import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    CODEX_DEFAULT_MODEL: "gpt-5.5",
    CODEX_LIGHT_MODEL: "gpt-5.6-terra",
    CODEX_CHEAP_MODEL: "gpt-5.6-luna",
    OPENCODE_BEST_MODEL: "openrouter/anthropic/claude-opus-4",
    OPENCODE_ADEQUATE_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
    OPENCODE_CHEAP_MODEL: "openrouter/google/gemini-2.5-flash",
    IMPROVEMENT_IDENTIFIER_MODEL: "openrouter/z-ai/glm-5.3",
  },
}));

vi.mock("./config.js", () => mockConfig);
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { codexSessionModels, opencodeSessionModels, sessionModelsFor, isValidSessionModel, CLAUDE_SESSION_MODELS } from "./session-models.js";

describe("codexSessionModels", () => {
  beforeEach(() => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.5";
    mockConfig.CODEX_LIGHT_MODEL = "gpt-5.6-terra";
    mockConfig.CODEX_CHEAP_MODEL = "gpt-5.6-luna";
  });

  it("omits a retired codex ID persisted in config", () => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.1";
    const ids = codexSessionModels().map((m) => m.id);
    expect(ids).not.toContain("gpt-5.1");
    expect(ids).toContain("gpt-5.5");
    expect(ids).not.toContain("");
  });

  it("dedupes when all config values match the shipped defaults", () => {
    const ids = codexSessionModels().map((m) => m.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toEqual(["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("dedupes configured non-empty model IDs", () => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.5";
    mockConfig.CODEX_LIGHT_MODEL = "gpt-5.5";
    mockConfig.CODEX_CHEAP_MODEL = "gpt-5.5-mini";
    expect(codexSessionModels().map((m) => m.id)).toEqual([
      "gpt-5.5",
      "gpt-5.5-mini",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("labels custom options with their own id", () => {
    mockConfig.CODEX_DEFAULT_MODEL = "gpt-5.5";
    expect(codexSessionModels()).toEqual([
      { id: "gpt-5.5", label: "gpt-5.5" },
      { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
      { id: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    ]);
  });
});

describe("opencodeSessionModels", () => {
  it("lists the configured OpenRouter ids, deduped and without empties", () => {
    mockConfig.OPENCODE_ADEQUATE_MODEL = "openrouter/anthropic/claude-opus-4";
    mockConfig.OPENCODE_CHEAP_MODEL = "";
    expect(opencodeSessionModels().map((m) => m.id)).toEqual([
      "openrouter/anthropic/claude-opus-4",
      "openrouter/z-ai/glm-5.3",
    ]);
    mockConfig.OPENCODE_ADEQUATE_MODEL = "openrouter/anthropic/claude-sonnet-4.5";
    mockConfig.OPENCODE_CHEAP_MODEL = "openrouter/google/gemini-2.5-flash";
  });
});

describe("sessionModelsFor", () => {
  it("returns the Claude CLI tier aliases for claude", () => {
    expect(sessionModelsFor("claude")).toBe(CLAUDE_SESSION_MODELS);
    expect(CLAUDE_SESSION_MODELS.map((m) => m.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
  });

  it("routes codex and opencode to their own builders", () => {
    expect(sessionModelsFor("codex").map((m) => m.id)).toContain("gpt-5.6-luna");
    expect(sessionModelsFor("opencode").map((m) => m.id)).toContain("openrouter/z-ai/glm-5.3");
  });
});

describe("isValidSessionModel", () => {
  it("rejects empty, whitespace, shell metacharacters, flags and over-long ids", () => {
    expect(isValidSessionModel("")).toBe(false);
    expect(isValidSessionModel("a b")).toBe(false);
    expect(isValidSessionModel("a;rm -rf /")).toBe(false);
    expect(isValidSessionModel("--flag")).toBe(false);
    expect(isValidSessionModel("a".repeat(200))).toBe(false);
  });

  it("accepts ordinary provider model ids", () => {
    expect(isValidSessionModel("openrouter/anthropic/claude-opus-4")).toBe(true);
    expect(isValidSessionModel("gpt-5.6-luna")).toBe(true);
    expect(isValidSessionModel("opus")).toBe(true);
  });
});
