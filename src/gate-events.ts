/**
 * Derived "gate" events for `claws_wait_for_change`
 * (#clw_01M5Q66MKK4WHBJ8XT1EMZZGEA): `pr-ready-to-merge`, `pr-needs-operator`
 * and `issue-awaiting-operator`, each emitted once per transition into its
 * state rather than on every write while the state holds. (`review-posted`
 * is a plain event, emitted by `db.recordPRReview`.)
 *
 * Each gate's last known state lives in `claws_gate_state`, keyed
 * `(repo, item, gate)`. {@link setGate} writes it with a compare-and-set, and
 * only the write that flips a gate to active (or moves an active gate to a
 * new detail, e.g. a new reviewed head) emits the event — so two processes
 * evaluating the same row, or a restart, never emit it twice.
 *
 * Upstream of `db.ts`, like `github-events.ts`: it imports only the driver
 * type, the `db.ts` row type, `log.ts`, `issue-id.ts` and `github-events.ts`.
 * `initDb()` creates the table from {@link CLAWS_GATE_STATE_DDL} and registers
 * its connection with {@link setGateEventsDriver}.
 */

import type { SqlDriver } from "./db-driver.js";
import type { ClawsPrRecord } from "./db.js";
import * as log from "./log.js";
import { canonicalIssueRef, type IssueRef } from "./issue-id.js";
import { recordGitHubEvent, type GitHubEvent } from "./github-events.js";

/** DDL for the table, run by `initDb()`. */
export const CLAWS_GATE_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS claws_gate_state (
    repo       TEXT NOT NULL,
    item       TEXT NOT NULL,
    gate       TEXT NOT NULL,
    active     INTEGER NOT NULL,
    detail     TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo, item, gate)
  )
`;

/** Why a PR needs the operator — the `pr-needs-operator` detail, one gate each. */
export type PrNeedsOperatorDetail = "manual-action" | "problematic" | "infra";

/** What an issue waits on the operator for — the `issue-awaiting-operator` detail, one gate each. */
export type IssueAwaitingOperatorDetail = "requirements-review" | "plan-review" | "manual-step";

export const ISSUE_AWAITING_OPERATOR_DETAILS: readonly IssueAwaitingOperatorDetail[] = ["requirements-review", "plan-review", "manual-step"];

let driver: SqlDriver | null = null;

/** Registers (or, with null, clears) the connection gate state is stored through. */
export function setGateEventsDriver(next: SqlDriver | null): void {
  driver = next;
}

/**
 * Record `gate`'s state for `(repo, item)` and emit `event` when this write
 * moved it into the active state — from inactive or absent, or from an active
 * state with a different detail. True when the event was emitted.
 *
 * MUST NEVER THROW: it runs inline from `upsertClawsPr`, the auto-merger and
 * the issue dispatcher, where an exception would abort real work. With no
 * driver registered it does nothing.
 */
export async function setGate(
  repo: string,
  item: IssueRef,
  gate: string,
  active: boolean,
  event: Omit<GitHubEvent, "id" | "at">,
): Promise<boolean> {
  if (!driver) return false;
  try {
    const detail = active ? event.detail ?? null : null;
    const { changes } = await driver.run(
      `INSERT INTO claws_gate_state (repo, item, gate, active, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, item, gate) DO UPDATE SET active = excluded.active, detail = excluded.detail, updated_at = excluded.updated_at
       WHERE claws_gate_state.active <> excluded.active
          OR (excluded.active = 1 AND COALESCE(claws_gate_state.detail, '') <> COALESCE(excluded.detail, ''))`,
      [repo, String(item), gate, active ? 1 : 0, detail, new Date().toISOString()],
    );
    if (!active || changes !== 1) return false;
    recordGitHubEvent(event);
    return true;
  } catch (err) {
    log.warn(`[gate-events] Could not record gate ${gate} for ${repo}#${item}: ${err}`);
    return false;
  }
}

/** The tracker issue a PR row serves, as an event's `related`, so a wait on the issue also catches its PR's gates. */
function relatedOf(issueId: string | null): IssueRef[] {
  const ref = issueId ? canonicalIssueRef(issueId) : null;
  return ref === null || ref === 0 ? [] : [ref];
}

/**
 * Whether a PR row is ready to merge: CI green (or no CI) on a head that has a
 * clean Claws review, and no hold. Mirrors `isReviewedHeadAwaitingMerge` in
 * `pr-state.ts`, which imports `db.ts` and so cannot be imported here.
 */
export function isReadyToMerge(row: ClawsPrRecord): boolean {
  if (row.stage !== "awaiting-merge" || row.reviewedSha === null || row.headSha === null) return false;
  if (row.headSha !== row.reviewedSha) return false;
  if (row.ciStatus !== "passing" && row.ciStatus !== "none") return false;
  return row.reviewVerdict === "clean" && row.manualActionReason === null && row.ciBlockedReason === null;
}

/** Set one `pr-needs-operator:<detail>` gate for a PR. Never throws. */
export async function setPrNeedsOperatorGate(
  repo: string,
  prNumber: number,
  issueId: string | null,
  detail: PrNeedsOperatorDetail,
  active: boolean,
): Promise<boolean> {
  return await setGate(repo, prNumber, `pr-needs-operator:${detail}`, active, {
    kind: "pr-needs-operator", repo, number: prNumber, related: relatedOf(issueId), detail,
  });
}

/**
 * Evaluate a `claws_prs` row's gates: `pr-ready-to-merge` (detail: the first
 * 12 characters of the head SHA) and the `manual-action` and `problematic`
 * `pr-needs-operator` gates. A merged or closed PR clears every gate,
 * including the auto-merger's `infra` one. Never throws.
 */
export async function evaluatePrGates(row: ClawsPrRecord): Promise<void> {
  const { repo, prNumber } = row;
  const open = row.stage !== "merged" && row.stage !== "closed";
  await setGate(repo, prNumber, "pr-ready-to-merge", isReadyToMerge(row), {
    kind: "pr-ready-to-merge", repo, number: prNumber, related: relatedOf(row.issueId), detail: (row.headSha ?? "").slice(0, 12),
  });
  await setPrNeedsOperatorGate(repo, prNumber, row.issueId, "manual-action", open && row.manualActionReason !== null);
  await setPrNeedsOperatorGate(repo, prNumber, row.issueId, "problematic", row.stage === "problematic");
  if (!open) await setPrNeedsOperatorGate(repo, prNumber, row.issueId, "infra", false);
}

/**
 * Set an issue's three `issue-awaiting-operator:<detail>` gates in `repo`,
 * with only `current` active (none when null). Never throws.
 */
export async function setIssueAwaitingOperatorGates(repo: string, issue: IssueRef, current: IssueAwaitingOperatorDetail | null): Promise<void> {
  for (const detail of ISSUE_AWAITING_OPERATOR_DETAILS) {
    await setGate(repo, issue, `issue-awaiting-operator:${detail}`, detail === current, {
      kind: "issue-awaiting-operator", repo, number: issue, related: [], detail,
    });
  }
}

/** Deletes inactive gate rows untouched for `retentionDays`; an active row is kept so it cannot re-fire. */
export async function pruneGateState(retentionDays = 30): Promise<number> {
  if (!driver) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await driver.run(`DELETE FROM claws_gate_state WHERE active = 0 AND updated_at < ?`, [cutoff]);
  return result.changes;
}
