// Typed links between tracker issues and shadow issues (the native backing
// record of a live forge issue). Reached only through the src/db.ts façade.
import { type ApprovedThrough, isApprovedThrough } from "../issue-approval.js";
import { type IssueRef, newClawsIssueId, newClawsLinkId, refFromColumn } from "../issue-id.js";
import { type IssueLifecycle, resolveStage, splitStateLabels } from "../issue-lifecycle.js";
import { getDb, nowSql, refParam } from "./core.js";
import { type ClawsIssueRecord, type ClawsIssueRow, type IssueSource, autoPromoteParam, isNativeIssueRow, loadIssueSidecars, primaryRepoSql, recordIssueHistory, requireClawsIssue, toClawsRecords } from "./issues.js";

// ── Links: typed relationships between tracker issues (docs/issue-tracker.md#links) ──

/** A stored link kind. `blocks` is an input spelling only: stored as `depends_on` with the ends swapped. */
export type ClawsIssueLinkKind = "depends_on" | "relates_to";

export interface ClawsIssueLinkRow {
  id: string;
  source_id: string;
  target_id: string;
  kind: ClawsIssueLinkKind;
  created_by: string;
  created_at: string;
  released_at: string | null;
  /** The target's step (1-based) a `depends_on` link waits for, or null for the whole issue. */
  target_step: number | null;
}

/** A link as seen from one of its ends, with the other end's title and state. */
export interface ClawsIssueLinkWithOther extends ClawsIssueLinkRow {
  other_id: string;
  other_title: string;
  other_state: string;
  other_state_reason: string | null;
  other_lifecycle: IssueLifecycle;
  other_kind: string;
}

/**
 * Record a link and return it, or the existing row when the same link is
 * already recorded. Both ends must exist; `actingId` — the issue the link was
 * added from — must also be a live native issue rather than a shadow, the same
 * rule every other by-id write keeps. The other end may be a shadow: that is
 * how a native issue depends on a forge one.
 *
 * `released` stores the link as already released — a dependency
 * on an issue that is closed when the link is made has nothing to unpark.
 * `targetStep` scopes a `depends_on` link to one step of the target; an
 * existing row keeps its own step.
 */
export async function createClawsIssueLink(input: {
  sourceId: string;
  targetId: string;
  kind: ClawsIssueLinkKind;
  createdBy: string;
  actingId: string;
  released?: boolean;
  targetStep?: number | null;
}): Promise<{ link: ClawsIssueLinkRow; created: boolean }> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, input.actingId);
    for (const id of [input.sourceId, input.targetId]) {
      if (!(await tx.get(`SELECT 1 AS present FROM claws_issues WHERE id = ?`, [id]))) {
        throw new Error(`claws-issues: no native issue ${id}`);
      }
    }
    const id = newClawsLinkId();
    const res = await tx.run(
      `INSERT OR IGNORE INTO claws_issue_links (id, source_id, target_id, kind, created_by, created_at, released_at, target_step)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.sourceId, input.targetId, input.kind, input.createdBy, now, input.released ? now : null, input.targetStep ?? null],
    );
    const row = linkRow(await tx.get(
      `SELECT * FROM claws_issue_links WHERE source_id = ? AND target_id = ? AND kind = ?`,
      [input.sourceId, input.targetId, input.kind],
    ) as ClawsIssueLinkRow);
    if (res.changes > 0 && await isNativeIssueRow(tx, input.sourceId)) {
      await recordIssueHistory(tx, input.sourceId, "link", null, linkHistoryValue(input.kind, input.targetId, row.target_step));
    }
    return { link: row, created: res.changes > 0 };
  });
}

/** How a link reads in History: `depends_on <id>`, or `depends_on <id> step <n>` for a step link. */
function linkHistoryValue(kind: string, targetId: string, step: number | null): string {
  return step === null ? `${kind} ${targetId}` : `${kind} ${targetId} step ${step}`;
}

/** `row` with `target_step` read as a number (Postgres may hand back a string or bigint). */
function linkRow<T extends ClawsIssueLinkRow>(row: T): T;
function linkRow<T extends ClawsIssueLinkRow>(row: T | undefined): T | undefined;
function linkRow<T extends ClawsIssueLinkRow>(row: T | undefined): T | undefined {
  if (!row) return row;
  return { ...row, target_step: row.target_step == null ? null : Number(row.target_step) };
}

export async function getClawsIssueLink(id: string): Promise<ClawsIssueLinkRow | undefined> {
  return linkRow(await getDb().get(`SELECT * FROM claws_issue_links WHERE id = ?`, [id]) as ClawsIssueLinkRow | undefined);
}

/** Remove a link. Returns false when it was already gone. */
export async function deleteClawsIssueLink(id: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const link = await tx.get(`SELECT source_id, target_id, kind, target_step FROM claws_issue_links WHERE id = ?`, [id]) as { source_id: string; target_id: string; kind: string; target_step: unknown } | undefined;
    const res = await tx.run(`DELETE FROM claws_issue_links WHERE id = ?`, [id]);
    if (res.changes > 0 && link && await isNativeIssueRow(tx, link.source_id)) {
      const step = link.target_step == null ? null : Number(link.target_step);
      await recordIssueHistory(tx, link.source_id, "link", linkHistoryValue(link.kind, link.target_id, step), null);
    }
    return res.changes > 0;
  });
}

/** Every link with `issueId` at either end, oldest first, joined with the other end. */
export async function listClawsIssueLinks(issueId: string): Promise<ClawsIssueLinkWithOther[]> {
  return (await getDb().all(
    `SELECT l.*, o.id AS other_id, o.title AS other_title, o.state AS other_state,
            o.state_reason AS other_state_reason, o.lifecycle AS other_lifecycle, o.kind AS other_kind
       FROM claws_issue_links l
       JOIN claws_issues o ON o.id = CASE WHEN l.source_id = ? THEN l.target_id ELSE l.source_id END
      WHERE l.source_id = ? OR l.target_id = ?
      ORDER BY l.id ASC`,
    [issueId, issueId, issueId],
  ) as ClawsIssueLinkWithOther[]).map((row) => linkRow(row));
}

/**
 * The issues `issueId` depends on that are still open — what the dispatcher's
 * implementer gate reads. A released link still counts: its target has
 * reopened since it fired, and reopened work is still unfinished.
 *
 * `target_step` is the step a step-scoped link waits for; whether that step
 * is done is for the caller (`issue-links.ts`) to read off the forge.
 */
export async function listOpenDependencyTargets(issueId: string): Promise<{ id: string; title: string; target_step: number | null }[]> {
  const rows = await getDb().all(
    `SELECT t.id, t.title, l.target_step FROM claws_issue_links l JOIN claws_issues t ON t.id = l.target_id
      WHERE l.source_id = ? AND l.kind = 'depends_on' AND t.state = 'open'
      ORDER BY l.id ASC`,
    [issueId],
  ) as { id: string; title: string; target_step: unknown }[];
  return rows.map((row) => ({
    id: String(row.id),
    title: row.title,
    target_step: row.target_step == null ? null : Number(row.target_step),
  }));
}

/**
 * For each of `issueIds`, every issue it depends on through a `depends_on`
 * link the dispatcher's sweep has not released yet, oldest link first, with
 * whether that issue is still open. An id with no such link is absent. One
 * query for the whole batch, for the board's Queued column.
 */
export async function listUnreleasedDependencyTargets(
  issueIds: readonly string[],
): Promise<Map<string, { id: string; title: string; open: boolean; target_step: number | null }[]>> {
  const result = new Map<string, { id: string; title: string; open: boolean; target_step: number | null }[]>();
  if (issueIds.length === 0) return result;
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT l.source_id, t.id, t.title, t.state, l.target_step FROM claws_issue_links l JOIN claws_issues t ON t.id = l.target_id
      WHERE l.source_id IN (${placeholders}) AND l.kind = 'depends_on' AND l.released_at IS NULL
      ORDER BY l.id ASC`,
    [...issueIds],
  ) as { source_id: string; id: string; title: string; state: string; target_step: unknown }[];
  for (const row of rows) {
    const source = String(row.source_id);
    const list = result.get(source) ?? [];
    list.push({
      id: String(row.id),
      title: row.title,
      open: row.state === "open",
      target_step: row.target_step == null ? null : Number(row.target_step),
    });
    result.set(source, list);
  }
  return result;
}

/**
 * Open native issues whose primary repo is `repo`, parked as Blocked, with at
 * least one unreleased `depends_on` link and no unreleased whole-issue link
 * still pointing at an open issue — the candidates the dispatcher's sweep
 * unparks. A step link to an open issue does not exclude one here: whether
 * its step is done is read off the forge by `issue-links.ts`.
 */
export async function listDependencyReleasableIssues(repo: string): Promise<ClawsIssueRecord[]> {
  const tail = `WHERE state = 'open' AND kind = 'issue' AND lifecycle = 'blocked' AND ${primaryRepoSql()} = ?
      AND EXISTS (SELECT 1 FROM claws_issue_links l WHERE l.source_id = claws_issues.id AND l.kind = 'depends_on' AND l.released_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM claws_issue_links l JOIN claws_issues t ON t.id = l.target_id
                       WHERE l.source_id = claws_issues.id AND l.kind = 'depends_on' AND l.released_at IS NULL AND t.state = 'open'
                         AND l.target_step IS NULL)
      ORDER BY id ASC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, [repo]) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, [repo]));
}

/**
 * True when `itemNumber` in `repo` has a queued or running `issue-refiner:*`
 * work_queue row — planner work still in flight for it.
 *
 * The dependency sweep checks this before unparking: releasing while the
 * planner is mid-run would let it later post a blocked verdict and re-park
 * the issue with every dependency link already stamped released, which no
 * later sweep would ever pick up again.
 */
export async function hasPendingIssueRefinerWork(repo: string, itemNumber: IssueRef): Promise<boolean> {
  const row = await getDb().get(
    `SELECT 1 AS present FROM work_queue WHERE repo = ? AND item_number = ? AND kind LIKE 'issue-refiner:%' AND status IN ('queued', 'running') LIMIT 1`,
    [repo, refParam(itemNumber)],
  ) as { present: number } | undefined;
  return row !== undefined;
}

/** Stamp every unreleased `depends_on` link of `issueId` as released; returns the number stamped. */
export async function markClawsIssueLinksReleased(issueId: string): Promise<number> {
  return await getDb().transaction(async (tx) => {
    const targets = await tx.all(
      `SELECT target_id FROM claws_issue_links WHERE source_id = ? AND kind = 'depends_on' AND released_at IS NULL ORDER BY id ASC`,
      [issueId],
    ) as { target_id: string }[];
    const changes = (await tx.run(
      `UPDATE claws_issue_links SET released_at = ? WHERE source_id = ? AND kind = 'depends_on' AND released_at IS NULL`,
      [nowSql(), issueId],
    )).changes;
    if (changes > 0 && await isNativeIssueRow(tx, issueId)) {
      await recordIssueHistory(tx, issueId, "dependency released", null, targets.map((t) => t.target_id).join(", "));
    }
    return changes;
  });
}

// ── Shadows: the native backing record of a live forge issue (#3246) ──
//
// Every issue Claws works has a `claws_issues` row whichever forge it was
// filed on, so a column or table added to the native schema covers all of
// them. A shadow is linked to its forge issue through `imported_issues`, the
// same table an import uses; only `kind` says which of the two a linkage row
// describes. `jobs/issue-shadow-sync.ts` is what mints shadows and keeps them
// in step with the forge; these helpers are the only writers of such a row.
//
// A shadow is not a second operator-facing issue. It carries no comments, is
// hidden from the façade's union, and nothing here ever writes to the forge.
// The writes below go through `db.ts` directly rather than through
// `claws-issues.ts`, so no dashboard event is emitted for a row no page lists.

/** A shadow with its labels, repos and the forge issue it stands for. */
export interface ShadowIssueRecord extends ClawsIssueRecord {
  forgeNumber: IssueRef;
}

/**
 * Every shadow whose linkage row names `repo`, least-recently-checked first.
 *
 * The ordering is the sync job's: it confirms the state of shadows missing
 * from the forge listing under a per-run read cap, and taking the least
 * recently *checked* first is what stops a capped run from re-checking the
 * same few shadows forever. It orders on `shadow_checked_at` and not on
 * `updated_at` because a check that finds nothing changed writes no issue
 * columns at all — order on `updated_at` and a shadow whose state check never
 * changes anything (the forge read errors, say) would sit at the head of the
 * queue on every run and the rows behind it would never be reached.
 * `COALESCE` to `updated_at` for a shadow no run has checked yet, so a
 * just-minted one sorts as just-checked rather than as the most overdue row.
 *
 * The forge number comes from the joined linkage row rather than from a second
 * query keyed by `repo`: that query read the repo's entire import history to
 * decorate a handful of shadows, and the map it built needed a fallback for a
 * miss it could only paper over with a wrong forge number. The join is on
 * `imported_issues`' leading primary key column, so this still reads one
 * repository's linkage rows rather than walking every shadow on the fleet —
 * and the `IN` form of the same predicate is kept for
 * {@link loadIssueSidecars}, whose scope subquery selects from `claws_issues`
 * alone.
 */
export async function listShadowIssues(repo: string): Promise<ShadowIssueRecord[]> {
  const tail = `WHERE kind = 'shadow' AND id IN (SELECT native_id FROM imported_issues WHERE repo = ?)`;
  const params = [repo];
  const rows = await getDb().all(
    `SELECT c.*, i.forge_number FROM claws_issues c
       JOIN imported_issues i ON i.native_id = c.id AND i.repo = ?
      WHERE c.kind = 'shadow'
      ORDER BY COALESCE(c.shadow_checked_at, c.updated_at) ASC, c.id ASC`,
    params,
  ) as (ClawsIssueRow & { forge_number: unknown })[];
  if (rows.length === 0) return [];
  const sidecars = await loadIssueSidecars(tail, params);
  const records = toClawsRecords(rows.map(({ forge_number: _forgeNumber, ...issue }) => issue), sidecars);
  return records.map((record, i) => ({ ...record, forgeNumber: refFromColumn(rows[i]!.forge_number) }));
}

/**
 * Record that the sync job has examined `ids`, without touching `updated_at`.
 *
 * Called for every shadow a run looks at, whether the look changed anything,
 * found nothing to change, or failed — it is {@link listShadowIssues}'
 * fairness marker, and a check that is not recorded is a check that repeats
 * forever under the run's read cap. Rows that are not shadows are ignored
 * rather than reported: a shadow the importer promoted mid-run is no longer
 * this job's to track.
 */
export async function markShadowsChecked(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await getDb().run(
    `UPDATE claws_issues SET shadow_checked_at = ? WHERE kind = 'shadow' AND id IN (${placeholders})`,
    [nowSql(), ...ids],
  );
}

/**
 * Create the shadow of `repo#forgeNumber`, or resolve the shadow that beat
 * this call to the linkage row. Undefined when that row names an *imported*
 * issue, which can never become a shadow.
 *
 * `issue-shadow-sync` calls this unconditionally for a forge issue with no
 * shadow of its own. `issue-importer` calls it too: for a forge issue with no
 * shadow yet, this *is* the importer's atomic create — the linkage row and the
 * `claws_issues` row commit in the same transaction the sync job uses, so it
 * is the linkage row's primary key, not the order the two jobs happen to run
 * in, that keeps them from ever producing a native issue nothing links to.
 *
 * The linkage row is written *first* inside the transaction, so its primary
 * key is what arbitrates a race between the two callers: when the forge issue
 * has been linked in the meantime the `INSERT OR IGNORE` changes nothing, the
 * transaction returns without inserting an issue row, and the id already
 * linked is resolved instead. Writing the issue row first and the linkage last
 * would leave an orphan `claws_issues` row behind that no reader ever lists
 * and no operator ever sees.
 *
 * But `(repo, forge_number)` is shared by imports and shadows and only `kind`
 * tells them apart, so "already linked" is not only the race — it is also the
 * permanent state of every issue this repo has ever imported. A forge issue a
 * human reopens after its import is back in the forge's open listing with a
 * linkage row naming a `kind = 'issue'` row, and handing that id back as
 * though it were a shadow would have the caller write to a row every
 * `updateShadowIssue` refuses, re-attempting the same pair every cycle with no
 * error and nothing logged. Hence `undefined` rather than an id: an
 * already-imported forge issue is something the caller has to decide about,
 * not something this can paper over. `created` distinguishes the two id cases
 * for the same reason — the shared key erases a distinction the caller needs.
 */
export async function createShadowIssue(
  repo: string,
  forgeNumber: IssueRef,
  input: { title: string; body?: string; authorLogin: string; labels?: readonly string[] },
): Promise<{ id: string; created: boolean } | undefined> {
  const now = nowSql();
  const id = newClawsIssueId();
  const { lifecycle, rest } = splitStateLabels(input.labels ?? []);
  const created = await getDb().transaction(async (tx) => {
    const link = await tx.run(
      `INSERT OR IGNORE INTO imported_issues (repo, forge_number, native_id) VALUES (?, ?, ?)`,
      [repo, refParam(forgeNumber), refParam(id)],
    );
    if (link.changes === 0) return false;
    await tx.run(
      `INSERT INTO claws_issues (id, title, body, author_login, state, state_reason, created_at, updated_at, closed_at, kind, lifecycle, source, requirements_stage)
       VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, NULL, 'shadow', ?, 'forge', 1)`,
      [id, input.title, input.body ?? "", input.authorLogin, now, now, lifecycle],
    );
    await tx.run(`INSERT OR IGNORE INTO claws_issue_repos (issue_id, repo) VALUES (?, ?)`, [id, repo]);
    for (const label of rest) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
    }
    return true;
  });
  if (created) return { id, created: true };
  // A linkage row naming an imported issue resolves to nothing rather than to
  // an id the caller would mistake for a shadow.
  const existing = await getDb().get(
    `SELECT i.native_id, c.kind FROM imported_issues i
       LEFT JOIN claws_issues c ON c.id = i.native_id
      WHERE i.repo = ? AND i.forge_number = ?`,
    [repo, refParam(forgeNumber)],
  ) as { native_id: string; kind: string | null } | undefined;
  // The linkage row that beat this transaction was deleted between the two
  // statements — nothing does that, and returning `id` would hand the caller
  // an id whose `claws_issues` row was never written, so every later
  // `updateShadowIssue` on it would return "not a shadow" forever and the sync
  // job would re-attempt it every cycle without ever noticing.
  if (!existing) throw new Error(`claws-issues: linkage row for ${repo}#${refParam(forgeNumber)} vanished while creating its shadow`);
  if (existing.kind !== "shadow") return undefined;
  return { id: String(existing.native_id), created: false };
}

/**
 * Every open shadow's id and lifecycle, keyed `repo \u0000 forge number` — the
 * board's one read for which forge cards sit in Planning rather than Ideas,
 * neither of which a forge label records, and for the tracker id their
 * requirements versions are keyed by. `hasPlannedPrs` says whether the shadow
 * has a stored PR list (`claws_issue_prs`), one of the board's cheap hints
 * that the forge issue has a plan. `approvedThrough` is the forge issue's
 * stored approval (`issue-approval.ts`), which its card's column and approval
 * track read.
 */
export async function listOpenShadowStages(): Promise<Map<string, { id: string; lifecycle: IssueLifecycle; approvedThrough: ApprovedThrough; hasPlannedPrs: boolean }>> {
  const rows = await getDb().all(
    `SELECT i.repo, i.forge_number, c.id, c.lifecycle, c.approved_through,
            EXISTS (SELECT 1 FROM claws_issue_prs p WHERE p.issue_id = c.id) AS has_prs
       FROM imported_issues i
       JOIN claws_issues c ON c.id = i.native_id
      WHERE c.kind = 'shadow' AND c.state = 'open'`,
  ) as Array<{ repo: string; forge_number: unknown; id: string; lifecycle: IssueLifecycle; approved_through: unknown; has_prs: unknown }>;
  return new Map(rows.map((r) => [`${r.repo}\u0000${String(refFromColumn(r.forge_number))}`, {
    id: String(r.id),
    lifecycle: r.lifecycle,
    approvedThrough: isApprovedThrough(r.approved_through) ? r.approved_through : "none",
    hasPlannedPrs: !!Number(r.has_prs),
  }]));
}

/**
 * Bring a shadow's title, body, labels and state in line with its forge issue.
 *
 * `"unchanged"` when the row already says exactly this: an alert-bridge issue
 * rewrites its body on every occurrence, so the sync job reaches this with an
 * unchanged issue most cycles, and an unconditional UPDATE would bump
 * `updated_at` fleet-wide every five minutes.
 *
 * `"not-a-shadow"` is a separate answer and not a second meaning for
 * `"unchanged"`, because the caller has to do the opposite thing with each:
 * an unchanged shadow stays in the sync job's working set and is checked again
 * next cycle, while a promoted one must be dropped from it immediately — the
 * promotion takes it out of {@link listShadowIssues}, but only on the *next*
 * listing, after this run has already tried to write it.
 *
 * `WHERE kind = 'shadow'` on the write, not just on the read, is what makes
 * this commute with `promoteShadowIssue`: a shadow the importer promoted
 * between the two changes zero rows rather than having the forge issue's text
 * written back over the imported one.
 *
 * `closed_at` is set on the close that first reports it and cleared on reopen;
 * an already-closed shadow whose body changed keeps its original close time.
 */
export async function updateShadowIssue(
  id: string,
  next: {
    title: string;
    body: string;
    labels: readonly string[];
    state: "open" | "closed";
    stateReason?: "completed" | "not_planned" | null;
  },
): Promise<"changed" | "unchanged" | "not-a-shadow"> {
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(
      `SELECT title, body, state, state_reason, closed_at, lifecycle, stage_changed_at, requirements_approved_at FROM claws_issues WHERE id = ? AND kind = 'shadow'`,
      [id],
    ) as { title: string; body: string; state: string; state_reason: string | null; closed_at: string | null; lifecycle: string; stage_changed_at: string | null; requirements_approved_at: string | null } | undefined;
    if (!row) return "not-a-shadow";

    // Compared as sets, not as two sorted lists: `ORDER BY label` is binary in
    // SQLite and collation-dependent in Postgres, so a positional comparison
    // would report a spurious difference on one dialect and not the other.
    const currentLabels = new Set(
      (await tx.all(`SELECT label FROM claws_issue_labels WHERE issue_id = ?`, [id]) as { label: string }[]).map((l) => l.label),
    );
    // The forge's state labels are the `lifecycle` column here, not rows, so
    // they are compared against it rather than against the label rows — or
    // every shadow of a `Blocked` issue would read as changed on every sync.
    const split = splitStateLabels(next.labels);
    const rest = split.rest;
    const lifecycle = resolveStage(split.lifecycle, { lifecycle: row.lifecycle as IssueLifecycle, requirementsApprovedAt: row.requirements_approved_at });
    const wantedLabels = new Set(rest);
    const labelsDiffer = currentLabels.size !== wantedLabels.size || [...wantedLabels].some((l) => !currentLabels.has(l));

    const reason = next.state === "closed" ? (next.stateReason ?? null) : null;
    const same = !labelsDiffer
      && row.lifecycle === lifecycle
      && row.title === next.title
      && row.body === next.body
      && row.state === next.state
      && (row.state_reason ?? null) === reason;
    if (same) return "unchanged";

    const now = nowSql();
    const closedAt = next.state === "closed" ? (row.closed_at ?? now) : null;
    await tx.run(
      `UPDATE claws_issues SET title = ?, body = ?, state = ?, state_reason = ?, closed_at = ?, lifecycle = ?, updated_at = ?, stage_changed_at = ?
        WHERE id = ? AND kind = 'shadow'`,
      [next.title, next.body, next.state, reason, closedAt, lifecycle, now, row.lifecycle !== lifecycle ? now : row.stage_changed_at, id],
    );
    if (labelsDiffer) {
      await tx.run(`DELETE FROM claws_issue_labels WHERE issue_id = ?`, [id]);
      for (const label of wantedLabels) {
        await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
      }
    }
    return "changed";
  });
}

/**
 * Promote a shadow into the live native issue `issue-importer` would otherwise
 * have created, in place.
 *
 * The id is kept, which is the whole point: anything already hanging off it —
 * the linkage row, the work-queue rows, a `Closes #clw_…` in a PR body —
 * carries over rather than being stranded on a row the importer abandons.
 *
 * The whole promotion — the columns, the labels and the `kind` flip — commits
 * as one transaction, so no reader ever sees a half-promoted row: the issue
 * becomes visible to the dispatchers already flagged `import_pending` when the
 * caller passes `opts.importPending`, so every dispatcher holds it until
 * {@link finishClawsIssueImport} clears the flag. It is
 * the atomicity that guarantees that and not the order of the statements, so
 * `kind` is set by the same UPDATE as the rest rather than by a later one.
 *
 * Every column `createClawsIssue` would have set is set here too, and for the
 * same reason: a promoted issue must be indistinguishable from a created one,
 * or the same forge issue imports differently depending on whether a shadow
 * happened to exist. Leaving the shadow's own values in place would mean an
 * `issue-refiner` plan re-stamped against `title` going stale the moment the
 * forge title was edited inside the sync job's window, a shadow the sync
 * closed being promoted closed and so invisible to `listOpenClawsIssues`, and
 * the dispatchers' `isAllowedActor` check seeing the forge author where the
 * create path writes `claws`.
 *
 * Returns false when `id` is not a shadow, so a second import of the same
 * forge issue cannot overwrite the issue the first one produced.
 *
 * The lifecycle is resolved through {@link resolveStage}, the same mapping
 * `updateShadowIssue` uses: the forge has no label for Planning, so an issue
 * already past Ideas (an auto-promoted first version, or a plan with no
 * approval yet) must not be imported straight back into it, with the
 * approval this call leaves untouched now pointing nowhere.
 */
export async function promoteShadowIssue(
  id: string,
  next: { title: string; body: string; labels: readonly string[] },
  opts?: { source?: IssueSource; autoPromote?: boolean; importPending?: boolean },
): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(
      `SELECT lifecycle, requirements_approved_at FROM claws_issues WHERE id = ? AND kind = 'shadow'`,
      [id],
    ) as { lifecycle: string; requirements_approved_at: string | null } | undefined;
    if (!row) return false;
    // State labels become the `lifecycle` column, never rows, and the
    // retired gate labels become nothing: approval is `approved_through`.
    const split = splitStateLabels(next.labels);
    const lifecycle = resolveStage(split.lifecycle, { lifecycle: row.lifecycle as IssueLifecycle, requirementsApprovedAt: row.requirements_approved_at });
    const rest = split.rest;
    const now = nowSql();
    // `'claws'` is `clawsIssues.CLAWS_NATIVE_LOGIN`, spelled out because
    // `claws-issues.ts` sits above this module and cannot be imported here.
    // `auto_promote` keeps the shadow's existing value when `opts.autoPromote`
    // is not given, so a demotion's "wait for a human" survives the import.
    await tx.run(
      `UPDATE claws_issues
          SET title = ?, body = ?, author_login = 'claws', state = 'open', state_reason = NULL, closed_at = NULL,
              updated_at = ?, kind = 'issue', shadow_checked_at = NULL, lifecycle = ?, stage_changed_at = ?,
              source = ?, auto_promote = COALESCE(?, auto_promote), import_pending = ?
        WHERE id = ? AND kind = 'shadow'`,
      [next.title, next.body, now, lifecycle, now, opts?.source ?? "forge", autoPromoteParam(opts?.autoPromote), opts?.importPending ? 1 : 0, id],
    );
    await tx.run(`DELETE FROM claws_issue_labels WHERE issue_id = ?`, [id]);
    for (const label of rest) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
    }
    return true;
  });
}

/**
 * Clear the `import_pending` flag {@link promoteShadowIssue} set, once
 * `issue-importer` has finished the import (or abandoned an interrupted one).
 * Returns true when the flag was set, so the caller can tell a finished import
 * from a no-op.
 */
export async function finishClawsIssueImport(id: string): Promise<boolean> {
  const res = await getDb().run(`UPDATE claws_issues SET import_pending = 0 WHERE id = ? AND import_pending <> 0`, [id]);
  return res.changes > 0;
}

