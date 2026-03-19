import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

const mockRunnerHosts = vi.hoisted(() => ({ value: [] as Array<{ name?: string; host: string; user?: string; port?: number; identityFile?: string; actionsDir: string }> }));
vi.mock("../config.js", () => ({
  get RUNNER_HOSTS() { return mockRunnerHosts.value; },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockReportError = vi.hoisted(() => vi.fn());
vi.mock("../error-reporter.js", () => ({
  reportError: mockReportError,
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({
  notify: mockNotify,
}));

import { run, sshExec } from "./runner-monitor.js";
import * as log from "../log.js";

function mockSshResponse(responses: Record<string, string | Error>) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const command = args[args.length - 1];
    const response = responses[command];
    if (response instanceof Error) {
      cb(response, "", response.message);
    } else {
      cb(null, response ?? "", "");
    }
  });
}

function mockSshResponseSequential(responses: Array<string | Error>) {
  let callIndex = 0;
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const response = responses[callIndex++];
    if (response instanceof Error) {
      cb(response, "", response.message);
    } else {
      cb(null, response ?? "", "");
    }
  });
}

const defaultRunner = {
  name: "test-runner",
  host: "10.0.0.1",
  user: "actions",
  port: 22,
  identityFile: "~/.ssh/id_ed25519",
  actionsDir: "/home/actions/actions-runner",
};

describe("runner-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunnerHosts.value = [];
    mockReportError.mockResolvedValue(undefined);
  });

  it("skips when no runners configured", async () => {
    mockRunnerHosts.value = [];
    await run();
    expect(log.info).toHaveBeenCalledWith("[runner-monitor] No runners configured — skipping");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("logs healthy when runner service is active and no issues", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponse({
      [`cd ${defaultRunner.actionsDir} && sudo ./svc.sh status`]: "active (running)",
      [`ps -eo pid,etimes,comm | grep -E 'Runner\\.(Worker|Listener)' || true`]: "",
      [`df --output=pcent / | tail -1`]: "  42%",
    });

    await run();

    expect(log.info).toHaveBeenCalledWith("[runner-monitor] test-runner healthy");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("restarts dead service and notifies Slack", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → not active
      "inactive (dead)",
      // stop + start
      "",
      // verify → now active
      "active (running)",
      // zombie check
      "",
      // disk check
      "  42%",
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("service not active — restarting"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("service restarted successfully"));
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("restarted service on test-runner"));
  });

  it("reports restart failure via actions", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → not active
      "inactive (dead)",
      // stop + start → fails
      new Error("sudo failed"),
      // zombie check
      "",
      // disk check
      "  42%",
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("restart failed"));
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("restart failed on test-runner"));
  });

  it("kills stale zombie process when service is dead", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → not active
      "inactive (dead)",
      // restart stop+start
      "",
      // verify → still dead
      "inactive (dead)",
      // zombie check → stale process (25000 seconds = ~7 hours)
      "12345 25000 Runner.Worker",
      // kill
      "",
      // disk check
      "  42%",
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("killed orphaned process 12345"));
  });

  it("does NOT kill stale process when service is active", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check → stale process
      "12345 25000 Runner.Worker",
      // disk check
      "  42%",
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("stale process 12345"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("skipping kill"));
    // Should not have a kill call
    const killCalls = mockExecFile.mock.calls.filter((c: unknown[]) => {
      const args = c[1] as string[];
      return args[args.length - 1].includes("kill");
    });
    expect(killCalls).toHaveLength(0);
  });

  it("cleans temp files on high disk usage", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponse({
      [`cd ${defaultRunner.actionsDir} && sudo ./svc.sh status`]: "active (running)",
      [`ps -eo pid,etimes,comm | grep -E 'Runner\\.(Worker|Listener)' || true`]: "",
      [`df --output=pcent / | tail -1`]: "  95%",
      [`sudo rm -rf /tmp/_github_* ${defaultRunner.actionsDir}/_work/_temp/*`]: "",
    });

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("disk usage 95%"));
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("cleaned temp files on test-runner"));
  });

  it("SSH connection failure on one host does not block next host", async () => {
    const runner1 = { ...defaultRunner, name: "runner-A", host: "10.0.0.1" };
    const runner2 = { ...defaultRunner, name: "runner-B", host: "10.0.0.2" };
    mockRunnerHosts.value = [runner1, runner2];

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const target = args.find((a: string) => a.includes("@"));
      if (target?.includes("10.0.0.1")) {
        cb(new Error("Connection refused"), "", "Connection refused");
        return;
      }
      const command = args[args.length - 1];
      if (command.includes("svc.sh status")) {
        cb(null, "active (running)", "");
      } else if (command.includes("ps -eo")) {
        cb(null, "", "");
      } else if (command.includes("df")) {
        cb(null, "  42%", "");
      } else {
        cb(null, "", "");
      }
    });

    await run();

    // runner-A: SSH failure on status → serviceActive=false → restart fails → actions recorded
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("runner-A"));
    // runner-B: healthy
    expect(log.info).toHaveBeenCalledWith("[runner-monitor] runner-B healthy");
  });


  it("sends single Slack notification with multiple actions across hosts", async () => {
    const runner1 = { ...defaultRunner, name: "runner-A", host: "10.0.0.1" };
    const runner2 = { ...defaultRunner, name: "runner-B", host: "10.0.0.2" };
    mockRunnerHosts.value = [runner1, runner2];

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const command = args[args.length - 1];
      if (command.includes("svc.sh status")) {
        cb(null, "active (running)", "");
      } else if (command.includes("ps -eo")) {
        cb(null, "", "");
      } else if (command.includes("df")) {
        cb(null, "  95%", "");
      } else if (command.includes("rm -rf")) {
        cb(null, "", "");
      } else {
        cb(null, "", "");
      }
    });

    await run();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const msg = mockNotify.mock.calls[0][0] as string;
    expect(msg).toContain("runner-A");
    expect(msg).toContain("runner-B");
  });

  it("uses user@host as display name when name is not set", async () => {
    mockRunnerHosts.value = [{ host: "10.0.0.1", user: "deploy", actionsDir: "/opt/runner" }];
    mockSshResponse({
      [`cd /opt/runner && sudo ./svc.sh status`]: "active (running)",
      [`ps -eo pid,etimes,comm | grep -E 'Runner\\.(Worker|Listener)' || true`]: "",
      [`df --output=pcent / | tail -1`]: "  42%",
    });

    await run();

    expect(log.info).toHaveBeenCalledWith("[runner-monitor] deploy@10.0.0.1 healthy");
  });

  describe("sshExec", () => {
    it("passes correct SSH flags", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, "ok");
      });

      await sshExec(defaultRunner, "whoami");

      expect(mockExecFile).toHaveBeenCalledWith(
        "ssh",
        expect.arrayContaining([
          "-o", "StrictHostKeyChecking=accept-new",
          "-o", "ConnectTimeout=10",
          "-o", "BatchMode=yes",
          "-i", expect.stringContaining(".ssh/id_ed25519"),
          "actions@10.0.0.1",
          "whoami",
        ]),
        { timeout: 30_000 },
        expect.any(Function),
      );
    });

    it("omits -p flag when port is 22", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, "ok");
      });

      await sshExec(defaultRunner, "whoami");

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("-p");
    });

    it("includes -p flag when port is non-default", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, "ok");
      });

      await sshExec({ ...defaultRunner, port: 2222 }, "whoami");

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-p");
      expect(args).toContain("2222");
    });

    it("rejects on SSH error", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(new Error("Connection refused"), "", "Connection refused");
      });

      await expect(sshExec(defaultRunner, "whoami")).rejects.toThrow("Connection refused");
    });
  });
});
