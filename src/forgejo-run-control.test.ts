import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRunSummary } from "./github.js";

const gh = vi.hoisted(() => ({
  getDefaultBranch: vi.fn(),
  getPR: vi.fn(),
  listActionRuns: vi.fn(),
  getActionRunByNumber: vi.fn(),
  cancelActionRunByIndex: vi.fn(),
  listRepoDirectory: vi.fn(),
  setWorkflowDisabled: vi.fn(),
  listDisabledWorkflows: vi.fn(),
}));
vi.mock("./github.js", () => gh);

const db = vi.hoisted(() => ({ recordActionsControl: vi.fn(), upsertDisabledWorkflow: vi.fn(), deleteDisabledWorkflow: vi.fn() }));
vi.mock("./db.js", () => db);

const metrics = vi.hoisted(() => ({ recordActionsControlMetric: vi.fn() }));
vi.mock("./metrics.js", () => metrics);

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("./log.js", () => log);

import { cancelRuns, setWorkflowEnabled, RunControlRequestError } from "./forgejo-run-control.js";
import { ForgejoActionNotFoundError, ForgejoRunControlEndpointUnavailableError } from "./forgejo.js";

const run = (n: number, over: Partial<ActionRunSummary> = {}): ActionRunSummary => ({
  run: n, workflow: "ci.yml", event: "push", ref: "main", status: "waiting", created: null, title: null, htmlUrl: null, ...over,
});

/** `listActionRuns` answers from `table`, keyed by `${ref ?? "*"} ${status}`. */
function runsTable(table: Record<string, ActionRunSummary[]>): void {
  gh.listActionRuns.mockImplementation(async (_repo: string, f: { status?: string; ref?: string }) =>
    table[`${f.ref ?? "*"} ${f.status}`] ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  gh.getDefaultBranch.mockResolvedValue("main");
  gh.cancelActionRunByIndex.mockImplementation(async (_repo: string, n: number) => ({ run: { index: n, status: "cancelled" }, cancelled: true }));
  db.recordActionsControl.mockResolvedValue(undefined);
});

describe("cancelRuns selection", () => {
  it("refuses an empty filter, runs combined with a filter, and an out-of-range run list", async () => {
    await expect(cancelRuns("o/r", {}, "dashboard")).rejects.toMatchObject({ status: 400 });
    await expect(cancelRuns("o/r", { includeRunning: true }, "dashboard")).rejects.toBeInstanceOf(RunControlRequestError);
    await expect(cancelRuns("o/r", { runs: [1], workflow: "ci.yml" }, "dashboard")).rejects.toMatchObject({ status: 400 });
    await expect(cancelRuns("o/r", { runs: [] }, "dashboard")).rejects.toMatchObject({ status: 400 });
    await expect(cancelRuns("o/r", { runs: Array.from({ length: 101 }, (_, i) => i + 1) }, "dashboard")).rejects.toMatchObject({ status: 400 });
    await expect(cancelRuns("o/r", { workflow: "../x" }, "dashboard")).rejects.toMatchObject({ status: 400 });
    expect(gh.listActionRuns).not.toHaveBeenCalled();
    expect(gh.cancelActionRunByIndex).not.toHaveBeenCalled();
  });

  it("matches a PR's refs/pull head and its same-repo head branch, waiting and blocked only by default", async () => {
    gh.getPR.mockResolvedValue({ number: 7, headRefName: "feat", isCrossRepository: false });
    runsTable({
      "refs/pull/7/head waiting": [run(10, { ref: "#7", event: "pull_request" })],
      "refs/heads/feat blocked": [run(11, { ref: "feat", status: "blocked" })],
      "refs/heads/feat running": [run(12, { ref: "feat", status: "running" })],
    });
    const res = await cancelRuns("o/r", { prNumbers: [7], dryRun: true }, "session:abc");
    expect(res).toEqual({ would_cancel: [
      expect.objectContaining({ run: 10, ref: "#7", pr: 7 }),
      expect.objectContaining({ run: 11, ref: "feat", pr: 7, status: "blocked" }),
    ] });
    const refs = gh.listActionRuns.mock.calls.map((c) => `${c[1].ref} ${c[1].status}`).sort();
    expect(refs).toEqual(["refs/heads/feat blocked", "refs/heads/feat waiting", "refs/pull/7/head blocked", "refs/pull/7/head waiting"]);
  });

  it("includes running runs with includeRunning", async () => {
    gh.getPR.mockResolvedValue({ number: 7, headRefName: "feat", isCrossRepository: false });
    runsTable({ "refs/heads/feat running": [run(12, { ref: "feat", status: "running" })] });
    const res = await cancelRuns("o/r", { prNumbers: [7], includeRunning: true, dryRun: true }, "dashboard");
    expect(res).toEqual({ would_cancel: [expect.objectContaining({ run: 12, status: "running" })] });
  });

  it("never lists a fork PR's branch or the default branch", async () => {
    gh.getPR.mockResolvedValueOnce({ number: 7, headRefName: "feat", isCrossRepository: true });
    gh.getPR.mockResolvedValueOnce({ number: 8, headRefName: "main", isCrossRepository: false });
    runsTable({});
    await cancelRuns("o/r", { prNumbers: [7, 8], dryRun: true }, "dashboard");
    const refs = new Set(gh.listActionRuns.mock.calls.map((c) => c[1].ref));
    expect([...refs].sort()).toEqual(["refs/pull/7/head", "refs/pull/8/head"]);
  });

  it("passes workflow server-side, matches event client-side, and re-checks an ignored ref filter", async () => {
    gh.getPR.mockResolvedValue({ number: 7, headRefName: "feat", isCrossRepository: false });
    runsTable({
      "refs/pull/7/head waiting": [
        run(10, { ref: "#7", event: "pull_request" }),
        run(11, { ref: "#7", event: "push" }),
        run(12, { ref: "other", event: "pull_request" }),
      ],
    });
    const res = await cancelRuns("o/r", { prNumbers: [7], workflow: "ci.yml", event: "pull_request", dryRun: true }, "dashboard");
    expect(res).toEqual({ would_cancel: [expect.objectContaining({ run: 10 })] });
    expect(gh.listActionRuns.mock.calls.every((c) => c[1].workflowId === "ci.yml")).toBe(true);
  });

  it("refuses a filter matching over 200 runs with the count", async () => {
    runsTable({ "* waiting": Array.from({ length: 150 }, (_, i) => run(i + 1)), "* blocked": Array.from({ length: 60 }, (_, i) => run(i + 500, { status: "blocked" })) });
    await expect(cancelRuns("o/r", { event: "push" }, "dashboard")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("210 runs") });
    expect(gh.cancelActionRunByIndex).not.toHaveBeenCalled();
  });
});

describe("cancelRuns execution", () => {
  it("buckets cancelled, already finished and failed runs and audits only the cancelled", async () => {
    runsTable({ "* waiting": [run(1), run(2), run(3), run(4)] });
    gh.cancelActionRunByIndex.mockImplementation(async (_repo: string, n: number) => {
      if (n === 2) return { run: { index: 2, status: "success" }, cancelled: false };
      if (n === 3) throw new Error("forgejo POST: 500");
      if (n === 4) throw new ForgejoActionNotFoundError("run", "action run not found");
      return { run: { index: n, status: "cancelled" }, cancelled: true };
    });
    const res = await cancelRuns("o/r", { workflow: "ci.yml" }, "session:abc");
    expect(res).toEqual({
      cancelled: [expect.objectContaining({ run: 1, status: "cancelled" })],
      already_finished: [expect.objectContaining({ run: 2, status: "success" })],
      failed: [
        expect.objectContaining({ run: 3, error: "forgejo POST: 500" }),
        expect.objectContaining({ run: 4, error: "run not found" }),
      ],
    });
    expect(db.recordActionsControl).toHaveBeenCalledTimes(1);
    expect(db.recordActionsControl).toHaveBeenCalledWith(expect.objectContaining({ repo: "o/r", actor: "session:abc", action: "cancel-run", target: "1", prNumber: null }));
    expect(log.info).toHaveBeenCalledWith("actions_run_cancelled", expect.objectContaining({ component: "actions-control", repo: "o/r", run: 1, actor: "session:abc" }));
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(metrics.recordActionsControlMetric.mock.calls).toEqual([
      ["cancel-run", "ok"], ["cancel-run", "already_finished"], ["cancel-run", "failed"], ["cancel-run", "failed"],
    ]);
  });

  it("records the PR on a PR-scoped cancel", async () => {
    gh.getPR.mockResolvedValue({ number: 7, headRefName: "feat", isCrossRepository: false });
    runsTable({ "refs/pull/7/head waiting": [run(10, { ref: "#7" })] });
    const res = await cancelRuns("o/r", { prNumbers: [7] }, "dashboard");
    expect(res).toMatchObject({ cancelled: [{ run: 10, pr: 7 }] });
    expect(db.recordActionsControl).toHaveBeenCalledWith(expect.objectContaining({ target: "10", prNumber: 7, actor: "dashboard" }));
  });

  it("a dry run cancels and records nothing", async () => {
    runsTable({ "* waiting": [run(1)] });
    expect(await cancelRuns("o/r", { event: "push", dryRun: true }, "dashboard")).toEqual({ would_cancel: [expect.objectContaining({ run: 1 })] });
    expect(gh.cancelActionRunByIndex).not.toHaveBeenCalled();
    expect(db.recordActionsControl).not.toHaveBeenCalled();
    expect(metrics.recordActionsControlMetric).not.toHaveBeenCalled();
  });

  it("explicit runs are looked up, and an unknown run is reported as failed", async () => {
    gh.getActionRunByNumber.mockImplementation(async (_repo: string, n: number) => n === 9 ? null : {
      number: n, workflowId: "release.yml", event: "push", ref: "main", status: "running",
    });
    const res = await cancelRuns("o/r", { runs: [5, 9, 5] }, "session:abc");
    expect(res).toEqual({
      cancelled: [expect.objectContaining({ run: 5, workflow: "release.yml" })],
      already_finished: [],
      failed: [expect.objectContaining({ run: 9, error: "run not found" })],
    });
    expect(gh.cancelActionRunByIndex).toHaveBeenCalledTimes(1);
  });

  it("an image without the cancel route throws endpoint unavailable", async () => {
    runsTable({ "* waiting": [run(1), run(2)] });
    gh.cancelActionRunByIndex.mockRejectedValue(new ForgejoRunControlEndpointUnavailableError("POST", "/repos/o/r/actions/runs/1/cancel"));
    const err = await cancelRuns("o/r", { event: "push" }, "dashboard").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgejoRunControlEndpointUnavailableError);
    expect((err as Error).message).toContain("#clw_01M7X2XQESHRXWHA4Z59EXWT7Y");
    expect(db.recordActionsControl).not.toHaveBeenCalled();
  });

  it("an audit write failure does not fail the cancel", async () => {
    runsTable({ "* waiting": [run(1)] });
    db.recordActionsControl.mockRejectedValue(new Error("db down"));
    expect(await cancelRuns("o/r", { event: "push" }, "dashboard")).toMatchObject({ cancelled: [{ run: 1 }] });
  });
});

describe("setWorkflowEnabled", () => {
  beforeEach(() => {
    gh.listRepoDirectory.mockResolvedValue([{ name: "ci.yml", path: ".forgejo/workflows/ci.yml", sha: "x", type: "file" }]);
    gh.setWorkflowDisabled.mockImplementation(async (_repo: string, workflow: string, disabled: boolean) => ({ workflow, disabled }));
    gh.listDisabledWorkflows.mockResolvedValue(["ci.yml"]);
  });

  it("refuses a name that is not a workflow file", async () => {
    for (const bad of ["../ci.yml", "ci", "ci.json", "a/b.yml", ""]) {
      await expect(setWorkflowEnabled("o/r", bad, false, "dashboard")).rejects.toMatchObject({ status: 400 });
    }
    expect(gh.setWorkflowDisabled).not.toHaveBeenCalled();
  });

  it("disables an existing workflow, records it and answers the disabled list", async () => {
    expect(await setWorkflowEnabled("o/r", "ci.yml", false, "session:abc")).toEqual({ workflow: "ci.yml", enabled: false, disabled_workflows: ["ci.yml"] });
    expect(gh.listRepoDirectory).toHaveBeenCalledWith("o/r", ".forgejo/workflows");
    expect(gh.setWorkflowDisabled).toHaveBeenCalledWith("o/r", "ci.yml", true);
    expect(db.recordActionsControl).toHaveBeenCalledWith({ repo: "o/r", actor: "session:abc", action: "disable-workflow", target: "ci.yml" });
    expect(log.info).toHaveBeenCalledWith("actions_workflow_disabled", { component: "actions-control", repo: "o/r", workflow: "ci.yml", actor: "session:abc" });
    expect(metrics.recordActionsControlMetric).toHaveBeenCalledWith("disable-workflow", "ok");
    expect(db.upsertDisabledWorkflow).toHaveBeenCalledWith("o/r", "ci.yml", "session:abc");
    expect(db.deleteDisabledWorkflow).not.toHaveBeenCalled();
  });

  it("refuses to disable a file missing on the default branch, but enables one", async () => {
    await expect(setWorkflowEnabled("o/r", "gone.yaml", false, "dashboard")).rejects.toMatchObject({ status: 404 });
    gh.listDisabledWorkflows.mockResolvedValue([]);
    expect(await setWorkflowEnabled("o/r", "gone.yaml", true, "dashboard")).toEqual({ workflow: "gone.yaml", enabled: true, disabled_workflows: [] });
    expect(gh.setWorkflowDisabled).toHaveBeenCalledWith("o/r", "gone.yaml", false);
    expect(log.info).toHaveBeenCalledWith("actions_workflow_enabled", expect.objectContaining({ workflow: "gone.yaml" }));
    expect(db.deleteDisabledWorkflow).toHaveBeenCalledWith("o/r", "gone.yaml");
  });

  it("an old image's error propagates, counted and logged at warn, with no audit row", async () => {
    gh.setWorkflowDisabled.mockRejectedValue(new ForgejoRunControlEndpointUnavailableError("PUT", "/x"));
    await expect(setWorkflowEnabled("o/r", "ci.yml", true, "dashboard")).rejects.toBeInstanceOf(ForgejoRunControlEndpointUnavailableError);
    expect(metrics.recordActionsControlMetric).toHaveBeenCalledWith("enable-workflow", "failed");
    expect(log.warn).toHaveBeenCalled();
    expect(db.recordActionsControl).not.toHaveBeenCalled();
    expect(db.deleteDisabledWorkflow).not.toHaveBeenCalled();
  });

  it("a failed cache write is logged and does not fail the toggle", async () => {
    db.upsertDisabledWorkflow.mockRejectedValue(new Error("db down"));
    expect(await setWorkflowEnabled("o/r", "ci.yml", false, "dashboard")).toMatchObject({ enabled: false });
    expect(log.warn).toHaveBeenCalledWith("disabled workflow cache not updated", expect.objectContaining({ workflow: "ci.yml" }), expect.any(Error));
  });
});
