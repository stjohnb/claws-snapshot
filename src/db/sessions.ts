// Persisted terminal sessions: rows, startup and usage updates, the
// per-repo capability and agent defaults, memory captures, summaries and
// agent status. Reached only through the src/db.ts façade.
import { VERSION } from "../version.js";
import { getDb, timedDb } from "./core.js";
import { retireSessionUsage } from "./usage.js";

// ── Terminal sessions (persist across Claws restarts via tmux) ──

export interface PersistedSession {
  id: string;
  tmux_name: string;
  mode: string;
  repo: string | null;
  cwd: string;
  worktree_path: string | null;
  extra_worktrees: string | null;
  capabilities: string | null;
  created_at: number;
  summary: string | null;
  summary_updated_at: number | null;
  ended_at: number | null;
  resume_repos: string | null;
  /** Agent CLI the session runs (`claude` | `codex`). NULL on rows written before #2664 — every read path must coalesce to `"claude"`. */
  provider: string | null;
  summary_manual: number;
  /** Model id passed to the agent CLI as `--model`. NULL / empty means the provider default; every read path must coalesce to `null` (#2873). */
  model: string | null;
  /** Session backend that owns the row (#3026): `"k8s-pod"`. NULL or `"local-tmux"` marks a legacy row from the removed host tmux backend, kept as history only and never resumable. */
  backend: string | null;
  /** Self-reported agent state set via `claws_set_session_status` (#3083): `working` | `monitoring` | `waiting` | `done`. NULL until the agent reports. */
  agent_status: string | null;
  agent_status_updated_at: number | null;
  /** When the session's pod was last launched (`k8s-pod`, reconcile's grace clock): `created_at` at insert, then each resume that relaunches it. NULL on rows written before #3061. */
  launched_at: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  last_context_tokens: number | null;
  usage_updated_at: number | null;
  startup_state: string | null;
  startup_step: string | null;
  startup_detail: string | null;
  startup_started_at: number | null;
  startup_updated_at: number | null;
  startup_ready_at: number | null;
  startup_failed_at: number | null;
  startup_failure: string | null;
  /** Exit code of the session's process once it ended on its own (#3311); NULL while running, after resume, or when unknown. */
  exit_code: number | null;
  /** Tail of the session's final terminal output, VT sequences stripped (#3311); NULL when none was captured. */
  last_output: string | null;
  /** SHA-256 (`hashAgentMcpToken`) of a legacy `local-tmux` session's per-launch `/mcp/sessions/:id` bearer (history only); NULL for k8s-pod rows, `repo-zsh` shells and rows written before it existed. */
  mcp_token_sha256: string | null;
  /** Claws `VERSION` the session's agent was launched or relaunched under; `sessionUpgradedSince` compares it with the running one. NULL on rows written before it existed. */
  launched_version: string | null;
  /** Issue brief appended to the session prompt on every launch and resume, for a session another session started (`claws_start_session`); NULL otherwise. */
  brief: string | null;
  /** Id of the session whose `claws_start_session` call created this one, for the audit trail only. A plain string, never a live link: ending or deleting that session never touches this row. */
  spawned_by_session: string | null;
  /** Canonical `clw_…` id of the issue this session was started for, alongside `spawned_by_session`. */
  spawned_for_issue: string | null;
  /** `issue-page` when started by the issue page's Create Session button; NULL for board, PRs page and agent starts. */
  spawned_from: string | null;
  /** `owner/name#123` of the pull request the operator started this session for (PRs page or board PR card); NULL otherwise. */
  spawned_for_pr: string | null;
  /** Operator's own first message from a dashboard New Session form's Initial prompt field, handed to the agent CLI at launch; NULL when none was given. Kept after delivery and never shown. */
  initial_prompt: string | null;
  /** When the session's startup first reached `ready` with `initial_prompt` set (`markSessionInitialPromptSent`); while NULL, every relaunch carries the prompt again. */
  initial_prompt_sent_at: number | null;
  /** When this ended session's memory files were captured into `session_memory_captures`; NULL while live, pending, or given up. Reset by every reopen. */
  memories_captured_at?: number | null;
  /** Failed capture attempts since the session last ended; capture gives up at `MAX_MEMORY_CAPTURE_ATTEMPTS` (`session-memory-capture.ts`). Reset by every reopen. */
  memory_capture_attempts?: number | null;
  /** Claude account id the live pod was launched with, shared by the Claude login and pi's Anthropic credential; NULL when it has neither grant, and on rows written before it existed. */
  claude_account?: string | null;
  /**
   * Node the session's pod was last scheduled on, recorded by reconcile from the pod's
   * `spec.nodeName`; its HOME PVC is local storage on that node. NULL on rows written before it
   * existed and on sessions whose pod never got a node: a NULL row with a PVC is treated as on the
   * home node (the last `CLAWS_SESSION_NODES` entry).
   */
  node?: string | null;
  /**
   * The HOME PVC a move gave the session; NULL (rows never moved, and rows written before it
   * existed) means the claim named after the session, `workloadName("session", id)`.
   */
  home_claim?: string | null;
  /** When reconcile found the node holding the session NotReady; NULL while it is Ready. The row stays open meanwhile. */
  node_lost_at?: number | null;
  /** JSON array of the times (ms) the session was relaunched after an eviction or preemption; NULL for none. */
  evicted_restarts?: string | null;
}

export async function insertSession(
  row: Omit<PersistedSession, "ended_at" | "resume_repos" | "backend" | "agent_status" | "agent_status_updated_at" | "launched_at" | "tokens_used" | "cost_usd" | "last_context_tokens" | "usage_updated_at" | "startup_state" | "startup_step" | "startup_detail" | "startup_started_at" | "startup_updated_at" | "startup_ready_at" | "startup_failed_at" | "startup_failure" | "exit_code" | "last_output" | "mcp_token_sha256" | "launched_version" | "brief" | "spawned_by_session" | "spawned_for_issue" | "spawned_from" | "spawned_for_pr" | "initial_prompt" | "initial_prompt_sent_at" | "summary_manual"> & { backend?: string | null; mcp_token_sha256?: string | null; brief?: string | null; spawned_by_session?: string | null; spawned_for_issue?: string | null; spawned_from?: string | null; spawned_for_pr?: string | null; initial_prompt?: string | null; summary_manual?: number },
): Promise<void> {
  await getDb().run(`
    INSERT INTO sessions (id, tmux_name, mode, repo, cwd, worktree_path, extra_worktrees, capabilities, created_at, provider, model, backend, launched_at, startup_started_at, startup_updated_at, mcp_token_sha256, launched_version, brief, spawned_by_session, spawned_for_issue, spawned_from, spawned_for_pr, initial_prompt, summary, summary_updated_at, summary_manual, claude_account)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [row.id, row.tmux_name, row.mode, row.repo, row.cwd, row.worktree_path, row.extra_worktrees, row.capabilities, row.created_at, row.provider, row.model, row.backend ?? null, row.created_at, row.created_at, row.created_at, row.mcp_token_sha256 ?? null, VERSION, row.brief ?? null, row.spawned_by_session ?? null, row.spawned_for_issue ?? null, row.spawned_from ?? null, row.spawned_for_pr ?? null, row.initial_prompt ?? null, row.summary ?? null, row.summary_updated_at ?? null, row.summary_manual ?? 0, row.claude_account ?? null]);
}

/** Record the Claude account id a session's live pod was launched with (`PersistedSession.claude_account`); null for none. */
export async function setSessionClaudeAccount(id: string, accountId: string | null): Promise<void> {
  await getDb().run(`UPDATE sessions SET claude_account = ? WHERE id = ?`, [accountId, id]);
}

/** Record the node a session's pod was scheduled on (`PersistedSession.node`). */
export async function setSessionNode(id: string, node: string): Promise<void> {
  await getDb().run(`UPDATE sessions SET node = ? WHERE id = ?`, [node, id]);
}

/** Record (a time) or clear (null) that a session's node is NotReady (`PersistedSession.node_lost_at`). */
export async function setSessionNodeLost(id: string, at: number | null): Promise<void> {
  await getDb().run(`UPDATE sessions SET node_lost_at = ? WHERE id = ?`, [at, id]);
}

/** Store the times a session was relaunched after an eviction (`PersistedSession.evicted_restarts`). */
export async function setSessionEvictedRestarts(id: string, restarts: readonly number[]): Promise<void> {
  await getDb().run(`UPDATE sessions SET evicted_restarts = ? WHERE id = ?`, [restarts.length > 0 ? JSON.stringify(restarts) : null, id]);
}

/** Point a session at the HOME PVC a move copied it to, on `node`. */
export async function setSessionHomeClaim(id: string, claim: string, node: string): Promise<void> {
  await getDb().run(`UPDATE sessions SET home_claim = ?, node = ? WHERE id = ?`, [claim, node, id]);
}

/** Record that a session's `initial_prompt` reached a ready agent. Only the first call writes, so the earliest timestamp wins; returns whether this call wrote it. */
export async function markSessionInitialPromptSent(id: string, at: number): Promise<boolean> {
  const result = await getDb().run(`UPDATE sessions SET initial_prompt_sent_at = ? WHERE id = ? AND initial_prompt_sent_at IS NULL`, [at, id]);
  return result.changes === 1;
}

/** Live (`ended_at IS NULL`) sessions that `claws_start_session` created from session `sessionId`: the fan-out cap's count. */
export async function countLiveSessionsSpawnedBy(sessionId: string): Promise<number> {
  const row = await getDb().get(`SELECT COUNT(*) AS n FROM sessions WHERE spawned_by_session = ? AND ended_at IS NULL`, [sessionId]) as { n: number | string } | undefined;
  return Number(row?.n ?? 0);
}

/** The board's "Go to session" source: issue id -> newest live (not ended) session started from a board card (`spawned_for_issue` set, `spawned_by_session` and `spawned_for_pr` NULL). */
export async function listLiveBoardStartedSessions(): Promise<Map<string, string>> {
  const rows = await getDb().all(`SELECT id, spawned_for_issue FROM sessions WHERE ended_at IS NULL AND spawned_by_session IS NULL AND spawned_for_pr IS NULL AND (spawned_from IS NULL OR spawned_from <> 'issue-page') AND spawned_for_issue IS NOT NULL ORDER BY created_at DESC`, []) as { id: string; spawned_for_issue: string }[];
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.spawned_for_issue)) out.set(r.spawned_for_issue, r.id);
  return out;
}

/** The PRs page's "Go to session" source: `owner/name#123` -> newest live (not ended) session started from a PR row (`spawned_for_pr` set, `spawned_by_session` NULL). */
export async function listLivePrStartedSessions(): Promise<Map<string, string>> {
  const rows = await getDb().all(`SELECT id, spawned_for_pr FROM sessions WHERE ended_at IS NULL AND spawned_by_session IS NULL AND spawned_for_pr IS NOT NULL ORDER BY created_at DESC`, []) as { id: string; spawned_for_pr: string }[];
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.spawned_for_pr)) out.set(r.spawned_for_pr, r.id);
  return out;
}

/** Replace a session's MCP bearer hash: each resume mints a new token (see `PersistedSession.mcp_token_sha256`). `clearEnded` also reopens the row so the new token is accepted before the agent spawns. */
export async function setSessionMcpTokenHash(id: string, sha256: string | null, clearEnded = false): Promise<void> {
  await getDb().run(`UPDATE sessions SET mcp_token_sha256 = ?${clearEnded ? `, ended_at = NULL, ${REOPEN_MEMORY_CAPTURE}` : ""} WHERE id = ?`, [sha256, id]);
}

export interface SessionStartupDbUpdate {
  state?: string | null;
  step?: string | null;
  detail?: string | null;
  startedAt?: number | null;
  updatedAt: number;
  readyAt?: number | null;
  failedAt?: number | null;
  failure?: string | null;
  clearFailure?: boolean;
  /**
   * Optimistic-concurrency guard for a writer that derived this update from a row it read
   * earlier and holds no lock on: the `startup_updated_at` it saw. The write is a no-op if
   * anything has written the row since, so a status derived from a stale pod read can never
   * land on top of — and erase the failure detail of — a newer authoritative write. Omit it
   * to write unconditionally, which is what a caller holding the session's lock does.
   */
  expectUpdatedAt?: number | null;
}

/** Whether the row was written; only ever `false` for an `expectUpdatedAt` that no longer matches. */
export async function updateSessionStartup(id: string, update: SessionStartupDbUpdate): Promise<boolean> {
  const sets = ["startup_updated_at = ?"];
  const values: unknown[] = [update.updatedAt];
  if ("state" in update) { sets.push("startup_state = ?"); values.push(update.state ?? null); }
  if ("step" in update) { sets.push("startup_step = ?"); values.push(update.step ?? null); }
  if ("detail" in update) { sets.push("startup_detail = ?"); values.push(update.detail ?? null); }
  if ("startedAt" in update) { sets.push("startup_started_at = ?"); values.push(update.startedAt ?? null); }
  if ("readyAt" in update) { sets.push("startup_ready_at = ?"); values.push(update.readyAt ?? null); }
  if ("failedAt" in update) { sets.push("startup_failed_at = ?"); values.push(update.failedAt ?? null); }
  if ("failure" in update) { sets.push("startup_failure = ?"); values.push(update.failure ?? null); }
  if (update.clearFailure) {
    if (!("failedAt" in update)) sets.push("startup_failed_at = NULL");
    if (!("failure" in update)) sets.push("startup_failure = NULL");
  }
  values.push(id);
  // `IS NULL` rather than `= ?` for the null case: no driver here compares NULL as equal.
  let where = "id = ?";
  if (update.expectUpdatedAt !== undefined) {
    if (update.expectUpdatedAt === null) where += " AND startup_updated_at IS NULL";
    else { where += " AND startup_updated_at = ?"; values.push(update.expectUpdatedAt); }
  }
  const res = await getDb().run(`UPDATE sessions SET ${sets.join(", ")} WHERE ${where}`, values);
  return res.changes > 0;
}

export interface SessionUsageDbSnapshot {
  tokensUsed: number;
  costUsd: number | null;
  lastContextTokens: number;
  usageUpdatedAt: number | null;
}

/**
 * Store session `id`'s cumulative usage. A snapshot lower than the stored one
 * (a usage reset) first folds the stored values into `usage_retired_totals`,
 * so the agent usage counters never fall.
 */
export async function updateSessionUsage(id: string, snapshot: SessionUsageDbSnapshot): Promise<void> {
  await getDb().transaction(async (tx) => {
    await retireSessionUsage(tx, `id = ? AND tokens_used > ?`, [id, snapshot.tokensUsed]);
    await tx.run(`
      UPDATE sessions
      SET tokens_used = ?, cost_usd = ?, last_context_tokens = ?, usage_updated_at = ?
      WHERE id = ?
    `, [snapshot.tokensUsed, snapshot.costUsd, snapshot.lastContextTokens, snapshot.usageUpdatedAt, id]);
  });
}

/** Distinct models previously chosen for `provider`, most-recently-used first. */
export async function getRecentSessionModels(provider: string, limit = 5): Promise<string[]> {
  return (await getDb().all(`
    SELECT model, MAX(created_at) AS last_used FROM sessions
    WHERE model IS NOT NULL AND model != '' AND COALESCE(provider, 'claude') = ?
    GROUP BY model ORDER BY last_used DESC LIMIT ?
  `, [provider, limit]) as Array<{ model: string }>).map((r) => r.model);
}

/** Key for a repo combination in `session_capability_defaults`: the repo full
 *  names de-duplicated, sorted and joined with a newline, so one repo is keyed
 *  by its own name and a multi-repo set is order-insensitive. Sorts by plain
 *  code-unit order, not `localeCompare`, so the key matches the browser-side
 *  one built in sessions-list.ts regardless of either side's locale. */
export function sessionCapabilityDefaultsKey(repos: string[]): string {
  return [...new Set(repos)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n");
}

/** Remember `capabilities` as the create-form default for this repo
 *  combination, replacing any earlier set. An empty list is stored as `[]`,
 *  distinct from no row. No-op for an empty `repos`. */
export async function rememberSessionCapabilityDefaults(repos: string[], capabilities: string[], updatedAt = Date.now()): Promise<void> {
  if (repos.length === 0) return;
  await getDb().run(`
    INSERT INTO session_capability_defaults (repo_key, capabilities, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(repo_key) DO UPDATE SET capabilities = excluded.capabilities, updated_at = excluded.updated_at
  `, [sessionCapabilityDefaultsKey(repos), JSON.stringify(capabilities), updatedAt]);
}

/** Every remembered capability set, keyed by `sessionCapabilityDefaultsKey`.
 *  Rows whose JSON is unparseable or not a string array are skipped. */
export async function getAllSessionCapabilityDefaults(): Promise<Map<string, string[]>> {
  const rows = await getDb().all(`SELECT repo_key, capabilities FROM session_capability_defaults`) as Array<{ repo_key: string; capabilities: string }>;
  const out = new Map<string, string[]>();
  for (const row of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.capabilities); } catch { continue; }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) continue;
    out.set(row.repo_key, parsed as string[]);
  }
  return out;
}

/** Remember `provider` as the operator's last-chosen agent. The model column is
 *  legacy and no longer written or read. */
export async function rememberSessionAgentDefault(provider: string, updatedAt = Date.now()): Promise<void> {
  await getDb().run(`
    INSERT INTO session_agent_defaults (provider, model, updated_at) VALUES (?, NULL, ?)
    ON CONFLICT(provider) DO UPDATE SET updated_at = excluded.updated_at
  `, [provider, updatedAt]);
}

/** The last-chosen agent (highest `updated_at`). */
export async function getSessionAgentDefaults(): Promise<{ lastProvider: string | null }> {
  const rows = await getDb().all(`SELECT provider, updated_at FROM session_agent_defaults ORDER BY updated_at DESC LIMIT 1`) as Array<{ provider: string; updated_at: number }>;
  return { lastProvider: rows[0]?.provider ?? null };
}

export async function getAllPersistedSessions(): Promise<PersistedSession[]> {
  return await getDb().all(`SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY created_at`) as PersistedSession[];
}

export async function getEndedSessions(): Promise<PersistedSession[]> {
  return await getDb().all(`SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC`) as PersistedSession[];
}

export async function getPersistedSession(id: string): Promise<PersistedSession | undefined> {
  return await getDb().get(`SELECT * FROM sessions WHERE id = ?`, [id]) as PersistedSession | undefined;
}

export async function markSessionEnded(id: string, endedAt: number, resumeRepos: string | null): Promise<void> {
  await getDb().run(`UPDATE sessions SET ended_at = ?, resume_repos = ?, startup_state = COALESCE(startup_state, 'ended'), startup_updated_at = ?, node_lost_at = NULL WHERE id = ?`, [endedAt, resumeRepos, endedAt, id]);
}

/** Record the exit code and final output of a session whose process ended (#3311). Does not end the row. */
export async function recordSessionExit(id: string, exitCode: number | null, lastOutput: string | null): Promise<void> {
  await getDb().run(`UPDATE sessions SET exit_code = ?, last_output = ? WHERE id = ?`, [exitCode, lastOutput, id]);
}

/** Reopen an ended session; `launchedAt` also records a pod relaunch and stamps the running `VERSION` as `launched_version` (see `PersistedSession.launched_at`). Adopting a still-running pod leaves the version alone — use `setSessionLaunchedVersion` where a fresh agent starts. */
export async function clearSessionEnded(id: string, launchedAt?: number): Promise<void> {
  if (launchedAt === undefined) {
    await getDb().run(`UPDATE sessions SET ended_at = NULL, agent_status = NULL, agent_status_updated_at = NULL, exit_code = NULL, last_output = NULL, node_lost_at = NULL, ${REOPEN_MEMORY_CAPTURE} WHERE id = ?`, [id]);
    return;
  }
  await getDb().run(`
    UPDATE sessions
    SET ended_at = NULL, agent_status = NULL, agent_status_updated_at = NULL, exit_code = NULL, last_output = NULL, node_lost_at = NULL, ${REOPEN_MEMORY_CAPTURE}, launched_at = ?,
        startup_started_at = ?, startup_updated_at = ?, startup_ready_at = NULL, startup_failed_at = NULL, startup_failure = NULL,
        launched_version = ?
    WHERE id = ?
  `, [launchedAt, launchedAt, launchedAt, VERSION, id]);
}

/** Stamp the running `VERSION` as the session's `launched_version`, for a resume that starts a fresh agent process. */
export async function setSessionLaunchedVersion(id: string): Promise<void> {
  await getDb().run(`UPDATE sessions SET launched_version = ? WHERE id = ?`, [VERSION, id]);
}

/**
 * Ids of `backend`'s ended sessions past its newest `keep`, without deleting them.
 * Each backend prunes only its own rows, so the other's cleanup (upload/MCP dirs,
 * session PVCs) is never skipped.
 */
export async function getPrunableEndedSessionIds(keep: number, backend: "local-tmux" | "k8s-pod"): Promise<string[]> {
  const backendFilter = backend === "k8s-pod" ? "backend = 'k8s-pod'" : "(backend IS NULL OR backend = 'local-tmux')";
  // SQLite: LIMIT -1 OFFSET keep = "all rows past the first `keep`"
  const rows = await getDb().all(`
    SELECT id
    FROM sessions
    WHERE ended_at IS NOT NULL AND ${backendFilter}
    ORDER BY ended_at DESC, id DESC
    LIMIT -1 OFFSET ?
  `, [keep]) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export async function pruneEndedSessions(keep: number, backend: "local-tmux" | "k8s-pod"): Promise<string[]> {
  return timedDb("prune-ended-sessions", () => pruneEndedSessionsUntimed(keep, backend));
}

async function pruneEndedSessionsUntimed(keep: number, backend: "local-tmux" | "k8s-pod"): Promise<string[]> {
  const ids = await getPrunableEndedSessionIds(keep, backend);
  if (ids.length === 0) return [];
  const deleteChunkSize = 900;
  await getDb().transaction(async (tx) => {
    for (let i = 0; i < ids.length; i += deleteChunkSize) {
      const chunk = ids.slice(i, i + deleteChunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      await retireSessionUsage(tx, `id IN (${placeholders})`, [...chunk]);
      await tx.run(`DELETE FROM sessions WHERE id IN (${placeholders})`, [...chunk]);
    }
  });
  return ids;
}

export async function deletePersistedSession(id: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await retireSessionUsage(tx, `id = ?`, [id]);
    await tx.run(`DELETE FROM sessions WHERE id = ?`, [id]);
  });
}

/** Delete a session row only while it is still ended; false when it was reopened (or is gone). */
export async function deleteEndedPersistedSession(id: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    await retireSessionUsage(tx, `id = ? AND ended_at IS NOT NULL`, [id]);
    const result = await tx.run(`DELETE FROM sessions WHERE id = ? AND ended_at IS NOT NULL`, [id]);
    return result.changes > 0;
  });
}

// ── Session memory captures (claude-memory-backup) ──

/** SET clause every reopen of a session row applies, so its next end captures its memories again. */
const REOPEN_MEMORY_CAPTURE = "memories_captured_at = NULL, memory_capture_attempts = 0";

/** project-slug → (filename → content), as read off a session's `~/.claude/projects`. */
export type SessionMemoryFiles = Record<string, Record<string, string>>;

export interface SessionMemoryCapture {
  session_id: string;
  captured_at: number;
  files: SessionMemoryFiles;
}

function endedAtMatch(endedAt: number | null): { sql: string; params: number[] } {
  return endedAt === null ? { sql: "ended_at IS NULL", params: [] } : { sql: "ended_at = ?", params: [endedAt] };
}

/**
 * Store the memory files just read off session `id`'s PVC, replacing any earlier
 * capture and clearing its `pushed_at` so claude-memory-backup pushes it again,
 * and stamp the row captured. Only while the row still has `endedAt` (NULL for an
 * open row being deleted): a capture that raced a resume is discarded, and
 * false is returned. A row already deleted is not stamped but its files are kept.
 */
export async function recordSessionMemoryCapture(id: string, endedAt: number | null, files: SessionMemoryFiles, capturedAt: number): Promise<boolean> {
  const match = endedAtMatch(endedAt);
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(`SELECT id FROM sessions WHERE id = ? AND ${match.sql}`, [id, ...match.params]) as { id: string } | undefined;
    if (!row) return false;
    await tx.run(`
      INSERT INTO session_memory_captures (session_id, captured_at, files_json, pushed_at) VALUES (?, ?, ?, NULL)
      ON CONFLICT(session_id) DO UPDATE SET captured_at = excluded.captured_at, files_json = excluded.files_json, pushed_at = NULL
    `, [id, capturedAt, JSON.stringify(files)]);
    await tx.run(`UPDATE sessions SET memories_captured_at = ? WHERE id = ?`, [capturedAt, id]);
    return true;
  });
}

/** Count one failed capture attempt for session `id`, while it still has `endedAt`. */
export async function noteSessionMemoryCaptureFailed(id: string, endedAt: number | null): Promise<void> {
  const match = endedAtMatch(endedAt);
  await getDb().run(`UPDATE sessions SET memory_capture_attempts = COALESCE(memory_capture_attempts, 0) + 1 WHERE id = ? AND ${match.sql}`, [id, ...match.params]);
}

/** Ended `k8s-pod` sessions not yet captured and with fewer than `maxAttempts` failed attempts, most recently ended first. */
export async function getSessionsNeedingMemoryCapture(maxAttempts: number, limit: number): Promise<PersistedSession[]> {
  return await getDb().all(`
    SELECT * FROM sessions
    WHERE backend = 'k8s-pod' AND ended_at IS NOT NULL AND memories_captured_at IS NULL
      AND COALESCE(memory_capture_attempts, 0) < ?
    ORDER BY ended_at DESC, id DESC
    LIMIT ?
  `, [maxAttempts, limit]) as PersistedSession[];
}

/** Captures whose current files claude-memory-backup has not pushed yet, oldest first. */
export async function listUnpushedSessionMemoryCaptures(): Promise<SessionMemoryCapture[]> {
  const rows = await getDb().all(`
    SELECT session_id, captured_at, files_json FROM session_memory_captures WHERE pushed_at IS NULL ORDER BY captured_at, session_id
  `) as Array<{ session_id: string; captured_at: number; files_json: string }>;
  const out: SessionMemoryCapture[] = [];
  for (const row of rows) {
    let files: SessionMemoryFiles = {};
    try {
      const parsed = JSON.parse(row.files_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) files = parsed as SessionMemoryFiles;
    } catch {
      // A corrupt row pushes as empty: the session's directories are cleared rather than left stale.
    }
    out.push({ session_id: row.session_id, captured_at: Number(row.captured_at), files });
  }
  return out;
}

/** Mark a capture pushed, unless a newer capture of that session replaced it since it was listed. */
export async function markSessionMemoryCapturePushed(sessionId: string, capturedAt: number, pushedAt: number): Promise<void> {
  await getDb().run(`UPDATE session_memory_captures SET pushed_at = ? WHERE session_id = ? AND captured_at = ?`, [pushedAt, sessionId, capturedAt]);
}

export async function updateSessionSummary(id: string, summary: string, updatedAt: number): Promise<void> {
  await getDb().run(`UPDATE sessions SET summary = ?, summary_updated_at = ? WHERE id = ? AND summary_manual = 0`, [summary, updatedAt, id]);
}

/** Set (or clear, with `summary === null`) a user-authored session description. Returns true if a row was updated. */
export async function setManualSessionSummary(id: string, summary: string | null, updatedAt: number | null): Promise<boolean> {
  const info = await getDb().run(`UPDATE sessions SET summary = ?, summary_updated_at = ?, summary_manual = ? WHERE id = ?`, [summary, updatedAt, summary === null ? 0 : 1, id]);
  return info.changes > 0;
}

/** Replace a session row's granted capability ids (#3072 runtime grant). */
export async function updateSessionCapabilities(id: string, caps: string[]): Promise<void> {
  await getDb().run(`UPDATE sessions SET capabilities = ? WHERE id = ?`, [JSON.stringify(caps), id]);
}

/** Record a live session's self-reported agent status. Returns false when the row is missing or already ended. */
export async function setSessionAgentStatus(id: string, status: string, updatedAt: number): Promise<boolean> {
  const info = await getDb().run(`UPDATE sessions SET agent_status = ?, agent_status_updated_at = ? WHERE id = ? AND ended_at IS NULL`, [status, updatedAt, id]);
  return info.changes > 0;
}
