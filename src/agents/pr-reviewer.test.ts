import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";
import { CLAWS_VISIBLE_HEADER } from "../github.js";

const mockConfigValues = vi.hoisted(() => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    manualAction: "Manual Action",
  },
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  HOME_ASSISTANT_CONFIG_REPO: "",
}));

vi.mock("../config.js", () => mockConfigValues);
vi.mock("../model-selector.js", () => ({
  getModel: () => "sonnet",
  getReviewModel: (tier?: string, provider?: string) => provider === "claude" ? `claude-${tier ?? "sonnet"}` : (tier ?? "sonnet"),
}));

const mockGetItemTimeoutMs = vi.hoisted(() => vi.fn().mockReturnValue(undefined));
vi.mock("../timeout-handler.js", () => ({
  getItemTimeoutMs: mockGetItemTimeoutMs,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    getIssueComments: vi.fn(),
    getIssueBody: vi.fn(),
    getPRHeadSHA: vi.fn(),
    commentOnIssue: vi.fn(),
    editIssueComment: vi.fn(),
    addLabel: vi.fn(),
    getPRCheckStatus: vi.fn(),
    getPRMergeableState: vi.fn(),
    getPRChangedFiles: vi.fn().mockResolvedValue([]),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    isClawsComment: vi.fn(),
    isForkPR: vi.fn().mockReturnValue(false),
    getCommentReactions: vi.fn().mockResolvedValue([]),
    stripClawsMarker: vi.fn(),
  },
  mockClaude: {
    withExistingWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    git: vi.fn(),
    writeClawsMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    readRepoAgentDoc: vi.fn().mockReturnValue(undefined),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
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

vi.mock("../github.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../github.js")>();
  return {
    ...original,
    ...mockGh,
  };
});
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import { processPR, hasNewCommitsSinceLastReview, getReviewHistory, extractRecommendedModel, extractPRReviewModel, maybeAddReadyLabel, buildReviewContext, changedFilesFromDiff, selectRelevantDocs, extractKeywordTokens, buildIssueContext, isNoActionableReview, isAdvisoryOnlyReview } from "./pr-reviewer.js";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

function makeReviewBody(commitSha?: string, iteration = 1): string {
  const marker = commitSha ? `\nReviewed commit: \`${commitSha}\`` : "";
  return `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #${iteration}*\n\nLooks good${marker}\nreview-iteration: ${iteration}`;
}

describe("pr-reviewer", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.getIssueBody.mockResolvedValue("");
    mockGh.getPRHeadSHA.mockResolvedValue("abc123def456abc123def456abc123def456abcd");
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.isClawsComment.mockImplementation((body: string) => /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body) || body.includes("<!-- claws-automated -->"));
    mockGh.stripClawsMarker.mockImplementation((body: string) =>
      body.replace("<!-- claws-automated -->", "").replace(/\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/g, "").trim(),
    );
    mockGh.isForkPR.mockReturnValue(false);
    mockClaude.withExistingWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("Found a bug on line 42");
    mockClaude.git.mockResolvedValue("diff --git a/file.ts b/file.ts\n+some change");
  });

  describe("processPR", () => {
    it("first review — posts new comment with commit SHA and human-readable marker", async () => {
      const pr = mockPR({ headRefName: "feature/new-thing" });

      await processPR(repo, pr);

      expect(mockClaude.withExistingWorktree).toHaveBeenCalledWith(repo, pr.headRefName, "pr-reviewer", expect.any(Function), { detach: true });
      expect(mockClaude.git).toHaveBeenCalledWith(
        ["diff", `origin/${pr.baseRefName}...HEAD`],
        "/tmp/worktree",
        { maxBuffer: 200 * 1024 * 1024 },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("## PR Review"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("Reviewed commit: `abc123def456`"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("*Review #1*"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0, prNumber: 10, prAction: "reviewed" });
    });

    it("subsequent review — edits existing comment instead of posting new", async () => {
      const pr = mockPR({ headRefName: "feature/updated" });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeReviewBody("oldcommit1234") },
      ]);

      await processPR(repo, pr);

      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        42,
        expect.stringContaining("## PR Review"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        42,
        expect.stringContaining("*Review #2*"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("subsequent review — archives the previous round in a collapsed audit log", async () => {
      const pr = mockPR({ headRefName: "feature/updated" });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeReviewBody("oldcommit1234") },
      ]);

      await processPR(repo, pr);

      const bodyArg = mockGh.editIssueComment.mock.calls[0][2] as string;
      // The previous round's visible content is preserved in a collapsed audit log.
      expect(bodyArg).toContain("<details>");
      expect(bodyArg).toContain("Previous review iterations");
      expect(bodyArg).toContain("@@@ ITERATION 1 @@@");
      expect(bodyArg).toContain("Looks good");
    });

    it("archive round-trips — the posted body is parsed back into multi-round history", async () => {
      const pr = mockPR({ headRefName: "feature/roundtrip" });
      mockClaude.runClaude.mockResolvedValue("Round 2 finding on line 20");
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeReviewBody("oldcommit1234") }, // iteration 1, content "Looks good"
      ]);

      await processPR(repo, pr);

      const postedBody = mockGh.editIssueComment.mock.calls[0][2] as string;

      // Feed the freshly-posted body back into getReviewHistory — it must recover both rounds.
      // (editIssueComment prepends the Claws header itself; the mock doesn't, so add it here.)
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: `${CLAWS_VISIBLE_HEADER}\n\n${postedBody}` }]);
      const history = await getReviewHistory(repo.fullName, pr.number);
      expect(history.count).toBe(2);
      expect(history.previousFeedback).toHaveLength(2);
      expect(history.previousFeedback[0]).toContain("Looks good");
      expect(history.previousFeedback[1]).toContain("Round 2 finding on line 20");
    });

    it("advisory-only review — records with advisory marker and adds Ready without another round", async () => {
      const pr = mockPR({ headRefName: "feature/advisory" });
      mockClaude.runClaude.mockResolvedValue("Minor nit on line 5\nseverity: advisory");
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      await processPR(repo, pr);

      const bodyArg = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(bodyArg).toContain("review-result: advisory");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "Manual Action");
    });

    it("round cap — escalates to human with Manual Action label after too many rounds", async () => {
      const pr = mockPR({ headRefName: "feature/stuck" });
      mockClaude.runClaude.mockResolvedValue("Yet another finding on line 99");
      // Existing review at iteration 8 → nextIteration 9 > MAX_REVIEW_ITERATIONS (8).
      mockGh.getIssueComments.mockResolvedValue([
        { id: 7, body: `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #8*\n\nEarlier finding\nReviewed commit: \`oldcommit1234\`\nreview-iteration: 8` },
      ]);

      await processPR(repo, pr);

      const bodyArg = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(bodyArg).toContain("Escalated to human review");
      expect(bodyArg).toContain("review-result: escalated");
      expect(bodyArg).not.toContain("review-result: advisory");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Manual Action");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    });

    it("round cap — does NOT escalate when the review is advisory-only (converged, not stuck)", async () => {
      const pr = mockPR({ headRefName: "feature/converged-late" });
      mockClaude.runClaude.mockResolvedValue("Minor nit on line 99\nseverity: advisory");
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
      // Existing review at iteration 8 → nextIteration 9 > MAX_REVIEW_ITERATIONS (8).
      mockGh.getIssueComments.mockResolvedValue([
        { id: 7, body: `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #8*\n\nEarlier finding\nReviewed commit: \`oldcommit1234\`\nreview-iteration: 8` },
      ]);

      await processPR(repo, pr);

      const bodyArg = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(bodyArg).not.toContain("Escalated to human review");
      expect(bodyArg).toContain("review-result: advisory");
      expect(bodyArg).not.toContain("review-result: escalated");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "Manual Action");
    });

    it("no-issues-found — adds Ready label when CI passing and no conflicts", async () => {
      const pr = mockPR({ headRefName: "feature/clean" });
      mockClaude.runClaude.mockResolvedValue("review-result: clean");
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("no issues found"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("Reviewed commit: `abc123def456`"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0, prNumber: 10, prAction: "reviewed" });
    });

    it("no-issues-found — does NOT add Ready label when CI is pending", async () => {
      const pr = mockPR({ headRefName: "feature/clean" });
      mockClaude.runClaude.mockResolvedValue("review-result: clean");
      mockGh.getPRCheckStatus.mockResolvedValue("pending");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("no issues found"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("no-issues-found — does NOT add Ready label when PR has merge conflicts", async () => {
      const pr = mockPR({ headRefName: "feature/clean" });
      mockClaude.runClaude.mockResolvedValue("review-result: clean");
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("no issues found"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("no-issues-found — does NOT throw when getPRCheckStatus fails transiently, still records task complete", async () => {
      const pr = mockPR({ headRefName: "feature/clean" });
      mockClaude.runClaude.mockResolvedValue("review-result: clean");
      mockGh.getPRCheckStatus.mockRejectedValue(new Error("gh pr checks failed: HTTP 401: Requires authentication"));

      await expect(processPR(repo, pr)).resolves.toBeUndefined();

      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0, prNumber: pr.number, prAction: "reviewed" });
    });

    it("posts no-issues-found review when Claude returns empty output and adds Ready label", async () => {
      const pr = mockPR({ headRefName: "feature/clean" });
      mockClaude.runClaude.mockResolvedValue("  ");

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("no issues found"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("Reviewed commit: `abc123def456`"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("treats trailing review-result: clean with preamble as clean", async () => {
      const pr = mockPR({ headRefName: "feature/clean-preamble" });
      mockClaude.runClaude.mockResolvedValue(
        "The dependency is genuinely unused as a direct import; XRControllerModelFactory uses Three's bundled copy.\n\nreview-result: clean",
      );
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("no issues found"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("Reviewed commit: `abc123def456`"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0, prNumber: 10, prAction: "reviewed" });
    });

    it("does not treat old 'Reviewed — no issues found.' phrase as clean", async () => {
      const pr = mockPR({ headRefName: "feature/clean-phrase" });
      mockClaude.runClaude.mockResolvedValue("Reviewed — no issues found.");

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("Reviewed — no issues found."),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does not treat marker embedded mid-line as clean", async () => {
      const pr = mockPR({ headRefName: "feature/inline-marker" });
      mockClaude.runClaude.mockResolvedValue("We found issue X. review-result: clean on the same line");

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("We found issue X."),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("posts empty-diff review when PR has no net changes, does not add Ready label", async () => {
      const pr = mockPR({ headRefName: "feature/empty" });
      mockClaude.git.mockResolvedValue("   ");

      await processPR(repo, pr);

      expect(mockClaude.runClaude).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("## PR Review"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("no net changes"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("Reviewed commit: `abc123def456`"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("injects human comments into the review prompt, excluding bots and claws comments", async () => {
      const pr = mockPR({ headRefName: "feature/branch" });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "Please keep the old API surface", login: "alice" },
        { id: 2, body: "<!-- claws-automated -->\n## PR Review\n\nIssue found.", login: "claws-bot" },
        { id: 3, body: "Use snake_case here", login: "dependabot[bot]" },
      ]);
      mockClaude.runClaude.mockResolvedValueOnce("NO_ISSUES_FOUND");

      await processPR(repo, pr);

      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("Human reviewer comments on this PR");
      expect(promptArg).toContain("alice");
      expect(promptArg).toContain("Please keep the old API surface");
      expect(promptArg).not.toContain("claws-bot");
      expect(promptArg).not.toContain("dependabot[bot]");
    });

    it("passes per-item timeout to runClaude", async () => {
      const pr = mockPR({ headRefName: "feature/slow" });
      mockGetItemTimeoutMs.mockReturnValueOnce(7_200_000);

      await processPR(repo, pr);

      expect(mockGetItemTimeoutMs).toHaveBeenCalledWith(repo.fullName, pr.number);
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ timeoutMs: 7_200_000 }),
      );
    });

    it("skips gracefully when branch no longer exists (merged/closed)", async () => {
      const pr = mockPR({ headRefName: "dependabot/npm/lodash-4.0" });
      mockClaude.withExistingWorktree.mockResolvedValue(null);

      await processPR(repo, pr);

      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, {
        commits: 0,
        prNumber: pr.number,
        prAction: "skipped",
      });
      expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
    });

    it("error handling — records failure and throws", async () => {
      const pr = mockPR({ headRefName: "feature/broken" });
      mockClaude.runClaude.mockRejectedValue(new Error("claude timeout"));

      await expect(processPR(repo, pr)).rejects.toThrow("claude timeout");

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude timeout"), expect.any(Object));
    });

    it("uses sonnet model for dependabot PRs", async () => {
      const pr = mockPR({ headRefName: "dependabot/npm_and_yarn/lodash-4.17.21", author: { login: "dependabot[bot]" } });

      await processPR(repo, pr);

      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "claude-sonnet" }),
      );
      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "claude-sonnet");
    });

    it("uses config default (sonnet) when no review-model marker in PR body", async () => {
      const pr = mockPR({ headRefName: "feature/new-thing", author: { login: "testuser" }, body: "No marker here" });

      await processPR(repo, pr);

      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "claude-sonnet" }),
      );
    });

    it("uses sonnet model when PR body contains review-model: sonnet marker", async () => {
      const pr = mockPR({ headRefName: "feature/simple-fix", author: { login: "testuser" }, body: "Simple fix\n\nreview-model: sonnet" });

      await processPR(repo, pr);

      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "claude-sonnet" }),
      );
      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "claude-sonnet");
    });

    it("uses opus model when PR body contains review-model: opus marker", async () => {
      const pr = mockPR({ headRefName: "feature/complex", author: { login: "testuser" }, body: "Complex change\n\nreview-model: opus" });

      await processPR(repo, pr);

      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "claude-opus" }),
      );
    });

    it("falls back to config default when PR body is undefined", async () => {
      const pr = mockPR({ headRefName: "feature/no-body", author: { login: "testuser" }, body: undefined });

      await processPR(repo, pr);

      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "claude-sonnet" }),
      );
    });

    it("always uses claude provider regardless of prompt size", async () => {
      const pr = mockPR({ headRefName: "feature/any-size" });

      await processPR(repo, pr);

      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ provider: "claude" }),
      );
    });

    it("includes model recommendation instructions in prompt", async () => {
      const pr = mockPR({ headRefName: "feature/new-thing" });

      await processPR(repo, pr);

      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("recommended-model");
      expect(promptArg).toContain("review-addresser");
    });

    it("linked issue via PR body — prompt contains issue body and plan", async () => {
      const pr = mockPR({ headRefName: "feature/x", body: "Closes #99" });
      mockGh.getIssueBody.mockResolvedValue("User wants feature X with property Y");
      const planComment = `*— Automated by Claws —*\n\n## Implementation Plan\nAdd Y to module Z`;
      mockGh.getIssueComments.mockImplementation((_repo: string, n: number) =>
        Promise.resolve(n === 99
          ? [{ id: 1, body: planComment, login: "claws[bot]" }]
          : []
        )
      );

      await processPR(repo, pr);

      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("Originating Issue");
      expect(promptArg).toContain("#99");
      expect(promptArg).toContain("User wants feature X");
      expect(promptArg).toContain("Add Y to module Z");
    });

    it("linked issue with refined plan — plan is framed as authoritative and appears before the issue body", async () => {
      const pr = mockPR({ headRefName: "feature/x", body: "Closes #99" });
      mockGh.getIssueBody.mockResolvedValue("User wants feature X with property Y");
      const planComment = `*— Automated by Claws —*\n\n## Implementation Plan\nAdd Y to module Z`;
      mockGh.getIssueComments.mockImplementation((_repo: string, n: number) =>
        Promise.resolve(n === 99
          ? [{ id: 1, body: planComment, login: "claws[bot]" }]
          : []
        )
      );

      await processPR(repo, pr);

      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("AUTHORITATIVE");
      expect(promptArg.toLowerCase()).toContain("refined plan is the authoritative");
      expect(promptArg.indexOf("Add Y to module Z")).toBeLessThan(promptArg.indexOf("User wants feature X"));
    });

    it("linked issue via branch name — fetches and renders issue context", async () => {
      const pr = mockPR({ headRefName: "claws/issue-42-abcd", body: "" });
      mockGh.getIssueBody.mockResolvedValue("This is issue 42 body");

      await processPR(repo, pr);

      expect(mockGh.getIssueBody).toHaveBeenCalledWith(repo.fullName, 42);
      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("Originating Issue");
      expect(promptArg).toContain("#42");
      expect(promptArg).toContain("This is issue 42 body");
    });

    it("no linked issue — prompt does not contain Originating Issue and getIssueBody is not called", async () => {
      const pr = mockPR({ headRefName: "dependabot/npm/foo", body: "" });

      await processPR(repo, pr);

      expect(mockGh.getIssueBody).not.toHaveBeenCalled();
      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).not.toContain("Originating Issue");
    });

    it("issue fetch failure is non-fatal — review still completes without issue context", async () => {
      const pr = mockPR({ headRefName: "feature/x", body: "Closes #5" });
      mockGh.getIssueBody.mockRejectedValue(new Error("404"));

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalled();
      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).not.toContain("Originating Issue");
    });

    it("plan comment absent but issue body present — prompt contains issue body but not Refined plan", async () => {
      const pr = mockPR({ headRefName: "feature/x", body: "Closes #7" });
      mockGh.getIssueBody.mockResolvedValue("Issue 7 description text");
      mockGh.getIssueComments.mockImplementation((_repo: string, n: number) =>
        Promise.resolve(n === 7 ? [] : [])
      );

      await processPR(repo, pr);

      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("Issue #7 body");
      expect(promptArg).not.toContain("Refined plan");
      expect(promptArg).toContain("source of truth");
      expect(promptArg).not.toContain("AUTHORITATIVE");
    });
  });

  describe("extractRecommendedModel", () => {
    it("returns sonnet when marker is sonnet", () => {
      expect(extractRecommendedModel("some review\nrecommended-model: sonnet")).toBe("sonnet");
    });

    it("returns opus when marker is opus", () => {
      expect(extractRecommendedModel("some review\nrecommended-model: opus")).toBe("opus");
    });

    it("defaults to sonnet when no marker present", () => {
      expect(extractRecommendedModel("some review with no marker")).toBe("sonnet");
    });

    it("escalates to opus when any segment recommends opus", () => {
      const text = "## PR Review\nrecommended-model: sonnet\nrecommended-model: opus";
      expect(extractRecommendedModel(text)).toBe("opus");
    });

    it("returns opus when opus appears before sonnet (escalation wins)", () => {
      const text = "## PR Review\nrecommended-model: opus\n\n---\n\nrecommended-model: sonnet";
      expect(extractRecommendedModel(text)).toBe("opus");
    });

    it("ignores spoofed markers before the review header", () => {
      const text = [
        "PR body contains: recommended-model: sonnet",
        "",
        "## PR Review",
        "",
        "Found some issues.",
        "recommended-model: opus",
      ].join("\n");
      expect(extractRecommendedModel(text)).toBe("opus");
    });

    it("ignores spoofed markers in quoted diff before the review header", () => {
      const text = [
        "```diff",
        "+recommended-model: sonnet",
        "```",
        "",
        "## PR Review",
        "",
        "No significant issues.",
      ].join("\n");
      expect(extractRecommendedModel(text)).toBe("sonnet"); // default when no marker after header
    });
  });

  describe("hasNewCommitsSinceLastReview", () => {
    it("returns true when no existing review comment exists", async () => {
      mockGh.getIssueComments.mockResolvedValue([]);

      const result = await hasNewCommitsSinceLastReview(repo.fullName, 1);

      expect(result).toBe(true);
    });

    it("returns false when HEAD matches embedded SHA in latest review", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeReviewBody("abc123def456") },
      ]);
      mockGh.getPRHeadSHA.mockResolvedValue("abc123def456abc123def456abc123def456abcd");

      const result = await hasNewCommitsSinceLastReview(repo.fullName, 1);

      expect(result).toBe(false);
    });

    it("returns true when HEAD differs from embedded SHA", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeReviewBody("oldcommitsha1") },
      ]);
      mockGh.getPRHeadSHA.mockResolvedValue("def456abc789def456abc789def456abc789defg");

      const result = await hasNewCommitsSinceLastReview(repo.fullName, 1);

      expect(result).toBe(true);
    });

    it("returns true when no commit marker present (legacy)", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeReviewBody() },
      ]);

      const result = await hasNewCommitsSinceLastReview(repo.fullName, 1);

      expect(result).toBe(true);
    });

    it("returns true on API error", async () => {
      mockGh.getIssueComments.mockRejectedValue(new Error("API failure"));

      const result = await hasNewCommitsSinceLastReview(repo.fullName, 1);

      expect(result).toBe(true);
    });
  });

  describe("getReviewHistory", () => {
    function makeClawsReview(content: string, commitSha = "abc123def456", iteration = 1): string {
      return `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #${iteration}*\n\n${content}\nReviewed commit: \`${commitSha}\`\nreview-iteration: ${iteration}`;
    }

    it("returns count=0 when no review comments exist", async () => {
      mockGh.getIssueComments.mockResolvedValue([]);

      const result = await getReviewHistory(repo.fullName, 1);

      expect(result).toEqual({ count: 0, previousFeedback: [] });
    });

    it("returns iteration count from the review comment marker", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: makeClawsReview("Bug found on line 10", "abc123def456", 3) },
      ]);

      const result = await getReviewHistory(repo.fullName, 1);

      expect(result.count).toBe(3);
    });

    it("extracts current review content as feedback", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: makeClawsReview("Bug found on line 10") },
      ]);

      const result = await getReviewHistory(repo.fullName, 1);

      expect(result.previousFeedback).toHaveLength(1);
      expect(result.previousFeedback[0]).toContain("Bug found on line 10");
    });

    it("ignores legacy collapsed details blocks, only returns current review content", async () => {
      const body = [
        `${CLAWS_VISIBLE_HEADER}`,
        "",
        "## PR Review",
        "",
        "*Review #2*",
        "",
        "New issue on line 20",
        `Reviewed commit: \`abc123def456\``,
        "review-iteration: 2",
        "",
        "<details>",
        "<summary>Previous review #1</summary>",
        "",
        "Bug found on line 10",
        "</details>",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body }]);

      const result = await getReviewHistory(repo.fullName, 1);

      expect(result.count).toBe(2);
      expect(result.previousFeedback).toHaveLength(1);
      expect(result.previousFeedback[0]).toContain("New issue on line 20");
      expect(result.previousFeedback[0]).not.toContain("Bug found on line 10");
    });

    it("excludes 'no issues found' reviews from feedback", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: makeClawsReview("Reviewed — no issues found.") },
      ]);

      const result = await getReviewHistory(repo.fullName, 1);

      expect(result.previousFeedback).toHaveLength(0);
    });

    it("excludes 'no net changes' reviews from feedback", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: makeClawsReview("This PR has no net changes relative to the base branch") },
      ]);

      const result = await getReviewHistory(repo.fullName, 1);

      expect(result.previousFeedback).toHaveLength(0);
    });

    it("excludes non-Claws comments", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## PR Review\n\nHuman review comment without marker" },
      ]);

      const result = await getReviewHistory(repo.fullName, 1);

      expect(result).toEqual({ count: 0, previousFeedback: [] });
    });

    it("returns feedback bodies stripped of markers and headers", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: makeClawsReview("Bug found on line 10") },
      ]);

      const result = await getReviewHistory(repo.fullName, 1);

      expect(result.previousFeedback[0]).toContain("Bug found on line 10");
      expect(result.previousFeedback[0]).not.toContain(CLAWS_VISIBLE_HEADER);
    });

    it("recovers multiple rounds of feedback from the audit-log archive plus current content", async () => {
      const body = [
        `${CLAWS_VISIBLE_HEADER}`,
        "",
        "## PR Review",
        "",
        "*Review #3*",
        "",
        "Round 3 finding on line 30",
        "Reviewed commit: `abc123def456`",
        "review-iteration: 3",
        "",
        "<details>",
        "<summary>Previous review iterations (audit log — do not edit)</summary>",
        "",
        "@@@ ITERATION 1 @@@",
        "Round 1 finding on line 10",
        "",
        "@@@ ITERATION 2 @@@",
        "Round 2 finding on line 20",
        "",
        "</details>",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body }]);

      const result = await getReviewHistory(repo.fullName, 1);

      expect(result.count).toBe(3);
      expect(result.previousFeedback).toHaveLength(3);
      expect(result.previousFeedback[0]).toContain("Round 1 finding on line 10");
      expect(result.previousFeedback[1]).toContain("Round 2 finding on line 20");
      expect(result.previousFeedback[2]).toContain("Round 3 finding on line 30");
    });
  });

  describe("isAdvisoryOnlyReview", () => {
    it("returns true when every finding is tagged advisory", () => {
      expect(isAdvisoryOnlyReview("Nit on line 10\nseverity: advisory")).toBe(true);
    });

    it("returns false when any finding is tagged blocking", () => {
      expect(isAdvisoryOnlyReview("Bug on line 10\nseverity: blocking\n\nNit on line 20\nseverity: advisory")).toBe(false);
    });

    it("returns false when no severity tags are present (untagged stays blocking)", () => {
      expect(isAdvisoryOnlyReview("Bug found on line 42")).toBe(false);
    });

    it("returns false for empty content", () => {
      expect(isAdvisoryOnlyReview("")).toBe(false);
    });
  });

  describe("extractPRReviewModel", () => {
    it("returns sonnet when marker is sonnet", () => {
      expect(extractPRReviewModel("PR body\n\nreview-model: sonnet")).toBe("sonnet");
    });

    it("returns opus when marker is opus", () => {
      expect(extractPRReviewModel("PR body\n\nreview-model: opus")).toBe("opus");
    });

    it("returns null when no marker present", () => {
      expect(extractPRReviewModel("PR body with no marker")).toBeNull();
    });

    it("uses last match when multiple markers exist", () => {
      const text = "PR body\n\nreview-model: sonnet\n\nreview-model: opus";
      expect(extractPRReviewModel(text)).toBe("opus");
    });
  });

  describe("processPR with reassessment", () => {
    function makeClawsReview(content: string, commitSha = "abc123def456", iteration = 3): string {
      return `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #${iteration}*\n\n${content}\nReviewed commit: \`${commitSha}\`\nreview-iteration: ${iteration}`;
    }

    it("includes reassessment context when review count >= threshold", async () => {
      const pr = mockPR({ headRefName: "feature/struggling" });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: makeClawsReview("Bug on line 10 not fixed", "abc123def456", 3) },
      ]);

      await processPR(repo, pr);

      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("Reassessment needed");
      expect(promptArg).toContain("reviewed 3 times previously");
      expect(promptArg).toContain("Bug on line 10");
      expect(promptArg).toContain("Suggested Approach Change");
    });

    it("does not include reassessment context when below threshold", async () => {
      const pr = mockPR({ headRefName: "feature/early" });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #2*\n\nAnother issue\nReviewed commit: \`abc123def456\`\nreview-iteration: 2` },
      ]);

      await processPR(repo, pr);

      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).not.toContain("Reassessment needed");
    });
  });

  describe("processPR with large diffs", () => {
    it("switches to per-file review when full diff exceeds maxBuffer", async () => {
      const pr = mockPR({ headRefName: "feature/huge-diff" });
      const maxBufferError = new Error("stdout maxBuffer length exceeded");

      // First call (full diff) throws maxBuffer error
      // Second call (--name-only) returns file list
      // Third+ calls (per-file diffs) return small diffs
      mockClaude.git
        .mockRejectedValueOnce(maxBufferError)
        .mockResolvedValueOnce("src/small.ts\nsrc/large.json")
        .mockResolvedValueOnce("diff --git a/src/small.ts\n+small change")
        .mockResolvedValueOnce("diff --git a/src/large.json\n" + "x".repeat(25_000));

      mockClaude.runClaude
        .mockResolvedValueOnce("Schema issue in large.json")
        .mockResolvedValueOnce("Bug on line 5");

      await processPR(repo, pr);

      // Should have called git 4 times: full diff (failed), --name-only, per-file x2
      expect(mockClaude.git).toHaveBeenCalledTimes(4);
      expect(mockClaude.git).toHaveBeenCalledWith(
        ["diff", "--name-only", `origin/${pr.baseRefName}...HEAD`],
        "/tmp/worktree",
        expect.objectContaining({ maxBuffer: expect.any(Number) }),
      );

      // Should have called runClaude twice: once for large file, once for normal files
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);

      // Final review should contain both segments
      const postedBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(postedBody).toContain("Schema issue in large.json");
      expect(postedBody).toContain("Bug on line 5");
    });

    it("switches to per-file review when diff exceeds 50k chars without error", async () => {
      const pr = mockPR({ headRefName: "feature/big-diff" });
      const bigDiff = "diff --git a/file.ts b/file.ts\n" + "x".repeat(60_000);

      mockClaude.git
        .mockResolvedValueOnce(bigDiff); // full diff succeeds but is large; segments parsed in-memory

      mockClaude.runClaude.mockResolvedValueOnce("Found issues");

      await processPR(repo, pr);

      // File segments are extracted from the in-memory diff — no extra git calls at all
      expect(mockClaude.git).toHaveBeenCalledTimes(1);

      // Review should have been posted with the per-file content
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      const postedBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(postedBody).toContain("Found issues");
    });

    it("handles per-file diff exceeding maxBuffer gracefully", async () => {
      const pr = mockPR({ headRefName: "feature/giant-file" });
      const maxBufferError = new Error("stdout maxBuffer length exceeded");

      mockClaude.git
        .mockRejectedValueOnce(maxBufferError) // full diff fails
        .mockResolvedValueOnce("src/giant.bin") // --name-only
        .mockRejectedValueOnce(maxBufferError); // per-file diff also fails

      await processPR(repo, pr);

      const postedBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(postedBody).toContain("Diff too large to review");
      expect(postedBody).toContain("giant.bin");
    });

    it("returns review-result: clean when all per-file reviews are clean", async () => {
      const pr = mockPR({ headRefName: "feature/large-but-clean" });
      const maxBufferError = new Error("stdout maxBuffer length exceeded");

      mockClaude.git
        .mockRejectedValueOnce(maxBufferError)
        .mockResolvedValueOnce("src/a.ts\nsrc/b.ts")
        .mockResolvedValueOnce("diff a\n+small")
        .mockResolvedValueOnce("diff b\n+small");

      mockClaude.runClaude.mockResolvedValue("review-result: clean");

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("no issues found"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    });

    it("treats per-file review with trailing review-result: clean preamble as clean", async () => {
      const pr = mockPR({ headRefName: "feature/large-clean-preamble" });
      const maxBufferError = new Error("stdout maxBuffer length exceeded");

      mockClaude.git
        .mockRejectedValueOnce(maxBufferError)
        .mockResolvedValueOnce("src/a.ts\nsrc/b.ts")
        .mockResolvedValueOnce("diff a\n+small")
        .mockResolvedValueOnce("diff b\n+small");

      mockClaude.runClaude.mockResolvedValue("some reasoning\n\nreview-result: clean");

      await processPR(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("no issues found"),
        { agentName: "Reviewer" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    });

    it("re-throws non-maxBuffer errors from full diff", async () => {
      const pr = mockPR({ headRefName: "feature/broken" });
      mockClaude.git.mockRejectedValueOnce(new Error("git network error"));

      await expect(processPR(repo, pr)).rejects.toThrow("git network error");
    });

    it("re-throws non-maxBuffer errors from per-file diff (isLargePR path)", async () => {
      const pr = mockPR({ headRefName: "feature/broken-perfile" });
      const maxBufferError = new Error("stdout maxBuffer length exceeded");

      mockClaude.git
        .mockRejectedValueOnce(maxBufferError) // full diff fails → isLargePR
        .mockResolvedValueOnce("src/a.ts") // --name-only
        .mockRejectedValueOnce(new Error("git network error")); // per-file diff throws non-maxBuffer error

      await expect(processPR(repo, pr)).rejects.toThrow("git network error");
    });

    it("includes reassessment context in per-file prompt when history.count >= threshold", async () => {
      const pr = mockPR({ headRefName: "feature/large-and-struggling" });
      const maxBufferError = new Error("stdout maxBuffer length exceeded");
      const previousFeedback = "Bug on line 10 was not fixed";

      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #3*\n\n${previousFeedback}\nReviewed commit: \`abc123def456\`\nreview-iteration: 3` },
      ]);

      // Large PR: full diff fails, per-file path
      mockClaude.git
        .mockRejectedValueOnce(maxBufferError) // full diff fails → isLargePR
        .mockResolvedValueOnce("src/large.ts") // --name-only
        .mockResolvedValueOnce("diff --git a/src/large.ts b/src/large.ts\n" + "x".repeat(60_000)); // per-file diff > 50k → classified as large

      mockClaude.runClaude.mockResolvedValueOnce("Style issue found");

      await processPR(repo, pr);

      // The per-file prompt should contain reassessment context
      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("Reassessment needed");
      expect(promptArg).toContain("reviewed 3 times previously");
      expect(promptArg).toContain(previousFeedback);
    });

    it("includes truncation notice in normalDiffs prompt when combined normal diff exceeds 50k chars", async () => {
      const pr = mockPR({ headRefName: "feature/many-normal-files" });

      mockGh.getIssueComments.mockResolvedValue([]);

      // Build a full diff with many small files (each < 20k chars, so classified as normalDiffs)
      // but whose combined length exceeds 50k chars.
      const makeFileDiff = (name: string, size: number) =>
        `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n` + "+".repeat(size);
      const fullDiff = [
        makeFileDiff("src/a.ts", 19_000),
        makeFileDiff("src/b.ts", 19_000),
        makeFileDiff("src/c.ts", 19_000),
      ].join("\n");
      // Combined is ~57k chars, full diff is >50k → triggers per-file path
      expect(fullDiff.length).toBeGreaterThan(50_000);

      mockClaude.git.mockResolvedValueOnce(fullDiff);
      mockClaude.runClaude.mockResolvedValueOnce("NO_ISSUES_FOUND");

      await processPR(repo, pr);

      // The normalDiffs prompt should contain the combined truncation notice
      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("[Note: diff truncated due to combined diff size limit]");
    });

    it("includes truncation notice in per-file prompt when file diff exceeds 50k chars", async () => {
      const pr = mockPR({ headRefName: "feature/large-file" });
      const maxBufferError = new Error("stdout maxBuffer length exceeded");

      mockGh.getIssueComments.mockResolvedValue([]);

      // Large PR: full diff fails, per-file path with diff > 50k
      mockClaude.git
        .mockRejectedValueOnce(maxBufferError) // full diff fails → isLargePR
        .mockResolvedValueOnce("src/large.ts") // --name-only
        .mockResolvedValueOnce("diff --git a/src/large.ts b/src/large.ts\n" + "x".repeat(60_000)); // per-file diff > 50k

      mockClaude.runClaude.mockResolvedValueOnce("review-result: clean");

      await processPR(repo, pr);

      const promptArg = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(promptArg).toContain("[Note: diff truncated due to file size limit]");
    });
  });

  describe("maybeAddReadyLabel", () => {
    function makeNoIssuesReview(commitSha = "abc123def456"): string {
      return `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #1*\n\nReviewed — no issues found.\nReviewed commit: \`${commitSha}\`\nreview-iteration: 1\nreview-result: clean`;
    }

    function makeNoIssuesReviewOldFormat(commitSha = "abc123def456"): string {
      return `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #1*\n\nReviewed — no issues found.\nReviewed commit: \`${commitSha}\`\nreview-iteration: 1`;
    }

    it("adds Ready label when review is clean, CI passing, no conflicts", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeNoIssuesReview() },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(true);
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    it("does not add Ready when CI is pending", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeNoIssuesReview() },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("pending");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(false);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("adds Ready when there are no checks and the PR changes only docs paths", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeNoIssuesReview() },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("none");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
      mockGh.getPRChangedFiles.mockResolvedValueOnce(["docs/postmortems/2026-07-18-incident.md", ".claude/skills/postmortem/SKILL.md"]);

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(true);
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    it("does not add Ready when there are no checks and the PR touches code", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeNoIssuesReview() },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("none");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
      mockGh.getPRChangedFiles.mockResolvedValueOnce(["docs/notes.md", "src/app.ts"]);

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(false);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does not add Ready when there are no checks and changed files are unknown", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeNoIssuesReview() },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("none");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
      mockGh.getPRChangedFiles.mockResolvedValueOnce([]);

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(false);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does not add Ready when PR has merge conflicts", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeNoIssuesReview() },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(false);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does not add Ready when review has issues", async () => {
      const reviewWithIssues = `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #1*\n\nBug on line 10\nReviewed commit: \`abc123def456\`\nreview-iteration: 1`;
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: reviewWithIssues },
      ]);

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(false);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does nothing when no review comment exists", async () => {
      mockGh.getIssueComments.mockResolvedValue([]);

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(false);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("swallows errors gracefully", async () => {
      mockGh.getIssueComments.mockRejectedValue(new Error("API failure"));

      await expect(maybeAddReadyLabel(repo.fullName, 1)).resolves.toBe(false);
    });

    it("falls back to regex for old-format reviews without clean marker", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeNoIssuesReviewOldFormat() },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(true);
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    function makeNoActionableReview(): string {
      // Mirrors the real namey#1454 review-addresser comment body (issue #1494)
      return [
        CLAWS_VISIBLE_HEADER,
        "",
        "## PR Review",
        "",
        "*Review #3*",
        "",
        "The workflow confirmed my findings. The review I already posted is accurate — no changes needed.",
        "",
        "Reviewed commit: `e80183910520`",
        "review-iteration: 3",
        "review-addressed: e80183910520",
      ].join("\n");
    }

    it("adds Ready for a conversational no-change re-review (#1494 case)", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeNoActionableReview() },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(true);
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    it("does not add Ready for conversational no-change re-review when CI is pending", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: makeNoActionableReview() },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("pending");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(false);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does not add Ready for a round-cap-escalated review, even with CI passing and no conflicts", async () => {
      const escalatedReview = `${CLAWS_VISIBLE_HEADER}\n\n## PR Review\n\n*Review #9*\n\n> ⚠️ **Escalated to human review** — this PR has been through 9 review rounds without converging. Automated re-review is paused; a maintainer should decide how to proceed.\n\nYet another finding on line 99\nReviewed commit: \`abc123def456\`\nreview-iteration: 9\nreview-result: escalated`;
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: escalatedReview },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(false);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does not add Ready when a blocking current round has an archived advisory round", async () => {
      // Round 1 was advisory-only and is now archived (marker text intact). Round 2
      // is a fresh blocking review. The archived advisory marker must not leak into
      // the current-round marker check and wrongly make the PR Ready-eligible.
      const body = [
        CLAWS_VISIBLE_HEADER,
        "",
        "## PR Review",
        "",
        "*Review #2*",
        "",
        "Blocking bug on line 20",
        "severity: blocking",
        "",
        "Reviewed commit: `abc123def456`",
        "review-iteration: 2",
        "",
        "<details>",
        "<summary>Previous review iterations (audit log — do not edit)</summary>",
        "",
        "@@@ ITERATION 1 @@@",
        "Minor nit on line 5",
        "severity: advisory",
        "review-result: advisory",
        "",
        "</details>",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body },
      ]);
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      const result = await maybeAddReadyLabel(repo.fullName, 1);

      expect(result).toBe(false);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });
  });

  describe("isNoActionableReview", () => {
    it("returns true for 'the review I already posted is accurate — no changes needed'", () => {
      expect(isNoActionableReview("The review I already posted is accurate — no changes needed.")).toBe(true);
    });

    it("returns true for 'Looks good, nothing to change'", () => {
      expect(isNoActionableReview("Looks good, nothing to change.")).toBe(true);
    });

    it("returns false for review mentioning a bug on a specific line", () => {
      expect(isNoActionableReview("Bug on line 10\nrecommended-model: opus")).toBe(false);
    });

    it("returns false for review with a Suggested Approach Change header", () => {
      expect(isNoActionableReview("## Suggested Approach Change\nRework the cache layer.")).toBe(false);
    });

    it("returns true for the real #1454 comment body (full format with headers and markers)", () => {
      const body = [
        CLAWS_VISIBLE_HEADER,
        "",
        "## PR Review",
        "",
        "*Review #3*",
        "",
        "The workflow confirmed my findings. The review I already posted is accurate — no changes needed.",
        "",
        "Reviewed commit: `e80183910520`",
        "review-iteration: 3",
        "review-addressed: e80183910520",
      ].join("\n");
      expect(isNoActionableReview(body)).toBe(true);
    });
  });

  describe("changedFilesFromDiff", () => {
    it("extracts file paths from a unified diff", () => {
      const diff = [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "index abc..def 100644",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/bar/baz.tsx b/src/bar/baz.tsx",
        "index 111..222 100644",
        "--- a/src/bar/baz.tsx",
        "+++ b/src/bar/baz.tsx",
        "@@ -2 +2 @@",
        "-x",
        "+y",
      ].join("\n");
      expect(changedFilesFromDiff(diff)).toEqual(["src/foo.ts", "src/bar/baz.tsx"]);
    });

    it("returns an empty array for an empty diff", () => {
      expect(changedFilesFromDiff("")).toEqual([]);
    });

    it("handles paths containing spaces and dots", () => {
      const diff = "diff --git a/some dir/file.name.ts b/some dir/file.name.ts\n";
      expect(changedFilesFromDiff(diff)).toEqual(["some dir/file.name.ts"]);
    });
  });

  describe("buildReviewContext", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pr-reviewer-ctx-"));
    });

    function write(rel: string, content: string): void {
      const abs = nodePath.join(tmpDir, rel);
      nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
      nodeFs.writeFileSync(abs, content);
    }

    it("returns an empty string when there are no docs and no readable changed files", () => {
      expect(buildReviewContext(tmpDir, [])).toBe("");
    });

    it("loads OVERVIEW.md and skips unrelated topic docs by default", () => {
      write("docs/OVERVIEW.md", "# Overview\nProject docs.");
      write("docs/api-design.md", "# API\nEndpoints.");
      write("docs/database-schema.md", "# DB\nTables.");

      // No changed files, no title — only OVERVIEW.md should be included,
      // topic docs have nothing to match against.
      const ctx = buildReviewContext(tmpDir, [], "");
      expect(ctx).toContain("## Codebase Context");
      expect(ctx).toContain("docs/OVERVIEW.md");
      expect(ctx).not.toContain("docs/api-design.md");
      expect(ctx).not.toContain("docs/database-schema.md");
    });

    it("pulls in topic docs whose filename tokens match the changed file paths", () => {
      write("docs/OVERVIEW.md", "overview");
      write("docs/database-schema.md", "schema docs");
      write("docs/api-design.md", "api docs");

      // PR touches a database file — database-schema.md should be included
      // because "database" is a token in both the path and the doc filename.
      const ctx = buildReviewContext(tmpDir, ["src/db/database.ts"], "");
      expect(ctx).toContain("docs/OVERVIEW.md");
      expect(ctx).toContain("docs/database-schema.md");
      expect(ctx).not.toContain("docs/api-design.md");
    });

    it("pulls in topic docs whose filename tokens match the PR title", () => {
      write("docs/OVERVIEW.md", "overview");
      write("docs/api-design.md", "api docs");
      write("docs/database-schema.md", "schema docs");

      const ctx = buildReviewContext(tmpDir, ["src/foo.ts"], "Add new API endpoint for search");
      expect(ctx).toContain("docs/OVERVIEW.md");
      expect(ctx).toContain("docs/api-design.md");
      expect(ctx).not.toContain("docs/database-schema.md");
    });

    it("pulls in multiple relevant topic docs when several signals match", () => {
      write("docs/OVERVIEW.md", "overview");
      write("docs/api-design.md", "api docs");
      write("docs/database-schema.md", "schema docs");
      write("docs/deployment.md", "deploy docs");

      const ctx = buildReviewContext(
        tmpDir,
        ["src/api/routes.ts", "src/db/schema.ts"],
        "",
      );
      expect(ctx).toContain("docs/OVERVIEW.md");
      expect(ctx).toContain("docs/api-design.md");
      expect(ctx).toContain("docs/database-schema.md");
      expect(ctx).not.toContain("docs/deployment.md");
    });

    it("skips non-markdown files in docs/", () => {
      write("docs/OVERVIEW.md", "overview");
      write("docs/notes.txt", "not markdown");
      write("docs/image.png", "fake binary");

      const ctx = buildReviewContext(tmpDir, [], "");
      expect(ctx).toContain("docs/OVERVIEW.md");
      expect(ctx).not.toContain("notes.txt");
      expect(ctx).not.toContain("image.png");
    });

    it("truncates oversized doc files with a marker", () => {
      write("docs/OVERVIEW.md", "x".repeat(100_000));
      const ctx = buildReviewContext(tmpDir, [], "");
      expect(ctx).toContain("[... truncated ...]");
    });

    it("loads full content of changed code files by extension", () => {
      write("src/foo.ts", "export function foo() { return 42; }");
      write("src/bar.tsx", "export const Bar = () => null;");

      const ctx = buildReviewContext(tmpDir, ["src/foo.ts", "src/bar.tsx"]);
      expect(ctx).toContain("### Full contents of changed files");
      expect(ctx).toContain("src/foo.ts");
      expect(ctx).toContain("foo() { return 42; }");
      expect(ctx).toContain("src/bar.tsx");
      expect(ctx).toContain("Bar = () => null");
    });

    it("skips changed files whose extension is not in the allow-list (lock, json, binary, etc.)", () => {
      write("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
      write("build/output.bin", "binary");
      write("src/real.ts", "export {};");

      const ctx = buildReviewContext(tmpDir, ["package-lock.json", "build/output.bin", "src/real.ts"]);
      expect(ctx).toContain("src/real.ts");
      expect(ctx).not.toContain("package-lock.json");
      expect(ctx).not.toContain("build/output.bin");
    });

    it("silently skips deleted files (not present on disk)", () => {
      write("src/still-here.ts", "export {};");
      // "src/deleted.ts" intentionally not written

      const ctx = buildReviewContext(tmpDir, ["src/deleted.ts", "src/still-here.ts"]);
      expect(ctx).toContain("src/still-here.ts");
      expect(ctx).not.toContain("src/deleted.ts");
    });

    it("truncates oversized changed-file content with a marker", () => {
      write("src/huge.ts", "x".repeat(100_000));
      const ctx = buildReviewContext(tmpDir, ["src/huge.ts"]);
      expect(ctx).toContain("src/huge.ts");
      expect(ctx).toContain("[... truncated ...]");
    });

    it("stops adding changed files once the aggregate context budget is exhausted", () => {
      // Each file ~14kB, MAX_CONTEXT_BYTES is 60kB — after ~4 files we hit the cap
      const bigContent = "x".repeat(14_000);
      const files: string[] = [];
      for (let i = 0; i < 10; i++) {
        const f = `src/file${i}.ts`;
        write(f, bigContent);
        files.push(f);
      }
      const ctx = buildReviewContext(tmpDir, files, "");
      expect(ctx).toMatch(/\d+ more file\(s\) omitted — context budget exhausted/);
    });

    it("omits the docs section entirely when docs/ does not exist", () => {
      write("src/foo.ts", "export {};");
      const ctx = buildReviewContext(tmpDir, ["src/foo.ts"]);
      expect(ctx).not.toContain("Project documentation");
      expect(ctx).toContain("src/foo.ts");
    });

    it("omits the changed-files section entirely when no files are readable", () => {
      write("docs/OVERVIEW.md", "overview");
      const ctx = buildReviewContext(tmpDir, [], "");
      expect(ctx).toContain("docs/OVERVIEW.md");
      expect(ctx).not.toContain("Full contents of changed files");
    });
  });

  describe("extractKeywordTokens", () => {
    it("splits on path separators, dashes, underscores, dots and lowercases", () => {
      const tokens = extractKeywordTokens(["src/db/User.schema.ts"]);
      expect(tokens).toContain("src");
      expect(tokens).toContain("user");
      expect(tokens).toContain("schema");
    });

    it("drops tokens shorter than 3 characters", () => {
      const tokens = extractKeywordTokens(["a/b/cd/foo.ts"]);
      expect(tokens).not.toContain("a");
      expect(tokens).not.toContain("b");
      expect(tokens).not.toContain("cd");
      expect(tokens).toContain("foo");
    });

    it("deduplicates tokens across multiple sources", () => {
      const tokens = extractKeywordTokens(["src/api/routes.ts", "Add API endpoint"]);
      expect(tokens.has("api")).toBe(true);
      // Both sources contain "api" but it should appear only once
      expect(Array.from(tokens).filter((t) => t === "api")).toHaveLength(1);
    });
  });

  describe("selectRelevantDocs", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pr-reviewer-select-"));
      nodeFs.mkdirSync(nodePath.join(tmpDir, "docs"), { recursive: true });
    });

    function writeDoc(name: string): void {
      nodeFs.writeFileSync(nodePath.join(tmpDir, "docs", name), "content");
    }

    it("returns empty when docs/ does not exist", () => {
      const emptyTmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pr-no-docs-"));
      expect(selectRelevantDocs(emptyTmp, [], "")).toEqual([]);
    });

    it("always includes OVERVIEW.md when present", () => {
      writeDoc("OVERVIEW.md");
      writeDoc("unrelated.md");
      expect(selectRelevantDocs(tmpDir, [], "")).toEqual(["OVERVIEW.md"]);
    });

    it("includes a topic doc whose name matches a changed path token", () => {
      writeDoc("OVERVIEW.md");
      writeDoc("database-schema.md");
      writeDoc("api-design.md");
      const selected = selectRelevantDocs(tmpDir, ["src/database/migration.ts"], "");
      expect(selected).toContain("OVERVIEW.md");
      expect(selected).toContain("database-schema.md");
      expect(selected).not.toContain("api-design.md");
    });

    it("includes a topic doc whose name matches a PR title token", () => {
      writeDoc("OVERVIEW.md");
      writeDoc("api-design.md");
      const selected = selectRelevantDocs(tmpDir, [], "Refactor API client");
      expect(selected).toContain("api-design.md");
    });

    it("returns only OVERVIEW when no topic doc matches", () => {
      writeDoc("OVERVIEW.md");
      writeDoc("database-schema.md");
      writeDoc("api-design.md");
      expect(selectRelevantDocs(tmpDir, ["src/utils.ts"], "Fix typo")).toEqual(["OVERVIEW.md"]);
    });

    it("sorts topic docs alphabetically after OVERVIEW", () => {
      writeDoc("OVERVIEW.md");
      writeDoc("database-schema.md");
      writeDoc("api-design.md");
      const selected = selectRelevantDocs(
        tmpDir,
        ["src/api/routes.ts", "src/db/schema.ts"],
        "",
      );
      expect(selected).toEqual(["OVERVIEW.md", "api-design.md", "database-schema.md"]);
    });

    it("returns no OVERVIEW when OVERVIEW.md is missing", () => {
      writeDoc("database-schema.md");
      expect(selectRelevantDocs(tmpDir, ["src/database.ts"], "")).toEqual(["database-schema.md"]);
    });
  });
});
