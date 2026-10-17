import { MAC_RUNNERS, getMacRunnerRepos, resolveLanHost, type MacRunner } from "../config.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { retryWithBackoff } from "../retry.js";
import { buildSshArgs, execCapture, redactSshError, isHostAbsent, isConnectionRefused } from "../ssh.js";

export { isHostAbsent, isConnectionRefused };

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
// Consecutive failed wake attempts per host; feeds the log line only.
const absentSince = new Map<string, number>();

export function _resetState(): void {
  lastWakeAt.clear();
  absentSince.clear();
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
  const sshRunner = resolveLanHost(runner);
  if (!SAFE_HOST.test(sshRunner.host)) {
    throw new Error(`[mac-runner-waker] refusing to SSH: unsafe host ${sshRunner.host}`);
  }
  const args = buildSshArgs(sshRunner);
  const target = sshRunner.user ? `${sshRunner.user}@${sshRunner.host}` : sshRunner.host;
  // nohup + disown so the assertion outlives the SSH session (remote shell
  // is zsh); `echo awake` keeps the call's captured output/exit meaningful.
  args.push(
    target,
    `nohup caffeinate -dimsu -t ${WAKE_HOLD_SECONDS} >/dev/null 2>&1 & disown; echo awake`,
  );
  await retryWithBackoff(
    () => execCapture("ssh", args, { timeout: 30_000 })
      .catch((err: unknown) => { throw redactSshError(err, sshRunner, runner.name ?? runner.host); }),
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

  // A Forgejo repo in getMacRunnerRepos() goes through the same gh.* facade
  // below — it routes to forgejo.ts under the hood, reading the org-owner
  // admin token read-only. A Forgejo "run" is a single waiting job whose
  // created_at is when Claws first saw it, not when the job was queued (#3099).
  for (const repo of getMacRunnerRepos()) {
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
        const sinceWake = Date.now() - (lastWakeAt.get(runner.host) ?? 0);
        if (sinceWake < WAKE_COOLDOWN_MS) {
          log.debug(`[mac-runner-waker] ${runner.host} woken recently — skipping`);
          continue;
        }
        lastWakeAt.set(runner.host, Date.now());
        const label = runner.name ?? runner.host;
        try {
          await wakeRunner(runner);
          absentSince.delete(runner.host);
          log.info(`[mac-runner-waker] woke ${label} for ${repo} run ${runId}`);
        } catch (err) {
          // An unavailable Mac is never alerted on: the job just stays queued.
          if (isHostAbsent(err) || isConnectionRefused(err)) {
            const attempt = (absentSince.get(runner.host) ?? 0) + 1;
            absentSince.set(runner.host, attempt);
            if (isConnectionRefused(err)) {
              log.warn(`[mac-runner-waker] ${label} refused SSH on port 22 (mid-sleep, mid-wake, or Remote Login off; attempt ${attempt}) — ${repo} run ${runId} will stay queued`);
            } else {
              log.warn(`[mac-runner-waker] ${label} is not answering SSH (asleep or off the network, attempt ${attempt}) — ${repo} run ${runId} will stay queued`);
            }
            continue;
          }
          log.warn(`[mac-runner-waker] failed to wake ${label} for ${repo} run ${runId} after retries: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      await reportError("mac-runner-waker", repo, err, { repo });
    }
  }
}
