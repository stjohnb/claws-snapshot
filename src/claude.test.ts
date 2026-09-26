import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";

const mockForgejoRepos = vi.hoisted(() => ({ list: [] as string[] }));
// Mutable so admission tests can flip the watchdog cap / shared budget at runtime.
// Defaults mirror production: an unset CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES
// is `undefined` (derive from the cgroup limit), not `0` (operator disabled
// admission) — those are different branches of computeAgentMemoryPolicy, and only
// the derived one is what actually ships. `headroomBytes` is
// DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES, inlined because vi.hoisted runs
// before the import of it.
const mockMemoryConfig = vi.hoisted(() => ({
  maxBytes: 1_610_612_736,
  headroomBytes: 1280 * 1024 * 1024,
  sharedBudgetBytes: undefined as number | undefined,
}));
vi.mock("./config.js", () => ({
  WORK_DIR: "/tmp/test-claws",
  PROMPT_CAPTURE_DIR: "/tmp/fake-default-capture-dir",
  CLAUDE_TIMEOUT_MS: 20 * 60 * 1000,
  CLAUDE_LIVENESS_TIMEOUT_MS: 10 * 60 * 1000,
  get AGENT_WORKER_MEMORY_MAX_BYTES() { return mockMemoryConfig.maxBytes; },
  get AGENT_WORKER_MEMORY_HEADROOM_BYTES() { return mockMemoryConfig.headroomBytes; },
  get AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES() { return mockMemoryConfig.sharedBudgetBytes; },
  CLAUDE_WORKER_MEMORY_MAX_BYTES: 1_610_612_736,
  AI_PROVIDER_NAMES: ["claude", "codex", "opencode"],
  AI_PROVIDERS: {
    claude: { enabled: true, weight: 4 },
    codex: { enabled: false, weight: 2 },
    opencode: { enabled: false, weight: 1 },
  },
  PROVIDER_RATE_LIMIT_COOLDOWN_MS: 300_000,
  GIT_AUTHOR_NAME: "clawsstjohn[bot]",
  GIT_AUTHOR_EMAIL: "276932287+clawsstjohn[bot]@users.noreply.github.com",
  OPENROUTER_API_KEY: "",
  SERVER_PORT: 3456,
  INTERNAL_MCP_TOKEN: "a".repeat(64),
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  HOME_ASSISTANT_BASE_URL: "https://homeassistant.home.example.net",
  HOME_ASSISTANT_TOKEN: "test-ha-token",
  PROD_K8S_KUBECONFIG_PATH: "/secret/prod.kubeconfig",
  FLEET_KUBECONFIG_PATH: "/secret/fleet.kubeconfig",
  forgejoRepoUrl: (fullName: string) => `https://forge.example.com/${fullName}`,
  FORGEJO_TOKEN: "fgj_test_token",
  FORGEJO_READ_TOKEN: "fgj_read_test_token",
  FORGEJO_BASE_URL: "https://forge.example.com/",
  isForgejoRepo: (fullName: string) => mockForgejoRepos.list.some((r) => r.toLowerCase() === fullName.toLowerCase()),
  hasForgejoRepoForOwner: (owner: string) => mockForgejoRepos.list.some((r) => r.toLowerCase().startsWith(`${owner.toLowerCase()}/`)),
}));
vi.mock("./model-selector.js", async () => {
  const configMod = await import("./config.js") as unknown as Record<string, unknown>;
  class NoEligibleProviderError extends Error {
    constructor(message = "No eligible AI providers are enabled with a positive finite weight") {
      super(message);
      this.name = "NoEligibleProviderError";
    }
  }
  const getEnabledProviderWeights = () => {
    const providers = configMod["AI_PROVIDERS"] as Record<"claude" | "codex" | "opencode", { enabled?: boolean; weight?: number }>;
    const names = configMod["AI_PROVIDER_NAMES"] as Array<"claude" | "codex" | "opencode">;
    return names
      .map((provider) => ({ provider, weight: Number(providers[provider]?.weight ?? 0), enabled: providers[provider]?.enabled !== false }))
      .filter((entry) => entry.enabled && Number.isFinite(entry.weight) && entry.weight > 0)
      .map(({ provider, weight }) => ({ provider, weight }));
  };
  const selectWeightedProvider = (pool: ReadonlyArray<{ provider: "claude" | "codex" | "opencode"; weight: number }>, random: () => number = Math.random) => {
    const total = pool.reduce((sum, entry) => sum + (Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0), 0);
    if (total <= 0) throw new NoEligibleProviderError();
    const raw = random();
    const r = Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), 0.999999999999) * total;
    let cursor = 0;
    for (const entry of pool) {
      if (!Number.isFinite(entry.weight) || entry.weight <= 0) continue;
      cursor += entry.weight;
      if (r < cursor) return entry.provider;
    }
    return pool[pool.length - 1]!.provider;
  };
  return {
    getModel: () => "sonnet",
    getDeepModel: vi.fn(() => "fable"),
    getEnabledProviderWeights,
    selectWeightedProvider,
    selectWeightedProviderFromConfig: (random?: () => number) => selectWeightedProvider(getEnabledProviderWeights(), random),
    withoutProviders: (pool: ReadonlyArray<{ provider: "claude" | "codex" | "opencode"; weight: number }>, excluded: Set<"claude" | "codex" | "opencode"> | Array<"claude" | "codex" | "opencode">) => {
      const set = excluded instanceof Set ? excluded : new Set(excluded);
      return pool.filter((entry) => !set.has(entry.provider));
    },
    NoEligibleProviderError,
    resolveCodexModelForAttempt: vi.fn(async (model: string) => model),
  };
});
vi.mock("./ollama-rate-limit-classifier.js", () => ({ isRateLimitError: vi.fn().mockResolvedValue(false) }));

// agent-auth-state.ts Slack-notifies on latch recovery; keep it off the wire.
vi.mock("./slack.js", () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

let mockRunCtxId: string | undefined = undefined;
vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  runContext: { getStore: () => mockRunCtxId !== undefined ? { runId: mockRunCtxId } : undefined },
}));

let mockShuttingDown = false;
vi.mock("./shutdown.js", async () => {
  const actual = await vi.importActual<typeof import("./shutdown.js")>("./shutdown.js");
  return {
    ...actual,
    isShuttingDown: () => mockShuttingDown,
    setShuttingDown: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    accessSync: vi.fn(),
    constants: { F_OK: 0 },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    readdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    promises: {
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

const mockMintToken = vi.hoisted(() => vi.fn());
const mockBuildGitEnvForOwner = vi.hoisted(() => vi.fn());
vi.mock("./github-app.js", async () => {
  const actual = await vi.importActual<typeof import("./github-app.js")>("./github-app.js");
  return { ...actual, getInstallationTokenForOwner: mockMintToken, buildGitEnvForOwner: mockBuildGitEnvForOwner };
});

import { randomSuffix, datestamp, hasNewCommits, getCommitCount, getDiffStats, getCommitCountSince, getDiffStatsSince, generatePRDescription, generateDocsPRDescription, regeneratePRDescription, runClaude, cancelCurrentTask, cancelTaskByRunId, createWorktree, createWorktreeFromBranch, createWorktreeFromBranchIfExists, removeWorktree, pushBranch, ensureClone, resetFetchCache, resetWorktreeLocks, refreshAllRepos, AgentTimeoutError, AgentCliError, AgentMemoryLimitError, AgentExternalKillError, PushConflictError, git, isProviderRateLimited, markProviderRateLimited, clearProviderRateLimitState, getProviderRateLimitedUntil, sanitiseEnvForChild, SENSITIVE_ENV_KEYS, readRepoAgentDoc, readRepoInstructions, parseCodexJsonOutput, collectProcessTreePids, sampleProcessTreeRssBytes, writeClawsMcpConfig, writeAgentMcpConfig, agentMcpDir, removeAgentMcpDir, agentOutputFilePath, buildOutputFileInstruction, readAgentOutputFile, agentVerdictFilePath, buildVerdictFileInstruction, readAgentVerdictFile, writeCodexMcpHomeForRun } from "./claude.js";
import { agentMemoryAdmissionStatus, AUXILIARY_AGENT_MAX_TIMEOUT_MS, EXTERNAL_SIGTERM_SHUTDOWN_GRACE_MS, resetAgentMemoryGateForTests, TEXT_ONLY_DISALLOWED_TOOLS, NO_BACKGROUND_TASKS_ENV } from "./claude.js";
import { AUXILIARY_AGENT_ADMISSION_BYTES, DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES, MIN_PLAUSIBLE_AGENT_MEMORY_BYTES, resetCgroupLimitCacheForTests } from "./agent-memory-budget.js";
import { isRateLimitError } from "./ollama-rate-limit-classifier.js";
import { getDeepModel, resolveCodexModelForAttempt } from "./model-selector.js";
import { ShutdownError } from "./shutdown.js";
import * as shutdown from "./shutdown.js";
import * as logModule from "./log.js";
import * as mockConfig from "./config.js";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);
type MockProvider = "claude" | "codex" | "opencode";
const MOCK_PROVIDER_WEIGHTS: Record<MockProvider, number> = { claude: 4, codex: 2, opencode: 1 };
const ALL_MOCK_PROVIDERS: readonly MockProvider[] = ["claude", "codex", "opencode"];
const DEFAULT_MOCK_PROVIDERS: readonly MockProvider[] = ["claude"];

function setMockAiProviders(enabledProviders: ReadonlyArray<MockProvider> = DEFAULT_MOCK_PROVIDERS): void {
  const enabled = new Set(enabledProviders);
  const providers = mockConfig.AI_PROVIDERS as Record<MockProvider, { enabled?: boolean; weight?: number }>;
  for (const provider of ALL_MOCK_PROVIDERS) {
    providers[provider] = {
      enabled: enabled.has(provider),
      weight: MOCK_PROVIDER_WEIGHTS[provider],
    };
  }
}

function resetMockAiProviders(): void {
  setMockAiProviders();
}

function makeMockChild(pid = 1): ChildProcess & EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
} {
  const child = new EventEmitter() as ChildProcess & EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  };
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    kill: vi.fn(),
    pid,
  });
  return child;
}

function enoent(pathname: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${pathname}`), { code: "ENOENT" });
}

/** Every provider attempt reads the repo instructions (`AGENTS.md`) before its MCP
 *  config. Keyed by path rather than by call order, so a run that falls back to a
 *  second provider needs no attempt count at the call site. Reset when the test ends,
 *  since the implementation would otherwise outlive it. */
function mockRepoInstructionMissesThenMcpConfig(config: unknown): void {
  const mock = vi.mocked(fs.readFileSync);
  mock.mockImplementation((pathname) => {
    const name = String(pathname);
    if (name.endsWith("AGENTS.md")) throw enoent(name);
    return JSON.stringify(config);
  });
  onTestFinished(() => { mock.mockReset(); });
}

// The cgroup limit is memoized for the life of the process, so whichever test
// spawns first would otherwise pin it for the whole file — silently making any
// derived-budget test order-dependent.
beforeEach(() => {
  resetCgroupLimitCacheForTests();
  // The gate is process-wide, so a test that leaves a child un-closed would
  // otherwise leave reservedBytes permanently elevated and silently change what
  // every later admission test in this file means.
  resetAgentMemoryGateForTests();
});

/** Lets the admission gate's drain() and the promise chain behind it settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const OK_JSON = JSON.stringify({ result: "ok", is_error: false });

let probePid = 9900;

/**
 * Runs one call to completion and reports what it reserved while admitted.
 *
 * The reservation *is* the enforced watchdog cap — `computeRunCapBytes` feeds
 * both numbers — so this single value pins the lane the run was admitted into
 * and the RSS at which its tree would be SIGKILLed.
 */
async function reservedBytesFor(options: Parameters<typeof runClaude>[2]): Promise<number> {
  const child = makeMockChild(probePid++);
  mockSpawn.mockReturnValueOnce(child as any);
  const promise = runClaude("probe", "/tmp/probe", options);
  await flushMicrotasks();
  const reserved = agentMemoryAdmissionStatus().reservedBytes;
  child.stdout.emit("data", Buffer.from(OK_JSON));
  child.emit("close", 0, null);
  await promise;
  await flushMicrotasks();
  return reserved;
}

describe("randomSuffix", () => {
  it("returns a 4-character hex string", () => {
    const result = randomSuffix();
    expect(result).toMatch(/^[0-9a-f]{4}$/);
  });

  it("returns different values on each call", () => {
    const results = new Set(Array.from({ length: 10 }, () => randomSuffix()));
    expect(results.size).toBeGreaterThan(1);
  });
});

describe("datestamp", () => {
  it("returns an 8-digit date string", () => {
    const result = datestamp();
    expect(result).toMatch(/^\d{8}$/);
  });

  it("returns today's date", () => {
    const result = datestamp();
    const now = new Date();
    const expected =
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    expect(result).toBe(expected);
  });
});

describe("hasNewCommits", () => {
  it("returns true when rev-list count > 0", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("rev-list")) {
        cb(null, "3\n", "");
      }
      return undefined as any;
    });

    const result = await hasNewCommits("/tmp/wt", "main");
    expect(result).toBe(true);
  });

  it("returns false when rev-list count is 0", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("rev-list")) {
        cb(null, "0\n", "");
      }
      return undefined as any;
    });

    const result = await hasNewCommits("/tmp/wt", "main");
    expect(result).toBe(false);
  });
});

describe("getCommitCount", () => {
  it("returns the parsed commit count", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("rev-list")) {
        cb(null, "7\n", "");
      }
      return undefined as any;
    });

    const count = await getCommitCount("/tmp/wt", "main");
    expect(count).toBe(7);
  });

  it("returns 0 for empty output", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("rev-list")) {
        cb(null, "\n", "");
      }
      return undefined as any;
    });

    const count = await getCommitCount("/tmp/wt", "main");
    expect(count).toBe(0);
  });
});

describe("getDiffStats", () => {
  it("parses full shortstat output with files, insertions, and deletions", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("--shortstat")) {
        cb(null, " 5 files changed, 127 insertions(+), 42 deletions(-)\n", "");
      }
      return undefined as any;
    });

    const stats = await getDiffStats("/tmp/wt", "main");
    expect(stats).toEqual({ filesChanged: 5, insertions: 127, deletions: 42 });
  });

  it("parses output with only insertions", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("--shortstat")) {
        cb(null, " 1 file changed, 3 insertions(+)\n", "");
      }
      return undefined as any;
    });

    const stats = await getDiffStats("/tmp/wt", "main");
    expect(stats).toEqual({ filesChanged: 1, insertions: 3, deletions: 0 });
  });

  it("parses output with only deletions", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("--shortstat")) {
        cb(null, " 2 files changed, 10 deletions(-)\n", "");
      }
      return undefined as any;
    });

    const stats = await getDiffStats("/tmp/wt", "main");
    expect(stats).toEqual({ filesChanged: 2, insertions: 0, deletions: 10 });
  });

  it("returns zeros for empty output (no changes)", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("--shortstat")) {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const stats = await getDiffStats("/tmp/wt", "main");
    expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it("parses singular 'file changed' (1 file)", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("--shortstat")) {
        cb(null, " 1 file changed, 1 insertion(+), 1 deletion(-)\n", "");
      }
      return undefined as any;
    });

    const stats = await getDiffStats("/tmp/wt", "main");
    expect(stats).toEqual({ filesChanged: 1, insertions: 1, deletions: 1 });
  });
});

describe("getCommitCountSince", () => {
  it("counts commits ahead of a SHA rather than origin/<branch>", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("rev-list")) {
        expect(args).toContain("abc123..HEAD");
        cb(null, "4\n", "");
      }
      return undefined as any;
    });

    const count = await getCommitCountSince("/tmp/wt", "abc123");
    expect(count).toBe(4);
  });
});

describe("getDiffStatsSince", () => {
  it("diffs against a SHA rather than origin/<branch>", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("--shortstat")) {
        expect(args).toContain("abc123...HEAD");
        cb(null, " 2 files changed, 30 insertions(+), 4 deletions(-)\n", "");
      }
      return undefined as any;
    });

    const stats = await getDiffStatsSince("/tmp/wt", "abc123");
    expect(stats).toEqual({ filesChanged: 2, insertions: 30, deletions: 4 });
  });
});

describe("runClaude", () => {
  afterEach(() => {
    mockShuttingDown = false;
    mockRunCtxId = undefined;
    clearProviderRateLimitState();
  });

  it("passes --model flag when model option is provided", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", model: "sonnet" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--model", "sonnet"]),
      expect.objectContaining({ cwd: "/tmp" }),
    );

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    await promise;
  });

  it("does not pass --model flag when model option is omitted", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp");

    const spawnArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1] as string[];
    expect(spawnArgs).not.toContain("--model");

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    await promise;
  });

  it("uses weighted provider selection for unpinned calls against the enabled provider config", async () => {
    setMockAiProviders(["claude", "codex", "opencode"]);
    try {
      const codexChild = makeMockChild(101);
      const opencodeChild = makeMockChild(102);
      mockSpawn.mockReturnValueOnce(codexChild as any).mockReturnValueOnce(opencodeChild as any);

      const codexProviderUsed = vi.fn();
      const codexPromise = runClaude("codex prompt", "/tmp", {
        tier: "sonnet",
        providerRandom: () => 4 / 7,
        onProviderUsed: codexProviderUsed,
      });
      await Promise.resolve();
      codexChild.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "codex output" },
      }) + "\n"));
      codexChild.emit("close", 0, null);

      await expect(codexPromise).resolves.toBe("codex output");
      expect(codexProviderUsed).toHaveBeenCalledWith("codex");

      const opencodeProviderUsed = vi.fn();
      const opencodePromise = runClaude("opencode prompt", "/tmp", {
        tier: "sonnet",
        providerRandom: () => 6 / 7,
        onProviderUsed: opencodeProviderUsed,
      });
      await Promise.resolve();
      opencodeChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", part: { text: "opencode output" } }) + "\n"));
      opencodeChild.emit("close", 0, null);

      await expect(opencodePromise).resolves.toBe("opencode output");
      expect(opencodeProviderUsed).toHaveBeenCalledWith("opencode");

      const spawnCalls = mockSpawn.mock.calls.slice(-2);
      expect(spawnCalls.map((call) => call[0])).toEqual(["codex", "opencode"]);
    } finally {
      resetMockAiProviders();
    }
  });

  it("resolves with parsed result from JSON output on success", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp");

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "output text", is_error: false })));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("output text");
    expect(stdinMock.write).toHaveBeenCalledWith("test prompt");
    expect(stdinMock.end).toHaveBeenCalled();
  });

  it("invokes onTokensUsed with summed token count and total cost from the Claude CLI JSON output", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const onTokensUsed = vi.fn();
    const promise = runClaude("test", "/tmp", {
      tier: "sonnet",
      provider: "claude",
      onTokensUsed,
    });

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({
      is_error: false,
      result: "ok",
      num_turns: 1,
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    })));
    child.emit("close", 0, null);

    await promise;
    expect(onTokensUsed).toHaveBeenCalledWith(165, 0.0123, "claude");
  });

  it("resolves with result when JSON is_error is false even on non-zero exit code", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "partial output", is_error: false })));
    stderrEmitter.emit("data", Buffer.from("error msg"));
    child.emit("close", 1, null);

    const result = await promise;
    expect(result).toBe("partial output");
  });

  it("rejects with AgentCliError when JSON is_error is true", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "You're out of extra usage · resets 5pm", is_error: true })));
    child.emit("close", 1, null);

    await expect(promise).rejects.toThrow(AgentCliError);
    await expect(promise).rejects.toThrow("You're out of extra usage");
  });

  it("rejects with AgentCliError on non-JSON output with non-zero exit code", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from("You're out of extra usage · resets 5pm (Europe/London)"));
    child.emit("close", 1, null);

    await expect(promise).rejects.toThrow(AgentCliError);
  });

  it("rejects with AgentCliError on non-JSON output even with exit code 0", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from("Some short error text"));
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow(AgentCliError);
  });

  it("rejects with AgentCliError on long non-JSON output with exit code 0", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from("x".repeat(1000)));
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow(AgentCliError);
  });

  it("does not retry AgentCliError when numTurns is not 0", async () => {
    const spawnCountBefore = mockSpawn.mock.calls.length;

    // First spawn — will produce a AgentCliError with num_turns: 1
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "CLI error", is_error: true, num_turns: 1 })));
    child.emit("close", 1, null);

    await expect(promise).rejects.toThrow(AgentCliError);
    // spawn should only have been called once — no retry for non-zero-turn AgentCliError
    expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(1);
  });

  it("retries AgentCliError with numTurns === 0 and succeeds", async () => {
    const spawnCountBefore = mockSpawn.mock.calls.length;

    // First child: fails with 0-turn init error
    const child1 = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout1 = new EventEmitter();
    const stderr1 = new EventEmitter();
    const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child1, { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: vi.fn(), pid: 1 });

    // Second child: succeeds
    const child2 = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout2 = new EventEmitter();
    const stderr2 = new EventEmitter();
    const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child2, { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn(), pid: 2 });

    mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

    const promise = runClaude("test prompt", "/tmp");

    // First child fails with 0-turn error
    stdout1.emit("data", Buffer.from(JSON.stringify({ is_error: true, subtype: "error_during_execution", num_turns: 0 })));
    child1.emit("close", 1, null);

    // Allow microtask for retry to spawn second child
    await new Promise((r) => setTimeout(r, 0));

    // Second child succeeds
    stdout2.emit("data", Buffer.from(JSON.stringify({ result: "retry success", is_error: false })));
    child2.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("retry success");
    expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(2);
  });

  it("does not retry AgentCliError with numTurns === 0 during shutdown", async () => {
    mockShuttingDown = true;
    const spawnCountBefore = mockSpawn.mock.calls.length;

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ is_error: true, num_turns: 0 })));
    child.emit("close", 1, null);

    await expect(promise).rejects.toThrow(AgentCliError);
    // No retry during shutdown
    expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(1);
  });

  it("retries AgentCliError with transient API 500 error and succeeds", async () => {
    const spawnCountBefore = mockSpawn.mock.calls.length;

    // First child: fails with API 500 error (num_turns > 0)
    const child1 = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout1 = new EventEmitter();
    const stderr1 = new EventEmitter();
    const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child1, { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: vi.fn(), pid: 1 });

    // Second child: succeeds
    const child2 = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout2 = new EventEmitter();
    const stderr2 = new EventEmitter();
    const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child2, { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn(), pid: 2 });

    mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

    const promise = runClaude("test prompt", "/tmp");

    // First child fails with API 500
    stdout1.emit("data", Buffer.from(JSON.stringify({
      result: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      is_error: true,
      num_turns: 5,
    })));
    child1.emit("close", 1, null);

    // Allow microtask for retry to spawn second child
    await new Promise((r) => setTimeout(r, 0));

    // Second child succeeds
    stdout2.emit("data", Buffer.from(JSON.stringify({ result: "retry success", is_error: false })));
    child2.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("retry success");
    expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(2);
  });

  it("retries AgentCliError with socket closure error and succeeds", async () => {
    const spawnCountBefore = mockSpawn.mock.calls.length;

    // First child: fails with socket closure error (num_turns > 0)
    const child1 = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout1 = new EventEmitter();
    const stderr1 = new EventEmitter();
    const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child1, { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: vi.fn(), pid: 1 });

    // Second child: succeeds
    const child2 = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout2 = new EventEmitter();
    const stderr2 = new EventEmitter();
    const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child2, { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn(), pid: 2 });

    mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

    const promise = runClaude("test prompt", "/tmp");

    // First child fails with socket closure
    stdout1.emit("data", Buffer.from(JSON.stringify({
      result: 'API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      is_error: true,
      num_turns: 5,
    })));
    child1.emit("close", 1, null);

    // Allow microtask for retry to spawn second child
    await new Promise((r) => setTimeout(r, 0));

    // Second child succeeds
    stdout2.emit("data", Buffer.from(JSON.stringify({ result: "retry success", is_error: false })));
    child2.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("retry success");
    expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(2);
  });

  it("retries AgentCliError with a mid-response connection error and succeeds", async () => {
    const spawnCountBefore = mockSpawn.mock.calls.length;

    // First child: fails with mid-response connection error (num_turns > 0)
    const child1 = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout1 = new EventEmitter();
    const stderr1 = new EventEmitter();
    const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child1, { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: vi.fn(), pid: 1 });

    // Second child: succeeds
    const child2 = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout2 = new EventEmitter();
    const stderr2 = new EventEmitter();
    const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child2, { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn(), pid: 2 });

    mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

    const promise = runClaude("test prompt", "/tmp");

    // First child fails with mid-response connection error
    stdout1.emit("data", Buffer.from(JSON.stringify({
      result: "API Error: Connection closed mid-response. The response above may be incomplete.",
      is_error: true,
      num_turns: 5,
    })));
    child1.emit("close", 1, null);

    // Allow microtask for retry to spawn second child
    await new Promise((r) => setTimeout(r, 0));

    // Second child succeeds
    stdout2.emit("data", Buffer.from(JSON.stringify({ result: "retry success", is_error: false })));
    child2.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("retry success");
    expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(2);
  });

  it("does not retry transient API error during shutdown", async () => {
    mockShuttingDown = true;
    const spawnCountBefore = mockSpawn.mock.calls.length;

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({
      result: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      is_error: true,
      num_turns: 5,
    })));
    child.emit("close", 1, null);

    await expect(promise).rejects.toThrow(AgentCliError);
    // No retry during shutdown
    expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(1);
  });

  it("retries Codex AgentCliError with transient OpenAI 500 error and succeeds", async () => {
    setMockAiProviders(["codex"]);
    const spawnCountBefore = mockSpawn.mock.calls.length;
    try {
      // First child: Codex fails with OpenAI 500 error (stderr-based)
      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout1 = new EventEmitter();
      const stderr1 = new EventEmitter();
      const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child1, { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: vi.fn(), pid: 1 });

      // Second child: Codex succeeds
      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout2 = new EventEmitter();
      const stderr2 = new EventEmitter();
      const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child2, { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn(), pid: 2 });

      mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "codex" });
      await Promise.resolve();

      // First child fails with OpenAI 500 on stderr
      stderr1.emit("data", Buffer.from("openai error 500: Internal Server Error"));
      child1.emit("close", 1, null);

      // Allow microtask for retry to spawn second child
      await new Promise((r) => setTimeout(r, 0));

      // Second child succeeds
      stdout2.emit("data", Buffer.from("codex output"));
      child2.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("codex output");
      expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(2);
    } finally {
      resetMockAiProviders();
    }
  });

  it("rejects on spawn error", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    child.emit("error", new Error("spawn failed"));

    await expect(promise).rejects.toThrow("Failed to spawn claude");
  });

  it("rejects with cancellation error when cancelCurrentTask is called", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mockReaddir = vi.mocked(fs.readdirSync);
    const mockReadFile = vi.mocked(fs.readFileSync);
    const savedReaddir = mockReaddir.getMockImplementation();
    const savedReadFile = mockReadFile.getMockImplementation();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 12345,
      });

      // Mock /proc: grandchild PID 67890 with ppid 12345
      mockReaddir.mockImplementation(((p: unknown) =>
        p === "/proc" ? ["12345", "67890"] : []) as unknown as typeof fs.readdirSync);
      mockReadFile.mockImplementation(((p: unknown) => {
        if (p === "/proc/12345/stat") return "12345 (claude) S 1 0 0 0 -1 0 0 0";
        if (p === "/proc/67890/stat") return "67890 (sh) S 12345 0 0 0 -1 0 0 0";
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }) as unknown as typeof fs.readFileSync);

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test prompt", "/tmp");

      // Cancel while running
      const cancelled = cancelCurrentTask();
      expect(cancelled).toBe(true);

      // Tree-walk should kill grandchild before root
      expect(killSpy).toHaveBeenCalledWith(67890, "SIGTERM");
      expect(killMock).toHaveBeenCalledWith("SIGTERM");

      // Simulate process exit after SIGTERM
      child.emit("close", null, "SIGTERM");

      await expect(promise).rejects.toThrow("Task cancelled — shutting down");
      await expect(promise).rejects.toBeInstanceOf(ShutdownError);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      mockReaddir.mockImplementation(savedReaddir as any);
      mockReadFile.mockImplementation(savedReadFile as any);
      killSpy.mockRestore();
    }
  });

  it("cancelTaskByRunId kills only the specified runId's process tree", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mockReaddir = vi.mocked(fs.readdirSync);
    const mockReadFile = vi.mocked(fs.readFileSync);
    const savedReaddir = mockReaddir.getMockImplementation();
    const savedReadFile = mockReadFile.getMockImplementation();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      // Target process (PID 11111, runId "target-run")
      const targetChild = new EventEmitter() as ChildProcess & EventEmitter;
      const targetStdout = new EventEmitter();
      const targetKill = vi.fn();
      Object.assign(targetChild, {
        stdout: targetStdout,
        stderr: new EventEmitter(),
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
        kill: targetKill,
        pid: 11111,
      });

      // Other process (PID 22222, no runId — runContext returns undefined)
      const otherChild = new EventEmitter() as ChildProcess & EventEmitter;
      const otherStdout = new EventEmitter();
      const otherKill = vi.fn();
      Object.assign(otherChild, {
        stdout: otherStdout,
        stderr: new EventEmitter(),
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
        kill: otherKill,
        pid: 22222,
      });

      // Mock /proc: target has grandchild 33333; other process has no children
      mockReaddir.mockImplementation(((p: unknown) =>
        p === "/proc" ? ["11111", "22222", "33333"] : []) as unknown as typeof fs.readdirSync);
      mockReadFile.mockImplementation(((p: unknown) => {
        if (p === "/proc/11111/stat") return "11111 (claude) S 1 0 0 0 -1 0 0 0";
        if (p === "/proc/22222/stat") return "22222 (claude) S 1 0 0 0 -1 0 0 0";
        if (p === "/proc/33333/stat") return "33333 (sh) S 11111 0 0 0 -1 0 0 0";
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }) as unknown as typeof fs.readFileSync);

      // Spawn target under "target-run" context
      mockRunCtxId = "target-run";
      mockSpawn.mockReturnValue(targetChild as any);
      const targetPromise = runClaude("target prompt", "/tmp/target");

      // Spawn other process with no runId
      mockRunCtxId = undefined;
      mockSpawn.mockReturnValue(otherChild as any);
      const otherPromise = runClaude("other prompt", "/tmp/other");

      // Cancel only the target run
      const cancelled = cancelTaskByRunId("target-run");
      expect(cancelled).toBe(true);

      // Tree-walk kills grandchild 33333 then root 11111
      expect(killSpy).toHaveBeenCalledWith(33333, "SIGTERM");
      expect(targetKill).toHaveBeenCalledWith("SIGTERM");

      // Other process is untouched
      expect(killSpy).not.toHaveBeenCalledWith(22222, "SIGTERM");
      expect(otherKill).not.toHaveBeenCalled();

      // Simulate target exiting
      targetChild.emit("close", null, "SIGTERM");
      await expect(targetPromise).rejects.toBeInstanceOf(ShutdownError);

      // Clean up other process
      otherChild.emit("close", 0, null);
      await otherPromise.catch(() => {/* may reject due to no stdout */});
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      mockReaddir.mockImplementation(savedReaddir as any);
      mockReadFile.mockImplementation(savedReadFile as any);
      killSpy.mockRestore();
    }
  });

  it("rejects with shutdown message when killed by SIGTERM during shutdown", async () => {
    mockShuttingDown = true;
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    child.emit("close", null, "SIGTERM");

    await expect(promise).rejects.toThrow("Task cancelled — shutting down");
    await expect(promise).rejects.toBeInstanceOf(ShutdownError);
  });

  it("classifies a SIGKILL during shutdown as a shutdown, not an external kill", async () => {
    // kubelet's sequence is SIGTERM, then SIGKILL to the whole cgroup once
    // terminationGracePeriodSeconds (420s in the statefulset) expires. An agent
    // still alive at that point closes with SIGKILL while isShuttingDown() is
    // already true; calling that `external-kill` files a [claws-error] issue
    // telling the operator to go hunt for OOMKilled pod events after what was a
    // routine rollout.
    mockShuttingDown = true;
    try {
      const child = makeMockChild(9204);
      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test", "/tmp");
      child.stderr.emit("data", Buffer.from("killed"));
      child.emit("close", null, "SIGKILL");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShutdownError);
      expect(err).not.toBeInstanceOf(AgentExternalKillError);
    } finally {
      mockShuttingDown = false;
    }
  });

  it("rejects when killed by signal (not via cancelCurrentTask)", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test", "/tmp");
      const settled = promise.catch((e: unknown) => e);
      stdoutEmitter.emit("data", Buffer.from("partial"));
      stderrEmitter.emit("data", Buffer.from("some error"));
      child.emit("close", null, "SIGTERM");
      // A SIGTERM is only classified as an external kill once the shutdown flag
      // has had its grace window to catch up.
      await vi.advanceTimersByTimeAsync(EXTERNAL_SIGTERM_SHUTDOWN_GRACE_MS);

      const err = await settled;
      expect(err).toBeInstanceOf(AgentExternalKillError);
      expect((err as AgentExternalKillError).signal).toBe("SIGTERM");
      expect((err as AgentExternalKillError).outputBytes).toBe("partial".length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a SIGTERM that races setShuttingDown() as a shutdown, not an external kill", async () => {
    // systemd/kubelet SIGTERM the whole cgroup at once, so the child can close
    // before setShuttingDown() runs. Classifying that as external-kill records a
    // spurious failure category and burns a work-queue attempt, instead of
    // leaving the row 'running' for recoverWorkOnStartup().
    vi.useFakeTimers();
    try {
      const child = makeMockChild(9501);
      mockSpawn.mockReturnValue(child as any);

      const settled = runClaude("test", "/tmp").catch((e: unknown) => e);
      child.emit("close", null, "SIGTERM");
      // The flag lands inside the grace window, exactly as it does on a rollout.
      mockShuttingDown = true;
      await vi.advanceTimersByTimeAsync(EXTERNAL_SIGTERM_SHUTDOWN_GRACE_MS);

      expect(await settled).toBeInstanceOf(ShutdownError);
    } finally {
      mockShuttingDown = false;
      vi.useRealTimers();
    }
  });

  it("serializes two capped runs whose cap exceeds the agent lane, through the solo escape hatch", async () => {
    // A 4 GiB cap under a 4.5 GiB budget does *not* serialize by lane
    // arithmetic: the 768 MiB auxiliary carve-out leaves a 3840 MiB agent lane,
    // so each 4096 MiB run is wider than its own lane and is admitted only with
    // the whole gate empty. Asserting the reservation numbers rather than a
    // spawn count is what keeps this test honest about which mechanism ran.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * 1024 * 1024 * 1024;
    mockMemoryConfig.sharedBudgetBytes = 4.5 * 1024 * 1024 * 1024;
    try {
      const first = makeMockChild(9301);
      const second = makeMockChild(9302);
      mockSpawn.mockReturnValueOnce(first as any).mockReturnValueOnce(second as any);

      const firstPromise = runClaude("first", "/tmp/one");
      const secondPromise = runClaude("second", "/tmp/two");
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(agentMemoryAdmissionStatus()).toMatchObject({
        active: true,
        budgetBytes: 4.5 * 1024 * 1024 * 1024,
        auxiliaryBudgetBytes: AUXILIARY_AGENT_ADMISSION_BYTES,
        reservedBytes: 4 * 1024 * 1024 * 1024,
        admitted: 1,
        waiting: 1,
      });
      expect(logModule.info).toHaveBeenCalledWith(expect.stringContaining("waiting for agent memory budget"));
      expect(logModule.info).toHaveBeenCalledWith(expect.stringContaining("single run exceeds its lane budget"));

      first.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      first.emit("close", 0, null);
      await firstPromise;
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      expect(agentMemoryAdmissionStatus()).toMatchObject({ reservedBytes: 4 * 1024 * 1024 * 1024, admitted: 1, waiting: 0 });
      expect(logModule.info).toHaveBeenCalledWith(expect.stringContaining("acquired agent memory budget after"));

      second.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      second.emit("close", 0, null);
      await secondPromise;
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("admits an auxiliary bookkeeping call past a full agent lane with a queued implementer", async () => {
    // The deployed k8s shape: 10 GiB container, 1.25 GiB headroom -> 8960 MiB
    // budget, 4 GiB cap, so the agent lane is exactly two full-cap runs. With a
    // third implementer already queued, a single FIFO would park the
    // PR-description call behind a multi-hour run even though its 768 MiB are
    // free — the auxiliary lane is what stops that.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * 1024 * 1024 * 1024;
    mockMemoryConfig.headroomBytes = DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES;
    mockMemoryConfig.sharedBudgetBytes = 10 * 1024 * 1024 * 1024 - DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES;
    try {
      const first = makeMockChild(9601);
      const second = makeMockChild(9602);
      const auxiliary = makeMockChild(9603);
      // The fourth child is provisioned explicitly: once the ...Once queue is
      // exhausted mockSpawn falls back to whatever standing implementation an
      // earlier test installed, and vitest auto-clear does not reset
      // implementations — so reaching into mock.results[3] would drive a child
      // another test already closed.
      const third = makeMockChild(9604);
      mockSpawn
        .mockReturnValueOnce(first as any)
        .mockReturnValueOnce(second as any)
        .mockReturnValueOnce(auxiliary as any)
        .mockReturnValueOnce(third as any);

      const firstPromise = runClaude("implementer", "/tmp/one");
      const secondPromise = runClaude("implementer", "/tmp/two");
      const blockedPromise = runClaude("implementer", "/tmp/three");
      const blockedSettled = blockedPromise.catch((e: unknown) => e);
      await flushMicrotasks();
      // Both full-cap runs fit the agent lane; the third does not.
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      const auxPromise = runClaude("bookkeeping", "/tmp/aux", { tier: "sonnet", admissionBytes: AUXILIARY_AGENT_ADMISSION_BYTES });
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(3);

      for (const [child, promise] of [[auxiliary, auxPromise], [first, firstPromise]] as const) {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
        child.emit("close", 0, null);
        await promise;
      }
      // Releasing an implementer is what finally admits the queued third run.
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(4);
      third.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      third.emit("close", 0, null);
      await blockedSettled;

      second.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      second.emit("close", 0, null);
      await secondPromise;
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("puts a short, text-only call in the auxiliary lane without an explicit annotation", async () => {
    // Deriving the class rather than enumerating it is what keeps the next
    // short runClaude() call a job adds from reserving (and being capped at)
    // the full agent cap.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * 1024 * 1024 * 1024;
    mockMemoryConfig.headroomBytes = DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES;
    mockMemoryConfig.sharedBudgetBytes = 10 * 1024 * 1024 * 1024 - DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES;
    try {
      const a = makeMockChild(9701);
      const b = makeMockChild(9702);
      const short = makeMockChild(9703);
      const third = makeMockChild(9704);
      mockSpawn
        .mockReturnValueOnce(a as any)
        .mockReturnValueOnce(b as any)
        .mockReturnValueOnce(short as any)
        .mockReturnValueOnce(third as any);

      const aPromise = runClaude("implementer", "/tmp/one");
      const bPromise = runClaude("implementer", "/tmp/two");
      const blocked = runClaude("implementer", "/tmp/three");
      const blockedSettled = blocked.catch((e: unknown) => e);
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      // A 60s session-summary style call: no admissionBytes anywhere.
      const shortPromise = runClaude("summarise", "/tmp/short", { tier: "sonnet", timeoutMs: 60_000 });
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(3);

      short.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      short.emit("close", 0, null);
      await shortPromise;

      for (const [child, promise] of [[a, aPromise], [b, bPromise]] as const) {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
        child.emit("close", 0, null);
        await promise;
      }
      await flushMicrotasks();
      third.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      third.emit("close", 0, null);
      await blockedSettled;
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });


  it("reserves and caps a run at its raised memoryMaxBytes, not at the global cap", async () => {
    // The per-call browser cap has to reach admission, not just the watchdog:
    // a 4 GiB run that reserves the 2 GiB global cap lets two of them overlap
    // inside a budget that only fits one.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 2 * GIB;
    mockMemoryConfig.sharedBudgetBytes = 5 * GIB;
    try {
      const raised = makeMockChild(9111);
      const plain = makeMockChild(9112);
      mockSpawn.mockReturnValueOnce(raised as any).mockReturnValueOnce(plain as any);

      const raisedPromise = runClaude("browser", "/tmp/one", { tier: "sonnet", memoryMaxBytes: 4 * GIB });
      await flushMicrotasks();
      expect(agentMemoryAdmissionStatus()).toMatchObject({ reservedBytes: 4 * GIB, admitted: 1, waiting: 0 });

      // The agent lane is 5 GiB - 768 MiB = 4352 MiB, so the raised 4 GiB run
      // plus a genuinely ordinary (no override) 2 GiB run still does not fit
      // alongside it (4096 + 2048 > 4352), so the second one queues.
      const plainPromise = runClaude("browser", "/tmp/two", { tier: "sonnet" });
      const queuedSettled = plainPromise.catch((e: unknown) => e);
      await flushMicrotasks();
      expect(agentMemoryAdmissionStatus()).toMatchObject({ reservedBytes: 4 * GIB, waiting: 1 });
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      raised.stdout.emit("data", Buffer.from(OK_JSON));
      raised.emit("close", 0, null);
      await raisedPromise;
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      // ...and the ordinary run reserves only the global cap, not the raised
      // 4 GiB the first run asked for.
      expect(agentMemoryAdmissionStatus()).toMatchObject({ reservedBytes: 2 * GIB });

      plain.stdout.emit("data", Buffer.from(OK_JSON));
      plain.emit("close", 0, null);
      expect(await queuedSettled).toBe("ok");
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("classifies workload scale from footprint evidence, not from a partial deny-list", async () => {
    // The class sets an enforced watchdog cap, so a misclassification kills a
    // real agent run at 768 MiB. reservedBytes *is* the enforced cap here —
    // computeRunCapBytes feeds both numbers — so asserting it pins the lane and
    // the kill threshold at once.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * GIB;
    mockMemoryConfig.sharedBudgetBytes = 8960 * MIB;
    try {
      // A 10-minute timeout is the boundary: auxiliary at the limit, agent-scale
      // one millisecond past it (shopping-comment-processor sits at 5 min).
      expect(await reservedBytesFor({ tier: "sonnet", timeoutMs: AUXILIARY_AGENT_MAX_TIMEOUT_MS })).toBe(AUXILIARY_AGENT_ADMISSION_BYTES);
      expect(await reservedBytesFor({ tier: "sonnet", timeoutMs: AUXILIARY_AGENT_MAX_TIMEOUT_MS + 1 })).toBe(4 * GIB);

      // A raised per-call cap is a call site asking for more memory, not less.
      expect(await reservedBytesFor({ tier: "sonnet", timeoutMs: 60_000, memoryMaxBytes: 6 * GIB })).toBe(6 * GIB);

      // admissionBytes: 0 opts a short-looking run back into agent scale.
      expect(await reservedBytesFor({ tier: "sonnet", timeoutMs: 60_000, admissionBytes: 0 })).toBe(4 * GIB);

      // A full text-only deny-list leaves the run no way to pull anything in,
      // whatever its timeout says (email-monitor, whatsapp-handler).
      expect(await reservedBytesFor({ tier: "sonnet", disallowedTools: TEXT_ONLY_DISALLOWED_TOOLS })).toBe(AUXILIARY_AGENT_ADMISSION_BYTES);

      // shopping-sourcer on the shared-browser path: a 20-minute Playwright-MCP
      // run whose deny-list only covers the repo-mutating tools. Deriving the
      // class from that deny-list capped it at 768 MiB (#3168 review).
      expect(await reservedBytesFor({
        tier: "sonnet",
        mcpConfig: "/tmp/mcp.json",
        timeoutMs: 20 * 60_000,
        disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Task"],
      })).toBe(4 * GIB);

      // An MCP server disqualifies on its own: its process tree cannot be sized
      // from the prompt, however short the call is.
      expect(await reservedBytesFor({ tier: "sonnet", mcpConfig: "/tmp/mcp.json", timeoutMs: 60_000 })).toBe(4 * GIB);

      // A bytes-vs-MiB slip at a call site must not become a 64-byte kill threshold.
      expect(await reservedBytesFor({ tier: "sonnet", admissionBytes: 64 })).toBe(MIN_PLAUSIBLE_AGENT_MEMORY_BYTES);
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("clamps a declared auxiliary slice to the auxiliary lane on a small budget", async () => {
    // The lane is min(768 MiB, budget/2), so on a 1 GiB budget a full 768 MiB
    // slice would exceed its own lane and take the solo hatch on every
    // bookkeeping call — the head-of-line blocking the lane exists to remove.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * GIB;
    mockMemoryConfig.sharedBudgetBytes = GIB;
    try {
      expect(await reservedBytesFor({ tier: "sonnet", admissionBytes: AUXILIARY_AGENT_ADMISSION_BYTES })).toBe(512 * MIB);
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("leaves the global cap alone for an auxiliary-shaped run when admission is inactive", async () => {
    // No cgroup limit and no explicit budget (dev boxes, the systemd host):
    // nothing is reserved and nothing is protected, so cutting the watchdog to
    // 768 MiB would be a pure regression. 1 GiB of RSS must not be killed.
    vi.useFakeTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mockReaddir = vi.mocked(fs.readdirSync);
    const mockReadFile = vi.mocked(fs.readFileSync);
    const savedReaddir = mockReaddir.getMockImplementation();
    const savedReadFile = mockReadFile.getMockImplementation();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * GIB;
    mockMemoryConfig.sharedBudgetBytes = undefined;
    try {
      const child = makeMockChild(77778);
      mockSpawn.mockReturnValueOnce(child as any);
      mockReaddir.mockImplementation(((dir: unknown) =>
        dir === "/proc" ? ["77778"] : []) as unknown as typeof fs.readdirSync);
      mockReadFile.mockImplementation(((file: unknown) => {
        if (file === "/proc/77778/stat") return "77778 (node) S 1 0 0 0 -1 0 0 0";
        if (file === "/proc/77778/status") return "VmRSS:\t1048576 kB\n";
        throw enoent(String(file));
      }) as unknown as typeof fs.readFileSync);

      const promise = runClaude("bookkeeping", "/tmp/aux", { tier: "sonnet", timeoutMs: 60_000 });
      child.stdout.emit("data", Buffer.from(OK_JSON));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(killSpy).not.toHaveBeenCalled();
      child.emit("close", 0, null);
      await expect(promise).resolves.toBe("ok");
    } finally {
      Object.assign(mockMemoryConfig, restore);
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      mockReaddir.mockImplementation(savedReaddir as any);
      mockReadFile.mockImplementation(savedReadFile as any);
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("derives the shared budget from the cgroup limit when none is configured", async () => {
    // The deployed configuration: CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES
    // unset, budget = containerLimit - headroom. Every other admission test
    // hand-feeds a budget, so this is the only one that crosses cgroup read ->
    // policy -> gate end to end.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * GIB;
    mockMemoryConfig.sharedBudgetBytes = undefined;
    const mockReadFile = vi.mocked(fs.readFileSync);
    const savedReadFile = mockReadFile.getMockImplementation();
    try {
      mockReadFile.mockImplementation(((file: unknown) => {
        if (String(file) === "/sys/fs/cgroup/memory.max") return "6442450944\n";
        throw enoent(String(file));
      }) as unknown as typeof fs.readFileSync);
      resetCgroupLimitCacheForTests();

      const first = makeMockChild(9121);
      const second = makeMockChild(9122);
      mockSpawn.mockReturnValueOnce(first as any).mockReturnValueOnce(second as any);

      const firstPromise = runClaude("first", "/tmp/one");
      const secondPromise = runClaude("second", "/tmp/two");
      await flushMicrotasks();
      expect(agentMemoryAdmissionStatus()).toMatchObject({
        active: true,
        budgetBytes: 6 * GIB - DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES,
        reservedBytes: 4 * GIB,
        admitted: 1,
        waiting: 1,
      });
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      first.stdout.emit("data", Buffer.from(OK_JSON));
      first.emit("close", 0, null);
      await firstPromise;
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

      second.stdout.emit("data", Buffer.from(OK_JSON));
      second.emit("close", 0, null);
      await secondPromise;
    } finally {
      mockReadFile.mockImplementation(savedReadFile as any);
      resetCgroupLimitCacheForTests();
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("cancelCurrentTask rejects a run still waiting for memory admission", async () => {
    // cancelCurrentTask() drains a different set from cancelTaskByRunId(), and
    // it is the one /cancel and the shutdown path actually call.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * GIB;
    mockMemoryConfig.sharedBudgetBytes = 8960 * MIB;
    try {
      const first = makeMockChild(9131);
      const second = makeMockChild(9132);
      mockSpawn.mockReturnValueOnce(first as any).mockReturnValueOnce(second as any);

      const firstPromise = runClaude("first", "/tmp/one").catch((e: unknown) => e);
      const secondPromise = runClaude("second", "/tmp/two").catch((e: unknown) => e);
      const waitingSettled = runClaude("waiting", "/tmp/three").catch((e: unknown) => e);
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(agentMemoryAdmissionStatus().waiting).toBe(1);

      expect(cancelCurrentTask()).toBe(true);
      expect(await waitingSettled).toBeInstanceOf(ShutdownError);
      expect(agentMemoryAdmissionStatus().waiting).toBe(0);

      for (const child of [first, second]) child.emit("close", null, "SIGTERM");
      await firstPromise;
      await secondPromise;
      // The cancelled waiter must not be resurrected by those releases.
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("carries the run's admission numbers on an external kill", async () => {
    // error-reporter builds these errors by hand in its own tests, so this is
    // the only place that proves runCliProcess populates them.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * GIB;
    mockMemoryConfig.sharedBudgetBytes = 8960 * MIB;
    try {
      const child = makeMockChild(9151);
      mockSpawn.mockReturnValueOnce(child as any);

      const settled = runClaude("first", "/tmp/one").catch((e: unknown) => e);
      await flushMicrotasks();
      child.emit("close", null, "SIGKILL");

      const err = await settled;
      expect(err).toBeInstanceOf(AgentExternalKillError);
      const killErr = err as AgentExternalKillError;
      expect(killErr.reservedBytes).toBe(4 * GIB);
      expect(killErr.sharedBudgetBytes).toBe(8960 * MIB);
      expect(killErr.headroomBytes).toBe(mockMemoryConfig.headroomBytes);
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("rejects a run admitted after shutdown began instead of spawning it", async () => {
    // shutdown() sets the flag, then drains the scheduler for up to 300s before
    // cancelCurrentTask() runs. Inside that window the holder can close
    // naturally and admit the waiter, which must not spawn a fresh multi-hour
    // CLI onto a terminating pod.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * 1024 * 1024 * 1024;
    mockMemoryConfig.sharedBudgetBytes = 4.5 * 1024 * 1024 * 1024;
    try {
      const first = makeMockChild(9801);
      mockSpawn.mockReturnValueOnce(first as any);

      const firstPromise = runClaude("first", "/tmp/one");
      const waitingSettled = runClaude("waiting", "/tmp/two").catch((e: unknown) => e);
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      mockShuttingDown = true;
      first.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      first.emit("close", 0, null);
      await firstPromise;
      await flushMicrotasks();

      expect(await waitingSettled).toBeInstanceOf(ShutdownError);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      mockShuttingDown = false;
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("releases the reservation when the child fails to spawn, so a queued run is still admitted", async () => {
    // A leaked reservation wedges the queue permanently, and release() sits on
    // three separate paths — the child 'error' path is the one with no close event.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * 1024 * 1024 * 1024;
    mockMemoryConfig.sharedBudgetBytes = 4.5 * 1024 * 1024 * 1024;
    try {
      const first = makeMockChild(9401);
      const second = makeMockChild(9402);
      mockSpawn.mockReturnValueOnce(first as any).mockReturnValueOnce(second as any);

      const firstSettled = runClaude("first", "/tmp/one").catch((e: unknown) => e);
      const secondPromise = runClaude("second", "/tmp/two");
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      first.emit("error", enoent("claude"));
      expect(String(await firstSettled)).toContain("CLI not found");
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      second.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      second.emit("close", 0, null);
      await secondPromise;
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("reserves a full budget slot for uncapped runs so shared admission still serializes them", async () => {
    // Watchdog disabled but an explicit shared budget keeps aggregate admission
    // on — two ordinary (uncapped) runs must not overlap.
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 0;
    mockMemoryConfig.sharedBudgetBytes = 3 * 1024 * 1024 * 1024;
    try {
      const first = makeMockChild(9001);
      const second = makeMockChild(9002);
      mockSpawn.mockReturnValueOnce(first as any).mockReturnValueOnce(second as any);

      const firstPromise = runClaude("first", "/tmp/one");
      const secondPromise = runClaude("second", "/tmp/two");
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      first.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      first.emit("close", 0, null);
      await firstPromise;
      // Depth-independent: the release -> drain -> waiter -> spawn chain is
      // several ticks deep and its depth is an implementation detail.
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

      second.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      second.emit("close", 0, null);
      await secondPromise;
    } finally {
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("cancelTaskByRunId rejects a run still waiting for memory admission without spawning it", async () => {
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 0;
    mockMemoryConfig.sharedBudgetBytes = 3 * 1024 * 1024 * 1024 + 1;
    try {
      const first = makeMockChild(9101);
      mockSpawn.mockReturnValueOnce(first as any);

      mockRunCtxId = "holder-run";
      const firstPromise = runClaude("first", "/tmp/one");
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      mockRunCtxId = "waiting-run";
      const waitingPromise = runClaude("waiting", "/tmp/two");
      const waitingSettled = waitingPromise.catch((err: unknown) => err);
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      expect(cancelTaskByRunId("waiting-run")).toBe(true);
      const err = await waitingSettled;
      expect(err).toBeInstanceOf(ShutdownError);
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // Releasing the holder must not resurrect the cancelled waiter.
      mockRunCtxId = "holder-run";
      first.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      first.emit("close", 0, null);
      await firstPromise;
      await flushMicrotasks();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      mockRunCtxId = undefined;
      Object.assign(mockMemoryConfig, restore);
    }
  });

  it("cancelCurrentTask returns false when no process is active", () => {
    expect(cancelCurrentTask()).toBe(false);
  });

  it("rejects with AgentTimeoutError carrying diagnostics when process times out", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 12345,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test prompt", "/tmp/test-cwd");

      // Emit some output before timeout (clears liveness timer)
      stdoutEmitter.emit("data", Buffer.from("partial work output"));
      stderrEmitter.emit("data", Buffer.from("some stderr"));

      // Advance past the timeout (20 min)
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      // Process exits after SIGTERM
      child.emit("close", null, "SIGTERM");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentTimeoutError);
      const timeoutErr = err as AgentTimeoutError;
      expect(timeoutErr.message).toContain("timed out after 20m");
      expect(timeoutErr.outputBytes).toBe("partial work output".length);
      expect(timeoutErr.lastOutput).toBe("partial work output");
      expect(timeoutErr.lastStderr).toBe("some stderr");
      expect(timeoutErr.cwd).toBe("/tmp/test-cwd");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts early with liveness timeout when process produces 0 bytes", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 99999,
      });

      mockSpawn.mockReturnValue(child as any);

      // runClaude wraps with retry — use two children, both will hang
      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter2 = new EventEmitter();
      const stderrEmitter2 = new EventEmitter();
      const stdinMock2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock2 = vi.fn();
      Object.assign(child2, {
        stdout: stdoutEmitter2,
        stderr: stderrEmitter2,
        stdin: stdinMock2,
        kill: killMock2,
        pid: 99998,
      });

      mockSpawn.mockReturnValueOnce(child as any).mockReturnValueOnce(child2 as any);

      const promise = runClaude("test prompt", "/tmp/test-cwd");

      // Advance 10 minutes — liveness timer fires (no output produced)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(killMock).toHaveBeenCalledWith("SIGTERM");

      // Process exits after SIGTERM
      child.emit("close", null, "SIGTERM");

      // Retry happens — advance liveness for second attempt too
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(killMock2).toHaveBeenCalledWith("SIGTERM");
      child2.emit("close", null, "SIGTERM");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentTimeoutError);
      const timeoutErr = err as AgentTimeoutError;
      // Liveness timeout (10 min = 600000ms), not the full 20 min timeout
      expect(timeoutErr.message).toContain("timed out after 10m");
      expect(timeoutErr.outputBytes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears liveness timer on first stdout output", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 12345,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test prompt", "/tmp");

      // Emit output at 9 minutes (before 10 min liveness threshold)
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
      stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "some output", is_error: false })));

      // Advance to 10 minutes — liveness timer should NOT fire
      await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
      expect(killMock).not.toHaveBeenCalled();

      // Complete normally
      child.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("some output");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries once on 0-byte timeout and succeeds", async () => {
    vi.useFakeTimers();
    try {
      const spawnCountBefore = mockSpawn.mock.calls.length;

      // First child: hangs with 0 output
      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout1 = new EventEmitter();
      const stderr1 = new EventEmitter();
      const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const kill1 = vi.fn();
      Object.assign(child1, { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: kill1, pid: 1 });

      // Second child: succeeds
      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout2 = new EventEmitter();
      const stderr2 = new EventEmitter();
      const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child2, { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn(), pid: 2 });

      mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

      const promise = runClaude("test prompt", "/tmp");

      // Liveness timeout fires on first child
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      child1.emit("close", null, "SIGTERM");

      // Second child produces output and finishes
      await vi.advanceTimersByTimeAsync(0);
      stdout2.emit("data", Buffer.from(JSON.stringify({ result: "success output", is_error: false })));
      child2.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("success output");
      expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry when timeout occurs with non-zero output", async () => {
    vi.useFakeTimers();
    try {
      const spawnCountBefore = mockSpawn.mock.calls.length;

      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 12345,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test prompt", "/tmp");

      // Emit some output so this is a non-0-byte timeout
      stdoutEmitter.emit("data", Buffer.from("partial work"));

      // Advance to full timeout
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      child.emit("close", null, "SIGTERM");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentTimeoutError);
      // spawn called only once — no retry
      expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with AgentMemoryLimitError when process tree exceeds the memory limit", async () => {
    vi.useFakeTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mockReaddir = vi.mocked(fs.readdirSync);
    const mockReadFile = vi.mocked(fs.readFileSync);
    const savedReaddir = mockReaddir.getMockImplementation();
    const savedReadFile = mockReadFile.getMockImplementation();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 55555,
      });

      mockSpawn.mockReturnValue(child as any);

      const spawnCountBefore = mockSpawn.mock.calls.length;

      // Mock /proc: root 55555 plus grandchild 66666 (ppid 55555).
      // VmRSS 2400000 kB = 2.29 GiB > 1.5 GiB limit.
      mockReaddir.mockImplementation(((p: unknown) =>
        p === "/proc" ? ["55555", "66666"] : []) as unknown as typeof fs.readdirSync);
      mockReadFile.mockImplementation(((p: unknown) => {
        if (p === "/proc/55555/stat") return "55555 (node) S 1 0 0 0 -1 0 0 0";
        if (p === "/proc/66666/stat") return "66666 (sh) S 55555 0 0 0 -1 0 0 0";
        if (p === "/proc/55555/status") return "VmRSS:\t2400000 kB\n";
        if (p === "/proc/66666/status") return "VmRSS:\t1000 kB\n";
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }) as unknown as typeof fs.readFileSync);

      const promise = runClaude("test prompt", "/tmp/test-cwd");

      // Emit stdout to clear the liveness timer
      stdoutEmitter.emit("data", Buffer.from("some output"));

      // Advance 15s — memory watchdog interval fires
      await vi.advanceTimersByTimeAsync(15_000);

      // Process tree is SIGKILL'd by watchdog; simulate exit
      child.emit("close", null, "SIGKILL");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentMemoryLimitError);
      const memErr = err as AgentMemoryLimitError;
      // 2400000 kB + 1000 kB = 2401000 kB total, * 1024 bytes/kB
      expect(memErr.observedRssBytes).toBe(2_401_000 * 1024);
      expect(memErr.limitBytes).toBe(1_610_612_736);
      expect(memErr.outputBytes).toBe("some output".length);
      expect(memErr.cwd).toBe("/tmp/test-cwd");

      // Grandchild killed before root
      expect(killSpy).toHaveBeenCalledWith(66666, "SIGKILL");
      expect(killMock).toHaveBeenCalledWith("SIGKILL");

      // Not retried — spawn called exactly once
      expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      mockReaddir.mockImplementation(savedReaddir as any);
      mockReadFile.mockImplementation(savedReadFile as any);
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("caps an auxiliary run at its declared slice, not at the global cap", async () => {
    // The reservation is only a real bound on container RSS if the watchdog
    // holds the run to it: a 768 MiB reservation that may grow to the 4 GiB cap
    // over-commits the pod and surfaces later as an external-kill. The smaller
    // cap exists *because* of admission, so the budget has to be on for it to
    // apply — see the "leaves the global cap alone" case below.
    vi.useFakeTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mockReaddir = vi.mocked(fs.readdirSync);
    const mockReadFile = vi.mocked(fs.readFileSync);
    const savedReaddir = mockReaddir.getMockImplementation();
    const savedReadFile = mockReadFile.getMockImplementation();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const restore = { ...mockMemoryConfig };
    mockMemoryConfig.maxBytes = 4 * 1024 * 1024 * 1024;
    mockMemoryConfig.sharedBudgetBytes = 8960 * 1024 * 1024;
    try {
      const child = makeMockChild(77777);
      mockSpawn.mockReturnValue(child as any);

      // 1 GiB of RSS: comfortably under the 4 GiB global cap, over the slice.
      mockReaddir.mockImplementation(((dir: unknown) =>
        dir === "/proc" ? ["77777"] : []) as unknown as typeof fs.readdirSync);
      mockReadFile.mockImplementation(((file: unknown) => {
        if (file === "/proc/77777/stat") return "77777 (node) S 1 0 0 0 -1 0 0 0";
        if (file === "/proc/77777/status") return "VmRSS:\t1048576 kB\n";
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }) as unknown as typeof fs.readFileSync);

      const promise = runClaude("bookkeeping", "/tmp/aux", {
        tier: "sonnet",
        admissionBytes: AUXILIARY_AGENT_ADMISSION_BYTES,
      });
      child.stdout.emit("data", Buffer.from("some output"));
      await vi.advanceTimersByTimeAsync(15_000);
      child.emit("close", null, "SIGKILL");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentMemoryLimitError);
      const memErr = err as AgentMemoryLimitError;
      expect(memErr.limitBytes).toBe(AUXILIARY_AGENT_ADMISSION_BYTES);
      // The operator comment is the whole point of the diagnostics: assert
      // runCliProcess actually populates them, not just that the kill happened.
      expect(memErr.sharedBudgetBytes).toBe(8960 * 1024 * 1024);
      expect(memErr.headroomBytes).toBe(mockMemoryConfig.headroomBytes);
    } finally {
      Object.assign(mockMemoryConfig, restore);
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      mockReaddir.mockImplementation(savedReaddir as any);
      mockReadFile.mockImplementation(savedReadFile as any);
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("honours a per-call memoryMaxBytes override", async () => {
    vi.useFakeTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mockReaddir = vi.mocked(fs.readdirSync);
    const mockReadFile = vi.mocked(fs.readFileSync);
    const savedReaddir = mockReaddir.getMockImplementation();
    const savedReadFile = mockReadFile.getMockImplementation();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 55555,
      });

      mockSpawn.mockReturnValue(child as any);

      const spawnCountBefore = mockSpawn.mock.calls.length;

      // Mock /proc: root 55555 plus grandchild 66666 (ppid 55555).
      // VmRSS 2400000 kB + 1000 kB = 2.29 GiB, still over the 2 GiB override.
      mockReaddir.mockImplementation(((p: unknown) =>
        p === "/proc" ? ["55555", "66666"] : []) as unknown as typeof fs.readdirSync);
      mockReadFile.mockImplementation(((p: unknown) => {
        if (p === "/proc/55555/stat") return "55555 (node) S 1 0 0 0 -1 0 0 0";
        if (p === "/proc/66666/stat") return "66666 (sh) S 55555 0 0 0 -1 0 0 0";
        if (p === "/proc/55555/status") return "VmRSS:\t2400000 kB\n";
        if (p === "/proc/66666/status") return "VmRSS:\t1000 kB\n";
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }) as unknown as typeof fs.readFileSync);

      const promise = runClaude("test prompt", "/tmp/test-cwd", {
        tier: "sonnet",
        memoryMaxBytes: 2_147_483_648,
      });

      // Emit stdout to clear the liveness timer
      stdoutEmitter.emit("data", Buffer.from("some output"));

      // Advance 15s — memory watchdog interval fires
      await vi.advanceTimersByTimeAsync(15_000);

      // Process tree is SIGKILL'd by watchdog; simulate exit
      child.emit("close", null, "SIGKILL");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentMemoryLimitError);
      const memErr = err as AgentMemoryLimitError;
      // The override (2_147_483_648) is higher than the mocked global
      // (1_610_612_736) so it must be the effective limit reported.
      expect(memErr.limitBytes).toBe(2_147_483_648);

      // Grandchild killed before root
      expect(killSpy).toHaveBeenCalledWith(66666, "SIGKILL");
      expect(killMock).toHaveBeenCalledWith("SIGKILL");

      // Not retried — spawn called exactly once
      expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      mockReaddir.mockImplementation(savedReaddir as any);
      mockReadFile.mockImplementation(savedReadFile as any);
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects with ShutdownError when memory watchdog fires during shutdown", async () => {
    vi.useFakeTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mockReaddir = vi.mocked(fs.readdirSync);
    const mockReadFile = vi.mocked(fs.readFileSync);
    const savedReaddir = mockReaddir.getMockImplementation();
    const savedReadFile = mockReadFile.getMockImplementation();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockShuttingDown = true;
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 55555,
      });

      mockSpawn.mockReturnValue(child as any);

      // Mock /proc: root 55555, VmRSS well above the limit.
      mockReaddir.mockImplementation(((p: unknown) =>
        p === "/proc" ? ["55555"] : []) as unknown as typeof fs.readdirSync);
      mockReadFile.mockImplementation(((p: unknown) => {
        if (p === "/proc/55555/stat") return "55555 (node) S 1 0 0 0 -1 0 0 0";
        if (p === "/proc/55555/status") return "VmRSS:\t2400000 kB\n";
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }) as unknown as typeof fs.readFileSync);

      const promise = runClaude("test prompt", "/tmp/test-cwd");

      stdoutEmitter.emit("data", Buffer.from("some output"));

      // Advance 15s — memory watchdog fires while shutting down
      await vi.advanceTimersByTimeAsync(15_000);

      // Watchdog SIGKILLs; simulate exit
      child.emit("close", null, "SIGKILL");

      const err = await promise.catch((e: unknown) => e);
      // During shutdown the watchdog path must resolve as ShutdownError, not AgentMemoryLimitError
      expect(err).toBeInstanceOf(ShutdownError);
      expect(err).not.toBeInstanceOf(AgentMemoryLimitError);
    } finally {
      mockShuttingDown = false;
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      mockReaddir.mockImplementation(savedReaddir as any);
      mockReadFile.mockImplementation(savedReadFile as any);
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("handles stdin error gracefully", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinEmitter = new EventEmitter();
    Object.assign(stdinEmitter, { write: vi.fn(), end: vi.fn() });

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinEmitter,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp");

    // Emit stdin error — should be handled gracefully
    stdinEmitter.emit("error", new Error("pipe broken"));

    // Process still completes normally
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "output", is_error: false })));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("output");
  });

  it("dispatches to codex when provider is codex", async () => {
    setMockAiProviders(["codex"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
      });

      mockSpawn.mockReturnValue(child as any);

      // An explicit provider+model pin is honoured on the first attempt (isFirstTryWithExplicitModel),
      // so the explicit model is used as-is instead of being re-derived from tier.
      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "codex", model: "gpt-5.1-codex-max" });
      await Promise.resolve();

      expect(mockSpawn).toHaveBeenCalledWith(
        "codex",
        ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--json", "-m", "gpt-5.1-codex-max"],
        expect.objectContaining({ cwd: "/tmp" }),
      );

      stdoutEmitter.emit("data", Buffer.from(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex output text" } }) + "\n",
      ));
      child.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("codex output text");
      expect(stdinMock.write).toHaveBeenCalledWith(expect.stringContaining("test prompt"));
      expect(stdinMock.end).toHaveBeenCalled();
    } finally {
      resetMockAiProviders();
    }
  });

  it("omits -m for codex when validation resolves to the CLI default", async () => {
    setMockAiProviders(["codex"]);
    try {
      vi.mocked(resolveCodexModelForAttempt).mockResolvedValueOnce("");
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
      mockSpawn.mockReturnValue(child as any);

      const onAttemptModelUsed = vi.fn();
      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "codex", model: "gpt-5", onAttemptModelUsed });
      await Promise.resolve();

      const spawnArgs = mockSpawn.mock.calls.at(-1)?.[1] as string[];
      expect(spawnArgs).not.toContain("-m");
      expect(onAttemptModelUsed).toHaveBeenCalledWith("codex", undefined);

      stdoutEmitter.emit("data", Buffer.from(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex output text" } }) + "\n",
      ));
      child.emit("close", 0, null);

      await expect(promise).resolves.toBe("codex output text");
    } finally {
      vi.mocked(resolveCodexModelForAttempt).mockImplementation(async (model: string) => model);
      resetMockAiProviders();
    }
  });

  it("passes model_reasoning_effort=xhigh to codex when deepThinking is set", async () => {
    setMockAiProviders(["codex"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "codex", deepThinking: true });
      await Promise.resolve();

      expect(mockSpawn).toHaveBeenCalledWith(
        "codex",
        ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--json", "-m", "fable", "-c", 'model_reasoning_effort="xhigh"'],
        expect.objectContaining({ cwd: "/tmp" }),
      );

      stdoutEmitter.emit("data", Buffer.from(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex output text" } }) + "\n",
      ));
      child.emit("close", 0, null);

      await promise;
    } finally {
      resetMockAiProviders();
    }
  });

  it("sets MAX_THINKING_TOKENS in the child env when deepThinking is set for claude", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude", deepThinking: true });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ MAX_THINKING_TOKENS: "31999" }) }),
    );

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "output", is_error: false })));
    child.emit("close", 0, null);

    await promise;
  });

  it("passes claudeEnv to the claude child env but not to codex", async () => {
    setMockAiProviders(["claude", "codex"]);
    try {
      for (const provider of ["claude", "codex"] as const) {
        mockSpawn.mockClear();
        const child = new EventEmitter() as ChildProcess & EventEmitter;
        const stdoutEmitter = new EventEmitter();
        const stderrEmitter = new EventEmitter();
        const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
        Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
        mockSpawn.mockReturnValue(child as any);

        const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider, strictProvider: true, claudeEnv: NO_BACKGROUND_TASKS_ENV });
        await Promise.resolve();

        const env = (mockSpawn.mock.calls[0]![2] as { env: Record<string, string | undefined> }).env;
        if (provider === "claude") {
          expect(env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]).toBe("1");
          stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "output", is_error: false })));
        } else {
          expect(env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]).toBeUndefined();
          stdoutEmitter.emit("data", Buffer.from(
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex output text" } }) + "\n",
          ));
        }
        child.emit("close", 0, null);
        await promise;
      }
    } finally {
      resetMockAiProviders();
    }
  });

  it("re-derives the deep model for the fallback provider when deepThinking is set", async () => {
    setMockAiProviders(["claude", "codex"]);
    try {
      vi.mocked(isRateLimitError).mockResolvedValueOnce(true);
      vi.mocked(getDeepModel).mockClear();

      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout1 = new EventEmitter();
      Object.assign(child1, { stdout: stdout1, stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), pid: 1 });

      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout2 = new EventEmitter();
      Object.assign(child2, { stdout: stdout2, stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), pid: 2 });

      mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude", deepThinking: true });

      // Claude fails with a rate-limit message (num_turns > 0 so runWithRetry won't retry); allow the async fallback retry.
      stdout1.emit("data", Buffer.from(JSON.stringify({ result: "rate limit exceeded", is_error: true, num_turns: 5 })));
      child1.emit("close", 1, null);
      await new Promise((r) => setTimeout(r, 10));

      stdout2.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex output" } }) + "\n"));
      child2.emit("close", 0, null);

      expect(await promise).toBe("codex output");
      // getDeepModel must be re-derived per attempted provider, not pinned to the first attempt's.
      expect(getDeepModel).toHaveBeenCalledWith("claude");
      expect(getDeepModel).toHaveBeenCalledWith("codex");
    } finally {
      resetMockAiProviders();
    }
  });

  it("injects MCP config into Codex via CODEX_HOME without leaking env secrets in argv", async () => {
    setMockAiProviders(["codex"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
      });

      mockSpawn.mockReturnValue(child as any);
      mockRepoInstructionMissesThenMcpConfig({
        mcpServers: {
          "claws-state": {
            command: "/usr/bin/node",
            args: ["/opt/claws/dist/mcp-server.js"],
            env: { CLAWS_MCP_AUTH_TOKEN: "secret-token" },
          },
        },
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "codex", mcpConfig: "/tmp/.mcp-claws.json" });
      await Promise.resolve();

      expect(mockSpawn).toHaveBeenCalledWith(
        "codex",
        expect.not.arrayContaining(["--mcp-config"]),
        expect.objectContaining({ cwd: "/tmp", env: expect.objectContaining({ CODEX_HOME: "/tmp/codex-home" }) }),
      );

      const configWrite = vi.mocked(fs.writeFileSync).mock.calls.find((call) => String(call[0]).endsWith("/config.toml"));
      expect(configWrite).toBeDefined();
      expect(configWrite?.[1]).toContain("[mcp_servers.claws-state]");
      expect(configWrite?.[1]).toContain('command = "/usr/bin/node"');
      expect(configWrite?.[1]).toContain('args = ["/opt/claws/dist/mcp-server.js"]');
      expect(configWrite?.[1]).toContain("[mcp_servers.claws-state.env]");
      expect(configWrite?.[1]).toContain('CLAWS_MCP_AUTH_TOKEN = "secret-token"');
      const spawnArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1] as string[];
      expect(spawnArgs.join(" ")).not.toContain("secret-token");
      expect(logModule.debug).toHaveBeenCalledWith(
        expect.stringContaining("Injected MCP config into Codex backend"),
      );

      stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "output" } }) + "\n"));
      child.emit("close", 0, null);

      await promise;
    } finally {
      resetMockAiProviders();
    }
  });

  it("throws before spawning Codex when MCP config is malformed", async () => {
    setMockAiProviders(["codex"]);
    try {
      mockRepoInstructionMissesThenMcpConfig({ mcpServers: { "claws-state": { args: [] } } });
      const callsBefore = mockSpawn.mock.calls.length;

      await expect(runClaude("test", "/tmp", { tier: "sonnet", provider: "codex", mcpConfig: "/tmp/.mcp-claws.json" }))
        .rejects.toThrow("must have a command string");

      expect(mockSpawn.mock.calls.length).toBe(callsBefore);
    } finally {
      resetMockAiProviders();
    }
  });

  it("reports codex token usage with a zero cost", async () => {
    setMockAiProviders(["codex"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
      mockSpawn.mockReturnValue(child as any);

      const onTokensUsed = vi.fn();
      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "codex", onTokensUsed });
      await Promise.resolve();

      stdoutEmitter.emit("data", Buffer.from([
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4, cached_input_tokens: 1, reasoning_output_tokens: 0 } }),
      ].join("\n") + "\n"));
      child.emit("close", 0, null);

      await expect(promise).resolves.toBe("answer");
      // Codex exposes no price, so the cost is recorded as 0 while the tokens are real.
      expect(onTokensUsed).toHaveBeenCalledWith(15, 0, "codex");
    } finally {
      resetMockAiProviders();
    }
  });

  it("reports opencode token usage and cost", async () => {
    setMockAiProviders(["opencode"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
      mockSpawn.mockReturnValue(child as any);

      const onTokensUsed = vi.fn();
      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode", onTokensUsed });

      stdoutEmitter.emit("data", Buffer.from([
        JSON.stringify({ type: "text", part: { text: "answer" } }),
        JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { total: 185, input: 100, output: 20, reasoning: 15, cache: { read: 50, write: 0 } }, cost: 0.0042 } }),
        JSON.stringify({ type: "step_finish", part: { reason: "tool-calls", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 5 } }, cost: 0 } }),
      ].join("\n") + "\n"));
      child.emit("close", 0, null);

      await expect(promise).resolves.toBe("answer");
      // 185 (explicit total) + 20 (fallback sum: 10 + 5 + 0 + 5 + 0) = 205
      expect(onTokensUsed).toHaveBeenCalledWith(205, 0.0042, "opencode");
    } finally {
      resetMockAiProviders();
    }
  });

  it("retries a hollow opencode completion (tokens but no text) and succeeds on the second attempt", async () => {
    setMockAiProviders(["opencode"]);
    try {
      const children = [1, 2].map(() => {
        const child = new EventEmitter() as ChildProcess & EventEmitter;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(child, { stdout, stderr, stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() } });
        return { child, stdout };
      });
      mockSpawn.mockReturnValueOnce(children[0]!.child as any).mockReturnValueOnce(children[1]!.child as any);

      const onTokensUsed = vi.fn();
      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode", onTokensUsed });

      children[0]!.stdout.emit("data", Buffer.from(
        JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { total: 50, input: 40, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.001 } }) + "\n",
      ));
      children[0]!.child.emit("close", 0, null);

      await Promise.resolve();
      await Promise.resolve();

      children[1]!.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", part: { text: "second answer" } }) + "\n"));
      children[1]!.child.emit("close", 0, null);

      await expect(promise).resolves.toBe("second answer");
      expect(mockSpawn.mock.calls.filter((c) => c[0] === "opencode")).toHaveLength(2);
      expect(onTokensUsed).toHaveBeenCalledWith(50, 0.001, "opencode");
    } finally {
      resetMockAiProviders();
    }
  });

  it("fails with a transient OpenRouter error when both opencode attempts are hollow", async () => {
    setMockAiProviders(["opencode"]);
    try {
      const children = [1, 2].map(() => {
        const child = new EventEmitter() as ChildProcess & EventEmitter;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(child, { stdout, stderr, stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() } });
        return { child, stdout };
      });
      mockSpawn.mockReturnValueOnce(children[0]!.child as any).mockReturnValueOnce(children[1]!.child as any);

      const onProviderUsed = vi.fn();
      const onAttemptModelUsed = vi.fn();
      const promise = runClaude("test", "/tmp", {
        tier: "sonnet",
        provider: "opencode",
        model: "openrouter/z-ai/glm-5.3",
        onProviderUsed,
        onAttemptModelUsed,
      });

      for (const { child, stdout } of children) {
        stdout.emit("data", Buffer.from(JSON.stringify({ type: "step_finish", part: { reason: "tool-calls", tokens: { total: 10 } } }) + "\n"));
        child.emit("close", 0, null);
        await Promise.resolve();
        await Promise.resolve();
      }

      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining("OpenRouter API Error: empty response from provider"),
        provider: "opencode",
      });
      expect(mockSpawn.mock.calls.filter((c) => c[0] === "opencode")).toHaveLength(2);
      expect(onProviderUsed).toHaveBeenCalledWith("opencode");
      expect(onAttemptModelUsed).toHaveBeenCalledWith("opencode", "openrouter/z-ai/glm-5.3");
    } finally {
      resetMockAiProviders();
    }
  });

  it("grants opencode full permissions via OPENCODE_CONFIG_CONTENT, not a CLI flag", async () => {
    setMockAiProviders(["opencode"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode" });

      stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ type: "text", part: { text: "answer" } }) + "\n"));
      child.emit("close", 0, null);

      await expect(promise).resolves.toBe("answer");

      const spawnOpts = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][2] as { env: Record<string, string> };
      expect(spawnOpts.env["OPENCODE_CONFIG_CONTENT"]).toBe('{"permission":"allow"}');
      const spawnArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1] as string[];
      expect(spawnArgs).not.toContain("--dangerously-skip-permissions");
      expect(spawnArgs).not.toContain("--auto");
    } finally {
      resetMockAiProviders();
    }
  });

  it("throws AgentCliError carrying the codex provider when the turn fails", async () => {
    setMockAiProviders(["codex"]);
    try {
      // A turn.failed with no agent_message is a 0-turn failure, so runWithRetry
      // makes one fresh attempt — both children must be driven.
      const children = [1, 2].map((pid) => {
        const child = new EventEmitter() as ChildProcess & EventEmitter;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(child, { stdout, stderr, stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), pid });
        return { child, stdout };
      });
      mockSpawn.mockReturnValueOnce(children[0]!.child as any).mockReturnValueOnce(children[1]!.child as any);

      const promise = runClaude("test", "/tmp", {
        tier: "sonnet",
        provider: "codex",
        noProviderFallback: true,
      });
      await Promise.resolve();

      const failure = JSON.stringify({ type: "turn.failed", error: { message: "refresh_token_reused" } }) + "\n";
      children[0]!.stdout.emit("data", Buffer.from(failure));
      children[0]!.child.emit("close", 0, null);
      await new Promise((r) => setTimeout(r, 0));
      children[1]!.stdout.emit("data", Buffer.from(failure));
      children[1]!.child.emit("close", 0, null);

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentCliError);
      expect((err as AgentCliError).message).toContain("refresh_token_reused");
      expect((err as AgentCliError).provider).toBe("codex");
    } finally {
      resetMockAiProviders();
    }
  });

  it("does not retry when codex reports an unsupported-model error", async () => {
    setMockAiProviders(["codex"]);
    try {
      const spawnCountBefore = mockSpawn.mock.calls.length;
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), pid: 1 });
      mockSpawn.mockReturnValueOnce(child as any);

      const promise = runClaude("test", "/tmp", {
        tier: "sonnet",
        provider: "codex",
        noProviderFallback: true,
      });
      await Promise.resolve();

      const errorEvent = JSON.stringify({
        type: "error",
        message: "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
      }) + "\n";
      stdoutEmitter.emit("data", Buffer.from(errorEvent));
      child.emit("close", 0, null);

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentCliError);
      expect((err as AgentCliError).message).toContain("not supported when using Codex with a ChatGPT account");
      expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(1);
    } finally {
      resetMockAiProviders();
    }
  });

  it("dispatches to claude (default) when no provider specified", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.any(Object),
    );

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "claude output", is_error: false })));
    child.emit("close", 0, null);

    await promise;
  });

  it("codex rejects with AgentCliError on non-zero exit", async () => {
    // When codex exits non-zero with no stdout, numTurns=0 triggers a retry.
    // Provide two children that both fail.
    setMockAiProviders(["codex"]);
    try {
      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const stderr1 = new EventEmitter();
      Object.assign(child1, {
        stdout: new EventEmitter(),
        stderr: stderr1,
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      });

      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stderr2 = new EventEmitter();
      Object.assign(child2, {
        stdout: new EventEmitter(),
        stderr: stderr2,
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      });

      mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "codex" });
      await Promise.resolve();
      stderr1.emit("data", Buffer.from("codex error"));
      child1.emit("close", 1, null);

      // Allow retry microtask
      await new Promise((r) => setTimeout(r, 0));

      stderr2.emit("data", Buffer.from("codex error"));
      child2.emit("close", 1, null);

      await expect(promise).rejects.toThrow(AgentCliError);
    } finally {
      resetMockAiProviders();
    }
  });

  it("codex rejects on spawn error", async () => {
    setMockAiProviders(["codex"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "codex" });
      await Promise.resolve();
      child.emit("error", new Error("spawn failed"));

      await expect(promise).rejects.toThrow("Failed to spawn codex");
    } finally {
      resetMockAiProviders();
    }
  });

  it("codex rejects with AgentTimeoutError on timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 55555,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test prompt", "/tmp/codex-timeout", { tier: "sonnet", provider: "codex" });
      await Promise.resolve();

      // Emit some output to clear liveness timer
      stdoutEmitter.emit("data", Buffer.from("partial codex output"));

      // Advance past the full timeout (20 min)
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      expect(killMock).toHaveBeenCalledWith("SIGTERM");

      // Process exits after SIGTERM
      child.emit("close", null, "SIGTERM");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentTimeoutError);
      const timeoutErr = err as AgentTimeoutError;
      expect(timeoutErr.message).toContain("timed out after 20m");
      expect(timeoutErr.outputBytes).toBe("partial codex output".length);
      expect(timeoutErr.cwd).toBe("/tmp/codex-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("codex aborts early with liveness timeout when producing 0 bytes", async () => {
    vi.useFakeTimers();
    try {
      // Two children: both will hang (runClaude retries once on 0-byte timeout)
      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const kill1 = vi.fn();
      Object.assign(child1, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
        kill: kill1,
        pid: 55551,
      });

      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const kill2 = vi.fn();
      Object.assign(child2, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
        kill: kill2,
        pid: 55552,
      });

      mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "codex" });
      await Promise.resolve();

      // Liveness fires on first child (10 min)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(kill1).toHaveBeenCalledWith("SIGTERM");
      child1.emit("close", null, "SIGTERM");

      // Retry spawns second child — liveness fires again
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(kill2).toHaveBeenCalledWith("SIGTERM");
      child2.emit("close", null, "SIGTERM");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentTimeoutError);
      expect((err as AgentTimeoutError).outputBytes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("codex resolves with empty string on exit 0 with no stdout", async () => {
    setMockAiProviders(["codex"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: stdinMock,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "codex" });
      await Promise.resolve();

      // Codex exits 0 but produces no output
      child.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("");
    } finally {
      resetMockAiProviders();
    }
  });

  it("codex sets numTurns=0 on non-zero exit with no stdout", async () => {
    setMockAiProviders(["codex"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: stderrEmitter,
        stdin: stdinMock,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "codex" });
      await Promise.resolve();
      stderrEmitter.emit("data", Buffer.from("init failure"));
      child.emit("close", 1, null);

      // runClaude retries on numTurns===0, so we need a second child
      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stderrEmitter2 = new EventEmitter();
      Object.assign(child2, {
        stdout: new EventEmitter(),
        stderr: stderrEmitter2,
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      });
      mockSpawn.mockReturnValue(child2 as any);

      // Allow retry microtask
      await new Promise((r) => setTimeout(r, 0));

      // Second attempt also fails — now the error propagates
      stderrEmitter2.emit("data", Buffer.from("init failure again"));
      child2.emit("close", 1, null);

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentCliError);
      expect((err as AgentCliError).numTurns).toBe(0);
    } finally {
      resetMockAiProviders();
    }
  });

  it("passes --append-system-prompt flag when appendSystemPrompt option is provided", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", {
      tier: "sonnet",
      appendSystemPrompt: "some doc content",
    });

    const spawnArgs = mockSpawn.mock.calls.at(-1)?.[1] as string[];
    const appendSystemPromptIndex = spawnArgs.indexOf("--append-system-prompt");
    expect(appendSystemPromptIndex).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[appendSystemPromptIndex + 1]).toContain("some doc content");
    expect(spawnArgs[appendSystemPromptIndex + 1]).toContain("## Cross-repo access");
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({ cwd: "/tmp" }),
    );

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    await promise;
  });

  it("inlines AGENTS.md into the claude prompt while the role document stays on --append-system-prompt", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);
    // readRepoInstructions swallows a non-ENOENT throw, so assert the path after the run
    // rather than from inside the mock, where a failed expect would be discarded.
    const instructionReads: string[] = [];
    vi.mocked(fs.readFileSync).mockImplementationOnce((pathname) => {
      instructionReads.push(String(pathname));
      return "# Repo rules\nAlways run npm test.";
    });

    const promise = runClaude("test prompt", "/tmp", {
      tier: "sonnet",
      appendSystemPrompt: "role doc content",
    });

    expect(instructionReads).toEqual(["/tmp/AGENTS.md"]);
    const sentPrompt = stdinMock.write.mock.calls.at(-1)?.[0] as string;
    expect(sentPrompt).toContain("<repository-instructions>");
    expect(sentPrompt).toContain("Always run npm test.");
    expect(sentPrompt).toContain("test prompt");
    // The role document travels via the flag only — never duplicated in the prompt.
    expect(sentPrompt).not.toContain("role doc content");
    expect(sentPrompt).not.toContain("<agent-role>");
    const spawnArgs2 = mockSpawn.mock.calls.at(-1)?.[1] as string[];
    expect(spawnArgs2[spawnArgs2.indexOf("--append-system-prompt") + 1]).toContain("role doc content");

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    await promise;
  });
});

describe("prompt capture", () => {
  const origCaptureDir = process.env["CLAWS_PROMPT_CAPTURE_DIR"];
  const origCaptureFlag = process.env["CLAWS_PROMPT_CAPTURE"];

  beforeEach(() => {
    vi.mocked(fs.promises.appendFile).mockClear();
    delete process.env["CLAWS_PROMPT_CAPTURE"];
    delete process.env["CLAWS_PROMPT_CAPTURE_DIR"];
  });

  afterEach(() => {
    if (origCaptureDir === undefined) delete process.env["CLAWS_PROMPT_CAPTURE_DIR"];
    else process.env["CLAWS_PROMPT_CAPTURE_DIR"] = origCaptureDir;
    if (origCaptureFlag === undefined) delete process.env["CLAWS_PROMPT_CAPTURE"];
    else process.env["CLAWS_PROMPT_CAPTURE"] = origCaptureFlag;
    clearProviderRateLimitState();
  });

  function mockChild(): { child: ChildProcess & EventEmitter; stdoutEmitter: EventEmitter } {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);
    return { child, stdoutEmitter };
  }

  it("writes a capture record when capture dir is set", async () => {
    process.env["CLAWS_PROMPT_CAPTURE"] = "1";
    process.env["CLAWS_PROMPT_CAPTURE_DIR"] = "/tmp/fake-capture-dir";
    const { child, stdoutEmitter } = mockChild();

    const promise = runClaude("hello", "/tmp/some-cwd", { tier: "sonnet", provider: "claude", captureLabel: "unit" });
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "world", is_error: false })));
    child.emit("close", 0, null);
    const output = await promise;
    expect(output).toBe("world");

    expect(fs.promises.appendFile).toHaveBeenCalledTimes(1);
    const [filePath, line] = vi.mocked(fs.promises.appendFile).mock.calls[0]!;
    expect(filePath).toMatch(/^\/tmp\/fake-capture-dir\/prompts-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const record = JSON.parse((line as string).trim());
    expect(record).toMatchObject({ label: "unit", prompt: "hello", output: "world", ok: true });
  });

  it("writes to the default capture dir when CLAWS_PROMPT_CAPTURE=1 and no dir override", async () => {
    process.env["CLAWS_PROMPT_CAPTURE"] = "1";
    const { child, stdoutEmitter } = mockChild();

    const promise = runClaude("hello", "/tmp/some-cwd", { tier: "sonnet", provider: "claude", captureLabel: "unit" });
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "world", is_error: false })));
    child.emit("close", 0, null);
    const output = await promise;
    expect(output).toBe("world");

    expect(fs.promises.appendFile).toHaveBeenCalledTimes(1);
    const [filePath, line] = vi.mocked(fs.promises.appendFile).mock.calls[0]!;
    expect(filePath).toMatch(/^\/tmp\/fake-default-capture-dir\/prompts-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const record = JSON.parse((line as string).trim());
    expect(record).toMatchObject({ label: "unit", prompt: "hello", output: "world", ok: true });
  });

  it("writes nothing when no capture env vars are set (opt-in default)", async () => {
    const { child, stdoutEmitter } = mockChild();

    const promise = runClaude("hello", "/tmp/some-cwd", { tier: "sonnet", provider: "claude", captureLabel: "unit" });
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "world", is_error: false })));
    child.emit("close", 0, null);
    await promise;

    expect(fs.promises.appendFile).not.toHaveBeenCalled();
  });

  it("writes nothing when CLAWS_PROMPT_CAPTURE=0", async () => {
    process.env["CLAWS_PROMPT_CAPTURE_DIR"] = "/tmp/fake-capture-dir";
    process.env["CLAWS_PROMPT_CAPTURE"] = "0";
    const { child, stdoutEmitter } = mockChild();

    const promise = runClaude("hello", "/tmp/some-cwd", { tier: "sonnet", provider: "claude" });
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "world", is_error: false })));
    child.emit("close", 0, null);
    await promise;

    expect(fs.promises.appendFile).not.toHaveBeenCalled();
  });

  it("captures failures with ok:false and re-throws the original error", async () => {
    process.env["CLAWS_PROMPT_CAPTURE"] = "1";
    process.env["CLAWS_PROMPT_CAPTURE_DIR"] = "/tmp/fake-capture-dir";
    const { child, stdoutEmitter } = mockChild();

    const promise = runClaude("hello", "/tmp/some-cwd", { tier: "sonnet", provider: "claude" });
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "boom", is_error: true })));
    child.emit("close", 1, null);

    await expect(promise).rejects.toThrow(AgentCliError);
    await expect(promise).rejects.toThrow("boom");

    expect(fs.promises.appendFile).toHaveBeenCalledTimes(1);
    const [, line] = vi.mocked(fs.promises.appendFile).mock.calls[0]!;
    const record = JSON.parse((line as string).trim());
    expect(record.ok).toBe(false);
    expect(record.errorMessage).toContain("boom");
  });
});

describe("provider circuit breakers", () => {
  afterEach(() => {
    clearProviderRateLimitState();
  });

  it("isProviderRateLimited returns false for an unknown provider", () => {
    expect(isProviderRateLimited("claude")).toBe(false);
  });

  it("markProviderRateLimited marks a provider as rate-limited", () => {
    markProviderRateLimited("claude");
    expect(isProviderRateLimited("claude")).toBe(true);
  });

  it("clearProviderRateLimitState clears a specific provider", () => {
    markProviderRateLimited("claude");
    markProviderRateLimited("opencode");
    clearProviderRateLimitState("claude");
    expect(isProviderRateLimited("claude")).toBe(false);
    expect(isProviderRateLimited("opencode")).toBe(true);
  });

  it("clearProviderRateLimitState with no argument clears all providers", () => {
    markProviderRateLimited("claude");
    markProviderRateLimited("opencode");
    clearProviderRateLimitState();
    expect(isProviderRateLimited("claude")).toBe(false);
    expect(isProviderRateLimited("opencode")).toBe(false);
  });

  it("clearProviderRateLimitState returns true when a specific provider was open, false when it was already clear", () => {
    markProviderRateLimited("claude");
    expect(clearProviderRateLimitState("claude")).toBe(true);
    expect(clearProviderRateLimitState("claude")).toBe(false);
  });

  it("clearProviderRateLimitState with no argument returns true only when a breaker was open", () => {
    expect(clearProviderRateLimitState()).toBe(false);
    markProviderRateLimited("claude");
    expect(clearProviderRateLimitState()).toBe(true);
  });

  it("getProviderRateLimitedUntil returns the deadline while open and null when clear or expired", () => {
    vi.useFakeTimers();
    try {
      expect(getProviderRateLimitedUntil("claude")).toBeNull();
      const now = Date.now();
      markProviderRateLimited("claude", 1000);
      expect(getProviderRateLimitedUntil("claude")).toBe(now + 1000);
      vi.advanceTimersByTime(1001);
      expect(getProviderRateLimitedUntil("claude")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearProviderRateLimitState returns false for a breaker that already lapsed but wasn't yet swept", () => {
    vi.useFakeTimers();
    try {
      markProviderRateLimited("claude", 1000);
      vi.advanceTimersByTime(1001);
      expect(clearProviderRateLimitState("claude")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isProviderRateLimited returns false after the custom cooldown expires", () => {
    vi.useFakeTimers();
    try {
      markProviderRateLimited("claude", 1000);
      expect(isProviderRateLimited("claude")).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(isProviderRateLimited("claude")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reselects by weight when the preferred claude provider is rate-limited", async () => {
    setMockAiProviders(["claude", "codex", "opencode"]);
    try {
      vi.mocked(isRateLimitError).mockResolvedValueOnce(true);

      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout1 = new EventEmitter();
      const stderr1 = new EventEmitter();
      const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child1, { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: vi.fn(), pid: 1 });

      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout2 = new EventEmitter();
      const stderr2 = new EventEmitter();
      const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child2, { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn(), pid: 2 });

      mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

      const onProviderUsed = vi.fn();
      const eligibleProviders = [
        { provider: "claude" as const, weight: 4 },
        { provider: "codex" as const, weight: 2 },
        { provider: "opencode" as const, weight: 1 },
      ];
      const providerRandom = vi.fn(() => 2 / 3);
      mockRepoInstructionMissesThenMcpConfig({
        mcpServers: {
          "claws-state": {
            command: "/usr/bin/node",
            args: ["/opt/claws/dist/mcp-server.js"],
            env: { CLAWS_MCP_AUTH_TOKEN: "secret-token" },
          },
        },
      });
      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude", eligibleProviders, providerRandom, onProviderUsed, mcpConfig: "/tmp/.mcp-claws.json" });

      // Claude fails with a rate-limit message (num_turns > 0 so runWithRetry won't retry)
      stdout1.emit("data", Buffer.from(JSON.stringify({ result: "rate limit exceeded", is_error: true, num_turns: 5 })));
      child1.emit("close", 1, null);

      // Allow async isRateLimitError check and fallback retry
      await new Promise((r) => setTimeout(r, 10));

      // OpenCode (weighted reselection from codex:opencode = 2:1) succeeds
      stdout2.emit("data", Buffer.from(JSON.stringify({ type: "text", part: { text: "opencode output" } }) + "\n"));
      child2.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("opencode output");
      expect(onProviderUsed).toHaveBeenCalledWith("claude");
      expect(onProviderUsed).toHaveBeenCalledWith("opencode");
      expect(onProviderUsed).toHaveBeenCalledTimes(2);
      // Verify spawn targets: first claude, then opencode
      const spawnCalls = mockSpawn.mock.calls.slice(-2);
      expect(spawnCalls[0][0]).toBe("claude");
      expect(spawnCalls[1][0]).toBe("opencode");
      const fallbackEnv = spawnCalls[1][2]?.env as Record<string, string>;
      expect(JSON.parse(fallbackEnv["OPENCODE_CONFIG_CONTENT"]).mcp["claws-state"].environment.CLAWS_MCP_AUTH_TOKEN).toBe("secret-token");
      expect(providerRandom).toHaveBeenCalledOnce();
    } finally {
      resetMockAiProviders();
    }
  });

  it("marks a weekly-limit message as rate-limited without consulting isRateLimitError", async () => {
    setMockAiProviders(["claude", "codex", "opencode"]);
    try {
      vi.mocked(isRateLimitError).mockClear();

      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout1 = new EventEmitter();
      const stderr1 = new EventEmitter();
      const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child1, { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: vi.fn(), pid: 1 });

      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout2 = new EventEmitter();
      const stderr2 = new EventEmitter();
      const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child2, { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn(), pid: 2 });

      mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

      const onProviderUsed = vi.fn();
      const eligibleProviders = [
        { provider: "claude" as const, weight: 4 },
        { provider: "codex" as const, weight: 2 },
        { provider: "opencode" as const, weight: 1 },
      ];
      const providerRandom = vi.fn(() => 2 / 3);
      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude", eligibleProviders, providerRandom, onProviderUsed });

      stdout1.emit(
        "data",
        Buffer.from(JSON.stringify({ result: "You've hit your weekly limit · resets 2am (Europe/London)", is_error: true, num_turns: 3 })),
      );
      child1.emit("close", 1, null);

      await new Promise((r) => setTimeout(r, 10));

      stdout2.emit("data", Buffer.from(JSON.stringify({ type: "text", part: { text: "opencode output" } }) + "\n"));
      child2.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("opencode output");
      expect(isProviderRateLimited("claude")).toBe(true);
      expect(isRateLimitError).not.toHaveBeenCalled();
      const spawnCalls = mockSpawn.mock.calls.slice(-2);
      expect(spawnCalls[0][0]).toBe("claude");
      expect(spawnCalls[1][0]).toBe("opencode");
      expect(providerRandom).toHaveBeenCalledOnce();
    } finally {
      resetMockAiProviders();
    }
  });

  it("marks a 'usage limit reached' message as rate-limited without consulting isRateLimitError", async () => {
    setMockAiProviders(["claude", "codex", "opencode"]);
    try {
      vi.mocked(isRateLimitError).mockClear();

      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout1 = new EventEmitter();
      const stderr1 = new EventEmitter();
      const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child1, { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: vi.fn(), pid: 1 });

      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout2 = new EventEmitter();
      const stderr2 = new EventEmitter();
      const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child2, { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn(), pid: 2 });

      mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

      const onProviderUsed = vi.fn();
      const eligibleProviders = [
        { provider: "claude" as const, weight: 4 },
        { provider: "codex" as const, weight: 2 },
        { provider: "opencode" as const, weight: 1 },
      ];
      const providerRandom = vi.fn(() => 2 / 3);
      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude", eligibleProviders, providerRandom, onProviderUsed });

      stdout1.emit(
        "data",
        Buffer.from(JSON.stringify({ result: "Claude AI usage limit reached|1735689600", is_error: true, num_turns: 3 })),
      );
      child1.emit("close", 1, null);

      await new Promise((r) => setTimeout(r, 10));

      stdout2.emit("data", Buffer.from(JSON.stringify({ type: "text", part: { text: "opencode output" } }) + "\n"));
      child2.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("opencode output");
      expect(isProviderRateLimited("claude")).toBe(true);
      expect(isRateLimitError).not.toHaveBeenCalled();
      const spawnCalls = mockSpawn.mock.calls.slice(-2);
      expect(spawnCalls[0][0]).toBe("claude");
      expect(spawnCalls[1][0]).toBe("opencode");
      expect(providerRandom).toHaveBeenCalledOnce();
    } finally {
      resetMockAiProviders();
    }
  });

  it("does not reselect another provider for unsupported model startup errors", async () => {
    setMockAiProviders(["claude", "codex", "opencode"]);
    try {
      vi.mocked(isRateLimitError).mockClear();

      const child = makeMockChild(1);
      mockSpawn.mockReturnValueOnce(child as any);
      const spawnCallsBefore = mockSpawn.mock.calls.length;

      const onProviderUsed = vi.fn();
      const eligibleProviders = [
        { provider: "claude" as const, weight: 4 },
        { provider: "codex" as const, weight: 2 },
        { provider: "opencode" as const, weight: 1 },
      ];
      const providerRandom = vi.fn(() => 2 / 3);
      const promise = runClaude("test prompt", "/tmp", {
        tier: "sonnet",
        provider: "claude",
        model: "not-a-real-model",
        eligibleProviders,
        providerRandom,
        onProviderUsed,
      });
      await Promise.resolve();

      child.stdout.emit("data", Buffer.from(JSON.stringify({
        result: "The model `not-a-real-model` does not exist",
        is_error: true,
        num_turns: 0,
      }) + "\n"));
      child.emit("close", 1, null);

      await expect(promise).rejects.toThrow("not-a-real-model");
      expect(onProviderUsed).toHaveBeenCalledOnce();
      expect(onProviderUsed).toHaveBeenCalledWith("claude");
      expect(mockSpawn.mock.calls.length - spawnCallsBefore).toBe(1);
      expect(providerRandom).not.toHaveBeenCalled();
      expect(isRateLimitError).not.toHaveBeenCalled();
    } finally {
      resetMockAiProviders();
    }
  });

  it("preserves unsupported codex model errors without provider fallback", async () => {
    setMockAiProviders(["codex", "claude"]);
    try {
      const spawnCallsBefore = mockSpawn.mock.calls.length;
      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout1 = new EventEmitter();
      Object.assign(child1, { stdout: stdout1, stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), pid: 1 });

      mockSpawn.mockReturnValueOnce(child1 as any);

      const onProviderUsed = vi.fn();
      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "codex", onProviderUsed });
      await Promise.resolve();

      stdout1.emit("data", Buffer.from(JSON.stringify({
        type: "error",
        message: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
      }) + "\n"));
      child1.emit("close", 0, null);

      await expect(promise).rejects.toThrow(/gpt-5\.4/);
      expect(isProviderRateLimited("codex")).toBe(false);
      expect(onProviderUsed).toHaveBeenCalledWith("codex");
      expect(onProviderUsed).toHaveBeenCalledOnce();
      expect(mockSpawn.mock.calls.length - spawnCallsBefore).toBe(1);
      expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe("codex");
    } finally {
      clearProviderRateLimitState("codex");
      resetMockAiProviders();
    }
  });

  it("preserves unsupported-model errors when strict provider leaves no fallback", async () => {
    setMockAiProviders(["codex", "claude"]);
    try {
      const spawnCountBefore = mockSpawn.mock.calls.length;
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout = new EventEmitter();
      Object.assign(child, { stdout, stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), pid: 1 });
      mockSpawn.mockReturnValueOnce(child as any);

      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "codex", strictProvider: true });
      await Promise.resolve();

      stdout.emit("data", Buffer.from(JSON.stringify({
        type: "error",
        message: "unsupported_model: account cannot use this model",
      }) + "\n"));
      child.emit("close", 0, null);

      await expect(promise).rejects.toThrow(/unsupported_model/);
      expect(mockSpawn.mock.calls.length - spawnCountBefore).toBe(1);
    } finally {
      clearProviderRateLimitState("codex");
      resetMockAiProviders();
    }
  });

  it("leaves the claude auth latch set when a fallback provider succeeds", async () => {
    const { noteAgentAuthFailure, isAgentAuthExpired, __resetAgentAuthStateForTests } = await import("./agent-auth-state.js");
    setMockAiProviders(["claude", "opencode"]);
    __resetAgentAuthStateForTests();
    try {
      noteAgentAuthFailure("claude OAuth session expired");
      vi.mocked(isRateLimitError).mockResolvedValueOnce(true);

      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      Object.assign(child1, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), pid: 1 });
      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout2 = new EventEmitter();
      Object.assign(child2, { stdout: stdout2, stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), pid: 2 });
      mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

      const eligibleProviders = [
        { provider: "claude" as const, weight: 4 },
        { provider: "opencode" as const, weight: 1 },
      ];
      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude", eligibleProviders, providerRandom: () => 0 });
      (child1.stdout as EventEmitter).emit("data", Buffer.from(JSON.stringify({ result: "rate limit exceeded", is_error: true, num_turns: 5 })));
      child1.emit("close", 1, null);
      await new Promise((r) => setTimeout(r, 10));
      stdout2.emit("data", Buffer.from(JSON.stringify({ type: "text", part: { text: "opencode output" } }) + "\n"));
      child2.emit("close", 0, null);

      expect(await promise).toBe("opencode output");
      // An opencode success says nothing about the claude CLI's OAuth session,
      // so the latch must survive it (#2538).
      expect(isAgentAuthExpired()).toBe(true);
    } finally {
      __resetAgentAuthStateForTests();
      resetMockAiProviders();
    }
  });

  it("clears the claude auth latch when the claude provider itself succeeds", async () => {
    const { noteAgentAuthFailure, isAgentAuthExpired, __resetAgentAuthStateForTests } = await import("./agent-auth-state.js");
    __resetAgentAuthStateForTests();
    try {
      noteAgentAuthFailure("claude OAuth session expired");

      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout = new EventEmitter();
      Object.assign(child, { stdout, stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), pid: 1 });
      mockSpawn.mockReturnValueOnce(child as any);

      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude" });
      stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      child.emit("close", 0, null);

      expect(await promise).toBe("ok");
      expect(isAgentAuthExpired()).toBe(false);
    } finally {
      __resetAgentAuthStateForTests();
    }
  });

  it("noProviderFallback throws instead of falling back to the next provider on a rate limit", async () => {
    setMockAiProviders(["claude", "opencode"]);
    try {
      vi.mocked(isRateLimitError).mockResolvedValueOnce(true);

      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock, kill: vi.fn(), pid: 1 });
      mockSpawn.mockReturnValue(child as any);
      const spawnCallsBefore = mockSpawn.mock.calls.length;

      const onProviderUsed = vi.fn();
      const promise = runClaude("test prompt", "/tmp", {
        tier: "sonnet",
        provider: "claude",
        disallowedTools: ["Bash"],
        noProviderFallback: true,
        onProviderUsed,
      });

      stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "rate limit exceeded", is_error: true, num_turns: 5 })));
      child.emit("close", 1, null);

      await expect(promise).rejects.toThrow(/rate limit exceeded/);
      // Only the pinned provider was ever attempted — no opencode re-run.
      expect(onProviderUsed).toHaveBeenCalledOnce();
      expect(onProviderUsed).toHaveBeenCalledWith("claude");
      expect(mockSpawn.mock.calls.slice(spawnCallsBefore).map((c) => c[0])).toEqual(["claude"]);
    } finally {
      resetMockAiProviders();
    }
  });

  it("disallowedTools alone pins the provider: no fallback re-run on a rate limit", async () => {
    setMockAiProviders(["claude", "opencode"]);
    try {
      vi.mocked(isRateLimitError).mockResolvedValueOnce(true);

      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock, kill: vi.fn(), pid: 1 });
      mockSpawn.mockReturnValue(child as any);
      const spawnCallsBefore = mockSpawn.mock.calls.length;

      const onProviderUsed = vi.fn();
      const promise = runClaude("test prompt", "/tmp", {
        tier: "sonnet",
        provider: "claude",
        disallowedTools: ["Bash"],
        onProviderUsed,
      });

      stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "rate limit exceeded", is_error: true, num_turns: 5 })));
      child.emit("close", 1, null);

      await expect(promise).rejects.toThrow(/rate limit exceeded/);
      // Only the pinned provider was ever attempted — no opencode re-run.
      expect(onProviderUsed).toHaveBeenCalledOnce();
      expect(onProviderUsed).toHaveBeenCalledWith("claude");
      expect(mockSpawn.mock.calls.slice(spawnCallsBefore).map((c) => c[0])).toEqual(["claude"]);
    } finally {
      resetMockAiProviders();
    }
  });

  it("onProviderUsed callback is called with the provider for each attempt", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const onProviderUsed = vi.fn();
    const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "claude", onProviderUsed });

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);

    await promise;
    expect(onProviderUsed).toHaveBeenCalledOnce();
    expect(onProviderUsed).toHaveBeenCalledWith("claude");
  });

  it("honors explicit options.provider over config primary in attempt order", async () => {
    setMockAiProviders(["codex"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
      mockSpawn.mockReturnValue(child as any);

      const onProviderUsed = vi.fn();
      const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude", onProviderUsed });

      stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      child.emit("close", 0, null);

      await promise;
      // Explicit provider: "claude" should be tried first, not config primary "codex"
      expect(onProviderUsed).toHaveBeenCalledOnce();
      expect(onProviderUsed).toHaveBeenCalledWith("claude");
      expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe("claude");
    } finally {
      resetMockAiProviders();
    }
  });

  it("throws 'All AI providers are rate-limited' when every provider in attemptOrder is already rate-limited", async () => {
    setMockAiProviders(["claude", "opencode"]);
    try {
      markProviderRateLimited("claude");
      markProviderRateLimited("opencode");

      const onProviderUsed = vi.fn();
      await expect(
        runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude", onProviderUsed }),
      ).rejects.toThrow("All AI providers are rate-limited or unavailable");
      expect(onProviderUsed).not.toHaveBeenCalled();
    } finally {
      resetMockAiProviders();
    }
  });
});

describe("opencode backend", () => {
  beforeEach(async () => {
    setMockAiProviders(["opencode"]);
  });
  afterEach(async () => {
    resetMockAiProviders();
  });

  it("dispatches to opencode when provider is opencode", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", {
      tier: "sonnet",
      provider: "opencode",
      disallowedTools: ["Bash"],
    });

    const spawnArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      expect.arrayContaining(["run", "--format", "json"]),
      expect.objectContaining({ cwd: "/tmp" }),
    );
    // Prompt must NOT appear in args — it is delivered via stdin only.
    expect(spawnArgs).not.toContain("test prompt");

    // Emit JSON-formatted output matching opencode --format json
    const jsonLine = JSON.stringify({ type: "text", part: { text: "opencode output text" } });
    stdoutEmitter.emit("data", Buffer.from(jsonLine + "\n"));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("opencode output text");
    // Prompt is written to stdin by runCliProcess
    expect(stdinMock.write).toHaveBeenCalledWith("test prompt");
    expect(stdinMock.end).toHaveBeenCalled();
  });

  it("opencode passes --model flag derived from tier", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    // An explicit provider+model pin is honoured on the first attempt (isFirstTryWithExplicitModel),
    // so the explicit model is used as-is instead of being re-derived from tier.
    const promise = runClaude("test", "/tmp", { tier: "opus", provider: "opencode", model: "anthropic/claude-opus-4" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      expect.arrayContaining(["--model", "anthropic/claude-opus-4"]),
      expect.objectContaining({ cwd: "/tmp" }),
    );

    const jsonLine = JSON.stringify({ type: "text", part: { text: "result" } });
    stdoutEmitter.emit("data", Buffer.from(jsonLine + "\n"));
    child.emit("close", 0, null);
    await promise;
  });

  it("opencode always passes --model flag derived from tier", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    // With tier required, model is always derived from tier via getModel (mocked to "sonnet")
    const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode" });

    const spawnArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1] as string[];
    expect(spawnArgs).toContain("--model");

    const jsonLine = JSON.stringify({ type: "text", part: { text: "result" } });
    stdoutEmitter.emit("data", Buffer.from(jsonLine + "\n"));
    child.emit("close", 0, null);
    await promise;
  });

  it("opencode throws AgentCliError when exit 0 produces empty stdout", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: new EventEmitter(), stderr: stderrEmitter, stdin: stdinMock });

    const retryChild = new EventEmitter() as ChildProcess & EventEmitter;
    const retryStderr = new EventEmitter();
    Object.assign(retryChild, { stdout: new EventEmitter(), stderr: retryStderr, stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() } });

    const callsBefore = mockSpawn.mock.calls.length;
    mockSpawn
      .mockReturnValueOnce(child as any)
      .mockReturnValueOnce(retryChild as any);

    const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode" });

    stderrEmitter.emit("data", Buffer.from("ProviderModelNotFoundError"));
    child.emit("close", 0, null);

    // numTurns=0 triggers retry — the retry also fails
    await new Promise((r) => setTimeout(r, 50));
    retryStderr.emit("data", Buffer.from("ProviderModelNotFoundError"));
    retryChild.emit("close", 0, null);

    // After retry exhausted, should reject with AgentCliError
    await expect(promise).rejects.toThrow(AgentCliError);
    expect(mockSpawn.mock.calls.length - callsBefore).toBe(2);
  });

  it("opencode parses JSON error events and throws AgentCliError", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });

    const retryChild = new EventEmitter() as ChildProcess & EventEmitter;
    const retryStdout = new EventEmitter();
    Object.assign(retryChild, { stdout: retryStdout, stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() } });

    const callsBefore = mockSpawn.mock.calls.length;
    mockSpawn
      .mockReturnValueOnce(child as any)
      .mockReturnValueOnce(retryChild as any);

    const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode" });

    // Emit a JSON error event
    const errorEvent = JSON.stringify({ type: "error", error: { name: "ProviderError", data: { message: "Model not found" } } });
    stdoutEmitter.emit("data", Buffer.from(errorEvent + "\n"));
    child.emit("close", 0, null);

    // numTurns=0 triggers retry — retry succeeds
    await new Promise((r) => setTimeout(r, 50));
    const jsonLine = JSON.stringify({ type: "text", part: { text: "retry success" } });
    retryStdout.emit("data", Buffer.from(jsonLine + "\n"));
    retryChild.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("retry success");
    expect(mockSpawn.mock.calls.length - callsBefore).toBe(2);
  });

  it("injects MCP config into OpenCode via OPENCODE_CONFIG_CONTENT without leaking env secrets in argv", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);
    mockRepoInstructionMissesThenMcpConfig({
      mcpServers: {
        "claws-state": {
          command: "/usr/bin/node",
          args: ["/opt/claws/dist/mcp-server.js"],
          env: { CLAWS_MCP_AUTH_TOKEN: "secret-token" },
        },
      },
    });

    const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode", mcpConfig: "/tmp/.mcp-claws.json" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      expect.not.arrayContaining(["--mcp-config"]),
      expect.any(Object),
    );
    expect(logModule.debug).toHaveBeenCalledWith(
      expect.stringContaining("Injected MCP config into OpenCode backend"),
    );
    const spawnOpts = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][2] as { env: Record<string, string> };
    expect(JSON.parse(spawnOpts.env["OPENCODE_CONFIG_CONTENT"])).toEqual({
      permission: "allow",
      mcp: {
        "claws-state": {
          type: "local",
          command: ["/usr/bin/node", "/opt/claws/dist/mcp-server.js"],
          environment: { CLAWS_MCP_AUTH_TOKEN: "secret-token" },
          enabled: true,
          timeout: 300000,
        },
      },
    });
    // Both tools default to 240s and permit 270s; allow HTTP overhead too.
    const timeout = JSON.parse(spawnOpts.env["OPENCODE_CONFIG_CONTENT"]).mcp["claws-state"].timeout;
    for (const tool of ["claws_wait_for_change", "claws_request_capability"]) {
      expect(timeout, tool).toBeGreaterThan(270_000);
    }
    const spawnArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1] as string[];
    expect(spawnArgs.join(" ")).not.toContain("secret-token");

    const jsonLine = JSON.stringify({ type: "text", part: { text: "output" } });
    stdoutEmitter.emit("data", Buffer.from(jsonLine + "\n"));
    child.emit("close", 0, null);
    await promise;
  });

  it("throws before spawning OpenCode when MCP config is missing", async () => {
    const callsBefore = mockSpawn.mock.calls.length;
    vi.mocked(fs.readFileSync)
      .mockImplementationOnce((pathname) => { throw enoent(String(pathname)); })
      .mockImplementationOnce((pathname) => { throw enoent(String(pathname)); })
      .mockImplementationOnce(() => {
        throw new Error("ENOENT");
      });

    await expect(runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode", mcpConfig: "/tmp/missing-mcp.json" }))
      .rejects.toThrow("Could not read MCP config");

    expect(mockSpawn.mock.calls.length).toBe(callsBefore);
  });

  it("opencode rejects with AgentCliError on non-zero exit with stderr output", async () => {
    // When stderr has content, stdout is non-empty (stderr is used as error message),
    // so numTurns is NOT set to 0 — no retry, just reject.
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stderrEmitter = new EventEmitter();
    const stdoutEmitter = new EventEmitter();
    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    });

    mockSpawn.mockReturnValueOnce(child as any);

    // Attach the rejection handler before the process closes to avoid an
    // unhandled-rejection warning during the async isRateLimitError check.
    const rejectPromise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode" });
    const assertion = expect(rejectPromise).rejects.toThrow(AgentCliError);

    // Emit some stdout so numTurns is not set to 0 (avoids retry/timeout)
    stdoutEmitter.emit("data", Buffer.from("partial output"));
    stderrEmitter.emit("data", Buffer.from("opencode error"));
    child.emit("close", 1, null);

    await assertion;
  });

  it("opencode sets numTurns=0 on non-zero exit with no stdout", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stderrEmitter = new EventEmitter();
    Object.assign(child, {
      stdout: new EventEmitter(),
      stderr: stderrEmitter,
      stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    });

    const retryChild = new EventEmitter() as ChildProcess & EventEmitter;
    const retryStdout = new EventEmitter();
    Object.assign(retryChild, { stdout: retryStdout, stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() } });

    const callsBefore = mockSpawn.mock.calls.length;
    mockSpawn
      .mockReturnValueOnce(child as any)
      .mockReturnValueOnce(retryChild as any);

    const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode" });

    stderrEmitter.emit("data", Buffer.from("opencode init failure"));
    child.emit("close", 1, null);

    // Give runWithRetry time to spawn the retry process
    await new Promise((r) => setTimeout(r, 50));
    const jsonLine = JSON.stringify({ type: "text", part: { text: "retry ok" } });
    retryStdout.emit("data", Buffer.from(jsonLine + "\n"));
    retryChild.emit("close", 0, null);

    // Should retry and succeed (numTurns=0 triggers retry in runWithRetry)
    const result = await promise;
    expect(result).toBe("retry ok");
    expect(mockSpawn.mock.calls.length - callsBefore).toBe(2);
  });

  it("opencode rejects on spawn error", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp", { tier: "sonnet", provider: "opencode" });
    child.emit("error", new Error("spawn failed"));

    await expect(promise).rejects.toThrow("Failed to spawn opencode");
  });
});

describe("generatePRDescription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns claude-generated description on success", async () => {
    // Mock git diff
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff") && !args?.includes("--stat")) {
        cb(null, "diff output here", "");
      }
      return undefined as any;
    });

    // Mock runClaude (via spawn)
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generatePRDescription("/tmp/wt", "main", {
      number: 1,
      title: "Test",
      body: "Fix something",
    }, "owner/repo");

    // Let the enqueue/runClaude call propagate
    await vi.advanceTimersByTimeAsync(0);

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "## Summary\nFixed the thing", is_error: false })));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("## Summary\nFixed the thing");
    expect(stdinMock.write).toHaveBeenCalledWith(expect.stringContaining("TITLE:"));
  });

  it("throws when claude fails", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff")) {
        cb(null, "diff content", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generatePRDescription("/tmp/wt", "main", {
      number: 1,
      title: "Test",
      body: "body",
    }, "owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    child.emit("error", new Error("spawn failed"));

    await expect(promise).rejects.toThrow("Failed to spawn claude");
  });

  it("throws when claude returns empty output", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff")) {
        cb(null, "diff content", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generatePRDescription("/tmp/wt", "main", {
      number: 1,
      title: "Test",
      body: "body",
    }, "owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "", is_error: false })));
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow("empty PR description");
  });
});

describe("generateDocsPRDescription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns claude-generated description for docs", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff") && !args?.includes("--stat")) {
        cb(null, "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md\n+new docs", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generateDocsPRDescription("/tmp/wt", "main");

    await vi.advanceTimersByTimeAsync(0);

    // Verify prompt mentions documentation
    expect(stdinMock.write).toHaveBeenCalledWith(expect.stringContaining("documentation"));

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "## Summary\nUpdated docs for new module", is_error: false })));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("## Summary\nUpdated docs for new module");
  });

  it("throws when claude returns empty output", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff")) {
        cb(null, "diff content", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generateDocsPRDescription("/tmp/wt", "main");

    await vi.advanceTimersByTimeAsync(0);
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "", is_error: false })));
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow("empty PR description");
  });
});

describe("regeneratePRDescription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns claude-generated description from diff and PR title", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff") && !args?.includes("--stat")) {
        cb(null, "diff output here", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = regeneratePRDescription("/tmp/wt", "main", {
      number: 5,
      title: "Fix CI",
    }, "owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    // Verify prompt references the PR title
    expect(stdinMock.write).toHaveBeenCalledWith(expect.stringContaining("Fix CI"));

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "## Summary\nFixed CI issues", is_error: false })));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("## Summary\nFixed CI issues");
  });

  it("throws when claude returns empty output", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff")) {
        cb(null, "diff content", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = regeneratePRDescription("/tmp/wt", "main", {
      number: 5,
      title: "Fix CI",
    }, "owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "", is_error: false })));
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow("empty PR description");
  });
});

describe("ensureClone coalescing", () => {
  const mockFs = vi.mocked(fs);
  const repo = { owner: "test-owner", name: "test-repo", fullName: "test-owner/test-repo", defaultBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
    resetFetchCache();
    resetWorktreeLocks();
  });

  it("concurrent createWorktree calls for the same repo only fetch once", async () => {
    let fetchCallCount = 0;

    // .git exists (existing clone) — fetch path
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      // worktree path doesn't exist yet
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        fetchCallCount++;
        // Simulate slow fetch
        setTimeout(() => cb(null, "", ""), 50);
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch") {
        // git branch -D (cleanup) — pretend branch doesn't exist
        cb(new Error("branch not found"), "", "branch not found");
      } else if (args?.[0] === "worktree") {
        if (args?.[1] === "add") {
          cb(null, "", "");
        } else if (args?.[1] === "remove") {
          cb(null, "", "");
        } else if (args?.[1] === "prune") {
          cb(null, "", "");
        }
      }
      return undefined as any;
    });

    const p1 = createWorktree(repo, "branch-a", "test-job");
    const p2 = createWorktree(repo, "branch-b", "test-job");

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toContain("branch-a");
    expect(r2).toContain("branch-b");
    // The key assertion: fetch was called only once, not twice
    expect(fetchCallCount).toBe(1);
  });

  it("createWorktree passes --no-track to avoid .git/config lock contention", async () => {
    const worktreeAddCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch") {
        cb(new Error("branch not found"), "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "add") {
        worktreeAddCalls.push([...args]);
        cb(null, "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "prune") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await createWorktree(repo, "branch-test", "test-job");

    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeAddCalls[0]).toContain("--no-track");
  });

  it("ensureClone updates working directory with checkout after fetch", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...args]);
      if (args?.[0] === "fetch") {
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await ensureClone(repo);

    const fetchCall = gitCalls.find((c) => c[0] === "fetch");
    const checkoutCall = gitCalls.find((c) => c[0] === "checkout");
    expect(fetchCall).toBeDefined();
    expect(checkoutCall).toEqual(["checkout", "origin/main", "--force"]);

    // checkout must come after fetch
    const fetchIdx = gitCalls.indexOf(fetchCall!);
    const checkoutIdx = gitCalls.indexOf(checkoutCall!);
    expect(fetchIdx).toBeLessThan(checkoutIdx);
  });

  it("after coalesced fetch completes, next call with skipFetchIfRecent skips fetch", async () => {
    let fetchCallCount = 0;

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        fetchCallCount++;
        setTimeout(() => cb(null, "", ""), 10);
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    // First call — fetches
    await ensureClone(repo);
    expect(fetchCallCount).toBe(1);

    // Second call with skipFetchIfRecent — skips fetch (uses cache)
    await ensureClone(repo, { skipFetchIfRecent: true });
    expect(fetchCallCount).toBe(1);
  });

  it("fetch error propagates to all concurrent callers", async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        setTimeout(() => cb(new Error("fetch failed"), "", "fatal: could not read from remote repository"), 10);
      }
      return undefined as any;
    });

    const p1 = createWorktree(repo, "branch-x", "test-job");
    const p2 = createWorktree(repo, "branch-y", "test-job");

    await expect(p1).rejects.toThrow("fetch");
    await expect(p2).rejects.toThrow("fetch");
  });

  it("concurrent createWorktree calls for the same repo serialize worktree operations", async () => {
    const events: string[] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch") {
        cb(new Error("branch not found"), "", "branch not found");
      } else if (args?.[0] === "worktree" && args?.[1] === "prune") {
        const branch = args.find((a: string) => a.includes("branch")) ?? "?";
        events.push(`prune`);
        cb(null, "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "add") {
        // Record which branch is being added
        const branchArg = args[args.indexOf("-b") + 1] ?? "?";
        events.push(`add:${branchArg}`);
        cb(null, "", "");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const p1 = createWorktree(repo, "branch-a", "test-job");
    const p2 = createWorktree(repo, "branch-b", "test-job");

    await Promise.all([p1, p2]);

    // Both branches should be created
    expect(events.filter((e) => e.startsWith("add:"))).toHaveLength(2);

    // Serialization: the second prune must not start before the first add finishes.
    // With the mutex, the order must be: prune, add:branch-a, prune, add:branch-b
    // (or the reverse order, but adds and prunes must never interleave across tasks).
    const pruneIndices = events.map((e, i) => (e === "prune" ? i : -1)).filter((i) => i >= 0);
    const addIndices = events.map((e, i) => (e.startsWith("add:") ? i : -1)).filter((i) => i >= 0);
    expect(pruneIndices).toHaveLength(2);
    expect(addIndices).toHaveLength(2);
    // Each prune must come before its corresponding add (paired by order)
    expect(pruneIndices[0]).toBeLessThan(addIndices[0]);
    expect(pruneIndices[1]).toBeLessThan(addIndices[1]);
    // First add must complete before second prune starts
    expect(addIndices[0]).toBeLessThan(pruneIndices[1]);
  });

  it("concurrent createWorktree calls for different repos run in parallel", async () => {
    const repo2 = { owner: "test-owner", name: "other-repo", fullName: "test-owner/other-repo", defaultBranch: "main" };
    const events: string[] = [];
    let resolveSlowAdd!: () => void;
    const slowAddDone = new Promise<void>((r) => { resolveSlowAdd = r; });

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch") {
        cb(new Error("branch not found"), "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "prune") {
        cb(null, "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "add") {
        // First repo's add is slow; second repo's add is instant
        const wtArg = String(args[2] ?? "");
        if (wtArg.includes("test-repo") && !wtArg.includes("other-repo")) {
          events.push("repo1:add:start");
          setTimeout(() => {
            events.push("repo1:add:done");
            resolveSlowAdd();
            cb(null, "", "");
          }, 50);
        } else {
          events.push("repo2:add");
          cb(null, "", "");
        }
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const p1 = createWorktree(repo, "branch-a", "test-job");
    const p2 = createWorktree(repo2, "branch-b", "test-job");

    await Promise.all([p1, p2]);

    // repo2's add should complete before repo1's slow add finishes
    // (they run in parallel, not serialized)
    const repo2AddIdx = events.indexOf("repo2:add");
    const repo1DoneIdx = events.indexOf("repo1:add:done");
    expect(repo2AddIdx).toBeGreaterThanOrEqual(0);
    expect(repo1DoneIdx).toBeGreaterThanOrEqual(0);
    expect(repo2AddIdx).toBeLessThan(repo1DoneIdx);
  });

  it("worktree lock releases after error so next call can proceed", async () => {
    let callCount = 0;

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch") {
        cb(new Error("branch not found"), "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "prune") {
        cb(null, "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "add") {
        callCount++;
        if (callCount === 1) {
          // First call fails
          cb(new Error("fatal: could not open .git/worktrees/x/gitdir"), "", "");
        } else {
          cb(null, "", "");
        }
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    // First call fails
    await expect(createWorktree(repo, "branch-fail", "test-job")).rejects.toThrow();

    // Second call should succeed (lock was released)
    await expect(createWorktree(repo, "branch-ok", "test-job")).resolves.toContain("branch-ok");
  });
});

describe("ensureClone fetch cache", () => {
  const mockFs = vi.mocked(fs);
  const repo = { owner: "test-owner", name: "test-repo", fullName: "test-owner/test-repo", defaultBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
    resetFetchCache();
  });

  it("skips fetch when repo was fetched within TTL and skipFetchIfRecent is true", async () => {
    let fetchCallCount = 0;

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        fetchCallCount++;
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    // First call — should fetch
    await ensureClone(repo, { skipFetchIfRecent: true });
    expect(fetchCallCount).toBe(1);

    // Second call with skipFetchIfRecent — should skip fetch (within TTL)
    await ensureClone(repo, { skipFetchIfRecent: true });
    expect(fetchCallCount).toBe(1);
  });

  it("always fetches when skipFetchIfRecent is not set", async () => {
    let fetchCallCount = 0;

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        fetchCallCount++;
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await ensureClone(repo);
    expect(fetchCallCount).toBe(1);

    // Without skipFetchIfRecent, should always fetch
    await ensureClone(repo);
    expect(fetchCallCount).toBe(2);
  });

  it("re-fetches after TTL expires", async () => {
    let fetchCallCount = 0;
    const now = Date.now();
    const dateNowSpy = vi.spyOn(Date, "now");

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        fetchCallCount++;
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    // First call at t=0
    dateNowSpy.mockReturnValue(now);
    await ensureClone(repo, { skipFetchIfRecent: true });
    expect(fetchCallCount).toBe(1);

    // Second call at t=31min — TTL expired, should re-fetch
    dateNowSpy.mockReturnValue(now + 31 * 60 * 1000);
    await ensureClone(repo, { skipFetchIfRecent: true });
    expect(fetchCallCount).toBe(2);

    dateNowSpy.mockRestore();
  });

  it("fresh clone (gh repo clone path) populates the cache", async () => {
    let fetchCallCount = 0;
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((cmd: any, args: any, ...rest: any[]) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { (rest.at(-1) as any)(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      const cb = rest[rest.length - 1];
      if (typeof cb === "function") {
        if (Array.isArray(args) && args[0] === "fetch") fetchCallCount++;
        cb(null, "", "");
      }
      return undefined as any;
    });

    await ensureClone(repo);

    // Verify cache is populated: a subsequent skipFetchIfRecent call should not fetch
    // Re-mock to handle the existing-clone path (now .git exists after clone)
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    await ensureClone(repo, { skipFetchIfRecent: true });
    expect(fetchCallCount).toBe(0); // no git fetch was called (clone uses gh, not git fetch)
  });

  it("does not cache on fetch error", async () => {
    let fetchCallCount = 0;

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          cb(new Error("network error"), "", "");
        } else {
          cb(null, "", "");
        }
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await expect(ensureClone(repo)).rejects.toThrow("network error");

    // After error, skipFetchIfRecent should still attempt a fetch (no cache entry)
    await ensureClone(repo, { skipFetchIfRecent: true });
    expect(fetchCallCount).toBe(2);
  });

  it("does not cache on fresh clone error", async () => {
    let cloneCallCount = 0;

    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((cmd: any, args: any, ...rest: any[]) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { (rest.at(-1) as any)(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      const cb = rest[rest.length - 1];
      if (typeof cb === "function") {
        if (String(cmd) === "gh") {
          cloneCallCount++;
          if (cloneCallCount === 1) {
            cb(new Error("clone failed: repository not found"));
          } else {
            cb(null, "", "");
          }
        } else {
          cb(null, "", "");
        }
      }
      return undefined as any;
    });

    await expect(ensureClone(repo)).rejects.toThrow("clone failed");

    // After clone error, skipFetchIfRecent should still attempt work (no cache entry)
    await ensureClone(repo, { skipFetchIfRecent: true });
    expect(cloneCallCount).toBe(2);
  });

  it("refreshAllRepos fetches all repos and populates cache", async () => {
    const repos = [
      { owner: "org", name: "repo-a", fullName: "org/repo-a", defaultBranch: "main" },
      { owner: "org", name: "repo-b", fullName: "org/repo-b", defaultBranch: "main" },
    ];
    const fetchedRepos: string[] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        fetchedRepos.push(String(_opts?.cwd ?? ""));
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await refreshAllRepos(repos);

    expect(fetchedRepos).toHaveLength(2);
  });

  it("refreshAllRepos continues after individual repo failure", async () => {
    const repos = [
      { owner: "org", name: "fail-repo", fullName: "org/fail-repo", defaultBranch: "main" },
      { owner: "org", name: "good-repo", fullName: "org/good-repo", defaultBranch: "main" },
    ];
    let fetchCallCount = 0;

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        fetchCallCount++;
        const cwd = String(opts?.cwd ?? "");
        if (cwd.includes("fail-repo")) {
          cb(new Error("network error"), "", "");
        } else {
          cb(null, "", "");
        }
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    // Should not throw
    await refreshAllRepos(repos);

    // Both repos were attempted
    expect(fetchCallCount).toBe(2);

    // Verify only good-repo was cached: calling with skipFetchIfRecent should skip good-repo but retry fail-repo
    fetchCallCount = 0;
    const goodRepo = repos[1];
    const failRepo = repos[0];
    await ensureClone(goodRepo, { skipFetchIfRecent: true });
    expect(fetchCallCount).toBe(0); // cached — skipped

    await expect(ensureClone(failRepo, { skipFetchIfRecent: true })).rejects.toThrow("network error");
    expect(fetchCallCount).toBe(1); // not cached — retried
  });

  it("unshallows a shallow clone before the regular fetch", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      if (s.endsWith(".git/shallow")) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue("7890ba2b9d93b16a4f74cabaecf2b1d4cbc69075\n" as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...(args as string[])]);
      cb(null, "", "");
      return undefined as any;
    });

    await ensureClone(repo);

    const unshallowIdx = gitCalls.findIndex((c) => c[0] === "fetch" && c[1] === "--unshallow");
    const fetchAllIdx = gitCalls.findIndex((c) => c[0] === "fetch" && c[1] === "--all");
    const checkoutIdx = gitCalls.findIndex((c) => c[0] === "checkout");

    expect(unshallowIdx).toBeGreaterThanOrEqual(0);
    expect(unshallowIdx).toBeLessThan(fetchAllIdx);
    expect(unshallowIdx).toBeLessThan(checkoutIdx);
  });

  it("does not unshallow a healthy clone", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...(args as string[])]);
      cb(null, "", "");
      return undefined as any;
    });

    await ensureClone(repo);

    expect(gitCalls.some((c) => c[0] === "fetch" && c[1] === "--unshallow")).toBe(false);
  });

  it("treats an empty .git/shallow file as not shallow", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      if (s.endsWith(".git/shallow")) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue("" as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...(args as string[])]);
      cb(null, "", "");
      return undefined as any;
    });

    await ensureClone(repo);

    expect(gitCalls.some((c) => c[0] === "fetch" && c[1] === "--unshallow")).toBe(false);
  });

  it("skipFetchIfRecent does not short-circuit a shallow clone", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...(args as string[])]);
      cb(null, "", "");
      return undefined as any;
    });

    await ensureClone(repo, { skipFetchIfRecent: true });

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      if (s.endsWith(".git/shallow")) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue("7890ba2b9d93b16a4f74cabaecf2b1d4cbc69075\n" as any);

    await ensureClone(repo, { skipFetchIfRecent: true });

    const fetchAllCalls = gitCalls.filter((c) => c[0] === "fetch" && c[1] === "--all");
    const unshallowCalls = gitCalls.filter((c) => c[0] === "fetch" && c[1] === "--unshallow");
    expect(fetchAllCalls.length).toBe(2);
    expect(unshallowCalls.length).toBe(1);
  });

  it("does not reject ensureClone when --unshallow fails", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      if (s.endsWith(".git/shallow")) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue("7890ba2b9d93b16a4f74cabaecf2b1d4cbc69075\n" as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...(args as string[])]);
      if (args?.[0] === "fetch" && args?.[1] === "--unshallow") {
        cb(new Error("fatal: --unshallow on a complete repository does not make sense"), "", "");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const dir = await ensureClone(repo);

    expect(dir).toBe("/tmp/test-claws/repos/test-owner/test-repo");
    expect(gitCalls.some((c) => c[0] === "checkout")).toBe(true);
  });
});

describe("ensureClone on a Forgejo repo", () => {
  const mockFs = vi.mocked(fs);
  const forgejoRepo = {
    owner: "test-owner",
    name: "test-repo",
    fullName: "test-owner/test-repo",
    defaultBranch: "main",
    forge: "forgejo" as const,
  };
  const githubRepo = { ...forgejoRepo, forge: undefined };
  const FORGEJO_URL = "https://forge.example.com/test-owner/test-repo.git";
  const GITHUB_URL = "https://github.com/test-owner/test-repo.git";

  /** Record every git call; `remote get-url` answers with `originUrl`. */
  function stubGit(originUrl: string): string[][] {
    const gitCalls: string[][] = [];
    mockExecFile.mockImplementation((cmd: any, args: any, _opts: any, cb: any) => {
      if (cmd === "git") gitCalls.push(args);
      if (args?.[0] === "remote" && args?.[1] === "get-url") cb(null, originUrl + "\n", "");
      else cb(null, "", "");
      return undefined as any;
    });
    return gitCalls;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetFetchCache();
    resetWorktreeLocks();
    mockFs.mkdirSync.mockReturnValue(undefined as any);
  });

  it("clones with plain git from the Forgejo URL — gh cannot reach that host", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const gitCalls = stubGit(FORGEJO_URL);

    await ensureClone(forgejoRepo);

    expect(gitCalls).toContainEqual(["clone", FORGEJO_URL, "/tmp/test-claws/repos/test-owner/test-repo"]);
    expect(mockExecFile.mock.calls.some((c: any) => c[0] === "gh")).toBe(false);
  });

  it("still uses gh repo clone for a GitHub repo", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const gitCalls = stubGit(GITHUB_URL);

    await ensureClone(githubRepo);

    expect(gitCalls.some((c) => c[0] === "clone")).toBe(false);
    expect(mockExecFile.mock.calls.some((c: any) => c[0] === "gh" && c[1][0] === "repo")).toBe(true);
  });

  it("re-points an existing clone whose origin predates the migration", async () => {
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith(".git"));
    mockFs.readFileSync.mockReturnValue("" as never);
    const gitCalls = stubGit(GITHUB_URL);

    await ensureClone(forgejoRepo);

    expect(gitCalls).toContainEqual(["remote", "set-url", "origin", FORGEJO_URL]);
    // The re-point happens before the fetch, so the fetch reads the new forge.
    const setUrlAt = gitCalls.findIndex((c) => c[1] === "set-url");
    const fetchAt = gitCalls.findIndex((c) => c[0] === "fetch");
    expect(setUrlAt).toBeGreaterThanOrEqual(0);
    expect(setUrlAt).toBeLessThan(fetchAt);
  });

  it("leaves origin alone when it already points at the right host", async () => {
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith(".git"));
    mockFs.readFileSync.mockReturnValue("" as never);
    const gitCalls = stubGit(FORGEJO_URL);

    await ensureClone(forgejoRepo);

    expect(gitCalls.some((c) => c[1] === "set-url")).toBe(false);
  });

  it("does not re-point a GitHub repo whose origin is already GitHub", async () => {
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith(".git"));
    mockFs.readFileSync.mockReturnValue("" as never);
    const gitCalls = stubGit(GITHUB_URL);

    await ensureClone(githubRepo);

    expect(gitCalls.some((c) => c[1] === "set-url")).toBe(false);
  });
});

describe("createWorktreeFromBranch", () => {
  const mockFs = vi.mocked(fs);
  const repo = { owner: "test-owner", name: "test-repo", fullName: "test-owner/test-repo", defaultBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses namespace-scoped local branch to avoid cross-job collisions", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...args]);
      if (args?.[0] === "fetch") {
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch" && args?.[1] === "-D") {
        cb(null, "", "");
      } else if (args?.[0] === "rev-parse") {
        cb(null, "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "add") {
        cb(null, "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "prune") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await createWorktreeFromBranch(repo, "dependabot/npm/eslint-10", "ci-fixer");

    // Verify branch -D was called with namespace-scoped name before worktree add
    const branchCall = gitCalls.find((c) => c[0] === "branch" && c[1] === "-D");
    const worktreeCall = gitCalls.find((c) => c[0] === "worktree" && c[1] === "add");
    expect(branchCall).toBeDefined();
    expect(branchCall).toEqual(["branch", "-D", "claws-wt/ci-fixer/dependabot/npm/eslint-10"]);
    expect(worktreeCall).toBeDefined();
    expect(worktreeCall).toEqual([
      "worktree", "add", "-b", "claws-wt/ci-fixer/dependabot/npm/eslint-10",
      expect.stringContaining("ci-fixer/dependabot/npm/eslint-10"),
      "--no-track",
      "origin/dependabot/npm/eslint-10",
    ]);

    // branch -D must come before worktree add
    const branchIdx = gitCalls.indexOf(branchCall!);
    const worktreeIdx = gitCalls.indexOf(worktreeCall!);
    expect(branchIdx).toBeLessThan(worktreeIdx);
  });

  it("proceeds normally when scoped local branch does not exist yet", async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "fetch") {
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch" && args?.[1] === "-D") {
        // Branch doesn't exist locally — git branch -D fails
        cb(new Error("error: branch not found"), "", "");
      } else if (args?.[0] === "rev-parse") {
        cb(null, "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "add") {
        cb(null, "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "prune") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const result = await createWorktreeFromBranch(repo, "new-branch", "ci-fixer");
    expect(result).toContain("new-branch");
  });

  it("different namespaces produce different local branch names for the same remote branch", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...args]);
      cb(null, "", "");
      return undefined as any;
    });

    await createWorktreeFromBranch(repo, "claws/issue-889-8e7c", "pr-reviewer");
    await createWorktreeFromBranch(repo, "claws/issue-889-8e7c", "ci-fixer");

    const worktreeCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "add");
    expect(worktreeCalls).toHaveLength(2);
    // Each uses a different namespace-scoped local branch
    expect(worktreeCalls[0][3]).toBe("claws-wt/pr-reviewer/claws/issue-889-8e7c");
    expect(worktreeCalls[1][3]).toBe("claws-wt/ci-fixer/claws/issue-889-8e7c");
  });

  it("detach mode uses --detach and skips local branch creation", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...args]);
      cb(null, "", "");
      return undefined as any;
    });

    await createWorktreeFromBranch(repo, "feature/some-pr", "pr-reviewer", { detach: true });

    // Should NOT call branch -D (no local branch in detach mode)
    const branchCall = gitCalls.find((c) => c[0] === "branch" && c[1] === "-D");
    expect(branchCall).toBeUndefined();

    // Should use --detach with origin/<branch>
    const worktreeCall = gitCalls.find((c) => c[0] === "worktree" && c[1] === "add");
    expect(worktreeCall).toBeDefined();
    expect(worktreeCall).toEqual([
      "worktree", "add", "--detach",
      expect.stringContaining("pr-reviewer/feature/some-pr"),
      "origin/feature/some-pr",
    ]);
  });

  it("defensive fallback retries with --detach on 'already used by worktree' error", async () => {
    const gitCalls: string[][] = [];
    let worktreeAddCallCount = 0;

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      gitCalls.push([...args]);
      if (args?.[0] === "worktree" && args?.[1] === "add") {
        worktreeAddCallCount++;
        if (worktreeAddCallCount === 1) {
          // First worktree add fails with branch-already-used error
          cb(new Error("git worktree add failed: fatal: 'claws-wt/ci-fixer/feat' is already used by worktree at '/tmp/other'"), "", "already used by worktree");
        } else {
          // Retry with --detach succeeds
          cb(null, "", "");
        }
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const result = await createWorktreeFromBranch(repo, "feat", "ci-fixer");
    expect(result).toContain("feat");

    // Should have two worktree add calls: the original and the --detach retry
    const worktreeCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "add");
    expect(worktreeCalls).toHaveLength(2);
    // Second call should use --detach
    expect(worktreeCalls[1]).toEqual([
      "worktree", "add", "--detach",
      expect.stringContaining("ci-fixer/feat"),
      "origin/feat",
    ]);
  });

  it("throws when remote ref does not exist (branch deleted after merge)", async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "rev-parse" && args?.[1] === "--verify") {
        // Simulate deleted remote branch — rev-parse fails
        cb(new Error("fatal: Needed a single revision"), "", "fatal: Needed a single revision");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await expect(
      createWorktreeFromBranch(repo, "dependabot/npm/lodash-4.0", "pr-reviewer", { detach: true }),
    ).rejects.toThrow("Remote ref origin/dependabot/npm/lodash-4.0 does not exist (branch may have been deleted after merge)");
  });

  it("non-matching errors still throw without fallback", async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "worktree" && args?.[1] === "add") {
        cb(new Error("git worktree add failed: fatal: some other error"), "", "some other error");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await expect(createWorktreeFromBranch(repo, "feat", "ci-fixer")).rejects.toThrow("some other error");
  });
});

describe("createWorktreeFromBranchIfExists", () => {
  const mockFs = vi.mocked(fs);
  const repo = { owner: "test-owner", name: "test-repo", fullName: "test-owner/test-repo", defaultBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when remote ref does not exist", async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "rev-parse" && args?.[1] === "--verify") {
        cb(new Error("fatal: Needed a single revision"), "", "fatal: Needed a single revision");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const result = await createWorktreeFromBranchIfExists(repo, "dependabot/npm/lodash-4.0", "pr-reviewer");
    expect(result).toBeUndefined();
  });

  it("returns worktree path on success", async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      // Every git call succeeds, including the origin read ensureClone now does.
      cb(null, "", "");
      return undefined as any;
    });

    const result = await createWorktreeFromBranchIfExists(repo, "feature/foo", "ci-fixer");
    expect(result).toContain("feature/foo");
  });

  it("rethrows non-matching errors", async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      // ensureClone reads origin before fetching so a clone taken before a
      // forge migration is re-pointed (#2650).
      if (args?.[0] === "remote") { cb(null, "https://github.com/test-owner/test-repo.git", ""); return undefined as any; }
      if (args?.[0] === "worktree" && args?.[1] === "add") {
        cb(new Error("git worktree add failed: fatal: some other error"), "", "some other error");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await expect(createWorktreeFromBranchIfExists(repo, "feat", "ci-fixer")).rejects.toThrow("some other error");
  });
});

describe("removeWorktree", () => {
  const mockFs = vi.mocked(fs);
  const repo = { owner: "test-owner", name: "test-repo", fullName: "test-owner/test-repo", defaultBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes namespace-scoped local branch after removing worktree", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args?.[0] === "rev-parse" && args?.[1] === "--abbrev-ref") {
        cb(null, "claws-wt/ci-fixer/feat/my-branch\n", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "remove") {
        cb(null, "", "");
      } else if (args?.[0] === "branch" && args?.[1] === "-D") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await removeWorktree(repo, "/tmp/some-worktree");

    const branchDelete = gitCalls.find((c) => c[0] === "branch" && c[1] === "-D");
    expect(branchDelete).toEqual(["branch", "-D", "claws-wt/ci-fixer/feat/my-branch"]);

    expect(mockFs.rmSync).toHaveBeenCalledWith(
      agentMcpDir("/tmp/some-worktree"),
      { recursive: true, force: true },
    );
  });

  it("skips branch cleanup for non-scoped branches", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args?.[0] === "rev-parse" && args?.[1] === "--abbrev-ref") {
        cb(null, "feat/regular-branch\n", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "remove") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await removeWorktree(repo, "/tmp/some-worktree");

    const branchDelete = gitCalls.find((c) => c[0] === "branch" && c[1] === "-D");
    expect(branchDelete).toBeUndefined();
  });
});

describe("pushBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches, rebases, and pushes HEAD to remote branch", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      cb(null, "", "");
      return undefined as any;
    });

    await pushBranch("/tmp/worktree", "feat/my-branch");

    expect(gitCalls[0]).toEqual(["fetch", "origin", "refs/heads/feat/my-branch:refs/remotes/origin/feat/my-branch"]);
    expect(gitCalls[1]).toEqual(["rebase", "--rebase-merges", "origin/feat/my-branch"]);
    expect(gitCalls[2]).toEqual(["push", "-u", "origin", "HEAD:feat/my-branch"]);
  });

  it("skips rebase when fetch fails (new branch)", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args[0] === "fetch") {
        const err = Object.assign(new Error("fatal: couldn't find remote ref"), { code: 128 });
        cb(err, "", "fatal: couldn't find remote ref");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await pushBranch("/tmp/worktree", "claws/issue-42-ab12");

    expect(gitCalls[0]).toEqual(["fetch", "origin", "refs/heads/claws/issue-42-ab12:refs/remotes/origin/claws/issue-42-ab12"]);
    expect(gitCalls[1]).toEqual(["push", "-u", "origin", "HEAD:claws/issue-42-ab12"]);
  });

  it("keeps a dash-leading branch name out of git option position", async () => {
    const gitCalls: string[][] = [];
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      cb(null, "", "");
      return undefined as any;
    });

    await pushBranch("/tmp/worktree", "--upload-pack=touch /tmp/pwned");

    expect(gitCalls[0]).toEqual([
      "fetch",
      "origin",
      "refs/heads/--upload-pack=touch /tmp/pwned:refs/remotes/origin/--upload-pack=touch /tmp/pwned",
    ]);
    expect(gitCalls[0]).not.toContain("--upload-pack=touch /tmp/pwned");
  });

  it("retries on non-fast-forward push rejection", async () => {
    const gitCalls: string[][] = [];
    let pushCount = 0;

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args[0] === "push") {
        pushCount++;
        if (pushCount === 1) {
          const err = Object.assign(new Error("push failed"), { code: 1 });
          cb(err, "", "! [rejected] HEAD -> feat/x (non-fast-forward)\nerror: failed to push some refs");
        } else {
          cb(null, "", "");
        }
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await pushBranch("/tmp/worktree", "feat/x");

    // First attempt: fetch, rebase, push (fails)
    // Second attempt: fetch, rebase, push (succeeds)
    expect(gitCalls.map(c => c[0])).toEqual(["fetch", "rebase", "push", "fetch", "rebase", "push"]);
  });

  it("throws on non-retryable push error without retrying", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args[0] === "push") {
        const err = Object.assign(new Error("push failed"), { code: 128 });
        cb(err, "", "fatal: could not read Username: terminal prompts disabled");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await expect(pushBranch("/tmp/worktree", "feat/x")).rejects.toThrow(
      "git push -u origin HEAD:feat/x failed in /tmp/worktree",
    );

    // Should not retry — only one fetch/rebase/push cycle
    expect(gitCalls.map(c => c[0])).toEqual(["fetch", "rebase", "push"]);
  });

  it("throws after all retry attempts are exhausted", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args[0] === "push") {
        const err = Object.assign(new Error("push failed"), { code: 1 });
        cb(err, "", "! [rejected] HEAD -> feat/x (non-fast-forward)\nerror: failed to push some refs");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const err = await pushBranch("/tmp/worktree", "feat/x").catch(e => e);
    expect(err).toBeInstanceOf(PushConflictError);
    expect(err.message).toContain(
      "rejected after retries exhausted",
    );

    // All 3 attempts: fetch, rebase, push each time
    expect(gitCalls.map(c => c[0])).toEqual([
      "fetch", "rebase", "push",
      "fetch", "rebase", "push",
      "fetch", "rebase", "push",
    ]);
  });

  it("retries on ref-lock push rejection", async () => {
    const gitCalls: string[][] = [];
    let pushCount = 0;

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args[0] === "push") {
        pushCount++;
        if (pushCount === 1) {
          const err = Object.assign(new Error("push failed"), { code: 1 });
          cb(
            err,
            "",
            " ! [remote rejected] HEAD -> feat/x (cannot lock ref 'refs/heads/feat/x': reference already exists)\nerror: failed to push some refs",
          );
        } else {
          cb(null, "", "");
        }
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await pushBranch("/tmp/worktree", "feat/x");

    // First attempt: fetch, rebase, push (fails)
    // Second attempt: fetch, rebase, push (succeeds)
    expect(gitCalls.map(c => c[0])).toEqual(["fetch", "rebase", "push", "fetch", "rebase", "push"]);
  });

  it("throws PushConflictError when ref-lock rejection persists", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args[0] === "push") {
        const err = Object.assign(new Error("push failed"), { code: 1 });
        cb(
          err,
          "",
          " ! [remote rejected] HEAD -> feat/x (cannot lock ref 'refs/heads/feat/x': reference already exists)\nerror: failed to push some refs",
        );
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const err = await pushBranch("/tmp/worktree", "feat/x").catch(e => e);
    expect(err).toBeInstanceOf(PushConflictError);
    expect(err.message).toContain("rejected after retries exhausted");

    // All 3 attempts: fetch, rebase, push each time
    expect(gitCalls.map(c => c[0])).toEqual([
      "fetch", "rebase", "push",
      "fetch", "rebase", "push",
      "fetch", "rebase", "push",
    ]);
  });

  it("falls back to merge when rebase conflicts", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args[0] === "rebase" && args.includes("--rebase-merges")) {
        const err = Object.assign(new Error("conflict"), { code: 1 });
        cb(err, "", "CONFLICT (content): Merge conflict in file.ts");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await pushBranch("/tmp/worktree", "feat/x");

    // Verify command sequence: fetch, rebase, rebase --abort, merge, push
    expect(gitCalls.map(c => c[0])).toEqual([
      "fetch", "rebase", "rebase", "merge", "push",
    ]);
    expect(gitCalls[2]).toEqual(["rebase", "--abort"]);
    expect(gitCalls[3]).toEqual(["merge", "origin/feat/x", "--no-edit"]);
  });

  it("throws when both rebase and merge conflict", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args[0] === "rebase" && args.includes("--rebase-merges")) {
        const err = Object.assign(new Error("conflict"), { code: 1 });
        cb(err, "", "CONFLICT (content): Merge conflict in file.ts");
      } else if (args[0] === "merge" && args[1]?.startsWith("origin/")) {
        const err = Object.assign(new Error("conflict"), { code: 1 });
        cb(err, "", "CONFLICT (content): Merge conflict in file.ts");
      } else {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const promise = pushBranch("/tmp/worktree", "feat/x");
    await expect(promise).rejects.toThrow(
      "Rebase onto origin/feat/x failed (conflicting concurrent changes)",
    );
    await expect(promise).rejects.toBeInstanceOf(PushConflictError);

    // Verify: fetch, rebase, rebase --abort, merge, merge --abort
    expect(gitCalls.map(c => c[0])).toEqual([
      "fetch", "rebase", "rebase", "merge", "merge",
    ]);
    expect(gitCalls[2]).toEqual(["rebase", "--abort"]);
    expect(gitCalls[4]).toEqual(["merge", "--abort"]);
  });
});

describe("git transient retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExecFile.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on transient HTTP 500 error and succeeds", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        cb(new Error("fetch failed"), "", "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500");
      } else {
        cb(null, "success\n", "");
      }
      return undefined as any;
    });

    const promise = git(["fetch", "--all", "--prune"], "/tmp/repo");
    // Advance past the 1s retry delay
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe("success");
    expect(callCount).toBe(2);
  });

  it("retries with exponential backoff delays", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount <= 2) {
        cb(new Error("fetch failed"), "", "HTTP 502 Bad Gateway");
      } else {
        cb(null, "ok\n", "");
      }
      return undefined as any;
    });

    const promise = git(["fetch", "origin"], "/tmp/repo");
    // First retry after 1s
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(2);
    // Second retry after 2s
    await vi.advanceTimersByTimeAsync(2000);
    expect(callCount).toBe(3);
    const result = await promise;
    expect(result).toBe("ok");
  });

  it("does not retry on non-transient errors", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      callCount++;
      cb(new Error("not a git repo"), "", "fatal: not a git repository");
      return undefined as any;
    });

    await expect(git(["status"], "/tmp/repo")).rejects.toThrow("fatal: not a git repository");
    expect(callCount).toBe(1);
  });

  it("exhausts retries and rejects with last error", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      callCount++;
      cb(new Error("fetch failed"), "", "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500");
      return undefined as any;
    });

    const promise = git(["fetch", "--all"], "/tmp/repo");
    // Attach catch handler immediately to prevent unhandled rejection during timer advancement
    const caught = promise.catch((e: Error) => e);
    // Advance through all retry delays at once
    await vi.advanceTimersByTimeAsync(5000);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("The requested URL returned error: 500");
    expect(callCount).toBe(3); // initial + 2 retries
  });

  it("retries on ECONNRESET errors", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        cb(new Error("fetch failed"), "", "fatal: unable to access: ECONNRESET");
      } else {
        cb(null, "done\n", "");
      }
      return undefined as any;
    });

    const promise = git(["fetch", "origin", "main"], "/tmp/repo");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe("done");
    expect(callCount).toBe(2);
  });

  it("retries on an SSH connect timeout and succeeds", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        cb(
          new Error("fetch failed"),
          "",
          "ssh: connect to host github.com port 22: Connection timed out\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
        );
      } else {
        cb(null, "done\n", "");
      }
      return undefined as any;
    });

    const promise = git(["fetch", "--all", "--prune"], "/tmp/repo");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe("done");
    expect(callCount).toBe(2);
  });

  it("retries on kex_exchange_identification connection reset", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        cb(new Error("fetch failed"), "", "kex_exchange_identification: banner exchange: fatal error");
      } else {
        cb(null, "done\n", "");
      }
      return undefined as any;
    });

    const promise = git(["fetch", "--all", "--prune"], "/tmp/repo");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe("done");
    expect(callCount).toBe(2);
  });

  it("retries on a ref-lock race from a concurrent fetch in a worktree", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        cb(
          new Error("fetch failed"),
          "",
          "error: cannot lock ref 'refs/remotes/origin/main': is at 7bd3835d8cd3039b84c191bdc807c53423161ea6 but expected 4ff8307e5a8e7a762c159c74caa56a2f56f40058\n ! 4ff8307..7bd3835  main -> origin/main  (unable to update local ref)",
        );
      } else {
        cb(null, "done\n", "");
      }
      return undefined as any;
    });

    const promise = git(["fetch", "--all", "--prune"], "/tmp/repo");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe("done");
    expect(callCount).toBe(2);
  });

  it("does not retry on SSH auth failures", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      callCount++;
      cb(new Error("fetch failed"), "", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.");
      return undefined as any;
    });

    await expect(git(["fetch", "--all"], "/tmp/repo")).rejects.toThrow("Permission denied");
    expect(callCount).toBe(1);
  });
});

describe("git() identity env", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockMintToken.mockReset();
    mockBuildGitEnvForOwner.mockReset();
  });

  it("injects the default author/committer identity when no owner is given", async () => {
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      cb(null, "ok\n", "");
      return undefined as any;
    });

    await git(["commit", "-m", "x"], "/tmp/repo");

    const env = mockExecFile.mock.calls[0][2]!.env!;
    expect(env.GIT_AUTHOR_EMAIL).toBe("276932287+clawsstjohn[bot]@users.noreply.github.com");
    expect(env.GIT_COMMITTER_EMAIL).toBe("276932287+clawsstjohn[bot]@users.noreply.github.com");
    expect(env.GIT_AUTHOR_NAME).toBe("clawsstjohn[bot]");
    expect(env.GIT_COMMITTER_NAME).toBe("clawsstjohn[bot]");
  });

  it("carries auth vars alongside the identity vars when an owner is given", async () => {
    mockBuildGitEnvForOwner.mockResolvedValue({
      ...process.env,
      GH_TOKEN: "ghs_test",
      GITHUB_TOKEN: "ghs_test",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "!helper",
    });
    mockExecFile.mockImplementation((_cmd, _args: any, _opts: any, cb: any) => {
      cb(null, "ok\n", "");
      return undefined as any;
    });

    await git(["commit", "-m", "x"], "/tmp/repo", { owner: "St-John-Software" });

    expect(mockBuildGitEnvForOwner).toHaveBeenCalledWith("St-John-Software");
    const env = mockExecFile.mock.calls[0][2]!.env!;
    expect(env.GH_TOKEN).toBe("ghs_test");
    expect(env.GIT_CONFIG_KEY_0).toBeTruthy();
    expect(env.GIT_AUTHOR_EMAIL).toBe("276932287+clawsstjohn[bot]@users.noreply.github.com");
    expect(env.GIT_COMMITTER_EMAIL).toBe("276932287+clawsstjohn[bot]@users.noreply.github.com");
  });
});

describe("AgentCliError", () => {
  it("extracts subtype and result from JSON output", () => {
    const err = new AgentCliError(
      JSON.stringify({ subtype: "error_during_execution", result: "some error text", is_error: true }),
      1,
    );
    expect(err.message).toBe("[error_during_execution] some error text");
  });

  it("extracts subtype only when result is absent", () => {
    const err = new AgentCliError(
      JSON.stringify({ subtype: "error_during_execution", is_error: true, num_turns: 0 }),
      1,
      0,
    );
    expect(err.message).toBe("[error_during_execution]");
  });

  it("preserves raw message for non-JSON output", () => {
    const err = new AgentCliError("You\u2019re out of extra usage \u00b7 resets 5pm", 1);
    expect(err.message).toBe("You\u2019re out of extra usage \u00b7 resets 5pm");
  });

  it("truncates long result to 500 characters", () => {
    const longResult = "x".repeat(600);
    const err = new AgentCliError(
      JSON.stringify({ subtype: "error_during_execution", result: longResult }),
      1,
    );
    expect(err.message.length).toBe(500);
  });
});

describe("sanitiseEnvForChild", () => {
  it("strict mode strips sensitive keys but preserves safe ones", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/test",
      PATH: "/usr/bin",
      CLAWS_AUTH_TOKEN: "tok123",
      CLAWS_OIDC_CLIENT_SECRET: "oidcsecret",
      GH_TOKEN: "ghtoken",
    };
    const result = sanitiseEnvForChild(env, "strict");
    expect(result).not.toHaveProperty("CLAWS_AUTH_TOKEN");
    expect(result).not.toHaveProperty("CLAWS_OIDC_CLIENT_SECRET");
    expect(result.HOME).toBe("/home/test");
    expect(result.PATH).toBe("/usr/bin");
    expect(result.GH_TOKEN).toBe("ghtoken");
  });

  it("passthrough mode returns an identical copy", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/test",
      CLAWS_OIDC_CLIENT_SECRET: "oidcsecret",
      CLAWS_AUTH_TOKEN: "tok123",
    };
    const result = sanitiseEnvForChild(env, "passthrough");
    expect(result).toEqual(env);
    expect(result).not.toBe(env); // must be a copy, not the same reference
  });

  it("strict mode does not modify the original env", () => {
    const env: NodeJS.ProcessEnv = { CLAWS_AUTH_TOKEN: "tok123" };
    sanitiseEnvForChild(env, "strict");
    expect(env.CLAWS_AUTH_TOKEN).toBe("tok123");
  });

  it("SENSITIVE_ENV_KEYS includes expected secrets", () => {
    const keys = SENSITIVE_ENV_KEYS as readonly string[];
    expect(keys).toContain("CLAWS_AUTH_TOKEN");
    expect(keys).toContain("OPENAI_API_KEY");
    expect(keys).toContain("CLAWS_HOME_ASSISTANT_TOKEN");
    expect(keys).toContain("CLAWS_OIDC_CLIENT_SECRET");
    expect(keys).toContain("CLAWS_SLACK_WEBHOOK");
    expect(keys).toContain("CLAWS_FORGEJO_ADMIN_TOKEN");
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("GH_TOKEN");
    expect(keys).not.toContain("HOME");
  });

  it("strict mode strips the opt-in Forgejo admin token (#2965)", () => {
    const env: NodeJS.ProcessEnv = {
      CLAWS_FORGEJO_ADMIN_TOKEN: "admin-tok",
      CLAWS_FORGEJO_TOKEN: "tok",
    };
    const result = sanitiseEnvForChild(env, "strict");
    expect(result).not.toHaveProperty("CLAWS_FORGEJO_ADMIN_TOKEN");
    expect(result).not.toHaveProperty("CLAWS_FORGEJO_TOKEN");
  });
});

describe("agent call sites that post output do not opt into passthrough env sanitization", () => {
  it.each([
    "src/agents/issue-worker.ts",
    "src/agents/ci-fixer.ts",
    "src/agents/review-addresser.ts",
    "src/agents/pr-reviewer.ts",
  ])("%s has no envSanitization: \"passthrough\"", async (relativePath) => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const source = realFs.readFileSync(relativePath, "utf8");
    expect(source).not.toContain('envSanitization: "passthrough"');
  });
});

describe("agent call sites in repo worktrees authenticate gh via the App installation token", () => {
  // The reviewed set: every `src/agents/` runClaude call that plans on, or writes to, a
  // repo checkout under an explicit issue/PR mandate. Counted per file so a single call
  // site can't silently drop the option while the file still mentions it once.
  // The issue worker authenticates as the repo its PR is opened in, which for a
  // multi-repo issue's step may be another of the issue's repos.
  it.each([
    ["src/agents/issue-refiner.ts", 4, "forgejoAccessRepo: repo.fullName", "githubTokenOwner: repo.owner"],
    ["src/agents/issue-worker.ts", 1, "forgejoAccessRepo: prFullName", "githubTokenOwner: prRepo.owner"],
    ["src/agents/ci-fixer.ts", 3, "forgejoAccessRepo: repo.fullName", "githubTokenOwner: repo.owner"],
    ["src/agents/review-addresser.ts", 1, "forgejoAccessRepo: repo.fullName", "githubTokenOwner: repo.owner"],
    ["src/agents/pr-reviewer.ts", 5, "forgejoAccessRepo: repo.fullName", "githubTokenOwner: repo.owner"],
    ["src/agents/problematic-pr-diagnoser.ts", 1, "forgejoAccessRepo: fullName", "githubTokenOwner: repo.owner"],
  ])("%s sets githubTokenOwner and forgejoAccessRepo at %i call site(s)", async (relativePath, expected, forgejoAccessRepoPattern, githubTokenOwnerPattern) => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const source = realFs.readFileSync(relativePath, "utf8");
    expect(source.split(githubTokenOwnerPattern).length - 1).toBe(expected);
    expect(source.split(forgejoAccessRepoPattern).length - 1).toBe(expected);
  });

  // Widening the set is a security decision, not a mechanical one: an installation token
  // is owner-wide (#2246), so handing one to an agent that reads lower-trust content
  // needs its own review. Fail loudly if a new call site appears without one.
  it("does not hand the token to any call site outside the reviewed set", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const reviewed = new Set([
      "issue-refiner.ts",
      "issue-worker.ts",
      "ci-fixer.ts",
      "review-addresser.ts",
      "pr-reviewer.ts",
      "problematic-pr-diagnoser.ts",
    ]);
    const unexpected: string[] = [];
    for (const dir of ["src/agents", "src/jobs"]) {
      for (const name of realFs.readdirSync(dir)) {
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        if (dir === "src/agents" && reviewed.has(name)) continue;
        const contents = realFs.readFileSync(`${dir}/${name}`, "utf8");
        if (contents.includes("githubTokenOwner") || contents.includes("forgejoAccessRepo")) {
          unexpected.push(`${dir}/${name}`);
        }
      }
    }
    expect(unexpected).toEqual([]);
  });
});

describe("tool-restricted call sites disable provider fallback", () => {
  // `disallowedTools` is Claude-CLI-only; codex/opencode silently ignore it, so a
  // tool-restricted call site must also refuse to fall back to them (#2882). This
  // is enforced structurally in runClaudeInner, but call sites should still set
  // the flag explicitly so the intent is visible locally — fail loudly if a new
  // call site adds `disallowedTools` without it.
  it("every disallowedTools call site also sets noProviderFallback: true", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const unexpected: string[] = [];
    for (const dir of ["src/agents", "src/jobs"]) {
      for (const name of realFs.readdirSync(dir)) {
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        const source = realFs.readFileSync(`${dir}/${name}`, "utf8");
        if (source.includes("disallowedTools:") && !source.includes("noProviderFallback: true")) {
          unexpected.push(`${dir}/${name}`);
        }
      }
    }
    expect(unexpected).toEqual([]);
  });
});

describe("GitHub token injection into agent child processes", () => {
  // Strict-mode sanitisation deliberately does NOT strip GH_TOKEN/GITHUB_TOKEN
  // (they are not in SENSITIVE_ENV_KEYS), so an ambient value exported by the
  // developer's shell would flow straight into the child env and break the
  // "omitted" assertions below. Drop them for this block, restore afterwards.
  const savedGhEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN"]) {
      savedGhEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedGhEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    mockShuttingDown = false;
    mockRunCtxId = undefined;
    clearProviderRateLimitState();
    mockMintToken.mockReset();
    delete process.env["CLAWS_PROMPT_CAPTURE"];
  });

  it("injects GH_TOKEN/GITHUB_TOKEN into the spawned child env when githubTokenOwner is set", async () => {
    mockMintToken.mockResolvedValue("ghs_test");

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", {
      tier: "sonnet",
      provider: "claude",
      githubTokenOwner: "St-John-Software",
    });

    await new Promise((r) => setTimeout(r, 0));
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    await promise;

    expect(mockMintToken).toHaveBeenCalledWith("St-John-Software");
    const env = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][2]!.env!;
    expect(env.GH_TOKEN).toBe("ghs_test");
    expect(env.GITHUB_TOKEN).toBe("ghs_test");
  });

  it("does not set GH_TOKEN/GITHUB_TOKEN when githubTokenOwner is omitted", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude" });

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    await promise;

    expect(mockMintToken).not.toHaveBeenCalled();
    const env = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][2].env;
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("injects the git author/committer identity into the spawned child env", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", provider: "claude" });

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    await promise;

    const env = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][2]!.env!;
    expect(env.GIT_AUTHOR_EMAIL).toBe("276932287+clawsstjohn[bot]@users.noreply.github.com");
    expect(env.GIT_COMMITTER_EMAIL).toBe("276932287+clawsstjohn[bot]@users.noreply.github.com");
  });

  it("degrades to ambient auth and logs an error when minting fails", async () => {
    mockMintToken.mockRejectedValue(new Error("installation not found"));

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", {
      tier: "sonnet",
      provider: "claude",
      githubTokenOwner: "St-John-Software",
    });

    await new Promise((r) => setTimeout(r, 0));
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    const result = await promise;

    expect(result).toBe("ok");
    const env = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][2].env;
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(logModule.error).toHaveBeenCalledTimes(1);
  });

  it("never writes the minted token into the prompt capture log", async () => {
    process.env["CLAWS_PROMPT_CAPTURE"] = "1";
    mockMintToken.mockResolvedValue("ghs_test");

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", {
      tier: "sonnet",
      provider: "claude",
      githubTokenOwner: "St-John-Software",
    });

    await new Promise((r) => setTimeout(r, 0));
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    await promise;

    const [, line] = vi.mocked(fs.promises.appendFile).mock.calls[vi.mocked(fs.promises.appendFile).mock.calls.length - 1]!;
    expect(String(line)).not.toContain("ghs_test");
  });
});

describe("Forgejo access for headless agent runs (#3067)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["CLAWS_FORGEJO_TOKEN", "CLAWS_FORGEJO_READ_TOKEN", "CLAWS_FORGEJO_BASE_URL", "KUBECONFIG"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    vi.mocked(fs.promises.appendFile).mockClear();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    mockForgejoRepos.list = [];
    clearProviderRateLimitState();
    mockMintToken.mockReset();
    delete process.env["CLAWS_PROMPT_CAPTURE"];
  });

  async function runAndCapture(options: Parameters<typeof runClaude>[2]): Promise<{ env: NodeJS.ProcessEnv; args: string[] }> {
    mockMintToken.mockResolvedValue("ghs_test");
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", options);
    await new Promise((r) => setTimeout(r, 0));
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);
    await promise;

    const call = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    return { env: call[2]!.env!, args: call[1] as string[] };
  }

  function appendedSystemPrompt(args: string[]): string {
    const idx = args.indexOf("--append-system-prompt");
    return idx >= 0 ? args[idx + 1]! : "";
  }

  it("injects the Forgejo env and guidance exactly once for a Forgejo working repo", async () => {
    mockForgejoRepos.list = ["St-John-Software/forgejo"];
    const { env, args } = await runAndCapture({
      tier: "sonnet",
      provider: "claude",
      appendSystemPrompt: "agent doc",
      githubTokenOwner: "St-John-Software",
      forgejoAccessRepo: "St-John-Software/forgejo",
    });

    expect(env.CLAWS_FORGEJO_TOKEN).toBe("fgj_test_token");
    expect(env.CLAWS_FORGEJO_READ_TOKEN).toBe("fgj_read_test_token");
    expect(env.CLAWS_FORGEJO_BASE_URL).toBe("https://forge.example.com");
    const system = appendedSystemPrompt(args);
    expect(system.startsWith("agent doc\n\n## Cross-repo access")).toBe(true);
    expect(system).toContain("## Forgejo access");
    expect(system.split("## Cross-repo access").length - 1).toBe(1);
    expect(system.split("## Forgejo access").length - 1).toBe(1);
    expect(system).toContain("This repository is hosted on Forgejo");
    expect(system).not.toContain("fgj_test_token");
    expect(system).not.toContain("fgj_read_test_token");
  });

  it("injects cross-repo guidance for ordinary shell-capable runs", async () => {
    mockForgejoRepos.list = ["St-John-Software/forgejo"];
    const { env, args } = await runAndCapture({
      tier: "sonnet",
      provider: "claude",
    });

    expect(env).not.toHaveProperty("CLAWS_FORGEJO_TOKEN");
    expect(env.CLAWS_FORGEJO_READ_TOKEN).toBe("fgj_read_test_token");
    expect(env.CLAWS_FORGEJO_BASE_URL).toBe("https://forge.example.com");
    const system = appendedSystemPrompt(args);
    expect(system.startsWith("## Cross-repo access")).toBe(true);
    expect(system).toContain("gh api repos/OWNER/NAME/contents/DIR");
    expect(system).toContain("$CLAWS_FORGEJO_READ_TOKEN");
  });

  it("does not grant push-capable Forgejo access for a GitHub working repo", async () => {
    mockForgejoRepos.list = ["Other-Org/forgejo"];
    const { env, args } = await runAndCapture({
      tier: "sonnet",
      provider: "claude",
      forgejoAccessRepo: "St-John-Software/fleet-infra",
    });

    expect(env).not.toHaveProperty("CLAWS_FORGEJO_TOKEN");
    expect(env.CLAWS_FORGEJO_READ_TOKEN).toBe("fgj_read_test_token");
    const system = appendedSystemPrompt(args);
    expect(system).toContain("## Cross-repo access");
    expect(system).not.toContain("## Forgejo access");
  });

  it("still strips an ambient push token when forgejoAccessRepo is omitted", async () => {
    mockForgejoRepos.list = ["St-John-Software/forgejo"];
    process.env["CLAWS_FORGEJO_TOKEN"] = "ambient_forgejo_token";
    const { env } = await runAndCapture({ tier: "sonnet", provider: "claude" });

    expect(env).not.toHaveProperty("CLAWS_FORGEJO_TOKEN");
  });

  it("strips ambient planner capability env when the capability is not granted", async () => {
    process.env["KUBECONFIG"] = "/ambient/kubeconfig";
    const { env } = await runAndCapture({ tier: "sonnet", provider: "claude" });

    expect(env).not.toHaveProperty("KUBECONFIG");
  });

  it("omits cross-repo guidance and env for Bash-denied runs", async () => {
    const { env, args } = await runAndCapture({ tier: "sonnet", provider: "claude", disallowedTools: ["Bash"] });

    expect(env).not.toHaveProperty("CLAWS_FORGEJO_READ_TOKEN");
    expect(env).not.toHaveProperty("CLAWS_FORGEJO_BASE_URL");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("never writes the Forgejo token into the prompt capture log", async () => {
    process.env["CLAWS_PROMPT_CAPTURE"] = "1";
    mockForgejoRepos.list = ["St-John-Software/forgejo"];
    await runAndCapture({
      tier: "sonnet",
      provider: "claude",
      forgejoAccessRepo: "St-John-Software/forgejo",
    });

    const calls = vi.mocked(fs.promises.appendFile).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, line] of calls) {
      expect(String(line)).not.toContain("fgj_test_token");
      expect(String(line)).not.toContain("fgj_read_test_token");
    }
  });

  it("injects planner capability env and appends read-only diagnostic guidance", async () => {
    process.env["KUBECONFIG"] = "/ambient/kubeconfig";
    const { env, args } = await runAndCapture({
      tier: "sonnet",
      provider: "claude",
      appendSystemPrompt: "agent doc",
      plannerCapabilities: ["prod-infra"],
    });

    expect(env.KUBECONFIG).toBe("/secret/prod.kubeconfig");
    const system = appendedSystemPrompt(args);
    expect(system).toContain("agent doc");
    expect(system).toContain("## Cross-repo access");
    expect(system).toContain("## Planner diagnostic capabilities");
    expect(system).toContain("Prod infra (kubectl)");
    expect(system).toContain("read-only diagnosis");
    expect(system).toContain("kubectl logs");
    expect(system).toContain("kubectl apply");
    expect(system).not.toContain("/secret/prod.kubeconfig");
  });

  it("does not inject planner capability env or guidance for Bash-denied runs", async () => {
    process.env["KUBECONFIG"] = "/ambient/kubeconfig";
    const { env, args } = await runAndCapture({
      tier: "sonnet",
      provider: "claude",
      plannerCapabilities: ["prod-infra"],
      disallowedTools: ["Bash"],
    });

    expect(env).not.toHaveProperty("KUBECONFIG");
    expect(appendedSystemPrompt(args)).not.toContain("Planner diagnostic capabilities");
  });

  it("never writes planner capability env values into the prompt capture log", async () => {
    process.env["CLAWS_PROMPT_CAPTURE"] = "1";
    await runAndCapture({
      tier: "sonnet",
      provider: "claude",
      plannerCapabilities: ["prod-infra"],
    });

    const calls = vi.mocked(fs.promises.appendFile).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, line] of calls) {
      expect(String(line)).not.toContain("/secret/prod.kubeconfig");
    }
  });
});

describe("writeClawsMcpConfig", () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes MCP config with mode 0o600 and calls chmodSync", () => {
    const cwd = "/tmp/test-worktree";
    const configPath = "/tmp/test-worktree/.mcp-claws.json";

    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.chmodSync.mockReturnValue(undefined);

    const result = writeClawsMcpConfig(cwd, { includeHomeAssistant: true });

    expect(result).toBe(configPath);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining("mcpServers"),
      { mode: 0o600 }
    );
    expect(mockFs.chmodSync).toHaveBeenCalledWith(configPath, 0o600);
  });

  it("omits Home Assistant env vars by default", () => {
    const cwd = "/tmp/test-worktree";

    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.chmodSync.mockReturnValue(undefined);

    writeClawsMcpConfig(cwd);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
    const env = written.mcpServers["claws-state"].env;
    expect(env).not.toHaveProperty("HOME_ASSISTANT_BASE_URL");
    expect(env).not.toHaveProperty("HOME_ASSISTANT_TOKEN");
  });

  it("includes Home Assistant env vars when includeHomeAssistant is true", () => {
    const cwd = "/tmp/test-worktree";

    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.chmodSync.mockReturnValue(undefined);

    writeClawsMcpConfig(cwd, { includeHomeAssistant: true });

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
    const env = written.mcpServers["claws-state"].env;
    expect(env.HOME_ASSISTANT_BASE_URL).toBe("https://homeassistant.home.example.net");
    expect(env.HOME_ASSISTANT_TOKEN).toBe("test-ha-token");
  });

  it("includes the claws-state server by default", () => {
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.chmodSync.mockReturnValue(undefined);

    writeClawsMcpConfig("/tmp/test-worktree");

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers).toHaveProperty("claws-state");
  });

  it("omits the claws-state server when includeClawsState is false", () => {
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.chmodSync.mockReturnValue(undefined);

    writeClawsMcpConfig("/tmp/test-worktree", {
      includeClawsState: false,
      additionalServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } },
    });

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers).not.toHaveProperty("claws-state");
    expect(Object.keys(written.mcpServers)).toEqual(["playwright"]);
  });

  it("includes CLAWS_MCP_SESSION_ID when sessionId is passed", () => {
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.chmodSync.mockReturnValue(undefined);

    writeClawsMcpConfig("/tmp/test-worktree", { sessionId: "abc123" });

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
    const env = written.mcpServers["claws-state"].env;
    expect(env.CLAWS_MCP_SESSION_ID).toBe("abc123");
  });

  it("omits CLAWS_MCP_SESSION_ID when sessionId is not passed", () => {
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.chmodSync.mockReturnValue(undefined);

    writeClawsMcpConfig("/tmp/test-worktree");

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
    const env = written.mcpServers["claws-state"].env;
    expect(env).not.toHaveProperty("CLAWS_MCP_SESSION_ID");
  });
});

describe("writeCodexMcpHomeForRun", () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdirSync.mockReturnValue(undefined as any);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.chmodSync.mockReturnValue(undefined);
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ mcpServers: { "claws-state": { command: "node", args: ["mcp.js"] } } }));
  });

  it("disables the startup update check ahead of the MCP servers block (#3312)", () => {
    writeCodexMcpHomeForRun("/tmp/test-mcp/mcp.json");

    const configPath = "/tmp/test-mcp/codex-home/config.toml";
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining("check_for_update_on_startup = false"),
      { mode: 0o600 },
    );
    const body = mockFs.writeFileSync.mock.calls.find((call) => call[0] === configPath)![1] as string;
    expect(body.startsWith("check_for_update_on_startup = false\n")).toBe(true);
    expect(body).toContain("[mcp_servers.claws-state]");
  });
});

describe("writeAgentMcpConfig", () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdirSync.mockReturnValue(undefined as any);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.chmodSync.mockReturnValue(undefined);
  });

  it("writes outside the worktree", () => {
    const wtPath = "/tmp/test-claws/worktrees/o/r/issue-worker/claws/x-1";
    const result = writeAgentMcpConfig(wtPath, { includeHomeAssistant: true });

    expect(result.startsWith("/tmp/test-claws/agent-mcp/")).toBe(true);
    expect(result.endsWith("/.mcp-claws.json")).toBe(true);
    expect(result).not.toContain("worktrees");
  });

  it("creates the scratch dir 0700", () => {
    const wtPath = "/tmp/test-claws/worktrees/o/r/issue-worker/claws/x-1";
    const dir = agentMcpDir(wtPath);

    writeAgentMcpConfig(wtPath);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(mockFs.chmodSync).toHaveBeenCalledWith(dir, 0o700);
  });

  it("is deterministic per worktree path and preserves config content", () => {
    const wtPathA = "/tmp/test-claws/worktrees/o/r/issue-worker/claws/x-1";
    const wtPathB = "/tmp/test-claws/worktrees/o/r/issue-worker/claws/x-2";

    const resultA1 = writeAgentMcpConfig(wtPathA, { includeHomeAssistant: true });
    const resultA2 = writeAgentMcpConfig(wtPathA, { includeHomeAssistant: true });
    const resultB = writeAgentMcpConfig(wtPathB, { includeHomeAssistant: true });

    expect(resultA1).toBe(resultA2);
    expect(resultA1).not.toBe(resultB);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers["claws-state"].env.HOME_ASSISTANT_TOKEN).toBe("test-ha-token");
  });
});

describe("removeAgentMcpDir", () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes the agent MCP dir for a worktree path", () => {
    const wtPath = "/tmp/test-claws/worktrees/o/r/n/b";

    removeAgentMcpDir(wtPath);

    expect(mockFs.rmSync).toHaveBeenCalledWith(agentMcpDir(wtPath), { recursive: true, force: true });
  });

  it("does not throw when rmSync throws", () => {
    mockFs.rmSync.mockImplementation(() => { throw new Error("boom"); });

    expect(() => removeAgentMcpDir("/tmp/test-claws/worktrees/o/r/n/b")).not.toThrow();
  });
});

describe("agent output file", () => {
  const mockFs = vi.mocked(fs);
  const enoent = () => Object.assign(new Error("no such file or directory"), { code: "ENOENT" });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockShuttingDown = false;
    clearProviderRateLimitState();
  });

  describe("readAgentOutputFile", () => {
    it("returns the file's contents instead of the fallback when non-empty", () => {
      mockFs.readFileSync.mockReturnValueOnce("FILE CONTENT");
      expect(readAgentOutputFile("/tmp/test-claws/agent-output/x.md", "fallback")).toBe("FILE CONTENT");
    });

    it("returns the fallback when the file is missing", () => {
      mockFs.readFileSync.mockImplementationOnce(() => { throw enoent(); });
      expect(readAgentOutputFile("/tmp/test-claws/agent-output/x.md", "fallback")).toBe("fallback");
    });

    it("returns the fallback when the file is whitespace-only", () => {
      mockFs.readFileSync.mockReturnValueOnce("   \n\t  ");
      expect(readAgentOutputFile("/tmp/test-claws/agent-output/x.md", "fallback")).toBe("fallback");
    });
  });

  describe("buildOutputFileInstruction", () => {
    it("names the path and states the ignore rule", () => {
      const instruction = buildOutputFileInstruction("/tmp/test-claws/agent-output/x.md");
      expect(instruction).toContain("/tmp/test-claws/agent-output/x.md");
      expect(instruction).toContain("is IGNORED whenever that file is non-empty");
    });
  });

  it("uses the agent's output file instead of a stray final assistant message (#2948 regression)", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", useOutputFile: true, captureLabel: "test" });

    const sentPrompt = stdinMock.write.mock.calls[0]?.[0] as string;
    const match = sentPrompt.match(/`(\S+agent-output\S+\.md)`/);
    expect(match).not.toBeNull();
    const outputFilePath = match![1];

    mockFs.readFileSync.mockImplementation((p: unknown) => {
      if (p === outputFilePath) return "THE REAL PLAN";
      throw enoent();
    });

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "stray note", is_error: false })));
    child.emit("close", 0, null);

    expect(await promise).toBe("THE REAL PLAN");
  });

  it("falls back to the assistant message when the agent never writes the file", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);
    mockFs.readFileSync.mockImplementation(() => { throw enoent(); });

    const promise = runClaude("test prompt", "/tmp", { tier: "sonnet", useOutputFile: true, captureLabel: "test" });

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "stray note", is_error: false })));
    child.emit("close", 0, null);

    expect(await promise).toBe("stray note");

    const outputFileRmCalls = mockFs.rmSync.mock.calls.filter(([p]) => typeof p === "string" && p.includes("agent-output"));
    expect(outputFileRmCalls.length).toBeGreaterThan(0);
  });

  it("ignores useOutputFile and warns when disallowedTools denies Write", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", {
      tier: "sonnet", useOutputFile: true, captureLabel: "test", disallowedTools: ["Write"],
    });

    const sentPrompt = stdinMock.write.mock.calls[0]?.[0] as string;
    expect(sentPrompt).not.toContain("agent-output");
    expect(vi.mocked(logModule.warn)).toHaveBeenCalledWith(expect.stringContaining("useOutputFile ignored"));

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "stray note", is_error: false })));
    child.emit("close", 0, null);

    expect(await promise).toBe("stray note");
  });
});

describe("agent verdict file (#3155)", () => {
  const mockFs = vi.mocked(fs);
  const enoent = () => Object.assign(new Error("no such file or directory"), { code: "ENOENT" });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockShuttingDown = false;
    clearProviderRateLimitState();
  });

  const startRun = (extra: Partial<Parameters<typeof runClaude>[2]> = {}) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);
    const seen: (string | null)[] = [];
    const promise = runClaude("test prompt", "/tmp", {
      tier: "sonnet", captureLabel: "test",
      verdictFile: { docs: "DOCS-SENTINEL", onVerdict: (raw) => { seen.push(raw); } },
      ...extra,
    });
    const sentPrompt = stdinMock.write.mock.calls[0]?.[0] as string;
    const finish = () => {
      stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "the plan", is_error: false })));
      child.emit("close", 0, null);
    };
    return { promise, sentPrompt, finish, seen };
  };

  describe("agentVerdictFilePath", () => {
    it("lands in the agent-output dir so pruneAgentOutputDir sweeps strays", () => {
      const p = agentVerdictFilePath("planner");
      expect(p).toContain("agent-output");
      expect(p).toMatch(/planner-verdict-\d+-\w+\.json$/);
    });
  });

  describe("buildVerdictFileInstruction", () => {
    it("names the path, carries the caller's docs, and states the safety rules", () => {
      const instruction = buildVerdictFileInstruction("/tmp/test-claws/agent-output/x-verdict-1.json", "DOCS-SENTINEL");
      expect(instruction).toContain("/tmp/test-claws/agent-output/x-verdict-1.json");
      expect(instruction).toContain("DOCS-SENTINEL");
      expect(instruction).toContain("do NOT create the file at all");
      expect(instruction).toContain(`unparseable file means "no outcome to report"`);
      expect(instruction).toContain("EXACTLY ONE JSON object");
      expect(instruction).toContain("Nothing is stripped from your written response");
      // The response file stays the last thing the agent writes — buildOutputFileInstruction
      // is appended first and says so.
      expect(instruction).toContain("Write this file BEFORE your final response file");
    });

    it("forbids naming the FILE in the response without forbidding the verdict values", () => {
      const instruction = buildVerdictFileInstruction("/tmp/test-claws/agent-output/x-verdict-1.json", "DOCS-SENTINEL");
      expect(instruction).toContain("Never name this file or its path in your written response");
      expect(instruction).not.toContain("or any of the verdict values");
    });
  });

  describe("readAgentVerdictFile", () => {
    it("returns the file's contents when non-empty", () => {
      mockFs.readFileSync.mockReturnValueOnce(`{"verdict":"blocked"}`);
      expect(readAgentVerdictFile("/tmp/test-claws/agent-output/x-verdict-1.json")).toBe(`{"verdict":"blocked"}`);
    });

    it("returns null when the file is missing", () => {
      mockFs.readFileSync.mockImplementationOnce(() => { throw enoent(); });
      expect(readAgentVerdictFile("/tmp/test-claws/agent-output/x-verdict-1.json")).toBeNull();
    });

    it("returns null when the file is whitespace-only", () => {
      mockFs.readFileSync.mockReturnValueOnce("  \n\t ");
      expect(readAgentVerdictFile("/tmp/test-claws/agent-output/x-verdict-1.json")).toBeNull();
    });
  });

  it("names the verdict path in the prompt and hands the written file to onVerdict", async () => {
    mockFs.readFileSync.mockImplementation(() => { throw enoent(); });
    const { promise, sentPrompt, finish, seen } = startRun();

    const match = sentPrompt.match(/`(\S+agent-output\S+-verdict-\S+\.json)`/);
    expect(match).not.toBeNull();
    const verdictFilePath = match![1];
    expect(sentPrompt).toContain("DOCS-SENTINEL");

    mockFs.readFileSync.mockImplementation((p: unknown) => {
      if (p === verdictFilePath) return `{"verdict":"duplicate","duplicate_of":458}`;
      throw enoent();
    });

    finish();
    expect(await promise).toBe("the plan");
    expect(seen).toEqual([`{"verdict":"duplicate","duplicate_of":458}`]);
  });

  it("passes null to onVerdict when the agent writes no file", async () => {
    mockFs.readFileSync.mockImplementation(() => { throw enoent(); });
    const { promise, finish, seen } = startRun();

    finish();
    expect(await promise).toBe("the plan");
    expect(seen).toEqual([null]);
  });

  it("removes the verdict file after the run", async () => {
    mockFs.readFileSync.mockImplementation(() => { throw enoent(); });
    const { promise, sentPrompt, finish } = startRun();
    const verdictFilePath = sentPrompt.match(/`(\S+agent-output\S+-verdict-\S+\.json)`/)![1];

    finish();
    await promise;

    expect(mockFs.rmSync).toHaveBeenCalledWith(verdictFilePath, { force: true });
  });

  it("ignores verdictFile and warns when disallowedTools denies Write", async () => {
    mockFs.readFileSync.mockImplementation(() => { throw enoent(); });
    const { promise, sentPrompt, finish, seen } = startRun({ disallowedTools: ["Write"] });

    expect(sentPrompt).not.toContain("-verdict-");
    expect(sentPrompt).not.toContain("DOCS-SENTINEL");
    expect(vi.mocked(logModule.warn)).toHaveBeenCalledWith(expect.stringContaining("verdictFile ignored"));

    finish();
    await promise;
    expect(seen).toEqual([]);
  });

  it("never invokes onVerdict when the run throws, even with a readable verdict file", async () => {
    mockFs.readFileSync.mockImplementation((f: unknown) => {
      if (typeof f === "string" && f.includes("-verdict-")) return `{"verdict":"blocked"}`;
      throw enoent();
    });
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const seen: (string | null)[] = [];
    const promise = runClaude("test prompt", "/tmp", {
      tier: "sonnet", captureLabel: "test",
      verdictFile: { docs: "DOCS-SENTINEL", onVerdict: (raw) => { seen.push(raw); } },
    });
    child.emit("error", new Error("spawn failed"));

    await expect(promise).rejects.toThrow("Failed to spawn claude");
    expect(seen).toEqual([]);
  });

  it("clears the verdict file before EVERY attempt, so a failed attempt's verdict never reaches the retry", async () => {
    vi.useFakeTimers();
    try {
      mockFs.readFileSync.mockImplementation(() => { throw enoent(); });

      const child1 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdin1 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child1, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: stdin1, kill: vi.fn(), pid: 1 });

      const child2 = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout2 = new EventEmitter();
      const stdin2 = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child2, { stdout: stdout2, stderr: new EventEmitter(), stdin: stdin2, kill: vi.fn(), pid: 2 });

      let verdictPath = "";
      let rmCountAtSecondSpawn = -1;
      mockSpawn
        .mockImplementationOnce(() => child1 as any)
        .mockImplementationOnce(() => {
          verdictPath = (stdin1.write.mock.calls[0][0] as string).match(/`(\S+agent-output\S+-verdict-\S+\.json)`/)![1];
          rmCountAtSecondSpawn = mockFs.rmSync.mock.calls.filter((c: unknown[]) => c[0] === verdictPath).length;
          return child2 as any;
        });

      const seen: (string | null)[] = [];
      const promise = runClaude("test prompt", "/tmp", {
        tier: "sonnet", captureLabel: "test",
        verdictFile: { docs: "DOCS-SENTINEL", onVerdict: (raw) => { seen.push(raw); } },
      });

      // First attempt hangs with 0 bytes of output — runWithRetry re-dispatches.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      child1.emit("close", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(0);
      stdout2.emit("data", Buffer.from(JSON.stringify({ result: "second attempt plan", is_error: false })));
      child2.emit("close", 0, null);

      expect(await promise).toBe("second attempt plan");
      // Once before the first attempt, once more before the retry.
      expect(rmCountAtSecondSpawn).toBe(2);
      expect(seen).toEqual([null]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readRepoAgentDoc", () => {
  const mockFs = vi.mocked(fs);
  const enoent = () => Object.assign(new Error("no such file or directory"), { code: "ENOENT" });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns body content after stripping YAML frontmatter", () => {
    mockFs.readFileSync.mockReturnValue(
      "---\nname: issue-refiner\ntools: all\n---\nYou are a planning agent.\n\nHelp refine issues.",
    );
    const result = readRepoAgentDoc("/repo/wt", "issue-refiner");
    expect(result).toBe("You are a planning agent.\n\nHelp refine issues.");
  });

  it("returns full content when there is no frontmatter", () => {
    mockFs.readFileSync.mockReturnValue("You are a planning agent.\n\nHelp refine issues.");
    const result = readRepoAgentDoc("/repo/wt", "issue-refiner");
    expect(result).toBe("You are a planning agent.\n\nHelp refine issues.");
  });

  it("returns undefined when the file does not exist", () => {
    mockFs.readFileSync.mockImplementation(() => { throw enoent(); });
    const result = readRepoAgentDoc("/repo/wt", "issue-refiner");
    expect(result).toBeUndefined();
    expect(mockFs.readFileSync).toHaveBeenCalledWith("/repo/wt/.agents/issue-refiner.md", "utf8");
  });

  it("returns undefined when file contains only frontmatter", () => {
    mockFs.readFileSync.mockReturnValue("---\nname: issue-refiner\n---\n");
    const result = readRepoAgentDoc("/repo/wt", "issue-refiner");
    expect(result).toBeUndefined();
  });

  it("returns undefined when file body is empty after trim", () => {
    mockFs.readFileSync.mockReturnValue("---\nname: issue-refiner\n---\n   \n");
    const result = readRepoAgentDoc("/repo/wt", "issue-refiner");
    expect(result).toBeUndefined();
  });

  it("reads .agents/<role>.md", () => {
    mockFs.readFileSync.mockReturnValue("canonical agent content");

    expect(readRepoAgentDoc("/repo/wt", "pr-reviewer")).toBe("canonical agent content");
    expect(mockFs.readFileSync).toHaveBeenCalledWith(
      "/repo/wt/.agents/pr-reviewer.md",
      "utf8",
    );
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when .agents is empty after frontmatter stripping", () => {
    mockFs.readFileSync.mockReturnValue("---\nname: issue-refiner\n---\n");

    expect(readRepoAgentDoc("/repo/wt", "issue-refiner")).toBeUndefined();
    expect(mockFs.readFileSync).toHaveBeenNthCalledWith(1, "/repo/wt/.agents/issue-refiner.md", "utf8");
    expect(mockFs.readFileSync).toHaveBeenCalledOnce();
  });

  it("warns and returns undefined when reading .agents fails with a non-ENOENT error", () => {
    const warn = vi.mocked(logModule.warn);
    mockFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("/.agents/issue-refiner.md")) {
        throw new Error("permission denied");
      }
      return "";
    });

    expect(readRepoAgentDoc("/repo/wt", "issue-refiner")).toBeUndefined();
    expect(mockFs.readFileSync).toHaveBeenNthCalledWith(1, "/repo/wt/.agents/issue-refiner.md", "utf8");
    expect(mockFs.readFileSync).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unexpected error reading .agents/issue-refiner.md"),
    );
  });
});

describe("parseCodexJsonOutput", () => {
  const evt = (o: unknown) => JSON.stringify(o);

  it("returns the agent message and the summed token usage", () => {
    const stdout = [
      evt({ type: "thread.started", thread_id: "t1" }),
      evt({ type: "turn.started" }),
      evt({ type: "item.completed", item: { type: "reasoning", text: "thinking..." } }),
      evt({ type: "item.completed", item: { type: "agent_message", text: "Here is the plan." } }),
      evt({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 7 },
      }),
    ].join("\n");

    const result = parseCodexJsonOutput(stdout);

    expect(result.text).toBe("Here is the plan.");
    expect(result.errors).toEqual([]);
    expect(result.tokensUsed).toBe(132);
    // Codex reports no price at all — cost is recorded as zero, not omitted.
    expect(result.costUsd).toBe(0);
  });

  it("returns the last agent message when the turn emits several", () => {
    const stdout = [
      evt({ type: "item.completed", item: { type: "agent_message", text: "first, intermediate" } }),
      evt({ type: "item.completed", item: { type: "command_execution", command: "ls" } }),
      evt({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
    ].join("\n");

    expect(parseCodexJsonOutput(stdout).text).toBe("final answer");
  });

  it("surfaces turn.failed as an error", () => {
    const stdout = [
      evt({ type: "turn.started" }),
      evt({ type: "turn.failed", error: { message: "model refused" } }),
    ].join("\n");

    const result = parseCodexJsonOutput(stdout);
    expect(result.errors).toEqual(["model refused"]);
    expect(result.text).toBe("");
  });

  it("falls back to a generic message when turn.failed carries no error text", () => {
    expect(parseCodexJsonOutput(evt({ type: "turn.failed" })).errors).toEqual(["turn failed"]);
  });

  it("surfaces error events", () => {
    const stdout = evt({ type: "error", message: "stream disconnected" });
    expect(parseCodexJsonOutput(stdout).errors).toEqual(["stream disconnected"]);
  });

  it("ignores non-JSON lines instead of throwing", () => {
    const stdout = [
      "codex 0.118.0 starting",
      "{not json",
      "",
      evt({ type: "item.completed", item: { type: "agent_message", text: "still parsed" } }),
      "trailing banner",
    ].join("\n");

    expect(() => parseCodexJsonOutput(stdout)).not.toThrow();
    expect(parseCodexJsonOutput(stdout).text).toBe("still parsed");
  });

  it("returns empty text with no usage for output with no events", () => {
    const result = parseCodexJsonOutput("");
    expect(result.text).toBe("");
    expect(result.errors).toEqual([]);
    expect(result.tokensUsed).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
  });
});

describe("readRepoInstructions", () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const enoent = () => Object.assign(new Error("no such file or directory"), { code: "ENOENT" });

  it("reads AGENTS.md and ignores CLAUDE.md", () => {
    mockFs.readFileSync.mockImplementation((p: unknown) =>
      String(p).endsWith("AGENTS.md") ? "agents content" : "claude content",
    );

    expect(readRepoInstructions("/repo/wt")).toBe("agents content");
    expect(mockFs.readFileSync).toHaveBeenCalledWith("/repo/wt/AGENTS.md", "utf8");
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when AGENTS.md is absent, even if CLAUDE.md exists", () => {
    mockFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("AGENTS.md")) throw enoent();
      return "claude content";
    });

    expect(readRepoInstructions("/repo/wt")).toBeUndefined();
  });

  it("returns undefined when AGENTS.md is empty, even if CLAUDE.md exists", () => {
    mockFs.readFileSync.mockImplementation((p: unknown) =>
      String(p).endsWith("AGENTS.md") ? "   \n" : "claude content",
    );

    expect(readRepoInstructions("/repo/wt")).toBeUndefined();
  });

  it("returns undefined when the file does not exist", () => {
    mockFs.readFileSync.mockImplementation(() => { throw enoent(); });

    expect(readRepoInstructions("/repo/wt")).toBeUndefined();
  });

  it("warns and returns undefined on a non-ENOENT read error", () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    expect(readRepoInstructions("/repo/wt")).toBeUndefined();
    expect(vi.mocked(logModule.warn)).toHaveBeenCalledWith(expect.stringContaining("AGENTS.md"));
  });

  it("truncates a file larger than 32 KiB", () => {
    mockFs.readFileSync.mockReturnValue("x".repeat(40000));

    const result = readRepoInstructions("/repo/wt");

    expect(result).toHaveLength(32768);
    expect(vi.mocked(logModule.warn)).toHaveBeenCalledWith(expect.stringContaining("truncating"));
  });
});

describe("repo context injection for non-Claude backends", () => {
  const mockFs = vi.mocked(fs);

  // Spawns a codex run and returns the prompt actually written to the child's stdin.
  async function codexPromptFor(options: Record<string, unknown> = {}): Promise<string> {
    setMockAiProviders(["codex"]);
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("do the thing", "/repo/wt", {
        tier: "sonnet",
        provider: "codex",
        ...options,
      });
      await Promise.resolve();
      stdoutEmitter.emit("data", Buffer.from(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\n",
      ));
      child.emit("close", 0, null);
      await promise;

      return stdinMock.write.mock.calls[0]![0] as string;
    } finally {
      resetMockAiProviders();
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    });
  });

  it("leaves the prompt untouched when there are no repo instructions and no agent role-capability context", async () => {
    expect(await codexPromptFor({ disallowedTools: ["Bash"] })).toBe("do the thing");
  });

  it("inlines implicit cross-repo guidance as agent-role context", async () => {
    const prompt = await codexPromptFor();

    expect(prompt).toContain("<agent-role>\n## Cross-repo access");
    expect(prompt).toContain("gh api repos/OWNER/NAME/contents/DIR");
    expect(prompt).toContain("$CLAWS_FORGEJO_READ_TOKEN");
    expect(prompt).toMatch(/\n<\/agent-role>\n\ndo the thing$/);
  });

  it("wraps AGENTS.md in <repository-instructions> ahead of the prompt", async () => {
    mockFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("AGENTS.md")) return "Build with npm test.";
      throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    });

    const prompt = await codexPromptFor({ disallowedTools: ["Bash"] });

    expect(prompt).toBe(
      "<repository-instructions>\nBuild with npm test.\n</repository-instructions>\n\ndo the thing",
    );
  });

  it("wraps appendSystemPrompt in <agent-role>, which codex has no flag for", async () => {
    const prompt = await codexPromptFor({
      appendSystemPrompt: "You are a reviewer.",
      disallowedTools: ["Bash"],
    });

    expect(prompt).toBe("<agent-role>\nYou are a reviewer.\n</agent-role>\n\ndo the thing");
  });

  it("puts repo instructions before the agent role, and both before the prompt", async () => {
    mockFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("AGENTS.md")) return "Repo rules.";
      throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    });

    const prompt = await codexPromptFor({
      appendSystemPrompt: "Role text.",
      disallowedTools: ["Bash"],
    });

    expect(prompt).toBe(
      "<repository-instructions>\nRepo rules.\n</repository-instructions>\n\n" +
      "<agent-role>\nRole text.\n</agent-role>\n\n" +
      "do the thing",
    );
  });

  it("wraps AGENTS.md ahead of the prompt for opencode too", async () => {
    setMockAiProviders(["opencode"]);
    mockFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("AGENTS.md")) return "Build with npm test.";
      throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    });
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("do the thing", "/repo/wt", {
        tier: "sonnet",
        provider: "opencode",
        disallowedTools: ["Bash"],
      });
      const jsonLine = JSON.stringify({ type: "text", part: { text: "done" } });
      stdoutEmitter.emit("data", Buffer.from(jsonLine + "\n"));
      child.emit("close", 0, null);
      await promise;

      expect(stdinMock.write).toHaveBeenCalledWith(
        "<repository-instructions>\nBuild with npm test.\n</repository-instructions>\n\ndo the thing",
      );
    } finally {
      resetMockAiProviders();
    }
  });
});

describe("process-tree helpers (memory watchdog)", () => {
  const mockReaddir = vi.mocked(fs.readdirSync);
  const mockReadFile = vi.mocked(fs.readFileSync);

  let procEntries: string[] = [];
  const procStat = new Map<number, string>();
  const procStatus = new Map<number, string>();

  // stat layout: `<pid> (<comm>) <state> <ppid> ...`
  const statLine = (pid: number, comm: string, ppid: number) =>
    `${pid} (${comm}) S ${ppid} 0 0 0 -1 0 0 0`;
  // /proc/PID/status VmRSS line (always in kB, portable across page sizes)
  const statusLine = (rssKb: number) => `Name:\tnode\nVmRSS:\t${rssKb} kB\n`;

  let restorePlatform: (() => void) | undefined;
  const setPlatform = (value: NodeJS.Platform) => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value, configurable: true });
    restorePlatform = () =>
      Object.defineProperty(process, "platform", { value: original, configurable: true });
  };

  beforeEach(() => {
    procEntries = [];
    procStat.clear();
    procStatus.clear();
    mockReaddir.mockImplementation(((p: unknown) =>
      p === "/proc" ? procEntries : []) as unknown as typeof fs.readdirSync);
    mockReadFile.mockImplementation(((p: unknown) => {
      const m = /^\/proc\/(\d+)\/(stat|status)$/.exec(String(p));
      if (m) {
        const map = m[2] === "stat" ? procStat : procStatus;
        const pid = Number(m[1]);
        if (map.has(pid)) return map.get(pid)!;
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }) as unknown as typeof fs.readFileSync);
  });

  afterEach(() => {
    restorePlatform?.();
    restorePlatform = undefined;
    mockReaddir.mockReset();
    mockReadFile.mockReset();
  });

  it("collectProcessTreePids returns root plus descendants, leaf-first", () => {
    setPlatform("linux");
    // tree: node(100) → claude(200) → openscad(300); 400 is unrelated.
    procEntries = ["1", "100", "200", "300", "400", "not-a-pid"];
    procStat.set(1, statLine(1, "init", 0));
    procStat.set(100, statLine(100, "node", 1));
    procStat.set(200, statLine(200, "claude", 100));
    procStat.set(300, statLine(300, "openscad", 200));
    procStat.set(400, statLine(400, "unrelated", 1));

    expect(collectProcessTreePids(100)).toEqual([300, 200, 100]);
  });

  it("parses ppid when comm contains spaces and parens", () => {
    setPlatform("linux");
    procEntries = ["500", "600"];
    procStat.set(500, statLine(500, "root", 1));
    // comm itself contains ") (" — only lastIndexOf(")") yields the right ppid.
    procStat.set(600, statLine(600, "weird) (name", 500));

    expect(collectProcessTreePids(500)).toEqual([600, 500]);
  });

  it("sampleProcessTreeRssBytes sums VmRSS kB across the tree", () => {
    setPlatform("linux");
    procEntries = ["100", "200", "300"];
    procStat.set(100, statLine(100, "node", 1));
    procStat.set(200, statLine(200, "claude", 100));
    procStat.set(300, statLine(300, "openscad", 200));
    procStatus.set(100, statusLine(10));
    procStatus.set(200, statusLine(20));
    procStatus.set(300, statusLine(30));

    expect(sampleProcessTreeRssBytes(100)).toBe((10 + 20 + 30) * 1024);
  });

  it("ignores a process that exits mid-scan (status read fails)", () => {
    setPlatform("linux");
    procEntries = ["100", "200"];
    procStat.set(100, statLine(100, "node", 1));
    procStat.set(200, statLine(200, "claude", 100));
    procStatus.set(100, statusLine(10));
    // 200 has no status entry → read throws → skipped.

    expect(sampleProcessTreeRssBytes(100)).toBe(10 * 1024);
  });

  it("no-ops off Linux", () => {
    setPlatform("darwin");
    expect(collectProcessTreePids(123)).toEqual([123]);
    expect(sampleProcessTreeRssBytes(123)).toBe(0);
  });
});
