import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  MAX_WORK_WORKERS: 2,
  shouldRunWorkPipeline: () => true,
}));

vi.mock("./log.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    runContext: new AsyncLocalStorage(),
    withRunContext: async (_runId: string, fn: () => Promise<unknown>) => fn(),
  };
});

const shutdownState = vi.hoisted(() => ({ shuttingDown: false }));
vi.mock("./shutdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shutdown.js")>();
  return { ...actual, isShuttingDown: () => shutdownState.shuttingDown };
});

vi.mock("./error-reporter.js", () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./timeout-handler.js", () => ({
  handleTimeoutIfApplicable: vi.fn().mockResolvedValue(undefined),
  handleMemoryLimitIfApplicable: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./github.js", () => ({
  RateLimitError: class RateLimitError extends Error {},
}));

import {
  initDb,
  closeDb,
  clearAllWorkQueueForTests,
  listQueuedWork,
  countWorkByStatus,
  claimNextWork,
  markWorkSucceeded,
} from "./db.js";
import { ShutdownError } from "./shutdown.js";
import { enqueue, _resetForTests, AGENT_KINDS, workerStatus, registerHandler, runRow, start, inFlightWork } from "./worker.js";
import { requestDeployDrain, clearDeployDrain, inFlightCount } from "./deploy-drain.js";

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("worker", () => {
  beforeEach(async () => {
    await initDb();
    _resetForTests();
    shutdownState.shuttingDown = false;
    clearDeployDrain();
  });

  afterEach(async () => {
    await clearAllWorkQueueForTests();
    await closeDb();
  });

  it("enqueue inserts a queued row", async () => {
    const r = await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 42);
    expect(r).not.toBeNull();
    expect(r!.alreadyQueued).toBe(false);
    expect(await listQueuedWork()).toHaveLength(1);
  });

  it("enqueue dedupes — same (kind, repo, item) only inserts once", async () => {
    const r1 = await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 7);
    const r2 = await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 7);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r2!.alreadyQueued).toBe(true);
    expect(await listQueuedWork()).toHaveLength(1);
  });

  it("workerStatus reflects queued and running counts", async () => {
    await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 1);
    await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 2);
    expect(await workerStatus()).toMatchObject({ queued: 2, running: 0 });

    await claimNextWork(null);
    expect(await workerStatus()).toMatchObject({ queued: 1, running: 1 });

    const row = await claimNextWork(null);
    await markWorkSucceeded(row!.id);
    const counts = await countWorkByStatus();
    expect(counts.completed).toBe(1);
    expect(counts.running).toBe(1);
  });

  it("cancellation without shutdown marks the row cancelled and frees redispatch", async () => {
    registerHandler(AGENT_KINDS.ISSUE_REFINER_PLAN, async () => {
      throw new ShutdownError("Task cancelled — shutting down");
    });
    await enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, "St-John-Software/claws", 2683);
    const row = (await claimNextWork(null))!;
    await runRow(0, row);

    const counts = await countWorkByStatus();
    expect(counts.cancelled).toBe(1);
    expect(counts.running ?? 0).toBe(0);

    // The item is dispatchable again — no stuck 'running' row blocking the unique index.
    const again = await enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, "St-John-Software/claws", 2683);
    expect(again!.alreadyQueued).toBe(false);
  });

  it("real shutdown leaves the row running for startup recovery", async () => {
    registerHandler(AGENT_KINDS.ISSUE_REFINER_PLAN, async () => {
      throw new ShutdownError("Task cancelled — shutting down");
    });
    await enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, "St-John-Software/claws", 2684);
    const row = (await claimNextWork(null))!;

    shutdownState.shuttingDown = true;
    await runRow(0, row);

    const counts = await countWorkByStatus();
    expect(counts.running).toBe(1);
    expect(counts.cancelled).toBeUndefined();
  });

  it("does not claim while a deploy drain is active, and tracks the running row once cleared", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started: number[] = [];
    registerHandler(AGENT_KINDS.PR_REVIEWER, async (row) => {
      started.push(row.item_number);
      await gate;
    });

    requestDeployDrain("v2026-09-14.9", Date.now());
    start(1);
    await enqueue(AGENT_KINDS.PR_REVIEWER, "St-John-Software/claws", 3052);
    await new Promise((r) => setTimeout(r, 50));

    expect(started).toEqual([]);
    expect((await countWorkByStatus()).queued).toBe(1);
    expect(inFlightWork().count).toBe(0);

    clearDeployDrain();
    // A new enqueue wakes the idle fiber.
    await enqueue(AGENT_KINDS.PR_REVIEWER, "St-John-Software/claws", 3053);
    await waitFor(() => started.length === 1);

    const inFlight = inFlightWork();
    expect(inFlight.count).toBe(1);
    expect(inFlightCount()).toBe(1);
    expect(inFlight.rows).toHaveLength(1);
    expect(inFlight.rows[0]).toMatchObject({ kind: AGENT_KINDS.PR_REVIEWER, repo: "St-John-Software/claws" });

    // Stop the fiber after this row so it does not outlive the test.
    shutdownState.shuttingDown = true;
    release();
    await waitFor(() => inFlightWork().count === 0);
    expect((await countWorkByStatus()).completed).toBe(1);
  });
});
