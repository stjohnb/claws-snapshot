import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    problematic: "Claws Problematic",
    billing: "Billing",
  },
  CI_FIXER_MAX_ATTEMPTS: () => 5,
  CI_FIXER_WINDOW_MS: () => 24 * 60 * 60 * 1000,
  CI_FIXER_MAX_CONSECUTIVE_FAILURES: () => 3,
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
}));
vi.mock("../model-selector.js", () => ({ getModel: (tier?: string) => tier ?? "sonnet" }));

const mockClassifyComplexity = vi.hoisted(() => vi.fn().mockResolvedValue("sonnet"));
vi.mock("../classify-complexity.js", () => ({ classifyComplexity: mockClassifyComplexity }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../log.js", () => mockLog);

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("../timeout-handler.js", () => ({
  handleTimeoutIfApplicable: vi.fn().mockResolvedValue(undefined),
  getItemTimeoutMs: vi.fn().mockReturnValue(undefined),
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    mergePR: vi.fn(),
    getFailingCheck: vi.fn(),
    getFailedRunLog: vi.fn(),
    rerunWorkflow: vi.fn(),
    getRunAnnotations: vi.fn(),
    isBillingBlocked: vi.fn((arr: string[]) => arr.some((s) => /account payments have failed|spending limit/i.test(s))),
    getPRMergeableState: vi.fn(),
    updatePR: vi.fn(),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    getPRChangedFiles: vi.fn(),
    searchIssues: vi.fn(),
    createIssue: vi.fn(),
    commentOnIssue: vi.fn(),
    getIssueComments: vi.fn(),
    editIssueComment: vi.fn(),
    isClawsComment: vi.fn(),
    isForkPR: vi.fn().mockReturnValue(false),
    postProblematicPRComment: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
  },
  mockClaude: {
    withExistingWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn(),
    regeneratePRDescription: vi.fn(),
    attemptMerge: vi.fn(),
    abortMerge: vi.fn(),
    git: vi.fn(),
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
    hasPreviousCiFixerTasks: vi.fn(),
    countCIFixerAttempts: vi.fn().mockReturnValue({ total: 0, failed: 0, successful: 0, transientApiFailed: 0 }),
    getRecentCIFixerErrors: vi.fn().mockReturnValue([]),
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

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import {
  identifyPRWork,
  runCIFix,
  fixCI,
  resolveConflicts,
  fileUnrelatedIssue,
  revertPreviousUnrelatedFixes,
  mergeBaseIfBehind,
  isCIUnrelatedFixPR,
} from "./ci-fixer.js";

describe("ci-fixer", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.mergePR.mockResolvedValue(undefined);
    mockGh.rerunWorkflow.mockResolvedValue(undefined);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getPRChangedFiles.mockResolvedValue(["src/app.ts"]);
    mockGh.searchIssues.mockResolvedValue([]);
    mockGh.createIssue.mockResolvedValue(99);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.isClawsComment.mockReturnValue(false);
    mockGh.isForkPR.mockReturnValue(false);
    mockClaude.withExistingWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue('{"related": true, "fingerprint": "", "reason": "related to PR"}');
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nUpdated");
    mockClaude.git.mockResolvedValue("abc123 some commit");
    mockGh.updatePR.mockResolvedValue(undefined);
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(false);
  });

  describe("identifyPRWork", () => {
    it("returns conflict when PR has merge conflicts", async () => {
      const pr = mockPR();
      mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");

      const result = await identifyPRWork(repo, pr);

      expect(result).toEqual({ kind: "conflict", repo, pr });
    });

    it("returns null when no failing checks", async () => {
      const pr = mockPR();
      mockGh.getFailingCheck.mockResolvedValue(undefined);

      const result = await identifyPRWork(repo, pr);

      expect(result).toBeNull();
    });

    it("returns rerun for cancelled checks", async () => {
      const pr = mockPR();
      mockGh.getFailingCheck.mockResolvedValue({
        name: "CI",
        state: "CANCELLED",
        link: "https://github.com/org/repo/actions/runs/555/jobs/1",
      });

      const result = await identifyPRWork(repo, pr);

      expect(result).toEqual({ kind: "rerun", repo, pr, runId: "555" });
    });

    it("returns null when cancelled check has no rerun link", async () => {
      const pr = mockPR();
      mockGh.getFailingCheck.mockResolvedValue({
        name: "CI",
        state: "CANCELLED",
        link: "",
      });

      const result = await identifyPRWork(repo, pr);

      expect(result).toBeNull();
    });

    it("returns fix for any non-cancelled failing check (no log fetch, no classify)", async () => {
      const pr = mockPR();
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/123" };
      mockGh.getFailingCheck.mockResolvedValue(failedCheck);

      const result = await identifyPRWork(repo, pr);

      expect(result).toEqual({ kind: "fix", repo, pr, failedCheck });
      // Scanner is pure GitHub-status — must not fetch logs or invoke claude.
      expect(mockGh.getFailedRunLog).not.toHaveBeenCalled();
      expect(mockClaude.runClaude).not.toHaveBeenCalled();
    });
  });

  describe("runCIFix", () => {
    it("reruns workflow when fail log is missing but link has a run ID", async () => {
      const pr = mockPR();
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/789/jobs/2" };
      mockGh.getFailedRunLog.mockResolvedValue(null);
      mockGh.getRunAnnotations.mockResolvedValue([]);

      await runCIFix(repo, pr, failedCheck);

      expect(mockGh.rerunWorkflow).toHaveBeenCalledWith(repo.fullName, "789");
      expect(mockClaude.runClaude).not.toHaveBeenCalled();
      expect(mockDb.recordTaskStart).toHaveBeenCalledWith("ci-fixer", repo.fullName, pr.number, null);
      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(expect.anything(), expect.any(String), { failureCategory: "logs-unavailable" });
    });

    it("skips rerun and logs warn when billing annotation is present", async () => {
      const pr = mockPR();
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/789/jobs/2" };
      mockGh.getFailedRunLog.mockResolvedValue(null);
      mockGh.getRunAnnotations.mockResolvedValue([
        "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
      ]);

      await runCIFix(repo, pr, failedCheck);

      expect(mockGh.rerunWorkflow).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringMatching(/billing|spending.limit/i));
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Billing");
      expect(mockDb.recordTaskStart).not.toHaveBeenCalled();
      expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
    });

    it("warns but does not throw when rerun fails with cannot be rerun", async () => {
      const pr = mockPR();
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/789/jobs/2" };
      mockGh.getFailedRunLog.mockResolvedValue(null);
      mockGh.getRunAnnotations.mockResolvedValue([]);
      mockGh.rerunWorkflow.mockRejectedValue(new Error("run 789 cannot be rerun; Resource not accessible by integration"));

      await expect(runCIFix(repo, pr, failedCheck)).resolves.toBeUndefined();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Cannot rerun workflow"));
      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(expect.anything(), expect.any(String), { failureCategory: "logs-unavailable" });
    });

    it("logs info but does not throw when rerun fails with already running", async () => {
      const pr = mockPR();
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/789/jobs/2" };
      mockGh.getFailedRunLog.mockResolvedValue(null);
      mockGh.getRunAnnotations.mockResolvedValue([]);
      mockGh.rerunWorkflow.mockRejectedValue(new Error("workflow already running"));

      await expect(runCIFix(repo, pr, failedCheck)).resolves.toBeUndefined();
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining("already running"));
      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(expect.anything(), expect.any(String), { failureCategory: "logs-unavailable" });
    });

    it("rethrows unknown rerun errors", async () => {
      const pr = mockPR();
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/789/jobs/2" };
      mockGh.getFailedRunLog.mockResolvedValue(null);
      mockGh.getRunAnnotations.mockResolvedValue([]);
      const unknownErr = new Error("unexpected GitHub outage");
      mockGh.rerunWorkflow.mockRejectedValue(unknownErr);

      await expect(runCIFix(repo, pr, failedCheck)).rejects.toThrow("unexpected GitHub outage");
      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(expect.anything(), expect.any(String), { failureCategory: "logs-unavailable" });
    });

    it("logs warn when fail log is missing and link has no run ID", async () => {
      const pr = mockPR();
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/pull/10/checks" };
      mockGh.getFailedRunLog.mockResolvedValue(null);

      await runCIFix(repo, pr, failedCheck);

      expect(mockGh.rerunWorkflow).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("No failure logs"));
      expect(mockDb.recordTaskStart).toHaveBeenCalledWith("ci-fixer", repo.fullName, pr.number, null);
      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(expect.anything(), expect.any(String), { failureCategory: "logs-unavailable" });
    });

    it("skips classification and calls fixCI for ci-unrelated fix PRs", async () => {
      const pr = mockPR({
        title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
      });
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/123" };
      mockGh.getFailedRunLog.mockResolvedValue("error: test failed");

      await runCIFix(repo, pr, failedCheck);

      // getPRChangedFiles is only called in the classification path — must not be called here
      expect(mockGh.getPRChangedFiles).not.toHaveBeenCalled();
      expect(mockClaude.withExistingWorktree).toHaveBeenCalledWith(
        repo,
        pr.headRefName,
        "ci-fixer",
        expect.any(Function),
      );
    });

    it("calls fixCI when classification returns related", async () => {
      const pr = mockPR();
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/123" };
      mockGh.getFailedRunLog.mockResolvedValue("error: assertion failed in src/app.ts");
      mockClaude.runClaude.mockResolvedValue('{"related": true, "fingerprint": "", "reason": "test file changed"}');

      await runCIFix(repo, pr, failedCheck);

      expect(mockClaude.withExistingWorktree).toHaveBeenCalledWith(
        repo,
        pr.headRefName,
        "ci-fixer",
        expect.any(Function),
      );
    });

    it("files issue and skips fixCI when classification returns unrelated", async () => {
      const pr = mockPR();
      const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/456" };
      mockGh.getFailedRunLog.mockResolvedValue("error: network timeout after 30s");
      mockClaude.runClaude.mockResolvedValue('{"related": false, "fingerprint": "runner:network-timeout", "reason": "intermittent network failure"}');
      mockDb.hasPreviousCiFixerTasks.mockReturnValue(false);
      mockClaude.git.mockResolvedValue("0");

      await runCIFix(repo, pr, failedCheck);

      expect(mockClaude.withExistingWorktree).not.toHaveBeenCalledWith(
        repo,
        pr.headRefName,
        "ci-fixer",
        expect.any(Function),
      );
      expect(mockGh.searchIssues).toHaveBeenCalled();
      expect(mockGh.createIssue).toHaveBeenCalled();
      expect(mockDb.hasPreviousCiFixerTasks).toHaveBeenCalled();
      expect(mockClaude.withExistingWorktree).toHaveBeenCalledWith(
        repo,
        pr.headRefName,
        "ci-fixer-merge-base",
        expect.any(Function),
      );
    });
  });

  describe("fixCI", () => {
    it("creates worktree, runs claude, pushes, updates description", async () => {
      const pr = mockPR();
      mockClaude.runClaude.mockResolvedValueOnce("fixed");

      await fixCI(repo, pr, "error: test failed");

      expect(mockClaude.withExistingWorktree).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer", expect.any(Function));
      expect(mockClaude.pushBranch).toHaveBeenCalled();
      expect(mockClaude.regeneratePRDescription).toHaveBeenCalledWith("/tmp/worktree", pr.baseRefName, pr, repo.fullName, expect.any(String));
      expect(mockGh.updatePR).toHaveBeenCalledWith(repo.fullName, pr.number, "## Summary\nUpdated");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("no commits produced — no push and no description update", async () => {
      const pr = mockPR();
      mockClaude.runClaude.mockResolvedValueOnce("fixed");
      mockClaude.hasNewCommits.mockResolvedValue(false);

      await fixCI(repo, pr, "error: test failed");

      expect(mockClaude.pushBranch).not.toHaveBeenCalled();
      expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
      expect(mockGh.updatePR).not.toHaveBeenCalled();
    });

    it("description update failure — does not fail the task", async () => {
      const pr = mockPR();
      mockClaude.runClaude.mockResolvedValueOnce("fixed");
      mockClaude.regeneratePRDescription.mockRejectedValue(new Error("Claude unavailable"));

      await fixCI(repo, pr, "error: test failed");

      expect(mockClaude.pushBranch).toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
      expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
    });

    it("skips gracefully when branch no longer exists (merged/closed)", async () => {
      const pr = mockPR({ headRefName: "dependabot/npm/lodash-4.0" });
      mockClaude.withExistingWorktree.mockResolvedValue(null);

      await fixCI(repo, pr, "error: test failed");

      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, {
        commits: 0,
        prNumber: pr.number,
        prAction: "skipped",
      });
      expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
    });

    it("uses classifyComplexity to pick model for CI fix", async () => {
      const pr = mockPR();
      mockClassifyComplexity.mockResolvedValueOnce("opus");
      mockClaude.runClaude.mockResolvedValueOnce("fixed");

      await fixCI(repo, pr, "error: complex architectural test failure");

      expect(mockClassifyComplexity).toHaveBeenCalledWith(
        expect.stringContaining("CI failure on PR"),
        "/tmp/worktree",
      );
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "opus" }),
      );
    });

    it("error during fix — records task as failed and throws", async () => {
      const pr = mockPR();
      mockClaude.runClaude.mockRejectedValueOnce(new Error("claude error"));

      await expect(fixCI(repo, pr, "log output")).rejects.toThrow("claude error");

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"), expect.any(Object));
    });
  });

  describe("resolveConflicts", () => {
    it("uses classifyComplexity to pick model for conflict resolution", async () => {
      const pr = mockPR();
      mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");
      mockClaude.attemptMerge.mockResolvedValue({ clean: false, conflictedFiles: ["src/foo.ts"] });
      mockClassifyComplexity.mockResolvedValueOnce("opus");

      await resolveConflicts(repo, pr);

      expect(mockClassifyComplexity).toHaveBeenCalledWith(
        expect.stringContaining("Resolving merge conflicts on PR"),
        "/tmp/worktree",
      );
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "opus" }),
      );
    });

    it("updates PR description after Claude-resolved push", async () => {
      const pr = mockPR();
      mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");
      mockClaude.attemptMerge.mockResolvedValue({ clean: false, conflictedFiles: ["file.ts"] });

      await resolveConflicts(repo, pr);

      expect(mockClaude.pushBranch).toHaveBeenCalled();
      expect(mockClaude.regeneratePRDescription).toHaveBeenCalledWith("/tmp/worktree", pr.baseRefName, pr, repo.fullName, expect.any(String));
      expect(mockGh.updatePR).toHaveBeenCalledWith(repo.fullName, pr.number, "## Summary\nUpdated");
    });

    it("clean merge — does NOT update PR description", async () => {
      const pr = mockPR();
      mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");
      mockClaude.attemptMerge.mockResolvedValue({ clean: true, conflictedFiles: [] });

      await resolveConflicts(repo, pr);

      expect(mockClaude.pushBranch).toHaveBeenCalled();
      expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
      expect(mockGh.updatePR).not.toHaveBeenCalled();
    });

    it("returns false when not conflicting", async () => {
      const pr = mockPR();
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

      const result = await resolveConflicts(repo, pr);

      expect(result).toBe(false);
      expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    });

    it("returns false and skips when branch no longer exists (merged/closed)", async () => {
      const pr = mockPR({ headRefName: "dependabot/npm/lodash-4.0" });
      mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");
      mockClaude.withExistingWorktree.mockResolvedValue(null);

      const result = await resolveConflicts(repo, pr);

      expect(result).toBe(false);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, {
        commits: 0,
        prNumber: pr.number,
        prAction: "skipped",
      });
      expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
    });
  });

  describe("fileUnrelatedIssue", () => {
    it("creates new issue and posts comment", async () => {
      mockGh.searchIssues.mockResolvedValue([]);
      mockGh.createIssue.mockResolvedValue(99);

      await fileUnrelatedIssue(repo.fullName, [{
        fingerprint: "flakey-test:auth-timeout",
        reason: "intermittent timeout",
        failLog: "error: timeout",
        pr: mockPR(),
        runUrl: "https://github.com/org/repo/actions/runs/123",
      }]);

      expect(mockGh.createIssue).toHaveBeenCalledWith(
        repo.fullName,
        "[ci-unrelated] CI failures unrelated to PR changes",
        expect.stringContaining("Auto-created by Claws"),
        [],
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        99,
        expect.stringContaining("flakey-test:auth-timeout"),
        { agentName: "CI Fixer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        99,
        expect.stringContaining("https://github.com/org/repo/actions/runs/123"),
        { agentName: "CI Fixer" },
      );
    });

    it("updates existing issue instead of creating duplicate", async () => {
      mockGh.searchIssues.mockResolvedValue([
        { number: 50, title: "[ci-unrelated] CI failures unrelated to PR changes" },
      ]);

      await fileUnrelatedIssue(repo.fullName, [{
        fingerprint: "flakey-test:auth-timeout",
        reason: "timeout",
        failLog: "error: timeout",
        pr: mockPR(),
        runUrl: "https://github.com/org/repo/actions/runs/123",
      }]);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        50,
        expect.stringContaining("flakey-test:auth-timeout"),
        { agentName: "CI Fixer" },
      );
      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("issue filing fails — does not throw", async () => {
      mockGh.createIssue.mockRejectedValue(new Error("API error"));

      // Should not throw
      await fileUnrelatedIssue(repo.fullName, [{
        fingerprint: "flakey-test:timeout",
        reason: "timeout",
        failLog: "error",
        pr: mockPR(),
        runUrl: "https://example.com",
      }]);

      expect(mockGh.createIssue).toHaveBeenCalled();
    });

    it("posts multiple occurrences to same issue", async () => {
      mockGh.searchIssues.mockResolvedValue([]);
      mockGh.createIssue.mockResolvedValue(99);

      await fileUnrelatedIssue(repo.fullName, [
        { fingerprint: "flakey-test:timeout", reason: "timeout", failLog: "error1", pr: mockPR({ number: 10 }), runUrl: "https://example.com/1" },
        { fingerprint: "runner:disk-space", reason: "disk space", failLog: "error2", pr: mockPR({ number: 20 }), runUrl: "https://example.com/2" },
      ]);

      expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(2);
    });
  });

  describe("revertPreviousUnrelatedFixes", () => {
    it("uses classifyComplexity to pick model for revert", async () => {
      const pr = mockPR();
      mockDb.hasPreviousCiFixerTasks.mockReturnValue(true);
      mockClassifyComplexity.mockResolvedValueOnce("opus");
      mockClaude.runClaude.mockResolvedValueOnce("reverted");

      await revertPreviousUnrelatedFixes(repo, pr, ["src/app.ts"]);

      expect(mockClassifyComplexity).toHaveBeenCalledWith(
        expect.stringContaining("revert unrelated automated CI fixes"),
        "/tmp/worktree",
      );
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "opus" }),
      );
    });

    it("reverts when previous ci-fixer tasks exist", async () => {
      const pr = mockPR();
      mockDb.hasPreviousCiFixerTasks.mockReturnValue(true);
      mockClaude.runClaude.mockResolvedValueOnce("reverted commits");

      await revertPreviousUnrelatedFixes(repo, pr, ["src/app.ts"]);

      expect(mockClaude.withExistingWorktree).toHaveBeenCalledWith(
        repo,
        pr.headRefName,
        "ci-fixer-revert",
        expect.any(Function),
      );
      expect(mockClaude.git).toHaveBeenCalledWith(
        ["log", "--oneline", `origin/${pr.baseRefName}..HEAD`],
        "/tmp/worktree",
      );
      expect(mockClaude.pushBranch).toHaveBeenCalled();
    });

    it("skips when no previous ci-fixer tasks", async () => {
      const pr = mockPR();
      mockDb.hasPreviousCiFixerTasks.mockReturnValue(false);

      await revertPreviousUnrelatedFixes(repo, pr, ["src/app.ts"]);

      expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    });

    it("skips gracefully when branch no longer exists (merged/closed)", async () => {
      const pr = mockPR({ headRefName: "dependabot/npm/lodash-4.0" });
      mockDb.hasPreviousCiFixerTasks.mockReturnValue(true);
      mockClaude.withExistingWorktree.mockResolvedValue(null);

      await revertPreviousUnrelatedFixes(repo, pr, ["src/app.ts"]);

      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, {
        commits: 0,
        prNumber: pr.number,
        prAction: "skipped",
      });
      expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
    });
  });

  describe("mergeBaseIfBehind", () => {
    it("merges base branch when behind", async () => {
      const pr = mockPR();
      mockClaude.git.mockResolvedValue("3");
      mockClaude.attemptMerge.mockResolvedValue({ clean: true, conflictedFiles: [] });

      await mergeBaseIfBehind(repo, pr);

      expect(mockClaude.withExistingWorktree).toHaveBeenCalledWith(
        repo,
        pr.headRefName,
        "ci-fixer-merge-base",
        expect.any(Function),
      );
      expect(mockClaude.pushBranch).toHaveBeenCalled();
      expect(mockDb.recordTaskStart).toHaveBeenCalledWith("ci-fixer:merge-base", repo.fullName, pr.number, null);
      expect(mockDb.recordTaskComplete).toHaveBeenCalled();
    });

    it("skips merge when already up-to-date", async () => {
      const pr = mockPR();
      mockClaude.git.mockResolvedValue("0");

      await mergeBaseIfBehind(repo, pr);

      expect(mockClaude.attemptMerge).not.toHaveBeenCalled();
      expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    });

    it("aborts merge when conflicts arise", async () => {
      const pr = mockPR();
      mockClaude.git.mockResolvedValue("2");
      mockClaude.attemptMerge.mockResolvedValue({ clean: false, conflictedFiles: ["file.ts"] });
      mockClaude.abortMerge.mockResolvedValue(undefined);

      await mergeBaseIfBehind(repo, pr);

      expect(mockClaude.abortMerge).toHaveBeenCalled();
      expect(mockClaude.pushBranch).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalled();
    });

    it("skips gracefully when branch no longer exists (merged/closed)", async () => {
      const pr = mockPR({ headRefName: "dependabot/npm/lodash-4.0" });
      mockClaude.withExistingWorktree.mockResolvedValue(null);

      await mergeBaseIfBehind(repo, pr);

      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, {
        commits: 0,
        prNumber: pr.number,
        prAction: "skipped",
      });
      expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
    });

    it("error does not throw — records task as failed", async () => {
      const pr = mockPR();
      mockClaude.withExistingWorktree.mockRejectedValue(new Error("worktree error"));

      // Should not throw
      await mergeBaseIfBehind(repo, pr);

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("worktree error"), expect.any(Object));
    });
  });

  describe("isCIUnrelatedFixPR", () => {
    it("returns true for ci-unrelated fix PRs", () => {
      const pr = mockPR({
        title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
      });
      expect(isCIUnrelatedFixPR(pr)).toBe(true);
    });

    it("returns false for regular PRs", () => {
      const pr = mockPR({ title: "feat: add new feature" });
      expect(isCIUnrelatedFixPR(pr)).toBe(false);
    });
  });

  describe("Circuit Breaker", () => {
    const repo = mockRepo();

    beforeEach(() => {
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 0, failed: 0, successful: 0, transientApiFailed: 0 });
      mockDb.getRecentCIFixerErrors.mockReturnValue([]);
      mockGh.postProblematicPRComment.mockClear();
      mockGh.addLabel.mockClear();
      mockGh.getIssueComments.mockClear();
      mockLog.error.mockClear();
    });

    it("skips PRs with problematic label", async () => {
      const pr = mockPR({ labels: [{ name: "Claws Problematic" }] });

      const result = await identifyPRWork(repo, pr);

      expect(result).toBeNull();
      expect(mockGh.getFailingCheck).not.toHaveBeenCalled();
    });

    it("triggers circuit breaker at correct threshold", async () => {
      const pr = mockPR();
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 5, failed: 3, successful: 2, transientApiFailed: 0 });
      mockDb.getRecentCIFixerErrors.mockReturnValue([
        { error: "Error 1", timestamp: "2026-04-13 10:00:00" },
        { error: "Error 2", timestamp: "2026-04-13 09:00:00" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([]);

      const result = await identifyPRWork(repo, pr);

      expect(result).toBeNull();
      expect(mockGh.postProblematicPRComment).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        "Exceeded maximum of 5 fix attempts in 24h window",
        5,
        expect.any(Array),
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        "Claws Problematic",
      );
    });

    it("detects consecutive failures correctly", async () => {
      const pr = mockPR();
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 3, failed: 3, successful: 0, transientApiFailed: 0 });
      mockDb.getRecentCIFixerErrors.mockReturnValue([
        { error: "Consecutive error 1", timestamp: "2026-04-13 10:00:00" },
        { error: "Consecutive error 2", timestamp: "2026-04-13 09:00:00" },
        { error: "Consecutive error 3", timestamp: "2026-04-13 08:00:00" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([]);

      const result = await identifyPRWork(repo, pr);

      expect(result).toBeNull();
      expect(mockGh.postProblematicPRComment).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        "3 consecutive failures without any successful fixes",
        3,
        expect.any(Array),
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        "Claws Problematic",
      );
    });

    it("handles errors during problematic PR notification", async () => {
      const pr = mockPR();
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 5, failed: 5, successful: 0, transientApiFailed: 0 });
      mockGh.postProblematicPRComment.mockRejectedValue(new Error("API error"));
      mockGh.getIssueComments.mockResolvedValue([]);

      const result = await identifyPRWork(repo, pr);

      expect(result).toBeNull();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to notify GitHub for problematic PR"),
      );
      // Label should still be added even when notification fails
      expect(mockGh.addLabel).toHaveBeenCalledWith(
        "test-org/test-repo",
        10,
        "Claws Problematic",
      );
    });

    it("does not post duplicate problematic comments", async () => {
      const pr = mockPR();
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 5, failed: 5, successful: 0, transientApiFailed: 0 });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "### 🚫 PR Marked as Problematic\nproblematic-pr-marked", login: "claws" }
      ]);

      await identifyPRWork(repo, pr);

      expect(mockGh.postProblematicPRComment).not.toHaveBeenCalled();
      // Label is still added (idempotent)
      expect(mockGh.addLabel).toHaveBeenCalled();
    });

    it("does not trigger circuit breaker below threshold", async () => {
      const pr = mockPR();
      mockGh.getFailingCheck.mockResolvedValue({
        name: "test",
        conclusion: "failure",
        detailsUrl: "https://example.com",
      });
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 2, failed: 1, successful: 1, transientApiFailed: 0 });

      const result = await identifyPRWork(repo, pr);

      expect(result).not.toBeNull();
    });

    it("allows successful fixes after failures", async () => {
      const pr = mockPR();
      mockGh.getFailingCheck.mockResolvedValue({
        name: "test",
        conclusion: "failure",
        detailsUrl: "https://example.com",
      });
      // 2 failed, 1 successful - should not trigger consecutive failures
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 3, failed: 2, successful: 1, transientApiFailed: 0 });

      const result = await identifyPRWork(repo, pr);

      expect(result).not.toBeNull();
    });

    it("does not trigger circuit breaker when all failures are transient-api", async () => {
      const pr = mockPR();
      mockGh.getFailingCheck.mockResolvedValue({
        name: "test",
        conclusion: "failure",
        detailsUrl: "https://example.com",
      });
      // 3 failed but all are transient-api — nonTransientFailed === 0
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 3, failed: 3, successful: 0, transientApiFailed: 3 });

      const result = await identifyPRWork(repo, pr);

      expect(result).not.toBeNull();
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "Claws Problematic");
    });

    it("triggers circuit breaker when non-transient failures hit threshold", async () => {
      const pr = mockPR();
      mockGh.getIssueComments.mockResolvedValue([]);
      // 4 failed, 1 transient-api → nonTransientFailed === 3 → threshold hit
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 4, failed: 4, successful: 0, transientApiFailed: 1 });
      mockDb.getRecentCIFixerErrors.mockReturnValue([]);

      const result = await identifyPRWork(repo, pr);

      expect(result).toBeNull();
      expect(mockGh.postProblematicPRComment).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        "3 consecutive failures without any successful fixes",
        4,
        expect.any(Array),
      );
    });

    it("triggers circuit breaker when mixed failures exceed threshold", async () => {
      const pr = mockPR();
      mockGh.getIssueComments.mockResolvedValue([]);
      // 4 total, 4 failed (below maxAttempts=5), 2 transient-api → nonTransientFailed === 2... wait need 3
      // Use total:4, failed:4 transientApiFailed:1 → nonTransientFailed === 3 → threshold hit
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 4, failed: 4, successful: 0, transientApiFailed: 1 });
      mockDb.getRecentCIFixerErrors.mockReturnValue([]);

      const result = await identifyPRWork(repo, pr);

      expect(result).toBeNull();
      expect(mockGh.postProblematicPRComment).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        "3 consecutive failures without any successful fixes",
        4,
        expect.any(Array),
      );
    });

    it("logs-unavailable failures count toward circuit breaker (not transient)", async () => {
      const pr = mockPR();
      mockGh.getIssueComments.mockResolvedValue([]);
      // 3 logs-unavailable failures, 0 transient-api → nonTransientFailed === 3 → threshold hit
      mockDb.countCIFixerAttempts.mockReturnValue({ total: 3, failed: 3, successful: 0, transientApiFailed: 0 });
      mockDb.getRecentCIFixerErrors.mockReturnValue([]);

      const result = await identifyPRWork(repo, pr);

      expect(result).toBeNull();
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Claws Problematic");
      expect(mockGh.postProblematicPRComment).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        "3 consecutive failures without any successful fixes",
        3,
        expect.any(Array),
      );
    });
  });
});
