import * as pty from "node-pty";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import * as log from "./log.js";
import { enrichedPath } from "./claude.js";

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
 */

const URL_REGEX = /(https?:\/\/\S*(?:oauth|authorize)\S*)/i;
const TOKEN_REGEX = /sk-ant-oat01-[A-Za-z0-9_-]+/;

interface PendingLogin {
  proc: pty.IPty;
  buffer: string;
  url: string | null;
  status: "awaiting-url" | "awaiting-code" | "completed" | "failed";
  error: string | null;
}

let pending: PendingLogin | null = null;

/** Redact any OAuth token from a string before it is returned to the browser. */
function redactToken(s: string): string {
  return s.replace(new RegExp(TOKEN_REGEX.source, "g"), "sk-ant-oat01-[REDACTED]");
}

/** Last ~500 chars of the buffer, with any token redacted, for error display. */
function tailError(buffer: string): string {
  return redactToken(buffer.slice(-500)).trim();
}

/**
 * Start the `claude setup-token` flow and resolve with the OAuth URL once it
 * appears. Any previous in-flight login is killed first.
 */
export function startClaudeLogin(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (pending && (pending.status === "awaiting-url" || pending.status === "awaiting-code")) {
    try {
      pending.proc.kill();
    } catch {
      // ignore — the process may already be gone
    }
    pending = null;
  }

  return new Promise((resolve) => {
    let settled = false;
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
      done({ ok: false, error: `Failed to start login: ${String(err)}` });
      return;
    }

    const state: PendingLogin = {
      proc,
      buffer: "",
      url: null,
      status: "awaiting-url",
      error: null,
    };
    pending = state;

    const timer = setTimeout(() => {
      if (state.url) return;
      state.status = "failed";
      state.error = "Timed out waiting for login URL";
      try {
        proc.kill();
      } catch {
        // ignore
      }
      done({ ok: false, error: state.error });
    }, 30_000);

    proc.onData((data: string) => {
      state.buffer += stripVTControlCharacters(data);
      if (state.url) return;
      const match = URL_REGEX.exec(state.buffer);
      if (match) {
        const url = match[1]!.replace(/[.,)\]]+$/, "");
        state.url = url;
        state.status = "awaiting-code";
        done({ ok: true, url });
      }
    });

    proc.onExit(() => {
      if (state.url) return;
      state.status = "failed";
      state.error = tailError(state.buffer) || "Login process exited before printing a URL";
      done({ ok: false, error: state.error });
    });
  });
}

/**
 * Submit the pasted OAuth code to the in-flight login. On success the printed
 * `sk-ant-oat01-…` token is persisted; the browser only ever learns whether it
 * succeeded, never the token.
 */
export function submitClaudeLoginCode(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const state = pending;
  if (!state || state.status !== "awaiting-code") {
    return Promise.resolve({ ok: false, error: "No login in progress" });
  }

  const clean = code.trim();
  if (clean === "" || /\s/.test(clean)) {
    return Promise.resolve({ ok: false, error: "Invalid code" });
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: true } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const onData = (): void => {
      // Buffer is already appended to by the onData listener registered in
      // startClaudeLogin (never disposed, still live) — only scan here.
      const match = TOKEN_REGEX.exec(state.buffer);
      if (match) {
        persistToken(match[0]);
        state.status = "completed";
        try {
          state.proc.kill();
        } catch {
          // ignore
        }
        done({ ok: true });
      }
    };

    state.proc.onData(onData);
    state.proc.onExit(() => {
      if (state.status === "completed") return;
      state.status = "failed";
      state.error = tailError(state.buffer) || "Login process exited before printing a token";
      done({ ok: false, error: state.error });
    });

    const timer = setTimeout(() => {
      if (state.status === "completed") return;
      state.status = "failed";
      state.error = "Timed out completing login";
      try {
        state.proc.kill();
      } catch {
        // ignore
      }
      done({ ok: false, error: state.error });
    }, 60_000);

    state.proc.write(clean + "\r");
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

/** Current login status for the web UI. Never includes the token. */
export function getClaudeLoginStatus(): { status: string; url: string | null; error: string | null } {
  if (!pending) return { status: "idle", url: null, error: null };
  return { status: pending.status, url: pending.url, error: pending.error };
}
