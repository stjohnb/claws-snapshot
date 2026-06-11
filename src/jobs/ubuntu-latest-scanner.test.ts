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
    searchIssues: vi.fn(),
    createIssue: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);

import { run } from "./ubuntu-latest-scanner.js";
import { reportError } from "../error-reporter.js";

describe("ubuntu-latest-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);
    mockGh.searchIssues.mockResolvedValue([]);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue("/home/testuser/.claws/repos/test-org/test-repo");
  });

  it("skips repos without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockGh.searchIssues).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("calls ensureClone to refresh working directory before scanning", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: self-hosted\n",
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

  it("skips repos where all workflows use self-hosted", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/checkout@v4\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips repos where workflows use self-hosted array form", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: [self-hosted, linux]\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("creates an issue when ubuntu-latest is found", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: workflows using GitHub-hosted runners",
      expect.stringContaining("ubuntu-latest"),
      ["Priority"],
    );
  });

  it("skips issue creation when a matching open issue already exists", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: ubuntu-latest\n",
    );
    mockGh.searchIssues.mockResolvedValue([
      { number: 42, title: "Alert: workflows using GitHub-hosted runners" },
    ]);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("issue body lists all offending files and their runs-on values", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml", "deploy.yaml"]);
    mockFs.readFileSync
      .mockReturnValueOnce(
        "jobs:\n  build:\n    runs-on: ubuntu-latest\n",
      )
      .mockReturnValueOnce(
        "jobs:\n  deploy:\n    runs-on: windows-latest\n",
      );

    await run([repo]);

    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("ci.yml");
    expect(body).toContain("ubuntu-latest");
    expect(body).toContain("deploy.yaml");
    expect(body).toContain("windows-latest");
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: ubuntu-latest\n",
    );
    mockGh.searchIssues
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([]);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "ubuntu-latest-scanner:process-repo",
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

  it("skips commented-out runs-on lines", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    # runs-on: ubuntu-latest\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not create an issue for expression syntax (indeterminate at static analysis time)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: ${{ matrix.os }}\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not create an issue for macos-latest runner", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: macos-latest\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not create an issue for versioned macOS runner (macos-14)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: macos-14\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not create an issue for macOS runner in array form ([macos-latest, xlarge])", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: [macos-latest, xlarge]\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("creates an issue only for ubuntu-latest when mixed with macos-latest in the same file", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  macos-build:\n    runs-on: macos-latest\n  linux-build:\n    runs-on: ubuntu-latest\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("ubuntu-latest");
    expect(body).not.toContain("macos-latest");
  });

  it("does not create an issue for custom runner name (ryzen)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: ryzen\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not create an issue for custom runner in array form ([ryzen, linux])", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: [ryzen, linux]\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("creates an issue for ubuntu-latest in array form ([ubuntu-latest])", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: [ubuntu-latest]\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("ubuntu-latest"),
      ["Priority"],
    );
  });

  it("creates an issue for windows runner in array form ([windows-2022, self-hosted])", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: [windows-2022, self-hosted]\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("windows-2022"),
      ["Priority"],
    );
  });

  it("does not create an issue for expression syntax in array form (indeterminate at static analysis time)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "jobs:\n  build:\n    runs-on: [${{ matrix.os }}]\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("ignores non-yml files in workflows directory", async () => {
    mockFs.readdirSync.mockReturnValue(["readme.md", "config.json"]);

    await run([repo]);

    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });
});
