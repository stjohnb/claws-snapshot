import { execFile } from "node:child_process";
import os from "node:os";
import { RUNNER_HOSTS, type RunnerHost } from "../config.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../slack.js";

function displayName(runner: RunnerHost): string {
  return runner.name ?? (runner.user ? `${runner.user}@${runner.host}` : runner.host);
}

function resolveIdentityFile(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return os.homedir() + filePath.slice(1);
  }
  return filePath;
}

export function sshExec(runner: RunnerHost, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes",
    ];

    if (runner.port && runner.port !== 22) {
      args.push("-p", String(runner.port));
    }
    if (runner.identityFile) {
      args.push("-i", resolveIdentityFile(runner.identityFile));
    }

    const target = runner.user ? `${runner.user}@${runner.host}` : runner.host;
    args.push(target, command);

    execFile("ssh", args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || (err as Error).message;
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function checkHost(runner: RunnerHost, actions: string[]): Promise<void> {
  const name = displayName(runner);

  // ── Service health check ──
  let serviceActive = false;
  try {
    const status = await sshExec(runner, `cd ${runner.actionsDir} && sudo ./svc.sh status`);
    serviceActive = status.includes("active (running)");
  } catch {
    serviceActive = false;
  }

  if (!serviceActive) {
    log.warn(`[runner-monitor] ${name}: service not active — restarting`);
    try {
      await sshExec(runner, `cd ${runner.actionsDir} && sudo ./svc.sh stop; sudo ./svc.sh start`);
      // Verify restart
      const verify = await sshExec(runner, `cd ${runner.actionsDir} && sudo ./svc.sh status`);
      if (verify.includes("active (running)")) {
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
  try {
    const psOutput = await sshExec(runner, `ps -eo pid,etimes,comm | grep -E 'Runner\\.(Worker|Listener)' || true`);
    const lines = psOutput.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
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
    const dfOutput = await sshExec(runner, `df --output=pcent / | tail -1`);
    const match = dfOutput.trim().match(/(\d+)%/);
    if (match) {
      const usage = parseInt(match[1], 10);
      if (usage > 90) {
        log.warn(`[runner-monitor] ${name}: disk usage ${usage}% — cleaning temp files`);
        await sshExec(runner, `sudo rm -rf /tmp/_github_* ${runner.actionsDir}/_work/_temp/*`);
        actions.push(`cleaned temp files on ${name} (disk was ${usage}%)`);
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
