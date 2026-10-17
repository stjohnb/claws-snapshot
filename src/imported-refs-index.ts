/**
 * The in-process index behind {@link resolveImportedRef} (#3245, split out for
 * `issue-clw_01M35GAV079FW4VJ1GN5J19ABM`).
 *
 * A leaf module: it imports `issue-id.js` only, so `config.ts` can consult it
 * without a cycle — `imported-refs.ts` imports `db.ts`, which imports
 * `config.ts`. `imported-refs.ts` remains the db-backed module that loads and
 * records into this index; it re-exports the accessors below so no existing
 * import path changes.
 *
 * Lookups are synchronous against an in-process index loaded once by
 * `loadImportedRefs()` in `imported-refs.ts`. Claws runs a single pod (see
 * docs/issue-tracker.md) and the table is tiny, and the callers —
 * `gh.isItemSkipped`, `isItemPrioritized`, `getItemTimeoutMs`, `issueUrl` —
 * are sync with many callers apiece, so making them async would ripple across
 * the dispatcher for no benefit.
 *
 * An index that has not been loaded resolves nothing, which is exactly the
 * pre-import behaviour: a boot-order slip degrades to "no imports are known"
 * rather than mis-resolving a ref to the wrong issue.
 */

import { canonicalIssueRef, type IssueRef } from "./issue-id.js";

/** Forge ref → native id, keyed `(repo, canonical ref)`. */
const forgeToNative = new Map<string, string>();
/** Native id → the forge ref it was imported from, keyed `(repo, canonical ref)`. */
const nativeToForge = new Map<string, IssueRef>();

/** `\0` separator: it cannot occur in a repo slug or in a canonical ref. */
function key(repo: string, ref: IssueRef): string {
  return `${repo}\u0000${canonicalIssueRef(ref) ?? ref}`;
}

/** Empty both maps. Called by `loadImportedRefs` before repopulating them. */
export function clearImportedRefs(): void {
  forgeToNative.clear();
  nativeToForge.clear();
}

/**
 * Index one imported pair into both maps. Called by `loadImportedRefs` and
 * `recordImport` in `imported-refs.ts`, which own the durable write this
 * mirrors.
 */
export function setImportedRef(repo: string, forgeNumber: IssueRef, nativeId: string): void {
  const native = canonicalIssueRef(nativeId);
  if (native === null) return;
  forgeToNative.set(key(repo, forgeNumber), String(native));
  nativeToForge.set(key(repo, native), canonicalIssueRef(forgeNumber) ?? forgeNumber);
}

/**
 * The native id `repo#ref` became, or `ref` canonicalised when it was never
 * imported.
 *
 * Use this where a *single* ref has to be acted on — the watcher's label and
 * comment writes. Where a record could name either spelling, fan out over
 * {@link issueRefAliases} instead.
 */
export function resolveImportedRef(repo: string, ref: IssueRef): IssueRef {
  const canonical = canonicalIssueRef(ref) ?? ref;
  return forgeToNative.get(key(repo, canonical)) ?? canonical;
}

/**
 * Every spelling of `repo#ref`: the canonical ref first, then the other side of
 * the imported pair when there is one. One or two entries, never more.
 *
 * Callers that fan out over it must preserve the order — the canonical ref is
 * the one whose result wins when both sides answer.
 */
export function issueRefAliases(repo: string, ref: IssueRef): IssueRef[] {
  const canonical = canonicalIssueRef(ref) ?? ref;
  const k = key(repo, canonical);
  const other = forgeToNative.get(k) ?? nativeToForge.get(k);
  return other === undefined ? [canonical] : [canonical, other];
}

/** Test-only: empty the index. */
export function resetImportedRefsForTest(): void {
  clearImportedRefs();
}
