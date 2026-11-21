import crypto from "node:crypto";
import * as log from "./log.js";
import type { SessionPodSettings } from "./config.js";
import {
  SESSION_MOVE_BLOCKING_STATES,
  claimSessionMove,
  clearNodeEvacuation,
  deleteRetiredSettleMoves,
  deleteSessionMove,
  deleteUnstartedSessionMove,
  getAllPersistedSessions,
  getEndedSessions,
  getNodeEvacuation,
  getPersistedSession,
  getLatestSessionMove,
  insertSessionMove,
  listActiveSessionMoves,
  listNodeEvacuations,
  listSessionMovesFromNode,
  requestNodeEvacuation,
  setSessionHomeClaim,
  setSessionNode,
  updateSessionMove,
  type NodeEvacuation,
  type PersistedSession,
  type SessionMove,
  type SessionMoveState,
} from "./db.js";
import type { K8sClient, K8sError, K8sObject } from "./k8s/api.js";
import {
  SESSION_MOVE_RECV_KIND,
  SESSION_MOVE_SECRET_KIND,
  SESSION_MOVE_SEND_KIND,
  SESSION_MOVE_TOKEN_KEY,
  WORKLOAD_PORT,
  buildSessionMoveReceiverPod,
  buildSessionMoveSenderPod,
  buildWorkloadPvc,
  buildWorkloadSecret,
  classifyPod,
  workloadName,
  type PodLike,
} from "./k8s/workload.js";

/**
 * Moves of a session's HOME volume between session nodes
 * (#clw_01M7Q3P5PR480HYED9TNH6VTV9), run by the controller only.
 *
 * An evacuation (`POST /api/nodes/:node/evacuation`) moves every session whose
 * HOME is on that node to the home node, the last `CLAWS_SESSION_NODES` entry:
 * running sessions first (each waits for its agent to go idle, up to the
 * evacuation's deadline, then is stopped, copied and resumed with
 * `--continue`), then ended ones (copied only). Moves happen only for an
 * evacuation: an ended session's HOME stays on the node it ran on, and a
 * resumed session runs where its storage is (#clw_01M7T8P6X0GTRKJXFDPX27H174;
 * most ended sessions are never resumed, so copying each one home was wasted
 * writes and held its busy lock against a resume). Legacy `settle` rows from
 * before that are retired by `start()`: unstarted or failed ones deleted, one
 * cut short mid-copy aborted, one already `resuming` finished.
 *
 * A copy is a pod pair (`move-home.ts`): a receiver on the home node with a
 * fresh PVC, a sender on the old node with the old PVC read-only. Only once
 * both exit 0 (the stream's hash matched) does the session switch to the new
 * claim and the old PVC go. A failed copy is retried once; a second failure
 * leaves the session on its old claim, relaunching it if it was running.
 *
 * Every move holds its session's busy lock from its first step, and its state
 * is in `session_moves`, so the web tier refuses resume/End/Delete while it is
 * past `waiting-idle` and a Claws restart picks the move up again: `stopping`
 * and `copying` restart the copy with a fresh PVC, `resuming` repeats itself.
 */

const NAME = "session-move";
export const SESSION_MOVE_TICK_MS = 5_000;
/** Moves past `waiting-idle` that run at once. */
export const MAX_CONCURRENT_MOVES = 2;
export const DEFAULT_IDLE_DEADLINE_SECONDS = 300;
export const MAX_IDLE_DEADLINE_SECONDS = 1800;
/** Copy attempts per move: the first and one retry. */
export const MAX_COPY_ATTEMPTS = 2;
/** How long a receiver may take to get an IP (image pull, volume bind). */
const RECEIVER_START_TIMEOUT_MS = 10 * 60_000;
/** Mover pods' `activeDeadlineSeconds`; the wait below allows a little more. */
const COPY_DEADLINE_SECONDS = 3600;
const MOVER_GONE_TIMEOUT_MS = 60_000;
const POLL_MS = 5_000;

/** The node a session with no recorded node keeps its storage on: the last `CLAWS_SESSION_NODES` entry. */
export function homeSessionNode(nodes: readonly string[]): string | null {
  return nodes.length > 0 ? nodes[nodes.length - 1] : null;
}

/** The node holding a session's HOME: its recorded node, else the home node (null without `CLAWS_SESSION_NODES`). */
export function effectiveSessionNode(row: Pick<PersistedSession, "node">, nodes: readonly string[]): string | null {
  return row.node ?? homeSessionNode(nodes);
}

/** The PVC a session's HOME is on. */
export function sessionHomeClaim(row: Pick<PersistedSession, "id" | "home_claim">): string {
  return row.home_claim ?? workloadName("session", row.id);
}

/**
 * The name of a fresh claim for a move of session `id`: `<name>-m<n>`, `n`
 * one above any already used by `claims`.
 */
export function nextMoveClaimName(id: string, claims: ReadonlyArray<string | null | undefined>): string {
  const base = workloadName("session", id);
  let n = 0;
  for (const c of claims) {
    const m = c?.startsWith(`${base}-m`) ? /^-m(\d+)$/.exec(c.slice(base.length)) : null;
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${base}-m${n + 1}`;
}

/** What the controller needs from the session backend. */
export interface SessionMoveHooks {
  /** Take the session's busy lock for a move; false when something else holds it. */
  tryLock(id: string): boolean;
  unlock(id: string): void;
  /** Stop a running session's pod and wait for it to go, deleting its Service and Secret; the row stays open. */
  stopForMove(id: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** Relaunch the session with `--continue` on the claim its row names. The caller holds the lock. */
  relaunch(id: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** End a session row whose storage is gone, so nothing relaunches it onto a missing claim. The caller holds the lock. */
  endWithoutStorage(id: string, reason: string): Promise<void>;
  /** Type `text` into the agent once its relaunched pod is ready. */
  notifyAgentOnceReady(id: string, text: string): void;
}

export interface SessionMoveControllerOptions {
  client: K8sClient;
  settings: Pick<SessionPodSettings, "namespace" | "image" | "imagePullSecrets" | "storageClassName" | "storageSize" | "nodes" | "tolerations">;
  hooks: SessionMoveHooks;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tickMs?: number;
  pollMs?: number;
  newId?: () => string;
  newToken?: () => string;
}

export interface SessionMoveController {
  /** Retire legacy settles, re-take interrupted moves' locks, start ticking. */
  start(): Promise<void>;
  stop(): void;
  /** Start ticking if there is anything to do (an evacuation another process recorded). */
  poke(): void;
  /** One pass; exposed for tests. */
  tick(): Promise<void>;
  /** Resolves once every move this controller started has finished; for tests. */
  idle(): Promise<void>;
}

function describe(err: K8sError): string {
  return err.message;
}

export function createSessionMoveController(opts: SessionMoveControllerOptions): SessionMoveController {
  const { client, settings, hooks } = opts;
  const ns = settings.namespace;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tickMs = opts.tickMs ?? SESSION_MOVE_TICK_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const newId = opts.newId ?? (() => crypto.randomBytes(8).toString("hex"));
  const newToken = opts.newToken ?? (() => crypto.randomBytes(32).toString("hex"));
  const home = homeSessionNode(settings.nodes);

  const inFlight = new Map<string, Promise<void>>();
  /** Sessions whose lock `start()` re-took for an interrupted move. */
  const preLocked = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  let stopped = false;

  const fields = (m: SessionMove, extra: Record<string, unknown> = {}) => ({
    component: NAME, move: m.id, session: m.session_id, kind: m.kind, from_node: m.from_node, to_node: m.to_node, ...extra,
  });

  function ensureTimer(): void {
    if (timer || stopped) return;
    timer = setInterval(() => { void tick().catch((err) => log.warn("session move tick failed", { component: NAME }, err)); }, tickMs);
    timer.unref();
  }

  function clearTimer(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function setState(m: SessionMove, state: SessionMoveState, extra: Partial<SessionMove> = {}): Promise<void> {
    await updateSessionMove(m.id, { state, ...extra });
    const from = m.state;
    Object.assign(m, { state, ...extra });
    if (from !== state) log.info("session move state changed", fields(m, { from_state: from, state }));
  }

  /** Give every session stored on an evacuated node a move. */
  async function planEvacuation(evac: NodeEvacuation): Promise<void> {
    if (!home || evac.node === home) return;
    const [open, ended] = await Promise.all([getAllPersistedSessions(), getEndedSessions()]);
    const moves = await listSessionMovesFromNode(evac.node, evac.requested_at);
    const covered = new Set(moves.map((m) => m.session_id));
    for (const row of [...open, ...ended]) {
      if (row.backend !== "k8s-pod" || covered.has(row.id)) continue;
      if (effectiveSessionNode(row, settings.nodes) !== evac.node) continue;
      const running = row.ended_at === null;
      const move: SessionMove = {
        id: newId(), session_id: row.id, kind: "evacuate", from_node: evac.node, to_node: home, reason: evac.reason,
        state: running ? "waiting-idle" : "queued", was_running: running ? 1 : 0, from_claim: sessionHomeClaim(row),
        new_claim: null, attempts: 0, bytes: null, requested_at: Math.max(now(), evac.requested_at), started_at: null, finished_at: null, error: null,
      };
      await insertSessionMove(move);
      log.info("session move queued", fields(move, { running }));
    }
  }

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const evacs = await listNodeEvacuations();
      for (const evac of evacs) await planEvacuation(evac);
      const active = await listActiveSessionMoves();
      if (evacs.length === 0 && active.length === 0 && inFlight.size === 0) {
        clearTimer();
        return;
      }
      ensureTimer();
      const evacByNode = new Map(evacs.map((e) => [e.node, e]));
      // Evacuate moves, plus any move a restart interrupted (it holds its session's lock and must finish
      // whatever its kind); interrupted ones first, then running sessions before ended ones, oldest first.
      const interrupted = (m: SessionMove) => (SESSION_MOVE_BLOCKING_STATES.includes(m.state) ? 1 : 0);
      const candidates = active
        .filter((m) => !inFlight.has(m.id) && (m.kind === "evacuate" || interrupted(m) === 1))
        .sort((a, b) => interrupted(b) - interrupted(a)
          || b.was_running - a.was_running
          || a.requested_at - b.requested_at);
      for (const m of candidates) {
        if (inFlight.size >= MAX_CONCURRENT_MOVES) break;
        if (m.state === "waiting-idle" && !await readyToStop(m, evacByNode.get(m.from_node))) continue;
        const run = runMove(m).catch((err) => log.warn("session move stopped", fields(m), err));
        inFlight.set(m.id, run.finally(() => inFlight.delete(m.id)));
      }
    } finally {
      ticking = false;
    }
  }

  /** Whether a running session's agent is idle, or the evacuation's idle deadline has passed. */
  async function readyToStop(m: SessionMove, evac: NodeEvacuation | undefined): Promise<boolean> {
    if (!evac) return false;
    const deadline = m.requested_at + Math.min(evac.idle_deadline_seconds, MAX_IDLE_DEADLINE_SECONDS) * 1000;
    if (now() >= deadline) return true;
    const row = await getPersistedSession(m.session_id);
    return !row || row.ended_at !== null || row.agent_status !== "working";
  }

  async function runMove(m: SessionMove): Promise<void> {
    const id = m.session_id;
    if (!preLocked.delete(id) && !hooks.tryLock(id)) return;
    try {
      const row = await getPersistedSession(id);
      if (!row || row.backend !== "k8s-pod") {
        await setState(m, "failed", { error: "session no longer exists", finished_at: now() });
        return;
      }
      if (m.state === "queued" || m.state === "waiting-idle") {
        if (effectiveSessionNode(row, settings.nodes) !== m.from_node || sessionHomeClaim(row) !== m.from_claim) {
          await deleteSessionMove(m.id);
          log.info("session move dropped", fields(m, { why: "session already moved" }));
          return;
        }
        const startedAt = now();
        const wasRunning = row.ended_at === null ? 1 : 0;
        // Compare-and-set: an evacuation cleared since the read may have dropped or reverted this move.
        if (!await claimSessionMove(m.id, startedAt, wasRunning)) {
          log.info("session move dropped", fields(m, { why: "changed before it started" }));
          return;
        }
        m.started_at = startedAt;
        m.was_running = wasRunning;
        // The web tier may have resumed or ended the session between the read and the claim.
        const claimed = await getPersistedSession(id);
        if (!claimed || claimed.backend !== "k8s-pod" || (claimed.ended_at === null) !== (row.ended_at === null)) {
          await deleteSessionMove(m.id);
          log.info("session move dropped", fields(m, { why: "session changed before it started" }));
          return;
        }
        log.info("session move started", fields(m, { running: m.was_running === 1 }));
      } else {
        log.info("session move resumed after a restart", fields(m, { state: m.state }));
        // The copy a restart cut short does not count against the move's retry.
        if (m.state === "copying" && m.attempts > 0) {
          m.attempts -= 1;
          await updateSessionMove(m.id, { attempts: m.attempts });
        }
      }
      const running = row.ended_at === null;

      if (m.state !== "resuming") {
        if (running) {
          await setState(m, "stopping");
          const stoppedPod = await hooks.stopForMove(id);
          if (!stoppedPod.ok) {
            await failMove(m, `stopping the session failed: ${stoppedPod.detail}`, true);
            return;
          }
        }
        await setState(m, "copying");
        const copied = await copyWithRetry(m);
        if (!copied.ok) {
          if (copied.missing) {
            // Nothing is stored on the node: the session's storage is gone (e.g. a failed launch's rollback).
            // Nothing moved, so the move failed; the node no longer holds anything of the session's.
            await setSessionNode(id, m.to_node);
            await deleteMovers(id, false);
            await setState(m, "failed", { finished_at: now(), error: "its storage no longer exists" });
            log.warn("session move failed", fields(m, { duration_ms: now() - (m.started_at ?? now()), error: "no storage to move" }));
            // A relaunch would wait forever on the missing claim: end the row instead.
            if (running) await hooks.endWithoutStorage(id, "its storage no longer exists");
            return;
          }
          await failMove(m, copied.detail, running);
          return;
        }
        await setState(m, "resuming", { bytes: copied.bytes });
      }

      const newClaim = m.new_claim!;
      await setSessionHomeClaim(id, newClaim, m.to_node);
      let relaunched = true;
      if (running) relaunched = await relaunchOrWarn(m);
      const oldDel = await client.delete("persistentvolumeclaims", ns, m.from_claim);
      if (!oldDel.ok && oldDel.kind !== "not-found") {
        log.warn("session move could not delete old storage", fields(m, { claim: m.from_claim, error: describe(oldDel) }));
      }
      await deleteMovers(id, false);
      await setState(m, "done", { finished_at: now(), ...(relaunched ? {} : { error: "the session could not be restarted; resume it from the sessions list" }) });
      log.info("session move finished", fields(m, { duration_ms: now() - (m.started_at ?? now()), bytes: m.bytes ?? 0, outcome: "moved" }));
      if (running && relaunched) {
        hooks.notifyAgentOnceReady(id, `[Claws] This session was moved from node ${m.from_node} to ${m.to_node} (${m.reason}) and restarted with its conversation and home directory kept. Any process you had running was stopped; restart it if you still need it.`);
      }
    } finally {
      hooks.unlock(id);
    }
  }

  async function relaunchOrWarn(m: SessionMove): Promise<boolean> {
    const res = await hooks.relaunch(m.session_id);
    if (res.ok) return true;
    log.warn("session move restarting session after failure", fields(m, { error: res.detail }));
    return false;
  }

  /** A move that cannot finish: clean up its copy, record why, and put a running session back on its old claim. */
  async function failMove(m: SessionMove, detail: string, running: boolean): Promise<void> {
    await deleteMovers(m.session_id, false);
    if (m.new_claim) {
      const del = await client.delete("persistentvolumeclaims", ns, m.new_claim);
      if (!del.ok && del.kind !== "not-found") log.warn("session move could not delete new claim", fields(m, { claim: m.new_claim, error: describe(del) }));
    }
    await setState(m, "failed", { finished_at: now(), error: detail });
    log.warn("session move failed", fields(m, { duration_ms: now() - (m.started_at ?? now()), error: detail }));
    if (running) await relaunchOrWarn(m);
  }

  type CopyResult = { ok: true; bytes: number } | { ok: false; detail: string; missing?: boolean };

  async function copyWithRetry(m: SessionMove): Promise<CopyResult> {
    for (;;) {
      if (m.attempts >= MAX_COPY_ATTEMPTS) return { ok: false, detail: `no copy attempts left (${m.attempts} used)` };
      const attempt = m.attempts + 1;
      const res = await copyOnce(m, attempt);
      if (res.ok || res.missing) return res;
      await deleteMovers(m.session_id, false);
      if (m.new_claim) {
        const del = await client.delete("persistentvolumeclaims", ns, m.new_claim);
        if (!del.ok && del.kind !== "not-found") log.warn("session move could not delete new claim", fields(m, { claim: m.new_claim, error: describe(del) }));
      }
      if (attempt >= MAX_COPY_ATTEMPTS) return res;
      log.warn("session move copy failed, retrying", fields(m, { attempt, error: res.detail }));
    }
  }

  /** Delete both mover pods and the move's Secret; with `wait`, until the pods are gone. */
  async function deleteMovers(id: string, wait: boolean): Promise<boolean> {
    const pods = [workloadName(SESSION_MOVE_SEND_KIND, id), workloadName(SESSION_MOVE_RECV_KIND, id)];
    for (const pod of pods) {
      const res = await client.delete("pods", ns, pod);
      if (!res.ok && res.kind !== "not-found") log.warn("session move could not delete mover pod", { component: NAME, session: id, pod, error: describe(res) });
    }
    const secret = await client.delete("secrets", ns, workloadName(SESSION_MOVE_SECRET_KIND, id));
    if (!secret.ok && secret.kind !== "not-found") log.warn("session move could not delete move secret", { component: NAME, session: id, error: describe(secret) });
    if (!wait) return true;
    for (let polls = Math.ceil(MOVER_GONE_TIMEOUT_MS / pollMs); ; polls--) {
      let present = false;
      for (const pod of pods) {
        const got = await client.get("pods", ns, pod);
        if (got.ok || got.kind !== "not-found") present = true;
      }
      if (!present) return true;
      if (polls <= 0) return false;
      await sleep(pollMs);
    }
  }

  async function copyOnce(m: SessionMove, attempt: number): Promise<CopyResult> {
    const id = m.session_id;
    if (!settings.image) return { ok: false, detail: "CLAWS_SESSION_IMAGE is empty" };
    if (!await deleteMovers(id, true)) return { ok: false, detail: "an earlier mover pod is still terminating" };
    if (m.new_claim) {
      const del = await client.delete("persistentvolumeclaims", ns, m.new_claim);
      if (!del.ok && del.kind !== "not-found") return { ok: false, detail: `deleting the previous copy: ${describe(del)}` };
    }
    const source = await client.get<K8sObject & { spec?: { resources?: { requests?: { storage?: string } } } }>("persistentvolumeclaims", ns, m.from_claim);
    if (!source.ok) {
      return source.kind === "not-found" ? { ok: false, detail: "storage not found", missing: true } : { ok: false, detail: `reading the session's storage: ${describe(source)}` };
    }
    const claim = nextMoveClaimName(id, [m.from_claim, m.new_claim]);
    await updateSessionMove(m.id, { new_claim: claim, attempts: attempt });
    m.new_claim = claim;
    m.attempts = attempt;

    const size = source.value.spec?.resources?.requests?.storage || settings.storageSize;
    const pvc = await client.create("persistentvolumeclaims", ns, buildWorkloadPvc({ kind: "session", id, namespace: ns, storageClassName: settings.storageClassName, size, name: claim }));
    if (!pvc.ok) return { ok: false, detail: `creating ${claim}: ${describe(pvc)}` };
    const secret = await client.create("secrets", ns, buildWorkloadSecret({ kind: SESSION_MOVE_SECRET_KIND, id, namespace: ns, data: { [SESSION_MOVE_TOKEN_KEY]: newToken() } }));
    if (!secret.ok) return { ok: false, detail: `creating the move Secret: ${describe(secret)}` };
    const common = { id, namespace: ns, image: settings.image, imagePullSecrets: settings.imagePullSecrets, tolerations: settings.tolerations, activeDeadlineSeconds: COPY_DEADLINE_SECONDS };
    const recvName = workloadName(SESSION_MOVE_RECV_KIND, id);
    const sendName = workloadName(SESSION_MOVE_SEND_KIND, id);
    const recv = await client.create("pods", ns, buildSessionMoveReceiverPod({ ...common, homeClaimName: claim, node: m.to_node }));
    if (!recv.ok) return { ok: false, detail: `creating the receiver: ${describe(recv)}` };

    let ip: string | undefined;
    for (let polls = Math.ceil(RECEIVER_START_TIMEOUT_MS / pollMs); ; polls--) {
      const got = await client.get<PodLike & K8sObject & { status?: { podIP?: string } }>("pods", ns, recvName);
      if (!got.ok) return { ok: false, detail: `reading the receiver: ${describe(got)}` };
      const phase = got.value.status?.phase;
      if (phase === "Failed" || phase === "Succeeded") return { ok: false, detail: `receiver ${phase.toLowerCase()} before the copy: ${classifyPod(got.value).detail ?? "no detail"}` };
      ip = got.value.status?.podIP;
      if (phase === "Running" && ip) break;
      if (polls <= 0) return { ok: false, detail: `receiver not running after ${Math.round(RECEIVER_START_TIMEOUT_MS / 60_000)} minutes` };
      await sleep(pollMs);
    }
    const receiverUrl = `http://${ip!.includes(":") ? `[${ip}]` : ip}:${WORKLOAD_PORT}`;
    const send = await client.create("pods", ns, buildSessionMoveSenderPod({ ...common, homeClaimName: m.from_claim, receiverUrl }));
    if (!send.ok) return { ok: false, detail: `creating the sender: ${describe(send)}` };

    const done = new Set<string>();
    for (let polls = Math.ceil(((COPY_DEADLINE_SECONDS + 120) * 1000) / pollMs); ; polls--) {
      for (const pod of [sendName, recvName]) {
        if (done.has(pod)) continue;
        const got = await client.get<PodLike & K8sObject>("pods", ns, pod);
        if (!got.ok) return { ok: false, detail: `reading ${pod}: ${describe(got)}` };
        const phase = got.value.status?.phase;
        if (phase === "Failed") return { ok: false, detail: `${pod === sendName ? "sender" : "receiver"} failed: ${classifyPod(got.value).detail ?? "no detail"}` };
        if (phase === "Succeeded") done.add(pod);
      }
      if (done.size === 2) break;
      if (polls <= 0) return { ok: false, detail: "copy did not finish in time" };
      await sleep(pollMs);
    }
    return { ok: true, bytes: await copiedBytes(sendName) };
  }

  /** The byte count the sender reported, or 0 when its log cannot be read. */
  async function copiedBytes(podName: string): Promise<number> {
    try {
      const res = await client.podLog(ns, podName, { container: SESSION_MOVE_SEND_KIND, limitBytes: 4096 });
      if (!res.ok) return 0;
      const line = res.value.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
      const bytes = (JSON.parse(line) as { bytes?: unknown }).bytes;
      return typeof bytes === "number" ? bytes : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Retire legacy settle moves (#clw_01M7T8P6X0GTRKJXFDPX27H174): delete queued and failed ones, abort one a
   * restart cut short before its copy finished (its movers and half-written claim go; the session stays on its
   * old claim), and leave one already `resuming` to finish, since its copy is verified.
   */
  async function retireSettles(): Promise<void> {
    const deleted = await deleteRetiredSettleMoves();
    let aborted = 0;
    for (const m of await listActiveSessionMoves()) {
      if (m.kind !== "settle" || m.state === "resuming") continue;
      try {
        await deleteMovers(m.session_id, false);
        if (m.new_claim) {
          const del = await client.delete("persistentvolumeclaims", ns, m.new_claim);
          if (!del.ok && del.kind !== "not-found") {
            log.warn("session move could not delete new claim", fields(m, { claim: m.new_claim, error: describe(del) }));
            continue;
          }
        }
        await deleteSessionMove(m.id);
        aborted++;
      } catch (err) {
        log.warn("session move could not abort settle", fields(m), err);
      }
    }
    if (deleted + aborted > 0) log.info("session settles retired", { component: NAME, deleted, aborted });
  }

  return {
    async start() {
      stopped = false;
      if (!home) return;
      await retireSettles();
      for (const m of await listActiveSessionMoves()) {
        if (SESSION_MOVE_BLOCKING_STATES.includes(m.state) && hooks.tryLock(m.session_id)) preLocked.add(m.session_id);
      }
      ensureTimer();
      // Launches the interrupted moves (without waiting for them), so their pre-taken locks are in use.
      await tick().catch((err) => log.warn("session move tick failed", { component: NAME }, err));
    },
    stop() {
      stopped = true;
      clearTimer();
    },
    poke() {
      if (!home || stopped || timer) return;
      void tick().catch((err) => log.warn("session move tick failed", { component: NAME }, err));
    },
    tick,
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
    },
  };
}

// ── Evacuation requests (both tiers; database only) ──

export interface EvacuationGroupCounts {
  pending: number;
  moving: number;
  moved: number;
  failed: number;
}

export interface EvacuationStatus {
  node: string;
  active: boolean;
  /** Nothing is pending or moving: every session has moved or its move failed. */
  done: boolean;
  /** `done` with no failed move: nothing of the node's sessions is left on it. */
  complete: boolean;
  running: EvacuationGroupCounts;
  ended: EvacuationGroupCounts;
}

const emptyCounts = (): EvacuationGroupCounts => ({ pending: 0, moving: 0, moved: 0, failed: 0 });

function countFor(state: SessionMoveState): keyof EvacuationGroupCounts {
  if (state === "done") return "moved";
  if (state === "failed") return "failed";
  return SESSION_MOVE_BLOCKING_STATES.includes(state) ? "moving" : "pending";
}

/**
 * Where an evacuation of `node` stands: moves off it since it was requested
 * (and any still active), plus sessions still stored there that have none yet
 * (pending until the controller plans them). `done` once nothing is pending or
 * moving, failed moves included (they will not be retried, so waiting longer
 * gains nothing); `complete` once, besides, none failed. With no evacuation
 * stored, `active` is false and only the sessions still there count, as
 * pending.
 */
export async function evacuationStatus(node: string, nodes: readonly string[]): Promise<EvacuationStatus> {
  const evac = await getNodeEvacuation(node);
  const running = emptyCounts();
  const ended = emptyCounts();
  const moves = evac ? await listSessionMovesFromNode(node, evac.requested_at) : [];
  const covered = new Set<string>();
  for (const m of moves) {
    covered.add(m.session_id);
    (m.was_running ? running : ended)[countFor(m.state)]++;
  }
  if (node !== homeSessionNode(nodes)) {
    const [open, endedRows] = await Promise.all([getAllPersistedSessions(), getEndedSessions()]);
    for (const row of [...open, ...endedRows]) {
      if (row.backend !== "k8s-pod" || covered.has(row.id) || effectiveSessionNode(row, nodes) !== node) continue;
      (row.ended_at === null ? running : ended).pending++;
    }
  }
  const done = running.pending + running.moving + ended.pending + ended.moving === 0;
  const complete = done && running.failed + ended.failed === 0;
  return { node, active: !!evac, done, complete, running, ended };
}

/** Record (idempotently) that `node` is to be evacuated. */
export async function startEvacuation(node: string, reason: string, idleDeadlineSeconds: number, at: number): Promise<NodeEvacuation> {
  const deadline = Math.max(0, Math.min(MAX_IDLE_DEADLINE_SECONDS, Math.round(idleDeadlineSeconds)));
  const evac = await requestNodeEvacuation({ node, reason, requested_at: at, idle_deadline_seconds: deadline });
  if (evac.requested_at === at) log.info("node evacuation requested", { component: NAME, node, reason, idle_deadline_seconds: deadline });
  return evac;
}

/**
 * Clear `node`'s evacuation: new sessions may run there again, and moves not
 * yet under way are dropped. Moves already past `waiting-idle` finish.
 */
export async function endEvacuation(node: string): Promise<boolean> {
  const cleared = await clearNodeEvacuation(node);
  let dropped = 0;
  for (const m of await listActiveSessionMoves()) {
    if (m.from_node !== node || m.kind !== "evacuate" || (m.state !== "queued" && m.state !== "waiting-idle") || m.started_at !== null) continue;
    // Conditional on the move still being unstarted: the controller may claim it meanwhile, and then it finishes.
    if (await deleteUnstartedSessionMove(m.id)) dropped++;
  }
  if (cleared) log.info("node evacuation cleared", { component: NAME, node, dropped_moves: dropped });
  return cleared;
}

/** The session page's view of a session's latest move. */
export interface SessionMoveNotice {
  id: string;
  state: SessionMoveState;
  fromNode: string;
  toNode: string;
  finishedAt: number | null;
  /** What the page shows, e.g. "Moved from k3s-nas to k3s: NAS shutdown". */
  message: string;
  failed: boolean;
}

/** The session's latest move as the page's notice, or null when it never moved. */
export async function sessionMoveNotice(sessionId: string): Promise<SessionMoveNotice | null> {
  const m = await getLatestSessionMove(sessionId);
  if (!m) return null;
  const route = `from ${m.from_node} to ${m.to_node}`;
  const message = m.state === "done"
    ? `Moved ${route}: ${m.reason}`
    : m.state === "failed"
      ? `Could not move ${route}: ${m.error ?? "unknown error"}`
      : `Moving ${route}: ${m.reason}`;
  return { id: m.id, state: m.state, fromNode: m.from_node, toNode: m.to_node, finishedAt: m.finished_at, message, failed: m.state === "failed" };
}
