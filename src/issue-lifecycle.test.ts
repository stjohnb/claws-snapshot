import { describe, it, expect } from "vitest";
import { LABELS } from "./config.js";
import {
  ISSUE_LIFECYCLES,
  STATE_LABELS,
  isIssueLifecycle,
  isStateLabel,
  labelForLifecycle,
  lifecycleForLabel,
  replaceLegacyLabels,
  resolveStage,
  RETIRED_GATE_LABELS,
  splitStateLabels,
} from "./issue-lifecycle.js";

describe("issue-lifecycle", () => {
  it("reads the retired Claws Ignore as Backlog, once, and leaves other labels alone", () => {
    expect(replaceLegacyLabels(["Priority", "Claws Ignore"])).toEqual(["Priority", LABELS.backlog]);
    expect(replaceLegacyLabels(["Claws Ignore", "Backlog"])).toEqual([LABELS.backlog]);
    expect(replaceLegacyLabels(["bug"])).toEqual(["bug"]);
    expect(splitStateLabels(replaceLegacyLabels(["Claws Ignore", "Refined"])).lifecycle).toBe("backlog");
    expect(splitStateLabels(replaceLegacyLabels(["Claws Ignore", "Refined"])).rest).toEqual([]);
  });

  it("spells the state labels exactly as config's LABELS does", () => {
    expect(STATE_LABELS).toEqual([LABELS.backlog, LABELS.blocked]);
  });

  it("names the retired gate labels, none of which is a live label any more", () => {
    expect(RETIRED_GATE_LABELS).toEqual(["Refined", "Ready", "Ship", "Claws Auto-Refine", "Automerge"]);
    const live = Object.values(LABELS) as string[];
    for (const label of RETIRED_GATE_LABELS) expect(live).not.toContain(label);
  });

  it("maps each stored lifecycle to its label and back", () => {
    expect(labelForLifecycle("ideas")).toBeUndefined();
    expect(labelForLifecycle("planning")).toBeUndefined();
    expect(labelForLifecycle("awaiting-plan-review")).toBeUndefined();
    expect(labelForLifecycle("blocked")).toBe(LABELS.blocked);
    expect(labelForLifecycle("backlog")).toBe(LABELS.backlog);
    for (const lifecycle of ISSUE_LIFECYCLES) {
      const label = labelForLifecycle(lifecycle);
      if (label !== undefined) expect(lifecycleForLabel(label)).toBe(lifecycle);
    }
    expect(lifecycleForLabel(LABELS.priority)).toBeUndefined();
  });

  it("recognises lifecycles and state labels", () => {
    expect(isIssueLifecycle("approved")).toBe(false);
    expect(isIssueLifecycle("awaiting-plan-review")).toBe(true);
    expect(isIssueLifecycle("backlog")).toBe(true);
    expect(isStateLabel(LABELS.backlog)).toBe(true);
    expect(isIssueLifecycle("in-progress")).toBe(false);
    expect(isIssueLifecycle("done")).toBe(false);
    expect(isStateLabel("Refined")).toBe(false);
    expect(isStateLabel(LABELS.priority)).toBe(false);
  });

  it("splits state labels out by the board's precedence", () => {
    // The retired gate labels are neither a lifecycle nor a label row.
    expect(splitStateLabels(["bug", "Ready", "Refined", "Automerge"])).toEqual({ lifecycle: "ideas", rest: ["bug"] });
    expect(splitStateLabels(["Refined", LABELS.blocked])).toEqual({ lifecycle: "blocked", rest: [] });
    // A human's "not now" outranks every automated state (#3293).
    expect(splitStateLabels([LABELS.blocked, LABELS.backlog])).toEqual({ lifecycle: "backlog", rest: [] });
    expect(splitStateLabels([LABELS.blocked, LABELS.backlog, "bug"])).toEqual({ lifecycle: "backlog", rest: ["bug"] });
    expect(splitStateLabels([LABELS.priority])).toEqual({ lifecycle: "ideas", rest: [LABELS.priority] });
    expect(splitStateLabels([])).toEqual({ lifecycle: "ideas", rest: [] });
  });

  it.each([
    // [labelLifecycle, storedLifecycle, requirementsApprovedAt, expected]
    ["ideas", "ideas", null, "ideas"],
    ["ideas", "planning", null, "planning"],
    // No forge label says Awaiting plan review, so the stored value stands.
    ["ideas", "awaiting-plan-review", null, "awaiting-plan-review"],
    ["ideas", "awaiting-plan-review", "2026-09-01 00:00:00", "awaiting-plan-review"],
    ["ideas", "blocked", null, "ideas"],
    ["ideas", "ideas", "2026-09-01 00:00:00", "planning"],
    // A real label always wins outright — "past Ideas" only matters for the
    // label-less case, where the forge has nothing to say.
    ["backlog", "awaiting-plan-review", null, "backlog"],
    ["blocked", "planning", "2026-09-01 00:00:00", "blocked"],
  ] as const)("resolveStage(%s, {lifecycle: %s, requirementsApprovedAt: %s}) is %s", (labelLifecycle, lifecycle, requirementsApprovedAt, expected) => {
    expect(resolveStage(labelLifecycle, { lifecycle, requirementsApprovedAt })).toBe(expected);
  });
});
