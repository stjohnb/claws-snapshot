/**
 * Read-only Datasette proxy for sessions holding `datasette:<db>` capabilities
 * (#clw_01M89P9YVSQY0S29YP6KBPJAQQ).
 *
 * The `/api/datasette/*` route (src/server.ts) authenticates the session's
 * per-session token (src/datasette-token.ts), refuses every method but GET,
 * and calls `proxyDatasetteRead` with the Datasette path after the prefix and
 * the databases the session holds. Only JSON reads of one granted, configured
 * database are forwarded (`/<db>.json`, `/<db>/<table>.json`,
 * `/<db>/<table>/<pk>.json`), to the in-cluster Datasette with no client
 * headers and no credential. Datasette's own instance paths (`/-/...`) and
 * the `_memory` database are never on any allowlist. The served redacted
 * files are the data boundary; this proxy only scopes which of them a
 * session may read.
 */
import { DATASETTE_BASE_URL, DATASETTE_DATABASES } from "./config.js";

const UPSTREAM_TIMEOUT_MS = 15_000;

export type DatasettePathCheck =
  | { ok: true; db: string; segments: string[] }
  | { ok: false; reason: "path" | "database"; db?: string };

/**
 * Check `rawPath` (the Datasette path, still percent-encoded) for a session
 * holding `grantedDbs`. Refuses `..`, `//`, a backslash and an encoded slash
 * or backslash before matching; then allows one to three segments whose last
 * ends `.json`, and whose first names a database both configured and granted.
 */
export function checkDatasettePath(rawPath: string, grantedDbs: ReadonlySet<string>): DatasettePathCheck {
  if (!rawPath.startsWith("/")) return { ok: false, reason: "path" };
  if (/%2f|%5c/i.test(rawPath)) return { ok: false, reason: "path" };
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, reason: "path" };
  }
  if (path.includes("..") || path.includes("//") || path.includes("\\")) return { ok: false, reason: "path" };
  const segments = path.slice(1).split("/");
  if (segments.length < 1 || segments.length > 3 || segments.some((s) => s === "")) return { ok: false, reason: "path" };
  const last = segments[segments.length - 1]!;
  if (!last.endsWith(".json") || last === ".json") return { ok: false, reason: "path" };
  const db = segments.length === 1 ? last.slice(0, -".json".length) : segments[0]!;
  if (!DATASETTE_DATABASES.includes(db) || !grantedDbs.has(db)) return { ok: false, reason: "database", db };
  return { ok: true, db, segments };
}

export type DatasetteReadResult =
  | { kind: "ok"; status: number; contentType: string | null; body: ArrayBuffer }
  | { kind: "forbidden" }
  | { kind: "unconfigured" }
  | { kind: "upstream-error"; error: string };

/**
 * Forward one allowed GET to Datasette. `path` is the Datasette path
 * (percent-encoded as received), `query` the raw query string without its `?`,
 * `grantedDbs` the databases the session holds. Sends no headers; never throws.
 */
export async function proxyDatasetteRead(
  path: string,
  query: string,
  grantedDbs: ReadonlySet<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetteReadResult> {
  const check = checkDatasettePath(path, grantedDbs);
  if (!check.ok) return { kind: "forbidden" };
  const base = DATASETTE_BASE_URL.replace(/\/+$/, "");
  if (!base) return { kind: "unconfigured" };
  // Re-encode each decoded segment so a `?` or `#` in a primary key stays in the path.
  const url = `${base}/${check.segments.map(encodeURIComponent).join("/")}${query ? `?${query}` : ""}`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return { kind: "ok", status: res.status, contentType: res.headers.get("content-type"), body: await res.arrayBuffer() };
  } catch (err) {
    return { kind: "upstream-error", error: err instanceof Error ? err.name : "Error" };
  }
}
