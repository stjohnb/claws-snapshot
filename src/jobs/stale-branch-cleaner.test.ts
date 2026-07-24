import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
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

const { mockFs, mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
  },
  mockGh: {
    listPRsForBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    git: vi.fn(),
    repoDir: vi.fn((repo: { owner: string; name: string }) => `/home/testuser/.claws/repos/${repo.owner}/${repo.name}`),
  },
  mockDb: {
    markRepoProcessedDaily: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../smart-schedule.js", async () => {
  const { reportError } = await import("../error-reporter.js");
  return {
    localDateString: () => "2024-01-15",
    runDailyRepoLoop: async (
      jobName: string,
      repos: Array<{ fullName: string }>,
      processRepo: (repo: { fullName: string }) => Promise<void>,
    ) => {
      for (const repo of repos) {
        if (mockGh.isRateLimited()) break;
        try {
          await processRepo(repo);
        } catch (err) {
          reportError(`${jobName}:process-repo`, repo.fullName, err);
        }
        mockDb.markRepoProcessedDaily(jobName, repo.fullName, "2024-01-15");
      }
    },
  };
});

import { run } from "./stale-branch-cleaner.js";
import { reportError } from "../error-reporter.js";

describe("stale-branch-cleaner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.isRateLimited.mockReturnValue(false);
    mockFs.existsSync.mockReturnValue(true);
    mockClaude.ensureClone.mockResolvedValue(undefined);
    mockClaude.git.mockResolvedValue("");
    mockGh.listPRsForBranch.mockResolvedValue([]);
    mockGh.deleteRemoteBranch.mockResolvedValue(undefined);
  });

  it("marks repo processed daily after successful processing", async () => {
    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "stale-branch-cleaner",
      repo.fullName,
      "2024-01-15",
    );
  });

  it("marks each repo processed daily when given multiple repos", async () => {
    const repo2 = mockRepo({ name: "repo-2", fullName: "test-org/repo-2" });

    await run([repo, repo2]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledTimes(2);
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("stale-branch-cleaner", repo.fullName, "2024-01-15");
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("stale-branch-cleaner", repo2.fullName, "2024-01-15");
  });

  it("marks repo processed even when processRepo throws", async () => {
    mockClaude.ensureClone.mockRejectedValue(new Error("clone failed"));

    await run([repo]);

    expect(reportError).toHaveBeenCalledWith("stale-branch-cleaner:process-repo", repo.fullName, expect.any(Error));
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("stale-branch-cleaner", repo.fullName, "2024-01-15");
  });

  it("does not mark repo processed when rate limited before processing", async () => {
    mockGh.isRateLimited.mockReturnValue(true);

    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).not.toHaveBeenCalled();
  });

  it("marks first repo processed but stops before second when rate limited between repos", async () => {
    const repo2 = mockRepo({ name: "repo-2", fullName: "test-org/repo-2" });

    mockGh.isRateLimited
      .mockReturnValueOnce(false) // first repo entry check
      .mockReturnValueOnce(true); // second repo entry check

    await run([repo, repo2]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledTimes(1);
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("stale-branch-cleaner", repo.fullName, "2024-01-15");
    expect(mockDb.markRepoProcessedDaily).not.toHaveBeenCalledWith("stale-branch-cleaner", repo2.fullName, expect.any(String));
  });

  it("skips repos without a local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith("stale-branch-cleaner", repo.fullName, "2024-01-15");
  });

  it("deletes stale merged branches older than 7 days", async () => {
    const mergedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const dateStr = createdAt.toISOString().replace("T", " ").replace("Z", " +0000");
    mockClaude.git.mockResolvedValue(`origin/claws/issue-1-ab12 ${dateStr}`);
    mockGh.listPRsForBranch.mockResolvedValue([{ state: "MERGED", number: 1, mergedAt }]);

    await run([repo]);

    expect(mockGh.deleteRemoteBranch).toHaveBeenCalledWith(repo.fullName, "claws/issue-1-ab12");
  });

  it("does not delete branches with open PRs", async () => {
    const createdAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const dateStr = createdAt.toISOString().replace("T", " ").replace("Z", " +0000");
    mockClaude.git.mockResolvedValue(`origin/claws/issue-1-ab12 ${dateStr}`);
    mockGh.listPRsForBranch.mockResolvedValue([{ state: "OPEN", number: 1 }]);

    await run([repo]);

    expect(mockGh.deleteRemoteBranch).not.toHaveBeenCalled();
  });
});
