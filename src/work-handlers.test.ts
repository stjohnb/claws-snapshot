import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "./test-helpers.js";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    inReview: "In Review",
    problematic: "Claws Problematic",
  },
}));

vi.mock("./log.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    runContext: new AsyncLocalStorage(),
  };
});

vi.mock("./shutdown.js", () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
  ShutdownError: class ShutdownError extends Error {},
}));

const mockDb = vi.hoisted(() => ({
  hasActiveWorkForPR: vi.fn().mockReturnValue(false),
}));
vi.mock("./db.js", () => mockDb);

const mockGh = vi.hoisted(() => ({
  listRepos: vi.fn(),
  listPRs: vi.fn().mockResolvedValue([]),
  listOpenIssues: vi.fn().mockResolvedValue([]),
  isItemSkipped: vi.fn().mockReturnValue(false),
  hasIgnoreLabel: vi.fn().mockReturnValue(false),
  hasPriorityLabel: vi.fn().mockReturnValue(false),
  isForkPR: vi.fn().mockReturnValue(false),
  getPRReviewComments: vi.fn().mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] }),
  getPRMergeableState: vi.fn().mockResolvedValue("MERGEABLE"),
  rerunWorkflow: vi.fn().mockResolvedValue(undefined),
  populateQueueCache: vi.fn(),
  removeQueueItem: vi.fn(),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("./github.js", () => mockGh);

const mockCiFixer = vi.hoisted(() => ({
  identifyPRWork: vi.fn().mockResolvedValue(null),
  resolveConflicts: vi.fn().mockResolvedValue(undefined),
  runCIFix: vi.fn().mockResolvedValue(undefined),
  reportRunNotRerunnable: vi.fn().mockResolvedValue(undefined),
  performRerun: vi.fn().mockResolvedValue(true),
}));
vi.mock("./agents/ci-fixer.js", () => mockCiFixer);

const mockProblematicDiagnoser = vi.hoisted(() => ({
  runDiagnosis: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./agents/problematic-pr-diagnoser.js", () => mockProblematicDiagnoser);

const mockReviewAddresser = vi.hoisted(() => ({
  processPR: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./agents/review-addresser.js", () => mockReviewAddresser);

const mockPrReviewer = vi.hoisted(() => ({
  hasNewCommitsSinceLastReview: vi.fn().mockResolvedValue(false),
  getPendingRebuttal: vi.fn().mockResolvedValue(null),
  maybeAddReadyLabel: vi.fn().mockResolvedValue(undefined),
  processPR: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./agents/pr-reviewer.js", () => mockPrReviewer);

const mockAutoMerger = vi.hoisted(() => ({
  tryMerge: vi.fn().mockResolvedValue(false),
}));
vi.mock("./agents/auto-merger.js", () => mockAutoMerger);

vi.mock("./agents/issue-refiner.js", () => ({
  PLAN_HEADER: "## Plan",
  findUnreactedHumanComments: vi.fn().mockResolvedValue([]),
  processIssue: vi.fn(),
  processRefinement: vi.fn(),
  processFollowUp: vi.fn(),
}));

vi.mock("./agents/issue-worker.js", () => ({
  processIssue: vi.fn(),
  checkAndContinue: vi.fn(),
}));

const { handlerMap, mockEnqueue, AGENT_KINDS } = vi.hoisted(() => ({
  handlerMap: new Map<string, (row: any, args: any) => Promise<void>>(),
  mockEnqueue: vi.fn().mockReturnValue({ id: 1, alreadyQueued: false }),
  AGENT_KINDS: {
    CI_FIXER_CONFLICT: "ci-fixer:conflict",
    CI_FIXER: "ci-fixer",
    CI_FIXER_RERUN: "ci-fixer:rerun",
    CI_FIXER_PROBLEMATIC: "ci-fixer:problematic",
    REVIEW_ADDRESSER: "review-addresser",
    PR_REVIEWER: "pr-reviewer",
    AUTO_MERGER_SWEEP: "auto-merger:sweep",
    ISSUE_WORKER: "issue-worker",
    ISSUE_WORKER_CONTINUE: "issue-worker:continue",
    ISSUE_REFINER_FOLLOWUP: "issue-refiner:followup",
    ISSUE_REFINER_PLAN: "issue-refiner:plan",
    ISSUE_REFINER_REFINE: "issue-refiner:refine",
  } as const,
}));
vi.mock("./worker.js", () => ({
  enqueue: (...args: any[]) => mockEnqueue(...args),
  registerHandler: (kind: string, fn: any) => {
    handlerMap.set(kind, fn);
  },
  AGENT_KINDS,
}));

import { registerAll } from "./work-handlers.js";

const repo = mockRepo();

beforeEach(() => {
  vi.clearAllMocks();
  handlerMap.clear();
  mockGh.listRepos.mockResolvedValue([repo]);
  mockGh.isForkPR.mockReturnValue(false);
  mockGh.hasPriorityLabel.mockReturnValue(false);
  mockDb.hasActiveWorkForPR.mockReturnValue(false);
  registerAll();
});

function fakeRow(kind: string, repoName: string, item: number) {
  return {
    id: 1,
    kind,
    repo: repoName,
    item_number: item,
    args_json: "{}",
    priority: 0,
    status: "running",
    pid: process.pid,
    attempts: 1,
    error_message: null,
    enqueued_at: "",
    started_at: null,
    completed_at: null,
    run_id: null,
  };
}

describe("work-handlers — sweep enqueue after PR-mutating handlers", () => {
  it("PR_REVIEWER handler enqueues AUTO_MERGER_SWEEP after no-review path", async () => {
    const pr = mockPR({ number: 42 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockPrReviewer.hasNewCommitsSinceLastReview.mockResolvedValue(false);

    const handler = handlerMap.get(AGENT_KINDS.PR_REVIEWER)!;
    await handler(fakeRow(AGENT_KINDS.PR_REVIEWER, repo.fullName, 42), {});

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      AGENT_KINDS.AUTO_MERGER_SWEEP,
      repo.fullName,
      0,
      expect.objectContaining({ priority: false }),
    );
  });

  it("PR_REVIEWER handler enqueues AUTO_MERGER_SWEEP after a real review", async () => {
    const pr = mockPR({ number: 7 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockPrReviewer.hasNewCommitsSinceLastReview.mockResolvedValue(true);

    const handler = handlerMap.get(AGENT_KINDS.PR_REVIEWER)!;
    await handler(fakeRow(AGENT_KINDS.PR_REVIEWER, repo.fullName, 7), {});

    expect(mockPrReviewer.processPR).toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledWith(
      AGENT_KINDS.AUTO_MERGER_SWEEP,
      repo.fullName,
      0,
      expect.any(Object),
    );
  });

  it("PR_REVIEWER handler reviews on a pending rebuttal even without new commits", async () => {
    const pr = mockPR({ number: 55 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockPrReviewer.hasNewCommitsSinceLastReview.mockResolvedValue(false);
    mockPrReviewer.getPendingRebuttal.mockResolvedValue("The blocking claim is factually wrong.");

    const handler = handlerMap.get(AGENT_KINDS.PR_REVIEWER)!;
    await handler(fakeRow(AGENT_KINDS.PR_REVIEWER, repo.fullName, 55), {});

    expect(mockPrReviewer.processPR).toHaveBeenCalled();
    expect(mockPrReviewer.maybeAddReadyLabel).not.toHaveBeenCalled();
  });

  it("PR_REVIEWER handler falls back to maybeAddReadyLabel when there is no rebuttal", async () => {
    const pr = mockPR({ number: 56 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockPrReviewer.hasNewCommitsSinceLastReview.mockResolvedValue(false);
    mockPrReviewer.getPendingRebuttal.mockResolvedValue(null);

    const handler = handlerMap.get(AGENT_KINDS.PR_REVIEWER)!;
    await handler(fakeRow(AGENT_KINDS.PR_REVIEWER, repo.fullName, 56), {});

    expect(mockPrReviewer.processPR).not.toHaveBeenCalled();
    expect(mockPrReviewer.maybeAddReadyLabel).toHaveBeenCalledWith(repo.fullName, 56);
  });

  it("PR_REVIEWER handler still enqueues sweep when processPR throws", async () => {
    const pr = mockPR({ number: 11 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockPrReviewer.hasNewCommitsSinceLastReview.mockResolvedValue(true);
    mockPrReviewer.processPR.mockRejectedValueOnce(new Error("boom"));

    const handler = handlerMap.get(AGENT_KINDS.PR_REVIEWER)!;
    await expect(
      handler(fakeRow(AGENT_KINDS.PR_REVIEWER, repo.fullName, 11), {}),
    ).rejects.toThrow("boom");

    expect(mockEnqueue).toHaveBeenCalledWith(
      AGENT_KINDS.AUTO_MERGER_SWEEP,
      repo.fullName,
      0,
      expect.any(Object),
    );
  });

  it("PR_REVIEWER handler does not enqueue sweep when PR was not found", async () => {
    mockGh.listPRs.mockResolvedValue([]);

    const handler = handlerMap.get(AGENT_KINDS.PR_REVIEWER)!;
    await handler(fakeRow(AGENT_KINDS.PR_REVIEWER, repo.fullName, 99), {});

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("REVIEW_ADDRESSER handler enqueues AUTO_MERGER_SWEEP on the early no-comments return", async () => {
    const pr = mockPR({ number: 21 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });

    const handler = handlerMap.get(AGENT_KINDS.REVIEW_ADDRESSER)!;
    await handler(fakeRow(AGENT_KINDS.REVIEW_ADDRESSER, repo.fullName, 21), {});

    expect(mockEnqueue).toHaveBeenCalledWith(
      AGENT_KINDS.AUTO_MERGER_SWEEP,
      repo.fullName,
      0,
      expect.any(Object),
    );
  });

  it("REVIEW_ADDRESSER handler passes includeAdvisory through from args and keeps Ready", async () => {
    const pr = mockPR({ number: 22 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "Minor nit", commentIds: [], reviewCommentIds: [],
      prReviewComment: { id: 1, body: "…", reviewedCommit: "abc123" }, advisoryOnly: true,
    });

    const handler = handlerMap.get(AGENT_KINDS.REVIEW_ADDRESSER)!;
    await handler(fakeRow(AGENT_KINDS.REVIEW_ADDRESSER, repo.fullName, 22), { advisory: true });

    expect(mockGh.getPRReviewComments).toHaveBeenCalledWith(repo.fullName, 22, { includeAdvisory: true });
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockReviewAddresser.processPR).toHaveBeenCalled();
  });

  it("REVIEW_ADDRESSER handler removes Ready when an advisory dispatch turns out to be blocking", async () => {
    const pr = mockPR({ number: 23 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "Blocking bug", commentIds: [], reviewCommentIds: [],
      prReviewComment: { id: 1, body: "…", reviewedCommit: "abc123" }, advisoryOnly: false,
    });

    const handler = handlerMap.get(AGENT_KINDS.REVIEW_ADDRESSER)!;
    await handler(fakeRow(AGENT_KINDS.REVIEW_ADDRESSER, repo.fullName, 23), { advisory: true });

    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 23, "Ready");
  });

  it("CI_FIXER handler enqueues AUTO_MERGER_SWEEP when there is no work item", async () => {
    const pr = mockPR({ number: 33 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockCiFixer.identifyPRWork.mockResolvedValueOnce(null);

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER, repo.fullName, 33), {});

    expect(mockEnqueue).toHaveBeenCalledWith(
      AGENT_KINDS.AUTO_MERGER_SWEEP,
      repo.fullName,
      0,
      expect.any(Object),
    );
  });

  it("CI_FIXER handler routes conflict work to CI_FIXER_CONFLICT instead of resolving inline", async () => {
    const pr = mockPR({ number: 34 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockCiFixer.identifyPRWork.mockResolvedValueOnce({ kind: "conflict", repo, pr });

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER, repo.fullName, 34), {});

    expect(mockCiFixer.resolveConflicts).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledWith(
      AGENT_KINDS.CI_FIXER_CONFLICT,
      repo.fullName,
      34,
      expect.objectContaining({ priority: expect.anything() }),
    );
  });

  it("CI_FIXER handler skips entirely when conflict resolution is already running", async () => {
    const pr = mockPR({ number: 35 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.hasActiveWorkForPR.mockReturnValue(true);

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER, repo.fullName, 35), {});

    expect(mockCiFixer.identifyPRWork).not.toHaveBeenCalled();
    expect(mockCiFixer.runCIFix).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalledWith(
      AGENT_KINDS.CI_FIXER_CONFLICT,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("CI_FIXER handler still runs the fix when conflict resolution is not running", async () => {
    const pr = mockPR({ number: 36 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.hasActiveWorkForPR.mockReturnValue(false);
    const failedCheck = { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/1" };
    mockCiFixer.identifyPRWork.mockResolvedValueOnce({ kind: "fix", repo, pr, failedCheck });

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER, repo.fullName, 36), {});

    expect(mockCiFixer.runCIFix).toHaveBeenCalledWith(repo, pr, failedCheck);
  });

  it("CI_FIXER handler skips when problematic diagnosis is already running", async () => {
    const pr = mockPR({ number: 37 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.hasActiveWorkForPR.mockImplementation((_repo: string, _n: number, kinds: string[]) =>
      kinds.includes(AGENT_KINDS.CI_FIXER_PROBLEMATIC),
    );

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER, repo.fullName, 37), {});

    expect(mockCiFixer.identifyPRWork).not.toHaveBeenCalled();
    expect(mockCiFixer.runCIFix).not.toHaveBeenCalled();
  });

  it("CI_FIXER_PROBLEMATIC handler skips when a ci-fixer job is already running", async () => {
    const pr = mockPR({ number: 38, labels: [{ name: "Claws Problematic" }] });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.hasActiveWorkForPR.mockImplementation((_repo: string, _n: number, kinds: string[]) =>
      kinds.includes(AGENT_KINDS.CI_FIXER),
    );

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER_PROBLEMATIC)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER_PROBLEMATIC, repo.fullName, 38), {});

    expect(mockProblematicDiagnoser.runDiagnosis).not.toHaveBeenCalled();
  });

  it("CI_FIXER_PROBLEMATIC handler runs diagnosis when no ci-fixer job is active", async () => {
    const pr = mockPR({ number: 39, labels: [{ name: "Claws Problematic" }] });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.hasActiveWorkForPR.mockReturnValue(false);

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER_PROBLEMATIC)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER_PROBLEMATIC, repo.fullName, 39), {});

    expect(mockProblematicDiagnoser.runDiagnosis).toHaveBeenCalledWith(repo, pr);
  });

  it("CI_FIXER_CONFLICT handler enqueues AUTO_MERGER_SWEEP after resolving conflicts", async () => {
    const pr = mockPR({ number: 55 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER_CONFLICT)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER_CONFLICT, repo.fullName, 55), {});

    expect(mockEnqueue).toHaveBeenCalledWith(
      AGENT_KINDS.AUTO_MERGER_SWEEP,
      repo.fullName,
      0,
      expect.any(Object),
    );
  });

  it("CI_FIXER_CONFLICT handler does not enqueue sweep when PR is not conflicting", async () => {
    const pr = mockPR({ number: 55 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER_CONFLICT)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER_CONFLICT, repo.fullName, 55), {});

    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

// Both handlers delegate every rerun to ciFixer.performRerun, which owns the
// not-rerunnable reporting and the runner-outage path (covered in ci-fixer.test.ts).
describe("work-handlers — CI rerun delegation", () => {
  it("CI_FIXER handler routes a rerun item through performRerun", async () => {
    const pr = mockPR({ number: 66 });
    mockGh.listPRs.mockResolvedValue([pr]);
    const item = { kind: "rerun", repo, pr, runId: "123" };
    mockCiFixer.identifyPRWork.mockResolvedValueOnce(item);

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER, repo.fullName, 66), {});

    expect(mockCiFixer.performRerun).toHaveBeenCalledWith(item);
    expect(mockGh.rerunWorkflow).not.toHaveBeenCalled();
    expect(mockCiFixer.reportRunNotRerunnable).not.toHaveBeenCalled();
  });

  it("CI_FIXER_RERUN handler routes each rerun item through performRerun", async () => {
    const pr = mockPR({ number: 78 });
    mockGh.listPRs.mockResolvedValue([pr]);
    const item = { kind: "rerun", repo, pr, runId: "999", infra: true };
    mockCiFixer.identifyPRWork.mockResolvedValueOnce(item);

    const handler = handlerMap.get(AGENT_KINDS.CI_FIXER_RERUN)!;
    await handler(fakeRow(AGENT_KINDS.CI_FIXER_RERUN, repo.fullName, 0), {});

    expect(mockCiFixer.performRerun).toHaveBeenCalledWith(item);
    expect(mockGh.rerunWorkflow).not.toHaveBeenCalled();
  });
});
