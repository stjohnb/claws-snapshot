import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  withPlannerRun,
  submitPlan,
  submitOutcome,
  submitStepBack,
  getSubmission,
  hasPlannerRun,
  getRunRejections,
  plannerRunHandler,
  NO_SUCH_PLANNER_RUN,
  MAX_PLANNED_PR_TITLE_CHARS,
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
        prs: [{ repo: "test-org/test-repo", title: "t".repeat(MAX_PLANNED_PR_TITLE_CHARS), dependsOn: null }],
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
  ])("rejects %s with a message", async (_label, overrides, message) => {
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitPlan(id, plan(overrides)))).toContain(message);
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
