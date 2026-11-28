import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SqlDriver } from "./db-driver.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "claws-config-store-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const { CONFIG_PATH, DB_PATH } = await import("./runtime-paths.js");
const store = await import("./config-store.js");

/** The service's connection: PGlite on the Postgres lane, else a SQLite file in the temp home. */
async function openDriver(): Promise<SqlDriver> {
  if (process.env["CLAWS_TEST_PGLITE"] === "1") {
    const { createPgLiteDriver } = await import("./db-driver-pg.js");
    return await createPgLiteDriver();
  }
  const { createSqliteDriver } = await import("./db-driver.js");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  return createSqliteDriver(DB_PATH);
}

let driver: SqlDriver | null = null;

beforeEach(() => {
  fs.rmSync(path.join(home, ".claws"), { recursive: true, force: true });
  store.setKnownConfigVersion(0);
});

afterEach(async () => {
  store.setConfigStoreDriver(null);
  if (driver) {
    await driver.exec("DROP TABLE IF EXISTS config_store");
    await driver.close();
    driver = null;
  }
});

async function registered(): Promise<SqlDriver> {
  driver = await openDriver();
  store.setConfigStoreDriver(driver);
  return driver;
}

function writeLocal(json: string): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, json);
}

describe("config-store", () => {
  it("readStoredConfig returns null when the table is missing", async () => {
    await registered();
    expect(await store.readStoredConfig()).toBeNull();
  });

  it("readStoredConfig returns null with no database registered", async () => {
    expect(await store.readStoredConfig()).toBeNull();
  });

  it("imports an existing config.json as version 1 and leaves the file in place", async () => {
    const original = JSON.stringify({ selfRepo: "org/claws" }, null, 2) + "\n";
    writeLocal(original);
    await registered();

    expect(await store.materialiseConfig()).toBe(false);

    expect(await store.readStoredConfig()).toEqual({ json: original, version: 1 });
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(original);
    expect(store.knownConfigVersion()).toBe(1);
  });

  it("stores and writes {} on first run with no config.json", async () => {
    await registered();
    await store.materialiseConfig();
    expect(await store.readStoredConfig()).toEqual({ json: "{}\n", version: 1 });
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe("{}\n");
    expect(fs.statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
  });

  it("readOnly (the web tier) creates no table and imports nothing, then applies a stored row", async () => {
    writeLocal("{\"local\":true}\n");
    const d = await registered();
    expect(await store.materialiseConfig({ readOnly: true })).toBe(false);
    expect(await store.readStoredConfig()).toBeNull();
    await expect(d.all(`SELECT 1 FROM config_store`)).rejects.toThrow();

    await store.materialiseConfig();
    await store.publishConfig("{\"stored\":true}\n", 1);
    expect(await store.materialiseConfig({ readOnly: true })).toBe(true);
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe("{\"stored\":true}\n");
  });

  it("does not import a config.json that is not valid JSON", async () => {
    writeLocal("{ not json");
    await registered();
    await store.materialiseConfig();
    expect(await store.readStoredConfig()).toBeNull();
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe("{ not json");
  });

  it("overwrites a hand-edited local file with the stored row", async () => {
    writeLocal(`{"selfRepo":"org/a"}`);
    await registered();
    await store.materialiseConfig();
    writeLocal(`{"selfRepo":"org/hand-edit"}`);

    expect(await store.materialiseConfig()).toBe(true);

    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(`{"selfRepo":"org/a"}`);
  });

  it("publishConfig bumps the version and round-trips the JSON", async () => {
    await registered();
    await store.materialiseConfig();

    expect(await store.publishConfig(`{"a":1}`, 1)).toBe(2);
    expect(await store.publishConfig(`{"a":2}`, 2)).toBe(3);

    expect(await store.readStoredConfig()).toEqual({ json: `{"a":2}`, version: 3 });
    expect(store.knownConfigVersion()).toBe(3);
  });

  it("publishConfig inserts version 1 when the row does not exist yet", async () => {
    const d = await registered();
    await d.exec(store.CONFIG_STORE_DDL);
    expect(await store.publishConfig(`{"a":1}`, null)).toBe(1);
  });

  it("publishConfig rejects a write based on a version another process has moved past", async () => {
    await registered();
    await store.materialiseConfig();
    expect(await store.publishConfig(`{"a":1}`, 1)).toBe(2);

    await expect(store.publishConfig(`{"a":"stale"}`, 1)).rejects.toBeInstanceOf(store.ConfigVersionConflictError);
    await expect(store.publishConfig(`{"a":"stale"}`, null)).rejects.toBeInstanceOf(store.ConfigVersionConflictError);

    expect(await store.readStoredConfig()).toEqual({ json: `{"a":1}`, version: 2 });
    expect(store.knownConfigVersion()).toBe(2);
  });

  it("publishConfig is a no-op returning null with no database registered", async () => {
    expect(await store.publishConfig(`{"a":1}`, null)).toBeNull();
  });

  it("publishConfig throws when the store is unreachable", async () => {
    store.setConfigStoreDriver({
      run: async () => {
        throw new Error("connection refused");
      },
    } as unknown as SqlDriver);
    await expect(store.publishConfig(`{"a":1}`, 1)).rejects.toThrow("connection refused");
    expect(store.knownConfigVersion()).toBe(0);
  });

  it.skipIf(process.env["CLAWS_TEST_PGLITE"] === "1")("leaves a missing SQLite database uncreated unless createIfMissing", async () => {
    writeLocal(`{"selfRepo":"org/a"}`);

    await store.materialiseConfig();
    expect(fs.existsSync(DB_PATH)).toBe(false);

    await store.materialiseConfig({ createIfMissing: true });
    expect(fs.existsSync(DB_PATH)).toBe(true);

    driver = await openDriver();
    expect(await store.readStoredConfig(driver)).toEqual({ json: `{"selfRepo":"org/a"}`, version: 1 });
  });
});
