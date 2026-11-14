import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  forgejoRepoUrl: (fullName: string) => `https://forge.example.test/${fullName}`,
  LABELS: {
    refined: "Refined",
    priority: "Priority",
  },
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  HOME_ASSISTANT_CONFIG_REPO: "",
}));
const mockGetModel = vi.hoisted(() => vi.fn().mockReturnValue("opus"));
// The per-issue model plan is exercised in model-plan.test.ts; here it
// resolves exactly like an issue with no cells, over the mocked selector.
const mockResolveModelPlanCell = vi.hoisted(() => vi.fn());
const mockSetSuggestedPlan = vi.hoisted(() => vi.fn());
vi.mock("../model-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-plan.js")>();
  const selector = await import("../model-selector.js") as any;
  mockResolveModelPlanCell.mockImplementation(async (_repo: string, _ref: unknown, phase: string, fallback: any = {}) => {
    const selection = selector.getProviderSelectionForItem(fallback.labels ?? [], { requiresMcp: fallback.requiresMcp });
    const tier = fallback.tier ?? ({ "plan": "fable", "plan-refine": "opus" } as Record<string, string>)[phase] ?? "sonnet";
    return { ...selection, tier, model: selector.getModel(tier, selection.provider), source: "default", tierSource: "default", providerSource: "default" };
  });
  mockSetSuggestedPlan.mockResolvedValue(undefined);
  return { ...actual, resolveModelPlanCell: mockResolveModelPlanCell, setSuggestedPlan: mockSetSuggestedPlan };
});

vi.mock("../model-selector.js", () => ({ getModel: mockGetModel, getProviderSelectionForItem: () => ({ provider: "claude", strictProvider: false, eligibleProviders: [{ provider: "claude", weight: 4 }] }) }));

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
    getIssueComments: vi.fn().mockResolvedValue([]),
    isClawsComment: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    stripClawsMarker: vi.fn((body: string) => body),
    getPRCheckStatus: vi.fn().mockResolvedValue("passing"),
    getPRMergeableState: vi.fn().mockResolvedValue("MERGEABLE"),
  },
  mockClaude: {
    withExistingWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn(),
    getHeadSha: vi.fn().mockResolvedValue("newsha\n"),
    regeneratePRDescription: vi.fn(),
    writeClawsMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    writeAgentMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    readRepoAgentDoc: vi.fn().mockReturnValue(undefined),
    getCommitCount: vi.fn().mockResolvedValue(1),
    getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 1, insertions: 10, deletions: 5 }),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskProvider: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    recordCIFixerPush: vi.fn(),
    markPRReviewAddressed: vi.fn(async () => {}),
    markPRReviewAdvisoryAddressed: vi.fn(async () => {}),
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

vi.mock("../github.js", () => ({ getLinkedIssueNumber: () => null, normalizeBotLogin: (l: string) => l, ...mockGh, ADDRESSED_REACTION: "rocket", ADVISORY_ADDRESSED_MARKER: "advisory-addressed", ADDRESSER_COMMENT_MARKER: "review-addresser-summary" }));
vi.mock("../claude.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claude.js")>();
  return { ...mockClaude, AgentCliError: actual.AgentCliError };
});
vi.mock("../db.js", () => mockDb);
const { mockMarkAwaitingMerge, mockMarkAwaitingReview } = vi.hoisted(() => ({
  mockMarkAwaitingMerge: vi.fn(async () => {}),
  mockMarkAwaitingReview: vi.fn(async () => {}),
}));
vi.mock("../pr-state.js", () => ({ markPrAwaitingMerge: mockMarkAwaitingMerge, markPrAwaitingReview: mockMarkAwaitingReview }));

import { processPR, isBenignNoChangeOutput, claimsFix, NO_COMMIT_REREVIEW_NOTE } from "./review-addresser.js";
import { AgentCliError } from "../claude.js";
import * as log from "../log.js";
import { OversizedPushError } from "../push-guard.js";
import { SECURITY_POLICY_VERIFICATION_CONTEXT } from "../security-contract.js";


/** HEAD-movement stand-in for the old hasNewCommits mock: the harness compares the head SHA before and after the agent runs. */
function setCommits(moved: boolean): void {
  mockClaude.getHeadSha.mockReset();
  if (moved) mockClaude.getHeadSha.mockResolvedValueOnce("startsha\n").mockResolvedValue("newsha\n");
  else mockClaude.getHeadSha.mockResolvedValue("startsha\n");
}

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
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.isClawsComment.mockReturnValue(false);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.addReviewCommentReaction.mockResolvedValue(undefined);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.updatePR.mockResolvedValue(undefined);
    mockGh.getPRBody.mockResolvedValue("");
    mockClaude.withExistingWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("");
    setCommits(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.getHeadSha.mockResolvedValue("newsha\n");
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nUpdated");
  });

  it("records its push as a Claws push so the ci-fixer breaker doesn't count it as manual intervention", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(true);

    await processPR(repo, pr, reviewData);

    expect(mockDb.recordCIFixerPush).toHaveBeenCalledWith(repo.fullName, pr.number, "newsha");
  });

  it("does not record a Claws push when nothing was pushed", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);

    await processPR(repo, pr, reviewData);

    expect(mockDb.recordCIFixerPush).not.toHaveBeenCalled();
  });

  it("happy path — creates worktree, pushes changes, reacts, does NOT mark awaiting merge label or post comment", async () => {
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

  it("no new commits, no issues — marks awaiting merge label without posting comment", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("   ");

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
    expect(mockGh.updatePR).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockMarkAwaitingMerge).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  /** A Forgejo comment edit carrying a review stamp — the stamps now live on `pr_reviews`. */
  function stampEdits(): unknown[][] {
    return mockGh.editIssueComment.mock.calls.filter(([, , body]) => /review-addressed|review-rebutted|advisory-addressed/.test(String(body)));
  }

  it("asks for a same-head re-review with the fixed note when a blocking round ends with no commit and no output", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const reviewSha = "abc123def456";
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("   ");

    await processPR(repo, pr, { ...reviewData, prReview: { headSha: reviewSha, verdict: "blocking" as const } });

    expect(mockDb.markPRReviewAddressed).toHaveBeenCalledWith(repo.fullName, pr.number, reviewSha, {
      addressedSha: "startsha", rebutted: true, rebuttal: NO_COMMIT_REREVIEW_NOTE, summary: null,
    });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("requested a same-head re-review"), expect.objectContaining({ prNumber: pr.number }));
    expect(mockDb.markPRReviewAdvisoryAddressed).not.toHaveBeenCalled();
    expect(stampEdits()).toEqual([]);
    expect(mockMarkAwaitingMerge).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("marks the review round rebutted with the trimmed output when the addresser declines with no commits", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const reviewSha = "abc123def456";
    setCommits(false);
    const output = "I did not make the change the automated review requested — the review's blocking claim is factually wrong.";
    mockClaude.runClaude.mockResolvedValue(`  ${output}\n`);

    await processPR(repo, pr, { ...reviewData, prReview: { headSha: reviewSha, verdict: "blocking" as const } });

    expect(mockDb.markPRReviewAddressed).toHaveBeenCalledWith(repo.fullName, pr.number, reviewSha, {
      addressedSha: "startsha", rebutted: true, rebuttal: output, summary: output,
    });
    expect(stampEdits()).toEqual([]);
    expect(mockMarkAwaitingMerge).not.toHaveBeenCalled();
  });

  it("caps the stored rebuttal at 6,000 characters", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("I did not make the change: " + "x".repeat(10_000));

    await processPR(repo, pr, { ...reviewData, prReview: { headSha: "abc", verdict: "blocking" as const } });

    const state = (mockDb.markPRReviewAddressed.mock.calls[0] as unknown[])[3] as { rebuttal: string };
    expect(state.rebuttal).toHaveLength(6000);
  });

  it("marks a blocking round rebutted with its output when benign no-change text ends it without a commit", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const reviewSha = "abc123def456";
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("Already addressed: edited the PR description to add the Testing section.");

    await processPR(repo, pr, { ...reviewData, prReview: { headSha: reviewSha, verdict: "blocking" as const } });

    expect(mockDb.markPRReviewAddressed).toHaveBeenCalledWith(repo.fullName, pr.number, reviewSha, expect.objectContaining({
      rebutted: true, rebuttal: "Already addressed: edited the PR description to add the Testing section.",
    }));
  });

  it("marks the round addressed at the pushed head when commits are pushed, never rebutted", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const reviewSha = "abc123def456";
    setCommits(true);
    mockClaude.runClaude.mockResolvedValue("Could not apply one suggestion");

    await processPR(repo, pr, { ...reviewData, prReview: { headSha: reviewSha, verdict: "blocking" as const } });

    expect(mockDb.markPRReviewAddressed).toHaveBeenCalledWith(repo.fullName, pr.number, reviewSha, {
      addressedSha: "newsha", rebutted: false, rebuttal: null,
      summary: "Could not apply one suggestion\n\nClaws pushed `newsha` to `claws/fix-123`.",
    });
    expect(stampEdits()).toEqual([]);
  });

  it("stores the posted summary on the round — the exact text of the addresser comment, without its marker", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const reviewSha = "abc123def456";
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("I fixed the null check, but I did not make the change: the finding is wrong.");

    await processPR(repo, pr, { ...reviewData, prReview: { headSha: reviewSha, verdict: "blocking" as const } });

    const state = (mockDb.markPRReviewAddressed.mock.calls[0] as unknown[])[3] as { summary: string };
    expect(state.summary).toMatch(/^\*\*No commit was pushed in this round\.\*\*/);
    const posted = String(mockGh.commentOnIssue.mock.calls[0][2]);
    expect(posted).toBe(`${state.summary}\n\nreview-addresser-summary`);
  });

  it("marks nothing when there is no Claws review round to address", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("   ");

    await processPR(repo, pr, reviewData);

    expect(mockDb.markPRReviewAddressed).not.toHaveBeenCalled();
    expect(mockDb.markPRReviewAdvisoryAddressed).not.toHaveBeenCalled();
  });

  describe("advisory rounds (#2230)", () => {
    const reviewSha = "abc123def456";
    const advisoryReviewData = {
      ...reviewData,
      commentIds: [],
      reviewCommentIds: [],
      prReview: { headSha: reviewSha, verdict: "advisory" as const },
      advisoryOnly: true,
    };

    it("frames the findings as optional polish in the prompt", async () => {
      const pr = mockPR({ headRefName: "claws/fix-123" });

      await processPR(repo, pr, advisoryReviewData);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("ADVISORY ONLY");
      expect(prompt).toContain("keep the diff minimal and low-risk");
    });

    it("records the advisory fix round at the pushed head when commits were pushed", async () => {
      const pr = mockPR({ headRefName: "claws/fix-123" });
      setCommits(true);

      await processPR(repo, pr, advisoryReviewData);

      expect(mockDb.markPRReviewAdvisoryAddressed).toHaveBeenCalledWith(repo.fullName, pr.number, reviewSha, "newsha");
      expect(mockDb.markPRReviewAddressed).toHaveBeenCalledWith(repo.fullName, pr.number, reviewSha, expect.objectContaining({ addressedSha: "newsha" }));
      expect(stampEdits()).toEqual([]);
    });

    it("records the advisory fix round and marks awaiting merge when no commits and no output", async () => {
      const pr = mockPR({ headRefName: "claws/fix-123" });
      setCommits(false);
      mockClaude.runClaude.mockResolvedValue("   ");

      await processPR(repo, pr, advisoryReviewData);

      expect(mockDb.markPRReviewAdvisoryAddressed).toHaveBeenCalledWith(repo.fullName, pr.number, reviewSha, "startsha");
      expect(mockDb.markPRReviewAddressed).toHaveBeenCalledWith(repo.fullName, pr.number, reviewSha, expect.objectContaining({ rebutted: false }));
      expect(stampEdits()).toEqual([]);
      expect(mockMarkAwaitingMerge).toHaveBeenCalledWith(repo.fullName, pr.number);
    });

    it("does not step the PR back to awaiting review when no commits are pushed", async () => {
      const pr = mockPR({ headRefName: "claws/fix-123" });
      setCommits(false);
      mockClaude.runClaude.mockResolvedValue("   ");

      await processPR(repo, pr, advisoryReviewData);

      expect(mockMarkAwaitingReview).not.toHaveBeenCalled();
    });

    it("steps the PR back to awaiting review when commits are pushed, so pr-reviewer re-verifies the fresh HEAD", async () => {
      const pr = mockPR({ headRefName: "claws/fix-123" });
      setCommits(true);

      await processPR(repo, pr, advisoryReviewData);

      expect(mockMarkAwaitingReview).toHaveBeenCalledWith(repo.fullName, pr.number);
    });
  });

  it("no new commits with issue output — posts comment but does NOT mark awaiting merge label", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("Could not implement suggestion: the function does not exist");

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("Could not implement suggestion: the function does not exist"),
      { agentName: "Review Addresser" },
    );
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("commits pushed with issue output — posts comment, does not mark awaiting merge", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(true);
    mockClaude.runClaude.mockResolvedValue("Note: one suggestion could not be applied");

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("Note: one suggestion could not be applied"),
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

  it("does not fetch image context for PR review comments", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const imgReviewData = {
      formatted: "Fix this ![screenshot](https://example.com/review.png)",
      commentIds: [101],
      reviewCommentIds: [],
      htmlBodies: [`<p>Fix this <img src="https://private-user-images.githubusercontent.com/x.png?jwt=tok"></p>`],
    };

    await processPR(repo, pr, imgReviewData);

    const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(prompt).not.toContain("## Attached Images");
  });

  it("takes the tier from the review round's recorded recommended model, not the comment text", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGetModel.mockReturnValueOnce("opus");

    await processPR(repo, pr, {
      ...reviewData,
      formatted: `${reviewData.formatted}\nrecommended-model: haiku`,
      prReview: { headSha: "abc", verdict: "blocking" as const, recommendedModel: "opus" },
    });

    expect(mockResolveModelPlanCell.mock.calls[0][3]).toMatchObject({ tier: "opus" });
    expect(mockGetModel).toHaveBeenCalledWith("opus", "claude");
    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/worktree",
      expect.objectContaining({ model: "opus" }),
    );
  });

  it("falls back to sonnet when the round recorded no recommended model", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGetModel.mockReturnValueOnce("sonnet");

    await processPR(repo, pr, { ...reviewData, formatted: "recommended-model: opus", prReview: { headSha: "abc", verdict: "blocking" as const, recommendedModel: null } });

    expect(mockGetModel).toHaveBeenCalledWith("sonnet", "claude");
    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/worktree",
      expect.objectContaining({ model: "sonnet" }),
    );
    expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "sonnet");
  });

  it("records the actual provider and model used after provider fallback", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGetModel.mockReturnValueOnce("sonnet");
    mockClaude.runClaude.mockImplementationOnce(async (_prompt: string, _wtPath: string, options: {
      onProviderUsed?: (provider: string) => void;
      onAttemptModelUsed?: (provider: string, model: string | null) => void;
    }) => {
      options.onProviderUsed?.("codex");
      options.onAttemptModelUsed?.("codex", "gpt-5.5-codex");
      return "";
    });

    await processPR(repo, pr, reviewData);

    expect(mockDb.updateTaskProvider).toHaveBeenCalledWith(1, "codex", undefined);
    expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "gpt-5.5-codex");
  });

  it("defaults to sonnet when there is no Claws review round", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGetModel.mockReturnValueOnce("sonnet");

    await processPR(repo, pr, reviewData);

    expect(mockGetModel).toHaveBeenCalledWith("sonnet", "claude");
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

  it("push failure — task recorded as failed, no comment, no reactions, not marked awaiting merge", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(true);
    mockClaude.runClaude.mockResolvedValue("I fixed findings A, B and D in one commit.");
    mockClaude.pushBranch.mockRejectedValue(new Error("git push -u origin HEAD:claws/fix-123 failed in /wt: fatal: could not read Username for 'https://github.com'"));

    await expect(processPR(repo, pr, reviewData)).rejects.toThrow("could not read Username");

    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("could not read Username"), expect.anything());
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockGh.addReaction).not.toHaveBeenCalled();
    expect(mockGh.addReviewCommentReaction).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockMarkAwaitingMerge).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).not.toHaveBeenCalled();
  });

  it("refused push — comments the refusal on the PR, then fails the run", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(true);
    mockClaude.runClaude.mockResolvedValue("Done.");
    const refused = new OversizedPushError("claws/fix-123", [{ path: "core", bytes: 4096, reason: "core-dump", commit: "c1" }], 5 * 1024 * 1024);
    mockClaude.pushBranch.mockRejectedValue(refused);

    await expect(processPR(repo, pr, reviewData)).rejects.toBe(refused);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("## Push refused\n\nPush of claws/fix-123 refused: `core` (4.0 KB) is a core dump."),
      { agentName: "Review Addresser" },
    );
    expect(mockDb.recordTaskComplete).not.toHaveBeenCalled();
  });

  it("successful push appends the pushed commit even when the agent claims the push failed", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(true);
    mockClaude.getHeadSha.mockReset();
    mockClaude.getHeadSha.mockResolvedValueOnce("startsha\n").mockResolvedValue("e304b44c1234567890\n");
    mockClaude.runClaude.mockResolvedValue("I fixed findings A, B and D in one commit, but the push failed: git could not read a GitHub username");

    await processPR(repo, pr, reviewData);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("Claws pushed `e304b44` to `claws/fix-123`"),
      { agentName: "Review Addresser" },
    );
  });

  it("agent pushed itself — harness still pushes and records, no review stamp edit", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(true);
    mockClaude.hasNewCommits.mockResolvedValue(false); // must not be consulted
    const reviewDataWithComment = {
      ...reviewData,
      prReview: { headSha: "abc123def456", verdict: "blocking" as const },
    };

    await processPR(repo, pr, reviewDataWithComment);

    expect(mockClaude.hasNewCommits).not.toHaveBeenCalled();
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockDb.recordCIFixerPush).toHaveBeenCalled();
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("prompt carries a <security> block with the verification paragraph", async () => {
    await processPR(repo, mockPR({ headRefName: "claws/fix-123" }), reviewData);

    const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("<security>");
    expect(prompt).toContain(SECURITY_POLICY_VERIFICATION_CONTEXT);
  });

  it("prompt tells the agent not to push", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });

    await processPR(repo, pr, reviewData);

    expect(mockClaude.runClaude.mock.calls[0][0]).toContain("Do NOT push");
  });

  it("prompt tells the agent to claim a fix only after committing it", async () => {
    await processPR(repo, mockPR({ headRefName: "claws/fix-123" }), reviewData);

    expect(mockClaude.runClaude.mock.calls[0][0]).toContain("Describe a finding as fixed only after `git log` in this worktree shows your commit for it");
  });

  it("no commit but the output claims a fix — says no commit was pushed and keeps the declined stamps", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    const reviewSha = "abc123def456";
    const reviewDataWithComment = {
      ...reviewData,
      prReview: { headSha: reviewSha, verdict: "blocking" as const },
    };
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("Finding 1: fixed by guarding the null case.");

    await processPR(repo, pr, reviewDataWithComment);

    const posted = mockGh.commentOnIssue.mock.calls[0][2] as string;
    expect(posted.startsWith("**No commit was pushed in this round.** HEAD is still `startsh`, so any finding below that needs a code change is still open; the reviewer will re-check the rest on this head.\n\nFinding 1: fixed")).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("output claims a fix but no commit was made"));
    expect(mockDb.markPRReviewAddressed).toHaveBeenCalledWith(repo.fullName, pr.number, reviewSha, expect.objectContaining({ rebutted: true }));
    expect(mockMarkAwaitingMerge).not.toHaveBeenCalled();
  });

  it("does not add the no-commit line when a commit was pushed or the output claims no fix", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(true);
    mockClaude.runClaude.mockResolvedValue("Finding 1: fixed, but one suggestion could not be applied.");
    await processPR(repo, pr, reviewData);
    expect(mockGh.commentOnIssue.mock.calls[0][2]).not.toContain("No commit was pushed");

    mockGh.commentOnIssue.mockClear();
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("Could not implement suggestion: the function does not exist");
    await processPR(repo, pr, reviewData);
    expect(mockGh.commentOnIssue.mock.calls[0][2]).not.toContain("No commit was pushed");
  });

  it("posts the agent's answer when a question is answered with a commit", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(true);
    mockClaude.runClaude.mockResolvedValue("Yes — I switched to the cached lookup in commit abc123 as you asked.");

    await processPR(repo, pr, reviewData);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("Yes — I switched to the cached lookup in commit abc123 as you asked."),
      { agentName: "Review Addresser" },
    );
  });

  it("rolling addresser comment — edits the existing marked comment instead of posting a new one", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("Could not apply one suggestion — the helper was removed.");
    // A prior rolling addresser summary already exists on the PR.
    mockGh.isClawsComment.mockReturnValue(true);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 555, body: "Earlier addresser summary\n\nreview-addresser-summary", login: "clawsbot[bot]", body_html: "" },
    ]);

    await processPR(repo, pr, reviewData);

    expect(mockGh.editIssueComment).toHaveBeenCalledWith(
      repo.fullName,
      555,
      expect.stringContaining("review-addresser-summary"),
      { agentName: "Review Addresser" },
    );
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("warns on pathologically large output while still posting it", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("x".repeat(100_001));

    await processPR(repo, pr, reviewData);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[review-addresser]"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`${repo.fullName}#${pr.number}`));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("100001"));
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("review-addresser-summary"),
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

  it("preserves the manual-action section from the existing PR body", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    mockGh.getPRBody.mockResolvedValue(
      "Some content\n\nCloses #5\n\n## ⚠️ Manual action required before merge\n\nSet the FOO_SECRET env var in prod",
    );

    await processPR(repo, pr, reviewData);

    expect(mockGh.updatePR).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      "## Summary\nUpdated\n\nCloses #5\n\n## ⚠️ Manual action required before merge\n\nSet the FOO_SECRET env var in prod",
    );
  });

  it("benign no-change output with CI passing — marks awaiting merge label", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("The nit was already addressed in an earlier commit; no further changes needed.");
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

    await processPR(repo, pr, reviewData);

    expect(mockMarkAwaitingMerge).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("benign no-change output with CI failing — does NOT mark awaiting merge label", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("This was already addressed. No changes needed.");
    mockGh.getPRCheckStatus.mockResolvedValue("failing");
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

    await processPR(repo, pr, reviewData);

    expect(mockMarkAwaitingMerge).not.toHaveBeenCalled();
  });

  it("benign no-change output with merge conflict — does NOT mark awaiting merge label", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("This was already addressed. No changes needed.");
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");

    await processPR(repo, pr, reviewData);

    expect(mockMarkAwaitingMerge).not.toHaveBeenCalled();
  });

  it("non-benign output — does NOT mark awaiting merge label even with CI passing", async () => {
    const pr = mockPR({ headRefName: "claws/fix-123" });
    setCommits(false);
    mockClaude.runClaude.mockResolvedValue("I was unable to apply this change because the file no longer exists.");
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

    await processPR(repo, pr, reviewData);

    expect(mockMarkAwaitingMerge).not.toHaveBeenCalled();
  });
});

describe("isBenignNoChangeOutput", () => {
  it("returns true for already-addressed nit message", () => {
    expect(isBenignNoChangeOutput("The dead-code spread was already removed in commit 2222c3d. No further changes are needed.")).toBe(true);
  });

  it("returns true for short already-addressed confirmation", () => {
    expect(isBenignNoChangeOutput("This was already addressed.")).toBe(true);
  });

  it("returns true for not-applicable confirmation", () => {
    expect(isBenignNoChangeOutput("No changes needed — the suggestion is not applicable.")).toBe(true);
  });

  it("returns true for false-positive confirmation", () => {
    expect(isBenignNoChangeOutput("False positive; the code is already correct.")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isBenignNoChangeOutput("")).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(isBenignNoChangeOutput("   ")).toBe(false);
  });

  it("returns false when implementation was blocked", () => {
    expect(isBenignNoChangeOutput("I could not implement this because the API does not expose that field.")).toBe(false);
  });

  it("returns false when output contains left-unchanged signal", () => {
    expect(isBenignNoChangeOutput("Why did you choose X? Because Y, but I left it unchanged for now.")).toBe(false);
  });

  it("returns false for error output", () => {
    expect(isBenignNoChangeOutput("Encountered an error running the build.")).toBe(false);
  });

  it("returns false when manual review is required", () => {
    expect(isBenignNoChangeOutput("This requires manual review.")).toBe(false);
  });
});

describe("claimsFix", () => {
  it("matches fix claims on word boundaries only", () => {
    expect(claimsFix("Finding 2 is resolved.")).toBe(true);
    expect(claimsFix("Implemented the guard and committed it.")).toBe(true);
    expect(claimsFix("This finding is NOT fixed: the API is missing.")).toBe(true);
    expect(claimsFix("The prefix-check is unchanged; I could not reproduce it.")).toBe(false);
  });
});
