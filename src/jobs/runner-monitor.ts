import type { IssueRef } from "../issue-id.js";
import { LAN_HOST_ALIASES, RUNNER_HOSTS, SELF_REPO, normaliseLanHostKey, resolveLanHost, type RunnerHost } from "../config.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { listRepos } from "../github.js";
import * as forgejo from "../forgejo.js";
import { getRepoConfig, type RepoLongRunningJob } from "../repo-config.js";
import { closeAlertIssueIfResolved, ensureAlertIssue } from "../occurrence-tracking.js";
import { buildSshArgs, execCapture, redactSshError, isHostAbsent, classifySshFailure, type SshFailureKind, isSafeAbsolutePath, type SshConnection } from "../ssh.js";
import { SshCaError, withJobSshIdentity } from "../ssh-ca.js";

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

/**
 * A configured runner with this run's SSH identity: `run` replaces the
 * deprecated config `identityFile` with a per-run key and certificate from
 * `withJobSshIdentity`, which every `sshExec` below authenticates with.
 */
type AuthedRunnerHost = RunnerHost & Pick<SshConnection, "certificateFile">;

export function sshExec(runner: AuthedRunnerHost, command: string, timeoutMs: number = 30_000): Promise<string> {
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
/** A Mac runner raises below this much free space on its data volume. */
const MAC_DISK_ALERT_FREE_GIB = 10;
/** A Mac runner's high-disk alert closes at this much free space or more. */
const MAC_DISK_CLEAR_FREE_GIB = 15;
const SAFE_RUNNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALERT_FOOTER = "*— Automated by Claws · runner-monitor —*";

/** Retired queue-stall alert (issue #clw_01M6TNMQTRHYBKKK4540GBT5JM); only closed, never filed. */
const RETIRED_WAITING_TITLE = "[runner-monitor] Forgejo Actions jobs waiting with no runner";
const RUNNING_TITLE = `[runner-monitor] Forgejo Actions job running over ${FORGEJO_RUNNING_ALERT_MS / 60_000}m`;
const highDiskTitle = (name: string) => `[runner-monitor] High disk on Forgejo runner ${name}`;
const offlineTitle = (name: string) => `[runner-monitor] Forgejo runner ${name} offline but host is up`;
const noSshTitle = (name: string) => `[runner-monitor] Cannot SSH to Forgejo runner ${name}`;

/** Raise the Cannot SSH alert only after this many consecutive failed checks. */
const NO_SSH_ALERT_AFTER_FAILURES = 2;
/** Consecutive SSH failures per runner name; in memory, so a restart resets it. */
const sshFailureCounts = new Map<string, number>();

/**
 * Log-activity fingerprint per running job over 45m, keyed `${repo}#${runNumber}#${jobIndex}`.
 * In memory, so a restart re-baselines it, which only delays a silence alert.
 */
const jobProgress = new Map<string, { fingerprint: string; changedAt: number; checkedAt: number }>();

/** Set once the retired queue-stall issue has been force-closed this process. */
let retiredWaitingAlertClosed = false;

export function __resetRunnerMonitorStateForTests(): void {
  retiredWaitingAlertClosed = false;
  sshFailureCounts.clear();
  jobProgress.clear();
}

function hasMacLabel(labels: string[]): boolean {
  return labels.some((l) => l.toLowerCase() === "macos");
}

function minutesSince(ms: number, now: number): number {
  return Math.round((now - ms) / 60_000);
}

function resolveRunnerTarget(name: string) {
  const target = resolveLanHost({ host: name });
  const key = normaliseLanHostKey(name);
  return { target, aliasKey: Object.hasOwn(LAN_HOST_ALIASES, key) ? key : undefined };
}

const SSH_CAUSE_LINES: Record<SshFailureKind, string> = {
  "name-resolution": "The name did not resolve: add it to `LAN_HOST_ALIASES` or fix LAN DNS.",
  refused: "The address answered but nothing accepted SSH on port 22. Either Remote Login/sshd is off on that machine, the address now belongs to another machine, or the Claws pod's egress NetworkPolicy (fleet-infra `clusters/my-cluster/claws/networkpolicy.yaml`) has no TCP 22 rule for it. kube-router reports a denied egress as a refusal, so if every runner refuses in the same run, the policy is the cause.",
  auth: "sshd answered but rejected Claws' certificate: map this host's `access-<host>` principal to the login user (nixos-config `ssh-ca.nix`, or `mac-bootstrap.sh` on a Mac) and allow it in the `claws` provisioner (fleet-infra `docs/ssh-ca.md`).",
  "host-key": "The host did not present a certificate signed by the host CA: the address may now be a different machine, or the host's key was never signed; a LAN-aliased Mac is checked against `<slug>.local` through `HostKeyAlias`, so its certificate must carry that principal; sign it with nixos-config `scripts/sign-host-key.sh` after verifying its fingerprint.",
  other: "Unclassified ssh error; see the message above.",
};

function sshToRunner(name: string, command: string, timeoutMs = 30_000): Promise<string> {
  const { target } = resolveRunnerTarget(name);
  const sshTarget = target.user ? `${target.user}@${target.host}` : target.host;
  return withJobSshIdentity("runner-monitor", [name], ({ identityFile, certificateFile }) =>
    execCapture("ssh", [...buildSshArgs({ ...target, identityFile, certificateFile }), sshTarget, command], { timeout: timeoutMs })
      .catch((err: unknown) => { throw redactSshError(err, target, name); }));
}

/**
 * Read-only disk breakdown for a Mac runner: one SSH call per probe so a slow
 * `du` cannot sink the rest. No sudo (the Mac has no non-interactive sudo).
 */
async function getMacDiskBreakdown(name: string): Promise<string> {
  const probes: Array<{ heading: string; cmd: string }> = [
    { heading: "Data volume:", cmd: "df -h /System/Volumes/Data" },
    ...[
      "$HOME/forgejo-runner/work",
      "$HOME/Library/Developer/Xcode/DerivedData",
      '"$HOME/Library/Developer/Xcode/iOS DeviceSupport"',
      "$HOME/Library/Developer/CoreSimulator",
      "$HOME/Library/Caches",
      "/nix",
    ].map((path) => ({ heading: "", cmd: `du -sh ${path} 2>/dev/null` })),
    { heading: "Largest job checkouts:", cmd: "du -sh $HOME/forgejo-runner/work/*/* 2>/dev/null | sort -hr | head -10" },
    { heading: "Local Time Machine snapshots:", cmd: "tmutil listlocalsnapshots /" },
  ];
  const sections: string[] = [];
  const dirLines: string[] = [];
  for (const probe of probes) {
    try {
      const out = (await sshToRunner(name, probe.cmd, 60_000)).trim();
      if (!out) continue;
      if (probe.heading === "") dirLines.push(out);
      else sections.push(`${probe.heading}\n${out}`);
    } catch { /* skip */ }
  }
  if (dirLines.length > 0) sections.splice(1, 0, `Top directories:\n${dirLines.join("\n")}`);
  if (sections.length === 0) {
    log.warn(`[runner-monitor] Forgejo runner ${name}: disk breakdown unavailable`);
    return "(breakdown unavailable)";
  }
  return sections.join("\n\n");
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

  const isMac = hasMacLabel(runner.labels);
  let output: string;
  try {
    output = await sshToRunner(name, online ? (isMac ? "df -Pk /System/Volumes/Data | tail -1" : "df -Pk / | tail -1") : "true");
  } catch (err) {
    if (err instanceof SshCaError) {
      // A CA outage says nothing about the runner: no alert, no failure count.
      log.warn("[runner-monitor] No SSH certificate for this run; skipping the Forgejo runner", { runner: name, error: err.message });
      return;
    }
    const kind = classifySshFailure(err);
    if (isHostAbsent(err) && !(online && kind === "name-resolution")) {
      log.info(`[runner-monitor] Forgejo runner ${name} (${runner.status}): host not reachable — skipping`);
      if (!online) await clearAlert(offlineTitle(name), "host is down");
      sshFailureCounts.delete(name);
      await clearAlert(noSshTitle(name), "host is down");
      if (online) await clearAlert(highDiskTitle(name), "host is down");
      return;
    }
    const failures = (sshFailureCounts.get(name) ?? 0) + 1;
    sshFailureCounts.set(name, failures);
    if (failures < NO_SSH_ALERT_AFTER_FAILURES) {
      log.info(`[runner-monitor] Forgejo runner ${name}: SSH failed (${kind}), ${failures} consecutive failure — alerting after ${NO_SSH_ALERT_AFTER_FAILURES}`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const { target, aliasKey } = resolveRunnerTarget(name);
    const resolved = `${target.user ? `${target.user}@` : ""}${target.host}`;
    const origin = aliasKey ? `LAN alias table entry \`${aliasKey}\` in \`src/config.ts\`` : "LAN DNS, no alias entry";
    await raiseAlert(noSshTitle(name), [
      kind === "name-resolution"
        ? `Claws cannot resolve Forgejo runner **${name}** (status \`${runner.status}\`).`
        : `Claws cannot SSH to Forgejo runner **${name}** (status \`${runner.status}\`), but the host answered.`,
      "",
      "```",
      message,
      "```",
      "",
      `**Resolved target:** \`${resolved}\` (${origin})`,
      `**Failure:** ${kind}`,
      SSH_CAUSE_LINES[kind],
    ], `cannot SSH to Forgejo runner ${name}`, actions);
    return;
  }
  sshFailureCounts.delete(name);
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
  // `-k` forces 1024-byte blocks on GNU and macOS (macOS `df -P` otherwise prints 512-byte blocks).
  // Columns: Filesystem 1024-blocks Used Available Capacity Mounted-on
  if (isMac) {
    const cols = line.split(/\s+/);
    const totalKiB = Number(cols[1]);
    const availKiB = Number(cols[3]);
    const pct = cols[4]?.match(/^(\d+)%$/)?.[1];
    if (!Number.isFinite(totalKiB) || !Number.isFinite(availKiB) || cols[1] === "" || cols[3] === "" || !pct) {
      log.warn(`[runner-monitor] Forgejo runner ${name}: could not parse df output ${JSON.stringify(line)}`);
      return;
    }
    const freeGiB = Math.round((availKiB / 1024 / 1024) * 10) / 10;
    const totalGiB = Math.round((totalKiB / 1024 / 1024) * 10) / 10;
    if (freeGiB < MAC_DISK_ALERT_FREE_GIB) {
      const breakdown = await getMacDiskBreakdown(name);
      await raiseAlert(highDiskTitle(name), [
        `Disk on Forgejo runner **${name}** (data volume) has **${freeGiB} GiB free** of ${totalGiB} GiB (${pct}% used).`,
        "",
        "```",
        line,
        "```",
        "",
        `No automated cleanup on a personal Mac. \`~/forgejo-runner/work\` (set in nixos-config \`home/mac/forgejo-runner.nix\`) is safe to clear while no job runs. Xcode DerivedData and local Time Machine snapshots are the other usual culprits. The alert closes at ${MAC_DISK_CLEAR_FREE_GIB} GiB free.`,
        "",
        "**Disk breakdown:**",
        "",
        "```",
        breakdown,
        "```",
      ], `high disk on Forgejo runner ${name} (${freeGiB} GiB free)`, actions);
    } else if (freeGiB >= MAC_DISK_CLEAR_FREE_GIB) {
      await clearAlert(highDiskTitle(name), `disk has ${freeGiB} GiB free`);
    }
    return;
  }
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

/**
 * Log Forgejo jobs waiting over the threshold. Queued jobs are never alerted on: Claws cannot see
 * instance-scope runners, and concurrency-group queues look identical to stalls.
 */
async function logForgejoQueue(repos: string[]): Promise<void> {
  const now = Date.now();
  const jobs: Array<{ repo: string; job: string; labels: string[]; waitingMinutes: number }> = [];
  for (const repo of repos) {
    try {
      const { waiting } = await forgejo.listActionRunJobs(repo);
      for (const job of waiting) {
        if (hasMacLabel(job.labels)) continue;
        if (now - job.firstSeenAt <= FORGEJO_WAITING_ALERT_MS) continue;
        jobs.push({ repo, job: job.name, labels: job.labels, waitingMinutes: minutesSince(job.firstSeenAt, now) });
      }
    } catch (err) {
      log.warn(`[runner-monitor] waiting jobs for ${repo} unavailable: ${err}`);
    }
  }
  if (jobs.length === 0) return;
  log.info("[runner-monitor] Forgejo Actions jobs waiting over threshold", {
    count: jobs.length,
    thresholdMinutes: FORGEJO_WAITING_ALERT_MS / 60_000,
    jobs,
  });
}

/**
 * The repo's `claws.json` `longRunningJobs` entry covering this job, or null.
 * A job-specific entry beats a workflow-wide one; job names match case-insensitively.
 */
export function allowanceFor(repo: string, workflowId: string | null, jobName: string | null): RepoLongRunningJob | null {
  if (!workflowId) return null;
  const entries = (getRepoConfig(repo)?.longRunningJobs ?? []).filter((e) => e.workflow === workflowId);
  const name = jobName?.toLowerCase();
  return entries.find((e) => e.job !== undefined && e.job.toLowerCase() === name)
    ?? entries.find((e) => e.job === undefined)
    ?? null;
}

interface ProbedJob {
  index: number;
  name: string;
  /** The job's own start (ms), or null when the jobs API omits it. */
  started: number | null;
  /** Running for no longer than the alert threshold: not probed, never listed. */
  fresh?: boolean;
  /** Null when the job's step logs could not be read. */
  progress: { stepIndex: number; stepName: string | null; stepCount: number; fingerprint: string } | null;
}

/**
 * The run's `running` jobs with their current step and log fingerprint, or null
 * when the jobs list is unavailable. A step-log failure leaves that job's progress
 * null. Every failure is logged once for the run.
 */
async function probeRunningJobs(repo: string, runNumber: number): Promise<ProbedJob[] | null> {
  const errors: string[] = [];
  let jobs: forgejo.ForgejoActionJob[];
  try {
    jobs = (await forgejo.getActionRunJobs(repo, runNumber)).jobs;
  } catch (err) {
    log.warn(`[runner-monitor] job progress for ${repo} run #${runNumber} unavailable: ${err}`);
    return null;
  }
  const out: ProbedJob[] = [];
  const now = Date.now();
  for (const job of jobs.filter((j) => j.status === "running")) {
    const parsed = job.started && !job.started.startsWith("0001-") ? Date.parse(job.started) : NaN;
    const jobStarted = Number.isNaN(parsed) ? null : parsed;
    if (jobStarted !== null && now - jobStarted <= FORGEJO_RUNNING_ALERT_MS) {
      out.push({ index: job.index, name: job.name, started: jobStarted, progress: null, fresh: true });
      continue;
    }
    try {
      const { steps } = await forgejo.getActionJobStepLogs(repo, runNumber, job.index);
      const pos = steps.findIndex((st) => st.status === "running");
      const logLength = steps.reduce((n, st) => n + st.log.length, 0);
      out.push({
        index: job.index,
        name: job.name,
        started: jobStarted,
        progress: {
          stepIndex: pos,
          stepName: pos >= 0 ? steps[pos].name : null,
          stepCount: steps.length,
          fingerprint: `${pos >= 0 ? steps[pos].index : -1}:${logLength}`,
        },
      });
    } catch (err) {
      errors.push(`job ${job.index}: ${err}`);
      out.push({ index: job.index, name: job.name, started: jobStarted, progress: null });
    }
  }
  if (errors.length > 0) log.warn(`[runner-monitor] job progress for ${repo} run #${runNumber} unavailable: ${errors.join("; ")}`);
  return out;
}

async function checkForgejoLongRunning(repos: string[], actions: string[]): Promise<void> {
  const now = Date.now();
  const defaultMinutes = FORGEJO_RUNNING_ALERT_MS / 60_000;
  const long: string[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    try {
      for (const task of await forgejo.listRunningTasks(repo)) {
        const started = task.runStartedAt ? Date.parse(task.runStartedAt) : NaN;
        if (Number.isNaN(started) || now - started <= FORGEJO_RUNNING_ALERT_MS) continue;
        const workflow = task.workflowId ?? "?";
        const url = task.url ?? "(no url)";
        const prefix = (jobName: string, since: number = started) => `- ${repo} · ${workflow} / ${jobName} · run #${task.runNumber ?? "?"} · running ${minutesSince(since, now)}m`;
        const jobs = task.runNumber !== null ? await probeRunningJobs(repo, task.runNumber) : null;
        if (jobs === null) {
          long.push(`${prefix(task.name)} (threshold ${defaultMinutes}m — default) · progress unavailable · ${url}`);
          continue;
        }
        for (const job of jobs) {
          if (job.fresh) continue;
          const jobStart = job.started ?? started;
          const jobRuntime = minutesSince(jobStart, now);
          const allowance = allowanceFor(repo, task.workflowId, job.name);
          const threshold = allowance?.maxMinutes ?? defaultMinutes;
          const source = allowance ? "claws.json allowance" : "default";
          let detail: string;
          let silent = false;
          if (job.progress === null) {
            detail = "progress unavailable";
          } else {
            const key = `${repo}#${task.runNumber}#${job.index}`;
            seen.add(key);
            const prev = jobProgress.get(key);
            const { fingerprint, stepIndex, stepName, stepCount } = job.progress;
            let activity: string;
            if (!prev) {
              activity = "first check, no trend yet";
              jobProgress.set(key, { fingerprint, changedAt: now, checkedAt: now });
            } else if (prev.fingerprint !== fingerprint) {
              activity = "log grew since the last check";
              jobProgress.set(key, { fingerprint, changedAt: now, checkedAt: now });
            } else {
              activity = `log unchanged for ${minutesSince(prev.changedAt, now)}m`;
              silent = allowance !== null && now - prev.changedAt >= allowance.silentMinutes * 60_000;
              jobProgress.set(key, { ...prev, checkedAt: now });
            }
            const step = stepIndex >= 0 ? `step ${stepIndex + 1}/${stepCount} "${stepName}"` : `step ?/${stepCount}`;
            detail = `${step} · ${activity}`;
          }
          if (now - jobStart > threshold * 60_000) {
            long.push(`${prefix(job.name, jobStart)} (threshold ${threshold}m — ${source}) · ${detail} · ${url}`);
          } else if (silent) {
            long.push(`${prefix(job.name, jobStart)} (threshold ${threshold}m — ${source}) · ${detail} — possibly wedged · ${url}`);
          } else {
            const why = job.progress === null ? "progress unavailable" : "log growing";
            log.info(`[runner-monitor] ${repo} ${workflow} / ${job.name} run #${task.runNumber} at ${jobRuntime}m: within its ${threshold}m allowance, ${why}`);
          }
        }
      }
    } catch (err) {
      log.warn(`[runner-monitor] running runs for ${repo} unavailable: ${err}`);
    }
  }
  for (const key of jobProgress.keys()) if (!seen.has(key)) jobProgress.delete(key);
  if (long.length === 0) {
    await clearAlert(RUNNING_TITLE, "no long-running Forgejo runs");
    return;
  }
  await raiseAlert(RUNNING_TITLE, [
    `Forgejo Actions jobs are running past their threshold (${defaultMinutes}m by default), or past ${defaultMinutes}m with a log that has stopped growing:`,
    "",
    ...long,
    "",
    "Nothing was cancelled — cancel it in the Forgejo UI if it is wedged.",
    `A repo's \`claws.json\` \`longRunningJobs\` entry raises a workflow's allowance past ${defaultMinutes}m for a job that normally runs long (see docs/repo-config.md).`,
  ], `${long.length} Forgejo job(s) running long`, actions);
}

/**
 * Collapse registry rows that share a runner name. Forgejo keeps orphaned rows after a
 * re-registration, and alerts are keyed by name, so a stale offline row would re-raise the
 * alert its live idle/active sibling clears. The first online row wins; with none online the
 * first row wins, so a name is probed once.
 */
export function collapseForgejoRunnersByName(runners: forgejo.OrgActionRunner[]): {
  kept: forgejo.OrgActionRunner[];
  ignored: Array<{ row: forgejo.OrgActionRunner; keptRow: forgejo.OrgActionRunner }>;
} {
  const isOnline = (r: forgejo.OrgActionRunner) => r.status === "idle" || r.status === "active";
  const byName = new Map<string, forgejo.OrgActionRunner[]>();
  for (const r of runners) {
    const group = byName.get(r.name);
    if (group) group.push(r);
    else byName.set(r.name, [r]);
  }
  const kept: forgejo.OrgActionRunner[] = [];
  const ignored: Array<{ row: forgejo.OrgActionRunner; keptRow: forgejo.OrgActionRunner }> = [];
  for (const group of byName.values()) {
    const keptRow = group.find(isOnline) ?? group[0];
    kept.push(keptRow);
    for (const row of group) if (row !== keptRow) ignored.push({ row, keptRow });
  }
  return { kept, ignored };
}

async function checkForgejoRunners(actions: string[]): Promise<void> {
  if (!forgejo.isConfigured()) return;

  if (!retiredWaitingAlertClosed) {
    try {
      await closeAlertIssueIfResolved({ repo: SELF_REPO, title: RETIRED_WAITING_TITLE, logPrefix: "runner-monitor", reason: "queue-stall alert retired", force: true });
    } catch (err) {
      log.warn(`[runner-monitor] closing retired queue-stall issue failed: ${err}`);
    }
    retiredWaitingAlertClosed = true;
  }

  const repos = (await listRepos()).map((r) => r.fullName);
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

  const { kept, ignored } = collapseForgejoRunnersByName(runners);
  for (const { row, keptRow } of ignored) {
    log.info(`[runner-monitor] Forgejo runner ${row.name}: ignoring registry row ${row.id ?? "?"} (${row.status}) — row ${keptRow.id ?? "?"} is ${keptRow.status}`);
  }

  for (const runner of kept) {
    try {
      await checkForgejoRunner(runner, actions);
    } catch (err) {
      log.warn(`[runner-monitor] Forgejo runner ${runner.name}: check failed: ${err}`);
    }
  }

  try {
    await logForgejoQueue(repos);
  } catch (err) {
    log.warn(`[runner-monitor] Forgejo queue log failed: ${err}`);
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
      await withJobSshIdentity("runner-monitor", [runner.name ?? runner.host], ({ identityFile, certificateFile }) => {
        const authed: AuthedRunnerHost = { ...runner, identityFile, certificateFile };
        return checkHost(authed, actions);
      });
    } catch (err) {
      if (err instanceof SshCaError) {
        log.warn("[runner-monitor] No SSH certificate for this run; skipping the runner host", { runner: displayName(runner), error: err.message });
        continue;
      }
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
  }
}
