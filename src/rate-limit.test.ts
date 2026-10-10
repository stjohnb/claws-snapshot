import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./slack.js", () => ({
  notify: vi.fn(),
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { notify } from "./slack.js";
import {
  isRateLimited,
  setRateLimited,
  setRateLimitedUntil,
  clearRateLimitState,
  checkAndResumeAfterCooldown,
  describeRateLimit,
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  RESET_BUFFER_MS,
} from "./rate-limit.js";

describe("rate-limit circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearRateLimitState();
    vi.mocked(notify).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("setRateLimitedUntil sets the deadline to the reset time plus the buffer", () => {
    const now = Date.now();
    const resetEpochMs = now + 10 * 60_000;
    setRateLimitedUntil(resetEpochMs);

    vi.setSystemTime(resetEpochMs + RESET_BUFFER_MS - 1);
    expect(isRateLimited()).toBe(true);

    vi.setSystemTime(resetEpochMs + RESET_BUFFER_MS + 1);
    expect(isRateLimited()).toBe(false);
  });

  it("falls back to the default cooldown when the reset is already in the past", () => {
    const now = Date.now();
    setRateLimitedUntil(now - 5000);

    vi.setSystemTime(now + DEFAULT_COOLDOWN_MS - 1);
    expect(isRateLimited()).toBe(true);

    vi.setSystemTime(now + DEFAULT_COOLDOWN_MS + 1);
    expect(isRateLimited()).toBe(false);
  });

  it("clamps a reset more than an hour out to the 1-hour max", () => {
    const now = Date.now();
    setRateLimitedUntil(now + 3 * 60 * 60_000);

    vi.setSystemTime(now + MAX_COOLDOWN_MS - 1);
    expect(isRateLimited()).toBe(true);

    vi.setSystemTime(now + MAX_COOLDOWN_MS + 1);
    expect(isRateLimited()).toBe(false);
  });

  it("never lets a later trip shorten an already-later deadline", () => {
    const now = Date.now();
    setRateLimitedUntil(now + 30 * 60_000); // long outage

    // A second, shorter trip (e.g. the 60s fallback) must not pull the
    // deadline back in.
    setRateLimited(DEFAULT_COOLDOWN_MS);

    vi.setSystemTime(now + 29 * 60_000);
    expect(isRateLimited()).toBe(true);
  });

  it("sends a Slack alert on the closed->open transition but not on a second trip while already open", () => {
    setRateLimited();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("rate limit hit"));

    vi.mocked(notify).mockClear();
    setRateLimited();
    expect(notify).not.toHaveBeenCalled();
  });

  it("checkAndResumeAfterCooldown notifies only when a trip alert was sent", () => {
    setRateLimited(1000);
    vi.mocked(notify).mockClear();

    vi.advanceTimersByTime(1001);
    checkAndResumeAfterCooldown();

    expect(isRateLimited()).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("resuming operations"));

    // The flag is consumed: a second resume with no announced trip in between
    // sends nothing, so one outage never yields two resume alerts.
    vi.mocked(notify).mockClear();
    setRateLimited(1000, { announce: false });
    vi.advanceTimersByTime(1001);
    checkAndResumeAfterCooldown();

    expect(isRateLimited()).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a silent trip opens the breaker without alerting, and the resume stays silent too", () => {
    setRateLimited(1000, { announce: false });

    expect(isRateLimited()).toBe(true);
    expect(notify).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1001);
    checkAndResumeAfterCooldown();

    expect(isRateLimited()).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("the announcing trip after a silent one alerts with the extended deadline, once (#3221)", () => {
    const now = Date.now();
    // gh() opens the breaker on the provisional 60s default while the
    // /rate_limit probe is in flight...
    setRateLimited(DEFAULT_COOLDOWN_MS, { announce: false });
    expect(notify).not.toHaveBeenCalled();

    // ...then the probe's real reset time extends it and announces it.
    setRateLimitedUntil(now + 30 * 60_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/rate limit hit.*\(30m/));

    // A further extension while the outage is already announced stays quiet.
    vi.mocked(notify).mockClear();
    setRateLimitedUntil(now + 40 * 60_000);
    expect(notify).not.toHaveBeenCalled();
  });

  it("clearRateLimitState resets the notified flag so the next trip alerts again", () => {
    setRateLimited(1000);
    clearRateLimitState();

    vi.mocked(notify).mockClear();
    setRateLimited(1000);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("describeRateLimit is null when not limited and describes the deadline otherwise", () => {
    expect(describeRateLimit()).toBeNull();

    setRateLimited(65_000);
    expect(describeRateLimit()).toMatch(/^until \d{2}:\d{2}:\d{2}Z \(1m 5s\)$/);
  });
});
