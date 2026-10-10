import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  withPlannerRun,
  submitPlan,
  submitOutcome,
  submitStepBack,
  submitFollowupVerdict,
  getFollowupVerdict,
  getSubmission,
  hasPlannerRun,
  getRunRejections,
  plannerRunHandler,
  NO_SUCH_PLANNER_RUN,
  MAX_PLANNED_PR_TITLE_CHARS,
  MAX_MANUAL_ACTION_CHARS,
  type PlannerRunInput,
  type PlanSubmission,
} from "./planner-runs.js";

const RUN: PlannerRunInput = {
  repo: "test-org/test-repo",
  issueRef: 42,
  stage: "plan",
  allowedRepos: ["test-org/test-repo"],
  allowedDuplicates: [7, 8],
  allowedTransfers: ["test-org/other-repo"],
};

const THREE = "### PR 1: A\na\n\n### PR 2: B\nb\n\n### PR 3: C\nc";

function threePrs(...deps: unknown[]): Record<string, unknown>[] {
  return ["a", "b", "c"].map((title, i) => ({
    repo: "test-org/test-repo",
    title,
    ...(deps[i] !== undefined ? { depends_on: deps[i] } : {}),
  }));
}

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan: "### Requirement\nDo it.",
    prs: [{ repo: "test-org/test-repo", title: "Do it" }],
    implementation_model: "sonnet",
    review_model: "opus",
    ...overrides,
  };
}

function errorOf(result: { ok: boolean; error?: string }): string {
  expect(result.ok).toBe(false);
  return result.error ?? "";
}

describe("planner runs", () => {
  it("canonicalises a valid plan", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(submitPlan(id, plan({
        plan: "## Implementation Plan\n\n### Requirement\nDo it.",
        prs: [{ repo: "TEST-ORG/Test-Repo", title: `  ${"t".repeat(250)}  ` }],
        implementation_model: "Haiku",
        review_model: " sonnet ",
        target_pr: "#12",
      }))).toEqual({ ok: true });
      expect(getSubmission(id)).toEqual({
        kind: "plan",
        plan: "### Requirement\nDo it.",
        prs: [{ repo: "test-org/test-repo", title: "t".repeat(MAX_PLANNED_PR_TITLE_CHARS), dependsOn: null, kind: "pr", manualAction: null }],
        implementationModel: "haiku",
        reviewModel: "sonnet",
        targetPr: 12,
        response: null,
      });
    });
  });

  it("keeps the last valid call", async () => {
    await withPlannerRun(RUN, async (id) => {
      submitPlan(id, plan({ plan: "first" }));
      submitPlan(id, plan({ plan: "second" }));
      expect(getSubmission(id)).toMatchObject({ plan: "second" });
    });
  });

  it("rejects a PR in a repo outside the allowed ones, naming them", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitPlan(id, plan({ prs: [{ repo: "someone/else", title: "x" }] })))).toContain("test-org/test-repo");
      expect(getSubmission(id)).toBeNull();
    });
  });

  it("accepts every repo of a multi-repo issue and rejects a third", async () => {
    await withPlannerRun({ ...RUN, allowedRepos: ["test-org/a", "test-org/b"] }, async (id) => {
      const twoPRs = "### PR 1: one\nIn b.\n### PR 2: two\nIn a.";
      expect(submitPlan(id, plan({ plan: twoPRs, prs: [{ repo: "test-org/b", title: "one" }, { repo: "Test-Org/A", title: "two" }] }))).toEqual({ ok: true });
      expect(getSubmission(id)).toMatchObject({ prs: [{ repo: "test-org/b", title: "one" }, { repo: "test-org/a", title: "two" }] });
      const error = errorOf(submitPlan(id, plan({ plan: twoPRs, prs: [{ repo: "test-org/a", title: "one" }, { repo: "test-org/c", title: "two" }] })));
      expect(error).toContain("test-org/a");
      expect(error).toContain("test-org/b");
    });
  });

  it("stores depends_on deduplicated and sorted, null when omitted", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(submitPlan(id, plan({ plan: THREE, prs: threePrs([], undefined, [2, 1, 2]) }))).toEqual({ ok: true });
      expect((getSubmission(id) as PlanSubmission).prs.map((p) => p.dependsOn)).toEqual([[], null, [1, 2]]);
    });
  });

  it.each([
    ["an empty plan", { plan: "## Implementation Plan\n\n  " }, "`plan` is empty"],
    ["no PRs", { prs: [] }, "at least one PR"],
    ["more than 20 PRs", { prs: Array.from({ length: 21 }, (_, i) => ({ repo: "test-org/test-repo", title: `p${i}` })) }, "at most 20"],
    ["an empty title", { prs: [{ repo: "test-org/test-repo", title: " " }] }, "title is empty"],
    ["a bad implementation model", { implementation_model: "fable" }, "implementation_model"],
    ["a bad review model", { review_model: "haiku" }, "review_model"],
    ["fewer PRs than the plan's sections", { plan: "### PR 1: A\na\n\n### PR 2: B\nb\n\n### PR 3: C\nc" }, "`prs` has 1 entry but the plan has 3 `### PR N:` sections"],
    ["more PRs than a plan with no sections", { prs: [{ repo: "test-org/test-repo", title: "a" }, { repo: "test-org/test-repo", title: "b" }] }, "the plan has 1 `### PR N:` section"],
    ["target_pr with 2 PRs", { target_pr: 5, plan: "### PR 1: A\na\n\n### PR 2: B\nb", prs: [{ repo: "test-org/test-repo", title: "a" }, { repo: "test-org/test-repo", title: "b" }] }, "single-PR plan"],
    ["a non-numeric target_pr", { target_pr: "soon" }, "positive PR number"],
    ["a response outside the refine stage", { response: "hi" }, "only accepted when refining"],
    ["a dependency on the PR itself", { plan: THREE, prs: threePrs(undefined, [2]) }, "prs[2].depends_on must be an array of earlier positions — it may only name positions 1..1"],
    ["a dependency on a later PR", { plan: THREE, prs: threePrs(undefined, undefined, [4]) }, "may only name positions 1..2"],
    ["a dependency on the first PR", { plan: THREE, prs: threePrs([1]) }, "must be [] for the first PR"],
    ["a non-array depends_on", { plan: THREE, prs: threePrs(undefined, 1) }, "prs[2].depends_on"],
    ["a fractional dependency", { plan: THREE, prs: threePrs(undefined, undefined, [1.5]) }, "prs[3].depends_on"],
    ["a non-string manual_action_before_merge", { prs: [{ repo: "test-org/test-repo", title: "a", manual_action_before_merge: 3 }] }, "prs[1].manual_action_before_merge must be a string"],
    ["an over-long manual_action_before_merge", { prs: [{ repo: "test-org/test-repo", title: "a", manual_action_before_merge: "x".repeat(MAX_MANUAL_ACTION_CHARS + 1) }] }, "keep it to 300"],
    ["target_pr with 2 PRs and a manual step", { target_pr: 5, plan: "### PR 1: A\na\n\n### PR 2: B\nb\n\n### Manual actions\nm", prs: [{ repo: "test-org/test-repo", title: "a" }, { repo: "test-org/test-repo", title: "b" }] }, "this plan lists 2 PRs"],
  ])("rejects %s with a message", async (_label, overrides, message) => {
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitPlan(id, plan(overrides)))).toContain(message);
    });
  });

  describe("manual actions", () => {
    const WITH_MANUAL = "### PR 1: A\na\n\n### PR 2: B\nb\n\n### Manual actions (operator)\n1. Import the repo.\n\n### Verification\nv";

    it("appends the manual section as a final step after every PR, in the primary repo", async () => {
      await withPlannerRun({ ...RUN, allowedRepos: ["test-org/test-repo", "test-org/zz"] }, async (id) => {
        expect(submitPlan(id, plan({
          plan: WITH_MANUAL,
          prs: [{ repo: "test-org/zz", title: "a" }, { repo: "test-org/zz", title: "b", manual_action_before_merge: "  Import the repo on Forgejo  " }],
        }))).toEqual({ ok: true });
        expect((getSubmission(id) as PlanSubmission).prs).toEqual([
          { repo: "test-org/zz", title: "a", dependsOn: null, kind: "pr", manualAction: null },
          { repo: "test-org/zz", title: "b", dependsOn: null, kind: "pr", manualAction: "Import the repo on Forgejo" },
          { repo: "test-org/test-repo", title: "Manual actions (operator)", dependsOn: [1, 2], kind: "manual", manualAction: null },
        ]);
      });
    });

    it("counts only PR entries against the `### PR N:` sections", async () => {
      await withPlannerRun(RUN, async (id) => {
        expect(errorOf(submitPlan(id, plan({ plan: WITH_MANUAL, prs: threePrs() })))).toContain("`prs` has 3 entries but the plan has 2");
      });
    });

    it("strips markdown from the heading and allows target_pr on a single-PR plan with a manual step", async () => {
      await withPlannerRun(RUN, async (id) => {
        expect(submitPlan(id, plan({ plan: "Do it.\n\n## Manual cutover (*operator*)\nRe-point Flux.", target_pr: 9 }))).toEqual({ ok: true });
        const sub = getSubmission(id) as PlanSubmission;
        expect(sub.targetPr).toBe(9);
        expect(sub.prs.map((p) => [p.kind, p.title, p.dependsOn])).toEqual([["pr", "Do it", null], ["manual", "Manual cutover (operator)", [1]]]);
      });
    });

    it("treats a blank manual_action_before_merge as none", async () => {
      await withPlannerRun(RUN, async (id) => {
        expect(submitPlan(id, plan({ prs: [{ repo: "test-org/test-repo", title: "a", manual_action_before_merge: "  " }] }))).toEqual({ ok: true });
        expect((getSubmission(id) as PlanSubmission).prs[0].manualAction).toBeNull();
      });
    });
  });

  it("accepts one entry per `### PR N:` section", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(submitPlan(id, plan({
        plan: "### Requirement\nx\n\n### PR 1: A\na\n\n### PR 2: B\nb",
        prs: [{ repo: "test-org/test-repo", title: "A" }, { repo: "test-org/test-repo", title: "B" }],
      }))).toEqual({ ok: true });
    });
  });

  it("accepts a response in the refine stage", async () => {
    await withPlannerRun({ ...RUN, stage: "refine" }, async (id) => {
      expect(submitPlan(id, plan({ response: " Thanks! " }))).toEqual({ ok: true });
      expect(getSubmission(id)).toMatchObject({ response: "Thanks!" });
    });
  });

  it("validates and canonicalises outcomes against the offered lists", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(submitOutcome(id, { outcome: "duplicate", duplicate_of: "#8", explanation: "Same cause." })).toEqual({ ok: true });
      expect(getSubmission(id)).toEqual({ kind: "outcome", outcome: { kind: "duplicate", duplicateOf: 8 }, explanation: "Same cause." });
      expect(submitOutcome(id, { outcome: "transfer", transfer_to: "TEST-ORG/other-repo", explanation: "Elsewhere." })).toEqual({ ok: true });
      expect(getSubmission(id)).toMatchObject({ outcome: { kind: "transfer", transferTo: "test-org/other-repo" } });
    });
  });

  it("rejects a duplicate that was not offered", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitOutcome(id, { outcome: "duplicate", duplicate_of: 99, explanation: "x" }))).toContain("#7, #8");
    });
    await withPlannerRun({ ...RUN, allowedDuplicates: [] }, async (id) => {
      expect(errorOf(submitOutcome(id, { outcome: "duplicate", duplicate_of: 7, explanation: "x" }))).toContain("no duplicate candidates");
    });
  });

  it("rejects a transfer outside the allowlist, an unknown outcome and a missing explanation", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitOutcome(id, { outcome: "transfer", transfer_to: "test-org/nope", explanation: "x" }))).toContain("not an allowed destination");
      expect(errorOf(submitOutcome(id, { outcome: "nonsense", explanation: "x" }))).toContain("unknown outcome");
      expect(errorOf(submitOutcome(id, { outcome: "blocked" }))).toContain("explanation");
    });
  });

  it("rejects an outcome after a plan, and a plan after an outcome", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(submitPlan(id, plan())).toEqual({ ok: true });
      expect(errorOf(submitOutcome(id, { outcome: "blocked", explanation: "x" }))).toContain("either a plan or an outcome");
      expect(getSubmission(id)?.kind).toBe("plan");
    });
    await withPlannerRun(RUN, async (id) => {
      expect(submitOutcome(id, { outcome: "blocked", explanation: "x" })).toEqual({ ok: true });
      expect(errorOf(submitPlan(id, plan()))).toContain("either a plan or an outcome");
    });
  });

  it("rejects any outcome in a plan-only run", async () => {
    await withPlannerRun({ ...RUN, allowOutcomes: false }, async (id) => {
      expect(errorOf(submitOutcome(id, { outcome: "blocked", explanation: "x" }))).toContain("cannot report an outcome");
    });
  });

  it("records a step-back verdict and validates its revision", async () => {
    await withPlannerRun({ ...RUN, stage: "step_back" }, async (id) => {
      expect(errorOf(submitPlan(id, plan()))).toContain("claws_step_back_verdict");
      expect(errorOf(submitStepBack(id, { verdict: "reconsider", revised: plan({ prs: [{ repo: "x/y", title: "t" }] }) }))).toMatch(/^revised: /);
      expect(errorOf(submitStepBack(id, { verdict: "sound", revised: plan() }))).toContain("reconsider");
      expect(submitStepBack(id, { verdict: "reconsider", critique: "Better way.", revised: plan() })).toEqual({ ok: true });
      expect(getSubmission(id)).toMatchObject({ kind: "step_back", verdict: "reconsider", critique: "Better way.", revised: { kind: "plan" } });
    });
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitStepBack(id, { verdict: "sound" }))).toContain("only available in a step-back pass");
    });
  });

  it("gives a no-such-run error for an unknown id", () => {
    expect(submitPlan("nope", plan())).toEqual({ ok: false, error: NO_SUCH_PLANNER_RUN });
    expect(submitOutcome("nope", {})).toEqual({ ok: false, error: NO_SUCH_PLANNER_RUN });
  });

  it("deletes the run after withPlannerRun throws", async () => {
    let runId = "";
    await expect(withPlannerRun(RUN, async (id) => {
      runId = id;
      expect(hasPlannerRun(id)).toBe(true);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(hasPlannerRun(runId)).toBe(false);
    expect(submitPlan(runId, plan())).toEqual({ ok: false, error: NO_SUCH_PLANNER_RUN });
  });

  it("gives each run its own id", async () => {
    const ids = await Promise.all([withPlannerRun(RUN, async (id) => id), withPlannerRun(RUN, async (id) => id)]);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("planner run rejections (#clw_01M3A42ZTGECAB11S0BZA6NG1A)", () => {
  it("counts refused calls with the last error, and a later accepted call still records the submission", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(getRunRejections(id)).toEqual({ count: 0, last: null });
      expect(submitPlan(id, plan({ prs: [{ repo: "someone/else", title: "x" }] })).ok).toBe(false);
      expect(submitOutcome(id, { outcome: "blocked" }).ok).toBe(false);
      expect(getRunRejections(id)).toEqual({ count: 2, last: expect.stringContaining("explanation") });
      expect(submitPlan(id, plan())).toEqual({ ok: true });
      expect(getSubmission(id)?.kind).toBe("plan");
      expect(getRunRejections(id).count).toBe(2);
    });
  });

  it("reports zero for an unknown run, and a call against one is not counted anywhere", () => {
    expect(submitPlan("no-such-run", plan())).toEqual({ ok: false, error: NO_SUCH_PLANNER_RUN });
    expect(getRunRejections("no-such-run")).toEqual({ count: 0, last: null });
  });

  it("serves the routes through the shared handler: 404 unknown run, 400 bad JSON or refused input, 200 saved", async () => {
    const app = new Hono();
    app.post("/api/planner-runs/:id/plan", plannerRunHandler(submitPlan));
    const post = (id: string, body: string) => app.request(`/api/planner-runs/${id}/plan`, { method: "POST", body, headers: { "content-type": "application/json" } });

    const missing = await post("no-such-run", JSON.stringify(plan()));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: NO_SUCH_PLANNER_RUN });

    await withPlannerRun(RUN, async (id) => {
      const bad = await post(id, "{not json");
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "Invalid JSON body" });

      const refused = await post(id, JSON.stringify(plan({ prs: [{ repo: "someone/else", title: "x" }] })));
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain("test-org/test-repo");

      const saved = await post(id, JSON.stringify(plan()));
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ ok: true });
      expect(getSubmission(id)?.kind).toBe("plan");
      expect(getRunRejections(id).count).toBe(1);
    });
  });
});

describe("follow-up verdicts", () => {
  const FOLLOWUP: PlannerRunInput = {
    repo: "test-org/test-repo",
    issueRef: 42,
    stage: "followup",
    allowedRepos: ["test-org/other-repo", "test-org/test-repo"],
    allowOutcomes: false,
    plannedPrs: [{ repo: "test-org/test-repo", kind: "pr" }, { repo: "test-org/other-repo", kind: "pr" }],
    openPrs: [{ repo: "test-org/test-repo", number: 5 }, { repo: "test-org/other-repo", number: 9 }],
  };
  const TWO = "### PR 1: A\na\n\n### PR 2: B\nb";
  const twoPrs = (second = "test-org/other-repo") => plan({ plan: TWO, prs: [{ repo: "test-org/test-repo", title: "A" }, { repo: second, title: "B" }] });

  it("records answered with no plan and no affected PRs", async () => {
    await withPlannerRun(FOLLOWUP, async (id) => {
      expect(getFollowupVerdict(id)).toBeNull();
      expect(submitFollowupVerdict(id, { verdict: "answered", affected_prs: [{ repo: "test-org/test-repo", number: 5 }] })).toEqual({ ok: true });
      expect(getFollowupVerdict(id)).toEqual({ verdict: "answered", affectedPrs: [] });
    });
  });

  it("accepts an amendment that keeps the PR set, canonicalising the affected PRs", async () => {
    await withPlannerRun(FOLLOWUP, async (id) => {
      expect(submitPlan(id, twoPrs())).toEqual({ ok: true });
      expect(submitFollowupVerdict(id, { verdict: "plan_amendment", affected_prs: [{ repo: "TEST-ORG/Other-Repo", number: "#9" }, { repo: "test-org/other-repo", number: 9 }] })).toEqual({ ok: true });
      expect(getFollowupVerdict(id)).toEqual({ verdict: "plan_amendment", affectedPrs: [{ repo: "test-org/other-repo", number: 9 }] });
      expect(getSubmission(id)?.kind).toBe("plan");
    });
  });

  it("needs claws_save_plan before an amendment", async () => {
    await withPlannerRun(FOLLOWUP, async (id) => {
      expect(errorOf(submitFollowupVerdict(id, { verdict: "plan_amendment" }))).toContain("call claws_save_plan first");
      expect(getFollowupVerdict(id)).toBeNull();
    });
  });

  it("rejects an amendment that changes the PR count, a position's repo or its kind", async () => {
    const message = "This changes the PR set — that is a design change, not an amendment.";
    for (const changed of [
      plan(),
      twoPrs("test-org/test-repo"),
      plan({ plan: `${TWO}\n\n### Manual actions (operator)\n- Do it.`, prs: [{ repo: "test-org/test-repo", title: "A" }, { repo: "test-org/other-repo", title: "B" }] }),
    ]) {
      await withPlannerRun(FOLLOWUP, async (id) => {
        expect(submitPlan(id, changed)).toEqual({ ok: true });
        const error = errorOf(submitFollowupVerdict(id, { verdict: "plan_amendment" }));
        expect(error).toContain(message);
        expect(error).toContain("Report verdict \"design_change\" instead");
        expect(getFollowupVerdict(id)).toBeNull();
      });
    }
  });

  it("re-checks a plan saved after an amendment verdict", async () => {
    await withPlannerRun(FOLLOWUP, async (id) => {
      expect(submitPlan(id, twoPrs())).toEqual({ ok: true });
      expect(submitFollowupVerdict(id, { verdict: "plan_amendment" })).toEqual({ ok: true });
      expect(errorOf(submitPlan(id, plan()))).toContain("This changes the PR set");
      expect((getSubmission(id) as PlanSubmission).prs).toHaveLength(2);
    });
  });

  it("refuses an affected PR that is not open on the issue, and an unknown verdict", async () => {
    await withPlannerRun(FOLLOWUP, async (id) => {
      expect(submitPlan(id, twoPrs())).toEqual({ ok: true });
      expect(errorOf(submitFollowupVerdict(id, { verdict: "plan_amendment", affected_prs: [{ repo: "test-org/test-repo", number: 6 }] }))).toContain("not one of this issue's open step PRs: test-org/test-repo#5, test-org/other-repo#9");
      expect(errorOf(submitFollowupVerdict(id, { verdict: "maybe" }))).toContain("`verdict` must be");
      expect(getRunRejections(id).count).toBe(2);
    });
  });

  describe("design_change", () => {
    const REQUIREMENTS = {
      title: "Move images to the new registry",
      kind: "feature",
      context: "The operator moved prod images.",
      requirement: "Images are pulled from the new registry.",
      acceptanceCriteria: ["Pods pull from the new registry."],
      outOfScope: [],
    };
    // A revised plan with three PRs where the old one had two.
    const THREE_STEP = plan({
      plan: "### PR 1: A\na\n\n### PR 2: B\nb\n\n### PR 3: C\nc",
      prs: [{ repo: "test-org/test-repo", title: "A" }, { repo: "test-org/other-repo", title: "B" }, { repo: "test-org/test-repo", title: "C" }],
    });
    const FATES = [
      { repo: "test-org/test-repo", number: 5, fate: "rework", position: 3 },
      { repo: "test-org/other-repo", number: 9, fate: "close" },
    ];

    it("accepts a changed PR set with the revised requirements and one fate per open PR", async () => {
      await withPlannerRun(FOLLOWUP, async (id) => {
        expect(submitPlan(id, THREE_STEP)).toEqual({ ok: true });
        expect(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates: FATES })).toEqual({ ok: true });
        expect(getFollowupVerdict(id)).toEqual({
          verdict: "design_change",
          affectedPrs: [],
          requirements: REQUIREMENTS,
          prFates: [
            { repo: "test-org/test-repo", number: 5, fate: "rework", position: 3 },
            { repo: "test-org/other-repo", number: 9, fate: "close", position: null },
          ],
        });
      });
    });

    it("needs the revised plan first and a complete requirements record", async () => {
      await withPlannerRun(FOLLOWUP, async (id) => {
        expect(errorOf(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates: FATES }))).toContain("call claws_save_plan first");
        expect(submitPlan(id, THREE_STEP)).toEqual({ ok: true });
        expect(errorOf(submitFollowupVerdict(id, { verdict: "design_change", requirements: { ...REQUIREMENTS, acceptanceCriteria: [] }, pr_fates: FATES }))).toContain("`requirements` must be the complete revised requirements record");
        expect(getFollowupVerdict(id)).toBeNull();
      });
    });

    it("rejects a missing, duplicate or misplaced fate", async () => {
      await withPlannerRun(FOLLOWUP, async (id) => {
        expect(submitPlan(id, THREE_STEP)).toEqual({ ok: true });
        const verdict = (pr_fates: unknown) => errorOf(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates }));
        expect(verdict([FATES[0]])).toContain("missing: test-org/other-repo#9");
        expect(verdict([...FATES, FATES[1]])).toContain("more than once");
        expect(verdict([{ ...FATES[0], position: undefined }, FATES[1]])).toContain("needs `position`");
        expect(verdict([{ ...FATES[0], position: 2 }, FATES[1]])).toContain("in test-org/other-repo");
        expect(verdict([{ ...FATES[0], position: 7 }, FATES[1]])).toContain("not a PR step");
        expect(verdict([FATES[0], { repo: "test-org/other-repo", number: 9, fate: "keep", position: 2 }, { repo: "test-org/test-repo", number: 4, fate: "keep", position: 1 }])).toContain("not one of this issue's step PRs");
        expect(getFollowupVerdict(id)).toBeNull();
        expect(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates: [{ ...FATES[0], fate: "keep", position: 1 }, { repo: "test-org/other-repo", number: 9, fate: "keep", position: 2 }] })).toEqual({ ok: true });
      });
    });

    it("lets a merged PR of the stored list be kept, never closed or reworked", async () => {
      await withPlannerRun({ ...FOLLOWUP, linkedPrs: [{ repo: "test-org/test-repo", number: 3 }] }, async (id) => {
        expect(submitPlan(id, THREE_STEP)).toEqual({ ok: true });
        expect(errorOf(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates: [...FATES, { repo: "test-org/test-repo", number: 3, fate: "close" }] }))).toContain("no longer open");
        expect(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates: [...FATES, { repo: "test-org/test-repo", number: 3, fate: "keep", position: 1 }] })).toEqual({ ok: true });
      });
    });

    it("re-checks the fates against a plan saved after the verdict", async () => {
      await withPlannerRun(FOLLOWUP, async (id) => {
        expect(submitPlan(id, THREE_STEP)).toEqual({ ok: true });
        expect(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates: FATES })).toEqual({ ok: true });
        // Step 3 no longer exists, so the rework fate no longer fits.
        expect(errorOf(submitPlan(id, twoPrs()))).toContain("call claws_followup_verdict again");
        expect((getSubmission(id) as PlanSubmission).prs).toHaveLength(3);
      });
    });
  });

  it("refuses an amendment with no stored PR list", async () => {
    await withPlannerRun({ ...FOLLOWUP, plannedPrs: [] }, async (id) => {
      expect(submitPlan(id, twoPrs())).toEqual({ ok: true });
      expect(errorOf(submitFollowupVerdict(id, { verdict: "plan_amendment" }))).toContain("no stored PR list");
    });
  });

  it("is only available in the followup stage, which reports no outcome", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitFollowupVerdict(id, { verdict: "answered" }))).toContain("only available when answering follow-up comments");
    });
    await withPlannerRun(FOLLOWUP, async (id) => {
      expect(errorOf(submitOutcome(id, { outcome: "blocked", explanation: "x" }))).toContain("cannot report an outcome");
    });
    expect(errorOf(submitFollowupVerdict("no-such-run", { verdict: "answered" }))).toBe(NO_SUCH_PLANNER_RUN);
  });
});
