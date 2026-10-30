import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
}));
vi.mock("./log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { closeDb, deleteClaudeAccount, initDb, insertClaudeAccount, listClaudeAccounts, readControllerStatus, setClaudeAccountToken, updateClaudeAccountLabel } from "./db.js";
import { CLAUDE_ACCOUNTS_IMPORTED_KEY, importLegacyClaudeAccounts } from "./claude-accounts-import.js";
import * as log from "./log.js";

let dir: string;
let configPath: string;

beforeEach(async () => {
  await initDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-accounts-import-"));
  configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, "{}");
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("claude_accounts helpers", () => {
  it("adds accounts in order, relabels, stores a token and deletes", async () => {
    await insertClaudeAccount("a", "A");
    await insertClaudeAccount("b", "B");
    await expect(insertClaudeAccount("a", "again")).rejects.toThrow();
    expect(await updateClaudeAccountLabel("b", "Bee")).toBe(true);
    expect(await updateClaudeAccountLabel("nope", "x")).toBe(false);
    expect(await setClaudeAccountToken("a", "tok-a")).toBe(true);
    expect(await setClaudeAccountToken("nope", "tok")).toBe(false);
    expect(await listClaudeAccounts()).toEqual([
      { id: "a", label: "A", token: "tok-a", position: 0 },
      { id: "b", label: "Bee", token: null, position: 1 },
    ]);
    expect(await deleteClaudeAccount("a")).toBe(true);
    expect(await deleteClaudeAccount("a")).toBe(false);
    await insertClaudeAccount("c", "C");
    expect((await listClaudeAccounts()).map((r) => [r.id, r.position])).toEqual([["b", 1], ["c", 2]]);
  });
});

describe("importLegacyClaudeAccounts", () => {
  it("imports CLAWS_CLAUDE_ACCOUNTS and each account's CLAUDE_CODE_OAUTH_TOKEN_<ID>, then never reads them again", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ claudeAccounts: [{ id: "ignored" }] }));
    const env = {
      CLAWS_CLAUDE_ACCOUNTS: "primary,second-max",
      CLAUDE_CODE_OAUTH_TOKEN_PRIMARY: "tok-a",
      CLAUDE_CODE_OAUTH_TOKEN_SECOND_MAX: "tok-b",
      CLAUDE_CODE_OAUTH_TOKEN: "legacy",
    };
    expect(await importLegacyClaudeAccounts({ env, configPath })).toMatchObject({ accounts: 2, tokens: 2 });
    expect(await listClaudeAccounts()).toEqual([
      { id: "primary", label: "primary", token: "tok-a", position: 0 },
      { id: "second-max", label: "second-max", token: "tok-b", position: 1 },
    ]);
    expect(await readControllerStatus(CLAUDE_ACCOUNTS_IMPORTED_KEY)).toMatchObject({ accounts: 2, tokens: 2 });
    // Tokens are never logged.
    for (const call of vi.mocked(log.info).mock.calls) expect(String(call[0])).not.toContain("tok-");

    // A second boot (or a changed env) leaves the table to the dashboard.
    await deleteClaudeAccount("second-max");
    expect(await importLegacyClaudeAccounts({ env: { ...env, CLAWS_CLAUDE_ACCOUNTS: "third" }, configPath })).toBeNull();
    expect((await listClaudeAccounts()).map((r) => r.id)).toEqual(["primary"]);
  });

  it("reads claudeAccounts from config.json and gives the first account the legacy bare token", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ claudeAccounts: [{ id: "main", label: "Main Max" }, { id: "spare" }] }));
    await importLegacyClaudeAccounts({ env: { CLAUDE_CODE_OAUTH_TOKEN: "legacy" }, configPath });
    expect(await listClaudeAccounts()).toEqual([
      { id: "main", label: "Main Max", token: "legacy", position: 0 },
      { id: "spare", label: "spare", token: null, position: 1 },
    ]);
  });

  it("creates the default primary account with no token when there is nothing to import", async () => {
    expect(await importLegacyClaudeAccounts({ env: {}, configPath })).toMatchObject({ accounts: 1, tokens: 0 });
    expect(await listClaudeAccounts()).toEqual([{ id: "primary", label: "primary", token: null, position: 0 }]);
  });

  it("leaves an account already in the table as it is", async () => {
    await insertClaudeAccount("primary", "Kept");
    await setClaudeAccountToken("primary", "db-token");
    expect(await importLegacyClaudeAccounts({ env: { CLAUDE_CODE_OAUTH_TOKEN_PRIMARY: "env-token" }, configPath })).toMatchObject({ accounts: 0, tokens: 0 });
    expect(await listClaudeAccounts()).toEqual([{ id: "primary", label: "Kept", token: "db-token", position: 0 }]);
  });
});
