#!/usr/bin/env node
// Poke the Everfit API directly, and manage the stored session the MCP server reads.
//   node cli.mjs login [--save-password]     log in and store the session (prompts, hidden input)
//   node cli.mjs whoami                      show who is logged in and when the token expires
//   node cli.mjs logout                      delete the stored session
//   node cli.mjs sessions [start] [end]      list workouts (YYYY-MM-DD, default last 7 days)
//   node cli.mjs days [start] [end]          raw day-by-day payload, includes rest days
//   node cli.mjs workout <id> [--raw]        one workout
//   node cli.mjs profile
//   node cli.mjs get <path> [k=v ...]        any endpoint, e.g. get habits/client-today
// Env (EVERFIT_EMAIL/PASSWORD, EVERFIT_TOKEN) overrides the stored session.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { createClient, decodeToken } from "./client.mjs";
import { clearSession, permissionWarning, readSession, sessionPath, storedClientOptions, writeSession } from "./store.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));
const out = (v) => console.log(JSON.stringify(v, null, 2));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/**
 * Read one line. On a TTY it prompts, and hidden=true suppresses the echo so a password stays off
 * the screen. Piped stdin gets no prompt and no readline terminal handling — forcing terminal mode
 * on a pipe emits escape codes and hangs, so `printf 'email\npassword\n' | everfit login` works.
 */
let pipedLines = null; // read the pipe once: closing readline mid-stream drops buffered lines

function nextPipedLine() {
  pipedLines ??= new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf.split(/\r?\n/)));
  });
  return pipedLines.then((lines) => (lines.shift() ?? "").trim());
}

function ask(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) return nextPipedLine();
  // The prompt must go through readline: in terminal mode readline redraws the line and erases
  // anything written to the tty behind its back. So instead of muting readline, mute the stream it
  // writes to, and unmute just long enough for the prompt itself to land.
  let muted = false;
  const output = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stderr.write(chunk, enc); // prompts on stderr keeps stdout pipeable
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write("\n"); // the muted newline the user typed
      resolve(answer.trim());
    });
    muted = hidden; // question() wrote the prompt synchronously; hide only the typing that follows
  });
}

const everfit = createClient(storedClientOptions());

try {
  switch (cmd) {
    case "login": {
      const email = process.env.EVERFIT_EMAIL || args[0] || (await ask("Everfit email: "));
      const password = process.env.EVERFIT_PASSWORD || (await ask("Password: ", { hidden: true }));
      const fresh = createClient({ email, password });
      const s = await fresh.login();
      // --save-password trades a secret at rest for a session that renews itself past 10 days.
      writeSession({
        email,
        ...(flags.has("--save-password") ? { password } : {}),
        token: s.token,
        clientId: s.clientId,
        expiresAt: s.expiresAt,
      });
      console.error(`Logged in as ${email}. Session saved to ${sessionPath()} (mode 600).`);
      console.error(`Token expires ${iso(s.expiresAt)}.`);
      console.error(
        flags.has("--save-password")
          ? "Password stored, so the session renews itself."
          : "Password not stored — re-run `everfit login` after the token expires, or use --save-password.",
      );
      break;
    }
    case "logout":
      clearSession();
      console.error(`Removed ${sessionPath()}.`);
      break;
    case "whoami": {
      const s = readSession();
      if (!s) {
        console.error(`No stored session (${sessionPath()}). Run: everfit login`);
        process.exit(1);
      }
      const warn = permissionWarning();
      if (warn) console.error(`warning: ${warn}`);
      const expiresAt = s.expiresAt ?? decodeToken(s.token ?? "").expiresAt;
      out({
        email: s.email,
        clientId: s.clientId ?? decodeToken(s.token ?? "").clientId,
        expiresAt: iso(expiresAt),
        expired: expiresAt ? expiresAt < Date.now() : null,
        renewable: Boolean(s.password),
        path: sessionPath(),
      });
      break;
    }
    case "sessions":
      out(await everfit.listTrainingSessions({ start_date: args[0], end_date: args[1] }));
      break;
    case "days":
      out(await everfit.assignmentsRaw({ start_date: args[0], end_date: args[1] }));
      break;
    case "workout":
      if (!args[0]) throw new Error("usage: workout <assignment_id> [--raw]");
      out(await everfit.getTrainingSession(args[0], { raw: flags.has("--raw") }));
      break;
    case "profile":
      out(await everfit.getProfile());
      break;
    case "get": {
      if (!args[0]) throw new Error("usage: get <path> [k=v ...]");
      const params = Object.fromEntries(args.slice(1).map((p) => p.split(/=(.*)/s).slice(0, 2)));
      out(await everfit.get(args[0], params));
      break;
    }
    default:
      console.error(
        "commands: login [--save-password] | whoami | logout | sessions [start] [end] | " +
          "days [start] [end] | workout <id> [--raw] | profile | get <path> [k=v ...]",
      );
      process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
