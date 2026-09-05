import * as db from "./db.js";
import * as config from "./config.js";
import * as log from "./log.js";
import * as slack from "./slack.js";
import * as gh from "./github.js";
import { reportError } from "./error-reporter.js";
import type { Repo } from "./config.js";

// Excludes long-running PR work so doc/security/etc. can still tick when only PR agents are active.
export function isClawsBusy(): boolean {
  const excluded = config.SMART_SCHEDULING.ignoreBusyKinds ?? [];
  if (db.countActiveWorkExcludingKinds(excluded) > 0) return true;
  const runningTasks = db.getRunningTasks();
  for (const t of runningTasks) {
    if (excluded.includes(t.job_name)) continue;
    return true;
  }
  return false;
}

export function localDateString(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function runDailyRepoLoop(
  jobName: string,
  repos: Repo[],
  processRepo: (repo: Repo) => Promise<void>,
): Promise<void> {
  for (const repo of repos) {
    if (gh.isRateLimited()) break;
    try {
      await processRepo(repo);
    } catch (err) {
      reportError(`${jobName}:process-repo`, repo.fullName, err);
    }
    db.markRepoProcessedDaily(jobName, repo.fullName, localDateString());
  }
}

/**
 * Concurrent-variant wrapper for a single repo's processing in a smart-scheduled
 * job that fans out with Promise.all/allSettled. ALWAYS marks the repo processed
 * daily in a finally (drives staleness selection in selectReposForTick), so callers
 * cannot forget it. Runs `fn`; on throw, if `onError` is provided its result is
 * returned, otherwise the error propagates.
 */
export async function withDailyRepoMarking<T>(
  jobName: string,
  repoFullName: string,
  fn: () => Promise<T>,
  onError?: (err: unknown) => T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!onError) throw err;
    return onError(err);
  } finally {
    db.markRepoProcessedDaily(jobName, repoFullName, localDateString());
  }
}

export function shouldRunSmartJob(name: string, _now = new Date(), manual = false): boolean {
  if (!(name in config.SMART_SCHEDULING.jobs)) return true;
  if (manual) return true;
  if (!config.SMART_SCHEDULING.enabled) return false;
  // The actual gating happens in selectReposForTick: it returns [] when no repos
  // are due, and forces SLO-breached repos through even if Claws is busy.
  return true;
}

const slackThrottleByJob = new Map<string, number>();
const SLACK_THROTTLE_MS = 6 * 60 * 60 * 1000;

export function selectReposForTick(jobName: string, allRepos: Repo[], now = new Date()): Repo[] {
  const targetMs = config.SMART_SCHEDULING.targetStalenessMs;
  const sloMs = config.SMART_SCHEDULING.sloStalenessMs;
  const lastTs = db.getLastProcessedTimestampsForJob(jobName);
  const nowMs = now.getTime();

  type Scored = { repo: Repo; ageMs: number; sloBreached: boolean };
  const scored: Scored[] = allRepos.map((r) => {
    const last = lastTs.get(r.fullName);
    const ageMs = last === undefined ? Number.POSITIVE_INFINITY : nowMs - last;
    return { repo: r, ageMs, sloBreached: ageMs >= sloMs };
  });

  const due = scored.filter((s) => s.ageMs >= targetMs);
  if (due.length === 0) return [];

  const busy = isClawsBusy();
  const sloBreached = due.filter((s) => s.sloBreached);

  let chosen: Scored[];
  if (busy) {
    if (sloBreached.length === 0) {
      log.info(`[${jobName}] Skipping tick — Claws is busy and no SLO breach`);
      return [];
    }
    const hours = Math.floor(sloMs / 3_600_000);
    log.warn(`[${jobName}] Escape valve: ${sloBreached.length} repo(s) >${hours}h stale, overriding busy`);
    const lastNotified = slackThrottleByJob.get(jobName) ?? 0;
    if (nowMs - lastNotified > SLACK_THROTTLE_MS) {
      slackThrottleByJob.set(jobName, nowMs);
      slack.notify(`:warning: claws smart-scheduler escape valve fired for *${jobName}* — ${sloBreached.length} repo(s) past SLO while system busy`);
    }
    chosen = sloBreached;
  } else {
    chosen = due;
  }

  chosen.sort((a, b) => {
    if (a.ageMs !== b.ageMs) return b.ageMs - a.ageMs;
    return a.repo.fullName < b.repo.fullName ? -1 : 1;
  });
  return chosen.map((s) => s.repo);
}

// ── Global concurrency cap for smart-scheduled per-repo work ──

let activeSlots = 0;
const waiters: Array<() => void> = [];

export async function withSmartJobSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (activeSlots >= config.SMART_SCHEDULING.maxConcurrentJobTasks) {
    await new Promise<void>((res) => waiters.push(res));
  }
  activeSlots++;
  try {
    return await fn();
  } finally {
    activeSlots--;
    const next = waiters.shift();
    if (next) next();
  }
}

/** @internal — tests only. */
export function _resetSmartJobSlotForTests(): void {
  activeSlots = 0;
  waiters.length = 0;
}

/** @internal — tests only. */
export function _resetSlackThrottleForTests(): void {
  slackThrottleByJob.clear();
}
