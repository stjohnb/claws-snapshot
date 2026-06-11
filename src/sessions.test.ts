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
  mockClaude: { removeWorktree: vi.fn(), ensureClone: vi.fn(), runClaude: vi.fn() },
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

import { recoverSessions } from "./sessions.js";

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
