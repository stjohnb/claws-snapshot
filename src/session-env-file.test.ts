import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("./config.js", () => ({ WORK_DIR: "/home/test/.claws" }));
vi.mock("node:os", () => ({ default: { homedir: () => "/home/codex" } }));

import {
  sessionEnvDir,
  writeSessionEnvFile,
  removeSessionEnvFile,
  pruneSessionEnvFiles,
  ensureSessionMcpDir,
  sessionCodexHomeDir,
  ensureSessionCodexHome,
  pruneOrphanSessionMcpDirs,
  removeSessionMcpDir,
} from "./session-env-file.js";

describe("session-env-file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue([]);
  });

  it("writes the env file at 0600 under WORK_DIR/session-env", () => {
    const file = writeSessionEnvFile("abc123", { HOME_ASSISTANT_TOKEN: "tok" });

    expect(file).toBe("/home/test/.claws/session-env/abc123.env");
    expect(sessionEnvDir()).toBe("/home/test/.claws/session-env");
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      file,
      "export HOME_ASSISTANT_TOKEN='tok'\n",
      { mode: 0o600 },
    );
  });

  it("chmods the file to 0600 and the dir to 0700 (umask/existing-file safety)", () => {
    const file = writeSessionEnvFile("abc123", { K: "v" });

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(sessionEnvDir(), { recursive: true, mode: 0o700 });
    expect(mockFs.chmodSync).toHaveBeenCalledWith(sessionEnvDir(), 0o700);
    expect(mockFs.chmodSync).toHaveBeenCalledWith(file, 0o600);
  });

  it("returns an absolute path so `.` does not search PATH", () => {
    expect(writeSessionEnvFile("deadbeef", { K: "v" }).startsWith("/")).toBe(true);
  });

  it("escapes single quotes in values", () => {
    writeSessionEnvFile("abc123", { K: "a'b" });
    expect(mockFs.writeFileSync.mock.calls[0][1]).toBe(`export K='a'\\''b'\n`);
  });

  it("writes one export line per var", () => {
    writeSessionEnvFile("abc123", { A: "1", B: "2" });
    expect(mockFs.writeFileSync.mock.calls[0][1]).toBe("export A='1'\nexport B='2'\n");
  });

  it("propagates a write failure to the caller", () => {
    mockFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    expect(() => writeSessionEnvFile("abc123", { K: "v" })).toThrow("ENOSPC");
  });

  it("removeSessionEnvFile force-removes and never throws", () => {
    mockFs.rmSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => removeSessionEnvFile("abc123")).not.toThrow();
    expect(mockFs.rmSync).toHaveBeenCalledWith("/home/test/.claws/session-env/abc123.env", {
      force: true,
    });
  });

  it("pruneSessionEnvFiles removes the whole dir and never throws", () => {
    mockFs.rmSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => pruneSessionEnvFiles()).not.toThrow();
    expect(mockFs.rmSync).toHaveBeenCalledWith(sessionEnvDir(), { recursive: true, force: true });
  });

  it("ensureSessionMcpDir creates and chmods the per-session MCP dir", () => {
    const dir = ensureSessionMcpDir("abc");

    expect(dir).toBe("/home/test/.claws/session-mcp/abc");
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(mockFs.chmodSync).toHaveBeenCalledWith(dir, 0o700);
  });

  it("removeSessionMcpDir force-removes recursively and never throws", () => {
    mockFs.rmSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => removeSessionMcpDir("abc")).not.toThrow();
    expect(mockFs.rmSync).toHaveBeenCalledWith("/home/test/.claws/session-mcp/abc", {
      recursive: true,
      force: true,
    });
  });

  it("creates a private session Codex home with a minimal config", () => {
    const dir = ensureSessionCodexHome("abc");

    expect(dir).toBe("/home/test/.claws/session-mcp/abc/codex-home");
    expect(sessionCodexHomeDir("abc")).toBe(dir);
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/abc/codex-home/config.toml",
      "# Claws session-local Codex config. Ambient plugins and MCP servers are intentionally not inherited.\n",
      { mode: 0o600 },
    );
    expect(mockFs.chmodSync).toHaveBeenCalledWith("/home/test/.claws/session-mcp/abc/codex-home/config.toml", 0o600);
  });

  it("copies ~/.codex/auth.json into the private Codex home when present", () => {
    mockFs.existsSync.mockReturnValue(true);

    ensureSessionCodexHome("abc");

    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      "/home/codex/.codex/auth.json",
      "/home/test/.claws/session-mcp/abc/codex-home/auth.json",
    );
    expect(mockFs.chmodSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/abc/codex-home/auth.json",
      0o600,
    );
  });

  it("skips the auth copy when ~/.codex/auth.json is absent", () => {
    mockFs.existsSync.mockReturnValue(false);

    ensureSessionCodexHome("abc");

    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    expect(mockFs.rmSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/abc/codex-home/auth.json",
      { force: true },
    );
  });

  it("prunes orphaned session MCP dirs and keeps active ones", () => {
    mockFs.readdirSync.mockReturnValue([
      { name: "keep-me", isDirectory: () => true },
      { name: "drop-me", isDirectory: () => true },
      { name: "notes.txt", isDirectory: () => false },
    ]);

    pruneOrphanSessionMcpDirs(["keep-me"]);

    expect(mockFs.rmSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/drop-me",
      { recursive: true, force: true },
    );
    expect(mockFs.rmSync).not.toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/keep-me",
      { recursive: true, force: true },
    );
  });

  it("swallows prune errors", () => {
    mockFs.readdirSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });

    expect(() => pruneOrphanSessionMcpDirs(["keep-me"])).not.toThrow();
  });
});
