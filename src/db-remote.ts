import * as db from "./db.js";
import * as diagnosticQueries from "./diagnostic-queries.js";
import * as logCore from "./log-core.js";
import { buildFailureOutcome } from "./outcome.js";
import { sleep } from "./util.js";
import { decodeWire, encodeWire } from "./agent-pod-wire.js";
import type { IssueRef } from "./issue-id.js";

// The agent pod's `db.ts` (#clw_01M386P9KPDEVV33TKY512HHBC). An agent pod
// holds no database credentials: `agent-pod/main.ts` installs a resolve hook
// (`agent-pod/db-redirect.ts`) that points every import of `db.js` here, and
// each function below that the pod's `worker.runRow()` uses becomes one call
// to the service's enumerated ops API (`agent-pod-ops.ts`) instead. Everything
// else is re-exported from the real `db.ts`, whose database is never opened,
// so a function missing here fails with its "Database not initialized" error.
//
// Diagnostics use `log-core.js`, never `log.*`: log.ts calls insertJobLog, so
// a `log.warn` from the job-log drain would feed itself. That is also why
// callAgentPodOp retries in its own loop rather than through retryWithBackoff,
// which logs each retry with `log.warn`.

export * from "./db.js";

export interface RemoteDbConfig {
  /** The service's in-cluster URL (`CLAWS_SESSION_MCP_URL`). */
  baseUrl: string;
  /** The row's per-run bearer token. */
  token: string;
  rowId: number;
  runId: string;
  /** Test seam. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Transient-failure retries; the default spans about five minutes of a service restart. */
  maxRetries?: number;
}

/** The service refused the row's token: the row has ended or been re-queued. */
export class AgentPodOpUnauthorizedError extends Error {
  constructor(op: string) {
    super(`agent pod ops API refused ${op}: this pod's work row is no longer running`);
    this.name = "AgentPodOpUnauthorizedError";
  }
}

/** The service refused the request body as too large (HTTP 413). */
export class AgentPodOpTooLargeError extends Error {
  constructor(op: string) {
    super(`agent pod ops API refused ${op}: request body too large`);
    this.name = "AgentPodOpTooLargeError";
  }
}

/**
 * A failure that never reached an op, so retrying cannot run it twice: the
 * connection was never established, or the service answered 502/503/504.
 * A reset socket is not one — the service may have run the op before losing it.
 */
class AgentPodOpTransientError extends Error {}

const OP_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 8; // 1 s + 2 s + … + 128 s ≈ 4¼ minutes of backoff
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
/** Failures before a connection exists. Not ECONNRESET or UND_ERR_SOCKET, which also fire after the op ran. */
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
]);

let config: RemoteDbConfig | null = null;

/** Point this module at the service's ops API for one row and start the job-log drain. */
export function configureRemoteDb(cfg: RemoteDbConfig): void {
  config = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, "") };
  startJobLogDrain();
}

function connectErrorCode(err: unknown): string | undefined {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code ?? (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Run one op on the service and return its result. */
export async function callAgentPodOp(op: string, args: unknown[]): Promise<unknown> {
  const cfg = config;
  if (!cfg) throw new Error("Database not initialized — agent pod ops API not configured");
  const doFetch = cfg.fetch ?? fetch;
  const url = `${cfg.baseUrl}/agent-pods/${cfg.rowId}/ops/${encodeURIComponent(op)}`;
  const body = encodeWire({ args });
  const attempt = async (): Promise<unknown> => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(cfg.timeoutMs ?? OP_TIMEOUT_MS),
      });
    } catch (err) {
      const code = connectErrorCode(err);
      if (code && CONNECT_ERROR_CODES.has(code)) throw new AgentPodOpTransientError(`${op}: ${code}`);
      // A timeout (or anything else) may have reached the op: not retried.
      throw new Error(`agent pod op ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (res.status === 401) throw new AgentPodOpUnauthorizedError(op);
    if (res.status === 413) throw new AgentPodOpTooLargeError(op);
    if (TRANSIENT_STATUSES.has(res.status)) throw new AgentPodOpTransientError(`${op}: HTTP ${res.status}`);
    if (!res.ok) {
      let message = `agent pod op ${op} failed: HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch { /* keep the status message */ }
      throw new Error(message);
    }
    return (decodeWire(text) as { result?: unknown }).result;
  };
  const maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof AgentPodOpTransientError) || retry >= maxRetries) throw err;
      const delay = 1000 * 2 ** retry; // 1 s, 2 s, 4 s, …
      logCore.warn(`[db-remote] ${err.message} (attempt ${retry + 1}/${maxRetries}), retrying in ${delay / 1000} s`);
      await sleep(delay);
    }
  }
}

function remote<K extends keyof typeof db>(name: K): (typeof db)[K] {
  return ((...args: unknown[]) => callAgentPodOp(name, args)) as unknown as (typeof db)[K];
}

// ── The enumerated ops (agent-pod-ops.ts's AGENT_POD_OPS) ──

export const getWorkRow: typeof db.getWorkRow = remote("getWorkRow");
export const markWorkSucceeded: typeof db.markWorkSucceeded = remote("markWorkSucceeded");
export const markWorkFailed: typeof db.markWorkFailed = remote("markWorkFailed");
export const markWorkSkipped: typeof db.markWorkSkipped = remote("markWorkSkipped");
export const markWorkCancelled: typeof db.markWorkCancelled = remote("markWorkCancelled");
export const setWorkPriority: typeof db.setWorkPriority = remote("setWorkPriority");
export const completeJobRun: typeof db.completeJobRun = remote("completeJobRun");
export const insertJobLogRows: typeof db.insertJobLogRows = remote("insertJobLogRows");
export const recordTaskStart: typeof db.recordTaskStart = remote("recordTaskStart");
export const recordTaskComplete: typeof db.recordTaskComplete = remote("recordTaskComplete");
export const recordTaskFailed: typeof db.recordTaskFailed = remote("recordTaskFailed");
export const updateTaskProvider: typeof db.updateTaskProvider = remote("updateTaskProvider");
export const updateTaskModel: typeof db.updateTaskModel = remote("updateTaskModel");
export const updateTaskWorktree: typeof db.updateTaskWorktree = remote("updateTaskWorktree");
export const updateTaskTokenUsage: typeof db.updateTaskTokenUsage = remote("updateTaskTokenUsage");
export const recordTaskEffectivenessEvent: typeof db.recordTaskEffectivenessEvent = remote("recordTaskEffectivenessEvent");
export const enqueueWork: typeof db.enqueueWork = remote("enqueueWork");
export const countActiveWorkExcludingKinds: typeof db.countActiveWorkExcludingKinds = remote("countActiveWorkExcludingKinds");
export const hasActiveWorkForPR: typeof db.hasActiveWorkForPR = remote("hasActiveWorkForPR");
export const hasPendingIssueRefinerWork: typeof db.hasPendingIssueRefinerWork = remote("hasPendingIssueRefinerWork");
export const getRunningTasks: typeof db.getRunningTasks = remote("getRunningTasks");
export const findLatestCompletedTaskForPrHead: typeof db.findLatestCompletedTaskForPrHead = remote("findLatestCompletedTaskForPrHead");
export const countRecentMemoryLimits: typeof db.countRecentMemoryLimits = remote("countRecentMemoryLimits");
export const countRecentNoCommitCompletions: typeof db.countRecentNoCommitCompletions = remote("countRecentNoCommitCompletions");
export const countRecentTimeouts: typeof db.countRecentTimeouts = remote("countRecentTimeouts");
export const getLastProcessedTimestampsForJob: typeof db.getLastProcessedTimestampsForJob = remote("getLastProcessedTimestampsForJob");
export const markRepoProcessedDaily: typeof db.markRepoProcessedDaily = remote("markRepoProcessedDaily");
export const getActiveWorkflowRuns: typeof db.getActiveWorkflowRuns = remote("getActiveWorkflowRuns");
export const countCIFixerAttempts: typeof db.countCIFixerAttempts = remote("countCIFixerAttempts");
export const countConflictResolutionAttempts: typeof db.countConflictResolutionAttempts = remote("countConflictResolutionAttempts");
export const getCIFixerBreakerState: typeof db.getCIFixerBreakerState = remote("getCIFixerBreakerState");
export const getRecentCIFixerErrors: typeof db.getRecentCIFixerErrors = remote("getRecentCIFixerErrors");
export const hasPreviousCiFixerTasks: typeof db.hasPreviousCiFixerTasks = remote("hasPreviousCiFixerTasks");
export const recordCIFixerBreakerGrant: typeof db.recordCIFixerBreakerGrant = remote("recordCIFixerBreakerGrant");
export const recordCIFixerBreakerTrip: typeof db.recordCIFixerBreakerTrip = remote("recordCIFixerBreakerTrip");
export const recordCIFixerPush: typeof db.recordCIFixerPush = remote("recordCIFixerPush");
export const resetCIFixerBreakerGrants: typeof db.resetCIFixerBreakerGrants = remote("resetCIFixerBreakerGrants");
export const getLatestPRReview: typeof db.getLatestPRReview = remote("getLatestPRReview");
export const recordPRReview: typeof db.recordPRReview = remote("recordPRReview");
export const getClawsPr: typeof db.getClawsPr = remote("getClawsPr");
export const listClawsPrs: typeof db.listClawsPrs = remote("listClawsPrs");
export const listOpenClawsPrsForIssue: typeof db.listOpenClawsPrsForIssue = remote("listOpenClawsPrsForIssue");
export const upsertClawsPr: typeof db.upsertClawsPr = remote("upsertClawsPr");
export const findIssuePlannedPRByNumber: typeof db.findIssuePlannedPRByNumber = remote("findIssuePlannedPRByNumber");
export const createClawsIssue: typeof db.createClawsIssue = remote("createClawsIssue");
export const createShadowIssue: typeof db.createShadowIssue = remote("createShadowIssue");
export const getClawsIssue: typeof db.getClawsIssue = remote("getClawsIssue");
export const listOpenClawsIssues: typeof db.listOpenClawsIssues = remote("listOpenClawsIssues");
export const listClosedClawsIssuesSince: typeof db.listClosedClawsIssuesSince = remote("listClosedClawsIssuesSince");
export const updateClawsIssueTitle: typeof db.updateClawsIssueTitle = remote("updateClawsIssueTitle");
export const updateClawsIssueBody: typeof db.updateClawsIssueBody = remote("updateClawsIssueBody");
export const setClawsIssueState: typeof db.setClawsIssueState = remote("setClawsIssueState");
export const setClawsIssueLifecycle: typeof db.setClawsIssueLifecycle = remote("setClawsIssueLifecycle");
export const setClawsIssueRepos: typeof db.setClawsIssueRepos = remote("setClawsIssueRepos");
export const addClawsIssueLabel: typeof db.addClawsIssueLabel = remote("addClawsIssueLabel");
export const removeClawsIssueLabel: typeof db.removeClawsIssueLabel = remote("removeClawsIssueLabel");
export const addClawsIssueComment: typeof db.addClawsIssueComment = remote("addClawsIssueComment");
export const editClawsIssueComment: typeof db.editClawsIssueComment = remote("editClawsIssueComment");
export const listClawsIssueComments: typeof db.listClawsIssueComments = remote("listClawsIssueComments");
export const addClawsIssueCommentReaction: typeof db.addClawsIssueCommentReaction = remote("addClawsIssueCommentReaction");
export const listClawsIssueCommentReactions: typeof db.listClawsIssueCommentReactions = remote("listClawsIssueCommentReactions");
export const listClawsIssuePlans: typeof db.listClawsIssuePlans = remote("listClawsIssuePlans");
export const listLatestClawsIssuePlansForOpenIssues: typeof db.listLatestClawsIssuePlansForOpenIssues = remote("listLatestClawsIssuePlansForOpenIssues");
export const addClawsIssueRequirementsVersion: typeof db.addClawsIssueRequirementsVersion = remote("addClawsIssueRequirementsVersion");
export const listClawsIssueRequirements: typeof db.listClawsIssueRequirements = remote("listClawsIssueRequirements");
export const listLatestClawsIssueRequirementsForOpenIssues: typeof db.listLatestClawsIssueRequirementsForOpenIssues = remote("listLatestClawsIssueRequirementsForOpenIssues");
export const listApprovedClawsIssueRequirementsForOpenIssues: typeof db.listApprovedClawsIssueRequirementsForOpenIssues = remote("listApprovedClawsIssueRequirementsForOpenIssues");
export const approveClawsIssueRequirements: typeof db.approveClawsIssueRequirements = remote("approveClawsIssueRequirements");
export const insertClawsIssueAttachment: typeof db.insertClawsIssueAttachment = remote("insertClawsIssueAttachment");
export const getClawsIssueAttachment: typeof db.getClawsIssueAttachment = remote("getClawsIssueAttachment");
export const listClawsIssueAttachments: typeof db.listClawsIssueAttachments = remote("listClawsIssueAttachments");
export const claimPendingClawsIssueAttachments: typeof db.claimPendingClawsIssueAttachments = remote("claimPendingClawsIssueAttachments");
export const listPendingClawsIssueAttachmentsOlderThan: typeof db.listPendingClawsIssueAttachmentsOlderThan = remote("listPendingClawsIssueAttachmentsOlderThan");
export const setClawsIssueAttachmentComment: typeof db.setClawsIssueAttachmentComment = remote("setClawsIssueAttachmentComment");
export const setClawsIssueAttachmentStoredPath: typeof db.setClawsIssueAttachmentStoredPath = remote("setClawsIssueAttachmentStoredPath");
export const deleteClawsIssueAttachment: typeof db.deleteClawsIssueAttachment = remote("deleteClawsIssueAttachment");
export const createClawsIssueLink: typeof db.createClawsIssueLink = remote("createClawsIssueLink");
export const getClawsIssueLink: typeof db.getClawsIssueLink = remote("getClawsIssueLink");
export const listClawsIssueLinks: typeof db.listClawsIssueLinks = remote("listClawsIssueLinks");
export const deleteClawsIssueLink: typeof db.deleteClawsIssueLink = remote("deleteClawsIssueLink");
export const listDependencyReleasableIssues: typeof db.listDependencyReleasableIssues = remote("listDependencyReleasableIssues");
export const listOpenDependencyTargets: typeof db.listOpenDependencyTargets = remote("listOpenDependencyTargets");
export const markClawsIssueLinksReleased: typeof db.markClawsIssueLinksReleased = remote("markClawsIssueLinksReleased");
export const getIssuePlannedPRs: typeof db.getIssuePlannedPRs = remote("getIssuePlannedPRs");
export const replaceIssuePlannedPRs: typeof db.replaceIssuePlannedPRs = remote("replaceIssuePlannedPRs");
export const linkIssuePlannedPR: typeof db.linkIssuePlannedPR = remote("linkIssuePlannedPR");
export const unlinkIssuePlannedPR: typeof db.unlinkIssuePlannedPR = remote("unlinkIssuePlannedPR");
export const listImportedIssues: typeof db.listImportedIssues = remote("listImportedIssues");
export const recordImportedIssue: typeof db.recordImportedIssue = remote("recordImportedIssue");
export const getLinkedNativeId: typeof db.getLinkedNativeId = remote("getLinkedNativeId");
export const getIssueModelPlanRows: typeof db.getIssueModelPlanRows = remote("getIssueModelPlanRows");
export const upsertIssueModelPlanCell: typeof db.upsertIssueModelPlanCell = remote("upsertIssueModelPlanCell");
export const deleteIssueModelPlanCell: typeof db.deleteIssueModelPlanCell = remote("deleteIssueModelPlanCell");
export const deleteIssueModelPlanRowsExceptRepo: typeof db.deleteIssueModelPlanRowsExceptRepo = remote("deleteIssueModelPlanRowsExceptRepo");

// ── Pod-local replacements (function declarations: hoisted, so safe inside the log.js ↔ db.js cycle) ──

/** An agent pod never opens the database. */
export async function initDb(): Promise<void> {
  throw new Error("agent pod has no database — its db.ts calls go through the agent-pod ops API");
}

/** {@link db.withTaskRecording} over the recordTaskStart / recordTaskFailed ops: its callback cannot cross the wire. */
export async function withTaskRecording<T>(
  jobName: string,
  repo: string,
  itemNumber: IssueRef,
  triggerLabel: string | null,
  fn: (taskId: number) => Promise<T>,
): Promise<T> {
  const taskId = await recordTaskStart(jobName, repo, itemNumber, triggerLabel);
  try {
    return await fn(taskId);
  } catch (err) {
    await recordTaskFailed(taskId, String(err), buildFailureOutcome(err));
    throw err;
  }
}

/**
 * {@link db.trackTaskTokens} over the updateTaskTokenUsage / updateTaskProvider
 * ops. The writes are chained so the last one still wins over HTTP.
 */
export function trackTaskTokens(taskId: number): (tokensUsed: number, costUsd: number, provider?: string) => void {
  let tokens = 0;
  let cost = 0;
  let lastProvider: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (what: string, write: () => Promise<void>) => {
    chain = chain.then(write).catch((err: unknown) => {
      logCore.warn(`[db-remote] trackTaskTokens(${taskId}) ${what} write failed: ${err}`);
    });
  };
  return (t, c, provider) => {
    tokens += t;
    cost += c;
    const [tokensNow, costNow] = [tokens, cost];
    enqueue("usage", () => updateTaskTokenUsage(taskId, tokensNow, costNow));
    if (provider && provider !== lastProvider) {
      lastProvider = provider;
      enqueue("provider", () => updateTaskProvider(taskId, provider));
    }
  };
}

/**
 * {@link db.remoteAttachmentReader} for an agent pod: the bytes stream from the
 * service's `GET /agent-pods/:rowId/attachments/:attachmentId`, never through
 * the JSON ops API. Null until {@link configureRemoteDb} has run.
 */
export function remoteAttachmentReader(): ((attachmentId: string, signal?: AbortSignal) => Promise<Response>) | null {
  const cfg = config;
  if (!cfg) return null;
  const doFetch = cfg.fetch ?? fetch;
  return (attachmentId, signal) =>
    doFetch(`${cfg.baseUrl}/agent-pods/${cfg.rowId}/attachments/${encodeURIComponent(attachmentId)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: signal ?? AbortSignal.timeout(cfg.timeoutMs ?? OP_TIMEOUT_MS),
    });
}

// ── Job logs: buffered here, shipped in batches through insertJobLogRows ──

/** Same bound as db.ts's buffer. */
const JOB_LOG_BUFFER_LIMIT = 10_000;
const JOB_LOG_BATCH_SIZE = 500;
/** Encoded bytes per batch, under server.ts's 4 MiB AGENT_POD_OPS_MAX_BYTES. */
const JOB_LOG_BATCH_BYTES = 3 * 1024 * 1024;
const JOB_LOG_DRAIN_MS = 1_000;

const jobLogBuffer: db.JobLogRowInput[] = [];
let jobLogsDropped = 0;
let jobLogDrainTimer: NodeJS.Timeout | null = null;
let jobLogDrainInFlight: Promise<boolean> | null = null;

/**
 * Buffers one job log line for the pod's run. Synchronous like db.ts's: every
 * `log.*` call funnels through here. `runId` is ignored — a pod logs only
 * under its row's run, which the service enforces anyway.
 */
export function insertJobLog(_runId: string, level: string, message: string, reason?: diagnosticQueries.DiagnosticReason, context?: diagnosticQueries.DiagnosticContext): void {
  if (jobLogBuffer.length >= JOB_LOG_BUFFER_LIMIT) {
    jobLogBuffer.shift();
    jobLogsDropped++;
    if (jobLogsDropped % 1_000 === 1) {
      logCore.warn(`[db-remote] job_logs buffer full — dropped ${jobLogsDropped} log lines`);
    }
  }
  jobLogBuffer.push({
    diagnosticContext: JSON.stringify(diagnosticQueries.diagnosticContext(context)),
    diagnosticReason: diagnosticQueries.diagnosticReason(reason)?.code ?? null,
    level,
    message: db.capJobLogMessage(message),
    loggedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
  });
}

/**
 * Takes the next batch off the buffer: up to JOB_LOG_BATCH_SIZE lines and
 * JOB_LOG_BATCH_BYTES of encoded JSON, and always at least one line (each
 * message is capped by capJobLogMessage, so one line fits).
 */
function takeJobLogBatch(): db.JobLogRowInput[] {
  let count = 0;
  let bytes = 0;
  while (count < jobLogBuffer.length && count < JOB_LOG_BATCH_SIZE) {
    const size = Buffer.byteLength(encodeWire(jobLogBuffer[count])) + 1;
    if (count > 0 && bytes + size > JOB_LOG_BATCH_BYTES) break;
    bytes += size;
    count++;
  }
  return jobLogBuffer.splice(0, count);
}

/**
 * Ships one batch, halving it on a 413 until each part fits; a single line
 * that is still too large is dropped and counted. Returns false when there was
 * nothing to ship or it failed.
 */
async function drainJobLogBatch(): Promise<boolean> {
  const cfg = config;
  if (jobLogBuffer.length === 0 || !cfg) return false;
  const pending = [takeJobLogBatch()];
  try {
    while (pending.length > 0) {
      const rows = pending[0]!;
      try {
        await insertJobLogRows(cfg.runId, rows);
        pending.shift();
      } catch (err) {
        if (!(err instanceof AgentPodOpTooLargeError)) throw err;
        pending.shift();
        if (rows.length === 1) {
          jobLogsDropped++;
          logCore.warn(`[db-remote] dropped a job log line too large for the ops API (${jobLogsDropped} dropped so far)`);
        } else {
          const mid = Math.ceil(rows.length / 2);
          pending.unshift(rows.slice(0, mid), rows.slice(mid));
        }
      }
    }
  } catch (err) {
    const batch = pending.flat();
    logCore.error(`[db-remote] job_logs insert failed: ${err instanceof Error ? err.message : String(err)}`);
    // The token is dead: nothing buffered can ever be written.
    if (err instanceof AgentPodOpUnauthorizedError) {
      jobLogBuffer.length = 0;
      return false;
    }
    const room = JOB_LOG_BUFFER_LIMIT - jobLogBuffer.length;
    if (room > 0) jobLogBuffer.unshift(...batch.slice(0, room));
    return false;
  }
  return true;
}

/** One drain at a time, shared by the timer and flushes, so batches stay in order. */
function drainOnce(): Promise<boolean> {
  if (!jobLogDrainInFlight) {
    jobLogDrainInFlight = drainJobLogBatch().finally(() => {
      jobLogDrainInFlight = null;
    });
  }
  return jobLogDrainInFlight;
}

function startJobLogDrain(): void {
  if (jobLogDrainTimer) return;
  jobLogDrainTimer = setInterval(() => {
    if (!jobLogDrainInFlight) void drainOnce();
  }, JOB_LOG_DRAIN_MS);
  jobLogDrainTimer.unref();
}

/** Ships every buffered log line. */
export async function flushJobLogs(): Promise<void> {
  if (jobLogDrainInFlight) await jobLogDrainInFlight;
  while (await drainOnce());
}

/** Stops the drain and ships what is left; the pod has no database to close. */
export async function closeDb(): Promise<void> {
  if (jobLogDrainTimer) {
    clearInterval(jobLogDrainTimer);
    jobLogDrainTimer = null;
  }
  await flushJobLogs();
}

/** @internal — tests only. */
export function _resetRemoteDbForTests(): void {
  if (jobLogDrainTimer) clearInterval(jobLogDrainTimer);
  jobLogDrainTimer = null;
  jobLogDrainInFlight = null;
  jobLogBuffer.length = 0;
  jobLogsDropped = 0;
  config = null;
}
