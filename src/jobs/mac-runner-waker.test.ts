import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { MAC_RUNNERS, MAC_RUNNER_REPOS, mockGh, mockSsh, mockLog, mockReportError } = vi.hoisted(() => ({
  MAC_RUNNERS: [
    { name: "Brendans-MacBook-Pro", host: "brendans-macbook-pro.local", labels: ["macos", "tempo"], enabled: undefined as boolean | undefined },
    { name: "Brendans-MacBook-Pro-3", host: "brendans-macbook-pro-3.local", labels: ["macos", "xcode26"], enabled: undefined as boolean | undefined },
  ],
  MAC_RUNNER_REPOS: ["St-John-Software/bonkus"],
  mockGh: {
    fetchQueuedWorkflowRuns: vi.fn(),
    fetchQueuedJobsForRun: vi.fn(),
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

import { run, isMacJob, matchingRunners, _resetState } from "./mac-runner-waker.js";

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
      mockSsh.execCapture.mockRejectedValue(new Error("Connection timed out"));

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
      mockSsh.execCapture.mockRejectedValue(new Error("Connection timed out"));

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
