import { spawn as childSpawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { PassThrough } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { WsMessageSchema, clampTerminalSize } from "../terminal-protocol.js";
import { saveUploadStreamToDir, UPLOAD_REQUEST_TIMEOUT_MS, type SaveUploadResult } from "../session-uploads-core.js";
import { AUTO_COMPACT_CHECK_INTERVAL_MS, maybeAutoCompact, type AutoCompactState } from "../session-auto-compact.js";
import { readClaudeSessionUsage } from "../session-usage.js";
import * as log from "./log.js";

// Terminal server inside a session pod (#3026). Owns the pod's one tmux session
// and exposes it to Claws over HTTP/WebSocket on the pod's terminal port. Like
// the rest of `session-pod/`, it must not import `config.js`, `log.js` or
// `db.js` (directly or transitively) — the pod has no Claws config or database;
// it logs through `./log.js`, which wraps the import-free `../log-core.js`.
//
// The session's own pane runs with `remain-on-exit on` (#3311), so when its
// process exits the pane stays behind as a dead pane carrying the exit status.
// That lets the server read the real exit code and capture the final output
// before tearing tmux down. The server tracks that pane by id, not by position:
// windows and panes the operator opens by hand close normally and never end
// the session, and the agent pane dying is noticed whichever pane is active.

/** tmux socket name, the same one the host backend uses. */
export const TMUX_SOCKET = "claws";
export const TERMINAL_SERVER_PORT = 7681;
const HAS_SESSION_POLL_MS = 5_000;
/** Most characters of final output sent in the exit report. */
export const EXIT_REPORT_SCROLLBACK_LIMIT = 50_000;
const EXIT_REPORT_TIMEOUT_MS = 5_000;
/** How long an ending server waits for sockets to finish closing before `onExit`. */
const SOCKET_CLOSE_WAIT_MS = 2_000;
const SCROLLBACK_LINES = "-10000";
/** tmux runs this via `default-shell -c` and sets `SHELL` to that shell, so new panes get a non-login shell. */
export const DEFAULT_COMMAND = 'exec "$SHELL"';

export interface TmuxResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `tmux -L claws <args>`. Never rejects: a spawn failure resolves with a non-zero code. */
export type TmuxRunner = (args: string[]) => Promise<TmuxResult>;

export interface PtyLike {
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => PtyLike;

export function createTmuxRunner(env: NodeJS.ProcessEnv = process.env): TmuxRunner {
  return (args) => new Promise((resolve) => {
    const proc = childSpawn("tmux", ["-L", TMUX_SOCKET, ...args], { env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: 1, stdout, stderr: stderr || String(err) }));
  });
}

/** node-pty, loaded lazily so tests that inject a factory never load the native addon. */
async function loadNodePtyFactory(): Promise<PtyFactory> {
  const pty = await import("node-pty");
  return (file, args, opts) => pty.spawn(file, args, opts);
}

export interface TerminalServerOptions {
  sessionId: string;
  /** Working directory of the tmux session. */
  cwd: string;
  /** Initial process of the tmux session; empty means tmux's default shell. */
  command: string[];
  /** Where `POST /uploads` stores files. */
  uploadDir: string;
  /** Returns the current bearer token (the mounted `terminal-token`). Throwing or "" rejects every request. */
  readToken: () => string;
  /** Environment for tmux (and so the session's processes) and the attach pty. */
  env?: NodeJS.ProcessEnv;
  tmux?: TmuxRunner;
  spawnPty?: PtyFactory;
  host?: string;
  /** Defaults to 7681; 0 picks a free port. */
  port?: number;
  pollIntervalMs?: number;
  /** Auto-compact the session's Claude process once it has been idle for `idleMs` (#3090). Absent means off. */
  autoCompact?: { idleMs: number; claudeHome: string };
  /**
   * Where to POST `{ code, scrollback }` (bearer = `readToken()`) when the
   * session's process exits, so Claws keeps the output after the pod is gone.
   * Absent skips the report.
   */
  exitReportUrl?: string;
  /** Called once when the server decides the process should exit. Defaults to `process.exit`. */
  onExit?: (code: number) => void;
}

export interface TerminalServer {
  /** The bound port. */
  port: number;
  /** SIGTERM path: kill the tmux server, send `{type:"exit"}` and close sockets, exit 0. */
  shutdown(): Promise<void>;
}

export class TerminalServerStartError extends Error {}

/**
 * Constant-time bearer check. Both sides are hashed first so a length mismatch
 * leaks nothing and `timingSafeEqual` always sees equal-length buffers.
 */
export function isAuthorized(header: string | undefined, readToken: () => string): boolean {
  let expected: string;
  try {
    expected = readToken().trim();
  } catch {
    return false;
  }
  if (!expected) return false;
  const match = /^Bearer\s+(\S+)\s*$/.exec(header ?? "");
  if (!match) return false;
  const digest = (v: string) => crypto.createHash("sha256").update(v).digest();
  return crypto.timingSafeEqual(digest(match[1]), digest(expected));
}

function uploadStatus(result: SaveUploadResult): number {
  if (result.ok) return 200;
  switch (result.reason) {
    case "too-large": return 413;
    case "write-failed": return 500;
  }
}

/** Parsed `#{pane_dead} #{pane_dead_status}`: alive, or dead with the process's exit status. */
export type PaneState = { dead: false } | { dead: true; code: number };

/** Parse `display-message -p "#{pane_dead} #{pane_dead_status}"`; a missing or non-numeric status counts as 1. */
export function parsePaneState(stdout: string): PaneState {
  const [dead, status] = stdout.trim().split(/\s+/);
  if (dead !== "1") return { dead: false };
  return { dead: true, code: status !== undefined && /^\d+$/.test(status) ? Number(status) : 1 };
}

/** Pod exit status for a session process exit code: 0 stays 0, anything else lands in 1..255. */
export function podExitCode(code: number): number {
  return code === 0 ? 0 : Math.min(Math.max(code, 1), 255);
}

/**
 * Ensure tmux session `claws-<id>` exists (creating it at 120×40 with
 * `mouse on`/`set-clipboard on` when absent), then serve:
 * - `GET /healthz` (no auth) — 200 while the session's process runs, else 503.
 * - `GET /scrollback` — `capture-pane -S -10000` as plain text.
 * - `POST /uploads?name=` — streamed into `uploadDir` under the shared per-file limit.
 * - `WS /pty` — scrollback, then one `tmux attach` pty per socket.
 *
 * Rejects with `TerminalServerStartError` when the tmux session cannot be created.
 * Once the session process's own pane (tracked by pane id, not whichever pane
 * is active) is dead (polled every 5 s, and checked whenever a pty
 * exits) the server captures the final output, POSTs it with the exit code to
 * `exitReportUrl`, sends every open socket `{type:"exit", code}` with the real
 * code and closes it, kills tmux, and calls `onExit` with the code (clamped to
 * 1..255 when non-zero), so a crash ends the pod Failed. An agent pane or tmux
 * session that is gone entirely (killed) counts as exit 0.
 */
export async function startTerminalServer(opts: TerminalServerOptions): Promise<TerminalServer> {
  const env = opts.env ?? process.env;
  const tmux = opts.tmux ?? createTmuxRunner(env);
  const spawnPty = opts.spawnPty ?? await loadNodePtyFactory();
  const onExit = opts.onExit ?? ((code: number) => process.exit(code));
  const tmuxName = `claws-${opts.sessionId}`;
  const target = `=${tmuxName}`;

  const hasSession = async () => (await tmux(["has-session", "-t", target])).code === 0;
  /** The session process's pane id (`%N`); empty when tmux did not report it, so the active pane is used. */
  let agentPane = "";

  if (!await hasSession()) {
    // Set before the session exists so even an instant crash leaves a dead pane behind.
    const started = await tmux(["start-server"]);
    if (started.code !== 0) log.warn(`tmux start-server failed: ${started.stderr.trim()}`);
    const remain = await tmux(["set-option", "-g", "remain-on-exit", "on"]);
    if (remain.code !== 0) log.warn(`Failed to set tmux remain-on-exit: ${remain.stderr.trim()}`);
    const created = await tmux([
      "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", tmuxName,
      "-x", "120", "-y", "40",
      "-c", opts.cwd,
      ...opts.command,
    ]);
    if (created.code !== 0) {
      throw new TerminalServerStartError(`tmux new-session failed: ${created.stderr.trim() || `exit ${created.code}`}`);
    }
    agentPane = created.stdout.trim();
    log.info(`Created tmux session ${tmuxName}`);
    if (agentPane) {
      // Keep remain-on-exit on the agent pane only, so hand-opened panes close normally.
      const pane = await tmux(["set-option", "-p", "-t", agentPane, "remain-on-exit", "on"]);
      if (pane.code !== 0) log.warn(`Failed to set tmux remain-on-exit on ${agentPane}: ${pane.stderr.trim()}`);
      else {
        const unset = await tmux(["set-option", "-gu", "remain-on-exit"]);
        if (unset.code !== 0) log.warn(`Failed to unset global tmux remain-on-exit: ${unset.stderr.trim()}`);
      }
    }
    // tmux starts extra windows/panes as login shells, and a login shell's
    // /etc/profile resets PATH — dropping the `gh` shim dir. A non-login shell
    // inherits the session's PATH instead.
    for (const [name, value] of [["mouse", "on"], ["set-clipboard", "on"], ["default-command", DEFAULT_COMMAND]] as const) {
      const res = await tmux(["set-option", "-t", target, name, value]);
      if (res.code !== 0) log.warn(`Failed to set tmux ${name}=${value}: ${res.stderr.trim()}`);
    }
  } else {
    log.info(`Reusing existing tmux session ${tmuxName}`);
    const panes = await tmux(["list-panes", "-t", `${target}:0`, "-F", "#{pane_id}"]);
    if (panes.code === 0) agentPane = panes.stdout.trim().split("\n")[0]?.trim() ?? "";
  }
  if (!agentPane) log.warn(`Could not find the pane id for ${tmuxName}; watching the active pane`);
  const agentTarget = agentPane || `${target}:`;

  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  let ending = false;

  const capture = async (paneTarget = `${target}:`): Promise<string | null> => {
    const r = await tmux(["capture-pane", "-p", "-S", SCROLLBACK_LINES, "-t", paneTarget]);
    return r.code === 0 ? r.stdout : null;
  };

  /** The agent pane's state, or `null` when that pane or the whole tmux session is gone. */
  const paneState = async (): Promise<PaneState | null> => {
    const r = await tmux(["display-message", "-p", "-t", agentTarget, "#{pane_id} #{pane_dead} #{pane_dead_status}"]);
    if (r.code !== 0) return null;
    const [paneId, ...rest] = r.stdout.trim().split(/\s+/);
    // tmux falls back to the current pane for an unknown pane id, so check it is still ours.
    if (agentPane && paneId !== agentPane) return null;
    return parsePaneState(rest.join(" "));
  };

  /** The exit code once the session's process has ended, `null` while it runs. */
  const exitedCode = async (): Promise<number | null> => {
    const state = await paneState();
    if (state === null) return 0;
    return state.dead ? state.code : null;
  };

  const sessionCreatedAt = async (): Promise<number> => {
    const r = await tmux(["display-message", "-p", "-t", `${target}:`, "#{session_created}"]);
    const secs = Number(r.stdout.trim());
    return r.code === 0 && Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      log.error(`Request failed: ${err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://session-pod");

    if (req.method === "GET" && url.pathname === "/healthz") {
      const ok = !ending && await exitedCode() === null;
      res.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain" });
      res.end(ok ? "ok" : "tmux session not running");
      return;
    }

    if (!isAuthorized(req.headers.authorization, opts.readToken)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      req.resume();
      return;
    }

    if (req.method === "GET" && url.pathname === "/scrollback") {
      const text = await capture();
      if (text === null) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("tmux session not running");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
      return;
    }

    if (req.method === "GET" && url.pathname === "/usage") {
      const snapshot = await readClaudeSessionUsage({
        claudeHome: opts.autoCompact?.claudeHome ?? env.HOME ?? process.cwd(),
        cwd: opts.cwd,
        sinceMs: await sessionCreatedAt(),
      });
      if (!snapshot) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(snapshot));
      return;
    }

    if (req.method === "POST" && url.pathname === "/uploads") {
      const name = url.searchParams.get("name");
      if (!name) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "write-failed", detail: "missing name" }));
        req.resume();
        return;
      }
      // Pipe through a PassThrough so a mid-stream limit rejection destroys
      // only that stream, not the request socket we still need to answer on.
      // `pipe` does not forward a client abort, so end `body` ourselves or the
      // save would wait forever and leave its partial file behind.
      const body = new PassThrough();
      const onClose = () => { if (!req.complete) body.destroy(); };
      req.once("close", onClose);
      req.pipe(body);
      const result = await saveUploadStreamToDir(opts.uploadDir, name, body, (stage, err) => {
        log.warn(`Upload ${stage} failed: ${err}`);
      });
      req.off("close", onClose);
      req.unpipe(body);
      const payload = JSON.stringify(result);
      if (result.ok || req.complete) {
        res.writeHead(uploadStatus(result), { "Content-Type": "application/json" });
        res.end(payload);
      } else {
        // The client is still sending a body we refused; answer, then drop the connection.
        res.writeHead(uploadStatus(result), { "Content-Type": "application/json", Connection: "close" });
        res.end(payload, () => req.destroy());
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }

  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://session-pod");
    if (url.pathname !== "/pty") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!isAuthorized(req.headers.authorization, opts.readToken)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    if (ending) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => { void handlePty(ws); });
  });

  async function handlePty(ws: WebSocket): Promise<void> {
    sockets.add(ws);
    let pty: PtyLike | null = null;
    let ptyExited = false;
    // The browser sends its size on open, while scrollback is still being
    // captured; keep the latest size and any input for when the pty spawns.
    let pendingSize = { cols: 120, rows: 40 };
    const pendingInput: string[] = [];

    ws.on("message", (raw: Buffer | string) => {
      if (ptyExited) return;
      try {
        const parsed = WsMessageSchema.safeParse(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
        if (!parsed.success) return;
        const msg = parsed.data;
        if (msg.type === "input") {
          if (pty) pty.write(msg.data);
          else pendingInput.push(msg.data);
        } else {
          const { cols, rows } = clampTerminalSize(msg.cols, msg.rows);
          if (pty) pty.resize(cols, rows);
          else pendingSize = { cols, rows };
        }
      } catch {
        // Ignore malformed frames.
      }
    });

    ws.on("close", () => {
      sockets.delete(ws);
      if (pty && !ptyExited) {
        ptyExited = true;
        try {
          pty.kill();
        } catch {
          // Already gone.
        }
      }
    });

    const scrollback = await capture();
    if (ws.readyState !== WebSocket.OPEN) return;
    // capture-pane emits bare LFs; the browser terminal needs CRLF to return to column 0.
    if (scrollback) ws.send(JSON.stringify({ type: "scrollback", data: scrollback.replace(/\r?\n/g, "\r\n") }));

    try {
      pty = spawnPty("tmux", ["-L", TMUX_SOCKET, "attach-session", "-t", target], {
        name: "xterm-256color",
        cols: pendingSize.cols,
        rows: pendingSize.rows,
        cwd: opts.cwd,
        env: { ...env, TERM: "xterm-256color" },
      });
    } catch (err) {
      log.error(`Failed to attach to ${tmuxName}: ${err}`);
      ws.close(1011, "Failed to attach terminal");
      return;
    }

    pty.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "output", data }));
    });
    for (const data of pendingInput.splice(0)) pty.write(data);

    pty.onExit(() => {
      ptyExited = true;
      void exitedCode().then((code) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (code === null) {
          // Only the bridge died; the browser's reconnect backoff reattaches.
          ws.close(1011, "Terminal bridge exited");
          return;
        }
        void endBecauseProcessExited(code);
      });
    });
  }

  /**
   * Send `{type:"exit", code: exitCode}` to every open socket and close it with
   * `closeCode`, then wait (up to `SOCKET_CLOSE_WAIT_MS`) for every close to
   * finish. `onExit` defaults to `process.exit`, so exiting earlier would cut off
   * buffered frames and the close handshake and the peer would see an abnormal
   * 1006 instead of an ended session.
   */
  async function closeAll(exitCode: number, closeCode: number, reason: string): Promise<void> {
    clearInterval(poll);
    clearInterval(autoCompactTimer);
    server.close();
    const closed = [...sockets].map((ws) => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close(closeCode, reason);
      }
    }));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(closed),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SOCKET_CLOSE_WAIT_MS); }),
    ]);
    clearTimeout(timer);
  }

  /** Best-effort POST of the exit code and final output to Claws; never throws. */
  async function reportExit(code: number, scrollback: string): Promise<void> {
    if (!opts.exitReportUrl) return;
    try {
      const res = await fetch(opts.exitReportUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.readToken().trim()}` },
        body: JSON.stringify({ code, scrollback: scrollback.trimEnd().slice(-EXIT_REPORT_SCROLLBACK_LIMIT) }),
        signal: AbortSignal.timeout(EXIT_REPORT_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (!res.ok) log.warn(`Exit report rejected: HTTP ${res.status}`);
    } catch (err) {
      log.warn(`Exit report failed: ${err}`);
    }
  }

  async function endBecauseProcessExited(code: number): Promise<void> {
    if (ending) return;
    ending = true;
    // Capture while the dead pane still exists; kill-server below removes it.
    const scrollback = await capture(agentTarget) ?? "";
    log.info(`Session process exited with code ${code} — exiting`);
    await Promise.all([reportExit(code, scrollback), closeAll(code, 1000, "Session ended")]);
    await tmux(["kill-server"]);
    onExit(podExitCode(code));
  }

  let polling = false;
  const poll = setInterval(() => {
    if (polling || ending) return;
    polling = true;
    void exitedCode().then((code) => {
      polling = false;
      if (code !== null) void endBecauseProcessExited(code);
    });
  }, opts.pollIntervalMs ?? HAS_SESSION_POLL_MS);

  let autoCompactTimer: NodeJS.Timeout | undefined;
  const autoCompact = opts.autoCompact;
  if (autoCompact && autoCompact.idleMs > 0) {
    // Transcripts from before this server started belong to an earlier process.
    const sinceMs = Date.now();
    const state: AutoCompactState = { lastAttemptTurnAt: null };
    let compacting = false;
    autoCompactTimer = setInterval(() => {
      if (compacting || ending) return;
      compacting = true;
      void maybeAutoCompact({
        tmux,
        tmuxName,
        claudeHome: autoCompact.claudeHome,
        cwd: opts.cwd,
        sinceMs,
        idleMs: autoCompact.idleMs,
        state,
        log: { info: (msg) => log.info(msg), warn: (msg) => log.warn(msg) },
      }).finally(() => { compacting = false; });
    }, AUTO_COMPACT_CHECK_INTERVAL_MS);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? TERMINAL_SERVER_PORT, opts.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((err) => {
    clearInterval(poll);
    clearInterval(autoCompactTimer);
    throw new TerminalServerStartError(`listen failed: ${err}`);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? TERMINAL_SERVER_PORT);
  log.info(`Terminal server listening on ${opts.host ?? "0.0.0.0"}:${port}`);

  return {
    port,
    async shutdown() {
      if (ending) return;
      ending = true;
      log.info("SIGTERM — killing tmux server");
      await tmux(["kill-server"]);
      await closeAll(0, 1001, "Session pod shutting down");
      onExit(0);
    },
  };
}
