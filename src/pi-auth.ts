import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "./config.js";
import * as log from "./log.js";
import { enrichedPath } from "./cli-path.js";

/**
 * pi's credentials, derived from the ones Claws already holds. pi picks a
 * provider per run from the model's `provider/id` prefix:
 *
 * - `anthropic`    — the Claude account: `CLAUDE_CODE_OAUTH_TOKEN` passed as pi's `ANTHROPIC_OAUTH_TOKEN`.
 * - `openai-codex` — the ChatGPT account: `~/.codex/auth.json` translated into pi's `auth.json`.
 * - `openai`       — `OPENAI_API_KEY` from config.
 * - `openrouter`   — `OPENROUTER_API_KEY` from config.
 *
 * Leaf module: imports only config, log and cli-path, so `claude.ts`, pages and
 * jobs can all use it.
 */

export type PiProviderId = "anthropic" | "openai-codex" | "openai" | "openrouter";

export const PI_PROVIDERS: ReadonlyArray<{ id: PiProviderId; label: string; source: string }> = [
  { id: "anthropic", label: "Anthropic account", source: "Claude token (CLAUDE_CODE_OAUTH_TOKEN)" },
  { id: "openai-codex", label: "ChatGPT account", source: "Codex login (~/.codex/auth.json)" },
  { id: "openai", label: "OpenAI API", source: "OpenAI API key" },
  { id: "openrouter", label: "OpenRouter", source: "OpenRouter API key" },
];

/**
 * Split a pi model at its first `/` into pi's `--provider` and `--model`.
 * A value with no `/` has no provider, so pi picks one itself.
 */
export function splitPiModel(model: string): { provider: string | null; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { provider: null, id: model };
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** The service's Codex `auth.json`: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
function defaultCodexAuthPath(): string {
  return path.join(process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex"), "auth.json");
}

/** The JWT's `exp` in ms, or null when the token is not a readable JWT. */
function jwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * pi's `auth.json` content holding an `openai-codex` OAuth entry translated
 * from the Codex CLI's `auth.json`, or null when that file is missing or any
 * of the access token, refresh token or account id is absent. `expires` is
 * the access JWT's `exp`, else one hour from now.
 */
export function piAuthJsonFromCodex(codexAuthPath: string = defaultCodexAuthPath()): string | null {
  let tokens: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(codexAuthPath, "utf8")) as { tokens?: unknown };
    tokens = parsed && typeof parsed.tokens === "object" && parsed.tokens !== null ? parsed.tokens as Record<string, unknown> : undefined;
  } catch {
    return null;
  }
  const access = tokens?.["access_token"];
  const refresh = tokens?.["refresh_token"];
  const accountId = tokens?.["account_id"];
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh || typeof accountId !== "string" || !accountId) {
    return null;
  }
  const expires = jwtExpiryMs(access) ?? Date.now() + 60 * 60 * 1000;
  return JSON.stringify({ "openai-codex": { type: "oauth", access, refresh, expires, accountId } }, null, 2);
}

/**
 * Write `<agentDir>/auth.json` (0600) from the Codex login, or remove it when
 * there is no usable Codex login. A ChatGPT refresh pi makes in this copy is
 * never written back to `~/.codex/auth.json`.
 */
export function writePiAuthJson(agentDir: string): void {
  const authPath = path.join(agentDir, "auth.json");
  const content = piAuthJsonFromCodex();
  if (content === null) {
    fs.rmSync(authPath, { force: true });
    return;
  }
  fs.writeFileSync(authPath, content, { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
}

/**
 * Env-var credentials and quiet-mode flags for a pi process. Secrets travel in
 * the child's env, never on argv.
 */
export function piCredentialEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const anthropic = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (anthropic) env["ANTHROPIC_OAUTH_TOKEN"] = anthropic;
  if (config.OPENAI_API_KEY) env["OPENAI_API_KEY"] = config.OPENAI_API_KEY;
  if (config.OPENROUTER_API_KEY) env["OPENROUTER_API_KEY"] = config.OPENROUTER_API_KEY;
  return env;
}

/** Which of pi's four providers have a credential source on this host. */
export function piCredentialSources(): PiProviderId[] {
  const sources: PiProviderId[] = [];
  if (process.env["CLAUDE_CODE_OAUTH_TOKEN"]) sources.push("anthropic");
  if (piAuthJsonFromCodex() !== null) sources.push("openai-codex");
  if (config.OPENAI_API_KEY) sources.push("openai");
  if (config.OPENROUTER_API_KEY) sources.push("openrouter");
  return sources;
}

export type PiCredentialStatus = "ready" | "not_ready" | "not_configured" | "error";

export interface PiProviderStatus {
  provider: PiProviderId;
  label: string;
  source: string;
  status: PiCredentialStatus;
  reason: string | null;
}

const PI_AUTH_CHECK_TIMEOUT_MS = 15_000;

function runPiAuthCheck(provider: PiProviderId, env: NodeJS.ProcessEnv, cwd: string): Promise<{ status: PiCredentialStatus; reason: string | null }> {
  return new Promise((resolve) => {
    execFile("pi", ["auth", "check", "--provider", provider, "--json", "--no-refresh"], { env, cwd, timeout: PI_AUTH_CHECK_TIMEOUT_MS }, (err, stdout) => {
      // pi exits non-zero for not_ready but still prints its JSON verdict.
      let parsed: { status?: unknown; reason?: unknown } | null = null;
      try {
        parsed = JSON.parse(String(stdout ?? "").trim()) as { status?: unknown; reason?: unknown };
      } catch {
        parsed = null;
      }
      if (parsed && (parsed.status === "ready" || parsed.status === "not_ready")) {
        resolve({ status: parsed.status, reason: typeof parsed.reason === "string" ? parsed.reason : null });
        return;
      }
      // Never log stdout: `pi auth check` output is the credential channel.
      const reason = err
        ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? "pi CLI not installed" : err.killed ? "timed out" : `exit ${(err as { code?: unknown }).code ?? "?"}`)
        : "unparseable output";
      log.warn(`[pi-auth] pi auth check --provider ${provider} failed: ${reason}`);
      resolve({ status: "error", reason });
    });
  });
}

/**
 * Per-provider readiness from `pi auth check --no-refresh`, run in a temporary
 * agent dir holding the translated Codex credential and the credential env, so
 * a status check never rotates a token. A provider with no source on this host
 * is reported `not_configured` without spawning pi.
 */
export async function piCredentialStatuses(): Promise<PiProviderStatus[]> {
  const sources = new Set(piCredentialSources());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claws-pi-auth-"));
  try {
    fs.chmodSync(tmp, 0o700);
    writePiAuthJson(tmp);
    const env: NodeJS.ProcessEnv = {
      PATH: enrichedPath(process.env["PATH"]),
      HOME: tmp,
      PI_CODING_AGENT_DIR: tmp,
      ...piCredentialEnv(),
    };
    return await Promise.all(PI_PROVIDERS.map(async (p): Promise<PiProviderStatus> => {
      if (!sources.has(p.id)) {
        return { provider: p.id, label: p.label, source: p.source, status: "not_configured", reason: `no ${p.source}` };
      }
      const { status, reason } = await runPiAuthCheck(p.id, env, tmp);
      return { provider: p.id, label: p.label, source: p.source, status, reason };
    }));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
