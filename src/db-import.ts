import Database from "better-sqlite3";
import { Client } from "pg";
import { buildPgConnectionConfig } from "./db-driver-pg.js";

/**
 * Load a SQLite snapshot of the claws database into the Postgres database that
 * `CLAWS_DATABASE_URL` points at, replacing whatever is there.
 *
 * This runs as its own short-lived process (`src/tools/import-sqlite-db.ts`)
 * inside the `claws-staging` pod, so it deliberately does not go through
 * `src/db.ts`: it opens one connection of its own and copies into whatever
 * tables already exist. It never issues DDL and carries no copy of the schema —
 * `initDb()` owns that. Tables or columns present on one side only are skipped
 * with a warning, which is what keeps a sync working while the pod runs an
 * older image than openclaw.
 */

export interface ImportResult {
  tables: number;
  rows: number;
  skipped: string[];
}

interface PgColumn {
  name: string;
  dataType: string;
  isSerial: boolean;
}

/** Postgres caps a single statement at 65535 bind parameters. */
export function batchSizeFor(columnCount: number): number {
  return Math.max(1, Math.min(1000, Math.floor(60000 / Math.max(1, columnCount))));
}

/**
 * Convert a value read from better-sqlite3 into something node-postgres can
 * bind. TEXT datetimes (`'YYYY-MM-DD HH:MM:SS'`, what SQLite's `datetime('now')`
 * produces) are passed through as strings and cast implicitly by Postgres,
 * which works whether the column is typed `text` or `timestamptz`.
 */
export function toPgValue(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "boolean" && typeof value === "number") return value !== 0;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return value;
}

// A connectionString plus a sibling password option silently loses the
// password — pg overwrites it with the empty password parsed out of the URL
// (#2974) — so the derivation lives in db-driver-pg.ts and is shared here.
// Importing it is safe: db-driver-pg.ts is a leaf module whose only runtime
// import is `pg`.
function resolvePgConnection(): Client {
  const connectionString = process.env["CLAWS_DATABASE_URL"];
  if (!connectionString) throw new Error("CLAWS_DATABASE_URL is not set");
  const password = process.env["CLAWS_DATABASE_PASSWORD"] ?? "";
  return new Client(buildPgConnectionConfig(connectionString, password));
}

const quote = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

export async function importSqliteIntoPostgres(sqlitePath: string): Promise<ImportResult> {
  const client = resolvePgConnection();
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });

  try {
    await client.connect();

    const sourceTables = (sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>).map(r => r.name);

    const schemaRow = await client.query<{ schema: string }>(`SELECT current_schema() AS schema`);
    const currentSchema = schemaRow.rows[0]?.schema ?? "public";

    const targetRows = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    );
    if (targetRows.rows.length === 0) {
      throw new Error(
        `Target database has no tables in schema ${currentSchema} — has initDb() run against CLAWS_DATABASE_URL?`,
      );
    }
    const targetTables = new Set(targetRows.rows.map(r => r.table_name.toLowerCase()));

    const skipped: string[] = [];
    const tables: string[] = [];
    for (const name of sourceTables) {
      if (targetTables.has(name.toLowerCase())) tables.push(name);
      else skipped.push(name);
    }
    for (const name of targetTables) {
      if (!sourceTables.some(t => t.toLowerCase() === name)) skipped.push(name);
    }
    for (const name of skipped) {
      console.warn(`[db-import] Skipping table ${name} — present on only one side`);
    }
    if (tables.length === 0) {
      throw new Error(
        `No tables in common between ${sqlitePath} and schema ${currentSchema} — has initDb() run against CLAWS_DATABASE_URL?`,
      );
    }

    // Per-table column intersection. Every identifier in this schema is already
    // lowercase; compare lowercased so a case difference never silently drops a
    // column.
    const columnsByTable = new Map<string, PgColumn[]>();
    for (const table of tables) {
      const pgCols = await client.query<{
        column_name: string;
        data_type: string;
        is_identity: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_identity, column_default
         FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1`,
        [table.toLowerCase()],
      );
      const sqliteCols = new Set(
        (sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map(c =>
          c.name.toLowerCase(),
        ),
      );

      const shared: PgColumn[] = [];
      for (const col of pgCols.rows) {
        const lower = col.column_name.toLowerCase();
        if (!sqliteCols.has(lower)) {
          console.warn(`[db-import] Dropping column ${table}.${col.column_name} — absent from the SQLite source`);
          continue;
        }
        shared.push({
          name: col.column_name,
          dataType: col.data_type,
          isSerial: col.is_identity === "YES" || (col.column_default ?? "").startsWith("nextval("),
        });
        sqliteCols.delete(lower);
      }
      for (const extra of sqliteCols) {
        console.warn(`[db-import] Dropping column ${table}.${extra} — absent from the Postgres target`);
      }
      columnsByTable.set(table, shared);
    }

    // Source row counts, captured before the transaction so the post-copy
    // assertion has something to compare against.
    const sourceCounts = new Map<string, number>();
    for (const table of tables) {
      const row = sqlite.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get() as { n: number };
      sourceCounts.set(table, Number(row.n));
    }

    let rows = 0;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '60s'");
      await client.query("SET LOCAL statement_timeout = 0");

      // TRUNCATE is transactional in Postgres, so any failure below rolls back
      // and leaves staging's previous data untouched.
      await client.query(`TRUNCATE TABLE ${tables.map(quote).join(", ")} CASCADE`);

      for (const table of tables) {
        const cols = columnsByTable.get(table)!;
        if (cols.length === 0) {
          console.warn(`[db-import] ${table} has no columns in common — leaving it empty`);
          continue;
        }
        rows += await copyTable(client, sqlite, table, cols);
      }

      for (const table of tables) {
        // A table with no shared columns was deliberately left empty above —
        // it never had rows to compare against.
        if (columnsByTable.get(table)!.length === 0) continue;
        const res = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${quote(table)}`);
        const actual = Number(res.rows[0]?.n ?? 0);
        const expected = sourceCounts.get(table)!;
        if (actual !== expected) {
          throw new Error(`Row count mismatch for ${table}: sqlite=${expected} postgres=${actual}`);
        }
      }

      await repairSequences(client, tables, columnsByTable);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }

    return { tables: tables.length, rows, skipped };
  } finally {
    await client.end().catch(() => {});
    sqlite.close();
  }
}

async function copyTable(
  client: Client,
  sqlite: Database.Database,
  table: string,
  cols: PgColumn[],
): Promise<number> {
  const batchSize = batchSizeFor(cols.length);
  const columnList = cols.map(c => quote(c.name)).join(", ");
  const target = quote(table);

  let batch: unknown[][] = [];
  let copied = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const values of batch) {
      const placeholders = values.map((_, i) => `$${params.length + i + 1}`);
      params.push(...values);
      tuples.push(`(${placeholders.join(", ")})`);
    }
    await client.query(`INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(", ")}`, params);
    copied += batch.length;
    batch = [];
  };

  // iterate(), never all() — job_logs is hundreds of megabytes and must not be
  // materialised in memory.
  const stmt = sqlite.prepare(`SELECT ${columnList} FROM ${target}`);
  for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
    batch.push(cols.map(c => toPgValue(row[c.name], c.dataType)));
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return copied;
}

/**
 * Point every identity/serial sequence at `max(id) + 1`. Without this the first
 * insert after a sync fails with a duplicate key — the failure fleet-infra hit
 * in `migrations/0030-forgejo-db.sh` when it restored Forgejo.
 */
async function repairSequences(
  client: Client,
  tables: string[],
  columnsByTable: Map<string, PgColumn[]>,
): Promise<void> {
  for (const table of tables) {
    for (const col of columnsByTable.get(table) ?? []) {
      if (!col.isSerial) continue;
      const seqRes = await client.query<{ seq: string | null }>(`SELECT pg_get_serial_sequence($1, $2) AS seq`, [
        table,
        col.name,
      ]);
      const seq = seqRes.rows[0]?.seq;
      if (!seq) continue;
      // `false` means "hand this value out next", so the first insert gets max+1.
      await client.query(
        `SELECT setval($1, COALESCE((SELECT max(${quote(col.name)}) FROM ${quote(table)}), 0) + 1, false)`,
        [seq],
      );
    }
  }
}
