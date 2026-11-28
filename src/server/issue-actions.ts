/** Native issue writes the dashboard routes share: loading and 404ing a native issue, lifecycle and column moves, board moves, unblocking, promotion, operator-step completion and plan feedback. */
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as worker from "../worker.js";
import { AGENT_KINDS } from "../worker.js";
import { isAgentDisabled } from "../config.js";
import * as config from "../config.js";
import { addLabel, removeLabel, isNativeIssue, hasPriorityLabel } from "../github.js";
import { LABELS } from "../config.js";
import { getIssueComments, closeIssue, getIssueState, type IssueState } from "../github.js";
import * as planParser from "../plan-parser.js";
import { isPhaseClaimOnly } from "../phase-coverage.js";
import { loadIssuePhaseState, resolveTrackerId } from "../planned-prs.js";
import { getIssueBlockedReasons, setIssueBlockedReason, setClawsIssueBacklogUntil } from "../db.js";
import * as log from "../log.js";
import { parseBacklogUntil } from "../backlog-until.js";
import { hasPendingReapproval, promoteReapproval } from "../reapproval.js";
import { applyIssueApproval } from "../issue-approval-write.js";
import { atLeast, type ApprovedThrough } from "../issue-approval.js";
import { approvalForMove, backlogRefusal, BACKLOG_DESTINATION, BLOCKED_REASON_REQUIRED, columnAfterMove, columnFor, DERIVED_COLUMN_REJECTION, destinationForLifecycle, FORGE_REOPEN_REJECTION, isBoardDestination, isDerivedColumn, isRequirementsColumn, landsIn, planRefusal, transitionFor, UNASSIGNED_REJECTION, type BoardDestination } from "../issue-board.js";
import { loadIssueFlight } from "../issue-flight.js";
import { isIssueLifecycle, type IssueLifecycle } from "../issue-lifecycle.js";
import * as clawsIssues from "../claws-issues.js";
import { canonicalIssueRef, isClawsIssueId } from "../issue-id.js";
import { AWAITING_OPERATOR_MARKER } from "../blocked-reason.js";
import { mapSettledWithConcurrency } from "../util.js";
import { attachmentUrl, isInlineImage } from "../issue-attachments.js";
import type { ClawsIssueAttachmentRow } from "../db.js";
import { type Ctx, htmlError } from "./http.js";
import { type GateWriteResult, type NativeIssueRecord, isConfiguredRepo, orphanedRejection, orphanedRepos, sessionApprover } from "./shared.js";
import { postSessionAudit } from "./session-actions.js";

/**
 * Move a native issue to `target` — the one write behind a board move, a
 * backlog Promote and the issue page's Status buttons. Any move into
 * Planning with no recorded approval yet is the promotion, recording
 * `approvedBy` as the approver of the latest requirements version —
 * decided on approval state rather than on the column the issue came from,
 * so a drag through Blocked or Approved on the way to Planning still
 * records one; any move into `ideas` (Drafting or Requirements review) is the demotion, which clears the
 * approval and skips a queued planner run. An *entry* move (`isEntry`, the
 * backlog Promote or a dependency release) is the one exception, whatever
 * its target: it restores the issue to a column it already earned —
 * Planning because it has a plan or approved requirements, Drafting or Requirements review because
 * it has neither — not because anyone is approving or demoting anything
 * now, so it is always a plain lifecycle write. Everything else is a
 * plain lifecycle write too.
 *
 * A promotion approves the *latest* requirements version, so this can rename
 * the issue even on a re-plan drag back into Planning — not only on the
 * first promotion out of Drafting or Requirements review — when that version's title differs from the
 * issue's; `promoteClawsIssue` keeps the title it was filed under in
 * `filed_title`. That is intentional: the latest version is the one the
 * approval is actually for.
 *
 * `promoteIssue`'s write is a compare-and-swap on `record.lifecycle`, so it
 * throws when the issue changed lifecycle since the caller read it —
 * `applyBoardMove`'s catch turns that into a 500 with `partial: true`
 * rather than answering 200 for a move that did not happen.
 */
export async function moveNativeLifecycle(
  owner: string,
  record: NonNullable<Awaited<ReturnType<typeof clawsIssues.getIssue>>>,
  target: IssueLifecycle,
  approvedBy: string | undefined,
  isEntry: boolean,
  reason?: string,
): Promise<void> {
  if (target === "blocked") {
    // Throws `BlockedReasonRequiredError` for a blank reason, before any write.
    await clawsIssues.blockIssue(owner, record.id, reason ?? "");
  } else if (isEntry) {
    await clawsIssues.setLifecycle(owner, record.id, target);
  } else if (target === "planning" && record.requirements_approved_at == null) {
    const promoted = await clawsIssues.promoteIssue(record.id, approvedBy ?? clawsIssues.CLAWS_NATIVE_LOGIN, record.lifecycle);
    if (!promoted) throw new Error(`${record.id} changed lifecycle since it was read — try the move again`);
  } else if (target === "ideas") {
    await clawsIssues.demoteIssue(record.id);
  } else {
    await clawsIssues.setLifecycle(owner, record.id, target);
  }
}

/**
 * Whether the issue has a plan — the input to the board's plan rule
 * (`planRefusal`, docs/refinements/issue-flow.md "The board"). A native
 * issue has one when it has a stored plan version; a forge issue when its
 * live comments hold a Claws plan comment. The forge read is a live API call
 * and can throw; the caller answers that as "nothing changed".
 */
export async function issueHasPlan(owner: string, ref: config.IssueRef, native: boolean): Promise<boolean> {
  if (native) return (await clawsIssues.listPlans(String(ref))).length > 0;
  return planParser.findPlanComment(await getIssueComments(owner, ref)) !== null;
}

/**
 * A move into Planning for an issue that already has a plan is a re-plan:
 * queue the planner to revise the posted plan against the current issue and
 * requirements. `processRefinement` sets `awaiting-plan-review` when it posts,
 * so the issue returns to plan review on its own; the plan it replaced stays
 * as a previous version. Without this the dispatcher sees an unchanged plan
 * with no feedback and the card sits in Planning with nothing running.
 * Best-effort: the move has already landed, so a failed enqueue is logged.
 */
export async function replanAfterPlanningMove(owner: string, ref: config.IssueRef, labels: readonly string[]): Promise<void> {
  if (isAgentDisabled("planner")) return;
  const where = owner ? `${owner}#${ref}` : `#${ref}`;
  try {
    await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, owner, ref, {
      priority: hasPriorityLabel(labels.map((name) => ({ name }))),
    });
    log.info(`[board] ${where}: moved to Planning with a plan — queued a re-plan`);
  } catch (err) {
    log.warn(`[board] ${where}: failed to enqueue a re-plan after a move to Planning: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Move one issue to a board column or the backlog, with every refusal
 * `POST /board/move` documents. Shared by that route, `POST /board/bulk-move`
 * and `POST /backlog/promote` (#3293), so a bulk move is exactly N single
 * moves. Answers the status and JSON body the single route sends as-is.
 *
 * A move into Approved or Awaiting plan review writes the issue's stored
 * approval (`applyIssueApproval`, #clw_01M5VW14RKAAGS6VZ5PCKQXB9F) beside
 * the plan-review lifecycle: Approved raises it to Plan (never lowering a
 * Merge approval), Awaiting plan review lowers it to Requirements.
 */
export async function applyBoardMove(repo: string, ref: config.IssueRef, to: string, opts?: { entry?: boolean; approvedBy?: string; until?: string | null; reason?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  // Whether a write has been *issued* — not whether one returned — which is
  // what the catch below turns into a status. Issued rather than returned
  // because a write that throws may still have landed: `closeIssue` commits
  // the native state before it emits its events, a `gh` failure can surface
  // after the edit took server-side, and the removals all start before any of
  // them is awaited. A flag that meant "returned" would answer 503 "nothing
  // changed" for a move that had already closed or relabelled the issue,
  // which is the one lie it exists to prevent. The other direction — a 500
  // for a first write that in fact wrote nothing — costs the operator a
  // reload.
  let wrote = false;
  try {
    if (!isBoardDestination(to)) return { status: 400, body: { error: `Unknown column: ${to}` } };
    let move = transitionFor(to);
    // The columns no label change can produce — say so rather than silently
    // doing nothing, so the card snaps back with a reason.
    if (!move) return { status: 409, body: { error: DERIVED_COLUMN_REJECTION } };
    // Every issue entering Blocked carries a reason; refused before anything reads or writes.
    const blockedReason = opts?.reason?.trim() ?? "";
    if (to === "blocked" && !blockedReason) return { status: 400, body: { error: BLOCKED_REASON_REQUIRED } };

    const native = isClawsIssueId(ref);
    // A return date is a native Backlog park only; checked before anything reads or writes.
    let until: string | null | undefined;
    if (opts?.until !== undefined) {
      if (to !== BACKLOG_DESTINATION || !native) return { status: 400, body: { error: "A return date is only accepted when moving a native issue to the backlog" } };
      const parsedUntil = parseBacklogUntil(opts.until);
      if (!parsedUntil.ok) return { status: 400, body: { error: parsedUntil.error } };
      until = parsedUntil.until;
    }
    // A native issue's record says how many repositories own it — one half of
    // the state no label change touches.
    const record = native ? await clawsIssues.getIssue(ref) : undefined;
    // A well-formed native id the store has never heard of. Left to fall
    // through, the state read below throws and answers 503 — "try again" for
    // a condition no retry can fix — so name what is actually wrong.
    if (native && !record) return { status: 404, body: { error: "No such issue" } };
    // A native issue none of whose repos is configured any more may only be
    // closed; the configured-repo checks are skipped for that one write.
    const orphaned = !!record && await orphanedRepos(record.repos);
    if (orphaned && record && !move.close) {
      return { status: 403, body: { error: orphanedRejection(record.repos) } };
    }
    // An unassigned native issue has no repository to check; everything else
    // must name one Claws manages, exactly as the queue actions do.
    if (!orphaned && (repo ? !(await isConfiguredRepo(repo)) : !native)) {
      return { status: 403, body: { error: "Repository not configured" } };
    }
    // A repo Claws manages is not necessarily *this issue's* repo. Labelling
    // through another one would tag `label-added`/`issue-closed` at a
    // repository the issue has nothing to do with, waking that repository's
    // `claws_wait_for_change` waiters.
    if (repo && record && !record.repos.includes(repo)) {
      return { status: 403, body: { error: "Repository not configured" } };
    }
    const unassigned = !!record && record.repos.length === 0;
    // The repository every write below goes through. Resolved from the record
    // rather than taken off the wire, because an assigned native ref may
    // arrive with `repo: ""` — the card for one carries its repository, but
    // the gate above falls through on an empty string, so passing it on would
    // let a hand-sent `{repo: "", ref: <native id>}` write to an issue whose
    // only repository Claws does not manage. Resolving first puts that
    // repository back through `isConfiguredRepo`, so this route gates on the
    // allowlist like every other dashboard mutation. A multi-repo issue
    // resolves to its primary repo, which owns its labels. An unassigned
    // issue has no repository to resolve and keeps `""`, which is what the
    // façade wants: `claws-issues.ts` then emits for each repo on the record.
    const owner = (record && clawsIssues.primaryRepo(record)) || repo;
    if (!orphaned && owner !== repo && !(await isConfiguredRepo(owner))) {
      return { status: 403, body: { error: "Repository not configured" } };
    }
    // The other half: whether the issue is closed *already*, and which labels
    // it is really holding. Read rather than taken from the card — nothing
    // re-renders the board, so a tab left open outlives the issue cache by
    // hours and can still show an issue in a PR column long after its PR merged
    // and closed it. The labels ride along on the same read; they decide the
    // landing column below and which writes are worth making. The issue's
    // flight — its running implementer and open PR rows — is read beside
    // them, for the same reason; `loadIssueFlight` never throws.
    const flightRead = loadIssueFlight(owner, ref);
    // The requirements columns and Planning carry no label, so a forge issue's stage is read off
    // its shadow; a native issue's is on its record. An entry move only takes
    // the forge issue out of the backlog and leaves its stage to the shadow
    // sync, so it needs no shadow and never writes one.
    const shadowId = native ? null : await resolveTrackerId(owner, ref);
    const shadowRecord = shadowId ? await clawsIssues.getIssue(shadowId) : undefined;
    // An entry move (the backlog's Promote) asks for the requirements
    // columns but lands the issue wherever `entryLifecycle` says: Planning
    // once it has a plan or approved requirements, which need no second
    // promotion. A forge issue with no shadow yet has nothing to check and
    // stays in Drafting.
    let target: BoardDestination = to;
    const entryRecord = record ?? shadowRecord;
    if (opts?.entry && isRequirementsColumn(to) && entryRecord) {
      const exit = clawsIssues.backlogExitLifecycle(entryRecord, (await clawsIssues.listPlans(entryRecord.id)).length > 0, await flightRead);
      target = destinationForLifecycle(exit.lifecycle);
      move = transitionFor(target)!;
    }
    // A forge issue's Blocked reason lives on its shadow, so a drop into
    // Blocked with no shadow to hold it is refused like a lifecycle move.
    const forgeBlocks = !native && !move.close && move.add.includes(LABELS.blocked);
    if (!native && (move.lifecycle || forgeBlocks) && !shadowId && !opts?.entry) {
      return { status: 409, body: { error: "Claws has not synced this issue yet — try again in a few minutes." } };
    }
    const lifecycle = record?.lifecycle ?? shadowRecord?.lifecycle;
    const approvedThrough: ApprovedThrough = record?.approved_through ?? shadowRecord?.approved_through ?? "none";
    let state: IssueState;
    let labels: string[];
    try {
      ({ state, labels } = await getIssueState(owner, ref));
    } catch (err) {
      // For a forge ref this is a live API call, so it can fail on its own.
      // Nothing has been written yet, so it must not fall through to the
      // catch below: a 500 here means a *half-applied* move and would strand
      // the card. 503 is in the client's "refused, nothing changed" set.
      log.warn(`[board] state of ${owner ? `${owner}#${ref}` : `#${ref}`}: ${err}`);
      return { status: 503, body: { error: "Could not read the issue's current state — try again." } };
    }
    const closedAlready = state === "CLOSED";
    // The façade has no forge reopen, so applying a column's labels to a
    // closed forge issue would leave it in Done holding a label that says
    // otherwise. The client refuses this too, but only for the cards it
    // closed itself; a stale card only the route can catch.
    if (closedAlready && !native && !move.close) {
      return { status: 409, body: { error: FORGE_REOPEN_REJECTION } };
    }
    // A drop into Planning for a design change pending re-approval is its
    // promotion: it approves the change, so the card lands wherever that
    // leaves it rather than in Planning — reported as such instead of the
    // `landsIn` 409.
    const reapprovalId = record?.id ?? shadowId;
    if (target === "planning" && !opts?.entry && !closedAlready && reapprovalId && await hasPendingReapproval(reapprovalId)) {
      wrote = true;
      if (!(await promoteReapproval(reapprovalId, opts?.approvedBy ?? clawsIssues.CLAWS_NATIVE_LOGIN))) {
        throw new Error(`${reapprovalId} changed lifecycle since it was read — try the move again`);
      }
      const after = await getIssueState(owner, ref);
      const afterRecord = await clawsIssues.getIssue(reapprovalId);
      const landed = columnFor({ labels: after.labels, lifecycle: afterRecord?.lifecycle, approvedThrough: afterRecord?.approved_through, unassigned, ...(await loadIssueFlight(owner, ref)) });
      return { status: 200, body: { result: "ok", column: landed } };
    }
    // The plan rule: Approved and Awaiting plan review need a plan, and a
    // move into Planning re-plans an issue that has one. Read only for those
    // three targets, and never for an entry move, whose target is settled by
    // `entryLifecycle` and which never re-plans.
    let hasPlan = false;
    if (!opts?.entry && (target === "approved" || target === "awaiting-plan-review" || target === "planning")) {
      try {
        hasPlan = await issueHasPlan(owner, ref, native);
      } catch (err) {
        // Nothing has been written yet — the same "refused, nothing changed"
        // answer as a failed state read above.
        log.warn(`[board] plan of ${owner ? `${owner}#${ref}` : `#${ref}`}: ${err}`);
        return { status: 503, body: { error: "Could not read the issue's current state — try again." } };
      }
      const refusal = planRefusal(target, hasPlan);
      if (refusal) return { status: 409, body: { error: refusal } };
    }
    // The route's contract: answer `ok` only for a move that lands where it
    // was asked to. `transitionFor` cannot promise that on its own, since it
    // declares only the labels the board owns while `columnFor` also reads
    // the issue's flight, `closed` and `unassigned` — an unassigned native issue
    // takes the labels and stays in Drafting, and an issue with a running
    // implementer or an open PR keeps it through every move. So the landing
    // column is computed from the issue's live labels and flight. `closed` is
    // what the move itself does and nothing else: a closed *forge* issue out of
    // Done was refused above, and a closed *native* one is reopened below, so
    // neither reaches this line still closed. Were that reopen ever dropped,
    // this would have to read `closedAlready` again or the landing column would
    // go silently wrong.
    // Backlog outranks the flight, so the landing check below would let an
    // issue in flight leave the board; refuse it explicitly.
    const flight = await flightRead;
    if (to === BACKLOG_DESTINATION) {
      const refusal = backlogRefusal(flight);
      if (refusal) return { status: 409, body: { error: refusal } };
    }
    // Drafting or Requirements review is decided by the issue's requirements
    // state, which no move changes — read only for a move into either
    // requirements column, the one place the answer is used.
    const requirementsReview = isRequirementsColumn(target)
      ? await clawsIssues.isAwaitingRequirementsReview(record?.id ?? shadowId)
      : false;
    const landing = columnAfterMove(move, { labels, closed: move.close, unassigned, lifecycle, approvedThrough, requirementsReview, ...flight });
    // Promote/bulk-promote only mean "take it out of the backlog" — any
    // landing other than Backlog itself (e.g. an issue with an open PR) is a
    // success, reported as the column it actually landed in. A drop into
    // either requirements column that lands in the other has landed too.
    const landed = opts?.entry && isRequirementsColumn(to) ? landing !== BACKLOG_DESTINATION : landsIn(landing, target);
    if (!landed) {
      // Landing in a derived column means the issue's flight outranks the
      // target, which is the fact DERIVED_COLUMN_REJECTION already states in
      // the operator's own terms — better than "that move lands in in-progress",
      // which does not say why or what to do about it.
      const reason = unassigned
        ? UNASSIGNED_REJECTION
        : isDerivedColumn(landing)
          ? DERIVED_COLUMN_REJECTION
          : `That move lands in ${landing}, not ${to}.`;
      return { status: 409, body: { error: reason } };
    }

    // Everything below this line writes — but not every path through it does:
    // a relabelling move whose labels the issue already holds writes nothing at
    // all, and a 500 for that would send the operator off to reload a board
    // that is right. So the flag goes up per write rather than once for the
    // whole block, and always *before* the write is issued — see its
    // declaration for why "issued" is the meaning that matters.
    if (move.close) {
      wrote = true;
      await closeIssue(owner, ref, "not_planned");
    } else {
      // Dragging out of Done reopens — but only a native issue, since the
      // façade has no forge reopen; the closed forge issue was refused above.
      if (native && closedAlready) {
        wrote = true;
        await clawsIssues.reopenIssue(ref);
      }
    }
    // Approved and Awaiting plan review are one lifecycle told apart by the
    // stored approval, written first: raising it from Ideas is the promotion,
    // which the lifecycle write below then moves on from. Approved never
    // lowers a Merge approval.
    if (move.approval && !opts?.entry) {
      const approval = approvalForMove(move, approvedThrough);
      if (approval !== undefined && approval !== approvedThrough) {
        wrote = true;
        const written = await applyIssueApproval(owner, ref, approval, opts?.approvedBy ?? clawsIssues.CLAWS_NATIVE_LOGIN);
        if (!written.ok) throw new Error(written.error);
      }
    }
    // The requirements columns are both lifecycle `ideas`; every other
    // non-derived column is its own lifecycle.
    const targetLifecycle = move.lifecycle ?? target;
    if (!move.close && native && record && isIssueLifecycle(targetLifecycle)) {
      // A native issue stores its lifecycle in one field, so the move is one
      // write rather than an add-then-remove label pair — there is no
      // half-applied state for it to leave behind. Skipped when the field
      // already holds it, for the same reason a held label is skipped below.
      if (record.lifecycle !== targetLifecycle) {
        wrote = true;
        await moveNativeLifecycle(owner, record, targetLifecycle, opts?.approvedBy, !!opts?.entry, blockedReason);
      }
    } else if (!move.close) {
      // The target's label first: a removal that then fails leaves the
      // *outranking* old label in place, so the issue is still in the column
      // the card came from and the client's revert tells the truth. Adding
      // last would leave a half-applied move holding no lifecycle label at
      // all — Drafting, Requirements review or Planning, which is neither end of the drag.
      //
      // A label the issue already holds is skipped: `ensureLabel` plus a
      // `gh issue edit` to end up where it started, and a no-op `label-added`
      // event waking that repository's waiters. `removeLabel` already declines
      // the inverse case internally.
      for (const label of move.add) {
        if (labels.includes(label)) continue;
        wrote = true;
        await addLabel(owner, ref, label);
      }
      // Only the labels the issue is actually holding. The common Planning →
      // Approved drag otherwise fires a `removeLabel` for `Blocked` and
      // `Backlog` when it holds neither, and on the GitHub path each one is a
      // `fetchLiveLabels` `gh api` subprocess spawn before it decides there is
      // nothing to do.
      const toRemove = move.remove.filter((label) => labels.includes(label));
      if (toRemove.length > 0) wrote = true;
      // The removals are independent of each other and each one costs its own
      // live-label round trip, so they go together rather than in series.
      // Settled rather than `Promise.all`, which rejects at the first failure
      // while its siblings keep running and removing labels: the outcome that
      // decides the answer would be the one thrown away.
      const removed = await mapSettledWithConcurrency(
        toRemove,
        toRemove.length,
        async (label) => removeLabel(owner, ref, label),
      );
      // A removal that failed leaves a label that outranks the one just
      // added, so the card would sit in a column the issue is not in — say
      // so rather than answering `ok`, exactly as /queue/unmark-problematic
      // does. A removal that *threw* is the same story with no confirmation
      // either way, so it is reported here rather than escaping to the catch
      // below, where its siblings' outcomes would be lost.
      const failedAt = removed.findIndex((r) => r.status === "rejected" || !r.value);
      if (failedAt >= 0) {
        const outcome = removed[failedAt];
        // Indexed into `toRemove`, which is what was handed to the map:
        // `move.remove` is a superset in the usual case, so indexing it would
        // name a label the route never tried to remove.
        const label = toRemove[failedAt];
        if (outcome.status === "rejected") {
          log.warn(`[board] remove ${label} on ${owner ? `${owner}#${ref}` : `#${ref}`}: ${outcome.reason}`);
        }
        return { status: 500, body: { error: `Failed to remove the ${label} label — the board may be stale, reload it`, partial: true } };
      }
      // A forge issue's lifecycle lives on its shadow, mirroring
      // `moveNativeLifecycle`: a drop into Planning with no recorded
      // approval yet promotes it, a drop into Drafting or Requirements review
      // demotes it, and a drop into Planning that is already approved or
      // into either plan-review column (whose approval is written above) is
      // a plain lifecycle write. Moves into the label-carried columns
      // (Blocked, Backlog) leave the shadow to the shadow sync instead.
      if (shadowId && move.lifecycle && !opts?.entry && lifecycle !== move.lifecycle) {
        wrote = true;
        if (move.lifecycle === "planning" && shadowRecord?.requirements_approved_at == null) {
          const promoted = await clawsIssues.promoteIssue(shadowId, opts?.approvedBy ?? clawsIssues.CLAWS_NATIVE_LOGIN, lifecycle!);
          if (!promoted) throw new Error(`${shadowId} changed lifecycle since it was read — try the move again`);
        } else if (move.lifecycle === "ideas") {
          await clawsIssues.demoteIssue(shadowId);
        } else {
          await clawsIssues.setShadowLifecycle(shadowId, move.lifecycle);
        }
      }
      // A drop into Blocked records its reason on the shadow now, beside the
      // stage, rather than leaving the stage to the next sync — which would
      // stamp a stage change after the reason and hide it, as
      // `issue-handback.ts` does for Claws' own parks.
      if (shadowId && forgeBlocks) {
        wrote = true;
        await clawsIssues.setShadowLifecycle(shadowId, "blocked");
        await setIssueBlockedReason(shadowId, blockedReason);
      }
    }
    if (until !== undefined && record) {
      wrote = true;
      if (!(await setClawsIssueBacklogUntil(record.id, until))) throw new Error(`${record.id} left the Backlog before its return date was saved`);
    }
    // Even a card already sitting in Planning: a hand-sent move is how a card
    // stuck there with a plan and nothing running gets unstuck.
    if (target === "planning" && hasPlan) await replanAfterPlanningMove(owner, ref, labels);
    // The column the issue is in now, so the client places the card rather
    // than assuming the drop landed. A close always records `not_planned`
    // (the issue page's Close as completed control is the only way to
    // record `completed` by hand), so the client can label the card without
    // a second round trip.
    return { status: 200, body: { result: "ok", column: landing, ...(move.close ? { stateReason: "not_planned" } : {}) } };
  } catch (err) {
    // `partial` is the client's instruction to leave the card where it was
    // dropped and reload, so it is set only for a move that may be
    // half-applied. It rides in the body rather than on the status, because
    // this route is not the only producer of a 500 on this URL — Hono's
    // `app.onError` answers one, with no JSON body, for anything that throws
    // around the handler, an expired session's middleware first among them.
    // A client reading the status alone would call that a half-applied move
    // and leave the card in a column nothing wrote.
    return { status: wrote ? 500 : 503, body: { error: String(err), partial: wrote } };
  }
}

/**
 * The native issue behind `:id`, canonicalised first — a human may have typed
 * or pasted `clw_01jbq…` in lower case.
 *
 * `forWrite` makes a shadow (#3246) read as missing, so the `/issues/:id/*`
 * POST routes fall into their existing not-found response. A shadow is not an
 * operator-facing issue: its title, body, labels and state follow the forge
 * issue it stands for, and `db.ts`' by-id writes refuse it anyway — this is
 * what turns that refusal into a 404 rather than a silently discarded form
 * post. The GET handler passes no flag, because it needs the record in order
 * to redirect to the forge.
 */
export async function loadNativeIssue(c: Ctx, opts?: { forWrite?: boolean }): Promise<{ record: Awaited<ReturnType<typeof clawsIssues.getIssue>>; id: string } | null> {
  const ref = canonicalIssueRef(c.req.param("id"));
  if (!isNativeIssue(ref)) return null;
  const record = await clawsIssues.getIssue(ref);
  if (opts?.forWrite && record?.kind === "shadow") return null;
  return { record, id: ref };
}

export function issueNotFound(c: Ctx) {
  const raw = c.req.param("id") ?? "";
  const native = isNativeIssue(canonicalIssueRef(raw));
  return htmlError(
    c,
    404,
    "Issue not found",
    native
      ? "No Claws-native issue with that id."
      : "That reference belongs to a GitHub or Forgejo issue, which lives on its own forge — open it from the issue list.",
    { detail: raw ? `#${raw}` : undefined, actions: [{ href: "/issues", label: "← All issues" }] },
  );
}

/** The repo an event about this issue belongs to — its primary repo, or `""` when it has none. */
export function eventRepo(issue: { repos: readonly string[]; primary_repo?: string | null }): string {
  return clawsIssues.primaryRepo(issue);
}

/**
 * Feedback on a plan that is Awaiting plan review means the plan is no longer
 * awaiting review — send it back to the planner (Planning) immediately rather than
 * waiting for the next issue-dispatcher tick (up to 5 minutes). Shared by
 * the comment route and the attachment routes' synthesised comment, so an
 * upload has the same immediate effect as a typed comment.
 */
export async function returnToPlannerOnFeedback(
  loaded: { record: NonNullable<Awaited<ReturnType<typeof clawsIssues.getIssue>>>; id: string },
  body: string,
): Promise<void> {
  if (isPhaseClaimOnly(body) || loaded.record.state !== "open" || loaded.record.lifecycle !== "awaiting-plan-review") return;
  const repo = eventRepo(loaded.record);
  await clawsIssues.setLifecycle(repo, loaded.id, "planning");
  if (loaded.record.repos.length === 1 && !isAgentDisabled("planner")) {
    try {
      await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REFINE, repo, loaded.id, {
        priority: hasPriorityLabel(loaded.record.labels.map((name) => ({ name }))),
      });
    } catch (err) {
      log.warn(`[server] Issue ${loaded.id}: failed to enqueue refinement after operator comment: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log.info(`[server] Issue ${loaded.id}: returned to the planner (planning) on operator feedback`);
}

/**
 * Set a native issue's lifecycle state the way a board move to `column`
 * would, with the same refusals. Shared by the issue page's Status buttons
 * and the session labels and column routes, so a session's Blocked passes
 * exactly the checks an operator's click does; `approvedBy` is recorded when
 * the move promotes the issue. A move into Planning for an issue that kept
 * its plan re-plans it, as a board drop into Planning would.
 *
 * `column` is a stored lifecycle or `approved`, the plan-review lifecycle
 * with the issue approved through Plan (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F).
 * Into Approved the stored approval rises to Plan — never lowering a Merge
 * approval — and into Awaiting plan review it drops to Requirements, both
 * through `applyIssueApproval`, as a board move does.
 *
 * `opts.until` parks the issue in the Backlog until that `YYYY-MM-DD` day
 * (null clears the date, omitted leaves it); only with `column: "backlog"`.
 *
 * `opts.reason` is why the issue is Blocked: required with `column:
 * "blocked"` and written with the move in one transaction. An issue already
 * Blocked takes it as its re-stated reason.
 *
 * `opts.unblock` marks a release from Blocked to the computed release
 * lifecycle: it never writes an approval (unblocking is not plan feedback, so
 * a Plan or Merge approval stands) and skips the landing check, so the issue
 * lands wherever its labels, flight and kept approval put it.
 *
 * A move to `backlog` is refused while work is in flight (`backlogRefusal`),
 * except for an issue whose every open PR is held on an operator step with
 * nothing running; the held PRs stay open. A move out of `backlog` while PRs
 * are open is released like an unblock: no approval of its own is written and
 * it lands where its flight puts it (#clw_01M7BBKF0M3JX2BDJTZRYFNGB0).
 */
export async function setNativeColumn(record: NativeIssueRecord, id: string, column: string, approvedBy: string, opts?: { unblock?: boolean; until?: string | null; reason?: string; approval?: ApprovedThrough }): Promise<GateWriteResult> {
  if (isDerivedColumn(column)) return { ok: false, status: 409, error: DERIVED_COLUMN_REJECTION };
  if (column !== "approved" && !isIssueLifecycle(column)) return { ok: false, status: 400, error: `Unknown column: ${column}` };
  const reason = opts?.reason?.trim() ?? "";
  if (column === "blocked" && !reason) return { ok: false, status: 400, error: BLOCKED_REASON_REQUIRED };
  let until: string | null | undefined;
  if (opts?.until !== undefined) {
    if (column !== BACKLOG_DESTINATION) return { ok: false, status: 400, error: "A return date is only accepted with the backlog column." };
    const parsedUntil = parseBacklogUntil(opts.until);
    if (!parsedUntil.ok) return { ok: false, status: 400, error: parsedUntil.error };
    until = parsedUntil.until;
  }
  const refusal = await nativeStatusRefusal(record);
  if (refusal) return refusal;
  // Planning for a pending design change is its promotion — see promoteNative.
  const flight = await loadIssueFlight(eventRepo(record), id);
  const leavesBacklogInFlight = record.lifecycle === BACKLOG_DESTINATION && column !== BACKLOG_DESTINATION && column !== "blocked" && (flight.openPrs?.length ?? 0) > 0;
  if (column === "planning" && !leavesBacklogInFlight && await hasPendingReapproval(id)) return await promoteNative(record, id, approvedBy);
  const hasPlan = (await clawsIssues.listPlans(id)).length > 0;
  // Before anything writes, so a refused Approved approves nothing either.
  const planReason = planRefusal(column, hasPlan);
  if (planReason) return { ok: false, status: 409, error: planReason };
  if (column === BACKLOG_DESTINATION) {
    const refusal = backlogRefusal(flight);
    if (refusal) return { ok: false, status: 409, error: refusal };
  }
  // `ideas` is either requirements column; the issue's requirements state
  // picks which, so a landing in either one is the move landing.
  const target: BoardDestination = column === "approved" ? column : destinationForLifecycle(column);
  const unblock = opts?.unblock === true && record.lifecycle === "blocked";
  // A move out of the Backlog while PRs are still open (sent there held on an
  // operator step, `backlogRefusal`) is released like an unblock: it lands
  // where its flight puts it and keeps its approval.
  const release = unblock || leavesBacklogInFlight;
  // A release keeps the issue's approval: the move's own approval is dropped.
  const move = release ? { ...transitionFor(target)!, approval: undefined } : transitionFor(target)!;
  // A release from the Backlog ignores the requested column: its lifecycle is computed like a dependency release's.
  const lifecycle: IssueLifecycle = leavesBacklogInFlight
    ? clawsIssues.releaseLifecycle(record, hasPlan, false).lifecycle as IssueLifecycle
    : move.lifecycle ?? (column as IssueLifecycle);
  const approvedThrough: ApprovedThrough = record.approved_through ?? "none";
  const requirementsReview = column === "ideas" ? await clawsIssues.isAwaitingRequirementsReview(id) : false;
  const landing = columnAfterMove(move, { labels: record.labels, closed: false, unassigned: false, lifecycle: record.lifecycle, approvedThrough, requirementsReview, ...flight });
  // An unblock's lifecycle is computed, not requested: it lands wherever the
  // issue's labels, flight and kept approval put it, so it is never refused.
  // Nor is a release from the Backlog with open PRs, for the same reason, or
  // a send to the Backlog `backlogRefusal` allowed: Backlog outranks the flight.
  if (!release && column !== BACKLOG_DESTINATION && !landsIn(landing, target)) {
    return { ok: false, status: 409, error: isDerivedColumn(landing) ? DERIVED_COLUMN_REJECTION : `That move lands in ${landing}, not ${target}.` };
  }
  // The approval first: raising it from Ideas is the promotion, which the
  // lifecycle write below then moves on from.
  // A caller's own approval (Refine & Automerge's Merge) replaces the move's, so it is one write.
  const approval = release ? opts?.approval : opts?.approval ?? approvalForMove(move, approvedThrough);
  let approvalWritten = false;
  if (approval && approval !== approvedThrough) {
    const written = await applyIssueApproval(eventRepo(record), id, approval, approvedBy);
    if (!written.ok) return { ok: false, status: written.status as ContentfulStatusCode, error: written.error };
    approvalWritten = written.changed;
  }
  const moved = record.lifecycle !== lifecycle;
  if (moved) {
    try {
      await moveNativeLifecycle(eventRepo(record), record, lifecycle, approvedBy, false, reason);
    } catch {
      // The approval has landed: say the move was partly applied, not refused.
      return approvalWritten
        ? { ok: false, status: 500, error: `The approval was saved, but the issue changed before it moved to ${lifecycle} — reload and try the move again.` }
        : { ok: false, status: 409, error: "The issue changed since this page loaded — reload and try again." };
    }
  } else if (column === "blocked") {
    await setIssueBlockedReason(id, reason);
  }
  if (until !== undefined && !(await setClawsIssueBacklogUntil(id, until))) {
    return {
      ok: false,
      status: 409,
      error: moved
        ? "The issue was moved to the Backlog, but it changed before its return date was saved — reload and set the date again."
        : "The issue changed since this page loaded — reload and try again.",
    };
  }
  if (column === "planning" && hasPlan && !leavesBacklogInFlight) await replanAfterPlanningMove(eventRepo(record), id, record.labels);
  return { ok: true };
}

/**
 * Why a native issue's status (column or Backlog return date) cannot be
 * changed at all, or null: an unassigned issue, one in an orphaned repo and a
 * closed one are never selected by the dispatchers or the Backlog sweep.
 */
export async function nativeStatusRefusal(record: NativeIssueRecord): Promise<Extract<GateWriteResult, { ok: false }> | null> {
  if (record.repos.length === 0) return { ok: false, status: 409, error: UNASSIGNED_REJECTION };
  if (await orphanedRepos(record.repos)) return { ok: false, status: 409, error: orphanedRejection(record.repos) };
  if (record.state === "closed") return { ok: false, status: 409, error: "Reopen this issue before changing its status." };
  return null;
}

/** Where a dependency release sends a Blocked issue (clawsIssues.releaseLifecycle). */
export async function blockedReleaseLifecycle(record: NativeIssueRecord, id: string): Promise<{ lifecycle: string; replan: boolean }> {
  const plans = await clawsIssues.listPlans(id);
  const latest = plans.length ? plans[plans.length - 1] : undefined;
  return clawsIssues.releaseLifecycle(record, latest != null, latest != null && planParser.isBlockedVerdictPlan(latest.body));
}

/**
 * Remove Blocked, keeping the issue's approval: it goes where a dependency
 * release would, and with an open PR or running implementer lands in its
 * derived column. A last plan that was the planner's blocked verdict is
 * re-planned, and a comment says so and that the approval stands.
 */
export async function unblockNative(record: NativeIssueRecord, id: string, approvedBy: string): Promise<GateWriteResult & { lifecycle?: string }> {
  if (record.lifecycle !== "blocked") return { ok: true };
  const { lifecycle, replan } = await blockedReleaseLifecycle(record, id);
  // A pending design change makes the Planning move its promotion, which queues no re-plan.
  const promoted = replan && await hasPendingReapproval(id);
  const result = await setNativeColumn(record, id, lifecycle, approvedBy, { unblock: true });
  if (!result.ok) return result;
  if (replan && !promoted) {
    const approved = record.approved_through ?? "none";
    const stands = atLeast(approved, "plan") ? ` Its approval through ${approved} stands.` : "";
    await postSessionAudit(eventRepo(record), id, `Its last plan was the planner's blocked verdict, so it is back in Planning and queued for a re-plan.${stands}`);
  }
  log.info(`[server] Issue ${id}: unblocked to ${lifecycle}; approval ${record.approved_through ?? "none"} unchanged`);
  return { ok: true, lifecycle };
}

/** Who marked an operator step done: a dashboard user pressing the button, or an interactive session's tool. */
export type StepDoneActor = { kind: "dashboard"; who: string } | { kind: "session"; sid: string };

/**
 * Record an operator (`manual`) step done from the dashboard or an
 * interactive session's `claws_mark_phase_done`: post a bare
 * `claws-phase-done: N` claim — unmarked, so `parsePhaseClaims` counts it,
 * and claim-only, so `findUnreactedHumanComments` never reads it as plan
 * feedback — then a separate Claws-marked attribution comment naming who
 * did it (a failure there is logged, never fails the write), then take the
 * issue out of an awaiting-operator Blocked state. Already-claimed steps
 * answer success and post nothing.
 */
export async function markOperatorStepDone(
  record: NativeIssueRecord,
  id: string,
  position: number,
  by: StepDoneActor,
): Promise<{ ok: true; already?: boolean } | { ok: false; status: number; error: string }> {
  const who = by.kind === "dashboard" ? by.who : `session ${by.sid}`;
  const approvedBy = by.kind === "dashboard" ? by.who : sessionApprover(by.sid);
  try {
    const repo = eventRepo(record);
    const comments = await getIssueComments(repo, id);
    const state = await loadIssuePhaseState(repo, id, comments);
    const entry = state.entries?.find((e) => e.position === position);
    if (!entry) return { ok: false, status: 404, error: `The plan has no step ${position}.` };
    if (entry.kind !== "manual") return { ok: false, status: 409, error: `Step ${position} is a pull request step, not an operator step.` };
    if (!state.coverage.awaitingOperator.includes(position)) {
      if (state.coverage.blockedPhases.includes(position)) return { ok: false, status: 409, error: `Step ${position} is not reachable yet: an earlier step has not finished.` };
      log.info(`[server] Issue ${id}: operator step ${position} already done; ${who} marked it done`);
      return { ok: true, already: true };
    }
    await clawsIssues.commentOnIssue(repo, id, `claws-phase-done: ${position}`, config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN);
    await postSessionAudit(repo, id, by.kind === "dashboard"
      ? `Operator step ${position} marked done from the dashboard by ${by.who}.`
      : `Session \`${by.sid}\` marked operator step ${position} done.`);
    const reasons = await getIssueBlockedReasons([id]).catch(() => new Map<string, string>());
    const unblocked = record.lifecycle === "blocked" && (reasons.get(id) ?? "").includes(AWAITING_OPERATOR_MARKER);
    if (unblocked) {
      const result = await unblockNative(record, id, approvedBy);
      if (!result.ok) return result;
    }
    log.info(`[server] Issue ${id}: operator step ${position} marked done by ${who}${unblocked ? "; unblocked" : ""}`);
    return { ok: true };
  } catch (err) {
    log.warn(`[server] Issue ${id}: could not mark operator step ${position} done for ${who}: ${err}`);
    return { ok: false, status: 500, error: `Could not mark the step done: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Promote a native issue out of Drafting or Requirements review, approving its latest requirements
 * version as `approvedBy`. Shared by the Requirements block's Promote button
 * and the session promote route. A demoted issue that kept its plan is
 * re-planned on the way back into Planning, as a board drop into Planning
 * would.
 */
export async function promoteNative(record: NativeIssueRecord, id: string, approvedBy: string): Promise<GateWriteResult> {
  if (record.state === "closed") return { ok: false, status: 409, error: "Reopen this issue before promoting it." };
  if (record.repos.length === 0) return { ok: false, status: 409, error: UNASSIGNED_REJECTION };
  // A design change pending re-approval is promoted from any column, and
  // the promotion is its approval — never a re-plan.
  if (await hasPendingReapproval(id)) {
    if (!(await promoteReapproval(id, approvedBy))) return { ok: false, status: 409, error: "The issue changed since this page loaded — reload and try again." };
    return { ok: true };
  }
  if (record.lifecycle !== "ideas") return { ok: false, status: 409, error: "Only an issue in Drafting or Requirements review can be promoted." };
  const promoted = await clawsIssues.promoteIssue(id, approvedBy, "ideas");
  if (!promoted) return { ok: false, status: 409, error: "The issue changed since this page loaded — reload and try again." };
  if ((await clawsIssues.listPlans(id)).length > 0) {
    await replanAfterPlanningMove(eventRepo(record), id, record.labels);
  }
  return { ok: true };
}

/**
 * Uploading a file from the Attachments-section form counts as plan
 * feedback, same as a typed comment (issue clw_01M39J5AT1SKCFV6CHMWPVHD6M):
 * post an "Attached …" comment on the uploader's behalf, one line per
 * stored file, so `commentOnIssue` stamps `comment_id` on each row and
 * `returnToPlannerOnFeedback` sends an Awaiting-review issue back to the
 * planner. Carries no "Automated by Claws" marker, so the refiner treats it
 * as human feedback.
 */
export async function postAttachmentFeedbackComment(
  loaded: { record: NonNullable<Awaited<ReturnType<typeof clawsIssues.getIssue>>>; id: string },
  rows: readonly ClawsIssueAttachmentRow[],
): Promise<void> {
  const body = rows
    .map((row) => {
      const name = row.filename.replace(/[[\]]/g, "_");
      const prefix = isInlineImage(row) ? "!" : "";
      return `Attached ${prefix}[${name}](${attachmentUrl(row)})`;
    })
    .join("\n");
  const uploader = config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN;
  const commentId = await clawsIssues.commentOnIssue(eventRepo(loaded.record), loaded.id, body, uploader);
  if (commentId) log.info(`[server] Issue ${loaded.id}: posted attachment feedback comment ${commentId}`);
  await returnToPlannerOnFeedback(loaded, body);
}
