import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";
import type { MainBuildRunRow } from "../db.js";
import type { ForgejoActionRunRow } from "../forgejo.js";

const { mockListPlans, mockFindPlanComment, mockDb, mockGh, mockForgejo, mockCiFixer, mockEnsureAlertIssue, mockResolveAlertIssue, mockUpsertAlertIssue, mockCloseAlertIssueIfResolved, mockNotifyProdAlert } = vi.hoisted(() => ({
  mockListPlans: vi.fn(async (_ref: unknown) => [] as unknown[]),
  mockFindPlanComment: vi.fn((_comments: unknown) => null as string | null),
  mockDb: {
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
    getClawsIssue: vi.fn(async () => undefined as unknown),
  },
  mockGh: {
    getRunJobSummaries: vi.fn(async () => [{ conclusion: "failure" }]),
    isInfrastructureOutage: vi.fn(() => false),
    isPreRepoStepFailure: vi.fn(() => false),
    commentOnIssue: vi.fn(async () => {}),
    getIssueComments: vi.fn(async () => [] as { body: string }[]),
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
    CI_UNRELATED_TITLE: "[ci-unrelated] CI failures unrelated to PR changes",
  },
  mockResolveAlertIssue: vi.fn(async (_opts?: { title?: string }) => null as { number: number | string; labels: string[]; updatedAt?: string } | null),
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
vi.mock("../claws-issues.js", () => ({ listPlans: mockListPlans }));
vi.mock("../plan-parser.js", () => ({ findPlanComment: mockFindPlanComment }));
vi.mock("../slack.js", () => ({ notifyProdAlert: mockNotifyProdAlert }));
vi.mock("../error-reporter.js", () => ({ reportError: vi.fn() }));
vi.mock("../planned-prs.js", () => ({ resolveTrackerId: vi.fn(async (_repo: string, ref: unknown) => `clw_${String(ref)}`) }));
vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { isTransientLog, isRetryCandidate, retrySkipReason, runKey, run } from "./main-build-monitor.js";
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

describe("retrySkipReason", () => {
  it("names each reason the gate refuses a run, in the gate's order", () => {
    expect(retrySkipReason(makeRun(), TIP, NOW)).toBeNull();
    expect(retrySkipReason(makeRun({ run_attempt: 2, head_sha: "b".repeat(40) }), TIP, NOW)).toBe("later-attempt");
    expect(retrySkipReason(makeRun({ head_sha: "b".repeat(40) }), TIP, NOW)).toBe("superseded");
    expect(retrySkipReason(makeRun({ head_sha: null }), TIP, NOW)).toBe("superseded");
    const stale = makeRun({ created_at: new Date(NOW - 5 * 60 * 60 * 1000).toISOString() });
    expect(retrySkipReason(stale, TIP, NOW)).toBe("too-old");
    // Superseded and too old at once reports the more informative `superseded`.
    expect(retrySkipReason({ ...stale, head_sha: "b".repeat(40) }, TIP, NOW)).toBe("superseded");
  });
});

describe("runKey", () => {
  it("keeps the forgejo: prefix existing main_build_failures rows carry", () => {
    expect(runKey(6)).toBe("forgejo:6");
  });
});

describe("run", () => {
  const repo = mockRepo({ forge: "forgejo" });

  /** A fresh first-attempt failure sitting on the branch tip — a retry candidate. */
  function failing(workflowName: string, runId: number, overrides: Partial<MainBuildRunRow> = {}): MainBuildRunRow {
    return makeRun({
      run_id: runId,
      run_number: runId,
      workflow_name: workflowName,
      created_at: new Date().toISOString(),
      html_url: `https://example.invalid/run/${runId}`,
      ...overrides,
    });
  }

  /** The repo's default-branch runs, newest first, as the Forgejo listing returns them. */
  function setRuns(rows: MainBuildRunRow[]): void {
    mockForgejo.listDefaultBranchActionRuns.mockResolvedValue(rows as ForgejoActionRunRow[]);
  }

  /** Every run has exactly one failed job, whose failed step logs `text`. */
  function jobLog(text: string): void {
    mockForgejo.getActionRunJobs.mockResolvedValue({ run: {}, jobs: [{ index: 0, name: "build", status: "failure" }] });
    mockForgejo.getActionJobStepLogs.mockResolvedValue({
      job: {},
      steps: [{ index: 0, name: "Build", status: "failure", log: text }],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getPendingMainBuildRetries.mockReturnValue([]);
    mockDb.getExpiredMainBuildRetries.mockReturnValue([]);
    mockDb.getUnreportedMainBuildFailures.mockReturnValue([]);
    mockDb.hasMainBuildFailure.mockReturnValue(false);
    mockDb.hasUnclosedReportedFailure.mockReturnValue(false);
    mockListPlans.mockResolvedValue([]);
    mockFindPlanComment.mockReturnValue(null);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.getRunJobSummaries.mockResolvedValue([{ conclusion: "failure" }]);
    mockGh.isInfrastructureOutage.mockReturnValue(false);
    mockGh.isPreRepoStepFailure.mockReturnValue(false);
    mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([]);
    mockForgejo.getRepo.mockResolvedValue({});
    mockForgejo.getBranchTipSha.mockResolvedValue(TIP);
    mockForgejo.getActionRunJobs.mockResolvedValue({ run: {}, jobs: [] });
    mockForgejo.getActionJobStepLogs.mockResolvedValue({ job: {}, steps: [] });
    mockForgejo.rerunFailedJobsByIndex.mockResolvedValue({ run: { index: 0, status: "waiting" }, jobs: [] });
  });

  it("refreshes the issue body so a later failure of the same workflow does not keep the first run's link", async () => {
    setRuns([failing("CI", 77, { head_sha: "b".repeat(40), event: "schedule" })]);

    await run([repo]);

    expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    const opts = mockEnsureAlertIssue.mock.calls[0][0] as { body: string; refreshBody?: boolean; title: string };
    expect(opts.refreshBody).toBe(true);
    expect(opts.title).toBe("Build failure: CI");
    expect(opts.body).toContain("https://example.invalid/run/77");
    expect(opts.body).toContain("`schedule`");
  });

  it("skips a failure it has already handled", async () => {
    setRuns([failing("CI", 5)]);
    mockDb.hasMainBuildFailure.mockReturnValue(true);

    await run([repo]);

    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
  });

  it("closes the tracking issue when the latest run is green again", async () => {
    setRuns([failing("CI", 9, { conclusion: "success" })]);
    mockDb.hasUnclosedReportedFailure.mockReturnValue(true);
    mockResolveAlertIssue.mockResolvedValue({ number: 42, labels: [] });

    await run([repo]);

    expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 42, "completed");
    expect(mockDb.markMainBuildFailuresClosed).toHaveBeenCalledWith("test-org/test-repo", "CI");
  });

  const greenCI = () => {
    setRuns([failing("CI", 9, { conclusion: "success" })]);
    mockDb.hasUnclosedReportedFailure.mockReturnValue(true);
  };

  it("closes a Backlog tracking issue on green", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue({ number: 42, labels: ["Backlog"] });

    await run([repo]);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith("test-org/test-repo", 42, expect.stringContaining("green again"), expect.anything());
    expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 42, "completed");
    expect(mockDb.markMainBuildFailuresClosed).toHaveBeenCalledWith("test-org/test-repo", "CI");
  });

  it("holds a tracking issue approved through Plan and keeps the failure rows open", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue({ number: 42, labels: [] });
    mockDb.getClawsIssue.mockResolvedValueOnce({ approved_through: "plan" });

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

  it("holds a native tracking issue with a plan version and logs why", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue({ number: "clw_01M5H67CHFSGWZH77FY1WSCSS5", labels: [] });
    mockListPlans.mockResolvedValue([{ version: 1 }]);

    await run([repo]);

    expect(mockListPlans).toHaveBeenCalledWith("clw_01M5H67CHFSGWZH77FY1WSCSS5");
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockDb.markMainBuildFailuresClosed).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("has a plan"));
  });

  it("holds a forge tracking issue whose comments hold a plan", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue({ number: 42, labels: [] });
    mockGh.getIssueComments.mockResolvedValue([{ body: "## Implementation Plan" }]);
    mockFindPlanComment.mockReturnValue("## Implementation Plan");

    await run([repo]);

    expect(mockGh.closeIssue).not.toHaveBeenCalled();
    expect(mockDb.markMainBuildFailuresClosed).not.toHaveBeenCalled();
  });

  it("does not close when the plan lookup throws, and warns", async () => {
    greenCI();
    mockResolveAlertIssue.mockResolvedValue({ number: "clw_01M5H67CHFSGWZH77FY1WSCSS6", labels: [] });
    mockListPlans.mockRejectedValue(new Error("db down"));

    await run([repo]);

    expect(mockGh.closeIssue).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("will retry"));
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
      setRuns([failing("CI", 9, { conclusion: "success" })]);
      unrelated(new Date(Date.now() - 3600_000).toISOString());

      await run([repo]);

      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 77, "completed");
    });

    it("stays open when the tracker has a plan", async () => {
      setRuns([failing("CI", 9, { conclusion: "success" })]);
      unrelated(new Date(Date.now() - 3600_000).toISOString());
      mockGh.getIssueComments.mockResolvedValue([{ body: "plan" }]);
      mockFindPlanComment.mockReturnValue("plan");

      await run([repo]);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("stays open while a workflow is still failing", async () => {
      setRuns([
        failing("CI", 9, { conclusion: "success" }),
        failing("Release", 10, { conclusion: "failure" }),
      ]);
      unrelated(new Date(Date.now() - 3600_000).toISOString());

      await run([repo]);

      expect(mockGh.closeIssue).not.toHaveBeenCalledWith("test-org/test-repo", 77, "completed");
    });

    it("stays open when the green run predates the issue's last update", async () => {
      setRuns([failing("CI", 9, { conclusion: "success" })]);
      unrelated(new Date(Date.now() + 3600_000).toISOString());

      await run([repo]);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });
  });

  it("keeps scanning a repo's other workflows after the rerun budget is spent", async () => {
    // Six transient retry candidates against a budget of five, then a superseded run that
    // only needs reporting: the budget must defer the sixth without ending the repo's pass.
    jobLog("npm error code ECONNRESET");
    setRuns([
      ...[1, 2, 3, 4, 5, 6].map((n) => failing(`CI-${n}`, n)),
      failing("Docs", 7, { head_sha: "b".repeat(40) }),
    ]);

    await run([repo]);

    expect(mockForgejo.rerunFailedJobsByIndex).toHaveBeenCalledTimes(5);
    // The deferred sixth workflow is left untouched, so it stays eligible next tick.
    expect(mockDb.recordMainBuildFailure).not.toHaveBeenCalledWith(
      "forgejo:6", expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
    // ...but the unrelated seventh is still reported.
    expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    expect((mockEnsureAlertIssue.mock.calls[0][0] as { title: string }).title).toBe("Build failure: Docs");
  });

  it("does not spend rerun budget on a re-run request that errored", async () => {
    // Classify via the infra path so the separate log-fetch budget does not bind first.
    mockGh.isInfrastructureOutage.mockReturnValue(true);
    mockForgejo.rerunFailedJobsByIndex
      .mockRejectedValueOnce(new Error("500 Internal Server Error"));
    setRuns([1, 2, 3, 4, 5, 6, 7].map((n) => failing(`CI-${n}`, n)));

    await run([repo]);

    // Seven attempts minus the one deferred by the spent budget: the errored re-run handed
    // its reserved slot back, so five re-runs still land.
    expect(mockForgejo.rerunFailedJobsByIndex).toHaveBeenCalledTimes(6);
  });

  it("says a retry was attempted when the re-run request itself failed", async () => {
    jobLog("npm error code ECONNRESET");
    mockForgejo.rerunFailedJobsByIndex.mockRejectedValue(new Error("500 Internal Server Error"));
    setRuns([failing("CI", 3)]);

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
        retry_detail: JSON.stringify({ kind: "not-transient" }),
      },
    ]);

    await run([repo]);

    expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    expect(mockDb.markMainBuildReported).toHaveBeenCalledWith("20");
    const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("did not match its transient-error heuristic");
  });

  it("re-files an unreported superseded row with the same superseded wording", async () => {
    mockDb.getUnreportedMainBuildFailures.mockReturnValue([
      {
        run_id: "22",
        repo: "test-org/test-repo",
        workflow_name: "CI",
        run_url: "https://example.invalid/run/22",
        outcome: "not-retried",
        event: "push",
        retry_detail: JSON.stringify({ kind: "superseded", tipSha: TIP, classification: "log-pattern" }),
      },
    ]);

    await run([repo]);

    const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("matched its transient-error heuristic (`log-pattern`)");
    expect(body).toContain(`https://forge.example.com/test-org/test-repo/commit/${TIP}`);
    expect(body).not.toContain("did not match");
  });

  it("claims no reason for a legacy unreported row with no stored detail", async () => {
    mockDb.getUnreportedMainBuildFailures.mockReturnValue([
      {
        run_id: "23",
        repo: "test-org/test-repo",
        workflow_name: "CI",
        run_url: "https://example.invalid/run/23",
        outcome: "not-retried",
        event: "push",
        retry_detail: null,
      },
    ]);

    await run([repo]);

    const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Claws did not retry this run.");
    expect(body).not.toContain("heuristic");
  });

  describe("why no retry ran", () => {
    const bodyOf = (i = 0) => (mockEnsureAlertIssue.mock.calls[i][0] as { body: string }).body;
    const AGED_OUT = () => new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

    it("says a superseded transient failure matched the heuristic and was deliberately not re-run", async () => {
      jobLog("npm error code ECONNRESET");
      setRuns([failing("CI", 101, { head_sha: "b".repeat(40) })]);

      await run([repo]);

      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      const body = bodyOf();
      expect(body).toContain("matched its transient-error heuristic");
      expect(body).toContain(`[\`aaaaaaa\`](https://forge.example.com/test-org/test-repo/commit/${TIP})`);
      expect(body).toContain("deliberately not re-run");
      expect(body).not.toContain("did not match");
      expect(mockDb.recordMainBuildFailure).toHaveBeenCalledWith(
        "forgejo:101", "test-org/test-repo", "CI", expect.anything(), false, "not-retried", "push",
        JSON.stringify({ kind: "superseded", tipSha: TIP, classification: "log-pattern" }),
      );
    });

    it("says a superseded genuine failure also did not match, naming the tip", async () => {
      jobLog("Error: expect(received).toBe(expected)");
      setRuns([failing("CI", 102, { head_sha: "b".repeat(40) })]);

      await run([repo]);

      const body = bodyOf();
      expect(body).toContain("`aaaaaaa`");
      expect(body).toContain("superseded run would not have been re-run");
      expect(body).toContain("did not match the transient-error heuristic");
    });

    it("classifies superseded runs on their own log budget, leaving tip retries unchanged", async () => {
      jobLog("npm error code ECONNRESET");
      setRuns([
        ...[1, 2, 3, 4, 5, 6].map((n) => failing(`Old-${n}`, 110 + n, { head_sha: "b".repeat(40) })),
        failing("CI", 120),
      ]);

      await run([repo]);

      expect(mockForgejo.rerunFailedJobsByIndex).toHaveBeenCalledWith("test-org/test-repo", 120);
      // The sixth superseded run found the wording budget spent and says so, without blaming the heuristic.
      const sixth = mockEnsureAlertIssue.mock.calls
        .map((c) => c[0] as { title: string; body: string })
        .find((o) => o.title === "Build failure: Old-6");
      expect(sixth?.body).toContain("heuristic was not applied");
      expect(sixth?.body).not.toContain("did not match");
    });

    it("says a later attempt is not retried again", async () => {
      jobLog("npm error code ECONNRESET");
      setRuns([failing("CI", 103, { run_attempt: 2 })]);

      await run([repo]);

      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      const body = bodyOf();
      expect(body).toContain("already attempt 2");
      expect(body).not.toContain("did not match");
    });

    it("says a run past the age window is too old", async () => {
      jobLog("npm error code ECONNRESET");
      setRuns([failing("CI", 104, { created_at: AGED_OUT() })]);

      await run([repo]);

      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      const body = bodyOf();
      expect(body).toContain("past its retry window");
      expect(body).not.toContain("did not match");
    });

    it("says the tip is unknown when it cannot be read", async () => {
      mockForgejo.getBranchTipSha.mockResolvedValue(null);
      setRuns([failing("CI", 105)]);

      await run([repo]);

      const body = bodyOf();
      expect(body).toContain("could not read the `main` tip commit");
      expect(body).not.toContain("did not match");
    });

    it("says why when more than one job failed", async () => {
      mockForgejo.getActionRunJobs.mockResolvedValue({
        run: {},
        jobs: [
          { index: 0, name: "build", status: "failure" },
          { index: 1, name: "lint", status: "failure" },
        ],
      });
      setRuns([failing("CI", 106)]);

      await run([repo]);

      expect(bodyOf()).toContain("2 jobs failed, and Claws only applies the log heuristic when exactly one job failed");
    });

    it("says the heuristic was not applied when the failed step's log came back empty", async () => {
      jobLog("");
      setRuns([failing("CI", 108)]);

      await run([repo]);

      const body = bodyOf();
      expect(body).toContain("heuristic was not applied");
      expect(body).not.toContain("did not match");
    });

    it("says the heuristic was not applied when no failed job could be listed", async () => {
      mockForgejo.getActionRunJobs.mockResolvedValue({ run: {}, jobs: [] });
      setRuns([failing("CI", 109)]);

      await run([repo]);

      const body = bodyOf();
      expect(body).toContain("heuristic was not applied");
      expect(body).not.toContain("did not match");
      expect(body).not.toContain("0 jobs failed");
    });

    it("still says a genuine tip failure did not match the heuristic", async () => {
      jobLog("error TS2345: Argument of type ...");
      setRuns([failing("CI", 107)]);

      await run([repo]);

      expect(bodyOf()).toContain("did not match its transient-error heuristic.");
    });

    it("says a run deferred by the rerun budget, then aged out, was too old and deferred first", async () => {
      jobLog("npm error code ECONNRESET");
      const sixth = failing("CI-6", 136);
      setRuns([
        ...[1, 2, 3, 4, 5].map((n) => failing(`CI-${n}`, 130 + n)),
        sixth,
      ]);

      await run([repo]);

      expect(mockForgejo.rerunFailedJobsByIndex).toHaveBeenCalledTimes(5);
      expect(mockEnsureAlertIssue).not.toHaveBeenCalled();

      // A later pass sees only the deferred run, now past the age window.
      setRuns([{ ...sixth, created_at: AGED_OUT() }]);
      await run([repo]);

      expect(mockForgejo.rerunFailedJobsByIndex).toHaveBeenCalledTimes(5);
      const body = bodyOf();
      expect(body).toContain("past its retry window");
      expect(body).toContain("deferred 1 time (rerun budget spent this pass)");
      expect(body).not.toContain("did not match");
    });

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
    mockEnsureAlertIssue.mockRejectedValueOnce(new Error("forge API hiccup"));

    await run([repo]);

    expect(mockDb.markMainBuildReported).not.toHaveBeenCalledWith("21");
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
    setRuns([
      failing("CI", 1),
      failing("Docs", 2, { head_sha: "b".repeat(40) }),
    ]);
    mockEnsureAlertIssue.mockRejectedValueOnce(new Error("forge API hiccup"));

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

      expect(mockForgejo.getBranchTipSha).toHaveBeenCalledWith("test-org/test-repo", "main");
      expect(mockForgejo.getActionJobStepLogs).toHaveBeenCalledWith("test-org/test-repo", 3, 0);
      expect(mockForgejo.rerunFailedJobsByIndex).toHaveBeenCalledWith("test-org/test-repo", 3);
      expect(mockDb.recordMainBuildFailure).toHaveBeenCalledWith(
        "forgejo:6", "test-org/test-repo", "deploy.yml", "https://git.example.com/o/r/actions/runs/3", true, null, event,
      );
      expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    });

    it("re-runs a run the job summaries class as an infrastructure outage without reading its log", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun()]);
      mockGh.isInfrastructureOutage.mockReturnValueOnce(true);
      failedJobLog("FAIL src/app.test.ts > adds");

      await run([forgejoRepo]);

      expect(mockGh.getRunJobSummaries).toHaveBeenCalledWith("test-org/test-repo", "3");
      expect(mockForgejo.rerunFailedJobsByIndex).toHaveBeenCalledWith("test-org/test-repo", 3);
      expect(mockForgejo.getActionJobStepLogs).not.toHaveBeenCalled();
      expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    });

    it("files the issue with the run's real trigger for a genuine test failure", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ event: "schedule" })]);
      failedJobLog("FAIL src/app.test.ts > adds\nAssertionError: expected 2 to be 3");

      await run([forgejoRepo]);

      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      expect(mockDb.recordMainBuildFailure).toHaveBeenCalledWith(
        "forgejo:6", "test-org/test-repo", "deploy.yml", "https://git.example.com/o/r/actions/runs/3", false, "not-retried", "schedule",
        JSON.stringify({ kind: "not-transient" }),
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

    it("does not re-run a superseded run, though it reads the log to word the issue", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ head_sha: "b".repeat(40) })]);
      failedJobLog(CHECKOUT_502);

      await run([forgejoRepo]);

      expect(mockForgejo.getActionRunJobs).toHaveBeenCalled();
      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      expect(mockEnsureAlertIssue).toHaveBeenCalledTimes(1);
    });

    it("says a superseded 503 registry failure matched the heuristic and names the newer tip", async () => {
      // production-infra run 765: four retried 503s on a manifest HEAD, main already moved on.
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ head_sha: "b".repeat(40) })]);
      failedJobLog(
        "ERROR: unexpected status from HEAD request to https://registry.bstjohn.net/v2/x/manifests/y: 503 Service Unavailable",
      );

      await run([forgejoRepo]);

      expect(mockForgejo.rerunFailedJobsByIndex).not.toHaveBeenCalled();
      const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
      expect(body).toContain("matched its transient-error heuristic");
      expect(body).toContain(`[\`aaaaaaa\`](https://forge.example.com/test-org/test-repo/commit/${TIP})`);
      expect(body).toContain("deliberately not re-run");
      expect(body).not.toContain("did not match");
    });

    it("says why when a Forgejo run has no web run number", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ run_number: null })]);

      await run([forgejoRepo]);

      const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
      expect(body).toContain("Forgejo reported no web run number");
      expect(body).not.toContain("did not match");
    });

    it("says the heuristic was not applied when the job log cannot be read", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun()]);
      mockForgejo.getActionRunJobs.mockRejectedValue(new Error("endpoint unavailable"));

      await run([forgejoRepo]);

      const body = (mockEnsureAlertIssue.mock.calls[0][0] as { body: string }).body;
      expect(body).toContain("the log could not be read");
      expect(body).toContain("heuristic was not applied");
      expect(body).not.toContain("did not match");
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

    it("reports rerun-errored when the re-run request fails", async () => {
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun()]);
      failedJobLog(CHECKOUT_502);
      mockForgejo.rerunFailedJobsByIndex.mockRejectedValue(
        Object.assign(new Error("action run has no failed jobs"), { status: 409 }),
      );

      await run([forgejoRepo]);

      expect(mockDb.recordMainBuildFailure).toHaveBeenCalledWith(
        "forgejo:6", expect.anything(), expect.anything(), expect.anything(), false, "rerun-errored", "push",
        JSON.stringify({ kind: "rerun-errored" }),
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

    it("leaves a legacy retry with a bare GitHub run key pending for the 24h expiry", async () => {
      // Without the prefix guard, "123456789".slice(8) is "9", which would resolve run 9.
      mockDb.getPendingMainBuildRetries.mockReturnValue([{ ...pendingRow, run_id: "123456789" }]);
      mockForgejo.listDefaultBranchActionRuns.mockResolvedValue([forgejoRun({ run_id: 9, conclusion: "success" })]);

      await run([forgejoRepo]);

      expect(mockDb.setMainBuildRetryOutcome).not.toHaveBeenCalled();
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
