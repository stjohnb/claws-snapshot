import { CAPABILITIES, capabilityLabel } from "./capabilities.js";
import { getSessionBackend, type GrantCapabilityResult, type GrantDelivery } from "./session-backend.js";
import { sleep as defaultSleep } from "./util.js";

/**
 * Agent-initiated capability requests (#3072). A session's agent asks for a
 * capability with the `claws_request_capability` MCP tool; the operator
 * approves or denies it on the session's dashboard page, and approval grants it
 * through `SessionBackend.grantCapability`.
 *
 * In memory only: Claws runs as a single replica, a restart drops pending
 * requests (the agent re-requests), and an approved grant is already persisted
 * on the session row. Where a grant's vars are delivered is never kept here:
 * the routes ask `SessionBackend.grantDelivery`, which stays right across a
 * restart or a resume. A denial sticks for its (session, capability) pair until
 * Claws restarts or the session ends; the operator can still grant it with the
 * Grant control.
 *
 * An approval can land after `claws_request_capability` stopped waiting
 * (#3106). Each request records when the agent last polled it and when a route
 * last returned it granted; approval waits briefly for a recently polling agent
 * to collect the grant, and otherwise reports that the agent needs a notice,
 * which the approving dashboard page types into the agent's terminal.
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

/**
 * Record a request. An existing pending, approved or denied entry for the pair
 * is returned unchanged, so a repeat never re-opens a denial. `too-many` when
 * the session already has `MAX_PENDING_PER_SESSION` pending requests. The
 * caller has already checked the capability is requestable.
 */
export function request(
  sessionId: string,
  capId: string,
  reason: string,
  now: number = Date.now(),
): { ok: true; request: CapabilityRequest } | { ok: false; reason: "too-many" } {
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
  let forSession = requests.get(sessionId);
  if (!forSession) {
    forSession = new Map();
    requests.set(sessionId, forSession);
  }
  forSession.set(capId, created);
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

/** Whether a grant reached the agent, and whether it must be told (see `resolveAgentPickup`). */
export interface AgentPickup {
  agentPickedUp: boolean;
  agentNoticeNeeded: boolean;
}

export type DecideResult =
  | ({ ok: true; request: CapabilityRequest; grant: Extract<GrantCapabilityResult, { ok: true }> | null } & AgentPickup)
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
    return { ok: true, request: entry, grant: null, agentPickedUp: false, agentNoticeNeeded: false };
  }
  const grant = await getSessionBackend().grantCapability(sessionId, capId);
  if (!grant.ok) return { ok: false, reason: "grant-failed", grant };
  // A concurrent decision may have landed while the grant ran; the grant still stands.
  const resolved = recordGrant(sessionId, capId, now());
  const outcome = resolved ? await resolveAgentPickup(sessionId, capId, grant.live, pickup) : { agentPickedUp: false, agentNoticeNeeded: false };
  return { ok: true, request: entry, grant, ...outcome };
}

/**
 * Resolve the pair's request, if any, as approved after a successful grant —
 * from `decide`, or from the operator's Grant control — so its banner clears.
 * True only when the entry it resolved was pending, i.e. an agent asked for it.
 */
export function recordGrant(sessionId: string, capId: string, now: number = Date.now()): boolean {
  const entry = get(sessionId, capId);
  if (!entry) return false;
  const wasPending = entry.status === "pending";
  entry.status = "approved";
  entry.decidedAt = now;
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
 * Whether a grant that resolved a pending request reached the agent, and
 * whether the agent must be told with `agentGrantNotice`. A grant that only
 * takes effect on resume (`live: false`) never needs a notice.
 */
export async function resolveAgentPickup(
  sessionId: string,
  capId: string,
  live: boolean,
  opts: PickupOptions = {},
): Promise<AgentPickup> {
  if (!live) return { agentPickedUp: false, agentNoticeNeeded: false };
  const agentPickedUp = await awaitAgentPickup(sessionId, capId, opts);
  return { agentPickedUp, agentNoticeNeeded: !agentPickedUp };
}

/**
 * The one-line notice the approving dashboard page types into the agent's
 * terminal when the agent stopped waiting. Never includes the agent's reason,
 * a path or a credential.
 */
export function agentGrantNotice(capId: string): string {
  const label = CAPABILITIES.find((c) => c.id === capId)?.label ?? capId;
  return `[Claws] The user approved your capability request for ${capId} (${label}). `
    + `Call claws_request_capability with capability "${capId}" and timeout_seconds 0 to get how to load it, then continue.`;
}

/** Drop every request for a session that has ended or been deleted. */
export function clearCapabilityRequestsForSession(sessionId: string): void {
  requests.delete(sessionId);
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
 * still has one) as `granted`, with usage guidance and `delivery` from
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
    status: "granted",
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
  };
}

/** Drop every request. Tests only. */
export function clearCapabilityRequestsForTests(): void {
  requests.clear();
}
