import Database from "better-sqlite3";

/**
 * Minimal async SQL surface shared by every backend Claws can run on.
 *
 * `src/db.ts` is the only module that authors SQL against it, so the surface is
 * deliberately tiny: five statement forms, DDL, an idempotent ADD COLUMN and a
 * transaction. Keep this module a leaf — it must not import `config.js` (or
 * anything that does), so standalone processes (the MCP server) can open their
 * own connection without pulling in the service's configuration.
 *
 * DDL passed to {@link SqlDriver.exec} may use two dialect tokens, which each
 * driver substitutes for its own spelling:
 *   - `{{PK_AUTOINC}}` — auto-incrementing integer primary key
 *   - `{{NOW}}` — a DEFAULT clause producing `YYYY-MM-DD HH:MM:SS` in UTC
 */
export interface SqlDriver {
  readonly dialect: "sqlite" | "postgres";
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** INSERT returning the new row's integer primary key. */
  insert(sql: string, params?: unknown[]): Promise<{ id: number; changes: number }>;
  /** DDL, no parameters. Substitutes the `{{PK_AUTOINC}}` / `{{NOW}}` tokens. */
  exec(sql: string): Promise<void>;
  /** Adds a column if it is missing; a duplicate-column error is swallowed. */
  addColumn(table: string, column: string, type: string): Promise<void>;
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Expands the dialect tokens in DDL to their SQLite spellings. */
function substituteDdlTokens(sql: string): string {
  return sql
    .replaceAll("{{PK_AUTOINC}}", "INTEGER PRIMARY KEY AUTOINCREMENT")
    .replaceAll("{{NOW}}", "(datetime('now'))");
}

/**
 * Opens a better-sqlite3-backed driver.
 *
 * better-sqlite3 is synchronous and single-connection, so every public method
 * takes a driver-wide async mutex before touching the connection. Without it a
 * caller awaiting inside {@link SqlDriver.transaction} would let unrelated
 * statements land inside the open transaction — and a rollback would silently
 * discard them — while a second `transaction()` would fail outright with
 * "cannot start a transaction within a transaction".
 */
export function createSqliteDriver(path: string, opts: { readonly?: boolean } = {}): SqlDriver {
  const conn = opts.readonly ? new Database(path, { readonly: true }) : new Database(path);
  if (!opts.readonly) {
    conn.pragma("journal_mode = WAL");
    conn.pragma("synchronous = NORMAL");
  }

  // Prepared statements are cached by SQL text so the hot paths (work-queue
  // polling, log writes) pay the prepare cost once per process.
  const statements = new Map<string, Database.Statement>();
  function prepare(sql: string): Database.Statement {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = conn.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  }

  let lock: Promise<void> = Promise.resolve();
  /** Chains onto the mutex; resolves with the release function once acquired. */
  function acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = lock;
    lock = prior.then(() => held);
    return prior.then(() => release);
  }

  /** The statement implementations, without the mutex. */
  const raw: SqlDriver = {
    dialect: "sqlite",
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return prepare(sql).all(...(params as never[])) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      return prepare(sql).get(...(params as never[])) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      const result = prepare(sql).run(...(params as never[]));
      return { changes: result.changes };
    },
    async insert(sql: string, params: unknown[] = []): Promise<{ id: number; changes: number }> {
      const result = prepare(sql).run(...(params as never[]));
      return { id: Number(result.lastInsertRowid), changes: result.changes };
    },
    async exec(sql: string): Promise<void> {
      conn.exec(substituteDdlTokens(sql));
    },
    async addColumn(table: string, column: string, type: string): Promise<void> {
      try {
        conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch {
        // Column already exists — safe to ignore
      }
    },
    async transaction<T>(): Promise<T> {
      throw new Error("nested transaction");
    },
    async close(): Promise<void> {
      /* the transaction owns the connection's lifetime */
    },
  };

  const driver: SqlDriver = {
    dialect: "sqlite",
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const release = await acquire();
      try {
        return await raw.all<T>(sql, params);
      } finally {
        release();
      }
    },
    async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      const release = await acquire();
      try {
        return await raw.get<T>(sql, params);
      } finally {
        release();
      }
    },
    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      const release = await acquire();
      try {
        return await raw.run(sql, params);
      } finally {
        release();
      }
    },
    async insert(sql: string, params: unknown[] = []): Promise<{ id: number; changes: number }> {
      const release = await acquire();
      try {
        return await raw.insert(sql, params);
      } finally {
        release();
      }
    },
    async exec(sql: string): Promise<void> {
      const release = await acquire();
      try {
        await raw.exec(sql);
      } finally {
        release();
      }
    },
    async addColumn(table: string, column: string, type: string): Promise<void> {
      const release = await acquire();
      try {
        await raw.addColumn(table, column, type);
      } finally {
        release();
      }
    },
    async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
      const release = await acquire();
      try {
        conn.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(raw);
          conn.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            conn.exec("ROLLBACK");
          } catch {
            // A failed rollback must not mask the error that caused it
          }
          throw err;
        }
      } finally {
        release();
      }
    },
    async close(): Promise<void> {
      const release = await acquire();
      try {
        statements.clear();
        conn.close();
      } finally {
        release();
      }
    },
  };

  return driver;
}
