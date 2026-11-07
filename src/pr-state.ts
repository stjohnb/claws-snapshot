/**
 * PR state store (`claws_prs`) — the label↔row contract, phase 1 of
 * docs/refinements/issue-flow.md ("Pull request state", "The façade and the
 * mirror").
 *
 * The row is written where the label is: `github.ts`'s `addLabel`,
 * `removeLabel` and `createPR` call {@link applyPrLabelAdded} /
 * {@link applyPrLabelRemoved} after the forge write, the same layer the native
 * issue lifecycle is written at. The review stage and merge approval have no
 * label: their writers call {@link markPrAwaitingMerge} /
 * {@link markPrAwaitingReview} or write `merge_approved_*` directly. The PR
 * dispatcher seeds and refreshes the row each tick.
 *
 * Since phase 5 the row is the only PR state input: readers use the typed
 * readers below ({@link isAwaitingMerge}, {@link isProblematic},
 * {@link hasManualAction}, {@link needsHumanReview}, {@link isMergeApproved}),
 * and the forge labels are a write-only mirror no decision reads back.
 */
import { LABELS } from "./config.js";
import * as db from "./db.js";
import type { ClawsPrPatch, ClawsPrRecord } from "./db.js";
import * as log from "./log.js";

/**
 * The PR state labels the row mirrors. Routing labels (Priority, Use Codex…)
 * are not state. A function, not a constant, so importing this module (every
 * `github.ts` import does) never reads `LABELS` at load time.
 */
export function prStateLabels(): readonly string[] {
  return [
    LABELS.problematic,
    LABELS.needsLgtm,
    LABELS.billing,
  ];
}

export function isPrStateLabel(label: string): boolean {
  return prStateLabels().includes(label);
}

/**
 * PR state labels whose row write cannot be best-effort: a lost write for one
 * of these silently un-gates a merge (`Needs LGTM`'s `needsHumanReview` is the
 * only label that can hold it back; a hold's `manualActionReason` is written
 * directly) or lets a superseded PR through ({@link isProblematic}).
 */
export function isGatingLabel(label: string): boolean {
  return label === LABELS.needsLgtm || label === LABELS.problematic;
}

/** `ci_blocked_reason` the hook records for `Billing`. */
export const LABEL_BILLING_REASON = "billing";
/**
 * Legacy `merge_approved_by` from when adding `Automerge` to a PR wrote the
 * row. Nothing writes it any more; rows that already hold it stay approved.
 */
export const LABEL_APPROVER = "label";
/** `merge_approved_by` when the PR's approval was carried over from its issue's merge approval. */
export const ISSUE_APPROVER = "issue";
/**
 * Legacy `merge_approved_by` for an `Automerge` the dispatcher copied off the
 * forge before phase 5. Nothing writes it any more: the merge gate rejects it,
 * and the PR dispatcher clears it from any row still holding it — a forge
 * label approves nothing.
 */
export const FORGE_LABEL_APPROVER = "forge-label";

/** The row patch that adding `label` implies, given the current row. Null: nothing to write. */
export function patchForLabelAdded(row: ClawsPrRecord, label: string): ClawsPrPatch | null {
  switch (label) {
    case LABELS.problematic:
      return row.stage === "problematic" ? null : { stage: "problematic" };
    case LABELS.needsLgtm:
      return row.needsHumanReview ? null : { needsHumanReview: true };
    case LABELS.billing:
      return row.ciBlockedReason !== null ? null : { ciBlockedReason: LABEL_BILLING_REASON };
    default:
      return null;
  }
}

/** The row patch that removing `label` implies, given the current row. Null: nothing to write. */
export function patchForLabelRemoved(row: ClawsPrRecord, label: string): ClawsPrPatch | null {
  switch (label) {
    case LABELS.problematic:
      return row.stage === "problematic" ? { stage: "awaiting-review" } : null;
    case LABELS.needsLgtm:
      return row.needsHumanReview ? { needsHumanReview: false } : null;
    case LABELS.billing:
      return row.ciBlockedReason !== null ? { ciBlockedReason: null } : null;
    default:
      return null;
  }
}

async function applyLabelChange(
  repo: string,
  prNumber: number,
  label: string,
  verb: "added" | "removed",
): Promise<void> {
  if (!isPrStateLabel(label)) return;
  try {
    // Row existence is the issue-vs-PR test: the forge shares one number
    // space, and every PR Claws works has a row before any label is written.
    const row = await db.getClawsPr(repo, prNumber);
    if (!row) return;
    const patch = verb === "added" ? patchForLabelAdded(row, label) : patchForLabelRemoved(row, label);
    if (patch) await db.upsertClawsPr(repo, prNumber, patch);
  } catch (err) {
    log.warn(`[pr-state] ${repo}#${prNumber}: could not mirror label ${label} ${verb}: ${err}`);
    // Best-effort for everything else, but the row is now the only PR state
    // input: a lost write for a gating label must fail the label write
    // rather than silently un-gate the PR.
    if (isGatingLabel(label)) throw err;
  }
}

/**
 * Mirror a PR state label added on a forge PR into its `claws_prs` row.
 * Never throws — except for a gating label ({@link isGatingLabel}), where a
 * failed row write is re-thrown so the caller doesn't treat an un-gated PR
 * as a success.
 */
export async function applyPrLabelAdded(repo: string, prNumber: number, label: string): Promise<void> {
  await applyLabelChange(repo, prNumber, label, "added");
}

/** Mirror a PR state label removed from a forge PR into its `claws_prs` row. Same gating-label exception as {@link applyPrLabelAdded}. */
export async function applyPrLabelRemoved(repo: string, prNumber: number, label: string): Promise<void> {
  await applyLabelChange(repo, prNumber, label, "removed");
}

/**
 * Record that a PR's review is clean and it awaits merge: `stage` →
 * `awaiting-merge`. Writes only an existing row (every PR Claws works has one)
 * and nothing when the stage is already there. No forge label is written.
 * Best-effort: never throws, since the stage only feeds the Queue UI and the
 * Phase 3 advisory gate, not merge safety.
 */
export async function markPrAwaitingMerge(repo: string, prNumber: number): Promise<void> {
  try {
    const row = await db.getClawsPr(repo, prNumber);
    if (!row || row.stage === "awaiting-merge") return;
    await db.upsertClawsPr(repo, prNumber, { stage: "awaiting-merge" });
  } catch (err) {
    log.warn(`[pr-state] ${repo}#${prNumber}: could not mark awaiting merge: ${err}`);
  }
}

/**
 * Send a PR that awaits merge back to review: `stage` `awaiting-merge` →
 * `awaiting-review`, and only from `awaiting-merge` — a problematic, merged
 * or closed row is left alone. Best-effort like {@link markPrAwaitingMerge}.
 */
export async function markPrAwaitingReview(repo: string, prNumber: number): Promise<void> {
  try {
    const row = await db.getClawsPr(repo, prNumber);
    if (row?.stage !== "awaiting-merge") return;
    await db.upsertClawsPr(repo, prNumber, { stage: "awaiting-review" });
  } catch (err) {
    log.warn(`[pr-state] ${repo}#${prNumber}: could not mark awaiting review: ${err}`);
  }
}

/**
 * Whether the row says the PR's review is clean and it awaits merge. Written
 * by {@link markPrAwaitingMerge}; no forge label mirrors it.
 */
export function isAwaitingMerge(row: ClawsPrRecord | null | undefined): boolean {
  return row?.stage === "awaiting-merge";
}

/** Whether the row says CI-fix attempts are exhausted (the `Claws Problematic` mirror). */
export function isProblematic(row: ClawsPrRecord | null | undefined): boolean {
  return row?.stage === "problematic";
}

/** Whether the row records a hold that keeps the PR from merging (see `pr-hold.ts`). */
export function hasManualAction(row: ClawsPrRecord | null | undefined): boolean {
  return row != null && row.manualActionReason !== null;
}

/** Whether the row says no merge exemption applies (the `Needs LGTM` mirror). */
export function needsHumanReview(row: ClawsPrRecord | null | undefined): boolean {
  return row?.needsHumanReview === true;
}

/**
 * Whether the row carries a merge approval the merge gate accepts: a time and
 * a named approver — an OIDC `sub`, `dashboard`, `session:<id>`,
 * {@link ISSUE_APPROVER}, the legacy {@link LABEL_APPROVER} or a
 * cutover-imported `forge:<login>`. The legacy
 * {@link FORGE_LABEL_APPROVER} names nobody and is never accepted.
 */
export function isMergeApproved(row: ClawsPrRecord | null | undefined): boolean {
  if (!row || row.mergeApprovedAt === null) return false;
  const by = row.mergeApprovedBy;
  return !!by && by !== FORGE_LABEL_APPROVER;
}

/**
 * Whether the row is `awaiting-merge` with a completed review of the PR's
 * current head — the shape {@link isIdleAwaitingHuman} in `auto-merger.ts`
 * builds "a PR that waits only on a human" from. `headSha`, when passed, is
 * the PR's live head (its `headRefOid`); otherwise the row's own `headSha` is
 * used. A null row, a row with no recorded review, or a head that does not
 * match the reviewed commit all answer false.
 */
export function isReviewedHeadAwaitingMerge(row: ClawsPrRecord | null | undefined, headSha?: string | null): boolean {
  if (!row || row.stage !== "awaiting-merge" || row.reviewedSha === null) return false;
  const head = headSha ?? row.headSha;
  return head != null && head === row.reviewedSha;
}

/** A board-recorded infrastructure merge approval, judged against the PR's live head. */
export type InfraMergeApproval =
  | { state: "none" }
  | { state: "current"; by: string; at: string }
  | { state: "stale"; by: string; at: string; sha: string | null };

/**
 * Whether the row carries a human's infra merge approval for `headSha` — the
 * PR's live head. `current` needs an approver, a time and the approved sha
 * equal to `headSha`; an approver and time for any other sha (or with no live
 * head known) is `stale`, so new commits always ask the operator again.
 */
export function infraMergeApproval(
  row: Partial<Pick<ClawsPrRecord, "infraMergeApprovedBy" | "infraMergeApprovedAt" | "infraMergeApprovedSha">> | null | undefined,
  headSha: string | null | undefined,
): InfraMergeApproval {
  if (!row || !row.infraMergeApprovedBy || !row.infraMergeApprovedAt) return { state: "none" };
  const by = row.infraMergeApprovedBy;
  const at = row.infraMergeApprovedAt;
  if (headSha && row.infraMergeApprovedSha === headSha) return { state: "current", by, at };
  return { state: "stale", by, at, sha: row.infraMergeApprovedSha ?? null };
}
