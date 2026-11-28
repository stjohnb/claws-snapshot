/**
 * Which issues are awaiting the operator, for the board, the nav counts and
 * `issue-stage.ts`. Service-side only: kept out of `planned-prs.ts` because that
 * module is in the agent-pod graph and no pod reads this.
 */

import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import * as clawsIssues from "./claws-issues.js";
import * as planParser from "./plan-parser.js";
import { AWAITING_OPERATOR_MARKER } from "./blocked-reason.js";
import { parkForHuman } from "./issue-handback.js";
import { parsePhaseClaims } from "./phase-coverage.js";
import type { IssuePhaseState } from "./planned-prs.js";
import type { IssueRef } from "./issue-id.js";
import { mapWithConcurrency } from "./util.js";

const CONCURRENCY = 4;

/**
 * The subset of `issueIds` (tracker ids) awaiting the operator, mapped to the
 * lowest manual step not yet claimed done: {@link db.getIssueIdsAwaitingOperator}'s
 * candidates, less any whose every manual step is claimed by an allowed actor's
 * `claws-phase-done:` comment. A plan whose every step is done is not awaiting
 * anyone, so it is not shown in Awaiting merge (#clw_01M4ZN75K7GK0G7AFZEHBNCWD5).
 * A manual step's "done" depends only on those claims, so this makes no PR
 * reads. A candidate whose read fails is kept (as the SQL reported it) and logged.
 */
export async function issuesAwaitingOperator(issueIds: readonly string[]): Promise<Map<string, { position: number; title: string }>> {
  const candidates = await db.getIssueIdsAwaitingOperator(issueIds);
  if (candidates.size === 0) return candidates;
  const resolved = await mapWithConcurrency([...candidates], CONCURRENCY, async ([id, step]) => {
    try {
      const planned = await db.getIssuePlannedPRs(id);
      const manual = planned.filter((e) => e.kind === "manual");
      const record = await clawsIssues.getIssue(id);
      const repo = clawsIssues.primaryRepo(record ?? { repos: [] });
      const comments = await gh.getIssueComments(repo, id);
      const claims = await parsePhaseClaims(comments, (login) => gh.isAllowedActor(login, repo, id), planned.length);
      const open = manual.find((e) => !claims.has(e.position));
      if (!open) return null;
      return [id, { position: open.position, title: open.title }] as const;
    } catch (err) {
      log.warn(`[awaiting-operator] Could not read the manual step claims of ${id}: ${err}`);
      return [id, step] as const;
    }
  });
  const out: Map<string, { position: number; title: string }> = new Map();
  for (const r of resolved) if (r) out.set(r[0], r[1]);
  return out;
}

/** A step title that names no step — the plan's generic manual-actions heading. */
const GENERIC_STEP_TITLE_RE = /^manual (?:actions?|steps?|cutover)(?: \(operator\))?$/i;

const FIRST_SENTENCE_MAX = 160;

/**
 * The first sentence of a plan's manual-actions section body, for the first
 * line of the operator-step Blocked reason: list markers, headings, emphasis,
 * code ticks and links flattened, cut at the first sentence end and capped at
 * 160 characters (an ellipsis marks a cut). Null when the body has no text.
 */
export function firstSentenceOfStep(body: string): string | null {
  const flat = body
    .split("\n")
    .map((line) => line
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
      .trim())
    .filter((line) => line && !/^(?:`{3,}|~{3,})/.test(line))
    .join(" ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/(^|\W)(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\2(?=\W|$)/g, "$1$3")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  const end = /[.!?](?=\s|$)/.exec(flat);
  const sentence = end ? flat.slice(0, end.index + 1) : flat;
  if (sentence.length <= FIRST_SENTENCE_MAX) return sentence;
  return `${sentence.slice(0, FIRST_SENTENCE_MAX - 1).trimEnd()}…`;
}

/**
 * The first line of the operator-step Blocked reason: "Operator step N is
 * ready: <first sentence of the step>", with the step's title in parentheses
 * only when it is not the generic "Manual actions (operator)" heading, and just
 * "Operator step N is ready." when the plan has no manual-actions text.
 */
export function operatorStepReadyLine(step: number, title: string | undefined, sectionBody: string | null | undefined): string {
  const named = title && !GENERIC_STEP_TITLE_RE.test(title.trim()) ? ` (${title.trim()})` : "";
  const sentence = sectionBody ? firstSentenceOfStep(sectionBody) : null;
  return sentence ? `Operator step ${step} is ready${named}: ${sentence}` : `Operator step ${step} is ready${named}.`;
}

/**
 * The issue's plan has nothing left to run before its manual (operator) step:
 * the step is awaiting the operator and no PR step is ready or open. That is
 * after the last PR merges, or — for a step a PR needs the output of — after
 * the steps before it land, or at once when it comes first. Park the issue in
 * Blocked once, with the plan's manual-actions section and how to finish as the
 * reason. Dashboard only: the Blocked column and the Board count are the cue,
 * with no Slack line (docs/slack-messages.md). Moving the issue out of Blocked does not mark the
 * step done — that is `claws-phase-done: N`, read once the issue is out of
 * Blocked, or closing the issue. Skipped when a Claws comment already carries
 * {@link AWAITING_OPERATOR_MARKER}. Never throws.
 */
export async function announceAwaitingOperator(
  phases: { issueRepo: string; state: IssuePhaseState; comments: gh.IssueComment[]; planText: string | null },
  issueRef: IssueRef,
  source: string,
  agentName = "Auto Merger",
): Promise<void> {
  const { issueRepo, state, comments, planText } = phases;
  const { coverage } = state;
  const step = coverage.awaitingOperator[0];
  if (step === undefined || !state.entries) return;
  if (coverage.readyPhases.length > 0 || coverage.openPhases.length > 0) return;
  if (comments.some((c) => gh.isClawsComment(c.body) && c.body.includes(AWAITING_OPERATOR_MARKER))) return;
  try {
    const entry = state.entries.find((e) => e.position === step);
    const section = planText ? planParser.findManualActionsSection(planText) : null;
    const reason = [
      operatorStepReadyLine(step, entry?.title, section?.body),
      "",
      `Every step before operator step ${step} has landed. The step:`,
      "",
      section?.body || "_See the plan's manual-actions section._",
      "",
      // Both routes post the claim and take the issue out of Blocked themselves.
      `When done, press **Mark step ${step} done** on the board or the issue page, or have an interactive session call \`claws_mark_phase_done\`, or close the issue. Marking the step done keeps the issue's approval.`,
      "",
      AWAITING_OPERATOR_MARKER,
    ].join("\n");
    await parkForHuman(issueRepo, issueRef, reason, agentName, { slug: `awaiting-operator-${step}`, comments });
    log.info(`[${source}] ${issueRepo}#${issueRef}: awaiting operator step ${step}`);
  } catch (err) {
    log.warn(`[${source}] Could not announce the operator step for ${issueRepo}#${issueRef}: ${err}`);
  }
}
