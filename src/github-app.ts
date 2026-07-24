import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY_PATH,
  GITHUB_APP_INSTALLATION_IDS,
  GITHUB_OWNERS,
  GITHUB_OWNER_APP_CREDENTIALS,
  type OwnerAppCredential,
} from "./config.js";
import * as log from "./log.js";
import { retryWithBackoff } from "./retry.js";
import { RateLimitError, setRateLimited } from "./rate-limit.js";

const InstallationSchema = z.object({ id: z.number() });
const TokenSchema = z.object({ token: z.string(), expires_at: z.string() });
const OrgSchema = z.object({ slug: z.string() });
const RawRepoRespSchema = z.object({
  repositories: z.array(z.object({
    name: z.string(),
    full_name: z.string(),
    archived: z.boolean(),
    private: z.boolean(),
    default_branch: z.string(),
    owner: z.object({ login: z.string() }),
  })),
  total_count: z.number(),
});

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
  appBotLoginCache.clear();
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
    const data = InstallationSchema.parse(await ghApiJson<{ id: number }>(
      `https://api.github.com/orgs/${encodeURIComponent(owner)}/installation`,
      jwt,
      "Bearer",
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

async function fetchInstallationToken(owner: string): Promise<string> {
  let installationId: number;
  try {
    installationId = await resolveInstallationId(owner);
  } catch (err) {
    throw new Error(`[github-app] Failed to resolve installation for ${owner}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const creds = getCredentialsForOwner(owner);
  if (!creds) {
    throw new Error(`[github-app] No credentials configured for owner ${owner}`);
  }
  const jwt = signAppJwtForCredentials(creds.appId, creds.privateKeyPath);
  try {
    const data = TokenSchema.parse(await ghApiJson<{ token: string; expires_at: string }>(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      jwt,
      "Bearer",
      { method: "POST" },
    ));
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

export async function getAnyInstallationToken(): Promise<string> {
  const errors: string[] = [];
  for (const owner of GITHUB_OWNERS) {
    try {
      return await getInstallationTokenForOwner(owner);
    } catch (err) {
      errors.push(`${owner}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`[github-app] Failed to obtain installation token for any owner: ${errors.join("; ")}`);
}

// ── App bot login ──

const appBotLoginCache = new Map<string, string>();

export async function getAppBotLogin(owner?: string): Promise<string> {
  const key = owner ?? "";
  const cached = appBotLoginCache.get(key);
  if (cached) return cached;
  let creds: { appId: number; privateKeyPath: string } | null;
  if (owner) {
    creds = getCredentialsForOwner(owner);
  } else {
    // Picks first configured owner as best-effort fallback; callers should pass owner explicitly
    const anyOwner = Object.keys(safeRead(() => GITHUB_OWNER_APP_CREDENTIALS, {} as Record<string, OwnerAppCredential>))[0];
    creds = anyOwner ? getCredentialsForOwner(anyOwner) : getCredentialsForOwner("");
  }
  if (!creds) throw new Error("[github-app] No credentials available for getAppBotLogin");
  const jwt = signAppJwtForCredentials(creds.appId, creds.privateKeyPath);
  const data = OrgSchema.parse(await ghApiJson<{ slug: string }>(`https://api.github.com/app`, jwt, "Bearer"));
  const login = `${data.slug}[bot]`;
  appBotLoginCache.set(key, login);
  return login;
}

// ── Installation repositories ──

export interface InstallationRepoEntry {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isArchived: boolean;
  isPrivate: boolean;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export function isRetryableFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === "fetch failed") return true;
  if (/\bHTTP (500|502|503|504)\b/.test(err.message)) return true;
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(cause.message);
  }
  return false;
}

export async function listInstallationRepositories(owner: string): Promise<InstallationRepoEntry[]> {
  return retryWithBackoff(async () => {
    const token = await getInstallationTokenForOwner(owner);
    const results: InstallationRepoEntry[] = [];
    let url: string | null = `https://api.github.com/installation/repositories?per_page=100`;
    let page = 0;
    while (url && page < 10) {
      page++;
      const res = await fetch(url, {
        headers: {
          "Authorization": `token ${token}`,
          "Accept": API_ACCEPT,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const isRateLimit =
          (res.status === 403 || res.status === 429) &&
          (/rate limit/i.test(body) || res.headers.get("x-ratelimit-remaining") === "0");
        if (isRateLimit) {
          setRateLimited();
          throw new RateLimitError(
            `[github-app] listInstallationRepositories rate limited for ${owner}: ${body.slice(0, 200)}`,
          );
        }
        throw new Error(`[github-app] listInstallationRepositories HTTP ${res.status}: ${body.slice(0, 500)}`);
      }
      const data = RawRepoRespSchema.parse(await res.json());
      for (const r of data.repositories) {
        results.push({
          owner: r.owner.login,
          name: r.name,
          fullName: r.full_name,
          defaultBranch: r.default_branch ?? "main",
          isArchived: Boolean(r.archived),
          isPrivate: Boolean(r.private),
        });
      }
      url = parseNextLink(res.headers.get("link"));
    }
    return results.filter((r) => r.owner === owner);
  }, 2, isRetryableFetchError, "[github-app] listInstallationRepositories");
}

// ── Owner extraction from gh argv ──

export function extractOwnerFromGhArgs(args: string[]): string | null {
  // --repo <owner>/<name>
  const repoIdx = args.indexOf("--repo");
  if (repoIdx >= 0 && repoIdx + 1 < args.length) {
    const slug = args[repoIdx + 1];
    const parts = slug.split("/");
    if (parts.length >= 2 && parts[0]) return parts[0];
  }

  if (args.length >= 2 && args[0] === "repo") {
    if (args[1] === "clone" && args[2]) {
      const parts = args[2].split("/");
      if (parts.length >= 2 && parts[0]) return parts[0];
    }
    if (args[1] === "list" && args[2]) return args[2];
  }

  if (args.length >= 2 && args[0] === "api") {
    const endpoint = args[1];
    // Strip leading slash if present
    const stripped = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
    const prefixes = ["repos/", "orgs/", "users/"];
    for (const prefix of prefixes) {
      if (stripped.startsWith(prefix)) {
        const rest = stripped.slice(prefix.length);
        const owner = rest.split("/")[0];
        if (owner) return owner;
      }
    }
  }

  return null;
}

// ── Env injection for gh and git subprocesses ──

export function buildEnvForGh(token: string | null): NodeJS.ProcessEnv {
  if (!token) return { ...process.env };
  return {
    ...process.env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

/** Reject anything that isn't a plain token — defense in depth for shell interpolation. */
function assertSafeToken(token: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(token)) {
    throw new Error("[github-app] Refusing to inject token containing unsafe characters");
  }
}

/**
 * Build an env for `git` subprocesses that includes a one-shot inline credential
 * helper so authenticated pushes/fetches use the installation token. Done via
 * GIT_CONFIG_COUNT/KEY/VALUE env vars rather than mutating git global config.
 */
export function buildEnvForGhGit(token: string): NodeJS.ProcessEnv {
  assertSafeToken(token);
  const helperInline = `!f() { echo "username=x-access-token"; echo "password=${token}"; }; f`;
  return {
    ...process.env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: helperInline,
  };
}
