/**
 * Post-merge operator steps — turning a merged PR's "Manual action required
 * after merge" note into an operator step on its issue's plan, so the issue
 * stays open until the step is marked done (**Mark step N done** or
 * `claws_mark_phase_done`). Nothing is recorded on the merged PR's
 * `claws_prs` row any more.
 *
 * The step lives where every other reader already looks: the plan comment's
 * `### Manual actions (operator)` section and a `manual` entry in the issue's
 * stored step list (`claws_issue_prs`). The plan comment is edited in place:
 * its trailing `CLAWS_PLAN_*` markers are kept verbatim, so the plan stays
 * current and approved, and a native issue's plan keeps its version number.
 *
 * One operator step per plan: a later note joins the section as another
 * bullet while the step is unclaimed. When the issue cannot take the step —
 * closed, no stored step list, no plan comment, or its operator step already
 * claimed done — a Blocked follow-up issue carries the note instead.
 */

import * as db from "./db.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import * as clawsIssues from "./claws-issues.js";
import * as planParser from "./plan-parser.js";
import { LABELS } from "./config.js";
import { stripPlanMarkers } from "./marker-text.js";
import { parsePhaseClaims } from "./phase-coverage.js";
import { issueRefForTracker, postMergeNoteDuplicatesPlan, clearPrHold, POST_MERGE_PREFIX } from "./pr-hold.js";
import { firstSentenceOfStep } from "./awaiting-operator.js";
import { addLink } from "./issue-links.js";
import { mapWithConcurrency } from "./util.js";

/** What {@link recordPostMergeStep} did with a note. */
export type PostMergeStepOutcome = "appended" | "merged-into-step" | "duplicate" | "follow-up-issue" | "comment-only";

/** The heading of the section Claws appends to a plan that has none. */
export const POST_MERGE_STEP_HEADING = "### Manual actions (operator)";

/** The stored list title of the step Claws appends. */
export const POST_MERGE_STEP_TITLE = "Manual actions (operator)";

/**
 * The parenthetical ending each bullet Claws adds: it tells a Claws-added
 * section from one the Planner wrote.
 */
export const CLAWS_ADDED_MARKER = "(added by Claws from the PR's post-merge note)";

const COMPONENT = "post-merge-step";

/** The plan bullet for a merged PR's note. */
export function postMergeBullet(prRepo: string, prNumber: number, note: string): string {
  const flat = note.replace(/\s*\n\s*/g, " ").trim();
  return `- After ${prRepo}#${prNumber} merged: ${flat} ${CLAWS_ADDED_MARKER}`;
}

/**
 * `planContent` (a plan comment without the Claws marker) with `bullet` added
 * to its first manual-actions section, or a new `### Manual actions (operator)`
 * section holding it when the plan has none. The `*Models used:*` attribution
 * and the trailing `CLAWS_PLAN_*` markers stay last and unchanged.
 */
export function addPostMergeBullet(planContent: string, bullet: string): string {
  const head = stripPlanMarkers(planContent);
  const markers = planContent.slice(head.length);
  const attribution = /\n*(\*Models used:[^\n]*\*)\s*$/.exec(head);
  let plan = attribution ? head.slice(0, attribution.index) : head;
  const tail = attribution ? `\n\n${attribution[1]}` : "";
  const span = planParser.manualActionsSectionSpan(plan);
  if (span) {
    const section = plan.slice(span.start, span.end).trimEnd();
    const lastLine = section.split("\n").pop() ?? "";
    const joiner = /^\s*[-*+]\s/.test(lastLine) ? "\n" : "\n\n";
    const after = plan.slice(span.end).trim();
    plan = `${plan.slice(0, span.start)}${section}${joiner}${bullet}${after ? `\n\n${after}` : ""}`;
  } else {
    plan = `${plan.trimEnd()}\n\n${POST_MERGE_STEP_HEADING}\n\n${bullet}`;
  }
  return `${plan.trimEnd()}${tail}${markers}`;
}

/**
 * Track merged PR `prRepo#prNumber`'s post-merge `note` as an operator step of
 * the issue its `claws_prs` row links:
 *
 * - `comment-only` — the PR has no linked issue; the PR comment is the record.
 * - `duplicate` — a later step of the plan already covers it (a Planner-written
 *   unclaimed operator step, or a later PR in a repo the note names), or the
 *   plan already carries this PR's note.
 * - `follow-up-issue` — the issue is closed, has no stored step list or plan
 *   comment, or its operator step is already claimed done: a Blocked follow-up
 *   issue carries the note, linked `relates_to` the original.
 * - `merged-into-step` — the note joined the plan's unclaimed operator step as
 *   another bullet.
 * - `appended` — a new operator step, last and depending on every PR step.
 *
 * Throws on a failed read or write; the caller logs it.
 */
export async function recordPostMergeStep(prRepo: string, prNumber: number, note: string): Promise<PostMergeStepOutcome> {
  const fields = { component: COMPONENT, repo: prRepo, pr: prNumber };
  const row = await db.getClawsPr(prRepo, prNumber);
  const issueId = row?.issueId ?? null;
  const issue = issueId ? await clawsIssues.getIssue(issueId) : undefined;
  if (!issueId || !issue) {
    log.info("post-merge note has no linked issue; left on the PR comment", { ...fields, note });
    return "comment-only";
  }
  return await withIssueLock(issueId, () => recordForIssue(prRepo, prNumber, note, row, issueId, issue));
}

/**
 * Per-issue chain serialising {@link recordPostMergeStep}'s read-modify-write
 * of an issue's plan comment and stored step list, so concurrent notes for
 * one issue (a multi-repo issue's PRs merging in one sweep, or several legacy
 * rows) neither lose a bullet nor append two operator steps.
 */
const issueLocks = new Map<string, Promise<unknown>>();

async function withIssueLock<T>(issueId: string, fn: () => Promise<T>): Promise<T> {
  const run = (issueLocks.get(issueId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  issueLocks.set(issueId, tail);
  try {
    return await run;
  } finally {
    if (issueLocks.get(issueId) === tail) issueLocks.delete(issueId);
  }
}

async function recordForIssue(
  prRepo: string,
  prNumber: number,
  note: string,
  row: db.ClawsPrRecord | null,
  issueId: string,
  issue: db.ClawsIssueRecord,
): Promise<PostMergeStepOutcome> {
  const fields = { component: COMPONENT, repo: prRepo, pr: prNumber };
  const where = await issueRefForTracker(issueId);
  const followUp = (reason: string) => fileFollowUpIssue(prRepo, prNumber, note, issueId, reason);
  if (issue.state !== "open" || !where) return await followUp(issue.state !== "open" ? "issue-closed" : "no-issue-repo");
  // A shadow's record lags the forge: the merged PR's `Closes #N` closes the
  // forge issue seconds before this runs, so read its live state.
  if (issue.kind === "shadow" && (await gh.getIssueState(where.repo, where.ref)).state !== "OPEN") {
    return await followUp("issue-closed");
  }
  const planned = await db.getIssuePlannedPRs(issueId);
  if (planned.length === 0) return await followUp("no-step-list");

  const comments = await gh.getIssueComments(where.repo, where.ref);
  const claimed = await parsePhaseClaims(comments, (login) => gh.isAllowedActor(login, where.repo, where.ref), planned.length);
  const planComment = planParser.findPlanCommentEntry(comments);
  const section = planComment ? planParser.findManualActionsSection(planComment.body) : null;
  const clawsAddedSection = !!section && section.body.includes(CLAWS_ADDED_MARKER);
  const duplicate = postMergeNoteDuplicatesPlan(note, prRepo, prNumber, row?.phase, planned, { claimed, clawsAddedSection });
  if (duplicate) {
    log.info("post-merge note duplicates a plan step", { ...fields, issue_id: issueId, position: duplicate.position, kind: duplicate.kind });
    return "duplicate";
  }
  const manual = planned.filter((e) => e.kind === "manual");
  const pending = manual.find((e) => !claimed.has(e.position));
  if (manual.length > 0 && !pending) return await followUp("step-claimed");
  if (!planComment) return await followUp("no-plan-comment");
  // The bullet without a stored `manual` entry is an earlier run that edited
  // the plan but failed to append: skip the edit and append the step.
  const onPlan = !!section?.body.includes(`After ${prRepo}#${prNumber} merged:`);
  if (onPlan && pending) {
    log.info("post-merge note already on the plan", { ...fields, issue_id: issueId });
    return "duplicate";
  }

  if (!onPlan) {
    const content = gh.stripClawsMarker(planComment.body);
    const edited = addPostMergeBullet(content, postMergeBullet(prRepo, prNumber, note));
    await gh.editIssueComment(where.repo, planComment.id, edited, { agentName: "Planner", amendPlanVersion: true });
  }
  if (pending) {
    log.info("post-merge note added to the plan's operator step", { ...fields, issue_id: issueId, position: pending.position });
    return "merged-into-step";
  }
  const entry = await db.appendIssuePlannedPR(issueId, { repo: where.repo, title: POST_MERGE_STEP_TITLE });
  log.info("post-merge note appended as an operator step", { ...fields, issue_id: issueId, position: entry.position });
  return "appended";
}

/** The follow-up issue's title: the merged PR and the note's first sentence. */
export function followUpTitle(prRepo: string, prNumber: number, note: string): string {
  const sentence = firstSentenceOfStep(note) ?? note.trim();
  return `Operator step after ${prRepo}#${prNumber} merged: ${sentence}`.slice(0, 200).trim();
}

/** The follow-up issue's dedupe key, one per merged PR. */
export function followUpDedupeKey(prRepo: string, prNumber: number): string {
  return `post-merge-action-${prRepo.replace("/", "-")}-${prNumber}`;
}

/**
 * File (or find, by its dedupe key) the Blocked follow-up issue carrying a
 * note the linked issue cannot take, and link it `relates_to` that issue. A
 * failed link is logged, not thrown: the issue body names the original.
 */
async function fileFollowUpIssue(
  prRepo: string,
  prNumber: number,
  note: string,
  originalIssueId: string,
  reason: string,
): Promise<"follow-up-issue"> {
  const fields = { component: COMPONENT, repo: prRepo, pr: prNumber, issue_id: originalIssueId, reason };
  const dedupeKey = followUpDedupeKey(prRepo, prNumber);
  const existing = await clawsIssues.findOpenIssueByDedupeKey(prRepo, dedupeKey);
  if (existing) {
    log.info("post-merge follow-up issue already open", { ...fields, follow_up: existing.id });
    return "follow-up-issue";
  }
  const id = await clawsIssues.createIssue({
    title: followUpTitle(prRepo, prNumber, note),
    body: [
      `${prRepo}#${prNumber} merged with a manual action that must happen after the merge. ` +
        `Its issue #${originalIssueId} could not take it as an operator step (${reason}), so this issue tracks it.`,
      "",
      note,
      "",
      "Close this issue once the step is done.",
    ].join("\n"),
    authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
    repos: [prRepo],
    labels: [LABELS.blocked],
    blockedReason: note,
    source: "automation",
    autoPromote: false,
    dedupeKey,
  });
  log.info("post-merge follow-up issue filed", { ...fields, follow_up: id });
  try {
    await addLink(prRepo, id, "relates_to", originalIssueId, clawsIssues.CLAWS_NATIVE_LOGIN);
  } catch (err) {
    log.warn("post-merge follow-up issue could not be linked", { ...fields, follow_up: id }, err);
  }
  return "follow-up-issue";
}

const MIGRATE_CONCURRENCY = 4;

/**
 * Convert the post-merge actions still recorded on merged PRs' `claws_prs`
 * rows (`db.listPostMergeActionPrs`), then clear each row: an open linked
 * issue takes the note through {@link recordPostMergeStep}; a closed or
 * missing issue is logged at `info` with the note and cleared, since the PR
 * comment already states the action. A row whose conversion fails is logged
 * at `warn` and kept for the next boot. Never throws. Run once at startup
 * (`main-controller.ts`) for rows recorded before post-merge notes became
 * plan steps.
 */
export async function migratePostMergeActions(source = "post-merge-step"): Promise<{ candidates: number; converted: number; cleared: number; failed: number }> {
  const start = performance.now();
  let rows: db.ClawsPrRecord[];
  try {
    rows = await db.listPostMergeActionPrs();
  } catch (err) {
    log.warn("post-merge action migration could not list rows", { component: source }, err);
    return { candidates: 0, converted: 0, cleared: 0, failed: 1 };
  }
  let converted = 0;
  let cleared = 0;
  let failed = 0;
  // Rows for one issue run in order; different issues run concurrently.
  const groups = new Map<string, db.ClawsPrRecord[]>();
  for (const row of rows) {
    const key = row.issueId ?? `${row.repo}#${row.prNumber}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  await mapWithConcurrency([...groups.values()], MIGRATE_CONCURRENCY, async (group) => {
    for (const row of group) await migrateRow(row);
  });
  async function migrateRow(row: db.ClawsPrRecord): Promise<void> {
    const fields = { component: source, repo: row.repo, pr: row.prNumber, issue_id: row.issueId };
    try {
      const reason = row.manualActionReason ?? "";
      const note = reason.startsWith(POST_MERGE_PREFIX) ? reason.slice(POST_MERGE_PREFIX.length).trim() : reason.trim();
      const issue = row.issueId ? await clawsIssues.getIssue(row.issueId) : undefined;
      if (!issue || issue.state !== "open") {
        log.info("post-merge action cleared without an open issue", { ...fields, note, issue_state: issue?.state ?? "none" });
      } else if (note) {
        const outcome = await recordPostMergeStep(row.repo, row.prNumber, note);
        converted++;
        log.info("post-merge action converted", { ...fields, outcome });
      }
      if (await clearPrHold(row.repo, row.prNumber, POST_MERGE_PREFIX)) cleared++;
    } catch (err) {
      failed++;
      log.warn("post-merge action could not be converted", fields, err);
    }
  }
  log.info("post-merge action migration finished", {
    component: source,
    candidates: rows.length,
    converted,
    cleared,
    failed,
    duration_ms: Math.round(performance.now() - start),
  });
  return { candidates: rows.length, converted, cleared, failed };
}
