/**
 * What every native-issue create path that dedupes by key shares: the key's
 * shape and one serial queue, so a dedupe check and the write it guards never
 * interleave with another create's (`POST /api/issues` and the issue-filer API).
 */

/** A `claws_create_issue` dedupe key: lowercase, 2–100 chars (docs/issue-tracker.md "Dedupe on create"). */
export const DEDUPE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{1,99}$/;

/**
 * Tail of the in-flight create chain. Creates run one at a time, so two
 * callers filing the same work in the same second cannot both pass the
 * dedupe check before either has written.
 */
let issueCreateTail: Promise<unknown> = Promise.resolve();

export function serialiseIssueCreate<T>(fn: () => Promise<T>): Promise<T> {
  const run = issueCreateTail.then(fn, fn);
  issueCreateTail = run.catch(() => undefined);
  return run;
}
