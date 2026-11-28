/** `apiAuth` JSON routes: `/api/state`, `/api/runtime/*`, `/api/issue-phases`, the `/api/issues*` reads and links, and the attachments API. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import path from "node:path";
import { Hono } from "hono";
import { stageRankOf } from "../../work-order.js";
import * as config from "../../config.js";
import { listRepos, isNativeIssue, type Issue, type PR } from "../../github.js";
import { getIssueComments } from "../../github.js";
import * as planParser from "../../plan-parser.js";
import { loadIssuePhaseState } from "../../planned-prs.js";
import { getLatestRunIdsByJob, listQueuedWork, listClawsIssueAttachments, listClawsIssues, listIssueIdsWithPlans, getIssueBlockedReasons } from "../../db.js";
import * as log from "../../log.js";
import { VERSION } from "../../version.js";
import { latencySummary } from "../../metrics.js";
import { planStepFootprints } from "../../overlap-gate.js";
import { deriveApprovalTrack } from "../../pages/approval-track.js";
import { loadIssueStage, loadOpenIssueStages } from "../../issue-stage.js";
import { renderRequirementsComment } from "../../requirements-record.js";
import * as clawsIssues from "../../claws-issues.js";
import * as issueLinks from "../../issue-links.js";
import { canonicalIssueRef } from "../../issue-id.js";
import { isClawsComment, isPlanComment, isRequirementsComment } from "../../marker-text.js";
import { guardContent, makeGuardCtx } from "../../prompt-guard.js";
import { attachmentResult, attachmentSummary } from "../../claws-state-tools.js";
import { isShuttingDown, shutdownElapsedMs } from "../../shutdown.js";
import { readIssueAttachment, readIssueAttachmentBytes } from "../../issue-attachments.js";
import type { ClawsIssueRecord } from "../../db.js";
import { type Ctx, type Env, jsonOk } from "../http.js";
import { apiAuthMiddleware } from "../auth.js";
import { isConfiguredRepo, startedAt } from "../shared.js";
import { loadNativeIssue } from "../issue-actions.js";
import { stopsAtForOpenIssues } from "../approval-actions.js";
import type { RouteContext } from "./context.js";

export function registerApiRoutes(app: Hono<Env>, ctx: RouteContext): void {
  const { controller } = ctx;
  // ── /api/state uses apiAuth (JSON 401) ──

  app.get("/api/state", apiAuthMiddleware, async (c) => {
    const snapshot = await controller.queueSnapshot();
    const ws = await controller.workerStatus();
    const queuedRows = await listQueuedWork();
    return jsonOk(c, {
      queue: snapshot.items,
      claudeQueue: { pending: ws.queued, active: ws.running },
      capacity: ws.capacity
        ? { ceiling: ws.capacity.ceiling, min: ws.capacity.min, max: ws.capacity.max, lanes: ws.capacity.lanes, source: ws.capacity.source }
        : null,
      claudeQueueEntries: queuedRows.map((r, i) => ({
        position: i + 1,
        priority: r.priority === 1,
        meta: { repo: r.repo, itemNumber: r.item_number, jobName: r.kind },
      })),
      updatedAt: new Date().toISOString(),
    });
  });

  app.get("/api/runtime/status", apiAuthMiddleware, async (c) => {
    try {
      const snapshot = await controller.queueSnapshot();
      const ws = await controller.workerStatus();
      const queuedRows = await listQueuedWork();
      return jsonOk(c, {
        status: "ok",
        version: VERSION,
        startedAt,
        uptimeSeconds: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
        activationState: config.ACTIVATION_STATE,
        shuttingDown: isShuttingDown(),
        shutdownElapsedMs: shutdownElapsedMs(),
        queue: {
          items: snapshot.items,
          total: snapshot.items.length,
        },
        // A run blocked in the shared memory-admission gate still counts as
        // `active` above, so report the gate separately rather than leaving
        // "running but waiting for memory" indistinguishable from real work.
        agentMemoryAdmission: ws.agentMemory,
        workQueue: {
          pending: ws.queued,
          active: ws.running,
          workers: ws.workers,
          // `k8s-pod`: the live ceiling, the min/max it is clamped to, and the
          // per-node figures it was derived from; null under `in-process`.
          capacity: ws.capacity ? { ...ws.capacity, fibers: ws.fibers } : null,
          entries: queuedRows.map((r, i) => ({
            position: i + 1,
            id: r.id,
            kind: r.kind,
            repo: r.repo,
            itemNumber: r.item_number,
            status: r.status,
            priority: r.priority === 1,
            stage: stageRankOf(r.kind),
            attempts: r.attempts,
            enqueuedAt: r.enqueued_at,
            startedAt: r.started_at,
            runId: r.run_id,
          })),
        },
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  app.get("/api/runtime/latency", apiAuthMiddleware, (c) => jsonOk(c, latencySummary()));

  app.get("/api/runtime/jobs", apiAuthMiddleware, async (c) => {
    try {
      const latestRuns = await getLatestRunIdsByJob();
      const schedInfo = await controller.jobScheduleInfo();
      const pausedSet = await controller.pausedJobs();
      const manualSet = await controller.manualOnlyJobs();
      const jobs = [...await controller.jobStates()].sort(([a], [b]) => a.localeCompare(b)).map(([name, running]) => {
        const sched = schedInfo.get(name);
        const latest = latestRuns.get(name);
        let nextRunInMs: number | null = null;
        if (!pausedSet.has(name) && sched?.nextTickAt !== undefined) {
          nextRunInMs = Math.max(0, sched.nextTickAt - Date.now());
        }
        return {
          name,
          running,
          paused: pausedSet.has(name),
          manualOnly: manualSet.has(name),
          schedule: sched ? {
            intervalMs: sched.intervalMs,
            ...(sched.scheduledHour !== undefined ? { scheduledHour: sched.scheduledHour } : {}),
            nextRunInMs,
          } : null,
          latestRun: latest ? {
            runId: latest.runId,
            status: latest.status,
            startedAt: latest.startedAt,
            completedAt: latest.completedAt,
          } : null,
        };
      });
      return jsonOk(c, {
        activationState: config.ACTIVATION_STATE,
        repositoryJobExclusions: config.getRepoJobExclusions(),
        pausedJobs: [...pausedSet].sort(),
        manualOnlyJobs: [...manualSet].sort(),
        jobs,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  /**
   * Which steps of an issue's multi-PR plan Claws currently believes are
   * covered. Backs the `claws_issue_phases` MCP tool, so a session can check
   * before implementing a step by hand (#2594).
   */
  app.get("/api/issue-phases", apiAuthMiddleware, async (c) => {
    const repo = c.req.query("repo") ?? "";
    const issue = canonicalIssueRef(c.req.query("issue") ?? "");
    if (!repo || issue === null || (typeof issue === "number" && issue <= 0)) {
      return jsonOk(c, { error: "repo and an issue reference are required" }, 400);
    }
    // The Forgejo bot token can reach repos outside Claws' managed set, so
    // gate on the configured list.
    if (!await isConfiguredRepo(repo)) {
      return jsonOk(c, { error: `${repo} is not a configured repo` }, 404);
    }
    const startedAt = Date.now();
    try {
      const comments = await getIssueComments(repo, issue);
      const planText = planParser.findPlanComment(comments);
      const plan = planText ? planParser.parsePlan(planText) : null;
      // The stored PR list when there is one, the plan text otherwise. The
      // merged-PR walk is left to `loadIssuePhaseState`, which runs it only
      // when a stored step is unlinked or on the plan-text path.
      const { totalPhases, coverage, entries } = await loadIssuePhaseState(repo, issue, comments, { planText });
      const durationMs = Date.now() - startedAt;
      if (durationMs > 5_000) {
        log.info(`[server] slow issue-phases: repo=${repo} issue=${issue} durationMs=${durationMs} source=${entries ? "stored" : "plan-text"}`);
      }
      return jsonOk(c, {
        repo,
        issue,
        totalPhases,
        nextPhase: coverage.nextPhase,
        readyPhases: coverage.readyPhases,
        openPhases: coverage.openPhases,
        blockedPhases: coverage.blockedPhases,
        // Manual (operator) steps whose dependencies have landed: no PR implements them.
        awaitingOperator: coverage.awaitingOperator,
        source: entries ? "stored" : "plan-text",
        claimsNote: "A `claws-phase-done: N` line at the start of its own line counts from an allowed actor's comment or a note an interactive session posted through its own session route (a note from any other caller is stamped `a Claws agent` and never counts); a claim on a manual step is honoured before its dependencies land.",
        phases: Array.from({ length: totalPhases }, (_, i) => i + 1).map((phase) => {
          const pr = coverage.coveringPRs.get(phase);
          const entry = entries?.[phase - 1];
          return {
            phase,
            title: entry?.title ?? plan?.phases[phase - 1]?.title ?? null,
            repo: entry?.repo ?? repo,
            // `manual`: the plan's operator step, done only by a `claws-phase-done:` claim.
            kind: entry?.kind ?? "pr",
            covered: coverage.covered.has(phase),
            coveredBy: pr?.number ?? null,
            state: pr?.state ?? null,
            // A linked PR that could not be read (e.g. linked before its repo changed forge).
            unreadable: pr?.unreadable ?? null,
            // Effective dependencies: declared, else after the previous step.
            dependsOn: coverage.dependencies.get(phase) ?? [],
            // A `claws-phase-done:` claim names this step (it counts as done).
            claimed: coverage.claimed.has(phase),
            // Dependencies not yet done — what this step still waits on.
            waitingOn: (coverage.dependencies.get(phase) ?? []).filter((d) => !coverage.done.has(d)),
            status: coverage.done.has(phase) ? "done"
              : coverage.covered.has(phase) ? "pending"
              : entry?.kind === "manual" ? "manual"
              : coverage.readyPhases.includes(phase) ? "ready"
              : "blocked",
          };
        }),
      });
    } catch (err) {
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * An issue's links, for the `claws_issue_links` / `claws_link_issues` /
   * `claws_unlink_issues` MCP tools. `:id` must be a live native issue: a
   * shadow or unknown id answers 404, as the dashboard's writes do.
   */
  async function apiLinkIssue(c: Ctx): Promise<{ id: string; repo: string } | null> {
    const ref = canonicalIssueRef(c.req.param("id") ?? "");
    if (!isNativeIssue(ref)) return null;
    const record = await clawsIssues.getIssue(ref);
    if (!record || record.kind === "shadow") return null;
    return { id: record.id, repo: clawsIssues.primaryRepo(record) };
  }

  /**
   * These two back the `claws_get_issue` / `claws_list_issues` MCP tools, so a
   * session can read the tracker instead of only writing to it (#3286 added
   * the writes; this closes the read gap). Not a public API.
   */
  app.get("/api/issues/:id", apiAuthMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c);
    if (!loaded?.record || loaded.record.kind === "shadow") return jsonOk(c, { error: "Issue not found" }, 404);
    const { record } = loaded;
    const [comments, plans, requirements] = await Promise.all([
      clawsIssues.listCommentDetails(record.id),
      clawsIssues.listPlans(record.id),
      clawsIssues.listRequirements(record.id),
    ]);
    // The plan comment is reported separately as `plan`, not in `comments` —
    // the same split the `/issues/:id` page renders. A legacy `## Requirements`
    // comment is dropped too: the record lives in the requirements versions,
    // reported as `requirements` / `previous_requirements`.
    const latestPlan = plans.at(-1) ?? null;
    const latestRequirements = requirements.at(-1) ?? null;
    const stageReads = await loadIssueStage(record, comments, latestRequirements);
    const { stage, stage_title } = stageReads.stage;
    // A version is approved only when it is the one promotion recorded, so an
    // approved v1 followed by an unreviewed v2 shows v2 as not approved.
    const approvedVersion = record.approved_requirements_version == null ? null : Number(record.approved_requirements_version);
    const isApproved = (version: number): boolean => approvedVersion === version && !!record.requirements_approved_at;
    // The blocked reason, best-effort: a failed read answers null rather than failing the read.
    const blockedReason = record.lifecycle === "blocked"
      ? await getIssueBlockedReasons([record.id])
        .then((reasons) => reasons.get(record.id) ?? null)
        .catch((err) => { log.warn(`[server] could not read the blocked reason of issue ${record.id}: ${err}`); return null; })
      : null;
    // The approval track's "Stops at" line, from the reads `stage` came
    // from, so the two agree, as `stopsAtForOpenIssues` does for the list.
    const primary = clawsIssues.primaryRepo(record);
    const stopsAt = deriveApprovalTrack({
      repo: primary,
      ref: record.id,
      column: stage,
      labels: record.labels,
      lifecycle: record.lifecycle,
      approvedThrough: record.approved_through ?? "none",
      requirementsApproved: record.requirements_approved_at != null,
      hasPlan: latestPlan !== null,
      reapprovalPending: stageReads.reapprovalPending,
      awaitingOperator: stageReads.awaitingOperator,
      openPrs: stageReads.flight.openPrs,
      overlapHold: stageReads.overlapHold,
    }).stopsAt;
    // Each PR step's declared paths and its overlaps with other in-flight
    // work (#clw_01M7WDMJ9GCF6MCZ0BPKN3333S), best-effort like the page's.
    const footprints = await planStepFootprints(record.id)
      .catch((err) => { log.warn(`[server] could not load plan steps for issue ${record.id}: ${err}`); return []; });
    const overlapLinkJson = (o: { issueId: string; position: number | null; prNumber: number | null; running: boolean; shared: string[] }) =>
      ({ issue_id: o.issueId, step: o.position, pr_number: o.prNumber, implementing: o.prNumber === null && o.running, files: o.shared });
    return jsonOk(c, {
      id: record.id,
      title: record.title,
      body: record.body,
      state: record.state,
      state_reason: record.state_reason,
      author_login: record.author_login,
      labels: record.labels,
      repos: record.repos,
      created_at: clawsIssues.toIso(record.created_at),
      updated_at: clawsIssues.toIso(record.updated_at),
      url: clawsIssues.dashboardIssueUrl(record.id),
      stage,
      stage_title,
      approved_through: record.approved_through ?? "none",
      stops_at: stopsAt,
      // Every ready step waits on overlapping work ahead of it (overlap-gate.ts); null otherwise.
      overlap_hold: stageReads.overlapHold,
      overlap_hold_lifted_at: record.overlap_hold_lifted_at ? clawsIssues.toIso(record.overlap_hold_lifted_at) : null,
      backlog_until: record.backlog_until ?? null,
      blocked_reason: blockedReason,
      requirements: latestRequirements
        ? {
            version: latestRequirements.version,
            created_at: latestRequirements.createdAt,
            kind: latestRequirements.kind,
            title: latestRequirements.title,
            context: latestRequirements.context,
            requirement: latestRequirements.requirement,
            acceptance_criteria: latestRequirements.acceptanceCriteria,
            out_of_scope: latestRequirements.outOfScope,
            body: renderRequirementsComment(latestRequirements),
            approved: isApproved(latestRequirements.version),
            approved_by: isApproved(latestRequirements.version) ? record.requirements_approved_by : null,
            approved_at: isApproved(latestRequirements.version) && record.requirements_approved_at
              ? clawsIssues.toIso(record.requirements_approved_at)
              : null,
            awaiting_review: stage === "requirements-review",
          }
        : null,
      previous_requirements: requirements.slice(0, -1).map((r) => ({
        version: r.version,
        created_at: r.createdAt,
        kind: r.kind,
        title: r.title,
        approved: isApproved(r.version),
      })),
      plan: latestPlan
        ? { version: latestPlan.version, comment_id: latestPlan.commentId, created_at: latestPlan.createdAt, body: latestPlan.body }
        : null,
      previous_plans: plans.slice(0, -1).map((p) => ({ version: p.version, comment_id: p.commentId, created_at: p.createdAt })),
      plan_steps: footprints.map((f) => ({
        step: f.position, repo: f.repo, title: f.title, paths: f.paths, pr_number: f.prNumber, changed_files: f.changedFiles,
        expected_rebase: f.expectedRebase,
      })),
      overlaps: footprints.filter((f) => f.heldBy.length > 0 || f.holds.length > 0).map((f) => ({
        step: f.position, repo: f.repo, held_by: f.heldBy.map(overlapLinkJson), holds: f.holds.map(overlapLinkJson),
      })),
      comments: comments
        .filter((cm) => (latestPlan?.commentId == null || String(cm.id) !== latestPlan.commentId) && !isRequirementsComment(cm.body))
        .map((cm) => ({
          id: String(cm.id),
          author_login: cm.login,
          body: cm.body,
          created_at: cm.createdAt,
          is_claws: isClawsComment(cm.body),
          is_plan: isPlanComment(cm.body),
        })),
    });
  });

  app.get("/api/issues", apiAuthMiddleware, async (c) => {
    const repoQuery = c.req.query("repo");
    let repo: string | undefined;
    if (repoQuery) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(repoQuery)) return jsonOk(c, { error: "repo must be owner/name" }, 400);
      const managed = new Map((await listRepos()).map((r) => [r.fullName.toLowerCase(), r.fullName]));
      repo = managed.get(repoQuery.toLowerCase()) ?? repoQuery;
    }
    const stateQuery = c.req.query("state") ?? "open";
    if (stateQuery !== "open" && stateQuery !== "closed" && stateQuery !== "all") return jsonOk(c, { error: "state must be open, closed or all" }, 400);
    const state: "open" | "closed" | "all" = stateQuery;
    const title = (c.req.query("title") ?? "").trim();
    if (title.length > 200) return jsonOk(c, { error: "title must be at most 200 characters" }, 400);
    const parseSince = (name: "closed_since" | "updated_since"): Date | undefined | null => {
      const raw = c.req.query(name);
      if (!raw) return undefined;
      const ms = Date.parse(raw);
      return Number.isNaN(ms) ? null : new Date(ms);
    };
    const closedSince = parseSince("closed_since");
    if (closedSince === null) return jsonOk(c, { error: "closed_since must be an ISO 8601 date" }, 400);
    const updatedSince = parseSince("updated_since");
    if (updatedSince === null) return jsonOk(c, { error: "updated_since must be an ISO 8601 date" }, 400);
    if (closedSince && state === "open") return jsonOk(c, { error: "closed_since cannot be combined with state=open" }, 400);
    const offsetQuery = c.req.query("offset");
    if (offsetQuery !== undefined && !/^\d+$/.test(offsetQuery)) return jsonOk(c, { error: "offset must be a non-negative integer" }, 400);
    const offset = offsetQuery === undefined ? 0 : Number(offsetQuery);
    // Ordered `updated_at DESC` already, by listClawsIssues' own query.
    const records = await listClawsIssues({
      state,
      ...(repo !== undefined ? { repo } : {}),
      ...(title ? { titleContains: title } : {}),
      ...(closedSince ? { closedSince } : {}),
      ...(updatedSince ? { updatedSince } : {}),
      limit: 101,
      offset,
    });
    const truncated = records.length > 100;
    const rows = records.slice(0, 100);
    const openRows = rows.filter((r) => r.state === "open");
    const plansByIssue = await listIssueIdsWithPlans(rows.map((r) => r.id));
    const closedIds = rows.filter((r) => r.state === "closed").map((r) => r.id);
    const duplicateOf = closedIds.length > 0 ? await clawsIssues.duplicateOfForIssues(closedIds) : new Map<string, string>();
    // Best-effort: a failed stage read gives the rows `stage: null` rather
    // than failing the list.
    const reads = await loadOpenIssueStages(openRows).catch((err) => {
      log.warn(`[api] issue stages: ${err}`);
      return { stages: new Map(), awaitingOperator: new Map(), flights: new Map(), reapprovals: new Set<string>(), queued: new Map<string, string>(), overlapHeld: new Map<string, string>() };
    });
    const { stages } = reads;
    const stopsAt = stopsAtForOpenIssues(openRows, reads, plansByIssue);
    return jsonOk(c, {
      issues: rows.map((r) => ({
        id: r.id,
        title: r.title,
        state: r.state,
        state_reason: r.state_reason ?? null,
        closed_at: r.closed_at ? clawsIssues.toIso(r.closed_at) : null,
        duplicate_of: duplicateOf.get(r.id) ?? null,
        labels: r.labels,
        repos: r.repos,
        primary_repo: clawsIssues.primaryRepo(r),
        updated_at: clawsIssues.toIso(r.updated_at),
        has_plan: plansByIssue.has(r.id),
        dedupe_key: r.dedupe_key ?? null,
        dedupe_keys: r.dedupe_keys ?? [],
        stage: stages.get(r.id)?.stage ?? null,
        stage_title: stages.get(r.id)?.stage_title ?? null,
        approved_through: r.approved_through ?? "none",
        stops_at: stopsAt.get(r.id) ?? null,
        backlog_until: r.backlog_until ?? null,
      })),
      truncated,
      next_offset: truncated ? offset + 100 : null,
    });
  });

  app.get("/api/issues/:id/links", apiAuthMiddleware, async (c) => {
    const issue = await apiLinkIssue(c);
    if (!issue) return jsonOk(c, { error: "Issue not found" }, 404);
    return jsonOk(c, { issue: issue.id, links: await issueLinks.listLinks(issue.repo, issue.id) });
  });

  app.post("/api/issues/:id/links", apiAuthMiddleware, async (c) => {
    const issue = await apiLinkIssue(c);
    if (!issue) return jsonOk(c, { error: "Issue not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { kind: rawKind, issue: target, step } = (body ?? {}) as { kind?: unknown; issue?: unknown; step?: unknown };
    const kind = issueLinks.parseLinkKind(rawKind);
    if (!kind) return jsonOk(c, { error: `kind must be one of ${issueLinks.LINK_KINDS.join(", ")}` }, 400);
    if (typeof target !== "string" && typeof target !== "number") return jsonOk(c, { error: "issue must be an issue reference" }, 400);
    if (step != null && (typeof step !== "number" || !Number.isInteger(step) || step < 1)) {
      return jsonOk(c, { error: "step must be a positive integer" }, 400);
    }
    try {
      const result = await issueLinks.addLink(issue.repo, issue.id, kind, String(target), clawsIssues.CLAWS_NATIVE_LOGIN, step ?? null);
      return jsonOk(c, result, result.created ? 201 : 200);
    } catch (err) {
      if (err instanceof issueLinks.LinkError) return jsonOk(c, { error: err.message }, err.status);
      throw err;
    }
  });

  app.delete("/api/issues/:id/links/:linkId", apiAuthMiddleware, async (c) => {
    const issue = await apiLinkIssue(c);
    if (!issue) return jsonOk(c, { error: "Issue not found" }, 404);
    try {
      await issueLinks.removeLink(issue.repo, issue.id, c.req.param("linkId") ?? "");
    } catch (err) {
      if (err instanceof issueLinks.LinkError) return jsonOk(c, { error: err.message }, err.status);
      throw err;
    }
    return jsonOk(c, { ok: true });
  });

  /**
   * A native issue's attachments, for the `claws_get_issue_attachments` /
   * `claws_get_issue_attachment` MCP tools. Both claws-state servers call
   * these, so an agent pod — no database, no file store — reads the files the
   * same way a session does (#clw_01M4GFB5Q5YQRQM2XK0RCTBSB5). A shadow or
   * unknown issue answers 404, as its pages do.
   */
  async function apiAttachmentIssue(c: Ctx): Promise<ClawsIssueRecord | null> {
    const loaded = await loadNativeIssue(c);
    return loaded?.record && loaded.record.kind !== "shadow" ? loaded.record : null;
  }

  app.get("/api/issues/:id/attachments", apiAuthMiddleware, async (c) => {
    const issue = await apiAttachmentIssue(c);
    if (!issue) return jsonOk(c, { error: `Issue ${c.req.param("id")} not found` }, 404);
    return jsonOk(c, (await listClawsIssueAttachments(issue.id)).map(attachmentSummary));
  });

  app.get("/api/issues/:id/attachments/:attachmentId", apiAuthMiddleware, async (c) => {
    const issue = await apiAttachmentIssue(c);
    if (!issue) return jsonOk(c, { error: `Issue ${c.req.param("id")} not found` }, 404);
    const attachmentId = c.req.param("attachmentId");
    const found = await readIssueAttachment(attachmentId);
    // Only this issue's own files: a body or comment linking another issue's
    // attachment does not expose it.
    if (!found || found.row.issue_id !== issue.id) return jsonOk(c, { error: `No attachment ${attachmentId} on ${issue.id}` }, 404);
    const guardCtx = makeGuardCtx(issue.repos[0] ?? "claws-issues", issue.id);
    try {
      return jsonOk(c, await attachmentResult({
        meta: attachmentSummary(found.row),
        read: () => readIssueAttachmentBytes(found),
        guardText: async (text) => await guardContent(text, guardCtx("issue-attachment-content")),
      }));
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      log.warn(`[api] Attachment ${attachmentId} on ${issue.id} could not be read: ${cause}`);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return jsonOk(c, { error: `Attachment ${attachmentId} file is missing from the attachment store` }, 404);
      }
      return jsonOk(c, { error: `Attachment read failed: ${cause}` }, 500);
    }
  });
}
