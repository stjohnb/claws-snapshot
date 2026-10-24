import { getMergeBlockReason, type CheckStatus } from "../github.js";
import { parsePRViewKind, type PRViewKind } from "../dependency-prs.js";
import { prAttentionReasons } from "../pr-attention.js";
import { hasManualAction, isMergeApproved } from "../pr-state.js";
import type { AllPRRow } from "./lists.js";
import type { PRRowStatus } from "./pr-status.js";

/**
 * The `/prs` view model: the filters and sort a `/prs?…` address names, the
 * attributes each row derives for them, and the filter-then-sort step. The page
 * (`buildAllPRsPage`) renders it; the `kind` chips (All / Dependencies / Other /
 * Blocked) are part of the query so they compose with the form's filters.
 */

export const PRS_SORTS = ["updated", "created", "repo", "title", "author", "ci"] as const;
export type PrsSort = (typeof PRS_SORTS)[number];
export type PrsDir = "asc" | "desc";

export const PRS_CI = ["passing", "failing", "pending", "held", "none"] as const;
export const PRS_REVIEW = ["clean", "issues", "escalated", "none"] as const;
export const PRS_MERGE = ["conflicts", "blocked", "automerge", "awaiting"] as const;
export type PrsMerge = (typeof PRS_MERGE)[number];

export interface PrsQuery {
  kind: PRViewKind;
  /** `""` means no filter on each of the following. */
  repo: string;
  author: string;
  label: string;
  ci: "" | CheckStatus;
  review: "" | (typeof PRS_REVIEW)[number];
  merge: "" | PrsMerge;
  sort: PrsSort;
  dir: PrsDir;
}

export const DEFAULT_PRS_QUERY: PrsQuery = {
  kind: "all", repo: "", author: "", label: "", ci: "", review: "", merge: "", sort: "updated", dir: "desc",
};

function oneOf<T extends string>(values: readonly T[], raw: string | undefined): "" | T {
  return raw !== undefined && (values as readonly string[]).includes(raw) ? (raw as T) : "";
}

/** Reads a query from request parameters; unknown values fall back to the defaults. */
export function parsePrsQuery(get: (key: string) => string | undefined): PrsQuery {
  const sort = get("sort");
  const dir = get("dir");
  return {
    kind: parsePRViewKind(get("kind")) ?? "all",
    repo: get("repo") ?? "",
    author: get("author") ?? "",
    label: get("label") ?? "",
    ci: oneOf(PRS_CI, get("ci")),
    review: oneOf(PRS_REVIEW, get("review")),
    merge: oneOf(PRS_MERGE, get("merge")),
    sort: (PRS_SORTS as readonly string[]).includes(sort ?? "") ? (sort as PrsSort) : "updated",
    dir: dir === "asc" || dir === "desc" ? dir : "desc",
  };
}

/**
 * The `/prs?…` address for a view: `kind` is always written (so a link never hits
 * the remembered-kind redirect on a bare `/prs`), the rest only when non-default.
 */
export const PRS_FILTER_KEYS = ["repo", "author", "label", "ci", "review", "merge"] as const;
export type PrsFilterKey = (typeof PRS_FILTER_KEYS)[number];

export function prsHref(query: PrsQuery): string {
  const params = new URLSearchParams();
  params.set("kind", query.kind);
  for (const key of PRS_FILTER_KEYS) {
    if (query[key]) params.set(key, query[key]);
  }
  if (query.sort !== "updated") params.set("sort", query.sort);
  if (query.dir !== "desc") params.set("dir", query.dir);
  const qs = params.toString();
  return `/prs${qs ? `?${qs}` : ""}`;
}

/** True when any form filter (not the `kind` chip) is set. */
export function hasPrsFilters(query: PrsQuery): boolean {
  return PRS_FILTER_KEYS.some((key) => query[key]);
}

/** True when the sort is the default (updated, newest first). */
export function isDefaultPrsSort(query: PrsQuery): boolean {
  return query.sort === "updated" && query.dir === "desc";
}

/** An open PR that is clean, green, mergeable and waiting only on the operator's automerge approval. */
export function isAwaitingApproval(row: AllPRRow, st: PRRowStatus | undefined): boolean {
  return !isMergeApproved(row.prRow) && !hasManualAction(row.prRow) && !row.approvalExempt &&
    st?.reviewStatus === "clean" &&
    (st.checkStatus === "passing" || st.checkStatus === "none") &&
    st.mergeableState !== "CONFLICTING";
}

/** The attributes a row derives for the filters and sorts. */
export interface PrFacets {
  ci: CheckStatus;
  review: (typeof PRS_REVIEW)[number];
  merge: Set<PrsMerge>;
  labels: string[];
  needsYou: boolean;
}

export function prFacets(row: AllPRRow, st: PRRowStatus | undefined): PrFacets {
  const { pr } = row;
  const merge = new Set<PrsMerge>();
  if (st?.mergeableState === "CONFLICTING") merge.add("conflicts");
  if (getMergeBlockReason(row.repo, pr.number)) merge.add("blocked");
  if (isMergeApproved(row.prRow)) merge.add("automerge");
  if (isAwaitingApproval(row, st)) merge.add("awaiting");
  return {
    ci: st?.checkStatus ?? "none",
    review: st?.reviewStatus ?? "none",
    merge,
    labels: pr.labels.map((l) => l.name),
    needsYou: prAttentionReasons(row.prRow, row.manualWarning).length > 0,
  };
}

const CI_ORDER: Record<CheckStatus, number> = { failing: 0, pending: 1, held: 2, passing: 3, none: 4 };

function matches(row: AllPRRow, f: PrFacets, q: PrsQuery): boolean {
  const { pr } = row;
  if (q.repo && row.repo !== q.repo) return false;
  if (q.author && (pr.author?.login ?? "") !== q.author) return false;
  if (q.label && !f.labels.includes(q.label)) return false;
  if (q.ci && f.ci !== q.ci) return false;
  if (q.review && f.review !== q.review) return false;
  if (q.merge && !f.merge.has(q.merge)) return false;
  return true;
}

/**
 * Filters then sorts `rows` per `query` (the `kind` chip is applied by the caller).
 * Rows missing the sort key go last either way; ties break by updated, newest first.
 * `needsHuman` lifts the Dependencies view's human-decision PRs first, under the default sort only.
 */
export function applyPrsQuery(
  rows: AllPRRow[],
  query: PrsQuery,
  facets: (row: AllPRRow) => PrFacets,
  needsHuman?: (row: AllPRRow) => boolean,
): AllPRRow[] {
  const kept = rows.filter((row) => matches(row, facets(row), query));
  const byUpdated = (a: AllPRRow, b: AllPRRow) => (b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || "");
  const sign = query.dir === "asc" ? 1 : -1;
  const key = (row: AllPRRow): string | number | undefined => {
    switch (query.sort) {
      case "updated": return row.pr.updatedAt || undefined;
      case "created": return row.pr.createdAt || undefined;
      case "repo": return row.repo;
      case "title": return row.pr.title.toLowerCase();
      case "author": return (row.pr.author?.login ?? "").toLowerCase() || undefined;
      case "ci": return CI_ORDER[facets(row).ci];
    }
  };
  const compare = (a: AllPRRow, b: AllPRRow): number => {
    const ka = key(a);
    const kb = key(b);
    if (ka === undefined && kb !== undefined) return 1;
    if (kb === undefined && ka !== undefined) return -1;
    if (ka !== undefined && kb !== undefined && ka !== kb) {
      const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      if (c !== 0) return c * sign;
    }
    return byUpdated(a, b);
  };
  const lift = query.kind === "deps" && needsHuman && isDefaultPrsSort(query);
  const flags = lift ? new Map(kept.map((row) => [row, needsHuman(row)])) : undefined;
  return kept.sort((a, b) => (flags ? Number(flags.get(b)) - Number(flags.get(a)) : 0) || compare(a, b));
}
