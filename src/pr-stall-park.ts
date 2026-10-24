/**
 * Parking an issue in Blocked while its PR cannot move on without a person
 * (#clw_01M4TJEHAP19S2N3SE6EHE6VNA). A PR is stalled (`isStalledPr`) when it
 * is at `problematic` (its CI-fix budget ran out) or carries a CI-blocked
 * reason (the Billing label). The board has no column for that: the issue the
 * PR implements is parked in Blocked with a reason naming the PR, and released
 * by Claws once the PR is back in the normal flow.
 *
 * A park is recognised only by the issue's current stored `blocked_reason`
 * matching {@link parsePrStallReason}, so an issue the operator or another
 * Claws step re-blocked afterwards is never released here. Parking only moves
 * the issue: pr-dispatcher, review and the Problematic PR Diagnoser keep
 * working the PR, which they revalidate on the PR's own state.
 */

import { LABELS } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { parkForHuman } from "./issue-handback.js";
import { isStalledPr } from "./issue-board.js";
import { issueRefForTracker, linkedIssue } from "./pr-hold.js";
import { LABEL_BILLING_REASON } from "./pr-state.js";

/** Why a PR is stalled: problematic outranks CI-blocked when both apply. */
export type PrStallCause = "problematic" | "ci-blocked";

type StallRow = Pick<db.ClawsPrRecord, "stage" | "ciBlockedReason" | "needsHumanReview">;

/** The stall cause of an open row, or null when it is not stalled. */
export function prStallCause(row: StallRow): PrStallCause | null {
  if (!isStalledPr(row)) return null;
  return row.stage === "problematic" ? "problematic" : "ci-blocked";
}

/** How a recorded CI-blocked reason reads to an operator. */
function ciBlockedCause(reason: string | null): string {
  return reason === LABEL_BILLING_REASON ? "GitHub Actions billing/spending limit" : reason ?? "unknown";
}

/** The Blocked reason of an issue parked for its stalled PR. */
export function prStallReason(prFullName: string, prNumber: number, cause: PrStallCause, ciBlockedReason: string | null = null): string {
  const pr = `PR \`${prFullName}#${prNumber}\``;
  return cause === "problematic"
    ? `${pr} exhausted its CI-fix budget: unmark it problematic (PRs page or claws_unmark_problematic) or fix CI by hand. Claws moves this issue out of Blocked on its own once the PR is back in the normal flow.`
    : `${pr}: CI is blocked: ${ciBlockedCause(ciBlockedReason)}. Clear the cause, then remove the ${LABELS.billing} label from the PR. Claws moves this issue out of Blocked on its own once CI is unblocked.`;
}

/** The park slug: one per cause and PR, so a re-park after a manual unblock posts no new comment. */
export function prStallSlug(prFullName: string, prNumber: number, cause: PrStallCause): string {
  return `pr-stall-${cause}-${prFullName.replace(/\//g, "-")}-${prNumber}`;
}

const PR_STALL_REASON_RE = /^PR `([^`]+)#(\d+)`(?:( exhausted its CI-fix budget)|: CI is blocked)/;

/**
 * The PR and cause a {@link prStallReason} names, or null for any other
 * reason — the operator-step reason (``PR `x#n` is ready to merge but…``)
 * included.
 */
export function parsePrStallReason(reason: string | null | undefined): { repo: string; prNumber: number; cause: PrStallCause } | null {
  const match = reason?.match(PR_STALL_REASON_RE);
  if (!match) return null;
  return { repo: match[1]!, prNumber: Number(match[2]), cause: match[3] ? "problematic" : "ci-blocked" };
}

/**
 * Park the issue `pr` implements in Blocked while the PR is stalled. Nothing
 * happens when the row is not stalled, the PR has no linked issue (a Renovate
 * PR stays visible on `/prs` alone), or the issue is closed or already
 * Blocked — for this PR or for anything else, whose reason is never
 * overwritten. An issue a person moved out of Blocked while the PR is still
 * stalled is parked again with the same reason, and the slug keeps it to one
 * `## Needs a human` comment.
 */
export async function settlePrStallPark(
  prFullName: string,
  pr: Pick<gh.PR, "number" | "headRefName">,
  row: db.ClawsPrRecord,
): Promise<void> {
  const cause = prStallCause(row);
  if (!cause) return;
  const issue = await linkedIssue(prFullName, row.issueId, pr.headRefName);
  if (!issue) return;
  const state = await gh.getIssueState(issue.repo, issue.ref);
  if (state.state !== "OPEN" || state.labels.includes(LABELS.blocked)) return;
  await parkForHuman(issue.repo, issue.ref, prStallReason(prFullName, pr.number, cause, row.ciBlockedReason),
    "PR Dispatcher", { slug: prStallSlug(prFullName, pr.number, cause) });
}

/** Why a cleared PR is back in the normal flow, for the release comment. */
function clearedWhy(row: db.ClawsPrRecord | null, cause: PrStallCause): string {
  if (!row || row.stage === "closed") return "closed";
  if (row.stage === "merged") return "merged";
  return cause === "problematic" ? "unmarked problematic" : "CI unblocked";
}

/**
 * Release every issue parked by {@link settlePrStallPark} whose PR is back
 * in the normal flow: unmarked problematic, CI unblocked, merged or closed.
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
      if (open && prStallCause(row)) continue;

      const issue = await issueRefForTracker(candidate.id);
      if (!issue) continue;
      const state = await gh.getIssueState(issue.repo, issue.ref);
      if (state.state !== "OPEN" || !state.labels.includes(LABELS.blocked)) continue;

      const next = (await db.listOpenClawsPrsForIssue(candidate.id))
        .map((r) => ({ r, cause: prStallCause(r) }))
        .find((x) => x.cause !== null);
      if (next?.cause) {
        await parkForHuman(issue.repo, issue.ref, prStallReason(next.r.repo, next.r.prNumber, next.cause, next.r.ciBlockedReason),
          "PR Dispatcher", { slug: prStallSlug(next.r.repo, next.r.prNumber, next.cause) });
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
