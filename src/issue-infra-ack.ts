/**
 * The operator's plan-stage acknowledgement of an issue's declared infra
 * changes (#clw_01M7096B0VFCVYAA2ED0ZRHFC2). It is stored on the issue
 * (`claws_issues.infra_ack_by/at/hash`) and bound to `declarationsHash` of
 * every planned PR's declaration, so a re-plan that changes any declaration
 * makes it stale. The auto-merger reads it per PR through
 * {@link loadInfraAckForPr}; the board and issue page through
 * {@link infraAckState}.
 */

import * as db from "./db.js";
import { declarationsHash, type InfraDeclaration } from "./infra-declaration.js";

export type InfraAckState = "none" | "current" | "stale";

/** Whether `ack` covers the current declarations of `plannedPrs`. */
export function infraAckState(
  ack: Pick<db.IssueInfraAck, "hash"> | null | undefined,
  plannedPrs: readonly { repo: string; infraChanges?: InfraDeclaration | null }[],
): InfraAckState {
  if (!ack) return "none";
  return ack.hash === declarationsHash(plannedPrs) ? "current" : "stale";
}

/** One PR's declaration and the state of its issue's acknowledgement. */
export interface PrInfraAck {
  issueId: string;
  position: number;
  declaration: InfraDeclaration;
  state: InfraAckState;
  ack: db.IssueInfraAck | null;
}

/**
 * The declaration a PR's planned entry carries and its issue's acknowledgement
 * state. Null — today's behaviour — when the PR has no issue, no planned entry
 * linked to it on that issue, covers more than one planned position, or its
 * entry declares nothing.
 */
export async function loadInfraAckForPr(row: Pick<db.ClawsPrRecord, "repo" | "prNumber" | "issueId">): Promise<PrInfraAck | null> {
  if (!row.issueId) return null;
  const found = await db.findIssuePlannedPRByNumber(row.repo, row.prNumber);
  if (!found || found.issueId !== row.issueId) return null;
  const planned = await db.getIssuePlannedPRs(row.issueId);
  const linked = planned.filter((e) => e.kind === "pr" && e.prNumber === row.prNumber && e.repo.toLowerCase() === row.repo.toLowerCase());
  if (linked.length !== 1) return null;
  const entry = linked[0]!;
  if (!entry.infraChanges) return null;
  const ack = await db.getIssueInfraAck(row.issueId);
  return { issueId: row.issueId, position: entry.position, declaration: entry.infraChanges, state: infraAckState(ack, planned), ack };
}
