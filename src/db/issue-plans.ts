// Per-issue model plan, planned PRs and design-change re-approvals.
// Reached only through the src/db.ts façade.
import { type InfraDeclaration, validateInfraDeclaration } from "../infra-declaration.js";
import { type IssueRef } from "../issue-id.js";
import { getDb, nowSql, refParam } from "./core.js";
import { type ClawsIssueRecord, type ClawsIssueRow, loadIssueSidecars, primaryRepoSql, recordIssueHistory, toClawsRecords } from "./issues.js";

// ── Per-issue model plan (docs/model-selection.md) ──

export type IssueModelPlanSource = "explicit" | "suggested";

export interface IssueModelPlanRow {
  repo: string;
  issue_ref: string;
  phase: string;
  provider: string | null;
  tier: string | null;
  source: IssueModelPlanSource;
  updated_at: string;
}

/** Every stored model-plan cell for one issue, in no particular order. */
export async function getIssueModelPlanRows(repo: string, ref: IssueRef): Promise<IssueModelPlanRow[]> {
  return await getDb().all(
    `SELECT repo, issue_ref, phase, provider, tier, source, updated_at FROM issue_model_plan WHERE repo = ? AND issue_ref = ?`,
    [repo, refParam(ref)],
  ) as IssueModelPlanRow[];
}

/**
 * Every operator-set cell across every issue, for the board's per-card
 * summary. The table holds at most six rows per planned issue and only the
 * explicit ones are read, so one unscoped read is cheaper than a lookup per card.
 */
export async function listExplicitIssueModelPlanRows(): Promise<IssueModelPlanRow[]> {
  return await getDb().all(
    `SELECT repo, issue_ref, phase, provider, tier, source, updated_at FROM issue_model_plan WHERE source = 'explicit'`,
  ) as IssueModelPlanRow[];
}

/**
 * Write one cell. A `suggested` write never replaces an `explicit` row — the
 * planner refreshes its own suggestions on every plan, but an operator's choice
 * stands until the operator clears it. Returns false when the write was refused
 * for that reason.
 */
export async function upsertIssueModelPlanCell(
  repo: string,
  ref: IssueRef,
  phase: string,
  cell: { provider: string | null; tier: string | null; source: IssueModelPlanSource },
): Promise<boolean> {
  const res = await getDb().run(
    `INSERT INTO issue_model_plan (repo, issue_ref, phase, provider, tier, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, issue_ref, phase) DO UPDATE SET
       provider = excluded.provider, tier = excluded.tier, source = excluded.source, updated_at = excluded.updated_at
     WHERE issue_model_plan.source <> 'explicit' OR excluded.source = 'explicit'`,
    [repo, refParam(ref), phase, cell.provider, cell.tier, cell.source, nowSql()],
  );
  return res.changes > 0;
}

/**
 * Delete one cell so the phase falls back to its default. With `onlySource`,
 * only a row of that source is removed — how the planner withdraws a suggestion
 * it no longer makes without touching an operator's explicit cell.
 */
export async function deleteIssueModelPlanCell(repo: string, ref: IssueRef, phase: string, onlySource?: IssueModelPlanSource): Promise<void> {
  if (onlySource) {
    await getDb().run(`DELETE FROM issue_model_plan WHERE repo = ? AND issue_ref = ? AND phase = ? AND source = ?`, [repo, refParam(ref), phase, onlySource]);
    return;
  }
  await getDb().run(`DELETE FROM issue_model_plan WHERE repo = ? AND issue_ref = ? AND phase = ?`, [repo, refParam(ref), phase]);
}

/**
 * Drop an issue's model-plan rows keyed to any repo other than `keepRepo`
 * (every row when `keepRepo` is null). A plan is keyed to the issue's primary
 * repo, so once that changes the old repo's rows are orphaned — left in place
 * they would resurface on the board under a repo the card is no longer listed
 * under.
 */
export async function deleteIssueModelPlanRowsExceptRepo(ref: IssueRef, keepRepo: string | null): Promise<void> {
  if (keepRepo === null) {
    await getDb().run(`DELETE FROM issue_model_plan WHERE issue_ref = ?`, [refParam(ref)]);
    return;
  }
  await getDb().run(`DELETE FROM issue_model_plan WHERE issue_ref = ? AND repo <> ?`, [refParam(ref), keepRepo]);
}

// ── Planned PRs: the PR list a plan needs (`claws_issue_prs`) ──

/** One PR a plan needs, 1-based `position` in merge order. */
export interface IssuePlannedPR {
  position: number;
  repo: string;
  title: string;
  /** The PR Claws opened (or pushed onto) for this position, or null. */
  prNumber: number | null;
  /**
   * Earlier positions this PR must land after: `[]` is independent, null is
   * unspecified — the plan header's suffix, else the previous PR.
   */
  dependsOn: number[] | null;
  /** `pr` is implemented by Claws; `manual` is an operator step with no PR. */
  kind: "pr" | "manual";
  /** The operator step that must be done before this PR merges, or null. */
  manualAction: string | null;
  /**
   * The open PR an approved design change reworks into this step, which the
   * implementer pushes onto instead of opening a new PR. Absent reads as null.
   */
  targetPrNumber?: number | null;
  /** The Tofu changes the planner declared for this PR (`infra_changes`); absent reads as none. */
  infraChanges?: InfraDeclaration | null;
  /** The files or directory prefixes the planner declared this step changes (`paths`); absent reads as none. */
  paths?: string[] | null;
}

/** An entry `replaceIssuePlannedPRs` writes; `kind` defaults to `pr`. */
export interface IssuePlannedPRInput {
  repo: string;
  title: string;
  dependsOn?: readonly number[] | null;
  kind?: "pr" | "manual";
  manualAction?: string | null;
  infraChanges?: InfraDeclaration | null;
  paths?: readonly string[] | null;
}

type IssuePlannedPRRow = {
  position: unknown; repo: string; title: string; pr_number: unknown; depends_on: unknown;
  kind?: unknown; manual_action?: unknown; target_pr_number?: unknown; infra_changes?: unknown; paths?: unknown;
};

const PLANNED_PR_COLUMNS = "position, repo, title, pr_number, depends_on, kind, manual_action, target_pr_number, infra_changes, paths";

/** A stored `paths` value; anything that is not a non-empty JSON array of strings reads as null. */
export function parsePlannedPaths(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === "string" && p !== "")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

function plannedPathsParam(paths: readonly string[] | null | undefined): string | null {
  return paths && paths.length > 0 ? JSON.stringify(paths) : null;
}

/** A stored `infra_changes` value; anything that does not validate reads as null. */
function parseInfraChanges(raw: unknown): InfraDeclaration | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = validateInfraDeclaration(JSON.parse(raw));
    return typeof parsed === "string" ? null : parsed;
  } catch {
    return null;
  }
}

/** A stored `depends_on` value; anything that is not a JSON array of positive integers reads as null. */
function parseDependsOn(raw: unknown): number[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n > 0)) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}

function plannedPRFromRow(r: IssuePlannedPRRow): IssuePlannedPR {
  return {
    position: Number(r.position),
    repo: r.repo,
    title: r.title,
    prNumber: r.pr_number === null || r.pr_number === undefined ? null : Number(r.pr_number),
    dependsOn: parseDependsOn(r.depends_on),
    kind: r.kind === "manual" ? "manual" : "pr",
    manualAction: typeof r.manual_action === "string" && r.manual_action !== "" ? r.manual_action : null,
    ...(r.target_pr_number === null || r.target_pr_number === undefined ? {} : { targetPrNumber: Number(r.target_pr_number) }),
    ...(() => { const infraChanges = parseInfraChanges(r.infra_changes); return infraChanges ? { infraChanges } : {}; })(),
    ...(() => { const paths = parsePlannedPaths(r.paths); return paths ? { paths } : {}; })(),
  };
}

/**
 * The native id `repo#forgeNumber` is linked to through `imported_issues`,
 * imported *or* shadowed, or undefined. Unlike the in-process alias index this
 * answers for a shadow too, which is what `planned-prs.ts` keys a forge issue's
 * PR list by.
 */
export async function getLinkedNativeId(repo: string, forgeNumber: IssueRef): Promise<string | undefined> {
  const row = await getDb().get(
    `SELECT native_id FROM imported_issues WHERE repo = ? AND forge_number = ?`,
    [repo, refParam(forgeNumber)],
  ) as { native_id: string } | undefined;
  return row ? String(row.native_id) : undefined;
}

export async function getIssuePlannedPRs(issueId: string): Promise<IssuePlannedPR[]> {
  const rows = await getDb().all(
    `SELECT ${PLANNED_PR_COLUMNS} FROM claws_issue_prs WHERE issue_id = ? ORDER BY position ASC`,
    [issueId],
  ) as IssuePlannedPRRow[];
  return rows.map(plannedPRFromRow);
}

/**
 * Replace an issue's planned-PR list in one transaction. `entries` are taken in
 * order as positions 1..n. An old `pr_number` carries over to the same position
 * when the repo and kind are unchanged, so a re-plan that keeps a shipped step
 * in place keeps its link. `dependsOn` and `manualAction` are written as given
 * (absent is null); `kind` defaults to `pr`.
 *
 * Clears the issue's tofu destroy consent (`approved_destroys`): consent
 * covers one plan version, and re-granting it is a Plan withdraw-and-approve.
 *
 * Returns the old entries whose link did NOT carry over — a position that was
 * dropped, or whose repo or kind changed — so the caller can warn that a PR
 * Claws already opened is no longer tracked by the plan.
 */
export async function replaceIssuePlannedPRs(
  issueId: string,
  entries: readonly IssuePlannedPRInput[],
): Promise<IssuePlannedPR[]> {
  return await getDb().transaction(async (tx) => {
    const oldRows = await tx.all(
      `SELECT ${PLANNED_PR_COLUMNS} FROM claws_issue_prs WHERE issue_id = ?`,
      [issueId],
    ) as IssuePlannedPRRow[];
    const old = new Map(oldRows.map((r) => [Number(r.position), plannedPRFromRow(r)]));
    await tx.run(`DELETE FROM claws_issue_prs WHERE issue_id = ?`, [issueId]);
    const carried = new Set<number>();
    for (const [i, entry] of entries.entries()) {
      const position = i + 1;
      const prev = old.get(position);
      const kind = entry.kind ?? "pr";
      const prNumber = prev && prev.prNumber !== null && prev.repo === entry.repo && prev.kind === kind ? prev.prNumber : null;
      if (prNumber !== null) carried.add(position);
      await tx.run(
        `INSERT INTO claws_issue_prs (issue_id, position, repo, title, pr_number, depends_on, kind, manual_action, infra_changes, paths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [issueId, position, entry.repo, entry.title, prNumber, entry.dependsOn ? JSON.stringify(entry.dependsOn) : null, kind, entry.manualAction ?? null, entry.infraChanges ? JSON.stringify(entry.infraChanges) : null, kind === "manual" ? null : plannedPathsParam(entry.paths)],
      );
    }
    // A new plan version withdraws the destroy consent given for the old one (src/destroy-consent.ts).
    await tx.run(
      `UPDATE claws_issues SET approved_destroys = NULL, approved_destroys_by = NULL, approved_destroys_at = NULL WHERE id = ?`,
      [issueId],
    );
    return [...old.values()]
      .filter((e) => e.prNumber !== null && !carried.has(e.position))
      .sort((a, b) => a.position - b.position);
  });
}

/**
 * Append an operator (`manual`) step to an issue's stored list at
 * `MAX(position) + 1`, depending on every earlier position, and return it.
 * Unlike {@link replaceIssuePlannedPRs} this keeps every existing entry, its
 * link and the issue's destroy consent (`approved_destroys`): the plan version
 * is unchanged, only a step is added to it (`src/post-merge-step.ts`).
 */
export async function appendIssuePlannedPR(
  issueId: string,
  entry: { repo: string; title: string; manualAction?: string | null },
): Promise<IssuePlannedPR> {
  return await getDb().transaction(async (tx) => {
    const max = await tx.get(
      `SELECT MAX(position) AS max_position FROM claws_issue_prs WHERE issue_id = ?`,
      [issueId],
    ) as { max_position: unknown } | undefined;
    const last = max?.max_position === null || max?.max_position === undefined ? 0 : Number(max.max_position);
    const position = last + 1;
    const dependsOn = Array.from({ length: last }, (_, i) => i + 1);
    await tx.run(
      `INSERT INTO claws_issue_prs (issue_id, position, repo, title, pr_number, depends_on, kind, manual_action, infra_changes, paths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [issueId, position, entry.repo, entry.title, null, JSON.stringify(dependsOn), "manual", entry.manualAction ?? null, null, null],
    );
    return { position, repo: entry.repo, title: entry.title, prNumber: null, dependsOn, kind: "manual", manualAction: entry.manualAction ?? null };
  });
}

/** One resource the operator consented to destroy (or replace) with the Plan approval. */
export interface ApprovedDestroy {
  /** The planned PR's position. */
  position: number;
  repo: string;
  /** The tofu root directory. */
  root: string;
  /** An exact resource address — never a wildcard. */
  address: string;
}

/** An issue's recorded tofu destroy consent. */
export interface IssueApprovedDestroys {
  destroys: ApprovedDestroy[];
  by: string;
  /** `YYYY-MM-DD HH:MM:SS` UTC. */
  at: string;
}

function parseApprovedDestroys(raw: unknown): ApprovedDestroy[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((d: unknown) => {
      if (typeof d !== "object" || d === null) return [];
      const r = d as Record<string, unknown>;
      return Number.isInteger(r["position"]) && typeof r["repo"] === "string" && typeof r["root"] === "string" && typeof r["address"] === "string"
        ? [{ position: r["position"] as number, repo: r["repo"], root: r["root"], address: r["address"] }]
        : [];
    });
  } catch {
    return null;
  }
}

/** `trackerId`'s recorded destroy consent, or null when none is recorded (never given, withdrawn, or cleared by a re-plan). */
export async function getApprovedDestroys(trackerId: string): Promise<IssueApprovedDestroys | null> {
  const row = await getDb().get(
    `SELECT approved_destroys, approved_destroys_by, approved_destroys_at FROM claws_issues WHERE id = ?`,
    [trackerId],
  ) as { approved_destroys: string | null; approved_destroys_by: string | null; approved_destroys_at: string | null } | undefined;
  const destroys = parseApprovedDestroys(row?.approved_destroys);
  if (!destroys || !row?.approved_destroys_by || !row.approved_destroys_at) return null;
  return { destroys, by: row.approved_destroys_by, at: row.approved_destroys_at };
}

/** Record `by`'s destroy consent for `trackerId` — `destroys` may be empty. Returns false for an unknown id. */
export async function setApprovedDestroys(trackerId: string, destroys: readonly ApprovedDestroy[], by: string): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE claws_issues SET approved_destroys = ?, approved_destroys_by = ?, approved_destroys_at = ? WHERE id = ?`,
    [JSON.stringify(destroys), by, nowSql(), trackerId],
  );
  return res.changes > 0;
}

/** Withdraw `trackerId`'s destroy consent. */
export async function clearApprovedDestroys(trackerId: string): Promise<void> {
  await getDb().run(
    `UPDATE claws_issues SET approved_destroys = NULL, approved_destroys_by = NULL, approved_destroys_at = NULL WHERE id = ?`,
    [trackerId],
  );
}

/** An issue's declaring planned-PR entries and its recorded destroy consent. */
export interface IssueInfraDeclarations {
  entries: IssuePlannedPR[];
  /** The tofu destroy consent recorded with the Plan approval (src/destroy-consent.ts), or null. */
  destroyConsent: IssueApprovedDestroys | null;
}

/**
 * The planned-PR entries with a declaration and the recorded destroy consent
 * of each of `trackerIds` that has at least one
 * declaration — one query each, for the board.
 */
export async function listIssueInfraDeclarations(
  trackerIds: readonly string[],
): Promise<Map<string, IssueInfraDeclarations>> {
  const out = new Map<string, IssueInfraDeclarations>();
  if (trackerIds.length === 0) return out;
  const placeholders = trackerIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT issue_id, ${PLANNED_PR_COLUMNS} FROM claws_issue_prs
      WHERE issue_id IN (${placeholders}) AND infra_changes IS NOT NULL ORDER BY issue_id, position ASC`,
    [...trackerIds],
  ) as (IssuePlannedPRRow & { issue_id: string })[];
  for (const r of rows) {
    const entry = plannedPRFromRow(r);
    if (!entry.infraChanges) continue;
    const id = String(r.issue_id);
    const slot = out.get(id) ?? { entries: [], destroyConsent: null };
    slot.entries.push(entry);
    out.set(id, slot);
  }
  if (out.size === 0) return out;
  const ids = [...out.keys()];
  const consents = await getDb().all(
    `SELECT id, approved_destroys, approved_destroys_by, approved_destroys_at
       FROM claws_issues WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  ) as {
    id: string; approved_destroys: string | null; approved_destroys_by: string | null; approved_destroys_at: string | null;
  }[];
  for (const a of consents) {
    const slot = out.get(String(a.id))!;
    const destroys = parseApprovedDestroys(a.approved_destroys);
    if (destroys && a.approved_destroys_by && a.approved_destroys_at) slot.destroyConsent = { destroys, by: a.approved_destroys_by, at: a.approved_destroys_at };
  }
  return out;
}

/** Record why Claws parked `trackerId` in Blocked for a human. Covers a shadow too. */
export async function setIssueBlockedReason(trackerId: string, reason: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT blocked_reason, kind FROM claws_issues WHERE id = ?`, [trackerId]) as { blocked_reason: string | null; kind: string } | undefined;
    const res = await tx.run(
      `UPDATE claws_issues SET blocked_reason = ?, blocked_reason_at = ? WHERE id = ?`,
      [reason, nowSql(), trackerId],
    );
    if (res.changes > 0 && old?.kind === "issue") await recordIssueHistory(tx, trackerId, "blocked_reason", old.blocked_reason, reason);
  });
}

/**
 * Record the board column each issue sits in, as the issue-dispatcher's sweep
 * derived it. An issue whose stored `board_column` already matches is left
 * alone, so `board_column_at` keeps meaning "entered this column". A first
 * recording (`board_column` NULL) takes `stage_changed_at` as the entry time
 * when it has one, so an issue already stuck when the column was added shows
 * its real age. Returns the ids whose column changed.
 */
export async function recordIssueBoardColumns(entries: ReadonlyArray<{ id: string; column: string }>): Promise<string[]> {
  if (entries.length === 0) return [];
  return await getDb().transaction(async (tx) => {
    const now = nowSql();
    const changed: string[] = [];
    for (const { id, column } of entries) {
      const res = await tx.run(
        `UPDATE claws_issues SET board_column = ?,
            board_column_at = CASE WHEN board_column IS NULL THEN COALESCE(stage_changed_at, ?) ELSE ? END
          WHERE id = ? AND (board_column IS NULL OR board_column <> ?)`,
        [column, now, now, id, column],
      );
      if (res.changes > 0) changed.push(id);
    }
    return changed;
  });
}

/**
 * Set or clear (`until === null`) the day native issue `id` returns from the
 * Backlog. Refuses — returns false — unless `id` is an open `kind = 'issue'`
 * row in `backlog`: a date on any other issue would sit inert until some
 * later move, or never mean anything at all. `until` is a validated
 * `YYYY-MM-DD` day (`backlog-until.ts`'s `parseBacklogUntil`).
 */
export async function setClawsIssueBacklogUntil(id: string, until: string | null): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(
      `SELECT backlog_until FROM claws_issues WHERE id = ? AND kind = 'issue' AND lifecycle = 'backlog'`,
      [id],
    ) as { backlog_until: string | null } | undefined;
    if (!old) return false;
    if ((old.backlog_until ?? null) === until) return true;
    const now = nowSql();
    await tx.run(
      `UPDATE claws_issues SET backlog_until = ?, backlog_until_at = ?, updated_at = ? WHERE id = ?`,
      [until, until === null ? null : now, now, id],
    );
    await recordIssueHistory(tx, id, "backlog_until", old.backlog_until ?? null, until);
    return true;
  });
}

/**
 * Lift the file-overlap hold on open native issue `id` for the whole issue
 * until it closes (Start anyway, #clw_01M7WDMJ9GCF6MCZ0BPKN3333S), recording
 * `by` and an `overlap_hold_lifted` history entry. False when `id` is not an
 * open native issue; true, writing nothing, when the hold is already lifted.
 */
export async function setClawsIssueOverlapHoldLifted(id: string, by: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(
      `SELECT overlap_hold_lifted_at FROM claws_issues WHERE id = ? AND kind = 'issue' AND state = 'open'`,
      [id],
    ) as { overlap_hold_lifted_at: string | null } | undefined;
    if (!old) return false;
    if (old.overlap_hold_lifted_at) return true;
    const now = nowSql();
    await tx.run(
      `UPDATE claws_issues SET overlap_hold_lifted_at = ?, overlap_hold_lifted_by = ?, updated_at = ? WHERE id = ?`,
      [now, by, now, id],
    );
    await recordIssueHistory(tx, id, "overlap_hold_lifted", null, by);
    return true;
  });
}

/**
 * Open native issues whose primary repo is `repo`, parked in the Backlog
 * with a return day on or before `today` (`YYYY-MM-DD`) — the ones the
 * dispatcher's sweep brings back. `today` is bound as a parameter so the
 * comparison is a plain string compare on both drivers.
 */
export async function listDueBacklogIssues(repo: string, today: string): Promise<ClawsIssueRecord[]> {
  const tail = `WHERE state = 'open' AND kind = 'issue' AND lifecycle = 'backlog' AND backlog_until IS NOT NULL AND backlog_until <= ? AND ${primaryRepoSql()} = ?
      ORDER BY id ASC`;
  const params = [today, repo];
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/**
 * The return day of each of `issueIds` that is parked in the Backlog with
 * one. One query for the whole batch, for the board and `/backlog`.
 */
export async function getIssueBacklogUntil(issueIds: readonly string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT id, backlog_until FROM claws_issues
      WHERE id IN (${placeholders}) AND lifecycle = 'backlog' AND backlog_until IS NOT NULL`,
    [...issueIds],
  ) as { id: string; backlog_until: string }[];
  return new Map(rows.map((r) => [String(r.id), String(r.backlog_until)]));
}

/**
 * The stored Blocked reason of each of `issueIds` that has a current one: the
 * issue is `blocked` and the reason was recorded no earlier than it entered
 * that stage. One query for the whole batch, for the board.
 */
export async function getIssueBlockedReasons(issueIds: readonly string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT id, blocked_reason FROM claws_issues
      WHERE id IN (${placeholders}) AND lifecycle = 'blocked' AND blocked_reason IS NOT NULL
        AND (stage_changed_at IS NULL OR blocked_reason_at >= stage_changed_at)`,
    [...issueIds],
  ) as { id: string; blocked_reason: string }[];
  return new Map(rows.map((r) => [String(r.id), r.blocked_reason]));
}

/**
 * Open `blocked` issues whose current Blocked reason names a PR (starts
 * ``PR ` ``) — the candidates `pr-stall-park.ts` may release. "Current" is
 * the same check as {@link getIssueBlockedReasons}: a reason recorded before
 * the issue last changed stage is not returned.
 */
export async function listPrStallParkCandidates(): Promise<{ id: string; blocked_reason: string }[]> {
  const rows = await getDb().all(
    `SELECT id, blocked_reason FROM claws_issues
      WHERE state = 'open' AND lifecycle = 'blocked' AND blocked_reason LIKE 'PR \`%'
        AND (stage_changed_at IS NULL OR blocked_reason_at >= stage_changed_at)
      ORDER BY id ASC`,
  ) as { id: string; blocked_reason: string }[];
  return rows.map((r) => ({ id: String(r.id), blocked_reason: r.blocked_reason }));
}

/**
 * Open `blocked` issues whose current Blocked reason says they wait on open
 * PRs to merge (starts ``Waiting on ` ``) — the candidates `pr-wait-park.ts`
 * may release. "Current" is the same check as {@link listPrStallParkCandidates}.
 */
export async function listPrWaitParkCandidates(): Promise<{ id: string; blocked_reason: string }[]> {
  const rows = await getDb().all(
    `SELECT id, blocked_reason FROM claws_issues
      WHERE state = 'open' AND lifecycle = 'blocked' AND blocked_reason LIKE 'Waiting on \`%'
        AND (stage_changed_at IS NULL OR blocked_reason_at >= stage_changed_at)
      ORDER BY id ASC`,
  ) as { id: string; blocked_reason: string }[];
  return rows.map((r) => ({ id: String(r.id), blocked_reason: r.blocked_reason }));
}

/**
 * The subset of `issueIds` awaiting the operator: the stored list has a
 * `manual` entry and every `pr` entry before the lowest-position `manual` step
 * is linked to a `claws_prs` row at stage `merged`, mapped to that step. A step
 * placed mid-plan counts once the PRs ahead of it merge. Batched, for the board.
 */
export async function getIssueIdsAwaitingOperator(issueIds: readonly string[]): Promise<Map<string, { position: number; title: string }>> {
  const out: Map<string, { position: number; title: string }> = new Map();
  if (issueIds.length === 0) return out;
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT ip.issue_id AS issue_id
       FROM claws_issue_prs ip
       JOIN (SELECT issue_id, MIN(position) AS manual_position FROM claws_issue_prs
              WHERE kind = 'manual' AND issue_id IN (${placeholders})
              GROUP BY issue_id) m ON m.issue_id = ip.issue_id
       LEFT JOIN claws_prs p ON p.repo = ip.repo AND p.pr_number = ip.pr_number
      WHERE ip.issue_id IN (${placeholders})
      GROUP BY ip.issue_id
     HAVING SUM(CASE WHEN ip.kind <> 'manual' AND ip.position < m.manual_position AND (p.stage IS NULL OR p.stage <> 'merged') THEN 1 ELSE 0 END) = 0`,
    [...issueIds, ...issueIds],
  ) as { issue_id: string }[];
  if (rows.length === 0) return out;
  const ids = rows.map((r) => String(r.issue_id));
  const steps = await getDb().all(
    `SELECT issue_id, position, title FROM claws_issue_prs
      WHERE kind = 'manual' AND issue_id IN (${ids.map(() => "?").join(",")})
      ORDER BY position`,
    ids,
  ) as { issue_id: string; position: number; title: string }[];
  for (const step of steps) {
    const id = String(step.issue_id);
    if (!out.has(id)) out.set(id, { position: Number(step.position), title: String(step.title) });
  }
  return out;
}

/** Record the PR Claws opened for `position`. A no-op when there is no such entry. */
export async function linkIssuePlannedPR(issueId: string, position: number, prNumber: number): Promise<void> {
  await getDb().run(
    `UPDATE claws_issue_prs SET pr_number = ? WHERE issue_id = ? AND position = ?`,
    [prNumber, issueId, position],
  );
}

export async function unlinkIssuePlannedPR(issueId: string, position: number): Promise<void> {
  await getDb().run(
    `UPDATE claws_issue_prs SET pr_number = NULL WHERE issue_id = ? AND position = ?`,
    [issueId, position],
  );
}

/** Set (or clear, with null) the open PR the implementer pushes `position` onto. A no-op when there is no such entry. */
export async function setIssuePlannedPRTarget(issueId: string, position: number, prNumber: number | null): Promise<void> {
  await getDb().run(
    `UPDATE claws_issue_prs SET target_pr_number = ? WHERE issue_id = ? AND position = ?`,
    [prNumber, issueId, position],
  );
}

// ── Design-change re-approval (`claws_issue_reapprovals`) ──

/** What an approved design change does to one open PR of the old plan. */
export interface IssueReapprovalFate {
  repo: string;
  number: number;
  /** `close` closes it; `rework` retargets it at `position`; `keep` links it to `position`; `retire` unlinks a merged PR the revised plan has no step for. */
  fate: "close" | "rework" | "keep" | "retire";
  /** The revised plan's 1-based position it covers, for `rework` and `keep`. */
  position: number | null;
}

/** A design change and its re-approval state, keyed by tracker id. */
export interface IssueReapproval {
  issueId: string;
  /** The unapproved requirements version the change stored. */
  requirementsVersion: number;
  /** The plan comment edited in place with the pending plan. */
  planCommentId: string | null;
  /** The revised plan's PR list; replaces `claws_issue_prs` on approval. */
  prs: IssuePlannedPRInput[];
  fates: IssueReapprovalFate[];
  /** The comments the change answered. */
  sourceCommentIds: string[];
  requestedAt: string;
  /** Null while the change waits for the operator. */
  approvedAt: string | null;
  approvedBy: string | null;
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function reapprovalFromRow(r: Record<string, unknown>): IssueReapproval {
  return {
    issueId: String(r.issue_id),
    requirementsVersion: Number(r.requirements_version),
    planCommentId: r.plan_comment_id == null ? null : String(r.plan_comment_id),
    prs: parseJsonArray(r.prs) as IssuePlannedPRInput[],
    fates: parseJsonArray(r.fates) as IssueReapprovalFate[],
    sourceCommentIds: parseJsonArray(r.source_comment_ids).map(String),
    requestedAt: String(r.requested_at),
    approvedAt: r.approved_at == null ? null : String(r.approved_at),
    approvedBy: r.approved_by == null ? null : String(r.approved_by),
  };
}

/** The issue's re-approval row, pending or approved, or null when it has none. */
export async function getIssueReapproval(issueId: string): Promise<IssueReapproval | null> {
  const row = await getDb().get(`SELECT * FROM claws_issue_reapprovals WHERE issue_id = ?`, [issueId]) as Record<string, unknown> | undefined;
  return row ? reapprovalFromRow(row) : null;
}

/**
 * Record a design change as pending re-approval, replacing whatever row the
 * issue had — an earlier pending change the new one supersedes, or an
 * approved one now history.
 */
export async function upsertIssueReapproval(
  row: Pick<IssueReapproval, "issueId" | "requirementsVersion" | "planCommentId" | "prs" | "fates" | "sourceCommentIds">,
): Promise<void> {
  await getDb().run(
    `INSERT INTO claws_issue_reapprovals (issue_id, requirements_version, plan_comment_id, prs, fates, source_comment_ids, requested_at, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(issue_id) DO UPDATE SET
       requirements_version = excluded.requirements_version,
       plan_comment_id = excluded.plan_comment_id,
       prs = excluded.prs,
       fates = excluded.fates,
       source_comment_ids = excluded.source_comment_ids,
       requested_at = excluded.requested_at,
       approved_at = NULL,
       approved_by = NULL`,
    [row.issueId, row.requirementsVersion, row.planCommentId, JSON.stringify(row.prs), JSON.stringify(row.fates),
      JSON.stringify(row.sourceCommentIds), nowSql()],
  );
}

/** Mark the issue's pending re-approval approved. False when there is none pending. */
export async function markIssueReapprovalApproved(issueId: string, approvedBy: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE claws_issue_reapprovals SET approved_at = ?, approved_by = ? WHERE issue_id = ? AND approved_at IS NULL`,
    [nowSql(), approvedBy, issueId],
  );
  return result.changes > 0;
}

/**
 * The subset of `issueIds` with a design change pending re-approval — one
 * query for the whole batch, for the board and the dispatcher. With no
 * `issueIds` at all, every pending issue.
 */
export async function listPendingReapprovalIssueIds(issueIds?: readonly string[]): Promise<Set<string>> {
  if (issueIds && issueIds.length === 0) return new Set();
  const rows = issueIds
    ? await getDb().all(
      `SELECT issue_id FROM claws_issue_reapprovals WHERE approved_at IS NULL AND issue_id IN (${issueIds.map(() => "?").join(",")})`,
      [...issueIds],
    ) as { issue_id: string }[]
    : await getDb().all(`SELECT issue_id FROM claws_issue_reapprovals WHERE approved_at IS NULL`) as { issue_id: string }[];
  return new Set(rows.map((r) => String(r.issue_id)));
}

/**
 * Which of `issueIds` have approved requirements (`requirements_approved_at`
 * set) — the approval track's Reqs gate, for the board. The same predicate
 * `/board/approve-through` and the issue page read off the issue row.
 */
export async function listRequirementsApprovedIssueIds(issueIds: readonly string[]): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = await getDb().all(
    `SELECT id FROM claws_issues WHERE requirements_approved_at IS NOT NULL AND id IN (${issueIds.map(() => "?").join(",")})`,
    [...issueIds],
  ) as { id: string }[];
  return new Set(rows.map((r) => String(r.id)));
}

/**
 * The issue a PR implements and the phase (1-based plan position) it is, looked
 * up in `claws_issue_prs` by `(repo, pr_number)`. Null when no
 * plan links the PR. Used by the PR dispatcher to back-fill `claws_prs.issue_id`.
 */
export async function findIssuePlannedPRByNumber(
  repo: string,
  prNumber: number,
): Promise<{ issueId: string; position: number } | null> {
  const row = await getDb().get(
    `SELECT issue_id, position FROM claws_issue_prs WHERE repo = ? AND pr_number = ? ORDER BY issue_id ASC, position ASC LIMIT 1`,
    [repo, prNumber],
  ) as { issue_id: string; position: unknown } | undefined;
  return row ? { issueId: String(row.issue_id), position: Number(row.position) } : null;
}

