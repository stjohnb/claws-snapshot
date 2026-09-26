import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteDriver, type SqlDriver } from "./db-driver.js";

describe("createSqliteDriver", () => {
  let driver: SqlDriver;

  beforeEach(async () => {
    driver = createSqliteDriver(":memory:");
    await driver.exec(`CREATE TABLE t (id {{PK_AUTOINC}}, name TEXT NOT NULL, made_at TEXT NOT NULL DEFAULT {{NOW}})`);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("substitutes the DDL dialect tokens", async () => {
    await driver.run(`INSERT INTO t (name) VALUES (?)`, ["a"]);
    const row = await driver.get<{ id: number; made_at: string }>(`SELECT id, made_at FROM t`);
    expect(row?.id).toBe(1);
    expect(row?.made_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("returns the inserted row id and change counts", async () => {
    const first = await driver.insert(`INSERT INTO t (name) VALUES (?)`, ["a"]);
    const second = await driver.insert(`INSERT INTO t (name) VALUES (?)`, ["b"]);
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(second.changes).toBe(1);

    const update = await driver.run(`UPDATE t SET name = ? WHERE name = ?`, ["c", "b"]);
    expect(update.changes).toBe(1);

    const rows = await driver.all<{ name: string }>(`SELECT name FROM t ORDER BY id`);
    expect(rows.map((r) => r.name)).toEqual(["a", "c"]);
  });

  it("adds a missing column and ignores a duplicate add", async () => {
    await driver.addColumn("t", "extra", "TEXT");
    await driver.addColumn("t", "extra", "TEXT");
    await driver.run(`INSERT INTO t (name, extra) VALUES (?, ?)`, ["a", "x"]);
    const row = await driver.get<{ extra: string }>(`SELECT extra FROM t`);
    expect(row?.extra).toBe("x");
  });

  it("commits a transaction and rolls back on throw", async () => {
    await driver.transaction(async (tx) => {
      await tx.run(`INSERT INTO t (name) VALUES (?)`, ["kept"]);
    });
    await expect(
      driver.transaction(async (tx) => {
        await tx.run(`INSERT INTO t (name) VALUES (?)`, ["dropped"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await driver.all<{ name: string }>(`SELECT name FROM t`);
    expect(rows.map((r) => r.name)).toEqual(["kept"]);
  });

  it("rejects a nested transaction", async () => {
    await expect(
      driver.transaction(async (tx) => {
        await tx.transaction(async () => undefined);
      }),
    ).rejects.toThrow("nested transaction");
  });

  it("serialises concurrent work so a rollback cannot discard it", async () => {
    const failing = driver
      .transaction(async (tx) => {
        await tx.run(`INSERT INTO t (name) VALUES (?)`, ["dropped"]);
        await new Promise((r) => setTimeout(r, 20));
        throw new Error("boom");
      })
      .catch((err: unknown) => err);
    // Fired while the transaction above is mid-flight and awaiting.
    const concurrentWrite = driver.run(`INSERT INTO t (name) VALUES (?)`, ["concurrent"]);
    const concurrentTx = driver.transaction(async (tx) => {
      await tx.run(`INSERT INTO t (name) VALUES (?)`, ["second-tx"]);
    });

    expect(await failing).toBeInstanceOf(Error);
    await concurrentWrite;
    await concurrentTx;

    const rows = await driver.all<{ name: string }>(`SELECT name FROM t ORDER BY id`);
    expect(rows.map((r) => r.name)).toEqual(["concurrent", "second-tx"]);
  });
});
