import fs from "node:fs";
import path from "node:path";
import { createSqliteDriver, type SqlDriver } from "./db-driver.js";
import { createPgDriver } from "./db-driver-pg.js";
import * as logCore from "./log-core.js";
import { CONFIG_PATH, DATABASE_URL, DATABASE_PASSWORD, DB_PATH } from "./runtime-paths.js";

/**
 * Operator configuration, stored in the database.
 *
 * The single `config_store` row is the source of truth; `~/.claws/config.json`
 * is a per-process materialised copy, written at boot ({@link materialiseConfig})
 * and on every change, so `config.ts` keeps loading it synchronously. Every
 * process that changes config publishes the whole JSON with {@link publishConfig},
 * which bumps `version`; `config-watch.ts` notices versions other processes
 * published and rewrites the local copy.
 *
 * Upstream of `config.ts` and `db.ts`: this module imports only the driver
 * modules, `log-core` and `runtime-paths`, so `boot.ts` can run it before the
 * config file is first read.
 */

/** DDL for the store, run by {@link materialiseConfig} and by `initDb()`. */
export const CONFIG_STORE_DDL = `
  CREATE TABLE IF NOT EXISTS config_store (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

export interface StoredConfig {
  json: string;
  version: number;
}

/** The service's own connection, registered by `initDb()` and cleared by `closeDb()`. */
let registered: SqlDriver | null = null;
/** The newest version this process has written to `CONFIG_PATH` or published. */
let knownVersion = 0;

export function setConfigStoreDriver(driver: SqlDriver | null): void {
  registered = driver;
}

/** The newest stored version this process has already materialised or published. */
export function knownConfigVersion(): number {
  return knownVersion;
}

export function setKnownConfigVersion(version: number): void {
  knownVersion = version;
}

function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such table|does not exist/i.test(message);
}

/**
 * Writes `json` to `CONFIG_PATH` with mode 0600, through a temporary file and a
 * rename so a concurrent synchronous reader never sees a half-written file.
 */
export function writeConfigFile(json: string): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // never created
    }
    throw err;
  }
}

/** The stored row, or null when the table or the row does not exist yet. */
export async function readStoredConfig(driver: SqlDriver | null = registered): Promise<StoredConfig | null> {
  if (!driver) return null;
  try {
    const row = await driver.get<{ json: string; version: number | string }>(`SELECT json, version FROM config_store WHERE id = 1`);
    return row ? { json: row.json, version: Number(row.version) } : null;
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

/**
 * Opens a connection of its own when the service's is not registered yet
 * (boot runs before `initDb()`). Null when the backend is a SQLite file that
 * does not exist and `createIfMissing` is false.
 */
function openStoreDriver(createIfMissing: boolean): SqlDriver | null {
  if (DATABASE_URL) return createPgDriver({ url: DATABASE_URL, password: DATABASE_PASSWORD, max: 1 });
  if (!createIfMissing && !fs.existsSync(DB_PATH)) return null;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  return createSqliteDriver(DB_PATH);
}

function readLocalFile(): string | null {
  try {
    return fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Brings `CONFIG_PATH` in line with the stored row.
 *
 * When the row exists its JSON is written to the file. On first run (no row) an
 * existing `config.json` is imported as version 1 and left in place, or `{}` is
 * stored and written when there is none. A file that is not valid JSON is left
 * alone and nothing is imported, so a hand-mangled config is never replaced by
 * an empty one; the next boot tries again.
 *
 * Resolves true when it rewrote `CONFIG_PATH`, so a caller that already
 * loaded config knows to reload.
 *
 * `createIfMissing` (default false) lets a SQLite backend create `claws.db`
 * when it does not exist. Boot leaves it off: a fresh host with no database
 * derives its `verify-only` activation default from that absence, so the file
 * stays authoritative until `initDb()` creates the database, and `main.ts`
 * imports it then.
 *
 * `readOnly` (the web tier, `CLAWS_ROLE=web`) never creates the table or the
 * row: only the controller migrates and imports. With nothing stored yet it
 * leaves `CONFIG_PATH` as is; `config-watch.ts` applies the row once the
 * controller has stored it.
 */
export async function materialiseConfig(opts: { createIfMissing?: boolean; readOnly?: boolean } = {}): Promise<boolean> {
  const own = registered ? null : openStoreDriver(opts.createIfMissing ?? false);
  const driver = registered ?? own;
  if (!driver) {
    logCore.info(`[config-store] No database at ${DB_PATH} yet — using ${CONFIG_PATH} as is`);
    return false;
  }
  try {
    if (!opts.readOnly) await driver.exec(CONFIG_STORE_DDL);
    let stored = await readStoredConfig(driver);
    if (!stored && opts.readOnly) {
      logCore.info(`[config-store] No stored config yet — using ${CONFIG_PATH} as is until the controller stores one`);
      return false;
    }
    if (!stored) {
      const local = readLocalFile();
      let json = "{}\n";
      if (local !== null) {
        try {
          JSON.parse(local);
          json = local;
        } catch (err) {
          logCore.warn(`[config-store] ${CONFIG_PATH} is not valid JSON — not importing it`, err);
          return false;
        }
      }
      await driver.run(
        `INSERT INTO config_store (id, json, version, updated_at) VALUES (1, ?, 1, ?) ON CONFLICT (id) DO NOTHING`,
        [json, nowSql()],
      );
      stored = await readStoredConfig(driver);
      if (!stored) throw new Error("config_store row missing after insert");
      logCore.info(local === null
        ? `[config-store] No stored config — stored an empty one`
        : `[config-store] Imported ${CONFIG_PATH} into the database as version ${stored.version}`);
    }
    const rewrote = readLocalFile() !== stored.json;
    if (rewrote) writeConfigFile(stored.json);
    knownVersion = stored.version;
    return rewrote;
  } finally {
    await own?.close();
  }
}

/**
 * Thrown by {@link publishConfig} when the stored version is no longer the one
 * the caller read, because another process published in between. The caller
 * re-reads, re-applies its change and publishes again.
 */
export class ConfigVersionConflictError extends Error {
  constructor(expected: number | null) {
    super(`config_store moved past version ${expected ?? "(none)"} before this write`);
    this.name = "ConfigVersionConflictError";
  }
}

let lockTail: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` after every earlier call has settled, so this process's config
 * writes and watcher polls never interleave between reading the store and
 * writing `CONFIG_PATH`.
 */
export function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockTail.then(fn, fn);
  lockTail = run.catch(() => undefined);
  return run;
}

/**
 * Stores `json` as the new config if the stored version is still
 * `expectedVersion` (null: no row yet) and returns the bumped version, or null
 * when no database is registered (tests and standalone tools, which keep
 * file-only config). Throws {@link ConfigVersionConflictError} when another
 * process published first; any other database error throws as is, so the
 * caller changes nothing locally.
 */
export async function publishConfig(json: string, expectedVersion: number | null): Promise<number | null> {
  const driver = registered;
  if (!driver) return null;
  const now = nowSql();
  const result = expectedVersion === null
    ? await driver.run(`INSERT INTO config_store (id, json, version, updated_at) VALUES (1, ?, 1, ?) ON CONFLICT (id) DO NOTHING`, [json, now])
    : await driver.run(`UPDATE config_store SET json = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?`, [json, now, expectedVersion]);
  if (result.changes === 0) throw new ConfigVersionConflictError(expectedVersion);
  const version = (expectedVersion ?? 0) + 1;
  knownVersion = version;
  return version;
}
