/** Approval-track reads and checked approval writes the dashboard routes share, plus board and issue-list plan previews, the queue capacity view and the run-control failure answer. */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { WorkerStatus } from "../controller-client.js";
import * as config from "../config.js";
import { isNativeIssue } from "../github.js";
import { getIssueState } from "../github.js";
import * as planParser from "../plan-parser.js";
import { issuesAwaitingOperator } from "../awaiting-operator.js";
import { resolveTrackerId } from "../planned-prs.js";
import { ForgejoRunControlEndpointUnavailableError } from "../forgejo.js";
import { listIssueInfraDeclarations } from "../db.js";
import * as log from "../log.js";
import type { QueueCapacityView } from "../pages/dashboard.js";
import type { PlanPreview } from "../pages/issue.js";
import { ideaExcerpt, type IdeaPreview } from "../pages/board.js";
import { hasPendingReapproval } from "../reapproval.js";
import { applyIssueApproval } from "../issue-approval-write.js";
import { approvalRank, atLeast, type ApprovedThrough } from "../issue-approval.js";
import { deriveApprovalTrack, type ApprovalTrackInput } from "../pages/approval-track.js";
import { columnFor } from "../issue-board.js";
import { flightKey, loadIssueFlight } from "../issue-flight.js";
import { loadOpenIssueStages } from "../issue-stage.js";
import * as clawsIssues from "../claws-issues.js";
import { issuesOverlapHeld, issuesQueued } from "../queued-issues.js";
import { canonicalIssueRef, isClawsIssueId } from "../issue-id.js";
import { renderMarkdown } from "../markdown.js";
import { RunControlRequestError } from "../forgejo-run-control.js";
import type { ClawsIssuePlanRow, ClawsIssueRecord, ClawsIssueRequirementsRow } from "../db.js";
import { destroyConsentView } from "../destroy-consent.js";
import { type Env, jsonOk } from "./http.js";
import { isConfiguredRepo } from "./shared.js";
import { issueHasPlan, promoteNative } from "./issue-actions.js";

/** The Agent Queue's Capacity line: the published capacity snapshot means the controller runs `k8s-pod`. */
export function queueCapacityView(ws: WorkerStatus): QueueCapacityView {
  return { backend: ws.capacity ? "k8s-pod" : config.WORK_BACKEND, workers: ws.workers, snapshot: ws.capacity };
}

/**
 * The approval track's "Stops at" line for each of `records` (open native
 * issues), keyed by id — `GET /api/issues`' batched counterpart of
 * `loadApprovalTrackInput`, derived from the same batched reads as the
 * rows' `stage` (`loadOpenIssueStages`), so the two agree. A row with no
 * stage has no line.
 */
export function stopsAtForOpenIssues(
  records: readonly ClawsIssueRecord[],
  reads: Awaited<ReturnType<typeof loadOpenIssueStages>>,
  plans: { has(id: string): boolean },
): Map<string, string> {
  const { stages, flights, awaitingOperator, reapprovals, overlapHeld } = reads;
  const lines = new Map<string, string>();
  for (const r of records) {
    const column = stages.get(r.id)?.stage;
    if (!column) continue;
    const repo = clawsIssues.primaryRepo(r);
    lines.set(r.id, deriveApprovalTrack({
      repo,
      ref: r.id,
      column,
      labels: r.labels,
      lifecycle: r.lifecycle,
      approvedThrough: r.approved_through ?? "none",
      requirementsApproved: r.requirements_approved_at != null,
      hasPlan: plans.has(r.id),
      reapprovalPending: reapprovals.has(r.id),
      awaitingOperator: awaitingOperator.has(r.id),
      openPrs: flights.get(flightKey(repo, r.id))?.openPrs,
      overlapHold: overlapHeld.get(r.id) ?? null,
    }).stopsAt);
  }
  return lines;
}

/** The answer for a run-control failure: a refused request keeps its status, an old image is 502. */
export function runControlFailure(c: Context<Env>, err: unknown): Response {
  if (err instanceof RunControlRequestError) return jsonOk(c, { error: err.message }, err.status);
  if (err instanceof ForgejoRunControlEndpointUnavailableError) return jsonOk(c, { error: err.message }, 502);
  return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 502);
}

/**
 * The latest plan of every open native issue, for the collapsed plan block
 * on board cards and `/issues` rows. Best-effort: a failed read costs the
 * plan blocks, not the page.
 */
export async function loadLatestPlans(page: string): Promise<Map<string, ClawsIssuePlanRow>> {
  return await clawsIssues.getLatestPlansForOpenIssues().catch((err) => {
    log.warn(`[${page}] plans: ${err}`);
    return new Map<string, ClawsIssuePlanRow>();
  });
}

/**
 * The plan block for `ref`, or undefined for a forge issue or a native one
 * with no plan yet. Only the Requirement section (else the first) is
 * rendered, to keep a board of ~100 cards small.
 */
export function planPreviewFor(ref: config.IssueRef, plans: Map<string, ClawsIssuePlanRow>): PlanPreview | undefined {
  if (!isNativeIssue(ref)) return undefined;
  const row = plans.get(String(canonicalIssueRef(ref)));
  if (!row) return undefined;
  const sections = planParser.parsePlanSections(row.body);
  if (sections.length === 0) return undefined;
  const requirement = sections.find((s) => planParser.isWhatChangesTitle(s.title)) ?? sections.find((s) => s.title.toLowerCase() === "requirement") ?? sections[0];
  return {
    summary: `${sections.length} section${sections.length === 1 ? "" : "s"}`,
    requirementHtml: renderMarkdown(requirement.markdown),
    url: `/issues/${encodeURIComponent(row.issue_id)}#plan`,
  };
}

/**
 * The idea block for a board card: the latest requirements version's
 * Requirement part when there is one, else the start of the issue body. The
 * board renders it only on a card in Drafting or Requirements review.
 */
export function ideaPreviewFor(row: ClawsIssueRequirementsRow | undefined, body: string, url: string): IdeaPreview {
  if (row) {
    return {
      summary: `Requirements v${row.version} · ${row.kind} — ${row.title}`,
      html: renderMarkdown(row.requirement),
      url,
    };
  }
  return { summary: "Idea", html: renderMarkdown(ideaExcerpt(body)), url };
}

/**
 * The approval track's input for one issue, read live — its labels, flight,
 * lifecycle, stored approval (a native record's, or a forge issue's shadow's)
 * and requirements state — with the column `columnFor` derives
 * from them, so `POST /board/approve-through` checks a click against the
 * track as it stands and answers with the track after its writes. `repo` is
 * the issue's primary repository. Null for a native id the store has never
 * heard of. A forge issue with no tracker record yet reads as awaiting
 * import, which leaves every gate read-only.
 */
export async function loadApprovalTrackInput(repo: string, ref: config.IssueRef): Promise<(ApprovalTrackInput & { repos: string[] | null }) | null> {
  const native = isClawsIssueId(ref);
  const record = native ? await clawsIssues.getIssue(ref) : undefined;
  if (native && !record) return null;
  const owner = (record && clawsIssues.primaryRepo(record)) || repo;
  const trackerId = record?.id ?? await resolveTrackerId(owner, ref);
  const tracked = record ?? (trackerId ? await clawsIssues.getIssue(trackerId) : undefined);
  const [{ state, labels }, flight, hasPlan] = await Promise.all([
    getIssueState(owner, ref),
    loadIssueFlight(owner, ref),
    issueHasPlan(owner, ref, native),
  ]);
  const lifecycle = tracked?.lifecycle;
  const [requirementsReview, hasRequirements, reapprovalPending, awaitingOperator, queued] = await Promise.all([
    (lifecycle ?? "ideas") === "ideas" ? clawsIssues.isAwaitingRequirementsReview(trackerId) : Promise.resolve(false),
    trackerId ? clawsIssues.listRequirements(trackerId).then((v) => v.length > 0) : Promise.resolve(false),
    trackerId ? hasPendingReapproval(trackerId) : Promise.resolve(false),
    trackerId ? issuesAwaitingOperator([trackerId]).then((m) => m.has(trackerId)) : Promise.resolve(false),
    trackerId ? issuesQueued([trackerId]).then((m) => m.has(trackerId)) : Promise.resolve(false),
  ]);
  // Every ready step held for file overlap (overlap-gate.ts); best-effort inside `issuesOverlapHeld`.
  const overlapHold = tracked && tracked.kind === "issue" ? (await issuesOverlapHeld([tracked])).get(tracked.id) ?? null : null;
  const awaitingImport = !native && !trackerId;
  const approvedThrough: ApprovedThrough = tracked?.approved_through ?? "none";
  const column = columnFor({
    labels,
    closed: state === "CLOSED",
    unassigned: !!record && record.repos.length === 0,
    lifecycle,
    approvedThrough,
    requirementsReview,
    ...flight,
    awaitingOperator,
    reapprovalPending,
    awaitingImport,
    queued,
    overlapHeld: overlapHold !== null,
  });
  return {
    repo: owner,
    ref,
    column,
    overlapHold,
    labels,
    lifecycle,
    approvedThrough,
    requirementsApproved: tracked?.requirements_approved_at != null,
    hasRequirements,
    hasPlan,
    reapprovalPending,
    awaitingOperator,
    awaitingImport,
    openPrs: flight.openPrs,
    destroyConsent: trackerId ? await loadDestroyConsentView(trackerId, approvedThrough) : undefined,
    repos: record ? record.repos : null,
  };
}

/**
 * Write issue `repo#ref`'s approval as `by`, checked against the approval
 * track derived from its live state as a gate click is — the one guard for
 * every surface that writes an approval outside the board's own gate
 * route (the session `approval` route, `/queue/mark-refined`,
 * `/queue/mark-automerge`, `/board/automerge`), since
 * `applyIssueApproval` checks nothing. `target` maps the current approval
 * to the one to store. Raising needs the target gate to offer `approve` —
 * so an issue in Drafting, with no requirements, cannot be approved past
 * them — and lowering from Merge to Plan needs the Merge gate's
 * `withdraw`; lowering to Requirements is always allowed. An unchanged
 * value writes nothing, except Merge restated while an open PR row lacks
 * its merge approval, which `applyIssueApproval` writes onto it. A native
 * issue promotes as the dashboard's own. A native issue is written through
 * its primary repo, so `repo` must be one of its repos and the primary one
 * managed, as `/board/approve-through` checks (403 otherwise).
 */
export async function checkedApproval(
  repo: string,
  ref: config.IssueRef,
  target: (current: ApprovedThrough) => ApprovedThrough,
  by: string,
): Promise<{ ok: true; through: ApprovedThrough; openPrs: number } | { ok: false; status: ContentfulStatusCode; error: string }> {
  let before: Awaited<ReturnType<typeof loadApprovalTrackInput>>;
  try {
    before = await loadApprovalTrackInput(repo, ref);
  } catch (err) {
    log.warn(`[approval] approval state of ${repo}#${ref}: ${err}`);
    return { ok: false, status: 503, error: "Could not read the issue's current state — try again." };
  }
  if (!before) return { ok: false, status: 404, error: "Issue not found" };
  if (before.repos && !before.repos.includes(repo)) return { ok: false, status: 403, error: "Repository not configured" };
  if (before.repo !== repo && !(await isConfiguredRepo(before.repo))) return { ok: false, status: 403, error: "Repository not configured" };
  const current = before.approvedThrough ?? "none";
  const through = target(current);
  const record = isClawsIssueId(ref) ? await clawsIssues.getIssue(ref) : undefined;
  const promote = record ? { promote: () => promoteNative(record, record.id, by) } : {};
  if (through === current) {
    // Merge restated: approve any open PR row left without it (a refused
    // single-PR approval, say), so the gate does not read approved while one waits.
    if (through === "merge" && (before.openPrs ?? []).some((pr) => !pr.mergeApprovedAt)) {
      const result = await applyIssueApproval(before.repo, ref, through, by, promote);
      if (!result.ok) return { ok: false, status: result.status as ContentfulStatusCode, error: result.error };
      return { ok: true, through, openPrs: result.openPrs };
    }
    return { ok: true, through, openPrs: before.openPrs?.length ?? 0 };
  }
  const track = deriveApprovalTrack(before);
  const raising = approvalRank(through) > approvalRank(current);
  // Raising to Requirements past a Reqs gate the column already fills
  // records what the issue has; nothing to refuse.
  const view = raising
    ? track.gates.find((g) => g.gate === through)
    : through === "plan" ? track.gates.find((g) => g.gate === "merge") : undefined;
  const offered = !view || view.action === (raising ? "approve" : "withdraw")
    || (raising && through === "requirements" && view.state === "approved");
  if (!offered) {
    return { ok: false, status: 409, error: `${view!.label} cannot be ${raising ? "approved" : "withdrawn"} here: ${view!.title}` };
  }
  const result = await applyIssueApproval(before.repo, ref, through, by, promote);
  if (!result.ok) return { ok: false, status: result.status as ContentfulStatusCode, error: result.error };
  return { ok: true, through, openPrs: result.openPrs };
}

/**
 * The approval track's `.destroy-consent` view for one tracker id
 * (`src/destroy-consent.ts`), or undefined when its plan declares no destroy.
 * Best-effort: a failed read shows no block.
 */
export async function loadDestroyConsentView(trackerId: string, approvedThrough: ApprovedThrough) {
  try {
    const declared = (await listIssueInfraDeclarations([trackerId])).get(trackerId);
    return declared ? destroyConsentView(declared.entries, atLeast(approvedThrough, "plan"), declared.destroyConsent) : undefined;
  } catch (err) {
    log.warn(`[server] could not read the destroy consent of issue ${trackerId}: ${err}`);
    return undefined;
  }
}
