// Offline self-check of the client's response shaping. Run: npm test
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mdy, setStr, sections, statusName, createClient, decodeToken } from "../src/client.mjs";
import { clearSession, permissionWarning, readSession, sessionPath, storedClientOptions, writeSession } from "../src/store.mjs";

assert.equal(mdy("2026-08-13"), "08-13-2026");
assert.equal(mdy("08-13-2026"), "08-13-2026"); // already API format, passed through
// Negative offsets are future dates — the default end_date needs them to show upcoming workouts.
{
  const future = mdy(undefined, -14);
  const past = mdy(undefined, 7);
  const asDate = (s) => new Date(`${s.slice(6)}-${s.slice(0, 2)}-${s.slice(3, 5)}`);
  assert.ok(asDate(future) > new Date(), `default end_date must be in the future, got ${future}`);
  assert.ok(asDate(past) < new Date(), `default start_date must be in the past, got ${past}`);
  assert.equal(Math.round((asDate(future) - asDate(past)) / 864e5), 21); // 7 back + 14 ahead
}

const ts = {
  weight: { value: "100", set_unit: { title: "kg" } },
  reps: { value: "4-6" },
  rpe: { value: "8" },
  rest: { value: "120" },
  is_completed: true,
};
assert.equal(setStr(ts), "100kg x4-6 @RPE8 rest120 [done]");
assert.equal(setStr({ reps: { value: "" } }), "-");

assert.equal(statusName(2), "completed");
assert.equal(statusName(7), 7); // unknown code passes through

const out = sections([
  { title: " ", format: "regular", exercises: [{ supersets: [{ exercise: { title: "Bench" }, training_sets: [ts] }] }] },
]);
assert.equal(out[0].title, null); // blank trainer title collapses
assert.equal(out[0].exercises[0].exercise, "Bench");
assert.deepEqual(sections(undefined), []);

// --- token handling: a token is a cache of a login, never the source of truth ---
const jwt = (claims) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const inDays = (n) => Math.floor((Date.now() + n * 864e5) / 1000);

const decoded = decodeToken(jwt({ profileId: "abc", teamId: "t1", is_trainer: false, exp: inDays(10) }));
assert.equal(decoded.clientId, "abc"); // clientId comes free from the token, no config needed
assert.ok(decoded.expiresAt > Date.now());
assert.deepEqual(decodeToken("not-a-jwt"), {}); // garbage in, no throw

delete process.env.EVERFIT_EMAIL;
delete process.env.EVERFIT_PASSWORD;
delete process.env.EVERFIT_TOKEN;

// No creds, no token: fails with the setup message instead of hitting the network.
await assert.rejects(createClient().getProfile(), /EVERFIT_EMAIL/);

// Token past its exp and no password to renew it: refuse up front, and say why.
await assert.rejects(
  createClient({ token: jwt({ profileId: "abc", exp: inDays(-1) }) }).getProfile(),
  /token expired and no credentials/,
);

// Password present: an expired token is silently replaced, no 401 round trip needed.
{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).endsWith("/auth/login/"))
      return new Response(JSON.stringify({ token: jwt({ profileId: "abc", exp: inDays(10) }), user: { _id: "abc" } }));
    assert.equal(opts.headers["x-access-token"], jwt({ profileId: "abc", exp: inDays(10) }));
    return new Response(JSON.stringify({ data: { day_data: [] } }));
  };
  try {
    const c = createClient({ email: "e", password: "p", token: jwt({ profileId: "abc", exp: inDays(-1) }) });
    await c.getProfile();
    assert.ok(calls[0].endsWith("/auth/login/"), "expired token should trigger login first");
    await c.getProfile();
    assert.equal(calls.filter((u) => u.endsWith("/auth/login/")).length, 1, "fresh token should be reused");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// A 401 on a token we believed was valid (revoked, password changed) renews once and retries.
{
  let logins = 0;
  let gets = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/auth/login/")) {
      logins++;
      return new Response(JSON.stringify({ token: jwt({ profileId: "abc", exp: inDays(10) }), user: { _id: "abc" } }));
    }
    gets++;
    return gets === 1 ? new Response("nope", { status: 401 }) : new Response(JSON.stringify({ data: { ok: true } }));
  };
  try {
    const c = createClient({ email: "e", password: "p", token: jwt({ profileId: "abc", exp: inDays(10) }) });
    assert.deepEqual(await c.getProfile(), { ok: true });
    assert.equal(logins, 1);
    assert.equal(gets, 2); // retried after renewing
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Concurrent cold starts share one login instead of racing several.
{
  let logins = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/auth/login/")) {
      logins++;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ token: jwt({ profileId: "abc", exp: inDays(10) }), user: { _id: "abc" } }));
    }
    return new Response(JSON.stringify({ data: {} }));
  };
  try {
    const c = createClient({ email: "e", password: "p" });
    await Promise.all([c.getProfile(), c.getProfile(), c.getProfile()]);
    assert.equal(logins, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- session store: state lives in a file the user owns, not in the MCP config or model context ---
{
  const dir = mkdtempSync(join(tmpdir(), "everfit-store-"));
  process.env.EVERFIT_STATE_DIR = dir;
  const path = sessionPath();
  assert.equal(readSession(path), null); // absent session is normal, not an error

  writeSession({ email: "e@x.com", token: "t", clientId: "abc", expiresAt: 123 }, path);
  assert.equal(readSession(path).email, "e@x.com");
  assert.equal(statSync(path).mode & 0o777, 0o600, "session file must not be world/group readable");
  assert.equal(permissionWarning(path), null);

  chmodSync(path, 0o644);
  assert.match(permissionWarning(path), /chmod 600/); // warn, don't hard-fail

  // Rewriting an existing session must re-tighten the mode, not inherit the loose one.
  writeSession({ token: "t2" }, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // Env beats the stored session, so containers and CI can override without editing files.
  writeSession({ email: "stored@x.com", password: "sp", token: "st", clientId: "sc" }, path);
  process.env.EVERFIT_EMAIL = "env@x.com";
  assert.equal(storedClientOptions(path).email, "env@x.com");
  assert.equal(storedClientOptions(path).password, "sp"); // unset in env, falls back to stored
  delete process.env.EVERFIT_EMAIL;
  assert.equal(storedClientOptions(path).email, "stored@x.com");

  // A renewed token is written back, so the next process start does not need to log in again.
  storedClientOptions(path).onSession({ token: "renewed", clientId: "abc", expiresAt: 999 });
  assert.equal(readSession(path).token, "renewed");
  assert.equal(readSession(path).password, "sp", "renewal must not drop the stored password");

  // With no session file, onSession must not create one out of env-only config.
  clearSession(path);
  storedClientOptions(path).onSession({ token: "x", clientId: "y", expiresAt: 1 });
  assert.equal(readSession(path), null, "env-only config must not start persisting state");

  rmSync(dir, { recursive: true, force: true });
  delete process.env.EVERFIT_STATE_DIR;
}

// The interactive prompts only misbehave on a real tty — readline in terminal mode erases anything
// written to the terminal behind its back, which silently swallowed the prompt twice. Needs a pty,
// so this runs only where expect(1) exists.
if (existsSync("/usr/bin/expect")) {
  const dir = mkdtempSync(join(tmpdir(), "everfit-tty-"));
  const script = join(dir, "login.exp");
  writeFileSync(
    script,
    [
      "set timeout 20",
      // Unreachable API: we only care about the prompts, not a successful login.
      `spawn env EVERFIT_STATE_DIR=${dir} EVERFIT_API_BASE=http://127.0.0.1:1 ` +
        `${process.execPath} ${fileURLToPath(new URL("../src/cli.mjs", import.meta.url))} login`,
      'expect "Everfit email: "',
      'send "typed@example.com\\r"',
      'expect "Password: "',
      'send "hunter2\\r"',
      "expect eof",
    ].join("\n"),
  );
  const r = spawnSync("/usr/bin/expect", [script], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.match(r.stdout, /Everfit email: /, "email prompt was erased by readline");
  assert.match(r.stdout, /typed@example\.com/, "typed email should echo");
  assert.match(r.stdout, /Password: /, "password prompt was erased by readline");
  assert.doesNotMatch(r.stdout, /hunter2/, "password must never be echoed to the terminal");
}

// client.mjs must load and work with no `process` and no `Buffer` — Hermes/RN, browsers, Workers.
{
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `const p = ${JSON.stringify(new URL("../src/client.mjs", import.meta.url).href)};
     delete globalThis.process; delete globalThis.Buffer;
     const m = await import(p);
     const t = "x." + btoa(JSON.stringify({ profileId: "abc", exp: 2 ** 40 })) + ".y";
     if (m.decodeToken(t).clientId !== "abc") throw new Error("decodeToken broke");
     if (m.createClient({ token: t }).session.clientId !== "abc") throw new Error("createClient broke");`,
  ]);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, `client.mjs needs Node globals: ${stderr}`);
}

// The server must serve when executed as a script — including through a bin symlink, which is how
// every MCP client launches it. Regression guard: a realpath mismatch here silently serves nothing.
const { execPath } = process;
const link = join(tmpdir(), `everfit-mcp-test-${process.pid}.mjs`);
symlinkSync(fileURLToPath(new URL("../src/server.mjs", import.meta.url)), link);
try {
  const child = spawn(execPath, [link], { env: { ...process.env, EVERFIT_EMAIL: "x", EVERFIT_PASSWORD: "y" } });
  child.stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }) + "\n",
  );
  let stdout = "";
  for await (const chunk of child.stdout) {
    stdout += chunk;
    if (stdout.includes("\n")) break;
  }
  child.kill();
  assert.match(stdout, /"serverInfo"/, "server did not respond to initialize when run as a script");
} finally {
  unlinkSync(link);
}

console.log("ok");
