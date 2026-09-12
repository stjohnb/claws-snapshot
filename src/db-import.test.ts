import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// ── pg stub ──────────────────────────────────────────────────────────────────

interface FakeQuery { text: string; params?: unknown[] }

/** Rows the fake returns for the `SELECT count(*)` assertion, per table. */
let pgCounts: Record<string, number> = {};
let pgTables: string[] = [];
let pgColumns: Record<string, Array<{ column_name: string; data_type: string; is_identity: string; column_default: string | null }>> = {};
let queries: FakeQuery[] = [];
let lastClientOptions: unknown;

class FakeClient {
  constructor(options: unknown) {
    lastClientOptions = options;
  }
  async connect(): Promise<void> {}
  async end(): Promise<void> {}
  async query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    queries.push({ text, params });
    if (text.includes("current_schema() AS schema")) return { rows: [{ schema: "public" }] };
    if (text.includes("information_schema.tables")) return { rows: pgTables.map(t => ({ table_name: t })) };
    if (text.includes("information_schema.columns")) {
      const table = String(params?.[0]);
      return { rows: pgColumns[table] ?? [] };
    }
    if (text.includes("count(*) AS n")) {
      const table = /FROM "([^"]+)"/.exec(text)?.[1] ?? "";
      return { rows: [{ n: String(pgCounts[table] ?? 0) }] };
    }
    if (text.includes("pg_get_serial_sequence")) {
      return { rows: [{ seq: `public.${params?.[0]}_${params?.[1]}_seq` }] };
    }
    if (text.startsWith("INSERT INTO")) {
      const table = /INSERT INTO "([^"]+)"/.exec(text)?.[1] ?? "";
      const tuples = (text.match(/\(\$/g) ?? []).length;
      pgCounts[table] = (pgCounts[table] ?? 0) + tuples;
      return { rows: [] };
    }
    if (text.startsWith("TRUNCATE")) {
      for (const t of pgTables) pgCounts[t] = 0;
      return { rows: [] };
    }
    return { rows: [] };
  }
}

vi.mock("pg", () => ({ Client: FakeClient }));

const { importSqliteIntoPostgres, toPgValue, batchSizeFor } = await import("./db-import.js");

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("toPgValue", () => {
  it("maps null and undefined to null", () => {
    expect(toPgValue(null, "text")).toBeNull();
    expect(toPgValue(undefined, "integer")).toBeNull();
  });

  it("maps 0/1 to booleans for boolean columns", () => {
    expect(toPgValue(0, "boolean")).toBe(false);
    expect(toPgValue(1, "boolean")).toBe(true);
  });

  it("leaves numbers alone for non-boolean columns", () => {
    expect(toPgValue(0, "integer")).toBe(0);
    expect(toPgValue(1, "integer")).toBe(1);
  });

  it("passes Buffers through for bytea columns", () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(toPgValue(buf, "bytea")).toBe(buf);
  });

  it("narrows safe bigints to numbers and stringifies the rest", () => {
    expect(toPgValue(42n, "bigint")).toBe(42);
    expect(toPgValue(12345678901234567890n, "bigint")).toBe("12345678901234567890");
  });

  it("passes SQLite text datetimes through unchanged", () => {
    expect(toPgValue("2026-09-10 01:00:00", "timestamp with time zone")).toBe("2026-09-10 01:00:00");
  });
});

describe("batchSizeFor", () => {
  it("stays under the 65535 bind-parameter cap", () => {
    for (const cols of [1, 3, 11, 60, 300, 1000]) {
      expect(batchSizeFor(cols) * cols).toBeLessThan(65535);
    }
  });

  it("caps at 1000 rows for narrow tables", () => {
    expect(batchSizeFor(1)).toBe(1000);
    expect(batchSizeFor(11)).toBe(1000);
  });

  it("never returns less than one row", () => {
    expect(batchSizeFor(100000)).toBe(1);
    expect(batchSizeFor(0)).toBe(1000);
  });
});

// ── importSqliteIntoPostgres ─────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

function makeSource(): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_name TEXT, ok INTEGER)`);
  const insert = db.prepare(`INSERT INTO job_runs (job_name, ok) VALUES (?, ?)`);
  insert.run("a", 1);
  insert.run("b", 0);
  db.close();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-dbimport-test-"));
  dbPath = path.join(tmpDir, "source.db");
  queries = [];
  pgCounts = {};
  pgTables = ["job_runs"];
  pgColumns = {
    job_runs: [
      { column_name: "id", data_type: "integer", is_identity: "YES", column_default: null },
      { column_name: "job_name", data_type: "text", column_default: null, is_identity: "NO" },
      { column_name: "ok", data_type: "boolean", column_default: null, is_identity: "NO" },
    ],
  };
  process.env["CLAWS_DATABASE_URL"] = "postgres://claws@example/claws";
  delete process.env["CLAWS_DATABASE_PASSWORD"];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["CLAWS_DATABASE_URL"];
  vi.restoreAllMocks();
});

describe("importSqliteIntoPostgres", () => {
  it("throws when CLAWS_DATABASE_URL is unset", async () => {
    delete process.env["CLAWS_DATABASE_URL"];
    makeSource();
    await expect(importSqliteIntoPostgres(dbPath)).rejects.toThrow("CLAWS_DATABASE_URL is not set");
  });

  it("merges CLAWS_DATABASE_PASSWORD into the connection string", async () => {
    process.env["CLAWS_DATABASE_PASSWORD"] = "hunter2";
    makeSource();
    await importSqliteIntoPostgres(dbPath);
    const opts = lastClientOptions as { connectionString: string; password?: string };
    expect(new URL(opts.connectionString).username).toBe("claws");
    expect(decodeURIComponent(new URL(opts.connectionString).password)).toBe("hunter2");
  });

  it("throws the initDb hint when the target schema is empty", async () => {
    pgTables = [];
    makeSource();
    await expect(importSqliteIntoPostgres(dbPath)).rejects.toThrow(/has initDb\(\) run against CLAWS_DATABASE_URL/);
  });

  it("emits BEGIN, SET LOCAL, one TRUNCATE, INSERTs, count checks, setval, COMMIT in order", async () => {
    makeSource();
    const result = await importSqliteIntoPostgres(dbPath);
    expect(result).toMatchObject({ tables: 1, rows: 2 });

    const texts = queries.map(q => q.text);
    const begin = texts.indexOf("BEGIN");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(texts[begin + 1]).toContain("SET LOCAL lock_timeout");
    expect(texts[begin + 2]).toContain("SET LOCAL statement_timeout");
    expect(texts[begin + 3]).toBe(`TRUNCATE TABLE "job_runs" CASCADE`);

    expect(texts.filter(t => t.startsWith("TRUNCATE"))).toHaveLength(1);

    const insert = texts.findIndex(t => t.startsWith("INSERT INTO"));
    const count = texts.findIndex(t => t.includes("count(*) AS n"));
    const setval = texts.findIndex(t => t.includes("setval"));
    const commit = texts.indexOf("COMMIT");
    expect(insert).toBeGreaterThan(begin);
    expect(count).toBeGreaterThan(insert);
    expect(setval).toBeGreaterThan(count);
    expect(commit).toBeGreaterThan(setval);
    expect(texts).not.toContain("ROLLBACK");
  });

  it("batches all rows of a table into one multi-row INSERT", async () => {
    makeSource();
    await importSqliteIntoPostgres(dbPath);
    const inserts = queries.filter(q => q.text.startsWith("INSERT INTO"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.text).toBe(`INSERT INTO "job_runs" ("id", "job_name", "ok") VALUES ($1, $2, $3), ($4, $5, $6)`);
    expect(inserts[0]!.params).toEqual([1, "a", true, 2, "b", false]);
  });

  it("rolls back and names the table on a row count mismatch", async () => {
    makeSource();
    // Make the post-copy count disagree with the source.
    const origQuery = FakeClient.prototype.query;
    vi.spyOn(FakeClient.prototype, "query").mockImplementation(async function (this: FakeClient, text: string, params?: unknown[]) {
      if (text.includes("count(*) AS n")) {
        queries.push({ text, params });
        return { rows: [{ n: "1" }] };
      }
      return origQuery.call(this, text, params);
    });

    await expect(importSqliteIntoPostgres(dbPath)).rejects.toThrow("Row count mismatch for job_runs: sqlite=2 postgres=1");
    expect(queries.map(q => q.text)).toContain("ROLLBACK");
    expect(queries.map(q => q.text)).not.toContain("COMMIT");
  });

  it("skips tables that exist on only one side without failing", async () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_name TEXT, ok INTEGER)`);
    db.exec(`CREATE TABLE only_in_sqlite (id INTEGER PRIMARY KEY)`);
    db.prepare(`INSERT INTO job_runs (job_name, ok) VALUES (?, ?)`).run("a", 1);
    db.close();
    pgTables = ["job_runs", "only_in_postgres"];

    const result = await importSqliteIntoPostgres(dbPath);
    expect(result.tables).toBe(1);
    expect(result.skipped.sort()).toEqual(["only_in_postgres", "only_in_sqlite"]);
    // sqlite_sequence exists in the source (AUTOINCREMENT) but is never copied.
    expect(queries.map(q => q.text).join("\n")).not.toContain("sqlite_sequence");
  });

  it("leaves a zero-shared-column table empty without failing the whole import", async () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_name TEXT, ok INTEGER)`);
    db.exec(`CREATE TABLE renamed_everything (old_a TEXT, old_b TEXT)`);
    db.prepare(`INSERT INTO job_runs (job_name, ok) VALUES (?, ?)`).run("a", 1);
    db.prepare(`INSERT INTO renamed_everything (old_a, old_b) VALUES (?, ?)`).run("x", "y");
    db.close();
    pgTables = ["job_runs", "renamed_everything"];
    pgColumns["renamed_everything"] = [
      { column_name: "new_a", data_type: "text", is_identity: "NO", column_default: null },
      { column_name: "new_b", data_type: "text", is_identity: "NO", column_default: null },
    ];

    const result = await importSqliteIntoPostgres(dbPath);
    expect(result.tables).toBe(2);
    expect(result.rows).toBe(1);
    expect(queries.map(q => q.text)).toContain("COMMIT");
    expect(queries.map(q => q.text)).not.toContain("ROLLBACK");
    expect(queries.map(q => q.text).join("\n")).not.toContain(`count(*) AS n FROM "renamed_everything"`);
  });

  it("drops columns the two sides do not share", async () => {
    makeSource();
    pgColumns["job_runs"] = [
      { column_name: "id", data_type: "integer", is_identity: "YES", column_default: null },
      { column_name: "job_name", data_type: "text", is_identity: "NO", column_default: null },
      { column_name: "added_by_a_newer_image", data_type: "text", is_identity: "NO", column_default: null },
    ];
    await importSqliteIntoPostgres(dbPath);
    const insert = queries.find(q => q.text.startsWith("INSERT INTO"))!;
    expect(insert.text).toContain(`("id", "job_name")`);
    expect(insert.text).not.toContain("added_by_a_newer_image");
  });
});
