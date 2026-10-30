/**
 * The alert-bridge API: `/api/alert-bridge/:owner/:name/issues[/:id]` and
 * `…/alerts/events` (docs/issue-tracker.md "Alert bridges").
 *
 * production-infra's `alert-issue-bridge` and fleet-infra's
 * `grafana-github-alerts` each keep one consolidated alert issue per repo.
 * They find, create, rewrite, close and reopen it here, in the native
 * tracker, rather than on a forge for the importer to copy across later.
 *
 * Auth is a per-repo bearer token whose SHA-256 the bridge repo commits as
 * `claws.json`'s `alertBridge.tokenSha256`. It is scoped twice: the token only
 * matches its own repo's path, and every route only reads or writes native
 * issues whose primary repo is that repo and that carry the configured label
 * and still the bridge title, both as filed and now — or, for `…/alerts/events`,
 * a dedupe key starting `alert-` (the dedicated issues tracking single alerts).
 * A retitled inbox is a dedicated issue and is never the inbox again.
 * Claws, not the bridge, decides that title and label.
 *
 * Each `…/alerts/events` entry may list its firing `instances` as
 * `{ key, startsAt }`. A re-notification whose instances all began before the
 * dedicated issue closed leaves it closed — the occurrence is counted and one
 * comment per close explains why — for up to 14 days after the close; only a
 * newer instance reopens it.
 */
import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { isAgentDisabled } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as clawsIssues from "./claws-issues.js";
import * as worker from "./worker.js";
import { AGENT_KINDS } from "./worker.js";
import * as log from "./log.js";
import * as importer from "./jobs/issue-importer.js";
import { resolveImportedRef } from "./imported-refs.js";
import { safeCompare } from "./internal-mcp-token.js";
import { withIssueActor, type IssueActor } from "./issue-history-actor.js";
import { forceRefreshRepoConfig, getRepoConfig, listRepoConfigs, type RepoAlertBridge } from "./repo-config.js";
import { alertDedupeKey, isAlertInbox, isAlertIssue, isHeldAlertLifecycle, untriagedAlertSections } from "./alert-issue.js";
import { appendOccurrenceTracking, updateOccurrenceTracking } from "./occurrence-tracking.js";

const NAME = "alert-bridge";

/** How a write over a bridge token reads in the issue's History. */
const ALERT_BRIDGE_ACTOR: IssueActor = { kind: "automation", name: "alert bridge" };

/** The bridge renders well under this; anything larger is not an alert body. */
export const MAX_BODY_LENGTH = 65_536;

/** How far back `?state=closed` looks — comfortably past either bridge's reopen window. */
const CLOSED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const CLOSED_LIMIT = 100;

/**
 * How far back `…/alerts/events` matches a closed dedicated issue for a
 * pre-close instance — past the reopen window, so a still-firing instance a
 * fix has yet to clear never files a second issue.
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
 * ({@link isAlertIssue}) only in `ideas`/`backlog` ({@link isHeldAlertLifecycle}),
 * since the planner parks a triaged alert inbox in `blocked`; any other issue
 * in `blocked` too, an operator's or a dependency's hold. The re-plan alone
 * is skipped while the planner is disabled. Returns whether a re-plan was queued.
 */
export async function requeueReopenedIssue(native: db.ClawsIssueRecord, fallbackRepo: string): Promise<boolean> {
  if (isHeldAlertLifecycle(native.lifecycle)) return false;
  if (native.lifecycle === "blocked" && !isAlertIssue(native)) return false;
  return await queueReplan(native, fallbackRepo);
}

/**
 * Re-plan an open alert issue whose rewrite added an untriaged section, so the
 * planner triages it. Nothing moves for an issue held in `ideas`/`backlog`,
 * one already `planning`, or while the planner is disabled.
 * Returns whether a re-plan was queued.
 */
async function queueAlertTriage(native: db.ClawsIssueRecord, fallbackRepo: string): Promise<boolean> {
  if (isHeldAlertLifecycle(native.lifecycle)) return false;
  if (native.lifecycle === "planning" || isAgentDisabled("planner")) return false;
  return await queueReplan(native, fallbackRepo);
}

export interface Bridge extends RepoAlertBridge {
  /** The repo's full name in its configured casing — what native issues record. */
  repo: string;
}

/** The path's repo and its `alertBridge` entry, or null when it has none. */
function bridgeFor(c: Context): Bridge | null {
  return bridgeForRepo(`${c.req.param("owner") ?? ""}/${c.req.param("name") ?? ""}`);
}

/** `wanted`'s `alertBridge` entry with the repo's configured casing, or null when it has none. */
function bridgeForRepo(wanted: string): Bridge | null {
  const alertBridge = getRepoConfig(wanted)?.alertBridge;
  if (!alertBridge) return null;
  const repo = listRepoConfigs().find((r) => r.fullName.toLowerCase() === wanted.toLowerCase())?.fullName ?? wanted;
  return { ...alertBridge, repo };
}

/**
 * Admit only the bearer token whose SHA-256 is the path repo's
 * `alertBridge.tokenSha256`. Never `apiAuthMiddleware`'s tokens: an agent's
 * `INTERNAL_MCP_TOKEN` gets a 401 here, and this token gets one everywhere else.
 */
export const alertBridgeAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  let bridge = bridgeFor(c);
  if (!bridge || !safeCompare(hash, bridge.tokenSha256)) {
    // The cached claws.json may predate a merged rotation or first cutover:
    // re-read it (rate-limited per repo) before refusing.
    const wanted = `${c.req.param("owner") ?? ""}/${c.req.param("name") ?? ""}`;
    if (!(await forceRefreshRepoConfig(wanted, gh.fetchRepoFileContent))) return c.json({ error: "unauthorized" }, 401);
    bridge = bridgeFor(c);
    if (!bridge || !safeCompare(hash, bridge.tokenSha256)) return c.json({ error: "unauthorized" }, 401);
    log.info(`[${NAME}] ${bridge.repo}: re-read claws.json after a token mismatch; the new token is accepted`);
  }
  return withIssueActor(ALERT_BRIDGE_ACTOR, next);
};

/** What every route answers for an issue. */
interface BridgeIssueJson {
  id: string;
  title: string;
  body: string;
  state: string;
  closedAt: string | null;
  labels: string[];
}

function toJson(record: db.ClawsIssueRecord): BridgeIssueJson {
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    state: record.state,
    closedAt: record.closed_at ? clawsIssues.toIso(record.closed_at) : null,
    labels: record.labels,
  };
}

/**
 * Whether the issue is this bridge's inbox: the bridge label, filed under the
 * bridge title, and still carrying it. An inbox someone retitled has become a
 * dedicated issue, so it is never the inbox again (#clw_01M61M73EW1AMEZPD9V06YW18X).
 */
function isBridgeIssue(bridge: Bridge, issue: { title: string; filedTitle?: string | null; labels: readonly string[] }): boolean {
  return (issue.filedTitle ?? issue.title) === bridge.title && issue.title === bridge.title && issue.labels.includes(bridge.label);
}

/** The bridge's open inboxes, oldest first. */
export async function listOpenInboxes(bridge: Bridge): Promise<db.ClawsIssueRecord[]> {
  const open = (await clawsIssues.listIssuesByLabel(bridge.repo, bridge.label))
    .filter((issue) => isBridgeIssue(bridge, { title: issue.title, filedTitle: issue.filedTitle, labels: issue.labels.map((l) => l.name) }))
    // Native ids are ULIDs, so id order is creation order: oldest first.
    .map((issue) => String(issue.number))
    .sort();
  const records = await Promise.all(open.map((id) => clawsIssues.getIssue(id)));
  return records.filter((r): r is db.ClawsIssueRecord => r !== undefined);
}

/** The bridge's inboxes closed within the last 7 days, newest closed first. */
export async function listRecentlyClosedInboxes(bridge: Bridge): Promise<db.ClawsIssueRecord[]> {
  const closed = await clawsIssues.listClosedIssuesSince(bridge.repo, new Date(Date.now() - CLOSED_LOOKBACK_MS), CLOSED_LIMIT);
  // Already newest closed first.
  return closed.filter((record) => isBridgeIssue(bridge, { title: record.title, filedTitle: record.filed_title, labels: record.labels }));
}

/** The native issue `id` when it is this bridge's alert issue, else undefined. */
async function getBridgeIssue(bridge: Bridge, id: string): Promise<db.ClawsIssueRecord | undefined> {
  if (!gh.isNativeIssue(id)) return undefined;
  const record = await clawsIssues.getIssue(id);
  if (!record || record.kind !== "issue") return undefined;
  if (clawsIssues.primaryRepo(record) !== bridge.repo || !isBridgeIssue(bridge, { title: record.title, filedTitle: record.filed_title, labels: record.labels })) return undefined;
  return record;
}

/** Repos whose forge cutover has finished this process: no open forge copy left. */
const cutoverDone = new Set<string>();

/** Test-only: forget every finished cutover. */
export function resetAlertBridgeCutoverForTest(): void {
  cutoverDone.clear();
}

/**
 * Carry a bridge's open forge alert issue over to the native tracker, once.
 *
 * A forge copy already imported is closed as not planned — its native issue
 * is the one the bridge continues. One never imported is imported now, which
 * closes the forge copy itself. Returns false while a copy is still neither,
 * so the caller answers 503 and the bridge's delivery is retried. Only a pass
 * that finds no open copy marks the repo done, so later deliveries make no
 * forge call at all.
 */
async function runForgeCutover(bridge: Bridge): Promise<boolean> {
  if (cutoverDone.has(bridge.repo)) return true;
  const copies = (await gh.listOpenIssues(bridge.repo, { includeImported: true }))
    .filter((issue) => !gh.isNativeIssue(issue.number) && isBridgeIssue(bridge, { title: issue.title, labels: issue.labels.map((l) => l.name) }));
  if (copies.length === 0) {
    cutoverDone.add(bridge.repo);
    return true;
  }
  let pending = false;
  for (const issue of copies) {
    const ref = `${bridge.repo}#${issue.number}`;
    const native = resolveImportedRef(bridge.repo, issue.number);
    if (gh.isNativeIssue(native)) {
      await gh.closeIssue(bridge.repo, issue.number, "not_planned");
      log.info(`[${NAME}] ${ref}: closed the forge alert issue; the bridge now writes ${native}`);
      continue;
    }
    await importer.importRepo(bridge.repo, [issue]);
    const imported = resolveImportedRef(bridge.repo, issue.number);
    if (gh.isNativeIssue(imported)) {
      log.info(`[${NAME}] ${ref}: imported the forge alert issue as ${imported}`);
    } else {
      log.warn(`[${NAME}] ${ref}: the forge alert issue is not imported yet; answering 503 so the bridge retries`);
      pending = true;
    }
  }
  return !pending;
}

/** `GET …/issues?state=open|closed`. */
export async function listBridgeIssuesHandler(c: Context): Promise<Response> {
  const bridge = bridgeFor(c);
  if (!bridge) return c.json({ error: "unauthorized" }, 401);
  const state = c.req.query("state") ?? "open";
  if (state === "closed") return c.json((await listRecentlyClosedInboxes(bridge)).map(toJson));
  if (state !== "open") return c.json({ error: "state must be open or closed" }, 400);

  let ready: boolean;
  try {
    ready = await runForgeCutover(bridge);
  } catch (err) {
    log.warn(`[${NAME}] ${bridge.repo}: forge cutover failed (${err}); answering 503 so the bridge retries`);
    ready = false;
  }
  if (!ready) return c.json({ error: "the forge alert issue is still being carried over; retry" }, 503);

  return c.json((await listOpenInboxes(bridge)).map(toJson));
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bodyError(body: unknown): string | null {
  if (typeof body !== "string") return "body must be a string";
  if (body.length > MAX_BODY_LENGTH) return `body must be at most ${MAX_BODY_LENGTH} characters`;
  return null;
}

/**
 * `POST …/issues` with `{ body }`: file the repo's alert issue under the
 * configured title and label. No dedupe or similarity check — the bridge has
 * already looked for an open issue and a reopen candidate.
 */
export async function createBridgeIssueHandler(c: Context): Promise<Response> {
  const bridge = bridgeFor(c);
  if (!bridge) return c.json({ error: "unauthorized" }, 401);
  const input = await readJson(c);
  if (!input) return c.json({ error: "Invalid JSON body" }, 400);
  const error = bodyError(input.body);
  if (error) return c.json({ error }, 400);
  const id = await clawsIssues.createIssue({
    title: bridge.title,
    body: input.body as string,
    authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
    repos: [bridge.repo],
    labels: [bridge.label],
    source: "automation",
    alertKind: "alert-bridge",
  });
  log.info(`[${NAME}] ${bridge.repo}: created alert issue ${id}`);
  const record = await clawsIssues.getIssue(id);
  if (!record) return c.json({ error: "created issue not found" }, 500);
  return c.json(toJson(record), 201);
}

/**
 * `PATCH …/issues/:id` with `{ body?, state? }`. A body edit is a plain edit
 * — the dispatcher's alert-bridge check already declines to re-plan on it —
 * unless it adds an untriaged section to an open issue, which queues a triage
 * re-plan; reopening a closed issue sends it back to planning.
 */
export async function updateBridgeIssueHandler(c: Context): Promise<Response> {
  const bridge = bridgeFor(c);
  if (!bridge) return c.json({ error: "unauthorized" }, 401);
  const input = await readJson(c);
  if (!input) return c.json({ error: "Invalid JSON body" }, 400);
  if (input.body !== undefined) {
    const error = bodyError(input.body);
    if (error) return c.json({ error }, 400);
  }
  if (input.state !== undefined && input.state !== "open" && input.state !== "closed") {
    return c.json({ error: "state must be open or closed" }, 400);
  }
  const record = await getBridgeIssue(bridge, c.req.param("id") ?? "");
  if (!record) return c.json({ error: "not found" }, 404);

  const ref = `${bridge.repo} ${record.id}`;
  const bodyChanged = typeof input.body === "string" && input.body !== record.body;
  if (bodyChanged) {
    await clawsIssues.editIssue(record.id, input.body as string);
  }
  if (input.state === "closed" && record.state === "open") {
    await clawsIssues.closeIssue(bridge.repo, record.id, "completed");
    log.info(`[${NAME}] ${ref}: closed — every alert resolved or tracked`);
  } else if (input.state === "open" && record.state !== "open") {
    await clawsIssues.reopenIssue(record.id);
    const replan = await requeueReopenedIssue(record, bridge.repo);
    log.info(`[${NAME}] ${ref}: reopened${replan ? ", re-plan queued" : ""}`);
  } else if (bodyChanged && record.state === "open") {
    // A section with no Triage/Tracked row that the old body did not have
    // already — a new alert, or a row deleted to force re-triage. A count
    // bump leaves the set unchanged and re-plans nothing.
    const before = new Set(untriagedAlertSections(record.body));
    const added = untriagedAlertSections(input.body as string).filter((name) => !before.has(name));
    if (added.length > 0 && await queueAlertTriage(record, bridge.repo)) {
      log.info(`[${NAME}] ${ref}: untriaged section(s) ${added.join(", ")}; re-plan queued`);
    }
  }
  const updated = await clawsIssues.getIssue(record.id);
  return c.json(toJson(updated ?? record));
}

/** At most this many alerts in one `…/alerts/events` call. */
export const MAX_ALERT_EVENTS = 50;

/** Every string field of an alert event is capped at this length. */
export const MAX_ALERT_FIELD_LENGTH = 2000;

/** At most this many firing instances on one alert event. */
export const MAX_ALERT_INSTANCES = 200;

/** One firing instance of an alert: the bridge's instance key and its raw `startsAt`. */
interface AlertInstance {
  key: string;
  startsAt: string;
}

/** One alert's transition, as the bridge reports it to `…/alerts/events`. */
interface AlertEvent {
  alertname: string;
  status: "firing" | "resolved";
  at: string;
  severity: string;
  summary: string;
  description: string;
  source?: string;
  instances?: AlertInstance[];
}

/** What `…/alerts/events` answers for one alertname. */
type AlertEventResult =
  | { tracked: true; id: string; state: "open" | "closed"; reopened: boolean }
  | { tracked: false };

function parseAlertEvents(input: Record<string, unknown>): { reopenWindowMs: number; alerts: AlertEvent[] } | string {
  const hours = input.reopenWindowHours;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0) return "reopenWindowHours must be a non-negative number";
  if (!Array.isArray(input.alerts)) return "alerts must be an array";
  if (input.alerts.length > MAX_ALERT_EVENTS) return `alerts must hold at most ${MAX_ALERT_EVENTS} entries`;
  const alerts: AlertEvent[] = [];
  for (const raw of input.alerts as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "each alert must be an object";
    const alert = raw as Record<string, unknown>;
    for (const field of ["alertname", "at", "severity", "summary", "description"]) {
      if (typeof alert[field] !== "string") return `alert ${field} must be a string`;
    }
    if (alert.source !== undefined && typeof alert.source !== "string") return "alert source must be a string";
    for (const field of ["alertname", "at", "severity", "summary", "description", "source"]) {
      const value = alert[field];
      if (typeof value === "string" && value.length > MAX_ALERT_FIELD_LENGTH) return `alert ${field} must be at most ${MAX_ALERT_FIELD_LENGTH} characters`;
    }
    if (!(alert.alertname as string).trim()) return "alert alertname must not be empty";
    if (alert.status !== "firing" && alert.status !== "resolved") return "alert status must be firing or resolved";
    const instancesError = validateInstances(alert.instances);
    if (instancesError) return instancesError;
    alerts.push(alert as unknown as AlertEvent);
  }
  // The window never reaches past what `?state=closed` would show either.
  return { reopenWindowMs: Math.min(hours * 60 * 60 * 1000, CLOSED_LOOKBACK_MS), alerts };
}

/** A 400 message when an alert's optional `instances` is malformed, else undefined. */
function validateInstances(instances: unknown): string | undefined {
  if (instances === undefined) return undefined;
  if (!Array.isArray(instances)) return "alert instances must be an array";
  if (instances.length > MAX_ALERT_INSTANCES) return `alert instances must hold at most ${MAX_ALERT_INSTANCES} entries`;
  for (const raw of instances as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "each alert instance must be an object";
    const instance = raw as Record<string, unknown>;
    for (const field of ["key", "startsAt"]) {
      const value = instance[field];
      if (typeof value !== "string") return `alert instance ${field} must be a string`;
      if (value.length > MAX_ALERT_FIELD_LENGTH) return `alert instance ${field} must be at most ${MAX_ALERT_FIELD_LENGTH} characters`;
    }
  }
  return undefined;
}

/**
 * True when every firing lists at least one instance and every instance has a
 * parseable `startsAt` strictly before `closedAt`: a re-notification of
 * instances already firing when the issue closed. Anything else — no or empty
 * `instances`, an unparseable start, any later instance — is not pre-close.
 */
function isPreClose(firings: readonly AlertEvent[], closedAt: Date): boolean {
  return firings.every((e) => e.instances !== undefined && e.instances.length > 0 && e.instances.every((i) => {
    const started = Date.parse(i.startsAt);
    return Number.isFinite(started) && started < closedAt.getTime();
  }));
}

/**
 * True when `record` is one this bridge may touch over `…/alerts/events`: a
 * native issue (not a shadow) whose primary repo is the bridge repo and whose
 * dedupe key starts `alert-`. An alert inbox never qualifies, even one holding
 * an `alert-` key, so its own resolves still reach its sections.
 */
function isTrackingIssue(bridge: Bridge, record: db.ClawsIssueRecord | undefined): record is db.ClawsIssueRecord {
  return record !== undefined
    && record.kind === "issue"
    && clawsIssues.primaryRepo(record) === bridge.repo
    && (record.dedupe_key ?? "").startsWith("alert-")
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

/** Apply one alertname's events to the dedicated issue tracking it, if any. */
async function routeTrackedAlert(bridge: Bridge, alertname: string, events: readonly AlertEvent[], reopenWindowMs: number): Promise<AlertEventResult> {
  const key = alertDedupeKey(alertname);
  const firings = events.filter((e) => e.status === "firing");
  const open = await clawsIssues.findOpenIssueByDedupeKey(bridge.repo, key);
  if (isTrackingIssue(bridge, open)) {
    if (firings.length > 0) {
      const body = firings.reduce((acc, e) => bumpOccurrence(acc, e.at, issueFirstSeen(open)), open.body);
      if (body !== open.body) await clawsIssues.editIssue(open.id, body);
    }
    return { tracked: true, id: open.id, state: "open", reopened: false };
  }
  // Look back past the reopen window so a pre-close instance still matches;
  // the window itself only gates the reopen path below.
  const closed = await clawsIssues.findRecentlyClosedIssueByDedupeKey(bridge.repo, key, new Date(Date.now() - PRE_CLOSE_LOOKBACK_MS));
  if (!isTrackingIssue(bridge, closed) || !closed.closed_at) return { tracked: false };
  const closedAt = new Date(clawsIssues.toIso(closed.closed_at));
  const withinWindow = Date.now() - closedAt.getTime() <= reopenWindowMs;
  // A resolve on an already-closed tracked alert changes nothing; it is still
  // tracked, so the bridge leaves the inbox alone.
  if (firings.length === 0) return withinWindow ? { tracked: true, id: closed.id, state: "closed", reopened: false } : { tracked: false };
  if (isPreClose(firings, closedAt)) return await recordPreCloseFiring(bridge, alertname, closed, closedAt, firings);
  if (!withinWindow) return { tracked: false };

  const ref = `${bridge.repo} ${closed.id}`;
  await clawsIssues.reopenIssue(closed.id);
  const body = firings.reduce((acc, e) => bumpOccurrence(acc, e.at, issueFirstSeen(closed)), closed.body);
  if (body !== closed.body) await clawsIssues.editIssue(closed.id, body);
  const first = firings[0]!;
  const summary = first.summary.trim() ? ` (${first.summary.trim()})` : "";
  await clawsIssues.commentOnIssue(bridge.repo, closed.id, `Alert ${alertname} fired again at ${first.at}${summary}; reopened.`, clawsIssues.CLAWS_NATIVE_LOGIN);
  const replan = await requeueReopenedIssue(closed, bridge.repo);
  log.info(`[${NAME}] ${ref}: ${alertname} fired again; reopened its tracking issue${replan ? ", re-plan queued" : ""}`);
  return { tracked: true, id: closed.id, state: "open", reopened: true };
}

/**
 * A re-notification of instances that all began before `closed` closed: count
 * the occurrence and, once per close, say why the issue stays closed. No
 * reopen and no re-plan.
 */
async function recordPreCloseFiring(
  bridge: Bridge, alertname: string, closed: db.ClawsIssueRecord, closedAt: Date, firings: readonly AlertEvent[],
): Promise<AlertEventResult> {
  const body = firings.reduce((acc, e) => bumpOccurrence(acc, e.at, issueFirstSeen(closed)), closed.body);
  if (body !== closed.body) await clawsIssues.editIssue(closed.id, body);
  const comments = await clawsIssues.listCommentDetails(closed.id, { renderHtml: false });
  const commented = comments.some((c) => Date.parse(c.createdAt) >= closedAt.getTime() && c.body.includes(PRE_CLOSE_COMMENT_MARKER));
  if (!commented) {
    const first = firings[0]!;
    const summary = first.summary.trim() ? ` (${first.summary.trim()})` : "";
    await clawsIssues.commentOnIssue(
      bridge.repo, closed.id,
      `Alert ${alertname} fired again at ${first.at}${summary} for instance(s) that ${PRE_CLOSE_COMMENT_MARKER} at ${closedAt.toISOString()}; left closed and the occurrence counted. It reopens if a new instance of this alert fires.`,
      clawsIssues.CLAWS_NATIVE_LOGIN,
    );
  }
  log.info(`[${NAME}] ${bridge.repo} ${closed.id}: ${alertname} re-notified for instance(s) that began before the close; left closed, occurrence counted`);
  return { tracked: true, id: closed.id, state: "closed", reopened: false };
}

/**
 * `POST …/alerts/events` with `{ reopenWindowHours, alerts: [{ alertname,
 * status, at, severity, summary, description, source?, instances? }] }`:
 * route each alertname's events to the dedicated issue tracking it — the
 * native issue keyed {@link alertDedupeKey} whose primary repo is the bridge
 * repo, open or closed within the last 14 days. A firing bumps an open
 * issue's occurrence block. On a closed one, a firing whose `instances`
 * (`[{ key, startsAt }]`) all started before the issue closed only bumps the
 * occurrence block and posts one comment per close, leaving it closed; any
 * other firing on an issue closed within `reopenWindowHours` (capped at the
 * closed lookback) also reopens it, posts one comment and queues a re-plan,
 * and outside that window is untracked. A resolve changes nothing. Answers `{ results: { [alertname]: { tracked: true, id, state,
 * reopened } | { tracked: false } } }`; the bridge leaves a tracked alertname
 * out of its alert issue.
 */
export async function alertEventsHandler(c: Context): Promise<Response> {
  const bridge = bridgeFor(c);
  if (!bridge) return c.json({ error: "unauthorized" }, 401);
  const input = await readJson(c);
  if (!input) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = parseAlertEvents(input);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);

  const byName = new Map<string, AlertEvent[]>();
  for (const alert of parsed.alerts) {
    const list = byName.get(alert.alertname) ?? [];
    list.push(alert);
    byName.set(alert.alertname, list);
  }
  const results: Record<string, AlertEventResult> = {};
  for (const [alertname, events] of byName) {
    results[alertname] = await routeTrackedAlert(bridge, alertname, events, parsed.reopenWindowMs);
  }
  return c.json({ results });
}

/**
 * The Claws issue tracking `alertname` in `repo`'s alert bridge, for the
 * dashboard's `/alerts/lookup` redirect that Slack alerts link to: the open
 * dedicated issue keyed {@link alertDedupeKey}, else the oldest open inbox,
 * else a dedicated issue closed within 14 days, else an inbox closed within 7
 * days. An empty alertname skips the dedicated lookups. Null when nothing
 * matches or the repo has no `alertBridge`.
 */
export async function resolveAlertIssue(repo: string, alertname: string): Promise<string | null> {
  const bridge = bridgeForRepo(repo);
  if (!bridge) return null;
  const name = alertname.trim();
  const key = name ? alertDedupeKey(name) : null;
  if (key) {
    const open = await clawsIssues.findOpenIssueByDedupeKey(bridge.repo, key);
    if (isTrackingIssue(bridge, open)) return open.id;
  }
  const inbox = (await listOpenInboxes(bridge))[0];
  if (inbox) return inbox.id;
  if (key) {
    const closed = await clawsIssues.findRecentlyClosedIssueByDedupeKey(bridge.repo, key, new Date(Date.now() - PRE_CLOSE_LOOKBACK_MS));
    if (isTrackingIssue(bridge, closed)) return closed.id;
  }
  return (await listRecentlyClosedInboxes(bridge))[0]?.id ?? null;
}
