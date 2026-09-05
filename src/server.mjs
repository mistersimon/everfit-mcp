#!/usr/bin/env node
// MCP wrapper over client.mjs. All API logic lives in the client.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createClient } from "./client.mjs";
import { storedClientOptions } from "./store.mjs";
import pkg from "../package.json" with { type: "json" };

// Credentials come from env or the session written by `everfit login` — never from tool arguments,
// which would put a live token through the model's context on every call.
const everfit = createClient(storedClientOptions());
const server = new McpServer({ name: "everfit", version: pkg.version });

// ponytail: every tool returns JSON text; no per-tool output schemas until a client needs them.
const json = (fn) => async (args) => {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(args ?? {}), null, 1) }] };
  } catch (e) {
    // Auth failures are the user's to fix in a terminal, so say that instead of leaking a stack.
    const needsLogin = /EVERFIT_EMAIL|token expired|E_UNAUTHORIZED/.test(e.message);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: needsLogin
            ? "Not logged in to Everfit (or the stored session expired). The user needs to run " +
              "this in a terminal — it prompts for the password, which must not be sent through " +
              "this conversation:\n\n  npx -p everfit-mcp everfit login --save-password\n\n" +
              `Then retry. Underlying error: ${e.message}`
            : e.message,
        },
      ],
    };
  }
};

server.registerTool(
  "list_training_sessions",
  {
    description:
      "List my assigned Everfit workouts in a date range. Defaults to the last 7 days through the " +
      "next 14 days, so it covers both completed and upcoming sessions. Future workouts come back " +
      "with status 'not_started' and their prescribed sets; they only exist as far ahead as my " +
      "coach has scheduled them, so an empty tail means nothing is assigned yet, not an error. " +
      "Returns an assignment_id per workout to pass to get_training_session.",
    inputSchema: {
      start_date: z.string().optional().describe("YYYY-MM-DD, default 7 days ago"),
      end_date: z.string().optional().describe("YYYY-MM-DD, default 14 days ahead"),
    },
  },
  json((a) => everfit.listTrainingSessions(a)),
);

server.registerTool(
  "get_training_session",
  {
    description: "Get one workout in full: prescribed sections/exercises/sets plus what I logged.",
    inputSchema: { assignment_id: z.string() },
  },
  json(({ assignment_id }) => everfit.getTrainingSession(assignment_id)),
);

server.registerTool(
  "get_profile",
  { description: "My Everfit client profile (name, units, timezone, trainer).", inputSchema: {} },
  json(() => everfit.getProfile()),
);

server.registerTool(
  "list_activity_types",
  {
    description:
      "Activity types available for log_activity (Run, Walk, Cycling, ...). Search by name, or " +
      "omit the query for the popular list. Each type accepts only certain metrics.",
    inputSchema: { query: z.string().optional().describe("name to search, e.g. 'run'") },
  },
  json(({ query }) =>
    everfit.searchActivityLibraries(query).then((ls) => ls.map((l) => ({ id: l._id, name: l.name, icon: l.icon }))),
  ),
);

server.registerTool(
  "log_activity",
  {
    description:
      "Log a completed cardio/activity session to my Everfit account — the '+ Activity' flow, not " +
      "a coach-assigned workout. THIS WRITES REAL DATA my coach can see, so confirm the details " +
      "with me before calling it, and do not guess at metrics I did not state. Duration comes from " +
      "the timestamps: pass duration_minutes, or start plus end. A bare distance number is in " +
      "MILES; write '7.22km' for kilometres. Metrics not accepted by the activity type are " +
      "rejected with the list of accepted ones.",
    inputSchema: {
      activity: z.string().describe("activity type name, e.g. 'Run' — see list_activity_types"),
      duration_minutes: z.number().positive().optional().describe("session length; alternative to end"),
      start: z.string().optional().describe("ISO time; defaults to duration_minutes ago (just finished)"),
      end: z.string().optional().describe("ISO time; alternative to duration_minutes"),
      distance: z.string().optional().describe("e.g. '7.22km' or '4.5mi'; a bare number means miles"),
      avg_heart_rate: z.number().optional().describe("bpm"),
      calories: z.number().optional().describe("kcal"),
      elevation_gain: z.string().optional().describe("e.g. '40m'"),
      avg_cadence: z.number().optional(),
      power: z.number().optional().describe("watts"),
      reps: z.number().optional(),
      note: z.string().optional(),
    },
  },
  json(async ({ activity, duration_minutes, start, end, note, ...metrics }) => {
    const logged = await everfit.logActivity({
      activity,
      durationMinutes: duration_minutes,
      // Default to a session that just ended — the same assumption the CLI makes.
      start: start ?? (duration_minutes != null ? new Date(Date.now() - duration_minutes * 60_000) : new Date()),
      end,
      metrics,
      note: note ?? "",
    });
    return {
      activity_id: logged._id,
      name: logged.name,
      start_time: logged.start_time,
      end_time: logged.end_time,
      tracking_fields: (logged.tracking_fields ?? []).map((f) => ({
        field: f.log_activity_field?.unique_code ?? f.log_activity_field,
        value: f.value,
        unit: f.unit?.title ?? f.unit,
      })),
      note: logged.note,
      // No delete tool exists, so tell the user how to undo this themselves.
      undo: `everfit delete-activity ${logged._id}`,
    };
  }),
);

server.registerTool(
  "list_body_metrics",
  {
    description:
      "Body metrics I can log with log_body_metric (weight, steps, body_fat, ...), each with the " +
      "units it accepts. My coach controls which exist, so this list is account-specific — check " +
      "it rather than assuming a metric is available.",
    inputSchema: {},
  },
  json(() =>
    everfit
      .listBodyMetrics()
      .then((ms) =>
        ms.map((m) => ({
          metric: m.unique_code,
          name: m.name,
          units: (m.category?.units ?? []).map((u) => u.unique_code),
        })),
      ),
  ),
);

server.registerTool(
  "log_body_metric",
  {
    description:
      "Record a body-metric measurement (weight, steps, body fat, ...) in my Everfit account. " +
      "THIS WRITES REAL DATA my coach can see, so confirm the value with me first and never guess " +
      "a measurement I did not state. Pass the unit when I gave one; otherwise the metric's " +
      "existing unit is used. There is no delete tool — a mistaken entry has to be removed in the " +
      "Everfit app.",
    inputSchema: {
      metric: z.string().describe("metric code or name, e.g. 'weight' — see list_body_metrics"),
      value: z.number().describe("the measurement, e.g. 82.8"),
      unit: z.string().optional().describe("unit code, e.g. 'kg' or 'lb'; defaults to the metric's unit"),
      date: z.string().optional().describe("YYYY-MM-DD or ISO time; defaults to now"),
    },
  },
  json(async (a) => {
    const e = await everfit.logBodyMetric(a);
    return {
      entry_id: e._id,
      metric: e.metric_code,
      value: e.value,
      day: e.day,
      date: e.date,
      // No delete endpoint has been captured, so the app is the only way back.
      undo: "remove this entry in the Everfit app — no API delete is implemented",
    };
  }),
);

// Run directly (including via the npm bin symlink, hence realpath) => serve. Imported => don't.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  await server.connect(new StdioServerTransport());
}

export { server, everfit };
