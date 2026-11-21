import * as claude from "./claude.js";
import * as log from "./log.js";
import { getDefaultTier, normalizeTier, type ModelTier } from "./model-selector.js";

/**
 * Lightweight classification step that asks sonnet whether a task warrants
 * opus-level reasoning. On failure it falls back to the configured `ci-fix`
 * default tier (`getDefaultTier("ci-fix")`, shipped as opus) unless the caller
 * passes its own `defaultOnFailure`. Pass `defaultOnFailure: null` to get
 * `null` on failure so the caller can fall through to its configured default tier.
 */
export async function classifyComplexity(
  contextDescription: string,
  wtPath: string,
  options: { defaultOnFailure: null },
): Promise<ModelTier | null>;
export async function classifyComplexity(
  contextDescription: string,
  wtPath: string,
  options?: { defaultOnFailure?: ModelTier },
): Promise<ModelTier>;
export async function classifyComplexity(
  contextDescription: string,
  wtPath: string,
  options?: { defaultOnFailure?: ModelTier | null },
): Promise<ModelTier | null> {
  // Resolved only on failure, so a successful classification never reads config.
  const failureTier = (): ModelTier | null => options?.defaultOnFailure === null ? null : (options?.defaultOnFailure ?? getDefaultTier("ci-fix"));

  const prompt = [
    `You are classifying a task to determine which AI model tier should be used.`,
    ``,
    contextDescription,
    ``,
    `Respond with ONLY one word — "haiku", "sonnet", or "opus":`,
    `- "haiku": trivial change — single-line fix, typo, comment, documentation-only, no logic change`,
    `- "sonnet": straightforward, well-defined fix (simple bug, config change, clear error)`,
    `- "opus": requires deep analysis (architectural issue, complex logic, multi-file investigation)`,
    ``,
    `Respond with only the single word "haiku", "sonnet", or "opus". No explanation.`,
  ].join("\n");

  try {
    const result = await claude.runClaude(prompt, wtPath, { tier: "sonnet", timeoutMs: 120_000, agent: "plan", provider: "claude" });
    const word = result.trim().toLowerCase().split(/\s+/)[0];
    // `normalizeTier` also accepts the old `cheap` spelling of `haiku`. `fable`
    // is deliberately not an answer this classifier may give — escalating to the
    // best model available is an operator decision, not a classification.
    const tier = word ? normalizeTier(word) : null;
    if (tier === "haiku" || tier === "sonnet" || tier === "opus") return tier;
    const fallback = failureTier();
    log.warn(`[classify-complexity] Unexpected classification response: "${result.trim()}" — defaulting to ${fallback ?? "the configured default"}`);
    return fallback;
  } catch (err) {
    const fallback = failureTier();
    log.warn(`[classify-complexity] Classification failed: ${err} — defaulting to ${fallback ?? "the configured default"}`);
    return fallback;
  }
}
