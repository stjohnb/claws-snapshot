import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";
import { ShutdownError } from "../shutdown.js";

vi.mock("../config.js", () => ({}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../log.js", () => mockLog);

const mockReportError = vi.hoisted(() => vi.fn());

vi.mock("../error-reporter.js", () => ({
  reportError: mockReportError,
}));

const { mockGh, mockClaude, mockDb, MockRateLimitError } = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RateLimitError";
    }
  }
  return {
  MockRateLimitError,
  mockGh: {
    listPRs: vi.fn(),
    prChecksPassing: vi.fn(),
    prChecksFailing: vi.fn(),
    mergePR: vi.fn(),
    getFailingCheck: vi.fn(),
    getFailedRunLog: vi.fn(),
    rerunWorkflow: vi.fn(),
    getPRMergeableState: vi.fn(),
    updatePRBody: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    getPRChangedFiles: vi.fn(),
    searchIssues: vi.fn(),
    createIssue: vi.fn(),
    commentOnIssue: vi.fn(),
    getIssueComments: vi.fn(),
    editIssueComment: vi.fn(),
    isClawsComment: vi.fn(),
    RateLimitError: MockRateLimitError,
  },
  mockClaude: {
    createWorktreeFromBranch: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn(),
    regeneratePRDescription: vi.fn(),
    attemptMerge: vi.fn(),
    abortMerge: vi.fn(),
    git: vi.fn(),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    hasPreviousCiFixerTasks: vi.fn(),
  },
};});

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import { run } from "./ci-fixer.js";

describe("ci-fixer", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRs.mockResolvedValue([]);
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
    mockClaude.createWorktreeFromBranch.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue('{"related": true, "fingerprint": "", "reason": "related to PR"}');
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nUpdated");
    mockClaude.git.mockResolvedValue("abc123 some commit");
    mockGh.updatePRBody.mockResolvedValue(undefined);
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(false);
  });

  it("cancelled check — re-runs workflow, does NOT attempt code fix", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "CANCELLED",
      link: "https://github.com/org/repo/actions/runs/555/jobs/1",
    });

    await run([repo]);

    expect(mockGh.rerunWorkflow).toHaveBeenCalledWith(repo.fullName, "555");
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("rerun silently skips when workflow is already running", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "CANCELLED",
      link: "https://github.com/org/repo/actions/runs/555/jobs/1",
    });
    mockGh.rerunWorkflow.mockRejectedValue(
      new Error("run 555 cannot be rerun; This workflow is already running"),
    );

    await run([repo]);

    expect(mockGh.rerunWorkflow).toHaveBeenCalledWith(repo.fullName, "555");
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("related failure — proceeds with fix as before", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    // Classification returns related
    mockClaude.runClaude
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "test failure in changed file"}')
      .mockResolvedValueOnce("fixed");

    await run([repo]);

    expect(mockGh.getPRChangedFiles).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).toHaveBeenCalledWith("/tmp/worktree", pr.baseRefName, pr);
    expect(mockGh.updatePRBody).toHaveBeenCalledWith(repo.fullName, pr.number, "## Summary\nUpdated");
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("unrelated failure — files issue, does not attempt fix", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    // Classification returns unrelated
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:auth-timeout", "reason": "intermittent timeout unrelated to PR"}',
    );

    await run([repo]);

    // Should file an issue with stable body
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "[ci-unrelated] CI failures unrelated to PR changes",
      expect.stringContaining("Auto-created by Claws"),
      [],
    );
    // Fingerprint logged as comment with run link
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("flakey-test:auth-timeout"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("https://github.com/org/repo/actions/runs/123"),
    );
    // Should NOT create a worktree for fixing (merge-base worktree is fine)
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer",
    );
  });

  it("unrelated failure — updates existing issue instead of creating duplicate", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:auth-timeout", "reason": "timeout"}',
    );
    // Existing issue found
    mockGh.searchIssues.mockResolvedValue([
      { number: 50, title: "[ci-unrelated] CI failures unrelated to PR changes" },
    ]);

    await run([repo]);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      50,
      expect.stringContaining("flakey-test:auth-timeout"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      50,
      expect.stringContaining("https://github.com/org/repo/actions/runs/123"),
    );
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("unrelated failures with different fingerprints — all go to same issue", async () => {
    const pr1 = mockPR({ number: 10, title: "PR ten" });
    const pr2 = mockPR({ number: 20, title: "PR twenty" });
    mockGh.listPRs.mockResolvedValue([pr1, pr2]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: some failure");
    // First PR: flakey-test fingerprint, second PR: runner fingerprint
    mockClaude.runClaude
      .mockResolvedValueOnce('{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}')
      .mockResolvedValueOnce('{"related": false, "fingerprint": "runner:disk-space", "reason": "disk space"}');
    // Structural grouping: single search, no existing issue
    mockGh.searchIssues.mockResolvedValueOnce([]);
    mockGh.createIssue.mockResolvedValue(99);

    await run([repo]);

    // Single search (structural dedup — grouped by repo before processing)
    expect(mockGh.searchIssues).toHaveBeenCalledTimes(1);
    expect(mockGh.searchIssues).toHaveBeenCalledWith(repo.fullName, "[ci-unrelated] CI failures unrelated to PR changes");
    // One issue created
    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    // Both occurrences logged as comments
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(2);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("flakey-test:timeout"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("runner:disk-space"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("https://github.com/org/repo/actions/runs/123"),
    );
  });

  it("unrelated failure — reverts previous ci-fixer commits", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    // Classification: unrelated
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // DB says there are previous ci-fixer tasks
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(true);
    // Revert Claude call
    mockClaude.runClaude.mockResolvedValueOnce("reverted commits");

    await run([repo]);

    // Should create a worktree for revert
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer-revert",
    );
    expect(mockClaude.git).toHaveBeenCalledWith(
      ["log", "--oneline", `origin/${pr.baseRefName}..HEAD`],
      "/tmp/worktree",
    );
    // Should push the reverts
    expect(mockClaude.pushBranch).toHaveBeenCalled();
  });

  it("unrelated failure — no previous ci-fixer tasks, skip revert", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: runner issue");
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "runner:disk-space", "reason": "disk space issue"}',
    );
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(false);

    await run([repo]);

    // Issue should still be filed
    expect(mockGh.createIssue).toHaveBeenCalled();
    // No worktree for revert (merge-base worktree is fine)
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer-revert",
    );
  });

  it("unrelated failure — merges base branch when behind", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // rev-list returns 3 (behind by 3 commits)
    mockClaude.git.mockResolvedValue("3");
    mockClaude.attemptMerge.mockResolvedValue({ clean: true, conflictedFiles: [] });

    await run([repo]);

    // Should create worktree for merge-base
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer-merge-base",
    );
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockDb.recordTaskStart).toHaveBeenCalledWith("ci-fixer:merge-base", repo.fullName, pr.number, null);
    expect(mockDb.recordTaskComplete).toHaveBeenCalled();
  });

  it("unrelated failure — skips merge when already up-to-date", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // rev-list returns 0 (already up-to-date)
    mockClaude.git.mockResolvedValue("0");

    await run([repo]);

    expect(mockClaude.attemptMerge).not.toHaveBeenCalled();
    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
  });

  it("unrelated failure — aborts merge when conflicts arise", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // Behind by 2 commits, merge has conflicts
    mockClaude.git.mockResolvedValue("2");
    mockClaude.attemptMerge.mockResolvedValue({ clean: false, conflictedFiles: ["file.ts"] });
    mockClaude.abortMerge.mockResolvedValue(undefined);

    await run([repo]);

    expect(mockClaude.abortMerge).toHaveBeenCalled();
    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalled();
  });

  it("unrelated failure — merge-base error does not block processing", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // createWorktreeFromBranch fails for merge-base
    mockClaude.createWorktreeFromBranch.mockRejectedValue(new Error("worktree error"));

    // Should not throw
    await run([repo]);

    // Issue was still filed
    expect(mockGh.createIssue).toHaveBeenCalled();
    // Task recorded as failed
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("worktree error"));
  });

  it("classification fails to parse — defaults to related", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    // Claude returns malformed output for classification, then valid fix
    mockClaude.runClaude
      .mockResolvedValueOnce("I cannot determine the issue, here is some random text")
      .mockResolvedValueOnce("fixed");

    await run([repo]);

    // Should proceed with fix (default to related)
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("getPRChangedFiles fails — defaults to related", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    // Changed files returns empty (failure case)
    mockGh.getPRChangedFiles.mockResolvedValue([]);
    // Classification still returns related with empty files
    mockClaude.runClaude
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "related"}')
      .mockResolvedValueOnce("fixed");

    await run([repo]);

    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
  });

  it("issue filing fails — does not block processing", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey test");
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // Issue creation fails
    mockGh.createIssue.mockRejectedValue(new Error("API error"));

    // Should not throw
    await run([repo]);

    // Processing completed despite issue filing failure
    expect(mockGh.createIssue).toHaveBeenCalled();
  });

  it("no failure logs — re-runs workflow when run link exists", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("");

    await run([repo]);

    expect(mockGh.rerunWorkflow).toHaveBeenCalledWith(repo.fullName, "123");
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("no failure logs and no run link — does not create worktree", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "",
    });
    mockGh.getFailedRunLog.mockResolvedValue("");

    await run([repo]);

    expect(mockGh.rerunWorkflow).not.toHaveBeenCalled();
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("no failing checks — returns early", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue(undefined);

    await run([repo]);

    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("no commits produced — no push and no description update", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    mockClaude.runClaude
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "related"}')
      .mockResolvedValueOnce("fixed");
    mockClaude.hasNewCommits.mockResolvedValue(false);

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
    expect(mockGh.updatePRBody).not.toHaveBeenCalled();
  });

  it("conflict resolution — updates PR description after Claude-resolved push", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");
    mockClaude.attemptMerge = vi.fn().mockResolvedValue({ clean: false, conflictedFiles: ["file.ts"] });
    mockClaude.abortMerge = vi.fn().mockResolvedValue(undefined);

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).toHaveBeenCalledWith("/tmp/worktree", pr.baseRefName, pr);
    expect(mockGh.updatePRBody).toHaveBeenCalledWith(repo.fullName, pr.number, "## Summary\nUpdated");
  });

  it("clean merge conflict — does NOT update PR description", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");
    mockClaude.attemptMerge = vi.fn().mockResolvedValue({ clean: true, conflictedFiles: [] });

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
    expect(mockGh.updatePRBody).not.toHaveBeenCalled();
  });

  it("description update failure — does not fail the task", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    mockClaude.runClaude
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "related"}')
      .mockResolvedValueOnce("fixed");
    mockClaude.regeneratePRDescription.mockRejectedValue(new Error("Claude unavailable"));

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
    // Task completed despite description failure
    expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
  });

  it("error during fix — records task as failed and reports error for regular PR", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification returns related, then fix Claude call fails
    mockClaude.runClaude
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "related"}')
      .mockRejectedValueOnce(new Error("claude error"));

    await run([repo]);

    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"));
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledWith(
      "ci-fixer:process-pr",
      `${repo.fullName}#${pr.number}`,
      expect.any(Error),
    );
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("error on ci-unrelated fix PR — comments on PR instead of reportError", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs, so only the fix call matters
    mockClaude.runClaude.mockRejectedValueOnce(new Error("claude error"));

    await run([repo]);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("### CI Fixer Error"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("claude error"),
    );
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("error on ci-unrelated fix PR — edits existing error comment", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs
    mockClaude.runClaude.mockRejectedValueOnce(new Error("claude error"));
    // Existing error comment from Claws
    mockGh.getIssueComments.mockResolvedValue([
      { id: 777, body: "### CI Fixer Error\n\nprevious error", login: "claws-bot" },
    ]);
    mockGh.isClawsComment.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.editIssueComment).toHaveBeenCalledWith(
      repo.fullName,
      777,
      expect.stringContaining("### CI Fixer Error"),
    );
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("ShutdownError — does not comment on PR or report error", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs
    mockClaude.runClaude.mockRejectedValueOnce(new ShutdownError("shutting down"));

    await run([repo]);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockReportError).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Shutdown"),
    );
  });

  it("RateLimitError — does not comment on PR or report error", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs
    mockClaude.runClaude.mockRejectedValueOnce(new MockRateLimitError("rate limited"));

    await run([repo]);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockReportError).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("Rate limited"),
    );
  });

  it("error comment posting fails on ci-unrelated PR — does not throw", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs
    mockClaude.runClaude.mockRejectedValueOnce(new Error("claude error"));
    // Commenting itself fails
    mockGh.getIssueComments.mockRejectedValue(new Error("API error"));

    // Should not throw
    await run([repo]);

    expect(mockReportError).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to post error comment"),
    );
  });

  it("ci-unrelated fix PR — skips classification and attempts fix directly", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    // Only one runClaude call — for the fix, not classification
    mockClaude.runClaude.mockResolvedValueOnce("fixed the issue");

    await run([repo]);

    // Classification should be skipped
    expect(mockGh.getPRChangedFiles).not.toHaveBeenCalled();
    // Fix should be attempted
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    // No issue filing
    expect(mockGh.searchIssues).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("regular PR still classifies normally when ci-unrelated guard is present", async () => {
    const pr = mockPR({ title: "feat: add new feature" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runClaude.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );

    await run([repo]);

    // Classification should run for regular PRs
    expect(mockGh.getPRChangedFiles).toHaveBeenCalledWith(repo.fullName, pr.number);
    // Unrelated path should be taken
    expect(mockGh.createIssue).toHaveBeenCalled();
    // Fix should NOT be attempted
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer",
    );
  });

  it("concurrent unrelated failures from same repo — single search, single create", async () => {
    const pr1 = mockPR({ number: 10, title: "PR ten" });
    const pr2 = mockPR({ number: 20, title: "PR twenty" });
    const pr3 = mockPR({ number: 30, title: "PR thirty" });
    mockGh.listPRs.mockResolvedValue([pr1, pr2, pr3]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: some failure");
    mockClaude.runClaude
      .mockResolvedValueOnce('{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}')
      .mockResolvedValueOnce('{"related": false, "fingerprint": "runner:disk-space", "reason": "disk space"}')
      .mockResolvedValueOnce('{"related": false, "fingerprint": "flakey-test:auth", "reason": "auth flake"}');
    mockGh.searchIssues.mockResolvedValueOnce([]);
    mockGh.createIssue.mockResolvedValue(99);

    await run([repo]);

    // Structural dedup: one search, one create, three comments
    expect(mockGh.searchIssues).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(3);
  });

  it("unrelated failures across different repos — separate issues", async () => {
    const repo2 = mockRepo({ fullName: "org/other-repo" });
    const pr1 = mockPR({ number: 10, title: "PR ten" });
    const pr2 = mockPR({ number: 20, title: "PR twenty" });
    mockGh.listPRs
      .mockResolvedValueOnce([pr1])
      .mockResolvedValueOnce([pr2]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: some failure");
    mockClaude.runClaude
      .mockResolvedValueOnce('{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}')
      .mockResolvedValueOnce('{"related": false, "fingerprint": "runner:disk-space", "reason": "disk space"}');
    // Each repo's search returns empty
    mockGh.searchIssues.mockResolvedValue([]);
    mockGh.createIssue
      .mockResolvedValueOnce(99)
      .mockResolvedValueOnce(100);

    await run([repo, repo2]);

    // One search per repo, one create per repo
    expect(mockGh.searchIssues).toHaveBeenCalledTimes(2);
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    // One comment per occurrence
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(2);
  });
});
