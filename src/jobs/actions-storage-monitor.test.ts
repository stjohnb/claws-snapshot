import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: { priority: "Priority" },
  SELF_REPO: "St-John-Software/claws",
  isJobDisabledForRepo: vi.fn().mockReturnValue(false),
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockGh, mockOccurrence } = vi.hoisted(() => ({
  mockGh: {
    listRepos: vi.fn(),
    fetchRepoStorageUsage: vi.fn(),
  },
  mockOccurrence: {
    ensureAlertIssue: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../occurrence-tracking.js", () => mockOccurrence);

import {
  run,
  formatBytes,
  perRepoAlertReasons,
  PER_REPO_ISSUE_TITLE,
  ORG_ISSUE_TITLE,
} from "./actions-storage-monitor.js";

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function usage(repo: string, cacheBytes: number, artifactBytes: number, oldestArtifactAt = "2026-06-24T00:00:00Z") {
  return {
    repo,
    cacheBytes,
    cacheCount: 1,
    artifactBytes,
    artifactCount: 3,
    oldestArtifactAt,
  };
}

describe("actions-storage-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T00:00:00Z"));
    mockOccurrence.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("files no issues when cache is low and artifacts are fresh", async () => {
    mockGh.listRepos.mockResolvedValue([mockRepo({ fullName: "org/a" })]);
    // Default oldestArtifactAt is 2026-06-24 — 1 day before frozen now, well under 7-day threshold.
    mockGh.fetchRepoStorageUsage.mockResolvedValue(usage("org/a", 10 * MB, 5 * MB));

    await run();

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
  });

  it("files no issue for large but short-retention artifacts (policy: big artifacts are fine if they age out fast and there is no cache)", async () => {
    // This is the #1738 policy change: 500 MB of artifacts is fine as long as retention is low.
    mockGh.listRepos.mockResolvedValue([mockRepo({ fullName: "org/a" })]);
    mockGh.fetchRepoStorageUsage.mockResolvedValue(usage("org/a", 0, 500 * MB, "2026-06-24T00:00:00Z"));

    await run();

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
  });

  it("files a per-repo issue when a repo uses significant Actions cache", async () => {
    mockGh.listRepos.mockResolvedValue([mockRepo({ fullName: "org/c" })]);
    mockGh.fetchRepoStorageUsage.mockResolvedValue(usage("org/c", 80 * MB, 0));

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const call = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(call.repo).toBe("org/c");
    expect(call.title).toBe(PER_REPO_ISSUE_TITLE);
    expect(call.body).toContain("cache");
  });

  it("files a per-repo issue when artifacts have high retention", async () => {
    mockGh.listRepos.mockResolvedValue([mockRepo({ fullName: "org/r" })]);
    // Oldest artifact is 24 days old (2026-06-01 → 2026-06-25), well over 7-day threshold.
    mockGh.fetchRepoStorageUsage.mockResolvedValue(usage("org/r", 0, 20 * MB, "2026-06-01T00:00:00Z"));

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const call = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(call.repo).toBe("org/r");
    expect(call.title).toBe(PER_REPO_ISSUE_TITLE);
    expect(call.body).toContain("days old");
  });

  it("also files the org roll-up issue when total exceeds the org threshold", async () => {
    mockGh.listRepos.mockResolvedValue([mockRepo({ fullName: "org/huge" })]);
    // 1.7 GB cache → trips cache reason (per-repo) AND total > 1.6 GB trips org roll-up.
    mockGh.fetchRepoStorageUsage.mockResolvedValue(usage("org/huge", Math.floor(1.7 * GB), 0));

    await run();

    const repos = mockOccurrence.ensureAlertIssue.mock.calls.map(c => c[0].repo);
    const titles = mockOccurrence.ensureAlertIssue.mock.calls.map(c => c[0].title);
    expect(repos).toContain("org/huge");
    expect(repos).toContain("St-John-Software/claws");
    expect(titles).toContain(ORG_ISSUE_TITLE);
  });

  it("completes the sweep when one repo's fetch rejects", async () => {
    mockGh.listRepos.mockResolvedValue([
      mockRepo({ fullName: "org/bad" }),
      mockRepo({ fullName: "org/big" }),
    ]);
    mockGh.fetchRepoStorageUsage.mockImplementation((repo: string) => {
      if (repo === "org/bad") return Promise.reject(new Error("boom"));
      // 80 MB of cache → trips the cache alert reason.
      return Promise.resolve(usage("org/big", 80 * MB, 0));
    });

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    expect(mockOccurrence.ensureAlertIssue.mock.calls[0]![0].repo).toBe("org/big");
  });
});

describe("perRepoAlertReasons", () => {
  const nowMs = Date.parse("2026-06-25T00:00:00Z");

  it("returns [] for low cache and fresh artifacts", () => {
    const u = usage("org/a", 10 * MB, 5 * MB, "2026-06-24T00:00:00Z");
    expect(perRepoAlertReasons(u, nowMs)).toHaveLength(0);
  });

  it("returns one reason when cache >= 50 MB", () => {
    const u = usage("org/a", 60 * MB, 0);
    const reasons = perRepoAlertReasons(u, nowMs);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("cache");
  });

  it("returns one reason when oldest artifact is >= 7 days old", () => {
    const u = usage("org/a", 0, 20 * MB, "2026-06-01T00:00:00Z");
    const reasons = perRepoAlertReasons(u, nowMs);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("days old");
  });

  it("returns two reasons when both cache and retention trip", () => {
    const u = usage("org/a", 80 * MB, 20 * MB, "2026-06-01T00:00:00Z");
    expect(perRepoAlertReasons(u, nowMs)).toHaveLength(2);
  });

  it("returns [] when oldestArtifactAt is null", () => {
    const u = { ...usage("org/a", 0, 0), oldestArtifactAt: null };
    expect(perRepoAlertReasons(u, nowMs)).toHaveLength(0);
  });
});

describe("formatBytes", () => {
  it("formats GB, MB, KB and bytes", () => {
    expect(formatBytes(Math.floor(1.23 * GB))).toBe("1.23 GB");
    expect(formatBytes(5 * MB)).toBe("5.00 MB");
    expect(formatBytes(2 * 1024)).toBe("2.00 KB");
    expect(formatBytes(512)).toBe("512 B");
  });
});
