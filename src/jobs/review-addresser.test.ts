import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
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
    listPRs: vi.fn(),
    getPRReviewComments: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    commentOnIssue: vi.fn(),
    updatePRBody: vi.fn(),
    addReaction: vi.fn(),
    addReviewCommentReaction: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    populateQueueCache: vi.fn(),
  },
  mockClaude: {
    createWorktreeFromBranch: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn(),
    regeneratePRDescription: vi.fn(),
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

import { run } from "./review-addresser.js";
import { reportError } from "../error-reporter.js";

describe("review-addresser", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.addReviewCommentReaction.mockResolvedValue(undefined);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "Review comment here",
      commentIds: [100],
      reviewCommentIds: [200],
    });
    mockGh.updatePRBody.mockResolvedValue(undefined);
    mockGh.populateQueueCache.mockReturnValue(undefined);
    mockClaude.createWorktreeFromBranch.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("addressed");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nUpdated");
  });

  it("happy path — fetches comments, creates worktree, pushes changes, reacts, adds Ready label", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    expect(mockGh.getPRReviewComments).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "review-addresser");
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).toHaveBeenCalledWith("/tmp/worktree", pr.baseRefName, pr);
    expect(mockGh.updatePRBody).toHaveBeenCalledWith(repo.fullName, pr.number, "## Summary\nUpdated");
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, pr.number, "addressed");
    expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 100, "+1");
    expect(mockGh.addReviewCommentReaction).toHaveBeenCalledWith(repo.fullName, 200, "+1");
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("no review comments — skips without creating worktree", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "",
      commentIds: [],
      reviewCommentIds: [],
    });

    await run([repo]);

    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("no new commits — no push, no description update, but comment still posted", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.hasNewCommits.mockResolvedValue(false);

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
    expect(mockGh.updatePRBody).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, pr.number, "addressed");
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("error — records failure", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.runClaude.mockRejectedValue(new Error("claude error"));

    await run([repo]);

    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"));
    expect(reportError).toHaveBeenCalled();
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
  });

  it("no new commits and empty Claude output — no comment posted", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.hasNewCommits.mockResolvedValue(false);
    mockClaude.runClaude.mockResolvedValue("   ");

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("posts comment alongside pushed commits", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.runClaude.mockResolvedValue("Fixed the issue and improved test coverage.");

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName, pr.number, "Fixed the issue and improved test coverage.",
    );
  });

  it("description update failure — does not fail the task", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.regeneratePRDescription.mockRejectedValue(new Error("Claude unavailable"));

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
    expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
  });

  it("includes image context in prompt when images are found", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "Fix this ![screenshot](https://example.com/review.png)",
      commentIds: [101],
      reviewCommentIds: [],
    });
    mockProcessTextForImages.mockResolvedValueOnce("\n## Attached Images\n- .claws-images/img-1.png");

    await run([repo]);

    expect(mockProcessTextForImages).toHaveBeenCalledWith(
      ["Fix this ![screenshot](https://example.com/review.png)"],
      "/tmp/worktree",
    );
    const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("## Attached Images");
  });

  it("skips non-claws PRs", async () => {
    const pr = mockPR({ headRefName: "feature-branch" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    expect(mockGh.getPRReviewComments).not.toHaveBeenCalled();
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });
});
