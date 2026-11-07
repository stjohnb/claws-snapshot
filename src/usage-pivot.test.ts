import { describe, it, expect } from "vitest";
import type { UsageItem } from "./db.js";
import {
  DEFAULT_PIVOT_STATE, MAX_CHILDREN, OTHER_COL, OPEN_ALL,
  buildPivot, groupPath, isOpen, parsePivotState, pivotHref, sortToggle, toggleOpen,
  type PivotState,
} from "./usage-pivot.js";

function item(overrides: Partial<UsageItem> = {}): UsageItem {
  return {
    kind: "task",
    taskId: 1,
    runId: null,
    sessionId: null,
    repo: "org/repo-a",
    cwd: null,
    job: "issue-worker",
    provider: "claude",
    account: "",
    model: "opus",
    state: "completed",
    tokens: 100,
    costUsd: 1,
    lastContextTokens: null,
    day: "2026-11-01",
    alive: false,
    ...overrides,
  };
}

function state(overrides: Partial<PivotState> = {}): PivotState {
  return { ...DEFAULT_PIVOT_STATE, rows: [...DEFAULT_PIVOT_STATE.rows], open: [], ...overrides };
}

describe("parsePivotState", () => {
  it("defaults when nothing is given", () => {
    expect(parsePivotState({})).toEqual({ rows: ["repo", "job", "id"], cols: null, measure: "cost", sort: "cost", dir: "desc", open: [] });
  });

  it("accepts comma lists and repeated rows, dropping unknown names and duplicates and keeping at most 3", () => {
    expect(parsePivotState({ rows: ["model,bogus,model", "day", "", "kind", "state"] }).rows).toEqual(["model", "day", "kind"]);
    expect(parsePivotState({ rows: ["bogus"] }).rows).toEqual(["repo", "job", "id"]);
  });

  it("falls back on invalid cols, measure, sort and dir", () => {
    const s = parsePivotState({ cols: "nope", measure: "nope", sort: "nope", dir: "sideways" });
    expect(s).toMatchObject({ cols: null, measure: "cost", sort: "cost", dir: "desc" });
  });

  it("allows total and col: sorts only with a column dimension", () => {
    expect(parsePivotState({ sort: "col:claude" }).sort).toBe("cost");
    expect(parsePivotState({ sort: "total", measure: "tokens" }).sort).toBe("tokens");
    expect(parsePivotState({ cols: "provider", sort: "col:claude" }).sort).toBe("col:claude");
    expect(parsePivotState({ cols: "provider", sort: "total", dir: "asc" })).toMatchObject({ sort: "total", dir: "asc" });
  });

  it("collapses open to * when present and drops duplicates", () => {
    expect(parsePivotState({ open: ["a", "a", "b"] }).open).toEqual(["a", "b"]);
    expect(parsePivotState({ open: ["a", "*"] }).open).toEqual([OPEN_ALL]);
  });
});

describe("buildPivot", () => {
  const items = [
    item({ taskId: 1, repo: "org/repo-a", job: "issue-worker", tokens: 100, costUsd: 1 }),
    item({ taskId: 2, repo: "org/repo-a", job: "ci-fixer", tokens: 50, costUsd: 3 }),
    item({ taskId: 3, repo: "org/repo-b", job: "issue-worker", tokens: 500, costUsd: 0.5 }),
    item({ kind: "session", taskId: null, sessionId: "sess-1", repo: "org/repo-b", job: "interactive-session", tokens: 10, costUsd: null, lastContextTokens: 150_000, state: "Live", alive: true }),
  ];

  it("groups by the row dimensions with nested children and grand totals", () => {
    const p = buildPivot(items, state());
    expect(p.groups.map((g) => g.value)).toEqual(["org/repo-a", "org/repo-b"]);
    const a = p.groups[0];
    expect(a.measures).toMatchObject({ items: 2, tokens: 150, cost: 4, unknownCost: 0, context: null });
    expect(a.children.map((g) => g.value)).toEqual(["ci-fixer", "issue-worker"]);
    expect(a.children[0].children.map((g) => g.value)).toEqual(["task:2"]);
    expect(a.children[0].children[0].children).toEqual([]);
    expect(p.total).toMatchObject({ items: 4, tokens: 660, cost: 4.5, unknownCost: 1, context: 150_000 });
  });

  it("counts unknown costs apart from the known sum and takes max context", () => {
    const p = buildPivot(items, state({ rows: ["repo"] }));
    const b = p.groups.find((g) => g.value === "org/repo-b")!;
    expect(b.measures).toMatchObject({ items: 2, cost: 0.5, unknownCost: 1, context: 150_000 });
  });

  it("sorts by the chosen measure and direction", () => {
    expect(buildPivot(items, state({ rows: ["repo"], sort: "tokens" })).groups.map((g) => g.value)).toEqual(["org/repo-b", "org/repo-a"]);
    expect(buildPivot(items, state({ rows: ["repo"], sort: "cost", dir: "asc" })).groups.map((g) => g.value)).toEqual(["org/repo-b", "org/repo-a"]);
    expect(buildPivot(items, state({ rows: ["repo"], sort: "context" })).groups[0].value).toBe("org/repo-b");
  });

  it("splits by a column dimension and sorts by a column", () => {
    const p = buildPivot(items, state({ rows: ["repo"], cols: "job", measure: "tokens", sort: "col:issue-worker" }));
    expect(p.colKeys).toEqual(["issue-worker", "ci-fixer", "interactive-session"]);
    expect(p.groups[0].value).toBe("org/repo-b");
    expect(p.groups[0].byCol.get("issue-worker")?.tokens).toBe(500);
    expect(p.totalByCol.get("ci-fixer")?.tokens).toBe(50);
  });

  it("keeps the top 10 column values and folds the rest into Other", () => {
    const many = Array.from({ length: 13 }, (_, i) => item({ taskId: i, model: `m${i}`, tokens: (i + 1) * 10 }));
    const p = buildPivot(many, state({ rows: ["repo"], cols: "model", measure: "tokens" }));
    expect(p.colKeys).toHaveLength(11);
    expect(p.colKeys[0]).toBe("m12");
    expect(p.colKeys[10]).toBe(OTHER_COL);
    expect(p.totalByCol.get(OTHER_COL)?.tokens).toBe(10 + 20 + 30);
    expect(p.groups[0].byCol.get(OTHER_COL)?.items).toBe(3);
  });

  it("caps children per parent and counts the rest", () => {
    const many = Array.from({ length: MAX_CHILDREN + 5 }, (_, i) => item({ taskId: i }));
    const p = buildPivot(many, state({ rows: ["repo", "id"] }));
    expect(p.groups[0].children).toHaveLength(MAX_CHILDREN);
    expect(p.groups[0].hiddenChildren).toBe(5);
    const top = buildPivot(many, state({ rows: ["id"] }));
    expect(top.groups).toHaveLength(MAX_CHILDREN);
    expect(top.hiddenGroups).toBe(5);
  });

  it("encodes / in path segments so repo paths stay unambiguous", () => {
    const p = buildPivot(items, state());
    expect(p.groups[0].path).toBe("org%2Frepo-a");
    expect(p.groups[0].children[0].path).toBe("org%2Frepo-a/ci-fixer");
    expect(groupPath("org%2Frepo-a/ci-fixer", "task:2")).toBe("org%2Frepo-a/ci-fixer/task%3A2");
  });
});

describe("open state", () => {
  it("expands everything under *", () => {
    expect(isOpen(state({ open: [OPEN_ALL] }), "anything")).toBe(true);
    expect(isOpen(state({ open: ["a"] }), "b")).toBe(false);
  });

  it("toggles a path, dropping its descendants on collapse", () => {
    expect(toggleOpen(state({ open: ["a"] }), "b")).toEqual(["a", "b"]);
    expect(toggleOpen(state({ open: ["a", "a/x", "b"] }), "a")).toEqual(["b"]);
    expect(toggleOpen(state({ open: [OPEN_ALL] }), "a/x")).toEqual(["a"]);
  });
});

describe("sortToggle", () => {
  it("flips direction on the active column and starts descending otherwise", () => {
    expect(sortToggle(state(), "cost")).toEqual({ sort: "cost", dir: "asc" });
    expect(sortToggle(state({ dir: "asc" }), "cost")).toEqual({ sort: "cost", dir: "desc" });
    expect(sortToggle(state(), "tokens")).toEqual({ sort: "tokens", dir: "desc" });
  });
});

describe("pivotHref", () => {
  it("omits defaults and keeps the window and filters", () => {
    expect(pivotHref({ days: 7, filters: { repo: "org/repo-a" } }, state())).toBe("?days=7&repo=org%2Frepo-a");
  });

  it("round-trips through parsePivotState", () => {
    const s = state({ rows: ["model", "repo"], cols: "day", measure: "tokens", sort: "col:2026-11-01", dir: "asc", open: ["org%2Frepo-a", "org%2Frepo-a/task%3A2"] });
    const href = pivotHref({ days: 30, filters: { provider: "unknown" } }, s);
    const params = new URLSearchParams(href.slice(1));
    expect(params.get("days")).toBe("30");
    expect(params.get("provider")).toBe("unknown");
    const parsed = parsePivotState({
      rows: params.getAll("rows"),
      cols: params.get("cols") ?? undefined,
      measure: params.get("measure") ?? undefined,
      sort: params.get("sort") ?? undefined,
      dir: params.get("dir") ?? undefined,
      open: params.getAll("open"),
    });
    expect(parsed).toEqual(s);
  });

  it("applies overrides for days, filters and pivot fields", () => {
    expect(pivotHref({ days: 7, filters: { job: "ci-fixer" } }, state(), { days: 1, filters: {}, open: ["x"] })).toBe("?days=1&open=x");
  });
});

describe("review fixes", () => {
  it("round-trips an open empty-valued group", () => {
    const path = groupPath("", "");
    expect(path).not.toBe("");
    const open = toggleOpen(parsePivotState({}), path);
    const parsed = parsePivotState({ open });
    expect(isOpen(parsed, path)).toBe(true);
  });

  it("keeps a sort on the Other column printable and parseable", () => {
    expect(OTHER_COL).toMatch(/^[\x21-\x7e]+$/);
    expect(parsePivotState({ cols: "model", sort: `col:${OTHER_COL}` }).sort).toBe(`col:${OTHER_COL}`);
  });

  it("sorts by total when columns are set and the sort is a measure or absent", () => {
    expect(parsePivotState({ cols: "model", sort: "cost" }).sort).toBe("total");
    expect(parsePivotState({ cols: "model" }).sort).toBe("total");
  });
});
