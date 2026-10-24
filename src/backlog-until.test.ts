import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./config.js", () => ({
  LABELS: { ready: "Ready", backlog: "Backlog" },
  isAgentDisabled: vi.fn(() => false),
  issueUrl: (_repo: string, ref: string) => `https://claws.example.invalid/issues/${ref}`,
}));

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("./db.js", () => ({ listDueBacklogIssues: vi.fn(), skipQueuedWorkForItem: vi.fn().mockResolvedValue(1) }));

vi.mock("./error-reporter.js", () => ({ reportError: vi.fn().mockResolvedValue(undefined) }));

vi.mock("./github.js", () => ({
  getIssueComments: vi.fn(),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  hasPriorityLabel: vi.fn((labels: { name: string }[]) => labels.some((l) => l.name === "Priority")),
}));

vi.mock("./slack.js", () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

vi.mock("./claws-issues.js", () => ({
  entryLifecycle: (issue: { requirements_approved_at: string | null }, hasPlan: boolean) =>
    hasPlan || issue.requirements_approved_at != null ? "planning" : "ideas",
  setLifecycle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./worker.js", () => ({
  enqueue: vi.fn().mockResolvedValue(null),
  AGENT_KINDS: { ISSUE_REFINER_VERIFY: "issue-refiner:verify" },
}));

vi.mock("./plan-parser.js", () => ({
  findPlanComment: (comments: { body: string }[]) => comments.find((c) => c.body.includes("## Implementation Plan"))?.body ?? null,
}));

vi.mock("./issue-handback.js", () => ({ returnToPlanReview: vi.fn().mockResolvedValue(undefined) }));

import * as db from "./db.js";
import * as gh from "./github.js";
import * as slack from "./slack.js";
import * as clawsIssues from "./claws-issues.js";
import * as worker from "./worker.js";
import { isAgentDisabled } from "./config.js";
import { returnToPlanReview } from "./issue-handback.js";
import { reportError } from "./error-reporter.js";
import { announceBacklogReturn, isBacklogUntilDue, parseBacklogUntil, releaseDueBacklogIssues, utcDay } from "./backlog-until.js";

const REPO = "org/a";
const NOW = new Date("2026-10-23T09:30:00Z");
const PLAN = { body: "*— Automated by Claws · Planner —*\n\n## Implementation Plan\n\nDo it." };

function due(id: string, opts: { approved?: boolean; labels?: string[] } = {}): db.ClawsIssueRecord {
  return {
    id,
    title: `Issue ${id}`,
    requirements_approved_at: opts.approved ? "2026-10-01 00:00:00" : null,
    labels: opts.labels ?? [],
    repos: [REPO],
    backlog_until: "2026-10-23",
  } as unknown as db.ClawsIssueRecord;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAgentDisabled).mockReturnValue(false);
});

describe("parseBacklogUntil", () => {
  it("clears on null, undefined or an empty string", () => {
    expect(parseBacklogUntil(null, NOW)).toEqual({ ok: true, until: null });
    expect(parseBacklogUntil(undefined, NOW)).toEqual({ ok: true, until: null });
    expect(parseBacklogUntil("  ", NOW)).toEqual({ ok: true, until: null });
  });

  it("accepts today and later days", () => {
    expect(parseBacklogUntil("2026-10-23", NOW)).toEqual({ ok: true, until: "2026-10-23" });
    expect(parseBacklogUntil(" 2027-01-01 ", NOW)).toEqual({ ok: true, until: "2027-01-01" });
  });

  it("rejects past days, malformed values and impossible dates", () => {
    expect(parseBacklogUntil("2026-10-22", NOW)).toMatchObject({ ok: false, error: expect.stringContaining("in the past") });
    expect(parseBacklogUntil("23/10/2026", NOW)).toMatchObject({ ok: false });
    expect(parseBacklogUntil("2027-02-30", NOW)).toMatchObject({ ok: false, error: expect.stringContaining("not a calendar date") });
    expect(parseBacklogUntil(20261023, NOW)).toMatchObject({ ok: false });
  });
});

describe("isBacklogUntilDue", () => {
  it("is due from the start of the UTC day on", () => {
    expect(utcDay(NOW)).toBe("2026-10-23");
    expect(isBacklogUntilDue("2026-10-23", NOW)).toBe(true);
    expect(isBacklogUntilDue("2026-10-22", NOW)).toBe(true);
    expect(isBacklogUntilDue("2026-10-24", NOW)).toBe(false);
  });
});

describe("announceBacklogReturn", () => {
  it("posts one comment and one Slack line naming the verdict", async () => {
    await announceBacklogReturn(REPO, "clw_A", "Right-size Plausible", { kind: "kept", reason: "Phases 1-5 merged; step 6 still valid." });
    expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
    const body = vi.mocked(gh.commentOnIssue).mock.calls[0][2];
    expect(body).toContain("Back from the Backlog");
    expect(body).toContain("kept unchanged — Phases 1-5 merged; step 6 still valid.");
    expect(slack.notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(slack.notify).mock.calls[0][0]).toContain("https://claws.example.invalid/issues/clw_A");
  });

  it("names the earlier version of a revised plan", async () => {
    await announceBacklogReturn(REPO, "clw_A", "T", { kind: "revised", previousVersion: 2 });
    expect(vi.mocked(gh.commentOnIssue).mock.calls[0][2]).toContain("revised — the earlier version 2 is under Previous plans");
  });

  it("says a fresh plan was written when the plan could not be found, not that it had none", async () => {
    await announceBacklogReturn(REPO, "clw_A", "T", { kind: "replanned" });
    const body = vi.mocked(gh.commentOnIssue).mock.calls[0][2];
    expect(body).toContain("Its plan could not be found, so a fresh plan was written.");
    expect(body).not.toContain("had no plan");
  });
});

describe("releaseDueBacklogIssues", () => {
  it("queries with today's UTC day and does nothing when none is due", async () => {
    vi.mocked(db.listDueBacklogIssues).mockResolvedValue([]);
    expect(await releaseDueBacklogIssues(REPO, NOW)).toEqual([]);
    expect(db.listDueBacklogIssues).toHaveBeenCalledWith(REPO, "2026-10-23");
    expect(clawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  it("moves an issue with a plan to Planning and queues the verify run, announcing nothing yet", async () => {
    vi.mocked(db.listDueBacklogIssues).mockResolvedValue([due("clw_A", { approved: true, labels: ["Priority"] })]);
    vi.mocked(gh.getIssueComments).mockResolvedValue([PLAN] as never);
    expect(await releaseDueBacklogIssues(REPO, NOW)).toEqual(["clw_A"]);
    expect(clawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, "clw_A", "planning");
    expect(worker.enqueue).toHaveBeenCalledWith("issue-refiner:verify", REPO, "clw_A", { priority: true });
    expect(gh.commentOnIssue).not.toHaveBeenCalled();
    expect(slack.notify).not.toHaveBeenCalled();
  });

  it("announces an issue with no plan itself and leaves it to the normal pipeline", async () => {
    vi.mocked(db.listDueBacklogIssues).mockResolvedValue([due("clw_B", { approved: true }), due("clw_C")]);
    vi.mocked(gh.getIssueComments).mockResolvedValue([]);
    expect(await releaseDueBacklogIssues(REPO, NOW)).toEqual(["clw_B", "clw_C"]);
    expect(clawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, "clw_B", "planning");
    expect(clawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, "clw_C", "ideas");
    expect(worker.enqueue).not.toHaveBeenCalled();
    expect(gh.commentOnIssue).toHaveBeenCalledTimes(2);
    expect(vi.mocked(gh.commentOnIssue).mock.calls[0][2]).toContain("It had no plan, so it is back in Planning");
    expect(slack.notify).toHaveBeenCalledTimes(2);
  });

  it("returns a planned issue to plan review unverified when the planner is disabled", async () => {
    vi.mocked(isAgentDisabled).mockReturnValue(true);
    vi.mocked(db.listDueBacklogIssues).mockResolvedValue([due("clw_A", { approved: true })]);
    vi.mocked(gh.getIssueComments).mockResolvedValue([PLAN] as never);
    await releaseDueBacklogIssues(REPO, NOW);
    expect(worker.enqueue).not.toHaveBeenCalled();
    expect(returnToPlanReview).toHaveBeenCalledWith(REPO, "clw_A");
    expect(vi.mocked(gh.commentOnIssue).mock.calls[0][2]).toContain("could not be verified (the planner is disabled)");
    expect(slack.notify).toHaveBeenCalledTimes(1);
  });

  it("reports one issue's failure and carries on with the rest", async () => {
    vi.mocked(db.listDueBacklogIssues).mockResolvedValue([due("clw_A"), due("clw_B")]);
    vi.mocked(gh.getIssueComments).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([PLAN] as never);
    expect(await releaseDueBacklogIssues(REPO, NOW)).toEqual(["clw_B"]);
    expect(reportError).toHaveBeenCalledWith("issue-dispatcher:release-backlog", `${REPO} clw_A`, expect.any(Error), { repo: REPO });
  });

  it("leaves the issue parked when queueing the verify run fails", async () => {
    vi.mocked(db.listDueBacklogIssues).mockResolvedValue([due("clw_A", { approved: true })]);
    vi.mocked(gh.getIssueComments).mockResolvedValue([PLAN] as never);
    vi.mocked(worker.enqueue).mockRejectedValueOnce(new Error("db busy"));
    expect(await releaseDueBacklogIssues(REPO, NOW)).toEqual([]);
    expect(clawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("withdraws the queued verify run when the lifecycle write fails", async () => {
    vi.mocked(db.listDueBacklogIssues).mockResolvedValue([due("clw_A", { approved: true })]);
    vi.mocked(gh.getIssueComments).mockResolvedValue([PLAN] as never);
    vi.mocked(clawsIssues.setLifecycle).mockRejectedValueOnce(new Error("write failed"));
    expect(await releaseDueBacklogIssues(REPO, NOW)).toEqual([]);
    expect(worker.enqueue).toHaveBeenCalledTimes(1);
    expect(db.skipQueuedWorkForItem).toHaveBeenCalledWith("issue-refiner:verify", REPO, "clw_A", expect.any(String));
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
