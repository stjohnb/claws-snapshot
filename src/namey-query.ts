/** Handler logic for the namey_query MCP tool, extracted for testability. */

import type pg from "pg";
import { isMultiStatement, ensureLimit } from "./sql-validation.js";
import { type ToolResult, textResult, errorResult } from "./mcp-result.js";

/** Shared timeout for statement_timeout (pool config) and client-side abort. */
export const QUERY_TIMEOUT_MS = 30_000;

export async function handleNameyQuery(sql: string, pool: pg.Pool): Promise<ToolResult> {
  // Reject multi-statement queries (semicolons outside single-quoted string literals).
  // Note: this doesn't handle PostgreSQL dollar-quoting ($$...$$), so a dollar-quoted
  // string containing a semicolon could false-positive. Not a security issue — the
  // extended query protocol (values: []) is the real single-statement guard.
  if (isMultiStatement(sql)) {
    return errorResult("Multi-statement queries are not allowed");
  }

  const query = ensureLimit(sql);

  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    return errorResult(`Connection failed: ${err instanceof Error ? err.message : err}`);
  }
  // Client-side abort timeout — guards against set_config('statement_timeout', '0', true)
  // bypassing the pool-level statement_timeout within a single query.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let queryPromise: Promise<pg.QueryResult> | undefined;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    // Extended query protocol (values: []) restricts to a single statement at the protocol level
    queryPromise = client.query({ text: query, values: [] });
    const result = await Promise.race([
      queryPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("client-side timeout"));
        }, QUERY_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    await client.query("COMMIT");
    return textResult({ rowCount: result.rowCount, rows: result.rows });
  } catch (err) {
    clearTimeout(timer);
    if (!timedOut) {
      await client.query("ROLLBACK").catch(() => {});
    }
    return errorResult(`Query failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    if (timedOut) {
      // Timeout: the underlying query is still running on this connection.
      // ROLLBACK/SET would queue behind it. Destroy the connection instead.
      // Swallow the orphaned query promise rejection — pg will reject it when
      // the socket is destroyed, and we don't want an unhandled rejection crash.
      queryPromise?.catch(() => {});
      client.release(true);
    } else {
      // Restore statement_timeout in case the query used set_config() to change it.
      // Runs on both success and error paths so the pooled connection is always safe.
      await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`).catch(() => {});
      client.release();
    }
  }
}
