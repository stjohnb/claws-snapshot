/**
 * Parking an issue in the Backlog until a date (docs/issue-tracker.md#backlog).
 *
 * An operator moves a native issue to the Backlog with a return day; until
 * then it is an ordinary Backlog issue. The issue dispatcher calls
 * {@link releaseDueBacklogIssues} each tick, which takes every due issue out
 * of the Backlog to where a Promote would land it
 * (`clawsIssues.entryLifecycle`) and, when it has a plan, queues
 * `issue-refiner:verify` to check that plan against the current state of the
 * world. The verify run (`issue-refiner.processRefinement`'s `backlog-return`
 * mode) keeps or revises the plan and then announces the return through
 * {@link announceBacklogReturn}; an issue with no plan is announced here and
 * planned by the normal pipeline. The requirements record is never touched.
 *
 * The date is a calendar day, `YYYY-MM-DD`, compared against the UTC date.
 * `db.ts` clears it on every lifecycle write that leaves `backlog`, so an issue
 * an operator pulls back early is never selected again.
 *
 * Sits above `github.ts` and `worker.ts`, like `issue-links.ts`; the leaf
 * `claws-state-tools.ts` repeats the date pattern rather than importing this.
 */

import * as db from "./db.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import * as slack from "./slack.js";
import * as clawsIssues from "./claws-issues.js";
import * as worker from "./worker.js";
import { AGENT_KINDS } from "./worker.js";
import * as planParser from "./plan-parser.js";
import { LABELS, isAgentDisabled, issueUrl } from "./config.js";
import { returnToPlanReview } from "./issue-handback.js";
import { reportError } from "./error-reporter.js";
import type { IssueRef } from "./issue-id.js";

const AGENT_NAME = "Backlog";

/** A `YYYY-MM-DD` calendar day. */
export const BACKLOG_UNTIL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC calendar day of `now`, `YYYY-MM-DD`. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Validate a requested return day. `null`, `undefined` and `""` clear the
 * date; anything else must be a real `YYYY-MM-DD` day no earlier than today
 * (UTC) — today itself is allowed and returns on the next sweep.
 */
export function parseBacklogUntil(input: unknown, now: Date = new Date()): { ok: true; until: string | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, until: null };
  if (typeof input !== "string") return { ok: false, error: "until must be a YYYY-MM-DD date or null" };
  const value = input.trim();
  if (value === "") return { ok: true, until: null };
  if (!BACKLOG_UNTIL_PATTERN.test(value)) return { ok: false, error: `until must be a YYYY-MM-DD date, got ${JSON.stringify(input)}` };
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || utcDay(parsed) !== value) return { ok: false, error: `${value} is not a calendar date` };
  if (value < utcDay(now)) return { ok: false, error: `${value} is in the past — pick today or a later date` };
  return { ok: true, until: value };
}

/** True once the UTC date of `now` is on or after the return day `until`. */
export function isBacklogUntilDue(until: string, now: Date = new Date()): boolean {
  return utcDay(now) >= until;
}

/** How the return went for the issue's plan, as {@link announceBacklogReturn} words it. */
export type BacklogReturnVerdict =
  | { kind: "kept"; reason: string | null }
  | { kind: "revised"; previousVersion: number | null }
  | { kind: "unverified"; why: string }
  | { kind: "replanned" }
  | { kind: "no-plan"; destination: string };

function verdictText(verdict: BacklogReturnVerdict): string {
  switch (verdict.kind) {
    case "kept":
      return `Plan verified against the current state: kept unchanged${verdict.reason ? ` — ${verdict.reason}` : ""}.`;
    case "revised":
      return `Plan verified against the current state: revised — the earlier version${verdict.previousVersion !== null ? ` ${verdict.previousVersion}` : ""} is under Previous plans.`;
    case "unverified":
      return `The plan could not be verified (${verdict.why}), so it is back in plan review unverified.`;
    case "replanned":
      return `Its plan could not be found, so a fresh plan was written.`;
    case "no-plan":
      return `It had no plan, so it is back in ${verdict.destination}.`;
  }
}

/**
 * Tell the operator `ref` is back from the Backlog: one issue comment and one
 * Slack line, each saying whether the plan was kept or revised. Called exactly
 * once per return — by the sweep for an issue with no plan or no planner, and
 * by the verify run otherwise.
 */
export async function announceBacklogReturn(repo: string, ref: IssueRef, title: string, verdict: BacklogReturnVerdict): Promise<void> {
  const text = verdictText(verdict);
  const review = verdict.kind === "no-plan" ? "" : ` Review it in \`${LABELS.ready}\` (awaiting plan review) as usual.`;
  await gh.commentOnIssue(repo, ref, `Back from the Backlog: its return date has passed. ${text}${review}`, { agentName: AGENT_NAME });
  const safeTitle = title.replace(/\s+/g, " ").slice(0, 100);
  await slack.notify(`:calendar: [backlog] ${repo} ${String(ref)} "${safeTitle}" is back from the Backlog — ${text}\n${issueUrl(repo, ref)}`);
}

/**
 * The dispatcher's per-repo sweep: bring back every native issue in `repo`
 * parked in the Backlog with a return day on or before today, and return the
 * ids released. One issue's failure is reported and does not stop the rest.
 *
 * The lifecycle write clears the date, so a released issue is never selected
 * again whatever happens after it. The verify row is therefore queued first
 * and withdrawn if the write fails: a failed enqueue leaves the issue parked
 * and due for the next sweep rather than out of the Backlog with no verify.
 */
export async function releaseDueBacklogIssues(repo: string, now: Date = new Date()): Promise<string[]> {
  const released: string[] = [];
  for (const issue of await db.listDueBacklogIssues(repo, utcDay(now))) {
    try {
      const hasPlan = planParser.findPlanComment(await gh.getIssueComments(repo, issue.id)) !== null;
      const destination = clawsIssues.entryLifecycle(issue, hasPlan);
      const verify = hasPlan && !isAgentDisabled("planner");
      if (verify) {
        await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_VERIFY, repo, issue.id, {
          priority: gh.hasPriorityLabel(issue.labels.map((name) => ({ name }))),
        });
      }
      try {
        await clawsIssues.setLifecycle(repo, issue.id, destination);
      } catch (err) {
        if (verify) await db.skipQueuedWorkForItem(AGENT_KINDS.ISSUE_REFINER_VERIFY, repo, issue.id, "Backlog release failed");
        throw err;
      }
      released.push(issue.id);
      if (!hasPlan) {
        await announceBacklogReturn(repo, issue.id, issue.title, {
          kind: "no-plan",
          destination: destination === "planning" ? "Planning for the planner" : "Drafting or Requirements review, where its requirements wait to be promoted",
        });
      } else if (!verify) {
        await returnToPlanReview(repo, issue.id);
        await announceBacklogReturn(repo, issue.id, issue.title, { kind: "unverified", why: "the planner is disabled" });
      }
      log.info(`[backlog-until] Released ${issue.id} from the Backlog to ${destination} (return date ${issue.backlog_until})${hasPlan ? "" : " — no plan"}`);
    } catch (err) {
      await reportError("issue-dispatcher:release-backlog", `${repo} ${issue.id}`, err, { repo });
    }
  }
  return released;
}
