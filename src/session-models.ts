import * as config from "./config.js";
import { resolveCodexModel } from "./model-selector.js";

/**
 * Model choices offered by the /sessions "New Session" form (#2873).
 *
 * A leaf module by design: it imports only config and model-selector, so
 * `pages/sessions.ts` can render the chooser without dragging `sessions.ts`
 * (and its node-pty/tmux dependencies) into the page-builder module graph.
 */
export interface ModelOption {
  id: string;
  label: string;
}

/**
 * Claude's choices are the CLI's tier *aliases*, not pinned model IDs.
 * `claude --model opus` resolves to the newest model in that tier, so this
 * list stays correct across model releases with no refresh mechanism — the
 * same rationale as `getDeepModel` in model-selector.ts.
 */
export const CLAUDE_SESSION_MODELS: ModelOption[] = [
  { id: "fable", label: "Fable (best)" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/** Sentinel `<option>` value meaning "use the free-text `modelCustom` input instead". */
export const CUSTOM_MODEL_SENTINEL = "__custom__";

function dedupeOptions(ids: string[]): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out;
}

/**
 * Codex choices: the operator's configured tier models plus the shipped
 * three-tier default set. Every config-sourced ID goes through
 * `resolveCodexModel` so a stale slug persisted in config.json never reaches
 * the dropdown.
 *
 * The config bindings are `export let` and reassigned on config reload, so they
 * are read inside the function rather than captured at module load.
 */
export function codexSessionModels(): ModelOption[] {
  return dedupeOptions([
    ...[config.CODEX_DEFAULT_MODEL, config.CODEX_LIGHT_MODEL, config.CODEX_CHEAP_MODEL]
      .filter(Boolean)
      .map((m) => resolveCodexModel(m)),
    "gpt-5.5",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
}

/**
 * OpenCode/OpenRouter choices: the four configured OpenRouter IDs. The full
 * OpenRouter catalogue is deliberately not fetched or hard-coded — the form's
 * "Other…" free-text box covers anything not listed here.
 */
export function opencodeSessionModels(): ModelOption[] {
  return dedupeOptions([
    config.OPENCODE_BEST_MODEL,
    config.OPENCODE_ADEQUATE_MODEL,
    config.OPENCODE_CHEAP_MODEL,
    config.IMPROVEMENT_IDENTIFIER_MODEL,
  ]);
}

/** The model options offered for `provider`. */
export function sessionModelsFor(provider: "claude" | "codex" | "opencode"): ModelOption[] {
  if (provider === "codex") return codexSessionModels();
  if (provider === "opencode") return opencodeSessionModels();
  return CLAUDE_SESSION_MODELS;
}

/**
 * argv-safe model id. Rejects whitespace, quotes, and shell metacharacters —
 * and anything starting with `-`, which an agent CLI would parse as a flag.
 */
export function isValidSessionModel(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,119}$/.test(model);
}
