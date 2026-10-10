import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

const mockIsAgentDisabled = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockIsJobDisabledForRepo = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock("../config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    problematic: "Claws Problematic",
    automerge: "Automerge",
    manualAction: "Manual Action",
    clawsStaging: "Claws Staging",
    clawsIgnore: "Claws Ignore",
    blocked: "Blocked",
    backlog: "Backlog",
    needsLgtm: "Needs LGTM",
    billing: "Billing",
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
  invalidatePRList: vi.fn(),
  isDispatchSkippable: vi.fn().mockReturnValue(false),
  hasPriorityLabel: vi.fn().mockReturnValue(false),
  isForkPR: vi.fn().mockReturnValue(false),
  isDependabotPR: vi.fn().mockReturnValue(false),
  normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
  listOpenIssues: vi.fn().mockResolvedValue([]),
  listRecentlyClosedIssues: vi.fn().mockResolvedValue([]),
  getPRBody: vi.fn().mockResolvedValue(""),
  fetchRepoFileWithSha: vi.fn().mockResolvedValue(null),
  getIssueComments: vi.fn().mockResolvedValue([]),
  getPRReviewComments: vi.fn().mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] }),
  getPRMergeableState: vi.fn().mockResolvedValue("MERGEABLE"),
  populateQueueCache: vi.fn(),
  populateQueueCacheFor: vi.fn(),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  addLabel: vi.fn().mockResolvedValue(undefined),
  isRateLimited: vi.fn().mockReturnValue(false),
  isRepoRateLimited: vi.fn().mockReturnValue(false),
  describeRateLimit: vi.fn().mockReturnValue(null),
  RateLimitError: class RateLimitError extends Error {},
  getPRDiffStats: vi.fn().mockResolvedValue({ changedFiles: 0, additions: 0, deletions: 0, state: "OPEN" }),
  closePR: vi.fn().mockResolvedValue(undefined),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  closeIssue: vi.fn().mockResolvedValue(undefined),
  getIssueState: vi.fn().mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] }),
  listMergedPRsForIssue: vi.fn().mockResolvedValue([]),
  getLinkedIssueNumber: vi.fn().mockReturnValue(null),
  removeQueueItem: vi.fn(),
  reconcileQueueCache: vi.fn(),
  listPRStatuses: vi.fn().mockResolvedValue(new Map()),
  getPRState: vi.fn().mockResolvedValue("OPEN"),
  getPRCheckStatus: vi.fn().mockResolvedValue("passing"),
  getLabelApplier: vi.fn().mockResolvedValue(null),
  isAllowedHumanActor: vi.fn().mockResolvedValue(false),
  listHeldWorkflowRuns: vi.fn().mockResolvedValue([]),
  approveWorkflowRun: vi.fn().mockResolvedValue(undefined),
  setDispatchNote: vi.fn(),
  // Mirrors isDispatchSkippable unless a test names the reason.
  dispatchSkipReason: vi.fn((repo: string, pr: unknown): string | null => (mockGh.isDispatchSkippable(repo, pr) ? "parked" : null)),
  freshDispatchNote: vi.fn((row: { dispatchNote?: string | null } | undefined) => row?.dispatchNote ?? undefined),
}));
vi.mock("../github.js", () => mockGh);

const mockDb = vi.hoisted(() => ({
  hasActiveWorkForPR: vi.fn().mockReturnValue(false),
  initDb: vi.fn(),
  closeDb: vi.fn(),
  clearAllWorkQueueForTests: vi.fn(),
  listClawsPrs: vi.fn().mockResolvedValue([]),
  getClawsPr: vi.fn().mockResolvedValue(null),
  upsertClawsPr: vi.fn().mockResolvedValue(undefined),
  findIssuePlannedPRByNumber: vi.fn().mockResolvedValue(null),
  getLatestPRReview: vi.fn().mockResolvedValue(null),
}));
vi.mock("../db.js", () => mockDb);

const mockCiFixer = vi.hoisted(() => ({
  identifyPRWork: vi.fn().mockResolvedValue(null),
  clearNotRerunnableIfResolved: vi.fn().mockResolvedValue(false),
  getIdentifySkipReason: vi.fn().mockReturnValue(undefined),
  pruneIdentifySkipReasons: vi.fn(),
}));
vi.mock("../agents/ci-fixer.js", () => mockCiFixer);

const mockAutoMerger = vi.hoisted(() => ({
  isApprovalExempt: vi.fn().mockResolvedValue(false),
  isAutoBumpPR: vi.fn().mockReturnValue(false),
  checkAutoBumpDiff: vi.fn().mockResolvedValue({ ok: true }),
  finalizeMergedClawsPR: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../agents/auto-merger.js", () => mockAutoMerger);

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

import * as log from "../log.js";
import type * as gh from "../github.js";
import { reportError } from "../error-reporter.js";
import { run, sweepEmptyPRs, sweepStackedPRs, refreshPrStore, clearActionRequiredHolds, resetHeldRunChecksForTests } from "./pr-dispatcher.js";
import { heldRunCount, resetHeldRunCountsForTests, resetRejectedHeldRunsForTests } from "../workflow-hold.js";
import { initDb, closeDb, clearAllWorkQueueForTests } from "../db.js";

/** A `claws_prs` row — the PR state dispatch reads, never `pr.labels`. */
function prRow(prNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    repo: mockRepo().fullName, prNumber, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, createdAt: "", updatedAt: "", ...overrides,
  };
}

describe("pr-dispatcher — enqueue coordination", () => {
  const repo = mockRepo();

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllWorkQueueForTests();
    mockIsAgentDisabled.mockReturnValue(false);
    mockIsJobDisabledForRepo.mockReturnValue(false);
    mockGh.isRateLimited.mockReturnValue(false);
    mockGh.isRepoRateLimited.mockReturnValue(false);
    mockGh.describeRateLimit.mockReturnValue(null);
    mockGh.isDispatchSkippable.mockReturnValue(false);
    mockGh.isForkPR.mockReturnValue(false);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getPRDiffStats.mockResolvedValue({ changedFiles: 0, additions: 0, deletions: 0, state: "OPEN" });
    mockGh.getLinkedIssueNumber.mockReturnValue(null);
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockDb.hasActiveWorkForPR.mockReturnValue(false);
    mockWorker.enqueue.mockReturnValue({ id: 1, alreadyQueued: false });
    mockAutoMerger.isApprovalExempt.mockResolvedValue(false);
    mockAutoMerger.isAutoBumpPR.mockReturnValue(false);
    mockAutoMerger.checkAutoBumpDiff.mockResolvedValue({ ok: true });
    mockDb.listClawsPrs.mockResolvedValue([]);
    mockCiFixer.identifyPRWork.mockResolvedValue(null);
    mockCiFixer.getIdentifySkipReason.mockReturnValue(undefined);
  });

  it("skips GitHub repos and logs while the breaker is open (#3221)", async () => {
    mockGh.isRateLimited.mockReturnValue(true);
    mockGh.isRepoRateLimited.mockReturnValue(true);
    mockGh.describeRateLimit.mockReturnValue("until 12:00:00Z (30m)");
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 42 })]);

    await run([repo]);

    expect(mockGh.listPRs).not.toHaveBeenCalled();
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("until 12:00:00Z (30m)"));
  });

  it("keeps dispatching Forgejo repos while the GitHub breaker is open (#3221)", async () => {
    const forgejoRepo = mockRepo({ owner: "test-org", name: "fj-repo", fullName: "test-org/fj-repo" });
    mockGh.isRateLimited.mockReturnValue(true);
    mockGh.isRepoRateLimited.mockImplementation((fullName: string) => fullName !== forgejoRepo.fullName);
    mockGh.describeRateLimit.mockReturnValue("until 12:00:00Z (30m)");
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 42 })]);

    await run([repo, forgejoRepo]);

    // Forgejo reads never touch GitHub's budget, so only the GitHub repo is skipped.
    expect(mockGh.listPRs).toHaveBeenCalledTimes(1);
    expect(mockGh.listPRs).toHaveBeenCalledWith(forgejoRepo.fullName);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("Skipping 1 GitHub repo(s)"));
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

  describe("third-party update PRs", () => {
    beforeEach(() => {
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("enqueues a renovate/* PR for review at 14:00 Europe/London like a non-bot PR", async () => {
      vi.setSystemTime(new Date("2026-09-24T13:00:00Z")); // 14:00 BST
      // fleet-infra's Renovate runs with a PAT, so its PRs carry a human author.
      const pr = mockPR({ number: 60, headRefName: "renovate/helm-chart", author: { login: "stjohnb" } });
      mockGh.listPRs.mockResolvedValue([pr]);

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).toContain("pr-reviewer");
    });
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

  it("staging mode only enqueues staging-labelled PRs", async () => {
    const plain = mockPR({ number: 50, labels: [], changedFiles: 1 });
    const staging = mockPR({ number: 51, labels: [{ name: "Claws Staging" }], changedFiles: 1 });
    mockGh.listPRs.mockResolvedValue([plain, staging]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "",
      commentIds: [],
      reviewCommentIds: [],
    });
    mockGh.isDispatchSkippable.mockImplementation((_repo: string, pr: { labels: { name: string }[] }) =>
      !pr.labels.some((l) => l.name === "Claws Staging"),
    );

    await run([repo]);

    expect(mockWorker.enqueue).not.toHaveBeenCalledWith(
      "pr-reviewer",
      repo.fullName,
      50,
      expect.anything(),
    );
    expect(mockWorker.enqueue).toHaveBeenCalledWith(
      "pr-reviewer",
      repo.fullName,
      51,
      { priority: false },
    );
  });

  it("does not enqueue unlabelled PR work when a live activation flip disables the work pipeline", async () => {
    const pr = mockPR({ number: 52, labels: [], changedFiles: 1 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.isDispatchSkippable.mockReturnValue(true);
    mockGh.dispatchSkipReason.mockReturnValueOnce("work pipeline paused");

    await run([repo]);

    expect(mockWorker.enqueue).not.toHaveBeenCalledWith(
      "pr-reviewer",
      repo.fullName,
      52,
      expect.anything(),
    );
    expect(mockWorker.enqueue).not.toHaveBeenCalledWith(
      "review-addresser",
      repo.fullName,
      52,
      expect.anything(),
    );
    expect(mockWorker.enqueue).not.toHaveBeenCalledWith(
      "ci-fixer",
      repo.fullName,
      52,
      expect.anything(),
    );
    // Still visible on the queue, with the reason nothing acts on it.
    expect(mockGh.populateQueueCacheFor.mock.calls).toEqual([
      ["needs-review", repo.fullName, pr, "pr", "not dispatched: work pipeline paused"],
    ]);
  });

  it("pr-reviewer is skipped when ci-fixer fix work is enqueued for the same PR", async () => {
    const pr = mockPR({ number: 42 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockCiFixer.identifyPRWork.mockResolvedValueOnce({ kind: "fix", repo, pr, failedCheck: { name: "ci", runId: "1" } });
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "",
      commentIds: [],
      reviewCommentIds: [],
    });

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("ci-fixer");
    expect(kinds).not.toContain("pr-reviewer");
  });

  it("pr-reviewer is still enqueued when the only ci-fixer work is a rerun", async () => {
    const pr = mockPR({ number: 42 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockCiFixer.identifyPRWork.mockResolvedValueOnce({ kind: "rerun", repo, pr, runId: "1" });
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "",
      commentIds: [],
      reviewCommentIds: [],
    });

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("pr-reviewer");
    expect(kinds).toContain("ci-fixer:rerun");
  });

  // A PR whose current head already carries a clean review is waiting only on a
  // human to merge — re-reviewing it is work nothing asked for (issue clw_01M3F9340HHVH185YR16PXVKWK).
  it("skips pr-reviewer for a PR whose reviewed head already awaits merge (clean verdict)", async () => {
    const pr = mockPR({ number: 42, headRefOid: "abc123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.listClawsPrs.mockResolvedValue([
      prRow(42, { stage: "awaiting-merge", reviewVerdict: "clean", reviewedSha: "abc123", headSha: "abc123" }),
    ]);

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain("pr-reviewer");
  });

  it("still enqueues pr-reviewer for an idle PR whose review is only advisory", async () => {
    const pr = mockPR({ number: 42, headRefOid: "abc123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.listClawsPrs.mockResolvedValue([
      prRow(42, { stage: "awaiting-merge", reviewVerdict: "advisory", reviewedSha: "abc123", headSha: "abc123" }),
    ]);

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("pr-reviewer");
  });

  it("still enqueues pr-reviewer once the head has moved past the reviewed commit", async () => {
    const pr = mockPR({ number: 42, headRefOid: "def456" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.listClawsPrs.mockResolvedValue([
      prRow(42, { stage: "awaiting-merge", reviewVerdict: "clean", reviewedSha: "abc123", headSha: "abc123" }),
    ]);

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("pr-reviewer");
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

  describe("advisory-only reviews (#2230)", () => {
    const advisoryReview = {
      formatted: "Minor nit on line 5",
      commentIds: [],
      reviewCommentIds: [],
      prReviewComment: { id: 971, body: "…", reviewedCommit: "abc123" },
      advisoryOnly: true,
    };
    const readyPR = () => mockPR({ number: 42 });
    beforeEach(() => {
      mockDb.listClawsPrs.mockResolvedValue([prRow(42, { stage: "awaiting-merge" })]);
    });

    it("fires the addresser and retains Ready when the PR is idle", async () => {
      mockGh.listPRs.mockResolvedValue([readyPR()]);
      mockGh.getPRReviewComments.mockResolvedValue(advisoryReview);

      await run([repo]);

      const calls = mockWorker.enqueue.mock.calls.filter((c) => c[0] === "review-addresser");
      expect(calls).toHaveLength(1);
      expect(calls[0][3]).toMatchObject({ args: { advisory: true } });
      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 42, "Ready");
      // Ready is retained, so the PR stays surfaced in the "ready" queue cache.
      expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith("ready", repo.fullName, expect.objectContaining({ number: 42 }), "pr");
      // …and pr-reviewer does not re-review it in the same cycle.
      expect(mockWorker.enqueue.mock.calls.map((c) => c[0])).not.toContain("pr-reviewer");
    });

    it("skips when the merge is approved", async () => {
      mockDb.listClawsPrs.mockResolvedValue([prRow(42, { stage: "awaiting-merge", mergeApprovedAt: "t", mergeApprovedBy: "dashboard" })]);
      mockGh.listPRs.mockResolvedValue([readyPR()]);
      mockGh.getPRReviewComments.mockResolvedValue(advisoryReview);

      await run([repo]);

      expect(mockWorker.enqueue.mock.calls.map((c) => c[0])).not.toContain("review-addresser");
      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 42, "Ready");
    });

    it("skips approval-exempt PRs (dependabot, docs, ideas-collection, auto-bump)", async () => {
      mockGh.listPRs.mockResolvedValue([readyPR()]);
      mockGh.getPRReviewComments.mockResolvedValue(advisoryReview);
      mockAutoMerger.isApprovalExempt.mockResolvedValue(true);

      await run([repo]);

      expect(mockWorker.enqueue.mock.calls.map((c) => c[0])).not.toContain("review-addresser");
      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 42, "Ready");
    });

    it("leaves a trusted Renovate PR's branch alone — pushing nits would fight Renovate", async () => {
      const renovatePR = mockPR({ number: 42, headRefName: "renovate/ollama-ollama-0.x", author: { login: "stjohnb" } });
      mockGh.listPRs.mockResolvedValue([renovatePR]);
      mockGh.getPRReviewComments.mockResolvedValue(advisoryReview);
      mockAutoMerger.isApprovalExempt.mockImplementation(async (_repo: string, pr: { headRefName: string }) =>
        pr.headRefName.startsWith("renovate/"));

      await run([repo]);

      expect(mockAutoMerger.isApprovalExempt).toHaveBeenCalledWith(repo.fullName, renovatePR, expect.anything());
      expect(mockWorker.enqueue.mock.calls.map((c) => c[0])).not.toContain("review-addresser");
    });

    it("skips when the PR is not awaiting merge, whatever its labels (not idle-and-mergeable)", async () => {
      mockDb.listClawsPrs.mockResolvedValue([prRow(42)]);
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 42, labels: [{ name: "Ready" }] })]);
      mockGh.getPRReviewComments.mockResolvedValue(advisoryReview);

      await run([repo]);

      expect(mockWorker.enqueue.mock.calls.map((c) => c[0])).not.toContain("review-addresser");
    });

    it("a blocking review still removes Ready and enqueues without the advisory flag", async () => {
      mockGh.listPRs.mockResolvedValue([readyPR()]);
      mockGh.getPRReviewComments.mockResolvedValue({
        formatted: "Blocking bug on line 20",
        commentIds: [],
        reviewCommentIds: [],
        prReviewComment: { id: 972, body: "…", reviewedCommit: "abc123" },
        advisoryOnly: false,
      });

      await run([repo]);

      const calls = mockWorker.enqueue.mock.calls.filter((c) => c[0] === "review-addresser");
      expect(calls).toHaveLength(1);
      expect(calls[0][3]).not.toHaveProperty("args");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 42, "Ready");
    });
  });

  it("does not enqueue an auto-merger sweep — the auto-merger scheduler job owns it (#2971)", async () => {
    mockGh.listPRs.mockResolvedValue([]);

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain("auto-merger:sweep");
  });

  it("a forge Claws Problematic label alone does not make a PR problematic", async () => {
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 77, labels: [{ name: "Claws Problematic" }] })]);
    mockDb.listClawsPrs.mockResolvedValue([prRow(77)]);

    await run([repo]);

    expect(mockWorker.enqueue.mock.calls.map((c) => c[0])).not.toContain("ci-fixer:problematic");
    expect(mockGh.populateQueueCacheFor).not.toHaveBeenCalledWith("problematic", repo.fullName, expect.anything(), "pr");
  });

  it("PR whose row is problematic is enqueued for CI_FIXER_PROBLEMATIC", async () => {
    const pr = mockPR({ number: 77 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.listClawsPrs.mockResolvedValue([prRow(77, { stage: "problematic" })]);

    await run([repo]);

    const calls = mockWorker.enqueue.mock.calls.filter((c) => c[0] === "ci-fixer:problematic");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(repo.fullName);
    expect(calls[0][2]).toBe(pr.number);
    // problematic PR is also surfaced on the dashboard
    expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith(
      "problematic",
      repo.fullName,
      expect.objectContaining({ number: 77 }),
      "pr",
    );
  });

  it("does NOT enqueue CI_FIXER_PROBLEMATIC when ci-fixer agent is disabled", async () => {
    const pr = mockPR({ number: 77 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.listClawsPrs.mockResolvedValue([prRow(77, { stage: "problematic" })]);
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
    const pr = mockPR({ number: 77 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.listClawsPrs.mockResolvedValue([prRow(77, { stage: "problematic" })]);
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
    const pr = mockPR({ number: 78 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.listClawsPrs.mockResolvedValue([prRow(78, { stage: "problematic" })]);
    mockGh.isDispatchSkippable.mockReturnValue(true);

    await run([repo]);

    const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain("ci-fixer:problematic");
  });

  it("calls clearNotRerunnableIfResolved for each listed PR even when ci-fixer agent is disabled", async () => {
    const pr = mockPR({ number: 88 });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockIsAgentDisabled.mockImplementation((name: string) => name === "ci-fixer");

    await run([repo]);

    expect(mockCiFixer.clearNotRerunnableIfResolved).toHaveBeenCalledWith(repo, pr);
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

  describe("Phase 6: surface Ready PRs on the dashboard", () => {
    it("populates ready cache for a PR whose row awaits merge", async () => {
      const pr = mockPR({ number: 55, title: "Ready PR" });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockDb.listClawsPrs.mockResolvedValue([prRow(55, { stage: "awaiting-merge" })]);
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
      mockDb.listClawsPrs.mockResolvedValue([prRow(56, { stage: "awaiting-merge" })]);
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
      mockDb.listClawsPrs.mockResolvedValue([prRow(57, { stage: "awaiting-merge" })]);
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.isForkPR.mockReturnValue(true);
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });

      await run([repo]);

      // Phase 7 still lists it, with a note saying it is never dispatched.
      const readyCalls = mockGh.populateQueueCacheFor.mock.calls.filter((c) => c[0] === "ready");
      expect(readyCalls).toEqual([["ready", repo.fullName, pr, "pr", "fork PR — never dispatched"]]);
    });

    it("does not populate ready cache for skippable PR with Ready label", async () => {
      const pr = mockPR({ number: 58, labels: [{ name: "Ready" }] });
      mockDb.listClawsPrs.mockResolvedValue([prRow(58, { stage: "awaiting-merge" })]);
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.isDispatchSkippable.mockReturnValue(true);
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });

      await run([repo]);

      const readyCalls = mockGh.populateQueueCacheFor.mock.calls.filter((c) => c[0] === "ready");
      expect(readyCalls).toEqual([["ready", repo.fullName, pr, "pr", "not dispatched: parked"]]);
    });

    it("does not populate ready cache for a PR carrying only a forge Ready label", async () => {
      const pr = mockPR({ number: 60, labels: [{ name: "Ready" }] });
      mockDb.listClawsPrs.mockResolvedValue([prRow(60)]);
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

  describe("Phase 7: every open PR has a queue category (#clw_01M4B5GZK2CC3F5MKE4W6P2XZV)", () => {
    const calls = (n: number) => mockGh.populateQueueCacheFor.mock.calls.filter((c) => (c[2] as { number: number }).number === n);

    it("a PR whose only comments are CI bot comments goes to the reviewer and shows as needs-review", async () => {
      const pr = mockPR({ number: 20 });
      mockGh.listPRs.mockResolvedValue([pr]);
      // Forge CI bot comments are filtered out by getPRReviewComments.
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });
      mockDb.listClawsPrs.mockResolvedValue([prRow(20, { stage: "opened", ciStatus: "passing" })]);

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).toContain("pr-reviewer");
      expect(kinds).not.toContain("review-addresser");
      expect(calls(20)).toEqual([["needs-review", repo.fullName, pr, "pr", undefined]]);
    });

    it("a PR stuck in addressing-review with nothing to address is handed to the reviewer and shown as needs-review", async () => {
      const pr = mockPR({ number: 6 });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });
      mockDb.listClawsPrs.mockResolvedValue([prRow(6, { stage: "addressing-review" })]);

      await run([repo]);

      expect(mockWorker.enqueue).toHaveBeenCalledWith("pr-reviewer", repo.fullName, 6, expect.anything());
      expect(calls(6)).toEqual([["needs-review", repo.fullName, pr, "pr", undefined]]);
    });

    it("a ci-failing PR the fixer declines appears as ci-failing with the skip reason", async () => {
      const pr = mockPR({ number: 2 });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockDb.listClawsPrs.mockResolvedValue([prRow(2, { stage: "ci-failing", ciStatus: "failing" })]);
      mockCiFixer.getIdentifySkipReason.mockReturnValue("CI fixer: waiting for \"build\" to finish before attempting a fix");

      await run([repo]);

      expect(calls(2)).toEqual([
        ["ci-failing", repo.fullName, pr, "pr", "CI fixer: waiting for \"build\" to finish before attempting a fix"],
      ]);
    });

    it("a PR the CI fixer is fixing shows as ci-failing while it is worked", async () => {
      const pr = mockPR({ number: 3 });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockDb.listClawsPrs.mockResolvedValue([prRow(3, { stage: "ci-failing" })]);
      mockCiFixer.identifyPRWork.mockResolvedValue({ kind: "fix", repo, pr, failedCheck: { name: "ci" } });

      await run([repo]);

      expect(mockWorker.enqueue).toHaveBeenCalledWith("ci-fixer", repo.fullName, 3, expect.anything());
      expect(calls(3)).toEqual([["ci-failing", repo.fullName, pr, "pr"]]);
    });

    it("a parked PR appears with the skip reason that actually fired", async () => {
      const pr = mockPR({ number: 4, labels: [{ name: "Blocked" }] });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.isDispatchSkippable.mockReturnValue(true);
      mockGh.dispatchSkipReason.mockReturnValueOnce("parked by label Blocked");
      mockDb.listClawsPrs.mockResolvedValue([prRow(4)]);

      await run([repo]);

      expect(calls(4)).toEqual([["needs-review", repo.fullName, pr, "pr", "not dispatched: parked by label Blocked"]]);
    });

    it("shows the dispatch note a work handler stored on the PR's row", async () => {
      // Handlers run in an agent pod under k8s-pod, so the note reaches the service only through claws_prs.
      const pr = mockPR({ number: 11 });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });
      mockDb.listClawsPrs.mockResolvedValue([prRow(11, { stage: "manual-action", dispatchNote: "reviewer: no new commits since the last review" })]);

      await run([repo]);

      expect(calls(11)).toEqual([["ready", repo.fullName, pr, "pr", "reviewer: no new commits since the last review"]]);
    });

    it("a conflicting PR records a merge-conflict dispatch note and shows it this tick", async () => {
      const pr = mockPR({ number: 8 });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getPRReviewComments.mockResolvedValueOnce({ formatted: "fix this", commentIds: [1], reviewCommentIds: [] });
      mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");
      mockDb.listClawsPrs.mockResolvedValue([prRow(8, { stage: "addressing-review" })]);

      await run([repo]);

      expect(mockGh.setDispatchNote).toHaveBeenCalledWith(repo.fullName, 8, "merge conflict — waiting for conflict resolution");
      expect(calls(8)).toEqual([["needs-review-addressing", repo.fullName, pr, "pr", "merge conflict — waiting for conflict resolution"]]);
    });

    it("clears the merge-conflict note once the PR is no longer conflicting", async () => {
      const pr = mockPR({ number: 8 });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getPRReviewComments.mockResolvedValueOnce({ formatted: "fix this", commentIds: [1], reviewCommentIds: [] });
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
      mockDb.listClawsPrs.mockResolvedValue([prRow(8, { stage: "addressing-review", dispatchNote: "merge conflict — waiting for conflict resolution" })]);

      await run([repo]);

      expect(mockGh.setDispatchNote).toHaveBeenCalledWith(repo.fullName, 8, null);
    });

    it("prunes the CI fixer's skip reasons to the open PRs", async () => {
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 5 })]);

      await run([repo]);

      expect(mockCiFixer.pruneIdentifySkipReasons).toHaveBeenCalledWith(repo.fullName, new Set([5]));
    });

    it("does not populate a merged or closed row", async () => {
      const merged = mockPR({ number: 9 });
      const closed = mockPR({ number: 10 });
      mockGh.listPRs.mockResolvedValue([merged, closed]);
      mockDb.listClawsPrs.mockResolvedValue([prRow(9, { stage: "merged" }), prRow(10, { stage: "closed" })]);

      await run([repo]);

      expect(calls(9)).toEqual([]);
      expect(calls(10)).toEqual([]);
    });

    it("reconciles the new categories so stale entries are evicted", async () => {
      mockGh.listPRs.mockResolvedValue([]);

      await run([repo]);

      expect(mockGh.reconcileQueueCache).toHaveBeenCalledWith(
        repo.fullName,
        expect.arrayContaining(["ci-failing", "needs-review", "needs-review-addressing"]),
        expect.any(Set),
        "pr",
      );
    });
  });

  describe("auto-bump gate (Phase 4)", () => {
    const autoBumpPR = (overrides: Partial<Parameters<typeof mockPR>[0]> = {}) =>
      mockPR({ number: 90, headRefName: "automation/bump-claws", labels: [{ name: "auto-bump" }], ...overrides });

    beforeEach(() => {
      mockAutoMerger.isAutoBumpPR.mockReturnValue(true);
      mockAutoMerger.isApprovalExempt.mockResolvedValue(true);
      mockAutoMerger.checkAutoBumpDiff.mockResolvedValue({ ok: true });
      mockGh.getPRCheckStatus.mockResolvedValue("passing");
      mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    });

    it("skips pr-reviewer and applies Ready for an approval-exempt auto-bump PR with a passing gate and CI", async () => {
      const pr = autoBumpPR();
      mockGh.listPRs.mockResolvedValue([pr]);

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).not.toContain("pr-reviewer");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
      expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith(
        "ready", repo.fullName, expect.objectContaining({ number: pr.number }), "pr",
      );
    });

    it("still reviews when the structural gate rejects the diff", async () => {
      const pr = autoBumpPR();
      mockGh.listPRs.mockResolvedValue([pr]);
      mockAutoMerger.checkAutoBumpDiff.mockResolvedValue({ ok: false, reason: "not-image-pin-only" });

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).toContain("pr-reviewer");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    });

    it("still reviews a Needs LGTM auto-bump PR (not approval-exempt)", async () => {
      const pr = autoBumpPR({ labels: [{ name: "auto-bump" }, { name: "Needs LGTM" }] });
      mockGh.listPRs.mockResolvedValue([pr]);
      mockAutoMerger.isApprovalExempt.mockResolvedValue(false);

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).toContain("pr-reviewer");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    });

    it("skips the review but withholds Ready while CI is still pending", async () => {
      const pr = autoBumpPR();
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getPRCheckStatus.mockResolvedValue("pending");

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).not.toContain("pr-reviewer");
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("skips the review but withholds Ready while the PR has merge conflicts", async () => {
      const pr = autoBumpPR();
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).not.toContain("pr-reviewer");
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does not re-apply Ready when the row already awaits merge", async () => {
      const pr = autoBumpPR();
      mockGh.listPRs.mockResolvedValue([pr]);
      mockDb.listClawsPrs.mockResolvedValue([prRow(pr.number, { stage: "awaiting-merge" })]);

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).not.toContain("pr-reviewer");
      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith(
        "ready", repo.fullName, expect.objectContaining({ number: pr.number }), "pr",
      );
    });

    it("falls back to the normal review when the gate check throws", async () => {
      const pr = autoBumpPR();
      mockGh.listPRs.mockResolvedValue([pr]);
      mockAutoMerger.checkAutoBumpDiff.mockRejectedValueOnce(new Error("API hiccup"));

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).toContain("pr-reviewer");
      expect(mockGh.addLabel).not.toHaveBeenCalled();
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

  describe("sweepStackedPRs", () => {
    const stacked = () => mockPR({ number: 30, headRefName: "claws/issue-9-abcd", baseRefName: "claws/issue-1-e121" });

    beforeEach(() => {
      // vi.clearAllMocks() does not reset implementations, so the marker stub set
      // by the dedup test would otherwise leak into every later case.
      mockGh.getIssueComments.mockResolvedValue([]);
    });

    it("comments once and applies Manual Action to a stacked claws PR", async () => {
      await sweepStackedPRs(repo, [stacked()]);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        30,
        expect.stringContaining("Stacked PR"),
        { agentName: "PR Dispatcher" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 30, "Manual Action");
    });

    it("is silent on a second sweep once the marker comment exists", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ body: "### Stacked PR\n\nclaws-stacked-pr-flagged" }]);

      await sweepStackedPRs(repo, [stacked()]);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("ignores a stacked PR from a non-claws branch", async () => {
      await sweepStackedPRs(repo, [mockPR({ number: 31, headRefName: "feature-branch", baseRefName: "release" })]);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("ignores a stacked PR a human has parked with Claws Ignore or Blocked", async () => {
      mockGh.isDispatchSkippable.mockReturnValue(true);

      await sweepStackedPRs(repo, [stacked()]);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("ignores a stacked PR from a fork", async () => {
      mockGh.isForkPR.mockReturnValue(true);

      await sweepStackedPRs(repo, [stacked()]);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("ignores PRs that already target the default branch", async () => {
      await sweepStackedPRs(repo, [mockPR({ number: 32, headRefName: "claws/issue-9-abcd", baseRefName: "main" })]);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("run() flags a stacked PR it encounters", async () => {
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 33, headRefName: "claws/issue-9-abcd", baseRefName: "claws/issue-1-e121", changedFiles: 3, additions: 1, deletions: 1 })]);

      await run([repo]);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 33, "Manual Action");
    });

    it("flagging one stacked PR does not block flagging another in the same sweep", async () => {
      const failing = mockPR({ number: 34, headRefName: "claws/issue-9-abcd", baseRefName: "claws/issue-1-e121" });
      const other = mockPR({ number: 35, headRefName: "claws/issue-9-efgh", baseRefName: "claws/issue-1-e121" });
      mockGh.commentOnIssue.mockRejectedValueOnce(new Error("rate limited"));

      await sweepStackedPRs(repo, [failing, other]);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 34, "Manual Action");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 35, "Manual Action");
    });

    it("run() skips the stacked-PR sweep when disabled for the repo", async () => {
      mockIsJobDisabledForRepo.mockImplementation((job: string) => job === "stacked-pr-flagger");
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 36, headRefName: "claws/issue-9-abcd", baseRefName: "claws/issue-1-e121" })]);

      await run([repo]);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 36, "Manual Action");
      mockIsJobDisabledForRepo.mockReturnValue(false);
    });
  });
});

describe("pr-dispatcher — PR state store (Phase 0a)", () => {
  const repo = mockRepo();
  const row = (overrides: Record<string, unknown> = {}) => prRow(42, { issueId: "clw_x", phase: 1, ...overrides });
  const status = (checkStatus: string) => new Map([[42, { checkStatus, checksPassed: 0, checksTotal: 1, mergeableState: "MERGEABLE" }]]);
  const patchFor = (n: number) => mockDb.upsertClawsPr.mock.calls.filter((c) => c[1] === n).map((c) => c[2]);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRStatuses.mockResolvedValue(new Map());
    mockGh.getPRState.mockResolvedValue("OPEN");
    mockDb.listClawsPrs.mockResolvedValue([]);
    mockDb.findIssuePlannedPRByNumber.mockResolvedValue(null);
    mockDb.getLatestPRReview.mockResolvedValue(null);
    mockDb.getClawsPr.mockResolvedValue(null);
    mockGh.getLabelApplier.mockResolvedValue(null);
  });

  it("seeds an unseen PR from CI and the issue link, ignoring its labels", async () => {
    mockDb.findIssuePlannedPRByNumber.mockResolvedValue({ issueId: "clw_abc", position: 2 });
    mockGh.listPRStatuses.mockResolvedValue(status("failing"));
    const labels = [{ name: "Ready" }, { name: "Needs LGTM" }, { name: "Automerge" }, { name: "Manual Action" }];
    await refreshPrStore(repo, [mockPR({ number: 42, labels, headRefOid: "sha1" })]);
    const [patch] = patchFor(42);
    expect(patch).toEqual(expect.objectContaining({
      stage: "ci-failing",
      issueId: "clw_abc",
      phase: 2,
      headSha: "sha1",
      ciStatus: "failing",
      mergeableState: "MERGEABLE",
      observedAt: expect.any(String),
      title: expect.any(String),
    }));
    for (const key of ["needsHumanReview", "mergeApprovedAt", "mergeApprovedBy", "manualActionReason", "ciBlockedReason"]) {
      expect(patch).not.toHaveProperty(key);
    }

    vi.clearAllMocks();
    mockGh.listPRStatuses.mockResolvedValue(status("passing"));
    await refreshPrStore(repo, [mockPR({ number: 42, labels })]);
    expect(patchFor(42)[0]).toMatchObject({ stage: "opened" });
  });

  it("refreshes observed fields on a known row without touching its stage or approval", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "addressing-review", mergeApprovedAt: "t", mergeApprovedBy: "label" })]);
    mockDb.getLatestPRReview.mockResolvedValue({ verdict: "clean", headSha: "sha2" });
    mockGh.listPRStatuses.mockResolvedValue(status("passing"));
    await refreshPrStore(repo, [mockPR({ number: 42, labels: [{ name: "Automerge" }], headRefOid: "sha2" })]);
    const [patch] = patchFor(42);
    expect(patch).toMatchObject({ headSha: "sha2", ciStatus: "passing", reviewVerdict: "clean", reviewedSha: "sha2" });
    expect(patch).not.toHaveProperty("stage");
    expect(patch).not.toHaveProperty("mergeApprovedAt");
    expect(patch).not.toHaveProperty("issueId");
    expect(mockDb.findIssuePlannedPRByNumber).not.toHaveBeenCalled();
  });

  it("applies the CI rule in both directions", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "awaiting-review" })]);
    mockGh.listPRStatuses.mockResolvedValue(status("failing"));
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(patchFor(42)[0]).toMatchObject({ stage: "ci-failing" });

    vi.clearAllMocks();
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "ci-failing" })]);
    mockGh.listPRStatuses.mockResolvedValue(status("none"));
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(patchFor(42)[0]).toMatchObject({ stage: "awaiting-review" });
  });

  it("moves no stage on a held (action_required) status, and seeds a new row as opened", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "awaiting-review" })]);
    mockGh.listPRStatuses.mockResolvedValue(status("held"));
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(patchFor(42)[0]).toMatchObject({ ciStatus: "held" });
    expect(patchFor(42)[0]).not.toHaveProperty("stage");

    vi.clearAllMocks();
    mockDb.listClawsPrs.mockResolvedValue([]);
    mockGh.listPRStatuses.mockResolvedValue(status("held"));
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(patchFor(42)[0]).toMatchObject({ stage: "opened" });
  });

  it("returns the statuses map it read", async () => {
    const statuses = status("held");
    mockGh.listPRStatuses.mockResolvedValue(statuses);
    expect(await refreshPrStore(repo, [mockPR({ number: 42 })])).toBe(statuses);
  });

  it("never changes a row from a forge label change", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ needsHumanReview: true, stage: "problematic" })]);
    await refreshPrStore(repo, [mockPR({ number: 42, labels: [{ name: "Automerge" }, { name: "Ready" }, { name: "Manual Action" }] })]);
    const [patch] = patchFor(42);
    for (const key of ["stage", "needsHumanReview", "mergeApprovedAt", "mergeApprovedBy", "manualActionReason"]) {
      expect(patch).not.toHaveProperty(key);
    }
    expect(mockGh.getLabelApplier).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("restores Manual Action removed on the forge while the row still records it, without clearing the row", async () => {
    const current = row({ manualActionReason: "set prod secrets", stage: "manual-action" });
    mockDb.listClawsPrs.mockResolvedValue([current]);
    mockDb.getClawsPr.mockResolvedValue(current);
    await refreshPrStore(repo, [mockPR({ number: 42, labels: [{ name: "Automerge" }] })]);
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 42, "Manual Action");
    expect(patchFor(42)[0]).not.toHaveProperty("manualActionReason");
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("restored Manual Action"));
  });

  it("does not restore Manual Action when a mid-tick clear already cleared the current record", async () => {
    // listClawsPrs' snapshot is stale — it still shows a reason — but a clear
    // landed while the tick was in flight, so a fresh read shows none.
    mockDb.listClawsPrs.mockResolvedValue([row({ manualActionReason: "set prod secrets", stage: "manual-action" })]);
    mockDb.getClawsPr.mockResolvedValue(row({ manualActionReason: null, stage: "awaiting-review" }));
    await refreshPrStore(repo, [mockPR({ number: 42, labels: [{ name: "Automerge" }] })]);
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("leaves Manual Action alone when the forge still carries it", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ manualActionReason: "set prod secrets" })]);
    await refreshPrStore(repo, [mockPR({ number: 42, labels: [{ name: "Manual Action" }] })]);
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("does not add Manual Action when the row records none", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ manualActionReason: null })]);
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("does not add Manual Action to a freshly seeded PR", async () => {
    mockDb.listClawsPrs.mockResolvedValue([]);
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("logs, not reports, a failed Manual Action restore", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ manualActionReason: "set prod secrets" })]);
    mockDb.getClawsPr.mockResolvedValue(row({ manualActionReason: "set prod secrets" }));
    mockGh.addLabel.mockRejectedValueOnce(new Error("forge down"));
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("could not restore Manual Action"));
    expect(patchFor(42)).toHaveLength(1);
  });

  it("imports a pre-cutover forge Automerge once, naming who applied it", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ mergeApprovedAt: "2026-09-01T00:00:00Z", mergeApprovedBy: "forge-label" })]);
    mockGh.getLabelApplier.mockResolvedValue("alice");
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(mockGh.getLabelApplier).toHaveBeenCalledWith(repo.fullName, 42, "Automerge");
    const [patch] = patchFor(42);
    expect(patch).toMatchObject({ mergeApprovedBy: "forge:alice" });
    expect(patch).not.toHaveProperty("mergeApprovedAt");
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("imported forge Automerge"));

    // Once rewritten, the row never matches again.
    vi.clearAllMocks();
    mockDb.listClawsPrs.mockResolvedValue([row({ mergeApprovedAt: "2026-09-01T00:00:00Z", mergeApprovedBy: "forge:alice" })]);
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(mockGh.getLabelApplier).not.toHaveBeenCalled();
  });

  it("clears a pre-cutover forge Automerge nobody is recorded applying", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ mergeApprovedAt: "t", mergeApprovedBy: "forge-label" })]);
    mockGh.getLabelApplier.mockResolvedValue(null);
    await refreshPrStore(repo, [mockPR({ number: 42, labels: [{ name: "Automerge" }] })]);
    expect(patchFor(42)[0]).toMatchObject({ mergeApprovedBy: null, mergeApprovedAt: null });
  });

  it("leaves the approval for the next tick when the applier read fails", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ mergeApprovedAt: "t", mergeApprovedBy: "forge-label" })]);
    mockGh.getLabelApplier.mockRejectedValue(new Error("boom"));
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    const [patch] = patchFor(42);
    expect(patch).not.toHaveProperty("mergeApprovedBy");
    expect(patch).not.toHaveProperty("mergeApprovedAt");
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(
      "pr-dispatcher:pr-store-import",
      `${repo.fullName}#42`,
      expect.any(Error),
      expect.anything(),
    );
    expect(patch).toMatchObject({ observedAt: expect.any(String) });
  });

  it("reads a fresh listing each tick", async () => {
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 42 })]);
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "awaiting-merge" })]);
    await run([repo]);
    expect(mockGh.invalidatePRList).toHaveBeenCalledWith(repo.fullName);
    expect(mockGh.invalidatePRList.mock.invocationCallOrder[0]).toBeLessThan(mockGh.listPRs.mock.invocationCallOrder[0]);
    expect(mockGh.listPRs).toHaveBeenCalledWith(repo.fullName);
    mockGh.listPRs.mockReset().mockResolvedValue([]);
  });

  it("looks up the plan link only at seeding or for an unlinked Claws branch", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ issueId: null })]);
    await refreshPrStore(repo, [mockPR({ number: 42, headRefName: "dependabot/npm/x" })]);
    expect(mockDb.findIssuePlannedPRByNumber).not.toHaveBeenCalled();

    mockDb.findIssuePlannedPRByNumber.mockResolvedValue({ issueId: "clw_abc", position: 1 });
    await refreshPrStore(repo, [mockPR({ number: 42, headRefName: "claws/issue-clw_abc-1" })]);
    expect(patchFor(42)[1]).toMatchObject({ issueId: "clw_abc", phase: 1 });
  });

  it("closes a row whose PR the forge no longer knows", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ prNumber: 5 })]);
    mockGh.getPRState.mockResolvedValue(null);
    await refreshPrStore(repo, []);
    expect(patchFor(5)[0]).toMatchObject({ stage: "closed" });
  });

  it("marks a vanished PR merged or closed", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ prNumber: 5 }), row({ prNumber: 6 }), row({ prNumber: 9, stage: "merged" })]);
    mockGh.getPRState.mockImplementation(async (_r: string, n: number) => (n === 5 ? "MERGED" : "CLOSED"));
    await refreshPrStore(repo, []);
    expect(patchFor(5)[0]).toMatchObject({ stage: "merged" });
    expect(patchFor(6)[0]).toMatchObject({ stage: "closed" });
    expect(mockGh.getPRState).not.toHaveBeenCalledWith(repo.fullName, 9);
  });

  // A PR merged by hand runs none of Claws' merge paths; the close-out here is
  // what closes the native issue its body names.
  it("finalizes a merged row linked to an issue, and only that one", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ prNumber: 5 }), row({ prNumber: 6 }), row({ prNumber: 7, issueId: null })]);
    mockGh.getPRState.mockImplementation(async (_r: string, n: number) => (n === 6 ? "CLOSED" : "MERGED"));
    await refreshPrStore(repo, []);
    expect(mockAutoMerger.finalizeMergedClawsPR).toHaveBeenCalledTimes(1);
    expect(mockAutoMerger.finalizeMergedClawsPR).toHaveBeenCalledWith(
      repo, { number: 5, headRefName: "", body: undefined }, "hand-merge");
  });

  it("keeps closing out rows when finalizing one throws", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ prNumber: 5 }), row({ prNumber: 6 })]);
    mockGh.getPRState.mockResolvedValue("MERGED");
    mockAutoMerger.finalizeMergedClawsPR.mockRejectedValueOnce(new Error("boom"));
    await refreshPrStore(repo, []);
    expect(patchFor(6)[0]).toMatchObject({ stage: "merged" });
    expect(mockAutoMerger.finalizeMergedClawsPR).toHaveBeenCalledTimes(2);
  });

  it("human feedback moves the PR to addressing-review, leaving the approval alone", async () => {
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 42, labels: [{ name: "Ready" }, { name: "Automerge" }] })]);
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "awaiting-merge", mergeApprovedAt: "t", mergeApprovedBy: "label" })]);
    // The removeLabel(Ready) hook has already stepped the row back.
    mockDb.getClawsPr.mockResolvedValue(row({ stage: "awaiting-review", mergeApprovedAt: "t", mergeApprovedBy: "label" }));
    mockGh.getPRReviewComments.mockResolvedValue({ formatted: "Please fix", commentIds: [100], reviewCommentIds: [] });
    await run([repo]);
    expect(mockDb.upsertClawsPr).toHaveBeenCalledWith(repo.fullName, 42, { stage: "addressing-review" });
    for (const patch of patchFor(42)) expect(patch).not.toHaveProperty("mergeApprovedAt", null);
  });

  it("review feedback leaves a problematic PR's stage alone", async () => {
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 42, labels: [{ name: "Claws Problematic" }] })]);
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "problematic" })]);
    mockDb.getClawsPr.mockResolvedValue(row({ stage: "problematic" }));
    mockGh.getPRReviewComments.mockResolvedValue({ formatted: "Please fix", commentIds: [100], reviewCommentIds: [] });
    await run([repo]);
    expect(mockWorker.enqueue).toHaveBeenCalledWith("review-addresser", repo.fullName, 42, expect.anything());
    for (const patch of patchFor(42)) expect(patch).not.toHaveProperty("stage");
  });

  it("an advisory-only round does not demote the stage", async () => {
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 42, labels: [{ name: "Ready" }] })]);
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "awaiting-merge" })]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "nit", commentIds: [], reviewCommentIds: [],
      prReviewComment: { id: 1, body: "…", reviewedCommit: "abc" }, advisoryOnly: true,
    });
    await run([repo]);
    for (const patch of patchFor(42)) expect(patch).not.toHaveProperty("stage");
  });
});

describe("pr-dispatcher — held workflow runs (action_required)", () => {
  const repo = mockRepo();
  const heldRun = { run_id: 7, workflow_name: "CI", conclusion: "action_required" };
  const statuses = (checkStatus: gh.CheckStatus) =>
    new Map<number, gh.PRRepoStatus>([[42, { checkStatus, checksPassed: 0, checksTotal: 1, checksHeld: 1, mergeableState: "MERGEABLE" }]]);
  const dependabot = (overrides: Record<string, unknown> = {}) =>
    mockPR({ number: 42, author: { login: "dependabot[bot]" }, headRefName: "dependabot/npm/x", headRefOid: "sha42", ...overrides });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.isDependabotPR.mockImplementation((pr: { author: { login: string } }) => pr.author.login === "dependabot[bot]");
    mockGh.isForkPR.mockImplementation((pr: { isCrossRepository?: boolean }) => pr.isCrossRepository === true);
    mockGh.listHeldWorkflowRuns.mockResolvedValue([heldRun]);
    resetHeldRunChecksForTests();
    resetRejectedHeldRunsForTests();
    resetHeldRunCountsForTests();
  });

  afterEach(() => {
    mockGh.isDependabotPR.mockReset().mockReturnValue(false);
    mockGh.isForkPR.mockReset().mockReturnValue(false);
    mockGh.isDispatchSkippable.mockReset().mockReturnValue(false);
  });

  it("approves the held runs of a same-repo Dependabot PR", async () => {
    await clearActionRequiredHolds(repo, [dependabot()], statuses("held"));
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledWith(repo.fullName, "sha42");
    expect(mockGh.approveWorkflowRun).toHaveBeenCalledWith(repo.fullName, 7);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining(`held workflow run 7 (CI) on ${repo.fullName}#42`));
  });

  it("leaves a fork Dependabot PR held", async () => {
    await clearActionRequiredHolds(repo, [dependabot({ isCrossRepository: true })], statuses("held"));
    expect(mockGh.approveWorkflowRun).not.toHaveBeenCalled();
  });

  it("leaves a human-authored PR held", async () => {
    await clearActionRequiredHolds(repo, [dependabot({ author: { login: "someone" }, headRefName: "claws/issue-1-abcd" })], statuses("held"));
    expect(mockGh.approveWorkflowRun).not.toHaveBeenCalled();
  });

  it("does nothing for a PR whose CI is failing", async () => {
    await clearActionRequiredHolds(repo, [dependabot()], statuses("failing"));
    expect(mockGh.listHeldWorkflowRuns).not.toHaveBeenCalled();
  });

  it.each(["passing", "pending", "none"] as const)(
    "approves held runs the rollup does not show (rollup %s)",
    async (checkStatus) => {
      await clearActionRequiredHolds(repo, [dependabot()], statuses(checkStatus));
      expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledWith(repo.fullName, "sha42");
      expect(mockGh.approveWorkflowRun).toHaveBeenCalledWith(repo.fullName, 7);
    },
  );

  it("lists a head with no held runs once, until the head changes or the rollup reports held", async () => {
    mockGh.listHeldWorkflowRuns.mockResolvedValue([]);
    await clearActionRequiredHolds(repo, [dependabot()], statuses("pending"));
    await clearActionRequiredHolds(repo, [dependabot()], statuses("passing"));
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledTimes(1);

    await clearActionRequiredHolds(repo, [dependabot()], statuses("held"));
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledTimes(2);

    await clearActionRequiredHolds(repo, [dependabot({ headRefOid: "sha43" })], statuses("pending"));
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledTimes(3);
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenLastCalledWith(repo.fullName, "sha43");
  });

  it("records, but does not approve, a held run on a human-authored PR the rollup misses", async () => {
    await clearActionRequiredHolds(repo, [dependabot({ author: { login: "someone" }, headRefName: "claws/issue-1-abcd" })], statuses("passing"));
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledWith(repo.fullName, "sha42");
    expect(mockGh.approveWorkflowRun).not.toHaveBeenCalled();
    expect(heldRunCount(repo.fullName, "sha42")).toBe(1);
  });

  it("records, but does not approve, a held run on a fork PR", async () => {
    await clearActionRequiredHolds(repo, [dependabot({ isCrossRepository: true })], statuses("none"));
    expect(mockGh.approveWorkflowRun).not.toHaveBeenCalled();
    expect(heldRunCount(repo.fullName, "sha42")).toBe(1);
  });

  it("re-lists a head with a recorded hold every tick and drops the record once a human approves", async () => {
    const human = dependabot({ author: { login: "someone" }, headRefName: "claws/issue-1-abcd" });
    await clearActionRequiredHolds(repo, [human], statuses("passing"));
    expect(heldRunCount(repo.fullName, "sha42")).toBe(1);

    mockGh.listHeldWorkflowRuns.mockResolvedValue([]);
    await clearActionRequiredHolds(repo, [human], statuses("pending"));
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(heldRunCount(repo.fullName, "sha42")).toBeUndefined();
  });

  it("re-lists a head whose held run GitHub rejected without retrying the approval", async () => {
    mockGh.approveWorkflowRun.mockRejectedValueOnce(new Error("HTTP 403"));

    await clearActionRequiredHolds(repo, [dependabot()], statuses("held"));
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledTimes(1);
    expect(mockGh.approveWorkflowRun).toHaveBeenCalledTimes(1);

    // The rollup can miss the still-held run; the recorded hold keeps it listed.
    await clearActionRequiredHolds(repo, [dependabot()], statuses("passing"));
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(mockGh.approveWorkflowRun).toHaveBeenCalledTimes(1);
    expect(heldRunCount(repo.fullName, "sha42")).toBe(1);
  });

  it("drops the recorded hold of a head that is no longer open", async () => {
    await clearActionRequiredHolds(repo, [dependabot({ isCrossRepository: true })], statuses("held"));
    expect(heldRunCount(repo.fullName, "sha42")).toBe(1);
    await clearActionRequiredHolds(repo, [], new Map());
    expect(heldRunCount(repo.fullName, "sha42")).toBeUndefined();
  });

  it("records, but does not approve, a held run on a dispatch-skippable PR", async () => {
    mockGh.isDispatchSkippable.mockReturnValue(true);
    await clearActionRequiredHolds(repo, [dependabot()], statuses("held"));
    expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledWith(repo.fullName, "sha42");
    expect(heldRunCount(repo.fullName, "sha42")).toBe(1);
    expect(mockGh.approveWorkflowRun).not.toHaveBeenCalled();
  });

  it("never lists runs on a Forgejo repo", async () => {
    await clearActionRequiredHolds({ ...repo, forge: "forgejo" }, [dependabot()], statuses("held"));
    expect(mockGh.listHeldWorkflowRuns).not.toHaveBeenCalled();
  });
});
