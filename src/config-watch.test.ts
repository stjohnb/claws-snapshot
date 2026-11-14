import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SqlDriver } from "./db-driver.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "claws-config-watch-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const { CONFIG_PATH, DB_PATH } = await import("./runtime-paths.js");
const store = await import("./config-store.js");
const config = await import("./config.js");
const { checkStoredConfig } = await import("./config-watch.js");

async function openDriver(): Promise<SqlDriver> {
  if (process.env["CLAWS_TEST_PGLITE"] === "1") {
    const { createPgLiteDriver } = await import("./db-driver-pg.js");
    return await createPgLiteDriver();
  }
  const { createSqliteDriver } = await import("./db-driver.js");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  return createSqliteDriver(DB_PATH);
}

let driver: SqlDriver;
const changes = vi.fn();
config.onConfigChange(changes);

/** Another process's publish: bumps the stored row without touching this process's state. */
async function publishFromElsewhere(json: string): Promise<void> {
  await driver.run(`UPDATE config_store SET json = ?, version = version + 1 WHERE id = 1`, [json]);
}

beforeEach(async () => {
  fs.rmSync(path.join(home, ".claws"), { recursive: true, force: true });
  store.setKnownConfigVersion(0);
  driver = await openDriver();
  store.setConfigStoreDriver(driver);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ selfRepo: "org/original" }));
  await store.materialiseConfig();
  config.reloadConfig();
  changes.mockClear();
});

afterEach(async () => {
  store.setConfigStoreDriver(null);
  await driver.exec("DROP TABLE IF EXISTS config_store");
  await driver.close();
});

describe("config-watch", () => {
  it("applies a version another process published and fires onConfigChange", async () => {
    const json = JSON.stringify({ selfRepo: "org/elsewhere" }, null, 2) + "\n";
    await publishFromElsewhere(json);

    expect(await checkStoredConfig()).toBe(true);

    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(json);
    expect(config.SELF_REPO).toBe("org/elsewhere");
    expect(changes).toHaveBeenCalledTimes(1);
    expect(store.knownConfigVersion()).toBe(2);
  });

  it("does nothing when the stored version has not moved", async () => {
    expect(await checkStoredConfig()).toBe(false);
    expect(changes).not.toHaveBeenCalled();
  });

  it("ignores this process's own published writes", async () => {
    await config.writeConfig({ selfRepo: "org/mine" });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await store.readStoredConfig())!.json)).toEqual({ selfRepo: "org/mine" });

    expect(await checkStoredConfig()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("writeConfig builds on a change another process published since the last poll", async () => {
    await publishFromElsewhere(JSON.stringify({ selfRepo: "org/elsewhere" }));

    await config.writeConfig({ logRetentionDays: 30 });

    expect(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"))).toEqual({ selfRepo: "org/elsewhere", logRetentionDays: 30 });
  });

  it("a failed publish leaves the local file untouched", async () => {
    const before = fs.readFileSync(CONFIG_PATH, "utf-8");
    store.setConfigStoreDriver({
      get: async () => undefined,
      run: async () => {
        throw new Error("connection refused");
      },
    } as unknown as SqlDriver);

    await expect(config.writeConfig({ selfRepo: "org/lost" })).rejects.toThrow("connection refused");

    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(before);
    expect(changes).not.toHaveBeenCalled();
  });

  it("a failed read rejects and changes nothing rather than writing from an empty base", async () => {
    const before = fs.readFileSync(CONFIG_PATH, "utf-8");
    const storedBefore = await store.readStoredConfig();
    const run = vi.fn();
    store.setConfigStoreDriver({
      get: async () => {
        throw new Error("connection terminated");
      },
      run,
    } as unknown as SqlDriver);

    await expect(config.writeConfig({ logRetentionDays: 30 })).rejects.toThrow("connection terminated");
    await expect(config.removeConfigKeys(["selfRepo"])).rejects.toThrow("connection terminated");

    expect(run).not.toHaveBeenCalled();
    store.setConfigStoreDriver(driver);
    expect(await store.readStoredConfig()).toEqual(storedBefore);
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(before);
    expect(changes).not.toHaveBeenCalled();
  });

  it("concurrent writes in this process both land", async () => {
    await Promise.all([
      config.writeConfig({ logRetentionDays: 30 }),
      config.writeConfig({ selfRepo: "org/both" }),
    ]);

    expect(JSON.parse((await store.readStoredConfig())!.json)).toEqual({ selfRepo: "org/both", logRetentionDays: 30 });
    expect(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"))).toEqual({ selfRepo: "org/both", logRetentionDays: 30 });
  });

  it("writeConfig re-reads and re-applies its change when another process publishes between its read and its publish", async () => {
    let raced = false;
    store.setConfigStoreDriver({
      ...driver,
      get: async (sql: string, params?: unknown[]) => {
        const row = await driver.get(sql, params);
        if (!raced) {
          raced = true;
          await publishFromElsewhere(JSON.stringify({ selfRepo: "org/elsewhere" }));
        }
        return row;
      },
      run: (sql: string, params?: unknown[]) => driver.run(sql, params),
    } as unknown as SqlDriver);

    await config.writeConfig({ logRetentionDays: 30 });

    store.setConfigStoreDriver(driver);
    const stored = (await store.readStoredConfig())!;
    expect(JSON.parse(stored.json)).toEqual({ selfRepo: "org/elsewhere", logRetentionDays: 30 });
    expect(stored.version).toBe(3);
    expect(store.knownConfigVersion()).toBe(3);
  });
});
