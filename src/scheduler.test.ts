import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withRunContext: vi.fn().mockImplementation((_runId: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("./error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("./db.js", () => ({
  insertJobRun: vi.fn(),
  completeJobRun: vi.fn(),
}));

import { startJobs, msUntilHour, type Job } from "./scheduler.js";
import { reportError } from "./error-reporter.js";
import { insertJobRun, completeJobRun } from "./db.js";

describe("msUntilHour", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns ms until the given hour today if it's in the future", () => {
    vi.setSystemTime(new Date("2025-01-01T10:00:00"));
    const ms = msUntilHour(12);
    expect(ms).toBe(2 * 60 * 60 * 1000);
  });

  it("returns ms until the given hour tomorrow if it's in the past", () => {
    vi.setSystemTime(new Date("2025-01-01T14:00:00"));
    const ms = msUntilHour(12);
    expect(ms).toBe(22 * 60 * 60 * 1000);
  });
});

describe("scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeJob(name: string, fn: () => Promise<void>, intervalMs = 1000): Job {
    return { name, intervalMs, run: fn };
  }

  it("runs jobs immediately on startup", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("test-job", runFn)]);

    // tick() is called synchronously but is async — flush microtasks
    await vi.advanceTimersByTimeAsync(0);

    expect(runFn).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("runs jobs at their interval", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("test-job", runFn, 5000)]);

    await vi.advanceTimersByTimeAsync(0); // initial tick
    expect(runFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(runFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(runFn).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("skips overlapping ticks when a job is still running", async () => {
    let resolveJob: () => void;
    const longRunning = () =>
      new Promise<void>((resolve) => {
        resolveJob = resolve;
      });
    const runFn = vi.fn().mockImplementation(longRunning);

    const scheduler = startJobs([makeJob("slow-job", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // start first run
    expect(runFn).toHaveBeenCalledTimes(1);

    // Advance past 2 intervals while job is still running
    await vi.advanceTimersByTimeAsync(2500);
    expect(runFn).toHaveBeenCalledTimes(1); // still only 1 — overlapping ticks skipped

    // Complete the job
    resolveJob!();
    await vi.advanceTimersByTimeAsync(0);

    // Next interval should now run
    await vi.advanceTimersByTimeAsync(1000);
    expect(runFn).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("jobStates() reflects running/idle correctly", async () => {
    let resolveJob: () => void;
    const longRunning = () =>
      new Promise<void>((resolve) => {
        resolveJob = resolve;
      });

    const scheduler = startJobs([makeJob("check-job", longRunning)]);

    await vi.advanceTimersByTimeAsync(0);
    const statesRunning = scheduler.jobStates();
    expect(statesRunning.get("check-job")).toBe(true);

    resolveJob!();
    await vi.advanceTimersByTimeAsync(0);

    const statesIdle = scheduler.jobStates();
    expect(statesIdle.get("check-job")).toBe(false);

    scheduler.stop();
  });

  it("stop() clears intervals — no more ticks fire", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("stop-job", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // initial tick
    expect(runFn).toHaveBeenCalledTimes(1);

    scheduler.stop();

    await vi.advanceTimersByTimeAsync(10000);
    expect(runFn).toHaveBeenCalledTimes(1); // no more calls
  });

  it("a failing job does not crash the scheduler", async () => {
    const runFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);

    const scheduler = startJobs([makeJob("fail-job", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // first tick — throws
    expect(reportError).toHaveBeenCalledWith("scheduler:fail-job", "fail-job", expect.any(Error));

    await vi.advanceTimersByTimeAsync(1000); // second tick — succeeds
    expect(runFn).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("drain() waits for running jobs to complete", async () => {
    let resolveJob: () => void;
    const longRunning = () =>
      new Promise<void>((resolve) => {
        resolveJob = resolve;
      });

    const scheduler = startJobs([makeJob("drain-job", longRunning, 1000)]);
    await vi.advanceTimersByTimeAsync(0); // start the job

    let drained = false;
    const drainPromise = scheduler.drain().then(() => {
      drained = true;
    });

    // drain is polling every 500ms — advance but job not done yet
    await vi.advanceTimersByTimeAsync(500);
    expect(drained).toBe(false);

    // Complete the job
    resolveJob!();
    await vi.advanceTimersByTimeAsync(0); // let job finish

    await vi.advanceTimersByTimeAsync(500); // let drain poll detect completion
    await drainPromise;
    expect(drained).toBe(true);
  });

  it("scheduledHour jobs with runOnStart run immediately and at scheduled time", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);

    // Set time to 10:00 so scheduledHour=12 is 2 hours away
    vi.setSystemTime(new Date("2025-01-01T10:00:00"));

    const scheduler = startJobs([
      { name: "startup-sched", intervalMs: 0, scheduledHour: 12, runOnStart: true, run: runFn },
    ]);

    // Should run immediately on startup
    await vi.advanceTimersByTimeAsync(0);
    expect(runFn).toHaveBeenCalledTimes(1);

    // Should not run again until the scheduled hour
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1 hour
    expect(runFn).toHaveBeenCalledTimes(1);

    // Should run at the scheduled hour (2 hours from start)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // another hour = 12:00
    expect(runFn).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("scheduledHour jobs without runOnStart do not run on startup", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);

    vi.setSystemTime(new Date("2025-01-01T10:00:00"));

    const scheduler = startJobs([
      { name: "no-startup-sched", intervalMs: 0, scheduledHour: 12, run: runFn },
    ]);

    await vi.advanceTimersByTimeAsync(0);
    expect(runFn).toHaveBeenCalledTimes(0);

    // Should only run at the scheduled hour
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // 2 hours to 12:00
    expect(runFn).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("draining prevents new ticks from starting", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("drain-block-job", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // initial tick
    expect(runFn).toHaveBeenCalledTimes(1);

    const drainPromise = scheduler.drain();
    await vi.advanceTimersByTimeAsync(500); // let drain poll
    await drainPromise;

    // Even though time advances, no new ticks should fire (draining=true + stopped)
    await vi.advanceTimersByTimeAsync(5000);
    expect(runFn).toHaveBeenCalledTimes(1);
  });

  it("creates a job_runs record when a job runs", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("tracked-job", runFn)]);

    await vi.advanceTimersByTimeAsync(0);

    expect(insertJobRun).toHaveBeenCalledWith(expect.any(String), "tracked-job");
    scheduler.stop();
  });

  it("marks run as completed on success", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("success-job", runFn)]);

    await vi.advanceTimersByTimeAsync(0);

    expect(completeJobRun).toHaveBeenCalledWith(expect.any(String), "completed");
    scheduler.stop();
  });

  it("marks run as failed on error", async () => {
    const runFn = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const scheduler = startJobs([makeJob("fail-tracked-job", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0);

    expect(completeJobRun).toHaveBeenCalledWith(expect.any(String), "failed");
    scheduler.stop();
  });

  it("updateInterval clears old timer and sets new one", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("update-interval-job", runFn, 5000)]);

    await vi.advanceTimersByTimeAsync(0); // initial tick
    expect(runFn).toHaveBeenCalledTimes(1);

    // Update interval to 2000ms
    scheduler.updateInterval("update-interval-job", 2000);

    // Old 5000ms interval should no longer fire
    await vi.advanceTimersByTimeAsync(2000);
    expect(runFn).toHaveBeenCalledTimes(2); // fires at new 2000ms interval

    await vi.advanceTimersByTimeAsync(2000);
    expect(runFn).toHaveBeenCalledTimes(3);

    // Would have been 3 at 5000ms but we already have 3 at 4000ms
    scheduler.stop();
  });

  it("updateScheduledHour clears old timer and schedules at new hour", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);

    vi.setSystemTime(new Date("2025-01-01T10:00:00"));

    const scheduler = startJobs([
      { name: "update-sched-job", intervalMs: 0, scheduledHour: 12, run: runFn },
    ]);

    await vi.advanceTimersByTimeAsync(0);
    expect(runFn).toHaveBeenCalledTimes(0);

    // Reschedule to hour 11 (1 hour from now)
    scheduler.updateScheduledHour("update-sched-job", 11);

    // Original 12:00 should not fire
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // advance 1 hour to 11:00
    expect(runFn).toHaveBeenCalledTimes(1); // fires at new time

    scheduler.stop();
  });

  it("updateInterval on unknown job is a no-op", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("known-job", runFn)]);

    await vi.advanceTimersByTimeAsync(0);

    // Should not throw
    scheduler.updateInterval("nonexistent-job", 1000);

    scheduler.stop();
  });

  it("staggers startup of interval-based jobs", async () => {
    const run1 = vi.fn().mockResolvedValue(undefined);
    const run2 = vi.fn().mockResolvedValue(undefined);
    const run3 = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([
      makeJob("job-1", run1, 60000),
      makeJob("job-2", run2, 60000),
      makeJob("job-3", run3, 60000),
    ]);

    // At t=0, only the first job should have fired
    await vi.advanceTimersByTimeAsync(0);
    expect(run1).toHaveBeenCalledTimes(1);
    expect(run2).toHaveBeenCalledTimes(0);
    expect(run3).toHaveBeenCalledTimes(0);

    // At t=2000, the second job fires
    await vi.advanceTimersByTimeAsync(2000);
    expect(run2).toHaveBeenCalledTimes(1);
    expect(run3).toHaveBeenCalledTimes(0);

    // At t=4000, the third job fires
    await vi.advanceTimersByTimeAsync(2000);
    expect(run3).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("updateScheduledHour on unknown job is a no-op", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("known-job", runFn)]);

    await vi.advanceTimersByTimeAsync(0);

    // Should not throw
    scheduler.updateScheduledHour("nonexistent-job", 5);

    scheduler.stop();
  });

  it("pauseJob prevents scheduled ticks from running", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("pause-test", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // initial tick
    expect(runFn).toHaveBeenCalledTimes(1);

    scheduler.pauseJob("pause-test");

    await vi.advanceTimersByTimeAsync(3000);
    expect(runFn).toHaveBeenCalledTimes(1); // no more ticks while paused

    scheduler.stop();
  });

  it("resumeJob re-enables scheduled ticks", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("resume-test", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // initial tick
    expect(runFn).toHaveBeenCalledTimes(1);

    scheduler.pauseJob("resume-test");
    await vi.advanceTimersByTimeAsync(3000);
    expect(runFn).toHaveBeenCalledTimes(1);

    scheduler.resumeJob("resume-test");
    await vi.advanceTimersByTimeAsync(1000);
    expect(runFn).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("pauseJob returns false for unknown job names", () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("known-job", runFn)]);

    expect(scheduler.pauseJob("nonexistent")).toBe(false);
    expect(scheduler.pauseJob("known-job")).toBe(true);

    scheduler.stop();
  });

  it("resumeJob returns false for unknown job names", () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("known-job", runFn)]);

    expect(scheduler.resumeJob("nonexistent")).toBe(false);
    expect(scheduler.resumeJob("known-job")).toBe(true);

    scheduler.stop();
  });

  it("manual triggerJob works on a paused job", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("paused-trigger", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // initial tick
    expect(runFn).toHaveBeenCalledTimes(1);

    scheduler.pauseJob("paused-trigger");

    // Scheduled ticks should not run
    await vi.advanceTimersByTimeAsync(2000);
    expect(runFn).toHaveBeenCalledTimes(1);

    // Manual trigger should bypass pause
    const result = scheduler.triggerJob("paused-trigger");
    expect(result).toBe("started");
    await vi.advanceTimersByTimeAsync(0);
    expect(runFn).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("pausedJobs returns correct set", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([
      makeJob("job-a", runFn, 60000),
      makeJob("job-b", runFn, 60000),
      makeJob("job-c", runFn, 60000),
    ]);

    expect(scheduler.pausedJobs().size).toBe(0);

    scheduler.pauseJob("job-a");
    scheduler.pauseJob("job-c");
    expect(scheduler.pausedJobs()).toEqual(new Set(["job-a", "job-c"]));

    scheduler.resumeJob("job-a");
    expect(scheduler.pausedJobs()).toEqual(new Set(["job-c"]));

    scheduler.stop();
  });

  it("jobScheduleInfo returns correct config for interval jobs", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("info-job", runFn, 5000)]);

    const info = scheduler.jobScheduleInfo();
    expect(info.get("info-job")).toEqual({ intervalMs: 5000, scheduledHour: undefined });

    scheduler.stop();
  });

  it("jobScheduleInfo returns correct config for scheduled-hour jobs", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    vi.setSystemTime(new Date("2025-01-01T10:00:00"));

    const scheduler = startJobs([
      { name: "sched-info-job", intervalMs: 0, scheduledHour: 3, run: runFn },
    ]);

    const info = scheduler.jobScheduleInfo();
    expect(info.get("sched-info-job")).toEqual({ intervalMs: 0, scheduledHour: 3 });

    scheduler.stop();
  });

  it("updateInterval updates jobScheduleInfo", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("update-info-job", runFn, 5000)]);

    await vi.advanceTimersByTimeAsync(0);
    scheduler.updateInterval("update-info-job", 2000);

    const info = scheduler.jobScheduleInfo();
    expect(info.get("update-info-job")?.intervalMs).toBe(2000);

    scheduler.stop();
  });

  it("updateScheduledHour updates jobScheduleInfo", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    vi.setSystemTime(new Date("2025-01-01T10:00:00"));

    const scheduler = startJobs([
      { name: "update-sched-info", intervalMs: 0, scheduledHour: 12, run: runFn },
    ]);

    scheduler.updateScheduledHour("update-sched-info", 5);

    const info = scheduler.jobScheduleInfo();
    expect(info.get("update-sched-info")?.scheduledHour).toBe(5);

    scheduler.stop();
  });

  it("pausing a currently running job does not interrupt it", async () => {
    let resolveJob: () => void;
    const longRunning = () =>
      new Promise<void>((resolve) => {
        resolveJob = resolve;
      });
    const runFn = vi.fn().mockImplementation(longRunning);

    const scheduler = startJobs([makeJob("running-pause", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // start the job
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(scheduler.jobStates().get("running-pause")).toBe(true);

    // Pause while job is running
    scheduler.pauseJob("running-pause");

    // Job should still be running
    expect(scheduler.jobStates().get("running-pause")).toBe(true);

    // Complete the job
    resolveJob!();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.jobStates().get("running-pause")).toBe(false);

    // Future ticks should be skipped
    await vi.advanceTimersByTimeAsync(3000);
    expect(runFn).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
});
