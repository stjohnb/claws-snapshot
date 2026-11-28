/** Dashboard pages: reauth, status, damp, DMARC, retro, alerts, contracts, blog, jobs, PRs and the issues list. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import path from "node:path";
import { bodyLimit } from "hono/body-limit";
import { isOpenCodeBinaryAvailable } from "../../claude.js";
import * as config from "../../config.js";
import { anthropicCredentialState } from "../../anthropic-wif.js";
import { listRepos, listPRs, listOpenIssues, listRepoDirectory, fetchRepoFileWithSha, getDefaultBranch, createBranchRef, putRepoFile, createPR, getPRState, getPRChangedFiles, isNativeIssue, type PR } from "../../github.js";
import { LABELS } from "../../config.js";
import { listDisabledWorkflows as listDisabledWorkflowRows } from "../../db.js";
import { loadManualActionWarnings, manualWarningRow } from "../../planned-prs.js";
import * as alertBridge from "../../alert-bridge.js";
import { getLatestRunIdsByJob, getQueueSnapshots, getLastUsedByProvider, getRecentDampReadings, getDampTrendRows, upsertDampReading, deleteDampReading, getLatestDmarcReportsPerReporter, getDmarcVerdictCounts, getDmarcSourceIps, getRecentDmarcRows, upsertBlogDraft, getBlogDraft, listBlogDrafts, listUntriagedFrictionNotes, countUntriagedFrictionNotesByRepoAndCategory, lastFrictionRetrospectiveAt, listFrictionRetrospectives, getTasksByIds, setBlogDraftPushed, clearBlogDraftPR, deleteBlogDraft, listOpenClawsIssues, listIssueIdsWithPlans, listClawsPrs, listActivePrWork, getIssueBlockedReasons, listOpenClawsAlerts, listOpenClawsIssuesByDedupeKey, listContractStatuses, getContractStatuses, listContractAuditTimes, listContractGapReconfirmations, listLivePrStartedSessions, listOpenClawsPrsLinkedToIssues } from "../../db.js";
import * as log from "../../log.js";
import { approvalHoldReason as getApprovalHoldReason, isApprovalExempt, isRenovateExempt, MERGE_BLOCKING_AGENT_KINDS } from "../../agents/auto-merger.js";
import { msUntilHour } from "../../scheduler.js";
import { slackStatus, isSlackBotConfigured } from "../../slack.js";
import { VERSION } from "../../version.js";
import { buildStatusPage, queueCapacitySummary } from "../../pages/dashboard.js";
import { buildAllPRsPage, buildAllIssuesPage, type AllIssueRow, type UnassignedIssueRow } from "../../pages/lists.js";
import { hasIssuesFilters, issuesDateRange, parseIssuesQuery } from "../../pages/issues-view.js";
import { parsePrsQuery } from "../../pages/prs-view.js";
import { loadPrAttention, prAttentionKey } from "../../pr-attention.js";
import { flightKey } from "../../issue-flight.js";
import { loadOpenIssueStages } from "../../issue-stage.js";
import * as clawsIssues from "../../claws-issues.js";
import { issuesQueued } from "../../queued-issues.js";
import { columnsForCards, loadOperatorAttentionCounts, WAITING_COLUMNS, type AttentionCard } from "../../operator-attention.js";
import { canonicalIssueRef } from "../../issue-id.js";
import { buildJobsMatrixPage } from "../../pages/jobs-matrix.js";
import { buildReauthPage } from "../../pages/reauth.js";
import { claudeAccountsStale, refreshClaudeAccounts } from "../../claude-accounts.js";
import { backfillClaudeAccountIdentities } from "../../claude-account-identity.js";
import { prSessionRef } from "../../session-brief.js";
import { buildDampPage, DAMP_POINTS } from "../../pages/damp.js";
import { buildDmarcPage } from "../../pages/dmarc.js";
import { getDmarcStatus } from "../../jobs/dmarc-monitor.js";
import { buildRetroPage, type RetroPageView, type RetroRepoView } from "../../pages/retro.js";
import { buildAlertsPage, type AlertRow } from "../../pages/alerts.js";
import { buildContractsPage, buildContractDetailPage, buildContractsReviewPage } from "../../pages/contracts.js";
import { buildReviewItems, FLEET_REVIEW_DEDUPE_KEY, FLEET_REVIEW_REPO, gapKey, reconfirmRows, reviewableRows, reviewSeenKey } from "../../contract-gap-review.js";
import { CONTRACTS, buildContractRows, contractWaivers, type ContractRow } from "../../contract-status.js";
import { parseLastSeen, parseOccurrenceCount } from "../../occurrence-tracking.js";
import { nextTimeBasedDue, parseSqlTime } from "../../jobs/friction-retrospective.js";
import { buildBlogListPage, loadRepoDraftFlags, buildBlogEditPage, buildBlogDiffPage, draftLiveness, blogSlug, BLOG_REPO, BLOG_CONTENT_DIR, isValidBlogPath, type OpenPrFiles, type BlogEditDraftInfo } from "../../pages/blog.js";
import { lineDiff } from "../../blog-diff.js";
import { mapWithConcurrency } from "../../util.js";
import { getTheme, htmlError, htmlOk, jsonOk, parseFormBody, readTextBody } from "../http.js";
import { authMiddleware } from "../auth.js";
import { type NativeIssueRecord, getHomeAssistantStatus, jobStateRecord, loadPRRowStatuses, queueEntryViews, runningTaskViews, startedAt } from "../shared.js";
import { stopsAtForOpenIssues, loadLatestPlans, planPreviewFor, queueCapacityView } from "../approval-actions.js";
import { Hono } from "hono";
import type { Env } from "../http.js";
import type { RouteContext } from "./context.js";

export function registerPageRoutes(app: Hono<Env>, ctx: RouteContext): void {
  const { controller } = ctx;
  // ── GET routes ──

  app.get("/reauth", authMiddleware, async (c) => {
    if (claudeAccountsStale()) await refreshClaudeAccounts();
    backfillClaudeAccountIdentities();
    return htmlOk(c, buildReauthPage(getTheme(c), await loadOperatorAttentionCounts()));
  });
  // Kept so the /claude-auth links in already-filed [claws-error] issues still work.
  app.get("/claude-auth", authMiddleware, (c) => c.redirect("/reauth", 302));

  app.get("/api/status", authMiddleware, async (c) => {
    // The controller's start, WhatsApp, email and login state, not this process's.
    const integrations = await controller.integrations();
    const controllerStartedAt = integrations.startedAt ?? startedAt;
    const uptimeMs = Date.now() - new Date(controllerStartedAt).getTime();
    const jobs = await jobStateRecord(controller);
    const ws = await controller.workerStatus();
    const cq = { pending: ws.queued, active: ws.running };
    const runningTasks = await runningTaskViews();
    const queueEntries = await queueEntryViews();
    const latestRuns = await getLatestRunIdsByJob();
    const schedInfo = await controller.jobScheduleInfo();
    const pausedSet = await controller.pausedJobs();
    const manualSet = await controller.manualOnlyJobs();
    const jobSchedules: Record<string, { intervalMs?: number; scheduledHour?: number; lastCompletedAt: string | null; nextRunIn: number | null; manualOnly: boolean }> = {};
    for (const name of Object.keys(jobs)) {
      const sched = schedInfo.get(name);
      const latest = latestRuns.get(name);
      const lastCompletedAt = latest?.completedAt ? latest.completedAt + "Z" : null;
      let nextRunIn: number | null = null;
      if (!pausedSet.has(name) && sched) {
        if (sched.scheduledHour !== undefined) {
          nextRunIn = msUntilHour(sched.scheduledHour);
        } else if (latest?.startedAt) {
          nextRunIn = Math.max(0, new Date(latest.startedAt + "Z").getTime() + sched.intervalMs - Date.now());
        } else {
          nextRunIn = sched.intervalMs;
        }
      }
      jobSchedules[name] = {
        ...(sched?.scheduledHour !== undefined ? { scheduledHour: sched.scheduledHour } : { intervalMs: sched?.intervalMs }),
        lastCompletedAt,
        nextRunIn,
        manualOnly: manualSet.has(name),
      };
    }
    const totalQueueItems = (await controller.queueSnapshot()).items.length;

    return jsonOk(c, {
      status: "ok",
      startedAt: controllerStartedAt,
      uptime: Math.floor(uptimeMs / 1000),
      jobs,
      pausedJobs: [...pausedSet],
      claudeQueue: { pending: cq.pending, active: cq.active },
      capacity: queueCapacitySummary(queueCapacityView(ws)),
      runningTasks,
      queueEntries,
      jobSchedules,
      queueDepth: totalQueueItems,
      slack: slackStatus(),
      slackBot: { configured: isSlackBotConfigured() },
      whatsapp: integrations.whatsapp,
      email: integrations.email,
      dmarc: {
        ...getDmarcStatus(),
        verdictCounts7d: await getDmarcVerdictCounts(new Date(Date.now() - 7 * 86400000).toISOString()),
      },
      homeAssistant: getHomeAssistantStatus(),
    });
  });

  // The Board is the landing page (#clw_01M39XF6QQ3EF0JX48AT81FNPK); the
  // Status page that used to live here moved to /status.
  app.get("/", authMiddleware, (c) => c.redirect("/board", 302));

  app.get("/status", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const integrations = await controller.integrations();
    const controllerStartedAt = integrations.startedAt ?? startedAt;
    const uptimeMs = Date.now() - new Date(controllerStartedAt).getTime();
    const runningTasks = await runningTaskViews();
    const queueEntries = await queueEntryViews();
    const dashQueueDepth = (await controller.queueSnapshot()).items.length;
    const dashSnapshots = await getQueueSnapshots(24);
    const dbLastUsed = await getLastUsedByProvider();
    const providers = await controller.providerStatus();
    function aiProviderStatus(provider: "claude" | "codex" | "opencode", configured: boolean) {
      const rl = providers[provider].rateLimited;
      const memLastUsed = providers[provider].lastUsedAt;
      const dbLast = dbLastUsed[provider] ?? null;
      const lastUsedAt = memLastUsed
        ? new Date(memLastUsed).toISOString()
        : dbLast;
      const providerConfig = config.AI_PROVIDERS[provider] ?? config.DEFAULT_AI_PROVIDERS[provider];
      return {
        configured,
        enabled: providerConfig.enabled !== false,
        weight: providerConfig.weight,
        rateLimited: rl,
        rateLimitedUntil: providers[provider].rateLimitedUntil ?? undefined,
        lastUsedAt,
        isPrimary: false,
      };
    }
    const anthropicAuth = anthropicCredentialState().mode;
    const clawsKeyConfigured = anthropicAuth !== "none" || !!config.OPENROUTER_API_KEY;
    const opencodeCliAvailable = isOpenCodeBinaryAvailable();
    const opencodeStatus = {
      ...aiProviderStatus("opencode", clawsKeyConfigured || opencodeCliAvailable),
      clawsKeyConfigured,
      anthropicAuth,
      opencodeCliAvailable,
    };
    const aiProviders = {
      anthropic: { ...aiProviderStatus("claude", true), authExpired: integrations.agentAuthExpired.claude },
      openai: { ...aiProviderStatus("codex", true), authExpired: integrations.agentAuthExpired.codex },
      opencode: opencodeStatus,
    };

    const ws = await controller.workerStatus();
    const heartbeat = await controller.heartbeat();
    const html = buildStatusPage(
      VERSION,
      Math.floor(uptimeMs / 1000),
      { pending: ws.queued, active: ws.running },
      slackStatus(),
      { configured: isSlackBotConfigured() },
      integrations.whatsapp,
      integrations.email,
      getHomeAssistantStatus(),
      runningTasks,
      theme,
      controllerStartedAt,
      dashQueueDepth,
      dashSnapshots,
      aiProviders,
      queueEntries,
      await loadOperatorAttentionCounts(),
      heartbeat.alive ? undefined : { lastSeenAt: heartbeat.lastSeenAt },
      queueCapacityView(ws),
      await listDisabledWorkflowRows().catch((err) => { log.warn(`[status] disabled workflows: ${err}`); return []; }),
    );
    return htmlOk(c, html);
  });

  app.get("/damp", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const saved = c.req.query("saved") === "1";
    const html = buildDampPage(await getDampTrendRows(), await getRecentDampReadings(200), theme, saved, await loadOperatorAttentionCounts());
    return htmlOk(c, html);
  });

  app.get("/dmarc", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const html = buildDmarcPage(
      await getLatestDmarcReportsPerReporter(),
      await getDmarcVerdictCounts(since7),
      await getDmarcVerdictCounts(since30),
      await getDmarcSourceIps(since30),
      await getRecentDmarcRows(100),
      theme,
      await loadOperatorAttentionCounts(),
    );
    return htmlOk(c, html);
  });

  app.post("/damp/log", authMiddleware, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const body = await c.req.parseBody();
    const readingDate = String(body["reading_date"] ?? "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(readingDate)
      ? readingDate : new Date().toISOString().slice(0, 10);
    const recordedAt = new Date().toISOString();
    for (let i = 0; i < DAMP_POINTS.length; i++) {
      const raw = String(body[`p${i}`] ?? "").trim();
      if (raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      await upsertDampReading(DAMP_POINTS[i].location, DAMP_POINTS[i].point, value, date, recordedAt);
    }
    return c.redirect("/damp?saved=1", 303);
  });

  app.post("/damp/reading", authMiddleware, async (c) => {
    try {
      const body = JSON.parse(await readTextBody(c)) as {
        index?: unknown; value?: unknown; reading_date?: unknown;
      };
      if (
        typeof body.index !== "number" &&
        (typeof body.index !== "string" || body.index.trim() === "")
      ) {
        return jsonOk(c, { error: "Bad index" }, 400);
      }
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0 || index >= DAMP_POINTS.length) {
        return jsonOk(c, { error: "Bad index" }, 400);
      }
      const rd = String(body.reading_date ?? "").trim();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(rd) ? rd : new Date().toISOString().slice(0, 10);
      const raw = String(body.value ?? "").trim();
      if (raw === "") {
        await deleteDampReading(DAMP_POINTS[index].location, DAMP_POINTS[index].point, date);
        return jsonOk(c, { ok: true, cleared: true });
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) return jsonOk(c, { error: "Bad value" }, 400);
      await upsertDampReading(DAMP_POINTS[index].location, DAMP_POINTS[index].point, value, date, new Date().toISOString());
      return jsonOk(c, { ok: true });
    } catch (err) {
      log.error(`Failed to save damp reading: ${err}`);
      return jsonOk(c, { error: "Save failed" }, 400);
    }
  });

  app.get("/retro", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const now = new Date();
    const [repos, notes, counts] = await Promise.all([listRepos(), listUntriagedFrictionNotes(), countUntriagedFrictionNotesByRepoAndCategory()]);
    const tasks = await getTasksByIds([...new Set(notes.map((n) => n.task_id).filter((id): id is number => id !== null))]);
    const taskJobs = new Map(tasks.map((t) => [t.id, t.job_name]));
    const [last, retrospectives] = await Promise.all([lastFrictionRetrospectiveAt(), listFrictionRetrospectives()]);
    const repoViews = repos.map((r): RetroRepoView => ({
      repo: r.fullName,
      counts: counts.get(r.fullName) ?? new Map(),
      notes: notes.filter((n) => n.repo === r.fullName),
      disabled: config.isJobDisabledForRepo("friction-retrospective", r.fullName),
    }));
    const view: RetroPageView = {
      nextDue: nextTimeBasedDue(last ? parseSqlTime(last) : null, now),
      totalUntriaged: repoViews.filter((r) => !r.disabled).reduce((n, r) => n + r.notes.length, 0),
      retrospectives,
      repos: repoViews,
      taskJobs,
    };
    return htmlOk(c, buildRetroPage(view, theme, await loadOperatorAttentionCounts()));
  });

  // Slack alerts link here: resolve a bridge repo's alertname to the Claws
  // issue tracking it at click time, else fall back to the alerts page
  // (docs/issue-tracker.md "Alert bridges").
  app.get("/alerts/lookup", authMiddleware, async (c) => {
    const repo = c.req.query("repo") ?? "";
    const alertname = c.req.query("alertname") ?? "";
    const id = repo ? await alertBridge.resolveAlertIssue(repo, alertname) : null;
    log.info(`[alert-lookup] ${repo || "(no repo)"} ${alertname || "(no alertname)"}: ${id ? `redirected to ${id}` : "no issue; redirected to /alerts"}`);
    return c.redirect(id ? `/issues/${encodeURIComponent(id)}` : "/alerts", 302);
  });

  // Every open alert issue, with the board column it sits in and whether that
  // column waits on the operator (docs/product/dashboard-and-integrations.md).
  app.get("/alerts", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const records = await listOpenClawsAlerts();
    const cards = records.map((record): AttentionCard => ({
      repo: clawsIssues.primaryRepo(record), ref: record.id, labels: record.labels, lifecycle: record.lifecycle,
      approvedThrough: record.approved_through, trackerId: record.id,
    }));
    const [columns, blockedReasons] = await Promise.all([
      columnsForCards(cards),
      getIssueBlockedReasons(records.map((record) => record.id)),
    ]);
    const lastSeenIso = (body: string): string | null => {
      const seen = parseLastSeen(body);
      const ms = seen ? Date.parse(seen) : NaN;
      return Number.isNaN(ms) ? null : new Date(ms).toISOString();
    };
    const rows = records.map((record, i): AlertRow => {
      const column = columns.get(flightKey(cards[i].repo, cards[i].ref)) ?? "planning";
      return {
        id: record.id,
        title: record.title,
        repo: cards[i].repo,
        repos: record.repos,
        createdAt: parseSqlTime(record.created_at).toISOString(),
        updatedAt: lastSeenIso(record.body) ?? parseSqlTime(record.updated_at).toISOString(),
        occurrences: parseOccurrenceCount(record.body),
        column,
        needsOperator: WAITING_COLUMNS.has(column),
        blockedReason: blockedReasons.get(record.id) ?? null,
      };
    });
    return htmlOk(c, buildAlertsPage(rows, theme, await loadOperatorAttentionCounts()));
  });

  /**
   * Every managed repo's standing against each contract
   * (docs/product/dashboard-and-integrations.md "Show where every repo stands
   * against its contracts"), from the scanners' stored snapshots, the audit
   * times, the open known-gaps follow-ups and the live job-disable config.
   * Rows cover `repos` only; `only` reads just that repo's snapshots. A failed stage read leaves the
   * follow-ups' Stops at line blank.
   */
  async function loadContractRows(repos: readonly string[], only?: string): Promise<ContractRow[]> {
    const [statuses, auditTimes, followUpLists] = await Promise.all([
      only ? getContractStatuses(only) : listContractStatuses(),
      listContractAuditTimes(),
      Promise.all(CONTRACTS.map((spec) => listOpenClawsIssuesByDedupeKey(spec.dedupeKey))),
    ]);
    const managed = new Set(repos);
    const followUpRecords = CONTRACTS.flatMap((spec, i) => followUpLists[i]!
      .filter((r) => managed.has(clawsIssues.primaryRepo(r)))
      .map((record) => ({ contract: spec.contract, record })));
    const records = followUpRecords.map((f) => f.record);
    let stopsAt = new Map<string, string>();
    if (records.length > 0) {
      try {
        const [reads, plans] = await Promise.all([
          loadOpenIssueStages(records),
          listIssueIdsWithPlans(records.map((r) => r.id)),
        ]);
        stopsAt = stopsAtForOpenIssues(records, reads, plans);
      } catch (err) {
        log.warn("contract follow-up stages failed", { component: "contracts-page", error: err instanceof Error ? err.message : String(err) });
      }
    }
    return buildContractRows({
      repos,
      statuses,
      auditTimes,
      followUps: followUpRecords.map(({ contract, record }) => ({
        contract,
        repo: clawsIssues.primaryRepo(record),
        id: record.id,
        title: record.title,
        stopsAt: stopsAt.get(record.id) ?? null,
      })),
      exclusions: config.getRepoJobExclusions(repos),
    });
  }

  app.get("/contracts", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = (await listRepos()).map((r) => r.fullName);
    const [rows, reconfirmations] = await Promise.all([loadContractRows(repos), listContractGapReconfirmations()]);
    const changed = buildReviewItems(rows, reconfirmations).filter((i) => i.changed).length;
    return htmlOk(c, buildContractsPage(rows, contractWaivers(rows), theme, await loadOperatorAttentionCounts(), changed));
  });

  // The fleet-wide accepted-gap review (#clw_01M753CRBTEEXJM0QMWEZQBWN4,
  // src/contract-gap-review.ts): every accepted Known gap, changed ones first.
  app.get("/contracts/review", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = (await listRepos()).map((r) => r.fullName);
    const [rows, reconfirmations, digest] = await Promise.all([
      loadContractRows(repos),
      listContractGapReconfirmations(),
      clawsIssues.findOpenIssueByDedupeKey(FLEET_REVIEW_REPO, FLEET_REVIEW_DEDUPE_KEY),
    ]);
    const flash = c.req.query("reconfirmed") !== undefined
      ? "Every accepted gap shown is reconfirmed."
      : c.req.query("partial") !== undefined
        ? `Reconfirmed what was on the page. ${Number(c.req.query("partial")) || "Some"} repo and contract row(s) were new or changed since it loaded, so the review issue stays open; review the reloaded page.`
        : c.req.query("stale") !== undefined
          ? "Nothing was reconfirmed: none of the rows on the reloaded page were on the page you submitted. Review it and try again."
          : undefined;
    return htmlOk(c, buildContractsReviewPage(
      buildReviewItems(rows, reconfirmations),
      rows,
      digest ? { id: digest.id } : null,
      new Date(),
      theme,
      await loadOperatorAttentionCounts(),
      flash,
    ));
  });

  // Reconfirm all: reconfirms exactly the gaps the page rendered (`seen`), so a
  // gap added or reworded since stays changed. The digest is closed as
  // completed only when no row was skipped, and before saving, so the
  // accepted-gaps-review job never re-applies the close.
  app.post("/contracts/review/reconfirm", authMiddleware, async (c) => {
    const params = parseFormBody(await readTextBody(c));
    const seen = new Map<string, Set<string>>();
    try {
      const parsed: unknown = JSON.parse(params["seen"] ?? "[]");
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (!Array.isArray(entry) || entry.length !== 3 || !entry.every((v) => typeof v === "string")) continue;
          const key = reviewSeenKey(entry[0] as string, entry[1] as string);
          const set = seen.get(key) ?? new Set<string>();
          set.add(entry[2] as string);
          seen.set(key, set);
        }
      }
    } catch { /* an unparsable form reconfirms nothing */ }
    const repos = (await listRepos()).map((r) => r.fullName);
    const rows = await loadContractRows(repos);
    const eligible = reviewableRows(rows);
    // A row with any accepted gap the page did not show changed since it loaded.
    const unseen = eligible.filter((r) => {
      const shown = seen.get(reviewSeenKey(r.contract, r.repo));
      return !r.snapshot!.gaps.some((g) => g.state === "accepted") || r.snapshot!.gaps.some((g) => g.state === "accepted" && !shown?.has(gapKey(g.text)));
    });
    if (unseen.length > 0) {
      log.info("accepted gaps reconfirm partial", { component: "contracts-page", reason: "rows changed since the page loaded", rows: unseen.length });
      if (unseen.length === eligible.length) return c.redirect("/contracts/review?stale=1", 303);
    }
    if (unseen.length === 0) {
      const digest = await clawsIssues.findOpenIssueByDedupeKey(FLEET_REVIEW_REPO, FLEET_REVIEW_DEDUPE_KEY);
      if (digest) {
        await clawsIssues.closeIssue(FLEET_REVIEW_REPO, digest.id, "completed");
        log.info("accepted gaps review closed", { component: "contracts-page", issue: digest.id, state_reason: "completed" });
      }
    }
    await reconfirmRows(rows, new Date(), "contracts-page", seen);
    return c.redirect(unseen.length > 0 ? `/contracts/review?partial=${unseen.length}` : "/contracts/review?reconfirmed=1", 303);
  });

  app.get("/contracts/:owner/:name", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const fullName = `${c.req.param("owner")}/${c.req.param("name")}`;
    const repo = (await listRepos()).find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
    if (!repo) {
      return htmlError(c, 404, "Repo not found", "That repository isn't managed by Claws.", {
        detail: fullName,
        actions: [{ href: "/contracts", label: "← Contracts" }],
      });
    }
    const rows = await loadContractRows([repo.fullName], repo.fullName);
    return htmlOk(c, buildContractDetailPage(repo.fullName, rows, theme, await loadOperatorAttentionCounts()));
  });

  app.get("/blog", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const rawEntries = await listRepoDirectory(BLOG_REPO, BLOG_CONTENT_DIR);
    const entries = rawEntries.filter((e) => e.type === "file" && e.name.endsWith(".md"));
    const drafts = await listBlogDrafts(BLOG_REPO);
    let flash: { text: string; error?: boolean } | undefined;
    const pushed = c.req.query("pushed");
    const error = c.req.query("error");
    const discarded = c.req.query("discarded");
    if (pushed) flash = { text: `Pushed PR #${pushed}` };
    else if (discarded) flash = { text: `Discarded saved draft ${discarded}` };
    else if (error === "badpath") flash = { text: "Invalid file path — must be a .md file under the blog content directory.", error: true };
    else if (error === "repo") flash = { text: "The blog repo could not be reached — try again shortly.", error: true };
    else if (error === "push") flash = { text: "Failed to push to PR — see server logs.", error: true };
    const filter = c.req.query("filter") === "drafts" ? "drafts" : "all";
    const repoDraft = await loadRepoDraftFlags(entries, (p) => fetchRepoFileWithSha(BLOG_REPO, p));
    const prNumbers = [...new Set(drafts.map((d) => d.pr_number).filter((n): n is number => n != null))];
    const prStates = new Map<number, string | null>();
    await mapWithConcurrency(prNumbers, 4, async (n) => {
      prStates.set(n, await getPRState(BLOG_REPO, n).catch(() => "UNKNOWN"));
    });
    // Open PRs on the blog repo count as drafts of the posts whose files they change.
    const openPrs = await listPRs(BLOG_REPO).catch((err) => {
      log.warn(`[blog] listPRs(${BLOG_REPO}) failed: ${err}`);
      return [] as PR[];
    });
    const openPrFiles = new Map<number, OpenPrFiles>();
    await mapWithConcurrency(openPrs, 4, async (pr) => {
      const files = await getPRChangedFiles(BLOG_REPO, pr.number).catch((err) => {
        log.warn(`[blog] getPRChangedFiles(${BLOG_REPO}#${pr.number}) failed: ${err}`);
        return [] as string[];
      });
      openPrFiles.set(pr.number, { title: pr.title, files, updatedAt: pr.updatedAt });
    });
    const html = buildBlogListPage(entries, drafts, theme, flash, await loadOperatorAttentionCounts(), { repoDraft, prStates, openPrFiles, filter });
    return htmlOk(c, html);
  });

  app.get("/blog/edit", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const isNew = c.req.query("new") === "1";
    if (isNew) {
      const html = buildBlogEditPage("", "", "", true, theme, undefined, undefined, await loadOperatorAttentionCounts());
      return htmlOk(c, html);
    }
    const path = c.req.query("path") ?? "";
    if (!path) return c.redirect("/blog", 303);
    if (!isValidBlogPath(path)) return c.redirect("/blog?error=badpath", 303);

    // A live saved draft wins over repo content so cross-browser edits survive; a
    // stale one (PR merged/closed/not found, or repo file changed) is never loaded
    // silently — the repo version shows unless the operator asks for ?draft=1.
    let repoUnchecked = false;
    const file = await fetchRepoFileWithSha(BLOG_REPO, path).catch((err) => {
      log.warn("blog edit: could not read the repo file", undefined, { repo: BLOG_REPO }, err);
      repoUnchecked = true;
      return null;
    });
    const draft = await getBlogDraft(BLOG_REPO, path);
    if (!draft && !file) return c.redirect(repoUnchecked ? "/blog?error=repo" : "/blog", 303);
    let content: string;
    let baseSha: string;
    let pr: { number: number } | undefined;
    let draftInfo: BlogEditDraftInfo | undefined;
    if (draft) {
      if (draft.pr_number != null) pr = { number: draft.pr_number };
      const prState = draft.pr_number != null
        ? await getPRState(BLOG_REPO, draft.pr_number).catch(() => "UNKNOWN")
        : null;
      const liveness = draftLiveness(draft, file?.sha, prState);
      draftInfo = { exists: true };
      if (repoUnchecked) {
        content = draft.content;
        baseSha = draft.base_sha ?? "";
      } else if (liveness.live) {
        content = draft.content;
        baseSha = draft.base_sha ?? "";
      } else if (c.req.query("draft") === "1" || !file) {
        content = draft.content;
        baseSha = file?.sha ?? "";
        draftInfo.stale = { reason: liveness.reason, loaded: true, prNumber: draft.pr_number, noRepoFile: !file };
      } else {
        content = file.content;
        baseSha = file.sha;
        draftInfo.stale = { reason: liveness.reason, loaded: false, prNumber: draft.pr_number };
      }
    } else {
      content = file!.content;
      baseSha = file!.sha;
    }
    const saved = c.req.query("saved") === "1";
    const error = c.req.query("error");
    let flash: { text: string; error?: boolean } | undefined;
    if (saved) flash = { text: "Saved to Claws ✓" };
    else if (repoUnchecked) flash = { text: "The blog repo could not be reached, so this saved draft was not checked against the repo version.", error: true };
    else if (error === "push") flash = { text: "Failed to push to PR — see server logs.", error: true };
    const html = buildBlogEditPage(path, content, baseSha, false, theme, pr, flash, await loadOperatorAttentionCounts(), draftInfo);
    return htmlOk(c, html);
  });

  app.get("/blog/diff", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const path = c.req.query("path") ?? "";
    if (!isValidBlogPath(path)) return c.redirect("/blog?error=badpath", 303);
    const draft = await getBlogDraft(BLOG_REPO, path);
    if (!draft) return c.redirect("/blog", 303);
    // Diff against the repo file at the draft's own path, else the post's repo file
    // with the same slug (its date may have changed before publishing), else empty.
    let againstPath: string | null = null;
    let repoUnchecked = false;
    const onRepoError = (err: unknown) => {
      log.warn("blog diff: could not read the repo file", undefined, { repo: BLOG_REPO }, err);
      repoUnchecked = true;
      return null;
    };
    let against = await fetchRepoFileWithSha(BLOG_REPO, path).catch(onRepoError);
    if (against) {
      againstPath = path;
    } else {
      const slug = blogSlug(path);
      const match = ((await listRepoDirectory(BLOG_REPO, BLOG_CONTENT_DIR).catch(onRepoError)) ?? [])
        .filter((e) => e.type === "file" && e.name.endsWith(".md") && blogSlug(e.path) === slug)
        .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))[0];
      if (match) {
        against = await fetchRepoFileWithSha(BLOG_REPO, match.path).catch(onRepoError);
        if (against) againstPath = match.path;
      }
    }
    if (repoUnchecked) return c.redirect("/blog?error=repo", 303);
    const prState = draft.pr_number != null
      ? await getPRState(BLOG_REPO, draft.pr_number).catch(() => "UNKNOWN")
      : null;
    const liveness = draftLiveness(draft, againstPath === path ? against?.sha : undefined, prState);
    const diff = lineDiff(against?.content ?? "", draft.content);
    const html = buildBlogDiffPage(
      draft,
      againstPath ? { path: againstPath } : null,
      diff,
      theme,
      liveness.live ? undefined : liveness.reason,
      await loadOperatorAttentionCounts(),
    );
    return htmlOk(c, html);
  });

  // Discard a Claws-saved draft. Only the stored row is removed; nothing is written to the blog repo.
  app.post("/blog/discard", authMiddleware, async (c) => {
    const body = await c.req.parseBody();
    const path = String(body["path"] ?? "").trim();
    if (!isValidBlogPath(path)) return c.redirect("/blog?error=badpath", 303);
    await deleteBlogDraft(BLOG_REPO, path);
    const name = path.split("/").pop() ?? path;
    return c.redirect("/blog?discarded=" + encodeURIComponent(name), 303);
  });

  app.post("/blog/save", authMiddleware, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const body = await c.req.parseBody();
    const action = String(body["action"] ?? "");
    const path = String(body["path"] ?? "").trim();
    const baseSha = String(body["base_sha"] ?? "");
    const content = String(body["content"] ?? "");
    const isNew = String(body["new"] ?? "") === "1";
    const theme = getTheme(c);

    // Path validation is the only guard on the single repo write path. Re-render the
    // form with the submitted content instead of redirecting, so a bad path never
    // discards a post the user just wrote.
    if (!isValidBlogPath(path)) {
      const flash = { text: "Invalid file path — must be a .md file under the blog content directory.", error: true };
      const html = buildBlogEditPage(path, content, baseSha, isNew, theme, undefined, flash, await loadOperatorAttentionCounts());
      return htmlOk(c, html);
    }

    const titleMatch = content.match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
    const title = titleMatch ? titleMatch[1] : null;

    // Re-saving over a draft whose PR merged, closed or vanished drops that PR
    // pointer, so the saved draft becomes live again instead of staying stale.
    const prior = await getBlogDraft(BLOG_REPO, path);
    if (prior?.pr_number != null) {
      const state = await getPRState(BLOG_REPO, prior.pr_number).catch(() => "UNKNOWN");
      if (state !== "OPEN" && state !== "UNKNOWN") await clearBlogDraftPR(BLOG_REPO, path);
    }

    await upsertBlogDraft(BLOG_REPO, path, content, baseSha || null, title, new Date().toISOString());

    if (action === "push") {
      try {
        const slug = path.split("/").pop()!.replace(/\.md$/, "");
        const message = `blog: update ${slug}`;
        const b64 = Buffer.from(content, "utf8").toString("base64");

        const draft = await getBlogDraft(BLOG_REPO, path);
        if (draft?.pr_number != null && draft.pr_branch) {
          const state = await getPRState(BLOG_REPO, draft.pr_number);
          if (state === "OPEN") {
            const onBranch = await fetchRepoFileWithSha(BLOG_REPO, path, draft.pr_branch);
            if (onBranch?.content === content) {
              // Nothing changed since the last push — don't create an empty commit.
              return c.redirect("/blog?pushed=" + draft.pr_number, 303);
            }
            await putRepoFile(BLOG_REPO, draft.pr_branch, path, b64, message, onBranch?.sha);
            await setBlogDraftPushed(BLOG_REPO, path, draft.pr_number, draft.pr_branch);
            return c.redirect("/blog?pushed=" + draft.pr_number, 303);
          }
          // PR merged, closed, or deleted — stale pointer, fall through to a fresh PR.
          log.info(`[blog] recorded PR #${draft.pr_number} for ${path} is ${state ?? "missing"}; opening a new PR`);
          await clearBlogDraftPR(BLOG_REPO, path);
        }

        const base = await getDefaultBranch(BLOG_REPO);
        const branch = `claws/blog-${slug}-${Date.now()}`;
        await createBranchRef(BLOG_REPO, branch, base);
        const existing = await fetchRepoFileWithSha(BLOG_REPO, path, base);
        await putRepoFile(BLOG_REPO, branch, path, b64, message, existing?.sha);
        const pr = await createPR(BLOG_REPO, branch, message, "Authored via the Claws blog editor.");
        await setBlogDraftPushed(BLOG_REPO, path, pr, branch);
        return c.redirect("/blog?pushed=" + pr, 303);
      } catch (err) {
        log.error(`[blog] push to PR failed for ${path}: ${String(err)}`);
        return c.redirect("/blog/edit?path=" + encodeURIComponent(path) + "&error=push", 303);
      }
    }

    return c.redirect("/blog/edit?path=" + encodeURIComponent(path) + "&saved=1", 303);
  });

  app.get("/jobs", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = await listRepos();
    repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
    const saved = c.req.query("saved") === "1";
    const locked = Object.fromEntries(repos.map((r) => [r.fullName, config.getLockedJobsForRepo(r.fullName)]));
    const jobs = await jobStateRecord(controller);
    const runningTasks = await runningTaskViews();
    const heartbeat = await controller.heartbeat();
    const toggleable = await controller.repoToggleableJobs();
    const html = buildJobsMatrixPage(repos, config.DISABLED_JOBS_BY_REPO, saved, theme, locked, {
      jobs,
      runningTasks,
      latestRuns: await getLatestRunIdsByJob(),
      paused: await controller.pausedJobs(),
      scheduleInfo: await controller.jobScheduleInfo(),
      staleController: heartbeat.alive ? undefined : { lastSeenAt: heartbeat.lastSeenAt },
    }, await loadOperatorAttentionCounts(), [...toggleable].map(([name, reason]) => ({ name, reason })));
    return htmlOk(c, html);
  });

  app.get("/prs", authMiddleware, async (c) => {
    const query = parsePrsQuery((k) => c.req.query(k));
    const theme = getTheme(c);
    const repos = await listRepos();
    const perRepo = await mapWithConcurrency(repos, 8, async (r) => {
      const prs = await listPRs(r.fullName, { staleOk: true }).catch(() => []);
      const [statuses, clawsPrs] = await Promise.all([
        loadPRRowStatuses(r.fullName, prs, { staleOk: true }),
        listClawsPrs(r.fullName).catch(() => []),
      ]);
      const prRows = new Map(clawsPrs.map((row) => [row.prNumber, row]));
      const open = await Promise.all(prs.map(async (pr) => {
        const prRow = prRows.get(pr.number);
        const approvalExempt = await isApprovalExempt(r.fullName, pr, prRow).catch(() => false);
        const renovateExempt = await isRenovateExempt(r.fullName, pr).catch(() => false);
        const approvalHoldReason = approvalExempt ? null : await getApprovalHoldReason(r.fullName, pr).catch(() => null);
        return { repo: r.fullName, pr, status: statuses.get(pr.number), prRow, approvalExempt, renovateExempt, approvalHoldReason: approvalHoldReason ?? undefined };
      }));
      return { open };
    });
    // Database only, batched by issue; a failed read costs the warnings, not the page.
    const [warnings, prSessions, activeWork, issueLinks] = await Promise.all([
      loadManualActionWarnings(perRepo.flatMap((r) => r.open).flatMap((row) => row.prRow ? [manualWarningRow(row.prRow)] : []))
        .catch((err) => { log.warn(`[prs] manual-action warnings: ${err}`); return new Map<string, string>(); }),
      listLivePrStartedSessions().catch((err) => { log.warn(`[prs] active sessions: ${err}`); return new Map<string, string>(); }),
      listActivePrWork(MERGE_BLOCKING_AGENT_KINDS).catch((err) => { log.warn(`[prs] active PR work: ${err}`); return new Map<string, string>(); }),
      listOpenClawsPrsLinkedToIssues().catch((err) => { log.warn(`[prs] linked issues: ${err}`); return []; }),
    ]);
    const stepIssues = new Map<string, string[]>();
    for (const link of issueLinks) {
      const key = `${link.row.repo}#${link.row.prNumber}`;
      stepIssues.set(key, [...(stepIssues.get(key) ?? []), link.issueId]);
    }
    // The one "needs the operator" rule the nav PRs count and the board share (`pr-attention.ts`).
    const openPrRows = perRepo.flatMap((r) => r.open).flatMap((row) => row.prRow ? [row.prRow] : []);
    const attention = await loadPrAttention(openPrRows, { warnings })
      .catch((err) => { log.warn(`[prs] attention: ${err}`); return new Map<string, string[]>(); });
    const rows = perRepo.flatMap((r) => r.open).map((row) => {
      const manualWarning = warnings.get(`${row.repo}#${row.pr.number}`);
      const activeSession = prSessions.get(prSessionRef(row.repo, row.pr.number));
      const reasons = row.prRow ? attention.get(prAttentionKey(row.repo, row.pr.number)) : undefined;
      const work = activeWork.get(`${row.repo}#${row.pr.number}`);
      const stepIssueIds = stepIssues.get(`${row.repo}#${row.pr.number}`);
      return { ...row, ...(stepIssueIds ? { stepIssueIds } : {}), ...(manualWarning ? { manualWarning } : {}), ...(activeSession ? { activeSession } : {}), ...(reasons ? { attention: reasons } : {}), ...(work ? { activeWork: work } : {}) };
    });
    const snapshot = await controller.queueSnapshot();
    return htmlOk(c, buildAllPRsPage(rows, snapshot.items, theme, query, await loadOperatorAttentionCounts()));
  });

  // The closed read's cap on `/issues`; one more is asked for to tell a full page from a cut one.
  const ISSUES_CLOSED_LIMIT = 500;

  app.get("/issues", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const query = parseIssuesQuery((k) => c.req.query(k), (k) => c.req.queries(k) ?? []);
    const wantOpen = query.state !== "closed";
    const wantClosed = query.state !== "open";
    // The Unassigned, Repository-no-longer-configured and Skipped sections are
    // open-issue housekeeping: only the unfiltered open view shows them.
    const housekeeping = !hasIssuesFilters(query);
    const repos = await listRepos();
    const plans = await loadLatestPlans("issues");
    const bounds = issuesDateRange(query);
    const dateColumn = ({ closed: "closed_at", created: "created_at", updated: "updated_at" } as const)[query.dateField];
    const [perRepo, unassignedIssues, openNative, closedMatches] = await Promise.all([
      wantOpen
        ? mapWithConcurrency(repos, 8, async (r) =>
          (await listOpenIssues(r.fullName).catch(() => [])).map((issue) => ({ repo: r.fullName, issue, plan: planPreviewFor(issue.number, plans) })),
        )
        : Promise.resolve([]),
      housekeeping ? clawsIssues.listUnassignedOpenIssues().catch(() => []) : Promise.resolve([]),
      housekeeping ? listOpenClawsIssues({}).catch(() => []) : Promise.resolve([]),
      // Closed issues come from the tracker only, with no time window: every
      // forge issue Claws manages is imported, so its closure is recorded there.
      wantClosed
        ? clawsIssues.listClosedIssuesMatching({
          repos: query.repos,
          ...(bounds.from || bounds.to ? { range: { field: dateColumn, ...bounds } } : {}),
          limit: ISSUES_CLOSED_LIMIT + 1,
        }).catch((err) => { log.warn(`[issues] closed issues: ${err}`); return []; })
        : Promise.resolve([]),
    ]);
    const toRow = (i: NativeIssueRecord): UnassignedIssueRow => ({
      id: i.id,
      title: i.title,
      authorLogin: i.author_login,
      updatedAt: clawsIssues.toIso(i.updated_at),
      repos: i.repos,
      plan: planPreviewFor(i.id, plans),
    });
    const unassigned: UnassignedIssueRow[] = unassignedIssues.map(toRow);
    const configured = new Set(repos.map((r) => r.fullName.toLowerCase()));
    const orphaned: UnassignedIssueRow[] = openNative
      .filter((i) => i.repos.length > 0 && !i.repos.some((r) => configured.has(r.toLowerCase())))
      .map(toRow);
    // A Blocked row only waiting on other work in flight reads Queued, as on
    // the board. A forge issue's tracker id is its shadow's.
    const shadowStages = wantOpen
      ? await clawsIssues.getOpenShadowStages()
        .catch((err) => { log.warn(`[issues] shadow stages: ${err}`); return new Map<string, { id: string }>(); })
      : new Map<string, { id: string }>();
    const rows: AllIssueRow[] = perRepo.flat().map((row) => ({
      ...row,
      trackerId: isNativeIssue(row.issue.number)
        ? String(canonicalIssueRef(row.issue.number))
        : shadowStages.get(`${row.repo}\u0000${String(row.issue.number)}`)?.id,
    }));
    const blockedIds = rows
      .filter((row) => row.issue.labels.some((l) => l.name === LABELS.blocked))
      .map((row) => row.trackerId)
      .filter((id): id is string => !!id);
    const truncatedClosed = closedMatches.length > ISSUES_CLOSED_LIMIT;
    for (const match of closedMatches.slice(0, ISSUES_CLOSED_LIMIT)) {
      rows.push({
        // An unassigned closed issue has no repo; it shows as "none".
        repo: match.issue.primaryRepo ?? "",
        issue: match.issue,
        trackerId: String(match.issue.number),
        closedAt: match.closedAt,
        stateReason: match.stateReason,
      });
    }
    const queued = new Set((await issuesQueued(blockedIds)).keys());
    const snapshot = await controller.queueSnapshot();
    return htmlOk(c, buildAllIssuesPage(rows, snapshot.items, theme, unassigned, housekeeping ? config.SKIPPED_ITEMS : [], orphaned, await loadOperatorAttentionCounts(), repos.map((r) => r.fullName), queued, { query, truncatedClosed, closedLimit: ISSUES_CLOSED_LIMIT }));
  });
}
