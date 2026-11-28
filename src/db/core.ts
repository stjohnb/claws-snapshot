// Database core: the driver holder and the dialect-neutral helpers every
// src/db/* module shares. Imports no other src/db/* module, so it can sit at
// the bottom of any import cycle. Reached only through the src/db.ts façade.
import type { DbPoolStats, SqlDriver } from "../db-driver.js";
import { DB_PATH, DATABASE_URL } from "../config.js";
import * as logCore from "../log-core.js";
import { canonicalIssueRef, type IssueRef } from "../issue-id.js";

export let driver: SqlDriver | null = null;

/** Install the driver {@link initDb} opened; every query reads it through {@link getDb}. */
export function setDriver(next: SqlDriver | null): void {
  driver = next;
}

export function getDb(): SqlDriver {
  if (!driver) throw new Error("Database not initialized — call initDb() first");
  return driver;
}

/**
 * The Postgres connection pool's client counts, for `claws_db_pool_clients`;
 * null on SQLite/PGlite (no pool) or before {@link initDb}.
 */
export function dbPoolStats(): DbPoolStats | null {
  return driver?.poolStats?.() ?? null;
}

/**
 * An issue reference as the TEXT column stores it.
 *
 * Always a string, never the raw number: better-sqlite3 binds a JS number as a
 * double, and SQLite's TEXT affinity would then write `42` as `"42.0"` —
 * which no later `= ?` lookup would ever match.
 *
 * Canonicalised here too, so "canonical on write" is structural rather than a
 * promise every caller has to keep. On Postgres these columns are TEXT and `=`
 * is case-sensitive, and `idx_work_queue_active` is unique over
 * `(kind, repo, item_number)`: a ref that reached `enqueueWork` spelled
 * `clw_01jbq…` would not collide with the canonical row, it would quietly add
 * a second queue entry for the same issue that no `= ?` lookup ever finds. A
 * ref that is not a reference at all is passed through unchanged so the caller
 * still sees its own bad input in the error.
 */
export function refParam(ref: IssueRef): string {
  return String(canonicalIssueRef(ref) ?? ref);
}

/**
 * Timestamp in SQLite's `datetime('now')` format — UTC, `YYYY-MM-DD HH:MM:SS`.
 * Every write that used to call `datetime('now')` in SQL now binds this instead,
 * so the SQL stays dialect-neutral while stored values (and the string
 * comparisons and ORDER BYs over them) keep their exact current form.
 */
export function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** {@link nowSql} offset by `deltaMs` — the replacement for `datetime('now', '-N days')`. */
export function nowSqlOffsetMs(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString().slice(0, 19).replace("T", " ");
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Host and database name of a Postgres connection string — never the
 * credentials. Since fleet-infra#1300 the URL carries the password inline, so
 * this builds the label from parsed components only and degrades to a bare
 * "PostgreSQL" rather than ever echoing the string it was given.
 */
export function describePostgresTarget(url: string): string {
  try {
    const u = new URL(url);
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    const target = [host, database].filter(Boolean).join("/");
    return target ? `PostgreSQL (${target})` : "PostgreSQL";
  } catch {
    return "PostgreSQL";
  }
}

/** Human label for the active backend — safe to log and to render in /config's connectivity checks. */
export function describeDatabaseTarget(): string {
  if (DATABASE_URL) return describePostgresTarget(DATABASE_URL);
  if (process.env["CLAWS_TEST_PGLITE"] === "1") return "PGlite (test lane)";
  return `SQLite (${DB_PATH})`;
}

/**
 * Runs one DB operation that can be slow (a migration, backfill, prune or
 * scan) and logs its `duration_ms`, plus `rows` when it returns a count. Logs
 * through log-core so db.ts never recurses into its own `job_logs` sink. A
 * failure is logged with its duration and rethrown.
 */
export async function timedDb<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    logCore.info("[db] operation finished", {
      op,
      duration_ms: Math.round(performance.now() - started),
      rows: typeof result === "number" ? result : undefined,
    });
    return result;
  } catch (err) {
    logCore.warn("[db] operation failed", err, { op, duration_ms: Math.round(performance.now() - started) });
    throw err;
  }
}

/** A SQL `datetime('now')` string (`YYYY-MM-DD HH:MM:SS`, UTC) as ISO-8601; an ISO value passes through. */
export function sqlTimeToIso(value: string): string;
export function sqlTimeToIso(value: string | null): string | null;
export function sqlTimeToIso(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}
