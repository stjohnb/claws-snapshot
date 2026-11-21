/**
 * Keep an imported forge issue's old number resolving (#3245).
 *
 * The `issue-importer` moves a forge issue into the native tracker and the
 * ref changes — but plenty of durable records are keyed to the *old* one: a
 * `claws-duplicate-of:<N>` marker on another issue, a `docs/upstream-watches`
 * manifest's `issue: <N>`, a `skippedItems` entry, a merged PR on a
 * `claws/issue-<N>-` branch, a PR body saying `Part of #<N>`. Rewriting each
 * of those in the importer was one bespoke case per record kind and a
 * permanent refusal wherever a rewrite was impossible; this module is the
 * general answer instead — the old ref still resolves, so nothing needs
 * rewriting.
 *
 * This module still imports `db.js`, so `config.ts` cannot import it without
 * a cycle (`config.ts` → `imported-refs.ts` → `db.ts` → `config.ts`); the
 * synchronous in-process index itself is the leaf `imported-refs-index.ts`,
 * which this module loads and records into and re-exports the accessors
 * from, so no existing import path changes.
 */

import * as db from "./db.js";
import type { IssueRef } from "./issue-id.js";
import { clearImportedRefs, setImportedRef } from "./imported-refs-index.js";

export { resolveImportedRef, issueRefAliases, resetImportedRefsForTest } from "./imported-refs-index.js";

/** Load (or reload) the index from `imported_issues`. Called after `initDb()`. */
export async function loadImportedRefs(): Promise<void> {
  const rows = await db.listImportedIssues();
  clearImportedRefs();
  for (const row of rows) {
    setImportedRef(row.repo, row.forgeNumber, row.nativeId);
  }
}

/**
 * Record an import durably and in the index, so the old ref resolves
 * immediately.
 *
 * Returns false when the linkage row for `repo#forgeNumber` already names a
 * *different* native issue — the durable row wins, so the index is left
 * alone rather than aliasing the forge ref to an id the database does not
 * agree with until the next restart (#3246). The caller has built a native
 * issue nothing links to and must fail loudly.
 */
export async function recordImport(repo: string, forgeNumber: IssueRef, nativeId: string): Promise<boolean> {
  if (!await db.recordImportedIssue(repo, forgeNumber, nativeId)) return false;
  setImportedRef(repo, forgeNumber, nativeId);
  return true;
}
