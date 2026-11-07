/**
 * Claws' Alertmanager poller (#clw_01M6NVG8QYJ0MN59X0Q3CWR932): for every repo
 * whose `claws.json` sets `alertBridge.poll`, read the cluster Alertmanager's
 * active alerts through that cluster's Grafana (its provisioned Alertmanager
 * datasource proxy, authenticated by the Claws-signed observability JWT) and
 * keep the repo's consolidated alert inbox from them, in-process. It replaces
 * the push bridge — production-infra's `alert-issue-bridge` — so the cluster
 * holds no Claws token and initiates nothing towards Claws.
 *
 * The body model is a port of that bridge's `server.py` and must stay
 * byte-compatible with it and with fleet-infra's `grafana-github-alerts`:
 * one `### <service> / <alert>` section per group, the `TABLE_ROWS` table with
 * the planner's Triage/Tracked rows last, the hidden firing/seen/triaged
 * instance lines, the footer carrying {@link ALERT_BRIDGE_FOOTER}, and Claws'
 * trailing occurrence block. See docs/issue-tracker.md "Alert bridges".
 *
 * Differences from the push model:
 * - every poll lists the whole active set, so an occurrence is counted only
 *   when a section gains a new firing instance or goes resolved→firing;
 * - resolution is an instance's absence from two consecutive successful
 *   polls; the first poll after start only primes, and a failed poll touches
 *   nothing;
 * - `mode: "shadow"` computes every decision and logs it, writing nothing.
 */
import crypto from "node:crypto";
import { isJobDisabledForRepo } from "../config.js";
import * as log from "../log.js";
import { listRepoConfigs, type RepoAlertBridgePoll } from "../repo-config.js";
import { grafanaUrl, mintGrafanaJwt, type GrafanaCluster } from "../grafana-jwt.js";
import { setAlertmanagerPollOk } from "../metrics.js";
import { ALERT_BRIDGE_FOOTER } from "../alert-issue.js";
import { withIssueActor, type IssueActor } from "../issue-history-actor.js";
import {
  createInbox,
  listOpenInboxes,
  listRecentlyClosedInboxes,
  routeAlertEvents,
  updateInbox,
  MAX_ALERT_INSTANCES,
  type AlertEvent,
  type Bridge,
} from "../alert-bridge.js";
import type * as db from "../db.js";
import { toIso } from "../claws-issues.js";

const NAME = "alertmanager-poller";

/** How a poller write reads in the issue's History. */
const POLLER_ACTOR: IssueActor = { kind: "automation", name: "alertmanager poller" };

const JWT_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

const MAX_DESCRIPTION = 1000;
/** Under Claws' 65,536-character body cap, so a long-lived flapping inbox stays readable. */
export const MAX_ISSUE_BODY = 60_000;
const SHORT_DESCRIPTION = 200;
/** Must keep {@link ALERT_BRIDGE_FOOTER}: triage and `isAlertBridgeOwned` key on it. */
const FOOTER_PREFIX = `*${ALERT_BRIDGE_FOOTER}.`;
const ZERO_TIME = "0001-01-01T00:00:00Z";

// ── Time helpers ──

function fmtTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Parse an RFC 3339 timestamp (any fractional precision). Null if unparseable. */
function parseTime(value: string | undefined | null): Date | null {
  if (!value || value === ZERO_TIME) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value.trim());
  if (!m) return null;
  const tz = m[3] === "Z" ? "+00:00" : m[3]!;
  const ms = Date.parse(`${m[1]}${tz}`);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (date.getUTCFullYear() <= 1) return null;
  return date;
}

function normTime(value: string | undefined, fallback: string): string {
  const date = parseTime(value);
  return date ? fmtTime(date) : fallback;
}

// ── Alert grouping ──

/** One alert as Alertmanager's `GET /api/v2/alerts` lists it (gettableAlert). */
export interface AlertmanagerAlert {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}

function oneLine(text: unknown): string {
  return String(text ?? "").split(/\s+/).filter(Boolean).join(" ");
}

/**
 * The name an alert is sectioned, tracked and deduplicated under: a non-empty
 * `claws_alertname` label, else `alertname`; "" when neither is set.
 */
export function effectiveAlertname(labels: Record<string, string> | undefined): string {
  return oneLine(labels?.claws_alertname ?? "") || oneLine(labels?.alertname ?? "");
}

/**
 * Labels naming the service an alert belongs to, in precedence order. Must
 * match both bridges' `SERVICE_LABELS`.
 */
const SERVICE_LABELS = ["claws_service", "exported_service", "app", "deployment", "statefulset", "daemonset", "cronjob", "node", "host"] as const;
const GROUP_SEPARATOR = " / ";

/** The first non-empty {@link SERVICE_LABELS} value, one-lined; "" for a cluster-wide alert. */
export function serviceOf(labels: Record<string, string> | undefined): string {
  for (const label of SERVICE_LABELS) {
    const value = oneLine(labels?.[label] ?? "");
    if (value) return value;
  }
  return "";
}

/** `<service> / <effective alertname>`, the bare alertname with no service, "" with neither. */
export function groupName(labels: Record<string, string> | undefined): string {
  const name = effectiveAlertname(labels);
  const service = serviceOf(labels);
  return service && name ? `${service}${GROUP_SEPARATOR}${name}` : name;
}

/** Stable identity of one alert instance: Alertmanager's fingerprint, else a 16-hex label-set hash. */
export function instanceKey(alert: AlertmanagerAlert): string {
  const fp = oneLine(alert.fingerprint ?? "");
  if (fp && /^[0-9A-Za-z]+$/.test(fp)) return fp;
  const pairs = Object.entries(alert.labels ?? {})
    .map(([k, v]) => [String(k), String(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  // Python json.dumps of the sorted pairs, matching the push bridge's hash.
  const canon = `[${pairs.map(([k, v]) => `[${JSON.stringify(k)}, ${JSON.stringify(v)}]`).join(", ")}]`;
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

function alertTexts(alert: AlertmanagerAlert): [string, string] {
  const annotations = alert.annotations ?? {};
  let description = oneLine(annotations.description || "No description provided");
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  return [oneLine(annotations.summary || "No summary provided"), description];
}

/** One group of active alert instances. */
export interface AlertGroup {
  instances: { key: string; startsAt: string }[];
  firingKeys: Set<string>;
  severity: string;
  startsAt: string;
  summary: string;
  description: string;
  texts: Map<string, [string, string]>;
  dashboard: string;
  generatorUrl: string;
}

/** Group active alert instances by {@link groupName}, preserving first-seen order. */
export function groupAlerts(alerts: readonly AlertmanagerAlert[]): Map<string, AlertGroup> {
  const byName = new Map<string, AlertmanagerAlert[]>();
  for (const alert of alerts) {
    if (alert === null || typeof alert !== "object") continue;
    const name = groupName(alert.labels) || "Unknown";
    const list = byName.get(name) ?? [];
    list.push(alert);
    byName.set(name, list);
  }
  const groups = new Map<string, AlertGroup>();
  for (const [name, instances] of byName) {
    const rep = instances[0]!;
    const [summary, description] = alertTexts(rep);
    groups.set(name, {
      instances: instances.map((a) => ({ key: instanceKey(a), startsAt: oneLine(a.startsAt ?? "") })),
      firingKeys: new Set(instances.map(instanceKey)),
      severity: oneLine(rep.labels?.severity ?? "unknown") || "unknown",
      startsAt: rep.startsAt ?? "",
      summary,
      description,
      texts: new Map(instances.map((a) => [instanceKey(a), alertTexts(a)])),
      dashboard: oneLine(rep.annotations?.dashboard ?? ""),
      generatorUrl: oneLine(rep.generatorURL ?? ""),
    });
  }
  return groups;
}

// ── Body model ──

/** One `### <group>` section of the inbox. */
export interface Section {
  severity: string;
  status: "firing" | "resolved";
  first: string;
  last: string;
  count: number;
  resolved: string;
  dashboard: string;
  source: string;
  triage: string;
  tracked: string;
  summary: string;
  description: string;
  /** Firing instance keys (`<!-- firing-instances: -->`). */
  instances: Set<string>;
  /** Every key fired since the section was last (re)triaged (`<!-- seen-instances: -->`). */
  seen: Set<string>;
  /** Keys a transient verdict covers (`<!-- triaged-instances: -->`), empty without a Triage row. */
  triaged: Set<string>;
}

export interface InboxState {
  firstSeen: string;
  lastSeen: string;
  total: number;
  sections: Map<string, Section>;
}

type SectionField = "severity" | "status" | "first" | "last" | "count" | "resolved" | "dashboard" | "source" | "triage" | "tracked";

const TABLE_ROWS: readonly (readonly [string, SectionField])[] = [
  ["Severity", "severity"],
  ["Status", "status"],
  ["First occurrence", "first"],
  ["Last occurrence", "last"],
  ["Occurrences", "count"],
  ["Resolved", "resolved"],
  ["Dashboard", "dashboard"],
  ["Source", "source"],
  ["Triage", "triage"],
  ["Tracked", "tracked"],
];
const OPTIONAL_ROWS = new Set<SectionField>(["dashboard", "source", "triage", "tracked"]);
const ROW_FIELD = new Map<string, SectionField>(TABLE_ROWS.map(([k, f]) => [k, f]));
const ROW_RE = new RegExp(`^\\| (${TABLE_ROWS.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}) \\| (.*) \\|$`);
const INSTANCES_PREFIX = "<!-- firing-instances: ";
const INSTANCES_SUFFIX = " -->";
const SEEN_PREFIX = "<!-- seen-instances: ";
const TRIAGED_PREFIX = "<!-- triaged-instances: ";

export function newState(now: string): InboxState {
  return { firstSeen: now, lastSeen: now, total: 0, sections: new Map() };
}

function cell(value: string | number): string {
  return String(value).replace(/\|/g, "\\|");
}

function uncell(value: string): string {
  return value.replace(/\\\|/g, "|");
}

function sortedKeys(keys: Set<string>): string {
  return [...keys].sort().join(",");
}

/** True when every section is resolved or tracked by a dedicated issue. */
export function allResolved(state: InboxState): boolean {
  return [...state.sections.values()].every((s) => s.status === "resolved" || !!s.tracked);
}

/** What the body names besides the state: the repo, the cluster Grafana and the reopen window. */
export interface RenderContext {
  repo: string;
  grafanaUrl: string;
  reopenWindowHours: number;
}

/** The links line both bridges render under the intro. */
function linksMarkdown(url: string): string {
  return `[📊 Grafana](${url}) · [📈 Explore metrics](${url}/explore) · [📜 Explore logs](${url}/explore)`;
}

export function renderBody(state: InboxState, ctx: RenderContext): string {
  const lines: string[] = [
    `Alertmanager alerts for ${ctx.repo}. One section per service and alert; `
      + "this issue closes when every section is resolved or tracked by its own issue.",
    "",
  ];
  if (ctx.grafanaUrl) lines.push(linksMarkdown(ctx.grafanaUrl), "");
  lines.push("## Currently firing", "");
  const firing = [...state.sections].filter(([, s]) => s.status === "firing");
  if (firing.length > 0) {
    for (const [n, s] of firing) lines.push(`- ${n} (${s.severity})${s.tracked ? ` — tracked in ${s.tracked}` : ""}`);
  } else {
    lines.push("- none");
  }
  lines.push("", "## Alerts", "");
  for (const [name, s] of state.sections) {
    lines.push(`### ${name}`, "", "| Field | Value |", "|---|---|");
    for (const [key, field] of TABLE_ROWS) {
      const value = s[field];
      if (OPTIONAL_ROWS.has(field) && !value) continue;
      lines.push(`| ${key} | ${cell(value)} |`);
    }
    lines.push(
      "",
      `${INSTANCES_PREFIX}${sortedKeys(s.instances)}${INSTANCES_SUFFIX}`,
      `${SEEN_PREFIX}${sortedKeys(s.seen)}${INSTANCES_SUFFIX}`,
    );
    if (s.triage) lines.push(`${TRIAGED_PREFIX}${sortedKeys(s.triaged)}${INSTANCES_SUFFIX}`);
    lines.push("", `**Summary:** ${s.summary}`, "", `**Description:** ${s.description}`, "");
  }
  lines.push(
    `${FOOTER_PREFIX} Closed when every alert above is resolved or tracked; `
      + `reopened if an untracked alert re-fires within ${formatHours(ctx.reopenWindowHours)} hours.*`,
    "",
    "---",
    `**First seen:** ${state.firstSeen}`,
    `**Last seen:** ${state.lastSeen}`,
    `**Occurrences:** ${state.total}`,
  );
  return lines.join("\n");
}

/** Python's `f"{x:g}"` for the reopen window: `24`, `6`, `1.5`. */
function formatHours(hours: number): string {
  return String(Number(hours.toPrecision(6)));
}

/**
 * Render the body, pruning `state` until it fits {@link MAX_ISSUE_BODY}: the
 * oldest resolved sections first, then descriptions are shortened. Firing
 * sections are never dropped.
 */
export function renderBounded(state: InboxState, ctx: RenderContext): string {
  let body = renderBody(state, ctx);
  if (body.length <= MAX_ISSUE_BODY) return body;
  const minTime = -Infinity;
  const resolved = [...state.sections]
    .filter(([, s]) => s.status === "resolved")
    .sort((a, b) => (parseTime(a[1].resolved)?.getTime() ?? minTime) - (parseTime(b[1].resolved)?.getTime() ?? minTime));
  const dropped: string[] = [];
  for (const [name] of resolved) {
    state.sections.delete(name);
    dropped.push(name);
    body = renderBody(state, ctx);
    if (body.length <= MAX_ISSUE_BODY) break;
  }
  let shortened = false;
  if (body.length > MAX_ISSUE_BODY) {
    for (const s of state.sections.values()) {
      if (s.description.length > SHORT_DESCRIPTION) {
        s.description = `${s.description.slice(0, SHORT_DESCRIPTION - 1)}…`;
        shortened = true;
      }
    }
    body = renderBody(state, ctx);
  }
  if (body.length > MAX_ISSUE_BODY) {
    for (const s of state.sections.values()) {
      s.summary = s.summary.length > SHORT_DESCRIPTION ? `${s.summary.slice(0, SHORT_DESCRIPTION - 1)}…` : s.summary;
      s.description = s.description.length > 40 ? `${s.description.slice(0, 39)}…` : s.description;
    }
    body = renderBody(state, ctx);
    if (body.length > MAX_ISSUE_BODY) {
      log.error(`[${NAME}] alert issue body still over size limit after pruning`, { bridge_repo: ctx.repo, length: body.length });
    }
  }
  log.warn(`[${NAME}] alert issue body over size limit, pruned`, {
    bridge_repo: ctx.repo, dropped: dropped.join(", "), shortened_descriptions: shortened, length: body.length,
  });
  return body;
}

/** Claws' trailing occurrence block; missing fields come back null. */
function parseTracking(body: string): { firstSeen: string | null; lastSeen: string | null; total: number | null } {
  const first = /^\*\*First seen:\*\* (.+)$/m.exec(body);
  const last = /^\*\*Last seen:\*\* (.+)$/m.exec(body);
  const total = /^\*\*Occurrences:\*\* (\d+)\s*$/m.exec(body);
  return {
    firstSeen: first ? first[1]!.trim() : null,
    lastSeen: last ? last[1]!.trim() : null,
    total: total ? Number(total[1]) : null,
  };
}

type PartialSection = Partial<Omit<Section, "count" | "seen" | "triaged">> & {
  count?: string | number;
  seen: Set<string> | null;
  triaged: Set<string> | null;
  instances: Set<string>;
};

function keySet(line: string, prefix: string): Set<string> {
  return new Set(line.slice(prefix.length, -INSTANCES_SUFFIX.length).split(",").filter(Boolean));
}

/** Parse a rendered body back into state. Null if it is not ours or was hand-edited. */
export function parseBody(body: string): InboxState | null {
  if (!body) return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf("## Alerts");
  if (start < 0) return null;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith(FOOTER_PREFIX)) { end = i; break; }
  }
  if (end < 0) return null;
  const { firstSeen, lastSeen, total } = parseTracking(body);
  if (firstSeen === null || lastSeen === null || total === null) return null;

  const partial = new Map<string, PartialSection>();
  let current: PartialSection | null = null;
  for (const line of lines.slice(start + 1, end)) {
    if (line.startsWith("### ")) {
      current = { dashboard: "", source: "", triage: "", tracked: "", instances: new Set(), seen: null, triaged: null };
      partial.set(line.slice(4), current);
      continue;
    }
    if (current === null) {
      if (line.trim()) return null;
      continue;
    }
    const m = ROW_RE.exec(line);
    if (m) {
      (current as Record<string, unknown>)[ROW_FIELD.get(m[1]!)!] = uncell(m[2]!);
    } else if (line.startsWith("**Summary:** ")) {
      current.summary = line.slice("**Summary:** ".length);
    } else if (line.startsWith("**Description:** ")) {
      current.description = line.slice("**Description:** ".length);
    } else if (line.startsWith(INSTANCES_PREFIX) && line.endsWith(INSTANCES_SUFFIX)) {
      current.instances = keySet(line, INSTANCES_PREFIX);
    } else if (line.startsWith(SEEN_PREFIX) && line.endsWith(INSTANCES_SUFFIX)) {
      current.seen = keySet(line, SEEN_PREFIX);
    } else if (line.startsWith(TRIAGED_PREFIX) && line.endsWith(INSTANCES_SUFFIX)) {
      current.triaged = keySet(line, TRIAGED_PREFIX);
    }
  }

  const required = [...TABLE_ROWS.map(([, f]) => f), "summary", "description"] as const;
  const sections = new Map<string, Section>();
  for (const [name, s] of partial) {
    if (!required.every((f) => (s as Record<string, unknown>)[f] !== undefined)) return null;
    if (s.status !== "firing" && s.status !== "resolved") return null;
    const count = String(s.count).trim();
    if (!/^[+-]?\d+$/.test(count)) return null;
    const seen = s.seen ?? new Set(s.instances);
    const triaged = !s.triage ? new Set<string>() : s.triaged ?? new Set(seen);
    sections.set(name, { ...(s as Section), count: Number(count), seen, triaged });
  }
  return { firstSeen, lastSeen, total, sections };
}

/**
 * Parse an inbox body, falling back to a fresh state that keeps its
 * occurrence block. `rebuilt` is true when the body did not parse.
 */
export function stateFromBody(body: string, now: string, ctx: { repo: string; issue: string }): { state: InboxState; rebuilt: boolean } {
  const parsed = parseBody(body);
  if (parsed) return { state: parsed, rebuilt: false };
  log.warn(`[${NAME}] alert issue body unparseable, rebuilding sections from the active alerts`, { bridge_repo: ctx.repo, inbox_issue: ctx.issue });
  const state = newState(now);
  const tracking = parseTracking(body);
  if (tracking.firstSeen) state.firstSeen = tracking.firstSeen;
  if (tracking.lastSeen) state.lastSeen = tracking.lastSeen;
  if (tracking.total !== null) state.total = tracking.total;
  return { state, rebuilt: true };
}

/**
 * Fold one poll's active groups into `state`. Returns the group names changed.
 *
 * `tracked` maps each group name a dedicated issue tracks to that issue's id.
 * A tracked group adds no section; an existing one only gets its Tracked row
 * and is otherwise frozen. An untracked firing counts one occurrence only when
 * it adds a section, goes resolved→firing or brings a new instance; a
 * transient-triaged section firing for an instance its verdict did not cover
 * loses its Triage row. Tracked names with no active group (a resolve on a
 * tracked alert) still get their Tracked row.
 */
export function applyGroups(state: InboxState, groups: ReadonlyMap<string, AlertGroup>, now: string, tracked: ReadonlyMap<string, string>): string[] {
  const changed = new Set<string>();
  const markTracked = (name: string, s: Section | undefined, id: string) => {
    const row = `#${id}`;
    if (s !== undefined && (s.tracked !== row || s.triage)) {
      s.tracked = row;
      s.triage = "";
      s.triaged = new Set();
      s.seen = new Set(s.instances);
      changed.add(name);
    }
  };
  for (const [name, id] of tracked) {
    if (!groups.has(name)) markTracked(name, state.sections.get(name), id);
  }
  for (const [name, g] of groups) {
    let s = state.sections.get(name);
    const trackedId = tracked.get(name);
    if (trackedId !== undefined) {
      markTracked(name, s, trackedId);
      continue;
    }
    let added = false;
    if (s === undefined) {
      s = {
        severity: g.severity, status: "firing", first: normTime(g.startsAt, now), last: now, count: 0, resolved: "-",
        dashboard: "", source: "", triage: "", tracked: "", summary: g.summary, description: g.description,
        instances: new Set(), seen: new Set(), triaged: new Set(),
      };
      state.sections.set(name, s);
      added = true;
    }
    let cleared = false;
    if (s.tracked) {
      // The dedicated issue closed and this firing is untracked: the section
      // is untriaged again and its frozen instances are stale.
      s.tracked = "";
      s.triage = "";
      s.triaged = new Set();
      s.instances = new Set();
      cleared = true;
    }
    const wasResolved = s.status === "resolved";
    if (wasResolved) s.instances = new Set();
    const newKeys = [...g.firingKeys].filter((k) => !s.instances.has(k));
    s.instances = new Set([...s.instances, ...g.firingKeys]);
    const bump = added || wasResolved || newKeys.length > 0;
    let uncovered: string[] = [];
    if (s.triage) {
      uncovered = [...g.texts.keys()].filter((k) => !s.triaged.has(k));
      if (uncovered.length > 0) {
        log.info(`[${NAME}] transient section fired for uncovered instances, verdict cleared`, { section: name, new_instances: uncovered.sort().join(",") });
        s.triage = "";
        s.triaged = new Set();
        cleared = true;
      }
    }
    if (!bump && !cleared) continue;
    if (bump) {
      s.status = "firing";
      s.last = now;
      s.count += 1;
      s.resolved = "-";
      state.total += 1;
      state.lastSeen = now;
    }
    changed.add(name);
    // A triaged transient section firing only for covered instances keeps its triaged text.
    if (s.triage) continue;
    const [summary, description] = uncovered.length > 0 ? g.texts.get(uncovered[0]!)! : [g.summary, g.description];
    s.severity = g.severity;
    s.summary = summary;
    s.description = description;
    s.dashboard = g.dashboard;
    s.source = g.generatorUrl;
    s.seen = cleared ? new Set(s.instances) : new Set([...s.seen, ...g.firingKeys]);
  }
  return [...changed];
}

/**
 * Drop firing instances in neither `keep` set. A section left with none is
 * resolved at `now`. Tracked sections are frozen. Returns the names changed.
 */
export function pruneStaleInstances(state: InboxState, keep: ReadonlySet<string>, now: string): string[] {
  const changed: string[] = [];
  for (const [name, s] of state.sections) {
    if (s.status !== "firing" || s.tracked) continue;
    const remaining = new Set([...s.instances].filter((k) => keep.has(k)));
    if (remaining.size === s.instances.size) continue;
    s.instances = remaining;
    if (remaining.size === 0) {
      s.status = "resolved";
      s.resolved = now;
    }
    changed.push(name);
  }
  return changed;
}

// ── Fetch ──

export type FetchResult =
  | { ok: true; alerts: AlertmanagerAlert[]; durationMs: number }
  | { ok: false; httpStatus?: number; probeError?: string; durationMs: number };

/** Error code for a thrown fetch error, never its message. */
function errorCode(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const code = [e?.cause?.code, e?.code, e?.name].find((c): c is string => typeof c === "string" && c !== "");
  return code ?? "unknown";
}

/** The Alertmanager alert-list URL through `cluster`'s Grafana datasource proxy. */
export function alertsUrl(cluster: GrafanaCluster, datasourceUid: string): string {
  return `${grafanaUrl(cluster)}/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}/api/v2/alerts?active=true&silenced=false&inhibited=false`;
}

/** Fetch `cluster`'s active, unsilenced, uninhibited alerts. Never throws. */
export async function fetchActiveAlerts(cluster: GrafanaCluster, datasourceUid: string): Promise<FetchResult> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  try {
    const res = await fetch(alertsUrl(cluster, datasourceUid), {
      headers: { Authorization: `Bearer ${mintGrafanaJwt(cluster, JWT_TTL_MS)}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, httpStatus: res.status, durationMs: elapsed() };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, httpStatus: 200, probeError: "unparseable", durationMs: elapsed() };
    }
    if (!Array.isArray(body) || !body.every((a) => a !== null && typeof a === "object" && !Array.isArray(a))) {
      return { ok: false, httpStatus: 200, probeError: "unparseable", durationMs: elapsed() };
    }
    return { ok: true, alerts: body as AlertmanagerAlert[], durationMs: elapsed() };
  } catch (err) {
    return { ok: false, probeError: errorCode(err), durationMs: elapsed() };
  }
}

// ── Poll cycle ──

/** Each repo's active instance keys from its last successful poll. */
const previousActive = new Map<string, Set<string>>();

/** Test-only: forget every repo's previous poll. */
export function resetAlertmanagerPollerForTest(): void {
  previousActive.clear();
}

type PolledBridge = Bridge & { poll: RepoAlertBridgePoll };

/** One open inbox's parsed state and the groups routed to it. */
interface RoutedInbox {
  record: db.ClawsIssueRecord;
  state: InboxState;
  rebuilt: boolean;
  groups: Map<string, AlertGroup>;
}

/** A group goes to every inbox holding its section; one held by none goes to the oldest. */
function routeGroups(records: db.ClawsIssueRecord[], groups: ReadonlyMap<string, AlertGroup>, now: string, repo: string): RoutedInbox[] {
  const routed = records.map((record) => ({ record, ...stateFromBody(record.body, now, { repo, issue: record.id }), groups: new Map<string, AlertGroup>() }));
  for (const [name, g] of groups) {
    const owners = routed.filter((r) => r.state.sections.has(name));
    for (const r of owners.length > 0 ? owners : routed.slice(0, 1)) r.groups.set(name, g);
  }
  return routed;
}

function firingAndResolved(state: InboxState): { firing: number; resolved: number } {
  const all = [...state.sections.values()];
  return { firing: all.filter((s) => s.status === "firing").length, resolved: all.filter((s) => s.status === "resolved").length };
}

/** Log one inbox decision; in write mode also apply it. */
async function decide(
  bridge: PolledBridge,
  decision: "create" | "update" | "close" | "reopen",
  record: db.ClawsIssueRecord | null,
  state: InboxState,
  body: string,
  changed: readonly string[],
): Promise<void> {
  const shadow = bridge.poll.mode === "shadow";
  const fields = {
    bridge_repo: bridge.repo,
    cluster: bridge.poll.cluster,
    mode: bridge.poll.mode,
    decision,
    inbox_issue: record?.id ?? "",
    sections: changed.join(", "),
    ...firingAndResolved(state),
    body_length: body.length,
  };
  if (shadow) {
    log.info(`[${NAME}] would ${decision} alert issue`, fields);
    return;
  }
  await withIssueActor(POLLER_ACTOR, async () => {
    if (decision === "create") {
      const created = await createInbox(bridge, body);
      fields.inbox_issue = created?.id ?? "";
    } else {
      await updateInbox(bridge, record!, { body, ...(decision === "close" ? { state: "closed" as const } : decision === "reopen" ? { state: "open" as const } : {}) });
    }
  });
  log.info(`[${NAME}] ${decision === "create" ? "created" : decision === "close" ? "closed" : decision === "reopen" ? "reopened" : "updated"} alert issue`, fields);
}

/** The events the poll reports to {@link routeAlertEvents}. */
function buildEvents(groups: ReadonlyMap<string, AlertGroup>, inboxes: readonly RoutedInbox[], now: string): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const [name, g] of groups) {
    events.push(firingEvent(name, g, now));
  }
  const resolved = new Set<string>();
  for (const inbox of inboxes) {
    if (inbox.rebuilt) continue;
    for (const [name, s] of inbox.state.sections) {
      // A frozen tracked section stays "firing" indefinitely; its next firing re-routes it.
      if (s.status !== "firing" || s.tracked || groups.has(name) || resolved.has(name)) continue;
      resolved.add(name);
      events.push({ alertname: name, status: "resolved", at: now, severity: s.severity, summary: s.summary, description: s.description });
    }
  }
  return events;
}

function firingEvent(name: string, g: AlertGroup, now: string): AlertEvent {
  return {
      alertname: name,
      status: "firing",
      at: now,
      severity: g.severity,
      summary: g.summary,
      description: g.description,
      ...(g.instances.length > 0 && g.instances.length <= MAX_ALERT_INSTANCES ? { instances: g.instances } : {}),
  };
}

/** Poll one repo's Alertmanager and reconcile its inbox. */
export async function pollRepo(bridge: PolledBridge, nowDate: Date = new Date()): Promise<void> {
  const { cluster, datasourceUid } = bridge.poll;
  const repoKey = bridge.repo.toLowerCase();
  const fetched = await fetchActiveAlerts(cluster, datasourceUid);
  const target = alertsUrl(cluster, datasourceUid).split("?")[0]!;
  if (!fetched.ok) {
    setAlertmanagerPollOk(cluster, false);
    log.warn(`[${NAME}] Alertmanager poll failed; no alert issue touched`, {
      bridge_repo: bridge.repo, cluster, url: target, duration_ms: fetched.durationMs,
      ...(fetched.httpStatus !== undefined ? { http_status: fetched.httpStatus } : {}),
      ...(fetched.probeError !== undefined ? { probe_error: fetched.probeError } : {}),
    });
    return;
  }
  log.debug(`[${NAME}] fetched Alertmanager alerts`, { bridge_repo: bridge.repo, cluster, url: target, duration_ms: fetched.durationMs, alerts: fetched.alerts.length });

  const ignored = new Set(bridge.poll.ignoreAlertnames);
  const alerts = fetched.alerts.filter((a) => !ignored.has(oneLine(a.labels?.alertname ?? "")) && !ignored.has(effectiveAlertname(a.labels)));
  const now = fmtTime(nowDate);
  const groups = groupAlerts(alerts);
  const active = new Set<string>();
  for (const g of groups.values()) for (const k of g.firingKeys) active.add(k);
  const previous = previousActive.get(repoKey);
  // Prune only what this and the previous successful poll both lack.
  const keep = previous === undefined ? null : new Set([...active, ...previous]);
  const ctx: RenderContext = { repo: bridge.repo, grafanaUrl: grafanaUrl(cluster), reopenWindowHours: bridge.poll.reopenWindowHours };

  const records = await listOpenInboxes(bridge);
  const routed = routeGroups(records, groups, now, bridge.repo);
  // Look tracking up without counting; count an occurrence on a tracking issue only for a new instance.
  const events = buildEvents(groups, routed, now);
  const results = await routeAlertEvents(bridge, events, { dryRun: true });
  if (bridge.poll.mode === "write" && previous !== undefined) {
    const fresh = [...groups].filter(([, g]) => [...g.firingKeys].some((k) => !previous.has(k))).map(([name, g]) => firingEvent(name, g, now));
    if (fresh.length > 0) await routeAlertEvents(bridge, fresh, { dryRun: false });
  }
  const tracked = new Map<string, string>();
  for (const [name, r] of Object.entries(results)) if (r.tracked) tracked.set(name, r.id);

  if (routed.length > 0) {
    for (const inbox of routed) {
      // Hand-edited duplicates are left alone; only the oldest is rebuilt.
      if (inbox.rebuilt && inbox !== routed[0]) continue;
      const trackedHere = new Map([...tracked].filter(([name]) => inbox.groups.has(name) || inbox.state.sections.has(name)));
      const changed = applyGroups(inbox.state, inbox.groups, now, trackedHere);
      if (!inbox.rebuilt && keep) {
        for (const name of pruneStaleInstances(inbox.state, keep, now)) if (!changed.includes(name)) changed.push(name);
      }
      // A rebuilt body with nothing firing is closed rather than left open with its hand-edited contents.
      const closing = (inbox.state.sections.size > 0 || inbox.rebuilt) && allResolved(inbox.state);
      if (changed.length === 0 && !closing && !inbox.rebuilt) continue;
      await decide(bridge, closing ? "close" : "update", inbox.record, inbox.state, renderBounded(inbox.state, ctx), changed);
    }
  } else if ([...groups.keys()].some((name) => !tracked.has(name))) {
    // Only an untracked firing creates or reopens the inbox.
    const candidate = (await listRecentlyClosedInboxes(bridge))[0];
    const closedAt = candidate?.closed_at ? Date.parse(toIso(candidate.closed_at)) : NaN;
    const withinWindow = Number.isFinite(closedAt) && nowDate.getTime() - closedAt <= bridge.poll.reopenWindowHours * 60 * 60 * 1000;
    if (candidate && withinWindow) {
      const { state, rebuilt } = stateFromBody(candidate.body, now, { repo: bridge.repo, issue: candidate.id });
      const changed = applyGroups(state, groups, now, tracked);
      if (!rebuilt && keep) {
        for (const name of pruneStaleInstances(state, keep, now)) if (!changed.includes(name)) changed.push(name);
      }
      await decide(bridge, "reopen", candidate, state, renderBounded(state, ctx), changed);
    } else {
      const state = newState(now);
      const changed = applyGroups(state, groups, now, tracked);
      await decide(bridge, "create", null, state, renderBounded(state, ctx), changed);
    }
  } else if (groups.size > 0) {
    log.debug(`[${NAME}] only tracked alerts firing and no open alert issue; nothing to do`, { bridge_repo: bridge.repo });
  }
  previousActive.set(repoKey, active);
  setAlertmanagerPollOk(cluster, true);
}

/** Every repo with `alertBridge.poll` whose `alertmanager-poller` job is not disabled. */
function polledBridges(): PolledBridge[] {
  const out: PolledBridge[] = [];
  for (const { fullName, config } of listRepoConfigs()) {
    const bridge = config.alertBridge;
    if (!bridge?.poll || !config.enabled) continue;
    if (isJobDisabledForRepo(NAME, fullName)) continue;
    out.push({ ...bridge, poll: bridge.poll, repo: fullName });
  }
  return out;
}

export async function run(): Promise<void> {
  const bridges = polledBridges();
  if (bridges.length === 0) {
    log.debug(`[${NAME}] no repo polls Alertmanager; skipping`);
    return;
  }
  const start = performance.now();
  log.info(`[${NAME}] poll started`, { repos: bridges.map((b) => b.repo).join(", ") });
  let failed = 0;
  for (const bridge of bridges) {
    try {
      await pollRepo(bridge);
    } catch (err) {
      failed += 1;
      setAlertmanagerPollOk(bridge.poll.cluster, false);
      log.warn(`[${NAME}] alert issue reconcile failed`, { bridge_repo: bridge.repo, cluster: bridge.poll.cluster }, err);
    }
  }
  log.info(`[${NAME}] poll finished`, { repos: bridges.length, failed, duration_ms: Math.round(performance.now() - start) });
}
