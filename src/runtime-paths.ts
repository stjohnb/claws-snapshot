import path from "node:path";
import os from "node:os";

/**
 * Where this process keeps its state, and which database it talks to.
 *
 * A leaf module — it imports nothing from Claws — so `config-store.ts` and
 * `boot.ts` can locate the database and the materialised `config.json` before
 * `config.ts` loads (and reads that file). `config.ts` re-exports every name.
 */

export const WORK_DIR = path.join(os.homedir(), ".claws");

export const DB_PATH = path.join(WORK_DIR, "claws.db");

export const CONFIG_PATH = path.join(WORK_DIR, "config.json");

// Postgres connection, pod-env only: deliberately not a config.json key, so the
// password is never written to disk or rendered on the config page. Unset means
// SQLite at DB_PATH.
export const DATABASE_URL = process.env["CLAWS_DATABASE_URL"] ?? "";
export const DATABASE_PASSWORD = process.env["CLAWS_DATABASE_PASSWORD"] ?? "";
