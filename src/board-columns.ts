/**
 * The board's column definitions. A dependency-free leaf, unlike
 * `issue-board.ts` (which imports `config.ts`): `claws-state-tools.ts` runs in
 * the standalone MCP child process and reads the column ids from here without
 * loading the service. `issue-board.ts` re-exports it.
 */

/**
 * The columns, left to right. A `gate` column is where a human acts — a drop
 * target the board marks as such. A `derived` column is set by Claws from the
 * issue's flight and is never a drop target — see {@link transitionFor}.
 * Blocked is neither: a drop target, but a parking spot rather than a gate.
 * A `waits` column is where the operator's action is what the card is waiting
 * on; the board starts only these open, at every width, and folds the rest. A `claws` column is one Claws
 * moves cards into on its own — the derived columns and Drafting, which an
 * issue enters when filed or when feedback is left on its requirements — and
 * is styled and counted as "set by Claws" even where it is a drop target.
 */
export const BOARD_COLUMNS = [
  { id: "drafting", title: "Drafting", hint: "Filed, or feedback left on the record — Claws writes or revises the requirements — drop a card here to send an issue back to requirements", group: "shaping", gate: false, derived: false, claws: true, waits: false },
  { id: "requirements-review", title: "Requirements review", hint: "Requirements written — read them and promote, or leave feedback — drop a card here", group: "shaping", gate: true, derived: false, claws: false, waits: true },
  { id: "planning", title: "Planning", hint: "Requirements approved — the planner is queued or running — drop here to promote or re-plan", group: "shaping", gate: true, derived: false, claws: false, waits: false },
  { id: "awaiting-plan-review", title: "Awaiting plan review", hint: "Planned — waiting for a human to approve — or a design change waits for re-approval — drop a card here", group: "shaping", gate: true, derived: false, claws: false, waits: true },
  { id: "approved", title: "Approved", hint: "Plan approved — Claws implements it — drop a card here", group: "building", gate: true, derived: false, claws: false, waits: false },
  { id: "implementing", title: "Implementing", hint: "Claws' implementer is running — set by Claws, not a drop target", group: "building", gate: false, derived: true, claws: true, waits: false },
  { id: "pr-progressing", title: "PR progressing", hint: "The issue's PR is cycling through CI, review and fixes — set by Claws, not a drop target", group: "building", gate: false, derived: true, claws: true, waits: false },
  { id: "pr-stalled", title: "PR stalled", hint: "The issue's PR needs a person — manual action, CI fixes exhausted or CI blocked — set by Claws, not a drop target", group: "building", gate: false, derived: true, claws: true, waits: true },
  { id: "blocked", title: "Blocked", hint: "Parked on something external", group: null, gate: false, derived: false, claws: false, waits: true },
  { id: "awaiting-merge", title: "Awaiting merge", hint: "Clean review and green CI — approve the merge with the card's Automerge control — set by Claws, not a drop target", group: "landing", gate: false, derived: true, claws: true, waits: true },
  { id: "done", title: "Closed", hint: "Closed — drop a card here to close it as not planned", group: "landing", gate: true, derived: false, claws: false, waits: false },
] as const;

