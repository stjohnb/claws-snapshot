/**
 * Read-only Home Assistant proxy for sessions holding `home-assistant-read`
 * (#clw_01M77K5B15JHY1N6JMGRZDFQ0D).
 *
 * The `/api/ha-read/*` route (src/server.ts) authenticates the session's
 * per-session token (src/ha-read-token.ts), refuses every method but GET, and
 * calls `proxyHaRead` with the Home Assistant path after the prefix. Only the
 * exact GET endpoints in the allowlist below are forwarded, with the
 * server-held Home Assistant token and no client headers, so a session can
 * read state but never call a service, fire an event or write anything.
 * Template rendering (a POST) and the websocket API are deliberately excluded.
 */
import { HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN } from "./config.js";
import { ENTITY_ID_RE } from "./home-assistant.js";

const UPSTREAM_TIMEOUT_MS = 15_000;

/** An ISO-8601 date or date-time, as HA's history and logbook paths take. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const EXACT_PATHS: ReadonlySet<string> = new Set([
  "/api/",
  "/api/config",
  "/api/components",
  "/api/services",
  "/api/events",
  "/api/error_log",
  "/api/states",
  "/api/history/period",
  "/api/logbook",
  "/api/calendars",
  "/api/config/config_entries/entry",
]);

/** Paths with one trailing parameter segment, and the pattern it must match. */
const PARAM_PATHS: ReadonlyArray<readonly [prefix: string, re: RegExp]> = [
  ["/api/states/", ENTITY_ID_RE],
  ["/api/history/period/", TIMESTAMP_RE],
  ["/api/logbook/", TIMESTAMP_RE],
  ["/api/calendars/", ENTITY_ID_RE],
];

/**
 * The decoded Home Assistant path when `rawPath` (still percent-encoded) is
 * on the read allowlist, else null. Refuses `..`, `//`, a backslash and an
 * encoded slash or backslash before matching.
 */
function allowedDecodedPath(rawPath: string): string | null {
  if (!rawPath.startsWith("/")) return null;
  if (/%2f|%5c/i.test(rawPath)) return null;
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (path.includes("..") || path.includes("//") || path.includes("\\")) return null;
  if (EXACT_PATHS.has(path)) return path;
  for (const [prefix, re] of PARAM_PATHS) {
    if (path.startsWith(prefix) && re.test(path.slice(prefix.length))) return path;
  }
  return null;
}

/** True when `path` (the Home Assistant path, percent-encoded as received) may be read through the proxy. */
export function isAllowedHaReadPath(path: string): boolean {
  return allowedDecodedPath(path) !== null;
}

export type HaReadResult =
  | { kind: "ok"; status: number; contentType: string | null; body: ArrayBuffer }
  | { kind: "forbidden" }
  | { kind: "unconfigured" }
  | { kind: "upstream-error"; error: string };

/**
 * Forward one allowlisted GET to Home Assistant. `path` is the HA path
 * (percent-encoded as received), `query` the raw query string without its `?`.
 * Sends only the server-held Authorization header; never throws.
 */
export async function proxyHaRead(path: string, query: string, fetchImpl: typeof fetch = fetch): Promise<HaReadResult> {
  const decoded = allowedDecodedPath(path);
  if (decoded === null) return { kind: "forbidden" };
  const base = HOME_ASSISTANT_BASE_URL.replace(/\/+$/, "");
  if (!base || !HOME_ASSISTANT_TOKEN) return { kind: "unconfigured" };
  const url = `${base}${encodeURI(decoded)}${query ? `?${query}` : ""}`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}` },
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return { kind: "ok", status: res.status, contentType: res.headers.get("content-type"), body: await res.arrayBuffer() };
  } catch (err) {
    return { kind: "upstream-error", error: err instanceof Error ? err.name : "Error" };
  }
}
