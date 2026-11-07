import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  class ForgejoActionNotFoundError extends Error {
    constructor(readonly kind: "run" | "job", message: string) {
      super(message);
    }
  }
  class ForgejoJobLogEndpointUnavailableError extends Error {}
  return {
    ForgejoActionNotFoundError,
    ForgejoJobLogEndpointUnavailableError,
    getActionRunJobs: vi.fn(),
    getActionJobStepLogs: vi.fn(),
    listRepos: vi.fn(),
  };
});

vi.mock("./config.js", () => ({}));
vi.mock("./github.js", () => ({ listRepos: mocks.listRepos }));
vi.mock("./forgejo.js", () => ({
  ForgejoActionNotFoundError: mocks.ForgejoActionNotFoundError,
  ForgejoJobLogEndpointUnavailableError: mocks.ForgejoJobLogEndpointUnavailableError,
  getActionRunJobs: mocks.getActionRunJobs,
  getActionJobStepLogs: mocks.getActionJobStepLogs,
  selectFailedJobs: (jobs: Array<{ status: string }>) => {
    const failed = jobs.filter((j) => j.status === "failure");
    return failed.length > 0 ? failed : jobs.filter((j) => j.status === "cancelled");
  },
}));

import { fetchForgejoJobLogs, ForgejoJobLogsError, FORGEJO_JOB_LOG_MAX_CHARS } from "./forgejo-job-logs.js";

const REPO = "St-John-Software/TempoStatusBar";

type Step = { index: number; name: string; status: string; log: string };
type Job = { index: number; name: string; status: string };

function setRun(jobs: Job[], steps: Record<number, Step[]>, runStatus = "failure"): void {
  mocks.getActionRunJobs.mockResolvedValue({
    run: { index: 3, title: "CI", status: runStatus, htmlUrl: `https://git.example/${REPO}/actions/runs/3` },
    jobs,
  });
  mocks.getActionJobStepLogs.mockImplementation(async (_repo: string, _run: number, jobIndex: number) => {
    const job = jobs.find((j) => j.index === jobIndex);
    if (!job) throw new mocks.ForgejoActionNotFoundError("job", "action job not found");
    return { job, steps: steps[jobIndex] ?? [] };
  });
}

async function expectError(promise: Promise<unknown>, status: number, message: RegExp): Promise<void> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ForgejoJobLogsError);
  expect((err as ForgejoJobLogsError).status).toBe(status);
  expect((err as Error).message).toMatch(message);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRepos.mockResolvedValue([
    { owner: "St-John-Software", name: "TempoStatusBar", fullName: REPO, defaultBranch: "main", forge: "forgejo" },
    { owner: "St-John-Software", name: "claws", fullName: "St-John-Software/claws", defaultBranch: "main" },
  ]);
});

describe("fetchForgejoJobLogs", () => {
  it("defaults to the failed steps of the failed job, with a run header", async () => {
    setRun(
      [{ index: 0, name: "lint", status: "success" }, { index: 1, name: "build", status: "failure" }],
      {
        1: [
          { index: 0, name: "Set up job", status: "success", log: "setup noise\n" },
          { index: 1, name: "swift build", status: "failure", log: "error: no such module 'Foo'\n" },
          { index: 2, name: "Post", status: "skipped", log: "" },
        ],
      },
    );
    const { text, truncated } = await fetchForgejoJobLogs({ repo: REPO.toLowerCase(), run: 3 });
    expect(truncated).toBe(false);
    expect(text).toBe([
      `${REPO} run 3 "CI" (failure) https://git.example/${REPO}/actions/runs/3`,
      "",
      `=== job 1 "build" (failure)`,
      `--- step 1 "swift build" (failure)`,
      "error: no such module 'Foo'",
    ].join("\n"));
    expect(mocks.getActionJobStepLogs).toHaveBeenCalledTimes(1);
    expect(mocks.getActionJobStepLogs).toHaveBeenCalledWith(REPO, 3, 1);
  });

  it("returns every failed job when several failed", async () => {
    setRun(
      [{ index: 0, name: "a", status: "failure" }, { index: 1, name: "b", status: "failure" }],
      {
        0: [{ index: 0, name: "s", status: "failure", log: "fail a" }],
        1: [{ index: 0, name: "s", status: "failure", log: "fail b" }],
      },
    );
    const { text } = await fetchForgejoJobLogs({ repo: REPO, run: 3 });
    expect(text).toContain(`=== job 0 "a" (failure)\n--- step 0 "s" (failure)\nfail a`);
    expect(text).toContain(`=== job 1 "b" (failure)\n--- step 0 "s" (failure)\nfail b`);
  });

  it("falls back to cancelled jobs when none failed", async () => {
    setRun([{ index: 0, name: "a", status: "cancelled" }], { 0: [{ index: 0, name: "s", status: "cancelled", log: "killed" }] });
    const { text } = await fetchForgejoJobLogs({ repo: REPO, run: 3 });
    expect(text).toContain("killed");
  });

  it("selects a job by index or by exact name, and all_steps returns every step", async () => {
    setRun(
      [{ index: 0, name: "lint", status: "success" }, { index: 1, name: "build", status: "failure" }],
      {
        0: [{ index: 0, name: "eslint", status: "success", log: "lint ok" }],
        1: [
          { index: 0, name: "setup", status: "success", log: "setup output" },
          { index: 1, name: "compile", status: "failure", log: "compile error" },
        ],
      },
    );
    const byIndex = await fetchForgejoJobLogs({ repo: REPO, run: 3, job: 0 });
    expect(byIndex.text).toContain(`=== job 0 "lint" (success)\n--- step 0 "eslint" (success)\nlint ok`);
    expect(byIndex.text).not.toContain("compile error");

    const byName = await fetchForgejoJobLogs({ repo: REPO, run: 3, job: "build" });
    expect(byName.text).toContain("compile error");
    expect(byName.text).not.toContain("setup output");

    const all = await fetchForgejoJobLogs({ repo: REPO, run: 3, job: "build", allSteps: true });
    expect(all.text).toContain("setup output");
    expect(all.text).toContain("compile error");
  });

  it("uses every step of a failed job that has no failed step", async () => {
    setRun([{ index: 0, name: "a", status: "failure" }], { 0: [{ index: 0, name: "s", status: "success", log: "timed out" }] });
    const { text } = await fetchForgejoJobLogs({ repo: REPO, run: 3 });
    expect(text).toContain("timed out");
  });

  it("strips ANSI escapes and leaves Forgejo's *** secret masks untouched", async () => {
    setRun([{ index: 0, name: "a", status: "failure" }], {
      0: [{ index: 0, name: "s", status: "failure", log: "\x1b[31merror\x1b[0m token=*** \x1b]8;;https://x\x07link\x1b]8;;\x07" }],
    });
    const { text } = await fetchForgejoJobLogs({ repo: REPO, run: 3 });
    expect(text).not.toContain("\x1b");
    expect(text).toContain("error token=*** link");
  });

  it("caps output at the documented maximum and reports truncation", async () => {
    const big = `FIRST\n${"x".repeat(FORGEJO_JOB_LOG_MAX_CHARS * 2)}\nFINAL ERROR`;
    setRun([{ index: 0, name: "a", status: "failure" }], { 0: [{ index: 0, name: "s", status: "failure", log: big }] });
    const { text, truncated } = await fetchForgejoJobLogs({ repo: REPO, run: 3 });
    expect(truncated).toBe(true);
    expect(text).toMatch(/… \[Claws elided \d+ characters of log\] …/);
    expect(text.endsWith("FINAL ERROR")).toBe(true);
    expect(text.length).toBeLessThan(FORGEJO_JOB_LOG_MAX_CHARS + 100);
  });

  describe("step and grep (#clw_01M646SBH8GCQ592CFV4SRMVK4)", () => {
    function longJob(): void {
      setRun([{ index: 0, name: "ci", status: "failure" }], {
        0: [
          { index: 0, name: "Set up job", status: "success", log: "setup\n" },
          { index: 1, name: "Run unit tests", status: "success", log: Array.from({ length: 20 }, (_, i) => (i === 5 || i === 7 ? `ERROR at ${i}` : i === 15 ? `error late ${i}` : `line ${i}`)).join("\n") + "\n" },
          { index: 2, name: "Build", status: "failure", log: "build broke\n" },
        ],
      });
    }

    it("selects a passed step by index or by case-insensitive name substring", async () => {
      longJob();
      const byIndex = await fetchForgejoJobLogs({ repo: REPO, run: 3, step: 1 });
      expect(byIndex.text).toContain(`--- step 1 "Run unit tests" (success)\nline 0`);
      expect(byIndex.text).not.toContain("build broke");
      const byName = await fetchForgejoJobLogs({ repo: REPO, run: 3, step: "UNIT test" });
      expect(byName.text).toBe(byIndex.text);
    });

    it("answers an unknown step with a 404 listing the job's steps", async () => {
      longJob();
      await expectError(
        fetchForgejoJobLogs({ repo: REPO, run: 3, step: "deploy" }),
        404,
        /no step "deploy"; job 0 "ci" steps: 0 "Set up job" \(success\), 1 "Run unit tests" \(success\), 2 "Build" \(failure\)/,
      );
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 3, step: 9 }), 404, /no step 9;/);
    });

    it("keeps matching lines with context, merging overlapping windows and marking gaps with --", async () => {
      longJob();
      const { text } = await fetchForgejoJobLogs({ repo: REPO, run: 3, job: 0, step: 1, grep: "error", context: 2 });
      expect(text).toContain([
        `--- step 1 "Run unit tests" (success)`,
        "line 3", "line 4", "ERROR at 5", "line 6", "ERROR at 7", "line 8", "line 9",
        "--",
        "line 13", "line 14", "error late 15", "line 16", "line 17",
      ].join("\n"));
      expect(text).not.toContain("line 10");
    });

    it("prints (no matching lines) for a step with no match, and applies grep before the cap", async () => {
      longJob();
      const none = await fetchForgejoJobLogs({ repo: REPO, run: 3, allSteps: true, grep: "^build" });
      expect(none.text).toContain(`--- step 0 "Set up job" (success)\n(no matching lines)`);
      expect(none.text).toContain(`--- step 2 "Build" (failure)\nbuild broke`);

      const big = `${"x\n".repeat(FORGEJO_JOB_LOG_MAX_CHARS)}NEEDLE in the middle\n${"y\n".repeat(FORGEJO_JOB_LOG_MAX_CHARS)}`;
      setRun([{ index: 0, name: "a", status: "failure" }], { 0: [{ index: 0, name: "s", status: "failure", log: big }] });
      const found = await fetchForgejoJobLogs({ repo: REPO, run: 3, grep: "needle", context: 0 });
      expect(found.truncated).toBe(false);
      expect(found.text.endsWith("NEEDLE in the middle")).toBe(true);
    });

    it("rejects an invalid regex as a 400 before reading Forgejo", async () => {
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 3, grep: "(unclosed" }), 400, /grep is not a valid regular expression/);
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 3, grep: "(a+)+$" }), 400, /unbounded quantifier/);
      expect(mocks.getActionRunJobs).not.toHaveBeenCalled();
    });
  });

  describe("errors", () => {
    it("rejects a repo Claws does not manage", async () => {
      await expectError(fetchForgejoJobLogs({ repo: "o/unknown", run: 3 }), 404, /o\/unknown is not a repo Claws manages/);
      expect(mocks.getActionRunJobs).not.toHaveBeenCalled();
    });

    it("reports a nonexistent run", async () => {
      mocks.getActionRunJobs.mockRejectedValue(new mocks.ForgejoActionNotFoundError("run", "action run not found"));
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 99 }), 404, /has no Actions run 99/);
    });

    it("reports a nonexistent job and lists the available ones", async () => {
      setRun([{ index: 0, name: "build", status: "failure" }], {});
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 3, job: 5 }), 404, /no job 5; its jobs are: 0 "build" \(failure\)/);
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 3, job: "nope" }), 404, /no job "nope"/);
    });

    it("reports a run with no failed job and says to pass job", async () => {
      setRun([{ index: 0, name: "build", status: "success" }], {}, "success");
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 3 }), 404, /no failed job; its jobs are: 0 "build" \(success\) — pass `job`/);
    });

    it("reports selected steps with no log text", async () => {
      setRun([{ index: 0, name: "build", status: "failure" }], { 0: [{ index: 0, name: "s", status: "failure", log: "" }] });
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 3 }), 404, /have no log text — pass all_steps/);
    });

    it("surfaces a Forgejo without the job-log patch as endpoint unavailable", async () => {
      mocks.getActionRunJobs.mockRejectedValue(
        new mocks.ForgejoJobLogEndpointUnavailableError("forgejo GET /repos/x/actions/runs/3/jobs: endpoint unavailable — this Forgejo lacks the Actions job-log API patch (#clw_x)"),
      );
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 3 }), 502, /endpoint unavailable.*job-log API patch/);
    });

    it("surfaces other Forgejo errors as 502 with their text", async () => {
      mocks.getActionRunJobs.mockRejectedValue(new Error("forgejo GET /x failed: HTTP 403: forbidden"));
      await expectError(fetchForgejoJobLogs({ repo: REPO, run: 3 }), 502, /HTTP 403: forbidden/);
    });
  });
});
