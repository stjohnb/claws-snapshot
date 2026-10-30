import { describe, it, expect } from "vitest";
import { deriveApprovalTrack, mergeApproval, renderApprovalTrack, type ApprovalTrackInput, type ApprovalTrackPr } from "./approval-track.js";
import { LABELS } from "../config.js";
import { ESCALATION_REASON_PREFIX } from "../pr-hold.js";

function input(overrides: Partial<ApprovalTrackInput> = {}): ApprovalTrackInput {
  return { repo: "org/repo", ref: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", column: "requirements-review", labels: [], lifecycle: "ideas", ...overrides };
}

const pr = (overrides: Partial<ApprovalTrackPr> = {}): ApprovalTrackPr =>
  ({ repo: "org/repo", prNumber: 7, mergeApprovedAt: null, stage: "awaiting-merge", needsHumanReview: false, ...overrides });

/** `state/action` for each gate, Reqs first. */
function shape(i: ApprovalTrackInput): string[] {
  return deriveApprovalTrack(i).gates.map((g) => `${g.state}/${g.action}`);
}

describe("deriveApprovalTrack (#clw_01M5VRB6Q607S256SQ8NDC5AHT)", () => {
  it("in Requirements review, every gate can be approved through and the issue stops at requirements review (AC3–AC6)", () => {
    const track = deriveApprovalTrack(input());
    expect(track.gates.map((g) => g.label)).toEqual(["Reqs", "Plan", "Merge"]);
    expect(shape(input())).toEqual(["next/approve", "open/approve", "open/approve"]);
    expect(track.stopsAt).toBe("Stops at: requirements review");
    // Gate titles state the state only; what a click does is on the controls.
    expect(track.gates.map((g) => g.title)).toEqual(["Requirements not yet approved", "Plan not yet approved", "Merge not yet approved"]);
    expect(track.primary?.title).toContain("the plan then stops for your review");
    expect(track.secondary[0].title).toContain("Implementation starts without plan review");
  });

  it("in Awaiting plan review with a plan, Plan approves the plan and the issue stops at plan review (AC7)", () => {
    const i = input({ column: "awaiting-plan-review", lifecycle: "awaiting-plan-review", approvedThrough: "requirements", hasPlan: true });
    expect(shape(i)).toEqual(["approved/none", "next/approve", "open/approve"]);
    expect(deriveApprovalTrack(i).stopsAt).toBe("Stops at: plan review");
    // Without a plan nothing can be approved there.
    expect(shape({ ...i, hasPlan: false })).toEqual(["approved/none", "next/none", "open/none"]);
  });

  it("reads an approval through Plan as a withdrawable pre-approval ahead of plan review (AC4, AC8, AC14)", () => {
    const planning = input({ column: "planning", lifecycle: "planning", approvedThrough: "plan" });
    expect(shape(planning)).toEqual(["approved/none", "preapproved/withdraw", "next/approve"]);
    expect(deriveApprovalTrack(planning).stopsAt).toBe("Stops at: merge approval");
    // Withdrawn, the stop moves back to plan review.
    const withdrawn = { ...planning, approvedThrough: "requirements" as const };
    expect(shape(withdrawn)).toEqual(["approved/none", "next/approve", "open/approve"]);
    expect(deriveApprovalTrack(withdrawn).stopsAt).toBe("Stops at: plan review");
  });

  it("reads a retired gate label as approving nothing", () => {
    const i = input({ column: "awaiting-plan-review", lifecycle: "awaiting-plan-review", labels: ["Ready", "Ship", "Refined", "Automerge", "Claws Auto-Refine"], hasPlan: true });
    expect(shape(i)).toEqual(["approved/none", "next/approve", "open/approve"]);
    expect(deriveApprovalTrack(i).stopsAt).toBe("Stops at: plan review");
  });

  it("shows an issue filed approved through Plan pre-approved from Requirements review on (AC13)", () => {
    expect(deriveApprovalTrack(input({ column: "planning", lifecycle: "planning", approvedThrough: "plan" })).gates[1].state).toBe("preapproved");
    expect(deriveApprovalTrack(input({ approvedThrough: "plan" })).gates[1].state).toBe("preapproved");
  });

  it("runs to merge once every gate is approved (AC3, AC5, AC14)", () => {
    const i = input({ column: "planning", lifecycle: "planning", approvedThrough: "merge" });
    expect(shape(i)).toEqual(["approved/none", "preapproved/withdraw", "preapproved/withdraw"]);
    expect(deriveApprovalTrack(i).stopsAt).toBe("Runs to merge — no further stop");
    const merging = input({ column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [pr({ mergeApprovedAt: "2026-10-26T10:00:00Z" })] });
    expect(shape(merging)).toEqual(["approved/none", "approved/none", "approved/withdraw"]);
    expect(deriveApprovalTrack(merging).stopsAt).toBe("Runs to merge — no further stop");
  });

  it("shows an approval through Plan in Approved as an approved Plan gate (AC14)", () => {
    const i = input({ column: "approved", lifecycle: "awaiting-plan-review", approvedThrough: "plan" });
    expect(shape(i)).toEqual(["approved/none", "approved/none", "next/approve"]);
    expect(deriveApprovalTrack(i).stopsAt).toBe("Stops at: merge approval");
  });

  it("fills Merge only when every open PR is approved, and shows a partial approval naming the approved PRs (AC11)", () => {
    const some = input({ column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [pr({ prNumber: 7, mergeApprovedAt: "2026-10-26T10:00:00Z" }), pr({ prNumber: 8 })] });
    const merge = deriveApprovalTrack(some).gates[2];
    expect(merge.state).toBe("partial");
    expect(merge.action).toBe("approve");
    expect(merge.title).toContain("Merge approved for repo#7 only");
    expect(deriveApprovalTrack(some).stopsAt).toBe("Stops at: merge approval");
    expect(mergeApproval(some).approved).toBe(false);
    expect(mergeApproval({ ...some, approvedThrough: "merge" }).approved).toBe(true);
  });

  it("names each unplanned stop over the gates while it applies (AC12)", () => {
    const merging = input({ column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "merge" });
    expect(deriveApprovalTrack({ ...merging, column: "blocked" }).stopsAt).toBe("Stops at: Blocked");
    expect(deriveApprovalTrack({ ...merging, column: "in-progress", openPrs: [pr({ stage: "problematic" })] }).stopsAt).toBe(`Stops at: ${LABELS.problematic} on repo#7`);
    expect(deriveApprovalTrack({ ...merging, openPrs: [pr({ manualActionReason: `${ESCALATION_REASON_PREFIX} reviewers disagree` })] }).stopsAt).toBe("Stops at: reviewer escalation on repo#7");
    expect(deriveApprovalTrack({ ...merging, openPrs: [pr({ needsHumanReview: true })] }).stopsAt).toBe(`Stops at: ${LABELS.needsLgtm} on repo#7`);
    expect(deriveApprovalTrack({ ...merging, openPrs: [pr({ manualActionReason: "rotate the secret" })] }).stopsAt).toBe("Stops at: operator step on repo#7");
    expect(deriveApprovalTrack({ ...merging, awaitingOperator: true }).stopsAt).toBe("Stops at: operator step");
    expect(deriveApprovalTrack({ ...merging, awaitingImport: true }).stopsAt).toBe("Stops at: import into the Claws tracker");
  });

  it("stops at plan review for a design change pending re-approval, with no merge approval (AC10)", () => {
    const i = input({ column: "awaiting-plan-review", lifecycle: "awaiting-plan-review", approvedThrough: "requirements", hasPlan: true, reapprovalPending: true, openPrs: [pr({ stage: "awaiting-review" })] });
    expect(shape(i)).toEqual(["approved/none", "next/approve", "open/approve"]);
    expect(deriveApprovalTrack(i).stopsAt).toBe("Stops at: plan review (design change)");
  });

  it("leaves every gate read-only in Drafting, Blocked and Backlog and on a card awaiting import", () => {
    for (const i of [
      input({ column: "drafting" }),
      input({ column: "blocked", lifecycle: "blocked", approvedThrough: "merge" }),
      input({ column: "backlog", lifecycle: "backlog", approvedThrough: "plan" }),
      input({ awaitingImport: true }),
    ]) {
      const track = deriveApprovalTrack(i);
      expect(track.readOnly).toBe(true);
      expect(track.gates.every((g) => g.action === "none")).toBe(true);
    }
    // Filled gates still show filled.
    expect(deriveApprovalTrack(input({ column: "blocked", lifecycle: "blocked", approvedThrough: "merge" })).gates[2].state).toBe("preapproved");
    expect(deriveApprovalTrack(input({ column: "drafting" })).stopsAt).toBe("Stops at: requirements review");
  });

  it("fills Reqs from an approval record in a column that does not imply it", () => {
    expect(deriveApprovalTrack(input({ column: "blocked", lifecycle: "blocked", requirementsApproved: true })).gates[0].state).toBe("approved");
    expect(deriveApprovalTrack(input({ column: "blocked", lifecycle: "blocked" })).gates[0].state).toBe("next");
  });

  // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F: the Plan and Merge gates read the one
  // stored value, so each value has exactly one track.
  it.each([
    ["none, in Requirements review", { approvedThrough: "none" }, ["next/approve", "open/approve", "open/approve"], "Stops at: requirements review"],
    ["requirements, in Planning", { column: "planning", lifecycle: "planning", approvedThrough: "requirements" }, ["approved/none", "next/approve", "open/approve"], "Stops at: plan review"],
    ["requirements, in Awaiting plan review", { column: "awaiting-plan-review", lifecycle: "awaiting-plan-review", approvedThrough: "requirements", hasPlan: true }, ["approved/none", "next/approve", "open/approve"], "Stops at: plan review"],
    ["plan, pre-approved in Planning", { column: "planning", lifecycle: "planning", approvedThrough: "plan" }, ["approved/none", "preapproved/withdraw", "next/approve"], "Stops at: merge approval"],
    ["plan, approved in Approved", { column: "approved", lifecycle: "awaiting-plan-review", approvedThrough: "plan", hasPlan: true }, ["approved/none", "approved/none", "next/approve"], "Stops at: merge approval"],
    ["merge, pre-approved in Approved", { column: "approved", lifecycle: "awaiting-plan-review", approvedThrough: "merge", hasPlan: true }, ["approved/none", "approved/none", "preapproved/withdraw"], "Runs to merge — no further stop"],
    ["merge, reached in Awaiting merge", { column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "merge", openPrs: [pr({ mergeApprovedAt: "2026-10-26T10:00:00Z" })] }, ["approved/none", "approved/none", "approved/withdraw"], "Runs to merge — no further stop"],
    ["plan with one PR's merge approved, partial", { column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [pr({ mergeApprovedAt: "2026-10-26T10:00:00Z" }), pr({ prNumber: 8 })] }, ["approved/none", "approved/none", "partial/approve"], "Stops at: merge approval"],
    ["requirements, in Awaiting merge with a plan", { column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "requirements", hasPlan: true, openPrs: [pr()] }, ["approved/none", "next/approve", "open/approve"], "Stops at: plan review"],
    ["requirements, in In progress with a plan", { column: "in-progress", lifecycle: "awaiting-plan-review", approvedThrough: "requirements", hasPlan: true, openPrs: [pr()] }, ["approved/none", "next/approve", "open/approve"], "Stops at: plan review"],
    ["requirements, in In progress without a plan", { column: "in-progress", lifecycle: "awaiting-plan-review", approvedThrough: "requirements", hasPlan: false, openPrs: [pr()] }, ["approved/none", "next/none", "open/approve"], "Stops at: plan review"],
    ["plan, in In progress", { column: "in-progress", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [pr()] }, ["approved/none", "approved/none", "next/approve"], "Stops at: merge approval"],
  ] as const)("reads the stored approval %s", (_name, overrides, gates, stopsAt) => {
    const i = input(overrides as Partial<ApprovalTrackInput>);
    expect(shape(i)).toEqual(gates);
    expect(deriveApprovalTrack(i).stopsAt).toBe(stopsAt);
  });

  it("names a reviewer escalation on the Merge gate's title", () => {
    const i = input({ column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [pr({ manualActionReason: `${ESCALATION_REASON_PREFIX} x` })] });
    expect(deriveApprovalTrack(i).gates[2].title).toContain("a reviewer escalation is recorded");
  });
});

/** The primary button's label and the More… entries' labels, as `[primary, secondary]`. */
function actions(i: ApprovalTrackInput): [string | null, string[]] {
  const track = deriveApprovalTrack(i);
  return [track.primary?.label ?? null, track.secondary.map((a) => a.label)];
}

describe("approval actions (#clw_01M5X4HY4YC56Y6VEMK12P2QR7)", () => {
  const approvedPr = pr({ mergeApprovedAt: "2026-10-26T10:00:00Z" });
  it.each([
    ["Requirements review", {}, "Approve requirements", ["Approve requirements and pre-approve plan", "Approve requirements, plan and merge — no further stop"]],
    ["Requirements review with the plan pre-approved", { approvedThrough: "plan" }, "Approve requirements", ["Approve requirements and merge — no further stop", "Withdraw plan pre-approval"]],
    ["Requirements review approved through merge", { approvedThrough: "merge" }, "Approve requirements", ["Withdraw plan pre-approval and merge approval", "Withdraw merge approval"]],
    ["Planning", { column: "planning", lifecycle: "planning", approvedThrough: "requirements" }, null, ["Pre-approve plan", "Pre-approve plan and approve merge — no further stop"]],
    ["Planning with the plan pre-approved", { column: "planning", lifecycle: "planning", approvedThrough: "plan" }, "Approve merge", ["Withdraw plan pre-approval"]],
    ["Awaiting plan review with a plan", { column: "awaiting-plan-review", lifecycle: "awaiting-plan-review", approvedThrough: "requirements", hasPlan: true }, "Approve plan", ["Approve plan and merge — no further stop"]],
    ["Awaiting plan review without a plan", { column: "awaiting-plan-review", lifecycle: "awaiting-plan-review", approvedThrough: "requirements" }, null, []],
    ["Approved", { column: "approved", lifecycle: "awaiting-plan-review", approvedThrough: "plan", hasPlan: true }, "Approve merge", []],
    ["Approved with merge pre-approved", { column: "approved", lifecycle: "awaiting-plan-review", approvedThrough: "merge", hasPlan: true }, null, ["Withdraw merge approval"]],
    ["In progress", { column: "in-progress", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [pr({ stage: "awaiting-review" })] }, "Approve merge", []],
    ["Awaiting merge with merge approved", { column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "merge", openPrs: [approvedPr] }, null, ["Withdraw merge approval"]],
    ["Awaiting merge with one PR's merge approved", { column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [approvedPr, pr({ prNumber: 8 })] }, "Approve merge", []],
  ] as const)("in %s", (_name, overrides, primary, secondary) => {
    expect(actions(input(overrides as Partial<ApprovalTrackInput>))).toEqual([primary, secondary]);
  });

  it("offers nothing in Drafting, Blocked, Backlog and Done and on a card awaiting import", () => {
    for (const i of [
      input({ column: "drafting" }),
      input({ column: "blocked", lifecycle: "blocked", approvedThrough: "merge" }),
      input({ column: "backlog", lifecycle: "backlog", approvedThrough: "plan" }),
      input({ column: "done", lifecycle: "done", approvedThrough: "merge" }),
      input({ awaitingImport: true }),
    ]) {
      expect(actions(i)).toEqual([null, []]);
      expect(renderApprovalTrack(i)).not.toContain("approval-actions");
    }
  });

  it("names the PRs already approved in a partial merge's detail, and keeps the primary to the next gate only", () => {
    const track = deriveApprovalTrack(input({ column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [approvedPr, pr({ prNumber: 8 })] }));
    expect(track.primary).toMatchObject({ gate: "merge", withdraw: false });
    expect(track.primary?.title).toContain("approved for repo#7 only");
    expect(deriveApprovalTrack(input()).primary).toMatchObject({ gate: "requirements", withdraw: false });
  });

  it("never puts the primary's action among the More… entries", () => {
    for (const column of ["requirements-review", "planning", "awaiting-plan-review", "approved", "in-progress", "awaiting-merge"] as const) {
      for (const approvedThrough of ["none", "requirements", "plan", "merge"] as const) {
        const track = deriveApprovalTrack(input({ column, approvedThrough, hasPlan: true }));
        if (!track.primary) continue;
        expect(track.secondary.some((a) => a.gate === track.primary!.gate && !a.withdraw)).toBe(false);
      }
    }
  });
});

describe("renderApprovalTrack (#clw_01M61A4P3N7D76P1JR2HW5WNN5)", () => {
  const furthers = (html: string): Array<[string, string, string]> =>
    Array.from(html.matchAll(/<button type="button" draggable="false" data-gate="(\w+)" data-action="approve" class="approval-further approval-act" title="([^"]*)" aria-label="([^"]*)">([^<]*)<\/button>/g))
      .map((m) => [m[4], m[2], m[3]] as [string, string, string]);

  it("renders a read-only dot strip, the Stops at line, a filled primary and its attached further approvals", () => {
    const html = renderApprovalTrack(input({ column: "awaiting-plan-review", lifecycle: "awaiting-plan-review", approvedThrough: "requirements", hasPlan: true }));
    expect(html).toMatch(/^<div class="approval-track" role="group" aria-label="Approval for #[^"]+" data-track-repo="org\/repo" data-track-ref="clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC">/);
    const strip = html.match(/<ol class="approval-steps">.*<\/ol>/)![0];
    expect(strip).not.toContain("<button");
    expect(strip).not.toContain("data-action");
    expect(strip).not.toContain("disabled");
    expect(strip).not.toContain("role=\"button\"");
    expect(strip.match(/<li class="approval-step"/g)).toHaveLength(3);
    expect(strip.match(/<li class="approval-line" role="presentation" aria-hidden="true"/g)).toHaveLength(2);
    expect(strip).toContain(`<li class="approval-step" data-gate="plan" data-state="next" aria-label="Plan: Plan not yet approved"`);
    expect(strip).toContain(`<span class="approval-dot" aria-hidden="true"></span>Plan</li>`);
    expect(html).toContain(`<p class="approval-stops">Stops at <b>plan review</b></p>`);
    expect(html.match(/class="approval-primary approval-act"/g)).toHaveLength(1);
    expect(html).toContain(`data-gate="plan" data-action="approve" class="approval-primary approval-act" title="Approve the plan of #`);
    expect(html).toContain(`>Approve plan</button>`);
    expect(furthers(html)).toEqual([["&amp; merge", "Approve plan and merge — no further stop", "Approve plan and merge — no further stop"]]);
    expect(html).toContain(`<div class="approval-actions"><div class="approval-group">`);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("approval-more");
    expect(html).not.toContain("approval-menu");
  });

  it("attaches & plan and & merge to Approve requirements in Requirements review", () => {
    const html = renderApprovalTrack(input());
    expect(html).toContain(`>Approve requirements</button>`);
    expect(furthers(html)).toEqual([
      ["&amp; plan", "Approve requirements and pre-approve plan", "Approve requirements and pre-approve plan"],
      ["&amp; merge", "Approve requirements, plan and merge — no further stop", "Approve requirements, plan and merge — no further stop"],
    ]);
  });

  it("shows Approve merge alone in Awaiting merge with the plan approved", () => {
    const html = renderApprovalTrack(input({ column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [pr()] }));
    expect(html).toContain(`<div class="approval-group"><button type="button" draggable="false" data-gate="merge" data-action="approve" class="approval-primary approval-act"`);
    expect(html).toContain(`>Approve merge</button></div></div>`);
    expect(furthers(html)).toEqual([]);
    expect(html).not.toContain("approval-menu");
  });

  it("leads with an outlined Pre-approve plan in Planning, where there is no primary", () => {
    const html = renderApprovalTrack(input({ column: "planning", lifecycle: "planning", approvedThrough: "requirements" }));
    expect(html).not.toContain("approval-primary");
    expect(html).toContain(`<div class="approval-group"><button type="button" draggable="false" data-gate="plan" data-action="approve" class="approval-further approval-act" title="Implementation starts without plan review">Pre-approve plan</button>`);
    expect(furthers(html).map(([text]) => text)).toEqual(["&amp; merge"]);
  });

  it("makes each withdrawal a plain button filling the row when nothing is left to approve", () => {
    const html = renderApprovalTrack(input({ column: "planning", lifecycle: "planning", approvedThrough: "merge" }));
    expect(html).not.toContain("approval-primary");
    expect(html).not.toContain("approval-group");
    expect(html).not.toContain("approval-menu");
    expect(html).toContain(`<button type="button" draggable="false" data-gate="plan" data-action="withdraw" class="approval-plain approval-act" title="The plan then stops for your review">Withdraw plan pre-approval and merge approval</button>`);
    expect(html).toContain(`<button type="button" draggable="false" data-gate="merge" data-action="withdraw" class="approval-plain approval-act" title="The PR then waits for your merge approval">Withdraw merge approval</button>`);
  });

  it("puts the withdrawals beside a primary in a ⋯ menu with menu semantics", () => {
    const html = renderApprovalTrack(input({ column: "approved", lifecycle: "awaiting-plan-review", approvedThrough: "merge", hasPlan: true, requirementsApproved: true, openPrs: [] }));
    const fromPlanning = renderApprovalTrack(input({ column: "requirements-review", approvedThrough: "plan" }));
    for (const h of [html, fromPlanning]) expect(h).not.toContain("<select");
    expect(fromPlanning).toContain(`>Approve requirements</button>`);
    expect(fromPlanning).toMatch(/<details class="approval-menu"><summary draggable="false" aria-label="More approval actions for #[^"]+" aria-haspopup="menu" aria-expanded="false"><svg [^>]*>.*<\/svg><\/summary><ul class="approval-menu-list" role="menu">/);
    expect(fromPlanning).toContain(`<li role="none"><button type="button" draggable="false" data-gate="plan" data-action="withdraw" class="approval-act" role="menuitem">Withdraw plan pre-approval<small>The plan then stops for your review</small></button></li>`);
    expect(fromPlanning.indexOf("approval-menu")).toBeGreaterThan(fromPlanning.indexOf("</div>", fromPlanning.indexOf("approval-group")));
  });

  it("draws each dot state, and accents the line after an approved step only", () => {
    const steps = (html: string): string[] => html.match(/<li class="approval-(?:step|line)"[^>]*>/g)!;
    const planning = steps(renderApprovalTrack(input({ column: "planning", lifecycle: "planning", approvedThrough: "plan" })));
    expect(planning.map((s) => s.match(/data-state="(\w+)"/)?.[1] ?? (s.includes("data-done") ? "line-done" : "line"))).toEqual(["approved", "line-done", "preapproved", "line", "next"]);
    expect(planning.filter((s) => s.includes('aria-current="step"'))).toHaveLength(1);
    expect(planning[4]).toContain('aria-current="step"');
    const open = steps(renderApprovalTrack(input()));
    expect(open[4]).toContain('data-state="open"');
    expect(open[4]).not.toContain("aria-current");
    expect(open.filter((s) => s.includes("data-done"))).toHaveLength(0);
    const partial = steps(renderApprovalTrack(input({ column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "plan", openPrs: [pr({ mergeApprovedAt: "2026-01-01" }), pr({ prNumber: 8 })] })));
    expect(partial[4]).toContain('data-state="partial"');
    expect(partial.filter((s) => s.includes("data-done"))).toHaveLength(2);
  });

  it("bolds the stop's name, in the warning colour for an unplanned stop and the success colour for the run to merge", () => {
    expect(renderApprovalTrack(input({ column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "merge", openPrs: [pr({ manualActionReason: "Apply the manifest" })] })))
      .toContain(`<p class="approval-stops warn">Stops at <b>operator step</b> on repo#7</p>`);
    expect(renderApprovalTrack(input({ column: "awaiting-merge", lifecycle: "awaiting-plan-review", approvedThrough: "merge", openPrs: [pr()] })))
      .toContain(`<p class="approval-stops go"><b>Runs to merge</b> — no further stop</p>`);
    expect(deriveApprovalTrack(input()).stop).toBe("gate");
  });

  it("renders no action row in the read-only columns", () => {
    for (const column of ["drafting", "blocked", "backlog", "done"] as const) {
      const html = renderApprovalTrack(input({ column }));
      expect(html).toContain(`<ol class="approval-steps">`);
      expect(html).toContain(`class="approval-stops`);
      expect(html).not.toContain("approval-actions");
    }
    expect(renderApprovalTrack(input({ awaitingImport: true }))).not.toContain("approval-actions");
  });

  it("keeps the Blocked stops line short however long the blocked reason is", () => {
    const html = renderApprovalTrack(input({ column: "blocked", blockedReason: "## Manual actions\n- **Do** this\n\nclaws-awaiting-operator" } as never));
    expect(html).toContain('<p class="approval-stops warn">Stops at <b>Blocked</b></p>');
    expect(html).not.toContain("Manual actions");
  });
});
