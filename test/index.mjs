// Offline self-check of the client's response shaping. Run: npm test
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mdy, setStr, sections, statusName, createClient, decodeToken, bodyMetricEntry } from "../src/client.mjs";
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

// --- logActivity: resolves field and unit ids from the library, or refuses ---
{
  const RUN_LIBRARY = {
    _id: "lib-run",
    name: "Run",
    icon: "🏃",
    background_icon_color: "#FCF5DE",
    log_activity_fields: [
      {
        _id: "f-cal",
        unique_code: "calories",
        unit_category: { default_unit: { unique_code: "kcal" }, units: [{ _id: "u-kcal", unique_code: "kcal" }] },
      },
      {
        _id: "f-dist",
        unique_code: "distance",
        unit_category: {
          default_unit: { unique_code: "mi" },
          units: [
            { _id: "u-mi", unique_code: "mi" },
            { _id: "u-km", unique_code: "km" },
          ],
        },
      },
      {
        _id: "f-hr",
        unique_code: "avg_heart_rate",
        unit_category: { default_unit: { unique_code: "bpm" }, units: [{ _id: "u-bpm", unique_code: "bpm" }] },
      },
    ],
  };
  const realFetch = globalThis.fetch;
  let posted = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/auth/login/"))
      return new Response(JSON.stringify({ token: jwt({ profileId: "abc", exp: inDays(10) }), user: { _id: "abc" } }));
    if (u.includes("/log-activity-libraries/lib-run")) return new Response(JSON.stringify({ data: RUN_LIBRARY }));
    if (u.includes("/log-activity-categories/v2/section"))
      return new Response(JSON.stringify({ data: [{ unique_code: "cardio", libraries: [{ _id: "lib-run", name: "Run" }] }] }));
    if (u.endsWith("/log-activities")) {
      posted = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: { _id: "act-1", ...posted } }));
    }
    throw new Error(`unexpected request: ${u}`);
  };
  try {
    const c = createClient({ email: "e", password: "p" });

    await c.logActivity({
      activity: "Run",
      start: "2026-08-12T00:55:00.000Z",
      durationMinutes: 46,
      metrics: { distance: "7.22km", avg_heart_rate: 126, calories: null }, // null is dropped, not sent as 0
      note: "easy",
    });
    assert.equal(posted.log_activity_library, "lib-run");
    assert.equal(posted.icon, "🏃"); // icon/colour copied from the library, as the app does
    assert.equal(posted.start_time, "2026-08-12T00:55:00.000Z");
    assert.equal(posted.end_time, "2026-08-12T01:41:00.000Z"); // duration applied
    assert.deepEqual(posted.tracking_fields, [
      { log_activity_field: "f-dist", unit: "u-km", value: 7.22 }, // explicit unit honoured
      { log_activity_field: "f-hr", unit: "u-bpm", value: 126 }, // bare number takes default unit
    ]);

    // A bare distance must use the library's default unit (mi), not guess km.
    await c.logActivity({ libraryId: "lib-run", start: "2026-08-12T00:00:00Z", durationMinutes: 30, metrics: { distance: 5 } });
    assert.deepEqual(posted.tracking_fields, [{ log_activity_field: "f-dist", unit: "u-mi", value: 5 }]);

    // Refuse rather than silently drop what the API would ignore.
    await assert.rejects(
      c.logActivity({ libraryId: "lib-run", start: "2026-08-12T00:00:00Z", durationMinutes: 5, metrics: { power: 200 } }),
      /does not accept "power"/,
    );
    await assert.rejects(
      c.logActivity({ libraryId: "lib-run", start: "2026-08-12T00:00:00Z", durationMinutes: 5, metrics: { distance: "5furlongs" } }),
      /unit must be one of: mi, km/,
    );
    await assert.rejects(
      c.logActivity({ libraryId: "lib-run", start: "2026-08-12T00:00:00Z", end: "2026-08-11T00:00:00Z" }),
      /end time must be after start/,
    );
    await assert.rejects(c.logActivity({ libraryId: "lib-run", start: "not a date", durationMinutes: 5 }), /unparseable start/);
    await assert.rejects(c.logActivity({ libraryId: "lib-run", start: "2026-08-12T00:00:00Z" }), /needs end or durationMinutes/);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- updateActivity: the API replaces the whole record, so omitted fields must be carried over ---
{
  const LIBRARY = {
    _id: "lib-run",
    name: "Run",
    icon: "🏃",
    background_icon_color: "#FCF5DE",
    log_activity_fields: [
      {
        _id: "f-cal",
        unique_code: "calories",
        unit_category: { default_unit: { unique_code: "kcal" }, units: [{ _id: "u-kcal", unique_code: "kcal" }] },
      },
      {
        _id: "f-dist",
        unique_code: "distance",
        unit_category: {
          default_unit: { unique_code: "mi" },
          units: [
            { _id: "u-mi", unique_code: "mi" },
            { _id: "u-km", unique_code: "km" },
          ],
        },
      },
      {
        _id: "f-hr",
        unique_code: "avg_heart_rate",
        unit_category: { default_unit: { unique_code: "bpm" }, units: [{ _id: "u-bpm", unique_code: "bpm" }] },
      },
    ],
  };
  const EXISTING = {
    _id: "act-1",
    name: "Run",
    log_activity_library: { _id: "lib-run" },
    icon: "🏃",
    background_icon_color: "#FCF5DE",
    rating: 4,
    log_type: "normal",
    note: "original",
    start_time: "2026-08-12T00:55:00.000Z",
    end_time: "2026-08-12T01:41:00.000Z",
    tracking_fields: [
      { log_activity_field: { unique_code: "distance" }, value: 10, unit: { unique_code: "km" } },
      { log_activity_field: { unique_code: "avg_heart_rate" }, value: 140, unit: { unique_code: "bpm" } },
    ],
  };
  const realFetch = globalThis.fetch;
  let patched = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/auth/login/"))
      return new Response(JSON.stringify({ token: jwt({ profileId: "abc", exp: inDays(10) }), user: { _id: "abc" } }));
    if (u.includes("/log-activity-libraries/lib-run")) return new Response(JSON.stringify({ data: LIBRARY }));
    if (u.includes("/log-activities/act-1")) {
      if (opts.method === "PATCH") {
        patched = JSON.parse(opts.body);
        return new Response(JSON.stringify({ data: { ...EXISTING, ...patched } }));
      }
      return new Response(JSON.stringify({ data: EXISTING }));
    }
    throw new Error(`unexpected request: ${u}`);
  };
  try {
    const c = createClient({ email: "e", password: "p" });

    // Changing only the duration must not drop the metrics or the note.
    await c.updateActivity("act-1", { durationMinutes: 46 });
    assert.equal(patched.note, "original");
    assert.equal(patched.end_time, "2026-08-12T01:41:00.000Z"); // 55 + 46 min
    assert.deepEqual(patched.tracking_fields, [
      { log_activity_field: "f-dist", unit: "u-km", value: 10 },
      { log_activity_field: "f-hr", unit: "u-bpm", value: 140 },
    ]);

    // Changing one metric leaves the others intact, units included.
    await c.updateActivity("act-1", { metrics: { distance: "7.22km" } });
    assert.deepEqual(patched.tracking_fields, [
      { log_activity_field: "f-dist", unit: "u-km", value: 7.22 },
      { log_activity_field: "f-hr", unit: "u-bpm", value: 140 },
    ]);

    // null removes just that metric.
    await c.updateActivity("act-1", { metrics: { avg_heart_rate: null } });
    assert.deepEqual(patched.tracking_fields, [{ log_activity_field: "f-dist", unit: "u-km", value: 10 }]);

    // Adding a metric that was not there before.
    await c.updateActivity("act-1", { metrics: { calories: 600 } });
    assert.ok(patched.tracking_fields.some((f) => f.log_activity_field === "f-cal" && f.value === 600));

    // rating is passed through untouched — the API ignores changes to it.
    assert.equal(patched.rating, 4);

    await assert.rejects(c.updateActivity("act-1", { end: "2026-08-11T00:00:00Z" }), /end time must be after start/);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- device id + 2FA: login needs x-device-token; an untrusted id gets an emailed code to verify ---
{
  const realFetch = globalThis.fetch;
  const seen = [];
  const trusted = new Set();
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts.headers, body: opts.body });
    // As observed live: verify-otp succeeds without a token, and from then on the device is trusted.
    if (String(url).endsWith("/2fa/verify-otp")) {
      trusted.add(opts.headers["x-device-token"]);
      return new Response(JSON.stringify({ data: { verified: true } }));
    }
    if (!trusted.has(opts.headers["x-device-token"]))
      return new Response(JSON.stringify({ requires_2fa: true, two_fa_token: "2fa-t" }));
    return new Response(JSON.stringify({ token: jwt({ profileId: "abc", exp: inDays(10) }), user: { _id: "abc" } }));
  };
  try {
    // No way to ask for the code (the MCP server): say how to fix it instead of hanging.
    await assert.rejects(createClient({ email: "e", password: "p", deviceId: "DEV-1" }).login(), /2FA.*everfit login/);
    assert.equal(seen[0].headers["x-device-token"], "DEV-1");

    seen.length = 0;
    const s = await createClient({ email: "e", password: "p", deviceId: "DEV-1", getOtp: async () => " 123456 " }).login();
    assert.equal(s.clientId, "abc");
    const verify = seen[1];
    assert.match(verify.url, /\/auth\/2fa\/verify-otp$/);
    assert.equal(verify.headers["x-access-token"], "2fa-t"); // the 2FA token stands in for the access token
    assert.equal(verify.headers["x-device-token"], "DEV-1"); // same id gets trusted
    assert.deepEqual(JSON.parse(verify.body), { code: "123456", two_fa_token: "2fa-t" });
    assert.ok(seen[2].url.endsWith("/auth/login/"), "re-login after verify to get a real token");
    assert.ok(s.token && s.expiresAt > Date.now() + 864e5, "session must carry the token, not a stub");

    // No id given: a random one is still sent, since login is refused without any.
    seen.length = 0;
    await createClient({ email: "e", password: "p", getOtp: async () => "1" }).login();
    assert.match(seen[0].headers["x-device-token"], /^[0-9A-F-]{36}$/);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- error bodies: condensed for humans and model context, full body kept on the error ---
{
  const realFetch = globalThis.fetch;
  const html = "<html>\n<head><title>502 Bad Gateway</title></head>\n<body>...</body>\n</html>";
  globalThis.fetch = async (url) =>
    String(url).endsWith("/auth/login/")
      ? new Response(JSON.stringify({ token: jwt({ profileId: "abc", exp: inDays(10) }), user: { _id: "abc" } }))
      : new Response(html, { status: 502 });
  try {
    const e = await createClient({ email: "e", password: "p" }).getProfile().catch((err) => err);
    assert.match(e.message, /502 Bad Gateway \(upstream gateway error, usually transient/);
    assert.doesNotMatch(e.message, /<html>/); // the page itself must not reach the message
    assert.equal(e.body, html); // still available for debugging
    assert.equal(e.status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }

  // A JSON API error surfaces just its message.
  globalThis.fetch = async (url) =>
    String(url).endsWith("/auth/login/")
      ? new Response(JSON.stringify({ token: jwt({ profileId: "abc", exp: inDays(10) }), user: { _id: "abc" } }))
      : new Response(JSON.stringify({ error: "E_NOT_FOUND", message: "Log activity not found" }), { status: 404 });
  try {
    const e = await createClient({ email: "e", password: "p" }).getActivity("nope").catch((err) => err);
    assert.match(e.message, /404 Log activity not found/);
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


// --- body metrics: the catalog owns the unit ids, so resolution is where this can go wrong ---
{
  const KG = "5c40aa79690c9d44eafb575c";
  const LB = "5c40aa79690c9d44eafb575d";
  const catalog = [
    {
      unique_code: "weight",
      name: "Weight",
      unit: { _id: KG },
      category: { units: [{ _id: LB, unique_code: "lb" }, { _id: KG, unique_code: "kg" }] },
    },
    { unique_code: "steps", name: "Steps", category: { units: [{ _id: "s1", unique_code: "steps" }] } },
    { unique_code: "neck_65d5", name: "Neck", category: { units: [{ _id: "c1", unique_code: "cm" }, { _id: "i1", unique_code: "in" }] } },
  ];
  // The metric's own unit wins when none is asked for — not the first in the list.
  assert.deepEqual(bodyMetricEntry(catalog, "weight", 82.8), { unique_code: "weight", value: 82.8, unit: KG });
  assert.equal(bodyMetricEntry(catalog, "weight", 182, "lb").unit, LB);
  assert.equal(bodyMetricEntry(catalog, "weight", "182lb").unit, LB); // unit suffix on the value
  assert.equal(bodyMetricEntry(catalog, "Weight", 82.8).value, 82.8); // display name
  assert.equal(bodyMetricEntry(catalog, "neck", 40, "cm").unique_code, "neck_65d5"); // team-scoped code
  assert.equal(bodyMetricEntry(catalog, "steps", 9000).unit, "s1"); // sole unit needs no default
  assert.throws(() => bodyMetricEntry(catalog, "vo2", 50), /available: weight, steps/);
  assert.throws(() => bodyMetricEntry(catalog, "weight", 82.8, "stone"), /must be one of: lb, kg/);
  assert.throws(() => bodyMetricEntry(catalog, "neck", 40), /needs an explicit unit/); // ambiguous
  assert.throws(() => bodyMetricEntry(catalog, "weight", "heavy"), /unparseable/);
}

// logBodyMetric shapes the POST body the iOS app sends, and buckets a bare date at local noon.
{
  const sent = [];
  const client = createClient({ token: jwt({ profileId: "c1", exp: inDays(10) }), clientId: "c1" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    sent.push({ u, body: init?.body && JSON.parse(init.body) });
    const data = u.includes("get-full-list-client-body-metric")
      ? [{ unique_code: "weight", name: "Weight", unit: { _id: "kgid" }, category: { units: [{ _id: "kgid", unique_code: "kg" }] } }]
      : { _id: "e1", metric_code: "weight", value: 82.8, day: "09-04-2026" };
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  };
  try {
    const e = await client.logBodyMetric({ metric: "weight", value: 82.8, date: "2026-09-04" });
    assert.equal(e._id, "e1");
    const post = sent.at(-1);
    assert.match(post.u, /body-metric-entry\/add-entry$/);
    assert.equal(post.body.client, "c1");
    assert.equal(post.body.unique_code, "weight");
    assert.equal(post.body.value, 82.8);
    assert.equal(post.body.unit, "kgid");
    // Local noon, so the server's day bucket cannot slip a day either side of UTC.
    assert.equal(new Date(post.body.date).getDate(), 4);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("ok");
