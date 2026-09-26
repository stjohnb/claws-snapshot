import fs from "node:fs";
import path from "node:path";

// Auto-compaction of idle interactive Claude sessions (#3090). Claude Code's
// prompt cache lives for an hour, so compacting a large context shortly after
// its last turn reads the cached prefix cheaply; coming back hours later would
// re-write the whole context to the cache instead. Shared by the local-tmux
// backend (in Claws) and the session pod's terminal server, so it must not
// import `config.js`, `log.js` or `db.js`, directly or transitively.

/** Sessions whose last turn used less context than this are never compacted. */
export const AUTO_COMPACT_MIN_CONTEXT_TOKENS = 100_000;
export const AUTO_COMPACT_CHECK_INTERVAL_MS = 60_000;

/** Only the end of a transcript is parsed, so huge transcripts stay cheap. */
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
/** How much of a transcript's head is scanned for its `entrypoint`. */
const TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const TRANSCRIPT_HEAD_LINES = 20;
/** Pane commands a live Claude Code process reports. */
const CLAUDE_PANE_COMMANDS = new Set(["claude", "node"]);

/** Runs a tmux command against the session's socket. Never rejects. */
export type AutoCompactTmuxRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

export interface AutoCompactLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Per-session memory, so a turn is attempted at most once even when the attempt fails. */
export interface AutoCompactState {
  lastAttemptTurnAt: number | null;
}

export interface TranscriptAssessment {
  /** Timestamp (ms) of the last `user`/`assistant` entry; null when there is none. */
  lastTurnAt: number | null;
  /** The last turn entry is an assistant message that finished (stop reason other than `tool_use`). */
  lastIsEndedAssistantTurn: boolean;
  /** Input + cache-creation + cache-read tokens of the last assistant message. */
  contextTokens: number;
  /** A `compact_boundary` follows the last assistant entry. */
  compactedSinceLastTurn: boolean;
}

/** Claude Code's per-project transcript dir: every non-alphanumeric character of `cwd` becomes `-`. */
export function claudeProjectDir(claudeHome: string, cwd: string): string {
  return path.join(claudeHome, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

async function readHead(file: string): Promise<string> {
  const handle = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readTail(file: string): Promise<string> {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    if (start === 0) return text;
    // The first line is cut mid-entry.
    const nl = text.indexOf("\n");
    return nl === -1 ? "" : text.slice(nl + 1);
  } finally {
    await handle.close();
  }
}

/**
 * The newest transcript in `projectDir` modified at or after `sinceMs` that was
 * written by an interactive CLI. Headless `claude -p` runs (e.g. session
 * summaries in `~`) share the dir but are tagged `"entrypoint":"sdk-cli"`.
 */
export async function findInteractiveTranscript(projectDir: string, sinceMs: number): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.promises.readdir(projectDir);
  } catch {
    return null;
  }
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(projectDir, name);
    try {
      const st = await fs.promises.stat(file);
      if (st.isFile() && st.mtimeMs >= sinceMs) candidates.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      // Removed since readdir.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { file } of candidates) {
    try {
      const head = (await readHead(file)).split("\n").slice(0, TRANSCRIPT_HEAD_LINES);
      if (head.some((line) => line.includes('"entrypoint":"cli"'))) return file;
    } catch {
      // Unreadable; try the next one.
    }
  }
  return null;
}

/** Parse transcript JSONL (lines that fail to parse are skipped). */
export function assessTranscript(text: string): TranscriptAssessment {
  const result: TranscriptAssessment = {
    lastTurnAt: null,
    lastIsEndedAssistantTurn: false,
    contextTokens: 0,
    compactedSinceLastTurn: false,
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      result.compactedSinceLastTurn = true;
      continue;
    }
    if ((entry.type !== "user" && entry.type !== "assistant") || entry.isSidechain === true) continue;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    result.lastTurnAt = Number.isNaN(at) ? null : at;
    if (entry.type === "user") {
      result.lastIsEndedAssistantTurn = false;
      continue;
    }
    const message = (entry.message ?? {}) as { stop_reason?: unknown; usage?: Record<string, unknown> };
    result.lastIsEndedAssistantTurn = typeof message.stop_reason === "string" && message.stop_reason !== "tool_use";
    const usage = message.usage ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    result.contextTokens = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
    result.compactedSinceLastTurn = false;
  }
  return result;
}

/** True when a subagent transcript of this session was modified at or after `sinceMs`. */
export async function hasRecentSubagentActivity(transcriptPath: string, sinceMs: number): Promise<boolean> {
  const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"), "subagents");
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    try {
      if ((await fs.promises.stat(path.join(dir, name))).mtimeMs >= sinceMs) return true;
    } catch {
      // Removed since readdir.
    }
  }
  return false;
}

export function shouldAutoCompact(
  a: TranscriptAssessment,
  opts: { idleMs: number; minTokens: number; nowMs: number; lastAttemptTurnAt: number | null },
): boolean {
  if (opts.idleMs <= 0 || a.lastTurnAt === null) return false;
  if (!a.lastIsEndedAssistantTurn || a.compactedSinceLastTurn) return false;
  if (a.contextTokens < opts.minTokens) return false;
  if (opts.nowMs - a.lastTurnAt < opts.idleMs) return false;
  return opts.lastAttemptTurnAt !== a.lastTurnAt;
}

export interface MaybeAutoCompactOptions {
  tmux: AutoCompactTmuxRunner;
  /** tmux session name, `claws-<id>`. */
  tmuxName: string;
  /** Directory holding `.claude` (the session's HOME). */
  claudeHome: string;
  /** Working directory the session's Claude process was started in. */
  cwd: string;
  /** Transcripts last modified before this are ignored (when the session's process started). */
  sinceMs: number;
  idleMs: number;
  state: AutoCompactState;
  log: AutoCompactLogger;
  now?: () => number;
  minTokens?: number;
}

export type AutoCompactResult = "compacted" | "skipped";

/**
 * Type `/compact` into an idle Claude session's pane when its transcript shows
 * a large, finished, not-yet-compacted turn older than `idleMs`, no subagent is
 * active, and the pane is running Claude outside copy mode. Never throws.
 */
export async function maybeAutoCompact(opts: MaybeAutoCompactOptions): Promise<AutoCompactResult> {
  try {
    const nowMs = (opts.now ?? Date.now)();
    if (opts.idleMs <= 0) return "skipped";
    const transcript = await findInteractiveTranscript(claudeProjectDir(opts.claudeHome, opts.cwd), opts.sinceMs);
    if (!transcript) return "skipped";
    const assessment = assessTranscript(await readTail(transcript));
    const eligible = shouldAutoCompact(assessment, {
      idleMs: opts.idleMs,
      minTokens: opts.minTokens ?? AUTO_COMPACT_MIN_CONTEXT_TOKENS,
      nowMs,
      lastAttemptTurnAt: opts.state.lastAttemptTurnAt,
    });
    if (!eligible || assessment.lastTurnAt === null) return "skipped";
    if (await hasRecentSubagentActivity(transcript, nowMs - opts.idleMs)) return "skipped";

    const target = `=${opts.tmuxName}:`;
    const pane = await opts.tmux(["display-message", "-p", "-t", target, "#{pane_current_command} #{pane_in_mode}"]);
    if (pane.code !== 0) return "skipped";
    const [command, inMode] = pane.stdout.trim().split(/\s+/);
    if (!CLAUDE_PANE_COMMANDS.has(command ?? "") || inMode === "1") return "skipped";

    opts.state.lastAttemptTurnAt = assessment.lastTurnAt;
    const typed = await opts.tmux(["send-keys", "-t", target, "-l", "/compact"]);
    if (typed.code !== 0) {
      opts.log.warn(`Failed to type /compact into ${opts.tmuxName}`);
      return "skipped";
    }
    const entered = await opts.tmux(["send-keys", "-t", target, "Enter"]);
    if (entered.code !== 0) {
      opts.log.warn(`Failed to submit /compact in ${opts.tmuxName}`);
      return "skipped";
    }
    const idleMinutes = Math.round((nowMs - assessment.lastTurnAt) / 60_000);
    opts.log.info(`Auto-compacted idle session ${opts.tmuxName.replace(/^claws-/, "")} (${assessment.contextTokens} tokens, idle ${idleMinutes}m)`);
    return "compacted";
  } catch (err) {
    opts.log.warn(`Auto-compact check failed for ${opts.tmuxName}: ${err}`);
    return "skipped";
  }
}
