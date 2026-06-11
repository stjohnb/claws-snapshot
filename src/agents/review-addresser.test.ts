import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
  },
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
}));
const mockGetModel = vi.hoisted(() => vi.fn().mockReturnValue("opus"));
vi.mock("../model-selector.js", () => ({ getModel: mockGetModel }));
const mockExtractRecommendedModel = vi.hoisted(() => vi.fn().mockReturnValue("opus"));
vi.mock("./pr-reviewer.js", () => ({ extractRecommendedModel: mockExtractRecommendedModel }));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../timeout-handler.js", () => ({
  handleTimeoutIfApplicable: vi.fn().mockResolvedValue(undefined),
  getItemTimeoutMs: vi.fn().mockReturnValue(undefined),
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    commentOnIssue: vi.fn(),
    updatePR: vi.fn(),
    getPRBody: vi.fn(),
    addReaction: vi.fn(),
    addReviewCommentReaction: vi.fn(),
    editIssueComment: vi.fn(),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    stripClawsMarker: vi.fn((body: string) => body),
  },
  mockClaude: {
    withExistingWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn(),
    regeneratePRDescription: vi.fn(),
    writeClawsMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    readRepoAgentDoc: vi.fn().mockReturnValue(undefined),
    getCommitCount: vi.fn().mockResolvedValue(1),
    getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 1, insertions: 10, deletions: 5 }),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
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
}));

vi.mock("../github.js", () => ({ ...mockGh, ADDRESSED_REACTION: "rocket", REVIEW_ADDRESSED_MARKER: "review-addressed" }));
vi.mock("../claude.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claude.js")>();
  return { ...mockClaude, AgentCliError: actual.AgentCliError };
});
vi.mock("../db.js", () => mockDb);

const mockProcessTextForImages = vi.hoisted(() => vi.fn().mockResolvedValue(""));
vi.mock("../images.js", () => ({
  processTextForImages: mockProcessTextForImages,
}));

import { processPR } from "./review-addresser.js";
import { AgentCliError } from "../claude.js";

describe("review-addresser", () => {
  const repo = mockRepo();
  const reviewData = {
    formatted: "Review comment here",
    commentIds: [100],
    reviewCommentIds: [200],
    htmlBodies: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.addReviewCommentReaction.mockResolvedValue(undefined);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.updatePR.mockResolvedValue(undefined);
    mockGh.getPRBody.mockResolvedValue("");
    mockClaude.withExistingWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nUpdated");
  });

  it("happy path — creates worktree, pushes changes, reacts, does NOT add Ready label or post comment", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });

    await processPR(repo, pr, reviewData);

    expect(mockClaude.withExistingWorktree).toHaveBeenCalledWith(repo, pr.headRefName, "review-addresser", expect.any(Function));
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).toHaveBeenCalledWith("/tmp/worktree", pr.baseRefName, pr, repo.fullName, expect.any(String));
    expect(mockGh.updatePR).toHaveBeenCalledWith(repo.fullName, pr.number, "## Summary\nUpdated");
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 100, "rocket");
    expect(mockGh.addReviewCommentReaction).toHaveBeenCalledWith(repo.fullName, 200, "rocket");
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("no new commits, no issues — restores Ready label without posting comment", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockClaude.hasNewCommits.mockResolvedValue(false);
    mockClaude.runClaude.mockResolvedValue("   ");

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
    expect(mockGh.updatePR).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("marks PR review comment as addressed when no commits pushed", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const reviewSha = "abc123def456";
    const reviewBody = `## PR Review\n\nFix the bug\n\nReviewed commit: \`${reviewSha}\``;
    const reviewDataWithComment = {
      ...reviewData,
      prReviewComment: { id: 300, body: reviewBody, reviewedCommit: reviewSha },
    };
    mockClaude.hasNewCommits.mockResolvedValue(false);
    mockClaude.runClaude.mockResolvedValue("   ");

    await processPR(repo, pr, reviewDataWithComment);

    expect(mockGh.editIssueComment).toHaveBeenCalledWith(
      repo.fullName,
      300,
      expect.stringContaining(`review-addressed: ${reviewSha}`),
      { agentName: "Reviewer" },
    );
  });

  it("does not mark PR review comment as addressed when commits are pushed", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const reviewSha = "abc123def456";
    const reviewDataWithComment = {
      ...reviewData,
      prReviewComment: { id: 300, body: "## PR Review\n\nFix the bug", reviewedCommit: reviewSha },
    };
    mockClaude.hasNewCommits.mockResolvedValue(true);

    await processPR(repo, pr, reviewDataWithComment);

    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("does not edit review comment if addressed marker already present", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const reviewSha = "abc123def456";
    const reviewBody = `## PR Review\n\nFix the bug\n\nreview-addressed: ${reviewSha}`;
    const reviewDataWithComment = {
      ...reviewData,
      prReviewComment: { id: 300, body: reviewBody, reviewedCommit: reviewSha },
    };
    mockClaude.hasNewCommits.mockResolvedValue(false);
    mockClaude.runClaude.mockResolvedValue("   ");

    await processPR(repo, pr, reviewDataWithComment);

    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("no new commits with issue output — posts comment but does NOT add Ready label", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockClaude.hasNewCommits.mockResolvedValue(false);
    mockClaude.runClaude.mockResolvedValue("Could not implement suggestion: the function does not exist");

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      "Could not implement suggestion: the function does not exist",
      { agentName: "Review Addresser" },
    );
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("commits pushed with issue output — posts comment, does not add Ready", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.runClaude.mockResolvedValue("Note: one suggestion could not be applied");

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      "Note: one suggestion could not be applied",
      { agentName: "Review Addresser" },
    );
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("error — records failure and throws", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockClaude.runClaude.mockRejectedValue(new Error("claude error"));

    await expect(processPR(repo, pr, reviewData)).rejects.toThrow("claude error");

    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"), expect.any(Object));
  });

  it("description update failure — does not fail the task", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockClaude.regeneratePRDescription.mockRejectedValue(new Error("Claude unavailable"));

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
  });

  it("non-Claws PR — pushes changes but skips description regeneration", async () => {
    const pr = mockPR({ headRefName: "feature/my-branch" });

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
    expect(mockGh.updatePR).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 100, "rocket");
    expect(mockGh.addReviewCommentReaction).toHaveBeenCalledWith(repo.fullName, 200, "rocket");
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("CLI error — no reactions, no comment, no label, task recorded as failed", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const cliError = new AgentCliError("You're out of extra usage · resets 5pm", 1);
    mockClaude.runClaude.mockRejectedValue(cliError);

    await expect(processPR(repo, pr, reviewData)).rejects.toThrow("You're out of extra usage");

    expect(mockGh.addReaction).not.toHaveBeenCalled();
    expect(mockGh.addReviewCommentReaction).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("You're out of extra usage"), expect.any(Object));
  });

  it("skips gracefully when branch no longer exists (merged/closed)", async () => {
    const pr = mockPR({ headRefName: "dependabot/npm/lodash-4.0" });
    mockClaude.withExistingWorktree.mockResolvedValue(null);

    await processPR(repo, pr, reviewData);

    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, {
      commits: 0,
      prNumber: pr.number,
      prAction: "skipped",
    });
    expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
  });

  it("includes image context in prompt when images are found", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const imgReviewData = {
      formatted: "Fix this ![screenshot](https://example.com/review.png)",
      commentIds: [101],
      reviewCommentIds: [],
      htmlBodies: [`<p>Fix this <img src="https://private-user-images.githubusercontent.com/x.png?jwt=tok"></p>`],
    };
    mockProcessTextForImages.mockResolvedValueOnce("\n## Attached Images\n- .claws-images/img-1.png");

    await processPR(repo, pr, imgReviewData);

    expect(mockProcessTextForImages).toHaveBeenCalledWith(
      ["Fix this ![screenshot](https://example.com/review.png)"],
      "/tmp/worktree",
      "test-org",
      { repo: "test-org/test-repo", issueNumber: 10, agentName: "Review Addresser" },
      [`<p>Fix this <img src="https://private-user-images.githubusercontent.com/x.png?jwt=tok"></p>`],
    );
    const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("## Attached Images");
  });

  it("uses recommended model from review comments", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockExtractRecommendedModel.mockReturnValueOnce("sonnet");
    mockGetModel.mockReturnValueOnce("sonnet");

    await processPR(repo, pr, reviewData);

    expect(mockExtractRecommendedModel).toHaveBeenCalledWith(reviewData.formatted);
    expect(mockGetModel).toHaveBeenCalledWith("sonnet", "tool-use", "claude");
    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/worktree",
      expect.objectContaining({ model: "sonnet" }),
    );
    expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "sonnet");
  });

  it("defaults to sonnet when no model recommendation in review", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockExtractRecommendedModel.mockReturnValueOnce("sonnet");
    mockGetModel.mockReturnValueOnce("sonnet");

    await processPR(repo, pr, reviewData);

    expect(mockGetModel).toHaveBeenCalledWith("sonnet", "tool-use", "claude");
    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/worktree",
      expect.objectContaining({ model: "sonnet" }),
    );
  });

  it("prompt instructs Claude to answer questions even when committing", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });

    await processPR(repo, pr, reviewData);

    const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("you MUST answer it directly in text output");
    expect(prompt).toContain("answering only with a commit is not acceptable");
    expect(prompt).not.toContain("Always include a brief summary");
  });

  it("posts the agent's answer when a question is answered with a commit", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.runClaude.mockResolvedValue("Yes — I switched to the cached lookup in commit abc123 as you asked.");

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      "Yes — I switched to the cached lookup in commit abc123 as you asked.",
      { agentName: "Review Addresser" },
    );
  });

  it("preserves closing keyword and phase header from existing PR body", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.getPRBody.mockResolvedValue("## PR 2 of 3: Phase Title\n\nSomething\n\nCloses #10");

    await processPR(repo, pr, reviewData);

    expect(mockGh.updatePR).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      "## PR 2 of 3: Phase Title\n\n## Summary\nUpdated\n\nCloses #10",
    );
  });

  it("preserves Part of keyword for intermediate phases", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.getPRBody.mockResolvedValue("Some content\n\nPart of #5");

    await processPR(repo, pr, reviewData);

    expect(mockGh.updatePR).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      "## Summary\nUpdated\n\nPart of #5",
    );
  });
});
