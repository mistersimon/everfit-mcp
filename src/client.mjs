// Pure Everfit API client — no MCP. Reverse-engineered from iOS app traffic (v3.99.1).
// Usable standalone: import { createClient } from "./client.mjs"
// No `process` on Hermes/browsers/Workers — read env defensively so this file loads anywhere.
const env = typeof process === "undefined" ? {} : (process.env ?? {});
// Overridable: accounts on another backend shard set EVERFIT_API_BASE.
const DEFAULT_BASE = env.EVERFIT_API_BASE ?? "https://api-prod4.everfit.io/api";
// Mirrors the app's identity headers; the server refuses login from builds it considers outdated.
const APP_VERSION = "3.99.1";
const APP_BUILD = "2";
const IOS_VERSION = "27.2";
const UA = `everfit/${APP_VERSION} (io.everfit.appv2; build:${APP_BUILD}; iOS ${IOS_VERSION}.0) Alamofire/5.12.2`;
const APP_HEADERS = {
  "x-app-type": "ios-client",
  "user-agent": UA,
  agent: "ios",
  "agent-app-build": `${APP_VERSION} (${APP_BUILD})`,
  "agent-device-os": IOS_VERSION,
};
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

/**
 * Turn {distance: "7.22km", avg_heart_rate: 126} into the API's (field id, unit id, value) triples.
 * Both ids come from the activity type's own definition, so an unsupported field or unit fails
 * here rather than being silently dropped by the API. Values may carry a unit suffix; a bare
 * number uses the field's default unit.
 */
export function trackingFields(library, metrics = {}) {
  const fields = library.log_activity_fields ?? [];
  return Object.entries(metrics)
    .filter(([, v]) => v != null && v !== "")
    .map(([code, raw]) => {
      const field = fields.find((f) => f.unique_code === code);
      if (!field) {
        const allowed = fields.map((f) => f.unique_code).join(", ") || "no metrics";
        throw new Error(`${library.name} does not accept "${code}" — it accepts: ${allowed}`);
      }
      const units = field.unit_category?.units ?? [];
      const m = /^\s*(-?[\d.]+)\s*([a-zA-Z]*)\s*$/.exec(String(raw));
      if (!m) throw new Error(`unparseable value for ${code}: ${raw}`);
      const wanted = m[2] || field.unit_category?.default_unit?.unique_code;
      const unit = units.find((u) => u.unique_code.toLowerCase() === String(wanted).toLowerCase());
      if (!unit) throw new Error(`${code} unit must be one of: ${units.map((u) => u.unique_code).join(", ")}`);
      return { log_activity_field: field._id, unit: unit._id, value: Number(m[1]) };
    });
}

/** Existing tracking_fields come back expanded ({field: {...}, unit: {...}}); flatten to codes. */
export function metricsFromActivity(activity) {
  return Object.fromEntries(
    (activity.tracking_fields ?? []).map((f) => [
      f.log_activity_field?.unique_code ?? f.log_activity_field,
      `${f.value}${f.unit?.unique_code ?? ""}`,
    ]),
  );
}

/**
 * Resolve a body-metric entry's (unique_code, unit id, value) from the client's metric catalog.
 * Units are per-metric ObjectIds, never a global table, so an unknown metric or unit fails here
 * rather than being silently accepted. Value may carry a unit suffix ("82.8kg"); a bare number
 * uses the metric's own unit, or the only unit it has.
 */
export function bodyMetricEntry(metrics, name, rawValue, wantedUnit) {
  const want = String(name).toLowerCase().trim();
  const metric =
    metrics.find((m) => m.unique_code?.toLowerCase() === want) ??
    metrics.find((m) => m.name?.toLowerCase() === want) ??
    metrics.find((m) => m.unique_code?.toLowerCase().startsWith(`${want}_`)) ?? // team-scoped: neck_<teamId>
    metrics.find((m) => m.name?.toLowerCase().includes(want));
  if (!metric) {
    const codes = metrics.map((m) => m.unique_code).join(", ");
    throw new Error(`no body metric matches "${name}" — available: ${codes}`);
  }

  const m = /^\s*(-?[\d.]+)\s*([^\s\d]*)\s*$/.exec(String(rawValue));
  if (!m) throw new Error(`unparseable value for ${metric.unique_code}: ${rawValue}`);
  const value = Number(m[1]);
  if (!Number.isFinite(value)) throw new Error(`unparseable value for ${metric.unique_code}: ${rawValue}`);

  const units = metric.category?.units ?? [];
  // The metric carries the unit the client already logs it in; fall back to the only one it has.
  const current = metric.unit?._id ?? metric.unit;
  const wanted = wantedUnit ?? m[2] ?? "";
  let unit;
  if (wanted) unit = units.find((u) => u.unique_code?.toLowerCase() === String(wanted).toLowerCase());
  else unit = units.find((u) => u._id === current) ?? (units.length === 1 ? units[0] : null);
  if (!unit) {
    const allowed = units.map((u) => u.unique_code).join(", ") || "none";
    throw new Error(
      wanted
        ? `${metric.unique_code} unit must be one of: ${allowed}`
        : `${metric.unique_code} needs an explicit unit — one of: ${allowed}`,
    );
  }
  return { unique_code: metric.unique_code, value, unit: unit._id };
}

export class EverfitError extends Error {
  constructor(status, path, body) {
    super(`${path}: ${status} ${summarizeErrorBody(status, body)}`);
    this.status = status;
    this.path = path;
    this.body = body; // full body preserved; only the message is condensed
  }
}

/**
 * API errors are JSON, but gateway errors (502/504) are HTML pages. Keep the message short and
 * useful in both cases — a full HTML error page is noise in a terminal and in model context.
 */
function summarizeErrorBody(status, body = "") {
  if (/^\s*</.test(body)) {
    const gateway = status >= 500 ? " (upstream gateway error, usually transient — retry)" : "";
    return `${(/<title>([^<]+)<\/title>/i.exec(body)?.[1] ?? "HTML error page").trim()}${gateway}`;
  }
  try {
    const d = JSON.parse(body);
    return d.message ?? d.error ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
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
 * @param {string} [opts.deviceId] defaults to EVERFIT_DEVICE_ID, else a random UUID; sent as x-device-token.
 *        Login is refused without one. An id the account hasn't trusted yet gets a 2FA challenge (code by
 *        email); once verified it stays trusted for months, so persist it.
 * @param {() => Promise<string>} [opts.getOtp] asked for the emailed 2FA code when Everfit wants one;
 *        without it a 2FA challenge is an error
 * @param {(s: {token: string, clientId: string, expiresAt: number}) => void} [opts.onSession]
 *        called after every successful login, so a caller can persist the renewed token
 */
export function createClient({ email, password, timezone, token, clientId, baseUrl, deviceId, getOtp, onSession } = {}) {
  email ??= env.EVERFIT_EMAIL;
  deviceId ??= env.EVERFIT_DEVICE_ID ?? globalThis.crypto?.randomUUID?.().toUpperCase();
  password ??= env.EVERFIT_PASSWORD;
  const BASE = (baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const tz = timezone ?? env.EVERFIT_TZ ?? systemTz();
  const canLogin = Boolean(email && password);
  // Sessions are derived, never authoritative: a token is a cache of a login we can always redo.
  let session = token ? { token, ...decodeToken(token), clientId: clientId ?? decodeToken(token).clientId } : null;
  let pending = null;

  const headers = (extra) => ({ ...APP_HEADERS, timezone: tz, ...extra });
  // Re-login this far before exp rather than waiting to be refused mid-request.
  const EXPIRY_SKEW_MS = 5 * 60_000;
  const isUsable = (s) => s?.token && (!s.expiresAt || s.expiresAt - EXPIRY_SKEW_MS > Date.now());

  async function postLogin() {
    const r = await fetch(`${BASE}/auth/login/`, {
      method: "POST",
      headers: headers({
        "content-type": "application/x-www-form-urlencoded",
        ...(deviceId ? { "x-device-token": deviceId } : {}),
      }),
      body: new URLSearchParams({ email, password }),
    });
    if (!r.ok) throw new EverfitError(r.status, "auth/login", await r.text());
    return r.json();
  }

  async function doLogin() {
    let d = await postLogin();
    if (d.requires_2fa) {
      const v = await verifyOtp(d.two_fa_token);
      // verify-otp's reply has no usable token, but it trusts the device, so a plain re-login does.
      d = v?.token ? v : await postLogin();
    }
    // Never hand back a session without a token: callers would persist it and fail later, confusingly.
    if (!d?.token) throw new Error(`auth/login: no token in Everfit's reply (keys: ${Object.keys(d ?? {}).join(", ")})`);
    return {
      token: d.token,
      clientId: d.user?._id ?? decodeToken(d.token).clientId,
      user: d.user,
      // Trust the token's own exp; token_expiry (~10 days, as ms) is the fallback.
      expiresAt: decodeToken(d.token).expiresAt ?? Date.now() + (d.token_expiry ?? 0),
    };
  }

  // Endpoint and body from the web app's bundle; the two_fa_token doubles as the access token.
  async function verifyOtp(twoFaToken) {
    if (!getOtp)
      throw new Error("auth/login: Everfit wants 2FA for this device — run `everfit login` in a terminal to enter the emailed code");
    const code = String(await getOtp()).trim();
    const r = await fetch(`${BASE}/auth/2fa/verify-otp`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "x-access-token": twoFaToken, "x-device-token": deviceId }),
      body: JSON.stringify({ code, two_fa_token: twoFaToken }),
    });
    if (!r.ok) throw new EverfitError(r.status, "auth/2fa/verify-otp", await r.text());
    const j = await r.json();
    return j.data ?? j;
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

  /** JSON-body request (POST/PATCH/PUT/DELETE). Same 401-renew behaviour as get(). */
  async function send(method, path, body, retry = true) {
    const { token } = await login();
    const r = await fetch(`${BASE}/${path.replace(/^\//, "")}`, {
      method,
      headers: headers({ "x-access-token": token, "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 401 && retry && canLogin) {
      session = null;
      await login({ force: true });
      return send(method, path, body, false);
    }
    if (!r.ok) throw new EverfitError(r.status, path, await r.text());
    return r.json();
  }

  return {
    get,
    send,
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

    /** Activity types you can log, e.g. Run, Walk, Cycling. Omit text for the popular list. */
    async searchActivityLibraries(text) {
      if (!text) return (await get("log-activity-libraries/popular")).data ?? [];
      const res = await get("log-activity-categories/v2/section", { page: 1, perPage: 20, textSearch: text });
      return (res.data ?? []).flatMap((c) => (c.libraries ?? []).map((l) => ({ ...l, category: c.unique_code })));
    },

    /** One activity type with the metric fields it accepts and each field's valid units. */
    async getActivityLibrary(libraryId) {
      return (await get(`log-activity-libraries/${libraryId}`)).data;
    },

    /**
     * Log a cardio/activity session — the "+ Activity" flow in the app, not a workout assignment.
     *
     * @param {object} a
     * @param {string} [a.activity]   activity name to look up, e.g. "Run" (or pass libraryId)
     * @param {string} [a.libraryId]  skip the lookup with a known log_activity_library id
     * @param {Date|string} a.start   start time
     * @param {Date|string} [a.end]   end time; or give durationMinutes
     * @param {number} [a.durationMinutes]
     * @param {object} [a.metrics]    by field code: {distance: "7.22km", avg_heart_rate: 126, calories: 500}
     *                                bare numbers use the field's default unit
     * @param {string} [a.note]
     */
    async logActivity({ activity, libraryId, start, end, durationMinutes, metrics = {}, note = "" }) {
      if (!libraryId) {
        if (!activity) throw new Error("logActivity needs activity or libraryId");
        const matches = await this.searchActivityLibraries(activity);
        const exact = matches.find((m) => m.name.toLowerCase() === activity.toLowerCase());
        const hit = exact ?? matches[0];
        if (!hit) throw new Error(`no activity type matches "${activity}"`);
        libraryId = hit._id;
      }
      const library = await this.getActivityLibrary(libraryId);

      const startAt = new Date(start);
      if (Number.isNaN(startAt.getTime())) throw new Error(`unparseable start time: ${start}`);
      const endAt = end
        ? new Date(end)
        : durationMinutes != null
          ? new Date(startAt.getTime() + durationMinutes * 60_000)
          : null;
      if (!endAt || Number.isNaN(endAt.getTime())) throw new Error("logActivity needs end or durationMinutes");
      if (endAt <= startAt) throw new Error("end time must be after start time");

      const tracking_fields = trackingFields(library, metrics);

      const res = await send("POST", "log-activities", {
        log_activity_library: libraryId,
        tracking_fields,
        note,
        icon: library.icon,
        background_icon_color: library.background_icon_color,
        start_time: startAt.toISOString(),
        end_time: endAt.toISOString(),
      });
      return res.data ?? res;
    },

    /**
     * Edit a logged activity. The API replaces the whole record, so this reads the current one,
     * applies your changes on top, and sends the merged result — fields you omit are preserved.
     * Set a metric to null to remove it.
     *
     * Note: `rating` cannot be changed here — the API accepts the field and ignores it (verified
     * against the captured payload shape), so the current value is passed through unchanged.
     *
     * @param {string} activityId
     * @param {object} changes {start, end, durationMinutes, metrics, note}
     */
    async updateActivity(activityId, { start, end, durationMinutes, metrics, note } = {}) {
      const current = await this.getActivity(activityId);
      const libraryId = current.log_activity_library?._id ?? current.log_activity_library;
      const library = await this.getActivityLibrary(libraryId);

      const startAt = start != null ? new Date(start) : new Date(current.start_time);
      if (Number.isNaN(startAt.getTime())) throw new Error(`unparseable start time: ${start}`);
      let endAt;
      if (end != null) endAt = new Date(end);
      else if (durationMinutes != null) endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
      else endAt = new Date(current.end_time);
      if (Number.isNaN(endAt.getTime())) throw new Error(`unparseable end time: ${end}`);
      if (endAt <= startAt) throw new Error("end time must be after start time");

      // null removes a metric; omitted metrics keep their current value.
      const merged = { ...metricsFromActivity(current), ...(metrics ?? {}) };
      for (const [k, v] of Object.entries(merged)) if (v == null || v === "") delete merged[k];

      const res = await send("PATCH", `log-activities/${activityId}`, {
        icon: current.icon ?? library.icon,
        background_icon_color: current.background_icon_color ?? library.background_icon_color,
        rating: current.rating ?? -1, // preserved, not settable

        tracking_fields: trackingFields(library, merged),
        log_type: current.log_type ?? "normal",
        note: note ?? current.note ?? "",
        start_time: startAt.toISOString(),
        end_time: endAt.toISOString(),
      });
      return res.data ?? res;
    },

    /** Delete a logged activity. Takes the id logActivity returned. */
    async deleteActivity(activityId) {
      return send("DELETE", `log-activities/${activityId}`);
    },

    /** One logged activity by id. */
    async getActivity(activityId) {
      return (await get(`log-activities/${activityId}`)).data;
    },

    /**
     * Body metrics this account can log (weight, steps, body_fat, plus any the coach added),
     * each with the units it accepts. Same role list_activity_types plays for cardio.
     */
    async listBodyMetrics() {
      const { clientId: id } = await login();
      if (!id) throw new Error("could not determine clientId — pass clientId or use email/password");
      const res = await get("body-metric/get-full-list-client-body-metric", { clientId: id });
      return res.data ?? [];
    },

    /**
     * Log a body-metric entry — the app's metric-tracking flow (weight, steps, ...), separate from
     * both workout assignments and logged activities.
     *
     * @param {object} e
     * @param {string} e.metric        unique_code or display name, e.g. "weight"
     * @param {number|string} e.value  82.8, or "82.8kg" to name the unit inline
     * @param {string} [e.unit]        unit code, e.g. "kg" — defaults to the metric's current unit
     * @param {Date|string} [e.date]   defaults to now; a bare YYYY-MM-DD lands at local noon so the
     *                                 server's day bucket cannot shift across a timezone boundary
     */
    async logBodyMetric({ metric, value, unit, date }) {
      if (!metric) throw new Error("logBodyMetric needs a metric");
      if (value == null || value === "") throw new Error("logBodyMetric needs a value");
      const entry = bodyMetricEntry(await this.listBodyMetrics(), metric, value, unit);

      const at = date == null ? new Date() : new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date);
      if (Number.isNaN(at.getTime())) throw new Error(`unparseable date: ${date}`);

      const { clientId: id } = await login();
      const res = await send("POST", "body-metric-entry/add-entry", {
        client: id,
        date: at.toISOString(),
        ...entry,
      });
      return res.data ?? res;
    },

    /** Profile with credential fields stripped — this payload embeds a fresh firebase_token. */
    async getProfile() {
      const u = await get("profile/v2/client");
      const { firebase_token, token, refresh_token, switch_platform_token, ...rest } = u.data ?? u;
      return rest;
    },
  };
}
