/**
 * The Approve infra changes block on a board card and the issue page
 * (#clw_01M7096B0VFCVYAA2ED0ZRHFC2): the infra changes the Planner declared
 * for the issue's PRs, and the operator's plan-stage acknowledgement of them.
 * Rendered only when at least one planned PR has a declaration; re-rendered
 * by `POST /board/infra-ack`, whose buttons `src/client/lib/infra-ack.ts`
 * wires on both pages.
 */

import { escapeHtml, formatRelativeTime } from "./layout.js";
import { declarationsHash, type InfraDeclaration } from "../infra-declaration.js";
import type { InfraAckState } from "../issue-infra-ack.js";

export interface InfraAckView {
  /** The issue's primary repository and ref, posted back by the buttons. */
  repo: string;
  ref: string;
  /** The planned PRs that declare infra changes, in plan order. */
  entries: readonly { position: number; repo: string; infraChanges: InfraDeclaration }[];
  ack: { by: string; at: string } | null;
  state: InfraAckState;
  /** False on a closed or read-only issue: the block shows no button. */
  canAct?: boolean;
}

/** A stored `YYYY-MM-DD HH:MM:SS` UTC time as ISO 8601. */
function isoFromSql(at: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? `${at.replace(" ", "T")}Z` : at;
}

function summaryText(view: InfraAckView): string {
  const total = view.entries.reduce((n, e) => n + e.infraChanges.resources.length, 0);
  const where = view.entries
    .map((e) => {
      const roots = [...new Set(e.infraChanges.resources.map((r) => r.root))].sort();
      return `PR ${e.position}${roots.length > 0 ? ` (${roots.join(", ")})` : ""}`;
    })
    .join(", ");
  const status = view.state === "current" && view.ack
    ? `approved by ${view.ack.by} ${formatRelativeTime(isoFromSql(view.ack.at))}`
    : view.state === "stale" ? "changed since approval" : "not approved";
  return `Expected infra changes: ${total} resource${total === 1 ? "" : "s"} in ${where} · ${status}`;
}

function entryList(e: InfraAckView["entries"][number]): string {
  const items = e.infraChanges.resources.map((r) => {
    const destructive = r.actions.includes("replace") || r.actions.includes("destroy");
    return `<li${destructive ? ` class="infra-ack-danger"` : ""}><code>${escapeHtml(r.root)} · ${escapeHtml(r.address)}</code> — ${escapeHtml(r.actions.join(", "))}</li>`;
  });
  const files = e.infraChanges.workflow_files.map((f) => `<li class="infra-ack-file">Workflow file <code>${escapeHtml(f)}</code></li>`);
  return `<p class="infra-ack-pr">PR ${e.position} · ${escapeHtml(e.repo)}</p>
        <ul class="infra-ack-list">${[...items, ...files].join("")}</ul>`;
}

/** The block, or "" when no planned PR declares infra changes. */
export function renderInfraAck(view: InfraAckView): string {
  if (view.entries.length === 0) return "";
  // The hash of the declarations shown, posted back so an approval covers exactly these.
  const data = `data-repo="${escapeHtml(view.repo)}" data-ref="${escapeHtml(view.ref)}" data-hash="${declarationsHash(view.entries)}"`;
  const canAct = view.canAct !== false;
  let footer: string;
  if (view.state === "current" && view.ack) {
    const at = isoFromSql(view.ack.at);
    footer = `<p class="infra-ack-by">Approved by <b>${escapeHtml(view.ack.by)}</b> <span title="${escapeHtml(at)}">${escapeHtml(formatRelativeTime(at))}</span>. Claws merges a PR whose verified plan stays inside these changes.</p>${canAct ? `
        <button type="button" class="infra-ack-withdraw" draggable="false">Withdraw</button>` : ""}`;
  } else {
    const stale = view.state === "stale" && view.ack
      ? `<p class="infra-ack-stale">The declared changes changed since ${escapeHtml(view.ack.by)} approved them; approve them again.</p>`
      : "";
    footer = `${stale}${canAct ? `
        <button type="button" class="infra-ack-approve" draggable="false">Approve infra changes</button>` : ""}`;
  }
  return `<details class="infra-ack" data-state="${view.state}" ${data}>
      <summary>${escapeHtml(summaryText(view))}</summary>
      <div class="infra-ack-body">
        ${view.entries.map(entryList).join("\n        ")}
        ${footer}
      </div>
    </details>`;
}

export const INFRA_ACK_CSS = `
  .infra-ack { width: 100%; box-sizing: border-box; min-width: 0; font-size: 0.75rem; color: var(--text-secondary); border: 1px solid var(--border); border-radius: 4px; padding: 0.3rem 0.5rem; }
  .infra-ack > summary { cursor: pointer; color: var(--text); overflow-wrap: anywhere; line-height: 1.3; }
  .infra-ack[data-state="stale"] > summary { color: var(--warning); }
  .infra-ack-body { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.3rem; min-width: 0; }
  .infra-ack-pr { margin: 0; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
  .infra-ack-list { margin: 0; padding-left: 1rem; overflow-wrap: anywhere; }
  .infra-ack-list code { overflow-wrap: anywhere; word-break: break-word; }
  .infra-ack-danger, .infra-ack-danger code { color: var(--danger); }
  .infra-ack-by, .infra-ack-stale { margin: 0; overflow-wrap: anywhere; }
  .infra-ack-stale { color: var(--warning); }
  .infra-ack-approve, .infra-ack-withdraw { width: 100%; min-height: 40px; box-sizing: border-box; padding: 0 0.6rem; border-radius: 4px; font: inherit; font-size: 0.75rem; font-weight: 600; cursor: pointer; }
  .infra-ack-approve { border: 1px solid var(--accent); background: var(--accent); color: var(--bg); }
  .infra-ack-withdraw { border: 1px solid var(--danger); background: transparent; color: var(--danger); }
  .infra-ack[aria-busy="true"] button { opacity: 0.6; cursor: progress; }
  .infra-ack-error { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
  @media (min-width: 768px) {
    .infra-ack-approve, .infra-ack-withdraw { min-height: 30px; }
  }
`;
