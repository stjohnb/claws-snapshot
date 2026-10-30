/**
 * Resolves the issue and PR references written in an issue's text to the pages
 * they link to, for {@link renderMarkdown}'s `refs` option on the issue page.
 *
 * Only items Claws already knows are linked — native issues, `claws_prs` rows
 * and imported or shadowed forge issues — so rendering never calls a forge and
 * an id that matches nothing stays plain text.
 */

import * as db from "./db.js";
import * as config from "./config.js";
import { collectIssueRefs, issueRefKey, type IssueRefCandidate, type IssueRefLinks } from "./markdown.js";
import { mapWithConcurrency } from "./util.js";

/** Concurrent store lookups while resolving one page's references. */
const LOOKUP_CONCURRENCY = 8;

async function resolveForgeRef(repo: string, number: number): Promise<string | undefined> {
  if (await db.getClawsPr(repo, number)) return config.prUrl(repo, number);
  const nativeId = await db.getLinkedNativeId(repo, number);
  return nativeId ? `/issues/${nativeId}` : undefined;
}

async function resolveRef(ref: IssueRefCandidate, repos: string[]): Promise<string | undefined> {
  if (ref.kind === "native") {
    return (await db.clawsIssueExists(ref.id)) ? `/issues/${ref.id}` : undefined;
  }
  // A bare `#N` means the issue's own repos, tried in sorted order.
  for (const repo of ref.repo ? [ref.repo] : repos) {
    const href = await resolveForgeRef(repo, ref.number);
    if (href) return href;
  }
  return undefined;
}

/**
 * Build the link resolver for an issue page from every text it renders —
 * body, comments, plan and requirements sections — and the issue's repos.
 */
export async function resolveIssueRefLinks(texts: string[], repos: string[]): Promise<IssueRefLinks> {
  const candidates = new Map<string, IssueRefCandidate>();
  for (const text of texts) {
    for (const ref of collectIssueRefs(text)) candidates.set(issueRefKey(ref), ref);
  }
  const sortedRepos = [...repos].sort();
  const entries = await mapWithConcurrency([...candidates], LOOKUP_CONCURRENCY,
    async ([key, ref]) => [key, await resolveRef(ref, sortedRepos)] as const);
  const hrefs = new Map<string, string>();
  for (const [key, href] of entries) if (href) hrefs.set(key, href);
  return { hrefFor: (ref) => hrefs.get(ref) };
}
