/**
 * The model plan's vocabulary: its phases, the providers a cell may name, and
 * the cell shape (docs/model-selection.md). Kept free of runtime imports so the
 * pure text parser in `plan-parser.ts` can validate a `**Model plan:**` line
 * without loading `model-plan.ts` and, through it, `db.ts`.
 */

import type { Provider } from "./plan-parser.js";
import type { ModelTier } from "./model-selector.js";

export const MODEL_PLAN_PHASES = ["requirements", "plan", "plan-refine", "implement", "review", "ci-fix", "review-address"] as const;
export type ModelPlanPhase = (typeof MODEL_PLAN_PHASES)[number];

export const MODEL_PLAN_PROVIDERS: readonly Provider[] = ["claude", "codex", "opencode"];

export interface ModelPlanCell {
  phase: ModelPlanPhase;
  provider: Provider | null;
  tier: ModelTier | null;
}

export function isModelPlanPhase(value: string): value is ModelPlanPhase {
  return (MODEL_PLAN_PHASES as readonly string[]).includes(value);
}

export function isModelPlanProvider(value: string): value is Provider {
  return (MODEL_PLAN_PROVIDERS as readonly string[]).includes(value);
}
