import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSpawn, mockPty, mockDb, mockGithub, mockClaude, mockLog, mockShutdown, mockSessionEnvFile, mockSessionUploads, mockCrypto } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockPty: { spawn: vi.fn() },
  mockDb: {
    getAllPersistedSessions: vi.fn(),
    deletePersistedSession: vi.fn(),
    insertSession: vi.fn(),
    updateSessionSummary: vi.fn(),
    setManualSessionSummary: vi.fn(() => true),
    getEndedSessions: vi.fn(() => []),
    getPersistedSession: vi.fn(),
    markSessionEnded: vi.fn(),
    clearSessionEnded: vi.fn(),
    pruneEndedSessions: vi.fn(),
  },
  mockGithub: { listRepos: vi.fn() },
  mockClaude: {
    removeWorktree: vi.fn(),
    ensureClone: vi.fn(),
    createWorktree: vi.fn(),
    runClaude: vi.fn(),
    writeClawsMcpConfig: vi.fn(() => "/home/test/.claws/session-mcp/x/.mcp-claws.json"),
    enrichedPath: vi.fn((p?: string) => `/home/test/.opencode/bin:${p ?? ""}`),
  },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockShutdown: { isShuttingDown: vi.fn(() => false), ShutdownError: class {} },
  mockSessionEnvFile: {
    writeSessionEnvFile: vi.fn(() => "/home/test/.claws/session-env/x.env"),
    removeSessionEnvFile: vi.fn(),
    pruneSessionEnvFiles: vi.fn(),
    ensureSessionCodexHome: vi.fn((id: string) => `/home/test/.claws/session-mcp/${id}/codex-home`),
    pruneOrphanSessionMcpDirs: vi.fn(),
    sessionMcpDir: vi.fn((id: string) => `/home/test/.claws/session-mcp/${id}`),
    ensureSessionMcpDir: vi.fn((id: string) => `/home/test/.claws/session-mcp/${id}`),
    removeSessionMcpDir: vi.fn(),
  },
  mockSessionUploads: {
    ensureSessionUploadDir: vi.fn((id: string) => `/home/test/.claws/session-uploads/${id}`),
    pruneOrphanSessionUploadDirs: vi.fn(),
    removeSessionUploadDir: vi.fn(),
    sessionUploadDir: vi.fn((id: string) => `/home/test/.claws/session-uploads/${id}`),
  },
  mockCrypto: {
    sessionIds: [] as string[],
    randomBytes: vi.fn(() => {
      const hex = mockCrypto.sessionIds.shift() ?? "aaaaaaaaaaaaaaaa";
      return Buffer.from(hex, "hex");
    }),
  },
}));

vi.mock("node-pty", () => ({ default: mockPty, ...mockPty }));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("./db.js", () => mockDb);
vi.mock("./github.js", () => mockGithub);
vi.mock("./claude.js", () => mockClaude);
vi.mock("./log.js", () => mockLog);
vi.mock("./shutdown.js", () => mockShutdown);
vi.mock("./config.js", () => ({ WORK_DIR: "/home/test/.claws", OPENCODE_BEST_MODEL: "openrouter/test/model", OPENROUTER_API_KEY: "" }));
vi.mock("node:fs", () => ({ default: { existsSync: () => true }, existsSync: () => true }));
vi.mock("./session-env-file.js", () => mockSessionEnvFile);
vi.mock("./session-uploads.js", () => mockSessionUploads);
vi.mock("node:crypto", () => ({ default: mockCrypto, ...mockCrypto }));

import { recoverSessions, createMultiWorktreeSession, createSession, resumeSession, listSessions, killSession, deleteSession, summarizeSession, setSessionDescription, getSession, getEndedSession } from "./sessions.js";
import type { Session } from "./sessions.js";
import { SESSION_WORKFLOW_PROMPT } from "./resources/claws-info.js";

function makeProc(stdout: string, exitCode = 0) {
  const proc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  };
  proc.stdout.on.mockImplementation((event: string, cb: (d: Buffer) => void) => {
    if (event === "data") setTimeout(() => cb(Buffer.from(stdout)), 0);
  });
  proc.stderr.on.mockImplementation(() => {});
  proc.on.mockImplementation((event: string, cb: (code: number) => void) => {
    if (event === "exit") setTimeout(() => cb(exitCode), 0);
  });
  return proc;
}

function makeFakePty() {
  return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };
}

// A fake pty whose bridge-exit callback can be fired on demand, so tests can
// simulate the Claude/tmux session ending.
function makeControllablePty() {
  let exitCb: ((e: { exitCode: number }) => void) | null = null;
  return {
    onData: vi.fn(),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => { exitCb = cb; }),
    kill: vi.fn(),
    write: vi.fn(),
    triggerExit(code = 0): void { exitCb?.({ exitCode: code }); },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function setNextSessionIds(...ids: string[]) {
  mockCrypto.sessionIds.splice(0, mockCrypto.sessionIds.length, ...ids);
}

// Wire mockSpawn so list-sessions returns the right names per socket
function setupTmuxMock(opts: {
  clawsSocketSessions?: string;
  defaultSocketSessions?: string | null; // null = no server running (exit 1)
}) {
  mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
    const lIdx = args.indexOf("-L");
    const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
    const isDefaultSocket = lIdx === -1;
    const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];

    if (isClawsSocket && subCmd === "list-sessions") {
      return makeProc(opts.clawsSocketSessions ?? "", 0);
    }
    if (isClawsSocket && subCmd === "has-session") {
      const tIdx = args.indexOf("-t");
      const name = tIdx !== -1 ? (args[tIdx + 1] ?? "").replace(/^=/, "") : "";
      const alive = (opts.clawsSocketSessions ?? "").split("\n").filter(Boolean);
      return makeProc("", alive.includes(name) ? 0 : 1);
    }
    if (isClawsSocket) {
      return makeProc("", 0);
    }
    if (isDefaultSocket && subCmd === "list-sessions") {
      if (opts.defaultSocketSessions === null) return makeProc("", 1);
      return makeProc(opts.defaultSocketSessions ?? "", 0);
    }
    if (isDefaultSocket) {
      return makeProc("", 0);
    }
    return makeProc("", 0);
  });
}

describe("recoverSessions — orphan sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNextSessionIds("1111111111111111", "2222222222222222", "3333333333333333");
    mockGithub.listRepos.mockResolvedValue([]);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockPty.spawn.mockReturnValue(makeFakePty());
  });

  it("kills a claws-* session on the claws socket with no DB row", async () => {
    mockDb.getAllPersistedSessions.mockReturnValue([]);
    setupTmuxMock({ clawsSocketSessions: "claws-abc123\n", defaultSocketSessions: null });

    await recoverSessions();

    const killCalls = mockSpawn.mock.calls.filter((call) => {
      const args: string[] = call[1];
      return args.includes("-L") && args.includes("kill-session") && args.some((a) => a.includes("claws-abc123"));
    });
    expect(killCalls.length).toBeGreaterThan(0);
  });

  it("kills a claws-* session on the default tmux socket", async () => {
    mockDb.getAllPersistedSessions.mockReturnValue([]);
    setupTmuxMock({ clawsSocketSessions: "", defaultSocketSessions: "claws-def456\n" });

    await recoverSessions();

    const killCalls = mockSpawn.mock.calls.filter((call) => {
      const args: string[] = call[1];
      return !args.includes("-L") && args.includes("kill-session") && args.some((a) => a.includes("claws-def456"));
    });
    expect(killCalls.length).toBeGreaterThan(0);
  });

  it("does not kill sessions without the claws- prefix", async () => {
    mockDb.getAllPersistedSessions.mockReturnValue([]);
    setupTmuxMock({
      clawsSocketSessions: "unrelated-session\n",
      defaultSocketSessions: "another-unrelated\n",
    });

    await recoverSessions();

    const killCalls = mockSpawn.mock.calls.filter((call) => {
      const args: string[] = call[1];
      return args.includes("kill-session");
    });
    expect(killCalls.length).toBe(0);
  });

  it("does not kill a session that matches a persisted DB row", async () => {
    mockDb.getAllPersistedSessions.mockReturnValue([
      {
        id: "abc123",
        tmux_name: "claws-abc123",
        mode: "home-claude",
        repo: null,
        cwd: "/home/test",
        worktree_path: null,
        created_at: 0,
        summary: null,
        summary_updated_at: null,
      },
    ]);
    setupTmuxMock({ clawsSocketSessions: "claws-abc123\n", defaultSocketSessions: null });

    await recoverSessions();

    const killCalls = mockSpawn.mock.calls.filter((call) => {
      const args: string[] = call[1];
      return args.includes("kill-session") && args.some((a) => a.includes("claws-abc123"));
    });
    expect(killCalls.length).toBe(0);
  });

  it("runs the sweep even when DB is empty (no early return on empty persisted)", async () => {
    mockDb.getAllPersistedSessions.mockReturnValue([]);
    setupTmuxMock({ clawsSocketSessions: "claws-stray\n", defaultSocketSessions: null });

    await recoverSessions();

    const warnCalls = (mockLog.warn.mock.calls as string[][]).flat().join("\n");
    expect(warnCalls).toMatch(/claws-stray/);
  });

  it("keeps private-state dirs for still-live claws-* tmux sessions before the DB row exists", async () => {
    mockDb.getAllPersistedSessions.mockReturnValue([]);
    setupTmuxMock({
      clawsSocketSessions: "claws-live-before-persist\n",
      defaultSocketSessions: null,
    });

    await recoverSessions();

    expect(mockSessionEnvFile.pruneOrphanSessionMcpDirs).toHaveBeenCalledWith(
      new Set(["live-before-persist"]),
    );
    expect(mockSessionUploads.pruneOrphanSessionUploadDirs).toHaveBeenCalledWith(
      new Set(["live-before-persist"]),
    );
  });

  it("does not keep private-state dirs for stray claws-* tmux sessions reaped during startup", async () => {
    mockDb.getAllPersistedSessions.mockReturnValue([]);
    let clawsListCalls = 0;
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const isDefaultSocket = lIdx === -1;
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];

      if (isClawsSocket && subCmd === "list-sessions") {
        clawsListCalls += 1;
        return makeProc(clawsListCalls === 1 ? "claws-stray\n" : "", 0);
      }
      if (isClawsSocket) return makeProc("", 0);
      if (isDefaultSocket && subCmd === "list-sessions") return makeProc("", 1);
      return makeProc("", 0);
    });

    await recoverSessions();

    expect(mockSessionEnvFile.pruneOrphanSessionMcpDirs).toHaveBeenCalledWith(new Set());
    expect(mockSessionUploads.pruneOrphanSessionUploadDirs).toHaveBeenCalledWith(new Set());
  });

  it("prunes orphan private-state dirs after the final stray-tmux sweep", async () => {
    mockDb.getAllPersistedSessions.mockReturnValue([]);
    let clawsListCalls = 0;
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const isDefaultSocket = lIdx === -1;
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];

      if (isClawsSocket && subCmd === "list-sessions") {
        clawsListCalls += 1;
        return makeProc(clawsListCalls <= 3 ? "claws-late-stray\n" : "", 0);
      }
      if (isClawsSocket) return makeProc("", 0);
      if (isDefaultSocket && subCmd === "list-sessions") return makeProc("", 1);
      return makeProc("", 0);
    });

    await recoverSessions();

    expect(mockSessionEnvFile.pruneOrphanSessionMcpDirs).toHaveBeenCalledWith(new Set());
    expect(mockSessionUploads.pruneOrphanSessionUploadDirs).toHaveBeenCalledWith(new Set());
  });

  it("reaps a tmux session whose DB row was deleted during recovery", async () => {
    mockDb.getAllPersistedSessions
      .mockReturnValueOnce([
        {
          id: "abc123",
          tmux_name: "claws-abc123",
          mode: "home-claude",
          provider: "claude",
          repo: null,
          cwd: "/home/test",
          worktree_path: null,
          extra_worktrees: null,
          capabilities: null,
          created_at: 0,
          summary: null,
          summary_updated_at: null,
        },
      ])
      .mockReturnValueOnce([]);
    let clawsListCalls = 0;
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const isDefaultSocket = lIdx === -1;
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];

      if (isClawsSocket && subCmd === "list-sessions") {
        clawsListCalls += 1;
        if (clawsListCalls <= 3) return makeProc("claws-abc123\n", 0);
        return makeProc("", 0);
      }
      if (isClawsSocket && subCmd === "capture-pane") return makeProc("", 0);
      if (isClawsSocket && subCmd === "kill-session") return makeProc("kill failed", 1);
      if (isClawsSocket) return makeProc("", 0);
      if (isDefaultSocket && subCmd === "list-sessions") return makeProc("", 1);
      return makeProc("", 0);
    });
    mockPty.spawn.mockImplementation(() => {
      throw new Error("bridge attach failed");
    });

    await recoverSessions();

    expect(mockDb.deletePersistedSession).toHaveBeenCalledWith("abc123");
    const killCalls = mockSpawn.mock.calls.filter((call) => {
      const args: string[] = call[1];
      return args.includes("-L") && args.includes("kill-session") && args.some((a) => a.includes("claws-abc123"));
    });
    expect(killCalls).toHaveLength(2);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("Reaping stray tmux session claws-abc123"),
    );
  });

  it("still removes private state and worktrees when DB deletion fails during teardown", async () => {
    const repoA = { fullName: "owner/app", owner: "owner", name: "app", defaultBranch: "main" };
    mockGithub.listRepos.mockResolvedValue([repoA]);
    mockDb.getAllPersistedSessions.mockReturnValue([
      {
        id: "stuck1",
        tmux_name: "claws-stuck1",
        mode: "worktree-claude",
        provider: "claude",
        repo: "owner/app",
        cwd: "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x",
        worktree_path: "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x",
        extra_worktrees: null,
        capabilities: null,
        created_at: 0,
        summary: null,
        summary_updated_at: null,
      },
    ]);
    setupTmuxMock({ clawsSocketSessions: "", defaultSocketSessions: null });
    mockDb.deletePersistedSession.mockImplementationOnce(() => {
      throw new Error("db down");
    });

    await recoverSessions();

    expect(mockSessionEnvFile.removeSessionMcpDir).toHaveBeenCalledWith("stuck1");
    expect(mockSessionUploads.removeSessionUploadDir).toHaveBeenCalledWith("stuck1");
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(
      repoA,
      "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x",
    );
  });
});

describe("createMultiWorktreeSession", () => {
  const repoA = { fullName: "owner/app", owner: "owner", name: "app", defaultBranch: "main" };
  const repoB = { fullName: "owner/infra", owner: "owner", name: "infra", defaultBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockShutdown.isShuttingDown.mockReturnValue(false);
    mockGithub.listRepos.mockResolvedValue([repoA, repoB]);
    mockClaude.ensureClone.mockResolvedValue(undefined);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockPty.spawn.mockReturnValue(makeFakePty());
    // tmux commands all succeed (exit code 0)
    mockSpawn.mockImplementation(() => makeProc("", 0));
  });

  it("rejects with too-few-repos when fewer than two repos are provided", async () => {
    const result = await createMultiWorktreeSession(["owner/app"]);
    expect(result).toEqual({ ok: false, reason: "too-few-repos" });
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("rejects with too-few-repos when duplicate repos deduplicate below threshold", async () => {
    const result = await createMultiWorktreeSession(["owner/app", "owner/app"]);
    expect(result).toEqual({ ok: false, reason: "too-few-repos" });
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("rejects with repo-not-listed when a repo is not in listRepos()", async () => {
    mockGithub.listRepos.mockResolvedValue([repoA]); // repoB absent
    const result = await createMultiWorktreeSession(["owner/app", "owner/infra"]);
    expect(result).toMatchObject({ ok: false, reason: "repo-not-listed", detail: "owner/infra" });
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("creates a worktree per repo and wires extras via --add-dir", async () => {
    mockClaude.createWorktree
      .mockResolvedValueOnce("/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x")
      .mockResolvedValueOnce("/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x");

    const result = await createMultiWorktreeSession(["owner/app", "owner/infra"]);

    expect(result.ok).toBe(true);
    expect(mockClaude.createWorktree).toHaveBeenCalledTimes(2);

    const newSessionCall = mockSpawn.mock.calls.find((call) => {
      const args: string[] = call[1];
      return args.includes("new-session");
    });
    expect(newSessionCall).toBeDefined();
    const args: string[] = newSessionCall![1];
    expect(args).toContain("--add-dir");
    expect(args).toContain("/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x");

    expect(mockDb.insertSession).toHaveBeenCalledTimes(1);
    const persisted = mockDb.insertSession.mock.calls[0][0];
    expect(persisted.mode).toBe("multi-worktree-claude");
    expect(persisted.extra_worktrees).toBeTruthy();
    expect(JSON.parse(persisted.extra_worktrees)).toEqual([
      { repo: "owner/infra", worktreePath: "/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x" },
    ]);

    const id = (result as { ok: true; session: Session }).session.id;
    expect(listSessions().find((x) => x.id === id)?.extraRepos).toContain("owner/infra");
  });

  it("cleans up created worktrees when a later worktree fails", async () => {
    mockClaude.createWorktree
      .mockResolvedValueOnce("/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x")
      .mockRejectedValueOnce(new Error("boom"));

    const result = await createMultiWorktreeSession(["owner/app", "owner/infra"]);

    expect(result).toMatchObject({ ok: false, reason: "worktree-failed" });
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(
      repoA,
      "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x",
    );
    expect(mockDb.insertSession).not.toHaveBeenCalled();
  });

  it("places --dangerously-skip-permissions before --add-dir in the tmux command", async () => {
    mockClaude.createWorktree
      .mockResolvedValueOnce("/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x")
      .mockResolvedValueOnce("/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x");

    await createMultiWorktreeSession(["owner/app", "owner/infra"]);

    const newSessionCall = mockSpawn.mock.calls.find((call) => {
      const args: string[] = call[1];
      return args.includes("new-session");
    });
    expect(newSessionCall).toBeDefined();
    const args: string[] = newSessionCall![1];
    const dpIdx = args.indexOf("--dangerously-skip-permissions");
    const addDirIdx = args.indexOf("--add-dir");
    expect(dpIdx).toBeGreaterThan(-1);
    expect(addDirIdx).toBeGreaterThan(-1);
    expect(dpIdx).toBeLessThan(addDirIdx);
  });

  it("cleans up created worktrees when ensureClone fails for a later repo", async () => {
    mockClaude.createWorktree
      .mockResolvedValueOnce("/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x");
    mockClaude.ensureClone
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("network error"));

    const result = await createMultiWorktreeSession(["owner/app", "owner/infra"]);

    expect(result).toMatchObject({ ok: false, reason: "fetch-failed" });
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(
      repoA,
      "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x",
    );
    expect(mockDb.insertSession).not.toHaveBeenCalled();
  });

  it("removes session-private MCP/upload state when tmux new-session fails", async () => {
    setNextSessionIds("4444444444444444");
    const appWt = "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x";
    const infraWt = "/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x";
    mockClaude.createWorktree
      .mockResolvedValueOnce(appWt)
      .mockResolvedValueOnce(infraWt);
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];
      if (subCmd === "new-session") return makeProc("tmux failed", 1);
      return makeProc("", 0);
    });

    const result = await createMultiWorktreeSession(["owner/app", "owner/infra"]);

    expect(result).toMatchObject({ ok: false, reason: "tmux-failed" });
    expect(mockSessionEnvFile.removeSessionMcpDir).toHaveBeenCalledWith("4444444444444444");
    expect(mockSessionUploads.removeSessionUploadDir).toHaveBeenCalledWith("4444444444444444");
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, appWt);
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoB, infraWt);
  });

  it("removes session-private MCP/upload state when persist fails", async () => {
    setNextSessionIds("5555555555555555");
    const appWt = "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x";
    const infraWt = "/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x";
    mockClaude.createWorktree
      .mockResolvedValueOnce(appWt)
      .mockResolvedValueOnce(infraWt);
    mockDb.insertSession.mockImplementationOnce(() => {
      throw new Error("db down");
    });

    const result = await createMultiWorktreeSession(["owner/app", "owner/infra"]);

    expect(result).toMatchObject({ ok: false, reason: "persist-failed" });
    expect(mockSessionEnvFile.removeSessionMcpDir).toHaveBeenCalledWith("5555555555555555");
    expect(mockSessionUploads.removeSessionUploadDir).toHaveBeenCalledWith("5555555555555555");
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, appWt);
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoB, infraWt);
  });
});

describe("summarizeSession — generate-once", () => {
  const ENOUGH_SCROLLBACK = "x".repeat(100);

  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: "sess-1",
      pty: { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() } as unknown as Session["pty"],
      tmuxName: "claws-sess-1",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      repo: null,
      cwd: "/home/test",
      mode: "home-claude",
      provider: "claude",
      worktreePath: null,
      extraWorktrees: [],
      capabilities: [],
      scrollback: ENOUGH_SCROLLBACK,
      alive: true,
      exitCode: null,
      wsConnected: false,
      bridgeSpawnedAt: Date.now(),
      respawnCount: 0,
      summary: null,
      summaryUpdatedAt: null,
      summaryManual: false,
      resumable: false,
      resumeRepos: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockShutdown.isShuttingDown.mockReturnValue(false);
    mockClaude.runClaude.mockResolvedValue("Editing src/sessions.ts summarizer");
  });

  it("calls runClaude with provider=claude and persists the summary", async () => {
    const session = makeSession();

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    const [, , opts] = mockClaude.runClaude.mock.calls[0];
    expect(opts).toMatchObject({ provider: "claude" });
    expect(session.summary).toBe("Editing src/sessions.ts summarizer");
    expect(mockDb.updateSessionSummary).toHaveBeenCalledWith("sess-1", "Editing src/sessions.ts summarizer", expect.any(Number));
  });

  it("does not call runClaude again when a summary is already set (generate-once)", async () => {
    const session = makeSession({ summary: "Already summarized" });

    await summarizeSession(session);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(session.summary).toBe("Already summarized");
  });

  it("does not call runClaude and leaves summary null when scrollback is too short", async () => {
    const session = makeSession({ scrollback: "short" });

    await summarizeSession(session);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(session.summary).toBeNull();
    expect(mockDb.updateSessionSummary).not.toHaveBeenCalled();
  });

  it("re-summarizes an idle placeholder once there is newer activity", async () => {
    const session = makeSession({
      summary: "Idle at shell prompt",
      summaryUpdatedAt: 1000,
      lastActivity: 2000,
    });
    mockClaude.runClaude.mockResolvedValue("Editing sessions.ts summarizer");

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    expect(session.summary).toBe("Editing sessions.ts summarizer");
  });

  it("skips re-summarizing an idle placeholder when there is no newer activity", async () => {
    const session = makeSession({
      summary: "Idle at Claude prompt",
      summaryUpdatedAt: 2000,
      lastActivity: 2000,
    });

    await summarizeSession(session);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(session.summary).toBe("Idle at Claude prompt");
  });

  it("normalizes verbose idle agent output to the canonical string", async () => {
    const session = makeSession();
    mockClaude.runClaude.mockResolvedValue("Idle at Claude Code prompt in bonkus worktree");

    await summarizeSession(session);

    expect(session.summary).toBe("Idle at Claude prompt");
  });

  it("normalizes verbose idle shell output to the canonical string", async () => {
    const session = makeSession();
    mockClaude.runClaude.mockResolvedValue("Idle sitting at shell prompt in claws-wt repo");

    await summarizeSession(session);

    expect(session.summary).toBe("Idle at shell prompt");
  });

  it("never calls runClaude when the summary is manually pinned", async () => {
    const session = makeSession({ summaryManual: true });

    await summarizeSession(session);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("force overwrites an existing summary", async () => {
    const session = makeSession({ summary: "Already summarized" });
    mockClaude.runClaude.mockResolvedValue("Fresh forced summary");

    await summarizeSession(session, { force: true });

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    expect(session.summary).toBe("Fresh forced summary");
  });
});

describe("setSessionDescription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:false when the DB update affects no row and no live session exists", () => {
    mockDb.setManualSessionSummary.mockReturnValue(false);

    const result = setSessionDescription("does-not-exist", "A description");

    expect(result.ok).toBe(false);
  });
});

describe("resume — exit retains session, recreate worktree on resume", () => {
  const repoA = { fullName: "owner/app", owner: "owner", name: "app", defaultBranch: "main" };
  const WT_PATH = "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x";

  beforeEach(() => {
    vi.clearAllMocks();
    setNextSessionIds("aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc");
    mockShutdown.isShuttingDown.mockReturnValue(false);
    mockGithub.listRepos.mockResolvedValue([repoA]);
    mockClaude.ensureClone.mockResolvedValue(undefined);
    mockClaude.createWorktree.mockResolvedValue(WT_PATH);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    // clearAllMocks() keeps mockReturnValue implementations, so reset the history lookup per test.
    mockDb.getPersistedSession.mockReturnValue(undefined);
    // has-session returns non-zero (tmux gone); every other tmux command succeeds.
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];
      if (subCmd === "has-session") return makeProc("", 1);
      return makeProc("", 0);
    });
  });

  // #2138: argv is world-readable via /proc/<pid>/cmdline, so no element of the
  // tmux new-session command may carry a KEY=value pair — apart from the one
  // non-secret assignment buildCapabilityEnvArgs adds for the MCP tool timeout.
  it("puts no KEY=value element on the tmux new-session argv", async () => {
    mockPty.spawn.mockReturnValue(makeFakePty());

    const result = await createSession("owner/app", "repo-claude", []);
    expect(result.ok).toBe(true);

    const newSession = mockSpawn.mock.calls.find((call) => {
      const args: string[] = call[1];
      return args.includes("-L") && args.includes("new-session");
    });
    expect(newSession).toBeDefined();
    expect(
      (newSession![1] as string[]).filter((a) => a.includes("=") && a !== "MCP_TOOL_TIMEOUT=300000"),
    ).toEqual([]);
  });

  // #2360: previously --append-system-prompt was omitted entirely when no
  // capability was granted, so a session had no guidance to follow the
  // Claws lifecycle instead of invoking the repo's .agents/* role docs itself.
  it("always appends the session workflow prompt, even with zero capabilities", async () => {
    mockPty.spawn.mockReturnValue(makeFakePty());

    const result = await createSession("owner/app", "repo-claude", []);
    expect(result.ok).toBe(true);

    const newSession = mockSpawn.mock.calls.find((call) => {
      const args: string[] = call[1];
      return args.includes("-L") && args.includes("new-session");
    });
    expect(newSession).toBeDefined();
    const args: string[] = newSession![1];
    const promptIdx = args.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThan(-1);
    expect(args[promptIdx + 1]).toContain("issue-implementer");
  });

  it("grants --mcp-config with a Playwright-only server when the browser capability is granted", async () => {
    mockPty.spawn.mockReturnValue(makeFakePty());

    const result = await createSession("owner/app", "repo-claude", ["browser"]);
    expect(result.ok).toBe(true);

    const newSession = mockSpawn.mock.calls.find((call) => {
      const args: string[] = call[1];
      return args.includes("-L") && args.includes("new-session");
    });
    expect(newSession).toBeDefined();
    const args: string[] = newSession![1];
    const mcpIdx = args.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(args[mcpIdx + 1]).toBe("/home/test/.claws/session-mcp/x/.mcp-claws.json");
    expect(args).toContain("--strict-mcp-config");

    expect(mockClaude.writeClawsMcpConfig).toHaveBeenCalledTimes(1);
    const call = mockClaude.writeClawsMcpConfig.mock.calls[0] as unknown as [
      string,
      { includeClawsState: boolean; additionalServers: { playwright: { args: string[] } } },
    ];
    const [, options] = call;
    expect(options.includeClawsState).toBe(false);
    expect(options.additionalServers.playwright.args).toContain("--headless");
    expect(options.additionalServers.playwright.args).toContain("--user-data-dir");
  });

  it("writes a strict Claws-owned MCP config even when no capability is granted", async () => {
    mockPty.spawn.mockReturnValue(makeFakePty());

    const result = await createSession("owner/app", "repo-claude", []);
    expect(result.ok).toBe(true);

    const newSession = mockSpawn.mock.calls.find((call) => {
      const args: string[] = call[1];
      return args.includes("-L") && args.includes("new-session");
    });
    expect(newSession).toBeDefined();
    const args: string[] = newSession![1];
    const mcpIdx = args.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(args[mcpIdx + 1]).toBe("/home/test/.claws/session-mcp/x/.mcp-claws.json");
    expect(args).toContain("--strict-mcp-config");
    expect(mockClaude.writeClawsMcpConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ includeClawsState: true }),
    );
  });

  it("does not create a session Codex home for repo-zsh even when provider=codex", async () => {
    mockPty.spawn.mockReturnValue(makeFakePty());

    const result = await createSession("owner/app", "repo-zsh", [], "codex");

    expect(result.ok).toBe(true);
    expect(mockSessionEnvFile.ensureSessionCodexHome).not.toHaveBeenCalled();
    expect(mockSessionEnvFile.writeSessionEnvFile).not.toHaveBeenCalled();
    const newSession = mockSpawn.mock.calls.find((call) => {
      const args: string[] = call[1];
      return args.includes("-L") && args.includes("new-session");
    });
    expect(newSession).toBeDefined();
    expect(newSession![1]).toContain("zsh");
  });

  it("persists provider=claude for a repo-zsh session even when the caller posts codex", async () => {
    mockPty.spawn.mockReturnValue(makeFakePty());
    const result = await createSession("owner/app", "repo-zsh", [], "codex");
    expect(result.ok).toBe(true);
    expect(mockDb.insertSession).toHaveBeenCalledWith(expect.objectContaining({ mode: "repo-zsh", provider: "claude" }));
  });

  it("on bridge exit records the session as ended, frees the worktree, and removes it from listSessions()", async () => {
    const ptyObj = makeControllablePty();
    mockPty.spawn.mockReturnValue(ptyObj);

    const result = await createSession("owner/app", "worktree-claude");
    expect(result.ok).toBe(true);
    const id = (result as { ok: true; session: { id: string } }).session.id;

    ptyObj.triggerExit(0);
    await flush();

    // Ended sessions live in the DB, not the in-memory map.
    expect(listSessions().find((x) => x.id === id)).toBeUndefined();
    expect(mockDb.markSessionEnded).toHaveBeenCalledWith(id, expect.any(Number), JSON.stringify(["owner/app"]));
    expect(mockDb.deletePersistedSession).not.toHaveBeenCalled();
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, WT_PATH);
  });

  it("removes session-private MCP/upload state when tmux new-session fails during create", async () => {
    setNextSessionIds("dddddddddddddddd");
    mockPty.spawn.mockReturnValue(makeFakePty());
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];
      if (subCmd === "new-session") return makeProc("tmux failed", 1);
      if (subCmd === "has-session") return makeProc("", 1);
      return makeProc("", 0);
    });

    const result = await createSession("owner/app", "worktree-claude");

    expect(result).toMatchObject({ ok: false, reason: "tmux-failed" });
    expect(mockSessionEnvFile.removeSessionMcpDir).toHaveBeenCalledWith("dddddddddddddddd");
    expect(mockSessionUploads.removeSessionUploadDir).toHaveBeenCalledWith("dddddddddddddddd");
  });

  it("removes session-private MCP/upload state when persist fails during create", async () => {
    setNextSessionIds("eeeeeeeeeeeeeeee");
    mockPty.spawn.mockReturnValue(makeFakePty());
    mockDb.insertSession.mockImplementationOnce(() => {
      throw new Error("db down");
    });

    const result = await createSession("owner/app", "worktree-claude");

    expect(result).toMatchObject({ ok: false, reason: "persist-failed" });
    expect(mockSessionEnvFile.removeSessionMcpDir).toHaveBeenCalledWith("eeeeeeeeeeeeeeee");
    expect(mockSessionUploads.removeSessionUploadDir).toHaveBeenCalledWith("eeeeeeeeeeeeeeee");
  });

  it("removes session-private MCP/upload state for ended sessions pruned from history", async () => {
    const ptyObj = makeControllablePty();
    mockPty.spawn.mockReturnValue(ptyObj);
    mockDb.pruneEndedSessions.mockReturnValue(["old-session"]);

    const result = await createSession("owner/app", "worktree-claude");
    expect(result.ok).toBe(true);

    ptyObj.triggerExit(0);
    await flush();

    expect(mockDb.pruneEndedSessions).toHaveBeenCalledWith(50);
    expect(mockSessionEnvFile.removeSessionMcpDir).toHaveBeenCalledWith("old-session");
    expect(mockSessionUploads.removeSessionUploadDir).toHaveBeenCalledWith("old-session");
  });

  it("resumeSession reconstructs an ended session from the DB, recreates the worktree, and clears its ended marker", async () => {
    const ptyObj = makeControllablePty();
    mockPty.spawn.mockReturnValue(ptyObj);

    const created = await createSession("owner/app", "worktree-claude");
    const id = (created as { ok: true; session: { id: string } }).session.id;

    ptyObj.triggerExit(0);
    await flush();

    // The session is now history-only (absent from the map); resume must read it back from the DB.
    expect(listSessions().find((x) => x.id === id)).toBeUndefined();
    mockDb.getPersistedSession.mockReturnValue({
      id, tmux_name: `claws-${id}`, mode: "worktree-claude", repo: "owner/app",
      cwd: WT_PATH, worktree_path: WT_PATH, extra_worktrees: null, capabilities: null,
      created_at: 0, summary: null, summary_updated_at: null,
      ended_at: 1000, resume_repos: JSON.stringify(["owner/app"]),
    });

    const resumed = await resumeSession(id);
    expect(resumed.ok).toBe(true);

    expect(mockDb.getPersistedSession).toHaveBeenCalledWith(id);
    expect(mockClaude.createWorktree).toHaveBeenCalledWith(repoA, `claws-wt/${id}`, "sessions");
    expect(mockDb.clearSessionEnded).toHaveBeenCalledWith(id);

    const continueCall = mockSpawn.mock.calls.find((call) => {
      const args: string[] = call[1];
      return args.includes("new-session") && args.includes("--continue");
    });
    expect(continueCall).toBeDefined();

    const s = listSessions().find((x) => x.id === id);
    expect(s?.alive).toBe(true);
    expect(s?.resumable).toBe(false);

    killSession(id);
  });

  it("a failed resume of a reconstructed session leaves no orphaned entry in the map", async () => {
    // The session exists only in history (never in the live map for this test).
    mockDb.getPersistedSession.mockReturnValue({
      id: "orphan1", tmux_name: "claws-orphan1", mode: "worktree-claude", repo: "owner/app",
      cwd: WT_PATH, worktree_path: WT_PATH, extra_worktrees: null, capabilities: null,
      created_at: 0, summary: null, summary_updated_at: null,
      ended_at: 1000, resume_repos: JSON.stringify(["owner/app"]),
    });
    // Rebuild fails partway through resume.
    mockClaude.createWorktree.mockRejectedValueOnce(new Error("boom"));

    const result = await resumeSession("orphan1");
    expect(result).toMatchObject({ ok: false, reason: "worktree-failed" });

    // The reconstructed session (with its placeholder pty) must NOT be published
    // to the live map — otherwise getSession()/the WS route could dereference it.
    expect(getSession("orphan1")).toBeUndefined();
    expect(listSessions().find((x) => x.id === "orphan1")).toBeUndefined();
  });

  it("rolls back rebuilt worktrees when resume fails after recreation", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "orphan2", tmux_name: "claws-orphan2", mode: "multi-worktree-claude", repo: "owner/app",
      cwd: WT_PATH, worktree_path: WT_PATH,
      extra_worktrees: JSON.stringify([{ repo: "owner/infra", worktreePath: "/old/infra" }]),
      capabilities: null,
      created_at: 0, summary: null, summary_updated_at: null,
      ended_at: 1000, resume_repos: JSON.stringify(["owner/app", "owner/infra"]),
    });
    mockGithub.listRepos.mockResolvedValue([repoA, { fullName: "owner/infra", owner: "owner", name: "infra", defaultBranch: "main" }]);
    mockClaude.createWorktree
      .mockResolvedValueOnce(WT_PATH)
      .mockResolvedValueOnce("/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x");
    mockPty.spawn.mockImplementation(() => {
      throw new Error("bridge attach failed");
    });

    const result = await resumeSession("orphan2");

    expect(result).toMatchObject({ ok: false, reason: "bridge-failed" });
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, WT_PATH);
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(
      { fullName: "owner/infra", owner: "owner", name: "infra", defaultBranch: "main" },
      "/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x",
    );
    expect(mockSessionEnvFile.removeSessionEnvFile).toHaveBeenCalledWith("orphan2");
    expect(mockSessionEnvFile.removeSessionMcpDir).not.toHaveBeenCalledWith("orphan2");
    expect(mockSessionUploads.removeSessionUploadDir).not.toHaveBeenCalledWith("orphan2");
    expect(mockDb.clearSessionEnded).not.toHaveBeenCalled();
    expect(getSession("orphan2")).toBeUndefined();
  });

  it("rolls back rebuilt worktrees when resume env preparation fails after recreation", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "orphan3", tmux_name: "claws-orphan3", mode: "worktree-claude", repo: "owner/app",
      cwd: WT_PATH, worktree_path: WT_PATH, extra_worktrees: null, capabilities: null,
      created_at: 0, summary: null, summary_updated_at: null,
      ended_at: 1000, resume_repos: JSON.stringify(["owner/app"]), provider: "codex",
    });
    mockSessionEnvFile.ensureSessionCodexHome.mockImplementationOnce(() => {
      throw new Error("codex home failed");
    });

    const result = await resumeSession("orphan3");

    expect(result).toMatchObject({ ok: false, reason: "tmux-failed" });
    expect(mockClaude.createWorktree).toHaveBeenCalledWith(repoA, "claws-wt/orphan3", "sessions");
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, WT_PATH);
    expect(mockSessionEnvFile.removeSessionEnvFile).toHaveBeenCalledWith("orphan3");
    expect(mockDb.clearSessionEnded).not.toHaveBeenCalled();
    expect(getSession("orphan3")).toBeUndefined();
  });

  it("rolls back rebuilt worktrees when tmux new-session fails after recreation", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "orphan4", tmux_name: "claws-orphan4", mode: "multi-worktree-claude", repo: "owner/app",
      cwd: WT_PATH, worktree_path: WT_PATH,
      extra_worktrees: JSON.stringify([{ repo: "owner/infra", worktreePath: "/old/infra" }]),
      capabilities: null,
      created_at: 0, summary: null, summary_updated_at: null,
      ended_at: 1000, resume_repos: JSON.stringify(["owner/app", "owner/infra"]), provider: "claude",
    });
    const repoInfra = { fullName: "owner/infra", owner: "owner", name: "infra", defaultBranch: "main" };
    mockGithub.listRepos.mockResolvedValue([repoA, repoInfra]);
    mockClaude.createWorktree
      .mockResolvedValueOnce(WT_PATH)
      .mockResolvedValueOnce("/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x");
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];
      if (subCmd === "has-session") return makeProc("", 1);
      if (subCmd === "new-session") return makeProc("tmux failed", 1);
      return makeProc("", 0);
    });

    const result = await resumeSession("orphan4");

    expect(result).toMatchObject({ ok: false, reason: "tmux-failed" });
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, WT_PATH);
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(
      repoInfra,
      "/home/test/.claws/worktrees/owner/infra/sessions/claws-wt/x",
    );
    expect(mockSessionEnvFile.removeSessionEnvFile).toHaveBeenCalledWith("orphan4");
    expect(mockDb.clearSessionEnded).not.toHaveBeenCalled();
    expect(getSession("orphan4")).toBeUndefined();
  });

  it("rejects resume for an abandoned in-memory session that is no longer resumable", async () => {
    const ptyObj = makeControllablePty();
    mockPty.spawn.mockReturnValue(ptyObj);
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];
      if (subCmd === "has-session") return makeProc("", 0);
      return makeProc("", 0);
    });
    const mod = await import("./sessions.js");
    const created = await mod.createSession("owner/app", "worktree-claude");
    expect(created.ok).toBe(true);
    const id = (created as { ok: true; session: { id: string } }).session.id;

    for (let i = 0; i < 3; i++) {
      ptyObj.triggerExit(1);
      await flush();
    }

    const result = await mod.resumeSession(id);

    expect(result).toMatchObject({ ok: false, reason: "not-resumable", detail: id });
  });

  it("rejects resume when the persisted row is still live rather than ended", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "live-row", tmux_name: "claws-live-row", mode: "worktree-claude", repo: "owner/app",
      cwd: WT_PATH, worktree_path: WT_PATH, extra_worktrees: null, capabilities: null,
      created_at: 0, summary: null, summary_updated_at: null,
      ended_at: null, resume_repos: null,
    });

    const result = await resumeSession("live-row");

    expect(result).toMatchObject({ ok: false, reason: "not-resumable", detail: "live-row" });
  });

  it("resumeSession on an unknown id returns repo-not-found", async () => {
    const result = await resumeSession("deadbeef");
    expect(result).toMatchObject({ ok: false, reason: "repo-not-found" });
  });

  it("killSession moves the session to history (markSessionEnded, not deletePersistedSession) and frees the worktree", async () => {
    const ptyObj = makeControllablePty();
    mockPty.spawn.mockReturnValue(ptyObj);

    const created = await createSession("owner/app", "worktree-claude");
    const id = (created as { ok: true; session: { id: string } }).session.id;

    expect(killSession(id)).toBe(true);
    expect(mockDb.markSessionEnded).toHaveBeenCalledWith(id, expect.any(Number), JSON.stringify(["owner/app"]));
    expect(mockDb.deletePersistedSession).not.toHaveBeenCalled();
    expect(listSessions().find((x) => x.id === id)).toBeUndefined();
    await flush();
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, WT_PATH);
  });

  it("bridge respawn fails 3x — the 60s reaper removes the abandoned session without recording it in history", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      setNextSessionIds("ffffffffffffffff");
      // tmux still reports the session alive on every check, so handleBridgeExit
      // takes the respawn path (not the graceful "tmux gone" exit path).
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        const lIdx = args.indexOf("-L");
        const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
        const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];
        if (subCmd === "has-session") return makeProc("", 0);
        return makeProc("", 0);
      });
      const mod = await import("./sessions.js");
      const ptyObj = makeControllablePty();
      mockPty.spawn.mockReturnValue(ptyObj);

      const p = mod.createSession("owner/app", "worktree-claude");
      await vi.advanceTimersByTimeAsync(50);
      const result = await p;
      expect(result.ok).toBe(true);
      const id = (result as { ok: true; session: { id: string } }).session.id;
      expect(id).toBe("ffffffffffffffff");

      // Each exit happens well within RESPAWN_MIN_LIFETIME_MS, so the 3rd exit
      // exhausts MAX_RESPAWN_ATTEMPTS and the bridge gives up on the session.
      for (let i = 0; i < 3; i++) {
        ptyObj.triggerExit(1);
        await vi.advanceTimersByTimeAsync(10);
      }

      expect(mockDb.deletePersistedSession).toHaveBeenCalledWith(id);
      expect(mockDb.markSessionEnded).not.toHaveBeenCalled();
      // Abandoned but not yet reaped — still in the map until the 60s sweep.
      expect(mod.listSessions().find((x) => x.id === id)).toBeDefined();

      await vi.advanceTimersByTimeAsync(61_000);

      expect(mod.listSessions().find((x) => x.id === id)).toBeUndefined();
      // The reaper's killSession() call must not record history a second time
      // against the already-deleted row.
      expect(mockDb.markSessionEnded).not.toHaveBeenCalled();
      expect(mockSessionEnvFile.removeSessionMcpDir).toHaveBeenCalledWith("ffffffffffffffff");
      expect(mockSessionUploads.removeSessionUploadDir).toHaveBeenCalledWith("ffffffffffffffff");
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("deleteSession permanently removes the persisted row, private state, and the worktree", async () => {
    const ptyObj = makeControllablePty();
    mockPty.spawn.mockReturnValue(ptyObj);

    const created = await createSession("owner/app", "worktree-claude");
    const id = (created as { ok: true; session: { id: string } }).session.id;

    expect(deleteSession(id)).toBe(true);
    expect(mockDb.deletePersistedSession).toHaveBeenCalledWith(id);
    expect(mockDb.markSessionEnded).not.toHaveBeenCalled();
    expect(mockSessionEnvFile.removeSessionMcpDir).toHaveBeenCalledWith(id);
    expect(mockSessionUploads.removeSessionUploadDir).toHaveBeenCalledWith(id);
    expect(listSessions().find((x) => x.id === id)).toBeUndefined();
    await flush();
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, WT_PATH);
  });
});

describe("provider choice — claude vs codex vs opencode argv", () => {
  const repoA = { fullName: "owner/app", owner: "owner", name: "app", defaultBranch: "main" };
  const WT_PATH = "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x";

  beforeEach(() => {
    vi.clearAllMocks();
    mockShutdown.isShuttingDown.mockReturnValue(false);
    mockGithub.listRepos.mockResolvedValue([repoA]);
    mockClaude.ensureClone.mockResolvedValue(undefined);
    mockClaude.createWorktree.mockResolvedValue(WT_PATH);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockDb.getPersistedSession.mockReturnValue(undefined);
    mockPty.spawn.mockReturnValue(makeFakePty());
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];
      if (subCmd === "has-session") return makeProc("", 1);
      return makeProc("", 0);
    });
  });

  function newSessionArgv(): string[] {
    const call = mockSpawn.mock.calls.find((c) => {
      const args: string[] = c[1];
      return args.includes("-L") && args.includes("new-session");
    });
    expect(call).toBeDefined();
    return call![1] as string[];
  }

  /** The argv from the agent command onwards — everything after the `env …` prefix. */
  function agentArgv(argv: string[], command: string): string[] {
    const idx = argv.lastIndexOf(command);
    expect(idx).toBeGreaterThan(-1);
    return argv.slice(idx);
  }

  it("spawns `claude` with a strict session-owned MCP config", async () => {
    const result = await createSession("owner/app", "repo-claude", []);
    expect(result.ok).toBe(true);
    const id = (result as { ok: true; session: { id: string } }).session.id;

    expect(agentArgv(newSessionArgv(), "claude")).toEqual([
      "claude",
      "--dangerously-skip-permissions",
      "--append-system-prompt", SESSION_WORKFLOW_PROMPT,
      "--add-dir", `/home/test/.claws/session-uploads/${id}`,
      "--mcp-config", "/home/test/.claws/session-mcp/x/.mcp-claws.json",
      "--strict-mcp-config",
    ]);
  });

  it("spawns `codex` with --dangerously-bypass-approvals-and-sandbox, isolated CODEX_HOME, and the workflow prompt as a positional arg", async () => {
    const result = await createSession("owner/app", "repo-claude", [], "codex");
    expect(result.ok).toBe(true);
    const id = (result as { ok: true; session: { id: string } }).session.id;

    expect(agentArgv(newSessionArgv(), "codex")).toEqual([
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "--add-dir", `/home/test/.claws/session-uploads/${id}`,
      SESSION_WORKFLOW_PROMPT,
    ]);
    const writeSessionEnvFile = (await import("./session-env-file.js")).writeSessionEnvFile as unknown as ReturnType<typeof vi.fn>;
    expect(writeSessionEnvFile).toHaveBeenCalledWith(
      id,
      expect.objectContaining({
        CODEX_HOME: `/home/test/.claws/session-mcp/${id}/codex-home`,
      }),
    );
    expect(mockDb.insertSession).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex" }));
  });

  it("rejects a codex session that asks for the browser capability", async () => {
    const result = await createSession("owner/app", "repo-claude", ["browser"], "codex");
    expect(result).toMatchObject({ ok: false, reason: "capability-unsupported" });
    expect(mockClaude.writeClawsMcpConfig).not.toHaveBeenCalled();
    expect(mockDb.insertSession).not.toHaveBeenCalled();
  });

  it("resumes a codex session with `codex resume --last` and no positional prompt", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "c0dec0de", tmux_name: "claws-c0dec0de", mode: "worktree-claude", repo: "owner/app",
      cwd: WT_PATH, worktree_path: WT_PATH, extra_worktrees: null, capabilities: null,
      created_at: 0, summary: null, summary_updated_at: null,
      ended_at: 1000, resume_repos: JSON.stringify(["owner/app"]), provider: "codex",
    });

    const resumed = await resumeSession("c0dec0de");
    expect(resumed.ok).toBe(true);

    expect(agentArgv(newSessionArgv(), "codex")).toEqual([
      "codex", "resume", "--last",
      "--dangerously-bypass-approvals-and-sandbox",
      "--add-dir", "/home/test/.claws/session-uploads/c0dec0de",
    ]);
    const writeSessionEnvFile = (await import("./session-env-file.js")).writeSessionEnvFile as unknown as ReturnType<typeof vi.fn>;
    expect(writeSessionEnvFile).toHaveBeenCalledWith(
      "c0dec0de",
      expect.objectContaining({
        CODEX_HOME: "/home/test/.claws/session-mcp/c0dec0de/codex-home",
      }),
    );

    killSession("c0dec0de");
  });

  it("spawns `opencode` with --model and the workflow prompt via --prompt, no MCP/add-dir/permission flags", async () => {
    const result = await createSession("owner/app", "repo-claude", [], "opencode");
    expect(result.ok).toBe(true);
    const id = (result as { ok: true; session: { id: string } }).session.id;

    expect(agentArgv(newSessionArgv(), "opencode")).toEqual([
      "opencode",
      "--model", "openrouter/test/model",
      "--prompt", SESSION_WORKFLOW_PROMPT,
    ]);
    const argv = agentArgv(newSessionArgv(), "opencode");
    expect(argv).not.toContain("--add-dir");
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(mockClaude.writeClawsMcpConfig).not.toHaveBeenCalled();

    const writeSessionEnvFile = (await import("./session-env-file.js")).writeSessionEnvFile as unknown as ReturnType<typeof vi.fn>;
    expect(writeSessionEnvFile).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ PATH: expect.stringContaining(".opencode/bin") }),
    );
    expect(mockDb.insertSession).toHaveBeenCalledWith(expect.objectContaining({ provider: "opencode" }));
  });

  it("rejects an opencode session that asks for the browser capability", async () => {
    const result = await createSession("owner/app", "repo-claude", ["browser"], "opencode");
    expect(result).toMatchObject({ ok: false, reason: "capability-unsupported" });
    expect(mockDb.insertSession).not.toHaveBeenCalled();
  });

  it("resumes an opencode session with --continue and no --prompt", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "09e9c0de", tmux_name: "claws-09e9c0de", mode: "worktree-claude", repo: "owner/app",
      cwd: WT_PATH, worktree_path: WT_PATH, extra_worktrees: null, capabilities: null,
      created_at: 0, summary: null, summary_updated_at: null,
      ended_at: 1000, resume_repos: JSON.stringify(["owner/app"]), provider: "opencode",
    });

    const resumed = await resumeSession("09e9c0de");
    expect(resumed.ok).toBe(true);

    expect(agentArgv(newSessionArgv(), "opencode")).toEqual([
      "opencode", "--continue", "--model", "openrouter/test/model",
    ]);

    killSession("09e9c0de");
  });

  it("persists provider=claude for a repo-zsh session even when the caller posts opencode", async () => {
    const result = await createSession("owner/app", "repo-zsh", [], "opencode");
    expect(result.ok).toBe(true);
    expect(mockDb.insertSession).toHaveBeenCalledWith(expect.objectContaining({ mode: "repo-zsh", provider: "claude" }));
    const newSession = mockSpawn.mock.calls.find((call) => {
      const args: string[] = call[1];
      return args.includes("-L") && args.includes("new-session");
    });
    expect(newSession).toBeDefined();
    expect(newSession![1]).toContain("zsh");
  });

  it("treats a NULL provider column as claude on resume", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "01dc0de1", tmux_name: "claws-01dc0de1", mode: "worktree-claude", repo: "owner/app",
      cwd: WT_PATH, worktree_path: WT_PATH, extra_worktrees: null, capabilities: null,
      created_at: 0, summary: null, summary_updated_at: null,
      ended_at: 1000, resume_repos: JSON.stringify(["owner/app"]), provider: null,
    });

    const resumed = await resumeSession("01dc0de1");
    expect(resumed.ok).toBe(true);
    expect(agentArgv(newSessionArgv(), "claude")).toContain("--continue");

    killSession("01dc0de1");
  });
});

describe("getEndedSession", () => {
  it("returns undefined when there is no persisted row", () => {
    mockDb.getPersistedSession.mockReturnValue(undefined);
    expect(getEndedSession("nope")).toBeUndefined();
  });

  it("returns undefined when the row is still live (ended_at is null)", () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "abcdef12", tmux_name: "claws-abcdef12", mode: "worktree-claude", repo: "org/a",
      cwd: "/w", worktree_path: "/w", extra_worktrees: null, capabilities: null,
      created_at: 1, summary: null, summary_updated_at: null,
      ended_at: null, resume_repos: JSON.stringify(["org/a"]),
    });
    expect(getEndedSession("abcdef12")).toBeUndefined();
  });

  it("returns the mapped history record for an ended row", () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "abcdef12", repo: "org/a", cwd: "/w", mode: "worktree-claude", provider: "codex",
      created_at: 1, ended_at: 2, resume_repos: '["org/a","org/b"]', summary: "did stuff",
      summary_updated_at: 2, tmux_name: "claws-abcdef12", worktree_path: "/w", capabilities: null,
    });
    expect(getEndedSession("abcdef12")).toEqual({
      id: "abcdef12", repo: "org/a", extraRepos: ["org/b"], cwd: "/w",
      provider: "codex", createdAt: 1, endedAt: 2, summary: "did stuff",
    });
  });
});
