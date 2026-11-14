/**
 * Alert filing for Claws' Alertmanager poller (docs/issue-tracker.md "Alert
 * bridges"): one native issue per alert group, keyed exactly.
 *
 * Each poll names its firing groups — `<service> / <alert>`, or a bare
 * alertname for an alert with no service identity — with their firing
 * `instances` as `{ key, startsAt }`. {@link routeDirectAlerts} routes each
 * group to the open issue holding its exact {@link alertGroupKey} and files a
 * dedicated issue ({@link fileAlertIssue}) for a group none holds. Claws never
 * reopens an alert issue: a re-notification whose instances all began before
 * the issue closed leaves it closed — the occurrence is counted and one
 * comment per close explains why — for up to 14 days after the close, and any
 * newer firing files a new issue citing the closed one.
 *
 * {@link resolveAlertIssue} answers the dashboard's `/alerts/lookup` redirect
 * that Slack alerts link to.
 */
import { isAgentDisabled } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as clawsIssues from "./claws-issues.js";
import * as worker from "./worker.js";
import { AGENT_KINDS } from "./worker.js";
import * as log from "./log.js";
import { getRepoConfig, listRepoConfigs, type RepoAlertBridge, type RepoAlertBridgePoll } from "./repo-config.js";
import {
  alertGroupKey, alertOwnerRepos, isAlertInbox, isAlertIssue, isHeldAlertLifecycle, legacyAlertDedupeKey,
  serviceDedupeKey, splitAlertGroupName,
} from "./alert-issue.js";
import { appendOccurrenceTracking, occurrenceAlertName, parseOccurrenceAlerts, recordAlertOnOccurrenceBlock, updateOccurrenceTracking } from "./occurrence-tracking.js";
import { recordAlertFilingCapped, recordAlertIssueFiled, recordDedupeKeyMoves } from "./metrics.js";

const NAME = "alert-bridge";

/**
 * How far back routing matches a closed alert issue for a pre-close
 * re-notification, so a still-firing instance a fix has yet to clear never
 * files a second issue.
 */
const PRE_CLOSE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/** The phrase that marks the once-per-close pre-close comment. */
const PRE_CLOSE_COMMENT_MARKER = "began before this issue closed";

/**
 * Move a native issue to planning in its primary repo and, unless the planner
 * is disabled, queue a re-plan. Returns whether a re-plan was queued.
 *
 * A native issue can name more than one repository; the alphabetically first
 * one owns planning unless the issue pins another (`clawsIssues.primaryRepo`), so `fallbackRepo` is used only
 * when the issue names none.
 */
async function queueReplan(native: db.ClawsIssueRecord, fallbackRepo: string): Promise<boolean> {
  const planRepo = clawsIssues.primaryRepo(native) || fallbackRepo;
  await clawsIssues.setLifecycle(planRepo, native.id, "planning");
  if (isAgentDisabled("planner")) return false;
  await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, planRepo, native.id, {
    priority: gh.hasPriorityLabel(native.labels.map((name) => ({ name }))),
  });
  return true;
}

/**
 * Send a reopened native issue back to planning and queue a re-plan.
 *
 * The dispatcher's own stale-plan check would not re-plan an issue that
 * already shipped a fix, which is exactly the state a re-fired alert finds its
 * issue in. Skipped for an issue that is held: an alert issue
 * ({@link isAlertIssue}) only in `ideas`/`backlog` ({@link isHeldAlertLifecycle});
 * any other issue in `blocked` too, an operator's or a dependency's hold. The
 * re-plan alone is skipped while the planner is disabled. Returns whether a
 * re-plan was queued.
 */
export async function requeueReopenedIssue(native: db.ClawsIssueRecord, fallbackRepo: string): Promise<boolean> {
  if (isHeldAlertLifecycle(native.lifecycle)) return false;
  if (native.lifecycle === "blocked" && !isAlertIssue(native)) return false;
  return await queueReplan(native, fallbackRepo);
}

export interface Bridge extends RepoAlertBridge {
  /** The repo's full name in its configured casing — what native issues record. */
  repo: string;
}

/** `wanted`'s `alertBridge` entry with the repo's configured casing, or null when it has none. */
function bridgeForRepo(wanted: string): Bridge | null {
  const alertBridge = getRepoConfig(wanted)?.alertBridge;
  if (!alertBridge) return null;
  const repo = listRepoConfigs().find((r) => r.fullName.toLowerCase() === wanted.toLowerCase())?.fullName ?? wanted;
  return { ...alertBridge, repo };
}

/** One firing instance of an alert: its instance key and its raw `startsAt`. */
export interface AlertInstance {
  key: string;
  startsAt: string;
}

/**
 * True when `instances` is non-empty and every instance has a parseable
 * `startsAt` strictly before `closedAt`: a re-notification of instances
 * already firing when the issue closed. Anything else — no instances, an
 * unparseable start, any later instance — is not pre-close.
 */
function isPreClose(instances: readonly AlertInstance[], closedAt: Date): boolean {
  return instances.length > 0 && instances.every((i) => {
    const started = Date.parse(i.startsAt);
    return Number.isFinite(started) && started < closedAt.getTime();
  });
}

/**
 * True when `record` is an alert issue this bridge routes to: a native issue
 * (not a shadow) whose primary repo is the bridge repo and that holds a dedupe
 * key starting `alert-`. A legacy alert inbox never qualifies, even one
 * holding an `alert-` key.
 */
function isTrackingIssue(bridge: Bridge, record: db.ClawsIssueRecord | undefined): record is db.ClawsIssueRecord {
  return record !== undefined
    && record.kind === "issue"
    && clawsIssues.primaryRepo(record) === bridge.repo
    && (record.dedupe_keys ?? []).some((key) => key.startsWith("alert-"))
    && !isAlertInbox({ title: record.title, filedTitle: record.filed_title, labels: record.labels, body: record.body }, bridge);
}

/** `body` with one more occurrence at `at`: the trailing block bumped, or one appended. */
function bumpOccurrence(body: string, at: string, firstSeen: string): string {
  const updated = updateOccurrenceTracking(body, at);
  if (updated !== body || body.includes("**First seen:**")) return updated;
  // Retroactive: the issue predates this firing, so it is at least the 2nd occurrence.
  return appendOccurrenceTracking(body, at, 2, firstSeen < at ? firstSeen : at);
}

/** When the tracking issue was filed, at second precision. */
function issueFirstSeen(record: { created_at: string }): string {
  return clawsIssues.toIso(record.created_at).replace(/\.\d{3}Z$/, "Z");
}

/**
 * A re-notification of instances that all began before `closed` closed: count
 * the occurrence at `at` and, once per close, say why the issue stays closed.
 * No reopen and no re-plan.
 */
async function recordPreCloseFiring(
  bridge: Bridge, groupName: string, closed: db.ClawsIssueRecord, closedAt: Date, at: string, summary: string,
): Promise<void> {
  const body = bumpOccurrence(closed.body, at, issueFirstSeen(closed));
  if (body !== closed.body) await clawsIssues.editIssue(closed.id, body);
  const comments = await clawsIssues.listCommentDetails(closed.id, { renderHtml: false });
  const commented = comments.some((c) => Date.parse(c.createdAt) >= closedAt.getTime() && c.body.includes(PRE_CLOSE_COMMENT_MARKER));
  if (!commented) {
    const said = summary.trim() ? ` (${summary.trim()})` : "";
    await clawsIssues.commentOnIssue(
      bridge.repo, closed.id,
      `Alert ${groupName} fired again at ${at}${said} for instance(s) that ${PRE_CLOSE_COMMENT_MARKER} at ${closedAt.toISOString()}; left closed and the occurrence counted. A new instance of this alert files a new issue.`,
      clawsIssues.CLAWS_NATIVE_LOGIN,
    );
  }
  log.info(`[${NAME}] ${bridge.repo} ${closed.id}: ${groupName} re-notified for instance(s) that began before the close; left closed, occurrence counted`);
}

/**
 * The Claws issue tracking `alertname` in `repo`'s alert bridge, for the
 * dashboard's `/alerts/lookup` redirect that Slack alerts link to: the open
 * issue keyed {@link alertGroupKey}, else the one keyed by the bare alert's
 * {@link legacyAlertDedupeKey}, else the oldest open `alert-`-keyed issue
 * whose `**Alerts:**` line lists the alert (Slack sends the bare alertname),
 * else an issue holding either exact key closed within 14 days. Null for an
 * empty alertname, when nothing matches, or when the repo has no `alertBridge`.
 */
export async function resolveAlertIssue(repo: string, alertname: string): Promise<string | null> {
  const bridge = bridgeForRepo(repo);
  if (!bridge) return null;
  const name = alertname.trim();
  if (!name) return null;
  const { alert } = splitAlertGroupName(name);
  const keys = [...new Set([alertGroupKey(name), legacyAlertDedupeKey(alert)])];
  for (const key of keys) {
    const open = await clawsIssues.findOpenIssueByDedupeKey(bridge.repo, key);
    if (isTrackingIssue(bridge, open)) return open.id;
  }
  const listing = (await clawsIssues.listOpenIssuesTouching([bridge.repo]))
    .filter((record) => isTrackingIssue(bridge, record) && listsAlert(record.body, alert))
    .map((record) => record.id)
    .sort()[0];
  if (listing) return listing;
  const since = new Date(Date.now() - PRE_CLOSE_LOOKBACK_MS);
  for (const key of keys) {
    const closed = await clawsIssues.findRecentlyClosedIssueByDedupeKey(bridge.repo, key, since);
    if (isTrackingIssue(bridge, closed)) return closed.id;
  }
  return null;
}

// ── Direct filing ──

/** A bridge Claws polls, with its `poll` settings. */
export type PolledBridge = Bridge & { poll: RepoAlertBridgePoll };

/** One alert group of a poll, as {@link routeDirectAlerts} sees it. */
export interface DirectAlertGroup {
  /** `<service> / <alert>`, or a bare alertname for an alert with no service identity. */
  name: string;
  severity: string;
  summary: string;
  description: string;
  /** The representative alert's `dashboard` annotation; "" when unset. */
  dashboard: string;
  /** The representative alert's rule (generator) URL; "" when unset. */
  source: string;
  /** The representative alert's raw `startsAt`. */
  startsAt: string;
  /** Every firing instance of the group. */
  instances: AlertInstance[];
  /** True when the poll shows an instance absent from the previous successful poll. */
  fresh: boolean;
}

/** What {@link routeDirectAlerts} did, or in a dry run would do, for one group. */
export interface DirectAlertOutcome {
  group: string;
  key: string;
  /**
   * `file`: a new issue; `bump`: an occurrence counted on the open holder;
   * `pre-close`: a re-notification counted on a closed holder; `none`: a
   * holder exists and nothing new fired; `deferred`: over the per-poll cap.
   */
  decision: "file" | "bump" | "pre-close" | "none" | "deferred";
  /** The issue filed or touched; "" for a deferred group or a dry-run filing. */
  issue: string;
}

/** True when `body`'s `**Alerts:**` line lists `alert`. */
function listsAlert(body: string, alert: string): boolean {
  const name = occurrenceAlertName(alert);
  return !!name && parseOccurrenceAlerts(body).includes(name);
}

/** A `<service> / <alert>` group's legacy per-service key and alert part; null for a bare alertname. */
function legacyServiceKey(groupName: string): { key: string; alert: string } | null {
  const { service, alert } = splitAlertGroupName(groupName);
  return service ? { key: serviceDedupeKey(service), alert } : null;
}

/**
 * The issue holding group `name`: the issue keyed `key` ({@link alertGroupKey}),
 * else one holding the group's legacy `alert-service-<slug>` key whose
 * `**Alerts:**` line lists the alert (`legacy`). Open, or with `since`, closed
 * at or after it.
 */
async function findGroupHolder(
  bridge: Bridge, name: string, key: string, since?: Date,
): Promise<{ record: db.ClawsIssueRecord; legacy: boolean } | undefined> {
  const lookup = (k: string) => since
    ? clawsIssues.findRecentlyClosedIssueByDedupeKey(bridge.repo, k, since)
    : clawsIssues.findOpenIssueByDedupeKey(bridge.repo, k);
  const exact = await lookup(key);
  if (isTrackingIssue(bridge, exact)) return { record: exact, legacy: false };
  const legacy = legacyServiceKey(name);
  if (!legacy) return undefined;
  const held = await lookup(legacy.key);
  if (isTrackingIssue(bridge, held) && listsAlert(held.body, legacy.alert)) return { record: held, legacy: true };
  return undefined;
}

/** The managed repos `bridge`'s `serviceRepos` names for `key`, canonicalised, without the bridge repo. */
async function managedOwnerRepos(bridge: Bridge, key: string): Promise<string[]> {
  const mapped = alertOwnerRepos(bridge, key);
  if (mapped.length === 0) return [];
  const managed = new Map((await gh.listRepos()).map((r) => [r.fullName.toLowerCase(), r.fullName]));
  const out: string[] = [];
  for (const owner of mapped) {
    const canonical = managed.get(owner.toLowerCase());
    if (!canonical) {
      log.warn(`[${NAME}] ${bridge.repo}'s alertBridge.serviceRepos maps ${key} to ${owner}, which Claws does not manage; skipping it`, { bridge_repo: bridge.repo, key, owner });
      continue;
    }
    if (canonical.toLowerCase() !== bridge.repo.toLowerCase() && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

function fieldCell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/** `value` as an RFC 3339 second-precision UTC timestamp, or `fallback` when it does not parse. */
function secondPrecision(value: string, fallback: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).getUTCFullYear() > 1 ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : fallback;
}

/**
 * File the dedicated issue for alert group `group` under exact key `key`:
 * titled `[Alert] <group>`, with no bridge label, `alertKind: "alert-bridge"`,
 * source `automation` and auto-promoted, so it is planned as an ordinary
 * issue. It names the bridge repo, pinned primary, and the managed repos
 * `serviceRepos` maps the service to. The body holds a field table (severity,
 * key, source, dashboard, and `previous`, the closed issue that last held the
 * key), the alert's Summary and Description, and an occurrence block whose
 * `**Alerts:**` line lists the alert. Returns the new issue's id.
 */
export async function fileAlertIssue(
  bridge: PolledBridge, group: DirectAlertGroup, key: string, now: string, previous?: db.ClawsIssueRecord,
): Promise<string> {
  const { alert } = splitAlertGroupName(group.name);
  const owners = await managedOwnerRepos(bridge, key);
  const rows: [string, string][] = [["Severity", group.severity], ["Key", `\`${key}\``]];
  if (group.source) rows.push(["Source", group.source]);
  if (group.dashboard) rows.push(["Dashboard", group.dashboard]);
  if (previous) {
    const closed = previous.closed_at ? ` (closed ${secondPrecision(clawsIssues.toIso(previous.closed_at), "")})` : "";
    rows.push(["Previous issue", `#${previous.id}${closed}`]);
  }
  const body = [
    `Alert \`${group.name}\` is firing on the ${bridge.poll.cluster} cluster. Claws' Alertmanager poller filed this issue for ${bridge.repo}; later firings of the same alert group count on the occurrence block below.`,
    "",
    "| Field | Value |",
    "|---|---|",
    ...rows.map(([field, value]) => `| ${field} | ${fieldCell(value)} |`),
    "",
    `**Summary:** ${group.summary}`,
    "",
    `**Description:** ${group.description}`,
  ].join("\n");
  const tracked = recordAlertOnOccurrenceBlock(appendOccurrenceTracking(body, now, 1, secondPrecision(group.startsAt, now)), alert);
  return await clawsIssues.createIssue({
    title: `[Alert] ${group.name}`,
    body: tracked,
    authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
    repos: [bridge.repo, ...owners],
    primaryRepo: bridge.repo,
    source: "automation",
    autoPromote: true,
    dedupeKey: key,
    alertKind: "alert-bridge",
  });
}

/**
 * Give `record`, an open per-service issue whose `**Alerts:**` line lists the
 * group's alert, the group's exact `key`, so later firings route by it.
 */
async function adoptGroupKey(record: db.ClawsIssueRecord, key: string, dryRun: boolean, fields: Record<string, unknown>): Promise<void> {
  if (dryRun) {
    log.info(`[${NAME}] would adopt alert issue`, { ...fields, issue: record.id });
    return;
  }
  if (!(await db.addClawsIssueDedupeKey(record.id, key))) {
    log.warn(`[${NAME}] could not add an alert group key to its legacy alert issue`, { ...fields, issue: record.id });
    return;
  }
  recordDedupeKeyMoves("adopt", 1);
  log.info(`[${NAME}] adopted alert issue`, { ...fields, issue: record.id });
}

/**
 * Route one poll's alert groups straight to their issues. Per
 * group, keyed {@link alertGroupKey}:
 *
 * - the open issue holding the key — or, on a miss, an open (legacy) issue
 *   holding the group's `alert-service-<slug>` key whose `**Alerts:**` line
 *   lists the alert, which gains the key — counts one occurrence and records
 *   the alert on its `**Alerts:**` line, only when the group is `fresh`;
 * - else an issue holding the key (or the legacy one) closed within 14 days
 *   stays closed for a re-notification of instances that all began before
 *   it closed, counted when `fresh` and explained once per close;
 * - anything else files a new issue ({@link fileAlertIssue}), citing that
 *   closed issue when there is one, up to `poll.maxNewIssuesPerPoll` per call;
 *   later groups are deferred to the next poll.
 *
 * A `dryRun` looks everything up and logs what it would do, writing nothing.
 * Callers wrap a live run in the poller's issue actor.
 */
export async function routeDirectAlerts(
  bridge: PolledBridge,
  groups: readonly DirectAlertGroup[],
  opts: { dryRun: boolean; now: string },
): Promise<DirectAlertOutcome[]> {
  const { dryRun, now } = opts;
  const since = new Date(Date.parse(now) - PRE_CLOSE_LOOKBACK_MS);
  const outcomes: DirectAlertOutcome[] = [];
  const deferred: string[] = [];
  let filed = 0;
  for (const group of groups) {
    const key = alertGroupKey(group.name);
    const { alert } = splitAlertGroupName(group.name);
    const fields = { bridge_repo: bridge.repo, cluster: bridge.poll.cluster, mode: bridge.poll.mode, group: group.name, key };

    const open = await findGroupHolder(bridge, group.name, key);
    if (open) {
      if (open.legacy) await adoptGroupKey(open.record, key, dryRun, fields);
      if (!group.fresh) {
        outcomes.push({ group: group.name, key, decision: "none", issue: open.record.id });
        continue;
      }
      if (dryRun) {
        log.info(`[${NAME}] would bump alert issue`, { ...fields, issue: open.record.id });
      } else {
        const bumped = recordAlertOnOccurrenceBlock(bumpOccurrence(open.record.body, now, issueFirstSeen(open.record)), alert);
        if (bumped !== open.record.body) await clawsIssues.editIssue(open.record.id, bumped);
        log.info(`[${NAME}] bumped alert issue`, { ...fields, issue: open.record.id });
      }
      outcomes.push({ group: group.name, key, decision: "bump", issue: open.record.id });
      continue;
    }

    const closed = (await findGroupHolder(bridge, group.name, key, since))?.record;
    if (closed?.closed_at) {
      const closedAt = new Date(clawsIssues.toIso(closed.closed_at));
      if (isPreClose(group.instances, closedAt)) {
        if (group.fresh && dryRun) log.info(`[${NAME}] would count pre-close firing on alert issue`, { ...fields, issue: closed.id });
        else if (group.fresh) await recordPreCloseFiring(bridge, group.name, closed, closedAt, now, group.summary);
        outcomes.push({ group: group.name, key, decision: "pre-close", issue: closed.id });
        continue;
      }
    }

    if (filed >= bridge.poll.maxNewIssuesPerPoll) {
      deferred.push(group.name);
      outcomes.push({ group: group.name, key, decision: "deferred", issue: "" });
      continue;
    }
    filed += 1;
    const previous = closed ? { previous_issue: closed.id } : {};
    if (dryRun) {
      log.info(`[${NAME}] would file alert issue`, { ...fields, issue: "", ...previous });
      outcomes.push({ group: group.name, key, decision: "file", issue: "" });
      continue;
    }
    const id = await fileAlertIssue(bridge, group, key, now, closed);
    recordAlertIssueFiled(bridge.poll.cluster);
    log.info(`[${NAME}] filed alert issue`, { ...fields, issue: id, ...previous });
    outcomes.push({ group: group.name, key, decision: "file", issue: id });
  }
  if (deferred.length > 0) {
    const fields = { bridge_repo: bridge.repo, cluster: bridge.poll.cluster, mode: bridge.poll.mode, cap: bridge.poll.maxNewIssuesPerPoll, deferred: deferred.join(", ") };
    if (dryRun) {
      log.info(`[${NAME}] would cap alert filing`, fields);
    } else {
      recordAlertFilingCapped(bridge.poll.cluster);
      log.warn(`[${NAME}] alert filing capped`, fields);
    }
  }
  return outcomes;
}
