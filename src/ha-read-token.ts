/**
 * Per-session tokens for the read-only Home Assistant proxy
 * (#clw_01M77K5B15JHY1N6JMGRZDFQ0D).
 *
 * A session holding the `home-assistant-read` capability gets
 * `CLAWS_HA_READ_URL` and `CLAWS_HA_READ_TOKEN` in its environment. It sends
 * the token as a Bearer header to Claws' `/api/ha-read/*` route
 * (src/ha-read-proxy.ts), which forwards an allowlist of GET requests to Home
 * Assistant with the server-held token, so the session never holds that token.
 *
 * Same scheme as src/pages-read-token.ts: `<sessionId>.<base64url HMAC-SHA256>`
 * over `claws-ha-read:<sessionId>`, keyed by a secret derived from the Grafana
 * JWT signing key, so it is deterministic per session and nothing is stored.
 * It is valid only while the session row is open and still holds
 * `home-assistant-read`.
 */
import crypto from "node:crypto";
import { SESSION_POD_SETTINGS } from "./config.js";
import { getPersistedSession } from "./db.js";
import { derivedSecret } from "./grafana-jwt.js";
import { safeCompare } from "./internal-mcp-token.js";

export const HA_READ_CAPABILITY_ID = "home-assistant-read";
/** The proxy route prefix on the Claws web tier. */
export const HA_READ_ROUTE_PREFIX = "/api/ha-read";

const HA_READ_INFO = "claws-ha-read";
const VERIFY_CACHE_TTL_MS = 30_000;

function mac(sessionId: string): string {
  return crypto.createHmac("sha256", derivedSecret(HA_READ_INFO)).update(`${HA_READ_INFO}:${sessionId}`).digest("base64url");
}

/** The Home Assistant read token for `sessionId`. */
export function mintHaReadToken(sessionId: string): string {
  return `${sessionId}.${mac(sessionId)}`;
}

/** The session id a well-formed, correctly signed token names, else null. Does not check the session. */
export function parseHaReadToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const sessionId = token.slice(0, dot);
  return safeCompare(token.slice(dot + 1), mac(sessionId)) ? sessionId : null;
}

/** `CLAWS_HA_READ_URL` and `CLAWS_HA_READ_TOKEN` for a session holding `home-assistant-read`; `{}` when no session MCP URL is configured. */
export function haReadEnv(sessionId: string): Record<string, string> {
  const base = SESSION_POD_SETTINGS.mcpUrl.replace(/\/+$/, "");
  if (!base) return {};
  return {
    CLAWS_HA_READ_URL: `${base}${HA_READ_ROUTE_PREFIX}`,
    CLAWS_HA_READ_TOKEN: mintHaReadToken(sessionId),
  };
}

// Keyed by SHA-256 of the token so a burst of reads costs one database read.
const verifyCache = new Map<string, { result: "ok" | "invalid"; at: number }>();

/** Test hook: forget cached verdicts. */
export function clearHaReadTokenCache(): void {
  verifyCache.clear();
}

/** `"ok"` when `token` is signed for a session that is still open and holds `home-assistant-read`. */
export async function verifyHaReadToken(token: string, now: number = Date.now()): Promise<"ok" | "invalid"> {
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const hit = verifyCache.get(key);
  if (hit && now - hit.at < VERIFY_CACHE_TTL_MS) return hit.result;
  const result = await verifyUncached(token);
  if (verifyCache.size > 1000) verifyCache.clear();
  verifyCache.set(key, { result, at: now });
  return result;
}

async function verifyUncached(token: string): Promise<"ok" | "invalid"> {
  const sessionId = parseHaReadToken(token);
  if (!sessionId) return "invalid";
  const row = await getPersistedSession(sessionId);
  if (!row || row.ended_at != null) return "invalid";
  try {
    const caps: unknown = JSON.parse(row.capabilities ?? "[]");
    return Array.isArray(caps) && caps.includes(HA_READ_CAPABILITY_ID) ? "ok" : "invalid";
  } catch {
    return "invalid";
  }
}
