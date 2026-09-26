import { COMMENT_REF_PATTERN, ISSUE_REF_GUARDED, canonicalCommentRef, compareIssueRefs, isClawsIssueId, type CommentRef, type IssueRef } from "../issue-id.js";
import { createHash } from "node:crypto";
import { LABELS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, isForgejoRepo, hasForgejoRepoForOwner, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { processTextForImages } from "../images.js";
import { RUNNER_POLICY_CONTEXT, HOST_EXECUTION_POLICY, REPO_DOCS_CONTEXT, SHOPPING_MANIFEST_CONTEXT, frontendContext, forgeContext, homeAssistantContext, formatIssueCommentsForPrompt, gitHubIncidentContext, loadRepoAgentDoc } from "./agent-context.js";
import { isHomeAssistantConfigRepo, homeAssistantMcpAvailable } from "../home-assistant.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { type ModelTier, type ProviderWeight } from "../model-selector.js";
import { BLOCKED_PLAN_SENTENCE, extractModelsAttribution, getRecommendedModel, getRecommendedReviewModel, formatDependencySuffix, parseModelPlanLine, parsePlan, type ParsedPlan, type Provider } from "../plan-parser.js";
import { resolveModelPlanCell, setSuggestedPlan, type ModelPlanCell, type ResolvedModelPlanCell } from "../model-plan.js";
import { loadIssuePhaseState, resolveTrackerId, type IssuePhaseState, type OpenPhasePR } from "../planned-prs.js";
import { PLAN_HEADER, stripLeadingPlanHeader, withPlannerRun, getSubmission, getRunRejections, type PlanSubmission, type PlannedPR, type PlannerOutcome, type PlannerStage } from "../planner-runs.js";
import { parseOccurrenceCount } from "../occurrence-tracking.js";
import { stripPlanMarkers, isRequirementsComment } from "../marker-text.js";
import { parseFirstValidJson } from "../json-extract.js";
import { plannerCapabilitiesForRepo } from "../capabilities.js";
import { isRepoMonitored } from "../repo-config.js";
import * as issueLinks from "../issue-links.js";
import { buildPreviewPromptSection, findIssuePreview, syncPreviewsForIssue, uniqueRepos } from "../issue-previews.js";
import { approvedRequirementsOrNull, approvedRequirementsSection, loadApprovedRequirements, requireApprovedRequirements, requirementsHashInput, type ApprovedRequirements, type RequirementsHashFields } from "../approved-requirements.js";

// Defined in planner-runs.ts, which validates plan text and cannot import this
// module; re-exported so every existing import keeps working.
export { PLAN_HEADER, stripLeadingPlanHeader };

export const PLAN_OCCURRENCES_MARKER = "CLAWS_PLAN_OCCURRENCES:";

async function persistProviderModel(taskId: number, provider: Provider, model: string): Promise<void> {
  const results = await Promise.allSettled([
    db.updateTaskProvider(taskId, provider),
    db.updateTaskModel(taskId, model),
  ]);
  for (const r of results) {
    if (r.status === "rejected") log.warn(`[issue-refiner] Could not persist provider/model for task ${taskId}: ${r.reason}`);
  }
}

/**
 * Record the planner's recommended matrix as the issue's *suggested* model
 * plan, which an operator can then override from the dashboard. The
 * `**Model plan:**` line wins; without one, the two older recommendation lines
 * still fill `implement` and `review`. A `plan` or `requirements` cell is
 * dropped: only an operator moves fresh planning or the requirements writer,
 * so the planner cannot steer the runs that feed it.
 * Best-effort — a failed write leaves the agents on their legacy sources, which
 * is no worse than before model plans.
 */
export async function persistSuggestedModelPlan(fullName: string, issueNumber: IssueRef, planText: string): Promise<void> {
  try {
    let cells: ModelPlanCell[] = parseModelPlanLine(planText).filter((c) => c.phase !== "plan" && c.phase !== "requirements");
    if (cells.length === 0) {
      const implement = getRecommendedModel(planText);
      const review = getRecommendedReviewModel(planText);
      cells = [
        ...(implement ? [{ phase: "implement" as const, provider: null, tier: implement }] : []),
        ...(review ? [{ phase: "review" as const, provider: null, tier: review }] : []),
      ];
    }
    await setSuggestedPlan(fullName, issueNumber, cells);
  } catch (err) {
    log.warn(`[issue-refiner] Could not record the suggested model plan for ${fullName}#${issueNumber}: ${err}`);
  }
}

function occurrenceMarkerFor(issueBody: string): string {
  const n = parseOccurrenceCount(issueBody ?? "");
  return n === null ? "" : `\n\n${PLAN_OCCURRENCES_MARKER} ${n}`;
}

export function parsePlannedOccurrences(planBody: string): number | null {
  const m = planBody.match(/CLAWS_PLAN_OCCURRENCES:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Hash of the issue title+body the plan was written against (#2524). */
export const PLAN_BODY_HASH_MARKER = "CLAWS_PLAN_BODY_HASH:";
/** Highest issue-comment id the plan run had seen when it started (#2524). */
export const PLAN_LAST_COMMENT_MARKER = "CLAWS_PLAN_LAST_COMMENT:";
/**
 * Stamped on a plan comment when the planner's step-back pass returned `reconsider`
 * (#3091). Read by both the refiner and the dispatcher's Phase 2 auto-refine path to
 * withhold auto-applying `Refined` so a human reviews the plan first.
 */
export const STEP_BACK_RECONSIDER_MARKER = "CLAWS_PLAN_STEP_BACK: reconsider";

/**
 * Stamped on the notice posted when `Refined` is stripped because human feedback
 * after the plan has not been addressed yet. Keyed to the newest unaddressed
 * comment id so a later round of feedback posts a fresh notice rather than being
 * suppressed by the previous one (same reasoning as issue-worker's
 * STALE_PLAN_MARKER, which keys on the plan body hash).
 */
export const PENDING_FEEDBACK_MARKER = "CLAWS_REFINED_PENDING_FEEDBACK";

/**
 * Stamped on the notice `trackRequirementsUpgradeStall` posts/updates when a
 * plan predating its approved requirements record keeps failing to upgrade —
 * an empty/degenerate refinement, or one whose output still has a
 * `### Requirement` section. Keyed to the record version, so a newly
 * re-approved record starts the count over, and carries the number of
 * consecutive failed attempts.
 */
export const REQUIREMENTS_UPGRADE_STALLED_MARKER = "CLAWS_REQUIREMENTS_UPGRADE_STALLED";

/**
 * How many consecutive stalled upgrade attempts `trackRequirementsUpgradeStall`
 * tolerates before giving up. Each attempt is a full planner run that strips
 * `Ready`, so an unbounded retry would spend one every dispatcher tick
 * forever on an issue whose refine model keeps returning unusable output.
 */
export const MAX_REQUIREMENTS_UPGRADE_ATTEMPTS = 3;

/** Why an upgrade attempt didn't stamp the record — see {@link trackRequirementsUpgradeStall}. */
type RequirementsUpgradeStallReason = "empty" | "requirement-section-kept";

function requirementsUpgradeStallMarkerRe(version: number): RegExp {
  return new RegExp(`${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v${version} attempts=(\\d+)`);
}

function findRequirementsUpgradeStallNotice(comments: readonly gh.IssueComment[], version: number): gh.IssueComment | undefined {
  const markerRe = requirementsUpgradeStallMarkerRe(version);
  return [...comments].reverse().find((c) => gh.isClawsComment(c.body) && markerRe.test(c.body));
}

/**
 * Record one more failed attempt to upgrade a pre-record plan against its
 * approved requirements record, and report whether the caller should give up
 * (stamp the record anyway, without a rewrite, so the dispatcher stops
 * re-queueing) rather than retry again. Posts a single notice comment on the
 * issue and edits it in place on later attempts, rather than spamming a new
 * comment per stalled tick.
 *
 * `reason` distinguishes an empty/degenerate rewrite from one that produced
 * real output but kept the plan's old `### Requirement` section — the notice
 * text must not claim the upgrade "produced no usable output" when it did.
 */
async function trackRequirementsUpgradeStall(
  fullName: string,
  issueNumber: IssueRef,
  requirements: ApprovedRequirements,
  comments: readonly gh.IssueComment[],
  reason: RequirementsUpgradeStallReason,
  /**
   * True for a plan with no earlier version to predate the record — a fresh
   * plan, or the first re-plan of a pre-record issue. Only changes the
   * non-give-up notice's wording (#3388 finding 2): "predates" is false when
   * there was never an earlier plan.
   */
  isFresh: boolean,
): Promise<{ gaveUp: boolean; postNotice: () => Promise<void> }> {
  const markerRe = requirementsUpgradeStallMarkerRe(requirements.version);
  const existing = findRequirementsUpgradeStallNotice(comments, requirements.version);
  const priorAttempts = existing ? Number(existing.body.match(markerRe)![1]) : 0;
  // A streak that already gave up (#3388 finding 7) restarts rather than
  // incrementing forever — otherwise the notice reports "after 4 attempts"
  // against a cap of 3 on the very next stalled tick.
  const attempts = priorAttempts >= MAX_REQUIREMENTS_UPGRADE_ATTEMPTS ? 1 : priorAttempts + 1;
  const gaveUp = attempts >= MAX_REQUIREMENTS_UPGRADE_ATTEMPTS;
  const notice = `${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v${requirements.version} attempts=${attempts}`;
  const whatHappened = reason === "requirement-section-kept"
    ? `kept its "### Requirement" section instead of removing it`
    : `produced no usable output`;
  const text = (gaveUp
    ? [
        `Claws gave up automatically upgrading this plan against approved requirements v${requirements.version} after ${attempts} attempts each ${whatHappened}.`,
        ``,
        `The plan has been stamped as current against v${requirements.version} anyway, so it stops being re-planned on every tick — but its text ${reason === "requirement-section-kept" ? `still has the "### Requirement" section and no version citation` : `was never actually rewritten to drop the "### Requirement" section or cite the version`}. Please check it by hand, or leave feedback to trigger a fresh refinement.`,
      ]
    : [
        isFresh
          ? `This plan kept a "### Requirement" section although the issue has an approved requirements record (v${requirements.version}). The automatic upgrade to rewrite it has ${whatHappened} for ${attempts} attempt(s) in a row and will keep being retried on the next dispatcher tick.`
          : `This issue's plan predates its approved requirements record (v${requirements.version}). The automatic upgrade to rewrite it has ${whatHappened} for ${attempts} attempt(s) in a row and will keep being retried on the next dispatcher tick.`,
      ]
  ).concat(``, notice).join("\n");
  const postNotice = async () => {
    try {
      if (existing) {
        await gh.editIssueComment(fullName, existing.id, text, { agentName: "Planner" });
      } else {
        await gh.commentOnIssue(fullName, issueNumber, text, { agentName: "Planner" });
      }
    } catch (err) {
      log.warn(`[issue-refiner] Could not record the requirements-upgrade-stall notice for ${fullName}#${issueNumber}: ${err}`);
    }
  };
  return { gaveUp, postNotice };
}

/**
 * Clear a prior stalled-upgrade notice once a plan is successfully stamped
 * against `requirements` — otherwise a later stall (after a human edit brings
 * back the old contract) resumes counting from the earlier streak, and the
 * notice's "in a row" wording stops being true. A no-op when there is no
 * notice to clear.
 */
async function resetRequirementsUpgradeStall(
  fullName: string,
  issueNumber: IssueRef,
  requirements: ApprovedRequirements,
  comments: readonly gh.IssueComment[],
): Promise<void> {
  const existing = findRequirementsUpgradeStallNotice(comments, requirements.version);
  if (!existing) return;
  const markerRe = requirementsUpgradeStallMarkerRe(requirements.version);
  const priorAttempts = Number(existing.body.match(markerRe)![1]);
  if (priorAttempts === 0) return; // already reset — avoid editing it again on every successful plan
  const text = [
    `This plan was successfully upgraded to cite approved requirements v${requirements.version} — the stalled-upgrade count above no longer applies.`,
    ``,
    `${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v${requirements.version} attempts=0`,
  ].join("\n");
  try {
    await gh.editIssueComment(fullName, existing.id, text, { agentName: "Planner" });
  } catch (err) {
    log.warn(`[issue-refiner] Could not reset the requirements-upgrade-stall notice for ${fullName}#${issueNumber}: ${err}`);
  }
}

/**
 * The requirements record to stamp a freshly-produced plan against — shared by
 * every site that posts/edits a plan whose text should reflect the approved
 * record. `requirements === null` (no record) always stamps body-only. With a
 * record, a plan that dropped the pre-record `### Requirement` section stamps
 * against the record (and clears any stalled-upgrade notice); one that kept it
 * goes through {@link trackRequirementsUpgradeStall} instead — stamped body-only
 * while there is still a chance the next tick's retry fixes it, or against the
 * record once the stall cap gives up. Kept as one helper so the sites that call
 * it can't drift apart on how they treat a `### Requirement` section left behind
 * by a model ignoring the prompt's instruction to remove it.
 */
async function requirementsStampFor(
  fullName: string,
  issueNumber: IssueRef,
  planText: string,
  requirements: ApprovedRequirements | null,
  comments: readonly gh.IssueComment[],
  /**
   * True for a fresh plan (no earlier plan this issue could predate) — see
   * {@link trackRequirementsUpgradeStall}'s `isFresh` parameter. Ignored when no
   * notice ends up posted (dropped section, or no record at all).
   */
  isFresh: boolean,
): Promise<{
  /** The requirements record to stamp the plan against, if any. */
  stamp: ApprovedRequirements | null;
  /** Deferred so callers can post the plan comment this notice refers to first (#3388 finding 2). */
  postNotice: () => Promise<void>;
}> {
  const noNotice = async () => {};
  if (requirements === null) return { stamp: null, postNotice: noNotice };
  if (!/^### Requirement\s*$/m.test(planText)) {
    return { stamp: requirements, postNotice: () => resetRequirementsUpgradeStall(fullName, issueNumber, requirements, comments) };
  }
  const { gaveUp, postNotice } = await trackRequirementsUpgradeStall(fullName, issueNumber, requirements, comments, "requirement-section-kept", isFresh);
  log.warn(`[issue-refiner] Plan for ${fullName}#${issueNumber} still has a "### Requirement" section despite an approved record — ${gaveUp ? "giving up and stamping against the record anyway" : "stamped body-only so the next tick retries the upgrade"}`);
  return { stamp: gaveUp ? requirements : null, postNotice };
}

function stripTrailingOccurrenceBlock(body: string): string {
  return body.replace(/\n*(?:---\n)?\*\*First seen:\*\* .*\n\*\*Last seen:\*\* .*\n\*\*Occurrences:\*\* \d+\s*$/, "");
}

/**
 * True for a consolidated alert-bridge body (fleet-infra's and production-infra's
 * grafana-github-alerts bridge): one issue per repo, one `### <alertname>` section per
 * alert, fully re-rendered on every firing/resolve. Detected structurally by the two
 * section headings the bridge always emits, so it doesn't depend on the bridge's wording
 * or name.
 */
export function isConsolidatedAlertBody(body: string): boolean {
  return /^## Currently firing[ \t]*$/m.test(body) && /^## Alerts[ \t]*$/m.test(body);
}

/**
 * Strips the parts of a body that change on every delivery without representing a real
 * edit: the trailing Claws occurrence block always, and — only for a consolidated
 * alert-bridge body — the `## Currently firing` list, the per-section Status/Last
 * occurrence/Occurrences/Resolved rows, the carried-over-count line, and the
 * Summary/Description lines (Grafana templates live values into those annotations).
 * What survives for a bridge body is the `### <alertname>` heading and its stable rows
 * (Severity, First occurrence, Source), so only a new/removed section or a human edit
 * changes the hash.
 */
function stripVolatileBody(body: string): string {
  const stripped = stripTrailingOccurrenceBlock(body);
  if (!isConsolidatedAlertBody(stripped)) return stripped;
  return stripped
    .replace(/^## Currently firing[ \t]*\n(?:(?!^## ).*\n?)*/m, "")
    .replace(/^\|[ \t]*(?:Status|Last occurrence|Occurrences|Resolved)[ \t]*\|.*\n?/gm, "")
    .replace(/^Occurrences carried over from an unparseable earlier body: \d+[ \t]*\n?/gm, "")
    .replace(/^\*\*Summary:\*\*.*\n?/gm, "")
    .replace(/^\*\*Description:\*\*.*\n?/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * The plan's `CLAWS_PLAN_BODY_HASH`. With an approved requirements record its
 * content is appended to the hash input, so re-approving an edited record
 * stales the plan the way a body edit does; with none the input is exactly
 * the title and body, so plans stamped without a record stay valid.
 */
export function issueContentHash(title: string, body: string | null | undefined, requirements?: RequirementsHashFields | null): string {
  const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  const record = requirements ? `\n\nrequirements:${requirementsHashInput(requirements)}` : "";
  return createHash("sha256")
    .update(`${norm(title ?? "")}\n\n${norm(stripVolatileBody(body ?? ""))}${record}`)
    .digest("hex");
}

/** Last match wins — a plan whose prose quotes the marker must not beat our trailing one. */
export function parsePlanBodyHash(planBody: string): string | null {
  const ms = [...planBody.matchAll(/CLAWS_PLAN_BODY_HASH:\s*([0-9a-f]{64})/g)];
  return ms.length ? ms[ms.length - 1][1] : null;
}

const PLAN_LAST_COMMENT_RE = new RegExp(`CLAWS_PLAN_LAST_COMMENT:\\s*(${COMMENT_REF_PATTERN})`, "g");

export function parsePlanLastCommentId(planBody: string): CommentRef | null {
  const ms = [...planBody.matchAll(PLAN_LAST_COMMENT_RE)];
  return ms.length ? canonicalCommentRef(ms[ms.length - 1][1]!) : null;
}

/**
 * Single source of truth for "the issue moved on since this plan was written".
 * False for legacy plans (no marker) and for Claws-maintained alert issues, whose
 * bodies ensureAlertIssue rewrites every tick — see REPLAN_OCCURRENCE_FACTOR. A
 * consolidated alert-bridge body (isConsolidatedAlertBody) is the one exception to that
 * occurrence-count skip: its body is also rewritten every tick, but issueContentHash
 * already strips its volatile parts, so the hash comparison below is meaningful and a
 * new/removed alert section or a human edit still counts as stale.
 *
 * `requirements` is the issue's approved requirements record, when it has one:
 * re-approving it with different content stales the plan too.
 */
export function isPlanStaleForIssue(planBody: string, title: string, body: string, requirements?: RequirementsHashFields | null): boolean {
  if (parseOccurrenceCount(body ?? "") !== null && !isConsolidatedAlertBody(body ?? "")) return false;
  const stamped = parsePlanBodyHash(planBody);
  if (stamped === null) return false;
  return stamped !== issueContentHash(title, body, requirements);
}

/**
 * Trailing markers for every posted/edited plan comment.
 *
 * `hashOverride`, when given, is stamped verbatim in place of
 * `issueContentHash(content.title, content.body, content.requirements)` — for
 * a re-stamp that cannot tell whether the plan text was ever rewritten
 * against `content.requirements` and must preserve the existing hash rather
 * than guess (see the "unchanged" case in `processRefinement`'s empty/degenerate
 * branch).
 */
export function planMarkersFor(content: { title: string; body: string; requirements?: RequirementsHashFields | null }, lastCommentId: CommentRef, opts?: { stepBackReconsider?: boolean; hashOverride?: string }): string {
  const parts = [
    occurrenceMarkerFor(content.body).trim(),
    `${PLAN_BODY_HASH_MARKER} ${opts?.hashOverride ?? issueContentHash(content.title, content.body, content.requirements)}`,
    `${PLAN_LAST_COMMENT_MARKER} ${lastCommentId}`,
    opts?.stepBackReconsider ? STEP_BACK_RECONSIDER_MARKER : "",
  ];
  return `\n\n${parts.filter(Boolean).join("\n")}`;
}

// Moved to marker-text.ts so db.ts can normalise plan versions without
// importing the refiner; re-exported so every existing import keeps working.
export { stripPlanMarkers };

/**
 * True when the trailing marker block of a plan comment carries
 * `STEP_BACK_RECONSIDER_MARKER` — never when the marker merely appears in the
 * plan's own prose (#3091).
 */
export function hasStepBackReconsiderMarker(planBody: string): boolean {
  const trailing = planBody.slice(stripPlanMarkers(planBody).length);
  return trailing.split("\n").map((l) => l.trim()).includes(STEP_BACK_RECONSIDER_MARKER);
}

/**
 * Highest comment id in a run's snapshot, or 0 when the snapshot was empty.
 *
 * 0 (not null) is load-bearing. It is below every real GitHub comment id, so a
 * plan stamped `CLAWS_PLAN_LAST_COMMENT: 0` makes selectFeedbackCandidates()
 * treat EVERY comment on the issue as post-snapshot feedback — correct, because
 * the run saw none. Omitting the marker instead (the pre-#2623 behaviour) made
 * selectFeedbackCandidates fall back to its legacy "after the plan comment only"
 * slice, so a comment posted while the planner ran on a brand-new issue was
 * permanently invisible (home-assistant-config#416: the owner had to repost the
 * same instruction after the plan landed to get it honoured).
 */
/** The newest comment id, by {@link compareIssueRefs} — native ids are strings. */
function maxCommentId(comments: gh.IssueComment[]): CommentRef {
  return comments.reduce<CommentRef>((max, c) => (compareIssueRefs(c.id, max) > 0 ? c.id : max), 0);
}

function isDeepPlan(issue: gh.Issue): boolean {
  return issue.labels.some((l) => l.name === LABELS.planDeep);
}

/**
 * The provider, tier and model a planner run uses, from the issue's model plan
 * (docs/model-selection.md). A fresh plan (`plan`) defaults to claude/fable and a
 * re-plan (`plan-refine`) to claude/opus; `Plan: Deep` asks for `fable` below
 * any model-plan cell. A `followUp` answer to a question comment also reads the
 * `plan-refine` cell, but falls back to `sonnet` and ignores `Plan: Deep` — it is
 * Q&A, not re-planning. `deepThinking` follows the resolved tier, not the label,
 * so an operator who picks fable gets the maximum reasoning effort too.
 * `deepContext` — whether the prompt gets {@link DEEP_PLANNING_CONTEXT} — needs
 * both the label and a resolved `fable` tier, since that text tells the model it
 * was labelled and is running on the best model.
 */
async function planModelForIssue(
  issue: gh.Issue,
  fullName: string,
  phase: "plan" | "plan-refine",
  options: { followUp?: boolean } = {},
): Promise<ResolvedModelPlanCell & { deepThinking: boolean; deepContext: boolean }> {
  const labelDeep = !options.followUp && isDeepPlan(issue);
  const resolved = await resolveModelPlanCell(fullName, issue.number, phase, {
    ...(options.followUp ? { tier: "sonnet" as const } : labelDeep ? { tier: "fable" as const, tierSource: "label" as const } : {}),
    labels: issue.labels,
    requiresMcp: homeAssistantMcpAvailable(fullName),
  });
  return { ...resolved, deepThinking: resolved.tier === "fable", deepContext: labelDeep && resolved.tier === "fable" };
}

export const MAX_DUPLICATE_CANDIDATES = 20;
export const DUPLICATE_CANDIDATE_BODY_LIMIT = 500;

/**
 * Soft ceiling for a posted plan body, in characters — the size quoted to the
 * planner as the outer limit before an operator warning fires. `IMPLEMENTER_GUIDANCE_INSTRUCTIONS`
 * targets roughly half of this (about 1,500 words), so an ordinary plan lands well
 * under it and only real outliers trip the warning.
 */
export const PLAN_LENGTH_WARN_CHARS = 18_000;

export const PLAN_LENGTH_WARN_SENTINEL = "well above the concise planning target";

function planLengthWarning(len: number): string {
  return `> [!WARNING]\n> This plan is ${len.toLocaleString()} characters — ${PLAN_LENGTH_WARN_SENTINEL} (soft limit ${PLAN_LENGTH_WARN_CHARS.toLocaleString()} chars). A plan this long usually means detail that belongs in the code, not the plan. Consider commenting with feedback to request a more concise re-plan.`;
}

async function warnIfPlanTooLong(
  fullName: string,
  issueNumber: IssueRef,
  length: number,
  label: string,
  existingComments: gh.IssueComment[] = [],
): Promise<void> {
  if (length <= PLAN_LENGTH_WARN_CHARS) return;
  if (existingComments.some((c) => gh.isClawsComment(c.body) && c.body.includes(PLAN_LENGTH_WARN_SENTINEL))) {
    log.info(`[issue-refiner] ${label} for ${fullName}#${issueNumber} is over the soft limit but a warning comment already exists — not reposting`);
    return;
  }
  log.warn(`[issue-refiner] ${label} for ${fullName}#${issueNumber} is ${length} chars — exceeds ${PLAN_LENGTH_WARN_CHARS} char soft limit`);
  await gh.commentOnIssue(fullName, issueNumber, planLengthWarning(length), { agentName: "Planner" });
}

/**
 * Prompt text describing the planner tools THIS run may call
 * (src/planner-tools.ts). Replaces the verdict file (#3155) and the output file
 * for planner runs: a tool call is validated as it is made, so a malformed
 * result comes back to the agent as an error it can fix rather than being lost.
 *
 * An outcome is described only when the prompt section that makes it legal was
 * actually injected: `duplicate` needs "Possible Duplicate Candidates",
 * `transfer` needs "Repository Routing". The run's allow-lists reject anything
 * else anyway, but a model pointed at an absent section would have spent the
 * run on a short non-plan paragraph. `blocked` and `no_code_changes` need no
 * section and are offered whenever `outcomes` is true — a refinement pass, or a
 * fresh plan written from the refinement flow, is plan-only.
 */
export function plannerToolDocs(opts: { actingRepo: string; issueRepos?: readonly string[]; duplicates: boolean; transfer: boolean; outcomes: boolean; response?: boolean }): string {
  const lines = [
    `HOW YOUR RESULT IS COLLECTED — read this last and follow it exactly:`,
    ``,
    opts.outcomes
      ? `Before you finish, call exactly one of the Claws MCP tools \`claws_save_plan\` or \`claws_report_outcome\`. Claws posts nothing until you finish, and then it posts what the tool recorded — not your chat messages.`
      : `Before you finish, call the Claws MCP tool \`claws_save_plan\`. Claws posts nothing until you finish, and then it posts what the tool recorded — not your chat messages. This pass cannot report an outcome.`,
    ``,
    `claws_save_plan fields:`,
    `- \`plan\`: the complete plan text, in the section format above.`,
    `- \`prs\`: the PRs the plan needs, in merge order — one {repo, title} entry per \`### PR N:\` section, in order, or exactly one entry for a single-PR plan. ${prsRepoRule(opts.actingRepo, opts.issueRepos)} \`title\` is the short title from that PR's header, without its dependency suffix. Optional \`depends_on\`: the earlier positions this PR must land after, matching the header's suffix — omit it for "after the previous PR", \`[]\` for independent.`,
    `- \`implementation_model\` and \`review_model\`: your model recommendations (see above).`,
    `- \`target_pr\`: only when the work must land on an already-open PR's branch (see above).`,
    ...(opts.response ? [`- \`response\`: your reply to the feedback (see above).`] : []),
    `Put the model choices, the target PR${opts.response ? " and the reply" : ""} in these fields, never in the plan text. If the tool returns an error, fix the input and call it again; a later call replaces the earlier plan.`,
  ];
  if (opts.outcomes) {
    lines.push(``, `claws_report_outcome — only when the issue should NOT get a plan. \`explanation\` is your short paragraph. The outcomes you may report:`);
    if (opts.duplicates) lines.push(`- \`duplicate\`, with \`duplicate_of\`: shares a root cause with a lower-numbered issue listed under "Possible Duplicate Candidates".`);
    if (opts.transfer) lines.push(`- \`transfer\`, with \`transfer_to\`: unambiguously belongs to a repository listed under "Repository Routing".`);
    lines.push(
      `- \`blocked\`: gated on a verifiable external precondition you checked today and confirmed is still unmet.`,
      `- \`no_code_changes\`: needs no change to any file tracked in this repository.`,
      `If none of these applies — the ordinary case — save a plan instead.`,
    );
  }
  lines.push(
    ``,
    `Never run a shell command in the background and never finish with a background task still running:`,
    `when it completes you are re-invoked. Run long commands in the foreground and wait for them.`,
  );
  return lines.join("\n");
}

/**
 * What a `prs[].repo` may be: the acting repo, or — for an issue naming
 * several repos — any of them. Mirrors the planner run's `allowedRepos`.
 */
function prsRepoRule(actingRepo: string, issueRepos: readonly string[] | undefined): string {
  if (!issueRepos || issueRepos.length < 2) return `\`repo\` must be ${actingRepo};`;
  return `\`repo\` is the repository the PR is opened in, and may be any of this issue's repositories: ${issueRepos.join(", ")};`;
}

/**
 * The prompt section for an issue naming several repositories, or "" for one.
 * The planner runs in the primary repo's worktree; the others are read over
 * the API. Self-contained: "Claws-managed repositories" is absent from the
 * step-back prompt and from a GitHub-only owner's prompts.
 */
export function issueReposSection(actingRepo: string, issueRepos: readonly string[]): string {
  if (issueRepos.length < 2) return "";
  return [
    ``,
    `## This issue's repositories`,
    ``,
    `This issue names several repositories: ${issueRepos.join(", ")}.`,
    `${actingRepo} is its primary repository — the worktree you are in, and where the issue is planned and tracked. Read the others over the API before planning changes to them: on GitHub, \`gh api repos/OWNER/NAME/contents/PATH\`; on Forgejo, \`curl -sH "Authorization: token $CLAWS_FORGEJO_READ_TOKEN" "$CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/raw/PATH"\` (or \`contents/DIR\` to list a directory). If \`gh\` returns 404 for one of these repositories, it is on Forgejo.`,
    `The plan may need PRs in any of these repositories. Give each PR in the plan the repository it is opened in: one \`prs\` entry per PR, in merge order, each with its own \`repo\`. PRs merge one at a time, whichever repository they are in, so order them so each can land before the next starts. Do NOT plan a companion issue in any of these repositories — plan a PR entry in that repository instead.`,
  ].join("\n");
}

/**
 * The repos a planner run may name in `prs[].repo`: a native issue's repos
 * that Claws manages and monitors, or the acting repo alone for a forge issue
 * (and for a native issue whose record cannot be read). Filtering here makes
 * `claws_save_plan` reject a step in an unmanaged repo while the planner can
 * still fix it, instead of the implementer stopping on it after approval. The
 * acting repo is always allowed; a failed listing leaves the issue's repos
 * unfiltered, and the implementer still refuses an unmanaged one.
 */
export async function plannerAllowedRepos(fullName: string, issueRef: IssueRef): Promise<string[]> {
  if (!isClawsIssueId(issueRef)) return [fullName];
  let repos: string[] = [];
  try {
    repos = (await db.getClawsIssue(issueRef))?.repos ?? [];
  } catch (err) {
    log.warn(`[issue-refiner] Could not read the repos of ${issueRef} — the plan may name ${fullName} only: ${err}`);
  }
  if (repos.length === 0) return [fullName];
  try {
    const managed = await gh.listRepos();
    // A degraded listing may be missing a managed repo; leave the list unfiltered.
    if (managed.length > 0 && !gh.isRepoListDegraded()) {
      repos = repos.filter((r) => r.toLowerCase() === fullName.toLowerCase()
        || (managed.some((m) => m.fullName.toLowerCase() === r.toLowerCase()) && isRepoMonitored(r)));
    }
  } catch (err) {
    log.warn(`[issue-refiner] Could not list managed repos — the plan may name any of ${issueRef}'s repos: ${err}`);
  }
  if (!repos.some((r) => r.toLowerCase() === fullName.toLowerCase())) repos = [...repos, fullName];
  return [...repos].sort();
}

/** Lines Claws renders from tool fields, stripped from the agent's plan text so
 *  it cannot carry a second, conflicting copy. */
const RENDERED_LINE_RE = /^[ \t]*(?:\*\*Recommended (?:implementation|review) model:\*\*.*|CLAWS_TARGET_PR:\s*#?\d+[ \t]*)$\n?/gim;

/**
 * The plan comment body for a `claws_save_plan` submission: the plan text, the
 * two `**Recommended … model:**` lines and, when set, `CLAWS_TARGET_PR: #N` on
 * the last line — the text planners used to write themselves, so plan-parser's
 * readers are unchanged.
 */
export function renderPlanBody(submission: PlanSubmission): string {
  const text = submission.plan.replace(RENDERED_LINE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return [
    text,
    ``,
    `**Recommended implementation model:** \`${submission.implementationModel}\``,
    `**Recommended review model:** \`${submission.reviewModel}\``,
    ...(submission.targetPr !== null ? [``, `CLAWS_TARGET_PR: #${submission.targetPr}`] : []),
  ].join("\n");
}

/** What one planner invocation produced. */
export interface PlannerRunResult {
  outcome: PlannerOutcome | null;
  /** Text to post: the rendered plan, the outcome's explanation, or the final-message fallback. */
  text: string;
  /** The PR list from `claws_save_plan`, or null on the fallback path. */
  prs: PlannedPR[] | null;
  response: string | null;
  degenerate: boolean;
}

/** A `CLAWS_TARGET_PR:` line in fallback text — only the `target_pr` tool field may set one. */
const FALLBACK_TARGET_PR_LINE_RE = /^[ \t]*CLAWS_TARGET_PR:\s*#?\d+[ \t]*$\n?/gim;

/**
 * Read a finished run's submission. With none, the plan text falls back to the
 * CLI's final assistant message, with no PR list — an outcome is never inferred
 * from silence (a destructive label is only ever applied on an explicit call).
 * The fallback drops any `CLAWS_TARGET_PR:` line (a refinement may echo the old
 * plan's) and, in the refine stage, splits a trailing `### Response` section off
 * into `response` so the reply is never written into the plan comment.
 */
function readPlannerRun(runId: string, output: string, label: string, stage: Exclude<PlannerStage, "step_back">): PlannerRunResult {
  const sub = getSubmission(runId);
  if (sub?.kind === "plan") return { outcome: null, text: renderPlanBody(sub), prs: sub.prs, response: sub.response, degenerate: false };
  if (sub?.kind === "outcome") return { outcome: sub.outcome, text: sub.explanation, prs: null, response: null, degenerate: false };
  // The final-message fallback is for a planner that never used the tools. One
  // that called them and was refused every time has a plan it could not hand
  // over, and its final message is a complaint about that, not a plan — fail
  // the run rather than publish it (#clw_01M3A42ZTGECAB11S0BZA6NG1A).
  const rejections = getRunRejections(runId);
  if (rejections.count > 0) {
    const message = `${label}: every planner tool call was rejected (${rejections.count} call${rejections.count === 1 ? "" : "s"}, last: ${rejections.last}) — refusing to publish the final message as a plan`;
    log.error(`[issue-refiner] ${message}`);
    throw new Error(message);
  }
  log.warn(`[issue-refiner] ${label}: the planner never called claws_save_plan — falling back to its final message, with no stored PR list`);
  let planText = output;
  let response: string | null = null;
  if (stage === "refine") {
    const match = output.match(/^### Response\s*\n([\s\S]*)$/m);
    if (match) {
      planText = output.slice(0, match.index);
      response = match[1].trim() || null;
    }
  }
  const text = stripLeadingPlanHeader(planText.replace(FALLBACK_TARGET_PR_LINE_RE, ""));
  return { outcome: null, text, prs: null, response, degenerate: isDegeneratePlanOutput(text) };
}

/**
 * Run one planner invocation inside its own planner run, with an MCP config
 * that carries that run's id. Each call is a fresh run, so a retry never sees
 * the previous attempt's submission.
 */
async function invokePlanner(
  opts: {
    repo: Repo;
    issueRef: IssueRef;
    wtPath: string;
    stage: Exclude<PlannerStage, "step_back">;
    allowedRepos: string[];
    allowedDuplicates?: IssueRef[];
    allowedTransfers?: string[];
    allowOutcomes?: boolean;
    label: string;
  },
  run: (mcpConfig: string) => Promise<string>,
): Promise<PlannerRunResult> {
  const fullName = opts.repo.fullName;
  const allowedDuplicates = opts.allowedDuplicates ?? [];
  const allowedTransfers = opts.allowedTransfers ?? [];
  return await withPlannerRun({
    repo: fullName,
    issueRef: opts.issueRef,
    stage: opts.stage,
    allowedRepos: opts.allowedRepos,
    allowedDuplicates,
    allowedTransfers,
    allowOutcomes: opts.allowOutcomes ?? true,
  }, async (runId) => {
    const mcpConfig = claude.writeAgentMcpConfig(opts.wtPath, {
      includeHomeAssistant: isHomeAssistantConfigRepo(fullName),
      plannerRun: {
        id: runId,
        stage: opts.stage,
        offers: [...(allowedDuplicates.length > 0 ? ["duplicate" as const] : []), ...(allowedTransfers.length > 0 ? ["transfer" as const] : [])],
        allowOutcomes: opts.allowOutcomes ?? true,
      },
      fileSuffix: opts.stage,
    });
    const output = await run(mcpConfig);
    return readPlannerRun(runId, output, `${opts.label} for ${fullName}#${opts.issueRef}`, opts.stage);
  });
}

/**
 * Write the final plan's PR list onto the issue's tracker record, after the
 * plan comment is posted. `prs === null` (no `claws_save_plan` call) keeps a
 * stored list whose length still matches the new text's `### PR N:` count —
 * its PR links cannot be rebuilt once deleted — and otherwise clears it so the
 * legacy `### PR N:` accounting applies again. Best-effort: a failure leaves
 * the previous list, and is logged.
 */
async function recordPlannedPRs(fullName: string, issue: gh.Issue, planBody: string, prs: PlannedPR[] | null): Promise<void> {
  try {
    const trackerId = await resolveTrackerId(fullName, issue.number, prs
      ? { title: issue.title, body: issue.body ?? "", authorLogin: issue.author?.login ?? "claws", labels: issue.labels.map((l) => l.name) }
      : undefined);
    if (!trackerId) return;
    const headers = parsePlan(planBody).totalPhases;
    if (!prs) {
      const existing = await db.getIssuePlannedPRs(trackerId);
      if (existing.length === 0) return;
      if (existing.length === headers) {
        log.warn(`[issue-refiner] ${fullName}#${issue.number}: the planner saved no PR list — keeping the stored ${existing.length}-entry list, which still matches the plan text`);
        return;
      }
    } else if (headers !== prs.length) {
      // claws_save_plan rejects a mismatch, so this is only a safety net.
      log.warn(`[issue-refiner] ${fullName}#${issue.number}: the saved PR list has ${prs.length} entr${prs.length === 1 ? "y" : "ies"} but the plan text has ${headers} \`### PR N:\` section(s) — storing the list anyway`);
    }
    const dropped = await db.replaceIssuePlannedPRs(trackerId, prs ?? []);
    for (const d of dropped) {
      log.warn(`[issue-refiner] ${fullName}#${issue.number}: step ${d.position} (${d.repo}#${d.prNumber}, "${d.title}") is no longer in the plan's PR list — that PR is no longer tracked`);
    }
  } catch (err) {
    log.warn(`[issue-refiner] Could not store the planned-PR list for ${fullName}#${issue.number}: ${err}`);
  }
}

/** "PRs already recorded" section of a refinement prompt, from a stored list. */
function recordedPRsNote(state: IssuePhaseState): string {
  if (!state.entries) return "";
  const rows = state.entries.map((e) => {
    const pr = state.coverage.coveringPRs.get(e.position);
    const link = pr
      ? `PR #${pr.number} (${pr.state})`
      : state.coverage.done.has(e.position) ? "claimed done" : e.prNumber !== null ? `PR #${e.prNumber}` : "no PR yet";
    const deps = state.coverage.dependencies.get(e.position) ?? [];
    const after = deps.length === 0 ? "independent" : `after ${deps.join(", ")}`;
    return `- ${e.position}. ${e.repo} — ${e.title} — ${after} — ${link}`;
  });
  return [
    ``,
    ``,
    `PRs already recorded for this issue (position. repo — title — dependencies — linked PR):`,
    ...rows,
    ``,
    `Keep every merged entry at its position, in the same repo, in your \`prs\` list, and keep its \`### PR N:\` header in place — Claws tracks shipped work by position.`,
  ].join("\n");
}

export const TRANSFERRED_FROM_MARKER = "CLAWS_TRANSFERRED_FROM:";
/**
 * Header for the routing comment. MUST NOT contain PLAN_HEADER: comments travel with a
 * transferred issue, and every "has this issue been planned?" check in the pipeline
 * (findUnreactedFeedbackAfterPlan, work-handlers.ts, plan-parser.findPlanComment) tests
 * for PLAN_HEADER. A PLAN_HEADER here would make the destination treat the issue as
 * already planned and never re-plan it.
 */
export const TRANSFER_HEADER = "## Repository Transfer";
export const MAX_TRANSFER_CANDIDATES = 30;

/** Kill switch — read at call time, mirroring stepBackEnabled(). */
export function transferEnabled(): boolean {
  return process.env["CLAWS_PLANNER_TRANSFER"] !== "false";
}

/** Source repo recorded by a `CLAWS_TRANSFERRED_FROM: owner/repo#123` stamp, or null. */
const TRANSFERRED_FROM_RE = new RegExp(`CLAWS_TRANSFERRED_FROM:\\s*([\\w.-]+/[\\w.-]+)#${ISSUE_REF_GUARDED}`);

export function parseTransferredFrom(text: string): string | null {
  const m = text.match(TRANSFERRED_FROM_RE);
  return m ? m[1]! : null;
}

/**
 * True when this issue has ALREADY been transferred INTO the current repo — one hop max.
 * The repo comparison matters: if `gh issue transfer` failed after the stamp was posted,
 * the stamp names the CURRENT repo, and routing must stay available so a retry is possible.
 */
export function alreadyTransferredInto(fullName: string, texts: string[]): boolean {
  return texts.some((t) => {
    const from = parseTransferredFrom(t);
    return from !== null && from.toLowerCase() !== fullName.toLowerCase();
  });
}

/** A plan body below this length with no model-recommendation line is a stray
 *  follow-up note, not a plan (#2948). */
export const MIN_PLAN_CHARS_WITHOUT_MODEL_LINE = 1_500;

/**
 * True when planner output is a stray final message rather than a plan. The claude CLI's
 * `result` is only the FINAL assistant message: when the agent leaves a background command
 * running, the completion notification re-invokes it after the plan is written and the short
 * reply replaces the plan wholesale (#2948, fleet-infra#1245).
 * Only called from readPlannerRun's no-submission fallback: a duplicate/transfer/blocked/
 * no_code_changes verdict comes back as `sub.kind === "outcome"`, which returns unconditionally
 * with `degenerate: false` and never reaches this function.
 */
export function isDegeneratePlanOutput(cleaned: string): boolean {
  const body = cleaned.trim();
  if (!body) return true;
  if (/\*\*Recommended implementation model:\*\*/i.test(body)) return false;
  return body.length < MIN_PLAN_CHARS_WITHOUT_MODEL_LINE;
}

export const STEP_BACK_HEADER = "## Step Back";

/**
 * Header for the escalation-reviewer's verdict comment. Declared here rather than
 * in `escalation-reviewer.ts` so the dependency stays one-way: `escalation-reviewer`
 * imports from `issue-refiner`, never the reverse.
 */
export const ESCALATION_REVIEW_HEADER = "## Escalation Review";

export const STEP_BACK_MIN_PLAN_CHARS = 1_200;
export const STEP_BACK_REVISED_MARKER = "STEP_BACK_REVISED_PLAN";

/** Kill switch — read at call time, not module load, so tests can stub it. */
export function stepBackEnabled(): boolean {
  return process.env["CLAWS_PLANNER_STEP_BACK"] !== "false";
}

export function parseStepBackVerdict(output: string): "sound" | "reconsider" | null {
  const m = output.match(/^\s*STEP_BACK_VERDICT:\s*(sound|reconsider)\b/im);
  return m ? (m[1].toLowerCase() as "sound" | "reconsider") : null;
}

/** Splits a `reconsider` output into critique and replacement plan. */
export function splitStepBackOutput(output: string): { critique: string; revisedPlan: string | null } {
  const parts = output.split(/^\s*STEP_BACK_REVISED_PLAN\s*$/m);
  const head = parts[0].replace(/^\s*STEP_BACK_VERDICT:.*$/im, "").trim();
  if (parts.length < 2) return { critique: head, revisedPlan: null };
  return { critique: head, revisedPlan: parts.slice(1).join("\n").trim() || null };
}

export function isCiUnrelatedIssue(issue: gh.Issue): boolean {
  return issue.title.startsWith("[ci-unrelated]");
}

/** Issues Claws may apply `Refined` to itself once a plan exists: `[ci-unrelated]`
 *  alerts, and issues explicitly carrying `Claws Auto-Refine`. `Automerge` deliberately
 *  does NOT count — it is the merge gate ("approve the PR merge"), not a
 *  plan-review gate, and treating it as one let an issue filed with `Automerge` skip
 *  human plan review entirely (#3042). */
export function isAutoRefineIssue(issue: gh.Issue): boolean {
  return isCiUnrelatedIssue(issue) || issue.labels.some((l) => l.name === LABELS.autoRefine);
}

const NO_CODE_CHANGES_INSTRUCTION = [
  `If, after investigating the codebase, you conclude that this issue requires`,
  `NO changes to any file tracked in this repository — because it describes a`,
  `purely operational/manual task (deleting artifacts, changing repo settings,`,
  `rotating a secret, running a one-off command), because the underlying code fix`,
  `has already been shipped, or because it is not actionable as a code change —`,
  `then do NOT write an implementation plan. Instead write a SHORT paragraph (2-4`,
  `sentences) explaining why no code change is warranted, and report it by calling`,
  `\`claws_report_outcome\` with \`outcome: "no_code_changes"\` and that paragraph as \`explanation\`.`,
  ``,
  `Only use this when you are confident a code change is genuinely unnecessary. If`,
  `there is any concrete file edit that would resolve or mitigate the issue`,
  `(including editing a GitHub Actions workflow), produce the normal plan instead.`,
  `If the issue belongs in a different repository, use the Repository Routing section below instead.`,
].join("\n");

const BLOCKED_INSTRUCTION = [
  `If the issue cannot be worked on yet because it is gated on a VERIFIABLE precondition`,
  `outside this repository's control — an upstream PR/release that has not landed, another`,
  `repository's PR that must merge first, hardware that has not arrived — then do NOT write`,
  `an implementation plan. Instead write a SHORT paragraph (2-4 sentences) naming the exact`,
  `blocker (repo, PR/issue number or release, and its state as you verified it today), and`,
  `report it by calling \`claws_report_outcome\` with \`outcome: "blocked"\` and that paragraph as \`explanation\`.`,
  ``,
  `Use this ONLY when you checked the blocker and confirmed it is still unmet. A task that is`,
  `merely large, unclear, or awaiting a human decision is NOT blocked — plan it normally.`,
].join("\n");

/** How a multi-PR plan declares which PRs depend on which; shared by both multi-PR prompts. */
const DEPENDENCY_INSTRUCTIONS = [
  `By default each PR lands after the previous one. A header may end with a dependency suffix instead:`,
  `\`(after PR 1)\`, \`(after PRs 1 and 3)\`, or \`(parallel)\` / \`(independent)\` for a PR that needs no earlier PR.`,
  `Name only lower-numbered PRs. Give the same dependencies in that PR's \`prs\` entry as \`depends_on\``,
  `(\`[1]\`, \`[1, 3]\`, \`[]\` for independent); omit \`depends_on\` for "after the previous PR".`,
  `Declare a PR parallel or independent only when its file set is disjoint from every PR it does not depend on,`,
  `and say so in that PR's section.`,
].join("\n");

const MULTI_PR_INSTRUCTIONS = [
  `Prefer a single PR — split only when the work is genuinely too large or risky to ship atomically`,
  `(a migration that must land before the code depending on it, or ~800+ lines across 15+ files).`,
  ``,
  `If you do need multiple PRs, use this exact format:`,
  ``,
  `### PR 1: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `### PR 2: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `Each PR must be independently deployable.`,
  ``,
  DEPENDENCY_INSTRUCTIONS,
].join("\n");

/**
 * Replaces MULTI_PR_INSTRUCTIONS when refining a plan that already has
 * `### PR N:` headers. Those headers are load-bearing: Claws numbers every PR
 * it opens `(N/M)` against the header count, so a refinement that flattens them
 * orphans PRs that already merged under the old numbering (#2821).
 */
function multiPrPreservationInstructions(plan: ParsedPlan): string {
  return [
    `The existing plan above is a multi-PR plan with exactly ${plan.totalPhases} steps:`,
    ...plan.phases.map((p) => `- ### PR ${p.phaseNumber}: ${p.title}${formatDependencySuffix(p.dependsOn)}`),
    ``,
    `You MUST keep this structure. Output exactly ${plan.totalPhases} \`### PR N:\` headers, numbered 1..${plan.totalPhases},`,
    `in the same order and covering the same scope as above. Claws numbers every PR it opens`,
    `\`(N/${plan.totalPhases})\` against this exact step count, so dropping a header or changing the count`,
    `silently orphans PRs that already merged against the old numbering.`,
    `Steps that have already shipped MUST keep their header and a short description of what shipped —`,
    `do NOT rewrite the plan as only the remaining work, and do NOT flatten it into a single list.`,
    `Apply the feedback inside the affected step(s). Only change the step count if the feedback`,
    `explicitly asks you to, and if you do, say so in one sentence at the top of the plan.`,
    `Keep each header's dependency suffix unless the feedback changes the order.`,
    ``,
    DEPENDENCY_INSTRUCTIONS,
  ].join("\n");
}

const PR_BASE_POLICY_INSTRUCTIONS = [
  `Never plan a stacked PR. A PR you plan targets the repository's default branch, full stop —`,
  `do not instruct the implementer to change any PR's base branch, and do not tell it to branch`,
  `from another PR's branch and open a separate PR.`,
  ``,
  `If the fix genuinely must land on an already-open pull request's branch — for example the`,
  `files it edits exist only on that branch, or that PR's CI cannot go green until this lands —`,
  `then say so in the plan and set \`target_pr\` to that PR's number when you call \`claws_save_plan\`.`,
  ``,
  `Claws will then check that PR out, commit your plan's changes onto its branch and push, so the`,
  `existing PR picks them up. Requirements for this to work: the PR must be open, not from a fork,`,
  `its head branch must be a \`claws/\` branch, and its base must be the default branch. Write the`,
  `plan as a single phase (no \`### PR N:\` split, one \`prs\` entry) — \`target_pr\` is rejected on a multi-PR plan.`,
  `Do not also ask for a new PR. If none of that holds, plan against the default branch instead.`,
].join("\n");

/**
 * Ties each plan to the product requirements layer doc-maintainer maintains
 * (#3082). With an approved requirements record the plan has no Requirement
 * section, so the citation moves to the first Decisions item alongside the
 * record version the plan was written against.
 */
function productRequirementCitation(hasApprovedRequirements: boolean): string {
  return hasApprovedRequirements ? APPROVED_REQUIREMENTS_CITATION : PRODUCT_REQUIREMENT_CITATION;
}

const APPROVED_REQUIREMENTS_CITATION =
  `The first "### Decisions" item must name the approved requirements version the plan was written against (e.g. "Planned against requirements v3 (approved 2026-09-24)") and, if \`docs/PRODUCT.md\` exists, cite the product requirement the issue serves as \`docs/product/<area>.md#<heading>\` (or \`docs/PRODUCT.md#<heading>\` when requirements are kept inline), state plainly that the issue introduces or changes a product requirement (and which area doc it belongs in), or state that no product requirement applies (pure maintenance).`;

const PRODUCT_REQUIREMENT_CITATION =
  `If \`docs/PRODUCT.md\` exists, the Requirement section must cite the product requirement the issue serves as \`docs/product/<area>.md#<heading>\` (or \`docs/PRODUCT.md#<heading>\` when requirements are kept inline), state plainly that the issue introduces or changes a product requirement (and which area doc it belongs in), or state that no product requirement applies (pure maintenance).`;

/**
 * The plan contract. With an approved requirements record the plan drops its
 * `### Requirement` section — the record is the requirement — and the rest
 * stays unstructured text; without one the contract is unchanged.
 */
function implementerGuidanceInstructions(hasApprovedRequirements: boolean): string {
  if (!hasApprovedRequirements) return IMPLEMENTER_GUIDANCE_INSTRUCTIONS;
  return IMPLEMENTER_GUIDANCE_INSTRUCTIONS
    .replace(REQUIREMENT_SECTION_INSTRUCTIONS, "")
    .replace(MULTI_PR_REQUIREMENT_SENTENCE, `If the work needs multiple PRs, put "### Decisions" before the first`);
}

const REQUIREMENT_SECTION_INSTRUCTIONS = [
  `### Requirement`,
  `Restate the user's ask in precise, unambiguous language and name the intended outcome. A`,
  `short paragraph or a few bullets — not one dense block.`,
  ``,
  ``,
].join("\n");

const MULTI_PR_REQUIREMENT_SENTENCE = `If the work needs multiple PRs, put "### Requirement" and "### Decisions" before the first`;

const IMPLEMENTER_GUIDANCE_INSTRUCTIONS = [
  `The implementer runs on a smaller model with a smaller context window; your plan is its`,
  `specification. Keep the plan self-contained, but write at the altitude a competent`,
  `developer can execute without being spoon-fed low-level navigation. Preserve concrete`,
  `facts the implementer cannot easily recover: key file paths, important function names,`,
  `error messages, prior decisions, invariants, and gotchas. Do not require line numbers or`,
  `quoted signatures unless they are genuinely necessary to avoid ambiguity. Resolve every`,
  `judgement call yourself instead of deferring it. "Handle edge cases appropriately" is not`,
  `a specification — name the edge case.`,
  ``,
  `Start immediately with the "${PLAN_HEADER}" header and the plan itself — no preamble, no`,
  `"I'll analyze" / "Looking at" narration. Use a real markdown heading per section, in this`,
  `order, so a human can scan and correct one item at a time:`,
  ``,
  `### Requirement`,
  `Restate the user's ask in precise, unambiguous language and name the intended outcome. A`,
  `short paragraph or a few bullets — not one dense block.`,
  ``,
  `### Decisions`,
  `A numbered list, one decision or assumption per line — not prose. Include decisions already`,
  `made and user-facing choices that may need correction; if you choose the likely path, say so`,
  `instead of blocking on optional input. An item that is an assumption rather than a settled`,
  `decision starts with "Assumption:". This is the section a human corrects by number, so keep`,
  `each item to one line.`,
  ``,
  `### Implementation`,
  `Name the files or modules to change and the expected behavioural changes. Include exact`,
  `paths and function names when they matter, but avoid exhaustive line-number instructions.`,
  ``,
  `### Risks And Edge Cases`,
  `Optional — include only when there are real risks or edge cases, not as filler for trivial`,
  `work.`,
  ``,
  `### Verification`,
  `List the concrete checks to run, or preserve any existing verification checklist format when`,
  `refining.`,
  ``,
  `If the work needs multiple PRs, put "### Requirement" and "### Decisions" before the first`,
  `"### PR 1:" heading, and use "####" sub-headings inside each PR. Only real phase headings may`,
  `start with "### PR" or "### Phase" — any other heading using that exact prefix would be`,
  `parsed as a phase boundary.`,
  ``,
  `Aim for under about 1,500 words. A plan over ${PLAN_LENGTH_WARN_CHARS.toLocaleString()} characters gets flagged to the`,
  `operator as too long — context you spend on detail a competent developer would infer is`,
  `context the implementer no longer has for reading files. For a change spanning many files,`,
  `describe each in 2-4 sentences rather than quoting large blocks.`,
].join("\n");

const DEEP_PLANNING_CONTEXT = [
  `This issue was explicitly labelled for deep planning: you are running on the best model`,
  `available, with reasoning effort turned to maximum. The label signals the issue is unusually`,
  `hard, ambiguous, or high-stakes.`,
  `Invest the extra capability in deeper investigation — read more of the codebase, trace the`,
  `actual code paths, verify assumptions against the real files — not in writing a longer plan.`,
  `The implementer is unchanged (a much smaller model), so the capability gap between planner`,
  `and implementer is wider than usual: resolve every judgment call yourself and make the plan`,
  `fully self-contained. The same plan length target applies.`,
].join("\n");

const MODEL_SELECTION_INSTRUCTIONS = [
  `Recommend an implementation model in the \`implementation_model\` field of \`claws_save_plan\`.`,
  `Valid tiers are \`haiku\`, \`sonnet\`, and \`opus\`. Choose \`haiku\` for trivial tasks with no logic`,
  `change (typos, comments, docs, one-line fixes); \`sonnet\` for well-defined changes following an`,
  `established pattern where the plan leaves little ambiguity; \`opus\` for architectural changes,`,
  `multi-file refactors with novel logic, or anything needing judgement beyond what the plan spells`,
  `out. When in doubt, choose \`opus\`.`,
].join("\n");

export const WORKTREE_ENVIRONMENT_NOTE = [
  `You are running inside a fresh git worktree checked out from the default branch.`,
  `It contains the repository's tracked files only — dependencies are NOT installed`,
  `(\`node_modules\` is absent, as are any other gitignored build/vendor artifacts).`,
  `This is by design, not a restriction: you have full shell access and MAY run`,
  `\`npm install\`/\`npm ci\` (or the project's package manager) yourself if you`,
  `genuinely need installed dependencies to investigate. For dependency or version`,
  `analysis, prefer reading the lockfile (\`package-lock.json\`) directly — it lists`,
  `every resolved version and avoids a slow, costly install. Do not describe reading`,
  `the lockfile as a workaround; it is the preferred approach.`,
].join("\n");

const NO_HTML_COMMENTS_INSTRUCTION = `Do not use HTML comments (<!-- ... -->) anywhere in your output. All content must be human-readable plain text or standard markdown.`;

/**
 * A follow-up answer is collected from the file the agent writes (`useOutputFile`
 * on `RunClaudeOptions`, set on `processFollowUp`'s `runClaude` call) and falls
 * back to the Claude CLI's final assistant message (`result` in its
 * `--output-format json` output) only when that file is missing or empty. An
 * agent that leaves a background shell command running gets re-invoked with a
 * completion notification once it finishes, and — on the fallback path — that
 * short follow-up reply silently replaces the whole answer (#2948,
 * fleet-infra#1245, #2950). Planner runs are collected through the planner
 * tools instead — see {@link plannerToolDocs}.
 */
const FINAL_MESSAGE_INSTRUCTION = [
  `Claws collects your output from the file named in the "HOW YOUR OUTPUT IS COLLECTED" block below;`,
  `if you do not write that file, it falls back to capturing ONLY your final assistant message. Two`,
  `consequences:`,
  `1. Never run a shell command in the background and never finish with a background task still`,
  `   running. When a background command completes you are re-invoked, and that short follow-up`,
  `   reply can silently REPLACE your entire response (this has already happened). Run long commands`,
  `   in the foreground and wait for them.`,
  `2. Whichever channel is used, it must carry the complete response on its own. Never end with only`,
  `   a note such as "see above".`,
].join("\n");

export const PLAN_RETRY_INSTRUCTION = [
  ``,
  `RETRY: your previous attempt at this task never called \`claws_save_plan\` and returned a short`,
  `note instead of the plan, so the plan was lost. Do not run any background commands this time, and`,
  `save the complete concise plan with \`claws_save_plan\` before you finish.`,
].join("\n");

function researchInstructions(repo: Repo): string {
  return [
    `Before writing the plan, gather the context the implementer cannot gather for itself:`,
    `- If the issue or a comment references other issues or PRs (by URL or \`#123\` / \`owner/repo#123\`), fetch them:`,
    `  - For GitHub-hosted repos: \`gh issue view <n> --repo <owner>/<repo> --comments\` or \`gh pr view <n> --repo <owner>/<repo>\` — the same number may be either, so try the other form on a 404. The \`gh\` CLI can read any GitHub repo the Claws GitHub App is installed in, including other repos in the org.`,
    ...(repo.forge === "forgejo" || hasForgejoRepoForOwner(repo.owner) ? [
      `  - For Forgejo-hosted repos: \`curl -sH "Authorization: token $CLAWS_FORGEJO_READ_TOKEN" "$CLAWS_FORGEJO_BASE_URL/api/v1/repos/<owner>/<repo>/issues/<n>"\`, plus \`/comments\` on that path for its comments. The issues endpoint also returns PRs. Never use \`gh\` for these repos: the GitHub copy is a stale mirror.`,
    ] : []),
    ...(repo.forge === "forgejo" ? [`  - This repository is hosted on Forgejo, so a bare \`#123\` refers to an issue or PR in this Forgejo repo.`] : []),
    `  If the lookup fails (both \`gh\` forms return 404, or the Forgejo API returns 404), say so in the plan and continue with what the issue holds.`,
    `- If it references external URLs, use the WebFetch tool to retrieve their content. Use the WebSearch tool when you need to research a named library or API you must get right and that is not directly linked. Note truncated or unreachable content rather than inventing it.`,
    `- If it references diagnostic artefacts — an Actions run, an uploaded artifact, a build log — in a GitHub-hosted repo, read them before diagnosing: \`gh run view <run-id> --repo <owner>/<repo> --log-failed\`, falling back to \`--log\`; \`gh run download <run-id>\` for artifacts. Forgejo Actions logs are not readable this way; if the diagnosis depends on one, say so in the plan. Auto-filed alert issues ([claws-error], [ci-failure]) usually carry no diagnosis in the body itself.`,
    `- An occurrence-tracking block ("**Occurrences:** N") is load-bearing: N greater than 1 means a recurring failure the plan must actually address, not a transient blip.`,
    ``,
    `Never write "see #N" or "fetch the linked context" in the plan — the implementer runs on a smaller model and cannot look anything up. Embed the concrete facts (paths, error messages, IDs, snippets, prior decisions) directly. Commit to ONE diagnosed root cause and ONE fix; if the evidence genuinely will not support a diagnosis, say so and recommend a single next action rather than branching into alternatives.`,
  ].join("\n");
}

const REVIEW_MODEL_INSTRUCTIONS = [
  `Also recommend a review model for the PR reviewer in the \`review_model\` field.`,
  `Valid tiers are \`sonnet\` and \`opus\`. Choose \`sonnet\` for PRs that will be straightforward to`,
  `review — config changes, simple bug fixes, well-scoped single-concern changes. Choose \`opus\``,
  `for security-sensitive or architectural changes, complex multi-file refactors, or novel`,
  `algorithms. When in doubt, choose \`opus\`.`,
].join("\n");

const MODEL_PLAN_INSTRUCTIONS = [
  `Optionally, end the plan text with a per-phase model plan on one line, in this exact format:`,
  ``,
  `**Model plan:** \`implement=claude/sonnet\` \`review=opus\` \`ci-fix=haiku\` \`review-address=sonnet\``,
  ``,
  `Each cell is \`phase=provider/tier\` or \`phase=tier\` (no provider means "use the default provider draw").`,
  `Phases: \`implement\`, \`review\`, \`ci-fix\`, \`review-address\` (and \`plan-refine\` for later re-plans).`,
  `Providers: \`claude\`, \`codex\`, \`opencode\`. Tiers, best first: \`fable\`, \`opus\`, \`sonnet\`, \`haiku\`.`,
  `Omit a phase to leave it on its default; omit the whole line when you have no view beyond the two fields above.`,
  `\`fable\` is only honoured for planning: a \`fable\` cell for any other phase runs on \`opus\` unless the`,
  `operator sets it. Name a provider only when the work genuinely needs that provider.`,
].join("\n");


/**
 * The issue's links to other tracker issues (docs/issue-tracker.md#links), so
 * the planner plans against a recorded dependency instead of rediscovering it.
 * Titles are guarded against the linked issue, not this one, for the same
 * reason the duplicate candidates are (#2526).
 *
 * `canLink` adds the instruction to record a newly discovered dependency with
 * `claws_link_issues`, which only takes a native issue id; `outcomes` says
 * whether this run may then report `blocked`.
 */
export function buildLinkedIssuesSection(
  fullName: string,
  links: readonly issueLinks.IssueLinkView[],
  opts: { canLink: boolean; outcomes: boolean; issueRef: IssueRef },
): string {
  const lines: string[] = [];
  if (links.length > 0) {
    lines.push(
      ``,
      `## Linked issues`,
      ``,
      `Claws tracks these relationships for this issue. An open "depends on" issue holds this one back from implementation until it closes; Claws unparks it automatically then.`,
      ``,
    );
    for (const link of links) {
      const title = guardContent(link.otherTitle, makeGuardCtx(fullName, link.otherId)("linked-issue-title"));
      const column = link.otherState === "open" ? `, ${LINKED_ISSUE_COLUMNS[link.otherLifecycle]}` : "";
      lines.push(`- ${issueLinks.LINK_KIND_LABELS[link.kind].toLowerCase()} #${link.otherId} — ${title} (${link.otherState}${column})`);
    }
  }
  if (opts.canLink) {
    lines.push(
      ``,
      `If this issue cannot be implemented until another tracker issue is done, record that with the Claws MCP tool`,
      `\`claws_link_issues\` (issue_id \`${opts.issueRef}\`, kind \`depends_on\`, target the other issue)${opts.outcomes ? `, then report \`blocked\`` : ""}.`,
      `A dependency that has already closed is not a blocker. Never re-record a dependency already listed above.`,
    );
  }
  return lines.join("\n");
}

/** A prompt section as a spreadable list: nothing at all when it is empty. */
function nonEmpty(section: string): string[] {
  return section ? [section] : [];
}

/** A linked issue's lifecycle, as the planner reads it. */
const LINKED_ISSUE_COLUMNS: Record<issueLinks.IssueLinkView["otherLifecycle"], string> = {
  "ideas": "requirements not yet approved",
  "planning": "being planned",
  "awaiting-plan-review": "planned, awaiting review",
  "approved": "plan approved",
  "blocked": "blocked",
  "backlog": "backlog",
};

export function buildDuplicateCandidatesSection(
  fullName: string,
  currentIssueNumber: IssueRef,
  candidates: gh.Issue[],
): string {
  if (candidates.length === 0) return "";
  const lines: string[] = [
    ``,
    `## Possible Duplicate Candidates`,
    ``,
    `The following open issues in this repository have a LOWER issue number than #${currentIssueNumber}. If this issue has the SAME ROOT CAUSE as any of them (for example, multiple alerts caused by one underlying failure), it should be treated as a duplicate of the lowest-numbered matching one.`,
    ``,
  ];
  for (const c of candidates) {
    // #2526: bind the guard context to the CANDIDATE, not the issue being refined.
    // guardContent() posts its warning comment to context.itemNumber and dedups on
    // repo#itemNumber, so the shared context put "please edit the source" on the
    // wrong issue and re-posted it for every subsequent refine in the repo.
    const candidateCtx = makeGuardCtx(fullName, c.number);
    const guardedTitle = guardContent(c.title, candidateCtx("duplicate-candidate-title"));
    // Truncate BEFORE guarding: only the prefix reaches the model, so only the
    // prefix should be scanned or alerted on. (Redaction markers are 47 chars,
    // so a guarded prefix may end up slightly longer than the limit — fine.)
    const rawBody = c.body ?? "";
    const truncRaw = rawBody.length > DUPLICATE_CANDIDATE_BODY_LIMIT
      ? rawBody.slice(0, DUPLICATE_CANDIDATE_BODY_LIMIT) + "..."
      : rawBody;
    const trunc = guardContent(truncRaw, candidateCtx("duplicate-candidate-body"));
    lines.push(`### #${c.number}: ${guardedTitle}`);
    lines.push(trunc || "(No description provided)");
    lines.push(``);
  }
  lines.push(
    `## Duplicate Determination`,
    ``,
    `If this issue is a duplicate, report it by calling \`claws_report_outcome\` with \`outcome: "duplicate"\` and \`duplicate_of\` set to the issue number.`,
    ``,
    `Rules:`,
    `- Record a duplicate verdict ONLY if the current issue (#${currentIssueNumber}) shares a root cause with an issue from the list above. Different symptoms of the same underlying failure count as a duplicate. Superficial textual similarity without a shared root cause does NOT.`,
    `- If multiple candidates share the root cause, pick the LOWEST-NUMBERED one.`,
    `- Otherwise save the normal plan with \`claws_save_plan\`.`,
    `- The number MUST be one of: ${candidates.map((c) => `#${c.number}`).join(", ")}. Do not invent a number.`,
    `- When you report a duplicate, do NOT write a plan — a short \`explanation\` saying which issue it duplicates and why is enough. A standard message will be posted automatically.`,
    ``,
  );
  return lines.join("\n");
}

function buildTransferCandidatesSection(fullName: string, candidates: string[]): string {
  if (candidates.length === 0) return "";
  return [
    ``,
    `## Repository Routing`,
    ``,
    `This issue was filed against ${fullName}, but it may belong to a different repository.`,
    `These repositories are managed by Claws and can receive this issue:`,
    ``,
    ...candidates.map((slug) => `- ${slug}`),
    ``,
    `If — after reading THIS repository's code — the issue is clearly about a DIFFERENT`,
    `repository's code or configuration (the subject matter has no presence here at all),`,
    `do NOT write a plan. Instead write a SHORT paragraph (2-4 sentences) naming the`,
    `evidence (e.g. "no file in this repository mentions X; that integration lives in Y"),`,
    `and report it by calling \`claws_report_outcome\` with \`outcome: "transfer"\`, \`transfer_to\` set to the`,
    `destination and that paragraph as \`explanation\`.`,
    ``,
    `Rules:`,
    `- Copy the destination EXACTLY from the list above. Do not invent a name.`,
    `- Only transfer when the issue is UNAMBIGUOUSLY about another repository. If the work`,
    `  could plausibly be done here, or spans both, write a normal plan instead.`,
    `- A vague or general issue is NOT a transfer candidate.`,
  ].join("\n");
}

/**
 * Every other same-owner repo Claws manages, on both forges, so the planner can
 * delegate a companion issue instead of calling a Forgejo repo "unmanaged"
 * (#3067). Empty unless the owner has at least one Forgejo repo, which keeps
 * GitHub-only prompts unchanged. Issue transfer stays GitHub-only.
 */
export function buildManagedReposSection(currentRepo: Repo, allRepos: Repo[]): string {
  const sameOwner = allRepos.filter((r) => r.owner === currentRepo.owner);
  if (currentRepo.forge !== "forgejo" && !sameOwner.some((r) => r.forge === "forgejo")) return "";
  const others = sameOwner
    .filter((r) => r.fullName !== currentRepo.fullName)
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .slice(0, MAX_TRANSFER_CANDIDATES);
  if (others.length === 0) return "";
  return [
    ``,
    `## Claws-managed repositories`,
    ``,
    `Claws plans and implements issues in all of these repositories, on both forges:`,
    ``,
    ...others.map((r) => `- ${r.fullName} (${r.forge === "forgejo" ? "Forgejo" : "GitHub"})`),
    ``,
    `Rules:`,
    `- Never describe one of these repositories as unmanaged or "not managed by Claws", and never emit a manual-action note asking a human to file an issue in one.`,
    `- Inspect listed repos over the API before guessing or asking anyone to clone them: GitHub via \`gh api repos/OWNER/NAME/contents/PATH\`; Forgejo via \`curl -sH "Authorization: token $CLAWS_FORGEJO_READ_TOKEN" "$CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/contents/PATH"\`, or replace \`contents\` with \`raw\` to read a file.`,
    `- When the work needs a companion change in a listed repository, add a plan step telling the implementer to file an issue there with the \`claws_create_issue\` MCP tool (\`repos\` set to that repository), and to put the returned \`#clw_…\` id and dashboard URL in its PR description. Fall back to filing directly on the forge only when that tool is unavailable or fails:`,
    `  - GitHub: \`gh issue create --repo <owner>/<repo> --title ... --body ...\``,
    `  - Forgejo: \`curl -sX POST -H "Authorization: token $CLAWS_FORGEJO_READ_TOKEN" -H "Content-Type: application/json" -d '{"title":"...","body":"..."}' "$CLAWS_FORGEJO_BASE_URL/api/v1/repos/<owner>/<repo>/issues"\``,
    `- Moving THIS issue to another repository (Repository Routing) is GitHub-only; Forgejo repositories can only receive companion issues.`,
  ].join("\n");
}

/**
 * The "## Issue preview" prompt section when the issue has a preview — an open
 * PR or a bare branch named `claws/preview-issue-<ref>` — in any of its repos,
 * or "". Never throws: a
 * failed lookup costs the section, not the planner run.
 */
async function issuePreviewSection(fullName: string, issueRef: IssueRef, issueRepos: readonly string[]): Promise<string> {
  for (const repo of uniqueRepos([fullName, ...issueRepos])) {
    try {
      const preview = await findIssuePreview(repo, issueRef);
      if (!preview) continue;
      const headSha = preview.kind === "pr" ? await gh.getPRHeadSHA(repo, preview.pr.number) : preview.headSha;
      return buildPreviewPromptSection(repo, preview, headSha, issueRef);
    } catch (err) {
      log.warn(`[issue-refiner] ${fullName}#${issueRef}: could not look up an issue preview in ${repo} (${err})`);
    }
  }
  return "";
}

/** Mirror the issue's preview onto it right after a plan is posted or edited. */
async function syncPreviewsAfterPlan(fullName: string, issueRef: IssueRef, issueRepos: readonly string[]): Promise<void> {
  try {
    await syncPreviewsForIssue(fullName, issueRef, issueRepos);
  } catch (err) {
    log.warn(`[issue-refiner] ${fullName}#${issueRef}: could not sync the issue preview (${err})`);
  }
}

/**
 * The approved requirements record ahead of the issue body, which becomes
 * background; nothing when the issue has no record.
 */
function plannerRequirementsLines(requirements: ApprovedRequirements | null, guardCtx: ReturnType<typeof makeGuardCtx>): string[] {
  if (!requirements) return [];
  return [approvedRequirementsSection(requirements, "planner", guardCtx), ``, `## Original issue body (background)`, ``];
}

/**
 * Comments to show a planner prompt. With an approved record, the
 * requirements writer's own `## Requirements` comment is dropped: it renders
 * with a literal `### Requirement` heading the plan must not copy, and a
 * refine run edits it in place to the latest version whether or not that
 * version is approved — showing it would contradict "an unapproved version is
 * ignored" with a comment appearing to say otherwise. The approved record is
 * already rendered above, so the comment adds nothing but conflicting text.
 */
function plannerComments(comments: readonly gh.IssueComment[], requirements: ApprovedRequirements | null): gh.IssueComment[] {
  return requirements ? comments.filter((c) => !isRequirementsComment(c.body)) : [...comments];
}

function planShapeSentence(hasApprovedRequirements: boolean): string {
  return hasApprovedRequirements
    ? `The plan should satisfy the approved requirements record above without restating it, surface decisions or assumptions early, describe the implementation at file/module level, include real risks or edge cases only when useful, and list verification steps.`
    : `The plan should restate the requirement unambiguously, surface decisions or assumptions early, describe the implementation at file/module level, include real risks or edge cases only when useful, and list verification steps.`;
}

/**
 * When a plan predating an approved record is being refined, the existing
 * plan pasted above still carries the pre-record contract in full — its own
 * `### Requirement` heading and no version citation. Nothing else in the
 * prompt tells the model that contract has changed for *this* plan
 * specifically, so it is likely to preserve the section unchanged. Empty
 * outside that exact case.
 */
function legacyRequirementSectionNotice(existingPlan: string, requirements: ApprovedRequirements | null): string {
  if (!requirements || !/^### Requirement\s*$/m.test(existingPlan)) return "";
  return `The previous plan above predates this approved requirements record: it still has a "### Requirement" section restating the old ask and no version citation. Remove that section from the updated plan — the record above is the requirement now — and make the first "### Decisions" item cite requirements v${requirements.version} and the product requirement the issue serves, per the citation rule below.`;
}

function buildRefinementPrompt(
  repo: Repo,
  issue: gh.Issue,
  existingPlan: string,
  parsed: ParsedPlan,
  feedback: gh.IssueComment[],
  selfLogin: string,
  isDeep: boolean,
  wtPath: string,
  allRepos: Repo[],
  /** The repos `prs[].repo` may name — see {@link plannerAllowedRepos}. */
  issueRepos: readonly string[],
  /** The issue's links to other tracker issues. */
  links: readonly issueLinks.IssueLinkView[] = [],
  /** The issue's preview section — see {@link issuePreviewSection}. */
  previewSection = "",
  /** The issue's approved requirements record, or null to plan from the body. */
  requirements: ApprovedRequirements | null = null,
): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  const incidentCtx = gitHubIncidentContext(guardCtx);
  const feedbackForPrompt = plannerComments(feedback, requirements);
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    ...plannerRequirementsLines(requirements, guardCtx),
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ...nonEmpty(buildLinkedIssuesSection(fullName, links, { canLink: isClawsIssueId(issue.number), outcomes: false, issueRef: issue.number })),
    ...nonEmpty(previewSection ? `\n${previewSection}` : ""),
    ``,
    `A previous implementation plan was produced:`,
    ``,
    // Existing plan is self-authored by Claws — guarding it produces false positives
    // when plans discuss security topics or contain example injection strings.
    existingPlan,
    ``,
    ...(feedbackForPrompt.length > 0
      ? [
          `The following feedback was provided on the plan:`,
          ``,
          ...formatIssueCommentsForPrompt(feedbackForPrompt, selfLogin, guardCtx),
        ]
      : [`No specific feedback comments were provided. Re-evaluate the plan for completeness and correctness.`, ``]),
    ``,
    REPO_DOCS_CONTEXT,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    ...(incidentCtx ? [incidentCtx] : []),
    SHOPPING_MANIFEST_CONTEXT,
    frontendContext(wtPath),
    forgeContext(repo),
    WORKTREE_ENVIRONMENT_NOTE,
    researchInstructions(repo),
    buildManagedReposSection(repo, allRepos),
    issueReposSection(fullName, issueRepos),
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `Please produce an updated concise implementation plan that addresses the feedback and preserves enough context for another agent to implement without asking follow-up questions.`,
    planShapeSentence(requirements !== null),
    productRequirementCitation(requirements !== null),
    ...nonEmpty(legacyRequirementSectionNotice(existingPlan, requirements)),
    ``,
    parsed.totalPhases > 1 ? multiPrPreservationInstructions(parsed) : MULTI_PR_INSTRUCTIONS,
    ``,
    PR_BASE_POLICY_INSTRUCTIONS,
    ``,
    implementerGuidanceInstructions(requirements !== null),
    ...(isDeep ? [``, DEEP_PLANNING_CONTEXT] : []),
    ``,
    MODEL_SELECTION_INSTRUCTIONS,
    ``,
    REVIEW_MODEL_INSTRUCTIONS,
    ``,
    MODEL_PLAN_INSTRUCTIONS,
    ``,
    ...(feedback.length > 0
      ? [
          `Also pass a reply to the feedback in the \`response\` field of \`claws_save_plan\`. It should:`,
          `- Directly answer any questions asked in the feedback`,
          `- Acknowledge concerns or suggestions`,
          `- Note any surprises or deviations from the original plan`,
          ``,
          `It is posted as a separate follow-up comment on the issue, so write it in a conversational tone addressing the commenter(s). Keep it out of the plan text.`,
          ``,
        ]
      : [
          `This is an automatic re-verification pass: nobody left feedback and nobody is waiting on a reply.`,
          `Save ONLY the updated plan. Do NOT set \`response\`, and do not add a "what changed since the last plan" summary or any conversational narration — a reply is discarded here, and previously one was posted as a separate comment on the issue on every re-verification pass, which is unwanted noise. If re-verification changed the diagnosis, say so inside the plan body itself.`,
          ``,
        ]),
    NO_HTML_COMMENTS_INSTRUCTION,
    ``,
    `Do NOT make any code changes. Only produce the plan, saved with \`claws_save_plan\`.`,
    ``,
    plannerToolDocs({ actingRepo: fullName, issueRepos, duplicates: false, transfer: false, outcomes: false, response: feedback.length > 0 }),
  ].join("\n");
}

function buildFollowUpPrompt(
  repo: Repo,
  issue: gh.Issue,
  existingPlan: string,
  openPRs: readonly OpenPhasePR[],
  followUpComments: gh.IssueComment[],
  selfLogin: string,
  wtPath: string,
  prSummary: string,
  requirements: ApprovedRequirements | null = null,
): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  const prRefs = openPRs.map((pr) => followUpPRRef(fullName, pr)).join(", ");
  const several = openPRs.length > 1;
  return [
    `You are responding to follow-up questions on a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    ...plannerRequirementsLines(requirements, guardCtx),
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    several
      ? `An implementation plan was already produced, and ${openPRs.length} PRs implementing its steps are open: ${prRefs}. Do NOT assume a PR implements its step of the plan — it may have diverged, or been opened against a newer comment. Check what each actually changes before describing it.`
      : `An implementation plan was already produced, and PR ${prRefs} is open referencing this issue. Do NOT assume the PR implements the plan — it may have diverged, or been opened against a newer comment. Check what it actually changes before describing it.`,
    ``,
    prSummary,
    ``,
    `Here is the existing plan:`,
    ``,
    // Existing plan is self-authored by Claws — guarding it produces false positives
    // when plans discuss security topics or contain example injection strings.
    existingPlan,
    ``,
    `The following follow-up comments were posted after the plan:`,
    ``,
    ...formatIssueCommentsForPrompt(plannerComments(followUpComments, requirements), selfLogin, guardCtx),
    ``,
    REPO_DOCS_CONTEXT,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    frontendContext(wtPath),
    forgeContext(repo),
    WORKTREE_ENVIRONMENT_NOTE,
    researchInstructions(repo),
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `Please respond to the follow-up comments above. Answer questions, provide clarifications, or address concerns.`,
    `Do NOT produce a new implementation plan — implementation is already in progress via ${several ? "PRs" : "PR"} ${prRefs}.`,
    several
      ? `If the comments suggest changes that should be made, say which of those PRs each change applies to.`
      : `If the comments suggest changes that should be made to the PR, mention that in your response.`,
    ``,
    FINAL_MESSAGE_INSTRUCTION,
    ``,
    `Do NOT make any code changes. Only produce your response as text output.`,
  ].join("\n");
}

/** `#N` for a PR in the issue's repo, `owner/name#N` for one elsewhere. */
function followUpPRRef(fullName: string, pr: OpenPhasePR): string {
  return pr.repo.toLowerCase() === fullName.toLowerCase() ? `#${pr.number}` : `${pr.repo}#${pr.number}`;
}

function buildNewPlanPrompt(
  repo: Repo,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  selfLogin: string,
  duplicateCandidates: gh.Issue[],
  transferCandidates: string[],
  isDeep: boolean,
  wtPath: string,
  allRepos: Repo[],
  /** True only when the caller's planner run accepts `claws_report_outcome`. The
   *  no-code-changes and blocked clauses tell the model to report through that
   *  tool, so they must never travel to a run that rejects it — the refinement
   *  flow's fresh-plan path is plan-only and gets a prompt with no outcome clauses
   *  at all. */
  outcomes: boolean,
  /** The repos `prs[].repo` may name — see {@link plannerAllowedRepos}. */
  issueRepos: readonly string[],
  /** The issue's links to other tracker issues. */
  links: readonly issueLinks.IssueLinkView[] = [],
  /** The issue's preview section — see {@link issuePreviewSection}. */
  previewSection = "",
  /** The issue's approved requirements record, or null to plan from the body. */
  requirements: ApprovedRequirements | null = null,
): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  const incidentCtx = gitHubIncidentContext(guardCtx);
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    ...plannerRequirementsLines(requirements, guardCtx),
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    ...formatIssueCommentsForPrompt(plannerComments(comments, requirements), selfLogin, guardCtx),
    ...nonEmpty(buildLinkedIssuesSection(fullName, links, { canLink: isClawsIssueId(issue.number), outcomes, issueRef: issue.number })),
    ...nonEmpty(previewSection ? `\n${previewSection}\n` : ""),
    REPO_DOCS_CONTEXT,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    ...(incidentCtx ? [incidentCtx] : []),
    SHOPPING_MANIFEST_CONTEXT,
    frontendContext(wtPath),
    forgeContext(repo),
    WORKTREE_ENVIRONMENT_NOTE,
    researchInstructions(repo),
    buildManagedReposSection(repo, allRepos),
    issueReposSection(fullName, issueRepos),
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `Please produce a concise implementation plan for this issue that another agent can follow without needing further input.`,
    planShapeSentence(requirements !== null),
    productRequirementCitation(requirements !== null),
    ``,
    MULTI_PR_INSTRUCTIONS,
    ``,
    PR_BASE_POLICY_INSTRUCTIONS,
    ``,
    implementerGuidanceInstructions(requirements !== null),
    ...(isDeep ? [``, DEEP_PLANNING_CONTEXT] : []),
    ``,
    MODEL_SELECTION_INSTRUCTIONS,
    ``,
    REVIEW_MODEL_INSTRUCTIONS,
    ``,
    MODEL_PLAN_INSTRUCTIONS,
    ``,
    NO_HTML_COMMENTS_INSTRUCTION,
    ...(outcomes ? [``, NO_CODE_CHANGES_INSTRUCTION, ``, BLOCKED_INSTRUCTION] : []),
    ``,
    `Do NOT make any code changes. Only produce the plan, saved with \`claws_save_plan\`.`,
    buildTransferCandidatesSection(fullName, outcomes ? transferCandidates : []),
    buildDuplicateCandidatesSection(fullName, issue.number, outcomes ? duplicateCandidates : []),
    ``,
    plannerToolDocs({
      actingRepo: fullName,
      issueRepos,
      duplicates: outcomes && duplicateCandidates.length > 0,
      transfer: outcomes && transferCandidates.length > 0,
      outcomes,
    }),
  ].join("\n");
}

function buildStepBackPrompt(repo: Repo, issue: gh.Issue, planBody: string, isDeep: boolean, wtPath: string, issueRepos: readonly string[], requirements: ApprovedRequirements | null = null): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    ...plannerRequirementsLines(requirements, guardCtx),
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    `A plan has already been produced for this issue:`,
    ``,
    // Plan is self-authored by Claws — guarding it produces false positives
    // when plans discuss security topics or contain example injection strings.
    planBody,
    ``,
    `This pass is NOT for polishing the plan or checking its details. Another pass already`,
    `does that. Your single question is: does this plan solve the right problem in the right`,
    `way, or is it a well-executed version of a suboptimal approach?`,
    ``,
    `Probe specifically:`,
    `- Does it attack the root cause, or work around a symptom?`,
    `- Is there a simpler approach that would make most of the plan unnecessary?`,
    `- Does it add machinery (a new module, a config key, an abstraction) where an existing`,
    `  helper, a deletion, or a changed default would do?`,
    `- Does it treat an existing bad design as fixed, when replacing it is cheaper than`,
    `  working around it?`,
    `- Does it carry forward a constraint from the issue text that is not actually a constraint?`,
    `- Does it look complete while leaving the original motivation only partly addressed?`,
    ``,
    `You have the whole repository available — read the real files before concluding. A step`,
    `back not grounded in the actual code is worse than none.`,
    ``,
    `Default to "sound". Most plans are fine and a spurious pivot costs more than it saves.`,
    `Emit "reconsider" only when you can name a concrete, materially better approach — not a`,
    `vague preference, and not a list of small improvements to the existing plan.`,
    ``,
    `How to report — call the Claws MCP tool \`claws_step_back_verdict\` once before you finish:`,
    `- \`sound\`: \`{"verdict":"sound"}\` and nothing else.`,
    `- \`reconsider\`: set \`critique\` to at most 400 words explaining what the original plan gets`,
    `  wrong and why the new approach is better, addressed to a human reviewer, and \`revised\` to the`,
    `  COMPLETE replacement plan with the same fields as a saved plan (\`plan\`, \`prs\` — one`,
    `  {repo, title, optional depends_on} entry per \`### PR N:\` section, ${prsRepoRule(fullName, issueRepos).replace(/;$/, "")} — \`implementation_model\`,`,
    `  \`review_model\`, optional \`target_pr\`). The original is discarded, not merged, so the replacement`,
    `  must stand alone. If the tool returns an error, fix the input and call it again.`,
    `- Only if the tool is unavailable: end your reply with a line \`STEP_BACK_VERDICT: sound\` or`,
    `  \`STEP_BACK_VERDICT: reconsider\`; for reconsider, follow it with the critique, then a line`,
    `  \`${STEP_BACK_REVISED_MARKER}\`, then the complete replacement plan.`,
    `- Do NOT try to report a duplicate, transfer, blocked or no-code-changes outcome — those were already decided, and this pass cannot report one.`,
    `- Never run a shell command in the background; when it completes you are re-invoked.`,
    ``,
    `The replacement plan must have the same shape as a normal plan:`,
    issueReposSection(fullName, issueRepos),
    REPO_DOCS_CONTEXT,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    SHOPPING_MANIFEST_CONTEXT,
    frontendContext(wtPath),
    forgeContext(repo),
    WORKTREE_ENVIRONMENT_NOTE,
    ``,
    MULTI_PR_INSTRUCTIONS,
    ``,
    PR_BASE_POLICY_INSTRUCTIONS,
    ``,
    implementerGuidanceInstructions(requirements !== null),
    ``,
    productRequirementCitation(requirements !== null),
    ...(isDeep ? [``, DEEP_PLANNING_CONTEXT] : []),
    ``,
    MODEL_SELECTION_INSTRUCTIONS,
    ``,
    REVIEW_MODEL_INSTRUCTIONS,
    ``,
    MODEL_PLAN_INSTRUCTIONS,
    ``,
    NO_HTML_COMMENTS_INSTRUCTION,
    ``,
    `Do NOT make any code changes. Only report through \`claws_step_back_verdict\`.`,
  ].join("\n");
}

/** A step-back pass's result. `revisedPrs` is null when the revision came from the text fallback. */
interface StepBackResult {
  revisedPlan: string | null;
  revisedPrs: PlannedPR[] | null;
  critique: string | null;
  verdict: "sound" | "reconsider" | null;
}

async function runStepBack(opts: {
  repo: Repo;
  issue: gh.Issue;
  wtPath: string;
  planBody: string;
  model: string;
  tier: ModelTier;
  provider: Provider;
  strictProvider: boolean;
  eligibleProviders: ReadonlyArray<ProviderWeight>;
  deepPlan: boolean;
  deepThinking: boolean;
  timeoutMs: number | undefined;
  agentDoc: string | undefined;
  taskId: number;
  onProviderUsed?: (provider: Provider) => void;
  onAttemptModelUsed?: (provider: Provider, model: string | undefined) => void;
  plannerCapabilities: readonly string[];
  /** The repos a revision's `prs[].repo` may name — see {@link plannerAllowedRepos}. */
  issueRepos: string[];
  /** The issue's approved requirements record, or null when it has none. */
  requirements?: ApprovedRequirements | null;
}): Promise<StepBackResult> {
  const none: StepBackResult = { revisedPlan: null, revisedPrs: null, critique: null, verdict: null };
  if (!stepBackEnabled()) return none;
  if (opts.planBody.length < STEP_BACK_MIN_PLAN_CHARS) return none;

  const fullName = opts.repo.fullName;
  try {
    return await withPlannerRun({ repo: fullName, issueRef: opts.issue.number, stage: "step_back", allowedRepos: opts.issueRepos }, async (runId) => {
      const prompt = buildStepBackPrompt(opts.repo, opts.issue, opts.planBody, opts.deepPlan, opts.wtPath, opts.issueRepos, opts.requirements ?? null);
      const mcpConfig = claude.writeAgentMcpConfig(opts.wtPath, {
        includeHomeAssistant: isHomeAssistantConfigRepo(fullName),
        plannerRun: { id: runId, stage: "step_back" },
        fileSuffix: "step_back",
      });
      const out = await claude.runClaude(prompt, opts.wtPath, {
        mcpConfig,
        timeoutMs: opts.timeoutMs,
        tier: opts.tier,
        model: opts.model,
        provider: opts.provider,
        strictProvider: opts.strictProvider,
        eligibleProviders: opts.eligibleProviders,
        deepThinking: opts.deepThinking,
        appendSystemPrompt: opts.agentDoc,
        onProviderUsed: opts.onProviderUsed,
        onAttemptModelUsed: opts.onAttemptModelUsed,
        onTokensUsed: db.trackTaskTokens(opts.taskId),
        captureLabel: "issue-refiner-step-back",
        plannerCapabilities: opts.plannerCapabilities,
      });

      const sub = getSubmission(runId);
      if (sub?.kind === "step_back") {
        if (sub.verdict === "sound") {
          log.info(`[issue-refiner] Step-back pass found the plan sound for ${fullName}#${opts.issue.number}`);
          return { revisedPlan: null, revisedPrs: null, critique: null, verdict: "sound" as const };
        }
        if (!sub.revised) {
          log.warn(`[issue-refiner] Step-back said "reconsider" for ${fullName}#${opts.issue.number} but gave no replacement plan — keeping the original`);
          return { revisedPlan: null, revisedPrs: null, critique: sub.critique, verdict: "reconsider" as const };
        }
        return { revisedPlan: renderPlanBody(sub.revised), revisedPrs: sub.revised.prs, critique: sub.critique, verdict: "reconsider" as const };
      }

      // No tool call: the text markers are the fallback, and an absent or
      // unparseable one deliberately means "sound". A rejected call is still
      // "sound" by default, but say so — a verdict was attempted and lost.
      const rejections = getRunRejections(runId);
      if (rejections.count > 0) {
        log.warn(`[issue-refiner] Step-back pass for ${fullName}#${opts.issue.number}: every claws_step_back_verdict call was rejected (${rejections.count}, last: ${rejections.last}) — falling back to the text markers`);
      }
      if (parseStepBackVerdict(out) !== "reconsider") {
        log.info(`[issue-refiner] Step-back pass found the plan sound for ${fullName}#${opts.issue.number}`);
        return { revisedPlan: null, revisedPrs: null, critique: null, verdict: "sound" as const };
      }

      const { critique, revisedPlan } = splitStepBackOutput(out);
      // A stray marker in the replacement text must not leak into the posted comment.
      const cleaned = revisedPlan ? stripLeadingPlanHeader(revisedPlan) : "";
      if (!cleaned.trim()) {
        log.warn(`[issue-refiner] Step-back said "reconsider" for ${fullName}#${opts.issue.number} but produced no usable replacement plan — keeping the original`);
        return { revisedPlan: null, revisedPrs: null, critique: critique || null, verdict: "reconsider" as const };
      }
      return { revisedPlan: cleaned, revisedPrs: null, critique: critique || null, verdict: "reconsider" as const };
    });
  } catch (err) {
    log.warn(`[issue-refiner] Step-back pass failed for ${opts.repo.fullName}#${opts.issue.number}: ${err}`);
    return none;
  }
}

function selectDuplicateCandidates(
  fullName: string,
  currentIssue: gh.Issue,
  allOpenIssues: gh.Issue[],
): gh.Issue[] {
  const clawsIgnore = LABELS.clawsIgnore;
  return allOpenIssues
    .filter((i) => compareIssueRefs(i.number, currentIssue.number) < 0)
    .filter((i) => !i.labels.some((l) => l.name === clawsIgnore))
    .filter((i) => !gh.isItemSkipped(fullName, i.number))
    .sort((a, b) => compareIssueRefs(b.number, a.number)) // take newest-relevant first
    .slice(0, MAX_DUPLICATE_CANDIDATES)
    .sort((a, b) => compareIssueRefs(a.number, b.number)); // render ascending for prompt stability
}

/**
 * Transfer is same-forge only: GitHub's transfer API cannot move an issue to a
 * Forgejo repo, and Forgejo/Gitea has no issue-transfer API at all. A Forgejo
 * repo is therefore neither a transfer source nor a transfer target (#2650).
 */
export function selectTransferCandidates(currentRepo: Repo, allRepos: Repo[]): string[] {
  if (isForgejoRepo(currentRepo.fullName)) return [];
  return allRepos
    .filter((r) => r.owner === currentRepo.owner && r.fullName !== currentRepo.fullName)
    .filter((r) => !isForgejoRepo(r.fullName))
    .map((r) => r.fullName).sort().slice(0, MAX_TRANSFER_CANDIDATES);
}

export async function processIssue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Planning ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("issue-refiner", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "issue-refiner", async (wtPath) => {
      await db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin, allOpenIssues, allRepos, live, requirementsResult] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLoginForIssue(repo.fullName, issue.number),
        gh.listOpenIssues(fullName),
        gh.listRepos().catch(() => []),
        gh.getIssueTitleBody(fullName, issue.number).catch(() => null),
        loadApprovedRequirements(fullName, issue.number),
      ]);
      const requirements = requireApprovedRequirements(requirementsResult, `${fullName}#${issue.number}`);
      // `issue` comes from the 60 s-cached open-issue list; the plan must be written
      // against — and stamped with — the live content, or the stamped hash lags and
      // the dispatcher re-plans forever (#2524).
      const issueForPlan: gh.Issue = live ? { ...issue, title: live.title, body: live.body } : issue;
      const plannedLastCommentId = maxCommentId(comments);
      const duplicateCandidates = selectDuplicateCandidates(fullName, issueForPlan, allOpenIssues);
      const transferCandidates = transferEnabled()
        && !alreadyTransferredInto(fullName, [issueForPlan.body ?? "", ...comments.map((c) => c.body)])
        ? selectTransferCandidates(repo, allRepos) : [];
      const imageContext = await processTextForImages([issueForPlan.body, ...comments.map((c) => c.body)], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" });
      const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier, model, deepThinking, deepContext: deep } = await planModelForIssue(issue, fullName, "plan");
      const issueRepos = await plannerAllowedRepos(fullName, issue.number);
      const links = await issueLinks.listLinks(fullName, issue.number).catch((err) => {
        log.warn(`[issue-refiner] ${fullName}#${issue.number}: could not load links (${err})`);
        return [];
      });
      const previewSection = await issuePreviewSection(fullName, issue.number, issueRepos);
      const prompt = buildNewPlanPrompt(repo, issueForPlan, comments, selfLogin, duplicateCandidates, transferCandidates, deep, wtPath, allRepos, true, issueRepos, links, previewSection, requirements) + imageContext;

      const agentDoc = loadRepoAgentDoc(wtPath, fullName, "issue-refiner");
      const plannerCapabilities = plannerCapabilitiesForRepo(fullName);
      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      // Never classified: issue descriptions are often too sparse to classify
      // reliably, and the planner is the highest-leverage model call in the
      // whole pipeline — it produces the specification a smaller implementer
      // then has to follow. The `plan` phase defaults to claude/fable; only the
      // issue's model plan or a provider label moves it.
      log.info(`[issue-refiner] Using model "${model}" for planning ${fullName}#${issue.number}`);
      if (overrideIgnoredReason) log.warn(`[issue-refiner] ${fullName}#${issue.number}: ${overrideIgnoredReason}`);
      const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
      let actualProvider: Provider = provider;
      let actualModel = model;
      const candidateNumbers = duplicateCandidates.map((c) => c.number);
      // Shared across retry attempts so totals accumulate instead of the first attempt's cost being discarded.
      const trackTokens = db.trackTaskTokens(taskId);
      // Each attempt is its own planner run, so a retry starts from no submission.
      // The outcome comes only from an explicit claws_report_outcome call — a plan
      // may quote and discuss any outcome without triggering one (#3155).
      const runPlanner = async (extra: string) => {
        const result = await invokePlanner(
          { repo, issueRef: issue.number, wtPath, stage: "plan", allowedRepos: issueRepos, allowedDuplicates: candidateNumbers, allowedTransfers: transferCandidates, label: "Plan" },
          (mcpConfig) => claude.runClaude(prompt + extra, wtPath, { mcpConfig, timeoutMs, tier, model, provider, strictProvider, eligibleProviders, deepThinking, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onAttemptModelUsed: (_p, m) => { actualModel = m ?? "default"; }, onTokensUsed: trackTokens, captureLabel: "issue-refiner", githubTokenOwner: repo.owner, forgejoAccessRepo: repo.fullName, plannerCapabilities }),
        );
        const outcome = result.outcome;
        const duplicateOf = outcome?.kind === "duplicate" ? outcome.duplicateOf : null;
        const transferTo = outcome?.kind === "transfer" ? outcome.transferTo : null;
        const blocked = outcome?.kind === "blocked";
        const noCodeChanges = outcome?.kind === "no_code_changes";
        return { duplicateOf, transferTo, blocked, noCodeChanges, cleanedOutput: result.text, prs: result.prs, degenerate: result.degenerate };
      };

      let r;
      try {
        r = await runPlanner("");
        if (r.degenerate) {
          log.warn(`[issue-refiner] Degenerate plan output for ${fullName}#${issue.number} (${r.cleanedOutput.trim().length} chars, no model line, no claws_save_plan call) — retrying once`);
          r = await runPlanner(PLAN_RETRY_INSTRUCTION);
        }
      } finally {
        await persistProviderModel(taskId, actualProvider, actualModel);
      }
      const planFailed = r.degenerate;
      if (planFailed) log.warn(`[issue-refiner] Discarding degenerate plan output for ${fullName}#${issue.number} after retry — not posting; the dispatcher will re-plan`);
      const { duplicateOf, transferTo, blocked, noCodeChanges, cleanedOutput, prs: planPrs } = r;

      // Retained for the auto-Refined coverage gate below: the plan body actually
      // posted, which is what its phase count must be read from.
      let postedPlan: string | null = null;
      // Set only in the plan-posting branch below when step-back returned
      // "reconsider" — gates the auto-Refined block further down (#3091).
      let withheld = false;
      let stepBackRevisedPlan = false;

      if (!planFailed && (cleanedOutput.trim() || duplicateOf !== null || noCodeChanges || blocked || transferTo !== null)) {
        let attribution = `*Models used: ${actualModel} (provider: ${actualProvider}${providerNote})*`;
        if (duplicateOf !== null) {
          // Use plain text marker (CLAWS_DUPLICATE_OF:) not hidden HTML comment — aligns with NO_HTML_COMMENTS_INSTRUCTION.
          // The prompt asks for a short paragraph saying WHICH issue this duplicates and why;
          // carry it through like the blocked/no-code-changes branches do, so the human sees
          // the planner's reasoning rather than the bare "shares a root cause" sentence.
          const dupBody = [
            `This issue appears to share a root cause with #${duplicateOf}. See that issue for the full implementation plan.`,
            ``,
            cleanedOutput.trim() || "(no further detail provided)",
            ``,
            `CLAWS_DUPLICATE_OF: #${duplicateOf}`,
            ``,
            `If you believe this is NOT a duplicate, remove the \`Duplicate\` label and re-add \`Ready\` — Claws will re-plan with your comment as context.`,
          ].join("\n");
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${dupBody}\n\n${attribution}`, { agentName: "Planner" });
          await gh.addLabel(fullName, issue.number, LABELS.duplicate);
          log.info(`[issue-refiner] Marked ${fullName}#${issue.number} as duplicate of #${duplicateOf}`);
          try {
            await gh.commentOnIssue(
              fullName,
              duplicateOf,
              `Claws planner identified #${issue.number} as a likely duplicate of this issue (same root cause). Leaving both open; this plan covers both.`,
              { agentName: "Planner" },
            );
          } catch (err) {
            log.warn(`[issue-refiner] Failed to post back-reference on canonical #${duplicateOf}: ${err}`);
          }
        } else if (transferTo !== null) {
          // Neutralise any stray plan header in model output — see TRANSFER_HEADER's doc comment.
          const rationale = (cleanedOutput || "(no further detail provided)").replaceAll(PLAN_HEADER, "Implementation plan");
          await gh.commentOnIssue(fullName, issue.number, [
            TRANSFER_HEADER, ``,
            `The planner determined this issue belongs to **${transferTo}**, not ${fullName}.`, ``,
            rationale, ``,
            `${TRANSFERRED_FROM_MARKER} ${fullName}#${issue.number}`, ``,
            `Claws is transferring this issue now. The destination repository will plan it from`,
            `scratch on the next dispatcher tick. Claws will not transfer it a second time — if the`,
            `destination is wrong, move it back manually.`, ``,
            attribution,
          ].join("\n"), { agentName: "Planner" });

          // A stale `Ready` ("Claws has finished") must not travel to the destination.
          if (issue.labels.some((l) => l.name === LABELS.ready)) {
            await gh.removeLabel(fullName, issue.number, LABELS.ready).catch(() => {});
          }

          try {
            const newUrl = await gh.transferIssue(fullName, issue.number, transferTo);
            log.info(`[issue-refiner] Transferred ${fullName}#${issue.number} to ${transferTo}: ${newUrl}`);
          } catch (err) {
            log.warn(`[issue-refiner] Transfer of ${fullName}#${issue.number} to ${transferTo} failed: ${String(err)}`);
            await gh.commentOnIssue(fullName, issue.number,
              `Automatic transfer to \`${transferTo}\` failed — please move this issue manually (Issue → Transfer issue). Applying \`${LABELS.clawsIgnore}\` so Claws stops re-planning it here.`,
              { agentName: "Planner" },
            );
            await gh.addLabel(fullName, issue.number, LABELS.clawsIgnore);
          }
        } else if (blocked) {
          const blockedBody = [
            `${BLOCKED_PLAN_SENTENCE} and cannot be implemented yet.`,
            ``,
            cleanedOutput || "(no further detail provided)",
            ``,
            `Claws is applying the \`${LABELS.blocked}\` label so it stops re-planning and implementing`,
            `this issue, and is removing \`${LABELS.ready}\` so it no longer sits in the awaiting-plan-review`,
            `pile. The issue stays open as a record. Remove \`${LABELS.blocked}\` (and add \`${LABELS.ready}\`)`,
            `once the blocker clears. If the blocker is another tracker issue, link the dependency (issue page`,
            `or \`claws_link_issues\`) so Claws unparks it automatically; for an external repo, add a watch file`,
            `under \`docs/upstream-watches/\` in the claws repo.`,
          ].join("\n");
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${blockedBody}\n\n${attribution}`, { agentName: "Planner" });
          await gh.addLabel(fullName, issue.number, LABELS.blocked);
          if (issue.labels.some((l) => l.name === LABELS.ready)) {
            await gh.removeLabel(fullName, issue.number, LABELS.ready).catch(() => {});
          }
          log.info(`[issue-refiner] ${fullName}#${issue.number} is blocked — applied ${LABELS.blocked}`);
        } else if (noCodeChanges) {
          const ncBody = [
            `The planner determined this issue does **not** require any code change to this repository.`,
            ``,
            cleanedOutput || "(no further detail provided)",
            ``,
            `Claws is applying the \`${LABELS.clawsIgnore}\` label so it stops re-planning and`,
            `implementing this issue. The issue stays open as a record. If you believe a code`,
            `change IS needed, remove the \`${LABELS.clawsIgnore}\` label and add the \`${LABELS.ready}\``,
            `label — Claws will re-plan with your comment as context.`,
          ].join("\n");
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${ncBody}\n\n${attribution}`, { agentName: "Planner" });
          await gh.addLabel(fullName, issue.number, LABELS.clawsIgnore);
          log.info(`[issue-refiner] ${fullName}#${issue.number} needs no code changes — applied ${LABELS.clawsIgnore}`);
        } else {
          const planProvider = actualProvider;
          const planModel = actualModel;
          let stepBackProvider = planProvider;
          let stepBackModel = planModel;
          const stepBack = await runStepBack({ repo, issue, wtPath, planBody: cleanedOutput, model, tier, provider, strictProvider, eligibleProviders, deepPlan: deep, deepThinking, timeoutMs, agentDoc, taskId, plannerCapabilities, issueRepos, requirements, onProviderUsed: (p) => { stepBackProvider = p; }, onAttemptModelUsed: (_p, m) => { stepBackModel = m ?? "default"; } });
          withheld = stepBack.verdict === "reconsider";
          stepBackRevisedPlan = stepBack.revisedPlan !== null;
          if (stepBack.revisedPlan) {
            actualProvider = stepBackProvider;
            actualModel = stepBackModel;
          } else {
            actualProvider = planProvider;
            actualModel = planModel;
          }
          await persistProviderModel(taskId, actualProvider, actualModel);
          attribution = `*Models used: ${actualModel} (provider: ${actualProvider}${providerNote})*`;
          const finalPlan = stepBack.revisedPlan ?? cleanedOutput;
          const { stamp: stampRequirements, postNotice } = await requirementsStampFor(fullName, issue.number, finalPlan, requirements, comments, /* isFresh */ true);
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${finalPlan}\n\n${attribution}${planMarkersFor({ ...issueForPlan, requirements: stampRequirements }, plannedLastCommentId, { stepBackReconsider: withheld })}`, { agentName: "Planner" });
          await postNotice();
          log.info(`[issue-refiner] Posted plan for ${fullName}#${issue.number}${stepBack.revisedPlan ? " (revised after step-back)" : ""}`);
          await syncPreviewsAfterPlan(fullName, issue.number, issueRepos);
          // The step-back revision's list wins. A revision from the text-marker
          // fallback carries none, and recordPlannedPRs then keeps a stored list
          // only if it still matches the revised text's `### PR N:` count.
          await recordPlannedPRs(fullName, issueForPlan, finalPlan, stepBack.revisedPlan ? stepBack.revisedPrs : planPrs);
          await persistSuggestedModelPlan(fullName, issue.number, finalPlan);
          // Must NOT contain PLAN_HEADER — plan lookup elsewhere finds the LAST comment
          // containing it, so a second such comment would hijack that lookup.
          if (withheld) {
            const critiqueText = stepBack.critique || "The step-back pass flagged this plan for reconsideration but gave no critique.";
            const withheldNote = isAutoRefineIssue(issue)
              ? `\n\nClaws is withholding auto-\`${LABELS.refined}\` on this plan — a human should review it (and this critique) and apply \`${LABELS.refined}\` by hand.`
              : "";
            await gh.commentOnIssue(fullName, issue.number, `${STEP_BACK_HEADER}\n\n${critiqueText}${withheldNote}`, { agentName: "Planner" });
          }
          await warnIfPlanTooLong(fullName, issue.number, finalPlan.length, "Plan");
          postedPlan = finalPlan;
        }
      } else {
        log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
      }

      if (duplicateOf === null && !noCodeChanges && !blocked && transferTo === null) {
        await gh.addLabel(fullName, issue.number, LABELS.ready);

        if (postedPlan !== null && isAutoRefineIssue(issue)) {
          if (await gh.isAllowedActor(issue.author.login, fullName, issue.number)) {
            if (withheld) {
              log.info(`[issue-refiner] Not auto-refining ${fullName}#${issue.number}: step-back verdict was "reconsider"${stepBackRevisedPlan ? " (plan revised)" : ""}; leaving at Ready for human review`);
            } else {
              // A fresh plan can land on an issue whose phase-covering PRs have already
              // merged — the old plan comment was deleted, or the steps shipped
              // out-of-band. Handing that to the implementer just makes its all-covered
              // guard strip `Refined` again, so gate on coverage the same way the
              // dispatcher does (#2821).
              const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number).catch(() => []);
              const { totalPhases, coverage } = await loadIssuePhaseState(fullName, issue.number, comments, { planText: postedPlan, mergedPRs });
              if (coverage.nextPhase === null) {
                log.info(`[issue-refiner] Not auto-refining ${fullName}#${issue.number}: all ${totalPhases} plan phase(s) already covered`);
              } else {
                await gh.addLabel(fullName, issue.number, LABELS.refined);
                log.info(`[issue-refiner] Auto-refined issue ${fullName}#${issue.number}`);
              }
            }
          } else {
            log.warn(`[issue-refiner] Skipping auto-Refined for issue ${fullName}#${issue.number} — author @${issue.author.login} is not an allowed actor`);
          }
        }
      }

      await db.recordTaskComplete(taskId, { commits: 0 });
    });
  });
}

export async function processRefinement(
  repo: Repo,
  issue: gh.Issue,
  unreactedComments: gh.IssueComment[],
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Refining plan for ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("issue-refiner", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "issue-refiner", async (wtPath) => {
      await db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin, live, requirementsResult] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLoginForIssue(repo.fullName, issue.number),
        gh.getIssueTitleBody(fullName, issue.number).catch(() => null),
        loadApprovedRequirements(fullName, issue.number),
      ]);
      const requirements = requireApprovedRequirements(requirementsResult, `${fullName}#${issue.number}`);
      const issueForPlan: gh.Issue = live ? { ...issue, title: live.title, body: live.body } : issue;
      const plannedLastCommentId = maxCommentId(comments);
      const lastPlanIdx = comments.findLastIndex((c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body));
      const agentDoc = loadRepoAgentDoc(wtPath, fullName, "issue-refiner");
      const plannerCapabilities = plannerCapabilitiesForRepo(fullName);

      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      const issueRepos = await plannerAllowedRepos(fullName, issue.number);
      // Never classified, for the same reason as processIssue. Reacting to
      // feedback is the `plan-refine` phase, which defaults to claude/opus;
      // with no plan comment to refine this run writes a fresh plan, so it
      // resolves against `plan` like processIssue.
      const phase = lastPlanIdx === -1 ? "plan" : "plan-refine";
      const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier, model, deepThinking, deepContext: deep } = await planModelForIssue(issue, fullName, phase);
      if (overrideIgnoredReason) log.warn(`[issue-refiner] ${fullName}#${issue.number}: ${overrideIgnoredReason}`);
      const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
      log.info(`[issue-refiner] Using model "${model}" for refinement ${fullName}#${issue.number}`);

      if (lastPlanIdx === -1) {
        log.warn(`[issue-refiner] No plan comment found for ${fullName}#${issue.number}, posting fresh plan`);
        const imageContext = await processTextForImages([issueForPlan.body, ...comments.map((c) => c.body)], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" });
        const allRepos = await gh.listRepos().catch(() => []);
        const links = await issueLinks.listLinks(fullName, issue.number).catch((err) => {
          log.warn(`[issue-refiner] ${fullName}#${issue.number}: could not load links (${err})`);
          return [];
        });
        const previewSection = await issuePreviewSection(fullName, issue.number, issueRepos);
        const prompt = buildNewPlanPrompt(repo, issueForPlan, comments, selfLogin, [], [], deep, wtPath, allRepos, false, issueRepos, links, previewSection, requirements) + imageContext;
        let actualProvider: Provider = provider;
        let actualModel = model;
        const runOpts = { timeoutMs, tier, model, provider, strictProvider, eligibleProviders, deepThinking, appendSystemPrompt: agentDoc, onProviderUsed: (p: Provider) => { actualProvider = p; }, onAttemptModelUsed: (_p: Provider, m: string | undefined) => { actualModel = m ?? "default"; }, onTokensUsed: db.trackTaskTokens(taskId), captureLabel: "issue-refiner", githubTokenOwner: repo.owner, forgejoAccessRepo: repo.fullName, plannerCapabilities };
        // Plan-only: this flow has no duplicate/transfer/blocked handling, so the
        // run rejects claws_report_outcome and the prompt never offers it.
        const runFresh = (extra: string) => invokePlanner(
          { repo, issueRef: issue.number, wtPath, stage: "plan", allowedRepos: issueRepos, allowOutcomes: false, label: "Fresh plan" },
          (mcpConfig) => claude.runClaude(prompt + extra, wtPath, { ...runOpts, mcpConfig }),
        );
        let fresh: PlannerRunResult;
        try {
          fresh = await runFresh("");
          if (fresh.degenerate) {
            log.warn(`[issue-refiner] Degenerate fresh-plan output for ${fullName}#${issue.number} — retrying once`);
            fresh = await runFresh(PLAN_RETRY_INSTRUCTION);
          }
        } finally {
          await persistProviderModel(taskId, actualProvider, actualModel);
        }

        if (fresh.text.trim() && !fresh.degenerate) {
          const cleaned = fresh.text;
          const attribution = `*Models used: ${actualModel} (provider: ${actualProvider}${providerNote})*`;
          const { stamp: stampRequirements, postNotice } = await requirementsStampFor(fullName, issue.number, cleaned, requirements, comments, /* isFresh */ true);
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${cleaned}\n\n${attribution}${planMarkersFor({ ...issueForPlan, requirements: stampRequirements }, plannedLastCommentId)}`, { agentName: "Planner" });
          await postNotice();
          log.info(`[issue-refiner] Posted fresh plan for ${fullName}#${issue.number}`);
          await syncPreviewsAfterPlan(fullName, issue.number, issueRepos);
          await recordPlannedPRs(fullName, issueForPlan, cleaned, fresh.prs);
          await persistSuggestedModelPlan(fullName, issue.number, cleaned);
          await warnIfPlanTooLong(fullName, issue.number, cleaned.length, "Fresh plan", comments);
        } else {
          log.warn(`[issue-refiner] Empty or degenerate plan output for ${fullName}#${issue.number}`);
        }
      } else {
        const planComment = comments[lastPlanIdx];
        const feedback = unreactedComments;

        // Name the steps that have already shipped. Without this the model sees
        // only the plan and the feedback, and rewrites a partly-shipped multi-PR
        // plan as "the work that is left" — dropping the `### PR N:` headers the
        // merged PRs were numbered against (#2821).
        // With a stored PR list, the recorded entries (and their linked PRs) are
        // what the planner must preserve; without one, the text-derived note.
        const parsedExisting = parsePlan(planComment.body);
        let coverageNote = "";
        const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number).catch(() => []);
        const phaseState = await loadIssuePhaseState(fullName, issue.number, comments, { planText: planComment.body, mergedPRs });
        if (phaseState.entries) {
          coverageNote = recordedPRsNote(phaseState);
        } else if (parsedExisting.totalPhases > 1) {
          const coverage = phaseState.coverage;
          const shipped = [...coverage.done].sort((a, b) => a - b).map((n) => {
            const pr = coverage.coveringPRs.get(n);
            return `step ${n}${pr ? ` (PR #${pr.number}, merged)` : " (claimed)"}`;
          });
          if (shipped.length > 0) {
            coverageNote = `\n\nAlready shipped and NOT to be re-planned or renumbered: ${shipped.join(", ")}. Keep their \`### PR N:\` headers in place.`;
          }
        }

        const imageContext = await processTextForImages([issueForPlan.body, ...comments.map((c) => c.body)], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" });
        const allRepos = await gh.listRepos().catch(() => []);
        const links = await issueLinks.listLinks(fullName, issue.number).catch((err) => {
          log.warn(`[issue-refiner] ${fullName}#${issue.number}: could not load links (${err})`);
          return [];
        });
        const previewSection = await issuePreviewSection(fullName, issue.number, issueRepos);
        const prompt = buildRefinementPrompt(repo, issueForPlan, planComment.body, parsedExisting, feedback, selfLogin, deep, wtPath, allRepos, issueRepos, links, previewSection, requirements) + imageContext + coverageNote;
        let actualProvider: Provider = provider;
        let actualModel = model;
        // Shared across retry attempts so totals accumulate instead of the first attempt's cost being discarded.
        const trackTokens = db.trackTaskTokens(taskId);
        // The reply to feedback travels in claws_save_plan's `response` field, so it
        // can never leak into — or stand in for — the plan body.
        const runRefiner = (extra: string) => invokePlanner(
          { repo, issueRef: issue.number, wtPath, stage: "refine", allowedRepos: issueRepos, allowOutcomes: false, label: "Refinement" },
          (mcpConfig) => claude.runClaude(prompt + extra, wtPath, { mcpConfig, timeoutMs, tier, model, provider, strictProvider, eligibleProviders, deepThinking, appendSystemPrompt: agentDoc, onProviderUsed: (p: Provider) => { actualProvider = p; }, onAttemptModelUsed: (_p, m) => { actualModel = m ?? "default"; }, onTokensUsed: trackTokens, captureLabel: "issue-refiner", githubTokenOwner: repo.owner, forgejoAccessRepo: repo.fullName, plannerCapabilities }),
        );

        let refined: PlannerRunResult;
        try {
          refined = await runRefiner("");
          if (refined.degenerate) {
            log.warn(`[issue-refiner] Degenerate refinement output for ${fullName}#${issue.number} — retrying once`);
            refined = await runRefiner(PLAN_RETRY_INSTRUCTION);
          }
        } finally {
          await persistProviderModel(taskId, actualProvider, actualModel);
        }
        const cleanedPlanBody = refined.text;
        const response = refined.response;

        if (cleanedPlanBody.trim() && !refined.degenerate) {
          // Build attribution, preserving the original model and replacing any prior
          // "Refined with" segment so it doesn't grow unboundedly on each refinement.
          const newAttribution = `*Models used: ${actualModel} (provider: ${actualProvider}${providerNote})*`;
          const existingAttrib = extractModelsAttribution(planComment.body);
          const attribution = (() => {
            if (!existingAttrib) return newAttribution;
            // Extract the original model (first segment before any | Refined with: ...)
            const originalPart = existingAttrib
              .replace(/^\*Models used:\s*/, "")
              .replace(/\*$/, "")
              .split(/\s*\|\s*/)[0]
              .trim();
            const originalAttrib = `*Models used: ${originalPart}*`;
            if (originalAttrib === newAttribution) return newAttribution;
            return `*Models used: ${originalPart} | Refined with: ${actualModel} (provider: ${actualProvider}${providerNote})*`;
          })();

          // A refinement that changes the step count re-bases phase accounting for
          // PRs that already merged under the old numbering (#2821). The plan body
          // is written through regardless — rejecting it would silently discard the
          // operator's feedback — but the change is recorded so the downstream
          // all-covered state can be traced back to it.
          const refinedTotal = parsePlan(cleanedPlanBody).totalPhases;
          if (parsedExisting.totalPhases > 1 && refinedTotal !== parsedExisting.totalPhases) {
            log.warn(`[issue-refiner] Refinement changed the phase count for ${fullName}#${issue.number}: ${parsedExisting.totalPhases} -> ${refinedTotal}`);
          }

          // The prompt asks the model to drop a pre-record plan's own `### Requirement`
          // section and cite the version, but a model that ignores that instruction must
          // not be trusted to have done it — stamping the record hash here would make an
          // un-rewritten plan look upgraded and never be retried.
          const { stamp: stampRequirements, postNotice } = await requirementsStampFor(fullName, issue.number, cleanedPlanBody, requirements, comments, /* isFresh */ false);
          await postNotice();

          await gh.editIssueComment(fullName, planComment.id, `${PLAN_HEADER}\n\n${cleanedPlanBody}\n\n${attribution}${planMarkersFor({ ...issueForPlan, requirements: stampRequirements }, plannedLastCommentId, { stepBackReconsider: hasStepBackReconsiderMarker(planComment.body) })}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Updated plan comment for ${fullName}#${issue.number}`);
          await syncPreviewsAfterPlan(fullName, issue.number, issueRepos);
          await recordPlannedPRs(fullName, issueForPlan, cleanedPlanBody, refined.prs);
          await persistSuggestedModelPlan(fullName, issue.number, cleanedPlanBody);

          // Only human feedback earns a reply comment. Occurrence-triggered re-plans
          // (ISSUE_REFINER_REPLAN passes an empty feedback list) posted a "no feedback
          // was left, so I re-verified…" comment on every pass — four on
          // fleet-infra#878 alone (#2558).
          if (feedback.length > 0 && response) {
            await gh.commentOnIssue(fullName, issue.number, response, { agentName: "Planner" });
            log.info(`[issue-refiner] Posted response comment for ${fullName}#${issue.number}`);
          }

          await warnIfPlanTooLong(fullName, issue.number, cleanedPlanBody.length, "Refined plan", comments);
        } else {
          // Re-stamp anyway: a model returning nothing would otherwise leave the plan's
          // hash pinned to the pre-edit body, and the dispatcher would re-plan forever.
          // stripClawsMarker first — editIssueComment re-prepends the header, so
          // echoing the raw comment body back would duplicate it on every empty run.
          //
          // What the stamped hash alone can tell us about the plan's relationship to
          // the record (no `CLAWS_PLAN_REQUIREMENTS_VERSION` marker — the marker set
          // stays as designed):
          // - It matches the current record's hash: known already current: stamping
          //   again is a no-op.
          // - It matches the current body-only hash (or there is no hash at all —
          //   a legacy pre-marker plan): known written before any record — keep it
          //   body-only, so the plan stays stale and the next tick retries the real
          //   upgrade, and count the stall so an unlucky streak of empty output
          //   doesn't retry forever.
          // - Neither: stamped against an earlier record version, or a body-only
          //   stamp whose body has since changed too. There's no way to tell whether
          //   this text was ever rewritten against the *current* record, so guessing
          //   "current" would make an un-rewritten plan look upgraded — leave the
          //   existing stamp untouched while the stall cap still allows a retry, and
          //   count it as a stalled attempt like the body-only case so a human-edited
          //   issue whose refinements keep coming back empty doesn't re-plan forever.
          const bodyOnlyHash = issueContentHash(issueForPlan.title, issueForPlan.body);
          const stampedHash = parsePlanBodyHash(planComment.body);
          let restampRequirements: ApprovedRequirements | null = null;
          let hashOverride: string | undefined;
          let note = "";
          if (requirements !== null) {
            const currentRecordHash = issueContentHash(issueForPlan.title, issueForPlan.body, requirements);
            if (stampedHash === currentRecordHash) {
              restampRequirements = requirements;
            } else if (stampedHash === null || stampedHash === bodyOnlyHash) {
              const { gaveUp, postNotice } = await trackRequirementsUpgradeStall(fullName, issue.number, requirements, comments, "empty", false);
              await postNotice();
              if (gaveUp) {
                restampRequirements = requirements;
                note = " (gave up upgrading after repeated stalls; stamped against the record without a rewrite)";
              } else {
                note = " (kept body-only; the plan was never rewritten against the newly approved record)";
              }
            } else {
              const { gaveUp, postNotice } = await trackRequirementsUpgradeStall(fullName, issue.number, requirements, comments, "empty", false);
              await postNotice();
              if (gaveUp) {
                restampRequirements = requirements;
                note = " (gave up upgrading after repeated stalls; stamped against the record without a rewrite — can't tell whether the plan text ever matched it)";
              } else {
                hashOverride = stampedHash;
                note = " (kept the existing stamp; can't tell whether the plan text matches the currently-approved record)";
              }
            }
          }
          await gh.editIssueComment(
            fullName,
            planComment.id,
            `${stripPlanMarkers(gh.stripClawsMarker(planComment.body))}${planMarkersFor({ ...issueForPlan, requirements: restampRequirements }, plannedLastCommentId, { stepBackReconsider: hasStepBackReconsiderMarker(planComment.body), hashOverride })}`,
            { agentName: "Planner" },
          );
          log.warn(`[issue-refiner] Empty or degenerate refinement output for ${fullName}#${issue.number} — re-stamped plan markers${note} to avoid a re-plan loop`);
        }
      }

      // React 👍 to each addressed comment
      for (const comment of unreactedComments) {
        await gh.addReaction(fullName, comment.id, "+1");
      }

      await gh.addLabel(fullName, issue.number, LABELS.ready);
      await db.recordTaskComplete(taskId, { commits: 0 });
    });
  });
}

export async function processFollowUp(
  repo: Repo,
  issue: gh.Issue,
  /** Every open PR implementing a step of the issue's plan, in any of its repos. */
  openPRs: readonly OpenPhasePR[],
  unreactedComments: gh.IssueComment[],
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Responding to follow-up on ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("issue-refiner", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "issue-refiner", async (wtPath) => {
      await db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin, requirementsResult] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLoginForIssue(repo.fullName, issue.number),
        loadApprovedRequirements(fullName, issue.number),
      ]);
      // A follow-up reply stamps no plan hash, so a failed read just degrades
      // to answering from the issue body alone rather than aborting the run.
      const requirements = approvedRequirementsOrNull(requirementsResult);
      const lastPlanIdx = comments.findLastIndex(
        (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
      );

      if (lastPlanIdx === -1) {
        log.warn(`[issue-refiner] No plan comment found for follow-up on ${fullName}#${issue.number}, skipping`);
        await db.recordTaskComplete(taskId, { commits: 0 });
        return;
      }

      const planComment = comments[lastPlanIdx];
      const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" });

      const guardCtx = makeGuardCtx(fullName, issue.number);
      // Each PR is read in its own repo: a multi-repo plan's step lives in the
      // repo its entry names, not necessarily this one.
      const prSummary = (await Promise.all(openPRs.map(async (pr) => {
        const [prBody, prFiles] = await Promise.all([
          gh.getPRBody(pr.repo, pr.number).catch(() => ""),
          gh.getPRChangedFiles(pr.repo, pr.number).catch(() => [] as string[]),
        ]);
        return [
          `Here is what PR ${followUpPRRef(fullName, pr)}${pr.phase !== null ? ` (plan step ${pr.phase})` : ""} actually contains:`,
          ``,
          `Repository: ${pr.repo}`,
          `Title: ${guardContent(pr.title, guardCtx("pr-title"))}`,
          ``,
          `Body:`,
          guardContent(prBody.slice(0, 4000), guardCtx("pr-body")) || "(no body)",
          ``,
          `Changed files (${prFiles.length}):`,
          ...prFiles.slice(0, 50).map((f) => `- ${f}`),
          ...(prFiles.length > 50 ? [`- …and ${prFiles.length - 50} more`] : []),
        ].join("\n");
      }))).join("\n\n");

      const prompt = buildFollowUpPrompt(repo, issue, planComment.body, openPRs, unreactedComments, selfLogin, wtPath, prSummary, requirements) + imageContext;

      const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
      const agentDoc = loadRepoAgentDoc(wtPath, fullName, "issue-refiner");
      const plannerCapabilities = plannerCapabilitiesForRepo(fullName);
      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      // Follow-ups don't need complexity classification — the issue is already
      // planned. An operator's `plan-refine` cell applies, but answering a
      // question stays on sonnet by default and ignores `Plan: Deep`.
      const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier, model, deepThinking } = await planModelForIssue(issue, fullName, "plan-refine", { followUp: true });
      if (overrideIgnoredReason) log.warn(`[issue-refiner] ${fullName}#${issue.number}: ${overrideIgnoredReason}`);
      const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
      let actualProvider: Provider = provider;
      let actualModel = model;
      const response = await (async () => {
        try {
          return await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider, strictProvider, eligibleProviders, deepThinking, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onAttemptModelUsed: (_p, m) => { actualModel = m ?? "default"; }, captureLabel: "issue-refiner", githubTokenOwner: repo.owner, forgejoAccessRepo: repo.fullName, plannerCapabilities, useOutputFile: true });
        } finally {
          await persistProviderModel(taskId, actualProvider, actualModel);
        }
      })();

      if (response.trim()) {
        const attribution = `*Models used: ${actualModel} (provider: ${actualProvider}${providerNote})*`;
        await gh.commentOnIssue(fullName, issue.number, `${response.trim()}\n\n${attribution}`, { agentName: "Planner" });
        log.info(`[issue-refiner] Posted follow-up response for ${fullName}#${issue.number}`);
      } else {
        log.warn(`[issue-refiner] Empty follow-up response for ${fullName}#${issue.number}`);
      }

      for (const comment of unreactedComments) {
        await gh.addReaction(fullName, comment.id, "+1");
      }

      await db.recordTaskComplete(taskId, { commits: 0 });
    });
  });
}

/**
 * `issueNumber` is the issue the comments came off. It reaches
 * `gh.isAllowedActor` so the native `claws` author is trusted on a native
 * issue and nowhere else — a forge account named `claws` must not be able to
 * put owner feedback into an agent prompt.
 */
export async function findUnreactedHumanComments(
  fullName: string,
  commentsAfterPlan: gh.IssueComment[],
  selfLogin: string,
  issueNumber: IssueRef,
): Promise<gh.IssueComment[]> {
  // Phase A: synchronous filters + sequential isAllowedActor (async).
  const candidates: gh.IssueComment[] = [];
  for (const comment of commentsAfterPlan) {
    if (gh.isClawsComment(comment.body)) continue;
    if (comment.login.endsWith("[bot]")) continue;
    if (!await gh.isAllowedActor(comment.login, fullName, issueNumber)) continue;
    candidates.push(comment);
  }

  // Phase B: independent reaction fetches in parallel; per-item catch
  // defaults a failed fetch to "unreacted" (preserves old behavior).
  const results = await Promise.all(
    candidates.map(async (comment) => {
      try {
        const reactions = await gh.getCommentReactions(fullName, comment.id);
        const hasReaction = reactions.some(
          (r) => r.user.login === selfLogin && r.content === "+1",
        );
        return hasReaction ? null : comment;
      } catch {
        return comment;
      }
    }),
  );
  return results.filter((c): c is gh.IssueComment => c !== null);
}

/**
 * Comments the plan did not see: those after the plan comment, plus any created
 * during the run (id greater than the id stamped at run start). Comment ids are
 * monotonically increasing, so this is a reliable "arrived after we snapshotted"
 * test.
 *
 * The fence has three states: `fence === null` means a legacy plan predating the
 * marker, where only the after-the-plan-only fallback applies; `fence === 0` means
 * the run's snapshot held no comments at all (a brand-new issue), so every comment
 * on the issue counts as feedback, including ones that landed before the plan
 * comment in thread order; any other value is the highest comment id the run had
 * actually seen (#2524, #2623).
 */
export function selectFeedbackCandidates(
  comments: gh.IssueComment[],
  lastPlanIdx: number,
): gh.IssueComment[] {
  const fence = parsePlanLastCommentId(comments[lastPlanIdx].body);
  const planId = comments[lastPlanIdx].id;
  return comments.filter(
    (c, i) => i > lastPlanIdx || (fence !== null && compareIssueRefs(c.id, fence) > 0 && c.id !== planId),
  );
}

export async function findUnreactedFeedbackAfterPlan(
  fullName: string,
  issueNumber: IssueRef,
  selfLogin: string,
): Promise<{ hasPlan: boolean; unreacted: gh.IssueComment[]; plannedOccurrences: number | null; hasEscalationReview: boolean; plannedBodyHash: string | null }> {
  const comments = await gh.getIssueComments(fullName, issueNumber);
  const lastPlanIdx = comments.findLastIndex(
    (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
  );
  if (lastPlanIdx === -1) {
    return { hasPlan: false, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null };
  }
  const after = comments.slice(lastPlanIdx + 1);
  const unreacted = await findUnreactedHumanComments(
    fullName,
    selectFeedbackCandidates(comments, lastPlanIdx),
    selfLogin,
    issueNumber,
  );
  // Scanned only AFTER the last plan on purpose: a re-plan invalidates the old
  // verdict, so a fresh escalation review runs against the new plan.
  const hasEscalationReview = after.some(
    (c) => gh.isClawsComment(c.body) && c.body.includes(ESCALATION_REVIEW_HEADER),
  );
  return {
    hasPlan: true,
    unreacted,
    plannedOccurrences: parsePlannedOccurrences(comments[lastPlanIdx].body),
    hasEscalationReview,
    plannedBodyHash: parsePlanBodyHash(comments[lastPlanIdx].body),
  };
}

export async function stripRefinedForPendingFeedback(
  fullName: string,
  issueNumber: IssueRef,
  unreacted: gh.IssueComment[],
  agentName: string,
): Promise<void> {
  try {
    const newestId = maxCommentId(unreacted);
    const notice = `${PENDING_FEEDBACK_MARKER}: ${newestId}`;
    await gh.removeLabel(fullName, issueNumber, LABELS.refined);
    log.info(`[issue-refiner] Removed ${LABELS.refined} from ${fullName}#${issueNumber}: ${unreacted.length} unaddressed human comment(s) after the plan`);
    const comments = await gh.getIssueComments(fullName, issueNumber);
    if (comments.some((c) => c.body.includes(notice))) return;
    await gh.commentOnIssue(fullName, issueNumber, [
      `There is human feedback on this issue that the plan above has not addressed yet, so implementing now would build the wrong thing.`,
      ``,
      `Claws has removed the \`${LABELS.refined}\` label. The planner will address the comment(s), update the plan in place and reply, then re-apply \`${LABELS.ready}\`. Re-apply \`${LABELS.refined}\` once the updated plan looks right.`,
      ``,
      notice,
    ].join("\n"), { agentName });
  } catch (err) {
    // Never let this break the dispatcher/worker loop — a transient GitHub failure
    // here must not abort the rest of a repo's Phase 1/2/3 pass or a worker run.
    log.warn(`[issue-refiner] Failed to strip ${LABELS.refined} for pending feedback on ${fullName}#${issueNumber}: ${String(err)}`);
  }
}
