import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let mockTimeoutOverrides: Array<{ repo: string; number: number | string; timeoutMs: number }> = [];
let mockClaudeTimeoutMs = 30 * 60 * 1000;

vi.mock("./config.js", () => ({
  get CLAUDE_TIMEOUT_MS() { return mockClaudeTimeoutMs; },
  get ITEM_TIMEOUT_OVERRIDES() { return mockTimeoutOverrides; },
  writeConfig: vi.fn(),
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./db.js", () => ({
  countRecentTimeouts: vi.fn().mockReturnValue(0),
  countRecentMemoryLimits: vi.fn().mockReturnValue(0),
  // `imported-refs.ts` is the real module here: the alias widening is what
  // keeps a forge-numbered override alive across an import.
  recordImportedIssue: vi.fn(async () => true),
  listImportedIssues: vi.fn(async () => []),
}));

vi.mock("./github.js", () => ({
  skipItem: vi.fn(),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./error-reporter.js", () => ({
  reportTimeoutOnItem: vi.fn().mockResolvedValue(undefined),
  reportMemoryLimitOnItem: vi.fn().mockResolvedValue(undefined),
}));

import { handleTimeoutIfApplicable, handleMemoryLimitIfApplicable, getItemTimeoutMs } from "./timeout-handler.js";
import { recordImport, resetImportedRefsForTest } from "./imported-refs.js";
import { AgentTimeoutError, AgentMemoryLimitError } from "./claude.js";
import { writeConfig } from "./config.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import { reportTimeoutOnItem, reportMemoryLimitOnItem } from "./error-reporter.js";
import * as log from "./log.js";

describe("getItemTimeoutMs", () => {
  beforeEach(() => {
    mockTimeoutOverrides = [];
    mockClaudeTimeoutMs = 30 * 60 * 1000;
    resetImportedRefsForTest();
  });

  afterEach(() => {
    resetImportedRefsForTest();
  });

  it("still finds a forge-numbered override after that issue was imported", async () => {
    const native = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    await recordImport("org/repo", 42, native);
    mockTimeoutOverrides = [{ repo: "org/repo", number: 42, timeoutMs: 45 * 60 * 1000 }];

    expect(getItemTimeoutMs("org/repo", native)).toBe(45 * 60 * 1000);
    // The alias belongs to `org/repo` alone — forge numbers collide across repos.
    expect(getItemTimeoutMs("org/other", native)).toBeUndefined();
  });

  it("returns undefined when no override exists", () => {
    expect(getItemTimeoutMs("org/repo", 42)).toBeUndefined();
  });

  it("returns the override timeout when one exists", () => {
    mockTimeoutOverrides = [{ repo: "org/repo", number: 42, timeoutMs: 45 * 60 * 1000 }];
    expect(getItemTimeoutMs("org/repo", 42)).toBe(45 * 60 * 1000);
  });

  it("returns undefined for a different item", () => {
    mockTimeoutOverrides = [{ repo: "org/repo", number: 42, timeoutMs: 45 * 60 * 1000 }];
    expect(getItemTimeoutMs("org/repo", 99)).toBeUndefined();
  });

  it("returns undefined when override is less than the current default (legacy override)", () => {
    mockClaudeTimeoutMs = 6 * 60 * 60 * 1000; // 6h default
    mockTimeoutOverrides = [{ repo: "org/repo", number: 42, timeoutMs: 45 * 60 * 1000 }]; // 45min legacy
    expect(getItemTimeoutMs("org/repo", 42)).toBeUndefined();
  });

  it("returns undefined when override equals the current default", () => {
    mockClaudeTimeoutMs = 6 * 60 * 60 * 1000;
    mockTimeoutOverrides = [{ repo: "org/repo", number: 42, timeoutMs: 6 * 60 * 60 * 1000 }];
    expect(getItemTimeoutMs("org/repo", 42)).toBeUndefined();
  });

  it("returns override when it exceeds the current default", () => {
    mockClaudeTimeoutMs = 30 * 60 * 1000; // 30min default
    mockTimeoutOverrides = [{ repo: "org/repo", number: 42, timeoutMs: 45 * 60 * 1000 }]; // 45min override
    expect(getItemTimeoutMs("org/repo", 42)).toBe(45 * 60 * 1000);
  });
});

describe("handleTimeoutIfApplicable", () => {
  beforeEach(() => {
    mockTimeoutOverrides = [];
    mockClaudeTimeoutMs = 30 * 60 * 1000;
    vi.clearAllMocks();
  });

  it("ignores non-timeout errors", async () => {
    await handleTimeoutIfApplicable("test-job", "org/repo", 1, new Error("generic error"));

    expect(db.countRecentTimeouts).not.toHaveBeenCalled();
    expect(gh.skipItem).not.toHaveBeenCalled();
    expect(reportTimeoutOnItem).not.toHaveBeenCalled();
  });

  it("on first timeout: posts comment and escalates timeout", async () => {
    vi.mocked(db.countRecentTimeouts).mockResolvedValue(1);
    const err = new AgentTimeoutError(30 * 60 * 1000, 500, "output", "stderr", "/tmp/wt");

    await handleTimeoutIfApplicable("test-job", "org/repo", 42, err);

    expect(gh.skipItem).not.toHaveBeenCalled();
    expect(writeConfig).toHaveBeenCalledWith({
      itemTimeoutOverrides: [{ repo: "org/repo", number: 42, timeoutMs: 45 * 60 * 1000 }],
    });
    expect(reportTimeoutOnItem).toHaveBeenCalledWith(
      "org/repo", 42, 1, err, false, 45 * 60 * 1000,
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Escalated timeout"));
  });

  it("on second timeout: escalates again", async () => {
    mockTimeoutOverrides = [{ repo: "org/repo", number: 42, timeoutMs: 45 * 60 * 1000 }];
    vi.mocked(db.countRecentTimeouts).mockResolvedValue(2);
    const err = new AgentTimeoutError(45 * 60 * 1000, 0, "", "", "/tmp/wt");

    await handleTimeoutIfApplicable("test-job", "org/repo", 42, err);

    expect(gh.skipItem).not.toHaveBeenCalled();
    // 45 * 1.5 = 67.5 → rounded to 68
    const expectedTimeout = Math.min(Math.round(45 * 60 * 1000 * 1.5), 6 * 60 * 60 * 1000);
    expect(writeConfig).toHaveBeenCalledWith({
      itemTimeoutOverrides: [{ repo: "org/repo", number: 42, timeoutMs: expectedTimeout }],
    });
  });

  it("escalates an imported issue's pre-import override in place instead of shadowing it", async () => {
    // `getItemTimeoutMs` reads by alias but `escalateTimeout` used to locate the
    // entry by the canonical ref alone, so it appended a second entry. `.find`
    // returns the first match, so the stale pre-import entry won every read and
    // the escalation was recomputed and rewritten forever (#3245).
    const native = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    resetImportedRefsForTest();
    await recordImport("org/repo", 42, native);
    mockTimeoutOverrides = [{ repo: "org/repo", number: 42, timeoutMs: 45 * 60 * 1000 }];
    vi.mocked(db.countRecentTimeouts).mockResolvedValue(1);
    const err = new AgentTimeoutError(45 * 60 * 1000, 0, "", "", "/tmp/wt");

    await handleTimeoutIfApplicable("test-job", "org/repo", native, err);

    const first = Math.round(45 * 60 * 1000 * 1.5);
    expect(writeConfig).toHaveBeenCalledWith({
      itemTimeoutOverrides: [{ repo: "org/repo", number: native, timeoutMs: first }],
    });

    // Re-read the config the way the process would, then escalate again: the
    // second escalation must build on the first, not on the stale 45min entry.
    mockTimeoutOverrides = [{ repo: "org/repo", number: native, timeoutMs: first }];
    vi.mocked(db.countRecentTimeouts).mockResolvedValue(2);
    await handleTimeoutIfApplicable("test-job", "org/repo", native, err);

    expect(writeConfig).toHaveBeenLastCalledWith({
      itemTimeoutOverrides: [{ repo: "org/repo", number: native, timeoutMs: Math.round(first * 1.5) }],
    });
    resetImportedRefsForTest();
  });

  it("on third timeout: skips the item", async () => {
    vi.mocked(db.countRecentTimeouts).mockResolvedValue(3);
    const err = new AgentTimeoutError(30 * 60 * 1000, 0, "", "", "/tmp/wt");

    await handleTimeoutIfApplicable("test-job", "org/repo", 42, err);

    expect(gh.skipItem).toHaveBeenCalledWith("org/repo", 42);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(reportTimeoutOnItem).toHaveBeenCalledWith(
      "org/repo", 42, 3, err, true, null,
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Auto-skipped"));
  });

  it("comment failure does not propagate", async () => {
    vi.mocked(db.countRecentTimeouts).mockResolvedValue(1);
    vi.mocked(reportTimeoutOnItem).mockRejectedValueOnce(new Error("comment failed"));
    const err = new AgentTimeoutError(30 * 60 * 1000, 0, "", "", "/tmp/wt");

    // Should not throw
    await handleTimeoutIfApplicable("test-job", "org/repo", 42, err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to post timeout comment"));
  });

  it("timeout escalation respects the 6-hour cap", async () => {
    // Set current override near the cap
    mockTimeoutOverrides = [{ repo: "org/repo", number: 42, timeoutMs: 5 * 60 * 60 * 1000 }];
    vi.mocked(db.countRecentTimeouts).mockResolvedValue(1);
    const err = new AgentTimeoutError(5 * 60 * 60 * 1000, 100, "output", "", "/tmp/wt");

    await handleTimeoutIfApplicable("test-job", "org/repo", 42, err);

    // 5h * 1.5 = 7.5h, capped at 6h
    expect(writeConfig).toHaveBeenCalledWith({
      itemTimeoutOverrides: [{ repo: "org/repo", number: 42, timeoutMs: 6 * 60 * 60 * 1000 }],
    });
  });
});

describe("handleMemoryLimitIfApplicable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores non-memory-limit errors", async () => {
    await handleMemoryLimitIfApplicable("test-job", "org/repo", 1, new Error("generic"));

    expect(reportMemoryLimitOnItem).not.toHaveBeenCalled();
  });

  it("posts a comment on the originating item for AgentMemoryLimitError", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(1);
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 236, err);

    expect(gh.skipItem).not.toHaveBeenCalled();
    expect(db.countRecentMemoryLimits).toHaveBeenCalledWith("org/repo", 236, 2_147_483_648);
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 236, err, 1, false);
  });

  it("does not post a comment for repo-level runs (itemNumber === 0)", async () => {
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 0, err);

    expect(reportMemoryLimitOnItem).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("repo-level run"));
  });

  it("skips the item after 3 consecutive memory-limit kills", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(3);
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 42, err);

    expect(gh.skipItem).toHaveBeenCalledWith("org/repo", 42);
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, err, 3, true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Auto-skipped"));
  });

  it("does not skip the item below the threshold", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(2);
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 42, err);

    expect(gh.skipItem).not.toHaveBeenCalled();
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, err, 2, false);
  });

  it("comment failure does not propagate", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(1);
    vi.mocked(reportMemoryLimitOnItem).mockRejectedValueOnce(new Error("comment failed"));
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 42, err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to post memory-limit comment"));
  });
});
