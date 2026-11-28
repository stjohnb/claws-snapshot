// The smart scheduling ledger and the durable work queue (`work_queue`).
// Reached only through the src/db.ts façade.
import * as diagnosticQueries from "../diagnostic-queries.js";
import { normalizeItemNumbers, type IssueRef } from "../issue-id.js";
import { planningKindsSql, stageRankSql, type WorkLane } from "../work-order.js";
import { DAY_MS, getDb, nowSql, nowSqlOffsetMs, refParam, timedDb } from "./core.js";

// ── Smart scheduling ledger ──

export async function markRepoProcessedDaily(jobName: string, repo: string, localDate: string): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO processed_repos_daily (job_name, repo, local_date) VALUES (?, ?, ?)`, [jobName, repo, localDate]);
}

/**
 * Atomically records that we Slack-notified about an untrusted-actor dispatch
 * skip for this issue. Returns true if this is the FIRST time (row inserted) —
 * the caller should send the Slack message. Returns false if a row already
 * existed — the caller should stay silent. Durable across process restarts,
 * unlike an in-memory Set, so a still-ignored issue is notified at most once ever.
 */
export async function markUntrustedActorNotified(repo: string, issueNumber: IssueRef): Promise<boolean> {
  const result = await getDb().run(`INSERT OR IGNORE INTO notified_untrusted_actors (repo, issue_number) VALUES (?, ?)`, [repo, refParam(issueNumber)]);
  return result.changes === 1;
}

/** Returns a map of repo → most-recent `processed_at` (epoch ms) for the given job.
 *  SQLite stores `datetime('now')` as `"YYYY-MM-DD HH:MM:SS"` in UTC; we convert to
 *  epoch ms by appending `T` + `Z` so JS Date.parse treats it as UTC. */
export async function getLastProcessedTimestampsForJob(jobName: string): Promise<Map<string, number>> {
  const rows = await getDb().all(`SELECT repo, MAX(processed_at) AS ts FROM processed_repos_daily WHERE job_name = ? GROUP BY repo`, [jobName]) as { repo: string; ts: string }[];
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.ts) continue;
    const epochMs = Date.parse(r.ts.replace(" ", "T") + "Z");
    if (!Number.isNaN(epochMs)) map.set(r.repo, epochMs);
  }
  return map;
}

export async function pruneProcessedReposDailyOlderThan(daysToKeep: number): Promise<number> {
  return timedDb("prune-processed-repos-daily-older-than", () => pruneProcessedReposDailyOlderThanUntimed(daysToKeep));
}

async function pruneProcessedReposDailyOlderThanUntimed(daysToKeep: number): Promise<number> {
  const result = await getDb().run(`DELETE FROM processed_repos_daily WHERE local_date < ?`, [nowSqlOffsetMs(-daysToKeep * DAY_MS).slice(0, 10)]);
  return result.changes;
}

// ── Work queue (durable agent dispatch) ──
//
// A queued row is a candidate, not a decision: workers claim by `priority`,
// then pipeline stage (`stageRankSql`, merge-nearest first), then age, and
// re-validate the winner against the forge before an agent spawns.

export interface WorkQueueRow {
  id: number;
  kind: string;
  repo: string;
  item_number: IssueRef;
  args_json: string;
  /** 0/1 Priority-label flag. Refreshed by `enqueueWork` each time a
   *  dispatcher re-discovers a still-queued item, and by the worker's
   *  pre-spawn re-validation, so it tracks the live label. */
  priority: number;
  status: string;
  pid: number | null;
  attempts: number;
  error_message: string | null;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  run_id: string | null;
  /** Agent pod running this row (`claws-agent-<id>`), set once the pod has been created; NULL for in-process runs. */
  agent_pod: string | null;
  /** Size class of `agent_pod` (`default` or `large`), resolved at launch; NULL for in-process runs and pods launched before it existed (read as `default`). */
  agent_pod_class?: string | null;
  /** SHA-256 (hex) of the agent pod's claws-state bearer token; NULL for in-process runs. */
  agent_mcp_token_sha256: string | null;
}

export interface EnqueueResult {
  id: number;
  alreadyQueued: boolean;
  /** True when an already-queued row's `priority` was changed to the caller's flag. */
  priorityChanged?: boolean;
}

export async function enqueueWork(
  kind: string,
  repo: string,
  itemNumber: IssueRef,
  opts: { priority?: boolean; args?: Record<string, unknown> } = {},
): Promise<EnqueueResult | null> {
  const priority = opts.priority ? 1 : 0;
  const argsJson = JSON.stringify(opts.args ?? {});
  const result = await getDb().insert(`
      INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, enqueued_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?)
      ON CONFLICT(kind, repo, item_number) WHERE status IN ('queued', 'running') DO NOTHING
    `, [kind, repo, refParam(itemNumber), argsJson, priority, nowSql()]);
  if (result.changes === 1) {
    return { id: result.id, alreadyQueued: false };
  }
  // No insert — the row already exists in queued/running state. Refresh a
  // queued row's priority to the caller's current flag so a Priority label
  // added after enqueue changes the claim order; running rows are untouched.
  // A repo-scoped row (item 0, e.g. auto-merger:sweep) is shared by every PR
  // in the repo, so it may only be raised here, never lowered — otherwise a
  // later non-Priority caller would bump a Priority PR's pending sweep behind
  // other Priority rows.
  const refreshed = itemNumber === 0
    ? await getDb().run(`UPDATE work_queue SET priority = ? WHERE kind = ? AND repo = ? AND item_number = ? AND status = 'queued' AND priority < ?`, [priority, kind, repo, refParam(itemNumber), priority])
    : await getDb().run(`UPDATE work_queue SET priority = ? WHERE kind = ? AND repo = ? AND item_number = ? AND status = 'queued' AND priority <> ?`, [priority, kind, repo, refParam(itemNumber), priority]);
  const existing = await getDb().get(`SELECT id FROM work_queue WHERE kind = ? AND repo = ? AND item_number = ? AND status IN ('queued', 'running') LIMIT 1`, [kind, repo, refParam(itemNumber)]) as { id: number } | undefined;
  return existing ? { id: existing.id, alreadyQueued: true, priorityChanged: refreshed.changes > 0 } : null;
}

export async function claimNextWork(
  runId: string | null,
  opts?: { priorityOnly?: boolean; planningOnly?: boolean; kinds?: readonly string[] },
): Promise<WorkQueueRow | null> {
  // `kinds` restricts the claim (an off-node-only fiber takes only kinds that
  // may leave the session node); an empty list claims nothing.
  if (opts?.kinds && opts.kinds.length === 0) return null;
  const d = getDb();
  const kindParams = opts?.kinds ? [...opts.kinds] : [];
  // The express worker fiber claims only priority rows (Priority or an
  // incident label), so an alert never waits for a busy regular worker. The
  // planning-lane fiber claims only planning and requirements kinds, so a
  // plan waits only behind other planning work.
  const priorityFilter = (opts?.priorityOnly ? " AND priority = 1" : "") +
    (opts?.planningOnly ? ` AND ${planningKindsSql()}` : "") +
    (kindParams.length > 0 ? ` AND kind IN (${kindParams.map(() => "?").join(", ")})` : "");
  if (d.dialect === "postgres") {
    // One statement, no explicit transaction: SKIP LOCKED lets concurrent
    // claimers step over each other's rows instead of serialising on the head
    // of the queue.
    const rows = await d.all<WorkQueueRow>(`
      UPDATE work_queue
      SET status = 'running',
          pid = ?,
          started_at = ?,
          attempts = attempts + 1,
          run_id = ?
      WHERE id = (SELECT id FROM work_queue WHERE status = 'queued'${priorityFilter}
                  ORDER BY priority DESC, ${stageRankSql()} ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *
    `, [process.pid, nowSql(), runId, ...kindParams]);
    return rows[0] ? normalizeItemNumbers(rows)[0]! : null;
  }
  return await d.transaction(async (tx) => {
    const row = await tx.get<WorkQueueRow>(`
      SELECT * FROM work_queue
      WHERE status = 'queued'${priorityFilter}
      ORDER BY priority DESC, ${stageRankSql()} ASC, id ASC
      LIMIT 1
    `, kindParams);
    if (!row) return null;
    await tx.run(`
      UPDATE work_queue
      SET status = 'running',
          pid = ?,
          started_at = ?,
          attempts = attempts + 1,
          run_id = ?
      WHERE id = ?
    `, [process.pid, nowSql(), runId, row.id]);
    const claimed = await tx.get<WorkQueueRow>(`SELECT * FROM work_queue WHERE id = ?`, [row.id]);
    return claimed ? normalizeItemNumbers([claimed])[0]! : null;
  });
}

export async function getWorkRow(id: number): Promise<WorkQueueRow | undefined> {
  const row = await getDb().get<WorkQueueRow>(`SELECT * FROM work_queue WHERE id = ?`, [id]);
  return row ? normalizeItemNumbers([row])[0] : undefined;
}

/**
 * Record the SHA-256 of the MCP token in a claimed row's agent pod Secret.
 * Written before the Secret exists, so the pod's token is accepted from its
 * first request.
 */
export async function setWorkAgentMcpToken(id: number, mcpTokenSha256: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET agent_mcp_token_sha256 = ? WHERE id = ?`, [mcpTokenSha256, id]);
}

/**
 * Record the agent pod a claimed row runs in. Written only once the Pod was
 * created, so every pod-backed row had a pod: a boot that crashed before that
 * leaves `agent_pod` NULL and recoverWorkOnStartup() re-queues the row.
 */
export async function setWorkAgentPod(id: number, podName: string, podClass: string = "default"): Promise<void> {
  await getDb().run(`UPDATE work_queue SET agent_pod = ?, agent_pod_class = ? WHERE id = ?`, [podName, podClass, id]);
}

/**
 * Whether `mcpTokenSha256` is the MCP token hash of a running pod-backed row.
 * The service's per-boot INTERNAL_MCP_TOKEN cannot authenticate a pod that
 * outlives the boot, so the API accepts these too, until the row ends.
 */
export async function isRunningAgentPodMcpToken(mcpTokenSha256: string): Promise<boolean> {
  const row = await getDb().get<{ id: number }>(
    `SELECT id FROM work_queue WHERE status = 'running' AND agent_mcp_token_sha256 = ?`,
    [mcpTokenSha256],
  );
  return row !== undefined;
}

/** Running rows owned by an agent pod; the launcher adopts them at boot. */
export async function listPodBackedRunningWork(): Promise<WorkQueueRow[]> {
  return normalizeItemNumbers(await getDb().all(
    `SELECT * FROM work_queue WHERE status = 'running' AND agent_pod IS NOT NULL ORDER BY id ASC`,
  ) as WorkQueueRow[]);
}

/**
 * Put a row claimed under `runId` back in the queue before anything ran it;
 * false when it is no longer running under that run. Clears `agent_pod`; a
 * `note` is stored as the row's `error_message` (otherwise it is left as is).
 */
export async function releaseClaimedWork(id: number, runId: string, note?: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'queued', pid = NULL, started_at = NULL, run_id = NULL, agent_mcp_token_sha256 = NULL, agent_pod = NULL, agent_pod_class = NULL${note === undefined ? "" : ", error_message = ?"}
     WHERE id = ? AND status = 'running' AND run_id = ?`,
    note === undefined ? [id, runId] : [note, id, runId],
  );
  return Number(result.changes) > 0;
}

/**
 * Put a 'running' row this process just claimed straight back onto the queue,
 * without charging a failed attempt. Unlike `releaseClaimedWork`, this does
 * not match on `run_id`: the in-process (non-pod) backend never records one
 * on the rows it claims, but a fiber that just claimed a row is its only
 * owner while it stays 'running', so matching on id and status is enough.
 */
export async function releaseClaimedWorkById(id: number): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'queued', pid = NULL, started_at = NULL, run_id = NULL, agent_mcp_token_sha256 = NULL
     WHERE id = ? AND status = 'running'`,
    [id],
  );
  return Number(result.changes) > 0;
}

/** `note` is kept as the row's queue note (e.g. a re-validation failure the run proceeded past). */
export async function markWorkSucceeded(id: number, note?: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), note?.slice(0, 4000) ?? null, id]);
}

export async function markWorkFailed(id: number, errorMessage: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), errorMessage.slice(0, 4000), id]);
}

/** `markWorkSucceeded` only while the row is still `running` under `runId`; false when it had already ended. */
export async function markWorkSucceededIfRunning(id: number, runId: string, note?: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [nowSql(), note?.slice(0, 4000) ?? null, id, runId],
  );
  return Number(result.changes) > 0;
}

/** `markWorkFailed` only while the row is still `running` under `runId`; false when it had already ended. */
export async function markWorkFailedIfRunning(id: number, runId: string, errorMessage: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [nowSql(), errorMessage.slice(0, 4000), id, runId],
  );
  return Number(result.changes) > 0;
}

/** Record the pre-spawn re-validation's result on the row's claim
 *  (display only — the row is already running). */
export async function setWorkPriority(id: number, priority: boolean): Promise<void> {
  await getDb().run(`UPDATE work_queue SET priority = ? WHERE id = ?`, [priority ? 1 : 0, id]);
}

/** `setWorkPriority` only while the row is still `running` under `runId`; false when it had already ended. */
export async function setWorkPriorityIfRunning(id: number, runId: string, priority: boolean): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET priority = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [priority ? 1 : 0, id, runId],
  );
  return Number(result.changes) > 0;
}

/** Terminal state for a claimed row the worker dropped without spawning an
 *  agent because the item is no longer actionable (merged, closed, parked).
 *  `completed`, not `cancelled` (operator cancels) or `failed` (errors), with
 *  the reason as `skipped: <reason>`. Frees `idx_work_queue_active`. */
export async function markWorkSkipped(id: number, reason: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), `skipped: ${reason}`.slice(0, 4000), id]);
}

/**
 * Skip every still-`queued` row for one item whose kind starts with
 * `kindPrefix` (e.g. `issue-refiner:`), returning how many it skipped. A
 * `running` row is left alone: it has already started and finishes on its own.
 * Demoting an issue back to Ideas uses it to drop a queued planner run.
 */
export async function skipQueuedWorkForItem(kindPrefix: string, repo: string, itemNumber: IssueRef, reason: string): Promise<number> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ?
      WHERE repo = ? AND item_number = ? AND status = 'queued' AND substr(kind, 1, ?) = ?`,
    [nowSql(), `skipped: ${reason}`.slice(0, 4000), repo, refParam(itemNumber), kindPrefix.length, kindPrefix],
  );
  return Number(result.changes);
}

/** `markWorkSkipped` only while the row is still `running` under `runId`; false when it had already ended. */
export async function markWorkSkippedIfRunning(id: number, runId: string, reason: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [nowSql(), `skipped: ${reason}`.slice(0, 4000), id, runId],
  );
  return Number(result.changes) > 0;
}

/** Terminal 'cancelled' state for a work row whose run was cancelled by an
 *  operator (POST /cancel or POST /logs/:runId/cancel) while the service kept
 *  running. Must not be left 'running': recoverWorkOnStartup() only resets
 *  'running' rows at the next restart, and reapStaleRunningWork() only reaps
 *  them after STALE_RUNNING_WORK_MS, so a row left running by a no-restart
 *  cancellation would otherwise block re-enqueue via idx_work_queue_active
 *  for up to that long (#2685, #3144). */
export async function markWorkCancelled(id: number, reason: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'cancelled', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), reason.slice(0, 4000), id]);
}

/** `markWorkCancelled` only while the row is still `running` under `runId`; false when it had already ended. */
export async function markWorkCancelledIfRunning(id: number, runId: string, reason: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'cancelled', completed_at = ?, error_message = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [nowSql(), reason.slice(0, 4000), id, runId],
  );
  return Number(result.changes) > 0;
}

export async function listQueuedWork(limit = 200): Promise<WorkQueueRow[]> {
  return normalizeItemNumbers(await getDb().all(`
      SELECT * FROM work_queue
      WHERE status IN ('queued', 'running')
      ORDER BY status DESC, priority DESC, ${stageRankSql()} ASC, id ASC
      LIMIT ?
    `, [limit]) as WorkQueueRow[]);
}

export type McpWorkQueueRow = Pick<WorkQueueRow,
  "id" | "kind" | "repo" | "item_number" | "priority" | "status" | "pid" |
  "attempts" | "error_message" | "enqueued_at" | "started_at" | "completed_at" | "run_id"
> & {
  /** Agent pod size class (`default` or `large`) the row's pod was launched in; null for in-process runs and older pods. */
  agent_pod_class: string | null;
  /** Pipeline stage rank from `work-order.ts`; lower is nearer to merge. */
  stage: number;
  /** Worker lane that claims the row: `planning`, `express` (priority) or `regular`. */
  lane: WorkLane;
};

export async function getMcpWorkQueue(limit = 100, statuses: readonly string[] = ["queued", "running"]): Promise<McpWorkQueueRow[]> {
  return await diagnosticQueries.getMcpWorkQueue(getDb(), limit, statuses);
}

export interface McpRepoProcessingState {
  job_name: string;
  repo: string;
  local_date: string;
  processed_at: string;
}

export async function getMcpRepoProcessingState(opts: { jobName?: string; repo?: string; limit?: number } = {}): Promise<McpRepoProcessingState[]> {
  return diagnosticQueries.getMcpRepoProcessingState(getDb(), opts);
}

export async function countWorkByStatus(): Promise<Record<string, number>> {
  const rows = await getDb().all(`SELECT status, COUNT(*) as cnt FROM work_queue GROUP BY status`) as Array<{ status: string; cnt: number }>;
  const result: Record<string, number> = {};
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

/** Count running+queued work_queue rows whose `kind` is NOT in the excluded set.
 *  Used by smart-schedule to ignore long-running PR work when deciding whether
 *  the system is "busy". */
export async function countActiveWorkExcludingKinds(excludedKinds: string[]): Promise<number> {
  if (excludedKinds.length === 0) {
    const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM work_queue WHERE status IN ('queued', 'running')`) as { cnt: number };
    return row.cnt;
  }
  const placeholders = excludedKinds.map(() => "?").join(",");
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM work_queue WHERE status IN ('queued', 'running') AND kind NOT IN (${placeholders})`, [...excludedKinds]) as { cnt: number };
  return row.cnt;
}

/**
 * #3144: inside the production container tini is PID 1 and the Node process is
 * always PID 7, so `pid` is not a liveness signal in this pod's PID namespace —
 * a stale row's `pid` is indistinguishable from the live process's own. A reset-all
 * is safe here because there is exactly one live writer per database.
 */
export async function recoverWorkOnStartup(): Promise<{ resetRunning: number }> {
  // Pod-backed rows outlive the service; the agent pod launcher adopts them.
  const result = await getDb().run(`
      UPDATE work_queue
      SET status = 'queued', pid = NULL, started_at = NULL, agent_mcp_token_sha256 = NULL
      WHERE status = 'running' AND agent_pod IS NULL
    `);
  return { resetRunning: Number(result.changes) };
}

/**
 * Staleness floor for reapStaleRunningWork()'s no-restart sweep — it matches
 * CLAUDE_TIMEOUT_MS / CLAUDE_LIVENESS_TIMEOUT_MS in src/config.ts, since no work
 * row should outlive its own agent's ceiling.
 */
export const STALE_RUNNING_WORK_MS = 6 * 60 * 60 * 1000;

/**
 * Between-restart self-heal for #3144: reset 'running' rows old enough that no
 * worker could still legitimately be executing them and that aren't in the
 * caller's live in-flight set. Unlike recoverWorkOnStartup(), this runs while
 * the service stays up, so it must not touch a row a fiber is actually running.
 * Pod-backed rows are skipped: the agent pod launcher enforces their ceiling.
 */
export async function reapStaleRunningWork(activeIds: readonly number[], maxAgeMs = STALE_RUNNING_WORK_MS): Promise<number> {
  const cutoff = nowSqlOffsetMs(-maxAgeMs);
  if (activeIds.length === 0) {
    const result = await getDb().run(`
        UPDATE work_queue
        SET status = 'queued', pid = NULL, started_at = NULL, agent_mcp_token_sha256 = NULL
        WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?
          AND agent_pod IS NULL
      `, [cutoff]);
    return Number(result.changes);
  }
  const placeholders = activeIds.map(() => "?").join(",");
  const result = await getDb().run(`
      UPDATE work_queue
      SET status = 'queued', pid = NULL, started_at = NULL, agent_mcp_token_sha256 = NULL
      WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?
        AND agent_pod IS NULL
        AND id NOT IN (${placeholders})
    `, [cutoff, ...activeIds]);
  return Number(result.changes);
}

export async function pruneWorkQueue(retentionHours = 168): Promise<number> {
  return timedDb("prune-work-queue", () => pruneWorkQueueUntimed(retentionHours));
}

async function pruneWorkQueueUntimed(retentionHours = 168): Promise<number> {
  const result = await getDb().run(`
      DELETE FROM work_queue
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND completed_at < ?
    `, [nowSqlOffsetMs(-retentionHours * 60 * 60 * 1000)]);
  return Number(result.changes);
}

/** Active = currently running. Used by auto-merger sweep to skip PRs being modified. */
export async function hasActiveWorkForPR(repo: string, prNumber: number, kinds: string[]): Promise<boolean> {
  if (kinds.length === 0) return false;
  const placeholders = kinds.map(() => "?").join(",");
  const row = await getDb().get(`
      SELECT 1 FROM work_queue
      WHERE status = 'running'
        AND repo = ?
        AND item_number = ?
        AND kind IN (${placeholders})
      LIMIT 1
    `, [repo, refParam(prNumber), ...kinds]);
  return row !== undefined;
}

/**
 * The queued or running `work_queue` rows of `kinds`, keyed `repo#number` to
 * the row's kind, a running row winning over a queued one. One read for every
 * PR a dashboard page renders (`infraApprovalWait`).
 */
export async function listActivePrWork(kinds: readonly string[]): Promise<Map<string, string>> {
  return timedDb("list-active-pr-work", () => listActivePrWorkUntimed(kinds));
}

async function listActivePrWorkUntimed(kinds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (kinds.length === 0) return out;
  const placeholders = kinds.map(() => "?").join(",");
  const rows = await getDb().all<{ repo: string; item_number: string | number; kind: string; status: string }>(`
      SELECT repo, item_number, kind, status FROM work_queue
      WHERE status IN ('queued', 'running')
        AND kind IN (${placeholders})
    `, [...kinds]);
  const running = new Set<string>();
  for (const r of rows) {
    const key = `${r.repo}#${r.item_number}`;
    if (r.status === "running") {
      if (!running.has(key)) out.set(key, r.kind);
      running.add(key);
    } else if (!running.has(key) && !out.has(key)) {
      out.set(key, r.kind);
    }
  }
  return out;
}

/** @internal — for tests only */
export async function clearAllWorkQueueForTests(): Promise<void> {
  await getDb().run(`DELETE FROM work_queue`);
}

