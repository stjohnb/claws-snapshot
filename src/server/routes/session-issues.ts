/** Session gate writes on native issues (docs/product/interactive-sessions.md), up to `sessionPrGuard`. Moved out of `registerRoutes` (src/server.ts) unchanged; `sessionIssueGuard` is hoisted to module level because the agent API notes routes share it. */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Hono } from "hono";
import * as config from "../../config.js";
import { listRepos, addLabel, removeLabel, isNativeIssue, type Issue, type PR } from "../../github.js";
import { LABELS } from "../../config.js";
import { editIssue, editIssueTitle, closeIssue, commentOnIssue as ghCommentOnIssue } from "../../github.js";
import { normalizeTier } from "../../model-selector.js";
import { clearPrHold } from "../../pr-hold.js";
import { getClawsPr } from "../../db.js";
import * as log from "../../log.js";
import { offeredLabels } from "../../pages/issue.js";
import { liftOverlapHold, overlapHoldNote } from "../../overlap-gate.js";
import { describeModelPlan, isModelPlanPhase, isModelPlanProvider, MODEL_PLAN_PHASES, setExplicitPlan, summarizeModelPlanCells, type ModelPlanCell } from "../../model-plan.js";
import { hasPendingReapproval } from "../../reapproval.js";
import { APPROVAL_GATES, atLeast, isApprovedThrough } from "../../issue-approval.js";
import { RETIRED_GATE_LABELS } from "../../issue-lifecycle.js";
import { deriveApprovalTrack } from "../../pages/approval-track.js";
import { UNASSIGNED_REJECTION } from "../../issue-board.js";
import { RequirementsRecordSchema } from "../../requirements-record.js";
import { ISSUE_LIFECYCLES } from "../../issue-lifecycle.js";
import * as clawsIssues from "../../claws-issues.js";
import { canonicalIssueRef } from "../../issue-id.js";
import { getSessionBackend } from "../../session-backend.js";
import { mergeDuplicateInto, mergeRefusal, type MergeDuplicateResult } from "../../issue-merge.js";
import { sanitizeUploadFilename } from "../../session-uploads-core.js";
import { guessSessionFileContentType } from "../../session-files.js";
import { formatBytes } from "../../format.js";
import { storeIssueAttachmentStream, attachmentUrl } from "../../issue-attachments.js";
import { type Ctx, type Env, jsonOk } from "../http.js";
import { apiAuthMiddleware, sessionOwnTokenMiddleware } from "../auth.js";
import { type GateWriteResult, type NativeIssueRecord, OUTSIDE_SESSION_AREAS_ERROR, RepoPrNumberSchema, isConfiguredRepo, orphanedRejection, orphanedRepos, sessionApprover } from "../shared.js";
import { loadNativeIssue, setNativeColumn, unblockNative, markOperatorStepDone, promoteNative, postAttachmentFeedbackComment } from "../issue-actions.js";
import { loadApprovalTrackInput, checkedApproval } from "../approval-actions.js";
import { postSessionAudit, startSpawnedSession } from "../session-actions.js";
import type { RouteContext } from "./context.js";


/**
 * The live session and writable native issue a session route acts on, or the
 * response refusing it: an unknown session or issue (a shadow included) is a
 * 404, a closed or unassigned issue a 409, and an issue whose primary repo
 * Claws does not manage a 403. `allowClosed` / `allowUnassigned` lift the
 * closed and unassigned refusals for the routes the dashboard allows them on;
 * an unassigned issue then has `repo` `""` and skips the managed-repo check.
 * `allowOrphaned` lets through an issue none of whose repos is configured
 * any more (`orphaned: true`) so it can still be closed and relabelled.
 */
export async function sessionIssueGuard(c: Ctx, opts: { allowClosed?: boolean; allowUnassigned?: boolean; allowOrphaned?: boolean } = {}): Promise<{ sid: string; record: NativeIssueRecord; id: string; repo: string; orphaned: boolean } | Response> {
  const sid = c.req.param("sid") ?? "";
  if (!/^[a-f0-9]+$/.test(sid)) return jsonOk(c, { error: "Session not found" }, 404);
  const live = await getSessionBackend().getLive(sid);
  if (!live.ok) return jsonOk(c, { error: "Session not found" }, 404);
  const loaded = await loadNativeIssue(c, { forWrite: true });
  if (!loaded?.record) {
    const raw = c.req.param("id") ?? "";
    if (!isNativeIssue(canonicalIssueRef(raw))) {
      return jsonOk(c, { error: "Not a Claws-native issue — use the Forgejo API for a forge issue" }, 404);
    }
    return jsonOk(c, { error: "Issue not found" }, 404);
  }
  const { record, id } = loaded;
  if (record.state === "closed" && !opts.allowClosed) return jsonOk(c, { error: "The issue is closed — reopen it before changing its state." }, 409);
  if (record.repos.length === 0) {
    if (!opts.allowUnassigned) return jsonOk(c, { error: UNASSIGNED_REJECTION }, 409);
    return { sid, record, id, repo: "", orphaned: false };
  }
  const repo = clawsIssues.primaryRepo(record);
  if (!(await isConfiguredRepo(repo))) {
    if (opts.allowOrphaned && await orphanedRepos(record.repos)) return { sid, record, id, repo, orphaned: true };
    return jsonOk(c, { error: "Repository not configured" }, 403);
  }
  return { sid, record, id, repo, orphaned: false };
}

export function registerSessionIssueRoutes(app: Hono<Env>, ctx: RouteContext): void {
  // ── Session gate writes (docs/product/interactive-sessions.md) ──
  //
  // The claws-state tools an interactive session uses to move a native issue
  // through the human gates it is driving it through — its approval
  // (`approval`), Blocked, Priority, promotion — to set its model plan, and to take the
  // issue page's other actions: close/reopen (`state`), edit title and body
  // (`edit`), set repos (`repos`), move the Status column (`column`), the
  // Labels form's other labels (`labels`), and close an issue as a duplicate
  // of another (`close-as-duplicate`), and attach a file from its pod to the
  // issue (`attachments`). It may also clear a PR's
  // recorded manual action once the step is done. Only the session
  // tools call these (`claws-state-tools.ts` registers them only when the
  // transport supplies `fetchSessionApi`: the `/mcp/sessions/:id` endpoint
  // every session pod uses), and `:sid` must name a live
  // session. Each write passes the
  // dashboard's own checks, records `session:<sid>` as the approver where the
  // store has an approver column, and posts one Claws-marked audit comment so
  // the issue's (or PR's) history tells it apart from an operator's click.

  /**
   * The labels a session may set: the Labels form's set (`offeredLabels`)
   * plus Blocked, which moves the lifecycle as the Status buttons do.
   */
  function sessionLabels(): string[] {
    return [LABELS.blocked, ...offeredLabels(Object.keys(config.LABEL_SPECS))];
  }
  /** `{ phase, provider, tier, model, source, explicit, suggested }` per phase, for the model-plan routes. */
  async function sessionModelPlanView(repo: string, record: NativeIssueRecord) {
    const rows = await describeModelPlan(repo || null, record.id, record.labels.map((name) => ({ name })));
    return rows.map((r) => ({
      phase: r.phase,
      provider: r.provider,
      tier: r.tier,
      model: r.resolvedModel,
      source: r.source,
      explicit: r.cellProvider || r.cellTier ? { provider: r.cellProvider, tier: r.cellTier } : null,
      suggested: r.suggestedProvider || r.suggestedTier ? { provider: r.suggestedProvider, tier: r.suggestedTier } : null,
    }));
  }

  app.post("/api/sessions/:sid/issues/:id/labels", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c, { allowOrphaned: true });
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { label, present, reason } = (body ?? {}) as { label?: unknown; present?: unknown; reason?: unknown };
    if (reason !== undefined && typeof reason !== "string") return jsonOk(c, { error: "reason must be a string" }, 400);
    // The retired gate labels are an approval now (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F),
    // set through the sibling `approval` route.
    if (typeof label === "string" && (RETIRED_GATE_LABELS as readonly string[]).includes(label)) {
      return jsonOk(c, { error: `${label} is not a label any more — use claws_set_issue_approval` }, 400);
    }
    const allowed = sessionLabels();
    if (typeof label !== "string" || !allowed.includes(label)) {
      return jsonOk(c, { error: `label must be one of ${allowed.join(", ")}` }, 400);
    }
    if (guard.orphaned && label === LABELS.blocked) {
      return jsonOk(c, { error: orphanedRejection(record.repos) }, 409);
    }
    if (typeof present !== "boolean") return jsonOk(c, { error: "present must be a boolean" }, 400);
    const approvedBy = sessionApprover(sid);
    let changed = false;
    let result: GateWriteResult = { ok: true };
    if (label === LABELS.blocked) {
      if (present && record.lifecycle !== "blocked") {
        result = await setNativeColumn(record, id, "blocked", approvedBy, { reason });
        changed = result.ok;
      } else if (!present && record.lifecycle === "blocked") {
        result = await unblockNative(record, id, approvedBy);
        changed = result.ok;
      }
    } else if (label === LABELS.priority) {
      if (present && !record.labels.includes(label)) {
        try {
          await addLabel(repo, id, label);
        } catch (err) {
          return jsonOk(c, { error: `Failed to apply the Priority label: ${err instanceof Error ? err.message : String(err)}` }, 500);
        }
        changed = true;
      } else if (!present && record.labels.includes(label)) {
        if (!(await removeLabel(repo, id, label))) return jsonOk(c, { error: "Failed to remove the Priority label" }, 500);
        changed = true;
      }
    } else if (present && !record.labels.includes(label)) {
      // Every other label the Labels form offers is a plain add or remove.
      try {
        await addLabel(repo, id, label);
      } catch (err) {
        return jsonOk(c, { error: `Failed to apply the ${label} label: ${err instanceof Error ? err.message : String(err)}` }, 500);
      }
      changed = true;
    } else if (!present && record.labels.includes(label)) {
      if (!(await removeLabel(repo, id, label))) return jsonOk(c, { error: `Failed to remove the ${label} label` }, 500);
      changed = true;
    }
    if (!result.ok) return jsonOk(c, { error: result.error }, result.status);
    if (changed) {
      // Unblocking keeps the approval; the audit says so, so nobody reads it as a withdrawal.
      const approved = record.approved_through ?? "none";
      const kept = label === LABELS.blocked && !present && atLeast(approved, "plan") ? `; its approval through ${approved} is unchanged` : "";
      await postSessionAudit(repo, id, `Session \`${sid}\` ${present ? "applied" : "removed"} **${label}**${kept}.`);
    }
    const after = (await clawsIssues.getIssue(id)) ?? record;
    return jsonOk(c, {
      ok: true,
      changed,
      lifecycle: after.lifecycle,
      labels: after.labels,
      ...(await sessionIssueTrack(repo, id)),
    });
  });

  // The `claws_mark_phase_done` tool: mark a plan's operator (`manual`) step
  // done from an interactive session, as the Mark step done button does,
  // with an attribution comment naming the session.
  app.post("/api/sessions/:sid/issues/:id/steps/done", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c, { allowOrphaned: true });
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { position } = (body ?? {}) as { position?: unknown };
    if (typeof position !== "number" || !Number.isInteger(position) || position < 1) {
      return jsonOk(c, { error: "position must be a positive integer" }, 400);
    }
    const result = await markOperatorStepDone(record, id, position, { kind: "session", sid });
    if (!result.ok) return jsonOk(c, { error: result.error }, result.status);
    const track = await sessionIssueTrack(repo, id);
    return jsonOk(c, { ok: true, position, ...(result.already ? { already: true } : {}), column: track.column });
  });

  // The `claws_start_issue_anyway` tool: lift the issue's file-overlap hold
  // until it closes, as the Start anyway button does; refused unless held.
  app.post("/api/sessions/:sid/issues/:id/overlap/start", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c);
    if (guard instanceof Response) return guard;
    const { sid, id, repo } = guard;
    const result = await liftOverlapHold(id, { kind: "session", sid });
    if (!result.ok) return jsonOk(c, { error: result.error }, result.status);
    const track = await sessionIssueTrack(repo, id);
    return jsonOk(c, { ok: true, lifted_hold: overlapHoldNote(result.hold), ...track });
  });

  /**
   * The board column, approval and "Stops at" line a session issue write
   * answers with, so its reply shows the stage `claws_list_issues` does
   * rather than only the stored lifecycle; nulls when the read fails.
   */
  async function sessionIssueTrack(repo: string, id: string): Promise<{ column: string | null; approved_through: string | null; stops_at: string | null }> {
    try {
      const track = await loadApprovalTrackInput(repo, id);
      if (track) return { column: track.column, approved_through: track.approvedThrough ?? "none", stops_at: deriveApprovalTrack(track).stopsAt };
    } catch (err) {
      log.warn(`[sessions] approval track of ${id} after the write: ${err}`);
    }
    return { column: null, approved_through: null, stops_at: null };
  }

  // The `claws_set_issue_approval` tool (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F): set
  // how far the issue is approved (`issue-approval.ts`), checked against the
  // approval track as a gate click on the dashboard is. Raising needs the
  // target gate to offer `approve` — one click approves every gate up to it —
  // and lowering from Merge to Plan needs the Merge gate's `withdraw`.
  // Lowering to Requirements is allowed from any column: it is how a session
  // sends a planned issue back to plan review, or withdraws a pre-approval.
  // `none` is refused: an issue leaves Requirements only by being sent back
  // to Ideas. Answers with the re-read track's column and "Stops at" line.
  app.post("/api/sessions/:sid/issues/:id/approval", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c);
    if (guard instanceof Response) return guard;
    const { sid, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { through } = (body ?? {}) as { through?: unknown };
    if (!isApprovedThrough(through)) return jsonOk(c, { error: `through must be one of ${APPROVAL_GATES.join(", ")}` }, 400);
    if (through === "none") {
      return jsonOk(c, { error: "Approval cannot be withdrawn below Requirements — send the issue back to Ideas instead" }, 400);
    }
    const result = await checkedApproval(repo, id, () => through, sessionApprover(sid));
    if (!result.ok) return jsonOk(c, { error: result.error }, result.status);
    let after: Awaited<ReturnType<typeof loadApprovalTrackInput>> = null;
    try {
      after = await loadApprovalTrackInput(repo, id);
    } catch (err) {
      log.warn(`[sessions] approval state of ${id} after the write: ${err}`);
    }
    if (!after) return jsonOk(c, { approved_through: through, column: null, stops_at: null });
    return jsonOk(c, { approved_through: after.approvedThrough ?? "none", column: after.column, stops_at: deriveApprovalTrack(after).stopsAt });
  });

  app.post("/api/sessions/:sid/issues/:id/promote", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c);
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    const result = await promoteNative(record, id, sessionApprover(sid));
    if (!result.ok) return jsonOk(c, { error: result.error }, result.status);
    await postSessionAudit(repo, id, `Session \`${sid}\` promoted this issue to Planning, approving its latest requirements.`);
    const after = (await clawsIssues.getIssue(id)) ?? record;
    return jsonOk(c, { ok: true, lifecycle: after.lifecycle, ...(await sessionIssueTrack(repo, id)) });
  });

  // The issue page's Status "Close" / "Reopen" controls. Closed and
  // unassigned issues pass the guard: reopening needs the one, and the
  // dashboard closes the other. Already in the requested state is a 409.
  app.post("/api/sessions/:sid/issues/:id/state", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c, { allowClosed: true, allowUnassigned: true, allowOrphaned: true });
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { state, reason } = (body ?? {}) as { state?: unknown; reason?: unknown };
    if (state !== "open" && state !== "closed") return jsonOk(c, { error: "state must be open or closed" }, 400);
    if (state === "closed" && reason !== "completed" && reason !== "not_planned") {
      return jsonOk(c, { error: "reason must be completed or not_planned when closing" }, 400);
    }
    if (record.state === state) return jsonOk(c, { error: `The issue is already ${state}.` }, 409);
    if (state === "open") {
      await clawsIssues.reopenIssue(id);
      await postSessionAudit(repo, id, `Session \`${sid}\` reopened this issue.`);
    } else {
      const closeReason = reason === "completed" ? "completed" : "not_planned";
      await closeIssue(repo, id, closeReason);
      await postSessionAudit(repo, id, `Session \`${sid}\` closed this issue as ${closeReason === "completed" ? "completed" : "not planned"}.`);
    }
    const after = (await clawsIssues.getIssue(id)) ?? record;
    return jsonOk(c, { ok: true, changed: true, state: after.state, state_reason: after.state_reason });
  });

  // Close as a duplicate in one call, so the order and the refusals live here
  // rather than in the agent: Duplicate first, then the
  // `claws-duplicate-of:<canonical>` marker `listDuplicateIssuesOf` reads
  // (which doubles as the audit comment), then merge it into the canonical
  // issue (`issue-merge.ts`: its dedupe keys and occurrences move there, with
  // one comment on the canonical issue), then close as not planned.
  app.post("/api/sessions/:sid/issues/:id/close-as-duplicate", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c, { allowUnassigned: true, allowOrphaned: true });
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const rawCanonical = (body as { canonical_id?: unknown } | null)?.canonical_id;
    const canonical = typeof rawCanonical === "string" ? canonicalIssueRef(rawCanonical) : null;
    if (!isNativeIssue(canonical)) return jsonOk(c, { error: "canonical_id must be a Claws-native issue id (clw_…)" }, 400);
    if (canonical === id) return jsonOk(c, { error: "An issue cannot be a duplicate of itself." }, 409);
    const target = await clawsIssues.getIssue(canonical);
    if (!target || target.kind === "shadow") return jsonOk(c, { error: `Canonical issue ${canonical} not found` }, 404);
    if (target.state === "closed") return jsonOk(c, { error: `The canonical issue ${canonical} is closed — pick the open issue the work continues on.` }, 409);
    // An issue holding dedupe keys is closed only when they can move to the
    // canonical issue; checked before anything is written, so a refusal
    // leaves no Duplicate label behind for the dispatcher to settle.
    if (record.dedupe_keys.length > 0) {
      const refusal = await mergeRefusal(id, canonical, record, target);
      if (refusal !== null) {
        return jsonOk(c, { error: `${refusal} It holds dedupe keys (${record.dedupe_keys.join(", ")}) that would stay on a closed issue, so it is not closed as a duplicate.` }, 409);
      }
    }
    if (!record.labels.includes(LABELS.duplicate)) {
      try {
        await addLabel(repo, id, LABELS.duplicate);
      } catch (err) {
        return jsonOk(c, { error: `Failed to apply the ${LABELS.duplicate} label: ${err instanceof Error ? err.message : String(err)}` }, 500);
      }
    }
    const marker = `claws-duplicate-of:${canonical}`;
    try {
      // A retry after a failed close must not post the marker a second time.
      const marked = (await clawsIssues.listCommentDetails(id)).some((cm) => cm.body.includes(marker));
      if (!marked) {
        await ghCommentOnIssue(repo, id, `Session \`${sid}\` closed this issue as a duplicate of #${canonical}.\n\n${marker}`);
      }
    } catch (err) {
      return jsonOk(c, { error: `The ${LABELS.duplicate} label was applied but the issue is still open: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    let merge: MergeDuplicateResult;
    try {
      merge = await mergeDuplicateInto(id, canonical, `Session ${sid}`);
    } catch (err) {
      return jsonOk(c, { error: `The ${LABELS.duplicate} label and the duplicate marker were applied but moving its dedupe keys to ${canonical} failed, so the issue is still open: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    if (!merge.ok && merge.sourceHoldsKeys) return jsonOk(c, { error: merge.reason }, 409);
    try {
      await closeIssue(repo, id, "not_planned");
    } catch (err) {
      return jsonOk(c, { error: `The ${LABELS.duplicate} label and the duplicate marker were applied but closing the issue failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    const after = (await clawsIssues.getIssue(id)) ?? record;
    return jsonOk(c, { ok: true, state: after.state, state_reason: after.state_reason, canonical, moved_dedupe_keys: merge.ok ? merge.keys : [] });
  });

  // The issue page's Edit form: an omitted field is left alone, a blank title
  // is refused, and an empty body is a valid body. A body edit goes through
  // the same `editIssue` façade as the dashboard's, so an issue with a plan
  // re-plans through the plan-hash check exactly as after a dashboard edit.
  app.post("/api/sessions/:sid/issues/:id/edit", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c);
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { title, body: newBody } = (body ?? {}) as { title?: unknown; body?: unknown };
    if (title == null && newBody == null) return jsonOk(c, { error: "Give a title, a body, or both" }, 400);
    if (title != null && typeof title !== "string") return jsonOk(c, { error: "title must be a string" }, 400);
    if (newBody != null && typeof newBody !== "string") return jsonOk(c, { error: "body must be a string" }, 400);
    const trimmed = typeof title === "string" ? title.trim() : undefined;
    if (trimmed === "") return jsonOk(c, { error: "title must not be blank" }, 400);
    const parts: string[] = [];
    if (trimmed !== undefined && trimmed !== record.title) {
      await editIssueTitle(repo, id, trimmed);
      parts.push(`edited the title (was: ${record.title})`);
    }
    if (typeof newBody === "string" && newBody !== record.body) {
      await editIssue(repo, id, newBody);
      parts.push("edited the body");
    }
    const changed = parts.length > 0;
    if (changed) await postSessionAudit(repo, id, `Session \`${sid}\` ${parts.join(" and ")}.`);
    return jsonOk(c, { ok: true, changed, title: trimmed ?? record.title });
  });

  // Bulk soft delete for a session tidying an issue's discussion
  // (docs/product/interactive-sessions.md "Let a session tidy..."). All or
  // nothing: one unknown, foreign or protected id refuses the whole call.
  app.post("/api/sessions/:sid/issues/:id/comments/delete", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c, { allowClosed: true, allowUnassigned: true, allowOrphaned: true });
    if (guard instanceof Response) return guard;
    const { sid, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const ids = (body as { comment_ids?: unknown } | null)?.comment_ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string" && x.trim() !== "")) {
      return jsonOk(c, { error: "comment_ids must be a non-empty array of comment ids" }, 400);
    }
    let deleted: number;
    try {
      deleted = await clawsIssues.deleteIssueComments(id, ids as string[], `session:${sid}`);
    } catch (err) {
      if (!(err instanceof clawsIssues.IssueCommentDeleteError)) throw err;
      return jsonOk(c, { error: err.message }, err.reason === "refused" ? 409 : 404);
    }
    if (deleted > 0) await postSessionAudit(repo, id, `Session \`${sid}\` deleted ${deleted} comment${deleted === 1 ? "" : "s"}; see the issue's History.`);
    return jsonOk(c, { ok: true, deleted });
  });

  // Stores a session's revised requirements record as a new, unapproved
  // version. Approval stays on the operator's paths (Requirements review, then
  // promote), and a design change awaiting re-approval must be settled first.
  app.post("/api/sessions/:sid/issues/:id/requirements", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c);
    if (guard instanceof Response) return guard;
    const { sid, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const parsed = RequirementsRecordSchema.safeParse(body);
    if (!parsed.success) {
      return jsonOk(c, { error: `Invalid requirements record: ${parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ")}` }, 400);
    }
    if (await hasPendingReapproval(id)) {
      return jsonOk(c, { error: "A design change is awaiting re-approval on this issue — settle it before storing a new requirements version." }, 409);
    }
    const version = await clawsIssues.storeSessionRequirements(id, parsed.data);
    await postSessionAudit(repo, id, `Session \`${sid}\` stored requirements v${version} — not approved.`);
    return jsonOk(c, { ok: true, version, approved: false });
  });

  // The issue page's Repositories form, restricted to repos Claws manages. An
  // unknown repo is refused rather than dropped, and clearing every repo is
  // not offered. An unassigned issue passes the guard: assigning it is the point.
  app.post("/api/sessions/:sid/issues/:id/repos", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c, { allowUnassigned: true });
    if (guard instanceof Response) return guard;
    const { sid, record, id } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const rawRepos = (body as { repos?: unknown } | null)?.repos;
    if (!Array.isArray(rawRepos) || rawRepos.length === 0 || !rawRepos.every((r) => typeof r === "string")) {
      return jsonOk(c, { error: "repos must be a non-empty array of repo names" }, 400);
    }
    const repos = [...new Set(rawRepos as string[])];
    const known = new Set((await listRepos()).map((r) => r.fullName));
    const unknown = repos.find((r) => !known.has(r));
    if (unknown !== undefined) return jsonOk(c, { error: `Not a repo Claws manages: ${unknown}` }, 400);
    const before = [...record.repos].sort();
    const changed = !isDeepStrictEqual(before, [...repos].sort());
    if (changed) {
      await clawsIssues.setRepos(id, repos);
      // Reloaded so a pinned primary (`claws_issues.primary_repo`) still decides where the audit lands.
      const updated = await clawsIssues.getIssue(id);
      await postSessionAudit(clawsIssues.primaryRepo(updated ?? { repos }), id, `Session \`${sid}\` set the repositories to ${repos.join(", ")} (was: ${before.length > 0 ? before.join(", ") : "none"}).`);
    }
    return jsonOk(c, { ok: true, changed, repos: changed ? repos : record.repos });
  });

  // The issue page's Status buttons: the same `setNativeColumn` write and
  // refusals as an operator's click. Closing is the state route, not a column.
  app.post("/api/sessions/:sid/issues/:id/column", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c);
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const column = (body as { column?: unknown } | null)?.column;
    if (typeof column !== "string" || !(ISSUE_LIFECYCLES as readonly string[]).includes(column)) {
      return jsonOk(c, { error: `column must be one of ${ISSUE_LIFECYCLES.join(", ")}` }, 400);
    }
    // `until`: a YYYY-MM-DD day parks the issue in the Backlog until then,
    // null clears the date, omitted leaves it as it is.
    const rawUntil = (body as { until?: unknown } | null)?.until;
    if (rawUntil !== undefined && rawUntil !== null && typeof rawUntil !== "string") {
      return jsonOk(c, { error: "until must be a YYYY-MM-DD date or null" }, 400);
    }
    // `reason`: why the issue is Blocked — required with `column: "blocked"`.
    const rawReason = (body as { reason?: unknown } | null)?.reason;
    if (rawReason !== undefined && typeof rawReason !== "string") return jsonOk(c, { error: "reason must be a string" }, 400);
    const result = await setNativeColumn(record, id, column, sessionApprover(sid), { until: rawUntil, reason: rawReason });
    if (!result.ok) return jsonOk(c, { error: result.error }, result.status);
    const after = (await clawsIssues.getIssue(id)) ?? record;
    const untilBefore = record.backlog_until ?? null;
    const untilAfter = after.backlog_until ?? null;
    // A move can lower the approval (`approvalForMove`) without changing the column.
    const approvalBefore = record.approved_through ?? "none";
    const approvalAfter = after.approved_through ?? "none";
    const approvalChanged = approvalBefore !== approvalAfter;
    const approvalNote = approvalChanged ? ` Its approval went from ${approvalBefore} to ${approvalAfter}.` : "";
    const changed = record.lifecycle !== column || untilBefore !== untilAfter || approvalChanged;
    if (record.lifecycle !== column) {
      await postSessionAudit(repo, id, `Session \`${sid}\` moved this issue to ${column}${untilAfter ? ` until ${untilAfter}` : ""}.${approvalNote}`);
    } else if (approvalChanged) {
      await postSessionAudit(repo, id, `Session \`${sid}\` re-sent this issue to ${column}, lowering its approval from ${approvalBefore} to ${approvalAfter}.`);
    } else if (untilBefore !== untilAfter) {
      await postSessionAudit(repo, id, untilAfter
        ? `Session \`${sid}\` set this issue's Backlog return date to ${untilAfter}${untilBefore ? ` (was: ${untilBefore})` : ""}.`
        : `Session \`${sid}\` cleared this issue's Backlog return date (was: ${untilBefore}).`);
    }
    return jsonOk(c, { ok: true, changed, lifecycle: after.lifecycle, backlog_until: untilAfter });
  });

  // Read-only, so any claws-state caller may use it — but native-only, like the
  // write below: a shadow's model plan is never surfaced through the dashboard,
  // so `forWrite` here is not an accident of reuse.
  app.get("/api/issues/:id/model-plan", apiAuthMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return jsonOk(c, { error: "Not a Claws-native issue" }, 404);
    const repo = clawsIssues.primaryRepo(loaded.record);
    return jsonOk(c, { issue: loaded.id, repo: repo || null, phases: await sessionModelPlanView(repo, loaded.record) });
  });

  // The Model plan form's write (`POST /issues/:id/model-plan`), for only the
  // phases named: a cell with neither provider nor tier clears the phase's
  // explicit cell and leaves a planner suggestion in place. An unknown phase,
  // provider or tier is refused rather than read as blank.
  app.post("/api/sessions/:sid/issues/:id/model-plan", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c);
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const rawCells = (body as { cells?: unknown } | null)?.cells;
    if (!Array.isArray(rawCells) || rawCells.length === 0) return jsonOk(c, { error: "cells must be a non-empty array" }, 400);
    const cells: ModelPlanCell[] = [];
    for (const raw of rawCells) {
      const { phase, provider, tier } = (raw ?? {}) as { phase?: unknown; provider?: unknown; tier?: unknown };
      if (typeof phase !== "string" || !isModelPlanPhase(phase)) {
        return jsonOk(c, { error: `phase must be one of ${MODEL_PLAN_PHASES.join(", ")}` }, 400);
      }
      if (provider != null && typeof provider !== "string") return jsonOk(c, { error: `${phase}: provider must be a string` }, 400);
      if (tier != null && typeof tier !== "string") return jsonOk(c, { error: `${phase}: tier must be a string` }, 400);
      const p = (provider ?? "").trim();
      const t = (tier ?? "").trim();
      if (p && !isModelPlanProvider(p)) return jsonOk(c, { error: `${phase}: unknown provider ${p}` }, 400);
      const normalizedTier = t ? normalizeTier(t) : null;
      if (t && !normalizedTier) return jsonOk(c, { error: `${phase}: unknown tier ${t}` }, 400);
      cells.push({ phase, provider: p && isModelPlanProvider(p) ? p : null, tier: normalizedTier });
    }
    const before = await sessionModelPlanView(repo, record);
    await setExplicitPlan(repo, id, cells);
    const after = await sessionModelPlanView(repo, record);
    const beforeExplicit = new Map(before.map((r) => [r.phase, r.explicit]));
    const afterExplicit = new Map(after.map((r) => [r.phase, r.explicit]));
    // Only the phases whose explicit cell actually moved, not every phase the
    // request named blank — a blank cell that was already blank cleared nothing.
    const touched = cells.filter((cell) => !isDeepStrictEqual(beforeExplicit.get(cell.phase), afterExplicit.get(cell.phase)));
    const changed = touched.length > 0;
    if (changed) {
      const set = summarizeModelPlanCells(touched);
      const cleared = touched.filter((cell) => !cell.provider && !cell.tier).map((cell) => cell.phase);
      const parts = [set ? `set ${set}` : "", cleared.length > 0 ? `cleared ${cleared.join(", ")}` : ""].filter(Boolean);
      await postSessionAudit(repo, id, `Session \`${sid}\` changed the model plan: ${parts.join("; ")}.`);
    }
    return jsonOk(c, { ok: true, changed, issue: id, repo, phases: after });
  });

  // Start a new, independent interactive session dedicated to this issue
  // (`claws_start_session`, the /new-session skill). Options default as the
  // New session form's do; nothing is silently substituted. The new session
  // gets only the baseline grant — the implicit capabilities plus the agent's
  // own login, which the form always pre-ticks — and each requested capability
  // becomes a pending request the operator decides on its page. The row
  // records who started it, as plain strings: no live link between the two.
  app.post("/api/sessions/:sid/issues/:id/start-session", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c, { allowUnassigned: true });
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    return startSpawnedSession(ctx, c, sid, { record, id, repo });
  });

  // Attach a file from this session's pod to the issue
  // (`claws_add_issue_attachment`, #clw_01M6KD2BTTTJ6NKN3K0QA4S3TB). The pod
  // serves the bytes (inside HOME, ≤ 10 MB) and they stream straight into the
  // attachment store unchanged. By default only a Claws-marked audit comment
  // records it, so the dispatcher does not re-plan; `feedback: true` posts the
  // dashboard's "Attached …" operator comment and returns an Awaiting-review
  // issue to planning, exactly like the Attachments form.
  app.post("/api/sessions/:sid/issues/:id/attachments", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c);
    if (guard instanceof Response) return guard;
    const { sid, record, id, repo } = guard;
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { path: podPath, filename, content_type: contentTypeRaw, feedback } = (body ?? {}) as {
      path?: unknown; filename?: unknown; content_type?: unknown; feedback?: unknown;
    };
    if (typeof podPath !== "string" || !podPath.trim()) return jsonOk(c, { error: "path is required" }, 400);
    if (filename !== undefined && typeof filename !== "string") return jsonOk(c, { error: "filename must be a string" }, 400);
    if (feedback !== undefined && typeof feedback !== "boolean") return jsonOk(c, { error: "feedback must be a boolean" }, 400);
    let contentType: string | undefined;
    if (contentTypeRaw !== undefined) {
      if (typeof contentTypeRaw !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentTypeRaw.trim().toLowerCase())) {
        return jsonOk(c, { error: "content_type must be a MIME type such as text/plain" }, 400);
      }
      contentType = contentTypeRaw.trim().toLowerCase();
    }
    const name = sanitizeUploadFilename(filename?.trim() || podPath);
    const tooLarge = (size?: number) => jsonOk(c, {
      error: `${size === undefined ? "File is too large" : `File is ${formatBytes(size)}`} — the per-file limit is 10 MB`,
    }, 413);
    const fetched = await getSessionBackend().fetchFile(sid, podPath);
    if (!fetched.ok) {
      switch (fetched.reason) {
        case "not-found":
        case "not-running": return jsonOk(c, { error: "Session not found or not running" }, 404);
        case "file-not-found": return jsonOk(c, { error: `No file at ${podPath} in this session${fetched.detail ? ` (${fetched.detail})` : ""}` }, 404);
        case "outside-home": return jsonOk(c, { error: OUTSIDE_SESSION_AREAS_ERROR }, 400);
        case "too-large": return tooLarge(fetched.size);
        case "unsupported": return jsonOk(c, { error: "This session's pod predates file publishing; end and revive the session to attach files" }, 409);
        case "unavailable": return jsonOk(c, { error: `Session runtime unavailable${fetched.detail ? `: ${fetched.detail}` : ""}` }, 503);
      }
    }
    const stored = await storeIssueAttachmentStream(id, name, fetched.stream, contentType ?? guessSessionFileContentType(name), `session:${sid}`);
    if (!stored.ok) {
      if (stored.reason === "too-large") return tooLarge();
      return jsonOk(c, { error: "Failed to store the attachment" }, 500);
    }
    const row = stored.row;
    const url = attachmentUrl(row);
    if (feedback === true) {
      await postAttachmentFeedbackComment({ record, id }, [row]);
    } else {
      await postSessionAudit(repo, id, `Session \`${sid}\` attached [${row.filename.replace(/[[\]]/g, "_")}](${url}).`);
    }
    log.info(`[server] Session ${sid}: attached ${row.filename} (${row.size} bytes) to ${id} as ${row.id}`);
    return jsonOk(c, {
      ok: true, id: row.id, filename: row.filename, size: row.size, content_type: row.content_type,
      url, issue_url: clawsIssues.dashboardIssueUrl(id), feedback: feedback === true,
    });
  });

  // The same start with no issue (`claws_start_session` without `issue_id`):
  // no issue to guard, so the caller must itself be a live session. Repos
  // default to none (a home-directory session); the brief carries only the
  // instructions; nothing is filed or commented on an issue.
  app.post("/api/sessions/:sid/start-session", sessionOwnTokenMiddleware, async (c) => {
    const sid = c.req.param("sid") ?? "";
    if (!/^[a-f0-9]+$/.test(sid)) return jsonOk(c, { error: "Session not found" }, 404);
    const live = await getSessionBackend().getLive(sid);
    if (!live.ok) return jsonOk(c, { error: "Session not found" }, 404);
    return startSpawnedSession(ctx, c, sid, null);
  });

  // The PR's repo and number travel in the body: a repo name contains a slash.
  app.post("/api/sessions/:sid/prs/clear-manual-action", sessionOwnTokenMiddleware, async (c) => {
    const sid = c.req.param("sid") ?? "";
    if (!/^[a-f0-9]+$/.test(sid)) return jsonOk(c, { error: "Session not found" }, 404);
    const live = await getSessionBackend().getLive(sid);
    if (!live.ok) return jsonOk(c, { error: "Session not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const parsed = RepoPrNumberSchema.safeParse(body);
    if (!parsed.success) return jsonOk(c, { error: "Missing repo or number" }, 400);
    const { repo, number } = parsed.data;
    if (!(await isConfiguredRepo(repo))) return jsonOk(c, { error: "Repository not configured" }, 403);
    const row = await getClawsPr(repo, number);
    if (!row) return jsonOk(c, { error: "No Claws record for this PR" }, 404);
    const reason = row.manualActionReason;
    if (reason === null) return jsonOk(c, { error: "No manual action is recorded on this PR" }, 409);
    // The hold is the row's reason alone; there is no forge label to remove.
    await clearPrHold(repo, number);
    await postSessionAudit(repo, number, `Session \`${sid}\` cleared the recorded manual action (was: \`${reason}\`) so the PR may auto-merge.`);
    return jsonOk(c, { ok: true, changed: true, reason });
  });
}
