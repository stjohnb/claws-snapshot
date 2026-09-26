import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { AUTO_COMPACT_CHECK_INTERVAL_MS, maybeAutoCompact } from "../session-auto-compact.js";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "../session-uploads-core.js";
import {
  DEFAULT_COMMAND,
  isAuthorized,
  parsePaneState,
  podExitCode,
  startTerminalServer,
  TerminalServerStartError,
  type PtyLike,
  type TerminalServer,
  type TmuxResult,
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
    calls: [] as string[][],
    scrollback: "line one\nline two\n",
    captureGate: null as Promise<void> | null,
  };
  const run = vi.fn(async (args: string[]): Promise<TmuxResult> => {
    state.calls.push(args);
    switch (args[0]) {
      case "has-session": return { code: state.exists ? 0 : 1, stdout: "", stderr: "" };
      case "display-message": {
        if (args.at(-1) !== "#{pane_id} #{pane_dead} #{pane_dead_status}") return { code: 0, stdout: "", stderr: "" };
        if (!state.exists) return { code: 1, stdout: "", stderr: "no server running" };
        // Like tmux, a target of the session (not a pane id) resolves to the active pane.
        const side = args[3] !== "%0" && state.sidePane?.active ? state.sidePane : null;
        const [id, dead] = side ? ["%1", side.deadStatus] : ["%0", state.deadStatus];
        return { code: 0, stdout: dead === null ? `${id} 0 \n` : `${id} 1 ${dead}\n`, stderr: "" };
      }
      case "list-panes": return { code: 0, stdout: state.agentPaneId ? `${state.agentPaneId}\n` : "", stderr: "" };
      case "new-session":
        if (initial.createFails) return { code: 1, stdout: "", stderr: "no server" };
        state.exists = true;
        return { code: 0, stdout: state.agentPaneId ? `${state.agentPaneId}\n` : "", stderr: "" };
      case "capture-pane":
        await state.captureGate;
        return state.exists ? { code: 0, stdout: state.scrollback, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      case "kill-server": state.exists = false; return { code: 0, stdout: "", stderr: "" };
      default: return { code: 0, stdout: "", stderr: "" };
    }
  });
  return { state, run };
}

function fakePtyFactory() {
  const ptys: Array<PtyLike & { emitData(d: string): void; emitExit(code: number): void; written: string[]; resizes: number[][]; killed: boolean; args: string[]; size: number[] }> = [];
  const factory = vi.fn((_file: string, args: string[], opts: { cols: number; rows: number }) => {
    let dataCb: ((d: string) => void) | null = null;
    let exitCb: ((e: { exitCode: number }) => void) | null = null;
    const p = {
      args,
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
  let tmux: ReturnType<typeof fakeTmux>;
  let pty: ReturnType<typeof fakePtyFactory>;
  const openSockets: WebSocket[] = [];

  async function start(opts: { exists?: boolean; createFails?: boolean; pollIntervalMs?: number; autoCompact?: { idleMs: number; claudeHome: string }; exitReportUrl?: string } = {}) {
    tmux = fakeTmux({ exists: opts.exists ?? false, createFails: opts.createFails });
    pty = fakePtyFactory();
    server = await startTerminalServer({
      sessionId: "abc",
      cwd: "/home/claws/work/org/app",
      command: ["claude", "--dangerously-skip-permissions"],
      uploadDir,
      readToken: () => TOKEN,
      tmux: tmux.run,
      spawnPty: pty.factory,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: opts.pollIntervalMs ?? 60_000,
      onExit: (code) => exits.push(code),
      ...(opts.autoCompact ? { autoCompact: opts.autoCompact } : {}),
      ...(opts.exitReportUrl ? { exitReportUrl: opts.exitReportUrl } : {}),
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
    server = null;
  });

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) ws.terminate();
    if (server) await server.shutdown();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it("creates the tmux session with size and options when absent", async () => {
    await start();
    expect(tmux.state.calls).toContainEqual([
      "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "claws-abc", "-x", "120", "-y", "40", "-c", "/home/claws/work/org/app",
      "claude", "--dangerously-skip-permissions",
    ]);
    expect(tmux.state.calls).toContainEqual(["set-option", "-t", "=claws-abc", "mouse", "on"]);
    expect(tmux.state.calls).toContainEqual(["set-option", "-t", "=claws-abc", "set-clipboard", "on"]);
    // New panes must be non-login shells so /etc/profile cannot drop the gh shim from PATH.
    expect(tmux.state.calls).toContainEqual(["set-option", "-t", "=claws-abc", "default-command", DEFAULT_COMMAND]);
  });

  it("sets remain-on-exit globally before creating the session so an instant crash keeps a dead pane", async () => {
    await start();
    const names = tmux.state.calls.map((c) => c.join(" "));
    const startServer = names.indexOf("start-server");
    const remain = names.indexOf("set-option -g remain-on-exit on");
    const created = names.findIndex((c) => c.startsWith("new-session"));
    expect(startServer).toBeGreaterThanOrEqual(0);
    expect(remain).toBeGreaterThan(startServer);
    expect(created).toBeGreaterThan(remain);
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
      sessionId: "abc", cwd: "/tmp", command: ["claude"], uploadDir, readToken: () => TOKEN,
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

  it("does not recreate an existing tmux session", async () => {
    await start({ exists: true });
    expect(tmux.state.calls.map((c) => c[0])).not.toContain("new-session");
    // The agent pane is the first pane of window 0.
    expect(tmux.state.calls).toContainEqual(["list-panes", "-t", "=claws-abc:0", "-F", "#{pane_id}"]);
  });

  it("rejects when tmux cannot create the session", async () => {
    await expect(start({ createFails: true })).rejects.toBeInstanceOf(TerminalServerStartError);
  });

  it("serves /healthz without auth: 200 while tmux exists, 503 once gone", async () => {
    const base = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    tmux.state.exists = false;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
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
    tmux.state.exists = false;
    socket.write("GET /pty HTTP/1.1\r\nHost: session-pod\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    expect((await response).split(" ")[1]).toBe("401");
    await waitFor(() => exits.length === 1);
    socket.destroy();
  });

  it("returns capture-pane scrollback", async () => {
    const base = await start();
    const res = await fetch(`${base}/scrollback`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("line one\nline two\n");
    expect(tmux.state.calls).toContainEqual(["capture-pane", "-p", "-S", "-10000", "-t", "=claws-abc:"]);
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

  it("sends exit and exits 0 when the pty exits because tmux is gone", async () => {
    const base = await start();
    const client = connect(base);
    await client.opened;
    await waitFor(() => pty.ptys.length === 1);
    tmux.state.exists = false;
    pty.ptys[0].emitExit(0);
    expect((await client.closed).code).toBe(1000);
    expect(client.messages).toContainEqual({ type: "exit", code: 0 });
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([0]);
  });

  it("sends exit to every socket, not just the one whose pty exited", async () => {
    const base = await start();
    const a = connect(base);
    const b = connect(base);
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => pty.ptys.length === 2);
    tmux.state.exists = false;
    pty.ptys[0].emitExit(0);
    expect((await a.closed).code).toBe(1000);
    expect((await b.closed).code).toBe(1000);
    expect(a.messages).toContainEqual({ type: "exit", code: 0 });
    expect(b.messages).toContainEqual({ type: "exit", code: 0 });
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([0]);
  });

  it("exits 0 and closes sockets once the poll finds the tmux session gone", async () => {
    const base = await start({ pollIntervalMs: 20 });
    const client = connect(base);
    await client.opened;
    tmux.state.exists = false;
    expect((await client.closed).code).toBe(1000);
    expect(client.messages).toContainEqual({ type: "exit", code: 0 });
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([0]);
  });

  describe("when the session's process exits", () => {
    let reportServer: http.Server;
    let reports: Array<{ auth: string | undefined; body: { code: number; scrollback: string } }>;
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
      expect(reports).toEqual([{ auth: `Bearer ${TOKEN}`, body: { code: 2, scrollback: "Error: EACCES" } }]);
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

    it("ends with 0 once the agent pane is gone and tmux falls back to another pane", async () => {
      await start({ pollIntervalMs: 20 });
      // tmux resolves an unknown pane id to the current pane.
      tmux.state.sidePane = { deadStatus: null, active: true };
      tmux.run.mockImplementation(async (args: string[]) => {
        tmux.state.calls.push(args);
        if (args[0] === "display-message" && args[3] === "%0") return { code: 0, stdout: "%1 0 \n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      });
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([0]);
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

    it("shutdown does not report", async () => {
      await start({ exitReportUrl: reportUrl });
      await server!.shutdown();
      expect(exits).toEqual([0]);
      expect(reports).toEqual([]);
    });
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
