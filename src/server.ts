import { z } from "zod";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import { serve, upgradeWebSocket } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import { cancelCurrentTask, cancelTaskByRunId, isProviderRateLimited, getProviderRateLimitedUntil, clearProviderRateLimitState, getProviderLastUsedAt, isOpenCodeBinaryAvailable } from "./claude.js";
import { isAgentAuthExpired } from "./agent-auth-state.js";
import { hashAgentMcpToken } from "./internal-mcp-token.js";
import { getAgentPodLauncher } from "./agent-pod-launcher.js";
import * as worker from "./worker.js";
import { AGENT_KINDS } from "./worker.js";
import { stageRankOf } from "./work-order.js";
import { SERVER_PORT, BIND_HOST, WORK_DIR, WHATSAPP_ENABLED, VALID_AGENT_NAMES, SENSITIVE_KEYS, DEEP_MERGED_KEYS, getConfigForDisplay, loadConfig, writeConfig, getUnknownConfigKeys, removeConfigKeys, MAC_RUNNERS, isAgentDisabled, type ConfigFile, type MacRunner, type Repo } from "./config.js";
import * as config from "./config.js";
import { getQueueSnapshot, enrichQueueItemsWithPRStatus, mergePR, removeQueueItem, ALL_QUEUE_CATEGORIES, listRepos, listPRs, listPRStatuses, getPRReviewStatus, type PRRepoStatus, listIssuesByLabel, listOpenIssues, openIssuesMayBeTruncated, addLabel, removeLabel, listRepoDirectory, fetchRepoFileWithSha, getDefaultBranch, createBranchRef, putRepoFile, createPR, getPRState, ensureLabel, getPRChangedFiles, infraPathsIn, isNativeIssue, hasPriorityLabel, type ReviewLedgerEntry, type Issue, type PR } from "./github.js";
import { LABELS } from "./config.js";
import { getIssueComments, listMergedPRsForIssue, editIssue, editIssueTitle, closeIssue, getIssueState, commentOnIssue as ghCommentOnIssue, type IssueState } from "./github.js";
import * as planParser from "./plan-parser.js";
import { normalizeTier } from "./model-selector.js";
import { isPhaseClaimOnly } from "./phase-coverage.js";
import { loadIssuePhaseState, resolveTrackerId } from "./planned-prs.js";
import * as plannerRuns from "./planner-runs.js";
import { getWorkRow, getJobRun, getJobRunLogs, getJobRunLogsSince, getLatestRunIdsByJob, getRunningTasks, getTasksByRunId, getWorkItemsForRuns, getRunsForIssue, getLogsForRuns, getQueueSnapshots, getRecentTasksForRepo, getDailyTaskStats, getLastTaskTimePerRepo, getLastUsedByProvider, getRecentWhatsappEvents, cancelJobRunIfRunning, listQueuedWork, setWorkPriority, getAllHaUpgraderStates, getUsageStats, getTotalUsage, getUsageFilterOptions, getRecentEffectivenessEvents, getRecentDampReadings, getDampTrendRows, upsertDampReading, deleteDampReading, getLatestDmarcReportsPerReporter, getDmarcVerdictCounts, getDmarcSourceIps, getRecentDmarcRows, upsertBlogDraft, getBlogDraft, listBlogDrafts, setBlogDraftPushed, clearBlogDraftPR, resetCIFixerBreakerGrants, getRecentSessionModels, rememberSessionCapabilityDefaults, getAllSessionCapabilityDefaults, getImportedIssueByNative, listExplicitIssueModelPlanRows, listClawsIssueAttachments, listPRReviews, isRunningAgentPodMcpToken, listOpenClawsIssues, getClawsPr, upsertClawsPr, type IssueModelPlanRow } from "./db.js";
import * as log from "./log.js";
import { finalizeMergedClawsPR } from "./agents/auto-merger.js";
import type { Scheduler } from "./scheduler.js";
import { msUntilHour } from "./scheduler.js";
import { notify, slackStatus, isSlackBotConfigured } from "./slack.js";
import { whatsappStatus, isPairing, startPairing, stopPairing, cancelPairing, unpair } from "./whatsapp.js";
import * as emailMonitor from "./jobs/email-monitor.js";
import { VERSION } from "./version.js";
import { buildStatusPage, type QueueEntryView } from "./pages/dashboard.js";
import { buildLogDetailPage, buildIssueLogsPage, renderOutcomeCard, parseOutcome } from "./pages/logs.js";
import { buildConfigPage } from "./pages/config.js";
import { buildWhatsAppPage } from "./pages/whatsapp.js";
import { buildRepoPage } from "./pages/repo.js";
import { buildAllPRsPage, buildAllIssuesPage, type PRRowStatus, type UnassignedIssueRow } from "./pages/lists.js";
import { buildIssuePage, buildNewIssuePage, offeredLabels, type IssuePageView, type PlanPreview, type PlanView, type RequirementsView } from "./pages/issue.js";
import { describeModelPlan, parseModelPlanForm, setExplicitPlan, summarizeModelPlanCells } from "./model-plan.js";
import { buildBoardPage, type BoardCard } from "./pages/board.js";
import { buildBacklogPage, type BacklogRow } from "./pages/backlog.js";
import { backlogRefusal, BACKLOG_DESTINATION, columnAfterMove, columnFor, DERIVED_COLUMN_REJECTION, DONE_COLUMN_LIMIT, DONE_WINDOW_DAYS, FORGE_REOPEN_REJECTION, isBoardDestination, isDerivedColumn, transitionFor, UNASSIGNED_REJECTION, type BoardDestination } from "./issue-board.js";
import { flightKey, loadBoardFlights, loadIssueFlight } from "./issue-flight.js";
import { isIssueLifecycle, isStateLabel, type IssueLifecycle } from "./issue-lifecycle.js";
import * as clawsIssues from "./claws-issues.js";
import * as issueLinks from "./issue-links.js";
import { canonicalIssueRef, isClawsIssueId, sameIssueRef, shortIssueRef } from "./issue-id.js";
import { isClawsComment, isPlanComment } from "./marker-text.js";
import { renderMarkdown } from "./markdown.js";
import { buildUsagePage } from "./pages/usage.js";
import { buildJobsMatrixPage, REPO_JOB_NAMES } from "./pages/jobs-matrix.js";
import { buildReauthPage } from "./pages/reauth.js";
import { startClaudeLogin, submitClaudeLoginCode, getClaudeLoginStatus } from "./claude-auth.js";
import { startCodexLogin, getCodexLoginStatus } from "./codex-auth.js";
import { runConnectivityVerification, loadLatestReport } from "./jobs/connectivity-verifier.js";
import { getEndedSession, listEndedSessions, describeCreateSessionError, isSessionAgentStatus, SESSION_AGENT_STATUSES, SESSION_MODES, SESSION_PROVIDERS, type SessionMode, type SessionProvider } from "./sessions.js";
import { getSessionBackend, type SessionUploadResult } from "./session-backend.js";
import { createClawsStateMcpHandler, mcpMethodNotAllowed, listOpenPrsForManagedRepo } from "./claws-state-http.js";
import { liveGrantableCapabilities, classifyLiveGrants, validCapabilityIds, capabilityGroup, isRememberableCapability } from "./capabilities.js";
import {
  MAX_PENDING_PER_SESSION as MAX_PENDING_CAPABILITY_REQUESTS,
  agentGrantNotice,
  clearCapabilityRequestsForSession,
  decide as decideCapabilityRequest,
  describeCapabilityRequest,
  describeGrantedCapability,
  get as getCapabilityRequest,
  listPending as listPendingCapabilityRequests,
  markGrantSeen as markCapabilityGrantSeen,
  markPolled as markCapabilityPolled,
  recordGrant as recordCapabilityGrant,
  request as requestCapability,
  resolveAgentPickup,
  type AgentPickup,
} from "./capability-requests.js";
import { buildEndedSessionPage, buildSessionsListPage, buildSessionTerminalPage } from "./pages/sessions.js";
import { CUSTOM_MODEL_SENTINEL, isValidSessionModel } from "./session-models.js";
import { listOpenRouterSessionModels } from "./openrouter.js";
import { buildHaUpgraderPage } from "./pages/ha-upgrader.js";
import { buildDampPage, DAMP_POINTS } from "./pages/damp.js";
import { buildDmarcPage } from "./pages/dmarc.js";
import { getDmarcStatus } from "./jobs/dmarc-monitor.js";
import { buildBlogListPage, buildBlogEditPage, BLOG_REPO, BLOG_CONTENT_DIR, isValidBlogPath } from "./pages/blog.js";
import { githubStatusLabel } from "./pages/layout.js";
import { buildErrorPage, type ErrorPageAction } from "./pages/error-page.js";
import { getGitHubStatusSnapshot } from "./github-status.js";
import { waitForEvents, GITHUB_EVENT_KINDS, type GitHubEventKind, type EventFilter } from "./github-events.js";
import { ALPINE_JS_SOURCE } from "./resources/alpinejs.js";
import { CHARTJS_SOURCE } from "./resources/chartjs.js";
import { reportError } from "./error-reporter.js";
import { TAILWIND_CSS_SOURCE } from "./resources/tailwind-css.generated.js";
import { WEB_MANIFEST, getAppIconPng } from "./pwa.js";
import { mapWithConcurrency, mapSettledWithConcurrency } from "./util.js";
import { MAX_UPLOAD_BYTES, MAX_LARGE_UPLOAD_BYTES, UPLOAD_REQUEST_TIMEOUT_MS, isAudioUpload, type SaveUploadResult } from "./session-uploads.js";
import { transcribe, isAvailable as transcribeAvailable, voiceVocabularyPrompt } from "./transcribe.js";
import { isShuttingDown, shutdownElapsedMs } from "./shutdown.js";
import { storeIssueAttachment, storeIssueAttachmentStream, readIssueAttachment, deleteIssueAttachment, claimPendingAttachments, sweepPendingAttachments, attachmentUrl, parseAttachmentUrl, serveContentType, contentDisposition, isInlineImage, PENDING_URL_SEGMENT } from "./issue-attachments.js";
import type { ClawsIssueAttachmentRow, ClawsIssuePlanRow } from "./db.js";
import { agentPodTokenLive, executeAgentPodOp } from "./agent-pod-ops.js";
import { decodeWire, encodeWire } from "./agent-pod-wire.js";

const ALPINE_JS_ETAG = `"${crypto.createHash("sha256").update(ALPINE_JS_SOURCE).digest("hex").slice(0, 16)}"`;
const CHARTJS_ETAG = `"${crypto.createHash("sha256").update(CHARTJS_SOURCE).digest("hex").slice(0, 16)}"`;
const TAILWIND_CSS_ETAG = `"${crypto.createHash("sha256").update(TAILWIND_CSS_SOURCE).digest("hex").slice(0, 16)}"`;

// Re-export for backwards compatibility with tests and other consumers
export { formatUptime } from "./pages/layout.js";
export type { Theme } from "./pages/layout.js";
export { buildLogDetailPage, buildIssueLogsPage } from "./pages/logs.js";

const startedAt = new Date().toISOString();

type Env = { Bindings: HttpBindings };
type Ctx = Context<Env>;

let homeAssistantStatus: { lastCheck: string | null; lastError: string | null } = { lastCheck: null, lastError: null };

/**
 * Attach each PR's last few recorded review rounds (`pr_reviews`) to its row
 * so the dashboard can render the review ledger. A failed read leaves that
 * row's `reviewLedger` unset.
 */
async function attachReviewLedgers(
  rows: Array<{ repo: string; prNumber: number; target: { reviewLedger?: ReviewLedgerEntry[] } }>,
): Promise<void> {
  await mapSettledWithConcurrency(rows, 8, async ({ repo, prNumber, target }) => {
    const reviews = await listPRReviews(repo, prNumber, 5);
    if (reviews.length === 0) return;
    target.reviewLedger = reviews.map((r) => ({
      headSha: r.headSha,
      verdict: r.verdict,
      mode: r.mode,
      iteration: r.iteration,
      provider: r.provider,
      model: r.model,
      createdAt: r.createdAt,
    }));
  });
}

function isHomeAssistantConfigured(): boolean {
  return !!(config.HOME_ASSISTANT_BASE_URL && config.HOME_ASSISTANT_TOKEN);
}

async function pingHomeAssistant(): Promise<void> {
  if (!isHomeAssistantConfigured()) {
    homeAssistantStatus = { lastCheck: null, lastError: null };
    return;
  }
  try {
    const url = config.HOME_ASSISTANT_BASE_URL.replace(/\/$/, "") + "/api/";
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.HOME_ASSISTANT_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      homeAssistantStatus = { lastCheck: new Date().toISOString(), lastError: `HTTP ${res.status}` };
      return;
    }
    homeAssistantStatus = { lastCheck: new Date().toISOString(), lastError: null };
  } catch (err) {
    homeAssistantStatus = {
      lastCheck: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

function getHomeAssistantStatus() {
  return { configured: isHomeAssistantConfigured(), lastCheck: homeAssistantStatus.lastCheck, lastError: homeAssistantStatus.lastError };
}

/**
 * The configured repo matching `repo` ("owner/name"), or `undefined` if it
 * isn't one of Claws' configured repos.
 */
async function findConfiguredRepo(repo: string): Promise<Repo | undefined> {
  const repos = await listRepos();
  return repos.find((r) => r.fullName === repo);
}

/**
 * True when `repo` ("owner/name") is one of Claws' configured repos.
 * Dashboard routes that mutate GitHub state must gate on this: the GitHub App
 * installation token can reach repos outside Claws' managed set.
 */
async function isConfiguredRepo(repo: string): Promise<boolean> {
  return (await findConfiguredRepo(repo)) !== undefined;
}

/** A forge issue/PR number, or a Claws-native `clw_…` id, canonicalised. */
const IssueRefSchema = z.union([z.number().int().positive(), z.string().min(1)])
  .transform((v) => canonicalIssueRef(v))
  .refine((v): v is config.IssueRef => v !== null, "not an issue reference");
const RepoNumberSchema = z.object({ repo: z.string().min(1), number: IssueRefSchema });
/** The PR-only variant: the circuit breaker is keyed by PR, never by issue. */
const RepoPrNumberSchema = z.object({ repo: z.string().min(1), number: z.number().int().positive() });
const MarkAutomergeSchema = RepoNumberSchema.extend({ alsoRefine: z.boolean().optional() });
/** The Agent Queue's Prioritise/Deprioritise toggle on `/status` — labels the item and flips its queue rows' Priority flag. */
const PriorityLabelSchema = RepoNumberSchema.extend({ add: z.boolean() });
/** A board drag: `repo` is empty for an unassigned native issue, which has none. */
const BoardMoveSchema = z.object({ repo: z.string(), ref: IssueRefSchema, to: z.string().min(1) });
/** The board's `M` toggle: unlike a move, always has a repository — see `automergeToggle` in `pages/board.ts`. */
const BoardAutomergeSchema = z.object({ repo: z.string().min(1), ref: IssueRefSchema, on: z.boolean() });
/** The most items one bulk board move takes — a sweep, not a migration. */
const BULK_MOVE_LIMIT = 200;
const BoardBulkMoveSchema = z.object({
  // `ideas` is the backlog's Promote: the issue re-enters the board wherever
  // `clawsIssues.entryLifecycle` puts it — Planning or Ideas.
  to: z.enum(["backlog", "ideas"]),
  items: z.array(z.object({ repo: z.string(), ref: IssueRefSchema })).min(1).max(BULK_MOVE_LIMIT),
});
const RepoItemSchema = z.object({ repo: z.string().min(1), prNumber: z.number().int().positive(), confirmInfra: z.boolean().optional() });
/** A session pod's exit report (#3311); `scrollback` is the pod's tail, at most 50,000 characters. */
const SessionExitReportSchema = z.object({ code: z.number().int(), scrollback: z.string() });
const SESSION_EXIT_REPORT_MAX_BYTES = 256 * 1024;
/** Largest agent-pod ops request body (a batch of job log lines is the biggest). */
const AGENT_POD_OPS_MAX_BYTES = 4 * 1024 * 1024;

// ── Auth helpers ──

function parseCookies(header: string | undefined | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Returns true when all four required OIDC fields are non-empty. */
function isOidcEnabled(): boolean {
  return !!(
    config.OIDC_CLIENT_ID &&
    config.OIDC_CLIENT_SECRET &&
    config.OIDC_BASE_URL &&
    config.OIDC_APPLICATION_SLUG
  );
}

/** First value of X-Forwarded-Host, else Host, normalised to a bare lowercase hostname. */
function effectiveHost(c: Ctx): string {
  const fwd = c.req.header("x-forwarded-host");
  const raw = (fwd ? fwd.split(",")[0] : c.req.header("host")) ?? "";
  return raw.trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * Per-request OIDC origin. When the request's host is in the allow-listed
 * OIDC_HOST_MAP, authorize/token/userinfo go to that host's Authentik and
 * redirect_uri is derived from the same host — so an externally-reached
 * dashboard never bounces to an internal-only auth host (#2841).
 */
function resolveOidcTarget(c: Ctx): { baseUrl: string; redirectUri: string } {
  const host = effectiveHost(c);
  const mapped = host ? config.OIDC_HOST_MAP[host] : undefined;
  if (mapped) return { baseUrl: mapped, redirectUri: `https://${host}/auth/callback` };
  const redirectUri = config.OIDC_REDIRECT_URI || `http://localhost:${SERVER_PORT}/auth/callback`;
  warnUnmappedOidcHost(host, redirectUri);
  return { baseUrl: config.OIDC_BASE_URL, redirectUri };
}

/** Hosts already warned about by warnUnmappedOidcHost; bounded so an attacker
 *  spraying Host headers can't grow it without limit. */
const warnedUnmappedOidcHosts = new Set<string>();
const MAX_WARNED_UNMAPPED_OIDC_HOSTS = 100;

/**
 * Logs once per host when a login arrives on a dashboard host that is neither
 * in `oidcHostMap` nor the host of the fixed `oidcRedirectUri`. The fallback
 * still works when that host can reach the default auth origin, but when it
 * can't (an `.ext.` host served over Tailscale bouncing to an internal-only
 * `auth.home`) the only symptom is a browser stuck on the auth host — this
 * makes the missing map entry visible in the journal instead (#2841).
 */
function warnUnmappedOidcHost(host: string, redirectUri: string): void {
  if (!host || warnedUnmappedOidcHosts.has(host)) return;
  let redirectHost = "";
  try {
    redirectHost = new URL(redirectUri).hostname.toLowerCase();
  } catch {
    // unparseable redirect URI — nothing sensible to compare against
  }
  if (host === redirectHost) return;
  if (warnedUnmappedOidcHosts.size >= MAX_WARNED_UNMAPPED_OIDC_HOSTS) return;
  warnedUnmappedOidcHosts.add(host);
  log.warn(
    `[oidc] Login reached the dashboard on host "${host}", which is not in oidcHostMap (CLAWS_OIDC_HOST_MAP) ` +
      `and does not match oidcRedirectUri (${redirectUri}). Falling back to ${config.OIDC_BASE_URL} with that ` +
      `redirect_uri; if the default auth host is unreachable from where "${host}" is served, add ` +
      `"${host}=<auth base URL>" to oidcHostMap and register https://${host}/auth/callback with the provider (#2841).`,
  );
}

const pendingOAuthStates = new Map<string, { expiresAt: number; returnTo: string; baseUrl: string; redirectUri: string }>();

function generateOAuthState(returnTo: string, baseUrl: string, redirectUri: string): string {
  const now = Date.now();
  for (const [k, v] of pendingOAuthStates) {
    if (v.expiresAt < now) pendingOAuthStates.delete(k);
  }
  const state = crypto.randomBytes(16).toString("hex");
  pendingOAuthStates.set(state, { expiresAt: now + 5 * 60 * 1000, returnTo, baseUrl, redirectUri });
  return state;
}

function consumeOAuthState(state: string): { returnTo: string; baseUrl: string; redirectUri: string } | null {
  const entry = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return { returnTo: entry.returnTo, baseUrl: entry.baseUrl, redirectUri: entry.redirectUri };
}

function signSession(sub: string, expiresAt: number, secret: string): string {
  const payload = `${sub}|${expiresAt}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}|${hmac}`;
}

function verifySession(
  value: string,
  secret: string,
): { sub: string; expiresAt: number } | null {
  const lastPipe = value.lastIndexOf("|");
  if (lastPipe < 0) return null;
  const hmac = value.slice(lastPipe + 1);
  const rest = value.slice(0, lastPipe);
  const secondLastPipe = rest.lastIndexOf("|");
  if (secondLastPipe < 0) return null;
  const expiryStr = rest.slice(secondLastPipe + 1);
  const sub = rest.slice(0, secondLastPipe);
  if (!sub || !expiryStr || !hmac) return null;
  const payload = `${sub}|${expiryStr}`;
  let expectedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(
      crypto.createHmac("sha256", secret).update(payload).digest("hex"),
    );
  } catch {
    return null;
  }
  const providedBuf = Buffer.from(hmac);
  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  )
    return null;
  const expiresAt = parseInt(expiryStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  return { sub, expiresAt };
}

/**
 * Who is acting, for a record that names the approver (a PR row's
 * `merge_approved_by`): the OIDC `sub` of the request's `claws_session`, or
 * `"dashboard"` when there is no valid session to read it from.
 */
function sessionSubject(c: Context<Env>): string {
  const raw = parseCookies(c.req.header("cookie"))["claws_session"];
  if (!raw || !config.OIDC_CLIENT_SECRET) return "dashboard";
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  return verifySession(decoded, config.OIDC_CLIENT_SECRET)?.sub ?? "dashboard";
}

/**
 * Record a dashboard merge approval on the `claws_prs` row for `repo#number`,
 * when Claws tracks one — a native issue id or an untracked PR has none, and
 * is left alone. Called before the Automerge label or the merge itself.
 */
async function recordMergeApproval(c: Context<Env>, repo: string, number: config.IssueRef): Promise<void> {
  if (typeof number !== "number") return;
  if (!(await getClawsPr(repo, number))) return;
  await upsertClawsPr(repo, number, { mergeApprovedBy: sessionSubject(c), mergeApprovedAt: new Date().toISOString() });
}

function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      const key = decodeURIComponent(pair.slice(0, eq));
      const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
      params[key] = value;
    } catch {
      continue;
    }
  }
  return params;
}

/** Parse all values for a repeated form key (parseFormBody keeps only the last). */
function parseFormBodyMulti(body: string, key: string): string[] {
  const out: string[] = [];
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      const k = decodeURIComponent(pair.slice(0, eq));
      if (k !== key) continue;
      out.push(decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " ")));
    } catch {
      continue;
    }
  }
  return out;
}

/** Strip control characters and truncate to prevent confusing audit messages from crafted URL paths. */
function sanitizeForNotification(value: string, maxLength = 100): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + "…" : cleaned;
}

function getTheme(c: Ctx): "dark" | "light" | "system" {
  const cookies = parseCookies(c.req.header("cookie"));
  const value = cookies["claws_theme"];
  if (value === "dark" || value === "light") return value;
  return "system";
}

async function readTextBody(c: Ctx, maxBytes = 1024 * 1024): Promise<string> {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error("Request body too large");
  }
  const rawBody = c.req.raw.body;
  if (!rawBody) return "";
  const reader = rawBody.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new Error("Request body too large");
    }
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

// ── Response helpers (exact Content-Type without charset suffix to match legacy) ──

function htmlOk(c: Ctx, body: string, status = 200) {
  c.header("Content-Type", "text/html");
  return c.body(body, status as ContentfulStatusCode);
}

function defaultSessionProvider(): SessionProvider {
  if (!isProviderRateLimited("claude")) return "claude";
  if (!isProviderRateLimited("codex")) return "codex";
  if (!isProviderRateLimited("opencode")) return "opencode";
  return "claude";
}

function defaultMultiSessionProvider(): Extract<SessionProvider, "claude" | "codex"> {
  if (!isProviderRateLimited("claude")) return "claude";
  if (!isProviderRateLimited("codex")) return "codex";
  return "claude";
}

function jsonOk(c: Ctx, obj: unknown, status = 200) {
  c.header("Content-Type", "application/json");
  return c.body(JSON.stringify(obj), status as ContentfulStatusCode);
}

function textPlain(c: Ctx, body: string, status = 200) {
  c.header("Content-Type", "text/plain");
  return c.body(body, status as ContentfulStatusCode);
}

function htmlError(
  c: Ctx,
  status: number,
  heading: string,
  message: string,
  extra: { detail?: string; actions?: ErrorPageAction[] } = {},
) {
  c.header("Content-Type", "text/html");
  return c.body(
    buildErrorPage(getTheme(c), { status, heading, message, ...extra }),
    status as ContentfulStatusCode,
  );
}

function shutdownRetryError(c: Ctx, heading: string, action: string, fields: Array<{ name: string; value: string }>) {
  c.header("Content-Type", "text/html");
  c.header("Cache-Control", "no-store");
  return c.body(buildErrorPage(getTheme(c), {
    status: 503,
    heading,
    message: "Claws is restarting — normally an auto-update deploy. It can't start new sessions until the restart finishes; shutdown waits up to 5 minutes for running jobs to drain.",
    actions: [{ href: "/sessions", label: "← Sessions" }],
    retry: { action, fields, elapsedMs: shutdownElapsedMs() },
  }), 503 as ContentfulStatusCode);
}

function describeUploadError(result: Extract<SaveUploadResult, { ok: false }>, maxLabel: string): string {
  switch (result.reason) {
    case "too-large": return `File too large (max ${maxLabel})`;
    case "write-failed": return "Failed to save upload";
  }
}

/** JSON error response for a failed session upload: 404 / 409 / 503 from the backend, else the storage failure. */
function uploadErrorResponse(c: Ctx, result: Extract<SessionUploadResult, { ok: false }>, maxLabel: string): Response {
  switch (result.reason) {
    case "not-found": return jsonOk(c, { error: "Session not found" }, 404);
    case "not-running": return jsonOk(c, { error: "Session is not running" }, 409);
    case "unavailable": return jsonOk(c, { error: "Session runtime unavailable" }, 503);
  }
  const status = result.reason === "too-large" ? 413 : 500;
  return jsonOk(c, { error: describeUploadError(result, maxLabel) }, status);
}

/** Pre-body liveness check for the upload routes: a response to return, or null when the session can take an upload. */
async function checkUploadTarget(c: Ctx, id: string): Promise<Response | null> {
  const live = await getSessionBackend().getLive(id);
  if (!live.ok) return uploadErrorResponse(c, live, "");
  if (!live.session.alive) return uploadErrorResponse(c, { ok: false, reason: "not-running" }, "");
  return null;
}

// ── Auth middlewares ──
// src/client/auth-watch.ts treats ANY same-origin 401 as a lapsed session and
// force-navigates to /login. Do not add another client-facing 401 source
// (app-level auth failures, bad tokens, etc.) without accounting for that —
// it will trigger an unwanted full-page redirect.

const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (isOidcEnabled()) {
    const cookies = parseCookies(c.req.header("cookie"));
    const sessionCookie = cookies["claws_session"];
    if (sessionCookie) {
      let decoded: string;
      try { decoded = decodeURIComponent(sessionCookie); } catch { decoded = sessionCookie; }
      if (verifySession(decoded, config.OIDC_CLIENT_SECRET)) return next();
    }
    const reqPath = c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?").slice(1).join("?") : "");
    const loginUrl = `/login?next=${encodeURIComponent(reqPath)}`;
    c.header("Content-Type", "text/html");
    return c.body(
      `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${loginUrl}"></head><body>Redirecting to login...</body></html>`,
      401,
    );
  }
  // OIDC not configured: fail closed. Nothing runs open.
  return textPlain(
    c,
    "Authentication is not configured. Set OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_BASE_URL, and OIDC_APPLICATION_SLUG in ~/.claws/env to enable login.",
    503,
  );
};

const apiAuthMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (safeCompare(token, config.INTERNAL_MCP_TOKEN)) return next();
    // An agent pod's own token, which outlives this boot's INTERNAL_MCP_TOKEN.
    // A DB failure here must not block the OIDC/401 fallbacks below.
    if (token && await isRunningAgentPodMcpToken(hashAgentMcpToken(token)).catch(() => false)) return next();
  }
  if (isOidcEnabled()) {
    const cookies = parseCookies(c.req.header("cookie"));
    const sessionCookie = cookies["claws_session"];
    if (sessionCookie) {
      let decoded: string;
      try { decoded = decodeURIComponent(sessionCookie); } catch { decoded = sessionCookie; }
      if (verifySession(decoded, config.OIDC_CLIENT_SECRET)) return next();
    }
  }
  return jsonOk(c, { error: "unauthorized" }, 401);
};

// ── Server ──

export function createServer(scheduler: Scheduler): http.Server {
  const app = new Hono<Env>();

  registerRoutes(app, scheduler);

  // ── Default 404 / 405 ──
  // Preserve legacy behavior: the original handleRequest returned 405 for any
  // non-GET that didn't match a POST handler, and 404 for unmatched GETs.
  app.notFound((c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    if (c.req.path.startsWith("/api/")) return jsonOk(c, { error: "Not found" }, 404);
    return htmlError(c, 404, "Page not found", "That URL doesn't match anything on this dashboard.", {
      detail: c.req.path,
      actions: [{ href: "/", label: "← Dashboard" }],
    });
  });

  app.onError((err, c) => {
    log.error(`HTTP handler error: ${err}`);
    c.header("Content-Type", "text/plain");
    return c.body("Internal Server Error", 500);
  });

  const wss = new WebSocketServer({ noServer: true });
  const server = serve(
    { fetch: app.fetch, port: SERVER_PORT, hostname: BIND_HOST, websocket: { server: wss } },
    (info) => {
      log.info(`HTTP server listening on ${info.address}:${info.port}`);
    },
  ) as http.Server;

  // A 1 GB session upload can legitimately take far longer than Node's 300 s
  // default request timeout; headersTimeout stays at its default.
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;

  pingHomeAssistant().catch(() => {});
  const haInterval = setInterval(() => { pingHomeAssistant().catch(() => {}); }, 5 * 60 * 1000);
  haInterval.unref();
  server.on("close", () => { clearInterval(haInterval); });

  server.on("close", () => {
    getSessionBackend().shutdown().catch((err) => log.error(`Session backend shutdown on close: ${err}`));
  });

  return server;
}

/** The running-task row shape shared by `/api/status`, `/status` and `/jobs`,
 *  so their three copies can't drift the way `/status`'s `itemShort` once did. */
async function runningTaskViews() {
  return (await getRunningTasks()).map((t) => ({
    jobName: t.job_name,
    repo: t.repo,
    itemNumber: t.item_number,
    itemShort: shortIssueRef(t.item_number),
    startedAt: t.started_at,
  }));
}

/** Work-queue kinds whose `item_number` is a PR, not an issue (#clw_01M39XF6QQ3EF0JX48AT81FNPK).
 *  Everything else in `AGENT_KINDS` is an issue kind; a native `clw_…` id is always an issue. */
const PR_WORK_KINDS: ReadonlySet<string> = new Set([
  AGENT_KINDS.CI_FIXER,
  AGENT_KINDS.CI_FIXER_CONFLICT,
  AGENT_KINDS.CI_FIXER_RERUN,
  AGENT_KINDS.CI_FIXER_PROBLEMATIC,
  AGENT_KINDS.REVIEW_ADDRESSER,
  AGENT_KINDS.PR_REVIEWER,
  AGENT_KINDS.AUTO_MERGER_SWEEP,
]);

/**
 * The `/status` page's Agent Queue table: every queued or running work row,
 * in claim order, joined against its issue/PR title and current Priority
 * label. Titles come from the 60s-cached `listOpenIssues`/`listPRs`, one
 * fetch per distinct repo — `listPRs` only for a repo with a PR-kind row, since
 * it spawns `gh pr list`. An unmatched row still gets a Prioritise button.
 */
async function queueEntryViews(): Promise<QueueEntryView[]> {
  const rows = await listQueuedWork();
  const repos = [...new Set(rows.map((r) => r.repo))];
  const issuesByRepo = new Map<string, Issue[]>();
  const prsByRepo = new Map<string, PR[]>();
  await mapWithConcurrency(repos, 8, async (repo) => {
    issuesByRepo.set(repo, await listOpenIssues(repo).catch((err) => {
      log.warn(`[status] listOpenIssues(${repo}) failed: ${err}`);
      return [];
    }));
    if (rows.some((r) => r.repo === repo && PR_WORK_KINDS.has(r.kind) && !isNativeIssue(r.item_number))) {
      prsByRepo.set(repo, await listPRs(repo).catch((err) => {
        log.warn(`[status] listPRs(${repo}) failed: ${err}`);
        return [];
      }));
    }
  });

  return rows.map((r, i) => {
    const isPr = PR_WORK_KINDS.has(r.kind) && !isNativeIssue(r.item_number);
    const match = isPr
      ? (prsByRepo.get(r.repo) ?? []).find((pr) => pr.number === r.item_number)
      : (issuesByRepo.get(r.repo) ?? []).find((issue) => sameIssueRef(issue.number, r.item_number));
    return {
      id: r.id,
      position: i + 1,
      kind: r.kind,
      repo: r.repo,
      itemNumber: r.item_number,
      itemShort: shortIssueRef(r.item_number),
      status: r.status,
      priority: r.priority === 1,
      title: match?.title ?? "(title unavailable)",
      hasPriorityLabel: hasPriorityLabel(match?.labels ?? []),
    };
  });
}

function jobStateRecord(scheduler: Scheduler): Record<string, boolean> {
  const jobs: Record<string, boolean> = {};
  for (const [name, running] of scheduler.jobStates()) {
    jobs[name] = running;
  }
  return jobs;
}

function registerRoutes(
  app: Hono<Env>,
  scheduler: Scheduler,
): void {
  // ── Public routes (no auth) ──

  app.get("/health", (c) => {
    c.header("Cache-Control", "no-store");
    return jsonOk(c, { status: "ok", version: VERSION, shuttingDown: isShuttingDown(), shutdownElapsedMs: shutdownElapsedMs() });
  });

  app.get("/static/alpine.js", (c) => {
    if (c.req.header("if-none-match") === ALPINE_JS_ETAG) {
      c.header("ETag", ALPINE_JS_ETAG);
      return c.body(null, 304);
    }
    c.header("Content-Type", "application/javascript");
    c.header("Cache-Control", "max-age=31536000, immutable");
    c.header("ETag", ALPINE_JS_ETAG);
    return c.body(ALPINE_JS_SOURCE);
  });

  app.get("/static/chart.js", (c) => {
    if (c.req.header("if-none-match") === CHARTJS_ETAG) {
      c.header("ETag", CHARTJS_ETAG);
      return c.body(null, 304);
    }
    c.header("Content-Type", "application/javascript");
    c.header("Cache-Control", "max-age=31536000, immutable");
    c.header("ETag", CHARTJS_ETAG);
    return c.body(CHARTJS_SOURCE);
  });

  app.get("/static/tailwind.css", (c) => {
    if (c.req.header("if-none-match") === TAILWIND_CSS_ETAG) {
      c.header("ETag", TAILWIND_CSS_ETAG);
      return c.body(null, 304);
    }
    c.header("Content-Type", "text/css");
    c.header("Cache-Control", "no-cache");
    c.header("ETag", TAILWIND_CSS_ETAG);
    return c.body(TAILWIND_CSS_SOURCE);
  });

  app.get("/manifest.webmanifest", (c) => {
    c.header("Content-Type", "application/manifest+json");
    c.header("Cache-Control", "max-age=86400");
    return c.body(WEB_MANIFEST);
  });

  const serveIcon = async (c: Ctx, size: number) => {
    try {
      const png = await getAppIconPng(size);
      c.header("Content-Type", "image/png");
      c.header("Cache-Control", "max-age=86400");
      return c.body(new Uint8Array(png));
    } catch (err) {
      log.warn(`[pwa] icon render failed (${size}): ${err}`);
      return c.body(null, 500);
    }
  };

  app.get("/static/icon-180.png", (c) => serveIcon(c, 180));
  app.get("/static/icon-192.png", (c) => serveIcon(c, 192));
  app.get("/static/icon-512.png", (c) => serveIcon(c, 512));
  app.get("/apple-touch-icon.png", (c) => serveIcon(c, 180));
  app.get("/apple-touch-icon-precomposed.png", (c) => serveIcon(c, 180));

  // Public by design: reports only whether the caller's *own* cookie is still
  // valid, so a restored page can detect a lapsed session without having to
  // parse authMiddleware's 401 HTML redirect body. Must never itself 401 —
  // src/client/auth-watch.ts treats a non-200 here as "server trouble", not
  // stale auth (#2479). Wire format is consumed by that module.
  app.get("/api/auth/status", (c) => {
    c.header("Cache-Control", "no-store");
    if (!isOidcEnabled()) {
      return jsonOk(c, { authenticated: false, oidcEnabled: false, expiresAt: null });
    }
    const cookies = parseCookies(c.req.header("cookie"));
    const raw = cookies["claws_session"];
    let session: { sub: string; expiresAt: number } | null = null;
    if (raw) {
      let decoded: string;
      try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
      session = verifySession(decoded, config.OIDC_CLIENT_SECRET);
    }
    return jsonOk(c, {
      authenticated: !!session,
      oidcEnabled: true,
      expiresAt: session ? session.expiresAt : null,
    });
  });

  app.get("/login", (c) => {
    if (isOidcEnabled()) {
      const raw = c.req.query("next") ?? "/";
      const returnTo =
        raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")
          ? raw
          : "/";
      const { baseUrl, redirectUri } = resolveOidcTarget(c);
      const state = generateOAuthState(returnTo, baseUrl, redirectUri);
      const authorizeUrl = new URL(
        `${baseUrl}/application/o/authorize/`,
      );
      authorizeUrl.searchParams.set("client_id", config.OIDC_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", "openid profile email");
      authorizeUrl.searchParams.set("state", state);
      return c.redirect(authorizeUrl.toString(), 302);
    }

    return textPlain(
      c,
      "Authentication is not configured. Set the OIDC_* variables in ~/.claws/env to enable login.",
      503,
    );
  });

  app.get("/auth/callback", async (c) => {
    if (!isOidcEnabled()) {
      return c.body(null, 404);
    }

    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      return htmlOk(c, "Bad request: missing code or state parameter", 400);
    }

    const stateEntry = consumeOAuthState(state);
    if (!stateEntry) {
      return htmlOk(c, "Bad request: invalid or expired OAuth state. Please try logging in again.", 400);
    }
    const { returnTo, baseUrl, redirectUri } = stateEntry;

    try {
      const tokenUrl = `${baseUrl}/application/o/token/`;
      const tokenRes = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: config.OIDC_CLIENT_ID,
          client_secret: config.OIDC_CLIENT_SECRET,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        log.error(`OIDC token exchange failed: ${tokenRes.status} ${text}`);
        return htmlOk(c, "Authentication failed: could not exchange code. Please try again.", 502);
      }

      const tokens = (await tokenRes.json()) as { access_token: string };

      if (!tokens.access_token || typeof tokens.access_token !== "string") {
        log.error("OIDC token exchange: missing access_token in response");
        return htmlOk(c, "Authentication failed: unexpected token response.", 502);
      }

      const userinfoUrl = `${baseUrl}/application/o/userinfo/`;
      const userRes = await fetch(userinfoUrl, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!userRes.ok) {
        log.error(`OIDC userinfo fetch failed: ${userRes.status}`);
        return htmlOk(c, "Authentication failed: could not fetch user info. Please try again.", 502);
      }

      const userinfo = (await userRes.json()) as { sub: string };

      if (!userinfo.sub || typeof userinfo.sub !== "string") {
        log.error("OIDC userinfo: missing sub claim");
        return htmlOk(c, "Authentication failed: user identity missing.", 502);
      }

      // No in-app identity allowlist by design. Dashboard authorization is
      // enforced upstream by the Authentik group policy bindings for the
      // claws-app application (fleet-infra:
      // apps/authentik/configmap-blueprints.yaml, "Claws bindings"), which
      // restrict completion of OIDC authorization to members of group-infra
      // or group-all-apps (policy_engine_mode: any). A user who can merely
      // authenticate to the IdP but is not in those groups is rejected at the
      // application-authorization step and never reaches this callback with a
      // valid code, so any sub/email arriving here is already authorized.
      // Adding a second allowlist here would duplicate that version-controlled
      // authorization across two systems (drift hazard) for a single-tenant
      // deployment. See issue #1792.

      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      const sessionValue = signSession(userinfo.sub, expiresAt, config.OIDC_CLIENT_SECRET);

      log.info(`OIDC login: sub=${userinfo.sub}`);
      c.header("Set-Cookie", `claws_session=${encodeURIComponent(sessionValue)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${24 * 60 * 60}`);
      return c.redirect(returnTo, 303);
    } catch (err) {
      log.error(`OIDC callback error: ${err}`);
      return htmlOk(c, "Internal error during authentication. Please try again.", 500);
    }
  });

  app.get("/logout", (c) => {
    c.header("Set-Cookie", `claws_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`, { append: true });

    const { baseUrl, redirectUri } = resolveOidcTarget(c);
    if (isOidcEnabled() && redirectUri) {
      const postLogoutUri = encodeURIComponent(
        redirectUri.replace(/\/auth\/callback$/, "/login"),
      );
      const endSessionUrl = `${baseUrl}/application/o/${config.OIDC_APPLICATION_SLUG}/end-session/?post_logout_redirect_uri=${postLogoutUri}`;
      return c.redirect(endSessionUrl, 303);
    }
    return c.redirect("/", 303);
  });

  // ── /api/state uses apiAuth (JSON 401) ──

  app.get("/api/state", apiAuthMiddleware, async (c) => {
    const snapshot = getQueueSnapshot(ALL_QUEUE_CATEGORIES);
    const ws = await worker.workerStatus();
    const queuedRows = await listQueuedWork();
    return jsonOk(c, {
      queue: snapshot.items,
      claudeQueue: { pending: ws.queued, active: ws.running },
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
      const snapshot = getQueueSnapshot(ALL_QUEUE_CATEGORIES);
      const ws = await worker.workerStatus();
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

  app.get("/api/runtime/jobs", apiAuthMiddleware, async (c) => {
    try {
      const latestRuns = await getLatestRunIdsByJob();
      const schedInfo = scheduler.jobScheduleInfo();
      const pausedSet = scheduler.pausedJobs();
      const manualSet = scheduler.manualOnlyJobs();
      const jobs = [...scheduler.jobStates()].sort(([a], [b]) => a.localeCompare(b)).map(([name, running]) => {
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
    // The GitHub App installation token can reach repos outside Claws' managed
    // set, so gate on the configured list.
    if (!await isConfiguredRepo(repo)) {
      return jsonOk(c, { error: `${repo} is not a configured repo` }, 404);
    }
    try {
      const comments = await getIssueComments(repo, issue);
      const planText = planParser.findPlanComment(comments);
      const plan = planText ? planParser.parsePlan(planText) : null;
      const mergedPRs = await listMergedPRsForIssue(repo, issue);
      // The stored PR list when there is one, the plan text otherwise.
      const { totalPhases, coverage, entries } = await loadIssuePhaseState(repo, issue, comments, { planText, mergedPRs });
      return jsonOk(c, {
        repo,
        issue,
        totalPhases,
        nextPhase: coverage.nextPhase,
        readyPhases: coverage.readyPhases,
        openPhases: coverage.openPhases,
        blockedPhases: coverage.blockedPhases,
        source: entries ? "stored" : "plan-text",
        phases: Array.from({ length: totalPhases }, (_, i) => i + 1).map((phase) => {
          const pr = coverage.coveringPRs.get(phase);
          const entry = entries?.[phase - 1];
          return {
            phase,
            title: entry?.title ?? plan?.phases[phase - 1]?.title ?? null,
            repo: entry?.repo ?? repo,
            covered: coverage.covered.has(phase),
            coveredBy: pr?.number ?? null,
            state: pr?.state ?? null,
            // Effective dependencies: declared, else after the previous step.
            dependsOn: coverage.dependencies.get(phase) ?? [],
            status: coverage.done.has(phase) ? "done"
              : coverage.covered.has(phase) ? "pending"
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
    return { id: record.id, repo: clawsIssues.primaryRepo(record.repos) };
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
    const [comments, plans] = await Promise.all([
      clawsIssues.listCommentDetails(record.id),
      clawsIssues.listPlans(record.id),
    ]);
    // The plan comment is reported separately as `plan`, not in `comments` —
    // the same split the `/issues/:id` page renders.
    const latestPlan = plans.at(-1) ?? null;
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
      plan: latestPlan
        ? { version: latestPlan.version, comment_id: latestPlan.commentId, created_at: latestPlan.createdAt, body: latestPlan.body }
        : null,
      previous_plans: plans.slice(0, -1).map((p) => ({ version: p.version, comment_id: p.commentId, created_at: p.createdAt })),
      comments: comments
        .filter((cm) => latestPlan?.commentId == null || String(cm.id) !== latestPlan.commentId)
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
    // Ordered `updated_at DESC` already, by listOpenClawsIssues' own query.
    const records = repo !== undefined ? await listOpenClawsIssues({ repo }) : await listOpenClawsIssues({});
    const plansByIssue = await clawsIssues.getLatestPlansForOpenIssues();
    const truncated = records.length > 100;
    return jsonOk(c, {
      issues: records.slice(0, 100).map((r) => ({
        id: r.id,
        title: r.title,
        state: r.state,
        labels: r.labels,
        repos: r.repos,
        updated_at: clawsIssues.toIso(r.updated_at),
        has_plan: plansByIssue.has(r.id),
      })),
      truncated,
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
    const { kind: rawKind, issue: target } = (body ?? {}) as { kind?: unknown; issue?: unknown };
    const kind = issueLinks.parseLinkKind(rawKind);
    if (!kind) return jsonOk(c, { error: `kind must be one of ${issueLinks.LINK_KINDS.join(", ")}` }, 400);
    if (typeof target !== "string" && typeof target !== "number") return jsonOk(c, { error: "issue must be an issue reference" }, 400);
    try {
      const result = await issueLinks.addLink(issue.repo, issue.id, kind, String(target), clawsIssues.CLAWS_NATIVE_LOGIN);
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

  /**
   * File a native issue. Backs the `claws_create_issue` MCP tool for both
   * interactive sessions and headless agents (#3286) — the write path that
   * replaces `gh issue create` now every new issue is filed natively
   * (docs/issue-tracker.md). Mirrors the `/issues` dashboard form's label
   * rules; unlike the form, `repos` is required, since an agent-filed issue
   * with none would sit unplanned with nothing pointing an implementer at it.
   */
  app.post("/api/issues", apiAuthMiddleware, async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { title, body: issueBody, repos: reposInput, labels: labelsInput, sessionId, autoPromote } = (body ?? {}) as {
      title?: unknown; body?: unknown; repos?: unknown; labels?: unknown; sessionId?: unknown; autoPromote?: unknown;
    };
    if (autoPromote !== undefined && typeof autoPromote !== "boolean") {
      return jsonOk(c, { error: "autoPromote must be a boolean when given" }, 400);
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
    // lifecycle is set by moving the issue rather than by a label a caller sends.
    const labelsWanted = Array.isArray(labelsInput) ? labelsInput.filter((l): l is string => typeof l === "string") : [];
    const labels = labelsWanted.filter((l) => l in config.LABEL_SPECS && !isStateLabel(l));
    const ignoredLabels = labelsWanted.filter((l) => !labels.includes(l));
    const fromSession = typeof sessionId === "string" && !!sessionId;
    const authorLogin = fromSession
      ? (config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN)
      : clawsIssues.CLAWS_NATIVE_LOGIN;
    // An interactive session has a human watching (attended); a headless
    // agent does not, so its issue auto-promotes unless told otherwise.
    const id = await clawsIssues.createIssue({
      title: title.trim(),
      body: typeof issueBody === "string" ? issueBody : "",
      authorLogin,
      repos,
      labels,
      source: fromSession ? "session" : "agent",
      autoPromote,
    });
    const primaryRepo = clawsIssues.primaryRepo(repos);
    const result: Record<string, unknown> = { id, ref: `#${id}`, url: clawsIssues.dashboardIssueUrl(id), repos, labels, ignoredLabels, primaryRepo };
    // Multi-repo issues (docs/issue-tracker.md "Repositories and the primary
    // repository"): the primary repo owns planning, and one plan covers every
    // named repo's PRs, run one at a time — no companion issues are filed.
    if (repos.length > 1) {
      result.note = `${primaryRepo} is this issue's primary repository: it owns planning, and one plan will cover the PRs needed across ${repos.join(", ")}, run one at a time, with no companion issues.`;
    }
    return jsonOk(c, result);
  });

  /**
   * Comment on a native issue. Backs the `claws_comment_on_issue` MCP tool
   * (#3286) — a session posts as the operator, with no "Automated by Claws"
   * marker, so the refiner reads it as feedback exactly like a dashboard
   * comment; a headless agent posts through the `github.ts` façade, which
   * stamps the marker itself.
   */
  app.post("/api/issues/:id/comments", apiAuthMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return jsonOk(c, { error: "Issue not found" }, 404);
    let parsed: unknown;
    try { parsed = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { body: commentBody, sessionId } = (parsed ?? {}) as { body?: unknown; sessionId?: unknown };
    if (typeof commentBody !== "string" || !commentBody.trim()) {
      return jsonOk(c, { error: "body must be a non-empty string" }, 400);
    }
    const repo = eventRepo(loaded.record.repos);
    if (typeof sessionId === "string" && sessionId) {
      await clawsIssues.commentOnIssue(repo, loaded.id, commentBody, config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN);
    } else {
      await ghCommentOnIssue(repo, loaded.id, commentBody);
    }
    return jsonOk(c, { ok: true, id: loaded.id, url: clawsIssues.dashboardIssueUrl(loaded.id) });
  });

  /**
   * Long-poll for Claws-originated GitHub state changes (#2832). Backs the
   * `claws_wait_for_change` MCP tool, so a session driving the /ship skill can
   * block until Claws acts instead of sleeping and re-polling `gh`.
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

    const kinds: GitHubEventKind[] = [];
    for (const raw of split(c.req.query("kinds"))) {
      if (!(GITHUB_EVENT_KINDS as string[]).includes(raw)) {
        return jsonOk(c, { error: `unknown event kind "${raw}"` }, 400);
      }
      kinds.push(raw as GitHubEventKind);
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
   * `claws_wait_for_change` holds a request up to 270 s, within
   * `server.requestTimeout`.
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
    let size: number;
    try {
      size = fs.statSync(found.absolutePath).size;
    } catch {
      return textPlain(c, "attachment file missing", 404);
    }
    // The raw stored type, as the in-process read returns: no browser renders this.
    c.header("Content-Type", found.row.content_type);
    c.header("Content-Length", String(size));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    const stream = Readable.toWeb(fs.createReadStream(found.absolutePath)) as unknown as ReadableStream<Uint8Array>;
    return c.body(stream, 200);
  });

  // ── Authenticated routes ──

  app.post("/trigger/:job", authMiddleware, (c) => {
    const jobName = c.req.param("job");
    const result = scheduler.triggerJob(jobName);
    const status = result === "started" ? 200 : result === "unknown" ? 404 : 409;
    return jsonOk(c, { result }, status);
  });

  app.post("/pause/:job", authMiddleware, (c) => {
    const jobName = c.req.param("job");
    const paused = scheduler.pausedJobs();
    let result: string;
    if (paused.has(jobName)) {
      if (!scheduler.resumeJob(jobName)) {
        return jsonOk(c, { result: "unknown" }, 404);
      }
      const updated = [...scheduler.pausedJobs()];
      writeConfig({ pausedJobs: updated });
      result = "resumed";
    } else {
      if (!scheduler.pauseJob(jobName)) {
        return jsonOk(c, { result: "unknown" }, 404);
      }
      const updated = [...scheduler.pausedJobs()];
      writeConfig({ pausedJobs: updated });
      result = "paused";
    }
    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] Job "${sanitizeForNotification(jobName)}" ${result}`);
    }
    return jsonOk(c, { result });
  });

  app.post("/cancel", authMiddleware, async (c) => {
    let cancelled = cancelCurrentTask();
    // Headless agents run in their own pods under k8s-pod, not as children of this process.
    if (config.WORK_BACKEND === "k8s-pod" && await getAgentPodLauncher().cancelAll() > 0) cancelled = true;
    return jsonOk(c, { result: cancelled ? "cancelled" : "no-active-task" });
  });

  app.post("/api/verify/run", authMiddleware, async (c) => {
    try {
      const report = await runConnectivityVerification();
      const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
      if (wantsJson) {
        return jsonOk(c, report);
      }
      return c.redirect("/config#activation", 303);
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/api/claude-auth/start", authMiddleware, async (c) => {
    const r = await startClaudeLogin();
    return jsonOk(c, r, r.ok ? 200 : 500);
  });
  app.post("/api/claude-auth/code", authMiddleware, async (c) => {
    const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
    const r = await submitClaudeLoginCode(body.code ?? "");
    return jsonOk(c, r, r.ok ? 200 : 400);
  });
  app.get("/api/claude-auth/status", authMiddleware, (c) => jsonOk(c, getClaudeLoginStatus()));

  app.post("/api/codex-auth/start", authMiddleware, async (c) => {
    const r = await startCodexLogin();
    return jsonOk(c, r, r.ok ? 200 : 500);
  });
  app.get("/api/codex-auth/status", authMiddleware, (c) => jsonOk(c, getCodexLoginStatus()));

  app.get("/api/providers", authMiddleware, (c) => {
    function status(provider: "claude" | "codex" | "opencode") {
      const until = getProviderRateLimitedUntil(provider);
      return {
        rateLimited: until !== null,
        rateLimitedUntil: until !== null ? new Date(until).toISOString() : null,
        authExpired: isAgentAuthExpired(provider),
      };
    }
    return jsonOk(c, { claude: status("claude"), codex: status("codex"), opencode: status("opencode") });
  });

  app.post("/api/providers/:provider/clear-rate-limit", authMiddleware, (c) => {
    const provider = c.req.param("provider");
    if (provider !== "claude" && provider !== "codex" && provider !== "opencode") {
      return jsonOk(c, { ok: false, error: "unknown provider" }, 400);
    }
    const cleared = clearProviderRateLimitState(provider);
    if (cleared && config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] Cleared rate-limit cooldown for provider "${provider}"`);
    }
    return jsonOk(c, { ok: true, cleared });
  });

  app.get("/api/opencode/models", authMiddleware, async (c) => {
    try {
      return jsonOk(c, { models: await listOpenRouterSessionModels() });
    } catch (err) {
      log.warn(`[sessions] OpenRouter model catalogue unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return jsonOk(c, { error: "catalogue unavailable" }, 502);
    }
  });
  app.post("/api/client-error", authMiddleware, async (c) => {
    try {
      const raw = await readTextBody(c, 8192);
      const parsed = JSON.parse(raw);
      const fingerprint = typeof parsed.fingerprint === "string" && parsed.fingerprint
        ? `client-error: ${parsed.fingerprint.slice(0, 200)}`
        : "client-error: unknown";
      const message = typeof parsed.message === "string" ? parsed.message.slice(0, 500) : "unknown";
      const stack = typeof parsed.stack === "string" ? parsed.stack.slice(0, 2000) : "";
      const context = typeof parsed.context === "string" ? parsed.context.slice(0, 200) : "client";
      const err = new Error(message);
      err.stack = stack || `Error: ${message}`;
      void reportError(fingerprint, `client-side JS error on ${context}`, err);
    } catch {
      // ignore malformed payloads
    }
    return c.body(null, 204);
  });

  app.get("/api/activation", authMiddleware, async (c) => {
    const report = await loadLatestReport();
    return jsonOk(c, {
      state: config.ACTIVATION_STATE,
      lastVerification: report ? { generatedAt: report.generatedAt, failures: report.checks.filter((ck) => !ck.ok).length } : null,
    });
  });

  app.post("/api/activation", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = JSON.parse(body) as { state?: string; confirm?: boolean };
      if (!parsed.confirm) {
        return jsonOk(c, { error: "confirm:true required" }, 400);
      }
      if (parsed.state !== "active" && parsed.state !== "staging" && parsed.state !== "verify-only") {
        return jsonOk(c, { error: "state must be 'active', 'staging', or 'verify-only'" }, 400);
      }
      if (parsed.state === config.ACTIVATION_STATE) {
        return jsonOk(c, { result: "unchanged", state: parsed.state });
      }
      writeConfig({ activationState: parsed.state });
      log.warn(`[activation] Flipped to ${parsed.state}`);
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] Activation flipped to ${parsed.state}`);
      }
      return jsonOk(c, { result: "flipped", state: parsed.state, restartRequired: true });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/refresh", authMiddleware, (c) => {
    const jobs = ["issue-dispatcher", "pr-dispatcher"];
    const results: Record<string, string> = {};
    for (const name of jobs) {
      results[name] = scheduler.triggerJob(name);
    }
    return jsonOk(c, { results });
  });

  app.post("/queue/merge", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, prNumber, confirmInfra } = RepoItemSchema.parse(JSON.parse(body));
      const repoObj = await findConfiguredRepo(repo);
      if (!repoObj) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      const infra = infraPathsIn(await getPRChangedFiles(repo, prNumber));
      if (infra.length > 0 && !confirmInfra) {
        return jsonOk(c, { error: `PR touches infrastructure (${infra.slice(0, 5).join(", ")}); reload the page and confirm to merge` }, 409);
      }
      const prFromList = (await listPRs(repoObj.fullName).catch(() => [])).find((p) => p.number === prNumber);
      await recordMergeApproval(c, repo, prNumber);
      await mergePR(repo, prNumber);
      removeQueueItem(repo, prNumber);
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
      writeConfig({ skippedItems: items });
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
      writeConfig({ skippedItems: items });
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
      writeConfig({ prioritizedItems: items });
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
      writeConfig({ prioritizedItems: items });
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
      await addLabel(repo, number, LABELS.refined);
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
      const { repo, number, alsoRefine } = parsed.data;
      if (!(await isConfiguredRepo(repo))) {
        return jsonOk(c, { error: "Repository not configured" }, 403);
      }
      // A PR Claws tracks records who approved its merge before it takes the
      // label, so the label hook keeps the identity.
      await recordMergeApproval(c, repo, number);
      await ensureLabel(repo, LABELS.automerge);
      await addLabel(repo, number, LABELS.automerge);
      if (alsoRefine) {
        await addLabel(repo, number, LABELS.refined);
        removeQueueItem(repo, number);
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

  app.post("/jobs", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);

    try {
      const repos = await listRepos();
      const newDisabled: Record<string, string[]> = {};
      const knownJobNames = new Set<string>(REPO_JOB_NAMES);
      // Jobs actually registered on the scheduler. A name in neither this set
      // nor REPO_JOB_NAMES is a job that no longer exists (#2936). Guarded on
      // non-empty for the same reason the repos list is below: a degenerate
      // view of the world must not wipe config.
      const registeredJobNames = new Set(scheduler.jobStates().keys());
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
        for (const job of REPO_JOB_NAMES) {
          if (locked.has(job)) {
            if (hostEntry.includes(job)) droppedCovered.push(`${repo.fullName}:${job}`);
            continue;
          }
          const fieldName = `${repo.fullName}::${job}`;
          const checked = params[fieldName] === "true";
          if (!checked) disabledJobs.push(job);
        }
        for (const job of hostEntry) {
          if (knownJobNames.has(job) || disabledJobs.includes(job)) continue;
          if (locked.has(job)) {
            droppedCovered.push(`${repo.fullName}:${job}`);
            continue;
          }
          if (registeredJobNames.size > 0 && !registeredJobNames.has(job)) {
            droppedDead.push(`${repo.fullName}:${job}`);
            continue;
          }
          // A real job the matrix does not list yet — carry it forward (#2625).
          disabledJobs.push(job);
        }
        if (disabledJobs.length > 0) {
          newDisabled[repo.fullName] = disabledJobs;
        }
      }

      if (droppedDead.length > 0) {
        log.info(`[jobs] Dropped disabledJobsByRepo entries for jobs that no longer exist: ${droppedDead.join(", ")}`);
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

      writeConfig({ disabledJobsByRepo: newDisabled });

      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        const totalDisabled = Object.values(newDisabled).reduce((sum, arr) => sum + arr.length, 0);
        notify(`[dashboard] Job toggles updated: ${totalDisabled} disabled`);
      }

      return c.redirect("/jobs?saved=1", 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to save job toggles: ${message}`);
      return c.redirect("/jobs", 303);
    }
  });

  app.post("/config/remove-unknown-keys", authMiddleware, (c) => {
    const unknownKeys = Array.from(getUnknownConfigKeys());
    if (unknownKeys.length > 0) {
      try {
        removeConfigKeys(unknownKeys);
        if (config.NOTIFY_DASHBOARD_ACTIONS) {
          notify(`[dashboard] Removed unknown config keys: ${unknownKeys.join(", ")}`);
        }
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

    if (params["githubOwners"] !== undefined) {
      updates.githubOwners = params["githubOwners"].split(",").map((s) => s.trim()).filter(Boolean);
    }
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

    if (params["notifyDashboardActions"] !== undefined) {
      updates.notifyDashboardActions = params["notifyDashboardActions"] === "true";
    } else {
      updates.notifyDashboardActions = false;
    }

    if (params["openrouterApiKey"] !== undefined) updates.openrouterApiKey = params["openrouterApiKey"];
    if (params["ollamaBaseUrl"] !== undefined) updates.ollamaBaseUrl = params["ollamaBaseUrl"];
    if (params["ollamaTimeoutMs"] !== undefined) {
      const v = parseInt(params["ollamaTimeoutMs"], 10);
      if (v > 0) updates.ollamaTimeoutMs = v * 1000;
    }
    if (params["ollamaConsecutiveFailuresBeforeDisable"] !== undefined) {
      const v = parseInt(params["ollamaConsecutiveFailuresBeforeDisable"], 10);
      if (v > 0) updates.ollamaConsecutiveFailuresBeforeDisable = v;
    }
    const ALL_PROVIDERS = ["claude", "codex", "opencode"] as const;
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
    if (params["opencodeBestModel"] !== undefined) updates.opencodeBestModel = params["opencodeBestModel"];
    if (params["opencodeAdequateModel"] !== undefined) updates.opencodeAdequateModel = params["opencodeAdequateModel"];
    if (params["opencodeCheapModel"] !== undefined) updates.opencodeCheapModel = params["opencodeCheapModel"];
    if (params["improvementIdentifierModel"] !== undefined) updates.improvementIdentifierModel = params["improvementIdentifierModel"];
    if (params["claudeCheapModel"] !== undefined) updates.claudeCheapModel = params["claudeCheapModel"];
    if (params["codexDefaultModel"] !== undefined) updates.codexDefaultModel = params["codexDefaultModel"];
    if (params["codexLightModel"] !== undefined) updates.codexLightModel = params["codexLightModel"];
    if (params["codexCheapModel"] !== undefined) updates.codexCheapModel = params["codexCheapModel"];
    if (params["claudeFableModel"] !== undefined) updates.claudeFableModel = params["claudeFableModel"];
    if (params["codexFableModel"] !== undefined) updates.codexFableModel = params["codexFableModel"];
    if (params["opencodeFableModel"] !== undefined) updates.opencodeFableModel = params["opencodeFableModel"];
    if (params["reviewModelTier"] !== undefined) {
      const tier = normalizeTier(params["reviewModelTier"]);
      if (tier) updates.reviewModelTier = tier;
    }

    const oldConfig = loadConfig();

    writeConfig(updates);

    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      const changedParts: string[] = [];
      for (const key of Object.keys(updates)) {
        const newVal = (updates as Record<string, unknown>)[key];
        if (SENSITIVE_KEYS.has(key) && newVal === "") continue;
        const oldVal = (oldConfig as Record<string, unknown>)[key];
        if (DEEP_MERGED_KEYS.has(key) && typeof newVal === "object" && newVal !== null && typeof oldVal === "object" && oldVal !== null) {
          const oldObj = oldVal as Record<string, unknown>;
          const newObj = newVal as Record<string, unknown>;
          for (const subKey of Object.keys(newObj)) {
            if (!isDeepStrictEqual(oldObj[subKey], newObj[subKey])) {
              changedParts.push(`${key}.${subKey} (${JSON.stringify(oldObj[subKey])} → ${JSON.stringify(newObj[subKey])})`);
            }
          }
        } else if (!isDeepStrictEqual(oldVal, newVal)) {
          if (SENSITIVE_KEYS.has(key)) {
            changedParts.push(key);
          } else {
            changedParts.push(`${key} (${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)})`);
          }
        }
      }
      if (changedParts.length > 0) {
        notify(`[dashboard] Config updated: ${changedParts.join(", ")}`);
      }
    }

    return c.redirect("/config?saved=1", 303);
  });

  app.post("/whatsapp/unpair", authMiddleware, async (c) => {
    await unpair();
    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] WhatsApp unpaired`);
    }
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

  // The explicit selection of a successful create becomes that repo
  // combination's pre-ticked default next time. Agent logins follow the Agent
  // select instead, and the always-forced cross-repo baseline is a disabled
  // checkbox that never posts, so neither is remembered; an explicit forgejo
  // tick for a repo selection it isn't forced on IS remembered like any other
  // capability. A DB failure must not fail the create, which has already
  // succeeded.
  const rememberCapabilityDefaults = async (repos: string[], capabilities: string[]): Promise<void> => {
    try {
      await rememberSessionCapabilityDefaults(repos, capabilities.filter((id) => isRememberableCapability(id)));
    } catch (err) {
      log.warn(`[sessions] Could not remember capability defaults for ${repos.join(", ")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  app.post("/sessions/create", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    const repo = params["repo"] || null;
    const rawMode = params["mode"] || "repo-zsh";
    if (!SESSION_MODES.includes(rawMode as SessionMode)) {
      return htmlError(c, 400, "Cannot create session", "Invalid mode", {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    const mode = rawMode as SessionMode;
    const rawProvider = params["provider"] || "claude";
    if (!SESSION_PROVIDERS.includes(rawProvider as SessionProvider)) {
      return htmlError(c, 400, "Cannot create session", "Invalid provider", {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    const provider = rawProvider as SessionProvider;
    const capabilities = validCapabilityIds(parseFormBodyMulti(body, "capability"));
    // Disabled <select>s are not submitted by the browser, so exactly one
    // `model` key arrives even though the form renders one per provider.
    const rawModel = params["model"] || "";
    const model = rawModel === CUSTOM_MODEL_SENTINEL ? (params["modelCustom"] || "").trim() : rawModel.trim();
    if (model && !isValidSessionModel(model)) {
      return htmlError(c, 400, "Cannot create session", "Invalid model id", {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    const result = await getSessionBackend().create({ repo, mode, capabilities, provider, model: model || null });
    if (!result.ok) {
      if (result.reason === "shutting-down") {
        const fields: Array<{ name: string; value: string }> = [];
        if (repo) fields.push({ name: "repo", value: repo });
        fields.push({ name: "mode", value: mode });
        fields.push({ name: "provider", value: provider });
        for (const cap of capabilities) fields.push({ name: "capability", value: cap });
        if (model) fields.push({ name: "model", value: model });
        return shutdownRetryError(c, "Cannot create session", "/sessions/create", fields);
      }
      const status = result.reason === "repo-required-for-mode" || result.reason === "capability-unsupported" ? 400
        : result.reason === "repo-not-found" || result.reason === "repo-not-listed" ? 404
        : result.reason === "backend-unavailable" ? 503
        : 500;
      return htmlError(c, status, "Cannot create session", describeCreateSessionError(result), {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    if (repo) await rememberCapabilityDefaults([repo], capabilities);
    return c.redirect(`/sessions/${result.id}`, 303);
  });

  app.post("/sessions/create-multi", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    const repos = parseFormBodyMulti(body, "repo").filter(Boolean);
    const rawProvider = params["provider"] || "claude";
    if (!SESSION_PROVIDERS.includes(rawProvider as SessionProvider)) {
      return htmlError(c, 400, "Cannot create session", "Invalid provider", {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    const provider = rawProvider as SessionProvider;
    const capabilities = validCapabilityIds(parseFormBodyMulti(body, "capability"));
    const rawModel = params["model"] || "";
    const model = rawModel === CUSTOM_MODEL_SENTINEL ? (params["modelCustom"] || "").trim() : rawModel.trim();
    if (model && !isValidSessionModel(model)) {
      return htmlError(c, 400, "Cannot create session", "Invalid model id", {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    const result = await getSessionBackend().createMulti({ repos, capabilities, provider, model: model || null });
    if (!result.ok) {
      if (result.reason === "shutting-down") {
        const fields: Array<{ name: string; value: string }> = [];
        for (const r of repos) fields.push({ name: "repo", value: r });
        fields.push({ name: "provider", value: provider });
        for (const cap of capabilities) fields.push({ name: "capability", value: cap });
        if (model) fields.push({ name: "model", value: model });
        return shutdownRetryError(c, "Cannot create session", "/sessions/create-multi", fields);
      }
      const status = result.reason === "too-few-repos" || result.reason === "repos-span-owners" || result.reason === "provider-unsupported" || result.reason === "capability-unsupported" ? 400
        : result.reason === "repo-not-found" || result.reason === "repo-not-listed" ? 404
        : result.reason === "backend-unavailable" ? 503
        : 500;
      return htmlError(c, status, "Cannot create session", describeCreateSessionError(result), {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    await rememberCapabilityDefaults(repos, capabilities);
    return c.redirect(`/sessions/${result.id}`, 303);
  });

  app.post("/sessions/:id/kill", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return textPlain(c, "Not found", 404);
    }
    const result = await getSessionBackend().end(id);
    if (!result.ok) {
      return result.reason === "unavailable"
        ? textPlain(c, `Session runtime unavailable${result.detail ? `: ${result.detail}` : ""}`, 503)
        : textPlain(c, "Session not found", 404);
    }
    clearCapabilityRequestsForSession(id);
    return c.redirect("/sessions", 303);
  });

  app.post("/sessions/:id/delete", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return textPlain(c, "Not found", 404);
    }
    const result = await getSessionBackend().remove(id);
    if (!result.ok) {
      return result.reason === "unavailable"
        ? textPlain(c, `Session runtime unavailable${result.detail ? `: ${result.detail}` : ""}`, 503)
        : textPlain(c, "Session not found", 404);
    }
    clearCapabilityRequestsForSession(id);
    return c.redirect("/sessions", 303);
  });

  app.post("/sessions/:id/resume", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return textPlain(c, "Not found", 404);
    }
    const result = await getSessionBackend().resume(id);
    if (!result.ok) {
      const status = result.reason === "shutting-down" || result.reason === "backend-unavailable" ? 503
        : result.reason === "repo-not-found" || result.reason === "repo-not-listed" ? 404
        : 500;
      if ((c.req.header("accept") ?? "").includes("text/html")) {
        if (result.reason === "shutting-down") {
          return shutdownRetryError(c, "Cannot revive session", `/sessions/${id}/resume`, []);
        }
        return htmlError(c, status, "Cannot revive session", describeCreateSessionError(result), {
          detail: id, actions: [{ href: "/sessions", label: "← All sessions" }],
        });
      }
      return textPlain(c, `Cannot resume session: ${describeCreateSessionError(result)}`, status);
    }
    return c.redirect(`/sessions/${id}`, 303);
  });

  const setDescriptionHandler = async (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const raw = (body as { description?: unknown } | null)?.description;
    if (raw != null && typeof raw !== "string") return jsonOk(c, { error: "description must be a string" }, 400);
    const result = await getSessionBackend().setDescription(id, typeof raw === "string" ? raw : "");
    if (!result.ok) return jsonOk(c, { error: "Session not found" }, 404);
    return jsonOk(c, { description: result.description });
  };

  app.post("/sessions/:id/description", authMiddleware, setDescriptionHandler);
  app.post("/api/sessions/:id/description", apiAuthMiddleware, setDescriptionHandler);

  app.get("/api/sessions/:id/startup", apiAuthMiddleware, async (c) => {
    const id = c.req.param("id") ?? "";
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const result = await getSessionBackend().getStartupStatus(id);
    if (!result.ok) {
      return result.reason === "unavailable"
        ? jsonOk(c, { error: "Session runtime unavailable", detail: result.detail ?? null }, 503)
        : jsonOk(c, { error: "Not found" }, 404);
    }
    return jsonOk(c, result.status);
  });

  /**
   * Whether an approved grant reached a waiting agent, and the one-line notice
   * the approving page types into the agent's terminal when it did not (#3106).
   */
  const agentNoticeFields = (capability: string, pickup: AgentPickup) => ({
    agentPickedUp: pickup.agentPickedUp,
    agentNotice: pickup.agentNoticeNeeded ? agentGrantNotice(capability) : null,
  });

  // Operator-only (#3072): never `apiAuthMiddleware`, whose INTERNAL_MCP_TOKEN
  // every agent holds — an agent must not be able to grant itself access.
  app.post("/sessions/:id/capabilities", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const capability = (body as { capability?: unknown } | null)?.capability;
    if (typeof capability !== "string" || !capability) return jsonOk(c, { error: "capability must be a non-empty string" }, 400);
    const result = await getSessionBackend().grantCapability(id, capability);
    if (!result.ok) {
      if (result.reason === "invalid") return jsonOk(c, { error: result.detail }, 400);
      if (result.reason === "unavailable") {
        return jsonOk(c, { error: `Session runtime unavailable${result.detail ? `: ${result.detail}` : ""}` }, 503);
      }
      return jsonOk(c, { error: "Session not found" }, 404);
    }
    const outcome = { live: result.live, loadPath: result.loadPath, marker: result.marker, delayed: result.delayed };
    // Only a grant that resolved an agent's pending request may notify the agent (#3106).
    if (!recordCapabilityGrant(id, capability)) return jsonOk(c, outcome);
    return jsonOk(c, { ...outcome, ...agentNoticeFields(capability, await resolveAgentPickup(id, capability, result.live)) });
  });

  // ── Agent-initiated capability requests (#3072) ──
  // The agent asks through `claws_request_capability` (INTERNAL_MCP_TOKEN, so
  // `apiAuthMiddleware`); only the operator's OIDC session may approve or deny.

  const runtimeUnavailable = (c: Ctx, detail?: string) =>
    jsonOk(c, { error: `Session runtime unavailable${detail ? `: ${detail}` : ""}` }, 503);

  /** A capability the live session holds, described with how it is delivered now (see `SessionBackend.grantDelivery`). */
  const grantedCapabilityResponse = async (c: Ctx, id: string, capability: string) => {
    const delivery = await getSessionBackend().grantDelivery(id, capability);
    if (!delivery.ok) {
      return delivery.reason === "unavailable" ? runtimeUnavailable(c, delivery.detail) : jsonOk(c, { error: "Session not found" }, 404);
    }
    markCapabilityGrantSeen(id, capability);
    return jsonOk(c, describeGrantedCapability(capability, delivery, getCapabilityRequest(id, capability)));
  };

  app.post("/api/sessions/:id/capability-requests", apiAuthMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { capability, reason } = (body ?? {}) as { capability?: unknown; reason?: unknown };
    if (typeof capability !== "string" || !capability) return jsonOk(c, { error: "capability must be a non-empty string" }, 400);
    if (typeof reason !== "string" || !reason.trim()) return jsonOk(c, { error: "reason must be a non-empty string" }, 400);
    markCapabilityPolled(id, capability);
    const backend = getSessionBackend();
    const live = await backend.getLive(id);
    if (!live.ok && live.reason === "unavailable") return runtimeUnavailable(c, live.detail);
    if (!live.ok || !live.session.alive) return jsonOk(c, { error: "Session not found" }, 404);
    if (live.session.capabilities.includes(capability)) return grantedCapabilityResponse(c, id, capability);
    const requestable = liveGrantableCapabilities(live.session.capabilities, backend.kind).map((cap) => cap.id);
    if (!requestable.includes(capability)) {
      return jsonOk(c, {
        error: `${capability} is not requestable for this session. Requestable: ${requestable.length > 0 ? requestable.join(", ") : "none"}`,
      }, 400);
    }
    const created = requestCapability(id, capability, reason);
    if (!created.ok) {
      return jsonOk(c, { error: `This session already has ${MAX_PENDING_CAPABILITY_REQUESTS} pending capability requests — wait for the user to decide them` }, 429);
    }
    return jsonOk(c, describeCapabilityRequest(created.request));
  });

  app.get("/api/sessions/:id/capability-requests/:cap", apiAuthMiddleware, async (c) => {
    const id = c.req.param("id");
    const capability = c.req.param("cap");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    markCapabilityPolled(id, capability);
    const entry = getCapabilityRequest(id, capability);
    if (entry && entry.status !== "approved") return jsonOk(c, describeCapabilityRequest(entry));
    const live = await getSessionBackend().getLive(id);
    if (!live.ok && live.reason === "unavailable") return runtimeUnavailable(c, live.detail);
    if (live.ok && live.session.alive && live.session.capabilities.includes(capability)) {
      return grantedCapabilityResponse(c, id, capability);
    }
    return jsonOk(c, { error: `No request for ${capability} (Claws may have restarted) — request it again` }, 404);
  });

  app.get("/sessions/:id/capability-requests", authMiddleware, (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    return jsonOk(c, { requests: listPendingCapabilityRequests(id).map(describeCapabilityRequest) });
  });

  // `code` tells the dashboard a request that is already gone ("no-request",
  // drop its banner) from a grant that failed ("session-not-found", show it).
  const decideCapabilityRequestHandler = (approve: boolean) => async (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    const capability = c.req.param("cap") ?? "";
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const result = await decideCapabilityRequest(id, capability, approve);
    if (result.ok) {
      return jsonOk(c, result.grant
        ? { ...describeGrantedCapability(capability, result.grant, result.request), ...agentNoticeFields(capability, result) }
        : describeCapabilityRequest(result.request));
    }
    if (result.reason === "grant-failed") {
      const { grant } = result;
      if (grant.reason === "invalid") return jsonOk(c, { error: grant.detail }, 400);
      if (grant.reason === "unavailable") return runtimeUnavailable(c, grant.detail);
      return jsonOk(c, { error: "Session not found — it may have ended", code: "session-not-found" }, 404);
    }
    if (result.reason === "not-pending") return jsonOk(c, { error: "This request has already been decided" }, 409);
    return jsonOk(c, { error: "No such capability request", code: "no-request" }, 404);
  };

  // Operator-only: never `apiAuthMiddleware`, or an agent could approve its own request.
  app.post("/sessions/:id/capability-requests/:cap/approve", authMiddleware, decideCapabilityRequestHandler(true));
  app.post("/sessions/:id/capability-requests/:cap/deny", authMiddleware, decideCapabilityRequestHandler(false));

  // Self-reported agent status (#3083), set by the session's `claws_set_session_status` MCP tool.
  const setAgentStatusHandler = async (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const status = (body as { status?: unknown } | null)?.status;
    if (!isSessionAgentStatus(status)) {
      return jsonOk(c, { error: `status must be one of ${SESSION_AGENT_STATUSES.join(", ")}` }, 400);
    }
    const result = await getSessionBackend().setAgentStatus(id, status);
    if (!result.ok) return jsonOk(c, { error: "Session not found" }, 404);
    return jsonOk(c, { status: result.status, updatedAt: result.updatedAt });
  };

  app.post("/api/sessions/:id/status", apiAuthMiddleware, setAgentStatusHandler);

  app.post("/sessions/:id/resummarize", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const result = await getSessionBackend().resummarize(id);
    if (!result.ok) return jsonOk(c, { error: "Session not found or not running" }, 404);
    return jsonOk(c, { description: result.description });
  });

  app.post(
    "/sessions/:id/upload",
    authMiddleware,
    // Enforce the cap while the body streams in — a chunked request has no
    // Content-Length to check, so without this the whole payload would be
    // buffered by parseBody() before saveSessionUpload() could reject it.
    // Slack of 4096 bytes covers multipart boundary/header framing around an
    // exactly-MAX_UPLOAD_BYTES file; the true per-file cap is still enforced
    // by saveSessionUpload().
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES + 4096,
      onError: (c) => {
        c.header("Content-Type", "application/json");
        return c.body(JSON.stringify({ error: "File too large (max 10 MB)" }), 413);
      },
    }),
    async (c) => {
      const id = c.req.param("id");
      if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
      const live = await checkUploadTarget(c, id);
      if (live) return live;
      let file: unknown;
      try {
        file = (await c.req.parseBody())["file"];
      } catch (err) {
        return jsonOk(c, { error: `Malformed upload: ${String(err)}` }, 400);
      }
      if (!(file instanceof File)) return jsonOk(c, { error: "Missing file field" }, 400);
      const buf = Buffer.from(await file.arrayBuffer());
      const result = await getSessionBackend().saveUpload(id, file.name, buf);
      if (!result.ok) return uploadErrorResponse(c, result, "10 MB");
      log.info(`[server] Session ${id}: stored upload ${result.path} (${buf.byteLength} bytes)`);
      if (isAudioUpload(file.name, file.type)) {
        if (!transcribeAvailable()) {
          return jsonOk(c, { path: result.path, transcriptError: "Transcription is not configured (set CLAWS_WHISPER_LOCAL_URL, CLAWS_WHISPER_BASE_URL or OPENAI_API_KEY)" });
        }
        try {
          const text = (await transcribe(buf, file.name || "voice-note.ogg", voiceVocabularyPrompt(await listRepos()))).trim();
          if (!text) {
            return jsonOk(c, { path: result.path, transcriptError: "Transcription produced no text" });
          }
          log.info(`[server] Session ${id}: transcribed ${file.name} (${text.length} chars)`);
          return jsonOk(c, { path: result.path, transcript: text });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`[server] Session ${id}: transcription failed for ${file.name}: ${message}`);
          return jsonOk(c, { path: result.path, transcriptError: `Transcription failed: ${message}` });
        }
      }
      return jsonOk(c, { path: result.path });
    },
  );

  app.post("/sessions/:id/upload-stream", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);

    // Fast reject before reading a byte (or looking up the session) when the
    // client declares an over-cap size.
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_LARGE_UPLOAD_BYTES) {
      return jsonOk(c, { error: "File too large (max 1 GB)" }, 413);
    }

    const live = await checkUploadTarget(c, id);
    if (live) return live;

    const body = c.req.raw.body;
    if (!body) return jsonOk(c, { error: "Missing request body" }, 400);
    const name = c.req.query("name") ?? "upload";

    const result = await getSessionBackend().saveUploadStream(
      id,
      name,
      Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    );
    if (!result.ok) return uploadErrorResponse(c, result, "1 GB");
    log.info(`[server] Session ${id}: stored streamed upload ${result.path}`);
    return jsonOk(c, { path: result.path });
  });

  app.post("/logs/:runId/cancel", authMiddleware, async (c) => {
    const runId = c.req.param("runId");
    if (!await getJobRun(runId)) {
      return jsonOk(c, { error: "Run not found" }, 404);
    }
    const cancelled = await cancelJobRunIfRunning(runId);
    if (!cancelled) {
      return jsonOk(c, { result: "not-running" });
    }
    cancelTaskByRunId(runId);
    if (config.WORK_BACKEND === "k8s-pod") getAgentPodLauncher().cancelByRunId(runId);
    return jsonOk(c, { result: "cancelled" });
  });

  // ── GET routes ──

  app.get("/reauth", authMiddleware, (c) => htmlOk(c, buildReauthPage(getTheme(c))));
  // Kept so the /claude-auth links in already-filed [claws-error] issues still work.
  app.get("/claude-auth", authMiddleware, (c) => c.redirect("/reauth", 302));

  app.get("/api/status", authMiddleware, async (c) => {
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const jobs = jobStateRecord(scheduler);
    const ws = await worker.workerStatus();
    const cq = { pending: ws.queued, active: ws.running };
    const runningTasks = await runningTaskViews();
    const queueEntries = await queueEntryViews();
    const latestRuns = await getLatestRunIdsByJob();
    const schedInfo = scheduler.jobScheduleInfo();
    const pausedSet = scheduler.pausedJobs();
    const manualSet = scheduler.manualOnlyJobs();
    const jobSchedules: Record<string, { intervalMs?: number; scheduledHour?: number; lastCompletedAt: string | null; nextRunIn: number | null; manualOnly: boolean }> = {};
    for (const [name] of scheduler.jobStates()) {
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
    const totalQueueItems = getQueueSnapshot(ALL_QUEUE_CATEGORIES).items.length;

    return jsonOk(c, {
      status: "ok",
      startedAt,
      uptime: Math.floor(uptimeMs / 1000),
      jobs,
      pausedJobs: [...pausedSet],
      claudeQueue: { pending: cq.pending, active: cq.active },
      runningTasks,
      queueEntries,
      jobSchedules,
      queueDepth: totalQueueItems,
      slack: slackStatus(),
      slackBot: { configured: isSlackBotConfigured() },
      whatsapp: WHATSAPP_ENABLED ? whatsappStatus() : { configured: false, connected: false, pairingRequired: false },
      email: config.EMAIL_ENABLED
        ? emailMonitor.getEmailStatus()
        : { configured: false, lastCheck: null, lastError: null },
      dmarc: {
        ...getDmarcStatus(),
        verdictCounts7d: await getDmarcVerdictCounts(new Date(Date.now() - 7 * 86400000).toISOString()),
      },
      homeAssistant: getHomeAssistantStatus(),
      github: (() => { const s = getGitHubStatusSnapshot(); return { ...s, label: githubStatusLabel(s) }; })(),
    });
  });

  // The Board is the landing page (#clw_01M39XF6QQ3EF0JX48AT81FNPK); the
  // Status page that used to live here moved to /status.
  app.get("/", authMiddleware, (c) => c.redirect("/board", 302));

  app.get("/status", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const runningTasks = await runningTaskViews();
    const queueEntries = await queueEntryViews();
    const dashQueueDepth = getQueueSnapshot(ALL_QUEUE_CATEGORIES).items.length;
    const dashSnapshots = await getQueueSnapshots(24);
    const dbLastUsed = await getLastUsedByProvider();
    function aiProviderStatus(provider: "claude" | "codex" | "opencode", configured: boolean) {
      const rl = isProviderRateLimited(provider);
      const memLastUsed = getProviderLastUsedAt(provider);
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
        rateLimitedUntil: getProviderRateLimitedUntil(provider) ?? undefined,
        lastUsedAt,
        isPrimary: false,
      };
    }
    const clawsKeyConfigured = !!config.OPENROUTER_API_KEY;
    const opencodeCliAvailable = isOpenCodeBinaryAvailable();
    const opencodeStatus = {
      ...aiProviderStatus("opencode", clawsKeyConfigured || opencodeCliAvailable),
      clawsKeyConfigured,
      opencodeCliAvailable,
    };
    const aiProviders = {
      anthropic: { ...aiProviderStatus("claude", true), authExpired: isAgentAuthExpired() },
      openai: { ...aiProviderStatus("codex", true), authExpired: isAgentAuthExpired("codex") },
      opencode: opencodeStatus,
    };

    const ws = await worker.workerStatus();
    const html = buildStatusPage(
      VERSION,
      Math.floor(uptimeMs / 1000),
      { pending: ws.queued, active: ws.running },
      slackStatus(),
      { configured: isSlackBotConfigured() },
      WHATSAPP_ENABLED ? whatsappStatus() : { configured: false, connected: false, pairingRequired: false },
      config.EMAIL_ENABLED
        ? emailMonitor.getEmailStatus()
        : { configured: false, lastCheck: null, lastError: null },
      getHomeAssistantStatus(),
      runningTasks,
      theme,
      startedAt,
      dashQueueDepth,
      dashSnapshots,
      aiProviders,
      getGitHubStatusSnapshot(),
      queueEntries,
    );
    return htmlOk(c, html);
  });

  app.get("/ha-upgrader", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const rows = await getAllHaUpgraderStates();
    const html = buildHaUpgraderPage(rows, theme);
    return htmlOk(c, html);
  });

  app.get("/damp", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const saved = c.req.query("saved") === "1";
    const html = buildDampPage(await getDampTrendRows(), await getRecentDampReadings(200), theme, saved);
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

  app.get("/blog", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const rawEntries = await listRepoDirectory(BLOG_REPO, BLOG_CONTENT_DIR);
    const entries = rawEntries.filter((e) => e.type === "file" && e.name.endsWith(".md"));
    const drafts = await listBlogDrafts(BLOG_REPO);
    let flash: { text: string; error?: boolean } | undefined;
    const pushed = c.req.query("pushed");
    const error = c.req.query("error");
    if (pushed) flash = { text: `Pushed PR #${pushed}` };
    else if (error === "badpath") flash = { text: "Invalid file path — must be a .md file under the blog content directory.", error: true };
    else if (error === "push") flash = { text: "Failed to push to PR — see server logs.", error: true };
    const html = buildBlogListPage(entries, drafts, theme, flash);
    return htmlOk(c, html);
  });

  app.get("/blog/edit", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const isNew = c.req.query("new") === "1";
    if (isNew) {
      const html = buildBlogEditPage("", "", "", true, theme);
      return htmlOk(c, html);
    }
    const path = c.req.query("path") ?? "";
    if (!path) return c.redirect("/blog", 303);
    if (!isValidBlogPath(path)) return c.redirect("/blog?error=badpath", 303);

    // Prefer the stored draft so cross-browser edits win over GitHub content.
    const draft = await getBlogDraft(BLOG_REPO, path);
    let content: string;
    let baseSha: string;
    let pr: { number: number } | undefined;
    if (draft) {
      content = draft.content;
      baseSha = draft.base_sha ?? "";
      if (draft.pr_number != null) pr = { number: draft.pr_number };
    } else {
      const file = await fetchRepoFileWithSha(BLOG_REPO, path);
      if (!file) return c.redirect("/blog", 303);
      content = file.content;
      baseSha = file.sha;
    }
    const saved = c.req.query("saved") === "1";
    const error = c.req.query("error");
    let flash: { text: string; error?: boolean } | undefined;
    if (saved) flash = { text: "Saved to Claws ✓" };
    else if (error === "push") flash = { text: "Failed to push to PR — see server logs.", error: true };
    const html = buildBlogEditPage(path, content, baseSha, false, theme, pr, flash);
    return htmlOk(c, html);
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
      const html = buildBlogEditPage(path, content, baseSha, isNew, theme, undefined, flash);
      return htmlOk(c, html);
    }

    const titleMatch = content.match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
    const title = titleMatch ? titleMatch[1] : null;

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
    const jobs = jobStateRecord(scheduler);
    const runningTasks = await runningTaskViews();
    const html = buildJobsMatrixPage(repos, config.DISABLED_JOBS_BY_REPO, saved, theme, locked, {
      jobs,
      runningTasks,
      latestRuns: await getLatestRunIdsByJob(),
      paused: scheduler.pausedJobs(),
      scheduleInfo: scheduler.jobScheduleInfo(),
    });
    return htmlOk(c, html);
  });

  app.get("/prs", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = await listRepos();
    const perRepo = await mapWithConcurrency(repos, 8, async (r) => {
      const [prs, statuses] = await Promise.all([
        listPRs(r.fullName).catch(() => []),
        listPRStatuses(r.fullName).catch((): Map<number, PRRepoStatus> => new Map()),
      ]);
      return prs.map((pr) => {
        const st = statuses.get(pr.number);
        // Copy: listPRStatuses caches its Map, so mutating the stored object
        // below would leak review status across requests.
        const status: PRRowStatus | undefined = st ? { ...st } : undefined;
        return { repo: r.fullName, pr, status };
      });
    });
    const rows = perRepo.flat();
    // Only merge candidates need a review status — getPRReviewStatus costs one
    // comments fetch per PR, and blocked PRs already render a reason.
    const candidates = rows.filter((row) =>
      row.status
      && row.status.mergeableState !== "CONFLICTING"
      && row.status.checkStatus !== "failing"
      && row.status.checkStatus !== "pending");
    // The ledger is a local pr_reviews read (no per-PR GitHub fetch), so unlike
    // getPRReviewStatus above it isn't restricted to merge candidates — a PR
    // failing CI or in conflict is exactly where an operator wants the history.
    const withStatus = rows.filter((row): row is typeof row & { status: PRRowStatus } => !!row.status);
    await Promise.all([
      mapSettledWithConcurrency(candidates, 8, async (row) => {
        const rev = await getPRReviewStatus(row.repo, row.pr.number);
        row.status!.reviewStatus = rev.status;
        row.status!.reviewIssueCount = rev.issueCount;
      }),
      attachReviewLedgers(withStatus.map((row) => ({ repo: row.repo, prNumber: row.pr.number, target: row.status }))),
    ]);
    const snapshot = getQueueSnapshot(ALL_QUEUE_CATEGORIES);
    return htmlOk(c, buildAllPRsPage(rows, snapshot.items, theme));
  });

  /**
   * The latest plan of every open native issue, for the collapsed plan block
   * on board cards and `/issues` rows. Best-effort: a failed read costs the
   * plan blocks, not the page.
   */
  async function loadLatestPlans(page: string): Promise<Map<string, ClawsIssuePlanRow>> {
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
  function planPreviewFor(ref: config.IssueRef, plans: Map<string, ClawsIssuePlanRow>): PlanPreview | undefined {
    if (!isNativeIssue(ref)) return undefined;
    const row = plans.get(String(canonicalIssueRef(ref)));
    if (!row) return undefined;
    const sections = planParser.parsePlanSections(row.body);
    if (sections.length === 0) return undefined;
    const requirement = sections.find((s) => s.title.toLowerCase() === "requirement") ?? sections[0];
    return {
      summary: `${sections.length} section${sections.length === 1 ? "" : "s"}`,
      requirementHtml: renderMarkdown(requirement.markdown),
      url: `/issues/${encodeURIComponent(row.issue_id)}#plan`,
    };
  }

  app.get("/issues", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = await listRepos();
    const plans = await loadLatestPlans("issues");
    const [perRepo, unassignedIssues] = await Promise.all([
      mapWithConcurrency(repos, 8, async (r) =>
        (await listOpenIssues(r.fullName).catch(() => [])).map((issue) => ({ repo: r.fullName, issue, plan: planPreviewFor(issue.number, plans) })),
      ),
      clawsIssues.listUnassignedOpenIssues().catch(() => []),
    ]);
    const unassigned: UnassignedIssueRow[] = unassignedIssues.map((i) => ({
      id: i.id,
      title: i.title,
      authorLogin: i.author_login,
      updatedAt: clawsIssues.toIso(i.updated_at),
      repos: i.repos,
      plan: planPreviewFor(i.id, plans),
    }));
    const snapshot = getQueueSnapshot(ALL_QUEUE_CATEGORIES);
    return htmlOk(c, buildAllIssuesPage(perRepo.flat(), snapshot.items, theme, unassigned, config.SKIPPED_ITEMS));
  });

  // ── Kanban board (docs/issue-tracker.md#board) ──
  //
  // A column is derived from the issue's labels on every render, never stored,
  // so the board and the pipeline cannot disagree. `/board/move` is the inverse
  // map: it applies the labels that put an issue in the column it was dropped
  // into, through the same façade the /issues row buttons use.

  app.get("/board", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = await listRepos();
    const plans = await loadLatestPlans("board");
    // Ideas and Planning carry no label: a forge card's stage comes off its
    // shadow, and a card in Ideas shows its latest requirements version. Both
    // best-effort — a failed read costs the chip, and puts forge cards in Ideas.
    const [shadowStages, requirements] = await Promise.all([
      clawsIssues.getOpenShadowStages().catch((err) => { log.warn(`[board] shadow stages: ${err}`); return new Map<string, { id: string; lifecycle: IssueLifecycle }>(); }),
      clawsIssues.getLatestRequirementsForOpenIssues().catch((err) => { log.warn(`[board] requirements: ${err}`); return null; }),
    ]);
    const requirementsVersion = (trackerId: string | undefined): number | null | undefined =>
      requirements === null ? undefined : (trackerId ? requirements.get(trackerId)?.version ?? null : null);
    const since = new Date(Date.now() - DONE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // One repository's API failure must not empty the whole board — but a
    // silently short board reads as an empty backlog, so the count of sources
    // that came back incomplete is rendered with it. A fetch that failed and
    // one that hit the open-issue cap are the same thing to a reader: cards
    // that should be on the board are not.
    const incomplete = new Set<string>();
    const orNone = (source: string) => (err: unknown): never[] => {
      log.warn(`[board] ${source}: ${err}`);
      incomplete.add(source);
      return [];
    };
    const perRepo = await mapWithConcurrency(repos, 8, async (r) => {
      const [open, closed] = await Promise.all([
        listOpenIssues(r.fullName).catch(orNone(r.fullName)),
        // Only native issues fill the Done column: a forge's closed issues
        // would cost an extra API round trip per repo on every page load, and
        // GitHub already shows them.
        clawsIssues.listClosedIssuesSince(r.fullName, since, DONE_COLUMN_LIMIT).catch(orNone(r.fullName)),
      ]);
      // The open read is one page, so a repository with more open issues than
      // it holds drops cards from every column but Done with nothing to show
      // for it — the same silence the failure count exists to break.
      if (openIssuesMayBeTruncated(r.fullName, open)) incomplete.add(r.fullName);
      const cards: BoardCard[] = open.map((issue) => {
        const shadow = issue.lifecycle ? undefined : shadowStages.get(`${r.fullName}\u0000${String(issue.number)}`);
        const trackerId = isNativeIssue(issue.number) ? String(canonicalIssueRef(issue.number)) : shadow?.id;
        return {
        repo: r.fullName,
        ref: issue.number,
        title: issue.title,
        labels: issue.labels.map((l) => l.name),
        lifecycle: issue.lifecycle ?? shadow?.lifecycle,
        requirementsVersion: requirementsVersion(trackerId),
        url: config.issueUrl(r.fullName, issue.number),
        plan: planPreviewFor(issue.number, plans),
        updatedAt: issue.updatedAt,
        // Native issues only; a forge card's age chip approximates from `updatedAt`.
        stageSince: issue.stageSince,
        };
      });
      // The closed cards are kept apart with the time they were closed: the
      // query's limit is per repository, so the column is bounded globally
      // below rather than at 50 × however many repositories Claws manages.
      const done = closed.map((record) => ({
        closedAt: record.closed_at ?? "",
        card: {
          repo: r.fullName,
          ref: record.id,
          title: record.title,
          labels: record.labels,
          closed: true,
          url: config.issueUrl(r.fullName, record.id),
          updatedAt: clawsIssues.toIso(record.updated_at),
          stageSince: record.closed_at ? clawsIssues.toIso(record.closed_at) : undefined,
        } satisfies BoardCard,
      }));
      return { cards, done };
    });
    const repoFilter = c.req.query("repo") ?? "";
    // Newest first across every repository, then cut to the one bound the
    // 14-day window is paired with — the same order `listClosedIssuesSince`
    // applies within a repository, so the column reads the same either way.
    //
    // `?repo=` is applied here rather than only in `buildBoardPage`, which
    // filters what it is handed: cutting the merged list first would hand a
    // filtered board whatever few of that repository's cards survived a global
    // top-50 spread across every other one — possibly none, with nothing on the
    // page to say cards were dropped. Filtering first makes the cap bound the
    // column that is actually rendered. Every other column is unfiltered here
    // because nothing cuts it.
    const done = perRepo
      .flatMap((r) => r.done)
      .filter((d) => !repoFilter || d.card.repo === repoFilter)
      .sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : 0))
      .slice(0, DONE_COLUMN_LIMIT)
      .map((d) => d.card);
    // Native issues with no repo never come through listOpenIssues, which
    // lists an issue under its primary repo; they sit in Ideas until one
    // is assigned. A multi-repo issue is a normal card under its primary repo.
    const unassigned: BoardCard[] = (await clawsIssues.listUnassignedOpenIssues().catch(orNone("unassigned issues"))).map((issue) => ({
      repo: "",
      ref: issue.id,
      title: issue.title,
      labels: issue.labels,
      lifecycle: issue.lifecycle,
      requirementsVersion: requirementsVersion(issue.id),
      url: config.issueUrl("", issue.id),
      plan: planPreviewFor(issue.id, plans),
      updatedAt: clawsIssues.toIso(issue.updated_at),
      stageSince: clawsIssues.toIso(issue.stage_changed_at ?? issue.updated_at),
    }));
    // Operator-set model-plan cells, summarised on the card. Best-effort: a
    // failed read costs the summary line, not the board. An unassigned card has
    // no repo to key on, so it matches its native id in any repo — a `clw_…`
    // id is unique fleet-wide.
    const explicitPlans = new Map<string, IssueModelPlanRow[]>();
    for (const row of await listExplicitIssueModelPlanRows().catch((err) => { log.warn(`[board] model plans: ${err}`); return []; })) {
      for (const key of [`${row.repo}\u0000${row.issue_ref}`, `\u0000${row.issue_ref}`]) {
        explicitPlans.set(key, [...(explicitPlans.get(key) ?? []), row]);
      }
    }
    const withModelPlan = (card: BoardCard): BoardCard => {
      const summary = summarizeModelPlanCells(explicitPlans.get(`${card.repo}\u0000${card.ref}`) ?? []);
      return summary ? { ...card, modelPlan: summary } : card;
    };
    // Backlog cards are off the board (#3293): split out here, from the same
    // fetch, so the header can count them without a second round trip. Open
    // cards only — Done is closed, and `columnFor` reads `closed` first.
    const onBoard: BoardCard[] = [];
    let backlogCount = 0;
    for (const card of [...perRepo.flatMap((r) => r.cards), ...unassigned]) {
      if (columnFor({ labels: card.labels, unassigned: !card.repo }) !== BACKLOG_DESTINATION) onBoard.push(card);
      else if (!repoFilter || card.repo === repoFilter) backlogCount++;
    }
    // The derived columns (Implementing, PR open, Awaiting merge) read each
    // open card's running implementer and open `claws_prs` rows. Best-effort
    // inside `loadBoardFlights`: a failed read leaves cards out of flight
    // rather than failing the page. Backlog outranks flight in `columnFor`, so
    // the split above needs none of it.
    const flights = await loadBoardFlights(onBoard);
    const withFlight = (card: BoardCard): BoardCard => {
      const flight = flights.get(flightKey(card.repo, card.ref));
      return flight ? { ...card, flight } : card;
    };
    return htmlOk(c, buildBoardPage({
      cards: [...onBoard.map(withFlight), ...done].map(withModelPlan),
      backlogCount,
      // What Claws manages, not what the cards happen to mention: the `?repo=`
      // cut above and the Done column's row cap both drop cards, and a
      // repository that lost all of its would otherwise drop out of the filter
      // that is hiding it, leaving "All repositories" the only way back to it.
      repoOptions: repos.map((r) => r.fullName),
      repoFilter,
      // The warning is about the board in front of the operator, so it counts
      // only the sources that board renders from. Under `?repo=` that is the
      // one repository: the others contribute no card either way, and counting
      // them would put the one incomplete source that matters inside a larger
      // number. The unassigned list is in the same position — its cards carry
      // `repo: ""`, so a `?repo=` filters every one of them away.
      incompleteSources: repoFilter ? (incomplete.has(repoFilter) ? 1 : 0) : incomplete.size,
    }, theme));
  });

  /**
   * Move a native issue to `target` — the one write behind a board move, a
   * backlog Promote and the issue page's Status buttons. Any move into
   * Planning with no recorded approval yet is the promotion, recording
   * `approvedBy` as the approver of the latest requirements version —
   * decided on approval state rather than on the column the issue came from,
   * so a drag through Blocked or Approved on the way to Planning still
   * records one; any move into Ideas is the demotion, which clears the
   * approval and skips a queued planner run. An *entry* move (`isEntry`, the
   * backlog Promote or a dependency release) is the one exception, whatever
   * its target: it restores the issue to a column it already earned —
   * Planning because it has a plan or approved requirements, Ideas because
   * it has neither — not because anyone is approving or demoting anything
   * now, so it is always a plain lifecycle write. Everything else is a
   * plain lifecycle write too.
   *
   * A promotion approves the *latest* requirements version, so this can rename
   * the issue even on a re-plan drag back into Planning — not only on the
   * first promotion out of Ideas — when that version's title differs from the
   * issue's; `promoteClawsIssue` keeps the title it was filed under in
   * `filed_title`. That is intentional: the latest version is the one the
   * approval is actually for.
   *
   * `promoteIssue`'s write is a compare-and-swap on `record.lifecycle`, so it
   * throws when the issue changed lifecycle since the caller read it —
   * `applyBoardMove`'s catch turns that into a 500 with `partial: true`
   * rather than answering 200 for a move that did not happen.
   */
  async function moveNativeLifecycle(
    owner: string,
    record: NonNullable<Awaited<ReturnType<typeof clawsIssues.getIssue>>>,
    target: IssueLifecycle,
    approvedBy: string | undefined,
    isEntry: boolean,
  ): Promise<void> {
    if (isEntry) {
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
   * Move one issue to a board column or the backlog, with every refusal
   * `POST /board/move` documents. Shared by that route, `POST /board/bulk-move`
   * and `POST /backlog/promote` (#3293), so a bulk move is exactly N single
   * moves. Answers the status and JSON body the single route sends as-is.
   */
  async function applyBoardMove(repo: string, ref: config.IssueRef, to: string, opts?: { entry?: boolean; approvedBy?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
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

      const native = isClawsIssueId(ref);
      // An unassigned native issue has no repository to check; everything else
      // must name one Claws manages, exactly as the queue actions do.
      if (repo ? !(await isConfiguredRepo(repo)) : !native) {
        return { status: 403, body: { error: "Repository not configured" } };
      }

      // A native issue's record says how many repositories own it — one half of
      // the state no label change touches.
      const record = native ? await clawsIssues.getIssue(ref) : undefined;
      // A well-formed native id the store has never heard of. Left to fall
      // through, the state read below throws and answers 503 — "try again" for
      // a condition no retry can fix — so name what is actually wrong.
      if (native && !record) return { status: 404, body: { error: "No such issue" } };
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
      const owner = (record && clawsIssues.primaryRepo(record.repos)) || repo;
      if (owner !== repo && !(await isConfiguredRepo(owner))) {
        return { status: 403, body: { error: "Repository not configured" } };
      }
      // The other half: whether the issue is closed *already*, and which labels
      // it is really holding. Read rather than taken from the card — nothing
      // re-renders the board, so a tab left open outlives the issue cache by
      // hours and can still show an issue in PR open long after its PR merged
      // and closed it. The labels ride along on the same read; they decide the
      // landing column below and which writes are worth making. The issue's
      // flight — its running implementer and open PR rows — is read beside
      // them, for the same reason; `loadIssueFlight` never throws.
      const flightRead = loadIssueFlight(owner, ref);
      // Ideas and Planning carry no label, so a forge issue's stage is read off
      // its shadow; a native issue's is on its record. An entry move only takes
      // the forge issue out of the backlog and leaves its stage to the shadow
      // sync, so it needs no shadow and never writes one.
      const shadowId = native ? null : await resolveTrackerId(owner, ref);
      const shadowRecord = shadowId ? await clawsIssues.getIssue(shadowId) : undefined;
      // An entry move (the backlog's Promote) asks for Ideas but lands the
      // issue wherever `entryLifecycle` says: Planning once it has a plan or
      // approved requirements, which need no second promotion. A forge issue
      // with no shadow yet has nothing to check and stays in Ideas.
      let target: BoardDestination = to;
      const entryRecord = record ?? shadowRecord;
      if (opts?.entry && to === "ideas" && entryRecord) {
        target = clawsIssues.entryLifecycle(entryRecord, (await clawsIssues.listPlans(entryRecord.id)).length > 0);
        move = transitionFor(target)!;
      }
      if (!native && move.lifecycle && !shadowId && !opts?.entry) {
        return { status: 409, body: { error: "Claws has not synced this issue yet — try again in a few minutes." } };
      }
      const lifecycle = record?.lifecycle ?? shadowRecord?.lifecycle;
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
      // The route's contract: answer `ok` only for a move that lands where it
      // was asked to. `transitionFor` cannot promise that on its own, since it
      // declares only the labels the board owns while `columnFor` also reads
      // the issue's flight, `closed` and `unassigned` — an unassigned native issue
      // takes the labels and stays in Ideas, and an issue with a running
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
      const landing = columnAfterMove(move, { labels, closed: move.close, unassigned, lifecycle, ...flight });
      // Promote/bulk-promote only mean "take it out of the backlog" — any
      // landing other than Backlog itself (e.g. an issue with an open PR) is a
      // success, reported as the column it actually landed in.
      const landed = opts?.entry && to === "ideas" ? landing !== BACKLOG_DESTINATION : landing === target;
      if (!landed) {
        // Landing in a derived column means the issue's flight outranks the
        // target, which is the fact DERIVED_COLUMN_REJECTION already states in
        // the operator's own terms — better than "that move lands in pr-open",
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
        await closeIssue(owner, ref, "completed");
      } else {
        // Dragging out of Done reopens — but only a native issue, since the
        // façade has no forge reopen; the closed forge issue was refused above.
        if (native && closedAlready) {
          wrote = true;
          await clawsIssues.reopenIssue(ref);
        }
      }
      if (!move.close && native && record && isIssueLifecycle(target)) {
        // A native issue stores its lifecycle in one field, so the move is one
        // write rather than an add-then-remove label pair — there is no
        // half-applied state for it to leave behind. Skipped when the field
        // already holds it, for the same reason a held label is skipped below.
        if (record.lifecycle !== target) {
          wrote = true;
          await moveNativeLifecycle(owner, record, target, opts?.approvedBy, !!opts?.entry);
        }
      } else if (!move.close) {
        // The target's label first: a removal that then fails leaves the
        // *outranking* old label in place, so the issue is still in the column
        // the card came from and the client's revert tells the truth. Adding
        // last would leave a half-applied move holding no lifecycle label at
        // all — Ideas or Planning, which is neither end of the drag.
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
        // Approved drag otherwise fires a `removeLabel` for all of `Blocked` and
        // `Ready` when it holds neither, and on the GitHub path each one is a
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
        // approval yet promotes it, a drop into Ideas demotes it. `move.lifecycle`
        // is only ever set for those two targets (`transitionFor`), so the
        // remaining branch — a drop into Planning that is already approved —
        // is the only plain lifecycle write reached here; moves into
        // label-carried columns (Awaiting plan review, Approved, Blocked,
        // Backlog) leave the shadow to the shadow sync instead.
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
      }
      // The column the issue is in now, so the client places the card rather
      // than assuming the drop landed.
      return { status: 200, body: { result: "ok", column: landing } };
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

  app.post("/board/move", authMiddleware, async (c) => {
    // Read and parse outside the `try`: this route's `partial: true` means a
    // *half-applied* move, which the client answers by leaving the card where
    // it was dropped and telling the operator to reload. A truncated or
    // non-JSON body wrote nothing, so it must not borrow that meaning — it is a
    // 400 like any other malformed request, and the card snaps back.
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return jsonOk(c, { error: "Malformed request body" }, 400);
    }
    const parsed = BoardMoveSchema.safeParse(raw);
    if (!parsed.success) return jsonOk(c, { error: "Missing repo, ref or column" }, 400);
    const { status, body } = await applyBoardMove(parsed.data.repo, parsed.data.ref, parsed.data.to, { approvedBy: sessionSubject(c) });
    return jsonOk(c, body, status);
  });

  // Bulk send-to-backlog from the board and bulk promote from the backlog
  // (#3293): each item is exactly one `applyBoardMove`, and the answer is 200
  // with one result per item, in order, carrying that move's own status.
  app.post("/board/bulk-move", authMiddleware, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return jsonOk(c, { error: "Malformed request body" }, 400);
    }
    const parsed = BoardBulkMoveSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonOk(c, { error: `Expected { to: "backlog" | "ideas", items: [{ repo, ref }] } with 1–${BULK_MOVE_LIMIT} items` }, 400);
    }
    const { to, items } = parsed.data;
    const results = await mapWithConcurrency(items, 4, async (item) => {
      const { status, body } = await applyBoardMove(item.repo, item.ref, to, { entry: to === "ideas", approvedBy: sessionSubject(c) });
      return { repo: item.repo, ref: item.ref, status, ...body };
    });
    return jsonOk(c, { results });
  });

  // The board's `M` toggle: a merge approval, not a lifecycle label, so unlike
  // `/board/move` it moves no card. On: each of the issue's open PR rows
  // records who approved and when (`merge_approved_by` / `merge_approved_at`,
  // from the session's identity), then the PR and the issue take the Automerge
  // label through the façade, so a forge and a native card work alike. The row
  // is written before the label so the label hook's own Automerge write — a
  // no-op once `merge_approved_at` is set — keeps the identity. Off: the labels
  // come off, then both row columns are cleared.
  app.post("/board/automerge", authMiddleware, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return jsonOk(c, { error: "Malformed request body" }, 400);
    }
    const parsed = BoardAutomergeSchema.safeParse(raw);
    if (!parsed.success) return jsonOk(c, { error: "Missing repo, ref or on" }, 400);
    const { repo, ref, on } = parsed.data;
    if (!(await isConfiguredRepo(repo))) {
      return jsonOk(c, { error: "Repository not configured" }, 403);
    }
    try {
      const { openPrs } = await loadIssueFlight(repo, ref);
      if (on) {
        const approvedBy = sessionSubject(c);
        const approvedAt = new Date().toISOString();
        await ensureLabel(repo, LABELS.automerge);
        for (const pr of openPrs) {
          // The approval record.
          await upsertClawsPr(pr.repo, pr.prNumber, { mergeApprovedBy: approvedBy, mergeApprovedAt: approvedAt });
          // The label mirror, while the façade is inert.
          if (pr.repo !== repo) await ensureLabel(pr.repo, LABELS.automerge);
          await addLabel(pr.repo, pr.prNumber, LABELS.automerge);
        }
        await addLabel(repo, ref, LABELS.automerge);
      } else {
        for (const pr of openPrs) {
          if (!(await removeLabel(pr.repo, pr.prNumber, LABELS.automerge))) {
            return jsonOk(c, { error: `Failed to remove the Automerge label from ${pr.repo}#${pr.prNumber}` }, 500);
          }
        }
        if (!(await removeLabel(repo, ref, LABELS.automerge))) {
          return jsonOk(c, { error: "Failed to remove the Automerge label" }, 500);
        }
        for (const pr of openPrs) {
          await upsertClawsPr(pr.repo, pr.prNumber, { mergeApprovedBy: null, mergeApprovedAt: null });
        }
      }
      return jsonOk(c, { result: "ok", on });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  // ── Backlog (docs/issue-tracker.md#backlog) ──
  //
  // Backlog issues are off the board; this is where they are listed, and where
  // a human promotes them back to Ideas or Planning. Nothing automated ever does.

  app.get("/backlog", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = await listRepos();
    const repoFilter = c.req.query("repo") ?? "";
    const incomplete = new Set<string>();
    const orNone = (source: string) => (err: unknown): never[] => {
      log.warn(`[backlog] ${source}: ${err}`);
      incomplete.add(source);
      return [];
    };
    const perRepo = await mapWithConcurrency(repos, 8, async (r) => {
      const open = await listOpenIssues(r.fullName).catch(orNone(r.fullName));
      if (openIssuesMayBeTruncated(r.fullName, open)) incomplete.add(r.fullName);
      return open.map((issue): BacklogRow => ({
        repo: r.fullName,
        ref: issue.number,
        title: issue.title,
        labels: issue.labels.map((l) => l.name),
        url: config.issueUrl(r.fullName, issue.number),
        updatedAt: issue.updatedAt ?? "",
      }));
    });
    // An unassigned issue reads as Ideas whatever its lifecycle (see
    // `columnFor`), so the filter below drops these; they are fetched so the
    // page agrees with the board by construction rather than by assumption.
    const unassigned = (await clawsIssues.listUnassignedOpenIssues().catch(orNone("unassigned issues"))).map((issue): BacklogRow => ({
      repo: "",
      ref: issue.id,
      title: issue.title,
      labels: issue.labels,
      url: config.issueUrl("", issue.id),
      updatedAt: clawsIssues.toIso(issue.updated_at),
    }));
    const rows = [...perRepo.flat(), ...unassigned]
      .filter((r) => columnFor({ labels: r.labels, unassigned: !r.repo }) === BACKLOG_DESTINATION);
    return htmlOk(c, buildBacklogPage({
      rows,
      repoOptions: repos.map((r) => r.fullName),
      repoFilter,
      labelFilter: c.req.query("label") ?? "",
      incompleteSources: repoFilter ? (incomplete.has(repoFilter) ? 1 : 0) : incomplete.size,
    }, theme));
  });

  // The backlog page's form: a row's own Promote button sends `only`, the
  // bulk button every ticked `item`. Works without JavaScript.
  app.post("/backlog/promote", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    const only = params["only"];
    const values = only ? [only] : parseFormBodyMulti(body, "item");
    const query = new URLSearchParams();
    if (params["repo"]) query.set("repo", params["repo"]);
    if (params["label"]) query.set("label", params["label"]);
    const qs = query.toString();
    const back = `/backlog${qs ? `?${qs}` : ""}`;
    const backAction = { actions: [{ href: back, label: "← Backlog" }] };
    if (values.length === 0) {
      return htmlError(c, 400, "Nothing to promote", "Tick at least one issue, or use a row's Promote button.", backAction);
    }
    if (values.length > BULK_MOVE_LIMIT) {
      return htmlError(c, 400, "Too many issues", `Promote at most ${BULK_MOVE_LIMIT} issues at a time.`, backAction);
    }
    // `<repo>#<ref>`, split on the last `#`: a repo name never holds one.
    const items = values.map((value) => {
      const at = value.lastIndexOf("#");
      const ref = at >= 0 ? canonicalIssueRef(value.slice(at + 1)) : null;
      return { value, repo: at >= 0 ? value.slice(0, at) : "", ref };
    });
    const results = await mapWithConcurrency(items, 4, async (item) => {
      if (item.ref === null) return { value: item.value, status: 400, error: "Not an issue reference" };
      const { status, body: res } = await applyBoardMove(item.repo, item.ref, "ideas", { entry: true, approvedBy: sessionSubject(c) });
      return { value: item.value, status, error: typeof res["error"] === "string" ? res["error"] : undefined };
    });
    const failed = results.filter((r) => r.status !== 200 || r.error);
    if (failed.length > 0) {
      const promoted = results.length - failed.length;
      return htmlError(
        c,
        409,
        "Some issues were not promoted",
        `${promoted} of ${results.length} promoted.`,
        { detail: failed.map((r) => `${r.value}: ${r.error ?? `HTTP ${r.status}`}`).join("\n"), ...backAction },
      );
    }
    return c.redirect(back, 303);
  });

  // ── Claws-native issue tracker (docs/issue-tracker.md) ──
  //
  // `/issues/new` is registered before `/issues/:id` so the literal path wins
  // over the parameter. Every mutation goes through the `github.ts` façade so a
  // native issue gets the same events and label semantics as a forge one —
  // except the comment form, which must post as the operator rather than as
  // Claws, or the refiner would read its own marker and skip the feedback.

  app.get("/issues/new", authMiddleware, async (c) => {
    const repos = await listRepos();
    return htmlOk(c, buildNewIssuePage(repos.map((r) => r.fullName), getTheme(c)));
  });

  app.post("/issues", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    const title = (params["title"] ?? "").trim();
    if (!title) {
      return htmlError(c, 400, "Cannot create issue", "A title is required.", {
        actions: [{ href: "/issues/new", label: "← New issue" }],
      });
    }
    const known = new Set((await listRepos()).map((r) => r.fullName));
    const repos = parseFormBodyMulti(body, "repo").filter((r) => known.has(r));
    const modelPlan = parseModelPlanForm(params);
    const hasModelPlan = modelPlan.some((cell) => cell.provider || cell.tier);
    if (hasModelPlan && repos.length === 0) {
      return htmlError(c, 409, "Model plan not saved", "The model plan is stored under the issue's primary repository, and this issue has none. Remove the model plan selections or pick a repo, then try again.", {
        actions: [{ href: "/issues/new", label: "← New issue" }],
      });
    }
    // State labels are not offered by the form — lifecycle is set by moving
    // the issue on the board or with its page's Status buttons — so a hand-sent
    // one is dropped rather than quietly setting the new issue's state.
    const labels = parseFormBodyMulti(body, "label").filter((l) => l in config.LABEL_SPECS && !isStateLabel(l));
    // The one state the form does offer: "File to backlog" parks an idea
    // captured for later without a trip through Ideas. `createIssue`'s
    // `splitStateLabels` turns the label into the lifecycle field. An
    // unassigned issue (zero repos) has no board column of its own to leave —
    // refused for the same reason every other path to Backlog refuses it. A
    // multi-repo issue is assigned (it resolves to a primary repo everywhere
    // else) and is fine.
    if (params["backlog"] && repos.length === 0) {
      return htmlError(c, 409, "Cannot create issue", UNASSIGNED_REJECTION, {
        actions: [{ href: "/issues/new", label: "← New issue" }],
      });
    }
    if (params["backlog"]) labels.push(config.LABELS.backlog);
    // Links are resolved before the issue is written, so a bad reference
    // fails the whole create instead of leaving a half-linked issue behind.
    const links: Array<{ kind: issueLinks.LinkKind; target: string }> = [];
    for (const kind of issueLinks.LINK_KINDS) {
      const refs = parseFormBodyMulti(body, kind).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
      for (const ref of refs) {
        try {
          links.push({ kind, target: await issueLinks.resolveLinkTarget(ref, clawsIssues.primaryRepo(repos)) });
        } catch (err) {
          if (!(err instanceof issueLinks.LinkError)) throw err;
          return htmlError(c, 400, "Cannot create issue", `${issueLinks.LINK_KIND_LABELS[kind]}: ${err.message}`, {
            actions: [{ href: "/issues/new", label: "← New issue" }],
          });
        }
      }
    }
    const id = await clawsIssues.createIssue({
      title,
      body: params["body"] ?? "",
      // Single-tenant dashboard behind OIDC: whoever is signed in is the owner.
      authorLogin: config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN,
      repos,
      labels,
      source: "dashboard",
      // The Requirements radio: "" (the default) follows the repo's
      // claws.json policy and the source default, same as no override at
      // all; "wait" holds the issue in Ideas for the operator's review;
      // "auto" promotes it once the record exists.
      autoPromote: params["autoPromote"] === "auto" ? true : params["autoPromote"] === "wait" ? false : undefined,
    });
    if (hasModelPlan) await setExplicitPlan(clawsIssues.primaryRepo(repos), id, modelPlan);
    for (const link of links) {
      await issueLinks.addLink(clawsIssues.primaryRepo(repos), id, link.kind, link.target, config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN);
    }
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
    return c.redirect(`/issues/${id}`, 303);
  });

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
  async function loadNativeIssue(c: Ctx, opts?: { forWrite?: boolean }): Promise<{ record: Awaited<ReturnType<typeof clawsIssues.getIssue>>; id: string } | null> {
    const ref = canonicalIssueRef(c.req.param("id"));
    if (!isNativeIssue(ref)) return null;
    const record = await clawsIssues.getIssue(ref);
    if (opts?.forWrite && record?.kind === "shadow") return null;
    return { record, id: ref };
  }

  function issueNotFound(c: Ctx) {
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
  function eventRepo(repos: string[]): string {
    return clawsIssues.primaryRepo(repos);
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
    const comments = await clawsIssues.listCommentDetails(record.id);
    // The plan comment is shown under Current plan, not in Comments; every
    // other comment, Claws' replies included, stays in the discussion.
    const plans = (await clawsIssues.listPlans(record.id)).map((p): PlanView & { commentId: string | null } => ({
      version: p.version,
      createdAt: p.createdAt,
      attribution: planParser.extractModelsAttribution(p.body),
      sections: planParser.parsePlanSections(p.body).map((s) => ({ title: s.title, html: renderMarkdown(s.markdown) })),
      commentId: p.commentId,
    }));
    const latestPlan = plans.at(-1) ?? null;
    // Likewise the requirements record comment, shown under Requirements.
    const requirements = (await clawsIssues.listRequirements(record.id)).map((r): RequirementsView & { commentId: string | null } => ({
      version: r.version,
      createdAt: r.createdAt,
      title: r.title,
      kind: r.kind,
      sections: [
        { title: "Context", html: renderMarkdown(r.context) },
        { title: "Requirement", html: renderMarkdown(r.requirement) },
        { title: "Acceptance criteria", html: renderMarkdown(r.acceptanceCriteria.map((item) => `- ${item}`).join("\n")) },
        { title: "Out of scope", html: r.outOfScope.length > 0 ? renderMarkdown(r.outOfScope.map((item) => `- ${item}`).join("\n")) : `<p class="queue-empty">None</p>` },
      ],
      commentId: r.commentId,
    }));
    const latestRequirements = requirements.at(-1) ?? null;
    const hiddenCommentIds = new Set([latestPlan?.commentId, latestRequirements?.commentId].filter((id): id is string => id != null));
    const view: IssuePageView = {
      id: record.id,
      title: record.title,
      body: record.body,
      bodyHtml: renderMarkdown(record.body),
      authorLogin: record.author_login,
      state: record.state,
      stateReason: record.state_reason,
      createdAt: clawsIssues.toIso(record.created_at),
      updatedAt: clawsIssues.toIso(record.updated_at),
      repos: record.repos,
      labels: record.labels,
      comments: comments
        .filter((cm) => !hiddenCommentIds.has(String(cm.id)))
        .map((cm) => ({ id: String(cm.id), login: cm.login, body: cm.body, bodyHtml: cm.body_html, createdAt: cm.createdAt })),
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
      lifecycle: record.lifecycle,
      source: record.source,
      autoPromotes: clawsIssues.shouldAutoPromote(record),
      filedTitle: record.filed_title,
      allRepos: (await listRepos()).map((r) => r.fullName),
      // Resolved against the issue's primary repo; with none there is no row
      // to read, and the page renders the grid read-only.
      modelPlan: await describeModelPlan(clawsIssues.primaryRepo(record.repos) || null, record.id, record.labels.map((name) => ({ name }))),
      attachments: (await listClawsIssueAttachments(record.id)).map((row) => ({
        id: row.id,
        name: row.filename,
        url: attachmentUrl(row),
        size: row.size,
        contentType: row.content_type,
        isImage: isInlineImage(row),
      })),
      links: await issueLinks.listLinks("", record.id),
      flight: await loadIssueFlight(clawsIssues.primaryRepo(record.repos), record.id),
    };
    return htmlOk(c, buildIssuePage(view, getTheme(c)));
  });

  /**
   * Feedback on a plan that is Awaiting plan review means the plan is no longer
   * awaiting review — send it back to the planner (Planning) immediately rather than
   * waiting for the next issue-dispatcher tick (up to 5 minutes). Shared by
   * the comment route and the attachment routes' synthesised comment, so an
   * upload has the same immediate effect as a typed comment.
   */
  async function returnToPlannerOnFeedback(
    loaded: { record: NonNullable<Awaited<ReturnType<typeof clawsIssues.getIssue>>>; id: string },
    body: string,
  ): Promise<void> {
    if (isPhaseClaimOnly(body) || loaded.record.state !== "open" || loaded.record.lifecycle !== "awaiting-plan-review") return;
    const repo = eventRepo(loaded.record.repos);
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

  app.post("/issues/:id/comments", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const params = parseFormBody(await readTextBody(c));
    const body = (params["body"] ?? "").trim();
    const commentId = await clawsIssues.commentOnIssue(
      eventRepo(loaded.record.repos),
      loaded.id,
      body,
      config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN,
    );
    if (commentId) await returnToPlannerOnFeedback({ record: loaded.record, id: loaded.id }, body);
    return c.redirect(`/issues/${loaded.id}`, 303);
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
    // and treating them as unticked would reset every issue to Ideas.
    // Claws Staging is opt-in only via the forge, so it isn't offered either —
    // must match the checkbox set rendered by offeredLabels() in pages/issue.ts.
    const offered = offeredLabels(Object.keys(config.LABEL_SPECS));
    const wanted = new Set(parseFormBodyMulti(await readTextBody(c), "label").filter((l) => offered.includes(l)));
    const repo = eventRepo(loaded.record.repos);
    for (const label of wanted) {
      if (!loaded.record.labels.includes(label)) await addLabel(repo, loaded.id, label);
    }
    for (const label of loaded.record.labels) {
      if (offered.includes(label) && !wanted.has(label)) await removeLabel(repo, loaded.id, label);
    }
    if (wantsJson) return jsonOk(c, { ok: true });
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // The issue page's Status buttons: set the issue's lifecycle state the way a
  // board move to that column would, with the same refusals. Refine &
  // Automerge rides along as one extra field: `automerge=1` alongside
  // `column=approved` applies the Automerge label after the lifecycle write.
  app.post("/issues/:id/column", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const { record } = loaded;
    const params = parseFormBody(await readTextBody(c));
    const column = params["column"] ?? "";
    const automerge = !!params["automerge"];
    const back = { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] };
    if (isDerivedColumn(column)) return htmlError(c, 409, "Cannot move issue", DERIVED_COLUMN_REJECTION, back);
    if (!isIssueLifecycle(column)) return htmlError(c, 400, "Cannot move issue", `Unknown column: ${column}`, back);
    if (record.repos.length === 0) return htmlError(c, 409, "Cannot move issue", UNASSIGNED_REJECTION, back);
    if (record.state === "closed") {
      return htmlError(c, 409, "Cannot move issue", "Reopen this issue before changing its status.", back);
    }
    const flight = await loadIssueFlight(eventRepo(record.repos), loaded.id);
    if (column === BACKLOG_DESTINATION) {
      const refusal = backlogRefusal(flight);
      if (refusal) return htmlError(c, 409, "Cannot move issue", refusal, back);
    }
    const landing = columnAfterMove(transitionFor(column)!, { labels: record.labels, closed: false, unassigned: false, lifecycle: record.lifecycle, ...flight });
    if (landing !== column) {
      const reason = isDerivedColumn(landing) ? DERIVED_COLUMN_REJECTION : `That move lands in ${landing}, not ${column}.`;
      return htmlError(c, 409, "Cannot move issue", reason, back);
    }
    if (record.lifecycle !== column) {
      try {
        await moveNativeLifecycle(eventRepo(record.repos), record, column, sessionSubject(c), false);
      } catch {
        return htmlError(c, 409, "Cannot move issue", "The issue changed since this page loaded — reload and try again.", back);
      }
    }
    if (automerge && column === "approved" && !record.labels.includes(LABELS.automerge)) {
      await addLabel(eventRepo(record.repos), loaded.id, LABELS.automerge);
    }
    return c.redirect(`/issues/${loaded.id}`, 303);
  });

  // The Requirements block's Promote button (docs/refinements/issue-flow.md
  // "Promotion"): approve the latest requirements version as the signed-in
  // operator and move the issue from Ideas to Planning — the same write as a
  // drop into Planning on the board.
  app.post("/issues/:id/promote", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const { record } = loaded;
    const back = { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] };
    if (record.state === "closed") return htmlError(c, 409, "Cannot promote issue", "Reopen this issue before promoting it.", back);
    if (record.repos.length === 0) return htmlError(c, 409, "Cannot promote issue", UNASSIGNED_REJECTION, back);
    if (record.lifecycle !== "ideas") return htmlError(c, 409, "Cannot promote issue", "Only an issue in Ideas can be promoted.", back);
    const promoted = await clawsIssues.promoteIssue(loaded.id, sessionSubject(c), "ideas");
    if (!promoted) return htmlError(c, 409, "Cannot promote issue", "The issue changed since this page loaded — reload and try again.", back);
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
    const repo = eventRepo(loaded.record.repos);
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

  app.post("/issues/:id/state", authMiddleware, async (c) => {
    const loaded = await loadNativeIssue(c, { forWrite: true });
    if (!loaded?.record) return issueNotFound(c);
    const state = parseFormBody(await readTextBody(c))["state"] ?? "";
    const repo = eventRepo(loaded.record.repos);
    if (state === "open") {
      // The façade has no reopen — GitHub and Forgejo never needed one here.
      await clawsIssues.reopenIssue(loaded.id);
    } else if (state === "closed") {
      await closeIssue(repo, loaded.id, "completed");
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
    await setExplicitPlan(clawsIssues.primaryRepo(repos), loaded.id, cells);
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

  /**
   * Uploading a file from the Attachments-section form counts as plan
   * feedback, same as a typed comment (issue clw_01M39J5AT1SKCFV6CHMWPVHD6M):
   * post an "Attached …" comment on the uploader's behalf, one line per
   * stored file, so `commentOnIssue` stamps `comment_id` on each row and
   * `returnToPlannerOnFeedback` sends an Awaiting-review issue back to the
   * planner. Carries no "Automated by Claws" marker, so the refiner treats it
   * as human feedback.
   */
  async function postAttachmentFeedbackComment(
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
    const commentId = await clawsIssues.commentOnIssue(eventRepo(loaded.record.repos), loaded.id, body, uploader);
    if (commentId) log.info(`[server] Issue ${loaded.id}: posted attachment feedback comment ${commentId}`);
    await returnToPlannerOnFeedback(loaded, body);
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
    let size: number;
    try {
      size = fs.statSync(found.absolutePath).size;
    } catch {
      return notFound();
    }
    c.header("Content-Type", serveContentType(found.row));
    c.header("Content-Length", String(size));
    c.header("Content-Disposition", contentDisposition(found.row));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("Cache-Control", "private, max-age=3600");
    const stream = Readable.toWeb(fs.createReadStream(found.absolutePath)) as unknown as ReadableStream<Uint8Array>;
    return c.body(stream, 200);
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
      await issueLinks.addLink(eventRepo(loaded.record.repos), loaded.id, kind, params["issue"] ?? "", config.ALLOWED_ACTORS[0] ?? clawsIssues.CLAWS_NATIVE_LOGIN);
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
      await issueLinks.removeLink(eventRepo(loaded.record.repos), loaded.id, c.req.param("linkId") ?? "");
    } catch (err) {
      if (err instanceof issueLinks.LinkError) {
        return htmlError(c, err.status, "Cannot remove link", err.message, { actions: [{ href: `/issues/${loaded.id}`, label: "← Back to issue" }] });
      }
      throw err;
    }
    return c.redirect(`/issues/${loaded.id}#links`, 303);
  });

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

    const snapshot = getQueueSnapshot(ALL_QUEUE_CATEGORIES);
    const repoQueueItems = snapshot.items.filter((item) => item.repo === fullName);

    const [recentTasks, dailyStats, prs, alerts, openIssues] = await Promise.all([
      getRecentTasksForRepo(fullName, 20),
      getDailyTaskStats(fullName, 30),
      listPRs(fullName).catch(() => []),
      listIssuesByLabel(fullName, "claws-error").catch(() => []),
      listOpenIssues(fullName).catch(() => []),
      enrichQueueItemsWithPRStatus(repoQueueItems),
    ]);

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
      alertIssues: alerts,
      openIssues,
    }, theme);
    return htmlOk(c, html);
  });

  app.get("/whatsapp", authMiddleware, (c) => {
    const theme = getTheme(c);
    return htmlOk(c, buildWhatsAppPage(theme));
  });

  app.get("/whatsapp/pair", authMiddleware, (c) => {
    if (isPairing()) {
      cancelPairing();
    }
    return streamSSE(c, async (stream) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => { resolveDone = r; });
      const listener = (event: import("./whatsapp.js").PairingEvent) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
        if (event.type === "connected") {
          if (config.NOTIFY_DASHBOARD_ACTIONS) {
            notify(`[dashboard] WhatsApp paired`);
          }
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

  app.get("/sessions", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = await listRepos().catch(() => []);
    const activityMap = await getLastTaskTimePerRepo();
    repos.sort((a, b) => {
      const ta = activityMap.get(a.fullName);
      const tb = activityMap.get(b.fullName);
      if (!ta && !tb) return a.fullName.localeCompare(b.fullName);
      if (!ta) return 1;
      if (!tb) return -1;
      return tb.localeCompare(ta);
    });
    const defaultRepo = repos[0]?.fullName ?? null;
    const live = await getSessionBackend().listLive();
    const liveIds = new Set(live.map((s) => s.id));
    const ended = (await listEndedSessions()).filter((s) => !liveIds.has(s.id));
    // A DB hiccup must not 500 the sessions page — fall back to no recents.
    let recentModels = { claude: [] as string[], codex: [] as string[], opencode: [] as string[] };
    try {
      recentModels = {
        claude: await getRecentSessionModels("claude"),
        codex: await getRecentSessionModels("codex"),
        opencode: await getRecentSessionModels("opencode"),
      };
    } catch { /* ignore */ }
    // Likewise fall back to the static per-repo map (no remembered defaults).
    let rememberedCapabilityDefaults = new Map<string, string[]>();
    try {
      rememberedCapabilityDefaults = await getAllSessionCapabilityDefaults();
    } catch { /* ignore */ }
    const html = buildSessionsListPage(theme, [...live, ...ended], repos, defaultRepo, recentModels, {
      defaultProvider: defaultSessionProvider(),
      defaultMultiProvider: defaultMultiSessionProvider(),
      rememberedCapabilityDefaults,
    });
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
      if (ended) return htmlOk(c, buildEndedSessionPage(theme, ended));
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
    const html = buildSessionTerminalPage(theme, {
      id: session.id,
      repo: session.repo,
      cwd: session.cwd,
      alive: session.alive,
      provider: session.provider,
      summary: session.summary,
      capabilityOptions: session.alive
        ? classifyLiveGrants(session.capabilities, backend.kind).map(({ cap, state, reason }) => ({ id: cap.id, label: cap.label, group: capabilityGroup(cap), state, reason }))
        : [],
    });
    return htmlOk(c, html);
  });

  app.get("/config", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const saved = c.req.query("saved") === "1";
    return htmlOk(c, buildConfigPage(saved, theme, await loadLatestReport()));
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
    const html = buildIssueLogsPage(repoParam, num, runs, logsByRun, workItems, theme);
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
    const html = buildLogDetailPage(run, logs, theme, tasks);
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
    const filters = { repo: pick("repo"), job: pick("job"), provider: pick("provider"), model: pick("model") };
    const stats = await getUsageStats(days, filters);
    const totals = await getTotalUsage(days, filters);
    const options = await getUsageFilterOptions(days);
    const recentEvents = await getRecentEffectivenessEvents(days, filters);
    const html = buildUsagePage({ stats, totals, days, filters, options, recentEvents }, theme);
    return htmlOk(c, html);
  });
}
