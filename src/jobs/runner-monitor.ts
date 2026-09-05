import { RUNNER_HOSTS, SELF_REPO, type RunnerHost } from "../config.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../slack.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";
import { buildSshArgs, execCapture, isSafeAbsolutePath } from "../ssh.js";

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

export async function run(): Promise<void> {
  const runners = RUNNER_HOSTS;
  if (runners.length === 0) {
    log.info("[runner-monitor] No runners configured — skipping");
    return;
  }

  const actions: string[] = [];

  for (const runner of runners) {
    try {
      await checkHost(runner, actions);
    } catch (err) {
      await reportError("runner-monitor:check-host", displayName(runner), err);
    }
  }

  if (actions.length > 0) {
    const summary = `Runner monitor: ${actions.join(", ")}`;
    log.info(`[runner-monitor] ${summary}`);
    notify(summary);
  }
}
