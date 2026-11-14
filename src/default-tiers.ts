/**
 * The fleet-wide default tiers (docs/model-selection.md): the tier each
 * pipeline phase and each fixed-tier scheduled or background job runs on when
 * nothing more specific names one. One data table drives the config page, the
 * loader in `config.ts` and the env-var map, so they cannot disagree.
 *
 * A leaf with no runtime imports: `config.ts` reads it to build
 * `DEFAULT_MODEL_TIERS`, and `model-selector.ts` (which imports `config.ts`)
 * re-exports it, so putting the table there would be a load-order cycle.
 */

import type { ModelPlanPhase } from "./model-plan-phases.js";

/** Mirror of `ModelTier` in `model-selector.ts`, spelled out to keep this a leaf. */
export type DefaultTierName = "fable" | "opus" | "sonnet" | "haiku";

export type DefaultTierJobKey =
  | "doc-maintainer"
  | "idea-suggester"
  | "friction-retrospective"
  | "email-monitor"
  | "whatsapp-handler"
  | "public-snapshot-sync"
  | "escalation-reviewer"
  | "prompt-guard-judge";

export type DefaultTierKey = ModelPlanPhase | DefaultTierJobKey;

export type DefaultTierRow = Readonly<{
  key: DefaultTierKey;
  kind: "phase" | "job";
  label: string;
  description: string;
  shippedDefault: DefaultTierName;
  /** Env var that pins this row; absent means `CLAWS_DEFAULT_TIER_<KEY>` ({@link defaultTierEnvVar}). */
  envVar?: string;
  /** Top-level config key holding the row, for a row that predates `defaultModelTiers`. */
  configKey?: string;
}>;

const JOB_FABLE_NOTE = " Setting this to Fable spends the top tier on every run.";

export const DEFAULT_TIER_TABLE: readonly DefaultTierRow[] = [
  { key: "requirements", kind: "phase", label: "Requirements", shippedDefault: "opus", description: "Writing and refining an issue's requirements. A Plan: Deep label still raises the first write to Fable." },
  { key: "plan", kind: "phase", label: "Planning", shippedDefault: "fable", description: "Writing a fresh implementation plan." },
  { key: "plan-refine", kind: "phase", label: "Plan refinement", shippedDefault: "opus", description: "Revising a plan after feedback." },
  { key: "implement", kind: "phase", label: "Implementation", shippedDefault: "sonnet", description: "Implementing a planned issue when the plan prose names no tier." },
  { key: "review", kind: "phase", label: "Review", shippedDefault: "sonnet", configKey: "reviewModelTier", envVar: "CLAWS_REVIEW_MODEL_TIER", description: "Tier PR reviews run on when neither the plan nor the PR body names one." },
  { key: "ci-fix", kind: "phase", label: "CI fixing", shippedDefault: "sonnet", description: "Fixing failing CI when the complexity classifier gives no tier." },
  { key: "review-address", kind: "phase", label: "Review addressing", shippedDefault: "sonnet", description: "Addressing review feedback when the reviewer recommends no tier." },
  { key: "doc-maintainer", kind: "job", label: "Doc maintainer", shippedDefault: "sonnet", description: "Scheduled documentation updates." + JOB_FABLE_NOTE },
  { key: "idea-suggester", kind: "job", label: "Idea suggester", shippedDefault: "sonnet", description: "Scheduled idea suggestions and the idea-pause check." + JOB_FABLE_NOTE },
  { key: "friction-retrospective", kind: "job", label: "Friction retrospective", shippedDefault: "sonnet", description: "The fortnightly roll-up of agents' friction notes." + JOB_FABLE_NOTE },
  { key: "email-monitor", kind: "job", label: "Email monitor", shippedDefault: "sonnet", description: "Reading and answering monitored email." + JOB_FABLE_NOTE },
  { key: "whatsapp-handler", kind: "job", label: "WhatsApp handler", shippedDefault: "sonnet", description: "Answering WhatsApp messages." + JOB_FABLE_NOTE },
  { key: "public-snapshot-sync", kind: "job", label: "Public snapshot sync", shippedDefault: "sonnet", description: "Reviewing and syncing public snapshot copies." + JOB_FABLE_NOTE },
  { key: "escalation-reviewer", kind: "job", label: "Escalation reviewer", shippedDefault: "opus", description: "Reviewing items escalated for a second opinion." + JOB_FABLE_NOTE },
  { key: "prompt-guard-judge", kind: "job", label: "Prompt-guard judge", shippedDefault: "haiku", description: "Classifying prompt-guard regex hits as directives or quoted text." + JOB_FABLE_NOTE },
];

export const DEFAULT_TIER_KEYS: readonly DefaultTierKey[] = DEFAULT_TIER_TABLE.map((row) => row.key);

export function isDefaultTierKey(value: string): value is DefaultTierKey {
  return (DEFAULT_TIER_KEYS as readonly string[]).includes(value);
}

export function defaultTierRow(key: DefaultTierKey): DefaultTierRow {
  return DEFAULT_TIER_TABLE.find((row) => row.key === key)!;
}

/** The env var that pins a row: its own `envVar`, else `CLAWS_DEFAULT_TIER_<KEY>` upper-snake-cased. */
export function defaultTierEnvVar(key: DefaultTierKey): string {
  const row = defaultTierRow(key);
  return row.envVar ?? `CLAWS_DEFAULT_TIER_${key.toUpperCase().replace(/-/g, "_")}`;
}

/** The config page's form field for a row: the legacy `configKey` when it has one, else `defaultTier_<key>`. */
export function defaultTierFieldName(key: DefaultTierKey): string {
  return defaultTierRow(key).configKey ?? `defaultTier_${key}`;
}
