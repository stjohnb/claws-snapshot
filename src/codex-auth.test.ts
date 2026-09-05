import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPty, mockLog } = vi.hoisted(() => ({
  mockPty: { spawn: vi.fn() },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node-pty", () => ({ default: mockPty, ...mockPty }));
vi.mock("./log.js", () => mockLog);
vi.mock("./claude.js", () => ({ enrichedPath: (p: string | undefined) => p ?? "" }));

const mockNoteAgentAuthSuccess = vi.hoisted(() => vi.fn());
vi.mock("./agent-auth-state.js", () => ({ noteAgentAuthSuccess: mockNoteAgentAuthSuccess }));
vi.mock("./jobs/auth-secret-sync.js", () => ({ syncAuthSecret: vi.fn().mockResolvedValue(undefined) }));

import { startCodexLogin, getCodexLoginStatus } from "./codex-auth.js";

// A controllable fake IPty whose onData/onExit handlers can be driven manually.
function makeFakePty() {
  const dataHandlers: Array<(d: string) => void> = [];
  const exitHandlers: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  return {
    written: [] as string[],
    killed: false,
    onData: vi.fn((cb: (d: string) => void) => {
      dataHandlers.push(cb);
      return {
        dispose: vi.fn(() => {
          const i = dataHandlers.indexOf(cb);
          if (i !== -1) dataHandlers.splice(i, 1);
        }),
      };
    }),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitHandlers.push(cb);
      return {
        dispose: vi.fn(() => {
          const i = exitHandlers.indexOf(cb);
          if (i !== -1) exitHandlers.splice(i, 1);
        }),
      };
    }),
    write: vi.fn(function (this: { written: string[] }, s: string) {
      this.written.push(s);
    }),
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
    }),
    emitData(d: string) {
      for (const h of dataHandlers) h(d);
    },
    emitExit(exitCode = 0) {
      for (const h of exitHandlers) h({ exitCode });
    },
  };
}

/** The real `codex login --device-auth` transcript, ANSI already stripped. */
const TRANSCRIPT =
  "Follow these steps to sign in with ChatGPT using device code authorization:\r\n" +
  "\r\n" +
  "1. Open this link in your browser and sign in to your account\r\n" +
  "   https://auth.openai.com/codex/device\r\n" +
  "\r\n" +
  "2. Enter this one-time code (expires in 15 minutes)\r\n" +
  "   R1OR-LBCFO\r\n";

describe("codex-auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the device URL and one-time code from the CLI transcript", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startCodexLogin();
    fake.emitData(TRANSCRIPT);
    fake.emitData("Device codes are a common phishing target. Never share this code.\r\n");
    const r = await p;

    expect(r).toEqual({ ok: true, url: "https://auth.openai.com/codex/device", userCode: "R1OR-LBCFO" });
    expect(getCodexLoginStatus().status).toBe("awaiting-authorization");
    expect(mockPty.spawn).toHaveBeenCalledWith(
      "codex",
      ["login", "--device-auth"],
      expect.objectContaining({ cols: 800 }),
    );
  });

  it("marks the login completed and clears the codex auth latch on exit 0", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startCodexLogin();
    fake.emitData(TRANSCRIPT);
    fake.emitData("Never share this code.\r\n");
    await p;

    fake.emitExit(0);

    expect(getCodexLoginStatus().status).toBe("completed");
    expect(getCodexLoginStatus().error).toBeNull();
    expect(mockNoteAgentAuthSuccess).toHaveBeenCalledWith("codex");
  });

  it("marks the login failed with an error on a non-zero exit after the code was shown", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startCodexLogin();
    fake.emitData(TRANSCRIPT);
    fake.emitData("Never share this code.\r\n");
    await p;

    fake.emitData("error: device code expired\r\n");
    fake.emitExit(1);

    const s = getCodexLoginStatus();
    expect(s.status).toBe("failed");
    expect(s.error).toBeTruthy();
    expect(mockNoteAgentAuthSuccess).not.toHaveBeenCalled();
  });

  it("fails the start when codex exits before printing a device code", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startCodexLogin();
    fake.emitData("error: unexpected argument '--device-auth' found\r\n");
    fake.emitExit(2);
    const r = await p;

    expect(r.ok).toBe(false);
    expect(getCodexLoginStatus().status).toBe("failed");
    expect((r as { ok: false; error: string }).error).toContain("--device-auth");
  });

  it("times out and kills the PTY when no device code is printed", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startCodexLogin();
    await vi.advanceTimersByTimeAsync(31_000);
    const r = await p;

    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Timed out/) });
    expect(fake.killed).toBe(true);
  });

  it("kills the previous PTY when a second login is started", async () => {
    const first = makeFakePty();
    mockPty.spawn.mockReturnValue(first);
    const p1 = startCodexLogin();
    first.emitData(TRANSCRIPT);
    first.emitData("Never share this code.\r\n");
    await p1;

    const second = makeFakePty();
    mockPty.spawn.mockReturnValue(second);
    const p2 = startCodexLogin();
    second.emitData(TRANSCRIPT);
    second.emitData("Never share this code.\r\n");
    await p2;

    expect(first.killed).toBe(true);
    expect(second.killed).toBe(false);
  });
});
