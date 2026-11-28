// Native issue comments, reactions, plan versions and requirements
// versions. Reached only through the src/db.ts façade.
import * as log from "../log.js";
import { type SqlDriver } from "../db-driver.js";
import { atLeast } from "../issue-approval.js";
import { newClawsCommentId } from "../issue-id.js";
import { isPlanComment, normalizePlanText } from "../marker-text.js";
import { type RequirementsRecord } from "../requirements-record.js";
import { getDb, nowSql, timedDb } from "./core.js";
import { type ClawsIssueCommentRow, type ClawsIssueReactionRow, isNativeIssueRow, recordIssueHistory, requireClawsIssue } from "./issues.js";

/** Append a comment and return its id. */
export async function addClawsIssueComment(issueId: string, authorLogin: string, body: string): Promise<string> {
  const now = nowSql();
  const id = newClawsCommentId();
  await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, issueId);
    await tx.run(
      `INSERT INTO claws_issue_comments (id, issue_id, author_login, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, issueId, authorLogin, body, now, now],
    );
    await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ?`, [now, issueId]);
    await recordPlanVersion(tx, issueId, id, body, now);
  });
  return id;
}

/** Replace a comment's body. Returns the owning issue id, or undefined when the comment is gone. */
export async function editClawsIssueComment(
  commentId: string,
  body: string,
  opts: { amendPlanVersion?: boolean } = {},
): Promise<string | undefined> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(`SELECT issue_id FROM claws_issue_comments WHERE id = ?`, [commentId]) as { issue_id: string } | undefined;
    if (!row) return undefined;
    await tx.run(`UPDATE claws_issue_comments SET body = ?, updated_at = ? WHERE id = ?`, [body, now, commentId]);
    await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ? AND kind <> 'shadow'`, [now, row.issue_id]);
    if (opts.amendPlanVersion) await amendLatestPlanVersion(tx, row.issue_id, commentId, body);
    else await recordPlanVersion(tx, row.issue_id, commentId, body, now);
    return row.issue_id;
  });
}

/**
 * Rewrite the text of the issue's latest plan version in place when it came
 * from `commentId` — the edit adds to the current plan rather than making a
 * new version (a post-merge operator step Claws appends,
 * `src/post-merge-step.ts`). Anything else records a version as usual.
 */
async function amendLatestPlanVersion(tx: SqlDriver, issueId: string, commentId: string, body: string): Promise<void> {
  if (!isPlanComment(body)) return;
  const latest = await tx.get(
    `SELECT version, comment_id FROM claws_issue_plans WHERE issue_id = ? ORDER BY version DESC LIMIT 1`,
    [issueId],
  ) as { version: number; comment_id: string | null } | undefined;
  if (!latest || latest.comment_id !== commentId) {
    await recordPlanVersion(tx, issueId, commentId, body, nowSql());
    return;
  }
  await tx.run(
    `UPDATE claws_issue_plans SET body = ? WHERE issue_id = ? AND version = ?`,
    [normalizePlanText(body), issueId, Number(latest.version)],
  );
}

/** One stored version of a native issue's plan: normalised text, see {@link recordPlanVersion}. */
export interface ClawsIssuePlanRow {
  issue_id: string;
  version: number;
  /** The plan comment the version came from; NULL once that comment is deleted. */
  comment_id: string | null;
  body: string;
  created_at: string;
}

/**
 * Record a new plan version when `body` is a Claws plan comment whose
 * normalised text differs from the issue's latest version. A marker-only
 * re-stamp normalises to the same text and records nothing.
 *
 * `latest + 1` is read-then-write, which is safe because plan writes for one
 * issue are serialised by the refiner's per-item lock and Claws runs a single
 * pod; a collision would fail on the primary key rather than corrupt history.
 */
async function recordPlanVersion(tx: SqlDriver, issueId: string, commentId: string, body: string, now: string): Promise<void> {
  if (!isPlanComment(body)) return;
  const text = normalizePlanText(body);
  const latest = await tx.get(
    `SELECT version, body FROM claws_issue_plans WHERE issue_id = ? ORDER BY version DESC LIMIT 1`,
    [issueId],
  ) as { version: number; body: string } | undefined;
  if (latest && latest.body === text) return;
  await tx.run(
    `INSERT INTO claws_issue_plans (issue_id, version, comment_id, body, created_at) VALUES (?, ?, ?, ?, ?)`,
    [issueId, (latest ? Number(latest.version) : 0) + 1, commentId, text, now],
  );
}

/**
 * Seed plan history from the plan comments of issues that have none yet, one
 * version per distinct plan comment in posting order. Idempotent: an issue
 * with any plan row is skipped, so a re-run is a no-op. The history of an
 * edited-in-place plan before this table existed is gone; only each comment's
 * current text is recoverable.
 */
export async function backfillClawsIssuePlans(): Promise<void> {
  return timedDb("backfill-claws-issue-plans", () => backfillClawsIssuePlansUntimed());
}

async function backfillClawsIssuePlansUntimed(): Promise<void> {
  const rows = await getDb().all(
    `SELECT c.id, c.issue_id, c.body, c.updated_at FROM claws_issue_comments c
     WHERE c.body LIKE '%## Implementation Plan%'
       AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM claws_issue_plans p WHERE p.issue_id = c.issue_id)
     ORDER BY c.issue_id, c.id`,
  ) as Array<{ id: string; issue_id: string; body: string; updated_at: string }>;
  if (rows.length === 0) return;
  await getDb().transaction(async (tx) => {
    for (const row of rows) await recordPlanVersion(tx, row.issue_id, row.id, row.body, row.updated_at);
  });
}

/** Every stored version of a native issue's plan, oldest first. */
export async function listClawsIssuePlans(issueId: string): Promise<ClawsIssuePlanRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_plans WHERE issue_id = ? ORDER BY version ASC`,
    [issueId],
  ) as ClawsIssuePlanRow[];
  return rows.map((r) => ({ ...r, version: Number(r.version) }));
}

/**
 * The latest plan version of every open native issue, keyed by issue id.
 * Shadows are excluded — they carry no comments. A join rather than an id
 * list, so there is no bind-parameter limit to hit.
 */
export async function listLatestClawsIssuePlansForOpenIssues(): Promise<Map<string, ClawsIssuePlanRow>> {
  const rows = await getDb().all(
    `SELECT p.* FROM claws_issue_plans p
     JOIN claws_issues i ON i.id = p.issue_id
     JOIN (SELECT issue_id, MAX(version) AS version FROM claws_issue_plans GROUP BY issue_id) m
       ON m.issue_id = p.issue_id AND m.version = p.version
     WHERE i.state = 'open' AND i.kind <> 'shadow'`,
  ) as ClawsIssuePlanRow[];
  return new Map(rows.map((r) => [r.issue_id, { ...r, version: Number(r.version) }]));
}

/** One stored version of an issue's requirements record; the list columns parsed. */
export interface ClawsIssueRequirementsRow {
  issue_id: string;
  version: number;
  title: string;
  kind: RequirementsRecord["kind"];
  context: string;
  requirement: string;
  acceptance_criteria: string[];
  out_of_scope: string[];
  /** The `## Requirements` comment the version was rendered into — native or forge. */
  comment_id: string | null;
  created_at: string;
}

function parseStringList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function toRequirementsRow(row: Record<string, unknown>): ClawsIssueRequirementsRow {
  return {
    issue_id: String(row.issue_id),
    version: Number(row.version),
    title: String(row.title),
    kind: row.kind === "bug" ? "bug" : "feature",
    context: String(row.context),
    requirement: String(row.requirement),
    acceptance_criteria: parseStringList(row.acceptance_criteria),
    out_of_scope: parseStringList(row.out_of_scope),
    comment_id: row.comment_id == null ? null : String(row.comment_id),
    created_at: String(row.created_at),
  };
}

/**
 * Record a new version of an issue's requirements record and return its
 * number — the latest stored version + 1. `issueId` is the tracker id: a
 * native issue's own id, or a forge issue's shadow. The same read-then-write
 * as {@link recordPlanVersion}, safe for the same reason: writer runs for one
 * issue are serialised by the work queue's per-item lock, and a collision
 * fails on the primary key rather than corrupting history.
 *
 * Once the version is stored the listener set with
 * {@link setRequirementsVersionListener} runs — `claws-issues.ts`'s
 * auto-promotion. It runs here, where the write lands, so an agent pod's
 * remote call reaches it through the ops API exactly as an in-process
 * writer's direct call does.
 */
export async function addClawsIssueRequirementsVersion(
  issueId: string,
  record: RequirementsRecord,
  commentId: string | null,
  opts?: { notify?: boolean },
): Promise<number> {
  const version = await insertClawsIssueRequirementsVersion(issueId, record, commentId);
  if (opts?.notify === false) return version;
  try {
    await requirementsVersionListener?.(issueId, version);
  } catch (err) {
    // The version is stored either way; a failed promotion is left for a human.
    log.warn(`[db] Requirements v${version} of ${issueId}: listener failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return version;
}

let requirementsVersionListener: ((issueId: string, version: number) => Promise<void>) | undefined;

/**
 * Register what runs after {@link addClawsIssueRequirementsVersion} stores a
 * version. A setter rather than an import: `claws-issues.ts`, which owns
 * promotion, sits above this module.
 */
export function setRequirementsVersionListener(listener: ((issueId: string, version: number) => Promise<void>) | undefined): void {
  requirementsVersionListener = listener;
}

async function insertClawsIssueRequirementsVersion(issueId: string, record: RequirementsRecord, commentId: string | null): Promise<number> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    const latest = await tx.get(
      `SELECT MAX(version) AS version FROM claws_issue_requirements WHERE issue_id = ?`,
      [issueId],
    ) as { version: number | null } | undefined;
    const version = (latest?.version == null ? 0 : Number(latest.version)) + 1;
    await tx.run(
      `INSERT INTO claws_issue_requirements (issue_id, version, title, kind, context, requirement, acceptance_criteria, out_of_scope, comment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [issueId, version, record.title, record.kind, record.context, record.requirement,
        JSON.stringify(record.acceptanceCriteria), JSON.stringify(record.outOfScope), commentId, now],
    );
    if (await isNativeIssueRow(tx, issueId)) await recordIssueHistory(tx, issueId, "requirements", null, `v${version} stored`);
    return version;
  });
}

/** Every stored version of an issue's requirements record, oldest first. */
export async function listClawsIssueRequirements(issueId: string): Promise<ClawsIssueRequirementsRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_requirements WHERE issue_id = ? ORDER BY version ASC`,
    [issueId],
  ) as Array<Record<string, unknown>>;
  return rows.map(toRequirementsRow);
}

/**
 * The latest requirements version of every open issue, keyed by tracker id —
 * the dispatcher's once-per-tick read. Unlike
 * {@link listLatestClawsIssuePlansForOpenIssues} this includes shadows: the
 * writer records a forge issue's versions against its shadow row.
 */
export async function listLatestClawsIssueRequirementsForOpenIssues(): Promise<Map<string, ClawsIssueRequirementsRow>> {
  const rows = await getDb().all(
    `SELECT r.* FROM claws_issue_requirements r
     JOIN claws_issues i ON i.id = r.issue_id
     JOIN (SELECT issue_id, MAX(version) AS version FROM claws_issue_requirements GROUP BY issue_id) m
       ON m.issue_id = r.issue_id AND m.version = r.version
     WHERE i.state = 'open'`,
  ) as Array<Record<string, unknown>>;
  return new Map(rows.map((r) => {
    const row = toRequirementsRow(r);
    return [row.issue_id, row];
  }));
}

/**
 * The ids of open native issues in `ideas` that skip the requirements stage
 * and are held for a human (`requirements_stage = 0`, `auto_promote = 0`) —
 * the board's once-per-render read for putting such an issue with no
 * requirements version in Requirements review (`claws-issues.ts`'s
 * `heldWithoutWriter`). Shadows are excluded.
 */
export async function listHeldStageOffOpenIdeasIssueIds(): Promise<Set<string>> {
  const rows = await getDb().all(
    `SELECT id FROM claws_issues
     WHERE state = 'open' AND kind <> 'shadow' AND lifecycle = 'ideas'
       AND requirements_stage = 0 AND auto_promote = 0`,
  ) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * The comments that may be feedback on the latest requirements version of an
 * open issue in `ideas` — the board's once-per-render read for telling
 * Drafting from Requirements review (`claws-issues.ts`'s
 * `getRequirementsFeedbackPending`). Already narrowed here to comments posted
 * at or after the latest version, not by `clawsLogin` or a `[bot]` login, and
 * not 👍'd by `clawsLogin` (feedback a refine run already addressed). Bodies
 * ride along so the caller can drop Claws-marked and `## Requirements` ones.
 */
export async function listClawsIssueCommentsForOpenIdeasIssues(clawsLogin: string): Promise<Array<Pick<ClawsIssueCommentRow, "issue_id" | "author_login" | "body" | "created_at">>> {
  return await getDb().all(
    `SELECT c.issue_id, c.author_login, c.body, c.created_at
     FROM claws_issue_comments c
     JOIN claws_issues i ON i.id = c.issue_id
     JOIN (SELECT issue_id, MAX(created_at) AS created_at FROM claws_issue_requirements GROUP BY issue_id) r
       ON r.issue_id = c.issue_id
     WHERE i.state = 'open' AND i.lifecycle = 'ideas'
       AND c.deleted_at IS NULL
       AND c.created_at >= r.created_at
       AND c.author_login <> ? AND c.author_login NOT LIKE '%[bot]'
       AND NOT EXISTS (SELECT 1 FROM claws_issue_comment_reactions x
                       WHERE x.comment_id = c.id AND x.login = ? AND x.content = '+1')
     ORDER BY c.id ASC`,
    [clawsLogin, clawsLogin],
  ) as Array<Pick<ClawsIssueCommentRow, "issue_id" | "author_login" | "body" | "created_at">>;
}

/** A requirements row plus who approved it — {@link listApprovedClawsIssueRequirementsForOpenIssues}'s shape. */
export interface ClawsIssueApprovedRequirementsRow extends ClawsIssueRequirementsRow {
  approved_by: string | null;
  approved_at: string | null;
}

/**
 * The approved requirements version of every open issue that has one, keyed
 * by tracker id — a dispatcher tick's batched read, so it does not run
 * `getClawsIssue` + `listClawsIssueRequirements` once per issue (see
 * `approvedRequirementsFromBatch` in approved-requirements.ts).
 */
export async function listApprovedClawsIssueRequirementsForOpenIssues(): Promise<Map<string, ClawsIssueApprovedRequirementsRow>> {
  const rows = await getDb().all(
    `SELECT r.*, i.requirements_approved_by AS approved_by, i.requirements_approved_at AS approved_at
     FROM claws_issue_requirements r
     JOIN claws_issues i ON i.id = r.issue_id AND i.approved_requirements_version = r.version
     WHERE i.state = 'open'`,
  ) as Array<Record<string, unknown>>;
  return new Map(rows.map((r) => {
    const row = toRequirementsRow(r);
    const approved: ClawsIssueApprovedRequirementsRow = {
      ...row,
      approved_by: r.approved_by == null ? null : String(r.approved_by),
      approved_at: r.approved_at == null ? null : String(r.approved_at),
    };
    return [row.issue_id, approved];
  }));
}

/**
 * Record that `approvedBy` approved requirements `version` of an issue (NULL
 * when it was promoted with no record yet). Returns false when no such issue
 * exists.
 */
export async function approveClawsIssueRequirements(issueId: string, version: number | null, approvedBy: string): Promise<boolean> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(
      `SELECT kind, approved_requirements_version, approved_through FROM claws_issues WHERE id = ?`,
      [issueId],
    ) as { kind: string; approved_requirements_version: number | null; approved_through: string } | undefined;
    // Approved requirements mean approved through Requirements at least, as on promotion.
    const raise = !!old && !atLeast(old.approved_through, "requirements");
    const result = await tx.run(
      `UPDATE claws_issues SET approved_requirements_version = ?, requirements_approved_by = ?, requirements_approved_at = ?, updated_at = ?${raise ? ", approved_through = 'requirements', approved_through_by = ?, approved_through_at = ?" : ""} WHERE id = ?`,
      [version, approvedBy, now, now, ...(raise ? [approvedBy, now] : []), issueId],
    );
    if (result.changes > 0 && old?.kind === "issue") {
      await recordIssueHistory(tx, issueId, "requirements approved", requirementsVersionLabel(old.approved_requirements_version), requirementsVersionLabel(version));
      if (raise) await recordIssueHistory(tx, issueId, "approved_through", old.approved_through, "requirements");
    }
    return result.changes > 0;
  });
}

/** How History shows an approved requirements version: `v<N>`, or `none` for a promotion with no record. */
export function requirementsVersionLabel(version: number | null | undefined): string {
  return version == null ? "none" : `v${Number(version)}`;
}

/**
 * A native issue's comments in posting order, soft-deleted ones left out.
 *
 * `ORDER BY id` is exact, not approximate: comment ids are monotonic ULIDs, so
 * their lexical order is their creation order.
 */
export async function listClawsIssueComments(issueId: string): Promise<ClawsIssueCommentRow[]> {
  return await getDb().all(
    `SELECT * FROM claws_issue_comments WHERE issue_id = ? AND deleted_at IS NULL ORDER BY id ASC`,
    [issueId],
  ) as ClawsIssueCommentRow[];
}

/** How much of a deleted comment's body its History entry keeps. */
const DELETED_COMMENT_EXCERPT_MAX = 200;

/**
 * Soft-delete the live comments of `issueId` named in `commentIds`, stamping
 * `deleted_at` and `deleted_by` rather than removing the rows
 * (docs/issue-tracker.md#deleting-comments). Ids that are not live comments
 * of this issue are skipped. A native issue gets one `comment` History entry
 * per deleted comment — `<id> by <author>: <excerpt>` → NULL. Deliberately
 * leaves `claws_issues.updated_at` alone: a deletion is not activity and must
 * not look like feedback. Returns how many comments it deleted.
 */
export async function softDeleteClawsIssueComments(issueId: string, commentIds: readonly string[], deletedBy: string): Promise<number> {
  const ids = [...new Set(commentIds)];
  if (ids.length === 0) return 0;
  const now = nowSql();
  const inList = ids.map(() => "?").join(", ");
  return await getDb().transaction(async (tx) => {
    const rows = await tx.all(
      `SELECT id, author_login, body FROM claws_issue_comments
       WHERE issue_id = ? AND id IN (${inList}) AND deleted_at IS NULL ORDER BY id ASC`,
      [issueId, ...ids],
    ) as Array<Pick<ClawsIssueCommentRow, "id" | "author_login" | "body">>;
    if (rows.length === 0) return 0;
    const result = await tx.run(
      `UPDATE claws_issue_comments SET deleted_at = ?, deleted_by = ?
       WHERE issue_id = ? AND id IN (${rows.map(() => "?").join(", ")}) AND deleted_at IS NULL`,
      [now, deletedBy, issueId, ...rows.map((r) => r.id)],
    );
    if (await isNativeIssueRow(tx, issueId)) {
      for (const row of rows) {
        const text = row.body.trim().replace(/\s+/g, " ");
        const excerpt = text.length > DELETED_COMMENT_EXCERPT_MAX ? `${text.slice(0, DELETED_COMMENT_EXCERPT_MAX)}…` : text;
        await recordIssueHistory(tx, issueId, "comment", `${row.id} by ${row.author_login}: ${excerpt}`, null);
      }
    }
    return Number(result.changes);
  });
}

/**
 * Record a reaction. Re-reacting with the same content is a no-op.
 *
 * Bumps the owning issue's `updated_at` like every other write here: a
 * reaction is how `issue-refiner` marks feedback addressed, so an issue whose
 * only change this cycle was a reaction must not keep a stale timestamp and
 * sort wrongly in {@link listOpenClawsIssues}'s `ORDER BY updated_at DESC`.
 */
export async function addClawsIssueCommentReaction(commentId: string, login: string, content: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const parent = await tx.get(`SELECT issue_id FROM claws_issue_comments WHERE id = ?`, [commentId]) as { issue_id: string } | undefined;
    if (!parent) throw new Error(`claws-issues: no native comment ${commentId}`);
    const res = await tx.run(
      `INSERT OR IGNORE INTO claws_issue_comment_reactions (comment_id, login, content) VALUES (?, ?, ?)`,
      [commentId, login, content],
    );
    if (res.changes > 0) await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ? AND kind <> 'shadow'`, [nowSql(), parent.issue_id]);
  });
}

/** Every reaction on a comment. */
export async function listClawsIssueCommentReactions(commentId: string): Promise<ClawsIssueReactionRow[]> {
  return await getDb().all(
    `SELECT comment_id, login, content FROM claws_issue_comment_reactions WHERE comment_id = ? ORDER BY login ASC, content ASC`,
    [commentId],
  ) as ClawsIssueReactionRow[];
}

