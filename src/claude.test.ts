import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  WORK_DIR: "/tmp/test-claws",
  PROMPT_CAPTURE_DIR: "/tmp/fake-default-capture-dir",
  CLAUDE_TIMEOUT_MS: 20 * 60 * 1000,
  CLAUDE_LIVENESS_TIMEOUT_MS: 10 * 60 * 1000,
  CLAUDE_WORKER_MEMORY_MAX_BYTES: 1_610_612_736,
  TOOL_USE_PROVIDER_FALLBACK_ORDER: ["claude"],
  TEXT_ONLY_PROVIDER_FALLBACK_ORDER: ["opencode"],
  PROVIDER_RATE_LIMIT_COOLDOWN_MS: 300_000,
  OPENROUTER_API_KEY: "",
  SERVER_PORT: 3456,
  INTERNAL_MCP_TOKEN: "a".repeat(64),
  NAMEY_DB_URL: "postgresql://readonly:pass@db.example.com:5432/names",
  HOME_ASSISTANT_BASE_URL: "https://homeassistant.home.example.net",
  HOME_ASSISTANT_TOKEN: "test-ha-token",
}));
vi.mock("./model-selector.js", async () => {
  const configMod = await import("./config.js") as unknown as Record<string, unknown>;
  return {
    getModel: () => "sonnet",
    getFallbackOrder: (capability: "tool-use" | "text-only") =>
      capability === "text-only"
        ? configMod["TEXT_ONLY_PROVIDER_FALLBACK_ORDER"]
        : configMod["TOOL_USE_PROVIDER_FALLBACK_ORDER"],
  };
});
vi.mock("./ollama-rate-limit-classifier.js", () => ({ isRateLimitError: vi.fn().mockResolvedValue(false) }));

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

import { randomSuffix, datestamp, hasNewCommits, getCommitCount, getDiffStats, generatePRDescription, generateDocsPRDescription, regeneratePRDescription, runClaude, cancelCurrentTask, cancelTaskByRunId, createWorktree, createWorktreeFromBranch, createWorktreeFromBranchIfExists, removeWorktree, pushBranch, ensureClone, resetFetchCache, resetWorktreeLocks, refreshAllRepos, AgentTimeoutError, AgentCliError, AgentMemoryLimitError, OpenRouterClientError, PushConflictError, git, isProviderRateLimited, markProviderRateLimited, clearProviderRateLimitState, sanitiseEnvForChild, SENSITIVE_ENV_KEYS, readRepoAgentDoc, collectProcessTreePids, sampleProcessTreeRssBytes, writeClawsMcpConfig } from "./claude.js";
import { isRateLimitError } from "./ollama-rate-limit-classifier.js";
import { ShutdownError } from "./shutdown.js";
import * as shutdown from "./shutdown.js";
import * as logModule from "./log.js";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

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

    const promise = runClaude("test prompt", "/tmp", { capability: "tool-use", tier: "sonnet", model: "sonnet" });

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
      capability: "tool-use",
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
    expect(onTokensUsed).toHaveBeenCalledWith(165, 0.0123);
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
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["codex"];
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

      const promise = runClaude("test prompt", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "codex" });

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
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
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

  it("rejects with signal error for non-SIGTERM signals during shutdown", async () => {
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
    stderrEmitter.emit("data", Buffer.from("killed"));
    child.emit("close", null, "SIGKILL");

    await expect(promise).rejects.toThrow("claude was killed by signal SIGKILL");
  });

  it("rejects when killed by signal (not via cancelCurrentTask)", async () => {
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
    stdoutEmitter.emit("data", Buffer.from("partial"));
    stderrEmitter.emit("data", Buffer.from("some error"));
    child.emit("close", null, "SIGTERM");

    await expect(promise).rejects.toThrow("claude was killed by signal SIGTERM");
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
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["codex"];
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

      // With tier required, model is always derived from tier via getModel (mocked to "sonnet" in tests).
      // The explicit model option is overridden by the tier-derived model.
      const promise = runClaude("test prompt", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "codex", model: "o3" });

      expect(mockSpawn).toHaveBeenCalledWith(
        "codex",
        expect.arrayContaining(["exec", "--dangerously-bypass-approvals-and-sandbox", "-m", "sonnet"]),
        expect.objectContaining({ cwd: "/tmp" }),
      );

      stdoutEmitter.emit("data", Buffer.from("codex output text"));
      child.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("codex output text");
      expect(stdinMock.write).toHaveBeenCalledWith("test prompt");
      expect(stdinMock.end).toHaveBeenCalled();
    } finally {
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
    }
  });

  it("codex logs debug warning when mcpConfig is passed", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["codex"];
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

      const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "codex", mcpConfig: "/tmp/.mcp-claws.json" });

      // mcpConfig should NOT be passed to the codex spawn args
      expect(mockSpawn).toHaveBeenCalledWith(
        "codex",
        expect.not.arrayContaining(["--mcp-config"]),
        expect.objectContaining({ cwd: "/tmp" }),
      );

      expect(logModule.debug).toHaveBeenCalledWith(
        expect.stringContaining("MCP config is not supported by Codex backend"),
      );

      stdoutEmitter.emit("data", Buffer.from("output"));
      child.emit("close", 0, null);

      await promise;
    } finally {
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
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
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["codex"];
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

      const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "codex" });
      stderr1.emit("data", Buffer.from("codex error"));
      child1.emit("close", 1, null);

      // Allow retry microtask
      await new Promise((r) => setTimeout(r, 0));

      stderr2.emit("data", Buffer.from("codex error"));
      child2.emit("close", 1, null);

      await expect(promise).rejects.toThrow(AgentCliError);
    } finally {
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
    }
  });

  it("codex rejects on spawn error", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["codex"];
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

      const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "codex" });
      child.emit("error", new Error("spawn failed"));

      await expect(promise).rejects.toThrow("Failed to spawn codex");
    } finally {
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
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

      const promise = runClaude("test prompt", "/tmp/codex-timeout", { capability: "tool-use", tier: "sonnet", provider: "codex" });

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

      const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "codex" });

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
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["codex"];
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: stdinMock,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "codex" });

      // Codex exits 0 but produces no output
      child.emit("close", 0, null);

      const result = await promise;
      expect(result).toBe("");
    } finally {
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
    }
  });

  it("codex sets numTurns=0 on non-zero exit with no stdout", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["codex"];
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

      const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "codex" });
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
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
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
      capability: "tool-use",
      tier: "sonnet",
      appendSystemPrompt: "some doc content",
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--append-system-prompt", "some doc content"]),
      expect.objectContaining({ cwd: "/tmp" }),
    );

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

    const promise = runClaude("hello", "/tmp/some-cwd", { capability: "tool-use", tier: "sonnet", provider: "claude", captureLabel: "unit" });
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

    const promise = runClaude("hello", "/tmp/some-cwd", { capability: "tool-use", tier: "sonnet", provider: "claude", captureLabel: "unit" });
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

    const promise = runClaude("hello", "/tmp/some-cwd", { capability: "tool-use", tier: "sonnet", provider: "claude", captureLabel: "unit" });
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "world", is_error: false })));
    child.emit("close", 0, null);
    await promise;

    expect(fs.promises.appendFile).not.toHaveBeenCalled();
  });

  it("writes nothing when CLAWS_PROMPT_CAPTURE=0", async () => {
    process.env["CLAWS_PROMPT_CAPTURE_DIR"] = "/tmp/fake-capture-dir";
    process.env["CLAWS_PROMPT_CAPTURE"] = "0";
    const { child, stdoutEmitter } = mockChild();

    const promise = runClaude("hello", "/tmp/some-cwd", { capability: "tool-use", tier: "sonnet", provider: "claude" });
    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "world", is_error: false })));
    child.emit("close", 0, null);
    await promise;

    expect(fs.promises.appendFile).not.toHaveBeenCalled();
  });

  it("captures failures with ok:false and re-throws the original error", async () => {
    process.env["CLAWS_PROMPT_CAPTURE"] = "1";
    process.env["CLAWS_PROMPT_CAPTURE_DIR"] = "/tmp/fake-capture-dir";
    const { child, stdoutEmitter } = mockChild();

    const promise = runClaude("hello", "/tmp/some-cwd", { capability: "tool-use", tier: "sonnet", provider: "claude" });
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

  it("falls back to opencode when the preferred claude provider is rate-limited", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude", "opencode"];
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
      const promise = runClaude("test prompt", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "claude", onProviderUsed });

      // Claude fails with a rate-limit message (num_turns > 0 so runWithRetry won't retry)
      stdout1.emit("data", Buffer.from(JSON.stringify({ result: "rate limit exceeded", is_error: true, num_turns: 5 })));
      child1.emit("close", 1, null);

      // Allow async isRateLimitError check and fallback retry
      await new Promise((r) => setTimeout(r, 10));

      // OpenCode (fallback) succeeds
      stdout2.emit("data", Buffer.from("opencode output"));
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
    } finally {
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
    }
  });

  it("onProviderUsed callback is called with the provider for each attempt", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const onProviderUsed = vi.fn();
    const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "claude", onProviderUsed });

    stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    child.emit("close", 0, null);

    await promise;
    expect(onProviderUsed).toHaveBeenCalledOnce();
    expect(onProviderUsed).toHaveBeenCalledWith("claude");
  });

  it("honors explicit options.provider over config primary in attempt order", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["codex"];
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
      mockSpawn.mockReturnValue(child as any);

      const onProviderUsed = vi.fn();
      const promise = runClaude("test prompt", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "claude", onProviderUsed });

      stdoutEmitter.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
      child.emit("close", 0, null);

      await promise;
      // Explicit provider: "claude" should be tried first, not config primary "codex"
      expect(onProviderUsed).toHaveBeenCalledOnce();
      expect(onProviderUsed).toHaveBeenCalledWith("claude");
      expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe("claude");
    } finally {
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
    }
  });

  it("throws 'All AI providers are rate-limited' when every provider in attemptOrder is already rate-limited", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude", "opencode"];
    try {
      markProviderRateLimited("claude");
      markProviderRateLimited("opencode");

      const onProviderUsed = vi.fn();
      await expect(
        runClaude("test prompt", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "claude", onProviderUsed }),
      ).rejects.toThrow("All AI providers are rate-limited or unavailable");
      expect(onProviderUsed).not.toHaveBeenCalled();
    } finally {
      (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
    }
  });
});

describe("opencode backend", () => {
  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["opencode"];
  });
  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude"];
  });

  it("dispatches to opencode when provider is opencode", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "opencode" });

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

    // model is derived from tier via getModel (mocked to "sonnet"); explicit model option is overridden
    const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "opus", provider: "opencode", model: "anthropic/claude-opus-4" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      expect.arrayContaining(["--model", "sonnet"]),
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
    const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "opencode" });

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

    const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "opencode" });

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

    const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "opencode" });

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

  it("opencode logs debug warning when mcpConfig is passed", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: new EventEmitter(), stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "opencode", mcpConfig: "/tmp/.mcp-claws.json" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      expect.not.arrayContaining(["--mcp-config"]),
      expect.any(Object),
    );
    expect(logModule.debug).toHaveBeenCalledWith(
      expect.stringContaining("MCP config is not supported by OpenCode backend"),
    );

    const jsonLine = JSON.stringify({ type: "text", part: { text: "output" } });
    stdoutEmitter.emit("data", Buffer.from(jsonLine + "\n"));
    child.emit("close", 0, null);
    await promise;
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
    const rejectPromise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "opencode" });
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

    const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "opencode" });

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

    const promise = runClaude("test", "/tmp", { capability: "tool-use", tier: "sonnet", provider: "opencode" });
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
      if (args?.[0] === "fetch") {
        setTimeout(() => cb(new Error("ref lock error"), "", "cannot lock ref"), 10);
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
      "rejected as non-fast-forward after retries exhausted",
    );

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

describe("runOpenRouterDirectOnce (via runClaude provider: 'openrouter')", () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
    clearProviderRateLimitState();
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OPENROUTER_API_KEY = "test-key";
    (configMod as Record<string, unknown>).TEXT_ONLY_PROVIDER_FALLBACK_ORDER = ["openrouter"];
  });

  afterEach(async () => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OPENROUTER_API_KEY = "";
    (configMod as Record<string, unknown>).TEXT_ONLY_PROVIDER_FALLBACK_ORDER = ["openrouter"];
  });

  it("returns the message content on a successful 200 response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Review looks good." } }],
          usage: { total_tokens: 42, cost: 0.0001 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await runClaude("test prompt", "/tmp", {
      capability: "text-only",
      tier: "sonnet",
      provider: "openrouter",
      model: "qwen/qwen-2.5-coder-32b-instruct",
    });
    expect(result).toBe("Review looks good.");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("qwen/qwen-2.5-coder-32b-instruct");
    expect(body.messages).toEqual([{ role: "user", content: "test prompt" }]);
  });

  it("throws if OPENROUTER_API_KEY is not set", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OPENROUTER_API_KEY = "";
    await expect(
      runClaude("test prompt", "/tmp", {
        capability: "text-only",
        tier: "sonnet",
        provider: "openrouter",
        model: "qwen/qwen-2.5-coder-32b-instruct",
      }),
    ).rejects.toThrow(/OPENROUTER_API_KEY is not set/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps HTTP 429 to a rate-limit error so provider fallback kicks in", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Rate limited", { status: 429 }),
    );
    await expect(
      runClaude("test prompt", "/tmp", {
        capability: "text-only",
        tier: "sonnet",
        provider: "openrouter",
        model: "qwen/qwen-2.5-coder-32b-instruct",
      }),
    ).rejects.toThrow(/rate limit.*429/i);
  });

  it("retries once on HTTP 5xx and then propagates the error", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("Upstream down", { status: 502 }))
      .mockResolvedValueOnce(new Response("Upstream still down", { status: 502 }));
    await expect(
      runClaude("test prompt", "/tmp", {
        capability: "text-only",
        tier: "sonnet",
        provider: "openrouter",
        model: "qwen/qwen-2.5-coder-32b-instruct",
      }),
    ).rejects.toThrow(/OpenRouter API Error.*502/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws on malformed JSON in the response body", async () => {
    const badResponse = new Response("not json at all", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    mockFetch.mockResolvedValueOnce(badResponse);
    await expect(
      runClaude("test prompt", "/tmp", {
        capability: "text-only",
        tier: "sonnet",
        provider: "openrouter",
        model: "qwen/qwen-2.5-coder-32b-instruct",
      }),
    ).rejects.toThrow(/non-JSON response/);
  });

  it("throws when the response has no choices", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      runClaude("test prompt", "/tmp", {
        capability: "text-only",
        tier: "sonnet",
        provider: "openrouter",
        model: "qwen/qwen-2.5-coder-32b-instruct",
      }),
    ).rejects.toThrow(/missing choices/);
  });

  it("throws when the response has no message content", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: {} }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      runClaude("test prompt", "/tmp", {
        capability: "text-only",
        tier: "sonnet",
        provider: "openrouter",
        model: "qwen/qwen-2.5-coder-32b-instruct",
      }),
    ).rejects.toThrow(/missing message content/);
  });

  it("passes usage data to the onTokensUsed callback", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "OK" } }],
          usage: { total_tokens: 100, cost: 0.002 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const onTokensUsed = vi.fn();
    await runClaude("test prompt", "/tmp", {
      capability: "text-only",
      tier: "sonnet",
      provider: "openrouter",
      model: "qwen/qwen-2.5-coder-32b-instruct",
      onTokensUsed,
    });
    expect(onTokensUsed).toHaveBeenCalledWith(100, 0.002);
  });

  it("throws OpenRouterClientError on HTTP 400", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("maximum context length is 32768 tokens", { status: 400 }),
    );
    await expect(
      runClaude("test prompt", "/tmp", {
        capability: "text-only",
        tier: "sonnet",
        provider: "openrouter",
        model: "qwen/qwen-2.5-coder-32b-instruct",
      }),
    ).rejects.toThrow(OpenRouterClientError);
  });

  it("does not mark provider rate-limited on HTTP 400", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("maximum context length is 32768 tokens", { status: 400 }),
    );
    await expect(
      runClaude("test prompt", "/tmp", {
        capability: "text-only",
        tier: "sonnet",
        provider: "openrouter",
        model: "qwen/qwen-2.5-coder-32b-instruct",
      }),
    ).rejects.toThrow(OpenRouterClientError);
    expect(isProviderRateLimited("openrouter")).toBe(false);
  });
});

describe("sanitiseEnvForChild", () => {
  it("strict mode strips sensitive keys but preserves safe ones", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/test",
      PATH: "/usr/bin",
      NAMEY_DB_URL: "postgres://secret",
      CLAWS_AUTH_TOKEN: "tok123",
      CLAWS_OIDC_CLIENT_SECRET: "oidcsecret",
      GH_TOKEN: "ghtoken",
    };
    const result = sanitiseEnvForChild(env, "strict");
    expect(result).not.toHaveProperty("NAMEY_DB_URL");
    expect(result).not.toHaveProperty("CLAWS_AUTH_TOKEN");
    expect(result).not.toHaveProperty("CLAWS_OIDC_CLIENT_SECRET");
    expect(result.HOME).toBe("/home/test");
    expect(result.PATH).toBe("/usr/bin");
    expect(result.GH_TOKEN).toBe("ghtoken");
  });

  it("passthrough mode returns an identical copy", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/test",
      NAMEY_DB_URL: "postgres://secret",
      CLAWS_AUTH_TOKEN: "tok123",
    };
    const result = sanitiseEnvForChild(env, "passthrough");
    expect(result).toEqual(env);
    expect(result).not.toBe(env); // must be a copy, not the same reference
  });

  it("strict mode does not modify the original env", () => {
    const env: NodeJS.ProcessEnv = { NAMEY_DB_URL: "postgres://secret" };
    sanitiseEnvForChild(env, "strict");
    expect(env.NAMEY_DB_URL).toBe("postgres://secret");
  });

  it("SENSITIVE_ENV_KEYS includes expected secrets", () => {
    const keys = SENSITIVE_ENV_KEYS as readonly string[];
    expect(keys).toContain("NAMEY_DB_URL");
    expect(keys).toContain("CLAWS_AUTH_TOKEN");
    expect(keys).toContain("OPENAI_API_KEY");
    expect(keys).toContain("CLAWS_HOME_ASSISTANT_TOKEN");
    expect(keys).toContain("CLAWS_OIDC_CLIENT_SECRET");
    expect(keys).toContain("CLAWS_SLACK_WEBHOOK");
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("GH_TOKEN");
    expect(keys).not.toContain("HOME");
  });
});

describe("tool-use call sites do not opt into passthrough env sanitization", () => {
  it.each([
    "src/agents/issue-worker.ts",
    "src/agents/ci-fixer.ts",
    "src/agents/review-addresser.ts",
  ])("%s has no envSanitization: \"passthrough\"", async (relativePath) => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const source = realFs.readFileSync(relativePath, "utf8");
    expect(source).not.toContain('envSanitization: "passthrough"');
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
});

describe("readRepoAgentDoc", () => {
  const mockFs = vi.mocked(fs);

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
    mockFs.readFileSync.mockImplementation(() => { throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" }); });
    const result = readRepoAgentDoc("/repo/wt", "issue-refiner");
    expect(result).toBeUndefined();
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

  it("reads from the correct path", () => {
    mockFs.readFileSync.mockReturnValue("agent content");
    readRepoAgentDoc("/repo/wt", "pr-reviewer");
    expect(mockFs.readFileSync).toHaveBeenCalledWith(
      "/repo/wt/.claude/agents/pr-reviewer.md",
      "utf8",
    );
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
