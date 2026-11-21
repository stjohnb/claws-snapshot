import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, repoAvatar } from "./layout.js";
import type { NavCounts, Theme } from "./layout.js";
import type { FrictionNoteRow, FrictionRetrospective } from "../db.js";
import { isClawsIssueId, shortIssueRef } from "../issue-id.js";
import { FRICTION_COUNT_THRESHOLD, FRICTION_RETRO_DAYS, localDate, noteSource, parseSqlTime } from "../jobs/friction-retrospective.js";

/** One managed repo's friction-note pile, as `/retro` shows it. */
export interface RetroRepoView {
  repo: string;
  /** Untriaged note counts by category. */
  counts: ReadonlyMap<string, number>;
  /** Untriaged notes, oldest first. */
  notes: readonly FrictionNoteRow[];
  /** True when the job is switched off for this repo in the /jobs matrix. */
  disabled?: boolean;
}

/** The whole `/retro` page: one fleet-wide clock and count, then each repo's pile. */
export interface RetroPageView {
  /** The local day the fleet's time-based retrospective is next due. */
  nextDue: Date;
  /** Untriaged notes that the next retrospective will cover. */
  totalUntriaged: number;
  /** Past retrospective issues, newest first. */
  retrospectives: readonly FrictionRetrospective[];
  repos: readonly RetroRepoView[];
  /** The job names of the notes' tasks that still exist, by task id. */
  taskJobs?: ReadonlyMap<number, string>;
}

const RETRO_CSS = `
  .retro-intro { color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1.25rem; }
  .retro-repo { border-top: 1px solid var(--border); padding-top: 1rem; margin-bottom: 1.5rem; }
  .retro-repo h2 { display: flex; align-items: center; gap: 0.5rem; font-size: 1rem; margin: 0 0 0.75rem; overflow-wrap: anywhere; }
  .retro-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.75rem; }
  .retro-chip { display: inline-block; font-size: 0.7rem; padding: 0.1rem 0.5rem; border: 1px solid var(--border); border-radius: 12px; color: var(--text-secondary); white-space: nowrap; }
  .retro-chip strong { color: var(--text); }
  .retro-none { color: var(--text-secondary); font-size: 0.875rem; margin: 0; }
  .retro-past { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; }
  .retro-note { overflow-wrap: anywhere; }
  .retro-repo td code { overflow-wrap: anywhere; }
`;

function sqlTimeIso(value: string): string {
  return parseSqlTime(value).toISOString();
}

/** The note's source, with its working issue linked when that is a native `clw_…` issue. */
function sourceCell(note: FrictionNoteRow, taskJobs: ReadonlyMap<number, string> | undefined): string {
  const job = note.task_id !== null ? taskJobs?.get(note.task_id) : undefined;
  const source = escapeHtml(noteSource(note, job ? { job_name: job } : undefined));
  if (!note.origin) return source;
  const ref = note.origin.includes("#") ? note.origin.slice(note.origin.lastIndexOf("#") + 1) : "";
  const origin = isClawsIssueId(ref)
    ? `<a href="/issues/${encodeURIComponent(ref)}">#${escapeHtml(shortIssueRef(ref))}</a>`
    : escapeHtml(note.origin);
  return `${source}<br>${origin}`;
}

function noteRow(note: FrictionNoteRow, taskJobs: ReadonlyMap<number, string> | undefined): string {
  const iso = sqlTimeIso(note.created_at);
  return `<tr>
        <td data-label="Date"><span title="${escapeHtml(iso)}">${escapeHtml(note.created_at.slice(0, 10))}</span></td>
        <td data-label="Category">${escapeHtml(note.category)}</td>
        <td class="cell-title retro-note" data-label="Note">${escapeHtml(note.text)}</td>
        <td data-label="Reference">${note.reference ? `<code>${escapeHtml(note.reference)}</code>` : "—"}</td>
        <td data-label="Source">${sourceCell(note, taskJobs)}</td>
      </tr>`;
}

function repoSection(view: RetroRepoView, taskJobs: ReadonlyMap<number, string> | undefined): string {
  const total = view.notes.length;
  const chips = [...view.counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, n]) => `<span class="retro-chip">${escapeHtml(category)} <strong>${n}</strong></span>`)
    .join("");
  const disabled = view.disabled ? `<p class="retro-none">Disabled in /jobs</p>` : "";
  const notes = total === 0
    ? (view.disabled ? "" : `<p class="retro-none">No notes</p>`)
    : `<div class="retro-chips">${chips}</div>
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Date</th><th>Category</th><th>Note</th><th>Reference</th><th>Source</th></tr></thead>
      <tbody>${view.notes.map((n) => noteRow(n, taskJobs)).join("\n")}</tbody>
    </table></div>`;
  return `<section class="retro-repo" id="${escapeHtml(`retro-${view.repo.replace(/[^A-Za-z0-9_-]/g, "-")}`)}">
    <h2>${repoAvatar(view.repo)}<a href="/repos/${view.repo.split("/").map(encodeURIComponent).join("/")}">${escapeHtml(view.repo)}</a></h2>
    ${disabled}
    ${notes}
  </section>`;
}

/**
 * `/retro`: the fleet's single retrospective clock (untriaged count, next
 * time-based due date, past retrospective issues), then every managed repo's
 * untriaged friction notes with counts by category. Repos with notes come
 * first, the largest pile leading.
 */
export function buildRetroPage(view: RetroPageView, theme: Theme, navCounts?: NavCounts): string {
  const ordered = [...view.repos].sort((a, b) => b.notes.length - a.notes.length || a.repo.localeCompare(b.repo));
  const latest = view.repos.flatMap((r) => r.notes).map((n) => n.created_at).sort().pop();
  const total = view.totalUntriaged;
  const nextDue = total > 0
    ? `${escapeHtml(localDate(view.nextDue))} (Friday)`
    : `${escapeHtml(localDate(view.nextDue))} (Friday), if a note is recorded by then`;
  const past = view.retrospectives.length === 0
    ? "None yet"
    : `<span class="retro-past">${view.retrospectives.map((r) =>
      `<a href="/issues/${encodeURIComponent(r.issueId)}" title="${escapeHtml(`${r.noteCount} notes, ${r.triagedAt.slice(0, 10)}`)}">#${escapeHtml(shortIssueRef(r.issueId))}</a> <span class="retro-chip">${escapeHtml(r.triagedAt.slice(0, 10))}</span>`).join("")}</span>`;
  const intro = `<p class="retro-intro">Agents record out-of-scope friction with <code>claws_note_friction</code>. One retrospective issue covers every repo: it is filed on a Friday once ${FRICTION_RETRO_DAYS} days have passed since the last one, or as soon as ${FRICTION_COUNT_THRESHOLD} notes pile up across all repos. ${total} untriaged note${total === 1 ? "" : "s"}${latest ? `, the latest ${escapeHtml(formatRelativeTime(sqlTimeIso(latest)))}` : ""}.</p>
  <dl class="meta">
    <dt>Untriaged</dt><dd>${total}/${FRICTION_COUNT_THRESHOLD}</dd>
    <dt>Next retrospective</dt><dd>${nextDue}</dd>
    <dt>Past retrospectives</dt><dd>${past}</dd>
  </dl>`;
  const body = ordered.length === 0
    ? `<p class="retro-none">No managed repositories.</p>`
    : ordered.map((r) => repoSection(r, view.taskJobs)).join("\n");
  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <title>claws — Retro</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${RETRO_CSS}</style>
</head>
<body>
  ${buildPageHeader("Retro", theme, { current: "/retro", navCounts })}
  ${THEME_SCRIPT}
  ${intro}
  ${body}
</body>
</html>`;
}
