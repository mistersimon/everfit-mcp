# everfit-mcp

MCP server + API client for [Everfit](https://everfit.io), from the **client** side (not coach).
Reads your assigned training sessions, workout detail, and profile.

Unofficial. Reverse-engineered from iOS app traffic (v3.84.2); Everfit can change or block these
endpoints at any time.

## Install

Needs Node >= 20. Nothing else — no Python, no build step.

```bash
npx everfit-mcp            # run the MCP server over stdio
npx -p everfit-mcp everfit sessions   # or the CLI
```

Not published yet? Three ways to install it elsewhere without a registry:

```bash
npm pack                                  # produces everfit-mcp-<version>.tgz
npm i -g ./everfit-mcp-0.0.2.tgz          # copy the tarball to any machine
npx github:mistersimon/everfit-mcp        # or install straight from the git repo
git clone https://github.com/mistersimon/everfit-mcp.git && npm install   # for development
```

### Claude Code

```bash
npx -p everfit-mcp everfit login --save-password   # once, prompts for your password
claude mcp add everfit -- npx -y everfit-mcp       # no credentials in the config
```

### Claude Desktop / Cursor / any MCP client

Run `npx -p everfit-mcp everfit login --save-password` once, then in
`claude_desktop_config.json` (or the equivalent):

```json
{
  "mcpServers": {
    "everfit": {
      "command": "npx",
      "args": ["-y", "everfit-mcp"]
    }
  }
}
```

Credentials come from the stored session, so nothing secret goes in this file. Env vars still work
if you prefer them — see [Credentials](#credentials).

### Hosting it elsewhere

What a host needs to run the MCP server: Node >= 20, the ability to spawn a child process and talk
MCP over **stdio**, per-server env vars, and outbound HTTPS to `api-prod4.everfit.io`. No inbound
port, no writable disk. Any agent host meeting that runs it with `npx -y everfit-mcp` and two env
vars, exactly like Claude Code.

Two cases that need more than a config entry:

- **Host only accepts remote (HTTP) MCP servers.** This ships stdio only. The SDK's
  streamable-HTTP transport is a small addition, but an HTTP endpoint holding your Everfit
  credentials needs its own auth — don't expose it unauthenticated.
- **Runtime without Node** (React Native / Hermes, browsers, Cloudflare Workers, Deno).
  `src/server.mjs` and `src/cli.mjs` are Node-only: child process, `node:fs`, stdio. But
  `src/client.mjs` (`everfit-mcp/client`) is dependency-free
  and uses only web-standard globals (`fetch`, `URL`, `URLSearchParams`, `atob`, `Intl`) — no
  `process`, no `Buffer` — so you can import it directly and skip MCP. `npm test` asserts this by
  loading it with `process` and `Buffer` deleted.

## Credentials

Everfit has no API keys, so auth is your app email and password. Two ways to supply them.

### Recommended: `everfit login`

```bash
npx -p everfit-mcp everfit login --save-password
```

Prompts for email and password (password is not echoed) and writes a session to
`~/.config/everfit/session.json`, mode `600`. Then the MCP config needs **no credentials at all**:

```json
{ "mcpServers": { "everfit": { "command": "npx", "args": ["-y", "everfit-mcp"] } } }
```

`everfit whoami` shows who is logged in and when the token expires; `everfit logout` deletes the file.

`--save-password` stores the password alongside the token so the session renews itself indefinitely.
Without it only the token is stored, and you re-run `everfit login` when it expires (~10 days).
Either way the secret sits in one `600` file you own rather than in an MCP client config, and it
never passes through the model.

### Or environment variables

Env always wins over the stored session, which is what you want for containers and CI.

| Variable | Purpose |
| --- | --- |
| `EVERFIT_EMAIL`, `EVERFIT_PASSWORD` | Log in on demand, renew forever. Best for containers. |
| `EVERFIT_TOKEN` | Use an existing token, no password anywhere. Get one from `everfit login`. Expires ~10 days after issue and cannot renew itself. |
| `EVERFIT_TZ` | Timezone header. Defaults to the system timezone. |
| `EVERFIT_API_BASE` | Override the API host if your account is on a different backend shard. |
| `EVERFIT_STATE_DIR` | Where the session file lives. Defaults to `$XDG_CONFIG_HOME/everfit` or `~/.config/everfit`. |

Credentials are never accepted as tool arguments. A token passed per call would sit in the model's
context and in transcripts; keeping auth in the process is the reason there is no `login` **tool**,
only a `login` **command**.

### Statelessness and token expiry

Nothing is written to disk, ever. A token is treated as a *cache of a login*, not as state:

- With email + password the client is effectively stateless. It holds a token in memory for the
  process lifetime, re-logs-in automatically ~5 minutes before the token's `exp`, and also renews
  once on an unexpected `401` (revoked token, changed password, clock skew). Restart the process,
  or run it in a fresh container, and it simply logs in again. Nothing to rotate or refresh by hand.
- With `EVERFIT_TOKEN` alone there is no way to renew, so it stops working ~10 days after issue and
  fails with `token expired and no credentials to renew it`. Fine for a shell session or CI run;
  wrong for a long-lived MCP server install.

The token is a JWT carrying `profileId` (your client id) and `exp`, so the client reads both
locally and needs no extra configuration and no probe request. Everfit's login response does
include a `refresh_token`, but no refresh endpoint appears in the captured traffic — re-login is
the refresh path, which is why the password is the durable credential.

**Whichever you choose, the secret is plaintext at rest.** `everfit login` at least confines it to
one `600` file instead of an MCP config that other tools read, and keeps it out of shell history.
On a shared box, anyone who can read that file has your Everfit account. Never bake credentials
into a container or machine image — pass them at run time. Where you can live with the 10-day
ceiling, `login` without `--save-password` (or a bare `EVERFIT_TOKEN`) limits the blast radius; a
long-lived unattended install needs the password to keep working.

## MCP tools

| Tool | Does |
| --- | --- |
| `list_training_sessions(start_date?, end_date?)` | Workouts in a date range (`YYYY-MM-DD`). Defaults to 7 days back through 14 days ahead, so past *and* upcoming sessions appear. Returns an `assignment_id` per workout. |
| `get_training_session(assignment_id)` | One workout: prescribed sections/exercises/sets plus what you logged. |
| `get_profile()` | Your client profile (name, units, timezone, trainer). |
| `list_activity_types(query?)` | Activity types available to `log_activity` (Run, Walk, Cycling, ...). |
| `log_activity({activity, duration_minutes \| end, start?, distance?, avg_heart_rate?, ...})` | **Writes.** Logs a cardio session your coach can see. Returns the new `activity_id` and an `undo` command. |

`log_activity` is the only tool that writes. Its description tells the model to confirm details
first and not to invent metrics, but that is a prompt, not a guarantee — an agent can create real
entries in your training log. There is deliberately **no delete tool**, so nothing an agent does is
destructive; remove a mistaken entry yourself with `everfit delete-activity <id>` (the tool returns
the exact command). Drop the `log_activity` registration from `src/server.mjs` if you want a
strictly read-only server.

## CLI

```bash
everfit login [--save-password]        # store a session the MCP server reads
everfit whoami                         # who is logged in, when the token expires
everfit logout                         # delete the stored session
everfit sessions [start] [end]         # workouts, YYYY-MM-DD, default -7d..+14d
everfit days [start] [end]             # raw day-by-day payload, includes rest days
everfit workout <assignment_id>        # one workout, flattened
everfit workout <assignment_id> --raw  # untouched API payload
everfit profile
everfit get <path> [k=v ...]           # any endpoint, e.g. get habits/client-today
```

`get` is the escape hatch for exploring endpoints this package does not wrap yet.

### Logging a cardio session

Cardio and other non-assigned activity is a **log activity**, a different object from a coach's
workout assignment. `everfit log` creates one, the same as "+ Activity" in the app:

```bash
everfit activities                     # popular activity types
everfit activities run                 # search: Run, Trail Run, ...
everfit log Run --duration 46 --distance 7.22km --hr 126
everfit log Run --start "2026-08-12T08:55" --end "2026-08-12T09:41" --distance 4.5mi --dry-run
everfit activity <activity_id>         # read one back
everfit edit <activity_id> --duration 46 --distance 7.22km
everfit edit <activity_id> --no-hr --note "felt easy"   # --no-<metric> clears one
everfit delete-activity <activity_id>  # remove it
```

- `--duration` is minutes. With no `--start`, the session is assumed to have just ended.
- Metric flags: `--distance --hr --calories --elevation --cadence --power --reps`. A bare number
  uses the field's default unit (**miles** for distance), so pass `7.22km` if you mean km.
- Each activity type accepts only some metrics — Run takes distance, avg_heart_rate and calories,
  and anything else is rejected with the list it does accept rather than being silently dropped.
- `--dry-run` prints the payload without sending it.
- `edit` merges: the API replaces the whole record, so the client reads the current activity first
  and carries over anything you did not pass. Clear a single metric with `--no-hr`, `--no-distance`
  and so on. `rating` cannot be changed — the API accepts the field and ignores it (verified), so
  the existing value is preserved.

## Library

The package entry point is the MCP server, since that is the primary artifact. The API client is a
subpath import, and needs no MCP:

```js
import { createClient } from "everfit-mcp/client";

const everfit = createClient(); // or { email, password, token, clientId, timezone, baseUrl }
const sessions = await everfit.listTrainingSessions({ start_date: "2026-08-01" });
const detail = await everfit.getTrainingSession(sessions[0].assignment_id);
const habits = await everfit.get("habits/client-today"); // raw GET, any endpoint
```

Also exported from `everfit-mcp/client`: `decodeToken`, `mdy`, `setStr`, `sections`, `statusName`,
`summarizeAssignment`, `EverfitError` (carries `.status`, `.path`, `.body`). Importing
`everfit-mcp` gives you the MCP `server` object and its configured `everfit` client; it only
speaks stdio when run as a script, so importing it is side-effect free.

### Layout

```
src/server.mjs   MCP server (package entry point, `everfit-mcp` bin)
src/client.mjs   Everfit API client, no deps, no Node built-ins
src/store.mjs    session file handling (Node-only, kept out of the client)
src/cli.mjs      `everfit` bin: login/whoami/logout and direct endpoint access
test/index.mjs   npm test
```

## Notes from the captured traffic

- Auth: `POST /api/auth/login/` form-encoded, token goes in the `x-access-token` header (not
  `Authorization`), alongside `x-app-type: ios-client`. A 401 triggers one re-login and retry.
- Dates: the API wants `MM-DD-YYYY`. This client accepts `YYYY-MM-DD` and converts.
- Set values are strings and reps can be ranges (`"4-6"`), so sets render as text:
  `160kg x5 @RPE7 rest120`.
- Assignment `status`: 0 and 2 confirmed (`not_started`, `completed`); 1 (`in_progress`) is
  inferred. Unknown codes pass through as numbers.
- Logged activities (cardio) are a separate object from workout assignments:
  `POST /api/log-activities` with `{log_activity_library, tracking_fields, start_time, end_time,
  icon, background_icon_color}`. Duration is implied by the timestamps — there is no duration field.
  `tracking_fields` entries are `{log_activity_field, unit, value}` id triples, and the valid field
  and unit ids for an activity come from `GET /api/log-activity-libraries/:id`.
- Future workouts are ordinary assignments: same endpoint, `status: not_started`, full prescribed
  sets, empty `logged`. There is no separate "upcoming" endpoint and no server-side cap on how far
  ahead you can query — you only get days your coach has actually scheduled, so a range past the
  end of the assigned program returns an empty list rather than an error.
- `get_profile` strips the `firebase_token` the endpoint returns, so credentials stay out of
  model context.

## Development

```bash
npm test              # offline: response shaping, token/expiry logic, session store, prompts
node src/cli.mjs login   # run the CLI from a clone without installing
claude mcp add everfit-dev -- node "$PWD/src/server.mjs"   # register the working tree
```

If you capture your own traffic with mitmproxy, remember the flow file contains your plaintext
password and a live token. `.gitignore` excludes `*.flows` and `*.har`; keep it that way.

## License

MIT — see [LICENSE](LICENSE).
