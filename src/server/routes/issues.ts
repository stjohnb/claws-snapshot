/** Claws-native issue pages and writes, and native issue attachments. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import { Readable } from "node:stream";
import { bodyLimit } from "hono/body-limit";
import * as config from "../../config.js";
import { listRepos, addLabel, removeLabel } from "../../github.js";
import { editIssue, editIssueTitle, closeIssue } from "../../github.js";
import * as planParser from "../../plan-parser.js";
import { issuesAwaitingOperator } from "../../awaiting-operator.js";
import { loadManualActionWarnings, manualWarningRow, resolveTrackerId } from "../../planned-prs.js";
import { getImportedIssueByNative, listClawsIssueAttachments, listClawsPrsForIssue, getIssuePlannedPRs, getIssueBlockedReasons, setClawsIssueBacklogUntil, getIssueReapproval } from "../../db.js";
import * as log from "../../log.js";
import { buildIssuePage, buildNewIssuePage, offeredLabels, type IssuePageView, type IssuePullRequestView, type PlanStepView, type PlanView, type RequirementsView } from "../../pages/issue.js";
import { liftOverlapHold, planStepFootprints } from "../../overlap-gate.js";
import { describeModelPlan, parseModelPlanForm, setExplicitPlan } from "../../model-plan.js";
import { parseBacklogUntil } from "../../backlog-until.js";
import { BACKLOG_DESTINATION } from "../../issue-board.js";
import { loadIssueFlight } from "../../issue-flight.js";
import * as clawsIssues from "../../claws-issues.js";
import { currentIssueActor } from "../../issue-history-actor.js";
import { issuesOverlapHeld, issuesQueued } from "../../queued-issues.js";
import { loadOperatorAttentionCounts } from "../../operator-attention.js";
import * as issueLinks from "../../issue-links.js";
import { isClawsIssueId } from "../../issue-id.js";
import { isRequirementsComment } from "../../marker-text.js";
import { renderMarkdown, type IssueRefLinks } from "../../markdown.js";
import { resolveIssueRefLinks } from "../../issue-ref-links.js";
import { MAX_UPLOAD_BYTES, MAX_LARGE_UPLOAD_BYTES, type SaveUploadResult } from "../../session-uploads-core.js";
import { storeIssueAttachment, storeIssueAttachmentStream, readIssueAttachment, openIssueAttachment, deleteIssueAttachment, claimPendingAttachments, sweepPendingAttachments, attachmentUrl, parseAttachmentUrl, serveContentType, contentDisposition, isInlineImage, PENDING_URL_SEGMENT } from "../../issue-attachments.js";
import type { ClawsIssueAttachmentRow, ClawsIssueRecord } from "../../db.js";
import { type BoardRefusalIds, type Ctx, boardRefusal, describeUploadError, getTheme, htmlError, htmlOk, jsonOk, parseFormBody, parseFormBodyMulti, readTextBody, textPlain, uploadErrorResponse } from "../http.js";
import { authMiddleware, sessionSubject } from "../auth.js";
import { BoardOverlapStartSchema, COMMENT_FREE_STATUSES, type GateWriteResult, type NativeIssueRecord, OperatorStepDoneSchema, isConfiguredRepo, stepNoticeFromQuery } from "../shared.js";
import { loadNativeIssue, issueNotFound, eventRepo, setNativeColumn, nativeStatusRefusal, unblockNative, markOperatorStepDone, promoteNative, returnToPlannerOnFeedback, postAttachmentFeedbackComment } from "../issue-actions.js";
import { loadDestroyConsentView } from "../approval-actions.js";
import { postSessionAudit, startIssueSession } from "../session-actions.js";
import { Hono } from "hono";
import type { Env } from "../http.js";
import type { RouteContext } from "./context.js";

export function registerIssueRoutes(app: Hono<Env>, ctx: RouteContext): void {
  // ── Claws-native issue tracker (docs/issue-tracker.md) ──
  //
  // `/issues/new` is registered before `/issues/:id` so the literal path wins
  // over the parameter. Every mutation goes through the `github.ts` façade so a
  // native issue gets the same events and label semantics as a forge one —
  // except the comment form, which must post as the operator rather than as
  // Claws, or the refiner would read its own marker and skip the feedback.

  app.get("/issues/new", authMiddleware, async (c) => {
    const repos = await listRepos();
    return htmlOk(c, buildNewIssuePage(repos.map((r) => r.fullName), getTheme(c), await loadOperatorAttentionCounts(), c.req.query("repo"), {
      title: c.req.query("title"),
      body: c.req.query("body"),
    }));
  });

  // The New issue modal on /board and /issues posts here with
  // `Accept: application/json` and gets `{ ok, id, url }` or `{ error }`; the
  // no-JS form on /issues/new keeps the HTML error page and 303 redirect.
  app.post("/issues", authMiddleware, async (c) => {
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const fail = (status: 400 | 409, heading: string, message: string) => wantsJson
      ? jsonOk(c, { error: message }, status)
      : htmlError(c, status, heading, message, {
        actions: [{ href: "/issues/new", label: "← New issue" }],
      });
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    const title = (params["title"] ?? "").trim();
    if (!title) {
      return fail(400, "Cannot create issue", "A title is required.");
    }
    const known = new Set((await listRepos()).map((r) => r.fullName));
    const repos = parseFormBodyMulti(body, "repo").filter((r) => known.has(r));
    const modelPlan = parseModelPlanForm(params);
    const hasModelPlan = modelPlan.some((cell) => cell.provider || cell.tier);
    if (hasModelPlan && repos.length === 0) {
      return fail(409, "Model plan not saved", "The model plan is stored under the issue's primary repository, and this issue has none. Remove the model plan selections or pick a repo, then try again.");
    }
    // The form offers only Priority; any other hand-sent label is dropped.
    const labels = parseFormBodyMulti(body, "label").filter((l) => l === config.LABELS.priority);
    const id = await clawsIssues.createIssue({
      title,
      body: params["body"] ?? "",
      // Single-tenant dashboard behind OIDC: whoever is signed in is the owner.
      authorLogin: config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN,
      repos,
      labels,
      source: "dashboard",
      // A form-filed issue always gets a requirements record and waits for
      // the operator's review, whatever a hand-sent `autoPromote` says.
      requirementsStage: true,
      autoPromote: false,
    });
    if (hasModelPlan) await setExplicitPlan(clawsIssues.primaryRepo({ repos }), id, modelPlan);
    // Files uploaded on the form before the issue existed are pending; claim
    // them and point the body's links at their new home.
    const claimed = await claimPendingAttachments(parseFormBodyMulti(body, "attachment"), id);
    if (claimed.length > 0) {
      const original = params["body"] ?? "";
      let rewritten = original;
      for (const row of claimed) {
        rewritten = rewritten.split(`/issues/${PENDING_URL_SEGMENT}/attachments/${row.id}/`).join(`/issues/${id}/attachments/${row.id}/`);
      }
      if (rewritten !== original) await clawsIssues.editIssue(id, rewritten);
    }
    if (wantsJson) return jsonOk(c, { ok: true, id, url: `/issues/${id}` });
    return c.redirect(`/issues/${id}`, 303);
  });

  /**
   * Every PR associated with a native issue, in any stage, for the page's Pull
   * requests section. Best-effort like `loadIssueFlight`: a failed read is
   * logged and the section renders empty.
   */
  async function loadIssuePullRequests(issueId: string): Promise<IssuePullRequestView[]> {
    try {
      const [rows, planned] = await Promise.all([listClawsPrsForIssue(issueId), getIssuePlannedPRs(issueId)]);
      // Only an open PR can still be merged, so only it carries the warning.
      const warnings = await loadManualActionWarnings(rows
        .filter((row) => row.stage !== "merged" && row.stage !== "closed")
        .map(manualWarningRow));
      return rows.map((row) => ({
        repo: row.repo,
        number: row.prNumber,
        title: row.title
          ?? planned.find((p) => p.repo === row.repo && p.prNumber === row.prNumber)?.title
          ?? `PR #${row.prNumber}`,
        url: config.prUrl(row.repo, row.prNumber),
        state: row.stage === "merged" ? "merged" : row.stage === "closed" ? "closed" : "open",
        stage: row.stage,
        needsHumanReview: row.needsHumanReview,
        manualWarning: warnings.get(`${row.repo}#${row.prNumber}`),
      }));
    } catch (err) {
      log.warn(`[server] could not load pull requests for issue ${issueId}: ${err}`);
      return [];
    }
  }

  /**
   * The stored plan's PR steps for the page's Plan steps section: declared
   * paths, the PR's changed-file count, each overlap with other in-flight
   * work (#clw_01M7WDMJ9GCF6MCZ0BPKN3333S) and its expected rebases. Best-effort: a failed read is
   * logged and the section is omitted.
   */
  async function loadPlanSteps(issueId: string): Promise<PlanStepView[]> {
    try {
      return (await planStepFootprints(issueId)).map((step) => ({
        position: step.position,
        repo: step.repo,
        title: step.title,
        paths: step.paths,
        prNumber: step.prNumber,
        changedFiles: step.changedFiles,
        overlaps: [
          ...step.heldBy.map((o) => ({ direction: "held-by" as const, issueId: o.issueId, position: o.position, repo: step.repo, prNumber: o.prNumber, running: o.running, files: o.shared })),
          ...step.holds.map((o) => ({ direction: "holds" as const, issueId: o.issueId, position: o.position, repo: step.repo, prNumber: o.prNumber, running: o.running, files: o.shared })),
        ],
        expectedRebase: step.expectedRebase,
      }));
    } catch (err) {
      log.warn(`[server] could not load plan steps for issue ${issueId}: ${err}`);
      return [];
    }
  }

  /**
   * The plan's operator step (its `manual` entry) for the Pull requests
   * section, pending while the issue is open — a `claws-phase-done:` claim
   * closes it on the next dispatcher tick. Undefined when the plan has none.
   */
  async function loadOperatorStep(record: ClawsIssueRecord, latestPlanBody: string | undefined): Promise<{ title: string; pending: boolean; awaiting: boolean; position: number; text: string } | undefined> {
    try {
      const manual = (await getIssuePlannedPRs(record.id)).find((e) => e.kind === "manual");
      if (!manual) return undefined;
      const section = latestPlanBody ? planParser.findManualActionsSection(latestPlanBody) : null;
      // The button shows only once the step is reachable (every earlier PR step merged).
      const awaiting = (await issuesAwaitingOperator([record.id])).get(record.id)?.position === manual.position;
      return { title: manual.title, pending: record.state === "open", awaiting, position: manual.position, text: section?.body ?? "" };
    } catch (err) {
      log.warn(`[server] could not load the operator step for issue ${record.id}: ${err}`);
      return undefined;
    }
  }

  app.get("/issues/:id", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c);
    if (!loaded?.record) return issueNotFound(c);
    const { record } = loaded;
    // A shadow stands for an issue that is still live on its forge, and the
    // forge copy is the operator-facing one — it has the comments, and it is
    // where a reply goes. Redirect rather than render a comment-less mirror
    // that reads like the real issue (#3246).
    if (record.kind === "shadow") {
      const link = await getImportedIssueByNative(record.id);
      if (!link) return issueNotFound(c);
      return c.redirect(config.forgeIssueUrl(link.repo, link.forgeNumber), 302);
    }
    const comments = await clawsIssues.listCommentDetails(record.id, { renderHtml: false });
    const planRecords = (await clawsIssues.listPlans(record.id)).map((p) => ({ ...p, sections: planParser.parsePlanSections(p.body) }));
    const requirementRecords = await clawsIssues.listRequirements(record.id);
    // Bare issue and PR references in any text on the page link to the items
    // Claws knows; the stored text is untouched.
    const refs = await resolveIssueRefLinks([
      record.body,
      ...comments.map((cm) => cm.body),
      ...planRecords.flatMap((p) => p.sections.map((s) => s.markdown)),
      ...requirementRecords.flatMap((r) => [r.context, r.requirement, ...r.acceptanceCriteria, ...r.outOfScope]),
    ], record.repos).catch((err): IssueRefLinks => {
      // Linking is decoration; a lookup failure must not fail the page.
      log.warn(`Issue ref link lookup failed for ${record.id}: ${err instanceof Error ? err.message : String(err)}`);
      return { hrefFor: () => undefined };
    });
    // The plan comment is shown under Current plan, not in Comments; every
    // other comment, Claws' replies included, stays in the discussion.
    const plans = planRecords.map((p): PlanView & { commentId: string | null } => ({
      version: p.version,
      createdAt: p.createdAt,
      attribution: planParser.extractModelsAttribution(p.body),
      sections: p.sections.map((s) => ({ title: s.title, html: renderMarkdown(s.markdown, { refs }) })),
      commentId: p.commentId,
    }));
    const latestPlan = plans.at(-1) ?? null;
    // Likewise the requirements record comment, shown under Requirements.
    const requirements = requirementRecords.map((r): RequirementsView & { commentId: string | null } => ({
      version: r.version,
      createdAt: r.createdAt,
      title: r.title,
      kind: r.kind,
      sections: [
        { title: "Context", html: renderMarkdown(r.context, { refs }) },
        { title: "Requirement", html: renderMarkdown(r.requirement, { refs }) },
        { title: "Acceptance criteria", html: renderMarkdown(r.acceptanceCriteria.map((item) => `- ${item}`).join("\n"), { refs }) },
        { title: "Out of scope", html: r.outOfScope.length > 0 ? renderMarkdown(r.outOfScope.map((item) => `- ${item}`).join("\n"), { refs }) : `<p class="queue-empty">None</p>` },
      ],
      commentId: r.commentId,
    }));
    const latestRequirements = requirements.at(-1) ?? null;
    const hiddenCommentIds = new Set([latestPlan?.commentId, latestRequirements?.commentId].filter((id): id is string => id != null));
    const autoPromotion = clawsIssues.autoPromoteDecision(record, latestRequirements?.kind);
    const view: IssuePageView = {
      id: record.id,
      title: record.title,
      body: record.body,
      bodyHtml: renderMarkdown(record.body, { refs, collapseImages: true }),
      authorLogin: record.author_login,
      state: record.state,
      stateReason: record.state_reason,
      createdAt: clawsIssues.toIso(record.created_at),
      updatedAt: clawsIssues.toIso(record.updated_at),
      repos: record.repos,
      primaryRepo: clawsIssues.primaryRepo(record),
      ...(record.primary_repo ? { pinnedPrimaryRepo: record.primary_repo } : {}),
      labels: record.labels,
      comments: comments
        .filter((cm) => !hiddenCommentIds.has(String(cm.id)) && !isRequirementsComment(cm.body))
        .map((cm) => ({ id: String(cm.id), login: cm.login, body: cm.body, bodyHtml: renderMarkdown(cm.body, { refs }), createdAt: cm.createdAt })),
      plan: latestPlan,
      previousPlans: plans.slice(0, -1),
      requirements: latestRequirements,
      previousRequirements: requirements.slice(0, -1),
      requirementsApproval: record.requirements_approved_by && record.requirements_approved_at
        ? {
            version: record.approved_requirements_version == null ? null : Number(record.approved_requirements_version),
            by: record.requirements_approved_by,
            at: clawsIssues.toIso(record.requirements_approved_at),
          }
        : null,
      requirementsApproved: record.requirements_approved_at != null,
      lifecycle: record.lifecycle,
      approvedThrough: record.approved_through ?? "none",
      // Drafting or Requirements review, the same rule as the board's.
      // A held stage-off issue with no version waits there on its own text.
      requirementsReview: latestRequirements !== null
        ? !await clawsIssues.hasRequirementsFeedback(comments, latestRequirements.createdAt)
        : clawsIssues.heldWithoutWriter(record),
      source: record.source,
      requirementsStage: clawsIssues.requirementsStageApplies(record),
      autoPromotes: autoPromotion.promotes,
      autoPromoteReason: autoPromotion.reason === "bug" || autoPromotion.reason === "alert" ? autoPromotion.reason : undefined,
      filedTitle: record.filed_title,
      allRepos: (await listRepos()).map((r) => r.fullName),
      // Resolved against the issue's primary repo; with none there is no row
      // to read, and the page renders the grid read-only.
      modelPlan: await describeModelPlan(clawsIssues.primaryRepo(record) || null, record.id, record.labels.map((name) => ({ name }))),
      attachments: (await listClawsIssueAttachments(record.id)).map((row) => ({
        id: row.id,
        name: row.filename,
        url: attachmentUrl(row),
        size: row.size,
        contentType: row.content_type,
        isImage: isInlineImage(row),
        uploader: row.uploader_login,
      })),
      links: await issueLinks.listLinks("", record.id),
      history: await clawsIssues.listHistory(record.id),
      flight: await loadIssueFlight(clawsIssues.primaryRepo(record), record.id),
      pullRequests: await loadIssuePullRequests(record.id),
      planSteps: await loadPlanSteps(record.id),
      operatorStep: await loadOperatorStep(record, planRecords.at(-1)?.body),
      stepNotice: stepNoticeFromQuery(c.req.query("step-done"), c.req.query("step-already")),
      destroyConsent: await loadDestroyConsentView(record.id, record.approved_through ?? "none"),
      blockedReason: await getIssueBlockedReasons([record.id])
        .then((reasons) => reasons.get(record.id) ?? null)
        .catch((err) => { log.warn(`[server] could not read the blocked reason of issue ${record.id}: ${err}`); return null; }),
      queuedReason: record.lifecycle === "blocked" ? (await issuesQueued([record.id])).get(record.id) ?? null : null,
      overlapHold: (await issuesOverlapHeld([record])).get(record.id) ?? null,
      backlogUntil: record.lifecycle === "backlog" ? record.backlog_until ?? null : null,
      reapprovalPending: await getIssueReapproval(record.id)
        .then((row) => (row && row.approvedAt === null ? { version: row.requirementsVersion } : null))
        .catch((err) => { log.warn(`[server] could not read the re-approval of issue ${record.id}: ${err}`); return null; }),
    };
    return htmlOk(c, buildIssuePage(view, getTheme(c), await loadOperatorAttentionCounts()));
  });

  // The issue page's combined comment + status box: `body` is the comment and
  // the optional `status` submit-button value applies a lifecycle move with it.
  // Only Approve plan (`approved`), its Merge partner (`approved-automerge`),
  // Send to backlog and Unblock may go without a comment; the comment is written first so a re-plan can read it.
  app.post("/issues/:id/comments", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const params = parseFormBody(await readTextBody(c));
    const body = (params["body"] ?? "").trim();
    const status = params["status"] ?? "";
    const back = { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] };
    if (status && !COMMENT_FREE_STATUSES.has(status) && !body) {
      return htmlError(c, 400, "Comment needed", "This status change needs a comment saying why.", back);
    }
    if (body) {
      const commentId = await clawsIssues.commentOnIssue(
        eventRepo(loaded.record),
        loaded.id,
        body,
        config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN,
      );
      if (commentId && !status) await returnToPlannerOnFeedback({ record: loaded.record, id: loaded.id }, body);
    }
    if (status) {
      const approvedBy = sessionSubject(c);
      const column = status === "approved-automerge" ? "approved" : status;
      // The date beside Send to backlog; empty sends it to the backlog undated.
      const until = column === BACKLOG_DESTINATION && params["backlog_until"] ? params["backlog_until"] : undefined;
      const result = status === "unblock"
        ? await unblockNative(loaded.record, loaded.id, approvedBy)
        : await applyColumnChange(loaded.record, loaded.id, column, status === "approved-automerge", approvedBy, until, column === "blocked" ? body : undefined);
      if (!result.ok) return htmlError(c, result.status, "Cannot move issue", result.error, back);
    }
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // The issue page's per-comment Delete (docs/issue-tracker.md#deleting-comments):
  // a soft delete recorded in History, never feedback, so nothing re-plans.
  app.post("/issues/:id/comments/:commentId/delete", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const commentRef = c.req.param("commentId") ?? "";
    try {
      await clawsIssues.deleteIssueComments(loaded.id, [commentRef], `operator:${currentIssueActor().name}`);
    } catch (err) {
      if (!(err instanceof clawsIssues.IssueCommentDeleteError)) throw err;
      const refused = err.reason === "refused";
      return htmlError(c, refused ? 409 : 404, refused ? "Comment not deleted" : "Comment not found", err.message, {
        actions: [{ href: `/issues/${loaded.id}`, label: "← Issue" }],
      });
    }
    return c.redirect(`/issues/${loaded.id}#comments`, 303);
  });

  app.post("/issues/:id/labels", authMiddleware, async (c) => {
    // The issue page's auto-saving forms ask for JSON; a plain form post (no
    // JS) still gets the redirect back to the page.
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return wantsJson ? jsonOk(c, { error: "Issue not found" }, 404) : issueNotFound(c);
    // Only labels the form itself offered are added or removed, so a label
    // applied by an agent but absent from LABEL_SPECS survives a "Save labels".
    // The state labels are not offered: they read off the `lifecycle` field,
    // and treating them as unticked would reset every issue to Drafting.
    // Claws Staging is opt-in only via the forge, so it isn't offered either —
    // must match the checkbox set rendered by offeredLabels() in pages/issue.ts.
    const offered = offeredLabels(Object.keys(config.LABEL_SPECS));
    const wanted = new Set(parseFormBodyMulti(await readTextBody(c), "label").filter((l) => offered.includes(l)));
    const repo = eventRepo(loaded.record);
    for (const label of wanted) {
      if (!loaded.record.labels.includes(label)) await addLabel(repo, loaded.id, label);
    }
    for (const label of loaded.record.labels) {
      if (offered.includes(label) && !wanted.has(label)) await removeLabel(repo, loaded.id, label);
    }
    if (wantsJson) return jsonOk(c, { ok: true });
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // The board card's Mark step done button.
  app.post("/board/operator-step-done", authMiddleware, async (c) => {
    const ids: BoardRefusalIds = {};
    const refuse = (body: { error: string } & Record<string, unknown>, status: number) => boardRefusal(c, "/board/operator-step-done", status, body, ids);
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return refuse({ error: "Malformed request body" }, 400);
    }
    const parsed = OperatorStepDoneSchema.safeParse(raw);
    if (!parsed.success) return refuse({ error: "Missing repo, ref or position" }, 400);
    const { repo, ref, position } = parsed.data;
    ids.repo = repo;
    ids.issue = String(ref);
    if (!(await isConfiguredRepo(repo))) return refuse({ error: "Repository not configured" }, 403);
    const id = isClawsIssueId(ref) ? ref : await resolveTrackerId(repo, ref);
    const record = id ? await clawsIssues.getIssue(id) : undefined;
    if (!id || !record || record.kind === "shadow") return refuse({ error: "No such issue" }, 404);
    if (record.repos.length > 0 && !record.repos.includes(repo) && eventRepo(record) !== repo) {
      return refuse({ error: "Repository not configured" }, 403);
    }
    const result = await markOperatorStepDone(record, id, position, { kind: "dashboard", who: sessionSubject(c) });
    if (!result.ok) return refuse({ error: result.error }, result.status);
    const after = await clawsIssues.getIssue(id).catch(() => undefined);
    return jsonOk(c, { result: "ok", ...(result.already ? { already: true } : {}), column: after?.lifecycle });
  });

  // The board card's Start anyway button (#clw_01M7WDMJ9GCF6MCZ0BPKN3333S):
  // lift the issue's file-overlap hold until it closes. `liftOverlapHold` is
  // shared with the issue page's button and `claws_start_issue_anyway`.
  app.post("/board/overlap-start", authMiddleware, async (c) => {
    const ids: BoardRefusalIds = {};
    const refuse = (body: { error: string } & Record<string, unknown>, status: number) => boardRefusal(c, "/board/overlap-start", status, body, ids);
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return refuse({ error: "Malformed request body" }, 400);
    }
    const parsed = BoardOverlapStartSchema.safeParse(raw);
    if (!parsed.success) return refuse({ error: "Missing repo or ref" }, 400);
    const { repo, ref } = parsed.data;
    ids.repo = repo;
    ids.issue = String(ref);
    if (!isClawsIssueId(ref)) return refuse({ error: "Only a Claws-native issue can be started anyway" }, 400);
    const record = await clawsIssues.getIssue(ref);
    if (!record || record.kind === "shadow") return refuse({ error: "No such issue" }, 404);
    const result = await liftOverlapHold(record.id, { kind: "dashboard", who: sessionSubject(c) });
    if (!result.ok) return refuse({ error: result.error }, result.status);
    return jsonOk(c, { result: "ok" });
  });

  // The issue page's Start anyway button.
  app.post("/issues/:id/overlap/start", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const back = { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] };
    const result = await liftOverlapHold(loaded.id, { kind: "dashboard", who: sessionSubject(c) });
    if (!result.ok) return htmlError(c, result.status, "Cannot start anyway", result.error, back);
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // The issue page's Mark step done button.
  app.post("/issues/:id/steps/:position/done", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const back = { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] };
    const position = Number(c.req.param("position"));
    if (!Number.isInteger(position) || position < 1) return htmlError(c, 400, "Cannot mark step done", "Invalid step number.", back);
    const result = await markOperatorStepDone(loaded.record, loaded.id, position, { kind: "dashboard", who: sessionSubject(c) });
    if (!result.ok) return htmlError(c, result.status, "Cannot mark step done", result.error, back);
    return c.redirect(`/issues/${loaded.id}?${result.already ? "step-already" : "step-done"}=${position}`, 303);
  });

  // The issue page's Unblock button.
  app.post("/issues/:id/unblock", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const back = { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] };
    const result = await unblockNative(loaded.record, loaded.id, sessionSubject(c));
    if (!result.ok) return htmlError(c, result.status, "Cannot move issue", result.error, back);
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  /**
   * Move a native issue to `column`; with `automerge` alongside Approved, the
   * issue is approved through Merge rather than Plan.
   */
  async function applyColumnChange(record: NativeIssueRecord, id: string, column: string, automerge: boolean, approvedBy: string, until?: string | null, reason?: string): Promise<GateWriteResult> {
    return await setNativeColumn(record, id, column, approvedBy, {
      ...(until === undefined ? {} : { until }),
      ...(reason === undefined ? {} : { reason }),
      ...(automerge && column === "approved" ? { approval: "merge" as const } : {}),
    });
  }

  // Standalone route (the issue page now posts to /comments with `status`): set the issue's lifecycle state the way a
  // board move to that column would, with the same refusals. `column=approved`
  // approves the issue through Plan; `automerge=1` alongside it approves it
  // through Merge.
  app.post("/issues/:id/column", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const { record } = loaded;
    const params = parseFormBody(await readTextBody(c));
    const column = params["column"] ?? "";
    const automerge = !!params["automerge"];
    const until = column === BACKLOG_DESTINATION && params["backlog_until"] ? params["backlog_until"] : undefined;
    const back = { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] };
    const result = await applyColumnChange(record, loaded.id, column, automerge, sessionSubject(c), until, params["reason"]);
    if (!result.ok) return htmlError(c, result.status, "Cannot move issue", result.error, back);
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // The issue page's Returns-on controls and the backlog page's per-row date
  // form (docs/issue-tracker.md#backlog): set or, with an empty `until`, clear
  // the day a parked issue comes back. Only while the issue is in the Backlog.
  // `return_to` sends the backlog page's form back to the filtered page.
  app.post("/issues/:id/backlog-until", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const params = parseFormBody(await readTextBody(c));
    const returnTo = params["return_to"] ?? "";
    const back = /^\/backlog(?:\?[^\s]*)?$/.test(returnTo) ? returnTo : `/issues/${loaded.id}`;
    const backAction = { actions: [{ href: back, label: back.startsWith("/backlog") ? "← Backlog" : "← Back to issue" }] };
    const refusal = await nativeStatusRefusal(loaded.record);
    if (refusal) return htmlError(c, refusal.status, "Cannot set the return date", refusal.error, backAction);
    if (loaded.record.lifecycle !== BACKLOG_DESTINATION) {
      return htmlError(c, 409, "Not in the backlog", "A return date can only be set while the issue is in the Backlog.", backAction);
    }
    const parsed = parseBacklogUntil(params["until"] ?? "");
    if (!parsed.ok) return htmlError(c, 400, "Invalid return date", parsed.error, backAction);
    if (!(await setClawsIssueBacklogUntil(loaded.id, parsed.until))) {
      return htmlError(c, 409, "Not in the backlog", "The issue changed since this page loaded — reload and try again.", backAction);
    }
    return c.redirect(back, 303);
  });

  // The Requirements block's Promote button (docs/refinements/issue-flow.md
  // "Promotion"): approve the latest requirements version as the signed-in
  // operator and move the issue from Drafting or Requirements review to Planning — the same write as a
  // drop into Planning on the board.
  app.post("/issues/:id/promote", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const back = { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] };
    const result = await promoteNative(loaded.record, loaded.id, sessionSubject(c));
    if (!result.ok) return htmlError(c, result.status, "Cannot promote issue", result.error, back);
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // The header's inline title editor posts here with just `title` and `Accept:
  // application/json`; the collapsed Edit section (no-JS path) posts both
  // `title` and `body`. A missing `body` field means "leave the body alone" —
  // an absent field must not be read as "set it to empty".
  app.post("/issues/:id/edit", authMiddleware, async (c) => {
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return wantsJson ? jsonOk(c, { error: "Issue not found" }, 404) : issueNotFound(c);
    const params = parseFormBody(await readTextBody(c));
    const repo = eventRepo(loaded.record);
    let title = loaded.record.title;
    if ("title" in params) {
      const trimmed = (params["title"] ?? "").trim();
      if (trimmed && trimmed !== loaded.record.title) await editIssueTitle(repo, loaded.id, trimmed);
      if (trimmed) title = trimmed;
    }
    if ("body" in params) {
      const newBody = params["body"] ?? "";
      if (newBody !== loaded.record.body) await editIssue(repo, loaded.id, newBody);
    }
    if (wantsJson) return jsonOk(c, { ok: true, title });
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // The issue page's Create Session button: an interactive session dedicated to
  // a native issue, set up exactly as a board start (`startIssueSession`: same
  // repos, agent, model, capabilities, brief and opening message). The only
  // differences are the audit comment posted here and `spawned_from`. A
  // dashboard route like `/board/start-session`, not the session-only
  // `startSpawnedSession` path, so its five-session cap and bearer rules stay
  // untouched (docs/product/dashboard-and-integrations.md).
  const issueSessionsInFlight = new Set<string>();
  app.post("/issues/:id/start-session", authMiddleware, async (c) => {
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return wantsJson ? jsonOk(c, { error: "Issue not found" }, 404) : issueNotFound(c);
    const { record, id } = loaded;
    const back = { actions: [{ href: `/issues/${id}`, label: "← Back to issue" }] };
    if (issueSessionsInFlight.has(id)) {
      const message = "A session is already being created for this issue";
      return wantsJson ? jsonOk(c, { error: message }, 409) : htmlError(c, 409, "Cannot create session", message, back);
    }
    issueSessionsInFlight.add(id);
    try {
      const started = await startIssueSession(ctx, record, id, "issue-page");
      if (!started.ok) {
        const message = `Cannot create session: ${started.error}`;
        return wantsJson ? jsonOk(c, { error: message }, started.status) : htmlError(c, started.status, "Cannot create session", started.error, back);
      }
      const { provider, model, repos, url } = started;
      await postSessionAudit(eventRepo(record), id, `The operator started session [\`${started.id}\`](${url}) for this issue from the issue page (${provider}${model ? `, ${model}` : ""}; ${repos.length > 0 ? repos.join(", ") : "home directory"}).`);
      return wantsJson ? jsonOk(c, { ok: true, id: started.id, url }) : c.redirect(url, 303);
    } finally {
      issueSessionsInFlight.delete(id);
    }
  });

  app.post("/issues/:id/state", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const params = parseFormBody(await readTextBody(c));
    const state = params["state"] ?? "";
    const repo = eventRepo(loaded.record);
    if (state === "open") {
      // The façade has no reopen — Forgejo never needed one here.
      await clawsIssues.reopenIssue(loaded.id);
    } else if (state === "closed") {
      // Not planned by default — the human closing from the board or this
      // control almost always means "this was dropped, not shipped". The
      // issue page's second button opts into completed, for work finished
      // outside Claws; a merged PR's own close (auto-merger.ts,
      // issue-auditor.ts, pr-dispatcher.ts) never goes through this route.
      await closeIssue(repo, loaded.id, params["reason"] === "completed" ? "completed" : "not_planned");
    }
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  app.post("/issues/:id/repos", authMiddleware, async (c) => {
    // The issue page's auto-saving forms ask for JSON; a plain form post (no
    // JS) still gets the redirect back to the page.
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return wantsJson ? jsonOk(c, { error: "Issue not found" }, 404) : issueNotFound(c);
    const known = new Set((await listRepos()).map((r) => r.fullName));
    await clawsIssues.setRepos(loaded.id, parseFormBodyMulti(await readTextBody(c), "repo").filter((r) => known.has(r)));
    if (wantsJson) return jsonOk(c, { ok: true });
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // The phase × (provider, tier) grid (docs/model-selection.md). Every phase in
  // the form is written: a phase left blank clears its explicit cell back to the
  // planner's suggestion or the default. Cells are stored under the issue's
  // primary repo — the one the planner and implementer resolve them from — so a
  // POST for an issue with no repo, including a stale tab whose repos were
  // cleared since it loaded, is refused rather than written nowhere.
  app.post("/issues/:id/model-plan", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const repos = loaded.record.repos;
    if (repos.length === 0) {
      return htmlError(c, 409, "Model plan not saved", "The model plan is stored under the issue's primary repository, and this issue has none. Assign a repo, reload the issue and try again.", {
        actions: [{ href: `/issues/${loaded.id}`, label: "← Issue" }],
      });
    }
    const cells = parseModelPlanForm(parseFormBody(await readTextBody(c)));
    await setExplicitPlan(clawsIssues.primaryRepo(loaded.record), loaded.id, cells);
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // ── Native issue attachments (#3289, docs/issue-tracker.md) ──
  //
  // `:id` is a native issue id, or the literal `new` for a pending upload made
  // on the New Issue form before the issue exists. Uploads mirror the session
  // routes: a multipart route capped at 10 MB per request, and a raw-body
  // streaming route for anything up to 1 GB.

  /**
   * The owner an attachment route acts on: a live native issue's id, `null`
   * for `new` (pending), or undefined when `:id` names neither — including a
   * shadow, whose files would belong to the forge copy. `loaded` carries the
   * live issue's record for routes that need to post feedback on upload.
   */
  async function attachmentOwner(
    c: Ctx,
  ): Promise<{ issueId: string | null; segment: string; loaded?: { record: NonNullable<Awaited<ReturnType<typeof clawsIssues.getIssue>>>; id: string } } | undefined> {
    if (c.req.param("id") === PENDING_URL_SEGMENT) return { issueId: null, segment: PENDING_URL_SEGMENT };
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return undefined;
    return { issueId: loaded.id, segment: loaded.id, loaded: { record: loaded.record, id: loaded.id } };
  }

  function describeAttachment(row: ClawsIssueAttachmentRow) {
    return { id: row.id, name: row.filename, url: attachmentUrl(row), size: row.size, contentType: row.content_type };
  }

  function attachmentUploadFailed(c: Ctx, wantsJson: boolean, segment: string, result: Extract<SaveUploadResult, { ok: false }>, maxLabel: string): Response {
    if (wantsJson) return uploadErrorResponse(c, result, maxLabel);
    return htmlError(c, result.reason === "too-large" ? 413 : 500, "Upload failed", describeUploadError(result, maxLabel), {
      actions: [{ href: `/issues/${segment}`, label: "← Back" }],
    });
  }

  app.get("/issues/:id/attachments/:attachmentId/:filename", authMiddleware, async (c) => {
    const notFound = () => textPlain(c, "Attachment not found", 404);
    const parsed = parseAttachmentUrl(c.req.path);
    if (!parsed) return notFound();
    let owner: string | null = null;
    if (parsed.issueId !== PENDING_URL_SEGMENT) {
      const record = await clawsIssues.getIssue(parsed.issueId);
      if (!record || record.kind === "shadow") return notFound();
      owner = record.id;
    }
    const found = await readIssueAttachment(parsed.attachmentId);
    // The row, not the URL, decides whose file this is.
    if (!found || found.row.issue_id !== owner) return notFound();
    let opened: Awaited<ReturnType<typeof openIssueAttachment>>;
    try {
      opened = await openIssueAttachment(found);
    } catch (err) {
      log.warn(`[server] Attachment ${found.row.id} could not be read: ${err}`);
      return textPlain(c, "Attachment store unavailable", 502);
    }
    if (!opened) return notFound();
    c.header("Content-Type", serveContentType(found.row));
    c.header("Content-Length", String(opened.size));
    c.header("Content-Disposition", contentDisposition(found.row));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(opened.body, 200);
  });

  app.post(
    "/issues/:id/attachments",
    authMiddleware,
    // Per request, not per file: the dashboard client sends one file per
    // request, and the true per-file cap is still enforced by the store.
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES + 4096,
      onError: (c) => {
        c.header("Content-Type", "application/json");
        return c.body(JSON.stringify({ error: "File too large (max 10 MB)" }), 413);
      },
    }),
    async (c) => {
      const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
      const owner = await attachmentOwner(c);
      if (!owner) return wantsJson ? jsonOk(c, { error: "Issue not found" }, 404) : issueNotFound(c);
      if (owner.issueId === null) await sweepPendingAttachments();
      let field: unknown;
      try {
        field = (await c.req.parseBody({ all: true }))["file"];
      } catch (err) {
        return jsonOk(c, { error: `Malformed upload: ${String(err)}` }, 400);
      }
      const files = (Array.isArray(field) ? field : [field]).filter((f): f is File => f instanceof File && f.size > 0);
      if (files.length === 0) {
        if (wantsJson) return jsonOk(c, { error: "Missing file field" }, 400);
        return c.redirect(`/issues/${owner.segment}`, 303);
      }
      const uploader = config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN;
      const stored: ClawsIssueAttachmentRow[] = [];
      for (const file of files) {
        const result = await storeIssueAttachment(owner.issueId, file.name, Buffer.from(await file.arrayBuffer()), file.type, uploader);
        if (!result.ok) return attachmentUploadFailed(c, wantsJson, owner.segment, result, "10 MB");
        log.info(`[server] Issue ${owner.segment}: stored attachment ${result.row.id} (${result.row.size} bytes)`);
        stored.push(result.row);
      }
      if (owner.loaded && c.req.query("feedback") === "1") await postAttachmentFeedbackComment(owner.loaded, stored);
      if (wantsJson) return jsonOk(c, { attachments: stored.map(describeAttachment) });
      return c.redirect(`/issues/${owner.segment}`, 303);
    },
  );

  app.post("/issues/:id/attachments/stream", authMiddleware, async (c) => {
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    // Fast reject before reading a byte when the client declares an over-cap size.
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_LARGE_UPLOAD_BYTES) {
      return jsonOk(c, { error: "File too large (max 1 GB)" }, 413);
    }
    const owner = await attachmentOwner(c);
    if (!owner) return wantsJson ? jsonOk(c, { error: "Issue not found" }, 404) : issueNotFound(c);
    if (owner.issueId === null) await sweepPendingAttachments();
    const body = c.req.raw.body;
    if (!body) return jsonOk(c, { error: "Missing request body" }, 400);
    const result = await storeIssueAttachmentStream(
      owner.issueId,
      c.req.query("name") ?? "upload",
      Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
      c.req.header("content-type"),
      config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN,
    );
    if (!result.ok) return attachmentUploadFailed(c, wantsJson, owner.segment, result, "1 GB");
    log.info(`[server] Issue ${owner.segment}: stored streamed attachment ${result.row.id} (${result.row.size} bytes)`);
    if (owner.loaded && c.req.query("feedback") === "1") await postAttachmentFeedbackComment(owner.loaded, [result.row]);
    if (wantsJson) return jsonOk(c, { attachments: [describeAttachment(result.row)] });
    return c.redirect(`/issues/${owner.segment}`, 303);
  });

  // A form cannot send DELETE, so this is a POST like every other issue write.
  app.post("/issues/:id/attachments/:attachmentId/delete", authMiddleware, async (c) => {
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const owner = await attachmentOwner(c);
    if (!owner) return wantsJson ? jsonOk(c, { error: "Issue not found" }, 404) : issueNotFound(c);
    const parsed = parseAttachmentUrl(`/issues/${owner.segment}/attachments/${c.req.param("attachmentId")}`);
    const found = parsed ? await readIssueAttachment(parsed.attachmentId) : undefined;
    if (!found || found.row.issue_id !== owner.issueId) {
      return wantsJson ? jsonOk(c, { error: "Attachment not found" }, 404) : textPlain(c, "Attachment not found", 404);
    }
    await deleteIssueAttachment(found.row.id);
    if (wantsJson) return jsonOk(c, { ok: true });
    return c.redirect(`/issues/${owner.segment}`, 303);
  });

  // Links to other tracker issues (docs/issue-tracker.md#links). Plain forms,
  // so both writes are POSTs that redirect back to the page.
  app.post("/issues/:id/links", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const params = parseFormBody(await readTextBody(c));
    const back = { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] };
    const kind = issueLinks.parseLinkKind(params["kind"]);
    if (!kind) return htmlError(c, 400, "Cannot link issue", `Unknown link kind: ${params["kind"] ?? ""}`, back);
    try {
      await issueLinks.addLink(eventRepo(loaded.record), loaded.id, kind, params["issue"] ?? "", config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN);
    } catch (err) {
      if (err instanceof issueLinks.LinkError) return htmlError(c, err.status, "Cannot link issue", err.message, back);
      throw err;
    }
    return c.redirect(`/issues/${loaded.id}#links`, 303);
  });

  app.post("/issues/:id/links/:linkId/delete", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    try {
      await issueLinks.removeLink(eventRepo(loaded.record), loaded.id, c.req.param("linkId") ?? "");
    } catch (err) {
      if (err instanceof issueLinks.LinkError) {
        return htmlError(c, err.status, "Cannot remove link", err.message, { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] });
      }
      throw err;
    }
    return c.redirect(`/issues/${loaded.id}#links`, 303);
  });
}
