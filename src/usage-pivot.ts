/**
 * The `/usage` pivot: parse and serialise its query-string state, and group
 * row-level usage items (tasks and interactive sessions) into a sorted tree.
 * Pure — no DB or HTML — so `src/pages/usage.ts` renders what this builds.
 */
import type { UsageFilters, UsageItem } from "./db.js";

export const PIVOT_DIMS = ["repo", "job", "provider", "model", "account", "kind", "id", "state", "day"] as const;
export type PivotDim = (typeof PIVOT_DIMS)[number];

export const PIVOT_DIM_LABELS: Record<PivotDim, string> = {
  repo: "Repo",
  job: "Job",
  provider: "Provider",
  model: "Model",
  account: "Account",
  kind: "Kind",
  id: "Task / session",
  state: "State",
  day: "Day",
};

export const PIVOT_MEASURES = ["items", "tokens", "cost", "context"] as const;
export type PivotMeasure = (typeof PIVOT_MEASURES)[number];

export const PIVOT_MEASURE_LABELS: Record<PivotMeasure, string> = {
  items: "Items",
  tokens: "Tokens",
  cost: "Cost",
  context: "Max context",
};

/** The most nested row dimensions a view may pick. */
export const MAX_ROW_DIMS = 3;
/** Column values shown on their own; the rest are summed into {@link OTHER_COL}. */
export const MAX_COL_VALUES = 10;
/** Children rendered under one parent; the rest are counted as "N more". */
export const MAX_CHILDREN = 200;
/** The column key the values beyond the top {@link MAX_COL_VALUES} are summed into. */
export const OTHER_COL = "__other__";
/** The `open` value that expands every row. */
export const OPEN_ALL = "*";

export interface PivotState {
  rows: PivotDim[];
  cols: PivotDim | null;
  /** The measure shown per column value when `cols` is set. */
  measure: PivotMeasure;
  /** A measure, `total` (the chosen measure's row total), or `col:<value>`. */
  sort: string;
  dir: "asc" | "desc";
  /** Expanded row paths (see {@link groupPath}), or {@link OPEN_ALL}. */
  open: string[];
}

export const DEFAULT_PIVOT_STATE: Readonly<PivotState> = Object.freeze({
  rows: ["repo", "job", "id"] as PivotDim[],
  cols: null,
  measure: "cost" as PivotMeasure,
  sort: "cost",
  dir: "desc" as const,
  open: [] as string[],
});

export interface PivotQuery {
  /** Every `rows` value; each may itself be a comma-separated list. */
  rows?: string[];
  cols?: string;
  measure?: string;
  sort?: string;
  dir?: string;
  open?: string[];
}

function isDim(v: string): v is PivotDim {
  return (PIVOT_DIMS as readonly string[]).includes(v);
}

function isMeasure(v: string): v is PivotMeasure {
  return (PIVOT_MEASURES as readonly string[]).includes(v);
}

/** Parse the pivot's query parameters; an invalid value falls back to its default. */
export function parsePivotState(q: PivotQuery): PivotState {
  const rows: PivotDim[] = [];
  for (const raw of q.rows ?? []) {
    for (const part of raw.split(",")) {
      const v = part.trim();
      if (isDim(v) && !rows.includes(v) && rows.length < MAX_ROW_DIMS) rows.push(v);
    }
  }
  const colsRaw = q.cols?.trim() ?? "";
  const cols = isDim(colsRaw) ? colsRaw : null;
  const measureRaw = q.measure?.trim() ?? "";
  const measure = isMeasure(measureRaw) ? measureRaw : DEFAULT_PIVOT_STATE.measure;
  const sortRaw = q.sort?.trim() ?? "";
  let sort: string;
  if (isMeasure(sortRaw)) sort = cols ? "total" : sortRaw;
  else if (cols && (sortRaw === "total" || (sortRaw.startsWith("col:") && sortRaw.length > 4))) sort = sortRaw;
  else if (!cols && sortRaw === "total") sort = measure;
  else sort = cols ? "total" : DEFAULT_PIVOT_STATE.sort;
  const dir = q.dir === "asc" ? "asc" : "desc";
  const open: string[] = [];
  for (const v of q.open ?? []) {
    if (v && !open.includes(v)) open.push(v);
  }
  return {
    rows: rows.length > 0 ? rows : [...DEFAULT_PIVOT_STATE.rows],
    cols,
    measure,
    sort,
    dir,
    open: open.includes(OPEN_ALL) ? [OPEN_ALL] : open,
  };
}

/** The value an item takes on `dim`; the group key. */
export function dimValue(item: UsageItem, dim: PivotDim): string {
  switch (dim) {
    case "repo": return item.repo ?? item.cwd ?? "";
    case "job": return item.job;
    case "provider": return item.provider;
    case "model": return item.model;
    case "account": return item.account;
    case "kind": return item.kind;
    case "id": return item.kind === "session" ? `session:${item.sessionId ?? ""}` : `task:${item.taskId ?? ""}`;
    case "state": return item.state;
    case "day": return item.day;
  }
}

export interface PivotMeasures {
  items: number;
  tokens: number;
  /** Sum of the known costs. */
  cost: number;
  /** Items whose cost is unknown (null). */
  unknownCost: number;
  /** Largest session context in the group; null when it holds no session context. */
  context: number | null;
}

function emptyMeasures(): PivotMeasures {
  return { items: 0, tokens: 0, cost: 0, unknownCost: 0, context: null };
}

function addItem(m: PivotMeasures, item: UsageItem): void {
  m.items += 1;
  m.tokens += item.tokens;
  if (item.costUsd == null) m.unknownCost += 1;
  else m.cost += item.costUsd;
  if (item.lastContextTokens != null) m.context = Math.max(m.context ?? 0, item.lastContextTokens);
}

/** The numeric value of `measure` in `m`, for sorting and ranking; cost is the known sum. */
export function measureValue(m: PivotMeasures | undefined, measure: PivotMeasure): number {
  if (!m) return -1;
  switch (measure) {
    case "items": return m.items;
    case "tokens": return m.tokens;
    case "cost": return m.cost;
    case "context": return m.context ?? -1;
  }
}

export interface PivotGroup {
  dim: PivotDim;
  value: string;
  /** The group's open path: its and its ancestors' values, each `encodeURIComponent`-ed, joined by `/`. */
  path: string;
  depth: number;
  /** An item in the group, for rendering its label (avatar, link, …). */
  sample: UsageItem;
  measures: PivotMeasures;
  /** Measures per column value (and {@link OTHER_COL}) when `cols` is set. */
  byCol: Map<string, PivotMeasures>;
  /** Sorted children, at most {@link MAX_CHILDREN}; empty at the last row dimension. */
  children: PivotGroup[];
  /** Children beyond the cap, not rendered. */
  hiddenChildren: number;
}

export interface Pivot {
  groups: PivotGroup[];
  hiddenGroups: number;
  total: PivotMeasures;
  totalByCol: Map<string, PivotMeasures>;
  /** Column keys in display order: the top values, then {@link OTHER_COL} if any were folded. */
  colKeys: string[];
  /** A sample item per column value, for labels. */
  colSamples: Map<string, UsageItem>;
}

/** Join a group's path with its child value. */
export function groupPath(parent: string, value: string): string {
  // An empty value gets a sentinel so the segment (and `open=` entry) is never empty.
  const seg = value === "" ? "%00" : encodeURIComponent(value);
  return parent === "" ? seg : `${parent}/${seg}`;
}

/** Whether the row at `path` is expanded. */
export function isOpen(state: PivotState, path: string): boolean {
  return state.open.includes(OPEN_ALL) || state.open.includes(path);
}

function sortValue(g: PivotGroup, state: PivotState): number {
  if (state.sort.startsWith("col:")) {
    return measureValue(g.byCol.get(state.sort.slice(4)), state.measure);
  }
  if (state.sort === "total") return measureValue(g.measures, state.measure);
  return isMeasure(state.sort) ? measureValue(g.measures, state.sort) : g.measures.cost;
}

function buildLevel(items: UsageItem[], state: PivotState, depth: number, parentPath: string, colOf: ((i: UsageItem) => string) | null): { groups: PivotGroup[]; hidden: number } {
  const dim = state.rows[depth];
  const buckets = new Map<string, UsageItem[]>();
  for (const item of items) {
    const v = dimValue(item, dim);
    const list = buckets.get(v);
    if (list) list.push(item);
    else buckets.set(v, [item]);
  }
  const entries: Array<{ group: PivotGroup; items: UsageItem[] }> = [];
  for (const [value, list] of buckets) {
    const measures = emptyMeasures();
    const byCol = new Map<string, PivotMeasures>();
    for (const item of list) {
      addItem(measures, item);
      if (colOf) {
        const key = colOf(item);
        let m = byCol.get(key);
        if (!m) { m = emptyMeasures(); byCol.set(key, m); }
        addItem(m, item);
      }
    }
    entries.push({ group: { dim, value, path: groupPath(parentPath, value), depth, sample: list[0], measures, byCol, children: [], hiddenChildren: 0 }, items: list });
  }
  const sign = state.dir === "asc" ? 1 : -1;
  entries.sort((a, b) => (sortValue(a.group, state) - sortValue(b.group, state)) * sign || a.group.value.localeCompare(b.group.value));
  const shown = entries.slice(0, MAX_CHILDREN);
  if (depth + 1 < state.rows.length) {
    for (const { group, items: list } of shown) {
      const sub = buildLevel(list, state, depth + 1, group.path, colOf);
      group.children = sub.groups;
      group.hiddenChildren = sub.hidden;
    }
  }
  return { groups: shown.map((e) => e.group), hidden: entries.length - shown.length };
}

/** Group `items` by `state.rows` (and `state.cols`) into a sorted tree. */
export function buildPivot(items: UsageItem[], state: PivotState): Pivot {
  const total = emptyMeasures();
  for (const item of items) addItem(total, item);

  let colOf: ((i: UsageItem) => string) | null = null;
  const colKeys: string[] = [];
  const colSamples = new Map<string, UsageItem>();
  const totalByCol = new Map<string, PivotMeasures>();
  if (state.cols) {
    const dim = state.cols;
    const perValue = new Map<string, PivotMeasures>();
    for (const item of items) {
      const v = dimValue(item, dim);
      let m = perValue.get(v);
      if (!m) { m = emptyMeasures(); perValue.set(v, m); colSamples.set(v, item); }
      addItem(m, item);
    }
    const ranked = [...perValue.entries()].sort((a, b) => measureValue(b[1], state.measure) - measureValue(a[1], state.measure) || a[0].localeCompare(b[0]));
    const top = new Set(ranked.slice(0, MAX_COL_VALUES).map(([v]) => v));
    colKeys.push(...ranked.slice(0, MAX_COL_VALUES).map(([v]) => v));
    if (ranked.length > MAX_COL_VALUES) colKeys.push(OTHER_COL);
    colOf = (i) => {
      const v = dimValue(i, dim);
      return top.has(v) ? v : OTHER_COL;
    };
    for (const item of items) {
      const key = colOf(item);
      let m = totalByCol.get(key);
      if (!m) { m = emptyMeasures(); totalByCol.set(key, m); }
      addItem(m, item);
    }
  }

  const { groups, hidden } = buildLevel(items, state, 0, "", colOf);
  return { groups, hiddenGroups: hidden, total, totalByCol, colKeys, colSamples };
}

export interface PivotBase {
  days: number;
  filters: UsageFilters;
}

/** A `/usage` query string (`?…`) for `base` and `state` with `overrides` applied; defaults are omitted. */
export function pivotHref(base: PivotBase, state: PivotState, overrides: Partial<PivotState> & { days?: number; filters?: UsageFilters } = {}): string {
  const days = overrides.days ?? base.days;
  const filters = overrides.filters ?? base.filters;
  const s: PivotState = { ...state, ...overrides };
  const parts: string[] = [`days=${days}`];
  for (const key of ["repo", "job", "provider", "account", "model"] as const) {
    const v = filters[key];
    if (v) parts.push(`${key}=${encodeURIComponent(v)}`);
  }
  if (s.rows.join(",") !== DEFAULT_PIVOT_STATE.rows.join(",")) parts.push(`rows=${s.rows.join(",")}`);
  if (s.cols) parts.push(`cols=${s.cols}`);
  if (s.measure !== DEFAULT_PIVOT_STATE.measure) parts.push(`measure=${s.measure}`);
  if (s.sort !== DEFAULT_PIVOT_STATE.sort) parts.push(`sort=${encodeURIComponent(s.sort)}`);
  if (s.dir !== DEFAULT_PIVOT_STATE.dir) parts.push(`dir=${s.dir}`);
  for (const p of s.open) parts.push(`open=${encodeURIComponent(p)}`);
  return `?${parts.join("&")}`;
}

/** The ancestors' paths of `path`, nearest last. */
function ancestors(path: string): string[] {
  const segs = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

/** The `open` list after toggling `path`: collapsing also drops its descendants. Under {@link OPEN_ALL}, collapsing keeps only the row's ancestors open. */
export function toggleOpen(state: PivotState, path: string): string[] {
  if (state.open.includes(OPEN_ALL)) return ancestors(path);
  if (state.open.includes(path)) return state.open.filter((p) => p !== path && !p.startsWith(`${path}/`));
  return [...state.open, path];
}

/** The sort and direction a header for `sortKey` links to: toggles direction when already active, descending otherwise. */
export function sortToggle(state: PivotState, sortKey: string): { sort: string; dir: "asc" | "desc" } {
  if (state.sort === sortKey) return { sort: sortKey, dir: state.dir === "desc" ? "asc" : "desc" };
  return { sort: sortKey, dir: "desc" };
}
