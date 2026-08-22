import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("./config.js", () => ({ WORK_DIR: "/home/test/.claws" }));

import {
  sessionEnvDir,
  writeSessionEnvFile,
  removeSessionEnvFile,
  pruneSessionEnvFiles,
  ensureSessionMcpDir,
  removeSessionMcpDir,
} from "./session-env-file.js";

describe("session-env-file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
