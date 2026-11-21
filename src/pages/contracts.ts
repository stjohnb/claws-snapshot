import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, repoAvatar, repoShortName } from "./layout.js";
import type { NavCounts, Theme } from "./layout.js";
import { escapeMarkdownHtml } from "../markdown.js";
import { shortIssueRef } from "../issue-id.js";
import type { DriftFinding } from "../contract-drift.js";
import { gapKey, REVIEW_PAGE_PATH, SECURITY_GAP_REVIEW_URL, type ReviewItem } from "../contract-gap-review.js";
import { ACCEPTED_GAP_PREFIX } from "../observability-contract.js";
import {
  CONTRACTS,
  contractRequirementsWaived,
  gapCounts,
  needsAttention,
  orderContractRows,
  type ContractRow,
  type ContractWaiver,
} from "../contract-status.js";

const CONTRACTS_CSS = `
  .contracts-intro { color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1.25rem; }
  .contracts-none { color: var(--text-secondary); font-size: 0.875rem; margin: 0; }
  .contracts-section-title { margin: 1.5rem 0 0.75rem; }
  .contract-repo { display: inline-flex; align-items: center; gap: 0.4rem; overflow-wrap: anywhere; }
  .contract-chip { display: inline-block; font-size: 0.7rem; padding: 0.1rem 0.5rem; border: 1px solid var(--border); border-radius: 12px; color: var(--text-subtle); white-space: nowrap; }
  .contract-chip.warn { border-color: var(--warning); color: var(--warning); }
  .contract-chip.ok { border-color: var(--success); color: var(--success); }
  .contract-sub { color: var(--text-secondary); font-size: 0.8rem; margin-top: 0.25rem; overflow-wrap: anywhere; }
  .contract-count-warn { color: var(--warning); font-weight: 600; }
  .contract-follow-up { overflow-wrap: anywhere; }
  .contract-detail-section { margin-bottom: 2rem; }
  .contract-items { list-style: none; padding: 0; margin: 0.5rem 0 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .contract-item { border: 1px solid var(--border); border-left-width: 3px; border-radius: 4px; padding: 0.5rem 0.75rem; overflow-wrap: anywhere; font-size: 0.875rem; }
  .contract-item.waives { border-left-color: var(--warning); }
  .contract-item-head { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.25rem; }
  .contract-loc { font-size: 0.8rem; color: var(--text-secondary); }
  .review-reconfirm { margin: 0 0 1.25rem; }
  .review-reconfirm .trigger-btn, .review-actions a { min-height: 40px; display: inline-flex; align-items: center; box-sizing: border-box; }
  .review-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.4rem; }
  .review-group-title { font-size: 0.85rem; color: var(--text-secondary); margin: 0.75rem 0 0.25rem; }
  .review-unchanged > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 600; }
  @media (min-width: 768px) {
    .review-reconfirm .trigger-btn, .review-actions a { min-height: 30px; }
  }
`;

function contractLabel(contract: string): string {
  return CONTRACTS.find((c) => c.contract === contract)?.label ?? contract;
}

function chip(text: string, tone?: "warn" | "ok", title?: string): string {
  return `<span class="contract-chip${tone ? ` ${tone}` : ""}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(text)}</span>`;
}

/** Gap or finding text, HTML-escaped, with backtick spans as `<code>`. */
function inlineText(text: string): string {
  return escapeMarkdownHtml(text).replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

function timeCell(iso: string | null): string {
  if (!iso) return "—";
  return `<span title="${escapeHtml(iso)}">${escapeHtml(formatRelativeTime(iso))}</span>`;
}

function repoCell(repo: string): string {
  const [owner, name] = repo.split("/");
  const href = `/contracts/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
  return `<a class="contract-repo" href="${href}">${repoAvatar(repo)}<span title="${escapeHtml(repo)}">${escapeHtml(repoShortName(repo))}</span></a>`;
}

/** The Policy cell: the opt-out, "Not scanned yet", or the policy status with any missing rules. */
function policyCell(row: ContractRow): string {
  if (row.optOut) {
    return `${chip("Opted out")}<div class="contract-sub">${escapeHtml(row.optOut.job)} disabled in ${row.optOut.source === "repo" ? "repo" : "host"} config</div>`;
  }
  const s = row.snapshot;
  if (!s) return chip("Not scanned yet");
  if (s.policy.status === "complete") return chip("Complete", "ok", s.policy.path ?? undefined);
  const label = s.policy.status === "incomplete" ? "Incomplete" : "None";
  const missing = s.policy.missingRules.length > 0
    ? `<div class="contract-sub">Missing ${s.policy.missingRules.length} rule${s.policy.missingRules.length === 1 ? "" : "s"}</div>`
    : "";
  return chip(label, "warn", s.policy.missingRules.join("\n") || undefined) + missing;
}

function countCell(n: number | null, warn: boolean): string {
  if (n === null) return "—";
  return warn && n > 0 ? `<span class="contract-count-warn">${n}</span>` : String(n);
}

function followUpCell(row: ContractRow): string {
  if (!row.followUp) return "—";
  const f = row.followUp;
  const stops = f.stopsAt ? `<div class="contract-sub">Stops at ${escapeHtml(f.stopsAt)}</div>` : "";
  return `<a href="/issues/${encodeURIComponent(f.id)}" title="${escapeHtml(f.title)}">#${escapeHtml(shortIssueRef(f.id))}</a>${stops}`;
}

function lastAuditCell(row: ContractRow): string {
  if (!row.audited || row.optOut) return "—";
  if (row.auditOff) return "off";
  return timeCell(row.auditedAt);
}

function contractRow(row: ContractRow): string {
  const s = row.optOut ? null : row.snapshot;
  const counts = s ? gapCounts(s) : null;
  const audit = !s || !row.audited ? null : s.audit?.findings.length ?? 0;
  return `<tr>
        <td class="cell-title" data-label="Repo">${repoCell(row.repo)}</td>
        <td data-label="Contract">${escapeHtml(contractLabel(row.contract))}</td>
        <td data-label="Policy">${policyCell(row)}</td>
        <td data-label="Unaccepted">${countCell(counts?.unaccepted ?? null, true)}</td>
        <td data-label="Deferred">${countCell(counts?.deferred ?? null, false)}</td>
        <td data-label="Accepted">${countCell(counts?.accepted ?? null, false)}</td>
        <td data-label="Drift">${countCell(s ? s.drift.length : null, true)}</td>
        <td data-label="Audit">${countCell(audit, true)}</td>
        <td class="contract-follow-up" data-label="Follow-up">${row.optOut ? "—" : followUpCell(row)}</td>
        <td class="hide-sm" data-label="Last scan">${row.optOut ? "—" : timeCell(row.scannedAt)}</td>
        <td class="hide-sm" data-label="Last audit">${lastAuditCell(row)}</td>
      </tr>`;
}

function waiverTable(waivers: readonly ContractWaiver[]): string {
  if (waivers.length === 0) return `<p class="contracts-none">No accepted gap waives a contract requirement</p>`;
  const rows = waivers.map((w) => `<tr>
        <td class="cell-title" data-label="Requirement">${escapeHtml(w.requirement)}</td>
        <td data-label="Contract">${escapeHtml(contractLabel(w.contract))}</td>
        <td data-label="Repos">${w.repos.map(repoCell).join(", ")}</td>
      </tr>`).join("\n");
  return `<div class="table-scroll"><table class="data-cards data-cards-wide contracts-waivers">
      <thead><tr><th>Requirement</th><th>Contract</th><th>Repos</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function pageShell(title: string, current: string, theme: Theme, width: "wide" | undefined, body: string, navCounts?: NavCounts): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme, width)}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <title>claws — ${escapeHtml(title)}</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${CONTRACTS_CSS}</style>
</head>
<body>
  ${buildPageHeader(title, theme, { current, navCounts })}
  ${THEME_SCRIPT}
  ${body}
</body>
</html>`;
}

/**
 * `/contracts`: every managed repo against each contract
 * (docs/product/dashboard-and-integrations.md "Show where every repo stands
 * against its contracts"), the rows needing attention first and opted-out
 * rows last, under a table of the contract requirements accepted gaps waive.
 */
export function buildContractsPage(
  rows: readonly ContractRow[],
  waivers: readonly ContractWaiver[],
  theme: Theme,
  navCounts?: NavCounts,
  reviewChanged = 0,
): string {
  const ordered = orderContractRows(rows);
  const attention = ordered.filter(needsAttention).length;
  const review = `<a href="${REVIEW_PAGE_PATH}">Review accepted gaps</a> (${reviewChanged} new or reworded)`;
  const intro = `<p class="contracts-intro">Where every managed repo stands against the observability and security contracts, from the daily contract scanners and the weekly audit. ${attention} of ${ordered.length} need attention. ${review}.</p>`;
  const table = ordered.length === 0
    ? `<p class="contracts-none">No managed repos</p>`
    : `<div class="table-scroll"><table class="data-cards data-cards-wide contracts-table">
      <thead><tr><th>Repo</th><th>Contract</th><th>Policy</th><th>Unaccepted</th><th>Deferred</th><th>Accepted</th><th>Drift</th><th>Audit</th><th>Follow-up</th><th class="hide-sm">Last scan</th><th class="hide-sm">Last audit</th></tr></thead>
      <tbody>${ordered.map(contractRow).join("\n")}</tbody>
    </table></div>`;
  const body = `${intro}
  ${table}
  <h2 class="contracts-section-title">Waived contract requirements</h2>
  ${waiverTable(waivers)}`;
  return pageShell("Contracts", "/contracts", theme, "wide", body, navCounts);
}

function findingItem(f: DriftFinding): string {
  const at = f.file ? (f.line !== undefined ? `${f.file}:${f.line}` : f.file) : null;
  return `<li class="contract-item"><div class="contract-item-head">${chip(f.rule)}${at ? `<code class="contract-loc">${escapeHtml(at)}</code>` : ""}</div>${inlineText(f.message)}</li>`;
}

function itemList(items: string[], empty: string): string {
  return items.length === 0 ? `<p class="contracts-none">${escapeHtml(empty)}</p>` : `<ul class="contract-items">${items.join("")}</ul>`;
}

function detailSection(row: ContractRow): string {
  const title = `<h2 class="contracts-section-title">${escapeHtml(contractLabel(row.contract))}</h2>`;
  const meta = (entries: Array<[string, string]>): string =>
    `<dl class="meta">${entries.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  if (row.optOut) {
    return `<section class="contract-detail-section">${title}${meta([["Policy", policyCell(row)]])}</section>`;
  }
  const s = row.snapshot;
  const base: Array<[string, string]> = [
    ["Policy", policyCell(row)],
    ["Policy doc", s?.policy.path ? `<code>${escapeHtml(s.policy.path)}</code>` : "—"],
    ["Follow-up", followUpCell(row)],
    ["Last scan", timeCell(row.scannedAt)],
    ["Last audit", lastAuditCell(row)],
  ];
  if (!s) return `<section class="contract-detail-section">${title}${meta(base)}</section>`;
  const missing = s.policy.missingRules.length > 0
    ? `<h3>Missing rules</h3>${itemList(s.policy.missingRules.map((r) => `<li class="contract-item">${inlineText(r)}</li>`), "")}`
    : "";
  const gaps = s.gaps.map((g) => {
    const waives = g.state === "accepted" ? contractRequirementsWaived(row.contract, g.text) : [];
    const chips = [chip(g.state === "accepted" ? "Accepted" : g.state === "deferred" ? "Deferred" : "Unaccepted", g.state === "unaccepted" ? "warn" : undefined),
      ...waives.map((w) => chip(`Waives: ${w}`, "warn"))].join("");
    return `<li class="contract-item${waives.length > 0 ? " waives" : ""}"><div class="contract-item-head">${chips}</div>${inlineText(g.text)}</li>`;
  });
  const unavailable = s.driftUnavailable.length > 0
    ? `<p class="contract-sub">Drift check could not run: ${s.driftUnavailable.map(escapeHtml).join("; ")}</p>`
    : "";
  const audit = row.audited
    ? `<h3>Audit findings</h3>${itemList((s.audit?.findings ?? []).map(findingItem), "No audit findings")}`
    : "";
  return `<section class="contract-detail-section">${title}${meta(base)}${missing}
    <h3>Known gaps</h3>${itemList(gaps, "No known gaps listed")}
    <h3>Drift</h3>${unavailable}${itemList(s.drift.map(findingItem), "No drift found")}
    ${audit}</section>`;
}

/** `/contracts/:owner/:name`: one repo's gaps, drift and audit findings per contract, accepted gaps that waive a contract requirement highlighted. */
export function buildContractDetailPage(repo: string, rows: readonly ContractRow[], theme: Theme, navCounts?: NavCounts): string {
  const intro = `<p class="contracts-intro"><a href="/contracts">← Contracts</a> · ${repoAvatar(repo)}${escapeHtml(repo)}</p>`;
  const body = `${intro}
  ${rows.map(detailSection).join("\n")}`;
  return pageShell(`Contracts — ${repoShortName(repo)}`, "/contracts", theme, undefined, body, navCounts);
}

/** Most characters of a gap quoted into a prefilled issue body. */
const QUOTE_CAP = 1500;

function newIssueHref(repo: string, title: string, body: string): string {
  return `/issues/new?repo=${encodeURIComponent(repo)}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

function quoteGap(text: string): string {
  const capped = text.length > QUOTE_CAP ? `${text.slice(0, QUOTE_CAP - 1)}…` : text;
  return capped.split("\n").map((l) => `> ${l}`).join("\n");
}

/** The two per-gap action links: file an issue to defer the gap, or to stop accepting it. */
function reviewActions(item: ReviewItem, policyPaths: ReadonlyMap<string, string>): string {
  const label = contractLabel(item.contract).toLowerCase();
  const short = repoShortName(item.repo);
  const path = policyPaths.get(`${item.contract}\u0000${item.repo}`);
  const where = path ? `the ${label} policy at \`${path}\`` : `the repo's ${label} policy`;
  const quoted = quoteGap(item.text);
  const defer = newIssueHref(
    item.repo,
    `chore: defer an accepted ${label} gap in ${short}`,
    [
      `This accepted Known gap in ${where} should be deferred rather than accepted:`,
      ``,
      quoted,
      ``,
      `Replace its \`${ACCEPTED_GAP_PREFIX}\` prefix with \`Deferred until YYYY-MM-DD: <reason>\` (a date at most a year ahead) or \`Deferred (#clw_<id>): <reason>\` (until that Claws issue closes).`,
    ].join("\n"),
  );
  const stop = newIssueHref(
    item.repo,
    `chore: stop accepting ${/^[aeiou]/.test(label) ? "an" : "a"} ${label} gap in ${short}`,
    [
      `This Known gap in ${where} should no longer be accepted:`,
      ``,
      quoted,
      ``,
      `Remove its \`${ACCEPTED_GAP_PREFIX}\` prefix so the daily contract scanner lists the gap in the repo's known-gaps follow-up for remediation.`,
    ].join("\n"),
  );
  return `<div class="review-actions"><a class="trigger-btn" href="${escapeHtml(defer)}">Defer</a><a class="trigger-btn" href="${escapeHtml(stop)}">Stop accepting</a></div>`;
}

function reviewItem(item: ReviewItem, policyPaths: ReadonlyMap<string, string>): string {
  const chips = [chip(contractLabel(item.contract)), ...item.waives.map((w) => chip(`Waives: ${w}`, "warn"))].join("");
  const reconfirmed = item.reconfirmedAt ? timeCell(item.reconfirmedAt) : "never";
  return `<li class="contract-item${item.waives.length > 0 ? " waives" : ""}">
      <div class="contract-item-head">${repoCell(item.repo)}${chips}</div>
      ${inlineText(item.text)}
      <div class="contract-sub">Last reconfirmed ${reconfirmed}</div>
      ${reviewActions(item, policyPaths)}
    </li>`;
}

/** The waivers sub-list then the other gaps, each only when non-empty. */
function reviewGroups(items: readonly ReviewItem[], policyPaths: ReadonlyMap<string, string>): string {
  const waiving = items.filter((i) => i.waives.length > 0);
  const other = items.filter((i) => i.waives.length === 0);
  const group = (title: string, list: readonly ReviewItem[]): string => list.length === 0 ? "" :
    `<h3 class="review-group-title">${escapeHtml(title)} (${list.length})</h3><ul class="contract-items">${list.map((i) => reviewItem(i, policyPaths)).join("")}</ul>`;
  return group("Waive a contract-level requirement", waiving) + group("Other accepted gaps", other);
}

/**
 * `/contracts/review`: the fleet-wide accepted observability gap review
 * (#clw_01M753CRBTEEXJM0QMWEZQBWN4); the intro links sentinel's page for
 * security gaps (#clw_01M75KGK2BVJVVMX73Z03ZBV5B). Gaps new or reworded since their last
 * reconfirmation first, unchanged ones collapsed, each split into contract
 * waivers and the rest; one Reconfirm all button and per-gap links that open
 * a prefilled new issue to defer the gap or stop accepting it. `items` come
 * from `buildReviewItems`, already ordered.
 */
export function buildContractsReviewPage(
  items: readonly ReviewItem[],
  rows: readonly ContractRow[],
  openDigest: { id: string } | null,
  renderedAt: Date,
  theme: Theme,
  navCounts?: NavCounts,
  flash?: string,
): string {
  const policyPaths = new Map<string, string>();
  for (const r of rows) if (r.snapshot?.policy.path) policyPaths.set(`${r.contract}\u0000${r.repo}`, r.snapshot.policy.path);
  const changed = items.filter((i) => i.changed);
  const unchanged = items.filter((i) => !i.changed);
  const repos = new Set(items.map((i) => i.repo)).size;
  const digest = openDigest
    ? ` The open review issue is <a href="/issues/${encodeURIComponent(openDigest.id)}">#${escapeHtml(shortIssueRef(openDigest.id))}</a>.`
    : "";
  const intro = `<p class="contracts-intro"><a href="/contracts">← Contracts</a> · ${items.length} accepted observability Known gap${items.length === 1 ? "" : "s"} across ${repos} repo${repos === 1 ? "" : "s"}, ${changed.length} new or reworded since the last reconfirmation.${digest} Accepted security gaps are reviewed on <a href="${escapeHtml(SECURITY_GAP_REVIEW_URL)}">sentinel's CVE exception page</a>.</p>`;
  const notice = flash ? `<p class="contracts-intro" role="status">${escapeHtml(flash)}</p>` : "";
  const form = items.length === 0 ? "" : `<form class="review-reconfirm" method="POST" action="${REVIEW_PAGE_PATH}/reconfirm">
    <input type="hidden" name="seen" value="${escapeHtml(JSON.stringify(items.map((i) => [i.contract, i.repo, gapKey(i.text)])))}">
    <button class="trigger-btn" type="submit">Reconfirm all</button>
  </form>`;
  const changedSection = changed.length === 0
    ? `<p class="contracts-none">Nothing changed since the last reconfirmation</p>`
    : reviewGroups(changed, policyPaths);
  const unchangedSection = unchanged.length === 0 ? "" : `<details class="review-unchanged">
    <summary>Unchanged (${unchanged.length})</summary>
    ${reviewGroups(unchanged, policyPaths)}
  </details>`;
  const body = `${intro}
  ${notice}
  ${form}
  <h2 class="contracts-section-title">New or reworded since last reconfirmation (${changed.length})</h2>
  ${changedSection}
  ${unchangedSection}`;
  return pageShell("Contracts — accepted gaps review", "/contracts", theme, undefined, body, navCounts);
}
