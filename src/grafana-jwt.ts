/**
 * The Claws JWT signing key (#clw_01M5AW39TVQ6KX2WRDZGHSN2TZ), and the fleet
 * Grafana sign-in probe.
 *
 * Claws holds one RSA signing key (config key `grafanaJwtSigningKey`, PKCS8
 * PEM; the name predates its current use) and publishes its public half at
 * `/.well-known/claws-jwks.json`. The key now serves content moderation tokens
 * (`mintClawsJwt`) and derived read tokens (`derivedSecret`, for the pages and
 * Home Assistant read tokens) only. Claws no longer signs Grafana tokens: it
 * signs in to Grafana as the Authentik service account `claws-service`
 * (src/grafana-auth.ts, #clw_01M7QFE3ZDE06M6JW202445NPX). See
 * docs/observability-access.md.
 */
import crypto from "node:crypto";
import type { DiagnosticContext } from "./diagnostic-queries.js";
import { GRAFANA_JWT_SIGNING_KEY, FLEET_GRAFANA_URL, writeConfig } from "./config.js";
import { grafanaServiceAccount, type GrafanaAuthMode } from "./grafana-auth.js";

/** Fleet Grafana is the only one Claws reads: prod data is read through it
 *  (#clw_01M7A7J69WPV7WHXW1EESEWQH1, #clw_01M7Q9T4AQAGSG48Z3P7B273HR). */
export type GrafanaCluster = "fleet";
/** The clusters whose Grafana is probed for `claws_grafana_auth_ok`. */
export const GRAFANA_CLUSTERS: readonly GrafanaCluster[] = ["fleet"];

export const GRAFANA_JWT_ISSUER = "claws";

export function isGrafanaCluster(value: string): value is GrafanaCluster {
  return (GRAFANA_CLUSTERS as readonly string[]).includes(value);
}

export function grafanaUrl(_cluster: GrafanaCluster): string {
  return FLEET_GRAFANA_URL;
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

/** The public JWK set served at `/.well-known/claws-jwks.json` (and mirrored
 *  by fleet-infra) for content moderation token verifiers. */
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
 * JWKS and pins its own `aud` can verify it (content moderation).
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

const PROBE_TIMEOUT_MS = 10_000;

export type GrafanaProbeResult =
  | { ok: true; authMode: GrafanaAuthMode; durationMs: number }
  | {
    ok: false;
    authMode: GrafanaAuthMode;
    reason: "unconfigured" | "status" | "admin_user" | "wrong_user" | "timeout" | "fetch_error";
    status?: number;
    error?: string;
    durationMs: number;
  };

/** Error code for a thrown fetch error: `cause.code` (where Node's fetch puts
 *  ECONNREFUSED/ENOTFOUND), then `code`, then `name`. Never the message. */
function errorCode(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const code = [e?.cause?.code, e?.code, e?.name].find((c): c is string => typeof c === "string" && c !== "");
  return code ?? "unknown";
}

/** Probe `cluster`'s Grafana on `GET /api/user` with the `claws-service`
 *  Basic header `grafanaAuthorization` sends. Ok only on 200 with
 *  `isGrafanaAdmin === false` and `login` equal to the service account's
 *  username; otherwise the result names why (`unconfigured` when no
 *  credentials are mounted, so no request is sent; `status`, `admin_user`,
 *  `wrong_user`, `timeout`, `fetch_error`) and how long it took. Never throws. */
export async function probeGrafanaAuth(cluster: GrafanaCluster): Promise<GrafanaProbeResult> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const account = grafanaServiceAccount();
  if (!account) return { ok: false, authMode: "unconfigured", reason: "unconfigured", durationMs: elapsed() };
  const authMode: GrafanaAuthMode = "authentik";
  try {
    const res = await fetch(`${grafanaUrl(cluster)}/api/user`, {
      headers: { Authorization: account.authorization, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return { ok: false, authMode, reason: "status", status: res.status, durationMs: elapsed() };
    const body = await res.json() as { isGrafanaAdmin?: unknown; login?: unknown };
    if (body.isGrafanaAdmin !== false) return { ok: false, authMode, reason: "admin_user", durationMs: elapsed() };
    if (body.login !== account.username) return { ok: false, authMode, reason: "wrong_user", durationMs: elapsed() };
    return { ok: true, authMode, durationMs: elapsed() };
  } catch (err) {
    const error = errorCode(err);
    const timedOut = error === "TimeoutError" || error === "AbortError" || error === "UND_ERR_CONNECT_TIMEOUT";
    return { ok: false, authMode, reason: timedOut ? "timeout" : "fetch_error", error, durationMs: elapsed() };
  }
}

/** Structured logger context for a probe, naming the auth mode. Omits unset
 *  fields (the logger drops empty values) and never carries the header. */
export function grafanaProbeLogContext(cluster: GrafanaCluster, result: GrafanaProbeResult): DiagnosticContext {
  const context: DiagnosticContext = { cluster, authMode: result.authMode, durationMs: result.durationMs };
  if (result.ok) return context;
  context.probeReason = result.reason;
  if (result.reason === "status" && result.status !== undefined) context.httpStatus = result.status;
  if ((result.reason === "timeout" || result.reason === "fetch_error") && result.error) context.probeError = result.error;
  return context;
}

/** The warn message for a failed probe: Grafana only "rejected" the sign-in
 *  for `status`, `admin_user` and `wrong_user`; `unconfigured` names the
 *  missing credentials; otherwise the probe "failed". */
export function grafanaProbeFailureMessage(cluster: GrafanaCluster, result: GrafanaProbeResult): string {
  if (result.ok) return `${cluster} Grafana accepted the Claws sign-in probe`;
  if (result.reason === "unconfigured") return `${cluster} Claws sign-in probe failed: no Authentik service-account credentials are mounted (unconfigured)`;
  const verb = result.reason === "status" || result.reason === "admin_user" || result.reason === "wrong_user"
    ? "rejected the Claws sign-in probe"
    : "Claws sign-in probe failed";
  return `${cluster} Grafana ${verb} (${result.reason})`;
}
