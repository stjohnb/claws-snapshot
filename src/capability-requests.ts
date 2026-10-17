import { CAPABILITIES, capabilityLabel } from "./capabilities.js";
import { deleteSessionCapabilityRequest, listSessionCapabilityRequestsForLiveSessions, pruneSessionCapabilityRequestsForEndedSessions, upsertSessionCapabilityRequest } from "./db.js";
import * as log from "./log.js";
import { getSessionBackend, type GrantCapabilityResult, type GrantDelivery, type NotifyAgentResult } from "./session-backend.js";
import { sleep as defaultSleep } from "./util.js";

/**
 * Agent-initiated capability requests (#3072). A session's agent asks for a
 * capability with the `claws_request_capability` MCP tool; the operator
 * approves or denies it on the session's dashboard page, and approval grants it
 * through `SessionBackend.grantCapability`.
 *
 * Requests and their decisions are written through to the
 * `session_capability_requests` table and the in-memory map is their cache:
 * Claws runs as a single replica, so the map is authoritative while it runs and
 * `loadCapabilityRequests` refills it at startup. A pending request therefore
 * survives a restart and can still be approved or denied, and a denial sticks
 * for its (session, capability) pair until the session ends or the grant is
 * revoked; the operator can still grant it with the Grant control. A failed DB
 * write is logged and the in-memory change stands. Where a grant's vars are
 * delivered is never kept here: the routes ask `SessionBackend.grantDelivery`,
 * which stays right across a restart or a resume.
 *
 * An approval can land after `claws_request_capability` stopped waiting
 * (#3106), and a grant from the operator's Grant control has no request at
 * all. Each request records when the agent last polled it and when a route
 * last returned it granted; a grant waits briefly for a recently polling agent
 * to collect it, and otherwise Claws types a notice into the agent's terminal
 * itself (`SessionBackend.notifyAgent`), so no browser tab is involved.
 */

export type CapabilityRequestStatus = "pending" | "approved" | "denied";

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

/** Session id → capability id → request. */
const requests = new Map<string, Map<string, CapabilityRequest>>();

function cache(entry: CapabilityRequest): void {
  let forSession = requests.get(entry.sessionId);
  if (!forSession) {
    forSession = new Map();
    requests.set(entry.sessionId, forSession);
  }
  forSession.set(entry.capability, entry);
}

/** Write `entry` through to the DB; a failure is logged and the cached change stands. */
async function persist(entry: CapabilityRequest): Promise<void> {
  try {
    await upsertSessionCapabilityRequest({
      session_id: entry.sessionId,
      capability: entry.capability,
      status: entry.status,
      reason: entry.reason,
      requested_at: entry.requestedAt,
      decided_at: entry.decidedAt,
    });
  } catch (err) {
    log.warn(`[capability-requests] Session ${entry.sessionId}: failed to store the ${entry.capability} request (${entry.status}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Delete the stored request(s) of a session; a failure is logged. */
async function unpersist(sessionId: string, capId?: string): Promise<void> {
  try {
    await deleteSessionCapabilityRequest(sessionId, capId);
  } catch (err) {
    log.warn(`[capability-requests] Session ${sessionId}: failed to delete stored ${capId ?? "capability"} request(s): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isStatus(value: string): value is CapabilityRequestStatus {
  return value === "pending" || value === "approved" || value === "denied";
}

/**
 * Fill the cache from the DB at startup, before the server takes requests:
 * every stored request of a live session, with no poll or pickup recorded
 * (`lastPolledAt`/`grantSeenAt` are never stored). Rows of ended or deleted
 * sessions are deleted. Returns how many requests were loaded.
 */
export async function loadCapabilityRequests(): Promise<number> {
  const pruned = await pruneSessionCapabilityRequestsForEndedSessions();
  if (pruned > 0) log.info(`[capability-requests] Dropped ${pruned} stored request(s) of ended sessions`);
  let loaded = 0;
  for (const row of await listSessionCapabilityRequestsForLiveSessions()) {
    if (!isStatus(row.status)) continue;
    cache({
      sessionId: row.session_id,
      capability: row.capability,
      status: row.status,
      reason: row.reason,
      requestedAt: Number(row.requested_at),
      decidedAt: row.decided_at === null ? null : Number(row.decided_at),
      lastPolledAt: null,
      grantSeenAt: null,
    });
    loaded += 1;
  }
  return loaded;
}

/**
 * Record a request. An existing pending, approved or denied entry for the pair
 * is returned unchanged, so a repeat never re-opens a denial. `too-many` when
 * the session already has `MAX_PENDING_PER_SESSION` pending requests. The
 * caller has already checked the capability is requestable.
 */
export async function request(
  sessionId: string,
  capId: string,
  reason: string,
  now: number = Date.now(),
): Promise<{ ok: true; request: CapabilityRequest } | { ok: false; reason: "too-many" }> {
  const existing = get(sessionId, capId);
  if (existing) return { ok: true, request: existing };
  if (listPending(sessionId).length >= MAX_PENDING_PER_SESSION) return { ok: false, reason: "too-many" };
  const created: CapabilityRequest = {
    sessionId,
    capability: capId,
    status: "pending",
    reason: reason.trim().slice(0, MAX_REASON_LENGTH),
    requestedAt: now,
    decidedAt: null,
    lastPolledAt: now,
    grantSeenAt: null,
  };
  cache(created);
  await persist(created);
  return { ok: true, request: created };
}

export function get(sessionId: string, capId: string): CapabilityRequest | undefined {
  return requests.get(sessionId)?.get(capId);
}

/** Record that the agent polled the pair's request; nothing without one. */
export function markPolled(sessionId: string, capId: string, now: number = Date.now()): void {
  const entry = get(sessionId, capId);
  if (entry) entry.lastPolledAt = now;
}

/** Record that a request route returned the pair to the agent as granted; nothing without a request. */
export function markGrantSeen(sessionId: string, capId: string, now: number = Date.now()): void {
  const entry = get(sessionId, capId);
  if (entry) entry.grantSeenAt = now;
}

/** A session's pending requests, oldest first. */
export function listPending(sessionId: string): CapabilityRequest[] {
  return [...(requests.get(sessionId)?.values() ?? [])]
    .filter((r) => r.status === "pending")
    .sort((a, b) => a.requestedAt - b.requestedAt);
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
  const entry = get(sessionId, capId);
  if (!entry) return { ok: false, reason: "not-found" };
  if (entry.status !== "pending") return { ok: false, reason: "not-pending" };
  if (!approve) {
    entry.status = "denied";
    entry.decidedAt = now();
    await persist(entry);
    return { ok: true, request: entry, grant: null, ...NO_NOTICE };
  }
  const grant = await getSessionBackend().grantCapability(sessionId, capId);
  if (!grant.ok) return { ok: false, reason: "grant-failed", grant };
  // A concurrent decision may have landed while the grant ran; the grant still
  // stands, and the route that made it tells the agent.
  const resolved = await recordGrant(sessionId, capId, now());
  const outcome = resolved ? await deliverGrantNotice(sessionId, capId, grant, pickup) : NO_NOTICE;
  return { ok: true, request: entry, grant, ...outcome };
}

/**
 * Resolve the pair's request, if any, as approved after a successful grant —
 * from `decide`, or from the operator's Grant control — so its banner clears.
 * True only when the entry it resolved was pending, i.e. an agent asked for it.
 */
export async function recordGrant(sessionId: string, capId: string, now: number = Date.now()): Promise<boolean> {
  const entry = get(sessionId, capId);
  if (!entry) return false;
  const wasPending = entry.status === "pending";
  entry.status = "approved";
  entry.decidedAt = now;
  await persist(entry);
  return wasPending;
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
  const entry = get(sessionId, capId);
  if (!entry || entry.lastPolledAt === null || now() - entry.lastPolledAt > AGENT_POLL_FRESH_MS) return false;
  const deadline = now() + AGENT_PICKUP_WAIT_MS;
  for (;;) {
    if (get(sessionId, capId) !== entry) return false;
    if (entry.grantSeenAt !== null) return true;
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
 */
export function agentGrantNotice(capId: string, landed = true, opts: { restarted?: boolean } = {}): string {
  const label = CAPABILITIES.find((c) => c.id === capId)?.label ?? capId;
  if (opts.restarted) {
    return `[Claws] The user granted you the capability ${capId} (${label}). `
      + `Claws restarted your agent with the conversation kept so its MCP tools are loaded; `
      + `you now hold it, ignore it in your "Requestable capabilities" list and do not request it again. `
      + `Continue where you left off.`;
  }
  if (!landed) {
    return `[Claws] The user granted you the capability ${capId} (${label}), and Claws is still delivering it to this session. `
      + `Ignore it in your "Requestable capabilities" list and do not request it again. `
      + `Call claws_request_capability with capability "${capId}" to wait until it is usable, then continue.`;
  }
  return `[Claws] The user granted you the capability ${capId} (${label}). `
    + `You now hold it; ignore it in your "Requestable capabilities" list and do not request it. `
    + `Its credentials are already exported in every new shell, nothing to source. `
    + `Call claws_request_capability with capability "${capId}" and timeout_seconds 0 for its usage guidance, then continue.`;
}

/** Drop every request for a session that has ended or been deleted. */
export async function clearCapabilityRequestsForSession(sessionId: string): Promise<void> {
  requests.delete(sessionId);
  await unpersist(sessionId);
}

/** Drop a session's request for one capability, so a request after a revoke starts fresh. */
export async function clearCapabilityRequest(sessionId: string, capId: string): Promise<void> {
  const forSession = requests.get(sessionId);
  if (forSession) {
    forSession.delete(capId);
    if (forSession.size === 0) requests.delete(sessionId);
  }
  await unpersist(sessionId, capId);
}

/** The JSON shape the request routes return for a pending or denied request. */
export function describeCapabilityRequest(entry: CapabilityRequest): Record<string, unknown> {
  const cap = CAPABILITIES.find((c) => c.id === entry.capability);
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
  const cap = CAPABILITIES.find((c) => c.id === capId);
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

/** Drop every cached request; the DB is untouched. Tests only. */
export function clearCapabilityRequestsForTests(): void {
  requests.clear();
}
