import type { CommentRef } from "./issue-id.js";
import { isClawsComment } from "./github.js";
import { normalizePlanText } from "./marker-text.js";
import { normalizeTier, type ModelTier } from "./model-selector.js";
import { isModelPlanPhase, isModelPlanProvider, type ModelPlanCell } from "./model-plan-phases.js";

/** The planner's optional `**Model plan:**` line, with its leading whitespace, for stripping. */
export const MODEL_PLAN_LINE_STRIP = /\s*\*\*Model plan:\*\*[^\n]*/g;

export interface PlanPhase {
  phaseNumber: number;
  title: string;
  description: string;
  /**
   * Earlier phases this one must land after, from the header's dependency
   * suffix: `[]` for `(parallel)` / `(independent)`, null when the header
   * has no suffix (after the previous phase by default).
   */
  dependsOn: number[] | null;
}

/**
 * A `### PR N:` header's trailing dependency suffix: `(after PR 1)`,
 * `(after PRs 1 and 3)`, `(after PR 1, 3)`, `(parallel)` or `(independent)`.
 */
const DEPENDENCY_SUFFIX_RE = /\s*\(\s*(?:after\s+(?:PRs?\s+)?((?:\d+|,|&|and|\s)+?)|(parallel|independent))\s*\)\s*$/i;

/**
 * Split a phase header's title into the title proper and its dependency list.
 * Numbers not lower than `phaseNumber` are ignored (a dependency may only name
 * an earlier phase); an `after` list with none left reads as unspecified.
 */
export function parseDependencySuffix(title: string, phaseNumber: number): { title: string; dependsOn: number[] | null } {
  const m = title.match(DEPENDENCY_SUFFIX_RE);
  if (!m || (!m[2] && !/\d/.test(m[1] ?? ""))) return { title, dependsOn: null };
  const stripped = title.slice(0, m.index).trim();
  if (m[2]) return { title: stripped, dependsOn: [] };
  const deps = [...new Set((m[1].match(/\d+/g) ?? []).map(Number))]
    .filter((n) => n >= 1 && n < phaseNumber)
    .sort((a, b) => a - b);
  return { title: stripped, dependsOn: deps.length > 0 ? deps : null };
}

export interface ParsedPlan {
  preamble: string;
  phases: PlanPhase[];
  totalPhases: number;
}

/**
 * Strip verbose introductory preamble patterns commonly produced by OpenCode.
 * These patterns typically appear before the actual "## Implementation Plan" header.
 */
function stripVerbosePreamble(text: string): string {
  // Pattern 1: Everything before "## Implementation Plan" if it contains verbose starter phrases
  const planHeaderMatch = text.match(/^([\s\S]*?)(##\s+Implementation Plan[\s\S]*)$/);
  if (planHeaderMatch) {
    const beforePlan = planHeaderMatch[1];
    const afterPlan = planHeaderMatch[2];
    
    // Check if the text before the plan header contains verbose phrases
    const verbosePatterns = [
      /I'll\s+(?:analyze|examine|help|produce|create|start)/i,
      /Let me\s+(?:analyze|examine|help|produce|create|start)/i,
      /I\s+will\s+(?:analyze|examine|help|produce|create|start)/i,
      /Based on\s+(?:my|the)\s+(?:analysis|review|understanding)/i,
      /After\s+(?:analyzing|examining|reviewing)/i,
      /Upon\s+(?:review|analysis|examination)/i,
      /Looking at\s+(?:the|this)/i,
    ];
    
    if (verbosePatterns.some(pattern => pattern.test(beforePlan))) {
      // Strip everything before the plan header
      return afterPlan;
    }
  }
  
  return text;
}

/** The header suffix for a dependency list — `""` when unspecified. */
export function formatDependencySuffix(dependsOn: readonly number[] | null): string {
  if (!dependsOn) return "";
  if (dependsOn.length === 0) return " (parallel)";
  if (dependsOn.length === 1) return ` (after PR ${dependsOn[0]})`;
  return ` (after PRs ${dependsOn.slice(0, -1).join(", ")} and ${dependsOn[dependsOn.length - 1]})`;
}

/**
 * Parse a structured plan comment into discrete phases.
 * Looks for `### PR N:` or `### Phase N:` headers to split into phases,
 * each with an optional dependency suffix (`parseDependencySuffix`).
 * Falls back to a single phase if no multi-PR structure is found.
 */
export function parsePlan(planComment: string): ParsedPlan {
  const cleaned = cleanPlanText(planComment);

  const headerPattern = /^###\s+(?:PR|Phase)\s+(\d+)\s*:\s*(.+)$/gm;
  const matches = [...cleaned.matchAll(headerPattern)];

  if (matches.length === 0) {
    return {
      preamble: cleaned,
      phases: [{ phaseNumber: 1, title: "Implementation", description: cleaned, dependsOn: null }],
      totalPhases: 1,
    };
  }

  const preamble = cleaned.slice(0, matches[0].index).trim()
    .replace(/^##\s+Implementation Plan\s*/m, "")
    .replace(/\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/g, "")
    .trim();

  const phases: PlanPhase[] = matches.map((match, i) => {
    const phaseNumber = parseInt(match[1], 10);
    const { title, dependsOn } = parseDependencySuffix(match[2].trim(), phaseNumber);
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : cleaned.length;
    const description = cleaned.slice(start, end).trim();
    return { phaseNumber, title, description, dependsOn };
  });

  return { preamble, phases, totalPhases: phases.length };
}

/**
 * A plan's text without its verbose preamble and the directive and footer
 * lines Claws reads separately (model recommendations, the model plan, the
 * `*Models used:*` attribution, `CLAWS_TARGET_PR`, the phase-update marker).
 */
export function cleanPlanText(text: string): string {
  // Strip verbose preamble patterns (e.g., "I'll analyze...", "Let me examine..."),
  // then the markers, so they don't leak into the last phase's description and
  // accumulate on each cycle.
  return stripVerbosePreamble(text)
    .replace(/\s*(?:<!-- )?plan-updated-after-phase:\d+(?: -->)?/g, "")
    .replace(/\s*\*\*Recommended implementation model:\*\*\s*`(?:fable|opus|sonnet|haiku|cheap)`/g, "")
    .replace(/\s*\*\*Recommended provider:\*\*\s*`(?:claude|codex|opencode)`/g, "")
    .replace(/\s*\*\*Recommended review model:\*\*\s*`(?:fable|opus|sonnet|haiku|cheap)`/g, "")
    .replace(MODEL_PLAN_LINE_STRIP, "")
    .replace(/\s*\*Models used:[^\n*]+\*/gm, "")
    .replace(/^\s*CLAWS_TARGET_PR:\s*#?\d+\s*$/gm, "");
}

/** One `###` section of a plan, for rendering each as its own block. */
export interface PlanSection {
  title: string;
  markdown: string;
}

/**
 * Split a plan into its `###` sections in order — Requirement, Decisions,
 * Implementation, …, or `PR N: title` for each phase of a multi-PR plan, whose
 * `####` sub-headings stay inside it. Text before the first heading becomes a
 * leading "Overview" section, so a verdict plan with no headings is one
 * Overview section. The Claws header, the `## Implementation Plan` line, the
 * trailing `CLAWS_PLAN_*` markers and the directive lines {@link cleanPlanText}
 * strips never appear in a section. Headings inside a code fence do not split.
 */
export function parsePlanSections(planText: string): PlanSection[] {
  const cleaned = cleanPlanText(normalizePlanText(planText))
    .replace(/^\s*##\s+Implementation Plan[ \t]*$/m, "");
  const sections: PlanSection[] = [];
  let current: { title: string; lines: string[] } = { title: "Overview", lines: [] };
  const flush = () => {
    const markdown = current.lines.join("\n").trim();
    if (markdown || current.title !== "Overview") sections.push({ title: current.title, markdown });
  };
  let fence: string | null = null;
  for (const line of cleaned.split("\n")) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
      current.lines.push(line);
      continue;
    }
    if (opener) fence = opener[1];
    const heading = fence === null ? /^###\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      flush();
      current = { title: heading[1], lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return sections;
}

/**
 * The opening sentence of the planner's blocked verdict. The verdict is posted
 * under the plan header, so {@link findPlanComment} finds it like a real plan;
 * this is how a reader tells the two apart.
 */
export const BLOCKED_PLAN_SENTENCE = "The planner determined this issue is blocked on an external precondition";

/** True when a plan comment is the planner's blocked verdict rather than a plan. */
export function isBlockedVerdictPlan(body: string): boolean {
  return body.includes(BLOCKED_PLAN_SENTENCE);
}

/**
 * Find the most recent plan comment in a list of issue comments.
 * Uses a direct backward loop to avoid casting `{ body }` to `{ id, body }`.
 */
export function findPlanComment(comments: { body: string }[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.includes("## Implementation Plan") && isClawsComment(comments[i].body)) {
      return comments[i].body;
    }
  }
  return null;
}

/**
 * Like `findPlanComment`, but returns both `id` and `body` so callers that
 * need the comment ID don't have to search the array a second time.
 */
export function findPlanCommentEntry<T extends { id: CommentRef; body: string }>(comments: T[]): T | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.includes("## Implementation Plan") && isClawsComment(comments[i].body)) {
      return comments[i];
    }
  }
  return null;
}

/**
 * Returns a plain-text marker indicating the plan was updated after a given phase.
 * Used to prevent duplicate validation runs for the same phase.
 */
export function makePlanUpdateFooter(phaseNumber: number): string {
  return `plan-updated-after-phase:${phaseNumber}`;
}

/**
 * The rest of the last line that starts with `**<label>:**`, outside fenced
 * code blocks, or null when there is none. Last match wins, as for the plan
 * markers: a plan whose prose quotes the directive — mid-sentence or in a code
 * sample — must not beat its own trailing line.
 */
function lastDirectiveLine(planText: string, label: string): string | null {
  const prefix = `**${label}:**`;
  let fence: string | null = null;
  let found: string | null = null;
  for (const line of planText.split("\n")) {
    const trimmed = line.trimStart();
    const opener = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence !== null) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
      continue;
    }
    if (opener) { fence = opener[1]; continue; }
    if (trimmed.startsWith(prefix)) found = trimmed.slice(prefix.length);
  }
  return found;
}

function recommendedTier(planText: string, label: string): ModelTier | null {
  const line = lastDirectiveLine(planText, label);
  const match = line?.match(/^\s*`(fable|opus|sonnet|haiku|cheap)`/);
  return match ? normalizeTier(match[1]) : null;
}

/**
 * Extracts the recommended implementation model from a plan comment.
 * Returns the tier if found, or null if no recommendation is present.
 * Plans written before the tier rename say `cheap`, which reads as `haiku`.
 * Only the last such line outside a code fence counts.
 */
export function getRecommendedModel(planText: string): ModelTier | null {
  return recommendedTier(planText, "Recommended implementation model");
}

export const TARGET_PR_MARKER = "CLAWS_TARGET_PR";

/** Plan directive: land this work on an existing open PR's branch instead of a new PR. */
export function getTargetPR(planText: string): number | null {
  const m = planText.match(/^\s*CLAWS_TARGET_PR:\s*#?(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

export type Provider = "claude" | "codex" | "opencode";

/**
 * Extracts the attribution footer line from a plan comment body.
 * Matches lines of the form: *Models used: ...*
 */
export function extractModelsAttribution(body: string): string | null {
  const match = body.match(/\*Models used:[^\n*]+\*/);
  return match ? match[0] : null;
}

/**
 * Extracts the recommended review model from a plan comment.
 * Returns the tier if found, or null if no recommendation is present. The
 * planner is asked for `sonnet` or `opus`; the other tiers are accepted rather
 * than silently dropped if one ever appears. Only the last such line outside a
 * code fence counts.
 */
export function getRecommendedReviewModel(planText: string): ModelTier | null {
  return recommendedTier(planText, "Recommended review model");
}

/**
 * Parses the plan-updated-after-phase marker from a plan comment body.
 * Returns the phase number the plan was last updated after, or null if no marker is present.
 */
export function getPlanUpdatePhase(planText: string): number | null {
  const matches = [...planText.matchAll(/(?:<!-- )?plan-updated-after-phase:(\d+)(?: -->)?/g)];
  if (matches.length === 0) return null;
  return parseInt(matches[matches.length - 1][1], 10);
}

/**
 * Parses the planner's optional model-plan line:
 *
 *     **Model plan:** `implement=claude/sonnet` `review=opus` `ci-fix=codex/haiku`
 *
 * Each cell is `phase=provider/tier` or `phase=tier`. Unknown phases, providers
 * and tiers are dropped rather than trusted, and a later cell for the same
 * phase wins. Returns an empty list when the line is absent. `cheap` reads as
 * `haiku`, as everywhere else. Only the last line that starts with the label,
 * outside a code fence, counts — an example quoted in the plan's prose is not
 * the plan.
 */
export function parseModelPlanLine(planText: string): ModelPlanCell[] {
  const line = lastDirectiveLine(planText, "Model plan");
  if (line === null) return [];
  const cells = new Map<string, ModelPlanCell>();
  for (const m of line.matchAll(/`\s*([a-z-]+)\s*=\s*(?:([a-z]+)\s*\/\s*)?([a-z]+)\s*`/gi)) {
    const phase = m[1].toLowerCase();
    if (!isModelPlanPhase(phase)) continue;
    const rawProvider = m[2]?.toLowerCase();
    const provider = rawProvider === undefined ? null : isModelPlanProvider(rawProvider) ? rawProvider : undefined;
    if (provider === undefined) continue;
    const tier = normalizeTier(m[3]);
    if (!tier) continue;
    cells.set(phase, { phase, provider, tier });
  }
  return [...cells.values()];
}
