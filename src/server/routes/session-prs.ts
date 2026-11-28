/** Session gate writes on PRs, Actions runs and session files, from `sessionPrGuard` on. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import { z } from "zod";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as config from "../../config.js";
import { listPRs, removeLabel, getPRState, type PR } from "../../github.js";
import { LABELS } from "../../config.js";
import { findLatestFailedRun, isRunOnCommit, rerunFailedJobsForSession, getPRMergeGate, postOperatorComment } from "../../github.js";
import { getIssueComments, commentOnIssue as ghCommentOnIssue } from "../../github.js";
import { isMergeApproved, isProblematic } from "../../pr-state.js";
import { hasCurrentDiagnosisReport, REDIAGNOSE_REQUEST_MARKER } from "../../agents/problematic-pr-diagnoser.js";
import { ForgejoActionNotFoundError } from "../../forgejo.js";
import { resetCIFixerBreakerGrants, getClawsPr, upsertClawsPr, recordSessionPrAction, listSessionFiles } from "../../db.js";
import * as log from "../../log.js";
import { attemptMerge } from "../../agents/auto-merger.js";
import * as clawsIssues from "../../claws-issues.js";
import { getSessionBackend } from "../../session-backend.js";
import { isEd25519PublicKey } from "../../ssh-cert.js";
import { cancelRuns, setWorkflowEnabled, type CancelRunEntry } from "../../forgejo-run-control.js";
import { sanitizeUploadFilename } from "../../session-uploads-core.js";
import { storeSessionFile, deleteSessionFile, describeSessionFile } from "../../session-files.js";
import { formatBytes } from "../../format.js";
import { ForgejoArtifactError, FORGEJO_ARTIFACT_MAX_BYTES, openForgejoRunArtifact, unknownArtifactMessage, type ForgejoRunArtifactDownload } from "../../forgejo-run-artifacts.js";
import { guardContent } from "../../prompt-guard.js";
import { ForgejoJobLogsError } from "../../forgejo-job-logs.js";
import { type Env, jsonOk } from "../http.js";
import { SESSION_SSH_SIGN_MIN_INTERVAL_MS, sessionOwnTokenMiddleware, sessionSshSignedAt } from "../auth.js";
import { FORGEJO_MERGE_HINT_CODES, OUTSIDE_SESSION_AREAS_ERROR, RepoPrNumberSchema, SESSION_PR_COMMENT_MAX_CHARS, SessionApproveMergeSchema, SessionCancelRunsSchema, SessionPrCommentSchema, SessionRerunSchema, SessionWorkflowToggleSchema, findConfiguredRepo, isConfiguredRepo, sessionApprover, writeMergeApproval } from "../shared.js";
import { runControlFailure } from "../approval-actions.js";
import { postSessionAudit } from "../session-actions.js";
import type { RouteContext } from "./context.js";

/** `POST /api/sessions/:sid/forgejo/artifacts`'s body. */
const SessionArtifactDownloadSchema = z.object({
  repo: z.string().min(1),
  run: z.number().int().nonnegative(),
  name: z.string().min(1).max(300),
});

export function registerSessionPrRoutes(app: Hono<Env>, ctx: RouteContext): void {
  /**
   * The checks the session PR recovery routes below share with
   * `clear-manual-action`: a live session, a `{repo, number}` body, a
   * configured repo. Answers the parsed body and the session's capabilities,
   * or the refusal to return.
   */
  async function sessionPrGuard<T extends z.ZodTypeAny>(c: Context<Env>, schema: T): Promise<Response | { sid: string; body: z.infer<T>; capabilities: string[] }> {
    const sid = c.req.param("sid") ?? "";
    if (!/^[a-f0-9]+$/.test(sid)) return jsonOk(c, { error: "Session not found" }, 404);
    const live = await getSessionBackend().getLive(sid);
    if (!live.ok) return jsonOk(c, { error: "Session not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return jsonOk(c, { error: "Missing repo or number" }, 400);
    const { repo } = parsed.data as { repo: string };
    if (!(await isConfiguredRepo(repo))) return jsonOk(c, { error: "Repository not configured" }, 403);
    return { sid, body: parsed.data, capabilities: live.session.capabilities };
  }

  /** The `session_pr_actions` row for a session PR action that already happened; a failure is logged, never fails it. */
  async function recordSessionPrActionLogged(entry: Parameters<typeof recordSessionPrAction>[0]): Promise<void> {
    try {
      await recordSessionPrAction(entry);
    } catch (err) {
      log.warn(`[server] ${entry.repo}#${entry.prNumber}: failed to record session ${entry.sessionId}'s ${entry.action}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // `claws_rerun_failed_ci`: re-run only the failed jobs of a CI run on the
  // PR's head commit — the named run, or the newest failed one — with no push.
  app.post("/api/sessions/:sid/prs/rerun-failed", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionPrGuard(c, SessionRerunSchema);
    if (guard instanceof Response) return guard;
    const { sid, body: { repo, number, run: requested } } = guard;
    let headSha: string;
    try {
      const gate = await getPRMergeGate(repo, number);
      if (gate.state !== "OPEN") return jsonOk(c, { error: "The PR is not open" }, 404);
      headSha = gate.headSha;
    } catch (err) {
      return jsonOk(c, { error: `Could not read the PR: ${err instanceof Error ? err.message : String(err)}` }, 404);
    }
    let run: number;
    try {
      if (requested === undefined) {
        const latest = await findLatestFailedRun(repo, headSha);
        if (latest === null) return jsonOk(c, { error: "No failed run on the PR's head commit" }, 409);
        run = latest;
      } else {
        if (!(await isRunOnCommit(repo, requested, headSha))) {
          return jsonOk(c, { error: `Run ${requested} is not on the PR's head commit ${headSha.slice(0, 7)}; re-running it would not change the PR's checks` }, 409);
        }
        run = requested;
      }
    } catch (err) {
      return jsonOk(c, { error: `Could not list the PR's CI runs: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
    let result: { run: number; jobs: string[] };
    try {
      result = await rerunFailedJobsForSession(repo, run);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ForgejoActionNotFoundError) return jsonOk(c, { error: `Run ${run} not found` }, 404);
      if ((err as { status?: unknown } | null)?.status === 409) return jsonOk(c, { error: message }, 409);
      return jsonOk(c, { error: message }, 502);
    }
    const jobList = result.jobs.length > 0 ? ` (${result.jobs.map((j) => `\`${j}\``).join(", ")})` : "";
    await recordSessionPrActionLogged({ repo, prNumber: number, sessionId: sid, action: "rerun", detail: `run ${result.run}: ${result.jobs.join(", ")}` });
    await postSessionAudit(repo, number, `Session \`${sid}\` re-ran the failed jobs of run ${result.run}${jobList}.`);
    return jsonOk(c, { ok: true, run: result.run, jobs: result.jobs });
  });

  /**
   * The checks the session Actions-control routes share: a live session, a
   * JSON body `schema` parses, and a repo Claws manages. Answers the parsed
   * body, or the refusal to return.
   */
  async function sessionRepoGuard<T extends z.ZodTypeAny>(c: Context<Env>, schema: T): Promise<Response | { sid: string; body: z.infer<T> }> {
    const sid = c.req.param("sid") ?? "";
    if (!/^[a-f0-9]+$/.test(sid)) return jsonOk(c, { error: "Session not found" }, 404);
    const live = await getSessionBackend().getLive(sid);
    if (!live.ok) return jsonOk(c, { error: "Session not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return jsonOk(c, { error: `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` }, 400);
    const { repo } = parsed.data as { repo: string };
    if (!(await isConfiguredRepo(repo))) return jsonOk(c, { error: "Repository not configured" }, 403);
    return { sid, body: parsed.data };
  }

  // `claws_cancel_runs`: cancel Forgejo Actions runs by number or by filter
  // (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y). A PR-scoped cancel notes the cancelled
  // runs on each PR; a dry run writes nothing.
  app.post("/api/sessions/:sid/actions/cancel-runs", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionRepoGuard(c, SessionCancelRunsSchema);
    if (guard instanceof Response) return guard;
    const { sid, body } = guard;
    let result: Awaited<ReturnType<typeof cancelRuns>>;
    try {
      result = await cancelRuns(body.repo, {
        ...(body.runs !== undefined ? { runs: body.runs } : {}),
        ...(body.pr_numbers !== undefined ? { prNumbers: body.pr_numbers } : {}),
        ...(body.workflow !== undefined ? { workflow: body.workflow } : {}),
        ...(body.event !== undefined ? { event: body.event } : {}),
        ...(body.include_running !== undefined ? { includeRunning: body.include_running } : {}),
        ...(body.dry_run !== undefined ? { dryRun: body.dry_run } : {}),
      }, `session:${sid}`);
    } catch (err) {
      return runControlFailure(c, err);
    }
    if ("cancelled" in result && body.pr_numbers) {
      const byPr = new Map<number, CancelRunEntry[]>();
      for (const entry of result.cancelled) {
        if (entry.pr === undefined) continue;
        byPr.set(entry.pr, [...(byPr.get(entry.pr) ?? []), entry]);
      }
      for (const [pr, entries] of byPr) {
        const list = entries.map((e) => `${e.run} (\`${e.workflow}\`)`).join(", ");
        await postSessionAudit(body.repo, pr, `Session \`${sid}\` cancelled CI run${entries.length === 1 ? "" : "s"} ${list}. \`claws_rerun_failed_ci\` re-runs cancelled jobs.`);
      }
    }
    return jsonOk(c, { ok: true, ...result });
  });

  // `claws_set_workflow_enabled`: disable or enable one Forgejo Actions
  // workflow (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y).
  app.post("/api/sessions/:sid/actions/workflow", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionRepoGuard(c, SessionWorkflowToggleSchema);
    if (guard instanceof Response) return guard;
    const { sid, body: { repo, workflow, enabled } } = guard;
    try {
      return jsonOk(c, { ok: true, ...(await setWorkflowEnabled(repo, workflow, enabled, `session:${sid}`)) });
    } catch (err) {
      return runControlFailure(c, err);
    }
  });

  // `claws_unmark_problematic`: the `/queue/unmark-problematic` button for a
  // session, refused unless the PR's row says it is Problematic.
  app.post("/api/sessions/:sid/prs/unmark-problematic", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionPrGuard(c, RepoPrNumberSchema);
    if (guard instanceof Response) return guard;
    const { sid, body: { repo, number } } = guard;
    const row = await getClawsPr(repo, number);
    if (!row) return jsonOk(c, { error: "No Claws record for this PR" }, 404);
    if (!isProblematic(row)) return jsonOk(c, { error: `The PR is not ${LABELS.problematic}` }, 409);
    if (!(await removeLabel(repo, number, LABELS.problematic))) {
      return jsonOk(c, { error: `Failed to remove the ${LABELS.problematic} label` }, 500);
    }
    // As the dashboard route: without the floor advance, the attempts still in
    // the 24h window re-trip the breaker on the very next sweep.
    await resetCIFixerBreakerGrants(repo, number);
    await recordSessionPrActionLogged({ repo, prNumber: number, sessionId: sid, action: "unmark-problematic" });
    await postSessionAudit(repo, number, `Session \`${sid}\` unmarked this PR ${LABELS.problematic} and reset its CI-fix budget, returning it to the normal CI-fix and review flow.`);
    return jsonOk(c, { ok: true, changed: true });
  });

  // `claws_retry_problematic_diagnosis`: post the rediagnosis marker, after
  // which the diagnoser no longer counts its earlier report as current.
  app.post("/api/sessions/:sid/prs/rediagnose", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionPrGuard(c, RepoPrNumberSchema);
    if (guard instanceof Response) return guard;
    const { sid, body: { repo, number } } = guard;
    const row = await getClawsPr(repo, number);
    if (!row) return jsonOk(c, { error: "No Claws record for this PR" }, 404);
    if (!isProblematic(row)) return jsonOk(c, { error: `The PR is not ${LABELS.problematic}` }, 409);
    try {
      if (!hasCurrentDiagnosisReport(await getIssueComments(repo, number))) {
        return jsonOk(c, { error: "No diagnosis report to retry" }, 409);
      }
      // The marker comment is the audit comment: Claws-marked by commentOnIssue's footer.
      await ghCommentOnIssue(repo, number, `${REDIAGNOSE_REQUEST_MARKER}\n\nSession \`${sid}\` asked Claws to re-diagnose this ${LABELS.problematic} PR; the Problematic PR Diagnoser runs again on its next pass.`);
    } catch (err) {
      return jsonOk(c, { error: `Failed to request a rediagnosis: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    await recordSessionPrActionLogged({ repo, prNumber: number, sessionId: sid, action: "rediagnose" });
    return jsonOk(c, { ok: true, changed: true });
  });

  // `claws_comment_on_pr`: operator feedback posted with no Claws footer and
  // its id recorded as `feedback`, which is what makes the review readers take
  // a bot-authored comment as human (forgejo.ts drops every other footer-less
  // comment by Claws' own login, #3225).
  app.post("/api/sessions/:sid/prs/comment", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionPrGuard(c, SessionPrCommentSchema);
    if (guard instanceof Response) return guard;
    const { sid, body: { repo, number, body } } = guard;
    if (!body.trim()) return jsonOk(c, { error: "The comment body is empty" }, 400);
    if (body.length > SESSION_PR_COMMENT_MAX_CHARS) {
      return jsonOk(c, { error: `The comment body is over ${SESSION_PR_COMMENT_MAX_CHARS} characters` }, 400);
    }
    try {
      const gate = await getPRMergeGate(repo, number);
      if (gate.state !== "OPEN") return jsonOk(c, { error: "The PR is not open" }, 404);
    } catch (err) {
      return jsonOk(c, { error: `Could not read the PR: ${err instanceof Error ? err.message : String(err)}` }, 404);
    }
    let commentId: string;
    try {
      commentId = await postOperatorComment(repo, number, `**Operator feedback via Claws session \`${sid}\`:**\n\n${body}`);
    } catch (err) {
      return jsonOk(c, { error: `Failed to post the comment: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
    // Not `recordSessionPrActionLogged`: without the row the comment reads as
    // Claws output, so a failed write must reach the session.
    try {
      await recordSessionPrAction({ repo, prNumber: number, sessionId: sid, action: "feedback", commentId });
    } catch (err) {
      return jsonOk(c, { error: `Posted comment ${commentId} but failed to record it as session feedback, so Claws will not read it as human: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    return jsonOk(c, { ok: true, commentId });
  });

  /**
   * The merge half of `claws_merge_pr` and `claws_approve_pr_merge`, for a PR
   * whose merge is approved: the auto-merger's own gates, then the merge.
   * Answers the merge (or that the sweep already merged it), or the refusal
   * with its skip code and the HTTP status to return it with.
   */
  async function mergeApprovedPrNow(
    sid: string,
    repo: string,
    number: number,
    opts: { notify?: boolean } = {},
  ): Promise<{ merged: boolean; note?: string } | { refusal: string; code?: string; status: ContentfulStatusCode }> {
    const repoObj = await findConfiguredRepo(repo);
    if (!repoObj) return { refusal: "Repository not configured", status: 403 };
    const alreadyMerged = async (): Promise<boolean> => (await getPRState(repo, number).catch(() => null)) === "MERGED";
    const pr = (await listPRs(repoObj.fullName)).find((p) => p.number === number);
    if (!pr) {
      if (await alreadyMerged()) return { merged: false, note: "already merged" };
      return { refusal: "PR is not open", status: 409 };
    }
    let result: Awaited<ReturnType<typeof attemptMerge>>;
    try {
      result = await attemptMerge(repoObj, pr, {
        mergedBy: `session:${sid}`,
        ...(opts.notify === false ? { notify: false } : {}),
      });
    } catch (err) {
      if (await alreadyMerged()) return { merged: false, note: "already merged" };
      return { refusal: `Merge failed: ${err instanceof Error ? err.message : String(err)}`, status: 502 };
    }
    if (!result.merged) {
      // The auto-merger's sweep may have merged it first.
      if ((result.code === "closed" || result.code === "head-moved") && await alreadyMerged()) {
        return { merged: false, note: "already merged" };
      }
      return { refusal: result.message, code: result.code, status: 409 };
    }
    return { merged: true };
  }

  /** The pointer a session's CI/review merge refusal carries to a Forgejo UI
   *  merge by the operator; text only, the gates are unchanged. "" for any other code. */
  function forgejoMergeHint(code: string | undefined): string {
    if (!code || !FORGEJO_MERGE_HINT_CODES.has(code)) return "";
    return " The operator can merge it in the Forgejo UI to bypass this gate; Claws picks that merge up like any other.";
  }

  // `claws_merge_pr`: merge a PR whose merge is already approved now, through
  // the auto-merger's own gates, instead of waiting for its next sweep
  // (#clw_01M4XFRSGNP87QVW0N1W5KN0V4). Never records an approval itself.
  app.post("/api/sessions/:sid/prs/merge", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionPrGuard(c, RepoPrNumberSchema);
    if (guard instanceof Response) return guard;
    const { sid, body: { repo, number } } = guard;
    const row = await getClawsPr(repo, number);
    if (!row) return jsonOk(c, { error: "No Claws record for this PR" }, 404);
    if (!isMergeApproved(row)) {
      return jsonOk(c, { error: "The merge is not approved. Ask the operator; if they approve it, record the approval first (claws_set_issue_approval through merge on the native issue) and call claws_merge_pr again. If the operator told you to merge this one PR only, call claws_approve_pr_merge instead", code: "not-approved" }, 409);
    }
    const outcome = await mergeApprovedPrNow(sid, repo, number);
    if ("refusal" in outcome) {
      return jsonOk(c, { error: `${outcome.refusal}${forgejoMergeHint(outcome.code)}`, ...(outcome.code ? { code: outcome.code } : {}) }, outcome.status);
    }
    if (!outcome.merged) return jsonOk(c, { ok: true, merged: false, note: outcome.note });
    await recordSessionPrActionLogged({ repo, prNumber: number, sessionId: sid, action: "merge", detail: `approved by ${row.mergeApprovedBy}` });
    await postSessionAudit(repo, number, `Session \`${sid}\` merged this PR directly (merge approved by ${row.mergeApprovedBy}).`);
    return jsonOk(c, { ok: true, merged: true });
  });

  // `claws_approve_pr_merge`: at the operator's direction, approve the merge of
  // this one PR — on its `claws_prs` row only, never the issue's stored
  // approval, so the issue's other PRs stay unapproved — and merge it through the
  // same gates as `claws_merge_pr` (#clw_01M5022YK7Z2V63775Y92B59P3). Without
  // `queue`, a refusal withdraws the approval this call wrote; with it, the
  // approval stays and the auto-merger's sweep merges the PR once it is ready.
  app.post("/api/sessions/:sid/prs/approve-merge", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionPrGuard(c, SessionApproveMergeSchema);
    if (guard instanceof Response) return guard;
    const { sid, body: { repo, number, queue } } = guard;
    if ((await getPRState(repo, number).catch(() => null)) !== "OPEN") return jsonOk(c, { error: "PR is not open" }, 409);
    const approver = sessionApprover(sid);
    let writtenAt: string | null;
    try {
      writtenAt = await writeMergeApproval(repo, number, approver, { keepExisting: true });
    } catch (err) {
      return jsonOk(c, { error: `Failed to record the merge approval: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    const outcome = await mergeApprovedPrNow(sid, repo, number, queue ? {} : { notify: false });
    if (!("refusal" in outcome)) {
      if (!outcome.merged) return jsonOk(c, { ok: true, merged: false, note: outcome.note });
      await recordSessionPrActionLogged({ repo, prNumber: number, sessionId: sid, action: "approve-merge", detail: "merged" });
      await postSessionAudit(repo, number, `Session \`${sid}\` approved the merge of this PR only (not the issue's other PRs) and merged it directly.`);
      return jsonOk(c, { ok: true, merged: true });
    }
    if (queue) {
      await recordSessionPrActionLogged({ repo, prNumber: number, sessionId: sid, action: "approve-merge", detail: "queued" });
      await postSessionAudit(repo, number, `Session \`${sid}\` approved the merge of this PR only (not the issue's other PRs); Claws merges it once it is ready.`);
      return jsonOk(c, { ok: true, merged: false, queued: true, reason: outcome.refusal, ...(outcome.code ? { code: outcome.code } : {}) });
    }
    if (writtenAt !== null) {
      // Withdraw only the approval this call wrote: one recorded since (an
      // operator's click) has another approver or timestamp and is kept.
      const sqlTime = (iso: string) => iso.slice(0, 19).replace("T", " ");
      try {
        const row = await getClawsPr(repo, number);
        if (row?.mergeApprovedBy === approver && row.mergeApprovedAt !== null && sqlTime(row.mergeApprovedAt) === sqlTime(writtenAt)) {
          await upsertClawsPr(repo, number, { mergeApprovedBy: null, mergeApprovedAt: null });
        }
      } catch (err) {
        log.warn(`[server] ${repo}#${number}: failed to withdraw session ${sid}'s refused merge approval: ${err instanceof Error ? err.message : String(err)}`);
        return jsonOk(c, { error: `${outcome.refusal} (and withdrawing the approval failed, so it is still recorded)${forgejoMergeHint(outcome.code)}`, ...(outcome.code ? { code: outcome.code } : {}) }, outcome.status);
      }
    }
    return jsonOk(c, { error: `${outcome.refusal}${forgejoMergeHint(outcome.code)}`, ...(outcome.code ? { code: outcome.code } : {}) }, outcome.status);
  });

  /**
   * `claws_delete_published_file`: remove one file this session published, by
   * `id` or by exact (case-insensitive) `name` — exactly one of them. A name
   * matches that file only, never its `-2` siblings. Only this session's files
   * can match: the row, not the request, decides ownership.
   */
  app.delete("/api/sessions/:sid/files", sessionOwnTokenMiddleware, async (c) => {
    const sid = c.req.param("sid") ?? "";
    if (!/^[a-f0-9]+$/.test(sid)) return jsonOk(c, { error: "Session not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { id, name } = (body ?? {}) as { id?: unknown; name?: unknown };
    if (id !== undefined && typeof id !== "string") return jsonOk(c, { error: "id must be a string" }, 400);
    if (name !== undefined && typeof name !== "string") return jsonOk(c, { error: "name must be a string" }, 400);
    const idArg = id?.trim() ?? "";
    const nameArg = name?.trim() ?? "";
    if (!idArg === !nameArg) return jsonOk(c, { error: "Give exactly one of id or name" }, 400);
    const files = await listSessionFiles(sid);
    const match = idArg
      ? files.find((f) => f.id === idArg)
      : files.find((f) => f.filename.toLowerCase() === nameArg.toLowerCase());
    const notFound = () => jsonOk(c, {
      error: `No published file ${idArg ? `with id ${idArg}` : `named ${nameArg}`} in this session`,
      published: files.map((f) => f.filename),
    }, 404);
    if (!match) return notFound();
    const result = await deleteSessionFile(sid, match.id);
    if (!result.ok) return notFound();
    log.info(`[server] Session ${sid}: session deleted published file ${result.row.filename} (${result.row.id})`);
    return jsonOk(c, { ok: true, id: result.row.id, name: result.row.filename });
  });

  /**
   * Sign the session pod's own SSH key for one granted host
   * (#clw_01M78063FGCMSJVSGS7ZDV1Z9C). Called by the pod's ssh refresh helper
   * from the session's ssh config when the host's certificate is missing or
   * near expiry, so a session signs only for hosts it is using. Authenticated
   * by the session's own MCP token; the backend re-checks the database row
   * holds `ssh:<alias>`, so a revoked host is never re-signed. At most one
   * successful signing per session and host per `SESSION_SSH_SIGN_MIN_INTERVAL_MS`.
   */
  app.post("/api/sessions/:sid/ssh/:alias/sign", sessionOwnTokenMiddleware, async (c) => {
    const sid = c.req.param("sid") ?? "";
    const alias = c.req.param("alias") ?? "";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) return jsonOk(c, { error: "Invalid host alias" }, 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const publicKey = (body ?? {}) as { publicKey?: unknown };
    if (typeof publicKey.publicKey !== "string" || publicKey.publicKey.length > 1024 || !isEd25519PublicKey(publicKey.publicKey)) {
      return jsonOk(c, { error: "publicKey must be one ssh-ed25519 public key" }, 400);
    }
    const refuse = (status: 403 | 429 | 503, reason: string, error: string) => {
      log.warn("Refused session SSH signing", { component: "sessions", session: sid, alias, reason });
      return jsonOk(c, { error }, status);
    };
    const nowMs = Date.now();
    for (const [key, at] of sessionSshSignedAt) {
      if (nowMs - at >= SESSION_SSH_SIGN_MIN_INTERVAL_MS) sessionSshSignedAt.delete(key);
    }
    const rateKey = `${sid}:${alias}`;
    const last = sessionSshSignedAt.get(rateKey);
    if (last !== undefined) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((last + SESSION_SSH_SIGN_MIN_INTERVAL_MS - nowMs) / 1000))));
      return refuse(429, "rate-limited", "This host's certificate was signed less than a minute ago");
    }
    const backend = getSessionBackend();
    if (!backend.signSessionSshKey) return refuse(503, "unsupported", "This session backend cannot sign SSH keys");
    const result = await backend.signSessionSshKey(sid, alias, publicKey.publicKey.trim());
    if (!result.ok) {
      if (result.reason === "not-granted") return refuse(403, result.reason, `This session does not hold ssh:${alias}`);
      return refuse(503, result.reason, result.reason === "ca-failed" ? "The SSH CA could not sign the key — try again shortly" : "Session database unavailable");
    }
    sessionSshSignedAt.set(rateKey, Date.now());
    return jsonOk(c, { certificate: result.certificate });
  });

  /**
   * `claws_publish_file`: pull one file out of this session's pod and keep it
   * on the Claws side for the user to download from the session page. Session
   * only, like the gate writes above: a headless agent has no session page.
   */
  app.post("/api/sessions/:sid/files", sessionOwnTokenMiddleware, async (c) => {
    const sid = c.req.param("sid") ?? "";
    if (!/^[a-f0-9]+$/.test(sid)) return jsonOk(c, { error: "Session not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { path: podPath, name } = (body ?? {}) as { path?: unknown; name?: unknown };
    if (typeof podPath !== "string" || !podPath.trim()) return jsonOk(c, { error: "path is required" }, 400);
    if (name !== undefined && typeof name !== "string") return jsonOk(c, { error: "name must be a string" }, 400);
    const displayName = sanitizeUploadFilename(name?.trim() || podPath);
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
        case "unsupported": return jsonOk(c, { error: "This session's pod predates file publishing; end and revive the session to publish files" }, 409);
        case "unavailable": return jsonOk(c, { error: `Session runtime unavailable${fetched.detail ? `: ${fetched.detail}` : ""}` }, 503);
      }
    }
    const stored = await storeSessionFile(sid, displayName, fetched.stream);
    if (!stored.ok) {
      if (stored.reason === "too-large") return tooLarge();
      return jsonOk(c, { error: "Failed to store the file" }, 500);
    }
    const view = describeSessionFile(stored.row);
    log.info(`[server] Session ${sid}: published ${view.name} (${view.size} bytes) as ${view.id}`);
    const renamed = view.name !== stored.requestedName;
    if (renamed) log.info(`[server] Session ${sid}: ${stored.requestedName} was already published, stored as ${view.name}`);
    return jsonOk(c, {
      ok: true, id: view.id, name: view.name, size: view.size, url: view.url, page: clawsIssues.dashboardSessionUrl(sid),
      ...(renamed ? {
        renamed: true,
        requested_name: stored.requestedName,
        note: `A file named ${stored.requestedName} was already published in this session, so this one was published as ${view.name}. Give each revision its own descriptive name.`,
      } : {}),
    });
  });

  /**
   * `claws_forgejo_download_artifact`: stream one Forgejo Actions run artifact's
   * zip, read with the bot token (forgejo patch 0009), into this session pod's
   * uploads directory through the pod's existing `POST /uploads` route
   * (#clw_01M8ET462MDX4K6FTQY252XHNG). Session only: it writes into the pod.
   * A zip past `FORGEJO_ARTIFACT_MAX_BYTES` aborts the upload, so the pod
   * unlinks its partial file and nothing is delivered.
   */
  app.post("/api/sessions/:sid/forgejo/artifacts", sessionOwnTokenMiddleware, async (c) => {
    const sid = c.req.param("sid") ?? "";
    if (!/^[a-f0-9]+$/.test(sid)) return jsonOk(c, { error: "Session not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const parsed = SessionArtifactDownloadSchema.safeParse(body);
    if (!parsed.success) return jsonOk(c, { error: "Give repo, run (the run number in /actions/runs/<n>) and name (the artifact's exact name)" }, 400);
    const { repo, run, name } = parsed.data;
    const live = await getSessionBackend().getLive(sid);
    if (!live.ok) return jsonOk(c, { error: "Session not found" }, 404);
    const refuse = (status: ContentfulStatusCode, error: string) => {
      log.warn("Session artifact download failed", { component: "sessions", session: sid, repo, run, artifact: name, status, reason: error });
      return jsonOk(c, { error }, status);
    };
    let download: ForgejoRunArtifactDownload;
    try {
      download = await openForgejoRunArtifact({ repo, run, name });
    } catch (err) {
      if (err instanceof ForgejoArtifactError && err.unknown) {
        // The run's artifact names are CI output: guard them, as the list route does.
        const names = await Promise.all(err.unknown.names.map((n) => guardContent(n, { repo, source: `ci-artifact-name (run ${run})`, itemNumber: 0 })));
        return refuse(err.status, unknownArtifactMessage({ ...err.unknown, names }));
      }
      if (err instanceof ForgejoJobLogsError || err instanceof ForgejoArtifactError) return refuse(err.status, err.message);
      return refuse(502, err instanceof Error ? err.message : String(err));
    }
    const saved = await getSessionBackend().saveUploadStream(sid, `${name}.zip`, download.stream);
    if (download.overCap) {
      download.stream.destroy();
      return refuse(413, `artifact ${download.artifact.name}'s zip passed the ${formatBytes(FORGEJO_ARTIFACT_MAX_BYTES)} download cap mid-stream; nothing was delivered`);
    }
    if (!saved.ok) {
      download.stream.destroy();
      switch (saved.reason) {
        case "not-found":
        case "not-running": return refuse(404, "Session not found or not running");
        case "too-large": return refuse(413, "The session pod refused the artifact as too large");
        case "write-failed": return refuse(500, `The session pod could not store the artifact${saved.detail ? `: ${saved.detail}` : ""}`);
        case "unavailable": return refuse(503, `Session runtime unavailable${saved.detail ? `: ${saved.detail}` : ""}`);
      }
    }
    const digest = download.digest();
    if (!digest) return refuse(502, `The Forgejo download of artifact ${download.artifact.name} ended early; nothing usable was delivered`);
    log.info("Delivered Forgejo artifact to session", {
      component: "sessions", session: sid, repo: download.repo, run: download.run, artifact: download.artifact.name, bytes: digest.size, path: saved.path,
    });
    return jsonOk(c, { ok: true, path: saved.path, name: download.artifact.name, size: digest.size, sha256: digest.sha256, repo: download.repo, run: download.run });
  });
}
