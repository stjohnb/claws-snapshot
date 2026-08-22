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

import {
  runRepoScanner,
  walkRepoTree,
  RECURRENCE_TRACKING_SNIPPET_LINES,
  type ScannerSpec,
} from "./scanner-runner.js";
import { reportError } from "../error-reporter.js";

function direntDir(name: string): { name: string; isDirectory: () => boolean; isFile: () => boolean } {
  return { name, isDirectory: () => true, isFile: () => false };
}

function direntFile(name: string): { name: string; isDirectory: () => boolean; isFile: () => boolean } {
  return { name, isDirectory: () => false, isFile: () => true };
}

describe("runRepoScanner", () => {
  const spec: ScannerSpec = {
    name: "test-scanner",
    issueTitle: "Test issue",
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

describe("walkRepoTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports \"\" for the root and a/b for a nested directory", () => {
    const seen: string[] = [];
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (dir === "/repo") return [direntDir("a")];
      if (dir === "/repo/a") return [direntDir("b")];
      if (dir === "/repo/a/b") return [];
      throw new Error(`unexpected dir ${dir}`);
    });

    walkRepoTree("/repo", { maxDepth: 3, onDirectory: ({ relPath }) => seen.push(relPath) });

    expect(seen).toEqual(["", "a", "a/b"]);
  });

  it("never readdirSync's a default-skipped directory but still lists it in the parent's entries", () => {
    const readDirs: string[] = [];
    mockFs.readdirSync.mockImplementation((dir: string) => {
      readDirs.push(dir);
      if (dir === "/repo") return [direntDir("node_modules"), direntDir("src")];
      if (dir === "/repo/src") return [];
      throw new Error(`unexpected dir ${dir}`);
    });

    const rootEntries: string[] = [];
    walkRepoTree("/repo", {
      maxDepth: 3,
      onDirectory: ({ relPath, entries }) => {
        if (relPath === "") rootEntries.push(...entries.map((e) => e.name));
      },
    });

    expect(readDirs).not.toContain("/repo/node_modules");
    expect(rootEntries).toContain("node_modules");
  });

  it("skips extraSkipDirs entries in addition to the defaults", () => {
    const readDirs: string[] = [];
    mockFs.readdirSync.mockImplementation((dir: string) => {
      readDirs.push(dir);
      if (dir === "/repo") return [direntDir("migrations"), direntDir("node_modules")];
      throw new Error(`unexpected dir ${dir}`);
    });

    walkRepoTree("/repo", { maxDepth: 3, extraSkipDirs: ["migrations"], onDirectory: () => {} });

    expect(readDirs).toEqual(["/repo"]);
  });

  it("reads directories at depths 0-3 and not depth 4", () => {
    const depths: number[] = [];
    mockFs.readdirSync.mockImplementation((dir: string) => {
      const depth = dir === "/repo" ? 0 : dir.split("/").length - 2;
      if (depth < 4) return [direntDir("d")];
      throw new Error(`unexpected dir ${dir}`);
    });

    walkRepoTree("/repo", { maxDepth: 3, onDirectory: ({ depth }) => depths.push(depth) });

    expect(depths).toEqual([0, 1, 2, 3]);
  });

  it("skips a directory whose readdirSync throws without aborting the rest of the walk", () => {
    const seen: string[] = [];
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (dir === "/repo") return [direntDir("bad"), direntDir("good")];
      if (dir === "/repo/bad") throw new Error("EACCES");
      if (dir === "/repo/good") return [direntFile("file.txt")];
      throw new Error(`unexpected dir ${dir}`);
    });

    walkRepoTree("/repo", { maxDepth: 3, onDirectory: ({ relPath }) => seen.push(relPath) });

    expect(seen).toEqual(["", "good"]);
  });
});

describe("RECURRENCE_TRACKING_SNIPPET_LINES", () => {
  const text = RECURRENCE_TRACKING_SNIPPET_LINES.join("\n");

  it("does not use the eventually-consistent search index", () => {
    expect(text).not.toContain("--search");
  });

  it("exports TITLE so $ENV.TITLE resolves in gh's --jq", () => {
    expect(text).toContain("export TITLE=");
    expect(text).toContain("$ENV.TITLE");
    expect(text).toContain("--json number,title");
  });

  it("keeps the 10-space YAML run-block indentation on every line", () => {
    for (const l of RECURRENCE_TRACKING_SNIPPET_LINES) {
      expect(l.startsWith("          ")).toBe(true);
    }
  });

  it("preserves the markers issue-comment-spam-scanner keys off of", () => {
    for (const m of ["**Occurrences:**", "**First seen:**", "gh issue edit"]) {
      expect(text).toContain(m);
    }
  });
});
