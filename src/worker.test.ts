import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  MAX_WORK_WORKERS: 2,
}));

vi.mock("./log.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    runContext: new AsyncLocalStorage(),
  };
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
import { enqueue, _resetForTests, AGENT_KINDS, workerStatus } from "./worker.js";

describe("worker", () => {
  beforeEach(() => {
    initDb();
    _resetForTests();
  });

  afterEach(() => {
    clearAllWorkQueueForTests();
    closeDb();
  });

  it("enqueue inserts a queued row", () => {
    const r = enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 42);
    expect(r).not.toBeNull();
    expect(r!.alreadyQueued).toBe(false);
    expect(listQueuedWork()).toHaveLength(1);
  });

  it("enqueue dedupes — same (kind, repo, item) only inserts once", () => {
    const r1 = enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 7);
    const r2 = enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 7);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r2!.alreadyQueued).toBe(true);
    expect(listQueuedWork()).toHaveLength(1);
  });

  it("workerStatus reflects queued and running counts", () => {
    enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 1);
    enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 2);
    expect(workerStatus()).toMatchObject({ queued: 2, running: 0 });

    claimNextWork(null);
    expect(workerStatus()).toMatchObject({ queued: 1, running: 1 });

    const row = claimNextWork(null);
    markWorkSucceeded(row!.id);
    const counts = countWorkByStatus();
    expect(counts.completed).toBe(1);
    expect(counts.running).toBe(1);
  });
});
