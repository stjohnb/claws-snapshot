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

/** The public JWK set Grafana fetches through `auth.jwt.jwk_set_url`. */
export function jwks(): { keys: Array<{ kty: string; n: string; e: string; alg: "RS256"; use: "sig"; kid: string }> } {
  const { publicKey, kid } = currentKey();
  const jwk = publicKey.export({ format: "jwk" });
  return { keys: [{ kty: jwk.kty as string, n: jwk.n as string, e: jwk.e as string, alg: "RS256", use: "sig", kid }] };
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** A compact RS256 JWT for `cluster`'s Grafana, valid for `ttlMs`. Carries no
 *  role claim: Grafana assigns the auto-created user its Viewer default. */
export function mintGrafanaJwt(cluster: GrafanaCluster, ttlMs: number, now: number = Date.now()): string {
  const { privateKey, kid } = currentKey();
  const iat = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const claims = {
    iss: GRAFANA_JWT_ISSUER,
    aud: grafanaAudience(cluster),
    sub: GRAFANA_JWT_SUBJECT,
    email: GRAFANA_JWT_EMAIL,
    iat,
    exp: iat + Math.floor(ttlMs / 1000),
    jti: crypto.randomUUID(),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

const PROBE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;

/** True only when `cluster`'s Grafana accepts a fresh Claws JWT on
 *  `GET /api/user` and reports a non-admin user. Never throws. */
export async function probeGrafanaAuth(cluster: GrafanaCluster): Promise<boolean> {
  try {
    const res = await fetch(`${grafanaUrl(cluster)}/api/user`, {
      headers: { Authorization: `Bearer ${mintGrafanaJwt(cluster, PROBE_TTL_MS)}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return false;
    const body = await res.json() as { isGrafanaAdmin?: unknown };
    return body.isGrafanaAdmin === false;
  } catch {
    return false;
  }
}
