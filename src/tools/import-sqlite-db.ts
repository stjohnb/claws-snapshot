#!/usr/bin/env node
/**
 * Load a SQLite snapshot into the Postgres database `CLAWS_DATABASE_URL` points
 * at, replacing its contents. A manual tool for one-off SQLite-to-Postgres
 * imports (see `docs/k8s-cutover.md` for its use during the cutover).
 *
 * Uses console.*, not src/log.ts — log.ts writes to the database this truncates.
 */
import { importSqliteIntoPostgres } from "../db-import.js";

const sqlitePath = process.argv[2];
if (!sqlitePath) {
  console.error("usage: node dist/tools/import-sqlite-db.js <path-to-claws.db>");
  process.exit(2);
}

try {
  const result = await importSqliteIntoPostgres(sqlitePath);
  const skipped = result.skipped.length > 0 ? result.skipped.join(", ") : "none";
  console.log(`imported ${result.rows} rows across ${result.tables} tables (skipped: ${skipped})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
