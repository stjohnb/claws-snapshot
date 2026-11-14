/**
 * How many issues and pull requests wait on the operator, for the counts on
 * the nav's Board and PRs links, plus the count of active sessions on Sessions (docs/product/dashboard-and-integrations.md).
 *
 * The issues count is the open issues the board files in a column whose
 * `BOARD_COLUMNS` entry `waits` — the same column inputs the `/board` route in
 * `server.ts` assembles, without its previews and chips. A change to how that
 * route derives `requirementsReview`, flights, awaiting-operator, re-approval,
 * queued or awaiting-import must be mirrored here. Queued does not `waits`, so
 * an issue waiting only on other work in flight is not counted.
 *
 * An issue with an open PR `loadPrAttention` flags sits in Awaiting merge
 * (`prNeedsOperator`), as on the board.
 *
 * The PRs count is the open `claws_prs` rows `loadPrAttention` flags — the one
 * rule (`pr-attention.ts`) the `/prs` Blocked chip and "Needs you" line and the
 * board's PR cards and Needs-you lines also use, read from the database so the
 * web tier sees the controller's signals — plus the merged rows still
 * carrying a post-merge manual action (`db.listPostMergeActionPrs`). A stalled PR's linked issue is
 * parked in Blocked (`pr-stall-park.ts`), so it counts once in issues, through
 * Blocked, and its PR once in PRs.
 *
 * Each of those also carries a total: the issues total is every open issue on
 * the board (all cards outside the Backlog), the PRs total every open `claws_prs` row
 * plus those post-merge rows.
 *
 * The sessions count is the `alive` entries of the session backend's `listLive()`,
 * the filter the `/sessions` page applies to its "Active Sessions" table. It is
 * read live on every call, never cached, so it cannot disagree with that list.
 *
 * Every page load reads the issues and PRs counts, so they are cached under `nav-counts` for
 * `NAV_COUNTS_TTL_MS` and served up to `STALE_OK_MS` past that while one
 * background refresh runs; the forge issue lists it reads are stale-ok too.
 * Those counts can therefore lag a label change by about 20 s; it is advisory.
 * Best-effort: a failed read is logged and that count is omitted, so the nav
 * shows no count rather than a wrong one.
 */

import * as db from "./db.js";
import * as log from "./log.js";
import * as clawsIssues from "./claws-issues.js";
import { listRepos, listOpenIssues, isNativeIssue, awaitingImportReason } from "./github.js";
import { BACKLOG_DESTINATION, BOARD_COLUMNS, columnFor, type BoardDestination } from "./issue-board.js";
import { flightKey, loadBoardFlights } from "./issue-flight.js";
import { canonicalIssueRef, type IssueRef } from "./issue-id.js";
import { loadPrAttention, prAttentionKey } from "./pr-attention.js";
import { issuesAwaitingOperator } from "./awaiting-operator.js";
import { issuesQueued } from "./queued-issues.js";
import { mapWithConcurrency } from "./util.js";
import { getSessionBackend } from "./session-backend.js";
import { STALE_OK_MS, TTLCache } from "./ttl-cache.js";
import type { ApprovedThrough } from "./issue-approval.js";

/** Items waiting on the operator, and all items, for one nav link. */
export interface NavCountPair {
  attention: number;
  total: number;
}

export interface NavCounts {
  /** Board link: open issues in the operator-waiting columns, and every open issue on the board (not Backlog). */
  issues?: NavCountPair;
  /** PRs link: open pull requests that wait on a person, and all open `claws_prs` rows. */
  prs?: NavCountPair;
  /** Sessions currently alive, the ones the Sessions page lists as active; shown on the Sessions link. */
  sessions?: number;
}

/** The board columns whose `BOARD_COLUMNS` entry `waits`: an issue there waits on the operator. */
export const WAITING_COLUMNS: ReadonlySet<string> = new Set(BOARD_COLUMNS.filter((col) => col.waits).map((col) => col.id));

/** An open issue as the column derivation needs it; `repo` is `""` for an unassigned native issue. */
export interface AttentionCard {
  repo: string;
  ref: IssueRef;
  labels: string[];
  lifecycle?: string;
  approvedThrough?: ApprovedThrough;
  trackerId?: string;
  awaitingImport?: boolean;
}

/**
 * The board column each of `cards` sits in, keyed by `flightKey(repo, ref)`:
 * the requirements-review, flight, awaiting-operator, re-approval and queued inputs
 * the `/board` route assembles, without its previews and chips. Shared by the
 * nav's issues count and the `/alerts` page.
 */
export async function columnsForCards(cards: readonly AttentionCard[]): Promise<Map<string, BoardDestination>> {
  const [requirements, heldWithoutWriter] = await Promise.all([
    clawsIssues.getLatestRequirementsForOpenIssues(),
    clawsIssues.getHeldWithoutWriterOpenIssueIds(),
  ]);
  const feedbackPending = await clawsIssues.getRequirementsFeedbackPending(requirements);
  // As on the board: a held stage-off issue with no version waits in
  // Requirements review on its own text.
  const requirementsReview = (trackerId: string | undefined): boolean =>
    !!trackerId && (requirements.has(trackerId) ? !feedbackPending.has(trackerId) : heldWithoutWriter.has(trackerId));
  const flights = await loadBoardFlights([...cards]);
  const ids = cards.map((card) => card.trackerId).filter((id): id is string => !!id);
  const [awaitingOperator, reapprovalPending, queued] = await Promise.all([
    issuesAwaitingOperator(ids),
    db.listPendingReapprovalIssueIds(ids),
    issuesQueued(ids),
  ]);

  const flightPrs = [...flights.values()].flatMap((flight) => flight.openPrs ?? []);
  const prAttention = flightPrs.length > 0 ? await loadPrAttention(dedupePrs(flightPrs)) : new Map<string, string[]>();

  const columns = new Map<string, BoardDestination>();
  for (const card of cards) {
    const key = flightKey(card.repo, card.ref);
    const flight = flights.get(key);
    const prNeedsOperator = (flight?.openPrs ?? []).some((pr) => prAttention.has(prAttentionKey(pr.repo, pr.prNumber)));
    columns.set(key, columnFor({
      labels: card.labels,
      unassigned: !card.repo,
      lifecycle: card.lifecycle,
      approvedThrough: card.approvedThrough,
      requirementsReview: requirementsReview(card.trackerId),
      implementing: flight?.implementing,
      openPrs: flight?.openPrs,
      awaitingOperator: !!card.trackerId && awaitingOperator.has(card.trackerId),
      reapprovalPending: !!card.trackerId && reapprovalPending.has(card.trackerId),
      awaitingImport: card.awaitingImport,
      queued: !!card.trackerId && queued.has(card.trackerId),
      prNeedsOperator,
    }));
  }
  return columns;
}

/** `rows` with each `repo#number` once. */
function dedupePrs(rows: readonly db.ClawsPrRecord[]): db.ClawsPrRecord[] {
  const seen = new Map<string, db.ClawsPrRecord>();
  for (const row of rows) seen.set(prAttentionKey(row.repo, row.prNumber), row);
  return [...seen.values()];
}

/**
 * Every open issue on the board — each managed repo's open issues (stale-ok)
 * and the unassigned native ones, outside the Backlog — with the column each
 * sits in. Shared by the nav's issues count and `boardColumnCounts`.
 */
export async function loadBoardCards(): Promise<{ cards: AttentionCard[]; columns: Map<string, BoardDestination> }> {
  const repos = await listRepos();
  const shadowStages = await clawsIssues.getOpenShadowStages();

  const perRepo = await mapWithConcurrency(repos, 8, async (r) => {
    const open = await listOpenIssues(r.fullName, { staleOk: true }).catch((err) => {
      log.warn(`[nav-counts] open issues for ${r.fullName}: ${err}`);
      return [];
    });
    return open.map((issue): AttentionCard => {
      const shadow = issue.lifecycle ? undefined : shadowStages.get(`${r.fullName}\u0000${String(issue.number)}`);
      const trackerId = isNativeIssue(issue.number) ? String(canonicalIssueRef(issue.number)) : shadow?.id;
      return {
        repo: r.fullName, ref: issue.number, labels: issue.labels.map((l) => l.name), lifecycle: issue.lifecycle ?? shadow?.lifecycle,
        approvedThrough: issue.approvedThrough ?? shadow?.approvedThrough, trackerId,
        awaitingImport: awaitingImportReason(r.fullName, issue) !== null,
      };
    });
  });
  const unassigned = (await clawsIssues.listUnassignedOpenIssues()).map((issue): AttentionCard => ({
    repo: "", ref: issue.id, labels: issue.labels, lifecycle: issue.lifecycle, approvedThrough: issue.approved_through, trackerId: issue.id,
  }));

  const cards = [...perRepo.flat(), ...unassigned]
    .filter((card) => columnFor({ labels: card.labels, unassigned: !card.repo }) !== BACKLOG_DESTINATION);
  return { cards, columns: await columnsForCards(cards) };
}

async function countIssues(): Promise<NavCountPair> {
  const { cards, columns } = await loadBoardCards();
  const count = cards.filter((card) => WAITING_COLUMNS.has(columns.get(flightKey(card.repo, card.ref)) ?? "")).length;
  return { attention: count, total: cards.length };
}

/** Open board issues per `BOARD_COLUMNS` id (every id, zeros included) and how many sit in a `WAITING_COLUMNS` column. */
export async function boardColumnCounts(): Promise<{ columns: Record<string, number>; waiting: number }> {
  const { cards, columns } = await loadBoardCards();
  const counts: Record<string, number> = Object.fromEntries(BOARD_COLUMNS.map((col) => [col.id, 0]));
  let waiting = 0;
  for (const card of cards) {
    const column = columns.get(flightKey(card.repo, card.ref)) ?? "";
    if (column in counts) counts[column]!++;
    if (WAITING_COLUMNS.has(column)) waiting++;
  }
  return { columns: counts, waiting };
}

async function countPrs(): Promise<NavCountPair> {
  const [rows, allPostMerge] = await Promise.all([db.listOpenClawsPrs(), db.listPostMergeActionPrs()]);
  // Only configured repos: the /prs section and Blocked chip cover those alone.
  const configured = allPostMerge.length > 0 ? new Set((await listRepos()).map((r) => r.fullName)) : new Set<string>();
  const postMerge = allPostMerge.filter((row) => configured.has(row.repo));
  const flagged = await loadPrAttention(rows);
  // A merged PR's pending post-merge manual action waits on the operator too.
  return { attention: flagged.size + postMerge.length, total: rows.length + postMerge.length };
}

async function countActiveSessions(): Promise<number> {
  return (await getSessionBackend().listLive()).filter((e) => e.alive).length;
}

/** How long the nav counts are served fresh before a background refresh. */
export const NAV_COUNTS_TTL_MS = 20_000;

// Wrapped so a computed `undefined` (no count readable) is still a cache hit.
const navCountsCache = new TTLCache<{ counts: NavCounts | undefined }>();

/** Drop the cached nav counts; tests call this between cases. */
export function clearNavCountsCache(): void {
  navCountsCache.clear();
}

/** `counts` with the sessions count set to `active`, for a page that already holds the list it renders. */
export function withSessionCount(counts: NavCounts | undefined, active: number): NavCounts {
  return { ...counts, sessions: active };
}

/**
 * The nav's counts, or `undefined` when none could be read. The sessions count
 * is read live on every call so it matches the Sessions page's list; only the
 * issues and PRs counts come from the cache.
 */
export async function loadOperatorAttentionCounts(): Promise<NavCounts | undefined> {
  const [cached, sessions] = await Promise.all([
    navCountsCache.dedupedFetch(
      "nav-counts",
      NAV_COUNTS_TTL_MS,
      async () => ({ counts: await computeOperatorAttentionCounts() }),
      { staleMs: STALE_OK_MS },
    ).then((entry) => entry.counts),
    countActiveSessions().catch((err) => {
      log.warn(`[nav-counts] Could not count active sessions: ${err}`);
      return undefined;
    }),
  ]);
  if (!cached && sessions === undefined) return undefined;
  return { ...cached, ...(sessions === undefined ? {} : { sessions }) };
}

async function computeOperatorAttentionCounts(): Promise<NavCounts | undefined> {
  return Promise.all([countIssues(), countPrs()]).then(([issues, prs]) => ({ issues, prs })).catch((err) => {
    log.warn(`[nav-counts] Could not count items needing operator attention: ${err}`);
    return undefined;
  });
}
