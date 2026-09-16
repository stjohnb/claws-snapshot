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
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
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

import { run } from "./runner-os-scanner.js";
import { reportError } from "../error-reporter.js";

describe("runner-os-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue("/home/testuser/.claws/repos/test-org/test-repo");
  });

  it("skips repos without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockGh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("calls ensureClone with { skipFetchIfRecent: true }", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps: []\n",
    );

    await run([repo]);

    expect(mockClaude.ensureClone).toHaveBeenCalledWith(repo, { skipFetchIfRecent: true });
  });

  it("skips repos with no .github/workflows directory", async () => {
    mockFs.existsSync
      .mockReturnValueOnce(true) // repoDir
      .mockReturnValueOnce(false); // workflowsDir

    await run([repo]);

    expect(mockFs.readdirSync).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips when all jobs use [self-hosted, linux]", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips when all jobs use [self-hosted, macos, arm64]", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, macos, arm64]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips for runs-on: ubuntu-latest (not this scanner's concern)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips for runs-on: macos-latest (GitHub-hosted macOS)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: macos-latest\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips for runs-on: ${{ matrix.os }} (indeterminate)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ${{ matrix.os }}\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips for runs-on: [self-hosted, ${{ matrix.arch }}] (indeterminate)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, '${{ matrix.arch }}']\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips for custom labels alone: runs-on: ryzen", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ryzen\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips for custom labels: runs-on: [ryzen, linux]", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [ryzen, linux]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("flags runs-on: self-hosted (string form)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: self-hosted runner jobs missing OS label",
      expect.stringContaining("self-hosted"),
      ["Priority"],
    );
  });

  it("flags runs-on: [self-hosted] (array form, no OS)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: self-hosted runner jobs missing OS label",
      expect.stringContaining("self-hosted"),
      ["Priority"],
    );
  });

  it("flags runs-on: [self-hosted, x64] (has self-hosted, no OS)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, x64]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: self-hosted runner jobs missing OS label",
      expect.stringContaining("x64"),
      ["Priority"],
    );
  });

  it("accepts case-insensitive OS: [self-hosted, Linux] not flagged", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, Linux]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("accepts case-insensitive OS: [self-hosted, MacOS] not flagged", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, MacOS]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips issue creation when a matching open issue already exists", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps: []\n",
    );
    mockGh.findIssueByExactTitle.mockResolvedValue(
      { number: 42, title: "Alert: self-hosted runner jobs missing OS label" },
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("multi-job file: flags only offending jobs and lists each by name", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps: []\n  test:\n    runs-on: self-hosted\n    steps: []\n  deploy:\n    runs-on: [self-hosted, x64]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).not.toContain("`build`");
    expect(body).toContain("`test`");
    expect(body).toContain("`deploy`");
  });

  it("reports errors via reportError without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps: []\n",
    );
    mockGh.findIssueByExactTitle
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce(null);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "runner-os-scanner:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo2.fullName,
      expect.any(String),
      expect.any(String),
      ["Priority"],
    );
  });

  it("ignores non-yml files", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml", "README.md", "script.sh"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("scans .yaml files in addition to .yml files", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml", "deploy.yaml", "README.md"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps: []\n",
    );

    await run([repo]);

    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });
});
