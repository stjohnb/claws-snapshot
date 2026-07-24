import { isClawsComment } from "./github.js";

export interface PlanPhase {
  phaseNumber: number;
  title: string;
  description: string;
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

/**
 * Parse a structured plan comment into discrete phases.
 * Looks for `### PR N:` or `### Phase N:` headers to split into phases.
 * Falls back to a single phase if no multi-PR structure is found.
 */
export function parsePlan(planComment: string): ParsedPlan {
  // First, strip verbose preamble patterns (e.g., "I'll analyze...", "Let me examine...")
  let cleaned = stripVerbosePreamble(planComment);
  
  // Strip markers before parsing so they don't leak into the last phase's
  // description and accumulate on each cycle.
  cleaned = cleaned
    .replace(/\s*(?:<!-- )?plan-updated-after-phase:\d+(?: -->)?/g, "")
    .replace(/\s*\*\*Recommended implementation model:\*\*\s*`(?:opus|sonnet|cheap)`/g, "")
    .replace(/\s*\*\*Recommended provider:\*\*\s*`(?:claude|codex|opencode)`/g, "")
    .replace(/\s*\*\*Recommended review model:\*\*\s*`(?:opus|sonnet)`/g, "")
    .replace(/\s*\*Models used:[^\n*]+\*/gm, "");

  const headerPattern = /^###\s+(?:PR|Phase)\s+(\d+)\s*:\s*(.+)$/gm;
  const matches = [...cleaned.matchAll(headerPattern)];

  if (matches.length === 0) {
    return {
      preamble: cleaned,
      phases: [{ phaseNumber: 1, title: "Implementation", description: cleaned }],
      totalPhases: 1,
    };
  }

  const preamble = cleaned.slice(0, matches[0].index).trim()
    .replace(/^##\s+Implementation Plan\s*/m, "")
    .replace(/\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/g, "")
    .trim();

  const phases: PlanPhase[] = matches.map((match, i) => {
    const phaseNumber = parseInt(match[1], 10);
    const title = match[2].trim();
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : cleaned.length;
    const description = cleaned.slice(start, end).trim();
    return { phaseNumber, title, description };
  });

  return { preamble, phases, totalPhases: phases.length };
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
export function findPlanCommentEntry<T extends { id: number; body: string }>(comments: T[]): T | null {
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
 * Extracts the recommended implementation model from a plan comment.
 * Returns "opus", "sonnet", or "cheap" if found, or null if no recommendation is present.
 */
export function getRecommendedModel(planText: string): "opus" | "sonnet" | "cheap" | null {
  const match = planText.match(/\*\*Recommended implementation model:\*\*\s*`(opus|sonnet|cheap)`/);
  return match ? (match[1] as "opus" | "sonnet" | "cheap") : null;
}

export type Provider = "claude" | "codex" | "opencode" | "openrouter";

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
 * Returns "opus" or "sonnet" if found, or null if no recommendation is present.
 */
export function getRecommendedReviewModel(planText: string): "opus" | "sonnet" | null {
  const match = planText.match(/\*\*Recommended review model:\*\*\s*`(opus|sonnet)`/);
  return match ? (match[1] as "opus" | "sonnet") : null;
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
