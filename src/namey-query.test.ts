import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";
import { handleNameyQuery } from "./namey-query.js";

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function mockPool(overrides?: {
  connectError?: Error;
  queryFn?: (q: string | { text: string; values: unknown[] }) => unknown;
  queryError?: Error;
}) {
  const client = {
    query: vi.fn(async (q: string | { text: string; values: unknown[] }) => {
      if (overrides?.queryError && typeof q === "object") {
        throw overrides.queryError;
      }
      if (overrides?.queryFn) return overrides.queryFn(q);
      return { rowCount: 0, rows: [] };
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => {
      if (overrides?.connectError) throw overrides.connectError;
      return client;
    }),
  } as unknown as pg.Pool;

  return { pool, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleNameyQuery", () => {
  it("rejects multi-statement queries", async () => {
    const { pool } = mockPool();
    const result = await handleNameyQuery("SELECT 1; DROP TABLE users", pool);
    const parsed = parseResult(result);
    expect(parsed.error).toBe("Multi-statement queries are not allowed");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("returns query results with rowCount and rows", async () => {
    const rows = [{ id: 1, name: "Alice" }];
    const { pool, client } = mockPool({
      queryFn: (q) => {
        if (typeof q === "object") return { rowCount: 1, rows };
        return { rowCount: 0, rows: [] };
      },
    });

    const result = await handleNameyQuery("SELECT * FROM users", pool);
    const parsed = parseResult(result);
    expect(parsed.rowCount).toBe(1);
    expect(parsed.rows).toEqual(rows);

    // Verify transaction wrapping and timeout restoration
    expect(client.query).toHaveBeenCalledWith("BEGIN TRANSACTION READ ONLY");
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({ text: "SELECT * FROM users LIMIT 500", values: [] }));
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.query).toHaveBeenCalledWith("SET statement_timeout = 30000");
    expect(client.release).toHaveBeenCalled();
  });

  it("enforces LIMIT 500 on queries without LIMIT", async () => {
    const { pool, client } = mockPool();
    await handleNameyQuery("SELECT * FROM names", pool);
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({ text: "SELECT * FROM names LIMIT 500", values: [] }));
  });

  it("preserves existing LIMIT clause", async () => {
    const { pool, client } = mockPool();
    await handleNameyQuery("SELECT * FROM names LIMIT 10", pool);
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({ text: "SELECT * FROM names LIMIT 10", values: [] }));
  });

  it("returns error on connection failure", async () => {
    const { pool } = mockPool({ connectError: new Error("ECONNREFUSED") });
    const result = await handleNameyQuery("SELECT 1", pool);
    const parsed = parseResult(result);
    expect(parsed.error).toBe("Connection failed: ECONNREFUSED");
  });

  it("returns error and rolls back on query failure", async () => {
    const { pool, client } = mockPool({ queryError: new Error("relation does not exist") });
    const result = await handleNameyQuery("SELECT * FROM nonexistent", pool);
    const parsed = parseResult(result);
    expect(parsed.error).toBe("Query failed: relation does not exist");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    // Verify statement_timeout is restored in finally block (security invariant:
    // prevents a poisoned connection from re-entering the pool with timeout disabled)
    expect(client.query).toHaveBeenCalledWith("SET statement_timeout = 30000");
    expect(client.release).toHaveBeenCalled();
  });

  it("releases client even when ROLLBACK fails", async () => {
    const client = {
      query: vi.fn(async (q: string | { text: string; values: unknown[] }) => {
        if (typeof q === "object") throw new Error("query error");
        if (q === "ROLLBACK") throw new Error("rollback error");
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;

    const result = await handleNameyQuery("SELECT 1", pool);
    const parsed = parseResult(result);
    expect(parsed.error).toContain("Query failed");
    expect(client.release).toHaveBeenCalled();
  });

  it("uses read-only transaction", async () => {
    const { pool, client } = mockPool();
    await handleNameyQuery("SELECT 1", pool);
    expect(client.query).toHaveBeenCalledWith("BEGIN TRANSACTION READ ONLY");
  });

  it("returns timeout error and destroys client when query hangs", async () => {
    vi.useFakeTimers();
    // Simulate real pg behavior: query promise rejects when release(true) destroys the socket.
    // Without the queryPromise.catch(() => {}) fix, this would be an unhandled rejection.
    let rejectQuery: (err: Error) => void;
    const client = {
      query: vi.fn(async (q: string | { text: string; values: unknown[] }) => {
        if (typeof q === "object") {
          return new Promise((_resolve, reject) => {
            rejectQuery = reject;
          });
        }
        if (q === "BEGIN TRANSACTION READ ONLY") {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(() => {
        // When release(true) destroys the socket, pg rejects the pending query
        rejectQuery(new Error("Connection terminated"));
      }),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;

    const resultPromise = handleNameyQuery("SELECT pg_sleep(3600)", pool);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;
    const parsed = parseResult(result);

    expect(parsed.error).toBe("Query failed: client-side timeout");
    // On timeout, client should be destroyed (release(true)), not just released
    expect(client.release).toHaveBeenCalledWith(true);
    // ROLLBACK should NOT be called — it would queue behind the still-running query
    expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");

    vi.useRealTimers();
  });
});
