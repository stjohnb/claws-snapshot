import * as log from "./log.js";
import { ESCALATION_REASON_PREFIX, clearPrHold } from "./pr-hold.js";

const MARKER_LINE = /^(severity|review-result|review-model|recommended-model):/i;
const SUMMARY_MAX = 120;

/** First finding line of a review's output, stripped of markdown lead-ins and capped at 120 chars. */
export function summarizeFindings(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[#\-*>\s]+/, "").trim();
    if (!line || MARKER_LINE.test(line)) continue;
    return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
  }
  return "";
}

/** The specific `manual_action_reason` for a reviewer escalation. */
export function escalationReason(kind: "rebuttal" | "round-cap", summary: string, rounds?: number): string {
  const head = kind === "rebuttal"
    ? "upheld blocking finding after implementer rebuttal"
    : `${rounds ?? "many"} review rounds without converging`;
  return `${ESCALATION_REASON_PREFIX}${head}${summary ? ` — ${summary}` : ""}`;
}

/** True iff the row's hold was recorded by a pr-reviewer escalation. */
export function isEscalationManualAction(row: { manualActionReason?: string | null } | null | undefined): boolean {
  return !!row?.manualActionReason && row.manualActionReason.startsWith(ESCALATION_REASON_PREFIX);
}

/**
 * Lift a reviewer-escalation hold once the disagreement is settled. Never
 * lifts another kind of hold. Never throws. Returns true iff a hold was lifted.
 */
export async function clearEscalationManualAction(repo: string, prNumber: number, settledBy: string): Promise<boolean> {
  try {
    if (!(await clearPrHold(repo, prNumber, ESCALATION_REASON_PREFIX))) return false;
    log.info(`[pr-reviewer] cleared the escalation hold on ${repo}#${prNumber} — settled by ${settledBy}`);
    return true;
  } catch (err) {
    log.warn(`[pr-reviewer] Could not clear the escalation hold on ${repo}#${prNumber}: ${err}`);
    return false;
  }
}
