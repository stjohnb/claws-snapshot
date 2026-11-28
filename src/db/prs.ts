// The PR state store (`claws_prs`) and PR changed files (`claws_pr_files`).
// Reached only through the src/db.ts façade.
import * as log from "../log.js";
import { evaluatePrGates } from "../gate-events.js";
import { type IssueRef, refFromColumn } from "../issue-id.js";
import { AGENT_KINDS } from "../work-order.js";
import { DAY_MS, getDb, nowSql, nowSqlOffsetMs, sqlTimeToIso, timedDb } from "./core.js";
import { parsePlannedPaths } from "./issue-plans.js";

// ── PR state store (`claws_prs`) ──

/** `claws_prs.stage` — docs/refinements/issue-flow.md "Pull request state". */
export type ClawsPrStage =
  | "opened"
  | "ci-failing"
  | "awaiting-review"
  | "addressing-review"
  | "awaiting-merge"
  | "problematic"
  | "merged"
  | "closed";

/** `claws_prs.issue_relation`: whether merging the PR closes its issue or is one step of it. */
export type ClawsPrIssueRelation = "closes" | "part-of";

/** One `claws_prs` row. Timestamps are ISO-8601 UTC. */
export interface ClawsPrRecord {
  repo: string;
  prNumber: number;
  issueId: string | null;
  phase: number | null;
  headSha: string | null;
  observedAt: string | null;
  stage: ClawsPrStage;
  /** `passing`, `failing`, `pending`, or `none` for a repo with no CI. */
  ciStatus: string | null;
  mergeableState: string | null;
  reviewVerdict: string | null;
  reviewedSha: string | null;
  mergeApprovedBy: string | null;
  mergeApprovedAt: string | null;
  manualActionReason: string | null;
  needsHumanReview: boolean;
  ciBlockedReason: string | null;
  /** Who approved this infrastructure PR's merge from the board; see `infraMergeApproval` in `pr-state.ts`. */
  infraMergeApprovedBy: string | null;
  /** When the infra merge approval was given. */
  infraMergeApprovedAt: string | null;
  /** The PR head the infra merge approval was given for; it counts only while this is the live head. */
  infraMergeApprovedSha: string | null;
  /**
   * JSON `InfraMergeApprovedEvidence` (`pr-state.ts`) recorded with the approval:
   * the plan fingerprint and tofu workflow digest a later head is compared to.
   */
  infraMergeApprovedEvidence?: string | null;
  /** The later head the infra merge approval was carried over to as plan-neutral. */
  infraMergeCarriedSha?: string | null;
  /** Why the approval was carried over, for the board card. */
  infraMergeCarriedNote?: string | null;
  /**
   * Automatic updates of the branch onto its base the auto-merger made under
   * the current infra merge approval (budget 2); a new approval resets it.
   */
  infraBranchUpdates?: number | null;
  /** The head the last automatic infra branch update produced; null when it could not be read. */
  infraBranchUpdateSha?: string | null;
  /** The head the last automatic infra branch update started from. */
  infraBranchUpdateFromSha?: string | null;
  /** The PR's forge title; null until Claws opens it or the dispatcher refreshes it. */
  title: string | null;
  /**
   * Whether merging the PR finishes the issue it belongs to (`closes`) or is one
   * step of several (`part-of`); null when unrecorded, so readers fall back to
   * the PR body. See src/pr-issue-relation.ts.
   */
  issueRelation?: ClawsPrIssueRelation | null;
  /** The issue ref the PR's `Closes` / `Part of` line names (`clw_…` or a forge number), as text. */
  issueRef?: string | null;
  /** How many steps the plan had when the relation was recorded. */
  planSteps?: number | null;
  /** Other issue refs merging the PR closes (duplicates, a target-PR push's issue). */
  alsoCloses?: string[] | null;
  /** Why the dispatcher or a work handler last left the PR alone; written only by {@link setClawsPrDispatchNote}. */
  dispatchNote: string | null;
  /** When `dispatchNote` was recorded. */
  dispatchNoteAt: string | null;
  /** The auto-merger's last skip code (`MergeSkipCode`); written only by {@link setClawsPrMergeSkip}. */
  mergeSkipCode?: string | null;
  /** The human-readable reason for `mergeSkipCode`. */
  mergeSkipReason?: string | null;
  /** The PR head the skip was decided on; the skip counts only while this is the row's `headSha`. */
  mergeSkipHead?: string | null;
  /** When the skip was recorded (ISO). */
  mergeSkipAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The writable columns of a `claws_prs` row; every key is optional. */
export type ClawsPrPatch = Partial<Omit<ClawsPrRecord, "repo" | "prNumber" | "createdAt" | "updatedAt" | "dispatchNote" | "dispatchNoteAt"
  | "mergeSkipCode" | "mergeSkipReason" | "mergeSkipHead" | "mergeSkipAt">>;

interface ClawsPrRow {
  repo: string;
  pr_number: unknown;
  issue_id: string | null;
  phase: unknown;
  head_sha: string | null;
  observed_at: string | null;
  stage: string;
  ci_status: string | null;
  mergeable_state: string | null;
  review_verdict: string | null;
  reviewed_sha: string | null;
  merge_approved_by: string | null;
  merge_approved_at: string | null;
  manual_action_reason: string | null;
  needs_human_review: unknown;
  ci_blocked_reason: string | null;
  infra_merge_approved_by?: string | null;
  infra_merge_approved_at?: string | null;
  infra_merge_approved_sha?: string | null;
  infra_merge_approved_evidence?: string | null;
  infra_merge_carried_sha?: string | null;
  infra_merge_carried_note?: string | null;
  infra_branch_updates?: number | string | null;
  infra_branch_update_sha?: string | null;
  infra_branch_update_from_sha?: string | null;
  title: string | null;
  issue_relation?: string | null;
  issue_ref?: string | null;
  plan_steps?: unknown;
  also_closes?: string | null;
  dispatch_note: string | null;
  dispatch_note_at: string | null;
  merge_skip_code?: string | null;
  merge_skip_reason?: string | null;
  merge_skip_head?: string | null;
  merge_skip_at?: string | null;
  created_at: string;
  updated_at: string;
}

const CLAWS_PR_COLUMNS: Record<keyof ClawsPrPatch, string> = {
  issueId: "issue_id",
  phase: "phase",
  headSha: "head_sha",
  observedAt: "observed_at",
  stage: "stage",
  ciStatus: "ci_status",
  mergeableState: "mergeable_state",
  reviewVerdict: "review_verdict",
  reviewedSha: "reviewed_sha",
  mergeApprovedBy: "merge_approved_by",
  mergeApprovedAt: "merge_approved_at",
  manualActionReason: "manual_action_reason",
  needsHumanReview: "needs_human_review",
  ciBlockedReason: "ci_blocked_reason",
  infraMergeApprovedBy: "infra_merge_approved_by",
  infraMergeApprovedAt: "infra_merge_approved_at",
  infraMergeApprovedSha: "infra_merge_approved_sha",
  infraMergeApprovedEvidence: "infra_merge_approved_evidence",
  infraMergeCarriedSha: "infra_merge_carried_sha",
  infraMergeCarriedNote: "infra_merge_carried_note",
  infraBranchUpdates: "infra_branch_updates",
  infraBranchUpdateSha: "infra_branch_update_sha",
  infraBranchUpdateFromSha: "infra_branch_update_from_sha",
  title: "title",
  issueRelation: "issue_relation",
  issueRef: "issue_ref",
  planSteps: "plan_steps",
  alsoCloses: "also_closes",
};

function parseAlsoCloses(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : null;
  } catch {
    return null;
  }
}

function toClawsPrRecord(row: ClawsPrRow): ClawsPrRecord {
  return {
    repo: row.repo,
    prNumber: Number(row.pr_number),
    issueId: row.issue_id ?? null,
    phase: row.phase === null || row.phase === undefined ? null : Number(row.phase),
    headSha: row.head_sha ?? null,
    observedAt: sqlTimeToIso(row.observed_at),
    stage: row.stage as ClawsPrStage,
    ciStatus: row.ci_status ?? null,
    mergeableState: row.mergeable_state ?? null,
    reviewVerdict: row.review_verdict ?? null,
    reviewedSha: row.reviewed_sha ?? null,
    mergeApprovedBy: row.merge_approved_by ?? null,
    mergeApprovedAt: sqlTimeToIso(row.merge_approved_at),
    manualActionReason: row.manual_action_reason ?? null,
    needsHumanReview: Number(row.needs_human_review) === 1,
    ciBlockedReason: row.ci_blocked_reason ?? null,
    infraMergeApprovedBy: row.infra_merge_approved_by ?? null,
    infraMergeApprovedAt: sqlTimeToIso(row.infra_merge_approved_at ?? null),
    infraMergeApprovedSha: row.infra_merge_approved_sha ?? null,
    infraMergeApprovedEvidence: row.infra_merge_approved_evidence ?? null,
    infraMergeCarriedSha: row.infra_merge_carried_sha ?? null,
    infraMergeCarriedNote: row.infra_merge_carried_note ?? null,
    infraBranchUpdates: row.infra_branch_updates == null ? null : Number(row.infra_branch_updates),
    infraBranchUpdateSha: row.infra_branch_update_sha ?? null,
    infraBranchUpdateFromSha: row.infra_branch_update_from_sha ?? null,
    title: row.title ?? null,
    issueRelation: row.issue_relation === "closes" || row.issue_relation === "part-of" ? row.issue_relation : null,
    issueRef: row.issue_ref ?? null,
    planSteps: row.plan_steps === null || row.plan_steps === undefined ? null : Number(row.plan_steps),
    alsoCloses: parseAlsoCloses(row.also_closes),
    dispatchNote: row.dispatch_note ?? null,
    dispatchNoteAt: sqlTimeToIso(row.dispatch_note_at ?? null),
    mergeSkipCode: row.merge_skip_code ?? null,
    mergeSkipReason: row.merge_skip_reason ?? null,
    mergeSkipHead: row.merge_skip_head ?? null,
    mergeSkipAt: sqlTimeToIso(row.merge_skip_at ?? null),
    createdAt: sqlTimeToIso(row.created_at),
    updatedAt: sqlTimeToIso(row.updated_at),
  };
}

/**
 * Columns the PR dispatcher re-observes from the forge every tick. An update
 * that writes only these leaves `updated_at` alone, so it keeps marking the
 * last state change — the dispatcher's reconcile relies on that.
 */
const CLAWS_PR_OBSERVED_KEYS: ReadonlySet<keyof ClawsPrPatch> = new Set([
  "headSha", "observedAt", "ciStatus", "mergeableState", "reviewVerdict", "reviewedSha", "title",
]);

/**
 * Insert or update the `claws_prs` row for `(repo, prNumber)`. Only the keys
 * present in `patch` are written — an insert leaves the rest at their column
 * defaults, an update leaves them untouched. `updated_at` moves on an insert
 * and on any update that writes a state column; an update of observed columns
 * only ({@link CLAWS_PR_OBSERVED_KEYS}) leaves it alone.
 * Timestamps in the patch are stored in the `nowSql()` form. Then re-reads the
 * row and evaluates its gate events (`evaluatePrGates`), best-effort.
 */
export async function upsertClawsPr(repo: string, prNumber: number, patch: ClawsPrPatch): Promise<void> {
  const keys = (Object.keys(patch) as (keyof ClawsPrPatch)[])
    .filter((k) => k in CLAWS_PR_COLUMNS && patch[k] !== undefined);
  const columns = keys.map((k) => CLAWS_PR_COLUMNS[k]);
  const values = keys.map((k) => {
    const v = patch[k];
    if (typeof v === "boolean") return v ? 1 : 0;
    if (k === "alsoCloses") return Array.isArray(v) ? JSON.stringify(v) : null;
    if ((k === "observedAt" || k === "mergeApprovedAt" || k === "infraMergeApprovedAt") && typeof v === "string") {
      return v.slice(0, 19).replace("T", " ");
    }
    return v as string | number | null;
  });
  const now = nowSql();
  const updates = columns.map((c) => `${c} = excluded.${c}`);
  const observedOnly = keys.length > 0 && keys.every((k) => CLAWS_PR_OBSERVED_KEYS.has(k));
  if (!observedOnly) updates.push("updated_at = excluded.updated_at");
  // The first time the row reaches `merged` or `problematic`; never moved or cleared after.
  const milestone = patch.stage === "merged" ? "merged_at" : patch.stage === "problematic" ? "problematic_at" : null;
  if (milestone) {
    columns.push(milestone);
    values.push(now);
    updates.push(`${milestone} = COALESCE(claws_prs.${milestone}, excluded.${milestone})`);
  }
  await getDb().run(
    `INSERT INTO claws_prs (repo, pr_number${columns.map((c) => `, ${c}`).join("")}, created_at, updated_at)
     VALUES (?, ?${columns.map(() => ", ?").join("")}, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET ${updates.join(", ")}`,
    [repo, prNumber, ...values, now, now],
  );
  try {
    const row = await getClawsPr(repo, prNumber);
    if (row) void evaluatePrGates(row);
  } catch (err) {
    log.warn(`upsertClawsPr: could not re-read ${repo}#${prNumber} for its gate events: ${err}`);
  }
}

/**
 * Fill `claws_prs.merged_at` and `problematic_at` where they are NULL: a
 * merged row's `merged_at` from its `updated_at`, and `problematic_at` from the
 * row's first `ci-fixer:problematic` task, else its `updated_at` while it is
 * still `problematic`. Idempotent; run by `migrateSchema` every boot. Returns
 * the rows changed.
 */
export async function backfillClawsPrMilestones(): Promise<number> {
  const merged = await getDb().run(
    `UPDATE claws_prs SET merged_at = updated_at WHERE stage = 'merged' AND merged_at IS NULL`,
  );
  const problematic = await getDb().run(
    `UPDATE claws_prs SET problematic_at = COALESCE(
        (SELECT MIN(t.started_at) FROM tasks t
          WHERE t.job_name = 'ci-fixer:problematic' AND t.repo = claws_prs.repo
            AND CAST(t.item_number AS TEXT) = CAST(claws_prs.pr_number AS TEXT)),
        CASE WHEN claws_prs.stage = 'problematic' THEN claws_prs.updated_at END)
      WHERE problematic_at IS NULL
        AND (stage = 'problematic' OR EXISTS (SELECT 1 FROM tasks t
          WHERE t.job_name = 'ci-fixer:problematic' AND t.repo = claws_prs.repo
            AND CAST(t.item_number AS TEXT) = CAST(claws_prs.pr_number AS TEXT)))`,
  );
  return Number(merged.changes) + Number(problematic.changes);
}

/**
 * Withdraw the merge approval on each of `rows` that holds one: null
 * `merge_approved_by` / `merge_approved_at` and any board infra merge approval,
 * through {@link upsertClawsPr} so the gate events still fire. Returns how many
 * rows it cleared. The one rule for every write that takes an issue below
 * Merge — `applyIssueApproval`'s lowering and the demotion to Ideas.
 */
export async function clearPrMergeApprovals(rows: readonly ClawsPrRecord[]): Promise<number> {
  let cleared = 0;
  for (const pr of rows) {
    if (!pr.mergeApprovedAt && !pr.infraMergeApprovedAt) continue;
    await upsertClawsPr(pr.repo, pr.prNumber, {
      mergeApprovedBy: null,
      mergeApprovedAt: null,
      infraMergeApprovedBy: null,
      infraMergeApprovedAt: null,
      infraMergeApprovedSha: null,
      infraMergeApprovedEvidence: null,
      infraMergeCarriedSha: null,
      infraMergeCarriedNote: null,
      infraBranchUpdates: null,
      infraBranchUpdateSha: null,
      infraBranchUpdateFromSha: null,
    });
    cleared++;
  }
  return cleared;
}

/**
 * Record (or clear, with null) why the dispatcher or a work handler left a PR
 * alone. Updates an existing row only — the dispatcher seeds one for every
 * open PR — and leaves `updated_at` alone: a note is not a state change.
 */
export async function setClawsPrDispatchNote(repo: string, prNumber: number, note: string | null): Promise<void> {
  await getDb().run(
    `UPDATE claws_prs SET dispatch_note = ?, dispatch_note_at = ? WHERE repo = ? AND pr_number = ?`,
    [note, note === null ? null : nowSql(), repo, prNumber],
  );
}

/** The auto-merger's last reason for leaving a PR unmerged, for {@link setClawsPrMergeSkip}. */
export interface ClawsPrMergeSkip {
  code: string;
  reason: string;
  head: string | null;
}

/**
 * Record (or clear, with null) the auto-merger's last skip on a PR, so the
 * web tier can read it (`pr-attention.ts`). Updates an existing row only and
 * leaves `updated_at` alone: a skip is an observation, not a state change.
 */
export async function setClawsPrMergeSkip(repo: string, prNumber: number, skip: ClawsPrMergeSkip | null): Promise<void> {
  await getDb().run(
    `UPDATE claws_prs SET merge_skip_code = ?, merge_skip_reason = ?, merge_skip_head = ?, merge_skip_at = ? WHERE repo = ? AND pr_number = ?`,
    [skip?.code ?? null, skip?.reason ?? null, skip?.head ?? null, skip ? nowSql() : null, repo, prNumber],
  );
}

export async function getClawsPr(repo: string, prNumber: number): Promise<ClawsPrRecord | null> {
  const row = await getDb().get(
    `SELECT * FROM claws_prs WHERE repo = ? AND pr_number = ?`,
    [repo, prNumber],
  ) as ClawsPrRow | undefined;
  return row ? toClawsPrRecord(row) : null;
}

/** Every `claws_prs` row for `repo`, by PR number; `openOnly` drops `merged`/`closed`. */
export async function listClawsPrs(repo: string, opts?: { openOnly?: boolean }): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    opts?.openOnly
      ? `SELECT * FROM claws_prs WHERE repo = ? AND stage NOT IN ('merged', 'closed') ORDER BY pr_number ASC`
      : `SELECT * FROM claws_prs WHERE repo = ? ORDER BY pr_number ASC`,
    [repo],
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

// ── PR number reuse (#clw_01M8BKXWPM0DN8QWB29S4684P5) ──

/**
 * How far before a forge PR's `created_at` a stored record must date to be
 * taken for an earlier PR that used the same number. Covers clock skew
 * between the forge and Claws: a fresh record is never written before its PR.
 */
export const PR_REUSE_FENCE_MS = 5 * 60_000;

/** What {@link retireReusedPrNumber} discarded. */
export interface RetiredPrNumber {
  /** Whether anything at all was deleted or unlinked. */
  retired: boolean;
  /** Whether the stale `claws_prs` row was deleted. */
  rowDropped: boolean;
  /** The dropped row's issue, approver and hold; null when no row was dropped. */
  issueId: string | null;
  mergeApprovedBy: string | null;
  manualActionReason: string | null;
  counts: { reviews: number; files: number; sessionActions: number; breaker: number; stepLinks: number };
}

/**
 * Discard every stored record of `repo#prNumber` that predates the forge PR
 * now holding that number: the forge reused the number (e.g. Forgejo's
 * numbering restarted after a move from GitHub), so the record belongs to an
 * earlier PR. A record is stale when it was created more than
 * {@link PR_REUSE_FENCE_MS} before `prCreatedAt`; an unparseable
 * `prCreatedAt` retires nothing.
 *
 * Deletes the stale `claws_prs` row, `pr_reviews` and `session_pr_actions`
 * rows (by `created_at`) and `claws_pr_files` rows (by `fetched_at`), and the
 * `ci_fixer_breaker` row when a stale `claws_prs` row was found or
 * `unlinkAllSteps` is set. Clears `claws_issue_prs.pr_number` /
 * `target_pr_number` equal to the number in `repo`: for every issue with
 * `unlinkAllSteps` (Claws itself just opened the PR, so no step can link it
 * yet), otherwise only for issues closed before the fence. Times are compared
 * in JS, since `prCreatedAt` may carry an offset and stored formats differ.
 */
export async function retireReusedPrNumber(
  repo: string,
  prNumber: number,
  prCreatedAt: string,
  opts: { unlinkAllSteps?: boolean } = {},
): Promise<RetiredPrNumber> {
  const out: RetiredPrNumber = {
    retired: false, rowDropped: false, issueId: null, mergeApprovedBy: null, manualActionReason: null,
    counts: { reviews: 0, files: 0, sessionActions: 0, breaker: 0, stepLinks: 0 },
  };
  const created = Date.parse(prCreatedAt);
  if (!Number.isFinite(created)) return out;
  const fence = created - PR_REUSE_FENCE_MS;
  const stale = (value: string | null | undefined): boolean => {
    if (!value) return false;
    const t = Date.parse(sqlTimeToIso(String(value)));
    return Number.isFinite(t) && t < fence;
  };
  const db = getDb();

  const row = await db.get(
    `SELECT created_at, issue_id, merge_approved_by, manual_action_reason FROM claws_prs WHERE repo = ? AND pr_number = ?`,
    [repo, prNumber],
  ) as { created_at: string; issue_id: string | null; merge_approved_by: string | null; manual_action_reason: string | null } | undefined;
  if (row && stale(row.created_at)) {
    await db.run(`DELETE FROM claws_prs WHERE repo = ? AND pr_number = ?`, [repo, prNumber]);
    out.rowDropped = true;
    out.issueId = row.issue_id ?? null;
    out.mergeApprovedBy = row.merge_approved_by ?? null;
    out.manualActionReason = row.manual_action_reason ?? null;
  }

  const reviews = await db.all(`SELECT id, created_at FROM pr_reviews WHERE repo = ? AND pr_number = ?`, [repo, prNumber]) as { id: number; created_at: string }[];
  for (const r of reviews.filter((r) => stale(r.created_at))) {
    out.counts.reviews += (await db.run(`DELETE FROM pr_reviews WHERE id = ?`, [r.id])).changes;
  }
  const actions = await db.all(`SELECT id, created_at FROM session_pr_actions WHERE repo = ? AND pr_number = ?`, [repo, prNumber]) as { id: number; created_at: string }[];
  for (const a of actions.filter((a) => stale(a.created_at))) {
    out.counts.sessionActions += (await db.run(`DELETE FROM session_pr_actions WHERE id = ?`, [a.id])).changes;
  }
  const files = await db.all(`SELECT head_sha, fetched_at FROM claws_pr_files WHERE repo = ? AND pr_number = ?`, [repo, prNumber]) as { head_sha: string; fetched_at: string }[];
  for (const f of files.filter((f) => stale(f.fetched_at))) {
    out.counts.files += (await db.run(
      `DELETE FROM claws_pr_files WHERE repo = ? AND pr_number = ? AND head_sha = ?`, [repo, prNumber, f.head_sha],
    )).changes;
  }
  if (out.rowDropped || opts.unlinkAllSteps) {
    out.counts.breaker = (await db.run(`DELETE FROM ci_fixer_breaker WHERE repo = ? AND item_number = ?`, [repo, prNumber])).changes;
  }

  const steps = await db.all(
    `SELECT p.issue_id, p.position, i.closed_at FROM claws_issue_prs p JOIN claws_issues i ON i.id = p.issue_id
      WHERE p.repo = ? AND (p.pr_number = ? OR p.target_pr_number = ?)`,
    [repo, prNumber, prNumber],
  ) as { issue_id: string; position: number; closed_at: string | null }[];
  for (const s of steps) {
    if (!opts.unlinkAllSteps && !stale(s.closed_at)) continue;
    out.counts.stepLinks += (await db.run(
      `UPDATE claws_issue_prs
          SET pr_number = CASE WHEN pr_number = ? THEN NULL ELSE pr_number END,
              target_pr_number = CASE WHEN target_pr_number = ? THEN NULL ELSE target_pr_number END
        WHERE issue_id = ? AND position = ?`,
      [prNumber, prNumber, s.issue_id, s.position],
    )).changes;
  }

  const c = out.counts;
  out.retired = out.rowDropped || c.reviews + c.files + c.sessionActions + c.breaker + c.stepLinks > 0;
  return out;
}

// ── PR changed files (claws_pr_files, src/overlap-gate.ts) ──

/** Most paths stored for one PR head; the rest are dropped. */
export const PR_FILES_CAP = 5000;

/** The stored changed files of `repo#prNumber` at `headSha`, or null when none were stored for that head. */
export async function getClawsPrFiles(repo: string, prNumber: number, headSha: string): Promise<string[] | null> {
  const row = await getDb().get(
    `SELECT files FROM claws_pr_files WHERE repo = ? AND pr_number = ? AND head_sha = ?`,
    [repo, prNumber, headSha],
  ) as { files: string } | undefined;
  return row ? parsePrFiles(row.files) : null;
}

/** Stores `repo#prNumber`'s changed files at `headSha` (at most {@link PR_FILES_CAP}), replacing any stored for that head. */
export async function upsertClawsPrFiles(repo: string, prNumber: number, headSha: string, files: readonly string[]): Promise<void> {
  await getDb().run(
    `INSERT INTO claws_pr_files (repo, pr_number, head_sha, files, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo, pr_number, head_sha) DO UPDATE SET files = excluded.files, fetched_at = excluded.fetched_at`,
    [repo, prNumber, headSha, JSON.stringify(files.slice(0, PR_FILES_CAP)), nowSql()],
  );
}

/** Deletes the stored files of PRs whose `claws_prs` row merged or closed more than `retentionDays` ago. Returns the rows deleted. */
export async function pruneClawsPrFiles(retentionDays = 30): Promise<number> {
  return timedDb("prune-claws-pr-files", async () => {
    const result = await getDb().run(
      `DELETE FROM claws_pr_files WHERE EXISTS (
         SELECT 1 FROM claws_prs p WHERE p.repo = claws_pr_files.repo AND p.pr_number = claws_pr_files.pr_number
           AND p.stage IN ('merged', 'closed') AND p.updated_at < ?)`,
      [nowSqlOffsetMs(-retentionDays * DAY_MS)],
    );
    return result.changes;
  });
}

/** One merged PR's stored changed files, as the retrospective's hot-spot section reads them (`listMergedPrFiles`). */
export interface MergedPrFiles {
  repo: string;
  prNumber: number;
  files: string[];
}

/**
 * The stored changed files of every `claws_prs` row that merged in the last
 * `days` days (its `updated_at`, set when the row is finalised), one entry per
 * PR: the files stored for its final head, else its most recently read head.
 * A merged PR with no stored files is left out. Sorted by repo and PR number.
 */
export async function listMergedPrFiles(days = 14): Promise<MergedPrFiles[]> {
  return timedDb("list-merged-pr-files", async () => {
    const rows = await getDb().all(
      `SELECT p.repo, p.pr_number, p.head_sha, f.head_sha AS file_head, f.files, f.fetched_at
         FROM claws_prs p
         JOIN claws_pr_files f ON f.repo = p.repo AND f.pr_number = p.pr_number
        WHERE p.stage = 'merged' AND p.updated_at >= ?
        ORDER BY p.repo ASC, p.pr_number ASC, f.fetched_at DESC`,
      [nowSqlOffsetMs(-days * DAY_MS)],
    ) as Array<{ repo: string; pr_number: number | string; head_sha: string | null; file_head: string; files: string; fetched_at: string }>;
    const latest = new Map<string, { row: (typeof rows)[number]; final: boolean }>();
    for (const r of rows) {
      const key = `${r.repo}#${r.pr_number}`;
      const final = r.head_sha !== null && r.file_head === r.head_sha;
      const kept = latest.get(key);
      // Rows arrive newest first, so the first seen is the latest head unless the final head comes later.
      if (!kept || (final && !kept.final)) latest.set(key, { row: r, final });
    }
    return [...latest.values()].map(({ row }) => ({ repo: row.repo, prNumber: Number(row.pr_number), files: parsePrFiles(row.files) }));
  });
}

function parsePrFiles(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** One open, issue-linked `claws_prs` row as the file-overlap gate reads it (`listOverlapPrRows`). */
export interface OverlapPrRow {
  prNumber: number;
  issueId: string;
  phase: number | null;
  stage: ClawsPrStage;
  ciBlockedReason: string | null;
  headSha: string | null;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** The stored changed files for the row's current head; null when none are stored. */
  files: string[] | null;
  /** The issue's lifecycle; null when the issue row is missing. */
  lifecycle: string | null;
  /** ISO-8601 UTC; null below Plan or when the issue row is missing. */
  planApprovedAt: string | null;
  issueLabels: string[];
  /** The `paths` the plan declared for the row's step (`claws_issue_prs` at its `phase` in this repo); null when none. */
  declaredPaths: string[] | null;
}

/** The labels of each of `issueIds`, in one query. */
async function labelsForIssues(issueIds: readonly string[]): Promise<Map<string, string[]>> {
  const labels = new Map<string, string[]>();
  if (issueIds.length === 0) return labels;
  const labelRows = await getDb().all(
    `SELECT issue_id, label FROM claws_issue_labels WHERE issue_id IN (${issueIds.map(() => "?").join(", ")})`,
    [...issueIds],
  ) as Array<{ issue_id: string; label: string }>;
  for (const l of labelRows) labels.set(l.issue_id, [...(labels.get(l.issue_id) ?? []), l.label]);
  return labels;
}

/**
 * Every open `claws_prs` row in `repo` linked to an issue, with its issue's
 * lifecycle, Plan approval time and labels, and the stored changed files of
 * its current head. Read by `overlap-gate.ts`'s `loadInFlight`.
 */
export async function listOverlapPrRows(repo: string): Promise<OverlapPrRow[]> {
  return timedDb("list-overlap-pr-rows", async () => {
    const rows = await getDb().all(
      `SELECT p.pr_number, p.issue_id, p.phase, p.stage, p.ci_blocked_reason, p.head_sha, p.created_at,
              f.files, i.lifecycle, i.plan_approved_at, ip.paths AS declared_paths
         FROM claws_prs p
         LEFT JOIN claws_pr_files f ON f.repo = p.repo AND f.pr_number = p.pr_number AND f.head_sha = p.head_sha
         LEFT JOIN claws_issues i ON i.id = p.issue_id
         LEFT JOIN claws_issue_prs ip ON ip.issue_id = p.issue_id AND ip.position = p.phase AND ip.repo = p.repo AND ip.kind = 'pr'
        WHERE p.repo = ? AND p.issue_id IS NOT NULL AND p.stage NOT IN ('merged', 'closed')
        ORDER BY p.pr_number ASC`,
      [repo],
    ) as Array<{
      pr_number: number | string; issue_id: string; phase: number | string | null; stage: string;
      ci_blocked_reason: string | null; head_sha: string | null; created_at: string;
      files: string | null; lifecycle: string | null; plan_approved_at: string | null; declared_paths: string | null;
    }>;
    const labels = await labelsForIssues([...new Set(rows.map((r) => r.issue_id))]);
    return rows.map((r) => ({
      prNumber: Number(r.pr_number),
      issueId: r.issue_id,
      phase: r.phase === null || r.phase === undefined ? null : Number(r.phase),
      stage: r.stage as ClawsPrStage,
      ciBlockedReason: r.ci_blocked_reason ?? null,
      headSha: r.head_sha ?? null,
      createdAt: sqlTimeToIso(r.created_at),
      files: r.files === null || r.files === undefined ? null : parsePrFiles(r.files),
      lifecycle: r.lifecycle ?? null,
      planApprovedAt: sqlTimeToIso(r.plan_approved_at ?? null),
      issueLabels: labels.get(r.issue_id) ?? [],
      declaredPaths: parsePlannedPaths(r.declared_paths),
    }));
  });
}

/** A planned step in a repo whose PR has not opened yet, as the file-overlap gate reads it (`listOverlapUnstartedSteps`). */
export interface OverlapUnstartedStep {
  issueId: string;
  position: number;
  /** The step's declared `paths`. */
  paths: string[];
  /** The issue's lifecycle. */
  lifecycle: string;
  /** ISO-8601 UTC; null when unknown. */
  planApprovedAt: string | null;
  issueLabels: string[];
  /** How many steps the issue's stored list has, to expand a `claws-phase-done: 2-` claim. */
  totalSteps: number;
  /** The issue's live comments that carry `claws-phase-done:`, with their authors. */
  claimComments: { body: string; login: string }[];
  /** The issue's hold was lifted with Start anyway (`overlap_hold_lifted_at` set). */
  holdLifted: boolean;
}

/**
 * Every stored `pr` step in `repo` with declared `paths` that has not started:
 * of an open issue approved through Plan, not Blocked or in Backlog, with no
 * design change pending re-approval, no PR linked at its position and no
 * `claws_prs` row recording it (any stage but `closed`). The caller drops steps
 * a trusted `claws-phase-done:` claim in `claimComments` covers. Read by
 * `overlap-gate.ts`'s `loadInFlight`.
 */
export async function listOverlapUnstartedSteps(repo: string): Promise<OverlapUnstartedStep[]> {
  return timedDb("list-overlap-unstarted-steps", async () => {
    const rows = await getDb().all(
      `SELECT ip.issue_id, ip.position, ip.paths, i.lifecycle, i.plan_approved_at, i.overlap_hold_lifted_at,
              (SELECT MAX(t.position) FROM claws_issue_prs t WHERE t.issue_id = ip.issue_id) AS total_steps
         FROM claws_issue_prs ip
         JOIN claws_issues i ON i.id = ip.issue_id
        WHERE ip.repo = ? AND ip.kind = 'pr' AND ip.paths IS NOT NULL AND ip.pr_number IS NULL
          AND i.state = 'open' AND i.approved_through IN ('plan', 'merge')
          AND i.lifecycle NOT IN ('blocked', 'backlog')
          AND NOT EXISTS (SELECT 1 FROM claws_issue_reapprovals r WHERE r.issue_id = ip.issue_id AND r.approved_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM claws_prs p WHERE p.issue_id = ip.issue_id AND p.repo = ip.repo
                            AND p.phase = ip.position AND p.stage <> 'closed')
        ORDER BY ip.issue_id ASC, ip.position ASC`,
      [repo],
    ) as Array<{
      issue_id: string; position: number | string; paths: string | null; lifecycle: string;
      plan_approved_at: string | null; overlap_hold_lifted_at: string | null; total_steps: number | string | null;
    }>;
    const steps = rows.flatMap((r) => {
      const paths = parsePlannedPaths(r.paths);
      return paths ? [{ row: r, paths }] : [];
    });
    const issueIds = [...new Set(steps.map((s) => s.row.issue_id))];
    const labels = await labelsForIssues(issueIds);
    const claims = new Map<string, { body: string; login: string }[]>();
    if (issueIds.length > 0) {
      const claimRows = await getDb().all(
        `SELECT issue_id, author_login, body FROM claws_issue_comments
          WHERE issue_id IN (${issueIds.map(() => "?").join(", ")}) AND deleted_at IS NULL AND body LIKE '%claws-phase-done:%'`,
        issueIds,
      ) as Array<{ issue_id: string; author_login: string; body: string }>;
      for (const c of claimRows) {
        claims.set(c.issue_id, [...(claims.get(c.issue_id) ?? []), { body: c.body, login: c.author_login }]);
      }
    }
    return steps.map(({ row: r, paths }) => ({
      issueId: r.issue_id,
      position: Number(r.position),
      paths,
      lifecycle: r.lifecycle,
      planApprovedAt: sqlTimeToIso(r.plan_approved_at ?? null),
      issueLabels: labels.get(r.issue_id) ?? [],
      totalSteps: r.total_steps === null || r.total_steps === undefined ? Number(r.position) : Number(r.total_steps),
      claimComments: claims.get(r.issue_id) ?? [],
      holdLifted: !!r.overlap_hold_lifted_at,
    }));
  });
}

/**
 * The items with an implementer job active: a `work_queue` row of kind
 * `issue-worker` or `issue-worker:continue` that is queued or running, as
 * `{repo, itemNumber}` (a forge number or a `clw_…` id). Read by
 * `overlap-gate.ts`'s `loadInFlight`, which counts those issues' ready steps
 * as running.
 */
export async function listActiveImplementerRefs(): Promise<Array<{ repo: string; itemNumber: IssueRef }>> {
  return timedDb("list-active-implementer-refs", async () => {
    const rows = await getDb().all(
      `SELECT DISTINCT repo, item_number FROM work_queue
        WHERE status IN ('queued', 'running') AND kind IN (?, ?)
        ORDER BY repo ASC, item_number ASC`,
      [AGENT_KINDS.ISSUE_WORKER, AGENT_KINDS.ISSUE_WORKER_CONTINUE],
    ) as Array<{ repo: string; item_number: string | number }>;
    return rows.map((r) => ({ repo: r.repo, itemNumber: refFromColumn(r.item_number) }));
  });
}

/** The open (`stage` not `merged`/`closed`) `claws_prs` rows for a tracker issue, in any repo. */
/** Every open `claws_prs` row in any repo, linked to an issue or not — the nav's PRs count. */
export async function listOpenClawsPrsForIssue(issueId: string): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE issue_id = ? AND stage NOT IN ('merged', 'closed') ORDER BY repo ASC, pr_number ASC`,
    [issueId],
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/** Every `claws_prs` row for a tracker issue, in any repo and any stage. */
export async function listClawsPrsForIssue(issueId: string): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE issue_id = ? ORDER BY repo ASC, pr_number ASC`,
    [issueId],
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/**
 * Merged `claws_prs` rows, in any repo, whose recorded relation closes the issue:
 * the row names it (`issue_id = trackerId` or `issue_ref = issueRef`) with
 * `issue_relation = 'closes'`, or its `also_closes` holds the quoted ref.
 * `trackerId` may be null for a forge issue with no native link.
 */
export async function listMergedClawsPrsClosingIssue(trackerId: string | null, issueRef: string): Promise<ClawsPrRecord[]> {
  const refs = [...new Set([issueRef, ...(trackerId ? [trackerId] : [])])];
  const named: string[] = [];
  const params: (string | null)[] = [];
  if (trackerId) {
    named.push(`issue_id = ?`);
    params.push(trackerId);
  }
  named.push(`issue_ref = ?`);
  params.push(issueRef);
  const also = refs.map(() => `also_closes LIKE ?`);
  for (const r of refs) params.push(`%${JSON.stringify(r)}%`);
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE stage = 'merged'
       AND ((issue_relation = 'closes' AND (${named.join(" OR ")})) OR ${also.join(" OR ")})
     ORDER BY repo ASC, pr_number ASC`,
    params,
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/**
 * Merged `claws_prs` rows in `repo` that record a relation (`closes` or
 * `part-of`) to an issue: by `issue_id = trackerId`, or by `issue_ref` equal
 * to one of `issueRefs` (its spellings). `trackerId` may be null for a forge
 * issue with no native link.
 */
export async function listMergedClawsPrsRecordingIssue(repo: string, trackerId: string | null, issueRefs: readonly string[]): Promise<ClawsPrRecord[]> {
  const named: string[] = [];
  const params: string[] = [repo];
  if (trackerId) {
    named.push(`issue_id = ?`);
    params.push(trackerId);
  }
  for (const ref of new Set(issueRefs)) {
    named.push(`issue_ref = ?`);
    params.push(ref);
  }
  if (named.length === 0) return [];
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE repo = ? AND stage = 'merged' AND issue_relation IS NOT NULL
       AND (${named.join(" OR ")})
     ORDER BY pr_number ASC`,
    params,
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/** Every open `claws_prs` row linked to an issue — the board's PR columns in one query. */
export async function listOpenClawsPrsWithIssue(): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE issue_id IS NOT NULL AND stage NOT IN ('merged', 'closed') ORDER BY repo ASC, pr_number ASC`,
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/**
 * Every open `claws_prs` row with each issue it serves: the issue that owns
 * it (`claws_prs.issue_id`) and every issue whose stored step is linked to it
 * (`claws_issue_prs.pr_number`) — a step committed onto another issue's PR
 * through `CLAWS_TARGET_PR` (#clw_01M4XWHG3A2Q5Y06GN2SC7K06X). One entry per
 * distinct issue and row, for the board.
 */
export async function listOpenClawsPrsLinkedToIssues(): Promise<{ issueId: string; row: ClawsPrRecord }[]> {
  const rows = await getDb().all(
    `SELECT p.issue_id AS link_issue_id, p.* FROM claws_prs p
      WHERE p.issue_id IS NOT NULL AND p.stage NOT IN ('merged', 'closed')
     UNION
     SELECT ip.issue_id AS link_issue_id, p.* FROM claws_issue_prs ip
       JOIN claws_prs p ON p.repo = ip.repo AND p.pr_number = ip.pr_number
      WHERE p.stage NOT IN ('merged', 'closed')
     ORDER BY repo ASC, pr_number ASC`,
  ) as (ClawsPrRow & { link_issue_id: string })[];
  return rows.map((r) => ({ issueId: String(r.link_issue_id), row: toClawsPrRecord(r) }));
}

/**
 * The open `claws_prs` rows an issue owns plus those one of its stored steps
 * is linked to (see {@link listOpenClawsPrsLinkedToIssues}), each once.
 * Ownership-only callers keep {@link listOpenClawsPrsForIssue}.
 */
export async function listOpenClawsPrsForIssueOrSteps(issueId: string): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs
      WHERE stage NOT IN ('merged', 'closed')
        AND (issue_id = ? OR EXISTS (
          SELECT 1 FROM claws_issue_prs ip
           WHERE ip.issue_id = ? AND ip.repo = claws_prs.repo AND ip.pr_number = claws_prs.pr_number))
      ORDER BY repo ASC, pr_number ASC`,
    [issueId, issueId],
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/**
 * Every merged `claws_prs` row still carrying a post-merge manual action
 * (`pr-hold.ts` `POST_MERGE_PREFIX`), by repo and PR number — legacy rows
 * that `migratePostMergeActions` (`src/post-merge-step.ts`) converts at startup.
 */
export async function listPostMergeActionPrs(): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE stage = 'merged' AND manual_action_reason LIKE 'Manual action after merge:%' ORDER BY repo ASC, pr_number ASC`,
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

export async function listOpenClawsPrs(): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE stage NOT IN ('merged', 'closed') ORDER BY repo ASC, pr_number ASC`,
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}
