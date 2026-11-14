/**
 * An issue's stored lifecycle state (#clw_01M350PWKJBS17E8861TKDP7TZ).
 *
 * A leaf module: native issues keep their lifecycle in one field,
 * `claws_issues.lifecycle`, rather than in `Blocked` / `Backlog` label rows,
 * and this is the mapping between the two. `db.ts` uses it to present the
 * field to the pipeline as the label it used to be and to turn a state-label
 * write back into a field write; the board and the issue page use it to leave
 * those labels out of the controls that no longer set them. Approval is not a
 * lifecycle: it is `claws_issues.approved_through` (`issue-approval.ts`),
 * which replaced the retired `Refined` and `Ready` labels
 * (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F).
 *
 * The values are the board's own column ids (see `issue-board.ts`), minus the
 * ones that are never stored: `in-progress` and `awaiting-merge` are derived from the running implementer and `claws_prs`,
 * `approved` is `awaiting-plan-review` approved through Plan, and
 * `done` is `state = 'closed'` — plus `backlog`, which is a destination
 * but not a column: a backlog issue is off the board and parked, and nothing
 * automated ever clears it, and the only automated set is the planner sending an
 * operator-task verdict there; only a human promotes (#3293).
 *
 * The label names are spelled out here rather than imported from
 * `config.ts`'s `LABELS`: `db.ts` imports this module, and dozens of test
 * suites mock `./config.js` with only the few values they need, so an import
 * here would crash every one of them at load. `issue-lifecycle.test.ts` pins
 * each name against `LABELS` instead.
 */

/** The two state label names, matching `LABELS.backlog` and `.blocked`. */
const BACKLOG = "Backlog";
const BLOCKED = "Blocked";

/**
 * Every value `claws_issues.lifecycle` may hold. `ideas` is the default: a new
 * issue waits there while the requirements writer drafts its record, and a
 * promotion moves it to `planning` (#clw_01M39G3SREWPRP5AH0THJR0P24).
 * `awaiting-plan-review` means the planner has posted a plan and has nothing
 * left to do; the board shows it as Approved once `approved_through` reaches
 * `plan`.
 */
export const ISSUE_LIFECYCLES = ["ideas", "planning", "awaiting-plan-review", "blocked", "backlog"] as const;

export type IssueLifecycle = (typeof ISSUE_LIFECYCLES)[number];

/**
 * The labels the lifecycle field stands in for, in the board's precedence
 * order: when an issue carries several, the first one listed wins.
 */
export const STATE_LABELS = [BACKLOG, BLOCKED] as const;

const LABEL_BY_LIFECYCLE: Record<IssueLifecycle, string | undefined> = {
  "ideas": undefined,
  "planning": undefined,
  "awaiting-plan-review": undefined,
  "blocked": BLOCKED,
  "backlog": BACKLOG,
};

export function isIssueLifecycle(value: string): value is IssueLifecycle {
  return (ISSUE_LIFECYCLES as readonly string[]).includes(value);
}

export function isStateLabel(label: string): boolean {
  return (STATE_LABELS as readonly string[]).includes(label);
}

/** The label a lifecycle reads as, or undefined for `ideas`, `planning` and `awaiting-plan-review`, which have none. */
export function labelForLifecycle(lifecycle: IssueLifecycle): string | undefined {
  return LABEL_BY_LIFECYCLE[lifecycle];
}

/** The lifecycle a state label sets, or undefined for any other label. */
export function lifecycleForLabel(label: string): IssueLifecycle | undefined {
  return ISSUE_LIFECYCLES.find((l) => LABEL_BY_LIFECYCLE[l] === label);
}

/** The retired `Claws Ignore` label, spelled out for the same reason as the state labels. */
const CLAWS_IGNORE = "Claws Ignore";

/**
 * Map retired labels on a forge item onto their replacements: `Claws Ignore`
 * reads as `Backlog`, so an item a human parks with it while the label still
 * exists on the forge stays parked once imported or shadowed
 * (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD). Run it before {@link splitStateLabels} so
 * `Backlog` becomes the lifecycle rather than a label row. A no-op once
 * repo-standards has deleted the label everywhere.
 */
export function replaceLegacyLabels(labels: Iterable<string>): string[] {
  return [...new Set([...labels].map((l) => (l === CLAWS_IGNORE ? BACKLOG : l)))];
}

/**
 * The retired gate labels (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F): approval lives
 * in `approved_through`, so none of them is ever stored as a label row, and a
 * forge copy that still carries one approves nothing.
 */
export const RETIRED_GATE_LABELS = ["Refined", "Ready", "Ship", "Claws Auto-Refine", "Automerge"] as const;

/**
 * Split a label list into the lifecycle its state labels name and the labels
 * that stay labels. Several state labels resolve by {@link STATE_LABELS}'
 * precedence — Backlog, then Blocked — the same order the board's `columnFor`
 * reads them in. The retired gate labels are dropped: they are neither a
 * lifecycle nor a label any more.
 */
export function splitStateLabels(labels: Iterable<string>): { lifecycle: IssueLifecycle; rest: string[] } {
  const all = [...new Set(labels)].filter((label) => !(RETIRED_GATE_LABELS as readonly string[]).includes(label));
  const winner = STATE_LABELS.find((label) => all.includes(label));
  return {
    lifecycle: winner === undefined ? "ideas" : lifecycleForLabel(winner)!,
    rest: all.filter((label) => !isStateLabel(label)),
  };
}

/**
 * Map a label-derived lifecycle onto the one to store, for a forge issue whose
 * labels alone cannot say "Planning" or "Awaiting plan review": the forge has
 * no label for either, so a label-less issue reads as `ideas` on every sync
 * unless it has already left Ideas — approved, or already sitting in Planning
 * or Awaiting plan review — in which case it stays where it is (Awaiting plan
 * review) or in Planning. Otherwise a label-less sync would demote it and the
 * next requirements version would promote it again.
 *
 * The one rule behind "has this issue left Ideas?", shared by every write that
 * turns a shadow's forge labels into a stored `lifecycle`.
 */
export function resolveStage(
  labelLifecycle: IssueLifecycle,
  state: { lifecycle: IssueLifecycle; requirementsApprovedAt: string | null },
): IssueLifecycle {
  const pastIdeas = state.requirementsApprovedAt !== null
    || state.lifecycle === "planning" || state.lifecycle === "awaiting-plan-review";
  if (labelLifecycle !== "ideas" || !pastIdeas) return labelLifecycle;
  return state.lifecycle === "awaiting-plan-review" ? "awaiting-plan-review" : "planning";
}
