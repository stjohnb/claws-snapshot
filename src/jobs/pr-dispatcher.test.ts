import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

const mockIsAgentDisabled = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockIsJobDisabledForRepo = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock("../config.js", () => ({
  DB_PATH: ":memory:",
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    problematic: "Claws Problematic",
  },
  isAgentDisabled: mockIsAgentDisabled,
  isJobDisabledForRepo: mockIsJobDisabledForRepo,
}));

vi.mock("../log.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    runContext: new AsyncLocalStorage(),
  };
});

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("../shutdown.js", () => ({
  ShutdownError: class ShutdownError extends Error {},
}));

const mockGh = vi.hoisted(() => ({
  listPRs: vi.fn().mockResolvedValue([]),
  isDispatchSkippable: vi.fn().mockReturnValue(false),
  hasPriorityLabel: vi.fn().mockReturnValue(false),
  isForkPR: vi.fn().mockReturnValue(false),
  getPRReviewComments: vi.fn().mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] }),
  getPRMergeableState: vi.fn().mockResolvedValue("MERGEABLE"),
  populateQueueCache: vi.fn(),
  populateQueueCacheFor: vi.fn(),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  isRateLimited: vi.fn().mockReturnValue(false),
  RateLimitError: class RateLimitError extends Error {},
  getPRDiffStats: vi.fn().mockResolvedValue({ changedFiles: 0, additions: 0, deletions: 0, state: "OPEN" }),
  closePR: vi.fn().mockResolvedValue(undefined),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  closeIssue: vi.fn().mockResolvedValue(undefined),
  getIssueState: vi.fn().mockResolvedValue({ state: "OPEN", stateReason: null }),
  listMergedPRsForIssue: vi.fn().mockResolvedValue([]),
  getLinkedIssueNumber: vi.fn().mockReturnValue(null),
  removeQueueItem: vi.fn(),
  reconcileQueueCache: vi.fn(),
}));
vi.mock("../github.js", () => mockGh);

const mockDb = vi.hoisted(() => ({
  hasActiveWorkForPR: vi.fn().mockReturnValue(false),
  initDb: vi.fn(),
  closeDb: vi.fn(),
  clearAllWorkQueueForTests: vi.fn(),
}));
vi.mock("../db.js", () => mockDb);

const mockCiFixer = vi.hoisted(() => ({
  identifyPRWork: vi.fn().mockResolvedValue(null),
}));
vi.mock("../agents/ci-fixer.js", () => mockCiFixer);

const mockWorker = vi.hoisted(() => ({
  enqueue: vi.fn().mockReturnValue({ id: 1, alreadyQueued: false }),
  AGENT_KINDS: {
    CI_FIXER_CONFLICT: "ci-fixer:conflict",
    CI_FIXER: "ci-fixer",
    CI_FIXER_RERUN: "ci-fixer:rerun",
    CI_FIXER_PROBLEMATIC: "ci-fixer:problematic",
    REVIEW_ADDRESSER: "review-addresser",
    PR_REVIEWER: "pr-reviewer",
    AUTO_MERGER_SWEEP: "auto-merger:sweep",
  },
}));
vi.mock("../worker.js", () => mockWorker);

import { run, sweepEmptyPRs } from "./pr-dispatcher.js";
import { initDb, closeDb, clearAllWorkQueueForTests } from "../db.js";

describe("pr-dispatcher — enqueue coordination", () => {
  const repo = mockRepo();

  beforeAll(() => {
    initDb();
  });

  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllWorkQueueForTests();
    mockIsAgentDisabled.mockReturnValue(false);
    mockIsJobDisabledForRepo.mockReturnValue(false);
    mockGh.isRateLimited.mockReturnValue(false);
    mockGh.isDispatchSkippable.mockReturnValue(false);
    mockGh.isForkPR.mockReturnValue(false);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getPRDiffStats.mockResolvedValue({ changedFiles: 0, additions: 0, deletions: 0, state: "OPEN" });
    mockGh.getLinkedIssueNumber.mockReturnValue(null);
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null });
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockDb.hasActiveWorkForPR.mockReturnValue(false);
    mockWorker.enqueue.mockReturnValue({ id: 1, alreadyQueued: false });
  });

  it("PR with review comments is enqueued for review-addresser, not pr-reviewer (same cycle)", async () => {
    const pr = mockPR({ number: 42 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "Please fix this",
      commentIds: [100],
      reviewCommentIds: [],
    });

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("review-addresser");
    expect(kinds).not.toContain("pr-reviewer");
  });

  it("PR without review comments is enqueued for pr-reviewer", async () => {
    const pr = mockPR({ number: 42 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "",
      commentIds: [],
      reviewCommentIds: [],
    });

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("pr-reviewer");
    expect(kinds).not.toContain("review-addresser");
  });

  it("when review-addresser is disabled, pr-reviewer is still enqueued", async () => {
    const pr = mockPR({ number: 42 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "Please fix this",
      commentIds: [100],
      reviewCommentIds: [],
    });
    mockIsAgentDisabled.mockImplementation((name: string) => name === "review-addresser");

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain("review-addresser");
    expect(kinds).toContain("pr-reviewer");
  });

  it("Ready label is removed before review-addresser is enqueued", async () => {
    const pr = mockPR({ number: 42 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "Please fix this",
      commentIds: [100],
      reviewCommentIds: [],
    });

    await run([repo]);

    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
  });

  it("auto-merger sweep is enqueued at the end", async () => {
    mockGh.listPRs.mockResolvedValue([]);

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("auto-merger:sweep");
  });

  it("PR with Claws Problematic label is enqueued for CI_FIXER_PROBLEMATIC", async () => {
    const pr = mockPR({ number: 77, labels: [{ name: "Claws Problematic" }] });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    const calls = mockWorker.enqueue.mock.calls.filter((c) => c[0] === "ci-fixer:problematic");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(repo.fullName);
    expect(calls[0][2]).toBe(pr.number);
    // problematic PR is also surfaced in the queue UI
    expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith(
      "problematic",
      repo.fullName,
      expect.objectContaining({ number: 77 }),
      "pr",
    );
  });

  it("does NOT enqueue CI_FIXER_PROBLEMATIC when ci-fixer agent is disabled", async () => {
    const pr = mockPR({ number: 77, labels: [{ name: "Claws Problematic" }] });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockIsAgentDisabled.mockImplementation((name: string) => name === "ci-fixer");

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain("ci-fixer:problematic");
    // But the queue cache is still populated so the dashboard surfaces it
    expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith(
      "problematic",
      repo.fullName,
      expect.objectContaining({ number: 77 }),
      "pr",
    );
  });

  it("does NOT enqueue CI_FIXER_PROBLEMATIC when ci-fixer is disabled per-repo", async () => {
    const pr = mockPR({ number: 77, labels: [{ name: "Claws Problematic" }] });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockIsJobDisabledForRepo.mockImplementation((name: string) => name === "ci-fixer");

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain("ci-fixer:problematic");
    // Queue UI still shows it
    expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith(
      "problematic",
      repo.fullName,
      expect.objectContaining({ number: 77 }),
      "pr",
    );
  });

  it("does NOT enqueue CI_FIXER_PROBLEMATIC when PR is skippable", async () => {
    const pr = mockPR({ number: 78, labels: [{ name: "Claws Problematic" }] });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.isDispatchSkippable.mockReturnValue(true);

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain("ci-fixer:problematic");
  });

  it("CI_FIXER_RERUN sweep is enqueued when any PR yields a rerun item", async () => {
    const pr = mockPR({ number: 42 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockCiFixer.identifyPRWork.mockResolvedValueOnce({ kind: "rerun", repo, pr, runId: "999" });

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("ci-fixer:rerun");
  });

  it("does not enqueue when listPRs throws — error is reported", async () => {
    mockGh.listPRs.mockRejectedValue(new Error("boom"));

    await run([repo]);

    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  describe("Phase 6: surface Ready PRs in queue UI", () => {
    it("populates ready cache for PR with Ready label", async () => {
      const pr = mockPR({ number: 55, title: "Ready PR", labels: [{ name: "Ready" }] });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });

      await run([repo]);

      expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith(
        "ready", repo.fullName,
        expect.objectContaining({ number: 55, title: "Ready PR" }),
        "pr",
      );
    });

    it("does not populate ready cache for PR processed by review-addresser this cycle", async () => {
      const pr = mockPR({ number: 56, title: "Needs Review Addressing", labels: [{ name: "Ready" }] });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getPRReviewComments.mockResolvedValue({
        formatted: "Please fix this",
        commentIds: [100],
        reviewCommentIds: [],
      });

      await run([repo]);

      const readyCalls = mockGh.populateQueueCacheFor.mock.calls.filter((c) => c[0] === "ready");
      expect(readyCalls).toHaveLength(0);
    });

    it("does not populate ready cache for fork PR with Ready label", async () => {
      const pr = mockPR({ number: 57, labels: [{ name: "Ready" }] });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.isForkPR.mockReturnValue(true);
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });

      await run([repo]);

      const readyCalls = mockGh.populateQueueCacheFor.mock.calls.filter((c) => c[0] === "ready");
      expect(readyCalls).toHaveLength(0);
    });

    it("does not populate ready cache for skippable PR with Ready label", async () => {
      const pr = mockPR({ number: 58, labels: [{ name: "Ready" }] });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.isDispatchSkippable.mockReturnValue(true);
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });

      await run([repo]);

      const readyCalls = mockGh.populateQueueCacheFor.mock.calls.filter((c) => c[0] === "ready");
      expect(readyCalls).toHaveLength(0);
    });

    it("does not populate ready cache for PR without Ready label", async () => {
      const pr = mockPR({ number: 60, labels: [] });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });

      await run([repo]);

      const readyCalls = mockGh.populateQueueCacheFor.mock.calls.filter((c) => c[0] === "ready");
      expect(readyCalls).toHaveLength(0);
    });

    it("does not populate ready cache for PR with active ci-fixer work", async () => {
      const pr = mockPR({ number: 61, labels: [{ name: "Ready" }] });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockCiFixer.identifyPRWork.mockResolvedValueOnce({ kind: "fix", repo, pr });
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });

      await run([repo]);

      const readyCalls = mockGh.populateQueueCacheFor.mock.calls.filter((c) => c[0] === "ready");
      expect(readyCalls).toHaveLength(0);
    });
  });

  describe("sweepEmptyPRs", () => {
    const OLD_CREATED_AT = "2026-01-01T00:00:00Z";

    it("closes an empty PR older than 10 minutes when the live re-check also finds it empty", async () => {
      const pr = mockPR({ number: 10, changedFiles: 0, additions: 0, deletions: 0, createdAt: OLD_CREATED_AT });

      const closed = await sweepEmptyPRs(repo, [pr]);

      expect(closed.has(10)).toBe(true);
      expect(mockGh.closePR).toHaveBeenCalledWith(repo.fullName, 10);
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        10,
        expect.any(String),
        { agentName: "Empty PR Closer" },
      );
    });

    it("does not close a PR with changedFiles: 5", async () => {
      const pr = mockPR({ number: 11, changedFiles: 5, additions: 1, deletions: 1, createdAt: OLD_CREATED_AT });

      const closed = await sweepEmptyPRs(repo, [pr]);

      expect(closed.size).toBe(0);
      expect(mockGh.closePR).not.toHaveBeenCalled();
    });

    it("does not close an empty PR created just now", async () => {
      const pr = mockPR({ number: 12, changedFiles: 0, additions: 0, deletions: 0, createdAt: new Date().toISOString() });

      const closed = await sweepEmptyPRs(repo, [pr]);

      expect(closed.size).toBe(0);
      expect(mockGh.closePR).not.toHaveBeenCalled();
    });

    it("does not close a draft empty PR", async () => {
      const pr = mockPR({ number: 13, changedFiles: 0, additions: 0, deletions: 0, createdAt: OLD_CREATED_AT, isDraft: true });

      const closed = await sweepEmptyPRs(repo, [pr]);

      expect(closed.size).toBe(0);
      expect(mockGh.closePR).not.toHaveBeenCalled();
    });

    it("does not close a fork PR", async () => {
      const pr = mockPR({ number: 14, changedFiles: 0, additions: 0, deletions: 0, createdAt: OLD_CREATED_AT });
      mockGh.isForkPR.mockReturnValue(true);

      const closed = await sweepEmptyPRs(repo, [pr]);

      expect(closed.size).toBe(0);
      expect(mockGh.closePR).not.toHaveBeenCalled();
    });

    it("does not close a PR with changedFiles undefined", async () => {
      const pr = mockPR({ number: 15, createdAt: OLD_CREATED_AT });

      const closed = await sweepEmptyPRs(repo, [pr]);

      expect(closed.size).toBe(0);
      expect(mockGh.closePR).not.toHaveBeenCalled();
    });

    it("skips PRs with active work and never calls getPRDiffStats", async () => {
      const pr = mockPR({ number: 16, changedFiles: 0, additions: 0, deletions: 0, createdAt: OLD_CREATED_AT });
      mockDb.hasActiveWorkForPR.mockReturnValue(true);

      const closed = await sweepEmptyPRs(repo, [pr]);

      expect(closed.size).toBe(0);
      expect(mockGh.getPRDiffStats).not.toHaveBeenCalled();
      expect(mockGh.closePR).not.toHaveBeenCalled();
    });

    it("does not close when the live re-check finds non-empty diff stats", async () => {
      const pr = mockPR({ number: 17, changedFiles: 0, additions: 0, deletions: 0, createdAt: OLD_CREATED_AT });
      mockGh.getPRDiffStats.mockResolvedValue({ changedFiles: 3, additions: 2, deletions: 1, state: "OPEN" });

      const closed = await sweepEmptyPRs(repo, [pr]);

      expect(closed.size).toBe(0);
      expect(mockGh.closePR).not.toHaveBeenCalled();
    });

    it("does not close when the live re-check returns null (PR gone)", async () => {
      const pr = mockPR({ number: 18, changedFiles: 0, additions: 0, deletions: 0, createdAt: OLD_CREATED_AT });
      mockGh.getPRDiffStats.mockResolvedValue(null);

      const closed = await sweepEmptyPRs(repo, [pr]);

      expect(closed.size).toBe(0);
      expect(mockGh.closePR).not.toHaveBeenCalled();
    });

    it("closes the linked issue when a PR for it has already merged", async () => {
      const pr = mockPR({
        number: 19,
        headRefName: "claws/issue-42-foo",
        changedFiles: 0,
        additions: 0,
        deletions: 0,
        createdAt: OLD_CREATED_AT,
      });
      mockGh.getLinkedIssueNumber.mockReturnValue(42);
      mockGh.listMergedPRsForIssue.mockResolvedValue([mockPR({ number: 20 })]);

      await sweepEmptyPRs(repo, [pr]);

      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 42, "completed");
    });

    it("leaves the linked issue open (with an explanatory comment) when no PR for it has merged", async () => {
      const pr = mockPR({
        number: 21,
        headRefName: "claws/issue-43-foo",
        changedFiles: 0,
        additions: 0,
        deletions: 0,
        createdAt: OLD_CREATED_AT,
      });
      mockGh.getLinkedIssueNumber.mockReturnValue(43);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await sweepEmptyPRs(repo, [pr]);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        43,
        expect.any(String),
        { agentName: "Empty PR Closer" },
      );
    });

    it("run() dispatches ci-fixer identification only for the non-empty PR", async () => {
      const emptyPR = mockPR({ number: 22, changedFiles: 0, additions: 0, deletions: 0, createdAt: OLD_CREATED_AT });
      const normalPR = mockPR({ number: 23, changedFiles: 2, additions: 1, deletions: 1, createdAt: OLD_CREATED_AT });
      mockGh.listPRs.mockResolvedValue([emptyPR, normalPR]);

      await run([repo]);

      expect(mockGh.closePR).toHaveBeenCalledWith(repo.fullName, 22);
      expect(mockCiFixer.identifyPRWork).toHaveBeenCalledTimes(1);
      expect(mockCiFixer.identifyPRWork).toHaveBeenCalledWith(repo, expect.objectContaining({ number: 23 }));
    });
  });
});
