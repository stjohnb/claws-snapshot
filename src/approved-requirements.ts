/**
 * The approved requirements record an issue is planned, implemented and
 * reviewed against (docs/refinements/issue-flow.md "Planner changes").
 *
 * The approved version is the one `claws_issues.approved_requirements_version`
 * names — a newer, unapproved version is ignored. An issue with none (planned
 * before the requirements stage, or promoted with no record) gets `{ status:
 * "none" }`, and every caller falls back to the issue body exactly as before.
 * A failed read gets `{ status: "error" }` instead — see
 * {@link ApprovedRequirementsResult}.
 */

import * as db from "./db.js";
import * as log from "./log.js";
import { resolveTrackerId } from "./planned-prs.js";
import { guardContent, makeGuardCtx } from "./prompt-guard.js";
import type { IssueRef } from "./issue-id.js";
import type { IssueRequirementsVersion } from "./claws-issues.js";

/** The approved version of an issue's requirements record, with who approved it. */
export interface ApprovedRequirements extends IssueRequirementsVersion {
  approvedBy: string | null;
  approvedAt: string | null;
}

function fromDbRow(row: db.ClawsIssueRequirementsRow, approvedBy: string | null, approvedAt: string | null): ApprovedRequirements {
  return {
    version: Number(row.version),
    title: row.title,
    kind: row.kind,
    context: row.context,
    requirement: row.requirement,
    acceptanceCriteria: row.acceptance_criteria,
    outOfScope: row.out_of_scope,
    commentId: row.comment_id,
    createdAt: String(row.created_at),
    approvedBy,
    approvedAt,
  };
}

/**
 * The result of a {@link loadApprovedRequirements} read. "none" and "error"
 * are deliberately distinct — a caller that only checked `record === null`
 * used to treat a database hiccup exactly like "this issue has no record",
 * which broke the stale-plan check (a plan stamped against a record would
 * look stale on the next successful read) and let the planner stamp a
 * body-only hash for an issue that does have a record.
 */
export type ApprovedRequirementsResult =
  | { status: "none" }
  | { status: "approved"; record: ApprovedRequirements }
  | { status: "error" };

/**
 * The issue's approved requirements version. Never throws: a failed read is
 * logged and reported as `{ status: "error" }` rather than thrown, so every
 * caller decides for itself how to treat "unknown" — see
 * {@link requireApprovedRequirements} and {@link approvedRequirementsOrNull}.
 */
export async function loadApprovedRequirements(repo: string, ref: IssueRef): Promise<ApprovedRequirementsResult> {
  try {
    const trackerId = await resolveTrackerId(repo, ref);
    if (!trackerId) return { status: "none" };
    const issue = await db.getClawsIssue(trackerId);
    if (issue?.approved_requirements_version == null) return { status: "none" };
    const approved = Number(issue.approved_requirements_version);
    const row = (await db.listClawsIssueRequirements(trackerId)).find((r) => Number(r.version) === approved);
    if (!row) return { status: "none" };
    return {
      status: "approved",
      record: fromDbRow(row, issue.requirements_approved_by, issue.requirements_approved_at == null ? null : String(issue.requirements_approved_at)),
    };
  } catch (err) {
    log.warn(`[approved-requirements] Could not read the approved requirements for ${repo}#${ref}: ${err}`);
    return { status: "error" };
  }
}

/**
 * The approved requirements version of every open issue that has one, keyed
 * by tracker id — a dispatcher tick's batched read, so a per-issue check can
 * use {@link approvedRequirementsFromBatch} instead of repeating
 * {@link loadApprovedRequirements}'s `getClawsIssue` + `listClawsIssueRequirements`
 * reads for every issue on every tick.
 */
export async function loadApprovedRequirementsForOpenIssues(): Promise<Map<string, ApprovedRequirements>> {
  const rows = await db.listApprovedClawsIssueRequirementsForOpenIssues();
  const out = new Map<string, ApprovedRequirements>();
  for (const [trackerId, row] of rows) {
    out.set(trackerId, fromDbRow(row, row.approved_by, row.approved_at));
  }
  return out;
}

/**
 * Resolve one issue's approved record against a pre-fetched
 * {@link loadApprovedRequirementsForOpenIssues} batch — one `resolveTrackerId`
 * lookup instead of {@link loadApprovedRequirements}'s three reads. Same
 * "none" vs "error" distinction: a failed tracker-id resolution is reported
 * as `error`, never silently folded into "no record".
 */
export async function approvedRequirementsFromBatch(repo: string, ref: IssueRef, batch: Map<string, ApprovedRequirements>): Promise<ApprovedRequirementsResult> {
  try {
    const trackerId = await resolveTrackerId(repo, ref);
    if (!trackerId) return { status: "none" };
    const record = batch.get(trackerId);
    return record ? { status: "approved", record } : { status: "none" };
  } catch (err) {
    log.warn(`[approved-requirements] Could not resolve the tracker id for ${repo}#${ref}: ${err}`);
    return { status: "error" };
  }
}

/**
 * Unwrap a load result for a planner run that is about to stamp a plan's
 * content hash. Throws on `error` so the run aborts and the work item
 * retries, rather than stamping a body-only hash for an issue that actually
 * has a record — which would make the plan look freshly-verified until the
 * next tick's successful read marks it stale again (costing another full
 * planner run, and silently dropping a human's `Refined`).
 */
export function requireApprovedRequirements(result: ApprovedRequirementsResult, context: string): ApprovedRequirements | null {
  if (result.status === "error") {
    throw new Error(`Could not read the approved requirements for ${context} — aborting this run so it retries instead of stamping a body-only plan hash`);
  }
  return result.status === "approved" ? result.record : null;
}

/** Unwrap a load result where "unknown" and "no record" are both fine to treat as "plan from the body alone". */
export function approvedRequirementsOrNull(result: ApprovedRequirementsResult): ApprovedRequirements | null {
  return result.status === "approved" ? result.record : null;
}

/** The record fields the plan hash covers — see `issueContentHash`. */
export type RequirementsHashFields = Pick<IssueRequirementsVersion, "version" | "title" | "kind" | "context" | "requirement" | "acceptanceCriteria" | "outOfScope">;

/**
 * A deterministic serialisation of the record's content, appended to the plan
 * hash input so the hash changes exactly when the approved text (or version)
 * does.
 */
export function requirementsHashInput(record: RequirementsHashFields): string {
  return JSON.stringify([
    record.version,
    record.title,
    record.kind,
    record.context,
    record.requirement,
    record.acceptanceCriteria,
    record.outOfScope,
  ]);
}

/** The heading the reviewer's criteria section starts with. */
export const REVIEWER_CRITERIA_HEADING = "### Approved requirements";

/** Who a rendered section is written for; picks its instruction paragraph. */
export type RequirementsAudience = "planner" | "implementer" | "reviewer";

const AUDIENCE_INSTRUCTIONS: Record<RequirementsAudience, string> = {
  planner: [
    `This is the issue's approved requirements record: what the plan must satisfy. Plan against it,`,
    `not against the issue body below — the body is the original request, kept as background, and`,
    `where the two disagree the record wins. Do not restate the requirement in the plan.`,
  ].join("\n"),
  implementer: [
    `These are the issue's approved acceptance criteria. Before you finish, check the change against`,
    `every criterion. Your final summary must contain an \`## Acceptance criteria\` list naming each`,
    `criterion with how it was verified — or "not part of this PR's phase" when a multi-PR plan puts`,
    `it in another PR. Do not do work listed under "Out of scope".`,
  ].join("\n"),
  reviewer: [
    `The issue's approved acceptance criteria. Check the PR against every one and name each`,
    `in the review's \`## Acceptance criteria\` section. Items under "Out of scope" are not findings.`,
  ].join("\n"),
};

function numbered(items: readonly string[]): string {
  return items.length === 0 ? "_None._" : items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

function bullets(items: readonly string[]): string {
  return items.length === 0 ? "_None._" : items.map((item) => `- ${item}`).join("\n");
}

/**
 * The record as a markdown prompt section, its free-text fields passed through
 * `guardContent`. The record reads as Claws-authored, but for a `forge`,
 * `agent` or `automation` issue (see docs/issue-tracker.md's auto-promotion
 * list) the first version is approved unattended — `approvedBy: "claws"` — so
 * it is really an LLM paraphrase of an arbitrary forge author's issue body and
 * comments, and this PR makes it authoritative over the body. Guarding it here
 * closes the gap the body's own `guardContent` call would otherwise miss.
 */
export function approvedRequirementsSection(
  record: ApprovedRequirements | RequirementsHashFields,
  audience: RequirementsAudience,
  guardCtx: ReturnType<typeof makeGuardCtx>,
): string {
  const title = guardContent(record.title, guardCtx("requirements-title"));
  const context = guardContent(record.context, guardCtx("requirements-context"));
  const requirement = guardContent(record.requirement, guardCtx("requirements-requirement"));
  const acceptanceCriteria = record.acceptanceCriteria.map((c, i) => guardContent(c, guardCtx(`requirements-acceptance-criteria-${i}`)));
  const outOfScope = record.outOfScope.map((s, i) => guardContent(s, guardCtx(`requirements-out-of-scope-${i}`)));
  if (audience === "reviewer") {
    // Nested under the reviewer's "Originating Issue" section, hence `###`.
    return [
      `${REVIEWER_CRITERIA_HEADING} v${record.version} — acceptance criteria`,
      ``,
      AUDIENCE_INSTRUCTIONS.reviewer,
      ``,
      numbered(acceptanceCriteria),
      ``,
      `### Out of scope`,
      ``,
      bullets(outOfScope),
    ].join("\n");
  }
  const approvedAt = "approvedAt" in record && record.approvedAt ? `, approved ${record.approvedAt.slice(0, 10)}` : "";
  return [
    `## Approved requirements (v${record.version}${approvedAt})`,
    ``,
    AUDIENCE_INSTRUCTIONS[audience],
    ``,
    `**Title:** ${title}`,
    ``,
    `**Kind:** ${record.kind}`,
    ``,
    // Bold labels rather than `###` headings: a planner prompt must not show a
    // `### Requirement` heading the plan could copy.
    `**Context:**`,
    ``,
    context,
    ``,
    `**Requirement:**`,
    ``,
    requirement,
    ``,
    `### Acceptance criteria`,
    ``,
    numbered(acceptanceCriteria),
    ``,
    `### Out of scope`,
    ``,
    bullets(outOfScope),
  ].join("\n");
}
