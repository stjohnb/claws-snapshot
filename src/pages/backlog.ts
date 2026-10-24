import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, specLabelChip, repoAvatar, repoShortName } from "./layout.js";
import type { NavCounts, Theme } from "./layout.js";
import { LIST_FILTERS_CSS, filterOptions, filterSelect } from "./list-filters.js";
import { isStateLabel } from "../issue-lifecycle.js";
import { isClawsIssueId, shortIssueRef, type IssueRef } from "../issue-id.js";

/**
 * `/backlog` (#3293, docs/issue-tracker.md#backlog) — every issue parked in the
 * backlog across the fleet, as one flat list the operator filters and sorts by any
 * shown field (the view lives in the page address, see `BacklogQuery`) rather than a
 * kanban: the backlog has no columns, only a way back to the board.
 *
 * The whole page is one form posting to `POST /backlog/promote`, so promoting
 * needs no JavaScript: a row's own **Promote** button submits `only=<item>`,
 * and **Promote selected** submits every ticked `item=<item>`. An item is
 * `<repo>#<ref>`, split on the last `#`.
 *
 * A native row's Returns cell sets, changes or clears the day it comes back
 * (`POST /issues/:id/backlog-until`). Forms cannot nest, so its date input
 * and buttons name one of the per-row forms rendered after the promote form
 * through the `form` attribute.
 */

export interface BacklogRow {
  repo: string;
  /** Every repo a native issue names, sorted; absent for forge issues. */
  repos?: string[];
  ref: IssueRef;
  title: string;
  labels: string[];
  /** Where the ref links to — the forge for a forge issue, `/issues/<id>` for a native one. */
  url: string;
  /** ISO timestamp, or `""` when the source does not say. */
  createdAt: string;
  /** The issue author's login. */
  author: string;
  /** ISO timestamp, or `""` when the source does not say. */
  updatedAt: string;
  /** The `YYYY-MM-DD` day a native issue returns from the backlog; absent or null when undated. */
  until?: string | null;
}

export const BACKLOG_SORTS = ["updated", "created", "repo", "title", "author", "returns"] as const;
export type BacklogSort = (typeof BACKLOG_SORTS)[number];
export type BacklogDir = "asc" | "desc";

const BACKLOG_SORT_LABELS: Record<BacklogSort, string> = {
  updated: "Date updated",
  created: "Date created",
  repo: "Repository",
  title: "Title",
  author: "Author",
  returns: "Returns",
};

/** The view a `/backlog?…` address names: filters, then the sort. */
export interface BacklogQuery {
  /** `""` means every repository. */
  repo: string;
  /** `""` means every label. */
  label: string;
  /** `""` means every author. */
  author: string;
  /** Case-insensitive substring of the title or ref; `""` means no filter. */
  q: string;
  sort: BacklogSort;
  dir: BacklogDir;
}

/** Reads a query from request parameters; unknown sort or direction values fall back to newest-updated first. */
export function parseBacklogQuery(get: (key: string) => string | undefined): BacklogQuery {
  const sort = get("sort");
  const dir = get("dir");
  return {
    repo: get("repo") ?? "",
    label: get("label") ?? "",
    author: get("author") ?? "",
    q: get("q") ?? "",
    sort: (BACKLOG_SORTS as readonly string[]).includes(sort ?? "") ? (sort as BacklogSort) : "updated",
    dir: dir === "asc" || dir === "desc" ? dir : "desc",
  };
}

/** The `/backlog?…` address for a view, carrying only the non-default keys. */
export function backlogHref(query: BacklogQuery): string {
  const params = new URLSearchParams();
  if (query.repo) params.set("repo", query.repo);
  if (query.label) params.set("label", query.label);
  if (query.author) params.set("author", query.author);
  if (query.q) params.set("q", query.q);
  if (query.sort !== "updated") params.set("sort", query.sort);
  if (query.dir !== "desc") params.set("dir", query.dir);
  const qs = params.toString();
  return `/backlog${qs ? `?${qs}` : ""}`;
}

export interface BacklogPageView {
  rows: BacklogRow[];
  /** Every repository Claws manages, for the Repository filter. */
  repoOptions: string[];
  /** The filters and sort the page address names. */
  query: BacklogQuery;
  /** How many repositories' fetches failed or came back truncated. */
  incompleteSources: number;
}

const BACKLOG_CSS = `
  .backlog-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .backlog-actions { margin-bottom: 0.75rem; }
  .backlog-actions .trigger-btn, .backlog-promote { min-height: 36px; }
  .backlog-chips { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .backlog-chips .backlog-also { font-size: 0.7rem; padding: 0.1rem 0.45rem; border: 1px dashed var(--border); border-radius: 12px; color: var(--text-secondary); }
  .backlog-chips .label-chip { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 12px; display: inline-block; }
  .backlog-select { width: 1rem; height: 1rem; }
  .backlog-warning { color: var(--warning); font-size: 0.8rem; margin-bottom: 0.5rem; }
  .backlog-until { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
  .backlog-until input[type=date] { min-height: 36px; box-sizing: border-box; background: var(--bg-secondary); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0 0.4rem; font-family: inherit; font-size: 0.85rem; }
  .backlog-until .trigger-btn { min-height: 36px; }
  @media (min-width: 768px) {
    .backlog-actions .trigger-btn, .backlog-promote, .backlog-until .trigger-btn, .backlog-until input[type=date] { min-height: 30px; }
  }
`;

/** The form value naming one issue: `<repo>#<ref>`. */
export function backlogItemValue(row: Pick<BacklogRow, "repo" | "ref">): string {
  return `${row.repo}#${row.ref}`;
}

/** The ids of a row's two out-of-table forms: set/change, and clear. */
function untilFormIds(r: Pick<BacklogRow, "ref">): { set: string; clear: string } {
  const key = String(r.ref).replace(/[^A-Za-z0-9_-]/g, "_");
  return { set: `backlog-until-${key}`, clear: `backlog-until-clear-${key}` };
}

/** A native row's Returns cell: the day, a date field and Save, plus Clear once a day is set. */
function untilCell(r: BacklogRow, today: string): string {
  if (!isClawsIssueId(r.ref)) return `<span class="issue-meta">—</span>`;
  const ids = untilFormIds(r);
  const ref = escapeHtml(shortIssueRef(r.ref));
  return `<div class="backlog-until">
          <input type="date" name="until" form="${ids.set}" value="${escapeHtml(r.until ?? "")}" min="${today}" required aria-label="Return date for #${ref}">
          <button class="trigger-btn" type="submit" form="${ids.set}">Save</button>${r.until ? `
          <button class="trigger-btn" type="submit" form="${ids.clear}" aria-label="Clear the return date of #${ref}">Clear</button>` : ""}
        </div>`;
}

/** The per-row date forms, outside the promote form; their fields live in the rows. */
function untilForms(rows: BacklogRow[], returnTo: string): string {
  return rows.filter((r) => isClawsIssueId(r.ref)).map((r) => {
    const ids = untilFormIds(r);
    const action = `/issues/${encodeURIComponent(String(r.ref))}/backlog-until`;
    const back = `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">`;
    return `<form id="${ids.set}" method="POST" action="${action}">${back}</form>${r.until ? `<form id="${ids.clear}" method="POST" action="${action}"><input type="hidden" name="until" value="">${back}</form>` : ""}`;
  }).join("");
}

function sortHeader(query: BacklogQuery, field: BacklogSort, label: string): string {
  const active = query.sort === field;
  const dir: BacklogDir = active ? (query.dir === "asc" ? "desc" : "asc") : "asc";
  const arrow = active ? (query.dir === "asc" ? " ▲" : " ▼") : "";
  return `<th><a href="${escapeHtml(backlogHref({ ...query, sort: field, dir }))}">${escapeHtml(label)}${arrow}</a></th>`;
}

function dateCell(label: string, iso: string): string {
  if (!iso) return `<td data-label="${label}"></td>`;
  return `<td data-label="${label}" title="${escapeHtml(iso)}">${escapeHtml(formatRelativeTime(iso))}</td>`;
}

function row(r: BacklogRow, today: string): string {
  const item = escapeHtml(backlogItemValue(r));
  const fullRef = String(r.ref);
  const shortRef = shortIssueRef(r.ref);
  const refTitle = shortRef !== fullRef ? ` title="${escapeHtml(fullRef)}"` : "";
  const also = (r.repos ?? []).filter((x) => x !== r.repo)
    .map((x) => `<span class="backlog-also" title="Also names ${escapeHtml(x)}">${escapeHtml(repoShortName(x))}</span>`).join("");
  const chips = also + r.labels.filter((l) => !isStateLabel(l)).map(specLabelChip).join("");
  const repoCell = r.repo
    ? `<span title="${escapeHtml(r.repo)}">${repoAvatar(r.repo)}${escapeHtml(repoShortName(r.repo))}</span>`
    : `<span class="issue-meta">unassigned</span>`;
  return `<tr>
        <td data-label="Select"><input type="checkbox" class="backlog-select" name="item" value="${item}" aria-label="Select #${escapeHtml(shortRef)}"></td>
        <td data-label="Issue"><a href="${escapeHtml(r.url)}"${refTitle}>#${escapeHtml(shortRef)}</a></td>
        <td data-label="Repository">${repoCell}</td>
        <td class="cell-title" data-label="Title"><a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a></td>
        <td data-label="Labels"><div class="backlog-chips">${chips}</div></td>
        ${dateCell("Created", r.createdAt)}
        ${dateCell("Updated", r.updatedAt)}
        <td data-label="Returns">${untilCell(r, today)}</td>
        <td class="cell-actions" data-label=""><button class="trigger-btn backlog-promote" type="submit" name="only" value="${item}">Promote</button></td>
      </tr>`;
}

/** Orders by one field; rows missing it sort last whichever the direction. */
function compareRows(a: BacklogRow, b: BacklogRow, sort: BacklogSort, dir: BacklogDir): number {
  const key = (r: BacklogRow): string => {
    switch (sort) {
      case "created": return r.createdAt;
      case "updated": return r.updatedAt;
      case "repo": return r.repo.toLowerCase();
      case "title": return r.title.toLowerCase();
      case "author": return r.author.toLowerCase();
      case "returns": return r.until ?? "";
    }
  };
  const ka = key(a);
  const kb = key(b);
  if (ka !== kb) {
    if (!ka) return 1;
    if (!kb) return -1;
    return dir === "asc" ? ka.localeCompare(kb) : kb.localeCompare(ka);
  }
  return (b.updatedAt || "").localeCompare(a.updatedAt || "");
}

/** `GET /backlog` — every backlog issue as one filterable, sortable list. */
export function buildBacklogPage(view: BacklogPageView, theme: Theme, navCounts?: NavCounts): string {
  const q = view.query;
  const repoOptions = filterOptions(view.repoOptions, q.repo);
  const labelOptions = filterOptions(view.rows.flatMap((r) => r.labels.filter((l) => !isStateLabel(l))), q.label);
  const authorOptions = filterOptions(view.rows.map((r) => r.author), q.author);
  const needle = q.q.toLowerCase();

  const visible = view.rows
    .filter((r) => (!q.repo || r.repo === q.repo || (r.repos?.includes(q.repo) ?? false))
      && (!q.label || r.labels.includes(q.label))
      && (!q.author || r.author === q.author)
      && (!needle || r.title.toLowerCase().includes(needle) || String(r.ref).toLowerCase().includes(needle)))
    .sort((a, b) => compareRows(a, b, q.sort, q.dir));

  const today = new Date().toISOString().slice(0, 10);
  const returnTo = backlogHref(q);

  const table = `
    <div class="table-scroll"><table class="data-cards data-cards-wide">
      <thead><tr><th></th><th>Issue</th>${sortHeader(q, "repo", "Repository")}${sortHeader(q, "title", "Title")}<th>Labels</th>${sortHeader(q, "created", "Created")}${sortHeader(q, "updated", "Updated")}${sortHeader(q, "returns", "Returns")}<th>Actions</th></tr></thead>
      <tbody>${visible.map((r) => row(r, today)).join("\n")}</tbody>
    </table></div>`;

  const sortOptions = BACKLOG_SORTS.map((s) => `<option value="${s}"${s === q.sort ? " selected" : ""}>${escapeHtml(BACKLOG_SORT_LABELS[s])}</option>`).join("");
  const dirOptions = `<option value="desc"${q.dir === "desc" ? " selected" : ""}>Descending</option><option value="asc"${q.dir === "asc" ? " selected" : ""}>Ascending</option>`;
  const boardHref = `/board${q.repo ? `?repo=${encodeURIComponent(q.repo)}` : ""}`;
  const body = `
  <div class="section">
    <h2>Backlog <span>${visible.length}</span></h2>
    <p class="issue-meta">Parked for later: off the board, and skipped by every Claws job until promoted back onto the board — or, for an issue parked until a date, until that date passes and Claws brings it back with its plan checked against the current state. <a href="${escapeHtml(boardHref)}">← Board</a></p>
    <form class="list-filters" method="GET" action="/backlog">
      ${filterSelect("repo", "Repository", repoOptions, q.repo, repoShortName)}
      ${filterSelect("label", "Label", labelOptions, q.label)}
      ${filterSelect("author", "Author", authorOptions, q.author)}
      <label class="form-field">Title contains
        <input class="form-input" type="text" name="q" value="${escapeHtml(q.q)}">
      </label>
      <label class="form-field">Sort
        <select class="form-select" name="sort">${sortOptions}</select>
      </label>
      <label class="form-field">Direction
        <select class="form-select" name="dir">${dirOptions}</select>
      </label>
      <div class="form-actions">
        <button class="trigger-btn" type="submit">Filter</button>
        <a class="trigger-btn" href="/backlog">Clear</a>
      </div>
    </form>
    ${view.incompleteSources
      ? `<div class="backlog-warning" role="status">${escapeHtml(
        `${view.incompleteSources} of the backlog's sources loaded incompletely — some issues are missing.`)}</div>`
      : ""}
    ${visible.length > 0 ? `
    <form method="POST" action="/backlog/promote">
      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
      <div class="backlog-actions">
        <button class="trigger-btn" type="submit" id="backlog-promote-selected">Promote selected</button>
      </div>
      ${table}
    </form>
    ${untilForms(visible, returnTo)}` : `<p class="queue-empty">${view.rows.length > 0 ? "No backlog issues match these filters" : "No backlog issues"}</p>`}
    <p class="refresh-note">Promoting moves an issue back onto the board: to Planning when it already has a plan or approved requirements, and to Drafting or Requirements review otherwise, where its requirements wait to be promoted. A plan written before it was backlogged is reused if the issue is unchanged, and re-planned if it is not.</p>
  </div>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <title>claws — Backlog</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${LIST_FILTERS_CSS}${BACKLOG_CSS}</style>
</head>
<body>
  ${buildPageHeader("Backlog", theme, { current: "/backlog", navCounts })}
  ${THEME_SCRIPT}
  ${body}
</body>
</html>`;
}
