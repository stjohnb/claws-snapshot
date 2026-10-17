import { describe, it, expect, beforeEach, vi } from "vitest";
import { ShutdownError } from "./shutdown.js";

describe("shutdown signal", () => {
  let setShuttingDown: () => void;
  let isShuttingDown: () => boolean;
  let shutdownStartedAt: () => number | null;

  beforeEach(async () => {
    // Re-import fresh module to reset state
    vi.resetModules();
    const mod = await import("./shutdown.js");
    setShuttingDown = mod.setShuttingDown;
    isShuttingDown = mod.isShuttingDown;
    shutdownStartedAt = mod.shutdownStartedAt;
  });

  it("isShuttingDown returns false initially", () => {
    expect(isShuttingDown()).toBe(false);
  });

  it("setShuttingDown makes isShuttingDown return true", () => {
    setShuttingDown();
    expect(isShuttingDown()).toBe(true);
  });

  it("shutdownStartedAt is null before setShuttingDown", () => {
    expect(shutdownStartedAt()).toBeNull();
  });

  it("shutdownStartedAt is non-null after setShuttingDown", () => {
    setShuttingDown();
    expect(shutdownStartedAt()).not.toBeNull();
  });

  it("a second setShuttingDown does not change the recorded start time", () => {
    setShuttingDown();
    const first = shutdownStartedAt();
    setShuttingDown();
    expect(shutdownStartedAt()).toBe(first);
  });
});

describe("ShutdownError", () => {
  it("is an instance of Error with name ShutdownError", () => {
    const err = new ShutdownError("test message");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ShutdownError");
    expect(err.message).toBe("test message");
  });
});
