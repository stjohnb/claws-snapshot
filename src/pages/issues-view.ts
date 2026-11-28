import type { AllIssueRow } from "./lists.js";

/**
 * The `/issues` view model: the state, repositories, date range and sort an
 * `/issues?…` address names, and the filter-then-sort step. The page
 * (`buildAllIssuesPage`) renders it. A bare `/issues` is today's view: open
 * issues, most recently updated first.
 */

export const ISSUES_SORTS = ["updated", "created", "closed", "repo", "title", "author"] as const;
export type IssuesSort = (typeof ISSUES_SORTS)[number];
export type IssuesDir = "asc" | "desc";

export const ISSUES_STATES = ["open", "closed", "all"] as const;
export type IssuesState = (typeof ISSUES_STATES)[number];

export const ISSUES_DATE_FIELDS = ["closed", "created", "updated"] as const;
export type IssuesDateField = (typeof ISSUES_DATE_FIELDS)[number];

export interface IssuesQuery {
  state: IssuesState;
  /** Ticked repositories, full names; empty means every repository. */
  repos: string[];
  /** The date the From/To range bounds. `closed` is never used with the open state. */
  dateField: IssuesDateField;
  /** Inclusive UTC days as `YYYY-MM-DD`, or `""` for no bound. */
  from: string;
  to: string;
  sort: IssuesSort;
  dir: IssuesDir;
}

export const DEFAULT_ISSUES_QUERY: IssuesQuery = {
  state: "open", repos: [], dateField: "updated", from: "", to: "", sort: "updated", dir: "desc",
};

/** The date field a state's range bounds when the address names none: close date once closed issues are listed. */
export function defaultDateField(state: IssuesState): IssuesDateField {
  return state === "open" ? "updated" : "closed";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` when `raw` is a real calendar day, else `""`. */
function parseDay(raw: string | undefined): string {
  if (!raw || !DAY.test(raw)) return "";
  const d = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : "";
}

function oneOf<T extends string>(values: readonly T[], raw: string | undefined): T | undefined {
  return raw !== undefined && (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

/**
 * Reads a query from request parameters; unknown values fall back to the
 * defaults and malformed dates to no bound. `getAll` returns every value of a
 * repeated key (`repo`).
 */
export function parseIssuesQuery(get: (key: string) => string | undefined, getAll: (key: string) => string[]): IssuesQuery {
  const state = oneOf(ISSUES_STATES, get("state")) ?? DEFAULT_ISSUES_QUERY.state;
  const rawField = oneOf(ISSUES_DATE_FIELDS, get("date")) ?? defaultDateField(state);
  const sort = oneOf(ISSUES_SORTS, get("sort")) ?? DEFAULT_ISSUES_QUERY.sort;
  const dir = oneOf(["asc", "desc"] as const, get("dir")) ?? DEFAULT_ISSUES_QUERY.dir;
  return {
    state,
    repos: [...new Set(getAll("repo").map((r) => r.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    // An open issue has no close date, so the open state never bounds one.
    dateField: state === "open" && rawField === "closed" ? "updated" : rawField,
    from: parseDay(get("from")),
    to: parseDay(get("to")),
    sort,
    dir,
  };
}

/** The `/issues?…` address for a view, writing only the keys that differ from the default. */
export function issuesHref(query: IssuesQuery): string {
  const params = new URLSearchParams();
  if (query.state !== DEFAULT_ISSUES_QUERY.state) params.set("state", query.state);
  for (const repo of query.repos) params.append("repo", repo);
  if ((query.from || query.to) && query.dateField !== defaultDateField(query.state)) params.set("date", query.dateField);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.sort !== DEFAULT_ISSUES_QUERY.sort || query.dir !== DEFAULT_ISSUES_QUERY.dir) {
    params.set("sort", query.sort);
    params.set("dir", query.dir);
  }
  const qs = params.toString();
  return `/issues${qs ? `?${qs}` : ""}`;
}

/** True when the state, a repository or a date bound narrows the list. */
export function hasIssuesFilters(query: IssuesQuery): boolean {
  return query.state !== DEFAULT_ISSUES_QUERY.state || query.repos.length > 0 || query.from !== "" || query.to !== "";
}

/** True for a bare `/issues`: no filter and the default sort. */
export function isDefaultIssuesQuery(query: IssuesQuery): boolean {
  return !hasIssuesFilters(query) && query.sort === DEFAULT_ISSUES_QUERY.sort && query.dir === DEFAULT_ISSUES_QUERY.dir;
}

/** The query's date bounds as instants: From's first and To's last millisecond, UTC. */
export function issuesDateRange(query: IssuesQuery): { from?: Date; to?: Date } {
  return {
    ...(query.from ? { from: new Date(`${query.from}T00:00:00.000Z`) } : {}),
    ...(query.to ? { to: new Date(`${query.to}T23:59:59.999Z`) } : {}),
  };
}

function rowDate(row: AllIssueRow, field: IssuesDateField): string | undefined {
  switch (field) {
    case "closed": return row.closedAt || undefined;
    case "created": return row.issue.createdAt || undefined;
    case "updated": return row.issue.updatedAt || undefined;
  }
}

function matches(row: AllIssueRow, query: IssuesQuery, range: { from?: number; to?: number }): boolean {
  const closed = row.closedAt !== undefined;
  if (query.state === "open" && closed) return false;
  if (query.state === "closed" && !closed) return false;
  if (query.repos.length > 0) {
    const named = new Set([row.repo, ...(row.issue.repos ?? [])]);
    if (!query.repos.some((r) => named.has(r))) return false;
  }
  if (range.from !== undefined || range.to !== undefined) {
    const raw = rowDate(row, query.dateField);
    const t = raw ? Date.parse(raw) : NaN;
    if (Number.isNaN(t)) return false;
    if (range.from !== undefined && t < range.from) return false;
    if (range.to !== undefined && t > range.to) return false;
  }
  return true;
}

/**
 * Filters then sorts `rows` per `query`. A row is closed when it carries
 * `closedAt`. Repository matching is "any": a row is kept when its own repo or
 * any repo its issue names is ticked. Rows missing the sort key go last either
 * way; ties break by updated, newest first.
 */
export function applyIssuesQuery(rows: AllIssueRow[], query: IssuesQuery): AllIssueRow[] {
  const bounds = issuesDateRange(query);
  const range = { from: bounds.from?.getTime(), to: bounds.to?.getTime() };
  const kept = rows.filter((row) => matches(row, query, range));
  const byUpdated = (a: AllIssueRow, b: AllIssueRow) => (b.issue.updatedAt || "").localeCompare(a.issue.updatedAt || "");
  const sign = query.dir === "asc" ? 1 : -1;
  const key = (row: AllIssueRow): string | number | undefined => {
    switch (query.sort) {
      case "updated":
      case "created":
      case "closed": {
        const raw = rowDate(row, query.sort);
        const t = raw ? Date.parse(raw) : NaN;
        return Number.isNaN(t) ? undefined : t;
      }
      case "repo": return row.repo || undefined;
      case "title": return row.issue.title.toLowerCase();
      case "author": return (row.issue.author?.login ?? "").toLowerCase() || undefined;
    }
  };
  const compare = (a: AllIssueRow, b: AllIssueRow): number => {
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
  return kept.sort(compare);
}
