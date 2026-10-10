/**
 * PR state store (`claws_prs`) — the label↔row contract, phase 1 of
 * docs/refinements/issue-flow.md ("Pull request state", "The façade and the
 * mirror").
 *
 * The row is written where the label is: `github.ts`'s `addLabel`,
 * `removeLabel` and `createPR` call {@link applyPrLabelAdded} /
 * {@link applyPrLabelRemoved} after the forge write, the same layer the native
 * issue lifecycle is written at, so no writer calls this module directly. The
 * PR dispatcher seeds and refreshes the row each tick.
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
    LABELS.ready,
    LABELS.problematic,
    LABELS.manualAction,
    LABELS.needsLgtm,
    LABELS.billing,
    LABELS.automerge,
  ];
}

export function isPrStateLabel(label: string): boolean {
  return prStateLabels().includes(label);
}

/**
 * PR state labels whose row write cannot be best-effort: a lost write for one
 * of these silently un-gates a merge ({@link isMergeApproved} rejects a bare
 * `Automerge` label, so `Needs LGTM`'s `needsHumanReview` and `Manual
 * Action`'s `manualActionReason` are the only things that can hold it back)
 * or lets a superseded PR through ({@link isProblematic}). `Ready` is
 * excluded — it only affects the Queue UI and the Phase 3 advisory gate, not
 * merge safety — and `Automerge` is excluded because every approval writer
 * (`setIssueAutomerge`, `recordMergeApproval`) already writes the row before
 * the label.
 */
export function isGatingLabel(label: string): boolean {
  return label === LABELS.manualAction || label === LABELS.needsLgtm || label === LABELS.problematic;
}

/** `manual_action_reason` the hook records; the label carries no reason. */
export const LABEL_MANUAL_ACTION_REASON = "manual action";
/** `ci_blocked_reason` the hook records for `Billing`. */
export const LABEL_BILLING_REASON = "billing";
/** `merge_approved_by` when the approval came through `addLabel(Automerge)`. */
export const LABEL_APPROVER = "label";
/**
 * Legacy `merge_approved_by` for an `Automerge` the dispatcher copied off the
 * forge before phase 5. Nothing writes it any more: the dispatcher's cutover
 * import rewrites it to {@link forgeApprover}, and the merge gate rejects it.
 */
export const FORGE_LABEL_APPROVER = "forge-label";

/** The row patch that adding `label` implies, given the current row. Null: nothing to write. */
export function patchForLabelAdded(row: ClawsPrRecord, label: string, now = new Date()): ClawsPrPatch | null {
  switch (label) {
    case LABELS.ready:
      return row.stage === "awaiting-merge" ? null : { stage: "awaiting-merge" };
    case LABELS.problematic:
      return row.stage === "problematic" ? null : { stage: "problematic" };
    case LABELS.manualAction: {
      const patch: ClawsPrPatch = {};
      if (row.manualActionReason === null) patch.manualActionReason = LABEL_MANUAL_ACTION_REASON;
      // A PR legitimately carries Ready + Manual Action today; keep the
      // single-valued stage on the stronger state.
      if (row.stage !== "awaiting-merge" && row.stage !== "problematic" && row.stage !== "manual-action") {
        patch.stage = "manual-action";
      }
      return Object.keys(patch).length > 0 ? patch : null;
    }
    case LABELS.needsLgtm:
      return row.needsHumanReview ? null : { needsHumanReview: true };
    case LABELS.billing:
      return row.ciBlockedReason !== null ? null : { ciBlockedReason: LABEL_BILLING_REASON };
    case LABELS.automerge:
      return row.mergeApprovedAt !== null
        ? null
        : { mergeApprovedAt: now.toISOString(), mergeApprovedBy: LABEL_APPROVER };
    default:
      return null;
  }
}

/** The row patch that removing `label` implies, given the current row. Null: nothing to write. */
export function patchForLabelRemoved(row: ClawsPrRecord, label: string): ClawsPrPatch | null {
  switch (label) {
    case LABELS.ready:
      return row.stage === "awaiting-merge" ? { stage: "awaiting-review" } : null;
    case LABELS.problematic:
      return row.stage === "problematic" ? { stage: "awaiting-review" } : null;
    case LABELS.manualAction: {
      const patch: ClawsPrPatch = {};
      if (row.manualActionReason !== null) patch.manualActionReason = null;
      if (row.stage === "manual-action") patch.stage = "awaiting-review";
      return Object.keys(patch).length > 0 ? patch : null;
    }
    case LABELS.needsLgtm:
      return row.needsHumanReview ? { needsHumanReview: false } : null;
    case LABELS.billing:
      return row.ciBlockedReason !== null ? { ciBlockedReason: null } : null;
    case LABELS.automerge:
      return row.mergeApprovedAt !== null || row.mergeApprovedBy !== null
        ? { mergeApprovedAt: null, mergeApprovedBy: null }
        : null;
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
 * Whether the row says the PR's review is clean and it awaits merge (the
 * `Ready` mirror). The row is the only PR state input; labels are write-only.
 */
export function isAwaitingMerge(row: ClawsPrRecord | null | undefined): boolean {
  return row?.stage === "awaiting-merge";
}

/** Whether the row says CI-fix attempts are exhausted (the `Claws Problematic` mirror). */
export function isProblematic(row: ClawsPrRecord | null | undefined): boolean {
  return row?.stage === "problematic";
}

/** Whether the row records a manual step before merge (the `Manual Action` mirror). */
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
 * {@link LABEL_APPROVER} or a cutover-imported `forge:<login>`. The legacy
 * {@link FORGE_LABEL_APPROVER} names nobody and is never accepted.
 */
export function isMergeApproved(row: ClawsPrRecord | null | undefined): boolean {
  if (!row || row.mergeApprovedAt === null) return false;
  const by = row.mergeApprovedBy;
  return !!by && by !== FORGE_LABEL_APPROVER;
}

/** `merge_approved_by` for a forge `Automerge` imported at cutover, naming who applied it. */
export function forgeApprover(login: string): string {
  return `forge:${login}`;
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
