import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  getRunningTasks: vi.fn().mockReturnValue([]),
  markRepoProcessedDaily: vi.fn(),
  getLastProcessedTimestampsForJob: vi.fn().mockReturnValue(new Map<string, number>()),
  countActiveWorkExcludingKinds: vi.fn().mockReturnValue(0),
}));

const mockConfig = vi.hoisted(() => ({
  SMART_SCHEDULING: {
    enabled: true,
    quietHourStart: 19,
    quietHourEnd: 7,
    tickIntervalMs: 60 * 60 * 1000,
    jobs: { "idea-suggester": {}, "improvement-identifier": {} },
    targetStalenessMs: 24 * 60 * 60 * 1000,
    sloStalenessMs: 48 * 60 * 60 * 1000,
    maxConcurrentJobTasks: 4,
    ignoreBusyKinds: [
      "ci-fixer",
      "review-addresser",
      "pr-reviewer",
      "doc-maintainer",
      "improvement-identifier",
      "idea-suggester",
      "issue-auditor",
    ],
  },
}));

const mockSlack = vi.hoisted(() => ({ notify: vi.fn() }));

const mockGh = vi.hoisted(() => ({ isRateLimited: vi.fn().mockReturnValue(false) }));

const mockReportError = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("./db.js", () => mockDb);
vi.mock("./config.js", () => mockConfig);
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./slack.js", () => mockSlack);
vi.mock("./github.js", () => mockGh);
vi.mock("./error-reporter.js", () => mockReportError);

import {
  isClawsBusy,
  localDateString,
  shouldRunSmartJob,
  selectReposForTick,
  withSmartJobSlot,
  runDailyRepoLoop,
  withDailyRepoMarking,
  _resetSmartJobSlotForTests,
  _resetSlackThrottleForTests,
} from "./smart-schedule.js";
import { mockRepo } from "./test-helpers.js";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-05-20T12:00:00Z");
const NOW_MS = NOW.getTime();

describe("localDateString", () => {
  it("formats date as YYYY-MM-DD", () => {
    expect(localDateString(new Date("2024-03-07T15:30:00"))).toBe("2024-03-07");
  });

  it("zero-pads month and day", () => {
    expect(localDateString(new Date("2024-01-05T00:00:00"))).toBe("2024-01-05");
  });
});

describe("isClawsBusy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.countActiveWorkExcludingKinds.mockReturnValue(0);
    mockDb.getRunningTasks.mockReturnValue([]);
  });

  it("returns false when no work and no running tasks", () => {
    expect(isClawsBusy()).toBe(false);
  });

  it("returns true when there is active non-excluded work", () => {
    mockDb.countActiveWorkExcludingKinds.mockReturnValue(2);
    expect(isClawsBusy()).toBe(true);
  });

  it("returns true when running task is not in ignoreBusyKinds", () => {
    mockDb.getRunningTasks.mockReturnValue([{ job_name: "some-unknown-job" }]);
    expect(isClawsBusy()).toBe(true);
  });

  it("ignores running tasks whose job_name is in ignoreBusyKinds", () => {
    mockDb.getRunningTasks.mockReturnValue([{ job_name: "ci-fixer" }, { job_name: "pr-reviewer" }]);
    expect(isClawsBusy()).toBe(false);
  });

  it("does NOT count smart-schedule job tasks as busy", () => {
    mockDb.getRunningTasks.mockReturnValue([{ job_name: "doc-maintainer" }]);
    expect(isClawsBusy()).toBe(false);
  });
});

describe("shouldRunSmartJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.SMART_SCHEDULING.enabled = true;
  });

  it("returns true for jobs not in SMART_SCHEDULING.jobs regardless of conditions", () => {
    expect(shouldRunSmartJob("some-other-job", NOW)).toBe(true);
  });

  it("returns false for smart-scheduled jobs when feature is disabled", () => {
    mockConfig.SMART_SCHEDULING.enabled = false;
    expect(shouldRunSmartJob("idea-suggester", NOW)).toBe(false);
  });

  it("returns true during the daytime now that off-hours gating is gone", () => {
    expect(shouldRunSmartJob("idea-suggester", new Date("2024-01-01T12:00:00"))).toBe(true);
  });

  it("returns true when Claws is busy — gating is per-repo in selectReposForTick", () => {
    mockDb.countActiveWorkExcludingKinds.mockReturnValue(5);
    expect(shouldRunSmartJob("idea-suggester", NOW)).toBe(true);
  });

  it("returns true when manual=true", () => {
    expect(shouldRunSmartJob("idea-suggester", NOW, true)).toBe(true);
  });

  it("returns true when manual=true even when SMART_SCHEDULING.enabled is false", () => {
    mockConfig.SMART_SCHEDULING.enabled = false;
    expect(shouldRunSmartJob("idea-suggester", NOW, true)).toBe(true);
  });
});

describe("selectReposForTick", () => {
  const repos = [
    mockRepo({ owner: "org", name: "repo-a", fullName: "org/repo-a" }),
    mockRepo({ owner: "org", name: "repo-b", fullName: "org/repo-b" }),
    mockRepo({ owner: "org", name: "repo-c", fullName: "org/repo-c" }),
    mockRepo({ owner: "org", name: "repo-d", fullName: "org/repo-d" }),
    mockRepo({ owner: "org", name: "repo-e", fullName: "org/repo-e" }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSlackThrottleForTests();
    mockDb.countActiveWorkExcludingKinds.mockReturnValue(0);
    mockDb.getRunningTasks.mockReturnValue([]);
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(new Map<string, number>());
  });

  it("returns empty when all repos are fresh (within target staleness)", () => {
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(
      new Map(repos.map((r) => [r.fullName, NOW_MS - 1 * HOUR_MS])),
    );
    expect(selectReposForTick("idea-suggester", repos, NOW)).toEqual([]);
  });

  it("returns all due repos sorted stalest-first", () => {
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(
      new Map([
        ["org/repo-a", NOW_MS - 25 * HOUR_MS],
        ["org/repo-b", NOW_MS - 30 * HOUR_MS],
        ["org/repo-c", NOW_MS - 1 * HOUR_MS], // fresh, excluded
        ["org/repo-d", NOW_MS - 26 * HOUR_MS],
        ["org/repo-e", NOW_MS - 36 * HOUR_MS],
      ]),
    );
    const result = selectReposForTick("idea-suggester", repos, NOW);
    expect(result.map((r) => r.fullName)).toEqual([
      "org/repo-e",
      "org/repo-b",
      "org/repo-d",
      "org/repo-a",
    ]);
  });

  it("never-processed repos sort before processed ones", () => {
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(
      new Map([
        ["org/repo-a", NOW_MS - 25 * HOUR_MS],
        ["org/repo-b", NOW_MS - 30 * HOUR_MS],
        // c, d, e never processed
      ]),
    );
    const result = selectReposForTick("idea-suggester", repos, NOW);
    // never-processed (alphabetical tiebreak) first
    expect(result.slice(0, 3).map((r) => r.fullName)).toEqual([
      "org/repo-c",
      "org/repo-d",
      "org/repo-e",
    ]);
    // then processed in stalest-first order
    expect(result.slice(3).map((r) => r.fullName)).toEqual(["org/repo-b", "org/repo-a"]);
  });

  it("when busy and no SLO breach, returns []", () => {
    mockDb.countActiveWorkExcludingKinds.mockReturnValue(3);
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(
      new Map([
        ["org/repo-a", NOW_MS - 25 * HOUR_MS],
        ["org/repo-b", NOW_MS - 30 * HOUR_MS],
        ["org/repo-c", NOW_MS - 1 * HOUR_MS],
        ["org/repo-d", NOW_MS - 1 * HOUR_MS],
        ["org/repo-e", NOW_MS - 1 * HOUR_MS],
      ]),
    );
    expect(selectReposForTick("idea-suggester", repos, NOW)).toEqual([]);
    expect(mockSlack.notify).not.toHaveBeenCalled();
  });

  it("when busy and SLO breached, returns only SLO-breached repos and notifies Slack", () => {
    mockDb.countActiveWorkExcludingKinds.mockReturnValue(3);
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(
      new Map([
        ["org/repo-a", NOW_MS - 25 * HOUR_MS], // due but not SLO
        ["org/repo-b", NOW_MS - 49 * HOUR_MS], // SLO breached
        ["org/repo-c", NOW_MS - 60 * HOUR_MS], // SLO breached
        ["org/repo-d", NOW_MS - 1 * HOUR_MS], // fresh
        ["org/repo-e", NOW_MS - 1 * HOUR_MS], // fresh
      ]),
    );
    const result = selectReposForTick("idea-suggester", repos, NOW);
    expect(result.map((r) => r.fullName)).toEqual(["org/repo-c", "org/repo-b"]);
    expect(mockSlack.notify).toHaveBeenCalledTimes(1);
    expect(mockSlack.notify).toHaveBeenCalledWith(expect.stringContaining("idea-suggester"));
  });

  it("never-processed repos count as SLO-breached when busy", () => {
    mockDb.countActiveWorkExcludingKinds.mockReturnValue(3);
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(new Map());
    const result = selectReposForTick("idea-suggester", repos, NOW);
    expect(result).toHaveLength(repos.length);
  });

  it("Slack notify is throttled — second SLO breach within 6h does not re-notify", () => {
    mockDb.countActiveWorkExcludingKinds.mockReturnValue(3);
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(
      new Map([["org/repo-a", NOW_MS - 60 * HOUR_MS]]),
    );

    selectReposForTick("idea-suggester", repos, NOW);
    selectReposForTick("idea-suggester", repos, new Date(NOW_MS + 5 * HOUR_MS));
    expect(mockSlack.notify).toHaveBeenCalledTimes(1);
  });

  it("Slack notify fires again after 6h have passed", () => {
    mockDb.countActiveWorkExcludingKinds.mockReturnValue(3);
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(
      new Map([["org/repo-a", NOW_MS - 60 * HOUR_MS]]),
    );

    selectReposForTick("idea-suggester", repos, NOW);
    selectReposForTick("idea-suggester", repos, new Date(NOW_MS + 7 * HOUR_MS));
    expect(mockSlack.notify).toHaveBeenCalledTimes(2);
  });
});

describe("runDailyRepoLoop", () => {
  const repos = [
    mockRepo({ owner: "org", name: "repo-a", fullName: "org/repo-a" }),
    mockRepo({ owner: "org", name: "repo-b", fullName: "org/repo-b" }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.isRateLimited.mockReturnValue(false);
  });

  it("processes every repo when not rate-limited", async () => {
    const processRepo = vi.fn().mockResolvedValue(undefined);

    await runDailyRepoLoop("some-job", repos, processRepo);

    expect(processRepo).toHaveBeenCalledTimes(2);
    expect(processRepo).toHaveBeenCalledWith(repos[0]);
    expect(processRepo).toHaveBeenCalledWith(repos[1]);
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledTimes(2);
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("some-job", "org/repo-a", expect.any(String));
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("some-job", "org/repo-b", expect.any(String));
  });

  it("breaks early when rate limited", async () => {
    mockGh.isRateLimited.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const processRepo = vi.fn().mockResolvedValue(undefined);

    await runDailyRepoLoop("some-job", repos, processRepo);

    expect(processRepo).toHaveBeenCalledTimes(1);
    expect(processRepo).toHaveBeenCalledWith(repos[0]);
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledTimes(1);
  });

  it("catches a throwing processRepo, reports the error, and still marks the repo processed", async () => {
    const err = new Error("boom");
    const processRepo = vi.fn().mockRejectedValue(err);

    await runDailyRepoLoop("some-job", [repos[0]], processRepo);

    expect(mockReportError.reportError).toHaveBeenCalledWith("some-job:process-repo", "org/repo-a", err);
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("some-job", "org/repo-a", expect.any(String));
  });
});

describe("withDailyRepoMarking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves fn's value and marks the repo processed once", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withDailyRepoMarking("some-job", "org/repo-a", fn);

    expect(result).toBe("ok");
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledTimes(1);
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("some-job", "org/repo-a", expect.any(String));
  });

  it("on throw with onError, returns onError's value and still marks the repo", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);
    const onError = vi.fn().mockReturnValue("fallback");

    const result = await withDailyRepoMarking("some-job", "org/repo-a", fn, onError);

    expect(result).toBe("fallback");
    expect(onError).toHaveBeenCalledWith(err);
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("some-job", "org/repo-a", expect.any(String));
  });

  it("on throw without onError, rejects with the original error and still marks the repo", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withDailyRepoMarking("some-job", "org/repo-a", fn)).rejects.toThrow("boom");
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("some-job", "org/repo-a", expect.any(String));
  });
});

describe("withSmartJobSlot", () => {
  beforeEach(() => {
    _resetSmartJobSlotForTests();
    mockConfig.SMART_SCHEDULING.maxConcurrentJobTasks = 4;
  });

  it("runs up to N tasks concurrently", async () => {
    let activeNow = 0;
    let maxObserved = 0;
    const release: Array<() => void> = [];

    const tasks = Array.from({ length: 4 }, () =>
      withSmartJobSlot(async () => {
        activeNow++;
        maxObserved = Math.max(maxObserved, activeNow);
        await new Promise<void>((res) => release.push(res));
        activeNow--;
      }),
    );

    // Give microtasks a chance to schedule
    await new Promise((res) => setTimeout(res, 0));
    expect(maxObserved).toBe(4);

    // Release all
    release.forEach((r) => r());
    await Promise.all(tasks);
  });

  it("queues the 5th task and lets it through when a slot frees", async () => {
    const release: Array<() => void> = [];
    const started: number[] = [];

    const t1to4 = Array.from({ length: 4 }, (_, i) =>
      withSmartJobSlot(async () => {
        started.push(i);
        await new Promise<void>((res) => release.push(res));
      }),
    );
    const t5 = withSmartJobSlot(async () => {
      started.push(4);
    });

    await new Promise((res) => setTimeout(res, 0));
    expect(started).toEqual([0, 1, 2, 3]);

    // Release one slot — the 5th should now run
    release[0]();
    await Promise.all([t1to4[0], t5]);
    expect(started).toContain(4);

    // Drain the rest
    for (let i = 1; i < release.length; i++) release[i]();
    await Promise.all(t1to4);
  });

  it("re-reads maxConcurrentJobTasks each call (supports live config reload)", async () => {
    mockConfig.SMART_SCHEDULING.maxConcurrentJobTasks = 1;

    const release: Array<() => void> = [];
    const started: number[] = [];

    const t1 = withSmartJobSlot(async () => {
      started.push(0);
      await new Promise<void>((res) => release.push(res));
    });
    const t2 = withSmartJobSlot(async () => {
      started.push(1);
    });

    await new Promise((res) => setTimeout(res, 0));
    expect(started).toEqual([0]);

    release[0]();
    await Promise.all([t1, t2]);
    expect(started).toEqual([0, 1]);
  });
});
