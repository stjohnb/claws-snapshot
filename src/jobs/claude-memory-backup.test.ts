import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  SELF_REPO: "St-John-Software/claws",
  WORK_DIR: "/home/testuser/.claws",
}));

vi.mock("../log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockFs, mockOs, mockClaude, mockOccurrenceTracking } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    lstatSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  },
  mockOs: {
    homedir: vi.fn(() => "/home/testuser"),
  },
  mockClaude: {
    git: vi.fn(),
  },
  mockOccurrenceTracking: {
    ensureAlertIssue: vi.fn(),
    closeAlertIssueIfResolved: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("node:os", () => ({ default: mockOs }));
vi.mock("../claude.js", () => mockClaude);
vi.mock("../occurrence-tracking.js", () => mockOccurrenceTracking);

import { run } from "./claude-memory-backup.js";

function dirent(name: string, kind: "dir" | "file") {
  return { name, isDirectory: () => kind === "dir", isFile: () => kind === "file" };
}

const PROJECTS_DIR = "/home/testuser/.claude/projects";
const MEM_DIR = `${PROJECTS_DIR}/proj-a/memory`;

describe("claude-memory-backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.git.mockResolvedValue("");
    mockOccurrenceTracking.closeAlertIssueIfResolved.mockResolvedValue(null);
    mockOccurrenceTracking.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
  });

  function setupSingleProject(opts: { fileNames?: string[]; content?: string } = {}) {
    const fileNames = opts.fileNames ?? ["notes.md"];
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === PROJECTS_DIR) return true;
      if (p === MEM_DIR) return true;
      if (p.endsWith(".git")) return false;
      return true;
    });
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (dir === PROJECTS_DIR) return [dirent("proj-a", "dir")];
      if (dir === MEM_DIR) return fileNames.map((n) => dirent(n, "file"));
      return [];
    });
    mockFs.lstatSync.mockReturnValue({ isFile: () => true, size: 100 });
    mockFs.readFileSync.mockReturnValue(opts.content ?? "hello");
  }

  it("does nothing when ~/.claude/projects is missing", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run();

    expect(mockClaude.git).not.toHaveBeenCalled();
  });

  it("does nothing when zero readable memory files are found (wipe guard)", async () => {
    mockFs.existsSync.mockImplementation((p: string) => p === PROJECTS_DIR);
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (dir === PROJECTS_DIR) return [dirent("proj-a", "dir")];
      return [];
    });

    await run();

    expect(mockClaude.git).not.toHaveBeenCalled();
  });

  it("first run: ls-remote empty skips fetch, inits repo, and pushes to HEAD:refs/heads/claude-memories", async () => {
    setupSingleProject();
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args[0] === "ls-remote") return Promise.resolve("");
      if (args[0] === "status") return Promise.resolve("M memories/proj-a/notes.md");
      return Promise.resolve("");
    });

    await run();

    const calls = mockClaude.git.mock.calls.map((c) => c[0] as string[]);
    expect(calls.some((a) => a[0] === "init")).toBe(true);
    expect(calls.some((a) => a[0] === "remote" && a[1] === "add")).toBe(true);
    expect(calls.some((a) => a[0] === "fetch")).toBe(false);
    const push = calls.find((a) => a[0] === "push");
    expect(push).toEqual(["push", "origin", "HEAD:refs/heads/claude-memories"]);
  });

  it("existing branch: ls-remote non-empty fetches and hard-resets before writing files", async () => {
    setupSingleProject();
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === PROJECTS_DIR) return true;
      if (p === MEM_DIR) return true;
      if (p.endsWith(".git")) return true;
      return true;
    });

    const order: string[] = [];
    mockClaude.git.mockImplementation((args: string[]) => {
      order.push(args[0]!);
      if (args[0] === "ls-remote") return Promise.resolve("abc123\trefs/heads/claude-memories");
      if (args[0] === "status") return Promise.resolve("M memories/proj-a/notes.md");
      return Promise.resolve("");
    });
    mockFs.writeFileSync.mockImplementation(() => {
      order.push("write");
    });

    await run();

    const fetchIdx = order.indexOf("fetch");
    const resetIdx = order.indexOf("reset");
    const writeIdx = order.indexOf("write");
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(fetchIdx);
    expect(writeIdx).toBeGreaterThan(resetIdx);
  });

  it("no staged changes: does not commit or push, closes alert issue", async () => {
    setupSingleProject();
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args[0] === "ls-remote") return Promise.resolve("");
      if (args[0] === "status") return Promise.resolve("");
      return Promise.resolve("");
    });

    await run();

    const calls = mockClaude.git.mock.calls.map((c) => c[0] as string[]);
    expect(calls.some((a) => a[0] === "commit")).toBe(false);
    expect(calls.some((a) => a[0] === "push")).toBe(false);
    expect(mockOccurrenceTracking.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "St-John-Software/claws" }),
    );
  });

  it("skips a project whose memory dir throws on read, without touching its committed directory", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === PROJECTS_DIR) return true;
      if (p === `${PROJECTS_DIR}/proj-a/memory`) return true;
      if (p === `${PROJECTS_DIR}/proj-b/memory`) return true;
      if (p.endsWith(".git")) return false;
      return true;
    });
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (dir === PROJECTS_DIR) return [dirent("proj-a", "dir"), dirent("proj-b", "dir")];
      if (dir === `${PROJECTS_DIR}/proj-a/memory`) throw new Error("EACCES");
      if (dir === `${PROJECTS_DIR}/proj-b/memory`) return [dirent("notes.md", "file")];
      return [];
    });
    mockFs.lstatSync.mockReturnValue({ isFile: () => true, size: 100 });
    mockFs.readFileSync.mockReturnValue("hello");
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args[0] === "ls-remote") return Promise.resolve("");
      if (args[0] === "status") return Promise.resolve("M memories/proj-b/notes.md");
      return Promise.resolve("");
    });

    await run();

    const rmPaths = mockFs.rmSync.mock.calls.map((c) => c[0] as string);
    expect(rmPaths).not.toContain(`/home/testuser/.claws/claude-memory-backup/memories/proj-a`);
    expect(rmPaths).toContain(`/home/testuser/.claws/claude-memory-backup/memories/proj-b`);
  });

  it("skips non-.md files, symlinks, and files over the size limit", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === PROJECTS_DIR) return true;
      if (p === MEM_DIR) return true;
      if (p.endsWith(".git")) return false;
      return true;
    });
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (dir === PROJECTS_DIR) return [dirent("proj-a", "dir")];
      if (dir === MEM_DIR) return [dirent("notes.txt", "file"), dirent("link.md", "file"), dirent("big.md", "file")];
      return [];
    });
    mockFs.lstatSync.mockImplementation((p: string) => {
      if (p.endsWith("link.md")) return { isFile: () => false, size: 10 };
      if (p.endsWith("big.md")) return { isFile: () => true, size: 600 * 1024 };
      return { isFile: () => true, size: 10 };
    });
    mockFs.readFileSync.mockReturnValue("hello");

    await run();

    expect(mockClaude.git).not.toHaveBeenCalled();
  });

  it("push failure raises an alert issue on SELF_REPO and does not throw", async () => {
    setupSingleProject();
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args[0] === "ls-remote") return Promise.resolve("");
      if (args[0] === "status") return Promise.resolve("M memories/proj-a/notes.md");
      if (args[0] === "push") return Promise.reject(new Error("push failed: secret scanning"));
      return Promise.resolve("");
    });

    await expect(run()).resolves.toBeUndefined();

    expect(mockOccurrenceTracking.ensureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "St-John-Software/claws" }),
    );
  });
});
