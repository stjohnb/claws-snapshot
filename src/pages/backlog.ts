import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, specLabelChip, repoShortName } from "./layout.js";
import type { Theme } from "./layout.js";
import { isStateLabel } from "../issue-lifecycle.js";
import { shortIssueRef, type IssueRef } from "../issue-id.js";

/**
 * `/backlog` (#3293, docs/issue-tracker.md#backlog) — every issue parked in the
 * backlog across the fleet, as a list rather than a kanban: the backlog has no
 * columns, only a way back to the board.
 *
 * The whole page is one form posting to `POST /backlog/promote`, so promoting
 * needs no JavaScript: a row's own **Promote** button submits `only=<item>`,
 * and **Promote selected** submits every ticked `item=<item>`. An item is
 * `<repo>#<ref>`, split on the last `#`.
 */

export interface BacklogRow {
  repo: string;
  ref: IssueRef;
  title: string;
  labels: string[];
  /** Where the ref links to — the forge for a forge issue, `/issues/<id>` for a native one. */
  url: string;
  /** ISO timestamp, or `""` when the source does not say. */
  updatedAt: string;
}

export interface BacklogPageView {
  rows: BacklogRow[];
  /** Every repository Claws manages, for the Repository filter. */
  repoOptions: string[];
  /** `?repo=` — `""` means every repository. */
  repoFilter: string;
  /** `?label=` — `""` means every label. */
  labelFilter: string;
  /** How many repositories' fetches failed or came back truncated. */
  incompleteSources: number;
}

const BACKLOG_CSS = `
  .backlog-filters { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-end; margin-bottom: 1rem; }
  .backlog-filters .form-field { flex: 1 1 12rem; }
  .backlog-filters .form-actions, .backlog-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .backlog-actions { margin-bottom: 0.75rem; }
  .backlog-actions .trigger-btn, .backlog-promote { min-height: 36px; }
  .backlog-repo { font-family: var(--font-display); font-size: 0.85rem; margin: 1rem 0 0.4rem; }
  .backlog-chips { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .backlog-chips .label-chip { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 12px; display: inline-block; }
  .backlog-select { width: 1rem; height: 1rem; }
  .backlog-warning { color: var(--warning); font-size: 0.8rem; margin-bottom: 0.5rem; }
  @media (min-width: 768px) {
    .backlog-actions .trigger-btn, .backlog-promote { min-height: 30px; }
  }
`;

/** The form value naming one issue: `<repo>#<ref>`. */
export function backlogItemValue(row: Pick<BacklogRow, "repo" | "ref">): string {
  return `${row.repo}#${row.ref}`;
}

function filterSelect(name: string, label: string, options: string[], selected: string, optionText: (v: string) => string = (v) => v): string {
  const opts = options
    .map((v) => `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>${escapeHtml(optionText(v))}</option>`)
    .join("");
  return `<label class="form-field">${escapeHtml(label)}
      <select class="form-select" name="${escapeHtml(name)}">
        <option value=""${selected === "" ? " selected" : ""}>All</option>${opts}
      </select>
    </label>`;
}

function filterOptions(values: string[], active: string): string[] {
  const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (active && !options.includes(active)) options.push(active);
  return options;
}

function row(r: BacklogRow): string {
  const item = escapeHtml(backlogItemValue(r));
  const fullRef = String(r.ref);
  const shortRef = shortIssueRef(r.ref);
  const refTitle = shortRef !== fullRef ? ` title="${escapeHtml(fullRef)}"` : "";
  const chips = r.labels.filter((l) => !isStateLabel(l)).map(specLabelChip).join("");
  return `<tr>
        <td data-label="Select"><input type="checkbox" class="backlog-select" name="item" value="${item}" aria-label="Select #${escapeHtml(shortRef)}"></td>
        <td data-label="Issue"><a href="${escapeHtml(r.url)}"${refTitle}>#${escapeHtml(shortRef)}</a></td>
        <td class="cell-title" data-label="Title"><a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a></td>
        <td data-label="Labels"><div class="backlog-chips">${chips}</div></td>
        <td data-label="Updated">${escapeHtml(r.updatedAt ? formatRelativeTime(r.updatedAt) : "")}</td>
        <td class="cell-actions" data-label=""><button class="trigger-btn backlog-promote" type="submit" name="only" value="${item}">Promote</button></td>
      </tr>`;
}

/** `GET /backlog` — every backlog issue, grouped by repository, newest first. */
export function buildBacklogPage(view: BacklogPageView, theme: Theme): string {
  const repoOptions = filterOptions(view.repoOptions, view.repoFilter);
  const labelOptions = filterOptions(view.rows.flatMap((r) => r.labels.filter((l) => !isStateLabel(l))), view.labelFilter);

  const visible = view.rows
    .filter((r) => (!view.repoFilter || r.repo === view.repoFilter)
      && (!view.labelFilter || r.labels.includes(view.labelFilter)))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  // Grouped by repository in name order; within a group the newest-first
  // order above holds.
  const groups = new Map<string, BacklogRow[]>();
  for (const r of visible) groups.set(r.repo, [...(groups.get(r.repo) ?? []), r]);
  const tables = [...groups.keys()].sort((a, b) => a.localeCompare(b)).map((repo) => {
    const rows = groups.get(repo)!;
    const repoTitle = repo ? ` title="${escapeHtml(repo)}"` : "";
    return `
    <h3 class="backlog-repo"${repoTitle}>${escapeHtml(repo ? repoShortName(repo) : "unassigned")} <span>${rows.length}</span></h3>
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th></th><th>Issue</th><th>Title</th><th>Labels</th><th>Updated</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(row).join("\n")}</tbody>
    </table></div>`;
  }).join("\n");

  const boardHref = `/board${view.repoFilter ? `?repo=${encodeURIComponent(view.repoFilter)}` : ""}`;
  const body = `
  <div class="section">
    <h2>Backlog <span>${visible.length}</span></h2>
    <p class="issue-meta">Parked for later: off the board, and skipped by every Claws job until promoted to Ideas or Planning. <a href="${escapeHtml(boardHref)}">← Board</a></p>
    <form class="backlog-filters" method="GET" action="/backlog">
      ${filterSelect("repo", "Repository", repoOptions, view.repoFilter, repoShortName)}
      ${filterSelect("label", "Label", labelOptions, view.labelFilter)}
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
      <input type="hidden" name="repo" value="${escapeHtml(view.repoFilter)}">
      <input type="hidden" name="label" value="${escapeHtml(view.labelFilter)}">
      <div class="backlog-actions">
        <button class="trigger-btn" type="submit" id="backlog-promote-selected">Promote selected</button>
      </div>
      ${tables}
    </form>` : `<p class="queue-empty">No backlog issues</p>`}
    <p class="refresh-note">Promoting moves an issue back onto the board: to Planning when it already has a plan or approved requirements, and to Ideas otherwise, where its requirements wait to be promoted. A plan written before it was backlogged is reused if the issue is unchanged, and re-planned if it is not.</p>
  </div>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <title>claws — Backlog</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${BACKLOG_CSS}</style>
</head>
<body>
  ${buildPageHeader("Backlog", theme)}
  ${THEME_SCRIPT}
  ${body}
</body>
</html>`;
}
