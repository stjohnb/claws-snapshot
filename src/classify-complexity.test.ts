import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { DEFAULT_MODEL_TIERS: {} as Record<string, string>, REVIEW_MODEL_TIER: "opus" },
}));
vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), mockConfig));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("./log.js", () => mockLog);

const mockClaude = vi.hoisted(() => ({
  runClaude: vi.fn(),
}));
vi.mock("./claude.js", () => mockClaude);

import { classifyComplexity } from "./classify-complexity.js";

describe("classifyComplexity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.DEFAULT_MODEL_TIERS = {};
  });

  it("returns 'sonnet' when Claude responds with sonnet", async () => {
    mockClaude.runClaude.mockResolvedValue("sonnet");
    const result = await classifyComplexity("Fix a typo", "/tmp/wt");
    expect(result).toBe("sonnet");
  });

  it("returns 'opus' when Claude responds with opus", async () => {
    mockClaude.runClaude.mockResolvedValue("opus");
    const result = await classifyComplexity("Refactor auth system", "/tmp/wt");
    expect(result).toBe("opus");
  });

  it("returns 'haiku' when Claude responds with haiku", async () => {
    mockClaude.runClaude.mockResolvedValue("haiku");
    const result = await classifyComplexity("Fix a typo", "/tmp/wt");
    expect(result).toBe("haiku");
  });

  it("reads the legacy 'cheap' answer as haiku", async () => {
    mockClaude.runClaude.mockResolvedValue("cheap");
    const result = await classifyComplexity("Fix a typo", "/tmp/wt");
    expect(result).toBe("haiku");
  });

  it("does not let the classifier escalate to fable", async () => {
    mockClaude.runClaude.mockResolvedValue("fable");
    const result = await classifyComplexity("Some task", "/tmp/wt");
    expect(result).toBe("opus"); // the configured ci-fix default, not fable
  });

  it("handles response with extra whitespace", async () => {
    mockClaude.runClaude.mockResolvedValue("  opus  \n");
    const result = await classifyComplexity("Complex task", "/tmp/wt");
    expect(result).toBe("opus");
  });

  it("defaults to the shipped ci-fix default (opus) on unexpected output", async () => {
    mockClaude.runClaude.mockResolvedValue("I think this is complex");
    const result = await classifyComplexity("Some task", "/tmp/wt");
    expect(result).toBe("opus");
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected classification response"),
    );
  });

  it("defaults to the shipped ci-fix default (opus) on error", async () => {
    mockClaude.runClaude.mockRejectedValue(new Error("timeout"));
    const result = await classifyComplexity("Some task", "/tmp/wt");
    expect(result).toBe("opus");
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("Classification failed"),
    );
  });

  it("follows the configured ci-fix default on failure", async () => {
    mockConfig.DEFAULT_MODEL_TIERS = { "ci-fix": "sonnet" };
    mockClaude.runClaude.mockRejectedValue(new Error("timeout"));
    expect(await classifyComplexity("Some task", "/tmp/wt")).toBe("sonnet");
  });

  it("returns null on failure with defaultOnFailure: null", async () => {
    mockClaude.runClaude.mockResolvedValue("no idea");
    expect(await classifyComplexity("Some task", "/tmp/wt", { defaultOnFailure: null })).toBeNull();
  });

  it("respects custom defaultOnFailure option", async () => {
    mockClaude.runClaude.mockRejectedValue(new Error("timeout"));
    const result = await classifyComplexity("Some task", "/tmp/wt", { defaultOnFailure: "opus" });
    expect(result).toBe("opus");
  });

  it("passes context description into the prompt", async () => {
    mockClaude.runClaude.mockResolvedValue("sonnet");
    await classifyComplexity("CI failure: test timeout in auth module", "/tmp/wt");
    const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("CI failure: test timeout in auth module");
  });

  it("uses sonnet model for the classification call itself", async () => {
    mockClaude.runClaude.mockResolvedValue("sonnet");
    await classifyComplexity("Some task", "/tmp/wt");
    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/wt",
      { tier: "sonnet", timeoutMs: 120_000, agent: "plan", provider: "claude" },
    );
  });
});
