/** Read-only diagnostics shared by HTTP and standalone stdio; no service imports. */
import type { SqlDriver } from "./db-driver.js";
import type { McpRecentJobRun, McpRecentJobLog, McpWorkQueueRow, McpRepoProcessingState } from "./db.js";
import { normalizeItemNumbers } from "./issue-id.js";
import { stageRankOf, stageRankSql } from "./work-order.js";

/** Producer-selected codes only; never interpret arbitrary log text. */
const DIAGNOSTIC_REASONS = {
  scheduling_disabled: "Skipped: smart scheduling is disabled.",
  scheduling_none_due: "Skipped: no eligible repositories reached target staleness.",
  scheduling_repo_disabled: "Skipped: this job is disabled for the repository.",
  scheduling_all_excluded: "Skipped: this job is disabled for every repository.",
  scheduling_busy: "Skipped: Claws was busy and no due repository breached the SLO.",
  scheduling_slo_override: "Busy gating restricted processing to repositories breaching the SLO.",
  scheduling_busy_ignored: "This job ignores the busy gate; busy state was not checked.",
  docs_open_pr: "Skipped: an open documentation PR already exists.",
  docs_unchanged: "Skipped: no changes since the last documentation update.",
  agent_timeout: "Agent exceeded its execution time limit.",
  agent_memory_limit: "Agent exceeded its memory limit.",
  rate_limited: "Provider or forge rate limit prevented execution.",
  operation_failed: "Operation failed; private details are available in operator logs.",
} as const;
export type DiagnosticReason = keyof typeof DIAGNOSTIC_REASONS;

export function diagnosticReason(value: unknown): { code: DiagnosticReason; summary: string } | null {
  if (typeof value !== "string" || !Object.hasOwn(DIAGNOSTIC_REASONS, value)) return null;
  const code = value as DiagnosticReason;
  return { code, summary: DIAGNOSTIC_REASONS[code] };
}

/** Only explicit public fields survive persistence and projection. */
export interface DiagnosticContext {
  repo?: string;
  job?: string;
  hostDisabled?: boolean;
  repositoryDisabled?: boolean;
  taskId?: number;
  enabled?: boolean;
  busy?: boolean;
  targetStalenessMs?: number;
  sloStalenessMs?: number;
  dueCount?: number;
  sloBreachedCount?: number;
}

export function diagnosticContext(value: unknown): DiagnosticContext {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const result: DiagnosticContext = {};
  if (typeof input.repo === "string" && input.repo.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.repo)) result.repo = input.repo;
  if (Number.isSafeInteger(input.taskId) && (input.taskId as number) > 0) result.taskId = input.taskId as number;
  if (typeof input.job === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(input.job)) result.job = input.job;
  for (const key of ["enabled", "busy", "hostDisabled", "repositoryDisabled"] as const) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  for (const key of ["targetStalenessMs", "sloStalenessMs", "dueCount", "sloBreachedCount"] as const) {
    if (Number.isSafeInteger(input[key]) && (input[key] as number) >= 0) result[key] = input[key] as number;
  }
  return result;
}

/**
 * Every value that may legitimately appear in `tasks.outcome.failureCategory`:
 * the union `categorizeFailure()` produces, plus `logs-unavailable`, which
 * `ci-fixer.ts` writes directly.
 *
 * Declared here rather than in `outcome.ts` because this module must stay free
 * of service imports — `mcp-server.ts` loads it in a standalone child process,
 * while `outcome.ts` pulls in `claude.ts` and the whole config graph.
 * `categorizeFailure()` is typed as returning `FailureCategory` via a type-only
 * import, so there is no runtime coupling, but adding a category without
 * listing it here is a compile error instead of a silently-projected `null`.
 */
export const FAILURE_CATEGORIES = [
  "timeout", "memory-limit", "external-kill", "shutdown", "rate-limit",
  "transient-api", "ref-not-found", "push-rejection", "git-conflict",
  "usage-limit", "unsupported-model", "auth-expired", "logs-unavailable",
  "unknown",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
const FAILURE_CATEGORY_SET: ReadonlySet<string> = new Set(FAILURE_CATEGORIES);

/** Project existing producer-classified task outcomes without exposing arbitrary outcome fields. */
export function taskFailureReason(outcome: unknown): string | null {
  try {
    const parsed = typeof outcome === "string" ? JSON.parse(outcome) : outcome;
    const category = parsed?.failureCategory;
    return typeof category === "string" && FAILURE_CATEGORY_SET.has(category) ? category : null;
  } catch {
    return null;
  }
}

/** Arbitrary agent/subprocess text has no safe secret pattern allowlist. Fail closed.
 * Keep presence/null information; raw payloads stay in operator-only logs.
 */
export function sanitizeDiagnosticText(value: string | null): string | null {
  return value === null ? null : "[redacted diagnostic text]";
}

export async function getMcpRecentJobRuns(db: SqlDriver, limit = 20, jobFilter?: string): Promise<McpRecentJobRun[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const where = jobFilter ? "WHERE jr.job_name = ?" : "";
  const params: unknown[] = jobFilter ? [jobFilter, capped] : [capped];
  const rows = await db.all<Omit<McpRecentJobRun, "diagnostic_reason" | "diagnostics" | "diagnostics_truncated"> & { diagnostic_reason: string | null }>(`
    SELECT jr.run_id, jr.job_name, jr.status, jr.started_at, jr.completed_at,
           (SELECT l.diagnostic_reason FROM job_logs l
            WHERE l.run_id = jr.run_id AND l.diagnostic_reason IS NOT NULL
            ORDER BY l.id DESC LIMIT 1) AS diagnostic_reason,
           (
             SELECT substr(l.message, 1, 4000)
             FROM job_logs l
             WHERE l.run_id = jr.run_id AND l.level IN ('error', 'warn')
             ORDER BY l.id DESC LIMIT 1
           ) AS latest_error,
           (
             SELECT substr(l.message, 1, 4000)
             FROM job_logs l
             WHERE l.run_id = jr.run_id
             ORDER BY l.id DESC LIMIT 1
           ) AS latest_log_excerpt
    FROM job_runs jr
    ${where}
    ORDER BY jr.started_at DESC
    LIMIT ?
  `, params);
  return await Promise.all(rows.map(async (row) => {
    const events = await db.all<{ diagnostic_reason: string; diagnostic_context: string; logged_at: string; id: number }>(
      "SELECT id, diagnostic_reason, diagnostic_context, logged_at FROM job_logs WHERE run_id = ? AND diagnostic_reason IS NOT NULL ORDER BY id DESC LIMIT 201", [row.run_id]);
    return { ...row, diagnostic_reason: diagnosticReason(row.diagnostic_reason),
      diagnostics: events.slice(0, 200).map((event) => ({ ...event, diagnostic_reason: diagnosticReason(event.diagnostic_reason), diagnostic_context: diagnosticContext(event.diagnostic_context) })),
      diagnostics_truncated: events.length > 200,
      latest_error: sanitizeDiagnosticText(row.latest_error), latest_log_excerpt: sanitizeDiagnosticText(row.latest_log_excerpt) };
  }));
}

export async function getMcpRecentJobLogs(db: SqlDriver, opts: { runId?: string; jobName?: string; limit?: number } = {}): Promise<McpRecentJobLog[]> {
  const capped = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.runId) {
    where.push("l.run_id = ?");
    params.push(opts.runId);
  }
  if (opts.jobName) {
    where.push("jr.job_name = ?");
    params.push(opts.jobName);
  }
  params.push(capped);
  const rows = await db.all<Omit<McpRecentJobLog, "diagnostic_reason" | "diagnostic_context"> & { diagnostic_reason: string | null; diagnostic_context: string | null }>(`
    SELECT l.id, l.run_id, jr.job_name, l.level, substr(l.message, 1, 4000) AS message, l.diagnostic_reason, l.diagnostic_context, l.logged_at
    FROM job_logs l
    LEFT JOIN job_runs jr ON jr.run_id = l.run_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY l.id DESC
    LIMIT ?
  `, params);
  return rows.map((row) => ({ ...row, diagnostic_reason: diagnosticReason(row.diagnostic_reason), diagnostic_context: diagnosticContext(row.diagnostic_context), message: sanitizeDiagnosticText(row.message)! }));
}

/** Queued/running rows come back in claim order: priority, stage, age. */
export async function getMcpWorkQueue(db: SqlDriver, limit = 100, statuses: readonly string[] = ["queued", "running"]): Promise<McpWorkQueueRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const filteredStatuses = statuses.filter((s) => ["queued", "running", "failed", "completed", "cancelled"].includes(s));
  const effectiveStatuses = filteredStatuses.length ? filteredStatuses : ["queued", "running"];
  const placeholders = effectiveStatuses.map(() => "?").join(",");
  const rows = await db.all<McpWorkQueueRow>(`
    SELECT id, kind, repo, item_number, priority, status, pid, attempts,
           error_message, enqueued_at, started_at, completed_at, run_id
    FROM work_queue
    WHERE status IN (${placeholders})
    ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
      CASE WHEN status IN ('running', 'queued') THEN priority END DESC,
      CASE WHEN status IN ('running', 'queued') THEN ${stageRankSql()} END ASC,
      CASE WHEN status IN ('running', 'queued') THEN id END ASC,
      completed_at DESC, id DESC
    LIMIT ?
  `, [...effectiveStatuses, capped]);
  // Normalised here rather than in `db.ts`: the MCP child process calls this
  // function directly with its own driver, so a wrapper one level up would
  // leave that reader seeing `item_number: "3215"` where every other tool
  // reports `3215`.
  return normalizeItemNumbers(rows.map((row) => ({ ...row, stage: stageRankOf(row.kind), error_message: sanitizeDiagnosticText(row.error_message) })));
}

export async function getMcpRepoProcessingState(db: SqlDriver, opts: { jobName?: string; repo?: string; limit?: number } = {}): Promise<McpRepoProcessingState[]> {
  const capped = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.jobName) {
    where.push("job_name = ?");
    params.push(opts.jobName);
  }
  if (opts.repo) {
    where.push("repo = ?");
    params.push(opts.repo);
  }
  params.push(capped);
  return await db.all(`
    SELECT job_name, repo, local_date, processed_at
    FROM (
      SELECT job_name, repo, local_date, processed_at,
             ROW_NUMBER() OVER (PARTITION BY job_name, repo ORDER BY processed_at DESC, local_date DESC) AS recency
      FROM processed_repos_daily
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ) latest
    WHERE recency = 1
    ORDER BY processed_at DESC, job_name ASC, repo ASC
    LIMIT ?
  `, params) as McpRepoProcessingState[];
}

/** A native issue attachment row as the stdio claws-state server reads it (#3289). */
export interface McpIssueAttachmentRow {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  comment_id: string | null;
  uploader_login: string;
  created_at: string;
  /** Relative to WORK_DIR; the caller path-checks it before reading. */
  stored_path: string;
}

/**
 * The attachments of native issue `issueId`, oldest first. A shadow issue
 * lists nothing, as its dashboard routes 404; a pending upload (NULL
 * `issue_id`) never matches.
 */
export async function getIssueAttachmentRows(db: SqlDriver, issueId: string): Promise<McpIssueAttachmentRow[]> {
  const rows = await db.all<McpIssueAttachmentRow>(`
    SELECT a.id, a.filename, a.content_type, a.size, a.comment_id, a.uploader_login, a.created_at, a.stored_path
    FROM claws_issue_attachments a
    JOIN claws_issues i ON i.id = a.issue_id
    WHERE a.issue_id = ? AND i.kind <> 'shadow'
    ORDER BY a.id ASC
  `, [issueId]);
  // Postgres may widen INTEGER to a string.
  return rows.map((row) => ({ ...row, size: Number(row.size) }));
}
