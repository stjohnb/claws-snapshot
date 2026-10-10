import { LABELS } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { extractManualActionSection } from "./agents/issue-worker.js";

/** Prefix of the `manual_action_reason` pr-reviewer records when it escalates a PR to a human. */
export const ESCALATION_REASON_PREFIX = "review escalated: ";

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

/** True iff the row's Manual Action was recorded by a pr-reviewer escalation. */
export function isEscalationManualAction(row: { manualActionReason?: string | null } | null | undefined): boolean {
  return !!row?.manualActionReason && row.manualActionReason.startsWith(ESCALATION_REASON_PREFIX);
}

/**
 * Remove a reviewer-escalation Manual Action once the disagreement is settled. Never clears a
 * Manual Action from another source (generic reason, or a manual-action section in the PR body).
 * Never throws. Returns true iff the label was removed.
 */
export async function clearEscalationManualAction(repo: string, prNumber: number, settledBy: string): Promise<boolean> {
  try {
    const row = await db.getClawsPr(repo, prNumber);
    if (!row || !isEscalationManualAction(row)) return false;
    const body = await gh.getPRBody(repo, prNumber);
    if (extractManualActionSection(body) !== null) {
      log.info(`[pr-reviewer] kept Manual Action on ${repo}#${prNumber} — another manual-action section remains`);
      return false;
    }
    if (!(await gh.removeLabel(repo, prNumber, LABELS.manualAction))) {
      log.warn(`[pr-reviewer] Could not remove ${LABELS.manualAction} from ${repo}#${prNumber}`);
      return false;
    }
    log.info(`[pr-reviewer] cleared Manual Action on ${repo}#${prNumber} — escalation "${row.manualActionReason}" settled by ${settledBy}`);
    return true;
  } catch (err) {
    log.warn(`[pr-reviewer] Could not clear escalation Manual Action on ${repo}#${prNumber}: ${err}`);
    return false;
  }
}
