// Task recording: the `tasks` rows each agent run writes, token usage,
// effectiveness events, and the running-task and MCP history readers.
// Reached only through the src/db.ts façade.
import * as diagnosticQueries from "../diagnostic-queries.js";
import * as log from "../log.js";
import * as logCore from "../log-core.js";
import { buildFailureOutcome } from "../outcome.js";
import { recordGitHubEvent } from "../github-events.js";
import { currentRunId } from "../issue-history-actor.js";
import { normalizeItemNumbers, type IssueRef } from "../issue-id.js";
import { getDb, nowSql, refParam } from "./core.js";
import { flushJobLogs } from "./job-logs.js";
import { bumpAgentEventTotal, jobPrefix, retireTaskUsage } from "./usage.js";

export interface TaskOutcome {
  commits?: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  prNumber?: number;
  /** The repo `prNumber` is in, when it is not the task's own `repo` — a
   *  multi-repo issue's step whose PR is in another of the issue's repos. */
  prRepo?: string;
  prAction?: "created" | "updated" | "reviewed" | "skipped";
  headSha?: string;
  reviewResult?: "clean" | "advisory" | "blocking" | "escalated" | "empty-diff";
  /** The pr-reviewer round number this outcome completed; read back by
   *  `backfillPRReviews()` so a task-outcome-only backfilled row (no matching
   *  effectiveness event) doesn't restart iteration counting at 1. */
  reviewIteration?: number;
  failureCategory?: string;
  /** Effective agent memory cap, in bytes, that an `AgentMemoryLimitError` breached.
   *  Lets `countRecentMemoryLimits()` count same-cap strikes structurally instead of
   *  parsing the rendered error message. */
  memoryLimitBytes?: number;
  /** How a `memory-limit` failure was measured: `pss` for the shared-container
   *  watchdog (summed proportional set size), `kubernetes-oom` for an agent pod
   *  Kubernetes OOM-killed at its memory limit. */
  memoryMeasurement?: "pss" | "kubernetes-oom";
  /** Reason a CI-fixer agent gave (its `CI-FIX-GIVE-UP:` line) for not fixing the
   *  failure; a run carrying one counts towards the fix-attempt cap. */
  giveUpReason?: string;
  /** Why a pre-spawn re-validation skipped the row (`merged`, `closed`, `parked`, ...). */
  skipReason?: string;
}

export interface Task {
  id: number;
  job_name: string;
  repo: string;
  item_number: IssueRef;
  trigger_label: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  run_id: string | null;
  status: string;
  error: string | null;
  outcome: string | null;
  model_used: string | null;
  provider_used: string | null;
  tokens_used: number | null;
  cost_usd: number | null;
  started_at: string;
  completed_at: string | null;
}

export interface TaskEffectivenessEventInput {
  taskId: number;
  source: string;
  sourceRepo: string;
  sourceNumber: number;
  sourceSha: string;
  signal: string;
  score: number | null;
  details?: unknown;
}

export interface RecentEffectivenessEvent {
  taskId: number;
  jobName: string;
  repo: string;
  itemNumber: IssueRef;
  provider: string;
  model: string;
  signal: string;
  score: number | null;
  source: string;
  sourceRepo: string;
  sourceNumber: number;
  sourceSha: string;
  details: string | null;
  createdAt: string;
}

let runIdProvider: (() => string | undefined) | null = null;

export function setRunIdProvider(provider: () => string | undefined): void {
  runIdProvider = provider;
}

/** Stamp every task started in this process with the current run context's run id. Each role calls this at boot. */
export function stampTasksWithRunContext(): void {
  setRunIdProvider(() => logCore.runContext.getStore()?.runId);
}

export async function recordTaskStart(
  jobName: string,
  repo: string,
  itemNumber: IssueRef,
  triggerLabel: string | null,
): Promise<number> {
  const currentRunId = runIdProvider?.() ?? null;
  const result = await getDb().insert(
    `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    [jobName, repo, refParam(itemNumber), triggerLabel, currentRunId, nowSql()],
  );
  recordGitHubEvent({ kind: "task-started", repo, number: itemNumber, related: [], detail: jobName });
  return result.id;
}

export async function updateTaskWorktree(
  taskId: number,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await getDb().run(`UPDATE tasks SET worktree_path = ?, branch_name = ? WHERE id = ?`, [worktreePath, branchName, taskId]);
}

export async function updateTaskModel(taskId: number, model: string): Promise<void> {
  await getDb().run(`UPDATE tasks SET model_used = ? WHERE id = ?`, [model, taskId]);
}

/**
 * Record the provider serving task `taskId`, and the Claude account it ran on
 * (`account_used`; cleared when the provider ran on no Claude account).
 */
export async function updateTaskProvider(taskId: number, provider: string, account?: string): Promise<void> {
  await getDb().run(`UPDATE tasks SET provider_used = ?, account_used = ? WHERE id = ?`, [provider, account ?? null, taskId]);
}

/** The `run_id` task `taskId` was recorded under, or null when it has none or does not exist. */
export async function getTaskRunId(taskId: number): Promise<string | null> {
  const row = await getDb().get<{ run_id: string | null }>(`SELECT run_id FROM tasks WHERE id = ?`, [taskId]);
  return row?.run_id ?? null;
}

/**
 * Store task `taskId`'s cumulative usage. A snapshot lower than the stored one
 * (a usage reset) first folds the stored values into `usage_retired_totals`,
 * so the agent usage counters never fall.
 */
export async function updateTaskTokenUsage(taskId: number, tokensUsed: number, costUsd: number): Promise<void> {
  await getDb().transaction(async (tx) => {
    await retireTaskUsage(tx, `id = ? AND tokens_used > ?`, [taskId, tokensUsed], false);
    await tx.run(`UPDATE tasks SET tokens_used = ?, cost_usd = ? WHERE id = ?`, [tokensUsed, costUsd, taskId]);
  });
}

/**
 * Returns an onTokensUsed callback bound to taskId that persists cumulative
 * token/cost via updateTaskTokenUsage. The same callback may be reused across
 * multiple runClaude calls for one task — totals accumulate and the running
 * sum is written on every invocation. Never fires for providers without usage
 * data (e.g. Codex), so nothing is written in that case. Also records the
 * reporting backend into `tasks.provider_used` (and its Claude account into
 * `tasks.account_used`) on every call that supplies one; when a task spans two
 * backends or accounts, the last reporter wins.
 *
 * The callback stays synchronous — `runClaude` invokes it from a stream handler
 * — so the writes are issued without being awaited. They are chained per tracker
 * so they commit in call order and the last write wins.
 */
export function trackTaskTokens(taskId: number): (tokensUsed: number, costUsd: number, provider?: string, account?: string) => void {
  let tokens = 0;
  let cost = 0;
  let lastProvider: string | undefined;
  let lastAccount: string | undefined;
  // Chained so cumulative writes commit in order; a stale lower write would read as a usage reset.
  let chain: Promise<void> = Promise.resolve();
  return (t, c, provider, account) => {
    tokens += t;
    cost += c;
    const tokensNow = tokens;
    const costNow = cost;
    chain = chain.then(() => updateTaskTokenUsage(taskId, tokensNow, costNow)).catch((err: unknown) => {
      log.warn(`trackTaskTokens(${taskId}) usage write failed: ${err}`);
    });
    if (provider && (provider !== lastProvider || account !== lastAccount)) {
      lastProvider = provider;
      lastAccount = account;
      void updateTaskProvider(taskId, provider, account).catch((err: unknown) => {
        log.warn(`trackTaskTokens(${taskId}) provider write failed: ${err}`);
      });
    }
  };
}

export async function recordTaskEffectivenessEvent(input: TaskEffectivenessEventInput): Promise<void> {
  const details = input.details === undefined || input.details === null
    ? null
    : typeof input.details === "string"
      ? input.details
      : JSON.stringify(input.details);
  await getDb().run(`
      INSERT INTO task_effectiveness_events
        (task_id, source, source_repo, source_number, source_sha, signal, score, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, source, source_repo, source_number, source_sha) DO UPDATE SET
        signal = excluded.signal,
        score = excluded.score,
        details = excluded.details,
        created_at = excluded.created_at
    `, [
      input.taskId,
      input.source,
      input.sourceRepo,
      input.sourceNumber,
      input.sourceSha,
      input.signal,
      input.score,
      details,
      nowSql(),
    ]);
}

/**
 * The task that produced `headSha` on the PR. Every pr-reviewer outcome
 * records the head it reviewed, so a reviewer round only counts as a producer
 * when it pushed (the advisory self-fix, `commits > 0`).
 */
export async function findLatestCompletedTaskForPrHead(repo: string, prNumber: number, headSha: string): Promise<Task | null> {
  const row = await getDb().get(`
      SELECT *
      FROM tasks
      WHERE COALESCE(json_extract(outcome, '$.prRepo'), repo) = ?
        AND status = 'completed'
        AND outcome IS NOT NULL
        AND CAST(json_extract(outcome, '$.prNumber') AS INTEGER) = ?
        AND json_extract(outcome, '$.headSha') = ?
        AND NOT (job_name = 'pr-reviewer' AND COALESCE(CAST(json_extract(outcome, '$.commits') AS INTEGER), 0) = 0)
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `, [repo, prNumber, headSha]) as Task | undefined;
  return row ? normalizeItemNumbers([row])[0]! : null;
}

export async function getLastUsedByProvider(): Promise<Record<string, string | null>> {
  const rows = await getDb().all(`
      SELECT provider_used, MAX(completed_at) as last_used
      FROM tasks
      WHERE provider_used IS NOT NULL AND completed_at IS NOT NULL
      GROUP BY provider_used
    `) as Array<{ provider_used: string; last_used: string }>;
  const result: Record<string, string | null> = { claude: null, codex: null, opencode: null, pi: null };
  for (const row of rows) {
    result[row.provider_used] = row.last_used;
  }
  return result;
}

/**
 * The repo/item/job a task is about, for the #2832 event bus. `recordTaskComplete`
 * and `recordTaskFailed` only receive a task id, so the subject has to be read
 * back. Returns null on any failure — a lookup must never break task accounting.
 */
async function lookupTaskSubject(taskId: number): Promise<{ repo: string; item_number: IssueRef; job_name: string } | null> {
  try {
    const row = await getDb().get(`SELECT repo, item_number, job_name FROM tasks WHERE id = ?`, [taskId]) as { repo: string; item_number: IssueRef; job_name: string } | undefined;
    if (!row || typeof row.repo !== "string" || !row.repo) return null;
    return normalizeItemNumbers([row])[0]!;
  } catch (err) {
    log.warn(`lookupTaskSubject(${taskId}) failed: ${err}`);
    return null;
  }
}

export async function recordTaskComplete(taskId: number, outcome?: TaskOutcome): Promise<void> {
  const outcomeJson = outcome ? JSON.stringify(outcome) : null;
  await getDb().run(`UPDATE tasks SET status = 'completed', outcome = ?, completed_at = ? WHERE id = ?`, [outcomeJson, nowSql(), taskId]);
  const row = await lookupTaskSubject(taskId);
  if (row) recordGitHubEvent({ kind: "task-completed", repo: row.repo, number: row.item_number, related: [], detail: row.job_name });
}

export async function recordTaskFailed(taskId: number, error: string, outcome?: TaskOutcome): Promise<void> {
  const outcomeJson = outcome ? JSON.stringify(outcome) : null;
  // The running -> failed transition is the guard: only the call that makes it counts the
  // failure, so a re-recorded or concurrently recorded failure is not counted twice.
  const transitioned = await getDb().run(
    `UPDATE tasks SET status = 'failed', error = ?, outcome = ?, completed_at = ? WHERE id = ? AND status = 'running'`,
    [error, outcomeJson, nowSql(), taskId],
  );
  if (transitioned.changes === 0) {
    // Not running (already failed, or never started): still overwrite the error and outcome.
    await getDb().run(`UPDATE tasks SET status = 'failed', error = ?, outcome = ?, completed_at = ? WHERE id = ?`, [error, outcomeJson, nowSql(), taskId]);
  } else {
    try {
      const task = await getDb().get(`
        SELECT t.job_name AS job_name, (SELECT wq.agent_pod_class FROM work_queue wq WHERE wq.run_id = t.run_id AND t.run_id IS NOT NULL ORDER BY wq.id DESC LIMIT 1) AS pod_class
        FROM tasks t WHERE t.id = ?`, [taskId]) as { job_name: string; pod_class: string | null } | undefined;
      if (task) {
        await bumpAgentEventTotal("task_failures", jobPrefix(task.job_name), outcome?.failureCategory || "unknown", task.pod_class || "none");
      }
    } catch (err) {
      logCore.warn(`[db] recordTaskFailed(${taskId}) could not count the failure: ${err}`);
    }
  }
  const row = await lookupTaskSubject(taskId);
  if (row) {
    recordGitHubEvent({
      kind: "task-failed",
      repo: row.repo,
      number: row.item_number,
      related: [],
      detail: `${row.job_name}: ${error.slice(0, 200)}`,
    });
  }
}

/**
 * Wraps a function with task lifecycle recording: records task start, invokes
 * the inner function with the new task ID, and on error records failure (with a
 * categorized outcome from {@link buildFailureOutcome}) before re-throwing.
 *
 * The inner function is responsible for calling {@link recordTaskComplete} along
 * its success paths — completion is left to the caller because outcomes vary
 * across paths (e.g. early returns, "no commits", PR-created, branch-deleted).
 */
export async function withTaskRecording<T>(
  jobName: string,
  repo: string,
  itemNumber: IssueRef,
  triggerLabel: string | null,
  fn: (taskId: number) => Promise<T>,
): Promise<T> {
  const taskId = await recordTaskStart(jobName, repo, itemNumber, triggerLabel);
  try {
    return await fn(taskId);
  } catch (err) {
    // A refused or failed recording must not replace the agent's own error.
    try {
      await recordTaskFailed(taskId, String(err), buildFailureOutcome(err));
    } catch (recordErr) {
      logCore.warn(`[db] recordTaskFailed(${taskId}) failed: ${recordErr} (original error: ${err})`);
    }
    throw err;
  }
}

/** Running tasks no live process owns — except those of a pod-backed running row, whose agent pod is still running them. */
export async function getOrphanedTasks(): Promise<Task[]> {
  return normalizeItemNumbers(await getDb().all(`
      SELECT * FROM tasks
      WHERE status = 'running'
        AND (run_id IS NULL OR run_id NOT IN (
          SELECT run_id FROM work_queue
          WHERE status = 'running' AND agent_pod IS NOT NULL AND run_id IS NOT NULL
        ))
    `) as Task[]);
}

export async function getRunningTasks(): Promise<Task[]> {
  return normalizeItemNumbers(await getDb().all(`SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at ASC`) as Task[]);
}

/** Running tasks as the `claws_status` MCP tool reports them — same columns as `mcp-server.ts`. */
export async function getRunningTaskSummaries(): Promise<Array<Pick<Task, "job_name" | "repo" | "item_number" | "started_at">>> {
  return normalizeItemNumbers(await getDb().all(
    `SELECT job_name, repo, item_number, started_at FROM tasks WHERE status = 'running' ORDER BY started_at ASC`,
  ) as Array<Pick<Task, "job_name" | "repo" | "item_number" | "started_at">>);
}

/** Whether a `jobName` task for `(repo, itemNumber)` is running right now. */
export async function hasRunningTask(jobName: string, repo: string, itemNumber: IssueRef): Promise<boolean> {
  const row = await getDb().get(
    `SELECT 1 AS n FROM tasks WHERE job_name = ? AND repo = ? AND item_number = ? AND status = 'running' LIMIT 1`,
    [jobName, repo, refParam(itemNumber)],
  );
  return !!row;
}

/**
 * The implementer attempt for `(repo, issueNumber)` whose agent pod was lost
 * with its node: the newest `issue-worker` task, but only when the launcher
 * failed it as `external-kill` (or as a `kubernetes-oom` memory-limit kill) while it worked on a `claws/issue-<ref>-`
 * branch. The re-run resumes on that branch so it never opens a second PR.
 * Null when the newest implementer task ended any other way — a later run
 * already settled the item — or worked on another issue's PR (target-PR mode).
 */
export async function findLostImplementerAttempt(repo: string, issueNumber: IssueRef): Promise<Task | null> {
  const row = await getDb().get(`
      SELECT *
      FROM tasks
      WHERE job_name = 'issue-worker' AND repo = ? AND item_number = ?
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `, [repo, refParam(issueNumber)]) as Task | undefined;
  if (!row || row.status !== "failed" || !row.outcome || !row.branch_name) return null;
  let parsed: { failureCategory?: unknown; memoryMeasurement?: unknown };
  try {
    parsed = JSON.parse(row.outcome) as { failureCategory?: unknown; memoryMeasurement?: unknown };
  } catch {
    return null;
  }
  // A Kubernetes OOM kill of the agent pod is recorded as `memory-limit`, but
  // like an external kill it ends the pod mid-run, before the implementer can
  // open its PR — so the re-run must resume on the same branch.
  const lostPod = parsed.failureCategory === "external-kill"
    || (parsed.failureCategory === "memory-limit" && parsed.memoryMeasurement === "kubernetes-oom");
  if (!lostPod) return null;
  if (!row.branch_name.startsWith(`claws/issue-${refParam(issueNumber)}-`)) return null;
  return normalizeItemNumbers([row])[0]!;
}

/** Last 20 tasks for a repo (optionally one item) as the `claws_task_history` MCP tool reports them. */
export async function getMcpTaskHistory(repo: string, itemNumber?: IssueRef): Promise<unknown[]> {
  if (itemNumber !== undefined) {
    return normalizeItemNumbers(await getDb().all(`
      SELECT t.job_name, t.item_number, t.status, t.error, t.outcome, t.started_at, t.completed_at,
             jr.job_name AS run_job, wq.agent_pod_class AS pod_class
      FROM tasks t
      LEFT JOIN job_runs jr ON t.run_id = jr.run_id
      LEFT JOIN work_queue wq ON wq.run_id = t.run_id
      WHERE t.repo = ? AND t.item_number = ?
      ORDER BY t.started_at DESC LIMIT 20
    `, [repo, refParam(itemNumber)]) as object[]);
  }
  return normalizeItemNumbers(await getDb().all(`
    SELECT t.job_name, t.item_number, t.status, t.error, t.outcome, t.started_at, t.completed_at,
           jr.job_name AS run_job, wq.agent_pod_class AS pod_class
    FROM tasks t
    LEFT JOIN job_runs jr ON t.run_id = jr.run_id
    LEFT JOIN work_queue wq ON wq.run_id = t.run_id
    WHERE t.repo = ?
    ORDER BY t.started_at DESC LIMIT 20
  `, [repo]) as object[]);
}

export interface McpRecentJobRun {
  diagnostics: Array<Pick<McpRecentJobLog, "id" | "diagnostic_reason" | "diagnostic_context" | "logged_at">>;
  diagnostics_truncated: boolean;
  diagnostic_reason: ReturnType<typeof diagnosticQueries.diagnosticReason>;
  run_id: string;
  job_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  latest_error: string | null;
  latest_log_excerpt: string | null;
}

export async function getMcpRecentJobRuns(limit = 20, jobFilter?: string): Promise<McpRecentJobRun[]> {
  await flushJobLogs();
  return diagnosticQueries.getMcpRecentJobRuns(getDb(), limit, jobFilter);
}

export interface McpRecentJobLog {
  diagnostic_context: diagnosticQueries.DiagnosticContext;
  diagnostic_reason: ReturnType<typeof diagnosticQueries.diagnosticReason>;
  id: number;
  run_id: string;
  job_name: string;
  level: string;
  message: string;
  logged_at: string;
}

export async function getMcpRecentJobLogs(opts: { runId?: string; jobName?: string; limit?: number } = {}): Promise<McpRecentJobLog[]> {
  await flushJobLogs();
  return diagnosticQueries.getMcpRecentJobLogs(getDb(), opts);
}

