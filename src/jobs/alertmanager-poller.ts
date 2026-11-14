/**
 * Claws' Alertmanager poller (#clw_01M6NVG8QYJ0MN59X0Q3CWR932): for every repo
 * whose `claws.json` sets `alertBridge.poll`, read the cluster's active alerts
 * through that cluster's Grafana (its provisioned Alertmanager datasource
 * proxy, or with `poll.source: "grafana"` Grafana's own managed-alerts
 * Alertmanager, authenticated by the Claws-signed observability JWT) and file
 * one issue per alert group, in-process (#clw_01M7554EZ4SGZQHDHWTAEQW2QV). The
 * cluster holds no Claws token and initiates nothing towards Claws.
 *
 * Every poll lists the whole active set. Each group (`<service> / <alert>`, or
 * a bare alertname) goes to the issue holding its exact key, or files its own
 * issue ({@link routeDirectAlerts}); an occurrence is counted only when the
 * poll shows an instance absent from the previous successful poll, so the
 * first poll after start only primes and a failed poll touches nothing.
 * `mode: "write"` and `"direct"` apply the routing; `"shadow"` computes every
 * decision and logs it, writing nothing. See docs/issue-tracker.md
 * "Alert bridges".
 */
import crypto from "node:crypto";
import { isJobDisabledForRepo } from "../config.js";
import * as log from "../log.js";
import { listRepoConfigs, type RepoAlertBridgePoll } from "../repo-config.js";
import { grafanaUrl, mintGrafanaJwt, type GrafanaCluster } from "../grafana-jwt.js";
import { setAlertmanagerPollOk } from "../metrics.js";
import { withIssueActor, type IssueActor } from "../issue-history-actor.js";
import { routeDirectAlerts, type DirectAlertGroup, type PolledBridge } from "../alert-bridge.js";

const NAME = "alertmanager-poller";

/** How a poller write reads in the issue's History. */
const POLLER_ACTOR: IssueActor = { kind: "automation", name: "alertmanager poller" };

const JWT_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

const MAX_DESCRIPTION = 1000;

function fmtTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
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
 * Labels naming the service an alert belongs to, in precedence order: a rule
 * sets `claws_service` explicitly, the rest are the fallback chain. A port of
 * fleet-infra's `grafana-github-alerts` `SERVICE_LABELS`, and what
 * docs/observability-contract.md states. `namespace` and `pod` are
 * deliberately absent: a namespace holds unrelated workloads and a pod name
 * changes on every restart.
 */
const SERVICE_LABELS = [
  "claws_service", "exported_service", "app", "deployment", "statefulset", "daemonset", "cronjob", "container", "job", "node", "host",
] as const;
/**
 * Fallback-label values naming the exporter a series came from, not the
 * service it describes; the fallback chain skips them. An explicit
 * `claws_service` is never skipped.
 */
const SCRAPE_TARGET_VALUES = new Set(["kube-state-metrics", "kubelet", "cadvisor", "apiserver", "node-exporter", "prometheus-node-exporter"]);
const GROUP_SEPARATOR = " / ";

/**
 * A non-empty `claws_service`, else the first non-empty fallback
 * {@link SERVICE_LABELS} value that is not a {@link SCRAPE_TARGET_VALUES}
 * name, one-lined; "" for a cluster-wide alert.
 */
export function serviceOf(labels: Record<string, string> | undefined): string {
  for (const label of SERVICE_LABELS) {
    const value = oneLine(labels?.[label] ?? "");
    if (!value) continue;
    if (label !== "claws_service" && SCRAPE_TARGET_VALUES.has(value.toLowerCase())) continue;
    return value;
  }
  return "";
}

/**
 * `<service> / <effective alertname>`, the bare alertname with no service, ""
 * with neither. A ` / ` inside either part becomes ` - `, so the separator only
 * ever marks the service boundary.
 */
export function groupName(labels: Record<string, string> | undefined): string {
  const name = effectiveAlertname(labels).replaceAll(GROUP_SEPARATOR, " - ");
  const service = serviceOf(labels).replaceAll(GROUP_SEPARATOR, " - ");
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
      dashboard: oneLine(rep.annotations?.dashboard ?? ""),
      generatorUrl: oneLine(rep.generatorURL ?? ""),
    });
  }
  return groups;
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

/**
 * The alert-list URL through `cluster`'s Grafana: its Alertmanager datasource
 * proxy for `source: "alertmanager"`, or Grafana's own managed-alerts
 * Alertmanager for `source: "grafana"`.
 */
export function alertsUrl(cluster: GrafanaCluster, datasourceUid: string, source: RepoAlertBridgePoll["source"] = "alertmanager"): string {
  const base = source === "grafana"
    ? `${grafanaUrl(cluster)}/api/alertmanager/grafana`
    : `${grafanaUrl(cluster)}/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}`;
  return `${base}/api/v2/alerts?active=true&silenced=false&inhibited=false`;
}

/** Fetch `cluster`'s active, unsilenced, uninhibited alerts. Never throws. */
export async function fetchActiveAlerts(
  cluster: GrafanaCluster, datasourceUid: string, source: RepoAlertBridgePoll["source"] = "alertmanager",
): Promise<FetchResult> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  try {
    const res = await fetch(alertsUrl(cluster, datasourceUid, source), {
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

/** The poll's groups for {@link routeDirectAlerts}; none is `fresh` on the priming poll. */
function directGroups(groups: ReadonlyMap<string, AlertGroup>, previous: ReadonlySet<string> | undefined): DirectAlertGroup[] {
  return [...groups].map(([name, g]) => ({
    name,
    severity: g.severity,
    summary: g.summary,
    description: g.description,
    dashboard: g.dashboard,
    source: g.generatorUrl,
    startsAt: g.startsAt,
    instances: g.instances,
    fresh: previous !== undefined && [...g.firingKeys].some((k) => !previous.has(k)),
  }));
}

/** Poll one repo's Alertmanager and route its alert groups to their issues; `shadow` only logs. */
export async function pollRepo(bridge: PolledBridge, nowDate: Date = new Date()): Promise<void> {
  const { cluster, datasourceUid, source } = bridge.poll;
  const repoKey = bridge.repo.toLowerCase();
  const fetched = await fetchActiveAlerts(cluster, datasourceUid, source);
  const target = alertsUrl(cluster, datasourceUid, source).split("?")[0]!;
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
  const direct = directGroups(groups, previousActive.get(repoKey));
  const dryRun = bridge.poll.mode === "shadow";
  const route = () => routeDirectAlerts(bridge, direct, { dryRun, now });
  const outcomes = dryRun ? await route() : await withIssueActor(POLLER_ACTOR, route);
  if (outcomes.every((o) => o.decision === "none")) {
    log.info(`[${NAME}] no alert issue change`, {
      bridge_repo: bridge.repo, cluster, mode: bridge.poll.mode, decision: "none",
      reason: direct.length > 0 ? "unchanged" : "no_firing", firing: direct.length,
    });
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
