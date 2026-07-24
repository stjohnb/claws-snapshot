import * as pty from "node-pty";
import { spawn as childSpawn } from "node:child_process";
import * as log from "./log.js";
import { isShuttingDown } from "./shutdown.js";
import { WORK_DIR } from "./config.js";
import * as claude from "./claude.js";
import { listRepos } from "./github.js";
import { buildCapabilityEnvArgs, buildCapabilityPrompt } from "./capabilities.js";
import type { Repo } from "./config.js";
import {
  insertSession,
  getAllPersistedSessions,
  deletePersistedSession,
  updateSessionSummary,
  getEndedSessions,
  getPersistedSession,
  markSessionEnded,
  clearSessionEnded,
  pruneEndedSessions,
  type PersistedSession,
} from "./db.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { stripVTControlCharacters } from "node:util";

const TMUX_SOCKET = "claws";
const SESSION_NAME_PREFIX = "claws-";
const SCROLLBACK_LIMIT = 50_000;
const MAX_RESPAWN_ATTEMPTS = 3;
const RESPAWN_MIN_LIFETIME_MS = 500;
const MAX_ENDED_SESSIONS = 50;

export const SESSION_MODES = ["repo-zsh", "repo-claude", "worktree-claude", "home-claude", "multi-worktree-claude"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export interface Session {
  id: string;
  pty: pty.IPty;
  tmuxName: string;
  createdAt: number;
  lastActivity: number;
  repo: string | null;
  cwd: string;
  mode: SessionMode;
  worktreePath: string | null;
  extraWorktrees: Array<{ repo: string; worktreePath: string }>;
  capabilities: string[];
  scrollback: string;
  alive: boolean;
  exitCode: number | null;
  wsConnected: boolean;
  bridgeSpawnedAt: number;
  respawnCount: number;
  resumable: boolean;
  resumeRepos: string[];
  summary: string | null;
  summaryUpdatedAt: number | null;
}

export type CreateSessionError =
  | "shutting-down"
  | "too-few-repos"
  | "repo-required-for-mode"
  | "repo-not-found"
  | "repo-not-listed"
  | "fetch-failed"
  | "worktree-failed"
  | "tmux-failed"
  | "bridge-failed"
  | "persist-failed";

export type CreateSessionResult =
  | { ok: true; session: Session }
  | { ok: false; reason: CreateSessionError; detail?: string };

export function describeCreateSessionError(err: { reason: CreateSessionError; detail?: string }): string {
  switch (err.reason) {
    case "shutting-down": return "Server is shutting down";
    case "too-few-repos": return "Select at least two repos for a multi-repo session";
    case "repo-required-for-mode": return "This mode requires a repo to be selected";
    case "repo-not-found": return `Repo not found${err.detail ? `: ${err.detail}` : ""}`;
    case "repo-not-listed": return `Repo is not in the configured repo list${err.detail ? `: ${err.detail}` : ""}`;
    case "fetch-failed": return `Failed to fetch latest changes from GitHub${err.detail ? `: ${err.detail}` : ""}`;
    case "worktree-failed": return `Failed to create worktree${err.detail ? `: ${err.detail}` : ""}`;
    case "tmux-failed": return `tmux failed to start the session${err.detail ? `: ${err.detail}` : ""}`;
    case "bridge-failed": return `Failed to attach to tmux session${err.detail ? `: ${err.detail}` : ""}`;
    case "persist-failed": return `Failed to persist session${err.detail ? `: ${err.detail}` : ""}`;
  }
}

const sessions = new Map<string, Session>();

async function tmuxCmd(args: string[], socket: string | null = TMUX_SOCKET): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const sockArgs = socket ? ["-L", socket] : [];
    const proc = childSpawn("tmux", [...sockArgs, ...args]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on("error", () => resolve({ code: 1, stdout, stderr }));
  });
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  const r = await tmuxCmd(["has-session", "-t", `=${name}`]);
  return r.code === 0;
}

async function tmuxListSessions(): Promise<Set<string>> {
  const r = await tmuxCmd(["list-sessions", "-F", "#{session_name}"]);
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\n").filter(Boolean));
}

async function tmuxListSessionsOnDefaultSocket(): Promise<Set<string>> {
  const r = await tmuxCmd(["list-sessions", "-F", "#{session_name}"], null);
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\n").filter(Boolean));
}

async function tmuxCapturePane(name: string): Promise<string> {
  const r = await tmuxCmd(["capture-pane", "-p", "-S", "-10000", "-t", `=${name}:`]);
  return r.code === 0 ? r.stdout : "";
}

async function tmuxKillSession(name: string): Promise<void> {
  await tmuxCmd(["kill-session", "-t", `=${name}`]);
}

function spawnBridge(tmuxName: string, cwd: string): pty.IPty {
  return pty.spawn("tmux", ["-L", TMUX_SOCKET, "attach-session", "-t", `=${tmuxName}`], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
  });
}

function wireBridgeHandlers(session: Session): void {
  session.pty.onData((data: string) => {
    session.lastActivity = Date.now();
    session.scrollback += data;
    if (session.scrollback.length > SCROLLBACK_LIMIT) {
      session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT);
    }
  });
  session.pty.onExit(({ exitCode }) => handleBridgeExit(session, exitCode));
}

function handleBridgeExit(session: Session, exitCode: number): void {
  session.exitCode = exitCode;
  void tmuxSessionExists(session.tmuxName).then((exists) => {
    if (!sessions.has(session.id)) return;
    if (!exists) {
      session.alive = false;
      session.resumable = true;
      recordSessionEnded(session);   // reads extraWorktrees synchronously → must run BEFORE cleanup
      log.info(`[sessions] Session ${session.id} exited (code ${exitCode}) — moved to history`);
      void cleanupSessionWorktree(session);
      sessions.delete(session.id);
      return;
    }
    if (isShuttingDown()) return;

    const lifetime = Date.now() - session.bridgeSpawnedAt;
    if (lifetime < RESPAWN_MIN_LIFETIME_MS) {
      session.respawnCount += 1;
      if (session.respawnCount >= MAX_RESPAWN_ATTEMPTS) {
        session.alive = false;
        log.error(`[sessions] Session ${session.id} bridge failed to stay up after ${MAX_RESPAWN_ATTEMPTS} attempts — giving up`);
        deletePersistedSession(session.id);
        void tmuxKillSession(session.tmuxName);
        void cleanupSessionWorktree(session);
        return;
      }
    } else {
      session.respawnCount = 0;
    }

    log.info(`[sessions] Session ${session.id} bridge exited but tmux persists — respawning bridge`);
    try {
      session.pty = spawnBridge(session.tmuxName, session.cwd);
      session.bridgeSpawnedAt = Date.now();
      wireBridgeHandlers(session);
    } catch (err) {
      session.alive = false;
      log.error(`[sessions] Session ${session.id} failed to respawn bridge: ${err}`);
      deletePersistedSession(session.id);
      void tmuxKillSession(session.tmuxName);
      void cleanupSessionWorktree(session);
    }
  });
}

/**
 * Build the argv passed to `claude` for a session spawn. Always disables
 * permission prompts; appends a `--append-system-prompt` capability-awareness
 * block ONLY when at least one capability was granted (an empty prompt would
 * otherwise leave a dangling flag that consumes the next argv).
 */
function claudeShellArgs(caps: string[], extra: string[]): string[] {
  const prompt = buildCapabilityPrompt(caps);
  const promptArgs = prompt ? ["--append-system-prompt", prompt] : [];
  return ["--dangerously-skip-permissions", ...promptArgs, ...extra];
}

export async function createSession(repo: string | null, mode: SessionMode, capabilities: string[] = []): Promise<CreateSessionResult> {
  if (isShuttingDown()) return { ok: false, reason: "shutting-down" };

  if (mode === "multi-worktree-claude") {
    // Multi-repo sessions must be created via createMultiWorktreeSession.
    return { ok: false, reason: "repo-required-for-mode" };
  }

  if (!repo && (mode === "worktree-claude" || mode === "repo-claude")) {
    log.warn(`[sessions] Rejected: mode=${mode} requires a repo`);
    return { ok: false, reason: "repo-required-for-mode" };
  }

  const id = crypto.randomBytes(8).toString("hex");

  let cwd: string;
  let worktreePath: string | null = null;

  if (!repo || mode === "home-claude") {
    cwd = os.homedir();
  } else {
    const reposBase = path.join(WORK_DIR, "repos");
    const mainClone = path.resolve(reposBase, repo);
    if (!mainClone.startsWith(reposBase + path.sep) || !fs.existsSync(mainClone)) {
      log.warn(`[sessions] Rejected: repo path does not exist: ${repo}`);
      return { ok: false, reason: "repo-not-found", detail: repo ?? undefined };
    }

    const repoObj = (await listRepos().catch(() => [] as Repo[]))
      .find((r) => r.fullName === repo);
    if (!repoObj) {
      log.warn(`[sessions] Rejected: repo not in listRepos(): ${repo}`);
      return { ok: false, reason: "repo-not-listed", detail: repo ?? undefined };
    }

    try {
      await claude.ensureClone(repoObj);
    } catch (err) {
      log.warn(`[sessions] Failed to refresh ${repo} before session: ${err}`);
      return { ok: false, reason: "fetch-failed", detail: String(err) };
    }

    if (mode === "worktree-claude") {
      const branchName = `claws-wt/${id}`;
      try {
        worktreePath = await claude.createWorktree(repoObj, branchName, "sessions");
      } catch (err) {
        log.warn(`[sessions] Failed to create session worktree for ${repo}: ${err}`);
        return { ok: false, reason: "worktree-failed", detail: String(err) };
      }
      cwd = worktreePath;
    } else {
      cwd = mainClone;
    }
  }

  const tmuxName = `claws-${id}`;
  const command = mode === "repo-zsh" ? "zsh" : "claude";
  const envArgs = buildCapabilityEnvArgs(capabilities);
  const shellArgs = mode === "repo-zsh" ? [] : claudeShellArgs(capabilities, []);

  const createRes = await tmuxCmd([
    "new-session", "-d", "-s", tmuxName,
    "-x", "120", "-y", "40",
    "-c", cwd,
    ...envArgs, command, ...shellArgs,
  ]);
  if (createRes.code !== 0) {
    log.warn(`[sessions] tmux new-session failed: ${createRes.stderr.trim()}`);
    if (worktreePath && repo) {
      const repoObj = (await listRepos().catch(() => [] as Repo[])).find(r => r.fullName === repo);
      if (repoObj) await claude.removeWorktree(repoObj, worktreePath).catch(() => {});
    }
    return { ok: false, reason: "tmux-failed", detail: createRes.stderr.trim() };
  }

  const mouseRes = await tmuxCmd(["set-option", "-t", `=${tmuxName}`, "mouse", "on"]);
  if (mouseRes.code !== 0) {
    log.warn(`[sessions] Failed to enable tmux mouse mode for ${tmuxName}: ${mouseRes.stderr.trim()}`);
  }

  let proc: pty.IPty;
  try {
    proc = spawnBridge(tmuxName, cwd);
  } catch (err) {
    log.warn(`[sessions] Failed to attach bridge to tmux session ${tmuxName}: ${err}`);
    await tmuxKillSession(tmuxName);
    if (worktreePath && repo) {
      const repoObj = (await listRepos().catch(() => [] as Repo[])).find(r => r.fullName === repo);
      if (repoObj) await claude.removeWorktree(repoObj, worktreePath).catch(() => {});
    }
    return { ok: false, reason: "bridge-failed", detail: String(err) };
  }

  try {
    insertSession({
      id,
      tmux_name: tmuxName,
      mode,
      repo,
      cwd,
      worktree_path: worktreePath,
      extra_worktrees: null,
      capabilities: JSON.stringify(capabilities),
      created_at: Date.now(),
      summary: null,
      summary_updated_at: null,
    });
  } catch (err) {
    log.error(`[sessions] Failed to persist session ${id}: ${err}`);
    proc.kill();
    await tmuxKillSession(tmuxName);
    if (worktreePath && repo) {
      const repoObj = (await listRepos().catch(() => [] as Repo[])).find(r => r.fullName === repo);
      if (repoObj) await claude.removeWorktree(repoObj, worktreePath).catch(() => {});
    }
    return { ok: false, reason: "persist-failed", detail: String(err) };
  }

  const session: Session = {
    id,
    pty: proc,
    tmuxName,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    repo,
    cwd,
    mode,
    worktreePath,
    extraWorktrees: [],
    capabilities,
    scrollback: "",
    alive: true,
    exitCode: null,
    wsConnected: false,
    bridgeSpawnedAt: Date.now(),
    respawnCount: 0,
    resumable: false,
    resumeRepos: [],
    summary: null,
    summaryUpdatedAt: null,
  };

  wireBridgeHandlers(session);

  sessions.set(id, session);
  log.info(`[sessions] Created session ${id} (cwd: ${cwd}, mode: ${mode}, tmux: ${tmuxName})`);
  return { ok: true, session };
}

/**
 * Launch a Claude session wired to a fresh worktree for each of `repos`.
 * Claude runs with its cwd set to the first repo's worktree; the remaining
 * worktrees are passed via `--add-dir` so it can read/write across all of them.
 */
export async function createMultiWorktreeSession(repos: string[], capabilities: string[] = []): Promise<CreateSessionResult> {
  if (isShuttingDown()) return { ok: false, reason: "shutting-down" };

  const deduped: string[] = [];
  for (const r of repos) {
    if (r && !deduped.includes(r)) deduped.push(r);
  }
  if (deduped.length < 2) return { ok: false, reason: "too-few-repos" };

  const id = crypto.randomBytes(8).toString("hex");
  const reposBase = path.join(WORK_DIR, "repos");
  const allRepos = await listRepos().catch(() => [] as Repo[]);

  // Resolve every repo up front so we don't create worktrees for a batch that
  // contains an invalid entry.
  const resolved: Repo[] = [];
  for (const repo of deduped) {
    const mainClone = path.resolve(reposBase, repo);
    if (!mainClone.startsWith(reposBase + path.sep) || !fs.existsSync(mainClone)) {
      log.warn(`[sessions] Rejected multi-repo session: repo path does not exist: ${repo}`);
      return { ok: false, reason: "repo-not-found", detail: repo };
    }
    const repoObj = allRepos.find((r) => r.fullName === repo);
    if (!repoObj) {
      log.warn(`[sessions] Rejected multi-repo session: repo not in listRepos(): ${repo}`);
      return { ok: false, reason: "repo-not-listed", detail: repo };
    }
    resolved.push(repoObj);
  }

  const created: Array<{ repo: string; worktreePath: string }> = [];
  for (const repoObj of resolved) {
    try {
      await claude.ensureClone(repoObj);
    } catch (err) {
      log.warn(`[sessions] Failed to refresh ${repoObj.fullName} before multi-repo session: ${err}`);
      await removeWorktreesByRepo(created);
      return { ok: false, reason: "fetch-failed", detail: String(err) };
    }
    try {
      const wtPath = await claude.createWorktree(repoObj, `claws-wt/${id}`, "sessions");
      created.push({ repo: repoObj.fullName, worktreePath: wtPath });
    } catch (err) {
      log.warn(`[sessions] Failed to create worktree for ${repoObj.fullName}: ${err}`);
      await removeWorktreesByRepo(created);
      return { ok: false, reason: "worktree-failed", detail: String(err) };
    }
  }

  const cwd = created[0].worktreePath;
  const extraWorktrees = created.slice(1);
  const addDirArgs = extraWorktrees.flatMap((w) => ["--add-dir", w.worktreePath]);

  const tmuxName = `claws-${id}`;
  const createRes = await tmuxCmd([
    "new-session", "-d", "-s", tmuxName,
    "-x", "120", "-y", "40",
    "-c", cwd,
    ...buildCapabilityEnvArgs(capabilities), "claude", ...claudeShellArgs(capabilities, addDirArgs),
  ]);
  if (createRes.code !== 0) {
    log.warn(`[sessions] tmux new-session failed for multi-repo session: ${createRes.stderr.trim()}`);
    await removeWorktreesByRepo(created);
    return { ok: false, reason: "tmux-failed", detail: createRes.stderr.trim() };
  }

  const mouseRes = await tmuxCmd(["set-option", "-t", `=${tmuxName}`, "mouse", "on"]);
  if (mouseRes.code !== 0) {
    log.warn(`[sessions] Failed to enable tmux mouse mode for ${tmuxName}: ${mouseRes.stderr.trim()}`);
  }

  let proc: pty.IPty;
  try {
    proc = spawnBridge(tmuxName, cwd);
  } catch (err) {
    log.warn(`[sessions] Failed to attach bridge to tmux session ${tmuxName}: ${err}`);
    await tmuxKillSession(tmuxName);
    await removeWorktreesByRepo(created);
    return { ok: false, reason: "bridge-failed", detail: String(err) };
  }

  try {
    insertSession({
      id,
      tmux_name: tmuxName,
      mode: "multi-worktree-claude",
      repo: created[0].repo,
      cwd,
      worktree_path: created[0].worktreePath,
      extra_worktrees: JSON.stringify(extraWorktrees),
      capabilities: JSON.stringify(capabilities),
      created_at: Date.now(),
      summary: null,
      summary_updated_at: null,
    });
  } catch (err) {
    log.error(`[sessions] Failed to persist multi-repo session ${id}: ${err}`);
    proc.kill();
    await tmuxKillSession(tmuxName);
    await removeWorktreesByRepo(created);
    return { ok: false, reason: "persist-failed", detail: String(err) };
  }

  const session: Session = {
    id,
    pty: proc,
    tmuxName,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    repo: created[0].repo,
    cwd,
    mode: "multi-worktree-claude",
    worktreePath: created[0].worktreePath,
    extraWorktrees,
    capabilities,
    scrollback: "",
    alive: true,
    exitCode: null,
    wsConnected: false,
    bridgeSpawnedAt: Date.now(),
    respawnCount: 0,
    resumable: false,
    resumeRepos: [],
    summary: null,
    summaryUpdatedAt: null,
  };

  wireBridgeHandlers(session);

  sessions.set(id, session);
  log.info(`[sessions] Created multi-repo session ${id} (repos: ${created.map((c) => c.repo).join(", ")}, tmux: ${tmuxName})`);
  return { ok: true, session };
}

async function reapOrphanTmuxSessions(
  knownNames: Set<string>,
  liveClawsSocket: Set<string>,
): Promise<void> {
  for (const name of liveClawsSocket) {
    if (!name.startsWith(SESSION_NAME_PREFIX)) continue;
    if (knownNames.has(name)) continue;
    log.warn(`[sessions] Reaping stray tmux session ${name} (claws socket, no DB row)`);
    await tmuxKillSession(name);
  }
  let defaultSocket: Set<string>;
  try {
    defaultSocket = await tmuxListSessionsOnDefaultSocket();
  } catch (err) {
    log.warn(`[sessions] Failed to query default tmux socket for stray sessions: ${err}`);
    return;
  }
  for (const name of defaultSocket) {
    if (!name.startsWith(SESSION_NAME_PREFIX)) continue;
    log.warn(`[sessions] Reaping stray tmux session ${name} (default socket — claws never creates here)`);
    await tmuxCmd(["kill-session", "-t", `=${name}`], null);
  }
}

export async function recoverSessions(): Promise<void> {
  let persisted: ReturnType<typeof getAllPersistedSessions>;
  try {
    persisted = getAllPersistedSessions();
  } catch (err) {
    log.warn(`[sessions] Failed to read persisted sessions: ${err}`);
    return;
  }

  let tmuxAlive: Set<string>;
  try {
    tmuxAlive = await tmuxListSessions();
  } catch (err) {
    log.warn(`[sessions] Failed to query tmux (is tmux installed?): ${err} — skipping recovery`);
    return;
  }

  const knownNames = new Set(persisted.map((r) => r.tmux_name));
  const repos = persisted.some((r) => r.worktree_path) ? await listRepos().catch(() => [] as Repo[]) : [];

  for (const row of persisted) {
    if (!tmuxAlive.has(row.tmux_name)) {
      log.info(`[sessions] Persisted session ${row.id} no longer in tmux — cleaning up`);
      deletePersistedSession(row.id);
      if (row.worktree_path && row.repo) {
        try {
          const repoObj = repos.find((r) => r.fullName === row.repo);
          if (repoObj) await claude.removeWorktree(repoObj, row.worktree_path);
        } catch {
          // best effort
        }
      }
      await removeWorktreesByRepo(parseExtraWorktrees(row.extra_worktrees));
      continue;
    }

    const mouseRes = await tmuxCmd(["set-option", "-t", `=${row.tmux_name}`, "mouse", "on"]);
    if (mouseRes.code !== 0) {
      log.warn(`[sessions] Failed to enable tmux mouse mode for ${row.tmux_name} during recovery: ${mouseRes.stderr.trim()}`);
    }

    const captured = await tmuxCapturePane(row.tmux_name);
    let proc: pty.IPty;
    try {
      proc = spawnBridge(row.tmux_name, row.cwd);
    } catch (err) {
      log.warn(`[sessions] Failed to re-attach bridge for session ${row.id}: ${err}`);
      deletePersistedSession(row.id);
      await tmuxKillSession(row.tmux_name).catch(() => {});
      if (row.worktree_path && row.repo) {
        const repoObj = repos.find((r) => r.fullName === row.repo);
        if (repoObj) await claude.removeWorktree(repoObj, row.worktree_path).catch(() => {});
      }
      await removeWorktreesByRepo(parseExtraWorktrees(row.extra_worktrees));
      continue;
    }

    const session: Session = {
      id: row.id,
      pty: proc,
      tmuxName: row.tmux_name,
      createdAt: row.created_at,
      lastActivity: Date.now(),
      repo: row.repo,
      cwd: row.cwd,
      mode: row.mode as SessionMode,
      worktreePath: row.worktree_path,
      extraWorktrees: parseExtraWorktrees(row.extra_worktrees),
      capabilities: parseCapabilities(row.capabilities),
      scrollback: captured.slice(-SCROLLBACK_LIMIT),
      alive: true,
      exitCode: null,
      wsConnected: false,
      bridgeSpawnedAt: Date.now(),
      respawnCount: 0,
      resumable: false,
      resumeRepos: [],
      summary: row.summary,
      summaryUpdatedAt: row.summary_updated_at,
    };

    wireBridgeHandlers(session);
    sessions.set(row.id, session);
    log.info(`[sessions] Recovered session ${row.id} (mode: ${row.mode}, tmux: ${row.tmux_name})`);
  }

  await reapOrphanTmuxSessions(knownNames, tmuxAlive);
}

function parseExtraWorktrees(raw: string | null): Array<{ repo: string; worktreePath: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseCapabilities(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseResumeRepos(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Persist an ended session to history so it can be listed and resumed later.
 * Reads `extraWorktrees`/`repo` synchronously to capture the repos needed to
 * rebuild the worktree(s) on resume — MUST run before `cleanupSessionWorktree`,
 * which nulls those fields.
 */
function recordSessionEnded(session: Session): void {
  let resumeRepos: string[] = [];
  if (session.mode === "worktree-claude" && session.repo) resumeRepos = [session.repo];
  else if (session.mode === "multi-worktree-claude") resumeRepos = [session.repo, ...session.extraWorktrees.map((w) => w.repo)].filter(Boolean) as string[];
  try {
    markSessionEnded(session.id, Date.now(), JSON.stringify(resumeRepos));
    pruneEndedSessions(MAX_ENDED_SESSIONS);
  } catch (err) {
    log.warn(`[sessions] Failed to record ended session ${session.id}: ${err}`);
  }
}

/**
 * Rebuild an in-memory Session from a DB row for an ended session, so
 * `resumeSession` can relaunch it. The `pty` field is a placeholder — the
 * reconstructed object is kept local (never published to the `sessions` map)
 * until resume assigns a live bridge, so the placeholder is never reachable
 * via `getSession()` and must never be dereferenced first.
 */
function reconstructEndedSession(row: PersistedSession): Session {
  return {
    id: row.id, pty: undefined as unknown as pty.IPty, tmuxName: row.tmux_name,
    createdAt: row.created_at, lastActivity: Date.now(), repo: row.repo, cwd: row.cwd,
    mode: row.mode as SessionMode, worktreePath: row.worktree_path, extraWorktrees: [],
    capabilities: parseCapabilities(row.capabilities), scrollback: "", alive: false,
    exitCode: null, wsConnected: false, bridgeSpawnedAt: Date.now(), respawnCount: 0,
    resumable: true, resumeRepos: parseResumeRepos(row.resume_repos),
    summary: row.summary, summaryUpdatedAt: row.summary_updated_at,
  };
}

async function removeWorktreesByRepo(
  items: Array<{ repo: string; worktreePath: string }>,
): Promise<void> {
  if (items.length === 0) return;
  const repos = await listRepos().catch(() => [] as Repo[]);
  for (const it of items) {
    const repoObj = repos.find((r) => r.fullName === it.repo);
    if (repoObj) await claude.removeWorktree(repoObj, it.worktreePath).catch(() => {});
  }
}

async function cleanupSessionWorktree(session: Session): Promise<void> {
  if (session.extraWorktrees.length > 0) {
    await removeWorktreesByRepo(session.extraWorktrees);
    session.extraWorktrees = [];
  }
  if (!session.worktreePath || !session.repo) return;
  const worktreePath = session.worktreePath;
  session.worktreePath = null;
  try {
    const repoObj = (await listRepos().catch(() => [] as Repo[]))
      .find((r) => r.fullName === session.repo);
    if (!repoObj) {
      log.warn(`[sessions] Cannot clean up worktree for ${session.id}: repo ${session.repo} not found`);
      return;
    }
    await claude.removeWorktree(repoObj, worktreePath);
    log.info(`[sessions] Cleaned up worktree for session ${session.id}`);
  } catch (err) {
    log.warn(`[sessions] Failed to clean up worktree for session ${session.id}: ${err}`);
  }
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Array<{
  id: string;
  repo: string | null;
  extraRepos: string[];
  cwd: string;
  createdAt: number;
  alive: boolean;
  resumable: boolean;
  wsConnected: boolean;
  summary: string | null;
  summaryUpdatedAt: number | null;
  endedAt: number | null;
}> {
  return [...sessions.values()].map((s) => {
    const extraRepos = s.extraWorktrees.length > 0
      ? s.extraWorktrees.map((w) => w.repo)
      : s.resumeRepos.filter((r) => r && r !== s.repo);
    return {
      id: s.id,
      repo: s.repo,
      extraRepos,
      cwd: s.cwd,
      createdAt: s.createdAt,
      alive: s.alive,
      resumable: s.resumable,
      wsConnected: s.wsConnected,
      summary: s.summary,
      summaryUpdatedAt: s.summaryUpdatedAt,
      endedAt: null,
    };
  });
}

export function listEndedSessions(): Array<{ id: string; repo: string | null; extraRepos: string[]; cwd: string; createdAt: number; alive: boolean; resumable: boolean; wsConnected: boolean; summary: string | null; summaryUpdatedAt: number | null; endedAt: number | null }> {
  return getEndedSessions().map((row) => ({
    id: row.id, repo: row.repo,
    extraRepos: parseResumeRepos(row.resume_repos).filter((r) => r && r !== row.repo),
    cwd: row.cwd, createdAt: row.created_at,
    alive: false, resumable: true, wsConnected: false,
    summary: row.summary, summaryUpdatedAt: row.summary_updated_at, endedAt: row.ended_at,
  }));
}

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  // A session that's already !alive here was abandoned by handleBridgeExit's
  // respawn-give-up branch, which already deleted its persisted row — the map
  // entry only lingers for the reaper (below) to sweep. Only a live kill (the
  // "End" button, which is only rendered for alive sessions) should move the
  // session to history; recording history a second time would silently no-op
  // against an already-deleted row while still logging "moved to history".
  const wasAlive = session.alive;
  if (wasAlive) session.pty.kill();
  void tmuxKillSession(session.tmuxName);
  if (wasAlive) {
    recordSessionEnded(session);        // reads extraWorktrees synchronously → must run BEFORE cleanup
  }
  void cleanupSessionWorktree(session);
  sessions.delete(id);
  if (wasAlive) {
    log.info(`[sessions] Ended session ${id} (moved to history)`);
  } else {
    log.info(`[sessions] Reaped abandoned session ${id} (bridge failed to respawn; not recorded in history)`);
  }
  return true;
}

/** Permanently remove a session from both memory and history. */
export function deleteSession(id: string): boolean {
  const session = sessions.get(id);
  if (session) {
    if (session.alive) session.pty.kill();
    void tmuxKillSession(session.tmuxName);
    void cleanupSessionWorktree(session);
    sessions.delete(id);
  }
  deletePersistedSession(id);
  log.info(`[sessions] Deleted session ${id}`);
  return true;
}

export async function resumeSession(id: string): Promise<CreateSessionResult> {
  if (isShuttingDown()) return { ok: false, reason: "shutting-down" };
  let session = sessions.get(id);
  // A session reconstructed from history is NOT published into the live
  // `sessions` map until its bridge is live (at the end of this function).
  // Publishing early would expose a session whose `pty` is a placeholder to
  // `getSession()`/the WS route during the seconds-long worktree/tmux/bridge
  // rebuild, crashing any concurrent WS connect on `undefined.onData/resize`;
  // it would also leak an orphaned entry if the rebuild fails partway.
  const reconstructed = !session;
  if (!session) {
    const row = getPersistedSession(id);
    if (!row) return { ok: false, reason: "repo-not-found", detail: id };
    session = reconstructEndedSession(row);
  }
  if (session.alive) return { ok: true, session }; // already running

  // Recreate worktree(s) at the SAME path so `claude --continue` finds the
  // path-keyed conversation history. The worktree is rebuilt fresh from the
  // default branch — uncommitted work from the old session is gone (acceptable;
  // important work is pushed as a branch). History lives in ~/.claude, not the
  // worktree, so it survives.
  if (session.mode === "worktree-claude" || session.mode === "multi-worktree-claude") {
    const allRepos = await listRepos().catch(() => [] as Repo[]);
    const rebuilt: Array<{ repo: string; worktreePath: string }> = [];
    for (const repoName of session.resumeRepos) {
      const repoObj = allRepos.find((r) => r.fullName === repoName);
      if (!repoObj) return { ok: false, reason: "repo-not-listed", detail: repoName };
      try {
        const wt = await claude.createWorktree(repoObj, `claws-wt/${id}`, "sessions");
        rebuilt.push({ repo: repoName, worktreePath: wt });
      } catch (err) {
        return { ok: false, reason: "worktree-failed", detail: String(err) };
      }
    }
    if (rebuilt.length === 0) return { ok: false, reason: "worktree-failed", detail: "no repos to rebuild" };
    session.cwd = rebuilt[0].worktreePath;       // identical to original cwd
    session.worktreePath = rebuilt[0].worktreePath;
    session.extraWorktrees = rebuilt.slice(1);
  } else if (!fs.existsSync(session.cwd)) {
    log.warn(`[sessions] Cannot resume ${id}: cwd no longer exists: ${session.cwd}`);
    return { ok: false, reason: "repo-not-found", detail: session.cwd };
  }

  const command = session.mode === "repo-zsh" ? "zsh" : "claude";
  const addDirArgs = session.extraWorktrees.flatMap((w) => ["--add-dir", w.worktreePath]);
  const envArgs = buildCapabilityEnvArgs(session.capabilities);
  const shellArgs = session.mode === "repo-zsh"
    ? []
    : claudeShellArgs(session.capabilities, ["--continue", ...addDirArgs]);

  const createRes = await tmuxCmd([
    "new-session", "-d", "-s", session.tmuxName,
    "-x", "120", "-y", "40", "-c", session.cwd,
    ...envArgs, command, ...shellArgs,
  ]);
  if (createRes.code !== 0) {
    log.warn(`[sessions] tmux new-session failed on resume: ${createRes.stderr.trim()}`);
    return { ok: false, reason: "tmux-failed", detail: createRes.stderr.trim() };
  }
  await tmuxCmd(["set-option", "-t", `=${session.tmuxName}`, "mouse", "on"]);

  let proc: pty.IPty;
  try {
    proc = spawnBridge(session.tmuxName, session.cwd);
  } catch (err) {
    await tmuxKillSession(session.tmuxName);
    return { ok: false, reason: "bridge-failed", detail: String(err) };
  }

  session.pty = proc;
  session.alive = true;
  session.resumable = false;
  session.exitCode = null;
  session.scrollback = "";
  session.respawnCount = 0;
  session.bridgeSpawnedAt = Date.now();
  session.lastActivity = Date.now();
  if (reconstructed) sessions.set(id, session); // publish only now that pty is live
  wireBridgeHandlers(session);
  clearSessionEnded(id);
  log.info(`[sessions] Resumed session ${id} (cwd: ${session.cwd}, mode: ${session.mode})`);
  return { ok: true, session };
}

const SUMMARY_INTERVAL_MS = 30_000;
const inFlightSummaries = new Set<string>();

const IDLE_SUMMARY_RE = /^\s*(?:idle|waiting|sitting)\b/i;
const IDLE_AGENT_RE = /claude|codex|opencode|agent/i;

function isIdlePlaceholder(summary: string | null): boolean {
  return summary != null && IDLE_SUMMARY_RE.test(summary);
}

export async function summarizeSession(session: Session): Promise<void> {
  if (isShuttingDown()) return;
  if (!session.alive) return;
  if (session.summary && !isIdlePlaceholder(session.summary)) return;
  if (isIdlePlaceholder(session.summary) &&
      session.lastActivity <= (session.summaryUpdatedAt ?? 0)) {
    return;
  }
  if (inFlightSummaries.has(session.id)) return;
  if (!session.scrollback) return;

  const clean = stripVTControlCharacters(session.scrollback);
  const trimmed = clean.slice(-12000);
  if (trimmed.trim().length < 80) return;

  inFlightSummaries.add(session.id);
  try {
    const prompt = `Summarise what the user is currently doing in this interactive terminal session in <=8 words. Be specific: name the file, command, PR/issue number, or task if visible. Do NOT include the repository, worktree, or directory name — that is already shown in a separate column, so it wastes space. Avoid generic phrases like "working on code" or "running commands". If the session is sitting at a plain shell prompt with no recent activity, reply exactly "Idle at shell prompt". If it is sitting at an idle Claude/agent prompt awaiting input, reply exactly "Idle at Claude prompt". Otherwise, if the most recent activity is a Claude/agent session, summarise the agent's current task, not the literal CLI invocation.

Reply with just the summary text. No quotes, no trailing punctuation, no preamble.

Good examples:
- Editing sessions.ts summarizer
- Reviewing PR #1234 comments
- Running vitest suite
- Debugging k3s monitor alert
- Idle at shell prompt
- Idle at Claude prompt

Recent terminal output:
---
${trimmed}
---`;

    const raw = await claude.runClaude(prompt, os.homedir(), {
      capability: "text-only",
      provider: "claude",
      tier: "sonnet",
      timeoutMs: 60_000,
      agent: "plan",
    });

    let summary = raw.trim().split("\n")[0] ?? "";
    summary = summary.replace(/^["']|["']$/g, "").slice(0, 120);
    if (!summary) return;

    if (IDLE_SUMMARY_RE.test(summary)) {
      summary = IDLE_AGENT_RE.test(summary) ? "Idle at Claude prompt" : "Idle at shell prompt";
    }

    session.summary = summary;
    session.summaryUpdatedAt = Date.now();
    updateSessionSummary(session.id, summary, session.summaryUpdatedAt);
  } catch (err) {
    log.warn(`[sessions] Failed to summarize session ${session.id}: ${err}`);
  } finally {
    inFlightSummaries.delete(session.id);
  }
}

setInterval(() => {
  if (isShuttingDown()) return;
  for (const session of sessions.values()) {
    if (!session.alive) continue;
    void summarizeSession(session);
  }
}, SUMMARY_INTERVAL_MS).unref();

// Periodically reap sessions whose tmux has died (bridge gave up respawning).
setInterval(() => {
  for (const [id, session] of sessions) {
    if (!session.alive && !session.resumable) {
      killSession(id);
    }
  }
}, 60_000).unref();

export async function disconnectAllSessions(): Promise<void> {
  const count = sessions.size;
  for (const session of sessions.values()) {
    if (session.alive) session.pty.kill();
  }
  sessions.clear();
  if (count > 0) log.info(`[sessions] Disconnected ${count} bridge(s) on shutdown (tmux sessions persist)`);
}

