// Pure Everfit API client — no MCP. Reverse-engineered from iOS app traffic (v3.84.2).
// Usable standalone: import { createClient } from "./client.mjs"
// No `process` on Hermes/browsers/Workers — read env defensively so this file loads anywhere.
const env = typeof process === "undefined" ? {} : (process.env ?? {});
// Overridable: accounts on another backend shard set EVERFIT_API_BASE.
const DEFAULT_BASE = env.EVERFIT_API_BASE ?? "https://api-prod4.everfit.io/api";
const UA = "everfit/3.84.2 (io.everfit.appv2; build:1; iOS 26.5.0) Alamofire/5.4.3";
const systemTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

const pad = (n) => String(n).padStart(2, "0");

/**
 * Accept YYYY-MM-DD or MM-DD-YYYY, return the API's MM-DD-YYYY.
 * With no input, falls back to today offset by `fallbackDaysAgo` — negative offsets are future dates.
 */
export function mdy(input, fallbackDaysAgo = 0) {
  if (!input) {
    const d = new Date(Date.now() - fallbackDaysAgo * 864e5);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  return m ? `${m[2]}-${m[3]}-${m[1]}` : input;
}

// Only 0 and 2 seen in captured traffic; 1 inferred. Unknown codes pass through as numbers.
const STATUS = { 0: "not_started", 1: "in_progress", 2: "completed" };
export const statusName = (s) => STATUS[s] ?? s;

/** Compact one set: "100kg x4-6 @RPE8 rest120 [done]". Values are strings, reps may be ranges. */
export function setStr(ts) {
  const parts = [];
  if (ts.weight?.value) parts.push(`${ts.weight.value}${ts.weight.set_unit?.title ?? ""}`);
  for (const [key, fmt] of [["reps", "x%"], ["duration", "%s"], ["rpe", "@RPE%"], ["rest", "rest%"]]) {
    const v = ts[key]?.value;
    if (v) parts.push(fmt.replace("%", v));
  }
  if (ts.is_completed) parts.push("[done]");
  return parts.join(" ") || "-";
}

/** Flatten the sections/exercises/supersets/sets nesting into something readable. */
export function sections(list) {
  return (list ?? []).map((sec) => ({
    title: sec.title?.trim() || null,
    format: sec.format,
    note: sec.note || null,
    exercises: (sec.exercises ?? []).flatMap((ex) =>
      (ex.supersets ?? []).map((ss) => ({
        exercise: ss.exercise?.title,
        note: ss.note || null,
        tempo: ss.tempo || null,
        one_rep_max: ss.one_rep_max?.value,
        sets: (ss.training_sets ?? []).map(setStr),
      })),
    ),
  }));
}

export function summarizeAssignment(a) {
  return {
    assignment_id: a._id,
    day: a.day,
    title: a.title,
    status: statusName(a.status),
    program: a.originalProgram?.title,
    duration_s: a.duration,
    exercises_completed: a.exercises_completed,
    exercises_total: a.exercises_total,
    prs: a.pr,
    completed_note: a.completed_note || null,
  };
}

/**
 * Read the claims out of an x-access-token without a network call.
 * The token is a JWT: { profileId, teamId, is_trainer, workspaceName, iat, exp }.
 * profileId is the client id, so a token alone is enough to make date-range queries.
 * Not verified — we only trust these claims for our own routing/expiry decisions.
 */
export function decodeToken(jwt) {
  try {
    // atob, not Buffer, so this file stays runtime-agnostic (Hermes/RN, browsers, Workers, Deno).
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64));
    return {
      clientId: claims.profileId,
      teamId: claims.teamId,
      isTrainer: claims.is_trainer,
      expiresAt: claims.exp ? claims.exp * 1000 : null,
    };
  } catch {
    return {}; // unparseable token: fall through to the API telling us it's bad
  }
}

export class EverfitError extends Error {
  constructor(status, path, body) {
    super(`${path}: ${status} ${body}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.email]    defaults to EVERFIT_EMAIL
 * @param {string} [opts.password] defaults to EVERFIT_PASSWORD
 * @param {string} [opts.timezone] defaults to EVERFIT_TZ, else the system timezone
 * @param {string} [opts.token]    pre-existing x-access-token, skips login
 * @param {string} [opts.clientId] required alongside token for date-range queries
 * @param {string} [opts.baseUrl]  defaults to EVERFIT_API_BASE, else api-prod4
 * @param {(s: {token: string, clientId: string, expiresAt: number}) => void} [opts.onSession]
 *        called after every successful login, so a caller can persist the renewed token
 */
export function createClient({ email, password, timezone, token, clientId, baseUrl, onSession } = {}) {
  email ??= env.EVERFIT_EMAIL;
  password ??= env.EVERFIT_PASSWORD;
  const BASE = (baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const tz = timezone ?? env.EVERFIT_TZ ?? systemTz();
  const canLogin = Boolean(email && password);
  // Sessions are derived, never authoritative: a token is a cache of a login we can always redo.
  let session = token ? { token, ...decodeToken(token), clientId: clientId ?? decodeToken(token).clientId } : null;
  let pending = null;

  const headers = (extra) => ({ "x-app-type": "ios-client", "user-agent": UA, timezone: tz, ...extra });
  // Re-login this far before exp rather than waiting to be refused mid-request.
  const EXPIRY_SKEW_MS = 5 * 60_000;
  const isUsable = (s) => s?.token && (!s.expiresAt || s.expiresAt - EXPIRY_SKEW_MS > Date.now());

  async function doLogin() {
    const r = await fetch(`${BASE}/auth/login/`, {
      method: "POST",
      headers: headers({ "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ email, password }),
    });
    if (!r.ok) throw new EverfitError(r.status, "auth/login", await r.text());
    const d = await r.json();
    return {
      token: d.token,
      clientId: d.user?._id ?? decodeToken(d.token).clientId,
      user: d.user,
      // Trust the token's own exp; token_expiry (~10 days, as ms) is the fallback.
      expiresAt: decodeToken(d.token).expiresAt ?? Date.now() + (d.token_expiry ?? 0),
    };
  }

  /**
   * Return a usable session, logging in when there isn't one or the current one is near expiry.
   * Concurrent callers share one in-flight login.
   */
  async function login({ force = false } = {}) {
    if (!force && isUsable(session)) return session;
    if (!canLogin) {
      // Token-only and we can't read an exp from it: use it and let the API judge.
      if (session?.token && !session.expiresAt && !force) return session;
      throw new Error(
        session?.token
          ? "token expired and no credentials to renew it — set EVERFIT_EMAIL and EVERFIT_PASSWORD"
          : "set EVERFIT_EMAIL and EVERFIT_PASSWORD (or pass a token)",
      );
    }
    pending ??= doLogin().finally(() => (pending = null));
    session = await pending;
    try {
      onSession?.(session);
    } catch {
      // Persisting is best-effort: a read-only or full disk must not break API calls.
    }
    return session;
  }

  /** Raw GET against any endpoint — for poking at the API yourself. */
  async function get(path, params = {}, retry = true) {
    const { token } = await login();
    const url = new URL(`${BASE}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: headers({ "x-access-token": token }) });
    // Rejected despite our expiry check (revoked, password changed, clock skew): renew once.
    if (r.status === 401 && retry && canLogin) {
      session = null;
      await login({ force: true });
      return get(path, params, false);
    }
    if (!r.ok) throw new EverfitError(r.status, path, await r.text());
    return r.json();
  }

  return {
    get,
    login,
    get session() {
      return session;
    },

    /** Raw day-by-day payload, including rest days with no assignments. */
    async assignmentsRaw({ start_date, end_date, includeVideoWorkouts = false } = {}) {
      const { clientId: id } = await login();
      if (!id) throw new Error("could not determine clientId — pass clientId or use email/password");
      return get("workout/v2/assignments/mobile", {
        client: id,
        // Default window straddles today: upcoming assignments are as interesting as past ones,
        // and an end_date of today hides everything the coach has scheduled ahead.
        start_date: mdy(start_date, 7),
        end_date: mdy(end_date, -14),
        is_include_video_workout: includeVideoWorkouts ? 1 : 0,
      });
    },

    /** One flat list of workouts in the range. */
    async listTrainingSessions(range) {
      const data = await this.assignmentsRaw(range);
      return (data.day_data ?? []).flatMap((day) => (day.assignments ?? []).map(summarizeAssignment));
    },

    /** Prescribed vs logged detail for one workout. Pass {raw: true} for the untouched payload. */
    async getTrainingSession(assignmentId, { raw = false } = {}) {
      const res = await get("assignment/get-assignment", {
        assignmentId,
        requestAchievement: "false",
      });
      const d = res.data;
      if (raw) return d;
      return {
        assignment_id: d._id,
        title: d.title,
        day: d.day,
        status: statusName(d.status),
        program: d.originalProgram?.title,
        duration_s: d.duration,
        start_date: d.start_date,
        end_date: d.end_date,
        completed_note: d.completed_note || null,
        prescribed: sections(d.sections_target),
        logged: sections(d.sections_complete),
      };
    },

    /** Profile with credential fields stripped — this payload embeds a fresh firebase_token. */
    async getProfile() {
      const u = await get("profile/v2/client");
      const { firebase_token, token, refresh_token, switch_platform_token, ...rest } = u.data ?? u;
      return rest;
    },
  };
}
