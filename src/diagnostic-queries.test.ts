import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  DB_PATH: ":memory:", DATABASE_URL: "", DATABASE_PASSWORD: "",
}));
vi.mock("./slack.js", () => ({ notify: vi.fn() }));
vi.mock("./github.js", () => ({ isRateLimited: () => false }));
vi.mock("./error-reporter.js", () => ({ reportError: vi.fn() }));

import * as db from "./db.js";
import * as queries from "./diagnostic-queries.js";
import * as log from "./log.js";

beforeEach(async () => { await db.initDb(); });
afterEach(async () => { await db.closeDb(); });

describe("job-name filter expansion", () => {
  // The auto-merger scheduler job sweeps inline as `auto-merger`; chained queue
  // rows run as `work:auto-merger:sweep` (#clw_01M4TK4C1E6VHMC09T13HDCBHJ).
  beforeEach(async () => {
    for (const [id, name] of [["sched", "auto-merger"], ["queued", "work:auto-merger:sweep"], ["other", "doc-maintainer"]]) {
      await db.insertJobRun(id, name);
      await log.withRunContext(id, async () => {
        log.info(`[auto-merger] swept org/repo in ${id}`, "merge_sweep_done", { repo: "org/repo", openPrCount: 0, mergedCount: 0, skippedCount: 0 });
      });
      await db.completeJobRun(id, "completed");
    }
  });

  it("returns the scheduler job and the queue runs for auto-merger:sweep", async () => {
    const runs = await db.getMcpRecentJobRuns(20, "auto-merger:sweep");
    expect(runs.map((r) => r.job_name).sort()).toEqual(["auto-merger", "work:auto-merger:sweep"]);
    expect(await queries.getMcpRecentJobRuns(db._rawDb(), 20, "auto-merger:sweep")).toEqual(runs);

    const logs = await db.getMcpRecentJobLogs({ jobName: "auto-merger:sweep" });
    expect(logs.map((l) => l.job_name).sort()).toEqual(["auto-merger", "work:auto-merger:sweep"]);
    expect(logs[0].diagnostic_reason?.code).toBe("merge_sweep_done");
    expect(logs[0].diagnostic_context).toEqual({ repo: "org/repo", openPrCount: 0, mergedCount: 0, skippedCount: 0 });
  });

  it("matches a filter's work: queue runs but not other jobs", async () => {
    const runs = await db.getMcpRecentJobRuns(20, "auto-merger");
    expect(runs.map((r) => r.job_name)).toEqual(["auto-merger"]);
    const logs = await db.getMcpRecentJobLogs({ jobName: "doc-maintainer" });
    expect(logs.map((l) => l.job_name)).toEqual(["doc-maintainer"]);
  });
});

describe("diagnosticContext", () => {
  it("keeps well-formed merge fields", () => {
    expect(queries.diagnosticContext({ repo: "org/repo", pr: 43, mergeSkip: "auto-bump-gate", openPrCount: 3, mergedCount: 1, skippedCount: 2 }))
      .toEqual({ repo: "org/repo", pr: 43, mergeSkip: "auto-bump-gate", openPrCount: 3, mergedCount: 1, skippedCount: 2 });
  });

  it("drops malformed merge fields", () => {
    expect(queries.diagnosticContext({
      pr: 0, mergeSkip: "Not Approved: secret", openPrCount: -1, mergedCount: 1.5, skippedCount: "2",
    })).toEqual({});
    expect(queries.diagnosticContext({ pr: "43", mergeSkip: `a${"b".repeat(64)}` })).toEqual({});
  });

  it("projects the merge reason codes", () => {
    expect(queries.diagnosticReason("merge_skipped")?.code).toBe("merge_skipped");
    expect(queries.diagnosticReason("merge_sweep_done")?.code).toBe("merge_sweep_done");
  });
});
