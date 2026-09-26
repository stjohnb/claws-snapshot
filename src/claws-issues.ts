/**
 * Claws-native issue store — the third issue backend behind the `github.ts`
 * façade, alongside GitHub and Forgejo (see docs/issue-tracker.md).
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
import { labelForLifecycle, type IssueLifecycle } from "./issue-lifecycle.js";
import { attachmentUrl } from "./issue-attachments.js";
import { isPlanComment } from "./marker-text.js";
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
  /** When the issue entered its current board column; `updatedAt` for a row that predates the column. */
  stageSince?: string;
  /** The stored lifecycle, which tells Ideas from Planning — the two carry no label. */
  lifecycle?: IssueLifecycle;
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
  return {
    number: record.id,
    title: record.title,
    body: record.body,
    labels: record.labels.map((name) => ({ name })),
    author: { login: record.author_login },
    updatedAt: toIso(record.updated_at),
    stageSince: toIso(record.stage_changed_at ?? record.updated_at),
    lifecycle: record.lifecycle,
  };
}

function toComment(row: db.ClawsIssueCommentRow): IssueComment {
  return { id: row.id, body: row.body, body_html: renderMarkdown(row.body), login: row.author_login };
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

/** Dashboard URL for a native issue — what `transferIssue` returns and pages link to. */
export function dashboardIssueUrl(ref: IssueRef): string {
  const base = DASHBOARD_URL?.replace(/\/+$/, "") ?? "";
  return `${base}/issues/${canonicalIssueRef(ref) ?? String(ref)}`;
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

async function reposOf(id: string): Promise<string[]> {
  return (await db.getClawsIssue(id))?.repos ?? [];
}

/**
 * A native issue's primary repo: the alphabetically first of its repos, or
 * `""` when it has none. The primary repo owns planning, labels and phase
 * sequencing; each planned PR is implemented in its own entry's repo.
 */
export function primaryRepo(repos: readonly string[]): string {
  return [...repos].sort()[0] ?? "";
}

// ── Reads ──

/**
 * Open native issues whose primary repo is `repo` — the ones that repo's
 * automation acts on. A multi-repo issue is listed under its primary repo
 * only (see {@link primaryRepo}).
 */
export async function listOpenIssues(repo: string): Promise<Issue[]> {
  return (await db.listOpenClawsIssues({ repo })).map(toIssue);
}

export async function listIssuesByLabel(repo: string, label: string): Promise<Issue[]> {
  return (await db.listOpenClawsIssues({ repo, label })).map(toIssue);
}

/** Open native issues with no repo yet — invisible to automation until one is assigned. */
export async function listUnassignedOpenIssues(): Promise<db.ClawsIssueRecord[]> {
  return await db.listOpenClawsIssues({ unassigned: true });
}

/**
 * Native issues closed at or after `since` whose primary repo is `repo`, newest
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
  return (await db.listClawsIssueComments(requireIssueId(ref))).filter((c) => c.body.trim()).map(toComment);
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

/** Comments for the dashboard's issue page, which shows when each was posted. */
export async function listCommentDetails(ref: IssueRef): Promise<IssueCommentDetail[]> {
  return (await db.listClawsIssueComments(requireIssueId(ref)))
    .filter((c) => c.body.trim())
    .map((c) => ({ ...toComment(c), createdAt: toIso(c.created_at) }));
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
export async function getOpenShadowStages(): Promise<Map<string, { id: string; lifecycle: IssueLifecycle }>> {
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
}): Promise<string> {
  return await db.createClawsIssue(input);
}

// ── Promotion (docs/refinements/issue-flow.md "Promotion") ──

/** Sources a human is watching: their requirements wait for approval by default. */
export const ATTENDED_SOURCES: ReadonlySet<db.IssueSource> = new Set(["dashboard", "session", "whatsapp"]);

/**
 * Whether the issue's first requirements version promotes it to Planning
 * without a human. The per-issue `auto_promote` choice wins; then the primary
 * repo's `claws.json` `autoPromote` for the issue's side (attended or
 * unattended); then the source's default — an attended issue waits, an
 * unattended one promotes.
 */
export function shouldAutoPromote(issue: Pick<db.ClawsIssueRecord, "source" | "auto_promote" | "repos">): boolean {
  if (issue.auto_promote !== null) return issue.auto_promote === 1;
  const attended = ATTENDED_SOURCES.has(issue.source);
  const policy = getAutoPromotePolicy(primaryRepo(issue.repos));
  return (attended ? policy.attended : policy.unattended) ?? !attended;
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
  return true;
}

/**
 * Send an issue back to Ideas: clear its approval, keep its requirements
 * versions, and skip any planner run still queued for it. A planner already
 * running is left to finish; a plan it posts moves the issue on as usual.
 */
export async function demoteIssue(ref: IssueRef): Promise<void> {
  const id = requireIssueId(ref);
  const before = await db.getClawsIssue(id);
  if (!before) throw new Error(`claws-issues: no native issue ${String(ref)}`);
  await db.demoteClawsIssue(id);
  await db.skipQueuedPlannerWork(id, "issue sent back to Ideas");
  if (before.kind === "shadow") return;
  const removed = labelForLifecycle(before.lifecycle);
  if (removed !== undefined) emitForRepos(before.repos, { kind: "label-removed", number: id, related: [], detail: removed });
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
  if (!issue || issue.state !== "open" || issue.lifecycle !== "ideas" || !shouldAutoPromote(issue)) return;
  await promoteIssue(issueIdValue, CLAWS_NATIVE_LOGIN, "ideas");
}

/**
 * The level-triggered counterpart to {@link autoPromoteOnFirstVersion}, for
 * an issue the listener never got to fire for: its version predates the
 * listener (this deploy's migration moved it from `inbox` to `ideas` with a
 * version already on record), or it landed while `requirements-writer` was
 * disabled. The issue dispatcher calls this on every tick for an issue it
 * finds in Ideas, passing `requirementsReady` — a version already exists, or
 * none ever will because the writer is disabled, in which case decision 10
 * lets the promotion plan from the body. A no-op once the issue has left
 * Ideas or already has a recorded approval, so a demotion in between (which
 * also sets the per-issue `auto_promote` override to wait) is not undone here.
 */
export async function autoPromoteIfDue(ref: IssueRef, requirementsReady: boolean): Promise<void> {
  if (!requirementsReady) return;
  const id = requireIssueId(ref);
  const issue = await db.getClawsIssue(id);
  if (!issue || issue.state !== "open" || issue.lifecycle !== "ideas" || issue.requirements_approved_at != null || !shouldAutoPromote(issue)) return;
  await promoteIssue(id, CLAWS_NATIVE_LOGIN, "ideas");
}

export async function addLabel(repo: string, ref: IssueRef, label: string): Promise<void> {
  const id = requireIssueId(ref);
  if (await db.addClawsIssueLabel(id, label)) {
    emitForRepos(repo ? [repo] : await reposOf(id), { kind: "label-added", number: id, related: [], detail: label });
  }
}

/** Mirrors the façade's contract: true means the label is confirmed absent afterwards. */
export async function removeLabel(repo: string, ref: IssueRef, label: string): Promise<boolean> {
  const id = requireIssueId(ref);
  if (await db.removeClawsIssueLabel(id, label)) {
    emitForRepos(repo ? [repo] : await reposOf(id), { kind: "label-removed", number: id, related: [], detail: label });
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
  const added = labelForLifecycle(lifecycle);
  if (added !== undefined) {
    emitForRepos(repos, { kind: "label-added", number: id, related: [], detail: added });
    return;
  }
  const removed = labelForLifecycle(before.lifecycle);
  if (removed !== undefined) emitForRepos(repos, { kind: "label-removed", number: id, related: [], detail: removed });
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
 * "Transfer" a native issue: there is nothing to move, so the repo association
 * is simply replaced. Returns the dashboard URL, matching the forge façade's
 * "URL of the issue in its new home" contract.
 */
export async function transferIssue(ref: IssueRef, destinationRepo: string): Promise<string> {
  const id = requireIssueId(ref);
  await db.setClawsIssueRepos(id, [destinationRepo]);
  await db.deleteIssueModelPlanRowsExceptRepo(id, destinationRepo);
  return dashboardIssueUrl(id);
}

/**
 * Replace the repo association wholesale (the dashboard's repo chips). A model
 * plan is keyed to the issue's primary repo, so it survives only while that
 * repo stays primary; any other resulting repo set clears the orphaned rows.
 */
export async function setRepos(ref: IssueRef, repos: readonly string[]): Promise<void> {
  const id = requireIssueId(ref);
  await db.setClawsIssueRepos(id, repos);
  await db.deleteIssueModelPlanRowsExceptRepo(id, primaryRepo(repos) || null);
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

export async function addReaction(ref: CommentRef, login: string, reaction: string): Promise<void> {
  await db.addClawsIssueCommentReaction(requireCommentId(ref), login, reaction);
}
