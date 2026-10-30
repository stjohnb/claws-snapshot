/**
 * A native issue's board stage, for the session-facing issue reads
 * (`GET /api/issues/:id` and `GET /api/issues`, behind `claws_get_issue` and
 * `claws_list_issues`).
 *
 * The stage is the board's own column id — {@link columnFor} over the same
 * inputs the board reads, or `backlog` — so the API and the board can never
 * disagree. `stage_title` is the column's title from {@link BOARD_COLUMNS}, or
 * `Backlog`.
 *
 * Every read is best-effort, as on `/board`: a failure is logged and read as
 * absent, so a database hiccup costs the stage its precision, not the request.
 */

import * as clawsIssues from "./claws-issues.js";
import type { IssueCommentDetail, IssueRequirementsVersion } from "./claws-issues.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { BACKLOG_DESTINATION, BOARD_COLUMNS, columnFor, type BoardDestination, type BoardIssue } from "./issue-board.js";
import { flightKey, loadBoardFlights, loadIssueFlight, type IssueFlight } from "./issue-flight.js";
import { issuesAwaitingOperator } from "./awaiting-operator.js";
import { issuesQueued } from "./queued-issues.js";
import type { IssueAwaitingOperatorDetail } from "./gate-events.js";

export interface IssueStage {
  stage: BoardDestination;
  stage_title: string;
}

export function titleFor(stage: BoardDestination): string {
  if (stage === BACKLOG_DESTINATION) return "Backlog";
  return BOARD_COLUMNS.find((col) => col.id === stage)?.title ?? stage;
}

function stageOf(
  record: db.ClawsIssueRecord,
  requirementsReview: boolean,
  flight: IssueFlight | undefined,
  awaitingOperator: boolean,
  reapprovalPending: boolean,
  queued: boolean,
): IssueStage {
  const issue: BoardIssue = {
    labels: record.labels,
    closed: record.state === "closed",
    unassigned: record.repos.length === 0,
    lifecycle: record.lifecycle,
    approvedThrough: record.approved_through,
    requirementsReview,
    implementing: flight?.implementing,
    openPrs: flight?.openPrs,
    awaitingOperator,
    reapprovalPending,
    queued,
  };
  const stage = columnFor(issue);
  return { stage, stage_title: titleFor(stage) };
}

/** The subset of `ids` with a design change pending re-approval; a failed read is logged and read as none. */
async function pendingReapprovals(ids: readonly string[]): Promise<Set<string>> {
  return await db.listPendingReapprovalIssueIds(ids).catch((err) => {
    log.warn(`[issue-stage] pending re-approvals: ${err}`);
    return new Set<string>();
  });
}

/**
 * One native issue's stage. `comments` and `latestRequirements` are read here
 * when the caller has not already loaded them; `latestRequirements` is `null`
 * when the issue has no version.
 */
export async function stageForIssue(
  record: db.ClawsIssueRecord,
  comments?: IssueCommentDetail[],
  latestRequirements?: IssueRequirementsVersion | null,
): Promise<IssueStage> {
  return (await loadIssueStage(record, comments, latestRequirements)).stage;
}

/**
 * {@link stageForIssue} with the reads it was derived from — the issue's
 * flight, whether it awaits an operator step or has a design change
 * pending re-approval, and the reason it is Queued (`queued-issues.ts`), if it is — so a caller deriving more from the same issue
 * (`GET /api/issues/:id`' "Stops at" line) reads one snapshot, once.
 */
export async function loadIssueStage(
  record: db.ClawsIssueRecord,
  comments?: IssueCommentDetail[],
  latestRequirements?: IssueRequirementsVersion | null,
): Promise<{ stage: IssueStage; flight: IssueFlight; awaitingOperator: boolean; reapprovalPending: boolean; queuedReason: string | null }> {
  const latest = latestRequirements !== undefined
    ? latestRequirements
    : await clawsIssues.listRequirements(record.id).then((v) => v.at(-1) ?? null).catch((err) => {
      log.warn(`[issue-stage] requirements for ${record.id}: ${err}`);
      return null;
    });
  // A failed feedback read leaves an issue with a version in Requirements
  // review, as on the board.
  let requirementsReview = false;
  if (latest !== null) {
    try {
      const all = comments ?? await clawsIssues.listCommentDetails(record.id);
      requirementsReview = !await clawsIssues.hasRequirementsFeedback(all, latest.createdAt);
    } catch (err) {
      log.warn(`[issue-stage] requirements feedback for ${record.id}: ${err}`);
      requirementsReview = true;
    }
  }
  const [flight, awaiting, reapprovals, queued] = await Promise.all([
    loadIssueFlight(clawsIssues.primaryRepo(record), record.id),
    issuesAwaitingOperator([record.id]).catch((err) => {
      log.warn(`[issue-stage] awaiting operator for ${record.id}: ${err}`);
      return new Map<string, { position: number; title: string }>();
    }),
    pendingReapprovals([record.id]),
    issuesQueued([record.id]),
  ]);
  const awaitingOperator = awaiting.has(record.id);
  const reapprovalPending = reapprovals.has(record.id);
  const queuedReason = queued.get(record.id) ?? null;
  return {
    stage: stageOf(record, requirementsReview, flight, awaitingOperator, reapprovalPending, queuedReason !== null),
    flight,
    awaitingOperator,
    reapprovalPending,
    queuedReason,
  };
}

/**
 * The stage of each of `records`, open native issues, keyed by id — the
 * board's batched reads rather than one query per issue, so a list stays fast.
 */
export async function stagesForOpenIssues(records: readonly db.ClawsIssueRecord[]): Promise<Map<string, IssueStage>> {
  return (await loadOpenIssueStages(records)).stages;
}

/**
 * What each of `records` (open native issues) waits on the operator for, keyed
 * by id — the `issue-awaiting-operator` gate detail (src/gate-events.ts), from
 * the same batched reads as {@link stagesForOpenIssues}: `manual-step` for an
 * issue awaiting an operator step, else `requirements-review` or
 * `plan-review` from its stage, else null.
 */
export async function issueGateDetails(records: readonly db.ClawsIssueRecord[]): Promise<Map<string, IssueAwaitingOperatorDetail | null>> {
  const { stages, awaitingOperator } = await loadOpenIssueStages(records);
  const details = new Map<string, IssueAwaitingOperatorDetail | null>();
  for (const record of records) {
    const stage = stages.get(record.id)?.stage;
    details.set(record.id, awaitingOperator.has(record.id) ? "manual-step"
      : stage === "requirements-review" ? "requirements-review"
      : stage === "awaiting-plan-review" ? "plan-review"
      : null);
  }
  return details;
}

/**
 * The stage of each of `records` (open native issues), keyed by id, with the
 * batched reads it was derived from — each card's flight (keyed by
 * `flightKey`), the issues awaiting an operator step, those with a design
 * change pending re-approval and the Queued ones with their reasons — so a caller deriving more from the same
 * records (`GET /api/issues`' "Stops at" line) reads one snapshot, once.
 */
export async function loadOpenIssueStages(records: readonly db.ClawsIssueRecord[]): Promise<{
  stages: Map<string, IssueStage>;
  awaitingOperator: Map<string, unknown>;
  flights: Map<string, IssueFlight>;
  reapprovals: Set<string>;
  queued: Map<string, string>;
}> {
  if (records.length === 0) return { stages: new Map(), awaitingOperator: new Map(), flights: new Map(), reapprovals: new Set(), queued: new Map() };
  const [requirements, flights, awaitingOperator, reapprovals, queued] = await Promise.all([
    clawsIssues.getLatestRequirementsForOpenIssues().catch((err) => {
      log.warn(`[issue-stage] requirements: ${err}`);
      return null;
    }),
    loadBoardFlights(records.map((r) => ({ repo: clawsIssues.primaryRepo(r), ref: r.id }))),
    issuesAwaitingOperator(records.map((r) => r.id)).catch((err) => {
      log.warn(`[issue-stage] awaiting operator: ${err}`);
      return new Map<string, { position: number; title: string }>();
    }),
    pendingReapprovals(records.map((r) => r.id)),
    issuesQueued(records.map((r) => r.id)),
  ]);
  const feedbackPending = requirements === null
    ? new Set<string>()
    : await clawsIssues.getRequirementsFeedbackPending(requirements).catch((err) => {
      log.warn(`[issue-stage] requirements feedback: ${err}`);
      return new Set<string>();
    });
  const stages = new Map<string, IssueStage>();
  for (const record of records) {
    const review = !!requirements?.has(record.id) && !feedbackPending.has(record.id);
    const flight = flights.get(flightKey(clawsIssues.primaryRepo(record), record.id));
    stages.set(record.id, stageOf(record, review, flight, awaitingOperator.has(record.id), reapprovals.has(record.id), queued.has(record.id)));
  }
  return { stages, awaitingOperator, flights, reapprovals, queued };
}
