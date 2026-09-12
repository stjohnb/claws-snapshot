import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    CODEX_DEFAULT_MODEL: "gpt-5.5",
    CODEX_LIGHT_MODEL: "gpt-5.6-terra",
    CODEX_CHEAP_MODEL: "gpt-5.6-luna",
    REVIEW_MODEL_TIER: "sonnet" as "sonnet" | "opus",
    OPENCODE_BEST_MODEL: "openrouter/anthropic/claude-opus-4",
    OPENCODE_ADEQUATE_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
    OPENCODE_CHEAP_MODEL: "openrouter/google/gemini-2.5-flash",
    CLAUDE_CHEAP_MODEL: "claude-haiku-4-5-20251001",
    AI_PROVIDER_NAMES: ["claude", "codex", "opencode"] as const,
    AI_PROVIDERS: {
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 1 },
    },
    LABELS: { useCodex: "Use Codex", useClaude: "Use Claude", useOpenCode: "Use OpenCode" },
  },
}));
vi.mock("./config.js", () => mockConfig);
vi.mock("./plan-parser.js", () => ({}));

const { mockLog } = vi.hoisted(() => ({
  mockLog: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("./log.js", () => mockLog);

const { mockGetCodexModelCatalogue } = vi.hoisted(() => ({
  mockGetCodexModelCatalogue: vi.fn(),
}));
vi.mock("./codex-models.js", () => ({ getCodexModelCatalogue: mockGetCodexModelCatalogue }));

import { getModel, getDeepModel, getReviewModel, getEnabledProviderWeights, selectWeightedProvider, getProviderForItem, getProviderOverride, getProviderSelectionForItem, MCP_REQUIRES_CLAUDE_NOTE, resolveCodexModel, resolveCodexModelForAttempt, __resetRetiredModelWarningsForTests, NoEligibleProviderError } from "./model-selector.js";

describe("getModel", () => {
  beforeEach(() => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.5";
    mockConfig.CODEX_LIGHT_MODEL = "gpt-5.6-terra";
    mockConfig.CODEX_CHEAP_MODEL = "gpt-5.6-luna";
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
    expect(getModel("opus", "codex")).toBe("gpt-5.5");
  });

  it("returns codex light model for sonnet tier with codex provider", () => {
    expect(getModel("sonnet", "codex")).toBe("gpt-5.6-terra");
  });

  it("keeps the shipped Codex tier mapping distinct", () => {
    const models = [
      getModel("opus", "codex"),
      getModel("sonnet", "codex"),
      getModel("cheap", "codex"),
    ];
    expect(models).toEqual(["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(new Set(models).size).toBe(3);
  });

  it("respects custom codex model config", () => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-4o";
    mockConfig.CODEX_LIGHT_MODEL = "gpt-4o-mini";
    expect(getModel("opus", "codex")).toBe("gpt-4o");
    expect(getModel("sonnet", "codex")).toBe("gpt-4o-mini");
  });

  it("returns codex cheap model for cheap tier with codex provider", () => {
    expect(getModel("cheap", "codex")).toBe("gpt-5.6-luna");
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
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.5";
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
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.5";
    mockConfig.CODEX_LIGHT_MODEL = "gpt-5.6-terra";
    mockConfig.CODEX_CHEAP_MODEL = "gpt-5.6-luna";
    mockGetCodexModelCatalogue.mockReset();
  });

  it("uses luna for a stale cheap-tier model via getModel", () => {
    mockConfig.CODEX_CHEAP_MODEL = "o4-mini";
    expect(getModel("cheap", "codex")).toBe("gpt-5.6-luna");
  });

  it("uses gpt-5.5 for a stale default model via getDeepModel", () => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.1-codex-max";
    expect(getDeepModel("codex")).toBe("gpt-5.5");
  });

  it("uses gpt-5.5 for any non-mini gpt-5.1 configured alias", () => {
    expect(resolveCodexModel("gpt-5.1-codex-ultra")).toBe("gpt-5.5");
  });

  it("uses luna for any mini/cheap gpt-5.1 configured alias", () => {
    expect(resolveCodexModel("gpt-5.1-codex-mini-preview")).toBe("gpt-5.6-luna");
    expect(resolveCodexModel("gpt-5.1-codex-cheap-preview")).toBe("gpt-5.6-luna");
  });

  it("passes through a non-retired model unchanged", () => {
    expect(resolveCodexModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
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

  it("uses the replacement ID for live catalogue validation", async () => {
    mockGetCodexModelCatalogue.mockResolvedValue({ visible: new Set(["gpt-5.6-luna"]), upgrades: new Map() });
    await expect(resolveCodexModelForAttempt("o4-mini")).resolves.toBe("gpt-5.6-luna");
  });

  it("accepts a visible configured ID from the live catalogue", async () => {
    mockGetCodexModelCatalogue.mockResolvedValue({ visible: new Set(["gpt-5.5"]), upgrades: new Map() });
    await expect(resolveCodexModelForAttempt("gpt-5.5")).resolves.toBe("gpt-5.5");
  });

  it("uses a visible catalogue upgrade for a configured ID", async () => {
    mockGetCodexModelCatalogue.mockResolvedValue({
      visible: new Set(["gpt-5.6-sol"]),
      upgrades: new Map([["gpt-5.5", "gpt-5.6-sol"]]),
    });
    await expect(resolveCodexModelForAttempt("gpt-5.5")).resolves.toBe("gpt-5.6-sol");
  });

  it("falls back to provider default when the catalogue upgrade is hidden", async () => {
    mockGetCodexModelCatalogue.mockResolvedValue({
      visible: new Set(["gpt-6-astra"]),
      upgrades: new Map([["gpt-5.5", "gpt-5.6-hidden"]]),
    });
    await expect(resolveCodexModelForAttempt("gpt-5.5")).resolves.toBe("");
  });

  it("preserves a configured ID when the live catalogue cannot load", async () => {
    mockGetCodexModelCatalogue.mockResolvedValue(null);
    await expect(resolveCodexModelForAttempt("custom-codex-model")).resolves.toBe("custom-codex-model");
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

describe("weighted provider selection", () => {
  beforeEach(() => {
    mockConfig.AI_PROVIDERS = {
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 1 },
    };
  });

  it("selects providers at deterministic 4/2/1 boundaries", () => {
    const pool = getEnabledProviderWeights();
    expect(selectWeightedProvider(pool, () => 0)).toBe("claude");
    expect(selectWeightedProvider(pool, () => 3.99 / 7)).toBe("claude");
    expect(selectWeightedProvider(pool, () => 4 / 7)).toBe("codex");
    expect(selectWeightedProvider(pool, () => 5.99 / 7)).toBe("codex");
    expect(selectWeightedProvider(pool, () => 6 / 7)).toBe("opencode");
    expect(selectWeightedProvider(pool, () => 0.999999)).toBe("opencode");
  });

  it("excludes disabled, zero, and invalid weights", () => {
    mockConfig.AI_PROVIDERS = {
      claude: { enabled: false, weight: 4 },
      codex: { enabled: true, weight: 0 },
      opencode: { enabled: true, weight: Number.POSITIVE_INFINITY },
    };
    expect(getEnabledProviderWeights()).toEqual([]);
  });

  it("throws when no provider has a positive finite enabled weight", () => {
    mockConfig.AI_PROVIDERS = {
      claude: { enabled: false, weight: 4 },
      codex: { enabled: true, weight: 0 },
      opencode: { enabled: true, weight: -1 },
    };
    expect(() => getProviderSelectionForItem([])).toThrow(NoEligibleProviderError);
  });
});

describe("item provider overrides", () => {
  beforeEach(() => {
    mockConfig.AI_PROVIDERS = {
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 1 },
    };
  });

  it("uses Use Codex as an item override", () => {
    expect(getProviderOverride([{ name: "Use Codex" }])).toBe("codex");
    expect(getProviderForItem([{ name: "Use Codex" }])).toBe("codex");
  });

  it("uses Use Claude for an individual item", () => {
    expect(getProviderForItem([{ name: "Use Claude" }])).toBe("claude");
  });

  it("uses Use OpenCode for an individual item", () => {
    expect(getProviderForItem([{ name: "Use OpenCode" }])).toBe("opencode");
  });

  it("pins Use Codex when enabled", () => {
    expect(getProviderSelectionForItem([{ name: "Use Codex" }])).toEqual({
      provider: "codex",
      strictProvider: true,
      eligibleProviders: [{ provider: "codex", weight: 2 }],
    });
  });

  it("uses weighted provider selection when no override label is present", () => {
    expect(getProviderSelectionForItem([], { random: () => 4 / 7 })).toEqual({
      provider: "codex",
      strictProvider: false,
      eligibleProviders: [{ provider: "claude", weight: 4 }, { provider: "codex", weight: 2 }, { provider: "opencode", weight: 1 }],
    });
  });

  it("falls back to weighted selection when multiple override labels are present", () => {
    expect(getProviderOverride([{ name: "Use Codex" }, { name: "Use Claude" }])).toBeUndefined();
    expect(getProviderSelectionForItem([{ name: "Use Codex" }, { name: "Use Claude" }], { random: () => 6 / 7 })).toEqual({
      provider: "opencode",
      strictProvider: false,
      eligibleProviders: [{ provider: "claude", weight: 4 }, { provider: "codex", weight: 2 }, { provider: "opencode", weight: 1 }],
      overrideIgnoredReason: "conflicting provider labels ignored — weighted provider selection used",
    });
  });

  it("ignores a disabled provider label and uses weighted selection", () => {
    mockConfig.AI_PROVIDERS.codex = { enabled: false, weight: 2 };
    expect(getProviderSelectionForItem([{ name: "Use Codex" }], { random: () => 0 })).toEqual({
      provider: "claude",
      strictProvider: false,
      eligibleProviders: [{ provider: "claude", weight: 4 }, { provider: "opencode", weight: 1 }],
      overrideIgnoredReason: '"Use Codex" label ignored — Codex provider is disabled or has non-positive weight',
    });
  });

  it("forces Claude when requiresMcp is set, overriding an explicit Use Codex label", () => {
    expect(getProviderSelectionForItem([{ name: "Use Codex" }], { requiresMcp: true }))
      .toEqual({ provider: "claude", strictProvider: true, eligibleProviders: [{ provider: "claude", weight: 4 }], overrideIgnoredReason: MCP_REQUIRES_CLAUDE_NOTE });
    expect(getProviderForItem([{ name: "Use Codex" }], { requiresMcp: true })).toBe("claude");
  });

  it("forces Claude when requiresMcp is set", () => {
    expect(getProviderSelectionForItem([], { requiresMcp: true }))
      .toEqual({ provider: "claude", strictProvider: true, eligibleProviders: [{ provider: "claude", weight: 4 }] });
  });

  it("throws for MCP prompts when Claude is disabled", () => {
    mockConfig.AI_PROVIDERS.claude = { enabled: false, weight: 4 };
    expect(() => getProviderSelectionForItem([], { requiresMcp: true })).toThrow(NoEligibleProviderError);
  });

  it("does not force Claude when requiresMcp is false or omitted", () => {
    expect(getProviderSelectionForItem([], { requiresMcp: false, random: () => 0 }))
      .toEqual({ provider: "claude", strictProvider: false, eligibleProviders: [{ provider: "claude", weight: 4 }, { provider: "codex", weight: 2 }, { provider: "opencode", weight: 1 }] });
    expect(getProviderSelectionForItem([], { random: () => 0 }))
      .toEqual({ provider: "claude", strictProvider: false, eligibleProviders: [{ provider: "claude", weight: 4 }, { provider: "codex", weight: 2 }, { provider: "opencode", weight: 1 }] });
  });
});
