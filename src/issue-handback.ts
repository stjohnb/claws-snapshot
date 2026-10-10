/**
 * Where an issue goes when Claws hands it back (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ).
 *
 * An issue with a plan is in Planning only while a planner run is queued or
 * running for it. Removing `Refined` on its own resets the stored lifecycle to
 * `planning` (`db.removeClawsIssueLabel`), and on a forge issue leaves its
 * shadow there, so every exit from the implementer and every backstop in the
 * dispatcher, merger and auditor names its destination through one of these
 * helpers instead:
 *
 * - {@link returnToPlanReview}: back to Awaiting plan review (`Ready`).
 * - {@link parkForHuman}: Blocked, with a `## Needs a human` comment and the
 *   reason stored for the board's card.
 * - {@link settleDuplicate}: closed as a duplicate.
 * - {@link settleMergedSingleStep}: closed when the merged PR closes it,
 *   otherwise (or when a human reopened it after the merge) parked for a human.
 *
 * Every helper adds the new state label before removing the old one, so a
 * failure partway leaves the issue with a label the dispatcher acts on rather
 * than with none (#2821).
 */

import { LABELS } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import * as planParser from "./plan-parser.js";
import { closesIssue } from "./phase-coverage.js";
import { resolveTrackerId } from "./planned-prs.js";
import { issueRefAliases } from "./imported-refs.js";
import { ISSUE_REF_GUARDED, canonicalIssueRef, type IssueRef } from "./issue-id.js";

/** The marker a `## Needs a human` comment carries, once per slug. */
export function needsHumanMarker(slug: string): string {
  return `claws-needs-human:${slug}`;
}

/** Whether a `## Needs a human` comment for `slug` is already on the issue. */
export function hasNeedsHumanMarker(comments: readonly { body: string }[], slug: string): boolean {
  const marker = needsHumanMarker(slug);
  return comments.some((c) => c.body.split("\n").some((line) => line.trim() === marker));
}

/** Whether a re-plan is queued or an implementer is running for the issue: it is in flight, not stranded. */
export async function hasActiveAgentWork(repo: string, ref: IssueRef): Promise<boolean> {
  return await db.hasPendingIssueRefinerWork(repo, ref) || await db.hasRunningTask("issue-worker", repo, ref);
}

/** The first merged PR whose body closes the issue under any of its ref aliases. */
export function findClosingPR<T extends { body?: string }>(repo: string, ref: IssueRef, mergedPRs: readonly T[]): T | undefined {
  const aliases = issueRefAliases(repo, ref);
  return mergedPRs.find((pr) => aliases.some((alias) => closesIssue(pr.body ?? "", alias)));
}

/** Send the issue back to Awaiting plan review: `Ready` on, then `Refined` off. */
export async function returnToPlanReview(repo: string, ref: IssueRef): Promise<void> {
  await gh.addLabel(repo, ref, LABELS.ready);
  await gh.removeLabel(repo, ref, LABELS.refined);
}

/**
 * Park the issue in Blocked for a human: add `Blocked`, remove `Refined` and
 * `Ready`, post a `## Needs a human` comment with `reason` (once per
 * `slug`), then store the reason for the board. A caller that has just
 * posted its own comment saying the same thing passes `skipComment`. The stored reason is
 * best-effort — the comment still holds it.
 */
export async function parkForHuman(
  repo: string,
  ref: IssueRef,
  reason: string,
  agentName: string,
  opts: { slug: string; comments?: readonly { body: string }[]; skipComment?: boolean },
): Promise<void> {
  const comments = opts.comments ?? await gh.getIssueComments(repo, ref);
  // Labels go first and the marker comment last: the comment is also the
  // acknowledgement that a human saw the park (see
  // {@link isAmbiguousCoverageAcknowledged}), so it must not exist unless
  // `Blocked` landed and `Refined` came off. A failed label write throws with
  // `Refined` still on and no marker, and the retry parks again.
  await gh.addLabel(repo, ref, LABELS.blocked);
  await gh.removeLabel(repo, ref, LABELS.refined);
  await gh.removeLabel(repo, ref, LABELS.ready);
  if (!opts.skipComment && !hasNeedsHumanMarker(comments, opts.slug)) {
    await gh.commentOnIssue(repo, ref, [
      `## Needs a human`,
      ``,
      reason,
      ``,
      `Claws has moved this issue to \`${LABELS.blocked}\` and will not act on it until a person does.`,
      ``,
      needsHumanMarker(opts.slug),
    ].join("\n"), { agentName });
  }
  log.info(`[issue-handback] Parked ${repo}#${ref} for a human (${opts.slug}): ${reason}`);
  try {
    const trackerId = await resolveTrackerId(repo, ref);
    if (!trackerId) return;
    // A forge issue's shadow follows its labels only on the next sync, which
    // would stamp a stage change after the reason and hide it; set it now.
    await db.setShadowLifecycle(trackerId, "blocked");
    await db.setIssueBlockedReason(trackerId, reason);
  } catch (err) {
    log.warn(`[issue-handback] Could not store the Blocked reason for ${repo}#${ref}: ${err}`);
  }
}

/** `PR #1` or `PRs #1, #2`. */
function describePRs(numbers: readonly number[]): string {
  return `${numbers.length === 1 ? "PR" : "PRs"} ${numbers.map((n) => `#${n}`).join(", ")}`;
}

/** The slug of an ambiguous-coverage park: one per distinct set of PRs. */
export function ambiguousCoverageSlug(prNumbers: readonly number[]): string {
  return `ambiguous-coverage-${[...new Set(prNumbers)].sort((a, b) => a - b).join("-")}`;
}

/**
 * Park an issue whose coverage rests on PRs Claws cannot place: an unmarked
 * PR that only references the issue, or one counted by position alone.
 *
 * Once parked, a human moving the issue back to Approved is the
 * acknowledgement: the same PR set never parks it again (see
 * {@link isAmbiguousCoverageAcknowledged}).
 */
export async function parkAmbiguousCoverage(
  repo: string,
  ref: IssueRef,
  prNumbers: readonly number[],
  comments?: readonly { body: string }[],
  opts: { allCovered?: boolean } = {},
): Promise<void> {
  const prs = [...new Set(prNumbers)].sort((a, b) => a - b);
  const one = prs.length === 1;
  const lead = `${describePRs(prs)} ${one ? "references" : "reference"} this issue without a step marker, so Claws cannot tell which step ${one ? "it" : "they"} finished — add \`claws-phase-done: <step>\` if ${one ? "it" : "they"} completed a step, close the issue if it is done, or re-plan the remainder.`;
  // At the all-covered exit these PRs already fill the plan's steps, so moving
  // the issue back to Approved keeps them counted rather than implementing again.
  const reason = opts.allCovered
    ? `${lead} Moving the issue back to Approved without doing one of these counts ${one ? "it" : "them"} as covering ${one ? "its" : "their"} step.`
    : `${lead} If ${one ? "it" : "they"} finished no step, move the issue back to Approved and Claws will implement the plan as written.`;
  await parkForHuman(repo, ref, reason, "Implementer", { slug: ambiguousCoverageSlug(prs), comments });
}

/** Whether a human already saw the ambiguous-coverage park for exactly these PRs and sent the issue on. */
export function isAmbiguousCoverageAcknowledged(comments: readonly { body: string }[], prNumbers: readonly number[]): boolean {
  return hasNeedsHumanMarker(comments, ambiguousCoverageSlug(prNumbers));
}

/** Marks the comment saying a `Duplicate` issue was closed with no canonical issue recorded. */
const NO_CANONICAL_MARKER = "claws-duplicate-of:none";

const DUPLICATE_MARKER_RE = new RegExp(`claws-duplicate-of:\\s*#?(${ISSUE_REF_GUARDED})`, "gi");

/** The canonical ref of the latest `claws-duplicate-of:<ref>` marker, or null. */
function latestDuplicateMarker(comments: readonly { body: string }[]): IssueRef | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const matches = [...comments[i].body.matchAll(DUPLICATE_MARKER_RE)];
    const last = matches.at(-1);
    if (last) return canonicalIssueRef(last[1]);
  }
  return null;
}

/**
 * Whether the issue is a duplicate Claws should close: it carries `Duplicate`,
 * or its plan is a `CLAWS_DUPLICATE_OF:` verdict that has not been closed
 * before. A plan-only verdict with a `claws-duplicate-of:` marker already
 * posted means Claws closed it once and a human reopened it and removed
 * `Duplicate` — closing it again would undo that.
 */
export function isDuplicateToSettle(
  labels: readonly { name: string }[],
  comments: readonly { body: string }[],
  planText: string | null = planParser.findPlanComment([...comments]),
): boolean {
  if (labels.some((l) => l.name === LABELS.duplicate)) return true;
  if (!planText || planParser.duplicateOfFromPlan(planText) === null) return false;
  return latestDuplicateMarker(comments) === null;
}

/**
 * Close a duplicate. The canonical issue comes from the latest
 * `claws-duplicate-of:<ref>` marker, else the plan's `CLAWS_DUPLICATE_OF:`
 * line. The issue closes as completed when the canonical one closed as
 * completed, as not planned otherwise, after `Duplicate` and the marker
 * comment go on. With no canonical issue recorded it closes as not planned
 * with a comment saying so. Returns true when it closed the issue.
 */
export async function settleDuplicate(
  repo: string,
  issue: Pick<gh.Issue, "number" | "labels">,
  comments?: readonly { body: string }[],
  agentName = "Planner",
): Promise<boolean> {
  const ref = issue.number;
  const all = comments ?? await gh.getIssueComments(repo, ref);
  const planText = planParser.findPlanComment([...all]);
  const canonical = latestDuplicateMarker(all) ?? (planText ? planParser.duplicateOfFromPlan(planText) : null);

  if (!issue.labels.some((l) => l.name === LABELS.duplicate)) {
    await gh.addLabel(repo, ref, LABELS.duplicate);
  }
  if (canonical === null) {
    if (!all.some((c) => c.body.includes(NO_CANONICAL_MARKER))) {
      await gh.commentOnIssue(repo, ref,
        `This issue is marked \`${LABELS.duplicate}\`, but no canonical issue was recorded, so Claws is closing it as not planned. Reopen it and remove \`${LABELS.duplicate}\` if it is not a duplicate.\n\n${NO_CANONICAL_MARKER}`,
        { agentName });
    }
    await gh.closeIssue(repo, ref, "not_planned");
    log.info(`[issue-handback] Closed ${repo}#${ref} as a duplicate with no canonical issue recorded`);
    return true;
  }

  let reason: "completed" | "not_planned" = "not_planned";
  try {
    const state = await gh.getIssueState(repo, canonical);
    if (state.state === "CLOSED" && state.stateReason?.toLowerCase() === "completed") reason = "completed";
  } catch (err) {
    log.warn(`[issue-handback] Could not read canonical ${repo}#${canonical} for duplicate ${ref} — closing as not planned: ${err}`);
  }

  const marker = `claws-duplicate-of:${canonical}`;
  if (!all.some((c) => c.body.includes(marker))) {
    await gh.commentOnIssue(repo, ref,
      `Closing this issue as a duplicate of #${canonical}${reason === "completed" ? ", which is already done" : ""}. Reopen it and remove \`${LABELS.duplicate}\` if it is not a duplicate.\n\n${marker}`,
      { agentName });
  }
  await gh.closeIssue(repo, ref, reason);
  log.info(`[issue-handback] Closed ${repo}#${ref} as a duplicate of #${canonical} (${reason})`);
  return true;
}

/**
 * Settle a single-step plan whose PR has merged while the issue is still
 * open: close it when a merged PR's body closes the issue, otherwise park it
 * for a human — a `Part of` PR may have done only part of the work, so it is
 * never auto-closed. Returns what it did.
 */
export async function settleMergedSingleStep(
  repo: string,
  ref: IssueRef,
  mergedPRs: readonly { number: number; body?: string; mergedAt?: string }[],
): Promise<"closed" | "parked" | "none"> {
  if (mergedPRs.length === 0) return "none";
  if ((await gh.getIssueState(repo, ref)).state !== "OPEN") return "none";
  const closer = findClosingPR(repo, ref, mergedPRs);
  if (closer) {
    // A human who reopened the issue after the merge meant it to stay open.
    const reopenedAt = closer.mergedAt ? await gh.getLastReopenedAt(repo, ref) : null;
    if (closer.mergedAt && reopenedAt && Date.parse(reopenedAt) > Date.parse(closer.mergedAt)) {
      await parkForHuman(repo, ref,
        `PR #${closer.number} merged saying it closes this issue, but it was reopened afterwards — Claws will not close it again. Re-plan the remaining work, or close it if it is done.`,
        "Implementer", { slug: `reopened-after-merge-${closer.number}` });
      return "parked";
    }
    await gh.closeIssue(repo, ref, "completed");
    log.info(`[issue-handback] Closed ${repo}#${ref}: its single-step plan's PR #${closer.number} merged saying it closes it`);
    return "closed";
  }
  const numbers = [...new Set(mergedPRs.map((pr) => pr.number))].sort((a, b) => a - b);
  await parkForHuman(repo, ref,
    `${describePRs(numbers)} merged without closing this issue — close it if the work is done, or re-plan the remainder.`,
    "Implementer", { slug: ambiguousCoverageSlug(numbers) });
  return "parked";
}
