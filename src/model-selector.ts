import * as config from "./config.js";
import type { Provider } from "./plan-parser.js";

export type ModelTier = "sonnet" | "opus" | "cheap";

/**
 * Whether a workflow needs the agent to call tools (edit files, run git, call gh)
 * or only needs text generation (produce a review comment, a plan, a markdown
 * triage report).
 *
 * Every call site that reaches `runClaude`/`getModel` must declare this
 * explicitly — there is no default. Tool-use workflows are routed to providers
 * that support MCP/tool calling (primarily Claude). Text-only workflows are
 * routed to the cheaper text-gen fallback order (primarily OpenCode+Qwen on
 * OpenRouter) to preserve Claude quota.
 */
export type Capability = "tool-use" | "text-only";

/** Returns the model to use, respecting the config override, capability, and provider. */
export function getModel(defaultTier: ModelTier, capability: Capability, provider: Provider): string {
  if (provider === "codex") {
    if (defaultTier === "cheap") return config.CODEX_CHEAP_MODEL;
    return defaultTier === "sonnet" ? config.CODEX_LIGHT_MODEL : config.CODEX_DEFAULT_MODEL;
  }
  if (provider === "openrouter") {
    // Direct OpenRouter HTTP backend — no tool schemas attached, so any
    // OpenRouter-hosted model works regardless of function-calling support.
    if (defaultTier === "cheap") return config.OPENROUTER_CHEAP_MODEL;
    if (defaultTier === "sonnet") return config.OPENROUTER_ADEQUATE_MODEL;
    return config.OPENROUTER_BEST_MODEL;
  }
  if (provider === "opencode") {
    // Text-only workflows get a separate model map so they can use cheaper
    // text-optimized models without disturbing the tool-use OpenCode
    // configuration. Note: opencode's `run` still sends tool schemas, so
    // models here must support function calling — use the `openrouter`
    // provider instead if you need a tool-incapable model.
    if (capability === "text-only") {
      if (defaultTier === "cheap") return config.OPENCODE_TEXT_CHEAP_MODEL;
      if (defaultTier === "sonnet") return config.OPENCODE_TEXT_ADEQUATE_MODEL;
      return config.OPENCODE_TEXT_BEST_MODEL;
    }
    if (defaultTier === "cheap") return config.OPENCODE_CHEAP_MODEL;
    if (defaultTier === "sonnet") return config.OPENCODE_ADEQUATE_MODEL;
    return config.OPENCODE_BEST_MODEL;
  }
  // claude provider
  if (defaultTier === "cheap") return config.CLAUDE_CHEAP_MODEL || "haiku";
  return defaultTier;
}

/** Returns the model to use for PR reviews (always text-only). */
export function getReviewModel(overrideTier: ModelTier | undefined, provider: Provider): string {
  return getModel(overrideTier ?? config.REVIEW_MODEL_TIER, "text-only", provider);
}

/**
 * Returns the capability-specific provider fallback order from config.
 * `runClaude` uses this to pick which providers to walk when the caller has
 * not pinned an explicit provider.
 */
export function getFallbackOrder(capability: Capability): ReadonlyArray<Provider> {
  return capability === "text-only"
    ? config.TEXT_ONLY_PROVIDER_FALLBACK_ORDER
    : config.TOOL_USE_PROVIDER_FALLBACK_ORDER;
}
