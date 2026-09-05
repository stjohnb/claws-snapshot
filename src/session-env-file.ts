import fs from "node:fs";
import os from "node:os";
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

/** Per-session Codex home nested under the session MCP dir for shared cleanup. */
export function sessionCodexHomeDir(sessionId: string): string {
  return path.join(sessionMcpDir(sessionId), "codex-home");
}

/**
 * Create a private per-session Codex home with an empty config and, when
 * present on this host, a copied `auth.json` so file-backed Codex auth still
 * works without inheriting ambient MCP/plugin config.
 */
export function ensureSessionCodexHome(sessionId: string): string {
  const mcpDir = ensureSessionMcpDir(sessionId);
  const homeDir = sessionCodexHomeDir(sessionId);
  const targetAuthPath = path.join(homeDir, "auth.json");
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(homeDir, 0o700);

  const configPath = path.join(homeDir, "config.toml");
  fs.writeFileSync(
    configPath,
    "# Claws session-local Codex config. Ambient plugins and MCP servers are intentionally not inherited.\n",
    { mode: 0o600 },
  );
  fs.chmodSync(configPath, 0o600);

  const sourceAuthPath = path.join(os.homedir(), ".codex", "auth.json");
  if (fs.existsSync(sourceAuthPath)) {
    fs.copyFileSync(sourceAuthPath, targetAuthPath);
    fs.chmodSync(targetAuthPath, 0o600);
  } else {
    fs.rmSync(targetAuthPath, { force: true });
  }

  fs.chmodSync(mcpDir, 0o700);
  return homeDir;
}

/**
 * Remove abandoned per-session MCP/Codex dirs whose ids are no longer backed
 * by a live or resumable session row. Never throws.
 */
export function pruneOrphanSessionMcpDirs(activeSessionIds: Iterable<string>): void {
  const root = path.join(WORK_DIR, "session-mcp");
  try {
    const keep = new Set(activeSessionIds);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (keep.has(entry.name)) continue;
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  } catch {
    // Best effort — recovery must not be blocked by stale private state.
  }
}

/** Best-effort removal of the session's MCP dir + browser profile. Never throws. */
export function removeSessionMcpDir(sessionId: string): void {
  try {
    fs.rmSync(sessionMcpDir(sessionId), { recursive: true, force: true });
  } catch {
    // Best effort — a leftover profile dir must not fail a teardown.
  }
}
