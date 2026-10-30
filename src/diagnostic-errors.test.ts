import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  DB_PATH: ":memory:", DATABASE_URL: "", DATABASE_PASSWORD: "",
}));
vi.mock("./slack.js", () => ({ notify: vi.fn() }));
vi.mock("./github.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./github.js")>(),
  listPRs: vi.fn(),
  isRateLimited: () => false,
}));
vi.mock("./claude.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./claude.js")>(),
  repoDir: () => process.cwd(),
}));
vi.mock("./occurrence-tracking.js", () => ({ ensureAlertIssue: vi.fn() }));

import * as db from "./db.js";
import * as queries from "./diagnostic-queries.js";
import { listPRs, RateLimitError } from "./github.js";
import { withRunContext } from "./log.js";
import { processRepo } from "./jobs/doc-maintainer.js";
import { reportError, __resetCooldownsForTests } from "./error-reporter.js";
import { mockRepo } from "./test-helpers.js";

beforeEach(async () => { await db.initDb(); __resetCooldownsForTests(); });
afterEach(async () => { await db.closeDb(); vi.restoreAllMocks(); });

it("retains two repositories failing before task creation in one run through both diagnostic projections", async () => {
  const failures = [
    { repo: "org/first", code: "rate_limited", error: new RateLimitError("private rate-limit details") },
    { repo: "org/second", code: "operation_failed", error: new Error("private operation details") },
  ];
  vi.mocked(listPRs).mockImplementation(async (repo) => {
    throw failures.find((failure) => failure.repo === repo)!.error;
  });
  const recordTask = vi.spyOn(db, "withTaskRecording");
  await db.insertJobRun("failures", "doc-maintainer");
  await withRunContext("failures", async () => {
    expect(await Promise.all(failures.map(({ repo }) => processRepo(mockRepo({ fullName: repo }))))).toEqual(
      failures.map(({ repo }) => ({ repo, status: "error" })),
    );
  });
  expect(recordTask).not.toHaveBeenCalled();
  await db.completeJobRun("failures", "completed");
  const logs = await db.getMcpRecentJobLogs();
  const runs = await db.getMcpRecentJobRuns();
  expect(await queries.getMcpRecentJobLogs(db._rawDb())).toEqual(logs);
  expect(await queries.getMcpRecentJobRuns(db._rawDb())).toEqual(runs);
  for (const { repo, code } of failures) {
    const event = { diagnostic_reason: expect.objectContaining({ code }), diagnostic_context: { repo } };
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining(event)]));
    expect(runs[0].diagnostics).toEqual(expect.arrayContaining([expect.objectContaining(event)]));
  }
  for (const { error } of failures) expect(JSON.stringify({ logs, runs })).not.toContain(error.message);
});

it("validates explicit identities and never derives them from private error context", async () => {
  await db.insertJobRun("validation", "doc-maintainer");
  await withRunContext("validation", async () => {
    await reportError("test", "org/private-context", new RateLimitError("private payload"), { repo: "org/repo", taskId: 42 });
    await reportError("test", "org/private-context", new RateLimitError("private payload"), { repo: "secret with spaces", taskId: -1 });
    await reportError("test", "org/private-context", new RateLimitError("private payload"));
  });
  const events = (await db.getMcpRecentJobLogs()).filter((row) => row.diagnostic_reason);
  expect(events.map((row) => row.diagnostic_context)).toEqual([{}, {}, { repo: "org/repo", taskId: 42 }]);
});
