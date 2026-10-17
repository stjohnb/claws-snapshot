import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { MAC_RUNNERS, MAC_RUNNER_REPOS, mockGh, mockSsh, mockLog, mockReportError, mockNotify, mockUpsert } = vi.hoisted(() => ({
  MAC_RUNNERS: [
    { name: "Brendans-MacBook-Pro", host: "brendans-macbook-pro.local", user: undefined as string | undefined, labels: ["macos", "tempo"], enabled: undefined as boolean | undefined },
    { name: "Brendans-MacBook-Pro-3", host: "brendans-macbook-pro-3.local", user: undefined as string | undefined, labels: ["macos", "xcode26"], enabled: undefined as boolean | undefined },
  ],
  MAC_RUNNER_REPOS: ["St-John-Software/bonkus"],
  mockGh: {
    fetchQueuedWorkflowRuns: vi.fn(),
    fetchQueuedJobsForRun: vi.fn(),
    fetchSelfHostedRunners: vi.fn(),
  },
  mockSsh: {
    buildSshArgs: vi.fn(() => ["-o", "BatchMode=yes"]),
    execCapture: vi.fn(),
  },
  mockLog: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
  mockReportError: vi.fn(),
  mockNotify: vi.fn(),
  mockUpsert: vi.fn(),
}));

vi.mock("../config.js", () => ({
  MAC_RUNNERS,
  MAC_RUNNER_REPOS,
  SELF_REPO: "St-John-Software/claws",
  getMacRunnerRepos: () => MAC_RUNNER_REPOS,
  resolveLanHost: (target: { name?: string; host: string; user?: string }) => {
    const key = (target.host || target.name || "").toLowerCase().replace(/\.local$/, "");
    if (key === "brendans-macbook-pro") return { ...target, host: "resolved-mbp", user: target.user ?? "brendan" };
    if (key === "brendans-macbook-pro-3") return { ...target, host: "resolved-mbp3", user: target.user ?? "brendanstjohn" };
    return target;
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../ssh.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ssh.js")>(),
  ...mockSsh,
}));
vi.mock("../log.js", () => mockLog);
vi.mock("../error-reporter.js", () => ({ reportError: mockReportError }));
vi.mock("../retry.js", () => ({ retryWithBackoff: (fn: () => Promise<unknown>) => fn() }));
vi.mock("../occurrence-tracking.js", () => ({ upsertAlertIssue: mockUpsert }));
vi.mock("../slack.js", () => ({ notify: mockNotify }));

import { run, isMacJob, matchingRunners, isHostAbsent, isConnectionRefused, _resetState } from "./mac-runner-waker.js";

const NOW = new Date("2026-07-09T12:00:00Z").getTime();

function queuedRun(runId: number, ageMs: number) {
  return {
    run_id: runId,
    repo: "St-John-Software/bonkus",
    workflow_name: "CI",
    status: "queued",
    conclusion: null,
    event: "push",
    head_branch: "main",
    created_at: new Date(NOW - ageMs).toISOString(),
    run_started_at: null,
    updated_at: new Date(NOW - ageMs).toISOString(),
  };
}

describe("mac-runner-waker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockSsh.buildSshArgs.mockReturnValue(["-o", "BatchMode=yes"]);
    mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([]);
    mockGh.fetchQueuedJobsForRun.mockResolvedValue([]);
    mockGh.fetchSelfHostedRunners.mockResolvedValue([]);
    mockSsh.execCapture.mockResolvedValue("awake\n");
    mockUpsert.mockResolvedValue("created");
    delete MAC_RUNNERS[0].user;
    _resetState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("matchingRunners", () => {
    it("matches both runners for a plain macos job", () => {
      const result = matchingRunners(["self-hosted", "macos"], MAC_RUNNERS);
      expect(result.map(r => r.host)).toEqual([MAC_RUNNERS[0].host, MAC_RUNNERS[1].host]);
    });

    it("matches only -3 for macos + xcode26", () => {
      const result = matchingRunners(["self-hosted", "macos", "xcode26"], MAC_RUNNERS);
      expect(result.map(r => r.host)).toEqual(["brendans-macbook-pro-3.local"]);
    });

    it("matches only the first for macos + tempo", () => {
      const result = matchingRunners(["self-hosted", "macos", "tempo"], MAC_RUNNERS);
      expect(result.map(r => r.host)).toEqual(["brendans-macbook-pro.local"]);
    });

    it("matches none for macos + arm64", () => {
      const result = matchingRunners(["self-hosted", "macos", "arm64"], MAC_RUNNERS);
      expect(result).toEqual([]);
    });

    it("is case-insensitive", () => {
      const result = matchingRunners(["self-hosted", "MacOS"], MAC_RUNNERS);
      expect(result.length).toBe(2);
    });
  });

  describe("isMacJob", () => {
    it("is true when labels include macos", () => {
      expect(isMacJob(["self-hosted", "macos"])).toBe(true);
    });

    it("is false otherwise", () => {
      expect(isMacJob(["self-hosted", "linux"])).toBe(false);
    });
  });

  describe("isHostAbsent", () => {
    it("is true for host-absent SSH failures", () => {
      expect(isHostAbsent(new Error("ssh: Could not resolve hostname brendans-macbook-pro.local: Name or service not known"))).toBe(true);
      expect(isHostAbsent(new Error("ssh: connect to host x port 22: No route to host"))).toBe(true);
      expect(isHostAbsent(new Error("Host is down"))).toBe(true);
      expect(isHostAbsent(new Error("ssh: connect to host brendans-macbook-pro-3.local port 22: Connection timed out"))).toBe(true);
      expect(isHostAbsent(new Error("Operation timed out"))).toBe(true);
    });

    it("is false for non-absence failures", () => {
      expect(isHostAbsent(new Error("ssh: Permission denied (publickey,password,keyboard-interactive)"))).toBe(false);
      expect(isHostAbsent(new Error("Host key verification failed"))).toBe(false);
      expect(isHostAbsent(new Error("Connection refused"))).toBe(false);
    });
  });

  describe("isConnectionRefused", () => {
    it("is true for the exact refusal message", () => {
      expect(isConnectionRefused(new Error("ssh: connect to host Brendans-MacBook-Pro port 22: Connection refused"))).toBe(true);
    });

    it("is false for other SSH failures", () => {
      expect(isConnectionRefused(new Error("ssh: Permission denied (publickey)"))).toBe(false);
      expect(isConnectionRefused(new Error("Host key verification failed"))).toBe(false);
    });
  });

  describe("run", () => {
    it("wakes the matching host for an old queued macos job", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(1, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);

      await run();

      expect(mockSsh.execCapture).toHaveBeenCalledTimes(1);
      const args = mockSsh.execCapture.mock.calls[0][1] as string[];
      expect(args.slice(-2)).toEqual([
        "brendan@resolved-mbp",
        "nohup caffeinate -dimsu -t 600 >/dev/null 2>&1 & disown; echo awake",
      ]);
    });

    it("preserves an explicit runner user while resolving the LAN address", async () => {
      MAC_RUNNERS[0].user = "override";
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(22, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);

      await run();

      const args = mockSsh.execCapture.mock.calls[0][1] as string[];
      expect(args.slice(-2)[0]).toBe("override@resolved-mbp");
      delete MAC_RUNNERS[0].user;
    });

    it("does not fetch jobs or wake anything for a run younger than the grace period", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(2, 5_000)]);

      await run();

      expect(mockGh.fetchQueuedJobsForRun).not.toHaveBeenCalled();
      expect(mockSsh.execCapture).not.toHaveBeenCalled();
    });

    it("does not wake anything when the only queued job is linux", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(3, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "linux"] },
      ]);

      await run();

      expect(mockSsh.execCapture).not.toHaveBeenCalled();
    });

    it("does not wake a host twice within the cooldown window", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(4, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);

      await run();
      await run();

      expect(mockSsh.execCapture).toHaveBeenCalledTimes(1);
    });

    const macJobs = [{ name: "build", labels: ["self-hosted", "macos", "tempo"] }];
    const expectNoAlerts = () => {
      expect(mockReportError).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockGh.fetchSelfHostedRunners).not.toHaveBeenCalled();
    };

    it("only logs when the SSH wake fails for another reason (host key)", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(5, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);
      mockSsh.execCapture.mockRejectedValue(new Error("Host key verification failed"));

      await expect(run()).resolves.toBeUndefined();

      expectNoAlerts();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("failed to wake"));
    });

    it("logs one warning per failing host and still attempts every runner", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(8, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos"] },
      ]);
      mockSsh.execCapture.mockRejectedValue(new Error("Host key verification failed"));

      await run();

      expect(mockSsh.execCapture).toHaveBeenCalledTimes(2);
      expect(mockLog.warn.mock.calls.filter(c => String(c[0]).includes("failed to wake"))).toHaveLength(2);
      expectNoAlerts();
    });

    it("only logs for a host-absent SSH failure", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(16, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);
      mockSsh.execCapture.mockRejectedValue(new Error("ssh: Could not resolve hostname brendans-macbook-pro.local: Name or service not known"));

      await run();

      expectNoAlerts();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("is not answering SSH"));
    });

    it("only logs for a connect timeout", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(21, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);
      mockSsh.execCapture.mockRejectedValue(
        new Error("ssh: connect to host brendans-macbook-pro.local port 22: Connection timed out"),
      );

      await run();

      expectNoAlerts();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("is not answering SSH"));
    });

    it("only logs for an auth failure", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(19, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);
      mockSsh.execCapture.mockRejectedValue(new Error("brendan@resolved-mbp: Permission denied (publickey)"));

      await run();

      expectNoAlerts();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Permission denied (publickey)"));
    });

    describe("connection refused", () => {
      const REFUSED = "ssh: connect to host Brendans-MacBook-Pro port 22: Connection refused";
      const attempt = async (n: number) => {
        vi.setSystemTime(NOW + n * 6 * 60_000);
        await run();
      };

      it("logs a refusal warning on every attempt, well past six refusals, and never alerts", async () => {
        mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(30, 61_000)]);
        mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);
        mockSsh.execCapture.mockRejectedValue(new Error(REFUSED));

        for (let i = 0; i < 8; i++) await attempt(i);

        expectNoAlerts();
        expect(mockLog.warn.mock.calls.filter(c => String(c[0]).includes("refused SSH"))).toHaveLength(8);
      });
    });

    it("never alerts across repeated absent runs past the old ten-minute window", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(20, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);
      mockSsh.execCapture.mockRejectedValue(new Error("ssh: Could not resolve hostname brendans-macbook-pro.local: Name or service not known"));

      await run();
      vi.setSystemTime(NOW + 10 * 60_000 + 1_000);
      await run();

      expect(mockSsh.execCapture).toHaveBeenCalledTimes(2);
      expectNoAlerts();
    });

    it("does not report when the wake succeeds", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(9, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);

      await run();

      expectNoAlerts();
    });

    it("never alerts or checks the runner registry when the runner stays offline after a wake", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(11, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);
      mockGh.fetchSelfHostedRunners.mockResolvedValue([
        { name: "Brendans-MacBook-Pro", status: "offline", labels: ["self-hosted", "macos", "tempo"] },
      ]);

      await run();
      vi.setSystemTime(NOW + 10 * 60_000 + 1_000);
      await run();
      vi.setSystemTime(NOW + 30 * 60_000);
      await run();

      expectNoAlerts();
    });

    it("reports the error and continues to the next repo when fetching queued runs fails", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockRejectedValue(new Error("gh api failed"));

      await expect(run()).resolves.toBeUndefined();

      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-waker",
        "St-John-Software/bonkus",
        expect.any(Error),
        { repo: "St-John-Software/bonkus" },
      );
    });

    it("reports the error when fetching queued jobs for a run fails", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(7, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockRejectedValue(new Error("gh api failed"));

      await expect(run()).resolves.toBeUndefined();

      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-waker",
        "St-John-Software/bonkus",
        expect.any(Error),
        { repo: "St-John-Software/bonkus" },
      );
      expect(mockSsh.execCapture).not.toHaveBeenCalled();
    });

    it("skips a runner whose enabled flag is false", async () => {
      MAC_RUNNERS[0].enabled = false; // Brendans-MacBook-Pro (tempo)
      try {
        mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(10, 61_000)]);
        mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);
        await run();
        expect(mockSsh.execCapture).not.toHaveBeenCalled();
        expect(mockReportError).not.toHaveBeenCalled();
      } finally {
        MAC_RUNNERS[0].enabled = undefined;
      }
    });

    it("logs and does not alert when refusing to SSH to an unsafe host", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(6, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue(macJobs);
      MAC_RUNNERS[0].host = "-oProxyCommand=x";
      try {
        await run();

        expect(mockSsh.execCapture).not.toHaveBeenCalled();
        expectNoAlerts();
        expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("unsafe host"));
      } finally {
        MAC_RUNNERS[0].host = "brendans-macbook-pro.local";
      }
    });
  });
});
