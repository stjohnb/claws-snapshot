import * as log from "./log.js";
import { formatMs } from "./format.js";
import { notify } from "./slack.js";

// ── Circuit breaker (rate limit protection) ──

let rateLimitedUntil: number | null = null;
let tripNotified = false;

export const DEFAULT_COOLDOWN_MS = 60_000;
export const MAX_COOLDOWN_MS = 3_600_000;
export const RESET_BUFFER_MS = 5_000;

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** True for a {@link RateLimitError}, or any error whose message says the rate
 *  limit was exceeded (a wrapped or re-thrown failure). */
export function isRateLimitFailure(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  return err instanceof Error && /rate limit exceeded/i.test(err.message);
}

export function isRateLimited(): boolean {
  return rateLimitedUntil !== null && Date.now() < rateLimitedUntil;
}

/** `null` when not rate-limited, else `until HH:MM:SSZ (duration)` for logs/jobs. */
export function describeRateLimit(): string | null {
  // Gated on isRateLimited(), not `rateLimitedUntil !== null`: the deadline is
  // only nulled by checkAndResumeAfterCooldown(), which runs from gh() alone.
  // Between deadline expiry and the next gh() call this would otherwise report
  // an already-closed breaker as open.
  if (!isRateLimited()) return null;
  const until = rateLimitedUntil as number;
  return `until ${new Date(until).toISOString().slice(11, 19)}Z (${formatMs(until - Date.now())})`;
}

function clampCooldown(cooldownMs: number): number {
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return DEFAULT_COOLDOWN_MS;
  return Math.min(cooldownMs, MAX_COOLDOWN_MS);
}

export interface TripOptions {
  /**
   * Send the Slack alert for this trip. Pass `false` to open the breaker
   * silently when the deadline is still provisional — the caller is then
   * expected to trip again once it knows the real reset time, and that trip
   * announces the accurate resume time.
   */
  announce?: boolean;
}

/**
 * Open (or extend) the breaker. The deadline only ever moves later — a trip
 * carrying a shorter deadline than one already in effect never shortens it.
 * Slack notification fires on the closed→open transition, or on the first
 * announcing trip after a silent one; a trip that only extends an
 * already-announced outage just logs.
 */
function trip(cooldownMs: number, announce: boolean): void {
  const wasLimited = isRateLimited();
  rateLimitedUntil = Math.max(rateLimitedUntil ?? 0, Date.now() + cooldownMs);
  log.warn(`[github] Rate limit detected — blocking API calls ${describeRateLimit()}`);
  if (announce && (!wasLimited || !tripNotified)) {
    notify(`[WARN] GitHub API rate limit hit — blocking calls ${describeRateLimit()}`);
    tripNotified = true;
  }
}

export function setRateLimited(cooldownMs = DEFAULT_COOLDOWN_MS, options: TripOptions = {}): void {
  trip(clampCooldown(cooldownMs), options.announce ?? true);
}

/** Trip the breaker to GitHub's real reset time (epoch ms), plus a small
 *  buffer so the first post-cooldown call doesn't land a second early. Falls
 *  back to the default cooldown when the reset is unusable (past or non-finite). */
export function setRateLimitedUntil(resetEpochMs: number, options: TripOptions = {}): void {
  trip(clampCooldown(resetEpochMs + RESET_BUFFER_MS - Date.now()), options.announce ?? true);
}

export function clearRateLimitState(): void {
  rateLimitedUntil = null;
  tripNotified = false;
}

/**
 * If a cooldown was set but has now elapsed, clear it and notify once. Called by
 * gh() before each attempt to reproduce the previous notify-once-on-resume behaviour.
 */
export function checkAndResumeAfterCooldown(): void {
  if (rateLimitedUntil !== null && Date.now() >= rateLimitedUntil) {
    rateLimitedUntil = null;
    log.info("[github] Rate limit cooldown expired — resuming API calls");
    if (tripNotified) {
      notify("[INFO] GitHub API rate limit passed — resuming operations");
      tripNotified = false;
    }
  }
}
