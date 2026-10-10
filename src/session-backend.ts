import type { Readable } from "node:stream";
import type { WebSocket } from "ws";
import type { CreateSessionError, SessionAgentStatus, SessionMode, SessionProvider } from "./sessions.js";
import type { SaveUploadResult } from "./session-uploads-core.js";
import type { SessionUsageWarningLevel } from "./session-usage.js";
import { getK8sSessionBackend } from "./session-backend-k8s.js";

/**
 * The boundary between the dashboard's session routes and whatever actually
 * runs interactive sessions (#3026). `server.ts` and `main.ts` talk only to
 * this interface, implemented by `k8s-pod` (one Kubernetes Pod per session,
 * `session-backend-k8s.ts`) — the only session runtime. The host tmux backend
 * (`local-tmux`) was removed; its ended rows stay in history only.
 *
 * Lookups distinguish `not-found` (no such live session — safe to 404) from
 * `unavailable` (the runtime could not answer — 503, and never a reason to
 * write to the DB or delete anything).
 */

export type SessionBackendKind = "k8s-pod";

/** Outcome of create / createMulti / resume. */
export type SessionStartResult =
  | { ok: true; id: string }
  | { ok: false; reason: CreateSessionError; detail?: string };

export type SessionLookupFailure = { ok: false; reason: "not-found" | "unavailable"; detail?: string };

/** Outcome of end / remove / checkAttach. */
export type SessionOpResult = { ok: true } | SessionLookupFailure;

export type SessionStartupState = "preparing" | "creating" | "pending" | "running" | "ready" | "failed" | "ended" | "unknown";

export interface SessionStartupStatus {
  state: SessionStartupState;
  step: string;
  detail: string | null;
  startedAt: number | null;
  elapsedMs: number;
  terminalReadyAt?: number | null;
  failureReason?: string | null;
}

export type SessionStartupStatusResult = { ok: true; status: SessionStartupStatus } | SessionLookupFailure;

/** One row of the live half of the `/sessions` list. */
export interface LiveSessionListEntry {
  id: string;
  repo: string | null;
  extraRepos: string[];
  cwd: string;
  mode: SessionMode;
  provider: SessionProvider;
  model: string | null;
  createdAt: number;
  alive: boolean;
  resumable: boolean;
  wsConnected: boolean;
  summary: string | null;
  summaryUpdatedAt: number | null;
  agentStatus: SessionAgentStatus | null;
  agentStatusUpdatedAt: number | null;
  startupStatus?: SessionStartupStatus | null;
  endedAt: number | null;
  capabilities: string[];
  tokensUsed: number | null;
  costUsd: number | null;
  lastContextTokens: number | null;
  usageUpdatedAt: number | null;
  usageWarningLevel: SessionUsageWarningLevel | null;
  /** Exit code of an ended session's process (#3311); null while live or when unknown. */
  exitCode: number | null;
}

/** What the terminal page and upload routes need to know about one live session. */
export interface LiveSessionDetail {
  id: string;
  repo: string | null;
  cwd: string;
  mode: SessionMode;
  provider: SessionProvider;
  model: string | null;
  alive: boolean;
  summary: string | null;
  /** Repos beyond the primary `repo`, in order. */
  extraRepos: string[];
  /** Granted capability ids, as persisted on the session row. */
  capabilities: string[];
}

/**
 * How a granted capability reaches the running session. `live` is false when
 * it takes effect only on the next resume. `delayed` is true when the mounted
 * delivery may lag the grant (a pod's mounted Secret). With `loadPath` set,
 * that delivery is the `granted-env` file to source for its vars — check for
 * `marker` (the exact line it carries once it holds the grant) before sourcing
 * it. With `loadPath` null, there are no vars to source: either they were
 * injected at launch, or (github-auth) the credential is a mounted file read
 * directly by `gh`/git rather than sourced, in which case `marker` is also
 * null and a failing `gh`/`git` call should be retried after a short wait.
 */
export interface GrantDelivery {
  live: boolean;
  loadPath: string | null;
  marker: string | null;
  delayed: boolean;
}

/** Outcome of `grantCapability`. */
export type GrantCapabilityResult =
  | ({ ok: true } & GrantDelivery)
  | SessionLookupFailure
  | { ok: false; reason: "invalid"; detail: string };

/** Outcome of `grantDelivery`. */
export type GrantDeliveryResult = ({ ok: true } & GrantDelivery) | SessionLookupFailure;

/**
 * Outcome of `revokeCapability`. `live` is false when the running session
 * keeps the capability until it is ended and resumed (a pod launched before
 * the SSH slot poller existed). `keysRemoved` is true only when the session loses
 * the shared SSH keys (now when `live`, else on resume) — every `ssh:*` host
 * shares them, so they stay until the last `ssh:*` host is revoked.
 */
export type RevokeCapabilityResult =
  | { ok: true; live: boolean; keysRemoved: boolean }
  | SessionLookupFailure
  | { ok: false; reason: "invalid"; detail: string };

export type SessionUploadResult =
  | SaveUploadResult
  | { ok: false; reason: "not-found" | "not-running" | "unavailable"; detail?: string };

/**
 * Set only when another session starts this one (`claws_start_session`,
 * docs/product/interactive-sessions.md): `brief` is persisted on the row and
 * appended to the session prompt on create and every resume; the other two
 * are audit-only strings, never a live link to the starting session.
 */
export interface SpawnedSessionFields {
  brief?: string | null;
  /** Id of the session that started this one. */
  spawnedBySession?: string | null;
  /** Canonical `clw_…` id of the issue it was started for. */
  spawnedForIssue?: string | null;
}

export interface CreateSessionRequest extends SpawnedSessionFields {
  repo: string | null;
  mode: SessionMode;
  capabilities: string[];
  provider: SessionProvider;
  model: string | null;
}

export interface CreateMultiSessionRequest extends SpawnedSessionFields {
  repos: string[];
  capabilities: string[];
  provider: SessionProvider;
  model: string | null;
}

export interface SessionBackend {
  readonly kind: SessionBackendKind;
  /** Called once at service startup (recovery / reconcile loops). */
  start(): Promise<void>;
  /** Called when the HTTP server closes. Must leave running sessions alive. */
  shutdown(): Promise<void>;
  create(req: CreateSessionRequest): Promise<SessionStartResult>;
  createMulti(req: CreateMultiSessionRequest): Promise<SessionStartResult>;
  resume(id: string): Promise<SessionStartResult>;
  /** End a live session, moving it to history. */
  end(id: string): Promise<SessionOpResult>;
  /** Permanently remove a session (live or ended) and its history row. */
  remove(id: string): Promise<SessionOpResult>;
  listLive(): Promise<LiveSessionListEntry[]>;
  getLive(id: string): Promise<{ ok: true; session: LiveSessionDetail } | SessionLookupFailure>;
  /** User-facing session startup progress. */
  getStartupStatus(id: string): Promise<SessionStartupStatusResult>;
  /** Pre-handshake check for the terminal WebSocket, so the client gets a real HTTP status. */
  checkAttach(id: string): Promise<SessionOpResult>;
  /** Bridge an accepted terminal WebSocket to the session. */
  attach(id: string, ws: WebSocket): void;
  saveUpload(id: string, originalName: string, data: Buffer): Promise<SessionUploadResult>;
  saveUploadStream(id: string, originalName: string, source: Readable): Promise<SessionUploadResult>;
  setDescription(id: string, description: string): Promise<{ ok: boolean; description: string | null }>;
  resummarize(id: string): Promise<{ ok: boolean; description: string | null }>;
  /** Record the agent's self-reported status (#3083); `ok` is false for an unknown or ended session. */
  setAgentStatus(id: string, status: SessionAgentStatus): Promise<{ ok: boolean; status: SessionAgentStatus; updatedAt: number }>;
  /**
   * Grant one more capability to a live session without restarting it (#3072).
   * The grant is persisted on the row, so a resume injects it at start. `live`
   * is false when the running session cannot receive it (a pod launched before
   * #3072): it takes effect on the next resume. `invalid` when the capability
   * is not live-grantable for this session.
   */
  grantCapability(id: string, capId: string): Promise<GrantCapabilityResult>;
  /**
   * How a capability the live session already holds is delivered now (#3072),
   * read from the runtime rather than remembered from the grant, so it stays
   * right across a Claws restart and a resume: the granted env file when it
   * carries the capability's marker, otherwise nothing to load (injected at
   * launch). The caller has checked the session holds `capId`.
   */
  grantDelivery(id: string, capId: string): Promise<GrantDeliveryResult>;
  /**
   * Remove a granted capability from a live session without restarting it.
   * Only `ssh:*` is revocable today: revoking the last `ssh:*` host drops the
   * shared SSH keys from the session. `invalid` when the capability is not
   * revocable or not held.
   */
  revokeCapability(id: string, capId: string): Promise<RevokeCapabilityResult>;
  /**
   * Check a per-session bearer token for the in-service `claws-state` MCP
   * endpoint (`/mcp/sessions/:id`, #3056). `denied` for a wrong token or a
   * session that is not live on this backend; `unavailable` only when the
   * runtime could not answer. Backends without per-session tokens omit it,
   * and the endpoint then rejects every request.
   */
  verifyMcpToken?(id: string, token: string): Promise<"ok" | "denied" | "unavailable">;
  /**
   * Record the exit code and final output a session pod reports as its process
   * exits (`POST /session-pods/:id/exit`, #3311), authenticated by the
   * session's terminal token. Writes only `exit_code` / `last_output`; ending
   * the row stays with reconcile. `denied` for a wrong token or a session that
   * is not an open pod session; `unavailable` when the token could not be read.
   */
  recordPodExit(id: string, token: string, report: { code: number; scrollback: string }): Promise<"ok" | "denied" | "unavailable">;
}

let testOverride: SessionBackend | null = null;

/** The active session backend: the Kubernetes pod backend, unless a test swapped it. */
export function getSessionBackend(): SessionBackend {
  return testOverride ?? getK8sSessionBackend();
}

/** Replace the active backend in tests; pass null to restore the default. */
export function setSessionBackendForTests(backend: SessionBackend | null): void {
  testOverride = backend;
}
