import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
}));

vi.mock("./log.js", async () => {
  const core = await vi.importActual<typeof import("./log-core.js")>("./log-core.js");
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), runContext: core.runContext, withRunContext: core.withRunContext };
});

vi.mock("./worker.js", () => ({
  workRunContextFields: (row: { kind: string; repo: string }) => ({ job: `work:${row.kind}`, repo: row.repo }),
}));

import * as db from "./db.js";
import { executeAgentPodOp } from "./agent-pod-ops.js";

const ROW = {
  id: 7, kind: "requirements-writer", repo: "org/repo", item_number: 1, args_json: "{}", priority: 0, status: "running",
  pid: null, attempts: 1, error_message: null, enqueued_at: "2026-09-24 10:00:00", started_at: "2026-09-24 10:00:00",
  completed_at: null, run_id: "run-7", agent_pod: "claws-agent-7", agent_mcp_token_sha256: "abc",
} satisfies db.WorkQueueRow;

describe("agent-pod task round trip against the real database", () => {
  beforeEach(async () => {
    await db.initDb();
  });

  afterEach(async () => {
    await db.closeDb();
  });

  it("stores a pod-started task under its run, so later task-scoped ops are accepted", async () => {
    db.stampTasksWithRunContext();
    const start = await executeAgentPodOp(ROW, "recordTaskStart", ["requirements-writer", "org/repo", 1, null]);
    expect(start.status).toBe(200);
    const id = (start as { result: number }).result;
    expect(typeof id).toBe("number");
    expect(await db.getTaskRunId(id)).toBe("run-7");

    expect(await executeAgentPodOp(ROW, "updateTaskWorktree", [id, "/tmp/wt"])).toMatchObject({ status: 200 });
    expect(await executeAgentPodOp(ROW, "recordTaskFailed", [id, "boom", { category: "error", detail: "boom" }])).toMatchObject({ status: 200 });
    const task = (await db.getRecentTasksForRepo("org/repo", 10)).find((t) => t.id === id);
    expect(task).toMatchObject({ status: "failed", error: "boom" });
  });

  it("refuses the failure report when the task was stored without a run id", async () => {
    db.setRunIdProvider(() => undefined);
    const start = await executeAgentPodOp(ROW, "recordTaskStart", ["requirements-writer", "org/repo", 1, null]);
    const id = (start as { result: number }).result;
    expect(await db.getTaskRunId(id)).toBeNull();
    expect(await executeAgentPodOp(ROW, "recordTaskFailed", [id, "boom", { category: "error", detail: "boom" }])).toMatchObject({
      status: 403,
      error: "recordTaskFailed must name a task of run run-7",
    });
  });
});
