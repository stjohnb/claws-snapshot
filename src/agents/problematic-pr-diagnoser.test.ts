import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    problematic: "Claws Problematic",
  },
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
  getItemTimeoutMs: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./ci-fixer.js", () => ({
  isCIUnrelatedFixPR: (pr: { title: string }) => pr.title.includes("[ci-unrelated]"),
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    listPRs: vi.fn(),
    getIssueComments: vi.fn(),
    getFailedRunLog: vi.fn(),
    getFailingCheck: vi.fn(),
    getPRHeadSHA: vi.fn(),
    getPRCheckStatus: vi.fn(),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    isForkPR: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
  },
  mockClaude: {
    withExistingWorktree: vi.fn(),
    runClaude: vi.fn().mockResolvedValue("done"),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    getHeadSha: vi.fn().mockResolvedValue("aaaaaaa1111111"),
    writeClawsMcpConfig: vi.fn().mockReturnValue("/tmp/mcp.json"),
    getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 1, insertions: 1, deletions: 1 }),
    getCommitCount: vi.fn().mockResolvedValue(1),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(42),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    getRecentCIFixerErrors: vi.fn().mockReturnValue([]),
    withTaskRecording: vi.fn(async (
      jobName: string,
      repo: string,
      itemNumber: number,
      triggerLabel: string | null,
      fn: (taskId: number) => Promise<unknown>,
    ) => {
      const id = mockDb.recordTaskStart(jobName, repo, itemNumber, triggerLabel);
      try {
        return await fn(id);
      } catch (err) {
        mockDb.recordTaskFailed(id, String(err), { failureCategory: "unknown" });
        throw err;
      }
    }),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import { runDiagnosis, DIAGNOSIS_COMMENT_MARKER, MAX_ROUNDS, _setTimingsForTests } from "./problematic-pr-diagnoser.js";

// Make the CI watch loop tick almost instantly under tests.
_setTimingsForTests(/* budgetMs */ 50, /* pollIntervalMs */ 1);

describe("problematic-pr-diagnoser", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.getFailedRunLog.mockResolvedValue("some failure log");
    mockGh.getFailingCheck.mockResolvedValue(undefined);
    mockGh.getPRHeadSHA.mockResolvedValue("aaaaaaa1111111");
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.isForkPR.mockReturnValue(false);
    mockClaude.withExistingWorktree.mockImplementation(
      async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"),
    );
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.getHeadSha.mockResolvedValue("aaaaaaa1111111");
    mockDb.getRecentCIFixerErrors.mockReturnValue([]);
  });

  const problematicPR = (overrides: Parameters<typeof mockPR>[0] = {}) =>
    mockPR({ labels: [{ name: "Claws Problematic" }], ...overrides });

  it("dedup: skips when a prior diagnosis report comment exists", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1, body: `### 🩺 Problematic PR Diagnosis Report\n${DIAGNOSIS_COMMENT_MARKER}\n...`, login: "claws-bot" },
    ]);

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("skips fork PRs", async () => {
    const pr = problematicPR();
    mockGh.isForkPR.mockReturnValue(true);

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
  });

  it("skips ci-unrelated fix PRs", async () => {
    const pr = problematicPR({ title: "fix: resolve #42 — [ci-unrelated] failures" });

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
  });

  it("bails when no failure log is available on round 1", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailedRunLog.mockResolvedValue("");

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    // Posts a final report
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining(DIAGNOSIS_COMMENT_MARKER),
      { agentName: "Problematic PR Diagnoser" },
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("No CI failure log available"),
      expect.any(Object),
    );
    // Problematic label is NOT removed on no-fix-possible
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("success path: CI passes after round 1, removes problematic label, posts success report", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await runDiagnosis(repo, pr);

    expect(mockClaude.pushBranch).toHaveBeenCalledTimes(1);
    expect(mockGh.removeLabel).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      "Claws Problematic",
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("Diagnosis succeeded"),
      { agentName: "Problematic PR Diagnoser" },
    );
    // Final comment posted exactly once with the marker
    const commentCalls = mockGh.commentOnIssue.mock.calls.filter(
      (c) => typeof c[2] === "string" && (c[2] as string).includes(DIAGNOSIS_COMMENT_MARKER),
    );
    expect(commentCalls).toHaveLength(1);
  });

  it("no-commits on round 1: bails, posts no-fix-possible report, does not remove label", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.hasNewCommits.mockResolvedValue(false);

    await runDiagnosis(repo, pr);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("no commits"),
      expect.any(Object),
    );
  });

  it("each round records a separate task with job_name ci-fixer:problematic", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);

    await runDiagnosis(repo, pr);

    expect(mockDb.recordTaskStart).toHaveBeenCalledWith(
      "ci-fixer:problematic",
      repo.fullName,
      pr.number,
      null,
    );
  });

  it("uses classifyComplexity to pick model", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClassifyComplexity.mockResolvedValueOnce("opus");

    await runDiagnosis(repo, pr);

    expect(mockClassifyComplexity).toHaveBeenCalledWith(
      expect.stringContaining("Problematic PR deeper-diagnosis"),
      "/tmp/worktree",
    );
    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/worktree",
      expect.objectContaining({ model: "opus", capability: "tool-use", agent: "build" }),
    );
  });

  it("stops silently when problematic label is removed before the round begins", async () => {
    const pr = problematicPR();
    // refetchPR returns the same PR without the problematic label
    const refreshedPR = mockPR({ number: pr.number, labels: [] });
    mockGh.listPRs.mockResolvedValue([refreshedPR]);

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    // No noisy report — the human removed the label, they don't need notification.
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("stops silently when PR is closed/merged mid-diagnosis", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([]); // refetchPR returns null

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("max-rounds: runs exactly MAX_ROUNDS when CI keeps failing", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    // getFailingCheck returns a truthy object so waitForCheck resolves "failing" each round
    mockGh.getFailingCheck.mockResolvedValue({ name: "test-ci", url: "https://example.com" });

    await runDiagnosis(repo, pr);

    expect(mockDb.recordTaskStart).toHaveBeenCalledTimes(MAX_ROUNDS);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining(DIAGNOSIS_COMMENT_MARKER),
      { agentName: "Problematic PR Diagnoser" },
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("CI still failing"),
      expect.any(Object),
    );
  });

  it("round 2+: falls through to runDiagnosisRound when log is empty but CI check is still failing", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    // Round 1 has a log; round 2 returns empty
    mockGh.getFailedRunLog
      .mockResolvedValueOnce("round 1 failure log")
      .mockResolvedValue("");
    // getFailingCheck always truthy:
    //   - waitForCheck on round 1 → "failing", continue to round 2
    //   - empty-log guard on round 2 → fall through to runDiagnosisRound
    mockGh.getFailingCheck.mockResolvedValue({ name: "test-ci", url: "https://example.com" });
    // Round 1 pushes; round 2 produces no commits → no-fix-possible
    mockClaude.hasNewCommits
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await runDiagnosis(repo, pr);

    // Both rounds invoked runDiagnosisRound
    expect(mockDb.recordTaskStart).toHaveBeenCalledTimes(2);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("no commits"),
      expect.any(Object),
    );
  });

  it("budget-exhausted: posts report with 'CI watch budget exhausted' when CI stays pending, does not remove label", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    // CI stays pending the whole budget — waitForCheck times out
    mockGh.getPRCheckStatus.mockResolvedValue("pending");
    mockGh.getFailingCheck.mockResolvedValue(undefined);

    await runDiagnosis(repo, pr);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("CI watch budget exhausted"),
      { agentName: "Problematic PR Diagnoser" },
    );
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("superseded: stops silently when an external commit lands mid-watch, does not comment or remove label", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    // Claws pushes headSha "aaaaaaa1111111"; then an external push changes the remote HEAD
    mockGh.getPRHeadSHA.mockResolvedValue("bbbbbbb2222222");

    await runDiagnosis(repo, pr);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("exports MAX_ROUNDS so tests/docs stay in sync", () => {
    expect(MAX_ROUNDS).toBeGreaterThan(0);
  });
});
