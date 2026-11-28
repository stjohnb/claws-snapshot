import { spawn as childSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { PassThrough } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { WsMessageSchema, clampTerminalSize } from "../terminal-protocol.js";
import { MAX_UPLOAD_BYTES, saveUploadStreamToDir, UPLOAD_REQUEST_TIMEOUT_MS, type SaveUploadResult } from "../session-uploads-core.js";
import {
  AUTO_COMPACT_CHECK_INTERVAL_MS,
  claudeProjectDir,
  findInteractiveTranscript,
  maybeAutoCompact,
  type AutoCompactState,
} from "../session-auto-compact.js";
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
//
// The tmux server and every attach pty run with `COLORTERM=truecolor` and
// `CLAUDE_CODE_TMUX_TRUECOLOR=1`, and a fresh server is told the browser
// terminal supports RGB (`terminal-features ",xterm-256color:RGB"`), so agents
// render 24-bit color through tmux to xterm.js (tmux 3.3a detects neither).

/** tmux socket name, the same one the host backend uses. */
export const TMUX_SOCKET = "claws";
export const TERMINAL_SERVER_PORT = 7681;
const HAS_SESSION_POLL_MS = 5_000;
/** How many times an unclear agent-pane query is asked again before the agent process decides. */
export const EXIT_CONFIRM_RETRIES = 3;
/** Pause between those re-queries. */
export const EXIT_CONFIRM_DELAY_MS = 2_000;
/** Most characters of tmux output put on a failed-query log line. */
const TMUX_LOG_OUTPUT_LIMIT = 500;
/** Most characters of final output sent in the exit report. */
export const EXIT_REPORT_SCROLLBACK_LIMIT = 50_000;
const EXIT_REPORT_TIMEOUT_MS = 5_000;
/** How long an ending server waits for sockets to finish closing before `onExit`. */
const SOCKET_CLOSE_WAIT_MS = 2_000;
const SCROLLBACK_LINES = "-10000";
/** Longest `POST /notify` body, in bytes. */
export const NOTIFY_MAX_BYTES = 1024;
/** Pause between typing a notice and pressing Enter, so the agent's TUI sees a paste, then a submit. */
export const NOTIFY_SUBMIT_DELAY_MS = 150;
/** Longest `POST /input` body (the chat composer's text), in bytes. */
export const INPUT_MAX_BYTES = 64 * 1024;
/** The tmux paste buffer `POST /input` loads and pastes from. */
export const INPUT_BUFFER_NAME = "claws-chat";
/**
 * A first `GET /transcript` read, or one after the transcript rotated, starts
 * this many slimmed bytes before the end: each line costs its raw length, capped
 * at `TRANSCRIPT_SLIM_LINE_BYTES`, so a few base64 photos cannot push earlier turns out.
 */
export const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
/** Most bytes of transcript lines, as sent (raw or slimmed), in one `GET /transcript` reply; a line still longer once slimmed becomes an oversize stub. */
export const TRANSCRIPT_REPLY_MAX_BYTES = 512 * 1024;
/** A transcript line longer than this many bytes is slimmed (`slimTranscriptLine`) before it is sent. */
export const TRANSCRIPT_SLIM_LINE_BYTES = 64 * 1024;
/** Longest string a slimmed line keeps, in characters; base64 payloads are emptied whatever their length. */
export const TRANSCRIPT_SLIM_STRING_CHARS = 32 * 1024;
/** Largest transcript line read into memory to slim, in bytes; a longer one becomes an oversize stub unread. */
export const TRANSCRIPT_SLIM_READ_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Most raw transcript bytes one `GET /transcript` reply steps past (the first
 * line always goes), so a run of large image lines cannot keep a reply past the
 * web tier's pod timeout; the client resumes from `next`.
 */
export const TRANSCRIPT_READ_MAX_RAW_BYTES = 64 * 1024 * 1024;
/** Chunk size for scanning a transcript for newlines. */
const TRANSCRIPT_SCAN_BYTES = 64 * 1024;
/** Window for the forward read of transcript lines; holds any line up to `TRANSCRIPT_SLIM_LINE_BYTES` whole. */
const TRANSCRIPT_READ_WINDOW_BYTES = 256 * 1024;
/** tmux runs this via `default-shell -c` and sets `SHELL` to that shell, so new panes get a non-login shell. */
export const DEFAULT_COMMAND = 'exec "$SHELL"';

export interface TmuxResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The signal that ended tmux, when one did; absent from fakes and a spawn failure. */
  signal?: string | null;
}

/** `base` plus the variables that tell agents (and Claude Code under tmux) 24-bit color is available. */
export function terminalColorEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, COLORTERM: "truecolor", CLAUDE_CODE_TMUX_TRUECOLOR: "1" };
}

/** Runs `tmux -L claws <args>`, writing `stdin` (when given) to its standard input, and resolves once its output is fully read. Never rejects: a spawn failure resolves with a non-zero code. */
export type TmuxRunner = (args: string[], stdin?: string) => Promise<TmuxResult>;

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
  return (args, stdin) => new Promise((resolve) => {
    const proc = childSpawn("tmux", ["-L", TMUX_SOCKET, ...args], { env });
    let stdout = "";
    let stderr = "";
    if (stdin !== undefined) {
      // A tmux that exits before reading all of stdin surfaces as EPIPE here; its exit code reports the failure.
      proc.stdin.on("error", () => {});
      proc.stdin.end(stdin);
    }
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    // `close`, not `exit`: Node can emit `exit` before stdout has been read, and
    // an empty answer with code 0 once ended live sessions (#clw_01M8997QNSAC11ZBBCZ4HCNVVC).
    proc.on("close", (code, signal) => resolve({ code: code ?? 1, stdout, stderr, signal: signal ?? null }));
    proc.on("error", (err) => resolve({ code: 1, stdout, stderr: stderr || String(err), signal: null }));
  });
}

/** node-pty, loaded lazily so tests that inject a factory never load the native addon. */
async function loadNodePtyFactory(): Promise<PtyFactory> {
  const pty = await import("node-pty");
  return (file, args, opts) => pty.spawn(file, args, opts);
}

/**
 * Which live grants the pod's mounted Secret carries now: the
 * `# claws-granted:` marker lines of `granted-env`, and which runtime SSH
 * keys are in place. Never values.
 */
export interface MountedGrants {
  envMarkers: string[];
  sshKeys: boolean;
  /** Aliases with a runtime key and certificate in place; absent from a pod launched before per-alias certificates. */
  sshAliases?: string[];
}

export interface TerminalServerOptions {
  sessionId: string;
  /** Working directory of the tmux session. */
  cwd: string;
  /** Initial process of the tmux session; empty means tmux's default shell. */
  command: string[];
  /** Where `POST /uploads` stores files. */
  uploadDir: string;
  /** The session's HOME: `GET /files` serves only files that resolve inside it or a `scratchRoots` entry. */
  home: string;
  /**
   * Further directories `GET /files` serves from: the Claude Code scratchpad
   * root. Each is resolved through symlinks per request; a missing one is
   * skipped. Defaults to `<os.tmpdir()>/claude-<uid>`.
   */
  scratchRoots?: string[];
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
  /** Answers `GET /grants`; absent means 404, as on a pod launched before the route existed. */
  inspectGrants?: () => MountedGrants;
  /** Waits between typing a `POST /notify` notice and pressing Enter, and between exit re-checks; tests inject it. */
  sleep?: (ms: number) => Promise<void>;
  /** Whether a pid still exists; defaults to `isProcessAlive`. Tests inject it. */
  isProcessAlive?: (pid: number) => boolean;
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

/**
 * Remove every entry inside `dir`, keeping `dir` itself, and return how many
 * were removed. Never throws: a failure is logged as a warn and counted as 0
 * removed for that entry. A missing `dir` removes nothing.
 */
export async function purgeUploadDir(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`Upload purge failed to list ${dir}: ${err}`);
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    try {
      await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn(`Upload purge failed to remove ${name}: ${err}`);
    }
  }
  return removed;
}

/** Whether process `pid` exists: `kill(pid, 0)` succeeds or fails with anything but `ESRCH` (`EPERM` means alive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * One agent-pane query's answer: the pane runs, is dead with its exit status,
 * or tmux gave no clear answer (`query_failed`: tmux exited non-zero;
 * `pane_mismatch`: an empty or different pane id came back).
 */
export type PaneQuery =
  | { state: "running" }
  | { state: "dead"; code: number }
  | { state: "unknown"; why: "query_failed" | "pane_mismatch" };

/** Which check ended a session: the 5 s poll or a pty exiting. */
export type EndCheck = "poll" | "pty-exit";

/** Why a session ended: its pane died, or (confirmed, agent gone) the tmux server or the pane vanished. */
export type EndReason = "pane_dead" | "tmux_gone" | "pane_gone";

/** Parsed `#{pane_dead} #{pane_dead_status}`: alive, or dead with the process's exit status. */
export type PaneState = { dead: false } | { dead: true; code: number };

/** Parse `display-message -p "#{pane_dead} #{pane_dead_status}"`; a missing or non-numeric status counts as 1. */
export function parsePaneState(stdout: string): PaneState {
  const [dead, status] = stdout.trim().split(/\s+/);
  if (dead !== "1") return { dead: false };
  return { dead: true, code: status !== undefined && /^\d+$/.test(status) ? Number(status) : 1 };
}

/** One `GET /transcript` reply. `file` is the transcript's base name; `next` is the offset to ask for next. */
export interface TranscriptChunk {
  file: string;
  /** Byte offset of the first line returned (always a line start). */
  start: number;
  /** Byte offset just past the last complete line returned; `start` when none is complete yet. */
  next: number;
  size: number;
  /** The read started at the tail, partway through the file, so earlier lines were skipped. */
  truncatedBefore: boolean;
  /**
   * JSONL lines, unparsed: a line up to `TRANSCRIPT_SLIM_LINE_BYTES` raw, a longer
   * one slimmed (`slimTranscriptLine`). A line over `TRANSCRIPT_SLIM_READ_MAX_BYTES`,
   * unparseable, or still over `TRANSCRIPT_REPLY_MAX_BYTES` once slimmed is
   * `{"type":"claws-oversize","bytes":N,"offset":O}`, N its raw length and O its byte offset.
   */
  lines: string[];
}

/** Offset of the first `\n` at or after `from`, or -1 when there is none before `size`. */
async function findNewline(handle: fs.promises.FileHandle, from: number, size: number): Promise<number> {
  const buf = Buffer.alloc(TRANSCRIPT_SCAN_BYTES);
  for (let pos = from; pos < size;) {
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - pos), pos);
    if (bytesRead === 0) return -1;
    const i = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (i !== -1) return pos + i;
    pos += bytesRead;
  }
  return -1;
}

function slimString(text: string): string {
  if (text.length <= TRANSCRIPT_SLIM_STRING_CHARS) return text;
  let keep = TRANSCRIPT_SLIM_STRING_CHARS;
  // Never split a surrogate pair.
  const code = text.charCodeAt(keep - 1);
  if (code >= 0xd800 && code <= 0xdbff) keep -= 1;
  return `${text.slice(0, keep)}\n[… ${text.length - keep} more characters, see the terminal]`;
}

function slimValue(value: unknown): unknown {
  if (typeof value === "string") return slimString(value);
  if (Array.isArray(value)) return value.map(slimValue);
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Record<string, unknown>;
  const base64 = obj.type === "base64" && typeof obj.data === "string" ? obj.data : null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = base64 !== null && k === "data" ? "" : slimValue(v);
  if (base64 !== null) out.claws_bytes = Math.floor(base64.length * 3 / 4);
  return out;
}

/**
 * Slim one transcript line for the chat view: every `{ type: "base64", data }`
 * source has `data` emptied and `claws_bytes` (its decoded size) added, and
 * every other string over `TRANSCRIPT_SLIM_STRING_CHARS` is cut, ending with a
 * marker naming how many characters were removed. Returns the re-serialised
 * JSON, or null when the line does not parse.
 */
export function slimTranscriptLine(line: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return JSON.stringify(slimValue(value));
}

/**
 * Where a fresh read starts: scanning back from the last complete line, each
 * line costs `min(rawLength, TRANSCRIPT_SLIM_LINE_BYTES)`, and the read starts at
 * the earliest line start that keeps the total within `TRANSCRIPT_TAIL_BYTES`.
 * Only newline positions are read; no line is parsed.
 */
async function tailStart(handle: fs.promises.FileHandle, size: number): Promise<number> {
  const buf = Buffer.alloc(TRANSCRIPT_SCAN_BYTES);
  /** Start of the earliest line counted so far; -1 until the last newline is found. */
  let lineStart = -1;
  let total = 0;
  for (let end = size; end > 0;) {
    const from = Math.max(0, end - buf.length);
    const { bytesRead } = await handle.read(buf, 0, end - from, from);
    if (bytesRead === 0) break;
    const view = buf.subarray(0, bytesRead);
    for (let i = view.lastIndexOf(0x0a); i !== -1; i = i > 0 ? view.lastIndexOf(0x0a, i - 1) : -1) {
      const nl = from + i;
      if (lineStart === -1) {
        // The last newline: everything after it is an incomplete line, never returned.
        lineStart = nl + 1;
        continue;
      }
      const cost = Math.min(lineStart - (nl + 1), TRANSCRIPT_SLIM_LINE_BYTES);
      if (total + cost > TRANSCRIPT_TAIL_BYTES) return lineStart;
      total += cost;
      lineStart = nl + 1;
    }
    end = from;
  }
  if (lineStart === -1) return 0;
  // The first line of the file.
  return total + Math.min(lineStart, TRANSCRIPT_SLIM_LINE_BYTES) > TRANSCRIPT_TAIL_BYTES ? lineStart : 0;
}

/**
 * Read the next complete lines of transcript `file` for the chat view. The
 * caller's `requestedFile`/`requestedOffset` resume a previous read; when the
 * file is missing or names another file (the transcript rotated), or the
 * offset is past the end, the read starts at the tail instead (`tailStart`:
 * `TRANSCRIPT_TAIL_BYTES` of slimmed size before the end). A start that is not
 * at a line start skips to the next one, so a partial line is never returned.
 * A line up to `TRANSCRIPT_SLIM_LINE_BYTES` comes back raw and a longer one
 * slimmed (`slimTranscriptLine`); one over `TRANSCRIPT_SLIM_READ_MAX_BYTES`,
 * unparseable, or still over `TRANSCRIPT_REPLY_MAX_BYTES` once slimmed is
 * replaced by an oversize stub and stepped past. At most
 * `TRANSCRIPT_REPLY_MAX_BYTES` of lines, as sent, come back per reply, and the
 * reply ends once it has stepped past `maxRawBytes` of the file
 * (`TRANSCRIPT_READ_MAX_RAW_BYTES`); `start` and `next` are raw byte offsets at
 * line starts.
 */
export async function readTranscriptChunk(
  file: string,
  requestedFile: string | null,
  requestedOffset: number | null,
  maxRawBytes: number = TRANSCRIPT_READ_MAX_RAW_BYTES,
): Promise<TranscriptChunk> {
  const name = path.basename(file);
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    const resume = requestedFile === name && requestedOffset !== null && requestedOffset <= size;
    let start = resume ? requestedOffset : await tailStart(handle, size);
    if (start > 0) {
      const prev = Buffer.alloc(1);
      await handle.read(prev, 0, 1, start - 1);
      if (prev[0] !== 0x0a) {
        const nl = await findNewline(handle, start, size);
        start = nl === -1 ? size : nl + 1;
      }
    }
    const lines: string[] = [];
    let sent = 0;
    let next = start;
    const window = Buffer.alloc(TRANSCRIPT_READ_WINDOW_BYTES);
    /** Bytes of `window` holding the file from `windowAt`. */
    let windowAt = start;
    let windowLen = 0;
    /** Take one line payload unless it would overflow the reply (the first line always fits). */
    const take = (payload: string): boolean => {
      const bytes = Buffer.byteLength(payload);
      if (lines.length > 0 && sent + bytes > TRANSCRIPT_REPLY_MAX_BYTES) return false;
      lines.push(payload);
      sent += bytes;
      return true;
    };
    // Raw bytes stepped past so far is `next - start`; the first line always goes.
    while (next < size && sent < TRANSCRIPT_REPLY_MAX_BYTES && next - start < maxRawBytes) {
      let rel = next - windowAt;
      let nlRel = rel < windowLen ? window.subarray(rel, windowLen).indexOf(0x0a) : -1;
      if (nlRel === -1 && windowAt + windowLen < size) {
        // Refill the window from this line's start.
        windowAt = next;
        rel = 0;
        const { bytesRead } = await handle.read(window, 0, Math.min(window.length, size - next), next);
        windowLen = bytesRead;
        nlRel = window.subarray(0, windowLen).indexOf(0x0a);
      }
      if (nlRel !== -1) {
        const lineLen = nlRel;
        const text = window.subarray(rel, rel + lineLen).toString("utf8");
        let payload: string | null;
        if (text.trim() === "") payload = null;
        else if (lineLen <= TRANSCRIPT_SLIM_LINE_BYTES) payload = text;
        else payload = slimmedOrStub(text, lineLen, next);
        if (payload !== null && !take(payload)) break;
        next += lineLen + 1;
        continue;
      }
      if (windowAt + windowLen >= size) break; // An unterminated last line still being written.
      // A line longer than the window: find its end, then read it whole or stub it.
      const nl = await findNewline(handle, windowAt + windowLen, size);
      if (nl === -1) break;
      const lineLen = nl - next;
      let payload: string;
      if (lineLen > TRANSCRIPT_SLIM_READ_MAX_BYTES) payload = oversizeStub(lineLen, next);
      else {
        const buf = Buffer.alloc(lineLen);
        const { bytesRead } = await handle.read(buf, 0, lineLen, next);
        payload = slimmedOrStub(buf.subarray(0, bytesRead).toString("utf8"), lineLen, next);
      }
      if (!take(payload)) break;
      next = nl + 1;
    }
    return { file: name, start, next, size, truncatedBefore: !resume && start > 0, lines };
  } finally {
    await handle.close();
  }
}

function oversizeStub(bytes: number, offset: number): string {
  return JSON.stringify({ type: "claws-oversize", bytes, offset });
}

/** A long line slimmed, or its oversize stub when it does not parse or is still over `TRANSCRIPT_REPLY_MAX_BYTES`. */
function slimmedOrStub(line: string, bytes: number, offset: number): string {
  const slim = slimTranscriptLine(line);
  return slim === null || Buffer.byteLength(slim) > TRANSCRIPT_REPLY_MAX_BYTES ? oversizeStub(bytes, offset) : slim;
}

/** `"<pane_id> <pane_pid>"` (first line) as the pane id ("" when absent) and pid (null when absent or not a positive integer). */
export function parsePaneIdentity(stdout: string): [string, number | null] {
  const [pane = "", pid] = (stdout.trim().split("\n")[0] ?? "").trim().split(/\s+/);
  const n = pid !== undefined && /^\d+$/.test(pid) ? Number(pid) : 0;
  return [pane, n > 0 ? n : null];
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
 * - `GET /screen` — the agent pane's visible screen only (`capture-pane -e`, SGR colour
 *   kept) as JSON `{ cols, rows, data }` with CRLF line ends; 503 when tmux is gone. A
 *   read-only snapshot for the Sessions list preview, so it never resizes the window.
 * - `POST /uploads?name=` — streamed into `uploadDir` under the shared per-file limit.
 * - `DELETE /uploads` — removes every entry inside `uploadDir` (keeping the directory), 204.
 * - `GET /grants` — the `inspectGrants` answer as JSON (markers and flags, never values).
 * - `GET /files?path=` — one file the session publishes for download (`claws_publish_file`),
 *   resolved against `cwd` and through symlinks, inside HOME or a `scratchRoots` entry; JSON `{ ok: false, reason }` with 400
 *   `outside-home`, 404 `not-found` (missing or not a regular file) or 413 `too-large`
 *   (over the shared per-file limit, with `size`).
 * - `POST /notify` — types one line of plain text (≤ `NOTIFY_MAX_BYTES`) into
 *   the agent's pane and submits it; 400 for an empty, multi-line or oversized
 *   body, 503 when the agent pane is gone.
 * - `GET /transcript?file=&offset=` — complete lines of the live Claude Code
 *   transcript (`readTranscriptChunk`: large lines slimmed, base64 images and
 *   documents emptied with their size kept) as JSON `{ file, start, next, size,
 *   truncatedBefore, lines }`, for the dashboard's chat view; 204 when there is
 *   no interactive transcript yet.
 * - `POST /input` — the chat composer's text (UTF-8, ≤ `INPUT_MAX_BYTES`, may be
 *   multi-line) pasted into the agent's pane as one bracketed paste, then
 *   submitted with Enter; 400 for a blank, oversized or non-UTF-8 body, 503
 *   when the agent pane is gone or a tmux step fails (the body names the step
 *   and tmux's error). `/notify` and `/input` run one at a time, from the pane
 *   check to the final Enter.
 * - `WS /pty` — scrollback, then one `tmux attach` pty per socket. Each resize
 *   (and each attach) also sets the tmux window size, so the latest client to resize wins.
 *
 * Rejects with `TerminalServerStartError` when the tmux session cannot be
 * created; when `exitReportUrl` is set, that failure is also POSTed there as
 * `{ code: 1, scrollback: <tmux's own stderr>, reason: "start_failed" }` first,
 * so a launch failure (e.g. tmux's `command too long`) is not just a bare pod
 * exit code (#clw_01M3HH9MM5J348FTZ4T9AY67Y2).
 * Once the session process's own pane (tracked by pane id, not whichever pane
 * is active) is dead (polled every 5 s, and checked whenever a pty
 * exits) the server captures the final output, POSTs it with the exit code and
 * `reason` to `exitReportUrl`, sends every open socket `{type:"exit", code}` with the real
 * code and closes it, kills tmux, empties `uploadDir`, and calls `onExit` with the code (clamped to
 * 1..255 when non-zero), so a crash ends the pod Failed. A query that gives no
 * clear answer never ends the session on its own (#clw_01M8997QNSAC11ZBBCZ4HCNVVC):
 * it is asked again `EXIT_CONFIRM_RETRIES` times, `EXIT_CONFIRM_DELAY_MS` apart,
 * and only once the agent process no longer exists does a gone tmux server
 * (`tmux_gone`) or gone agent pane (`pane_gone`) end the session, with exit 0.
 * While the agent process lives, tmux is never killed.
 */
/** The Claude Code scratchpad root for this process's uid: `<os.tmpdir()>/claude-<uid>`. */
export function defaultScratchRoot(): string {
  return path.join(os.tmpdir(), `claude-${process.getuid?.() ?? ""}`);
}

export async function startTerminalServer(opts: TerminalServerOptions): Promise<TerminalServer> {
  const env = terminalColorEnv(opts.env ?? process.env);
  const tmux = opts.tmux ?? createTmuxRunner(env);
  const spawnPty = opts.spawnPty ?? await loadNodePtyFactory();
  const onExit = opts.onExit ?? ((code: number) => process.exit(code));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tmuxName = `claws-${opts.sessionId}`;
  const scratchRoots = opts.scratchRoots ?? [defaultScratchRoot()];
  const target = `=${tmuxName}`;

  const hasSession = async () => (await tmux(["has-session", "-t", target])).code === 0;
  /** Sets the session's current window to the client's size; never throws. */
  const resizeWindow = async (cols: number, rows: number): Promise<void> => {
    try {
      const res = await tmux(["resize-window", "-t", `${target}:`, "-x", String(cols), "-y", String(rows)]);
      if (res.code !== 0) log.warn(`tmux resize-window failed: ${res.stderr.trim()}`);
    } catch (err) {
      log.warn(`tmux resize-window failed: ${err}`);
    }
  };
  /** The session process's pane id (`%N`); empty when tmux did not report it, so the active pane is used. */
  let agentPane = "";
  /** The session process's pid, from `#{pane_pid}`; null when tmux did not report it. */
  let agentPid: number | null = null;
  const isAlive = opts.isProcessAlive ?? isProcessAlive;
  /**
   * Tail of the chain that runs `/notify` and `/input` keystroke sequences one
   * at a time, so two requests never share the paste buffer or swap Enters.
   */
  let paneInputTail: Promise<unknown> = Promise.resolve();
  const withPaneInput = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = paneInputTail.then(fn, fn);
    paneInputTail = run.catch(() => undefined);
    return run;
  };

  /** Best-effort POST of the exit code and final output to Claws; never throws. */
  const reportExit = async (code: number, scrollback: string, reason: EndReason | "start_failed"): Promise<void> => {
    if (!opts.exitReportUrl) return;
    try {
      const res = await fetch(opts.exitReportUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.readToken().trim()}` },
        body: JSON.stringify({ code, scrollback: scrollback.trimEnd().slice(-EXIT_REPORT_SCROLLBACK_LIMIT), reason }),
        signal: AbortSignal.timeout(EXIT_REPORT_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (!res.ok) log.warn(`Exit report rejected: HTTP ${res.status}`);
    } catch (err) {
      log.warn(`Exit report failed: ${err}`);
    }
  };

  if (!await hasSession()) {
    // One tmux call: a bare `start-server` exits at once with no sessions, so
    // separate `set-option` calls after it found no server. remain-on-exit is
    // set before the session exists so even an instant crash leaves a dead pane
    // behind; terminal-features is appended (-a) so the default `clipboard`
    // feature stays, and only here, so it never duplicates.
    const created = await tmux([
      "start-server", ";",
      "set-option", "-g", "remain-on-exit", "on", ";",
      "set-option", "-sa", "terminal-features", ",xterm-256color:RGB", ";",
      "new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-s", tmuxName,
      "-x", "120", "-y", "40",
      "-c", opts.cwd,
      ...opts.command,
    ]);
    if (created.code !== 0) {
      const message = `tmux new-session failed: ${created.stderr.trim() || `exit ${created.code}`}`;
      await reportExit(1, message, "start_failed");
      throw new TerminalServerStartError(message);
    }
    [agentPane, agentPid] = parsePaneIdentity(created.stdout);
    log.info(`Created tmux session ${tmuxName}`, { agent_pane: agentPane, agent_pid: agentPid });
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
    // /etc/profile resets PATH — dropping the session's PATH. A non-login shell
    // inherits the session's PATH instead.
    for (const [name, value] of [["mouse", "on"], ["set-clipboard", "on"], ["default-command", DEFAULT_COMMAND]] as const) {
      const res = await tmux(["set-option", "-t", `${target}:`, name, value]);
      if (res.code !== 0) log.warn(`Failed to set tmux ${name}=${value}: ${res.stderr.trim()}`);
    }
  } else {
    log.info(`Reusing existing tmux session ${tmuxName}`);
    const panes = await tmux(["list-panes", "-t", `${target}:0`, "-F", "#{pane_id} #{pane_pid}"]);
    if (panes.code === 0) [agentPane, agentPid] = parsePaneIdentity(panes.stdout);
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

  /** The agent pane's visible screen with SGR colour, or `null` when tmux cannot capture it. */
  const captureScreen = async (): Promise<{ cols: number; rows: number; data: string } | null> => {
    const size = await tmux(["display-message", "-p", "-t", agentTarget, "#{pane_width} #{pane_height}"]);
    const shot = await tmux(["capture-pane", "-p", "-e", "-t", agentTarget]);
    if (shot.code !== 0) return null;
    const [w, h] = size.code === 0 ? size.stdout.trim().split(/\s+/).map(Number) : [];
    // Drop trailing rows with no visible text so a short pane is not scrolled out of view.
    const split = shot.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
    while (split.length > 1 && /^(\x1b\[[0-9;]*m)*\s*$/.test(split[split.length - 1]!)) split.pop();
    const lines = split.length;
    const cols = Number.isInteger(w) && w! > 0 ? w! : 120;
    const rows = Number.isInteger(h) && h! > 0 ? h! : lines;
    return { cols, rows, data: split.join("\r\n") + "\r\n" };
  };

  /**
   * Ask tmux for the agent pane's state. Only `dead` is proof the process
   * ended; a failed query or a pane id that is empty or not ours (tmux falls
   * back to the current pane for an unknown id) is `unknown`, logged at warn
   * with tmux's own answer. `check` names the caller on that line.
   */
  const queryPane = async (check: string): Promise<PaneQuery> => {
    const r = await tmux(["display-message", "-p", "-t", agentTarget, "#{pane_id} #{pane_dead} #{pane_dead_status}"]);
    let why: "query_failed" | "pane_mismatch" | null = null;
    let state: PaneState = { dead: false };
    if (r.code !== 0) why = "query_failed";
    else {
      const [paneId = "", ...rest] = r.stdout.trim().split(/\s+/);
      if (!paneId || (agentPane && paneId !== agentPane)) why = "pane_mismatch";
      else state = parsePaneState(rest.join(" "));
    }
    if (why) {
      log.warn("tmux agent pane query gave no clear answer", undefined, {
        check,
        why,
        tmux_code: r.code,
        tmux_signal: r.signal ?? null,
        tmux_stderr: r.stderr.trim().slice(0, TMUX_LOG_OUTPUT_LIMIT),
        tmux_stdout: r.stdout.trim().slice(0, TMUX_LOG_OUTPUT_LIMIT),
      });
      return { state: "unknown", why };
    }
    return state.dead ? { state: "dead", code: state.code } : { state: "running" };
  };

  /** Where Claude Code keeps `.claude/projects`, for `/usage` and `/transcript`. */
  const claudeHome = opts.autoCompact?.claudeHome ?? env.HOME ?? process.cwd();

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
      // An unclear answer stays 200: one failed query must not drop the pod from its Service.
      const ok = !ending && (await queryPane("healthz")).state !== "dead";
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

    if (req.method === "GET" && url.pathname === "/screen") {
      const screen = await captureScreen();
      if (screen === null) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("tmux session not running");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(screen));
      return;
    }

    if (req.method === "GET" && url.pathname === "/usage") {
      const snapshot = await readClaudeSessionUsage({
        claudeHome,
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

    if (req.method === "GET" && url.pathname === "/transcript") {
      const file = await findInteractiveTranscript(claudeProjectDir(claudeHome, opts.cwd), await sessionCreatedAt());
      const offsetParam = url.searchParams.get("offset");
      const offset = offsetParam !== null && /^\d{1,15}$/.test(offsetParam) ? Number(offsetParam) : null;
      let chunk: TranscriptChunk | null = null;
      if (file) {
        try {
          chunk = await readTranscriptChunk(file, url.searchParams.get("file"), offset);
        } catch (err) {
          // Removed or unreadable since it was found: no transcript to show right now.
          log.warn(`Reading transcript ${path.basename(file)} failed: ${err}`);
        }
      }
      if (!chunk) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(chunk));
      return;
    }

    if (req.method === "GET" && url.pathname === "/grants" && opts.inspectGrants) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(opts.inspectGrants()));
      return;
    }

    if (req.method === "GET" && url.pathname === "/files") {
      serveFile(url.searchParams.get("path") ?? "", res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/notify") {
      const text = await readNotifyBody(req);
      if (text === null) {
        res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
        res.end("notice must be one non-empty line of at most 1 KiB", () => req.destroy());
        return;
      }
      const outcome = await withPaneInput(async (): Promise<"dead" | "failed" | "ok"> => {
        if (ending || (await queryPane("notify")).state !== "running") return "dead";
        // Type the text literally, then press Enter on its own — the browser's
        // paste-then-submit sequence, so the agent's TUI never takes the Enter as pasted text.
        const typed = await tmux(["send-keys", "-t", agentTarget, "-l", text]);
        if (typed.code === 0) await sleep(NOTIFY_SUBMIT_DELAY_MS);
        const submitted = typed.code === 0 ? await tmux(["send-keys", "-t", agentTarget, "Enter"]) : typed;
        return submitted.code === 0 ? "ok" : "failed";
      });
      if (outcome !== "ok") {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("agent pane not running");
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/input") {
      const text = await readInputBody(req);
      if (text === null) {
        res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
        res.end("input must be non-blank UTF-8 text of at most 64 KiB", () => req.destroy());
        return;
      }
      const failure = await withPaneInput(async (): Promise<string | null> => {
        if (ending || (await queryPane("input")).state !== "running") return "agent pane not running";
        // One bracketed paste (-p), so the agent's TUI takes newlines as text, not
        // submits; -d drops the buffer once pasted. Enter on its own submits it.
        const steps: Array<[string, string[], string | undefined]> = [
          ["load into tmux buffer", ["load-buffer", "-b", INPUT_BUFFER_NAME, "-"], text],
          ["paste into agent pane", ["paste-buffer", "-p", "-d", "-b", INPUT_BUFFER_NAME, "-t", agentTarget], undefined],
          ["submit to agent pane", ["send-keys", "-t", agentTarget, "Enter"], undefined],
        ];
        for (const [step, args, stdin] of steps) {
          if (step === "submit to agent pane") await sleep(NOTIFY_SUBMIT_DELAY_MS);
          const result = await tmux(args, stdin);
          if (result.code !== 0) {
            const reason = result.stderr.trim() || `tmux exit ${result.code}`;
            log.warn(`Chat input failed at ${step}: ${reason}`);
            return `${step} failed: ${reason}`;
          }
        }
        return null;
      });
      if (failure !== null) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end(failure);
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/uploads") {
      const removed = await purgeUploadDir(opts.uploadDir);
      log.info(`Purged ${removed} upload(s) on request`);
      res.writeHead(204);
      res.end();
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

  /**
   * `GET /files`: stream one regular file inside HOME or a scratch root. The
   * path is resolved through symlinks before the check, so a link in the
   * worktree or scratchpad cannot reach the mounted Secret or anything else
   * outside those areas.
   */
  function serveFile(requested: string, res: http.ServerResponse): void {
    const refuse = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, ...body }));
    };
    if (!requested) return refuse(404, { reason: "not-found", detail: "missing path" });
    let full: string;
    let home: string;
    try {
      home = fs.realpathSync(opts.home);
      full = fs.realpathSync(path.resolve(opts.cwd, requested));
    } catch {
      return refuse(404, { reason: "not-found" });
    }
    const roots = [home];
    for (const root of scratchRoots) {
      try {
        roots.push(fs.realpathSync(root));
      } catch {
        // No scratchpad yet: nothing to serve from it.
      }
    }
    if (!roots.some((root) => full.startsWith(root + path.sep))) return refuse(400, { reason: "outside-home" });
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      return refuse(404, { reason: "not-found" });
    }
    if (!stat.isFile()) return refuse(404, { reason: "not-found", detail: "not a regular file" });
    if (stat.size > MAX_UPLOAD_BYTES) return refuse(413, { reason: "too-large", size: stat.size });
    const stream = fs.createReadStream(full);
    stream.once("open", () => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(stat.size) });
      stream.pipe(res);
    });
    stream.once("error", (err) => {
      if (!res.headersSent) refuse(404, { reason: "not-found" });
      else res.destroy(err);
    });
  }

  /** A request body of at most `maxBytes`, else null (the rest is left unread). */
  function readCappedBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
    // Not `for await`: leaving it early destroys the socket the 400 is sent on.
    return new Promise<Buffer | null>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size <= maxBytes) {
          chunks.push(chunk);
          return;
        }
        req.off("data", onData);
        req.pause();
        resolve(null);
      };
      req.on("data", onData);
      req.once("end", () => resolve(Buffer.concat(chunks)));
      req.once("error", reject);
    });
  }

  /** A `POST /notify` body: one non-empty line of at most `NOTIFY_MAX_BYTES` (a trailing newline allowed), else null. */
  async function readNotifyBody(req: http.IncomingMessage): Promise<string | null> {
    const body = await readCappedBody(req, NOTIFY_MAX_BYTES);
    if (body === null) return null;
    const text = body.toString("utf8").replace(/\r?\n$/, "");
    return text.trim() === "" || /[\r\n]/.test(text) ? null : text;
  }

  /**
   * A `POST /input` body: valid UTF-8 of at most `INPUT_MAX_BYTES` that is not
   * blank, with CRLF made LF and trailing newlines dropped (Enter is sent
   * separately), else null.
   */
  async function readInputBody(req: http.IncomingMessage): Promise<string | null> {
    const body = await readCappedBody(req, INPUT_MAX_BYTES);
    if (body === null) return null;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return null;
    }
    text = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    return text.trim() === "" ? null : text;
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
          if (pty) {
            pty.resize(cols, rows);
            void resizeWindow(cols, rows);
          } else pendingSize = { cols, rows };
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

    void resizeWindow(pendingSize.cols, pendingSize.rows);
    pty.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "output", data }));
    });
    for (const data of pendingInput.splice(0)) pty.write(data);

    pty.onExit(() => {
      ptyExited = true;
      void queryPane("pty-exit").then((q) => {
        if (q.state === "dead") {
          void endBecauseProcessExited({ code: q.code, reason: "pane_dead", check: "pty-exit", evidence: { pane_dead: true, failed_queries: 0 } });
          return;
        }
        // The bridge died, or tmux gave no clear answer: the browser's reconnect
        // backoff reattaches, and a confirmation decides whether the session ended.
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Terminal bridge exited");
        if (q.state === "unknown") void confirmExit("pty-exit", q);
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

  /** What decided an end: whether tmux showed a dead pane, whether the agent pid existed, whether `has-session` succeeded, and how many queries were unclear. */
  interface EndEvidence {
    pane_dead: boolean;
    agent_alive?: boolean | null;
    has_session?: boolean | null;
    failed_queries: number;
  }

  async function endBecauseProcessExited(end: { code: number; reason: EndReason; check: EndCheck; evidence: EndEvidence }): Promise<void> {
    if (ending) return;
    ending = true;
    const { code, reason, check, evidence } = end;
    // Capture while the dead pane still exists; kill-server below removes it.
    const scrollback = await capture(agentTarget) ?? "";
    log.info(`Session process exited with code ${code} — exiting`, {
      reason,
      check,
      pane_dead: evidence.pane_dead,
      agent_alive: evidence.agent_alive ?? null,
      has_session: evidence.has_session ?? null,
      failed_queries: evidence.failed_queries,
    });
    await Promise.all([reportExit(code, scrollback, reason), closeAll(code, 1000, "Session ended")]);
    await tmux(["kill-server"]);
    // Not in shutdown(): SIGTERM also means a grant relaunch or resume on the same storage.
    const removed = await purgeUploadDir(opts.uploadDir);
    log.info(`Purged ${removed} upload(s) after the session process exited`);
    onExit(podExitCode(code));
  }

  /** A confirmation is running; the poll and pty exits start no second one. */
  let confirming = false;
  /** Unclear queries have been seen with the agent still alive, and that was logged once. */
  let failingStreak = false;

  /**
   * Decide whether the session's process ended. Only a dead pane ends it at
   * once; an `unknown` answer is asked again up to `EXIT_CONFIRM_RETRIES` times,
   * `EXIT_CONFIRM_DELAY_MS` apart. If every answer stays unclear, the session
   * ends (exit 0) only when the agent pid no longer exists — `tmux_gone` when
   * `has-session` fails, else `pane_gone` — or, with no pid known, when
   * `has-session` fails. While the agent lives nothing ends and tmux is never killed.
   */
  async function confirmExit(check: EndCheck, first?: PaneQuery): Promise<void> {
    if (confirming || ending) return;
    confirming = true;
    try {
      let q = first ?? await queryPane(check);
      let failed = 0;
      for (let retry = 0; ; retry++) {
        if (ending) return;
        if (q.state === "running") {
          if (failingStreak) {
            failingStreak = false;
            log.info("tmux pane query recovered; agent pane running", { check, failed_queries: failed });
          }
          return;
        }
        if (q.state === "dead") {
          await endBecauseProcessExited({ code: q.code, reason: "pane_dead", check, evidence: { pane_dead: true, failed_queries: failed } });
          return;
        }
        failed++;
        if (retry >= EXIT_CONFIRM_RETRIES) break;
        await sleep(EXIT_CONFIRM_DELAY_MS);
        if (ending) return;
        q = await queryPane(check);
      }
      const agentAlive = agentPid === null ? null : isAlive(agentPid);
      const sessionThere = agentAlive ? null : await hasSession();
      if (ending) return;
      if (agentAlive || (agentAlive === null && sessionThere)) {
        if (!failingStreak) {
          failingStreak = true;
          const msg = agentAlive
            ? "tmux pane query keeps failing; agent process alive, not ending"
            : "tmux pane query keeps failing; agent pid unknown and tmux session present, not ending";
          log.warn(msg, undefined, { check, agent_pid: agentPid, agent_alive: agentAlive, has_session: sessionThere, failed_queries: failed });
        }
        return;
      }
      await endBecauseProcessExited({
        code: 0,
        reason: sessionThere ? "pane_gone" : "tmux_gone",
        check,
        evidence: { pane_dead: false, agent_alive: agentAlive, has_session: sessionThere, failed_queries: failed },
      });
    } finally {
      confirming = false;
    }
  }

  const poll = setInterval(() => {
    if (confirming || ending) return;
    void confirmExit("poll");
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
