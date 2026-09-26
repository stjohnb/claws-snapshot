/**
 * The single source of truth for how a PR names the issue it closes: the
 * `claws/issue-<ref>-...` branch convention, and the `Closes/Fixes/Resolves/
 * Part of #<ref>` body convention.
 *
 * A leaf module by design — it imports only `./issue-id.js` — so both
 * `github.ts` and `forgejo.ts` can depend on it without a cycle. `github.ts`
 * imports `forgejo.ts` at runtime (routing GitHub-shaped calls to the
 * Forgejo backend for a Forgejo repo), so `forgejo.ts` importing `github.ts`
 * back would be a real cycle between the two largest modules in the repo.
 */

import { ISSUE_REF_PATTERN, ISSUE_REF_GUARDED, canonicalIssueRef, type IssueRef } from "./issue-id.js";

const LINKED_BRANCH_RE = new RegExp(`^claws/issue-(${ISSUE_REF_PATTERN})-`);
const LINKED_BODY_RE = new RegExp(`(?:closes?|fixes?|resolves?|part of)\\s*#(${ISSUE_REF_GUARDED})`, "i");

/** The subset of a PR this convention actually reads. */
export interface LinkedPR {
  headRefName: string;
  body?: string | null;
}

/**
 * The issue a PR links, by branch name first (`claws/issue-<ref>-...`), then
 * by body keyword (`Closes/Fixes/Resolves/Part of #<ref>`). Null when neither
 * convention matches.
 */
export function linkedIssueRefFromPR(pr: LinkedPR): IssueRef | null {
  const branchMatch = pr.headRefName.match(LINKED_BRANCH_RE);
  if (branchMatch) return canonicalIssueRef(branchMatch[1]!);

  if (pr.body) {
    const bodyMatch = pr.body.match(LINKED_BODY_RE);
    if (bodyMatch) return canonicalIssueRef(bodyMatch[1]!);
  }

  return null;
}
