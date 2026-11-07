import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY_PATH,
  GITHUB_APP_INSTALLATION_IDS,
  GITHUB_OWNER_APP_CREDENTIALS,
  PUBLIC_SNAPSHOTS,
  FORGEJO_BASE_URL,
  FORGEJO_TOKEN,
  type OwnerAppCredential,
} from "./config.js";
import * as log from "./log.js";
import { retryWithBackoff } from "./retry.js";

const InstallationSchema = z.object({ id: z.number() });
const TokenSchema = z.object({ token: z.string(), expires_at: z.string() });
const USER_AGENT = "claws";
const API_ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";
const FETCH_TIMEOUT_MS = 30_000;

// ── Enablement ──

let validated = false;

function safeRead<T>(read: () => T, fallback: T): T {
  // Guard against partial module mocks (vitest throws on access to undefined
  // exports of a mocked module). In production this is a plain passthrough.
  try {
    return read();
  } catch {
    return fallback;
  }
}

function validateGitHubAppConfig(): boolean {
  if (validated) return true;

  // Per-owner credentials count
  const ownerCreds = safeRead(
    () => GITHUB_OWNER_APP_CREDENTIALS,
    {} as Record<string, OwnerAppCredential>,
  );
  for (const cred of Object.values(ownerCreds)) {
    if (cred.appId && cred.privateKeyPath && fs.existsSync(cred.privateKeyPath)) {
      validated = true;
      return true;
    }
  }

  // Fall back to global credentials
  const appId = safeRead(() => GITHUB_APP_ID, 0);
  const keyPath = safeRead(() => GITHUB_APP_PRIVATE_KEY_PATH, "");
  if (!appId || !keyPath) return false;
  if (!fs.existsSync(keyPath)) return false;
  validated = true;
  return true;
}

export function ensureGitHubAppConfigured(): void {
  if (!validateGitHubAppConfig()) {
    throw new Error(
      "[github-app] GitHub App credentials are not configured. " +
      "Set CLAWS_GITHUB_APP_ID + CLAWS_GITHUB_APP_PRIVATE_KEY_PATH (or githubOwnerAppCredentials).",
    );
  }
}

export function isGitHubAppEnabled(): boolean {
  return validateGitHubAppConfig();
}

let _onResetCallbacks: Array<() => void> = [];

/** Register a callback to invoke whenever resetGitHubAppState() is called. */
export function registerOnResetCallback(cb: () => void): void {
  _onResetCallbacks.push(cb);
}

/** Reset the validated-state. Exposed for tests and config reloads. */
export function resetGitHubAppState(): void {
  validated = false;
  privateKeyByPath.clear();
  jwtCacheByAppId.clear();
  installationIdCache.clear();
  tokenCache.clear();
  inFlightTokenRefresh.clear();
  for (const cb of _onResetCallbacks) cb();
}

// ── Private key ──

const privateKeyByPath = new Map<string, string>();

function loadPrivateKeyForPath(keyPath: string): string {
  const cached = privateKeyByPath.get(keyPath);
  if (cached !== undefined) return cached;
  const key = fs.readFileSync(keyPath, "utf-8");
  privateKeyByPath.set(keyPath, key);
  return key;
}

// ── JWT signing ──

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(Buffer.from(s, "utf-8"));
}

const jwtCacheByAppId = new Map<number, { jwt: string; expiresAt: number }>();

function signAppJwtForCredentials(appId: number, privateKeyPath: string): string {
  const cached = jwtCacheByAppId.get(appId);
  if (cached && cached.expiresAt > Date.now() + 60 * 1000) {
    return cached.jwt;
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 540, iss: appId };
  const headerEnc = base64UrlEncodeString(JSON.stringify(header));
  const payloadEnc = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerEnc}.${payloadEnc}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(loadPrivateKeyForPath(privateKeyPath)));
  const jwt = `${signingInput}.${signature}`;
  jwtCacheByAppId.set(appId, { jwt, expiresAt: (now + 540) * 1000 });
  return jwt;
}

function getCredentialsForOwner(owner: string): { appId: number; privateKeyPath: string } | null {
  const override = safeRead(() => GITHUB_OWNER_APP_CREDENTIALS, {} as Record<string, OwnerAppCredential>)[owner];
  if (override?.appId && override?.privateKeyPath) {
    return { appId: override.appId, privateKeyPath: override.privateKeyPath };
  }
  const appId = safeRead(() => GITHUB_APP_ID, 0);
  const keyPath = safeRead(() => GITHUB_APP_PRIVATE_KEY_PATH, "");
  if (appId && keyPath) {
    return { appId, privateKeyPath: keyPath };
  }
  return null;
}

// ── HTTP helpers ──

interface GhRequestOptions {
  method?: string;
  headers?: Record<string, string>;
}

async function ghApiJson<T>(url: string, token: string, tokenType: "Bearer" | "token", opts: GhRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Authorization": `${tokenType} ${token}`,
    "Accept": API_ACCEPT,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
    ...(opts.headers ?? {}),
  };
  const res = await fetch(url, { method: opts.method ?? "GET", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`[github-app] HTTP ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 500)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

// ── Installation ID resolution ──

const installationIdCache = new Map<string, number>();

async function resolveInstallationId(owner: string): Promise<number> {
  // Per-owner credential with explicit installationId takes highest priority
  const ownerCred = safeRead(() => GITHUB_OWNER_APP_CREDENTIALS, {} as Record<string, OwnerAppCredential>)[owner];
  if (ownerCred?.installationId) return ownerCred.installationId;

  // Only use global installation IDs when no per-owner credential is configured;
  // mixing them risks using one app's JWT against another app's installation (401).
  const hasByOwnerCreds = Boolean(ownerCred?.appId && ownerCred?.privateKeyPath);
  if (!hasByOwnerCreds) {
    const configured = GITHUB_APP_INSTALLATION_IDS[owner];
    if (configured) return configured;
  }

  const cached = installationIdCache.get(owner);
  if (cached !== undefined) return cached;

  const creds = getCredentialsForOwner(owner);
  if (!creds) {
    throw new Error(`[github-app] No credentials configured for owner ${owner}`);
  }
  const jwt = signAppJwtForCredentials(creds.appId, creds.privateKeyPath);
  try {
    const data = InstallationSchema.parse(await retryWithBackoff(
      () => ghApiJson<{ id: number }>(
        `https://api.github.com/orgs/${encodeURIComponent(owner)}/installation`,
        jwt,
        "Bearer",
      ),
      2,
      isRetryableFetchError,
      "[github-app] resolveInstallationId",
    ));
    installationIdCache.set(owner, data.id);
    return data.id;
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status !== 404) throw err;
    const data = InstallationSchema.parse(await ghApiJson<{ id: number }>(
      `https://api.github.com/users/${encodeURIComponent(owner)}/installation`,
      jwt,
      "Bearer",
    ));
    installationIdCache.set(owner, data.id);
    return data.id;
  }
}

// ── Token cache + in-flight dedup ──

interface TokenEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenEntry>();
const inFlightTokenRefresh = new Map<string, Promise<string>>();

const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000; // refresh when <10 min left

/**
 * Render an error with its `cause` chain (bounded) so undici's bare
 * "fetch failed" shows the underlying socket error code and message.
 */
export function describeFetchFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  let out = err.message;
  let cur: unknown = (err as Error & { cause?: unknown }).cause;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    const code = (cur as Error & { code?: unknown }).code;
    out += ` (${cur.message}${code !== undefined ? ` [${String(code)}]` : ""})`;
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return out;
}

async function fetchInstallationToken(owner: string): Promise<string> {
  let installationId: number;
  try {
    installationId = await resolveInstallationId(owner);
  } catch (err) {
    throw new Error(`[github-app] Failed to resolve installation for ${owner}: ${describeFetchFailure(err)}`, { cause: err });
  }

  const creds = getCredentialsForOwner(owner);
  if (!creds) {
    throw new Error(`[github-app] No credentials configured for owner ${owner}`);
  }
  const jwt = signAppJwtForCredentials(creds.appId, creds.privateKeyPath);
  try {
    const raw = await retryWithBackoff(
      () => ghApiJson<{ token: string; expires_at: string }>(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        jwt,
        "Bearer",
        { method: "POST" },
      ),
      2,
      isRetryableFetchError,
      "[github-app] fetchInstallationToken",
    );
    const data = TokenSchema.parse(raw);
    if (typeof data.token !== "string" || data.token.trim().length === 0 || /\s/.test(data.token)) {
      throw new Error(`[github-app] Minted token for ${owner} failed validation (${describeTokenShape(data.token)})`);
    }
    const expiresAt = Date.parse(data.expires_at);
    tokenCache.set(owner, { token: data.token, expiresAt });
    log.info(`[github-app] Minted installation token for ${owner} (len=${data.token.length}, expires=${data.expires_at})`);
    return data.token;
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 404) {
      installationIdCache.delete(owner);
    }
    throw err;
  }
}

export async function getInstallationTokenForOwner(owner: string): Promise<string> {
  const cached = tokenCache.get(owner);
  if (cached && cached.expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    return cached.token;
  }

  const inFlight = inFlightTokenRefresh.get(owner);
  if (inFlight) return inFlight;

  const promise = fetchInstallationToken(owner).finally(() => {
    inFlightTokenRefresh.delete(owner);
  });
  inFlightTokenRefresh.set(owner, promise);
  return promise;
}

/**
 * GitHub owners the App is installed on: the owners of the public snapshot
 * targets, plus any owner given explicit credentials or an installation id.
 * Claws manages no GitHub repos, so this is the whole GitHub reach.
 */
export function githubAppOwners(): string[] {
  const owners = new Set<string>();
  for (const s of safeRead(() => PUBLIC_SNAPSHOTS, [] as readonly { target: string }[])) {
    const owner = s.target.split("/")[0];
    if (owner) owners.add(owner);
  }
  for (const owner of Object.keys(safeRead(() => GITHUB_OWNER_APP_CREDENTIALS, {} as Record<string, OwnerAppCredential>))) owners.add(owner);
  for (const owner of Object.keys(safeRead(() => GITHUB_APP_INSTALLATION_IDS, {} as Record<string, number>))) owners.add(owner);
  return [...owners];
}

export async function getAnyInstallationToken(): Promise<string> {
  const errors: string[] = [];
  for (const owner of githubAppOwners()) {
    try {
      return await getInstallationTokenForOwner(owner);
    } catch (err) {
      errors.push(`${owner}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`[github-app] Failed to obtain installation token for any owner: ${errors.join("; ")}`);
}

export function isRetryableFetchError(err: unknown, depth = 0): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError") return true;
  if (err.message === "fetch failed") return true;
  if (/\bHTTP (500|502|503|504)\b/.test(err.message)) return true;
  // GitHub sometimes answers a transient outage on token minting with 422 "unavailable: ...".
  if (/\bHTTP 422\b/.test(err.message) && /"message":\s*"unavailable/i.test(err.message)) return true;
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(cause.message)) return true;
    if (depth < 5) return isRetryableFetchError(cause, depth + 1);
  }
  return false;
}

// ── Env injection for gh and git subprocesses ──

export function buildEnvForGh(token: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!token) {
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    return env;
  }
  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;
  return env;
}

/** Describe a token's shape for logs — never includes the token value. */
export function describeTokenShape(token: unknown): string {
  if (token === null) return "type=null";
  if (typeof token !== "string") return `type=${typeof token}`;
  const prefix = token.slice(0, 4).replace(/[^A-Za-z0-9_]/g, "?");
  const hasWhitespace = /\s/.test(token);
  return `type=string len=${token.length} prefix=${prefix} whitespace=${hasWhitespace}`;
}

/** Reject values that cannot be used as a git credential. Shell injection is no
 *  longer possible (the helper reads the token from the env), so this only
 *  rejects genuinely unusable values — never a well-formed but unfamiliar token. */
function assertUsableToken(token: unknown): void {
  if (typeof token !== "string") {
    throw new Error(`[github-app] Refusing to inject missing token (${describeTokenShape(token)})`);
  }
  if (token.trim().length === 0) {
    throw new Error(`[github-app] Refusing to inject empty token (${describeTokenShape(token)})`);
  }
  if (/\s/.test(token)) {
    throw new Error(`[github-app] Refusing to inject malformed token containing whitespace (${describeTokenShape(token)})`);
  }
}

/** Env var the inline git credential helper reads the token from at runtime.
 *  The token is NEVER interpolated into the helper's shell source — a quoted
 *  parameter expansion cannot be re-parsed as code, so no character allowlist
 *  is needed and any future GitHub token format keeps working. */
const GIT_CREDENTIAL_TOKEN_VAR = "CLAWS_GIT_CREDENTIAL_TOKEN";
const GIT_CREDENTIAL_HELPER =
  '!f() { echo "username=x-access-token"; echo "password=$CLAWS_GIT_CREDENTIAL_TOKEN"; }; f';

/** Forgejo counterpart of the above. `oauth2` is the Gitea/Forgejo username
 *  convention for token auth; the token itself is again only ever read through
 *  a quoted parameter expansion, never interpolated into the helper source.
 *  Duplicated in capabilities.ts for the interactive-session grant (see the
 *  note there); keep the two in sync. */
const FORGEJO_GIT_CREDENTIAL_TOKEN_VAR = "CLAWS_FORGEJO_GIT_TOKEN";
const FORGEJO_GIT_CREDENTIAL_HELPER =
  '!f() { echo "username=oauth2"; echo "password=$CLAWS_FORGEJO_GIT_TOKEN"; }; f';

/**
 * GitHub git auth for the public snapshot targets only: the tokens, the
 * github.com credential helper at GIT_CONFIG index 0 and
 * `GIT_TERMINAL_PROMPT=0`, never the Forgejo helper or token. No agent or
 * session gets this — managed repos use `buildForgejoGitAuthEnv`.
 */
export function buildGitHubGitAuthEnv(token: string): Record<string, string> {
  assertUsableToken(token);
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    [GIT_CREDENTIAL_TOKEN_VAR]: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: GIT_CREDENTIAL_HELPER,
  };
}

/**
 * Build an env for `git` subprocesses against a public snapshot target on
 * GitHub: `process.env` plus `buildGitHubGitAuthEnv` with `owner`'s
 * installation token. A failed mint (never cached) is retried once; a second
 * failure throws, so git never falls back to ambient credentials.
 */
export async function buildEnvForGitHubGit(owner: string): Promise<NodeJS.ProcessEnv> {
  let token: string;
  try {
    token = await getInstallationTokenForOwner(owner);
  } catch (firstErr) {
    token = await getInstallationTokenForOwner(owner);
    log.warn(`[github-app] git token for ${owner} recovered on retry (first attempt: ${describeFetchFailure(firstErr)})`);
  }
  return { ...process.env, ...buildGitHubGitAuthEnv(token) };
}

/**
 * Only the git auth vars `buildEnvForForgejoGit` layers over `process.env`: the
 * Forgejo credential helper (via GIT_CONFIG_COUNT/KEY/VALUE rather than
 * mutating git global config), `CLAWS_FORGEJO_GIT_TOKEN` and
 * `GIT_TERMINAL_PROMPT=0`. Never sets `GH_TOKEN`/`GITHUB_TOKEN`: every managed
 * repo is on Forgejo. Use this when the env leaves the process (e.g. a session
 * pod's `clone-env.json`), so no other service secret goes with it. Without a
 * Forgejo token only `GIT_TERMINAL_PROMPT=0` is set.
 */
export function buildForgejoGitAuthEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  const forgejoToken = FORGEJO_TOKEN;
  if (forgejoToken && forgejoToken.trim()) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `credential.${FORGEJO_BASE_URL.replace(/\/+$/, "")}.helper`;
    env.GIT_CONFIG_VALUE_0 = FORGEJO_GIT_CREDENTIAL_HELPER;
    env[FORGEJO_GIT_CREDENTIAL_TOKEN_VAR] = forgejoToken;
  }
  return env;
}

/**
 * Build an env for `git` subprocesses against Forgejo: `process.env` plus
 * `buildForgejoGitAuthEnv`, with any ambient GitHub token stripped. Without a
 * Forgejo token `GIT_CONFIG_COUNT` is forced to 0, so no inherited
 * `GIT_CONFIG_KEY_*` credential helper reaches git.
 */
export function buildEnvForForgejoGit(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_COUNT: "0", ...buildForgejoGitAuthEnv() };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env[GIT_CREDENTIAL_TOKEN_VAR];
  return env;
}
