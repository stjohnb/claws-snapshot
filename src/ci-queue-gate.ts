/**
 * CI queue gate (#clw_01M7T7K12NNP20WJ83PWMAVZB1): while a repo has
 * `CI_QUEUE_HOLD_JOBS` or more non-Mac Actions jobs that have waited at least
 * five minutes for a runner, Claws starts no new work that would push to it.
 *
 * Fails open: a Forgejo read error (or a missing admin token, which reads as
 * no waiting jobs) never holds work.
 */
import { CI_QUEUE_HOLD_JOBS } from "./config.js";
import * as forgejo from "./forgejo.js";
import * as log from "./log.js";

/** A job counts once it has waited this long. */
export const CI_QUEUE_MIN_WAIT_MS = 5 * 60_000;
/** Per-repo memo lifetime, so one dispatcher tick reads each repo once. */
export const CI_QUEUE_MEMO_MS = 60_000;

export interface CiQueueHold {
  /** Non-Mac jobs waiting at least `CI_QUEUE_MIN_WAIT_MS`. */
  waiting: number;
  /** The `CI_QUEUE_HOLD_JOBS` threshold reached. */
  limit: number;
}

const memo = new Map<string, { at: number; hold: CiQueueHold | null }>();

/**
 * `{ waiting, limit }` when `repo`'s CI queue is deep enough to hold new
 * pushing work, otherwise `null`. Memoised per repo for 60 seconds.
 */
export async function ciQueueHold(repo: string): Promise<CiQueueHold | null> {
  const limit = CI_QUEUE_HOLD_JOBS;
  if (!(limit > 0)) return null;
  const now = Date.now();
  const cached = memo.get(repo);
  if (cached && now - cached.at < CI_QUEUE_MEMO_MS) return cached.hold;
  let hold: CiQueueHold | null = null;
  try {
    const jobs = await forgejo.listWaitingRunJobs(repo);
    const waiting = jobs.filter((j) => !forgejo.hasMacLabel(j.labels) && now - j.firstSeenAt >= CI_QUEUE_MIN_WAIT_MS).length;
    hold = waiting >= limit ? { waiting, limit } : null;
  } catch (err) {
    log.warn("ci_queue_read_failed", { component: "ci-queue-gate", repo }, err);
    hold = null;
  }
  memo.set(repo, { at: now, hold });
  return hold;
}

/** Note shown on a held item's dispatch status. */
export function ciQueueHoldNote(repo: string, hold: CiQueueHold): string {
  return `Waiting for the CI queue: ${hold.waiting} jobs waiting in ${repo}`;
}

/** One `info` line per held item. */
export function logCiQueueHold(repo: string, kind: string, item: string | number, hold: CiQueueHold): void {
  log.info("ci_queue_hold", { component: "ci-queue-gate", repo, kind, item: String(item), waiting: hold.waiting, limit: hold.limit });
}

export function __resetCiQueueGateForTests(): void {
  memo.clear();
}
