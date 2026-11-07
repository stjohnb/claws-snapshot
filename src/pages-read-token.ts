/**
 * Per-session read tokens for the private fleet pages host
 * (#clw_01M619KBVSEV0SNRRXD33YYVQC).
 *
 * A session holding the `pages` capability gets `CLAWS_PAGES_READ_TOKEN` and
 * `CLAWS_PAGES_LOGIN_URL` in its environment. Traefik sends any pages request
 * carrying the token (as a Bearer header or the `claws_pages_token` cookie) to
 * Claws' `/api/pages/auth` ForwardAuth route instead of Authentik; the
 * `/__claws/login/<token>` route on the pages host turns the token into that
 * cookie for the session's browser. See docs/patterns.md (mid-session grants).
 *
 * The token is `<sessionId>.<base64url HMAC-SHA256>` over
 * `claws-pages-read:<sessionId>`, keyed by a secret derived from the Grafana
 * JWT signing key, so it is deterministic per session and nothing is stored:
 * a granted-env rebuild or resume re-derives the same value. It is valid only
 * while the session row is open and still holds `pages`.
 */
import crypto from "node:crypto";
import { getPagesHostConfig } from "./config.js";
import { getPersistedSession } from "./db.js";
import { derivedSecret } from "./grafana-jwt.js";
import { safeCompare } from "./internal-mcp-token.js";

export const PAGES_READ_COOKIE = "claws_pages_token";
export const PAGES_LOGIN_PATH = "/__claws/login";

const PAGES_READ_INFO = "claws-pages-read";
const PAGES_CAPABILITY = "pages";
const VERIFY_CACHE_TTL_MS = 30_000;

function mac(sessionId: string): string {
  return crypto.createHmac("sha256", derivedSecret(PAGES_READ_INFO)).update(`${PAGES_READ_INFO}:${sessionId}`).digest("base64url");
}

/** The pages read token for `sessionId`. */
export function mintPagesReadToken(sessionId: string): string {
  return `${sessionId}.${mac(sessionId)}`;
}

/** The session id a well-formed, correctly signed token names, else null. Does not check the session. */
export function parsePagesReadToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const sessionId = token.slice(0, dot);
  return safeCompare(token.slice(dot + 1), mac(sessionId)) ? sessionId : null;
}

/** `CLAWS_PAGES_READ_TOKEN` and `CLAWS_PAGES_LOGIN_URL` for a session holding `pages`; `{}` when no pages host is configured. */
export function pagesReadEnv(sessionId: string): Record<string, string> {
  const host = getPagesHostConfig();
  if (!host) return {};
  const token = mintPagesReadToken(sessionId);
  return {
    CLAWS_PAGES_READ_TOKEN: token,
    CLAWS_PAGES_LOGIN_URL: `${host.baseUrl}${PAGES_LOGIN_PATH}/${token}`,
  };
}

/** The pages host's hostname (no port), or null when no pages host is configured. */
export function pagesHostname(): string | null {
  const host = getPagesHostConfig();
  if (!host) return null;
  try {
    return new URL(host.baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Keyed by SHA-256 of the token so a page's asset storm costs one database read.
const verifyCache = new Map<string, { result: "ok" | "invalid"; at: number }>();

/** Test hook: forget cached verdicts. */
export function clearPagesReadTokenCache(): void {
  verifyCache.clear();
}

/** `"ok"` when `token` is signed for a session that is still open and holds `pages`. */
export async function verifyPagesReadToken(token: string, now: number = Date.now()): Promise<"ok" | "invalid"> {
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const hit = verifyCache.get(key);
  if (hit && now - hit.at < VERIFY_CACHE_TTL_MS) return hit.result;
  const result = await verifyUncached(token);
  if (verifyCache.size > 1000) verifyCache.clear();
  verifyCache.set(key, { result, at: now });
  return result;
}

async function verifyUncached(token: string): Promise<"ok" | "invalid"> {
  const sessionId = parsePagesReadToken(token);
  if (!sessionId) return "invalid";
  const row = await getPersistedSession(sessionId);
  if (!row || row.ended_at != null) return "invalid";
  try {
    const caps: unknown = JSON.parse(row.capabilities ?? "[]");
    return Array.isArray(caps) && caps.includes(PAGES_CAPABILITY) ? "ok" : "invalid";
  } catch {
    return "invalid";
  }
}
