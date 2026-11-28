// pr-reviewer verdicts (`pr_reviews`): recording, addressing, listing and
// the boot-time backfill. Reached only through the src/db.ts façade.
import type { ModelTierName } from "../config.js";
import * as log from "../log.js";
import { recordGitHubEvent } from "../github-events.js";
import { reviewVerdictPassesMerge } from "../gate-events.js";
import { canonicalIssueRef } from "../issue-id.js";
import { getDb, nowSql, sqlTimeToIso, timedDb } from "./core.js";
// Not yet split out of the façade (#clw_01M8A3RZ47A1W7E28W43TAFJ3G PR 3–4).
import { getClawsPr } from "../db.js";
import type { TaskOutcome } from "./tasks.js";

/** Verdict of a completed pr-reviewer round — the `TaskOutcome.reviewResult` union. */
export type PRReviewVerdict = NonNullable<TaskOutcome["reviewResult"]>;

export interface PRReviewRecord {
  id: number;
  repo: string;
  prNumber: number;
  /** Full head SHA recorded for the round — the PR's head once the round finished, which on
   * an advisory self-fix round is the commit the reviewer pushed, not what the model reviewed
   * (see `reviewedSha`). */
  headSha: string;
  /** The commit the model actually reviewed. Equal to `headSha` except on an advisory
   * self-fix round, where it is the pre-fix commit — the correct start of the next
   * incremental delta, so the fix itself is not silently skipped. `null` for rows that
   * predate this column (backfilled rows; treat as `headSha`). */
  reviewedSha: string | null;
  /** `git merge-base origin/<base> HEAD` at review time; `''` for backfilled rows. */
  baseSha: string;
  verdict: PRReviewVerdict;
  mode: "full" | "incremental";
  iteration: number;
  reviewerTaskId: number | null;
  provider: string | null;
  model: string | null;
  /** The full review text, stored whole (no cap) so the addresser always gets every finding. */
  findings: string | null;
  /** The reviewer's `recommended-model:` tier for the addresser, parsed from the model's
   * output when the round was recorded; null when the round recorded none (clean,
   * empty-diff and backfilled rounds). */
  recommendedModel: ModelTierName | null;
  /** ISO-8601 UTC timestamp. */
  createdAt: string;
  /** When the review-addresser handled this round; null while it is still pending. */
  addressedAt: string | null;
  /** The head the addresser left the PR at when it handled this round. */
  addressedSha: string | null;
  /** True when the addresser declined the round's findings (pushed nothing) — the reviewer reconsiders. */
  rebutted: boolean;
  /** The addresser's justification when `rebutted`; null otherwise. */
  rebuttal: string | null;
  /** The summary the addresser posted for this round, without the comment marker; null
   * when it posted none. Kept across a same-head re-review so a rebuttal's summary
   * survives the reviewer reconsidering it; the next addresser round overwrites it. */
  addresserSummary: string | null;
  /** The commit of the round's single advisory fix (addresser or reviewer self-fix); the one-shot guard. */
  advisoryAddressedSha: string | null;
}

/** Addresser state columns are written by `markPRReviewAddressed` / `markPRReviewAdvisoryAddressed`, never by `recordPRReview`. */
export type PRReviewInput = Omit<PRReviewRecord, "id" | "createdAt" | "addressedAt" | "addressedSha" | "rebutted" | "rebuttal" | "addresserSummary" | "advisoryAddressedSha" | "recommendedModel"> & {
  recommendedModel?: ModelTierName | null;
};

interface PRReviewRow {
  id: number;
  repo: string;
  pr_number: number;
  head_sha: string;
  reviewed_sha: string | null;
  base_sha: string;
  verdict: string;
  mode: string;
  iteration: number;
  reviewer_task_id: number | null;
  provider: string | null;
  model: string | null;
  findings: string | null;
  created_at: string;
  addressed_at: string | null;
  addressed_sha: string | null;
  rebutted: number | boolean | null;
  rebuttal: string | null;
  advisory_addressed_sha: string | null;
  addresser_summary: string | null;
  recommended_model: string | null;
}

const PR_REVIEW_MODEL_TIERS: readonly (string | null)[] = ["fable", "opus", "sonnet", "haiku"] satisfies ModelTierName[];

function toPRReviewRecord(row: PRReviewRow): PRReviewRecord {
  return {
    id: Number(row.id),
    repo: row.repo,
    prNumber: Number(row.pr_number),
    headSha: row.head_sha,
    reviewedSha: row.reviewed_sha,
    baseSha: row.base_sha,
    verdict: row.verdict as PRReviewVerdict,
    mode: row.mode === "incremental" ? "incremental" : "full",
    iteration: Number(row.iteration),
    reviewerTaskId: row.reviewer_task_id === null ? null : Number(row.reviewer_task_id),
    provider: row.provider,
    model: row.model,
    findings: row.findings,
    recommendedModel: PR_REVIEW_MODEL_TIERS.includes(row.recommended_model as ModelTierName) ? row.recommended_model as ModelTierName : null,
    createdAt: sqlTimeToIso(row.created_at),
    addressedAt: sqlTimeToIso(row.addressed_at ?? null),
    addressedSha: row.addressed_sha ?? null,
    rebutted: Number(row.rebutted ?? 0) !== 0,
    rebuttal: row.rebuttal ?? null,
    addresserSummary: row.addresser_summary ?? null,
    advisoryAddressedSha: row.advisory_addressed_sha ?? null,
  };
}

/**
 * Record a completed review round. Re-reviewing the same head (a rebuttal round)
 * overwrites its row and resets the addresser state (`addressed_*`, `rebutted`,
 * `rebuttal`) so the new verdict is handed off afresh. `addresser_summary` is
 * kept: it is the record of the disagreement the doc-maintainer reads once the
 * PR merges, and nothing gates on it (`rebutted` alone re-fires the reviewer). `advisory_addressed_sha`
 * is the advisory fix one-shot, which is per PR: a new head's row inherits the
 * PR's latest stamp, and a same-head re-review keeps its own.
 */
export async function recordPRReview(input: PRReviewInput): Promise<void> {
  await getDb().run(`
      INSERT INTO pr_reviews
        (repo, pr_number, head_sha, reviewed_sha, base_sha, verdict, mode, iteration, reviewer_task_id, provider, model, findings, recommended_model, created_at, advisory_addressed_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (
        SELECT prev.advisory_addressed_sha FROM pr_reviews prev
        WHERE prev.repo = ? AND prev.pr_number = ? AND prev.advisory_addressed_sha IS NOT NULL
        ORDER BY prev.created_at DESC, prev.id DESC
        LIMIT 1
      ))
      ON CONFLICT(repo, pr_number, head_sha) DO UPDATE SET
        reviewed_sha = excluded.reviewed_sha,
        base_sha = excluded.base_sha,
        verdict = excluded.verdict,
        mode = excluded.mode,
        iteration = excluded.iteration,
        reviewer_task_id = excluded.reviewer_task_id,
        provider = excluded.provider,
        model = excluded.model,
        findings = excluded.findings,
        recommended_model = excluded.recommended_model,
        created_at = excluded.created_at,
        addressed_at = NULL,
        addressed_sha = NULL,
        rebutted = 0,
        rebuttal = NULL,
        advisory_addressed_sha = COALESCE(pr_reviews.advisory_addressed_sha, excluded.advisory_addressed_sha)
    `, [
      input.repo,
      input.prNumber,
      input.headSha,
      input.reviewedSha,
      input.baseSha,
      input.verdict,
      input.mode,
      input.iteration,
      input.reviewerTaskId,
      input.provider,
      input.model,
      input.findings,
      input.recommendedModel ?? null,
      nowSql(),
      input.repo,
      input.prNumber,
    ]);
  // `review-posted` carries the verdict, so a waiter acts without fetching the
  // review comment; the PR's issue rides in `related`.
  let issueId: string | null = null;
  try {
    issueId = (await getClawsPr(input.repo, input.prNumber))?.issueId ?? null;
  } catch (err) {
    log.warn(`recordPRReview: could not read ${input.repo}#${input.prNumber}'s issue: ${err}`);
  }
  const issueRef = issueId ? canonicalIssueRef(issueId) : null;
  recordGitHubEvent({
    kind: "review-posted",
    repo: input.repo,
    number: input.prNumber,
    related: issueRef === null || issueRef === 0 ? [] : [issueRef],
    detail: reviewPostedDetail(input.verdict),
  });
}

/**
 * Mark the review round at `headSha` handled by the review-addresser. `rebutted`
 * records that it declined the findings, with its justification in `rebuttal`,
 * so the reviewer reconsiders at the same head. `summary` is the comment the
 * addresser posted (null when it posted none), handed back to the reviewer and
 * the doc-maintainer. A no-op when no row exists for
 * that head (the round was superseded).
 */
export async function markPRReviewAddressed(
  repo: string,
  prNumber: number,
  headSha: string,
  state: { addressedSha: string; rebutted: boolean; rebuttal: string | null; summary: string | null },
): Promise<void> {
  const result = await getDb().run(`
      UPDATE pr_reviews
      SET addressed_at = ?, addressed_sha = ?, rebutted = ?, rebuttal = ?, addresser_summary = ?
      WHERE repo = ? AND pr_number = ? AND head_sha = ?
    `, [nowSql(), state.addressedSha, state.rebutted ? 1 : 0, state.rebutted ? state.rebuttal : null, state.summary, repo, prNumber, headSha]);
  log.info("PR review round marked addressed", {
    repo,
    pr: prNumber,
    head_sha: headSha,
    action: state.rebutted ? "rebutted" : "addressed",
    addressed_sha: state.addressedSha,
    updated: result.changes,
  });
}

/**
 * Record the one advisory fix round for the review round at `headSha` — the
 * one-shot guard that stops another advisory fix on this PR. A no-op when no
 * row exists for that head.
 */
export async function markPRReviewAdvisoryAddressed(repo: string, prNumber: number, headSha: string, sha: string): Promise<void> {
  const result = await getDb().run(`
      UPDATE pr_reviews SET advisory_addressed_sha = ?
      WHERE repo = ? AND pr_number = ? AND head_sha = ?
    `, [sha, repo, prNumber, headSha]);
  log.info("PR review round marked advisory-addressed", {
    repo,
    pr: prNumber,
    head_sha: headSha,
    action: "advisory-addressed",
    advisory_addressed_sha: sha,
    updated: result.changes,
  });
}

/** A review verdict as `review-posted`'s detail: `clean` when it does not block the merge, else `blocking`. */
export function reviewPostedDetail(verdict: PRReviewVerdict): "clean" | "blocking" {
  return reviewVerdictPassesMerge(verdict) ? "clean" : "blocking";
}

/**
 * Newest first by `created_at`, then `id`. `created_at` leads so a rebuttal
 * re-review (an upsert of an existing, lower-id row) and backfilled rows (whose
 * insertion order does not follow review order) still sort chronologically.
 */
export async function listPRReviews(repo: string, prNumber: number, limit = 5): Promise<PRReviewRecord[]> {
  const rows = await getDb().all(`
      SELECT * FROM pr_reviews
      WHERE repo = ? AND pr_number = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `, [repo, prNumber, limit]) as PRReviewRow[];
  return rows.map(toPRReviewRecord);
}

/** The most recent completed review round for a PR, or null if none is recorded. */
export async function getLatestPRReview(repo: string, prNumber: number): Promise<PRReviewRecord | null> {
  return (await listPRReviews(repo, prNumber, 1))[0] ?? null;
}

/**
 * Seed `pr_reviews` from the observability rows written before the table
 * existed: `pr-review` effectiveness events, then completed pr-reviewer task
 * outcomes carrying both `headSha` and `reviewResult`. Backfilled rows get
 * `base_sha = ''`, so the next round on those PRs is always a full review.
 *
 * One-shot: skipped once `pr_reviews` holds any row. Running this on every
 * boot would let it race live writes — a self-fix round's `pr_reviews` row
 * and its effectiveness event (recorded on the pre-fix SHA) can have the same
 * `created_at` ordering, so a later backfill can insert a same-`created_at`
 * phantom row for the pre-fix event that outranks the live row in
 * `listPRReviews`'s `created_at DESC, id DESC` order.
 */
export async function backfillPRReviews(): Promise<void> {
  return timedDb("backfill-p-r-reviews", () => backfillPRReviewsUntimed());
}

async function backfillPRReviewsUntimed(): Promise<void> {
  try {
    const existing = await getDb().get(`SELECT 1 FROM pr_reviews LIMIT 1`);
    if (existing) return;
    await getDb().run(`
      INSERT INTO pr_reviews
        (repo, pr_number, head_sha, reviewed_sha, base_sha, verdict, mode, iteration, reviewer_task_id, provider, model, findings, created_at)
      SELECT
        e.source_repo,
        e.source_number,
        e.source_sha,
        NULL,
        '',
        CASE e.signal
          WHEN 'pr-review-clean' THEN 'clean'
          WHEN 'pr-review-advisory' THEN 'advisory'
          WHEN 'pr-review-blocking' THEN 'blocking'
          WHEN 'pr-review-escalated' THEN 'escalated'
          ELSE 'empty-diff'
        END,
        'full',
        COALESCE(CAST(json_extract(e.details, '$.iteration') AS INTEGER), 1),
        CAST(json_extract(e.details, '$.reviewerTaskId') AS INTEGER),
        t.provider_used,
        t.model_used,
        NULL,
        e.created_at
      FROM task_effectiveness_events e
      LEFT JOIN tasks t ON t.id = CAST(json_extract(e.details, '$.reviewerTaskId') AS INTEGER)
      WHERE e.source = 'pr-review'
        AND e.source_sha <> ''
        AND e.signal IN ('pr-review-clean', 'pr-review-advisory', 'pr-review-blocking', 'pr-review-escalated', 'pr-review-empty-diff')
        AND NOT EXISTS (
          SELECT 1 FROM pr_reviews p
          WHERE p.reviewer_task_id = CAST(json_extract(e.details, '$.reviewerTaskId') AS INTEGER)
        )
      ORDER BY e.created_at, e.id
      ON CONFLICT(repo, pr_number, head_sha) DO NOTHING
    `);
    await getDb().run(`
      INSERT INTO pr_reviews
        (repo, pr_number, head_sha, reviewed_sha, base_sha, verdict, mode, iteration, reviewer_task_id, provider, model, findings, created_at)
      SELECT
        repo,
        CAST(json_extract(outcome, '$.prNumber') AS INTEGER),
        json_extract(outcome, '$.headSha'),
        NULL,
        '',
        json_extract(outcome, '$.reviewResult'),
        'full',
        COALESCE(CAST(json_extract(outcome, '$.reviewIteration') AS INTEGER), 1),
        id,
        provider_used,
        model_used,
        NULL,
        COALESCE(completed_at, started_at)
      FROM tasks
      WHERE job_name = 'pr-reviewer'
        AND status = 'completed'
        AND outcome IS NOT NULL
        AND json_extract(outcome, '$.headSha') IS NOT NULL
        AND json_extract(outcome, '$.reviewResult') IS NOT NULL
        AND json_extract(outcome, '$.prNumber') IS NOT NULL
      ORDER BY completed_at, id
      ON CONFLICT(repo, pr_number, head_sha) DO NOTHING
    `);
  } catch (err) {
    log.warn(`backfillPRReviews failed: ${err}`);
  }
}

