// Recent-failure counters, the CI-fixer breaker and attempt counters,
// session PR actions, Actions control and disabled workflows.
// Reached only through the src/db.ts façade.
import * as logCore from "../log-core.js";
import { PRE_WORK_FAILURE_CATEGORIES_SQL } from "../outcome.js";
import type { IssueRef } from "../issue-id.js";
import { getDb, refParam } from "./core.js";


export async function countRecentTimeouts(repo: string, itemNumber: IssueRef, windowMs: number = 2 * 60 * 60 * 1000): Promise<number> {
  // Format cutoff to match SQLite's datetime() format (YYYY-MM-DD HH:MM:SS)
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND error LIKE '%timed out%'
       AND completed_at > ?`, [repo, refParam(itemNumber), cutoff]) as { cnt: number };
  return row.cnt;
}

/** Failed `work_queue` rows for this kind/repo/item within `windowMs` whose error starts with `errorPrefix`. */
export async function countRecentWorkFailures(kind: string, repo: string, itemNumber: IssueRef, errorPrefix: string, windowMs: number = 2 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const escaped = errorPrefix.replace(/[\\%_]/g, "\\$&");
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM work_queue
       WHERE kind = ? AND repo = ? AND item_number = ? AND status = 'failed'
       AND error_message LIKE ? ESCAPE '\\'
       AND completed_at > ?`, [kind, repo, refParam(itemNumber), `${escaped}%`, cutoff]) as { cnt: number };
  return Number(row.cnt);
}

export async function countRecentMemoryLimits(repo: string, itemNumber: IssueRef, limitBytes?: number, windowMs: number = 2 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  if (limitBytes === undefined) {
    const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND error LIKE '%exceeded memory limit%'
       AND completed_at > ?`, [repo, refParam(itemNumber), cutoff]) as { cnt: number };
    return row.cnt;
  }
  // Rows written since #3168 carry the breached cap structurally in the outcome
  // JSON, so the same-cap count is plain SQL and survives any rewording of
  // AgentMemoryLimitError's message.
  const structural = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND CAST(json_extract(outcome, '$.memoryLimitBytes') AS INTEGER) = ?
       AND completed_at > ?`, [repo, refParam(itemNumber), limitBytes, cutoff]) as { cnt: number };
  // Fallback for rows written before that field existed: parse the cap out of
  // the stored message. Scoped to rows with no structural value so the two
  // branches can never double-count the same task.
  const legacyRows = await getDb().all(`SELECT error FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND json_extract(outcome, '$.memoryLimitBytes') IS NULL
       AND error LIKE '%exceeded memory limit%'
       AND completed_at > ?`, [repo, refParam(itemNumber), cutoff]) as Array<{ error: string | null }>;
  const targetMiB = Math.round(limitBytes / 1048576);
  const legacy = legacyRows.filter((row) => {
    const match = /\((?:\d+)MiB > (\d+)MiB\)/.exec(row.error ?? "");
    return match ? Number(match[1]) === targetMiB : false;
  }).length;
  return structural.cnt + legacy;
}

/**
 * How many `issue-worker` runs for `repo#itemNumber` completed with no
 * commits and no PR within the last `windowMs`, since the last run that
 * opened a PR. With `since` (ISO 8601) only runs completed after it count —
 * the implementer's circuit breaker passes the time it last tripped, so a
 * human's retry after the trip starts the count again.
 */
export async function countRecentNoCommitCompletions(
  repo: string,
  itemNumber: IssueRef,
  windowMs: number = 6 * 60 * 60 * 1000,
  since?: string | null,
): Promise<number> {
  const windowStart = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const sinceMs = since ? Date.parse(since) : NaN;
  const sinceSql = Number.isNaN(sinceMs) ? null : new Date(sinceMs).toISOString().slice(0, 19).replace("T", " ");
  const cutoff = sinceSql !== null && sinceSql > windowStart ? sinceSql : windowStart;
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE job_name = 'issue-worker'
       AND repo = ? AND item_number = ? AND status = 'completed'
       AND CAST(json_extract(outcome, '$.commits') AS INTEGER) = 0
       AND json_extract(outcome, '$.prNumber') IS NULL
       AND completed_at > ?
       AND completed_at > COALESCE(
         (SELECT MAX(completed_at) FROM tasks
          WHERE job_name = 'issue-worker'
          AND repo = ? AND item_number = ? AND status = 'completed'
          AND json_extract(outcome, '$.prNumber') IS NOT NULL),
         '1970-01-01')`, [repo, refParam(itemNumber), cutoff, repo, refParam(itemNumber)]) as { cnt: number };
  return row.cnt;
}

export async function hasPreviousCiFixerTasks(repo: string, prNumber: number): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 FROM tasks WHERE job_name = 'ci-fixer' AND repo = ? AND item_number = ? AND status = 'completed' LIMIT 1`, [repo, refParam(prNumber)]);
  return row !== undefined;
}

/** Per-PR circuit-breaker bookkeeping, backing the new-commit fix grant. */
export interface CIFixerBreakerState {
  trippedSha: string | null;
  trippedAt: string | null;
  lastClawsSha: string | null;
  budgetFloorAt: string | null;
  grants: number;
}

/** Read the breaker state for a PR, or `undefined` when the breaker never tripped. */
export async function getCIFixerBreakerState(repo: string, prNumber: number): Promise<CIFixerBreakerState | undefined> {
  const row = await getDb().get(`SELECT tripped_sha, tripped_at, last_claws_sha, budget_floor_at, grants
       FROM ci_fixer_breaker WHERE repo = ? AND item_number = ?`, [repo, prNumber]) as
    | { tripped_sha: string | null; tripped_at: string | null; last_claws_sha: string | null; budget_floor_at: string | null; grants: number }
    | undefined;
  if (!row) return undefined;
  return {
    trippedSha: row.tripped_sha,
    trippedAt: row.tripped_at,
    lastClawsSha: row.last_claws_sha,
    budgetFloorAt: row.budget_floor_at,
    grants: row.grants,
  };
}

/**
 * Record the head SHA a PR was sitting on when the circuit breaker tripped.
 * Deliberately leaves `grants`, `budget_floor_at` and `last_claws_sha` alone —
 * a re-trip must not wipe the lifetime grant count.
 */
export async function recordCIFixerBreakerTrip(repo: string, prNumber: number, headSha: string | null): Promise<void> {
  await getDb().run(`INSERT INTO ci_fixer_breaker (repo, item_number, tripped_sha, tripped_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, item_number) DO UPDATE SET
         tripped_sha = excluded.tripped_sha,
         tripped_at  = excluded.tripped_at`, [repo, prNumber, headSha, new Date().toISOString()]);
}

/**
 * Record a head SHA that Claws itself pushed to a PR branch. Guards the
 * new-commit grant against Claws resetting its own budget with its own fixes.
 */
export async function recordCIFixerPush(repo: string, prNumber: number, headSha: string): Promise<void> {
  await getDb().run(`INSERT INTO ci_fixer_breaker (repo, item_number, last_claws_sha)
       VALUES (?, ?, ?)
       ON CONFLICT(repo, item_number) DO UPDATE SET last_claws_sha = excluded.last_claws_sha`, [repo, prNumber, headSha]);
}

/**
 * Grant a fresh fix budget after a new head commit. Clears the trip, advances
 * the budget floor so pre-trip attempts stop counting, and either resets the
 * lifetime grant count (the new head is green) or spends one grant.
 */
export async function recordCIFixerBreakerGrant(repo: string, prNumber: number, opts: { recovered: boolean }): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(`INSERT INTO ci_fixer_breaker (repo, item_number, tripped_sha, tripped_at, budget_floor_at, grants)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(repo, item_number) DO UPDATE SET
         tripped_sha     = NULL,
         tripped_at      = NULL,
         budget_floor_at = excluded.budget_floor_at,
         grants          = ${opts.recovered ? "0" : "ci_fixer_breaker.grants + 1"}`, [repo, prNumber, now, opts.recovered ? 0 : 1]);
}

/**
 * Full reset for "a human (or the diagnoser) cleared the problematic label" —
 * drops the trip, zeroes the lifetime grants and advances the budget floor so
 * the pre-existing attempts in the 24h window can't immediately re-trip.
 */
export async function resetCIFixerBreakerGrants(repo: string, prNumber: number): Promise<void> {
  await getDb().run(`INSERT INTO ci_fixer_breaker (repo, item_number, tripped_sha, tripped_at, budget_floor_at, grants)
       VALUES (?, ?, NULL, NULL, ?, 0)
       ON CONFLICT(repo, item_number) DO UPDATE SET
         tripped_sha     = NULL,
         tripped_at      = NULL,
         budget_floor_at = excluded.budget_floor_at,
         grants          = 0`, [repo, prNumber, new Date().toISOString()]);
}

/** A PR recovery action an interactive session took (`session_pr_actions.action`). */
export type SessionPrAction = "rerun" | "unmark-problematic" | "rediagnose" | "feedback" | "merge" | "approve-merge";

/** Record that session `sessionId` took `action` on `repo#prNumber`. */
export async function recordSessionPrAction(entry: {
  repo: string;
  prNumber: number;
  sessionId: string;
  action: SessionPrAction;
  detail?: string | null;
  commentId?: string | null;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO session_pr_actions (repo, pr_number, session_id, action, detail, comment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.repo, entry.prNumber, entry.sessionId, entry.action, entry.detail ?? null, entry.commentId ?? null, new Date().toISOString()],
  );
}

/** An Actions control a session or the dashboard took (`actions_control_log.action`). */
export type ActionsControlAction = "cancel-run" | "disable-workflow" | "enable-workflow";

/** One `actions_control_log` row. */
export interface ActionsControlEntry {
  id: number;
  repo: string;
  /** `session:<sid>` or `dashboard`. */
  actor: string;
  action: ActionsControlAction;
  /** The run number for `cancel-run`, else the workflow file. */
  target: string;
  prNumber: number | null;
  detail: string | null;
  createdAt: string;
}

/** Record one cancelled run or workflow toggle on `repo`. */
export async function recordActionsControl(entry: {
  repo: string;
  actor: string;
  action: ActionsControlAction;
  target: string;
  prNumber?: number | null;
  detail?: string | null;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO actions_control_log (repo, actor, action, target, pr_number, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.repo, entry.actor, entry.action, entry.target, entry.prNumber ?? null, entry.detail ?? null, new Date().toISOString()],
  );
}

/** The newest `limit` `actions_control_log` rows for `repo`, newest first. */
export async function listRecentActionsControl(repo: string, limit: number): Promise<ActionsControlEntry[]> {
  const rows = await getDb().all(
    `SELECT id, repo, actor, action, target, pr_number, detail, created_at FROM actions_control_log
       WHERE repo = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [repo, limit],
  ) as Array<{ id: number; repo: string; actor: string; action: ActionsControlAction; target: string; pr_number: number | null; detail: string | null; created_at: string }>;
  return rows.map((r) => ({
    id: Number(r.id),
    repo: r.repo,
    actor: r.actor,
    action: r.action,
    target: r.target,
    prNumber: r.pr_number === null ? null : Number(r.pr_number),
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

/** One `disabled_workflows` row: a workflow file disabled on a repo. */
export interface DisabledWorkflow {
  repo: string;
  workflow: string;
  /** `session:<sid>` or `dashboard` when Claws disabled it, else NULL (seen disabled on Forgejo). */
  disabledBy: string | null;
  /** When Claws first saw it disabled, ISO-8601 UTC. */
  firstSeenAt: string;
}

/**
 * Make `repo`'s `disabled_workflows` rows exactly `files`: rows for files no
 * longer listed are deleted, new files are inserted with no `disabled_by`, and
 * rows that remain keep their `disabled_by` and `first_seen_at`.
 */
export async function replaceDisabledWorkflows(repo: string, files: readonly string[]): Promise<void> {
  const wanted = [...new Set(files)];
  const now = new Date().toISOString();
  await getDb().transaction(async (tx) => {
    const existing = (await tx.all(`SELECT workflow FROM disabled_workflows WHERE repo = ?`, [repo]) as Array<{ workflow: string }>).map((r) => r.workflow);
    for (const workflow of existing) {
      if (!wanted.includes(workflow)) await tx.run(`DELETE FROM disabled_workflows WHERE repo = ? AND workflow = ?`, [repo, workflow]);
    }
    for (const workflow of wanted) {
      if (existing.includes(workflow)) continue;
      await tx.run(
        `INSERT INTO disabled_workflows (repo, workflow, disabled_by, first_seen_at) VALUES (?, ?, NULL, ?)
           ON CONFLICT(repo, workflow) DO NOTHING`,
        [repo, workflow, now],
      );
    }
  });
}

/** Record `workflow` disabled on `repo` by `disabledBy`; an existing row takes the new actor and keeps its `first_seen_at`. */
export async function upsertDisabledWorkflow(repo: string, workflow: string, disabledBy: string | null): Promise<void> {
  await getDb().run(
    `INSERT INTO disabled_workflows (repo, workflow, disabled_by, first_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, workflow) DO UPDATE SET disabled_by = excluded.disabled_by`,
    [repo, workflow, disabledBy, new Date().toISOString()],
  );
}

/** Forget `workflow` as disabled on `repo`. */
export async function deleteDisabledWorkflow(repo: string, workflow: string): Promise<void> {
  await getDb().run(`DELETE FROM disabled_workflows WHERE repo = ? AND workflow = ?`, [repo, workflow]);
}

/** Disabled workflows on `repo`, or on every repo when omitted, sorted by repo then file. */
export async function listDisabledWorkflows(repo?: string): Promise<DisabledWorkflow[]> {
  const rows = (repo === undefined
    ? await getDb().all(`SELECT repo, workflow, disabled_by, first_seen_at FROM disabled_workflows ORDER BY repo, workflow`)
    : await getDb().all(`SELECT repo, workflow, disabled_by, first_seen_at FROM disabled_workflows WHERE repo = ? ORDER BY workflow`, [repo])
  ) as Array<{ repo: string; workflow: string; disabled_by: string | null; first_seen_at: string }>;
  return rows.map((r) => ({ repo: r.repo, workflow: r.workflow, disabledBy: r.disabled_by, firstSeenAt: r.first_seen_at }));
}

/**
 * Ids of the comments sessions posted on `repo#prNumber` through
 * `claws_comment_on_pr` — the allowlist of bot-authored comments the review
 * readers take as human feedback rather than Claws output.
 */
export async function getSessionFeedbackCommentIds(repo: string, prNumber: number): Promise<Set<string>> {
  const rows = await getDb().all(
    `SELECT comment_id FROM session_pr_actions WHERE repo = ? AND pr_number = ? AND action = 'feedback' AND comment_id IS NOT NULL`,
    [repo, prNumber],
  ) as Array<{ comment_id: string }>;
  return new Set(rows.map((r) => String(r.comment_id)));
}

/**
 * Count CI fixer attempts for a PR within a time window.
 * Returns counts for total attempts, failed attempts, and successful attempts.
 * `preWorkFailed` counts attempts that failed before the agent ran (see
 * `PRE_WORK_FAILURE_CATEGORIES`) — callers subtract these from `failed` so a
 * provider outage does not trip the CI-fix circuit breaker. `rerunOnly` counts
 * attempts that read no CI log and only re-ran the workflow (or found it already
 * running) — callers exclude them from the fix budget and bound them separately,
 * since they changed nothing in the PR. `pushed` counts completed runs that
 * pushed a commit (`prAction: "updated"`) and `gaveUp` counts runs whose agent
 * gave up with a stated reason (`giveUpReason`); callers count only these two
 * towards the fix-attempt cap.
 *
 * `sinceIso` is an optional budget floor (ISO timestamp): when it is newer than
 * the window cutoff, attempts before it are excluded. An older floor never
 * widens the window.
 */
export async function countCIFixerAttempts(
  repo: string,
  prNumber: number,
  windowMs: number = 24 * 60 * 60 * 1000, // 24 hours default
  sinceIso?: string | null,
): Promise<{ total: number; failed: number; successful: number; preWorkFailed: number; rerunOnly: number; pushed: number; gaveUp: number }> {
  const windowCutoff = new Date(Date.now() - windowMs).toISOString();
  const cutoff = sinceIso && sinceIso > windowCutoff ? sinceIso : windowCutoff;
  const result = await getDb().get(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as successful,
        COALESCE(SUM(CASE WHEN status = 'failed'
          AND json_extract(outcome, '$.failureCategory') IN (${PRE_WORK_FAILURE_CATEGORIES_SQL})
          THEN 1 ELSE 0 END), 0) as "preWorkFailed",
        COALESCE(SUM(CASE WHEN status = 'failed'
          AND json_extract(outcome, '$.failureCategory') = 'rerun-only'
          THEN 1 ELSE 0 END), 0) as "rerunOnly",
        COALESCE(SUM(CASE WHEN status = 'completed'
          AND json_extract(outcome, '$.prAction') = 'updated'
          THEN 1 ELSE 0 END), 0) as pushed,
        COALESCE(SUM(CASE WHEN json_extract(outcome, '$.giveUpReason') IS NOT NULL
          THEN 1 ELSE 0 END), 0) as "gaveUp"
      FROM tasks
      -- Conflict resolution has its own budget (countConflictResolutionAttempts) so a
      -- conflict loop cannot exhaust the CI-fix budget or vice-versa (#2389).
      WHERE (job_name = 'ci-fixer' OR (job_name LIKE 'ci-fixer:%' AND job_name != 'ci-fixer:merge-conflict'))
        AND repo = ?
        AND item_number = ?
        AND datetime(started_at) >= datetime(?)
    `, [repo, refParam(prNumber), cutoff]) as { total: number; failed: number; successful: number; preWorkFailed: number; rerunOnly: number; pushed: number; gaveUp: number };
  return result;
}

/**
 * CI-fixer runs on one PR head that pushed nothing: `noop` counts completed runs
 * that also gave no reason (not fix attempts, so `countCIFixerAttempts` never caps
 * them), `gaveUp` counts runs whose agent gave up with a stated reason. Both match
 * on the outcome's `headSha`, so a new commit starts from zero. `identifyPRWork`
 * uses them to stop re-dispatching against a head nothing has changed on. Same
 * window and budget-floor rules as `countCIFixerAttempts`.
 */
export async function countCIFixerIdleRunsOnHead(
  repo: string,
  prNumber: number,
  headSha: string,
  windowMs: number = 24 * 60 * 60 * 1000,
  sinceIso?: string | null,
): Promise<{ noop: number; gaveUp: number }> {
  const windowCutoff = new Date(Date.now() - windowMs).toISOString();
  const cutoff = sinceIso && sinceIso > windowCutoff ? sinceIso : windowCutoff;
  const result = await getDb().get(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'completed'
          AND json_extract(outcome, '$.prAction') IS NULL
          AND json_extract(outcome, '$.giveUpReason') IS NULL
          THEN 1 ELSE 0 END), 0) as noop,
        COALESCE(SUM(CASE WHEN json_extract(outcome, '$.giveUpReason') IS NOT NULL
          THEN 1 ELSE 0 END), 0) as "gaveUp"
      FROM tasks
      WHERE (job_name = 'ci-fixer' OR (job_name LIKE 'ci-fixer:%' AND job_name != 'ci-fixer:merge-conflict'))
        AND repo = ?
        AND item_number = ?
        AND json_extract(outcome, '$.headSha') = ?
        AND datetime(started_at) >= datetime(?)
    `, [repo, refParam(prNumber), headSha, cutoff]) as { noop: number; gaveUp: number };
  return result;
}

/**
 * Whether a CI-fixer run gave up on `headSha` of the PR with a stated reason
 * (`giveUpReason`). No time window, unlike {@link countCIFixerIdleRunsOnHead}:
 * the PR-stall park reads it to keep an issue in Blocked while a held PR's CI
 * cannot pass, which outlasts the CI fixer's own window and a restart.
 */
export async function hasCiFixerGiveUpOnHead(repo: string, prNumber: number, headSha: string): Promise<boolean> {
  const row = await getDb().get(`
      SELECT 1 AS hit
      FROM tasks
      WHERE (job_name = 'ci-fixer' OR (job_name LIKE 'ci-fixer:%' AND job_name != 'ci-fixer:merge-conflict'))
        AND repo = ?
        AND item_number = ?
        AND json_extract(outcome, '$.headSha') = ?
        AND json_extract(outcome, '$.giveUpReason') IS NOT NULL
      LIMIT 1
    `, [repo, refParam(prNumber), headSha]);
  return !!row;
}

/**
 * The `repo#prNumber#headSha` keys of `rows` whose current head the CI fixer
 * has stopped on — the check `identifyPRWork` makes with
 * {@link countCIFixerIdleRunsOnHead}, batched: within `windowMs` and after the
 * PR's breaker `budgetFloorAt`, a run gave up with a stated reason or
 * `maxNoopRuns` runs pushed nothing. One breaker read and one `tasks` read for
 * all rows. Whether CI still fails on the head is the caller's to check.
 * Web/controller-only: not mirrored in `db-remote` or the agent-pod ops.
 */
export async function listCiFixerGiveUpHeads(
  rows: readonly { repo: string; prNumber: number; headSha: string | null }[],
  opts: { windowMs: number; maxNoopRuns: number },
): Promise<Set<string>> {
  const hits = new Set<string>();
  const withHead = rows.filter((r): r is { repo: string; prNumber: number; headSha: string } => !!r.headSha);
  if (withHead.length === 0) return hits;
  const started = Date.now();
  const repos = [...new Set(withHead.map((r) => r.repo))];
  const floors = new Map<string, string>();
  const breakerRows = await getDb().all(`
      SELECT repo, item_number, budget_floor_at
      FROM ci_fixer_breaker
      WHERE repo IN (${repos.map(() => "?").join(", ")}) AND budget_floor_at IS NOT NULL
    `, repos) as { repo: string; item_number: unknown; budget_floor_at: string }[];
  for (const b of breakerRows) floors.set(`${b.repo}#${Number(b.item_number)}`, b.budget_floor_at);
  const windowCutoff = new Date(Date.now() - opts.windowMs).toISOString();
  const params: unknown[] = [];
  const clauses = withHead.map((r) => {
    const floor = floors.get(`${r.repo}#${r.prNumber}`);
    params.push(r.repo, refParam(r.prNumber), r.headSha, floor && floor > windowCutoff ? floor : windowCutoff);
    return "(repo = ? AND item_number = ? AND json_extract(outcome, '$.headSha') = ? AND datetime(started_at) >= datetime(?))";
  });
  const found = await getDb().all(`
      SELECT repo, item_number, json_extract(outcome, '$.headSha') AS head,
        COALESCE(SUM(CASE WHEN status = 'completed'
          AND json_extract(outcome, '$.prAction') IS NULL
          AND json_extract(outcome, '$.giveUpReason') IS NULL
          THEN 1 ELSE 0 END), 0) AS noop,
        COALESCE(SUM(CASE WHEN json_extract(outcome, '$.giveUpReason') IS NOT NULL
          THEN 1 ELSE 0 END), 0) AS "gaveUp"
      FROM tasks
      WHERE (job_name = 'ci-fixer' OR (job_name LIKE 'ci-fixer:%' AND job_name != 'ci-fixer:merge-conflict'))
        AND (${clauses.join(" OR ")})
      GROUP BY repo, item_number, json_extract(outcome, '$.headSha')
    `, params) as { repo: string; item_number: unknown; head: unknown; noop: unknown; gaveUp: unknown }[];
  for (const r of found) {
    if (Number(r.gaveUp) > 0 || Number(r.noop) >= opts.maxNoopRuns) hits.add(`${r.repo}#${Number(r.item_number)}#${String(r.head)}`);
  }
  logCore.debug("[db] listCiFixerGiveUpHeads", { duration_ms: Date.now() - started, rows: rows.length, hits: hits.size });
  return hits;
}

/**
 * Count merge-conflict resolution attempts for a PR within a window.
 * `unproductive` counts attempts that failed after the agent had a chance to
 * work, or completed without producing a commit — a successful resolution is
 * progress, not a loop, so it does not consume the conflict budget (#2389).
 * Attempts that failed before the agent ran (see `PRE_WORK_FAILURE_CATEGORIES`)
 * still count in `total` (so the dashboard/task history stay honest) but not in
 * `unproductive`. `recentPreWorkFailed` counts such failures within
 * `providerBackoffMs` of now, so callers can back off instead of re-dispatching
 * into an ongoing outage (#2977).
 */
export async function countConflictResolutionAttempts(
  repo: string,
  prNumber: number,
  windowMs: number = 24 * 60 * 60 * 1000,
  providerBackoffMs: number = 0,
): Promise<{ total: number; unproductive: number; preWorkFailed: number; recentPreWorkFailed: number }> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const backoffCutoff = new Date(Date.now() - providerBackoffMs).toISOString();
  const result = await getDb().get(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN (status = 'failed'
            AND COALESCE(json_extract(outcome, '$.failureCategory'), '') NOT IN (${PRE_WORK_FAILURE_CATEGORIES_SQL}))
          OR (status = 'completed' AND COALESCE(CAST(json_extract(outcome, '$.commits') AS INTEGER), 0) = 0)
          THEN 1 ELSE 0 END), 0) AS unproductive,
        COALESCE(SUM(CASE WHEN status = 'failed'
          AND json_extract(outcome, '$.failureCategory') IN (${PRE_WORK_FAILURE_CATEGORIES_SQL})
          THEN 1 ELSE 0 END), 0) AS "preWorkFailed",
        COALESCE(SUM(CASE WHEN status = 'failed'
          AND json_extract(outcome, '$.failureCategory') IN (${PRE_WORK_FAILURE_CATEGORIES_SQL})
          AND datetime(started_at) >= datetime(?)
          THEN 1 ELSE 0 END), 0) AS "recentPreWorkFailed"
      FROM tasks
      WHERE job_name = 'ci-fixer:merge-conflict'
        AND repo = ?
        AND item_number = ?
        AND datetime(started_at) >= datetime(?)
    `, [backoffCutoff, repo, refParam(prNumber), cutoff]) as { total: number; unproductive: number; preWorkFailed: number; recentPreWorkFailed: number };
  return result;
}

/**
 * Get recent CI fixer error messages for a PR.
 * Used to provide context when marking a PR as problematic.
 */
export async function getRecentCIFixerErrors(
  repo: string,
  prNumber: number,
  limit: number = 5,
): Promise<Array<{ error: string; timestamp: string }>> {
  return await getDb().all(`
      SELECT error, completed_at as timestamp
      FROM tasks
      WHERE (job_name = 'ci-fixer' OR job_name LIKE 'ci-fixer:%')
        AND repo = ?
        AND item_number = ?
        AND status = 'failed'
        AND error IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT ?
    `, [repo, refParam(prNumber), limit]) as Array<{ error: string; timestamp: string }>;
}

