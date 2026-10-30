import { describe, it, expect } from "vitest";
import { RateLimitError, isRateLimitFailure } from "./rate-limit.js";

describe("isRateLimitFailure", () => {
  it("is true for a RateLimitError", () => {
    expect(isRateLimitFailure(new RateLimitError("slow down"))).toBe(true);
  });

  it("is true for a wrapped error whose message says the rate limit was exceeded", () => {
    expect(isRateLimitFailure(new Error("gh api failed: API rate limit exceeded for installation"))).toBe(true);
  });

  it("is false for any other failure", () => {
    expect(isRateLimitFailure(new Error("HTTP 404: Not Found"))).toBe(false);
    expect(isRateLimitFailure("rate limit exceeded")).toBe(false);
  });
});
