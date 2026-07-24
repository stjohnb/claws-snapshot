import { MAC_RUNNERS, MAC_RUNNER_REPOS, type MacRunner } from "../config.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { retryWithBackoff } from "../retry.js";
import { buildSshArgs, execCapture } from "../ssh.js";

const QUEUED_GRACE_MS = 60_000;
const WAKE_COOLDOWN_MS = 5 * 60_000;
// How long the wake SSH holds a caffeinate assertion on the Mac. A bare
// network wake is a dark wake: the Mac answers SSH and lets the runner pick
// up the job, then re-sleeps within seconds unless something takes a power
// assertion — the runner then goes silent mid-checkout and GitHub fails the
// job with "lost communication with the server" (bonkus#1605). Ten minutes
// covers pickup through the job's own keep-awake step; the -t bound means a
// wake with no job behind it cannot pin the Mac awake beyond that.
const WAKE_HOLD_SECONDS = 600;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const lastWakeAt = new Map<string, number>();

export function _resetState(): void {
  lastWakeAt.clear();
}

/** A job needs a Mac if its labels include "macos" (case-insensitive). */
export function isMacJob(labels: string[]): boolean {
  return labels.some(l => l.toLowerCase() === "macos");
}

/** Runner can serve the job when every label other than "self-hosted"
 * is present in runner.labels. Comparison is case-insensitive. */
export function matchingRunners(labels: string[], runners: readonly MacRunner[]): MacRunner[] {
  const required = labels
    .map(l => l.toLowerCase())
    .filter(l => l !== "self-hosted");
  return runners.filter(runner => {
    const runnerLabels = new Set(runner.labels.map(l => l.toLowerCase()));
    return required.every(l => runnerLabels.has(l));
  });
}

async function wakeRunner(runner: MacRunner): Promise<void> {
  if (!SAFE_HOST.test(runner.host)) {
    throw new Error(`[mac-runner-waker] refusing to SSH: unsafe host ${runner.host}`);
  }
  const args = buildSshArgs(runner);
  const target = runner.user ? `${runner.user}@${runner.host}` : runner.host;
  // nohup + disown so the assertion outlives the SSH session (remote shell
  // is zsh); `echo awake` keeps the call's captured output/exit meaningful.
  args.push(
    target,
    `nohup caffeinate -dimsu -t ${WAKE_HOLD_SECONDS} >/dev/null 2>&1 & disown; echo awake`,
  );
  await retryWithBackoff(
    () => execCapture("ssh", args, { timeout: 30_000 }),
    3,
    () => true,
    `mac-runner-waker:${runner.host}`,
  );
}

export async function run(): Promise<void> {
  if (MAC_RUNNERS.length === 0) {
    log.info("[mac-runner-waker] No Mac runners configured — skipping");
    return;
  }

  const activeRunners = MAC_RUNNERS.filter(r => r.enabled !== false);

  for (const repo of MAC_RUNNER_REPOS) {
    try {
      const queuedRuns = await gh.fetchQueuedWorkflowRuns(repo);
      const eligibleRuns = queuedRuns.filter(queuedRun => {
        const createdAt = Date.parse(queuedRun.created_at);
        if (Number.isNaN(createdAt)) return false;
        return Date.now() - createdAt >= QUEUED_GRACE_MS;
      });

      const toWake = new Map<string, { runner: MacRunner; runId: number }>();
      for (const queuedRun of eligibleRuns) {
        const jobs = await gh.fetchQueuedJobsForRun(repo, queuedRun.run_id);
        for (const job of jobs) {
          if (!isMacJob(job.labels)) continue;
          const matches = matchingRunners(job.labels, activeRunners);
          if (matches.length === 0) {
            log.warn(`[mac-runner-waker] No Mac runner matches job "${job.name}" labels [${job.labels.join(", ")}] in ${repo}`);
            continue;
          }
          for (const runner of matches) toWake.set(runner.host, { runner, runId: queuedRun.run_id });
        }
      }

      for (const { runner, runId } of toWake.values()) {
        const lastWake = lastWakeAt.get(runner.host) ?? 0;
        if (Date.now() - lastWake < WAKE_COOLDOWN_MS) {
          log.debug(`[mac-runner-waker] ${runner.host} woken recently — skipping`);
          continue;
        }
        lastWakeAt.set(runner.host, Date.now());
        try {
          await wakeRunner(runner);
          log.info(`[mac-runner-waker] woke ${runner.name ?? runner.host} for ${repo} run ${runId}`);
        } catch (err) {
          await reportError(
            `mac-runner-waker-ssh:${runner.host}`,
            `${repo} run ${runId} — failed to wake ${runner.name ?? runner.host} after retries`,
            err,
          );
        }
      }
    } catch (err) {
      await reportError("mac-runner-waker", repo, err);
    }
  }
}
