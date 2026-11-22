// Node-only session store, kept out of client.mjs so that file stays runtime-agnostic.
// State lives in one file the user owns, not in the MCP client config and never in model context.
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Honours EVERFIT_STATE_DIR, then XDG_CONFIG_HOME, else ~/.config/everfit. */
export function sessionPath() {
  if (process.env.EVERFIT_STATE_DIR) return join(process.env.EVERFIT_STATE_DIR, "session.json");
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "everfit", "session.json");
}

/** Returns null when there is nothing stored — a missing session is normal, not an error. */
export function readSession(path = sessionPath()) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write the session 0600 in a 0700 directory. Contains a live token — and, if the user opted in
 * with --save-password, the password too — so permissions are part of the contract, not a nicety.
 */
export function writeSession(session, path = sessionPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync leaves an existing file's mode alone
  return path;
}

export function clearSession(path = sessionPath()) {
  rmSync(path, { force: true });
  return path;
}

/**
 * Credentials in precedence order: env wins (containers, CI), then the stored session.
 * Pass the result to createClient(). onSession persists a token the client renews on its own.
 */
export function storedClientOptions(path = sessionPath()) {
  const s = readSession(path) ?? {};
  return {
    email: process.env.EVERFIT_EMAIL ?? s.email,
    password: process.env.EVERFIT_PASSWORD ?? s.password,
    token: process.env.EVERFIT_TOKEN ?? s.token,
    clientId: process.env.EVERFIT_CLIENT_ID ?? s.clientId,
    deviceId: process.env.EVERFIT_DEVICE_ID ?? s.deviceId,
    onSession: (next) => {
      // Only rewrite what we already own; never create a session file from env-only config.
      if (!readSession(path)) return;
      writeSession({ ...readSession(path), token: next.token, clientId: next.clientId, expiresAt: next.expiresAt }, path);
    },
  };
}

/** Loose permissions on a file holding a live token are worth a warning, not a hard failure. */
export function permissionWarning(path = sessionPath()) {
  try {
    const mode = statSync(path).mode & 0o777;
    return mode & 0o077 ? `${path} is mode ${mode.toString(8)}; run: chmod 600 ${path}` : null;
  } catch {
    return null;
  }
}
