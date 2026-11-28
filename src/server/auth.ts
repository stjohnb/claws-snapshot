/** Dashboard server auth: cookies, OIDC hosts, OAuth state and session signing, the auth middlewares and the session SSH-sign rate limit. */
import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { hashAgentMcpToken, safeCompare } from "../internal-mcp-token.js";
import { SERVER_PORT } from "../config.js";
import * as config from "../config.js";
import { isRunningAgentPodMcpToken } from "../db.js";
import * as log from "../log.js";
import { withIssueActor, type IssueActor } from "../issue-history-actor.js";
import { getSessionBackend } from "../session-backend.js";
import { type Ctx, type Env, jsonOk, textPlain } from "./http.js";

// ── Auth helpers ──

export function parseCookies(header: string | undefined | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

/** The lowercase hostname of a `Host`-style header value (port and any list tail dropped). */
export function requestHostname(header: string | undefined | null): string | null {
  const first = header?.split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  return first.replace(/:\d+$/, "");
}

/** Returns true when all four required OIDC fields are non-empty. */
export function isOidcEnabled(): boolean {
  return !!(
    config.OIDC_CLIENT_ID &&
    config.OIDC_CLIENT_SECRET &&
    config.OIDC_BASE_URL &&
    config.OIDC_APPLICATION_SLUG
  );
}

/** First value of X-Forwarded-Host, else Host, normalised to a bare lowercase hostname. */
function effectiveHost(c: Ctx): string {
  const fwd = c.req.header("x-forwarded-host");
  const raw = (fwd ? fwd.split(",")[0] : c.req.header("host")) ?? "";
  return raw.trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * Per-request OIDC origin. When the request's host is in the allow-listed
 * OIDC_HOST_MAP, authorize/token/userinfo go to that host's Authentik and
 * redirect_uri is derived from the same host — so an externally-reached
 * dashboard never bounces to an internal-only auth host (#2841).
 */
export function resolveOidcTarget(c: Ctx): { baseUrl: string; redirectUri: string } {
  const host = effectiveHost(c);
  const mapped = host ? config.OIDC_HOST_MAP[host] : undefined;
  if (mapped) return { baseUrl: mapped, redirectUri: `https://${host}/auth/callback` };
  const redirectUri = config.OIDC_REDIRECT_URI || `http://localhost:${SERVER_PORT}/auth/callback`;
  warnUnmappedOidcHost(host, redirectUri);
  return { baseUrl: config.OIDC_BASE_URL, redirectUri };
}

/** Hosts already warned about by warnUnmappedOidcHost; bounded so an attacker
 *  spraying Host headers can't grow it without limit. */
const warnedUnmappedOidcHosts = new Set<string>();
const MAX_WARNED_UNMAPPED_OIDC_HOSTS = 100;

/**
 * Logs once per host when a login arrives on a dashboard host that is neither
 * in `oidcHostMap` nor the host of the fixed `oidcRedirectUri`. The fallback
 * still works when that host can reach the default auth origin, but when it
 * can't (an `.ext.` host served over Tailscale bouncing to an internal-only
 * `auth.home`) the only symptom is a browser stuck on the auth host — this
 * makes the missing map entry visible in the journal instead (#2841).
 */
function warnUnmappedOidcHost(host: string, redirectUri: string): void {
  if (!host || warnedUnmappedOidcHosts.has(host)) return;
  let redirectHost = "";
  try {
    redirectHost = new URL(redirectUri).hostname.toLowerCase();
  } catch {
    // unparseable redirect URI — nothing sensible to compare against
  }
  if (host === redirectHost) return;
  if (warnedUnmappedOidcHosts.size >= MAX_WARNED_UNMAPPED_OIDC_HOSTS) return;
  warnedUnmappedOidcHosts.add(host);
  log.warn(
    `[oidc] Login reached the dashboard on host "${host}", which is not in oidcHostMap (CLAWS_OIDC_HOST_MAP) ` +
      `and does not match oidcRedirectUri (${redirectUri}). Falling back to ${config.OIDC_BASE_URL} with that ` +
      `redirect_uri; if the default auth host is unreachable from where "${host}" is served, add ` +
      `"${host}=<auth base URL>" to oidcHostMap and register https://${host}/auth/callback with the provider (#2841).`,
  );
}

/**
 * A login in flight lives in a signed cookie rather than process memory, so
 * the callback succeeds on whichever web replica it reaches, including one
 * started mid-login (#clw_01M5APX7YF3AGWHV1S1WMHJDR6). `SameSite=Lax`, not
 * Strict: the IdP's redirect back is a cross-site navigation. Each login gets
 * its own cookie, named for its state, so logins started together in several
 * tabs do not overwrite each other.
 */
export const OAUTH_STATE_COOKIE = "claws_oauth_state";

/** The cookie holding the login started with `state`. */
export function oauthStateCookieName(state: string): string {
  return `${OAUTH_STATE_COOKIE}_${state}`;
}
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStateEntry {
  returnTo: string;
  baseUrl: string;
  redirectUri: string;
}

function oauthStateMac(payload: string, secret: string): string {
  // Prefixed so a `claws_session` signature can never pass for this one.
  return crypto.createHmac("sha256", secret).update(`oauth-state|${payload}`).digest("base64url");
}

/** The `claws_oauth_state_<state>` cookie value binding `state` to where the login returns. */
export function signOAuthState(state: string, entry: OAuthStateEntry, expiresAt: number, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ s: state, r: entry.returnTo, b: entry.baseUrl, u: entry.redirectUri, e: expiresAt })).toString("base64url");
  return `${payload}.${oauthStateMac(payload, secret)}`;
}

/**
 * The login entry when `value` carries a valid signature, has not expired and
 * was issued for `state`; else null.
 */
export function verifyOAuthState(value: string | undefined, state: string, secret: string, now = Date.now()): OAuthStateEntry | null {
  if (!value || !secret) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  if (!safeCompare(value.slice(dot + 1), oauthStateMac(payload, secret))) return null;
  let parsed: { s?: unknown; r?: unknown; b?: unknown; u?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.s !== "string" || typeof parsed.r !== "string" || typeof parsed.b !== "string" || typeof parsed.u !== "string" || typeof parsed.e !== "number") return null;
  if (parsed.e < now || !safeCompare(parsed.s, state)) return null;
  return { returnTo: parsed.r, baseUrl: parsed.b, redirectUri: parsed.u };
}

export function oauthStateCookie(state: string, value: string, maxAgeSeconds: number): string {
  return `${oauthStateCookieName(state)}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/auth/callback; Max-Age=${maxAgeSeconds}`;
}

export function signSession(sub: string, expiresAt: number, secret: string): string {
  const payload = `${sub}|${expiresAt}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}|${hmac}`;
}

export function verifySession(
  value: string,
  secret: string,
): { sub: string; expiresAt: number } | null {
  const lastPipe = value.lastIndexOf("|");
  if (lastPipe < 0) return null;
  const hmac = value.slice(lastPipe + 1);
  const rest = value.slice(0, lastPipe);
  const secondLastPipe = rest.lastIndexOf("|");
  if (secondLastPipe < 0) return null;
  const expiryStr = rest.slice(secondLastPipe + 1);
  const sub = rest.slice(0, secondLastPipe);
  if (!sub || !expiryStr || !hmac) return null;
  const payload = `${sub}|${expiryStr}`;
  let expectedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(
      crypto.createHmac("sha256", secret).update(payload).digest("hex"),
    );
  } catch {
    return null;
  }
  const providedBuf = Buffer.from(hmac);
  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  )
    return null;
  const expiresAt = parseInt(expiryStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  return { sub, expiresAt };
}

/**
 * Who is acting, for a record that names the approver (a PR row's
 * `merge_approved_by`): the OIDC `sub` of the request's `claws_session`, or
 * `"dashboard"` when there is no valid session to read it from.
 */
export function sessionSubject(c: Context<Env>): string {
  const raw = parseCookies(c.req.header("cookie"))["claws_session"];
  if (!raw || !config.OIDC_CLIENT_SECRET) return "dashboard";
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  return verifySession(decoded, config.OIDC_CLIENT_SECRET)?.sub ?? "dashboard";
}

// ── Auth middlewares ──
// src/client/auth-watch.ts treats ANY same-origin 401 as a lapsed session and
// force-navigates to /login. Do not add another client-facing 401 source
// (app-level auth failures, bad tokens, etc.) without accounting for that —
// it will trigger an unwanted full-page redirect.

export const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (isOidcEnabled()) {
    const cookies = parseCookies(c.req.header("cookie"));
    const sessionCookie = cookies["claws_session"];
    if (sessionCookie) {
      let decoded: string;
      try { decoded = decodeURIComponent(sessionCookie); } catch { decoded = sessionCookie; }
      const session = verifySession(decoded, config.OIDC_CLIENT_SECRET);
      if (session) return withIssueActor({ kind: "operator", name: session.sub }, next);
    }
    const reqPath = c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?").slice(1).join("?") : "");
    const loginUrl = `/login?next=${encodeURIComponent(reqPath)}`;
    c.header("Content-Type", "text/html");
    return c.body(
      `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${loginUrl}"></head><body>Redirecting to login...</body></html>`,
      401,
    );
  }
  // OIDC not configured: fail closed. Nothing runs open.
  return textPlain(
    c,
    "Authentication is not configured. Set OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_BASE_URL, and OIDC_APPLICATION_SLUG in ~/.claws/env to enable login.",
    503,
  );
};

/** How an issue write over an agent's bearer token reads in the issue's History. */
const AGENT_MCP_ACTOR: IssueActor = { kind: "automation", name: "agent via MCP" };

export const apiAuthMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (safeCompare(token, config.INTERNAL_MCP_TOKEN)) return withIssueActor(AGENT_MCP_ACTOR, next);
    // An agent pod's own token, which outlives this boot's INTERNAL_MCP_TOKEN.
    // A DB failure here must not block the OIDC/401 fallbacks below.
    if (token && await isRunningAgentPodMcpToken(hashAgentMcpToken(token)).catch(() => false)) return withIssueActor(AGENT_MCP_ACTOR, next);
  }
  if (isOidcEnabled()) {
    const cookies = parseCookies(c.req.header("cookie"));
    const sessionCookie = cookies["claws_session"];
    if (sessionCookie) {
      let decoded: string;
      try { decoded = decodeURIComponent(sessionCookie); } catch { decoded = sessionCookie; }
      const session = verifySession(decoded, config.OIDC_CLIENT_SECRET);
      if (session) return withIssueActor({ kind: "operator", name: session.sub }, next);
    }
  }
  return jsonOk(c, { error: "unauthorized" }, 401);
};

/** The operator's dashboard session only: unlike `apiAuthMiddleware`, no agent
 *  bearer token gets in, so an agent cannot mint itself Grafana access. */
const operatorSessionMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (isOidcEnabled()) {
    const cookies = parseCookies(c.req.header("cookie"));
    const sessionCookie = cookies["claws_session"];
    if (sessionCookie) {
      let decoded: string;
      try { decoded = decodeURIComponent(sessionCookie); } catch { decoded = sessionCookie; }
      const session = verifySession(decoded, config.OIDC_CLIENT_SECRET);
      if (session) return withIssueActor({ kind: "operator", name: session.sub }, next);
    }
  }
  return jsonOk(c, { error: "unauthorized" }, 401);
};

/**
 * Auth for the session gate-write routes (`/api/sessions/:sid/issues/:id/*`
 * `/api/sessions/:sid/start-session` and `/api/sessions/:sid/prs/clear-manual-action`,
 * docs/product/interactive-sessions.md "Let a session pass a native issue's
 * gates..."). Deliberately never `apiAuthMiddleware`: that accepts
 * `INTERNAL_MCP_TOKEN` or any running agent pod's own token, both of which
 * every agent holds, and these routes approve a native issue's plan or merge —
 * an agent must not be able to grant itself that (#clw_01M3BWP83BQRXE06NWW1GKYT2S).
 * Only a bearer `getSessionBackend().verifyMcpToken` accepts for this exact
 * `:sid` gets in: the per-launch token each session pod
 * holds for its own `/mcp/sessions/:id` endpoint, revoked when it ends.
 */
export const sessionOwnTokenMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const sid = c.req.param("sid") ?? "";
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return jsonOk(c, { error: "unauthorized" }, 401);
  const verdict = await (getSessionBackend().verifyMcpToken?.(sid, token) ?? Promise.resolve("denied" as const));
  if (verdict === "unavailable") return jsonOk(c, { error: "session backend unavailable" }, 503);
  if (verdict !== "ok") return jsonOk(c, { error: "unauthorized" }, 401);
  return withIssueActor({ kind: "session", name: sid }, next);
};

/** Minimum gap between two successful signings of one session's key for one SSH host (#clw_01M78063FGCMSJVSGS7ZDV1Z9C). */
export const SESSION_SSH_SIGN_MIN_INTERVAL_MS = 60_000;
/** `sid:alias` → time of the last successful signing; pruned on every call. */
export const sessionSshSignedAt = new Map<string, number>();

/** Forget every session SSH signing time; tests only. */
export function resetSessionSshSignRateLimitForTests(): void {
  sessionSshSignedAt.clear();
}
