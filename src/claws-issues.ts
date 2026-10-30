/**
 * Claws-native issue store — the third issue backend behind the `github.ts`
 * façade, alongside Forgejo (see docs/issue-tracker.md).
 *
 * This module is a thin mapping layer: `db.ts` owns the SQL, and everything
 * here exists to hand the façade the same shapes `forgejo.ts` does, so no
 * dispatcher, agent or worker knows a native issue from a forge one.
 *
 * It deliberately does NOT import `github.ts` — the façade imports this, so the
 * dependency has to run one way. Events go straight to the leaf
 * `github-events.ts` bus instead, which is what keeps `claws_wait_for_change`
 * working for native issues.
 *
 * Every exported function canonicalises the ids it is handed before touching
 * the database: the id may have come from a URL segment, a form field, an MCP
 * argument or an issue body, and a human writes `clw_01jbq…` in lower case.
 */

import * as db from "./db.js";
import * as log from "./log.js";
import { recordGitHubEvent, extractRelatedNumbers } from "./github-events.js";
import { renderMarkdown } from "./markdown.js";
import { mapSettledWithConcurrency } from "./util.js";
import { DASHBOARD_URL, LABELS, getAutoPromotePolicy } from "./config.js";
import type { RequirementsRecord } from "./requirements-record.js";
import { isAlertInbox, isAlertIssue } from "./alert-issue.js";
import { getRepoConfig } from "./repo-config.js";
import { isStateLabel, labelForLifecycle, type IssueLifecycle } from "./issue-lifecycle.js";
import { atLeast, type ApprovedThrough } from "./issue-approval.js";
import { attachmentUrl } from "./issue-attachments.js";
import { isClawsComment, isPlanComment, isRequirementsComment } from "./marker-text.js";
import {
  canonicalIssueRef,
  canonicalCommentRef,
  isClawsIssueId,
  isClawsCommentId,
  ISSUE_REF_BOUNDARY,
  type IssueRef,
  type CommentRef,
} from "./issue-id.js";

/** Structurally identical to `github.ts`'s `Issue`; redeclared to avoid the import cycle. */
export interface Issue {
  number: IssueRef;
  title: string;
  body: string;
  labels: { name: string }[];
  author: { login: string };
  updatedAt?: string;
  createdAt?: string;
  /** The title the issue was filed under when promotion renamed it. */
  filedTitle?: string;
  /** When the issue entered its current board column; `updatedAt` for a row that predates the column. */
  stageSince?: string;
  /** The stored lifecycle, which tells Ideas from Planning — the two carry no label. */
  lifecycle?: IssueLifecycle;
  /** How far the issue is approved (`issue-approval.ts`), who set it and when. */
  approvedThrough?: ApprovedThrough;
  approvedThroughBy?: string;
  approvedThroughAt?: string;
  /** The dedupe key the issue was filed with, if any. */
  dedupeKey?: string;
  /** Every repo the issue names: the primary first, then the rest sorted. */
  repos?: string[];
  /** The repo that owns planning, labels and phase sequencing; see {@link primaryRepo}. */
  primaryRepo?: string;
  /** Set while `issue-importer` is still assembling the issue. */
  importPending?: boolean;
}

/** Structurally identical to `github.ts`'s `IssueComment`. */
export interface IssueComment {
  id: CommentRef;
  body: string;
  body_html: string;
  login: string;
}

/** Structurally identical to `github.ts`'s `Reaction`. Native reactions carry no id of their own. */
export interface Reaction {
  id: number;
  user: { login: string };
  content: string;
}

/**
 * The login Claws writes on its own native comments and reactions.
 *
 * Native writes never reach a forge, so there is no app installation to ask
 * for a bot login — and asking one would turn every native comment into a
 * GitHub API call. `gh.getSelfLoginForIssue` returns this for a native issue,
 * so authorship and reaction comparisons keep working unchanged.
 */
export const CLAWS_NATIVE_LOGIN = "claws";

/** `YYYY-MM-DD HH:MM:SS` UTC (the stored form) → ISO, which every caller expects. */
export function toIso(stored: string): string {
  const parsed = new Date(`${stored.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? stored : parsed.toISOString();
}

function toIssue(record: db.ClawsIssueRecord): Issue {
  const primary = primaryRepo(record);
  return {
    number: record.id,
    title: record.title,
    body: record.body,
    labels: record.labels.map((name) => ({ name })),
    author: { login: record.author_login },
    updatedAt: toIso(record.updated_at),
    createdAt: toIso(record.created_at),
    filedTitle: record.filed_title ?? undefined,
    stageSince: toIso(record.stage_changed_at ?? record.updated_at),
    lifecycle: record.lifecycle,
    approvedThrough: record.approved_through ?? "none",
    ...(record.approved_through_by ? { approvedThroughBy: record.approved_through_by } : {}),
    ...(record.approved_through_at ? { approvedThroughAt: toIso(record.approved_through_at) } : {}),
    dedupeKey: record.dedupe_key ?? undefined,
    repos: primary ? [primary, ...record.repos.filter((r) => r !== primary).sort()] : [],
    primaryRepo: primary || undefined,
    ...(record.importPending ? { importPending: true } : {}),
  };
}

function toComment(row: db.ClawsIssueCommentRow, renderHtml = true): IssueComment {
  return { id: row.id, body: row.body, body_html: renderHtml ? renderMarkdown(row.body) : "", login: row.author_login };
}

/** The canonical id behind `ref`, or null when it is not a native issue id. */
function issueId(ref: IssueRef): string | null {
  const canonical = canonicalIssueRef(ref);
  return isClawsIssueId(canonical) ? canonical : null;
}

/** The canonical id behind `ref`, or null when it is not a native comment id. */
function commentId(ref: CommentRef): string | null {
  const canonical = canonicalCommentRef(ref);
  return isClawsCommentId(canonical) ? canonical : null;
}

function requireIssueId(ref: IssueRef): string {
  const id = issueId(ref);
  if (!id) throw new Error(`claws-issues: not a native issue id: ${String(ref)}`);
  return id;
}

function requireCommentId(ref: CommentRef): string {
  const id = commentId(ref);
  if (!id) throw new Error(`claws-issues: not a native comment id: ${String(ref)}`);
  return id;
}

/** Dashboard URL for a native issue — what pages link to. */
export function dashboardIssueUrl(ref: IssueRef): string {
  const base = DASHBOARD_URL?.replace(/\/+$/, "") ?? "";
  return `${base}/issues/${canonicalIssueRef(ref) ?? String(ref)}`;
}

/** The dashboard terminal page of an interactive session, e.g. for `claws_start_session`'s reply. */
export function dashboardSessionUrl(sessionId: string): string {
  const base = DASHBOARD_URL?.replace(/\/+$/, "") ?? "";
  return `${base}/sessions/${encodeURIComponent(sessionId)}`;
}

/**
 * Emit one event per repository the issue is associated with.
 *
 * A native issue can concern zero repos, and an event with `repo: ""` matches
 * no `claws_wait_for_change` filter while still consuming a ring slot — so an
 * unassigned issue emits nothing at all.
 */
function emitForRepos(
  repos: readonly string[],
  event: Omit<Parameters<typeof recordGitHubEvent>[0], "repo">,
): void {
  for (const repo of repos) {
    if (repo) recordGitHubEvent({ ...event, repo });
  }
}

/**
 * Announce a native issue's move between stored lifecycles as a
 * `stage-changed` event (detail `<from>-><to>`), beside the label events
 * existing waiters read. Emits nothing when the lifecycle did not change.
 */
function emitStageChanged(repos: readonly string[], id: string, from: IssueLifecycle, to: IssueLifecycle): void {
  if (from === to) return;
  emitForRepos(repos, { kind: "stage-changed", number: id, related: [], detail: `${from}->${to}` });
}

async function reposOf(id: string): Promise<string[]> {
  return (await db.getClawsIssue(id))?.repos ?? [];
}

/**
 * A native issue's primary repo: its pinned `primary_repo` when that is one
 * of its repos (only the friction retrospective pins one), else the
 * alphabetically first of its repos, or `""` when it has none. The primary
 * repo owns planning, labels and phase sequencing; each planned PR is
 * implemented in its own entry's repo.
 */
export function primaryRepo(issue: { readonly repos: readonly string[]; readonly primary_repo?: string | null }): string {
  return db.primaryRepoOf(issue);
}

// ── Reads ──

/**
 * Open native issues whose primary repo is `repo` — the ones that repo's
 * automation acts on (the dispatch rule). A multi-repo issue is listed under
 * its primary repo only (see {@link primaryRepo}); discovery views use
 * {@link listOpenIssuesNaming} to list it under every repo it names.
 */
export async function listOpenIssues(repo: string): Promise<Issue[]> {
  return (await db.listOpenClawsIssues({ repo })).map(toIssue);
}

/** Open native issues that name `repo`, as primary or not — the discovery rule. */
export async function listOpenIssuesNaming(repo: string): Promise<Issue[]> {
  return (await db.listOpenClawsIssues({ repo, repoMatch: "any" })).map(toIssue);
}

export async function listIssuesByLabel(repo: string, label: string): Promise<Issue[]> {
  return (await db.listOpenClawsIssues({ repo, label })).map(toIssue);
}

/** Open native issues with no repo yet — invisible to automation until one is assigned. */
export async function listUnassignedOpenIssues(): Promise<db.ClawsIssueRecord[]> {
  return await db.listOpenClawsIssues({ unassigned: true });
}

/**
 * Native issues closed at or after `since` whose primary repo is `repo` (each
 * record carries every repo it names, for discovery views), newest
 * first and capped at `limit`.
 *
 * Both filters go down into SQL — the façade asks per repo on every poll
 * cycle, and the closed set only ever grows.
 */
export async function listClosedIssuesSince(repo: string, since: Date, limit: number): Promise<db.ClawsIssueRecord[]> {
  return await db.listClosedClawsIssuesSince(since, { repo, limit });
}

/** The full record behind a native issue, for the dashboard's issue page. */
export async function getIssue(ref: IssueRef): Promise<db.ClawsIssueRecord | undefined> {
  const id = issueId(ref);
  return id ? await db.getClawsIssue(id) : undefined;
}

async function requireIssue(ref: IssueRef): Promise<db.ClawsIssueRecord> {
  const issue = await getIssue(ref);
  if (!issue) throw new Error(`claws-issues: no native issue ${String(ref)}`);
  return issue;
}

export async function getIssueTitleBody(ref: IssueRef): Promise<{ title: string; body: string }> {
  const issue = await requireIssue(ref);
  return { title: issue.title, body: issue.body };
}

export async function getIssueBody(ref: IssueRef): Promise<string> {
  return (await requireIssue(ref)).body;
}

/** Rendered body. The images pipeline scrapes `<img>` out of this, exactly as for GitHub. */
export async function getIssueBodyHtml(ref: IssueRef): Promise<string> {
  return renderMarkdown((await requireIssue(ref)).body);
}

/** The labels come off the record this already read, so the façade gets them free. */
export async function getIssueState(ref: IssueRef): Promise<{ state: string; stateReason: string | null; labels: string[] }> {
  const issue = await requireIssue(ref);
  return { state: issue.state.toUpperCase(), stateReason: issue.state_reason, labels: issue.labels };
}

export async function getIssueComments(ref: IssueRef): Promise<IssueComment[]> {
  return (await db.listClawsIssueComments(requireIssueId(ref))).filter((c) => c.body.trim()).map((row) => ({ ...toComment(row), createdAt: toIso(row.created_at) }));
}

/** A comment plus the posting time the façade's `IssueComment` has no room for. */
export interface IssueCommentDetail extends IssueComment {
  createdAt: string;
}

/**
 * A native issue's files as `{ name, url }`, the shape `forgejo.ts` returns
 * for Forgejo assets, so the images pipeline merges them the same way. The
 * URL is the site-relative one the serve route answers on (#3289).
 */
export async function listAttachments(ref: IssueRef): Promise<{ name: string; url: string }[]> {
  const id = issueId(ref);
  if (!id) return [];
  return (await db.listClawsIssueAttachments(id)).map((row) => ({ name: row.filename, url: attachmentUrl(row) }));
}

/** One recorded change to a native issue, for its page's History block (docs/issue-tracker.md#history). */
export interface IssueHistoryEntry {
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actorKind: "operator" | "session" | "automation";
  actor: string;
  runId: string | null;
  createdAt: string;
}

/** Every recorded change to a native issue, oldest first; empty for a ref that is not one. */
export async function listHistory(ref: IssueRef): Promise<IssueHistoryEntry[]> {
  const id = issueId(ref);
  if (!id) return [];
  return (await db.listClawsIssueHistory(id)).map((row) => ({
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    actorKind: row.actor_kind,
    actor: row.actor,
    runId: row.run_id,
    createdAt: toIso(row.created_at),
  }));
}

/** Comments for the dashboard's issue page, which shows when each was posted. */
export async function listCommentDetails(ref: IssueRef, opts: { renderHtml?: boolean } = {}): Promise<IssueCommentDetail[]> {
  return (await db.listClawsIssueComments(requireIssueId(ref)))
    .filter((c) => c.body.trim())
    .map((c) => ({ ...toComment(c, opts.renderHtml ?? true), createdAt: toIso(c.created_at) }));
}

/** One stored version of a native issue's plan, for the issue page. */
export interface IssuePlanVersion {
  version: number;
  /** The plan comment the version came from, or null once it is deleted. */
  commentId: string | null;
  /** Normalised plan text: no Claws header, no `CLAWS_PLAN_*` markers. */
  body: string;
  createdAt: string;
}

/** Every version of a native issue's plan, oldest first; empty for a forge ref. */
export async function listPlans(ref: IssueRef): Promise<IssuePlanVersion[]> {
  const id = issueId(ref);
  if (!id) return [];
  return (await db.listClawsIssuePlans(id)).map((row) => ({
    version: row.version,
    commentId: row.comment_id,
    body: row.body,
    createdAt: toIso(row.created_at),
  }));
}

/** The latest plan version of every open native issue, keyed by issue id — the board's and `/issues`' bulk read. */
export async function getLatestPlansForOpenIssues(): Promise<Map<string, db.ClawsIssuePlanRow>> {
  return await db.listLatestClawsIssuePlansForOpenIssues();
}

/** Every open forge issue's shadow id and lifecycle, keyed `repo \u0000 forge number` — the board's bulk read. */
export async function getOpenShadowStages(): Promise<Map<string, { id: string; lifecycle: IssueLifecycle; approvedThrough: ApprovedThrough; hasPlannedPrs: boolean }>> {
  return await db.listOpenShadowStages();
}

/** One stored version of an issue's requirements record, for the issue page. */
export interface IssueRequirementsVersion {
  version: number;
  title: string;
  kind: "bug" | "feature";
  context: string;
  requirement: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  /** The `## Requirements` comment the version was rendered into. */
  commentId: string | null;
  createdAt: string;
}

/**
 * Every version of an issue's requirements record, oldest first. `ref` is a
 * tracker id — a native issue's id or a forge issue's shadow — so anything
 * else has no versions.
 */
export async function listRequirements(ref: IssueRef): Promise<IssueRequirementsVersion[]> {
  const id = issueId(ref);
  if (!id) return [];
  return (await db.listClawsIssueRequirements(id)).map((row) => ({
    version: row.version,
    title: row.title,
    kind: row.kind,
    context: row.context,
    requirement: row.requirement,
    acceptanceCriteria: row.acceptance_criteria,
    outOfScope: row.out_of_scope,
    commentId: row.comment_id,
    createdAt: toIso(row.created_at),
  }));
}

/** The latest requirements version of every open issue, shadows included, keyed by tracker id. */
export async function getLatestRequirementsForOpenIssues(): Promise<Map<string, db.ClawsIssueRequirementsRow>> {
  return await db.listLatestClawsIssueRequirementsForOpenIssues();
}

/**
 * Whether a comment can be feedback on a requirements version created at
 * `latestCreatedAt` (ISO): posted at or after the version and not written by
 * Claws — not the `claws` login, not a `[bot]` login, not a Claws-marked body
 * and not a `## Requirements` record. The cheap half of the board's rule; a
 * comment passing it is feedback only while Claws has not 👍'd it
 * ({@link hasRequirementsFeedback}).
 */
export function isRequirementsFeedback(comment: { login: string; body: string; createdAt: string }, latestCreatedAt: string): boolean {
  if (Date.parse(comment.createdAt) < Date.parse(latestCreatedAt)) return false;
  if (comment.login === CLAWS_NATIVE_LOGIN || comment.login.endsWith("[bot]")) return false;
  return !isClawsComment(comment.body) && !isRequirementsComment(comment.body);
}

/** Whether Claws has 👍'd a native comment — how a refine run marks feedback addressed. */
async function isAddressedByClaws(commentId: string): Promise<boolean> {
  return (await db.listClawsIssueCommentReactions(commentId))
    .some((r) => r.login === CLAWS_NATIVE_LOGIN && r.content === "+1");
}

/**
 * Whether any of a native issue's comments is unaddressed feedback on the
 * requirements version created at `latestCreatedAt` — what moves a board card
 * from Requirements review back to Drafting (docs/issue-tracker.md#board):
 * {@link isRequirementsFeedback} and no 👍 from Claws. That is the reaction rule
 * the dispatcher's `unreactedAfterRequirements` applies, so a card never sits
 * in Drafting on feedback no refine run will pick up. It skips
 * `isAllowedActor`, so it needs no API calls, and reads reactions only for the
 * comments that pass the cheap filter. A refine run that stores the next
 * version moves the anchor past the comment, which is what returns the card.
 */
export async function hasRequirementsFeedback(comments: IssueCommentDetail[], latestCreatedAt: string): Promise<boolean> {
  for (const c of comments) {
    if (isRequirementsFeedback(c, latestCreatedAt) && !await isAddressedByClaws(String(c.id))) return true;
  }
  return false;
}

/**
 * The ids of open `ideas` issues with unaddressed feedback on their latest
 * requirements version — the board's bulk read, beside
 * {@link getLatestRequirementsForOpenIssues}, whose map is `latest`. The SQL
 * applies the timing, login and reaction rules; the body checks run here. A
 * shadow has no native comments, so it is never here.
 */
export async function getRequirementsFeedbackPending(latest: Map<string, db.ClawsIssueRequirementsRow>): Promise<Set<string>> {
  const pending = new Set<string>();
  for (const row of await db.listClawsIssueCommentsForOpenIdeasIssues(CLAWS_NATIVE_LOGIN)) {
    if (pending.has(row.issue_id) || !row.body.trim()) continue;
    const version = latest.get(row.issue_id);
    if (!version) continue;
    const comment = { login: row.author_login, body: row.body, createdAt: toIso(row.created_at) };
    if (isRequirementsFeedback(comment, toIso(version.created_at))) pending.add(row.issue_id);
  }
  return pending;
}

/**
 * Whether one issue sits in Requirements review rather than Drafting: it has
 * a stored requirements version and no unaddressed feedback on it
 * ({@link hasRequirementsFeedback}). `ref` is a tracker id — a native issue's
 * id or a forge issue's shadow — so anything else, or no id at all, is false.
 * A shadow has no native comments, so it is true once a version exists.
 */
export async function isAwaitingRequirementsReview(ref: IssueRef | null | undefined): Promise<boolean> {
  if (ref == null) return false;
  const latest = (await listRequirements(ref)).at(-1);
  if (!latest) return false;
  return !await hasRequirementsFeedback(await listCommentDetails(ref), latest.createdAt);
}

export async function getCommentReactions(ref: CommentRef): Promise<Reaction[]> {
  return (await db.listClawsIssueCommentReactions(requireCommentId(ref))).map((r) => ({
    id: 0,
    user: { login: r.login },
    content: r.content,
  }));
}

/**
 * Open native issues marked as duplicates of `canonicalRef`.
 *
 * GitHub finds these with a comment-body search and Forgejo by scanning the
 * label-filtered candidates' comments; here the marker is looked for in both
 * the body and the comments of the (small) labelled set.
 *
 * Only the structured marker counts, never a bare `#<canonical>` mention: the
 * result feeds `Closes #<ref>` lines in the implementer's PR body, which the
 * merger then acts on, so a `Duplicate` issue that merely *discusses* the
 * canonical issue would otherwise be closed automatically.
 */
export async function listDuplicateIssuesOf(repo: string, canonicalRef: IssueRef): Promise<Issue[]> {
  const canonical = canonicalIssueRef(canonicalRef);
  if (canonical === null) return [];
  // The boundary guard is what stops a marker for one ref being read as a
  // marker for a shorter one that happens to be its prefix.
  const marker = new RegExp(`claws-duplicate-of:${canonical}${ISSUE_REF_BOUNDARY}`, "i");
  const candidates = await db.listOpenClawsIssues({ repo, label: LABELS.duplicate });
  const settled = await mapSettledWithConcurrency(candidates, 4, async (issue) => {
    if (marker.test(issue.body)) return issue;
    const comments = await db.listClawsIssueComments(issue.id);
    return comments.some((c) => marker.test(c.body)) ? issue : null;
  });
  const matches: db.ClawsIssueRecord[] = [];
  for (const [i, result] of settled.entries()) {
    if (result.status === "rejected") {
      log.warn(`listDuplicateIssuesOf ${repo}#${candidates[i]!.id}: ${result.reason}`);
      continue;
    }
    if (result.value) matches.push(result.value);
  }
  return matches.map(toIssue);
}

/**
 * The issue each of `issueIds` was closed against, read from its
 * `claws-duplicate-of:` marker in the body or a live comment. One query for
 * the batch; the first marker found per issue wins.
 */
export async function duplicateOfForIssues(issueIds: readonly string[]): Promise<Map<string, string>> {
  const marker = new RegExp(`claws-duplicate-of:(\\S+?)${ISSUE_REF_BOUNDARY}`, "i");
  const out = new Map<string, string>();
  for (const row of await db.listDuplicateMarkerBodies(issueIds)) {
    if (out.has(row.issue_id)) continue;
    const m = marker.exec(row.body);
    const canonical = m ? canonicalIssueRef(m[1]!) : null;
    if (canonical !== null) out.set(row.issue_id, String(canonical));
  }
  return out;
}

// ── Writes ──

/**
 * Create a native issue. `repos` is the repo association: one or several
 * repos make the issue visible to automation through its primary repo, and
 * none leaves it "unassigned" on the list and board only.
 */
export async function createIssue(input: {
  title: string;
  body?: string;
  authorLogin: string;
  repos?: readonly string[];
  labels?: readonly string[];
  /** Where the issue came from; defaults to `dashboard`. */
  source?: db.IssueSource;
  /** Per-issue promotion override; omitted follows the source and repo policy. */
  autoPromote?: boolean;
  /**
   * Whether the issue goes through the requirements stage before Planning;
   * omitted defaults to whether `source` is hand-filed (`db.HUMAN_ISSUE_SOURCES`).
   */
  requirementsStage?: boolean;
  /** The caller's dedupe key (docs/issue-tracker.md "Dedupe on create"). */
  dedupeKey?: string;
  /** Why the issue is Blocked; required when `labels` files it Blocked. */
  blockedReason?: string;
  /** The approval the issue is filed with (`issue-approval.ts`); omitted files it unapproved. */
  approvedThrough?: ApprovedThrough;
  /** Who the filing-time approval is recorded as; defaults to `authorLogin`. */
  approvedBy?: string;
  /**
   * A repo pinned as the primary however `repos` sort; must be one of them.
   * Only the friction retrospective sets it (docs/issue-tracker.md).
   */
  primaryRepo?: string;
  /** Which alert path filed the issue, listing it on the dashboard's `/alerts` page; omitted when it is not an alert. */
  alertKind?: string;
}): Promise<string> {
  return await db.createClawsIssue(input);
}

/**
 * Set how far issue `ref` — a native issue or a forge issue's shadow — is
 * approved, as `by`: the raw write behind `issue-approval-write.ts`'s
 * `applyIssueApproval`, which owns the PR rows and comments that go with it.
 * A native issue announces the change as a `stage-changed` event (detail
 * `approved-through:<from>-><to>`); a shadow's events come from its forge.
 * Returns whether the value changed.
 */
export async function setApprovedThrough(ref: IssueRef, through: ApprovedThrough, by: string): Promise<boolean> {
  const id = requireIssueId(ref);
  const before = await requireIssue(id);
  if (!(await db.setClawsIssueApprovedThrough(id, through, by))) return false;
  log.info(`[claws-issues] ${id} approved through ${through} by ${by} (was ${before.approved_through ?? "none"})`);
  if (before.kind !== "shadow") {
    emitForRepos(before.repos, { kind: "stage-changed", number: id, related: [], detail: `approved-through:${before.approved_through ?? "none"}->${through}` });
  }
  return true;
}

/** True when `record` is an alert bridge inbox, which is never a dedicated (keyed) issue. */
export function isAlertInboxRecord(record: db.ClawsIssueRecord): boolean {
  return isAlertInbox(
    { title: record.title, filedTitle: record.filed_title, labels: record.labels, body: record.body },
    getRepoConfig(primaryRepo(record))?.alertBridge,
  );
}

/**
 * The oldest open native issue filed with dedupe key `key` whose primary repo
 * is `primary`, or undefined. Alert inboxes are skipped. A key is scoped to its primary repo, so two
 * repos naming the same key for unrelated work never collide.
 */
export async function findOpenIssueByDedupeKey(primary: string, key: string): Promise<db.ClawsIssueRecord | undefined> {
  return (await db.listOpenClawsIssuesByDedupeKey(key)).find((record) => primaryRepo(record) === primary && !isAlertInboxRecord(record));
}

/**
 * The most recently closed native issue filed with dedupe key `key` whose
 * primary repo is `primary` and that closed at or after `since`, or undefined.
 */
export async function findRecentlyClosedIssueByDedupeKey(primary: string, key: string, since: Date): Promise<db.ClawsIssueRecord | undefined> {
  return (await db.listClosedClawsIssuesByDedupeKey(primary, key, since)).find((record) => !isAlertInboxRecord(record));
}

/**
 * The newest open, unkeyed native issue whose primary repo is `primary` and
 * that was filed under exactly `title` (its `filed_title`, else its title),
 * or undefined — the issue filer's adoption candidate. Never the alert inbox.
 */
export async function findOpenUnkeyedIssueByFiledTitle(primary: string, title: string): Promise<db.ClawsIssueRecord | undefined> {
  const record = await db.findOpenUnkeyedIssueByFiledTitle(primary, title);
  return record && !isAlertInboxRecord(record) ? record : undefined;
}

/**
 * Set a native issue's dedupe key; false when the issue is unknown or
 * another open issue with the same primary repo already holds `key`.
 */
export async function setClawsIssueDedupeKey(ref: IssueRef, key: string): Promise<boolean> {
  const id = issueId(ref);
  return id ? await db.setClawsIssueDedupeKey(id, key) : false;
}

/**
 * Open native issues associated with any of `repos` — not only those whose
 * primary repo is one of them — for dedupe on create: a companion issue for
 * one repo duplicates an open issue that names that repo second.
 */
export async function listOpenIssuesTouching(repos: readonly string[]): Promise<db.ClawsIssueRecord[]> {
  const wanted = new Set(repos);
  return (await db.listOpenClawsIssues({})).filter((record) => record.repos.some((r) => wanted.has(r)));
}

// ── Promotion (docs/refinements/issue-flow.md "Promotion") ──

/**
 * Whether `record` goes through the requirements stage before Planning. A row
 * that predates the `requirements_stage` column (NULL) counts as on, so issues
 * filed before it keep today's flow.
 */
export function requirementsStageApplies(record: Pick<db.ClawsIssueRow, "requirements_stage">): boolean {
  return record.requirements_stage !== 0;
}

/** {@link requirementsStageApplies} for issue `ref`; true when it does not exist. */
export async function requirementsStageOn(ref: IssueRef): Promise<boolean> {
  const issue = await db.getClawsIssue(requireIssueId(ref));
  return issue === undefined || requirementsStageApplies(issue);
}

/** Why {@link autoPromoteDecision} decided as it did. */
export type AutoPromoteReason = "override" | "bug" | "alert" | "default";

/**
 * Whether the issue's first requirements version promotes it to Planning
 * without a human, and why. It decides only for an issue that goes through
 * the requirements stage ({@link requirementsStageApplies}); one that skips it
 * is promoted by {@link autoPromoteIfDue} with no record. First match wins:
 *
 * 1. the per-issue `auto_promote` choice;
 * 2. when the requirements record is `kind: bug`, or the issue is an alert
 *    ({@link isAlertIssue} — the `alert`/`grafana-alert` label, or a
 *    consolidated alert-bridge body), the primary repo's `claws.json`
 *    `autoPromote.bugsAndAlerts` (default `true`) promotes it — a `false`
 *    here does not decide "wait"; it falls through to the source default
 *    below, as if the issue were neither a bug nor an alert;
 * 3. the source's default — `automation` and `forge` issues promote; every
 *    other source waits for a human. (`automation`, `agent` and `session`
 *    issues normally skip the stage, so this matters for them only when the
 *    stage was turned on explicitly.)
 *
 * `requirementsKind` is the issue's latest requirements record's `kind`, or
 * `undefined` when it has none yet — in which case only the alert rule (2)
 * can apply, never the bug one.
 */
export function autoPromoteDecision(
  issue: Pick<db.ClawsIssueRecord, "source" | "auto_promote" | "repos" | "primary_repo" | "labels" | "body">,
  requirementsKind: "bug" | "feature" | undefined,
): { promotes: boolean; reason: AutoPromoteReason } {
  if (issue.auto_promote !== null) return { promotes: issue.auto_promote === 1, reason: "override" };
  const policy = getAutoPromotePolicy(primaryRepo(issue));
  const isBug = requirementsKind === "bug";
  if ((isBug || isAlertIssue(issue)) && (policy.bugsAndAlerts ?? true)) {
    return { promotes: true, reason: isBug ? "bug" : "alert" };
  }
  return { promotes: issue.source === "automation" || issue.source === "forge", reason: "default" };
}

/** {@link autoPromoteDecision}'s verdict alone, for a caller that doesn't need the reason. */
export function shouldAutoPromote(
  issue: Pick<db.ClawsIssueRecord, "source" | "auto_promote" | "repos" | "primary_repo" | "labels" | "body">,
  requirementsKind?: "bug" | "feature",
): boolean {
  return autoPromoteDecision(issue, requirementsKind).promotes;
}

/** The `kind` of an issue's latest requirements record, or `undefined` with none yet. */
async function latestRequirementsKind(issueId: string): Promise<"bug" | "feature" | undefined> {
  const versions = await db.listClawsIssueRequirements(issueId);
  return versions[versions.length - 1]?.kind;
}

/**
 * Where an issue re-enters the board — out of the backlog, or released from a
 * dependency: `planning` once it has a plan or approved requirements, since
 * neither needs a human's promotion again, and `ideas` otherwise.
 */
export function entryLifecycle(issue: Pick<db.ClawsIssueRow, "requirements_approved_at">, hasPlan: boolean): IssueLifecycle {
  return hasPlan || issue.requirements_approved_at != null ? "planning" : "ideas";
}

/**
 * Where a Blocked issue lands once it stops being blocked — its dependencies
 * released, or an operator/session clears the label directly: a real plan
 * sends it to Awaiting plan review with the plan kept, the planner's blocked
 * verdict sends it back to Planning for a re-plan, and no plan at all goes
 * where {@link entryLifecycle} says. `isBlockedVerdict` (`plan-parser.ts`'s
 * `isBlockedVerdictPlan` on the latest plan comment) is meaningless without a
 * plan, so callers may pass `false` when `hasPlan` is `false`. The caller
 * still has to queue `ISSUE_REFINER_REPLAN` itself when `replan` is true —
 * this only picks the destination.
 */
export function releaseLifecycle(
  issue: Pick<db.ClawsIssueRow, "requirements_approved_at">,
  hasPlan: boolean,
  isBlockedVerdict: boolean,
): { lifecycle: IssueLifecycle; replan: boolean } {
  const replan = hasPlan && isBlockedVerdict;
  if (hasPlan && !replan) return { lifecycle: "awaiting-plan-review", replan: false };
  return { lifecycle: entryLifecycle(issue, hasPlan), replan };
}

/**
 * Promote an issue to Planning, recording `approvedBy` as the approver of its
 * latest requirements version — or of none, when a human promotes before the
 * writer has produced one, and the planner then plans from the body. When the
 * approved version's title differs from the issue's, the issue takes it and
 * keeps the title it was filed under (`filed_title`). `ref` may be a forge
 * issue's shadow: the dispatcher reads a forge issue's stage from there.
 *
 * `expectedLifecycle` is the lifecycle the caller already read: the write is a
 * compare-and-swap on it, so a promotion that lost a race against a human's
 * own move in the meantime changes nothing. Returns whether it landed —
 * `false` means the caller's read is stale and the move it was part of did
 * not happen.
 */
export async function promoteIssue(ref: IssueRef, approvedBy: string, expectedLifecycle: IssueLifecycle): Promise<boolean> {
  const id = requireIssueId(ref);
  const before = await db.getClawsIssue(id);
  if (!before) throw new Error(`claws-issues: no native issue ${String(ref)}`);
  const versions = await db.listClawsIssueRequirements(id);
  const latest = versions[versions.length - 1];
  const promoted = await db.promoteClawsIssue(id, { version: latest?.version ?? null, approvedBy, title: latest?.title, expectedLifecycle });
  if (!promoted) return false;
  log.info(`[claws-issues] ${id} promoted to Planning by ${approvedBy}${latest ? ` (requirements v${latest.version})` : " (no requirements yet)"}`);
  // A shadow's events come from its forge; only a native issue announces the move.
  if (before.kind === "shadow") return true;
  const removed = labelForLifecycle(before.lifecycle);
  if (removed !== undefined) emitForRepos(before.repos, { kind: "label-removed", number: id, related: [], detail: removed });
  emitStageChanged(before.repos, id, expectedLifecycle, "planning");
  return true;
}

/**
 * Send an issue back to Ideas: clear its approval — the merge approval on
 * its open PR rows too — keep its requirements versions, and skip any
 * planner run still queued for it. A planner already
 * running is left to finish; a plan it posts moves the issue on as usual.
 */
export async function demoteIssue(ref: IssueRef): Promise<void> {
  const id = requireIssueId(ref);
  const before = await db.getClawsIssue(id);
  if (!before) throw new Error(`claws-issues: no native issue ${String(ref)}`);
  await db.demoteClawsIssue(id);
  // Nothing is approved back in Ideas, so neither is the merge of an open PR.
  await db.clearPrMergeApprovals(await db.listOpenClawsPrsForIssueOrSteps(id));
  await db.skipQueuedPlannerWork(id, "issue sent back to Ideas");
  if (before.kind === "shadow") return;
  const removed = labelForLifecycle(before.lifecycle);
  if (removed !== undefined) emitForRepos(before.repos, { kind: "label-removed", number: id, related: [], detail: removed });
  emitStageChanged(before.repos, id, before.lifecycle, "ideas");
}

/**
 * Auto-promote an issue whose first requirements version just landed, when it
 * is still in Ideas and {@link shouldAutoPromote} says so. The service
 * registers it at boot with `db.setRequirementsVersionListener`, so it runs
 * after every version `db.ts` stores — an agent pod's too, which reaches that
 * write through the ops API.
 */
export async function autoPromoteOnFirstVersion(issueIdValue: string, version: number): Promise<void> {
  if (version !== 1) return;
  const issue = await db.getClawsIssue(issueIdValue);
  if (!issue || issue.state !== "open" || issue.lifecycle !== "ideas") return;
  if (await promoteIfPreapproved(issue)) return;
  if (!shouldAutoPromote(issue, await latestRequirementsKind(issueIdValue))) return;
  await promoteIssue(issueIdValue, CLAWS_NATIVE_LOGIN, "ideas");
}

/**
 * Promote an issue in Ideas that was filed already approved through
 * Requirements or beyond (`claws_create_issue`'s `approve_through`), as
 * whoever approved it. Returns whether it applied.
 */
async function promoteIfPreapproved(issue: db.ClawsIssueRecord): Promise<boolean> {
  if (!atLeast(issue.approved_through, "requirements")) return false;
  await promoteIssue(issue.id, issue.approved_through_by ?? CLAWS_NATIVE_LOGIN, "ideas");
  return true;
}

/**
 * Announce a stored requirements version, then run
 * {@link autoPromoteOnFirstVersion}. The service registers this with
 * `db.setRequirementsVersionListener`. A native issue emits
 * `requirements-stored` (detail `v<N>`) per repository, before any
 * auto-promotion's `stage-changed`; a shadow's events come from its forge, so
 * it emits nothing.
 */
export async function onRequirementsVersionStored(issueIdValue: string, version: number): Promise<void> {
  const issue = await db.getClawsIssue(issueIdValue);
  if (issue && issue.kind !== "shadow") {
    emitForRepos(issue.repos, { kind: "requirements-stored", number: issue.id, related: [], detail: `v${version}` });
  }
  await autoPromoteOnFirstVersion(issueIdValue, version);
}

/**
 * The level-triggered counterpart to {@link autoPromoteOnFirstVersion}, for
 * an issue the listener never got to fire for: its version predates the
 * listener (this deploy's migration moved it from `inbox` to `ideas` with a
 * version already on record), or it landed while `requirements-writer` was
 * disabled. The issue dispatcher calls this on every tick for an issue it
 * finds in Ideas, passing `requirementsReady` — a version already exists, or
 * none ever will because the writer is disabled, in which case decision 10
 * lets the promotion plan from the body. With no version, the requirements
 * kind is `undefined`, so only the label/body alert rule of
 * {@link autoPromoteDecision} can promote it — never the bug one. A no-op once
 * the issue has left Ideas or already has a recorded approval, so a demotion
 * in between (which also sets the per-issue `auto_promote` override to wait)
 * is not undone here.
 *
 * An issue that skips the requirements stage ({@link requirementsStageApplies}
 * false) has no record to wait for: it is promoted as `claws` with none, so
 * the planner plans from its text, unless its per-issue `auto_promote` is 0
 * (an explicit hold, or a human's demotion back to Ideas), which leaves it in
 * Drafting for a human. {@link autoPromoteDecision} is not consulted for it.
 */
export async function autoPromoteIfDue(ref: IssueRef, requirementsReady: boolean): Promise<void> {
  if (!requirementsReady) return;
  const id = requireIssueId(ref);
  const issue = await db.getClawsIssue(id);
  if (!issue || issue.state !== "open" || issue.lifecycle !== "ideas" || issue.requirements_approved_at != null) return;
  if (await promoteIfPreapproved(issue)) return;
  if (!requirementsStageApplies(issue)) {
    if (issue.auto_promote === 0) return;
    await promoteIssue(id, CLAWS_NATIVE_LOGIN, "ideas");
    return;
  }
  if (!shouldAutoPromote(issue, await latestRequirementsKind(id))) return;
  await promoteIssue(id, CLAWS_NATIVE_LOGIN, "ideas");
}

export async function addLabel(repo: string, ref: IssueRef, label: string): Promise<void> {
  const id = requireIssueId(ref);
  const before = isStateLabel(label) ? await db.getClawsIssue(id) : undefined;
  if (await db.addClawsIssueLabel(id, label)) {
    const repos = repo ? [repo] : await reposOf(id);
    emitForRepos(repos, { kind: "label-added", number: id, related: [], detail: label });
    await emitLabelStageChange(repos, before);
  }
}

/**
 * After a state label write, announce the lifecycle move it made — read
 * before and after, since the write's own result only says something changed.
 * `before` is undefined for a plain label or an unknown issue.
 */
async function emitLabelStageChange(repos: readonly string[], before: db.ClawsIssueRecord | undefined): Promise<void> {
  if (!before || before.kind === "shadow") return;
  const after = await db.getClawsIssue(before.id);
  if (after) emitStageChanged(repos, before.id, before.lifecycle, after.lifecycle);
}

/** Mirrors the façade's contract: true means the label is confirmed absent afterwards. */
export async function removeLabel(repo: string, ref: IssueRef, label: string): Promise<boolean> {
  const id = requireIssueId(ref);
  const before = isStateLabel(label) ? await db.getClawsIssue(id) : undefined;
  if (await db.removeClawsIssueLabel(id, label)) {
    const repos = repo ? [repo] : await reposOf(id);
    emitForRepos(repos, { kind: "label-removed", number: id, related: [], detail: label });
    await emitLabelStageChange(repos, before);
  }
  return true;
}

/**
 * Set a native issue's lifecycle state in one write — the board's native move
 * and the issue page's status buttons.
 *
 * Emits the label event the equivalent label write would have, so a
 * `claws_wait_for_change` watcher sees no difference: `label-added` with the
 * new state label, or `label-removed` with the old one on a move to Ideas or
 * Planning, which carry no label.
 */
export async function setLifecycle(repo: string, ref: IssueRef, lifecycle: IssueLifecycle): Promise<void> {
  const id = requireIssueId(ref);
  const before = await requireIssue(id);
  if (!(await db.setClawsIssueLifecycle(id, lifecycle))) return;
  const repos = repo ? [repo] : before.repos;
  if (before.kind !== "shadow") emitStageChanged(repos, id, before.lifecycle, lifecycle);
  const added = labelForLifecycle(lifecycle);
  if (added !== undefined) {
    emitForRepos(repos, { kind: "label-added", number: id, related: [], detail: added });
    return;
  }
  const removed = labelForLifecycle(before.lifecycle);
  if (removed !== undefined) emitForRepos(repos, { kind: "label-removed", number: id, related: [], detail: removed });
}

/**
 * Move a native issue to Blocked and record `reason` in one write
 * (`db.blockClawsIssue`), the only way a native issue enters Blocked. Throws
 * `db.BlockedReasonRequiredError` for a blank reason, before any write.
 * Emits what {@link setLifecycle} would for the move: `stage-changed` and
 * `label-added` with the Blocked label, and nothing when the issue was
 * already Blocked and only its reason changed.
 */
export async function blockIssue(repo: string, ref: IssueRef, reason: string): Promise<void> {
  const id = requireIssueId(ref);
  const before = await requireIssue(id);
  if (!(await db.blockClawsIssue(id, reason))) return;
  const repos = repo ? [repo] : before.repos;
  emitStageChanged(repos, id, before.lifecycle, "blocked");
  emitForRepos(repos, { kind: "label-added", number: id, related: [], detail: labelForLifecycle("blocked")! });
}

/**
 * Mark an import finished: clear the `import_pending` flag
 * `issue-importer` promoted the shadow with, so the dispatchers pick the
 * issue up. Emits one `stage-changed` event (detail
 * `importing-><lifecycle>`) when the flag was set, and nothing otherwise.
 */
export async function finishImport(repo: string, ref: IssueRef): Promise<void> {
  const id = requireIssueId(ref);
  if (!(await db.finishClawsIssueImport(id))) return;
  const issue = await requireIssue(id);
  emitForRepos(repo ? [repo] : issue.repos, { kind: "stage-changed", number: id, related: [], detail: `importing->${issue.lifecycle}` });
}

/**
 * Settle an import that was interrupted before it finished — the process died
 * between promoting the shadow and closing the forge copy. Clears the
 * `import_pending` flag, parks the issue in the Backlog so nothing acts on a
 * possibly incomplete copy, and posts one comment telling the operator to
 * check it against `forgeUrl` and close the forge issue by hand.
 */
export async function abandonImport(repo: string, ref: IssueRef, forgeUrl: string): Promise<void> {
  const id = requireIssueId(ref);
  if (!(await db.finishClawsIssueImport(id))) return;
  await setLifecycle(repo, id, "backlog");
  await commentOnIssue(
    repo,
    id,
    `This issue was imported from ${forgeUrl}, but the import was interrupted before it finished, so its comments or attachments may be incomplete and the forge issue may still be open. Claws moved it to the Backlog: check it against the forge issue, close that by hand if it is still open, then move this issue back onto the board.`,
    CLAWS_NATIVE_LOGIN,
  );
}

/**
 * Set a forge issue's shadow to `lifecycle` in one write, without touching
 * its approval fields — the plain-write counterpart to {@link promoteIssue}
 * and {@link demoteIssue} for a shadow moving between the columns that carry
 * no approval of their own (Awaiting plan review, Approved, Blocked,
 * Backlog). A shadow's events come from its forge, so this emits nothing.
 */
export async function setShadowLifecycle(ref: IssueRef, lifecycle: IssueLifecycle): Promise<void> {
  const id = requireIssueId(ref);
  await db.setShadowLifecycle(id, lifecycle);
}

/**
 * The write helpers return false for an unknown id. The forge backends throw
 * in that situation and the reads here do too (`requireIssue`), so a silent
 * no-op would be the odd one out — an agent's edit would vanish.
 */
function requireChanged(changed: boolean, ref: IssueRef): void {
  if (!changed) throw new Error(`claws-issues: no native issue ${String(ref)}`);
}

export async function editIssue(ref: IssueRef, body: string): Promise<void> {
  requireChanged(await db.updateClawsIssueBody(requireIssueId(ref), body), ref);
}

export async function editIssueTitle(ref: IssueRef, title: string): Promise<void> {
  requireChanged(await db.updateClawsIssueTitle(requireIssueId(ref), title), ref);
}

/**
 * Close a native issue.
 *
 * `issue-closed` is emitted only when the state actually changed: the merger
 * and the auditor both close on a merged PR, and the second one through must
 * not wake every `claws_wait_for_change` waiter a second time.
 */
export async function closeIssue(
  repo: string,
  ref: IssueRef,
  stateReason?: "completed" | "not_planned",
): Promise<void> {
  const id = requireIssueId(ref);
  const issue = await requireIssue(id);
  if (!(await db.setClawsIssueState(id, "closed", stateReason ?? null))) return;
  emitForRepos(repo ? [repo] : issue.repos, { kind: "issue-closed", number: id, related: [], detail: stateReason });
}

/** Reopen a native issue. The façade has no reopen — only the dashboard offers one. */
export async function reopenIssue(ref: IssueRef): Promise<void> {
  const id = requireIssueId(ref);
  const issue = await requireIssue(id);
  if (!(await db.setClawsIssueState(id, "open"))) return;
  emitForRepos(issue.repos, { kind: "issue-reopened", number: id, related: [] });
}

/**
 * Replace the repo association wholesale (the dashboard's repo chips). A model
 * plan is keyed to the issue's primary repo, so it survives only while that
 * repo stays primary; any other resulting repo set clears the orphaned rows.
 */
export async function setRepos(ref: IssueRef, repos: readonly string[]): Promise<void> {
  const id = requireIssueId(ref);
  await db.setClawsIssueRepos(id, repos);
  const record = await db.getClawsIssue(id);
  await db.deleteIssueModelPlanRowsExceptRepo(id, primaryRepo({ repos, primary_repo: record?.primary_repo }) || null);
}

/**
 * Add `repos` to a native issue's repo association, returning the ones that
 * were new. The current primary repo is pinned first, so an added repo that
 * sorts earlier does not take over planning and labels. A no-op when every
 * repo is already on the issue.
 */
export async function addRepos(ref: IssueRef, repos: readonly string[]): Promise<string[]> {
  const id = requireIssueId(ref);
  const record = await requireIssue(id);
  const added = [...new Set(repos)].filter((r) => !record.repos.includes(r));
  if (added.length === 0) return [];
  const primary = primaryRepo(record);
  if (primary && record.primary_repo !== primary) await db.setClawsIssuePrimaryRepo(id, primary);
  await setRepos(id, [...record.repos, ...added]);
  return added;
}

/**
 * Append a comment authored by `authorLogin`, returning its id.
 *
 * `body` is stored verbatim: the façade has already prepended the "Automated
 * by Claws" marker for agent comments, and a human comment posted from the
 * dashboard must NOT carry it — the refiner reads that marker to tell its own
 * plans from the feedback it has to address.
 *
 * A blank body is dropped: an empty comment is invisible on the page but would
 * still wake every waiter on the issue.
 *
 * `opts.emitEvent: false` writes the comment without announcing it. Only the
 * importer passes it: replaying a whole backlog's comment threads would evict
 * the 500-slot event ring and take every waiter's backlog with it, so it emits
 * once per imported issue instead of once per comment (#3215).
 *
 * `opts.attachmentIds` limits which linked attachments become this comment's.
 * The importer passes the files it copied for the comment, so a reply that
 * links a file the body already copied leaves that file with the body.
 */
export async function commentOnIssue(
  repo: string,
  ref: IssueRef,
  body: string,
  authorLogin: string,
  opts?: { emitEvent?: boolean; attachmentIds?: readonly string[] },
): Promise<string | null> {
  if (!body.trim()) return null;
  const id = requireIssueId(ref);
  const issue = await requireIssue(id);
  const commentIdOut = await db.addClawsIssueComment(id, authorLogin, body);
  await stampCommentAttachments(id, commentIdOut, body, opts?.attachmentIds);
  if (opts?.emitEvent !== false) {
    emitForRepos(repo ? [repo] : issue.repos, {
      kind: "issue-comment",
      number: id,
      related: extractRelatedNumbers(body),
      detail: isPlanComment(body) ? "plan" : undefined,
    });
  }
  return commentIdOut;
}

/**
 * Record which comment links each of the issue's not-yet-linked attachments,
 * so the page and agents can tell a comment's files from the body's. Only
 * an attachment whose `/attachments/<id>/` path appears in `body` counts, and
 * when `only` is given, only one it names.
 */
async function stampCommentAttachments(
  issueIdValue: string,
  commentIdValue: string,
  body: string,
  only?: readonly string[],
): Promise<void> {
  if (!body.includes("/attachments/")) return;
  for (const row of await db.listClawsIssueAttachments(issueIdValue)) {
    if (only && !only.includes(row.id)) continue;
    if (row.comment_id === null && body.includes(`/attachments/${row.id}/`)) {
      await db.setClawsIssueAttachmentComment(row.id, commentIdValue);
    }
  }
}

/**
 * Replace a comment's body.
 *
 * Throws when the comment is gone, for the same reason as
 * {@link requireChanged}: this is the update half of `upsertAlertIssue`, whose
 * whole point is to edit one body rather than spam comments, and the refiner
 * edits its own plan comment in place. A silent no-op there would report
 * success and lose the write.
 */
export async function editIssueComment(ref: CommentRef, body: string): Promise<void> {
  if (!(await db.editClawsIssueComment(requireCommentId(ref), body))) {
    throw new Error(`claws-issues: no native comment ${String(ref)}`);
  }
}

/**
 * Why {@link deleteIssueComments} refused: `not-found` when an id is not a
 * live comment of the issue (unknown, on another issue, or already deleted),
 * `refused` when it is the current plan or latest requirements comment.
 */
export class IssueCommentDeleteError extends Error {
  constructor(readonly reason: "not-found" | "refused", message: string) {
    super(message);
    this.name = "IssueCommentDeleteError";
  }
}

/**
 * Soft-delete comments of a native issue as `deletedBy`
 * (docs/issue-tracker.md#deleting-comments). All or nothing: any id that is
 * not a live comment of this issue, or that is the current plan comment or
 * the latest requirements version's comment, throws an
 * {@link IssueCommentDeleteError} before anything is written. A deletion
 * never re-plans or enqueues work; it emits `issue-comment` so waiters see
 * the thread changed. Returns how many comments were deleted.
 */
export async function deleteIssueComments(ref: IssueRef, commentRefs: readonly CommentRef[], deletedBy: string): Promise<number> {
  const id = requireIssueId(ref);
  const issue = await requireIssue(id);
  if (issue.kind === "shadow") throw new Error(`claws-issues: not a native issue id: ${String(ref)}`);
  const ids = [...new Set(commentRefs.map((r) => commentId(r) ?? String(r)))];
  const live = new Set((await db.listClawsIssueComments(id)).map((c) => c.id));
  const missing = ids.filter((c) => !live.has(c));
  if (missing.length > 0) {
    throw new IssueCommentDeleteError("not-found", `Not a comment on ${id}: ${missing.join(", ")}`);
  }
  const plans = await db.listClawsIssuePlans(id);
  const planComment = plans[plans.length - 1]?.comment_id ?? null;
  if (planComment !== null && ids.includes(planComment)) {
    throw new IssueCommentDeleteError("refused", `${planComment} is the current plan comment and cannot be deleted`);
  }
  const requirements = await db.listClawsIssueRequirements(id);
  const requirementsComment = requirements[requirements.length - 1]?.comment_id ?? null;
  if (requirementsComment !== null && ids.includes(requirementsComment)) {
    throw new IssueCommentDeleteError("refused", `${requirementsComment} is the latest requirements comment and cannot be deleted`);
  }
  const deleted = await db.softDeleteClawsIssueComments(id, ids, deletedBy);
  if (deleted > 0) emitForRepos(issue.repos, { kind: "issue-comment", number: id, related: [] });
  return deleted;
}

/**
 * Store a session's revised requirements record as a new, unapproved version
 * of an existing native issue. Approval stays with the operator's paths
 * (Requirements review, then promote); this never calls {@link promoteIssue}.
 * The version listener is suppressed, so `requirements-stored` is emitted
 * here instead. Returns the new version.
 */
export async function storeSessionRequirements(ref: IssueRef, record: RequirementsRecord): Promise<number> {
  const id = requireIssueId(ref);
  const version = await db.addClawsIssueRequirementsVersion(id, record, null, { notify: false });
  const issue = await db.getClawsIssue(id);
  if (issue && issue.kind !== "shadow") {
    emitForRepos(issue.repos, { kind: "requirements-stored", number: issue.id, related: [], detail: `v${version}` });
  }
  return version;
}

export async function addReaction(ref: CommentRef, login: string, reaction: string): Promise<void> {
  await db.addClawsIssueCommentReaction(requireCommentId(ref), login, reaction);
}
