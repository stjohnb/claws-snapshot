/**
 * PR state store (`claws_prs`) — the label↔row contract, phase 1 of
 * docs/refinements/issue-flow.md ("Pull request state", "The façade and the
 * mirror").
 *
 * The row is written where the label is: `github.ts`'s `addLabel`,
 * `removeLabel` and `createPR` call {@link applyPrLabelAdded} /
 * {@link applyPrLabelRemoved} after the forge write, the same layer the native
 * issue lifecycle is written at, so no writer calls this module directly. The
 * PR dispatcher seeds and refreshes the row each tick; the issue auditor
 * compares it with the labels ({@link comparePrRowWithLabels}).
 *
 * The label façade ({@link overlayPrStateLabels}) is inert unless
 * `CLAWS_PR_STORE_FACADE=true`, read at call time.
 */
import { LABELS } from "./config.js";
import * as db from "./db.js";
import type { ClawsPrPatch, ClawsPrRecord, ClawsPrStage } from "./db.js";
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

/** Façade switch — read at call time, mirroring stepBackEnabled(). Default off. */
export function prStoreFacadeEnabled(): boolean {
  return process.env["CLAWS_PR_STORE_FACADE"] === "true";
}

/** `manual_action_reason` the hook records; the label carries no reason. */
export const LABEL_MANUAL_ACTION_REASON = "manual action";
/** `ci_blocked_reason` the hook records for `Billing`. */
export const LABEL_BILLING_REASON = "billing";
/** `merge_approved_by` when the approval came through `addLabel(Automerge)`. */
export const LABEL_APPROVER = "label";
/** `merge_approved_by` when the dispatcher imported an `Automerge` applied on the forge. */
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
    // Best-effort: a row write must never fail a label write. The auditor
    // reports the resulting drift.
    log.warn(`[pr-state] ${repo}#${prNumber}: could not mirror label ${label} ${verb}: ${err}`);
  }
}

/** Mirror a PR state label added on a forge PR into its `claws_prs` row. Never throws. */
export async function applyPrLabelAdded(repo: string, prNumber: number, label: string): Promise<void> {
  await applyLabelChange(repo, prNumber, label, "added");
}

/** Mirror a PR state label removed from a forge PR into its `claws_prs` row. Never throws. */
export async function applyPrLabelRemoved(repo: string, prNumber: number, label: string): Promise<void> {
  await applyLabelChange(repo, prNumber, label, "removed");
}

/**
 * The one-shot import for a PR the dispatcher sees for the first time with
 * labels already on it (every PR open when the store shipped, Dependabot
 * PRs). Stage precedence: problematic > awaiting-merge > manual-action >
 * ci-failing > opened.
 */
export function seedPatchFromLabels(
  labels: readonly string[],
  ciStatus: string | null,
  now = new Date(),
): ClawsPrPatch {
  const has = (l: string): boolean => labels.includes(l);
  let stage: ClawsPrStage = "opened";
  if (has(LABELS.problematic)) stage = "problematic";
  else if (has(LABELS.ready)) stage = "awaiting-merge";
  else if (has(LABELS.manualAction)) stage = "manual-action";
  else if (ciStatus === "failing") stage = "ci-failing";
  return {
    stage,
    manualActionReason: has(LABELS.manualAction) ? LABEL_MANUAL_ACTION_REASON : null,
    needsHumanReview: has(LABELS.needsLgtm),
    ciBlockedReason: has(LABELS.billing) ? LABEL_BILLING_REASON : null,
    mergeApprovedAt: has(LABELS.automerge) ? now.toISOString() : null,
    mergeApprovedBy: has(LABELS.automerge) ? FORGE_LABEL_APPROVER : null,
  };
}

/**
 * Reconcile an existing row with the forge's state labels — phase 1, while
 * labels are the source of truth. A label a human adds or removes on the forge
 * never passes through `addLabel`/`removeLabel`, so the dispatcher applies
 * the hook's own patches for each label whose presence differs from the row.
 * Disagreements are found against `row` once, then applied removals first
 * and additions in {@link prStateLabels} order, so a single-valued stage
 * lands on the same precedence as {@link seedPatchFromLabels}. An `Automerge`
 * found on the forge is attributed to {@link FORGE_LABEL_APPROVER}.
 */
export function reconcilePatchFromLabels(
  row: ClawsPrRecord,
  labels: readonly string[],
  now = new Date(),
): { patch: ClawsPrPatch; corrected: PrStateDisagreement[] } {
  const corrected = comparePrRowWithLabels(row, labels);
  const ordered = [
    ...corrected.filter((d) => d.actual === "absent"),
    ...corrected.filter((d) => d.actual === "present"),
  ];
  let current = row;
  const patch: ClawsPrPatch = {};
  for (const d of ordered) {
    const step = d.actual === "present"
      ? patchForLabelAdded(current, d.field, now)
      : patchForLabelRemoved(current, d.field);
    if (!step) continue;
    if (d.field === LABELS.automerge && d.actual === "present") step.mergeApprovedBy = FORGE_LABEL_APPROVER;
    Object.assign(patch, step);
    current = { ...current, ...step };
  }
  return { patch, corrected };
}

/** Whether the row implies `label` is on the PR — the contract all three users share. */
function rowImpliesLabel(row: ClawsPrRecord, label: string): boolean {
  switch (label) {
    case LABELS.ready: return row.stage === "awaiting-merge";
    case LABELS.problematic: return row.stage === "problematic";
    case LABELS.manualAction: return row.manualActionReason !== null;
    case LABELS.needsLgtm: return row.needsHumanReview;
    case LABELS.billing: return row.ciBlockedReason !== null;
    case LABELS.automerge: return row.mergeApprovedAt !== null;
    default: return false;
  }
}

/** The PR state labels the row implies, in {@link prStateLabels} order. */
export function labelsForPrRow(row: ClawsPrRecord): string[] {
  return prStateLabels().filter((l) => rowImpliesLabel(row, l));
}

/** Replace `labels`' state labels with the ones `row` implies, keeping every other label. */
export function overlayLabelNames(labels: readonly string[], row: ClawsPrRecord): string[] {
  return [...labels.filter((l) => !isPrStateLabel(l)), ...labelsForPrRow(row)];
}

/**
 * The label façade over `claws_prs`. With `CLAWS_PR_STORE_FACADE` unset this
 * returns `prs` itself, untouched and without a DB read. When on, each PR with
 * a row gets its state labels from the row; a PR with no row is untouched.
 * Never mutates its input.
 */
export async function overlayPrStateLabels<T extends { number: number; labels: { name: string }[] }>(
  repo: string,
  prs: T[],
): Promise<T[]> {
  if (!prStoreFacadeEnabled()) return prs;
  let rows: ClawsPrRecord[];
  try {
    rows = await db.listClawsPrs(repo);
  } catch (err) {
    log.warn(`[pr-state] ${repo}: façade could not read claws_prs, serving forge labels: ${err}`);
    return prs;
  }
  const byNumber = new Map(rows.map((r) => [r.prNumber, r]));
  return prs.map((pr) => {
    const row = byNumber.get(pr.number);
    if (!row) return pr;
    const names = overlayLabelNames(pr.labels.map((l) => l.name), row);
    return { ...pr, labels: names.map((name) => ({ name })) };
  });
}

/** {@link overlayPrStateLabels} for one PR's `string[]` labels (`getPRMergeGate`). */
export async function overlayPrStateLabelNames(repo: string, prNumber: number, labels: string[]): Promise<string[]> {
  if (!prStoreFacadeEnabled()) return labels;
  try {
    const row = await db.getClawsPr(repo, prNumber);
    return row ? overlayLabelNames(labels, row) : labels;
  } catch (err) {
    log.warn(`[pr-state] ${repo}#${prNumber}: façade could not read claws_prs, serving forge labels: ${err}`);
    return labels;
  }
}

/** One row-vs-labels disagreement: `expected` is what the row implies, `actual` what the forge shows. */
export interface PrStateDisagreement {
  /** The state label compared, or `missing-row`. */
  field: string;
  expected: string;
  actual: string;
}

/** Compare a PR's row with its forge labels, one entry per disagreeing state label. */
export function comparePrRowWithLabels(row: ClawsPrRecord | null, labels: readonly string[]): PrStateDisagreement[] {
  if (!row) return [{ field: "missing-row", expected: "row", actual: "none" }];
  const out: PrStateDisagreement[] = [];
  for (const label of prStateLabels()) {
    const want = rowImpliesLabel(row, label);
    const have = labels.includes(label);
    if (want !== have) {
      out.push({ field: label, expected: want ? "present" : "absent", actual: have ? "present" : "absent" });
    }
  }
  return out;
}
