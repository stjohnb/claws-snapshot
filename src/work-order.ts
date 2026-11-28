/**
 * Claim order for `work_queue` rows. Pure — no service imports — so `db.ts`
 * and the MCP child process (`diagnostic-queries.ts`) can use it without
 * pulling in `worker.ts`.
 *
 * A queued row is a candidate, not a decision: a free worker claims by the
 * row's (dispatcher-refreshed) Priority flag first, then by how close the
 * item's pipeline stage is to merge, then by age. See `docs/patterns.md`
 * ("SQLite-Backed Work Queue").
 */

/** Stable string identifiers persisted in the work_queue.kind column. */
export const AGENT_KINDS = {
  CI_FIXER_CONFLICT: "ci-fixer:conflict",
  CI_FIXER: "ci-fixer",
  CI_FIXER_RERUN: "ci-fixer:rerun",
  CI_FIXER_PROBLEMATIC: "ci-fixer:problematic",
  REVIEW_ADDRESSER: "review-addresser",
  PR_REVIEWER: "pr-reviewer",
  AUTO_MERGER_SWEEP: "auto-merger:sweep",
  ISSUE_WORKER: "issue-worker",
  ISSUE_WORKER_CONTINUE: "issue-worker:continue",
  ISSUE_REFINER_FOLLOWUP: "issue-refiner:followup",
  ISSUE_REFINER_PLAN: "issue-refiner:plan",
  ISSUE_REFINER_REFINE: "issue-refiner:refine",
  ISSUE_REFINER_REPLAN: "issue-refiner:replan",
  ISSUE_REFINER_VERIFY: "issue-refiner:verify",
  REQUIREMENTS_WRITE: "requirements-writer:write",
  REQUIREMENTS_REFINE: "requirements-writer:refine",
  ESCALATION_REVIEW: "escalation-reviewer",
} as const;

/**
 * Kinds scoped to the repository alone; they enqueue with `item_number` 0.
 * They are stateless and repeated every cycle, so a lost run is not an error.
 * They are the only kinds whose pod is not re-queued when it vanishes mid-run:
 * the next cycle re-runs them anyway.
 */
export const REPO_SCOPED_KINDS: ReadonlySet<string> = new Set<string>([
  AGENT_KINDS.AUTO_MERGER_SWEEP,
  AGENT_KINDS.CI_FIXER_RERUN,
]);

/**
 * Pipeline stage of each kind, nearest to merge first. Lower ranks are
 * claimed first among rows with the same Priority flag.
 */
export const STAGE_RANK: Readonly<Record<string, number>> = {
  [AGENT_KINDS.AUTO_MERGER_SWEEP]: 0,
  [AGENT_KINDS.CI_FIXER_CONFLICT]: 1,
  [AGENT_KINDS.CI_FIXER]: 1,
  [AGENT_KINDS.CI_FIXER_RERUN]: 1,
  [AGENT_KINDS.CI_FIXER_PROBLEMATIC]: 1,
  [AGENT_KINDS.REVIEW_ADDRESSER]: 2,
  [AGENT_KINDS.PR_REVIEWER]: 3,
  [AGENT_KINDS.ISSUE_WORKER_CONTINUE]: 4,
  [AGENT_KINDS.ISSUE_WORKER]: 5,
  [AGENT_KINDS.ISSUE_REFINER_REFINE]: 6,
  [AGENT_KINDS.ISSUE_REFINER_REPLAN]: 6,
  [AGENT_KINDS.ISSUE_REFINER_VERIFY]: 6,
  [AGENT_KINDS.ISSUE_REFINER_FOLLOWUP]: 6,
  [AGENT_KINDS.ESCALATION_REVIEW]: 6,
  [AGENT_KINDS.ISSUE_REFINER_PLAN]: 7,
  [AGENT_KINDS.REQUIREMENTS_WRITE]: 8,
  [AGENT_KINDS.REQUIREMENTS_REFINE]: 8,
};

/** Rank for a kind missing from {@link STAGE_RANK}: claimed last. */
export const UNKNOWN_STAGE_RANK = 99;

export function stageRankOf(kind: string): number {
  return Object.hasOwn(STAGE_RANK, kind) ? STAGE_RANK[kind]! : UNKNOWN_STAGE_RANK;
}

/**
 * `CASE <column> WHEN '<kind>' THEN <rank> ... ELSE 99 END`, for ORDER BY.
 * Built only from the constant map — no placeholders, so the Postgres
 * driver's `?` rewriting is unaffected.
 */
export function stageRankSql(column = "kind"): string {
  const whens = Object.entries(STAGE_RANK)
    .map(([kind, rank]) => `WHEN '${kind}' THEN ${rank}`)
    .join(" ");
  return `CASE ${column} ${whens} ELSE ${UNKNOWN_STAGE_RANK} END`;
}

/**
 * Planning and requirements kinds. A reserved planning-lane worker fiber
 * claims only these, so a plan never waits behind a wave of PR work.
 */
export const PLANNING_KINDS: ReadonlySet<string> = new Set<string>([
  AGENT_KINDS.ISSUE_REFINER_PLAN,
  AGENT_KINDS.ISSUE_REFINER_REFINE,
  AGENT_KINDS.ISSUE_REFINER_REPLAN,
  AGENT_KINDS.ISSUE_REFINER_VERIFY,
  AGENT_KINDS.ISSUE_REFINER_FOLLOWUP,
  AGENT_KINDS.REQUIREMENTS_WRITE,
  AGENT_KINDS.REQUIREMENTS_REFINE,
]);

/**
 * `<column> IN ('<kind>', ...)` over {@link PLANNING_KINDS}. Built only from
 * the constant set — no placeholders, like {@link stageRankSql}.
 */
export function planningKindsSql(column = "kind"): string {
  return `${column} IN (${[...PLANNING_KINDS].map((k) => `'${k}'`).join(", ")})`;
}

/** Which worker lane claims a queued row: the planning lane, the priority express fiber, or any regular fiber. */
export type WorkLane = "planning" | "express" | "regular";

export function workLaneOf(kind: string, priority: boolean | number): WorkLane {
  if (PLANNING_KINDS.has(kind)) return "planning";
  return priority ? "express" : "regular";
}
