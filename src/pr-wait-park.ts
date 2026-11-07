/**
 * Parking an issue in Blocked while every remaining step waits on an open PR
 * to merge (#clw_01M4XWHG3A2Q5Y06GN2SC7K06X) — typically a step committed
 * onto another issue's PR through `CLAWS_TARGET_PR`, with the next step
 * depending on it. The implementer parks it (`parkWaitingOnPRs`) with a
 * reason naming the PRs, and the PR dispatcher releases it here once they
 * merge, or hands it to a person when one closes unmerged.
 *
 * As in `pr-stall-park.ts`, a park is recognised only by the issue's current
 * stored `blocked_reason` matching {@link parsePrWaitReason}, so an issue the
 * operator or another Claws step re-blocked afterwards is never released here.
 */

import { LABELS } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { parkForHuman } from "./issue-handback.js";
import { issueRefForTracker } from "./pr-hold.js";
import type { IssueRef } from "./issue-id.js";

/** A PR an issue waits on, by its full repo name. */
export interface WaitedPR {
  repo: string;
  number: number;
}

/** The PRs once each, by repo then number. */
function normalise(prs: readonly WaitedPR[]): WaitedPR[] {
  const seen = new Map<string, WaitedPR>();
  for (const pr of prs) seen.set(`${pr.repo}#${pr.number}`, { repo: pr.repo, number: pr.number });
  return [...seen.values()].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.number - b.number));
}

/** ``Waiting on `A#1` to merge`` or ``Waiting on `A#1`, `B#2` and `C#3` to merge``. */
export function prWaitReason(prs: readonly WaitedPR[]): string {
  const names = normalise(prs).map((pr) => `\`${pr.repo}#${pr.number}\``);
  const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Waiting on ${list} to merge`;
}

/** The park slug: one per distinct PR set, so repeated runs post one comment. */
export function prWaitSlug(prs: readonly WaitedPR[]): string {
  return `waiting-on-prs-${normalise(prs).map((pr) => `${pr.repo.replace(/\//g, "-")}-${pr.number}`).join("-")}`;
}

const PR_WAIT_REASON_RE = /^Waiting on ((?:`[^`]+#\d+`(?:, | and )?)+) to merge$/;
const PR_WAIT_NAME_RE = /`([^`]+)#(\d+)`/g;

/** The PRs a {@link prWaitReason} names, or null for any other reason. */
export function parsePrWaitReason(reason: string | null | undefined): WaitedPR[] | null {
  const match = reason?.match(PR_WAIT_REASON_RE);
  if (!match) return null;
  return [...match[1]!.matchAll(PR_WAIT_NAME_RE)].map((m) => ({ repo: m[1]!, number: Number(m[2]) }));
}

/**
 * Settle a closed-unmerged waited PR: clear the stored step target that
 * pointed at it, then park the issue for a person to re-plan or re-approve.
 */
async function parkClosedUnmerged(trackerId: string, issue: { repo: string; ref: IssueRef }, pr: WaitedPR): Promise<void> {
  const entries = await db.getIssuePlannedPRs(trackerId);
  const entry = entries.find((e) => e.repo === pr.repo && (e.targetPrNumber === pr.number || e.prNumber === pr.number));
  if (entry && entry.targetPrNumber === pr.number) {
    await db.setIssuePlannedPRTarget(trackerId, entry.position, null);
  }
  const step = entry ? `step ${entry.position} of ${entries.length}` : "the step that waited on it";
  await parkForHuman(issue.repo, issue.ref,
    `PR \`${pr.repo}#${pr.number}\` closed without merging, so ${step} has no PR: re-plan the issue, or move it to Approved to implement the step afresh.`,
    "PR Dispatcher", { slug: `waited-pr-closed-${pr.repo.replace(/\//g, "-")}-${pr.number}` });
}

/**
 * Release every issue parked by `parkWaitingOnPRs` whose PRs have all merged:
 * `Blocked` comes off — re-read live first, so a shadow lagging its forge
 * issue is not released twice — with one comment, and the dispatcher's
 * continuation picks up the next step. A PR closed unmerged parks the issue
 * for a person instead. While any PR is open, or its state cannot be read,
 * nothing happens. Each issue's failure is logged and the rest carry on.
 */
export async function releasePrWaitParks(): Promise<void> {
  for (const candidate of await db.listPrWaitParkCandidates()) {
    try {
      const waited = parsePrWaitReason(candidate.blocked_reason);
      if (!waited || waited.length === 0) continue;
      const states: { pr: WaitedPR; state: string | null }[] = [];
      for (const pr of waited) states.push({ pr, state: (await gh.getPRState(pr.repo, pr.number))?.toUpperCase() ?? null });

      const unreadable = states.filter((s) => s.state === null);
      if (unreadable.length > 0) {
        log.warn(`[pr-wait-park] Could not read ${unreadable.map((s) => `${s.pr.repo}#${s.pr.number}`).join(", ")} for ${candidate.id}: leaving it Blocked`);
        continue;
      }
      if (states.some((s) => s.state === "OPEN")) continue;

      const issue = await issueRefForTracker(candidate.id);
      if (!issue) continue;
      const state = await gh.getIssueState(issue.repo, issue.ref);
      if (state.state !== "OPEN" || !state.labels.includes(LABELS.blocked)) continue;

      const closed = states.find((s) => s.state !== "MERGED");
      if (closed) {
        await parkClosedUnmerged(candidate.id, issue, closed.pr);
        log.info(`[pr-wait-park] ${issue.repo}#${issue.ref}: ${closed.pr.repo}#${closed.pr.number} closed unmerged — parked for a human`);
        continue;
      }

      await gh.removeLabel(issue.repo, issue.ref, LABELS.blocked);
      const names = waited.map((pr) => `\`${pr.repo}#${pr.number}\``).join(", ");
      await gh.commentOnIssue(issue.repo, issue.ref,
        `${names} merged, so Claws has moved this issue out of \`${LABELS.blocked}\` and will continue with its next step.`,
        { agentName: "PR Dispatcher" });
      log.info(`[pr-wait-park] Released ${issue.repo}#${issue.ref}: ${names} merged`);
    } catch (err) {
      log.warn(`[pr-wait-park] Could not settle the PR-wait park of ${candidate.id}: ${err}`);
    }
  }
}
