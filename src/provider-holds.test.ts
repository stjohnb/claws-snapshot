import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  PROVIDER_RATE_LIMIT_COOLDOWN_MS: 5 * 60_000,
  DASHBOARD_URL: "https://claws.example.com",
}));
vi.mock("./log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./slack.js", () => ({ notify: vi.fn() }));
const accountRows = vi.hoisted(() => ({ rows: [] as Array<{ id: string; label: string; token: string | null; position: number }> }));
vi.mock("./db.js", () => ({
  listClaudeAccounts: vi.fn(async () => accountRows.rows),
  listProviderHolds: vi.fn(async () => []),
  setProviderHold: vi.fn(async () => {}),
  clearProviderHolds: vi.fn(async () => 0),
}));

import * as db from "./db.js";
import * as log from "./log.js";
import { __resetAgentAuthStateForTests, isAgentAuthExpired, noteAgentAuthFailure, noteAgentAuthSuccess } from "./agent-auth-state.js";
import { accountToken, resetClaudeAccountRoundRobin, setClaudeAccounts } from "./claude-accounts.js";
import {
  __resetProviderHoldsForTests,
  claudeProviderHeldUntil,
  clearProviderRateLimitState,
  clearProviderRateLimitStateShared,
  getModelTierRateLimitedUntil,
  isAccountRateLimited,
  isModelTierRateLimited,
  isProviderRateLimited,
  lastLimitedAt,
  markAccountRateLimited,
  markModelTierRateLimited,
  markProviderRateLimited,
  pickClaudeAccount,
  pickableClaudeAccounts,
  refreshProviderHolds,
} from "./provider-holds.js";

const KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_A", "CLAUDE_CODE_OAUTH_TOKEN_B"];
let saved: Record<string, string | undefined>;

/** Let fire-and-forget write-throughs settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  accountRows.rows = [{ id: "a", label: "A", token: "tok-a", position: 0 }, { id: "b", label: "B", token: "tok-b", position: 1 }];
  setClaudeAccounts(accountRows.rows);
  __resetProviderHoldsForTests();
  __resetAgentAuthStateForTests();
  resetClaudeAccountRoundRobin();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("refreshProviderHolds", () => {
  it("reloads the Claude accounts and tokens with the holds", async () => {
    accountRows.rows = [{ id: "a", label: "A", token: "tok-new", position: 0 }, { id: "c", label: "C", token: "tok-c", position: 1 }];
    await refreshProviderHolds();
    expect(db.listClaudeAccounts).toHaveBeenCalled();
    expect(accountToken("a")).toBe("tok-new");
    expect(pickableClaudeAccounts().map((a) => a.id)).toEqual(["a", "c"]);
  });
});

describe("write-through", () => {
  it("records each mark in the shared table under its key", async () => {
    const until = Date.now() + 60_000;
    markAccountRateLimited("a", until);
    markModelTierRateLimited("claude", "fable", 30_000, "b");
    markProviderRateLimited("codex", 10_000);
    await settle();
    expect(db.setProviderHold).toHaveBeenCalledWith("claude@a", until, "usage-limit");
    expect(db.setProviderHold).toHaveBeenCalledWith("claude@b:fable", expect.any(Number), "model-usage-limit");
    expect(db.setProviderHold).toHaveBeenCalledWith("codex", expect.any(Number), "rate-limit");
  });

  it("clears an account's keys only, or the whole provider's", async () => {
    markAccountRateLimited("a", Date.now() + 60_000);
    markAccountRateLimited("b", Date.now() + 60_000);
    expect(clearProviderRateLimitState("claude", "a")).toBe(true);
    expect(isAccountRateLimited("a")).toBe(false);
    expect(isAccountRateLimited("b")).toBe(true);
    expect(clearProviderRateLimitState("claude")).toBe(true);
    expect(isAccountRateLimited("b")).toBe(false);
    await settle();
    expect(db.clearProviderHolds).toHaveBeenCalledWith("claude@a");
    expect(db.clearProviderHolds).toHaveBeenCalledWith("claude");
  });

  it("waits for the shared delete when clearing service-side", async () => {
    let landed = false;
    vi.mocked(db.clearProviderHolds).mockImplementationOnce(async () => {
      await settle();
      landed = true;
      return 1;
    });
    markAccountRateLimited("a", Date.now() + 60_000);
    expect(await clearProviderRateLimitStateShared("claude", "a")).toBe(true);
    expect(landed).toBe(true);
  });

  it("logs a failed write and keeps the hold in this process", async () => {
    vi.mocked(db.setProviderHold).mockRejectedValueOnce(new Error("ops API down"));
    markAccountRateLimited("a", Date.now() + 60_000);
    await settle();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ops API down"));
    expect(isAccountRateLimited("a")).toBe(true);
  });
});

describe("refreshProviderHolds", () => {
  it("loads holds another process recorded and drops lapsed ones", async () => {
    const now = Date.now();
    vi.mocked(db.listProviderHolds).mockResolvedValueOnce([
      { key: "claude@b", until_ms: now + 60_000, reason: "usage-limit", updated_at: new Date(now - 1000).toISOString() },
      { key: "codex", until_ms: now - 1, reason: "rate-limit", updated_at: null },
    ]);
    await refreshProviderHolds();
    expect(isAccountRateLimited("b")).toBe(true);
    expect(lastLimitedAt("b")).toBe(now - 1000);
    expect(isProviderRateLimited("codex")).toBe(false);
  });

  it("forgets a hold the table no longer has, but keeps one whose write has not landed", async () => {
    markAccountRateLimited("a", Date.now() + 60_000);
    await settle(); // write landed
    vi.mocked(db.setProviderHold).mockRejectedValueOnce(new Error("down"));
    markAccountRateLimited("b", Date.now() + 60_000);
    await settle();
    vi.mocked(db.listProviderHolds).mockResolvedValueOnce([]); // the operator cleared a
    await refreshProviderHolds();
    expect(isAccountRateLimited("a")).toBe(false);
    expect(isAccountRateLimited("b")).toBe(true);
  });

  it("keeps the current holds when the table cannot be read", async () => {
    markAccountRateLimited("a", Date.now() + 60_000);
    await settle();
    vi.mocked(db.listProviderHolds).mockRejectedValueOnce(new Error("Database not initialized"));
    await refreshProviderHolds();
    expect(isAccountRateLimited("a")).toBe(true);
  });
});

describe("the all-accounts rule", () => {
  it("holds the Claude provider only when every account with a token is held, until the earliest release", () => {
    const now = Date.now();
    markAccountRateLimited("a", now + 60_000);
    expect(isProviderRateLimited("claude")).toBe(false);
    expect(claudeProviderHeldUntil()).toBeNull();
    markAccountRateLimited("b", now + 30_000);
    expect(isProviderRateLimited("claude")).toBe(true);
    expect(claudeProviderHeldUntil()).toBe(now + 30_000);
  });

  it("ignores an account with no token", () => {
    setClaudeAccounts([{ id: "a", label: "A", token: "tok-a" }, { id: "b", label: "B", token: null }]);
    markAccountRateLimited("a", Date.now() + 60_000);
    expect(isProviderRateLimited("claude")).toBe(true);
  });

  it("counts an auth-expired account as held", () => {
    noteAgentAuthFailure("expired", Date.now(), "claude", "b");
    expect(isProviderRateLimited("claude")).toBe(false);
    const until = Date.now() + 60_000;
    markAccountRateLimited("a", until);
    expect(claudeProviderHeldUntil()).toBe(until);
  });

  it("holds a tier for Claude only when every account holds it", () => {
    markModelTierRateLimited("claude", "fable", 60_000, "a");
    expect(isModelTierRateLimited("claude", "fable", "a")).toBe(true);
    expect(isModelTierRateLimited("claude", "fable")).toBe(false);
    expect(claudeProviderHeldUntil("fable")).toBeNull();
    markModelTierRateLimited("claude", "fable", 30_000, "b");
    expect(isModelTierRateLimited("claude", "fable")).toBe(true);
    expect(getModelTierRateLimitedUntil("claude", "fable")).not.toBeNull();
    expect(claudeProviderHeldUntil("fable")).not.toBeNull();
    expect(claudeProviderHeldUntil("opus")).toBeNull();
  });

  it("a provider-wide hold holds Claude whatever the accounts", () => {
    markProviderRateLimited("claude", 60_000);
    expect(isProviderRateLimited("claude")).toBe(true);
  });
});

describe("pickClaudeAccount", () => {
  it("skips held, tier-held, auth-expired and excluded accounts", () => {
    markAccountRateLimited("a", Date.now() + 60_000);
    expect(pickClaudeAccount()?.id).toBe("b");
    clearProviderRateLimitState("claude", "a");
    markModelTierRateLimited("claude", "opus", 60_000, "b");
    expect(pickClaudeAccount({ tier: "opus" })?.id).toBe("a");
    expect(pickClaudeAccount({ tier: "opus", exclude: new Set(["a"]) })).toBeNull();
    noteAgentAuthFailure("expired", Date.now(), "claude", "a");
    expect(pickClaudeAccount({ tier: "sonnet" })?.id).toBe("b");
  });

  it("lets an auth-expired account back in once its hold lapses, and a success clears the latch", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      noteAgentAuthFailure("expired", Date.now(), "claude", "a");
      expect(pickClaudeAccount({ exclude: new Set(["b"]) })).toBeNull();
      // A further failure renews the hold.
      vi.setSystemTime(1_100_000);
      noteAgentAuthFailure("expired", Date.now(), "claude", "a");
      // Every account auth-expired: Claude is held until the earliest lapses.
      noteAgentAuthFailure("expired", Date.now(), "claude", "b");
      expect(claudeProviderHeldUntil()).toBe(1_100_000 + 5 * 60_000);
      vi.setSystemTime(1_100_000 + 5 * 60_000);
      expect(pickClaudeAccount({ exclude: new Set(["b"]) })?.id).toBe("a");
      // The probe run succeeds: the latch clears and the shared row lapses (pods may set, not delete).
      noteAgentAuthSuccess("claude", "a");
      expect(isAgentAuthExpired("claude", "a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(vi.mocked(db.setProviderHold).mock.calls.filter(([key]) => key === "auth-expired:claude@a")).toEqual([
      ["auth-expired:claude@a", 1_000_000 + 5 * 60_000, "auth-expired"],
      ["auth-expired:claude@a", 1_100_000 + 5 * 60_000, "auth-expired"],
      ["auth-expired:claude@a", 0, "cleared"],
    ]);
    expect(db.clearProviderHolds).not.toHaveBeenCalled();
  });

  it("prefers the account limited least recently, round-robin among ties", () => {
    expect([pickClaudeAccount()?.id, pickClaudeAccount()?.id]).toEqual(["a", "b"]);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      markAccountRateLimited("a", 1_000_100);
      vi.setSystemTime(1_000_050);
      markAccountRateLimited("b", 1_000_100);
      vi.setSystemTime(1_000_200); // both holds lapsed; a was limited earlier
      expect([pickClaudeAccount()?.id, pickClaudeAccount()?.id]).toEqual(["a", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
