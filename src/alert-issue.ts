/**
 * Alert-issue detection, shared by promotion (`claws-issues.ts`'s
 * `shouldAutoPromote`) and the planner's stale-body stripping
 * (`agents/issue-refiner.ts`'s `stripVolatileBody`). Kept in its own leaf
 * module — no service imports — so `claws-issues.ts` and
 * `agents/issue-refiner.ts` can both depend on it without a cycle between
 * them.
 */
import type { IssueLifecycle } from "./issue-lifecycle.js";

/**
 * True for a consolidated alert-bridge body (fleet-infra's and production-infra's
 * grafana-github-alerts bridge): one issue per repo, one `### <alertname>` section per
 * alert, fully re-rendered on every firing/resolve. Detected structurally by the two
 * section headings the bridge always emits, so it doesn't depend on the bridge's wording
 * or name.
 */
export function isConsolidatedAlertBody(body: string): boolean {
  return /^## Currently firing[ \t]*$/m.test(body) && /^## Alerts[ \t]*$/m.test(body);
}

/**
 * Labels either alert bridge attaches: production-infra's `alert-issue-bridge`
 * defaults to `alert`, and fleet-infra's `grafana-github-alerts` deployment
 * sets `grafana-alert`.
 */
export const ALERT_ISSUE_LABELS = ["alert", "grafana-alert"];

/**
 * True when `issue` is an alert issue: it carries one of {@link ALERT_ISSUE_LABELS}
 * exactly, or its body matches {@link isConsolidatedAlertBody} — a bridge issue
 * imported or shadowed without its label.
 */
export function isAlertIssue(issue: { labels: readonly string[]; body: string }): boolean {
  return issue.labels.some((label) => ALERT_ISSUE_LABELS.includes(label)) || isConsolidatedAlertBody(issue.body);
}

/**
 * True when `issue` is an alert bridge's inbox, never a dedicated issue: it is an
 * {@link isAlertIssue}, or it carries the repo's configured bridge `label` and was
 * filed under the bridge `title` (`filedTitle` survives a retitle). `bridge` is the
 * repo's `alertBridge` config, absent when it has none.
 */
export function isAlertInbox(
  issue: { title: string; filedTitle?: string | null; labels: readonly string[]; body: string },
  bridge?: { label: string; title: string } | null,
): boolean {
  if (isAlertIssue(issue)) return true;
  return !!bridge && issue.labels.includes(bridge.label) && (issue.filedTitle ?? issue.title) === bridge.title;
}

/** The footer production-infra's `alert-issue-bridge` writes on every issue it manages. */
export const ALERT_BRIDGE_FOOTER = "Automatically managed by alert-issue-bridge";

/**
 * True when an alert bridge owns `issue`: it opens, rewrites, reopens and
 * closes it, so Claws must not close it or re-plan on its rewrites. That is
 * {@link isAlertIssue}, or a body carrying {@link ALERT_BRIDGE_FOOTER}.
 */
export function isAlertBridgeOwned(issue: { labels: readonly string[]; body: string }): boolean {
  return isAlertIssue(issue) || issue.body.includes(ALERT_BRIDGE_FOOTER);
}

// ── Inbox sections and triage rows (docs/issue-tracker.md "Alert bridges") ──

/**
 * The dedupe key of the dedicated issue that tracks `alertname`: `alert-`
 * then the alertname lower-cased, every run of characters outside `[a-z0-9]`
 * replaced by `-`, cut to 90 characters and stripped of leading/trailing `-`
 * (`unknown` when nothing is left). Both bridges' `alert_dedupe_key`
 * implement the same rule, so keep the three in step.
 */
export function alertDedupeKey(alertname: string): string {
  const slug = alertname.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 90).replace(/^-+|-+$/g, "");
  return `alert-${slug || "unknown"}`;
}

/** Prefix of the Blocked reason the planner parks a triaged alert inbox with. */
export const ALERT_TRIAGE_BLOCKED_PREFIX = "Alert triage:";

/**
 * True for the lifecycles that hold an alert issue: a reopen or a new
 * untriaged section leaves it there instead of moving it to planning.
 * `ideas` waits for its requirements to be promoted and `backlog` is an
 * operator's hold. `blocked` is deliberately not one: the planner parks a
 * triaged inbox there, and new work must wake it.
 */
export function isHeldAlertLifecycle(lifecycle: IssueLifecycle): boolean {
  return lifecycle === "ideas" || lifecycle === "backlog";
}

/** One section's triage outcome, as {@link annotateAlertTriage} writes it. */
export interface AlertTriageVerdict {
  alertname: string;
  verdict: "transient" | "tracked";
  /** Why a `transient` section needs no work. */
  reason?: string | null;
  /** The `clw_…` id of the issue tracking a `tracked` section. */
  issueId?: string | null;
}

const TRIAGE_ROW = /^\|[ \t]*(?:Triage|Tracked)[ \t]*\|/;

interface AlertSection {
  name: string;
  /** Index of the `### ` heading line. */
  start: number;
  /** Index one past the section's last line. */
  end: number;
}

/**
 * The `### <alertname>` sections between `## Alerts` and the bridge footer
 * (the line carrying {@link ALERT_BRIDGE_FOOTER}, which both bridges write), or
 * the next `## ` heading or end of body when there is no footer.
 */
function parseAlertSections(lines: readonly string[]): AlertSection[] {
  const alerts = lines.findIndex((line) => /^## Alerts[ \t]*$/.test(line));
  if (alerts < 0) return [];
  let stop = lines.length;
  for (let i = alerts + 1; i < lines.length; i++) {
    if (lines[i]!.includes(ALERT_BRIDGE_FOOTER) || /^## /.test(lines[i]!)) {
      stop = i;
      break;
    }
  }
  const sections: AlertSection[] = [];
  for (let i = alerts + 1; i < stop; i++) {
    if (!lines[i]!.startsWith("### ")) continue;
    const previous = sections.at(-1);
    if (previous) previous.end = i;
    sections.push({ name: lines[i]!.slice(4).trim(), start: i, end: stop });
  }
  return sections;
}

function bodyLines(body: string): string[] {
  return body.replace(/\r\n/g, "\n").split("\n");
}

/** Every alertname with a section in a consolidated alert body, in body order. */
export function alertSectionNames(body: string): string[] {
  return parseAlertSections(bodyLines(body)).map((section) => section.name);
}

/** The sections carrying neither a `| Triage |` nor a `| Tracked |` row, in body order. */
export function untriagedAlertSections(body: string): string[] {
  const lines = bodyLines(body);
  return parseAlertSections(lines)
    .filter((section) => !lines.slice(section.start, section.end).some((line) => TRIAGE_ROW.test(line)))
    .map((section) => section.name);
}

function triageCell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/**
 * Write each verdict into its section as the table's last row —
 * `| Triage | transient — <reason> |` or `| Tracked | #clw_… |` — replacing
 * any Triage/Tracked row already there. A verdict for an alertname with no
 * section, or a section with no table, is skipped.
 */
export function annotateAlertTriage(body: string, verdicts: readonly AlertTriageVerdict[]): string {
  const lines = bodyLines(body);
  const byName = new Map(verdicts.map((v) => [v.alertname, v]));
  // Back to front, so splicing a section never shifts an earlier one.
  for (const section of parseAlertSections(lines).reverse()) {
    const verdict = byName.get(section.name);
    if (!verdict) continue;
    const row = verdict.verdict === "tracked"
      ? `| Tracked | #${triageCell(verdict.issueId ?? "")} |`
      : `| Triage | transient — ${triageCell(verdict.reason ?? "")} |`;
    const kept = lines.slice(section.start, section.end).filter((line) => !TRIAGE_ROW.test(line));
    let lastRow = -1;
    kept.forEach((line, i) => { if (line.startsWith("|")) lastRow = i; });
    if (lastRow < 0) continue;
    kept.splice(lastRow + 1, 0, row);
    lines.splice(section.start, section.end - section.start, ...kept);
  }
  return lines.join("\n");
}
