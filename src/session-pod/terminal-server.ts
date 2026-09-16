import { spawn as childSpawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { PassThrough } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { WsMessageSchema, clampTerminalSize } from "../terminal-protocol.js";
import { saveUploadStreamToDir, UPLOAD_REQUEST_TIMEOUT_MS, type SaveUploadResult } from "../session-uploads-core.js";
import { AUTO_COMPACT_CHECK_INTERVAL_MS, maybeAutoCompact, type AutoCompactState } from "../session-auto-compact.js";

// Terminal server inside a session pod (#3026). Owns the pod's one tmux session
// and exposes it to Claws over HTTP/WebSocket on the pod's terminal port. Like
// the rest of `session-pod/`, it must not import `config.js`, `log.js` or
// `db.js` (directly or transitively) — the pod has no Claws config or database.

/** tmux socket name, the same one the host backend uses. */
export const TMUX_SOCKET = "claws";
export const TERMINAL_SERVER_PORT = 7681;
const HAS_SESSION_POLL_MS = 5_000;
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
    case "too-many":
    case "session-full": return 400;
    case "write-failed": return 500;
  }
}

/**
 * Ensure tmux session `claws-<id>` exists (creating it at 120×40 with
 * `mouse on`/`set-clipboard on` when absent), then serve:
 * - `GET /healthz` (no auth) — 200 while the tmux session exists, else 503.
 * - `GET /scrollback` — `capture-pane -S -10000` as plain text.
 * - `POST /uploads?name=` — streamed into `uploadDir` under the shared limits.
 * - `WS /pty` — scrollback, then one `tmux attach` pty per socket.
 *
 * Rejects with `TerminalServerStartError` when the tmux session cannot be created.
 * Once `has-session` fails (polled every 5 s, and checked whenever a pty exits)
 * every open socket gets `{type:"exit"}` and is closed, and `onExit(0)` fires
 * once they have closed, so the pod ends Succeeded.
 */
export async function startTerminalServer(opts: TerminalServerOptions): Promise<TerminalServer> {
  const env = opts.env ?? process.env;
  const tmux = opts.tmux ?? createTmuxRunner(env);
  const spawnPty = opts.spawnPty ?? await loadNodePtyFactory();
  const onExit = opts.onExit ?? ((code: number) => process.exit(code));
  const tmuxName = `claws-${opts.sessionId}`;
  const target = `=${tmuxName}`;

  const hasSession = async () => (await tmux(["has-session", "-t", target])).code === 0;

  if (!await hasSession()) {
    const created = await tmux([
      "new-session", "-d", "-s", tmuxName,
      "-x", "120", "-y", "40",
      "-c", opts.cwd,
      ...opts.command,
    ]);
    if (created.code !== 0) {
      throw new TerminalServerStartError(`tmux new-session failed: ${created.stderr.trim() || `exit ${created.code}`}`);
    }
    console.log(`[session-pod] Created tmux session ${tmuxName}`);
    // tmux starts extra windows/panes as login shells, and a login shell's
    // /etc/profile resets PATH — dropping the `gh` shim dir. A non-login shell
    // inherits the session's PATH instead.
    for (const [name, value] of [["mouse", "on"], ["set-clipboard", "on"], ["default-command", DEFAULT_COMMAND]] as const) {
      const res = await tmux(["set-option", "-t", target, name, value]);
      if (res.code !== 0) console.warn(`[session-pod] Failed to set tmux ${name}=${value}: ${res.stderr.trim()}`);
    }
  } else {
    console.log(`[session-pod] Reusing existing tmux session ${tmuxName}`);
  }

  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  let ending = false;

  const capture = async (): Promise<string | null> => {
    const r = await tmux(["capture-pane", "-p", "-S", SCROLLBACK_LINES, "-t", `${target}:`]);
    return r.code === 0 ? r.stdout : null;
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      console.error(`[session-pod] Request failed: ${err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://session-pod");

    if (req.method === "GET" && url.pathname === "/healthz") {
      const ok = !ending && await hasSession();
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
      // save would wait forever and leave its partial file counting against the quota.
      const body = new PassThrough();
      const onClose = () => { if (!req.complete) body.destroy(); };
      req.once("close", onClose);
      req.pipe(body);
      const result = await saveUploadStreamToDir(opts.uploadDir, name, body, (stage, err) => {
        console.warn(`[session-pod] Upload ${stage} failed: ${err}`);
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
      console.error(`[session-pod] Failed to attach to ${tmuxName}: ${err}`);
      ws.close(1011, "Failed to attach terminal");
      return;
    }

    pty.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "output", data }));
    });
    for (const data of pendingInput.splice(0)) pty.write(data);

    pty.onExit(() => {
      ptyExited = true;
      void hasSession().then((alive) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (alive) {
          // Only the bridge died; the browser's reconnect backoff reattaches.
          ws.close(1011, "Terminal bridge exited");
          return;
        }
        endBecauseTmuxGone();
      });
    });
  }

  /**
   * Send `{type:"exit"}` to every open socket and close it, then wait (up to
   * `SOCKET_CLOSE_WAIT_MS`) for every close to finish. `onExit` defaults to
   * `process.exit`, so exiting earlier would cut off buffered frames and the
   * close handshake and the peer would see an abnormal 1006 instead of an ended session.
   */
  async function closeAll(code: number, reason: string): Promise<void> {
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
        ws.send(JSON.stringify({ type: "exit", code: 0 }));
        ws.close(code, reason);
      }
    }));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(closed),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SOCKET_CLOSE_WAIT_MS); }),
    ]);
    clearTimeout(timer);
  }

  function endBecauseTmuxGone(): void {
    if (ending) return;
    ending = true;
    console.log(`[session-pod] tmux session ${tmuxName} has ended — exiting`);
    void closeAll(1000, "Session ended").then(() => onExit(0));
  }

  let polling = false;
  const poll = setInterval(() => {
    if (polling || ending) return;
    polling = true;
    void hasSession().then((alive) => {
      polling = false;
      if (!alive) endBecauseTmuxGone();
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
        log: { info: (msg) => console.log(`[session-pod] ${msg}`), warn: (msg) => console.warn(`[session-pod] ${msg}`) },
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
  console.log(`[session-pod] Terminal server listening on ${opts.host ?? "0.0.0.0"}:${port}`);

  return {
    port,
    async shutdown() {
      if (ending) return;
      ending = true;
      console.log("[session-pod] SIGTERM — killing tmux server");
      await tmux(["kill-server"]);
      await closeAll(1001, "Session pod shutting down");
      onExit(0);
    },
  };
}
