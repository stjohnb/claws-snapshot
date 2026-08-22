import { MAC_RUNNERS, MAC_RUNNER_REPOS, type MacRunner } from "../config.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { retryWithBackoff } from "../retry.js";
import { buildSshArgs, execCapture } from "../ssh.js";
import { notify } from "../slack.js";

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
// After a successful wake the Mac answers SSH within seconds and the runner
// agent reports online to GitHub shortly after. If the job is still queued
// this long after the wake, the runner service itself is the problem (not
// running, unregistered, or mislabelled) — waking again won't help, so check
// GitHub's runner registry and alert.
const RUNNER_ONLINE_GRACE_MS = 3 * 60_000;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** SSH failures that mean the peer never answered — the Mac is off, asleep
 * without a working Bonjour sleep proxy (the mDNS name can still resolve via a
 * sleep proxy while the Mac itself ignores the SYN), off the LAN, or behind a
 * firewall that drops port 22. None of these are Claws defects and none must
 * open a [claws-error] issue (#1980, #1986, #2112, #2143, #2160, #2203, #2212).
 * Deliberately EXCLUDES "connection refused", "permission denied" and "host key
 * verification failed" — those prove a live TCP stack or a live sshd, i.e. a
 * real misconfiguration worth alerting on. */
const HOST_ABSENT_RE = /could not resolve hostname|name or service not known|nodename nor servname provided|no route to host|network is unreachable|host is down|connection timed out|operation timed out/i;

export function isHostAbsent(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return HOST_ABSENT_RE.test(message);
}

const lastWakeAt = new Map<string, number>();
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

/** A woken Mac that answers SSH but whose runner agent never reports online
 * to GitHub leaves the job queued forever while the waker keeps re-caffeinating
 * it. Alert (via reportError's per-fingerprint cooldown) when no runner
 * carrying this config runner's labels is online in the repo's registry. */
async function checkRunnerCameOnline(
  repo: string,
  runner: MacRunner,
  runId: number,
  ghRunners: gh.SelfHostedRunner[],
  sinceWakeMs: number,
): Promise<void> {
  const wanted = runner.labels.map(l => l.toLowerCase());
  const registered = ghRunners.filter(r => {
    const have = new Set(r.labels.map(l => l.toLowerCase()));
    return wanted.every(l => have.has(l));
  });
  const minutes = Math.round(sinceWakeMs / 60_000);
  if (registered.length === 0) {
    await reportError(
      `mac-runner-offline:${runner.host}`,
      `${repo} run ${runId} — no self-hosted runner with labels [${runner.labels.join(", ")}] is registered in the repo or org; ${runner.name ?? runner.host} was woken ${minutes}m ago but nothing can pick the job up (a re-registered runner loses its custom labels — check the runner's labels in the org settings)`,
      new Error("runner not registered"),
    );
  } else if (!registered.some(r => r.status === "online")) {
    await reportError(
      `mac-runner-offline:${runner.host}`,
      `${repo} run ${runId} — runner ${registered.map(r => r.name).join(", ")} still offline ${minutes}m after ${runner.name ?? runner.host} was woken; the runner service is likely not running`,
      new Error("runner offline after wake"),
    );
  }
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

      // null = registry not visible (403) — check skipped; undefined = not fetched yet
      let ghRunners: gh.SelfHostedRunner[] | null | undefined;
      for (const { runner, runId } of toWake.values()) {
        const lastWake = lastWakeAt.get(runner.host) ?? 0;
        const sinceWake = Date.now() - lastWake;
        if (sinceWake < WAKE_COOLDOWN_MS) {
          log.debug(`[mac-runner-waker] ${runner.host} woken recently — skipping`);
          // A host mid-absence-streak has never actually answered SSH, so the
          // "still offline after wake" check doesn't apply — it would just
          // re-file the suppressed absence as a [claws-error] under a
          // different fingerprint once RUNNER_ONLINE_GRACE_MS elapses.
          if (sinceWake >= RUNNER_ONLINE_GRACE_MS && !absentSince.has(runner.host)) {
            if (ghRunners === undefined) ghRunners = await gh.fetchSelfHostedRunners(repo);
            if (ghRunners !== null) {
              await checkRunnerCameOnline(repo, runner, runId, ghRunners, sinceWake);
            }
          }
          continue;
        }
        lastWakeAt.set(runner.host, Date.now());
        try {
          await wakeRunner(runner);
          absentSince.delete(runner.host);
          log.info(`[mac-runner-waker] woke ${runner.name ?? runner.host} for ${repo} run ${runId}`);
        } catch (err) {
          if (isHostAbsent(err)) {
            const streak = (absentSince.get(runner.host) ?? 0) + 1;
            absentSince.set(runner.host, streak);
            const label = runner.name ?? runner.host;
            log.warn(`[mac-runner-waker] ${label} is not answering SSH (asleep or off the network, attempt ${streak}) — ${repo} run ${runId} will stay queued`);
            if (streak === 1) {
              notify(`:sleeping: mac-runner-waker: ${label} (${runner.host}) is not answering SSH — asleep or off the network, so ${repo} run ${runId} cannot start. Turn the Mac on (check System Settings → Network → "Wake for network access"), or untick it under Mac Runner Enrolment in the config UI.`);
            }
            continue;
          }
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
