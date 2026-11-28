/** Agent-facing API routes: planner runs, open PRs, Forgejo reads, the issue filer, issue creation, friction notes, repos, events, MCP sessions, session pods and agent pods. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import { z } from "zod";
import http from "node:http";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { hashAgentMcpToken, safeCompare } from "../../internal-mcp-token.js";
import * as config from "../../config.js";
import { listRepos, clearRepoCache, isNativeIssue, type Issue, type PR } from "../../github.js";
import { commentOnIssue as ghCommentOnIssue } from "../../github.js";
import { PHASE_CLAIM_RE, isPhaseClaimOnly } from "../../phase-coverage.js";
import { createOrgRepo, commitFiles, AdminTokenMissingError, listActionsSecretNames, getRepo as getForgejoRepo, isMissing as isForgejoMissing, fetchRepoFileContent as fetchForgejoFileContent, getRepoSeedState as getForgejoRepoSeedState, type ForgejoRepoInfo } from "../../forgejo.js";
import { buildRepoSeed, CALLER_SEED_PATHS, MAX_PURPOSE_CHARS, SEED_KINDS, SEED_PATHS, type SeedFallback } from "../../repo-seed.js";
import type { RepoKind } from "../../security-contract.js";
import * as plannerRuns from "../../planner-runs.js";
import * as alertBridge from "../../alert-bridge.js";
import * as issueFiler from "../../issue-filer.js";
import { issueFilerAuthMiddleware, MAX_ATTACHMENT_BYTES as MAX_FILER_ATTACHMENT_BYTES } from "../../issue-filer.js";
import { completionAuthMiddleware, completionHandler } from "../../completion-api.js";
import { DEDUPE_KEY_PATTERN, serialiseIssueCreate } from "../../issue-create-lock.js";
import { getWorkRow, insertFrictionNote, getSessionAttachment, listClawsIssueLinks } from "../../db.js";
import * as log from "../../log.js";
import { loadPrsOverview } from "../../prs-overview.js";
import { DELIVERY_PERIODS, loadDeliveryStats, type DeliveryPeriod } from "../../delivery-stats.js";
import { APPROVAL_GATES, isApprovedThrough } from "../../issue-approval.js";
import { RETIRED_GATE_LABELS } from "../../issue-lifecycle.js";
import { isStateLabel } from "../../issue-lifecycle.js";
import * as clawsIssues from "../../claws-issues.js";
import { findDuplicateCandidates } from "../../issue-dedupe.js";
import { canonicalIssueRef, isClawsIssueId } from "../../issue-id.js";
import { ISSUE_NOTE_AGENT, stripQuotedRegions } from "../../marker-text.js";
import { getSessionBackend } from "../../session-backend.js";
import { createClawsStateMcpHandler, mcpMethodNotAllowed, listOpenPrsForManagedRepo } from "../../claws-state-http.js";
import { fetchForgejoJobLogs, ForgejoJobLogsError } from "../../forgejo-job-logs.js";
import { fetchForgejoRun } from "../../forgejo-run.js";
import { fetchForgejoRunArtifacts } from "../../forgejo-run-artifacts.js";
import { guardContent } from "../../prompt-guard.js";
import { FRICTION_CATEGORIES, FRICTION_REFERENCE_MAX, FRICTION_TEXT_MAX } from "../../claws-state-tools.js";
import { getRepoConfig } from "../../repo-config.js";
import { alertOwnerRepos, isAlertInbox } from "../../alert-issue.js";
import { waitForEvents, parseKindFilter, GITHUB_EVENT_KINDS, type EventFilter, type KindFilter } from "../../github-events.js";
import { openSessionAttachment, isSessionAttachmentId } from "../../session-attachments.js";
import { readIssueAttachment, openIssueAttachment, parseAttachmentUrl, PENDING_URL_SEGMENT } from "../../issue-attachments.js";
import type { ClawsIssueRecord } from "../../db.js";
import { agentPodTokenLive, executeAgentPodOp } from "../../agent-pod-ops.js";
import { decodeWire, encodeWire } from "../../agent-pod-wire.js";
import { type Ctx, type Env, jsonOk, readTextBody, textPlain } from "../http.js";
import { apiAuthMiddleware, sessionOwnTokenMiddleware } from "../auth.js";
import { COMPLETION_PROXIED_ROUTE, completionBodyLimit } from "../proxy.js";
import { AGENT_POD_OPS_MAX_BYTES, type NativeIssueRecord, REPO_NAME_PATTERN, SESSION_EXIT_REPORT_MAX_BYTES, STEP_CLAIM_REFUSAL, SessionExitReportSchema, errMessage, postDedupeAuditComment, sessionApprover } from "../shared.js";
import { loadNativeIssue, eventRepo } from "../issue-actions.js";
import type { RouteContext } from "./context.js";
import { sessionIssueGuard } from "./session-issues.js";

export function registerAgentApiRoutes(app: Hono<Env>, ctx: RouteContext): void {
  const { controller, role } = ctx;
  /**
   * Planner tool submissions (`src/planner-tools.ts`). The run id is the only
   * handle: it is minted per planner invocation by `withPlannerRun` and names
   * one issue and stage, so these routes cannot write anywhere else. Nothing is
   * published here — the refiner reads the submission once the run ends.
   */
  // Serves only in-process planner runs: an agent pod's runs live in the pod,
  // which serves these same routes on its own loopback listener
  // (`src/planner-run-listener.ts`).
  app.post("/api/planner-runs/:id/plan", apiAuthMiddleware, plannerRuns.plannerRunHandler(plannerRuns.submitPlan));
  app.post("/api/planner-runs/:id/outcome", apiAuthMiddleware, plannerRuns.plannerRunHandler(plannerRuns.submitOutcome));
  app.post("/api/planner-runs/:id/step-back", apiAuthMiddleware, plannerRuns.plannerRunHandler(plannerRuns.submitStepBack));
  app.post("/api/planner-runs/:id/followup", apiAuthMiddleware, plannerRuns.plannerRunHandler(plannerRuns.submitFollowupVerdict));
  app.post("/api/planner-runs/:id/keep-plan", apiAuthMiddleware, plannerRuns.plannerRunHandler(plannerRuns.submitKeepPlan));

  /**
   * Open PRs for a managed repo, forge-aware. Backs the `claws_open_prs` MCP
   * tool for the stdio server, which cannot import `github.js` (#3062).
   */
  app.get("/api/open-prs", apiAuthMiddleware, async (c) => {
    const repo = c.req.query("repo") ?? "";
    if (!repo) {
      return jsonOk(c, { error: "repo is required" }, 400);
    }
    try {
      const prs = await listOpenPrsForManagedRepo(repo);
      if (!prs) {
        return jsonOk(c, { error: `${repo} is not a repo Claws manages` }, 404);
      }
      return jsonOk(c, prs);
    } catch (err) {
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /** The `/prs` page's hold and attention state; backs `claws_prs_overview`. */
  app.get("/api/prs-overview", apiAuthMiddleware, async (c) => {
    const repo = c.req.query("repo") || undefined;
    try {
      const overview = await loadPrsOverview(repo);
      if (!overview) return jsonOk(c, { error: `${repo} is not a repo Claws manages` }, 404);
      return jsonOk(c, overview);
    } catch (err) {
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * Per-repo, per-period cost and rework of implemented issues, from stored
   * rows only; backs `claws_delivery_stats`.
   */
  app.get("/api/delivery-stats", apiAuthMiddleware, async (c) => {
    const repo = c.req.query("repo") || undefined;
    const periodRaw = c.req.query("period");
    const sinceRaw = c.req.query("since");
    const detailRaw = c.req.query("detail");
    if (periodRaw !== undefined && !(DELIVERY_PERIODS as readonly string[]).includes(periodRaw)) {
      return jsonOk(c, { error: `period must be one of ${DELIVERY_PERIODS.join(", ")}` }, 400);
    }
    let since: number | undefined;
    if (sinceRaw !== undefined) {
      since = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(sinceRaw)
        ? Date.parse(sinceRaw.length === 10 ? `${sinceRaw}T00:00:00Z` : /(Z|[+-]\d{2}:?\d{2})$/.test(sinceRaw) ? sinceRaw : `${sinceRaw}Z`)
        : NaN;
      if (!Number.isFinite(since)) return jsonOk(c, { error: "since must be an ISO-8601 date or timestamp (e.g. 2026-09-01)" }, 400);
      if (since > Date.now()) return jsonOk(c, { error: "since must not be in the future" }, 400);
    }
    if (detailRaw !== undefined && detailRaw !== "true" && detailRaw !== "false") {
      return jsonOk(c, { error: "detail must be true or false" }, 400);
    }
    try {
      const stats = await loadDeliveryStats({ repo, since, period: periodRaw as DeliveryPeriod | undefined, detail: detailRaw === "true" });
      if (!stats) return jsonOk(c, { error: `${repo} is not a repo Claws manages` }, 404);
      return jsonOk(c, stats);
    } catch (err) {
      log.warn("delivery stats read failed", { component: "delivery-stats", repo: repo ?? null }, err);
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * A Forgejo Actions run's job logs as readable text, read with the bot token.
   * Backs the `claws_forgejo_job_logs` MCP tool, so sessions read Forgejo CI
   * failures with no token or capability grant (#clw_01M4BYY8SZ9CY5NBC20ZHAPXFW).
   */
  app.get("/api/forgejo/job-logs", apiAuthMiddleware, async (c) => {
    const repo = c.req.query("repo") ?? "";
    const runRaw = c.req.query("run") ?? "";
    const jobRaw = c.req.query("job");
    const attemptRaw = c.req.query("attempt");
    const allStepsRaw = c.req.query("all_steps");
    const stepRaw = c.req.query("step");
    const grep = c.req.query("grep");
    const contextRaw = c.req.query("context");
    if (!repo) return jsonOk(c, { error: "repo is required" }, 400);
    if (!/^\d+$/.test(runRaw)) return jsonOk(c, { error: "run must be a non-negative integer (the run number in /actions/runs/<n>)" }, 400);
    if (jobRaw !== undefined && !jobRaw.trim()) return jsonOk(c, { error: "job must be a 0-based job index or a job name" }, 400);
    if (attemptRaw !== undefined && !/^[1-9]\d*$/.test(attemptRaw)) return jsonOk(c, { error: "attempt must be a positive integer (1 is the first run)" }, 400);
    if (allStepsRaw !== undefined && allStepsRaw !== "true" && allStepsRaw !== "false") {
      return jsonOk(c, { error: "all_steps must be true or false" }, 400);
    }
    if (stepRaw !== undefined && !stepRaw.trim()) return jsonOk(c, { error: "step must be a 0-based step index or part of a step name" }, 400);
    if (grep !== undefined && (grep.length < 1 || grep.length > 200)) return jsonOk(c, { error: "grep must be 1-200 characters" }, 400);
    if (contextRaw !== undefined && (!/^\d+$/.test(contextRaw) || Number(contextRaw) > 20)) {
      return jsonOk(c, { error: "context must be an integer from 0 to 20" }, 400);
    }
    const run = Number(runRaw);
    const job = jobRaw === undefined ? undefined : /^\d+$/.test(jobRaw) ? Number(jobRaw) : jobRaw;
    const step = stepRaw === undefined ? undefined : /^\d+$/.test(stepRaw) ? Number(stepRaw) : stepRaw;
    const context = contextRaw === undefined ? undefined : Number(contextRaw);
    const attempt = attemptRaw === undefined ? undefined : Number(attemptRaw);
    try {
      const result = await fetchForgejoJobLogs({ repo, run, job, attempt, allSteps: allStepsRaw === "true", step, grep, context });
      const text = await guardContent(result.text, { repo, source: `ci-log (run ${run})`, itemNumber: 0 });
      return jsonOk(c, { text, truncated: result.truncated });
    } catch (err) {
      if (err instanceof ForgejoJobLogsError) return jsonOk(c, { error: err.message }, err.status);
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * Whether Forgejo Actions secrets exist on a managed repo and its org: names
   * only, read with the service's admin token. Backs `claws_forgejo_actions_secrets`.
   */
  app.get("/api/forgejo/actions-secrets", apiAuthMiddleware, async (c) => {
    const repo = c.req.query("repo") ?? "";
    const namesRaw = c.req.query("names");
    if (!repo) return jsonOk(c, { error: "repo is required" }, 400);
    const names = namesRaw === undefined || namesRaw === "" ? [] : namesRaw.split(",");
    if (names.length > 50 || names.some((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) {
      return jsonOk(c, { error: "names must be at most 50 comma-separated secret names matching [A-Za-z_][A-Za-z0-9_]*" }, 400);
    }
    try {
      const wanted = repo.toLowerCase();
      const managed = (await listRepos()).find((r) => r.fullName.toLowerCase() === wanted);
      if (!managed) return jsonOk(c, { error: `${repo} is not a repository Claws manages` }, 404);
      const found = await listActionsSecretNames(managed.fullName);
      const repoSecrets = found.repo.map((s) => s.name);
      const orgSecrets = found.org ? found.org.map((s) => s.name) : null;
      const has = (list: string[] | null, n: string) => (list ? list.some((x) => x.toLowerCase() === n.toLowerCase()) : null);
      log.debug(`actions-secrets: ${managed.fullName} checked ${names.length} name(s)`);
      return jsonOk(c, {
        repo: managed.fullName,
        org: found.org ? managed.fullName.split("/")[0] : null,
        repo_secrets: repoSecrets,
        org_secrets: orgSecrets,
        ...(names.length > 0
          ? {
              checked: names.map((name) => {
                const inRepo = has(repoSecrets, name) === true;
                const inOrg = has(orgSecrets, name);
                return { name, repo: inRepo, org: inOrg, exists: inRepo || inOrg === true };
              }),
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof AdminTokenMissingError) return jsonOk(c, { error: "Forgejo admin token not configured" }, 503);
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * One Forgejo Actions run by its run number: status, true trigger event,
   * timings and job statuses. Backs the `claws_forgejo_run` MCP tool.
   */
  app.get("/api/forgejo/run", apiAuthMiddleware, async (c) => {
    const repo = c.req.query("repo") ?? "";
    const runRaw = c.req.query("run") ?? "";
    if (!repo) return jsonOk(c, { error: "repo is required" }, 400);
    if (!/^\d+$/.test(runRaw)) return jsonOk(c, { error: "run must be a non-negative integer (the run number in /actions/runs/<n>)" }, 400);
    const run = Number(runRaw);
    try {
      const result = await fetchForgejoRun({ repo, run });
      const title = result.title === null ? null : await guardContent(result.title, { repo, source: `ci-run-title (run ${run})`, itemNumber: 0 });
      return jsonOk(c, { ...result, title });
    } catch (err) {
      if (err instanceof ForgejoJobLogsError) return jsonOk(c, { error: err.message }, err.status);
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * A Forgejo Actions run's artifacts by its run number, read with the bot token
   * through forgejo patch 0009. Backs the `claws_forgejo_run_artifacts` MCP tool
   * (#clw_01M8ET462MDX4K6FTQY252XHNG).
   */
  app.get("/api/forgejo/run-artifacts", apiAuthMiddleware, async (c) => {
    const repo = c.req.query("repo") ?? "";
    const runRaw = c.req.query("run") ?? "";
    if (!repo) return jsonOk(c, { error: "repo is required" }, 400);
    if (!/^\d+$/.test(runRaw)) return jsonOk(c, { error: "run must be a non-negative integer (the run number in /actions/runs/<n>)" }, 400);
    const run = Number(runRaw);
    try {
      const result = await fetchForgejoRunArtifacts({ repo, run });
      const artifacts = await Promise.all(result.artifacts.map(async (a) => ({
        ...a,
        name: await guardContent(a.name, { repo, source: `ci-artifact-name (run ${run})`, itemNumber: 0 }),
      })));
      return jsonOk(c, { ...result, artifacts });
    } catch (err) {
      if (err instanceof ForgejoJobLogsError) return jsonOk(c, { error: err.message }, err.status);
      return jsonOk(c, { error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // Issue filers (docs/issue-tracker.md "Issue filers"). Only ever
  // `issueFilerAuthMiddleware`, never `apiAuthMiddleware`: the per-repo filer
  // token reaches these routes and nothing else, and no agent token or
  // operator session reaches them at all.
  app.get("/api/issue-filer/:owner/:name/issues", issueFilerAuthMiddleware, issueFiler.lookupFilerIssueHandler);
  app.post("/api/issue-filer/:owner/:name/issues", issueFilerAuthMiddleware, issueFiler.createFilerIssueHandler);
  app.patch("/api/issue-filer/:owner/:name/issues/:id", issueFilerAuthMiddleware, issueFiler.updateFilerIssueHandler);
  app.post(
    "/api/issue-filer/:owner/:name/issues/:id/attachments",
    issueFilerAuthMiddleware,
    bodyLimit({
      maxSize: MAX_FILER_ATTACHMENT_BYTES,
      onError: (c) => {
        c.header("Content-Type", "application/json");
        return c.body(JSON.stringify({ error: "File too large (max 5 MiB)" }), 413);
      },
    }),
    issueFiler.uploadFilerAttachmentHandler,
  );

  // One-shot completions (docs/completion-api.md). Only ever
  // `completionAuthMiddleware`, never `apiAuthMiddleware`: the per-repo
  // completion token reaches this route and nothing else, and no agent token
  // or operator session reaches it at all.
  app.post(
    COMPLETION_PROXIED_ROUTE,
    completionAuthMiddleware,
    completionBodyLimit,
    completionHandler,
  );

  /**
   * File a native issue. Backs the `claws_create_issue` MCP tool for both
   * interactive sessions and headless agents (#3286) — the write path every
   * new issue is filed through
   * (docs/issue-tracker.md). Mirrors the `/issues` dashboard form's label
   * rules; unlike the form, `repos` is required, since an agent-filed issue
   * with none would sit unplanned with nothing pointing an implementer at it.
   *
   * Before filing it dedupes against open native issues (docs/issue-tracker.md
   * "Dedupe on create"): an open issue with the same `dedupeKey` in the same
   * primary repo is returned instead, for any caller; a strong similarity
   * match (`issue-dedupe.ts`) is returned instead for a headless caller, and
   * blocks a session caller until it passes `force: true`. The issue named by
   * the caller's `origin` (the issue it is working) and every issue linked to
   * it are never similarity matches; dedupe-key matching ignores `origin`.
   *
   * `sessionId` in the body only attributes the issue (author, source, the
   * dedupe reply): `apiAuthMiddleware` accepts a token every agent holds, so
   * nothing proves the caller is that session. An up-front approval
   * (`approveThrough`), which approves on the operator's behalf, is refused
   * here and accepted only on `POST /api/sessions/:sid/issues`, behind the
   * session's own token. A `requirements` field from an older session pod is
   * ignored and logged: agent and session issues skip the requirements stage.
   */
  app.post("/api/issues", apiAuthMiddleware, (c) => createIssueFromRequest(c, null));

  /**
   * `POST /api/issues` for an interactive session, behind its own token
   * (`sessionOwnTokenMiddleware`), so `:sid` is proven and the issue may be
   * filed approved (`approveThrough`). The body's `sessionId` is ignored for `:sid`.
   */
  app.post("/api/sessions/:sid/issues", sessionOwnTokenMiddleware, async (c) => {
    const sid = c.req.param("sid") ?? "";
    if (!/^[a-f0-9]+$/.test(sid)) return jsonOk(c, { error: "Session not found" }, 404);
    const live = await getSessionBackend().getLive(sid);
    if (!live.ok) return jsonOk(c, { error: "Session not found" }, 404);
    return createIssueFromRequest(c, sid);
  });

  /**
   * The body of both issue-create routes. `verifiedSid` is the session the
   * caller proved it is, or null on `POST /api/issues`, where only an
   * unverified `sessionId` attribution is taken from the body.
   */
  async function createIssueFromRequest(c: Context<Env>, verifiedSid: string | null): Promise<Response> {
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { title, body: issueBody, repos: reposInput, labels: labelsInput, sessionId: claimedSessionId, autoPromote, dedupeKey: dedupeKeyInput, force, origin, requirements, approveThrough } = (body ?? {}) as {
      title?: unknown; body?: unknown; repos?: unknown; labels?: unknown; sessionId?: unknown; autoPromote?: unknown;
      dedupeKey?: unknown; force?: unknown; origin?: unknown; requirements?: unknown; approveThrough?: unknown;
    };
    const sessionId = verifiedSid ?? claimedSessionId;
    if (autoPromote !== undefined && typeof autoPromote !== "boolean") {
      return jsonOk(c, { error: "autoPromote must be a boolean when given" }, 400);
    }
    // How far the new issue is approved at filing (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F):
    // `plan` set before a plan exists is the plan's pre-approval.
    if (approveThrough !== undefined && approveThrough !== null && !isApprovedThrough(approveThrough)) {
      return jsonOk(c, { error: `approveThrough must be one of ${APPROVAL_GATES.join(", ")} when given` }, 400);
    }
    // An approval given up front is the operator's, so only an interactive
    // session (whose operator said so), proven by its own token, may give
    // one. A headless agent has no operator to ask; approving its own issue
    // would skip every human gate (#clw_01M3BWP83BQRXE06NWW1GKYT2S).
    const upFront = isApprovedThrough(approveThrough) && approveThrough !== "none" ? approveThrough : null;
    if (upFront && !verifiedSid) {
      return jsonOk(c, { error: "approveThrough can only be set from an interactive session, through /api/sessions/:sid/issues; a headless agent's issue waits for the usual gates" }, 400);
    }
    if (force !== undefined && typeof force !== "boolean") {
      return jsonOk(c, { error: "force must be a boolean when given" }, 400);
    }
    // Agent and session issues skip the requirements stage, so a record an
    // older session pod still sends is dropped rather than refusing the filing.
    if (requirements !== undefined && requirements !== null) {
      log.info(`[issues] ignoring a requirements record supplied with a new issue (${verifiedSid ? `session ${verifiedSid}` : "a headless agent"}): agent and session issues plan from their text`);
    }
    let dedupeKey: string | undefined;
    if (dedupeKeyInput !== undefined && dedupeKeyInput !== null) {
      dedupeKey = typeof dedupeKeyInput === "string" ? dedupeKeyInput.trim().toLowerCase() : "";
      if (!DEDUPE_KEY_PATTERN.test(dedupeKey)) {
        return jsonOk(c, { error: "dedupeKey must be 2-100 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit" }, 400);
      }
    }
    if (typeof title !== "string" || !title.trim()) {
      return jsonOk(c, { error: "title must be a non-empty string" }, 400);
    }
    if (!Array.isArray(reposInput) || reposInput.length === 0 || !reposInput.every((r) => typeof r === "string")) {
      return jsonOk(c, { error: "repos must be a non-empty array of repository full names" }, 400);
    }
    const managed = new Map((await listRepos()).map((r) => [r.fullName.toLowerCase(), r.fullName]));
    const repos: string[] = [];
    for (const raw of reposInput as string[]) {
      const canonical = managed.get(raw.toLowerCase());
      if (!canonical) return jsonOk(c, { error: `${raw} is not a repo Claws manages` }, 400);
      repos.push(canonical);
    }
    // Same rule as the dashboard form: state labels are not offered, since
    // lifecycle is set by moving the issue rather than by a label a caller
    // sends. The retired gate labels are `approveThrough` now.
    const labelsWanted = Array.isArray(labelsInput) ? labelsInput.filter((l): l is string => typeof l === "string") : [];
    const labels = labelsWanted.filter((l) => l in config.LABEL_SPECS && !isStateLabel(l) && !(RETIRED_GATE_LABELS as readonly string[]).includes(l));
    const ignoredLabels = labelsWanted.filter((l) => !labels.includes(l));
    const fromSession = typeof sessionId === "string" && !!sessionId;
    const authorLogin = fromSession
      ? (config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN)
      : clawsIssues.CLAWS_NATIVE_LOGIN;
    const trimmedTitle = title.trim();
    const bodyText = typeof issueBody === "string" ? issueBody : "";
    // A dedicated alert issue (docs/issue-tracker.md "Alert bridges") names the
    // repo owning the service as well as the bridge repo, which stays primary
    // so alert lookup, occurrence counting and dedupe keep working.
    let pinnedPrimary: string | undefined;
    if (dedupeKey?.startsWith("alert-")) {
      const bridges = repos.filter((r) => getRepoConfig(r)?.alertBridge);
      if (bridges.length === 1) {
        const bridgeRepo = bridges[0]!;
        pinnedPrimary = bridgeRepo;
        for (const owner of alertOwnerRepos(getRepoConfig(bridgeRepo)?.alertBridge, dedupeKey)) {
          const canonical = managed.get(owner.toLowerCase());
          if (!canonical) {
            log.warn(`[issues] ${bridgeRepo}'s alertBridge.serviceRepos maps ${dedupeKey} to ${owner}, which Claws does not manage; skipping it`, { repo: bridgeRepo, dedupeKey, owner });
            continue;
          }
          if (canonical !== bridgeRepo && !repos.includes(canonical)) repos.push(canonical);
        }
      }
    }
    const primaryRepo = pinnedPrimary ?? clawsIssues.primaryRepo({ repos });
    const caller = {
      title: trimmedTitle,
      repos,
      dedupeKey,
      origin: typeof origin === "string" && /^[\w.-]+\/[\w.-]+#\S{1,40}$/.test(origin.trim())
        ? origin.trim()
        : fromSession ? `session ${sessionId as string}` : "a headless agent",
    };
    // The native issue the caller is working, named after the `#` of a valid
    // `owner/name#ref` origin (the fallbacks above hold no `#`); null for a
    // session, a forge issue number or no origin.
    const workingIssueRef = caller.origin.includes("#")
      ? canonicalIssueRef(caller.origin.slice(caller.origin.lastIndexOf("#") + 1))
      : null;
    const workingIssueId = isClawsIssueId(workingIssueRef) ? workingIssueRef : null;
    const keptResult = (kept: ClawsIssueRecord, matchedBy: "dedupeKey" | "similarity"): Record<string, unknown> => ({
      deduplicated: true,
      matchedBy,
      id: kept.id,
      ref: `#${kept.id}`,
      url: clawsIssues.dashboardIssueUrl(kept.id),
      title: kept.title,
      repos: kept.repos,
      primaryRepo: clawsIssues.primaryRepo(kept),
      // The approval the kept issue actually holds: a requested `approveThrough` is not applied to it.
      approvedThrough: kept.approved_through ?? "none",
    });
    // An alert inbox is never a dedupe match: a dedicated issue for one of its sections is separate.
    const isInboxRecord = (r: { title: string; filed_title: string | null; labels: string[]; body: string; repos: string[] }): boolean =>
      isAlertInbox({ title: r.title, filedTitle: r.filed_title, labels: r.labels, body: r.body }, getRepoConfig(clawsIssues.primaryRepo(r))?.alertBridge);
    const result = await serialiseIssueCreate(async (): Promise<Record<string, unknown>> => {
      // 1. The caller's own key names the work: honoured for every caller,
      //    with no `force` bypass. An alert inbox never counts as the match.
      if (dedupeKey) {
        const kept = await clawsIssues.findOpenIssueByDedupeKey(primaryRepo, dedupeKey);
        if (kept && !isInboxRecord(kept)) {
          await postDedupeAuditComment(kept, caller);
          return keptResult(kept, "dedupeKey");
        }
      }
      // 2. Title similarity plus shared key terms against every open issue
      //    touching these repos — skipped when the caller passed `force`.
      //    A dedupeKey is a caller-declared identity, so two different keys are
      //    two pieces of work (the alert bridge routes each alertname to the
      //    issue holding its key): a keyed call never similarity-matches an
      //    issue holding another key, for session and headless callers alike.
      //    An issue with no key still matches, and the refiner keys it later.
      //    Alert inboxes are never candidates, whatever their current title.
      //    The issue the caller is working (its `origin` names a native
      //    issue) and every issue linked to it are never similarity matches:
      //    a follow-up shares words with the issue that spawned it.
      if (!force) {
        const excluded = new Set<string>();
        if (workingIssueId) {
          excluded.add(workingIssueId);
          try {
            for (const link of (await listClawsIssueLinks(workingIssueId)) ?? []) excluded.add(link.other_id);
          } catch (err) {
            log.warn("could not read issue links for the similarity dedupe; excluding only the working issue", { component: "issues", issue: workingIssueId }, err);
          }
        }
        // Filter the input, not the ranked output, so the top-N cut only sees
        // eligible records.
        const eligible = (await clawsIssues.listOpenIssuesTouching(repos)).filter(
          (r) => !isInboxRecord(r) && !excluded.has(r.id) && (!dedupeKey || (r.dedupe_keys ?? []).length === 0 || (r.dedupe_keys ?? []).includes(dedupeKey)),
        );
        const candidates = findDuplicateCandidates({ title: trimmedTitle, body: bodyText, repos }, eligible);
        const best = candidates[0];
        if (best?.strong) {
          const listed = candidates.map((m) => ({
            id: m.record.id,
            ref: `#${m.record.id}`,
            url: clawsIssues.dashboardIssueUrl(m.record.id),
            title: m.record.title,
            repos: m.record.repos,
            similarity: Math.round(m.similarity * 100) / 100,
            sharedKeyTerms: m.sharedKeyTerms,
          }));
          if (fromSession) {
            return {
              created: false,
              needsForce: true,
              candidates: listed,
              note: "An open issue looks like the same work. Reference it instead, or call again with force: true if this is different work.",
            };
          }
          await postDedupeAuditComment(best.record, caller);
          return { ...keptResult(best.record, "similarity"), candidates: listed };
        }
      }
      // 3. Nothing open covers it: file it. An agent or session issue skips
      //    the requirements stage: the dispatcher promotes it to Planning with
      //    no record on its next tick (unless `autoPromote` is false), and the
      //    planner plans from its text.
      const id = await clawsIssues.createIssue({
        title: trimmedTitle,
        body: bodyText,
        authorLogin,
        repos,
        labels,
        source: fromSession ? "session" : "agent",
        autoPromote,
        dedupeKey,
        ...(pinnedPrimary ? { primaryRepo: pinnedPrimary } : {}),
        ...(upFront && verifiedSid ? { approvedThrough: upFront, approvedBy: sessionApprover(verifiedSid) } : {}),
      });
      const created: Record<string, unknown> = { id, ref: `#${id}`, url: clawsIssues.dashboardIssueUrl(id), repos, labels, ignoredLabels, primaryRepo };
      if (upFront) created.approvedThrough = upFront;
      if (dedupeKey) created.dedupeKey = dedupeKey;
      // Multi-repo issues (docs/issue-tracker.md "Repositories and the primary
      // repository"): the primary repo owns planning, and one plan covers every
      // named repo's PRs, run one at a time — no companion issues are filed.
      if (repos.length > 1) {
        created.note = `${primaryRepo} is this issue's primary repository: it owns planning, and one plan will cover the PRs needed across ${repos.join(", ")}, run one at a time, with no companion issues.`;
      }
      return created;
    });
    return jsonOk(c, result);
  }

  /**
   * Record a friction note. Backs the `claws_note_friction` MCP tool: it
   * stores one untriaged row and nothing else — no issue, comment, gate event
   * or board change. Any pod token reaches it, so lengths are capped here.
   */
  app.post("/api/friction-notes", apiAuthMiddleware, async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { repo, category, text, reference, sessionId, taskId, origin } = (body ?? {}) as {
      repo?: unknown; category?: unknown; text?: unknown; reference?: unknown; sessionId?: unknown; taskId?: unknown; origin?: unknown;
    };
    if (typeof repo !== "string" || !repo.trim()) return jsonOk(c, { error: "repo must be a repository full name" }, 400);
    const canonical = (await listRepos()).find((r) => r.fullName.toLowerCase() === repo.trim().toLowerCase())?.fullName;
    if (!canonical) return jsonOk(c, { error: `${repo} is not a repo Claws manages` }, 400);
    if (typeof category !== "string" || !(FRICTION_CATEGORIES as readonly string[]).includes(category)) {
      return jsonOk(c, { error: `category must be one of ${FRICTION_CATEGORIES.join(", ")}` }, 400);
    }
    const noteText = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
    if (!noteText || noteText.length > FRICTION_TEXT_MAX) {
      return jsonOk(c, { error: `text must be 1-${FRICTION_TEXT_MAX} characters` }, 400);
    }
    if (reference !== undefined && reference !== null && (typeof reference !== "string" || reference.trim().length > FRICTION_REFERENCE_MAX)) {
      return jsonOk(c, { error: `reference must be at most ${FRICTION_REFERENCE_MAX} characters` }, 400);
    }
    const id = await insertFrictionNote({
      repo: canonical,
      category,
      text: noteText,
      reference: typeof reference === "string" && reference.trim() ? reference.trim() : null,
      taskId: typeof taskId === "number" && Number.isInteger(taskId) && taskId > 0 ? taskId : null,
      sessionId: typeof sessionId === "string" && sessionId ? sessionId.slice(0, 100) : null,
      origin: typeof origin === "string" && origin ? origin.slice(0, 200) : null,
    });
    return jsonOk(c, { ok: true, id });
  });

  /**
   * Create a private repository in the org and bring it under Claws. Backs the
   * `claws_create_repo` MCP tool (#clw_01M6E2HBCJJ79SSFFX3VHSF994). The org is
   * `SELF_REPO`'s owner; the create call uses the admin token (the bot's team
   * cannot create org repos), every later write the bot token. The repo is
   * seeded by `buildRepoSeed` (`claws.json` with a generated avatar,
   * `AGENTS.md` with the host policy, the three `.agents/` role docs and an
   * observability and security policy true of an empty repo), so no baseline
   * scanner files an issue against it for being new; optional `kind`,
   * `purpose` and `files` make the seed specific, each caller file validated
   * and replaced by the static one when it fails (`seed_fallbacks`). This
   * process's repo cache is refreshed before replying, so the dashboard and
   * API see it at once (the controller's background jobs within its
   * five-minute repo cache TTL). A name that already exists is returned as
   * `existed: true` and left untouched when it has `claws.json`; one without
   * is seeded with every seed file it lacks only when it still holds just the
   * `auto_init` commit (a half-finished earlier call), and is otherwise
   * refused with 409.
   */
  app.post("/api/repos", apiAuthMiddleware, async (c) => {
    let parsed: unknown;
    try { parsed = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { name, description, issue_id: issueIdInput, origin, sessionId, kind: kindInput, purpose: purposeInput, files: filesInput } = (parsed ?? {}) as {
      name?: unknown; description?: unknown; issue_id?: unknown; origin?: unknown; sessionId?: unknown; kind?: unknown; purpose?: unknown; files?: unknown;
    };
    if (typeof name !== "string" || !REPO_NAME_PATTERN.test(name)) {
      return jsonOk(c, { error: "name must match ^[a-z0-9][a-z0-9-]{1,63}$ (lowercase letters, digits and '-', 2-64 characters)" }, 400);
    }
    if (description !== undefined && description !== null && (typeof description !== "string" || description.length > 255)) {
      return jsonOk(c, { error: "description must be a string of at most 255 characters" }, 400);
    }
    const desc = typeof description === "string" ? description.trim() : "";
    if (kindInput !== undefined && kindInput !== null && !(SEED_KINDS as unknown[]).includes(kindInput)) {
      return jsonOk(c, { error: `kind must be one of ${SEED_KINDS.join(", ")}` }, 400);
    }
    const kind = (kindInput ?? null) as RepoKind | null;
    if (purposeInput !== undefined && purposeInput !== null && (typeof purposeInput !== "string" || purposeInput.length > MAX_PURPOSE_CHARS)) {
      return jsonOk(c, { error: `purpose must be a string of at most ${MAX_PURPOSE_CHARS} characters` }, 400);
    }
    const purpose = typeof purposeInput === "string" && purposeInput.trim() ? purposeInput.trim() : null;
    const callerFiles: Record<string, string> = {};
    if (filesInput !== undefined && filesInput !== null) {
      if (typeof filesInput !== "object" || Array.isArray(filesInput)) {
        return jsonOk(c, { error: `files must be an object keyed by ${CALLER_SEED_PATHS.join(", ")}` }, 400);
      }
      for (const [key, value] of Object.entries(filesInput)) {
        if (!CALLER_SEED_PATHS.includes(key)) {
          return jsonOk(c, { error: `files may only hold ${CALLER_SEED_PATHS.join(", ")}; ${key} is composed by Claws or not seeded` }, 400);
        }
        if (typeof value !== "string") return jsonOk(c, { error: `files["${key}"] must be a string` }, 400);
        callerFiles[key] = value;
      }
    }
    let issue: NativeIssueRecord | null = null;
    if (issueIdInput !== undefined && issueIdInput !== null && issueIdInput !== "") {
      const ref = typeof issueIdInput === "string" ? issueIdInput.trim().replace(/^#/, "") : "";
      if (!isNativeIssue(ref)) return jsonOk(c, { error: "issue_id must be a Claws-native issue id (clw_…)" }, 400);
      issue = (await clawsIssues.getIssue(ref)) ?? null;
      if (!issue) return jsonOk(c, { error: `Issue ${ref} not found` }, 404);
    }
    const requester = typeof sessionId === "string" && sessionId
      ? `session \`${sessionId.slice(0, 100)}\``
      : typeof origin === "string" && origin.trim() ? `headless agent ${origin.trim().slice(0, 200)}` : "a headless agent";
    const org = config.SELF_REPO.split("/")[0] ?? "";
    const fullName = `${org}/${name}`;
    const url = config.webUrlForRepo(fullName);

    let existing: ForgejoRepoInfo | null = null;
    try {
      existing = await getForgejoRepo(fullName);
    } catch (err) {
      if (!isForgejoMissing(err)) return jsonOk(c, { error: `Could not check for ${fullName}: ${errMessage(err)}` }, 502);
    }

    let repo: ForgejoRepoInfo;
    let seededFiles: string[];
    try {
      if (existing) {
        repo = existing;
        if ((await fetchForgejoFileContent(fullName, "claws.json")) !== null) {
          seededFiles = [];
        } else {
          // Seed an existing repo only when it is a create of ours that stopped
          // before its seed commit: just the auto_init commit on the default
          // branch. Any other repo without claws.json was left out (or taken
          // out) of Claws on purpose, and onboarding it is a reviewed PR.
          const state = await getForgejoRepoSeedState(fullName, repo.defaultBranch);
          if (state.archived || !state.isPrivate) {
            return jsonOk(c, {
              error: `${fullName} already exists but is ${state.archived ? "archived" : "not private"}, so Claws' repo discovery skips it and it will not become managed; ${state.archived ? "unarchive it" : "make it private"} first, or choose another name.`,
              created: false, existed: true, managed: false, repo: fullName, url,
            }, 409);
          }
          if (!state.singleCommit) {
            return jsonOk(c, {
              error: `${fullName} already exists but is not managed by Claws (it has no claws.json) and was not created by claws_create_repo, so it is left alone. Onboarding it is a pull request adding claws.json to it; or choose another name.`,
              created: false, existed: true, managed: false, repo: fullName, url,
            }, 409);
          }
          // commitFiles creates every file, so a file an earlier attempt left behind is skipped.
          seededFiles = ["claws.json"];
          for (const p of SEED_PATHS) {
            if (p !== "claws.json" && (await fetchForgejoFileContent(fullName, p)) === null) seededFiles.push(p);
          }
        }
      } else {
        repo = await createOrgRepo(org, { name, description: desc });
        seededFiles = [...SEED_PATHS];
      }
    } catch (err) {
      if (err instanceof AdminTokenMissingError) return jsonOk(c, { error: err.message }, 503);
      const status = (err as { status?: unknown } | null)?.status;
      if (!existing && status === 409) {
        return jsonOk(c, {
          error: `${fullName} already exists but the Claws bot account cannot see it, so Claws cannot manage it; give the bot's team access to it, or choose another name.`,
          created: false, managed: false, repo: fullName, url,
        }, 409);
      }
      const hint = status === 403 ? " — the Forgejo admin token (forgejoAdminToken) needs the write:organization scope to create org repositories" : "";
      log.warn("repo create failed", { component: "repo-create", repo: fullName, requester, status: typeof status === "number" ? status : undefined }, err);
      return jsonOk(c, { error: `Creating ${fullName} failed: ${errMessage(err)}${hint}` }, 502);
    }

    let seedFallbacks: SeedFallback[] = [];
    if (seededFiles.length > 0) {
      const seed = buildRepoSeed({
        fullName, url, description: desc, kind, purpose, files: callerFiles,
        issue: issue ? { id: issue.id, title: issue.title } : null,
      });
      seedFallbacks = seed.fallbacks;
      for (const f of seedFallbacks) {
        log.warn("repo seed content rejected", { component: "repo-create", repo: fullName, path: f.path, reasons: f.reasons.join("; ") });
      }
      try {
        await commitFiles(fullName, repo.defaultBranch, "Bring the repository under Claws management", seededFiles.map((p) => ({ path: p, content: seed.files[p]! })));
      } catch (err) {
        log.warn("repo seed failed", { component: "repo-create", repo: fullName, requester }, err);
        const listed = seededFiles.length > 1 ? `${seededFiles.slice(0, -1).join(", ")} and ${seededFiles[seededFiles.length - 1]}` : seededFiles.join("");
        return jsonOk(c, {
          error: `${fullName} ${existing ? "exists" : "was created"} but seeding ${listed} failed, so Claws does not manage it yet: ${errMessage(err)}. Call claws_create_repo again with the same name to seed it.`,
          created: !existing, managed: false, repo: fullName, url,
        }, 502);
      }
    }

    clearRepoCache();
    const managed = (await listRepos()).some((r) => r.fullName.toLowerCase() === fullName.toLowerCase());

    if (issue && !issue.repos.some((r) => r.toLowerCase() === fullName.toLowerCase())) {
      if (managed) {
        try {
          await clawsIssues.setRepos(issue.id, [...issue.repos, repo.fullName]);
          const updated = await clawsIssues.getIssue(issue.id);
          await ghCommentOnIssue(
            clawsIssues.primaryRepo(updated ?? { repos: [...issue.repos, repo.fullName] }),
            issue.id,
            `Repository [${repo.fullName}](${url}) ${existing ? "was brought under Claws" : "was created"} by claws_create_repo at the request of ${requester}, and added to this issue's repositories.`,
          );
        } catch (err) {
          log.warn("repo create: linking issue failed", { component: "repo-create", repo: fullName, issue: issue.id }, err);
        }
      }
    }

    log.info(existing ? "repo already existed" : "repo created", {
      component: "repo-create", repo: repo.fullName, requester, seeded: seededFiles.join(",") || "none", managed, issue: issue?.id,
      kind: kind ?? undefined, seed_fallbacks: seedFallbacks.length,
    });
    const note = managed ? undefined : `${repo.fullName} is not in the managed set yet (the repo list may be degraded); it should appear within five minutes.`;
    const seedReply = { seeded: seededFiles, seed_fallbacks: seedFallbacks };
    if (existing) return jsonOk(c, { created: false, existed: true, repo: repo.fullName, url, defaultBranch: repo.defaultBranch, managed, ...seedReply, ...(note ? { note } : {}) });
    return jsonOk(c, { created: true, repo: repo.fullName, url, defaultBranch: repo.defaultBranch, managed, ...seedReply, ...(note ? { note } : {}) });
  });

  /**
   * Post an informational note on a native issue. A note is always a
   * Claws-marked comment, so no feedback reader counts it and it never
   * withdraws approval or triggers a re-plan. `session` is the id the caller
   * proved with `sessionOwnTokenMiddleware`, or null for any other caller;
   * only a verified session's note carries the `_Note from session <id> —`
   * line whose `claws-phase-done:` claim `parsePhaseClaims` honours.
   */
  async function postIssueNote(repo: string, id: string, commentBody: string, session: string | null): Promise<void> {
    const origin = session ? `session ${session}` : "a Claws agent";
    const prefixed = `_Note from ${origin} — context for this issue's planner and implementer, not feedback on its plan._\n\n${commentBody}`;
    await ghCommentOnIssue(repo, id, prefixed, { agentName: ISSUE_NOTE_AGENT });
    log.info("issue note posted", {
      component: "issue-comments",
      issue: id,
      ...(session ? { session } : {}),
    });
  }

  /**
   * A note from an interactive session, behind `sessionOwnTokenMiddleware`:
   * the session's own per-launch token proves `:sid`, so this is the only
   * route that stamps `_Note from session <sid> —` (#clw_01M70G1VXV5MS5GAX1MQSC45TK).
   */
  app.post("/api/sessions/:sid/issues/:id/notes", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c, { allowClosed: true, allowUnassigned: true, allowOrphaned: true });
    if (guard instanceof Response) return guard;
    const { sid, id, record } = guard;
    let parsed: unknown;
    try { parsed = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const commentBody = (parsed as { body?: unknown } | null)?.body;
    if (typeof commentBody !== "string" || !commentBody.trim()) {
      return jsonOk(c, { error: "body must be a non-empty string" }, 400);
    }
    await postIssueNote(eventRepo(record), id, commentBody, sid);
    return jsonOk(c, { ok: true, id, url: clawsIssues.dashboardIssueUrl(id), note: true });
  });

  /**
   * Feedback from an interactive session, posted as the operator with no
   * Claws marker. Behind `sessionOwnTokenMiddleware`, so only a caller that
   * proved `:sid` can post as the operator (#clw_01M70NNZKY94WP6293S1Q2MDJX).
   */
  app.post("/api/sessions/:sid/issues/:id/comments", sessionOwnTokenMiddleware, async (c) => {
    const guard = await sessionIssueGuard(c, { allowClosed: true, allowUnassigned: true, allowOrphaned: true });
    if (guard instanceof Response) return guard;
    const { sid, id, record } = guard;
    let parsed: unknown;
    try { parsed = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const commentBody = (parsed as { body?: unknown } | null)?.body;
    if (typeof commentBody !== "string" || !commentBody.trim()) {
      return jsonOk(c, { error: "body must be a non-empty string" }, 400);
    }
    await clawsIssues.commentOnIssue(eventRepo(record), id, commentBody, config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN);
    log.info("issue feedback posted", { component: "issue-comments", issue: id, session: sid });
    return jsonOk(c, { ok: true, id, url: clawsIssues.dashboardIssueUrl(id), feedback: true });
  });

  /**
   * Comment on a native issue. Backs the `claws_comment_on_issue` MCP tool
   * (#3286). Every holder of this route's token can send any `sessionId`, so
   * nothing here posts as the operator: the comment always goes through the
   * `github.ts` façade, which stamps the Claws marker, so it is neither
   * feedback nor a phase claim. A session's feedback goes through
   * `POST /api/sessions/:sid/issues/:id/comments`.
   * A step claim that would land Claws-marked here (any note, or a
   * claim-only comment) is refused with 400 naming `claws_mark_phase_done`
   * and the Mark step done button.
   */
  app.post("/api/issues/:id/comments", apiAuthMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return jsonOk(c, { error: "Issue not found" }, 404);
    let parsed: unknown;
    try { parsed = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { body: commentBody, note } = (parsed ?? {}) as { body?: unknown; note?: unknown };
    if (typeof commentBody !== "string" || !commentBody.trim()) {
      return jsonOk(c, { error: "body must be a non-empty string" }, 400);
    }
    if (note !== undefined && typeof note !== "boolean") {
      return jsonOk(c, { error: "note must be a boolean" }, 400);
    }
    const repo = eventRepo(loaded.record);
    // Everything posted here is Claws-marked, so a claim in a note or a
    // claim-only comment never counts. Refuse both rather than post a claim
    // that silently does nothing.
    if ((note === true && PHASE_CLAIM_RE.test(stripQuotedRegions(commentBody))) || isPhaseClaimOnly(commentBody)) {
      return jsonOk(c, { error: STEP_CLAIM_REFUSAL }, 400);
    }
    if (note === true) {
      // Every holder of this route's tokens can send any `sessionId`, so a
      // note posted here is always "a Claws agent"'s; only the session route
      // below, which verifies the session's own token, writes `session <id>`
      // — the line `parsePhaseClaims` trusts for a note's claim.
      await postIssueNote(repo, loaded.id, commentBody, null);
      return jsonOk(c, { ok: true, id: loaded.id, url: clawsIssues.dashboardIssueUrl(loaded.id), note: true });
    }
    await ghCommentOnIssue(repo, loaded.id, commentBody);
    return jsonOk(c, { ok: true, id: loaded.id, url: clawsIssues.dashboardIssueUrl(loaded.id), marked: true });
  });

  /**
   * Long-poll for Claws-originated GitHub state changes (#2832). Backs the
   * `claws_wait_for_change` MCP tool, so a session driving the /claws-ship skill can
   * block until Claws acts instead of sleeping and re-polling `gh`. One
   * request is held at most 270 s; the tool chains 240 s requests into a wait
   * of up to an hour, so no single request outlives a proxy or fetch timeout.
   * `interrupted: true` means this process is shutting down.
   */
  app.get("/api/events", apiAuthMiddleware, async (c) => {
    const afterRaw = c.req.query("after");
    let after: number | undefined;
    if (afterRaw !== undefined && afterRaw !== "") {
      const parsed = Number(afterRaw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return jsonOk(c, { error: "after must be a non-negative integer" }, 400);
      }
      after = parsed;
    }

    const split = (v: string | undefined): string[] =>
      (v ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0);

    const items: config.IssueRef[] = [];
    for (const raw of split(c.req.query("items"))) {
      const ref = canonicalIssueRef(raw);
      if (ref === null || (typeof ref === "number" && ref <= 0)) {
        return jsonOk(c, { error: `items must be issue references (got "${raw}")` }, 400);
      }
      if (items.length < 20) items.push(ref);
    }

    // Each entry is `kind` or `kind:detail` (github-events.ts parseKindFilter).
    const kinds: KindFilter[] = [];
    for (const raw of split(c.req.query("kinds"))) {
      const parsed = parseKindFilter(raw);
      if (!parsed) {
        const kind = raw.split(":")[0]!.trim();
        const error = (GITHUB_EVENT_KINDS as string[]).includes(kind)
          ? `empty detail in event kind "${raw}"`
          : `unknown event kind "${kind}"`;
        return jsonOk(c, { error }, 400);
      }
      kinds.push(parsed);
    }

    const timeoutRaw = Number(c.req.query("timeout") ?? "240");
    const timeoutSec = Number.isFinite(timeoutRaw) ? Math.min(270, Math.max(0, timeoutRaw)) : 240;

    const filter: EventFilter = {};
    const repo = c.req.query("repo");
    if (repo) filter.repo = repo;
    if (items.length > 0) filter.items = items;
    if (kinds.length > 0) filter.kinds = kinds;

    return jsonOk(c, await waitForEvents(after, filter, timeoutSec * 1000));
  });

  /**
   * claws-state MCP over streamable HTTP for k8s-pod sessions (#3056). No auth
   * middleware: the handler accepts only the per-session bearer token for :id.
   * A `claws_wait_for_change` call is held up to an hour, answered over SSE
   * with a keepalive comment every 25 s (claws-state-http.ts) so no idle
   * timeout between the pod and here fires; `server.requestTimeout` bounds
   * only receiving the request, not the response.
   */
  app.post("/mcp/sessions/:id", createClawsStateMcpHandler(app));
  app.get("/mcp/sessions/:id", () => mcpMethodNotAllowed());
  app.delete("/mcp/sessions/:id", () => mcpMethodNotAllowed());

  /**
   * A session pod's exit report (#3311): the process's exit code and final
   * output, POSTed by the pod's terminal server just before it exits so the
   * output outlives the pod. No auth middleware: the backend accepts only the
   * session's own terminal token. Never log the token.
   */
  app.post("/session-pods/:id/exit", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return c.body(null, 404);
    const bearer = /^Bearer\s+(\S+)\s*$/.exec(c.req.header("authorization") ?? "");
    if (!bearer) return c.body(null, 401);
    let raw: string;
    try {
      // Streams with a running byte count, so a chunked body cannot be buffered past the cap.
      raw = await readTextBody(c, SESSION_EXIT_REPORT_MAX_BYTES);
    } catch {
      return c.body(null, 413);
    }
    let parsed: z.infer<typeof SessionExitReportSchema>;
    try {
      const result = SessionExitReportSchema.safeParse(JSON.parse(raw));
      if (!result.success) return c.body(null, 400);
      parsed = result.data;
    } catch {
      return c.body(null, 400);
    }
    const outcome = await getSessionBackend().recordPodExit(id, bearer[1], parsed);
    return c.body(null, outcome === "ok" ? 204 : outcome === "denied" ? 401 : 503);
  });

  // A session pod fetches the files attached on its New Session form before its agent starts.
  app.get("/api/sessions/:sid/attachments/:aid", sessionOwnTokenMiddleware, async (c) => {
    const sid = c.req.param("sid");
    const aid = c.req.param("aid");
    const row = isSessionAttachmentId(aid) ? await getSessionAttachment(aid) : undefined;
    if (!row || row.session_id !== sid) return jsonOk(c, { error: "Attachment not found" }, 404);
    let opened: Awaited<ReturnType<typeof openSessionAttachment>>;
    try {
      opened = await openSessionAttachment(row, c.req.raw.signal);
    } catch (err) {
      log.warn(`[server] Session ${sid}: could not read attachment ${aid}: ${err}`);
      return jsonOk(c, { error: "Attachment store unavailable" }, 502);
    }
    if (!opened) return jsonOk(c, { error: "Attachment file missing" }, 404);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Length", String(opened.size));
    c.header("Cache-Control", "no-store");
    return c.body(opened.body, 200);
  });

  /**
   * The work row an agent-pod API request speaks for, or the error to answer
   * with: 404 for a malformed :rowId, 401 unless the bearer's SHA-256 is the
   * row's `agent_mcp_token_sha256` while that token is live, 503 when the
   * database is unreachable. Never log the token.
   */
  async function authenticateAgentPod(c: Ctx): Promise<{ row: NonNullable<Awaited<ReturnType<typeof getWorkRow>>> } | { error: Response }> {
    const rowIdParam = c.req.param("rowId") ?? "";
    if (!/^[1-9][0-9]{0,15}$/.test(rowIdParam)) return { error: c.body(null, 404) };
    const bearer = /^Bearer\s+(\S+)\s*$/.exec(c.req.header("authorization") ?? "");
    if (!bearer) return { error: jsonOk(c, { error: "unauthorized" }, 401) };
    let row: Awaited<ReturnType<typeof getWorkRow>>;
    try {
      row = await getWorkRow(Number(rowIdParam));
    } catch {
      // Nothing ran yet, so the pod may retry.
      return { error: jsonOk(c, { error: "database unavailable" }, 503) };
    }
    if (!row?.agent_mcp_token_sha256 || !agentPodTokenLive(row)
      || !safeCompare(hashAgentMcpToken(bearer[1]), row.agent_mcp_token_sha256)) {
      return { error: jsonOk(c, { error: "unauthorized" }, 401) };
    }
    return { row };
  }

  /**
   * The agent-pod ops API (#clw_01M386P9KPDEVV33TKY512HHBC): an agent pod's
   * `db-remote.ts` calls one enumerated op from `agent-pod-ops.ts` per
   * request, body `{ "args": [...] }`, reply `{ "result": ... }`. No auth
   * middleware: only the bearer whose SHA-256 is row :rowId's
   * `agent_mcp_token_sha256`, while that token is live, is accepted. Never
   * log the token.
   */
  app.post("/agent-pods/:rowId/ops/:op", async (c) => {
    const auth = await authenticateAgentPod(c);
    if ("error" in auth) return auth.error;
    const { row } = auth;
    let raw: string;
    try {
      raw = await readTextBody(c, AGENT_POD_OPS_MAX_BYTES);
    } catch {
      return jsonOk(c, { error: "request body too large" }, 413);
    }
    let args: unknown;
    try {
      const parsed = decodeWire(raw);
      args = typeof parsed === "object" && parsed !== null ? (parsed as { args?: unknown }).args : undefined;
    } catch {
      return jsonOk(c, { error: "invalid JSON" }, 400);
    }
    const outcome = await executeAgentPodOp(row, c.req.param("op"), args);
    c.header("Content-Type", "application/json");
    if (outcome.status !== 200) return c.body(JSON.stringify({ error: outcome.error }), outcome.status);
    return c.body(encodeWire({ result: outcome.result }), 200);
  });

  /**
   * A native issue attachment's bytes for an agent pod, whose HOME has no
   * `issue-attachments/` (`db-remote.ts`' remoteAttachmentReader). Streamed,
   * never through the JSON ops API. Same auth as the ops API and, like the
   * `getClawsIssueAttachment` op, unscoped beyond it: the pod checks the row
   * belongs to the issue it is processing before asking.
   */
  app.get("/agent-pods/:rowId/attachments/:attachmentId", async (c) => {
    const auth = await authenticateAgentPod(c);
    if ("error" in auth) return auth.error;
    const parsed = parseAttachmentUrl(`/issues/${PENDING_URL_SEGMENT}/attachments/${c.req.param("attachmentId")}`);
    if (!parsed) return textPlain(c, "attachment not found", 404);
    const found = await readIssueAttachment(parsed.attachmentId);
    if (!found) return textPlain(c, "attachment not found", 404);
    let opened: Awaited<ReturnType<typeof openIssueAttachment>>;
    try {
      opened = await openIssueAttachment(found);
    } catch (err) {
      log.warn(`[server] Attachment ${found.row.id} could not be read for an agent pod: ${err}`);
      return textPlain(c, "attachment store unavailable", 502);
    }
    if (!opened) return textPlain(c, "attachment file missing", 404);
    // The raw stored type, as the in-process read returns: no browser renders this.
    c.header("Content-Type", found.row.content_type);
    c.header("Content-Length", String(opened.size));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    return c.body(opened.body, 200);
  });
}
