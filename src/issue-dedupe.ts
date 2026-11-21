/**
 * Duplicate detection for `claws_create_issue` (`POST /api/issues`): is the
 * issue a caller is about to file already open? (docs/issue-tracker.md
 * "Dedupe on create".) Pure — the route loads the open issues and decides what
 * to do with a match; nothing else re-implements the comparison.
 *
 * A candidate is a **strong** match when either
 *
 * - its title overlap coefficient is at least {@link STRONG_TITLE_SIMILARITY}
 *   (0.8), or
 * - its title overlap coefficient is at least {@link KEYED_TITLE_SIMILARITY}
 *   (0.5) *and* the two issues share at least one key term across title and
 *   body — a Secret name, file path, package name, env var or backticked span.
 *
 * The overlap coefficient is shared title tokens over the smaller token set,
 * so a long title that adds a second clause ("… and lift the per-run PR cap")
 * does not dilute a match. Compound tokens (`renovate-github-com`,
 * `GITHUB_COM_TOKEN`, `github.com`) are kept whole rather than split into
 * words, which is what stops "Add a Grafana alert when the
 * renovate-github-com Secret token expires" matching "create the
 * renovate-github-com Secret": the shared Secret name is one token, not three.
 * Two compounds match when one is a whole-segment run of the other
 * (`github.com` inside `renovate-github-com`).
 */

import type * as db from "./db.js";
import { compareIssueRefs } from "./issue-id.js";

/** Title overlap at or above which a candidate is a strong match on its own. */
export const STRONG_TITLE_SIMILARITY = 0.8;
/** Title overlap at or above which a shared key term makes a strong match. */
export const KEYED_TITLE_SIMILARITY = 0.5;
/** How many candidates {@link findDuplicateCandidates} returns at most. */
export const MAX_CANDIDATES = 5;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "these", "those", "from", "into", "onto",
  "when", "then", "than", "can", "are", "its", "not", "via", "should", "must", "will",
  "was", "were", "has", "have", "but", "all", "any", "our", "out", "who", "what", "which",
  "where", "why", "how", "does", "doesn't", "don't", "isn't", "also", "only", "just",
]);

const COMPOUND = /[a-z0-9][-_/.][a-z0-9]/i;
const SEPARATORS = /[-_/.]+/g;
const NOT_KEY_TERMS = new Set(["e.g", "i.e", "n/a", "and/or"]);

/** Strip leading and trailing punctuation, keeping inner `-_/.`. */
function trimPunctuation(word: string): string {
  return word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
}

/**
 * Lowercased content tokens: split on whitespace, surrounding punctuation
 * stripped, stopwords, pure numbers and tokens under 3 characters dropped —
 * unless the token is a compound (`a-b`, `x_y`, `p/q`, `s.t`), which is kept
 * whole whatever its length.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const word = trimPunctuation(raw).toLowerCase();
    if (!word || /^[0-9]+$/.test(word) || STOPWORDS.has(word)) continue;
    if (word.length < 3 && !COMPOUND.test(word)) continue;
    out.push(word);
  }
  return out;
}

/**
 * Identifier-like terms worth matching on across title and body, lowercased:
 * compounds with `-`, `_`, `/` or `.` between alphanumerics
 * (`renovate-github-com`, `src/foo.ts`), ALL-CAPS identifiers of 3+
 * characters (`GITHUB_COM_TOKEN`, `PAT`) and backticked spans. Pure numbers,
 * `#N` refs, `clw_`/`clwc_` ids and URLs are excluded: they name issues and
 * pages, not the artefact the work changes.
 */
export function keyTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const add = (term: string): void => {
    const t = term.trim().toLowerCase();
    if (!t || /^#?[0-9.]+$/.test(t) || !/[a-z]/.test(t)) return;
    if (/^clwc?_/.test(t) || /^[a-z]+:\/\//.test(t) || NOT_KEY_TERMS.has(t)) return;
    terms.add(t);
  };
  for (const match of text.matchAll(/`([^`\n]+)`/g)) add(match[1]!);
  for (const raw of text.replace(/`[^`\n]*`/g, " ").split(/\s+/)) {
    if (raw.startsWith("#") || /^[a-z]+:\/\//i.test(raw)) continue;
    const word = trimPunctuation(raw);
    if (!word) continue;
    if (COMPOUND.test(word) || (/^[A-Z][A-Z0-9]{2,}$/.test(word) && /[_0-9]/.test(word))) add(word);
  }
  return terms;
}

/** True when `a` and `b` are the same token, or one compound is a whole-segment run of the other. */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (!COMPOUND.test(a) || !COMPOUND.test(b)) return false;
  const na = `-${a.replace(SEPARATORS, "-")}-`;
  const nb = `-${b.replace(SEPARATORS, "-")}-`;
  return na.includes(nb) || nb.includes(na);
}

/** How many of `smaller` match some token in `larger`. */
function matchedCount(smaller: readonly string[], larger: readonly string[]): number {
  return smaller.filter((s) => larger.some((l) => tokensMatch(s, l))).length;
}

/**
 * Title overlap coefficient: the share of the smaller title's distinct tokens
 * that match a token of the other title. 0 when either has no tokens.
 */
export function titleSimilarity(a: string, b: string): number {
  return titleEvidence(a, b).similarity;
}

/** The overlap coefficient plus the evidence behind it: the smaller set's size and its matched count. */
function titleEvidence(a: string, b: string): { similarity: number; size: number; matched: number } {
  const ta = [...new Set(tokenize(a))];
  const tb = [...new Set(tokenize(b))];
  if (ta.length === 0 || tb.length === 0) return { similarity: 0, size: 0, matched: 0 };
  const [smaller, larger] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const matched = matchedCount(smaller, larger);
  return { similarity: matched / smaller.length, size: smaller.length, matched };
}

/** Key terms of `a` that match one of `b`'s, sorted. */
function sharedKeyTerms(a: Set<string>, b: Set<string>): string[] {
  const bList = [...b];
  return [...a].filter((t) => bList.some((u) => tokensMatch(t, u))).sort();
}

export interface DuplicateCandidate {
  record: db.ClawsIssueRecord;
  /** Best title overlap against the record's `title` or `filed_title`. */
  similarity: number;
  /** Key terms the new issue shares with the record's title and body. */
  sharedKeyTerms: string[];
  /** Whether this meets the strong-match rule in the module header. */
  strong: boolean;
}

/**
 * Rank `open` against the issue about to be filed: candidates whose title
 * overlap reaches {@link KEYED_TITLE_SIMILARITY}, strong matches first, then by
 * similarity, then oldest id first; at most {@link MAX_CANDIDATES}. Only
 * records sharing a repo with `input.repos` are considered, and each is
 * compared against both its current title and the title it was filed under,
 * since promotion renames unattended issues.
 */
export function findDuplicateCandidates(
  input: { title: string; body: string; repos: readonly string[] },
  open: readonly db.ClawsIssueRecord[],
): DuplicateCandidate[] {
  const repos = new Set(input.repos);
  const inputTerms = keyTerms(`${input.title}\n${input.body}`);
  const out: DuplicateCandidate[] = [];
  for (const record of open) {
    if (!record.repos.some((r) => repos.has(r))) continue;
    const titles = record.filed_title ? [record.title, record.filed_title] : [record.title];
    const evidence = titles.map((t) => titleEvidence(input.title, t));
    const similarity = Math.max(...evidence.map((e) => e.similarity));
    if (similarity < KEYED_TITLE_SIMILARITY) continue;
    // Strong on title alone needs real evidence: 3+ tokens in the smaller title, all 3+ matched.
    const titleStrong = evidence.some((e) => e.similarity >= STRONG_TITLE_SIMILARITY && e.size >= 3 && e.matched >= 3);
    const shared = sharedKeyTerms(inputTerms, keyTerms(`${titles.join("\n")}\n${record.body}`));
    const strong = titleStrong || shared.length > 0;
    out.push({ record, similarity, sharedKeyTerms: shared, strong });
  }
  out.sort((a, b) =>
    Number(b.strong) - Number(a.strong)
    || b.similarity - a.similarity
    || compareIssueRefs(a.record.id, b.record.id));
  return out.slice(0, MAX_CANDIDATES);
}
