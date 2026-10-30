/**
 * Parking an issue in Blocked while its PR cannot move on without a person
 * (#clw_01M4TJEHAP19S2N3SE6EHE6VNA). A PR is stalled (`isStalledPr`) when it
 * is at `problematic` (its CI-fix budget ran out) or carries a CI-blocked
 * reason (the Billing label). The board has no column for that: the issue the
 * PR implements is parked in Blocked with a reason naming the PR, and released
 * by Claws once the PR is back in the normal flow.
 *
 * A third cause is an operator step CI depends on
 * (#clw_01M61A554ED0300Q1J0WKZJPSG): a PR holding an operator step
 * (`isOperatorStepHold`) whose CI is failing and whose CI fixer gave up on
 * the current head cannot move until the operator does the step. When none of
 * the issue's other steps is ready or in flight the issue is parked the same
 * way; otherwise it gets one `## Waiting on an operator step` comment and keeps
 * working those steps. The park is released once the hold is cleared, CI stops
 * failing, or the PR merges or closes. Nothing here reads or writes the hold
 * beyond checking it, so the issue leaving Blocked never lifts it.
 *
 * A park is recognised only by the issue's current stored `blocked_reason`
 * matching {@link parsePrStallReason}, so an issue the operator or another
 * Claws step re-blocked afterwards is never released here. Parking only moves
 * the issue: pr-dispatcher, review and the Problematic PR Diagnoser keep
 * working the PR, which they revalidate on the PR's own state.
 */

import { createHash } from "node:crypto";
import { LABELS } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { hasActiveAgentWork, hasNeedsHumanMarker, needsHumanMarker, parkForHuman } from "./issue-handback.js";
import { isStalledPr } from "./issue-board.js";
import { isOperatorStepHold, issueRefForTracker, linkedIssue } from "./pr-hold.js";
import { loadIssuePhaseState } from "./planned-prs.js";
import type { IssueRef } from "./issue-id.js";
import { LABEL_BILLING_REASON } from "./pr-state.js";

/**
 * Why a PR is stalled: problematic outranks CI-blocked when both apply, and
 * both outrank an operator step CI cannot pass without.
 */
export type PrStallCause = "problematic" | "ci-blocked" | "operator-step";

type StallRow = Pick<db.ClawsPrRecord, "stage" | "ciBlockedReason" | "needsHumanReview">;

/** The problematic or CI-blocked cause of an open row, or null when it has neither. */
export function prStallCause(row: StallRow): Exclude<PrStallCause, "operator-step"> | null {
  if (!isStalledPr(row)) return null;
  return row.stage === "problematic" ? "problematic" : "ci-blocked";
}

/**
 * The operator-step hold text of a row whose CI cannot pass until the step is
 * done — the hold is an operator step, CI is failing, and a CI-fixer run gave
 * up on the row's current head — or null. The cheap row checks come first, so
 * only a held PR with failing CI costs a database read.
 */
export async function operatorStepCiStall(
  row: Pick<db.ClawsPrRecord, "repo" | "prNumber" | "headSha" | "ciStatus" | "manualActionReason">,
): Promise<string | null> {
  const hold = row.manualActionReason;
  if (!isOperatorStepHold(hold) || hold === null) return null;
  if (row.ciStatus !== "failing" || !row.headSha) return null;
  return await db.hasCiFixerGiveUpOnHead(row.repo, row.prNumber, row.headSha) ? hold : null;
}

/** The stall of a row with the reason's detail (CI-blocked reason or hold text), any cause, or null. */
async function rowStall(row: db.ClawsPrRecord): Promise<{ cause: PrStallCause; detail: string | null } | null> {
  const cause = prStallCause(row);
  if (cause) return { cause, detail: row.ciBlockedReason };
  const hold = await operatorStepCiStall(row);
  return hold === null ? null : { cause: "operator-step", detail: hold };
}

/** A hold's text on one line with no trailing full stop, for a reason or comment. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
}

/** How a recorded CI-blocked reason reads to an operator. */
function ciBlockedCause(reason: string | null): string {
  return reason === LABEL_BILLING_REASON ? "CI spending limit" : reason ?? "unknown";
}

/**
 * The Blocked reason of an issue parked for its stalled PR. `detail` is the
 * recorded CI-blocked reason for `ci-blocked` and the hold text for
 * `operator-step`.
 */
export function prStallReason(prFullName: string, prNumber: number, cause: PrStallCause, detail: string | null = null): string {
  const pr = `PR \`${prFullName}#${prNumber}\``;
  if (cause === "problematic") {
    return `${pr} exhausted its CI-fix budget: unmark it problematic (PRs page or claws_unmark_problematic) or fix CI by hand. Claws moves this issue out of Blocked on its own once the PR is back in the normal flow.`;
  }
  if (cause === "operator-step") {
    return `${pr} cannot pass CI until its operator step is done: ${oneLine(detail ?? "")}. ` +
      "Do the step, press Clear manual action for that PR on /prs (or have a session call claws_clear_pr_manual_action), " +
      "then re-run the failed CI job: Claws does not retry a head its CI fixer gave up on. " +
      "Claws moves this issue out of Blocked on its own once the hold is cleared or CI passes; moving it out by hand does not lift the hold.";
  }
  return `${pr}: CI is blocked: ${ciBlockedCause(detail)}. Clear the cause; removing the ${LABELS.billing} label on the forge does nothing. Claws moves this issue out of Blocked on its own once the PR's recorded CI block is cleared.`;
}

/** The park slug: one per cause and PR, so a re-park after a manual unblock posts no new comment. */
export function prStallSlug(prFullName: string, prNumber: number, cause: PrStallCause): string {
  return `pr-stall-${cause}-${prFullName.replace(/\//g, "-")}-${prNumber}`;
}

const PR_STALL_REASON_RE = /^PR `([^`]+)#(\d+)`(?:( exhausted its CI-fix budget)|(: CI is blocked)| cannot pass CI until its operator step is done)/;

/**
 * The PR and cause a {@link prStallReason} names, or null for any other
 * reason — the ready-to-merge operator-step reason
 * (``PR `x#n` is ready to merge but…``) included.
 */
export function parsePrStallReason(reason: string | null | undefined): { repo: string; prNumber: number; cause: PrStallCause } | null {
  const match = reason?.match(PR_STALL_REASON_RE);
  if (!match) return null;
  const cause: PrStallCause = match[3] ? "problematic" : match[4] ? "ci-blocked" : "operator-step";
  return { repo: match[1]!, prNumber: Number(match[2]), cause };
}

/** The comment slug of an operator-step CI stall left unparked: one per PR and hold text. */
export function operatorStepCiSlug(prNumber: number, hold: string): string {
  return `operator-step-ci-${prNumber}-${createHash("sha256").update(hold).digest("hex").slice(0, 8)}`;
}

/**
 * Whether the issue has work that does not wait on PR `prNumber` (plan step
 * `phase`): a plan step ready to start, another step's open PR, or a re-plan
 * or implementer in flight.
 */
async function hasIndependentWork(
  issue: { repo: string; ref: IssueRef },
  comments: { body: string; login: string }[],
  prNumber: number,
  phase: number | null,
): Promise<boolean> {
  const { coverage } = await loadIssuePhaseState(issue.repo, issue.ref, comments);
  if (coverage.readyPhases.length > 0) return true;
  const otherOpen = coverage.openPhases.some((p) => p !== phase && coverage.coveringPRs.get(p)?.number !== prNumber);
  return otherOpen || await hasActiveAgentWork(issue.repo, issue.ref);
}

/**
 * Park the issue `pr` implements in Blocked while the PR is stalled. Nothing
 * happens when the row is not stalled, the PR has no linked issue (a Renovate
 * PR stays visible on `/prs` alone), or the issue is closed or already
 * Blocked — for this PR or for anything else, whose reason is never
 * overwritten. An issue a person moved out of Blocked while the PR is still
 * stalled is parked again with the same reason, and the slug keeps it to one
 * `## Needs a human` comment.
 *
 * An operator step CI cannot pass without parks the issue only when nothing
 * else on it is ready or in flight; otherwise the issue gets one
 * `## Waiting on an operator step` comment per PR and hold text and carries on.
 */
export async function settlePrStallPark(
  prFullName: string,
  pr: Pick<gh.PR, "number" | "headRefName">,
  row: db.ClawsPrRecord,
): Promise<void> {
  const stall = await rowStall(row);
  if (!stall) return;
  const issue = await linkedIssue(prFullName, row.issueId, pr.headRefName);
  if (!issue) return;
  const state = await gh.getIssueState(issue.repo, issue.ref);
  if (state.state !== "OPEN" || state.labels.includes(LABELS.blocked)) return;
  const reason = prStallReason(prFullName, pr.number, stall.cause, stall.detail);
  const slug = prStallSlug(prFullName, pr.number, stall.cause);
  if (stall.cause !== "operator-step") {
    await parkForHuman(issue.repo, issue.ref, reason, "PR Dispatcher", { slug });
    return;
  }

  const comments = await gh.getIssueComments(issue.repo, issue.ref);
  if (!await hasIndependentWork(issue, comments, pr.number, row.phase)) {
    await parkForHuman(issue.repo, issue.ref, reason, "PR Dispatcher", { slug, comments });
    return;
  }
  const hold = stall.detail ?? "";
  const noticeSlug = operatorStepCiSlug(pr.number, hold);
  if (hasNeedsHumanMarker(comments, noticeSlug)) return;
  const step = row.phase != null ? ` (step ${row.phase})` : "";
  await gh.commentOnIssue(issue.repo, issue.ref, [
    "## Waiting on an operator step",
    "",
    `PR \`${prFullName}#${pr.number}\`${step} cannot pass CI until its operator step is done: ${oneLine(hold)}. ` +
      "Claws keeps working this issue's other steps. " +
      "When the step is done, press **Clear manual action** for that PR on /prs, or have a session call " +
      "`claws_clear_pr_manual_action`, then re-run the failed CI job: Claws does not retry a head its CI fixer gave up on. " +
      "Moving this issue out of Blocked does not lift the hold.",
    "",
    needsHumanMarker(noticeSlug),
  ].join("\n"), { agentName: "PR Dispatcher" });
  log.info(`[pr-stall-park] Told ${issue.repo}#${issue.ref} that ${prFullName}#${pr.number}'s CI waits on an operator step (${noticeSlug})`);
}

/** Why a cleared PR is back in the normal flow, for the release comment. */
function clearedWhy(row: db.ClawsPrRecord | null, cause: PrStallCause): string {
  if (!row || row.stage === "closed") return "closed";
  if (row.stage === "merged") return "merged";
  if (cause === "operator-step") {
    if (!isOperatorStepHold(row.manualActionReason)) return "its manual action cleared";
    return row.ciStatus === "passing" || row.ciStatus === "none" ? "CI passing" : "CI no longer failing on the head the CI fixer gave up on";
  }
  return cause === "problematic" ? "unmarked problematic" : "CI unblocked";
}

/**
 * Release every issue parked by {@link settlePrStallPark} whose PR is back
 * in the normal flow: unmarked problematic, CI unblocked, its operator-step
 * hold cleared or CI no longer failing, merged or closed. The PR's hold is
 * never touched.
 * While the named PR is still stalled nothing happens. When it has cleared
 * but another of the issue's open PRs is stalled, the park moves to that PR.
 * Otherwise `Blocked` comes off — re-read live first, so a shadow lagging its
 * forge issue is not released twice — with one comment saying why. Each
 * issue's failure is logged and the rest carry on.
 */
export async function releasePrStallParks(): Promise<void> {
  for (const candidate of await db.listPrStallParkCandidates()) {
    try {
      const parked = parsePrStallReason(candidate.blocked_reason);
      if (!parked) continue;
      const row = await db.getClawsPr(parked.repo, parked.prNumber);
      const open = !!row && row.stage !== "merged" && row.stage !== "closed";
      if (open && (parked.cause === "operator-step" ? await operatorStepCiStall(row) !== null : prStallCause(row))) continue;

      const issue = await issueRefForTracker(candidate.id);
      if (!issue) continue;
      const state = await gh.getIssueState(issue.repo, issue.ref);
      if (state.state !== "OPEN" || !state.labels.includes(LABELS.blocked)) continue;

      let next: { r: db.ClawsPrRecord; stall: { cause: PrStallCause; detail: string | null } } | null = null;
      for (const r of await db.listOpenClawsPrsForIssue(candidate.id)) {
        const stall = await rowStall(r);
        if (stall) { next = { r, stall }; break; }
      }
      if (next) {
        await parkForHuman(issue.repo, issue.ref, prStallReason(next.r.repo, next.r.prNumber, next.stall.cause, next.stall.detail),
          "PR Dispatcher", { slug: prStallSlug(next.r.repo, next.r.prNumber, next.stall.cause) });
        continue;
      }

      await gh.removeLabel(issue.repo, issue.ref, LABELS.blocked);
      await gh.commentOnIssue(issue.repo, issue.ref,
        `PR \`${parked.repo}#${parked.prNumber}\` is back in the normal flow (${clearedWhy(row, parked.cause)}), so Claws has moved this issue out of \`${LABELS.blocked}\`.`,
        { agentName: "PR Dispatcher" });
      log.info(`[pr-stall-park] Released ${issue.repo}#${issue.ref}: ${parked.repo}#${parked.prNumber} is ${clearedWhy(row, parked.cause)}`);
    } catch (err) {
      log.warn(`[pr-stall-park] Could not settle the PR-stall park of ${candidate.id}: ${err}`);
    }
  }
}
