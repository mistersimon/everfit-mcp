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

// Run directly (including via the npm bin symlink, hence realpath) => serve. Imported => don't.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  await server.connect(new StdioServerTransport());
}

export { server, everfit };
