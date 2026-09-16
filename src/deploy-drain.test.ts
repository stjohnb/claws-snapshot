import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import {
  requestDeployDrain,
  clearDeployDrain,
  getDeployDrain,
  isDeployDraining,
  registerInFlightCounter,
  inFlightCount,
  DRAIN_EXPIRY_MS,
} from "./deploy-drain.js";

describe("deploy-drain", () => {
  beforeEach(() => {
    clearDeployDrain();
  });

  it("is inactive by default", () => {
    expect(getDeployDrain()).toBeNull();
    expect(isDeployDraining()).toBe(false);
  });

  it("request activates the drain and clear lifts it", () => {
    requestDeployDrain("v2026-09-14.8", 1_000, 2_000);
    expect(getDeployDrain(2_000)).toEqual({ tag: "v2026-09-14.8", startedAt: 1_000, lastRequestAt: 2_000 });
    expect(isDeployDraining(2_000)).toBe(true);
    clearDeployDrain();
    expect(isDeployDraining(2_000)).toBe(false);
  });

  it("refresh updates tag and lastRequestAt but keeps the caller's startedAt", () => {
    requestDeployDrain("v1", 1_000, 2_000);
    requestDeployDrain("v2", 1_000, 60_000);
    expect(getDeployDrain(60_000)).toEqual({ tag: "v2", startedAt: 1_000, lastRequestAt: 60_000 });
  });

  it("expires once not refreshed for the expiry window", () => {
    requestDeployDrain("v1", 1_000, 10_000);
    expect(isDeployDraining(10_000 + DRAIN_EXPIRY_MS)).toBe(true);
    expect(isDeployDraining(10_000 + DRAIN_EXPIRY_MS + 1)).toBe(false);
    // Stays cleared even if queried with an earlier clock afterwards.
    expect(getDeployDrain(10_000)).toBeNull();
  });

  it("a refresh inside the window extends the drain", () => {
    requestDeployDrain("v1", 1_000, 10_000);
    requestDeployDrain("v1", 1_000, 10_000 + DRAIN_EXPIRY_MS - 1);
    expect(isDeployDraining(10_000 + DRAIN_EXPIRY_MS + 1)).toBe(true);
  });

  it("inFlightCount reads the registered counter", () => {
    let n = 3;
    registerInFlightCounter(() => n);
    expect(inFlightCount()).toBe(3);
    n = 0;
    expect(inFlightCount()).toBe(0);
  });
});
