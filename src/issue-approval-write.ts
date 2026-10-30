/**
 * The one writer of an issue's approval (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F):
 * `claws_issues.approved_through` plus what goes with it — the promotion a
 * Requirements approval is, the design-change approval a Plan approval is
 * while one is pending, and `merge_approved_by` / `merge_approved_at` on each
 * of the issue's open PR rows for a Merge approval. No label is written: the
 * stored value and the rows are the only approval record.
 *
 * Shared by the approval track (`POST /board/approve-through`), the
 * `claws_set_issue_approval` MCP tool, board moves, the issue page,
 * `reapproval.ts`, the planner, the implementer and the monitors that file
 * pre-approved issues. Each caller still checks what it is allowed to offer
 * (the track's gate, a board move's landing column); this module only writes.
 */

import * as db from "./db.js";
import * as log from "./log.js";
import * as gh from "./github.js";
import * as clawsIssues from "./claws-issues.js";
import { loadIssueFlight } from "./issue-flight.js";
import { resolveTrackerId } from "./planned-prs.js";
import * as reapproval from "./reapproval.js";
import { approvalRank, atLeast, type ApprovedThrough } from "./issue-approval.js";
import type { IssueRef } from "./issue-id.js";

/**
 * The first words of the comment an approval raise posts. A Claws comment, so
 * the planner's feedback reads never count it as human feedback; the
 * refiner dates feedback against `plan_approved_at`, which the same write
 * sets.
 */
export const APPROVAL_COMMENT_PREFIX = "**Approved through";

/** The first words of the comment a withdrawal posts. */
export const APPROVAL_WITHDRAWN_PREFIX = "**Approval withdrawn**";

const GATE_WORD: Record<ApprovedThrough, string> = {
  none: "nothing",
  requirements: "Requirements",
  plan: "Plan",
  merge: "Merge",
};

export type ApprovalWriteResult =
  | { ok: true; trackerId: string; before: ApprovedThrough; after: ApprovedThrough; changed: boolean; openPrs: number }
  | { ok: false; status: number; error: string };

export interface ApplyIssueApprovalOptions {
  /**
   * Mint a forge issue's shadow from these fields when it has none, so an
   * approval set before the dispatcher first saw the issue is not lost.
   */
  create?: { title: string; body?: string; authorLogin: string; labels?: readonly string[] };
  /**
   * How an issue still in Ideas is promoted when the approval reaches
   * Requirements. The dashboard passes its own promotion (which also re-plans
   * an issue that already has a plan); the default promotes the latest
   * requirements version, or approves a pending design change.
   */
  promote?: () => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /**
   * Clear every approved open PR row even when only some are approved — a
   * deliberate withdrawal of a partial Merge given by single-PR approvals.
   * Without it a restated value below Merge clears the rows only when all of
   * them are approved. Ignored when `through` is `merge`.
   */
  clearMergeRows?: boolean;
  /** Post the one-line approval / withdrawal comment (default true). */
  comment?: boolean;
  /** Whose words the comment is in; defaults to none (a plain Claws comment). */
  agentName?: string;
  /**
   * Why, appended to the comment — "the planner's step-back said reconsider",
   * say. Plain text.
   */
  reason?: string;
}

/** The default promotion: a pending design change's approval, or a plain promotion from Ideas. */
async function defaultPromote(trackerId: string, by: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (await reapproval.hasPendingReapproval(trackerId)) {
    return (await reapproval.promoteReapproval(trackerId, by))
      ? { ok: true }
      : { ok: false, status: 409, error: "The issue changed since it was read — reload and try again." };
  }
  return (await clawsIssues.promoteIssue(trackerId, by, "ideas"))
    ? { ok: true }
    : { ok: false, status: 409, error: "The issue changed since it was read — reload and try again." };
}

/**
 * Set issue `repo#ref`'s approval to `through`, as `by`: the one write behind
 * every approval surface. `ref` is a native id or a forge number, whose
 * approval lives on its shadow.
 *
 * - Raising to Requirements or beyond from Ideas promotes the issue first
 *   ({@link ApplyIssueApprovalOptions.promote}), as does approving through
 *   Requirements there. Restating a Plan or Merge value never promotes: a
 *   withdrawal that leaves a pre-approval as it was approves no requirements.
 * - Raising to Plan or beyond while a design change is pending approves the
 *   change as `by` (`reapproval.approveReapproval`).
 * - Raising to Merge writes `merge_approved_by` / `merge_approved_at` on every
 *   open PR row; the next PR Claws opens inherits the issue's value.
 * - Lowering below Merge — or restating a lower value while every open PR row
 *   is approved, or with `clearMergeRows` — clears those row columns, along
 *   with any board infra merge approval.
 * - Lowering below Plan leaves the lifecycle alone: an issue in
 *   `awaiting-plan-review` moves from Approved back to Awaiting plan review.
 * - Lowering to `none` is refused (400): an issue leaves Requirements only by
 *   being sent back to Ideas, which is the demotion's write. Restating `none`
 *   on an issue already there only clears approved PR rows, as above — the
 *   way a partial Merge given by single-PR approvals is withdrawn.
 *
 * Posts one Claws comment naming the gate and who set it on a raise, or the
 * withdrawal on a lower; nothing when nothing changed.
 */
export async function applyIssueApproval(
  repo: string,
  ref: IssueRef,
  through: ApprovedThrough,
  by: string,
  opts: ApplyIssueApprovalOptions = {},
): Promise<ApprovalWriteResult> {
  const refuseNone = { ok: false, status: 400, error: "Approval cannot be withdrawn below Requirements — send the issue back to Ideas instead." } as const;
  try {
    const trackerId = await resolveTrackerId(repo, ref, through === "none" ? undefined : opts.create);
    if (!trackerId) return through === "none" ? refuseNone : { ok: false, status: 404, error: `No tracker record for ${repo}#${ref}` };
    const record = await db.getClawsIssue(trackerId);
    if (!record) return { ok: false, status: 404, error: `No such issue ${trackerId}` };
    const before: ApprovedThrough = record.approved_through ?? "none";
    if (through === "none" && before !== "none") return refuseNone;

    const raises = approvalRank(through) > approvalRank(before) || (through === "requirements" && before === "requirements");
    if (record.lifecycle === "ideas" && record.requirements_approved_at == null && raises) {
      const promoted = await (opts.promote ?? (() => defaultPromote(trackerId, by)))();
      if (!promoted.ok) return promoted;
    } else if (atLeast(through, "plan") && await reapproval.hasPendingReapproval(trackerId)) {
      await reapproval.approveReapproval(trackerId, by);
    }

    const changed = await clawsIssues.setApprovedThrough(trackerId, through, by);
    const { openPrs } = await loadIssueFlight(repo, ref);
    const rowsAllApproved = openPrs.length > 0 && openPrs.every((pr) => !!pr.mergeApprovedAt);
    let rowsChanged = false;
    if (through === "merge") {
      const approvedAt = new Date().toISOString();
      for (const pr of openPrs) {
        if (pr.mergeApprovedAt) continue;
        await db.upsertClawsPr(pr.repo, pr.prNumber, { mergeApprovedBy: by, mergeApprovedAt: approvedAt });
        rowsChanged = true;
      }
    } else if (atLeast(before, "merge") || opts.clearMergeRows || (rowsAllApproved && approvalRank(through) <= approvalRank(before))) {
      // Withdrawing the merge withdraws a board infra approval too; applying it never sets one.
      rowsChanged = (await db.clearPrMergeApprovals(openPrs)) > 0;
    }

    if ((changed || rowsChanged) && opts.comment !== false) {
      await postApprovalComment(repo, ref, before, through, by, opts, rowsChanged && through !== "merge");
    }
    if (changed || rowsChanged) log.info(`[issue-approval] ${repo}#${ref}: approved through ${through} by ${by} (was ${before}; ${openPrs.length} open PR row(s))`);
    return { ok: true, trackerId, before, after: through, changed: changed || rowsChanged, openPrs: openPrs.length };
  } catch (err) {
    return { ok: false, status: 500, error: String(err) };
  }
}

/** The one-line approval or withdrawal comment. Best-effort: the write has landed. */
async function postApprovalComment(
  repo: string,
  ref: IssueRef,
  before: ApprovedThrough,
  after: ApprovedThrough,
  by: string,
  opts: ApplyIssueApprovalOptions,
  mergeWithdrawn: boolean,
): Promise<void> {
  const at = new Date().toISOString();
  const why = opts.reason ? ` ${opts.reason}` : "";
  const body = approvalRank(after) > approvalRank(before) || (after === before && !mergeWithdrawn)
    ? `${APPROVAL_COMMENT_PREFIX} ${GATE_WORD[after]}** by \`${by}\` at ${at}.${after === "merge" ? " Claws merges each PR on green CI and a clean review." : after === "plan" ? " Claws implements the plan without stopping for review." : ""}${why}`
    : `${APPROVAL_WITHDRAWN_PREFIX} by \`${by}\` at ${at}: approved through ${GATE_WORD[after]} only (was ${GATE_WORD[before]}).${atLeast(before, "merge") || mergeWithdrawn ? " The merge approval is withdrawn." : ""}${!atLeast(after, "plan") && atLeast(before, "plan") ? " The plan stops for review." : ""}${why}`;
  try {
    await gh.commentOnIssue(repo, ref, body, opts.agentName ? { agentName: opts.agentName } : undefined);
  } catch (err) {
    log.warn(`[issue-approval] ${repo}#${ref}: failed to post the approval comment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The approval Claws reads for issue `repo#ref`: a native issue's own record,
 * or a forge issue's shadow. `none` with no tracker record. `at` (when the
 * value was last set) and `planAt` (when it last rose through Plan, null
 * below Plan) are ISO 8601.
 */
export async function readIssueApproval(repo: string, ref: IssueRef): Promise<{ trackerId: string | null; approvedThrough: ApprovedThrough; by: string | null; at: string | null; planAt: string | null }> {
  const trackerId = await resolveTrackerId(repo, ref);
  const record = trackerId ? await db.getClawsIssue(trackerId) : undefined;
  return {
    trackerId,
    approvedThrough: record?.approved_through ?? "none",
    by: record?.approved_through_by ?? null,
    at: record?.approved_through_at ? clawsIssues.toIso(record.approved_through_at) : null,
    planAt: record?.plan_approved_at ? clawsIssues.toIso(record.plan_approved_at) : null,
  };
}

/**
 * Withdraw issue `repo#ref`'s Plan approval as `by`: lower it to Requirements
 * when it is approved through Plan or beyond, through
 * {@link applyIssueApproval}. A lower approval is left as it is — "lowering"
 * it to Requirements would raise it, promoting an issue still in Ideas — and
 * reads `changed: false`.
 */
export async function withdrawPlanApproval(
  repo: string,
  ref: IssueRef,
  by: string,
  opts: ApplyIssueApprovalOptions = {},
): Promise<ApprovalWriteResult> {
  try {
    const approval = await readIssueApproval(repo, ref);
    if (!atLeast(approval.approvedThrough, "plan")) {
      return { ok: true, trackerId: approval.trackerId ?? "", before: approval.approvedThrough, after: approval.approvedThrough, changed: false, openPrs: 0 };
    }
  } catch (err) {
    return { ok: false, status: 500, error: String(err) };
  }
  return await applyIssueApproval(repo, ref, "requirements", by, opts);
}
