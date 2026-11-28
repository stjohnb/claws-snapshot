import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let mockTimeoutOverrides: Array<{ repo: string; number: number | string; timeoutMs: number }> = [];
let mockClaudeTimeoutMs = 30 * 60 * 1000;
const POD_CAP = 6 * 1024 * 1024 * 1024 - 512 * 1024 * 1024;

vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), {
  get CLAUDE_TIMEOUT_MS() { return mockClaudeTimeoutMs; },
  get ITEM_TIMEOUT_OVERRIDES() { return mockTimeoutOverrides; },
  writeConfig: vi.fn(),
  get AGENT_WORKER_MEMORY_MAX_BYTES() { return POD_CAP; },
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
  recordItemRemovedFromQueue: vi.fn().mockResolvedValue(undefined),
  // `imported-refs.ts` is the real module here: the alias widening is what
  // keeps a forge-numbered override alive across an import.
  recordImportedIssue: vi.fn(async () => true),
  listImportedIssues: vi.fn(async () => []),
}));

vi.mock("./github.js", () => ({
  skipItem: vi.fn(),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./agent-pod-class.js", () => ({
  AGENT_POD_CLASS_ENV: "CLAWS_AGENT_POD_CLASS",
  agentPodClassOf: (v: string | null | undefined) => (v === "large" ? "large" : "default"),
  escalateItemToLarge: vi.fn().mockResolvedValue(true),
}));

vi.mock("./error-reporter.js", () => ({
  reportTimeoutOnItem: vi.fn().mockResolvedValue(undefined),
  reportMemoryLimitOnItem: vi.fn().mockResolvedValue(undefined),
}));

import { handleTimeoutIfApplicable, handleMemoryLimitIfApplicable, handleMemoryLimitKill, getItemTimeoutMs } from "./timeout-handler.js";
import { memoryLimitKillFromError, type MemoryLimitKill } from "./memory-limit-kill.js";
import { recordImport, resetImportedRefsForTest } from "./imported-refs.js";
import { AgentTimeoutError, AgentMemoryLimitError } from "./claude.js";
import { writeConfig } from "./config.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import { reportTimeoutOnItem, reportMemoryLimitOnItem } from "./error-reporter.js";
import { escalateItemToLarge } from "./agent-pod-class.js";
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
    expect(db.recordItemRemovedFromQueue).toHaveBeenCalledWith("test-job", "timeout", "none");
  });

  it("does not count a queue removal below the threshold", async () => {
    vi.mocked(db.countRecentTimeouts).mockResolvedValue(2);
    await handleTimeoutIfApplicable("test-job", "org/repo", 42, new AgentTimeoutError(30 * 60 * 1000, 0, "", "", "/tmp/wt"));
    expect(db.recordItemRemovedFromQueue).not.toHaveBeenCalled();
  });

  it("counts a timeout removal under the agent pod's class", async () => {
    vi.stubEnv("CLAWS_AGENT_POD_ROW", "7");
    vi.stubEnv("CLAWS_AGENT_POD_CLASS", "large");
    try {
      vi.mocked(db.countRecentTimeouts).mockResolvedValue(3);
      await handleTimeoutIfApplicable("test-job", "org/repo", 42, new AgentTimeoutError(30 * 60 * 1000, 0, "", "", "/tmp/wt"));
      expect(db.recordItemRemovedFromQueue).toHaveBeenCalledWith("test-job", "timeout", "large");
    } finally {
      vi.unstubAllEnvs();
    }
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

const pss = (err: AgentMemoryLimitError, podClass?: "default" | "large", escalatable = false): MemoryLimitKill =>
  memoryLimitKillFromError(err, podClass, escalatable);

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
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 236, pss(err), 1, false);
  });

  it("does not post a comment for repo-level runs (itemNumber === 0)", async () => {
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 0, err);

    expect(reportMemoryLimitOnItem).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("repo-level run"), expect.objectContaining({ measurement: "pss" }));
  });

  it("skips the item after 3 consecutive memory-limit kills", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(3);
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 42, err);

    expect(gh.skipItem).toHaveBeenCalledWith("org/repo", 42);
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, pss(err), 3, true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Auto-skipped"));
    expect(db.recordItemRemovedFromQueue).toHaveBeenCalledWith("test-job", "memory-limit", "none");
  });

  it("still skips the item when the removal cannot be counted", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(3);
    vi.mocked(db.recordItemRemovedFromQueue).mockRejectedValueOnce(new Error("agent pod op refused"));
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 42, err);

    expect(gh.skipItem).toHaveBeenCalledWith("org/repo", 42);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Could not count the queue removal"));
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, pss(err), 3, true);
  });

  it("does not skip the item below the threshold", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(2);
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 42, err);

    expect(gh.skipItem).not.toHaveBeenCalled();
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, pss(err), 2, false);
    expect(db.recordItemRemovedFromQueue).not.toHaveBeenCalled();
  });

  describe("in an agent pod", () => {
    beforeEach(() => {
      vi.stubEnv("CLAWS_AGENT_POD_ROW", "7");
      vi.stubEnv("CLAWS_AGENT_POD_CLASS", "default");
      vi.mocked(escalateItemToLarge).mockResolvedValue(true);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("escalates a default-class kill at the pod's full cap and never counts or skips", async () => {
      vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(3);
      const err = new AgentMemoryLimitError(POD_CAP + 1, POD_CAP, 100, "/tmp/wt");

      await handleMemoryLimitIfApplicable("issue-worker", "org/repo", "clw_01ABC", err);

      expect(escalateItemToLarge).toHaveBeenCalledWith("org/repo", "clw_01ABC");
      expect(db.countRecentMemoryLimits).not.toHaveBeenCalled();
      expect(gh.skipItem).not.toHaveBeenCalled();
      expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", "clw_01ABC", pss(err, "default", true), 0, false, { retryingLarger: true });
      expect(db.recordItemRemovedFromQueue).not.toHaveBeenCalled();
    });

    it("falls through to the strike rule when the label is already present", async () => {
      vi.mocked(escalateItemToLarge).mockResolvedValue(false);
      vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(3);
      const err = new AgentMemoryLimitError(POD_CAP + 1, POD_CAP, 100, "/tmp/wt");

      await handleMemoryLimitIfApplicable("issue-worker", "org/repo", 42, err);

      expect(db.countRecentMemoryLimits).toHaveBeenCalledWith("org/repo", 42, POD_CAP);
      expect(gh.skipItem).toHaveBeenCalledWith("org/repo", 42);
      expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, pss(err, "default", true), 3, true);
    });

    it("falls through to the strike rule when the label write fails", async () => {
      vi.mocked(escalateItemToLarge).mockRejectedValue(new Error("forge down"));
      vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(1);
      const err = new AgentMemoryLimitError(POD_CAP + 1, POD_CAP, 100, "/tmp/wt");

      await handleMemoryLimitIfApplicable("issue-worker", "org/repo", 42, err);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Could not escalate"));
      expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, pss(err, "default", true), 1, false);
    });

    it("counts a large-class kill toward the three-strike rule", async () => {
      vi.stubEnv("CLAWS_AGENT_POD_CLASS", "large");
      vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(3);
      const err = new AgentMemoryLimitError(POD_CAP + 1, POD_CAP, 100, "/tmp/wt");

      await handleMemoryLimitIfApplicable("issue-worker", "org/repo", 42, err);

      expect(escalateItemToLarge).not.toHaveBeenCalled();
      expect(gh.skipItem).toHaveBeenCalledWith("org/repo", 42);
      expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, pss(err, "large"), 3, true);
      expect(db.recordItemRemovedFromQueue).toHaveBeenCalledWith("issue-worker", "memory-limit", "large");
    });

    it("does not escalate a kill at a lowered auxiliary cap", async () => {
      vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(1);
      const err = new AgentMemoryLimitError(800 * 1024 * 1024, 768 * 1024 * 1024, 100, "/tmp/wt");

      await handleMemoryLimitIfApplicable("pr-describer", "org/repo", 42, err);

      expect(escalateItemToLarge).not.toHaveBeenCalled();
      expect(db.countRecentMemoryLimits).toHaveBeenCalledWith("org/repo", 42, 768 * 1024 * 1024);
    });
  });

  it("never escalates an in-process run", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(1);
    const err = new AgentMemoryLimitError(POD_CAP + 1, POD_CAP, 100, "/tmp/wt");

    await handleMemoryLimitIfApplicable("issue-worker", "org/repo", 42, err);

    expect(escalateItemToLarge).not.toHaveBeenCalled();
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, pss(err), 1, false);
  });

  it("comment failure does not propagate", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(1);
    vi.mocked(reportMemoryLimitOnItem).mockRejectedValueOnce(new Error("comment failed"));
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");

    await handleMemoryLimitIfApplicable("test-job", "org/repo", 42, err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to post memory-limit comment"));
  });
});

describe("handleMemoryLimitKill for a Kubernetes OOM kill", () => {
  const GIB = 1024 ** 3;
  const oom = (podClass: "default" | "large", limitBytes: number, escalatable = podClass === "default"): MemoryLimitKill => ({
    measurement: "kubernetes-oom", limitBytes, observedBytes: null, rssBytes: null, outputBytes: null, podClass,
    escalatable, sharedBudgetBytes: null, containerLimitBytes: null, headroomBytes: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(escalateItemToLarge).mockResolvedValue(true);
  });

  it("escalates a default-class OOM to large without counting a strike", async () => {
    const kill = oom("default", 6 * GIB);
    await handleMemoryLimitKill("issue-worker", "org/repo", 42, kill);
    expect(escalateItemToLarge).toHaveBeenCalledWith("org/repo", 42);
    expect(db.countRecentMemoryLimits).not.toHaveBeenCalled();
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, kill, 0, false, { retryingLarger: true });
  });

  it("counts a default-class OOM as a strike when the item is already large", async () => {
    vi.mocked(escalateItemToLarge).mockResolvedValue(false);
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(1);
    const kill = oom("default", 6 * GIB);
    await handleMemoryLimitKill("issue-worker", "org/repo", 42, kill);
    expect(db.countRecentMemoryLimits).toHaveBeenCalledWith("org/repo", 42, 6 * GIB);
    expect(gh.skipItem).not.toHaveBeenCalled();
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", 42, kill, 1, false);
  });

  it("skips the item on the third large-class OOM at the same limit", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(3);
    const kill = oom("large", 16 * GIB);
    await handleMemoryLimitKill("issue-worker", "org/repo", "clw_01ABC", kill);
    expect(escalateItemToLarge).not.toHaveBeenCalled();
    expect(db.countRecentMemoryLimits).toHaveBeenCalledWith("org/repo", "clw_01ABC", 16 * GIB);
    expect(gh.skipItem).toHaveBeenCalledWith("org/repo", "clw_01ABC");
    expect(reportMemoryLimitOnItem).toHaveBeenCalledWith("org/repo", "clw_01ABC", kill, 3, true);
  });

  it("counts an OOM at an unknown pod limit on the legacy path", async () => {
    vi.mocked(db.countRecentMemoryLimits).mockResolvedValue(1);
    await handleMemoryLimitKill("issue-worker", "org/repo", 42, oom("large", 0));
    expect(db.countRecentMemoryLimits).toHaveBeenCalledWith("org/repo", 42, undefined);
  });

  it("only logs an OOM on a repo-level row", async () => {
    await handleMemoryLimitKill("doc-maintainer", "org/repo", 0, oom("default", 6 * GIB));
    expect(escalateItemToLarge).not.toHaveBeenCalled();
    expect(reportMemoryLimitOnItem).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("repo-level run"), expect.objectContaining({ measurement: "kubernetes-oom" }));
  });
});
