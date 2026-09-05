import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";
import type { MainBuildRunRow } from "../db.js";
import type { ForgejoActionRunRow } from "../forgejo.js";

const { mockDb, mockGh, mockForgejo, mockCiFixer, mockEnsureAlertIssue, mockNotifyProdAlert } = vi.hoisted(() => ({
  mockDb: {
    getDefaultBranchRuns: vi.fn(() => [] as MainBuildRunRow[]),
    getPendingMainBuildRetries: vi.fn(() => [] as unknown[]),
    getExpiredMainBuildRetries: vi.fn(() => [] as unknown[]),
    getUnreportedMainBuildFailures: vi.fn(() => [] as unknown[]),
    setMainBuildRetryOutcome: vi.fn(),
    hasMainBuildFailure: vi.fn(() => false),
    recordMainBuildFailure: vi.fn(),
    markMainBuildReported: vi.fn(),
    hasUnclosedReportedFailure: vi.fn(() => false),
    markMainBuildFailuresClosed: vi.fn(),
  },
  mockGh: {
    getBranchTipCommit: vi.fn(async () => ({ sha: "a".repeat(40) })),
    getRunJobSummaries: vi.fn(async () => [{ conclusion: "failure" }]),
    isInfrastructureOutage: vi.fn(() => false),
    isPreRepoStepFailure: vi.fn(() => false),
    fetchFailedJobLog: vi.fn(async () => ""),
    rerunFailedJobs: vi.fn(async () => {}),
    fetchWorkflowRunById: vi.fn(
      async (): Promise<{ status: string; conclusion: string | null; event: string } | null> => null,
    ),
    findIssueByExactTitle: vi.fn(async () => null as { number: number; labels: string[] } | null),
    commentOnIssue: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
  },
  mockForgejo: {
    listDefaultBranchActionRuns: vi.fn(async () => [] as ForgejoActionRunRow[]),
  },
  mockCiFixer: {
    isPoolSaturated: vi.fn(() => false),
    isActionsPermissionDenied: vi.fn(() => false),
    reportActionsPermissionDenied: vi.fn(async () => {}),
  },
  mockEnsureAlertIssue: vi.fn(async (_opts: Record<string, unknown>) => ({ outcome: "created", issueNumber: 1 })),
  mockNotifyProdAlert: vi.fn(async () => {}),
}));

vi.mock("../config.js", () => ({
  isJobDisabledForRepo: vi.fn(() => false),
  PROD_ALERT_WORKFLOWS: {},
  MAIN_BUILD_IGNORE_WORKFLOWS: {},
  forgejoRepoUrl: vi.fn((fullName: string) => `https://forge.example.com/${fullName}`),
}));
vi.mock("../db.js", () => mockDb);
vi.mock("../github.js", () => mockGh);
vi.mock("../forgejo.js", () => mockForgejo);
vi.mock("../agents/ci-fixer.js", () => mockCiFixer);
vi.mock("../occurrence-tracking.js", () => ({ ensureAlertIssue: mockEnsureAlertIssue }));
vi.mock("../slack.js", () => ({ notifyProdAlert: mockNotifyProdAlert }));
vi.mock("../error-reporter.js", () => ({ reportError: vi.fn() }));
vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { isTransientLog, isRetryCandidate, runKey, run } from "./main-build-monitor.js";
import { reportError } from "../error-reporter.js";

const TIP = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = Date.parse("2026-09-02T12:00:00Z");

function makeRun(overrides: Partial<MainBuildRunRow> = {}): MainBuildRunRow {
  return {
    run_id: 1,
    workflow_name: "CI",
    conclusion: "failure",
    event: "push",
    created_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    head_sha: TIP,
    html_url: "https://example.invalid/run/1",
    run_attempt: 1,
    ...overrides,
  };
}

describe("isTransientLog", () => {
  it.each([
    "npm error code ECONNRESET\nnpm error network aborted",
    "The runner has received a shutdown signal",
    "net/http: TLS handshake timeout",
  ])("matches %j", (text) => {
    expect(isTransientLog(text)).toBe(true);
  });

  it.each([
    "Error: expect(received).toBe(expected)",
    "error TS2345: Argument of type ...",
    "##[error]Process completed with exit code 1",
    "",
  ])("does not match %j", (text) => {
    expect(isTransientLog(text)).toBe(false);
  });
});

describe("isRetryCandidate", () => {
  it("accepts a fresh first-attempt run on the branch tip", () => {
    expect(isRetryCandidate(makeRun(), TIP, NOW)).toBe(true);
  });

  it("rejects a run that has already been retried", () => {
    expect(isRetryCandidate(makeRun({ run_attempt: 2 }), TIP, NOW)).toBe(false);
  });

  it("rejects a superseded run — re-running it would republish a stale artefact", () => {
    expect(isRetryCandidate(makeRun({ head_sha: "b".repeat(40) }), TIP, NOW)).toBe(false);
  });

  it("rejects a run with no recorded head SHA", () => {
    expect(isRetryCandidate(makeRun({ head_sha: null }), TIP, NOW)).toBe(false);
  });

  it("rejects a run older than the age window", () => {
    const stale = makeRun({ created_at: new Date(NOW - 5 * 60 * 60 * 1000).toISOString() });
    expect(isRetryCandidate(stale, TIP, NOW)).toBe(false);
  });
});

describe("runKey", () => {
  it("namespaces a Forgejo run id so it can't collide with a GitHub run id", () => {
    expect(runKey(mockRepo({ forge: "forgejo" }), 6)).toBe("forgejo:6");
  });

  it("leaves a GitHub run id as a bare string", () => {
    expect(runKey(mockRepo(), 123)).toBe("123");
  });
});

describe("run", () => {
  const repo = mockRepo();

  /** A fresh first-attempt failure sitting on the branch tip — a retry candidate. */
  function failing(workflowName: string, runId: number, overrides: Partial<MainBuildRunRow> = {}): MainBuildRunRow {
    return makeRun({
      run_id: runId,
      workflow_name: workflowName,
      created_at: new Date().toISOString(),
      html_url: `https://example.invalid/run/${runId}`,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getDefaultBranchRuns.mockReturnValue([]);
    mockDb.getPendingMainBuildRetries.mockReturnValue([]);
    mockDb.getExpiredMainBuildRetries.mockReturnValue([]);
    mockDb.getUnreportedMainBuildFailures.mockReturnValue([]);
    mockDb.hasMainBuildFailure.mockReturnValue(false);
    mockDb.hasUnclosedReportedFailure.mockReturnValue(false);
    mockGh.getBranchTipCommit.mockResolvedValue({ sha: TIP });
    mockGh.getRunJobSummaries.mockResolvedValue([{ conclusion: "failure" }]);
    mockGh.fetchFailedJobLog.mockResolvedValue("");
    mockGh.rerunFailedJobs.mockResolvedValue(undefined);
    mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([]);
    mockCiFixer.isPoolSaturated.mockReturnValue(false);
    mockCiFixer.isActionsPermissionDenied.mockReturnValue(false);
  });

  it("refreshes the issue body so a later failure of the same workflow does not keep the first run's link", async () => {
    mockDb.getDefaultBranchRuns.mockReturnValue([failing("CI", 77, { head_sha: "b".repeat(40), event: "schedule" })]);

    await run([repo]);

    expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    const opts = mockEnsureAlertIssue.mock.calls[0][0] as { body: string; refreshBody?: boolean; title: string };
    expect(opts.refreshBody).toBe(true);
    expect(opts.title).toBe("Build failure: CI");
    expect(opts.body).toContain("https://example.invalid/run/77");
    expect(opts.body).toContain("`schedule`");
  });

  it("skips a failure it has already handled", async () => {
    mockDb.getDefaultBranchRuns.mockReturnValue([failing("CI", 5)]);
    mockDb.hasMainBuildFailure.mockReturnValue(true);

    await run([repo]);

    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.rerunFailedJobs).not.toHaveBeenCalled();
  });

  it("closes the tracking issue when the latest run is green again", async () => {
    mockDb.getDefaultBranchRuns.mockReturnValue([failing("CI", 9, { conclusion: "success" })]);
    mockDb.hasUnclosedReportedFailure.mockReturnValue(true);
    mockGh.findIssueByExactTitle.mockResolvedValue({ number: 42, labels: [] });

    await run([repo]);

    expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 42, "completed");
    expect(mockDb.markMainBuildFailuresClosed).toHaveBeenCalledWith("test-org/test-repo", "CI");
  });

  it("never closes a tracking issue that is already being worked on", async () => {
    mockDb.getDefaultBranchRuns.mockReturnValue([failing("CI", 9, { conclusion: "success" })]);
    mockDb.hasUnclosedReportedFailure.mockReturnValue(true);
    mockGh.findIssueByExactTitle.mockResolvedValue({ number: 42, labels: ["Refined"] });

    await run([repo]);

    expect(mockGh.closeIssue).not.toHaveBeenCalled();
  });

  it("keeps scanning a repo's other workflows after the rerun budget is spent", async () => {
    // Six transient retry candidates against a budget of five, then a superseded run that
    // only needs reporting: the budget must defer the sixth without ending the repo's pass.
    mockGh.fetchFailedJobLog.mockResolvedValue("npm error code ECONNRESET");
    mockDb.getDefaultBranchRuns.mockReturnValue([
      ...[1, 2, 3, 4, 5, 6].map((n) => failing(`CI-${n}`, n)),
      failing("Docs", 7, { head_sha: "b".repeat(40) }),
    ]);

    await run([repo]);

    expect(mockGh.rerunFailedJobs).toHaveBeenCalledTimes(5);
    // The deferred sixth workflow is left untouched, so it stays eligible next tick.
    expect(mockDb.recordMainBuildFailure).not.toHaveBeenCalledWith(
      "6", expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
    // ...but the unrelated seventh is still reported.
    expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    expect((mockEnsureAlertIssue.mock.calls[0][0] as { title: string }).title).toBe("Build failure: Docs");
  });

  it("keeps scanning a repo's other workflows while the runner pool is saturated", async () => {
    mockCiFixer.isPoolSaturated.mockReturnValue(true);
    mockDb.getDefaultBranchRuns.mockReturnValue([
      failing("CI", 1),
      failing("Docs", 2, { head_sha: "b".repeat(40) }),
    ]);

    await run([repo]);

    expect(mockGh.rerunFailedJobs).not.toHaveBeenCalled();
    expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    expect((mockEnsureAlertIssue.mock.calls[0][0] as { title: string }).title).toBe("Build failure: Docs");
  });

  it("does not spend rerun budget on a re-run request that errored", async () => {
    // Classify via the infra path so the separate log-fetch budget does not bind first.
    mockGh.isInfrastructureOutage.mockReturnValue(true);
    mockGh.rerunFailedJobs
      .mockRejectedValueOnce(new Error("500 Internal Server Error"))
      .mockResolvedValue(undefined);
    mockDb.getDefaultBranchRuns.mockReturnValue([1, 2, 3, 4, 5, 6, 7].map((n) => failing(`CI-${n}`, n)));

    await run([repo]);

    // Seven attempts minus the one deferred by the spent budget: the errored re-run handed
    // its reserved slot back, so five re-runs still land.
    expect(mockGh.rerunFailedJobs).toHaveBeenCalledTimes(6);
  });

  it("says a retry was attempted when the re-run request itself failed", async () => {
    mockGh.fetchFailedJobLog.mockResolvedValue("npm error code ECONNRESET");
    mockGh.rerunFailedJobs.mockRejectedValue(new Error("500 Internal Server Error"));
    mockDb.getDefaultBranchRuns.mockReturnValue([failing("CI", 3)]);

    await run([repo]);

    const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("the re-run request itself errored");
    expect(body).not.toContain("did not match its transient-error heuristic");
  });

  it("retries a build-failure report that was detected but never got filed", async () => {
    mockDb.getUnreportedMainBuildFailures.mockReturnValue([
      {
        run_id: "20",
        repo: "test-org/test-repo",
        workflow_name: "CI",
        run_url: "https://example.invalid/run/20",
        outcome: "not-retried",
        event: "push",
      },
    ]);

    await run([repo]);

    expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    expect(mockDb.markMainBuildReported).toHaveBeenCalledWith("20");
    const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("did not match its transient-error heuristic");
  });

  it("does not mark a report retried when ensureAlertIssue fails again", async () => {
    mockDb.getUnreportedMainBuildFailures.mockReturnValue([
      {
        run_id: "21",
        repo: "test-org/test-repo",
        workflow_name: "CI",
        run_url: "https://example.invalid/run/21",
        outcome: "failure",
        event: "push",
      },
    ]);
    mockEnsureAlertIssue.mockRejectedValueOnce(new Error("GitHub API hiccup"));

    await run([repo]);

    expect(mockDb.markMainBuildReported).not.toHaveBeenCalledWith("21");
  });

  it("reports a retry that failed again", async () => {
    mockDb.getPendingMainBuildRetries.mockReturnValue([
      { run_id: "11", repo: "test-org/test-repo", workflow_name: "CI", run_url: "https://example.invalid/run/11" },
    ]);
    mockGh.fetchWorkflowRunById.mockResolvedValue({ status: "completed", conclusion: "failure", event: "push" });

    await run([repo]);

    expect(mockDb.setMainBuildRetryOutcome).toHaveBeenCalledWith("11", "failure");
    const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("the retry failed too");
  });

  it("forces a retry stuck past 24h to a terminal outcome and reports it the same pass", async () => {
    mockDb.getExpiredMainBuildRetries.mockReturnValue([
      { run_id: "30", repo: "test-org/test-repo", workflow_name: "CI", run_url: "https://example.invalid/run/30" },
    ]);
    mockDb.getUnreportedMainBuildFailures.mockImplementation(() => [
      {
        run_id: "30",
        repo: "test-org/test-repo",
        workflow_name: "CI",
        run_url: "https://example.invalid/run/30",
        outcome: "retry-timed-out",
        event: "push",
      },
    ]);

    await run([repo]);

    expect(mockDb.setMainBuildRetryOutcome).toHaveBeenCalledWith("30", "retry-timed-out");
    expect(mockDb.markMainBuildReported).toHaveBeenCalledWith("30");
    const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("never reached a conclusion within 24h");
  });

  it("does not abort scanning a repo's other workflows when reporting one fails", async () => {
    // Neither workflow must look transient — both should go straight to reportFailure.
    mockGh.isInfrastructureOutage.mockReturnValue(false);
    mockGh.isPreRepoStepFailure.mockReturnValue(false);
    mockDb.getDefaultBranchRuns.mockReturnValue([
      failing("CI", 1),
      failing("Docs", 2, { head_sha: "b".repeat(40) }),
    ]);
    mockEnsureAlertIssue.mockRejectedValueOnce(new Error("GitHub API hiccup"));

    await run([repo]);

    expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(2);
    expect((mockEnsureAlertIssue.mock.calls[0][0] as { title: string }).title).toBe("Build failure: CI");
    expect((mockEnsureAlertIssue.mock.calls[1][0] as { title: string }).title).toBe("Build failure: Docs");
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(
      "main-build-monitor:report-failure",
      "test-org/test-repo",
      expect.any(Error),
    );
  });

  describe("Forgejo repos", () => {
    const forgejoRepo = mockRepo({ forge: "forgejo" });

    it("files a tracking issue straight away, never fetching the branch tip or retrying", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([
        {
          run_id: 6,
          workflow_name: "deploy.yml",
          conclusion: "failure",
          event: "push",
          created_at: new Date().toISOString(),
          head_sha: "abc",
          html_url: "https://git.example.com/o/r/actions/runs/6",
          run_attempt: null,
        },
      ]);

      await run([forgejoRepo]);

      expect(mockGh.getBranchTipCommit).not.toHaveBeenCalled();
      expect(mockGh.rerunFailedJobs).not.toHaveBeenCalled();
      expect(mockDb.recordMainBuildFailure).toHaveBeenCalledWith(
        "forgejo:6",
        "test-org/test-repo",
        "deploy.yml",
        "https://git.example.com/o/r/actions/runs/6",
        false,
        "not-retried",
        "push",
      );
      expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
      expect((mockEnsureAlertIssue.mock.calls[0][0] as { title: string }).title).toBe("Build failure: deploy.yml");
    });

    it("never reaches fetchWorkflowRunById for a namespaced Forgejo run id", async () => {
      mockDb.getPendingMainBuildRetries.mockReturnValue([
        { run_id: "forgejo:6", repo: "test-org/test-repo", workflow_name: "deploy.yml", run_url: "https://example.invalid/run/6" },
      ]);

      await run([forgejoRepo]);

      expect(mockGh.fetchWorkflowRunById).not.toHaveBeenCalled();
      expect(mockDb.setMainBuildRetryOutcome).toHaveBeenCalledWith("forgejo:6", "abandoned");
    });
  });
});
