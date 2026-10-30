import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("./claws-issues.js", () => ({
  getLatestRequirementsForOpenIssues: vi.fn(async () => new Map()),
  getRequirementsFeedbackPending: vi.fn(async () => new Set<string>()),
  primaryRepo: (issue: { repos: readonly string[] }) => [...issue.repos].sort()[0] ?? "",
}));

vi.mock("./db.js", () => ({
  listPendingReapprovalIssueIds: vi.fn(async () => new Set<string>()),
}));

vi.mock("./issue-flight.js", () => ({
  flightKey: (repo: string, ref: string) => `${repo}\u0000${ref}`,
  loadBoardFlights: vi.fn(async () => new Map()),
  loadIssueFlight: vi.fn(async () => undefined),
}));

vi.mock("./awaiting-operator.js", () => ({
  issuesAwaitingOperator: vi.fn(async () => new Map()),
}));

import * as clawsIssues from "./claws-issues.js";
import { issuesAwaitingOperator } from "./awaiting-operator.js";
import { LABELS } from "./config.js";
import type * as db from "./db.js";
import { issueGateDetails, stagesForOpenIssues } from "./issue-stage.js";

function record(id: string, overrides: Partial<db.ClawsIssueRecord> = {}): db.ClawsIssueRecord {
  return { id, kind: "issue", state: "open", repos: ["o/r"], labels: [], lifecycle: "drafting", ...overrides } as db.ClawsIssueRecord;
}

describe("issueGateDetails (#clw_01M5Q66MKK4WHBJ8XT1EMZZGEA)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names what each open issue waits on the operator for, from the board's stages", async () => {
    vi.mocked(clawsIssues.getLatestRequirementsForOpenIssues).mockResolvedValue(new Map([["a", {}]]) as never);
    vi.mocked(issuesAwaitingOperator).mockResolvedValue(new Map([["c", { position: 2, title: "Rotate the key" }]]));
    const records = [
      record("a"),
      record("b", { lifecycle: "awaiting-plan-review" }),
      record("e", { lifecycle: "awaiting-plan-review", approved_through: "plan" }),
      record("c"),
      record("d", { lifecycle: "planning" }),
    ];
    const details = await issueGateDetails(records);
    expect(Object.fromEntries(details)).toEqual({ a: "requirements-review", b: "plan-review", c: "manual-step", d: null, e: null });
    // The same reads as the stage list, which is unchanged.
    const stages = await stagesForOpenIssues(records);
    expect(stages.get("a")!.stage).toBe("requirements-review");
    expect(stages.get("b")!.stage).toBe("awaiting-plan-review");
    expect(stages.get("e")!.stage).toBe("approved");
  });

  it("returns nothing for no issues", async () => {
    expect((await issueGateDetails([])).size).toBe(0);
    expect(issuesAwaitingOperator).not.toHaveBeenCalled();
  });
});
