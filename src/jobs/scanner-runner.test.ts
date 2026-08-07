import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  LABELS: { priority: "Priority" },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh, mockClaude } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
  },
  mockGh: {
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    repoDir: vi.fn((repo: { owner: string; name: string }) => `/home/testuser/.claws/repos/${repo.owner}/${repo.name}`),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);

import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";
import { reportError } from "../error-reporter.js";

describe("runRepoScanner", () => {
  const spec: ScannerSpec = {
    name: "test-scanner",
    issueTitle: "Test issue",
    searchQuery: "Test issue",
    label: "Priority",
    scan: vi.fn(() => ({ body: "b", summary: "s" })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue("/home/testuser/.claws/repos/test-org/repo");
  });

  it("processes every repo", async () => {
    const repos = Array.from({ length: 10 }, (_, i) =>
      mockRepo({ owner: "test-org", name: `repo-${i}`, fullName: `test-org/repo-${i}` }),
    );

    await runRepoScanner(spec, repos);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(10);
    const processed = mockGh.createIssue.mock.calls.map((c) => c[0]).sort();
    const expected = repos.map((r) => r.fullName).sort();
    expect(processed).toEqual(expected);
  });

  it("bounds concurrency at 4", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockClaude.ensureClone.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return "/home/testuser/.claws/repos/test-org/repo";
    });

    const repos = Array.from({ length: 10 }, (_, i) =>
      mockRepo({ owner: "test-org", name: `repo-${i}`, fullName: `test-org/repo-${i}` }),
    );

    await runRepoScanner(spec, repos);

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("isolates errors per repo", async () => {
    mockClaude.ensureClone.mockImplementation(async (repo: { fullName: string }) => {
      if (repo.fullName === "test-org/repo-3") {
        throw new Error("boom");
      }
      return "/home/testuser/.claws/repos/test-org/repo";
    });

    const repos = Array.from({ length: 10 }, (_, i) =>
      mockRepo({ owner: "test-org", name: `repo-${i}`, fullName: `test-org/repo-${i}` }),
    );

    await expect(runRepoScanner(spec, repos)).resolves.toBeUndefined();

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "test-scanner:process-repo",
      "test-org/repo-3",
      expect.anything(),
    );
    expect(mockGh.createIssue).toHaveBeenCalledTimes(9);
  });

  it("skips repos with no local clone", async () => {
    const repos = [
      mockRepo({ owner: "test-org", name: "repo-a", fullName: "test-org/repo-a" }),
      mockRepo({ owner: "test-org", name: "repo-b", fullName: "test-org/repo-b" }),
    ];
    mockFs.existsSync.mockImplementation((p: string) => !(p as string).includes("repo-a"));

    await runRepoScanner(spec, repos);

    expect(mockClaude.ensureClone).toHaveBeenCalledTimes(1);
    expect(mockClaude.ensureClone).toHaveBeenCalledWith(repos[1], expect.anything());
  });
});
