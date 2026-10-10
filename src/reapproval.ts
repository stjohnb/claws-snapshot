/**
 * Design-change re-approval (docs/jobs/issue-dispatcher.md "Follow-up
 * response", docs/issue-tracker.md "Plans").
 *
 * A follow-up run on an issue with an open PR may find the feedback changes
 * the design — PRs added, removed, reordered or redirected, or the approved
 * requirements contradicted. {@link startReapproval} then stores the revised
 * requirements as a new, unapproved version, rewrites the plan comment in
 * place with a pending banner and marker, records the change in
 * `claws_issue_reapprovals`, removes `Refined`, and holds every open PR the
 * change would close or rework so none can merge. Nothing is closed or
 * reworked yet, and the implementer stays off the issue while the row is
 * pending.
 *
 * The operator approves by promoting the new requirements or applying
 * `Refined`; {@link approveReapproval} then approves the version, closes the
 * superseded PRs, swaps in the revised PR list, links kept PRs and points
 * reworked ones at their new step, renumbers every surviving `(N/M)` marker,
 * lifts the holds, strips the banner and re-applies `Refined` so the normal
 * implement flow resumes. Its approval time fences the old plan's PRs out of
 * marker coverage (`planned-prs.ts`).
 */

import { LABELS, type Repo } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import * as clawsIssues from "./claws-issues.js";
import type { CommentRef, IssueRef } from "./issue-id.js";
import { resolveTrackerId, type OpenPhasePR } from "./planned-prs.js";
import { retitlePhaseMarker } from "./phase-coverage.js";
import { holdForReapproval, releaseReapprovalHold } from "./pr-hold.js";
import { storeRequirementsVersion } from "./agents/requirements-writer.js";
import { editPlanInPlace, issueContentHash, renderPlanBody, PLAN_BODY_HASH_MARKER, PLAN_HEADER } from "./agents/issue-refiner.js";
import { PLAN_PENDING_REAPPROVAL_MARKER } from "./marker-text.js";
import type { FollowupVerdict, PlanSubmission, PRFate } from "./planner-runs.js";
import type { RequirementsHashFields } from "./approved-requirements.js";

/** `requirements_approved_by` for a design change approved by applying `Refined`. */
export const REFINED_APPROVER = "refined";

/** The first line of a plan pending re-approval. */
export function pendingBanner(version: number): string {
  return `> **Pending re-approval** — design change; requirements v${version} and this plan wait for you to promote or apply ${LABELS.refined}.`;
}

const BANNER_RE = /^> \*\*Pending re-approval\*\*[^\n]*\n+/m;
const PENDING_MARKER_RE = new RegExp(`^${PLAN_PENDING_REAPPROVAL_MARKER}\\s*v\\d+[ \\t]*\\n?`, "gm");

/** `#N` for a PR in the issue's repo, `owner/name#N` for one elsewhere. */
function prRef(issueRepo: string, pr: { repo: string; number: number }): string {
  return pr.repo.toLowerCase() === issueRepo.toLowerCase() ? `#${pr.number}` : `${pr.repo}#${pr.number}`;
}

export interface StartReapprovalContext {
  /** The plan comment the follow-up answered, edited in place. */
  planComment: gh.IssueComment;
  /** Highest comment id the run had seen — the plan's last-comment fence. */
  lastCommentId: CommentRef;
  /** The plan comment's attribution line. */
  attribution: string;
  /** The attribution a forge issue's `## Requirements` comment carries. */
  requirementsAttribution: string;
  /** The human comments the change answered. */
  sourceComments: readonly gh.IssueComment[];
}

/**
 * Hold a design change for the operator's re-approval — the eight steps of the
 * module doc, in order. `verdict` is the run's `design_change` verdict (its
 * requirements and PR fates), `plan` the revised plan it saved, `prs` the open
 * step PRs the run was shown. A second design change before approval replaces
 * the pending one, releasing the holds it no longer needs.
 *
 * Returns the comment that names each open PR, its fate and its new step. The
 * caller posts it with its reply, so the issue gets one comment, not two.
 */
export async function startReapproval(
  repo: Repo,
  issue: gh.Issue,
  verdict: FollowupVerdict,
  plan: PlanSubmission,
  prs: readonly OpenPhasePR[],
  ctx: StartReapprovalContext,
): Promise<string> {
  const fullName = repo.fullName;
  const record = verdict.requirements;
  if (verdict.verdict !== "design_change" || !record) throw new Error("startReapproval needs a design_change verdict with its requirements");
  const fates = verdict.prFates ?? [];
  const issueLabel = `${fullName}#${issue.number}`;

  // 0. Out of Approved until the operator decides — first, so a failure leaves
  // nothing written, and before any row exists so the old approval's label can
  // never read as the operator's decision.
  if (!(await gh.removeLabel(fullName, issue.number, LABELS.refined))) throw new Error(`could not remove ${LABELS.refined} from ${issueLabel}`);

  // 1. The revised record, stored unapproved (and posted on a forge issue).
  const create = { title: issue.title, body: issue.body ?? "", authorLogin: issue.author?.login ?? "claws", labels: issue.labels.map((l) => l.name) };
  const existingTracker = await resolveTrackerId(fullName, issue.number);
  const latest = existingTracker ? (await clawsIssues.listRequirements(existingTracker)).at(-1) : undefined;
  const { trackerId, version } = await storeRequirementsVersion(fullName, issue.number, record, ctx.requirementsAttribution, {
    latestCommentId: latest?.commentId ?? null,
    create,
  });

  // 2. The re-approval row as soon as the version exists, replacing any earlier
  // pending change — so a failure past here still gates the implementer.
  const previous = await db.getIssueReapproval(trackerId);
  await db.upsertIssueReapproval({
    issueId: trackerId,
    requirementsVersion: version,
    planCommentId: String(ctx.planComment.id),
    prs: plan.prs.map((p) => ({ repo: p.repo, title: p.title, dependsOn: p.dependsOn, kind: p.kind, manualAction: p.manualAction })),
    fates,
    sourceCommentIds: ctx.sourceComments.map((c) => String(c.id)),
  });

  // 3. The plan, edited in place with the banner and marker, its hash
  // stamped with the pending version — the record it will be approved as.
  const pendingRecord: RequirementsHashFields = { version, ...record };
  await editPlanInPlace({
    fullName, issue, planComment: ctx.planComment, planBody: renderPlanBody(plan),
    attribution: ctx.attribution, requirements: pendingRecord, lastCommentId: ctx.lastCommentId,
    prs: null, pendingReapproval: { version, banner: pendingBanner(version) },
  });

  // 6. Hold every open PR the change would close or rework.
  const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const isOpen = (f: PRFate) => prs.some((p) => sameRepo(p.repo, f.repo) && p.number === f.number);
  const held = fates.filter((f) => f.fate !== "keep" && isOpen(f));
  for (const f of held) {
    const what = f.fate === "close" ? "close this PR" : `rework this PR into step ${f.position} of ${plan.prs.length}`;
    try {
      await holdForReapproval(f.repo, f.number, `a design change on ${issueLabel} would ${what} — waiting for the operator to promote requirements v${version} or apply ${LABELS.refined}`, issueLabel);
    } catch (err) {
      log.warn(`[reapproval] Could not hold ${f.repo}#${f.number} for ${issueLabel}: ${err}`);
    }
  }

  // 7. Release what the replaced change held that this one does not.
  if (previous && previous.approvedAt === null) {
    for (const f of previous.fates) {
      if (f.fate === "keep" || held.some((h) => h.repo === f.repo && h.number === f.number)) continue;
      try {
        await releaseReapprovalHold(f.repo, f.number);
      } catch (err) {
        log.warn(`[reapproval] Could not release ${f.repo}#${f.number} for ${issueLabel}: ${err}`);
      }
    }
  }

  log.info(`[reapproval] ${issueLabel}: design change pending re-approval (requirements v${version}, ${plan.prs.length}-step plan, ${held.length} PR(s) held)`);

  // 8. The comment naming each open PR, its fate and its new step.
  const stepTitle = (position: number | null) => (position === null ? "" : `: ${plan.prs[position - 1]?.title ?? ""}`);
  const lines = prs.map((pr) => {
    const f = fates.find((x) => sameRepo(x.repo, pr.repo) && x.number === pr.number);
    const ref = prRef(fullName, pr);
    if (!f) return `- ${ref} — no fate given; left as it is`;
    if (f.fate === "close") return `- ${ref} — **held**; closed on approval`;
    if (f.fate === "rework") return `- ${ref} — **held**; reworked on approval into step ${f.position} of ${plan.prs.length}${stepTitle(f.position)}`;
    return `- ${ref} — kept as step ${f.position} of ${plan.prs.length}${stepTitle(f.position)}`;
  });
  for (const f of fates) {
    if (f.fate === "keep" && !isOpen(f)) lines.push(`- ${prRef(fullName, f)} (merged) — kept as step ${f.position} of ${plan.prs.length}${stepTitle(f.position)}`);
  }
  return [
    `**Design change — waiting for your re-approval.** Requirements v${version} and the revised plan above replace the approved ones once you promote the requirements or apply \`${LABELS.refined}\`. Nothing is closed or reworked until then, and Claws implements nothing new.`,
    ...(lines.length > 0 ? [``, `Open PRs:`, ``, ...lines] : []),
  ].join("\n");
}

/** Where a tracker issue lives on its forge, or on the native tracker. */
async function issueLocation(trackerId: string): Promise<{ repo: string; ref: IssueRef; record: db.ClawsIssueRecord } | null> {
  const record = await db.getClawsIssue(trackerId);
  if (!record) return null;
  if (record.kind === "shadow") {
    const link = await db.getImportedIssueByNative(trackerId);
    return link ? { repo: link.repo, ref: link.forgeNumber, record } : null;
  }
  return { repo: clawsIssues.primaryRepo(record.repos), ref: trackerId, record };
}

const approvals = new Map<string, Promise<boolean>>();

/**
 * Approve the issue's pending design change as `approvedBy` — the ten steps of
 * the module doc. Idempotent: a call with nothing pending returns false, and
 * concurrent calls for one issue share a single run; every step re-checks
 * what it changes, so a run cut short is finished by the next. Returns true
 * when this call approved it.
 */
export async function approveReapproval(trackerId: string, approvedBy: string): Promise<boolean> {
  const running = approvals.get(trackerId);
  if (running) return await running;
  const run = runApproval(trackerId, approvedBy).finally(() => approvals.delete(trackerId));
  approvals.set(trackerId, run);
  return await run;
}

async function runApproval(trackerId: string, approvedBy: string): Promise<boolean> {
  const row = await db.getIssueReapproval(trackerId);
  if (!row || row.approvedAt !== null) return false;
  const where = await issueLocation(trackerId);
  if (!where) {
    log.warn(`[reapproval] ${trackerId}: no issue to approve the design change on`);
    return false;
  }
  const { repo, ref, record } = where;
  const issueLabel = `${repo}#${ref}`;
  const total = row.prs.length;
  const notes: string[] = [];

  // 1. The pending requirements version.
  if (record.approved_requirements_version == null || Number(record.approved_requirements_version) < row.requirementsVersion) {
    await db.approveClawsIssueRequirements(trackerId, row.requirementsVersion, approvedBy);
  }

  const stateOf = async (f: PRFate): Promise<string> => {
    try {
      return ((await gh.getPRState(f.repo, f.number)) ?? "UNKNOWN").toUpperCase();
    } catch (err) {
      log.warn(`[reapproval] Could not read ${f.repo}#${f.number} for ${issueLabel}: ${err}`);
      return "UNKNOWN";
    }
  };
  const states = new Map<string, string>();
  for (const f of row.fates) states.set(`${f.repo}#${f.number}`, await stateOf(f));
  const state = (f: PRFate) => states.get(`${f.repo}#${f.number}`) ?? "UNKNOWN";

  // 2. Close what the change supersedes — never one that already merged.
  for (const f of row.fates.filter((x) => x.fate === "close")) {
    const s = state(f);
    if (s === "MERGED") {
      notes.push(`- ${prRef(repo, f)} — ⚠️ merged before the approval, so it was not closed; check whether its change must be reverted`);
      continue;
    }
    if (s !== "OPEN") {
      notes.push(`- ${prRef(repo, f)} — no longer open; skipped`);
      continue;
    }
    try {
      await gh.commentOnIssue(f.repo, f.number, `Closing: the design change on ${issueLabel} was approved, and the revised plan no longer needs this PR.`, { agentName: "Planner" });
      await gh.closePR(f.repo, f.number);
      notes.push(`- ${prRef(repo, f)} — closed`);
    } catch (err) {
      log.warn(`[reapproval] Could not close ${f.repo}#${f.number} for ${issueLabel}: ${err}`);
      notes.push(`- ${prRef(repo, f)} — could not be closed (${err instanceof Error ? err.message : String(err)}); close it by hand`);
    }
  }

  // 3–5. The revised PR list: no old link survives unless a keep names it,
  // and a reworked PR becomes its step's target, unlinked until pushed onto.
  await db.replaceIssuePlannedPRs(trackerId, row.prs);
  const keeps = row.fates.filter((f) => f.fate === "keep" && f.position !== null && (state(f) === "OPEN" || state(f) === "MERGED"));
  const reworks = row.fates.filter((f) => f.fate === "rework" && f.position !== null && state(f) === "OPEN");
  for (const entry of await db.getIssuePlannedPRs(trackerId)) {
    const keep = keeps.find((f) => f.position === entry.position);
    if (keep) {
      if (entry.prNumber !== keep.number) await db.linkIssuePlannedPR(trackerId, entry.position, keep.number);
    } else if (entry.prNumber !== null) {
      await db.unlinkIssuePlannedPR(trackerId, entry.position);
    }
    const rework = reworks.find((f) => f.position === entry.position);
    if ((entry.targetPrNumber ?? null) !== (rework?.number ?? null)) {
      await db.setIssuePlannedPRTarget(trackerId, entry.position, rework?.number ?? null);
    }
  }

  // 6. Renumber every surviving open PR's marker to its new step.
  const openPRs = new Map<string, Promise<gh.PR[]>>();
  for (const f of [...keeps, ...reworks]) {
    const label = f.fate === "keep" ? `kept as step ${f.position} of ${total}` : `reworked into step ${f.position} of ${total}; Claws pushes that step onto its branch`;
    if (state(f) === "OPEN") {
      try {
        const key = f.repo.toLowerCase();
        if (!openPRs.has(key)) openPRs.set(key, gh.listPRs(f.repo));
        const title = (await openPRs.get(key)!).find((p) => p.number === f.number)?.title;
        const body = await gh.getPRBody(f.repo, f.number);
        const next = title !== undefined ? retitlePhaseMarker(title, body, f.position!, total) : null;
        if (next) await gh.updatePR(f.repo, f.number, next.body, next.title !== title ? next.title : undefined);
      } catch (err) {
        log.warn(`[reapproval] Could not renumber ${f.repo}#${f.number} for ${issueLabel}: ${err}`);
      }
    }
    notes.push(`- ${prRef(repo, f)} — ${label}`);
  }
  for (const f of row.fates.filter((x) => x.fate !== "close" && !keeps.includes(x) && !reworks.includes(x))) {
    notes.push(`- ${prRef(repo, f)} — no longer open; skipped`);
  }

  // 7. Kept PRs may merge again; a reworked one stays held until the
  // implementer has pushed its new step.
  for (const f of keeps) {
    try {
      await releaseReapprovalHold(f.repo, f.number);
    } catch (err) {
      log.warn(`[reapproval] Could not release ${f.repo}#${f.number} for ${issueLabel}: ${err}`);
    }
  }

  // 8. The plan is current: no banner, no pending marker, and its hash
  // re-stamped against the approved record and the issue as it reads now —
  // a promotion may have retitled it. A failure leaves the row pending, so the
  // next settle retries.
  await finishPlanComment(repo, ref, row, trackerId);

  // 9. Resume the implement flow before the row is marked approved, so a
  // failed write is retried rather than stranding the issue without `Refined`.
  if (record.state === "open") await gh.addLabel(repo, ref, LABELS.refined);

  // 10. Approved; then say what happened (best effort).
  await db.markIssueReapprovalApproved(trackerId, approvedBy);
  log.info(`[reapproval] ${issueLabel}: design change approved by ${approvedBy} (requirements v${row.requirementsVersion})`);
  try {
    await gh.commentOnIssue(repo, ref, [
      `**Design change approved** by ${approvedBy}: requirements v${row.requirementsVersion} and the revised ${total}-step plan are now current.`,
      ...(notes.length > 0 ? [``, ...notes] : []),
      ``,
      `Implementation resumes on the revised plan.`,
    ].join("\n"), { agentName: "Planner" });
  } catch (err) {
    log.warn(`[reapproval] Could not post the approval summary on ${issueLabel}: ${err}`);
  }
  return true;
}

/** Strip the banner and pending marker from the plan comment and re-stamp its hash. */
async function finishPlanComment(repo: string, ref: IssueRef, row: db.IssueReapproval, trackerId: string): Promise<void> {
  {
    const comments = await gh.getIssueComments(repo, ref);
    const plan = comments.find((c) => String(c.id) === row.planCommentId)
      ?? comments.findLast((c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body));
    if (!plan) return;
    const approved = (await clawsIssues.listRequirements(trackerId)).find((v) => v.version === row.requirementsVersion);
    const live = await gh.getIssueTitleBody(repo, ref);
    const hash = issueContentHash(live.title, live.body, approved ?? null);
    const hashRe = new RegExp(`${PLAN_BODY_HASH_MARKER}\\s*[0-9a-f]{64}`, "g");
    const body = plan.body
      .replace(BANNER_RE, "")
      .replace(PENDING_MARKER_RE, "")
      .replace(hashRe, `${PLAN_BODY_HASH_MARKER} ${hash}`)
      .trimEnd();
    if (body !== plan.body) await gh.editIssueComment(repo, plan.id, body, { agentName: "Planner" });
  }
}

/**
 * Promote an issue whose design change is pending: approve its latest
 * requirements version as `approvedBy` from whatever lifecycle it is in — the
 * compare-and-swap uses the lifecycle read here — then approve the change.
 * Shared by the Promote button, `claws_promote_issue` and a board drop into
 * Planning. False when the promotion lost a race.
 */
export async function promoteReapproval(trackerId: string, approvedBy: string): Promise<boolean> {
  const record = await db.getClawsIssue(trackerId);
  if (!record) return false;
  if (!(await clawsIssues.promoteIssue(trackerId, approvedBy, record.lifecycle))) return false;
  await approveReapproval(trackerId, approvedBy);
  return true;
}

/** True when the tracker issue has a design change pending re-approval. */
export async function hasPendingReapproval(trackerId: string): Promise<boolean> {
  const row = await db.getIssueReapproval(trackerId);
  return !!row && row.approvedAt === null;
}

/**
 * Whether `repo#ref` has a design change pending re-approval. A failed read is
 * logged and answered true: the implementer waits a tick rather than building
 * a plan the operator has not approved.
 */
export async function isReapprovalPending(repo: string, ref: IssueRef): Promise<boolean> {
  try {
    const trackerId = await resolveTrackerId(repo, ref);
    return trackerId ? await hasPendingReapproval(trackerId) : false;
  } catch (err) {
    log.warn(`[reapproval] Could not read the re-approval state of ${repo}#${ref} — treating it as pending: ${err}`);
    return true;
  }
}

/** Re-read the issue's live labels; a failed read counts as not applied. */
async function refinedIsLive(trackerId: string): Promise<boolean> {
  try {
    const where = await issueLocation(trackerId);
    if (!where) return false;
    return (await gh.getLiveLabels(where.repo, where.ref)).includes(LABELS.refined);
  } catch (err) {
    log.warn(`[reapproval] Could not re-read the labels of ${trackerId}: ${err}`);
    return false;
  }
}

/**
 * The dispatcher's level-triggered approval check for an issue whose design
 * change is pending: approve it when the issue carries `Refined` (recorded as
 * {@link REFINED_APPROVER}) or its approved requirements version has reached
 * the pending one — a promotion whose own approval call did not finish.
 * Returns whether the change is still pending afterwards.
 */
export async function settlePendingReapproval(trackerId: string, labels: readonly string[]): Promise<boolean> {
  const row = await db.getIssueReapproval(trackerId);
  if (!row || row.approvedAt !== null) return false;
  // The caller's snapshot may predate the row: the change removes `Refined`
  // before writing it, so a `Refined` read after the row is the operator's.
  if (labels.includes(LABELS.refined) && (await refinedIsLive(trackerId))) {
    await approveReapproval(trackerId, REFINED_APPROVER);
  } else {
    const record = await db.getClawsIssue(trackerId);
    const approved = record?.approved_requirements_version;
    if (approved != null && Number(approved) >= row.requirementsVersion) {
      await approveReapproval(trackerId, record?.requirements_approved_by ?? REFINED_APPROVER);
    }
  }
  return await hasPendingReapproval(trackerId);
}
