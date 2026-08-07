import * as claude from "./claude.js";
import * as log from "./log.js";
import type { ModelTier } from "./model-selector.js";

/**
 * Lightweight classification step that asks sonnet whether a task warrants
 * opus-level reasoning.  Defaults to **sonnet** on failure (cheaper); callers
 * that prefer opus on failure (e.g. the issue planner) should pass
 * `defaultOnFailure: "opus"`.
 */
export async function classifyComplexity(
  contextDescription: string,
  wtPath: string,
  options?: { defaultOnFailure?: ModelTier },
): Promise<ModelTier> {
  const fallback = options?.defaultOnFailure ?? "sonnet";

  const prompt = [
    `You are classifying a task to determine which AI model tier should be used.`,
    ``,
    contextDescription,
    ``,
    `Respond with ONLY one word — "cheap", "sonnet", or "opus":`,
    `- "cheap": trivial change — single-line fix, typo, comment, documentation-only, no logic change`,
    `- "sonnet": straightforward, well-defined fix (simple bug, config change, clear error)`,
    `- "opus": requires deep analysis (architectural issue, complex logic, multi-file investigation)`,
    ``,
    `Respond with only the single word "cheap", "sonnet", or "opus". No explanation.`,
  ].join("\n");

  try {
    const result = await claude.runClaude(prompt, wtPath, { capability: "text-only", tier: "sonnet", timeoutMs: 120_000, agent: "plan", provider: "claude" });
    const word = result.trim().toLowerCase().split(/\s+/)[0];
    if (word === "cheap" || word === "sonnet" || word === "opus") return word;
    log.warn(`[classify-complexity] Unexpected classification response: "${result.trim()}" — defaulting to ${fallback}`);
    return fallback;
  } catch (err) {
    log.warn(`[classify-complexity] Classification failed: ${err} — defaulting to ${fallback}`);
    return fallback;
  }
}
