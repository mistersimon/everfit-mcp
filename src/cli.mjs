#!/usr/bin/env node
// Poke the Everfit API directly, and manage the stored session the MCP server reads.
//   node cli.mjs login [--save-password]     log in and store the session (prompts, hidden input)
//   node cli.mjs whoami                      show who is logged in and when the token expires
//   node cli.mjs logout                      delete the stored session
//   node cli.mjs sessions [start] [end]      list workouts (YYYY-MM-DD, default last 7 days)
//   node cli.mjs days [start] [end]          raw day-by-day payload, includes rest days
//   node cli.mjs workout <id> [--raw]        one workout
//   node cli.mjs profile
//   node cli.mjs activities [search]         activity types available to log
//   node cli.mjs log Run --duration 46 --distance 7.22km --hr 126   log a cardio session
//   node cli.mjs edit <id> --duration 46 --distance 7.5km   change a logged activity
//   node cli.mjs activity <id> | delete-activity <id>
//   node cli.mjs get <path> [k=v ...]        any endpoint, e.g. get habits/client-today
// Env (EVERFIT_EMAIL/PASSWORD, EVERFIT_TOKEN) overrides the stored session.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { createClient, decodeToken } from "./client.mjs";
import { clearSession, permissionWarning, readSession, sessionPath, storedClientOptions, writeSession } from "./store.mjs";

const [cmd, ...rest] = process.argv.slice(2);

// Flags that take a value; everything else starting with -- is a boolean. Listing them explicitly
// keeps `workout <id> --raw` from swallowing a following positional argument.
// Short CLI flag -> the API's field code.
const METRIC_FLAGS = {
  distance: "distance",
  hr: "avg_heart_rate",
  calories: "calories",
  elevation: "elevation_gain",
  cadence: "avg_cadence",
  power: "power",
  reps: "reps",
};
const VALUE_FLAGS = new Set(["start", "end", "duration", "note", "library", ...Object.keys(METRIC_FLAGS)]);
const opts = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) {
    args.push(a);
    continue;
  }
  const [key, inline] = a.slice(2).split(/=(.*)/s);
  if (inline !== undefined) opts[key] = inline;
  else if (VALUE_FLAGS.has(key) && rest[i + 1] !== undefined) opts[key] = rest[++i];
  else opts[key] = true;
}
const flags = new Set(Object.keys(opts).map((k) => `--${k}`)); // back-compat for boolean checks
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
    case "activities":
      out((await everfit.searchActivityLibraries(args[0])).map((l) => ({ id: l._id, name: l.name, icon: l.icon })));
      break;
    case "log": {
      if (!args[0] && !opts.library) throw new Error('usage: log <activity> --duration <min> [--distance 7.22km] [--hr 126]');
      const metrics = Object.fromEntries(Object.entries(METRIC_FLAGS).map(([flag, code]) => [code, opts[flag]]));
      const durationMinutes = opts.duration != null ? Number(opts.duration) : undefined;
      if (opts.duration != null && !Number.isFinite(durationMinutes)) throw new Error("--duration must be minutes");
      // Default to a session that just ended, which is the common case for logging after the fact.
      const start =
        opts.start ?? (durationMinutes != null ? new Date(Date.now() - durationMinutes * 60_000) : new Date());
      const activity = { activity: args[0], libraryId: opts.library, start, end: opts.end, durationMinutes, metrics, note: opts.note ?? "" };
      if (opts["dry-run"]) {
        out({ dryRun: true, ...activity, start: new Date(start).toISOString() });
        break;
      }
      const logged = await everfit.logActivity(activity);
      out({
        activity_id: logged._id,
        name: logged.name,
        start_time: logged.start_time,
        end_time: logged.end_time,
        tracking_fields: logged.tracking_fields,
        note: logged.note,
      });
      break;
    }
    case "edit": {
      if (!args[0]) throw new Error("usage: edit <activity_id> [--duration 46] [--distance 7.5km] [--note ...]");
      // Only send what was actually passed: omitted metrics keep their value, --no-<metric> clears.
      const metrics = {};
      for (const [flag, code] of Object.entries(METRIC_FLAGS)) {
        if (opts[flag] != null) metrics[code] = opts[flag];
        if (opts[`no-${flag}`]) metrics[code] = null;
      }
      const updated = await everfit.updateActivity(args[0], {
        start: opts.start,
        end: opts.end,
        durationMinutes: opts.duration != null ? Number(opts.duration) : undefined,
        metrics: Object.keys(metrics).length ? metrics : undefined,
        note: opts.note,
      });
      out({
        activity_id: updated._id,
        name: updated.name,
        start_time: updated.start_time,
        end_time: updated.end_time,
        tracking_fields: updated.tracking_fields,
        note: updated.note,
      });
      break;
    }
    case "delete-activity":
      if (!args[0]) throw new Error("usage: delete-activity <activity_id>");
      out(await everfit.deleteActivity(args[0]));
      break;
    case "activity":
      if (!args[0]) throw new Error("usage: activity <activity_id>");
      out(await everfit.getActivity(args[0]));
      break;
    case "get": {
      if (!args[0]) throw new Error("usage: get <path> [k=v ...]");
      const params = Object.fromEntries(args.slice(1).map((p) => p.split(/=(.*)/s).slice(0, 2)));
      out(await everfit.get(args[0], params));
      break;
    }
    default:
      console.error(
        "commands:\n" +
          "  login [--save-password] | whoami | logout\n" +
          "  sessions [start] [end] | days [start] [end] | workout <id> [--raw] | profile\n" +
          "  activities [search]                       list activity types you can log\n" +
          "  log <activity> --duration <min> [--start <time>] [--end <time>]\n" +
          "      [--distance 7.22km] [--hr 126] [--calories 500] [--elevation 40m]\n" +
          "      [--cadence 170] [--power 200] [--reps 50] [--note ...] [--dry-run]\n" +
          "  edit <activity_id> [--duration 46] [same metric flags] [--no-hr] [--note ...]\n" +
          "  activity <id> | delete-activity <id>\n" +
          "  get <path> [k=v ...]                      any endpoint",
      );
      process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
