import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    problematic: "Claws Problematic",
  },
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  HOME_ASSISTANT_CONFIG_REPO: "",
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
    getRunJobSummaries: vi.fn().mockResolvedValue([]),
    // Simplified stand-in: names each stepless job and its runner (format tested in github.test.ts).
    describeSteplessJobs: vi.fn((jobs: Array<{ name: string; conclusion: string | null; stepCount: number; runnerName?: string | null }>) =>
      jobs
        .filter((j) => (j.conclusion === "failure" || j.conclusion === "cancelled") && j.stepCount === 0)
        .map((j) => `job "${j.name}" produced no logs: 0 steps${j.runnerName ? ` on runner "${j.runnerName}"` : ""}`)
        .join("; ")),
    getPRHeadSHA: vi.fn(),
    getPRCheckStatus: vi.fn(),
    getPRMergeableState: vi.fn(),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(true),
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
    writeAgentMcpConfig: vi.fn().mockReturnValue("/tmp/mcp.json"),
    getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 1, insertions: 1, deletions: 1 }),
    getCommitCount: vi.fn().mockResolvedValue(1),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(42),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    getRecentCIFixerErrors: vi.fn().mockReturnValue([]),
    recordCIFixerPush: vi.fn(),
    resetCIFixerBreakerGrants: vi.fn(),
    getClawsPr: vi.fn(),
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

import { runDiagnosis, DIAGNOSIS_COMMENT_MARKER, REDIAGNOSE_REQUEST_MARKER, hasCurrentDiagnosisReport, MAX_ROUNDS, _setTimingsForTests } from "./problematic-pr-diagnoser.js";

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
    mockGh.getRunJobSummaries.mockResolvedValue([]);
    mockGh.getPRHeadSHA.mockResolvedValue("aaaaaaa1111111");
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.isForkPR.mockReturnValue(false);
    mockClaude.withExistingWorktree.mockImplementation(
      async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"),
    );
    // HEAD moves during the agent run (start sha differs from every later read).
    mockClaude.getHeadSha.mockReset();
    mockClaude.getHeadSha.mockResolvedValueOnce("0000000start").mockResolvedValue("aaaaaaa1111111");
    mockDb.getRecentCIFixerErrors.mockReturnValue([]);
    // The claws_prs row is the problematic signal, not the label.
    mockDb.getClawsPr.mockResolvedValue({ stage: "problematic" });
  });

  const problematicPR = (overrides: Parameters<typeof mockPR>[0] = {}) =>
    mockPR({ labels: [{ name: "Claws Problematic" }], ...overrides });

  it("dedup: skips diagnosis (and keeps label) when a prior report exists and CI still failing", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1, body: `### 🩺 Problematic PR Diagnosis Report\n${DIAGNOSIS_COMMENT_MARKER}\n...`, login: "claws-bot" },
    ]);
    mockGh.getFailingCheck.mockResolvedValue({ name: "build", state: "FAILURE" });
    mockGh.getPRCheckStatus.mockResolvedValue("failing");

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  describe("session rediagnosis requests (#clw_01M4DQW4N7DJT8WHTCSV3NBZSD)", () => {
    const REPORT = { id: 1, body: `*— Automated by Claws · Problematic PR Diagnoser —*\n\n### 🩺 Problematic PR Diagnosis Report\n${DIAGNOSIS_COMMENT_MARKER}\n...`, login: "claws-bot" };
    const REQUEST = { id: 2, body: `*— Automated by Claws —*\n\n${REDIAGNOSE_REQUEST_MARKER}\n\nSession \`abc\` asked for a rediagnosis.`, login: "claws-bot" };

    it("hasCurrentDiagnosisReport counts only a report newer than the last Claws-marked request", () => {
      expect(hasCurrentDiagnosisReport([])).toBe(false);
      expect(hasCurrentDiagnosisReport([REPORT])).toBe(true);
      expect(hasCurrentDiagnosisReport([REPORT, REQUEST])).toBe(false);
      expect(hasCurrentDiagnosisReport([REPORT, REQUEST, { ...REPORT, id: 3 }])).toBe(true);
      // A request without the Claws footer is anyone's comment, not a session's.
      expect(hasCurrentDiagnosisReport([REPORT, { id: 4, body: REDIAGNOSE_REQUEST_MARKER, login: "someone" }])).toBe(true);
    });

    it("runs again when a rediagnosis request follows the report", async () => {
      const pr = problematicPR();
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getIssueComments.mockResolvedValue([REPORT, REQUEST]);
      mockGh.getFailedRunLog.mockResolvedValue("");
      mockGh.getPRCheckStatus.mockResolvedValue("pending");

      await runDiagnosis(repo, pr);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining(DIAGNOSIS_COMMENT_MARKER),
        { agentName: "Problematic PR Diagnoser" },
      );
    });

    it("skips when a newer report follows the rediagnosis request", async () => {
      const pr = problematicPR();
      mockGh.getIssueComments.mockResolvedValue([REPORT, REQUEST, { ...REPORT, id: 3 }]);
      mockGh.getPRCheckStatus.mockResolvedValue("failing");

      await runDiagnosis(repo, pr);

      expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("names the session tools in a failed report's next steps", async () => {
      const pr = problematicPR();
      mockGh.listPRs.mockResolvedValue([pr]);
      mockGh.getFailedRunLog.mockResolvedValue("");
      mockGh.getPRCheckStatus.mockResolvedValue("pending");

      await runDiagnosis(repo, pr);

      const body = mockGh.commentOnIssue.mock.calls.map((c: unknown[]) => c[2] as string).find((b: string) => b.includes(DIAGNOSIS_COMMENT_MARKER))!;
      expect(body).toContain("claws_retry_problematic_diagnosis");
      expect(body).toContain("claws_unmark_problematic");
      expect(body).not.toContain(REDIAGNOSE_REQUEST_MARKER);
    });
  });

  it("dedup + green CI: removes stale problematic label without replaying diagnosis", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1, body: `### 🩺 Problematic PR Diagnosis Report\n${DIAGNOSIS_COMMENT_MARKER}\n...`, login: "claws-bot" },
    ]);
    mockGh.getFailingCheck.mockResolvedValue(undefined);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await runDiagnosis(repo, pr);

    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Claws Problematic");
    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("dedup + green CI but CONFLICTING: keeps the label instead of flapping it against the breaker", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1, body: `### 🩺 Problematic PR Diagnosis Report\n${DIAGNOSIS_COMMENT_MARKER}\n...`, login: "claws-bot" },
    ]);
    mockGh.getFailingCheck.mockResolvedValue(undefined);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");

    await runDiagnosis(repo, pr);

    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("dedup + green CI with an unreadable mergeable state: keeps the label", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1, body: `### 🩺 Problematic PR Diagnosis Report\n${DIAGNOSIS_COMMENT_MARKER}\n...`, login: "claws-bot" },
    ]);
    mockGh.getFailingCheck.mockResolvedValue(undefined);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockRejectedValue(new Error("gh exploded"));

    await runDiagnosis(repo, pr);

    expect(mockGh.removeLabel).not.toHaveBeenCalled();
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
    // CI is still pending (not green) — should yield no-fix-possible, not success
    mockGh.getFailingCheck.mockResolvedValue(undefined);
    mockGh.getPRCheckStatus.mockResolvedValue("pending");

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

  it("names the stepless job and its runner when the failing check produced no logs (fleet-infra#1699)", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailedRunLog.mockResolvedValue("");
    mockGh.getFailingCheck.mockResolvedValue({
      name: "migration-exec-secrets",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123/jobs/9",
    });
    mockGh.getRunJobSummaries.mockResolvedValue([
      { id: 9, name: "migration-exec-secrets", status: "completed", conclusion: "failure", stepCount: 0, failedSteps: [], runnerName: "nas" },
    ]);

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    expect(mockGh.getRunJobSummaries).toHaveBeenCalledWith(repo.fullName, "123");
    const body = mockGh.commentOnIssue.mock.calls.at(-1)![2] as string;
    expect(body).toContain("Diagnosis stopped — failing job produced no logs (runner problem suspected)");
    expect(body).toContain("migration-exec-secrets");
    expect(body).toContain('"nas"');
    expect(body).toContain("no logs");
    expect(body).toContain("check the runner host is up");
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("does not blame the runner for a stepless job other than the failing one", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailedRunLog.mockResolvedValue("");
    mockGh.getFailingCheck.mockResolvedValue({
      name: "build",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123/job/9",
    });
    mockGh.getRunJobSummaries.mockResolvedValue([
      { id: 9, name: "build", status: "completed", conclusion: "failure", stepCount: 7, failedSteps: ["Run npm test"] },
      { id: 10, name: "deploy", status: "completed", conclusion: "cancelled", stepCount: 0, failedSteps: [], runnerName: "nas" },
    ]);

    await runDiagnosis(repo, pr);

    const body = mockGh.commentOnIssue.mock.calls.at(-1)![2] as string;
    expect(body).toContain("Diagnosis stopped — no fix attempted");
    expect(body).not.toContain('"nas"');
  });

  it("names the failing check and its link when no log could be read and no job was stepless", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailedRunLog.mockResolvedValue("");
    mockGh.getFailingCheck.mockResolvedValue({
      name: "build",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123/jobs/9",
    });
    mockGh.getRunJobSummaries.mockResolvedValue([
      { id: 9, name: "build", status: "completed", conclusion: "failure", stepCount: 7, failedSteps: ["Run npm test"] },
    ]);

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    const body = mockGh.commentOnIssue.mock.calls.at(-1)![2] as string;
    expect(body).toContain("Diagnosis stopped — no fix attempted");
    expect(body).toContain('Check "build" failed but no failed-job log could be read from https://github.com/org/repo/actions/runs/123/jobs/9');
  });

  it("green CI on round 1 with no failure log: clears stale problematic label, posts success report, runs no rounds", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailedRunLog.mockResolvedValue("");
    mockGh.getFailingCheck.mockResolvedValue(undefined);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Claws Problematic");
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("Diagnosis succeeded"),
      { agentName: "Problematic PR Diagnoser" },
    );
  });

  it("green CI on round 1 with no failure log and no checks (status=none): clears stale problematic label", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailedRunLog.mockResolvedValue("");
    mockGh.getFailingCheck.mockResolvedValue(undefined);
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Claws Problematic");
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("Diagnosis succeeded"),
      { agentName: "Problematic PR Diagnoser" },
    );
  });

  it("green CI on round 1 but the stale-label removal is unconfirmed: leaves the breaker grants untouched", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailedRunLog.mockResolvedValue("");
    mockGh.getFailingCheck.mockResolvedValue(undefined);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.removeLabel.mockResolvedValue(false);

    await runDiagnosis(repo, pr);

    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Claws Problematic");
    expect(mockDb.resetCIFixerBreakerGrants).not.toHaveBeenCalled();
  });

  it("green CI on round 1 but CONFLICTING: keeps the label and reports a manual rebase is needed", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailedRunLog.mockResolvedValue("");
    mockGh.getFailingCheck.mockResolvedValue(undefined);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("merge conflicts"),
      { agentName: "Problematic PR Diagnoser" },
    );
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
    mockClaude.getHeadSha.mockReset();
    mockClaude.getHeadSha.mockResolvedValue("aaaaaaa1111111");

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
      expect.objectContaining({ model: "opus", agent: "build", githubTokenOwner: repo.owner, forgejoAccessRepo: repo.fullName }),
    );
  });

  it("stops silently when the row is no longer problematic before the round begins", async () => {
    const pr = problematicPR();
    // The forge label is still there, but the row was unmarked.
    mockGh.listPRs.mockResolvedValue([pr]);
    mockDb.getClawsPr.mockResolvedValue({ stage: "awaiting-review" });

    await runDiagnosis(repo, pr);

    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    // No noisy report — the human unmarked it, they don't need notification.
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
    // Before the agent runs HEAD is a start SHA; once it has run HEAD is the pushed
    // SHA that getPRHeadSHA reports (so the watch is not treated as superseded).
    let agentRan = false;
    mockClaude.getHeadSha.mockReset();
    mockClaude.getHeadSha.mockImplementation(async () => (agentRan ? "aaaaaaa1111111" : "0000000start"));
    mockClaude.runClaude.mockImplementation(async () => { agentRan = true; return ""; });
    mockClaude.withExistingWorktree.mockImplementation(
      async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => { agentRan = false; return fn("/tmp/worktree"); },
    );

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
    // Round 1: start→moved, post-push read; round 2: start and end identical.
    mockClaude.getHeadSha.mockReset();
    mockClaude.getHeadSha
      .mockResolvedValueOnce("0000000start")
      .mockResolvedValueOnce("aaaaaaa1111111")
      .mockResolvedValueOnce("aaaaaaa1111111")
      .mockResolvedValue("aaaaaaa1111111");

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

  it("held: stops without a report when the fix's workflow runs are held for approval", async () => {
    const pr = problematicPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRCheckStatus.mockResolvedValue("held");
    mockGh.getFailingCheck.mockResolvedValue(undefined);

    await runDiagnosis(repo, pr);

    expect(mockGh.getPRCheckStatus).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
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
