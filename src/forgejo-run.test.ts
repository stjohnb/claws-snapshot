import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getActionRunByNumber: vi.fn(),
  getActionRunJobs: vi.fn(),
  listRepos: vi.fn(),
}));

vi.mock("./config.js", () => ({}));
vi.mock("./github.js", () => ({ listRepos: mocks.listRepos }));
vi.mock("./forgejo.js", () => ({
  ForgejoActionNotFoundError: class extends Error {},
  ForgejoJobLogEndpointUnavailableError: class extends Error {},
  getActionRunByNumber: mocks.getActionRunByNumber,
  getActionRunJobs: mocks.getActionRunJobs,
  getActionJobStepLogs: vi.fn(),
  selectFailedJobs: () => [],
}));

import { fetchForgejoRun } from "./forgejo-run.js";
import { ForgejoJobLogsError } from "./forgejo-job-logs.js";

const detail = {
  id: 19006,
  number: 6226,
  workflowId: "ci.yml",
  title: "CI",
  status: "cancelled",
  reportedEvent: "push",
  event: "schedule",
  ref: "main",
  headSha: "abc",
  created: "2026-11-07T00:00:00Z",
  started: null,
  stopped: null,
  htmlUrl: "https://git.example/o/r/actions/runs/6226",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRepos.mockResolvedValue([{ fullName: "o/r" }]);
});

describe("fetchForgejoRun", () => {
  it("returns the true trigger and raw event, with null zero dates", async () => {
    mocks.getActionRunByNumber.mockResolvedValue(detail);
    mocks.getActionRunJobs.mockResolvedValue({ run: {}, jobs: [{ index: 0, name: "build", status: "cancelled" }] });
    const res = await fetchForgejoRun({ repo: "o/r", run: 6226 });
    expect(res).toMatchObject({ run: 6226, id: 19006, event: "schedule", reported_event: "push", started: null, stopped: null });
    expect(res.jobs).toEqual([{ index: 0, name: "build", status: "cancelled" }]);
  });

  it("404s a missing run", async () => {
    mocks.getActionRunByNumber.mockResolvedValue(null);
    const err = await fetchForgejoRun({ repo: "o/r", run: 99999 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ForgejoJobLogsError);
    expect((err as ForgejoJobLogsError).status).toBe(404);
  });

  it("keeps the run when the jobs read fails", async () => {
    mocks.getActionRunByNumber.mockResolvedValue(detail);
    mocks.getActionRunJobs.mockRejectedValue(new Error("boom"));
    const res = await fetchForgejoRun({ repo: "o/r", run: 6226 });
    expect(res.jobs).toBeNull();
    expect(res.jobs_error).toBe("boom");
  });
});
