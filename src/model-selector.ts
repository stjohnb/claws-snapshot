import * as config from "./config.js";
import * as log from "./log.js";
import type { Provider } from "./plan-parser.js";

export type ModelTier = "sonnet" | "opus" | "cheap";

/**
 * Codex model IDs the ChatGPT-account backend now rejects with a 400
 * ("The '<id>' model is not supported when using Codex with a ChatGPT
 * account") — every slug marked `visibility: "hide"` in codex-cli 0.118's
 * model registry, plus the pre-gpt-5 OpenAI IDs. A persisted config written
 * before those retirements would otherwise loop forever (#2694), so map each
 * to its registry `upgrade.model` replacement.
 */
export const RETIRED_CODEX_MODELS: Readonly<Record<string, string>> = {
  "gpt-5": "gpt-5.4",
  "gpt-5-codex": "gpt-5.4",
  "gpt-5.1": "gpt-5.4",
  "gpt-5.1-codex": "gpt-5.4",
  "gpt-5.1-codex-max": "gpt-5.4",
  "gpt-5.2-codex": "gpt-5.4",
  "gpt-5-codex-mini": "gpt-5.4-mini",
  "gpt-5.1-codex-mini": "gpt-5.4-mini",
  "o3": "gpt-5.4",
  "o3-mini": "gpt-5.4-mini",
  "o4-mini": "gpt-5.4-mini",
};

const warnedRetiredModels = new Set<string>();

/** Substitute a retired Codex model ID, warning once per distinct ID. */
export function resolveCodexModel(model: string): string {
  const replacement = RETIRED_CODEX_MODELS[model];
  if (!replacement) return model;
  if (!warnedRetiredModels.has(model)) {
    warnedRetiredModels.add(model);
    log.warn(`[model-selector] Codex model "${model}" is retired and rejected by the Codex CLI account — using "${replacement}" instead. Update the matching codex*Model key in config.json to silence this.`);
  }
  return replacement;
}

/** Test-only: clear the warn-once cache so tests can assert repeated warnings. */
export function __resetRetiredModelWarningsForTests(): void {
  warnedRetiredModels.clear();
}

/** Returns the model to use, respecting the config override and provider. */
export function getModel(defaultTier: ModelTier, provider: Provider): string {
  if (provider === "codex") {
    if (defaultTier === "cheap") return resolveCodexModel(config.CODEX_CHEAP_MODEL);
    return resolveCodexModel(defaultTier === "sonnet" ? config.CODEX_LIGHT_MODEL : config.CODEX_DEFAULT_MODEL);
  }
  if (provider === "opencode") {
    if (defaultTier === "cheap") return config.OPENCODE_CHEAP_MODEL;
    if (defaultTier === "sonnet") return config.OPENCODE_ADEQUATE_MODEL;
    return config.OPENCODE_BEST_MODEL;
  }
  // claude provider
  if (defaultTier === "cheap") return config.CLAUDE_CHEAP_MODEL || "haiku";
  return defaultTier;
}

/**
 * The best model a provider offers, for deep-thinking runs (`Plan: Deep`).
 * Independent of ModelTier: tiers are a cost dial, this is "the best there is".
 *
 * Claude gets the CLI's `fable` *alias*, not a pinned model ID — `claude
 * --model` resolves an alias to the latest model in that tier, so this stays
 * correct across model releases with no code change (same reason getModel
 * returns bare "opus"/"sonnet" for Claude). Codex/OpenCode reuse the operator's
 * existing best-model config keys.
 */
export function getDeepModel(provider: Provider): string {
  if (provider === "codex") return resolveCodexModel(config.CODEX_DEFAULT_MODEL);
  if (provider === "opencode") return config.OPENCODE_BEST_MODEL;
  return "fable";
}

/** Returns the model to use for PR reviews. */
export function getReviewModel(overrideTier: ModelTier | undefined, provider: Provider): string {
  return getModel(overrideTier ?? config.REVIEW_MODEL_TIER, provider);
}

/**
 * Returns the provider fallback order from config. `runClaude` uses this to
 * pick which providers to walk when the caller has not pinned an explicit
 * provider.
 */
export function getFallbackOrder(): ReadonlyArray<Provider> {
  return config.PROVIDER_FALLBACK_ORDER;
}

/**
 * Return an item-level provider override from GitHub labels.  A conflicting
 * pair deliberately falls back to the global setting: it is safer to keep an
 * item runnable than to silently choose one of two explicit instructions.
 */
export function getProviderOverride(labels: ReadonlyArray<{ name: string }>): Provider | undefined {
  const names = new Set(labels.map((label) => label.name));
  const codex = names.has(config.LABELS.useCodex);
  const claude = names.has(config.LABELS.useClaude);
  if (codex === claude) return undefined;
  return codex ? "codex" : "claude";
}

export interface ProviderSelection {
  provider: Provider;
  strictProvider: boolean;
  /**
   * Set when an explicit `Use Codex` label could not be honoured. Agents append
   * it to the "Models used" attribution so an ignored label is visible (#2686).
   *
   * MUST NOT contain `*`, `|` or a newline: plan-parser.ts matches the
   * attribution with a "Models used:" regex that stops at the next `*`,
   * and issue-refiner splits the segment on `|` when building "Refined with:".
   */
  overrideIgnoredReason?: string;
}

export const MCP_REQUIRES_CLAUDE_NOTE =
  `"Use Codex" label ignored — this repository's prompts need MCP tools that only Claude can use`;

/**
 * Select the provider for an issue/PR.
 *
 * Explicit `Use Claude` / `Use Codex` labels always pin the first attempt.
 *
 * `requiresMcp` forces Claude regardless of labels or global fallback order:
 * Codex and OpenCode silently drop `mcpConfig` (see `runClaude` in claude.ts),
 * so a prompt that embeds MCP-tool context (e.g. Home Assistant) must never
 * route to them — the agent would be told to use tools it can't reach.
 */
export function getProviderSelectionForItem(
  labels: ReadonlyArray<{ name: string }>,
  options?: { requiresMcp?: boolean },
): ProviderSelection {
  const override = getProviderOverride(labels);
  if (options?.requiresMcp) {
    return {
      provider: "claude",
      strictProvider: true,
      ...(override === "codex" ? { overrideIgnoredReason: MCP_REQUIRES_CLAUDE_NOTE } : {}),
    };
  }
  if (override) return { provider: override, strictProvider: true };
  return { provider: getFallbackOrder()[0] ?? "claude", strictProvider: false };
}

/** Select an item's explicit label override, otherwise its global primary. */
export function getProviderForItem(
  labels: ReadonlyArray<{ name: string }>,
  options?: { requiresMcp?: boolean },
): Provider {
  return getProviderSelectionForItem(labels, options).provider;
}
