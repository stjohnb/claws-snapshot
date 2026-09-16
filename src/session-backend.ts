import type { Readable } from "node:stream";
import type { WebSocket } from "ws";
import type { CreateSessionError, SessionAgentStatus, SessionMode, SessionProvider } from "./sessions.js";
import type { SaveUploadResult } from "./session-uploads-core.js";
import { SESSION_BACKEND } from "./config.js";
import { localSessionBackend } from "./session-backend-local.js";
import { getK8sSessionBackend } from "./session-backend-k8s.js";

/**
 * The boundary between the dashboard's session routes and whatever actually
 * runs interactive sessions (#3026). `server.ts` and `main.ts` talk only to
 * this interface: `local-tmux` (host tmux via `sessions.ts`, the default) or
 * `k8s-pod` (one Kubernetes Pod per session, `session-backend-k8s.ts`),
 * chosen by `CLAWS_SESSION_BACKEND`.
 *
 * Lookups distinguish `not-found` (no such live session — safe to 404) from
 * `unavailable` (the runtime could not answer — 503, and never a reason to
 * write to the DB or delete anything).
 */

export type SessionBackendKind = "local-tmux" | "k8s-pod";

/** Outcome of create / createMulti / resume. */
export type SessionStartResult =
  | { ok: true; id: string }
  | { ok: false; reason: CreateSessionError; detail?: string };

export type SessionLookupFailure = { ok: false; reason: "not-found" | "unavailable"; detail?: string };

/** Outcome of end / remove / checkAttach. */
export type SessionOpResult = { ok: true } | SessionLookupFailure;

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
  endedAt: number | null;
  capabilities: string[];
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
  /** Granted capability ids, as persisted on the session row. */
  capabilities: string[];
}

/**
 * How a granted capability reaches the running session. `live` is false when
 * it takes effect only on the next resume. `loadPath` is the file to source for
 * its vars, or null when there is none (or they were injected at launch).
 * `marker` is the exact line `loadPath` carries once it holds the grant (null
 * with `loadPath`). `delayed` is true when `loadPath` updates eventually rather
 * than before the grant returns (a pod's mounted Secret): check for `marker`
 * before sourcing it.
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

export type SessionUploadResult =
  | SaveUploadResult
  | { ok: false; reason: "not-found" | "not-running" | "unavailable"; detail?: string };

export interface CreateSessionRequest {
  repo: string | null;
  mode: SessionMode;
  capabilities: string[];
  provider: SessionProvider;
  model: string | null;
}

export interface CreateMultiSessionRequest {
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
   * Check a per-session bearer token for the in-service `claws-state` MCP
   * endpoint (`/mcp/sessions/:id`, #3056). `denied` for a wrong token or a
   * session that is not live on this backend; `unavailable` only when the
   * runtime could not answer. Backends without per-session tokens omit it,
   * and the endpoint then rejects every request.
   */
  verifyMcpToken?(id: string, token: string): Promise<"ok" | "denied" | "unavailable">;
}

let testOverride: SessionBackend | null = null;

function configuredBackendKind(): SessionBackendKind {
  try {
    return SESSION_BACKEND;
  } catch {
    // A test's partial config.js mock without the setting.
    return "local-tmux";
  }
}

/** The active session backend: `CLAWS_SESSION_BACKEND` (default `local-tmux`), unless a test swapped it. */
export function getSessionBackend(): SessionBackend {
  if (testOverride) return testOverride;
  return configuredBackendKind() === "k8s-pod" ? getK8sSessionBackend() : localSessionBackend;
}

/** Replace the active backend in tests; pass null to restore the default. */
export function setSessionBackendForTests(backend: SessionBackend | null): void {
  testOverride = backend;
}
