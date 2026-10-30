/**
 * The head-branch contract for disposable issue previews,
 * `claws/preview-issue-<issue ref>`. A leaf module so `github.ts` can tell a
 * preview PR apart by its branch — it is never dispatched and never counted as
 * the issue's implementation PR — without importing `issue-previews.ts`, which
 * imports `github.ts` (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD).
 */

import { canonicalIssueRef, parseIssueRef, type IssueRef } from "./issue-id.js";

export const PREVIEW_BRANCH_PREFIX = "claws/preview-issue-";

/** The issue a `claws/preview-issue-<ref>` branch belongs to, or null. */
export function issueRefFromPreviewBranch(branch: string): IssueRef | null {
  if (!branch.toLowerCase().startsWith(PREVIEW_BRANCH_PREFIX)) return null;
  return parseIssueRef(branch.slice(PREVIEW_BRANCH_PREFIX.length));
}

/** The branch name a repository's preview step pushes for `ref`. */
export function previewBranchFor(ref: IssueRef): string {
  return `${PREVIEW_BRANCH_PREFIX}${canonicalIssueRef(ref) ?? ref}`;
}
