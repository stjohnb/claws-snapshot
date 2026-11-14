import fs from "node:fs";
import path from "node:path";
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_WIF_RULE_ID,
  ANTHROPIC_WIF_ORGANIZATION_ID,
  ANTHROPIC_WIF_SERVICE_ACCOUNT_ID,
  ANTHROPIC_WIF_WORKSPACE_ID,
  ANTHROPIC_WIF_K8S_SERVICE_ACCOUNT,
  ANTHROPIC_ACCESS_TOKEN,
  ANTHROPIC_ACCESS_TOKEN_EXPIRES_AT,
} from "./config.js";
import * as log from "./log.js";
import { createK8sClient, SERVICE_ACCOUNT_DIR, type K8sClient } from "./k8s/api.js";

// Anthropic workload identity federation for OpenCode's `anthropic/` models
// (#clw_01M6KP2HTJ2K6NXSCX5VZJ61PE). Claws mints a short-lived JWT for the
// `claws-anthropic` ServiceAccount through the TokenRequest API, exchanges it
// at Anthropic's OAuth token endpoint (RFC 7523 jwt-bearer) and hands the
// short-lived access token to OpenCode as a Bearer token. Agent pods hold no
// cluster identity: they use the access token the controller minted for them
// (`CLAWS_ANTHROPIC_ACCESS_TOKEN`). No token, JWT or response body is logged.

export const ANTHROPIC_OAUTH_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const ANTHROPIC_WIF_AUDIENCE = "https://api.anthropic.com";
export const ANTHROPIC_WIF_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Requested lifetime of each minted ServiceAccount JWT (the issuer's maximum in the Console). */
export const ANTHROPIC_WIF_JWT_EXPIRATION_SECONDS = 21_600;
/** A cached access token with less than this left is refreshed, so every OpenCode spawn gets at least this long. */
export const ANTHROPIC_WIF_REFRESH_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 15_000;
const EXCHANGE_FAILED = "Anthropic workload identity token exchange failed";

export interface AnthropicAccessToken {
  /** The `sk-ant-oat01-…` access token: a credential. */
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface AnthropicCredentialState {
  mode: "wif" | "api-key" | "none";
  lastExchange: { ok: boolean; at: string; detail: string } | null;
}

interface WifDeps {
  k8s: () => K8sClient;
  fetch: typeof fetch;
  saDir: string;
  now: () => number;
}

const defaultDeps: WifDeps = {
  k8s: () => createK8sClient(),
  fetch: (...args) => fetch(...args),
  saDir: SERVICE_ACCOUNT_DIR,
  now: Date.now,
};

let deps: WifDeps = defaultDeps;
let cached: AnthropicAccessToken | null = null;
let inflight: Promise<AnthropicAccessToken> | null = null;
let lastExchange: AnthropicCredentialState["lastExchange"] = null;

/** Tests only: swap the k8s client, fetch, ServiceAccount dir or clock, and clear the cache. */
export function setAnthropicWifDepsForTests(overrides: Partial<WifDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
  cached = null;
  inflight = null;
  lastExchange = null;
}

/** Whether the three IDs federation needs (rule, organisation, service account) are all set. */
export function isAnthropicWifConfigured(): boolean {
  return !!ANTHROPIC_WIF_RULE_ID && !!ANTHROPIC_WIF_ORGANIZATION_ID && !!ANTHROPIC_WIF_SERVICE_ACCOUNT_ID;
}

/** Whether this process can hand OpenCode a federated token: it can exchange one, or (an agent pod) was given one. */
export function isAnthropicFederationAvailable(): boolean {
  return isAnthropicWifConfigured() || !!ANTHROPIC_ACCESS_TOKEN;
}

function hasServiceAccountToken(): boolean {
  return fs.existsSync(path.join(deps.saDir, "token"));
}

function podNamespace(): string {
  try {
    return fs.readFileSync(path.join(deps.saDir, "namespace"), "utf8").trim() || "default";
  } catch {
    return "default";
  }
}

/** The pre-minted token an agent pod received in its env file, or null when none or unparseable. */
function preMintedToken(): AnthropicAccessToken | null {
  const token = ANTHROPIC_ACCESS_TOKEN;
  if (!token) return null;
  const expiresAt = Date.parse(ANTHROPIC_ACCESS_TOKEN_EXPIRES_AT);
  if (!Number.isFinite(expiresAt)) return null;
  return { token, expiresAt };
}

function errorType(body: unknown): string {
  const raw = (body as { error?: unknown } | null)?.error;
  const type = typeof raw === "string" ? raw : (raw as { type?: unknown } | undefined)?.type;
  // Only a bare identifier, never free text from the body.
  return typeof type === "string" && /^[a-z_]{1,64}$/.test(type) ? type : "authentication_error";
}

async function exchange(): Promise<AnthropicAccessToken> {
  const started = deps.now();
  const sa = ANTHROPIC_WIF_K8S_SERVICE_ACCOUNT || "claws-anthropic";
  const fields = { component: "anthropic-wif", rule: ANTHROPIC_WIF_RULE_ID, k8s_service_account: sa };
  const fail = (detail: string): never => {
    lastExchange = { ok: false, at: new Date(deps.now()).toISOString(), detail };
    log.warn("anthropic token exchange failed", { ...fields, outcome: "failed", duration_ms: deps.now() - started, detail });
    throw new Error(`${EXCHANGE_FAILED}: ${detail}`);
  };

  const minted = await deps.k8s().createServiceAccountToken(podNamespace(), sa, [ANTHROPIC_WIF_AUDIENCE], ANTHROPIC_WIF_JWT_EXPIRATION_SECONDS);
  if (!minted.ok) return fail(`could not mint a ${sa} ServiceAccount token (${minted.message})`);
  const grantedSeconds = Math.round((Date.parse(minted.value.expirationTimestamp) - deps.now()) / 1000);
  if (Number.isFinite(grantedSeconds) && grantedSeconds < ANTHROPIC_WIF_JWT_EXPIRATION_SECONDS - 60) {
    log.warn("anthropic wif jwt shorter than requested", { ...fields, requested_seconds: ANTHROPIC_WIF_JWT_EXPIRATION_SECONDS, granted_seconds: grantedSeconds });
  }

  const body: Record<string, string> = {
    grant_type: ANTHROPIC_WIF_GRANT_TYPE,
    assertion: minted.value.token,
    federation_rule_id: ANTHROPIC_WIF_RULE_ID,
    organization_id: ANTHROPIC_WIF_ORGANIZATION_ID,
    service_account_id: ANTHROPIC_WIF_SERVICE_ACCOUNT_ID,
  };
  if (ANTHROPIC_WIF_WORKSPACE_ID) body["workspace_id"] = ANTHROPIC_WIF_WORKSPACE_ID;

  let res: Response;
  try {
    res = await deps.fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    return fail(e?.name === "TimeoutError" ? "timed out" : e?.cause?.code ?? e?.message ?? "request failed");
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) return fail(`HTTP ${res.status} ${errorType(json)}`);
  const parsed = json as { access_token?: unknown; expires_in?: unknown } | null;
  if (typeof parsed?.access_token !== "string" || !parsed.access_token || typeof parsed.expires_in !== "number") {
    return fail(`HTTP ${res.status} response has no access_token`);
  }
  const expiresAt = deps.now() + parsed.expires_in * 1000;
  const hours = (parsed.expires_in / 3600).toFixed(1);
  lastExchange = { ok: true, at: new Date(deps.now()).toISOString(), detail: `token expires in ${hours}h` };
  log.info("anthropic token exchange", { ...fields, outcome: "ok", duration_ms: deps.now() - started, expires_in: parsed.expires_in });
  return { token: parsed.access_token, expiresAt };
}

/**
 * A federated Anthropic access token with at least
 * `ANTHROPIC_WIF_REFRESH_THRESHOLD_MS` left where possible, or null when
 * federation is unavailable. Concurrent callers share one in-flight exchange.
 * On a failed refresh a still-valid cached token is served; otherwise this
 * throws `Anthropic workload identity token exchange failed: …`.
 *
 * With no ServiceAccount token file (an agent pod, or a host outside the
 * cluster) it never mints: it returns the pre-minted
 * `CLAWS_ANTHROPIC_ACCESS_TOKEN`, or null when there is none.
 *
 * `forceRefresh` (the connectivity check) bypasses the cache and never falls
 * back to it, so a failure surfaces.
 */
export async function getAnthropicAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<AnthropicAccessToken | null> {
  if (!hasServiceAccountToken()) {
    const pre = preMintedToken();
    if (!pre) return null;
    if (pre.expiresAt <= deps.now()) {
      throw new Error(`${EXCHANGE_FAILED}: the pod's pre-minted access token expired at ${new Date(pre.expiresAt).toISOString()}`);
    }
    return pre;
  }
  if (!isAnthropicWifConfigured()) return null;
  if (!opts.forceRefresh && cached && cached.expiresAt - deps.now() > ANTHROPIC_WIF_REFRESH_THRESHOLD_MS) return cached;
  if (!inflight) {
    inflight = exchange()
      .then((token) => {
        cached = token;
        return token;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (err) {
    if (!opts.forceRefresh && cached && cached.expiresAt > deps.now()) return cached;
    throw err;
  }
}

/** The credential OpenCode's `anthropic/` models use, and the last exchange this process made. */
export function anthropicCredentialState(): AnthropicCredentialState {
  const mode = isAnthropicFederationAvailable() ? "wif" : ANTHROPIC_API_KEY ? "api-key" : "none";
  return { mode, lastExchange };
}
