/** Module-level state and helpers the dashboard routes share: request schemas, Home Assistant status, PR row statuses, cache warm-up, queue views, Forgejo webhook helpers and the repo avatar cache. */
import { z } from "zod";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AGENT_KINDS } from "../worker.js";
import type { ControllerClient, ProviderStatuses } from "../controller-client.js";
import { workLaneOf } from "../work-order.js";
import type { Repo } from "../config.js";
import * as config from "../config.js";
import { listRepos, listPRs, listPRStatuses, getPRReviewStatus, getMergeBlockReason, type PRRepoStatus, type StaleReadOptions, listOpenIssues, getPRState, fetchRepoFileBytes, isNativeIssue, hasPriorityLabel, type ReviewLedgerEntry, type Issue, type PR } from "../github.js";
import { commentOnIssue as ghCommentOnIssue } from "../github.js";
import { loadManualActionWarnings, manualWarningRow } from "../planned-prs.js";
import { isMergeApproved } from "../pr-state.js";
import type { InfraApprovalNeed } from "../tofu-plan.js";
import { forgejoSelfLogin, forgejoReadSelfLogin } from "../forgejo.js";
import { getRunningTasks, listQueuedWork, getSessionAgentDefaults, listPRReviews, getClawsPr, upsertClawsPr, type ClawsPrRecord } from "../db.js";
import * as log from "../log.js";
import { infraApprovalCovers } from "../agents/auto-merger.js";
import { setGrafanaAuthOk } from "../metrics.js";
import { GRAFANA_CLUSTERS, grafanaProbeFailureMessage, grafanaProbeLogContext, probeGrafanaAuth } from "../grafana-jwt.js";
import type { QueueEntryView } from "../pages/dashboard.js";
import type { PRRowStatus } from "../pages/pr-status.js";
import type { BoardCardPr } from "../pages/board.js";
import * as clawsIssues from "../claws-issues.js";
import { loadOperatorAttentionCounts } from "../operator-attention.js";
import { canonicalIssueRef, sameIssueRef, shortIssueRef } from "../issue-id.js";
import { SESSION_PROVIDERS, type SessionProvider } from "../sessions.js";
import { mapWithConcurrency, mapSettledWithConcurrency } from "../util.js";
import type { Env } from "./http.js";
import { sessionSubject } from "./auth.js";

export const startedAt = new Date().toISOString();

let homeAssistantStatus: { lastCheck: string | null; lastError: string | null } = { lastCheck: null, lastError: null };

/** Names `claws_create_repo` accepts: lowercase, digits and '-', 2-64 characters. */
export const REPO_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Leave the audit trail on an issue a `claws_create_issue` call was
 * deduplicated onto: one automated comment naming where else the work is
 * needed. Posted through the façade, so it carries the "Automated by Claws"
 * marker and the refiner does not read it as feedback; skipped when an
 * identical comment is already there, so a retrying agent adds nothing.
 */
export async function postDedupeAuditComment(
  kept: { id: string; repos: string[]; primary_repo?: string | null },
  call: { title: string; repos: string[]; origin: string; dedupeKey?: string },
): Promise<void> {
  const key = call.dedupeKey ? `, dedupe key \`${call.dedupeKey}\`` : "";
  const body = `Also needed by ${call.origin} for ${call.repos.join(", ")}: a claws_create_issue call proposed "${call.title}"${key} and was deduplicated onto this issue.`;
  try {
    const existing = await clawsIssues.listCommentDetails(kept.id);
    if (existing.some((c) => c.body.includes(body))) return;
    await ghCommentOnIssue(clawsIssues.primaryRepo(kept), kept.id, body);
  } catch (err) {
    log.warn(`claws_create_issue: dedupe audit comment on ${kept.id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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

/**
 * Live status for `repo`'s open `prs`, keyed by PR number — the one source
 * the All PRs page and the repository page both render from, so they agree
 * about a PR. Reads the 60s-cached `listPRStatuses` bulk fetch (a failure
 * yields an empty map), adds a Claws review status for merge candidates and
 * the review ledger for every PR with a status. Page handlers pass
 * `staleOk` (src/ttl-cache.ts) so a reload does not wait on the forge.
 */
export async function loadPRRowStatuses(repo: string, prs: PR[], opts?: StaleReadOptions): Promise<Map<number, PRRowStatus>> {
  const statuses = await listPRStatuses(repo, opts).catch((): Map<number, PRRepoStatus> => new Map());
  const rows: Array<{ prNumber: number; status: PRRowStatus }> = [];
  for (const pr of prs) {
    const st = statuses.get(pr.number);
    // Copy: listPRStatuses caches its Map, so mutating the stored object
    // below would leak review status across requests.
    if (st) rows.push({ prNumber: pr.number, status: { ...st } });
  }
  // Only merge candidates need a review status — getPRReviewStatus costs one
  // comments fetch per PR, and blocked PRs already render a reason.
  const candidates = rows.filter((row) =>
    row.status.mergeableState !== "CONFLICTING"
    && row.status.checkStatus !== "failing"
    && row.status.checkStatus !== "pending"
    && row.status.checkStatus !== "held");
  // The ledger is a local pr_reviews read (no per-PR GitHub fetch), so unlike
  // getPRReviewStatus above it isn't restricted to merge candidates — a PR
  // failing CI or in conflict is exactly where an operator wants the history.
  await Promise.all([
    mapSettledWithConcurrency(candidates, 8, async (row) => {
      const rev = await getPRReviewStatus(repo, row.prNumber, opts);
      row.status.reviewStatus = rev.status;
      row.status.reviewIssueCount = rev.issueCount;
    }),
    attachReviewLedgers(rows.map((row) => ({ repo, prNumber: row.prNumber, target: row.status }))),
  ]);
  return new Map(rows.map((row) => [row.prNumber, row.status]));
}

function isHomeAssistantConfigured(): boolean {
  return !!(config.HOME_ASSISTANT_BASE_URL && config.HOME_ASSISTANT_TOKEN);
}

export async function pingHomeAssistant(): Promise<void> {
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

/** Probe each `GRAFANA_CLUSTERS` Grafana (fleet only; prod is read through it)
 *  with the header `grafanaAuthorization` sends and export the result as `claws_grafana_auth_ok`;
 *  fleet Grafana alerts on it (docs/metrics.md). */
export async function probeGrafanaClusters(): Promise<void> {
  await Promise.all(GRAFANA_CLUSTERS.map(async (cluster) => {
    const result = await probeGrafanaAuth(cluster);
    setGrafanaAuthOk(cluster, result.ok);
    if (!result.ok) log.warn(`[grafana-auth] ${grafanaProbeFailureMessage(cluster, result)}`, undefined, grafanaProbeLogContext(cluster, result));
  }));
}

export function getHomeAssistantStatus() {
  return { configured: isHomeAssistantConfigured(), lastCheck: homeAssistantStatus.lastCheck, lastError: homeAssistantStatus.lastError };
}

/**
 * The configured repo matching `repo` ("owner/name"), or `undefined` if it
 * isn't one of Claws' configured repos.
 */
export async function findConfiguredRepo(repo: string): Promise<Repo | undefined> {
  const repos = await listRepos();
  return repos.find((r) => r.fullName === repo);
}

/**
 * True when `repo` ("owner/name") is one of Claws' configured repos.
 * Dashboard routes that mutate forge state must gate on this: the Forgejo bot
 * token can reach repos outside Claws' managed set.
 */
export async function isConfiguredRepo(repo: string): Promise<boolean> {
  return (await findConfiguredRepo(repo)) !== undefined;
}

/**
 * True when a native issue names repositories but none of them is configured
 * in Claws any more (a removed or archived repo). Such an issue can still be
 * closed and relabelled, but no lifecycle move or automation applies to it.
 */
export async function orphanedRepos(repos: readonly string[]): Promise<boolean> {
  if (repos.length === 0) return false;
  const configured = new Set((await listRepos()).map((r) => r.fullName.toLowerCase()));
  return !repos.some((r) => configured.has(r.toLowerCase()));
}

/** The refusal for a lifecycle move on an issue whose repositories are all unconfigured. */
export function orphanedRejection(repos: readonly string[]): string {
  return `None of this issue's repositories (${repos.join(", ")}) is configured in Claws any more — close the issue, or assign a configured repository first.`;
}

/** A forge issue/PR number, or a Claws-native `clw_…` id, canonicalised. */
const IssueRefSchema = z.union([z.number().int().positive(), z.string().min(1)])
  .transform((v) => canonicalIssueRef(v))
  .refine((v): v is config.IssueRef => v !== null, "not an issue reference");
export const RepoNumberSchema = z.object({ repo: z.string().min(1), number: IssueRefSchema });
/** The PR-only variant: the circuit breaker is keyed by PR, never by issue. */
export const RepoPrNumberSchema = z.object({ repo: z.string().min(1), number: z.number().int().positive() });
/** `claws_rerun_failed_ci`: `run` is GitHub's run id or Forgejo's `/actions/runs/<n>` number. */
export const SessionRerunSchema = RepoPrNumberSchema.extend({ run: z.number().int().nonnegative().optional() });
/** `claws_cancel_runs`: explicit `runs`, or a filter; the module checks which. */
export const SessionCancelRunsSchema = z.object({
  repo: z.string().min(1),
  runs: z.array(z.number().int().positive()).optional(),
  pr_numbers: z.array(z.number().int().positive()).min(1).max(50).optional(),
  workflow: z.string().min(1).optional(),
  event: z.string().min(1).optional(),
  include_running: z.boolean().optional(),
  dry_run: z.boolean().optional(),
});
/** `claws_set_workflow_enabled`. */
export const SessionWorkflowToggleSchema = z.object({ repo: z.string().min(1), workflow: z.string().min(1), enabled: z.boolean() });
/** Bound on the repo page's CI queue reads: past it the section reads "CI queue unavailable". */
export const CI_QUEUE_READ_TIMEOUT_MS = 8_000;
/** The dashboard's `/queue/cancel-run`. */
export const DashboardCancelRunSchema = z.object({ repo: z.string().min(1), run: z.number().int().positive() });
/** The dashboard's `/queue/workflow-enabled`. */
export const DashboardWorkflowToggleSchema = SessionWorkflowToggleSchema;
export const SessionApproveMergeSchema = RepoPrNumberSchema.extend({ queue: z.boolean().optional() });
export const SessionPrCommentSchema = RepoPrNumberSchema.extend({ body: z.string() });
/** The longest operator feedback a session may post through `claws_comment_on_pr`. */
export const SESSION_PR_COMMENT_MAX_CHARS = 20_000;
/** The publish and issue-attachment routes' answer to a pod's `outside-home` refusal. */
export const OUTSIDE_SESSION_AREAS_ERROR =
  "The file must be inside this session's home directory or its Claude scratchpad (/tmp/claude-<uid>/…); if it is in the scratchpad and this still fails, end and revive the session";
export const MarkAutomergeSchema = RepoNumberSchema.extend({ alsoRefine: z.boolean().optional(), confirmManual: z.boolean().optional() });
/** The Agent Queue's Prioritise/Deprioritise toggle on `/status` — labels the item and flips its queue rows' Priority flag. */
export const PriorityLabelSchema = RepoNumberSchema.extend({ add: z.boolean() });
/**
 * A board drag: `repo` is empty for an unassigned native issue, which has none.
 * `until` (`YYYY-MM-DD`, or null to clear) parks a native issue moved to the
 * Backlog until that day (docs/issue-tracker.md#backlog).
 */
export const BoardMoveSchema = z.object({ repo: z.string(), ref: IssueRefSchema, to: z.string().min(1), until: z.string().nullable().optional(), reason: z.string().optional() });
/** The board's `M` toggle: unlike a move, always has a repository — see `automergeToggle` in `pages/board.ts`. */
export const BoardAutomergeSchema = z.object({ repo: z.string().min(1), ref: IssueRefSchema, on: z.boolean() });
export const ApproveThroughSchema = z.object({ repo: z.string().min(1), ref: IssueRefSchema, gate: z.enum(["requirements", "plan", "merge"]), withdraw: z.boolean().optional() });
/** A board card's Mark step done button: the issue and the awaiting operator step. */
export const OperatorStepDoneSchema = z.object({ repo: z.string().min(1), ref: IssueRefSchema, position: z.number().int().min(1) });
/** The board's Start session button. `repo` is empty for an unassigned native card; the issue's own repos are what the session gets. */
export const BoardStartSessionSchema = z.object({ repo: z.string(), ref: IssueRefSchema });
/** A held board card's Start anyway button: the card's issue. */
export const BoardOverlapStartSchema = z.object({ repo: z.string(), ref: IssueRefSchema });
/**
 * A board card's infra approval button: the card's issue, the
 * infrastructure PR it approves, and the head whose plan summary the operator saw.
 */
// `repo`/`ref` name the issue card the button sits on; a board PR card (an
// unlinked PR that needs the operator) sends neither.
export const BoardMergeApproveSchema = z.object({ repo: z.string().min(1).optional(), ref: IssueRefSchema.optional(), prRepo: z.string().min(1), prNumber: z.number().int().positive(), confirmManual: z.boolean().optional() });
/** What each infra approval need asks the operator to approve, for a 409 refusal. */
export const INFRA_NEED_WORDS: Record<InfraApprovalNeed, string> = {
  unverified: "its plan cannot be verified",
  destructive: "its plan destroys or replaces resources",
  workflow: "it edits a tofu workflow",
};
export const BoardInfraApproveSchema = z.object({ repo: z.string().min(1).optional(), ref: IssueRefSchema.optional(), prRepo: z.string().min(1), prNumber: z.number().int().positive(), headSha: z.string().min(7), need: z.enum(["unverified", "destructive", "workflow"]) });
/** The most items one bulk board move takes — a sweep, not a migration. */
export const BULK_MOVE_LIMIT = 200;
export const BoardBulkMoveSchema = z.object({
  // `ideas` is the backlog's Promote: the issue re-enters the board wherever
  // `clawsIssues.entryLifecycle` puts it — Planning, or Drafting or
  // Requirements review. Mapped to `requirements-review` before the move.
  to: z.enum(["backlog", "ideas"]),
  items: z.array(z.object({ repo: z.string(), ref: IssueRefSchema })).min(1).max(BULK_MOVE_LIMIT),
});
export const RepoItemSchema = z.object({ repo: z.string().min(1), prNumber: z.number().int().positive(), confirmInfra: z.boolean().optional(), confirmManual: z.boolean().optional() });
/** Session merge refusal codes whose refusal tells the operator to merge in the Forgejo UI. */
export const FORGEJO_MERGE_HINT_CODES = new Set(["checks-failed", "checks-pending", "checks-missing", "checks-held", "review-not-clean", "review-stale"]);
/** A session pod's exit report (#3311); `scrollback` is the pod's tail, at most 50,000 characters. */
export const SessionExitReportSchema = z.object({ code: z.number().int(), scrollback: z.string(), reason: z.string().max(40).optional() });
export const SESSION_EXIT_REPORT_MAX_BYTES = 256 * 1024;
/** Largest agent-pod ops request body (a batch of job log lines is the biggest). */
export const AGENT_POD_OPS_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Record a dashboard merge approval on the `claws_prs` row for `repo#number`.
 * Only a PR can have one — a native issue id is left alone, and so is a
 * numeric ref that turns out not to be an open PR (`mark-automerge` also
 * takes issue numbers). When the number is an open PR with no row yet (the
 * dispatcher hasn't reached it, or it's disabled for this repo), seeds one
 * the same way `refreshPrStore` does before writing the approval, so a
 * dashboard click can never be silently dropped. Answers whether it wrote a
 * PR row — the row is a PR's only approval record, so no label follows. Called
 * before the merge itself; a caller must let a thrown error surface as a
 * failed response rather than reporting "ok" with the approval lost.
 */
export async function recordMergeApproval(c: Context<Env>, repo: string, number: config.IssueRef): Promise<boolean> {
  if (typeof number !== "number") return false;
  return (await writeMergeApproval(repo, number, sessionSubject(c))) !== null;
}

/**
 * Write a merge approval by `approvedBy` on the `claws_prs` row for
 * `repo#number`, seeding the row first when the PR is open and has none (see
 * `recordMergeApproval`). With `keepExisting`, an already-approved row is left
 * as it is, so its approver is kept. Answers the `mergeApprovedAt` it wrote,
 * or null when it wrote nothing.
 */
export async function writeMergeApproval(
  repo: string,
  number: number,
  approvedBy: string,
  opts: { keepExisting?: boolean } = {},
): Promise<string | null> {
  const approval = { mergeApprovedBy: approvedBy, mergeApprovedAt: new Date().toISOString() };
  const row = await getClawsPr(repo, number);
  if (row) {
    if (opts.keepExisting && isMergeApproved(row)) return null;
    await upsertClawsPr(repo, number, approval);
    return approval.mergeApprovedAt;
  }
  if ((await getPRState(repo, number)) !== "OPEN") return null;
  const status = (await listPRStatuses(repo)).get(number);
  const stage = status?.checkStatus === "failing" ? "ci-failing" : "opened";
  await upsertClawsPr(repo, number, { stage, ...approval });
  return approval.mergeApprovedAt;
}

/**
 * An open PR row as a board card reads it: the row overlaid with the live
 * `listPRStatuses` entry (checks, conflicts, the infra paths and Tofu plan
 * evidence for its head, and whether a recorded infra approval covers the
 * need that evidence shows) and the auto-merger's last refusal, if any.
 */
export function boardCardPr(row: ClawsPrRecord, live: PRRepoStatus | undefined, activeWork?: ReadonlyMap<string, string>): BoardCardPr {
  const blockReason = getMergeBlockReason(row.repo, row.prNumber);
  const work = activeWork?.get(`${row.repo}#${row.prNumber}`);
  return {
    ...row,
    ...(work ? { activeWork: work } : {}),
    liveCheckStatus: live?.checkStatus,
    mergeableState: live?.mergeableState ?? row.mergeableState,
    mergeBlocked: !!blockReason,
    mergeBlockReason: blockReason ?? null,
    ...(live?.infraPaths ? { infraPaths: live.infraPaths } : {}),
    ...(live?.tofuPlan ? { tofuPlan: live.tofuPlan } : {}),
    ...(live?.tofuPlanState ? { tofuPlanState: live.tofuPlanState } : {}),
    ...(live?.tofuPlanDetail ? { tofuPlanDetail: live.tofuPlanDetail } : {}),
    ...(live?.tofuPlanHeadSha ? { tofuPlanHeadSha: live.tofuPlanHeadSha } : {}),
    ...(live && live.infraApprovalNeed !== undefined ? { infraApprovalNeed: live.infraApprovalNeed } : {}),
    ...(live?.infraApprovalNeed && live.tofuPlanState
      ? { infraApprovalCovered: infraApprovalCovers(live.infraApprovalNeed, row.infraMergeApprovedEvidence, { state: live.tofuPlanState, resources: live.tofuPlanResources }) }
      : {}),
  };
}

/**
 * The unmet-manual-action warning `/prs` shows for a PR, or undefined — the
 * gate `/queue/merge` and `/queue/mark-automerge` hold behind `confirmManual`.
 * An issue ref or a PR Claws does not track has none.
 */
export async function manualWarningFor(repo: string, number: config.IssueRef): Promise<string | undefined> {
  if (typeof number !== "number") return undefined;
  const row = await getClawsPr(repo, number);
  if (!row) return undefined;
  return (await loadManualActionWarnings([manualWarningRow(row)])).get(`${repo}#${number}`);
}

/**
 * The approver recorded for a gate an interactive session passes through the
 * claws-state tools — distinct from an OIDC `sub` and from `"dashboard"`, so the
 * record tells a session's approval apart from an operator's click.
 */
export function sessionApprover(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * Why `/api/issues/:id/comments` refuses a step claim: a note posted there and
 * a headless agent's comment are both Claws-marked, so `parsePhaseClaims`
 * would never count the claim.
 */
export const STEP_CLAIM_REFUSAL = "A claws-phase-done claim posted here never counts: it would be Claws-marked. An interactive session marks an operator step done with claws_mark_phase_done; the operator presses Mark step N done on the board or the issue page. A headless agent cannot claim a step — name the steps you found already done in your PR body instead.";

/** The issue page's one-line notice after its Mark step done form redirects back, from the `step-done` / `step-already` query. */
export function stepNoticeFromQuery(done: string | undefined, already: string | undefined): { position: number; already: boolean } | undefined {
  for (const [raw, isAlready] of [[done, false], [already, true]] as const) {
    const position = Number(raw);
    if (raw && Number.isInteger(position) && position >= 1) return { position, already: isAlready };
  }
  return undefined;
}

/** A shared gate write's answer: done, or the status and message a route turns into its own response. */
/** Status values the issue page's comment box accepts with an empty comment. */
export const COMMENT_FREE_STATUSES = new Set(["approved", "approved-automerge", "backlog", "unblock"]);

export type GateWriteResult = { ok: true } | { ok: false; status: ContentfulStatusCode; error: string };

export type NativeIssueRecord = NonNullable<Awaited<ReturnType<typeof clawsIssues.getIssue>>>;

/** Live sessions one session may have started with `claws_start_session` at once. */
export const MAX_LIVE_STARTED_SESSIONS = 5;

/** The New session agent: the remembered one unless it is rate-limited, else the first that is not. */
export function defaultSessionProvider(remembered: string | null | undefined, providers: ProviderStatuses): SessionProvider {
  const limited = (p: SessionProvider) => providers[p].rateLimited;
  if (remembered && SESSION_PROVIDERS.includes(remembered as SessionProvider) && !limited(remembered as SessionProvider)) {
    return remembered as SessionProvider;
  }
  if (!limited("claude")) return "claude";
  if (!limited("codex")) return "codex";
  if (!limited("opencode")) return "opencode";
  return "claude";
}

export function defaultMultiSessionProvider(remembered: string | null | undefined, providers: ProviderStatuses): Extract<SessionProvider, "claude" | "codex"> {
  const limited = (p: "claude" | "codex") => providers[p].rateLimited;
  if ((remembered === "claude" || remembered === "codex") && !limited(remembered)) return remembered;
  if (!limited("claude")) return "claude";
  if (!limited("codex")) return "codex";
  return "claude";
}

/** The operator's remembered agent; empty on a DB failure
 *  so the page and `claws_start_session` fall back to the fixed defaults. */
export async function loadSessionAgentDefaults(): Promise<{ lastProvider: string | null }> {
  try {
    return await getSessionAgentDefaults();
  } catch (err) {
    log.warn(`[sessions] Could not load remembered agent defaults: ${err instanceof Error ? err.message : String(err)}`);
    return { lastProvider: null };
  }
}

const REPO_AVATAR_MAX_BYTES = 1024 * 1024;
const REPO_AVATAR_CACHE_TTL_MS = 30 * 60 * 1000;
export const REPO_AVATAR_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** Keyed by `repo + path`; a null entry is a cached miss, so a page of rows costs one forge call per repo. */
const repoAvatarCache = new Map<string, { bytes: Buffer | null; fetchedAt: number }>();

export async function loadRepoAvatar(repo: string, avatarPath: string): Promise<Buffer | null> {
  const key = `${repo.toLowerCase()}\n${avatarPath}`;
  const cached = repoAvatarCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < REPO_AVATAR_CACHE_TTL_MS) return cached.bytes;
  let bytes: Buffer | null = null;
  try {
    bytes = await fetchRepoFileBytes(repo, avatarPath);
  } catch (err) {
    log.warn(`repo-avatar: could not fetch ${avatarPath} from ${repo} — ${err}`);
  }
  if (bytes && bytes.length > REPO_AVATAR_MAX_BYTES) bytes = null;
  repoAvatarCache.set(key, { bytes, fetchedAt: Date.now() });
  return bytes;
}

/**
 * Fill the forge list caches the dashboard pages and nav counts read, so the
 * first reloads after a rollout render from cache instead of waiting on the
 * forge. Run by whichever process serves the dashboard: `main-controller.ts`
 * under `CLAWS_ROLE=all`, `main-web.ts` on each web pod. Best effort: a
 * failed read just leaves that entry cold.
 */
export async function warmDashboardCaches(): Promise<void> {
  try {
    const repos = await listRepos();
    await mapWithConcurrency(repos, 4, async (r) => {
      await Promise.allSettled([
        listOpenIssues(r.fullName),
        listPRs(r.fullName),
        listPRStatuses(r.fullName),
      ]);
    });
    await loadOperatorAttentionCounts();
  } catch (err) {
    log.warn(`[warm-caches] Dashboard cache warm-up failed: ${err}`);
  }
}

/** The running-task row shape shared by `/api/status`, `/status` and `/jobs`,
 *  so their three copies can't drift the way `/status`'s `itemShort` once did. */
export async function runningTaskViews() {
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
 *
 * Primary-only listing is intentional here: queue rows are keyed on the
 * primary repo, so a multi-repo issue resolves under that repo alone.
 */
export async function queueEntryViews(): Promise<QueueEntryView[]> {
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
      lane: workLaneOf(r.kind, r.priority === 1),
      podClass: r.status === "running" && r.agent_pod_class === "large" ? "large" : "default",
    };
  });
}

export async function jobStateRecord(controller: ControllerClient): Promise<Record<string, boolean>> {
  const jobs: Record<string, boolean> = {};
  for (const [name, running] of await controller.jobStates()) {
    jobs[name] = running;
  }
  return jobs;
}

/** The largest Forgejo webhook delivery accepted; real payloads are a few tens of KiB. */
export const MAX_FORGEJO_WEBHOOK_BYTES = 1024 * 1024;
let forgejoSelfLoginWarned = false;

/**
 * Claws' own Forgejo logins, lowercased, so a delivery Claws caused is not
 * re-reported as a human action. A failed lookup filters nothing and warns once.
 */
export async function forgejoSelfLogins(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const lookup of [forgejoSelfLogin, forgejoReadSelfLogin]) {
    try {
      const login = await lookup();
      if (login) out.add(login.toLowerCase());
    } catch (err) {
      if (!forgejoSelfLoginWarned) {
        forgejoSelfLoginWarned = true;
        log.warn(`[forgejo-webhook] Could not resolve Claws' Forgejo login — its own actions will not be filtered: ${err}`);
      }
    }
  }
  return out;
}

/** True when `fullName` is a managed (Forgejo) repo. */
export async function isManagedForgejoRepo(fullName: string): Promise<boolean> {
  const target = fullName.toLowerCase();
  return (await listRepos()).some((r) => r.fullName.toLowerCase() === target);
}
