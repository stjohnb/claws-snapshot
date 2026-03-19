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
 * Parse a structured plan comment into discrete phases.
 * Looks for `### PR N:` or `### Phase N:` headers to split into phases.
 * Falls back to a single phase if no multi-PR structure is found.
 */
export function parsePlan(planComment: string): ParsedPlan {
  const headerPattern = /^###\s+(?:PR|Phase)\s+(\d+)\s*:\s*(.+)$/gm;
  const matches = [...planComment.matchAll(headerPattern)];

  if (matches.length === 0) {
    return {
      preamble: planComment,
      phases: [{ phaseNumber: 1, title: "Implementation", description: planComment }],
      totalPhases: 1,
    };
  }

  const preamble = planComment.slice(0, matches[0].index).trim();

  const phases: PlanPhase[] = matches.map((match, i) => {
    const phaseNumber = parseInt(match[1], 10);
    const title = match[2].trim();
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : planComment.length;
    const description = planComment.slice(start, end).trim();
    return { phaseNumber, title, description };
  });

  return { preamble, phases, totalPhases: phases.length };
}

/**
 * Find the most recent plan comment in a list of issue comments.
 * Looks for comments containing `## Implementation Plan` (uses includes
 * rather than startsWith so it still matches when the Claws visible header
 * is prepended).
 */
export function findPlanComment(comments: { body: string }[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.includes("## Implementation Plan")) {
      return comments[i].body;
    }
  }
  return null;
}
