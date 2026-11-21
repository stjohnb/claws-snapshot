/**
 * Machine-to-service API authorisation (#clw_01M7RC7NY8JM8T76FKNBVK53ND).
 *
 * A machine (the NAS's shutdown hook today) signs in to Authentik as a listed
 * service account with the client-credentials grant against the `claws-api`
 * provider and sends the short-lived access token as a bearer. Claws holds no
 * copy of any secret the request carries: it verifies the token's RS256
 * signature against Authentik's JWKS (`<issuer>jwks/`), its `iss`, `aud` and
 * `exp`, and then maps the token's `groups` claim to named actions through
 * `CLAWS_MACHINE_API_GRANTS`. Disabling the account or dropping its group cuts
 * access within the token's 5-minute life, with no Claws deploy.
 *
 * Header trust from the Authentik outpost is deliberately not used: agent and
 * session pods reach port 3000 directly and could forge `X-authentik-*` headers.
 */
import crypto from "node:crypto";
import * as config from "./config.js";
import * as log from "./log.js";

const COMPONENT = "machine-auth";
/** How long one JWKS fetch may take. */
const JWKS_FETCH_TIMEOUT_MS = 10_000;
/** An unknown `kid` refetches the JWKS at most this often. */
const JWKS_REFETCH_INTERVAL_MS = 60_000;
/** Allowed clock skew on `exp`. */
const EXP_SKEW_MS = 30_000;

/** The verified caller a machine token names. */
export interface MachineCaller {
  sub: string;
  preferredUsername: string;
  groups: string[];
}

/**
 * Why a token was refused. `no-keys` means no signing key could ever be loaded
 * (answered 503); every other reason is the caller's fault (answered 401).
 */
export type MachineAuthRefusal =
  | "missing"
  | "malformed"
  | "unsupported-alg"
  | "unknown-kid"
  | "bad-signature"
  | "wrong-issuer"
  | "wrong-audience"
  | "expired"
  | "no-keys";

export type MachineAuthResult = { ok: true; caller: MachineCaller } | { ok: false; reason: MachineAuthRefusal };

interface KeyCache {
  keys: Map<string, crypto.KeyObject>;
  /** When the last fetch was attempted (successful or not), ms since the epoch. */
  lastAttemptAt: number | null;
  inflight: Promise<void> | null;
}

let cache: KeyCache = { keys: new Map(), lastAttemptAt: null, inflight: null };

/** Drops the cached signing keys. Tests only. */
export function resetMachineAuthForTest(): void {
  cache = { keys: new Map(), lastAttemptAt: null, inflight: null };
}

/** Whether `action` is switched on: the issuer, the audience and a grant for it are all set. */
export function machineActionEnabled(action: string): boolean {
  return Boolean(config.MACHINE_AUTH_ISSUER && config.MACHINE_AUTH_AUDIENCE && config.MACHINE_API_GRANTS[action]?.length);
}

/** True when any of `groups` is granted `action` in `CLAWS_MACHINE_API_GRANTS`. */
export function machineMayDo(action: string, groups: readonly string[]): boolean {
  const granted = config.MACHINE_API_GRANTS[action] ?? [];
  return groups.some((g) => granted.includes(g));
}

function jwksUrl(issuer: string): string {
  return `${issuer.endsWith("/") ? issuer : `${issuer}/`}jwks/`;
}

/** Fetches the JWKS and replaces the cache; on any failure keeps the last good set. */
async function fetchKeys(now: number): Promise<void> {
  cache.lastAttemptAt = now;
  const target = jwksUrl(config.MACHINE_AUTH_ISSUER);
  const started = Date.now();
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) {
      log.warn("machine auth jwks fetch failed", { component: COMPONENT, target, http_status: res.status, duration_ms: Date.now() - started, cached_keys: cache.keys.size });
      return;
    }
    const body = (await res.json()) as { keys?: unknown };
    const keys = new Map<string, crypto.KeyObject>();
    for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
      if (!jwk || typeof jwk !== "object") continue;
      const k = jwk as Record<string, unknown>;
      if (k["kty"] !== "RSA" || (k["use"] !== undefined && k["use"] !== "sig")) continue;
      try {
        keys.set(typeof k["kid"] === "string" ? k["kid"] : "", crypto.createPublicKey({ key: k as crypto.JsonWebKeyInput["key"], format: "jwk" }));
      } catch { /* an unusable key is skipped */ }
    }
    if (keys.size === 0) {
      log.warn("machine auth jwks fetch failed", { component: COMPONENT, target, reason: "no-usable-keys", duration_ms: Date.now() - started, cached_keys: cache.keys.size });
      return;
    }
    cache.keys = keys;
    log.info("machine auth jwks fetched", { component: COMPONENT, target, keys: keys.size, duration_ms: Date.now() - started });
  } catch (err) {
    log.warn("machine auth jwks fetch failed", { component: COMPONENT, target, probe_error: String(err), duration_ms: Date.now() - started, cached_keys: cache.keys.size });
  }
}

/** The signing keys to try for `kid`: fetched on first use and refetched (rate-limited) on an unknown kid. */
async function keysFor(kid: string | undefined, now: number): Promise<crypto.KeyObject[]> {
  const pick = (): crypto.KeyObject[] => {
    if (kid === undefined) return [...cache.keys.values()];
    const key = cache.keys.get(kid);
    return key ? [key] : [];
  };
  let found = pick();
  if (found.length > 0) return found;
  if (cache.inflight) {
    await cache.inflight;
  } else if (cache.lastAttemptAt === null || now - cache.lastAttemptAt >= JWKS_REFETCH_INTERVAL_MS) {
    cache.inflight = fetchKeys(now).finally(() => { cache.inflight = null; });
    await cache.inflight;
  }
  found = pick();
  return found;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verifies an Authentik-signed machine access token. Accepts only RS256, with
 * `iss` equal to `CLAWS_MACHINE_AUTH_ISSUER`, `aud` equal to or containing
 * `CLAWS_MACHINE_AUTH_AUDIENCE`, and `exp` in the future (30 s of skew).
 * `now` is ms since the epoch.
 */
export async function verifyMachineToken(bearer: string, now: number): Promise<MachineAuthResult> {
  if (!bearer) return { ok: false, reason: "missing" };
  const parts = bearer.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[2]) return { ok: false, reason: "malformed" };
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const header = decodeSegment(rawHeader);
  const payload = decodeSegment(rawPayload);
  if (!header || !payload) return { ok: false, reason: "malformed" };
  if (header["alg"] !== "RS256") return { ok: false, reason: "unsupported-alg" };
  const kid = typeof header["kid"] === "string" ? header["kid"] : undefined;

  const keys = await keysFor(kid, now);
  if (keys.length === 0) return { ok: false, reason: cache.keys.size === 0 ? "no-keys" : "unknown-kid" };
  const signed = Buffer.from(`${rawHeader}.${rawPayload}`);
  const signature = Buffer.from(rawSignature, "base64url");
  if (!keys.some((key) => crypto.verify("RSA-SHA256", signed, key, signature))) return { ok: false, reason: "bad-signature" };

  if (payload["iss"] !== config.MACHINE_AUTH_ISSUER) return { ok: false, reason: "wrong-issuer" };
  const aud = payload["aud"];
  const audience = config.MACHINE_AUTH_AUDIENCE;
  if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) return { ok: false, reason: "wrong-audience" };
  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return { ok: false, reason: "malformed" };
  if (exp * 1000 + EXP_SKEW_MS <= now) return { ok: false, reason: "expired" };

  const groups = Array.isArray(payload["groups"]) ? payload["groups"].filter((g): g is string => typeof g === "string") : [];
  return {
    ok: true,
    caller: {
      sub: typeof payload["sub"] === "string" ? payload["sub"] : "",
      preferredUsername: typeof payload["preferred_username"] === "string" ? payload["preferred_username"] : "",
      groups,
    },
  };
}
