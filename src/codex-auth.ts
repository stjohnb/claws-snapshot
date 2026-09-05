import * as pty from "node-pty";
import { stripVTControlCharacters } from "node:util";
import os from "node:os";
import * as log from "./log.js";
import { enrichedPath } from "./claude.js";
import { noteAgentAuthSuccess } from "./agent-auth-state.js";
import { syncAuthSecret } from "./jobs/auth-secret-sync.js";

/**
 * Server-side orchestration of the `codex login --device-auth` device-code flow
 * so a ChatGPT session expiry can be fixed from the web UI instead of shelling
 * into the host.
 *
 * A plain `codex login` opens a browser and listens on `127.0.0.1:1455` for the
 * callback — useless on a headless server, since that port is unreachable from
 * the operator's laptop. `--device-auth` is the headless path: the CLI prints an
 * `https://auth.openai.com/codex/device` link and a short one-time code, then
 * polls OpenAI in the background. There is nothing to paste back into the CLI
 * (unlike `claude setup-token`) — the process writes `~/.codex/auth.json` and
 * **exits 0** once the operator authorizes, and exits non-zero on error or when
 * the code expires. So "did it work?" is simply the exit code.
 *
 * The PTY is spawned with a very wide `cols` for the same reason as
 * `claude-auth.ts`: the URL must not be wrapped across lines. `CODEX_HOME` is
 * deliberately left alone so the refreshed credential lands in the real
 * `~/.codex/auth.json`, which is what task runs and `jobs/auth-secret-sync.ts`
 * read.
 */

const URL_REGEX = /(https?:\/\/\S*(?:device|oauth|authorize)\S*)/i;
/** The one-time code, printed alone on its own line (e.g. `R1OR-LBCFO`). */
const CODE_REGEX = /^[ \t]*([A-Za-z0-9]{4,8}-[A-Za-z0-9]{4,8})[ \t]*$/m;
/** API keys / JWTs — never let one reach the browser or the log if it lands in CLI output. */
const SECRET_REGEX = /(?:sk-[A-Za-z0-9_-]{16,}|ey[A-Za-z0-9._-]{24,})/g;

/** How long to wait for the device code itself to be printed. */
const URL_TIMEOUT_MS = 30_000;
/** Device codes expire after 15 minutes; give the poll one extra minute to notice. */
const AUTH_TIMEOUT_MS = 16 * 60 * 1000;

interface PendingCodexLogin {
  proc: pty.IPty;
  /** ANSI-stripped, CR-normalised CLI output. */
  buffer: string;
  url: string | null;
  userCode: string | null;
  status: "awaiting-url" | "awaiting-authorization" | "completed" | "failed";
  error: string | null;
}

let pending: PendingCodexLogin | null = null;

/** Redact anything key-shaped from a string before it is returned to the browser. */
function redactSecrets(s: string): string {
  return s.replace(SECRET_REGEX, "[REDACTED]");
}

/** Lines composed only of spinner/progress glyphs, dots or whitespace. */
const NOISE_LINE = /^[·✢*✶✻✽░▒█▄▀▁\s.…]*$/u;

/** Last few meaningful CLI lines, spinner/redraw noise removed, secrets redacted. */
function tailError(buffer: string): string {
  const lines = redactSecrets(buffer)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !NOISE_LINE.test(l));
  const deduped = lines.filter((l, i) => l !== lines[i - 1]);
  const joined = deduped.slice(-4).join(" | ");
  return joined.length > 300 ? `…${joined.slice(-300)}` : joined;
}

/**
 * Scan the buffer for the device URL and one-time code. Unless `acceptTrailing`,
 * both matches must be followed by further buffered output — a PTY read split
 * mid-token would otherwise hand the browser a truncated URL or code.
 */
function scanForCode(buffer: string, acceptTrailing: boolean): { url: string; userCode: string } | null {
  const urlMatch = URL_REGEX.exec(buffer);
  if (!urlMatch) return null;
  if (!acceptTrailing && urlMatch.index + urlMatch[1]!.length >= buffer.length) return null;
  const codeMatch = CODE_REGEX.exec(buffer);
  if (!codeMatch) return null;
  if (!acceptTrailing && codeMatch.index + codeMatch[0].length >= buffer.length) return null;
  return { url: urlMatch[1]!.replace(/[.,)\]]+$/, ""), userCode: codeMatch[1]! };
}

/**
 * Start the `codex login --device-auth` flow and resolve with the device URL and
 * one-time code once the CLI prints them. Any previous in-flight login is killed
 * first. Completion is reported asynchronously via `getCodexLoginStatus()` — the
 * CLI keeps polling OpenAI until the operator authorizes.
 */
export function startCodexLogin(): Promise<
  { ok: true; url: string; userCode: string } | { ok: false; error: string }
> {
  if (pending && (pending.status === "awaiting-url" || pending.status === "awaiting-authorization")) {
    try {
      pending.proc.kill();
    } catch {
      // ignore — the process may already be gone
    }
    pending = null;
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: true; url: string; userCode: string } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let proc: pty.IPty;
    try {
      proc = pty.spawn("codex", ["login", "--device-auth"], {
        name: "xterm-color",
        cols: 800, // CRITICAL: wide cols so the device URL is NOT wrapped
        rows: 40,
        cwd: os.homedir(),
        env: { ...process.env, PATH: enrichedPath(process.env["PATH"]) },
      });
    } catch (err) {
      pending = null;
      done({ ok: false, error: `Failed to start codex login: ${String(err)}` });
      return;
    }

    const state: PendingCodexLogin = {
      proc,
      buffer: "",
      url: null,
      userCode: null,
      status: "awaiting-url",
      error: null,
    };
    pending = state;

    const timer = setTimeout(() => {
      if (state.url && state.userCode) return;
      // A code that arrived as the very last bytes of output has nothing
      // trailing to prove it's complete — accept it now rather than losing it.
      const rescan = scanForCode(state.buffer, true);
      if (rescan) {
        state.url = rescan.url;
        state.userCode = rescan.userCode;
        state.status = "awaiting-authorization";
        done({ ok: true, ...rescan });
        return;
      }
      state.status = "failed";
      state.error = tailError(state.buffer) || "Timed out waiting for the codex device code";
      try {
        proc.kill();
      } catch {
        // ignore
      }
      done({ ok: false, error: state.error });
    }, URL_TIMEOUT_MS);

    // The device code is only good for 15 minutes; don't leave a dead PTY polling.
    const authTimer = setTimeout(() => {
      if (state.status !== "awaiting-authorization") return;
      state.status = "failed";
      state.error =
        "Timed out waiting for authorization — the device code expires after 15 minutes. Start a new login.";
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, AUTH_TIMEOUT_MS);

    proc.onData((data: string) => {
      // CR normalisation is load-bearing: the PTY emits `\r\n`, and CODE_REGEX's
      // `$` would never see a clean line end without it.
      state.buffer += stripVTControlCharacters(data).replace(/\r\n?/g, "\n");
      if (state.url && state.userCode) return;
      const found = scanForCode(state.buffer, false);
      if (found) {
        state.url = found.url;
        state.userCode = found.userCode;
        state.status = "awaiting-authorization";
        done({ ok: true, ...found });
      }
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      clearTimeout(authTimer);
      // Either timeout already killed the PTY and recorded a better error.
      if (state.status === "failed" || state.status === "completed") return;

      if (!state.url || !state.userCode) {
        // Exit code 0 here usually means the CLI decided it was already authenticated.
        state.status = "failed";
        state.error = tailError(state.buffer) || "codex login exited before printing a device code";
        done({ ok: false, error: state.error });
        return;
      }

      if (exitCode === 0) {
        state.status = "completed";
        state.error = null;
        noteAgentAuthSuccess("codex");
        log.info("Codex OAuth credentials refreshed via web UI");
        // Push the rotated ~/.codex/auth.json into the claws-auth k8s Secret now
        // rather than up to 10 minutes later; a silent no-op off-cluster.
        void syncAuthSecret().catch(() => {});
        return;
      }

      state.status = "failed";
      state.error = tailError(state.buffer) || `codex login exited with code ${exitCode}`;
    });
  });
}

/**
 * Current login status for the web UI. The one-time code IS returned — it is
 * what the operator types into OpenAI — but nothing else from the PTY reaches
 * the browser except `tailError()` output, which is redacted.
 */
export function getCodexLoginStatus(): {
  status: string;
  url: string | null;
  userCode: string | null;
  error: string | null;
} {
  if (!pending) return { status: "idle", url: null, userCode: null, error: null };
  return { status: pending.status, url: pending.url, userCode: pending.userCode, error: pending.error };
}
