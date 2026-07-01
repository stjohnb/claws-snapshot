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
}));
vi.mock("../github.js", () => mockGh);

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

import { run } from "./pr-dispatcher.js";
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
});
