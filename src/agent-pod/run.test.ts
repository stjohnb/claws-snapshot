import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const db = vi.hoisted(() => {
  class AgentPodOpUnauthorizedError extends Error {}
  return {
    AgentPodOpUnauthorizedError,
    configureRemoteDb: vi.fn(),
    initDb: vi.fn(),
    closeDb: vi.fn(),
    getWorkRow: vi.fn(),
    completeJobRun: vi.fn(),
  };
});
const worker = vi.hoisted(() => ({ runRow: vi.fn() }));
const importedRefs = vi.hoisted(() => ({ loadImportedRefs: vi.fn() }));
const plannerListener = vi.hoisted(() => ({
  close: vi.fn(),
  startPlannerRunListener: vi.fn(),
}));

vi.mock("../db-remote.js", () => db);
vi.mock("../db.js", () => { throw new Error("the agent pod runtime must use db-remote.js"); });
vi.mock("../config.js", () => ({ WORK_DIR: "/home/claws/.claws", SESSION_POD_SETTINGS: { mcpUrl: "http://claws.default.svc:3000" } }));
vi.mock("../internal-mcp-token.js", () => ({
  internalMcpTokenPath: (dir: string) => `${dir}/internal-mcp-token`,
  readMcpTokenFile: (file: string) => `token-from:${file}`,
}));
vi.mock("../worker.js", () => worker);
vi.mock("../imported-refs.js", () => importedRefs);
vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  runContext: { getStore: () => undefined },
}));
vi.mock("../shutdown.js", () => ({ setShuttingDown: vi.fn() }));
vi.mock("../claude.js", () => ({ cancelCurrentTask: vi.fn(), retuneAgentMemoryGate: vi.fn() }));
vi.mock("../work-handlers.js", () => ({ registerAll: vi.fn() }));
vi.mock("../planner-run-listener.js", () => ({ startPlannerRunListener: plannerListener.startPlannerRunListener }));

import { jobRunStatusFor, runWorkRow } from "./run.js";
import { setShuttingDown } from "../shutdown.js";
import { cancelCurrentTask } from "../claude.js";

const ROW = { id: 7, status: "running", run_id: "run-7", kind: "pr-reviewer", repo: "org/repo", item_number: 1 };

describe("agent pod runWorkRow", () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    importedRefs.loadImportedRefs.mockResolvedValue(undefined);
    plannerListener.close.mockResolvedValue(undefined);
    plannerListener.startPlannerRunListener.mockResolvedValue({ baseUrl: "http://127.0.0.1:41234", close: plannerListener.close });
    delete process.env["CLAWS_PLANNER_RUN_BASE_URL"];
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exit.mockRestore();
    delete process.env["CLAWS_PLANNER_RUN_BASE_URL"];
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("maps a finished row's status to its job run status, and a running row to none", () => {
    expect(jobRunStatusFor("completed")).toBe("completed");
    expect(jobRunStatusFor("failed")).toBe("failed");
    expect(jobRunStatusFor("cancelled")).toBe("cancelled");
    expect(jobRunStatusFor("running")).toBeNull();
    expect(jobRunStatusFor("queued")).toBeNull();
  });

  it("points db-remote at the service's ops API with the row's token instead of opening a database", async () => {
    db.getWorkRow.mockResolvedValue(ROW);
    await runWorkRow(7, "run-7");
    expect(db.initDb).not.toHaveBeenCalled();
    expect(db.configureRemoteDb).toHaveBeenCalledWith({
      baseUrl: "http://claws.default.svc:3000",
      token: "token-from:/home/claws/.claws/internal-mcp-token",
      rowId: 7,
      runId: "run-7",
    });
  });

  it("serves the planner-run routes on loopback with the row's token before running the row, and closes them on exit (#clw_01M3A42ZTGECAB11S0BZA6NG1A)", async () => {
    db.getWorkRow.mockResolvedValue(ROW);
    let urlDuringRow: string | undefined;
    worker.runRow.mockImplementationOnce(async () => {
      urlDuringRow = process.env["CLAWS_PLANNER_RUN_BASE_URL"];
    });
    await runWorkRow(7, "run-7");
    expect(plannerListener.startPlannerRunListener).toHaveBeenCalledWith({ token: "token-from:/home/claws/.claws/internal-mcp-token" });
    expect(urlDuringRow).toBe("http://127.0.0.1:41234");
    expect(plannerListener.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("fails the row without running it when the listener cannot start", async () => {
    db.getWorkRow.mockResolvedValue(ROW);
    plannerListener.startPlannerRunListener.mockRejectedValueOnce(new Error("planner-run listener needs the pod's MCP token"));
    await runWorkRow(7, "run-7");
    expect(worker.runRow).not.toHaveBeenCalled();
    expect(db.closeDb).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 0 without running the row when the service refuses the pod's token", async () => {
    db.getWorkRow.mockRejectedValueOnce(new db.AgentPodOpUnauthorizedError("getWorkRow"));
    await runWorkRow(7, "run-7");
    expect(importedRefs.loadImportedRefs).not.toHaveBeenCalled();
    expect(worker.runRow).not.toHaveBeenCalled();
    expect(db.closeDb).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each(["completed", "failed", "cancelled"])("completes the service-opened job run when the row ends %s", async (status) => {
    db.getWorkRow.mockResolvedValueOnce(ROW).mockResolvedValueOnce({ ...ROW, status });
    await runWorkRow(7, "run-7");
    expect(worker.runRow).toHaveBeenCalledWith(0, ROW);
    expect(db.completeJobRun).toHaveBeenCalledWith("run-7", status);
    expect(db.closeDb).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("leaves the job run alone when the row is still running (interrupted by shutdown)", async () => {
    db.getWorkRow.mockResolvedValue(ROW);
    await runWorkRow(7, "run-7");
    expect(db.completeJobRun).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not run a row claimed under another run", async () => {
    db.getWorkRow.mockResolvedValue({ ...ROW, run_id: "run-other" });
    await runWorkRow(7, "run-7");
    expect(worker.runRow).not.toHaveBeenCalled();
    expect(plannerListener.startPlannerRunListener).not.toHaveBeenCalled();
    expect(db.completeJobRun).not.toHaveBeenCalled();
    expect(db.closeDb).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("cancels the agent and leaves the row running on SIGTERM", async () => {
    db.getWorkRow.mockResolvedValue(ROW);
    worker.runRow.mockImplementationOnce(async () => {
      process.emit("SIGTERM");
    });
    await runWorkRow(7, "run-7");
    expect(setShuttingDown).toHaveBeenCalledOnce();
    expect(cancelCurrentTask).toHaveBeenCalledOnce();
    expect(db.completeJobRun).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("flushes job logs before exiting on a boot failure", async () => {
    db.getWorkRow.mockResolvedValue(ROW);
    importedRefs.loadImportedRefs.mockRejectedValue(new Error("boom"));
    await runWorkRow(7, "run-7");
    expect(worker.runRow).not.toHaveBeenCalled();
    expect(db.closeDb).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
