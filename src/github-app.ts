import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY_PATH,
  GITHUB_APP_INSTALLATION_IDS,
  GITHUB_OWNERS,
  GITHUB_OWNER_APP_CREDENTIALS,
  FORGEJO_BASE_URL,
  FORGEJO_TOKEN,
  type OwnerAppCredential,
} from "./config.js";
import * as log from "./log.js";
import { retryWithBackoff } from "./retry.js";
import { RateLimitError, isRateLimited, setRateLimited, setRateLimitedUntil } from "./rate-limit.js";

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
  gitEnvEscalatedOwners.clear();
  coreRateLimitCache.clear();
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

/** Evict a cached installation token so the next call re-mints. */
export function invalidateInstallationToken(owner: string): void {
  // Deliberately does NOT touch inFlightTokenRefresh: that promise's
  // .finally() deletes by owner key and would drop a newer entry, causing a
  // duplicate-mint race.
  tokenCache.delete(owner);
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
  // Breaker guard, mirroring gh() in github.ts, so every caller — fetchRepos,
  // listPublicReposIncludingArchived and any future one — is covered by
  // construction instead of having to remember the check (#3221).
  if (isRateLimited()) {
    throw new RateLimitError(`[github-app] Rate limited — skipping listInstallationRepositories for ${owner}`);
  }
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
          // A secondary-limit 403 ("You have exceeded a secondary rate
          // limit…") also matches /rate limit/i without exhausting the
          // primary budget, so only trust x-ratelimit-reset when
          // x-ratelimit-remaining confirms the primary bucket is the one
          // that tripped — otherwise it's routinely 30-59min out and would
          // open the global breaker for far longer than the outage.
          const primaryExhausted = res.headers.get("x-ratelimit-remaining") === "0";
          const resetHeader = res.headers.get("x-ratelimit-reset");
          const resetSeconds = resetHeader ? Number(resetHeader) : NaN;
          const retryAfterHeader = res.headers.get("retry-after");
          const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
          if (primaryExhausted && Number.isInteger(resetSeconds) && resetSeconds > 0) {
            setRateLimitedUntil(resetSeconds * 1000);
          } else if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
            setRateLimited(retryAfterSeconds * 1000);
          } else {
            setRateLimited();
          }
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

interface RateLimitResource {
  remaining?: number;
  reset?: number;
}

// The buckets Claws’ `gh` traffic actually spends. `/rate_limit` reports a
// dozen more (source_import, code_scanning_upload, scim, …); letting one of
// those pin the *global* breaker would block all GitHub work on a budget we
// never touch, for up to the 1h clamp.
const RELEVANT_RATE_LIMIT_BUCKETS = new Set(["core", "graphql", "search", "code_search"]);

const RateLimitResourcesSchema = z.object({ resources: z.record(z.string(), z.unknown()) });

/**
 * `GET /rate_limit` with the owner's installation token (any installation's
 * when `owner` is null). The endpoint is documented as exempt from the limit it
 * reports. Returns the raw `resources` map for callers to pick their bucket;
 * throws on any failure or unexpected shape.
 */
async function fetchRateLimitResources(owner: string | null): Promise<Record<string, unknown>> {
  const token = owner ? await getInstallationTokenForOwner(owner) : await getAnyInstallationToken();
  const raw = await ghApiJson<unknown>("https://api.github.com/rate_limit", token, "token");
  return RateLimitResourcesSchema.parse(raw).resources;
}

/**
 * Probe GitHub's free `GET /rate_limit` endpoint (documented as exempt from
 * the limit it reports) for the real reset time. Used by gh()'s `execFile`
 * path, whose stderr carries no response headers, so it cannot read
 * `x-ratelimit-reset` directly the way `listInstallationRepositories` does.
 * Never throws: any failure, unexpected shape, or a response with none of the
 * buckets Claws spends exhausted (typical of a *secondary* rate limit, which
 * has no reset here) returns null so the caller falls back to the default
 * cooldown. Always probes fresh — a memoised reading from before the limit hit
 * would report quota left and lose the reset time.
 */
export async function fetchRateLimitResetMs(owner: string | null): Promise<number | null> {
  try {
    const resources = await fetchRateLimitResources(owner);
    let maxReset: number | null = null;
    for (const [name, value] of Object.entries(resources)) {
      if (!RELEVANT_RATE_LIMIT_BUCKETS.has(name)) continue;
      if (!value || typeof value !== "object") continue;
      const resource = value as RateLimitResource;
      if (resource.remaining !== 0) continue;
      if (typeof resource.reset !== "number" || !Number.isFinite(resource.reset)) continue;
      if (maxReset === null || resource.reset > maxReset) maxReset = resource.reset;
    }
    return maxReset === null ? null : maxReset * 1000;
  } catch {
    return null;
  }
}

export interface CoreRateLimit {
  remaining: number;
  limit: number;
  /** Epoch seconds at which the core bucket refills. */
  resetAt: number;
}

const CoreRateLimitSchema = z.object({ remaining: z.number(), limit: z.number(), reset: z.number() });

const CORE_RATE_LIMIT_TTL_MS = 60_000;
const coreRateLimitCache = new Map<string, { at: number; value: Promise<CoreRateLimit | null> }>();

/**
 * The owner's installation core (REST) quota, read from the free
 * `GET /rate_limit` endpoint with that owner's installation token. Memoised per
 * owner for 60s so concurrent callers share one probe. Never throws and never
 * trips the breaker: any failure logs a warning and returns null.
 */
export function getInstallationCoreRateLimit(owner: string): Promise<CoreRateLimit | null> {
  const cached = coreRateLimitCache.get(owner);
  if (cached && Date.now() - cached.at < CORE_RATE_LIMIT_TTL_MS) return cached.value;
  const value = (async (): Promise<CoreRateLimit | null> => {
    try {
      const core = CoreRateLimitSchema.parse((await fetchRateLimitResources(owner)).core);
      return { remaining: core.remaining, limit: core.limit, resetAt: core.reset };
    } catch (err) {
      log.warn(`[github-app] Could not read the core rate limit for ${owner}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  })();
  coreRateLimitCache.set(owner, { at: Date.now(), value });
  return value;
}

// ── Owner extraction from gh argv ──

// `gh api` flags that consume the following argument as their value.
export const GH_API_VALUE_FLAGS = new Set([
  "-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field",
  "-q", "--jq", "-t", "--template", "-p", "--preview", "--input", "--hostname", "--cache",
]);

// Value-taking flags for non-`api` subcommands (`pr`, `issue`, `label`, `run`,
// `release`, …), covering every one the call sites in src/github.ts use — the
// consistency test in src/github-app.test.ts fails if a new call site passes a
// flag listed neither here nor in GH_COMMAND_BOOLEAN_FLAGS, so this cannot
// silently drift out of sync. `--repo`/`-R` is deliberately excluded: its value
// is read directly by the `--repo` scan in extractOwnerFromGhArgs below rather
// than via this generic walker.
export const GH_COMMAND_VALUE_FLAGS = new Set([
  "--title", "--body", "--body-file", "--name", "--label", "--add-label", "--remove-label",
  "--json", "--jq", "-q", "--template", "--search", "--head", "--base", "--limit", "--state",
  "--assignee", "--milestone", "--pattern", "--dir", "--notes", "--notes-file",
  "--target", "--color", "--description", "--reason", "--match-head-commit",
]);

// Non-`api` flags that take no value, so the token after one of them really is
// a positional. Tracked only so the consistency test can tell "deliberately
// valueless" apart from "forgotten".
export const GH_COMMAND_BOOLEAN_FLAGS = new Set([
  "--allow-escape-sequences", "--clobber", "--failed", "--force", "--log-failed",
  "--name-only", "--paginate", "--squash", "--yes",
]);

type GhArgKind = "flag" | "flag-value" | "positional";

/**
 * Classify each element of `args` as a flag, the value a preceding flag
 * consumed, or a positional. `args[0]` (the gh subcommand) is always
 * positional. Uses `GH_API_VALUE_FLAGS` for `gh api …` calls and
 * `GH_COMMAND_VALUE_FLAGS` otherwise, so a flag *value* (`-f body=…`, a
 * `--title` string) is never mistaken for a flag or a positional endpoint.
 */
function classifyGhArgs(args: string[]): GhArgKind[] {
  const valueFlags = args[0] === "api" ? GH_API_VALUE_FLAGS : GH_COMMAND_VALUE_FLAGS;
  const kinds: GhArgKind[] = new Array(args.length).fill("positional");
  for (let i = 1; i < args.length; i++) {
    if (kinds[i] === "flag-value") continue;
    if (!args[i].startsWith("-")) continue;
    kinds[i] = "flag";
    // `--repo`/`-R` aren't in valueFlags (extractOwnerFromGhArgs reads their
    // value directly), but their value still consumes the next token and
    // must not be left classified as a positional endpoint.
    if ((valueFlags.has(args[i]) || args[i] === "--repo" || args[i] === "-R") && i + 1 < args.length) {
      kinds[i + 1] = "flag-value";
    }
  }
  return kinds;
}

/** The endpoint positional of a `gh api …` call, which may follow flags
 *  (`gh api --method PATCH repos/…`). */
function findGhApiEndpoint(args: string[]): string | null {
  const kinds = classifyGhArgs(args);
  for (let i = 1; i < args.length; i++) {
    if (kinds[i] === "positional") return args[i];
  }
  return null;
}

export function extractOwnerFromGhArgs(args: string[]): string | null {
  const kinds = classifyGhArgs(args);

  // --repo <owner>/<name> / -R <owner>/<name> / --repo=<owner>/<name>, but
  // only when the token is genuinely a flag position — not another flag's
  // swallowed value (e.g. a `--title` whose text happens to be "--repo").
  for (let i = 0; i < args.length; i++) {
    if (kinds[i] !== "flag") continue;
    const a = args[i];
    if (a.startsWith("--repo=")) {
      const parts = a.slice("--repo=".length).split("/");
      if (parts.length >= 2 && parts[0]) return parts[0];
      continue;
    }
    if (a === "--repo" || a === "-R") {
      const value = args[i + 1];
      if (value !== undefined) {
        const parts = value.split("/");
        if (parts.length >= 2 && parts[0]) return parts[0];
      }
    }
  }

  if (args.length >= 2 && args[0] === "repo") {
    if (args[1] === "clone" && args[2]) {
      const parts = args[2].split("/");
      if (parts.length >= 2 && parts[0]) return parts[0];
    }
    if (args[1] === "list" && args[2]) return args[2];
  }

  const endpoint = args[0] === "api" ? findGhApiEndpoint(args) : null;
  if (endpoint) {
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

  // `gh api graphql -f owner=<owner> …` — the owner arrives as a query variable,
  // not in the endpoint path, so pick it out of the -f/-F pairs.
  if (endpoint === "graphql") {
    for (const a of args) {
      const m = /^owner=(.+)$/.exec(a);
      if (m) return m[1];
    }
  }

  return null;
}

/**
 * Redacted, log-safe description of a `gh` call shape: the subcommand, the
 * endpoint (for `api` calls) or the sub-subcommand, and flag *names* only —
 * never a flag value, so it is safe to log even when a call carries secrets
 * (an issue/PR body, a query string). `--flag=value` forms are truncated to
 * the part before `=`.
 */
export function describeGhCallShape(args: string[]): string {
  const kinds = classifyGhArgs(args);
  const flagNames: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (kinds[i] !== "flag") continue;
    const eqIdx = args[i].indexOf("=");
    flagNames.push(eqIdx >= 0 ? args[i].slice(0, eqIdx) : args[i]);
  }
  const flagsSuffix = flagNames.length > 0 ? ` [${flagNames.join(" ")}]` : "";

  if (args[0] === "api") {
    const endpoint = findGhApiEndpoint(args) ?? "(no endpoint)";
    return `api ${endpoint}${flagsSuffix}`;
  }

  const head = args.length > 1 && kinds[1] === "positional" ? `${args[0]} ${args[1]}` : (args[0] ?? "");
  return `${head}${flagsSuffix}`;
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
 * Only the git/gh auth vars `buildEnvForGhGit` layers over `process.env`: the
 * tokens, a one-shot inline credential helper (via GIT_CONFIG_COUNT/KEY/VALUE
 * rather than mutating git global config) and `GIT_TERMINAL_PROMPT=0`. Use this
 * when the env leaves the process (e.g. a session pod's `clone-env.json`), so no
 * other service secret goes with it.
 *
 * When a Forgejo token is configured a second helper is appended for the Forgejo
 * host. Git picks a credential helper by URL, so both can coexist and every
 * existing fetch/rebase/push path works against either forge with no routing.
 */
export function buildGitAuthEnv(token: string): Record<string, string> {
  assertUsableToken(token);
  const env: Record<string, string> = {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    [GIT_CREDENTIAL_TOKEN_VAR]: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: GIT_CREDENTIAL_HELPER,
  };
  const forgejoToken = FORGEJO_TOKEN;
  if (forgejoToken && forgejoToken.trim()) {
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_1 = `credential.${FORGEJO_BASE_URL.replace(/\/+$/, "")}.helper`;
    env.GIT_CONFIG_VALUE_1 = FORGEJO_GIT_CREDENTIAL_HELPER;
    env[FORGEJO_GIT_CREDENTIAL_TOKEN_VAR] = forgejoToken;
  }
  return env;
}

/**
 * Build an env for `git` subprocesses: `process.env` plus `buildGitAuthEnv`, so
 * authenticated pushes/fetches use the installation token.
 */
export function buildEnvForGhGit(token: string): NodeJS.ProcessEnv {
  return { ...process.env, ...buildGitAuthEnv(token) };
}

const gitEnvEscalatedOwners = new Set<string>();

/**
 * Build a git env for `owner`, self-healing a stale/poisoned cached token: on
 * failure the cache entry is evicted and exactly one fresh mint is attempted.
 * Returns undefined only if both attempts fail — git then falls back to the
 * host's ambient credentials, a real privilege change, so the first failure per
 * owner is escalated via log.error (later ones warn; the 2026-07-24 incident
 * produced 262 of these in 24h and log.error pages Slack).
 */
export async function buildGitEnvForOwner(owner: string): Promise<NodeJS.ProcessEnv | undefined> {
  try {
    return buildEnvForGhGit(await getInstallationTokenForOwner(owner));
  } catch (firstErr) {
    invalidateInstallationToken(owner);
    try {
      const env = buildEnvForGhGit(await getInstallationTokenForOwner(owner));
      log.warn(`[github-app] git token for ${owner} recovered after cache eviction (first attempt: ${firstErr instanceof Error ? firstErr.message : String(firstErr)})`);
      return env;
    } catch (retryErr) {
      const msg = `[github-app] git token fetch failed for ${owner} after cache eviction + retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)} — git will run with the host's ambient credentials instead of the scoped installation token`;
      if (gitEnvEscalatedOwners.has(owner)) log.warn(msg);
      else { gitEnvEscalatedOwners.add(owner); log.error(msg); }
      return undefined;
    }
  }
}
