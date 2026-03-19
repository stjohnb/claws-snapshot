import crypto from "node:crypto";
import * as log from "./log.js";
import { withRunContext } from "./log.js";
import { reportError } from "./error-reporter.js";
import { insertJobRun, completeJobRun } from "./db.js";

export interface Job {
  name: string;
  intervalMs: number;
  scheduledHour?: number; // 0-23, run at this hour daily instead of on interval
  runOnStart?: boolean; // also run immediately on startup (useful with scheduledHour)
  run: () => Promise<void>;
}

export interface Scheduler {
  stop(): void;
  drain(timeoutMs?: number): Promise<void>;
  jobStates(): Map<string, boolean>;
  triggerJob(name: string): "started" | "already-running" | "unknown";
  updateInterval(jobName: string, newIntervalMs: number): void;
  updateScheduledHour(jobName: string, newHour: number): void;
  pauseJob(name: string): boolean;
  resumeJob(name: string): boolean;
  pausedJobs(): Set<string>;
  jobScheduleInfo(): Map<string, { intervalMs: number; scheduledHour?: number }>;
}

export function msUntilHour(hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

export function startJobs(jobs: Job[], initialPaused?: readonly string[]): Scheduler {
  const jobTimers = new Map<string, NodeJS.Timeout[]>();
  const runningFlags = new Map<string, boolean>();
  const pausedFlags = new Map<string, boolean>();
  const initialPausedSet = new Set(initialPaused);
  const scheduleConfigs = new Map<string, { intervalMs: number; scheduledHour?: number }>();
  const ticks = new Map<string, (manual?: boolean) => Promise<void>>();
  let draining = false;
  let intervalIndex = 0;

  for (const job of jobs) {
    runningFlags.set(job.name, false);
    pausedFlags.set(job.name, initialPausedSet.has(job.name));
    scheduleConfigs.set(job.name, { intervalMs: job.intervalMs, scheduledHour: job.scheduledHour });
    jobTimers.set(job.name, []);

    const tick = async (manual?: boolean) => {
      if (draining) return;

      if (!manual && pausedFlags.get(job.name)) return;

      if (runningFlags.get(job.name)) {
        log.info(`Skipping ${job.name} — previous run still in progress`);
        return;
      }

      const runId = crypto.randomUUID();
      runningFlags.set(job.name, true);

      try {
        insertJobRun(runId, job.name);
      } catch {
        // Don't block the job if run tracking fails
      }

      await withRunContext(runId, async () => {
        log.info(`Starting job: ${job.name}`);
        try {
          await job.run();
          log.info(`Finished job: ${job.name}`);
          try { completeJobRun(runId, "completed"); } catch { /* best effort */ }
        } catch (err) {
          try { completeJobRun(runId, "failed"); } catch { /* best effort */ }
          reportError(`scheduler:${job.name}`, job.name, err);
        } finally {
          runningFlags.set(job.name, false);
        }
      });
    };

    ticks.set(job.name, tick);

    const timers = jobTimers.get(job.name)!;
    if (job.scheduledHour !== undefined) {
      const delay = msUntilHour(job.scheduledHour);
      log.info(`Scheduling ${job.name} for ${job.scheduledHour}:00 (in ${Math.round(delay / 60000)} min)`);
      if (job.runOnStart) tick();
      timers.push(setTimeout(() => {
        tick();
        timers.push(setInterval(tick, 24 * 60 * 60 * 1000));
      }, delay));
    } else {
      // Stagger startup: each interval job waits (index * 2s) before first tick
      const startDelay = intervalIndex * 2000;
      intervalIndex++;
      if (startDelay === 0) {
        tick();
        timers.push(setInterval(tick, job.intervalMs));
      } else {
        timers.push(setTimeout(() => {
          tick();
          timers.push(setInterval(tick, job.intervalMs));
        }, startDelay));
      }
    }
  }

  function clearJobTimers(jobName: string): void {
    const timers = jobTimers.get(jobName);
    if (timers) {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    }
  }

  function stop() {
    for (const [, timers] of jobTimers) {
      for (const t of timers) clearTimeout(t);
    }
  }

  async function drain(timeoutMs?: number): Promise<void> {
    draining = true;
    stop();
    log.info("Draining — waiting for running jobs to finish...");

    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        const anyRunning = [...runningFlags.values()].some(Boolean);
        if (!anyRunning) {
          clearInterval(poll);
          resolve();
        }
      }, 500);

      if (timeoutMs !== undefined) {
        setTimeout(() => {
          const stillRunning = [...runningFlags.entries()]
            .filter(([, running]) => running)
            .map(([name]) => name);
          if (stillRunning.length > 0) {
            log.warn(
              `Drain timeout — exiting with ${stillRunning.length} job(s) still running: ${stillRunning.join(", ")}`,
            );
            clearInterval(poll);
            resolve();
          }
        }, timeoutMs);
      }
    });

    log.info("All jobs drained");
  }

  function jobStates(): Map<string, boolean> {
    return new Map(runningFlags);
  }

  function triggerJob(name: string): "started" | "already-running" | "unknown" {
    const tick = ticks.get(name);
    if (!tick) return "unknown";
    if (draining) return "already-running";
    if (runningFlags.get(name)) return "already-running";
    tick(true);
    return "started";
  }

  function updateInterval(jobName: string, newIntervalMs: number): void {
    const tick = ticks.get(jobName);
    if (!tick) return; // unknown job — no-op

    clearJobTimers(jobName);
    const timers = jobTimers.get(jobName)!;
    timers.push(setInterval(tick, newIntervalMs));
    const existing = scheduleConfigs.get(jobName);
    scheduleConfigs.set(jobName, { ...existing, intervalMs: newIntervalMs });
    log.info(`Updated interval for ${jobName} to ${newIntervalMs}ms`);
  }

  function updateScheduledHour(jobName: string, newHour: number): void {
    const tick = ticks.get(jobName);
    if (!tick) return; // unknown job — no-op

    clearJobTimers(jobName);
    const timers = jobTimers.get(jobName)!;
    const delay = msUntilHour(newHour);
    timers.push(setTimeout(() => {
      tick();
      timers.push(setInterval(tick, 24 * 60 * 60 * 1000));
    }, delay));
    const existing = scheduleConfigs.get(jobName);
    scheduleConfigs.set(jobName, { ...existing, intervalMs: existing?.intervalMs ?? 0, scheduledHour: newHour });
    log.info(`Updated scheduled hour for ${jobName} to ${newHour}:00 (in ${Math.round(delay / 60000)} min)`);
  }

  function pauseJob(name: string): boolean {
    if (!ticks.has(name)) return false;
    pausedFlags.set(name, true);
    log.info(`Paused job: ${name}`);
    return true;
  }

  function resumeJob(name: string): boolean {
    if (!ticks.has(name)) return false;
    pausedFlags.set(name, false);
    log.info(`Resumed job: ${name}`);
    return true;
  }

  function pausedJobs(): Set<string> {
    const result = new Set<string>();
    for (const [name, paused] of pausedFlags) {
      if (paused) result.add(name);
    }
    return result;
  }

  function jobScheduleInfo(): Map<string, { intervalMs: number; scheduledHour?: number }> {
    return new Map(scheduleConfigs);
  }

  return { stop, drain, jobStates, triggerJob, updateInterval, updateScheduledHour, pauseJob, resumeJob, pausedJobs, jobScheduleInfo };
}
