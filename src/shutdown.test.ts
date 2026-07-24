import { describe, it, expect, beforeEach } from "vitest";
import { ShutdownError } from "./shutdown.js";

describe("shutdown signal", () => {
  let setShuttingDown: () => void;
  let isShuttingDown: () => boolean;

  beforeEach(async () => {
    // Re-import fresh module to reset state
    const mod = await import("./shutdown.js");
    setShuttingDown = mod.setShuttingDown;
    isShuttingDown = mod.isShuttingDown;
  });

  it("isShuttingDown returns false initially", () => {
    expect(isShuttingDown()).toBe(false);
  });

  it("setShuttingDown makes isShuttingDown return true", () => {
    setShuttingDown();
    expect(isShuttingDown()).toBe(true);
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
