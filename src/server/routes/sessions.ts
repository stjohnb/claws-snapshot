/** Repo pages, repo avatars, WhatsApp pages, the session list and pages, config, logs and usage. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { streamSSE } from "hono/streaming";
import { upgradeWebSocket } from "@hono/node-server";
import { WebSocket } from "ws";
import { homeSessionNode } from "../../session-move.js";
import { WORK_DIR, getConfigForDisplay } from "../../config.js";
import * as config from "../../config.js";
import { enrichQueueItemsWithPRStatus, listRepos, listPRs, listIssuesByLabel, listOpenIssues, listRepoDirectory, type Issue, type PR } from "../../github.js";
import { listActionRuns, type ActionRunSummary } from "../../github.js";
import { listDisabledWorkflows as listDisabledWorkflowRows } from "../../db.js";
import { getJobRun, getJobRunLogs, getJobRunLogsSince, getTasksByRunId, getWorkItemsForRuns, getRunsForIssue, getLogsForRuns, getRecentTasksForRepo, getDailyTaskStats, getUsageItems, getTotalUsage, getUsageFilterOptions, getRecentEffectivenessEvents, getOpencodeAnthropicSpendUsd, getRecentSessionModels, getAllSessionCapabilityDefaults, listClawsPrs, listActivePrWork, getPersistedSession, listSessionFiles } from "../../db.js";
import * as log from "../../log.js";
import { MERGE_BLOCKING_AGENT_KINDS } from "../../agents/auto-merger.js";
import { isPairing, startPairing, stopPairing, cancelPairing } from "../../whatsapp.js";
import { buildLogDetailPage, buildIssueLogsPage, renderOutcomeCard, parseOutcome } from "../../pages/logs.js";
import { buildConfigPage } from "../../pages/config.js";
import { buildWhatsAppPage } from "../../pages/whatsapp.js";
import { buildRepoPage, type CiQueueData } from "../../pages/repo.js";
import * as clawsIssues from "../../claws-issues.js";
import { loadOperatorAttentionCounts, withSessionCount } from "../../operator-attention.js";
import { canonicalIssueRef } from "../../issue-id.js";
import { buildUsagePage } from "../../pages/usage.js";
import { parsePivotState } from "../../usage-pivot.js";
import { claudeAccountsStale, refreshClaudeAccounts } from "../../claude-accounts.js";
import { loadLatestReport } from "../../jobs/connectivity-verifier.js";
import { getEndedSession, listEndedSessions } from "../../sessions.js";
import { getSessionBackend } from "../../session-backend.js";
import { classifyLiveGrants, capabilityGroup } from "../../capabilities.js";
import { listAutoGranted as listAutoGrantedCapabilities, listPendingBySession as listPendingCapabilityRequestsBySession, pendingRequestView as pendingCapabilityRequestView, type CapabilityRequest } from "../../capability-requests.js";
import { awsSignInView, type AwsSignInView } from "../../aws-access.js";
import { listAwaitingSignInAwsGrants } from "../../db.js";
import { buildEndedSessionPage, buildSessionsListPage, buildSessionTerminalPage, renderSessionMemoryWarning, renderSessionsTables } from "../../pages/sessions.js";
import { sessionNodeMemoryPressure, type SessionNodeMemoryPressure } from "../../work-capacity.js";
import { parsePrSessionRef } from "../../session-brief.js";
import { navLinkCount } from "../../pages/layout.js";
import { getRepoConfig } from "../../repo-config.js";
import { readSessionFile, deleteSessionFile, describeSessionFiles, type SessionFileView } from "../../session-files.js";
import { serveContentType, contentDisposition } from "../../issue-attachments.js";
import { getTheme, htmlError, htmlOk, jsonOk, textPlain } from "../http.js";
import { authMiddleware } from "../auth.js";
import { CI_QUEUE_READ_TIMEOUT_MS, REPO_AVATAR_CONTENT_TYPES, defaultMultiSessionProvider, defaultSessionProvider, isConfiguredRepo, loadPRRowStatuses, loadRepoAvatar, loadSessionAgentDefaults } from "../shared.js";
import { Hono } from "hono";
import type { Env } from "../http.js";
import type { RouteContext } from "./context.js";

export function registerSessionRoutes(app: Hono<Env>, ctx: RouteContext): void {
  const { controller } = ctx;
  app.get("/repo-avatar/:owner/:name", authMiddleware, async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("name")}`;
    const avatarPath = getRepoConfig(fullName)?.avatar;
    if (!avatarPath) return textPlain(c, "No avatar", 404);
    const bytes = await loadRepoAvatar(fullName, avatarPath);
    if (!bytes) return textPlain(c, "Avatar not found", 404);
    const ext = avatarPath.slice(avatarPath.lastIndexOf(".") + 1).toLowerCase();
    c.header("Content-Type", REPO_AVATAR_CONTENT_TYPES[ext] ?? "application/octet-stream");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("Cache-Control", "private, max-age=1800");
    return c.body(new Uint8Array(bytes), 200);
  });

  /**
   * The repo page's CI queue (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y): waiting,
   * blocked and running runs, newest first, and the workflow files, read in
   * parallel and bounded by {@link CI_QUEUE_READ_TIMEOUT_MS}. Null when any
   * read fails or times out, so the page renders "CI queue unavailable".
   */
  async function loadCiQueue(repo: string): Promise<CiQueueData | null> {
    let timer: NodeJS.Timeout | undefined;
    const reads = (async () => Promise.all([
      Promise.all(["waiting", "blocked", "running"].map((status) => listActionRuns(repo, { status }))),
      listRepoDirectory(repo, ".forgejo/workflows"),
    ]))().then(([lists, entries]): CiQueueData => {
      const byRun = new Map<number, ActionRunSummary>();
      for (const r of lists.flat()) if (!byRun.has(r.run)) byRun.set(r.run, r);
      return {
        runs: [...byRun.values()].sort((a, b) => b.run - a.run),
        workflows: entries.filter((e) => e.type === "file" && /\.ya?ml$/.test(e.name)).map((e) => e.name).sort(),
      };
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${CI_QUEUE_READ_TIMEOUT_MS}ms`)), CI_QUEUE_READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([reads, timeout]);
    } catch (err) {
      log.warn("[repo] CI queue unavailable", { repo, error: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  app.get("/repos/:owner/:name", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    if (!owner || !name) {
      return htmlError(c, 404, "Repo not found", "That repository isn't managed by Claws.", {
        actions: [{ href: "/jobs", label: "← Jobs" }],
      });
    }

    const repoWtDir = path.resolve(WORK_DIR, "worktrees", owner, name);
    if (!repoWtDir.startsWith(path.join(WORK_DIR, "worktrees") + path.sep)) {
      return c.body(null, 400);
    }

    const fullName = `${owner}/${name}`;

    const repos = await listRepos();
    if (!repos.some((r) => r.fullName === fullName)) {
      return htmlError(c, 404, "Repo not found", "That repository isn't managed by Claws.", {
        detail: fullName,
        actions: [{ href: "/jobs", label: "← Jobs" }],
      });
    }

    const snapshot = await controller.queueSnapshot();
    const repoQueueItems = snapshot.items.filter((item) => item.repo === fullName);

    // The PR statuses chain on listPRs so they still load alongside the rest.
    const prsWithStatuses = listPRs(fullName).catch((): PR[] => [])
      .then(async (prs) => ({ prs, prStatuses: await loadPRRowStatuses(fullName, prs) }));
    const [recentTasks, dailyStats, { prs, prStatuses }, prRows, alerts, primaryIssues, namingIssues, , activeWork, ciQueue, disabledWorkflows] = await Promise.all([
      getRecentTasksForRepo(fullName, 20),
      getDailyTaskStats(fullName, 30),
      prsWithStatuses,
      listClawsPrs(fullName).catch(() => []),
      listIssuesByLabel(fullName, "claws-error").catch(() => []),
      listOpenIssues(fullName).catch(() => []),
      clawsIssues.listOpenIssuesNaming(fullName).catch((): Issue[] => []),
      enrichQueueItemsWithPRStatus(repoQueueItems),
      listActivePrWork(MERGE_BLOCKING_AGENT_KINDS).catch((err) => { log.warn(`[repo] active PR work: ${err}`); return new Map<string, string>(); }),
      loadCiQueue(fullName),
      listDisabledWorkflowRows(fullName).catch((err) => { log.warn(`[repo] disabled workflows: ${err}`); return []; }),
    ]);
    // Any-repo matching: native issues that name this repo as a non-primary
    // join the primary-repo list, deduped by number.
    const seenIssues = new Set(primaryIssues.map((i) => String(i.number)));
    const openIssues = [...primaryIssues, ...namingIssues.filter((i) => !seenIssues.has(String(i.number)))];

    let worktrees: string[] = [];
    try {
      const namespaces = await fs.promises.readdir(repoWtDir, { withFileTypes: true });
      for (const ns of namespaces) {
        if (!ns.isDirectory()) continue;
        const branches = await fs.promises.readdir(path.join(repoWtDir, ns.name));
        for (const branch of branches) {
          worktrees.push(`${ns.name}/${branch}`);
        }
      }
    } catch {
      // ENOENT or permission error — no worktrees for this repo
    }

    const html = buildRepoPage({
      owner,
      name,
      queueItems: repoQueueItems,
      recentTasks,
      dailyStats,
      worktrees,
      openPRs: prs,
      clawsPrs: prRows,
      alertIssues: alerts,
      openIssues,
      prStatuses,
      activeWork,
      ciQueue,
      disabledWorkflows,
    }, theme, await loadOperatorAttentionCounts());
    return htmlOk(c, html);
  });

  app.get("/whatsapp", authMiddleware, async (c) => {
    const theme = getTheme(c);
    return htmlOk(c, buildWhatsAppPage(theme, await loadOperatorAttentionCounts()));
  });

  app.get("/whatsapp/pair", authMiddleware, (c) => {
    if (isPairing()) {
      cancelPairing();
    }
    return streamSSE(c, async (stream) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => { resolveDone = r; });
      const listener = (event: import("../../whatsapp.js").PairingEvent) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
        if (event.type === "connected") {
          resolveDone();
        } else if (event.type === "error" || event.type === "timeout") {
          resolveDone();
        }
      };
      stream.onAbort(() => {
        stopPairing();
        resolveDone();
      });
      startPairing(listener).catch((err) => {
        void stream.writeSSE({ data: JSON.stringify({ type: "error", message: String(err) }) });
        resolveDone();
      });
      await done;
    });
  });

  // ── Session routes (GET) ──
  // Register specific routes first so they don't collide with /sessions/:id.

  /** Live sessions first, then ended ones, as the /sessions list shows them. */
  const loadSessionsForList = async () => {
    // Each live row's Claude account label and Switch account state read the account list.
    if (claudeAccountsStale()) await refreshClaudeAccounts();
    const backendLive = await getSessionBackend().listLive();
    // Flag each live session whose agent waits on a capability decision; a DB
    // failure leaves the marker off rather than failing the page.
    let pending = new Map<string, CapabilityRequest[]>();
    try {
      pending = await listPendingCapabilityRequestsBySession();
    } catch (err) {
      log.warn(`[sessions] Failed to load pending capability requests for the sessions list: ${err instanceof Error ? err.message : String(err)}`);
    }
    // AWS sign-ins awaiting the operator, shown on the session's pending-request marker.
    let signIns: Array<AwsSignInView & { sessionId: string }> = [];
    try {
      signIns = (await listAwaitingSignInAwsGrants()).flatMap((row) => {
        const view = awsSignInView(row);
        return view ? [{ ...view, sessionId: row.session_id }] : [];
      });
    } catch (err) {
      log.warn("Could not read AWS sign-ins for the sessions list", { component: "aws-access", error: String(err) });
    }
    const live = backendLive.map((s) => ({
      ...s,
      pendingCapabilityRequests: (pending.get(s.id) ?? []).map((entry) => {
        const view = pendingCapabilityRequestView(entry);
        const signIn = signIns.find((v) => v.sessionId === s.id && v.capability === entry.capability);
        return signIn ? { ...view, signIn: { verificationUrl: signIn.verificationUrl, userCode: signIn.userCode, expiresAt: signIn.expiresAt } } : view;
      }),
    }));
    const liveIds = new Set(live.map((s) => s.id));
    const ended = (await listEndedSessions()).filter((s) => !liveIds.has(s.id));
    return [...live, ...ended];
  };

  // The controller's worker status, memoised for 10s so the 5s sessions poll adds at most one call per 10s.
  let memoryPressureCache: { at: number; value: SessionNodeMemoryPressure | null } | null = null;
  const loadSessionMemoryPressure = async (): Promise<SessionNodeMemoryPressure | null> => {
    const now = Date.now();
    if (memoryPressureCache && now - memoryPressureCache.at < 10_000) return memoryPressureCache.value;
    let value: SessionNodeMemoryPressure | null = null;
    try {
      value = sessionNodeMemoryPressure((await controller.workerStatus()).capacity);
    } catch { /* unreadable node memory shows no warning */ }
    memoryPressureCache = { at: now, value };
    return value;
  };

  // The /sessions page polls this to drop an ended session without a reload (#clw_01M52FEC8QSM9P57WWSEBYFB7D).
  app.get("/api/sessions/table", authMiddleware, async (c) => {
    const sessions = await loadSessionsForList();
    const badge = navLinkCount("/sessions", { sessions: sessions.filter((s) => s.alive).length });
    const nav = [{ href: "/sessions", text: badge?.text ?? "", name: badge?.name ?? "Sessions" }];
    return c.json({ ...renderSessionsTables(sessions), nav, memoryWarning: renderSessionMemoryWarning(await loadSessionMemoryPressure()) });
  });

  app.get("/sessions", authMiddleware, async (c) => {
    // The create form offers claude-auth only while an account has a token.
    if (claudeAccountsStale()) await refreshClaudeAccounts();
    const theme = getTheme(c);
    const repos = await listRepos().catch(() => []);
    const sessions = await loadSessionsForList();
    // A DB hiccup must not 500 the sessions page — fall back to no recents.
    let recentModels = { claude: [] as string[], codex: [] as string[], opencode: [] as string[], pi: [] as string[] };
    try {
      recentModels = {
        claude: await getRecentSessionModels("claude"),
        codex: await getRecentSessionModels("codex"),
        opencode: await getRecentSessionModels("opencode"),
        pi: await getRecentSessionModels("pi"),
      };
    } catch { /* ignore */ }
    // Likewise fall back to the static per-repo map (no remembered defaults).
    let rememberedCapabilityDefaults = new Map<string, string[]>();
    try {
      rememberedCapabilityDefaults = await getAllSessionCapabilityDefaults();
    } catch { /* ignore */ }
    const [agentDefaults, providers] = await Promise.all([loadSessionAgentDefaults(), controller.providerStatus()]);
    const html = buildSessionsListPage(theme, sessions, repos, recentModels, {
      defaultProvider: defaultSessionProvider(agentDefaults.lastProvider, providers),
      defaultMultiProvider: defaultMultiSessionProvider(agentDefaults.lastProvider, providers),
      rememberedCapabilityDefaults,
      memoryPressure: await loadSessionMemoryPressure(),
    }, withSessionCount(await loadOperatorAttentionCounts(), sessions.filter((s) => s.alive).length));
    return htmlOk(c, html);
  });

  // WebSocket route for /sessions/:id/ws — register BEFORE /sessions/:id to win match order.
  // Auth note: the WS upgrade runs through `authMiddleware`. Under OIDC it requires a valid
  // `claws_session` cookie; with OIDC unconfigured the upgrade is denied (503), consistent with
  // all other authenticated routes.
  app.get(
    "/sessions/:id/ws",
    authMiddleware,
    // Validate session before the WebSocket handshake so the client gets HTTP 404 (not a
    // post-handshake close(1008)) when the session ID is unknown.
    async (c, next) => {
      const id = c.req.param("id") ?? "";
      if (!/^[a-f0-9]+$/.test(id)) return c.body(null, 404);
      const check = await getSessionBackend().checkAttach(id);
      if (!check.ok) return c.body(null, check.reason === "unavailable" ? 503 : 404);
      return next();
    },
    upgradeWebSocket((c) => {
      const id = c.req.param("id") ?? "";
      return {
        onOpen(_evt, ws) {
          if (ws.raw) getSessionBackend().attach(id, ws.raw as WebSocket);
        },
      };
    }),
  );

  // Files the session published (`claws_publish_file`). Operator routes, like
  // the session page itself; they work for live and ended sessions alike.
  app.get("/sessions/:id/files", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    return jsonOk(c, { files: describeSessionFiles(await listSessionFiles(id)) });
  });

  app.get("/sessions/:id/files/:fileId/:filename", authMiddleware, async (c) => {
    const notFound = () => textPlain(c, "File not found", 404);
    const id = c.req.param("id");
    const fileId = c.req.param("fileId");
    if (!/^[a-f0-9]+$/.test(id) || !/^csf_[0-9A-Z]{26}$/.test(fileId)) return notFound();
    const found = await readSessionFile(fileId);
    // The row, not the URL, decides whose file this is.
    if (!found || found.row.session_id !== id) return notFound();
    let size: number;
    try {
      size = fs.statSync(found.absolutePath).size;
    } catch {
      return notFound();
    }
    const disposition = contentDisposition(found.row);
    c.header("Content-Type", serveContentType(found.row));
    c.header("Content-Length", String(size));
    c.header("Content-Disposition", c.req.query("download") === "1" ? disposition.replace(/^inline;/, "attachment;") : disposition);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("Cache-Control", "private, max-age=3600");
    const stream = Readable.toWeb(fs.createReadStream(found.absolutePath)) as unknown as ReadableStream<Uint8Array>;
    return c.body(stream, 200);
  });

  app.delete("/sessions/:id/files/:fileId", authMiddleware, async (c) => {
    const id = c.req.param("id");
    const fileId = c.req.param("fileId");
    if (!/^[a-f0-9]+$/.test(id) || !/^csf_[0-9A-Z]{26}$/.test(fileId)) return jsonOk(c, { error: "File not found" }, 404);
    const result = await deleteSessionFile(id, fileId);
    if (!result.ok) return jsonOk(c, { error: "File not found" }, 404);
    log.info(`[server] Session ${id}: operator deleted published file ${result.row.filename} (${fileId})`);
    return jsonOk(c, { ok: true });
  });

  /** A session's published files for its page; a DB hiccup shows none rather than failing the page. */
  async function sessionFilesForPage(id: string): Promise<SessionFileView[]> {
    try {
      return describeSessionFiles(await listSessionFiles(id));
    } catch (err) {
      log.warn(`[server] Session ${id}: failed to list published files: ${err}`);
      return [];
    }
  }

  app.get("/sessions/:id", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return htmlError(c, 404, "Session not found", "That session ID isn't valid.", {
        detail: id,
        actions: [{ href: "/sessions", label: "← All sessions" }],
      });
    }
    const live = await getSessionBackend().getLive(id);
    if (!live.ok && live.reason === "unavailable") {
      return htmlError(c, 503, "Session runtime unavailable",
        "Claws could not reach the session runtime to look this session up. It has not been changed — try again shortly.",
        {
          detail: live.detail ? `${id}: ${live.detail}` : id,
          actions: [{ href: "/sessions", label: "← All sessions" }],
        },
      );
    }
    if (!live.ok) {
      const ended = await getEndedSession(id);
      if (ended) return htmlOk(c, buildEndedSessionPage(theme, { ...ended, files: await sessionFilesForPage(id) }, await loadOperatorAttentionCounts()));
      return htmlError(c, 404, "Session not found",
        "No running session has that ID, and none is in history — it may have been deleted, or pruned (Claws keeps the 50 most recent ended sessions).",
        {
          detail: id,
          actions: [{ href: "/sessions", label: "← All sessions" }, { href: "/", label: "Dashboard" }],
        },
      );
    }
    const session = live.session;
    const backend = getSessionBackend();
    // A DB hiccup only drops the "Started by" line, never the page.
    let startedBy: { session: string | null; issue: string | null; pr?: { repo: string; number: number } | null; source?: "issue-page" | null } | null = null;
    let node: string | null = null;
    try {
      const row = await getPersistedSession(id);
      node = row?.node ?? homeSessionNode(config.SESSION_POD_SETTINGS.nodes);
      const pr = parsePrSessionRef(row?.spawned_for_pr);
      if (row?.spawned_by_session) startedBy = { session: row.spawned_by_session, issue: row.spawned_for_issue ?? null };
      else if (pr) startedBy = { session: null, issue: row?.spawned_for_issue ?? null, pr };
      else if (row?.spawned_for_issue) startedBy = { session: null, issue: row.spawned_for_issue, ...(row.spawned_from === "issue-page" ? { source: "issue-page" as const } : {}) };
    } catch { /* ignore */ }
    const html = buildSessionTerminalPage(theme, {
      files: await sessionFilesForPage(id),
      startedBy,
      node,
      id: session.id,
      repo: session.repo,
      cwd: session.cwd,
      alive: session.alive,
      provider: session.provider,
      summary: session.summary,
      extraRepos: session.extraRepos,
      capabilityOptions: session.alive
        ? await (async () => {
          // A DB hiccup only drops the "(granted automatically)" labels.
          const auto = new Set<string>();
          try {
            for (const r of await listAutoGrantedCapabilities(id)) auto.add(r.capability);
          } catch { /* ignore */ }
          return classifyLiveGrants(session.capabilities, backend.kind, session).map(({ cap, state, reason }) => ({
            id: cap.id, label: cap.label, group: capabilityGroup(cap), state, reason,
            ...(state === "held" && auto.has(cap.id) ? { auto: true } : {}),
          }));
        })()
        : [],
    }, await loadOperatorAttentionCounts());
    return htmlOk(c, html);
  });

  app.get("/config", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const saved = c.req.query("saved") === "1";
    return htmlOk(c, buildConfigPage(saved, theme, await loadLatestReport(), await loadOperatorAttentionCounts()));
  });

  app.get("/config/api", authMiddleware, (c) => {
    return jsonOk(c, getConfigForDisplay());
  });

  // /logs/issue must come BEFORE /logs/:runId so it isn't captured as a runId.
  app.get("/logs/issue", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repoParam = c.req.query("repo");
    const num = canonicalIssueRef(c.req.query("number") ?? "");
    if (!repoParam || num === null || (typeof num === "number" && num < 1)) {
      return htmlError(c, 400, "Bad request", "This page needs both a repo and an issue reference, e.g. /logs/issue?repo=owner/name&number=123.", {
        actions: [{ href: "/jobs", label: "← Jobs" }],
      });
    }
    if (!(await isConfiguredRepo(repoParam))) {
      return htmlError(c, 404, "Repo not configured", "That repository isn't managed by Claws.", {
        detail: repoParam,
        actions: [{ href: "/jobs", label: "← Jobs" }],
      });
    }
    const runs = await getRunsForIssue(repoParam, num);
    const runIds = runs.map((r) => r.run_id);
    const logsByRun = await getLogsForRuns(runIds);
    const workItems = await getWorkItemsForRuns(runIds);
    const html = buildIssueLogsPage(repoParam, num, runs, logsByRun, workItems, theme, await loadOperatorAttentionCounts());
    return htmlOk(c, html);
  });

  app.get("/logs/:runId/tail", authMiddleware, async (c) => {
    const runId = c.req.param("runId");
    const afterId = parseInt(c.req.query("after") ?? "0", 10) || 0;
    const run = await getJobRun(runId);
    if (!run) {
      return jsonOk(c, { error: "Run not found" }, 404);
    }
    const logs = await getJobRunLogsSince(runId, afterId);
    const tasks = run.status !== "running" ? await getTasksByRunId(runId) : undefined;
    const outcomeCards = tasks?.map((t) => {
      const outcome = parseOutcome(t);
      const html = outcome ? renderOutcomeCard(outcome, t.status) : "";
      return { repo: t.repo, item_number: t.item_number, html };
    }).filter((cd) => cd.html);
    return jsonOk(c, {
      status: run.status,
      completed_at: run.completed_at,
      logs: logs.map((l) => ({ id: l.id, level: l.level, message: l.message, logged_at: l.logged_at })),
      taskCount: tasks?.length,
      outcomeCards,
    });
  });

  app.get("/logs/:runId", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const runId = c.req.param("runId");
    const run = await getJobRun(runId);
    if (!run) {
      return htmlError(c, 404, "Run not found", "No job run exists with that ID. It may have been pruned from the log retention window.", {
        detail: runId,
        actions: [{ href: "/jobs", label: "← Jobs" }],
      });
    }
    const logs = await getJobRunLogs(runId);
    const tasks = await getTasksByRunId(runId);
    const html = buildLogDetailPage(run, logs, theme, tasks, await loadOperatorAttentionCounts());
    return htmlOk(c, html);
  });

  app.get("/usage", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const daysParam = parseInt(c.req.query("days") ?? "7", 10);
    const days = [1, 7, 30].includes(daysParam) ? daysParam : 7;
    const pick = (name: string): string | undefined => {
      const v = c.req.query(name)?.trim();
      return v ? v : undefined;
    };
    const filters = { repo: pick("repo"), job: pick("job"), provider: pick("provider"), model: pick("model"), account: pick("account") };
    const items = await getUsageItems(days, filters);
    const pivot = parsePivotState({
      rows: c.req.queries("rows") ?? [],
      cols: c.req.query("cols"),
      measure: c.req.query("measure"),
      sort: c.req.query("sort"),
      dir: c.req.query("dir"),
      open: c.req.queries("open") ?? [],
    });
    const totals = await getTotalUsage(days, filters);
    const options = await getUsageFilterOptions(days);
    const recentEvents = await getRecentEffectivenessEvents(days, filters);
    const opencodeSpendUsd = await getOpencodeAnthropicSpendUsd();
    const html = buildUsagePage({ items, pivot, totals, days, filters, options, recentEvents, opencodeSpendUsd, opencodeSpendWarnUsd: config.OPENCODE_SPEND_WARN_USD }, theme, await loadOperatorAttentionCounts());
    return htmlOk(c, html);
  });
}
