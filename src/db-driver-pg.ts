import { Pool, types as pgTypes, type PoolClient } from "pg";
import type { SqlDriver } from "./db-driver.js";

/**
 * PostgreSQL implementation of {@link SqlDriver}, plus a PGlite variant used by
 * the test lane.
 *
 * `src/db.ts` is the only module that authors SQL, and it writes SQLite — so
 * every statement passes through {@link translate}, a closed set of rewrites
 * covering exactly the SQLite-only constructs that survive in `src/db.ts`. Any
 * new SQL must stick to constructs `translate()` already covers, or add a rule
 * here plus a case in `src/db-driver-pg.test.ts`.
 *
 * Both factories build on one `makeDriver()` over a single `query` function, so
 * the dialect layer is written once and the PGlite lane exercises the exact SQL
 * the production Postgres lane runs.
 */

/** Executes one statement. `params === undefined` selects the multi-statement,
 *  simple-protocol path used for DDL. */
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;

// ── Dialect translation ──

/** Expands the DDL tokens and widens SQLite's 64-bit INTEGER to Postgres BIGINT.
 *  Postgres INTEGER is 32-bit; the schema stores epoch-millisecond timestamps
 *  and GitHub run IDs, both well past 2^31. */
function substituteDdlTokens(sql: string): string {
  return widenIntegers(sql)
    .replaceAll("{{PK_AUTOINC}}", "BIGSERIAL PRIMARY KEY")
    .replaceAll("{{NOW}}", "(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))");
}

function widenIntegers(type: string): string {
  return type.replace(/\bINTEGER\b/gi, "BIGINT");
}

/** Rewrites the `?` placeholders to `$1, $2, …`, skipping string literals and
 *  `--` comments so a `?` inside either is left alone. */
function numberPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") {
      // Copy the whole literal. A doubled '' closes and immediately reopens,
      // which lands on the same place as treating it as an escape.
      out += c;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'") break;
        i++;
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") out += sql[i++];
      if (i < sql.length) out += sql[i];
      continue;
    }
    out += c === "?" ? `$${++n}` : c;
  }
  return out;
}

const translationCache = new Map<string, string>();

/**
 * Rewrites one SQLite statement into its Postgres equivalent.
 *
 * The rules are ordered: the `CAST(json_extract(…))` form must match before the
 * bare `json_extract`, and `?` numbering must run last so the earlier rules
 * still see `?`.
 */
export function translate(sql: string): string {
  const cached = translationCache.get(sql);
  if (cached !== undefined) return cached;

  let out = sql;

  // 1. INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING
  if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out)) {
    out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT INTO");
    if (!/\bON\s+CONFLICT\b/i.test(out)) out = `${out.trimEnd()} ON CONFLICT DO NOTHING`;
  }

  // 2. json_extract — the numeric CAST form first, then the plain form.
  out = out.replace(
    /CAST\(\s*json_extract\(\s*([\w.]+)\s*,\s*'\$\.(\w+)'\s*\)\s+AS\s+INTEGER\s*\)/gi,
    "(($1::jsonb ->> '$2')::int)",
  );
  out = out.replace(/json_extract\(\s*([\w.]+)\s*,\s*'\$\.(\w+)'\s*\)/gi, "($1::jsonb ->> '$2')");

  // 3. strftime
  out = out.replace(/strftime\(\s*'%s'\s*,\s*([\w.]+)\s*\)/gi, "EXTRACT(EPOCH FROM $1::timestamp)");
  out = out.replace(
    /strftime\(\s*'%Y-%m-%d'\s*,\s*([\w.]+)\s*\)/gi,
    "to_char($1::timestamp, 'YYYY-MM-DD')",
  );

  // 4. julianday — SQLite's fractional day count.
  out = out.replace(
    /julianday\(\s*([\w.]+)\s*\)/gi,
    "(EXTRACT(EPOCH FROM $1::timestamp) / 86400.0)",
  );

  // 5. INSTR → strpos (SUBSTR and COALESCE are spelled the same in both).
  out = out.replace(/\bINSTR\(\s*([\w.]+)\s*,\s*('(?:[^']|'')*')\s*\)/gi, "strpos($1, $2)");

  // 6. "all rows past the first N"
  out = out.replace(/\bLIMIT\s+-1\s+OFFSET\b/gi, "LIMIT ALL OFFSET");

  // 7. datetime(x) as a normalising cast over a stored timestamp string. (The
  //    datetime('now', …) forms are gone — src/db.ts binds those as parameters.)
  out = out.replace(/\bdatetime\(\s*([\w.]+|\?)\s*\)/gi, "($1)::timestamp");

  // 8. Placeholders, last.
  out = numberPlaceholders(out);

  translationCache.set(sql, out);
  return out;
}

// ── Shared driver ──

function makeDriver(
  query: QueryFn,
  close: () => Promise<void>,
  transaction: SqlDriver["transaction"],
): SqlDriver {
  return {
    dialect: "postgres",
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await query(translate(sql), params)).rows as T[];
    },
    async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      return (await query(translate(sql), params)).rows[0] as T | undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      return { changes: (await query(translate(sql), params)).rowCount };
    },
    async insert(sql: string, params: unknown[] = []): Promise<{ id: number; changes: number }> {
      let text = translate(sql);
      if (!/\bRETURNING\b/i.test(text)) text = `${text.trimEnd()} RETURNING id`;
      const result = await query(text, params);
      // No row comes back from an ON CONFLICT DO NOTHING that skipped; callers
      // read `changes` to tell that apart from a real insert.
      return { id: Number(result.rows[0]?.id ?? 0), changes: result.rowCount };
    },
    async exec(sql: string): Promise<void> {
      await query(substituteDdlTokens(sql));
    },
    async addColumn(table: string, column: string, type: string): Promise<void> {
      await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${widenIntegers(type)}`);
    },
    transaction,
    close,
  };
}

async function nestedTransaction<T>(): Promise<T> {
  throw new Error("nested transaction");
}

// ── Production: node-postgres over a connection pool ──

let typeParsersInstalled = false;

/**
 * int8 and numeric arrive as strings by default, which would turn every
 * COUNT/SUM/AVG into a string and — via `SELECT *` on work_queue — hand
 * `markWorkSucceeded()` an id that matches nothing.
 */
function installTypeParsers(): void {
  if (typeParsersInstalled) return;
  typeParsersInstalled = true;
  pgTypes.setTypeParser(20, Number);   // int8
  pgTypes.setTypeParser(1700, Number); // numeric
}

/**
 * First-connect retry: 1s, 2s, 4s … 32s, about 63 s of cover. Written inline
 * rather than importing `retryWithBackoff` from ./retry.js on purpose — that
 * module imports log → db → config, which would make this a non-leaf module
 * and pull the whole config loader into every mcp-server child that runs
 * against Postgres. Keep this file's imports to `pg`, the dynamically-imported
 * PGlite, and node builtins.
 */
async function connectWithBackoff(pool: Pool, maxRetries = 6): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delay = 1000 * 2 ** attempt;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[db-driver-pg] postgres connect failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay / 1000}s: ${reason}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Pool/Client config for a URL plus a separately supplied password (#2974).
 *
 * `pg` builds its ConnectionParameters as
 * `Object.assign({}, config, parse(config.connectionString))`, and
 * pg-connection-string returns `password: ""` for a URL with no password
 * segment — so a `password` option passed alongside a `connectionString` is
 * always overwritten and then falls through to `null`, which the SASL
 * handshake rejects ("client password must be a string"). The password has to
 * go into the URL to survive. `CLAWS_DATABASE_PASSWORD` wins over any password
 * the URL already carries.
 */
export function buildPgConnectionConfig(
  url: string,
  password: string,
): { connectionString: string; password?: string } {
  if (!password) return { connectionString: url };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL — e.g. the bare unix-socket form `/var/run/postgresql claws`,
    // which pg-connection-string parses into `{ host, database }` with no
    // password key at all, so the explicit option does survive there.
    return { connectionString: url, password };
  }
  // encodeURIComponent, not the raw value: pg-connection-string reads the
  // userinfo back through decodeURIComponent. The URL setter does not re-encode
  // `%`, so this is a clean round trip for every byte.
  parsed.password = encodeURIComponent(password);
  return { connectionString: parsed.toString() };
}

export function createPgDriver(opts: { url: string; password: string; max?: number }): SqlDriver {
  installTypeParsers();
  const pool = new Pool({
    ...buildPgConnectionConfig(opts.url, opts.password),
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle pooled client dropped by the server must not take the process down,
  // but a pattern of drops should be visible in the logs. console, not log.js:
  // this module stays a leaf (see connectWithBackoff).
  pool.on("error", (err) => {
    console.warn(`[db-driver-pg] idle client error: ${err.message}`);
  });

  // k3s admits a new pod's IP to the NetworkPolicy about a second after the pod
  // starts, so the very first connection is expected to be refused. Retried
  // 1s→32s (~63s total) before the process gives up.
  let ready: Promise<void> | null = null;
  function ensureConnected(): Promise<void> {
    if (!ready) {
      ready = connectWithBackoff(pool).catch((err) => {
        ready = null;
        throw err;
      });
    }
    return ready;
  }

  const poolQuery: QueryFn = async (sql, params) => {
    await ensureConnected();
    const result = params === undefined ? await pool.query(sql) : await pool.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };

  function clientQuery(client: PoolClient): QueryFn {
    return async (sql, params) => {
      const result = params === undefined ? await client.query(sql) : await client.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    };
  }

  // No mutex, unlike the SQLite driver: each transaction takes its own client
  // out of the pool, so concurrent statements cannot land inside it.
  async function transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    await ensureConnected();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await fn(makeDriver(clientQuery(client), async () => {}, nestedTransaction));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // A failed rollback must not mask the error that caused it
        }
        throw err;
      }
    } finally {
      client.release();
    }
  }

  return makeDriver(poolQuery, async () => { await pool.end(); }, transaction);
}

// ── Tests: PGlite (real Postgres compiled to wasm, in-process) ──

/**
 * One instance per vitest worker: wasm startup costs about a second and
 * `src/db.test.ts` alone re-initialises the database ~180 times. Vitest isolates
 * modules per test file, so each file gets its own — which is what keeps the
 * files independent.
 */
let pgliteSingleton: Awaited<ReturnType<typeof importPgLite>>["instance"] | null = null;

async function importPgLite(): Promise<{ instance: import("@electric-sql/pglite").PGlite }> {
  // Dynamic: @electric-sql/pglite is a devDependency and `npm prune --omit=dev`
  // removes it from the image, so production must never reach this import.
  const { PGlite, types } = await import("@electric-sql/pglite");
  return {
    instance: await PGlite.create({ parsers: {
        // Mirror installTypeParsers(): int8 (every BIGSERIAL id and COUNT(*))
        // and numeric must come back as numbers, exactly as the pg driver
        // returns them, or the test lane proves nothing about dialect parity.
        20: (v: string) => Number(v),
        [types.NUMERIC]: (v: string) => Number(v),
      } }),
  };
}

/** Test-only driver. `close()` resets the schema rather than disposing the
 *  instance, so the next `initDb()` builds the tables again from clean. */
export async function createPgLiteDriver(): Promise<SqlDriver> {
  if (!pgliteSingleton) pgliteSingleton = (await importPgLite()).instance;
  const db = pgliteSingleton;

  const query: QueryFn = async (sql, params) => {
    if (params === undefined) {
      await db.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const result = await db.query<any>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  };

  async function transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    // PGlite is a single connection; its own transaction() holds the mutex that
    // also gates plain query() calls, so nothing can slip inside the BEGIN.
    const result = await db.transaction(async (tx) => {
      const txQuery: QueryFn = async (sql, params) => {
        if (params === undefined) {
          await tx.exec(sql);
          return { rows: [], rowCount: 0 };
        }
        const r = await tx.query<any>(sql, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
      };
      return await fn(makeDriver(txQuery, async () => {}, nestedTransaction));
    });
    return result as T;
  }

  return makeDriver(
    query,
    async () => { await db.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); },
    transaction,
  );
}
