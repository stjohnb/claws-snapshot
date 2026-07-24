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
vi.mock("./claude.js", () => ({ enrichedPath: (p: string | undefined) => p ?? "" }));

import { startClaudeLogin, submitClaudeLoginCode, getClaudeLoginStatus } from "./claude-auth.js";

// A controllable fake IPty whose onData/onExit handlers can be driven manually.
function makeFakePty() {
  const dataHandlers: Array<(d: string) => void> = [];
  const exitHandlers: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  return {
    written: [] as string[],
    killed: false,
    onData: vi.fn((cb: (d: string) => void) => {
      dataHandlers.push(cb);
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitHandlers.push(cb);
      return { dispose: vi.fn() };
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startClaudeLogin resolves with the URL once an oauth line is emitted", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("Visit https://claude.ai/oauth/authorize?code=abc123 to continue\n");
    const r = await p;

    expect(r).toEqual({ ok: true, url: "https://claude.ai/oauth/authorize?code=abc123" });
    expect(getClaudeLoginStatus().status).toBe("awaiting-code");
  });

  it("spawns the PTY with a wide cols so the URL is not wrapped", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n");
    await p;

    expect(mockPty.spawn).toHaveBeenCalledWith("claude", ["setup-token"], expect.objectContaining({ cols: 800 }));
    expect(mockPty.spawn.mock.calls[0]![2].cols).toBeGreaterThanOrEqual(800);
  });

  it("strips trailing punctuation from the captured URL", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const p = startClaudeLogin();
    fake.emitData("Open (https://claude.ai/oauth/authorize?code=z).\n");
    const r = await p;

    expect(r).toEqual({ ok: true, url: "https://claude.ai/oauth/authorize?code=z" });
  });

  it("submitClaudeLoginCode writes code\\r and persists the token on sk-ant-oat01 output", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n");
    await start;

    const submit = submitClaudeLoginCode("mycode123");
    expect(fake.write).toHaveBeenCalledWith("mycode123\r");

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
  });

  it("upserts the token into an existing env file, preserving other lines", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("OTHER_SECRET=keepme\nCLAUDE_CODE_OAUTH_TOKEN=old\n");
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n");
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
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n");
    await start;

    expect(await submitClaudeLoginCode("   ")).toEqual({ ok: false, error: "Invalid code" });
    expect(await submitClaudeLoginCode("has space")).toEqual({ ok: false, error: "Invalid code" });
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("returns a clean error when submitting a code with no login in progress", async () => {
    // Fresh module state guaranteed by prior tests killing/completing pending;
    // simulate by never starting a login here relative to a killed one.
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);
    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n");
    await start;
    // complete it so status is no longer awaiting-code
    const submit = submitClaudeLoginCode("code");
    fake.emitData("sk-ant-oat01-DONE\n");
    await submit;

    expect(await submitClaudeLoginCode("again")).toEqual({ ok: false, error: "No login in progress" });
  });

  it("getClaudeLoginStatus never exposes the token", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n");
    await start;
    const submit = submitClaudeLoginCode("code");
    fake.emitData("sk-ant-oat01-SECRETTOKEN\n");
    await submit;

    const status = getClaudeLoginStatus();
    expect(JSON.stringify(status)).not.toContain("sk-ant-oat01-SECRETTOKEN");
    expect(status).not.toHaveProperty("token");
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

  it("does not double-append data chunks into the buffer once code submission is in flight", async () => {
    const fake = makeFakePty();
    mockPty.spawn.mockReturnValue(fake);

    const start = startClaudeLogin();
    fake.emitData("https://claude.ai/oauth/authorize?x=1\n");
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
});
