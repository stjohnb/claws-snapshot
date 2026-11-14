import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelfRepoGitUrl } = vi.hoisted(() => ({
  mockSelfRepoGitUrl: vi.fn(() => "https://github.com/St-John-Software/claws.git"),
}));

vi.mock("../config.js", () => ({
  SELF_REPO: "St-John-Software/claws",
  WORK_DIR: "/home/testuser/.claws",
  selfRepoGitUrl: mockSelfRepoGitUrl,
}));

vi.mock("../log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockFs, mockOs, mockClaude, mockOccurrenceTracking, mockDb } = vi.hoisted(() => ({
  mockDb: {
    listUnpushedSessionMemoryCaptures: vi.fn(),
    markSessionMemoryCapturePushed: vi.fn(),
  },
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
vi.mock("../db.js", () => mockDb);

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
    mockDb.listUnpushedSessionMemoryCaptures.mockResolvedValue([]);
    mockDb.markSessionMemoryCapturePushed.mockResolvedValue(undefined);
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

  function setupExistingCheckout(origin: string) {
    setupSingleProject();
    mockFs.existsSync.mockReturnValue(true);
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args[0] === "remote" && args[1] === "get-url") return Promise.resolve(origin);
      if (args[0] === "ls-remote") return Promise.resolve("");
      if (args[0] === "status") return Promise.resolve("M memories/proj-a/notes.md");
      return Promise.resolve("");
    });
  }

  it("first run adds the self-repo remote on whichever forge hosts it", async () => {
    setupSingleProject();
    mockSelfRepoGitUrl.mockReturnValueOnce("https://git.home.bstjohn.net/St-John-Software/claws.git");

    await run();

    const calls = mockClaude.git.mock.calls.map((c) => c[0] as string[]);
    expect(calls).toContainEqual(["remote", "add", "origin", "https://git.home.bstjohn.net/St-John-Software/claws.git"]);
  });

  it("re-points an existing checkout's origin when the self-repo moved forge", async () => {
    setupExistingCheckout("https://github.com/St-John-Software/claws.git");
    mockSelfRepoGitUrl.mockReturnValueOnce("https://git.home.bstjohn.net/St-John-Software/claws.git");

    await run();

    const calls = mockClaude.git.mock.calls.map((c) => c[0] as string[]);
    expect(calls).toContainEqual(["remote", "set-url", "origin", "https://git.home.bstjohn.net/St-John-Software/claws.git"]);
    expect(calls.findIndex((a) => a[1] === "set-url")).toBeLessThan(calls.findIndex((a) => a[0] === "ls-remote"));
  });

  it("leaves an existing checkout's origin alone when it already matches", async () => {
    setupExistingCheckout("https://github.com/St-John-Software/claws.git");

    await run();

    const calls = mockClaude.git.mock.calls.map((c) => c[0] as string[]);
    expect(calls.some((a) => a[0] === "remote" && a[1] === "set-url")).toBe(false);
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

describe("claude-memory-backup session captures", () => {
  const CHECKOUT_MEMORIES = "/home/testuser/.claws/claude-memory-backup/memories";
  const SLUG = "-home-claws-work-St-John-Software-claws";

  /** The branch checkout's memories/ holds `branchDirs`; the host has no memories of its own unless `hostProject` is set. */
  function setup(opts: { branchDirs?: string[]; hostProject?: string } = {}) {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".git")) return false;
      if (p === PROJECTS_DIR) return !!opts.hostProject;
      return true;
    });
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (dir === PROJECTS_DIR) return opts.hostProject ? [dirent(opts.hostProject, "dir")] : [];
      if (opts.hostProject && dir === `${PROJECTS_DIR}/${opts.hostProject}/memory`) return [dirent("MEMORY.md", "file")];
      if (dir === CHECKOUT_MEMORIES) return opts.branchDirs ?? [];
      return [];
    });
    mockFs.lstatSync.mockReturnValue({ isFile: () => true, size: 10 });
    mockFs.readFileSync.mockReturnValue("host");
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args[0] === "ls-remote") return Promise.resolve("abc\trefs/heads/claude-memories");
      if (args[0] === "status") return Promise.resolve("M memories/x");
      return Promise.resolve("");
    });
  }

  const written = () => mockFs.writeFileSync.mock.calls.map((c) => [c[0] as string, c[1] as string]);
  const removed = () => mockFs.rmSync.mock.calls.map((c) => c[0] as string);

  beforeEach(() => {
    vi.clearAllMocks();
    mockOccurrenceTracking.closeAlertIssueIfResolved.mockResolvedValue(null);
    mockOccurrenceTracking.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
    mockDb.markSessionMemoryCapturePushed.mockResolvedValue(undefined);
  });

  it("pushes a capture even when the host has no memories, and marks it pushed", async () => {
    setup();
    mockDb.listUnpushedSessionMemoryCaptures.mockResolvedValue([
      { session_id: "aa11", captured_at: 5, files: { [SLUG]: { "MEMORY.md": "from aa11" } } },
    ]);

    await run();

    expect(written()).toContainEqual([`${CHECKOUT_MEMORIES}/session-aa11-${SLUG}/MEMORY.md`, "from aa11"]);
    const calls = mockClaude.git.mock.calls.map((c) => c[0] as string[]);
    expect(calls.some((a) => a[0] === "push")).toBe(true);
    expect(calls.find((a) => a[0] === "commit")?.[2]).toContain("1 session capture(s)");
    expect(mockDb.markSessionMemoryCapturePushed).toHaveBeenCalledWith("aa11", 5, expect.any(Number));
  });

  it("keeps two sessions' same-named MEMORY.md apart", async () => {
    setup();
    mockDb.listUnpushedSessionMemoryCaptures.mockResolvedValue([
      { session_id: "aa11", captured_at: 5, files: { [SLUG]: { "MEMORY.md": "one" } } },
      { session_id: "bb22", captured_at: 6, files: { [SLUG]: { "MEMORY.md": "two" } } },
    ]);

    await run();

    expect(written()).toContainEqual([`${CHECKOUT_MEMORIES}/session-aa11-${SLUG}/MEMORY.md`, "one"]);
    expect(written()).toContainEqual([`${CHECKOUT_MEMORIES}/session-bb22-${SLUG}/MEMORY.md`, "two"]);
  });

  it("the host pass leaves session directories alone and skips a local project named session-*", async () => {
    setup({ hostProject: "session-zz99--x", branchDirs: [`session-aa11-${SLUG}`, SLUG] });
    mockDb.listUnpushedSessionMemoryCaptures.mockResolvedValue([]);

    await run();

    expect(removed().some((p) => p.includes("session-"))).toBe(false);
    expect(written()).toEqual([]);
    expect(mockClaude.git).not.toHaveBeenCalled();
  });

  it("a re-capture replaces only that session's directories, dropping its deleted files", async () => {
    setup({ hostProject: SLUG, branchDirs: [SLUG, `session-aa11-${SLUG}`, `session-aa11--home-claws`, `session-bb22-${SLUG}`] });
    mockDb.listUnpushedSessionMemoryCaptures.mockResolvedValue([
      { session_id: "aa11", captured_at: 7, files: { [SLUG]: { "kept.md": "k" } } },
    ]);

    await run();

    expect(removed()).toEqual(expect.arrayContaining([
      `${CHECKOUT_MEMORIES}/${SLUG}`,
      `${CHECKOUT_MEMORIES}/session-aa11-${SLUG}`,
      `${CHECKOUT_MEMORIES}/session-aa11--home-claws`,
    ]));
    expect(removed()).not.toContain(`${CHECKOUT_MEMORIES}/session-bb22-${SLUG}`);
    expect(written()).toContainEqual([`${CHECKOUT_MEMORIES}/session-aa11-${SLUG}/kept.md`, "k"]);
    expect(written()).toContainEqual([`${CHECKOUT_MEMORIES}/${SLUG}/MEMORY.md`, "host"]);
  });

  it("an empty capture still clears that session's directories", async () => {
    setup({ branchDirs: [`session-aa11-${SLUG}`] });
    mockDb.listUnpushedSessionMemoryCaptures.mockResolvedValue([{ session_id: "aa11", captured_at: 8, files: {} }]);

    await run();

    expect(removed()).toContain(`${CHECKOUT_MEMORIES}/session-aa11-${SLUG}`);
    expect(mockDb.markSessionMemoryCapturePushed).toHaveBeenCalledWith("aa11", 8, expect.any(Number));
  });

  it("skips slugs and filenames that could escape the session's directory", async () => {
    setup();
    mockDb.listUnpushedSessionMemoryCaptures.mockResolvedValue([
      { session_id: "aa11", captured_at: 5, files: { "..": { "x.md": "a" }, [SLUG]: { "../x.md": "b", "ok.md": "c" } } },
    ]);

    await run();

    expect(written()).toEqual([[`${CHECKOUT_MEMORIES}/session-aa11-${SLUG}/ok.md`, "c"]]);
  });

  it("a push failure raises the existing alert and leaves the captures unpushed", async () => {
    setup();
    mockDb.listUnpushedSessionMemoryCaptures.mockResolvedValue([
      { session_id: "aa11", captured_at: 5, files: { [SLUG]: { "MEMORY.md": "x" } } },
    ]);
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args[0] === "status") return Promise.resolve("M memories/x");
      if (args[0] === "push") return Promise.reject(new Error("push failed"));
      return Promise.resolve("");
    });

    await run();

    expect(mockOccurrenceTracking.ensureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: "[claude-memory-backup] Memory backup push is failing" }),
    );
    expect(mockDb.markSessionMemoryCapturePushed).not.toHaveBeenCalled();
  });
});
