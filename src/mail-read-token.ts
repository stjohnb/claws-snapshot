/**
 * Per-session tokens for the read-only prod mailbox proxy
 * (#clw_01M8BM2RWC1T085EEEVZ6X21EH).
 *
 * A session holding the `prod-mail-read` capability gets `CLAWS_MAIL_READ_URL`
 * and `CLAWS_MAIL_READ_TOKEN` in its environment. It sends the token as a
 * Bearer header to Claws' `/api/mail-read/*` routes (src/mail-read-proxy.ts),
 * which read the mailbox over IMAP with the web-tier-held reader login, so the
 * session never holds the mailbox password.
 *
 * Same scheme as src/ha-read-token.ts: `<sessionId>.<base64url HMAC-SHA256>`
 * over `claws-mail-read:<sessionId>`, keyed by a secret derived from the
 * Grafana JWT signing key, so it is deterministic per session and nothing is
 * stored. It is valid only while the session row is open and still holds
 * `prod-mail-read`.
 */
import crypto from "node:crypto";
import { SESSION_POD_SETTINGS } from "./config.js";
import { getPersistedSession } from "./db.js";
import { derivedSecret } from "./grafana-jwt.js";
import { safeCompare } from "./internal-mcp-token.js";
import { PROD_MAIL_READ_CAPABILITY_ID } from "./capabilities.js";

/** The proxy route prefix on the Claws web tier. */
export const MAIL_READ_ROUTE_PREFIX = "/api/mail-read";

const MAIL_READ_INFO = "claws-mail-read";
const VERIFY_CACHE_TTL_MS = 30_000;

function mac(sessionId: string): string {
  return crypto.createHmac("sha256", derivedSecret(MAIL_READ_INFO)).update(`${MAIL_READ_INFO}:${sessionId}`).digest("base64url");
}

/** The mailbox read token for `sessionId`. */
export function mintMailReadToken(sessionId: string): string {
  return `${sessionId}.${mac(sessionId)}`;
}

/** The session id a well-formed, correctly signed token names, else null. Does not check the session. */
export function parseMailReadToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const sessionId = token.slice(0, dot);
  return safeCompare(token.slice(dot + 1), mac(sessionId)) ? sessionId : null;
}

/** `CLAWS_MAIL_READ_URL` and `CLAWS_MAIL_READ_TOKEN` for a session holding `prod-mail-read`; `{}` when no session MCP URL is configured. */
export function mailReadEnv(sessionId: string): Record<string, string> {
  const base = SESSION_POD_SETTINGS.mcpUrl.replace(/\/+$/, "");
  if (!base) return {};
  return {
    CLAWS_MAIL_READ_URL: `${base}${MAIL_READ_ROUTE_PREFIX}`,
    CLAWS_MAIL_READ_TOKEN: mintMailReadToken(sessionId),
  };
}

// Keyed by SHA-256 of the token so a burst of reads costs one database read.
const verifyCache = new Map<string, { result: string | null; at: number }>();

/** Test hook: forget cached verdicts. */
export function clearMailReadTokenCache(): void {
  verifyCache.clear();
}

/**
 * The session id `token` is signed for while that session is open and holds
 * `prod-mail-read`, else null. Each verdict is cached for 30 s.
 */
export async function verifyMailReadToken(token: string, now: number = Date.now()): Promise<string | null> {
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const hit = verifyCache.get(key);
  if (hit && now - hit.at < VERIFY_CACHE_TTL_MS) return hit.result;
  const result = await verifyUncached(token);
  if (verifyCache.size > 1000) verifyCache.clear();
  verifyCache.set(key, { result, at: now });
  return result;
}

async function verifyUncached(token: string): Promise<string | null> {
  const sessionId = parseMailReadToken(token);
  if (!sessionId) return null;
  const row = await getPersistedSession(sessionId);
  if (!row || row.ended_at != null) return null;
  try {
    const caps: unknown = JSON.parse(row.capabilities ?? "[]");
    return Array.isArray(caps) && caps.includes(PROD_MAIL_READ_CAPABILITY_ID) ? sessionId : null;
  } catch {
    return null;
  }
}
