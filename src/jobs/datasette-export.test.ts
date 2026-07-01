import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

const mockFs = vi.hoisted(() => ({
  statSync: vi.fn().mockReturnValue({ size: 33 * 1024 * 1024 }),
  unlinkSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  default: mockFs,
}));

const mockBackupDb = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({
  backupDb: mockBackupDb,
}));

const mockDatasetteExport = vi.hoisted(() => ({ value: null as null | { host: string; user?: string; port?: number; identityFile?: string; remotePath: string } }));
vi.mock("../config.js", () => ({
  get DATASETTE_EXPORT() { return mockDatasetteExport.value; },
  WORK_DIR: "/home/user/.claws",
}));

vi.mock("../log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { run } from "./datasette-export.js";
import * as log from "../log.js";

const defaultCfg = {
  host: "203.0.113.20",
  user: "user",
  port: 22,
  identityFile: "~/.ssh/id_ed25519",
  remotePath: "/data/claws.db",
};

function mockScpSuccess() {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, "", "");
  });
}

function mockScpFailure(msg: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(new Error(msg), "", msg);
  });
}

describe("datasette-export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDatasetteExport.value = null;
    mockBackupDb.mockResolvedValue(undefined);
    mockFs.statSync.mockReturnValue({ size: 33 * 1024 * 1024 });
    mockFs.unlinkSync.mockReturnValue(undefined);
  });

  it("skips when not configured", async () => {
    mockDatasetteExport.value = null;
    await run();
    expect(log.debug).toHaveBeenCalledWith("[datasette-export] Not configured — skipping");
    expect(mockBackupDb).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("creates backup and SCPs to remote", async () => {
    mockDatasetteExport.value = defaultCfg;
    mockScpSuccess();

    await run();

    expect(mockBackupDb).toHaveBeenCalledWith("/home/user/.claws/claws-datasette-export.db");
    expect(mockExecFile).toHaveBeenCalledWith(
      "scp",
      expect.arrayContaining([
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=10",
        "-o", "BatchMode=yes",
        "-i", expect.stringContaining(".ssh/id_ed25519"),
        "/home/user/.claws/claws-datasette-export.db",
        "user@203.0.113.20:/data/claws.db",
      ]),
      { timeout: 120_000 },
      expect.any(Function),
    );
    expect(log.info).toHaveBeenCalledWith("[datasette-export] Upload complete");
  });

  it("cleans up temp file on success", async () => {
    mockDatasetteExport.value = defaultCfg;
    mockScpSuccess();

    await run();

    expect(mockFs.unlinkSync).toHaveBeenCalledWith("/home/user/.claws/claws-datasette-export.db");
  });

  it("cleans up temp file on SCP failure", async () => {
    mockDatasetteExport.value = defaultCfg;
    mockBackupDb.mockResolvedValue(undefined);
    mockScpFailure("permission denied");

    await expect(run()).rejects.toThrow("permission denied");
    expect(mockFs.unlinkSync).toHaveBeenCalledWith("/home/user/.claws/claws-datasette-export.db");
  });

  it("omits -P flag when port is 22", async () => {
    mockDatasetteExport.value = { ...defaultCfg, port: 22 };
    mockScpSuccess();

    await run();

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).not.toContain("-P");
  });

  it("omits -P flag when port is undefined", async () => {
    const { port: _, ...cfgWithoutPort } = defaultCfg;
    mockDatasetteExport.value = cfgWithoutPort;
    mockScpSuccess();

    await run();

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).not.toContain("-P");
  });

  it("includes -P flag for non-default port", async () => {
    mockDatasetteExport.value = { ...defaultCfg, port: 2222 };
    mockScpSuccess();

    await run();

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-P");
    expect(args).toContain("2222");
  });

  it("handles backup failure — no SCP attempted", async () => {
    mockDatasetteExport.value = defaultCfg;
    mockBackupDb.mockRejectedValue(new Error("disk full"));

    await expect(run()).rejects.toThrow("disk full");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockFs.unlinkSync).toHaveBeenCalled();
  });

  it("uses host without user when user is not set", async () => {
    mockDatasetteExport.value = { host: "203.0.113.20", remotePath: "/data/claws.db" };
    mockScpSuccess();

    await run();

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("203.0.113.20:/data/claws.db");
    expect(args).not.toContain("-i");
  });

  it("uses user@host format and omits -i when user is set but identityFile is not", async () => {
    mockDatasetteExport.value = { host: "203.0.113.20", user: "user", remotePath: "/data/claws.db" };
    mockScpSuccess();

    await run();

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("user@203.0.113.20:/data/claws.db");
    expect(args).not.toContain("-i");
  });

  it("uses bare host format and includes -i when identityFile is set but user is not", async () => {
    mockDatasetteExport.value = { host: "203.0.113.20", identityFile: "~/.ssh/id_ed25519", remotePath: "/data/claws.db" };
    mockScpSuccess();

    await run();

    const args = mockExecFile.mock.calls[0][1] as string[];
    const destination = args[args.length - 1];
    expect(destination).toBe("203.0.113.20:/data/claws.db");
    const iIdx = args.indexOf("-i");
    expect(iIdx).toBeGreaterThan(-1);
    expect(args[iIdx + 1]).toContain(".ssh/id_ed25519");
  });
});
