import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExistsSync } = vi.hoisted(() => ({ mockExistsSync: vi.fn() }));
vi.mock("node:fs", () => ({ default: { existsSync: mockExistsSync } }));

import { isContainer } from "./runtime-env.js";

describe("isContainer", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["CLAWS_RUNTIME"];
    delete process.env["KUBERNETES_SERVICE_HOST"];
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(origEnv)) {
      process.env[key] = value;
    }
  });

  it("returns true when CLAWS_RUNTIME=container", () => {
    process.env["CLAWS_RUNTIME"] = "container";
    expect(isContainer()).toBe(true);
  });

  it("returns false when CLAWS_RUNTIME=host even with KUBERNETES_SERVICE_HOST set", () => {
    process.env["CLAWS_RUNTIME"] = "host";
    process.env["KUBERNETES_SERVICE_HOST"] = "10.0.0.1";
    expect(isContainer()).toBe(false);
  });

  it("returns true when KUBERNETES_SERVICE_HOST is set alone", () => {
    process.env["KUBERNETES_SERVICE_HOST"] = "10.0.0.1";
    expect(isContainer()).toBe(true);
  });

  it("falls back to fs.existsSync(/.dockerenv) when neither is set", () => {
    mockExistsSync.mockReturnValue(true);
    expect(isContainer()).toBe(true);
    expect(mockExistsSync).toHaveBeenCalledWith("/.dockerenv");

    mockExistsSync.mockReturnValue(false);
    expect(isContainer()).toBe(false);
  });
});
