import { describe, it, expect } from "vitest";
import { applyIssuesQuery, DEFAULT_ISSUES_QUERY, hasIssuesFilters, isDefaultIssuesQuery, issuesDateRange, issuesHref, parseIssuesQuery, type IssuesQuery } from "./issues-view.js";
import type { AllIssueRow } from "./lists.js";
import type { Issue } from "../github.js";

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return { number, title: `Issue ${number}`, body: "", labels: [], author: { login: "alice" }, updatedAt: `2026-10-0${number}T00:00:00Z`, createdAt: `2026-09-0${number}T00:00:00Z`, ...over };
}
const q = (over: Partial<IssuesQuery> = {}): IssuesQuery => ({ ...DEFAULT_ISSUES_QUERY, ...over });
const numbers = (rows: AllIssueRow[]) => rows.map((r) => r.issue.number);
const parse = (o: Record<string, string | string[]>) =>
  parseIssuesQuery((k) => { const v = o[k]; return Array.isArray(v) ? v[0] : v; }, (k) => { const v = o[k]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; });

describe("parseIssuesQuery / issuesHref", () => {
  it("reads a bare address as today's view: open, most recently updated first", () => {
    const query = parse({});
    expect(query).toEqual(DEFAULT_ISSUES_QUERY);
    expect(isDefaultIssuesQuery(query)).toBe(true);
    expect(hasIssuesFilters(query)).toBe(false);
    expect(issuesHref(query)).toBe("/issues");
  });

  it("falls back to defaults on unknown values and drops malformed dates", () => {
    expect(parse({ state: "bogus", sort: "nope", dir: "up", date: "x", from: "2026-13-01", to: "yesterday" })).toEqual(DEFAULT_ISSUES_QUERY);
    expect(parse({ from: "2026-02-30" }).from).toBe("");
  });

  it("bounds the close date by default once closed issues are listed, and never under the open state", () => {
    expect(parse({ state: "closed" }).dateField).toBe("closed");
    expect(parse({ state: "all" }).dateField).toBe("closed");
    expect(parse({ state: "open", date: "closed" }).dateField).toBe("updated");
    expect(parse({ state: "closed", date: "created" }).dateField).toBe("created");
  });

  it("round-trips every field, repeating repo and omitting defaults", () => {
    const query = q({ state: "closed", repos: ["org/a", "org/b"], dateField: "created", from: "2026-10-01", to: "2026-10-31", sort: "closed", dir: "asc" });
    const href = issuesHref(query);
    expect(href).toBe("/issues?state=closed&repo=org%2Fa&repo=org%2Fb&date=created&from=2026-10-01&to=2026-10-31&sort=closed&dir=asc");
    const params = new URL(href, "http://x").searchParams;
    expect(parseIssuesQuery((k) => params.get(k) ?? undefined, (k) => params.getAll(k))).toEqual(query);
    expect(issuesHref(q({ state: "closed", dateField: "closed", from: "2026-10-01" }))).toBe("/issues?state=closed&from=2026-10-01");
    expect(issuesHref(q({ dateField: "created" }))).toBe("/issues");
  });

  it("dedupes and sorts the ticked repositories", () => {
    expect(parse({ repo: ["org/b", "org/a", "org/b", ""] }).repos).toEqual(["org/a", "org/b"]);
  });

  it("makes To cover the whole UTC day", () => {
    const range = issuesDateRange(q({ from: "2026-10-01", to: "2026-10-02" }));
    expect(range.from?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(range.to?.toISOString()).toBe("2026-10-02T23:59:59.999Z");
  });
});

describe("applyIssuesQuery", () => {
  const open: AllIssueRow[] = [
    { repo: "org/a", issue: issue(1) },
    { repo: "org/b", issue: issue(3, { repos: ["org/b", "org/c"] }) },
    { repo: "org/a", issue: issue(2) },
  ];
  const closed: AllIssueRow[] = [
    { repo: "org/a", issue: issue(4), closedAt: "2026-10-05T12:00:00Z", stateReason: "completed" },
    { repo: "org/c", issue: issue(5), closedAt: "2026-09-20T12:00:00Z", stateReason: "not_planned" },
    { repo: "", issue: issue(6), closedAt: "2026-10-06T00:00:00Z" },
  ];
  const all = [...open, ...closed];

  it("keeps today's order under the default view: open only, newest updated first", () => {
    expect(numbers(applyIssuesQuery(all, DEFAULT_ISSUES_QUERY))).toEqual([3, 2, 1]);
  });

  it("splits open, closed and all", () => {
    expect(numbers(applyIssuesQuery(all, q({ state: "closed" })))).toEqual([6, 5, 4]);
    expect(numbers(applyIssuesQuery(all, q({ state: "all" })))).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("matches any ticked repo, including one an issue only names", () => {
    expect(numbers(applyIssuesQuery(all, q({ state: "all", repos: ["org/c"] })))).toEqual([5, 3]);
    expect(numbers(applyIssuesQuery(all, q({ state: "all", repos: ["org/a", "org/c"] })))).toEqual([5, 4, 3, 2, 1]);
  });

  it("filters closed issues for one repo closed on or after a day", () => {
    const rows = applyIssuesQuery(all, q({ state: "closed", repos: ["org/a"], dateField: "closed", from: "2026-10-05" }));
    expect(numbers(rows)).toEqual([4]);
    expect(numbers(applyIssuesQuery(all, q({ state: "closed", dateField: "closed", to: "2026-10-05" })))).toEqual([5, 4]);
  });

  it("never matches an open row against a close-date range", () => {
    expect(numbers(applyIssuesQuery(all, q({ state: "all", dateField: "closed", from: "2026-01-01" })))).toEqual([6, 5, 4]);
  });

  it("bounds created and updated dates inclusively", () => {
    expect(numbers(applyIssuesQuery(all, q({ dateField: "created", from: "2026-09-02", to: "2026-09-03" })))).toEqual([3, 2]);
    expect(numbers(applyIssuesQuery(all, q({ dateField: "updated", from: "2026-10-03", to: "2026-10-03" })))).toEqual([3]);
  });

  it("returns nothing when From is after To", () => {
    expect(applyIssuesQuery(all, q({ from: "2026-10-05", to: "2026-10-01" }))).toEqual([]);
  });

  it("sorts by close date both ways with open rows last", () => {
    expect(numbers(applyIssuesQuery(all, q({ state: "all", sort: "closed", dir: "desc" })))).toEqual([6, 4, 5, 3, 2, 1]);
    expect(numbers(applyIssuesQuery(all, q({ state: "all", sort: "closed", dir: "asc" })))).toEqual([5, 4, 6, 3, 2, 1]);
  });

  it("sorts by created, repo, title and author", () => {
    expect(numbers(applyIssuesQuery(open, q({ sort: "created", dir: "asc" })))).toEqual([1, 2, 3]);
    expect(numbers(applyIssuesQuery(open, q({ sort: "repo", dir: "desc" })))).toEqual([3, 2, 1]);
    expect(numbers(applyIssuesQuery(open, q({ sort: "title", dir: "asc" })))).toEqual([1, 2, 3]);
    const authored = [{ repo: "org/a", issue: issue(1, { author: { login: "zed" } }) }, { repo: "org/a", issue: issue(2, { author: { login: "amy" } }) }];
    expect(numbers(applyIssuesQuery(authored, q({ sort: "author", dir: "asc" })))).toEqual([2, 1]);
  });
});
