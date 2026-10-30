import { isClawsIssueId, isClawsCommentId, registerDiscoveredForgejoRepos, FORGEJO_REPOS, LABELS, LABEL_SPECS, SKIPPED_ITEMS, PRIORITIZED_ITEMS, ALLOWED_ACTORS, writeConfig, SELF_REPO, isActive, isStagingPipelineEnabled, shouldRunWorkPipeline, getIncidentLabels, isJobDisabledForRepo, type Repo } from "./config.js";
import * as log from "./log.js";
import { reportError } from "./error-reporter.js";
import type { IssueSource, WorkflowRunRow } from "./db.js";
import type { IssueLifecycle } from "./issue-lifecycle.js";
import type { ApprovedThrough } from "./issue-approval.js";
import { mapSettledWithConcurrency } from "./util.js";
import { TTLCache, staleOpts } from "./ttl-cache.js";
import * as forgejo from "./forgejo.js";
import * as clawsIssues from "./claws-issues.js";
import { applyPrLabelAdded, applyPrLabelRemoved, isGatingLabel, isPrStateLabel } from "./pr-state.js";
import { upsertClawsPr, setClawsPrDispatchNote, getLinkedNativeId, setShadowLifecycle, setIssueBlockedReason, BlockedReasonRequiredError } from "./db.js";
import { canonicalIssueRef, canonicalCommentRef, compareIssueRefs, sameIssueRef, type IssueRef, type CommentRef } from "./issue-id.js";
import { issueRefAliases, resolveImportedRef } from "./imported-refs.js";
import { linkedIssueRefFromPR } from "./issue-link.js";
import { issueRefFromPreviewBranch } from "./preview-branch.js";
import { refreshRepoConfigs, isRepoMonitored, getRepoConfigState, getRepoConfig } from "./repo-config.js";
import { isCiExemptPath } from "./ci-exempt.js";
import { CLAWS_VISIBLE_HEADER, isClawsComment, stripClawsMarker } from "./marker-text.js";
import { TOFU_PLAN_WORKFLOW_NAME, isNoOpPlan, isInfraPinOnly, isTofuPlanComment, parseTofuPlanBody, providerBumpDiffVerdict, tofuPlanChangeCount, type TofuPlanSummary } from "./tofu-plan.js";

export { RateLimitError, isRateLimitFailure } from "./rate-limit.js";

const apiCache = new TTLCache<unknown>();

export function clearApiCache(): void {
  // Exposed for tests
  apiCache.clear();
}

/**
 * The full body of a comment Claws posts, *before* any size limit: the visible
 * header (optionally naming the agent), a blank line, then the caller's body.
 * Shared by commentOnIssue and editIssueComment so the two formats cannot
 * drift.
 */
function buildClawsCommentBody(body: string, agentName?: string): string {
  const header = agentName
    ? `*— Automated by Claws · ${agentName} —*`
    : CLAWS_VISIBLE_HEADER;
  return header + "\n\n" + body;
}

/** Reaction used by review-addresser to mark comments as addressed. */
export const ADDRESSED_REACTION = "rocket";

/** Pattern to extract reviewed-commit SHA from a Claws PR review comment. */
export const REVIEWED_COMMIT_PATTERN = /Reviewed commit: `([0-9a-f]+)`/;

/** Marker appended by review-addresser when review is addressed without code changes. */
export const REVIEW_ADDRESSED_MARKER = "review-addressed";

/** Identifies review-addresser's single rolling summary comment (edited in place each round).
 *  doc-maintainer also reads it as a machine failure signal for `.agents/pr-reviewer.md`. */
export const ADDRESSER_COMMENT_MARKER = "review-addresser-summary";

/** Written by review-addresser when it declined/failed to make the reviewed change (no commits pushed). */
export const REVIEW_REBUTTED_MARKER = "review-rebutted";
export const REVIEW_REBUTTED_PATTERN = /(?:<!-- )?review-rebutted: ([0-9a-f]+)(?: -->)?/;

/** Stamped by review-addresser after its single advisory-only fix round; one-shot loop guard. */
export const ADVISORY_ADDRESSED_MARKER = "advisory-addressed";
export const ADVISORY_ADDRESSED_PATTERN = /(?:<!-- )?advisory-addressed: ([0-9a-f]+)(?: -->)?/;

// `isClawsComment` / `stripClawsMarker` / `CLAWS_VISIBLE_HEADER` live in the
// leaf `marker-text.ts` — a pure string predicate every marker parser needs,
// which tests that stub this module out could not otherwise reach — and are
// re-exported here because every caller already reads them off the façade.
export { CLAWS_VISIBLE_HEADER, isClawsComment, stripClawsMarker };

// ── Repo cache (shared across all jobs) ──

const REPO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
// A discovery pass where Forgejo enumeration failed is cached for only a
// minute, so the next pass retries quickly.
const DEGRADED_REPO_CACHE_TTL = 60 * 1000;

let repoCache: { repos: Repo[]; fetchedAt: number; degraded: boolean } | null = null;
let repoCachePromise: Promise<Repo[]> | null = null;

/** Forgejo names from CLAWS_FORGEJO_REPOS the bot currently cannot see, so the
 *  "exclusion-only entry" line is logged once per name, not every 5 minutes. */
const inaccessibleForgejoLogged = new Set<string>();

export function clearRepoCache(): void {
  repoCache = null;
  repoCachePromise = null;
}

// ── Category-based queue cache (populated by jobs as they classify items) ──

export type QueueCategory =
  | "ready"
  | "needs-refinement"
  | "refined"
  | "needs-review-addressing"
  | "auto-mergeable"
  | "needs-triage"
  | "problematic"
  | "ci-failing"
  | "needs-review";

export const ALL_QUEUE_CATEGORIES: readonly QueueCategory[] = [
  "ready", "needs-refinement", "refined", "needs-review-addressing",
  "auto-mergeable", "needs-triage", "problematic", "ci-failing", "needs-review",
];

/** One completed pr-reviewer round (a `pr_reviews` row), for the dashboard's per-PR review ledger. */
export interface ReviewLedgerEntry {
  headSha: string;
  verdict: string;
  mode: "full" | "incremental";
  iteration: number;
  provider: string | null;
  model: string | null;
  /** ISO-8601 UTC timestamp. */
  createdAt: string;
}

export interface QueueItem {
  repo: string;
  number: IssueRef;
  title: string;
  category: QueueCategory;
  updatedAt: string;
  type: "issue" | "pr";
  checkStatus?: Exclude<CheckStatus, "none">;
  prNumber?: number;
  prioritized?: boolean;
  labels?: string[];
  mergeableState?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checksPassed?: number;
  checksTotal?: number;
  reviewStatus?: "clean" | "issues" | "escalated" | "none";
  reviewIssueCount?: number;
  infraPaths?: string[];
  tofuPlan?: TofuPlanSummary;
  tofuPlanState?: TofuPlanState;
  tofuPlanDetail?: string;
  /** Every changed file is a provider pin (`versions.tf` / `.terraform.lock.hcl`). */
  infraPinOnly?: boolean;
  /** Forgejo only: the diff passes `providerBumpDiffVerdict`, so the no-op plan exception may apply. */
  infraBumpEligible?: boolean;
  /** Forgejo only: why `providerBumpDiffVerdict` refused the diff. */
  infraBumpHoldReason?: string;
  /** Why the auto-merger last declined an approved PR (#2971). */
  mergeBlockReason?: string;
  /** One sentence saying why no agent will act on this PR this cycle. */
  note?: string;
  /** Recent recorded review rounds, newest first — attached by the server, not the poller. */
  reviewLedger?: ReviewLedgerEntry[];
}

const queueCache = new Map<string, { item: QueueItem; fetchedAt: number }>();

/** How long a queue cache entry is considered fresh. Entries older than this
 * are evicted on read. Longer than the slowest dispatcher interval (10 min
 * for ci-fixer / triage) so a single transient scan failure does
 * not wipe the cache. */
export const QUEUE_ENTRY_TTL_MS = 20 * 60 * 1000;

/**
 * `config.ts` canonicalises both lists at load, so the stored side is already
 * canonical; `sameIssueRef` covers the *caller's* side, which may be a ref
 * spelled however an issue body or a URL segment wrote it. A bare `===` here
 * would silently never match a lower-cased `clw_…`, and Claws would keep
 * dispatching an item an operator explicitly told it to leave alone.
 *
 * Matched against every {@link issueRefAliases} spelling of the caller's ref,
 * so an operator's `{repo, <forge number>}` entry still matches after that
 * issue was imported — otherwise an import would silently un-skip an item the
 * operator told Claws to leave alone (#3245). `repo` stays an exact match:
 * forge numbers collide across repositories.
 */
export function isItemSkipped(repo: string, number: IssueRef): boolean {
  const aliases = issueRefAliases(repo, number);
  return SKIPPED_ITEMS.some((i) => i.repo === repo && aliases.some((a) => sameIssueRef(i.number, a)));
}

export function isItemPrioritized(repo: string, number: IssueRef): boolean {
  const aliases = issueRefAliases(repo, number);
  return PRIORITIZED_ITEMS.some((i) => i.repo === repo && aliases.some((a) => sameIssueRef(i.number, a)));
}

/**
 * True when the item carries `Priority` or an incident label (built-in
 * `grafana-alert`, or any repo's `claws.json` `incidentLabels`). Either sets
 * the work-queue priority flag, so the row is claimed ahead of every
 * non-priority row and by the priority-only express worker.
 */
export function hasPriorityLabel(labels: { name: string }[]): boolean {
  if (labels.some((l) => l.name === LABELS.priority)) return true;
  const incident = getIncidentLabels();
  return labels.some((l) => incident.includes(l.name));
}

export function hasBlockedLabel(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name === LABELS.blocked);
}

export function hasBacklogLabel(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name === LABELS.backlog);
}

export function hasStagingLabel(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name === LABELS.clawsStaging);
}

export const CLAWS_STAGING_PR_MARKER = "claws-staging-owned: true";

function hasStagingOwnershipMarker(body?: string | null): boolean {
  return body?.split(/\r?\n/).some((line) => line.trim() === CLAWS_STAGING_PR_MARKER) ?? false;
}

/** True when a label tells Claws to leave the item alone. Three cases:
 *  1. Blocked precondition — `Blocked` in every activation state.
 *  2. Backlog — `Backlog` in every activation state. Unlike `Blocked`, nothing
 *     automated ever removes it; only a human promotes it back onto the board.
 *  3. Active-instance staging skip — `Claws Staging` only when `isActive()`. */
export function isParked(labels: { name: string }[]): boolean {
  return hasBlockedLabel(labels) || hasBacklogLabel(labels) ||
    (isActive() && hasStagingLabel(labels));
}

/**
 * The fields of an issue or PR the dispatch-skip checks read. `headRefName`
 * is a PR's head branch: a disposable issue preview is recognised by its
 * `claws/preview-issue-` branch. `importPending` is set on a native issue
 * `issue-importer` is still assembling (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD).
 */
export interface DispatchSkipItem {
  number: IssueRef;
  labels: { name: string }[];
  body?: string | null;
  headRefName?: string;
  importPending?: boolean;
}

/**
 * Why the dispatcher leaves this item alone, or null when it may dispatch it.
 * The reason is the first of {@link isDispatchSkippable}'s checks that fired.
 */
export function dispatchSkipReason(repoFullName: string, item: DispatchSkipItem): string | null {
  if (!shouldRunWorkPipeline()) return "work pipeline paused";
  if (isItemSkipped(repoFullName, item.number)) return "skipped from the dashboard";
  if (item.headRefName !== undefined && issueRefFromPreviewBranch(item.headRefName) !== null) return "issue preview PR";
  if (item.importPending) return "import in progress";
  if (hasBlockedLabel(item.labels)) return `parked by label ${LABELS.blocked}`;
  if (hasBacklogLabel(item.labels)) return `parked by label ${LABELS.backlog}`;
  if (isActive() && (hasStagingLabel(item.labels) || hasStagingOwnershipMarker(item.body))) return "staging-owned";
  if (isStagingPipelineEnabled() && !hasStagingLabel(item.labels) && !hasStagingOwnershipMarker(item.body)) return "not opted in to staging";
  return null;
}

export function isDispatchSkippable(repoFullName: string, item: DispatchSkipItem): boolean {
  return dispatchSkipReason(repoFullName, item) !== null;
}

/**
 * Why a forge issue must wait for `issue-importer` before any agent acts on
 * it, or null. In a repo with the importer enabled, Claws imports a forge
 * issue into the native tracker before it runs, comments on or relabels it
 * (#clw_01M52GPG0E9DP8RQKW6ABH0X7R); a native id, or a repo with the
 * importer switched off, is never held.
 */
export function awaitingImportReason(repoFullName: string, item: { number: IssueRef }): string | null {
  if (isNativeIssue(item.number)) return null;
  if (isJobDisabledForRepo("issue-importer", repoFullName)) return null;
  return "awaiting import into the native tracker";
}

/**
 * {@link dispatchSkipReason} for issue-scoped work: also holds a forge issue
 * {@link awaitingImportReason} says has not been imported yet. PR callers keep
 * {@link dispatchSkipReason}, since a PR is never imported.
 */
export function issueDispatchSkipReason(repoFullName: string, item: DispatchSkipItem): string | null {
  return dispatchSkipReason(repoFullName, item) ?? awaitingImportReason(repoFullName, item);
}

export function isIssueDispatchSkippable(repoFullName: string, item: DispatchSkipItem): boolean {
  return issueDispatchSkipReason(repoFullName, item) !== null;
}

// gh CLI returns "app/<slug>" for GitHub App authors in `--json author` output,
// while the REST /app endpoint (used by getAppBotLogin) returns `<slug>[bot]`.
// Normalize to the `[bot]` form so comparisons work regardless of which API
// produced the login.
export function normalizeBotLogin(login: string): string {
  if (login.startsWith("app/")) return `${login.slice("app/".length)}[bot]`;
  return login;
}

/**
 * Returns true if the login is in the configured allowedActors list or is
 * Claws' own login.
 *
 * Pass `repo` whenever a repo full name is in hand. Claws posts as the Forgejo
 * token's own account; the parameter is optional only for the handful of call
 * sites with no repo context, which skip the read-account exemption below.
 *
 * Pass `ref` whenever the login came off a *specific* issue or PR. On a native
 * issue Claws writes itself as the literal login `claws`
 * ({@link clawsIssues.CLAWS_NATIVE_LOGIN}), which has to be trusted or an
 * operator who empties `allowedActors` gets dashboard-created native issues
 * skipped by every dispatcher and auditor with no log line saying why. That
 * exemption is scoped to native items on purpose: `github.com/claws` is a real
 * account this org does not control, and so is any self-registered `claws` on
 * the Forgejo instance — trusting the login alone would hand either of them
 * the untrusted-actor gate on every monitored repo.
 *
 * When `repo` is given, the least-privilege read/issue account
 * (`forgejo.forgejoReadSelfLogin()`) is trusted too: it files Claws' own
 * companion issues on other managed Forgejo repos via the implicit
 * `cross-repo` capability (#3152). This exemption never applies to
 * {@link isAllowedHumanActor} — the read account must never count as a human
 * approver.
 */
export async function isAllowedActor(login: string, repo?: string, ref?: IssueRef): Promise<boolean> {
  const normalized = normalizeBotLogin(login);
  if (ALLOWED_ACTORS.includes(login) || ALLOWED_ACTORS.includes(normalized)) return true;
  if (isNativeIssue(ref) && normalized === clawsIssues.CLAWS_NATIVE_LOGIN) return true;
  const self = await getSelfLoginForRepo(repo ?? SELF_REPO);
  if (normalized === normalizeBotLogin(self)) return true;
  if (!repo) return false;
  const readLogin = await forgejo.forgejoReadSelfLogin();
  return readLogin !== null && normalized === normalizeBotLogin(readLogin);
}

/**
 * A 👍 counts as human approval only when it comes from a configured
 * allowedActors login that is neither Claws' own account nor a bot (#3232).
 * `isAllowedActor` deliberately returns true for Claws' own login (#2650), so
 * the self/bot exclusion has to be explicit here.
 */
export async function isAllowedHumanActor(login: string, repo: string): Promise<boolean> {
  const normalized = normalizeBotLogin(login);
  if (!normalized) return false;
  if (normalized.endsWith("[bot]")) return false;
  if (CI_FAILURE_ALERT_BOT_LOGINS.includes(login) || CI_FAILURE_ALERT_BOT_LOGINS.includes(normalized)) return false;
  if (FORGEJO_CI_ALERT_BOT_LOGINS.includes(login.toLowerCase())) return false;
  if (normalized === normalizeBotLogin(await getSelfLoginForRepo(repo))) return false;
  if (!ALLOWED_ACTORS.includes(login) && !ALLOWED_ACTORS.includes(normalized)) return false;
  const readLogin = await forgejo.forgejoReadSelfLogin();
  if (readLogin !== null && normalized === normalizeBotLogin(readLogin)) return false;
  return isAllowedActor(login, repo);
}

// GitHub Actions runner logins. Kept because they are harmless: Forgejo usernames
// cannot contain `[`, `]` or `/`, so no Forgejo account can claim them.
const CI_FAILURE_ALERT_BOT_LOGINS = ["github-actions[bot]", "app/github-actions"];
/** Forgejo Actions runner login; trusted as an alert author whenever a repo is given. */
const FORGEJO_CI_ALERT_BOT_LOGINS = ["forgejo-actions"];

/**
 * True if the issue's author is the GitHub Actions runner bot — in either the
 * gh-CLI `app/github-actions` form or the REST `github-actions[bot]` form.
 * Issues filed by this bot are CI/automation alerts (build failures, migration
 * failures, Lighthouse/Cypress regressions, etc.), not human work items, so the
 * issue-dispatcher's actor gate dispatches them into the refine-and-fix pipeline
 * even though the bot is not in `allowedActors`. This replaces the former
 * title-allowlist approach: any runner-authored issue is opted in, regardless of
 * title. Other bots (dependabot, etc.) are NOT covered — only the github-actions
 * runner logins in `CI_FAILURE_ALERT_BOT_LOGINS`, plus `forgejo-actions` whenever
 * a `repo` is given — safe because every managed repo is on Forgejo, where that
 * login is the runner's own. Neither is ever a human approver (see `isAllowedHumanActor`).
 */
export function isCiAlertBotAuthor(issue: { author: { login: string }; title?: string }, repo?: string): boolean {
  if (CI_FAILURE_ALERT_BOT_LOGINS.includes(issue.author.login)) return true;
  return !!repo && FORGEJO_CI_ALERT_BOT_LOGINS.includes(issue.author.login);
}

const DEPENDENCY_BOT_LOGINS = [
  "renovate",
  "renovate[bot]",
  "app/renovate",
  "dependabot[bot]",
  "app/dependabot",
];

/**
 * True if the issue's author is a dependency-update bot (Renovate, Dependabot).
 * These bots file generated tracking issues such as Renovate's Dependency
 * Dashboard, which are not work items, so the dispatcher skips them silently
 * instead of raising a disallowed-actor alert (#3034).
 */
export function isDependencyBotAuthor(issue: { author: { login: string } }): boolean {
  return DEPENDENCY_BOT_LOGINS.includes(issue.author.login);
}

export async function skipItem(repo: string, number: IssueRef): Promise<void> {
  // Write the canonical spelling, so the entry matches the refs the pipeline
  // holds and re-reading the config is a fixed point.
  const canonical = canonicalIssueRef(number) ?? number;
  // Dedup against every alias `isItemSkipped` reads, or skipping an imported
  // issue by its native id when a `{repo, <forge number>}` entry already exists
  // appends a second entry meaning the same thing, and the operator has to
  // unskip twice with no indication why (#3245).
  const aliases = issueRefAliases(repo, number);
  const items = [...(SKIPPED_ITEMS as Array<{ repo: string; number: IssueRef }>)];
  if (!items.some((i) => i.repo === repo && aliases.some((a) => sameIssueRef(i.number, a)))) {
    items.push({ repo, number: canonical });
    await writeConfig({ skippedItems: items });
  }
  removeQueueItem(repo, canonical);
}

export async function postProblematicPRComment(
  repo: string,
  prNumber: number,
  reason: string,
  attemptCount: number,
  recentErrors: Array<{ error: string; timestamp: string }>,
  pushedCount: number,
): Promise<void> {
  const body = [
    `### 🚫 PR Marked as Problematic`,
    `problematic-pr-marked`,
    "",
    `This PR has been automatically marked as problematic after **${attemptCount} counted CI fix attempts** (**${pushedCount}** pushed a commit).`,
    "",
    `**Reason:** ${reason}`,
    "",
    `Manual intervention is required to resolve the CI failures. The CI fixer will not make further automatic attempts.`,
    "",
    recentErrors.length > 0 ? "**Recent errors:**" : "",
    ...recentErrors.map((e, i) => {
      const timestamp = e.timestamp.includes("T") ? e.timestamp : e.timestamp.replace(" ", "T") + "Z";
      const formattedDate = new Date(timestamp).toLocaleString();
      const truncatedError = e.error.length > 1000 ? e.error.slice(0, 1000) + "\n... (truncated)" : e.error;
      const lines = [
        `<details>`,
        `<summary>Attempt ${recentErrors.length - i} (${formattedDate})</summary>`,
        "",
        "```",
        truncatedError,
        "```",
        "</details>",
      ];
      return lines.join("\n");
    }),
    "",
    `Push a commit to this PR and Claws will automatically make a fresh set of CI-fix attempts (a limited number of times). To retry immediately, use **Unmark problematic** on the Claws dashboard's \`/prs\` page.`,
  ].filter(Boolean).join("\n");

  await commentOnIssue(repo, prNumber, body, { agentName: "CI Fixer" });
}

/**
 * The queue cache's key fragment for an item ref, canonical by construction.
 *
 * Keys are `category:repo:number`, so a ref spelled `clw_01jbq…` anywhere
 * upstream would key a *second* entry for an issue already in the cache, and
 * `removeQueueItem` would then miss the other one — a live queue entry for an
 * issue that has been skipped or transferred. Canonicalising on the way in
 * keeps that out of the seven call sites, which is where it would rot.
 */
function queueRef(number: IssueRef): IssueRef {
  return canonicalIssueRef(number) ?? number;
}

export function removeQueueItem(repo: string, number: IssueRef): void {
  const suffix = `:${repo}:${queueRef(number)}`;
  for (const key of queueCache.keys()) {
    if (key.endsWith(suffix)) queueCache.delete(key);
  }
}

/**
 * Evict queue-cache entries for `repo` in `categories` (optionally restricted
 * to one item `type`) whose item number is NOT in `keep`. Dispatchers call this
 * at the end of a full repo scan with the set of numbers they (re)populated this
 * cycle, so items that dropped out — closed, merged, relabelled, feedback
 * addressed — are removed immediately instead of lingering until
 * QUEUE_ENTRY_TTL_MS. `type` keeps issue-dispatcher and pr-dispatcher from
 * clobbering each other's entries in the shared "ready" category.
 *
 * Membership is tested on {@link queueRef}ed forms rather than on `Set`
 * identity: `keep` is built by the caller from whatever the scan handed it,
 * and across the `number | string` union a `123` and a Postgres-returned
 * `"123"` are different members — which would evict a live queue entry.
 */
export function reconcileQueueCache(
  repo: string,
  categories: readonly QueueCategory[],
  keep: ReadonlySet<IssueRef>,
  type?: "issue" | "pr",
): void {
  const catSet = new Set(categories);
  const keepRefs = new Set([...keep].map(queueRef));
  for (const [key, entry] of queueCache) {
    if (entry.item.repo !== repo) continue;
    if (!catSet.has(entry.item.category)) continue;
    if (type && entry.item.type !== type) continue;
    if (!keepRefs.has(queueRef(entry.item.number))) queueCache.delete(key);
  }
}

export function populateQueueCache(category: QueueCategory, repo: string, item: { number: IssueRef; title: string; type: "issue" | "pr"; updatedAt?: string; priority?: boolean; labels?: string[]; note?: string }): void {
  if (isItemSkipped(repo, item.number)) return;
  const number = queueRef(item.number);
  const newKey = `${category}:${repo}:${number}`;
  // Evict any entry for the same (repo, number) under a different category
  // so category transitions (e.g. needs-refinement → refined) cleanly replace
  // rather than accumulate.
  const suffix = `:${repo}:${number}`;
  for (const key of queueCache.keys()) {
    if (key !== newKey && key.endsWith(suffix)) queueCache.delete(key);
  }
  queueCache.set(newKey, {
    item: {
      repo,
      number,
      title: item.title,
      category,
      updatedAt: item.updatedAt ?? "",
      type: item.type,
      prioritized: isItemPrioritized(repo, item.number) || item.priority === true,
      labels: item.labels,
      ...(item.note ? { note: item.note } : {}),
    },
    fetchedAt: Date.now(),
  });
}

export function populateQueueCacheFor(
  category: QueueCategory,
  repo: string,
  item: { number: IssueRef; title: string; updatedAt?: string; labels: { name: string }[] },
  type: "issue" | "pr",
  note?: string,
): void {
  populateQueueCache(category, repo, {
    number: item.number,
    title: item.title,
    type,
    updatedAt: item.updatedAt,
    priority: hasPriorityLabel(item.labels),
    labels: item.labels.map((l) => l.name),
    note,
  });
}

// ── Merge-block reasons (set by the auto-merger for approved PRs it could not merge, #2971) ──

const MERGE_BLOCK_TTL_MS = 60 * 60 * 1000;
/** How long a stored dispatch note stays fresh. */
const DISPATCH_NOTE_TTL_MS = 60 * 60 * 1000;
const mergeBlockReasons = new Map<string, { reason: string; code?: string; at: number }>();

/** Record (or clear, with null) why the auto-merger could not merge an approved PR, with its `MergeSkipCode`. */
export function setMergeBlockReason(repo: string, prNumber: number, reason: string | null, code?: string): void {
  const key = `${repo}#${prNumber}`;
  if (reason === null) mergeBlockReasons.delete(key);
  else mergeBlockReasons.set(key, { reason, code, at: Date.now() });
}

/** The `MergeSkipCode` recorded with the PR's merge block, if one was recorded within the last hour. */
export function getMergeBlockCode(repo: string, prNumber: number): string | undefined {
  return getMergeBlockReason(repo, prNumber) === undefined ? undefined : mergeBlockReasons.get(`${repo}#${prNumber}`)?.code;
}

const ciFixerGaveUpHeads = new Map<string, string>();

/** Record (or clear, with null) the head the CI fixer gave up on for a PR. */
export function setCiFixerGaveUp(repo: string, prNumber: number, headSha: string | null): void {
  const key = `${repo}#${prNumber}`;
  if (headSha === null) ciFixerGaveUpHeads.delete(key);
  else ciFixerGaveUpHeads.set(key, headSha);
}

/** Whether the CI fixer gave up on exactly this head of the PR. */
export function ciFixerGaveUpOnHead(repo: string, prNumber: number, headSha: string | null | undefined): boolean {
  return !!headSha && ciFixerGaveUpHeads.get(`${repo}#${prNumber}`) === headSha;
}

/** Drop `repo`'s gave-up records for PRs no longer open. */
export function pruneCiFixerGaveUp(repo: string, openPRNumbers: ReadonlySet<number>): void {
  const prefix = `${repo}#`;
  for (const key of ciFixerGaveUpHeads.keys()) {
    if (key.startsWith(prefix) && !openPRNumbers.has(Number(key.slice(prefix.length)))) ciFixerGaveUpHeads.delete(key);
  }
}

/** The auto-merger's last block reason for a PR, if recorded within the last hour. */
export function getMergeBlockReason(repo: string, prNumber: number): string | undefined {
  const key = `${repo}#${prNumber}`;
  const entry = mergeBlockReasons.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > MERGE_BLOCK_TTL_MS) {
    mergeBlockReasons.delete(key);
    return undefined;
  }
  return entry.reason;
}

// ── Dispatch notes (why no agent acts on a PR this cycle, #clw_01M4B5GZK2CC3F5MKE4W6P2XZV) ──

// Stored on the PR's `claws_prs` row, not in memory: the work handlers that
// record most notes run in an agent pod under `CLAWS_WORK_BACKEND=k8s-pod`,
// whose `db.js` forwards the write to the service through the ops API.

/**
 * Record (or clear, with null) why the dispatcher or a work handler left a PR
 * alone. A failed write is logged, never thrown: the note is informational.
 */
export async function setDispatchNote(repo: string, prNumber: number, note: string | null): Promise<void> {
  try {
    await setClawsPrDispatchNote(repo, prNumber, note);
  } catch (err) {
    log.warn(`[dispatch-note] could not record the dispatch note for ${repo}#${prNumber}: ${err}`);
  }
}

/** A row's dispatch note, if recorded within the last hour. */
export function freshDispatchNote(row: { dispatchNote: string | null; dispatchNoteAt: string | null } | undefined, now = Date.now()): string | undefined {
  if (!row?.dispatchNote || !row.dispatchNoteAt) return undefined;
  if (now - Date.parse(row.dispatchNoteAt) > DISPATCH_NOTE_TTL_MS) return undefined;
  return row.dispatchNote;
}

export function getQueueSnapshot(categories: readonly QueueCategory[]): { items: QueueItem[]; oldestFetchAt: number | null } {
  const catSet = new Set(categories);
  const now = Date.now();

  // Pass 1: evict TTL-expired entries across all categories.
  for (const [key, entry] of queueCache) {
    if (now - entry.fetchedAt > QUEUE_ENTRY_TTL_MS) queueCache.delete(key);
  }

  // Pass 2: for each (repo, number), keep only the freshest entry in the
  // requested categories. Prior implementation deduped by insertion order,
  // which preferred the OLDER entry — the root cause of stale categories
  // appearing after a transition.
  const best = new Map<string, { item: QueueItem; fetchedAt: number }>();
  for (const [, entry] of queueCache) {
    if (!catSet.has(entry.item.category)) continue;
    const dedup = `${entry.item.repo}:${entry.item.number}`;
    const existing = best.get(dedup);
    if (!existing || entry.fetchedAt > existing.fetchedAt) {
      best.set(dedup, entry);
    }
  }

  const items: QueueItem[] = [];
  let oldestFetchAt: number | null = null;
  for (const entry of best.values()) {
    if (oldestFetchAt === null || entry.fetchedAt < oldestFetchAt) {
      oldestFetchAt = entry.fetchedAt;
    }
    const item = { ...entry.item };
    if (item.type === "pr" && typeof item.number === "number") {
      const reason = getMergeBlockReason(item.repo, item.number);
      if (reason) item.mergeBlockReason = reason;
    }
    items.push(item);
  }

  items.sort((a, b) => {
    if (a.prioritized && !b.prioritized) return -1;
    if (!a.prioritized && b.prioritized) return 1;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
  return { items, oldestFetchAt };
}

export function clearQueueCache(): void {
  queueCache.clear();
}

/**
 * The login Claws posts as in a managed repo: the Forgejo token's own account.
 * `repo` is accepted so call sites keep stating which repo they mean.
 */
export async function getSelfLoginForRepo(_repo: string): Promise<string> {
  return forgejo.forgejoSelfLogin();
}

/**
 * Does this `(repo, ref)` route to the native store?
 *
 * The single predicate every routing site in this file uses, so the boundary
 * cannot drift: `isClawsIssueId` is anchored and does *not* trim, so a ref
 * carrying surrounding whitespace would resolve natively in whichever
 * functions happened to canonicalise first and fall through to a 404-ing Forgejo
 * call in the rest. The backends canonicalise again on entry, so passing the
 * caller's spelling straight through is safe.
 */
export function isNativeIssue(ref: IssueRef | null | undefined): ref is string {
  return isClawsIssueId(canonicalIssueRef(ref));
}

/** {@link isNativeIssue} for comment ids. */
export function isNativeComment(ref: CommentRef | null | undefined): ref is string {
  return isClawsCommentId(canonicalCommentRef(ref));
}

/**
 * The login Claws posts as on a *specific issue*. Prefer this over
 * {@link getSelfLoginForRepo} wherever the answer is compared against a
 * comment author or a reaction login: a Claws-native issue is written as the
 * constant `claws`, and asking the forge for a bot login there would both be
 * wrong and cost an API call the native path otherwise never makes.
 */
export async function getSelfLoginForIssue(repo: string, issueRef: IssueRef): Promise<string> {
  if (isNativeIssue(issueRef)) return clawsIssues.CLAWS_NATIVE_LOGIN;
  return getSelfLoginForRepo(repo);
}

export async function isRepoPrivate(repo: string): Promise<boolean> {
  return forgejo.isRepoPrivate(repo);
}

// ── Repo discovery ──

/**
 * Whether the latest `listRepos()` result came from a fetch where Forgejo
 * enumeration failed. A repo missing from a degraded listing may still be managed,
 * so callers must not treat its absence as definitive.
 */
export function isRepoListDegraded(): boolean {
  return repoCache?.degraded ?? false;
}

/** Fixed message prefix of {@link TransientRepoListError}; the worker matches failed rows on it. */
export const TRANSIENT_REPO_LIST_PREFIX = "transient repo-list failure";

/**
 * A repo is missing from a repo list built while forge discovery failed, so its
 * absence proves nothing. Retry the work item later instead of failing it as
 * "Unknown repo".
 */
export class TransientRepoListError extends Error {
  constructor(readonly repo: string) {
    super(`${TRANSIENT_REPO_LIST_PREFIX}: ${repo} is missing from a repo list built while forge discovery failed`);
    this.name = "TransientRepoListError";
  }
}

export async function listRepos(): Promise<Repo[]> {
  // Return cached result if still fresh
  if (repoCache) {
    const ttl = repoCache.degraded ? DEGRADED_REPO_CACHE_TTL : REPO_CACHE_TTL;
    if (Date.now() - repoCache.fetchedAt < ttl) return repoCache.repos;
  }

  // Deduplicate concurrent calls: if a fetch is already in flight, reuse it
  if (repoCachePromise) {
    return repoCachePromise;
  }

  repoCachePromise = (async () => {
    const { repos, forgejoFailed } = await fetchRepos();

    // If the fetch returned empty but we had repos before, a transient error
    // likely caused Forgejo enumeration to fail. Return stale cache.
    if (repos.length === 0 && repoCache && repoCache.repos.length > 0) {
      log.warn(`listRepos: fetch returned 0 repos, returning stale cache (${repoCache.repos.length} repos)`);
      return repoCache.repos;
    }

    repoCache = { repos, fetchedAt: Date.now(), degraded: forgejoFailed };
    return repos;
  })();

  try {
    return await repoCachePromise;
  } finally {
    repoCachePromise = null;
  }
}

/**
 * Repos whose canonical home is Forgejo. Enumerated from the bot account's
 * accessible repos (#2885): granting `clawsstjohn` write access on Forgejo
 * plus a root `claws.json` is the only onboarding step, with
 * `CLAWS_FORGEJO_REPOS` as an emergency additive override (#2952).
 *
 * Skipped entirely when no forgejoToken is configured: every call would throw
 * from requireToken() and file a recurring [claws-error] alert on each cache
 * refresh for a static misconfiguration (#2670). config.ts warns at load.
 */
async function fetchForgejoRepos(): Promise<{ repos: Repo[]; failed: boolean }> {
  if (!forgejo.isConfigured()) return { repos: [], failed: false };

  const byName = new Map<string, Repo>();
  let enumerationFailed = false;

  try {
    for (const info of await forgejo.listAccessibleRepos()) {
      byName.set(info.fullName.toLowerCase(), {
        owner: info.owner,
        name: info.name,
        fullName: info.fullName,
        defaultBranch: info.defaultBranch,
        forge: "forgejo",
      });
    }
  } catch (err) {
    // A failed enumeration falls back to the previous cache's Forgejo entries
    // rather than dropping every Forgejo repo from the managed set.
    reportError("github:list-repos-forgejo", "discovery", err);
    enumerationFailed = true;
    for (const stale of repoCache?.repos.filter((r) => r.forge === "forgejo") ?? []) {
      byName.set(stale.fullName.toLowerCase(), stale);
    }
  }

  // `CLAWS_FORGEJO_REPOS` (normally empty) is an additive override on top of
  // discovery: a repo the bot cannot enumerate (or one listed before it was
  // granted access) is still fetched by name. A repo whose metadata fetch
  // fails falls back to its previous cache entry and is otherwise skipped —
  // never automated against a guessed default branch (#2650). A name the bot
  // cannot see at all (404/403) is skipped quietly as an exclusion-only entry
  // (#2921).
  for (const fullName of FORGEJO_REPOS) {
    const key = fullName.toLowerCase();
    if (byName.has(key)) {
      inaccessibleForgejoLogged.delete(key);
      continue;
    }
    try {
      const info = await forgejo.getRepo(fullName);
      inaccessibleForgejoLogged.delete(key);
      byName.set(info.fullName.toLowerCase(), {
        owner: info.owner,
        name: info.name,
        fullName: info.fullName,
        defaultBranch: info.defaultBranch,
        forge: "forgejo",
      });
    } catch (err) {
      // Gitea returns 404 for "invisible to this token" as well as "gone", so a
      // 404/403 here means the bot has no access — a supported state for an
      // exclusion-only entry like St-John-Software/forgejo (#2921). Claws must
      // not automate a repo it cannot read, so skip it without an error issue and
      // without resurrecting a stale cache entry.
      if (forgejo.isMissing(err)) {
        if (!inaccessibleForgejoLogged.has(key)) {
          inaccessibleForgejoLogged.add(key);
          log.info(`fetchForgejoRepos: ${fullName} is not visible to the Forgejo bot account — not automated. Grant it write access on Forgejo to bring it under Claws.`);
        }
        continue;
      }
      reportError("github:list-repos-forgejo", fullName, err, { repo: fullName });
      enumerationFailed = true;
      const stale = repoCache?.repos.find((r) => r.fullName === fullName);
      if (stale) byName.set(key, stale);
    }
  }

  const list = [...byName.values()];
  // Registering an empty set after a failed enumeration would forget every
  // discovered Forgejo repo.
  if (!(enumerationFailed && list.length === 0)) {
    registerDiscoveredForgejoRepos(list.map((r) => r.fullName));
  }
  return { repos: list, failed: enumerationFailed };
}

async function fetchRepos(): Promise<{ repos: Repo[]; forgejoFailed: boolean }> {
  // Forgejo is the only managed forge: the repo set is its discovery plus
  // CLAWS_FORGEJO_REPOS. GitHub hosts only the public snapshot targets.
  const forgejoResult = await fetchForgejoRepos();
  const repos: Repo[] = [...forgejoResult.repos];

  // `claws.json` at the repo root is mandatory: a repo that does not carry one
  // on its default branch has not opted into Claws and is not automated at all
  // (#2885). The Forgejo names are registered above, so fetchRepoFileContent
  // routes every call to Forgejo.
  await refreshRepoConfigs(repos, (fullName, p) => fetchRepoFileContent(fullName, p));
  const kept = repos.filter((r) => isRepoMonitored(r.fullName));
  const dropped = repos.filter((r) => !isRepoMonitored(r.fullName));
  if (dropped.length > 0) {
    const reasons = dropped
      .map((r) => `${r.fullName} (${getRepoConfigState(r.fullName) === "absent" ? "no claws.json" : 'claws.json "enabled": false'})`)
      .join(", ");
    log.warn(`listRepos: not monitoring ${dropped.length} repo(s) — ${reasons}`);
  }

  return { repos: kept, forgejoFailed: forgejoResult.failed };
}

/**
 * Tag of the most-recent STABLE release on `repo`, or null if none. Filters out
 * prereleases (RC/beta) and drafts; releases are listed newest-first. (#1851)
 */
export async function getLatestStableReleaseTag(repo: string): Promise<string | null> {
  const stable = (await forgejo.listReleases(repo)).filter((r) => !r.prerelease && !r.draft);
  return stable[0]?.tag ?? null;
}

/** All stable (non-draft, non-prerelease) release tags on `repo`, newest-first. (#1941) */
export async function listStableReleaseTags(repo: string): Promise<string[]> {
  return (await forgejo.listReleases(repo)).filter((r) => !r.prerelease && !r.draft).map((r) => r.tag);
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
  draft: boolean;
  url: string;
}

/**
 * Recent releases on `repo`, newest-first, with the fields the upstream-watcher
 * needs to decide whether a release satisfies a watch. Unlike
 * `listStableReleaseTags` this keeps drafts and prereleases so the caller can
 * apply its own filter. (#2617)
 */
export async function listReleases(repo: string): Promise<ReleaseInfo[]> {
  return forgejo.listReleases(repo);
}

/**
 * Download every release asset from `repo`@`tag` into `destDir`. (#1851)
 * Only `"*"` is supported, which is what the only caller passes.
 */
export async function downloadReleaseAssets(repo: string, tag: string, pattern: string, destDir: string): Promise<void> {
  if (pattern !== "*") throw new Error(`downloadReleaseAssets: pattern "${pattern}" unsupported for Forgejo repo ${repo}`);
  await forgejo.downloadReleaseAssets(repo, tag, destDir);
}

// ── Issue search & creation ──

// Exact-title lookup over the cached open-issue list, not a search index: the list
// API is strongly consistent, where a search index lags creation by minutes (#2289).
export async function findIssueByExactTitle(
  repo: string,
  title: string,
): Promise<{ number: IssueRef; title: string; labels: string[] } | null> {
  const open = await listOpenIssues(repo);
  const match = open
    .filter((i) => i.title === title || i.filedTitle === title)
    .sort((a, b) => compareIssueRefs(a.number, b.number))[0];
  if (!match) return null;
  return { number: match.number, title: match.title, labels: match.labels.map((l) => l.name) };
}

/** Open PRs whose title contains `needle`. Replaces the old `gh search prs` path (#2289). */
export async function findOpenPRsByTitle(
  repo: string,
  needle: string,
): Promise<{ number: number; title: string }[]> {
  const open = await listPRs(repo);
  return open.filter((p) => p.title.includes(needle)).map((p) => ({ number: p.number, title: p.title }));
}

/**
 * File a new issue for `repo`, returning its reference.
 *
 * Unlike every other routed function there is no ref to route on yet, and
 * unlike every other write there is no forge to fall back to: `createIssue`
 * always files a native issue associated with exactly this repo — which is
 * what makes automation treat it as an ordinary issue of `repo`, GitHub and
 * Forgejo alike, since the native store is forge-agnostic — and returns its
 * `clw_…` id.
 *
 * Labels are stored directly instead of calling {@link ensureLabel}: the
 * native store has no label registry to provision. The dashboard still
 * creates its own issues through `claws-issues.ts` directly rather than
 * through this function, since it authors them as the operator.
 *
 * `opts.source` says where the issue came from, which decides whether its
 * requirements wait for a human before planning; it defaults to `automation`,
 * an unattended source.
 */
export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[],
  opts?: { source?: IssueSource; blockedReason?: string; approveThrough?: ApprovedThrough; approvedBy?: string; alertKind?: string },
): Promise<IssueRef> {
  return clawsIssues.createIssue({
    title,
    body,
    authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
    repos: [repo],
    labels,
    source: opts?.source ?? "automation",
    blockedReason: opts?.blockedReason,
    ...(opts?.approveThrough ? { approvedThrough: opts.approveThrough, approvedBy: opts.approvedBy } : {}),
    ...(opts?.alertKind ? { alertKind: opts.alertKind } : {}),
  });
}

/**
 * Open issues for `repo`: the forge's own, followed by the Claws-native issues
 * whose primary repository is this one.
 *
 * The native read sits outside the 60 s `apiCache` block on purpose — it is a
 * local database query, so caching it would only delay a label change the
 * dashboard just made from reaching the next dispatcher tick. It runs
 * concurrently with the forge round trip, and a native failure degrades to an
 * empty list rather than costing the caller the forge issues it would
 * otherwise have processed fine.
 *
 * A native issue is listed here under its primary repository only (the
 * dispatch rule); discovery views use `clawsIssues.listOpenIssuesNaming`.
 *
 * A forge issue already imported into the native tracker is dropped unless
 * `opts.includeImported` — see {@link ListIssuesOptions}.
 */
export async function listOpenIssues(
  repo: string,
  opts?: ListIssuesOptions,
): Promise<Issue[]> {
  const forgePromise = forgejo.listOpenIssues(repo, opts?.staleOk ? { staleOk: true } : undefined);
  const [forgeIssues, nativeIssues] = await Promise.all([forgePromise, nativeOrEmpty(`listOpenIssues ${repo}`, clawsIssues.listOpenIssues(repo))]);
  return [...withoutImported(repo, forgeIssues, opts), ...nativeIssues];
}

/** Options for {@link listOpenIssues} and {@link listIssuesByLabel}. */
export interface ListIssuesOptions {
  /**
   * Keep forge issues already imported into the native tracker. Default false.
   *
   * Once imported, a forge issue is never live work: a human or a bot
   * reopening or editing it puts it back in the forge's open listing, but the
   * issue Claws plans against is its native copy, and `issue-shadow-sync`
   * forwards the forge change there. Without this filter the dispatcher,
   * refiner and board would each treat the forge copy as a second issue.
   * Only `issue-importer` and `issue-shadow-sync` opt back in, because they
   * are the two jobs that handle these copies.
   */
  includeImported?: boolean;
  /**
   * Accept a forge list up to `STALE_OK_MS` past its TTL while one background
   * refresh runs (src/ttl-cache.ts). Only dashboard page handlers set this;
   * jobs and `/api` paths stay strict.
   */
  staleOk?: boolean;
}

/** The `staleOk` option the PR list and status reads accept from dashboard pages. */
export interface StaleReadOptions {
  /** See {@link ListIssuesOptions.staleOk}. */
  staleOk?: boolean;
}

/**
 * Drop forge issues the imported-refs index resolves to a native id.
 *
 * Applied after the `apiCache` read, not inside it, so both variants share
 * one cache entry. The index already excludes shadows, so a shadowed forge
 * issue — which is live work — is kept.
 */
function withoutImported(repo: string, forgeIssues: Issue[], opts: ListIssuesOptions | undefined): Issue[] {
  if (opts?.includeImported) return forgeIssues;
  return forgeIssues.filter((i) => isNativeIssue(i.number) || !isNativeIssue(resolveImportedRef(repo, i.number)));
}

/**
 * A native-store read that degrades to `[]` on failure.
 *
 * `listOpenIssues`, `listIssuesByLabel` and `listRecentlyClosedIssues` never
 * touched the database before this backend existed; a DB error must not now
 * take down the forge read the caller actually depends on.
 */
async function nativeOrEmpty<T>(label: string, promise: Promise<T[]>): Promise<T[]> {
  try {
    return await promise;
  } catch (err) {
    log.warn(`${label}: native store unavailable (${err})`);
    return [];
  }
}

// ── Labels ──

export async function ensureLabel(
  repo: string,
  label: string,
  overrideSpec?: { color: string; description: string },
): Promise<void> {
  return forgejo.ensureLabel(repo, label, overrideSpec);
}

export async function ensureAllLabels(
  repo: string,
  extraSpecs?: Record<string, { color: string; description: string }>,
): Promise<void> {
  for (const label of Object.keys(LABEL_SPECS)) {
    await ensureLabel(repo, label);
  }
  if (extraSpecs) {
    for (const [label, spec] of Object.entries(extraSpecs)) {
      await ensureLabel(repo, label, spec);
    }
  }
}

export async function listLabels(repo: string): Promise<string[]> {
  return forgejo.listLabels(repo);
}

export async function deleteLabel(repo: string, label: string): Promise<void> {
  return forgejo.deleteLabel(repo, label);
}

export async function deleteStaleLabels(
  repo: string,
  legacyLabels: Set<string>,
): Promise<void> {
  const current = await listLabels(repo);
  // Only delete labels that were previously managed by Claws but are no longer needed
  const stale = current.filter((name) => legacyLabels.has(name));

  for (const label of stale) {
    log.info(`[repo-standards] Deleting stale label "${label}" from ${repo}`);
    await deleteLabel(repo, label);
  }
}

/** Apply one-off label case/name corrections. Skips a rename when the target
 *  name already exists exactly, so it is a no-op after the first successful run. */
export async function applyLabelRenames(
  repo: string,
  renames: Record<string, string>,
): Promise<void> {
  return forgejo.applyLabelRenames(repo, renames);
}

/**
 * Add a label. `forgejo.addLabel` invalidates its cached open-issue list, so a
 * reader inside the 60 s window does not get the pre-write labels back
 * (`/board` renders a column straight out of them).
 */
export async function addLabel(repo: string, issueNumber: IssueRef, label: string): Promise<void> {
  if (isNativeIssue(issueNumber)) return clawsIssues.addLabel(repo, issueNumber, label);
  await forgejo.addLabel(repo, issueNumber, label);
  // Mirror a PR state label into claws_prs (src/pr-state.ts); a no-op for an issue.
  if (isPrStateLabel(label)) await mirrorPrStateLabel(repo, issueNumber, label, "added");
}

/**
 * Move an issue to Blocked with `reason` — the one way Claws parks an issue
 * there, since a native issue refuses a bare Blocked label
 * (`db.BlockedReasonRequiredError`). A native ref moves and records the
 * reason in one write. A forge ref gets the label, then its shadow (when one
 * exists) takes the Blocked stage and the reason now rather than on the next
 * sync, which would stamp a stage change after the reason and hide it.
 */
export async function blockIssue(repo: string, issueNumber: IssueRef, reason: string): Promise<void> {
  if (isNativeIssue(issueNumber)) return clawsIssues.blockIssue(repo, issueNumber, reason);
  if (!reason.trim()) throw new BlockedReasonRequiredError();
  await addLabel(repo, issueNumber, LABELS.blocked);
  const trackerId = await getLinkedNativeId(repo, canonicalIssueRef(issueNumber) ?? issueNumber);
  if (!trackerId) return;
  await setShadowLifecycle(trackerId, "blocked");
  await setIssueBlockedReason(trackerId, reason.trim());
}

/**
 * Set an issue's stored lifecycle — the write that replaced the retired
 * `Ready` label. A native ref moves in one write (`clawsIssues.setLifecycle`);
 * a forge ref moves its shadow, which is where its stage lives, and is a
 * no-op when it has none yet (the dispatcher mints one on first sight).
 */
export async function setIssueLifecycle(repo: string, issueNumber: IssueRef, lifecycle: Exclude<IssueLifecycle, "blocked">): Promise<void> {
  if (isNativeIssue(issueNumber)) return clawsIssues.setLifecycle(repo, issueNumber, lifecycle);
  const trackerId = await getLinkedNativeId(repo, canonicalIssueRef(issueNumber) ?? issueNumber);
  if (!trackerId) {
    log.info(`[github] ${repo}#${issueNumber}: no shadow to move to ${lifecycle}`);
    return;
  }
  await setShadowLifecycle(trackerId, lifecycle);
}

/**
 * The PR state label hook. This is how Claws' own label writes reach the
 * `claws_prs` row — a forge-side label edit never does.
 */
async function mirrorPrStateLabel(repo: string, issueNumber: IssueRef, label: string, verb: "added" | "removed"): Promise<void> {
  if (verb === "added") await applyPrLabelAdded(repo, Number(issueNumber), label);
  else await applyPrLabelRemoved(repo, Number(issueNumber), label);
}

/** Live labels on an issue, bypassing every cache — native or Forgejo. */
export async function getLiveLabels(repo: string, issueNumber: IssueRef): Promise<string[]> {
  if (isNativeIssue(issueNumber)) return (await clawsIssues.getIssueState(issueNumber)).labels;
  return forgejo.fetchLiveLabels(repo, Number(issueNumber));
}

/**
 * Remove a label, returning true only when the label is confirmed absent
 * afterwards.
 *
 * Callers that persist "this label is gone" state must be able to tell a
 * benign no-op (the label was never applied) from a failed removal, so a
 * `false` here means "not confirmed absent"; callers that don't care can keep
 * ignoring the result.
 */
export async function removeLabel(repo: string, issueNumber: IssueRef, label: string): Promise<boolean> {
  if (isNativeIssue(issueNumber)) return clawsIssues.removeLabel(repo, issueNumber, label);
  const removed = await forgejo.removeLabel(repo, issueNumber, label);
  // Mirror a confirmed removal of a PR state label into claws_prs
  // (src/pr-state.ts) — the "never there" exit included, so a stale column
  // converges. A no-op for an issue.
  if (removed && isPrStateLabel(label)) await mirrorPrStateLabel(repo, issueNumber, label, "removed");
  return removed;
}

// ── Issues ──

export interface Issue {
  number: IssueRef;
  title: string;
  body: string;
  labels: { name: string }[];
  author: { login: string };
  /** ISO 8601 creation time; set when the source reports it. */
  createdAt?: string;
  updatedAt?: string;
  /**
   * Set only for native issues: the title the issue was filed under when
   * promotion renamed it (`claws_issues.filed_title`). Alert dedup matches on
   * it so a retitled automation issue is still found.
   */
  filedTitle?: string;
  /**
   * Set only for native issues: when the issue entered its current board
   * column (ISO 8601), or its `updatedAt` for a row that predates the column.
   */
  stageSince?: string;
  /**
   * Set only for native issues: the stored lifecycle, the one way to tell an
   * issue in Ideas from one in Planning, which carry no label. A forge issue's
   * lives on its shadow.
   */
  lifecycle?: IssueLifecycle;
  /**
   * Set only for native issues: how far the issue is approved
   * (`claws_issues.approved_through`, `issue-approval.ts`), who last set it
   * and when (ISO 8601). A forge issue's lives on its shadow.
   */
  approvedThrough?: ApprovedThrough;
  approvedThroughBy?: string;
  approvedThroughAt?: string;
  /**
   * Set only for native issues: every repo the issue names, the primary first
   * and the rest sorted. Discovery views list the issue under each of them.
   */
  repos?: string[];
  /** Set only for native issues: the repo that owns planning, labels and phase sequencing. */
  primaryRepo?: string;
  /**
   * Set only for a native issue `issue-importer` is still assembling
   * (`claws_issues.import_pending`): every dispatcher holds it until the
   * import finishes.
   */
  importPending?: boolean;
}

/**
 * Open issues carrying `label`: the forge's own, followed by the native ones.
 * A forge issue already imported into the native tracker is dropped unless
 * `opts.includeImported` — see {@link ListIssuesOptions}.
 */
export async function listIssuesByLabel(repo: string, label: string, opts?: ListIssuesOptions): Promise<Issue[]> {
  const forgePromise = forgejo.listIssuesByLabel(repo, label);
  const [forgeIssues, nativeIssues] = await Promise.all([
    forgePromise,
    nativeOrEmpty(`listIssuesByLabel ${repo} ${label}`, clawsIssues.listIssuesByLabel(repo, label)),
  ]);
  return [...withoutImported(repo, forgeIssues, opts), ...nativeIssues];
}

/**
 * Open issues marked `claws-duplicate-of:<canonicalNumber>`: the forge's own,
 * followed by the native ones.
 *
 * A union rather than a route, for the same reason as {@link listOpenIssues}:
 * both kinds of issue coexist in one repo, so a *native* issue can be a
 * duplicate of a *forge* one and vice versa. Routing on the target's kind
 * would hide the other half from the merger, and silently — the caller gets a
 * short list, not an error.
 *
 * Run once per {@link issueRefAliases} spelling and de-duplicated by issue
 * number, so a `claws-duplicate-of:<forge number>` marker on an un-migrated
 * issue still resolves after the canonical issue was imported (#3245). An
 * un-imported ref has a one-element alias list and costs exactly one union, as
 * before.
 */
export async function listDuplicateIssuesOf(repo: string, canonicalNumber: IssueRef): Promise<Issue[]> {
  const aliases = issueRefAliases(repo, canonicalNumber);
  if (aliases.length > 1) {
    const byNumber = new Map<IssueRef, Issue>();
    for (const alias of aliases) {
      for (const issue of await listDuplicateIssuesOfRef(repo, alias)) {
        if (!byNumber.has(issue.number)) byNumber.set(issue.number, issue);
      }
    }
    return [...byNumber.values()];
  }
  return listDuplicateIssuesOfRef(repo, aliases[0]!);
}

async function listDuplicateIssuesOfRef(repo: string, canonicalNumber: IssueRef): Promise<Issue[]> {
  const forgePromise = forgejo.listDuplicateIssuesOf(repo, canonicalNumber);
  const [forgeIssues, nativeIssues] = await Promise.all([
    forgePromise,
    nativeOrEmpty(`listDuplicateIssuesOf ${repo} ${canonicalNumber}`, clawsIssues.listDuplicateIssuesOf(repo, canonicalNumber)),
  ]);
  return [...forgeIssues, ...nativeIssues];
}

/**
 * Read an issue's live title and body. Deliberately NOT cached: every caller
 * (the planner's snapshot stamp, the stale-plan gates) needs the current value,
 * not the 60 s-cached `listOpenIssues` copy.
 */
export async function getIssueTitleBody(
  repo: string,
  issueNumber: IssueRef,
): Promise<{ title: string; body: string }> {
  if (isNativeIssue(issueNumber)) return clawsIssues.getIssueTitleBody(issueNumber);
  return forgejo.getIssueTitleBody(repo, issueNumber);
}

export async function getIssueBody(repo: string, issueNumber: IssueRef): Promise<string> {
  if (isNativeIssue(issueNumber)) return clawsIssues.getIssueBody(issueNumber);
  return forgejo.getIssueBody(repo, issueNumber);
}

export async function getIssueBodyHtml(repo: string, issueNumber: IssueRef): Promise<string> {
  if (isNativeIssue(issueNumber)) return clawsIssues.getIssueBodyHtml(issueNumber);
  return forgejo.getIssueBodyHtml(repo, issueNumber);
}

/**
 * An issue's state, spelled the one way every caller can compare against.
 *
 * The backends behind this façade do not agree on the casing — `forgejo.ts`
 * and `claws-issues.ts` upper-case a lower-case column — so a
 * `string` return left every caller to normalise for itself, and one that wrote
 * `=== "closed"` compiled clean and was dead in production. Normalising once
 * here and returning the union makes that comparison a type error instead.
 */
export type IssueState = "OPEN" | "CLOSED";

/**
 * `labels` rides along on the same read. The board's `POST /board/move` needs the
 * issue's live labels and its live state together — to compute the column a move
 * lands in, and to skip the label writes a move does not need — and every backend
 * here already has them in hand at this point, so carrying them costs no extra
 * round trip. Callers that want only the state (`jobs/pr-dispatcher.ts`,
 * `jobs/upstream-watcher.ts`) bind the result into a variable annotated with
 * only `{state, stateReason}` and read `state` off it — a wider return assigns
 * to a narrower annotation, so `labels` is simply invisible there until that
 * annotation widens.
 */
export async function getIssueState(
  repo: string,
  issueNumber: IssueRef,
): Promise<{ state: IssueState; stateReason: string | null; labels: string[] }> {
  const raw = await readIssueState(repo, issueNumber);
  return {
    state: raw.state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
    stateReason: raw.stateReason,
    labels: raw.labels,
  };
}

/** The backends' own spelling of the state, normalised by the caller above. */
async function readIssueState(
  repo: string,
  issueNumber: IssueRef,
): Promise<{ state: string; stateReason: string | null; labels: string[] }> {
  if (isNativeIssue(issueNumber)) return clawsIssues.getIssueState(issueNumber);
  return forgejo.getIssueState(repo, issueNumber);
}

export async function commentOnIssue(repo: string, issueNumber: IssueRef, body: string, opts?: { agentName?: string }): Promise<void> {
  if (isNativeIssue(issueNumber)) {
    await clawsIssues.commentOnIssue(repo, issueNumber, buildClawsCommentBody(body, opts?.agentName), clawsIssues.CLAWS_NATIVE_LOGIN);
    return;
  }
  return forgejo.commentOnIssue(repo, issueNumber, body, opts);
}

/**
 * Post `body` on a PR verbatim — no Claws footer — and answer the new
 * comment's id. For a session's operator feedback (`claws_comment_on_pr`),
 * which the review readers take as human only because its id is recorded as
 * `feedback` in `session_pr_actions`.
 */
export async function postOperatorComment(repo: string, prNumber: number, body: string): Promise<string> {
  return forgejo.postOperatorComment(repo, prNumber, body);
}

export async function editIssue(repo: string, issueNumber: IssueRef, body: string): Promise<void> {
  if (isNativeIssue(issueNumber)) return clawsIssues.editIssue(issueNumber, body);
  return forgejo.editIssue(repo, issueNumber, body);
}

/**
 * Rename an issue. Callers that rename (e.g. ensureAlertIssue's legacy-title
 * migration) then re-read the open-issue list and must not see the stale
 * pre-rename title; the backends invalidate their own cached lists.
 */
export async function editIssueTitle(repo: string, issueNumber: IssueRef, title: string): Promise<void> {
  if (isNativeIssue(issueNumber)) return clawsIssues.editIssueTitle(issueNumber, title);
  return forgejo.editIssueTitle(repo, issueNumber, title);
}

export async function closeIssue(
  repo: string,
  issueNumber: IssueRef,
  stateReason?: "completed" | "not_planned",
): Promise<void> {
  if (isNativeIssue(issueNumber)) return clawsIssues.closeIssue(repo, issueNumber, stateReason);
  return forgejo.closeIssue(repo, issueNumber, stateReason);
}

export interface IssueComment {
  id: CommentRef;
  body: string;
  body_html: string;
  login: string;
  /** Last edit time (Forgejo falls back to the creation time); the Tofu plan evidence reads it. */
  updatedAt?: string;
  /** Posting time (ISO 8601), where the forge gives it; dates feedback against an approval. */
  createdAt?: string;
}

export async function getIssueComments(repo: string, issueNumber: IssueRef): Promise<IssueComment[]> {
  if (isNativeIssue(issueNumber)) return clawsIssues.getIssueComments(issueNumber);
  return forgejo.getIssueComments(repo, issueNumber);
}

/**
 * Every file uploaded to `repo`'s issue/PR `issueNumber` and its comments.
 * GitHub uploads are already inline in the issue body and `body_html`, so this
 * returns nothing for them. Forgejo uploads live in Gitea's `assets` API
 * field instead of markdown/HTML, and a native issue's files live in Claws'
 * own store (#3289) behind site-relative URLs the body regexes deliberately
 * skip — the images pipeline reaches both through this listing.
 */
export async function getIssueAttachments(repo: string, issueNumber: IssueRef): Promise<{ name: string; url: string }[]> {
  if (isNativeIssue(issueNumber)) return clawsIssues.listAttachments(issueNumber);
  return forgejo.getIssueAttachments(repo, issueNumber);
}

export async function editIssueComment(repo: string, commentId: CommentRef, body: string, opts?: { agentName?: string }): Promise<void> {
  if (isNativeComment(commentId)) return clawsIssues.editIssueComment(commentId, buildClawsCommentBody(body, opts?.agentName));
  return forgejo.editIssueComment(repo, commentId, body, opts);
}

// ── Pull Requests ──

export interface PR {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  labels: { name: string }[];
  author: { login: string };
  updatedAt?: string;
  body?: string;
  isCrossRepository?: boolean;
  createdAt?: string;
  isDraft?: boolean;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  /** Head commit SHA; set by `listPRs` (Forgejo: `head.sha`). */
  headRefOid?: string;
}

// Wrapper to allow future expansion (e.g. checking headRepositoryOwner)
export function isForkPR(pr: PR): boolean {
  return pr.isCrossRepository === true;
}

/**
 * Thrown when a PR was created but a label `createPR` was asked to apply is
 * not confirmed in its `claws_prs` row. Two ways there: the retry-induced
 * duplicate path re-applied a forge label that failed, or the row insert
 * itself failed and left a gating label (`Needs LGTM`, `Claws Problematic`) unrecorded even though the forge PR carries it — the
 * merge gate reads the row, not the label. Callers whose label is a safety
 * gate (see `doc-maintainer`'s **Needs LGTM**) must treat this as "an
 * un-gated PR is open" and close it.
 */
export class PRLabelError extends Error {
  constructor(readonly prNumber: number, readonly labels: readonly string[], reason: unknown) {
    super(
      `PR #${prNumber} exists but label(s) ${labels.join(", ")} could not be applied: ` +
      (reason instanceof Error ? reason.message : String(reason)),
    );
    this.name = "PRLabelError";
  }
}

/**
 * Open a PR, optionally with `labels` applied atomically.
 *
 * A label that gates merging must not arrive in a second round trip: the PR is
 * merge-eligible from the instant it exists, and a crash between the two calls
 * leaves it gated by nothing. Both backends therefore apply labels as part of
 * the create itself and fail before opening anything if a label cannot be
 * resolved (#3124).
 */
export async function createPR(
  repo: string,
  head: string,
  title: string,
  body: string,
  opts?: { labels?: readonly string[] },
): Promise<number> {
  const labels = opts?.labels?.filter((l) => l.length > 0) ?? [];
  const prNumber = await createForgePR(repo, head, title, body, labels);
  await recordCreatedPR(repo, prNumber, labels, title);
  return prNumber;
}

/**
 * Give a PR Claws just opened its `claws_prs` row, then mirror the state
 * labels it was created with. Best-effort when nothing gates on the row: a
 * failed insert is logged and seeded by the next dispatcher tick, and never
 * fails the PR. But when a gating label (`Needs LGTM`, `Claws Problematic`)
 * was requested, a failed insert means that label never
 * reaches the row — the dispatcher's seed ignores labels — so it throws
 * {@link PRLabelError} for the caller to treat the same as a labelling
 * failure. Mirroring each label after a successful insert already re-throws
 * for a gating label via {@link applyPrLabelAdded}.
 */
async function recordCreatedPR(repo: string, prNumber: number, labels: readonly string[], title: string): Promise<void> {
  try {
    await upsertClawsPr(repo, prNumber, { stage: "opened", title });
  } catch (err) {
    log.warn(`[pr-state] ${repo}#${prNumber}: could not insert claws_prs row: ${err}`);
    const gating = labels.filter((label) => isGatingLabel(label));
    if (gating.length > 0) throw new PRLabelError(prNumber, gating, err);
    return;
  }
  for (const label of labels) {
    if (isPrStateLabel(label)) await applyPrLabelAdded(repo, prNumber, label);
  }
}

async function createForgePR(
  repo: string,
  head: string,
  title: string,
  body: string,
  labels: readonly string[],
): Promise<number> {
  return forgejo.createPR(repo, head, title, body, labels);
}

/**
 * Open PRs as the forge reports them. Their PR state labels are a write-only
 * mirror — read PR state from the `claws_prs` row (src/pr-state.ts).
 */
export async function listPRs(repo: string, opts?: StaleReadOptions): Promise<PR[]> {
  return forgejo.listPRs(repo, opts);
}

/**
 * Aggregate check status of a PR's head. `held` means a workflow run is waiting
 * for manual approval (zero jobs started) and nothing is genuinely red —
 * blocking, but not a CI failure. Forgejo has no approval hold, so no reader
 * produces `held` today; the state is reserved for one.
 */
export type CheckStatus = "passing" | "failing" | "pending" | "held" | "none";

export interface PRRepoStatus {
  checkStatus: CheckStatus;
  checksPassed: number;
  checksTotal: number;
  /** Checks whose run is held for approval. Always 0: Forgejo has no approval hold. */
  checksHeld: number;
  mergeableState: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  infraPaths?: string[];
  tofuPlan?: TofuPlanSummary;
  tofuPlanState?: TofuPlanState;
  tofuPlanDetail?: string;
  /**
   * The head the Tofu plan evidence was read for. The status is cached, so a
   * reader bound to a particular head checks this before trusting the plan.
   */
  tofuPlanHeadSha?: string;
  /** Every changed file is a provider pin (`versions.tf` / `.terraform.lock.hcl`). */
  infraPinOnly?: boolean;
  /** Forgejo only: the diff passes `providerBumpDiffVerdict`, so the no-op plan exception may apply. */
  infraBumpEligible?: boolean;
  /** Forgejo only: why `providerBumpDiffVerdict` refused the diff. */
  infraBumpHoldReason?: string;
}

/**
 * The body of {@link listPRStatuses}. Gitea has no bulk status read, so the
 * map is assembled from the per-PR Forgejo calls with bounded concurrency. It lives here rather than in
 * forgejo.ts because it needs `infraPathsIn`/`getTofuPlanEvidence`, and forgejo.ts
 * must never value-import this module.
 *
 * `mergeable` is read with a single attempt: this is 60 s-cached dashboard data,
 * and the merge gate reads getPRMergeGate live anyway, so the multi-attempt
 * retry sleep would only stall the page render.
 */
async function listForgejoPRStatuses(repo: string): Promise<Map<number, PRRepoStatus>> {
  const prs = await forgejo.listPRs(repo);
  const out = new Map<number, PRRepoStatus>();
  const settled = await mapSettledWithConcurrency(prs, 4, async (pr) => {
    const [checks, mergeableState, files] = await Promise.all([
      forgejo.getPRChecksSummary(repo, pr.number),
      forgejo.getPRMergeableState(repo, pr.number, 1, 0),
      forgejo.getPRChangedFiles(repo, pr.number),
    ]);
    const infraPaths = infraPathsIn(files);
    const status: PRRepoStatus = {
      checkStatus: checks.status,
      checksPassed: checks.passed,
      checksTotal: checks.total,
      checksHeld: 0,
      mergeableState,
      ...(infraPaths.length > 0 ? { infraPaths } : {}),
    };
    if (infraPaths.length > 0) {
      const [evidence, diff] = await Promise.all([
        getTofuPlanEvidence(repo, pr.number, pr.headRefOid ?? ""),
        forgejo.getPRDiff(repo, pr.number),
      ]);
      const bump = providerBumpDiffVerdict(files, diff);
      Object.assign(status, tofuPlanFields(evidence, files), {
        tofuPlanHeadSha: pr.headRefOid ?? "",
        infraBumpEligible: bump.ok,
        ...(bump.ok ? {} : { infraBumpHoldReason: bump.reason }),
      });
    }
    out.set(pr.number, status);
  });
  for (const [i, result] of settled.entries()) {
    if (result.status === "rejected") {
      log.warn(`listPRStatuses ${repo}#${prs[i]!.number}: ${result.reason}`);
    }
  }
  return out;
}

/** Check + mergeability status for every open PR in a repo, cached for 60 s. */
export async function listPRStatuses(repo: string, opts?: StaleReadOptions): Promise<Map<number, PRRepoStatus>> {
  return apiCache.dedupedFetch(`pr-list-status:${repo}`, 60_000, async () => {
    return listForgejoPRStatuses(repo);
  }, staleOpts(opts?.staleOk)) as Promise<Map<number, PRRepoStatus>>;
}

/**
 * The branch Claws opens a PR from for `issueNumber`, as a prefix.
 *
 * Canonicalised, unlike the routing predicates' input: git branch names are
 * case-sensitive and the branch is cut with the canonical uppercase ULID body,
 * so a lower-cased `clw_…` ref would build a prefix matching no branch — and
 * `getOpenPRForIssue` returning null reads as "no work in flight", which
 * dispatches a second implementer for an issue that already has an open PR.
 */
function issueBranchPrefix(issueNumber: IssueRef): string {
  return `claws/issue-${canonicalIssueRef(issueNumber) ?? issueNumber}-`;
}

/**
 * Merged PRs cut from `issueNumber`'s branch.
 *
 * Forge-first with no native branch, deliberately: a Claws-native issue's PRs
 * still live on the forge, and the branch prefix identifies them there just as
 * well as for a forge issue.
 *
 * Queried once per {@link issueRefAliases} spelling and de-duplicated by PR
 * number, preserving alias order: the phases of an issue imported between
 * steps landed on `claws/issue-<forge number>-` branches, and only the alias
 * finds them (#3245). An un-imported ref yields one alias and exactly one
 * query, as before.
 */
export async function listMergedPRsForIssue(repo: string, issueNumber: IssueRef): Promise<PR[]> {
  const aliases = issueRefAliases(repo, issueNumber);
  if (aliases.length > 1) {
    const byNumber = new Map<number, PR>();
    for (const alias of aliases) {
      for (const pr of await listMergedPRsForRef(repo, alias)) {
        if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr);
      }
    }
    return [...byNumber.values()];
  }
  return listMergedPRsForRef(repo, aliases[0]!);
}

async function listMergedPRsForRef(repo: string, issueNumber: IssueRef): Promise<PR[]> {
  return forgejo.listMergedPRsForIssue(repo, issueNumber);
}

/**
 * The open PR cut from `issueNumber`'s branch. Forge-first, as
 * {@link listMergedPRsForIssue}.
 *
 * Every {@link issueRefAliases} spelling is accepted, so an in-flight PR cut
 * before an import — on a `claws/issue-<forge number>-` branch — is still
 * visible under the native id. "No PR" reads to the dispatcher as "no work in
 * flight", which starts a second implementer (#3245).
 */
export async function getOpenPRForIssue(repo: string, issueNumber: IssueRef): Promise<PR | null> {
  const aliases = issueRefAliases(repo, issueNumber);
  for (const alias of aliases) {
    const pr = await forgejo.getOpenPRForIssue(repo, alias);
    if (pr) return pr;
  }
  return null;
}

/**
 * Every open PR cut from `issueNumber`'s branch — a multi-PR plan whose steps
 * run in parallel has several at once. Aliases as {@link getOpenPRForIssue},
 * canonical ref's PRs first.
 *
 * Filters the open-PR list by branch prefix rather than routing through
 * `forgejo.getOpenPRForIssue` — that helper is `prs.find(...)` and so returns
 * at most one PR per alias, which hid a sibling parallel-phase PR. `listPRs` is the same 60 s-cached list that helper
 * already reads, so this adds no extra cost.
 */
export async function listOpenPRsForIssue(repo: string, issueNumber: IssueRef): Promise<PR[]> {
  const aliases = issueRefAliases(repo, issueNumber);
  const prs = await listPRs(repo);
  const out: PR[] = [];
  for (const prefix of aliases.map(issueBranchPrefix)) {
    for (const pr of prs) {
      if (pr.headRefName.startsWith(prefix) && !out.some((p) => p.number === pr.number)) out.push(pr);
    }
  }
  return out;
}

export interface CrossRefPR {
  number: number;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
  login: string;
  /** ISO 8601 creation time, when the source reports one — a design change's coverage fence reads it. */
  createdAt?: string;
}

/**
 * "Does this PR body mention `ref`?", for the native cross-reference scan.
 *
 * A native id is distinctive enough to match as a bare lower-cased substring,
 * as it always has. A *forge number* alias is not — a bare `7` appears in every
 * other body — so it needs the `#`, a trailing digit boundary (or `#7` would
 * also be found inside `#70`) and a *leading* one: without it
 * `St-John-Software/other-repo#7` reads as this repo's `#7`, and the native
 * branch below scans every PR body in the repo.
 */
function refBodyMatcher(ref: IssueRef): (body: string | null | undefined) => boolean {
  if (typeof ref === "number") {
    const re = new RegExp(`(?<![\\w/-])#${ref}(?!\\d)`);
    return (body) => re.test(body ?? "");
  }
  const needle = ref.toLowerCase();
  return (body) => (body ?? "").toLowerCase().includes(needle);
}

/**
 * Every PR that cross-references an issue — any author, any branch, in this
 * repo — via the issue timeline. Unlike `listMergedPRsForIssue` /
 * `getOpenPRForIssue`, which only see `claws/issue-<N>-` branches, this is what
 * makes hand-rolled PRs for a multi-PR plan visible to phase accounting (#2594).
 *
 * Never throws: any failure returns `[]` so callers degrade to branch-prefix
 * accounting rather than stalling the pipeline.
 */
export async function listPRsCrossReferencingIssue(repo: string, issueNumber: IssueRef): Promise<CrossRefPR[]> {
  // The forge has no timeline for a native issue, so the cross-reference is
  // found by scanning this repo's PR bodies for the id instead. Closed-unmerged
  // PRs are deliberately not scanned: nothing downstream acts on them, and
  // Forgejo offers no one cheap "all states" read. Lower-cased on both
  // sides — an agent may have written "#clw_01jbq…".
  //
  // The merged half comes from Forgejo's indexed issue search, one query per
  // alias, instead of a repo-wide walk of closed PRs: that walk re-read every
  // closed-PR page each minute and pinned Forgejo at its CPU limit
  // (#clw_01M63XPT6DFETCV8RWS0KTMD3X). The search is fuzzy, so every hit is
  // re-checked with `refBodyMatcher`. It is still **best-effort enrichment for
  // hand-rolled branches only**, and must not be read as the record of what
  // landed: the durable records are the ones `loadPhaseCoverage` unions in
  // beside this — the issue-scoped list from `listMergedPRsForIssue`, and the
  // `claws-phase-done:` markers on the issue itself. Do not remove either on
  // the strength of this scan.
  //
  // Cached with the same key and TTL as the forge branch below — `loadPhaseCoverage`
  // runs per multi-phase issue per dispatcher tick.
  if (isNativeIssue(issueNumber)) {
    // Every alias, so a PR opened before the import — whose body still says
    // `Part of #<forge number>` — is still cross-referenced from the native id
    // (#3245).
    const aliases = issueRefAliases(repo, issueNumber);
    const matchers = aliases.map(refBodyMatcher);
    const matches = (body: string | null | undefined): boolean => matchers.some((m) => m(body));
    return apiCache.dedupedFetch(`issue-xrefs:${repo}:${issueNumber}`, 60_000, async () => {
      try {
        const [open, ...searched] = await Promise.all([
          listPRs(repo),
          ...aliases.map((alias) => forgejo.searchClosedPulls(repo, String(alias))),
        ]);
        const byNumber = new Map<number, CrossRefPR>();
        for (const pr of open) {
          // A disposable issue preview (`claws/preview-issue-<id>`) may name
          // the id in plain text; it is never the issue's implementation PR.
          if (issueRefFromPreviewBranch(pr.headRefName) !== null) continue;
          if (matches(pr.body)) byNumber.set(pr.number, { number: pr.number, title: pr.title, body: pr.body ?? "", state: "open", login: pr.author.login, ...(pr.createdAt ? { createdAt: pr.createdAt } : {}) });
        }
        for (const hit of searched.flat()) {
          // A merged verdict wins over an open one: `listPRs` is 60 s-cached and
          // may still be showing a PR that landed since.
          if (hit.pull_request?.merged === true && matches(hit.body)) {
            byNumber.set(hit.number, { number: hit.number, title: hit.title, body: hit.body ?? "", state: "merged", login: hit.user?.login ?? "" });
          }
        }
        return [...byNumber.values()];
      } catch (err) {
        log.warn(`listPRsCrossReferencingIssue ${repo}#${issueNumber}: ${err}`);
        return [];
      }
    }) as Promise<CrossRefPR[]>;
  }
  return forgejo.listPRsCrossReferencingIssue(repo, issueNumber);
}

/**
 * When `repo#ref` was last reopened, or null if it never was. Null for a
 * native issue (no reopen-event source). Uncached; throws on a failed read.
 */
export async function getLastReopenedAt(repo: string, ref: IssueRef): Promise<string | null> {
  if (isNativeIssue(ref)) return null;
  return forgejo.getLastReopenedAt(repo, Number(ref));
}

export async function getPRMergeableState(
  repo: string,
  prNumber: number,
  maxAttempts = 5,
  delayMs = 3000,
): Promise<"MERGEABLE" | "CONFLICTING" | "UNKNOWN"> {
  return forgejo.getPRMergeableState(repo, prNumber, maxAttempts, delayMs);
}

/** Live PR state used as the final gate immediately before an auto-merge. */
export interface PRMergeGate {
  state: string;                    // "OPEN" | "CLOSED" | "MERGED"
  headSha: string;
  /** The base branch's current tip (Forgejo `base.sha`); "" when not reported. */
  baseSha: string;
  labels: string[];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checkStatus: CheckStatus;
  checksTotal: number;
  /** Checks held in GitHub's `action_required` state (always 0 on Forgejo). */
  checksHeld: number;
}

/**
 * Read the merge-relevant PR state (labels, head SHA, check rollup, mergeability)
 * in one uncached call. `labels` serve routing/parking checks only; PR state
 * comes from the `claws_prs` row. Deliberately bypasses `apiCache` — the auto-merger runs
 * seconds after other agents mutate the PR, and a stale snapshot is what merged a
 * red PR in #2354.
 */
export async function getPRMergeGate(repo: string, prNumber: number): Promise<PRMergeGate> {
  return forgejo.getPRMergeGate(repo, prNumber);
}

/** ISO commit-date of `sha`, or null when unreadable. Used to tell "this repo has
 *  no CI" from "CI for a just-pushed head has not registered yet". */
export async function getCommitCommittedAt(repo: string, sha: string): Promise<string | null> {
  return forgejo.getCommitCommittedAt(repo, sha);
}

/**
 * Decide whether a check status of `"none"` can be believed. A brand-new head
 * SHA has no check runs registered for the first minute or two, so reading
 * `"none"` as "this repo has no CI" races the workflow trigger — that is how
 * #2354 merged a red PR. Returns `settled: false` while the head commit is
 * still inside the settle window, or when its age can't be determined at all
 * (fail closed); `age` is a human-readable string for the caller's log line.
 */
export async function haveChecksSettled(repo: string, sha: string): Promise<{ settled: boolean; age: string }> {
  return forgejo.haveChecksSettled(repo, sha);
}

export { isCiExemptPath };

/** How long a `repoExpectsCi` answer is reused before the workflow dirs are re-listed. */
const REPO_EXPECTS_CI_TTL_MS = 10 * 60 * 1000;
const repoExpectsCiCache = new Map<string, { value: boolean; at: number }>();

/** Exposed for tests. */
export function clearRepoExpectsCiCache(): void {
  repoExpectsCiCache.clear();
}

/**
 * Whether this repo's CI is expected to report on PR heads, so a head with no
 * statuses or check runs means "CI has not reported", not "there is no CI".
 * False when `claws.json` sets `mergeWithoutChecks`; otherwise true when the
 * default branch has a `.yml`/`.yaml` under `.forgejo/workflows/` or
 * `.github/workflows/`. A read error answers true (fail closed) and is not cached.
 */
export async function repoExpectsCi(repo: string): Promise<boolean> {
  if (getRepoConfig(repo)?.mergeWithoutChecks) return false;
  const key = repo.toLowerCase();
  const hit = repoExpectsCiCache.get(key);
  if (hit && Date.now() - hit.at < REPO_EXPECTS_CI_TTL_MS) return hit.value;
  try {
    let value = false;
    for (const dir of [".forgejo/workflows", ".github/workflows"]) {
      const entries = await listRepoDirectory(repo, dir);
      if (entries.some((e) => e.type === "file" && /\.ya?ml$/i.test(e.name))) {
        value = true;
        break;
      }
    }
    repoExpectsCiCache.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    log.warn(`repoExpectsCi ${repo}: ${err}`);
    return true;
  }
}

/**
 * Check status of the newest commit in this PR that actually ran CI, provided
 * every commit from the head down to it changes only CI-exempt paths — so the
 * code content those checks validated is the code content at the head (#2929).
 * Returns "none" when the walk can't prove that, including on any read failure.
 */
export async function carriedForwardCheckStatus(
  repo: string,
  prNumber: number,
): Promise<CheckStatus> {
  return forgejo.carriedForwardCheckStatus(repo, prNumber);
}

// ── Checks ──

export async function getPRCheckStatus(
  repo: string,
  prNumber: number,
): Promise<CheckStatus> {
  return forgejo.getPRCheckStatus(repo, prNumber);
}

export async function getPRChecksSummary(
  repo: string,
  prNumber: number,
): Promise<{ status: CheckStatus; passed: number; total: number }> {
  return forgejo.getPRChecksSummary(repo, prNumber);
}

export async function getPRReviewStatus(
  repo: string,
  prNumber: number,
  opts?: StaleReadOptions,
): Promise<{ status: "clean" | "issues" | "escalated" | "none"; issueCount: number; reviewedCommit: string | null }> {
  return forgejo.getPRReviewStatus(repo, prNumber, opts);
}

export async function updatePR(repo: string, prNumber: number, body: string, title?: string): Promise<void> {
  return forgejo.updatePR(repo, prNumber, body, title);
}

/**
 * Squash-merge a PR. When `expectedHeadSha` is supplied the merge is pinned to
 * that commit via `--match-head-commit`, so GitHub rejects it if the head moved
 * between evaluation and merge (#2354).
 */
export async function mergePR(repo: string, prNumber: number, expectedHeadSha?: string): Promise<void> {
  return forgejo.mergePR(repo, prNumber, expectedHeadSha);
}

/** Drop the cached open-PR list for `repo` so the next `listPRs` re-reads it. */
export function invalidatePRList(repo: string): void {
  forgejo.invalidatePRList(repo);
}

export async function closePR(repo: string, prNumber: number): Promise<void> {
  return forgejo.closePR(repo, prNumber);
}

// ── Reactions ──

export async function addReaction(repo: string, commentId: CommentRef, reaction: string): Promise<void> {
  if (isNativeComment(commentId)) return clawsIssues.addReaction(commentId, clawsIssues.CLAWS_NATIVE_LOGIN, reaction);
  return forgejo.addReaction(repo, commentId, reaction);
}

export async function addReviewCommentReaction(repo: string, commentId: number, reaction: string): Promise<void> {
  return forgejo.addReviewCommentReaction(repo, commentId, reaction);
}

export interface Reaction {
  id: number;
  user: { login: string };
  content: string;
}

export async function getCommentReactions(repo: string, commentId: CommentRef): Promise<Reaction[]> {
  if (isNativeComment(commentId)) return clawsIssues.getCommentReactions(commentId);
  return forgejo.getCommentReactions(repo, commentId);
}

/**
 * Reactions on a pull-request *review* comment. Review-comment IDs live in a
 * different namespace from issue-comment IDs, so this cannot share
 * getCommentReactions' `issues/comments/...` endpoint or its cache key (#2265).
 */
export async function getReviewCommentReactions(repo: string, commentId: number): Promise<Reaction[]> {
  return forgejo.getReviewCommentReactions(repo, commentId);
}

export async function listCompareCommits(
  repo: string,
  base: string,
  head: string,
): Promise<{ sha: string; subject: string }[]> {
  return forgejo.listCompareCommits(repo, base, head);
}

export interface PRReviewData {
  formatted: string;
  commentIds: number[];
  reviewCommentIds: number[];
  /** HTML bodies for all comments in formatted — used for image-URL extraction only; not passed to the model. */
  htmlBodies: string[];
  /** The Claws PR review comment needing addressing, if any. */
  prReviewComment?: { id: number; body: string; reviewedCommit: string };
  /** True when the ONLY work in `formatted` is an advisory-only Claws review. */
  advisoryOnly?: boolean;
}

/**
 * Collect the outstanding review work for a PR.
 *
 * Advisory-only Claws reviews are skipped by default — they exist to break nit
 * ping-pong. Pass `includeAdvisory` to surface one anyway (see pr-dispatcher
 * Phase 3, which does this only while the PR is Ready-idle); the result then
 * carries `advisoryOnly: true` and any review already stamped
 * `advisory-addressed: <sha>` stays skipped, so advisory nits get at most one
 * fix round per PR.
 */
export async function getPRReviewComments(
  repo: string,
  prNumber: number,
  opts: { includeAdvisory?: boolean } = {},
): Promise<PRReviewData> {
  return forgejo.getPRReviewComments(repo, prNumber, opts);
}

export interface PRReviewNote {
  login: string;
  body: string;
  path?: string;
  line?: number | null;
}

/**
 * Raw human-readable review bodies and inline review comments for intent capture.
 * Resolved threads are deliberately NOT filtered — a resolved thread's owner comment
 * is still a statement of intent. Caller does author filtering.
 * Rejects on fetch failure; callers are expected to isolate/log that themselves.
 */
export async function getPRReviewNotes(repo: string, prNumber: number): Promise<PRReviewNote[]> {
  return forgejo.getPRReviewNotes(repo, prNumber);
}

export interface FailedCheck {
  name: string;
  state: string;
  link: string;
}

export async function getFailingCheck(repo: string, prNumber: number): Promise<FailedCheck | undefined> {
  return forgejo.getFailingCheck(repo, prNumber);
}

/** One check on a PR's head, classified into the buckets `getPRCheckStatus` aggregates. */
export interface PRCheck {
  name: string;
  state: string;
  outcome: "passing" | "failing" | "pending" | "held";
  link: string;
}

/**
 * Every check on a PR's head, uncached; `[]` when the PR has no checks.
 * Unlike {@link getFailingCheck}, read errors other than "no checks" propagate.
 */
export async function listPRChecks(repo: string, prNumber: number): Promise<PRCheck[]> {
  return forgejo.listPRChecks(repo, prNumber);
}

export async function rerunWorkflow(repo: string, runId: string): Promise<void> {
  return forgejo.rerunWorkflow(repo, runId);
}

export interface RunJobSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  stepCount: number;
  failedSteps: string[];
  runnerName?: string | null;
  labels?: string[];
  startedAt?: string | null;
  completedAt?: string | null;
}

/**
 * Jobs of a run with their recorded step counts. Returns [] on any failure so
 * callers fall back to normal failure handling rather than mis-classifying.
 * Cached briefly: identifyPRWork asks for the same run from the classification
 * phase, the CI_FIXER handler and the CI_FIXER_RERUN sweep within one cycle.
 */
export async function getRunJobSummaries(repo: string, runId: string): Promise<RunJobSummary[]> {
  return forgejo.getRunJobSummaries(repo, runId);
}

/**
 * A job that failed or was cancelled without recording a single step never ran user
 * code — the runner went away mid-job (registration purge, nixos-rebuild, host reboot).
 * This is an infrastructure outcome, not a PR failure.
 */
export function isInfrastructureOutage(jobs: RunJobSummary[]): boolean {
  const bad = jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "cancelled");
  return bad.length > 0 && bad.every((j) => j.stepCount === 0);
}

/**
 * Steps GitHub runs before the workflow's own code, plus the source fetch
 * (Forgejo names its checkout step after the action URL, `https://github.com/actions/checkout@v4`). A failure
 * confined to these never exercised the PR's diff. Also consulted on the normal
 * (non-degraded) path — there a mis-match costs at most INFRA_MAX_RERUNS (3) wasted
 * re-runs before isInfraRerunExhausted sends the run down the normal fix path.
 */
const PRE_REPO_STEP_RE =
  /^(?:(?:set up job|set up runner|complete job|checkout|post checkout|run actions\/checkout|post run actions\/checkout)\b|(?:post )?https?:\/\/\S*\/actions\/checkout@)/i;

/**
 * True when every failed/cancelled job died before any repo-owned step ran — either
 * with no recorded steps at all, or with failures confined to GitHub's own setup and
 * checkout steps. A bad job with steps but no recorded failed step returns false
 * (conservative: we can't prove the diff wasn't exercised).
 */
export function isPreRepoStepFailure(jobs: RunJobSummary[]): boolean {
  const bad = jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "cancelled");
  if (bad.length === 0) return false;
  return bad.every(
    (j) =>
      j.stepCount === 0 ||
      (j.failedSteps.length > 0 && j.failedSteps.every((s) => PRE_REPO_STEP_RE.test(s.trim()))),
  );
}

function formatJobDuration(startedAt: string | null | undefined, completedAt: string | null | undefined): string {
  if (!startedAt || !completedAt) return "";
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

/**
 * Human-readable description of every failed/cancelled job that recorded zero steps,
 * e.g. `job "deploy" produced no logs: 0 steps, failure after 10 min on self-hosted
 * runner "nas" [container, linux]`, joined with `; `. Such a job never ran user code
 * and has no log to read, so callers name it (and its runner) instead of reporting a
 * bare "no log". Returns "" when there is none.
 */
export function describeSteplessJobs(jobs: RunJobSummary[]): string {
  return jobs
    .filter((j) => (j.conclusion === "failure" || j.conclusion === "cancelled") && j.stepCount === 0)
    .map((j) => {
      const duration = formatJobDuration(j.startedAt, j.completedAt);
      let text = `job "${j.name}" produced no logs: 0 steps, ${j.conclusion}${duration ? ` after ${duration}` : ""}`;
      if (j.runnerName) {
        const labels = j.labels ?? [];
        const kind = labels.some((l) => l === "self-hosted" || l === "container" || l === "host") ? "self-hosted runner" : "runner";
        text += ` on ${kind} "${j.runnerName}"${labels.length > 0 ? ` [${labels.join(", ")}]` : ""}`;
      }
      return text;
    })
    .join("; ");
}

/**
 * Re-runs only the failed jobs of a run — much cheaper than a full rerun on a
 * two-runner pool.
 */
export async function rerunFailedJobs(repo: string, runId: string): Promise<void> {
  return forgejo.rerunFailedJobs(repo, runId);
}

/** Forgejo run statuses a session may re-run the failed jobs of. */
const SESSION_RERUNNABLE_FORGEJO = new Set(["failure", "cancelled"]);

/**
 * The newest finished CI run on `headSha` that failed, or null. The id is
 * the Forgejo run number in `/actions/runs/<n>` — the same `run` a session passes to `claws_rerun_failed_ci`.
 */
export async function findLatestFailedRun(repo: string, headSha: string): Promise<number | null> {
  const runs = await forgejo.listActionRunsForSha(repo, headSha);
  return runs.find((r) => SESSION_RERUNNABLE_FORGEJO.has(r.status) && r.index !== null)?.index ?? null;
}

/**
 * Whether `run` (as {@link findLatestFailedRun} names it) ran on `headSha`.
 * A run on an older commit is refused: re-running it would not change the PR's checks.
 */
export async function isRunOnCommit(repo: string, run: number, headSha: string): Promise<boolean> {
  return (await forgejo.listActionRunsForSha(repo, headSha)).some((r) => r.index === run);
}

/**
 * Re-run only the failed jobs of `run` for an interactive session's
 * `claws_rerun_failed_ci` — unlike {@link rerunFailedJobs}, this really re-runs
 * on Forgejo, through the image's re-run patch, and reports which jobs went.
 */
export async function rerunFailedJobsForSession(repo: string, run: number): Promise<{ run: number; jobs: string[] }> {
  const res = await forgejo.rerunFailedJobsByIndex(repo, run);
  return { run: res.run.index, jobs: res.jobs.map((j) => j.name) };
}

export async function getRunAnnotations(repo: string, runId: string): Promise<string[]> {
  return forgejo.getRunAnnotations(repo, runId);
}

export async function getFailedRunLog(repo: string, prNumber: number): Promise<string> {
  return forgejo.getFailedRunLog(repo, prNumber);
}

// ── PR changed files ──

/**
 * Infrastructure-as-code paths: an OpenTofu/Terraform change is never
 * auto-merged (#2275). A plan comment is spoofable and absent whenever the
 * plan job failed, and a workflow that runs tofu can apply infra with no .tf
 * file changing (production-infra#841), so this path test — not the plan — is
 * the gate. The one narrow exception: a PR whose diff is a provider bump — any
 * PR passing `providerBumpDiffVerdict` — and whose plan for the exact head is a verified no-op (`getTofuPlanEvidence`) —
 * see auto-merger's `tryMerge`.
 * A workflow or action under `.github/` or `.forgejo/` whose path names tofu or
 * terraform (case-insensitive) counts as infra.
 */
export function isInfraPath(p: string): boolean {
  return /(?:^|\/)(?:tofu|terraform)\//.test(p)
    || /\.(?:tf|tfvars)(?:\.json)?$/.test(p)
    || /(?:^|\/)\.terraform\.lock\.hcl$/.test(p)
    // A workflow/action under .github/ or .forgejo/ that runs tofu can apply infra with no
    // .tf file changing (#841). production-infra's .forgejo/workflows/tofu-apply.yml is
    // push-triggered on its own path, so a merged edit applies prod immediately.
    || /(?:^|\/)\.(?:github|forgejo)\/(?:workflows|actions)\/.*(?:tofu|terraform)/i.test(p);
}

/** Infra-relevant subset of a changed-file list (empty when the PR touches no infra). */
export function infraPathsIn(files: string[]): string[] {
  return files.filter(isInfraPath);
}

export type { TofuPlanSummary } from "./tofu-plan.js";

/** The newest github-actions[bot] plan comment on the PR, in either repo's format. */
async function latestTofuPlanComment(repo: string, prNumber: number): Promise<IssueComment | undefined> {
  const comments = await getIssueComments(repo, prNumber);
  return [...comments].reverse().find((x) => x.login === "github-actions[bot]" && isTofuPlanComment(x.body));
}

/**
 * Parse the plan comment the repo's tofu-plan-on-pr.yml posts — production-infra's
 * redacted counts line or bstjohn-blog's raw `tofu plan` text. DISPLAY ONLY — an
 * issue comment is spoofable and absent whenever the plan job failed; the merge
 * gate reads {@link getTofuPlanEvidence}, which ties it to the head's plan run.
 */
export async function getTofuPlanSummary(repo: string, prNumber: number): Promise<TofuPlanSummary | null> {
  try {
    const c = await latestTofuPlanComment(repo, prNumber);
    return c ? parseTofuPlanBody(c.body) : null;
  } catch { return null; }
}

/** `noop`/`changes` only for a plan verified against the head's own plan run. */
export type TofuPlanState = "noop" | "changes" | "unavailable";

export interface TofuPlanEvidence {
  plan: TofuPlanSummary | null;
  state: TofuPlanState;
  detail: string;
}

/**
 * The Tofu plan for `headSha`, tied to the repo's own plan workflow. The
 * github-actions[bot] plan comment counts only when it was last edited inside
 * the window of the newest `Tofu Plan` run on exactly `headSha`, and that run
 * completed with conclusion `success` — both repos' workflows post the comment
 * mid-run, so a comment from an older head or an earlier run falls outside it.
 * On Forgejo, whose run records are not bound to a head the same way, the
 * marker comment by any author (the workflow posts it with a user token) counts
 * when it was last edited at or after the head commit's committer date and the
 * head carries a passing `Tofu Plan /` status; see {@link forgejoTofuPlanEvidence}.
 * Every state that cannot be established — no comment, an unparseable body, no
 * run, a failed/cancelled/running run, any API error — is `unavailable`, so the
 * caller fails closed.
 */
export async function getTofuPlanEvidence(repo: string, prNumber: number, headSha: string): Promise<TofuPlanEvidence> {
  const unavailable = (detail: string, plan: TofuPlanSummary | null = null): TofuPlanEvidence => ({ plan, state: "unavailable", detail });
  if (!headSha) return unavailable("head commit unknown");
  return forgejoTofuPlanEvidence(repo, prNumber, headSha);
}

/**
 * Forgejo half of {@link getTofuPlanEvidence}: the `<!-- tofu-plan -->`-style
 * marker comment with the newest `updatedAt`, whoever posted it (the workflow
 * PATCHes one comment in place, so only `updatedAt` moves after a push). It
 * counts only when edited at or after the head commit's committer date and a
 * `Tofu Plan /` status on the PR's head is passing. A forged comment is outside
 * the threat model; these guards keep the plan current and fail closed.
 */
async function forgejoTofuPlanEvidence(repo: string, prNumber: number, headSha: string): Promise<TofuPlanEvidence> {
  const unavailable = (detail: string, plan: TofuPlanSummary | null = null): TofuPlanEvidence => ({ plan, state: "unavailable", detail });
  try {
    const comment = (await getIssueComments(repo, prNumber))
      .filter((c) => isTofuPlanComment(c.body))
      .reduce<IssueComment | undefined>((best, c) => (!best || Date.parse(c.updatedAt ?? "") > Date.parse(best.updatedAt ?? "") ? c : best), undefined);
    if (!comment) return unavailable("no plan comment");
    const plan = parseTofuPlanBody(comment.body);
    if (!plan) return unavailable("plan comment is not parseable");
    const committedAt = await getCommitCommittedAt(repo, headSha);
    const committed = committedAt ? Date.parse(committedAt) : NaN;
    if (Number.isNaN(committed)) return unavailable("head commit date unknown", plan);
    const edited = comment.updatedAt ? Date.parse(comment.updatedAt) : NaN;
    if (!(edited >= committed)) return unavailable("plan comment predates the head commit", plan);
    const checks = (await forgejo.listPRChecks(repo, prNumber)).filter((c) => c.name.startsWith(`${TOFU_PLAN_WORKFLOW_NAME} /`));
    if (checks.length === 0) return unavailable("no Tofu Plan check on this head", plan);
    const notPassing = checks.find((c) => c.outcome !== "passing");
    if (notPassing) return unavailable(`Tofu Plan check is ${notPassing.state.toLowerCase()}`, plan);
    if (isNoOpPlan(plan)) return { plan, state: "noop", detail: "no-op plan" };
    const n = tofuPlanChangeCount(plan);
    return { plan, state: "changes", detail: `plan shows ${n} change${n === 1 ? "" : "s"}` };
  } catch (err) {
    log.warn(`getTofuPlanEvidence for PR #${prNumber} in ${repo}: ${err}`);
    return unavailable("plan evidence could not be read");
  }
}

/** The dashboard fields an infra PR's plan evidence and changed files contribute. */
function tofuPlanFields(e: TofuPlanEvidence, files: string[]): Pick<PRRepoStatus, "tofuPlan" | "tofuPlanState" | "tofuPlanDetail" | "infraPinOnly"> {
  return {
    ...(e.plan ? { tofuPlan: e.plan } : {}),
    tofuPlanState: e.state,
    tofuPlanDetail: e.detail,
    infraPinOnly: isInfraPinOnly(files),
  };
}

export async function getPRChangedFiles(repo: string, prNumber: number): Promise<string[]> {
  return forgejo.getPRChangedFiles(repo, prNumber);
}

export async function getPRDiff(repo: string, prNumber: number): Promise<string> {
  return forgejo.getPRDiff(repo, prNumber);
}

/** The PR's commits with their parent SHAs and subject lines. Throws on a failed read. */
export async function listPRCommits(repo: string, prNumber: number): Promise<{ sha: string; parents: string[]; subject: string }[]> {
  return forgejo.listPRCommits(repo, prNumber);
}

/**
 * The commits in `base...head` with the files each changes; null when `base`
 * or `head` is not on the repo (Forgejo 404). Any other failure throws.
 */
export async function listCompareChangedFiles(
  repo: string,
  base: string,
  head: string,
): Promise<{ totalCommits: number; commits: { sha: string; files: string[] }[] } | null> {
  return forgejo.listCompareChangedFiles(repo, base, head);
}

/** The unified diff one commit introduces. Throws on a failed read. */
export async function getCommitDiff(repo: string, sha: string): Promise<string> {
  return forgejo.getCommitDiff(repo, sha);
}

export async function getPRHeadSHA(repo: string, prNumber: number): Promise<string> {
  return forgejo.getPRHeadSHA(repo, prNumber);
}

// Fetch a PR's state ("OPEN" | "CLOSED" | "MERGED"). Returns null when the PR
// does not exist (404), so callers can treat it as "no PR".
export async function getPRState(repo: string, prNumber: number): Promise<string | null> {
  return forgejo.getPRState(repo, prNumber);
}

export interface UpstreamPRStatus {
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  title: string;
  url: string;
  updatedAt: string;
}

/**
 * Merge status of a PR in an arbitrary (possibly externally-owned) repo, read
 * through the REST API so it works for repos with no App installation. Returns
 * null when the PR does not exist (404/403). (#2617)
 *
 * `title` is third-party text — guard it before embedding it anywhere an agent
 * will later read.
 */
export async function getUpstreamPRStatus(repo: string, prNumber: number): Promise<UpstreamPRStatus | null> {
  return forgejo.getUpstreamPRStatus(repo, prNumber);
}

// Live re-verification of a PR's diff stats, bypassing the 60s `pr-list` cache.
// Returns null when the PR does not exist (404).
export async function getPRDiffStats(
  repo: string,
  prNumber: number,
): Promise<{ changedFiles: number; additions: number; deletions: number; state: string } | null> {
  return forgejo.getPRDiffStats(repo, prNumber);
}

export async function getPRBody(repo: string, prNumber: number): Promise<string> {
  return forgejo.getPRBody(repo, prNumber);
}

export function getLinkedIssueNumber(pr: PR): IssueRef | null {
  return linkedIssueRefFromPR(pr);
}

// ── Recently closed issues ──

export interface ClosedIssueSummary {
  number: IssueRef;
  title: string;
  body: string;
  closedAt: string;
  updatedAt: string;
  author: string;
}

/**
 * Recently closed issues for `repo`: the forge's own, plus the Claws-native
 * issues closed since `since` whose primary repository is this one.
 *
 * The two halves are **merged by `closedAt` and then cut to `limit`**, not
 * concatenated: a caller that walks the list and stops early (`doc-maintainer`
 * breaks at ten plans) would otherwise never reach a native issue behind a
 * full window of forge ones, which is exactly the "no job knows the
 * difference" property this façade exists to hold.
 *
 * `repo` and `limit` are pushed into the native query rather than applied
 * here, so the cost tracks the result set rather than every issue Claws has
 * ever closed. The native read runs concurrently with the forge round trip,
 * as in {@link listOpenIssues}, and degrades to `[]` on a database error.
 *
 * The merge compares *parsed instants*, not strings: the three sources do not
 * agree on format — `clawsIssues.toIso` emits `…T00:00:00.000Z` and Forgejo passes Gitea's RFC3339 through with whatever
 * offset it carries — so a lexical compare would order `…T09:00:00+02:00`
 * ahead of the later `…T08:00:00.000Z` and cut the wrong issues.
 */
export async function listRecentlyClosedIssues(
  repo: string,
  since: Date | null,
  limit = 100,
): Promise<ClosedIssueSummary[]> {
  const nativePromise = nativeOrEmpty(
    `listRecentlyClosedIssues ${repo}`,
    clawsIssues.listClosedIssuesSince(repo, since ?? new Date(0), limit),
  ).then((issues): ClosedIssueSummary[] => issues.map((i) => ({
    number: i.id,
    title: i.title,
    // `closed_at` is never null here — the store filters on it — but the
    // type is nullable, so fall back rather than assert.
    closedAt: clawsIssues.toIso(i.closed_at ?? i.updated_at),
    body: i.body,
    updatedAt: clawsIssues.toIso(i.updated_at),
    author: i.author_login,
  })));
  const forgePromise: Promise<ClosedIssueSummary[]> = forgejo.listRecentlyClosedIssues(repo, since, limit);
  const [forge, native] = await Promise.all([forgePromise, nativePromise]);
  return [...forge, ...native]
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
    .slice(0, limit);
}

export async function listRecentlyMergedPRs(
  repo: string,
  since: Date | null,
  limit = 50,
): Promise<{ number: number; title: string; body: string; mergedAt: string; updatedAt: string; author: string; headRefName: string }[]> {
  return forgejo.listRecentlyMergedPRs(repo, since, limit);
}

/**
 * PRs the owner closed WITHOUT merging — the highest-signal record of rejected
 * direction.
 */
export async function listRecentlyClosedUnmergedPRs(
  repo: string,
  since: Date | null,
  limit = 50,
): Promise<{ number: number; title: string; body: string; closedAt: string; updatedAt: string; author: string; headRefName: string }[]> {
  return forgejo.listRecentlyClosedUnmergedPRs(repo, since, limit);
}

// ── Branch cleanup helpers ──

export interface BranchPR {
  number: number;
  state: string;
  mergedAt?: string;
  closedAt?: string;
}

/**
 * Fetch all PRs (open, closed and merged) for many head branches of one repo.
 * Returns a Map keyed by branch name; a queried branch with no PRs maps to [].
 * Branches with unsafe names are omitted from the map entirely.
 * Throws if any chunk fails — callers MUST NOT treat a rejection as "no PRs".
 */
export async function listPRsForBranches(
  repo: string,
  branchNames: string[],
): Promise<Map<string, BranchPR[]>> {
  return forgejo.listPRsForBranches(repo, branchNames);
}

export async function deleteRemoteBranch(repo: string, branchName: string): Promise<void> {
  return forgejo.deleteRemoteBranch(repo, branchName);
}

/**
 * True when a {@link deleteRemoteBranch} failure means the branch is already
 * gone (HTTP 404/422). Reads Forgejo's `HTTP <status>` message (or a `stderr`
 * field when one is attached) rather than the whole error string, which echoes the branch name
 * and would misread a failure on `claws/preview-issue-404` as "already gone".
 */
export function isRefAlreadyGone(err: unknown): boolean {
  const text = (err as { stderr?: string } | null)?.stderr || (err instanceof Error ? err.message : String(err));
  return /\bHTTP (?:404|422)\b/.test(text) || text.includes("Reference does not exist");
}

export interface BranchHead {
  name: string;
  sha: string;
}

/**
 * Branches under `repo` whose name starts with `prefix`: the full Forgejo
 * branch list filtered client-side. Used for previews that push a branch without opening a PR
 * (#clw_01M3A0HN2JJWXBPNPK5TET0B1N, #clw_01M3J52H0H9WSH3GTSY87ZY351).
 */
export async function listBranchesByPrefix(repo: string, prefix: string): Promise<BranchHead[]> {
  return forgejo.listBranchesByPrefix(repo, prefix);
}

async function getPRMetadata(
  repo: string,
  prNumber: number,
): Promise<{ labels: string[]; mergeableState: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" }> {
  const gate = await forgejo.getPRMergeGate(repo, prNumber);
  return { labels: gate.labels, mergeableState: gate.mergeable };
}

export async function enrichQueueItemsWithPRStatus(items: QueueItem[]): Promise<void> {
  const tasks = items.map(async (item) => {
    try {
      if (item.type === "pr" && typeof item.number === "number") {
        const prNumber = item.number;
        item.prNumber = prNumber;
        const [sum, meta, rev, files] = await Promise.all([
          getPRChecksSummary(item.repo, prNumber),
          getPRMetadata(item.repo, prNumber),
          getPRReviewStatus(item.repo, prNumber),
          getPRChangedFiles(item.repo, prNumber),
        ]);
        if (sum.status !== "none") {
          item.checkStatus = sum.status;
          item.checksPassed = sum.passed;
          item.checksTotal = sum.total;
        }
        item.labels = meta.labels;
        item.mergeableState = meta.mergeableState;
        item.reviewStatus = rev.status;
        if (rev.status === "issues") item.reviewIssueCount = rev.issueCount;
        const infra = infraPathsIn(files);
        if (infra.length > 0) {
          item.infraPaths = infra;
          const headSha = await getPRHeadSHA(item.repo, prNumber).catch(() => "");
          Object.assign(item, tofuPlanFields(await getTofuPlanEvidence(item.repo, prNumber, headSha), files));
        }
      } else if (item.type === "issue") {
        const pr = await getOpenPRForIssue(item.repo, item.number);
        if (pr) {
          item.prNumber = pr.number;
          const [sum, meta, rev, files] = await Promise.all([
            getPRChecksSummary(item.repo, pr.number),
            getPRMetadata(item.repo, pr.number),
            getPRReviewStatus(item.repo, pr.number),
            getPRChangedFiles(item.repo, pr.number),
          ]);
          if (sum.status !== "none") {
            item.checkStatus = sum.status;
            item.checksPassed = sum.passed;
            item.checksTotal = sum.total;
          }
          item.mergeableState = meta.mergeableState;
          item.reviewStatus = rev.status;
          if (rev.status === "issues") item.reviewIssueCount = rev.issueCount;
          const infra = infraPathsIn(files);
          if (infra.length > 0) {
            item.infraPaths = infra;
            const headSha = pr.headRefOid ?? await getPRHeadSHA(item.repo, pr.number).catch(() => "");
            Object.assign(item, tofuPlanFields(await getTofuPlanEvidence(item.repo, pr.number, headSha), files));
          }
        }
      }
    } catch {
      // Graceful degradation — item renders without status
    }
  });
  await Promise.allSettled(tasks);
}

// ── Forgejo Actions queue and runners ──

/** Does NOT swallow fetch failures — callers that need to escalate persistent
 * failures (e.g. mac-runner-waker) rely on errors propagating rather than a silent
 * empty array.
 *
 * Delegates to {@link forgejo.listWaitingRunJobRows}, which reads the org-owner
 * `forgejoAdminToken` (the ordinary bot token gets 403 on this route). Forgejo jobs have no parent run, so each waiting job becomes its own row:
 * `run_id` is the job id and `created_at` is when Claws first saw the job waiting
 * (#3099). With no admin token configured this returns `[]` rather than throwing. */
export async function fetchQueuedWorkflowRuns(repo: string): Promise<WorkflowRunRow[]> {
  return forgejo.listWaitingRunJobRows(repo);
}

export interface QueuedJobInfo {
  name: string;
  labels: string[];
}

/** Does not swallow fetch failures — see {@link fetchQueuedWorkflowRuns}.
 *
 * `runId` is actually a job id (see {@link fetchQueuedWorkflowRuns}), so this
 * delegates to {@link forgejo.listWaitingRunJobLabels}, which re-reads the
 * waiting-jobs endpoint with the admin token and returns the one job whose id matches,
 * if it is still waiting. Returns `[]` with no admin token configured. */
export async function fetchQueuedJobsForRun(repo: string, runId: number): Promise<QueuedJobInfo[]> {
  return forgejo.listWaitingRunJobLabels(repo, runId);
}

export interface SelfHostedRunner {
  name: string;
  status: string;
  labels: string[];
}

/** Self-hosted runners visible to a repo with their online/offline status —
 * the repo-level registry merged with the owning org's. Other fetch failures
 * propagate — see {@link fetchQueuedWorkflowRuns}.
 *
 * Delegates to {@link forgejo.listActionRunners}, which reads the repo+org
 * registries with the admin token and maps Forgejo's `offline`/`idle`/`active` runner status onto `online`/`offline`. Returns `null`
 * with no admin token configured, same as an invisible registry. */
export async function fetchSelfHostedRunners(repo: string): Promise<SelfHostedRunner[] | null> {
  return forgejo.listActionRunners(repo);
}

export async function fetchRepoFileContent(repo: string, path: string): Promise<string | null> {
  return forgejo.fetchRepoFileContent(repo, path);
}

/** Like {@link fetchRepoFileContent}, but returns the raw bytes — for binary files such as images. */
export async function fetchRepoFileBytes(repo: string, path: string): Promise<Buffer | null> {
  return forgejo.fetchRepoFileBytes(repo, path);
}

export interface RepoDirEntry {
  name: string;
  path: string;
  sha: string;
  type: string;
}

// List a directory's entries via the contents API. A missing/renamed directory
// (404) yields [] so callers can still render.
export async function listRepoDirectory(repo: string, dirPath: string): Promise<RepoDirEntry[]> {
  return forgejo.listRepoDirectory(repo, dirPath);
}

// Fetch a single file's decoded content plus its git blob sha (needed for
// updates). 404/403 → null, mirroring fetchRepoFileContent.
export async function fetchRepoFileWithSha(
  repo: string,
  path: string,
  ref?: string,
): Promise<{ content: string; sha: string } | null> {
  return forgejo.fetchRepoFileWithSha(repo, path, ref);
}

// Every blob path in the repo at `ref` (recursive git tree, paged). Throws on
// a read error or an incomplete tree (entries read != total_count) rather than returning a partial list.
export async function listRepoTreePaths(repo: string, ref: string): Promise<string[]> {
  return forgejo.listRepoTreePaths(repo, ref);
}

export async function getDefaultBranch(repo: string): Promise<string> {
  return forgejo.getDefaultBranch(repo);
}

// Create a new branch ref pointing at baseBranch's tip. Swallows the 422
// "Reference already exists" so retries are idempotent.
export async function createBranchRef(repo: string, newBranch: string, baseBranch: string): Promise<void> {
  return forgejo.createBranchRef(repo, newBranch, baseBranch);
}

// Create or update a file on a branch via the contents API. Pass sha only when
// updating an existing file (omit to create a new one).
export async function putRepoFile(
  repo: string,
  branch: string,
  path: string,
  contentBase64: string,
  message: string,
  sha?: string,
): Promise<void> {
  return forgejo.putRepoFile(repo, branch, path, contentBase64, message, sha);
}
