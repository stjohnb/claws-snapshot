// Claws-native issue tracker records: rows, history, dedupe keys, listing,
// title/body/state/labels, lifecycle, approval and repos. Reached only
// through the src/db.ts façade; sibling modules share its helpers.
import { type SqlDriver } from "../db-driver.js";
import { type ApprovedThrough, atLeast } from "../issue-approval.js";
import { currentIssueActor, currentRunId } from "../issue-history-actor.js";
import { newClawsIssueId, newUlid } from "../issue-id.js";
import { type IssueLifecycle, RETIRED_GATE_LABELS, labelForLifecycle, lifecycleForLabel, splitStateLabels } from "../issue-lifecycle.js";
import { getDb, nowSql, timedDb } from "./core.js";
import { requirementsVersionLabel } from "./issue-comments.js";

// ── Claws-native issue tracker ──

export interface ClawsIssueRow {
  id: string;
  title: string;
  body: string;
  author_login: string;
  state: string;
  state_reason: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /**
   * `issue` — an operator-facing native issue. `shadow` — the native backing
   * record of an issue that is still live on a forge (#3246).
   *
   * A shadow is a `claws_issues` row and not a table of its own precisely so
   * that every column added here covers it too. It is invisible to the
   * dispatchers, the board and `/issues` because {@link listOpenClawsIssues}
   * and {@link listClosedClawsIssuesSince} exclude it; {@link getClawsIssue}
   * still returns one, so the page can redirect to the forge.
   */
  kind: "issue" | "shadow";
  /**
   * When `issue-shadow-sync` last examined this shadow, successfully or not;
   * NULL on every `issue` row and on a shadow no run has reached yet. Separate
   * from `updated_at` because "we looked" and "something changed" are
   * different facts and a checked-but-unchanged shadow deliberately records
   * only the first; {@link listShadowIssues} orders on it (#3246).
   */
  shadow_checked_at: string | null;
  /**
   * The issue's lifecycle state, stored here rather than as `Blocked` /
   * `Backlog` label rows. {@link toClawsRecords} adds the matching
   * label to `labels`, and {@link addClawsIssueLabel} /
   * {@link removeClawsIssueLabel} turn a state-label write into a write here.
   */
  lifecycle: IssueLifecycle;
  /**
   * How far along the Requirements → Plan → Merge track the issue is approved
   * (`issue-approval.ts`); written only by {@link setClawsIssueApprovedThrough}
   * and the promotion writes. Absent on a hand-built row, which reads as `none`.
   */
  approved_through?: ApprovedThrough;
  /** Who last set {@link approved_through}: a login, an agent or `migration`. */
  approved_through_by?: string | null;
  /** When {@link approved_through} was last set. */
  approved_through_at?: string | null;
  /**
   * When {@link approved_through} last rose to `plan` or beyond from below;
   * NULL while it is below `plan`. Unlike {@link approved_through_at}, a
   * Plan ↔ Merge change leaves it as it is.
   */
  plan_approved_at?: string | null;
  /**
   * When an operator pressed Start anyway on the issue's file-overlap hold
   * ({@link setClawsIssueOverlapHoldLifted}); NULL, or absent on a hand-built
   * row, while no hold is lifted. Cleared when the issue closes.
   */
  overlap_hold_lifted_at?: string | null;
  /** Who pressed Start anyway: a dashboard login or a session's operator. */
  overlap_hold_lifted_by?: string | null;
  /**
   * When the issue entered its current board column: set on every `lifecycle`
   * change and close/reopen. NULL on a row that
   * predates the column — readers fall back to `updated_at`.
   */
  stage_changed_at: string | null;
  /**
   * The board column the issue-dispatcher's sweep last recorded for the issue
   * ({@link recordIssueBoardColumns}); NULL, or absent on a hand-built row,
   * until the first sweep.
   */
  board_column?: string | null;
  /**
   * When the issue entered {@link board_column}. Only a column change moves
   * it — comments, edits and `updated_at` bumps do not.
   */
  board_column_at?: string | null;
  /** The approved `claws_issue_requirements` version; NULL until promotion. */
  approved_requirements_version: number | null;
  /** Who approved it — a dashboard login, or `claws` for auto-promotion. */
  requirements_approved_by: string | null;
  requirements_approved_at: string | null;
  /** Where the issue came from; decides whether its requirements auto-promote. */
  source: IssueSource;
  /** Per-issue promotion override: 1 auto-promotes, 0 waits for a human, NULL follows the source default. */
  auto_promote: number | null;
  /**
   * 1 when the issue goes through the requirements stage, 0 when it goes
   * straight to Planning with no record; NULL, or absent on a hand-built row,
   * reads as 1 (`requirementsStageApplies`).
   */
  requirements_stage?: number | null;
  /** The title the issue was filed under, once promotion renamed it; NULL otherwise. */
  filed_title: string | null;
  /**
   * Retired column, never read: a record's value is the first of
   * {@link ClawsIssueRecord.dedupe_keys}, or NULL when it holds none.
   */
  dedupe_key: string | null;
  /**
   * The repo pinned as the issue's primary ({@link primaryRepoOf}); NULL, or
   * absent on a hand-built row, when the alphabetical rule applies.
   */
  primary_repo?: string | null;
  /**
   * The `YYYY-MM-DD` day an issue parked in the Backlog returns on
   * ({@link setClawsIssueBacklogUntil}); NULL, or absent on a hand-built row,
   * when it has none. Cleared whenever the issue leaves `backlog`.
   */
  backlog_until?: string | null;
  /** When {@link backlog_until} was set. */
  backlog_until_at?: string | null;
  /**
   * 1 while `issue-importer` is still assembling the issue
   * ({@link promoteShadowIssue}'s `importPending`, cleared by
   * {@link finishClawsIssueImport}); 0, or absent on a hand-built row,
   * otherwise. Read as {@link ClawsIssueRecord.importPending}.
   */
  import_pending?: number;
  /**
   * Which alert path filed the issue ({@link setClawsIssueAlertKind}); NULL,
   * or absent on a hand-built row, when it is not an alert.
   */
  alert_kind?: string | null;
  /** When the outage-plan Slack page last went out ({@link claimClawsIssueOutageNotice}); NULL when never. */
  alert_attention_notified_at?: string | null;
}

/**
 * Where an issue came from (docs/refinements/issue-flow.md "Promotion"). A
 * human files a `dashboard`, `whatsapp` or `forge` issue by hand, so it goes
 * through the requirements stage ({@link HUMAN_ISSUE_SOURCES}); a `session`,
 * `agent` or `automation` issue skips it and goes straight to Planning. Of the
 * hand-filed ones, `dashboard` and `whatsapp` records wait for approval and a
 * `forge` one auto-promotes by default.
 */
export const ISSUE_SOURCES = ["dashboard", "session", "agent", "automation", "whatsapp", "forge"] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

/** The sources a human files by hand: only these get a requirements record by default. */
export const HUMAN_ISSUE_SOURCES: readonly IssueSource[] = ["dashboard", "whatsapp", "forge"];

/** An issue row with its repo associations and labels resolved. */
export interface ClawsIssueRecord extends ClawsIssueRow {
  repos: string[];
  labels: string[];
  /**
   * Every dedupe key the issue holds (`claws_issue_dedupe_keys`), oldest
   * first; {@link ClawsIssueRow.dedupe_key} is the first of them.
   */
  dedupe_keys: string[];
  /** True while `issue-importer` is still assembling the issue: every dispatcher holds it. */
  importPending: boolean;
}

export interface ClawsIssueCommentRow {
  id: string;
  issue_id: string;
  author_login: string;
  body: string;
  created_at: string;
  updated_at: string;
  /** When the comment was soft-deleted; the reads filter such rows out, so this is NULL on what they return. */
  deleted_at: string | null;
  /** Who soft-deleted the comment: `operator:<login>` or `session:<id>`. */
  deleted_by: string | null;
}

export interface ClawsIssueReactionRow {
  comment_id: string;
  login: string;
  content: string;
}

/**
 * Labels and repos for the issues `tail` selects, keyed by issue id.
 *
 * `tail` is the caller's own `WHERE … ORDER BY … LIMIT …` re-used verbatim as
 * a subquery, not a list of ids: scoped exactly the same way, but with no
 * `IN (?, ?, …)` to blow past Postgres' 65535 bind parameters or SQLite's
 * `SQLITE_MAX_VARIABLE_NUMBER` — `listOpenClawsIssues` has no `LIMIT`, so
 * enough open issues would have failed the read outright and taken every
 * dispatcher down with it rather than degrading.
 *
 * Every reader goes through here so the three cannot drift into opposite
 * rules about what a sidecar is scoped to.
 */
export async function loadIssueSidecars(tail: string, params: readonly unknown[]): Promise<IssueSidecars> {
  const scope = `issue_id IN (SELECT id FROM claws_issues ${tail})`;
  const [repoRows, labelRows, keyRows] = await Promise.all([
    getDb().all(`SELECT issue_id, repo FROM claws_issue_repos WHERE ${scope} ORDER BY repo ASC`, [...params]) as Promise<{ issue_id: string; repo: string }[]>,
    getDb().all(`SELECT issue_id, label FROM claws_issue_labels WHERE ${scope} ORDER BY label ASC`, [...params]) as Promise<{ issue_id: string; label: string }[]>,
    getDb().all(`SELECT issue_id, dedupe_key FROM claws_issue_dedupe_keys WHERE ${scope} ORDER BY created_at ASC, dedupe_key ASC`, [...params]) as Promise<{ issue_id: string; dedupe_key: string }[]>,
  ]);
  return { repos: groupBySidecar(repoRows, "repo"), labels: groupBySidecar(labelRows, "label"), dedupeKeys: groupBySidecar(keyRows, "dedupe_key") };
}

interface IssueSidecars {
  repos: Map<string, string[]>;
  labels: Map<string, string[]>;
  dedupeKeys: Map<string, string[]>;
}

function groupBySidecar<K extends string>(rows: Array<{ issue_id: string } & Record<K, string>>, column: K): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.issue_id) ?? [];
    list.push(row[column]);
    out.set(row.issue_id, list);
  }
  return out;
}

/**
 * Every reader goes through here, which is what lets the stored `lifecycle`
 * field read as the state label it replaced: the pipeline's "is this issue
 * `Blocked`?" checks see the label without knowing the field exists. Approval
 * is never a label: readers check `approved_through`.
 */
export function toClawsRecords(rows: ClawsIssueRow[], sidecars: IssueSidecars): ClawsIssueRecord[] {
  return rows.map((row) => {
    const labels = sidecars.labels.get(row.id) ?? [];
    const stateLabel = labelForLifecycle(row.lifecycle);
    const dedupeKeys = sidecars.dedupeKeys.get(row.id) ?? [];
    return {
      ...row,
      dedupe_key: dedupeKeys[0] ?? null,
      dedupe_keys: dedupeKeys,
      repos: sidecars.repos.get(row.id) ?? [],
      labels: stateLabel === undefined ? labels : [...labels, stateLabel],
      importPending: Boolean(row.import_pending),
    };
  });
}

/**
 * Throws unless `issueId` names a live native issue, inside the caller's
 * transaction.
 *
 * A shadow is not one (#3246), and refusing it here rather than at each call
 * site is what makes "nothing outside `db.ts`'s shadow helpers may write a
 * shadow" an invariant rather than something every new caller has to remember.
 * The three writes that do not go through this guard —
 * {@link updateClawsIssueTitle}, {@link updateClawsIssueBody} and
 * {@link setClawsIssueState} — carry the same `kind <> 'shadow'` clause on
 * their own UPDATE and report the refusal as `false`.
 *
 * **The two not-found contracts below are deliberate, not an oversight.** A
 * write whose `false` already carries a meaning — `addClawsIssueLabel` and
 * `removeClawsIssueLabel` return false for "the label was already (ab)sent" —
 * cannot also spend `false` on "no such issue" without conflating the two, so
 * those writes throw through this guard instead. `updateClawsIssueTitle` and
 * `updateClawsIssueBody` have no second meaning for `false`, so they return it
 * and `claws-issues.ts` turns it into the same error with `requireChanged`.
 * Do not "fix" one half into the other.
 *
 * {@link setClawsIssueState} is the one write with a second meaning for
 * `false` — "already in that state", which `claws-issues.ts` uses to emit
 * `issue-closed` exactly once — that does *not* go through this guard: it is a
 * single guarded UPDATE with no transaction to hang one on. Its existence
 * check lives one layer up, in `claws-issues.ts`'s `closeIssue`/`reopenIssue`,
 * which call `requireIssue` first. Do not drop that call.
 */
export async function requireClawsIssue(tx: SqlDriver, issueId: string): Promise<void> {
  const parent = await tx.get(`SELECT kind FROM claws_issues WHERE id = ?`, [issueId]) as { kind: string } | undefined;
  if (!parent) throw new Error(`claws-issues: no native issue ${issueId}`);
  if (parent.kind === "shadow") throw new Error(`claws-issues: ${issueId} is a shadow of a live forge issue, not a native issue`);
}

/** One recorded change to a native issue (docs/issue-tracker.md#history). */
export interface ClawsIssueHistoryRow {
  id: string;
  issue_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor_kind: "operator" | "session" | "automation";
  actor: string;
  run_id: string | null;
  created_at: string;
}

/** Longest history value stored; alert issues rewrite their whole body on every occurrence. */
const ISSUE_HISTORY_VALUE_MAX = 10_000;

function capHistoryValue(value: string | null): string | null {
  if (value === null || value.length <= ISSUE_HISTORY_VALUE_MAX) return value;
  return `${value.slice(0, ISSUE_HISTORY_VALUE_MAX)}…(truncated)`;
}

/**
 * Record that `field` of native issue `issueId` went from `oldValue` to
 * `newValue`, attributed to the current issue actor and run. Writes nothing
 * when the two are equal, so a write that changed nothing leaves no entry.
 * Callers run it in the write's own transaction and only for a `kind = 'issue'`
 * row — a shadow has no History.
 */
export async function recordIssueHistory(tx: SqlDriver, issueId: string, field: string, oldValue: string | null, newValue: string | null): Promise<void> {
  if (oldValue === newValue) return;
  const actor = currentIssueActor();
  await tx.run(
    `INSERT INTO claws_issue_history (id, issue_id, field, old_value, new_value, actor_kind, actor, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newUlid(), issueId, field, capHistoryValue(oldValue), capHistoryValue(newValue), actor.kind, actor.name, currentRunId(), nowSql()],
  );
}

/** True when `id` is a native issue rather than a shadow — the rows History is kept for. */
export async function isNativeIssueRow(tx: SqlDriver, id: string): Promise<boolean> {
  const row = await tx.get(`SELECT kind FROM claws_issues WHERE id = ?`, [id]) as { kind: string } | undefined;
  return row?.kind === "issue";
}

/** The stored lifecycle of `id`, read inside `tx`. */
async function readClawsIssueLifecycle(tx: SqlDriver, id: string): Promise<string | null> {
  const row = await tx.get(`SELECT lifecycle FROM claws_issues WHERE id = ?`, [id]) as { lifecycle: string | null } | undefined;
  return row?.lifecycle ?? null;
}

/** Every recorded change to native issue `issueId`, oldest first. */
export async function listClawsIssueHistory(issueId: string): Promise<ClawsIssueHistoryRow[]> {
  return await getDb().all(
    `SELECT * FROM claws_issue_history WHERE issue_id = ? ORDER BY id ASC`,
    [issueId],
  ) as ClawsIssueHistoryRow[];
}

/**
 * Create a native issue and return its id.
 *
 * The id is minted in-process by `issue-id.ts` rather than read back out of
 * the table: a `MAX(id) + 1` allocation is a read-then-write race on Postgres
 * under READ COMMITTED, and there is no mutex to close it with.
 *
 * `kind` is written as `'issue'` explicitly rather than left to the column
 * default: this is the operator-facing create, and a shadow is only ever made
 * by {@link createShadowIssue}.
 */
export async function createClawsIssue(input: {
  title: string;
  body?: string;
  authorLogin: string;
  repos?: readonly string[];
  labels?: readonly string[];
  /** Defaults to `dashboard`. */
  source?: IssueSource;
  /** The per-issue promotion override; omitted follows the policy. */
  autoPromote?: boolean;
  /**
   * Whether the issue goes through the requirements stage; omitted defaults to
   * whether {@link source} is one of {@link HUMAN_ISSUE_SOURCES}.
   */
  requirementsStage?: boolean;
  /** The caller's dedupe key (docs/issue-tracker.md "Dedupe on create"). */
  dedupeKey?: string;
  /** Why the issue is Blocked: required when `labels` makes it Blocked, ignored otherwise. */
  blockedReason?: string;
  /**
   * The approval the issue is filed with — a pre-approval through Plan or
   * Merge, say — recorded as {@link approvedBy}'s; omitted or `none` files it
   * unapproved.
   */
  approvedThrough?: ApprovedThrough;
  /** Who the filing-time approval is recorded as; defaults to {@link authorLogin}. */
  approvedBy?: string;
  /** A repo pinned as the primary however the repos sort; must be one of `repos`. */
  primaryRepo?: string;
  /** Which alert path filed the issue; omitted when it is not an alert. */
  alertKind?: string;
}): Promise<string> {
  if (input.primaryRepo !== undefined && !(input.repos ?? []).includes(input.primaryRepo)) {
    throw new Error(`primary repo ${input.primaryRepo} is not one of the issue's repos`);
  }
  const now = nowSql();
  const id = newClawsIssueId();
  const { lifecycle, rest } = splitStateLabels(input.labels ?? []);
  const blockedReason = lifecycle === "blocked" ? requireBlockedReason(input.blockedReason) : null;
  const approvedThrough = input.approvedThrough ?? "none";
  const approved = approvedThrough !== "none";
  const source = input.source ?? "dashboard";
  const requirementsStage = input.requirementsStage ?? HUMAN_ISSUE_SOURCES.includes(source);
  await getDb().transaction(async (tx) => {
    await tx.run(
      `INSERT INTO claws_issues (id, title, body, author_login, state, state_reason, created_at, updated_at, closed_at, kind, lifecycle, stage_changed_at, source, auto_promote, requirements_stage, blocked_reason, blocked_reason_at, approved_through, approved_through_by, approved_through_at, plan_approved_at, primary_repo, alert_kind)
       VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, NULL, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.title, input.body ?? "", input.authorLogin, now, now, lifecycle, now, source, autoPromoteParam(input.autoPromote), requirementsStage ? 1 : 0, blockedReason, blockedReason === null ? null : now,
        approvedThrough, approved ? (input.approvedBy ?? input.authorLogin) : null, approved ? now : null, atLeast(approvedThrough, "plan") ? now : null, input.primaryRepo ?? null, input.alertKind ?? null],
    );
    if (approved) await recordIssueHistory(tx, id, "approved_through", "none", approvedThrough);
    for (const repo of new Set(input.repos ?? [])) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_repos (issue_id, repo) VALUES (?, ?)`, [id, repo]);
    }
    for (const label of rest) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
    }
    if (input.dedupeKey !== undefined) {
      await tx.run(`INSERT INTO claws_issue_dedupe_keys (issue_id, dedupe_key, created_at) VALUES (?, ?, ?)`, [id, input.dedupeKey, now]);
    }
  });
  return id;
}

export function autoPromoteParam(autoPromote: boolean | undefined): number | null {
  return autoPromote === undefined ? null : autoPromote ? 1 : 0;
}

/** A native issue with its repos and labels, or undefined when it does not exist. */
/** Whether a native issue exists — a cheap check that skips loading its sidecars. */
export async function clawsIssueExists(id: string): Promise<boolean> {
  return await getDb().get(`SELECT 1 AS one FROM claws_issues WHERE id = ?`, [id]) !== undefined;
}

export async function getClawsIssue(id: string): Promise<ClawsIssueRecord | undefined> {
  const row = await getDb().get(`SELECT * FROM claws_issues WHERE id = ?`, [id]) as ClawsIssueRow | undefined;
  if (!row) return undefined;
  return toClawsRecords([row], await loadIssueSidecars(`WHERE id = ?`, [id]))[0];
}

/**
 * A native issue's primary repo: its pinned `primary_repo` when that is one of
 * its repos, else the alphabetically first of its repos (by code point), else
 * `""` when it has none. The primary repo owns planning, labels and phase
 * sequencing; {@link primaryRepoSql} is the SQL twin.
 */
export function primaryRepoOf(issue: { readonly repos: readonly string[]; readonly primary_repo?: string | null }): string {
  if (issue.primary_repo && issue.repos.includes(issue.primary_repo)) return issue.primary_repo;
  return [...issue.repos].sort()[0] ?? "";
}

/**
 * A native issue's primary repo in SQL: the pinned `primary_repo` when it is
 * one of the issue's repos, else the alphabetically first of its repos, NULL
 * when it has none. Mirrors {@link primaryRepoOf}, so the fallback comparison
 * has to be by code point in both dialects: SQLite's `MIN` already is,
 * Postgres's follows the database collation unless told otherwise, and a
 * locale collation would pick a different primary for mixed-case names.
 */
export function primaryRepoSql(): string {
  const collate = getDb().dialect === "postgres" ? ` COLLATE "C"` : "";
  return `COALESCE((SELECT r.repo FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id AND r.repo = claws_issues.primary_repo), `
    + `(SELECT MIN(r.repo${collate}) FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id))`;
}

/**
 * Open native issues, newest-updated first.
 *
 * `repo` filters to issues whose *primary* repo is that one — the
 * alphabetically first of its repos, which owns planning, labels and phase
 * sequencing. A multi-repo issue is therefore listed under exactly one repo,
 * so exactly one dispatcher acts on it. That primary-only match is the
 * dispatch rule and the default; `repoMatch: "any"` is the discovery rule,
 * matching an issue that names `repo` at all (board, API, repo page). `unassigned` is the issues with no
 * repo at all: visible on the list and the board but never through
 * `listOpenIssues`. Both are decided in SQL, so a tracker with thousands of
 * closed issues still costs one indexed scan.
 *
 * The two are mutually exclusive in the signature. Together they are the
 * unsatisfiable "primary repo is X and there are no repos", which would
 * return an empty list — a mistaken caller would read that as "no issues"
 * rather than as the mistake it is.
 *
 * Shadows are excluded here and in {@link listClosedClawsIssuesSince}, and
 * nowhere else: those two are what the façade unions, so one clause apiece
 * hides them from the dispatchers, `findIssueByExactTitle`, alert-issue dedup,
 * the board and `/issues` at once (#3246).
 */
export async function listOpenClawsIssues(
  filter: { label?: string; repoMatch?: "primary" | "any" } & ({ repo?: string; unassigned?: never } | { repo?: never; unassigned?: boolean }) = {},
): Promise<ClawsIssueRecord[]> {
  const clauses = [`state = 'open'`, `kind <> 'shadow'`];
  const params: unknown[] = [];
  if (filter.repo !== undefined) {
    clauses.push(filter.repoMatch === "any"
      ? `EXISTS (SELECT 1 FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id AND r.repo = ?)`
      : `${primaryRepoSql()} = ?`);
    params.push(filter.repo);
  }
  if (filter.unassigned) clauses.push(`NOT EXISTS (SELECT 1 FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id)`);
  if (filter.label !== undefined) {
    // A state label is the `lifecycle` field, not a label row.
    const lifecycle = lifecycleForLabel(filter.label);
    if (lifecycle !== undefined) {
      clauses.push(`lifecycle = ?`);
      params.push(lifecycle);
    } else {
      clauses.push(`EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label = ?)`);
      params.push(filter.label);
    }
  }
  const tail = `WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/** SQL: the `claws_issues` row holds the dedupe key bound at this `?`. */
const HOLDS_DEDUPE_KEY_SQL = `EXISTS (SELECT 1 FROM claws_issue_dedupe_keys k WHERE k.issue_id = claws_issues.id AND k.dedupe_key = ?)`;

/**
 * Open native issues holding dedupe key `key` among their keys, oldest first.
 * A shadow never carries a key, but is excluded anyway, as in
 * {@link listOpenClawsIssues}.
 */
export async function listOpenClawsIssuesByDedupeKey(key: string): Promise<ClawsIssueRecord[]> {
  const params = [key];
  const tail = `WHERE state = 'open' AND kind <> 'shadow' AND ${HOLDS_DEDUPE_KEY_SQL} ORDER BY created_at ASC, id ASC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/**
 * The newest open `kind = 'issue'` row in `repo`, its primary repo, holding no dedupe key and filed under exactly `title` —
 * `filed_title` when it has been renamed since, else its title. The issue
 * filer adopts it for a key on a lookup miss (docs/issue-tracker.md "Issue
 * filers"), so a report imported from the forge keeps its card.
 */
export async function findOpenUnkeyedIssueByFiledTitle(repo: string, title: string): Promise<ClawsIssueRecord | undefined> {
  const row = await getDb().get(
    `SELECT id FROM claws_issues
      WHERE state = 'open' AND kind = 'issue'
        AND NOT EXISTS (SELECT 1 FROM claws_issue_dedupe_keys k WHERE k.issue_id = claws_issues.id)
        AND ${primaryRepoSql()} = ? AND COALESCE(filed_title, title) = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [repo, title],
  ) as { id: string } | undefined;
  return row ? await getClawsIssue(String(row.id)) : undefined;
}

/**
 * Mark native issue `id` as an alert filed by `kind`, leaving an issue already
 * marked as it is. Returns whether the value changed.
 */
export async function setClawsIssueAlertKind(id: string, kind: string): Promise<boolean> {
  const res = await getDb().run(`UPDATE claws_issues SET alert_kind = ? WHERE id = ? AND alert_kind IS NULL AND kind <> 'shadow'`, [kind, id]);
  return res.changes > 0;
}

/**
 * Claim the outage-plan Slack page for issue `id` (src/outage-plan-notify.ts):
 * stamp `alert_attention_notified_at` with `nowIso` unless it already holds a
 * time at or after `cutoffIso`. True when this call claimed the page, so only
 * one caller sends it per window.
 */
export async function claimClawsIssueOutageNotice(id: string, nowIso: string, cutoffIso: string): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE claws_issues SET alert_attention_notified_at = ? WHERE id = ? AND (alert_attention_notified_at IS NULL OR alert_attention_notified_at < ?)`,
    [nowIso, id, cutoffIso],
  );
  return res.changes > 0;
}

/**
 * Every open alert issue ({@link ClawsIssueRow.alert_kind} set), newest first,
 * for the dashboard's `/alerts` page. Never a shadow.
 */
export async function listOpenClawsAlerts(): Promise<ClawsIssueRecord[]> {
  const tail = `WHERE state = 'open' AND kind <> 'shadow' AND alert_kind IS NOT NULL ORDER BY created_at DESC, id DESC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, []) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, []));
}

/**
 * Native issues holding dedupe key `key` whose primary repo is `repo`,
 * closed at or after `since`, newest-closed first. Never a shadow.
 */
export async function listClosedClawsIssuesByDedupeKey(repo: string, key: string, since: Date): Promise<ClawsIssueRecord[]> {
  const cutoff = since.toISOString().slice(0, 19).replace("T", " ");
  const params = [key, cutoff, repo];
  const tail = `WHERE state = 'closed' AND kind <> 'shadow' AND ${HOLDS_DEDUPE_KEY_SQL} AND closed_at IS NOT NULL AND closed_at >= ?
      AND ${primaryRepoSql()} = ? ORDER BY closed_at DESC, id DESC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/**
 * Native issues holding dedupe key `key` whose primary repo is `repo` and
 * that closed as not planned, newest-closed first. A `null` repo matches
 * every repo, for a caller whose key already names its subject. Never a shadow.
 */
export async function listNotPlannedClawsIssuesByDedupeKey(repo: string | null, key: string): Promise<ClawsIssueRecord[]> {
  const params = repo === null ? [key] : [key, repo];
  const tail = `WHERE state = 'closed' AND kind <> 'shadow' AND ${HOLDS_DEDUPE_KEY_SQL} AND state_reason = 'not_planned'
      ${repo === null ? "" : `AND ${primaryRepoSql()} = ? `}ORDER BY closed_at DESC, id DESC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/**
 * The primary repo of live native issue `id` (NULL when it names no repo),
 * and whether another open issue with that primary repo already holds `key`.
 * Undefined when `id` is unknown or a shadow. Read inside the caller's `tx`.
 */
async function dedupeKeyHolderCheck(tx: SqlDriver, id: string, key: string): Promise<{ taken: boolean } | undefined> {
  const issue = await tx.get(
    `SELECT ${primaryRepoSql()} AS repo FROM claws_issues WHERE id = ? AND kind <> 'shadow'`,
    [id],
  ) as { repo: string | null } | undefined;
  if (!issue) return undefined;
  const holder = await tx.get(
    `SELECT id FROM claws_issues WHERE state = 'open' AND kind <> 'shadow' AND ${HOLDS_DEDUPE_KEY_SQL} AND id <> ?
       AND ${issue.repo === null ? `NOT EXISTS (SELECT 1 FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id)` : `${primaryRepoSql()} = ?`}`,
    issue.repo === null ? [key, id] : [key, id, issue.repo],
  ) as { id: string } | undefined;
  return { taken: holder !== undefined };
}

/**
 * Add `key` to a native issue's dedupe keys, keeping the ones it holds.
 * Returns true when the issue holds `key` afterwards (already holding it
 * counts), false, writing nothing, when the issue does not exist, is a
 * shadow, or another open issue with the same primary repo already holds
 * `key` — a key names one open issue per repo.
 */
export async function addClawsIssueDedupeKey(id: string, key: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const check = await dedupeKeyHolderCheck(tx, id, key);
    if (!check || check.taken) return false;
    const now = nowSql();
    const res = await tx.run(`INSERT OR IGNORE INTO claws_issue_dedupe_keys (issue_id, dedupe_key, created_at) VALUES (?, ?, ?)`, [id, key, now]);
    if (res.changes > 0) await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ?`, [now, id]);
    return true;
  });
}

/**
 * Replace all of a native issue's dedupe keys with `key`. Returns false,
 * writing nothing, when the issue does not exist, is a shadow, or another
 * open issue with the same primary repo already holds `key` — a key names one
 * open issue per repo. Clears the retired `claws_issues.dedupe_key` column so
 * {@link migrateDedupeKeysToTable} cannot copy a dropped key back.
 */
export async function setClawsIssueDedupeKey(id: string, key: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const check = await dedupeKeyHolderCheck(tx, id, key);
    if (!check || check.taken) return false;
    const now = nowSql();
    await tx.run(`DELETE FROM claws_issue_dedupe_keys WHERE issue_id = ?`, [id]);
    await tx.run(`INSERT INTO claws_issue_dedupe_keys (issue_id, dedupe_key, created_at) VALUES (?, ?, ?)`, [id, key, now]);
    await tx.run(`UPDATE claws_issues SET dedupe_key = NULL, updated_at = ? WHERE id = ?`, [now, id]);
    return true;
  });
}

/**
 * Swap one of a native issue's dedupe keys, `from`, for `key`, keeping every
 * other key it holds — the move off a legacy key. Returns true when the issue
 * holds `key` afterwards; false, writing nothing, when the issue does not
 * exist, is a shadow, or another open issue with the same primary repo already
 * holds `key`. Clears the retired `claws_issues.dedupe_key` column when it
 * holds `from`, so {@link migrateDedupeKeysToTable} cannot copy it back.
 */
export async function replaceClawsIssueDedupeKey(id: string, from: string, key: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const check = await dedupeKeyHolderCheck(tx, id, key);
    if (!check || check.taken) return false;
    const now = nowSql();
    if (from !== key) await tx.run(`DELETE FROM claws_issue_dedupe_keys WHERE issue_id = ? AND dedupe_key = ?`, [id, from]);
    await tx.run(`INSERT OR IGNORE INTO claws_issue_dedupe_keys (issue_id, dedupe_key, created_at) VALUES (?, ?, ?)`, [id, key, now]);
    await tx.run(
      `UPDATE claws_issues SET dedupe_key = CASE WHEN dedupe_key = ? THEN NULL ELSE dedupe_key END, updated_at = ? WHERE id = ?`,
      [from, now, id],
    );
    return true;
  });
}

/**
 * Move every dedupe key native issue `fromId` holds onto `toId`, in one
 * transaction, and return the moved keys (oldest first). A key `toId` already
 * holds stays as it is; each newly added row is dated now, so `toId`'s oldest
 * key — its {@link ClawsIssueRecord.dedupe_key} — does not change. Clears
 * `fromId`'s retired `claws_issues.dedupe_key` column so
 * {@link migrateDedupeKeysToTable} cannot copy a moved key back. Returns an
 * empty list, writing nothing, when `fromId` holds no key, either issue is
 * unknown or a shadow, or the two are the same issue. The caller checks the
 * one-open-holder-per-primary-repo rule (`issue-merge.ts` moves keys only
 * between issues with the same primary repo).
 */
export async function moveClawsIssueDedupeKeys(fromId: string, toId: string): Promise<string[]> {
  if (fromId === toId) return [];
  return await getDb().transaction(async (tx) => {
    const live = await tx.all(
      `SELECT id FROM claws_issues WHERE id IN (?, ?) AND kind <> 'shadow'`,
      [fromId, toId],
    ) as { id: string }[];
    if (live.length !== 2) return [];
    const rows = await tx.all(
      `SELECT dedupe_key FROM claws_issue_dedupe_keys WHERE issue_id = ? ORDER BY created_at ASC, dedupe_key ASC`,
      [fromId],
    ) as { dedupe_key: string }[];
    if (rows.length === 0) return [];
    const now = nowSql();
    for (const { dedupe_key } of rows) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_dedupe_keys (issue_id, dedupe_key, created_at) VALUES (?, ?, ?)`, [toId, dedupe_key, now]);
    }
    await tx.run(`DELETE FROM claws_issue_dedupe_keys WHERE issue_id = ?`, [fromId]);
    await tx.run(`UPDATE claws_issues SET dedupe_key = NULL, updated_at = ? WHERE id = ?`, [now, fromId]);
    await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ?`, [now, toId]);
    return rows.map((r) => r.dedupe_key);
  });
}

/**
 * Native issues in any state, for the session/agent search behind
 * `claws_list_issues` and the dashboard's `/issues` closed view. `state` picks
 * open, closed or both; `repo` matches an issue naming that repo at all (the
 * `repoMatch: "any"` rule), and `repos` an issue naming any of them;
 * `titleContains` is a case-insensitive substring; `closedSince` /
 * `updatedSince` are inclusive lower bounds, and `range` an inclusive window
 * on one date column (`to` is the last instant kept). Newest-updated first by
 * default so paging is stable across states; `orderBy: "closed_at"` is
 * newest-closed first. Shadows are never returned. Logs `duration_ms`.
 */
export async function listClawsIssues(filter: {
  state: "open" | "closed" | "all";
  repo?: string;
  repos?: readonly string[];
  titleContains?: string;
  closedSince?: Date;
  updatedSince?: Date;
  range?: { field: "closed_at" | "created_at" | "updated_at"; from?: Date; to?: Date };
  orderBy?: "updated_at" | "closed_at";
  limit: number;
  offset?: number;
}): Promise<ClawsIssueRecord[]> {
  return timedDb("list-claws-issues", () => listClawsIssuesUntimed(filter));
}

async function listClawsIssuesUntimed(filter: Parameters<typeof listClawsIssues>[0]): Promise<ClawsIssueRecord[]> {
  const clauses = [`kind <> 'shadow'`];
  const params: unknown[] = [];
  const cutoff = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  if (filter.state !== "all") {
    clauses.push(`state = ?`);
    params.push(filter.state);
  }
  if (filter.repo !== undefined) {
    clauses.push(`EXISTS (SELECT 1 FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id AND r.repo = ?)`);
    params.push(filter.repo);
  }
  if (filter.repos !== undefined) {
    if (filter.repos.length === 0) return [];
    clauses.push(`EXISTS (SELECT 1 FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id AND r.repo IN (${filter.repos.map(() => "?").join(",")}))`);
    params.push(...filter.repos);
  }
  if (filter.titleContains) {
    clauses.push(`LOWER(title) LIKE ? ESCAPE '\\'`);
    params.push(`%${filter.titleContains.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  if (filter.closedSince) {
    clauses.push(`closed_at IS NOT NULL AND closed_at >= ?`);
    params.push(cutoff(filter.closedSince));
  }
  if (filter.updatedSince) {
    clauses.push(`updated_at >= ?`);
    params.push(cutoff(filter.updatedSince));
  }
  if (filter.range) {
    // The column is one of three literals, never caller text.
    const column = filter.range.field;
    if (filter.range.from) {
      clauses.push(`${column} IS NOT NULL AND ${column} >= ?`);
      params.push(cutoff(filter.range.from));
    }
    if (filter.range.to) {
      clauses.push(`${column} IS NOT NULL AND ${column} <= ?`);
      params.push(cutoff(filter.range.to));
    }
  }
  const order = filter.orderBy === "closed_at" ? `closed_at DESC, id DESC` : `updated_at DESC, id DESC`;
  const where = `WHERE ${clauses.join(" AND ")} ORDER BY ${order}`;
  const rows = await getDb().all(
    `SELECT * FROM claws_issues ${where} LIMIT ? OFFSET ?`,
    [...params, filter.limit, filter.offset ?? 0],
  ) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(`${where} LIMIT ? OFFSET ?`, [...params, filter.limit, filter.offset ?? 0]));
}

/** The subset of `issueIds` that has at least one stored plan, in one query. */
export async function listIssueIdsWithPlans(issueIds: readonly string[]): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT DISTINCT issue_id FROM claws_issue_plans WHERE issue_id IN (${placeholders})`,
    [...issueIds],
  ) as { issue_id: string }[];
  return new Set(rows.map((r) => String(r.issue_id)));
}

/**
 * The bodies, from each of `issueIds`' own body and its live (not
 * soft-deleted) comments, that contain a `claws-duplicate-of:` marker. One
 * query for the batch.
 */
export async function listDuplicateMarkerBodies(issueIds: readonly string[]): Promise<{ issue_id: string; body: string }[]> {
  if (issueIds.length === 0) return [];
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT id AS issue_id, body FROM claws_issues
      WHERE id IN (${placeholders}) AND body LIKE '%claws-duplicate-of:%'
     UNION ALL
     SELECT issue_id, body FROM claws_issue_comments
      WHERE issue_id IN (${placeholders}) AND deleted_at IS NULL AND body LIKE '%claws-duplicate-of:%'`,
    [...issueIds, ...issueIds],
  ) as { issue_id: string; body: string }[];
  return rows.map((r) => ({ issue_id: String(r.issue_id), body: r.body }));
}

/**
 * Native issues closed at or after `since`, newest-closed first.
 *
 * `repo` and `limit` are pushed into SQL rather than applied by the caller,
 * for the same reason {@link listOpenClawsIssues} does it: the façade asks per
 * repo on every poll cycle, and the closed set only ever grows. `repo` matches
 * the open reader's rule — the issue's *primary* repo is that one — and, like the
 * open reader, this one never returns a shadow.
 */
export async function listClosedClawsIssuesSince(
  since: Date,
  filter: { repo?: string; limit?: number } = {},
): Promise<ClawsIssueRecord[]> {
  const cutoff = since.toISOString().slice(0, 19).replace("T", " ");
  const clauses = [`state = 'closed'`, `kind <> 'shadow'`, `closed_at IS NOT NULL`, `closed_at >= ?`];
  const params: unknown[] = [cutoff];
  if (filter.repo !== undefined) {
    clauses.push(`${primaryRepoSql()} = ?`);
    params.push(filter.repo);
  }
  let tail = `WHERE ${clauses.join(" AND ")} ORDER BY closed_at DESC, id DESC`;
  if (filter.limit !== undefined) {
    tail += ` LIMIT ?`;
    params.push(filter.limit);
  }
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/** Replace a native issue's title. Returns false when the issue does not exist or is a shadow. */
export async function updateClawsIssueTitle(id: string, title: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT title FROM claws_issues WHERE id = ? AND kind <> 'shadow'`, [id]) as { title: string } | undefined;
    const res = await tx.run(`UPDATE claws_issues SET filed_title = COALESCE(filed_title, title), title = ?, updated_at = ? WHERE id = ? AND kind <> 'shadow'`, [title, nowSql(), id]);
    if (res.changes > 0 && old) await recordIssueHistory(tx, id, "title", old.title, title);
    return res.changes > 0;
  });
}

/** Replace a native issue's body. Returns false when the issue does not exist or is a shadow. */
export async function updateClawsIssueBody(id: string, body: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT body FROM claws_issues WHERE id = ? AND kind <> 'shadow'`, [id]) as { body: string | null } | undefined;
    const res = await tx.run(`UPDATE claws_issues SET body = ?, updated_at = ? WHERE id = ? AND kind <> 'shadow'`, [body, nowSql(), id]);
    if (res.changes > 0 && old) await recordIssueHistory(tx, id, "body", old.body ?? "", body);
    return res.changes > 0;
  });
}

/**
 * Open or close a native issue; `closed_at` is cleared on reopen.
 *
 * Guarded with `AND state <> ?` so a repeat close changes zero rows. Callers
 * use that to emit `issue-closed` exactly once — two jobs racing to close the
 * same issue must not produce two events.
 *
 * The guard is on `state` alone, so re-closing an already-closed issue with a
 * *different* `stateReason` returns false and leaves the original reason in
 * place: the first close wins. Reopen and close again to change it.
 *
 * `kind <> 'shadow'` is the second guard: a shadow's state follows its forge
 * issue through {@link updateShadowIssue} and nothing else may move it.
 */
export async function setClawsIssueState(
  id: string,
  state: "open" | "closed",
  stateReason?: "completed" | "not_planned" | null,
): Promise<boolean> {
  const now = nowSql();
  const reason = state === "closed" ? (stateReason ?? null) : null;
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT state, state_reason FROM claws_issues WHERE id = ? AND kind <> 'shadow'`, [id]) as { state: string; state_reason: string | null } | undefined;
    const res = await tx.run(
      `UPDATE claws_issues SET state = ?, state_reason = ?, closed_at = ?, updated_at = ?, stage_changed_at = ?${state === "closed" ? ", overlap_hold_lifted_at = NULL, overlap_hold_lifted_by = NULL" : ""} WHERE id = ? AND state <> ? AND kind <> 'shadow'`,
      [state, reason, state === "closed" ? now : null, now, now, id, state],
    );
    if (res.changes > 0 && old) await recordIssueHistory(tx, id, "state", historyStateValue(old.state, old.state_reason), historyStateValue(state, reason));
    return res.changes > 0;
  });
}

/** An issue's state as its History shows it: `open`, or `closed (reason)`. */
function historyStateValue(state: string, reason: string | null): string {
  return state === "closed" && reason ? `closed (${reason})` : state;
}

/**
 * Add a label. Returns false when the issue already carried it.
 *
 * A state label (`Blocked` / `Backlog`) sets the `lifecycle` field
 * instead, replacing whichever state the issue held: the field is
 * single-valued, so adding `Backlog` to a Blocked issue leaves it in
 * `Backlog` alone. A retired gate label (`Refined`, `Automerge`, …) is
 * refused: approval is {@link setClawsIssueApprovedThrough}'s. `Blocked` throws {@link BlockedReasonRequiredError}: a
 * move to Blocked must carry a reason, so it goes through
 * {@link blockClawsIssue}.
 */
export async function addClawsIssueLabel(id: string, label: string): Promise<boolean> {
  if (lifecycleForLabel(label) === "blocked") throw new BlockedReasonRequiredError();
  if ((RETIRED_GATE_LABELS as readonly string[]).includes(label)) {
    throw new Error(`claws-issues: ${label} is not a label any more — set the issue's approval instead`);
  }
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const lifecycle = lifecycleForLabel(label);
    if (lifecycle !== undefined) {
      const now = nowSql();
      const before = await readClawsIssueLifecycle(tx, id);
      const set = await tx.run(
        `UPDATE claws_issues SET lifecycle = ?, updated_at = ?, stage_changed_at = ? WHERE id = ? AND lifecycle <> ?`,
        [lifecycle, now, now, id, lifecycle],
      );
      if (set.changes > 0) {
        await recordIssueHistory(tx, id, "lifecycle", before, lifecycle);
        await clearBacklogUntilOnExit(tx, id);
      }
      return set.changes > 0;
    }
    const res = await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
    if (res.changes > 0) {
      await touchClawsIssueForLabel(tx, id);
      await recordIssueHistory(tx, id, "label", null, label);
    }
    return res.changes > 0;
  });
}

/** Bump `updated_at` after a plain label row was added or removed. */
async function touchClawsIssueForLabel(tx: SqlDriver, id: string): Promise<void> {
  await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ?`, [nowSql(), id]);
}

/**
 * Remove a label. Returns false when the issue did not carry it.
 *
 * A state label moves the `lifecycle` field back to where the issue enters the
 * board, but only when the field holds that state — removing `Blocked` from a
 * Backlog issue leaves it in the Backlog, as removing an absent label row
 * always did. It goes to `planning` when it has a plan or approved
 * requirements and to `ideas` otherwise, as `clawsIssues.entryLifecycle`
 * decides.
 */
export async function removeClawsIssueLabel(id: string, label: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const lifecycle = lifecycleForLabel(label);
    if (lifecycle !== undefined) {
      const now = nowSql();
      const reset = await tx.run(
        `UPDATE claws_issues SET lifecycle = ${ENTRY_LIFECYCLE_SQL}, updated_at = ?, stage_changed_at = ? WHERE id = ? AND lifecycle = ?`,
        [now, now, id, lifecycle],
      );
      if (reset.changes > 0) {
        await recordIssueHistory(tx, id, "lifecycle", lifecycle, await readClawsIssueLifecycle(tx, id));
        await clearBacklogUntilOnExit(tx, id);
      }
      return reset.changes > 0;
    }
    const res = await tx.run(`DELETE FROM claws_issue_labels WHERE issue_id = ? AND label = ?`, [id, label]);
    if (res.changes > 0) {
      await touchClawsIssueForLabel(tx, id);
      await recordIssueHistory(tx, id, "label", label, null);
    }
    return res.changes > 0;
  });
}

/**
 * Where an issue re-enters the board, in SQL over the `claws_issues` row:
 * `planning` once it has a plan or approved requirements, `ideas` otherwise.
 * Mirrors `clawsIssues.entryLifecycle`.
 */
export const ENTRY_LIFECYCLE_SQL = `CASE WHEN requirements_approved_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM claws_issue_plans p WHERE p.issue_id = claws_issues.id)
  THEN 'planning' ELSE 'ideas' END`;

/**
 * Promote an issue to `planning`: record that `approvedBy` approved
 * requirements `version` (NULL when there is no record yet), and, when
 * `title` is given and differs, rename the issue to it and keep the title it
 * was filed under in `filed_title` (only the first rename sets it). Unlike the
 * label writes this covers a shadow too — a forge issue is promoted through
 * its shadow, whose `lifecycle` the dispatcher reads — though a shadow is
 * never renamed: the sync job would write the forge title straight back.
 *
 * Guarded by `input.expectedLifecycle`, a compare-and-swap on the lifecycle
 * the caller already read rather than a fixed allow-list: a human move can
 * promote out of Blocked, Approved or Awaiting plan review, not just Ideas,
 * while a promotion racing a concurrent move to some other column still
 * loses. Returns false when there is no such issue or it lost that race.
 */
export async function promoteClawsIssue(id: string, input: { version: number | null; approvedBy: string; title?: string; expectedLifecycle: IssueLifecycle }): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(
      `SELECT title, kind, approved_requirements_version, approved_through FROM claws_issues WHERE id = ? AND lifecycle = ?`,
      [id, input.expectedLifecycle],
    ) as { title: string; kind: string; approved_requirements_version: number | null; approved_through: string } | undefined;
    if (!row) return false;
    const now = nowSql();
    const rename = row.kind !== "shadow" && input.title !== undefined && input.title.trim() !== "" && input.title !== row.title;
    // Approving the requirements approves the issue through Requirements; a
    // higher pre-approval (through Plan or Merge) stands.
    const raise = !atLeast(row.approved_through, "requirements");
    const res = await tx.run(
      `UPDATE claws_issues
          SET approved_requirements_version = ?, requirements_approved_by = ?, requirements_approved_at = ?,
              lifecycle = 'planning', updated_at = ?,
              stage_changed_at = CASE WHEN lifecycle = 'planning' THEN stage_changed_at ELSE ? END${rename ? `, filed_title = COALESCE(filed_title, title), title = ?` : ""}${raise ? `, approved_through = 'requirements', approved_through_by = ?, approved_through_at = ?` : ""}
        WHERE id = ? AND lifecycle = ?`,
      [input.version, input.approvedBy, now, now, now, ...(rename ? [input.title] : []), ...(raise ? [input.approvedBy, now] : []), id, input.expectedLifecycle],
    );
    if (res.changes > 0 && row.kind === "issue") {
      await recordIssueHistory(tx, id, "lifecycle", input.expectedLifecycle, "planning");
      if (raise) await recordIssueHistory(tx, id, "approved_through", row.approved_through, "requirements");
      if (rename) await recordIssueHistory(tx, id, "title", row.title, input.title ?? null);
      await recordIssueHistory(tx, id, "requirements approved", requirementsVersionLabel(row.approved_requirements_version), requirementsVersionLabel(input.version));
      await clearBacklogUntilOnExit(tx, id);
    }
    return res.changes > 0;
  });
}

/**
 * Send an issue back to `ideas`: clear the approval fields and leave its
 * requirements versions, and its title, as they are. Also sets `auto_promote`
 * to 0 — a human (or a board drag) sent it back on purpose, so the
 * level-triggered check in the issue dispatcher must not promote it straight
 * back out from under them. Covers a shadow too. Returns false when there is
 * no such issue.
 */
export async function demoteClawsIssue(id: string): Promise<boolean> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT lifecycle, kind, approved_through FROM claws_issues WHERE id = ?`, [id]) as { lifecycle: string | null; kind: string; approved_through: string } | undefined;
    // Back in Ideas nothing is approved: the approval goes with the requirements'.
    const result = await tx.run(
      `UPDATE claws_issues
          SET approved_requirements_version = NULL, requirements_approved_by = NULL, requirements_approved_at = NULL,
              auto_promote = 0,
              approved_through = 'none', approved_through_at = CASE WHEN approved_through = 'none' THEN approved_through_at ELSE ? END,
              approved_through_by = CASE WHEN approved_through = 'none' THEN approved_through_by ELSE ? END,
              plan_approved_at = NULL,
              lifecycle = 'ideas', updated_at = ?, stage_changed_at = CASE WHEN lifecycle = 'ideas' THEN stage_changed_at ELSE ? END
        WHERE id = ?`,
      [now, currentIssueActor().name, now, now, id],
    );
    if (Number(result.changes) > 0 && old?.kind === "issue") {
      await recordIssueHistory(tx, id, "lifecycle", old.lifecycle, "ideas");
      await recordIssueHistory(tx, id, "approved_through", old.approved_through, "none");
      await clearBacklogUntilOnExit(tx, id);
    }
    return Number(result.changes) > 0;
  });
}

/**
 * Set a native issue's lifecycle state. Returns false when it already held
 * `lifecycle`; throws for a missing issue or a shadow, like the label writes.
 * Throws {@link BlockedReasonRequiredError} for `blocked` — use
 * {@link blockClawsIssue}, which records the reason in the same write.
 */
export async function setClawsIssueLifecycle(id: string, lifecycle: IssueLifecycle): Promise<boolean> {
  if (lifecycle === "blocked") throw new BlockedReasonRequiredError();
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const now = nowSql();
    const before = await readClawsIssueLifecycle(tx, id);
    const res = await tx.run(
      `UPDATE claws_issues SET lifecycle = ?, updated_at = ?, stage_changed_at = ? WHERE id = ? AND lifecycle <> ?`,
      [lifecycle, now, now, id, lifecycle],
    );
    if (res.changes > 0) {
      await recordIssueHistory(tx, id, "lifecycle", before, lifecycle);
      await clearBacklogUntilOnExit(tx, id);
    }
    return res.changes > 0;
  });
}

/**
 * A refused move to Blocked: every issue entering Blocked must carry a
 * non-empty reason (docs/product/dashboard-and-integrations.md).
 */
export class BlockedReasonRequiredError extends Error {
  constructor() {
    super("A reason is required to mark an issue Blocked");
    this.name = "BlockedReasonRequiredError";
  }
}

/** `reason` trimmed, or throws {@link BlockedReasonRequiredError} when it is missing or blank. */
function requireBlockedReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed === "") throw new BlockedReasonRequiredError();
  return trimmed;
}

/**
 * Move native issue `id` to Blocked and record `reason` in one transaction,
 * with both History rows, so a refused move leaves nothing behind and the
 * reason is never older than the stage. Throws
 * {@link BlockedReasonRequiredError} for a blank reason before any write, and
 * throws for a missing issue or a shadow like the label writes. An issue
 * already Blocked keeps its stage and takes the new reason. Returns whether
 * the lifecycle changed.
 */
export async function blockClawsIssue(id: string, reason: string): Promise<boolean> {
  const trimmed = requireBlockedReason(reason);
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const old = await tx.get(`SELECT lifecycle, blocked_reason FROM claws_issues WHERE id = ?`, [id]) as { lifecycle: string; blocked_reason: string | null };
    const changed = old.lifecycle !== "blocked";
    const now = nowSql();
    await tx.run(
      `UPDATE claws_issues SET lifecycle = 'blocked', updated_at = ?, stage_changed_at = CASE WHEN lifecycle = 'blocked' THEN stage_changed_at ELSE ? END, blocked_reason = ?, blocked_reason_at = ? WHERE id = ?`,
      [now, now, trimmed, now, id],
    );
    if (changed) await recordIssueHistory(tx, id, "lifecycle", old.lifecycle, "blocked");
    await recordIssueHistory(tx, id, "blocked_reason", old.blocked_reason, trimmed);
    if (changed) await clearBacklogUntilOnExit(tx, id);
    return changed;
  });
}

/**
 * Clear `id`'s Backlog return date once its lifecycle is no longer
 * `backlog`, recording the cleared date in History. Every native lifecycle
 * write calls it in its own transaction, so an issue moved out of the Backlog
 * before its date leaves nothing for the dispatcher's sweep to act on, and a
 * later plain move back into the Backlog carries no stale date.
 */
async function clearBacklogUntilOnExit(tx: SqlDriver, id: string): Promise<void> {
  const row = await tx.get(
    `SELECT backlog_until, kind FROM claws_issues WHERE id = ? AND lifecycle <> 'backlog' AND backlog_until IS NOT NULL`,
    [id],
  ) as { backlog_until: string; kind: string } | undefined;
  if (!row) return;
  await tx.run(`UPDATE claws_issues SET backlog_until = NULL, backlog_until_at = NULL WHERE id = ?`, [id]);
  if (row.kind === "issue") await recordIssueHistory(tx, id, "backlog_until", row.backlog_until, null);
}

/**
 * Set a shadow's lifecycle state without touching its approval fields — the
 * plain-write counterpart to {@link promoteClawsIssue} for a forge issue
 * moving between columns that carry no requirements approval of their own
 * (Awaiting plan review, Blocked, Backlog) — its plan and merge approval is
 * {@link setClawsIssueApprovedThrough}'s. {@link setClawsIssueLifecycle} throws
 * for a shadow, since every other native-issue write is meant to refuse one;
 * a forge issue's stage has nowhere else to live, so this is the one write
 * that accepts it. Returns false when there is no such shadow or it already
 * held `lifecycle`.
 */
export async function setShadowLifecycle(id: string, lifecycle: IssueLifecycle): Promise<boolean> {
  const now = nowSql();
  const res = await getDb().run(
    `UPDATE claws_issues SET lifecycle = ?, updated_at = ?, stage_changed_at = ? WHERE id = ? AND kind = 'shadow' AND lifecycle <> ?`,
    [lifecycle, now, now, id, lifecycle],
  );
  return res.changes > 0;
}

/**
 * Set how far issue `id` — a native issue or a forge issue's shadow — is
 * approved (`issue-approval.ts`), recording `by` as who set it.
 * Compare-and-set: returns false, writing nothing, when it already held
 * `through` or there is no such row. Records History on a native issue,
 * bumps `updated_at`, and bumps `stage_changed_at` only when the issue sits
 * in `awaiting-plan-review` and the value crosses `plan` — the one change
 * that moves its card between Awaiting plan review and Approved. Sets
 * `plan_approved_at` when the value rises through `plan` and clears it when
 * it drops below.
 *
 * The raw write: the PR rows, comments and promotion that go with a change
 * are `issue-approval-write.ts`'s `applyIssueApproval`, which every other
 * write goes through. The column is also written directly by issue creation
 * (`createClawsIssue`), the requirements-approval raise
 * (`promoteClawsIssue` / `approveClawsIssueRequirements`), the send-back to
 * Ideas (`demoteClawsIssue`), the boot migration
 * (`migrateGateLabelsToApprovedThrough`), and `reapproval.ts`'s settle
 * step, which calls this raw because the approval writer would re-enter it.
 */
export async function setClawsIssueApprovedThrough(id: string, through: ApprovedThrough, by: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(
      `SELECT kind, lifecycle, approved_through FROM claws_issues WHERE id = ?`,
      [id],
    ) as { kind: string; lifecycle: string; approved_through: string } | undefined;
    if (!old || old.approved_through === through) return false;
    const now = nowSql();
    const planChanged = atLeast(old.approved_through, "plan") !== atLeast(through, "plan");
    const crossesPlan = old.lifecycle === "awaiting-plan-review" && planChanged;
    const res = await tx.run(
      `UPDATE claws_issues SET approved_through = ?, approved_through_by = ?, approved_through_at = ?, updated_at = ?${crossesPlan ? ", stage_changed_at = ?" : ""}${planChanged ? ", plan_approved_at = ?" : ""}
        WHERE id = ? AND approved_through = ?`,
      [through, by, now, now, ...(crossesPlan ? [now] : []), ...(planChanged ? [atLeast(through, "plan") ? now : null] : []), id, old.approved_through],
    );
    if (res.changes > 0 && old.kind === "issue") await recordIssueHistory(tx, id, "approved_through", old.approved_through, through);
    return res.changes > 0;
  });
}

/** Replace a native issue's repo associations wholesale. */
export async function setClawsIssueRepos(id: string, repos: readonly string[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const before = await tx.all(`SELECT repo FROM claws_issue_repos WHERE issue_id = ?`, [id]) as { repo: string }[];
    await tx.run(`DELETE FROM claws_issue_repos WHERE issue_id = ?`, [id]);
    for (const repo of new Set(repos)) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_repos (issue_id, repo) VALUES (?, ?)`, [id, repo]);
    }
    await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ?`, [nowSql(), id]);
    const list = (names: Iterable<string>) => [...new Set(names)].sort().join(", ");
    await recordIssueHistory(tx, id, "repos", list(before.map((r) => r.repo)), list(repos));
  });
}

/**
 * Pin a native issue's primary repo ({@link primaryRepoOf}), so adding a repo
 * that sorts earlier does not take over planning and labels. `repo` should be
 * one of the issue's repos; an unlisted pin is ignored by the readers.
 */
export async function setClawsIssuePrimaryRepo(id: string, repo: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    await tx.run(`UPDATE claws_issues SET primary_repo = ?, updated_at = ? WHERE id = ?`, [repo, nowSql(), id]);
  });
}


/**
 * The open, non-shadow native issue in `repo` (its primary repo) titled
 * exactly `title` — or first filed under it, before a rename — that was
 * itself imported from a `repo` forge issue — the target when a recurring
 * workflow re-files a forge issue Claws already moved, so the importer
 * updates it instead of importing a duplicate. Newest first when several
 * match. A natively filed issue never matches.
 */
export async function findOpenImportedIssueByTitle(repo: string, title: string): Promise<ClawsIssueRecord | undefined> {
  const row = await getDb().get(
    `SELECT id FROM claws_issues
      WHERE state = 'open' AND kind <> 'shadow' AND (title = ? OR filed_title = ?)
        AND ${primaryRepoSql()} = ?
        AND EXISTS (SELECT 1 FROM imported_issues i WHERE i.native_id = claws_issues.id AND i.repo = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [title, title, repo, repo],
  ) as { id: string } | undefined;
  return row ? await getClawsIssue(String(row.id)) : undefined;
}
