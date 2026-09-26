import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    DB_PATH: ":memory:",
    DATABASE_URL: "",
    DATABASE_PASSWORD: "",
    CODEX_DEFAULT_MODEL: "gpt-5.5",
    CODEX_LIGHT_MODEL: "gpt-5.6-terra",
    CODEX_CHEAP_MODEL: "gpt-5.6-luna",
    REVIEW_MODEL_TIER: "sonnet",
    OPENCODE_BEST_MODEL: "openrouter/anthropic/claude-opus-4",
    OPENCODE_ADEQUATE_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
    OPENCODE_CHEAP_MODEL: "openrouter/google/gemini-2.5-flash",
    CLAUDE_CHEAP_MODEL: "claude-haiku-4-5-20251001",
    CLAUDE_FABLE_MODEL: "fable",
    CODEX_FABLE_MODEL: "gpt-5.5",
    OPENCODE_FABLE_MODEL: "openrouter/anthropic/claude-opus-4",
    AI_PROVIDER_NAMES: ["claude", "codex", "opencode"] as const,
    AI_PROVIDERS: {
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 1 },
    } as Record<string, { enabled: boolean; weight: number }>,
    LABELS: { useCodex: "Use Codex", useClaude: "Use Claude", useOpenCode: "Use OpenCode", planDeep: "Plan: Deep" },
  },
}));
vi.mock("./config.js", () => mockConfig);
vi.mock("./log.js", () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("./codex-models.js", () => ({ getCodexModelCatalogue: vi.fn().mockResolvedValue(null) }));

import { initDb, closeDb, createClawsIssue, getIssueModelPlanRows, upsertIssueModelPlanCell } from "./db.js";
import {
  describeModelPlan,
  parseModelPlanForm,
  resolveModelPlanCell,
  setExplicitPlan,
  setSuggestedPlan,
  summarizeModelPlanCells,
} from "./model-plan.js";

const REPO = "org/repo";
const REF = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
/** Always draws the first enabled provider, so an undecided provider is claude. */
const first = { random: () => 0 };
/** Always draws the last enabled provider, so a weighted draw is visibly not claude. */
const last = { random: () => 0.99 };

describe("resolveModelPlanCell", () => {
  beforeEach(async () => {
    mockConfig.AI_PROVIDERS = {
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 1 },
    };
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("resolves fresh planning to claude/fable with no cells", async () => {
    const r = await resolveModelPlanCell(REPO, REF, "plan", {}, last);
    expect(r).toMatchObject({ provider: "claude", tier: "fable", model: "fable", strictProvider: false, source: "default" });
    // A default provider is a preference, not a pin: runClaude may still fall back.
    expect(r.eligibleProviders.map((p) => p.provider)).toEqual(["claude", "codex", "opencode"]);
  });

  it("resolves requirements to claude/sonnet with no cells", async () => {
    const r = await resolveModelPlanCell(REPO, REF, "requirements", {}, last);
    expect(r).toMatchObject({ provider: "claude", tier: "sonnet", model: "sonnet", source: "default" });
  });

  it("resolves requirements to fable under the Plan: Deep label fallback", async () => {
    const r = await resolveModelPlanCell(REPO, REF, "requirements", { tier: "fable", tierSource: "label" }, last);
    expect(r).toMatchObject({ provider: "claude", tier: "fable", source: "label" });
  });

  it("resolves plan refinement to claude/opus with no cells", async () => {
    const r = await resolveModelPlanCell(REPO, REF, "plan-refine", {}, last);
    expect(r).toMatchObject({ provider: "claude", tier: "opus", model: "opus", source: "default" });
  });

  it("falls back to sonnet on the weighted draw when a later phase has nothing else", async () => {
    const r = await resolveModelPlanCell(REPO, REF, "implement", {}, last);
    expect(r).toMatchObject({ provider: "opencode", tier: "sonnet", strictProvider: false, source: "default" });
  });

  it("applies explicit > suggested > plan prose > label > default", async () => {
    const labels = [{ name: "Use Codex" }];

    // Default only.
    expect(await resolveModelPlanCell(REPO, REF, "implement", {}, last)).toMatchObject({ tier: "sonnet", source: "default" });

    // A label names the provider and outranks the default.
    const byLabel = await resolveModelPlanCell(REPO, REF, "implement", { labels }, last);
    expect(byLabel).toMatchObject({ provider: "codex", strictProvider: true, providerSource: "label", source: "label" });

    // Plan prose supplies the tier and outranks the label for the overall source.
    const byProse = await resolveModelPlanCell(REPO, REF, "implement", { tier: "haiku", labels }, last);
    expect(byProse).toMatchObject({ provider: "codex", tier: "haiku", model: "gpt-5.6-luna", tierSource: "plan-prose", source: "plan-prose" });

    // A suggested cell beats the prose.
    await setSuggestedPlan(REPO, REF, [{ phase: "implement", provider: "opencode", tier: "opus" }]);
    const bySuggestion = await resolveModelPlanCell(REPO, REF, "implement", { tier: "haiku", labels }, last);
    expect(bySuggestion).toMatchObject({ provider: "opencode", tier: "opus", strictProvider: true, source: "suggested" });

    // An explicit cell beats the suggestion.
    await setExplicitPlan(REPO, REF, [{ phase: "implement", provider: "codex", tier: "haiku" }]);
    const byExplicit = await resolveModelPlanCell(REPO, REF, "implement", { tier: "opus", labels: [] }, last);
    expect(byExplicit).toMatchObject({ provider: "codex", tier: "haiku", model: "gpt-5.6-luna", strictProvider: true, source: "explicit" });
  });

  it("clamps a suggested fable cell to opus outside fresh planning", async () => {
    await setSuggestedPlan(REPO, REF, [
      { phase: "plan", provider: null, tier: "fable" },
      { phase: "implement", provider: "claude", tier: "fable" },
    ]);
    expect(await resolveModelPlanCell(REPO, REF, "implement", {}, first)).toMatchObject({ tier: "opus", model: "opus", source: "suggested" });
    expect(await resolveModelPlanCell(REPO, REF, "plan", {}, first)).toMatchObject({ tier: "fable", source: "suggested" });
  });

  it("clamps a fable fallback tier to opus outside fresh planning", async () => {
    // A PR body's `review-model: fable` or a reviewer's `recommended-model: fable`
    // reaches the resolver as a plan-prose fallback and must not spend the top tier.
    expect(await resolveModelPlanCell(REPO, REF, "review", { tier: "fable" }, first)).toMatchObject({ tier: "opus", model: "opus", source: "plan-prose" });
    expect(await resolveModelPlanCell(REPO, REF, "review-address", { tier: "fable", tierSource: "plan-prose" }, first)).toMatchObject({ tier: "opus", source: "plan-prose" });
    expect(await resolveModelPlanCell(REPO, null, "implement", { tier: "fable" }, first)).toMatchObject({ tier: "opus", source: "plan-prose" });
    // Fresh planning may still take fable from its caller.
    expect(await resolveModelPlanCell(REPO, REF, "plan", { tier: "fable" }, first)).toMatchObject({ tier: "fable", source: "plan-prose" });
    // `Plan: Deep` is operator-set, so a label-sourced fable on a re-plan passes through.
    expect(await resolveModelPlanCell(REPO, REF, "plan-refine", { tier: "fable", tierSource: "label" }, first)).toMatchObject({ tier: "fable", source: "label" });
  });

  it("reads a native issue's cells from its primary repo when a PR is in another of its repos", async () => {
    const id = await createClawsIssue({ title: "Multi-repo", authorLogin: "alice", repos: ["org/b-repo", "org/a-repo"] });
    await setExplicitPlan("org/a-repo", id, [{ phase: "review", provider: "codex", tier: "opus" }]);
    expect(await resolveModelPlanCell("org/b-repo", id, "review", {}, first)).toMatchObject({ provider: "codex", tier: "opus", source: "explicit" });
  });

  it("honours an explicit fable cell on a later phase", async () => {
    await setExplicitPlan(REPO, REF, [{ phase: "implement", provider: null, tier: "fable" }]);
    expect(await resolveModelPlanCell(REPO, REF, "implement", { tier: "sonnet" }, first)).toMatchObject({ tier: "fable", model: "fable", source: "explicit" });
  });

  it("falls back to the default once a cell is cleared", async () => {
    await setExplicitPlan(REPO, REF, [{ phase: "plan", provider: "codex", tier: "haiku" }]);
    expect(await resolveModelPlanCell(REPO, REF, "plan", {}, first)).toMatchObject({ provider: "codex", tier: "haiku", source: "explicit" });
    await setExplicitPlan(REPO, REF, [{ phase: "plan", provider: null, tier: null }]);
    expect(await getIssueModelPlanRows(REPO, REF)).toEqual([]);
  });

  it("leaves a suggested cell in place when an operator submits that phase blank", async () => {
    await setSuggestedPlan(REPO, REF, [{ phase: "review", provider: null, tier: "opus" }]);
    await setExplicitPlan(REPO, REF, [{ phase: "review", provider: null, tier: null }]);
    expect((await getIssueModelPlanRows(REPO, REF)).map((r) => [r.phase, r.tier, r.source])).toEqual([["review", "opus", "suggested"]]);
    expect(await resolveModelPlanCell(REPO, REF, "plan", {}, last)).toMatchObject({ provider: "claude", tier: "fable", source: "default" });
  });

  it("ignores a cell's provider when that provider is disabled, and says so", async () => {
    mockConfig.AI_PROVIDERS = { ...mockConfig.AI_PROVIDERS, codex: { enabled: false, weight: 2 } };
    await setExplicitPlan(REPO, REF, [{ phase: "implement", provider: "codex", tier: "haiku" }]);
    const r = await resolveModelPlanCell(REPO, REF, "implement", {}, first);
    expect(r).toMatchObject({ provider: "claude", tier: "haiku", strictProvider: false });
    expect(r.overrideIgnoredReason).toContain("codex");
  });

  it("reads no cells when there is no linked issue", async () => {
    await setExplicitPlan(REPO, REF, [{ phase: "review", provider: "codex", tier: "opus" }]);
    expect(await resolveModelPlanCell(REPO, null, "review", { tier: "sonnet" }, first)).toMatchObject({ provider: "claude", tier: "sonnet", source: "plan-prose" });
  });
});

describe("setSuggestedPlan", () => {
  beforeEach(async () => { await initDb(); });
  afterEach(async () => { await closeDb(); });

  it("replaces earlier suggestions and never touches explicit cells", async () => {
    await setExplicitPlan(REPO, 42, [{ phase: "review", provider: "codex", tier: null }]);
    await setSuggestedPlan(REPO, 42, [{ phase: "implement", provider: null, tier: "opus" }, { phase: "review", provider: null, tier: "sonnet" }]);
    await setSuggestedPlan(REPO, 42, [{ phase: "ci-fix", provider: null, tier: "haiku" }]);
    const rows = (await getIssueModelPlanRows(REPO, 42)).map((r) => [r.phase, r.provider, r.tier, r.source]).sort();
    expect(rows).toEqual([
      ["ci-fix", null, "haiku", "suggested"],
      ["review", "codex", null, "explicit"],
    ]);
  });
});

describe("describeModelPlan", () => {
  beforeEach(async () => { await initDb(); });
  afterEach(async () => { await closeDb(); });

  it("reports the stored cells and what they resolve to, without drawing a provider", async () => {
    await upsertIssueModelPlanCell(REPO, REF, "implement", { provider: "codex", tier: "haiku", source: "explicit" });
    await upsertIssueModelPlanCell(REPO, REF, "review", { provider: null, tier: "fable", source: "suggested" });
    const view = await describeModelPlan(REPO, REF, []);
    const by = Object.fromEntries(view.map((v) => [v.phase, v]));
    expect(by["plan"]).toMatchObject({ provider: "claude", tier: "fable", resolvedModel: "fable", source: "default" });
    expect(by["implement"]).toMatchObject({ cellProvider: "codex", cellTier: "haiku", resolvedModel: "gpt-5.6-luna", source: "explicit" });
    // Clamped for display too, and the provider is still an undecided draw.
    expect(by["review"]).toMatchObject({ tier: "opus", provider: null, resolvedModel: null, source: "suggested" });
    expect(by["ci-fix"]).toMatchObject({ provider: null, tier: null, resolvedModel: null, source: "default" });
  });

  it("keeps a suggested cell out of the form's selects, reporting it (clamped) as a suggestion", async () => {
    await upsertIssueModelPlanCell(REPO, REF, "implement", { provider: "claude", tier: "fable", source: "suggested" });
    const view = await describeModelPlan(REPO, REF, []);
    expect(view.find((v) => v.phase === "implement")).toMatchObject({
      cellProvider: null, cellTier: null, suggestedProvider: "claude", suggestedTier: "opus", tier: "opus", source: "suggested",
    });
  });

  it("shows Plan: Deep as the planning tier's source", async () => {
    const view = await describeModelPlan(null, REF, [{ name: "Plan: Deep" }, { name: "Use Codex" }]);
    expect(view.find((v) => v.phase === "plan-refine")).toMatchObject({ provider: "codex", tier: "fable", resolvedModel: "gpt-5.5", source: "label" });
    expect(view.find((v) => v.phase === "requirements")).toMatchObject({ tier: "fable", source: "label" });
  });
});

describe("parseModelPlanForm", () => {
  it("reads one cell per phase, blank or unknown values as default", () => {
    const cells = parseModelPlanForm({ provider_implement: "codex", tier_implement: "cheap", tier_review: "opus", provider_plan: "gpt", tier_plan: "huge" });
    expect(cells).toHaveLength(7);
    expect(cells.find((c) => c.phase === "implement")).toEqual({ phase: "implement", provider: "codex", tier: "haiku" });
    expect(cells.find((c) => c.phase === "review")).toEqual({ phase: "review", provider: null, tier: "opus" });
    expect(cells.find((c) => c.phase === "plan")).toEqual({ phase: "plan", provider: null, tier: null });
  });
});

describe("summarizeModelPlanCells", () => {
  it("lists cells in phase order", () => {
    expect(summarizeModelPlanCells([
      { phase: "implement", provider: "codex", tier: "sonnet" },
      { phase: "plan", provider: "claude", tier: "fable" },
      { phase: "review", provider: null, tier: "opus" },
    ])).toBe("plan: claude/fable · impl: codex/sonnet · review: opus");
    expect(summarizeModelPlanCells([])).toBe("");
  });
});
