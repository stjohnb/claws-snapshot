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

import { run } from "./cache-on-self-hosted-scanner.js";
import { reportError } from "../error-reporter.js";

describe("cache-on-self-hosted-scanner", () => {
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

  it("calls ensureClone with { skipFetchIfRecent: true }", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/checkout@v4\n",
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

  it("skips when all jobs use ubuntu-latest (only flag self-hosted)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("flags actions/cache@v4 step in a self-hosted job", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: unnecessary caching on self-hosted runners",
      expect.stringContaining("actions/cache@v4"),
      ["Priority"],
    );
  });

  it("flags actions/cache/save@v4", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/cache/save@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("actions/cache/save@v4"),
      ["Priority"],
    );
  });

  it("flags actions/cache/restore@v4", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/cache/restore@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("actions/cache/restore@v4"),
      ["Priority"],
    );
  });

  it("flags actions/setup-node@v4 with cache: npm on self-hosted", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '18'\n          cache: npm\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("actions/setup-node@v4"),
      ["Priority"],
    );
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("with.cache: npm");
  });

  it("flags actions/setup-python@v5 with cache: pip on self-hosted", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.11'\n          cache: pip\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("actions/setup-python@v5"),
      ["Priority"],
    );
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("with.cache: pip");
  });

  it("does NOT flag actions/setup-node@v4 without a cache key", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '18'\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does NOT flag actions/setup-node@v4 with cache: 'false' (string)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '18'\n          cache: 'false'\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does NOT flag actions/setup-node@v4 with cache: false (boolean)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '18'\n          cache: false\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does NOT flag caches inside jobs that runs-on: ubuntu-latest", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does NOT flag when runs-on: ${{ matrix.os }} (indeterminate)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ${{ matrix.os }}\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("flags custom runner labels (ryzen)", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ryzen\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("actions/cache@v4"),
      ["Priority"],
    );
  });

  it("flags array form runs-on: [self-hosted, linux]", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("actions/cache@v4"),
      ["Priority"],
    );
  });

  it("does NOT flag macos-latest jobs", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: macos-latest\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips when matching open issue already exists", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );
    mockGh.searchIssues.mockResolvedValue([
      { number: 42, title: "Alert: unnecessary caching on self-hosted runners" },
    ]);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("reports errors per-repo without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n",
    );
    mockGh.searchIssues
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([]);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "cache-on-self-hosted-scanner:process-repo",
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

  it("creates one issue per repo aggregating all violations", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml", "deploy.yaml"]);
    mockFs.readFileSync
      .mockReturnValueOnce(
        "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: node\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '18'\n          cache: npm\n",
      )
      .mockReturnValueOnce(
        "name: Deploy\non:\n  push:\njobs:\n  deploy:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.11'\n          cache: pip\n",
      );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("actions/cache@v4");
    expect(body).toContain("actions/setup-node@v4");
    expect(body).toContain("actions/setup-python@v5");
  });
});
