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

describe("resolveHeadlessShell", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, HOME: "/home/test", PATH: "/opt/x" };
  });
  afterEach(() => {
    vi.doUnmock("node:fs");
    process.env = { ...originalEnv };
  });

  const mockFs = (executable: string[]) =>
    vi.doMock("node:fs", () => ({
      default: {
        constants: { X_OK: 1 },
        existsSync: vi.fn(() => false),
        accessSync: vi.fn((p: string) => {
          if (!executable.includes(p)) throw new Error("ENOENT");
        }),
      },
    }));

  it("prefers /bin/bash", async () => {
    mockFs(["/bin/bash", "/opt/x/bash"]);
    const { resolveHeadlessShell } = await import("./cli-path.js");
    expect(resolveHeadlessShell()).toBe("/bin/bash");
  });

  it("falls back to bash on PATH", async () => {
    mockFs(["/opt/x/bash"]);
    const { resolveHeadlessShell } = await import("./cli-path.js");
    expect(resolveHeadlessShell()).toBe("/opt/x/bash");
  });

  it("returns null when no bash exists", async () => {
    mockFs([]);
    const { resolveHeadlessShell } = await import("./cli-path.js");
    expect(resolveHeadlessShell()).toBeNull();
  });
});
