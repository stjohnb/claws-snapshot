import { escapeHtml } from "./layout.js";

/** CSS for a GET filter form shared by the flat list pages (`/backlog`, `/prs`). */
export const LIST_FILTERS_CSS = `
  .list-filters { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-end; margin-bottom: 1rem; }
  .list-filters .form-field { flex: 1 1 12rem; }
  .list-filters .form-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .list-filters-compact { align-items: center; margin-bottom: 0.5rem; }
  .prs-filter { display: flex; align-items: center; gap: 0.5rem; flex: 1 1 100%; }
  .prs-filter[x-cloak] { display: none !important; }
  .prs-filter-key { font-family: var(--font-display); font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap; }
  .prs-filter .form-field { flex: 1 1 auto; min-width: 0; }
  @media (min-width: 768px) {
    .prs-filter { flex: 0 1 auto; }
    .list-filters-compact .form-field-compact { flex: 0 1 auto; max-width: none; }
    .list-filters-compact .form-field-compact .form-select { width: auto; min-height: 30px; padding: 0.25rem 0.5rem; font-size: 0.8rem; }
  }
`;

/** A labelled `<select>` whose first choice, "All", is the empty value. */
export function filterSelect(name: string, label: string, options: string[], selected: string, optionText: (v: string) => string = (v) => v, opts: { compact?: boolean; autoSubmit?: boolean; emptyText?: string } = {}): string {
  const optionsHtml = options
    .map((v) => `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>${escapeHtml(optionText(v))}</option>`)
    .join("");
  const compact = Boolean(opts.compact);
  return `<label class="form-field${compact ? " form-field-compact" : ""}">${compact ? `<span class="visually-hidden">${escapeHtml(label)}</span>` : escapeHtml(label)}
      <select class="form-select" name="${escapeHtml(name)}"${compact ? ` title="${escapeHtml(label)}"` : ""}${opts.autoSubmit ? ` @change="$el.form.requestSubmit()"` : ""}>
        <option value=""${selected === "" ? " selected" : ""}>${opts.emptyText !== undefined ? escapeHtml(opts.emptyText) : compact ? escapeHtml(label) : "All"}</option>${optionsHtml}
      </select>
    </label>`;
}

/** Sorted distinct values, plus the active one when it matches nothing. */
export function filterOptions(values: string[], active: string): string[] {
  const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (active && !options.includes(active)) options.push(active);
  return options;
}
