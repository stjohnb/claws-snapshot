// The Board's Dependency graph modal (docs/issue-tracker.md#board): the
// dialog's markup and CSS, and the HTML `GET /api/board/dependency-graph`
// answers with. `src/client/dependency-graph.ts` opens the dialog, fetches the
// body and draws each chain's edges from its `data-edges`.
import { BOARD_COLUMNS } from "../board-columns.js";
import type { DependencyChain, GraphNodeState } from "../dependency-graph.js";
import { escapeHtml, formatCompactAge, repoShortName } from "./layout.js";

/** The dialog, on the preview modal's frame; its body is filled on every open. */
export const DEPENDENCY_GRAPH_MODAL_HTML = `<dialog class="preview-modal dep-graph-modal" id="dep-graph-modal" aria-labelledby="dep-graph-modal-title">
  <div class="preview-modal-frame">
    <div class="preview-modal-head"><h2 id="dep-graph-modal-title">Dependency graph</h2><button type="button" class="preview-modal-close" aria-label="Close">×</button></div>
    <div class="preview-modal-body dep-graph-body" data-dep-graph-body></div>
  </div>
</dialog>`;

/**
 * The modal's styles (docs/DESIGN.md "Form factors & responsive"): one
 * left-to-right row per chain that scrolls sideways at every width. Colours
 * are the existing tokens: solid `--success` moving, dashed `--success`
 * awaiting merge approval, `--warning` operator action, dashed `--danger`
 * held; edges `--danger`. No transition or animation.
 */
export const DEPENDENCY_GRAPH_CSS = `
  .dep-graph-modal { max-width: 72rem; }
  .dep-graph-body { overflow-wrap: normal; }
  .dep-graph-body > p { margin: 0.5rem 0; color: var(--text-secondary); }
  .dep-legend { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; color: var(--text-secondary); font-size: 0.8rem; margin: 0 0 0.75rem; padding: 0; list-style: none; }
  .dep-legend li { display: inline-flex; align-items: center; gap: 0.35rem; }
  .dep-swatch { display: inline-block; width: 14px; height: 11px; border: 2px solid; border-radius: 3px; }
  .dep-swatch[data-state="moving"] { border-color: var(--success); }
  .dep-swatch[data-state="approval"] { border-color: var(--success); border-style: dashed; }
  .dep-swatch[data-state="operator"] { border-color: var(--warning); }
  .dep-swatch[data-state="held"] { border-color: var(--danger); border-style: dashed; }
  .dep-swatch-edge { display: inline-block; width: 22px; border-top: 2px solid var(--danger); }
  .dep-chain { margin: 0 0 0.5rem; }
  .dep-chain h3 { font-family: var(--font-display); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-secondary); margin: 0.75rem 0 0.35rem; font-weight: 600; }
  .dep-row { position: relative; display: flex; gap: 56px; align-items: stretch; padding: 4px 0 34px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .dep-row svg { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
  .dep-row svg .dep-edge { fill: none; stroke: var(--danger); stroke-width: 2; pointer-events: stroke; }
  .dep-row svg .dep-edge-mark { fill: var(--danger); }
  .dep-card { flex: 1 1 0; max-width: 330px; min-width: 0; display: block; text-decoration: none; color: var(--text); background: var(--bg-secondary); border: 2px solid var(--border); border-left-width: 5px; border-radius: 6px; padding: 0.6rem 0.75rem; }
  .dep-card:hover .dep-title, .dep-card:focus-visible .dep-title { text-decoration: underline; }
  .dep-card[data-state="moving"] { border-color: var(--success); }
  .dep-card[data-state="approval"] { border-color: var(--success); border-style: dashed; border-left-style: solid; }
  .dep-card[data-state="operator"] { border-color: var(--warning); }
  .dep-card[data-state="held"] { border-color: var(--danger); border-style: dashed; border-left-style: solid; }
  .dep-title { font-weight: 600; font-size: 0.875rem; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .dep-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; margin-top: 0.5rem; }
  .dep-stage { font-size: 0.75rem; font-weight: 600; }
  .dep-time { font-family: var(--font-display); font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1; }
  .dep-card[data-state="moving"] :is(.dep-stage, .dep-time), .dep-card[data-state="approval"] :is(.dep-stage, .dep-time) { color: var(--success); }
  .dep-card[data-state="operator"] :is(.dep-stage, .dep-time) { color: var(--warning); }
  .dep-card[data-state="held"] :is(.dep-stage, .dep-time) { color: var(--danger); }
  .dep-why { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.35rem; overflow-wrap: anywhere; }
  @media (max-width: 767px) {
    .dep-row { gap: 26px; }
    .dep-card { flex: 1 0 150px; max-width: none; padding: 0.5rem 0.55rem; border-left-width: 4px; }
    .dep-title { font-size: 0.8rem; -webkit-line-clamp: 4; }
    .dep-meta { flex-direction: column; gap: 2px; margin-top: 0.35rem; }
    .dep-time { font-size: 1.125rem; }
    .dep-why { font-size: 0.75rem; line-height: 1.35; }
  }
  html:has(.dep-graph-modal[open]) { overflow: hidden; }
`;

const STATE_WORDS: Record<GraphNodeState, string> = {
  moving: "moving, runs to merge",
  approval: "awaiting merge approval only",
  operator: "operator action needed",
  held: "held by another issue",
};

const EMPTY = "<p>No open issues are blocking one another.</p>";

function legend(): string {
  const items = (Object.keys(STATE_WORDS) as GraphNodeState[])
    .map((state) => `<li><span class="dep-swatch" data-state="${state}" aria-hidden="true"></span>${escapeHtml(STATE_WORDS[state])}</li>`);
  return `<ul class="dep-legend">${items.join("")}<li><span class="dep-swatch-edge" aria-hidden="true"></span>is blocked by →</li></ul>`;
}

/**
 * The modal body: the legend and one `.dep-chain` per chain — a heading of
 * its repos' short names, then a row of `a.dep-card` boxes left to right with
 * the edges as JSON in the row's `data-edges` — or one paragraph when there
 * are no chains.
 */
export function renderDependencyGraph(chains: readonly DependencyChain[], now = Date.now()): string {
  if (chains.length === 0) return EMPTY;
  const sections = chains.map((chain) => {
    const repos = [...new Set(chain.nodes.map((n) => (n.repo ? repoShortName(n.repo) : "unassigned")))];
    const edges = chain.edges.map((e) => ({ from: e.from, to: e.to, label: e.label }));
    const cards = chain.nodes.map((node) => {
      const stage = BOARD_COLUMNS.find((col) => col.id === node.column)?.title ?? node.column;
      const time = node.since ? formatCompactAge(node.since, now) : "";
      const timeTitle = node.since ? ` title="${escapeHtml(`In ${stage} since ${node.since}`)}"` : "";
      return `<a class="dep-card" data-state="${node.state}" data-node="${escapeHtml(node.id)}" href="/issues/${encodeURIComponent(node.id)}" aria-label="${escapeHtml(`${node.title} — ${stage}, ${STATE_WORDS[node.state]}`)}">
        <div class="dep-title">${escapeHtml(node.title)}</div>
        <div class="dep-meta"><span class="dep-stage">${escapeHtml(stage)}</span><span class="dep-time"${timeTitle}>${escapeHtml(time)}</span></div>
        ${node.why ? `<div class="dep-why">${escapeHtml(node.why)}</div>` : ""}
      </a>`;
    });
    return `<section class="dep-chain">
      <h3>${escapeHtml(repos.join(" · "))}</h3>
      <div class="dep-row" data-edges="${escapeHtml(JSON.stringify(edges))}">
        ${cards.join("\n        ")}
      </div>
    </section>`;
  });
  return `${legend()}\n${sections.join("\n")}`;
}
