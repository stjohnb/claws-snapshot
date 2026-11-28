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
import type { InfraApprovalNeed } from "./tofu-plan.js";
import { ESCALATION_REASON_PREFIX } from "./hold-kind.js";
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

/** A board-recorded infra approval (resource deletion, unverified plan or tofu workflow change), judged against the PR's live head. */
export type InfraMergeApproval =
  | { state: "none" }
  | { state: "current"; by: string; at: string }
  | { state: "carried"; by: string; at: string; sha: string | null; carriedTo: string; note: string }
  | { state: "stale"; by: string; at: string; sha: string | null };

/**
 * How the auto-merger's `infra-approval-stale` refusal begins; the board card
 * strips it to show the rule that kept the approval from carrying over.
 */
export const INFRA_APPROVAL_NOT_CARRIED = "Infra approval not carried over: ";

/**
 * The `- …` lines of the auto-merger's persisted `infra` refusal for `head`:
 * each a resource the head's plan destroys or replaces. Empty for any other
 * skip, another head, or no row — read from the row so the web tier sees it
 * under the web/controller split.
 */
export function persistedInfraHoldItems(
  row: Pick<ClawsPrRecord, "mergeSkipCode" | "mergeSkipReason" | "mergeSkipHead"> | null | undefined,
  head: string | null | undefined,
): string[] {
  if (!row || row.mergeSkipCode !== "infra" || !head || row.mergeSkipHead !== head) return [];
  return (row.mergeSkipReason ?? "").split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0);
}

/**
 * What the board recorded with an infra approval, stored as JSON in
 * `infraMergeApprovedEvidence`: the approved head's plan fingerprint
 * (`tofuPlanFingerprint`; null when the plan was not verified or listed no
 * resources), its counts, and the PR's tofu workflow digest
 * (`infraWorkflowDiffDigest`), and the need the operator approved. A later
 * head whose plan and digest match keeps the approval.
 */
export interface InfraMergeApprovedEvidence {
  fingerprint: string | null;
  counts: { add: number; change: number; replace: number; destroy: number } | null;
  /** `infraWorkflowDiffDigest`; null when the diff could not be read. */
  workflowDiff: string | null;
  /**
   * The `infraApprovalNeed` the approval was given for, so it never covers a
   * different need on the same head (an "unverified" approval does not cover a
   * plan that later shows a destroy); absent on approvals recorded before it was kept.
   */
  need?: InfraApprovalNeed;
}

/** The parsed `infraMergeApprovedEvidence`, or null when absent or malformed. */
export function parseInfraMergeApprovedEvidence(raw: string | null | undefined): InfraMergeApprovedEvidence | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<InfraMergeApprovedEvidence> | null;
    if (!v || typeof v !== "object" || v.workflowDiff !== null && typeof v.workflowDiff !== "string") return null;
    const need = v.need === "unverified" || v.need === "destructive" || v.need === "workflow" ? v.need : undefined;
    return { fingerprint: typeof v.fingerprint === "string" ? v.fingerprint : null, counts: v.counts ?? null, workflowDiff: v.workflowDiff ?? null, ...(need ? { need } : {}) };
  } catch {
    return null;
  }
}

/**
 * Whether the row carries a human's infra approval for `headSha` — the
 * PR's live head. `current` needs an approver, a time and the approved sha
 * equal to `headSha`; `carried` is an approval for an older head that the
 * auto-merger carried over to `headSha` because the plan and the PR's tofu
 * workflow edits did not change (`infraMergeCarriedSha`); an approver and time
 * for any other sha (or with no live head known) is `stale`, so new commits
 * ask the operator again unless they are plan-neutral.
 */
export function infraMergeApproval(
  row: Partial<Pick<ClawsPrRecord, "infraMergeApprovedBy" | "infraMergeApprovedAt" | "infraMergeApprovedSha" | "infraMergeCarriedSha" | "infraMergeCarriedNote">> | null | undefined,
  headSha: string | null | undefined,
): InfraMergeApproval {
  if (!row || !row.infraMergeApprovedBy || !row.infraMergeApprovedAt) return { state: "none" };
  const by = row.infraMergeApprovedBy;
  const at = row.infraMergeApprovedAt;
  if (headSha && row.infraMergeApprovedSha === headSha) return { state: "current", by, at };
  const sha = row.infraMergeApprovedSha ?? null;
  if (headSha && row.infraMergeCarriedSha === headSha) {
    return { state: "carried", by, at, sha, carriedTo: headSha, note: row.infraMergeCarriedNote ?? "" };
  }
  return { state: "stale", by, at, sha };
}

/** The row fields {@link infraApprovalWait} reads; the board card, `/prs`, the repo page and the attention reasons all pass a `claws_prs` row shape. */
export interface InfraApprovalWaitRow {
  stage?: string | null;
  headSha?: string | null;
  ciStatus?: string | null;
  reviewVerdict?: string | null;
  reviewedSha?: string | null;
  mergeableState?: string | null;
  ciBlockedReason?: string | null;
  manualActionReason?: string | null;
}

/** What a PR with a recorded manual action waits on before its infra approval (#clw_01M7QWS5TGJF46D318FN3W5HRJ). */
export const INFRA_WAIT_MANUAL_ACTION = "Infra approval comes after the manual action";
/** What a PR held by a reviewer escalation waits on before its infra approval (#clw_01M7QWS5TGJF46D318FN3W5HRJ). */
export const INFRA_WAIT_ESCALATION = "Infra approval comes after the reviewer escalation is settled";

/** The in-progress wording for each merge-blocking agent kind queued or running on the PR. */
const INFRA_WAIT_WORK: Record<string, string> = {
  "pr-reviewer": "Waiting for review",
  "review-addresser": "Addressing review",
  "ci-fixer": "Fixing CI",
  "ci-fixer:conflict": "Resolving conflicts",
};

/** Review verdicts that pass the merge gate, as the auto-merger's `deriveReviewStatus` treats them. */
const PASSING_REVIEW_VERDICTS = new Set(["clean", "advisory", "empty-diff"]);

/**
 * What an infrastructure PR is still waiting on before its infra approval is
 * the next step (#clw_01M7QNXX7VNQXA1A92P1WCT6S9), or null when the approval
 * is the next step. A recorded hold (`manualActionReason`, any hold kind)
 * comes first, #clw_01M7QWS5TGJF46D318FN3W5HRJ: it holds the merge whatever
 * the approval does, so it wins over `problematic`, a CI block, held checks
 * and active work — {@link INFRA_WAIT_ESCALATION} for a reviewer escalation,
 * {@link INFRA_WAIT_MANUAL_ACTION} otherwise. Then, in order: a merge-blocking job queued or running on it
 * (`activeWork`, a work kind), CI on the head pending ("Waiting for CI") or
 * failing ("CI failing"), no review of the current head ("Waiting for
 * review"), a blocking review ("Addressing review"), a conflict with its base
 * ("Resolving conflicts"). A stalled or human-held PR — `problematic`, a CI
 * block, held checks or an escalated review — is not in progress: null.
 * `liveCheckStatus` (the forge's check status) is preferred over the row's
 * `ciStatus`; CI `none` does not count as waiting. Pure; the one rule behind
 * the board card's infra line, the `/prs` and repo page infra hold note and
 * the "Needs infra approval" attention reason.
 */
export function infraApprovalWait(
  pr: InfraApprovalWaitRow | null | undefined,
  opts: { liveCheckStatus?: string | null; activeWork?: string | null } = {},
): string | null {
  if (!pr) return null;
  // A recorded hold blocks the merge whatever the infra approval does: the hold is the one call to act.
  const hold = pr.manualActionReason?.trim();
  if (hold) return hold.startsWith(ESCALATION_REASON_PREFIX) ? INFRA_WAIT_ESCALATION : INFRA_WAIT_MANUAL_ACTION;
  const ci = opts.liveCheckStatus ?? pr.ciStatus ?? null;
  if (pr.stage === "problematic" || pr.ciBlockedReason || ci === "held" || pr.reviewVerdict === "escalated") return null;
  const work = opts.activeWork ? INFRA_WAIT_WORK[opts.activeWork] : undefined;
  if (work) return work;
  if (ci === "pending") return "Waiting for CI";
  if (ci === "failing") return "CI failing";
  if (!pr.headSha || pr.reviewedSha !== pr.headSha || !pr.reviewVerdict) return "Waiting for review";
  if (!PASSING_REVIEW_VERDICTS.has(pr.reviewVerdict)) return pr.reviewVerdict === "blocking" ? "Addressing review" : null;
  if (pr.mergeableState === "CONFLICTING") return "Resolving conflicts";
  return null;
}
