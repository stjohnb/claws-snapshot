import * as config from "./config.js";
import * as log from "./log.js";
import { getCodexModelCatalogue } from "./codex-models.js";
import type { Provider } from "./plan-parser.js";

export type ModelTier = "fable" | "opus" | "sonnet" | "haiku";
export type ProviderWeight = Readonly<{ provider: Provider; weight: number }>;

/** Every tier, best first. This is the canonical order for operator-facing lists. */
export const MODEL_TIERS: readonly ModelTier[] = ["fable", "opus", "sonnet", "haiku"];

/** Tier spellings Claws still reads but no longer writes. */
const TIER_ALIASES: ReadonlyMap<string, ModelTier> = new Map<string, ModelTier>([["cheap", "haiku"]]);

/**
 * Parse a tier written by a model, an operator, or an older config file.
 *
 * `"cheap"` was the name of the `haiku` tier before the vocabulary was unified,
 * and stays readable forever: it is still sitting in posted plan comments, PR
 * body markers and persisted config files. Returns null for anything that is
 * not a tier, so callers can fall back rather than trusting model output.
 */
export function normalizeTier(raw: string): ModelTier | null {
  const word = raw.trim().toLowerCase();
  const alias = TIER_ALIASES.get(word);
  if (alias) return alias;
  return (MODEL_TIERS as readonly string[]).includes(word) ? (word as ModelTier) : null;
}

/** One provider's column in a {@link MODEL_TIER_TABLE} row. */
export type ModelTierProviderCell = Readonly<{
  /** Operator-facing field label. */
  label: string;
  /**
   * Config key holding the operator's override, which is also the config
   * form's field name. Absent when the tier resolves to a fixed CLI alias
   * (Claude's `opus`/`sonnet`) and there is nothing to configure.
   */
  configKey?: string;
  /** Environment variable that overrides `configKey`. */
  envVar?: string;
  /** Model used when `configKey` is empty or unset; mirrors the default in `config.ts`. */
  defaultModel: string;
}>;

export type ModelTierRow = Readonly<{
  tier: ModelTier;
  label: string;
  description: string;
  providers: Readonly<Record<Provider, ModelTierProviderCell>>;
}>;

/**
 * The tier × provider grid: which config key supplies the concrete model for
 * each combination `getModel()` can be asked for. Rendered as one table by the
 * config page so tiers stay a single vocabulary rather than a list of ad-hoc
 * per-provider fields.
 */
export const MODEL_TIER_TABLE: readonly ModelTierRow[] = [
  {
    tier: "fable",
    label: "Fable",
    description: "The best model each provider offers. Fresh planning, and any phase an operator escalates by hand.",
    providers: {
      claude: { label: "Claude Fable Model", configKey: "claudeFableModel", envVar: "CLAWS_CLAUDE_FABLE_MODEL", defaultModel: "fable" },
      codex: { label: "Codex Fable Model", configKey: "codexFableModel", envVar: "CLAWS_CODEX_FABLE_MODEL", defaultModel: "gpt-5.5" },
      opencode: { label: "OpenCode Fable Model", configKey: "opencodeFableModel", envVar: "CLAWS_OPENCODE_FABLE_MODEL", defaultModel: "openrouter/anthropic/claude-opus-4" },
    },
  },
  {
    tier: "opus",
    label: "Opus",
    description: "Deep analysis: architectural work, novel logic, multi-file investigation.",
    providers: {
      claude: { label: "Claude Opus Model", defaultModel: "opus" },
      codex: { label: "Codex Default Model", configKey: "codexDefaultModel", envVar: "CLAWS_CODEX_DEFAULT_MODEL", defaultModel: "gpt-5.5" },
      opencode: { label: "OpenCode Best Model", configKey: "opencodeBestModel", envVar: "CLAWS_OPENCODE_BEST_MODEL", defaultModel: "openrouter/anthropic/claude-opus-4" },
    },
  },
  {
    tier: "sonnet",
    label: "Sonnet",
    description: "Well-defined changes following an established pattern.",
    providers: {
      claude: { label: "Claude Sonnet Model", defaultModel: "sonnet" },
      codex: { label: "Codex Light Model", configKey: "codexLightModel", envVar: "CLAWS_CODEX_LIGHT_MODEL", defaultModel: "gpt-5.6-terra" },
      opencode: { label: "OpenCode Adequate Model", configKey: "opencodeAdequateModel", envVar: "CLAWS_OPENCODE_ADEQUATE_MODEL", defaultModel: "openrouter/anthropic/claude-sonnet-4.5" },
    },
  },
  {
    tier: "haiku",
    label: "Haiku",
    description: "Trivial changes with no logic to get wrong. Written `cheap` in older plans and config.",
    providers: {
      claude: { label: "Claude Cheap Model", configKey: "claudeCheapModel", envVar: "CLAWS_CLAUDE_CHEAP_MODEL", defaultModel: "claude-haiku-4-5-20251001" },
      codex: { label: "Codex Cheap Model", configKey: "codexCheapModel", envVar: "CLAWS_CODEX_CHEAP_MODEL", defaultModel: "gpt-5.6-luna" },
      opencode: { label: "OpenCode Cheap Model", configKey: "opencodeCheapModel", envVar: "CLAWS_OPENCODE_CHEAP_MODEL", defaultModel: "openrouter/google/gemini-2.5-flash" },
    },
  },
];

export class NoEligibleProviderError extends Error {
  constructor(message = "No eligible AI providers are enabled with a positive finite weight") {
    super(message);
    this.name = "NoEligibleProviderError";
  }
}

/**
 * Legacy Codex model IDs that should no longer be pinned. Persisted config
 * written before a model retirement is repaired onto the current shipped
 * family: old non-mini IDs stay on the opus/default lane, while old mini/cheap
 * IDs stay on the haiku lane.
 */
const STALE_CODEX_MODEL_REPLACEMENTS = new Map<string, string>([
  ["gpt-5", "gpt-5.5"],
  ["gpt-5-codex", "gpt-5.5"],
  ["gpt-5.1", "gpt-5.5"],
  ["gpt-5.1-codex", "gpt-5.5"],
  ["gpt-5.1-codex-max", "gpt-5.5"],
  ["gpt-5.2-codex", "gpt-5.5"],
  ["o3", "gpt-5.5"],
  ["gpt-5-codex-mini", "gpt-5.6-luna"],
  ["gpt-5-codex-cheap", "gpt-5.6-luna"],
  ["gpt-5.1-codex-mini", "gpt-5.6-luna"],
  ["gpt-5.1-codex-cheap", "gpt-5.6-luna"],
  ["o3-mini", "gpt-5.6-luna"],
  ["o4-mini", "gpt-5.6-luna"],
]);

const warnedRetiredModels = new Set<string>();
const warnedCatalogueRepairs = new Set<string>();

function replacementForStaleCodexModelAlias(model: string): string | undefined {
  const replacement = STALE_CODEX_MODEL_REPLACEMENTS.get(model);
  if (replacement) return replacement;
  if (!/^gpt-5\.1(?:$|[-.])/.test(model)) return undefined;
  return /(?:^|[-.])(?:mini|cheap)(?:$|[-.])/.test(model) ? "gpt-5.6-luna" : "gpt-5.5";
}

/** Return a current model for stale Codex aliases, warning once per distinct ID. */
export function resolveCodexModel(model: string): string {
  const replacement = replacementForStaleCodexModelAlias(model);
  if (!replacement) return model;
  if (!warnedRetiredModels.has(model)) {
    warnedRetiredModels.add(model);
    log.warn(`[model-selector] Codex model "${model}" is a stale configured alias; using "${replacement}" instead. Clear or update the matching codex*Model key to silence this.`);
  }
  return replacement;
}

/** Validate a configured Codex model against the live CLI catalogue when available. */
export async function resolveCodexModelForAttempt(model: string): Promise<string> {
  const normalized = resolveCodexModel(model);
  if (!normalized) return "";

  const catalogue = await getCodexModelCatalogue();
  if (!catalogue) return normalized;

  if (catalogue.visible.has(normalized)) return normalized;

  const upgrade = catalogue.upgrades.get(normalized);
  if (upgrade && catalogue.visible.has(upgrade)) {
    const key = `${normalized}->${upgrade}`;
    if (!warnedCatalogueRepairs.has(key)) {
      warnedCatalogueRepairs.add(key);
      log.warn(`[model-selector] Codex model "${normalized}" is not visible in the current CLI catalogue; using visible upgrade "${upgrade}" instead.`);
    }
    return upgrade;
  }

  const key = `${normalized}->default`;
  if (!warnedCatalogueRepairs.has(key)) {
    warnedCatalogueRepairs.add(key);
    log.warn(`[model-selector] Codex model "${normalized}" is not visible in the current CLI catalogue; using the Codex CLI default.`);
  }
  return "";
}

/** Test-only: clear the warn-once cache so tests can assert repeated warnings. */
export function __resetRetiredModelWarningsForTests(): void {
  warnedRetiredModels.clear();
  warnedCatalogueRepairs.clear();
}

/** Returns the model to use, respecting the config override and provider. */
export function getModel(defaultTier: ModelTier, provider: Provider): string {
  if (provider === "codex") {
    if (defaultTier === "fable") return resolveCodexModel(config.CODEX_FABLE_MODEL);
    if (defaultTier === "haiku") return resolveCodexModel(config.CODEX_CHEAP_MODEL);
    return resolveCodexModel(defaultTier === "sonnet" ? config.CODEX_LIGHT_MODEL : config.CODEX_DEFAULT_MODEL);
  }
  if (provider === "opencode") {
    if (defaultTier === "fable") return config.OPENCODE_FABLE_MODEL;
    if (defaultTier === "haiku") return config.OPENCODE_CHEAP_MODEL;
    if (defaultTier === "sonnet") return config.OPENCODE_ADEQUATE_MODEL;
    return config.OPENCODE_BEST_MODEL;
  }
  // claude provider: an unconfigured tier falls through to the CLI's own alias
  // for that tier, which resolves to the newest model in it with no code change.
  if (defaultTier === "fable") return config.CLAUDE_FABLE_MODEL || "fable";
  if (defaultTier === "haiku") return config.CLAUDE_CHEAP_MODEL || "haiku";
  return defaultTier;
}

/**
 * The best model a provider offers, for deep-thinking runs (`Plan: Deep`).
 *
 * @deprecated "the best there is" is now the `fable` tier, so this is just
 * `getModel("fable", provider)`. Call that directly.
 */
export function getDeepModel(provider: Provider): string {
  return getModel("fable", provider);
}

/** Returns the model to use for PR reviews. */
export function getReviewModel(overrideTier: ModelTier | undefined, provider: Provider): string {
  return getModel(overrideTier ?? config.REVIEW_MODEL_TIER, provider);
}

export function getEnabledProviderWeights(): ReadonlyArray<ProviderWeight> {
  return config.AI_PROVIDERS
    ? (config.AI_PROVIDER_NAMES as readonly Provider[])
      .map((provider) => ({ provider, weight: Number(config.AI_PROVIDERS[provider]?.weight ?? 0), enabled: config.AI_PROVIDERS[provider]?.enabled !== false }))
      .filter((entry): entry is ProviderWeight & { enabled: true } => entry.enabled && Number.isFinite(entry.weight) && entry.weight > 0)
      .map(({ provider, weight }) => ({ provider, weight }))
    : [];
}

export function selectWeightedProvider(pool: ReadonlyArray<ProviderWeight>, random: () => number = Math.random): Provider {
  const total = pool.reduce((sum, entry) => sum + (Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0), 0);
  if (total <= 0) throw new NoEligibleProviderError();
  const raw = random();
  const r = Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), 0.999999999999) * total;
  let cursor = 0;
  for (const { provider, weight } of pool) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    cursor += weight;
    if (r < cursor) return provider;
  }
  return pool[pool.length - 1]!.provider;
}

export function selectWeightedProviderFromConfig(random?: () => number): Provider {
  return selectWeightedProvider(getEnabledProviderWeights(), random);
}

export function withoutProviders(
  pool: ReadonlyArray<ProviderWeight>,
  excluded: ReadonlySet<Provider> | ReadonlyArray<Provider>,
): ReadonlyArray<ProviderWeight> {
  const excludedSet = excluded instanceof Set ? excluded : new Set(excluded);
  return pool.filter(({ provider }) => !excludedSet.has(provider));
}

/**
 * Return an item-level provider override from GitHub labels.  A conflicting
 * pair deliberately falls back to the global setting: it is safer to keep an
 * item runnable than to silently choose one of two explicit instructions.
 */
export function getProviderOverride(labels: ReadonlyArray<{ name: string }>): Provider | undefined {
  const names = new Set(labels.map((label) => label.name));
  const providers: Provider[] = [];
  if (names.has(config.LABELS.useClaude)) providers.push("claude");
  if (names.has(config.LABELS.useCodex)) providers.push("codex");
  if (names.has(config.LABELS.useOpenCode)) providers.push("opencode");
  return providers.length === 1 ? providers[0] : undefined;
}

export interface ProviderSelection {
  provider: Provider;
  strictProvider: boolean;
  eligibleProviders: ReadonlyArray<ProviderWeight>;
  /**
   * Set when an explicit `Use Codex` label could not be honoured. Agents append
   * it to the "Models used" attribution so an ignored label is visible (#2686).
   *
   * MUST NOT contain `*`, `|` or a newline: plan-parser.ts matches the
   * attribution with a "Models used:" regex that stops at the next `*`,
   * and issue-refiner splits the segment on `|` when building "Refined with:".
   */
  overrideIgnoredReason?: string;
}

/**
 * Select the provider for an issue/PR.
 *
 * Explicit provider labels pin the first attempt only when that provider is
 * enabled with a positive finite weight.
 *
 * `requiresMcp` is kept as an item-selection signal for callers, but automated
 * Claude, Codex, and OpenCode backends all receive `mcpConfig`; provider labels
 * and weighted selection therefore keep their usual semantics.
 */
export function getProviderSelectionForItem(
  labels: ReadonlyArray<{ name: string }>,
  options?: { requiresMcp?: boolean; random?: () => number },
): ProviderSelection {
  const pool = getEnabledProviderWeights();
  const override = getProviderOverride(labels);
  const names = new Set(labels.map((label) => label.name));
  const providerLabels: Array<{ label: string; provider: Provider; display: string }> = [
    { label: config.LABELS.useClaude, provider: "claude", display: "Claude" },
    { label: config.LABELS.useCodex, provider: "codex", display: "Codex" },
    { label: config.LABELS.useOpenCode, provider: "opencode", display: "OpenCode" },
  ];
  const labelProviders = providerLabels.filter(({ label }) => names.has(label));

  if (labelProviders.length > 1) {
    return {
      provider: selectWeightedProvider(pool, options?.random),
      strictProvider: false,
      eligibleProviders: pool,
      overrideIgnoredReason: "conflicting provider labels ignored — weighted provider selection used",
    };
  }
  if (override) {
    const overridePool = pool.filter(({ provider }) => provider === override);
    if (overridePool.length > 0) {
      return { provider: override, strictProvider: true, eligibleProviders: overridePool };
    }
    const ignored = labelProviders[0];
    return {
      provider: selectWeightedProvider(pool, options?.random),
      strictProvider: false,
      eligibleProviders: pool,
      overrideIgnoredReason: `"${ignored?.label ?? "provider"}" label ignored — ${ignored?.display ?? override} provider is disabled or has non-positive weight`,
    };
  }
  return { provider: selectWeightedProvider(pool, options?.random), strictProvider: false, eligibleProviders: pool };
}

/** Select an item's explicit label override, otherwise a weighted provider. */
export function getProviderForItem(
  labels: ReadonlyArray<{ name: string }>,
  options?: { requiresMcp?: boolean },
): Provider {
  return getProviderSelectionForItem(labels, options).provider;
}
