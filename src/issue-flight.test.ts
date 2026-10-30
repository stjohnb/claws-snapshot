import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

const db = vi.hoisted(() => ({
  hasRunningTask: vi.fn(async (_job: string, _repo: string, _ref: unknown) => false),
  listOpenClawsPrsForIssueOrSteps: vi.fn(async (_issueId: string) => [] as any[]),
  getRunningTaskSummaries: vi.fn(async () => [] as any[]),
  listOpenClawsPrsLinkedToIssues: vi.fn(async () => [] as any[]),
}));
vi.mock("./db.js", () => db);

// A forge issue is linked to its tracker id by `resolveTrackerId`; a native
// ref is its own.
const resolveTrackerId = vi.hoisted(() => vi.fn(async (_repo: string, ref: unknown) =>
  (String(ref).startsWith("clw_") ? String(ref) : ref === 42 ? "clw_FORGE42" : null)));
vi.mock("./planned-prs.js", () => ({ resolveTrackerId }));

import { flightKey, loadBoardFlights, loadIssueFlight } from "./issue-flight.js";
import { columnFor, type BoardIssue } from "./issue-board.js";
import { LABELS } from "./config.js";

const row = (issueId: string, prNumber: number, stage = "awaiting-review") => ({ repo: "org/repo", prNumber, issueId, stage });
const owned = (r: ReturnType<typeof row>) => ({ issueId: r.issueId, row: r });

beforeEach(() => {
  vi.clearAllMocks();
  db.hasRunningTask.mockResolvedValue(false);
  db.listOpenClawsPrsForIssueOrSteps.mockResolvedValue([]);
  db.getRunningTaskSummaries.mockResolvedValue([]);
  db.listOpenClawsPrsLinkedToIssues.mockResolvedValue([]);
});

describe("loadIssueFlight", () => {
  it("reads the running implementer and the open rows by tracker id", async () => {
    db.hasRunningTask.mockResolvedValue(true);
    db.listOpenClawsPrsForIssueOrSteps.mockResolvedValue([row("clw_FORGE42", 7)]);

    const flight = await loadIssueFlight("org/repo", 42);

    expect(flight).toEqual({ implementing: true, openPrs: [row("clw_FORGE42", 7)] });
    expect(db.hasRunningTask).toHaveBeenCalledWith("issue-worker", "org/repo", 42);
    expect(db.listOpenClawsPrsForIssueOrSteps).toHaveBeenCalledWith("clw_FORGE42");
  });

  it("has no rows for an issue with no tracker id", async () => {
    expect(await loadIssueFlight("org/repo", 99)).toEqual({ implementing: false, openPrs: [] });
    expect(db.listOpenClawsPrsForIssueOrSteps).not.toHaveBeenCalled();
  });

  // Best-effort: a DB hiccup costs the flight, not the caller.
  it("reads a failure as not in flight", async () => {
    db.hasRunningTask.mockRejectedValue(new Error("db down"));
    db.listOpenClawsPrsForIssueOrSteps.mockRejectedValue(new Error("db down"));

    expect(await loadIssueFlight("org/repo", 42)).toEqual({ implementing: false, openPrs: [] });
  });
});

describe("loadBoardFlights", () => {
  it("files each card in flight under its repo and ref, and leaves the rest out", async () => {
    db.getRunningTaskSummaries.mockResolvedValue([
      { job_name: "issue-worker", repo: "org/repo", item_number: 42, started_at: "" },
      { job_name: "ci-fixer", repo: "org/repo", item_number: 43, started_at: "" },
    ]);
    db.listOpenClawsPrsLinkedToIssues.mockResolvedValue([row("clw_FORGE42", 7), row("clw_NATIVE", 8, "awaiting-merge"), row("clw_ELSEWHERE", 9)].map(owned));

    const flights = await loadBoardFlights([
      { repo: "org/repo", ref: 42 },
      { repo: "org/repo", ref: 43 },
      { repo: "org/repo", ref: "clw_NATIVE" },
    ]);

    expect([...flights.keys()]).toEqual([flightKey("org/repo", 42), flightKey("org/repo", "clw_NATIVE")]);
    expect(flights.get(flightKey("org/repo", 42))).toEqual({ implementing: true, openPrs: [row("clw_FORGE42", 7)] });
    expect(flights.get(flightKey("org/repo", "clw_NATIVE"))).toEqual({ implementing: false, openPrs: [row("clw_NATIVE", 8, "awaiting-merge")] });
  });

  it("skips the tracker-id lookups when no open row is linked to an issue", async () => {
    db.getRunningTaskSummaries.mockResolvedValue([{ job_name: "issue-worker", repo: "org/repo", item_number: 42, started_at: "" }]);

    const flights = await loadBoardFlights([{ repo: "org/repo", ref: 42 }, { repo: "org/repo", ref: 43 }]);

    expect(resolveTrackerId).not.toHaveBeenCalled();
    expect([...flights.keys()]).toEqual([flightKey("org/repo", 42)]);
  });

  it("reads a failed query as no card in flight", async () => {
    db.getRunningTaskSummaries.mockRejectedValue(new Error("db down"));
    db.listOpenClawsPrsLinkedToIssues.mockRejectedValue(new Error("db down"));

    expect((await loadBoardFlights([{ repo: "org/repo", ref: 42 }])).size).toBe(0);
  });
});

// A step committed onto another issue's PR through CLAWS_TARGET_PR
// (#clw_01M4XWHG3A2Q5Y06GN2SC7K06X): the PR is owned by issue A and linked to
// a step of issue B, so both cards show it.
describe("a shared target PR", () => {
  it("is in flight for the issue that owns it and the issue whose step it carries, once each", async () => {
    const shared = row("clw_A", 3);
    db.listOpenClawsPrsLinkedToIssues.mockResolvedValue([
      { issueId: "clw_A", row: shared },
      { issueId: "clw_A", row: shared },
      { issueId: "clw_B", row: shared },
    ]);

    const flights = await loadBoardFlights([{ repo: "org/repo", ref: "clw_A" }, { repo: "org/repo", ref: "clw_B" }]);

    expect(flights.get(flightKey("org/repo", "clw_A"))?.openPrs).toEqual([shared]);
    const b = flights.get(flightKey("org/repo", "clw_B"))!;
    expect(b.openPrs).toEqual([shared]);
    expect(columnFor({ labels: [], lifecycle: "awaiting-plan-review", ...b } as BoardIssue)).toBe("in-progress");
  });

  it("places the card in Awaiting merge when the shared PR is at that stage", async () => {
    db.listOpenClawsPrsLinkedToIssues.mockResolvedValue([{ issueId: "clw_B", row: row("clw_A", 3, "awaiting-merge") }]);

    const b = (await loadBoardFlights([{ repo: "org/repo", ref: "clw_B" }])).get(flightKey("org/repo", "clw_B"))!;

    expect(columnFor({ labels: [], lifecycle: "awaiting-plan-review", ...b } as BoardIssue)).toBe("awaiting-merge");
  });
});
