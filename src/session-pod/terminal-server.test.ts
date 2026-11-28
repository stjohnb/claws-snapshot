import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { AUTO_COMPACT_CHECK_INTERVAL_MS, maybeAutoCompact } from "../session-auto-compact.js";
import { MAX_UPLOAD_BYTES, UPLOAD_REQUEST_TIMEOUT_MS } from "../session-uploads-core.js";
import {
  DEFAULT_COMMAND,
  INPUT_BUFFER_NAME,
  INPUT_MAX_BYTES,
  isAuthorized,
  NOTIFY_MAX_BYTES,
  NOTIFY_SUBMIT_DELAY_MS,
  createTmuxRunner,
  EXIT_CONFIRM_DELAY_MS,
  EXIT_CONFIRM_RETRIES,
  isProcessAlive,
  parsePaneIdentity,
  parsePaneState,
  podExitCode,
  purgeUploadDir,
  readTranscriptChunk,
  TRANSCRIPT_REPLY_MAX_BYTES,
  TRANSCRIPT_SLIM_LINE_BYTES,
  TRANSCRIPT_SLIM_STRING_CHARS,
  TRANSCRIPT_TAIL_BYTES,
  slimTranscriptLine,
  startTerminalServer,
  terminalColorEnv,
  TerminalServerStartError,
  type MountedGrants,
  defaultScratchRoot,
  type PtyLike,
  type TerminalServer,
  type TmuxResult,
  type TranscriptChunk,
} from "./terminal-server.js";

vi.mock("../session-auto-compact.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../session-auto-compact.js")>(),
  maybeAutoCompact: vi.fn(async () => "skipped"),
}));

const TOKEN = "a".repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function fakeTmux(initial: { exists: boolean; createFails?: boolean }) {
  const state = {
    exists: initial.exists,
    /** Exit status of the session's process once its pane is dead (remain-on-exit), else null. */
    deadStatus: null as number | null,
    /** A second, hand-opened pane: its dead status (null while it runs), and whether it is the active one. */
    sidePane: null as { deadStatus: number | null; active: boolean } | null,
    /** Pane id tmux reports for the session process, or "" when it reports none. */
    agentPaneId: "%0",
    /** The session process's pid, as `#{pane_pid}` reports it. */
    agentPid: 4242,
    /** Answers the next agent-pane queries get before the normal one: exit code and stdout as given. */
    paneAnswers: [] as TmuxResult[],
    calls: [] as string[][],
    /** Standard input passed with each call that had one. */
    stdins: [] as string[],
    /** tmux subcommands that fail. */
    failing: new Set<string>(),
    resizeWindowFails: false,
    scrollback: "line one\nline two\n",
    captureGate: null as Promise<void> | null,
  };
  const one = async (args: string[]): Promise<TmuxResult> => {
    if (state.failing.has(args[0]!)) return { code: 1, stdout: "", stderr: "boom" };
    switch (args[0]) {
      case "resize-window": return { code: state.resizeWindowFails ? 1 : 0, stdout: "", stderr: state.resizeWindowFails ? "boom" : "" };
      case "has-session": return { code: state.exists ? 0 : 1, stdout: "", stderr: "" };
      case "display-message": {
        if (args.at(-1) === "#{pane_width} #{pane_height}") return state.exists ? { code: 0, stdout: "132 43\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
        if (args.at(-1) !== "#{pane_id} #{pane_dead} #{pane_dead_status}") return { code: 0, stdout: "", stderr: "" };
        const answer = state.paneAnswers.shift();
        if (answer) return answer;
        if (!state.exists) return { code: 1, stdout: "", stderr: "no server running" };
        // Like tmux, a target of the session (not a pane id) resolves to the active pane.
        const side = args[3] !== "%0" && state.sidePane?.active ? state.sidePane : null;
        const [id, dead] = side ? ["%1", side.deadStatus] : ["%0", state.deadStatus];
        return { code: 0, stdout: dead === null ? `${id} 0 \n` : `${id} 1 ${dead}\n`, stderr: "" };
      }
      case "list-panes": return { code: 0, stdout: state.agentPaneId ? `${state.agentPaneId} ${state.agentPid}\n` : "", stderr: "" };
      case "new-session":
        if (initial.createFails) return { code: 1, stdout: "", stderr: "no server" };
        state.exists = true;
        return { code: 0, stdout: state.agentPaneId ? `${state.agentPaneId} ${state.agentPid}\n` : "", stderr: "" };
      case "capture-pane":
        await state.captureGate;
        return state.exists ? { code: 0, stdout: state.scrollback, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      case "kill-server": state.exists = false; return { code: 0, stdout: "", stderr: "" };
      default: return { code: 0, stdout: "", stderr: "" };
    }
  };
  const run = vi.fn(async (args: string[], stdin?: string): Promise<TmuxResult> => {
    state.calls.push(args);
    if (stdin !== undefined) state.stdins.push(stdin);
    // Like tmux, `a ; b ; c` runs each command in turn and stops at the first failure.
    const commands: string[][] = [[]];
    for (const arg of args) {
      if (arg === ";") commands.push([]);
      else commands.at(-1)!.push(arg);
    }
    let result: TmuxResult = { code: 0, stdout: "", stderr: "" };
    for (const command of commands) {
      result = await one(command);
      if (result.code !== 0) break;
    }
    return result;
  });
  return { state, run };
}

function fakePtyFactory() {
  const ptys: Array<PtyLike & { emitData(d: string): void; emitExit(code: number): void; written: string[]; resizes: number[][]; killed: boolean; args: string[]; size: number[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const factory = vi.fn((_file: string, args: string[], opts: { cols: number; rows: number; env?: NodeJS.ProcessEnv }) => {
    let dataCb: ((d: string) => void) | null = null;
    let exitCb: ((e: { exitCode: number }) => void) | null = null;
    const p = {
      args,
      env: opts.env,
      size: [opts.cols, opts.rows],
      written: [] as string[],
      resizes: [] as number[][],
      killed: false,
      onData: (cb: (d: string) => void) => { dataCb = cb; return { dispose() {} }; },
      onExit: (cb: (e: { exitCode: number }) => void) => { exitCb = cb; return { dispose() {} }; },
      write(d: string) { p.written.push(d); },
      resize(c: number, r: number) { p.resizes.push([c, r]); },
      kill() { p.killed = true; },
      emitData(d: string) { dataCb?.(d); },
      emitExit(code: number) { exitCb?.({ exitCode: code }); },
    };
    ptys.push(p);
    return p;
  });
  return { ptys, factory };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("isAuthorized", () => {
  it("accepts only the exact bearer token", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, () => `${TOKEN}\n`)).toBe(true);
    expect(isAuthorized(`Bearer ${TOKEN}x`, () => TOKEN)).toBe(false);
    expect(isAuthorized(TOKEN, () => TOKEN)).toBe(false);
    expect(isAuthorized(undefined, () => TOKEN)).toBe(false);
  });

  it("fails closed when the token is empty or unreadable", () => {
    expect(isAuthorized("Bearer ", () => "")).toBe(false);
    expect(isAuthorized("Bearer x", () => { throw new Error("ENOENT"); })).toBe(false);
  });
});

describe("startTerminalServer", () => {
  let uploadDir: string;
  let server: TerminalServer | null;
  let exits: number[];
  /** What the injected `isProcessAlive` answers, and the pids it was asked about. */
  let agentAlive: boolean;
  let aliveChecks: number[];
  let tmux: ReturnType<typeof fakeTmux>;
  let pty: ReturnType<typeof fakePtyFactory>;
  const openSockets: WebSocket[] = [];

  async function start(opts: { cwd?: string; home?: string; exists?: boolean; createFails?: boolean; pollIntervalMs?: number; autoCompact?: { idleMs: number; claudeHome: string }; exitReportUrl?: string; inspectGrants?: () => MountedGrants; scratchRoots?: string[]; sleep?: (ms: number) => Promise<void> } = {}) {
    tmux = fakeTmux({ exists: opts.exists ?? false, createFails: opts.createFails });
    pty = fakePtyFactory();
    server = await startTerminalServer({
      sessionId: "abc",
      cwd: opts.cwd ?? "/home/claws/work/org/app",
      command: ["claude", "--dangerously-skip-permissions"],
      uploadDir,
      home: opts.home ?? uploadDir,
      scratchRoots: opts.scratchRoots ?? [],
      readToken: () => TOKEN,
      tmux: tmux.run,
      spawnPty: pty.factory,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: opts.pollIntervalMs ?? 60_000,
      onExit: (code) => exits.push(code),
      ...(opts.autoCompact ? { autoCompact: opts.autoCompact } : {}),
      ...(opts.exitReportUrl ? { exitReportUrl: opts.exitReportUrl } : {}),
      ...(opts.inspectGrants ? { inspectGrants: opts.inspectGrants } : {}),
      sleep: opts.sleep ?? (async () => {}),
      isProcessAlive: (pid) => { aliveChecks.push(pid); return agentAlive; },
    });
    return `http://127.0.0.1:${server.port}`;
  }

  function connect(base: string, headers: Record<string, string> = AUTH) {
    const ws = new WebSocket(`${base.replace("http", "ws")}/pty`, { headers });
    openSockets.push(ws);
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    const closed = new Promise<{ code: number }>((resolve) => ws.on("close", (code) => resolve({ code })));
    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on("error", reject);
    });
    return { ws, messages, closed, opened };
  }

  beforeEach(() => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-server-test-"));
    exits = [];
    agentAlive = true;
    aliveChecks = [];
    server = null;
  });

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) ws.terminate();
    if (server) await server.shutdown();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  /** The one tmux call that starts the server, sets the global options and creates the session. */
  const CREATE_CALL = [
    "start-server", ";",
    "set-option", "-g", "remain-on-exit", "on", ";",
    "set-option", "-sa", "terminal-features", ",xterm-256color:RGB", ";",
    "new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-s", "claws-abc", "-x", "120", "-y", "40", "-c", "/home/claws/work/org/app",
    "claude", "--dangerously-skip-permissions",
  ];

  it("creates the tmux session with size and options when absent, in one call so the global options find a server", async () => {
    await start();
    expect(tmux.state.calls).toContainEqual(CREATE_CALL);
    // A bare start-server exits with no sessions, so no option is set in a call of its own.
    expect(tmux.state.calls).not.toContainEqual(["start-server"]);
    expect(tmux.state.calls).not.toContainEqual(["set-option", "-g", "remain-on-exit", "on"]);
    // `=name:` targets the session; a bare `=name` is "no such session".
    expect(tmux.state.calls).toContainEqual(["set-option", "-t", "=claws-abc:", "mouse", "on"]);
    expect(tmux.state.calls).toContainEqual(["set-option", "-t", "=claws-abc:", "set-clipboard", "on"]);
    // New panes must be non-login shells so /etc/profile cannot drop the gh shim from PATH.
    expect(tmux.state.calls).toContainEqual(["set-option", "-t", "=claws-abc:", "default-command", DEFAULT_COMMAND]);
  });

  it("sets remain-on-exit globally before creating the session so an instant crash keeps a dead pane", async () => {
    await start();
    const createArgs = CREATE_CALL.join(" ");
    expect(createArgs.indexOf("set-option -g remain-on-exit on")).toBeGreaterThan(createArgs.indexOf("start-server"));
    expect(createArgs.indexOf("new-session")).toBeGreaterThan(createArgs.indexOf("set-option -g remain-on-exit on"));
    const names = tmux.state.calls.map((c) => c.join(" "));
    const created = names.indexOf(createArgs);
    expect(created).toBeGreaterThanOrEqual(0);
    // Then narrowed to the agent pane, so hand-opened panes close normally.
    const pane = names.indexOf("set-option -p -t %0 remain-on-exit on");
    expect(pane).toBeGreaterThan(created);
    expect(names.indexOf("set-option -gu remain-on-exit")).toBeGreaterThan(pane);
  });

  it("keeps remain-on-exit global and watches the active pane when tmux reports no pane id", async () => {
    tmux = fakeTmux({ exists: false });
    tmux.state.agentPaneId = "";
    pty = fakePtyFactory();
    server = await startTerminalServer({
      sessionId: "abc", cwd: "/tmp", command: ["claude"], uploadDir, home: uploadDir, readToken: () => TOKEN,
      tmux: tmux.run, spawnPty: pty.factory, host: "127.0.0.1", port: 0, pollIntervalMs: 20,
      onExit: (code) => exits.push(code),
    });
    const names = tmux.state.calls.map((c) => c.join(" "));
    expect(names).not.toContain("set-option -gu remain-on-exit");
    tmux.state.deadStatus = 4;
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([4]);
  });

  it("raises requestTimeout so large streamed uploads are not cut off", async () => {
    const createServer = vi.spyOn(http, "createServer");
    try {
      await start();
      const created = createServer.mock.results[0].value as http.Server;
      expect(created.requestTimeout).toBe(UPLOAD_REQUEST_TIMEOUT_MS);
    } finally {
      createServer.mockRestore();
    }
  });

  it("tells tmux the browser terminal supports RGB, only when creating the server's session", async () => {
    await start();
    const createArgs = tmux.state.calls.find((c) => c.includes("new-session"))!.join(" ");
    const feature = createArgs.indexOf("set-option -sa terminal-features ,xterm-256color:RGB");
    expect(feature).toBeGreaterThan(createArgs.indexOf("start-server"));
    expect(feature).toBeLessThan(createArgs.indexOf("new-session"));
  });

  it("does not append terminal-features again for an existing session", async () => {
    await start({ exists: true });
    expect(tmux.state.calls.some((c) => c.includes("terminal-features"))).toBe(false);
  });

  it("attaches ptys with true-color environment variables", async () => {
    const base = await start();
    const client = connect(base);
    await client.opened;
    await waitFor(() => pty.ptys.length === 1);
    expect(pty.ptys[0].env).toMatchObject({ COLORTERM: "truecolor", CLAUDE_CODE_TMUX_TRUECOLOR: "1", TERM: "xterm-256color" });
  });

  it("terminalColorEnv adds both keys without dropping existing ones", () => {
    expect(terminalColorEnv({ HOME: "/h" })).toEqual({ HOME: "/h", COLORTERM: "truecolor", CLAUDE_CODE_TMUX_TRUECOLOR: "1" });
  });

  it("does not recreate an existing tmux session", async () => {
    await start({ exists: true });
    expect(tmux.state.calls.map((c) => c[0])).not.toContain("new-session");
    // The agent pane is the first pane of window 0.
    expect(tmux.state.calls).toContainEqual(["list-panes", "-t", "=claws-abc:0", "-F", "#{pane_id} #{pane_pid}"]);
  });

  it("rejects when tmux cannot create the session", async () => {
    await expect(start({ createFails: true })).rejects.toBeInstanceOf(TerminalServerStartError);
  });

  it("rejects on a create failure without posting an exit report when exitReportUrl is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(start({ createFails: true })).rejects.toThrow("tmux new-session failed");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("serves /healthz without auth: 200 while tmux exists and while a query is unclear", async () => {
    const base = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    // One failed query must not drop the pod from its Service.
    tmux.state.exists = false;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    tmux.state.paneAnswers.push({ code: 0, stdout: "", stderr: "" });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("serves /healthz 503 once the session's pane is dead", async () => {
    const base = await start();
    tmux.state.deadStatus = 1;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });

  it("requires the bearer token for everything else", async () => {
    const base = await start();
    expect((await fetch(`${base}/scrollback`)).status).toBe(401);
    expect((await fetch(`${base}/scrollback`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/usage`)).status).toBe(401);
    expect((await fetch(`${base}/uploads?name=a.txt`, { method: "POST", body: "hi" })).status).toBe(401);
    expect((await fetch(`${base}/grants`)).status).toBe(401);
    expect((await fetch(`${base}/notify`, { method: "POST", body: "hi" })).status).toBe(401);
    expect((await fetch(`${base}/transcript`)).status).toBe(401);
    expect((await fetch(`${base}/input`, { method: "POST", body: "hi" })).status).toBe(401);
    expect(tmux.state.calls.some((c) => c[0] === "send-keys")).toBe(false);
    await expect(connect(base, {}).opened).rejects.toThrow("HTTP 401");
    expect(pty.factory).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated /pty upgrade with 401 even while ending, not 503", async () => {
    const base = await start({ pollIntervalMs: 20 });
    // Connect before the server stops accepting new sockets, so the upgrade
    // request below still reaches the handler once `ending` flips true.
    const socket = net.connect(Number(new URL(base).port), "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const response = new Promise<string>((resolve) => socket.once("data", (chunk) => resolve(chunk.toString())));
    tmux.state.deadStatus = 0;
    socket.write("GET /pty HTTP/1.1\r\nHost: session-pod\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    expect((await response).split(" ")[1]).toBe("401");
    await waitFor(() => exits.length === 1);
    socket.destroy();
  });

  describe("GET /grants", () => {
    it("answers the inspectGrants callback as JSON", async () => {
      const grants: MountedGrants = { envMarkers: ["# claws-granted: home-assistant"], sshKeys: false };
      const base = await start({ inspectGrants: () => grants });
      const res = await fetch(`${base}/grants`, { headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(grants);
    });

    it("is 404 without an inspectGrants callback", async () => {
      const base = await start();
      expect((await fetch(`${base}/grants`, { headers: AUTH })).status).toBe(404);
    });
  });

  describe("GET /files", () => {
    let home: string;
    let outside: string;
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-server-home-"));
      outside = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-server-outside-"));
      fs.mkdirSync(path.join(home, "work"));
    });
    afterEach(() => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });
    const get = (base: string, p: string, headers: Record<string, string> = AUTH) =>
      fetch(`${base}/files?path=${encodeURIComponent(p)}`, { headers });

    it("streams a file inside HOME byte for byte, by relative or absolute path", async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      fs.writeFileSync(path.join(home, "work", "chart.png"), bytes);
      const base = await start({ cwd: path.join(home, "work"), home });
      for (const p of ["chart.png", path.join(home, "work", "chart.png")]) {
        const res = await get(base, p);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-length")).toBe(String(bytes.length));
        expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
      }
    });

    it("refuses a path outside HOME, including through a symlink", async () => {
      fs.writeFileSync(path.join(outside, "secret"), "token");
      fs.symlinkSync(path.join(outside, "secret"), path.join(home, "work", "link"));
      const base = await start({ cwd: path.join(home, "work"), home });
      for (const p of [path.join(outside, "secret"), "link", "../../" + path.basename(outside) + "/secret"]) {
        const res = await get(base, p);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ ok: false, reason: "outside-home" });
      }
    });

    it("streams a file inside a scratch root, by absolute path or through a symlink in HOME", async () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-server-scratch-"));
      try {
        fs.mkdirSync(path.join(scratch, "proj"));
        fs.writeFileSync(path.join(scratch, "proj", "report.md"), "# report");
        fs.symlinkSync(path.join(scratch, "proj", "report.md"), path.join(home, "work", "report-link"));
        const base = await start({ cwd: path.join(home, "work"), home, scratchRoots: [scratch, path.join(outside, "missing-root")] });
        for (const p of [path.join(scratch, "proj", "report.md"), "report-link"]) {
          const res = await get(base, p);
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("# report");
        }
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("refuses a path outside HOME and the scratch roots, including a symlink out of the scratchpad", async () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-server-scratch-"));
      try {
        fs.writeFileSync(path.join(outside, "secret"), "token");
        fs.symlinkSync(path.join(outside, "secret"), path.join(scratch, "link"));
        const base = await start({ cwd: path.join(home, "work"), home, scratchRoots: [scratch] });
        for (const p of [path.join(outside, "secret"), path.join(scratch, "link")]) {
          const res = await get(base, p);
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ ok: false, reason: "outside-home" });
        }
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("defaults the scratch root to the Claude Code scratchpad for this uid", () => {
      expect(defaultScratchRoot()).toBe(path.join(os.tmpdir(), `claude-${process.getuid?.() ?? ""}`));
    });

    it("is 404 not-found for a missing path or a directory", async () => {
      const base = await start({ cwd: path.join(home, "work"), home });
      for (const p of ["missing.txt", "."]) {
        const res = await get(base, p);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ ok: false, reason: "not-found" });
      }
    });

    it("refuses a file over the per-file limit with its size", async () => {
      const big = path.join(home, "work", "big.bin");
      fs.writeFileSync(big, "");
      fs.truncateSync(big, MAX_UPLOAD_BYTES + 1);
      const base = await start({ cwd: path.join(home, "work"), home });
      const res = await get(base, "big.bin");
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ ok: false, reason: "too-large", size: MAX_UPLOAD_BYTES + 1 });
    });

    it("requires the bearer token", async () => {
      fs.writeFileSync(path.join(home, "work", "a.txt"), "a");
      const base = await start({ cwd: path.join(home, "work"), home });
      expect((await get(base, "a.txt", {})).status).toBe(401);
    });
  });

  describe("POST /notify", () => {
    const sendKeys = () => tmux.state.calls.filter((c) => c[0] === "send-keys");

    it("types the text literally into the agent pane, waits, then presses Enter", async () => {
      const sleeps: number[] = [];
      const base = await start({ sleep: async (ms) => { sleeps.push(ms); } });
      const res = await fetch(`${base}/notify`, { method: "POST", headers: AUTH, body: "[Claws] granted; it's ready\n" });
      expect(res.status).toBe(204);
      expect(sendKeys()).toEqual([
        ["send-keys", "-t", "%0", "-l", "[Claws] granted; it's ready"],
        ["send-keys", "-t", "%0", "Enter"],
      ]);
      expect(sleeps).toEqual([NOTIFY_SUBMIT_DELAY_MS]);
    });

    it.each([
      ["empty", ""],
      ["multi-line", "one\ntwo"],
      ["oversized", "x".repeat(NOTIFY_MAX_BYTES + 1)],
    ])("rejects an %s body with 400 and types nothing", async (_label, body) => {
      const base = await start();
      const res = await fetch(`${base}/notify`, { method: "POST", headers: AUTH, body });
      expect(res.status).toBe(400);
      expect(sendKeys()).toEqual([]);
    });

    it("accepts a body of exactly the size cap", async () => {
      const base = await start();
      const res = await fetch(`${base}/notify`, { method: "POST", headers: AUTH, body: "x".repeat(NOTIFY_MAX_BYTES) });
      expect(res.status).toBe(204);
    });

    it("is 503 once the agent pane is dead or gone", async () => {
      const base = await start();
      tmux.state.deadStatus = 0;
      expect((await fetch(`${base}/notify`, { method: "POST", headers: AUTH, body: "hi" })).status).toBe(503);
      tmux.state.deadStatus = null;
      tmux.state.exists = false;
      expect((await fetch(`${base}/notify`, { method: "POST", headers: AUTH, body: "hi" })).status).toBe(503);
      expect(sendKeys()).toEqual([]);
    });
  });

  describe("POST /input", () => {
    const sent = () => tmux.state.calls.filter((c) => ["load-buffer", "paste-buffer", "send-keys"].includes(c[0]!));

    it("loads the text into a buffer, bracket-pastes it into the agent pane, waits, then presses Enter", async () => {
      const sleeps: number[] = [];
      const base = await start({ sleep: async (ms) => { sleeps.push(ms); } });
      const res = await fetch(`${base}/input`, { method: "POST", headers: AUTH, body: "first line\r\nsecond `line` $(x)\n\n" });
      expect(res.status).toBe(204);
      expect(sent()).toEqual([
        ["load-buffer", "-b", INPUT_BUFFER_NAME, "-"],
        ["paste-buffer", "-p", "-d", "-b", INPUT_BUFFER_NAME, "-t", "%0"],
        ["send-keys", "-t", "%0", "Enter"],
      ]);
      expect(tmux.state.stdins).toEqual(["first line\nsecond `line` $(x)"]);
      expect(sleeps).toEqual([NOTIFY_SUBMIT_DELAY_MS]);
    });

    it.each([
      ["empty", Buffer.from("")],
      ["blank", Buffer.from("  \n\t\n")],
      ["oversized", Buffer.from("x".repeat(INPUT_MAX_BYTES + 1))],
      ["non-UTF-8", Buffer.from([0x68, 0xff, 0xfe])],
    ])("rejects an %s body with 400 and sends nothing", async (_label, body) => {
      const base = await start();
      const res = await fetch(`${base}/input`, { method: "POST", headers: AUTH, body });
      expect(res.status).toBe(400);
      expect(sent()).toEqual([]);
    });

    it("accepts a body of exactly the size cap", async () => {
      const base = await start();
      expect((await fetch(`${base}/input`, { method: "POST", headers: AUTH, body: "x".repeat(INPUT_MAX_BYTES) })).status).toBe(204);
    });

    it("is 503 once the agent pane is dead or gone", async () => {
      const base = await start();
      tmux.state.deadStatus = 0;
      expect((await fetch(`${base}/input`, { method: "POST", headers: AUTH, body: "hi" })).status).toBe(503);
      tmux.state.deadStatus = null;
      tmux.state.exists = false;
      expect((await fetch(`${base}/input`, { method: "POST", headers: AUTH, body: "hi" })).status).toBe(503);
      expect(sent()).toEqual([]);
    });

    it("is 503 and presses no Enter when the paste fails", async () => {
      const base = await start();
      tmux.state.failing.add("paste-buffer");
      const res = await fetch(`${base}/input`, { method: "POST", headers: AUTH, body: "hi" });
      expect(res.status).toBe(503);
      expect(await res.text()).toMatch(/^paste into agent pane failed: /);
      expect(sent().map((c) => c[0])).toEqual(["load-buffer", "paste-buffer"]);
    });

    it("runs two concurrent inputs one at a time, each as a whole load, paste, Enter group", async () => {
      const gates: Array<() => void> = [];
      const base = await start({ sleep: () => new Promise<void>((resolve) => { gates.push(resolve); }) });
      const first = fetch(`${base}/input`, { method: "POST", headers: AUTH, body: "one" });
      await waitFor(() => gates.length === 1);
      const second = fetch(`${base}/input`, { method: "POST", headers: AUTH, body: "two" });
      // The second request must wait behind the first's pending Enter.
      await new Promise((r) => setTimeout(r, 50));
      expect(sent().map((c) => c[0])).toEqual(["load-buffer", "paste-buffer"]);
      gates[0]!();
      await waitFor(() => gates.length === 2);
      gates[1]!();
      expect((await first).status).toBe(204);
      expect((await second).status).toBe(204);
      const group = [
        ["load-buffer", "-b", INPUT_BUFFER_NAME, "-"],
        ["paste-buffer", "-p", "-d", "-b", INPUT_BUFFER_NAME, "-t", "%0"],
        ["send-keys", "-t", "%0", "Enter"],
      ];
      expect(sent()).toEqual([...group, ...group]);
      expect(tmux.state.stdins).toEqual(["one", "two"]);
    });
  });

  describe("GET /transcript", () => {
    let claudeHome: string;
    const cwd = "/home/claws/work/org/app";
    const projectDir = () => path.join(claudeHome, ".claude", "projects", "-home-claws-work-org-app");
    const cliHead = JSON.stringify({ type: "user", entrypoint: "cli", uuid: "u0" }) + "\n";

    beforeEach(() => {
      claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-server-claude-"));
    });
    afterEach(() => fs.rmSync(claudeHome, { recursive: true, force: true }));

    const startWithHome = () => start({ cwd, autoCompact: { idleMs: 3_600_000, claudeHome } });

    it("is 204 when there is no interactive transcript", async () => {
      const base = await startWithHome();
      const res = await fetch(`${base}/transcript`, { headers: AUTH });
      expect(res.status).toBe(204);
    });

    it("returns complete lines from the start of a small transcript, then only what was appended", async () => {
      fs.mkdirSync(projectDir(), { recursive: true });
      const file = path.join(projectDir(), "s1.jsonl");
      fs.writeFileSync(file, cliHead + '{"a":1}\n{"partial":');
      const base = await startWithHome();
      const first = await (await fetch(`${base}/transcript`, { headers: AUTH })).json() as TranscriptChunk;
      expect(first).toEqual({ file: "s1.jsonl", start: 0, next: cliHead.length + 8, size: cliHead.length + 8 + 11, truncatedBefore: false, lines: [cliHead.trim(), '{"a":1}'] });
      fs.appendFileSync(file, "true}\n");
      const second = await (await fetch(`${base}/transcript?file=s1.jsonl&offset=${first.next}`, { headers: AUTH })).json() as TranscriptChunk;
      expect(second).toMatchObject({ file: "s1.jsonl", start: first.next, truncatedBefore: false, lines: ['{"partial":true}'] });
      expect(second.next).toBe(second.size);
    });
  });

  it("returns capture-pane scrollback", async () => {
    const base = await start();
    const res = await fetch(`${base}/scrollback`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("line one\nline two\n");
    expect(tmux.state.calls).toContainEqual(["capture-pane", "-p", "-S", "-10000", "-t", "=claws-abc:"]);
  });

  it("returns the agent pane's visible screen as JSON with CRLF line ends", async () => {
    const base = await start();
    expect((await fetch(`${base}/screen`)).status).toBe(401);
    const res = await fetch(`${base}/screen`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cols: 132, rows: 43, data: "line one\r\nline two\r\n" });
    expect(tmux.state.calls).toContainEqual(["capture-pane", "-p", "-e", "-t", "%0"]);
    expect(tmux.state.calls).toContainEqual(["display-message", "-p", "-t", "%0", "#{pane_width} #{pane_height}"]);
    expect(tmux.state.calls.some((c) => c[0] === "resize-window")).toBe(false);
  });

  it("drops trailing blank rows from the /screen snapshot", async () => {
    const base = await start();
    tmux.state.scrollback = "\x1b[1mhi\x1b[0m\n\x1b[0m   \n\n\n";
    const res = await fetch(`${base}/screen`, { headers: AUTH });
    expect(await res.json()).toEqual({ cols: 132, rows: 43, data: "\x1b[1mhi\x1b[0m\r\n" });
  });

  it("answers /screen with 503 once tmux is gone", async () => {
    const base = await start();
    tmux.state.exists = false;
    const res = await fetch(`${base}/screen`, { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("tmux session not running");
  });

  it("stores uploads and accepts uploads after the old file-count cap", async () => {
    const base = await start();
    const ok = await fetch(`${base}/uploads?name=${encodeURIComponent("my notes.txt")}`, { method: "POST", headers: AUTH, body: "hello" });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(path.dirname(body.path)).toBe(uploadDir);
    expect(fs.readFileSync(body.path, "utf8")).toBe("hello");

    expect((await fetch(`${base}/uploads`, { method: "POST", headers: AUTH, body: "x" })).status).toBe(400);

    for (let i = fs.readdirSync(uploadDir).length; i < 20; i++) {
      fs.writeFileSync(path.join(uploadDir, `f${i}`), "x");
    }
    const extra = await fetch(`${base}/uploads?name=b.txt`, { method: "POST", headers: AUTH, body: "more" });
    expect(extra.status).toBe(200);
    const extraBody = await extra.json() as { ok: boolean; path: string };
    expect(extraBody.ok).toBe(true);
    expect(fs.readFileSync(extraBody.path, "utf8")).toBe("more");
  });

  it("DELETE /uploads empties the upload directory, keeps it and answers 204", async () => {
    const base = await start();
    fs.writeFileSync(path.join(uploadDir, "key.pem"), "secret");
    fs.mkdirSync(path.join(uploadDir, "nested"));
    fs.writeFileSync(path.join(uploadDir, "nested", "x"), "y");
    expect((await fetch(`${base}/uploads`, { method: "DELETE" })).status).toBe(401);
    expect(fs.readdirSync(uploadDir)).toHaveLength(2);
    const res = await fetch(`${base}/uploads`, { method: "DELETE", headers: AUTH });
    expect(res.status).toBe(204);
    expect(fs.existsSync(uploadDir)).toBe(true);
    expect(fs.readdirSync(uploadDir)).toEqual([]);
  });

  it("purgeUploadDir never throws for a missing directory", async () => {
    expect(await purgeUploadDir(path.join(uploadDir, "missing"))).toBe(0);
  });

  it("drops a client that aborts mid-upload, removes the partial file and keeps accepting uploads", async () => {
    const base = await start();
    const req = http.request(`${base}/uploads?name=partial.bin`, {
      method: "POST",
      headers: { ...AUTH, "Content-Length": String(100 * 1024) },
    });
    req.on("error", () => {});
    req.write(Buffer.alloc(1024, 120));
    await waitFor(() => fs.readdirSync(uploadDir).length === 1);
    req.destroy();
    await waitFor(() => fs.readdirSync(uploadDir).length === 0);

    const ok = await fetch(`${base}/uploads?name=after.txt`, { method: "POST", headers: AUTH, body: "hello" });
    expect(ok.status).toBe(200);
    expect(fs.readdirSync(uploadDir)).toHaveLength(1);
  });

  it("applies a resize and input sent before the pty exists", async () => {
    const base = await start();
    let releaseCapture!: () => void;
    tmux.state.captureGate = new Promise((resolve) => { releaseCapture = resolve; });
    const client = connect(base);
    await client.opened;
    client.ws.send(JSON.stringify({ type: "resize", cols: 200, rows: 50 }));
    client.ws.send(JSON.stringify({ type: "input", data: "early" }));
    // Let the server receive both frames while scrollback capture is still blocked.
    await new Promise((r) => setTimeout(r, 100));
    expect(pty.ptys).toHaveLength(0);
    releaseCapture();
    await waitFor(() => pty.ptys.length === 1);
    expect(pty.ptys[0].size).toEqual([200, 50]);
    expect(pty.ptys[0].written).toEqual(["early"]);
  });

  it("sends scrollback on connect, attaches a pty and validates frames with clamped resizes", async () => {
    const base = await start();
    const client = connect(base);
    await client.opened;
    await waitFor(() => pty.ptys.length === 1);
    expect(client.messages[0]).toEqual({ type: "scrollback", data: "line one\r\nline two\r\n" });
    expect(pty.ptys[0].args).toEqual(["-L", "claws", "attach-session", "-t", "=claws-abc"]);

    pty.ptys[0].emitData("prompt$ ");
    await waitFor(() => client.messages.length === 2);
    expect(client.messages[1]).toEqual({ type: "output", data: "prompt$ " });

    client.ws.send(JSON.stringify({ type: "input", data: "ls\r" }));
    client.ws.send(JSON.stringify({ type: "resize", cols: 9999, rows: 0 }));
    client.ws.send(JSON.stringify({ type: "bogus" }));
    client.ws.send("not json");
    await waitFor(() => pty.ptys[0].resizes.length === 1);
    expect(pty.ptys[0].written).toEqual(["ls\r"]);
    expect(pty.ptys[0].resizes).toEqual([[500, 1]]);
    await waitFor(() => tmux.state.calls.some((c) => c.join(" ") === "resize-window -t =claws-abc: -x 500 -y 1"));
    expect(tmux.state.calls.some((c) => c.join(" ") === "resize-window -t =claws-abc: -x 120 -y 40")).toBe(true);
  });

  it("keeps the socket working when resize-window fails", async () => {
    const base = await start();
    tmux.state.resizeWindowFails = true;
    const client = connect(base);
    await client.opened;
    await waitFor(() => pty.ptys.length === 1);
    client.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await waitFor(() => pty.ptys[0].resizes.length === 1);
    client.ws.send(JSON.stringify({ type: "input", data: "x" }));
    await waitFor(() => pty.ptys[0].written.length === 1);
    expect(pty.ptys[0].resizes).toEqual([[100, 30]]);
  });

  it("spawns one pty per socket and kills it when the socket closes", async () => {
    const base = await start();
    const a = connect(base);
    const b = connect(base);
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => pty.ptys.length === 2);
    a.ws.close();
    await waitFor(() => pty.ptys.some((p) => p.killed));
    expect(pty.ptys.filter((p) => p.killed)).toHaveLength(1);
  });

  it("closes with 1011 when the pty exits but tmux is still alive", async () => {
    const base = await start();
    const client = connect(base);
    await client.opened;
    await waitFor(() => pty.ptys.length === 1);
    pty.ptys[0].emitExit(1);
    expect((await client.closed).code).toBe(1011);
    expect(client.messages.some((m) => m.type === "exit")).toBe(false);
    expect(exits).toEqual([]);
  });

  it("exits 0 once a pty exits, tmux is gone and the confirmation finds the agent process gone", async () => {
    const base = await start();
    const a = connect(base);
    const b = connect(base);
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => pty.ptys.length === 2);
    tmux.state.exists = false;
    agentAlive = false;
    pty.ptys[0].emitExit(0);
    // The socket whose bridge died closes as a bridge exit; the confirmation then ends the rest.
    expect((await a.closed).code).toBe(1011);
    expect((await b.closed).code).toBe(1000);
    expect(b.messages).toContainEqual({ type: "exit", code: 0 });
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([0]);
    expect(aliveChecks).toEqual([4242]);
  });

  it("keeps the session when a pty exits and tmux gives no answer while the agent process lives", async () => {
    const base = await start();
    const client = connect(base);
    await client.opened;
    await waitFor(() => pty.ptys.length === 1);
    tmux.state.exists = false;
    pty.ptys[0].emitExit(0);
    expect((await client.closed).code).toBe(1011);
    await waitFor(() => aliveChecks.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(exits).toEqual([]);
    expect(tmux.state.calls).not.toContainEqual(["kill-server"]);
  });

  it("exits 0 and closes sockets once the poll finds the tmux session gone and the agent process gone", async () => {
    const base = await start({ pollIntervalMs: 20 });
    const client = connect(base);
    await client.opened;
    agentAlive = false;
    tmux.state.exists = false;
    expect((await client.closed).code).toBe(1000);
    expect(client.messages).toContainEqual({ type: "exit", code: 0 });
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([0]);
  });

  describe("when the session's process exits", () => {
    let reportServer: http.Server;
    let reports: Array<{ auth: string | undefined; body: { code: number; scrollback: string; reason?: string } }>;
    let reportStatus: number;
    let reportUrl: string;

    beforeEach(async () => {
      reports = [];
      reportStatus = 204;
      reportServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (d) => { body += d; });
        req.on("end", () => {
          reports.push({ auth: req.headers.authorization, body: JSON.parse(body) });
          res.writeHead(reportStatus);
          res.end();
        });
      });
      await new Promise<void>((resolve) => reportServer.listen(0, "127.0.0.1", resolve));
      reportUrl = `http://127.0.0.1:${(reportServer.address() as net.AddressInfo).port}/session-pods/abc/exit`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => reportServer.close(() => resolve()));
    });

    it("sends the real exit code to every socket, reports the output and exits with the code", async () => {
      const base = await start({ pollIntervalMs: 20, exitReportUrl: reportUrl });
      const a = connect(base);
      const b = connect(base);
      await Promise.all([a.opened, b.opened]);
      tmux.state.scrollback = "Error: EACCES\n\n\n";
      tmux.state.deadStatus = 2;
      expect((await a.closed).code).toBe(1000);
      expect((await b.closed).code).toBe(1000);
      expect(a.messages).toContainEqual({ type: "exit", code: 2 });
      expect(b.messages).toContainEqual({ type: "exit", code: 2 });
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([2]);
      expect(reports).toEqual([{ auth: `Bearer ${TOKEN}`, body: { code: 2, scrollback: "Error: EACCES", reason: "pane_dead" } }]);
      // Output is captured before tmux is torn down.
      const names = tmux.state.calls.map((c) => c[0]);
      expect(names.lastIndexOf("capture-pane")).toBeLessThan(names.lastIndexOf("kill-server"));
    });

    it("ignores a hand-opened pane exiting while the agent runs", async () => {
      const base = await start({ pollIntervalMs: 20, exitReportUrl: reportUrl });
      tmux.state.sidePane = { deadStatus: 0, active: true };
      await new Promise((r) => setTimeout(r, 100));
      expect(exits).toEqual([]);
      expect(reports).toEqual([]);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });

    it("ends when the agent pane dies while another pane is active, capturing the agent pane", async () => {
      await start({ pollIntervalMs: 20, exitReportUrl: reportUrl });
      tmux.state.sidePane = { deadStatus: null, active: true };
      tmux.state.deadStatus = 5;
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([5]);
      expect(reports.map((r) => r.body.code)).toEqual([5]);
      expect(tmux.state.calls).toContainEqual(["capture-pane", "-p", "-S", "-10000", "-t", "%0"]);
    });

    it("ends with 0 and pane_gone once the agent pane is gone, tmux falls back to another pane and the agent process is gone", async () => {
      await start({ pollIntervalMs: 20, exitReportUrl: reportUrl });
      agentAlive = false;
      // tmux resolves an unknown pane id to the current pane.
      tmux.state.sidePane = { deadStatus: null, active: true };
      tmux.run.mockImplementation(async (args: string[]) => {
        tmux.state.calls.push(args);
        if (args[0] === "display-message" && args[3] === "%0") return { code: 0, stdout: "%1 0 \n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      });
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([0]);
      expect(reports.map((r) => r.body)).toEqual([{ code: 0, scrollback: "", reason: "pane_gone" }]);
    });

    it("does not end the session on one empty answer from a pane query (#clw_01M8997QNSAC11ZBBCZ4HCNVVC)", async () => {
      process.env["CLAWS_LOG_FORMAT"] = "json";
      const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await start({ pollIntervalMs: 20, exitReportUrl: reportUrl });
        // What reading tmux's stdout at `exit` instead of `close` produced: code 0, no output.
        tmux.state.paneAnswers.push({ code: 0, stdout: "", stderr: "" });
        await waitFor(() => tmux.state.paneAnswers.length === 0);
        await new Promise((r) => setTimeout(r, 100));
        expect(exits).toEqual([]);
        expect(reports).toEqual([]);
        expect(tmux.state.calls).not.toContainEqual(["kill-server"]);
        const lines = warns.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
        expect(lines).toContainEqual(expect.objectContaining({
          level: "warn", check: "poll", why: "pane_mismatch", tmux_code: 0,
        }));
      } finally {
        warns.mockRestore();
        delete process.env["CLAWS_LOG_FORMAT"];
      }
    });

    it("re-queries an unclear answer and a later running answer cancels the end", async () => {
      const sleeps: number[] = [];
      await start({ pollIntervalMs: 20, exitReportUrl: reportUrl, sleep: async (ms) => { sleeps.push(ms); } });
      tmux.state.paneAnswers.push({ code: 1, stdout: "", stderr: "no server running", signal: null }, { code: 1, stdout: "", stderr: "x" });
      await waitFor(() => sleeps.length >= 2);
      await new Promise((r) => setTimeout(r, 100));
      expect(sleeps.slice(0, 2)).toEqual([EXIT_CONFIRM_DELAY_MS, EXIT_CONFIRM_DELAY_MS]);
      expect(exits).toEqual([]);
      expect(aliveChecks).toEqual([]);
    });

    it("ends with the dead pane's code when a re-query finds it dead", async () => {
      await start({ pollIntervalMs: 20, exitReportUrl: reportUrl });
      tmux.state.paneAnswers.push({ code: 1, stdout: "", stderr: "boom" });
      tmux.state.deadStatus = 7;
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([7]);
      expect(reports.map((r) => r.body.reason)).toEqual(["pane_dead"]);
    });

    it("never ends or kills tmux while the agent process lives, however many queries fail", async () => {
      process.env["CLAWS_LOG_FORMAT"] = "json";
      const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
      const infos = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const sleeps: number[] = [];
        await start({ pollIntervalMs: 20, exitReportUrl: reportUrl, sleep: async (ms) => { sleeps.push(ms); } });
        tmux.state.exists = false;
        await waitFor(() => aliveChecks.length >= 3);
        expect(exits).toEqual([]);
        expect(reports).toEqual([]);
        expect(tmux.state.calls).not.toContainEqual(["kill-server"]);
        expect(new Set(aliveChecks)).toEqual(new Set([4242]));
        // Each confirmation re-queries EXIT_CONFIRM_RETRIES times before asking about the process.
        expect(sleeps.length).toBeGreaterThanOrEqual(3 * EXIT_CONFIRM_RETRIES);
        const streak = (spy: typeof warns) => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
          .filter((l) => typeof l.msg === "string" && l.msg.startsWith("tmux pane query"));
        // One warn for the whole failing streak, one info once it recovers.
        expect(streak(warns).map((l) => l.msg)).toEqual(["tmux pane query keeps failing; agent process alive, not ending"]);
        expect(streak(warns)[0]).toMatchObject({ agent_alive: true, failed_queries: EXIT_CONFIRM_RETRIES + 1 });
        tmux.state.exists = true;
        await waitFor(() => streak(infos).length === 1);
        expect(streak(infos)[0]!.msg).toBe("tmux pane query recovered; agent pane running");
      } finally {
        warns.mockRestore();
        infos.mockRestore();
        delete process.env["CLAWS_LOG_FORMAT"];
      }
    });

    it("ends with tmux_gone and code 0 once the queries fail, the agent process is gone and has-session fails", async () => {
      process.env["CLAWS_LOG_FORMAT"] = "json";
      const infos = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await start({ pollIntervalMs: 20, exitReportUrl: reportUrl });
        agentAlive = false;
        tmux.state.exists = false;
        await waitFor(() => exits.length === 1);
        expect(exits).toEqual([0]);
        expect(reports.map((r) => r.body)).toEqual([{ code: 0, scrollback: "", reason: "tmux_gone" }]);
        const end = infos.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
          .find((l) => l.msg === "Session process exited with code 0 — exiting");
        expect(end).toMatchObject({
          reason: "tmux_gone", check: "poll", pane_dead: false, agent_alive: false, has_session: false, failed_queries: EXIT_CONFIRM_RETRIES + 1,
        });
      } finally {
        infos.mockRestore();
        delete process.env["CLAWS_LOG_FORMAT"];
      }
    });

    it("logs which check ended a session on a dead pane", async () => {
      process.env["CLAWS_LOG_FORMAT"] = "json";
      const infos = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await start({ pollIntervalMs: 20 });
        tmux.state.deadStatus = 2;
        await waitFor(() => exits.length === 1);
        const end = infos.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
          .find((l) => l.msg === "Session process exited with code 2 — exiting");
        expect(end).toMatchObject({ reason: "pane_dead", check: "poll", pane_dead: true, failed_queries: 0 });
      } finally {
        infos.mockRestore();
        delete process.env["CLAWS_LOG_FORMAT"];
      }
    });

    it("with no agent pid known, ends only when has-session fails", async () => {
      tmux = fakeTmux({ exists: true });
      tmux.state.agentPaneId = "";
      tmux.state.agentPid = 0;
      pty = fakePtyFactory();
      server = await startTerminalServer({
        sessionId: "abc", cwd: "/tmp", command: ["claude"], uploadDir, home: uploadDir, readToken: () => TOKEN,
        tmux: tmux.run, spawnPty: pty.factory, host: "127.0.0.1", port: 0, pollIntervalMs: 20,
        onExit: (code) => exits.push(code), sleep: async () => {},
        isProcessAlive: (pid) => { aliveChecks.push(pid); return false; },
        exitReportUrl: reportUrl,
      });
      // Pane queries fail but the session is still there: not ended.
      tmux.state.failing.add("display-message");
      await waitFor(() => tmux.state.calls.filter((c) => c[0] === "has-session").length >= 3);
      expect(exits).toEqual([]);
      tmux.state.exists = false;
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([0]);
      expect(aliveChecks).toEqual([]);
      expect(reports.map((r) => r.body.reason)).toEqual(["tmux_gone"]);
    });

    it("clamps a large exit status for the pod", async () => {
      await start({ pollIntervalMs: 20 });
      tmux.state.deadStatus = 300;
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([255]);
    });

    it("still exits when the report is rejected", async () => {
      reportStatus = 500;
      await start({ pollIntervalMs: 20, exitReportUrl: reportUrl });
      tmux.state.deadStatus = 1;
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([1]);
      expect(reports).toHaveLength(1);
    });

    it("still exits when the report endpoint is unreachable", async () => {
      await start({ pollIntervalMs: 20, exitReportUrl: "http://127.0.0.1:1/session-pods/abc/exit" });
      tmux.state.deadStatus = 1;
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([1]);
    });

    it("exits 0 for a clean exit and skips the report without a URL", async () => {
      const base = await start({ pollIntervalMs: 20 });
      const client = connect(base);
      await client.opened;
      tmux.state.deadStatus = 0;
      expect((await client.closed).code).toBe(1000);
      expect(client.messages).toContainEqual({ type: "exit", code: 0 });
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([0]);
      expect(reports).toEqual([]);
    });

    it("ends when a pty exits and the pane is dead", async () => {
      const base = await start({ exitReportUrl: reportUrl });
      const client = connect(base);
      await client.opened;
      await waitFor(() => pty.ptys.length === 1);
      tmux.state.deadStatus = 3;
      pty.ptys[0].emitExit(0);
      expect((await client.closed).code).toBe(1000);
      expect(client.messages).toContainEqual({ type: "exit", code: 3 });
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([3]);
      expect(reports.map((r) => r.body.code)).toEqual([3]);
    });

    it("empties the upload directory when the session's process exits", async () => {
      await start({ pollIntervalMs: 20 });
      fs.writeFileSync(path.join(uploadDir, "token.txt"), "secret");
      tmux.state.deadStatus = 0;
      await waitFor(() => exits.length === 1);
      expect(fs.existsSync(uploadDir)).toBe(true);
      expect(fs.readdirSync(uploadDir)).toEqual([]);
    });

    it("shutdown keeps the uploads", async () => {
      await start();
      fs.writeFileSync(path.join(uploadDir, "token.txt"), "secret");
      await server!.shutdown();
      expect(exits).toEqual([0]);
      expect(fs.readdirSync(uploadDir)).toEqual(["token.txt"]);
    });

    it("shutdown does not report", async () => {
      await start({ exitReportUrl: reportUrl });
      await server!.shutdown();
      expect(exits).toEqual([0]);
      expect(reports).toEqual([]);
    });

    // #clw_01M3HH9MM5J348FTZ4T9AY67Y2: a launch failure (e.g. tmux's own
    // "command too long") used to leave the pod with no exit report at all —
    // the terminal server never started, so nothing sent one before the pod
    // was reconciled away. Now a `new-session` failure is reported like any
    // other exit, carrying tmux's stderr as the scrollback.
    it("reports a tmux new-session failure with code 1 and tmux's stderr before rejecting", async () => {
      await expect(start({ createFails: true, exitReportUrl: reportUrl })).rejects.toBeInstanceOf(TerminalServerStartError);
      expect(reports).toEqual([{ auth: `Bearer ${TOKEN}`, body: { code: 1, scrollback: "tmux new-session failed: no server", reason: "start_failed" } }]);
    });
  });

  it("parses the pane id and pid", () => {
    expect(parsePaneIdentity("%3 1234\n")).toEqual(["%3", 1234]);
    expect(parsePaneIdentity("%3\n")).toEqual(["%3", null]);
    expect(parsePaneIdentity("%3 0\n%4 9\n")).toEqual(["%3", null]);
    expect(parsePaneIdentity("")).toEqual(["", null]);
  });

  it("parses pane state", () => {
    expect(parsePaneState("0 \n")).toEqual({ dead: false });
    expect(parsePaneState("1 2\n")).toEqual({ dead: true, code: 2 });
    expect(parsePaneState("1 \n")).toEqual({ dead: true, code: 1 });
    expect(parsePaneState("1 x")).toEqual({ dead: true, code: 1 });
    expect(podExitCode(0)).toBe(0);
    expect(podExitCode(-1)).toBe(1);
    expect(podExitCode(256)).toBe(255);
  });

  it("shutdown kills the tmux server, sends exit, closes sockets and exits 0", async () => {
    const base = await start();
    const client = connect(base);
    await client.opened;
    await server!.shutdown();
    expect(tmux.state.calls).toContainEqual(["kill-server"]);
    expect((await client.closed).code).toBe(1001);
    expect(client.messages).toContainEqual({ type: "exit", code: 0 });
    expect(exits).toEqual([0]);
  });

  it("runs the auto-compact check on an interval and clears it on shutdown (#3090)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const check = vi.mocked(maybeAutoCompact);
      check.mockClear();
      await start({ autoCompact: { idleMs: 1_800_000, claudeHome: "/home/claws" } });
      vi.advanceTimersByTime(AUTO_COMPACT_CHECK_INTERVAL_MS);
      expect(check).toHaveBeenCalledTimes(1);
      expect(check.mock.calls[0][0]).toMatchObject({ tmuxName: "claws-abc", cwd: "/home/claws/work/org/app", claudeHome: "/home/claws", idleMs: 1_800_000 });
      // The has-session poll plus the auto-compact interval.
      expect(vi.getTimerCount()).toBe(2);
      await server!.shutdown();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(AUTO_COMPACT_CHECK_INTERVAL_MS * 3);
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no auto-compact check without the option", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const check = vi.mocked(maybeAutoCompact);
      check.mockClear();
      await start();
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(AUTO_COMPACT_CHECK_INTERVAL_MS * 2);
      expect(check).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readTranscriptChunk", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-chunk-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, text: string | Buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };

  it("starts a first read at the tail, aligned to the next line start, and flags it truncated", async () => {
    const line = JSON.stringify({ pad: "x".repeat(1000) });
    const count = Math.ceil(TRANSCRIPT_TAIL_BYTES / (line.length + 1)) + 50;
    const file = write("t.jsonl", (line + "\n").repeat(count));
    const size = fs.statSync(file).size;
    const chunk = await readTranscriptChunk(file, null, null);
    expect(chunk.truncatedBefore).toBe(true);
    expect(chunk.start).toBeGreaterThanOrEqual(size - TRANSCRIPT_TAIL_BYTES);
    expect(chunk.start % (line.length + 1)).toBe(0);
    expect(chunk.lines.every((l) => l === line)).toBe(true);
    expect(chunk.lines.reduce((n, l) => n + Buffer.byteLength(l), 0)).toBeLessThanOrEqual(TRANSCRIPT_REPLY_MAX_BYTES);
    expect(chunk.next - chunk.start).toBe(chunk.lines.length * (line.length + 1));
  });

  it("restarts at the tail when the transcript rotated to another file", async () => {
    const file = write("new.jsonl", '{"a":1}\n');
    expect(await readTranscriptChunk(file, "old.jsonl", 5)).toEqual({ file: "new.jsonl", start: 0, next: 8, size: 8, truncatedBefore: false, lines: ['{"a":1}'] });
  });

  it("restarts at the tail when the offset is past the end", async () => {
    const file = write("t.jsonl", '{"a":1}\n{"b":2}\n');
    expect(await readTranscriptChunk(file, "t.jsonl", 999)).toMatchObject({ start: 0, next: 16, lines: ['{"a":1}', '{"b":2}'] });
  });

  it("resumes from an offset at the end with nothing new", async () => {
    const file = write("t.jsonl", '{"a":1}\n');
    expect(await readTranscriptChunk(file, "t.jsonl", 8)).toEqual({ file: "t.jsonl", start: 8, next: 8, size: 8, truncatedBefore: false, lines: [] });
  });

  it("skips to the next line start when the offset lands mid-line", async () => {
    const file = write("t.jsonl", '{"a":1}\n{"b":2}\n');
    expect(await readTranscriptChunk(file, "t.jsonl", 3)).toMatchObject({ start: 8, next: 16, lines: ['{"b":2}'] });
  });

  it("replaces a line still longer than a reply once slimmed with an oversize stub and steps past it", async () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 20; i++) fields[`k${i}`] = "y".repeat(30_000);
    const huge = JSON.stringify(fields);
    expect(huge.length).toBeGreaterThan(TRANSCRIPT_REPLY_MAX_BYTES);
    const file = write("t.jsonl", huge + '\n{"after":1}\n');
    const first = await readTranscriptChunk(file, "t.jsonl", 0);
    expect(first.lines).toEqual([JSON.stringify({ type: "claws-oversize", bytes: huge.length, offset: 0 }), '{"after":1}']);
    expect(first.next).toBe(first.size);
    const second = await readTranscriptChunk(file, "t.jsonl", huge.length + 1);
    expect(second.lines).toEqual(['{"after":1}']);
  });

  it("stubs an unparseable long line and steps past it", async () => {
    const bad = "{" + "x".repeat(TRANSCRIPT_SLIM_LINE_BYTES + 10);
    const file = write("t.jsonl", bad + '\n{"after":1}\n');
    const chunk = await readTranscriptChunk(file, "t.jsonl", 0);
    expect(chunk.lines).toEqual([JSON.stringify({ type: "claws-oversize", bytes: bad.length, offset: 0 }), '{"after":1}']);
    expect(chunk.next).toBe(chunk.size);
  });

  it("cuts a long string in a large line with a marker", async () => {
    const big = JSON.stringify({ uuid: "u", text: "y".repeat(TRANSCRIPT_SLIM_LINE_BYTES * 2) });
    const file = write("t.jsonl", big + "\n");
    const [out] = (await readTranscriptChunk(file, null, null)).lines;
    const parsed = JSON.parse(out!) as { uuid: string; text: string };
    expect(parsed.uuid).toBe("u");
    const removed = TRANSCRIPT_SLIM_LINE_BYTES * 2 - TRANSCRIPT_SLIM_STRING_CHARS;
    expect(parsed.text).toBe("y".repeat(TRANSCRIPT_SLIM_STRING_CHARS) + `\n[… ${removed} more characters, see the terminal]`);
  });

  it("returns a line under the slim threshold byte-for-byte", async () => {
    const small = `{ "spaced" : "${"a".repeat(TRANSCRIPT_SLIM_LINE_BYTES - 100)}", "src": {"type":"base64","data":"QUJD"} }`;
    const file = write("t.jsonl", small + "\n");
    expect((await readTranscriptChunk(file, null, null)).lines).toEqual([small]);
  });

  describe("with images", () => {
    const MB = 1024 * 1024;
    const turn = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } });
    const photo = (uuid: string) => JSON.stringify({
      type: "user",
      uuid,
      message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(MB) } }, { type: "text", text: `photo ${uuid}` }] },
    });

    it("keeps the turns before several MB of photos and slims each photo", async () => {
      const entries = [turn("t1", "first"), turn("t2", "second"), ...["p1", "p2", "p3", "p4", "p5"].map(photo)];
      const file = write("t.jsonl", entries.map((l) => l + "\n").join(""));
      const all: string[] = [];
      let chunk = await readTranscriptChunk(file, null, null);
      expect(chunk).toMatchObject({ start: 0, truncatedBefore: false });
      all.push(...chunk.lines);
      while (chunk.next < chunk.size) {
        chunk = await readTranscriptChunk(file, "t.jsonl", chunk.next);
        expect(chunk.lines.length).toBeGreaterThan(0);
        all.push(...chunk.lines);
      }
      expect(all).toHaveLength(7);
      expect(all.slice(0, 2)).toEqual(entries.slice(0, 2));
      for (const [i, out] of all.slice(2).entries()) {
        expect(out).not.toContain("claws-oversize");
        const content = (JSON.parse(out) as { message: { content: Array<Record<string, any>> } }).message.content;
        expect(content[0]!.source).toEqual({ type: "base64", media_type: "image/jpeg", data: "", claws_bytes: Math.floor(MB * 3 / 4) });
        expect(content[1]).toEqual({ type: "text", text: `photo p${i + 1}` });
      }
    });

    it("resumes with no gap and no repeat across mixed large and small lines", async () => {
      const entries: string[] = [];
      for (let i = 0; i < 12; i++) entries.push(i % 3 === 0 ? photo(`p${i}`) : turn(`t${i}`, `x${"y".repeat(40_000)}`));
      const file = write("t.jsonl", entries.map((l) => l + "\n").join(""));
      const uuids: string[] = [];
      let offset = 0;
      for (;;) {
        const chunk = await readTranscriptChunk(file, "t.jsonl", offset);
        uuids.push(...chunk.lines.map((l) => (JSON.parse(l) as { uuid: string }).uuid));
        expect(chunk.lines.reduce((n, l) => n + Buffer.byteLength(l), 0)).toBeLessThanOrEqual(TRANSCRIPT_REPLY_MAX_BYTES);
        if (chunk.next === chunk.size) break;
        expect(chunk.next).toBeGreaterThan(offset);
        offset = chunk.next;
      }
      expect(uuids).toEqual(entries.map((l) => (JSON.parse(l) as { uuid: string }).uuid));
    });

    it("ends a reply once it has stepped past the raw-read budget and resumes with no gap", async () => {
      const entries = ["p1", "p2", "p3", "p4", "p5", "p6"].map(photo);
      const file = write("t.jsonl", entries.map((l) => l + "\n").join(""));
      const starts = entries.reduce<number[]>((acc, l, i) => [...acc, i === 0 ? 0 : acc[i - 1]! + Buffer.byteLength(entries[i - 1]!) + 1], []);
      const budget = 2 * MB;
      const first = await readTranscriptChunk(file, "t.jsonl", 0, budget);
      expect(first.lines.length).toBeGreaterThan(0);
      expect(first.lines.length).toBeLessThan(entries.length);
      expect(first.next).toBeLessThan(first.size);
      expect(starts).toContain(first.next);
      expect(first.next - first.start).toBeLessThan(budget + Buffer.byteLength(entries[0]!) + 1);
      const uuids = first.lines.map((l) => (JSON.parse(l) as { uuid: string }).uuid);
      let offset = first.next;
      while (offset < first.size) {
        const chunk = await readTranscriptChunk(file, "t.jsonl", offset, budget);
        expect(chunk.next).toBeGreaterThan(offset);
        uuids.push(...chunk.lines.map((l) => (JSON.parse(l) as { uuid: string }).uuid));
        offset = chunk.next;
      }
      expect(uuids).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    });

    it("always takes the first line even when it alone exceeds the raw-read budget", async () => {
      const file = write("t.jsonl", photo("p1") + "\n" + photo("p2") + "\n");
      const chunk = await readTranscriptChunk(file, "t.jsonl", 0, 1);
      expect(chunk.lines).toHaveLength(1);
      expect(chunk.next).toBe(Buffer.byteLength(photo("p1")) + 1);
    });

    it("still flags a read truncated when the slimmed history exceeds the tail window", async () => {
      const line = turn("t", "z".repeat(TRANSCRIPT_SLIM_LINE_BYTES * 2));
      const count = Math.ceil(TRANSCRIPT_TAIL_BYTES / TRANSCRIPT_SLIM_LINE_BYTES) + 5;
      const file = write("t.jsonl", (line + "\n").repeat(count));
      const chunk = await readTranscriptChunk(file, null, null);
      expect(chunk.truncatedBefore).toBe(true);
      expect(chunk.start).toBeGreaterThan(0);
      expect(chunk.start % (line.length + 1)).toBe(0);
    });

    it("waits on a large line still being written", async () => {
      const file = write("t.jsonl", turn("t1", "a") + "\n" + photo("p1").slice(0, 500_000));
      const chunk = await readTranscriptChunk(file, null, null);
      expect(chunk.lines).toEqual([turn("t1", "a")]);
      expect(chunk.next).toBe(turn("t1", "a").length + 1);
    });
  });

  it("waits on an oversize line that is still being written", async () => {
    const file = write("t.jsonl", "z".repeat(TRANSCRIPT_REPLY_MAX_BYTES + 10));
    expect(await readTranscriptChunk(file, "t.jsonl", 0)).toMatchObject({ start: 0, next: 0, lines: [] });
  });

  it("keeps multi-byte UTF-8 intact", async () => {
    const file = write("t.jsonl", '{"t":"héllo ✓"}\n');
    expect((await readTranscriptChunk(file, null, null)).lines).toEqual(['{"t":"héllo ✓"}']);
  });
});

describe("slimTranscriptLine", () => {
  it("empties base64 data at any length and records its decoded size", () => {
    const out = slimTranscriptLine(JSON.stringify({ a: [{ source: { type: "base64", media_type: "image/png", data: "QUJD" } }] }));
    expect(JSON.parse(out!)).toEqual({ a: [{ source: { type: "base64", media_type: "image/png", data: "", claws_bytes: 3 } }] });
  });

  it("is null for a line that does not parse", () => {
    expect(slimTranscriptLine("{nope")).toBeNull();
  });
});

describe("isProcessAlive", () => {
  it("is true for this process and false for a pid that does not exist", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });

  it("treats EPERM as alive", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); });
    try {
      expect(isProcessAlive(1)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});

describe("createTmuxRunner", () => {
  let binDir: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-server-tmux-"));
  });

  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function fakeTmuxBinary(script: string) {
    const file = path.join(binDir, "tmux");
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return createTmuxRunner({ ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` });
  }

  it("returns output written just before tmux exits, even with many calls at once (#clw_01M8997QNSAC11ZBBCZ4HCNVVC)", async () => {
    const run = fakeTmuxBinary("printf '%%0 0 \\n'; exit 0");
    const results = await Promise.all(Array.from({ length: 64 }, () => run(["display-message", "-p"])));
    for (const r of results) expect(r).toEqual({ code: 0, stdout: "%0 0 \n", stderr: "", signal: null });
  });

  it("passes the arguments after -L claws and reports exit code and stderr", async () => {
    const run = fakeTmuxBinary('echo "$@"; echo nope >&2; exit 3');
    expect(await run(["has-session", "-t", "=x"])).toEqual({ code: 3, stdout: "-L claws has-session -t =x\n", stderr: "nope\n", signal: null });
  });

  it("reports the signal that ended tmux", async () => {
    const run = fakeTmuxBinary("kill -TERM $$");
    expect(await run(["list-panes"])).toMatchObject({ code: 1, signal: "SIGTERM" });
  });

  it("resolves with code 1 and the error when tmux cannot be spawned", async () => {
    const run = createTmuxRunner({ PATH: binDir });
    const r = await run(["list-panes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ENOENT/);
  });
});
