import type { IssueRef } from "../issue-id.js";
import { RUNNER_HOSTS, SELF_REPO, isForgejoRepo, resolveLanHost, type RunnerHost } from "../config.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../slack.js";
import { listRepos } from "../github.js";
import * as forgejo from "../forgejo.js";
import { closeAlertIssueIfResolved, ensureAlertIssue } from "../occurrence-tracking.js";
import { buildSshArgs, execCapture, redactSshError, isHostAbsent, isSafeAbsolutePath } from "../ssh.js";

function displayName(runner: RunnerHost): string {
  return runner.name ?? (runner.user ? `${runner.user}@${runner.host}` : runner.host);
}

function isSystemd(runner: RunnerHost): boolean {
  return Boolean(runner.serviceUnit);
}

function workRoot(runner: RunnerHost): string {
  return runner.serviceUnit ? runner.workDir! : `${runner.actionsDir}/_work`;
}

function tempDir(runner: RunnerHost): string {
  return `${workRoot(runner)}/_temp`;
}

function toolCacheDir(runner: RunnerHost): string {
  return runner.serviceUnit ? runner.toolDir! : `${workRoot(runner)}/_tool`;
}

export function assertSafeRunnerPaths(runner: RunnerHost): void {
  const name = displayName(runner);
  if (isSystemd(runner)) {
    if (!runner.serviceUnit || !/^[a-zA-Z0-9@._-]+$/.test(runner.serviceUnit)) {
      throw new Error(`[runner-monitor] refusing to run remote command: unsafe serviceUnit for ${name}`);
    }
    if (!runner.workDir || !isSafeAbsolutePath(runner.workDir)) {
      throw new Error(`[runner-monitor] refusing to run remote command: unsafe workDir for ${name}`);
    }
    if (!runner.toolDir || !isSafeAbsolutePath(runner.toolDir)) {
      throw new Error(`[runner-monitor] refusing to run remote command: unsafe toolDir for ${name}`);
    }
    return;
  }
  if (!runner.actionsDir || !isSafeAbsolutePath(runner.actionsDir)) {
    throw new Error(`[runner-monitor] refusing to run remote command: unsafe actionsDir for ${name}`);
  }
}

export function sshExec(runner: RunnerHost, command: string, timeoutMs: number = 30_000): Promise<string> {
  const args = buildSshArgs(runner);
  const target = runner.user ? `${runner.user}@${runner.host}` : runner.host;
  args.push(target, command);
  return execCapture("ssh", args, { timeout: timeoutMs });
}

async function statusProbe(runner: RunnerHost): Promise<boolean> {
  if (isSystemd(runner)) {
    const status = await sshExec(runner, `systemctl is-active ${runner.serviceUnit} || true`);
    const trimmed = status.trim();
    return trimmed === "active" || trimmed === "activating";
  }
  const status = await sshExec(runner, `cd ${runner.actionsDir} && sudo ./svc.sh status`);
  return status.includes("active (running)");
}

async function restartRunner(runner: RunnerHost): Promise<void> {
  if (isSystemd(runner)) {
    await sshExec(runner, `sudo systemctl restart ${runner.serviceUnit}`, 120_000);
    return;
  }
  await sshExec(runner, `cd ${runner.actionsDir} && sudo ./svc.sh stop; sudo ./svc.sh start`);
}

async function getUsagePercent(runner: RunnerHost): Promise<number | null> {
  const dfOutput = await sshExec(runner, `df --output=pcent / | tail -1`);
  const match = dfOutput.trim().match(/(\d+)%/);
  return match ? parseInt(match[1], 10) : null;
}

async function getDiskBreakdown(runner: RunnerHost): Promise<string> {
  assertSafeRunnerPaths(runner);
  const lines: string[] = [];

  try {
    const out = await sshExec(runner, `df -h /`, 60_000);
    if (out.trim()) lines.push("Filesystem:", out.trim());
  } catch { /* skip */ }

  const dirProbes = isSystemd(runner)
    ? [
        `/var/lib/docker`,
        workRoot(runner),
        toolCacheDir(runner),
        `/var/log`,
        `/tmp`,
        `/nix/store`,
        `/var/cache`,
      ]
    : [
        `/var/lib/docker`,
        workRoot(runner),
        `/var/log`,
        `/tmp`,
        `/snap`,
        `/var/cache`,
      ];
  const dirLines: string[] = [];
  for (const dir of dirProbes) {
    try {
      const out = await sshExec(runner, `sudo du -sh ${dir}`, 60_000);
      if (out.trim()) dirLines.push(out.trim());
    } catch { /* skip */ }
  }
  if (dirLines.length > 0) lines.push("Top directories:", ...dirLines);

  try {
    const out = await sshExec(runner, `sudo du -sh ${workRoot(runner)}/*/ 2>/dev/null | sort -hr | head -10`, 60_000);
    if (out.trim()) lines.push("_work breakdown:", out.trim());
  } catch { /* skip */ }

  try {
    const out = await sshExec(runner, `docker image ls --format '{{.Repository}}:{{.Tag}}\\t{{.Size}}' | sort -k2 -hr | head -20`, 60_000);
    if (out.trim()) lines.push("Top docker images:", out.trim());
  } catch { /* skip */ }

  try {
    const out = await sshExec(runner, `docker system df`, 60_000);
    if (out.trim()) lines.push("Docker breakdown:", out.trim());
  } catch { /* skip */ }

  if (lines.length === 0) return "(breakdown unavailable)";
  return lines.join("\n").trim();
}

async function checkHost(runner: RunnerHost, actions: string[]): Promise<void> {
  assertSafeRunnerPaths(runner);
  const name = displayName(runner);

  // ── Service health check ──
  let serviceActive = false;
  try {
    serviceActive = await statusProbe(runner);
  } catch {
    serviceActive = false;
  }

  if (!serviceActive) {
    log.warn(`[runner-monitor] ${name}: service not active — restarting`);
    try {
      await restartRunner(runner);
      // Verify restart
      const verify = await statusProbe(runner);
      if (verify) {
        actions.push(`restarted service on ${name}`);
        log.info(`[runner-monitor] ${name}: service restarted successfully`);
      } else {
        actions.push(`restart attempted on ${name} but service still not active`);
        log.warn(`[runner-monitor] ${name}: service still not active after restart`);
      }
    } catch (err) {
      actions.push(`restart failed on ${name}`);
      log.warn(`[runner-monitor] ${name}: restart failed: ${err}`);
    }
  }

  // ── Zombie/stale process detection ──
  // A live `Runner.Worker` process means a job is executing right now. The
  // Listener is always up; only the Worker implies an in-flight job.
  let jobRunning = false;
  try {
    const psOutput = await sshExec(runner, `ps -eo pid,etimes,comm | grep -E 'Runner\\.(Worker|Listener)' || true`);
    const lines = psOutput.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      if (parts[2].startsWith("Runner.Worker")) jobRunning = true;
      const pid = parts[0];
      const etimes = parseInt(parts[1], 10);
      if (etimes > 21600) { // 6 hours
        if (!serviceActive) {
          // Orphaned worker — kill it
          try {
            await sshExec(runner, `sudo kill -9 ${pid}`);
            actions.push(`killed orphaned process ${pid} on ${name} (uptime ${Math.round(etimes / 3600)}h)`);
            log.warn(`[runner-monitor] ${name}: killed orphaned process ${pid} (uptime ${Math.round(etimes / 3600)}h)`);
          } catch (killErr) {
            log.warn(`[runner-monitor] ${name}: failed to kill process ${pid}: ${killErr}`);
          }
        } else {
          log.warn(`[runner-monitor] ${name}: stale process ${pid} (uptime ${Math.round(etimes / 3600)}h) — service active, skipping kill`);
        }
      }
    }
  } catch {
    // No matching processes or ps failed — fine
  }

  // ── Disk space check ──
  try {
    const usage = await getUsagePercent(runner);
    if (usage !== null && usage > 85) {
      const cleaned: string[] = [];

      // Tier 1 (>85%): basic cleanup
      log.warn(`[runner-monitor] ${name}: disk usage ${usage}% — running cleanup`);
      // Never blow away _work/_temp while a job is executing: it holds the live
      // job's scratch dirs and the runner's own file-command files
      // (set_output/set_env). Deleting them mid-job fails the job with
      // "ENOENT ... cache.tzst" / "Missing file at path: .../set_output_*"
      // (issue #2327). Even when idle, only reap entries older than 6h so a job
      // that starts in the race window between the ps probe and this command is
      // not affected.
      if (jobRunning) {
        log.info(`[runner-monitor] ${name}: job in progress — skipping temp-file cleanup`);
      } else {
        try {
          await sshExec(
            runner,
            `sudo find /tmp -maxdepth 1 -name '_github_*' -mmin +360 -exec rm -rf {} + ; ` +
            `sudo find ${tempDir(runner)} -mindepth 1 -maxdepth 1 -mmin +360 -exec rm -rf {} +`,
          );
          cleaned.push("temp files");
        } catch { /* non-fatal */ }
      }
      try {
        await sshExec(runner, `docker system prune -f`);
        cleaned.push("docker prune");
      } catch { /* Docker may not be present */ }
      try {
        await sshExec(runner, `docker image prune -af --filter 'until=24h'`, 120_000);
        cleaned.push("docker images >24h");
      } catch { /* Docker may not be present */ }
      try {
        await sshExec(runner, `sudo journalctl --vacuum-time=3d`);
        cleaned.push("journal vacuum");
      } catch { /* non-fatal */ }

      // Tier 2 (>90%): aggressive cleanup
      if (usage > 90) {
        try {
          await sshExec(runner, `docker system prune -af --volumes`);
          cleaned.push("docker full prune");
        } catch { /* Docker may not be present */ }
        if (jobRunning) {
          log.info(`[runner-monitor] ${name}: job in progress — skipping tool-cache cleanup`);
        } else {
          try {
            await sshExec(runner, `sudo rm -rf ${toolCacheDir(runner)}/*`);
            cleaned.push("tool cache");
          } catch { /* non-fatal */ }
        }
      }

      // Post-cleanup re-check
      let postUsage: number | null = null;
      try {
        postUsage = await getUsagePercent(runner);
      } catch { /* non-fatal */ }

      const cleanedStr = cleaned.join(" + ") || "none";
      const cleanupNoop = postUsage !== null && postUsage >= usage;
      const stillCritical = postUsage !== null && postUsage > 90;

      // Only notify Slack about the cleanup itself when it actually reduced
      // usage (success signal) or when we couldn't verify (degraded signal).
      // A noop cleanup is silent — escalates to a GitHub issue below.
      if (postUsage === null) {
        actions.push(`disk cleanup on ${name} (was ${usage}%, ${cleanedStr})`);
      } else if (!cleanupNoop) {
        actions.push(`disk cleanup on ${name} (${usage}% → ${postUsage}%, ${cleanedStr})`);
      }

      // Escalate to a GitHub issue when cleanup couldn't bring usage down,
      // either because the runner is still critical (>90%) or because the
      // cleanup was a noop (postUsage >= usage). Including a disk breakdown
      // gives whoever triages the ticket somewhere to start.
      if (stillCritical || cleanupNoop) {
        if (cleanupNoop) {
          log.warn(`[runner-monitor] ${name}: cleanup did not reduce disk usage (${usage}% → ${postUsage}%)`);
        } else {
          log.warn(`[runner-monitor] ${name}: disk still critical after cleanup (${postUsage}%)`);
        }
        try {
          const breakdown = await getDiskBreakdown(runner);
          const body = [
            `Disk usage on **${name}** remains at **${postUsage}%** after automated cleanup (was ${usage}%).`,
            "",
            `**Cleanup performed:** ${cleanedStr}`,
            "",
            "**Disk breakdown:**",
            "```",
            breakdown,
            "```",
            "",
            "*— Automated by Claws · runner-monitor —*",
          ].join("\n");
          const result = await ensureAlertIssue({
            repo: SELF_REPO,
            title: `[runner-monitor] Persistent high disk on ${name}`,
            body,
            logPrefix: "runner-monitor",
          });
          // Only push a Slack action on first occurrence — occurrence tracking
          // on the issue body is the durable signal on subsequent cycles.
          if (result.outcome === "created") {
            actions.push(`filed issue #${result.issueNumber} for ${name}`);
          } else {
            log.info(`[runner-monitor] ${name}: updated existing issue #${result.issueNumber}`);
          }
        } catch (err) {
          log.warn(`[runner-monitor] ${name}: failed to file disk issue: ${err}`);
        }
      }
    }
  } catch (err) {
    log.warn(`[runner-monitor] ${name}: disk check failed: ${err}`);
  }

  if (actions.length === 0 || !actions.some((a) => a.includes(name))) {
    log.info(`[runner-monitor] ${name} healthy`);
  }
}

// ── Forgejo runners (discovered from the org runner registry, #2863) ──
//
// A runner's registered name is its SSH host name (LAN DNS, Tailscale
// MagicDNS, or an ssh_config alias). Runner layouts differ (k3s docker-mode,
// launchd on Macs, NixOS units), so discovered runners are only alerted on —
// never restarted, cleaned up, or cancelled.

const FORGEJO_WAITING_ALERT_MS = 30 * 60_000;
const FORGEJO_RUNNING_ALERT_MS = 45 * 60_000;
const FORGEJO_DISK_ALERT_PCT = 90;
const FORGEJO_DISK_CLEAR_PCT = 85;
const SAFE_RUNNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALERT_FOOTER = "*— Automated by Claws · runner-monitor —*";

const WAITING_TITLE = "[runner-monitor] Forgejo Actions jobs waiting with no runner";
const RUNNING_TITLE = `[runner-monitor] Forgejo Actions job running over ${FORGEJO_RUNNING_ALERT_MS / 60_000}m`;
const highDiskTitle = (name: string) => `[runner-monitor] High disk on Forgejo runner ${name}`;
const offlineTitle = (name: string) => `[runner-monitor] Forgejo runner ${name} offline but host is up`;
const noSshTitle = (name: string) => `[runner-monitor] Cannot SSH to Forgejo runner ${name}`;

function hasMacLabel(labels: string[]): boolean {
  return labels.some((l) => l.toLowerCase() === "macos");
}

function minutesSince(ms: number, now: number): number {
  return Math.round((now - ms) / 60_000);
}

function sshToRunner(name: string, command: string): Promise<string> {
  const target = resolveLanHost({ host: name });
  const sshTarget = target.user ? `${target.user}@${target.host}` : target.host;
  return execCapture("ssh", [...buildSshArgs(target), sshTarget, command], { timeout: 30_000 })
    .catch((err: unknown) => { throw redactSshError(err, target, name); });
}

async function raiseAlert(title: string, lines: string[], action: string, actions: string[]): Promise<void> {
  const result = await ensureAlertIssue({
    repo: SELF_REPO,
    title,
    body: [...lines, "", ALERT_FOOTER].join("\n"),
    logPrefix: "runner-monitor",
    refreshBody: true,
  });
  if (result.outcome === "created") {
    actions.push(`${action} (#${result.issueNumber})`);
  } else {
    log.info(`[runner-monitor] ${title}: ${result.outcome} #${result.issueNumber}`);
  }
}

function clearAlert(title: string, reason: string): Promise<IssueRef | null> {
  return closeAlertIssueIfResolved({ repo: SELF_REPO, title, logPrefix: "runner-monitor", reason });
}

async function checkForgejoRunner(runner: forgejo.OrgActionRunner, actions: string[]): Promise<void> {
  const { name } = runner;
  if (!SAFE_RUNNER_NAME.test(name)) {
    log.warn(`[runner-monitor] Forgejo runner name ${JSON.stringify(name)} is not a safe SSH host — skipping`);
    return;
  }
  const online = runner.status === "idle" || runner.status === "active";
  if (!online && hasMacLabel(runner.labels)) {
    // Probing through the Bonjour sleep proxy would wake the Mac; mac-runner-waker owns it.
    log.info(`[runner-monitor] Forgejo runner ${name} offline (macos) — not probing`);
    return;
  }

  let output: string;
  try {
    output = await sshToRunner(name, online ? "df -P / | tail -1" : "true");
  } catch (err) {
    if (isHostAbsent(err)) {
      log.info(`[runner-monitor] Forgejo runner ${name} (${runner.status}): host not reachable — skipping`);
      if (!online) await clearAlert(offlineTitle(name), "host is down");
      await clearAlert(noSshTitle(name), "host is down");
      if (online) await clearAlert(highDiskTitle(name), "host is down");
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await raiseAlert(noSshTitle(name), [
      `Claws cannot SSH to Forgejo runner **${name}** (status \`${runner.status}\`), but the host answered.`,
      "",
      "```",
      message,
      "```",
      "",
      "The runner's registered name is resolved through `resolveLanHost` / `LAN_HOST_ALIASES` before SSH; check the alias table or DNS, and that Claws' key is authorised.",
    ], `cannot SSH to Forgejo runner ${name}`, actions);
    return;
  }
  await clearAlert(noSshTitle(name), "SSH succeeded");

  if (!online) {
    await raiseAlert(offlineTitle(name), [
      `Forgejo reports runner **${name}** as \`offline\`, but its host answers SSH — the runner service/agent on the host is not running.`,
      "",
      `Labels: ${runner.labels.join(", ") || "(none)"}`,
    ], `Forgejo runner ${name} offline but host up`, actions);
    return;
  }
  await clearAlert(offlineTitle(name), "runner online");

  const line = output.trim();
  // `df -P` columns: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const match = line.split(/\s+/)[4]?.match(/^(\d+)%$/);
  if (!match) {
    log.warn(`[runner-monitor] Forgejo runner ${name}: could not parse df output ${JSON.stringify(line)}`);
    return;
  }
  const usage = parseInt(match[1], 10);
  if (usage > FORGEJO_DISK_ALERT_PCT) {
    await raiseAlert(highDiskTitle(name), [
      `Disk usage on Forgejo runner **${name}** is **${usage}%**.`,
      "",
      "```",
      line,
      "```",
      "",
      "No automated cleanup — runner layout unknown.",
    ], `high disk on Forgejo runner ${name} (${usage}%)`, actions);
  } else if (usage <= FORGEJO_DISK_CLEAR_PCT) {
    await clearAlert(highDiskTitle(name), `disk at ${usage}%`);
  }
}

async function checkForgejoQueue(
  repos: string[],
  runners: forgejo.OrgActionRunner[],
  actions: string[],
): Promise<void> {
  const now = Date.now();
  const stalled: string[] = [];
  for (const repo of repos) {
    try {
      for (const job of await forgejo.listWaitingRunJobs(repo)) {
        if (hasMacLabel(job.labels)) continue;
        if (now - job.firstSeenAt <= FORGEJO_WAITING_ALERT_MS) continue;
        stalled.push(`- ${repo} · ${job.name} [${job.labels.join(", ")}] · waiting ${minutesSince(job.firstSeenAt, now)}m`);
      }
    } catch (err) {
      log.warn(`[runner-monitor] waiting jobs for ${repo} unavailable: ${err}`);
    }
  }
  if (stalled.length === 0) {
    await clearAlert(WAITING_TITLE, "no stalled Forgejo jobs");
    return;
  }
  const snapshot = runners.length > 0
    ? runners.map((r) => `- ${r.name} — ${r.status} [${r.labels.join(", ")}]`)
    : ["- (no org-scope runners visible)"];
  await raiseAlert(WAITING_TITLE, [
    `Forgejo Actions jobs have been waiting over ${FORGEJO_WAITING_ALERT_MS / 60_000}m with no runner picking them up (macOS jobs excluded — mac-runner-waker owns those):`,
    "",
    ...stalled,
    "",
    "**Org runner registry:**",
    ...snapshot,
    "",
    "Jobs whose labels no runner advertises (e.g. `tailnet`) also land here. The waiting time is tracked in memory, so it restarts when Claws restarts.",
  ], `${stalled.length} Forgejo job(s) waiting with no runner`, actions);
}

async function checkForgejoLongRunning(repos: string[], actions: string[]): Promise<void> {
  const now = Date.now();
  const long: string[] = [];
  for (const repo of repos) {
    try {
      for (const task of await forgejo.listRunningTasks(repo)) {
        const started = task.runStartedAt ? Date.parse(task.runStartedAt) : NaN;
        if (Number.isNaN(started) || now - started <= FORGEJO_RUNNING_ALERT_MS) continue;
        long.push(
          `- ${repo} · ${task.workflowId ?? "?"} / ${task.name} · run #${task.runNumber ?? "?"} · started ${task.runStartedAt} · ${minutesSince(started, now)}m · ${task.url ?? "(no url)"}`,
        );
      }
    } catch (err) {
      log.warn(`[runner-monitor] running tasks for ${repo} unavailable: ${err}`);
    }
  }
  if (long.length === 0) {
    await clearAlert(RUNNING_TITLE, "no long-running Forgejo jobs");
    return;
  }
  await raiseAlert(RUNNING_TITLE, [
    `Forgejo Actions jobs have been running for over ${FORGEJO_RUNNING_ALERT_MS / 60_000}m:`,
    "",
    ...long,
    "",
    "Nothing was cancelled — cancel it in the Forgejo UI if it is wedged.",
  ], `${long.length} Forgejo job(s) running over ${FORGEJO_RUNNING_ALERT_MS / 60_000}m`, actions);
}

async function checkForgejoRunners(actions: string[]): Promise<void> {
  if (!forgejo.isConfigured()) return;

  const repos = (await listRepos()).map((r) => r.fullName).filter((n) => isForgejoRepo(n));
  const owners = [...new Set(repos.map((n) => n.split("/")[0]))];

  const runners: forgejo.OrgActionRunner[] = [];
  for (const owner of owners) {
    try {
      const found = await forgejo.listOrgActionRunners(owner);
      if (found) runners.push(...found);
    } catch (err) {
      log.warn(`[runner-monitor] Forgejo org runner registry for ${owner} unavailable: ${err}`);
    }
  }

  for (const runner of runners) {
    try {
      await checkForgejoRunner(runner, actions);
    } catch (err) {
      log.warn(`[runner-monitor] Forgejo runner ${runner.name}: check failed: ${err}`);
    }
  }

  try {
    await checkForgejoQueue(repos, runners, actions);
  } catch (err) {
    log.warn(`[runner-monitor] Forgejo queue-stall check failed: ${err}`);
  }
  try {
    await checkForgejoLongRunning(repos, actions);
  } catch (err) {
    log.warn(`[runner-monitor] Forgejo long-running check failed: ${err}`);
  }
}

export async function run(): Promise<void> {
  const runners = RUNNER_HOSTS;
  const actions: string[] = [];

  if (runners.length === 0) {
    log.info("[runner-monitor] No runners configured — skipping");
  }

  for (const runner of runners) {
    try {
      await checkHost(runner, actions);
    } catch (err) {
      await reportError("runner-monitor:check-host", displayName(runner), err);
    }
  }

  try {
    await checkForgejoRunners(actions);
  } catch (err) {
    await reportError("runner-monitor:forgejo", "forgejo", err);
  }

  if (actions.length > 0) {
    const summary = `Runner monitor: ${actions.join(", ")}`;
    log.info(`[runner-monitor] ${summary}`);
    notify(summary);
  }
}
