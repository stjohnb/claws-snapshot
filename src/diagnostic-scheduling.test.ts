import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:", DATABASE_URL: "", DATABASE_PASSWORD: "",
  getRepoJobExclusions: vi.fn(() => []),
  SMART_SCHEDULING: { enabled: true, jobs: { "doc-maintainer": {} }, targetStalenessMs: 1000, sloStalenessMs: 10000, ignoreBusyKinds: [] },
}));
vi.mock("./slack.js", () => ({ notify: vi.fn() }));
vi.mock("./github.js", () => ({ isRateLimited: () => false }));
vi.mock("./error-reporter.js", () => ({ reportError: vi.fn() }));

import * as db from "./db.js";
import * as queries from "./diagnostic-queries.js";
import { getRepoJobExclusions, SMART_SCHEDULING } from "./config.js";
import { withRunContext } from "./log.js";
import { selectReposForTick, shouldRunSmartJob } from "./smart-schedule.js";
import { mockRepo } from "./test-helpers.js";

beforeEach(async () => { await db.initDb(); SMART_SCHEDULING.enabled = true; vi.mocked(getRepoJobExclusions).mockReturnValue([]); });
afterEach(async () => { await db.closeDb(); });

it("retains scheduler decisions through both diagnostic query paths after queue state changes", async () => {
  const repo = mockRepo({ fullName: "org/repo" });
  await db.markRepoProcessedDaily("doc-maintainer", repo.fullName, "2026-09-17");
  const timestamps = await db.getLastProcessedTimestampsForJob("doc-maintainer");
  const processedAt = timestamps.get(repo.fullName)!;
  for (const id of ["disabled", "fresh", "busy", "override"]) await db.insertJobRun(id, "doc-maintainer");
  SMART_SCHEDULING.enabled = false;
  await withRunContext("disabled", async () => { expect(shouldRunSmartJob("doc-maintainer")).toBe(false); });
  SMART_SCHEDULING.enabled = true;
  await withRunContext("fresh", async () => {
    expect(await selectReposForTick("doc-maintainer", [repo], new Date(processedAt))).toEqual([]);
  });
  const work = (await db.enqueueWork("planner", repo.fullName, 1))!;
  await withRunContext("busy", async () => {
    expect(await selectReposForTick("doc-maintainer", [repo], new Date(processedAt + 2000))).toEqual([]);
  });
  await withRunContext("override", async () => {
    expect(await selectReposForTick("doc-maintainer", [repo], new Date(processedAt + 11000))).toEqual([repo]);
  });
  await db.markWorkFailed(work.id, "private failure");
  for (const id of ["disabled", "fresh", "busy", "override"]) await db.completeJobRun(id, "completed");
  const logs = await db.getMcpRecentJobLogs(); // HTTP path flushes the producer buffer.
  expect(logs.map((row) => row.diagnostic_reason?.code)).toEqual([
    "scheduling_slo_override", "scheduling_busy", "scheduling_none_due", "scheduling_disabled",
  ]);
  expect(logs[1].diagnostic_context).toEqual({ enabled: true, busy: true, targetStalenessMs: 1000, sloStalenessMs: 10000, dueCount: 1, sloBreachedCount: 0 });
  expect(await queries.getMcpRecentJobLogs(db._rawDb())).toEqual(logs); // Standalone stdio path.
  const runs = await db.getMcpRecentJobRuns();
  expect(await queries.getMcpRecentJobRuns(db._rawDb())).toEqual(runs);
  expect(runs.find((run) => run.run_id === "busy")?.diagnostics[0].diagnostic_context.busy).toBe(true);
});

it.each([
  { hostDisabled: true, repositoryDisabled: false },
  { hostDisabled: false, repositoryDisabled: true },
  { hostDisabled: true, repositoryDisabled: true },
])("records stale repository exclusions with their source: %o", async (source) => {
  const excluded = mockRepo({ fullName: "org/excluded" });
  const eligible = mockRepo({ fullName: "org/eligible" });
  const exclusion = { repo: excluded.fullName, job: "doc-maintainer", ...source };
  vi.mocked(getRepoJobExclusions).mockReturnValue([exclusion]);
  // Never-processed repos are beyond the SLO; exclusions must still win.
  await db.insertJobRun("mixed", "doc-maintainer");
  await withRunContext("mixed", async () => {
    expect(await selectReposForTick("doc-maintainer", [excluded, eligible])).toEqual([eligible]);
  });
  await db.insertJobRun("all-excluded", "doc-maintainer");
  await withRunContext("all-excluded", async () => {
    expect(await selectReposForTick("doc-maintainer", [excluded])).toEqual([]);
  });
  for (const id of ["mixed", "all-excluded"]) await db.completeJobRun(id, "completed");
  const logs = await db.getMcpRecentJobLogs();
  expect(logs.filter((row) => row.diagnostic_reason?.code === "scheduling_repo_disabled"))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: "mixed", job_name: "doc-maintainer", diagnostic_context: exclusion }),
      expect.objectContaining({ run_id: "all-excluded", job_name: "doc-maintainer", diagnostic_context: exclusion }),
    ]));
  expect(logs.some((row) => row.diagnostic_reason?.code === "scheduling_none_due")).toBe(false);
  expect(logs.find((row) => row.run_id === "all-excluded")?.diagnostic_reason?.code).toBe("scheduling_all_excluded");
  expect(await queries.getMcpRecentJobLogs(db._rawDb())).toEqual(logs);
  const runs = await db.getMcpRecentJobRuns();
  expect(await queries.getMcpRecentJobRuns(db._rawDb())).toEqual(runs);
});
