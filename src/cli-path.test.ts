import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

describe("cli path helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, HOME: "/home/test", PATH: "/usr/bin" };
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
    process.env = { ...originalEnv };
  });

  it("prepends existing profile-installed CLI directories", async () => {
    vi.doMock("node:fs", () => ({
      default: {
        existsSync: vi.fn((p: string) => p === "/home/test/.local/bin"),
      },
    }));

    const { enrichedPath } = await import("./cli-path.js");

    expect(enrichedPath(process.env["PATH"])).toBe("/home/test/.local/bin:/usr/bin");
  });

  it("finds a CLI binary that exists only on the enriched path", async () => {
    vi.doMock("node:fs", () => ({
      default: {
        existsSync: vi.fn((p: string) =>
          p === "/home/test/.local/bin" || p === "/home/test/.local/bin/codex"
        ),
      },
    }));

    const { isCliBinaryAvailable } = await import("./cli-path.js");

    expect(isCliBinaryAvailable("codex")).toBe(true);
  });
});
