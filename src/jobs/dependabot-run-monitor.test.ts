import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: { priority: "Priority" },
  SELF_REPO: "St-John-Software/claws",
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

const { mockGh, mockOccurrence, mockSmartSchedule } = vi.hoisted(() => ({
  mockGh: {
    listDependabotUpdateRuns: vi.fn(),
    fetchFailedJobLog: vi.fn(),
    findIssueByExactTitle: vi.fn(),
    closeIssue: vi.fn(),
    fetchRepoFileContent: vi.fn(),
  },
  mockOccurrence: {
    ensureAlertIssue: vi.fn(),
  },
  mockSmartSchedule: {
    withDailyRepoMarking: vi.fn(
      async (_job: string, _repo: string, fn: () => Promise<void>) => fn(),
    ),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../occurrence-tracking.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../occurrence-tracking.js")>()),
  ensureAlertIssue: mockOccurrence.ensureAlertIssue,
}));
vi.mock("../smart-schedule.js", () => mockSmartSchedule);

import {
  processRepo,
  groupKey,
  extractDependabotErrors,
  buildBody,
  isRetiredGroup,
} from "./dependabot-run-monitor.js";
import { parseCoverage } from "./dependabot-config-scanner.js";

const HANDLED_ERROR_LINE =
  '2026-07-20T21:02:13.7628603Z updater | 2026/07/20 21:02:13 INFO <job_1469069355> Handled error whilst updating @types/react: dependency_file_not_resolvable {message: "Override for @types/react@19.2.17 conflicts with direct dependency."}';

function run(overrides: Partial<{
  runId: number;
  name: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  htmlUrl: string;
}> = {}) {
  return {
    repo: "test-org/test-repo",
    runId: 1,
    name: "npm_and_yarn in /. - Update #1469069355",
    status: "completed",
    conclusion: "failure",
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    htmlUrl: "https://github.com/test-org/test-repo/actions/runs/1",
    ...overrides,
  };
}

describe("dependabot-run-monitor", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSmartSchedule.withDailyRepoMarking.mockImplementation(
      async (_job: string, _repo: string, fn: () => Promise<void>) => fn(),
    );
    mockGh.listDependabotUpdateRuns.mockResolvedValue([]);
    mockGh.fetchFailedJobLog.mockResolvedValue("");
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.closeIssue.mockResolvedValue(undefined);
    mockOccurrence.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 7 });
    mockGh.fetchRepoFileContent.mockResolvedValue(
      "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n  - package-ecosystem: github-actions\n    directory: /\n",
    );
  });

  describe("groupKey", () => {
    it("strips the ' - Update #<n>' suffix", () => {
      expect(groupKey("npm_and_yarn in /. - Update #1469069355")).toBe("npm_and_yarn in /.");
      expect(groupKey("terraform in /infra - Update #1469069356")).toBe("terraform in /infra");
    });

    it("returns the full name when the separator is absent", () => {
      expect(groupKey("  npm_and_yarn in /.  ")).toBe("npm_and_yarn in /.");
    });
  });

  describe("extractDependabotErrors", () => {
    it("extracts the dependency, error type, and detail from a handled-error line", () => {
      const [first] = extractDependabotErrors(HANDLED_ERROR_LINE);
      expect(first).toContain("@types/react");
      expect(first).toContain("dependency_file_not_resolvable");
      expect(first).toContain("Override for @types/react");
    });

    it("extracts ##[error] lines", () => {
      const errors = extractDependabotErrors(
        "2026-07-20T21:02:14.0000000Z ##[error]Dependabot encountered an error performing the update",
      );
      expect(errors).toEqual(["Dependabot encountered an error performing the update"]);
    });

    it("dedupes repeated lines", () => {
      const log = Array.from({ length: 12 }, (_, i) => `##[error]failure ${i % 3}`).join("\n");
      expect(extractDependabotErrors(log)).toEqual(["failure 0", "failure 1", "failure 2"]);
    });

    it("caps at five entries", () => {
      const log = Array.from({ length: 9 }, (_, i) => `##[error]failure ${i}`).join("\n");
      expect(extractDependabotErrors(log)).toHaveLength(5);
    });

    it("returns [] for empty input", () => {
      expect(extractDependabotErrors("")).toEqual([]);
    });
  });

  describe("isRetiredGroup", () => {
    const npmAndActionsConfig = parseCoverage(
      "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n  - package-ecosystem: github-actions\n    directory: /\n",
    )!;

    it("treats a group as retired when its ecosystem+directory has no declaring entry", () => {
      expect(isRetiredGroup("terraform in /infra", npmAndActionsConfig)).toBe(true);
    });

    it("does not retire a group whose ecosystem+directory is still declared", () => {
      expect(isRetiredGroup("npm_and_yarn in /.", npmAndActionsConfig)).toBe(false);
    });

    it("retires a group in a directory the config no longer covers", () => {
      expect(isRetiredGroup("npm_and_yarn in /apps/web", npmAndActionsConfig)).toBe(true);
    });

    it("does not retire when the config uses a directories: glob for the ecosystem", () => {
      const coverage = parseCoverage(
        "version: 2\nupdates:\n  - package-ecosystem: npm\n    directories:\n      - /apps/*\n",
      )!;
      expect(isRetiredGroup("npm_and_yarn in /apps/web", coverage)).toBe(false);
    });

    it("does not retire when the config uses a globbed directory: string", () => {
      const coverage = parseCoverage(
        "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /apps/*\n",
      )!;
      expect(isRetiredGroup("npm_and_yarn in /apps/web", coverage)).toBe(false);
    });

    it("never retires a run-name token it has no ecosystem mapping for", () => {
      expect(isRetiredGroup("cocoapods in /.", npmAndActionsConfig)).toBe(false);
    });

    it("never retires a key that doesn't match the 'X in Y' shape", () => {
      expect(isRetiredGroup("weird-name", npmAndActionsConfig)).toBe(false);
    });
  });

  it("files one issue naming only the group whose latest run failed", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue([
      run({ runId: 10, name: "npm_and_yarn in /. - Update #1", conclusion: "failure" }),
      run({ runId: 11, name: "github_actions in /. - Update #2", conclusion: "success" }),
    ]);
    mockGh.fetchFailedJobLog.mockResolvedValue(HANDLED_ERROR_LINE);

    await processRepo(repo);

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const body = mockOccurrence.ensureAlertIssue.mock.calls[0][0].body as string;
    expect(body).toContain("npm_and_yarn in /.");
    expect(body).not.toContain("github_actions");
    expect(body).toContain("dependency_file_not_resolvable");
    expect(mockOccurrence.ensureAlertIssue.mock.calls[0][0].labels).toEqual([]);
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
  });

  it("ignores an older failure when the latest run in the group succeeded, and closes the issue", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue([
      run({
        runId: 20,
        name: "npm_and_yarn in /. - Update #1",
        conclusion: "failure",
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      }),
      run({
        runId: 21,
        name: "npm_and_yarn in /. - Update #2",
        conclusion: "success",
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    ]);
    mockGh.findIssueByExactTitle.mockResolvedValue({ number: 42 });

    await processRepo(repo);

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 42, "completed");
  });

  it("ignores runs older than 30 days entirely", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue([
      run({
        conclusion: "failure",
        createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    await processRepo(repo);

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
  });

  it("excludes in_progress runs so a running update cannot close the issue", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue([
      run({ status: "in_progress", conclusion: null }),
    ]);
    mockGh.findIssueByExactTitle.mockResolvedValue({ number: 42 });

    await processRepo(repo);

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
  });

  it("is a no-op when the repo has no Dependabot updater runs", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue([]);
    mockGh.findIssueByExactTitle.mockResolvedValue({ number: 42 });

    await processRepo(repo);

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
  });

  it("fetches at most three job logs per repo", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue(
      ["a", "b", "c", "d", "e"].map((eco, i) =>
        run({ runId: 30 + i, name: `${eco} in /. - Update #${i}`, conclusion: "failure" }),
      ),
    );

    await processRepo(repo);

    expect(mockGh.fetchFailedJobLog).toHaveBeenCalledTimes(3);
    const body = mockOccurrence.ensureAlertIssue.mock.calls[0][0].body as string;
    expect(body).toContain("no error lines could be extracted");
  });

  it("suppresses a retired ecosystem's permanently-failing run and closes the stale alert issue", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue([
      run({
        runId: 1,
        name: "terraform in /infra - Update #1",
        conclusion: "failure",
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      }),
      run({
        runId: 2,
        name: "npm_and_yarn in /. - Update #2",
        conclusion: "success",
      }),
    ]);
    mockGh.fetchRepoFileContent.mockResolvedValue(
      "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n  - package-ecosystem: github-actions\n    directory: /\n",
    );
    mockGh.findIssueByExactTitle.mockResolvedValue({ number: 206 });

    await processRepo(repo);

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 206, "completed");
  });

  it("treats a missing dependabot.yml as every failing group being retired", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue([
      run({ runId: 1, name: "terraform in /infra - Update #1", conclusion: "failure" }),
    ]);
    mockGh.fetchRepoFileContent.mockResolvedValue(null);
    mockGh.findIssueByExactTitle.mockResolvedValue({ number: 206 });

    await processRepo(repo);

    expect(mockGh.fetchRepoFileContent).toHaveBeenCalledTimes(2);
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 206, "completed");
  });

  it("fails open and reports failing groups when dependabot.yml is unparsable", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue([
      run({ runId: 1, name: "terraform in /infra - Update #1", conclusion: "failure" }),
    ]);
    mockGh.fetchRepoFileContent.mockResolvedValue("::: not yaml :::");

    await processRepo(repo);

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
  });

  it("fails open and reports failing groups when reading dependabot.yml throws", async () => {
    mockGh.listDependabotUpdateRuns.mockResolvedValue([
      run({ runId: 1, name: "terraform in /infra - Update #1", conclusion: "failure" }),
    ]);
    mockGh.fetchRepoFileContent.mockRejectedValue(new Error("HTTP 500"));

    await processRepo(repo);

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const { reportError } = await import("../error-reporter.js");
    expect(reportError).not.toHaveBeenCalled();
  });

  describe("buildBody", () => {
    it("renders a table row and an error block per failing group", () => {
      const body = buildBody("test-org/test-repo", [
        {
          key: "npm_and_yarn in /.",
          runId: 99,
          htmlUrl: "https://github.com/test-org/test-repo/actions/runs/99",
          createdAt: "2026-07-20T21:02:13Z",
          errors: ["@types/react: dependency_file_not_resolvable"],
        },
      ]);
      expect(body).toContain("| Update job | Latest run | When |");
      expect(body).toContain("[99](https://github.com/test-org/test-repo/actions/runs/99)");
      expect(body).toContain("#### `npm_and_yarn in /.`");
      expect(body).toContain("do **not** affect CI or deploys");
    });
  });
});
