import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

const WORK_DIR = "/home/testuser/.claws";
const WORKTREE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000; // fixed timestamp

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  WORKTREE_STALE_MS: 7 * 24 * 60 * 60 * 1000,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

const { mockDb, mockGh, mockFs, mockExecFile } = vi.hoisted(() => ({
  mockDb: {
    getRunningTasks: vi.fn(),
    getAllPersistedSessions: vi.fn(),
  },
  mockGh: {
    listRepos: vi.fn(),
  },
  mockFs: {
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
  },
  mockExecFile: vi.fn(),
}));

vi.mock("../db.js", () => mockDb);
vi.mock("../github.js", () => mockGh);
vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
    // The promisify wrapper calls execFile(cmd, args, callback)
    // We capture this via the mock below
    mockExecFile(_cmd, _args, cb);
  },
}));

vi.mock("node:util", () => ({
  promisify: (fn: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: unknown, result: unknown) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
  },
}));

import * as log from "../log.js";
import { run } from "./worktree-cleaner.js";

const repo = mockRepo({ owner: "myorg", name: "myrepo", fullName: "myorg/myrepo" });
const repoDir = `${WORK_DIR}/repos/myorg/myrepo`;
const wtRootDir = `${WORK_DIR}/worktrees/myorg/myrepo`;

function staleTime(): number {
  // mtime older than threshold
  return NOW - WORKTREE_STALE_MS - 1000;
}

function freshTime(): number {
  return NOW - 60_000;
}

function makeWorktreeListOutput(paths: string[]): string {
  return paths
    .map(p => `worktree ${p}\nHEAD abc\nbranch refs/heads/feature\n`)
    .join("\n") + "\n";
}

function setupBasicMocks() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  mockDb.getRunningTasks.mockReturnValue([]);
  mockDb.getAllPersistedSessions.mockReturnValue([]);
  mockGh.listRepos.mockResolvedValue([repo]);

  // existsSync: .git dir in repoDir exists, wtRootDir exists
  mockFs.existsSync.mockImplementation((p: string) => {
    if (p === `${repoDir}/.git`) return true;
    if (p === wtRootDir) return true;
    return false;
  });

  // readdirSync returns empty by default (no orphan dirs)
  mockFs.readdirSync.mockReturnValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  setupBasicMocks();
});

describe("worktree-cleaner", () => {
  it("no-ops when there are no repos", async () => {
    mockGh.listRepos.mockResolvedValue([]);

    await run();

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("no-ops when worktree list is empty (only bare clone)", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: null, r: { stdout: string }) => void) => {
      cb(null, { stdout: makeWorktreeListOutput([repoDir]) });
    });
    mockFs.statSync.mockReturnValue({ mtimeMs: staleTime() });

    await run();

    expect(mockFs.rmSync).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("does not remove a worktree younger than the stale threshold", async () => {
    const wtPath = `${wtRootDir}/issue-123-abc`;
    mockExecFile.mockImplementation((_cmd: string, args: string[], cb: (err: null, r: { stdout: string }) => void) => {
      if (args.includes("list")) {
        cb(null, { stdout: makeWorktreeListOutput([repoDir, wtPath]) });
      } else {
        cb(null, { stdout: "" });
      }
    });
    mockFs.statSync.mockReturnValue({ mtimeMs: freshTime() });

    await run();

    expect(mockFs.rmSync).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("removes a stale worktree not in use via git worktree remove", async () => {
    const wtPath = `${wtRootDir}/issue-123-abc`;
    mockExecFile.mockImplementation((_cmd: string, args: string[], cb: (err: null | Error, r?: { stdout: string }) => void) => {
      if (args.includes("list")) {
        cb(null, { stdout: makeWorktreeListOutput([repoDir, wtPath]) });
      } else if (args.includes("-sb")) {
        cb(null, { stdout: `1048576\t${wtPath}\n` });
      } else if (args.includes("remove")) {
        cb(null, { stdout: "" });
      } else {
        cb(null, { stdout: "" });
      }
    });
    mockFs.statSync.mockReturnValue({ mtimeMs: staleTime() });

    await run();

    const removeCalls = (mockExecFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: string[][]) => c[1]?.includes("remove"),
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]![1]).toContain(wtPath);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Removed 1 worktree"));
  });

  it("preserves a worktree that is in use by a running task", async () => {
    const wtPath = `${wtRootDir}/issue-456-def`;
    mockDb.getRunningTasks.mockReturnValue([
      { worktree_path: wtPath, status: "running" },
    ]);
    mockExecFile.mockImplementation((_cmd: string, args: string[], cb: (err: null, r: { stdout: string }) => void) => {
      if (args.includes("list")) {
        cb(null, { stdout: makeWorktreeListOutput([repoDir, wtPath]) });
      } else {
        cb(null, { stdout: "" });
      }
    });
    mockFs.statSync.mockReturnValue({ mtimeMs: staleTime() });

    await run();

    const removeCalls = (mockExecFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: string[][]) => c[1]?.includes("remove"),
    );
    expect(removeCalls).toHaveLength(0);
  });

  it("preserves a worktree that is in use by a persisted session", async () => {
    const wtPath = `${wtRootDir}/issue-789-ghi`;
    mockDb.getAllPersistedSessions.mockReturnValue([
      { worktree_path: wtPath, id: "s1", tmux_name: "s1", mode: "issue", repo: "myorg/myrepo", cwd: wtPath, created_at: NOW },
    ]);
    mockExecFile.mockImplementation((_cmd: string, args: string[], cb: (err: null, r: { stdout: string }) => void) => {
      if (args.includes("list")) {
        cb(null, { stdout: makeWorktreeListOutput([repoDir, wtPath]) });
      } else {
        cb(null, { stdout: "" });
      }
    });
    mockFs.statSync.mockReturnValue({ mtimeMs: staleTime() });

    await run();

    const removeCalls = (mockExecFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: string[][]) => c[1]?.includes("remove"),
    );
    expect(removeCalls).toHaveLength(0);
  });

  it("falls back to rm -rf and queues prune when git worktree remove fails", async () => {
    const wtPath = `${wtRootDir}/issue-321-jkl`;
    mockExecFile.mockImplementation((_cmd: string, args: string[], cb: (err: null | Error, r?: { stdout: string }) => void) => {
      if (args.includes("list")) {
        cb(null, { stdout: makeWorktreeListOutput([repoDir, wtPath]) });
      } else if (args.includes("-sb")) {
        cb(null, { stdout: `512000\t${wtPath}\n` });
      } else if (args.includes("remove")) {
        cb(new Error("locked"));
      } else if (args.includes("prune")) {
        cb(null, { stdout: "" });
      } else {
        cb(null, { stdout: "" });
      }
    });
    mockFs.statSync.mockReturnValue({ mtimeMs: staleTime() });

    await run();

    expect(mockFs.rmSync).toHaveBeenCalledWith(wtPath, { recursive: true, force: true });
    const pruneCalls = (mockExecFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: string[][]) => c[1]?.includes("prune"),
    );
    expect(pruneCalls).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Removed 1 worktree"));
  });

  it("removes an orphaned leaf directory not in the porcelain list", async () => {
    const orphanPath = `${wtRootDir}/orphan-branch/claws/issue-000-zzz`;
    // git worktree list returns only the bare clone
    mockExecFile.mockImplementation((_cmd: string, args: string[], cb: (err: null | Error, r?: { stdout: string }) => void) => {
      if (args.includes("list")) {
        cb(null, { stdout: makeWorktreeListOutput([repoDir]) });
      } else if (args.includes("-sb")) {
        cb(null, { stdout: `204800\t${orphanPath}\n` });
      } else if (args.includes("prune")) {
        cb(null, { stdout: "" });
      } else {
        cb(null, { stdout: "" });
      }
    });

    // readdirSync walks: wtRootDir → "orphan-branch" dir → "claws" dir → leaf with .git file
    mockFs.readdirSync.mockImplementation((p: string) => {
      if (p === wtRootDir) {
        return [{ name: "orphan-branch", isDirectory: () => true }];
      }
      if (p === `${wtRootDir}/orphan-branch`) {
        return [{ name: "claws", isDirectory: () => true }];
      }
      if (p === `${wtRootDir}/orphan-branch/claws`) {
        return [{ name: "issue-000-zzz", isDirectory: () => true }];
      }
      return [];
    });

    mockFs.statSync.mockImplementation((p: string) => {
      if (p === `${orphanPath}/.git`) {
        return { isFile: () => true, mtimeMs: staleTime() };
      }
      return { isFile: () => false, mtimeMs: staleTime() };
    });

    await run();

    expect(mockFs.rmSync).toHaveBeenCalledWith(orphanPath, { recursive: true, force: true });
  });

  it("does not delete anything under the bare clone dir", async () => {
    // Bare clone path returned as a worktree — should be skipped
    mockExecFile.mockImplementation((_cmd: string, args: string[], cb: (err: null, r: { stdout: string }) => void) => {
      if (args.includes("list")) {
        cb(null, { stdout: makeWorktreeListOutput([repoDir]) });
      } else {
        cb(null, { stdout: "" });
      }
    });
    mockFs.statSync.mockReturnValue({ mtimeMs: staleTime() });

    await run();

    const removeCalls = (mockExecFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: string[][]) => c[1]?.includes("remove"),
    );
    expect(removeCalls).toHaveLength(0);
    expect(mockFs.rmSync).not.toHaveBeenCalled();
  });
});
