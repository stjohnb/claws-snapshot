/**
 * An issue's *flight* — the state the board's derived columns read
 * (docs/refinements/issue-flow.md, "The board"): whether its implementer is
 * running right now, and its open `claws_prs` rows.
 *
 * Neither is stored on the issue. The running implementer is a `tasks` row
 * (`job_name = 'issue-worker'`, `status = 'running'`) keyed by the issue's own
 * repo and ref; the PR rows are keyed by tracker id, so a forge issue resolves
 * through `resolveTrackerId` first, and one with no tracker id has no rows.
 *
 * Every read is best-effort: a failure is logged and read as "not in flight",
 * so a database hiccup costs the board its derived columns, not the page.
 */

import * as db from "./db.js";
import * as log from "./log.js";
import { resolveTrackerId } from "./planned-prs.js";
import type { IssueRef } from "./issue-id.js";
import { mapWithConcurrency } from "./util.js";

export interface IssueFlight {
  /** An `issue-worker` task is running for the issue. */
  implementing: boolean;
  /** The issue's open `claws_prs` rows, in any repository. */
  openPrs: db.ClawsPrRecord[];
}

const IMPLEMENTER_JOB = "issue-worker";

/** The key {@link loadBoardFlights} files a card's flight under. */
export function flightKey(repo: string, ref: IssueRef): string {
  return `${repo}\u0000${ref}`;
}

/** One issue's flight, for the routes that act on a single issue. */
export async function loadIssueFlight(repo: string, ref: IssueRef): Promise<IssueFlight> {
  const [implementing, openPrs] = await Promise.all([
    repo
      ? db.hasRunningTask(IMPLEMENTER_JOB, repo, ref).catch((err) => {
        log.warn(`[issue-flight] running task for ${repo}#${ref}: ${err}`);
        return false;
      })
      : Promise.resolve(false),
    (async () => {
      const trackerId = await resolveTrackerId(repo, ref);
      return trackerId ? db.listOpenClawsPrsForIssue(trackerId) : [];
    })().catch((err) => {
      log.warn(`[issue-flight] open PRs for ${repo ? `${repo}#${ref}` : `#${ref}`}: ${err}`);
      return [];
    }),
  ]);
  return { implementing, openPrs };
}

/**
 * The flight of every card on the board, in two queries plus one tracker-id
 * lookup per forge card (skipped when no open row is linked to any issue).
 * Only cards in flight get an entry, keyed by {@link flightKey}.
 */
export async function loadBoardFlights(cards: { repo: string; ref: IssueRef }[]): Promise<Map<string, IssueFlight>> {
  const [running, rows] = await Promise.all([
    db.getRunningTaskSummaries().catch((err) => {
      log.warn(`[issue-flight] running tasks: ${err}`);
      return [];
    }),
    db.listOpenClawsPrsWithIssue().catch((err) => {
      log.warn(`[issue-flight] open PRs: ${err}`);
      return [];
    }),
  ]);
  const implementing = new Set(
    running.filter((t) => t.job_name === IMPLEMENTER_JOB).map((t) => flightKey(t.repo, t.item_number)),
  );
  const byIssue = new Map<string, db.ClawsPrRecord[]>();
  for (const row of rows) {
    if (!row.issueId) continue;
    byIssue.set(row.issueId, [...(byIssue.get(row.issueId) ?? []), row]);
  }

  const flights = new Map<string, IssueFlight>();
  await mapWithConcurrency(cards, 8, async (card) => {
    let trackerId: string | null = null;
    if (byIssue.size > 0) {
      // A native ref resolves to itself without a query.
      trackerId = await resolveTrackerId(card.repo, card.ref).catch((err) => {
        log.warn(`[issue-flight] tracker id for ${card.repo}#${card.ref}: ${err}`);
        return null;
      });
    }
    const key = flightKey(card.repo, card.ref);
    const flight: IssueFlight = {
      implementing: !!card.repo && implementing.has(key),
      openPrs: (trackerId && byIssue.get(trackerId)) || [],
    };
    if (flight.implementing || flight.openPrs.length > 0) flights.set(key, flight);
  });
  return flights;
}
