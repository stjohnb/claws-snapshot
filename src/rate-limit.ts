import * as log from "./log.js";
import { formatMs } from "./format.js";
import { notify } from "./slack.js";

// ── Circuit breaker (rate limit protection) ──

let rateLimitedUntil: number | null = null;

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export function isRateLimited(): boolean {
  return rateLimitedUntil !== null && Date.now() < rateLimitedUntil;
}

export function setRateLimited(cooldownMs = 60_000): void {
  rateLimitedUntil = Date.now() + cooldownMs;
  log.warn(`[github] Rate limit detected — blocking API calls for ${formatMs(cooldownMs)}`);
  notify(`[WARN] GitHub API rate limit hit — blocking calls for ${formatMs(cooldownMs)}`);
}

export function clearRateLimitState(): void {
  rateLimitedUntil = null;
}

/**
 * If a cooldown was set but has now elapsed, clear it and notify once. Called by
 * gh() before each attempt to reproduce the previous notify-once-on-resume behaviour.
 */
export function checkAndResumeAfterCooldown(): void {
  if (rateLimitedUntil !== null && Date.now() >= rateLimitedUntil) {
    rateLimitedUntil = null;
    log.info("[github] Rate limit cooldown expired — resuming API calls");
    notify("[INFO] GitHub API rate limit passed — resuming operations");
  }
}
