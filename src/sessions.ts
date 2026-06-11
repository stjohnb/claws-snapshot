import * as pty from "node-pty";
import { spawn as childSpawn } from "node:child_process";
import * as log from "./log.js";
import { isShuttingDown } from "./shutdown.js";
import { WORK_DIR } from "./config.js";
import * as claude from "./claude.js";
import { listRepos } from "./github.js";
import type { Repo } from "./config.js";
import {
  insertSession,
  getAllPersistedSessions,
  deletePersistedSession,
  updateSessionSummary,
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

export const SESSION_MODES = ["repo-zsh", "repo-claude", "worktree-claude", "home-claude"] as const;
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
  scrollback: string;
  alive: boolean;
  exitCode: number | null;
  wsConnected: boolean;
  bridgeSpawnedAt: number;
  respawnCount: number;
  summary: string | null;
  summaryUpdatedAt: number | null;
}

export type CreateSessionError =
  | "shutting-down"
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
      log.info(`[sessions] Session ${session.id} tmux session ended (code ${exitCode})`);
      void cleanupSessionWorktree(session);
      deletePersistedSession(session.id);
      setTimeout(() => sessions.delete(session.id), 30_000);
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

export async function createSession(repo: string | null, mode: SessionMode): Promise<CreateSessionResult> {
  if (isShuttingDown()) return { ok: false, reason: "shutting-down" };

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
  const shellArgs = mode === "repo-zsh" ? [] : ["--dangerously-skip-permissions"];

  const createRes = await tmuxCmd([
    "new-session", "-d", "-s", tmuxName,
    "-x", "120", "-y", "40",
    "-c", cwd,
    command, ...shellArgs,
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
    scrollback: "",
    alive: true,
    exitCode: null,
    wsConnected: false,
    bridgeSpawnedAt: Date.now(),
    respawnCount: 0,
    summary: null,
    summaryUpdatedAt: null,
  };

  wireBridgeHandlers(session);

  sessions.set(id, session);
  log.info(`[sessions] Created session ${id} (cwd: ${cwd}, mode: ${mode}, tmux: ${tmuxName})`);
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
      scrollback: captured.slice(-SCROLLBACK_LIMIT),
      alive: true,
      exitCode: null,
      wsConnected: false,
      bridgeSpawnedAt: Date.now(),
      respawnCount: 0,
      summary: row.summary,
      summaryUpdatedAt: row.summary_updated_at,
    };

    wireBridgeHandlers(session);
    sessions.set(row.id, session);
    log.info(`[sessions] Recovered session ${row.id} (mode: ${row.mode}, tmux: ${row.tmux_name})`);
  }

  await reapOrphanTmuxSessions(knownNames, tmuxAlive);
}

async function cleanupSessionWorktree(session: Session): Promise<void> {
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
  cwd: string;
  createdAt: number;
  alive: boolean;
  wsConnected: boolean;
  summary: string | null;
  summaryUpdatedAt: number | null;
}> {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    repo: s.repo,
    cwd: s.cwd,
    createdAt: s.createdAt,
    alive: s.alive,
    wsConnected: s.wsConnected,
    summary: s.summary,
    summaryUpdatedAt: s.summaryUpdatedAt,
  }));
}

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.alive) session.pty.kill();
  void tmuxKillSession(session.tmuxName);
  deletePersistedSession(id);
  void cleanupSessionWorktree(session);
  sessions.delete(id);
  log.info(`[sessions] Killed session ${id}`);
  return true;
}

const SUMMARY_INTERVAL_MS = 90_000;
const inFlightSummaries = new Set<string>();

async function summarizeSession(session: Session): Promise<void> {
  if (isShuttingDown()) return;
  if (!session.alive) return;
  if (inFlightSummaries.has(session.id)) return;
  if (Date.now() - (session.summaryUpdatedAt ?? 0) < SUMMARY_INTERVAL_MS - 5_000) return;
  if (session.summaryUpdatedAt !== null && session.lastActivity <= session.summaryUpdatedAt) return;
  if (!session.scrollback) return;

  inFlightSummaries.add(session.id);
  try {
    const clean = stripVTControlCharacters(session.scrollback);
    const trimmed = clean.slice(-12000);
    if (trimmed.trim().length < 80) {
      session.summary = "Starting…";
      session.summaryUpdatedAt = Date.now();
      updateSessionSummary(session.id, session.summary, session.summaryUpdatedAt);
      return;
    }

    const prompt = `Summarise what the user is currently doing in this interactive terminal session in <=10 words. Be specific: name the file, command, repo, PR/issue number, or task if visible in the output. Avoid generic phrases like "working on code" or "running commands". If the session is sitting at a shell prompt with no recent activity, reply "Idle at shell prompt". If the most recent activity is a Claude/agent session, summarise the agent's current task, not the literal CLI invocation.

Reply with just the summary text. No quotes, no trailing punctuation, no preamble.

Good examples:
- Editing src/sessions.ts summarizer
- Reviewing PR #1234 review comments
- Running pnpm test in claws repo
- Debugging k3s monitor alert
- Idle at shell prompt

Recent terminal output:
---
${trimmed}
---`;

    const raw = await claude.runClaude(prompt, os.homedir(), {
      capability: "text-only",
      tier: "sonnet",
      timeoutMs: 60_000,
      agent: "plan",
    });

    let summary = raw.trim().split("\n")[0] ?? "";
    summary = summary.replace(/^["']|["']$/g, "").slice(0, 120);
    if (!summary) return;

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
    if (!session.alive) {
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

