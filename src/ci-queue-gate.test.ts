import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({ CI_QUEUE_HOLD_JOBS: 8 }));
vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    get CI_QUEUE_HOLD_JOBS() {
      return mockConfig.CI_QUEUE_HOLD_JOBS;
    },
  };
});

const mockForgejo = vi.hoisted(() => ({
  listWaitingRunJobs: vi.fn(),
  hasMacLabel: (labels: string[]) => labels.some((l) => l.toLowerCase() === "macos"),
}));
vi.mock("./forgejo.js", () => mockForgejo);

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));

import * as log from "./log.js";
import { ciQueueHold, ciQueueHoldNote, logCiQueueHold, __resetCiQueueGateForTests, CI_QUEUE_MIN_WAIT_MS, CI_QUEUE_MEMO_MS } from "./ci-queue-gate.js";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const REPO = "St-John-Software/bonkus";

function jobs(count: number, opts: { ageMs?: number; labels?: string[] } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `job ${i + 1}`,
    labels: opts.labels ?? ["container", "linux"],
    firstSeenAt: NOW - (opts.ageMs ?? CI_QUEUE_MIN_WAIT_MS),
    attempt: 1,
  }));
}

describe("ciQueueHold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mockConfig.CI_QUEUE_HOLD_JOBS = 8;
    __resetCiQueueGateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds once the threshold of jobs waiting five minutes is reached", async () => {
    mockForgejo.listWaitingRunJobs.mockResolvedValue(jobs(8));
    await expect(ciQueueHold(REPO)).resolves.toEqual({ waiting: 8, limit: 8 });
    expect(mockForgejo.listWaitingRunJobs).toHaveBeenCalledWith(REPO);
  });

  it("does not hold below the threshold", async () => {
    mockForgejo.listWaitingRunJobs.mockResolvedValue(jobs(7));
    await expect(ciQueueHold(REPO)).resolves.toBeNull();
  });

  it("does not count jobs that have waited under five minutes", async () => {
    mockForgejo.listWaitingRunJobs.mockResolvedValue([...jobs(7), ...jobs(5, { ageMs: CI_QUEUE_MIN_WAIT_MS - 1 })]);
    await expect(ciQueueHold(REPO)).resolves.toBeNull();
  });

  it("ignores jobs waiting for a Mac runner", async () => {
    mockForgejo.listWaitingRunJobs.mockResolvedValue([...jobs(7), ...jobs(4, { labels: ["host", "macOS", "xcode"] })]);
    await expect(ciQueueHold(REPO)).resolves.toBeNull();
  });

  it("never holds, and never reads, when the threshold is 0", async () => {
    mockConfig.CI_QUEUE_HOLD_JOBS = 0;
    mockForgejo.listWaitingRunJobs.mockResolvedValue(jobs(20));
    await expect(ciQueueHold(REPO)).resolves.toBeNull();
    expect(mockForgejo.listWaitingRunJobs).not.toHaveBeenCalled();
  });

  it("fails open with one warning when the queue cannot be read", async () => {
    mockForgejo.listWaitingRunJobs.mockRejectedValue(new Error("HTTP 500"));
    await expect(ciQueueHold(REPO)).resolves.toBeNull();
    await expect(ciQueueHold(REPO)).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("ci_queue_read_failed", expect.objectContaining({ repo: REPO }), expect.any(Error));
  });

  it("reads each repo at most once a minute", async () => {
    mockForgejo.listWaitingRunJobs.mockResolvedValue(jobs(8));
    await ciQueueHold(REPO);
    mockForgejo.listWaitingRunJobs.mockResolvedValue([]);
    await expect(ciQueueHold(REPO)).resolves.toEqual({ waiting: 8, limit: 8 });
    expect(mockForgejo.listWaitingRunJobs).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + CI_QUEUE_MEMO_MS);
    await expect(ciQueueHold(REPO)).resolves.toBeNull();
    expect(mockForgejo.listWaitingRunJobs).toHaveBeenCalledTimes(2);

    await ciQueueHold("St-John-Software/other");
    expect(mockForgejo.listWaitingRunJobs).toHaveBeenCalledTimes(3);
  });

  it("words the note and logs one info line with constant msg", () => {
    const hold = { waiting: 9, limit: 8 };
    expect(ciQueueHoldNote(REPO, hold)).toBe(`Waiting for the CI queue: 9 jobs waiting in ${REPO}`);
    logCiQueueHold(REPO, "ci-fixer", 42, hold);
    expect(log.info).toHaveBeenCalledWith("ci_queue_hold", expect.objectContaining({ repo: REPO, kind: "ci-fixer", item: "42", waiting: 9, limit: 8 }));
  });
});
