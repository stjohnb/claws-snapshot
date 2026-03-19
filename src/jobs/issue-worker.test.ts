import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    inReview: "In Review",
  },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    listIssuesByLabel: vi.fn(),
    listOpenIssues: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    createPR: vi.fn(),
    getIssueComments: vi.fn(),
    listMergedPRsForIssue: vi.fn(),
    getOpenPRForIssue: vi.fn(),
    editIssueComment: vi.fn(),
    commentOnIssue: vi.fn(),
    isClawsComment: (body: string) => body.includes("<!-- claws-automated -->"),
    stripClawsMarker: (body: string) => body.replace("<!-- claws-automated -->", "").replace("*— Automated by Claws —*", "").trim(),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    isItemPrioritized: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    populateQueueCache: vi.fn(),
  },
  mockClaude: {
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn(),
    generatePRDescription: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

const mockProcessTextForImages = vi.hoisted(() => vi.fn().mockResolvedValue(""));
vi.mock("../images.js", () => ({
  processTextForImages: mockProcessTextForImages,
}));

vi.mock("../plan-parser.js", async () => {
  const actual = await vi.importActual("../plan-parser.js");
  return actual;
});

import { run } from "./issue-worker.js";
import { reportError } from "../error-reporter.js";

describe("issue-worker", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("implemented");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.generatePRDescription.mockResolvedValue("## Summary\nFixed it");
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockGh.listIssuesByLabel.mockResolvedValue([]);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.createPR.mockResolvedValue(100);
    mockGh.getIssueComments.mockResolvedValue([] as { id: number; body: string; login: string }[]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
  });

  describe("single-PR flow", () => {
    it("happy path — creates worktree, runs claude, pushes, creates PR", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);

      await run([repo]);

      expect(mockClaude.createWorktree).toHaveBeenCalled();
      expect(mockClaude.pushBranch).toHaveBeenCalled();
      expect(mockClaude.generatePRDescription).toHaveBeenCalled();
      expect(mockGh.createPR).toHaveBeenCalledWith(
        repo.fullName,
        expect.stringContaining("claws/issue-1"),
        expect.stringContaining("#1"),
        expect.stringContaining("Closes #1"),
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "In Review");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
    });

    it("no commits — logs warning, no PR created, no In Review label", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockClaude.hasNewCommits.mockResolvedValue(false);

      await run([repo]);

      expect(mockClaude.pushBranch).not.toHaveBeenCalled();
      expect(mockGh.createPR).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "In Review");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
    });

    it("error handling — records failed task, trigger label stays", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockClaude.runClaude.mockRejectedValue(new Error("claude error"));

      await run([repo]);

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"));
      expect(reportError).toHaveBeenCalled();
      expect(mockClaude.removeWorktree).toHaveBeenCalled();
      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("label management — removes Ready at start and Refined on success", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);

      await run([repo]);

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });
  });

  describe("multi-PR flow", () => {
    const multiPRPlan = [
      "## Implementation Plan",
      "",
      "Preamble text.",
      "",
      "### PR 1: Add database schema",
      "Create tables.",
      "",
      "### PR 2: Implement API endpoints",
      "Build REST endpoints.",
      "",
      "### PR 3: Add frontend UI",
      "Wire up React components.",
    ].join("\n");

    it("creates first PR with phase title", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await run([repo]);

      expect(mockGh.createPR).toHaveBeenCalledWith(
        repo.fullName,
        expect.stringContaining("claws/issue-1"),
        "fix(#1): Add database schema (1/3)",
        expect.stringContaining("Part of #1"),
      );
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    it("creates second PR after first is merged", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, title: "Add database schema", headRefName: "claws/issue-1-xxxx" }),
      ]);

      await run([repo]);

      expect(mockGh.createPR).toHaveBeenCalledWith(
        repo.fullName,
        expect.stringContaining("claws/issue-1"),
        "fix(#1): Implement API endpoints (2/3)",
        expect.stringContaining("Part of #1"),
      );
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    it("creates final PR with Closes reference", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        mockPR({ number: 51, headRefName: "claws/issue-1-bbbb" }),
      ]);

      await run([repo]);

      expect(mockGh.createPR).toHaveBeenCalledWith(
        repo.fullName,
        expect.stringContaining("claws/issue-1"),
        "fix(#1): Add frontend UI (3/3)",
        expect.stringContaining("Closes #1"),
      );
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    it("includes phase-specific prompt content", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await run([repo]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("PR 1 of 3");
      expect(prompt).toContain("Add database schema");
      expect(prompt).toContain("Do NOT implement changes from other phases");
    });
  });

  describe("checkAndContinue (multi-PR via listOpenIssues)", () => {
    const multiPRPlan = [
      "## Implementation Plan",
      "",
      "### PR 1: First change",
      "Do first thing.",
      "",
      "### PR 2: Second change",
      "Do second thing.",
    ].join("\n");

    it("does nothing if there is still an open PR", async () => {
      const issue = mockIssue();
      // No refined issues, but issue appears in listOpenIssues
      mockGh.listIssuesByLabel.mockResolvedValueOnce([]);
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      // Issue has merged PRs (so it qualifies for multi-phase check)
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      // Still has an open PR
      mockGh.getOpenPRForIssue.mockResolvedValue(mockPR({ headRefName: "claws/issue-1-cd34" }));

      await run([repo]);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("re-labels as Refined when PR merged and more phases remain", async () => {
      const issue = mockIssue();
      mockGh.listIssuesByLabel.mockResolvedValueOnce([]);
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);

      await run([repo]);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("does not re-label when all phases are complete", async () => {
      const issue = mockIssue();
      mockGh.listIssuesByLabel.mockResolvedValueOnce([]);
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        mockPR({ number: 51, headRefName: "claws/issue-1-bbbb" }),
      ]);

      await run([repo]);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });
  });

  describe("duplicate PR prevention", () => {
    it("skips if open PR already exists", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getOpenPRForIssue.mockResolvedValue(
        mockPR({ number: 42, headRefName: "claws/issue-1-ab12" }),
      );

      await run([repo]);

      expect(mockClaude.createWorktree).not.toHaveBeenCalled();
      expect(mockClaude.runClaude).not.toHaveBeenCalled();
      expect(mockGh.createPR).not.toHaveBeenCalled();
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("skips checkAndContinue for issues just processed", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      // Issue appears in both Refined list and listOpenIssues
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getOpenPRForIssue.mockResolvedValue(null);

      await run([repo]);

      // getOpenPRForIssue called once for the processIssue guard, but NOT again for checkAndContinue
      expect(mockGh.getOpenPRForIssue).toHaveBeenCalledTimes(1);
    });
  });

  describe("phase progress comment", () => {
    const multiPRPlan = [
      "## Implementation Plan",
      "",
      "Preamble text.",
      "",
      "### PR 1: Add database schema",
      "Create tables.",
      "",
      "### PR 2: Implement API endpoints",
      "Build REST endpoints.",
      "",
      "### PR 3: Add frontend UI",
      "Wire up React components.",
    ].join("\n");

    it("posts progress comment before implementing next phase", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, title: "Add database schema", headRefName: "claws/issue-1-xxxx" }),
      ]);

      await run([repo]);

      // Only one runClaude call (implementation only, no plan rewrite)
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);

      // Progress comment posted (not plan edit)
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("phase-progress:1"),
      );
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();

      // PR still created
      expect(mockGh.createPR).toHaveBeenCalled();
    });

    it("skips progress comment if marker already exists in comments", async () => {
      const progressComment = "## Phase Progress\n\n<!-- phase-progress:1 -->";
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: multiPRPlan, login: "claws-bot" },
        { id: 43, body: progressComment, login: "claws-bot" },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-xxxx" }),
      ]);

      await run([repo]);

      // No progress comment posted (already exists)
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      // Implementation still runs
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    });

    it("progress comment failure does not block implementation", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-xxxx" }),
      ]);

      mockGh.commentOnIssue.mockRejectedValueOnce(new Error("API error"));

      await run([repo]);

      // Implementation still proceeds
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
      expect(mockGh.createPR).toHaveBeenCalled();
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("skips progress comment for first phase", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await run([repo]);

      // No progress comment for first phase
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    });

    it("progress comment contains merged PR numbers and titles", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, title: "Add database schema", headRefName: "claws/issue-1-xxxx" }),
        mockPR({ number: 51, title: "Implement API endpoints", headRefName: "claws/issue-1-yyyy" }),
      ]);

      await run([repo]);

      const commentBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(commentBody).toContain("PR #50: Add database schema");
      expect(commentBody).toContain("PR #51: Implement API endpoints");
      expect(commentBody).toContain("2/3");
      expect(commentBody).toContain("PR 3/3");
    });
  });

  it("includes image context in prompt when images are found", async () => {
    const issue = mockIssue({
      body: "Fix this: ![bug](https://example.com/bug.png)",
      labels: [{ name: "Refined" }],
    });
    mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([{ id: 100, body: "![comment img](https://example.com/comment.png)", login: "commenter" }]);
    mockProcessTextForImages.mockResolvedValueOnce("\n## Attached Images\n- .claws-images/img-1.png");

    await run([repo]);

    expect(mockProcessTextForImages).toHaveBeenCalledWith(
      [issue.body, "![comment img](https://example.com/comment.png)"],
      "/tmp/worktree",
    );
    const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("## Attached Images");
  });
});
