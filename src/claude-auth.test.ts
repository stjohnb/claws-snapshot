import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPty, mockFs, mockLog } = vi.hoisted(() => ({
  mockPty: { spawn: vi.fn() },
  mockFs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node-pty", () => ({ default: mockPty, ...mockPty }));
vi.mock("node:fs", () => ({ default: mockFs, ...mockFs }));
vi.mock("./log.js", () => mockLog);
vi.mock("./cli-path.js", () => ({ enrichedPath: (p: string | undefined) => p ?? "" }));
vi.mock("./config.js", () => ({ DASHBOARD_URL: "https://claws.example.com" }));
vi.mock("./slack.js", () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

const mockNoteAgentAuthSuccess = vi.hoisted(() => vi.fn());
vi.mock("./agent-auth-state.js", () => ({ noteAgentAuthSuccess: mockNoteAgentAuthSuccess }));
const mockSyncAuthSecret = vi.hoisted(() => vi.fn());
vi.mock("./jobs/auth-secret-sync.js", () => ({ syncAuthSecret: mockSyncAuthSecret }));

import { startClaudeLogin, submitClaudeLoginCode, getClaudeLoginStatus } from "./claude-auth.js";

/**
 * The paste prompt exactly as Claude Code 2.1.269+ emits it: words are placed
 * with cursor-column escapes, not spaces, so the stripped text has no spaces.
 */
const PROMPT =
  "\r\r\n\r\r\n\u001b[2GPaste\u001b[8Gcode\u001b[13Ghere\u001b[18Gif\u001b[21Gprompted\u001b[30G>\r\r\n\u001b[>0q\u001b[?u\u001b[c";

/** A realistic-length `code#state` — long enough that the CLI treats a combined write as a paste. */
const LONG_CODE = `${"a1B2c3D4".repeat(8)}#${"e5F6g7H8".repeat(5)}`;

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

describe("claude-auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    mockFs.existsSync.mockReturnValue(false);
    mockSyncAuthSecret.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startClaudeLogin resolves with the URL once an oauth line is emitted", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("Visit https://claude.ai/oauth/authorize?code=abc123 to continue\n" + PROMPT);
    const r = await p;

    expect(r).toEqual({ ok: true, url: "https://claude.ai/oauth/authorize?code=abc123" });
    expect(getClaudeLoginStatus().status).toBe("awaiting-code");
  });

  it("spawns the PTY with a wide cols so the URL is not wrapped", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await p;

    expect(mockPty.spawn).toHaveBeenCalledWith("claude", ["setup-token"], expect.objectContaining({ cols: 800 }));
    expect(mockPty.spawn.mock.calls[0]![2].cols).toBeGreaterThanOrEqual(800);
  });

  it("strips trailing punctuation from the captured URL", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("Open (https://claude.ai/oauth/authorize?code=z).\n" + PROMPT);
    const r = await p;

    expect(r).toEqual({ ok: true, url: "https://claude.ai/oauth/authorize?code=z" });
  });

  it("submitClaudeLoginCode writes the code, then Enter after its echo, and persists the token on sk-ant-oat01 output", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode("mycode123");
    expect(fake.written).toEqual(["mycode123"]);
    fake.emitData("*****e123\r\r\n");
    expect(fake.written).toEqual(["mycode123", "\r"]);

    fake.emitData("Success! Token: sk-ant-oat01-ABCdef_-123\n");
    const r = await submit;

    expect(r).toEqual({ ok: true });
    expect(process.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-ABCdef_-123");
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, contents, opts] = mockFs.writeFileSync.mock.calls[0]!;
    expect(String(writtenPath)).toMatch(/\.claws\/env$/);
    expect(contents).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-ABCdef_-123");
    expect(opts).toEqual({ mode: 0o600 });
    expect(mockFs.chmodSync).toHaveBeenCalledWith(writtenPath, 0o600);
    expect(mockNoteAgentAuthSuccess).toHaveBeenCalledTimes(1);
    expect(mockSyncAuthSecret).toHaveBeenCalledTimes(1);
    expect(getClaudeLoginStatus().lastAttempt).toMatchObject({ status: "completed", phase: "submit", message: null });
  });

  it("upserts the token into an existing env file, preserving other lines", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("OTHER_SECRET=keepme\nCLAUDE_CODE_OAUTH_TOKEN=old\n");
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode("code");
    fake.emitData("sk-ant-oat01-NEWTOKEN\n");
    await submit;

    const contents = mockFs.writeFileSync.mock.calls[0]![1] as string;
    expect(contents).toContain("OTHER_SECRET=keepme");
    expect(contents).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-NEWTOKEN");
    expect(contents).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=old");
  });

  it("rejects an empty or whitespace-containing code without writing", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    expect(await submitClaudeLoginCode("   ")).toEqual({ ok: false, error: "Invalid code", retryable: true });
    expect(await submitClaudeLoginCode("has space")).toEqual({ ok: false, error: "Invalid code", retryable: true });
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("returns a clean error when submitting a code with no login in progress", async () => {
    // Fresh module state guaranteed by prior tests killing/completing pending;
    // simulate by never starting a login here relative to a killed one.
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);
    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;
    // complete it so status is no longer awaiting-code
    const submit = submitClaudeLoginCode("code");
    fake.emitData("sk-ant-oat01-DONE\n");
    await submit;

    expect(await submitClaudeLoginCode("again")).toEqual({
      ok: false,
      error: "No login in progress",
      retryable: false,
    });
  });

  it("getClaudeLoginStatus never exposes the token", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;
    const submit = submitClaudeLoginCode("code");
    fake.emitData("sk-ant-oat01-SECRETTOKEN\n");
    await submit;

    const status = getClaudeLoginStatus();
    expect(JSON.stringify(status)).not.toContain("sk-ant-oat01-SECRETTOKEN");
    expect(status).not.toHaveProperty("token");
  });

  it("resolves with ok: false instead of throwing when pty.spawn throws", async () => {
    mockPty.spawn.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const r = await startClaudeLogin();

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Failed to start login");
    expect(getClaudeLoginStatus().lastAttempt).toMatchObject({ phase: "start", status: "failed" });
  });

  it("startClaudeLogin resolves with an error if the process exits before a URL", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("some error output\n");
    fake.emitExit(1);
    const r = await p;

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("some error output");
  });

  it("redacts tokens from a start failure's error and lastAttempt", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("unexpected sk-ant-oat01-LEAKED7 output\n");
    fake.emitExit(1);
    const r = await p;

    expect(r.ok).toBe(false);
    const { url: _url, ...rest } = getClaudeLoginStatus();
    expect(JSON.stringify([r, rest])).not.toContain("LEAKED7");
    expect(rest.lastAttempt).toMatchObject({ status: "failed", phase: "start" });
  });

  it("does not double-append data chunks into the buffer once code submission is in flight", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode("code");
    fake.emitData("still working\n");
    fake.emitExit(1);
    const r = await submit;

    expect(r.ok).toBe(false);
    if (!r.ok) {
      const occurrences = r.error.split("still working").length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("surfaces a fatal CLI error immediately, without waiting for the timeout", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode("code#state");
    fake.emitData("OAuth error: Request failed with status code 400\r\nPress Enter to retry.\r\n");
    const r = await submit;

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.error).toContain("OAuth error: Request failed with status code 400");
    }
    expect(fake.killed).toBe(true);
    expect(getClaudeLoginStatus().status).toBe("failed");
  });

  it("kills the session on an invalid-code error so a fresh URL must be minted", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode("badcode");
    fake.emitData("OAuth error: Invalid code. Please make sure the full code was copied\r\nPress Enter to retry.\r\n");
    const r = await submit;

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.error).toContain("no longer valid");
    }
    expect(fake.killed).toBe(true);
    expect(getClaudeLoginStatus().status).toBe("failed");
  });

  it("strips spinner/redraw noise from the timeout tail", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode("code#state");
    fake.emitData("Still negotiating with the server\r\n");
    fake.emitData("\r✢\r\r\n\r*\r\r\n\r✻\r\r\n".repeat(200));
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await submit;

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Still negotiating with the server");
      expect(r.error).not.toContain("****");
    }
  });

  it("carries the CLI output tail on a genuine timeout", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode("code#state");
    fake.emitData("still waiting for you\r\n");
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await submit;

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Timed out");
      expect(r.error).toContain("still waiting for you");
    }
  });

  it("does not capture a URL split across PTY reads before it is complete", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("https://claude.com/cai/oauth/authorize?code=true&state=ab");

    const sentinel = Symbol("pending");
    const race = await Promise.race([p, Promise.resolve(sentinel)]);
    expect(race).toBe(sentinel);

    fake.emitData("cdef\r\n" + PROMPT);
    const r = await p;

    expect(r).toEqual({
      ok: true,
      url: "https://claude.com/cai/oauth/authorize?code=true&state=abcdef",
    });
  });

  // #3022: a real `code#state` written together with its `\r` is read by the
  // CLI as a paste — it echoes the masked code but swallows the Enter, so the
  // code is never exchanged and the submit times out.
  it("writes a long code and the Enter key in separate PTY writes once the code is echoed", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.com/cai/oauth/authorize?code=true&state=abc\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode(LONG_CODE);
    expect(fake.written).toEqual([LONG_CODE]);

    fake.emitData(`\r[31C[1A${"*".repeat(LONG_CODE.length - 6)}${LONG_CODE.slice(-6)}\r\r\n`);
    expect(fake.written).toEqual([LONG_CODE, "\r"]);

    fake.emitData("sk-ant-oat01-LONGCODEOK\r\n");
    expect(await submit).toEqual({ ok: true });
  });

  it("does not send Enter on post-submit output that is not the code echo", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode(LONG_CODE);
    fake.emitData("\u001b[?25l");
    fake.emitData("\r✢\r\r\n\r*\r\r\n");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fake.written).toEqual([LONG_CODE]);

    fake.emitData(`${"*".repeat(LONG_CODE.length - 6)}${LONG_CODE.slice(-6)}\r\r\n`);
    expect(fake.written).toEqual([LONG_CODE, "\r"]);

    fake.emitData("sk-ant-oat01-AFTERNOISE\r\n");
    expect(await submit).toEqual({ ok: true });
  });

  it("sends Enter after a fallback delay when the CLI does not echo the code", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode(LONG_CODE);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fake.written).toEqual([LONG_CODE]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.written).toEqual([LONG_CODE, "\r"]);

    // A late code echo after the fallback already sent Enter must not send a second one.
    fake.emitData(`${"*".repeat(LONG_CODE.length - 6)}${LONG_CODE.slice(-6)}\r\r\n`);
    expect(fake.written).toEqual([LONG_CODE, "\r"]);

    fake.emitData("sk-ant-oat01-FALLBACK\r\n");
    expect(await submit).toEqual({ ok: true });
  });

  it("does not return the URL until the CLI's paste prompt has been printed", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("Browser didn't open? Use the url below\r\n\r\nhttps://claude.ai/oauth/authorize?x=1\r\n\r\n");

    const sentinel = Symbol("pending");
    expect(await Promise.race([p, Promise.resolve(sentinel)])).toBe(sentinel);
    expect(getClaudeLoginStatus().status).toBe("awaiting-url");
    expect(await submitClaudeLoginCode("code")).toEqual({
      ok: false,
      error: "No login in progress",
      retryable: false,
    });
    expect(fake.write).not.toHaveBeenCalled();

    fake.emitData(PROMPT);
    expect(await p).toEqual({ ok: true, url: "https://claude.ai/oauth/authorize?x=1" });
    expect(getClaudeLoginStatus().status).toBe("awaiting-code");
  });

  it("fails with a prompt-specific error when the URL appears but the paste prompt never does", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("https://claude.com/cai/oauth/authorize?code=true&code_challenge=CHAL&state=STATE1\r\n");
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;

    expect(r).toEqual({ ok: false, error: "Timed out waiting for Claude paste prompt after login URL" });
    expect(fake.killed).toBe(true);
    const status = getClaudeLoginStatus();
    expect(status.status).toBe("failed");
    expect(status.url).toBeNull();
    expect(status.lastAttempt).toMatchObject({ status: "failed", phase: "start", promptReady: false });
    expect(JSON.stringify([status.error, status.lastAttempt])).not.toMatch(/https:|CHAL|STATE1/);
  });

  it("keeps the failed submit as lastAttempt after a fresh login replaces it", async () => {
    const first = makeFakePty();
    mockPty.spawn.mockReturnValue(first);
    const start1 = startClaudeLogin();
    first.emitData("https://claude.com/cai/oauth/authorize?code=true&state=FIRSTSTATE\n" + PROMPT);
    await start1;

    const submit = submitClaudeLoginCode(LONG_CODE);
    first.emitData(`${"*".repeat(LONG_CODE.length - 6)}${LONG_CODE.slice(-6)}\r\r\n`);
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await submit;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.error).toContain("Timed out completing login");
      expect(r.error).toContain("[masked code]");
      expect(r.error).not.toContain(LONG_CODE.slice(-6));
    }
    const failedId = getClaudeLoginStatus().lastAttempt!.attemptId;

    // The page's automatic retry.
    const second = makeFakePty();
    mockPty.spawn.mockReturnValue(second);
    const start2 = startClaudeLogin();
    second.emitData("https://claude.com/cai/oauth/authorize?code=true&state=SECONDSTATE\n" + PROMPT);
    await start2;

    const status = getClaudeLoginStatus();
    expect(status.status).toBe("awaiting-code");
    expect(status.error).toBeNull();
    expect(status.url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=SECONDSTATE");
    expect(status.lastAttempt).toMatchObject({
      attemptId: failedId,
      status: "failed",
      phase: "submit",
      promptReady: true,
    });
    expect(status.lastAttempt!.message).toContain("Timed out completing login");
    expect(status.lastAttempt!.supersededByAttemptId).toBeGreaterThan(failedId);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining(`attempt ${failedId} submit failed`));

    const { url: _activeUrl, ...rest } = status;
    expect(JSON.stringify(rest)).not.toMatch(/https:|FIRSTSTATE|SECONDSTATE|sk-ant-oat01-|code_challenge=|state=/);
  });

  it("keeps the failed submit in lastFailedSubmit when the automatic retry also fails", async () => {
    const first = makeFakePty();
    mockPty.spawn.mockReturnValue(first);
    const start1 = startClaudeLogin();
    first.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start1;

    const submit = submitClaudeLoginCode(LONG_CODE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await submit).ok).toBe(false);
    const failedId = getClaudeLoginStatus().lastFailedSubmit!.attemptId;

    // The page's automatic retry prints a URL but never its paste prompt.
    const second = makeFakePty();
    mockPty.spawn.mockReturnValue(second);
    const start2 = startClaudeLogin();
    second.emitData("https://claude.ai/oauth/authorize?x=2\n");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await start2).toEqual({ ok: false, error: "Timed out waiting for Claude paste prompt after login URL" });

    const status = getClaudeLoginStatus();
    expect(status.status).toBe("failed");
    expect(status.lastAttempt).toMatchObject({ phase: "start", status: "failed" });
    expect(status.lastFailedSubmit).toMatchObject({ attemptId: failedId, status: "failed", phase: "submit" });
    expect(status.lastFailedSubmit!.message).toContain("Timed out completing login");
    expect(status.lastFailedSubmit!.supersededByAttemptId).toBeGreaterThan(failedId);

    // A later successful login clears it.
    const third = makeFakePty();
    mockPty.spawn.mockReturnValue(third);
    const start3 = startClaudeLogin();
    third.emitData("https://claude.ai/oauth/authorize?x=3\n" + PROMPT);
    await start3;
    const submit3 = submitClaudeLoginCode("code");
    third.emitData("sk-ant-oat01-THIRD\r\n");
    expect(await submit3).toEqual({ ok: true });
    expect(getClaudeLoginStatus().lastFailedSubmit).toBeNull();
  });

  it("records an abandoned attempt as superseded before any code was submitted", async () => {
    const first = makeFakePty();
    mockPty.spawn.mockReturnValue(first);
    const start1 = startClaudeLogin();
    first.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start1;

    const second = makeFakePty();
    mockPty.spawn.mockReturnValue(second);
    const start2 = startClaudeLogin();
    expect(first.killed).toBe(true);
    // The killed PTY's late exit must not overwrite the snapshot.
    first.emitExit(1);
    second.emitData("https://claude.ai/oauth/authorize?x=2\n" + PROMPT);
    await start2;

    expect(getClaudeLoginStatus().lastAttempt).toMatchObject({
      status: "superseded",
      phase: "start",
      message: expect.stringContaining("before a code was submitted"),
    });
  });

  it("supersedes a login while a code submission is in flight, recording it as a superseded submit in lastFailedSubmit", async () => {
    const first = makeFakePty();
    mockPty.spawn.mockReturnValue(first);
    const start1 = startClaudeLogin();
    first.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start1;

    const submit = submitClaudeLoginCode(LONG_CODE);

    const second = makeFakePty();
    mockPty.spawn.mockReturnValue(second);
    const start2 = startClaudeLogin();

    const firstId = getClaudeLoginStatus().lastAttempt!.attemptId;
    const supersededByAttemptId = getClaudeLoginStatus().lastAttempt!.supersededByAttemptId;
    expect(supersededByAttemptId).toBeGreaterThan(firstId);
    expect(getClaudeLoginStatus().lastAttempt).toMatchObject({
      attemptId: firstId,
      status: "superseded",
      phase: "submit",
      supersededByAttemptId,
    });
    expect(getClaudeLoginStatus().lastFailedSubmit).toMatchObject({
      attemptId: firstId,
      status: "superseded",
      phase: "submit",
      supersededByAttemptId,
    });

    // The killed PTY's late exit must run the submit's fail() without
    // overwriting the new attempt's snapshot, since `pending` now points at
    // the second attempt.
    first.emitExit(1);
    expect((await submit).ok).toBe(false);
    expect(getClaudeLoginStatus().lastAttempt).toMatchObject({
      attemptId: firstId,
      status: "superseded",
      phase: "submit",
      supersededByAttemptId,
    });

    second.emitData("https://claude.ai/oauth/authorize?x=2\n" + PROMPT);
    await start2;
  });

  it("clears a stale lastFailedSubmit once the attempt that superseded it is itself abandoned and replaced", async () => {
    // Attempt 1 fails during submit.
    const first = makeFakePty();
    mockPty.spawn.mockReturnValue(first);
    const start1 = startClaudeLogin();
    first.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start1;
    const submit1 = submitClaudeLoginCode(LONG_CODE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await submit1).ok).toBe(false);
    expect(getClaudeLoginStatus().lastFailedSubmit).not.toBeNull();

    // Attempt 2, the page's automatic retry, starts but is abandoned — no code is ever submitted.
    const second = makeFakePty();
    mockPty.spawn.mockReturnValue(second);
    const start2 = startClaudeLogin();
    second.emitData("https://claude.ai/oauth/authorize?x=2\n" + PROMPT);
    await start2;

    // Days later, clicking "Start login" again supersedes attempt 2 before it
    // ever had a code submitted — the stale attempt-1 failure must not resurface.
    const third = makeFakePty();
    mockPty.spawn.mockReturnValue(third);
    const start3 = startClaudeLogin();
    third.emitData("https://claude.ai/oauth/authorize?x=3\n" + PROMPT);
    await start3;

    expect(getClaudeLoginStatus().lastFailedSubmit).toBeNull();
  });

  it("redacts URLs and PKCE parameters from fatal-error diagnostics", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n" + PROMPT);
    await start;

    const submit = submitClaudeLoginCode("code#state");
    fake.emitData(
      "OAuth error: redirect https://claude.com/cai/oauth/authorize?code_challenge=CHALLENGE9&state=STATE9 " +
        "code_challenge=LOOSE9 state=LOOSESTATE9\r\n"
    );
    const r = await submit;

    expect(r.ok).toBe(false);
    const lastAttempt = getClaudeLoginStatus().lastAttempt!;
    for (const text of [r.ok ? "" : r.error, lastAttempt.message!]) {
      expect(text).toContain("OAuth error:");
      expect(text).toContain("[URL REDACTED]");
      expect(text).toContain("code_challenge=[REDACTED]");
      expect(text).not.toMatch(/https:|CHALLENGE9|STATE9|LOOSE9|LOOSESTATE9/);
    }
    for (const [msg] of mockLog.warn.mock.calls) {
      expect(String(msg)).not.toMatch(/https:|CHALLENGE9|STATE9|LOOSE9/);
    }
  });
});
