import fs from "node:fs";
import path from "node:path";
import { WORK_DIR } from "./config.js";

/**
 * Per-session env files for granted capability credentials (#2138). Values used
 * to be placed on the tmux argv as `KEY=value` elements, which made them
 * world-readable via `/proc/<pid>/cmdline`. They are now written here at 0600
 * and sourced by a tiny `/bin/sh` prelude whose argv carries only the path.
 * This module also owns each session's per-session MCP-config/browser-profile
 * directory (#2510).
 */
export function sessionEnvDir(): string {
  return path.join(WORK_DIR, "session-env");
}

/** Single-quote a value for POSIX `sh` sourcing. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envFilePath(sessionId: string): string {
  return path.join(sessionEnvDir(), `${sessionId}.env`);
}

/**
 * Write the granted capability vars for `sessionId` to a 0600 file and return
 * its absolute path. The explicit `chmodSync` calls are load-bearing, not
 * redundant: the `mode` options on `mkdirSync`/`writeFileSync` are masked by
 * umask and ignored entirely when the target already exists (the resume path
 * rewrites the file). Throws on any filesystem failure — callers must treat a
 * failed write as a failed spawn rather than silently running without creds.
 */
export function writeSessionEnvFile(sessionId: string, vars: Record<string, string>): string {
  const dir = sessionEnvDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const body = Object.entries(vars)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}\n`)
    .join("");
  const file = envFilePath(sessionId);
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * Best-effort removal of a session's env file. The `/bin/sh` prelude deletes it
 * immediately after sourcing, so this only matters when the spawn never
 * happened (e.g. `tmux new-session` failed). Never throws.
 */
export function removeSessionEnvFile(sessionId: string): void {
  try {
    fs.rmSync(envFilePath(sessionId), { force: true });
  } catch {
    // Best effort — a leftover 0600 file is not worth failing a teardown over.
  }
}

/**
 * Drop the whole env-file directory. Called once at recovery: a crash between
 * the file write and the tmux spawn leaves a credential sitting on disk with
 * nothing left to consume it. Never throws.
 */
export function pruneSessionEnvFiles(): void {
  try {
    fs.rmSync(sessionEnvDir(), { recursive: true, force: true });
  } catch {
    // Best effort — recovery must not be blocked by a stale env file.
  }
}

/** Per-session directory holding the MCP config and the browser profile. */
export function sessionMcpDir(sessionId: string): string {
  return path.join(WORK_DIR, "session-mcp", sessionId);
}

/** Create (0700) and return the session's MCP dir. Throws on fs failure. */
export function ensureSessionMcpDir(sessionId: string): string {
  const dir = sessionMcpDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** Best-effort removal of the session's MCP dir + browser profile. Never throws. */
export function removeSessionMcpDir(sessionId: string): void {
  try {
    fs.rmSync(sessionMcpDir(sessionId), { recursive: true, force: true });
  } catch {
    // Best effort — a leftover profile dir must not fail a teardown.
  }
}
