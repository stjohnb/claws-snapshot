import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";
import { CLAWS_AUTOMATION_DOC } from "../resources/claws-info.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
}));
vi.mock("../model-selector.js", () => ({ getModel: () => "sonnet" }));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh, mockClaude, mockDb, mockPlanParser, mockSlack } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
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
    withNewWorktree: vi.fn(),
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
    getCommitCount: vi.fn().mockResolvedValue(1),
    getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 1, insertions: 10, deletions: 5 }),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    markRepoProcessedDaily: vi.fn(),
    withTaskRecording: vi.fn(async (jobName: string, repo: string, itemNumber: number, triggerLabel: string | null, fn: (taskId: number) => Promise<unknown>) => {
      const taskId = mockDb.recordTaskStart(jobName, repo, itemNumber, triggerLabel);
      try {
        return await fn(taskId);
      } catch (err) {
        mockDb.recordTaskFailed(taskId, String(err), { failureCategory: "unknown" });
        throw err;
      }
    }),
  },
  mockPlanParser: {
    findPlanComment: vi.fn(),
  },
  mockSlack: {
    notify: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../smart-schedule.js", () => ({ localDateString: () => "2024-01-15" }));
vi.mock("../plan-parser.js", () => mockPlanParser);
vi.mock("../slack.js", () => mockSlack);

import { run } from "./doc-maintainer.js";
import { reportError } from "../error-reporter.js";

describe("doc-maintainer", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(CLAWS_AUTOMATION_DOC);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(100);
    mockGh.listRecentlyClosedIssues.mockResolvedValue([]);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("docs generated");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
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
    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
  });

  it("skips repo when open docs PR already exists", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
  });

  it("skips repo when HEAD matches last doc-maintainer commit and claws doc is current", async () => {
    mockClaude.getHeadSha.mockResolvedValue("abc123");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue("abc123");
    // readFileSync returns CLAWS_AUTOMATION_DOC by default (set in beforeEach)

    await run([repo]);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("syncs claws doc when it is missing even if no code changes since last doc commit", async () => {
    mockClaude.getHeadSha.mockResolvedValue("abc123");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue("abc123");
    // Doc file is absent
    mockFs.existsSync.mockImplementation((p: string) => !p.endsWith("claws-automation.md"));
    mockClaude.git.mockImplementation(async (args: string[]) => {
      // Simulate "diff --cached" showing the file is staged
      if (args[0] === "diff") return "docs/claws-automation.md\n";
      return "";
    });

    await run([repo]);

    expect(mockClaude.runClaude).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("claws-automation.md"),
      CLAWS_AUTOMATION_DOC,
    );
    expect(mockClaude.git).toHaveBeenCalledWith(
      expect.arrayContaining(["commit", "-m", expect.stringContaining("[doc-maintainer]")]),
      expect.any(String),
    );
    expect(mockGh.createPR).toHaveBeenCalled();
  });

  it("syncs claws doc when it exists but has stale content", async () => {
    mockClaude.getHeadSha.mockResolvedValue("abc123");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue("abc123");
    // File exists but content is outdated
    mockFs.readFileSync.mockReturnValue("outdated content");
    mockClaude.git.mockImplementation(async (args: string[]) => {
      if (args[0] === "diff") return "docs/claws-automation.md\n";
      return "";
    });

    await run([repo]);

    expect(mockClaude.runClaude).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("claws-automation.md"),
      CLAWS_AUTOMATION_DOC,
    );
    expect(mockGh.createPR).toHaveBeenCalled();
  });

  it("no-op when claws doc is current and no code changes since last doc commit", async () => {
    mockClaude.getHeadSha.mockResolvedValue("abc123");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue("abc123");
    // readFileSync returns CLAWS_AUTOMATION_DOC by default (set in beforeEach)

    await run([repo]);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("instructs Claude to create CLAUDE.md if absent", async () => {
    mockClaude.getLastDocMaintainerSha.mockResolvedValue(null);

    await run([repo]);

    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.stringContaining("CLAUDE.md` is absent, create it"),
      "/tmp/worktree",
      expect.any(Object),
    );
  });

  it("creates docs PR when no previous doc-maintainer commit exists", async () => {
    mockClaude.getLastDocMaintainerSha.mockResolvedValue(null);

    await run([repo]);

    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.stringContaining("maintaining documentation"),
      "/tmp/worktree",
      expect.objectContaining({ model: "sonnet" }),
    );
    expect(mockClaude.generateDocsPRDescription).toHaveBeenCalledWith(
      "/tmp/worktree",
      repo.defaultBranch,
      expect.any(String),
    );
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      expect.stringContaining("claws/docs-"),
      expect.stringContaining("update documentation"),
      "## Summary\nUpdated docs",
    );
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
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

    expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(1);
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude crashed"), expect.any(Object));
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
        expect.objectContaining({ model: "sonnet" }),
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
        expect.objectContaining({ model: "sonnet" }),
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

      // Should write exactly 10 plan files (the cap) — plus 1 for the claws-automation.md sync
      const planWrites = mockFs.writeFileSync.mock.calls.filter(
        (args) => (args[0] as string).includes(".plans/"),
      );
      expect(planWrites).toHaveLength(10);
    });
  });

  it("marks repo processed after run", async () => {
    await run([repo]);
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "doc-maintainer", repo.fullName, "2024-01-15"
    );
  });

  describe("slack summary", () => {
    it("posts summary when a PR is created", async () => {
      await run([repo]);

      expect(mockSlack.notify).toHaveBeenCalledTimes(1);
      expect(mockSlack.notify).toHaveBeenCalledWith(expect.stringContaining("1 PR opened"));
      expect(mockSlack.notify).toHaveBeenCalledWith(expect.stringContaining("test-org/test-repo"));
    });

    it("includes plan titles as features covered", async () => {
      mockGh.listRecentlyClosedIssues.mockResolvedValue([
        { number: 42, title: "Add auth", body: "body", closedAt: "2025-01-15T00:00:00Z" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## Implementation Plan\nDo the thing", login: "bot" },
      ]);
      mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nDo the thing");

      await run([repo]);

      expect(mockSlack.notify).toHaveBeenCalledWith(expect.stringContaining("features:"));
      expect(mockSlack.notify).toHaveBeenCalledWith(expect.stringContaining("Add auth"));
    });

    it("posts summary when Claude produces no commits", async () => {
      mockClaude.hasNewCommits.mockResolvedValue(false);

      await run([repo]);

      expect(mockSlack.notify).toHaveBeenCalledTimes(1);
      expect(mockSlack.notify).toHaveBeenCalledWith(expect.stringContaining("No-op"));
    });

    it("does not post summary when all repos lack a local clone", async () => {
      mockFs.existsSync.mockReturnValue(false);

      await run([repo]);

      expect(mockSlack.notify).not.toHaveBeenCalled();
    });

    it("does not post summary when all repos are skipped-no-changes", async () => {
      mockClaude.getHeadSha.mockResolvedValue("abc123");
      mockClaude.getLastDocMaintainerSha.mockResolvedValue("abc123");

      await run([repo]);

      expect(mockSlack.notify).not.toHaveBeenCalled();
    });

    it("does not post summary when all repos are skipped-has-pr", async () => {
      mockGh.listPRs.mockResolvedValue([mockPR({ headRefName: "claws/docs-ab12" })]);

      await run([repo]);

      expect(mockSlack.notify).not.toHaveBeenCalled();
    });

    it("posts summary when errors occur", async () => {
      mockClaude.runClaude.mockRejectedValue(new Error("claude crashed"));

      await run([repo]);

      expect(mockSlack.notify).toHaveBeenCalledTimes(1);
      expect(mockSlack.notify).toHaveBeenCalledWith(expect.stringContaining("Errors:"));
    });
  });
});
