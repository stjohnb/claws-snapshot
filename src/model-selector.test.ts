import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    CODEX_DEFAULT_MODEL: "gpt-5.4",
    CODEX_LIGHT_MODEL: "gpt-5.4",
    CODEX_CHEAP_MODEL: "gpt-5.4-mini",
    REVIEW_MODEL_TIER: "sonnet" as "sonnet" | "opus",
    OPENCODE_BEST_MODEL: "openrouter/anthropic/claude-opus-4",
    OPENCODE_ADEQUATE_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
    OPENCODE_CHEAP_MODEL: "openrouter/google/gemini-2.5-flash",
    CLAUDE_CHEAP_MODEL: "claude-haiku-4-5-20251001",
    PROVIDER_FALLBACK_ORDER: ["claude"] as ReadonlyArray<"claude" | "codex" | "opencode">,
    LABELS: { useCodex: "Use Codex", useClaude: "Use Claude" },
  },
}));
vi.mock("./config.js", () => mockConfig);
vi.mock("./plan-parser.js", () => ({}));

const { mockLog } = vi.hoisted(() => ({
  mockLog: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("./log.js", () => mockLog);

import { getModel, getDeepModel, getReviewModel, getFallbackOrder, getProviderForItem, getProviderOverride, getProviderSelectionForItem, MCP_REQUIRES_CLAUDE_NOTE, resolveCodexModel, __resetRetiredModelWarningsForTests } from "./model-selector.js";

describe("getModel", () => {
  beforeEach(() => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.4";
    mockConfig.CODEX_LIGHT_MODEL = "gpt-5.4";
    mockConfig.CODEX_CHEAP_MODEL = "gpt-5.4-mini";
    mockConfig.REVIEW_MODEL_TIER = "sonnet";
    mockConfig.OPENCODE_BEST_MODEL = "openrouter/anthropic/claude-opus-4";
    mockConfig.OPENCODE_ADEQUATE_MODEL = "openrouter/anthropic/claude-sonnet-4.5";
    mockConfig.OPENCODE_CHEAP_MODEL = "openrouter/google/gemini-2.5-flash";
    mockConfig.CLAUDE_CHEAP_MODEL = "claude-haiku-4-5-20251001";
  });

  // ── claude provider ──
  it("returns sonnet tier name as claude model", () => {
    expect(getModel("sonnet", "claude")).toBe("sonnet");
  });

  it("returns opus tier name as claude model", () => {
    expect(getModel("opus", "claude")).toBe("opus");
  });

  it("returns claude cheap model for cheap tier with claude provider", () => {
    expect(getModel("cheap", "claude")).toBe("claude-haiku-4-5-20251001");
  });

  it("falls back to 'haiku' alias when CLAUDE_CHEAP_MODEL is empty", () => {
    mockConfig.CLAUDE_CHEAP_MODEL = "";
    expect(getModel("cheap", "claude")).toBe("haiku");
  });

  // ── codex provider ──
  it("returns codex default model for opus tier with codex provider", () => {
    expect(getModel("opus", "codex")).toBe("gpt-5.4");
  });

  it("returns codex light model for sonnet tier with codex provider", () => {
    expect(getModel("sonnet", "codex")).toBe("gpt-5.4");
  });

  it("respects custom codex model config", () => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-4o";
    mockConfig.CODEX_LIGHT_MODEL = "gpt-4o-mini";
    expect(getModel("opus", "codex")).toBe("gpt-4o");
    expect(getModel("sonnet", "codex")).toBe("gpt-4o-mini");
  });

  it("returns codex cheap model for cheap tier with codex provider", () => {
    expect(getModel("cheap", "codex")).toBe("gpt-5.4-mini");
  });

  it("respects custom codex cheap model config", () => {
    mockConfig.CODEX_CHEAP_MODEL = "gpt-4o-mini";
    expect(getModel("cheap", "codex")).toBe("gpt-4o-mini");
  });

  // ── opencode provider ──
  it("returns opencode best model for opus tier", () => {
    expect(getModel("opus", "opencode")).toBe("openrouter/anthropic/claude-opus-4");
  });

  it("returns opencode adequate model for sonnet tier", () => {
    expect(getModel("sonnet", "opencode")).toBe("openrouter/anthropic/claude-sonnet-4.5");
  });

  it("returns opencode cheap model for cheap tier", () => {
    expect(getModel("cheap", "opencode")).toBe("openrouter/google/gemini-2.5-flash");
  });

  it("respects custom opencode model config", () => {
    mockConfig.OPENCODE_BEST_MODEL = "anthropic/claude-opus-4-5";
    mockConfig.OPENCODE_ADEQUATE_MODEL = "anthropic/claude-sonnet-4-6";
    mockConfig.OPENCODE_CHEAP_MODEL = "google/gemini-2.0-flash";
    expect(getModel("opus", "opencode")).toBe("anthropic/claude-opus-4-5");
    expect(getModel("sonnet", "opencode")).toBe("anthropic/claude-sonnet-4-6");
    expect(getModel("cheap", "opencode")).toBe("google/gemini-2.0-flash");
  });
});

describe("getDeepModel", () => {
  beforeEach(() => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.4";
    mockConfig.OPENCODE_BEST_MODEL = "openrouter/anthropic/claude-opus-4";
  });

  it("returns the fable alias for claude", () => {
    expect(getDeepModel("claude")).toBe("fable");
  });

  it("returns CODEX_DEFAULT_MODEL for codex", () => {
    expect(getDeepModel("codex")).toBe(mockConfig.CODEX_DEFAULT_MODEL);
  });

  it("returns OPENCODE_BEST_MODEL for opencode", () => {
    expect(getDeepModel("opencode")).toBe(mockConfig.OPENCODE_BEST_MODEL);
  });
});

describe("resolveCodexModel", () => {
  beforeEach(() => {
    __resetRetiredModelWarningsForTests();
    mockLog.warn.mockClear();
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.4";
    mockConfig.CODEX_LIGHT_MODEL = "gpt-5.4";
    mockConfig.CODEX_CHEAP_MODEL = "gpt-5.4-mini";
  });

  it("substitutes a retired cheap-tier model via getModel", () => {
    mockConfig.CODEX_CHEAP_MODEL = "o4-mini";
    expect(getModel("cheap", "codex")).toBe("gpt-5.4-mini");
  });

  it("substitutes a retired default model via getDeepModel", () => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.1-codex-max";
    expect(getDeepModel("codex")).toBe("gpt-5.4");
  });

  it("passes through a non-retired model unchanged", () => {
    expect(resolveCodexModel("gpt-5.4")).toBe("gpt-5.4");
  });

  it("does not affect claude or opencode branches", () => {
    expect(getModel("opus", "claude")).toBe("opus");
    expect(getModel("opus", "opencode")).toBe(mockConfig.OPENCODE_BEST_MODEL);
  });

  it("warns once per distinct retired model ID", () => {
    resolveCodexModel("o4-mini");
    resolveCodexModel("o4-mini");
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });
});

describe("getReviewModel", () => {
  beforeEach(() => {
    mockConfig.REVIEW_MODEL_TIER = "sonnet";
    mockConfig.OPENCODE_ADEQUATE_MODEL = "openrouter/anthropic/claude-sonnet-4.5";
    mockConfig.OPENCODE_BEST_MODEL = "openrouter/anthropic/claude-opus-4";
  });

  it("defaults to config REVIEW_MODEL_TIER (sonnet) when no override provided, opencode", () => {
    expect(getReviewModel(undefined, "opencode")).toBe("openrouter/anthropic/claude-sonnet-4.5");
  });

  it("uses override tier when provided, opencode", () => {
    expect(getReviewModel("opus", "opencode")).toBe("openrouter/anthropic/claude-opus-4");
  });

  it("falls back to claude tier names when provider is claude", () => {
    expect(getReviewModel("sonnet", "claude")).toBe("sonnet");
    expect(getReviewModel("opus", "claude")).toBe("opus");
  });

});

describe("getFallbackOrder", () => {
  it("returns the configured provider fallback order", () => {
    mockConfig.PROVIDER_FALLBACK_ORDER = ["claude", "codex"];
    expect(getFallbackOrder()).toEqual(["claude", "codex"]);
  });
});

describe("item provider overrides", () => {
  it("uses Use Codex regardless of the global primary", () => {
    mockConfig.PROVIDER_FALLBACK_ORDER = ["claude"];
    expect(getProviderOverride([{ name: "Use Codex" }])).toBe("codex");
    expect(getProviderForItem([{ name: "Use Codex" }])).toBe("codex");
  });

  it("uses Use Claude for an individual item", () => {
    mockConfig.PROVIDER_FALLBACK_ORDER = ["codex"];
    expect(getProviderForItem([{ name: "Use Claude" }])).toBe("claude");
  });

  it("honours Use Codex even when the global default is Claude", () => {
    mockConfig.PROVIDER_FALLBACK_ORDER = ["claude"];
    expect(getProviderSelectionForItem([{ name: "Use Codex" }])).toEqual({ provider: "codex", strictProvider: true });
  });

  it("uses the global default provider when no override label is present", () => {
    mockConfig.PROVIDER_FALLBACK_ORDER = ["codex", "claude"];
    expect(getProviderSelectionForItem([])).toEqual({ provider: "codex", strictProvider: false });
  });

  it("falls back to the global provider when both override labels are present", () => {
    mockConfig.PROVIDER_FALLBACK_ORDER = ["codex", "claude"];
    expect(getProviderOverride([{ name: "Use Codex" }, { name: "Use Claude" }])).toBeUndefined();
    expect(getProviderForItem([{ name: "Use Codex" }, { name: "Use Claude" }])).toBe("codex");
  });

  it("forces Claude when requiresMcp is set, overriding an explicit Use Codex label", () => {
    mockConfig.PROVIDER_FALLBACK_ORDER = ["codex"];
    expect(getProviderSelectionForItem([{ name: "Use Codex" }], { requiresMcp: true }))
      .toEqual({ provider: "claude", strictProvider: true, overrideIgnoredReason: MCP_REQUIRES_CLAUDE_NOTE });
    expect(getProviderForItem([{ name: "Use Codex" }], { requiresMcp: true })).toBe("claude");
  });

  it("forces Claude when requiresMcp is set, overriding the global fallback order", () => {
    mockConfig.PROVIDER_FALLBACK_ORDER = ["codex"];
    expect(getProviderSelectionForItem([], { requiresMcp: true }))
      .toEqual({ provider: "claude", strictProvider: true });
  });

  it("does not force Claude when requiresMcp is false or omitted", () => {
    mockConfig.PROVIDER_FALLBACK_ORDER = ["codex"];
    expect(getProviderSelectionForItem([], { requiresMcp: false }))
      .toEqual({ provider: "codex", strictProvider: false });
    expect(getProviderSelectionForItem([]))
      .toEqual({ provider: "codex", strictProvider: false });
  });
});
