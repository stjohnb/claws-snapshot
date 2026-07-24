import { z } from "zod";
import * as config from "./config.js";
import * as log from "./log.js";

const OllamaResponseSchema = z.object({ response: z.string().optional() });

/**
 * Regex fallback for rate-limit detection when Ollama is unavailable.
 * Exported for use in tests and as a secondary reference.
 */
export const RATE_LIMIT_RE = /rate.?limit|quota.?exceeded|429|529|overloaded|too.?many.?requests/i;

/** How long to disable Ollama after hitting the consecutive-failure threshold. */
const OLLAMA_CIRCUIT_BREAKER_DISABLE_MS = 5 * 60 * 1000; // 5 minutes

let consecutiveFailures = 0;
let disabledUntil = 0;

/**
 * Classify whether errorText represents a usage/rate limit error.
 * Uses the local Ollama instance (llama3) with a long timeout to handle cold GPU starts.
 * Falls back to regex if Ollama is unavailable or the circuit breaker has tripped.
 * Returns true = is rate limit, false = is not.
 */
export async function isRateLimitError(errorText: string): Promise<boolean> {
  // Circuit breaker: skip Ollama if it's been disabled due to consecutive failures
  if (disabledUntil > Date.now()) {
    log.debug("[ollama-classifier] Circuit breaker active — using regex fallback");
    return RATE_LIMIT_RE.test(errorText);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        stream: false,
        prompt: `Classify this error as a usage limit or not. Reply with only YES or NO: ${errorText.slice(0, 1000)}`,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const data = OllamaResponseSchema.parse(await response.json());
    const answer = (data.response ?? "").trim().toUpperCase();
    const isRateLimit = answer.startsWith("YES");

    // Successful response — reset consecutive failure counter
    consecutiveFailures = 0;
    log.debug(`[ollama-classifier] Ollama classification: ${isRateLimit ? "YES" : "NO"}`);
    return isRateLimit;
  } catch (err) {
    consecutiveFailures++;
    log.debug(`[ollama-classifier] Ollama unavailable (failure ${consecutiveFailures}/${config.OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE}): ${err}`);

    if (consecutiveFailures >= config.OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE) {
      disabledUntil = Date.now() + OLLAMA_CIRCUIT_BREAKER_DISABLE_MS;
      consecutiveFailures = 0;
      log.info("[ollama-classifier] Ollama unavailable — falling back to regex for 5 min");
    }

    return RATE_LIMIT_RE.test(errorText);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Reset the Ollama availability state (consecutive failures, disabled-until timestamp).
 * Exported for use in tests to ensure clean state between test cases.
 */
export function clearOllamaAvailabilityCache(): void {
  consecutiveFailures = 0;
  disabledUntil = 0;
}
