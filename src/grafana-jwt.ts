/**
 * Claws-signed Grafana observability JWTs (#clw_01M5AW39TVQ6KX2WRDZGHSN2TZ).
 *
 * Claws holds one RSA signing key (config key `grafanaJwtSigningKey`, PKCS8
 * PEM) and publishes its public half at `/.well-known/claws-jwks.json`. Each
 * cluster's Grafana trusts that JWKS through `[auth.jwt]`, pins `iss` and its
 * own `aud`, and auto-creates the `claws-observability` Viewer user on first
 * use, so no service account, token or admin credential lives in Grafana and
 * a Grafana rebuild heals itself on the next request. See
 * docs/observability-access.md.
 */
import crypto from "node:crypto";
import type { DiagnosticContext } from "./diagnostic-queries.js";
import { GRAFANA_JWT_SIGNING_KEY, PROD_GRAFANA_URL, FLEET_GRAFANA_URL, writeConfig } from "./config.js";

export type GrafanaCluster = "prod" | "fleet";
export const GRAFANA_CLUSTERS: readonly GrafanaCluster[] = ["prod", "fleet"];

export const GRAFANA_JWT_ISSUER = "claws";
export const GRAFANA_JWT_SUBJECT = "claws-observability";
export const GRAFANA_JWT_EMAIL = "claws-observability@bstjohn.net";

export function isGrafanaCluster(value: string): value is GrafanaCluster {
  return (GRAFANA_CLUSTERS as readonly string[]).includes(value);
}

/** The `aud` each cluster's Grafana pins with `expect_claims`. */
export function grafanaAudience(cluster: GrafanaCluster): string {
  return `grafana-${cluster}`;
}

export function grafanaUrl(cluster: GrafanaCluster): string {
  return cluster === "prod" ? PROD_GRAFANA_URL : FLEET_GRAFANA_URL;
}

interface SigningKey {
  pem: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  kid: string;
}

let cached: SigningKey | null = null;
/** A key generated before `ensureSigningKey` has persisted it. */
let pendingPem: string | null = null;

function parseKey(pem: string): SigningKey {
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey);
  const der = publicKey.export({ format: "der", type: "spki" });
  const kid = crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
  return { pem, privateKey, publicKey, kid };
}

/** The current signing key: the configured one, else one generated in memory
 *  for `ensureSigningKey` to persist. Re-parsed when the config value changes,
 *  so a key written by another process is picked up on config reload. */
function currentKey(): SigningKey {
  const pem = GRAFANA_JWT_SIGNING_KEY || pendingPem;
  if (!pem) {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    pendingPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    return currentKey();
  }
  if (cached?.pem !== pem) cached = parseKey(pem);
  return cached;
}

/** Make sure a signing key exists and is stored in the config store. Called at
 *  startup; a no-op once `grafanaJwtSigningKey` is configured. */
export async function ensureSigningKey(): Promise<void> {
  if (GRAFANA_JWT_SIGNING_KEY) {
    pendingPem = null;
    return;
  }
  const { pem } = currentKey();
  await writeConfig({ grafanaJwtSigningKey: pem });
  pendingPem = null;
}

/** A 32-byte HKDF-SHA256 key derived from the current signing key's PKCS8 DER
 *  and `info`, for Claws-internal MACs (e.g. the pages read token). Rotating
 *  the signing key changes every derived secret. */
export function derivedSecret(info: string): Buffer {
  const der = currentKey().privateKey.export({ format: "der", type: "pkcs8" });
  return Buffer.from(crypto.hkdfSync("sha256", der, Buffer.alloc(0), info, 32));
}

/** The public JWK set Grafana fetches through `auth.jwt.jwk_set_url`. */
export function jwks(): { keys: Array<{ kty: string; n: string; e: string; alg: "RS256"; use: "sig"; kid: string }> } {
  const { publicKey, kid } = currentKey();
  const jwk = publicKey.export({ format: "jwk" });
  return { keys: [{ kty: jwk.kty as string, n: jwk.n as string, e: jwk.e as string, alg: "RS256", use: "sig", kid }] };
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * A compact RS256 JWT signed with the Claws key published at
 * `/.well-known/claws-jwks.json`, carrying `iss: "claws"`, the given `aud` and
 * `sub`, and any `extra` claims, valid for `ttlMs`. Any service that trusts the
 * JWKS and pins its own `aud` can verify it (Grafana, content moderation).
 */
export function mintClawsJwt(
  options: { aud: string; sub: string; ttlMs: number; extra?: Record<string, unknown> },
  now: number = Date.now(),
): string {
  const { privateKey, kid } = currentKey();
  const iat = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const claims = {
    iss: GRAFANA_JWT_ISSUER,
    aud: options.aud,
    sub: options.sub,
    ...options.extra,
    iat,
    exp: iat + Math.floor(options.ttlMs / 1000),
    jti: crypto.randomUUID(),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

/** A compact RS256 JWT for `cluster`'s Grafana, valid for `ttlMs`. Carries no
 *  role claim: Grafana assigns the auto-created user its Viewer default. */
export function mintGrafanaJwt(cluster: GrafanaCluster, ttlMs: number, now: number = Date.now()): string {
  return mintClawsJwt(
    { aud: grafanaAudience(cluster), sub: GRAFANA_JWT_SUBJECT, ttlMs, extra: { email: GRAFANA_JWT_EMAIL } },
    now,
  );
}

const PROBE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;

export type GrafanaProbeResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: "status" | "admin_user" | "timeout" | "fetch_error"; status?: number; error?: string; durationMs: number };

/** Error code for a thrown fetch error: `cause.code` (where Node's fetch puts
 *  ECONNREFUSED/ENOTFOUND), then `code`, then `name`. Never the message. */
function errorCode(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const code = [e?.cause?.code, e?.code, e?.name].find((c): c is string => typeof c === "string" && c !== "");
  return code ?? "unknown";
}

/** Probe `cluster`'s Grafana with a fresh Claws JWT on `GET /api/user`. Ok only
 *  on 200 with `isGrafanaAdmin === false`; otherwise the result names why
 *  (`status`, `admin_user`, `timeout`, `fetch_error`) and how long it took.
 *  Never throws. */
export async function probeGrafanaAuth(cluster: GrafanaCluster): Promise<GrafanaProbeResult> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  try {
    const res = await fetch(`${grafanaUrl(cluster)}/api/user`, {
      headers: { Authorization: `Bearer ${mintGrafanaJwt(cluster, PROBE_TTL_MS)}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return { ok: false, reason: "status", status: res.status, durationMs: elapsed() };
    const body = await res.json() as { isGrafanaAdmin?: unknown };
    if (body.isGrafanaAdmin !== false) return { ok: false, reason: "admin_user", durationMs: elapsed() };
    return { ok: true, durationMs: elapsed() };
  } catch (err) {
    const error = errorCode(err);
    const timedOut = error === "TimeoutError" || error === "AbortError" || error === "UND_ERR_CONNECT_TIMEOUT";
    return { ok: false, reason: timedOut ? "timeout" : "fetch_error", error, durationMs: elapsed() };
  }
}

/** Structured logger context for a failed probe. Omits unset fields (the
 *  logger drops empty values) and never carries the JWT. */
export function grafanaProbeLogContext(cluster: GrafanaCluster, result: GrafanaProbeResult): DiagnosticContext {
  const context: DiagnosticContext = { cluster, durationMs: result.durationMs };
  if (result.ok) return context;
  context.probeReason = result.reason;
  if (result.reason === "status" && result.status !== undefined) context.httpStatus = result.status;
  if ((result.reason === "timeout" || result.reason === "fetch_error") && result.error) context.probeError = result.error;
  return context;
}

/** The warn message for a failed probe: Grafana only "rejected" the token for
 *  `status` and `admin_user`; otherwise the probe "failed". */
export function grafanaProbeFailureMessage(cluster: GrafanaCluster, result: GrafanaProbeResult): string {
  if (result.ok) return `${cluster} Grafana accepted the Claws observability JWT probe`;
  const verb = result.reason === "status" || result.reason === "admin_user"
    ? "rejected the Claws observability JWT probe"
    : "Claws observability JWT probe failed";
  return `${cluster} Grafana ${verb} (${result.reason})`;
}
