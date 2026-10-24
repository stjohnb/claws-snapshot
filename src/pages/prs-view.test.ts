import { describe, it, expect } from "vitest";
import { applyPrsQuery, DEFAULT_PRS_QUERY, parsePrsQuery, prFacets, prsHref, PRS_FILTER_KEYS, type PrsQuery } from "./prs-view.js";
import type { AllPRRow, PRRowStatus } from "./lists.js";
import type { PR } from "../github.js";

function pr(number: number, over: Partial<PR> = {}): PR {
  return { number, title: `PR ${number}`, headRefName: `feat/${number}`, baseRefName: "main", labels: [], author: { login: "alice" }, updatedAt: `2026-10-0${number}T00:00:00Z`, createdAt: `2026-09-0${10 - number}T00:00:00Z`, ...over };
}
function status(over: Partial<PRRowStatus> = {}): PRRowStatus {
  return { checkStatus: "passing", checksPassed: 1, checksTotal: 1, mergeableState: "MERGEABLE", ...over };
}
const q = (over: Partial<PrsQuery> = {}): PrsQuery => ({ ...DEFAULT_PRS_QUERY, ...over });
const facets = (row: AllPRRow) => prFacets(row, row.status);
const numbers = (rows: AllPRRow[]) => rows.map((r) => r.pr.number);

describe("parsePrsQuery / prsHref", () => {
  it("defaults and ignores invalid values", () => {
    const query = parsePrsQuery((k) => ({ kind: "bogus", sort: "nope", dir: "up", ci: "x" } as Record<string, string>)[k]);
    expect(query).toEqual(DEFAULT_PRS_QUERY);
    expect(prsHref(query)).toBe("/prs?kind=all");
  });

  it("writes only non-default keys and round-trips", () => {
    const query = q({ kind: "blocked", repo: "org/a b", label: "x&y#z", ci: "failing", sort: "created", dir: "asc" });
    const href = prsHref(query);
    const params = new URL(href, "http://x").searchParams;
    expect(parsePrsQuery((k) => params.get(k) ?? undefined)).toEqual(query);
    expect(prsHref(q({ kind: "all", sort: "created" }))).toBe("/prs?kind=all&sort=created");
  });

  it("keeps kind and filters together on a non-default view", () => {
    expect(prsHref(q({ kind: "other", repo: "o/a" }))).toBe("/prs?kind=other&repo=o%2Fa");
  });
});

describe("applyPrsQuery", () => {
  const rows: AllPRRow[] = [
    { repo: "o/a", pr: pr(1, { isDraft: true, labels: [{ name: "bug" }] }), status: status({ checkStatus: "failing" }) },
    { repo: "o/b", pr: pr(2, { author: { login: "bob" } }), status: status({ mergeableState: "CONFLICTING" }) },
    { repo: "o/a", pr: pr(3, { headRefName: "claws/issue-3-x" }), status: status({ checkStatus: "pending" }) },
  ];

  it("filters by each attribute and combines them", () => {
    expect(numbers(applyPrsQuery(rows, q({ repo: "o/a" }), facets))).toEqual([3, 1]);
    expect(numbers(applyPrsQuery(rows, q({ author: "bob" }), facets))).toEqual([2]);
    expect(numbers(applyPrsQuery(rows, q({ label: "bug" }), facets))).toEqual([1]);
    expect(numbers(applyPrsQuery(rows, q({ ci: "failing" }), facets))).toEqual([1]);
    expect(numbers(applyPrsQuery(rows, q({ merge: "conflicts" }), facets))).toEqual([2]);
    expect(numbers(applyPrsQuery(rows, q({ repo: "o/a", ci: "pending" }), facets))).toEqual([3]);
  });

  it("sorts by created in both directions", () => {
    expect(numbers(applyPrsQuery(rows, q({ sort: "created", dir: "asc" }), facets))).toEqual([3, 2, 1]);
    expect(numbers(applyPrsQuery(rows, q({ sort: "created", dir: "desc" }), facets))).toEqual([1, 2, 3]);
  });

  it("sorts rows missing the key last either way", () => {
    const withGap: AllPRRow[] = [...rows, { repo: "o/a", pr: pr(4, { createdAt: undefined }) }];
    expect(numbers(applyPrsQuery(withGap, q({ sort: "created", dir: "asc" }), facets)).at(-1)).toBe(4);
    expect(numbers(applyPrsQuery(withGap, q({ sort: "created", dir: "desc" }), facets)).at(-1)).toBe(4);
  });

  it("orders CI failing, pending, passing", () => {
    expect(numbers(applyPrsQuery(rows, q({ sort: "ci", dir: "asc" }), facets))).toEqual([1, 3, 2]);
  });

  it("puts needs-human first in the deps view only under the default sort", () => {
    const needs = (row: AllPRRow) => row.pr.number === 1;
    expect(numbers(applyPrsQuery(rows, q({ kind: "deps" }), facets, needs))[0]).toBe(1);
    expect(numbers(applyPrsQuery(rows, q({ kind: "deps", sort: "created", dir: "desc" }), facets, needs))).toEqual([1, 2, 3]);
    expect(numbers(applyPrsQuery(rows, q({ kind: "deps", sort: "created", dir: "asc" }), facets, needs))).toEqual([3, 2, 1]);
  });
});

describe("PRS_FILTER_KEYS", () => {
  it("lists the six filter keys in order", () => {
    expect([...PRS_FILTER_KEYS]).toEqual(["repo", "author", "label", "ci", "review", "merge"]);
  });
});
