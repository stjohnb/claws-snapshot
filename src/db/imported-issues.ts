// `imported_issues`: the forge issues Claws imported into its native
// tracker. Reached only through the src/db.ts façade.
import { refFromColumn, type IssueRef } from "../issue-id.js";
import { getDb, refParam } from "./core.js";

export interface ImportedIssue {
  repo: string;
  /** The forge issue number the import closed. */
  forgeNumber: IssueRef;
  /** The `clw_…` id it became. */
  nativeId: string;
}

/**
 * Record that `repo#forgeNumber` was imported into the native tracker as
 * `nativeId` (#3245).
 *
 * `INSERT OR IGNORE` on `(repo, forge_number)`: this is `issue-importer`'s
 * idempotency key, so a re-run that reaches the write again must not replace
 * the row that already names the native issue it created.
 *
 * Returns whether the stored row names `nativeId` — true both when this call
 * inserted it and when a previous one already recorded the same id. False
 * means the key was taken by a *different* native issue, which the caller must
 * treat as a failure rather than as idempotency: it has just built an issue
 * nothing links to. A write whose whole job is idempotency must not be able to
 * disagree with its caller in silence (#3246).
 */
export async function recordImportedIssue(repo: string, forgeNumber: IssueRef, nativeId: string): Promise<boolean> {
  const id = refParam(nativeId);
  const res = await getDb().run(
    `INSERT OR IGNORE INTO imported_issues (repo, forge_number, native_id) VALUES (?, ?, ?)`,
    [repo, refParam(forgeNumber), id],
  );
  if (res.changes > 0) return true;
  const row = await getDb().get(
    `SELECT native_id FROM imported_issues WHERE repo = ? AND forge_number = ?`,
    [repo, refParam(forgeNumber)],
  ) as { native_id: string } | undefined;
  return row !== undefined && String(row.native_id) === id;
}

/**
 * Every recorded import, for the in-process index in `imported-refs.ts`.
 *
 * `forge_number` is TEXT, so Postgres hands `7` back as `"7"` — normalised
 * here, or every `sameIssueRef` comparison against a forge number would
 * silently stop matching on Postgres while still passing on SQLite.
 *
 * Shadows have a linkage row too, and they are excluded here (#3246): the
 * index is an *alias* index, and a live forge issue is not an alias of its
 * shadow. Leave them in and every forge ref on the fleet would resolve to a
 * hidden native id, doubling `listMergedPRsForIssue` and
 * `listDuplicateIssuesOf`'s API calls and pointing the watcher's writes at a
 * row nothing reads. The join is an INNER one on purpose: a linkage row whose
 * native issue has been deleted names nothing to alias to either.
 */
export async function listImportedIssues(): Promise<ImportedIssue[]> {
  const rows = await getDb().all(`
    SELECT i.repo, i.forge_number, i.native_id
      FROM imported_issues i
      JOIN claws_issues c ON c.id = i.native_id
     WHERE c.kind <> 'shadow'
  `) as { repo: string; forge_number: unknown; native_id: string }[];
  return rows.map((r) => ({ repo: r.repo, forgeNumber: refFromColumn(r.forge_number), nativeId: String(r.native_id) }));
}

/**
 * The forge `updatedAt` `issue-shadow-sync` last processed for
 * `repo#forgeNumber`, or null when it has not yet — or there is no row.
 */
export async function getImportedForgeSyncedAt(repo: string, forgeNumber: IssueRef): Promise<string | null> {
  const row = await getDb().get(
    `SELECT forge_synced_at FROM imported_issues WHERE repo = ? AND forge_number = ?`,
    [repo, refParam(forgeNumber)],
  ) as { forge_synced_at: string | null } | undefined;
  return row?.forge_synced_at ?? null;
}

/** Record the forge `updatedAt` just processed for `repo#forgeNumber`. A missing row is left missing. */
export async function setImportedForgeSyncedAt(repo: string, forgeNumber: IssueRef, updatedAt: string): Promise<void> {
  await getDb().run(
    `UPDATE imported_issues SET forge_synced_at = ? WHERE repo = ? AND forge_number = ?`,
    [updatedAt, repo, refParam(forgeNumber)],
  );
}

/**
 * The forge issue `nativeId` is linked to, imported or shadowed, or undefined.
 *
 * The reverse of the `imported_issues` lookup, and unlike
 * {@link listImportedIssues} it answers for a shadow. `/issues/:id` uses it
 * to redirect a shadow to the forge issue it stands for.
 *
 * The table's primary key is `(repo, forge_number)` and the only index on
 * `native_id` is non-unique, so nothing structural stops two linkage rows
 * naming the same native issue. `ORDER BY` makes the answer deterministic
 * anyway — without it the planner returns whichever row it reached first,
 * which can differ between SQLite and Postgres and between runs, and a
 * redirect would send the same shadow to a different forge issue each time.
 * A unique index would be the stronger fix, but it is not one that can be
 * added here: `CREATE UNIQUE INDEX` on a database that already holds a
 * duplicate fails, and it would fail at boot.
 */
export async function getImportedIssueByNative(nativeId: string): Promise<{ repo: string; forgeNumber: IssueRef } | undefined> {
  const row = await getDb().get(
    `SELECT repo, forge_number FROM imported_issues WHERE native_id = ? ORDER BY repo ASC, forge_number ASC LIMIT 1`,
    [refParam(nativeId)],
  ) as { repo: string; forge_number: unknown } | undefined;
  return row ? { repo: row.repo, forgeNumber: refFromColumn(row.forge_number) } : undefined;
}
/**
 * Point `repo#forgeNumber`'s linkage row at `nativeId`, inserting it when
 * missing. A shadow the row previously named is deleted (its sidecar rows
 * cascade), since the forge issue it stood for now belongs to `nativeId`.
 */
export async function relinkImportedIssue(repo: string, forgeNumber: IssueRef, nativeId: string): Promise<void> {
  const id = refParam(nativeId);
  await getDb().transaction(async (tx) => {
    const previous = await tx.get(
      `SELECT native_id FROM imported_issues WHERE repo = ? AND forge_number = ?`,
      [repo, refParam(forgeNumber)],
    ) as { native_id: string } | undefined;
    if (!previous) {
      await tx.run(`INSERT INTO imported_issues (repo, forge_number, native_id) VALUES (?, ?, ?)`, [repo, refParam(forgeNumber), id]);
      return;
    }
    const previousId = String(previous.native_id);
    if (previousId === id) return;
    await tx.run(`UPDATE imported_issues SET native_id = ? WHERE repo = ? AND forge_number = ?`, [id, repo, refParam(forgeNumber)]);
    await tx.run(`DELETE FROM claws_issues WHERE id = ? AND kind = 'shadow'`, [previousId]);
  });
}
