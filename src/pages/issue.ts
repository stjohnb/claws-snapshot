import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, specLabelChip, NO_REPO_WARNING, repoShortName } from "./layout.js";
import type { Theme } from "./layout.js";
import { LABEL_SPECS, LABELS, issueUrl, shortIssueRef } from "../config.js";
import { isClawsComment } from "../github.js";
import { primaryRepo } from "../claws-issues.js";
import { repoUrl } from "./repo.js";
import { ISSUE_EDIT_SCRIPT } from "../resources/issue-edit.generated.js";
import { ISSUE_ATTACHMENTS_SCRIPT } from "../resources/issue-attachments.generated.js";
import { MODEL_TIERS } from "../model-selector.js";
import { MODEL_PLAN_PHASES, MODEL_PLAN_PHASE_LABELS, MODEL_PLAN_PROVIDERS, type ModelPlanView } from "../model-plan.js";
import { BACKLOG_DESTINATION, BOARD_COLUMNS, backlogRefusal, columnAfterMove, columnFor, transitionFor, type BoardPr } from "../issue-board.js";
import { ISSUE_LIFECYCLES, isStateLabel, type IssueLifecycle } from "../issue-lifecycle.js";
import { LINK_KINDS, LINK_KIND_LABELS, type IssueLinkView } from "../issue-links.js";

/** One comment on a native issue, as the page needs it. */
export interface IssueCommentView {
  id: string;
  login: string;
  body: string;
  /** Pre-rendered by the store — the page never re-renders markdown itself. */
  bodyHtml: string;
  createdAt: string;
}

/** One file attached to a native issue (#3289). */
export interface IssueAttachmentView {
  id: string;
  name: string;
  /** Site-relative serve URL. */
  url: string;
  size: number;
  contentType: string;
  /** An allowlisted image type, shown as a thumbnail. */
  isImage: boolean;
}

/** One version of a native issue's plan, split into its `###` sections and rendered. */
export interface PlanView {
  version: number;
  createdAt: string;
  /** The plan's `*Models used: …*` footer, when it has one. */
  attribution: string | null;
  sections: { title: string; html: string }[];
}

/** One version of an issue's requirements record, its four parts rendered. */
export interface RequirementsView {
  version: number;
  createdAt: string;
  title: string;
  kind: "bug" | "feature";
  /** Context, Requirement, Acceptance criteria and Out of scope, in that order. */
  sections: { title: string; html: string }[];
}

/** Who approved which requirements version, and when; null until promotion. */
export interface RequirementsApprovalView {
  version: number | null;
  by: string;
  at: string;
}

/**
 * The collapsed plan block a multi-issue page (board card, `/issues` row)
 * shows: the section count, the Requirement section rendered, and a link to
 * the full plan on the issue page.
 */
export interface PlanPreview {
  /** `N sections`. */
  summary: string;
  requirementHtml: string;
  /** `/issues/<id>#plan`. */
  url: string;
}

/** Everything `/issues/:id` renders. */
export interface IssuePageView {
  id: string;
  title: string;
  body: string;
  /** The body, rendered by the store. */
  bodyHtml: string;
  authorLogin: string;
  state: string;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  repos: string[];
  labels: string[];
  comments: IssueCommentView[];
  /** Every managed repo, for the repo-association form. */
  allRepos: string[];
  /** One row per pipeline phase (docs/model-selection.md). */
  modelPlan: ModelPlanView[];
  /** Files attached to the issue or its comments, oldest first. */
  attachments: IssueAttachmentView[];
  /** Links to other tracker issues, from this issue's side, oldest first. */
  links: IssueLinkView[];
  /** The latest plan version, or null before the planner has run. */
  plan: PlanView | null;
  /** Every earlier plan version, oldest first. */
  previousPlans: PlanView[];
  /** The latest requirements version, or null before the requirements writer has run. Absent reads as null. */
  requirements?: RequirementsView | null;
  /** Every earlier requirements version, oldest first. */
  previousRequirements?: RequirementsView[];
  /** The approved requirements version, or null when not yet approved. */
  requirementsApproval?: RequirementsApprovalView | null;
  /** The stored lifecycle, which tells Ideas from Planning. Absent reads as the labels' column. */
  lifecycle?: IssueLifecycle;
  /** Where the issue came from (`dashboard`, `session`, `agent`, …). */
  source?: string;
  /** Whether its first requirements version promotes it without a human, per `shouldAutoPromote`. */
  autoPromotes?: boolean;
  /** The title the issue was filed under, once promotion renamed it. */
  filedTitle?: string | null;
  /**
   * The issue's running implementer and open PR rows (`issue-flight.ts`), which
   * decide its derived column and which Status buttons can land. Absent reads
   * as not in flight.
   */
  flight?: { implementing: boolean; openPrs: readonly BoardPr[] };
}

const ISSUE_CSS = `
  .issue-head { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 1rem; }
  .issue-title { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 1.15rem; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
  .issue-title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; }
  .icon-btn { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text-secondary); cursor: pointer; flex: none; }
  .icon-btn:hover { border-color: var(--accent); color: var(--text); }
  .icon-btn svg { width: 16px; height: 16px; }
  .icon-status { font-size: 0.8rem; color: var(--text-secondary); min-height: 1.2rem; }
  .icon-status-error { color: var(--danger); }
  .issue-title-form input[type=text] { width: 100%; box-sizing: border-box; font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 1.15rem; font-weight: 600; background: var(--bg-secondary); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem; }
  .issue-title-form .form-actions { margin-top: 0.5rem; }
  .issue-meta { color: var(--text-secondary); font-size: 0.85rem; overflow-wrap: anywhere; }
  .state-pill { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .state-open { background: var(--success); color: var(--bg); }
  .state-closed { background: var(--text-subtle); color: var(--bg); }
  .state-column { background: var(--accent); color: var(--bg); }
  .chip-row { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .repo-chip { display: inline-block; padding: 0.15rem 0.6rem; border: 1px solid var(--border); border-radius: 12px; font-size: 0.75rem; color: var(--text-secondary); text-decoration: none; }
  .label-chip { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
  .issue-card { border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; margin-bottom: 0.75rem; background: var(--bg-secondary); }
  .issue-card.claws-comment { border-left: 3px solid var(--accent); }
  .comment-head { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 0.5rem; }
  .comment-author { font-family: "IBM Plex Mono", ui-monospace, monospace; color: var(--text); font-weight: 600; }
  .claws-badge { color: var(--accent); font-weight: 600; }
  .markdown { overflow-wrap: anywhere; }
  .markdown pre { overflow-x: auto; -webkit-overflow-scrolling: touch; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0.6rem; }
  .markdown code { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.85em; }
  .markdown img { max-width: 100%; height: auto; }
  .markdown table { border-collapse: collapse; }
  .markdown th, .markdown td { border: 1px solid var(--border); padding: 0.25rem 0.5rem; }
  .issue-form { border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; margin-bottom: 0.75rem; }
  .issue-form textarea, .issue-form input[type=text] { width: 100%; box-sizing: border-box; font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif; font-size: 0.9rem; background: var(--bg-secondary); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem; }
  .issue-form textarea { font-family: "IBM Plex Mono", ui-monospace, monospace; min-height: 8rem; resize: vertical; }
  .issue-form > .issue-meta { margin-bottom: 0.5rem; }
  .check-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.6rem; }
  .check-grid label { display: inline-flex; align-items: center; gap: 0.4rem; min-height: 44px; padding: 0.4rem 0.8rem; flex: 1 1 calc(50% - 0.2rem); box-sizing: border-box; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); cursor: pointer; transition: border-color 0.2s; }
  .check-grid label:hover { border-color: var(--border-hover); }
  .check-grid label:has(input:checked) { border-color: var(--accent); }
  .check-grid input[type=checkbox] { margin: 0; width: 1.15rem; height: 1.15rem; flex: none; }
  .check-text { overflow-wrap: anywhere; }
  .issue-form .trigger-btn { min-height: 40px; }
  .form-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .issue-form .form-actions { margin-top: 0.6rem; }
  .autosave-status, .attach-status { min-height: 1.2rem; font-size: 0.8rem; color: var(--text-secondary); align-self: center; }
  .autosave-status-error, .attach-status-error { color: var(--danger); }
  .issue-form h3 { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); margin: 0.9rem 0 0.4rem; }
  .model-plan select { min-height: 30px; background: var(--bg-secondary); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.2rem 0.4rem; font-family: inherit; font-size: 0.8rem; }
  .model-plan .model-id { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.8rem; overflow-wrap: anywhere; }
  .source-badge { display: inline-block; padding: 0.1rem 0.5rem; border: 1px solid var(--border); border-radius: 12px; font-size: 0.7rem; color: var(--text-secondary); white-space: nowrap; }
  .attach-thumb { max-width: 4rem; max-height: 3rem; vertical-align: middle; border: 1px solid var(--border); border-radius: 4px; }
  .link-add select { min-height: 30px; background: var(--bg-secondary); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.2rem 0.4rem; font-family: inherit; font-size: 0.9rem; }
  .link-add input[type=text] { flex: 1 1 14rem; width: auto; }
  .attach-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.4rem; }
  .attach-dropzone.drag-over { outline: 2px dashed var(--accent); outline-offset: -4px; }
  .issue-section { margin-bottom: 0.5rem; }
  .issue-section > summary, .plan-section > summary { list-style: none; cursor: pointer; display: flex; gap: 0.4rem; align-items: baseline; }
  .issue-section > summary { padding: 0.5rem 0; min-height: 44px; box-sizing: border-box; }
  .issue-section > summary::-webkit-details-marker, .plan-section > summary::-webkit-details-marker { display: none; }
  .issue-section > summary > h2 { margin: 0; margin-right: auto; }
  .issue-section > summary::after, .plan-section > summary::after { content: "▾"; color: var(--text-secondary); }
  .issue-section[open] > summary::after, .plan-section[open] > summary::after { content: "▴"; }
  .plan-section { border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); margin-bottom: 0.5rem; }
  .plan-section > summary { padding: 0.5rem 0.75rem; font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.85rem; font-weight: 600; }
  .plan-section > summary > span:first-child { margin-right: auto; overflow-wrap: anywhere; }
  .plan-section > .markdown, .plan-section > .plan-version { padding: 0 0.75rem 0.75rem; }
  .plan-section .plan-section { background: var(--bg); }
  .source-badge.source-explicit { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  @media (min-width: 768px) {
    .issue-title { font-size: 1.5rem; }
    .issue-title-form input[type=text] { font-size: 1.5rem; }
    .check-grid label { min-height: 32px; padding: 0.2rem 0.6rem; flex: 0 1 auto; }
    .issue-form .trigger-btn { min-height: 30px; }
  }
`;

/** Two overlapping rounded rectangles — the copy-URL icon button's glyph. */
const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

function pageShell(title: string, headerTitle: string, theme: Theme, body: string): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <title>claws — ${escapeHtml(title)}</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${ISSUE_CSS}</style>
</head>
<body>
  ${buildPageHeader(headerTitle, theme)}
  ${THEME_SCRIPT}
  ${body}
</body>
</html>`;
}

function repoChip(fullName: string): string {
  const [owner, name] = fullName.split("/");
  const short = escapeHtml(repoShortName(fullName));
  if (!owner || !name) return `<span class="repo-chip">${short}</span>`;
  return `<a class="repo-chip" href="${repoUrl(owner, name)}" title="${escapeHtml(fullName)}">${short}</a>`;
}

function checkboxList(name: string, options: string[], checked: Set<string>, render: (v: string) => string, titleFor?: (v: string) => string): string {
  if (options.length === 0) return `<p class="queue-empty">None available</p>`;
  return `<div class="check-grid">${options.map((value) => `
      <label${titleFor ? ` title="${escapeHtml(titleFor(value))}"` : ""}><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${checked.has(value) ? " checked" : ""}> <span class="check-text">${render(value)}</span></label>`).join("")}</div>`;
}

/** Repositories in alphabetical order — `listRepos()` groups by forge and owner. */
function sortedRepos(repos: string[]): string[] {
  return [...repos].sort((a, b) => a.localeCompare(b));
}

/** The repo checkbox's visible text: the short name. The checkbox `value` and its `title` keep the full name. */
function repoOptionText(fullName: string): string {
  return escapeHtml(repoShortName(fullName));
}

/**
 * One grid select. `selected` is the operator's explicit value only; a planner
 * suggestion is named in the blank option's text, so leaving it blank keeps the
 * phase on the suggestion rather than promoting it to an explicit choice.
 */
function planSelect(name: string, options: readonly string[], selected: string | null, suggested: string | null, label: string, disabled: boolean): string {
  const opts = options
    .map((v) => `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>${escapeHtml(v)}</option>`)
    .join("");
  const blank = suggested ? `default (suggested: ${escapeHtml(suggested)})` : "default";
  return `<select name="${escapeHtml(name)}" aria-label="${escapeHtml(label)}"${disabled ? " disabled" : ""}><option value=""${selected ? "" : " selected"}>${blank}</option>${opts}</select>`;
}

const SOURCE_TEXT: Readonly<Record<ModelPlanView["source"], string>> = {
  "explicit": "explicit",
  "suggested": "suggested by planner",
  "plan-prose": "plan text",
  "label": "label",
  "default": "default",
};

/**
 * The phase × (provider, tier) grid. With `rows` it is the issue page's view:
 * the explicit cell fills each select, a planner suggestion is named in the
 * blank option, and the resolved model and the source of
 * the winning value sit beside it. Without, it is the New Issue form's empty
 * grid. Field names are `provider_<phase>` and `tier_<phase>`, blank = default.
 */
function modelPlanTable(rows: ModelPlanView[] | null, disabled: boolean): string {
  const body = MODEL_PLAN_PHASES.map((phase) => {
    const row = rows?.find((r) => r.phase === phase);
    const phaseLabel = MODEL_PLAN_PHASE_LABELS[phase];
    const resolved = row
      ? `<td data-label="Model"><span class="model-id">${escapeHtml(row.resolvedModel ?? [row.provider ?? "weighted draw", row.tier ?? "set by agent"].join(" / "))}</span></td>
        <td data-label="Source"><span class="source-badge source-${escapeHtml(row.source)}">${escapeHtml(SOURCE_TEXT[row.source])}</span></td>`
      : "";
    return `<tr>
        <td class="cell-title" data-label="Phase">${escapeHtml(phaseLabel)}</td>
        <td data-label="Provider">${planSelect(`provider_${phase}`, MODEL_PLAN_PROVIDERS, row?.cellProvider ?? null, row?.suggestedProvider ?? null, `${phaseLabel} provider`, disabled)}</td>
        <td data-label="Tier">${planSelect(`tier_${phase}`, MODEL_TIERS, row?.cellTier ?? null, row?.suggestedTier ?? null, `${phaseLabel} tier`, disabled)}</td>
        ${resolved}
      </tr>`;
  }).join("\n");
  const head = rows ? "<th>Phase</th><th>Provider</th><th>Tier</th><th>Model</th><th>Source</th>" : "<th>Phase</th><th>Provider</th><th>Tier</th>";
  return `<div class="table-scroll model-plan"><table class="data-cards">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

/** `12 KB`, `3.4 MB` — the Attachments table's size column. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const ATTACH_HINT = "Paste or drop files into the text box to upload them and insert a link. Files over 10 MB upload by streaming, up to 1 GB.";

/**
 * The "Attach files" control under a body or comment textarea. Hidden until
 * the client script runs — it has no `name`, so without JS the surrounding
 * urlencoded form would silently drop the files.
 */
function attachRow(): string {
  return `<div class="attach-row" data-attach-row hidden>
        <label class="trigger-btn">Attach files<input type="file" multiple hidden data-attach-input></label>
        <span class="attach-status" data-attach-status role="status" aria-live="polite"></span>
      </div>`;
}

/** The issue page's Attachments list and its no-JS upload form. */
function attachmentsSection(view: IssuePageView): string {
  const base = `/issues/${escapeHtml(view.id)}/attachments`;
  const rows = view.attachments.map((a) => `
        <tr data-attachment-row>
          <td class="cell-title" data-label="File">${a.isImage ? `<img class="attach-thumb" src="${escapeHtml(a.url)}" alt=""> ` : ""}<a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a></td>
          <td data-label="Size">${escapeHtml(formatBytes(a.size))}</td>
          <td data-label="Type">${escapeHtml(a.contentType)}</td>
          <td data-label="">
            <form method="POST" action="${base}/${escapeHtml(a.id)}/delete" data-attachment-delete>
              <button class="trigger-btn" type="submit">Delete</button>
            </form>
          </td>
        </tr>`).join("");
  const table = view.attachments.length > 0
    ? `<div class="table-scroll"><table class="data-cards">
        <thead><tr><th>File</th><th>Size</th><th>Type</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<p class="queue-empty">No attachments</p>`;
  return sectionBlock("Attachments", `
    <div class="issue-form attach-dropzone" data-attach-dropzone>
      ${table}
      <form method="POST" action="${base}?feedback=1" enctype="multipart/form-data" data-attach-form>
        <p class="issue-meta">Images, archives and other files. Drop files here or pick them and they upload straight away. Without JavaScript, one upload is limited to 10 MB in total.</p>
        <div class="form-actions">
          <input type="file" name="file" multiple required>
          <button class="trigger-btn" type="submit" data-attach-submit>Attach files</button>
          <span class="attach-status" data-attach-status role="status" aria-live="polite"></span>
        </div>
      </form>
    </div>`, true, view.attachments.length);
}

/** A linked issue's lifecycle as its board column title — Backlog is not a column. */
function lifecycleTitle(lifecycle: IssueLifecycle): string {
  return BOARD_COLUMNS.find((col) => col.id === lifecycle)?.title ?? "Backlog";
}

const LINK_HINT = "A Claws id (clw_…), owner/repo#123 for a forge issue Claws tracks, or #123 in this issue's primary repository.";

/**
 * The issue page's Links section (docs/issue-tracker.md#links): one table per
 * relationship, then the add form. Plain forms — no client script.
 */
function linksSection(view: IssuePageView): string {
  const base = `/issues/${escapeHtml(view.id)}/links`;
  const groups = LINK_KINDS.map((kind) => {
    const links = view.links.filter((l) => l.kind === kind);
    if (links.length === 0) return "";
    const rows = links.map((l) => {
      const open = l.otherState === "open";
      const state = open
        ? `<span class="state-pill state-open">Open</span>`
        : `<span class="state-pill state-closed">Closed${l.otherStateReason ? ` · ${escapeHtml(l.otherStateReason.replace("_", " "))}` : ""}</span>`;
      return `
        <tr>
          <td class="cell-title" data-label="Issue"><a href="/issues/${escapeHtml(l.otherId)}">${escapeHtml(l.otherTitle)}</a> <span style="color:var(--text-subtle)">#${escapeHtml(l.otherId)}</span></td>
          <td data-label="State">${state}</td>
          <td data-label="Status">${open ? `<span class="source-badge">${escapeHtml(lifecycleTitle(l.otherLifecycle))}</span>` : ""}${l.releasedAt ? ` <span class="source-badge" title="This dependency has cleared; Claws will not unpark on it again">released</span>` : ""}</td>
          <td data-label="">
            <form method="POST" action="${base}/${escapeHtml(l.id)}/delete">
              <button class="trigger-btn" type="submit">Remove</button>
            </form>
          </td>
        </tr>`;
    }).join("");
    return `
      <h3>${escapeHtml(LINK_KIND_LABELS[kind])}</h3>
      <div class="table-scroll"><table class="data-cards">
        <thead><tr><th>Issue</th><th>State</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }).join("");
  return sectionBlock("Links", `
    <div class="issue-form">
      ${groups || `<p class="queue-empty">No links</p>`}
      <form class="link-add" method="POST" action="${base}">
        <h3>Add link</h3>
        <p class="issue-meta">This issue … the other one. A dependency on an open issue parks this one as Blocked until it closes. ${escapeHtml(LINK_HINT)}</p>
        <div class="form-actions">
          <select name="kind" aria-label="Relationship">
            ${LINK_KINDS.map((kind) => `<option value="${kind}">${escapeHtml(LINK_KIND_LABELS[kind])}</option>`).join("")}
          </select>
          <input type="text" name="issue" required placeholder="clw_… or owner/repo#123" aria-label="Other issue">
          <button class="trigger-btn" type="submit">Add link</button>
        </div>
      </form>
    </div>`, view.links.length > 0, view.links.length, "links");
}

const MODEL_PLAN_NOTE = "Blank means default: fresh planning runs on claude/fable, plan refinement on claude/opus, and every later phase on whatever its agent chooses. Planner suggestions naming fable outside planning run on opus; only a choice made here can select fable for a later phase.";

/** `GET /issues/new` — title, body, repo association and starting labels. */
export function buildNewIssuePage(allRepos: string[], theme: Theme): string {
  const sortedAllRepos = sortedRepos(allRepos);
  const body = `
  <div class="section">
    <h2>New issue</h2>
    <form class="issue-form" method="POST" action="/issues">
      <label class="form-field" style="width:100%">
        Title
        <input type="text" name="title" required maxlength="300" placeholder="What needs doing?">
      </label>
      <label class="form-field" style="width:100%; margin-top:0.6rem;">
        Body (markdown)
        <textarea name="body" rows="12" placeholder="Context, acceptance criteria, links…" data-attach-target="new"></textarea>
      </label>
      ${attachRow()}
      <div data-attachment-inputs hidden></div>
      <p class="issue-meta" data-attach-row hidden>${escapeHtml(ATTACH_HINT)}</p>
      <h3>Repositories</h3>
      <p class="issue-meta">An issue may name several repositories — its plan can then open PRs in any of them — or none until it is ready to plan. ${escapeHtml(NO_REPO_WARNING)}.</p>
      ${checkboxList("repo", sortedAllRepos, new Set(), repoOptionText, (r) => r)}
      <div class="check-grid">
      <label><input type="checkbox" name="backlog" value="1"> File to backlog</label></div>
      <p class="issue-meta">Park it for later: off the board, and skipped by every Claws job until it is promoted to Ideas or Planning from the backlog.</p>
      <h3>Requirements</h3>
      <p class="issue-meta">Claws writes a requirements record for the issue before anyone plans it. Promoting the record moves the issue from Ideas to Planning.</p>
      <div class="check-grid">
      <label><input type="radio" name="autoPromote" value="" checked> Follow the repository default</label>
      <label><input type="radio" name="autoPromote" value="wait"> Wait for my review before planning</label>
      <label><input type="radio" name="autoPromote" value="auto"> Promote automatically once written</label></div>
      <div class="form-actions"><button class="trigger-btn" type="submit">Create issue</button></div>
      <h3>Labels</h3>
      <p class="issue-meta">${escapeHtml(LABEL_FORM_HINT)}</p>
      ${checkboxList("label", offeredLabels(Object.keys(LABEL_SPECS)), new Set(), specLabelChip)}
      <h3>Links</h3>
      <p class="issue-meta">Comma-separated. ${escapeHtml(LINK_HINT)} Depending on an open issue files this one as Blocked until it closes.</p>
      ${LINK_KINDS.map((kind) => `<label class="form-field" style="width:100%; margin-top:0.4rem;">
        ${escapeHtml(LINK_KIND_LABELS[kind])}
        <input type="text" name="${kind}" placeholder="clw_… or owner/repo#123">
      </label>`).join("\n      ")}
      <h3>Model plan</h3>
      <p class="issue-meta">${escapeHtml(MODEL_PLAN_NOTE)}</p>
      ${modelPlanTable(null, false)}
      <div class="form-actions">
        <button class="trigger-btn" type="submit">Create issue</button>
        <a class="trigger-btn" href="/issues">Cancel</a>
      </div>
    </form>
  </div>`;
  return pageShell("New issue", "New issue", theme, `${body}
  ${ISSUE_ATTACHMENTS_SCRIPT}`);
}

/**
 * The labels offered as checkboxes and shown as chips. The state labels are
 * left out: they read off the issue's lifecycle field, which the Status
 * section (and the board) sets.
 */
function plainLabels(labels: readonly string[]): string[] {
  return labels.filter((l) => !isStateLabel(l));
}

/** The labels offered as checkboxes: `plainLabels` minus Claws Staging, which is opt-in only via the forge. */
export function offeredLabels(labels: readonly string[]): string[] {
  return plainLabels(labels).filter((l) => l !== LABELS.clawsStaging);
}

const LABEL_FORM_HINT = "Lifecycle state (Ideas, Planning, Awaiting plan review, Approved, Blocked, Backlog) is set under Status or by moving the issue on the board.";

/** The Status buttons, by target state. */
const STATUS_ACTIONS: Record<IssueLifecycle, string> = {
  "approved": "Mark refined",
  "blocked": "Mark blocked",
  "awaiting-plan-review": "Move to Awaiting plan review",
  "planning": "Send back to Planning",
  "ideas": "Move to Ideas",
  "backlog": "Send to backlog",
};

/** A Status button's text: out of Ideas, Planning is the promotion. */
function statusAction(to: IssueLifecycle, current: string): string {
  return to === "planning" && current === "ideas" ? "Promote to Planning" : STATUS_ACTIONS[to];
}

/**
 * The issue's board column as a pill, and one button per state it can move to.
 *
 * A target is offered only when `POST /issues/:id/column` would accept it —
 * the same `columnAfterMove` check — so an issue with an open PR is never
 * offered Ideas, Planning or Awaiting plan review — nor Backlog, which `backlogRefusal`
 * turns away while the PR is open. A closed or unassigned issue gets no
 * buttons: the route refuses both, and the no-repository banner already says
 * why for the second.
 *
 * **Refine & Automerge** rides beside Mark refined whenever Approved is
 * offered and the issue does not already hold `Automerge` (in which case Mark
 * refined alone gets there): it posts the same `column=approved`, plus
 * `automerge=1`, so the route applies the label in the same write.
 */
function statusSection(view: IssuePageView, isOpen: boolean): string {
  const unassigned = view.repos.length === 0;
  const flight = { implementing: view.flight?.implementing, openPrs: view.flight?.openPrs };
  const current = columnFor({ labels: view.labels, closed: !isOpen, unassigned, lifecycle: view.lifecycle, ...flight });
  const title = BOARD_COLUMNS.find((col) => col.id === current)?.title ?? "Backlog";
  const targets = isOpen && !unassigned
    ? ISSUE_LIFECYCLES.filter((to) => to !== current
      && !(to === BACKLOG_DESTINATION && backlogRefusal(flight))
      && columnAfterMove(transitionFor(to)!, { labels: view.labels, closed: false, unassigned: false, lifecycle: view.lifecycle, ...flight }) === to)
    : [];
  const automergeOffered = targets.includes("approved") && !view.labels.includes(LABELS.automerge);
  const buttons = targets.map((to) => {
    const form = `
        <form method="POST" action="/issues/${escapeHtml(view.id)}/column">
          <input type="hidden" name="column" value="${escapeHtml(to)}">
          <button class="trigger-btn" type="submit">${escapeHtml(statusAction(to, current))}</button>
        </form>`;
    if (to !== "approved" || !automergeOffered) return form;
    return `${form}
        <form method="POST" action="/issues/${escapeHtml(view.id)}/column">
          <input type="hidden" name="column" value="approved">
          <input type="hidden" name="automerge" value="1">
          <button class="trigger-btn" type="submit">Refine &amp; Automerge</button>
        </form>`;
  }).join("");
  return sectionBlock("Status", `
    <div class="issue-form">
      <p class="issue-meta"><span class="state-pill state-column">${escapeHtml(title)}</span></p>
      ${buttons ? `<div class="form-actions">${buttons}
      </div>` : ""}
    </div>`, true);
}

/**
 * One collapsible block of the issue page: a `<details>` whose summary is the
 * section's `h2`, with an optional count beside the title as before.
 */
function sectionBlock(title: string, body: string, open: boolean, count?: number, id?: string): string {
  return `
    <details class="issue-section"${id ? ` id="${escapeHtml(id)}"` : ""}${open ? " open" : ""}>
      <summary><h2>${escapeHtml(title)}${count === undefined ? "" : ` <span>${count}</span>`}</h2></summary>
      ${body}
    </details>`;
}

/** Plan sections open by default on the Current plan block; the rest start closed. */
const OPEN_PLAN_SECTIONS: ReadonlySet<string> = new Set(["requirement", "requirements", "decisions"]);

/** A plan's sections, each its own `<details class="plan-section">`. */
function planSections(plan: PlanView, openDefaults: boolean): string {
  return plan.sections.map((s) => `
      <details class="plan-section"${openDefaults && OPEN_PLAN_SECTIONS.has(s.title.toLowerCase()) ? " open" : ""}>
        <summary><span>${escapeHtml(s.title)}</span></summary>
        <div class="markdown">${s.html}</div>
      </details>`).join("");
}

function planMeta(plan: PlanView): string {
  return `v${plan.version} · ${formatRelativeTime(plan.createdAt)}`;
}

/** The Current plan block: the latest version's sections, Requirement and Decisions open. */
function currentPlanSection(view: IssuePageView): string {
  const plan = view.plan;
  const body = plan
    ? `<p class="issue-meta">${escapeHtml(planMeta(plan))}${plan.attribution ? ` · ${escapeHtml(plan.attribution.replace(/^\*|\*$/g, ""))}` : ""}</p>
      ${planSections(plan, true)}`
    : `<p class="queue-empty">No plan yet</p>`;
  return sectionBlock("Current plan", body, true, undefined, "plan");
}

function requirementsMeta(req: RequirementsView): string {
  return `v${req.version} · ${formatRelativeTime(req.createdAt)}`;
}

/** A requirements version's title, kind chip and four parts, each part its own `<details>`. */
function requirementsBody(req: RequirementsView, open: boolean): string {
  return `<p><strong>${escapeHtml(req.title)}</strong> <span class="repo-chip">${escapeHtml(req.kind)}</span></p>
      ${req.sections.map((s) => `
      <details class="plan-section"${open ? " open" : ""}>
        <summary><span>${escapeHtml(s.title)}</span></summary>
        <div class="markdown">${s.html}</div>
      </details>`).join("")}`;
}

/**
 * The Requirements block: the latest version, its age and whether it is
 * approved, where the issue came from and whether it waits for a human. While
 * the issue is in Ideas it carries the Promote button — the same write as a
 * drop into Planning on the board. Omitted until the requirements writer has
 * run; the Status section's Promote to Planning covers an issue with no record.
 */
function requirementsSection(view: IssuePageView): string {
  const req = view.requirements;
  if (!req) return "";
  const approval = view.requirementsApproval;
  const approvalText = approval
    ? `Approved ${approval.version === null ? "without a record" : `v${approval.version}`} by ${approval.by}, ${formatRelativeTime(approval.at)}`
    : "Not yet approved";
  const policy = view.source
    ? `<p class="issue-meta">Filed from ${escapeHtml(view.source)} · ${view.autoPromotes ? "auto-promotes" : "waits for you"}</p>`
    : "";
  const promote = view.lifecycle === "ideas" && view.state.toLowerCase() === "open" && view.repos.length > 0
    ? `
      <form method="POST" action="/issues/${escapeHtml(view.id)}/promote" class="form-actions">
        <button class="trigger-btn" type="submit">Promote</button>
      </form>`
    : "";
  const body = `<p class="issue-meta">${escapeHtml(requirementsMeta(req))} · ${escapeHtml(approvalText)}</p>
      ${policy}
      ${requirementsBody(req, true)}${promote}`;
  return sectionBlock("Requirements", body, true, undefined, "requirements");
}

/** Earlier requirements versions, newest first, all closed. Omitted when there are none. */
function previousRequirementsSection(view: IssuePageView): string {
  const previous = view.previousRequirements ?? [];
  if (previous.length === 0) return "";
  const versions = [...previous].reverse().map((req) => `
      <details class="plan-section">
        <summary><span>${escapeHtml(requirementsMeta(req))}</span></summary>
        <div class="plan-version">${requirementsBody(req, false)}</div>
      </details>`).join("");
  return sectionBlock("Previous requirements", versions, false, previous.length);
}

/** Earlier plan versions, newest first, all closed. Omitted when there are none. */
function previousPlansSection(view: IssuePageView): string {
  if (view.previousPlans.length === 0) return "";
  const versions = [...view.previousPlans].reverse().map((plan) => `
      <details class="plan-section">
        <summary><span>${escapeHtml(planMeta(plan))}</span></summary>
        <div class="plan-version">${planSections(plan, false)}</div>
      </details>`).join("");
  return sectionBlock("Previous plans", versions, false, view.previousPlans.length);
}

/**
 * The collapsed plan block on a board card or an `/issues` row: closed, with
 * the Requirement section and a link to the full plan. `className` scopes the
 * page's own styling.
 */
export function planPreviewBlock(plan: PlanPreview, className: string): string {
  return `<details class="${escapeHtml(className)}"><summary>Plan · ${escapeHtml(plan.summary)}</summary><div class="markdown">${plan.requirementHtml}</div><a href="${escapeHtml(plan.url)}">Full plan</a></details>`;
}

function commentCard(comment: IssueCommentView): string {
  const claws = isClawsComment(comment.body);
  return `<div class="issue-card${claws ? " claws-comment" : ""}">
    <div class="comment-head">
      <span class="comment-author">${escapeHtml(comment.login)}</span>
      <span>${escapeHtml(formatRelativeTime(comment.createdAt))}</span>
      ${claws ? `<span class="claws-badge">Claws</span>` : ""}
    </div>
    <div class="markdown">${comment.bodyHtml}</div>
  </div>`;
}

/** `GET /issues/:id` — the Claws-native issue page. */
export function buildIssuePage(view: IssuePageView, theme: Theme): string {
  const isOpen = view.state.toLowerCase() === "open";
  const labelSet = new Set(view.labels);
  const repoSet = new Set(view.repos);
  const sortedAllRepos = sortedRepos(view.allRepos);
  const statePill = isOpen
    ? `<span class="state-pill state-open">Open</span>`
    : `<span class="state-pill state-closed">Closed${view.stateReason ? ` · ${escapeHtml(view.stateReason.replace("_", " "))}` : ""}</span>`;
  // Always rendered, hidden when it does not apply, so the auto-saving
  // Repositories form can show or hide it without a reload.
  const unactionable = `<div class="warning-banner" id="issue-repo-warning"${view.repos.length === 0 ? "" : " hidden"}>${escapeHtml(NO_REPO_WARNING)} — assign one to start automation.</div>`;
  // The multi-repo note, likewise always rendered so the client can toggle it.
  const primary = primaryRepo(view.repos);
  const multiRepo = `<p class="issue-meta" id="issue-repo-primary"${view.repos.length >= 2 ? "" : " hidden"}>Planned and tracked from <span id="issue-repo-primary-name" title="${escapeHtml(primary)}">${escapeHtml(repoShortName(primary))}</span>; its plan may open PRs in any of these repositories.</p>`;
  // Only the primary repo's dispatchers act on the issue, so an unmanaged
  // primary leaves it inert even when another of its repos is managed. Every
  // repo the Repositories form can save is managed, so the client hides this
  // after a save rather than re-deriving it.
  const primaryUnmanaged = primary !== "" && !view.allRepos.some((r) => r.toLowerCase() === primary.toLowerCase());
  const unmanagedPrimary = primaryUnmanaged
    ? `<div class="warning-banner" id="issue-repo-unmanaged">Its primary repository, ${escapeHtml(primary)}, is not managed by Claws, so nothing will act on this issue — assign a managed repository that sorts first, or remove ${escapeHtml(primary)}.</div>`
    : "";
  // Cells are stored under the primary repo, the one the planner and
  // implementer resolve them from, so any issue with a repo can set them.
  const modelPlanReadOnly = view.repos.length === 0;

  const body = `
  <div class="section">
    <div class="issue-head">
      <div class="issue-title-row" id="issue-title-row">
        <h2 class="issue-title" id="issue-title"><span id="issue-title-text">${escapeHtml(view.title)}</span> <span style="color:var(--text-subtle)" title="${escapeHtml(view.id)}">#${escapeHtml(shortIssueRef(view.id))}</span></h2>
        <button type="button" class="icon-btn" id="issue-title-edit" aria-label="Edit title" title="Edit title">✎</button>
        <button type="button" class="icon-btn" id="issue-copy-url" aria-label="Copy URL" title="Copy URL" data-copy-url="${escapeHtml(issueUrl(primary, view.id))}">${COPY_ICON_SVG}</button>
        <span class="icon-status" id="issue-head-status" role="status" aria-live="polite"></span>
      </div>
      <form class="issue-title-form" id="issue-title-form" method="POST" action="/issues/${escapeHtml(view.id)}/edit" hidden>
        <input type="text" name="title" required maxlength="300" value="${escapeHtml(view.title)}">
        <div class="form-actions">
          <button class="trigger-btn" type="submit">Save</button>
          <button class="trigger-btn" type="button" id="issue-title-cancel">Cancel</button>
        </div>
      </form>
      <div class="issue-meta">${statePill} opened by ${escapeHtml(view.authorLogin)} · updated ${escapeHtml(formatRelativeTime(view.updatedAt))}</div>
      <div class="chip-row" id="issue-repos">${view.repos.map(repoChip).join("")}</div>
      ${multiRepo}
      <div class="chip-row" id="issue-labels">${plainLabels(view.labels).map(specLabelChip).join("")}</div>
    </div>
    ${unactionable}
    ${unmanagedPrimary}
    ${sectionBlock("Request", `
    <div class="issue-card">
      <div class="comment-head"><span class="comment-author">${escapeHtml(view.authorLogin)}</span><span>${escapeHtml(formatRelativeTime(view.createdAt))}</span></div>
      <div class="markdown">${view.body.trim() ? view.bodyHtml : `<p class="queue-empty">No description</p>`}</div>
      ${view.filedTitle ? `<p class="issue-meta">Filed as “${escapeHtml(view.filedTitle)}”</p>` : ""}
    </div>`, true)}

    ${requirementsSection(view)}

    ${previousRequirementsSection(view)}

    ${currentPlanSection(view)}

    ${previousPlansSection(view)}

    ${sectionBlock("Comments", `
    ${view.comments.map(commentCard).join("\n")}

    <form class="issue-form" method="POST" action="/issues/${escapeHtml(view.id)}/comments">
      <label class="form-field" style="width:100%">
        Comment (markdown)
        <textarea name="body" rows="6" required placeholder="Feedback on the plan, extra context…" data-attach-target="${escapeHtml(view.id)}"></textarea>
      </label>
      ${attachRow()}
      <div class="form-actions"><button class="trigger-btn" type="submit">Comment</button></div>
    </form>`, true, view.comments.length)}

    ${attachmentsSection(view)}

    ${linksSection(view)}

    ${sectionBlock("Edit", `
    <form class="issue-form" method="POST" action="/issues/${escapeHtml(view.id)}/edit">
      <label class="form-field" style="width:100%">
        Title
        <input type="text" id="issue-edit-title" name="title" required maxlength="300" value="${escapeHtml(view.title)}">
      </label>
      <label class="form-field" style="width:100%; margin-top:0.6rem;">
        Body (markdown)
        <textarea name="body" rows="10" data-attach-target="${escapeHtml(view.id)}">${escapeHtml(view.body)}</textarea>
      </label>
      ${attachRow()}
      <div class="form-actions"><button class="trigger-btn" type="submit">Save</button></div>
    </form>`, false)}

    ${statusSection(view, isOpen)}

    ${sectionBlock("Labels", `
    <form class="issue-form" method="POST" action="/issues/${escapeHtml(view.id)}/labels" data-autosave="labels">
      <p class="issue-meta">${escapeHtml(LABEL_FORM_HINT)}</p>
      ${checkboxList("label", offeredLabels(Object.keys(LABEL_SPECS)), labelSet, specLabelChip)}
      <div class="form-actions"><button class="trigger-btn" type="submit" data-autosave-submit>Save labels</button><span class="autosave-status" role="status" aria-live="polite"></span></div>
    </form>`, false)}

    ${sectionBlock("Model plan", `
    <form class="issue-form" method="POST" action="/issues/${escapeHtml(view.id)}/model-plan">
      <p class="issue-meta">${escapeHtml(MODEL_PLAN_NOTE)}</p>
      ${modelPlanReadOnly ? `<p class="issue-meta">The model plan is stored under the issue's primary repository, so it can be edited once the issue has one.</p>` : ""}
      ${modelPlanTable(view.modelPlan, modelPlanReadOnly)}
      ${modelPlanReadOnly ? "" : `<div class="form-actions"><button class="trigger-btn" type="submit">Save model plan</button></div>`}
    </form>`, false)}

    ${sectionBlock("Repositories", `
    <form class="issue-form" method="POST" action="/issues/${escapeHtml(view.id)}/repos" data-autosave="repos">
      ${checkboxList("repo", sortedAllRepos, repoSet, repoOptionText, (r) => r)}
      <div class="form-actions"><button class="trigger-btn" type="submit" data-autosave-submit>Save repositories</button><span class="autosave-status" role="status" aria-live="polite"></span></div>
    </form>`, false)}

    <h2>State</h2>
    <form class="issue-form" method="POST" action="/issues/${escapeHtml(view.id)}/state">
      ${isOpen ? `
      <div class="form-actions">
        <button class="trigger-btn" type="submit" name="state" value="closed">Close issue</button>
      </div>` : `
      <div class="form-actions">
        <button class="trigger-btn" type="submit" name="state" value="open">Reopen issue</button>
      </div>`}
    </form>
    <p class="issue-meta"><a href="${escapeHtml(issueUrl(primary, view.id))}">Permalink</a> · <a href="/issues">← All issues</a></p>
  </div>`;

  return pageShell(`#${shortIssueRef(view.id)} ${view.title}`, `Issue #${shortIssueRef(view.id)}`, theme, `${body}
  ${ISSUE_EDIT_SCRIPT}
  ${ISSUE_ATTACHMENTS_SCRIPT}`);
}
