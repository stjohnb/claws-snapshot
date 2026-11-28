/** Authenticated `/queue/*` actions, `POST /jobs`, `POST /config*` and the WhatsApp writes. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import { z } from "zod";
import type { Context } from "hono";
import { VALID_AGENT_NAMES, getConfigForDisplay, writeConfig, getUnknownConfigKeys, removeConfigKeys, MAC_RUNNERS, type ConfigFile, type MacRunner } from "../../config.js";
import * as config from "../../config.js";
import { mergePR, removeQueueItem, listRepos, listPRs, addLabel, removeLabel, getPRChangedFiles, infraPathsIn, type PR } from "../../github.js";
import { LABELS } from "../../config.js";
import { commentOnIssue as ghCommentOnIssue } from "../../github.js";
import { DEFAULT_TIER_TABLE, defaultTierFieldName, normalizeTier, shippedModelDefault, shippedModelDefaultKeys, type ModelTier } from "../../model-selector.js";
import { clearPrHold } from "../../pr-hold.js";
import { getRecentWhatsappEvents, listQueuedWork, setWorkPriority, resetCIFixerBreakerGrants, getClawsPr, upsertClawsPr } from "../../db.js";
import * as log from "../../log.js";
import { finalizeMergedClawsPR } from "../../agents/auto-merger.js";
import { unpair } from "../../whatsapp.js";
import { maxApproval } from "../../issue-approval.js";
import { canonicalIssueRef, sameIssueRef } from "../../issue-id.js";
import { listsJob } from "../../pages/jobs-matrix.js";
import { isSubScannerName } from "../../jobs/scanner-dispatcher.js";
import { PR_DISPATCHER_GATES } from "../../jobs/pr-dispatcher.js";
import { cancelRuns, setWorkflowEnabled } from "../../forgejo-run-control.js";
import { recordPrMerged } from "../../gate-events.js";
import { linkedIssueRefFromPR } from "../../issue-link.js";
import { extractRelatedNumbers } from "../../github-events.js";
import { type Env, jsonOk, parseFormBody, readTextBody } from "../http.js";
import { authMiddleware, sessionSubject } from "../auth.js";
import { DashboardCancelRunSchema, DashboardWorkflowToggleSchema, MarkAutomergeSchema, PriorityLabelSchema, RepoItemSchema, RepoNumberSchema, RepoPrNumberSchema, findConfiguredRepo, isConfiguredRepo, manualWarningFor, recordMergeApproval } from "../shared.js";
import { checkedApproval, runControlFailure } from "../approval-actions.js";
import { Hono } from "hono";
import type { RouteContext } from "./context.js";

export function registerQueueRoutes(app: Hono<Env>, ctx: RouteContext): void {
  const { controller } = ctx;
  app.post("/queue/refresh", authMiddleware, async (c) => {
    const jobs = ["issue-dispatcher", "pr-dispatcher"];
    const results: Record<string, string> = {};
    for (const name of jobs) {
      results[name] = await controller.triggerJob(name);
    }
    return jsonOk(c, { results });
  });

  app.post("/queue/merge", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, prNumber, confirmInfra, confirmManual } = RepoItemSchema.parse(JSON.parse(body));
      const repoObj = await findConfiguredRepo(repo);
      if (!repoObj) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      const manualWarning = await manualWarningFor(repo, prNumber);
      if (manualWarning && !confirmManual) {
        return jsonOk(c, { error: `${manualWarning}; reload the page and confirm` }, 409);
      }
      const infra = await infraPathsIn(await getPRChangedFiles(repo, prNumber), repo);
      if (infra.length > 0 && !confirmInfra) {
        return jsonOk(c, { error: `PR touches infrastructure (${infra.slice(0, 5).join(", ")}); reload the page and confirm to merge` }, 409);
      }
      const prFromList = (await listPRs(repoObj.fullName).catch(() => [])).find((p) => p.number === prNumber);
      await recordMergeApproval(c, repo, prNumber);
      await mergePR(repo, prNumber);
      removeQueueItem(repo, prNumber);
      try {
        // The row's recorded issue first (#clw_01M7FC1ARKV7AYR9C0EGC26S8F),
        // then the branch / body convention for a PR with no recorded relation.
        const row = await getClawsPr(repo, prNumber).catch(() => null);
        const recorded = [row?.issueRef, row?.issueId]
          .map((raw) => (raw ? canonicalIssueRef(raw) : null))
          .filter((ref): ref is NonNullable<typeof ref> => ref !== null && ref !== 0);
        const linked = prFromList ? linkedIssueRefFromPR(prFromList) : null;
        await recordPrMerged(repo, prNumber, [
          ...recorded,
          ...(linked !== null && linked !== 0 ? [linked] : []),
          ...extractRelatedNumbers(`${prFromList?.title ?? ""}\n${prFromList?.body ?? ""}`),
        ]);
      } catch (err) {
        log.warn(`[queue/merge] Could not record pr-merged for ${repo}#${prNumber}: ${err}`);
      }
      try {
        await finalizeMergedClawsPR(repoObj, prFromList ?? { number: prNumber, title: "", headRefName: "", body: undefined }, "dashboard");
      } catch (err) {
        log.warn(`[queue/merge] Post-merge cleanup failed for ${repo}#${prNumber}: ${err}`);
      }
      return jsonOk(c, { result: "merged" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/skip", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, number } = RepoNumberSchema.parse(JSON.parse(body));
      const items = [...(config.SKIPPED_ITEMS as Array<{ repo: string; number: config.IssueRef }>)];
      if (!items.some((i) => i.repo === repo && i.number === number)) {
        items.push({ repo, number });
      }
      await writeConfig({ skippedItems: items });
      removeQueueItem(repo, number);
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/unskip", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, number } = RepoNumberSchema.parse(JSON.parse(body));
      const items = (config.SKIPPED_ITEMS as Array<{ repo: string; number: config.IssueRef }>).filter(
        (i) => !(i.repo === repo && i.number === number),
      );
      await writeConfig({ skippedItems: items });
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/prioritize", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, number } = RepoNumberSchema.parse(JSON.parse(body));
      const items = [...(config.PRIORITIZED_ITEMS as Array<{ repo: string; number: config.IssueRef }>)];
      if (!items.some((i) => i.repo === repo && i.number === number)) {
        items.push({ repo, number });
      }
      await writeConfig({ prioritizedItems: items });
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/deprioritize", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, number } = RepoNumberSchema.parse(JSON.parse(body));
      const items = (config.PRIORITIZED_ITEMS as Array<{ repo: string; number: config.IssueRef }>).filter(
        (i) => !(i.repo === repo && i.number === number),
      );
      await writeConfig({ prioritizedItems: items });
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/mark-refined", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = RepoNumberSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo or number");
      const { repo, number } = parsed.data;
      if (!(await isConfiguredRepo(repo))) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      // The old Refined: approve the issue through Plan — the approval track's
      // Plan gate, never lowering a Merge approval.
      const result = await checkedApproval(repo, number, (current) => maxApproval(current, "plan"), sessionSubject(c));
      if (!result.ok) return jsonOk(c, { error: result.error }, result.status);
      removeQueueItem(repo, number);
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/priority-label", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = PriorityLabelSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo, number or add");
      const { repo, number, add } = parsed.data;
      if (!(await isConfiguredRepo(repo))) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      if (add) {
        await addLabel(repo, number, LABELS.priority);
      } else {
        await removeLabel(repo, number, LABELS.priority);
      }
      const rows = await listQueuedWork();
      await Promise.all(
        rows
          .filter((r) => r.repo === repo && sameIssueRef(r.item_number, number))
          .map((r) => setWorkPriority(r.id, add)),
      );
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/mark-automerge", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = MarkAutomergeSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo or number");
      const { repo, number, alsoRefine, confirmManual } = parsed.data;
      if (!(await isConfiguredRepo(repo))) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      const manualWarning = await manualWarningFor(repo, number);
      if (manualWarning && !confirmManual) {
        return jsonOk(c, { error: `${manualWarning}; reload the page and confirm` }, 409);
      }
      // A PR's approval is its row alone; an issue's is its stored approval,
      // which Merge raises through Plan as well — so `alsoRefine` (Refine &
      // Merge) needs no second write.
      const isPr = await recordMergeApproval(c, repo, number);
      if (!isPr) {
        const result = await checkedApproval(repo, number, () => "merge", sessionSubject(c));
        if (!result.ok) return jsonOk(c, { error: result.error }, result.status);
        if (alsoRefine) removeQueueItem(repo, number);
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  // Withdraws one PR's merge approval (its row's approver and timestamp only);
  // the linked issue's approval and any infra approval stay as they are.
  app.post("/queue/unmark-automerge", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = RepoPrNumberSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo or number");
      const { repo, number } = parsed.data;
      if (!(await isConfiguredRepo(repo))) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      const row = await getClawsPr(repo, number);
      if (row?.mergeApprovedAt) {
        await upsertClawsPr(repo, number, { mergeApprovedBy: null, mergeApprovedAt: null });
        log.info("withdrew PR merge approval", { component: "server", repo, pr: number, by: sessionSubject(c), previousApprover: row.mergeApprovedBy ?? null });
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/mark-problematic", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = RepoNumberSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo or number");
      const { repo, number } = parsed.data;
      if (!(await isConfiguredRepo(repo))) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      await addLabel(repo, number, LABELS.problematic);
      removeQueueItem(repo, number);
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/unmark-problematic", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = RepoPrNumberSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo or number");
      const { repo, number } = parsed.data;
      if (!(await isConfiguredRepo(repo))) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      if (!(await removeLabel(repo, number, LABELS.problematic))) {
        return jsonOk(c, { error: `Failed to remove the ${LABELS.problematic} label` }, 500);
      }
      // Advance the budget floor too, otherwise the pre-existing attempts still
      // inside the 24h window re-trip the breaker on the very next sweep.
      await resetCIFixerBreakerGrants(repo, number);
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  // A PR hold is the row's manual_action_reason alone — no forge label — so
  // this is how a human lifts it, besides moving the linked issue out of
  // Blocked (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK).
  app.post("/queue/clear-manual-action", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = RepoPrNumberSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo or number");
      const { repo, number } = parsed.data;
      if (!(await isConfiguredRepo(repo))) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      const reason = (await getClawsPr(repo, number))?.manualActionReason ?? null;
      await clearPrHold(repo, number);
      // The audit comment is best-effort: the hold is already lifted above.
      if (reason !== null) {
        try {
          await ghCommentOnIssue(repo, number, `The hold recorded on this PR (\`${reason}\`) was cleared from the dashboard, so Claws will merge it under the usual rules.`);
        } catch (err) {
          log.warn(`[server] PR ${repo}#${number}: failed to post clear-manual-action audit comment: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  /**
   * Parse a dashboard Actions-control body with `schema` and check its repo is
   * managed (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y). Answers the body, or the refusal.
   */
  async function dashboardRepoGuard<T extends z.ZodTypeAny>(c: Context<Env>, schema: T): Promise<Response | z.infer<T>> {
    let raw: unknown;
    try { raw = JSON.parse(await readTextBody(c)); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return jsonOk(c, { error: `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` }, 400);
    if (!(await isConfiguredRepo((parsed.data as { repo: string }).repo))) return jsonOk(c, { error: "Repository not configured" }, 403);
    return parsed.data;
  }

  // The repo page's CI queue Cancel button: cancel one Forgejo Actions run.
  app.post("/queue/cancel-run", authMiddleware, async (c) => {
    const body = await dashboardRepoGuard(c, DashboardCancelRunSchema);
    if (body instanceof Response) return body;
    try {
      return jsonOk(c, { ok: true, ...(await cancelRuns(body.repo, { runs: [body.run] }, "dashboard")) });
    } catch (err) {
      return runControlFailure(c, err);
    }
  });

  // The /prs row's Cancel waiting runs button: cancel the PR's waiting runs
  // and note them on the PR.
  app.post("/queue/cancel-pr-runs", authMiddleware, async (c) => {
    const body = await dashboardRepoGuard(c, RepoPrNumberSchema);
    if (body instanceof Response) return body;
    const { repo, number } = body;
    let result: Awaited<ReturnType<typeof cancelRuns>>;
    try {
      result = await cancelRuns(repo, { prNumbers: [number] }, "dashboard");
    } catch (err) {
      return runControlFailure(c, err);
    }
    if ("cancelled" in result && result.cancelled.length > 0) {
      const list = result.cancelled.map((e) => `${e.run} (\`${e.workflow}\`)`).join(", ");
      // Best-effort: the runs are already cancelled.
      try {
        await ghCommentOnIssue(repo, number, `CI run${result.cancelled.length === 1 ? "" : "s"} ${list} ${result.cancelled.length === 1 ? "was" : "were"} cancelled from the dashboard. Re-run cancelled jobs with the PR's re-run, or push a new commit.`);
      } catch (err) {
        log.warn(`[server] PR ${repo}#${number}: failed to post cancel-pr-runs audit comment: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return jsonOk(c, { ok: true, ...result });
  });

  // The Workflows list's and disabled-workflow banner's Disable / Enable buttons.
  app.post("/queue/workflow-enabled", authMiddleware, async (c) => {
    const body = await dashboardRepoGuard(c, DashboardWorkflowToggleSchema);
    if (body instanceof Response) return body;
    try {
      return jsonOk(c, { ok: true, ...(await setWorkflowEnabled(body.repo, body.workflow, body.enabled, "dashboard")) });
    } catch (err) {
      return runControlFailure(c, err);
    }
  });

  app.post("/jobs", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);

    try {
      // Only jobs the scheduler marks `repoToggle` have a checkbox. Until the
      // controller has published its job list that set is empty, and saving
      // would read every host entry as dead, so refuse rather than wipe config.
      const toggleable = await controller.repoToggleableJobs();
      if (toggleable.size === 0) {
        log.warn("[jobs] Refused to save job toggles: the controller has not published its job list");
        return c.redirect("/jobs", 303);
      }
      const repos = await listRepos();
      const newDisabled: Record<string, string[]> = {};
      // Jobs actually registered on the scheduler. A name that is neither
      // registered nor a sub-scanner name or alias is a job that no longer
      // exists (#2936). Guarded on non-empty for the same reason the repos list
      // is below: a degenerate view of the world must not wipe config.
      const registeredJobNames = new Set((await controller.jobStates()).keys());
      const droppedDead: string[] = [];
      const droppedCovered: string[] = [];

      for (const repo of repos) {
        const disabledJobs: string[] = [];
        const hostEntry = config.DISABLED_JOBS_BY_REPO[repo.fullName] ?? [];
        // Jobs the repo's own claws.json disables render as disabled checkboxes
        // that submit nothing; skip them so a locked cell is not mirrored into
        // disabledJobsByRepo (#2885). A host entry naming the same job is now
        // redundant — the file wins and locks it — so it is retired here (#2936).
        const locked = new Set(config.getLockedJobsForRepo(repo.fullName));
        for (const job of toggleable.keys()) {
          if (listsJob([...locked], job)) {
            if (hostEntry.includes(job)) droppedCovered.push(`${repo.fullName}:${job}`);
            continue;
          }
          const fieldName = `${repo.fullName}::${job}`;
          const checked = params[fieldName] === "true";
          if (!checked) disabledJobs.push(job);
        }
        for (const job of hostEntry) {
          if (toggleable.has(job) || disabledJobs.includes(job)) continue;
          if (locked.has(job)) {
            droppedCovered.push(`${repo.fullName}:${job}`);
            continue;
          }
          if (registeredJobNames.size > 0 && !registeredJobNames.has(job) && !isSubScannerName(job) && !(PR_DISPATCHER_GATES as readonly string[]).includes(job)) {
            droppedDead.push(`${repo.fullName}:${job}`);
            continue;
          }
          // triage-claws-errors only ever acts on the self repo; elsewhere it is a no-op.
          if (job === "triage-claws-errors" && repo.fullName !== config.SELF_REPO) {
            droppedDead.push(`${repo.fullName}:${job}`);
            continue;
          }
          // A real job with no matrix column (a pipeline job or a single
          // sub-scanner) — carry it forward so nothing turns on (#2625).
          disabledJobs.push(job);
        }
        if (disabledJobs.length > 0) {
          newDisabled[repo.fullName] = disabledJobs;
        }
      }

      if (droppedDead.length > 0) {
        log.info(`[jobs] Dropped disabledJobsByRepo entries for jobs that no longer exist or have no per-repo effect: ${droppedDead.join(", ")}`);
      }
      if (droppedCovered.length > 0) {
        log.info(`[jobs] Dropped disabledJobsByRepo entries already covered by the repo's claws.json: ${droppedCovered.join(", ")}`);
      }

      const existingDisabled = config.DISABLED_JOBS_BY_REPO;
      if (repos.length === 0) {
        // Degenerate discovery (an API outage, say) must not wipe the map.
        for (const [repoFullName, jobs] of Object.entries(existingDisabled)) {
          if (jobs.length > 0) newDisabled[repoFullName] = [...jobs];
        }
      } else {
        // Entries for repos Claws no longer monitors are inert — no job runs on
        // an unmonitored repo — and archived/renamed repos accumulate there
        // forever otherwise. If such a repo comes back, its own claws.json is
        // the source of truth (#2898).
        const dropped = Object.keys(existingDisabled).filter((name) => !repos.some((r) => r.fullName === name));
        if (dropped.length > 0) log.info(`[jobs] Dropped disabledJobsByRepo entries for unmonitored repos: ${dropped.join(", ")}`);
      }

      await writeConfig({ disabledJobsByRepo: newDisabled });

      return c.redirect("/jobs?saved=1", 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to save job toggles: ${message}`);
      return c.redirect("/jobs", 303);
    }
  });

  app.post("/config/remove-unknown-keys", authMiddleware, async (c) => {
    const unknownKeys = Array.from(getUnknownConfigKeys());
    if (unknownKeys.length > 0) {
      try {
        await removeConfigKeys(unknownKeys);
        return c.redirect("/config?saved=1", 303);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to remove unknown keys: ${message}`);
        return c.redirect("/config", 303);
      }
    }
    return c.redirect("/config", 303);
  });

  app.post("/config", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    const updates: Partial<ConfigFile> = {};

    if (params["selfRepo"] !== undefined) updates.selfRepo = params["selfRepo"];
    if (params["logRetentionDays"] !== undefined) {
      const v = parseInt(params["logRetentionDays"], 10);
      if (v > 0) updates.logRetentionDays = v;
    }
    if (params["logRetentionPerJob"] !== undefined) {
      const v = parseInt(params["logRetentionPerJob"], 10);
      if (v >= 0) updates.logRetentionPerJob = v;
    }

    if (params["slackWebhook"] !== undefined) updates.slackWebhook = params["slackWebhook"];
    if (params["slackBotToken"] !== undefined) updates.slackBotToken = params["slackBotToken"];
    if (params["slackIdeasChannel"] !== undefined) updates.slackIdeasChannel = params["slackIdeasChannel"];
    if (params["whatsappAllowedNumbers"] !== undefined) {
      updates.whatsappAllowedNumbers = params["whatsappAllowedNumbers"].split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (params["openaiApiKey"] !== undefined) updates.openaiApiKey = params["openaiApiKey"];
    if (params["oidcBaseUrl"] !== undefined) updates.oidcBaseUrl = params["oidcBaseUrl"];
    if (params["oidcApplicationSlug"] !== undefined) updates.oidcApplicationSlug = params["oidcApplicationSlug"];
    if (params["oidcClientId"] !== undefined) updates.oidcClientId = params["oidcClientId"];
    if (params["oidcClientSecret"] !== undefined) updates.oidcClientSecret = params["oidcClientSecret"];
    if (params["oidcRedirectUri"] !== undefined) updates.oidcRedirectUri = params["oidcRedirectUri"];
    if (params["dashboardUrl"] !== undefined) updates.dashboardUrl = params["dashboardUrl"];
    if (params["emailUser"] !== undefined) updates.emailUser = params["emailUser"];
    if (params["emailAppPassword"] !== undefined) updates.emailAppPassword = params["emailAppPassword"];
    if (params["emailRecipient"] !== undefined) updates.emailRecipient = params["emailRecipient"];

    if (params["runners"] !== undefined) {
      try {
        const parsed = JSON.parse(params["runners"]);
        if (Array.isArray(parsed)) updates.runners = parsed;
      } catch {
        // Invalid JSON — skip silently
      }
    }

    if (params["macRunners"] !== undefined) {
      try {
        const parsed = JSON.parse(params["macRunners"]);
        if (Array.isArray(parsed)) updates.macRunners = parsed;
      } catch {
        // Invalid JSON — skip silently
      }
    }
    if (params["macRunnerHosts"] !== undefined) {
      const knownHosts = params["macRunnerHosts"].split(",").map(s => s.trim()).filter(Boolean);
      const base = Array.isArray(updates.macRunners)
        ? updates.macRunners
        : (MAC_RUNNERS as MacRunner[]).map(r => ({ ...r }));
      for (const runner of base) {
        if (knownHosts.includes(runner.host)) {
          runner.enabled = params[`macRunnerEnabled_${runner.host}`] === "on";
        }
      }
      updates.macRunners = base;
    }
    if (params["macRunnerRepos"] !== undefined) {
      const submitted = params["macRunnerRepos"].split(",").map((s) => s.trim()).filter(Boolean);
      // A repo whose own claws.json says `runners: ["macos"]` enrols itself, so
      // the host entry is a redundant shadow of the file (#2936). Only a
      // present, parsed file prunes anything — a failed fetch leaves the entry.
      const covered = submitted.filter((r) => config.isRepoDeclaredMacRunner(r));
      if (covered.length > 0) {
        log.info(`[config] Dropped macRunnerRepos entries already covered by the repo's claws.json: ${covered.join(", ")}`);
      }
      updates.macRunnerRepos = submitted.filter((r) => !covered.includes(r));
    }

    const intervalUpdates: Record<string, number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("interval_")) {
        const intKey = key.slice("interval_".length);
        const v = parseInt(value, 10);
        if (v > 0) intervalUpdates[intKey] = v * 60 * 1000;
      }
    }
    if (Object.keys(intervalUpdates).length > 0) {
      updates.intervals = intervalUpdates as ConfigFile["intervals"];
    }

    const scheduleUpdates: Record<string, number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("schedule_")) {
        const schedKey = key.slice("schedule_".length);
        const v = parseInt(value, 10);
        if (v >= 0 && v <= 23) scheduleUpdates[schedKey] = v;
      }
    }
    if (Object.keys(scheduleUpdates).length > 0) {
      updates.schedules = scheduleUpdates as ConfigFile["schedules"];
    }

    const disabledAgents: string[] = [];
    for (const name of VALID_AGENT_NAMES) {
      if (params[`enabledAgent_${name}`] !== "true") {
        disabledAgents.push(name);
      }
    }
    updates.disabledAgents = disabledAgents;

    if (params["openrouterApiKey"] !== undefined) updates.openrouterApiKey = params["openrouterApiKey"];
    if (params["anthropicApiKey"] !== undefined) updates.anthropicApiKey = params["anthropicApiKey"];
    if (params["opencodeSpendWarnUsd"] !== undefined && params["opencodeSpendWarnUsd"] !== "") {
      const v = Number(params["opencodeSpendWarnUsd"]);
      if (Number.isFinite(v) && v >= 0) updates.opencodeSpendWarnUsd = v;
    }
    if (params["ollamaBaseUrl"] !== undefined) updates.ollamaBaseUrl = params["ollamaBaseUrl"];
    if (params["ollamaTimeoutMs"] !== undefined) {
      const v = parseInt(params["ollamaTimeoutMs"], 10);
      if (v > 0) updates.ollamaTimeoutMs = v * 1000;
    }
    if (params["ollamaConsecutiveFailuresBeforeDisable"] !== undefined) {
      const v = parseInt(params["ollamaConsecutiveFailuresBeforeDisable"], 10);
      if (v > 0) updates.ollamaConsecutiveFailuresBeforeDisable = v;
    }
    const ALL_PROVIDERS = ["claude", "codex", "opencode", "pi"] as const;
    const aiProviders = {} as config.AiProviderConfig;
    for (const p of ALL_PROVIDERS) {
      const weight = Number(params[`providerWeight_${p}`]);
      const finiteWeight = Number.isFinite(weight);
      aiProviders[p] = {
        enabled: params[`providerEnabled_${p}`] === "true" && finiteWeight,
        weight: finiteWeight ? weight : config.DEFAULT_AI_PROVIDERS[p].weight,
      };
    }
    updates.aiProviders = aiProviders;
    if (params["providerRateLimitCooldownMs"] !== undefined) {
      const v = parseInt(params["providerRateLimitCooldownMs"], 10);
      if (v > 0) updates.providerRateLimitCooldownMs = v * 60 * 1000;
    }
    // A model field left at its shipped default (or blank) is removed from the
    // stored config, not written, so a later change to the default takes effect.
    for (const key of shippedModelDefaultKeys()) {
      const submitted = params[key];
      if (submitted === undefined) continue;
      const value = submitted.trim();
      (updates as Record<string, unknown>)[key] = value === "" || value === shippedModelDefault(key) ? undefined : submitted;
    }
    // The review row is stored only when it differs from the shipped default,
    // like every other default-tier row; an unrecognised value writes nothing.
    if (params["reviewModelTier"] !== undefined) {
      const tier = normalizeTier(params["reviewModelTier"]);
      const shippedReview = DEFAULT_TIER_TABLE.find((row) => row.key === "review")!.shippedDefault;
      if (tier) updates.reviewModelTier = tier === shippedReview ? undefined : tier;
    }
    // The review-raise threshold is an integer >= 0 (0 turns the raise off); a
    // blank or invalid value keeps the stored one.
    if (params["reviewRaiseLineThreshold"] !== undefined && params["reviewRaiseLineThreshold"].trim() !== "") {
      const v = Number(params["reviewRaiseLineThreshold"]);
      if (Number.isInteger(v) && v >= 0) updates.reviewRaiseLineThreshold = v;
    }
    // Default tiers (DEFAULT_TIER_TABLE): store a row only when it differs from
    // the shipped default, so an untouched row stays "not changed". A row whose
    // field is absent (env-pinned, so disabled) or unrecognised keeps its stored value.
    const storedDefaultTiers = (getConfigForDisplay().defaultModelTierOverrides ?? {}) as Record<string, ModelTier>;
    const defaultModelTiers: Record<string, ModelTier> = {};
    for (const row of DEFAULT_TIER_TABLE) {
      if (row.key === "review") continue;
      const raw = params[defaultTierFieldName(row.key)];
      const tier = raw !== undefined ? normalizeTier(raw) : null;
      const value = tier ?? storedDefaultTiers[row.key];
      if (value && value !== row.shippedDefault) defaultModelTiers[row.key] = value;
    }
    updates.defaultModelTiers = defaultModelTiers;

    await writeConfig(updates);

    return c.redirect("/config?saved=1", 303);
  });

  app.post("/whatsapp/unpair", authMiddleware, async (c) => {
    await unpair();
    return c.redirect("/whatsapp", 303);
  });

  app.get("/whatsapp/events", authMiddleware, async (c) => {
    try {
      const limitRaw = c.req.query("limit");
      const limit = Math.min(parseInt(limitRaw ?? "50", 10) || 50, 200);
      const events = await getRecentWhatsappEvents(limit);
      return jsonOk(c, events);
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });
}
