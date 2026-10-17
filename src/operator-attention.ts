/**
 * How many issues and pull requests wait on the operator, for the counts on
 * the nav's Board and PRs links, plus the count of active sessions on Sessions (docs/product/dashboard-and-integrations.md).
 *
 * The issues count is the open issues the board files in a column whose
 * `BOARD_COLUMNS` entry `waits` — the same column inputs the `/board` route in
 * `server.ts` assembles, without its previews and chips. A change to how that
 * route derives `requirementsReview`, flights, awaiting-operator, re-approval or
 * awaiting-import must be mirrored here.
 *
 * The PRs count is the open `claws_prs` rows `prAttentionReasons` flags, the same
 * signals the `/prs` "Needs you" line renders. A stalled PR's linked issue is
 * parked in Blocked (`pr-stall-park.ts`), so it counts once in issues, through
 * Blocked, and its PR once in PRs.
 *
 * The sessions count is the `alive` entries of the session backend's `listLive()`,
 * the filter the `/sessions` page applies to its "Active Sessions" table.
 *
 * Read fresh on every page load. Best-effort: a failed read is logged and that
 * count is omitted, so the nav shows no count rather than a wrong one.
 */

import * as db from "./db.js";
import * as log from "./log.js";
import * as clawsIssues from "./claws-issues.js";
import { listRepos, listOpenIssues, isNativeIssue, awaitingImportReason } from "./github.js";
import { BACKLOG_DESTINATION, BOARD_COLUMNS, columnFor } from "./issue-board.js";
import { flightKey, loadBoardFlights } from "./issue-flight.js";
import { canonicalIssueRef, type IssueRef } from "./issue-id.js";
import { prAttentionReasons } from "./pr-attention.js";
import { issuesAwaitingOperator } from "./awaiting-operator.js";
import { loadManualActionWarnings, manualWarningRow } from "./planned-prs.js";
import { mapWithConcurrency } from "./util.js";
import { getSessionBackend } from "./session-backend.js";

export interface NavCounts {
  /** Open issues in the board's operator-waiting columns; shown on the Board link. */
  issues: number;
  /** Open pull requests that wait on a person. */
  prs: number;
  /** Sessions currently alive, the ones the Sessions page lists as active; shown on the Sessions link. */
  sessions?: number;
}

const WAITING_COLUMNS: ReadonlySet<string> = new Set(BOARD_COLUMNS.filter((col) => col.waits).map((col) => col.id));

interface AttentionCard {
  repo: string;
  ref: IssueRef;
  labels: string[];
  lifecycle?: string;
  trackerId?: string;
  awaitingImport?: boolean;
}

async function countIssues(): Promise<number> {
  const repos = await listRepos();
  const shadowStages = await clawsIssues.getOpenShadowStages();
  const requirements = await clawsIssues.getLatestRequirementsForOpenIssues();
  const feedbackPending = await clawsIssues.getRequirementsFeedbackPending(requirements);
  const requirementsReview = (trackerId: string | undefined): boolean =>
    !!trackerId && requirements.has(trackerId) && !feedbackPending.has(trackerId);

  const perRepo = await mapWithConcurrency(repos, 8, async (r) => {
    const open = await listOpenIssues(r.fullName).catch((err) => {
      log.warn(`[nav-counts] open issues for ${r.fullName}: ${err}`);
      return [];
    });
    return open.map((issue): AttentionCard => {
      const shadow = issue.lifecycle ? undefined : shadowStages.get(`${r.fullName}\u0000${String(issue.number)}`);
      const trackerId = isNativeIssue(issue.number) ? String(canonicalIssueRef(issue.number)) : shadow?.id;
      return {
        repo: r.fullName, ref: issue.number, labels: issue.labels.map((l) => l.name), lifecycle: issue.lifecycle ?? shadow?.lifecycle, trackerId,
        awaitingImport: awaitingImportReason(r.fullName, issue) !== null,
      };
    });
  });
  const unassigned = (await clawsIssues.listUnassignedOpenIssues()).map((issue): AttentionCard => ({
    repo: "", ref: issue.id, labels: issue.labels, lifecycle: issue.lifecycle, trackerId: issue.id,
  }));

  const onBoard = [...perRepo.flat(), ...unassigned]
    .filter((card) => columnFor({ labels: card.labels, unassigned: !card.repo }) !== BACKLOG_DESTINATION);
  const flights = await loadBoardFlights(onBoard);
  const ids = onBoard.map((card) => card.trackerId).filter((id): id is string => !!id);
  const [awaitingOperator, reapprovalPending] = await Promise.all([
    issuesAwaitingOperator(ids),
    db.listPendingReapprovalIssueIds(ids),
  ]);

  let count = 0;
  for (const card of onBoard) {
    const flight = flights.get(flightKey(card.repo, card.ref));
    const column = columnFor({
      labels: card.labels,
      unassigned: !card.repo,
      lifecycle: card.lifecycle,
      requirementsReview: requirementsReview(card.trackerId),
      implementing: flight?.implementing,
      openPrs: flight?.openPrs,
      awaitingOperator: !!card.trackerId && awaitingOperator.has(card.trackerId),
      reapprovalPending: !!card.trackerId && reapprovalPending.has(card.trackerId),
      awaitingImport: card.awaitingImport,
    });
    if (WAITING_COLUMNS.has(column)) count++;
  }
  return count;
}

async function countPrs(): Promise<number> {
  const rows = await db.listOpenClawsPrs();
  const warnings = await loadManualActionWarnings(rows.map(manualWarningRow));
  return rows.filter((row) => prAttentionReasons(row, warnings.get(`${row.repo}#${row.prNumber}`)).length > 0).length;
}

async function countActiveSessions(): Promise<number> {
  return (await getSessionBackend().listLive()).filter((e) => e.alive).length;
}

/** The nav's counts, or `undefined` when none could be read. */
export async function loadOperatorAttentionCounts(): Promise<NavCounts | undefined> {
  const [attention, sessions] = await Promise.all([
    Promise.all([countIssues(), countPrs()]).then(([issues, prs]) => ({ issues, prs })).catch((err) => {
      log.warn(`[nav-counts] Could not count items needing operator attention: ${err}`);
      return undefined;
    }),
    countActiveSessions().catch((err) => {
      log.warn(`[nav-counts] Could not count active sessions: ${err}`);
      return undefined;
    }),
  ]);
  if (!attention && sessions === undefined) return undefined;
  return { ...attention, ...(sessions === undefined ? {} : { sessions }) } as NavCounts;
}
