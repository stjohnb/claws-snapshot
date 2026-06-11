import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  HOME_ASSISTANT_BASE_URL: "http://ha.local",
  HOME_ASSISTANT_TOKEN: "test-token",
}));

import { isHaTransient } from "./home-assistant.js";

describe("isHaTransient", () => {
  it("returns true for HA API 500", () => {
    expect(isHaTransient(new Error("HA API 500 for /api/states: Internal Server Error"))).toBe(true);
  });

  it("returns true for HA API 502", () => {
    expect(isHaTransient(new Error("HA API 502 for /api/states: Bad Gateway"))).toBe(true);
  });

  it("returns true for HA API 503", () => {
    expect(isHaTransient(new Error("HA API 503 for /api/states: Service Unavailable"))).toBe(true);
  });

  it("returns true for HA API 504", () => {
    expect(isHaTransient(new Error("HA API 504 for /api/states: Gateway Timeout"))).toBe(true);
  });

  it("returns true for HA API 429 (rate limited)", () => {
    expect(isHaTransient(new Error("HA API 429 for /api/states: Too Many Requests"))).toBe(true);
  });

  it("returns false for HA API 404", () => {
    expect(isHaTransient(new Error("HA API 404 for /api/states/missing: Not Found"))).toBe(false);
  });

  it("returns false for HA API 401", () => {
    expect(isHaTransient(new Error("HA API 401 for /api/states: Unauthorized"))).toBe(false);
  });

  it("returns false for HA API 501", () => {
    expect(isHaTransient(new Error("HA API 501 for /api/states: Not Implemented"))).toBe(false);
  });

  it("returns true when err.name is TimeoutError", () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    expect(isHaTransient(err)).toBe(true);
  });

  it("returns false for a generic Error", () => {
    expect(isHaTransient(new Error("Something went wrong"))).toBe(false);
  });
});
