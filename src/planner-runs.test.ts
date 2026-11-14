import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  withPlannerRun,
  submitPlan,
  submitOutcome,
  submitStepBack,
  submitFollowupVerdict,
  submitKeepPlan,
  getKeepPlan,
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
};

const THREE = "### PR 1: A\na\n\n### PR 2: B\nb\n\n### PR 3: C\nc";

function threePrs(...deps: unknown[]): Record<string, unknown>[] {
  return ["a", "b", "c"].map((title, i) => ({
    repo: "test-org/test-repo",
    title,
    ...(deps[i] !== undefined ? { depends_on: deps[i] } : {}),
  }));
}

/** A valid opening section naming every repository in `prs`. */
function whatChanges(prs: readonly unknown[]): string {
  const repos = [...new Set(prs.map((p) => (p as { repo: string }).repo))];
  return `### What changes\nOnce approved, the work lands as pull requests in ${repos.join(" and ")}.\n\n`;
}

/** A plan payload; the plan text gets a valid What changes section unless it has its own or `raw` is set. */
function plan(overrides: Record<string, unknown> = {}, raw = false): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    plan: "### Requirement\nDo it.",
    prs: [{ repo: "test-org/test-repo", title: "Do it" }],
    implementation_model: "sonnet",
    review_model: "opus",
    ...overrides,
  };
  if (!raw && typeof merged["plan"] === "string" && !/^###\s+What changes/m.test(merged["plan"])) {
    merged["plan"] = whatChanges(merged["prs"] as unknown[]) + merged["plan"].replace(/^## Implementation Plan\s*/, "");
  }
  return merged;
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
        plan: `${whatChanges([{ repo: "TEST-ORG/Test-Repo" }]).trimEnd()}\n\n### Requirement\nDo it.`,
        prs: [{ repo: "test-org/test-repo", title: "t".repeat(MAX_PLANNED_PR_TITLE_CHARS), dependsOn: null, kind: "pr", manualAction: null }],
        implementationModel: "haiku",
        reviewModel: "sonnet",
        targetPr: 12,
        response: null,
      });
    });
  });

  describe("What changes section", () => {
    const body = "Do it.";
    const check = async (text: string, extra: Record<string, unknown> = {}, stage: "plan" | "followup" = "plan") =>
      withPlannerRun({ ...RUN, stage, allowedRepos: ["test-org/test-repo", "test-org/other-repo"] }, async (id) => submitPlan(id, plan({ plan: text, ...extra }, true)));

    it("rejects a plan with no section, naming the fix", async () => {
      expect(errorOf(await check("### Requirement\nDo it."))).toContain('must start with a "### What changes" section');
    });
    it("rejects Decisions first", async () => {
      expect(errorOf(await check("### Decisions\n1. x\n\n### What changes\ntest-repo"))).toContain("must start with");
    });
    it("rejects text before the section", async () => {
      expect(errorOf(await check("Overview text.\n\n### What changes\ntest-repo gets a PR."))).toContain("must start with");
    });
    it("rejects an empty section", async () => {
      expect(errorOf(await check("### What changes\n\n### Decisions\n1. x"))).toContain("must start with");
    });
    it("rejects backticks", async () => {
      expect(errorOf(await check("### What changes\nChanges `foo()` in test-repo."))).toContain("backticks");
    });
    it("rejects a section over the limit", async () => {
      expect(errorOf(await check(`### What changes\ntest-repo ${"x".repeat(800)}`))).toContain("keep it to 800");
    });
    it("rejects a section that misses a PR repository", async () => {
      const prs = [{ repo: "test-org/test-repo", title: "A" }, { repo: "test-org/other-repo", title: "B" }];
      const text = "### What changes\ntest-repo gets a PR.\n\n### PR 1: A\na\n\n### PR 2: B\nb";
      expect(errorOf(await check(text, { prs }))).toContain("does not name repository test-org/other-repo");
    });
    it("accepts the bare repository name and the 'What will change' heading", async () => {
      expect(await check(`### What will change\n${body} test-repo gets one PR.`)).toEqual({ ok: true });
    });
    it("is not required for a followup amendment", async () => {
      expect(await check("### Requirement\nDo it.", {}, "followup")).toEqual({ ok: true });
    });
  });

  it("keeps the last valid call", async () => {
    await withPlannerRun(RUN, async (id) => {
      submitPlan(id, plan({ plan: "first" }));
      submitPlan(id, plan({ plan: "second" }));
      expect((getSubmission(id) as PlanSubmission).plan).toContain("second");
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

  it("accepts an addable managed repo in its canonical spelling and rejects an unknown one, naming both sets", async () => {
    await withPlannerRun({ ...RUN, allowedRepos: ["test-org/test-repo"], addableRepos: ["test-org/Infra"] }, async (id) => {
      const twoPRs = "### PR 1: one\nIn infra.\n### PR 2: two\nHere.";
      expect(submitPlan(id, plan({ plan: twoPRs, prs: [{ repo: "TEST-ORG/infra", title: "one" }, { repo: "test-org/test-repo", title: "two" }] }))).toEqual({ ok: true });
      expect(getSubmission(id)).toMatchObject({ prs: [{ repo: "test-org/Infra", title: "one" }, { repo: "test-org/test-repo", title: "two" }] });
      const error = errorOf(submitPlan(id, plan({ prs: [{ repo: "test-org/unknown", title: "x" }] })));
      expect(error).toContain("test-org/test-repo");
      expect(error).toContain("test-org/Infra");
    });
  });

  it("keeps the manual step in the issue's first allowed repo when PRs land in an addable repo", async () => {
    await withPlannerRun({ ...RUN, allowedRepos: ["test-org/test-repo"], addableRepos: ["test-org/infra"] }, async (id) => {
      expect(submitPlan(id, plan({ plan: "### PR 1: A\na\n\n### Manual actions (operator)\n1. Import the repo.", prs: [{ repo: "test-org/infra", title: "a" }] }))).toEqual({ ok: true });
      expect((getSubmission(id) as PlanSubmission).prs.map((p) => [p.repo, p.kind])).toEqual([["test-org/infra", "pr"], ["test-org/test-repo", "manual"]]);
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
    ["a malformed infra_changes", { prs: [{ repo: "test-org/test-repo", title: "a", infra_changes: { resources: [{ root: "tofu", address: "a.*.b", actions: ["change"] }] } }] }, "prs[1].infra_changes resources[1].address"],
    ["an infra_changes workflow file that is not a tofu workflow", { prs: [{ repo: "test-org/test-repo", title: "a", infra_changes: { resources: [], workflow_files: [".forgejo/workflows/ci.yml"] } }] }, "prs[1].infra_changes workflow_files[1]"],
    ["target_pr with 2 PRs and a manual step", { target_pr: 5, plan: "### PR 1: A\na\n\n### PR 2: B\nb\n\n### Manual actions\nm", prs: [{ repo: "test-org/test-repo", title: "a" }, { repo: "test-org/test-repo", title: "b" }] }, "this plan lists 2 PRs"],
  ])("rejects %s with a message", async (_label, overrides, message) => {
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitPlan(id, plan(overrides, (overrides as { plan?: string }).plan === "## Implementation Plan\n\n  ")))).toContain(message);
    });
  });

  it("carries a valid infra_changes declaration on the PR entry", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(submitPlan(id, plan({
        prs: [{ repo: "test-org/test-repo", title: "a", infra_changes: { resources: [{ root: "tofu", address: "hcloud_server.web", actions: ["replace"] }], workflow_files: [] } }],
      }))).toEqual({ ok: true });
      expect((getSubmission(id) as PlanSubmission).prs[0]!.infraChanges).toEqual({
        resources: [{ root: "tofu", address: "hcloud_server.web", actions: ["replace"] }],
        workflow_files: [],
      });
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

    const THREE_WITH_MANUAL = "### PR 1: A\na\n\n### PR 2: B\nb\n\n### PR 3: C\nc\n\n### Manual actions (operator)\n1. Import the repo and post its URL.";
    const prsOf = (...entries: Record<string, unknown>[]) => entries.map((e, i) => ({ repo: "test-org/test-repo", title: `t${i + 1}`, ...e }));

    it("places the manual step just before the first PR flagged after_manual_actions and remaps depends_on to positions", async () => {
      await withPlannerRun(RUN, async (id) => {
        expect(submitPlan(id, plan({
          plan: THREE_WITH_MANUAL,
          prs: prsOf({}, { after_manual_actions: true }, { depends_on: [1] }),
        }))).toEqual({ ok: true });
        expect((getSubmission(id) as PlanSubmission).prs.map((p) => [p.kind, p.title, p.dependsOn])).toEqual([
          ["pr", "t1", []],
          ["manual", "Manual actions (operator)", [1]],
          ["pr", "t2", [2]],
          ["pr", "t3", [1]],
        ]);
      });
    });

    describe("placed by the plan text (#clw_01M70G1VXV5MS5GAX1MQSC45TK)", () => {
      const AFTER_PR_1 = "### PR 1: A\na\n\n### Manual actions (operator) (after PR 1)\n1. Put the secret on the host.\n\n### PR 2: B\nb";

      it("inserts the step after PR k from its heading, with the next PR depending on it", async () => {
        await withPlannerRun(RUN, async (id) => {
          expect(submitPlan(id, plan({ plan: AFTER_PR_1, prs: prsOf({}, {}) }))).toEqual({ ok: true });
          expect((getSubmission(id) as PlanSubmission).prs.map((p) => [p.kind, p.title, p.dependsOn])).toEqual([
            ["pr", "t1", []],
            ["manual", "Manual actions (operator)", [1]],
            ["pr", "t2", [2]],
          ]);
        });
      });

      it("inserts the step before a PR whose header says (after manual)", async () => {
        const text = "### PR 1: A\na\n\n### PR 2: B (after manual)\nb\n\n### PR 3: C\nc\n\n### Manual actions (operator)\n1. Put the secret on the host.";
        await withPlannerRun(RUN, async (id) => {
          expect(submitPlan(id, plan({ plan: text, prs: prsOf({}, {}, {}) }))).toEqual({ ok: true });
          expect((getSubmission(id) as PlanSubmission).prs.map((p) => [p.kind, p.dependsOn])).toEqual([
            ["pr", []],
            ["manual", [1]],
            ["pr", [2]],
            ["pr", [3]],
          ]);
        });
      });

      it("accepts a flag that agrees with the heading and rejects one that does not", async () => {
        await withPlannerRun(RUN, async (id) => {
          expect(submitPlan(id, plan({ plan: AFTER_PR_1, prs: prsOf({}, { after_manual_actions: true }) }))).toEqual({ ok: true });
        });
        const three = "### PR 1: A\na\n\n### Manual actions (operator) (after PR 1)\n1. Put the secret on the host.\n\n### PR 2: B\nb\n\n### PR 3: C\nc";
        await withPlannerRun(RUN, async (id) => {
          const error = errorOf(submitPlan(id, plan({ plan: three, prs: prsOf({}, {}, { after_manual_actions: true }) })));
          expect(error).toContain("(after PR 1)");
          expect(error).toContain("prs[3].after_manual_actions is set");
        });
      });

      it("rejects a heading naming a PR the plan does not have", async () => {
        const text = "### PR 1: A\na\n\n### PR 2: B\nb\n\n### Manual actions (operator) (after PR 5)\n1. Put the secret on the host.";
        await withPlannerRun(RUN, async (id) => {
          expect(errorOf(submitPlan(id, plan({ plan: text, prs: prsOf({}, {}) })))).toContain("names PR 5");
        });
      });
    });

    describe("circular manual_action_before_merge", () => {
      const TWO = "### PR 1: A\na\n\n### PR 2: B\nb";
      const MULTI = { ...RUN, repo: "o/fleet-infra", allowedRepos: ["o/fleet-infra", "o/home-assistant-config"] };

      it("rejects a hold naming the repo of a later PR that depends on it", async () => {
        await withPlannerRun(MULTI, async (id) => {
          const error = errorOf(submitPlan(id, plan({
            plan: TWO,
            prs: [
              { repo: "o/fleet-infra", title: "a", manual_action_before_merge: "Merge and OTA-flash the home-assistant-config ESPHome change" },
              { repo: "o/home-assistant-config", title: "b" },
            ],
          })));
          expect(error).toBe("prs[1].manual_action_before_merge names o/home-assistant-config, which PR 2 (step 2) delivers and which depends on PR 1 — reorder the steps or drop the hold");
        });
      });

      it("rejects a same-repo hold naming the dependent PR by number", async () => {
        await withPlannerRun(RUN, async (id) => {
          expect(errorOf(submitPlan(id, plan({ plan: TWO, prs: prsOf({ manual_action_before_merge: "Merge PR 2 first" }, {}) }))))
            .toContain("which PR 2 (step 2) delivers");
        });
      });

      it("accepts a hold when the named PR does not depend on it", async () => {
        await withPlannerRun(MULTI, async (id) => {
          expect(submitPlan(id, plan({
            plan: TWO,
            prs: [
              { repo: "o/fleet-infra", title: "a", manual_action_before_merge: "Add the home-assistant-config deploy key" },
              { repo: "o/home-assistant-config", title: "b", depends_on: [] },
            ],
          }))).toEqual({ ok: true });
        });
      });
    });

    it("rejects a manual step placement that would move a shipped entry", async () => {
      const repo = "test-org/test-repo";
      await withPlannerRun({ ...RUN, shippedEntries: [{ position: 1, repo, kind: "pr" }, { position: 2, repo, kind: "pr" }] }, async (id) => {
        expect(errorOf(submitPlan(id, plan({ plan: THREE_WITH_MANUAL, prs: prsOf({}, { after_manual_actions: true }, {}) }))))
          .toContain("step 2 (test-org/test-repo) has already shipped at position 2");
        expect(submitPlan(id, plan({ plan: THREE_WITH_MANUAL, prs: prsOf({}, {}, { after_manual_actions: true }) }))).toEqual({ ok: true });
      });
    });

    describe("primary repo not alphabetically first", () => {
      const MULTI = { ...RUN, repo: "o/zeta", allowedRepos: ["o/alpha", "o/zeta"] };
      const multiPrs = [
        { repo: "o/zeta", title: "a" },
        { repo: "o/zeta", title: "b", after_manual_actions: true },
        { repo: "o/alpha", title: "c" },
      ];

      it("refines when the shipped manual step is stored under the primary repo", async () => {
        const run = { ...MULTI, stage: "refine" as const, shippedEntries: [{ position: 1, repo: "o/zeta", kind: "pr" as const }, { position: 2, repo: "o/zeta", kind: "manual" as const }] };
        await withPlannerRun(run, async (id) => {
          expect(submitPlan(id, plan({ plan: THREE_WITH_MANUAL, prs: multiPrs }))).toEqual({ ok: true });
          const prs = (getSubmission(id) as PlanSubmission).prs;
          expect(prs[1]).toMatchObject({ kind: "manual", repo: "o/zeta" });
        });
      });

      it("still accepts a shipped manual step stored under the alphabetical repo", async () => {
        const run = { ...MULTI, stage: "refine" as const, shippedEntries: [{ position: 1, repo: "o/zeta", kind: "pr" as const }, { position: 2, repo: "o/alpha", kind: "manual" as const }] };
        await withPlannerRun(run, async (id) => {
          expect(submitPlan(id, plan({ plan: THREE_WITH_MANUAL, prs: multiPrs }))).toEqual({ ok: true });
        });
      });

      it("records a fresh manual step in the primary repo", async () => {
        await withPlannerRun(MULTI, async (id) => {
          expect(submitPlan(id, plan({ plan: THREE_WITH_MANUAL, prs: multiPrs }))).toEqual({ ok: true });
          const manual = (getSubmission(id) as PlanSubmission).prs.find((p) => p.kind === "manual");
          expect(manual?.repo).toBe("o/zeta");
        });
      });
    });

    it("rejects a plan that puts a different repo at a shipped PR position", async () => {
      const run = { ...RUN, repo: "o/zeta", allowedRepos: ["o/alpha", "o/zeta"], shippedEntries: [{ position: 1, repo: "o/alpha", kind: "pr" as const }] };
      await withPlannerRun(run, async (id) => {
        const err = errorOf(submitPlan(id, plan({ plan: "### PR 1: A\na\n\n### PR 2: B\nb", prs: [{ repo: "o/zeta", title: "A" }, { repo: "o/zeta", title: "B" }] })));
        expect(err).toContain("already shipped");
      });
    });

    describe("a shipped operator step is pinned", () => {
      const repo = "test-org/test-repo";
      const shipped = [{ position: 1, repo, kind: "pr" as const }, { position: 2, repo, kind: "manual" as const }];
      it.each([
        ["no flag", [{}, {}, {}]],
        ["flag on prs[3]", [{}, {}, { after_manual_actions: true }]],
      ])("keeps it at position 2 with %s", async (_l, entries) => {
        await withPlannerRun({ ...RUN, shippedEntries: shipped }, async (id) => {
          expect(submitPlan(id, plan({ plan: THREE_WITH_MANUAL, prs: prsOf(...entries) }))).toEqual({ ok: true });
          const out = (getSubmission(id) as PlanSubmission).prs;
          expect(out.map((p) => p.kind)).toEqual(["pr", "manual", "pr", "pr"]);
          expect(out[2].dependsOn).toContain(2);
        });
      });
      it("rejects a plan that drops the section", async () => {
        await withPlannerRun({ ...RUN, shippedEntries: shipped }, async (id) => {
          expect(errorOf(submitPlan(id, plan({ plan: "### PR 1: A\na\n\n### PR 2: B\nb\n\n### PR 3: C\nc", prs: prsOf({}, {}, {}) }))))
            .toContain("stays at position 2");
        });
      });
      it("rejects a plan too short to hold the step at its position", async () => {
        await withPlannerRun({ ...RUN, shippedEntries: [{ position: 1, repo, kind: "pr" }, { position: 2, repo, kind: "pr" }, { position: 3, repo, kind: "manual" }] }, async (id) => {
          expect(errorOf(submitPlan(id, plan({ plan: "### PR 1: A\na\n\n### Manual actions (operator)\n1. Import the repo and post its URL.", prs: prsOf({}) }))))
            .toContain("lists only 1 PRs");
        });
      });
    });

    it("puts a manual step needed by the first PR at position 1 and keeps explicit deps past it", async () => {
      await withPlannerRun(RUN, async (id) => {
        expect(submitPlan(id, plan({
          plan: THREE_WITH_MANUAL,
          prs: prsOf({ after_manual_actions: true }, { depends_on: [] }, { depends_on: [1, 2], after_manual_actions: true }),
        }))).toEqual({ ok: true });
        expect((getSubmission(id) as PlanSubmission).prs.map((p) => [p.kind, p.dependsOn])).toEqual([
          ["manual", []],
          ["pr", [1]],
          ["pr", []],
          ["pr", [1, 2, 3]],
        ]);
      });
    });

    it("rejects after_manual_actions when the plan has no manual-actions section", async () => {
      await withPlannerRun(RUN, async (id) => {
        expect(errorOf(submitPlan(id, plan({ plan: "### PR 1: A\na\n\n### PR 2: B\nb", prs: prsOf({}, { after_manual_actions: true }) }))))
          .toContain("prs[2].after_manual_actions is set but the plan has no `### Manual actions (operator)` section");
      });
    });

    it("rejects a non-boolean after_manual_actions", async () => {
      await withPlannerRun(RUN, async (id) => {
        expect(errorOf(submitPlan(id, plan({ plan: THREE_WITH_MANUAL, prs: prsOf({ after_manual_actions: "yes" }, {}, {}) }))))
          .toContain("prs[1].after_manual_actions must be true or false");
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

    const GERBER = "### PR 1: A\na\n\n### Manual actions (operator)\n- Look at each board page and `workflow_dispatch\` any pcb workflow missing a zip\n";

    it("rejects a manual section that is only verification or a CI re-run", async () => {
      await withPlannerRun(RUN, async (id) => {
        expect(errorOf(submitPlan(id, plan({ plan: GERBER })))).toContain("is only verification or a CI re-run");
      });
    });

    it("saves the same plan without the section and adds no manual step", async () => {
      await withPlannerRun(RUN, async (id) => {
        expect(submitPlan(id, plan({ plan: "### PR 1: A\na" }))).toEqual({ ok: true });
        expect((getSubmission(id) as PlanSubmission).prs.some((p) => p.kind === "manual")).toBe(false);
      });
    });

    it("rejects a verification-only manual_action_before_merge", async () => {
      await withPlannerRun(RUN, async (id) => {
        const err = errorOf(submitPlan(id, plan({ prs: [{ repo: "test-org/test-repo", title: "a", manual_action_before_merge: "Re-run CI on main" }] })));
        expect(err).toContain("prs[1].manual_action_before_merge");
        expect(err).toContain("is only verification or a CI re-run");
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
    });
  });

  it("requires a known no_change_kind for no_code_changes", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitOutcome(id, { outcome: "no_code_changes", explanation: "x" }))).toContain("already_resolved, transient, operator_task");
      expect(errorOf(submitOutcome(id, { outcome: "no_code_changes", no_change_kind: "later", explanation: "x" }))).toContain("no_change_kind");
      for (const k of ["already_resolved", "transient", "operator_task"]) {
        expect(submitOutcome(id, { outcome: "no_code_changes", no_change_kind: k, explanation: "x" })).toEqual({ ok: true });
        expect(getSubmission(id)).toMatchObject({ outcome: { kind: "no_code_changes", noChangeKind: k } });
      }
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

  it("rejects the retired transfer outcome, an unknown outcome and a missing explanation", async () => {
    await withPlannerRun(RUN, async (id) => {
      expect(errorOf(submitOutcome(id, { outcome: "transfer", transfer_to: "test-org/other-repo", explanation: "x" }))).toContain("unknown outcome");
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

  it("records a verify run's keep verdict, and lets the later of keep and save win", async () => {
    await withPlannerRun({ ...RUN, stage: "verify", allowOutcomes: false }, async (id) => {
      expect(errorOf(submitKeepPlan(id, {}))).toContain("`reason` is required");
      expect(errorOf(submitKeepPlan(id, { reason: "x".repeat(401) }))).toContain("keep it to 400");
      expect(submitKeepPlan(id, { reason: "Still fits." })).toEqual({ ok: true });
      expect(getKeepPlan(id)).toEqual({ reason: "Still fits." });
      expect(submitPlan(id, plan())).toEqual({ ok: true });
      expect(getKeepPlan(id)).toBeNull();
      expect(getSubmission(id)).toMatchObject({ kind: "plan" });
      expect(errorOf(submitPlan(id, plan({ response: "hi" })))).toContain("`response` is only accepted");
      expect(submitKeepPlan(id, { reason: "On reflection it fits." })).toEqual({ ok: true });
      expect(getSubmission(id)).toBeNull();
      expect(getKeepPlan(id)).toEqual({ reason: "On reflection it fits." });
      expect(errorOf(submitOutcome(id, { outcome: "blocked", explanation: "x" }))).toContain("cannot report an outcome");
    });
    await withPlannerRun({ ...RUN, stage: "refine" }, async (id) => {
      expect(errorOf(submitKeepPlan(id, { reason: "x" }))).toContain("only available when verifying");
    });
    expect(submitKeepPlan("nope", { reason: "x" })).toEqual({ ok: false, error: NO_SUCH_PLANNER_RUN });
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

  it("accepts an unchanged-set amendment when the stored manual step is under another repo", async () => {
    const run = {
      ...FOLLOWUP,
      repo: "o/zeta",
      allowedRepos: ["o/alpha", "o/zeta"],
      plannedPrs: [{ repo: "o/zeta", kind: "pr" as const }, { repo: "o/alpha", kind: "manual" as const }, { repo: "o/alpha", kind: "pr" as const }],
      openPrs: [],
    };
    await withPlannerRun(run, async (id) => {
      const amended = plan({
        plan: "### PR 1: A\na\n\n### Manual actions (operator)\n- Do it.\n\n### PR 2: B\nb",
        prs: [{ repo: "o/zeta", title: "A" }, { repo: "o/alpha", title: "B", after_manual_actions: true }],
      });
      expect(submitPlan(id, amended)).toEqual({ ok: true });
      expect(submitFollowupVerdict(id, { verdict: "plan_amendment" })).toEqual({ ok: true });
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

    // #clw_01M7BBKF0M3JX2BDJTZRYFNGB0: a re-plan must say what happens to every shipped step.
    it("rejects a design change that gives a merged step PR no fate", async () => {
      await withPlannerRun({ ...FOLLOWUP, linkedPrs: [{ repo: "test-org/test-repo", number: 3 }, { repo: "test-org/other-repo", number: 4 }] }, async (id) => {
        expect(submitPlan(id, THREE_STEP)).toEqual({ ok: true });
        const error = errorOf(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates: [...FATES, { repo: "test-org/test-repo", number: 3, fate: "keep", position: 1 }] }));
        expect(error).toContain("every merged step PR needs a fate — keep it at its step or retire it — missing: test-org/other-repo#4");
        expect(getFollowupVerdict(id)).toBeNull();
      });
    });

    it("accepts retire only for a merged step PR, with no position", async () => {
      await withPlannerRun({ ...FOLLOWUP, linkedPrs: [{ repo: "test-org/test-repo", number: 3 }] }, async (id) => {
        expect(submitPlan(id, THREE_STEP)).toEqual({ ok: true });
        expect(errorOf(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates: [{ ...FATES[0], fate: "retire" }, FATES[1], { repo: "test-org/test-repo", number: 3, fate: "retire" }] }))).toContain("only a merged PR can be retired");
        expect(submitFollowupVerdict(id, { verdict: "design_change", requirements: REQUIREMENTS, pr_fates: [...FATES, { repo: "test-org/test-repo", number: "#3", fate: "Retire", position: 2 }] })).toEqual({ ok: true });
        expect(getFollowupVerdict(id)?.prFates).toContainEqual({ repo: "test-org/test-repo", number: 3, fate: "retire", position: null });
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
