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
  GITHUB_AUTH_CAPABILITY_ID,
  liveGrantableCapabilities,
  withImplicitCapabilities,
} from "./capabilities.js";
import {
  isIdlePlaceholder,
  isNumberOnlySummary,
  isSessionAgentStatus,
  providerFromRow,
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
  markSessionInitialPromptSent,
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
  SSH_SLOTS_KEY,
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
  planWorkloadReconcile,
  renderTerminationMessage,
  workloadName,
  workloadSelector,
  type PodClassification,
  type PodLike,
  type PodStartupClassification,
} from "./k8s/workload.js";
import {
  buildGrantedSecretData,
  buildPodLaunch,
  readServiceSshKeys,
  type PodLaunch,
  type PodLaunchRequest,
} from "./session-pod-launch.js";
import { grantedEnvMarker } from "./session-env-file.js";
import { WsMessageSchema } from "./terminal-protocol.js";
import { MAX_UPLOAD_BYTES, UPLOAD_REQUEST_TIMEOUT_MS, type SaveUploadResult } from "./session-uploads-core.js";
import { deleteSessionFiles } from "./session-files.js";
import { VERSION } from "./version.js";
import type { SessionUsageSnapshot } from "./session-usage.js";
import type { MountedGrants } from "./session-pod/terminal-server.js";
import type {
  GrantCapabilityResult,
  GrantDelivery,
  GrantDeliveryResult,
  NotifyAgentResult,
  RevokeCapabilityResult,
  LiveSessionListEntry,
  SessionBackend,
  SessionLookupFailure,
  SessionOpResult,
  SessionStartupStatus,
  SessionStartResult,
  SessionUploadResult,
  SessionFileFetchResult,
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
 * Rows whose `backend` is NULL or `local-tmux` belong to the removed host tmux
 * backend: legacy history only, never listed as live, revived or reconciled here. PVCs are deleted
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
/** Pod annotation a grant or revoke bumps so the kubelet re-syncs the pod, remounting its Secret at once. */
export const SECRET_REVISION_ANNOTATION = "claws.st-john-software/secret-revision";
/** Longest a live grant waits for the pod to report it landed before answering "landing". */
export const GRANT_LANDED_TIMEOUT_MS = 6_000;
const GRANT_LANDED_POLL_MS = 500;
/** When a grant that has not landed bumps the annotation once more, in case the remount raced the Secret update. */
const GRANT_REBUMP_AFTER_MS = 2_000;
/** A `GET /grants` probe; short, since a grant waits on it. */
const GRANTS_PROBE_TIMEOUT_MS = 2_000;
const GRANTS_REPLY_MAX_BYTES = 16_000;
const NOTIFY_REPLY_MAX_BYTES = 1024;
/** How often a notice queued for a relaunched pod checks that the pod is ready, and the gap between delivery retries. */
export const RELAUNCH_NOTICE_POLL_MS = 5_000;
/** Longest a queued notice waits for a relaunched pod to become ready. */
export const RELAUNCH_NOTICE_TIMEOUT_MS = 5 * 60_000;
/** Pause after a relaunched pod is ready, for the agent to start and reload its conversation. */
export const RELAUNCH_NOTICE_SETTLE_MS = 15_000;
/** Delivery retries after the first attempt finds the agent unreachable. */
const RELAUNCH_NOTICE_RETRIES = 3;
const PTY_HANDSHAKE_TIMEOUT_MS = 10_000;
const SCROLLBACK_LIMIT = 50_000;
/** Bytes of a pod's `GET /scrollback` answer kept: the tail, enough for `SCROLLBACK_LIMIT` characters. */
const SCROLLBACK_MAX_BYTES = SCROLLBACK_LIMIT * 4;
/** A pod's `POST /uploads` reply is a small JSON result; anything larger is refused. */
const UPLOAD_REPLY_MAX_BYTES = 16_000;
/** A pod's `GET /usage` reply is a tiny JSON snapshot. */
const USAGE_REPLY_MAX_BYTES = 4096;
/** A pod's `GET /files` refusal is a small JSON body; only this much of it is read. */
const FILE_REFUSAL_MAX_BYTES = 4096;
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
type BusyOp = "launching" | "ending" | "removing" | "pruning" | "reconciling" | "granting" | "revoking";

const BUSY_DETAIL: Record<Exclude<BusyOp, "launching">, string> = {
  ending: "session is being ended — try again shortly",
  removing: "session is being deleted — try again shortly",
  pruning: "session storage is being deleted — try again shortly",
  reconciling: "session is being reconciled — try again shortly",
  granting: "a capability is being granted to this session — try again shortly",
  revoking: "a capability is being revoked from this session — try again shortly",
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
  /** The service's SSH private keys by Secret slot (see `readServiceSshKeys`). */
  readServiceSshKeys?: () => Record<string, string>;
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

/** What `create` / `createMulti` hand the launch, after validation. */
interface LaunchNewRequest {
  mode: SessionMode;
  provider: SessionProvider;
  model: string | null;
  repos: string[];
  capabilities: string[];
  brief?: string | null;
  spawnedBySession?: string | null;
  spawnedForIssue?: string | null;
  spawnedForPr?: string | null;
  /** The operator's dashboard Initial prompt, stored on the row; null or omitted for none. */
  initialPrompt?: string | null;
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

/** Whether a pod terminal frame is its `{ type: "exit" }` message. */
function isExitFrame(text: string): boolean {
  try {
    return (JSON.parse(text) as { type?: unknown } | null)?.type === "exit";
  } catch {
    return false;
  }
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
  const buildGrantedData = opts.buildGrantedData ?? ((caps: string[]) => buildGrantedSecretData(caps));
  const getGithubToken = opts.getGithubToken ?? defaultGithubToken;
  const readSshKeys = opts.readServiceSshKeys ?? (() => readServiceSshKeys());
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
  /** Ids whose pod a live grant is relaunching: the old pod's exit frames are withheld so terminals reconnect (#clw_01M4RASNVDKH2YBHZMGR0SM0RA). */
  const relaunching = new Set<string>();
  let reconcileState: ReconcileState = "unknown";
  let reconcileTimer: NodeJS.Timeout | null = null;
  let summaryTimer: NodeJS.Timeout | null = null;
  let usageTimer: NodeJS.Timeout | null = null;
  let reconciling = false;
  let summarizing = false;
  let samplingUsage = false;
  /** Whether the missing `patch pods` RBAC was already logged; once per process. */
  let warnedNoPodPatch = false;

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

  /**
   * Relaunch a session on its existing storage: delete the pod (when
   * `podPresent`) and wait for it to go, delete the Service and Secret, build
   * a resume launch (`--continue`, regenerated mcp.json and prompt) for
   * `capabilities`, create the objects, reopen the row and reset the entry's
   * runtime state. Shared by `resume` and a live `browser` grant
   * (#clw_01M4RASNVDKH2YBHZMGR0SM0RA); the caller holds the busy lock. A
   * failure's `stopped` is true once the running pod was deleted: the agent is
   * no longer running and only a resume brings it back.
   */
  async function relaunchOnStorage(
    id: string,
    row: PersistedSession,
    capabilities: string[],
    podPresent: boolean,
  ): Promise<{ ok: true } | { ok: false; stopped: boolean; reason: "backend-unavailable" | "persist-failed"; detail: string }> {
    let stopped = false;
    if (podPresent) {
      const del = await client.delete("pods", ns, name(id));
      if (!okOrGone(del)) return { ok: false, stopped, reason: "backend-unavailable", detail: describeError(del as K8sError, "pods") };
      stopped = true;
      if (!await waitForPodGone(id)) {
        return { ok: false, stopped, reason: "backend-unavailable", detail: `pod ${name(id)} is still terminating — try again shortly` };
      }
    }

    for (const resource of ["services", "secrets"] as const) {
      const res = await client.delete(resource, ns, name(id));
      if (!okOrGone(res)) return { ok: false, stopped, reason: "backend-unavailable", detail: describeError(res as K8sError, resource) };
    }

    let launch: PodLaunch;
    try {
      launch = await buildLaunch({
        id,
        mode: row.mode as SessionMode,
        provider: providerFromRow(row.provider),
        model: row.model ?? null,
        repos: rowRepos(row),
        capabilities,
        brief: row.brief ?? null,
        // Still undelivered: carry it again. `buildPodLaunch` then starts the agent fresh despite `resume`.
        initialPrompt: row.initial_prompt_sent_at == null ? row.initial_prompt ?? null : null,
        resume: true,
      });
    } catch (err) {
      return { ok: false, stopped, reason: "backend-unavailable", detail: `could not prepare session credentials: ${err instanceof Error ? err.message : err}` };
    }

    const launchTime = now();
    await recordStartupBestEffort(id, "preparing", "Preparing launch material", null, {
      startedAt: launchTime,
      readyAt: null,
      clearFailure: true,
    });
    const created = await createObjects(id, launch, false);
    if (!created.ok) return { ok: false, stopped, reason: "backend-unavailable", detail: created.detail };

    try {
      await clearSessionEnded(id, launchTime);
    } catch (err) {
      log.error(`[sessions-k8s] Failed to reopen session ${id} after relaunch — removing the new pod, keeping storage: ${err}`);
      await deleteOrRetryLater(id, ["pods", "services", "secrets"]);
      return { ok: false, stopped, reason: "persist-failed", detail: String(err) };
    }

    const entry = ensureEntry({ ...row, ended_at: null, agent_status: null, agent_status_updated_at: null, launched_at: launchTime });
    entry.classification = null;
    entry.startup = null;
    entry.scrollback = "";
    entry.terminalToken = launch.terminalToken;
    entry.mcpToken = launch.mcpToken;
    entry.githubToken = launch.hasGithubToken ? launch.secretData[GITHUB_TOKEN_KEY] ?? null : null;
    return { ok: true };
  }

  /**
   * Mark a session's Initial prompt delivered the first time its startup reads `ready` (the pod's
   * `/healthz` saw the agent's process running), so no later relaunch carries it again. Best-effort:
   * a failed write leaves it pending, and the next ready read retries.
   */
  async function noteInitialPromptDelivered(row: PersistedSession, startup: PodStartupClassification | null): Promise<void> {
    if (row.initial_prompt == null || row.initial_prompt_sent_at != null || startup?.state !== "ready") return;
    const at = now();
    try {
      await markSessionInitialPromptSent(row.id, at);
      row.initial_prompt_sent_at = at;
    } catch (err) {
      log.warn(`[sessions-k8s] Failed to mark session ${row.id}'s initial prompt delivered: ${err}`);
    }
  }

  /** Type one line into the agent's terminal through the pod's `POST /notify`. */
  async function notifyAgentText(id: string, text: string): Promise<NotifyAgentResult> {
    const ready = await readyEntry(id);
    if (!ready.ok) return "unreachable";
    const token = await terminalToken(ready.entry);
    if (!token) return "unreachable";
    try {
      const res = await podRequest(id, token, "POST", "/notify", Buffer.from(text, "utf8"), POD_HTTP_TIMEOUT_MS, { maxBytes: NOTIFY_REPLY_MAX_BYTES, overflow: "reject" });
      if (res.status === 204 || res.status === 200) return "ok";
      if (res.status === 404) return "unsupported";
      log.warn(`[sessions-k8s] Notifying the agent of session ${id} failed: HTTP ${res.status}`);
      return "unreachable";
    } catch (err) {
      log.warn(`[sessions-k8s] Notifying the agent of session ${id} failed: ${err instanceof Error ? err.message : err}`);
      return "unreachable";
    }
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

  // ── Grant delivery ──

  /** The terminal token in Secret data just read, or null without one. */
  function secretTerminalToken(data: Record<string, string>): string | null {
    const encoded = data[TERMINAL_TOKEN_KEY];
    return encoded ? Buffer.from(encoded, "base64").toString("utf8").trim() || null : null;
  }

  /**
   * Merge-patch the pod's `SECRET_REVISION_ANNOTATION`: any pod update makes
   * the kubelet re-sync it and remount its Secret volume, so a just-patched
   * Secret lands in about a second instead of on the kubelet's 1–2 minute
   * schedule. False when the patch failed; the grant then lands on that schedule.
   */
  async function bumpPodSync(id: string): Promise<boolean> {
    const res = await client.patch("pods", ns, name(id), { metadata: { annotations: { [SECRET_REVISION_ANNOTATION]: String(now()) } } });
    if (res.ok) return true;
    if (res.kind === "forbidden") {
      if (!warnedNoPodPatch) {
        warnedNoPodPatch = true;
        log.warn(`[sessions-k8s] RBAC lacks patch on pods; grants land on the kubelet's schedule (${describeError(res, "pods", "patch")})`);
      }
    } else {
      log.warn(`[sessions-k8s] Could not force session ${id}'s pod to re-sync its Secret: ${describeError(res, "pods", "patch")}`);
    }
    return false;
  }

  /**
   * What the pod's mounted Secret carries now, from its terminal server's
   * `GET /grants`: `unsupported` for a pod launched before the route existed
   * (404), null when it could not be asked.
   */
  async function readPodGrants(id: string, token: string | null): Promise<MountedGrants | "unsupported" | null> {
    if (!token) return null;
    let res: { status: number; body: string };
    try {
      res = await podRequest(id, token, "GET", "/grants", null, GRANTS_PROBE_TIMEOUT_MS, { maxBytes: GRANTS_REPLY_MAX_BYTES, overflow: "reject" });
    } catch {
      return null;
    }
    if (res.status === 404) return "unsupported";
    if (res.status !== 200) return null;
    try {
      const v = JSON.parse(res.body) as Partial<MountedGrants>;
      if (!Array.isArray(v.envMarkers) || typeof v.githubToken !== "boolean" || typeof v.sshKeys !== "boolean") return null;
      return { envMarkers: v.envMarkers.filter((m): m is string => typeof m === "string"), githubToken: v.githubToken, sshKeys: v.sshKeys };
    } catch {
      return null;
    }
  }

  /** Whether the pod's mounted grants carry `capId`. */
  function grantLanded(grants: MountedGrants, capId: string): boolean {
    if (capId === GITHUB_AUTH_CAPABILITY_ID) return grants.githubToken;
    if (capId.startsWith("ssh:")) return grants.sshKeys;
    return grants.envMarkers.includes(grantedEnvMarker(capId));
  }

  /**
   * Poll the pod's `GET /grants` every `GRANT_LANDED_POLL_MS` for up to
   * `timeoutMs` until it carries `capId`, bumping the annotation once more at
   * `GRANT_REBUMP_AFTER_MS` (0 asks once, without a bump). `pending` when it
   * has not landed by then; an unreachable pod counts as not landed. Bounded
   * by both the poll count and the clock, so slow probes cannot stretch it.
   */
  async function awaitLanded(id: string, token: string | null, capId: string, timeoutMs: number): Promise<"landed" | "pending" | "unsupported"> {
    const deadline = now() + timeoutMs;
    for (let polls = 0; ; polls++) {
      const grants = await readPodGrants(id, token);
      if (grants === "unsupported") return "unsupported";
      if (grants && grantLanded(grants, capId)) return "landed";
      const waited = polls * GRANT_LANDED_POLL_MS;
      if (waited >= timeoutMs || now() >= deadline) return "pending";
      if (waited === GRANT_REBUMP_AFTER_MS) await bumpPodSync(id);
      await sleep(GRANT_LANDED_POLL_MS);
    }
  }

  /**
   * A live grant's delivery once the pod has been asked. On a pod that reports
   * its grants, the vars are auto-loaded in every new shell (no `loadPath`) and
   * `landed` is whether it has them yet; a pod launched before that keeps the
   * `legacy` (Secret-derived) guidance.
   */
  function reportedDelivery(legacy: Omit<GrantDelivery, "landed" | "restarted">, arrival: "landed" | "pending" | "unsupported"): GrantDelivery {
    if (arrival === "unsupported") return { ...legacy, landed: true, restarted: false };
    const landed = arrival === "landed";
    return { live: legacy.live, loadPath: null, marker: null, delayed: !landed, landed, restarted: false };
  }

  /**
   * After a live grant's Secret PATCH and DB write: force the pod's re-sync
   * and wait for the grant to land. A grant whose mounted content did not
   * change (`delayed` false) is already in place.
   */
  async function deliverLiveGrant(id: string, token: string | null, capId: string, legacy: Omit<GrantDelivery, "landed" | "restarted">): Promise<GrantDelivery> {
    if (!legacy.delayed) return { ...legacy, landed: true, restarted: false };
    const bumped = await bumpPodSync(id);
    return reportedDelivery(legacy, await awaitLanded(id, token, capId, bumped ? GRANT_LANDED_TIMEOUT_MS : 0));
  }

  /**
   * How a held capability is delivered according to the session's Secret alone
   * (see `GrantDelivery`); `delayed` means the mounted copy may lag it.
   */
  function secretDelivery(mounted: Record<string, string>, capId: string): Omit<GrantDelivery, "landed" | "restarted"> {
    // github-auth sets no env vars — gh and git read the mounted github-token file
    // directly — so it is never delivered via the granted-env marker. A pod launched
    // before #3131 has no github-token slot, so the grant only takes effect on resume.
    if (capId === GITHUB_AUTH_CAPABILITY_ID) {
      return GITHUB_TOKEN_KEY in mounted
        ? { live: true, loadPath: null, marker: null, delayed: true }
        : { live: false, loadPath: null, marker: null, delayed: false };
    }
    // ssh:* needs only a filled key slot on a pod that polls its slots, never the
    // granted-env marker; kubelet may lag the fill.
    if (capId.startsWith("ssh:")) {
      const live = SSH_SLOTS_KEY in mounted && SSH_KEY_SECRET_KEYS.some((key) => (mounted[key] ?? "") !== "");
      return { live, loadPath: null, marker: null, delayed: live };
    }
    const encoded = mounted[GRANTED_ENV_KEY];
    const marker = grantedEnvMarker(capId);
    if (encoded !== undefined && Buffer.from(encoded, "base64").toString("utf8").split("\n").includes(marker)) {
      return { live: true, loadPath: `${WORKLOAD_SECRET_DIR}/${GRANTED_ENV_KEY}`, marker, delayed: true };
    }
    // No marker: the pod was launched with the capability (a resume rewrites
    // the slot empty). A pod launched before #3072 has no granted-env slot and
    // its launch grants cannot be told apart; assume the grant waits for a resume.
    if (encoded === undefined) {
      return { live: false, loadPath: null, marker: null, delayed: false };
    }
    return { live: true, loadPath: null, marker: null, delayed: false };
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
    await noteInitialPromptDelivered(row, startup);
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
    req: LaunchNewRequest,
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
    req: LaunchNewRequest,
  ): Promise<SessionStartResult> {
    let launch: PodLaunch;
    try {
      launch = await buildLaunch({ id, mode: req.mode, provider: req.provider, model: req.model, repos: req.repos, capabilities: req.capabilities, brief: req.brief ?? null, initialPrompt: req.initialPrompt ?? null, resume: false });
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
      brief: req.brief ?? null,
      spawned_by_session: req.spawnedBySession ?? null,
      spawned_for_issue: req.spawnedForIssue ?? null,
      spawned_for_pr: req.spawnedForPr ?? null,
      initial_prompt: req.initialPrompt ?? null,
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
      mcp_token_sha256: null,
      launched_version: VERSION,
      initial_prompt_sent_at: null,
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
  /**
   * End a session row whose process has exited: record why on its startup state,
   * move it to history and delete its Service and Secret (resume recreates both).
   * The caller holds the id's lock and drops the entry. False when the row could
   * not be marked ended, so nothing else was done.
   */
  async function endExitedRow(row: PersistedSession, code: number, reason: string): Promise<boolean> {
    const id = row.id;
    const step = row.exit_code != null
      ? (code === 0 ? "Session exited" : `Session exited with code ${code}`)
      : (code === 0 ? "Session ended" : "Session pod failed");
    // Only the ending path knows why the row ended; `markSessionEnded` would otherwise leave
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
      return false;
    }
    log.info(`[sessions-k8s] Session ${id} ended (${reason}) — moved to history; its storage is kept`);
    // Its credentials go with it; resume recreates both.
    await deleteOrRetryLater(id, ["services", "secrets"]);
    return true;
  }

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
        if (pod) {
          entry.startup = classifyPodStartup(pod);
          await noteInitialPromptDelivered(row, entry.startup);
        }
      }
      let endedAny = false;
      for (const { id, reason, exitCode, terminationMessage } of plan.markEnded) {
        const planned = planRows.get(id);
        if (!planned) continue;
        await whileLocked(id, async () => {
          const row = await unchangedRow(planned);
          if (!row) return;
          // The process's own exit report (#3311) never arrived — capture its fatal log text
          // (#clw_01M3HHA3KY0AMHDMH6C2F2X34Z) before the pod is deleted below. Best-effort: a
          // failure here must never block the row from being recorded as ended.
          if (row.exit_code == null && row.last_output == null && terminationMessage) {
            try {
              await recordSessionExit(id, null, renderTerminationMessage(terminationMessage).slice(-SCROLLBACK_LIMIT) || null);
            } catch (err) {
              log.warn(`[sessions-k8s] Failed to keep session ${id}'s startup error output: ${err}`);
            }
          }
          // The pod's own exit report (#3311) carries the process's real code; the pod status is the fallback.
          const code = row.exit_code ?? exitCode;
          if (!await endExitedRow(row, code, reason)) return;
          dropEntry(id, code);
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

  // ── Published files ──

  /** A pod's `GET /files` JSON refusal, or null when the body is not one. */
  function parseFileRefusal(text: string): { ok?: unknown; reason?: unknown; size?: unknown; detail?: unknown } | null {
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === "object" ? v as { ok?: unknown; reason?: unknown; size?: unknown; detail?: unknown } : null;
    } catch {
      return null;
    }
  }

  /**
   * `GET /files?path=` on the pod, answered as a stream rather than through
   * `podRequest`, which buffers into a string. A 404 whose body is not the
   * route's JSON refusal is a pod launched before the route existed.
   */
  async function fetchPodFile(id: string, podPath: string): Promise<SessionFileFetchResult> {
    const ready = await readyEntry(id);
    if (!ready.ok) return ready;
    const token = await terminalToken(ready.entry);
    if (!token) return { ok: false, reason: "unavailable", detail: "session terminal token unavailable" };
    return new Promise((resolve) => {
      const url = new URL(`/files?path=${encodeURIComponent(podPath)}`, podBaseUrl(id));
      const req = http.request(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, timeout: POD_HTTP_TIMEOUT_MS }, (res) => {
        const status = res.statusCode ?? 0;
        const declared = Number(res.headers["content-length"]);
        if (status === 200) {
          if (!Number.isFinite(declared) || declared < 0) {
            res.destroy();
            resolve({ ok: false, reason: "unavailable", detail: "session pod sent no file length" });
          } else if (declared > MAX_UPLOAD_BYTES) {
            res.destroy();
            resolve({ ok: false, reason: "too-large", size: declared });
          } else {
            resolve({ ok: true, stream: res, size: declared });
          }
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= FILE_REFUSAL_MAX_BYTES) chunks.push(c);
        });
        res.on("error", () => resolve({ ok: false, reason: "unavailable", detail: `session pod answered HTTP ${status}` }));
        res.on("end", () => {
          const parsed = parseFileRefusal(Buffer.concat(chunks).toString("utf8"));
          const detail = typeof parsed?.detail === "string" ? parsed.detail : undefined;
          if (parsed?.ok === false && parsed.reason === "not-found") resolve({ ok: false, reason: "file-not-found", ...(detail ? { detail } : {}) });
          else if (parsed?.ok === false && parsed.reason === "outside-home") resolve({ ok: false, reason: "outside-home" });
          else if (parsed?.ok === false && parsed.reason === "too-large") resolve({ ok: false, reason: "too-large", ...(typeof parsed.size === "number" ? { size: parsed.size } : {}) });
          else if (status === 404) resolve({ ok: false, reason: "unsupported" });
          else resolve({ ok: false, reason: "unavailable", detail: `session pod answered HTTP ${status}` });
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (err) => resolve({ ok: false, reason: "unavailable", detail: `session pod unreachable: ${err.message}` }));
      req.end();
    });
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
        if (await deleteEndedPersistedSession(id)) await deleteSessionFiles(id);
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
      return launchNew({ mode: req.mode, provider, model, repos: req.repo ? [req.repo] : [], capabilities, brief: req.brief, spawnedBySession: req.spawnedBySession, spawnedForIssue: req.spawnedForIssue, spawnedForPr: req.spawnedForPr, initialPrompt: req.mode === "repo-zsh" ? null : req.initialPrompt ?? null });
    },

    async createMulti(req) {
      if (isShuttingDown()) return { ok: false, reason: "shutting-down" };
      if (req.provider === "opencode") {
        return { ok: false, reason: "provider-unsupported", detail: "opencode cannot attach additional repo worktrees" };
      }
      if (req.provider === "pi") {
        return { ok: false, reason: "provider-unsupported", detail: "pi cannot attach additional repo worktrees" };
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
      return launchNew({ mode: "multi-worktree-claude", provider: req.provider, model, repos: deduped, capabilities, brief: req.brief, spawnedBySession: req.spawnedBySession, spawnedForIssue: req.spawnedForIssue, spawnedForPr: req.spawnedForPr, initialPrompt: req.initialPrompt ?? null });
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
          return { ok: false, reason: "not-resumable", detail: "host tmux sessions can no longer be resumed" };
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
        } else if (pod.kind !== "not-found") {
          return { ok: false, reason: "backend-unavailable", detail: describeError(pod, "pods") };
        }

        const relaunched = await relaunchOnStorage(id, row, withImplicitCapabilities(rowCapabilities(row), rowRepos(row)), pod.ok);
        if (!relaunched.ok) return { ok: false, reason: relaunched.reason, detail: relaunched.detail };
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
          // A legacy host-tmux row left open is never touched from here; an ended one is only history.
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
        await deleteSessionFiles(id);
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
          provider: providerFromRow(row.provider),
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
          provider: providerFromRow(row.provider),
          model: row.model ?? null,
          alive: true,
          summary: entry?.summary ?? row.summary,
          extraRepos: rowRepos(row).slice(row.repo ? 1 : 0),
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
        const target = { provider: providerFromRow(found.row.provider), mode: found.row.mode as SessionMode };
        if (!liveGrantableCapabilities(current, "k8s-pod", target).some((c) => c.id === capId)) {
          return { ok: false, reason: "invalid", detail: `${capId} cannot be granted to this session` };
        }
        const previous = withImplicitCapabilities(current, rowRepos(found.row));
        const caps = previous.includes(capId) ? previous : [...previous, capId];
        if (capId === BROWSER_CAPABILITY_ID) {
          // Claude loads MCP servers only at start (--strict-mcp-config), so the
          // Playwright server arrives by relaunching the pod on its storage with
          // --continue and a regenerated mcp.json: the conversation is kept, and a
          // shared browser's tokened URL travels only in the new Secret's session
          // env file (#clw_01M4RASNVDKH2YBHZMGR0SM0RA).
          try {
            await updateSessionCapabilities(id, caps);
          } catch (err) {
            return { ok: false, reason: "unavailable", detail: `database: ${err}` };
          }
          const entry = entries.get(id);
          if (entry) entry.row.capabilities = JSON.stringify(caps);
          // The old pod's terminal server says "exit" as it shuts down; an open
          // terminal page would take that as the session ending and stop
          // reconnecting. Hand its sockets a restart close now, and withhold the
          // old pod's exit frames from anyone who attaches meanwhile.
          relaunching.add(id);
          let relaunched: Awaited<ReturnType<typeof relaunchOnStorage>>;
          try {
            for (const [ws, sid] of clientSockets) {
              if (sid === id && ws.readyState === WebSocket.OPEN) ws.close(1012, "Agent restarting");
            }
            relaunched = await relaunchOnStorage(id, { ...found.row, capabilities: JSON.stringify(caps) }, caps, true);
          } finally {
            relaunching.delete(id);
          }
          if (!relaunched.ok) {
            // Roll back so the next resume does not silently add the browser.
            try {
              await updateSessionCapabilities(id, current);
            } catch (err) {
              log.warn(`[sessions-k8s] Failed to roll back capabilities of session ${id} after a failed relaunch: ${err}`);
            }
            const after = entries.get(id);
            if (after) after.row.capabilities = JSON.stringify(current);
            log.warn(`[sessions-k8s] Granting ${capId} to session ${id} failed to relaunch its pod: ${relaunched.detail}`);
            const detail = relaunched.stopped
              ? `${relaunched.detail} — the agent was stopped; resume the session from the sessions list`
              : relaunched.detail;
            return { ok: false, reason: "unavailable", detail };
          }
          log.info(`[sessions-k8s] Granted capability ${capId} to session ${id}; relaunched its pod with the conversation kept`);
          return { ok: true, live: true, loadPath: null, marker: null, delayed: true, landed: false, restarted: true };
        }
        const secret = await client.get<K8sObject & { data?: Record<string, string> }>("secrets", ns, name(id));
        if (!secret.ok) return { ok: false, reason: "unavailable", detail: describeError(secret, "secrets") };
        const mounted = secret.value.data ?? {};
        if (capId.startsWith("ssh:")) {
          // Every ssh:* host shares the Claws-owned keys. A pod mounts the key
          // slots from launch (empty without an ssh:* grant) and polls them, so
          // filling them makes the grant live without a resume. A pod launched
          // before the poller existed has no SSH_SLOTS_KEY marker (it may still
          // have launch-time slots it never re-reads): record the grant for its next resume.
          const present = SSH_SLOTS_KEY in mounted ? SSH_KEY_SECRET_KEYS.filter((key) => key in mounted) : [];
          if (present.length === 0) {
            try {
              await updateSessionCapabilities(id, caps);
            } catch (err) {
              return { ok: false, reason: "unavailable", detail: `database: ${err}` };
            }
            const entry = entries.get(id);
            if (entry) entry.row.capabilities = JSON.stringify(caps);
            log.info(`[sessions-k8s] Granted capability ${capId} to session ${id} (effective on resume)`);
            return { ok: true, live: false, loadPath: null, marker: null, delayed: false, landed: false, restarted: false };
          }
          const serviceKeys = readSshKeys();
          const slots = Object.fromEntries(Object.entries(serviceKeys).filter(([key]) => present.includes(key)));
          if (Object.keys(slots).length === 0) {
            // Recording the grant would report a host the session cannot reach as usable.
            log.warn(`[sessions-k8s] Cannot grant ${capId} to session ${id}: the service has no SSH private key to deliver`);
            return { ok: false, reason: "unavailable", detail: "the service has no SSH private key to deliver" };
          }
          const previousSlots = Object.fromEntries(present.map((key) => [key, Buffer.from(mounted[key] ?? "", "base64").toString("utf8")]));
          // kubelet lags only when a slot changes from empty; an already filled slot is in place.
          const delayed = Object.keys(slots).some((key) => previousSlots[key] === "");
          const patched = await client.patch("secrets", ns, name(id), buildSecretKeysPatch(slots));
          if (!patched.ok) return { ok: false, reason: "unavailable", detail: describeError(patched, "secrets") };
          try {
            await updateSessionCapabilities(id, caps);
          } catch (err) {
            const rollback = Object.fromEntries(Object.keys(slots).map((key) => [key, previousSlots[key]]));
            const restored = await client.patch("secrets", ns, name(id), buildSecretKeysPatch(rollback));
            if (!restored.ok) {
              log.warn(`[sessions-k8s] Failed to roll back SSH key slots for session ${id} after a database failure: ${describeError(restored, "secrets")}`);
            }
            return { ok: false, reason: "unavailable", detail: `database: ${err}` };
          }
          const entry = entries.get(id);
          if (entry) entry.row.capabilities = JSON.stringify(caps);
          log.info(`[sessions-k8s] Granted capability ${capId} to session ${id}`);
          return { ok: true, ...await deliverLiveGrant(id, secretTerminalToken(mounted), capId, { live: true, loadPath: null, marker: null, delayed }) };
        }
        // The pod mounts only the Secret keys present at launch. A pod launched
        // before #3072 lacks the granted-env slot: record the grant for its next resume.
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
          return live
            ? { ok: true, ...await deliverLiveGrant(id, secretTerminalToken(mounted), capId, { live, loadPath: null, marker: null, delayed: true }) }
            : { ok: true, live, loadPath: null, marker: null, delayed: false, landed: false, restarted: false };
        }
        // Without the re-sync the kubelet updates the mounted file a minute or two after the PATCH.
        return live
          ? { ok: true, ...await deliverLiveGrant(id, secretTerminalToken(mounted), capId, { live, loadPath: `${WORKLOAD_SECRET_DIR}/${GRANTED_ENV_KEY}`, marker: grantedEnvMarker(capId), delayed: true }) }
          : { ok: true, live, loadPath: null, marker: null, delayed: false, landed: false, restarted: false };
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
      const legacy = secretDelivery(mounted, capId);
      if (!legacy.live) return { ok: true, ...legacy, landed: false, restarted: false };
      if (!legacy.delayed) return { ok: true, ...legacy, landed: true, restarted: false };
      // The mounted copy may lag: ask the pod what it holds (a pod that cannot tell keeps the legacy guidance).
      return { ok: true, ...reportedDelivery(legacy, await awaitLanded(id, secretTerminalToken(mounted), capId, 0)) };
    },

    async revokeCapability(id, capId): Promise<RevokeCapabilityResult> {
      const held = busy.get(id);
      if (held) return busyResult(held);
      busy.set(id, "revoking");
      try {
        const found = await openPodRow(id);
        if (!found.ok) return found;
        const current = rowCapabilities(found.row);
        if (!capId.startsWith("ssh:") || !current.includes(capId)) {
          return { ok: false, reason: "invalid", detail: `${capId} cannot be revoked from this session` };
        }
        const remaining = current.filter((c) => c !== capId);
        const secret = await client.get<K8sObject & { data?: Record<string, string> }>("secrets", ns, name(id));
        if (!secret.ok) return { ok: false, reason: "unavailable", detail: describeError(secret, "secrets") };
        const mounted = secret.value.data ?? {};
        // A pod launched before the poller existed (no SSH_SLOTS_KEY marker) keeps
        // the keys it copied at startup until a resume, even if it has filled slots.
        const live = SSH_SLOTS_KEY in mounted;
        const present = live ? SSH_KEY_SECRET_KEYS.filter((key) => key in mounted) : [];
        // Every ssh:* host shares the keys, so they go only with the last ssh:* host.
        const lastSshHost = !remaining.some((c) => c.startsWith("ssh:"));
        const emptySlots = live && lastSshHost
          ? Object.fromEntries(present.map((key) => [key, ""]))
          : null;
        if (emptySlots) {
          const patched = await client.patch("secrets", ns, name(id), buildSecretKeysPatch(emptySlots));
          if (!patched.ok) return { ok: false, reason: "unavailable", detail: describeError(patched, "secrets") };
        }
        try {
          await updateSessionCapabilities(id, remaining);
        } catch (err) {
          if (emptySlots) {
            const rollback = Object.fromEntries(present.map((key) => [key, Buffer.from(mounted[key] ?? "", "base64").toString("utf8")]));
            const restored = await client.patch("secrets", ns, name(id), buildSecretKeysPatch(rollback));
            if (!restored.ok) {
              log.warn(`[sessions-k8s] Failed to roll back SSH key slots for session ${id} after a database failure: ${describeError(restored, "secrets")}`);
            }
          }
          return { ok: false, reason: "unavailable", detail: `database: ${err}` };
        }
        const entry = entries.get(id);
        if (entry) entry.row.capabilities = JSON.stringify(remaining);
        // Empty slots reach the pod on the same forced re-sync as a grant; a failure leaves them to the kubelet's schedule.
        if (emptySlots) await bumpPodSync(id);
        log.info(`[sessions-k8s] Revoked capability ${capId} from session ${id}${live ? "" : " (effective on resume)"}`);
        return { ok: true, live, keysRemoved: lastSshHost };
      } finally {
        busy.delete(id);
      }
    },

    notifyAgent(id, text): Promise<NotifyAgentResult> {
      return notifyAgentText(id, text);
    },

    notifyAgentOnceReady(id, text): void {
      void (async () => {
        const deadline = now() + RELAUNCH_NOTICE_TIMEOUT_MS;
        for (;;) {
          const ready = await readyEntry(id);
          if (ready.ok) break;
          if (ready.reason === "not-found") return;
          if (now() >= deadline) {
            log.warn(`[sessions-k8s] Gave up telling the agent of session ${id} about its relaunch: the pod was not ready in time`);
            return;
          }
          await sleep(RELAUNCH_NOTICE_POLL_MS);
        }
        // Ready means the terminal is up; give the agent time to load its conversation.
        await sleep(RELAUNCH_NOTICE_SETTLE_MS);
        for (let attempt = 0; ; attempt++) {
          const result = await notifyAgentText(id, text);
          if (result === "ok") {
            log.info(`[sessions-k8s] Told the agent of session ${id} that it was relaunched`);
            return;
          }
          if (result === "unsupported" || attempt >= RELAUNCH_NOTICE_RETRIES) {
            log.warn(`[sessions-k8s] Could not tell the agent of session ${id} that it was relaunched: ${result}`);
            return;
          }
          await sleep(RELAUNCH_NOTICE_POLL_MS);
        }
      })().catch((err) => {
        log.warn(`[sessions-k8s] Telling the agent of session ${id} about its relaunch failed: ${err instanceof Error ? err.message : err}`);
      });
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
          if (ws.readyState !== WebSocket.OPEN) return;
          const text = typeof data === "string" ? data : data.toString("utf8");
          if (relaunching.has(id) && isExitFrame(text)) return;
          ws.send(text);
        });
        up.on("error", (err) => {
          log.debug(`[sessions-k8s] Terminal proxy for ${id}: ${err.message}`);
        });
        up.on("close", (code: number) => {
          upstreamSockets.delete(up);
          if (clientClosed || ws.readyState !== WebSocket.OPEN) return;
          if (relaunching.has(id)) ws.close(1012, "Agent restarting");
          // 1000/1001: the session ended or its pod is shutting down, after an exit frame.
          else if (code === 1000 || code === 1001) ws.close(code, "Session ended");
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
      // End the row now rather than on the next reconcile pass, so the sessions list drops it at
      // once. A busy id (launch, relaunch, End, Delete, prune) is left to reconcile. The pod has
      // already sent its own exit frame to attached terminals, so none is sent here, and the
      // exited pod is deleted by reconcile's next pass.
      let ended = false;
      await whileLocked(id, async () => {
        const current = await getPersistedSession(id);
        if (!current || current.backend !== "k8s-pod" || current.ended_at !== null) return;
        if (!await endExitedRow(current, report.code, "process exited")) return;
        dropEntry(id);
        ended = true;
      });
      if (ended) void pruneHistory().catch((err) => log.warn(`[sessions-k8s] Pruning session history failed: ${err}`));
      return "ok";
    },

    saveUpload: (id, originalName, data) => proxyUpload(id, originalName, data),

    saveUploadStream: (id, originalName, source) => proxyUpload(id, originalName, source),

    fetchFile: (id, podPath) => fetchPodFile(id, podPath),

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
