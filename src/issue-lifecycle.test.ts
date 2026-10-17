import { describe, it, expect } from "vitest";
import { LABELS } from "./config.js";
import {
  ISSUE_LIFECYCLES,
  STATE_LABELS,
  isIssueLifecycle,
  isStateLabel,
  labelForLifecycle,
  lifecycleForLabel,
  resolveStage,
  splitStateLabels,
} from "./issue-lifecycle.js";

describe("issue-lifecycle", () => {
  it("spells the state labels exactly as config's LABELS does", () => {
    expect(STATE_LABELS).toEqual([LABELS.backlog, LABELS.blocked, LABELS.refined, LABELS.ready]);
  });

  it("maps each stored lifecycle to its label and back", () => {
    expect(labelForLifecycle("ideas")).toBeUndefined();
    expect(labelForLifecycle("planning")).toBeUndefined();
    expect(labelForLifecycle("awaiting-plan-review")).toBe(LABELS.ready);
    expect(labelForLifecycle("approved")).toBe(LABELS.refined);
    expect(labelForLifecycle("blocked")).toBe(LABELS.blocked);
    expect(labelForLifecycle("backlog")).toBe(LABELS.backlog);
    for (const lifecycle of ISSUE_LIFECYCLES) {
      const label = labelForLifecycle(lifecycle);
      if (label !== undefined) expect(lifecycleForLabel(label)).toBe(lifecycle);
    }
    expect(lifecycleForLabel(LABELS.priority)).toBeUndefined();
  });

  it("recognises lifecycles and state labels", () => {
    expect(isIssueLifecycle("approved")).toBe(true);
    expect(isIssueLifecycle("backlog")).toBe(true);
    expect(isStateLabel(LABELS.backlog)).toBe(true);
    expect(isIssueLifecycle("in-progress")).toBe(false);
    expect(isIssueLifecycle("done")).toBe(false);
    expect(isStateLabel(LABELS.refined)).toBe(true);
    expect(isStateLabel(LABELS.priority)).toBe(false);
  });

  it("splits state labels out by the board's precedence", () => {
    expect(splitStateLabels(["bug", LABELS.ready, LABELS.refined])).toEqual({ lifecycle: "approved", rest: ["bug"] });
    expect(splitStateLabels([LABELS.refined, LABELS.blocked])).toEqual({ lifecycle: "blocked", rest: [] });
    // A human's "not now" outranks every automated state (#3293).
    expect(splitStateLabels([LABELS.refined, LABELS.backlog])).toEqual({ lifecycle: "backlog", rest: [] });
    expect(splitStateLabels([LABELS.blocked, LABELS.backlog, "bug"])).toEqual({ lifecycle: "backlog", rest: ["bug"] });
    expect(splitStateLabels([LABELS.priority])).toEqual({ lifecycle: "ideas", rest: [LABELS.priority] });
    expect(splitStateLabels([])).toEqual({ lifecycle: "ideas", rest: [] });
  });

  it.each([
    // [labelLifecycle, storedLifecycle, requirementsApprovedAt, expected]
    ["ideas", "ideas", null, "ideas"],
    ["ideas", "planning", null, "planning"],
    ["ideas", "awaiting-plan-review", null, "planning"],
    ["ideas", "approved", null, "planning"],
    ["ideas", "blocked", null, "ideas"],
    ["ideas", "ideas", "2026-09-01 00:00:00", "planning"],
    // A real label always wins outright — "past Ideas" only matters for the
    // label-less case, where the forge has nothing to say.
    ["awaiting-plan-review", "blocked", null, "awaiting-plan-review"],
    ["blocked", "planning", "2026-09-01 00:00:00", "blocked"],
  ] as const)("resolveStage(%s, {lifecycle: %s, requirementsApprovedAt: %s}) is %s", (labelLifecycle, lifecycle, requirementsApprovedAt, expected) => {
    expect(resolveStage(labelLifecycle, { lifecycle, requirementsApprovedAt })).toBe(expected);
  });
});
