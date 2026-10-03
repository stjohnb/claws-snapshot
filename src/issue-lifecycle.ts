/**
 * An issue's stored lifecycle state (#clw_01M350PWKJBS17E8861TKDP7TZ).
 *
 * A leaf module: native issues keep their lifecycle in one field,
 * `claws_issues.lifecycle`, rather than in `Refined` / `Ready` / `Blocked`
 * label rows, and this is the mapping between the two. `db.ts` uses it to
 * present the field to the pipeline as the label it used to be and to turn a
 * state-label write back into a field write; the board and the issue page use
 * it to leave those labels out of the controls that no longer set them.
 *
 * The values are the board's own column ids (see `issue-board.ts`), minus the
 * ones that are never stored: `implementing`, `pr-open` and
 * `awaiting-merge` are derived from the running implementer and `claws_prs`, and
 * `done` is `state = 'closed'` — plus `backlog`, which is a destination
 * but not a column: a backlog issue is off the board and parked, and nothing
 * automated ever sets or clears it; only a human does (#3293).
 *
 * The label names are spelled out here rather than imported from
 * `config.ts`'s `LABELS`: `db.ts` imports this module, and dozens of test
 * suites mock `./config.js` with only the few values they need, so an import
 * here would crash every one of them at load. `issue-lifecycle.test.ts` pins
 * each name against `LABELS` instead.
 */

/** The four state label names, matching `LABELS.backlog`, `.blocked`, `.refined` and `.ready`. */
const BACKLOG = "Backlog";
const BLOCKED = "Blocked";
const REFINED = "Refined";
const READY = "Ready";

/**
 * Every value `claws_issues.lifecycle` may hold. `ideas` is the default: a new
 * issue waits there while the requirements writer drafts its record, and a
 * promotion moves it to `planning` (#clw_01M39G3SREWPRP5AH0THJR0P24).
 */
export const ISSUE_LIFECYCLES = ["ideas", "planning", "awaiting-plan-review", "approved", "blocked", "backlog"] as const;

export type IssueLifecycle = (typeof ISSUE_LIFECYCLES)[number];

/**
 * The labels the lifecycle field stands in for, in the board's precedence
 * order: when an issue carries several, the first one listed wins.
 */
export const STATE_LABELS = [BACKLOG, BLOCKED, REFINED, READY] as const;

const LABEL_BY_LIFECYCLE: Record<IssueLifecycle, string | undefined> = {
  "ideas": undefined,
  "planning": undefined,
  "awaiting-plan-review": READY,
  "approved": REFINED,
  "blocked": BLOCKED,
  "backlog": BACKLOG,
};

export function isIssueLifecycle(value: string): value is IssueLifecycle {
  return (ISSUE_LIFECYCLES as readonly string[]).includes(value);
}

export function isStateLabel(label: string): boolean {
  return (STATE_LABELS as readonly string[]).includes(label);
}

/** The label a lifecycle reads as, or undefined for `ideas` and `planning`, which have none. */
export function labelForLifecycle(lifecycle: IssueLifecycle): string | undefined {
  return LABEL_BY_LIFECYCLE[lifecycle];
}

/** The lifecycle a state label sets, or undefined for any other label. */
export function lifecycleForLabel(label: string): IssueLifecycle | undefined {
  return ISSUE_LIFECYCLES.find((l) => LABEL_BY_LIFECYCLE[l] === label);
}

/**
 * Split a label list into the lifecycle its state labels name and the labels
 * that stay labels. Several state labels resolve by {@link STATE_LABELS}'
 * precedence — Backlog, then Blocked, then Refined, then Ready — the same
 * order the board's `columnFor` reads them in, so a forge issue imported with
 * both `Ready` and `Refined` lands in the column it was already drawn in.
 */
export function splitStateLabels(labels: Iterable<string>): { lifecycle: IssueLifecycle; rest: string[] } {
  const all = [...new Set(labels)];
  const winner = STATE_LABELS.find((label) => all.includes(label));
  return {
    lifecycle: winner === undefined ? "ideas" : lifecycleForLabel(winner)!,
    rest: all.filter((label) => !isStateLabel(label)),
  };
}

/**
 * Map a label-derived lifecycle onto the one to store, for a forge issue whose
 * labels alone cannot say "Planning": the forge has no label for it, so a
 * label-less issue reads as `ideas` on every sync unless it has already left
 * Ideas — approved, or already sitting in Planning, Awaiting plan review or
 * Approved — in which case it stays in Planning. Otherwise a label-less sync
 * would demote it and the next requirements version would promote it again.
 *
 * The one rule behind "has this issue left Ideas?", shared by every write that
 * turns a shadow's forge labels into a stored `lifecycle`.
 */
export function resolveStage(
  labelLifecycle: IssueLifecycle,
  state: { lifecycle: IssueLifecycle; requirementsApprovedAt: string | null },
): IssueLifecycle {
  const pastIdeas = state.requirementsApprovedAt !== null
    || state.lifecycle === "planning" || state.lifecycle === "awaiting-plan-review" || state.lifecycle === "approved";
  return labelLifecycle === "ideas" && pastIdeas ? "planning" : labelLifecycle;
}
