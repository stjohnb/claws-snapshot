import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSpawn, mockPty, mockDb, mockGithub, mockClaude, mockLog, mockShutdown } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockPty: { spawn: vi.fn() },
  mockDb: {
    getAllPersistedSessions: vi.fn(),
    deletePersistedSession: vi.fn(),
    insertSession: vi.fn(),
    updateSessionSummary: vi.fn(),
  },
  mockGithub: { listRepos: vi.fn() },
  mockClaude: { removeWorktree: vi.fn(), ensureClone: vi.fn(), createWorktree: vi.fn(), runClaude: vi.fn() },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockShutdown: { isShuttingDown: vi.fn(() => false), ShutdownError: class {} },
}));

vi.mock("node-pty", () => ({ default: mockPty, ...mockPty }));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("./db.js", () => mockDb);
vi.mock("./github.js", () => mockGithub);
vi.mock("./claude.js", () => mockClaude);
vi.mock("./log.js", () => mockLog);
vi.mock("./shutdown.js", () => mockShutdown);
vi.mock("./config.js", () => ({ WORK_DIR: "/home/test/.claws" }));
vi.mock("node:fs", () => ({ default: { existsSync: () => true }, existsSync: () => true }));

import { recoverSessions, createMultiWorktreeSession, createSession, resumeSession, listSessions, killSession, summarizeSession } from "./sessions.js";
import type { Session } from "./sessions.js";

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

  it("calls runClaude with provider=claude and capability=text-only and persists the summary", async () => {
    const session = makeSession();

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    const [, , opts] = mockClaude.runClaude.mock.calls[0];
    expect(opts).toMatchObject({ capability: "text-only", provider: "claude" });
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
});

describe("resume — exit retains session, recreate worktree on resume", () => {
  const repoA = { fullName: "owner/app", owner: "owner", name: "app", defaultBranch: "main" };
  const WT_PATH = "/home/test/.claws/worktrees/owner/app/sessions/claws-wt/x";

  beforeEach(() => {
    vi.clearAllMocks();
    mockShutdown.isShuttingDown.mockReturnValue(false);
    mockGithub.listRepos.mockResolvedValue([repoA]);
    mockClaude.ensureClone.mockResolvedValue(undefined);
    mockClaude.createWorktree.mockResolvedValue(WT_PATH);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    // has-session returns non-zero (tmux gone); every other tmux command succeeds.
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const lIdx = args.indexOf("-L");
      const isClawsSocket = lIdx !== -1 && args[lIdx + 1] === "claws";
      const subCmd = isClawsSocket ? args[lIdx + 2] : args[0];
      if (subCmd === "has-session") return makeProc("", 1);
      return makeProc("", 0);
    });
  });

  it("keeps an exited worktree session resumable, frees the worktree, and does not delete the row", async () => {
    const ptyObj = makeControllablePty();
    mockPty.spawn.mockReturnValue(ptyObj);

    const result = await createSession("owner/app", "worktree-claude");
    expect(result.ok).toBe(true);
    const id = (result as { ok: true; session: { id: string } }).session.id;

    ptyObj.triggerExit(0);
    await flush();

    const s = listSessions().find((x) => x.id === id);
    expect(s).toBeDefined();
    expect(s?.alive).toBe(false);
    expect(s?.resumable).toBe(true);
    expect(mockDb.deletePersistedSession).not.toHaveBeenCalled();
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, WT_PATH);

    killSession(id); // cleanup for isolation
  });

  it("resumeSession recreates the worktree at claws-wt/<id> and relaunches claude --continue", async () => {
    const ptyObj = makeControllablePty();
    mockPty.spawn.mockReturnValue(ptyObj);

    const created = await createSession("owner/app", "worktree-claude");
    const id = (created as { ok: true; session: { id: string } }).session.id;

    ptyObj.triggerExit(0);
    await flush();

    const resumed = await resumeSession(id);
    expect(resumed.ok).toBe(true);

    expect(mockClaude.createWorktree).toHaveBeenCalledWith(repoA, `claws-wt/${id}`, "sessions");

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

  it("resumeSession on an unknown id returns repo-not-found", async () => {
    const result = await resumeSession("deadbeef");
    expect(result).toMatchObject({ ok: false, reason: "repo-not-found" });
  });

  it("60s reaper does not kill a resumable exited session", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      const mod = await import("./sessions.js");
      const ptyObj = makeControllablePty();
      mockPty.spawn.mockReturnValue(ptyObj);

      const p = mod.createSession("owner/app", "worktree-claude");
      await vi.advanceTimersByTimeAsync(50);
      const result = await p;
      expect(result.ok).toBe(true);
      const id = (result as { ok: true; session: { id: string } }).session.id;

      ptyObj.triggerExit(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(mod.listSessions().find((x) => x.id === id)?.resumable).toBe(true);

      // Advance past the 60s reaper interval — the resumable session must survive.
      await vi.advanceTimersByTimeAsync(61_000);
      const survivor = mod.listSessions().find((x) => x.id === id);
      expect(survivor).toBeDefined();
      expect(survivor?.alive).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("killSession on an alive worktree session removes the worktree and the persisted row", async () => {
    const ptyObj = makeControllablePty();
    mockPty.spawn.mockReturnValue(ptyObj);

    const created = await createSession("owner/app", "worktree-claude");
    const id = (created as { ok: true; session: { id: string } }).session.id;

    expect(killSession(id)).toBe(true);
    expect(mockDb.deletePersistedSession).toHaveBeenCalledWith(id);
    expect(listSessions().find((x) => x.id === id)).toBeUndefined();
    await flush();
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repoA, WT_PATH);
  });
});
