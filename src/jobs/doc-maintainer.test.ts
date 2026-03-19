import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh, mockClaude, mockDb, mockPlanParser } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  },
  mockGh: {
    listPRs: vi.fn(),
    createPR: vi.fn(),
    listRecentlyClosedIssues: vi.fn(),
    getIssueComments: vi.fn(),
  },
  mockClaude: {
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn(),
    getHeadSha: vi.fn(),
    getLastDocMaintainerSha: vi.fn(),
    getCommitDate: vi.fn(),
    generateDocsPRDescription: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    datestamp: vi.fn().mockReturnValue("20260318"),
    git: vi.fn(),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
  },
  mockPlanParser: {
    findPlanComment: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../plan-parser.js", () => mockPlanParser);

import { run } from "./doc-maintainer.js";
import { reportError } from "../error-reporter.js";

describe("doc-maintainer", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(100);
    mockGh.listRecentlyClosedIssues.mockResolvedValue([]);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("docs generated");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.getHeadSha.mockResolvedValue("abc123");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue(null);
    mockClaude.getCommitDate.mockResolvedValue(new Date("2025-01-01"));
    mockClaude.generateDocsPRDescription.mockResolvedValue("## Summary\nUpdated docs");
    mockClaude.git.mockResolvedValue("");
    mockPlanParser.findPlanComment.mockReturnValue(null);
  });

  it("skips repo without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockGh.listPRs).not.toHaveBeenCalled();
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("skips repo when open docs PR already exists", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("skips repo when HEAD matches last doc-maintainer commit", async () => {
    mockClaude.getHeadSha.mockResolvedValue("abc123");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue("abc123");

    await run([repo]);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("creates docs PR when no previous doc-maintainer commit exists", async () => {
    mockClaude.getLastDocMaintainerSha.mockResolvedValue(null);

    await run([repo]);

    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.stringContaining("maintaining documentation"),
      "/tmp/worktree",
    );
    expect(mockClaude.generateDocsPRDescription).toHaveBeenCalledWith(
      "/tmp/worktree",
      repo.defaultBranch,
    );
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      expect.stringContaining("claws/docs-"),
      expect.stringContaining("update documentation"),
      "## Summary\nUpdated docs",
    );
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("creates docs PR when HEAD differs from last doc-maintainer commit", async () => {
    mockClaude.getHeadSha.mockResolvedValue("newsha");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue("oldsha");

    await run([repo]);

    expect(mockClaude.runClaude).toHaveBeenCalled();
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockGh.createPR).toHaveBeenCalled();
  });

  it("does not create PR when Claude produces no commits", async () => {
    mockClaude.hasNewCommits.mockResolvedValue(false);

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("cleans up worktree on error", async () => {
    mockClaude.runClaude.mockRejectedValue(new Error("claude crashed"));

    await run([repo]);

    expect(mockClaude.removeWorktree).toHaveBeenCalled();
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude crashed"));
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockClaude.runClaude
      .mockRejectedValueOnce(new Error("first repo error"))
      .mockResolvedValueOnce("docs generated");

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "doc-maintainer:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    // Second repo should still be processed
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo2.fullName,
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  describe("plan harvesting", () => {
    it("fetches plans from recently-closed issues and writes .plans/ directory", async () => {
      mockGh.listRecentlyClosedIssues.mockResolvedValue([
        { number: 42, title: "Add auth", body: "body", closedAt: "2025-01-15T00:00:00Z" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## Implementation Plan\nDo the thing", login: "bot" },
      ]);
      mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nDo the thing");

      await run([repo]);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp/worktree/.plans", { recursive: true });
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        "/tmp/worktree/.plans/42.md",
        expect.stringContaining("# Issue #42: Add auth"),
      );
      // Prompt should include plan instructions
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.stringContaining(".plans/"),
        "/tmp/worktree",
      );
    });

    it("uses last doc-maintainer commit date as since cutoff", async () => {
      const commitDate = new Date("2025-01-10T00:00:00Z");
      mockClaude.getLastDocMaintainerSha.mockResolvedValue("oldsha");
      mockClaude.getHeadSha.mockResolvedValue("newsha");
      mockClaude.getCommitDate.mockResolvedValue(commitDate);

      await run([repo]);

      expect(mockClaude.getCommitDate).toHaveBeenCalledWith("/tmp/worktree", "oldsha");
      expect(mockGh.listRecentlyClosedIssues).toHaveBeenCalledWith(repo.fullName, commitDate);
    });

    it("falls back to 7-day window when no previous doc-maintainer commit", async () => {
      mockClaude.getLastDocMaintainerSha.mockResolvedValue(null);

      await run([repo]);

      const [, sinceDate] = mockGh.listRecentlyClosedIssues.mock.calls[0];
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      // Should be within a few seconds of 7 days ago
      expect(Math.abs(sinceDate.getTime() - sevenDaysAgo)).toBeLessThan(5000);
    });

    it("skips issues without plan comments", async () => {
      mockGh.listRecentlyClosedIssues.mockResolvedValue([
        { number: 10, title: "No plan", body: "body", closedAt: "2025-01-15T00:00:00Z" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "just a comment", login: "user" },
      ]);
      mockPlanParser.findPlanComment.mockReturnValue(null);

      await run([repo]);

      expect(mockFs.mkdirSync).not.toHaveBeenCalledWith(
        expect.stringContaining(".plans"),
        expect.anything(),
      );
      // Prompt should NOT include plan instructions
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.not.stringContaining(".plans/"),
        "/tmp/worktree",
      );
    });

    it("cleans up .plans/ directory after Claude runs", async () => {
      mockGh.listRecentlyClosedIssues.mockResolvedValue([
        { number: 42, title: "Add auth", body: "body", closedAt: "2025-01-15T00:00:00Z" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## Implementation Plan\nDo the thing", login: "bot" },
      ]);
      mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nDo the thing");

      await run([repo]);

      expect(mockFs.rmSync).toHaveBeenCalledWith("/tmp/worktree/.plans", { recursive: true });
    });

    it("caps plans at 10 and truncates long plans", async () => {
      // Create 12 closed issues to test the cap
      const issues = Array.from({ length: 12 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
        body: "body",
        closedAt: "2025-01-15T00:00:00Z",
      }));
      mockGh.listRecentlyClosedIssues.mockResolvedValue(issues);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## Implementation Plan\nPlan", login: "bot" },
      ]);
      mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nPlan");

      await run([repo]);

      // Should write exactly 10 plan files (the cap)
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(10);
    });
  });
});
