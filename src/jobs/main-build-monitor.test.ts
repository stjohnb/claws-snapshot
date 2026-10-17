import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";
import type { MainBuildRunRow } from "../db.js";
import type { ForgejoActionRunRow } from "../forgejo.js";

const { mockDb, mockGh, mockForgejo, mockCiFixer, mockEnsureAlertIssue, mockResolveAlertIssue, mockUpsertAlertIssue, mockCloseAlertIssueIfResolved, mockNotifyProdAlert } = vi.hoisted(() => ({
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
    listOpenClawsPrsForIssue: vi.fn(async () => [] as unknown[]),
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
    commentOnIssue: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
  },
  mockForgejo: {
    listDefaultBranchActionRuns: vi.fn(async () => [] as ForgejoActionRunRow[]),
    getRepo: vi.fn(async () => ({})),
    getBranchTipSha: vi.fn(async (): Promise<string | null> => "a".repeat(40)),
    getActionRunJobs: vi.fn(async () => ({ run: {}, jobs: [] as Array<{ index: number; name: string; status: string }> })),
    getActionJobStepLogs: vi.fn(async () => ({ job: {}, steps: [] as Array<{ index: number; name: string; status: string; log: string }> })),
    rerunFailedJobsByIndex: vi.fn(async () => ({ run: { index: 0, status: "waiting" }, jobs: [] })),
  },
  mockCiFixer: {
    isPoolSaturated: vi.fn(() => false),
    isActionsPermissionDenied: vi.fn(() => false),
    reportActionsPermissionDenied: vi.fn(async () => {}),
    CI_UNRELATED_TITLE: "[ci-unrelated] CI failures unrelated to PR changes",
  },
  mockResolveAlertIssue: vi.fn(async (_opts?: { title?: string }) => null as { number: number; labels: string[]; updatedAt?: string } | null),
  mockUpsertAlertIssue: vi.fn(async () => "created"),
  mockCloseAlertIssueIfResolved: vi.fn(async () => null),
  mockEnsureAlertIssue: vi.fn(async (_opts: Record<string, unknown>) => ({ outcome: "created", issueNumber: 1 })),
  mockNotifyProdAlert: vi.fn(async () => {}),
}));

vi.mock("../config.js", () => ({
  isJobDisabledForRepo: vi.fn(() => false),
  PROD_ALERT_WORKFLOWS: {},
  MAIN_BUILD_IGNORE_WORKFLOWS: {},
  getProdAlertWorkflows: () => [],
  getMainBuildIgnoreWorkflows: () => [],
  forgejoRepoUrl: vi.fn((fullName: string) => `https://forge.example.com/${fullName}`),
}));
vi.mock("../db.js", () => mockDb);
vi.mock("../github.js", () => mockGh);
vi.mock("../forgejo.js", () => mockForgejo);
vi.mock("../agents/ci-fixer.js", () => mockCiFixer);
vi.mock("../occurrence-tracking.js", () => ({ ensureAlertIssue: mockEnsureAlertIssue, resolveAlertIssue: mockResolveAlertIssue, upsertAlertIssue: mockUpsertAlertIssue, closeAlertIssueIfResolved: mockCloseAlertIssueIfResolved }));
vi.mock("../slack.js", () => ({ notifyProdAlert: mockNotifyProdAlert }));
vi.mock("../error-reporter.js", () => ({ reportError: vi.fn() }));
vi.mock("../planned-prs.js", () => ({ resolveTrackerId: vi.fn(async (_repo: string, ref: unknown) => `clw_${String(ref)}`) }));
vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { isTransientLog, isRetryCandidate, runKey, run } from "./main-build-monitor.js";
import { reportError } from "../error-reporter.js";
import * as log from "../log.js";
import { stripAnsi } from "../log-excerpt.js";

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
    // bonkus run 352: the forge answered the checkout with a 502.
    "fatal: unable to access 'https://git.home.bstjohn.net/St-John-Software/bonkus/': The requested URL returned error: 502",
    "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nfatal: expected 'packfile'",
  ])("matches %j", (text) => {
    expect(isTransientLog(text)).toBe(true);
  });

  it.each([
    "Error: expect(received).toBe(expected)",
    "error TS2345: Argument of type ...",
    "##[error]Process completed with exit code 1",
    "",
    "The job running on runner hetzner-runner has exceeded the maximum execution time of 20 minutes.\nError: The operation was canceled.",
    // A step's `curl -f` smoke test hitting a 502 from the app is a genuine failure.
    "curl: (22) The requested URL returned error: 502",
    "fatal: expected 'packfile'",
  ])("does not match %j", (text) => {
    expect(isTransientLog(text)).toBe(false);
  });

  it("matches an ANSI-coloured Docker build log after stripping", () => {
    const text = "\x1b[33m#12 34.16 npm error code ECONNRESET\x1b[0m\n"
      + "\x1b[33m#12 34.16 npm error network aborted\x1b[0m";
    expect(isTransientLog(stripAnsi(text))).toBe(true);
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
    mockForgejo.getRepo.mockResolvedValue({});
    mockForgejo.getBranchTipSha.mockResolvedValue(TIP);
    mockForgejo.getActionRunJobs.mockResolvedValue({ run: {}, jobs: [] });
    mockForgejo.getActionJobStepLogs.mockResolvedValue({ job: {}, steps: [] });
    mockForgejo.rerunFailedJobsByIndex.mockResolvedValue({ run: { index: 0, status: "waiting" }, jobs: [] });
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
    mockResolveAlertIssue.mockResolvedValue({ number: 42, labels: [] });

    await run([repo]);

    expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 42, "completed");
    expect(mockDb.markMainBuildFailuresClosed).toHaveBeenCalledWith("test-org/test-repo", "CI");
  });

  const greenCI = () => {
    mockDb.getDefaultBranchRuns.mockReturnValue([failing("CI", 9, { conclusion: "success" })]);
    mockDb.hasUnclosedReportedFailure.mockReturnValue(true);
  };

  it("closes a Claws Ignore tracking issue on green", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue({ number: 42, labels: ["Claws Ignore"] });

    await run([repo]);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith("test-org/test-repo", 42, expect.stringContaining("green again"), expect.anything());
    expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 42, "completed");
    expect(mockDb.markMainBuildFailuresClosed).toHaveBeenCalledWith("test-org/test-repo", "CI");
  });

  it("holds a Refined tracking issue and keeps the failure rows open", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue({ number: 42, labels: ["Refined"] });

    await run([repo]);

    expect(mockGh.closeIssue).not.toHaveBeenCalled();
    expect(mockDb.markMainBuildFailuresClosed).not.toHaveBeenCalled();
  });

  it("holds a tracking issue with an open PR and keeps the failure rows open", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue({ number: 42, labels: [] });
    mockDb.listOpenClawsPrsForIssue.mockResolvedValueOnce([{ repo: "test-org/test-repo", prNumber: 7 }]);

    await run([repo]);

    expect(mockDb.listOpenClawsPrsForIssue).toHaveBeenCalledWith("clw_42");
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
    expect(mockDb.markMainBuildFailuresClosed).not.toHaveBeenCalled();
  });

  it("keeps the failure rows open when the close fails, and warns", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue({ number: 42, labels: [] });
    mockGh.closeIssue.mockRejectedValueOnce(new Error("blocked"));

    await run([repo]);

    expect(mockDb.markMainBuildFailuresClosed).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("will retry"));
  });

  it("marks the failure rows closed when no open issue is found", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue(null);

    await run([repo]);

    expect(mockDb.markMainBuildFailuresClosed).toHaveBeenCalledWith("test-org/test-repo", "CI");
  });

  describe("[ci-unrelated] close on green", () => {
    const unrelated = (updatedAt: string) =>
      mockResolveAlertIssue.mockImplementation(async (opts?: { title?: string }) =>
        opts?.title?.startsWith("[ci-unrelated]") ? { number: 77, labels: [], updatedAt } : null);

    it("closes when every workflow is green and the newest run postdates the issue update", async () => {
      mockDb.getDefaultBranchRuns.mockReturnValue([failing("CI", 9, { conclusion: "success" })]);
      unrelated(new Date(Date.now() - 3600_000).toISOString());

      await run([repo]);

      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 77, "completed");
    });

    it("stays open while a workflow is still failing", async () => {
      mockDb.getDefaultBranchRuns.mockReturnValue([
        failing("CI", 9, { conclusion: "success" }),
        failing("Release", 10, { conclusion: "failure" }),
      ]);
      unrelated(new Date(Date.now() - 3600_000).toISOString());

      await run([repo]);

      expect(mockGh.closeIssue).not.toHaveBeenCalledWith("test-org/test-repo", 77, "completed");
    });

    it("stays open when the green run predates the issue's last update", async () => {
      mockDb.getDefaultBranchRuns.mockReturnValue([failing("CI", 9, { conclusion: "success" })]);
      unrelated(new Date(Date.now() + 3600_000).toISOString());

      await run([repo]);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });
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
      { repo: "test-org/test-repo" },
    );
  });

  describe("Forgejo repos", () => {
    const forgejoRepo = mockRepo({ forge: "forgejo" });

    /** A fresh failed Forgejo run on the branch tip, triggered by `event`. */
    function forgejoRun(overrides: Partial<ForgejoActionRunRow> = {}): ForgejoActionRunRow {
      return {
        run_id: 6,
        run_number: 3,
        workflow_name: "deploy.yml",
        conclusion: "failure",
        event: "push",
        created_at: new Date().toISOString(),
        head_sha: TIP,
        html_url: "https://git.example.com/o/r/actions/runs/3",
        run_attempt: null,
        ...overrides,
      };
    }

    const CHECKOUT_502 = [
      "fatal: unable to access 'https://git.home.bstjohn.net/St-John-Software/bonkus/': The requested URL returned error: 502",
      "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502",
      "fatal: expected 'packfile'",
    ].join("\n");

    /** One failed job whose failed steps log `text`, plus an always() summary step that also fails. */
    function failedJobLog(text: string): void {
      mockForgejo.getActionRunJobs.mockResolvedValue({
        run: {},
        jobs: [
          { index: 0, name: "build", status: "failure" },
          { index: 1, name: "lint", status: "success" },
        ],
      });
      mockForgejo.getActionJobStepLogs.mockResolvedValue({
        job: {},
        steps: [
          { index: 0, name: "Checkout", status: "failure", log: `\x1b[31m${text}\x1b[0m` },
          { index: 1, name: "Test", status: "skipped", log: "" },
          { index: 2, name: "Generate summary", status: "failure", log: "summary.json: no such file" },
        ],
      });
    }

    it.each(["schedule", "push"])("re-runs a %s run whose checkout got a 502 from the forge", async (event) => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ event })]);
      failedJobLog(CHECKOUT_502);

      await run([forgejoRepo]);

      expect(mockGh.getBranchTipCommit).not.toHaveBeenCalled();
      expect(mockForgejo.getBranchTipSha).toHaveBeenCalledWith("test-org/test-repo", "main");
      expect(mockForgejo.getActionJobStepLogs).toHaveBeenCalledWith("test-org/test-repo", 3, 0);
      expect(mockForgejo.rerunFailedJobsByIndex).toHaveBeenCalledWith("test-org/test-repo", 3);
      expect(mockGh.rerunFailedJobs).not.toHaveBeenCalled();
      expect(mockDb.recordMainBuildFailure).toHaveBeenCalledWith(
        "forgejo:6", "test-org/test-repo", "deploy.yml", "https://git.example.com/o/r/actions/runs/3", true, null, event,
      );
      expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    });

    it("files the issue with the run's real trigger for a genuine test failure", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ event: "schedule" })]);
      failedJobLog("FAIL src/app.test.ts > adds\nAssertionError: expected 2 to be 3");

      await run([forgejoRepo]);

      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      expect(mockDb.recordMainBuildFailure).toHaveBeenCalledWith(
        "forgejo:6", "test-org/test-repo", "deploy.yml", "https://git.example.com/o/r/actions/runs/3", false, "not-retried", "schedule",
      );
      expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
      const opts = mockEnsureAlertIssue.mock.calls[0][0] as { title: string; body: string };
      expect(opts.title).toBe("Build failure: deploy.yml");
      expect(opts.body).toContain("**Triggered by:** `schedule`");
      expect(opts.body).not.toContain("`push`");
    });

    it("does not re-run a timed-out job", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun()]);
      failedJobLog(
        "The job running on runner r1 has exceeded the maximum execution time of 20 minutes.\nThe operation was canceled.",
      );

      await run([forgejoRepo]);

      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    });

    it("does not re-run a superseded run", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ head_sha: "b".repeat(40) })]);
      failedJobLog(CHECKOUT_502);

      await run([forgejoRepo]);

      expect(mockForgejo.getActionRunJobs).not.toHaveBeenCalled();
      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    });

    it("does not re-run when the branch tip is unknown", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun()]);
      mockForgejo.getBranchTipSha.mockResolvedValue(null);
      failedJobLog(CHECKOUT_502);

      await run([forgejoRepo]);

      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    });

    it("does not re-run a run with no web run number", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ run_number: null })]);
      failedJobLog(CHECKOUT_502);

      await run([forgejoRepo]);

      expect(mockForgejo.getActionRunJobs).not.toHaveBeenCalled();
      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    });

    it("files the issue when the job log cannot be read", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun()]);
      mockForgejo.getActionRunJobs.mockRejectedValue(new Error("endpoint unavailable"));

      await run([forgejoRepo]);

      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn)).toHaveBeenCalled();
      expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    });

    it("treats a 409 'action run is not done' as already running", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun()]);
      failedJobLog(CHECKOUT_502);
      mockForgejo.rerunFailedJobsByIndex.mockRejectedValue(
        Object.assign(new Error("action run is not done"), { status: 409 }),
      );

      await run([forgejoRepo]);

      expect(mockDb.recordMainBuildFailure).toHaveBeenCalledWith(
        "forgejo:6", expect.anything(), expect.anything(), expect.anything(), true, null, "push",
      );
      expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    });

    it("reports rerun-errored, without the GitHub permission alert, when the re-run request fails", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun()]);
      failedJobLog(CHECKOUT_502);
      mockCiFixer.isActionsPermissionDenied.mockReturnValue(true);
      mockForgejo.rerunFailedJobsByIndex.mockRejectedValue(
        Object.assign(new Error("action run has no failed jobs"), { status: 409 }),
      );

      await run([forgejoRepo]);

      expect(mockCiFixer.reportActionsPermissionDenied).not.toHaveBeenCalled();
      expect(mockDb.recordMainBuildFailure).toHaveBeenCalledWith(
        "forgejo:6", expect.anything(), expect.anything(), expect.anything(), false, "rerun-errored", "push",
      );
      const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
      expect(body).toContain("asked the forge to re-run");
    });

    const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

    it("treats a 404 runs listing on a readable repo as nothing to monitor", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockRejectedValue(httpError(404));

      await run([forgejoRepo]);

      expect(vi.mocked(reportError)).not.toHaveBeenCalled();
      expect(mockUpsertAlertIssue).not.toHaveBeenCalled();
      expect(mockCloseAlertIssueIfResolved).toHaveBeenCalled();
    });

    it("raises one alert when both the repo and runs endpoints return 404", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockRejectedValue(httpError(404));
      mockForgejo.getRepo.mockRejectedValue(httpError(404));

      await run([forgejoRepo]);

      expect(vi.mocked(reportError)).not.toHaveBeenCalled();
      expect(mockUpsertAlertIssue).toHaveBeenCalledTimes(1);
      expect((mockUpsertAlertIssue.mock.calls[0] as unknown as [{ title: string }])[0].title).toBe(
        "Claws cannot read this repo on Forgejo",
      );
    });

    it("keeps reporting non-404 runs errors", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockRejectedValue(httpError(403));

      await run([forgejoRepo]);

      expect(vi.mocked(reportError)).toHaveBeenCalledWith(
        "main-build-monitor:process-repo",
        "test-org/test-repo",
        expect.any(Error),
        { repo: "test-org/test-repo" },
      );
    });

    it("still processes the next repo after a 404", async () => {
      const other = mockRepo({ forge: "forgejo", fullName: "test-org/other" });
      mockForgejo.listDefaultBranchActionRuns
        .mockRejectedValueOnce(httpError(404))
        .mockResolvedValueOnce([
          {
            run_id: 9,
            run_number: null,
            workflow_name: "ci.yml",
            conclusion: "failure",
            event: "push",
            created_at: new Date().toISOString(),
            head_sha: "abc",
            html_url: "https://git.example.com/o/r/actions/runs/9",
            run_attempt: null,
          },
        ]);

      await run([forgejoRepo, other]);

      expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    });

    const pendingRow = {
      run_id: "forgejo:6",
      repo: "test-org/test-repo",
      workflow_name: "deploy.yml",
      run_url: "https://git.example.com/o/r/actions/runs/3",
    };

    it("reports a Forgejo retry that failed again, with the run's real trigger", async () => {
      mockDb.getPendingMainBuildRetries.mockReturnValue([pendingRow]);
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([
        forgejoRun({ event: "schedule", head_sha: "b".repeat(40) }),
      ]);

      await run([forgejoRepo]);

      expect(mockGh.fetchWorkflowRunById).not.toHaveBeenCalled();
      expect(mockDb.setMainBuildRetryOutcome).toHaveBeenCalledWith("forgejo:6", "failure");
      const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
      expect(body).toContain("the retry failed too");
      expect(body).toContain("**Triggered by:** `schedule`");
    });

    it("records a Forgejo retry that passed", async () => {
      mockDb.getPendingMainBuildRetries.mockReturnValue([pendingRow]);
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ conclusion: "success" })]);

      await run([forgejoRepo]);

      expect(mockDb.setMainBuildRetryOutcome).toHaveBeenCalledWith("forgejo:6", "success");
      expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    });

    it("leaves a Forgejo retry pending while its run is not listed as finished", async () => {
      mockDb.getPendingMainBuildRetries.mockReturnValue([pendingRow]);
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([]);

      await run([forgejoRepo]);

      expect(mockDb.setMainBuildRetryOutcome).not.toHaveBeenCalled();
      expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    });
  });
});
