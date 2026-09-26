import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

const mockIsAgentDisabled = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockIsJobDisabledForRepo = vi.hoisted(() => vi.fn().mockReturnValue(false));
/** Off by default so existing tests are time-independent; the window tests turn it on. */
const mockUpdateWindow = vi.hoisted(() => ({ enabled: false, start: "22:00", end: "07:00", timezone: "Europe/London" }));
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
    needsLgtm: "Needs LGTM",
    billing: "Billing",
  },
  isAgentDisabled: mockIsAgentDisabled,
  isJobDisabledForRepo: mockIsJobDisabledForRepo,
  get THIRD_PARTY_UPDATE_WINDOW() {
    return mockUpdateWindow;
  },
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
}));
vi.mock("../agents/ci-fixer.js", () => mockCiFixer);

const mockAutoMerger = vi.hoisted(() => ({
  isApprovalExempt: vi.fn().mockReturnValue(false),
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
import { run, sweepEmptyPRs, sweepStackedPRs, refreshPrStore } from "./pr-dispatcher.js";
import { initDb, closeDb, clearAllWorkQueueForTests } from "../db.js";

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
    mockAutoMerger.isApprovalExempt.mockReturnValue(false);
    mockAutoMerger.isAutoBumpPR.mockReturnValue(false);
    mockAutoMerger.checkAutoBumpDiff.mockResolvedValue({ ok: true });
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
    expect(mockGh.listPRs).toHaveBeenCalledWith(forgejoRepo.fullName, { raw: true });
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

  describe("out-of-hours window for third-party updates", () => {
    beforeEach(() => {
      mockUpdateWindow.enabled = true;
      mockGh.getPRReviewComments.mockResolvedValue({ formatted: "", commentIds: [], reviewCommentIds: [] });
      vi.useFakeTimers({ toFake: ["Date"] });
      // 14:00 BST — outside 22:00–07:00 Europe/London.
      vi.setSystemTime(new Date("2026-09-24T13:00:00Z"));
    });
    afterEach(() => {
      mockUpdateWindow.enabled = false;
      vi.useRealTimers();
    });

    // fleet-infra's Renovate runs with a PAT, so its PRs carry a human author.
    const renovatePR = () => mockPR({ number: 60, headRefName: "renovate/helm-chart", author: { login: "stjohnb" } });

    it("enqueues nothing for a renovate/* PR outside the window and surfaces it as waiting-for-window", async () => {
      const pr = renovatePR();
      mockGh.listPRs.mockResolvedValue([pr]);

      await run([repo]);

      expect(mockWorker.enqueue).not.toHaveBeenCalled();
      expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith("waiting-for-window", repo.fullName, pr, "pr");
      expect(mockGh.reconcileQueueCache).toHaveBeenCalledWith(
        repo.fullName,
        expect.arrayContaining(["waiting-for-window"]),
        new Set([60]),
        "pr",
      );
    });

    it("enqueues the same renovate/* PR for review inside the window", async () => {
      vi.setSystemTime(new Date("2026-09-24T22:00:00Z")); // 23:00 BST
      const pr = renovatePR();
      mockGh.listPRs.mockResolvedValue([pr]);

      await run([repo]);

      const kinds = mockWorker.enqueue.mock.calls.map((c) => c[0]);
      expect(kinds).toContain("pr-reviewer");
      expect(mockGh.populateQueueCacheFor).not.toHaveBeenCalledWith("waiting-for-window", expect.anything(), expect.anything(), expect.anything());
    });

    it("enqueues an auto-bump PR outside the window", async () => {
      const pr = mockPR({ number: 61, headRefName: "automation/bump-claws", labels: [{ name: "auto-bump" }] });
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
    expect(mockGh.populateQueueCacheFor).not.toHaveBeenCalled();
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
    const readyPR = () => mockPR({ number: 42, labels: [{ name: "Ready" }] });

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

    it("skips when the Automerge label is present", async () => {
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 42, labels: [{ name: "Ready" }, { name: "Automerge" }] })]);
      mockGh.getPRReviewComments.mockResolvedValue(advisoryReview);

      await run([repo]);

      expect(mockWorker.enqueue.mock.calls.map((c) => c[0])).not.toContain("review-addresser");
      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 42, "Ready");
    });

    it("skips approval-exempt PRs (dependabot, docs, ideas-collection, auto-bump)", async () => {
      mockGh.listPRs.mockResolvedValue([readyPR()]);
      mockGh.getPRReviewComments.mockResolvedValue(advisoryReview);
      mockAutoMerger.isApprovalExempt.mockReturnValue(true);

      await run([repo]);

      expect(mockWorker.enqueue.mock.calls.map((c) => c[0])).not.toContain("review-addresser");
      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 42, "Ready");
    });

    it("skips when the PR is not Ready (not idle-and-mergeable)", async () => {
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 42 })]);
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

  it("PR with Claws Problematic label is enqueued for CI_FIXER_PROBLEMATIC", async () => {
    const pr = mockPR({ number: 77, labels: [{ name: "Claws Problematic" }] });
    mockGh.listPRs.mockResolvedValue([pr]);

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

  describe("auto-bump gate (Phase 4)", () => {
    const autoBumpPR = (overrides: Partial<Parameters<typeof mockPR>[0]> = {}) =>
      mockPR({ number: 90, headRefName: "automation/bump-claws", labels: [{ name: "auto-bump" }], ...overrides });

    beforeEach(() => {
      mockAutoMerger.isAutoBumpPR.mockReturnValue(true);
      mockAutoMerger.isApprovalExempt.mockReturnValue(true);
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
      mockAutoMerger.isApprovalExempt.mockReturnValue(false);

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

    it("does not re-apply Ready when the PR already carries it", async () => {
      const pr = autoBumpPR({ labels: [{ name: "auto-bump" }, { name: "Ready" }] });
      mockGh.listPRs.mockResolvedValue([pr]);

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
  const row = (overrides: Record<string, unknown> = {}) => ({
    repo: repo.fullName, prNumber: 42, issueId: "clw_x", phase: 1, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, createdAt: "", updatedAt: "", ...overrides,
  });
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
    delete process.env["CLAWS_PR_STORE_FACADE"];
  });

  afterAll(() => {
    delete process.env["CLAWS_PR_STORE_FACADE"];
  });

  it("seeds an unseen labelled PR from its labels and the issue link", async () => {
    mockDb.findIssuePlannedPRByNumber.mockResolvedValue({ issueId: "clw_abc", position: 2 });
    mockGh.listPRStatuses.mockResolvedValue(status("failing"));
    await refreshPrStore(repo, [mockPR({ number: 42, labels: [{ name: "Ready" }, { name: "Needs LGTM" }], headRefOid: "sha1" })]);
    expect(patchFor(42)).toEqual([expect.objectContaining({
      stage: "awaiting-merge",
      needsHumanReview: true,
      issueId: "clw_abc",
      phase: 2,
      headSha: "sha1",
      ciStatus: "failing",
      mergeableState: "MERGEABLE",
      observedAt: expect.any(String),
    })]);
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

  it("mirrors an Automerge label applied or removed on the forge", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row()]);
    await refreshPrStore(repo, [mockPR({ number: 42, labels: [{ name: "Automerge" }] })]);
    expect(patchFor(42)[0]).toMatchObject({ mergeApprovedBy: "forge-label", mergeApprovedAt: expect.any(String) });

    vi.clearAllMocks();
    mockDb.listClawsPrs.mockResolvedValue([row({ mergeApprovedAt: "t", mergeApprovedBy: "label" })]);
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(patchFor(42)[0]).toMatchObject({ mergeApprovedBy: null, mergeApprovedAt: null });
  });

  it("reconciles a state label a human removed on the forge, logging it as a forge edit", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ needsHumanReview: true })]);
    await refreshPrStore(repo, [mockPR({ number: 42 })]);
    expect(patchFor(42)[0]).toMatchObject({ needsHumanReview: false });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      `[pr-dispatcher] pr-store: forge-edit ${repo.fullName}#42 field=Needs LGTM row=present labels=absent`);
  });

  it("does not reconcile a row written after the listing was fetched", async () => {
    // The Ready hook moved the row on after the (cached) listing was read.
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "awaiting-merge", updatedAt: "2026-09-01T10:00:30Z" })]);
    await refreshPrStore(repo, [mockPR({ number: 42 })], "2026-09-01T10:00:00.000Z");
    expect(patchFor(42)[0]).not.toHaveProperty("stage");
    expect(vi.mocked(log.info)).not.toHaveBeenCalledWith(expect.stringContaining("forge-edit"));

    // Nor does the CI rule act on a status that may predate the hook's write.
    vi.clearAllMocks();
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "awaiting-review", updatedAt: "2026-09-01T10:00:30Z" })]);
    mockGh.listPRStatuses.mockResolvedValue(status("failing"));
    await refreshPrStore(repo, [mockPR({ number: 42 })], "2026-09-01T10:00:00.000Z");
    expect(patchFor(42)[0]).not.toHaveProperty("stage");

    vi.clearAllMocks();
    mockGh.listPRStatuses.mockResolvedValue(new Map());
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "awaiting-merge", updatedAt: "2026-09-01T09:59:00Z" })]);
    await refreshPrStore(repo, [mockPR({ number: 42 })], "2026-09-01T10:00:00.000Z");
    expect(patchFor(42)[0]).toMatchObject({ stage: "awaiting-review" });
  });

  it("reads a fresh listing each tick and passes its time to the refresh", async () => {
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 42 })]);
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "awaiting-merge", updatedAt: "2999-01-01T00:00:00Z" })]);
    await run([repo]);
    expect(mockGh.invalidatePRList).toHaveBeenCalledWith(repo.fullName);
    expect(mockGh.invalidatePRList.mock.invocationCallOrder[0]).toBeLessThan(mockGh.listPRs.mock.invocationCallOrder[0]);
    for (const patch of patchFor(42)) expect(patch).not.toHaveProperty("stage");
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

  it("reconciles Claws Problematic cleared and Ready added on the forge", async () => {
    mockDb.listClawsPrs.mockResolvedValue([row({ stage: "problematic" })]);
    await refreshPrStore(repo, [mockPR({ number: 42, labels: [{ name: "Ready" }] })]);
    expect(patchFor(42)[0]).toMatchObject({ stage: "awaiting-merge" });
  });

  it("with the façade on, a forge-applied Automerge still reaches the row", async () => {
    process.env["CLAWS_PR_STORE_FACADE"] = "true";
    const listed = [mockPR({ number: 42, labels: [{ name: "Automerge" }] })];
    mockGh.listPRs.mockImplementation(async (_r: string, opts?: { raw?: boolean }) => (opts?.raw ? listed : [mockPR({ number: 42 })]));
    mockDb.listClawsPrs.mockResolvedValue([row()]);
    await run([repo]);
    expect(mockGh.listPRs).toHaveBeenCalledWith(repo.fullName, { raw: true });
    expect(patchFor(42)[0]).toMatchObject({ mergeApprovedBy: "forge-label", mergeApprovedAt: expect.any(String) });
    mockGh.listPRs.mockReset().mockResolvedValue([]);
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
