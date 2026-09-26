import crypto from "node:crypto";
import http from "node:http";
import { Readable, pipeline } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { WebSocket } from "ws";
import * as log from "./log.js";
import { SESSION_POD_SETTINGS, isForgejoRepo, type Repo, type SessionPodSettings } from "./config.js";
import { isShuttingDown } from "./shutdown.js";
import { listRepos } from "./github.js";
import { getAnyInstallationToken, getInstallationTokenForOwner } from "./github-app.js";
import {
  BROWSER_CAPABILITY_ID,
  CAPABILITIES,
  GITHUB_AUTH_CAPABILITY_ID,
  liveGrantableCapabilities,
  withImplicitCapabilities,
} from "./capabilities.js";
import {
  isIdlePlaceholder,
  isNumberOnlySummary,
  isSessionAgentStatus,
  setSessionAgentStatusForSession,
  setSessionDescription,
  summarizeSession,
  type SessionMode,
  type SessionProvider,
} from "./sessions.js";
import {
  clearSessionEnded,
  deleteEndedPersistedSession,
  deletePersistedSession,
  getAllPersistedSessions,
  getEndedSessions,
  getPersistedSession,
  getPrunableEndedSessionIds,
  insertSession,
  markSessionEnded,
  recordSessionExit,
  setManualSessionSummary,
  updateSessionStartup,
  updateSessionCapabilities,
  updateSessionUsage,
  type PersistedSession,
} from "./db.js";
import { createK8sClient, type K8sClient, type K8sError, type K8sObject, type K8sResource } from "./k8s/api.js";
import {
  GITHUB_TOKEN_KEY,
  SSH_KEY_SECRET_KEYS,
  GRANTED_ENV_KEY,
  LABEL_WORKLOAD_ID,
  MCP_TOKEN_KEY,
  TERMINAL_TOKEN_KEY,
  WORKLOAD_LAUNCH_GRACE_MS,
  WORKLOAD_PORT,
  WORKLOAD_SECRET_DIR,
  buildSecretKeyPatch,
  buildSecretKeysPatch,
  buildWorkloadPod,
  buildWorkloadPvc,
  buildWorkloadSecret,
  buildWorkloadService,
  classifyPod,
  classifyPodStartup,
  grantedKubeconfigKey,
  planWorkloadReconcile,
  workloadName,
  workloadSelector,
  type PodClassification,
  type PodLike,
  type PodStartupClassification,
} from "./k8s/workload.js";
import {
  buildGrantedSecretData,
  buildPodLaunch,
  defaultPodLaunchDeps,
  type PodLaunch,
  type PodLaunchRequest,
} from "./session-pod-launch.js";
import { grantedEnvMarker } from "./session-env-file.js";
import { WsMessageSchema } from "./terminal-protocol.js";
import { UPLOAD_REQUEST_TIMEOUT_MS, type SaveUploadResult } from "./session-uploads-core.js";
import type { SessionUsageSnapshot } from "./session-usage.js";
import type {
  GrantCapabilityResult,
  GrantDeliveryResult,
  LiveSessionListEntry,
  SessionBackend,
  SessionLookupFailure,
  SessionOpResult,
  SessionStartupStatus,
  SessionStartResult,
  SessionUploadResult,
} from "./session-backend.js";

/**
 * `k8s-pod` session backend (#3026): one Pod per interactive session, created
 * through the Kubernetes API in `CLAWS_SESSION_NAMESPACE`. Claws only proxies
 * to the pod's terminal server, so a Claws rollout never touches a session,
 * and the Kubernetes API is the single source of truth for whether one is
 * alive.
 *
 * Only a successful Kubernetes answer may end a row or delete anything: a
 * terminal pod phase, or no pod past the launch grace. API errors, timeouts
 * and 403s leave the DB and the cluster untouched and surface as
 * `unavailable` / `backend-unavailable` (HTTP 503).
 *
 * Rows whose `backend` is NULL or `local-tmux` belong to the host tmux backend
 * and are never listed as live, revived or reconciled here. PVCs are deleted
 * only by `remove()`, by history pruning, and by the rollback (or its queued
 * retry) of a create whose session never started.
 */

export const SESSION_WORKLOAD_KIND = "session";
const MAX_ENDED_SESSIONS = 50;
const POD_GONE_TIMEOUT_MS = 30_000;
const POLL_MS = 1_000;
const RECONCILE_INTERVAL_MS = 15_000;
const SUMMARY_INTERVAL_MS = 30_000;
const USAGE_INTERVAL_MS = 60_000;
const POD_HTTP_TIMEOUT_MS = 10_000;
const PTY_HANDSHAKE_TIMEOUT_MS = 10_000;
const SCROLLBACK_LIMIT = 50_000;
/** Bytes of a pod's `GET /scrollback` answer kept: the tail, enough for `SCROLLBACK_LIMIT` characters. */
const SCROLLBACK_MAX_BYTES = SCROLLBACK_LIMIT * 4;
/** A pod's `POST /uploads` reply is a small JSON result; anything larger is refused. */
const UPLOAD_REPLY_MAX_BYTES = 16_000;
/** A pod's `GET /usage` reply is a tiny JSON snapshot. */
const USAGE_REPLY_MAX_BYTES = 4096;
/** Largest `/pty` frame accepted from a pod: its opening scrollback frame is up to 10,000 lines. */
const PTY_MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_PENDING_FRAMES = 1_000;
/**
 * How long a create whose answer was lost may still be written: past the API
 * server's own request timeout (60s by default). Until then a 404 from its
 * rollback delete does not prove the object will never exist.
 */
const LATE_WRITE_MS = 120_000;
export const POD_UNREACHABLE_MESSAGE = "[Session pod unreachable — retrying]";
/** End/Delete during a create or resume would race the objects it is creating. */
const STILL_STARTING = { ok: false, reason: "unavailable", detail: "session is still starting — try again shortly" } as const;

/** What holds a session id's exclusive lock (see `busy`). */
type BusyOp = "launching" | "ending" | "removing" | "pruning" | "reconciling" | "granting";

const BUSY_DETAIL: Record<Exclude<BusyOp, "launching">, string> = {
  ending: "session is being ended — try again shortly",
  removing: "session is being deleted — try again shortly",
  pruning: "session storage is being deleted — try again shortly",
  reconciling: "session is being reconciled — try again shortly",
  granting: "a capability is being granted to this session — try again shortly",
};

function busyResult(op: BusyOp): SessionLookupFailure {
  return op === "launching" ? STILL_STARTING : { ok: false, reason: "unavailable", detail: BUSY_DETAIL[op] };
}

export interface K8sSessionBackendOptions {
  client: K8sClient;
  settings: SessionPodSettings;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  buildLaunch?: (req: PodLaunchRequest) => Promise<PodLaunch>;
  /** The granted-capability Secret slots for a capability set (see `buildGrantedSecretData`). */
  buildGrantedData?: (caps: string[]) => Record<string, string>;
  /** A GitHub installation token for a session with these repos (first GitHub-hosted owner, else any). */
  getGithubToken?: (repos: string[]) => Promise<string>;
  /** Base URL of a session pod's terminal server, e.g. `http://claws-session-<id>.<ns>.svc:7681`. */
  podBaseUrl?: (id: string) => string;
  podGoneTimeoutMs?: number;
  pollMs?: number;
  reconcileIntervalMs?: number;
  summaryIntervalMs?: number;
  usageIntervalMs?: number;
}

/** In-memory state for one open pod-backed row. */
interface PodSessionEntry {
  id: string;
  row: PersistedSession;
  classification: PodClassification | null;
  /** Startup view of the pod from the last reconcile pass; what the list column renders. */
  startup: PodStartupClassification | null;
  scrollback: string;
  lastActivity: number;
  alive: boolean;
  summary: string | null;
  summaryUpdatedAt: number | null;
  summaryManual: boolean;
  wsCount: number;
  terminalToken: string | null;
  /** Bearer token of the session's `claws-state` MCP endpoint; null means not yet read from the Secret. */
  mcpToken: string | null;
  /** The token last written to the Secret; null means unknown (e.g. after a Claws restart). */
  githubToken: string | null;
}

/** Outcome of the last reconcile pass; attach and uploads 503 with the matching detail unless `ok`. */
type ReconcileState = "unknown" | "ok" | "k8s-failed" | "db-failed";

const RECONCILE_STATE_DETAIL: Record<Exclude<ReconcileState, "ok">, string> = {
  unknown: "Kubernetes API not yet reached",
  "k8s-failed": "Kubernetes API unreachable",
  "db-failed": "session database unreachable",
};

async function defaultGithubToken(repos: string[]): Promise<string> {
  const githubRepo = repos.find((r) => !isForgejoRepo(r));
  return githubRepo ? getInstallationTokenForOwner(githubRepo.split("/")[0]) : getAnyInstallationToken();
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rowCapabilities(row: PersistedSession): string[] {
  return parseJsonArray(row.capabilities).filter((x): x is string => typeof x === "string");
}

/** Every repo of a row, primary first. */
function rowRepos(row: PersistedSession): string[] {
  const extra = parseJsonArray(row.extra_worktrees)
    .map((w) => (w && typeof w === "object" ? (w as { repo?: unknown }).repo : undefined))
    .filter((r): r is string => typeof r === "string");
  return row.repo ? [row.repo, ...extra] : extra;
}

function resumeReposJson(row: PersistedSession): string {
  const repos = row.mode === "worktree-claude" || row.mode === "multi-worktree-claude" ? rowRepos(row) : [];
  return JSON.stringify(repos);
}

const VERB_FOR_METHOD: Record<string, string> = { POST: "create", GET: "get", DELETE: "delete", PATCH: "patch" };

/** GitHub owners of a repo set; installation tokens are per owner, so a pod can use only one. */
function githubOwners(repos: string[]): string[] {
  return [...new Set(repos.filter((r) => !isForgejoRepo(r)).map((r) => r.split("/")[0]))];
}

export function createK8sSessionBackend(opts: K8sSessionBackendOptions): SessionBackend & { reconcile(): Promise<void> } {
  const { client, settings } = opts;
  const ns = settings.namespace;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const buildLaunch = opts.buildLaunch ?? ((req: PodLaunchRequest) => buildPodLaunch(req));
  const buildGrantedData = opts.buildGrantedData ?? ((caps: string[]) => buildGrantedSecretData(caps, defaultPodLaunchDeps.readFile));
  const getGithubToken = opts.getGithubToken ?? defaultGithubToken;
  const podBaseUrl = opts.podBaseUrl ?? ((id: string) => `http://${workloadName(SESSION_WORKLOAD_KIND, id)}.${ns}.svc:${WORKLOAD_PORT}`);
  const podGoneTimeoutMs = opts.podGoneTimeoutMs ?? POD_GONE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? POLL_MS;

  const entries = new Map<string, PodSessionEntry>();
  /**
   * Per-id exclusive lock. create/resume/end/remove/prune take it synchronously,
   * before their first await on the id, and release it in `finally`; reconcile
   * takes it around each per-id mutation. A caller that finds it held returns a
   * 503 (or skips the id), so no two operations ever interleave on one session.
   */
  const busy = new Map<string, BusyOp>();
  const reportedOrphans = new Set<string>();
  /**
   * Objects of an ended or failed session whose delete did not return ok/404,
   * retried every successful reconcile pass until it does, so a transient API
   * error never strands a Secret holding session credentials. Each maps to the
   * time before which a 404 is not trusted (see `LATE_WRITE_MS`); 0 trusts it.
   */
  const pendingCleanup = new Map<string, Map<K8sResource, number>>();
  /** Ids whose failed create kept the row as ended only for a queued rollback; the row goes once the queue drains (retried until its delete succeeds). */
  const failedLaunches = new Set<string>();
  /** Whether a reconcile pass has queued every ended row's Service/Secret (covers deletes that failed before a restart). */
  let cleanupSeeded = false;
  const clientSockets = new Map<WebSocket, string>();
  const upstreamSockets = new Set<WebSocket>();
  let reconcileState: ReconcileState = "unknown";
  let reconcileTimer: NodeJS.Timeout | null = null;
  let summaryTimer: NodeJS.Timeout | null = null;
  let usageTimer: NodeJS.Timeout | null = null;
  let reconciling = false;
  let summarizing = false;
  let samplingUsage = false;

  const name = (id: string) => workloadName(SESSION_WORKLOAD_KIND, id);
  const ref = (id: string) => ({ kind: SESSION_WORKLOAD_KIND, id, namespace: ns });

  function elapsed(startedAt: number | null, at = now()): number {
    return startedAt === null ? 0 : Math.max(0, at - startedAt);
  }

  async function recordStartup(
    id: string,
    state: SessionStartupStatus["state"],
    step: string,
    detail: string | null = null,
    extra: { startedAt?: number | null; readyAt?: number | null; failedAt?: number | null; failure?: string | null; clearFailure?: boolean; expectUpdatedAt?: number | null } = {},
  ): Promise<boolean> {
    const at = now();
    return await updateSessionStartup(id, {
      state,
      step,
      detail,
      updatedAt: at,
      ...(extra.startedAt !== undefined ? { startedAt: extra.startedAt } : {}),
      ...(extra.readyAt !== undefined ? { readyAt: extra.readyAt } : {}),
      ...(extra.failedAt !== undefined ? { failedAt: extra.failedAt } : {}),
      ...(extra.failure !== undefined ? { failure: extra.failure } : {}),
      ...(extra.clearFailure ? { clearFailure: true } : {}),
      ...(extra.expectUpdatedAt !== undefined ? { expectUpdatedAt: extra.expectUpdatedAt } : {}),
    });
  }

  /**
   * Record a startup classification derived from a plain status read, which — unlike every
   * other writer of the `startup_*` columns — holds no lock on the id. That writer (reconcile
   * ending the pod, `end`, `resume`) knows why the session is in the state it is, and a blind
   * `UPDATE` landing after it would wipe the failure detail the user is meant to see.
   *
   * The `busy` check alone cannot prevent that: it runs before the DB round-trip starts, and a
   * lock can be taken and released entirely inside that await window. So the real guard is
   * `expectUpdatedAt` — the `startup_updated_at` the caller read before deriving this status —
   * which makes a write that raced past a newer one a no-op in the database. A poller retries a
   * second later anyway, so a skipped or failed write costs nothing but one stale interval.
   *
   * Returns whether the row was actually updated.
   */
  async function recordDerivedStartup(
    id: string,
    state: SessionStartupStatus["state"],
    step: string,
    detail: string | null,
    extra: Parameters<typeof recordStartup>[4] = {},
  ): Promise<boolean> {
    if (busy.has(id)) return false;
    try {
      return await recordStartup(id, state, step, detail, extra);
    } catch (err) {
      log.warn(`[sessions-k8s] Failed to persist derived startup status for session ${id}: ${err}`);
      return false;
    }
  }

  /**
   * Record startup progress where a DB hiccup must not change what happens next — inside
   * `createObjects`, whose loop owes its caller either every object or none of them. An
   * unguarded throw there escapes past the rollback that deletes what the attempt already
   * created, so these observability writes log and carry on instead.
   */
  async function recordStartupBestEffort(...args: Parameters<typeof recordStartup>): Promise<void> {
    try {
      await recordStartup(...args);
    } catch (err) {
      log.warn(`[sessions-k8s] Failed to persist startup status for session ${args[0]}: ${err}`);
    }
  }

  /** Log-safe detail for a failed call; a 403 names the RBAC grant that is missing (`verb` overrides the method's). */
  function describeError(err: K8sError, resource: K8sResource, verb = VERB_FOR_METHOD[err.message.split(" ")[0]] ?? "access"): string {
    if (err.kind !== "forbidden") return err.message;
    return `${err.message} — the Claws ServiceAccount needs RBAC "${verb}" on ${resource} in namespace ${ns} (see docs/k8s-cutover.md)`;
  }

  const okOrGone = (res: { ok: boolean; kind?: string }) => res.ok || res.kind === "not-found";

  function ensureEntry(row: PersistedSession): PodSessionEntry {
    let entry = entries.get(row.id);
    if (!entry) {
      entry = {
        id: row.id,
        row,
        classification: null,
        startup: null,
        scrollback: "",
        lastActivity: now(),
        alive: true,
        summary: row.summary,
        summaryUpdatedAt: row.summary_updated_at,
        summaryManual: row.summary_manual === 1,
        wsCount: 0,
        terminalToken: null,
        mcpToken: null,
        githubToken: null,
      };
      entries.set(row.id, entry);
    } else {
      entry.row = row;
    }
    return entry;
  }

  /** Forget a session; with `exitCode`, tell its open terminals it exited so they stop reconnecting. */
  function dropEntry(id: string, exitCode?: number): void {
    const entry = entries.get(id);
    if (entry) entry.mcpToken = null;
    entries.delete(id);
    if (exitCode === undefined) return;
    for (const [ws, sid] of clientSockets) {
      if (sid !== id || ws.readyState !== WebSocket.OPEN) continue;
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      ws.close(1000, "Session ended");
    }
  }

  async function deleteQuietly(resource: K8sResource, id: string): Promise<boolean> {
    const res = await client.delete(resource, ns, name(id));
    if (!okOrGone(res)) {
      log.warn(`[sessions-k8s] Failed to delete ${resource} ${name(id)}: ${(res as K8sError).message}`);
      return false;
    }
    return true;
  }

  /**
   * Delete `resources` of a session, queueing any delete that fails for the next
   * reconcile pass. A 404 for a resource whose create may still be written stays
   * queued until that window has passed; an ok means the write landed and is gone.
   */
  async function deleteOrRetryLater(id: string, resources: readonly K8sResource[]): Promise<void> {
    const pending = pendingCleanup.get(id) ?? new Map<K8sResource, number>();
    for (const resource of resources) {
      const notGoneBefore = pending.get(resource) ?? 0;
      const res = await client.delete(resource, ns, name(id));
      if (res.ok || (res.kind === "not-found" && now() >= notGoneBefore)) {
        pending.delete(resource);
        continue;
      }
      if (res.kind !== "not-found") log.warn(`[sessions-k8s] Failed to delete ${resource} ${name(id)}: ${res.message}`);
      pending.set(resource, notGoneBefore);
    }
    if (pending.size > 0) pendingCleanup.set(id, pending);
    else pendingCleanup.delete(id);
  }

  /**
   * Until when a lost create of this ended session may still write an object, or
   * 0 if none can. Delete and pruning keep the row until then: `pendingCleanup` is
   * only in memory, and after a restart the row is what re-queues the delete.
   */
  function lateWriteDeadline(row: PersistedSession): number {
    const deadlines = [...(pendingCleanup.get(row.id)?.values() ?? [])];
    // Until reconcile has seeded ended rows, one ended just before a restart may be such a create.
    if (!cleanupSeeded && row.ended_at !== null) deadlines.push(row.ended_at + LATE_WRITE_MS);
    return Math.max(0, ...deadlines.filter((t) => t > now()));
  }

  /** Create Secret → (PVC) → Service → Pod; on failure delete what this attempt created. */
  async function createObjects(id: string, launch: PodLaunch, createPvc: boolean): Promise<{ ok: true } | { ok: false; detail: string }> {
    const steps: Array<[K8sResource, K8sObject, string]> = [
      ["secrets", buildWorkloadSecret({ ...ref(id), data: launch.secretData }), "Creating session credentials"],
    ];
    if (createPvc) {
      steps.push(["persistentvolumeclaims", buildWorkloadPvc({ ...ref(id), storageClassName: settings.storageClassName, size: settings.storageSize }), "Creating session storage"]);
    }
    steps.push(["services", buildWorkloadService(ref(id)), "Creating terminal service"]);
    steps.push(["pods", buildWorkloadPod({
      ...ref(id),
      image: settings.image,
      secretKeys: Object.keys(launch.secretData),
      imagePullSecrets: settings.imagePullSecrets,
      nodeSelector: settings.nodeSelector,
      priorityClassName: settings.priorityClassName || undefined,
      resources: { cpuRequest: settings.cpuRequest, memoryRequest: settings.memoryRequest, memoryLimit: settings.memoryLimit },
    }), "Creating session pod"]);

    const created: K8sResource[] = [];
    for (const [resource, obj, step] of steps) {
      await recordStartupBestEffort(id, "creating", step);
      const res = await client.create(resource, ns, obj);
      if (!res.ok) {
        const detail = describeError(res, resource);
        await recordStartupBestEffort(id, "failed", `${step} failed`, detail, { failedAt: now(), failure: detail });
        log.warn(`[sessions-k8s] Creating ${resource} for session ${id} failed: ${detail}`);
        // A create the API refused or never received stored nothing. One whose answer was lost (timeout,
        // ECONNRESET) or was a 5xx may have been stored, even after the rollback's delete of it, so that
        // resource stays queued until its write can no longer land.
        if (res.applied === "maybe") {
          const pending = pendingCleanup.get(id) ?? new Map<K8sResource, number>();
          pendingCleanup.set(id, pending.set(resource, now() + LATE_WRITE_MS));
        }
        await deleteOrRetryLater(id, res.applied === "maybe" ? [resource, ...created.reverse()] : created.reverse());
        return { ok: false, detail };
      }
      created.push(resource);
    }
    await recordStartupBestEffort(id, "pending", "Waiting for pod to start", null, { clearFailure: true });
    return { ok: true };
  }

  async function waitForPodGone(id: string): Promise<boolean> {
    const deadline = now() + podGoneTimeoutMs;
    for (;;) {
      const res = await client.get("pods", ns, name(id));
      if (!res.ok && res.kind === "not-found") return true;
      if (now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  async function terminalToken(entry: PodSessionEntry): Promise<string | null> {
    if (entry.terminalToken) return entry.terminalToken;
    const res = await client.get<K8sObject & { data?: Record<string, string> }>("secrets", ns, name(entry.id));
    const encoded = res.ok ? res.value.data?.[TERMINAL_TOKEN_KEY] : undefined;
    if (!encoded) return null;
    entry.terminalToken = Buffer.from(encoded, "base64").toString("utf8").trim();
    return entry.terminalToken;
  }

  /**
   * The session's MCP token, read from its Secret on a cache miss (e.g. after a
   * Claws restart). `token` is null when the Secret or its key is gone — a
   * session created before #3056 has none. Only a 404 counts as gone.
   */
  async function mcpToken(entry: PodSessionEntry): Promise<{ ok: true; token: string | null } | { ok: false; detail: string }> {
    if (entry.mcpToken) return { ok: true, token: entry.mcpToken };
    const res = await client.get<K8sObject & { data?: Record<string, string> }>("secrets", ns, name(entry.id));
    if (!res.ok) return res.kind === "not-found" ? { ok: true, token: null } : { ok: false, detail: describeError(res, "secrets") };
    const encoded = res.value.data?.[MCP_TOKEN_KEY];
    if (!encoded) return { ok: true, token: null };
    const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
    const current = entries.get(entry.id) ?? entry;
    current.mcpToken ??= decoded;
    return { ok: true, token: current.mcpToken };
  }

  /**
   * One HTTP exchange with a session pod's terminal server. Rejects on network
   * failure/timeout. A pod runs code Claws does not control, so its answer is
   * bounded: past `limit.maxBytes` only the tail is kept, or the request fails.
   */
  function podRequest(
    id: string,
    token: string,
    method: "GET" | "POST",
    pathAndQuery: string,
    body: Buffer | Readable | null,
    timeoutMs: number,
    limit: { maxBytes: number; overflow: "keep-tail" | "reject" },
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(pathAndQuery, podBaseUrl(id));
      const headers: Record<string, string | number> = { Authorization: `Bearer ${token}` };
      if (Buffer.isBuffer(body)) headers["Content-Length"] = body.length;
      if (body) headers["Content-Type"] = "application/octet-stream";
      const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (req.destroyed) return;
          chunks.push(c);
          size += c.length;
          if (size <= limit.maxBytes) return;
          if (limit.overflow === "reject") {
            req.destroy(new Error("response too large"));
            return;
          }
          while (size - chunks[0].length >= limit.maxBytes) size -= chunks.shift()!.length;
        });
        res.on("end", () => {
          const all = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, body: all.subarray(Math.max(0, all.length - limit.maxBytes)).toString("utf8") });
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      if (Buffer.isBuffer(body)) {
        req.end(body);
      } else if (body) {
        // pipeline destroys the upload source too when the pod request fails, so the browser upload aborts.
        pipeline(body, req, (err) => { if (err) req.destroy(err); });
      } else {
        req.end();
      }
    });
  }

  // ── Row lookups ──

  type RowLookup = { ok: true; row: PersistedSession } | SessionLookupFailure;

  async function openPodRow(id: string): Promise<RowLookup> {
    let row: PersistedSession | undefined;
    try {
      row = await getPersistedSession(id);
    } catch (err) {
      return { ok: false, reason: "unavailable", detail: `database: ${err}` };
    }
    if (!row || row.backend !== "k8s-pod" || row.ended_at !== null) return { ok: false, reason: "not-found" };
    return { ok: true, row };
  }

  /** Row open, API reachable and the pod Ready — else the lookup failure. */
  async function readyEntry(id: string): Promise<{ ok: true; entry: PodSessionEntry } | SessionLookupFailure> {
    const found = await openPodRow(id);
    if (!found.ok) return found;
    const entry = ensureEntry(found.row);
    if (reconcileState !== "ok") return { ok: false, reason: "unavailable", detail: RECONCILE_STATE_DETAIL[reconcileState] };
    if (entry.classification?.state !== "ready") {
      return { ok: false, reason: "unavailable", detail: `session pod is ${entry.classification?.state ?? "not yet observed"}` };
    }
    return { ok: true, entry };
  }

  function startupFailureReason(startup: PodStartupClassification): string | null {
    return startup.state === "failed" ? startup.failureReason ?? startup.detail ?? "startup failed" : null;
  }

  function startupFromRow(row: PersistedSession): SessionStartupStatus {
    const startedAt = row.startup_started_at ?? row.launched_at ?? row.created_at ?? null;
    const state = (row.startup_state ?? (row.ended_at !== null ? "ended" : "unknown")) as SessionStartupStatus["state"];
    return {
      state,
      step: row.startup_step ?? (state === "ended" ? "Session ended" : "Checking session startup"),
      detail: row.startup_detail,
      startedAt,
      elapsedMs: elapsed(startedAt),
      terminalReadyAt: row.startup_ready_at,
      failureReason: row.startup_failure,
    };
  }

  /**
   * Startup status for one row of the `/sessions` list: what the 15s reconcile pass last saw
   * for the pod (it lists every session pod in one call), else what the row recorded. A list
   * render must cost no per-session API call and no write; only `getStartupStatus`, polled for
   * a single open terminal, reads the pod live.
   */
  function listStartupStatus(row: PersistedSession): SessionStartupStatus {
    const base = startupFromRow(row);
    const startup = entries.get(row.id)?.startup;
    if (!startup || row.ended_at !== null) return base;
    return {
      ...base,
      state: startup.state,
      step: startup.step,
      detail: startup.detail ?? null,
      failureReason: startupFailureReason(startup),
    };
  }

  async function deriveStartupStatus(row: PersistedSession): Promise<SessionStartupStatus | SessionLookupFailure> {
    const base = startupFromRow(row);
    if (row.ended_at !== null) {
      return {
        ...base,
        state: "ended",
        step: row.exit_code != null ? `Session exited (code ${row.exit_code})` : row.startup_failure ? "Startup failed" : "Session ended",
        failureReason: row.startup_failure,
      };
    }

    const pod = await client.get<PodLike & K8sObject>("pods", ns, name(row.id));
    if (!pod.ok) {
      if (pod.kind !== "not-found") return { ok: false, reason: "unavailable", detail: describeError(pod, "pods") };
      if (reconcileState === "unknown") reconcileState = "ok";
      const startedAt = row.startup_started_at ?? row.launched_at ?? row.created_at;
      if (now() - startedAt > WORKLOAD_LAUNCH_GRACE_MS) {
        const failure = "pod not found";
        await recordDerivedStartup(row.id, "failed", "Session pod not found", failure, { failedAt: now(), failure, expectUpdatedAt: row.startup_updated_at });
        return { ...base, state: "failed", step: "Session pod not found", detail: failure, failureReason: failure, elapsedMs: elapsed(startedAt) };
      }
      return {
        ...base,
        state: base.state === "creating" || base.state === "preparing" ? base.state : "pending",
        step: base.step === "Checking session startup" ? "Waiting for pod to start" : base.step,
        elapsedMs: elapsed(startedAt),
      };
    }

    if (reconcileState === "unknown") reconcileState = "ok";
    const classification = classifyPod(pod.value);
    const startup = classifyPodStartup(pod.value);
    const entry = ensureEntry(row);
    entry.classification = classification;
    entry.startup = startup;
    const startedAt = row.startup_started_at ?? row.launched_at ?? row.created_at;
    const readyAt = startup.state === "ready" ? (row.startup_ready_at ?? now()) : row.startup_ready_at;
    const failedAt = startup.state === "failed" ? (row.startup_failed_at ?? now()) : row.startup_failed_at;
    if (
      startup.state !== row.startup_state
      || startup.step !== row.startup_step
      || (startup.detail ?? null) !== row.startup_detail
      || readyAt !== row.startup_ready_at
      || failedAt !== row.startup_failed_at
      || (startup.failureReason ?? null) !== row.startup_failure
    ) {
      const persisted = await recordDerivedStartup(row.id, startup.state, startup.step, startup.detail ?? null, {
        ...(startup.state === "ready" ? { readyAt } : {}),
        ...(startup.state === "failed" ? { failedAt, failure: startupFailureReason(startup) } : {}),
        clearFailure: startup.state !== "failed",
        expectUpdatedAt: row.startup_updated_at,
      });
      if (persisted) {
        row.startup_state = startup.state;
        row.startup_step = startup.step;
        row.startup_detail = startup.detail ?? null;
        row.startup_ready_at = readyAt;
        row.startup_failed_at = failedAt;
        row.startup_failure = startupFailureReason(startup);
      }
    }
    return {
      state: startup.state,
      step: startup.step,
      detail: startup.detail ?? null,
      startedAt,
      elapsedMs: elapsed(startedAt),
      terminalReadyAt: readyAt,
      failureReason: startupFailureReason(startup),
    };
  }

  // ── Launch ──

  async function launchNew(
    req: { mode: SessionMode; provider: SessionProvider; model: string | null; repos: string[]; capabilities: string[] },
  ): Promise<SessionStartResult> {
    if (!settings.image) {
      return { ok: false, reason: "backend-unavailable", detail: "CLAWS_SESSION_IMAGE is empty (a dev build has no published image)" };
    }
    const id = crypto.randomBytes(8).toString("hex");
    busy.set(id, "launching");
    try {
      return await launchNewLocked(id, req);
    } finally {
      busy.delete(id);
    }
  }

  /**
   * Drop the row of a create whose objects could not all be created. If a
   * rollback delete is still queued, `pendingCleanup` is only in memory, so the
   * row is kept as ended instead: reconcile deletes it once the queue drains,
   * and after a restart the ended-row seed re-queues its Service and Secret and
   * pruning deletes its PVC and row. Should even that write fail, the open
   * pod-less row is ended by reconcile past its grace.
   */
  async function discardFailedLaunchRow(id: string): Promise<void> {
    try {
      if (pendingCleanup.has(id)) {
        await markSessionEnded(id, now(), null);
        failedLaunches.add(id);
      } else {
        await deletePersistedSession(id);
      }
    } catch (err) {
      log.warn(`[sessions-k8s] Failed to clean up the row of failed session ${id}: ${err}`);
    }
  }

  async function launchNewLocked(
    id: string,
    req: { mode: SessionMode; provider: SessionProvider; model: string | null; repos: string[]; capabilities: string[] },
  ): Promise<SessionStartResult> {
    let launch: PodLaunch;
    try {
      launch = await buildLaunch({ id, ...req, resume: false });
    } catch (err) {
      log.warn(`[sessions-k8s] Could not prepare launch material for ${id}: ${err}`);
      return { ok: false, reason: "backend-unavailable", detail: `could not prepare session credentials: ${err instanceof Error ? err.message : err}` };
    }

    const worktreeMode = req.mode === "worktree-claude" || req.mode === "multi-worktree-claude";
    const row = {
      id,
      tmux_name: `claws-${id}`,
      mode: req.mode,
      repo: req.repos[0] ?? null,
      cwd: launch.cwd,
      worktree_path: worktreeMode ? launch.repoDirs[0]?.dir ?? null : null,
      extra_worktrees: req.mode === "multi-worktree-claude"
        ? JSON.stringify(launch.repoDirs.slice(1).map(({ repo, dir }) => ({ repo, worktreePath: dir })))
        : null,
      capabilities: JSON.stringify(req.capabilities),
      created_at: now(),
      summary: null,
      summary_updated_at: null,
      provider: req.provider,
      model: req.model,
      backend: "k8s-pod",
    };
    try {
      await insertSession(row);
    } catch (err) {
      log.error(`[sessions-k8s] Failed to persist session ${id}: ${err}`);
      return { ok: false, reason: "persist-failed", detail: String(err) };
    }
    await recordStartupBestEffort(id, "preparing", "Preparing launch material", null, { startedAt: row.created_at, clearFailure: true });

    const created = await createObjects(id, launch, true);
    if (!created.ok) {
      await discardFailedLaunchRow(id);
      return { ok: false, reason: "backend-unavailable", detail: created.detail };
    }
    const entry = ensureEntry({
      ...row,
      ended_at: null,
      resume_repos: null,
      summary_manual: 0,
      agent_status: null,
      agent_status_updated_at: null,
      launched_at: row.created_at,
      tokens_used: null,
      cost_usd: null,
      last_context_tokens: null,
      usage_updated_at: null,
      startup_state: "pending",
      startup_step: "Waiting for pod to start",
      startup_detail: null,
      startup_started_at: row.created_at,
      startup_updated_at: now(),
      startup_ready_at: null,
      startup_failed_at: null,
      startup_failure: null,
      exit_code: null,
      last_output: null,
    });
    entry.terminalToken = launch.terminalToken;
    entry.mcpToken = launch.mcpToken;
    if (launch.hasGithubToken) entry.githubToken = launch.secretData[GITHUB_TOKEN_KEY] ?? null;
    log.info(`[sessions-k8s] Created session ${id} (pod ${name(id)}, mode: ${req.mode}, provider: ${req.provider}; readiness pending)`);
    return { ok: true, id };
  }

  // ── Reconcile ──

  async function refreshGithubToken(entry: PodSessionEntry): Promise<void> {
    if (!rowCapabilities(entry.row).includes(GITHUB_AUTH_CAPABILITY_ID)) return;
    let token: string;
    try {
      token = await getGithubToken(rowRepos(entry.row));
    } catch (err) {
      log.warn(`[sessions-k8s] Could not mint a GitHub token for session ${entry.id}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    // Checked every pass, whatever the Secret's age: the installation-token cache
    // hands back the same token (an in-memory hit) until it is close to expiry, so
    // a session may have been launched with one that has only minutes left.
    if (token === entry.githubToken) return;
    if (entry.githubToken === null) {
      // Unknown slot state (a restart, or a grant recorded for resume): a pod
      // launched before #3131 never mounts a key added now, and adding one would
      // make grantDelivery report the grant live.
      const secret = await client.get<K8sObject & { data?: Record<string, string> }>("secrets", ns, name(entry.id));
      if (!secret.ok || !(GITHUB_TOKEN_KEY in (secret.value.data ?? {}))) return;
    }
    const res = await client.patch("secrets", ns, name(entry.id), buildSecretKeyPatch(GITHUB_TOKEN_KEY, token));
    if (!res.ok) {
      log.warn(`[sessions-k8s] Refreshing github-token for session ${entry.id} failed: ${describeError(res, "secrets")}`);
      return;
    }
    entry.githubToken = token;
  }

  function reconcileFailed(state: "k8s-failed" | "db-failed", message: string): void {
    if (reconcileState !== state) log.warn(`[sessions-k8s] Reconcile: ${message} — making no changes`);
    reconcileState = state;
  }

  type PlanRow = { id: string; launched_at: number; ended_at: number | null };

  const planRow = (r: PersistedSession): PlanRow => (
    { id: r.id, launched_at: Math.max(r.created_at, r.launched_at ?? 0), ended_at: r.ended_at }
  );

  /**
   * Run one reconcile mutation for `id` under its lock; skipped when something
   * else holds it. A DB or API error only skips this id until the next pass.
   */
  async function whileLocked(id: string, act: () => Promise<void>): Promise<void> {
    if (busy.has(id)) return;
    busy.set(id, "reconciling");
    try {
      await act();
    } catch (err) {
      log.warn(`[sessions-k8s] Reconcile: skipped session ${id}: ${err}`);
    } finally {
      busy.delete(id);
    }
  }

  /** Re-read under the lock: the row if it is still as the pass planned from, else undefined. */
  async function unchangedRow(planned: PlanRow): Promise<PersistedSession | undefined> {
    const row = await getPersistedSession(planned.id);
    if (!row || row.backend !== "k8s-pod") return undefined;
    const current = planRow(row);
    return current.ended_at === planned.ended_at && current.launched_at === planned.launched_at ? row : undefined;
  }

  /**
   * One reconcile pass. Without `drainCleanup` (the startup pass) queued
   * Service/Secret deletes are only seeded, not attempted, so boot does not wait
   * on two DELETEs per ended row; the next pass performs them.
   */
  async function runReconcile({ drainCleanup }: { drainCleanup: boolean }): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      // Taken before the pod list: a launch after this point makes the pass's view of that id stale.
      // Rows are read after it, so a relaunch that finishes in between only lengthens that id's grace
      // (its persisted `launched_at` is newer), and the id is in `busy` for the whole relaunch anyway.
      const busyAtStart = new Set(busy.keys());

      const pods = await client.list<PodLike & K8sObject>("pods", ns, workloadSelector(SESSION_WORKLOAD_KIND));
      if (!pods.ok) {
        reconcileFailed("k8s-failed", `listing session pods failed: ${describeError(pods, "pods", "list")}`);
        return;
      }
      const pvcs = await client.list<K8sObject>("persistentvolumeclaims", ns, workloadSelector(SESSION_WORKLOAD_KIND));
      if (!pvcs.ok) log.debug(`[sessions-k8s] Reconcile: listing session PVCs failed: ${describeError(pvcs, "persistentvolumeclaims", "list")}`);
      let rows: PersistedSession[];
      try {
        const [open, ended] = await Promise.all([getAllPersistedSessions(), getEndedSessions()]);
        rows = [...open, ...ended].filter((r) => r.backend === "k8s-pod");
      } catch (err) {
        reconcileFailed("db-failed", `reading sessions failed: ${err}`);
        return;
      }
      if (reconcileState !== "ok") log.info("[sessions-k8s] Reconcile: Kubernetes API and database reachable");
      reconcileState = "ok";

      const rowsById = new Map(rows.map((r) => [r.id, r]));
      const planRows = new Map(rows.map((r) => [r.id, planRow(r)]));

      if (!cleanupSeeded) {
        cleanupSeeded = true;
        for (const r of rows) {
          if (r.ended_at === null) continue;
          const known = pendingCleanup.get(r.id);
          const pending = known ?? new Map<K8sResource, number>();
          // This process already queued what its own failed creates may still write. Any other row may be
          // one whose create failed just before a restart, ended at the failure, so its write may land until then.
          const notGoneBefore = known ? 0 : r.ended_at + LATE_WRITE_MS;
          for (const resource of ["services", "secrets"] as const) if (!pending.has(resource)) pending.set(resource, notGoneBefore);
          pendingCleanup.set(r.id, pending);
        }
      }
      for (const id of drainCleanup ? new Set([...pendingCleanup.keys(), ...failedLaunches]) : []) {
        await whileLocked(id, async () => {
          const row = await getPersistedSession(id);
          // Reopened since the delete failed: its objects are the live session's now.
          if (row?.backend === "k8s-pod" && row.ended_at === null) {
            pendingCleanup.delete(id);
            failedLaunches.delete(id);
            return;
          }
          const resources = pendingCleanup.get(id);
          if (resources) await deleteOrRetryLater(id, [...resources.keys()]);
          // The row of a create that never started was only kept to carry this retry.
          if (failedLaunches.has(id) && !pendingCleanup.has(id)) {
            // Already gone (e.g. Delete or pruning): nothing left to retry.
            if (row) await deleteEndedPersistedSession(id);
            // Only once the delete succeeded; a throw keeps the id for the next pass.
            failedLaunches.delete(id);
          }
        });
      }

      const plan = planWorkloadReconcile({
        rows: [...planRows.values()],
        pods: pods.value,
        launching: new Set([...busyAtStart, ...busy.keys()]),
        now: now(),
        graceMs: WORKLOAD_LAUNCH_GRACE_MS,
      });

      const podsById = new Map<string, PodLike & K8sObject>();
      for (const pod of pods.value) {
        const id = pod.metadata?.labels?.[LABEL_WORKLOAD_ID];
        if (id) podsById.set(id, pod);
      }
      const openIds = new Set<string>();
      for (const live of plan.live) {
        const row = rowsById.get(live.id);
        if (!row) continue;
        openIds.add(live.id);
        const entry = ensureEntry(row);
        entry.classification = live.classification;
        // The list column reads this, so every pass refreshes it from the pod list it already has.
        const pod = podsById.get(live.id);
        if (pod) entry.startup = classifyPodStartup(pod);
      }
      let endedAny = false;
      for (const { id, reason, exitCode } of plan.markEnded) {
        const planned = planRows.get(id);
        if (!planned) continue;
        await whileLocked(id, async () => {
          const row = await unchangedRow(planned);
          if (!row) return;
          // The pod's own exit report (#3311) carries the process's real code; the pod status is the fallback.
          const code = row.exit_code ?? exitCode;
          const step = row.exit_code != null
            ? (code === 0 ? "Session exited" : `Session exited with code ${code}`)
            : (code === 0 ? "Session ended" : "Session pod failed");
          // Only this pass knows why the row ended; `markSessionEnded` would otherwise leave
          // `startup_state` at 'ended' with no cause for any session no client was polling.
          try {
            await recordStartup(
              id,
              code === 0 ? "ended" : "failed",
              step,
              reason,
              code === 0 ? {} : { failedAt: now(), failure: reason },
            );
          } catch (err) {
            log.warn(`[sessions-k8s] Failed to record why session ${id} ended: ${err}`);
          }
          try {
            await markSessionEnded(id, now(), resumeReposJson(row));
          } catch (err) {
            log.warn(`[sessions-k8s] Failed to record ended session ${id}: ${err}`);
            return;
          }
          log.info(`[sessions-k8s] Session ${id} ended (${reason}) — moved to history; its storage is kept`);
          dropEntry(id, code);
          // Its credentials go with it; resume recreates both.
          await deleteOrRetryLater(id, ["services", "secrets"]);
          endedAny = true;
        });
      }
      // A session that ends on its own (exit, crash, eviction) never goes through `end()`, so prune here
      // too — otherwise only an operator's explicit End keeps history and its PVCs within the bound.
      if (endedAny) await pruneHistory();
      for (const podName of plan.deletePodsForEndedRows) {
        const pod = pods.value.find((p) => p.metadata?.name === podName);
        const id = pod?.metadata?.labels?.[LABEL_WORKLOAD_ID];
        const planned = id === undefined ? undefined : planRows.get(id);
        if (!id || !planned) continue;
        await whileLocked(id, async () => {
          if (!await unchangedRow(planned)) return;
          const res = await client.delete("pods", ns, podName);
          if (res.ok) log.info(`[sessions-k8s] Deleted pod ${podName} of ended session ${id}`);
          else if (res.kind !== "not-found") log.warn(`[sessions-k8s] Failed to delete pod ${podName}: ${describeError(res, "pods")}`);
        });
      }
      for (const podName of plan.orphanPods) {
        if (reportedOrphans.has(podName)) continue;
        reportedOrphans.add(podName);
        const id = pods.value.find((p) => p.metadata?.name === podName)?.metadata?.labels?.[LABEL_WORKLOAD_ID] ?? "<id>";
        log.warn(
          `[sessions-k8s] Orphan session pod ${podName} has no session row — left running. `
          + `Inspect it, then clean up with: kubectl -n ${ns} delete pod,svc,secret -l claws-workload-id=${id} `
          + `(add pvc to also discard its storage)`,
        );
      }
      // A PVC with no row at all (e.g. a prune whose delete failed) is only reported, never deleted;
      // one already terminating (Delete or a prune just removed its row) or queued for a delete is not an orphan.
      for (const pvc of pvcs.ok ? pvcs.value : []) {
        const pvcName = pvc.metadata?.name;
        const id = pvc.metadata?.labels?.[LABEL_WORKLOAD_ID];
        if (!pvcName || !id || rowsById.has(id) || busyAtStart.has(id) || busy.has(id) || reportedOrphans.has(pvcName)) continue;
        if (pvc.metadata?.deletionTimestamp || pendingCleanup.has(id)) continue;
        reportedOrphans.add(pvcName);
        log.warn(
          `[sessions-k8s] Orphan session PVC ${pvcName} has no session row — its storage is kept. `
          + `Inspect it, then clean up with: kubectl -n ${ns} delete pod,svc,secret,pvc -l claws-workload-id=${id}`,
        );
      }

      // Rows still open but not in the plan (launching, or a pod-less row inside its grace) keep their entries.
      for (const r of rows) if (r.ended_at === null) openIds.add(r.id);
      for (const id of [...entries.keys()]) {
        if (openIds.has(id)) continue;
        await whileLocked(id, async () => {
          // A create/resume may have opened it since the pass read the rows.
          const row = await getPersistedSession(id);
          if (row?.backend !== "k8s-pod" || row.ended_at !== null) dropEntry(id);
        });
      }

      for (const live of plan.live) {
        const entry = entries.get(live.id);
        // A PATCH of one Secret key cannot race a launch or cleanup into stranding anything, so it only skips a held id.
        if (entry && !busy.has(live.id)) await refreshGithubToken(entry);
      }
    } finally {
      reconciling = false;
    }
  }

  const reconcile = (): Promise<void> => runReconcile({ drainCleanup: true });

  async function refreshScrollback(entry: PodSessionEntry): Promise<boolean> {
    const token = await terminalToken(entry);
    if (!token) return false;
    try {
      const res = await podRequest(entry.id, token, "GET", "/scrollback", null, POD_HTTP_TIMEOUT_MS, { maxBytes: SCROLLBACK_MAX_BYTES, overflow: "keep-tail" });
      if (res.status !== 200) return false;
      const text = res.body.slice(-SCROLLBACK_LIMIT);
      if (text !== entry.scrollback) {
        entry.scrollback = text;
        entry.lastActivity = now();
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Whether `summarizeSession` could replace this entry's summary; mirrors its early returns. */
  function wantsSummary(entry: PodSessionEntry): boolean {
    if (entry.summaryManual) return false;
    return !entry.summary || isIdlePlaceholder(entry.summary) || isNumberOnlySummary(entry.summary);
  }

  async function summarizeAll(): Promise<void> {
    if (isShuttingDown() || summarizing) return;
    summarizing = true;
    try {
      for (const entry of [...entries.values()]) {
        if (entry.classification?.state !== "ready" || !wantsSummary(entry)) continue;
        if (await refreshScrollback(entry)) void summarizeSession(entry);
      }
    } finally {
      summarizing = false;
    }
  }

  function parseUsageSnapshot(raw: string): SessionUsageSnapshot | null {
    try {
      const v = JSON.parse(raw) as unknown;
      if (!v || typeof v !== "object") return null;
      const o = v as Record<string, unknown>;
      if (typeof o.tokensUsed !== "number" || typeof o.lastContextTokens !== "number") return null;
      if (o.costUsd !== null && typeof o.costUsd !== "number") return null;
      if (o.usageUpdatedAt !== null && typeof o.usageUpdatedAt !== "number") return null;
      const warningLevel = o.warningLevel;
      if (warningLevel !== "none" && warningLevel !== "warn" && warningLevel !== "critical") return null;
      return {
        tokensUsed: o.tokensUsed,
        costUsd: o.costUsd,
        lastContextTokens: o.lastContextTokens,
        usageUpdatedAt: o.usageUpdatedAt,
        warningLevel,
      } as SessionUsageSnapshot;
    } catch {
      return null;
    }
  }

  async function sampleUsageAll(): Promise<void> {
    if (isShuttingDown() || samplingUsage) return;
    samplingUsage = true;
    try {
      for (const entry of [...entries.values()]) {
        if (entry.classification?.state !== "ready") continue;
        if (entry.row.mode === "repo-zsh" || (entry.row.provider && entry.row.provider !== "claude")) continue;
        const token = await terminalToken(entry);
        if (!token) continue;
        try {
          const res = await podRequest(entry.id, token, "GET", "/usage", null, POD_HTTP_TIMEOUT_MS, { maxBytes: USAGE_REPLY_MAX_BYTES, overflow: "reject" });
          if (res.status === 204) continue;
          if (res.status !== 200) continue;
          const snapshot = parseUsageSnapshot(res.body);
          if (!snapshot) continue;
          await updateSessionUsage(entry.id, snapshot);
          entry.row.tokens_used = snapshot.tokensUsed;
          entry.row.cost_usd = snapshot.costUsd;
          entry.row.last_context_tokens = snapshot.lastContextTokens;
          entry.row.usage_updated_at = snapshot.usageUpdatedAt;
        } catch (err) {
          log.debug(`[sessions-k8s] Usage refresh for ${entry.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      samplingUsage = false;
    }
  }

  // ── Uploads ──

  async function proxyUpload(id: string, originalName: string, body: Buffer | Readable): Promise<SessionUploadResult> {
    const ready = await readyEntry(id);
    if (!ready.ok) return ready;
    const token = await terminalToken(ready.entry);
    if (!token) return { ok: false, reason: "unavailable", detail: "session terminal token unavailable" };
    let res: { status: number; body: string };
    try {
      res = await podRequest(id, token, "POST", `/uploads?name=${encodeURIComponent(originalName)}`, body, UPLOAD_REQUEST_TIMEOUT_MS, { maxBytes: UPLOAD_REPLY_MAX_BYTES, overflow: "reject" });
    } catch (err) {
      return { ok: false, reason: "unavailable", detail: `session pod unreachable: ${err instanceof Error ? err.message : err}` };
    }
    try {
      const parsed = JSON.parse(res.body) as SaveUploadResult;
      if (parsed && typeof parsed.ok === "boolean" && (parsed.ok ? typeof parsed.path === "string" : typeof parsed.reason === "string")) {
        return parsed;
      }
    } catch {
      // Fall through.
    }
    return { ok: false, reason: "unavailable", detail: `session pod answered HTTP ${res.status}` };
  }

  // ── History ──

  /**
   * Drop ended sessions past the newest `MAX_ENDED_SESSIONS`: objects first, then
   * the row only once every delete returned ok/404 (as `remove()` does), so a
   * failed delete leaves the row to retry from on the next End, or the next
   * reconcile pass that ends a row. A row whose lost create may still be written
   * is skipped until it can no longer land (see `lateWriteDeadline`).
   */
  async function pruneHistory(): Promise<void> {
    let candidates: string[];
    try {
      candidates = await getPrunableEndedSessionIds(MAX_ENDED_SESSIONS, "k8s-pod");
    } catch (err) {
      log.warn(`[sessions-k8s] Failed to list ended sessions to prune: ${err}`);
      return;
    }
    for (const id of candidates) {
      if (busy.has(id)) continue;
      busy.set(id, "pruning");
      try {
        // Re-read under the lock: a resume may have reopened the row since the query.
        const row = await getPersistedSession(id);
        if (row?.backend !== "k8s-pod" || row.ended_at === null || lateWriteDeadline(row) > 0) continue;
        let allGone = true;
        for (const resource of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) {
          if (!await deleteQuietly(resource, id)) {
            allGone = false;
            break;
          }
        }
        if (!allGone) continue;
        await deleteEndedPersistedSession(id);
        pendingCleanup.delete(id);
        failedLaunches.delete(id);
      } catch (err) {
        log.warn(`[sessions-k8s] Failed to prune ended session ${id}: ${err}`);
      } finally {
        busy.delete(id);
      }
    }
  }

  // ── Attach ──

  function closeUnreachable(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "output", data: `\r\n${POD_UNREACHABLE_MESSAGE}\r\n` }));
    ws.close(1011, "Session pod unreachable");
  }

  return {
    kind: "k8s-pod",

    reconcile,

    async start() {
      // The startup pass only queues ended rows' Service/Secret deletes; the first interval pass performs them.
      await runReconcile({ drainCleanup: false });
      reconcileTimer = setInterval(() => { void reconcile().catch((err) => log.warn(`[sessions-k8s] Reconcile failed: ${err}`)); }, opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);
      reconcileTimer.unref();
      summaryTimer = setInterval(() => { void summarizeAll().catch((err) => log.warn(`[sessions-k8s] Summariser failed: ${err}`)); }, opts.summaryIntervalMs ?? SUMMARY_INTERVAL_MS);
      summaryTimer.unref();
      usageTimer = setInterval(() => { void sampleUsageAll().catch((err) => log.warn(`[sessions-k8s] Usage sampler failed: ${err}`)); }, opts.usageIntervalMs ?? USAGE_INTERVAL_MS);
      usageTimer.unref();
      log.info(`[sessions-k8s] Session backend k8s-pod started (namespace ${ns}, image ${settings.image || "<none>"})`);
    },

    async shutdown() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (summaryTimer) clearInterval(summaryTimer);
      if (usageTimer) clearInterval(usageTimer);
      reconcileTimer = null;
      summaryTimer = null;
      usageTimer = null;
      // Only the proxies close; session pods keep running.
      for (const ws of clientSockets.keys()) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1012, "Claws restarting");
      }
      for (const up of upstreamSockets) {
        if (up.readyState === WebSocket.OPEN) up.close(1012, "Claws restarting");
        else up.terminate();
      }
    },

    async create(req) {
      if (isShuttingDown()) return { ok: false, reason: "shutting-down" };
      const provider: SessionProvider = req.mode === "repo-zsh" ? "claude" : req.provider;
      const model = req.mode === "repo-zsh" ? null : (req.model && req.model.trim() ? req.model.trim() : null);
      if (req.mode !== "repo-zsh" && req.provider !== "claude" && req.capabilities.includes(BROWSER_CAPABILITY_ID)) {
        return { ok: false, reason: "capability-unsupported", detail: `${req.provider} cannot use the ${BROWSER_CAPABILITY_ID} capability` };
      }
      if (req.mode === "multi-worktree-claude") return { ok: false, reason: "repo-required-for-mode" };
      if (!req.repo && (req.mode === "worktree-claude" || req.mode === "repo-claude")) {
        return { ok: false, reason: "repo-required-for-mode" };
      }
      if (req.repo) {
        const repos = await listRepos().catch(() => [] as Repo[]);
        if (!repos.some((r) => r.fullName === req.repo)) return { ok: false, reason: "repo-not-listed", detail: req.repo };
      }
      const capabilities = withImplicitCapabilities(req.capabilities, [req.repo]);
      return launchNew({ mode: req.mode, provider, model, repos: req.repo ? [req.repo] : [], capabilities });
    },

    async createMulti(req) {
      if (isShuttingDown()) return { ok: false, reason: "shutting-down" };
      if (req.provider === "opencode") {
        return { ok: false, reason: "provider-unsupported", detail: "opencode cannot attach additional repo worktrees" };
      }
      if (req.provider !== "claude" && req.capabilities.includes(BROWSER_CAPABILITY_ID)) {
        return { ok: false, reason: "capability-unsupported", detail: "browser requires claude" };
      }
      const deduped: string[] = [];
      for (const r of req.repos) if (r && !deduped.includes(r)) deduped.push(r);
      if (deduped.length < 2) return { ok: false, reason: "too-few-repos" };
      const owners = githubOwners(deduped);
      if (owners.length > 1) {
        // Clone credentials and github-token are one owner's installation token.
        return { ok: false, reason: "repos-span-owners", detail: `pod sessions cannot yet combine repos from several GitHub owners (${owners.join(", ")})` };
      }
      const listed = await listRepos().catch(() => [] as Repo[]);
      for (const repo of deduped) {
        if (!listed.some((r) => r.fullName === repo)) return { ok: false, reason: "repo-not-listed", detail: repo };
      }
      const model = req.model && req.model.trim() ? req.model.trim() : null;
      const capabilities = withImplicitCapabilities(req.capabilities, deduped);
      return launchNew({ mode: "multi-worktree-claude", provider: req.provider, model, repos: deduped, capabilities });
    },

    async resume(id) {
      if (isShuttingDown()) return { ok: false, reason: "shutting-down" };
      const held = busy.get(id);
      if (held === "launching") return { ok: true, id };
      if (held) return { ok: false, reason: "backend-unavailable", detail: BUSY_DETAIL[held] };
      busy.set(id, "launching");
      try {
        let row: PersistedSession | undefined;
        try {
          row = await getPersistedSession(id);
        } catch (err) {
          return { ok: false, reason: "persist-failed", detail: String(err) };
        }
        if (!row) return { ok: false, reason: "repo-not-found", detail: id };
        if (row.backend !== "k8s-pod") {
          return { ok: false, reason: "not-resumable", detail: "created on the host tmux backend" };
        }
        if (!settings.image) {
          return { ok: false, reason: "backend-unavailable", detail: "CLAWS_SESSION_IMAGE is empty (a dev build has no published image)" };
        }

        const pvc = await client.get<K8sObject>("persistentvolumeclaims", ns, name(id));
        if (!pvc.ok) {
          return pvc.kind === "not-found"
            ? { ok: false, reason: "not-resumable", detail: "session storage was deleted" }
            : { ok: false, reason: "backend-unavailable", detail: describeError(pvc, "persistentvolumeclaims") };
        }
        if (pvc.value.metadata?.deletionTimestamp) {
          return { ok: false, reason: "not-resumable", detail: "session storage is being deleted" };
        }

        const pod = await client.get<PodLike & K8sObject>("pods", ns, name(id));
        if (pod.ok) {
          const classification = classifyPod(pod.value);
          let relaunch = classification.state === "succeeded" || classification.state === "failed" || !!pod.value.metadata?.deletionTimestamp;
          if (!relaunch && row.ended_at !== null) {
            // Ending the row deleted (or queued a delete of) its Service and Secret; without both the pod is unreachable.
            for (const resource of ["services", "secrets"] as const) {
              const res = await client.get<K8sObject>(resource, ns, name(id));
              if (res.ok) continue;
              if (res.kind !== "not-found") return { ok: false, reason: "backend-unavailable", detail: describeError(res, resource) };
              relaunch = true;
            }
          }
          if (!relaunch) {
            if (row.ended_at !== null) {
              try {
                await clearSessionEnded(id);
              } catch (err) {
                return { ok: false, reason: "persist-failed", detail: String(err) };
              }
            }
            const kept = ensureEntry(
              row.ended_at !== null ? { ...row, ended_at: null, agent_status: null, agent_status_updated_at: null } : row,
            );
            kept.classification = classification;
            kept.startup = classifyPodStartup(pod.value);
            return { ok: true, id };
          }
          const del = await client.delete("pods", ns, name(id));
          if (!okOrGone(del)) return { ok: false, reason: "backend-unavailable", detail: describeError(del as K8sError, "pods") };
          if (!await waitForPodGone(id)) {
            return { ok: false, reason: "backend-unavailable", detail: `pod ${name(id)} is still terminating — try again shortly` };
          }
        } else if (pod.kind !== "not-found") {
          return { ok: false, reason: "backend-unavailable", detail: describeError(pod, "pods") };
        }

        for (const resource of ["services", "secrets"] as const) {
          const res = await client.delete(resource, ns, name(id));
          if (!okOrGone(res)) return { ok: false, reason: "backend-unavailable", detail: describeError(res as K8sError, resource) };
        }

        let launch: PodLaunch;
        try {
          launch = await buildLaunch({
            id,
            mode: row.mode as SessionMode,
            provider: row.provider === "codex" || row.provider === "opencode" ? row.provider : "claude",
            model: row.model ?? null,
            repos: rowRepos(row),
            capabilities: withImplicitCapabilities(rowCapabilities(row), rowRepos(row)),
            resume: true,
          });
        } catch (err) {
          return { ok: false, reason: "backend-unavailable", detail: `could not prepare session credentials: ${err instanceof Error ? err.message : err}` };
        }

        const launchTime = now();
        await recordStartupBestEffort(id, "preparing", "Preparing launch material", null, {
          startedAt: launchTime,
          readyAt: null,
          clearFailure: true,
        });
        const created = await createObjects(id, launch, false);
        if (!created.ok) return { ok: false, reason: "backend-unavailable", detail: created.detail };

        try {
          await clearSessionEnded(id, launchTime);
        } catch (err) {
          log.error(`[sessions-k8s] Failed to reopen session ${id} after relaunch — removing the new pod, keeping storage: ${err}`);
          await deleteOrRetryLater(id, ["pods", "services", "secrets"]);
          return { ok: false, reason: "persist-failed", detail: String(err) };
        }

        const entry = ensureEntry({ ...row, ended_at: null, agent_status: null, agent_status_updated_at: null, launched_at: launchTime });
        entry.classification = null;
        entry.startup = null;
        entry.scrollback = "";
        entry.terminalToken = launch.terminalToken;
        entry.mcpToken = launch.mcpToken;
        entry.githubToken = launch.hasGithubToken ? launch.secretData[GITHUB_TOKEN_KEY] ?? null : null;
        log.info(`[sessions-k8s] Resumed session ${id} on its existing storage; readiness pending`);
        return { ok: true, id };
      } finally {
        busy.delete(id);
      }
    },

    async end(id): Promise<SessionOpResult> {
      const held = busy.get(id);
      if (held) return busyResult(held);
      busy.set(id, "ending");
      try {
        const found = await openPodRow(id);
        if (!found.ok) return found;
        const del = await client.delete("pods", ns, name(id));
        if (!okOrGone(del)) {
          return { ok: false, reason: "unavailable", detail: describeError(del as K8sError, "pods") };
        }
        await deleteOrRetryLater(id, ["services", "secrets"]);
        try {
          await markSessionEnded(id, now(), resumeReposJson(found.row));
        } catch (err) {
          // The pod is gone, so reconcile ends the row once the database is back.
          log.warn(`[sessions-k8s] Failed to record ended session ${id}: ${err}`);
        }
        dropEntry(id, 0);
        log.info(`[sessions-k8s] Ended session ${id} (pod deleted, storage kept)`);
      } finally {
        busy.delete(id);
      }

      // The session has ended; a slow prune must not hold up the End button.
      void pruneHistory().catch((err) => log.warn(`[sessions-k8s] Pruning session history failed: ${err}`));
      return { ok: true };
    },

    async remove(id) {
      const held = busy.get(id);
      if (held) return busyResult(held);
      busy.set(id, "removing");
      try {
        let row: PersistedSession | undefined;
        try {
          row = await getPersistedSession(id);
        } catch (err) {
          return { ok: false, reason: "unavailable", detail: `database: ${err}` };
        }
        if (!row) return { ok: false, reason: "not-found" };
        if (row.backend !== "k8s-pod") {
          // A live host-tmux row is never touched from here; an ended one is only history.
          if (row.ended_at === null) return { ok: false, reason: "not-found" };
        } else {
          if (lateWriteDeadline(row) > 0) {
            return { ok: false, reason: "unavailable", detail: "session is still being cleaned up — try again shortly" };
          }
          for (const resource of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) {
            const res = await client.delete(resource, ns, name(id));
            if (!okOrGone(res)) return { ok: false, reason: "unavailable", detail: describeError(res as K8sError, resource) };
          }
        }
        try {
          await deletePersistedSession(id);
        } catch (err) {
          return { ok: false, reason: "unavailable", detail: `database: ${err}` };
        }
        pendingCleanup.delete(id);
        failedLaunches.delete(id);
        dropEntry(id, 0);
        log.info(`[sessions-k8s] Deleted session ${id}`);
        return { ok: true };
      } finally {
        busy.delete(id);
      }
    },

    async listLive() {
      let rows: PersistedSession[];
      try {
        rows = (await getAllPersistedSessions()).filter((r) => r.backend === "k8s-pod");
      } catch {
        rows = [...entries.values()].map((e) => e.row);
      }
      return rows.map((row): LiveSessionListEntry => {
        const entry = entries.get(row.id);
        const repos = rowRepos(row);
        return {
          id: row.id,
          repo: row.repo,
          extraRepos: repos.slice(row.repo ? 1 : 0),
          cwd: row.cwd,
          mode: row.mode as SessionMode,
          provider: row.provider === "codex" || row.provider === "opencode" ? row.provider : "claude",
          model: row.model ?? null,
          createdAt: row.created_at,
          alive: true,
          resumable: false,
          wsConnected: (entry?.wsCount ?? 0) > 0,
          summary: entry?.summary ?? row.summary,
          summaryUpdatedAt: entry?.summaryUpdatedAt ?? row.summary_updated_at,
          agentStatus: isSessionAgentStatus(row.agent_status) ? row.agent_status : null,
          agentStatusUpdatedAt: isSessionAgentStatus(row.agent_status) ? row.agent_status_updated_at ?? null : null,
          startupStatus: listStartupStatus(row),
          endedAt: null,
          exitCode: null,
          tokensUsed: row.tokens_used,
          costUsd: row.cost_usd,
          lastContextTokens: row.last_context_tokens,
          usageUpdatedAt: row.usage_updated_at,
          usageWarningLevel: row.last_context_tokens == null ? null : row.last_context_tokens >= 180_000 ? "critical" : row.last_context_tokens >= 100_000 ? "warn" : "none",
          capabilities: rowCapabilities(row),
        };
      });
    },

    async getLive(id) {
      const found = await openPodRow(id);
      if (!found.ok) return found;
      const { row } = found;
      const entry = entries.get(id);
      return {
        ok: true,
        session: {
          id: row.id,
          repo: row.repo,
          cwd: row.cwd,
          mode: row.mode as SessionMode,
          provider: row.provider === "codex" || row.provider === "opencode" ? row.provider : "claude",
          model: row.model ?? null,
          alive: true,
          summary: entry?.summary ?? row.summary,
          capabilities: rowCapabilities(row),
        },
      };
    },

    async getStartupStatus(id) {
      if (!/^[a-f0-9]+$/.test(id)) return { ok: false, reason: "not-found" };
      let row: PersistedSession | undefined;
      try {
        row = await getPersistedSession(id);
      } catch (err) {
        return { ok: false, reason: "unavailable", detail: `database: ${err}` };
      }
      if (!row || row.backend !== "k8s-pod") return { ok: false, reason: "not-found" };
      const derived = await deriveStartupStatus(row);
      if ("ok" in derived) return derived;
      return { ok: true, status: derived };
    },

    async grantCapability(id, capId): Promise<GrantCapabilityResult> {
      const held = busy.get(id);
      if (held) return busyResult(held);
      busy.set(id, "granting");
      try {
        const found = await openPodRow(id);
        if (!found.ok) return found;
        const current = rowCapabilities(found.row);
        if (!liveGrantableCapabilities(current, "k8s-pod").some((c) => c.id === capId)) {
          return { ok: false, reason: "invalid", detail: `${capId} cannot be granted to this session` };
        }
        const previous = withImplicitCapabilities(current, rowRepos(found.row));
        const caps = previous.includes(capId) ? previous : [...previous, capId];
        const secret = await client.get<K8sObject & { data?: Record<string, string> }>("secrets", ns, name(id));
        if (!secret.ok) return { ok: false, reason: "unavailable", detail: describeError(secret, "secrets") };
        const mounted = secret.value.data ?? {};
        if (capId.startsWith("ssh:")) {
          // Every ssh:* host shares the Claws-owned keys, mounted only when the pod
          // launched with an ssh:* capability. Nothing is sourced or patched: the
          // grant is live when the key slots are mounted, else it waits for a
          // resume, which rebuilds the launch from the recorded list (#3322).
          const live = SSH_KEY_SECRET_KEYS.some((key) => key in mounted);
          try {
            await updateSessionCapabilities(id, caps);
          } catch (err) {
            return { ok: false, reason: "unavailable", detail: `database: ${err}` };
          }
          const entry = entries.get(id);
          if (entry) entry.row.capabilities = JSON.stringify(caps);
          log.info(`[sessions-k8s] Granted capability ${capId} to session ${id}${live ? "" : " (effective on resume)"}`);
          return { ok: true, live, loadPath: null, marker: null, delayed: false };
        }
        // The pod mounts only the Secret keys present at launch. A pod launched
        // before #3072, or before a KUBECONFIG capability joined the registry,
        // lacks a slot this grant fills: record the grant for its next resume.
        const grantedData = buildGrantedData(caps);
        // github-auth is delivered through the pre-created github-token slot (#3131),
        // which the gh shim and git credential helper read at every call. Mint only
        // when that slot is mounted — a pod launched before #3131 has none, and a
        // transient mint failure must not fail a grant that only takes effect on resume.
        let githubToken: string | null = null;
        if (capId === GITHUB_AUTH_CAPABILITY_ID && GITHUB_TOKEN_KEY in mounted) {
          try {
            githubToken = await getGithubToken(rowRepos(found.row));
          } catch (err) {
            return { ok: false, reason: "unavailable", detail: `GitHub token: ${err instanceof Error ? err.message : err}` };
          }
          grantedData[GITHUB_TOKEN_KEY] = githubToken;
        }
        // A github-auth grant is live only when the github-token slot is mounted too:
        // grantedData never carries that key when the slot is absent, so without this
        // check a missing slot would compute as live from the other keys alone.
        const live = GRANTED_ENV_KEY in mounted
          && Object.entries(grantedData).every(([key, value]) => value === "" || key in mounted)
          && (capId !== GITHUB_AUTH_CAPABILITY_ID || GITHUB_TOKEN_KEY in mounted);
        if (live) {
          // Patch only keys the Secret already has, so an unmounted slot is never added and later mistaken for mounted.
          const slots = Object.fromEntries(Object.entries(grantedData).filter(([key]) => key in mounted));
          const patched = await client.patch("secrets", ns, name(id), buildSecretKeysPatch(slots));
          if (!patched.ok) return { ok: false, reason: "unavailable", detail: describeError(patched, "secrets") };
        }
        try {
          await updateSessionCapabilities(id, caps);
        } catch (err) {
          if (live) {
            // The Secret already carries the new credential; the DB write that would
            // record the grant failed, so restore the Secret to the previous grant.
            const rollbackData = buildGrantedData(previous);
            if (githubToken !== null) rollbackData[GITHUB_TOKEN_KEY] = "";
            const rollbackSlots = Object.fromEntries(Object.entries(rollbackData).filter(([key]) => key in mounted));
            const restored = await client.patch("secrets", ns, name(id), buildSecretKeysPatch(rollbackSlots));
            if (!restored.ok) {
              log.warn(`[sessions-k8s] Failed to roll back granted Secret for session ${id} after a database failure: ${describeError(restored, "secrets")}`);
            }
          }
          return { ok: false, reason: "unavailable", detail: `database: ${err}` };
        }
        const entry = entries.get(id);
        if (entry) {
          entry.row.capabilities = JSON.stringify(caps);
          if (live && githubToken !== null) entry.githubToken = githubToken;
        }
        log.info(`[sessions-k8s] Granted capability ${capId} to session ${id}${live ? "" : " (effective on resume)"}`);
        if (capId === GITHUB_AUTH_CAPABILITY_ID) {
          // github-auth sets no env vars — gh and git read the mounted file directly — so
          // there is nothing to source; `delayed` here means the mounted file may lag,
          // which is true exactly when we actually patched the Secret (i.e. `live`).
          return { ok: true, live, loadPath: null, marker: null, delayed: live };
        }
        // kubelet syncs the mounted file up to a minute or two after the PATCH.
        return live
          ? { ok: true, live, loadPath: `${WORKLOAD_SECRET_DIR}/${GRANTED_ENV_KEY}`, marker: grantedEnvMarker(capId), delayed: true }
          : { ok: true, live, loadPath: null, marker: null, delayed: false };
      } finally {
        busy.delete(id);
      }
    },

    async grantDelivery(id, capId): Promise<GrantDeliveryResult> {
      const found = await openPodRow(id);
      if (!found.ok) return found;
      const secret = await client.get<K8sObject & { data?: Record<string, string> }>("secrets", ns, name(id));
      if (!secret.ok) return { ok: false, reason: "unavailable", detail: describeError(secret, "secrets") };
      const mounted = secret.value.data ?? {};
      // github-auth sets no env vars — gh and git read the mounted github-token file
      // directly — so it is never delivered via the granted-env marker. A pod launched
      // before #3131 has no github-token slot, so the grant only takes effect on resume.
      if (capId === GITHUB_AUTH_CAPABILITY_ID) {
        return GITHUB_TOKEN_KEY in mounted
          ? { ok: true, live: true, loadPath: null, marker: null, delayed: true }
          : { ok: true, live: false, loadPath: null, marker: null, delayed: false };
      }
      // ssh:* needs only the mounted key slots, never the granted-env marker (#3322).
      if (capId.startsWith("ssh:")) {
        return { ok: true, live: SSH_KEY_SECRET_KEYS.some((key) => key in mounted), loadPath: null, marker: null, delayed: false };
      }
      const encoded = mounted[GRANTED_ENV_KEY];
      const marker = grantedEnvMarker(capId);
      if (encoded !== undefined && Buffer.from(encoded, "base64").toString("utf8").split("\n").includes(marker)) {
        return { ok: true, live: true, loadPath: `${WORKLOAD_SECRET_DIR}/${GRANTED_ENV_KEY}`, marker, delayed: true };
      }
      // No marker: the pod was launched with the capability (a resume rewrites
      // the slots empty), or it lacks a slot the grant needs, so the grant waits
      // for a resume. A pod launched before #3072 has no slots at all and its
      // launch grants cannot be told apart; assume the grant waits.
      const kubeconfigSlot = CAPABILITIES.find((c) => c.id === capId)?.envKeys.includes("KUBECONFIG") ?? false;
      if (encoded === undefined || (kubeconfigSlot && !(grantedKubeconfigKey(capId) in mounted))) {
        return { ok: true, live: false, loadPath: null, marker: null, delayed: false };
      }
      return { ok: true, live: true, loadPath: null, marker: null, delayed: false };
    },

    async checkAttach(id) {
      const ready = await readyEntry(id);
      return ready.ok ? { ok: true } : ready;
    },

    attach(id, ws) {
      const entry = entries.get(id);
      if (!entry) {
        ws.close(1008, "Session not found");
        return;
      }
      clientSockets.set(ws, id);
      entry.wsCount += 1;
      entry.lastActivity = now();
      const pending: string[] = [];
      let upstream: WebSocket | null = null;
      let clientClosed = false;

      ws.on("message", (raw: Buffer | string) => {
        entry.lastActivity = now();
        let frame: string;
        try {
          const parsed = WsMessageSchema.safeParse(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
          if (!parsed.success) return;
          frame = JSON.stringify(parsed.data);
        } catch {
          return;
        }
        if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else if (pending.length < MAX_PENDING_FRAMES) pending.push(frame);
      });

      ws.on("close", () => {
        clientClosed = true;
        clientSockets.delete(ws);
        entry.wsCount = Math.max(0, entry.wsCount - 1);
        if (upstream) {
          if (upstream.readyState === WebSocket.OPEN) upstream.close(1000);
          else upstream.terminate();
        }
      });

      void (async () => {
        const token = await terminalToken(entry);
        if (clientClosed) return;
        if (!token) {
          closeUnreachable(ws);
          return;
        }
        const url = new URL("/pty", podBaseUrl(id));
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const up = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: PTY_HANDSHAKE_TIMEOUT_MS, maxPayload: PTY_MAX_PAYLOAD });
        upstream = up;
        upstreamSockets.add(up);
        up.on("open", () => {
          for (const frame of pending.splice(0)) up.send(frame);
        });
        up.on("message", (data: Buffer | string) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(typeof data === "string" ? data : data.toString("utf8"));
        });
        up.on("error", (err) => {
          log.debug(`[sessions-k8s] Terminal proxy for ${id}: ${err.message}`);
        });
        up.on("close", (code: number) => {
          upstreamSockets.delete(up);
          if (clientClosed || ws.readyState !== WebSocket.OPEN) return;
          // 1000/1001: the session ended or its pod is shutting down, after an exit frame.
          if (code === 1000 || code === 1001) ws.close(code, "Session ended");
          else closeUnreachable(ws);
        });
      })().catch((err) => {
        log.warn(`[sessions-k8s] Terminal proxy for ${id} failed: ${err}`);
        closeUnreachable(ws);
      });
    },

    async verifyMcpToken(id, token) {
      let row: PersistedSession | undefined;
      try {
        row = await getPersistedSession(id);
      } catch (err) {
        log.warn(`[sessions-k8s] MCP token check for ${id}: database: ${err}`);
        return "unavailable";
      }
      // Ending or deleting the session revokes its token.
      if (!row || row.backend !== "k8s-pod" || row.ended_at !== null) return "denied";
      const expected = await mcpToken(ensureEntry(row));
      if (!expected.ok) {
        log.warn(`[sessions-k8s] MCP token check for ${id}: ${expected.detail}`);
        return "unavailable";
      }
      if (!expected.token) return "denied";
      const a = Buffer.from(expected.token, "utf8");
      const b = Buffer.from(token, "utf8");
      return a.length === b.length && crypto.timingSafeEqual(a, b) ? "ok" : "denied";
    },

    async recordPodExit(id, token, report) {
      let row: PersistedSession | undefined;
      try {
        row = await getPersistedSession(id);
      } catch (err) {
        log.warn(`[sessions-k8s] Exit report for ${id}: database: ${err}`);
        return "unavailable";
      }
      if (!row || row.backend !== "k8s-pod" || row.ended_at !== null) return "denied";
      const entry = ensureEntry(row);
      if (!entry.terminalToken) {
        // Tell a Secret read failure (retryable) apart from a missing Secret (nothing to check against).
        const secret = await client.get<K8sObject & { data?: Record<string, string> }>("secrets", ns, name(id));
        if (!secret.ok) {
          if (secret.kind === "not-found") return "denied";
          log.warn(`[sessions-k8s] Exit report for ${id}: ${describeError(secret, "secrets")}`);
          return "unavailable";
        }
        const encoded = secret.value.data?.[TERMINAL_TOKEN_KEY];
        if (encoded) entry.terminalToken = Buffer.from(encoded, "base64").toString("utf8").trim();
      }
      const expected = entry.terminalToken;
      if (!expected) return "denied";
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(token, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "denied";
      const tail = stripVTControlCharacters(report.scrollback).slice(-SCROLLBACK_LIMIT);
      try {
        await recordSessionExit(id, report.code, tail || null);
      } catch (err) {
        log.warn(`[sessions-k8s] Exit report for ${id}: database: ${err}`);
        return "unavailable";
      }
      entry.scrollback = tail;
      log.info(`[sessions-k8s] Session ${id} process exited with code ${report.code} (${tail.length} chars of output kept)`);
      return "ok";
    },

    saveUpload: (id, originalName, data) => proxyUpload(id, originalName, data),

    saveUploadStream: (id, originalName, source) => proxyUpload(id, originalName, source),

    async setDescription(id, description) {
      const result = await setSessionDescription(id, description);
      const entry = entries.get(id);
      if (result.ok && entry) {
        entry.summary = result.description;
        entry.summaryUpdatedAt = result.description === null ? null : now();
        entry.summaryManual = result.description !== null;
      }
      return result;
    },

    async setAgentStatus(id, status) {
      const result = await setSessionAgentStatusForSession(id, status);
      const entry = entries.get(id);
      if (result.ok && entry) {
        entry.row = { ...entry.row, agent_status: result.status, agent_status_updated_at: result.updatedAt };
      }
      return result;
    },

    async resummarize(id) {
      const entry = entries.get(id);
      if (!entry || entry.classification?.state !== "ready") return { ok: false, description: null };
      try {
        await setManualSessionSummary(id, null, null);
      } catch (err) {
        log.warn(`[sessions-k8s] Failed to clear pin for session ${id}: ${err}`);
      }
      entry.summary = null;
      entry.summaryUpdatedAt = null;
      entry.summaryManual = false;
      await refreshScrollback(entry);
      await summarizeSession(entry, { force: true });
      return { ok: true, description: entry.summary };
    },
  };
}

let defaultBackend: SessionBackend | null = null;

/** The process-wide `k8s-pod` backend, created on first use with the in-cluster client. */
export function getK8sSessionBackend(): SessionBackend {
  defaultBackend ??= createK8sSessionBackend({ client: createK8sClient(), settings: SESSION_POD_SETTINGS });
  return defaultBackend;
}
