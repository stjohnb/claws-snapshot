/**
 * PR holds — keeping a PR from merging until a person acts, through the
 * reason recorded on its `claws_prs` row (`manual_action_reason`). A hold is
 * a merge gate only: it sets no stage and no forge label, so CI-fix and
 * review work the PR as normal and its stage keeps tracking them
 * (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK).
 *
 * The reason's prefix names the hold's kind:
 *
 * - an operator step (the plan's `manual_action_before_merge`, the
 *   implementer's marker, or the legacy generic `manual action`) — no prefix;
 *   it gates only that PR's merge and does not park the issue, whose other
 *   steps carry on. {@link settleOperatorStepHold} tells the linked issue
 *   once per PR and step when the PR is otherwise ready to merge; a step CI
 *   cannot pass without (CI failing, CI fixer gave up on the head) is
 *   `pr-stall-park.ts`'s operator-step park instead, which parks the issue
 *   only when none of its other steps is ready or in flight. Only
 *   {@link clearPrHold} through the dashboard's Clear manual action button
 *   or the session tool `claws_clear_pr_manual_action` lifts it — never the
 *   issue leaving Blocked;
 * - a reviewer escalation ({@link ESCALATION_REASON_PREFIX});
 * - a re-approval hold ({@link REAPPROVAL_HOLD_PREFIX});
 * - a stacked PR ({@link STACKED_PREFIX});
 * - a refused CI re-run ({@link CI_RERUN_REFUSED_PREFIX}).
 *
 * The last four clear themselves when their condition resolves, each through
 * {@link clearPrHold} with its own prefix, so none ever lifts another kind's
 * hold. A new hold never overwrites a different kind's, so a PR keeps one
 * reason at a time; the auto-merger checks a stacked base and a pending
 * re-approval directly as well, so those stay in force when a refused hold of
 * theirs is lost behind an operator step that is later lifted.
 */

import { createHash } from "node:crypto";
import { isClawsIssueId } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import * as clawsIssues from "./claws-issues.js";
import { hasNeedsHumanMarker, needsHumanMarker, parkForHuman } from "./issue-handback.js";
import { isReviewedHeadAwaitingMerge } from "./pr-state.js";
import { ISSUE_REF_PATTERN, canonicalIssueRef, type IssueRef } from "./issue-id.js";

/** How every re-approval hold's recorded reason starts. */
export const REAPPROVAL_HOLD_PREFIX = "Held for re-approval:";
/** How a reviewer escalation's recorded reason starts. */
export const ESCALATION_REASON_PREFIX = "review escalated: ";
/** How a stacked PR's recorded reason starts. */
export const STACKED_PREFIX = "Stacked PR:";
/** How a refused CI re-run's recorded reason starts. */
export const CI_RERUN_REFUSED_PREFIX = "CI re-run refused:";

const SELF_CLEARING_PREFIXES = [REAPPROVAL_HOLD_PREFIX, ESCALATION_REASON_PREFIX, STACKED_PREFIX, CI_RERUN_REFUSED_PREFIX] as const;

/** A hold's kind: the self-clearing prefix its reason starts with, or `operator-step`. */
function holdKind(reason: string): string {
  return SELF_CLEARING_PREFIXES.find((p) => reason.startsWith(p)) ?? "operator-step";
}

/** Whether `reason` is an operator step before merge — none of the self-clearing kinds. */
export function isOperatorStepHold(reason: string | null | undefined): boolean {
  return !!reason && holdKind(reason) === "operator-step";
}

/**
 * Hold a PR from merging: record `reason` on its `claws_prs` row. No stage
 * and no label. The auto-merger refuses a PR whose row carries a reason even
 * when the merge is approved. A different kind's hold already on the row is
 * kept and this returns false; a hold of the same kind is replaced.
 */
export async function recordPrHold(prFullName: string, prNumber: number, reason: string): Promise<boolean> {
  const existing = (await db.getClawsPr(prFullName, prNumber))?.manualActionReason ?? null;
  if (existing !== null && holdKind(existing) !== holdKind(reason)) {
    log.info(`[pr-hold] ${prFullName}#${prNumber} already holds "${existing}" — not recording "${reason}"`);
    return false;
  }
  await db.upsertClawsPr(prFullName, prNumber, { manualActionReason: reason });
  log.info(`[pr-hold] Held ${prFullName}#${prNumber}: ${reason}`);
  return true;
}

/**
 * Lift a PR's hold. With `prefix`, only a reason starting with it is lifted.
 * Returns whether a hold was lifted.
 */
export async function clearPrHold(prFullName: string, prNumber: number, prefix?: string): Promise<boolean> {
  const reason = (await db.getClawsPr(prFullName, prNumber))?.manualActionReason ?? null;
  if (reason === null) return false;
  if (prefix !== undefined && !reason.startsWith(prefix)) return false;
  await db.upsertClawsPr(prFullName, prNumber, { manualActionReason: null });
  log.info(`[pr-hold] Lifted the hold on ${prFullName}#${prNumber}: ${reason}`);
  return true;
}

const ISSUE_BRANCH_RE = new RegExp(`^claws/issue-(${ISSUE_REF_PATTERN})-`);

/**
 * Where a tracker issue lives: a shadow's forge issue, or a native issue's
 * primary repo. Null when the issue is unknown or names no repository.
 */
export async function issueRefForTracker(trackerId: string): Promise<{ repo: string; ref: IssueRef } | null> {
  const record = await db.getClawsIssue(trackerId);
  if (record?.kind === "shadow") {
    const link = await db.getImportedIssueByNative(trackerId);
    return link ? { repo: link.repo, ref: link.forgeNumber } : null;
  }
  if (record && record.repos.length > 0) return { repo: clawsIssues.primaryRepo(record), ref: trackerId };
  return null;
}

/**
 * Where the issue a PR implements lives: from the row's tracker id (a
 * shadow's forge issue, or a native issue's primary repo), else from a
 * `claws/issue-<ref>-…` head branch. Null when the PR has no linked issue.
 */
export async function linkedIssue(
  prFullName: string,
  issueId: string | null | undefined,
  headRefName?: string,
): Promise<{ repo: string; ref: IssueRef } | null> {
  if (issueId) {
    const issue = await issueRefForTracker(issueId);
    if (issue) return issue;
  }
  const match = headRefName?.match(ISSUE_BRANCH_RE);
  const ref = match ? canonicalIssueRef(match[1]!) : null;
  if (ref === null) return null;
  if (!isClawsIssueId(ref)) return { repo: prFullName, ref };
  const record = await clawsIssues.getIssue(ref);
  if (!record || record.repos.length === 0) return null;
  return { repo: clawsIssues.primaryRepo(record), ref };
}

/**
 * Park the issue a PR implements in Blocked with `reason` (see
 * `parkForHuman`), once per `slug`. Returns false when the PR has no linked
 * issue — a Renovate PR, say — whose hold then only gates the merge.
 */
export async function blockLinkedIssue(
  prFullName: string,
  prNumber: number,
  reason: string,
  slug: string,
  opts: { headRefName?: string; agentName?: string } = {},
): Promise<boolean> {
  const row = await db.getClawsPr(prFullName, prNumber);
  const issue = await linkedIssue(prFullName, row?.issueId, opts.headRefName);
  if (!issue) {
    log.info(`[pr-hold] ${prFullName}#${prNumber} has no linked issue to block (${slug})`);
    return false;
  }
  await parkForHuman(issue.repo, issue.ref, reason, opts.agentName ?? "PR Dispatcher", { slug });
  return true;
}

/** The notice slug of an operator-step hold: one per PR and step text, so a new step is told again. */
export function operatorStepSlug(prNumber: number, reason: string): string {
  return `operator-step-${prNumber}-${createHash("sha256").update(reason).digest("hex").slice(0, 8)}`;
}

/**
 * `${repo}#${pr}:${slug}` keys whose operator-step notice is already on the
 * issue, so a merge-ready held PR costs no forge reads on later ticks. After
 * a restart the first tick re-reads the issue's comments once.
 */
const operatorStepNotices = new Set<string>();

/** Forget the operator-step notices seen in this process — for tests. */
export function resetOperatorStepNotices(): void {
  operatorStepNotices.clear();
}

/**
 * Settle a PR's operator-step hold. The hold only gates this PR's merge: the
 * issue is never parked, so Claws keeps implementing, reviewing and merging
 * its other steps (#clw_01M5220Y7EWQG1X0H3Y3T45J81). Once the PR is otherwise
 * ready to merge — a clean review of its current head and CI passing or
 * absent — the linked issue gets one `## Waiting on an operator step` comment
 * per PR and step text. Nothing here lifts the hold, and neither does the
 * issue leaving Blocked; only {@link clearPrHold} through the dashboard's
 * Clear manual action button or the session tool
 * `claws_clear_pr_manual_action` does. The cheap row checks come first, so a
 * PR with no operator step costs no API calls. A held PR whose CI cannot pass
 * until the step is done never gets here; `settlePrStallPark` in
 * `pr-stall-park.ts` handles it.
 */
export async function settleOperatorStepHold(
  prFullName: string,
  pr: Pick<gh.PR, "number" | "headRefName" | "headRefOid">,
  row: db.ClawsPrRecord,
): Promise<void> {
  const reason = row.manualActionReason;
  if (!isOperatorStepHold(reason) || reason === null) return;
  if (!isReviewedHeadAwaitingMerge(row, pr.headRefOid)) return;
  if (row.ciStatus !== "passing" && row.ciStatus !== "none") return;
  const slug = operatorStepSlug(pr.number, reason);
  const key = `${prFullName}#${pr.number}:${slug}`;
  if (operatorStepNotices.has(key)) return;
  const issue = await linkedIssue(prFullName, row.issueId, pr.headRefName);
  if (!issue) return;
  const state = await gh.getIssueState(issue.repo, issue.ref);
  if (state.state !== "OPEN") return;
  const comments = await gh.getIssueComments(issue.repo, issue.ref);
  if (hasNeedsHumanMarker(comments, slug)) {
    operatorStepNotices.add(key);
    return;
  }
  const step = row.phase != null ? ` (step ${row.phase})` : "";
  await gh.commentOnIssue(issue.repo, issue.ref, [
    "## Waiting on an operator step",
    "",
    `PR \`${prFullName}#${pr.number}\`${step} is ready to merge but waits on an operator step: ${reason}. ` +
      "Claws keeps implementing, reviewing and merging this issue's other steps. " +
      "When the step is done, press **Clear manual action** for that PR on /prs, or have a session call " +
      "`claws_clear_pr_manual_action`; Claws then merges it under the usual rules. " +
      "Moving this issue out of Blocked does not lift the hold.",
    "",
    needsHumanMarker(slug),
  ].join("\n"), { agentName: "PR Dispatcher" });
  operatorStepNotices.add(key);
  log.info(`[pr-hold] Told ${issue.repo}#${issue.ref} that ${prFullName}#${pr.number} waits on an operator step (${slug})`);
}

/**
 * Hold a PR a pending design change would close or rework, with a reason
 * starting {@link REAPPROVAL_HOLD_PREFIX}. A PR already holding some other
 * kind of hold — an operator's, or the plan's own operator step — is left as
 * it is: it cannot merge either way, and that reason must survive the
 * re-approval. The issue already waits in re-approval, so it is not parked.
 * Returns whether this call recorded the hold.
 */
export async function holdForReapproval(prFullName: string, prNumber: number, detail: string, issueLabel: string): Promise<boolean> {
  const recorded = await recordPrHold(prFullName, prNumber, `${REAPPROVAL_HOLD_PREFIX} ${detail}`);
  if (!recorded) log.info(`[pr-hold] Left ${prFullName}#${prNumber}'s existing hold in place for the re-approval of ${issueLabel}`);
  return recorded;
}

/**
 * Lift a re-approval hold: only a reason starting with
 * {@link REAPPROVAL_HOLD_PREFIX}. A PR with no reason, or one an operator or
 * the plan recorded, is left alone. Returns whether a hold was lifted.
 */
export async function releaseReapprovalHold(prFullName: string, prNumber: number): Promise<boolean> {
  return await clearPrHold(prFullName, prNumber, REAPPROVAL_HOLD_PREFIX);
}
