import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { MAC_RUNNERS, MAC_RUNNER_REPOS, mockGh, mockSsh, mockLog, mockReportError, mockNotify } = vi.hoisted(() => ({
  MAC_RUNNERS: [
    { name: "Brendans-MacBook-Pro", host: "brendans-macbook-pro.local", labels: ["macos", "tempo"], enabled: undefined as boolean | undefined },
    { name: "Brendans-MacBook-Pro-3", host: "brendans-macbook-pro-3.local", labels: ["macos", "xcode26"], enabled: undefined as boolean | undefined },
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
}));

vi.mock("../config.js", () => ({
  MAC_RUNNERS,
  MAC_RUNNER_REPOS,
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../ssh.js", () => mockSsh);
vi.mock("../log.js", () => mockLog);
vi.mock("../error-reporter.js", () => ({ reportError: mockReportError }));
vi.mock("../retry.js", () => ({ retryWithBackoff: (fn: () => Promise<unknown>) => fn() }));
vi.mock("../slack.js", () => ({ notify: mockNotify }));

import { run, isMacJob, matchingRunners, isHostAbsent, _resetState } from "./mac-runner-waker.js";

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

    it("is false for genuinely alert-worthy failures", () => {
      expect(isHostAbsent(new Error("ssh: Permission denied (publickey,password,keyboard-interactive)"))).toBe(false);
      expect(isHostAbsent(new Error("Host key verification failed"))).toBe(false);
      expect(isHostAbsent(new Error("Connection refused"))).toBe(false);
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
        "brendans-macbook-pro.local",
        "nohup caffeinate -dimsu -t 600 >/dev/null 2>&1 & disown; echo awake",
      ]);
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

    it("reports an alert with a per-host fingerprint when the SSH wake fails", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(5, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockSsh.execCapture.mockRejectedValue(new Error("ssh: connect to host brendans-macbook-pro.local port 22: Connection refused"));

      await expect(run()).resolves.toBeUndefined();

      expect(mockReportError).toHaveBeenCalledTimes(1);
      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-waker-ssh:brendans-macbook-pro.local",
        expect.stringContaining("Brendans-MacBook-Pro"),
        expect.any(Error),
      );
    });

    it("reports one alert per failing host and still attempts every runner", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(8, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos"] },
      ]);
      mockSsh.execCapture.mockRejectedValue(new Error("ssh: connect to host x port 22: Connection refused"));

      await run();

      expect(mockSsh.execCapture).toHaveBeenCalledTimes(2);
      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-waker-ssh:brendans-macbook-pro.local",
        expect.any(String),
        expect.any(Error),
      );
      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-waker-ssh:brendans-macbook-pro-3.local",
        expect.any(String),
        expect.any(Error),
      );
    });

    it("does not open an alert issue for a host-absent SSH failure, and notifies Slack once", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(16, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockSsh.execCapture.mockRejectedValue(new Error("ssh: Could not resolve hostname brendans-macbook-pro.local: Name or service not known"));

      await run();

      expect(mockReportError).not.toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("is not answering SSH"));
    });

    it("sends only one Slack notice per absence episode", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(17, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockSsh.execCapture.mockRejectedValue(new Error("ssh: Could not resolve hostname brendans-macbook-pro.local: Name or service not known"));

      await run();
      vi.setSystemTime(NOW + 6 * 60_000);
      await run();

      expect(mockSsh.execCapture).toHaveBeenCalledTimes(2);
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockReportError).not.toHaveBeenCalled();
    });

    it("resets the absence streak after a successful wake", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(18, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);

      mockSsh.execCapture.mockRejectedValue(new Error("ssh: Could not resolve hostname brendans-macbook-pro.local: Name or service not known"));
      await run();

      mockSsh.execCapture.mockResolvedValue("awake\n");
      vi.setSystemTime(NOW + 6 * 60_000);
      await run();

      mockSsh.execCapture.mockRejectedValue(new Error("ssh: Could not resolve hostname brendans-macbook-pro.local: Name or service not known"));
      vi.setSystemTime(NOW + 12 * 60_000);
      await run();

      expect(mockNotify).toHaveBeenCalledTimes(2);
    });

    it("does not fall through to the offline-registry alert once a host-absent streak crosses the online-grace window", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(20, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockGh.fetchSelfHostedRunners.mockResolvedValue([]);
      mockSsh.execCapture.mockRejectedValue(new Error("ssh: Could not resolve hostname brendans-macbook-pro.local: Name or service not known"));

      await run(); // host-absent wake failure — suppressed, starts the streak

      vi.setSystemTime(NOW + 3 * 60_000 + 1_000); // past RUNNER_ONLINE_GRACE_MS, still inside WAKE_COOLDOWN_MS
      await run();

      expect(mockReportError).not.toHaveBeenCalled();
      expect(mockGh.fetchSelfHostedRunners).not.toHaveBeenCalled();
    });

    it("still reports an alert for an auth failure", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(19, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockSsh.execCapture.mockRejectedValue(new Error("ssh: Permission denied (publickey)"));

      await run();

      expect(mockReportError).toHaveBeenCalledTimes(1);
      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-waker-ssh:brendans-macbook-pro.local",
        expect.stringContaining("Brendans-MacBook-Pro"),
        expect.any(Error),
      );
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it("does not open an alert issue for a connect timeout — the Mac is asleep, not misconfigured", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(21, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockSsh.execCapture.mockRejectedValue(
        new Error("ssh: connect to host brendans-macbook-pro.local port 22: Connection timed out"),
      );

      await run();

      expect(mockReportError).not.toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    it("does not report when the wake succeeds", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(9, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);

      await run();

      expect(mockReportError).not.toHaveBeenCalled();
    });

    it("reports the error and continues to the next repo when fetching queued runs fails", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockRejectedValue(new Error("gh api failed"));

      await expect(run()).resolves.toBeUndefined();

      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-waker",
        "St-John-Software/bonkus",
        expect.any(Error),
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
      );
      expect(mockSsh.execCapture).not.toHaveBeenCalled();
    });

    it("skips a runner whose enabled flag is false", async () => {
      MAC_RUNNERS[0].enabled = false; // Brendans-MacBook-Pro (tempo)
      try {
        mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(10, 61_000)]);
        mockGh.fetchQueuedJobsForRun.mockResolvedValue([
          { name: "build", labels: ["self-hosted", "macos", "tempo"] },
        ]);
        await run();
        expect(mockSsh.execCapture).not.toHaveBeenCalled();
        expect(mockReportError).not.toHaveBeenCalled();
      } finally {
        MAC_RUNNERS[0].enabled = undefined;
      }
    });

    it("alerts when the runner is still offline after the online grace window", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(11, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockGh.fetchSelfHostedRunners.mockResolvedValue([
        { name: "Brendans-MacBook-Pro", status: "offline", labels: ["self-hosted", "macOS", "macos", "tempo"] },
      ]);

      await run(); // wakes the host
      expect(mockReportError).not.toHaveBeenCalled();

      vi.setSystemTime(NOW + 3 * 60_000 + 1_000); // past grace, inside cooldown
      await run();

      expect(mockSsh.execCapture).toHaveBeenCalledTimes(1); // no second wake
      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-offline:brendans-macbook-pro.local",
        expect.stringContaining("still offline"),
        expect.any(Error),
      );
    });

    it("alerts when no runner with the labels is registered at all", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(12, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockGh.fetchSelfHostedRunners.mockResolvedValue([]);

      await run();
      vi.setSystemTime(NOW + 3 * 60_000 + 1_000);
      await run();

      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-offline:brendans-macbook-pro.local",
        expect.stringContaining("registered"),
        expect.any(Error),
      );
    });

    it("does not alert when a matching runner is online", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(13, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockGh.fetchSelfHostedRunners.mockResolvedValue([
        { name: "Brendans-MacBook-Pro", status: "online", labels: ["self-hosted", "macos", "tempo"] },
      ]);

      await run();
      vi.setSystemTime(NOW + 3 * 60_000 + 1_000);
      await run();

      expect(mockReportError).not.toHaveBeenCalled();
    });

    it("skips the check without alerting when the registry is not visible (403)", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(15, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      mockGh.fetchSelfHostedRunners.mockResolvedValue(null);

      await run();
      vi.setSystemTime(NOW + 3 * 60_000 + 1_000);
      await run();

      expect(mockGh.fetchSelfHostedRunners).toHaveBeenCalledTimes(1);
      expect(mockReportError).not.toHaveBeenCalled();
    });

    it("does not check runner status before the grace window elapses", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(14, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);

      await run();
      vi.setSystemTime(NOW + 2 * 60_000); // inside grace window
      await run();

      expect(mockGh.fetchSelfHostedRunners).not.toHaveBeenCalled();
      expect(mockReportError).not.toHaveBeenCalled();
    });

    it("refuses to SSH to an unsafe host", async () => {
      mockGh.fetchQueuedWorkflowRuns.mockResolvedValue([queuedRun(6, 61_000)]);
      mockGh.fetchQueuedJobsForRun.mockResolvedValue([
        { name: "build", labels: ["self-hosted", "macos", "tempo"] },
      ]);
      MAC_RUNNERS[0].host = "-oProxyCommand=x";

      await run();

      expect(mockSsh.execCapture).not.toHaveBeenCalled();
      expect(mockReportError).toHaveBeenCalledWith(
        "mac-runner-waker-ssh:-oProxyCommand=x",
        expect.any(String),
        expect.any(Error),
      );
      MAC_RUNNERS[0].host = "brendans-macbook-pro.local";
    });
  });
});
