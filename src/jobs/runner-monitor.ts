import type { IssueRef } from "../issue-id.js";
import { LAN_HOST_ALIASES, RUNNER_HOSTS, SELF_REPO, normaliseLanHostKey, resolveLanHost, type RunnerHost } from "../config.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { listRepos } from "../github.js";
import * as forgejo from "../forgejo.js";
import { getRepoConfig, type RepoLongRunningJob } from "../repo-config.js";
import { closeAlertIssueIfResolved, ensureAlertIssue } from "../occurrence-tracking.js";
import { mapWithConcurrency } from "../util.js";
import { buildSshArgs, execCapture, redactSshError, isHostAbsent, classifySshFailure, type SshFailureKind, isSafeAbsolutePath } from "../ssh.js";

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

/** Raise the Cannot SSH alert only after this many consecutive failed checks. */
const NO_SSH_ALERT_AFTER_FAILURES = 2;
/** Consecutive SSH failures per runner name; in memory, so a restart resets it. */
const sshFailureCounts = new Map<string, number>();

/**
 * Log-activity fingerprint per running job over 45m, keyed `${repo}#${runNumber}#${jobIndex}`.
 * In memory, so a restart re-baselines it, which only delays a silence alert.
 */
const jobProgress = new Map<string, { fingerprint: string; changedAt: number; checkedAt: number }>();

export function __resetRunnerMonitorStateForTests(): void {
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
  auth: "sshd answered but rejected Claws' key: authorise the service's public key for this user on the host.",
  "host-key": "The host key changed: the address may now be a different machine; verify, then remove the stale known_hosts entry.",
  other: "Unclassified ssh error; see the message above.",
};

function sshToRunner(name: string, command: string): Promise<string> {
  const { target } = resolveRunnerTarget(name);
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

export interface WaitingJob {
  repo: string;
  name: string;
  labels: string[];
  firstSeenAt: number;
}

interface ServedBy {
  repo: string;
  name: string;
}

const normLabels = (labels: string[]): string[] =>
  [...new Set(labels.map((l) => l.trim().toLowerCase()))].sort();

interface WaitCause {
  tag: "confirmed" | "unverified";
  text: string;
}

const servedNote = (served: ServedBy): string =>
  `inference, not registry proof: a same-label job (\`${served.repo}\` \`${served.name}\`) is running now on a runner Claws cannot see, so an instance-scope runner may serve these labels`;

/** Per-job tiers the always-on thinkcentre runner advertises; anything above waits for nas or ryzen. */
const ALWAYS_ON_RAM_GB = 6;
const ALWAYS_ON_DISK_GB = 40;
/** The on-demand NixOS hosts, powered off until a job needs them. */
const ON_DEMAND_HOSTS = ["nas", "ryzen"];

/**
 * The on-demand hosts a label set needs, or null when the always-on runner can serve it:
 * `gpu` is served only by ryzen, and a `ram-<N>g` above 6 or `disk-<N>g` above 40 only by
 * nas and ryzen. `labels` is the job's normalised label set.
 */
function onDemandNeed(labels: string[]): { tiers: string[]; hosts: string[] } | null {
  const above = (l: string, prefix: string, max: number): boolean => {
    const m = new RegExp(`^${prefix}-(\\d+)g$`).exec(l);
    return m !== null && Number(m[1]) > max;
  };
  const tiers = labels.filter((l) => l === "gpu" || above(l, "ram", ALWAYS_ON_RAM_GB) || above(l, "disk", ALWAYS_ON_DISK_GB));
  if (tiers.length === 0) return null;
  return { tiers, hosts: tiers.includes("gpu") ? ["ryzen"] : ON_DEMAND_HOSTS };
}

/** Names the on-demand hosts that serve the job's tier labels with their registry status, and the matching remedy. */
function describeOnDemandHosts(runners: forgejo.OrgActionRunner[], tiers: string[], hosts: string[]): { note: string; remedy: string } {
  const status = (host: string): "idle" | "active" | "offline" | "absent" => {
    const rows = runners.filter((r) => r.name.trim().toLowerCase() === host);
    if (rows.length === 0) return "absent";
    const online = rows.find((r) => r.status === "idle" || r.status === "active");
    return online ? (online.status as "idle" | "active") : "offline";
  };
  const isOn = (s: string): boolean => s === "idle" || s === "active";
  if (hosts.length === 1) {
    const [h] = hosts;
    const s = status(h);
    const prefix = `${tiers.join(", ")} is served only by the instance-scope runner pod on ${h}; `;
    if (s === "offline") return { note: `${prefix}it is offline in the registry, so it is likely powered off`, remedy: `fix if none does: power on ${h}` };
    if (s === "absent") return { note: `${prefix}it does not appear in the registry`, remedy: `fix if none does: check that ${h} is powered on and its runner pod is running` };
    return { note: `${prefix}it is online in the registry (${h} ${s})`, remedy: `fix if none does: check the runner pod on ${h}` };
  }
  const [a, b] = hosts;
  const sa = status(a);
  const sb = status(b);
  const prefix = `${tiers.join(", ")} is served only by the instance-scope runner pods on ${a} and ${b}; `;
  const checkPods = `check that ${a} or ${b} is powered on and its runner pod is running`;
  if (sa === "offline" && sb === "offline") {
    return { note: `${prefix}both are offline in the registry, so they are likely powered off`, remedy: `fix if none does: power on ${a} or ${b}` };
  }
  if (sa === "absent" && sb === "absent") {
    return { note: `${prefix}neither appears in the registry`, remedy: `fix if none does: ${checkPods}` };
  }
  if (isOn(sa) && isOn(sb)) {
    return { note: `${prefix}both are online in the registry (${a} ${sa}, ${b} ${sb})`, remedy: `fix if none does: check the runner pods on ${a} and ${b}` };
  }
  if (sa === "absent" || sb === "absent") {
    const word = (h: string, s: string): string => (s === "absent" ? `${h} is not in the registry` : isOn(s) ? `${h} is ${s}` : `${h} is offline in the registry`);
    return { note: `${prefix}${word(a, sa)}, ${word(b, sb)}`, remedy: `fix if none does: ${checkPods}` };
  }
  const [off, on, onStatus] = sa === "offline" ? [a, b, sb] : [b, a, sa];
  return {
    note: `${prefix}${off} is offline in the registry, ${on} is ${onStatus}`,
    remedy: `fix if none does: power on ${off}, or check the runner pod on ${on}`,
  };
}

function describeWaitCause(
  owner: string,
  labels: string[],
  runnersByOwner: Map<string, forgejo.OrgActionRunner[]>,
  unavailableOwners: Set<string>,
  servedLabelSets: Map<string, ServedBy> = new Map(),
): WaitCause {
  const runners = runnersByOwner.get(owner);
  const served = servedLabelSets.get(JSON.stringify(normLabels(labels)));
  const withNote = (base: string, note: string | null): string => (note ? `${base}; ${note}`: base);
  if (unavailableOwners.has(owner) || !runners) {
    return {
      tag: "unverified",
      text: withNote(`unverified: runner registry for ${owner} unavailable — cannot tell whether a runner matches`, served ? servedNote(served) : null),
    };
  }
  const need = normLabels(labels);
  const withLabels = runners.map((r) => ({ r, have: new Set(normLabels(r.labels)) }));
  const matching = withLabels.filter(({ have }) => need.every((l) => have.has(l))).map(({ r }) => r);
  if (matching.length === 0) {
    const missing = need.filter((l) => !withLabels.some(({ have }) => have.has(l)));
    const invisible = "instance-scope runners (such as fleet-infra's k3s pods) are not visible to Claws, so one may still serve this job if its host is up";
    const base = missing.length > 0
      ? `unverified: no runner visible in the ${owner} org registry advertises ${missing.join(", ")} — ${invisible}`
      : `unverified: no single runner visible in the ${owner} org registry advertises all of [${need.join(", ")}] — ${invisible}`;
    const text = withNote(base, served ? servedNote(served) : null);
    const onDemand = onDemandNeed(need);
    if (onDemand) {
      const hosts = describeOnDemandHosts(runners, onDemand.tiers, onDemand.hosts);
      return {
        tag: "unverified",
        text: `${text}; ${hosts.note}; ${hosts.remedy}; keep the tier on the job: the always-on runner does not offer it`,
      };
    }
    const remedy = missing.length > 0
      ? `fix if none does: bring up or register a runner advertising ${missing.join(", ")}, or drop ${missing.join(", ")} from the job's runs-on if retired`
      : `fix if none does: bring up or register a runner advertising all of [${need.join(", ")}], or drop a retired label from the job's runs-on`;
    return { tag: "unverified", text: `${text}; ${remedy}` };
  }
  const list = matching.map((r) => `${r.name} (${r.status})`).join(", ");
  const idle = matching.find((r) => r.status === "idle");
  if (idle) return { tag: "confirmed", text: `confirmed: matching runner ${idle.name} is idle but not picking the job up — check its logs` };
  const busy = matching.filter((r) => r.status === "active");
  if (busy.length > 0) {
    return { tag: "confirmed", text: `confirmed: queue backlog — matching runner busy: ${busy.map((r) => `${r.name} (${r.status})`).join(", ")}` };
  }
  const offlineOnDemand = matching.filter((r) => ON_DEMAND_HOSTS.includes(r.name.trim().toLowerCase()));
  const lead = served ? "fix if none does:" : "fix:";
  const remedy = offlineOnDemand.length === matching.length
    ? `${lead} power on ${offlineOnDemand.map((r) => r.name).join(" or ")}`
    : `${lead} bring ${matching.map((r) => r.name).join(", ")} back online — power on the host, or restart its runner if the host is up`;
  const base = withNote(`confirmed: matching runner offline: ${list}`, served ? servedNote(served) : null);
  return {
    tag: "confirmed",
    text: `${base}; the job stays queued and this alert tracks it until a matching runner registers; ${remedy}`,
  };
}

/**
 * A repo's waiting jobs of one name-and-labels key that sit in runs queued behind an earlier run of
 * their workflow's concurrency group — Forgejo starts same-group runs one at a time,
 * oldest first, so these wait however many runners are free.
 */
export interface QueuedBehind {
  /** The oldest unfinished run of the group, which holds the queue. */
  head: { index: number; status: string; createdAt: string; startedAt: string | null };
  workflowId: string;
  ref: string;
  group: string;
  /** The workflow's `cancel-in-progress` as written; null when unset. */
  cancelInProgress: string | null;
  /** Run numbers of the group's runs behind the head, oldest first. */
  queuedIndexes: number[];
  /** How many waiting jobs with this name and label set are in the queued runs. */
  waitingJobs: number;
}

const MAX_LISTED_QUEUED_RUNS = 5;

/** `HH:MM UTC` of an ISO timestamp, or the raw text when it does not parse. */
function utcClock(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? iso : `${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

function describeQueuedBehind(q: QueuedBehind, stalledCount: number): WaitCause {
  const created = utcClock(q.head.createdAt);
  const started = q.head.startedAt === null ? "not started" : `started ${utcClock(q.head.startedAt)}`;
  const cancel = q.cancelInProgress === null ? "unset" : `\`${q.cancelInProgress}\``;
  const listed = q.queuedIndexes.slice(0, MAX_LISTED_QUEUED_RUNS).map((i) => `#${i}`);
  if (q.queuedIndexes.length > MAX_LISTED_QUEUED_RUNS) listed.push("…");
  return {
    tag: "confirmed",
    text: `confirmed: queued behind run #${q.head.index} of ${q.workflowId} on ${q.ref} (${q.head.status}, created ${created}, ${started}) — the workflow declares concurrency group \`${q.group}\` with cancel-in-progress ${cancel}, and Forgejo runs same-group runs one at a time, oldest first; the runner registry is not the cause; fix: set cancel-in-progress: true so newer runs supersede queued ones, or drop the group — ${q.queuedIndexes.length} run(s) queued: ${listed.join(", ")}; all ${stalledCount} stalled jobs are in queued runs`,
  };
}

/**
 * Group stalled Forgejo jobs by repo, name and label set, with a per-group runner-match cause.
 * A group whose name-and-labels key is in `queuedBehind` (repo → key) gets the concurrency-queue
 * cause instead, since the repo's run list and workflow file prove it.
 */
export function formatWaitingJobGroups(
  jobs: WaitingJob[],
  runnersByOwner: Map<string, forgejo.OrgActionRunner[]>,
  unavailableOwners: Set<string>,
  now: number,
  servedLabelSets: Map<string, ServedBy> = new Map(),
  queuedBehind: Map<string, Map<string, QueuedBehind>> = new Map(),
): { lines: string[]; confirmed: number; unverified: number } {
  const repos = new Map<string, Map<string, { job: WaitingJob; count: number; oldest: number }>>();
  for (const job of jobs) {
    let groups = repos.get(job.repo);
    if (!groups) repos.set(job.repo, (groups = new Map()));
    const key = JSON.stringify([job.name, normLabels(job.labels)]);
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.oldest = Math.min(g.oldest, job.firstSeenAt);
    } else {
      groups.set(key, { job, count: 1, oldest: job.firstSeenAt });
    }
  }
  const lines: string[] = [];
  const causes = new Map<string, number>();
  let confirmed = 0;
  let unverified = 0;
  for (const [repo, groups] of repos) {
    if (lines.length > 0) lines.push("");
    lines.push(`**${repo}**`);
    const owner = repo.split("/")[0];
    for (const [key, { job, count, oldest }] of groups) {
      // Only a group whose every stalled job is in a queued run is confirmed; a name shared
      // with jobs elsewhere (another workflow, other labels) keeps the registry cause.
      const queued = queuedBehind.get(repo)?.get(key);
      const cause = queued && queued.waitingJobs >= count
        ? describeQueuedBehind(queued, count)
        : describeWaitCause(owner, job.labels, runnersByOwner, unavailableOwners, servedLabelSets);
      if (cause.tag === "confirmed") confirmed++;
      else unverified++;
      let n = causes.get(cause.text);
      if (n === undefined) causes.set(cause.text, (n = causes.size + 1));
      lines.push(`- ${job.name} [${job.labels.join(", ")}] · ${count} waiting · longest ${minutesSince(oldest, now)}m — ${cause.tag} (cause ${n})`);
    }
  }
  if (causes.size > 0) {
    lines.push("", "**Causes**");
    for (const [text, n] of causes) lines.push(`${n}. ${text}`);
  }
  return { lines, confirmed, unverified };
}

const STABLE_GROUP_CONTEXTS = new Set([
  "github.ref",
  "github.ref_name",
  "github.head_ref",
  "github.base_ref",
  "github.workflow",
  "github.repository",
]);

/**
 * True when a concurrency group expression evaluates identically for every run of one
 * workflow on one ref: literals and the constant contexts only. Anything else
 * (`github.sha`, `github.run_id`, `github.event.*`, `inputs.*`, `matrix.*`, `env.*`)
 * can put same-ref runs in different groups, so the queue cannot be proven.
 */
export function isStableConcurrencyGroup(group: string): boolean {
  for (const m of group.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    if (!STABLE_GROUP_CONTEXTS.has(m[1].trim())) return false;
  }
  return true;
}

/**
 * `repo`'s waiting jobs that sit in runs queued behind an earlier run of their
 * concurrency group, keyed like `formatWaitingJobGroups` groups:
 * `JSON.stringify([name, normLabels(labels)])`. Two unfinished runs with the same workflow and
 * ref share a group when the workflow declares `concurrency.group`; a literal
 * `cancel-in-progress: true` means nothing queues. Any read failure is logged and
 * yields an empty map, so the registry causes still apply.
 */
async function findQueuedBehind(repo: string): Promise<Map<string, QueuedBehind>> {
  const out = new Map<string, QueuedBehind>();
  try {
    const groups = new Map<string, forgejo.ForgejoUnfinishedActionRun[]>();
    for (const r of await forgejo.listUnfinishedActionRuns(repo)) {
      const key = JSON.stringify([r.workflowId, r.ref]);
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    const concurrency = new Map<string, forgejo.WorkflowConcurrency | null>();
    // Largest queue first, so a name-and-labels key shared by several groups names the longest one.
    const ordered = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length);
    for (const runs of ordered) {
      const { workflowId, ref } = runs[0];
      if (!concurrency.has(workflowId)) concurrency.set(workflowId, await forgejo.readWorkflowConcurrency(repo, workflowId));
      const c = concurrency.get(workflowId);
      if (!c || c.cancelInProgress === "true" || !isStableConcurrencyGroup(c.group)) continue;
      const [head, ...queued] = [...runs].sort((a, b) => a.index - b.index);
      // A waiting head means a runner problem, and a second running run disproves one serialising group.
      if (head.status !== "running" || queued.some((r) => r.status !== "waiting")) continue;
      const queuedIndexes = queued.map((r) => r.index);
      const jobLists = await mapWithConcurrency(queued, 4, (r) => forgejo.getActionRunJobs(repo, r.index));
      const counts = new Map<string, number>();
      for (const { jobs } of jobLists) {
        for (const j of jobs) {
          // The jobs route omits runs-on, so labels come from the workflow file; a job without readable labels cannot be matched.
          const labels = c.jobLabels[j.name];
          if (j.status !== "waiting" || !labels) continue;
          const key = JSON.stringify([j.name, normLabels(labels)]);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      for (const [key, waitingJobs] of counts) {
        if (out.has(key)) continue;
        out.set(key, {
          head: { index: head.index, status: head.status, createdAt: head.createdAt, startedAt: head.startedAt },
          workflowId,
          ref,
          group: c.group,
          cancelInProgress: c.cancelInProgressRaw,
          queuedIndexes,
          waitingJobs,
        });
      }
    }
  } catch (err) {
    log.warn(`[runner-monitor] concurrency queue for ${repo} unavailable: ${err}`);
    return new Map();
  }
  return out;
}

async function checkForgejoQueue(
  repos: string[],
  runners: forgejo.OrgActionRunner[],
  runnersByOwner: Map<string, forgejo.OrgActionRunner[]>,
  unavailableOwners: Set<string>,
  actions: string[],
): Promise<void> {
  const now = Date.now();
  const stalled: WaitingJob[] = [];
  const servedLabelSets = new Map<string, ServedBy>();
  for (const repo of repos) {
    try {
      const { waiting, running } = await forgejo.listActionRunJobs(repo);
      for (const job of running) {
        const key = JSON.stringify(normLabels(job.labels));
        if (!servedLabelSets.has(key)) servedLabelSets.set(key, { repo, name: job.name });
      }
      for (const job of waiting) {
        if (hasMacLabel(job.labels)) continue;
        if (now - job.firstSeenAt <= FORGEJO_WAITING_ALERT_MS) continue;
        stalled.push({ repo, name: job.name, labels: job.labels, firstSeenAt: job.firstSeenAt });
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
  const queuedBehind = new Map<string, Map<string, QueuedBehind>>();
  for (const repo of new Set(stalled.map((j) => j.repo))) {
    const q = await findQueuedBehind(repo);
    if (q.size > 0) queuedBehind.set(repo, q);
  }
  const groups = formatWaitingJobGroups(stalled, runnersByOwner, unavailableOwners, now, servedLabelSets, queuedBehind);
  await raiseAlert(WAITING_TITLE, [
    `Forgejo Actions jobs have been waiting over ${FORGEJO_WAITING_ALERT_MS / 60_000}m (macOS jobs excluded — mac-runner-waker owns those): ${groups.confirmed} group(s) have a confirmed cause (proven by the org registry, or by the repo's own run list and workflow file); ${groups.unverified} group(s) cannot be verified because instance-scope runners are not visible to Claws.`,
    "",
    ...groups.lines,
    "",
    "**Org runner registry** (instance-scope runners such as fleet-infra's k3s pods are not visible to Claws):",
    ...snapshot,
    "",
    "`confirmed:` = the org registry, or the repo's own run list and workflow file, proves the cause. `unverified:` = no matching visible runner, so instance-scope capacity may be serving the job. Each job line names its cause number; the **Causes** list holds each distinct cause once, and anything marked `inference` is not registry proof. The waiting time is tracked in memory, so it restarts when Claws restarts.",
  ], `${stalled.length} Forgejo job(s) waiting (${groups.confirmed} confirmed, ${groups.unverified} unverified)`, actions);
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
  for (const job of jobs.filter((j) => j.status === "running")) {
    try {
      const { steps } = await forgejo.getActionJobStepLogs(repo, runNumber, job.index);
      const pos = steps.findIndex((st) => st.status === "running");
      const logLength = steps.reduce((n, st) => n + st.log.length, 0);
      out.push({
        index: job.index,
        name: job.name,
        progress: {
          stepIndex: pos,
          stepName: pos >= 0 ? steps[pos].name : null,
          stepCount: steps.length,
          fingerprint: `${pos >= 0 ? steps[pos].index : -1}:${logLength}`,
        },
      });
    } catch (err) {
      errors.push(`job ${job.index}: ${err}`);
      out.push({ index: job.index, name: job.name, progress: null });
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
        const runtime = minutesSince(started, now);
        const workflow = task.workflowId ?? "?";
        const url = task.url ?? "(no url)";
        const prefix = (jobName: string) => `- ${repo} · ${workflow} / ${jobName} · run #${task.runNumber ?? "?"} · running ${runtime}m`;
        const jobs = task.runNumber !== null ? await probeRunningJobs(repo, task.runNumber) : null;
        if (jobs === null) {
          long.push(`${prefix(task.name)} (threshold ${defaultMinutes}m — default) · progress unavailable · ${url}`);
          continue;
        }
        for (const job of jobs) {
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
          if (now - started > threshold * 60_000) {
            long.push(`${prefix(job.name)} (threshold ${threshold}m — ${source}) · ${detail} · ${url}`);
          } else if (silent) {
            long.push(`${prefix(job.name)} (threshold ${threshold}m — ${source}) · ${detail} — possibly wedged · ${url}`);
          } else {
            const why = job.progress === null ? "progress unavailable" : "log growing";
            log.info(`[runner-monitor] ${repo} ${workflow} / ${job.name} run #${task.runNumber} at ${runtime}m: within its ${threshold}m allowance, ${why}`);
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

  const repos = (await listRepos()).map((r) => r.fullName);
  const owners = [...new Set(repos.map((n) => n.split("/")[0]))];

  const runners: forgejo.OrgActionRunner[] = [];
  const runnersByOwner = new Map<string, forgejo.OrgActionRunner[]>();
  const unavailableOwners = new Set<string>();
  for (const owner of owners) {
    try {
      const found = await forgejo.listOrgActionRunners(owner);
      if (found) {
        runners.push(...found);
        runnersByOwner.set(owner, found);
      } else {
        unavailableOwners.add(owner);
      }
    } catch (err) {
      unavailableOwners.add(owner);
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
    await checkForgejoQueue(repos, runners, runnersByOwner, unavailableOwners, actions);
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
  }
}
