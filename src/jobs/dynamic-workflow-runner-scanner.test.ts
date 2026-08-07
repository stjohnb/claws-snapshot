import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: { priority: "Priority" },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockGh, mockOccurrence } = vi.hoisted(() => ({
  mockGh: {
    listDynamicWorkflowRuns: vi.fn(),
    getRunJobRunnerInfo: vi.fn(),
  },
  mockOccurrence: {
    ensureAlertIssue: vi.fn(),
    closeAlertIssueIfResolved: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../occurrence-tracking.js", () => mockOccurrence);

import {
  run,
  isGitHubHostedJob,
  latestRunByPath,
  selectScannableRuns,
  buildBody,
  ISSUE_TITLE,
} from "./dynamic-workflow-runner-scanner.js";
import { reportError } from "../error-reporter.js";

function dynamicRun(overrides: Partial<{
  runId: number;
  path: string;
  name: string;
  createdAt: string;
  htmlUrl: string;
}> = {}) {
  return {
    repo: "test-org/test-repo",
    runId: 1,
    path: "dynamic/dependabot/dependabot-updates",
    name: "npm_and_yarn in /. - Update #1",
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    htmlUrl: "https://github.com/test-org/test-repo/actions/runs/1",
    ...overrides,
  };
}

function job(overrides: Partial<{ name: string; labels: string[]; runnerGroupName: string | null }> = {}) {
  return {
    name: "update",
    labels: ["self-hosted", "linux"],
    runnerGroupName: "Default",
    ...overrides,
  };
}

describe("dynamic-workflow-runner-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listDynamicWorkflowRuns.mockResolvedValue([]);
    mockGh.getRunJobRunnerInfo.mockResolvedValue([]);
    mockOccurrence.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
    mockOccurrence.closeAlertIssueIfResolved.mockResolvedValue(null);
  });

  describe("isGitHubHostedJob", () => {
    it("flags a job whose runner group is 'GitHub Actions'", () => {
      expect(isGitHubHostedJob({ labels: [], runnerGroupName: "GitHub Actions" })).toBe(true);
    });

    it("flags a job with an ubuntu- label", () => {
      expect(isGitHubHostedJob({ labels: ["ubuntu-latest"], runnerGroupName: null })).toBe(true);
    });

    it("flags a job with a windows- label", () => {
      expect(isGitHubHostedJob({ labels: ["windows-2022"], runnerGroupName: null })).toBe(true);
    });

    it("flags a job with a macos- label", () => {
      expect(isGitHubHostedJob({ labels: ["macos-14"], runnerGroupName: null })).toBe(true);
    });

    it("does not flag a self-hosted job", () => {
      expect(isGitHubHostedJob({ labels: ["self-hosted", "linux"], runnerGroupName: "Default" })).toBe(false);
    });
  });

  describe("latestRunByPath", () => {
    it("keeps only the newest run per distinct path", () => {
      const older = dynamicRun({ runId: 1, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
      const newer = dynamicRun({ runId: 2, createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
      const other = dynamicRun({ runId: 3, path: "dynamic/github-code-scanning/codeql" });

      const result = latestRunByPath([older, newer, other]);

      expect(result.map((r) => r.runId).sort()).toEqual([2, 3]);
    });
  });

  describe("selectScannableRuns", () => {
    const now = Date.now();

    it("drops a run whose latest is 20 days old, keeps one 1 day old", () => {
      const stale = dynamicRun({
        runId: 1,
        path: "dynamic/dependabot/dependabot-updates",
        createdAt: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const fresh = dynamicRun({
        runId: 2,
        path: "dynamic/github-code-scanning/codeql",
        createdAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const result = selectScannableRuns([stale, fresh], now);

      expect(result.map((r) => r.runId)).toEqual([2]);
    });

    it("drops a pages run even when it is fresh", () => {
      const pages = dynamicRun({
        runId: 1,
        path: "dynamic/pages/pages-build-deployment",
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
      });

      const result = selectScannableRuns([pages], now);

      expect(result).toEqual([]);
    });

    it("returns only the dependabot run when both a fresh dependabot and fresh pages run are present", () => {
      const dependabot = dynamicRun({
        runId: 1,
        path: "dynamic/dependabot/dependabot-updates",
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
      });
      const pages = dynamicRun({
        runId: 2,
        path: "dynamic/pages/pages-build-deployment",
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
      });

      const result = selectScannableRuns([dependabot, pages], now);

      expect(result.map((r) => r.runId)).toEqual([1]);
    });

    it("still collapses two runs of the same path to the newest", () => {
      const older = dynamicRun({
        runId: 1,
        createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      });
      const newer = dynamicRun({
        runId: 2,
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
      });

      const result = selectScannableRuns([older, newer], now);

      expect(result.map((r) => r.runId)).toEqual([2]);
    });
  });

  it("is a no-op when the repo has no dynamic workflow runs", async () => {
    mockGh.listDynamicWorkflowRuns.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.getRunJobRunnerInfo).not.toHaveBeenCalled();
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("files an alert issue when a dynamic workflow job ran on a GitHub-hosted runner", async () => {
    mockGh.listDynamicWorkflowRuns.mockResolvedValue([dynamicRun()]);
    mockGh.getRunJobRunnerInfo.mockResolvedValue([job({ name: "update", labels: [], runnerGroupName: "GitHub Actions" })]);

    await run([repo]);

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const call = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(call.repo).toBe(repo.fullName);
    expect(call.title).toBe(ISSUE_TITLE);
    expect(call.labels).toEqual(["Priority"]);
    expect(call.body).toContain("dynamic/dependabot/dependabot-updates");
    expect(call.body).toContain("Runner label");
    expect(mockOccurrence.closeAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("flags a job by ubuntu- label even with a non-GitHub-Actions runner group name", async () => {
    mockGh.listDynamicWorkflowRuns.mockResolvedValue([dynamicRun()]);
    mockGh.getRunJobRunnerInfo.mockResolvedValue([job({ labels: ["ubuntu-latest"], runnerGroupName: null })]);

    await run([repo]);

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
  });

  it("closes an existing alert issue once the repo is fully self-hosted again", async () => {
    mockGh.listDynamicWorkflowRuns.mockResolvedValue([dynamicRun()]);
    mockGh.getRunJobRunnerInfo.mockResolvedValue([job({ labels: ["self-hosted", "linux"], runnerGroupName: "Default" })]);

    await run([repo]);

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledTimes(1);
    expect(mockOccurrence.closeAlertIssueIfResolved.mock.calls[0]![0]).toMatchObject({
      repo: repo.fullName,
      title: ISSUE_TITLE,
    });
  });

  it("only checks the latest run per dynamic workflow path, ignoring stale hosted-runner history", async () => {
    mockGh.listDynamicWorkflowRuns.mockResolvedValue([
      dynamicRun({ runId: 1, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }),
      dynamicRun({ runId: 2, createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    ]);
    mockGh.getRunJobRunnerInfo.mockImplementation(async (_repo: string, runId: number) =>
      runId === 1
        ? [job({ labels: [], runnerGroupName: "GitHub Actions" })]
        : [job({ labels: ["self-hosted", "linux"], runnerGroupName: "Default" })],
    );

    await run([repo]);

    expect(mockGh.getRunJobRunnerInfo).toHaveBeenCalledTimes(1);
    expect(mockGh.getRunJobRunnerInfo).toHaveBeenCalledWith(repo.fullName, 2);
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledTimes(1);
  });

  it("closes the alert for a dead path whose latest hosted run is 150 days old, without re-fetching jobs", async () => {
    mockGh.listDynamicWorkflowRuns.mockResolvedValue([
      dynamicRun({
        runId: 1,
        path: "dynamic/pages/pages-build-deployment",
        createdAt: new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    await run([repo]);

    expect(mockGh.getRunJobRunnerInfo).not.toHaveBeenCalled();
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledTimes(1);
    expect(mockOccurrence.closeAlertIssueIfResolved.mock.calls[0]![0]).toMatchObject({
      repo: repo.fullName,
      title: ISSUE_TITLE,
    });
  });

  it("never alerts on a fresh legacy Pages build even when it is GitHub-hosted", async () => {
    mockGh.listDynamicWorkflowRuns.mockResolvedValue([
      dynamicRun({
        runId: 1,
        path: "dynamic/pages/pages-build-deployment",
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    ]);

    await run([repo]);

    expect(mockGh.getRunJobRunnerInfo).not.toHaveBeenCalled();
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledTimes(1);
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });
    mockGh.listDynamicWorkflowRuns
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([]);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "dynamic-workflow-runner-scanner:process-repo",
      repo.fullName,
      expect.any(Error),
    );
  });

  it("never touches the alert issue when a job-fetch failure is inconclusive rather than a real resolution", async () => {
    mockGh.listDynamicWorkflowRuns.mockResolvedValue([dynamicRun()]);
    mockGh.getRunJobRunnerInfo.mockRejectedValue(new Error("gh api ... failed: HTTP 500"));

    await run([repo]);

    expect(reportError).toHaveBeenCalledWith(
      "dynamic-workflow-runner-scanner:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  describe("buildBody", () => {
    it("renders a violation row and the org-setting remedy", () => {
      const body = buildBody("test-org/test-repo", [
        {
          path: "dynamic/dependabot/dependabot-updates",
          runId: 99,
          htmlUrl: "https://github.com/test-org/test-repo/actions/runs/99",
          jobName: "update",
          labels: [],
          runnerGroupName: "GitHub Actions",
        },
      ]);
      expect(body).toContain("| Workflow | Job | Runner | Latest run |");
      expect(body).toContain("[99](https://github.com/test-org/test-repo/actions/runs/99)");
      expect(body).toContain("dynamic/dependabot/dependabot-updates");
      expect(body).toContain("GitHub Actions");
      expect(body).toContain("Org Settings");
      expect(body).toContain("Runner label");
    });
  });
});
