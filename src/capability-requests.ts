import { allCapabilities, capabilityLabel, isAutoApproveCapability } from "./capabilities.js";
import {
  deleteSessionCapabilityRequest,
  getSessionCapabilityRequest,
  insertSessionCapabilityRequestIfAbsent,
  listPendingSessionCapabilityRequests,
  listSessionCapabilityRequests,
  markSessionCapabilityRequest,
  pruneSessionCapabilityRequestsForEndedSessions,
  setSessionCapabilityRequestStatus,
  upsertSessionCapabilityRequest,
  type SessionCapabilityRequestRow,
} from "./db.js";
import * as log from "./log.js";
import { getSessionBackend, type GrantCapabilityResult, type GrantDelivery, type NotifyAgentResult } from "./session-backend.js";
import { sleep as defaultSleep } from "./util.js";

/**
 * Agent-initiated capability requests (#3072). A session's agent asks for a
 * capability with the `claws_request_capability` MCP tool; the operator
 * approves or denies it on the session's dashboard page, and approval grants it
 * through `SessionBackend.grantCapability`.
 *
 * Requests and their decisions live only in the `session_capability_requests`
 * table, so every Claws process — the web tier that serves the routes and the
 * controller — reads the same state (#clw_01M5APX7YF3AGWHV1S1WMHJDR6). A
 * pending request survives a restart and can still be approved or denied, and
 * a denial sticks for its (session, capability) pair until the session ends or
 * the grant is revoked; the operator can still grant it with the Grant
 * control. Where a grant's vars are delivered is never kept here: the routes
 * ask `SessionBackend.grantDelivery`, which stays right across a restart or a
 * resume.
 *
 * An approval can land after `claws_request_capability` stopped waiting
 * (#3106), and a grant from the operator's Grant control has no request at
 * all. Each request records when the agent last polled it and when a route
 * last returned it granted; a grant waits briefly for a recently polling agent
 * to collect it, and otherwise Claws types a notice into the agent's terminal
 * itself (`SessionBackend.notifyAgent`), so no browser tab is involved.
 */

export type CapabilityRequestStatus = "pending" | "approved" | "denied";
/** Who decided a request: Claws for an auto-approve capability, or the operator. */
export type CapabilityDecider = "auto" | "operator";

export interface CapabilityRequest {
  sessionId: string;
  capability: string;
  status: CapabilityRequestStatus;
  reason: string;
  requestedAt: number;
  decidedAt: number | null;
  /** When the agent last hit a request route for the pair. */
  lastPolledAt: number | null;
  /** When a request route last returned the pair to the agent as granted. */
  grantSeenAt: number | null;
  /** Who decided it; null while pending. A legacy decided row reads as `operator`. */
  decidedBy: CapabilityDecider | null;
}

/** Longest `reason` kept; agent-controlled text shown on the dashboard. */
export const MAX_REASON_LENGTH = 300;
/** Pending requests one session may hold at once. */
export const MAX_PENDING_PER_SESSION = 5;
/** A poll this recent means `claws_request_capability` is still waiting (it polls every 3s). */
export const AGENT_POLL_FRESH_MS = 6_000;
/** Longest an approval waits for a waiting agent to collect its grant. */
export const AGENT_PICKUP_WAIT_MS = 8_000;
const AGENT_PICKUP_CHECK_MS = 250;

function isStatus(value: string): value is CapabilityRequestStatus {
  return value === "pending" || value === "approved" || value === "denied";
}

function fromRow(row: SessionCapabilityRequestRow): CapabilityRequest | undefined {
  if (!isStatus(row.status)) return undefined;
  return {
    sessionId: row.session_id,
    capability: row.capability,
    status: row.status,
    reason: row.reason,
    requestedAt: Number(row.requested_at),
    decidedAt: row.decided_at === null ? null : Number(row.decided_at),
    lastPolledAt: row.last_polled_at === null ? null : Number(row.last_polled_at),
    grantSeenAt: row.grant_seen_at === null ? null : Number(row.grant_seen_at),
    decidedBy: row.decided_by === "auto" ? "auto" : row.status === "pending" && row.decided_by === null ? null : "operator",
  };
}

function toRow(entry: CapabilityRequest): SessionCapabilityRequestRow {
  return {
    session_id: entry.sessionId,
    capability: entry.capability,
    status: entry.status,
    reason: entry.reason,
    requested_at: entry.requestedAt,
    decided_at: entry.decidedAt,
    last_polled_at: entry.lastPolledAt,
    grant_seen_at: entry.grantSeenAt,
    decided_by: entry.decidedBy,
  };
}

/** Delete the stored request(s) of a session; a failure is logged. */
async function unpersist(sessionId: string, capId?: string): Promise<void> {
  try {
    await deleteSessionCapabilityRequest(sessionId, capId);
  } catch (err) {
    log.warn(`[capability-requests] Session ${sessionId}: failed to delete stored ${capId ?? "capability"} request(s): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Startup cleanup: deletes the stored requests of ended or deleted sessions.
 * Returns how many rows went.
 */
export async function loadCapabilityRequests(): Promise<number> {
  const pruned = await pruneSessionCapabilityRequestsForEndedSessions();
  if (pruned > 0) log.info(`[capability-requests] Dropped ${pruned} stored request(s) of ended sessions`);
  return pruned;
}

/**
 * Record a request. An existing pending, approved or denied entry for the pair
 * is returned unchanged, so a repeat never re-opens a denial. `too-many` when
 * the session already has `MAX_PENDING_PER_SESSION` pending requests, unless
 * `opts.skipPendingLimit` is set for an auto-approve capability, which is
 * granted at once rather than left for the operator. The caller has already
 * checked the capability is requestable.
 */
export async function request(
  sessionId: string,
  capId: string,
  reason: string,
  now: number = Date.now(),
  opts: { skipPendingLimit?: boolean } = {},
): Promise<{ ok: true; request: CapabilityRequest } | { ok: false; reason: "too-many" }> {
  const existing = await get(sessionId, capId);
  if (existing) return { ok: true, request: existing };
  const skipLimit = opts.skipPendingLimit === true && isAutoApproveCapability(capId);
  if (!skipLimit && (await listPending(sessionId)).length >= MAX_PENDING_PER_SESSION) return { ok: false, reason: "too-many" };
  const created: CapabilityRequest = {
    sessionId,
    capability: capId,
    status: "pending",
    reason: reason.trim().slice(0, MAX_REASON_LENGTH),
    requestedAt: now,
    decidedAt: null,
    lastPolledAt: now,
    grantSeenAt: null,
    decidedBy: null,
  };
  if (await insertSessionCapabilityRequestIfAbsent(toRow(created))) return { ok: true, request: created };
  // Another process stored the pair's request first; that one stands.
  const raced = await get(sessionId, capId);
  return { ok: true, request: raced ?? created };
}

export async function get(sessionId: string, capId: string): Promise<CapabilityRequest | undefined> {
  const row = await getSessionCapabilityRequest(sessionId, capId);
  return row ? fromRow(row) : undefined;
}

async function mark(sessionId: string, capId: string, column: "last_polled_at" | "grant_seen_at", now: number): Promise<void> {
  try {
    await markSessionCapabilityRequest(sessionId, capId, column, now);
  } catch (err) {
    log.warn(`[capability-requests] Session ${sessionId}: failed to record ${column} for ${capId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Record that the agent polled the pair's request; nothing without one. Never throws. */
export async function markPolled(sessionId: string, capId: string, now: number = Date.now()): Promise<void> {
  await mark(sessionId, capId, "last_polled_at", now);
}

/** Record that a request route returned the pair to the agent as granted; nothing without a request. Never throws. */
export async function markGrantSeen(sessionId: string, capId: string, now: number = Date.now()): Promise<void> {
  await mark(sessionId, capId, "grant_seen_at", now);
}

/** A session's pending requests, oldest first. */
export async function listPending(sessionId: string): Promise<CapabilityRequest[]> {
  return (await listSessionCapabilityRequests(sessionId))
    .map(fromRow)
    .filter((r): r is CapabilityRequest => r !== undefined && r.status === "pending")
    .sort((a, b) => a.requestedAt - b.requestedAt);
}

/** A session's approved requests Claws decided automatically, oldest first. */
export async function listAutoGranted(sessionId: string): Promise<CapabilityRequest[]> {
  return (await listSessionCapabilityRequests(sessionId))
    .map(fromRow)
    .filter((r): r is CapabilityRequest => r !== undefined && r.status === "approved" && r.decidedBy === "auto")
    .sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0));
}

/**
 * Every session's pending requests, keyed by session id, each list oldest
 * first. Feeds the Sessions list's pending-request marker.
 */
export async function listPendingBySession(): Promise<Map<string, CapabilityRequest[]>> {
  const bySession = new Map<string, CapabilityRequest[]>();
  for (const row of await listPendingSessionCapabilityRequests()) {
    const entry = fromRow(row);
    if (!entry || entry.status !== "pending") continue;
    const list = bySession.get(entry.sessionId);
    if (list) list.push(entry);
    else bySession.set(entry.sessionId, [entry]);
  }
  return bySession;
}

/** A pending request as the Sessions list shows it. */
export interface PendingCapabilityRequestView {
  capability: string;
  label: string;
  reason: string;
  requestedAt: number;
}

/** The Sessions list's view of a pending request. */
export function pendingRequestView(entry: CapabilityRequest): PendingCapabilityRequestView {
  return { capability: entry.capability, label: capabilityLabel(entry.capability), reason: entry.reason, requestedAt: entry.requestedAt };
}

export interface PickupOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How a grant reached the agent (see `deliverGrantNotice`): a waiting agent
 * collected it, or Claws typed a notice into its terminal; `notifyFailure`
 * says why a needed notice could not be delivered.
 */
export interface GrantNoticeOutcome {
  agentPickedUp: boolean;
  agentNotified: boolean;
  notifyFailure: Exclude<NotifyAgentResult, "ok"> | null;
  /** The grant restarted the agent: Claws types the notice once it is back. */
  agentNoticeQueued: boolean;
}

const NO_NOTICE: GrantNoticeOutcome = { agentPickedUp: false, agentNotified: false, notifyFailure: null, agentNoticeQueued: false };

export type DecideResult =
  | ({ ok: true; request: CapabilityRequest; grant: Extract<GrantCapabilityResult, { ok: true }> | null } & GrantNoticeOutcome)
  | { ok: false; reason: "not-found" | "not-pending" }
  | { ok: false; reason: "grant-failed"; grant: Exclude<GrantCapabilityResult, { ok: true }> };

/**
 * Approve or deny a pending request. Approval grants the capability through the
 * session backend and returns the grant (null for a denial); if the grant fails
 * the request stays pending and the failure is returned for the operator.
 */
export async function decide(
  sessionId: string,
  capId: string,
  approve: boolean,
  now: () => number = Date.now,
  pickup: PickupOptions = {},
): Promise<DecideResult> {
  const entry = await get(sessionId, capId);
  if (!entry) return { ok: false, reason: "not-found" };
  if (entry.status !== "pending") return { ok: false, reason: "not-pending" };
  if (!approve) {
    const decidedAt = now();
    // Conditional, so a decision another process stored meanwhile stands.
    if (!await setSessionCapabilityRequestStatus(sessionId, capId, "denied", decidedAt, { onlyIfPending: true })) {
      return { ok: false, reason: "not-pending" };
    }
    return { ok: true, request: { ...entry, status: "denied", decidedAt, decidedBy: "operator" }, grant: null, ...NO_NOTICE };
  }
  const grant = await getSessionBackend().grantCapability(sessionId, capId);
  if (!grant.ok) return { ok: false, reason: "grant-failed", grant };
  // A concurrent decision may have landed while the grant ran; the grant still
  // stands, and the route that made it tells the agent.
  const decidedAt = now();
  const resolved = await recordGrant(sessionId, capId, decidedAt);
  const outcome = resolved ? await deliverGrantNotice(sessionId, capId, grant, pickup) : NO_NOTICE;
  return { ok: true, request: { ...entry, status: "approved", decidedAt, decidedBy: "operator" }, grant, ...outcome };
}

export type AutoApproveResult =
  | { ok: true; request: CapabilityRequest; grant: Extract<GrantCapabilityResult, { ok: true }>; agentNoticeQueued: boolean }
  | { ok: false; reason: "not-found" | "not-pending" }
  | { ok: false; reason: "grant-failed"; grant: Exclude<GrantCapabilityResult, { ok: true }> };

/**
 * Grant a pending request for an auto-approve capability at once, through the
 * same `SessionBackend.grantCapability` an operator approval uses
 * (#clw_01M77K5B15JHY1N6JMGRZDFQ0D), and record it as decided by `auto`. The
 * agent asked from inside its own tool call, so this never waits for it to
 * pick the grant up: the route returns the grant directly. Only a grant that
 * restarted the agent (`browser`) queues `notifyAgentOnceReady`, since the
 * restart ends that tool call. A failed grant leaves the request pending for
 * the operator.
 */
export async function autoApprove(sessionId: string, capId: string, now: () => number = Date.now): Promise<AutoApproveResult> {
  const entry = await get(sessionId, capId);
  if (!entry) return { ok: false, reason: "not-found" };
  if (entry.status !== "pending") return { ok: false, reason: "not-pending" };
  const grant = await getSessionBackend().grantCapability(sessionId, capId);
  if (!grant.ok) return { ok: false, reason: "grant-failed", grant };
  const decidedAt = now();
  await recordGrant(sessionId, capId, decidedAt, "auto");
  let agentNoticeQueued = false;
  if (grant.live && grant.restarted) {
    getSessionBackend().notifyAgentOnceReady(sessionId, agentGrantNotice(capId, true, { restarted: true, auto: true }));
    agentNoticeQueued = true;
  }
  return { ok: true, request: { ...entry, status: "approved", decidedAt, decidedBy: "auto" }, grant, agentNoticeQueued };
}

/**
 * Resolve the pair's request, if any, as approved after a successful grant —
 * from `decide`, `autoApprove`, or the operator's Grant control — so its banner
 * clears. True only when the entry it resolved was pending, i.e. an agent asked for it.
 */
export async function recordGrant(
  sessionId: string,
  capId: string,
  now: number = Date.now(),
  decidedBy: CapabilityDecider = "operator",
): Promise<boolean> {
  if (await setSessionCapabilityRequestStatus(sessionId, capId, "approved", now, { onlyIfPending: true, decidedBy })) return true;
  await setSessionCapabilityRequestStatus(sessionId, capId, "approved", now, { decidedBy });
  return false;
}

/** Reason stored on the denial a revoke of an auto-approve capability leaves. */
export const REVOKED_REASON = "Revoked by the operator";

/**
 * After the operator revokes an auto-approve capability: store a denial for
 * the pair, whether or not a request existed, so a repeat request is refused
 * rather than granted automatically again. The operator can still grant it
 * with the Grant control.
 */
export async function recordRevoke(sessionId: string, capId: string, now: number = Date.now()): Promise<void> {
  await upsertSessionCapabilityRequest({
    session_id: sessionId,
    capability: capId,
    status: "denied",
    reason: REVOKED_REASON,
    requested_at: now,
    decided_at: now,
    last_polled_at: null,
    grant_seen_at: null,
    decided_by: "operator",
  });
}

/**
 * Store an approved, `auto`-decided row for a capability granted at a
 * session's launch because it was named in `claws_start_session`'s
 * `request_capabilities` and is auto-approve, so the session page shows it as
 * granted automatically.
 */
export async function recordAutoGrantAtLaunch(sessionId: string, capId: string, reason: string, now: number = Date.now()): Promise<void> {
  await upsertSessionCapabilityRequest({
    session_id: sessionId,
    capability: capId,
    status: "approved",
    reason: reason.trim().slice(0, MAX_REASON_LENGTH),
    requested_at: now,
    decided_at: now,
    last_polled_at: null,
    grant_seen_at: null,
    decided_by: "auto",
  });
}

/**
 * After a grant resolved a pending request: if the agent polled within
 * `AGENT_POLL_FRESH_MS`, wait up to `AGENT_PICKUP_WAIT_MS` for a request route
 * to return it the grant. False straight away when there is no request or its
 * last poll is stale, and as soon as the request disappears (the session ended).
 */
export async function awaitAgentPickup(sessionId: string, capId: string, opts: PickupOptions = {}): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const entry = await get(sessionId, capId);
  if (!entry || entry.lastPolledAt === null || now() - entry.lastPolledAt > AGENT_POLL_FRESH_MS) return false;
  const deadline = now() + AGENT_PICKUP_WAIT_MS;
  for (let first = true; ; first = false) {
    // Re-read each round: the route that hands the agent its grant may run in
    // another process. A request that went (or was re-filed) ends the wait.
    const current = first ? entry : await get(sessionId, capId);
    if (!current || current.requestedAt !== entry.requestedAt) return false;
    if (current.grantSeenAt !== null) return true;
    const left = deadline - now();
    if (left <= 0) return false;
    await sleep(Math.min(AGENT_PICKUP_CHECK_MS, left));
  }
}

/**
 * Make sure the agent learns of a live grant, from an approved request or the
 * operator's Grant control: a landed grant first waits for a polling agent to
 * collect it (`awaitAgentPickup`); when it does not, or nobody was waiting,
 * Claws types `agentGrantNotice` into the agent's terminal. A grant that only
 * takes effect on resume (`live: false`) never notifies. A grant that
 * restarted the agent (`restarted`) has no agent to collect it yet: the
 * notice is queued with `notifyAgentOnceReady` and typed once the agent is back.
 */
export async function deliverGrantNotice(
  sessionId: string,
  capId: string,
  grant: GrantDelivery,
  opts: PickupOptions = {},
): Promise<GrantNoticeOutcome> {
  if (!grant.live) return NO_NOTICE;
  if (grant.restarted) {
    getSessionBackend().notifyAgentOnceReady(sessionId, agentGrantNotice(capId, true, { restarted: true }));
    return { ...NO_NOTICE, agentNoticeQueued: true };
  }
  if (grant.landed && await awaitAgentPickup(sessionId, capId, opts)) return { ...NO_NOTICE, agentPickedUp: true };
  const sent = await getSessionBackend().notifyAgent(sessionId, agentGrantNotice(capId, grant.landed));
  return sent === "ok" ? { ...NO_NOTICE, agentNotified: true } : { ...NO_NOTICE, notifyFailure: sent };
}

/**
 * The one-line notice Claws types into the agent's terminal after a grant.
 * Never includes the agent's reason, a path or a credential. While the grant
 * is still landing it says so rather than calling it usable. After a grant
 * that restarted the agent (`restarted`) it says the conversation was kept.
 * An automatic grant (`auto`) says Claws granted it automatically.
 */
export function agentGrantNotice(capId: string, landed = true, opts: { restarted?: boolean; auto?: boolean } = {}): string {
  const label = allCapabilities().find((c) => c.id === capId)?.label ?? capId;
  const who = opts.auto ? `Claws granted you the capability ${capId} (${label}) automatically` : `The user granted you the capability ${capId} (${label})`;
  if (opts.restarted) {
    return `[Claws] ${who}. `
      + `Claws restarted your agent with the conversation kept so its MCP tools are loaded; `
      + `you now hold it, ignore it in your "Requestable capabilities" list and do not request it again. `
      + `Continue where you left off.`;
  }
  if (!landed) {
    return `[Claws] ${who}, and Claws is still delivering it to this session. `
      + `Ignore it in your "Requestable capabilities" list and do not request it again. `
      + `Call claws_request_capability with capability "${capId}" to wait until it is usable, then continue.`;
  }
  return `[Claws] ${who}. `
    + `You now hold it; ignore it in your "Requestable capabilities" list and do not request it. `
    + `Its credentials are already exported in every new shell, nothing to source. `
    + `Call claws_request_capability with capability "${capId}" and timeout_seconds 0 for its usage guidance, then continue.`;
}

/** Drop every request for a session that has ended or been deleted. */
export async function clearCapabilityRequestsForSession(sessionId: string): Promise<void> {
  await unpersist(sessionId);
}

/** Drop a session's request for one capability, so a request after a revoke starts fresh. */
export async function clearCapabilityRequest(sessionId: string, capId: string): Promise<void> {
  await unpersist(sessionId, capId);
}

/** The JSON shape the request routes return for a pending or denied request. */
export function describeCapabilityRequest(entry: CapabilityRequest): Record<string, unknown> {
  const cap = allCapabilities().find((c) => c.id === entry.capability);
  return {
    status: entry.status,
    capability: entry.capability,
    label: cap?.label ?? entry.capability,
    reason: entry.reason,
    requestedAt: entry.requestedAt,
    decidedAt: entry.decidedAt,
  };
}

/**
 * The JSON shape for a capability the session holds: its request (if Claws
 * still has one) as `granted` — or `landing` while a live grant has not yet
 * reached the running session — with usage guidance and `delivery` from
 * `SessionBackend.grantDelivery` or the grant itself. No credential value is
 * ever included.
 */
export function describeGrantedCapability(
  capId: string,
  delivery: GrantDelivery,
  entry?: CapabilityRequest,
): Record<string, unknown> {
  const cap = allCapabilities().find((c) => c.id === capId);
  return {
    status: delivery.live && !delivery.landed ? "landing" : "granted",
    capability: capId,
    label: capabilityLabel(capId),
    reason: entry?.reason ?? "",
    requestedAt: entry?.requestedAt ?? null,
    decidedAt: entry?.decidedAt ?? null,
    description: cap?.description ?? "",
    live: delivery.live,
    loadPath: delivery.loadPath,
    marker: delivery.marker,
    delayed: delivery.delayed,
    landed: delivery.landed,
    restarted: delivery.restarted,
  };
}
