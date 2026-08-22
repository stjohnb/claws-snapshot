import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    CODEX_DEFAULT_MODEL: "o3",
    CODEX_LIGHT_MODEL: "o4-mini",
    CODEX_CHEAP_MODEL: "o4-mini",
    REVIEW_MODEL_TIER: "sonnet" as "sonnet" | "opus",
    OPENCODE_BEST_MODEL: "openrouter/anthropic/claude-opus-4",
    OPENCODE_ADEQUATE_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
    OPENCODE_CHEAP_MODEL: "openrouter/google/gemini-2.5-flash",
    OPENCODE_TEXT_BEST_MODEL: "openrouter/qwen/qwen-2.5-coder-32b-instruct",
    OPENCODE_TEXT_ADEQUATE_MODEL: "openrouter/qwen/qwen-2.5-coder-32b-instruct",
    OPENCODE_TEXT_CHEAP_MODEL: "openrouter/google/gemini-2.5-flash",
    CLAUDE_CHEAP_MODEL: "claude-haiku-4-5-20251001",
    TOOL_USE_PROVIDER_FALLBACK_ORDER: ["claude"] as ReadonlyArray<"claude" | "codex" | "opencode">,
    TEXT_ONLY_PROVIDER_FALLBACK_ORDER: ["opencode"] as ReadonlyArray<"claude" | "codex" | "opencode">,
  },
}));
vi.mock("./config.js", () => mockConfig);
vi.mock("./plan-parser.js", () => ({}));

import { getModel, getReviewModel, getFallbackOrder } from "./model-selector.js";

describe("getModel", () => {
  beforeEach(() => {
    mockConfig.CODEX_DEFAULT_MODEL = "o3";
    mockConfig.CODEX_LIGHT_MODEL = "o4-mini";
    mockConfig.CODEX_CHEAP_MODEL = "o4-mini";
    mockConfig.REVIEW_MODEL_TIER = "sonnet";
    mockConfig.OPENCODE_BEST_MODEL = "openrouter/anthropic/claude-opus-4";
    mockConfig.OPENCODE_ADEQUATE_MODEL = "openrouter/anthropic/claude-sonnet-4.5";
    mockConfig.OPENCODE_CHEAP_MODEL = "openrouter/google/gemini-2.5-flash";
    mockConfig.OPENCODE_TEXT_BEST_MODEL = "openrouter/qwen/qwen-2.5-coder-32b-instruct";
    mockConfig.OPENCODE_TEXT_ADEQUATE_MODEL = "openrouter/qwen/qwen-2.5-coder-32b-instruct";
    mockConfig.OPENCODE_TEXT_CHEAP_MODEL = "openrouter/google/gemini-2.5-flash";
    mockConfig.CLAUDE_CHEAP_MODEL = "claude-haiku-4-5-20251001";
  });

  // ── claude provider ──
  it("returns sonnet tier name as claude model", () => {
    expect(getModel("sonnet", "tool-use", "claude")).toBe("sonnet");
  });

  it("returns opus tier name as claude model", () => {
    expect(getModel("opus", "tool-use", "claude")).toBe("opus");
  });

  it("returns claude cheap model for cheap tier with claude provider", () => {
    expect(getModel("cheap", "tool-use", "claude")).toBe("claude-haiku-4-5-20251001");
  });

  it("falls back to 'haiku' alias when CLAUDE_CHEAP_MODEL is empty", () => {
    mockConfig.CLAUDE_CHEAP_MODEL = "";
    expect(getModel("cheap", "tool-use", "claude")).toBe("haiku");
  });

  // ── codex provider ──
  it("returns codex default model for opus tier with codex provider", () => {
    expect(getModel("opus", "tool-use", "codex")).toBe("o3");
  });

  it("returns codex light model for sonnet tier with codex provider", () => {
    expect(getModel("sonnet", "tool-use", "codex")).toBe("o4-mini");
  });

  it("respects custom codex model config", () => {
    mockConfig.CODEX_DEFAULT_MODEL = "o4-mini";
    mockConfig.CODEX_LIGHT_MODEL = "gpt-4o-mini";
    expect(getModel("opus", "tool-use", "codex")).toBe("o4-mini");
    expect(getModel("sonnet", "tool-use", "codex")).toBe("gpt-4o-mini");
  });

  it("returns codex cheap model for cheap tier with codex provider", () => {
    expect(getModel("cheap", "tool-use", "codex")).toBe("o4-mini");
  });

  it("respects custom codex cheap model config", () => {
    mockConfig.CODEX_CHEAP_MODEL = "gpt-4o-mini";
    expect(getModel("cheap", "tool-use", "codex")).toBe("gpt-4o-mini");
  });

  // ── opencode provider, tool-use ──
  it("returns opencode best model for opus tier / tool-use", () => {
    expect(getModel("opus", "tool-use", "opencode")).toBe("openrouter/anthropic/claude-opus-4");
  });

  it("returns opencode adequate model for sonnet tier / tool-use", () => {
    expect(getModel("sonnet", "tool-use", "opencode")).toBe("openrouter/anthropic/claude-sonnet-4.5");
  });

  it("returns opencode cheap model for cheap tier / tool-use", () => {
    expect(getModel("cheap", "tool-use", "opencode")).toBe("openrouter/google/gemini-2.5-flash");
  });

  it("respects custom opencode tool-use model config", () => {
    mockConfig.OPENCODE_BEST_MODEL = "anthropic/claude-opus-4-5";
    mockConfig.OPENCODE_ADEQUATE_MODEL = "anthropic/claude-sonnet-4-6";
    mockConfig.OPENCODE_CHEAP_MODEL = "google/gemini-2.0-flash";
    expect(getModel("opus", "tool-use", "opencode")).toBe("anthropic/claude-opus-4-5");
    expect(getModel("sonnet", "tool-use", "opencode")).toBe("anthropic/claude-sonnet-4-6");
    expect(getModel("cheap", "tool-use", "opencode")).toBe("google/gemini-2.0-flash");
  });

  // ── opencode provider, text-only ──
  it("returns opencode text-only best model for opus tier / text-only", () => {
    expect(getModel("opus", "text-only", "opencode")).toBe("openrouter/qwen/qwen-2.5-coder-32b-instruct");
  });

  it("returns opencode text-only adequate model for sonnet tier / text-only", () => {
    expect(getModel("sonnet", "text-only", "opencode")).toBe("openrouter/qwen/qwen-2.5-coder-32b-instruct");
  });

  it("returns opencode text-only cheap model for cheap tier / text-only", () => {
    expect(getModel("cheap", "text-only", "opencode")).toBe("openrouter/google/gemini-2.5-flash");
  });

  it("text-only and tool-use use distinct opencode model configs", () => {
    mockConfig.OPENCODE_BEST_MODEL = "anthropic/claude-opus-4-5";
    mockConfig.OPENCODE_TEXT_BEST_MODEL = "qwen/qwen-2.5-coder-7b-instruct";
    expect(getModel("opus", "tool-use", "opencode")).toBe("anthropic/claude-opus-4-5");
    expect(getModel("opus", "text-only", "opencode")).toBe("qwen/qwen-2.5-coder-7b-instruct");
  });
});

describe("getReviewModel", () => {
  beforeEach(() => {
    mockConfig.REVIEW_MODEL_TIER = "sonnet";
    mockConfig.OPENCODE_TEXT_ADEQUATE_MODEL = "openrouter/qwen/qwen-2.5-coder-32b-instruct";
    mockConfig.OPENCODE_TEXT_BEST_MODEL = "openrouter/qwen/qwen-2.5-coder-32b-instruct";
  });

  it("defaults to config REVIEW_MODEL_TIER (sonnet) when no override provided, opencode text-only", () => {
    expect(getReviewModel(undefined, "opencode")).toBe("openrouter/qwen/qwen-2.5-coder-32b-instruct");
  });

  it("uses override tier when provided, opencode text-only", () => {
    expect(getReviewModel("opus", "opencode")).toBe("openrouter/qwen/qwen-2.5-coder-32b-instruct");
  });

  it("falls back to claude tier names when provider is claude", () => {
    expect(getReviewModel("sonnet", "claude")).toBe("sonnet");
    expect(getReviewModel("opus", "claude")).toBe("opus");
  });

});

describe("getFallbackOrder", () => {
  it("returns the tool-use order for tool-use capability", () => {
    mockConfig.TOOL_USE_PROVIDER_FALLBACK_ORDER = ["claude", "codex"];
    expect(getFallbackOrder("tool-use")).toEqual(["claude", "codex"]);
  });

  it("returns the text-only order for text-only capability", () => {
    mockConfig.TEXT_ONLY_PROVIDER_FALLBACK_ORDER = ["opencode", "claude"];
    expect(getFallbackOrder("text-only")).toEqual(["opencode", "claude"]);
  });
});
