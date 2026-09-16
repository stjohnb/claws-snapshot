import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { WebSocket } from "ws";

const { mockSessions, mockUploads } = vi.hoisted(() => ({
  mockSessions: {
    createSession: vi.fn(),
    createMultiWorktreeSession: vi.fn(),
    resumeSession: vi.fn(),
    killSession: vi.fn(),
    deleteSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    recoverSessions: vi.fn(),
    disconnectAllSessions: vi.fn(),
    setSessionDescription: vi.fn(),
    resummarizeSession: vi.fn(),
  },
  mockUploads: {
    saveSessionUpload: vi.fn(),
    saveSessionUploadStream: vi.fn(),
  },
}));

vi.mock("./sessions.js", () => mockSessions);
vi.mock("./session-uploads.js", () => mockUploads);

import { localSessionBackend } from "./session-backend-local.js";
import { getSessionBackend, setSessionBackendForTests, type SessionBackend } from "./session-backend.js";

function fakeWs() {
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  });
  return ws;
}

function fakeSession(overrides: Record<string, unknown> = {}) {
  let onData: ((d: string) => void) | null = null;
  const pty = {
    onData: vi.fn((cb: (d: string) => void) => { onData = cb; return { dispose: vi.fn() }; }),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
  };
  return {
    session: {
      id: "abc", repo: "org/app", cwd: "/w", mode: "repo-claude", provider: "claude", model: null,
      alive: true, exitCode: null, summary: "Doing things", scrollback: "", wsConnected: false, lastActivity: 0,
      pty,
      ...overrides,
    },
    emitData: (d: string) => onData?.(d),
  };
}

describe("localSessionBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is the local-tmux backend and the default from getSessionBackend()", () => {
    expect(localSessionBackend.kind).toBe("local-tmux");
    expect(getSessionBackend()).toBe(localSessionBackend);
  });

  it("setSessionBackendForTests swaps the backend and null restores the local adapter", () => {
    const fake = { kind: "k8s-pod" } as SessionBackend;
    try {
      setSessionBackendForTests(fake);
      expect(getSessionBackend()).toBe(fake);
    } finally {
      setSessionBackendForTests(null);
    }
    expect(getSessionBackend()).toBe(localSessionBackend);
  });

  it("start recovers sessions and shutdown disconnects bridges", async () => {
    await localSessionBackend.start();
    await localSessionBackend.shutdown();
    expect(mockSessions.recoverSessions).toHaveBeenCalledTimes(1);
    expect(mockSessions.disconnectAllSessions).toHaveBeenCalledTimes(1);
  });

  it("create forwards the request and returns only the id on success", async () => {
    mockSessions.createSession.mockResolvedValueOnce({ ok: true, session: { id: "s1", pty: {} } });
    const result = await localSessionBackend.create({ repo: "org/app", mode: "repo-claude", capabilities: ["browser"], provider: "claude", model: "opus" });
    expect(mockSessions.createSession).toHaveBeenCalledWith("org/app", "repo-claude", ["browser"], "claude", "opus");
    expect(result).toEqual({ ok: true, id: "s1" });
  });

  it("create passes failures through unchanged", async () => {
    mockSessions.createSession.mockResolvedValueOnce({ ok: false, reason: "tmux-failed", detail: "boom" });
    expect(await localSessionBackend.create({ repo: null, mode: "home-claude", capabilities: [], provider: "claude", model: null }))
      .toEqual({ ok: false, reason: "tmux-failed", detail: "boom" });
  });

  it("createMulti and resume map to the sessions.ts calls", async () => {
    mockSessions.createMultiWorktreeSession.mockResolvedValueOnce({ ok: true, session: { id: "m1" } });
    expect(await localSessionBackend.createMulti({ repos: ["a/b", "c/d"], capabilities: [], provider: "codex", model: null }))
      .toEqual({ ok: true, id: "m1" });
    expect(mockSessions.createMultiWorktreeSession).toHaveBeenCalledWith(["a/b", "c/d"], [], "codex", null);

    mockSessions.resumeSession.mockResolvedValueOnce({ ok: false, reason: "not-resumable", detail: "r1" });
    expect(await localSessionBackend.resume("r1")).toEqual({ ok: false, reason: "not-resumable", detail: "r1" });
  });

  it("end maps killSession's boolean to ok / not-found", async () => {
    mockSessions.killSession.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await localSessionBackend.end("a")).toEqual({ ok: true });
    expect(await localSessionBackend.end("b")).toEqual({ ok: false, reason: "not-found" });
  });

  it("remove deletes the session", async () => {
    mockSessions.deleteSession.mockResolvedValueOnce(true);
    expect(await localSessionBackend.remove("a")).toEqual({ ok: true });
    expect(mockSessions.deleteSession).toHaveBeenCalledWith("a");
  });

  it("getLive and checkAttach report not-found for an unknown id", async () => {
    mockSessions.getSession.mockReturnValue(undefined);
    expect(await localSessionBackend.getLive("x")).toEqual({ ok: false, reason: "not-found" });
    expect(await localSessionBackend.checkAttach("x")).toEqual({ ok: false, reason: "not-found" });
  });

  it("getLive returns the page-facing fields of a live session", async () => {
    const { session } = fakeSession();
    mockSessions.getSession.mockReturnValue(session);
    expect(await localSessionBackend.getLive("abc")).toEqual({
      ok: true,
      session: { id: "abc", repo: "org/app", cwd: "/w", mode: "repo-claude", provider: "claude", model: null, alive: true, summary: "Doing things" },
    });
    expect(await localSessionBackend.checkAttach("abc")).toEqual({ ok: true });
  });

  it("listLive, setDescription and resummarize delegate to sessions.ts", async () => {
    mockSessions.listSessions.mockReturnValueOnce([{ id: "l1" }]);
    mockSessions.setSessionDescription.mockResolvedValueOnce({ ok: true, description: "d" });
    mockSessions.resummarizeSession.mockResolvedValueOnce({ ok: false, description: null });
    expect(await localSessionBackend.listLive()).toEqual([{ id: "l1" }]);
    expect(await localSessionBackend.setDescription("l1", "d")).toEqual({ ok: true, description: "d" });
    expect(await localSessionBackend.resummarize("l1")).toEqual({ ok: false, description: null });
  });

  it("uploads store straight into the session's upload dir", async () => {
    mockUploads.saveSessionUpload.mockReturnValueOnce({ ok: true, path: "/u/a.png" });
    mockUploads.saveSessionUploadStream.mockResolvedValueOnce({ ok: false, reason: "too-large" });
    const buf = Buffer.from("x");
    const stream = Readable.from([buf]);
    expect(await localSessionBackend.saveUpload("abc", "a.png", buf)).toEqual({ ok: true, path: "/u/a.png" });
    expect(await localSessionBackend.saveUploadStream("abc", "b.bin", stream)).toEqual({ ok: false, reason: "too-large" });
    expect(mockUploads.saveSessionUpload).toHaveBeenCalledWith("abc", "a.png", buf);
    expect(mockUploads.saveSessionUploadStream).toHaveBeenCalledWith("abc", "b.bin", stream);
  });

  describe("attach", () => {
    it("closes the socket when the session vanished after the pre-handshake check", () => {
      mockSessions.getSession.mockReturnValue(undefined);
      const ws = fakeWs();
      localSessionBackend.attach("gone", ws as unknown as WebSocket);
      expect(ws.close).toHaveBeenCalledWith(1008, "Session not found");
    });

    it("replays scrollback, streams output, forwards input and clamps resize", () => {
      const { session, emitData } = fakeSession({ scrollback: "earlier" });
      mockSessions.getSession.mockReturnValue(session);
      const ws = fakeWs();
      localSessionBackend.attach("abc", ws as unknown as WebSocket);

      expect(session.wsConnected).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "scrollback", data: "earlier" }));

      emitData("hi");
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "output", data: "hi" }));

      ws.emit("message", JSON.stringify({ type: "input", data: "ls\r" }));
      expect(session.pty.write).toHaveBeenCalledWith("ls\r");

      ws.emit("message", JSON.stringify({ type: "resize", cols: 9999.7, rows: 0 }));
      expect(session.pty.resize).toHaveBeenCalledWith(500, 1);

      ws.emit("message", "not json");
      ws.emit("message", JSON.stringify({ type: "bogus" }));
      expect(session.pty.write).toHaveBeenCalledTimes(1);

      ws.emit("close");
      expect(session.wsConnected).toBe(false);
    });

    it("sends exit immediately for a session that is no longer alive", () => {
      const { session } = fakeSession({ alive: false, exitCode: 3 });
      mockSessions.getSession.mockReturnValue(session);
      const ws = fakeWs();
      localSessionBackend.attach("abc", ws as unknown as WebSocket);
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "exit", code: 3 }));
      ws.emit("message", JSON.stringify({ type: "input", data: "x" }));
      expect(session.pty.write).not.toHaveBeenCalled();
    });
  });
});
