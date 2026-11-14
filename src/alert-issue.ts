/**
 * Alert-issue detection, shared by promotion (`claws-issues.ts`'s
 * `shouldAutoPromote`) and the planner's stale-body stripping
 * (`agents/issue-refiner.ts`'s `stripVolatileBody`). Kept in its own leaf
 * module — no service imports — so `claws-issues.ts` and
 * `agents/issue-refiner.ts` can both depend on it without a cycle between
 * them.
 */
import crypto from "node:crypto";
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

// ── Alert group keys (docs/issue-tracker.md "Alert bridges") ──

/** The separator between a group name's service and alert parts. */
const GROUP_SEPARATOR = " / ";

/**
 * A bridge group name split on its first ` / `: `<service> / <alert>` gives
 * both parts, and a bare name (an alert with no service identity) gives an
 * empty `service` and the whole name as `alert`.
 */
export function splitAlertGroupName(name: string): { service: string; alert: string } {
  const at = name.indexOf(GROUP_SEPARATOR);
  if (at < 0) return { service: "", alert: name.trim() };
  return { service: name.slice(0, at).trim(), alert: name.slice(at + GROUP_SEPARATOR.length).trim() };
}

/**
 * Lower-case `value`, replace every run of characters outside `[a-z0-9]` by
 * `-`, cut to 90 characters and strip leading/trailing `-` (`unknown` when
 * nothing is left).
 */
function alertKeySlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 90).replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * The legacy dedupe key of a service's dedicated alert issue,
 * `alert-service-<slug>`: issues filed before keys were per alert group hold
 * it, and the poller's legacy adoption gives such an issue its group key.
 */
export function serviceDedupeKey(service: string): string {
  return `alert-service-${alertKeySlug(service)}`;
}

/** Longest service slug in an {@link alertGroupKey}. */
const GROUP_SERVICE_SLUG_MAX = 40;
/** Longest alert slug in an {@link alertGroupKey}. */
const GROUP_ALERT_SLUG_MAX = 45;

/**
 * {@link alertKeySlug}'s rule without its 90-character cut, bounded to `max`
 * instead: a longer slug is cut 9 short and gets `-` plus the first 8 hex of
 * its SHA-256, so two long names sharing a prefix never collide.
 */
function boundedAlertSlug(value: string, max: number): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  if (slug.length <= max) return slug;
  const hash = crypto.createHash("sha256").update(slug).digest("hex").slice(0, 8);
  return `${slug.slice(0, max - 9)}-${hash}`;
}

/** The `alert-group-<service-slug>.` prefix every {@link alertGroupKey} of `service` starts with. */
function alertGroupKeyPrefix(service: string): string {
  return `alert-group-${boundedAlertSlug(service, GROUP_SERVICE_SLUG_MAX)}.`;
}

/**
 * The exact dedupe key of the issue tracking the alert group `name`:
 * `alert-group-<service-slug>.<alert-slug>` for `<service> / <alert>` (service
 * slug at most 40 characters, alert slug at most 45), and
 * {@link legacyAlertDedupeKey} for a bare alertname. Slugs never hold a `.`,
 * so the dot always marks the service boundary.
 */
export function alertGroupKey(name: string): string {
  const { service, alert } = splitAlertGroupName(name);
  if (!service) return legacyAlertDedupeKey(name);
  return `${alertGroupKeyPrefix(service)}${boundedAlertSlug(alert, GROUP_ALERT_SLUG_MAX)}`;
}

/**
 * The repos a bridge's `serviceRepos` map names as owning the service whose
 * dedicated issue holds `dedupeKey`: every entry whose service an
 * {@link alertGroupKey} key names, deduplicated case-insensitively. Empty for
 * a missing map or a key that is not a group key.
 */
export function alertOwnerRepos(
  bridge: { serviceRepos?: Readonly<Record<string, readonly string[]>> } | null | undefined,
  dedupeKey: string,
): string[] {
  const map = bridge?.serviceRepos;
  if (!map) return [];
  if (!dedupeKey.startsWith("alert-group-")) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [service, repos] of Object.entries(map)) {
    if (!dedupeKey.startsWith(alertGroupKeyPrefix(service))) continue;
    for (const repo of repos) {
      if (seen.has(repo.toLowerCase())) continue;
      seen.add(repo.toLowerCase());
      out.push(repo);
    }
  }
  return out;
}

/**
 * The per-alertname dedupe key, `alert-<slug>`: the key of an alert with no
 * service identity, and the key a dedicated issue held before keys were per
 * service.
 */
export function legacyAlertDedupeKey(alert: string): string {
  return `alert-${alertKeySlug(alert)}`;
}

/**
 * True for the lifecycles that hold an alert issue: a reopen leaves it there
 * instead of moving it to planning. `ideas` waits for its requirements to be
 * promoted and `backlog` is an operator's hold. `blocked` is deliberately not
 * one: new work must wake a blocked alert issue.
 */
export function isHeldAlertLifecycle(lifecycle: IssueLifecycle): boolean {
  return lifecycle === "ideas" || lifecycle === "backlog";
}
