import { describe, it, expect } from "vitest";
import { parseUsageLimitReset, RESET_GRACE_MS, usageLimitHoldUntil } from "./usage-limit-reset.js";

const at = (iso: string) => Date.parse(iso);

describe("parseUsageLimitReset", () => {
  it("reads the printed zone: the next 02:00 London time", () => {
    // 2026-10-27 is after the clocks went back, so London is on GMT.
    const msg = "Claude AI usage limit reached · You've hit your limit · resets 2am (Europe/London)";
    expect(parseUsageLimitReset(msg, at("2026-10-27T10:00:00Z"))).toBe(at("2026-10-28T02:00:00Z"));
    // Before 02:00 the same day's reset is next.
    expect(parseUsageLimitReset(msg, at("2026-10-27T01:15:00Z"))).toBe(at("2026-10-27T02:00:00Z"));
  });

  it("applies daylight saving in the printed zone", () => {
    // 01:30 BST on 1 July: 02:00 BST is 01:00 UTC.
    expect(parseUsageLimitReset("resets 2am (Europe/London)", at("2026-07-01T00:30:00Z"))).toBe(at("2026-07-01T01:00:00Z"));
  });

  it("handles 12pm, 12am and minutes", () => {
    expect(parseUsageLimitReset("resets 12pm", at("2026-10-27T09:00:00Z"), "UTC")).toBe(at("2026-10-27T12:00:00Z"));
    expect(parseUsageLimitReset("resets 12am", at("2026-10-27T09:00:00Z"), "UTC")).toBe(at("2026-10-28T00:00:00Z"));
    // 08:00 EDT → 17:30 EDT is 21:30 UTC.
    expect(parseUsageLimitReset("You've hit your limit · resets 5:30pm", at("2026-10-27T12:00:00Z"), "America/New_York")).toBe(at("2026-10-27T21:30:00Z"));
  });

  it("wraps to the next day once the time has passed, across a month end", () => {
    expect(parseUsageLimitReset("resets 12pm", at("2026-10-31T13:00:00Z"), "UTC")).toBe(at("2026-11-01T12:00:00Z"));
    expect(parseUsageLimitReset("resets 12pm", at("2026-12-31T12:00:00Z"), "UTC")).toBe(at("2027-01-01T12:00:00Z"));
  });

  it("falls back from an invalid printed zone to the default zone, then UTC", () => {
    expect(parseUsageLimitReset("resets 9am (Not/AZone)", at("2026-10-27T12:00:00Z"), "Asia/Tokyo")).toBe(at("2026-10-28T00:00:00Z"));
    expect(parseUsageLimitReset("resets 9am (Not/AZone)", at("2026-10-27T08:00:00Z"), "Also/Bad")).toBe(at("2026-10-27T09:00:00Z"));
  });

  it("returns null when no reset time parses", () => {
    expect(parseUsageLimitReset("You've hit your weekly limit", at("2026-10-27T12:00:00Z"))).toBeNull();
    expect(parseUsageLimitReset("resets 13pm", at("2026-10-27T12:00:00Z"))).toBeNull();
    expect(parseUsageLimitReset("resets 5:75am", at("2026-10-27T12:00:00Z"))).toBeNull();
    expect(parseUsageLimitReset("resets soon", at("2026-10-27T12:00:00Z"))).toBeNull();
  });
});

describe("usageLimitHoldUntil", () => {
  const now = at("2026-10-27T10:00:00Z");

  it("holds until the printed reset plus a minute", () => {
    expect(usageLimitHoldUntil("resets 2am (Europe/London)", now, 5 * 60_000)).toBe(at("2026-10-28T02:00:00Z") + RESET_GRACE_MS);
  });

  it("takes a printed reset sooner than the fixed cooldown", () => {
    // 13:50, "resets 2pm": hold 11 minutes, not the hour-long cooldown.
    expect(usageLimitHoldUntil("You've reached your Fable limit · resets 2pm (UTC)", at("2026-10-27T13:50:00Z"), 60 * 60_000))
      .toBe(at("2026-10-27T14:00:00Z") + RESET_GRACE_MS);
  });

  it("uses the fixed cooldown when no reset time is printed", () => {
    expect(usageLimitHoldUntil("You've hit your limit", now, 5 * 60_000)).toBe(now + 5 * 60_000);
  });
});
