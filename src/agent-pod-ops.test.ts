import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

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

vi.mock("./db.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./db.js")>(),
  getTaskRunId: vi.fn(),
  getWorkRow: vi.fn(),
  markWorkFailed: vi.fn(),
  markWorkFailedIfRunning: vi.fn(),
  markWorkSucceededIfRunning: vi.fn(),
  completeJobRun: vi.fn(),
  recordTaskStart: vi.fn(),
  recordTaskComplete: vi.fn(),
  enqueueWork: vi.fn(),
}));

import * as db from "./db.js";
import { runContext } from "./log-core.js";
import { AGENT_POD_OPS, AGENT_POD_OP_EXCLUSIONS, AGENT_POD_OPS_GRACE_MS, agentPodTokenLive, executeAgentPodOp } from "./agent-pod-ops.js";

const ROW = {
  id: 7, kind: "pr-reviewer", repo: "org/repo", item_number: 1, args_json: "{}", priority: 0, status: "running",
  pid: null, attempts: 1, error_message: null, enqueued_at: "2026-09-24 10:00:00", started_at: "2026-09-24 10:00:00",
  completed_at: null, run_id: "run-7", agent_pod: "claws-agent-7", agent_mcp_token_sha256: "abc",
} satisfies db.WorkQueueRow;

describe("executeAgentPodOp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses an unknown op with 404", async () => {
    expect(await executeAgentPodOp(ROW, "initDb", [])).toMatchObject({ status: 404 });
    expect(await executeAgentPodOp(ROW, "__proto__", [])).toMatchObject({ status: 404 });
    expect(await executeAgentPodOp(ROW, "getOrphanedTasks", [])).toMatchObject({ status: 404 });
  });

  it("refuses args that are not an array", async () => {
    expect(await executeAgentPodOp(ROW, "getWorkRow", { 0: 7 })).toMatchObject({ status: 400 });
  });

  it("refuses a row-scoped op naming another row", async () => {
    expect(await executeAgentPodOp(ROW, "markWorkFailed", [8, "x"])).toMatchObject({ status: 403 });
    expect(await executeAgentPodOp(ROW, "getWorkRow", ["7"])).toMatchObject({ status: 403 });
    expect(db.markWorkFailedIfRunning).not.toHaveBeenCalled();
  });

  it("runs a row-scoped write guarded on the row still running under its run", async () => {
    vi.mocked(db.markWorkSucceededIfRunning).mockResolvedValueOnce(true);
    expect(await executeAgentPodOp(ROW, "markWorkSucceeded", [7])).toEqual({ status: 200, result: undefined });
    expect(db.markWorkSucceededIfRunning).toHaveBeenCalledWith(7, "run-7");
    // The launcher failed the row after the route read it: the write must not land.
    vi.mocked(db.markWorkFailedIfRunning).mockResolvedValueOnce(false);
    expect(await executeAgentPodOp(ROW, "markWorkFailed", [7, "boom"])).toMatchObject({ status: 403 });
    expect(db.markWorkFailedIfRunning).toHaveBeenCalledWith(7, "run-7", "boom");
    expect(db.markWorkFailed).not.toHaveBeenCalled();
  });

  it("refuses a row-scoped write once the row has ended, but still lets the pod read it", async () => {
    const ended = { ...ROW, status: "completed", completed_at: "2026-09-24 10:05:00" };
    expect(await executeAgentPodOp(ended, "markWorkFailed", [7, "x"])).toMatchObject({ status: 403 });
    vi.mocked(db.getWorkRow).mockResolvedValue(ended);
    expect(await executeAgentPodOp(ended, "getWorkRow", [7])).toEqual({ status: 200, result: ended });
  });

  it("refuses a run-scoped op naming another run", async () => {
    expect(await executeAgentPodOp(ROW, "completeJobRun", ["run-8", "completed"])).toMatchObject({ status: 403 });
    expect(db.completeJobRun).not.toHaveBeenCalled();
    expect(await executeAgentPodOp(ROW, "completeJobRun", ["run-7", "completed"])).toMatchObject({ status: 200 });
    expect(db.completeJobRun).toHaveBeenCalledWith("run-7", "completed");
  });

  it("refuses a task-scoped op on a task of another run", async () => {
    vi.mocked(db.getTaskRunId).mockResolvedValueOnce("run-8");
    expect(await executeAgentPodOp(ROW, "recordTaskComplete", [42])).toMatchObject({ status: 403 });
    vi.mocked(db.getTaskRunId).mockResolvedValueOnce(null);
    expect(await executeAgentPodOp(ROW, "recordTaskComplete", [42])).toMatchObject({ status: 403 });
    expect(db.recordTaskComplete).not.toHaveBeenCalled();
    vi.mocked(db.getTaskRunId).mockResolvedValueOnce("run-7");
    expect(await executeAgentPodOp(ROW, "recordTaskComplete", [42, { category: "success" }])).toMatchObject({ status: 200 });
    expect(db.recordTaskComplete).toHaveBeenCalledWith(42, { category: "success" });
  });

  it("runs a permitted op under the row's run context", async () => {
    let seen: unknown;
    vi.mocked(db.recordTaskStart).mockImplementation(async () => {
      seen = runContext.getStore();
      return 99;
    });
    expect(await executeAgentPodOp(ROW, "recordTaskStart", ["pr-reviewer", "org/repo", 1, null])).toEqual({ status: 200, result: 99 });
    expect(seen).toEqual({ runId: "run-7", job: "work:pr-reviewer", repo: "org/repo" });
  });

  it("reports an op that threw as 500 with its message", async () => {
    vi.mocked(db.enqueueWork).mockRejectedValue(new Error("constraint failed"));
    expect(await executeAgentPodOp(ROW, "enqueueWork", ["ci-fixer", "org/repo", 1])).toEqual({ status: 500, error: "constraint failed" });
  });
});

describe("agentPodTokenLive", () => {
  const now = Date.parse("2026-09-24T10:05:00Z");

  it("accepts a running row and a recently finished one", () => {
    expect(agentPodTokenLive(ROW, now)).toBe(true);
    expect(agentPodTokenLive({ ...ROW, status: "failed", completed_at: "2026-09-24 10:04:00" }, now)).toBe(true);
  });

  it("refuses a row finished longer ago than the grace period, a re-queued row, and an in-process row", () => {
    const longAgo = new Date(now - AGENT_POD_OPS_GRACE_MS - 1000).toISOString().slice(0, 19).replace("T", " ");
    expect(agentPodTokenLive({ ...ROW, status: "completed", completed_at: longAgo }, now)).toBe(false);
    expect(agentPodTokenLive({ ...ROW, status: "queued", run_id: null, agent_mcp_token_sha256: null }, now)).toBe(false);
    expect(agentPodTokenLive({ ...ROW, agent_mcp_token_sha256: null }, now)).toBe(false);
  });
});

/** Every module reachable by relative import from `roots`. */
function reachableModules(roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)\.js["']/g)) {
      queue.push(path.normalize(path.join(path.dirname(file), `${m[1]}.ts`)));
    }
  }
  return [...seen];
}

describe("agent-pod ops registry", () => {
  it("covers every db.ts function the agent-pod runtime calls (drift guard)", () => {
    const srcDir = path.dirname(new URL(import.meta.url).pathname);
    const roots = ["work-handlers.ts", "worker.ts", "agent-pod/run.ts"].map((f) => path.join(srcDir, f));
    const referenced = new Set<string>();
    for (const file of reachableModules(roots)) {
      if (/\/db(-remote)?\.ts$/.test(file)) continue;
      const src = fs.readFileSync(file, "utf8");
      const addIfDbFunction = (name: string) => {
        if (name in db && typeof (db as Record<string, unknown>)[name] === "function") referenced.add(name);
      };
      for (const imp of src.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+["']\.{1,2}\/(?:[^"']*\/)?db(?:-remote)?\.js["']/g)) {
        for (const ref of src.matchAll(new RegExp(`\\b${imp[1]}\\.(\\w+)\\b`, "g"))) addIfDbFunction(ref[1]!);
      }
      // Named imports: `import { a, b as c, type T } from "./db.js"`; `import type { … }` imports no values.
      for (const imp of src.matchAll(/import\s+(?!type\s)\{([^}]*)\}\s*from\s+["']\.{1,2}\/(?:[^"']*\/)?db(?:-remote)?\.js["']/g)) {
        for (const spec of imp[1]!.split(",")) {
          const name = spec.trim().split(/\s+as\s+/)[0]!.trim();
          if (name && !name.startsWith("type ")) addIfDbFunction(name);
        }
      }
    }
    expect(referenced.size).toBeGreaterThan(50);
    const missing = [...referenced].filter((name) => !AGENT_POD_OPS.has(name) && !AGENT_POD_OP_EXCLUSIONS.has(name));
    expect(missing).toEqual([]);
  });

  it("registers only db.ts functions, none of them excluded", () => {
    for (const [name, entry] of AGENT_POD_OPS) {
      expect(AGENT_POD_OP_EXCLUSIONS.has(name)).toBe(false);
      expect(typeof entry.fn).toBe("function");
      expect(typeof (db as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("matches db-remote.ts's overrides one for one", () => {
    const srcDir = path.dirname(new URL(import.meta.url).pathname);
    const remote = fs.readFileSync(path.join(srcDir, "db-remote.ts"), "utf8");
    const overrides = [...remote.matchAll(/^export const (\w+): typeof db\.(\w+) = remote\("(\w+)"\);$/gm)];
    for (const [, name, typed, op] of overrides) expect([typed, op]).toEqual([name, name]);
    expect(overrides.map((m) => m[1]).sort()).toEqual([...AGENT_POD_OPS.keys()].sort());
  });
});
