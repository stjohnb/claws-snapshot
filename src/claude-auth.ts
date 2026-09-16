import * as pty from "node-pty";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import * as log from "./log.js";
import { enrichedPath } from "./cli-path.js";
import { noteAgentAuthSuccess } from "./agent-auth-state.js";
import { syncAuthSecret } from "./jobs/auth-secret-sync.js";

/**
 * Server-side orchestration of the `claude setup-token` OAuth flow so the
 * subscription credential can be refreshed from the web UI instead of a
 * cramped browser terminal. `setup-token` opens the same authorization flow
 * as `/login` but, on a headless server, falls back to the paste-code path:
 * it prints an OAuth URL, waits for a code on stdin, then prints a
 * `sk-ant-oat01-…` token. We persist that token as CLAUDE_CODE_OAUTH_TOKEN,
 * which outranks the expired `/login` subscription credential in the CLI's
 * precedence, so subsequent `runClaude`/session spawns pick it up immediately.
 *
 * The PTY is spawned with a very wide `cols` so the long OAuth URL is emitted
 * on a single unwrapped line — that unwrapping is the whole point of the
 * feature (a normal 80/120-col terminal wraps the URL and makes it painful to
 * copy).
 *
 * A rejected code is never retried in place: the CLI parks on a "Press Enter
 * to retry." screen and, on retry, regenerates its PKCE challenge, so the
 * PTY is killed and the caller must start a new login.
 *
 * The code and the Enter key are written to the PTY separately (#3022). The
 * CLI treats a multi-character stdin read longer than ~60 bytes as a paste, so
 * a real `code#state` (~100 chars) written together with its `\r` lands in the
 * input box with the Enter swallowed — the CLI echoes the masked code and then
 * sits idle, never exchanging it, until our submit timeout fires.
 */

const URL_REGEX = /(https?:\/\/\S*(?:oauth|authorize)\S*)/i;
const TOKEN_REGEX = /sk-ant-oat01-[A-Za-z0-9_-]+/;
/**
 * The CLI's paste prompt. The CLI positions words with cursor-movement escapes
 * rather than spaces, so the ANSI-stripped buffer reads `Pastecodehereifprompted>`.
 */
const PASTE_PROMPT_REGEX = /Paste\s*code\s*here\s*if\s*prompted\s*>/i;
/**
 * CLI's client-side format check. NOT retryable in place: the CLI parks on a
 * "Press Enter to retry." screen and discards the PKCE challenge, so the URL
 * that produced this code is dead.
 */
const INVALID_CODE_REGEX = /Invalid code\. Please make sure the full code was copied/;
/** Exchange rejected / flow reset — the auth code is dead, a fresh URL is required. */
const FATAL_ERROR_REGEX =
  /(OAuth error:.*|Token exchange failed|Failed to exchange authorization code for access token[^\n]*|Press Enter to retry\.)/;
/** The CLI's masked echo of a submitted code: a run of `*` followed by its last few characters. */
const CODE_ECHO_REGEX = /\*{4,}/;
/**
 * Fallback for sending Enter when the CLI never echoes the submitted code. Kept
 * long so a CLI that is merely slow to read the code (a busy host) is not given
 * the Enter early, where it would merge into the paste and be swallowed again.
 */
const ENTER_FALLBACK_MS = 3_000;

/**
 * Sanitized outcome of a finished or replaced login attempt, kept after a
 * fresh attempt starts so status can distinguish "submission failed and a new
 * login was started" from "no code was ever submitted". Never contains the
 * authorization URL, code, token or raw terminal output.
 */
export interface ClaudeLoginAttemptSnapshot {
  attemptId: number;
  status: "failed" | "completed" | "superseded";
  phase: "start" | "submit";
  message: string | null;
  occurredAt: string;
  promptReady: boolean;
  supersededByAttemptId?: number;
}

export interface ClaudeLoginStatus {
  status: PendingLogin["status"] | "idle";
  url: string | null;
  error: string | null;
  lastAttempt: ClaudeLoginAttemptSnapshot | null;
  /**
   * Most recent code submission that did not complete (failed, or replaced
   * mid-submission). Kept separately from `lastAttempt` so a failed restart
   * cannot erase the record that a code was submitted; cleared on success.
   */
  lastFailedSubmit: ClaudeLoginAttemptSnapshot | null;
}

interface PendingLogin {
  attemptId: number;
  proc: pty.IPty;
  buffer: string;
  url: string | null;
  /** Whether the CLI's paste prompt has been printed, i.e. it is ready to read a code. */
  promptReady: boolean;
  submittedAt: string | null;
  status: "awaiting-url" | "awaiting-code" | "completed" | "failed";
  error: string | null;
}

let pending: PendingLogin | null = null;
let lastAttempt: ClaudeLoginAttemptSnapshot | null = null;
let lastFailedSubmit: ClaudeLoginAttemptSnapshot | null = null;
let nextAttemptId = 1;

/** Store `snapshot` as `lastAttempt`, tracking unsuccessful submissions in `lastFailedSubmit`. */
function storeSnapshot(snapshot: ClaudeLoginAttemptSnapshot): void {
  lastAttempt = snapshot;
  if (snapshot.phase === "submit") lastFailedSubmit = snapshot.status === "completed" ? null : snapshot;
}

/** Redact any OAuth token from a string before it is returned to the browser. */
function redactToken(s: string): string {
  return s.replace(new RegExp(TOKEN_REGEX.source, "g"), "sk-ant-oat01-[REDACTED]");
}

/**
 * Redact everything secret-shaped from CLI output before it is stored, logged
 * or returned as a diagnostic: tokens, authorization URLs, PKCE/OAuth query
 * parameters that appear outside a URL, and the CLI's masked echo of the
 * submitted code (which leaves its last few characters visible).
 */
function redactDiagnosticText(s: string): string {
  return redactToken(s)
    .replace(/https?:\/\/\S+/gi, "[URL REDACTED]")
    .replace(/\b(code_challenge_method|code_challenge|code_verifier|state|code)=[^\s&]+/gi, "$1=[REDACTED]")
    .replace(/\*{4,}\S*/g, "[masked code]");
}

/** Lines composed only of spinner/progress glyphs, dots or whitespace. */
const NOISE_LINE = /^[·✢*✶✻✽░▒█▄▀▁\s.…]*$/u;

/** Last few meaningful CLI lines, spinner/redraw noise removed, secrets redacted. */
function tailError(buffer: string): string {
  const lines = buffer
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !NOISE_LINE.test(l));
  const deduped = lines.filter((l, i) => l !== lines[i - 1]);
  const joined = redactDiagnosticText(deduped.slice(-4).join(" | "));
  return joined.length > 300 ? `…${joined.slice(-300)}` : joined;
}

/**
 * Record a sanitized snapshot of `state`'s outcome. Ignored for an attempt that
 * has already been replaced, so a superseded PTY's late exit cannot overwrite
 * the snapshot of the attempt that replaced it.
 */
function recordAttempt(
  state: PendingLogin,
  status: ClaudeLoginAttemptSnapshot["status"],
  phase: ClaudeLoginAttemptSnapshot["phase"],
  message: string | null,
  supersededByAttemptId?: number
): void {
  if (pending !== state && supersededByAttemptId === undefined) return;
  storeSnapshot({
    attemptId: state.attemptId,
    status,
    phase,
    message: message === null ? null : redactDiagnosticText(message),
    occurredAt: new Date().toISOString(),
    promptReady: state.promptReady,
    ...(supersededByAttemptId === undefined ? {} : { supersededByAttemptId }),
  });
}

/** Mark `state` failed, record the sanitized snapshot and log it. Returns the stored error. */
function failAttempt(state: PendingLogin, phase: ClaudeLoginAttemptSnapshot["phase"], message: string): string {
  const error = redactDiagnosticText(message);
  state.status = "failed";
  state.error = error;
  if (pending === state) {
    recordAttempt(state, "failed", phase, error);
    log.warn(`[claude-auth] attempt ${state.attemptId} ${phase} failed: ${error}`);
  }
  return error;
}

/**
 * Start the `claude setup-token` flow and resolve with the OAuth URL once both
 * the URL and the paste prompt have appeared, so a code can never be submitted
 * before the CLI is reading one. Any previous in-flight login is killed first;
 * its outcome is kept as `lastAttempt`.
 */
export function startClaudeLogin(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const attemptId = nextAttemptId++;
  const previous = pending;
  if (previous && (previous.status === "awaiting-url" || previous.status === "awaiting-code")) {
    // An attempt that never had a code submitted carries no submit outcome of
    // its own, so any older lastFailedSubmit it's still sitting in front of is
    // stale — clear it rather than let it resurface next to an unrelated attempt.
    if (!previous.submittedAt) lastFailedSubmit = null;
    const phase: ClaudeLoginAttemptSnapshot["phase"] = previous.submittedAt ? "submit" : "start";
    recordAttempt(
      previous,
      "superseded",
      phase,
      previous.submittedAt
        ? "Login attempt was replaced by a fresh start while a code submission was still in progress"
        : "Login attempt was replaced by a fresh start before a code was submitted",
      attemptId
    );
    log.warn(`[claude-auth] attempt ${previous.attemptId} ${phase} superseded by attempt ${attemptId}`);
    try {
      previous.proc.kill();
    } catch {
      // ignore — the process may already be gone
    }
    pending = null;
  } else if (previous && previous.status === "failed") {
    storeSnapshot(
      lastAttempt && lastAttempt.attemptId === previous.attemptId
        ? { ...lastAttempt, supersededByAttemptId: attemptId }
        : {
            attemptId: previous.attemptId,
            status: "failed",
            phase: previous.submittedAt ? "submit" : "start",
            message: previous.error,
            occurredAt: new Date().toISOString(),
            promptReady: previous.promptReady,
            supersededByAttemptId: attemptId,
          }
    );
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (result: { ok: true; url: string } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let proc: pty.IPty;
    try {
      proc = pty.spawn("claude", ["setup-token"], {
        name: "xterm-color",
        cols: 800, // CRITICAL: wide cols so the long OAuth URL is NOT wrapped
        rows: 40,
        cwd: os.homedir(),
        env: { ...process.env, PATH: enrichedPath(process.env["PATH"]) },
      });
    } catch (err) {
      pending = null;
      const error = redactDiagnosticText(`Failed to start login: ${String(err)}`);
      storeSnapshot({
        attemptId,
        status: "failed",
        phase: "start",
        message: error,
        occurredAt: new Date().toISOString(),
        promptReady: false,
      });
      log.warn(`[claude-auth] attempt ${attemptId} start failed: ${error}`);
      done({ ok: false, error });
      return;
    }

    const state: PendingLogin = {
      attemptId,
      proc,
      buffer: "",
      url: null,
      promptReady: false,
      submittedAt: null,
      status: "awaiting-url",
      error: null,
    };
    pending = state;

    const resolveIfReady = (): void => {
      if (!state.url || !state.promptReady) return;
      state.status = "awaiting-code";
      done({ ok: true, url: state.url });
    };

    timer = setTimeout(() => {
      if (settled) return;
      if (!state.url) {
        // A URL that arrived as the very last bytes of output has no trailing
        // whitespace to prove it's complete — accept it now rather than losing it.
        const rescan = URL_REGEX.exec(state.buffer);
        if (rescan) state.url = rescan[1]!.replace(/[.,)\]]+$/, "");
      }
      if (state.url && state.promptReady) {
        resolveIfReady();
        return;
      }
      const error = failAttempt(
        state,
        "start",
        state.url ? "Timed out waiting for Claude paste prompt after login URL" : "Timed out waiting for login URL"
      );
      try {
        proc.kill();
      } catch {
        // ignore
      }
      done({ ok: false, error });
    }, 30_000);

    proc.onData((data: string) => {
      state.buffer += stripVTControlCharacters(data);
      if (settled) return;
      if (!state.url) {
        const match = URL_REGEX.exec(state.buffer);
        // Only accept the match once it's followed by more buffered output —
        // otherwise a PTY read split mid-URL truncates the state= param and
        // the eventual code exchange 400s.
        if (match && match.index + match[1]!.length < state.buffer.length) {
          state.url = match[1]!.replace(/[.,)\]]+$/, "");
        }
      }
      if (!state.promptReady && PASTE_PROMPT_REGEX.test(state.buffer)) {
        state.promptReady = true;
      }
      resolveIfReady();
    });

    proc.onExit(() => {
      if (settled) return;
      const error = failAttempt(
        state,
        "start",
        tailError(state.buffer) ||
          (state.url ? "Login process exited before printing its paste prompt" : "Login process exited before printing a URL")
      );
      done({ ok: false, error });
    });
  });
}

/**
 * Submit the pasted OAuth code to the in-flight login. On success the printed
 * `sk-ant-oat01-…` token is persisted; the browser only ever learns whether it
 * succeeded, never the token.
 */
export function submitClaudeLoginCode(
  code: string
): Promise<{ ok: true } | { ok: false; error: string; retryable?: boolean }> {
  const state = pending;
  if (!state || state.status !== "awaiting-code") {
    return Promise.resolve({ ok: false, error: "No login in progress", retryable: false });
  }

  const clean = code.trim();
  if (clean === "" || /\s/.test(clean)) {
    return Promise.resolve({ ok: false, error: "Invalid code", retryable: true });
  }

  return new Promise((resolve) => {
    let settled = false;
    let enterSent = false;
    const done = (result: { ok: true } | { ok: false; error: string; retryable?: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(enterFallback);
      dataDisposable.dispose();
      exitDisposable.dispose();
      resolve(result);
    };

    const fail = (message: string): void => {
      const error = failAttempt(state, "submit", message);
      try {
        state.proc.kill();
      } catch {
        // ignore
      }
      done({ ok: false, error, retryable: false });
    };

    // Only the output produced after this submit counts — the buffer already
    // holds the URL frame (and, on a retry, the previous attempt's error).
    const scanFrom = state.buffer.length;
    const since = (): string => state.buffer.slice(scanFrom);

    // Enter goes in its own write once the CLI has echoed the code: written
    // together, the CLI reads the whole chunk as a paste and drops the Enter.
    // Other output (a redraw, a spinner frame) does not prove the code was read.
    const sendEnter = (): void => {
      if (enterSent || settled) return;
      enterSent = true;
      state.proc.write("\r");
    };

    const onData = (): void => {
      const tokenMatch = TOKEN_REGEX.exec(since());
      if (tokenMatch) {
        persistToken(tokenMatch[0]);
        noteAgentAuthSuccess();
        state.status = "completed";
        recordAttempt(state, "completed", "submit", null);
        // Push the new ~/.claws/env into the claws-auth k8s Secret now rather
        // than on the next periodic sync; a silent no-op off-cluster.
        void syncAuthSecret().catch(() => {});
        try {
          state.proc.kill();
        } catch {
          // ignore
        }
        done({ ok: true });
        return;
      }

      if (INVALID_CODE_REGEX.test(since())) {
        fail(
          "Invalid code — the CLI rejected it and discarded this login attempt, so the URL above is " +
            "no longer valid. Use the new URL, then paste the whole value including the part after the '#'."
        );
        return;
      }

      const fatalMatch = FATAL_ERROR_REGEX.exec(since());
      if (fatalMatch) {
        fail(`${fatalMatch[0].trim()} — click "Start login" for a fresh URL and try again.`);
        return;
      }

      if (CODE_ECHO_REGEX.test(since())) sendEnter();
    };

    const dataDisposable = state.proc.onData(onData);
    const exitDisposable = state.proc.onExit(() => {
      if (state.status === "completed") return;
      fail(tailError(since()) || "Login process exited before printing a token");
    });

    const timer = setTimeout(() => {
      if (state.status === "completed") return;
      const tail = tailError(since());
      const base = since().trim()
        ? "Timed out completing login — the CLI never printed a token."
        : "Timed out completing login — the CLI produced no output after the code was submitted.";
      fail(tail ? `${base} Last output: ${tail}` : base);
    }, 60_000);

    const enterFallback = setTimeout(sendEnter, ENTER_FALLBACK_MS);

    state.submittedAt = new Date().toISOString();
    state.proc.write(clean);
  });
}

/**
 * Persist the freshly-minted OAuth token both in the live process env (so
 * in-flight and subsequent child spawns inherit it immediately) and in
 * `~/.claws/env`, upserting the key while preserving other secrets in the file.
 * The token value is NEVER logged.
 */
function persistToken(token: string): void {
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = token;

  const dir = path.join(os.homedir(), ".claws");
  const envPath = path.join(dir, "env");
  const line = `CLAUDE_CODE_OAUTH_TOKEN=${token}`;

  let lines: string[] = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, "utf8").split("\n");
  }
  let replaced = false;
  lines = lines.map((l) => {
    if (/^CLAUDE_CODE_OAUTH_TOKEN=/.test(l)) {
      replaced = true;
      return line;
    }
    return l;
  });
  if (!replaced) lines.push(line);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
  // `mode` on writeFileSync only applies to newly-created files; chmod
  // unconditionally enforces it even when envPath already existed.
  fs.chmodSync(envPath, 0o600);

  log.info("Claude OAuth token refreshed via web UI");
}

/**
 * Current login status for the web UI. Never includes the token; `url` is the
 * active attempt's authorization URL, while `lastAttempt` is the sanitized
 * outcome of the most recent finished or replaced attempt and `lastFailedSubmit`
 * that of the most recent code submission that did not complete.
 */
export function getClaudeLoginStatus(): ClaudeLoginStatus {
  if (!pending) return { status: "idle", url: null, error: null, lastAttempt, lastFailedSubmit };
  return {
    status: pending.status,
    url: pending.status === "awaiting-code" ? pending.url : null,
    error: pending.error,
    lastAttempt,
    lastFailedSubmit,
  };
}
