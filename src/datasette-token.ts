/**
 * Per-session tokens for the read-only Datasette proxy
 * (#clw_01M89P9YVSQY0S29YP6KBPJAQQ).
 *
 * A session holding any `datasette:<db>` capability gets `CLAWS_DATASETTE_URL`
 * and `CLAWS_DATASETTE_TOKEN` in its environment. It sends the token as a
 * Bearer header to Claws' `/api/datasette/*` route (src/datasette-proxy.ts),
 * which forwards GET reads of the databases the session currently holds to
 * the in-cluster Datasette, so the session holds no upstream credential.
 *
 * Same scheme as src/ha-read-token.ts: `<sessionId>.<base64url HMAC-SHA256>`
 * over `claws-datasette:<sessionId>`, keyed by a secret derived from the
 * Grafana JWT signing key, so it is deterministic per session and nothing is
 * stored. One token covers every Datasette database; the verifier returns the
 * set the open session holds right now.
 */
import crypto from "node:crypto";
import { SESSION_POD_SETTINGS } from "./config.js";
import { getPersistedSession } from "./db.js";
import { derivedSecret } from "./grafana-jwt.js";
import { safeCompare } from "./internal-mcp-token.js";
import { datasetteDatabaseName } from "./capabilities.js";

/** The proxy route prefix on the Claws web tier. */
export const DATASETTE_ROUTE_PREFIX = "/api/datasette";

const DATASETTE_INFO = "claws-datasette";
const VERIFY_CACHE_TTL_MS = 30_000;

function mac(sessionId: string): string {
  return crypto.createHmac("sha256", derivedSecret(DATASETTE_INFO)).update(`${DATASETTE_INFO}:${sessionId}`).digest("base64url");
}

/** The Datasette proxy token for `sessionId`. */
export function mintDatasetteToken(sessionId: string): string {
  return `${sessionId}.${mac(sessionId)}`;
}

/** The session id a well-formed, correctly signed token names, else null. Does not check the session. */
export function parseDatasetteToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const sessionId = token.slice(0, dot);
  return safeCompare(token.slice(dot + 1), mac(sessionId)) ? sessionId : null;
}

/** `CLAWS_DATASETTE_URL` and `CLAWS_DATASETTE_TOKEN` for a session holding a `datasette:*` capability; `{}` when no session MCP URL is configured. */
export function datasetteEnv(sessionId: string): Record<string, string> {
  const base = SESSION_POD_SETTINGS.mcpUrl.replace(/\/+$/, "");
  if (!base) return {};
  return {
    CLAWS_DATASETTE_URL: `${base}${DATASETTE_ROUTE_PREFIX}`,
    CLAWS_DATASETTE_TOKEN: mintDatasetteToken(sessionId),
  };
}

// Keyed by SHA-256 of the token so a burst of reads costs one database read.
const verifyCache = new Map<string, { result: VerifiedDatasetteToken | null; at: number }>();

/** The verified session and the Datasette databases it currently holds. */
export interface VerifiedDatasetteToken {
  sessionId: string;
  databases: ReadonlySet<string>;
}

/** Test hook: forget cached verdicts. */
export function clearDatasetteTokenCache(): void {
  verifyCache.clear();
}

/**
 * The session `token` is signed for and the database names it currently
 * holds as `datasette:*` capabilities, or null when the token is invalid, the
 * session has ended or it holds none. Each verdict is cached for 30 s.
 */
export async function verifyDatasetteToken(token: string, now: number = Date.now()): Promise<VerifiedDatasetteToken | null> {
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const hit = verifyCache.get(key);
  if (hit && now - hit.at < VERIFY_CACHE_TTL_MS) return hit.result;
  const result = await verifyUncached(token);
  if (verifyCache.size > 1000) verifyCache.clear();
  verifyCache.set(key, { result, at: now });
  return result;
}

async function verifyUncached(token: string): Promise<VerifiedDatasetteToken | null> {
  const sessionId = parseDatasetteToken(token);
  if (!sessionId) return null;
  const row = await getPersistedSession(sessionId);
  if (!row || row.ended_at != null) return null;
  let caps: unknown;
  try {
    caps = JSON.parse(row.capabilities ?? "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(caps)) return null;
  const databases = new Set<string>();
  for (const id of caps) {
    const db = typeof id === "string" ? datasetteDatabaseName(id) : null;
    if (db) databases.add(db);
  }
  return databases.size > 0 ? { sessionId, databases } : null;
}
