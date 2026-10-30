import { describe, it, expect } from "vitest";
import { APPROVAL_GATES, approvalRank, atLeast, isApprovedThrough, maxApproval, stopsAtFor, withdrawMergeTarget } from "./issue-approval.js";

describe("issue approval", () => {
  it("orders the gates none → requirements → plan → merge", () => {
    expect(APPROVAL_GATES).toEqual(["none", "requirements", "plan", "merge"]);
    expect(APPROVAL_GATES.map(approvalRank)).toEqual([0, 1, 2, 3]);
  });

  it("ranks a missing or unknown value as none", () => {
    expect(approvalRank(null)).toBe(0);
    expect(approvalRank(undefined)).toBe(0);
    expect(approvalRank("approved")).toBe(0);
  });

  it("recognises only the four stored values", () => {
    for (const gate of APPROVAL_GATES) expect(isApprovedThrough(gate)).toBe(true);
    for (const other of ["", "Merge", "approved", null, undefined, 2]) expect(isApprovedThrough(other)).toBe(false);
  });

  it("atLeast reads a value as approved through its own gate and every lower one", () => {
    expect(atLeast("plan", "none")).toBe(true);
    expect(atLeast("plan", "requirements")).toBe(true);
    expect(atLeast("plan", "plan")).toBe(true);
    expect(atLeast("plan", "merge")).toBe(false);
    expect(atLeast("merge", "plan")).toBe(true);
    expect(atLeast(null, "requirements")).toBe(false);
    expect(atLeast(undefined, "none")).toBe(true);
    expect(atLeast("bogus", "requirements")).toBe(false);
  });

  it("maxApproval picks the higher of two values, whichever side it is on", () => {
    expect(maxApproval("none", "plan")).toBe("plan");
    expect(maxApproval("merge", "requirements")).toBe("merge");
    expect(maxApproval("plan", "plan")).toBe("plan");
  });

  it("words the Stops at line for each first open gate, and the run-to-merge line for none", () => {
    expect(stopsAtFor("requirements")).toBe("Stops at: requirements review");
    expect(stopsAtFor("plan")).toBe("Stops at: plan review");
    expect(stopsAtFor("merge")).toBe("Stops at: merge approval");
    expect(stopsAtFor(null)).toBe("Runs to merge — no further stop");
    expect(stopsAtFor(undefined)).toBe("Runs to merge — no further stop");
  });
});

describe("withdrawMergeTarget", () => {
  it("lowers Merge to Plan and restates anything lower, never raising it", () => {
    expect(withdrawMergeTarget("merge")).toBe("plan");
    expect(withdrawMergeTarget("plan")).toBe("plan");
    expect(withdrawMergeTarget("requirements")).toBe("requirements");
  });
});
