/**
 * The per-issue model plan (docs/model-selection.md).
 *
 * One optional `{provider, tier}` cell per pipeline phase, stored against an
 * issue in `issue_model_plan`. A cell is either `explicit` (an operator set it
 * on the dashboard) or `suggested` (the planner wrote it through the plan's
 * `**Model plan:**` line). {@link resolveModelPlanCell} is the one place a phase's
 * provider and tier are decided: it layers the cell over every older input —
 * plan prose, the PR `review-model:` marker, `classifyComplexity()`,
 * `reviewModelTier`, and the `Use *` / `Plan: Deep` labels — so the dashboard can
 * show which of them won.
 *
 * A leaf over `db.ts`, `config.ts` and `model-selector.ts`; nothing here
 * imports an agent. The phase/provider vocabulary lives in `model-plan-phases.ts`
 * and is re-exported here.
 */

import * as db from "./db.js";
import { LABELS } from "./config.js";
import { isClawsIssueId, type IssueRef } from "./issue-id.js";
import type { Provider } from "./plan-parser.js";
import {
  getEnabledProviderWeights,
  getModel,
  getProviderSelectionForItem,
  normalizeTier,
  type ModelTier,
  type ProviderWeight,
} from "./model-selector.js";
import {
  MODEL_PLAN_PHASES,
  isModelPlanPhase,
  isModelPlanProvider,
  type ModelPlanCell,
  type ModelPlanPhase,
} from "./model-plan-phases.js";

export {
  MODEL_PLAN_PHASES,
  MODEL_PLAN_PROVIDERS,
  isModelPlanPhase,
  isModelPlanProvider,
  type ModelPlanCell,
  type ModelPlanPhase,
} from "./model-plan-phases.js";

/** Operator-facing phase names, for the issue page and the board. */
export const MODEL_PLAN_PHASE_LABELS: Readonly<Record<ModelPlanPhase, string>> = {
  "requirements": "Requirements",
  "plan": "Plan",
  "plan-refine": "Plan refinement",
  "implement": "Implement",
  "review": "Review",
  "ci-fix": "CI fix",
  "review-address": "Address review",
};

/** Short phase names for the board card's one-line summary. */
const PHASE_SHORT: Readonly<Record<ModelPlanPhase, string>> = {
  "requirements": "req",
  "plan": "plan",
  "plan-refine": "refine",
  "implement": "impl",
  "review": "review",
  "ci-fix": "ci",
  "review-address": "address",
};

/**
 * The tier a phase runs on when nothing else names one. `undefined` means the
 * caller's own legacy source (plan prose, PR marker, `classifyComplexity`,
 * `reviewModelTier`) supplies it.
 */
export const PHASE_DEFAULT_TIER: Readonly<Record<ModelPlanPhase, ModelTier | undefined>> = {
  "requirements": "sonnet",
  "plan": "fable",
  "plan-refine": "opus",
  "implement": undefined,
  "review": undefined,
  "ci-fix": undefined,
  "review-address": undefined,
};

/**
 * The provider a phase prefers when no cell or label names one. Requirements
 * and planning stay on Claude; every other phase takes the weighted draw. A default is a
 * preference, never a pin — `runClaude` may still fall back to another
 * provider when it fails.
 */
export const PHASE_DEFAULT_PROVIDER: Readonly<Record<ModelPlanPhase, Provider | undefined>> = {
  "requirements": "claude",
  "plan": "claude",
  "plan-refine": "claude",
  "implement": undefined,
  "review": undefined,
  "ci-fix": undefined,
  "review-address": undefined,
};

/** Tier used when a phase has no default and its caller supplied no fallback. */
const LAST_RESORT_TIER: ModelTier = "sonnet";

export type ModelPlanSource = "explicit" | "suggested" | "plan-prose" | "label" | "default";

/** Highest first — the order {@link resolveModelPlanCell} consults its inputs in. */
const SOURCE_RANK: readonly ModelPlanSource[] = ["explicit", "suggested", "plan-prose", "label", "default"];

export interface ModelPlanFallback {
  /** The caller's legacy tier: plan prose, PR marker, `classifyComplexity`, `REVIEW_MODEL_TIER`. */
  tier?: ModelTier;
  /** How to attribute `tier`; `plan-prose` unless it came from a label (`Plan: Deep`). */
  tierSource?: "plan-prose" | "label";
  provider?: Provider;
  /** The item's labels, for the `Use Claude` / `Use Codex` / `Use OpenCode` override. */
  labels?: ReadonlyArray<{ name: string }>;
  requiresMcp?: boolean;
}

export interface ResolvedModelPlanCell {
  provider: Provider;
  tier: ModelTier;
  /** `getModel(tier, provider)`. */
  model: string;
  /** True when a cell or label named the provider, so `runClaude` must not fall back. */
  strictProvider: boolean;
  eligibleProviders: ReadonlyArray<ProviderWeight>;
  /** Why a named provider was not honoured, for the "Models used" attribution. */
  overrideIgnoredReason?: string;
  /** The higher-precedence of {@link tierSource} and {@link providerSource}. */
  source: ModelPlanSource;
  tierSource: ModelPlanSource;
  providerSource: ModelPlanSource;
}

interface StoredCell {
  provider: Provider | null;
  tier: ModelTier | null;
  source: "explicit" | "suggested";
}

/**
 * Stored rows as validated cells, keyed by phase; anything unrecognised is dropped.
 *
 * A native issue's cells live under its primary repo, whichever repo the
 * caller acts in: a multi-repo issue's PR in another of its repos must read
 * the same cells the issue page wrote. The primary repo is the sorted-first
 * of the issue's repos — `primaryRepo` in `claws-issues.ts`, which this leaf
 * does not import.
 */
async function loadCells(repo: string, ref: IssueRef): Promise<Map<ModelPlanPhase, StoredCell>> {
  const out = new Map<ModelPlanPhase, StoredCell>();
  const storageRepo = isClawsIssueId(ref) ? ([...(await db.getClawsIssue(ref))?.repos ?? []].sort()[0] ?? repo) : repo;
  for (const row of await db.getIssueModelPlanRows(storageRepo, ref)) {
    if (!isModelPlanPhase(row.phase)) continue;
    if (row.source !== "explicit" && row.source !== "suggested") continue;
    const provider = row.provider && isModelPlanProvider(row.provider) ? row.provider : null;
    const tier = row.tier ? normalizeTier(row.tier) : null;
    if (!provider && !tier) continue;
    out.set(row.phase, { provider, tier, source: row.source });
  }
  return out;
}

/**
 * Decision 7's guardrail: `fable` outside fresh planning is an operator's call.
 * A planner-suggested `fable` cell is honoured only for `plan`; everywhere else
 * it is clamped to `opus`. The same clamp covers a `plan-prose` fallback — plan
 * prose, a PR's `review-model:` marker, a reviewer's `recommended-model:`
 * marker — which is agent-written or PR-author-editable text, so it must not
 * be able to spend the top tier either. An explicit cell and the `Plan: Deep`
 * label (`tierSource: "label"`, which only names `fable` for the planning
 * phases) are both operator-set and pass through.
 */
function clampTier(phase: ModelPlanPhase, tier: ModelTier | null, source: ModelPlanSource): ModelTier | null {
  if (tier === "fable" && phase !== "plan" && (source === "suggested" || source === "plan-prose")) return "opus";
  return tier;
}

function clampSuggestedTier(phase: ModelPlanPhase, cell: StoredCell): ModelTier | null {
  return clampTier(phase, cell.tier, cell.source);
}

function higherSource(a: ModelPlanSource, b: ModelPlanSource): ModelPlanSource {
  return SOURCE_RANK.indexOf(a) <= SOURCE_RANK.indexOf(b) ? a : b;
}

function resolveTier(phase: ModelPlanPhase, cell: StoredCell | undefined, fallback: ModelPlanFallback): { tier: ModelTier; source: ModelPlanSource } {
  const cellTier = cell ? clampSuggestedTier(phase, cell) : null;
  if (cell && cellTier) return { tier: cellTier, source: cell.source };
  if (fallback.tier) {
    const source = fallback.tierSource ?? "plan-prose";
    return { tier: clampTier(phase, fallback.tier, source) ?? fallback.tier, source };
  }
  return { tier: PHASE_DEFAULT_TIER[phase] ?? LAST_RESORT_TIER, source: "default" };
}

type ProviderChoice = Omit<ResolvedModelPlanCell, "tier" | "model" | "source" | "tierSource">;

function resolveProvider(
  phase: ModelPlanPhase,
  cell: StoredCell | undefined,
  fallback: ModelPlanFallback,
  random?: () => number,
): ProviderChoice {
  const pool = getEnabledProviderWeights();
  let ignored: string | undefined;
  // A cell pins its provider for the whole run, exactly like a `Use *` label —
  // but only when that provider can actually run.
  if (cell?.provider) {
    const pinned = pool.filter(({ provider }) => provider === cell.provider);
    if (pinned.length > 0) {
      return { provider: cell.provider, strictProvider: true, eligibleProviders: pinned, providerSource: cell.source };
    }
    ignored = `model plan provider "${cell.provider}" ignored — provider is disabled or has non-positive weight`;
  }
  if (fallback.provider && pool.some(({ provider }) => provider === fallback.provider)) {
    return { provider: fallback.provider, strictProvider: false, eligibleProviders: pool, providerSource: "plan-prose", ...(ignored ? { overrideIgnoredReason: ignored } : {}) };
  }
  const selection = getProviderSelectionForItem(fallback.labels ?? [], { requiresMcp: fallback.requiresMcp, random });
  const reason = ignored ?? selection.overrideIgnoredReason;
  if (selection.strictProvider) {
    return { ...selection, providerSource: "label", ...(reason ? { overrideIgnoredReason: reason } : {}) };
  }
  const preferred = PHASE_DEFAULT_PROVIDER[phase];
  if (preferred && pool.some(({ provider }) => provider === preferred)) {
    return { provider: preferred, strictProvider: false, eligibleProviders: pool, providerSource: "default", ...(reason ? { overrideIgnoredReason: reason } : {}) };
  }
  return { ...selection, providerSource: "default", ...(reason ? { overrideIgnoredReason: reason } : {}) };
}

/**
 * The provider and tier a phase runs on for one issue.
 *
 * Precedence, highest first: explicit cell → suggested cell (with the fable
 * clamp) → `fallback.tier`/`fallback.provider` (same clamp unless the tier
 * came from a label) → a `Use *` label → the phase default → the weighted
 * provider draw. Tier and provider resolve
 * independently, so an explicit tier-only cell still lets a label pick the
 * provider.
 *
 * `ref` is null for work with no linked issue — a Dependabot or hand-rolled PR —
 * which then resolves exactly as it did before model plans existed.
 */
export async function resolveModelPlanCell(
  repo: string,
  ref: IssueRef | null,
  phase: ModelPlanPhase,
  fallback: ModelPlanFallback = {},
  options?: { random?: () => number },
): Promise<ResolvedModelPlanCell> {
  const cells = ref === null ? new Map<ModelPlanPhase, StoredCell>() : await loadCells(repo, ref);
  const cell = cells.get(phase);
  const { tier, source: tierSource } = resolveTier(phase, cell, fallback);
  const choice = resolveProvider(phase, cell, fallback, options?.random);
  return {
    ...choice,
    tier,
    model: getModel(tier, choice.provider),
    tierSource,
    source: higherSource(tierSource, choice.providerSource),
  };
}

/** One row of the issue page's model-plan grid. */
export interface ModelPlanView {
  phase: ModelPlanPhase;
  /**
   * The operator's explicit cell, for the form's selects; null = default. A
   * suggested cell never fills these, so saving the form cannot promote a
   * planner suggestion to an explicit choice.
   */
  cellProvider: Provider | null;
  cellTier: ModelTier | null;
  /** The planner's suggested cell (tier after the fable clamp), shown beside the select; null = none. */
  suggestedProvider: Provider | null;
  suggestedTier: ModelTier | null;
  /** What the phase resolves to without running an agent; null = decided at run time. */
  provider: Provider | null;
  tier: ModelTier | null;
  /** `getModel(tier, provider)`, or null when either half is decided at run time. */
  resolvedModel: string | null;
  source: ModelPlanSource;
}

/**
 * The model plan as the dashboard shows it. Unlike {@link resolveModelPlanCell}
 * this never draws: a phase whose provider would be a weighted draw, or whose
 * tier comes from the agent's own legacy source at run time, reports null for
 * that half rather than a value that could differ from what actually runs.
 */
export async function describeModelPlan(
  repo: string | null,
  ref: IssueRef,
  labels: ReadonlyArray<{ name: string }>,
): Promise<ModelPlanView[]> {
  const cells = repo === null ? new Map<ModelPlanPhase, StoredCell>() : await loadCells(repo, ref);
  const pool = getEnabledProviderWeights();
  const inPool = (p: Provider | null | undefined): p is Provider => !!p && pool.some(({ provider }) => provider === p);
  let labelProvider: Provider | undefined;
  try {
    const selection = getProviderSelectionForItem(labels, { random: () => 0 });
    if (selection.strictProvider) labelProvider = selection.provider;
  } catch {
    // No enabled provider: nothing can run, and every provider shows as undecided.
  }
  return MODEL_PLAN_PHASES.map((phase) => {
    const cell = cells.get(phase);
    const cellTier = cell ? clampSuggestedTier(phase, cell) : null;
    const deep = phase === "requirements" || phase === "plan" || phase === "plan-refine" ? labels.some((l) => l.name === LABELS.planDeep) : false;
    let tier: ModelTier | null;
    let tierSource: ModelPlanSource;
    if (cell && cellTier) { tier = cellTier; tierSource = cell.source; }
    else if (deep) { tier = "fable"; tierSource = "label"; }
    else if (PHASE_DEFAULT_TIER[phase]) { tier = PHASE_DEFAULT_TIER[phase]!; tierSource = "default"; }
    else { tier = null; tierSource = "default"; }

    let provider: Provider | null;
    let providerSource: ModelPlanSource;
    if (cell && inPool(cell.provider)) { provider = cell.provider; providerSource = cell.source; }
    else if (labelProvider) { provider = labelProvider; providerSource = "label"; }
    else if (inPool(PHASE_DEFAULT_PROVIDER[phase])) { provider = PHASE_DEFAULT_PROVIDER[phase]!; providerSource = "default"; }
    else { provider = null; providerSource = "default"; }

    const explicit = cell?.source === "explicit";
    const suggested = cell?.source === "suggested";
    return {
      phase,
      cellProvider: explicit ? cell.provider : null,
      cellTier: explicit ? cell.tier : null,
      suggestedProvider: suggested ? cell.provider : null,
      suggestedTier: suggested ? cellTier : null,
      provider,
      tier,
      resolvedModel: provider && tier ? getModel(tier, provider) : null,
      source: higherSource(tierSource, providerSource),
    };
  });
}

/**
 * Replace the planner's suggestions for one issue. Phases the new plan no
 * longer suggests lose their suggested row; explicit rows are never touched.
 */
export async function setSuggestedPlan(repo: string, ref: IssueRef, cells: readonly ModelPlanCell[]): Promise<void> {
  const byPhase = new Map(cells.filter((c) => c.provider || c.tier).map((c) => [c.phase, c]));
  for (const phase of MODEL_PLAN_PHASES) {
    const cell = byPhase.get(phase);
    if (cell) {
      await db.upsertIssueModelPlanCell(repo, ref, phase, { provider: cell.provider, tier: cell.tier, source: "suggested" });
    } else {
      await db.deleteIssueModelPlanCell(repo, ref, phase, "suggested");
    }
  }
}

/**
 * Write operator-set cells. A cell with neither provider nor tier clears the
 * phase's explicit cell, so it falls back to the planner's suggestion or the
 * default — a suggested row is left alone; phases not listed are left as they
 * are.
 */
export async function setExplicitPlan(repo: string, ref: IssueRef, cells: readonly ModelPlanCell[]): Promise<void> {
  for (const cell of cells) {
    if (!cell.provider && !cell.tier) {
      await db.deleteIssueModelPlanCell(repo, ref, cell.phase, "explicit");
    } else {
      await db.upsertIssueModelPlanCell(repo, ref, cell.phase, { provider: cell.provider, tier: cell.tier, source: "explicit" });
    }
  }
}

/**
 * Parse the issue forms' grid: `provider_<phase>` and `tier_<phase>` fields,
 * blank meaning default. Unknown values read as blank. Returns one cell per
 * phase, so a submitted form clears every phase the operator left blank.
 */
export function parseModelPlanForm(params: Readonly<Record<string, string | undefined>>): ModelPlanCell[] {
  return MODEL_PLAN_PHASES.map((phase) => {
    const rawProvider = (params[`provider_${phase}`] ?? "").trim();
    const rawTier = (params[`tier_${phase}`] ?? "").trim();
    return {
      phase,
      provider: isModelPlanProvider(rawProvider) ? rawProvider : null,
      tier: rawTier ? normalizeTier(rawTier) : null,
    };
  });
}

/** `plan: claude/fable · impl: codex/sonnet` — the board card's one-line summary of explicit cells. */
export function summarizeModelPlanCells(cells: ReadonlyArray<{ phase: string; provider: string | null; tier: string | null }>): string {
  return MODEL_PLAN_PHASES
    .map((phase) => cells.find((c) => c.phase === phase))
    .filter((c): c is { phase: string; provider: string | null; tier: string | null } => !!c && !!(c.provider || c.tier))
    .map((c) => `${PHASE_SHORT[c.phase as ModelPlanPhase]}: ${[c.provider, c.tier].filter(Boolean).join("/")}`)
    .join(" · ");
}
