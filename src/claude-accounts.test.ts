import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; label: string; token: string | null; position: number }>,
  failList: false,
  listClaudeAccounts: vi.fn(async () => {
    if (mockDb.failList) throw new Error("ops API down");
    return mockDb.rows.map((r) => ({ ...r }));
  }),
  setClaudeAccountToken: vi.fn(async (id: string, token: string | null) => {
    const row = mockDb.rows.find((r) => r.id === id);
    if (!row) return false;
    row.token = token;
    return true;
  }),
}));
vi.mock("./db.js", () => mockDb);
vi.mock("./log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import {
  __resetClaudeAccountsForTests,
  accountToken,
  accountTokenEnvKey,
  accountsWithToken,
  claudeAccounts,
  claudeAccountsStale,
  findClaudeAccount,
  isClaudeTokenEnvKey,
  pickClaudeAccount,
  refreshClaudeAccounts,
  resetClaudeAccountRoundRobin,
  setAccountToken,
  setClaudeAccounts,
} from "./claude-accounts.js";

const TWO = [{ id: "primary", label: "Primary", token: "tok-a" }, { id: "second-max", label: "Second", token: "tok-b" }];

beforeEach(() => {
  __resetClaudeAccountsForTests();
  mockDb.rows = [];
  mockDb.failList = false;
  vi.clearAllMocks();
  resetClaudeAccountRoundRobin();
});

describe("accountTokenEnvKey", () => {
  it("uppercases the id and turns dashes into underscores", () => {
    expect(accountTokenEnvKey("primary")).toBe("CLAUDE_CODE_OAUTH_TOKEN_PRIMARY");
    expect(accountTokenEnvKey("second-max")).toBe("CLAUDE_CODE_OAUTH_TOKEN_SECOND_MAX");
    expect(isClaudeTokenEnvKey("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(isClaudeTokenEnvKey("CLAUDE_CODE_OAUTH_TOKEN_SECOND_MAX")).toBe(true);
    expect(isClaudeTokenEnvKey("OTHER")).toBe(false);
  });
});

describe("claudeAccounts", () => {
  it("returns the cached accounts in position order and finds one by id", () => {
    setClaudeAccounts([{ id: "second-max", label: "Second", position: 1 }, { id: "primary", label: "Primary", position: 0 }]);
    expect(claudeAccounts().map((a) => a.id)).toEqual(["primary", "second-max"]);
    expect(findClaudeAccount("second-max")).toEqual({ id: "second-max", label: "Second" });
    expect(findClaudeAccount("nope")).toBeUndefined();
  });

  it("is empty when no account is stored: there is no default account", () => {
    expect(claudeAccounts()).toEqual([]);
    expect(pickClaudeAccount()).toBeNull();
  });
});

describe("refreshClaudeAccounts", () => {
  it("loads the accounts and tokens from the table and marks the cache fresh", async () => {
    mockDb.rows = [{ id: "primary", label: "Primary", token: "tok-a", position: 0 }];
    expect(claudeAccountsStale()).toBe(true);
    await refreshClaudeAccounts();
    expect(claudeAccountsStale()).toBe(false);
    expect(claudeAccounts()).toEqual([{ id: "primary", label: "Primary" }]);
    expect(accountToken("primary")).toBe("tok-a");
  });

  it("keeps the old cache when the read fails", async () => {
    setClaudeAccounts(TWO);
    mockDb.failList = true;
    await refreshClaudeAccounts();
    expect(claudeAccounts().map((a) => a.id)).toEqual(["primary", "second-max"]);
  });
});

describe("accountToken", () => {
  it("reads the cache, never process.env", () => {
    const saved = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "legacy";
    process.env["CLAUDE_CODE_OAUTH_TOKEN_PRIMARY"] = "env-own";
    try {
      setClaudeAccounts([{ id: "primary", label: "Primary", token: null }, { id: "second-max", label: "Second", token: "tok-b" }]);
      expect(accountToken("primary")).toBeUndefined();
      expect(accountToken("second-max")).toBe("tok-b");
      expect(accountToken("nope")).toBeUndefined();
      expect(accountsWithToken().map((a) => a.id)).toEqual(["second-max"]);
    } finally {
      if (saved === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
      else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = saved;
      delete process.env["CLAUDE_CODE_OAUTH_TOKEN_PRIMARY"];
    }
  });
});

describe("pickClaudeAccount", () => {
  it("round-robins over accounts with a token", () => {
    setClaudeAccounts(TWO);
    expect([pickClaudeAccount(), pickClaudeAccount(), pickClaudeAccount()].map((a) => a?.id)).toEqual(["primary", "second-max", "primary"]);
  });

  it("seeds a fresh process's cursor from the agent pod's row id, so consecutive rows alternate accounts", async () => {
    const savedRow = process.env["CLAWS_AGENT_POD_ROW"];
    try {
      const firstPicks: Array<string | undefined> = [];
      for (const row of ["41", "42"]) {
        process.env["CLAWS_AGENT_POD_ROW"] = row;
        vi.resetModules();
        const fresh = await import("./claude-accounts.js");
        fresh.setClaudeAccounts(TWO);
        firstPicks.push(fresh.pickClaudeAccount()?.id);
      }
      expect(firstPicks).toEqual(["second-max", "primary"]);
    } finally {
      if (savedRow === undefined) delete process.env["CLAWS_AGENT_POD_ROW"];
      else process.env["CLAWS_AGENT_POD_ROW"] = savedRow;
    }
  });

  it("seeds a fresh process's cursor at a random offset outside an agent pod", async () => {
    const savedRow = process.env["CLAWS_AGENT_POD_ROW"];
    delete process.env["CLAWS_AGENT_POD_ROW"];
    const random = vi.spyOn(Math, "random").mockReturnValue(0.0000011);
    try {
      vi.resetModules();
      const fresh = await import("./claude-accounts.js");
      fresh.setClaudeAccounts(TWO);
      expect(fresh.pickClaudeAccount()?.id).toBe("second-max");
    } finally {
      random.mockRestore();
      if (savedRow !== undefined) process.env["CLAWS_AGENT_POD_ROW"] = savedRow;
    }
  });

  it("skips excluded accounts and returns null when none is eligible", () => {
    setClaudeAccounts([{ id: "primary", label: "Primary", token: "tok-a" }]);
    expect(pickClaudeAccount(new Set(["primary"]))).toBeNull();
    expect(pickClaudeAccount()?.id).toBe("primary");
    setClaudeAccounts([{ id: "primary", label: "Primary", token: null }]);
    expect(pickClaudeAccount()).toBeNull();
  });
});

describe("setAccountToken", () => {
  it("writes the token to the table and the cache, not to process.env", async () => {
    mockDb.rows = [{ id: "primary", label: "Primary", token: "old", position: 0 }];
    await refreshClaudeAccounts();
    expect(await setAccountToken("primary", "new-a")).toBe(true);
    expect(mockDb.setClaudeAccountToken).toHaveBeenCalledWith("primary", "new-a");
    expect(mockDb.rows[0]!.token).toBe("new-a");
    expect(accountToken("primary")).toBe("new-a");
    expect(process.env["CLAUDE_CODE_OAUTH_TOKEN_PRIMARY"]).toBeUndefined();
  });

  it("loads an account this process had not read yet", async () => {
    mockDb.rows = [{ id: "fresh", label: "fresh", token: null, position: 0 }];
    expect(await setAccountToken("fresh", "tok")).toBe(true);
    expect(accountToken("fresh")).toBe("tok");
  });

  it("returns false and drops the account when it was removed", async () => {
    setClaudeAccounts([{ id: "gone", label: "gone", token: "old" }]);
    expect(await setAccountToken("gone", "tok")).toBe(false);
    expect(findClaudeAccount("gone")).toBeUndefined();
  });
});
