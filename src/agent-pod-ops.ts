import * as db from "./db.js";
import { withRunContext } from "./log.js";
import { workRunContextFields } from "./worker.js";

// The enumerated agent-pod ops API (#clw_01M386P9KPDEVV33TKY512HHBC), served
// at `POST /agent-pods/:rowId/ops/:op` by `server.ts`. An agent pod
// (`CLAWS_WORK_BACKEND=k8s-pod`) holds no database credentials: every
// `db.ts` call its `worker.runRow()` makes goes through `db-remote.ts` to one
// of the named ops below, authenticated by the row's per-run token. No SQL
// crosses the wire, only an op name from this registry and its JSON args.
//
// The registry is every `db.*` function reachable from `work-handlers.ts`,
// `worker.ts` and `agent-pod/run.ts`, minus AGENT_POD_OP_EXCLUSIONS;
// `agent-pod-ops.test.ts` fails when a handler starts calling one that is in
// neither list.

/**
 * What an op's first argument must name for the calling pod's row:
 * - `row`: the row id itself;
 * - `run`: the row's run id;
 * - `task`: a task recorded under the row's run id;
 * - `none`: keyed by repo, PR or native issue — allow-listed, not further restricted.
 */
export type AgentPodOpScope = "row" | "run" | "task" | "none";

export interface AgentPodOp {
  fn: (...args: never[]) => Promise<unknown>;
  scope: AgentPodOpScope;
}

/**
 * `db.ts` functions reachable from the agent-pod runtime that are never
 * registered: service-only (claiming, the launcher's bookkeeping) or
 * reimplemented pod-side in `db-remote.ts` over the registered ops.
 */
export const AGENT_POD_OP_EXCLUSIONS: ReadonlySet<string> = new Set([
  // Pod-local in db-remote.ts.
  "initDb", "closeDb", "setRunIdProvider", "setRequirementsVersionListener", "withTaskRecording", "insertJobLog", "flushJobLogs", "trackTaskTokens",
  "remoteAttachmentReader",
  // The worker fiber's claim loop, which a pod never runs.
  "claimNextWork", "releaseClaimedWork", "insertJobRun", "listPodBackedRunningWork", "countWorkByStatus",
  // runRow() only calls this behind `opts.priorityOnly`, which agent-pod/run.ts
  // never sets when it calls runRow() — textually reachable, never invoked by a pod.
  "releaseClaimedWorkById",
  // The service's agent-pod launcher and API auth.
  "setWorkAgentMcpToken", "setWorkAgentPod", "markWorkFailedIfRunning", "markWorkCancelledIfRunning",
  "cancelJobRunIfRunning", "getJobRun", "getTasksByRunId", "isRunningAgentPodMcpToken",
  // Interactive sessions (sessions.ts, session-backend-k8s.ts): imported along
  // the runtime's module graph, never called by runRow.
  "insertSession", "getAllPersistedSessions", "deletePersistedSession", "updateSessionSummary",
  "setManualSessionSummary", "setSessionAgentStatus", "getEndedSessions", "getPersistedSession",
  "markSessionEnded", "clearSessionEnded", "pruneEndedSessions", "recordSessionExit",
  "updateSessionCapabilities", "updateSessionUsage", "deleteEndedPersistedSession",
  "getPrunableEndedSessionIds", "updateSessionStartup",
  // Promotion and the board's shadow read (claws-issues.ts): imported along the
  // runtime's module graph, but run by the dashboard and by the requirements
  // version listener, both service-side.
  "listOpenShadowStages", "promoteClawsIssue", "demoteClawsIssue", "setShadowLifecycle", "getImportedIssueByNative", "skipQueuedWorkForItem",
  "skipQueuedPlannerWork",
]);

/** Row-scoped ops a pod may still call once its row has left `running`. */
const POST_TERMINAL_ROW_OPS: ReadonlySet<string> = new Set(["getWorkRow"]);

/**
 * How long after its row reaches a terminal status a pod's token still works:
 * `runRow` marks the row before it completes the run, handles timeouts and
 * reports errors, and the pod flushes its job logs on exit. The launcher
 * deletes a finished row's pod well within this.
 */
export const AGENT_POD_OPS_GRACE_MS = 10 * 60 * 1000;

/**
 * Row-scoped writes, run server-side as one `WHERE id = ? AND status = 'running'
 * AND run_id = ?` statement instead of the registered unguarded function, so
 * a row the launcher ended after the route read it stays ended. Each resolves
 * false when no row changed.
 */
const GUARDED_ROW_WRITES: ReadonlyMap<string, (runId: string, args: unknown[]) => Promise<boolean>> = new Map([
  ["markWorkSucceeded", (runId, [id]) => db.markWorkSucceededIfRunning(id as number, runId)],
  ["markWorkFailed", (runId, [id, message]) => db.markWorkFailedIfRunning(id as number, runId, message as string)],
  ["markWorkSkipped", (runId, [id, reason]) => db.markWorkSkippedIfRunning(id as number, runId, reason as string)],
  ["markWorkCancelled", (runId, [id, reason]) => db.markWorkCancelledIfRunning(id as number, runId, reason as string)],
  ["setWorkPriority", (runId, [id, priority]) => db.setWorkPriorityIfRunning(id as number, runId, priority as boolean)],
]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

function op(fn: AgentPodOp["fn"], scope: AgentPodOpScope = "none"): AgentPodOp {
  return { fn, scope };
}

export const AGENT_POD_OPS: ReadonlyMap<string, AgentPodOp> = new Map<string, AgentPodOp>([
  // Work queue: the pod's own row.
  ["getWorkRow", op(db.getWorkRow, "row")],
  ["markWorkSucceeded", op(db.markWorkSucceeded, "row")],
  ["markWorkFailed", op(db.markWorkFailed, "row")],
  ["markWorkSkipped", op(db.markWorkSkipped, "row")],
  ["markWorkCancelled", op(db.markWorkCancelled, "row")],
  ["setWorkPriority", op(db.setWorkPriority, "row")],
  // Job run and logs: the row's run.
  ["completeJobRun", op(db.completeJobRun, "run")],
  ["insertJobLogRows", op(db.insertJobLogRows, "run")],
  // Tasks: recorded under the row's run (recordTaskStart stamps it from the run context).
  ["recordTaskStart", op(db.recordTaskStart)],
  ["recordTaskComplete", op(db.recordTaskComplete, "task")],
  ["recordTaskFailed", op(db.recordTaskFailed, "task")],
  ["updateTaskProvider", op(db.updateTaskProvider, "task")],
  ["updateTaskModel", op(db.updateTaskModel, "task")],
  ["updateTaskWorktree", op(db.updateTaskWorktree, "task")],
  ["updateTaskTokenUsage", op(db.updateTaskTokenUsage, "task")],
  ["recordTaskEffectivenessEvent", op(db.recordTaskEffectivenessEvent)],
  // Work queue: reads and enqueues other handlers make.
  ["enqueueWork", op(db.enqueueWork)],
  ["countActiveWorkExcludingKinds", op(db.countActiveWorkExcludingKinds)],
  ["hasActiveWorkForPR", op(db.hasActiveWorkForPR)],
  ["hasPendingIssueRefinerWork", op(db.hasPendingIssueRefinerWork)],
  ["getRunningTasks", op(db.getRunningTasks)],
  ["findLatestCompletedTaskForPrHead", op(db.findLatestCompletedTaskForPrHead)],
  ["countRecentMemoryLimits", op(db.countRecentMemoryLimits)],
  ["countRecentNoCommitCompletions", op(db.countRecentNoCommitCompletions)],
  ["countRecentTimeouts", op(db.countRecentTimeouts)],
  ["getLastProcessedTimestampsForJob", op(db.getLastProcessedTimestampsForJob)],
  ["markRepoProcessedDaily", op(db.markRepoProcessedDaily)],
  ["getActiveWorkflowRuns", op(db.getActiveWorkflowRuns)],
  // CI fixer, conflict resolution and PR reviews.
  ["countCIFixerAttempts", op(db.countCIFixerAttempts)],
  ["countConflictResolutionAttempts", op(db.countConflictResolutionAttempts)],
  ["getCIFixerBreakerState", op(db.getCIFixerBreakerState)],
  ["getRecentCIFixerErrors", op(db.getRecentCIFixerErrors)],
  ["hasPreviousCiFixerTasks", op(db.hasPreviousCiFixerTasks)],
  ["recordCIFixerBreakerGrant", op(db.recordCIFixerBreakerGrant)],
  ["recordCIFixerBreakerTrip", op(db.recordCIFixerBreakerTrip)],
  ["recordCIFixerPush", op(db.recordCIFixerPush)],
  ["resetCIFixerBreakerGrants", op(db.resetCIFixerBreakerGrants)],
  ["getLatestPRReview", op(db.getLatestPRReview)],
  ["recordPRReview", op(db.recordPRReview)],
  // PR state store (`claws_prs`): the github.ts label hook runs in pods too.
  ["getClawsPr", op(db.getClawsPr)],
  ["listClawsPrs", op(db.listClawsPrs)],
  ["listOpenClawsPrsForIssue", op(db.listOpenClawsPrsForIssue)],
  ["upsertClawsPr", op(db.upsertClawsPr)],
  ["findIssuePlannedPRByNumber", op(db.findIssuePlannedPRByNumber)],
  // Native issue tracker.
  ["createClawsIssue", op(db.createClawsIssue)],
  ["createShadowIssue", op(db.createShadowIssue)],
  ["getClawsIssue", op(db.getClawsIssue)],
  ["listOpenClawsIssues", op(db.listOpenClawsIssues)],
  ["listClosedClawsIssuesSince", op(db.listClosedClawsIssuesSince)],
  ["updateClawsIssueTitle", op(db.updateClawsIssueTitle)],
  ["updateClawsIssueBody", op(db.updateClawsIssueBody)],
  ["setClawsIssueState", op(db.setClawsIssueState)],
  ["setClawsIssueLifecycle", op(db.setClawsIssueLifecycle)],
  ["setClawsIssueRepos", op(db.setClawsIssueRepos)],
  ["addClawsIssueLabel", op(db.addClawsIssueLabel)],
  ["removeClawsIssueLabel", op(db.removeClawsIssueLabel)],
  ["addClawsIssueComment", op(db.addClawsIssueComment)],
  ["editClawsIssueComment", op(db.editClawsIssueComment)],
  ["listClawsIssueComments", op(db.listClawsIssueComments)],
  ["addClawsIssueCommentReaction", op(db.addClawsIssueCommentReaction)],
  ["listClawsIssueCommentReactions", op(db.listClawsIssueCommentReactions)],
  ["listClawsIssuePlans", op(db.listClawsIssuePlans)],
  ["listLatestClawsIssuePlansForOpenIssues", op(db.listLatestClawsIssuePlansForOpenIssues)],
  ["addClawsIssueRequirementsVersion", op(db.addClawsIssueRequirementsVersion)],
  ["listClawsIssueRequirements", op(db.listClawsIssueRequirements)],
  ["listLatestClawsIssueRequirementsForOpenIssues", op(db.listLatestClawsIssueRequirementsForOpenIssues)],
  ["listApprovedClawsIssueRequirementsForOpenIssues", op(db.listApprovedClawsIssueRequirementsForOpenIssues)],
  ["approveClawsIssueRequirements", op(db.approveClawsIssueRequirements)],
  ["insertClawsIssueAttachment", op(db.insertClawsIssueAttachment)],
  ["getClawsIssueAttachment", op(db.getClawsIssueAttachment)],
  ["listClawsIssueAttachments", op(db.listClawsIssueAttachments)],
  ["claimPendingClawsIssueAttachments", op(db.claimPendingClawsIssueAttachments)],
  ["listPendingClawsIssueAttachmentsOlderThan", op(db.listPendingClawsIssueAttachmentsOlderThan)],
  ["setClawsIssueAttachmentComment", op(db.setClawsIssueAttachmentComment)],
  ["setClawsIssueAttachmentStoredPath", op(db.setClawsIssueAttachmentStoredPath)],
  ["deleteClawsIssueAttachment", op(db.deleteClawsIssueAttachment)],
  ["createClawsIssueLink", op(db.createClawsIssueLink)],
  ["getClawsIssueLink", op(db.getClawsIssueLink)],
  ["listClawsIssueLinks", op(db.listClawsIssueLinks)],
  ["deleteClawsIssueLink", op(db.deleteClawsIssueLink)],
  ["listDependencyReleasableIssues", op(db.listDependencyReleasableIssues)],
  ["listOpenDependencyTargets", op(db.listOpenDependencyTargets)],
  ["markClawsIssueLinksReleased", op(db.markClawsIssueLinksReleased)],
  ["getIssuePlannedPRs", op(db.getIssuePlannedPRs)],
  ["replaceIssuePlannedPRs", op(db.replaceIssuePlannedPRs)],
  ["linkIssuePlannedPR", op(db.linkIssuePlannedPR)],
  ["unlinkIssuePlannedPR", op(db.unlinkIssuePlannedPR)],
  // Imported forge issues and the model plan.
  ["listImportedIssues", op(db.listImportedIssues)],
  ["recordImportedIssue", op(db.recordImportedIssue)],
  ["getLinkedNativeId", op(db.getLinkedNativeId)],
  ["getIssueModelPlanRows", op(db.getIssueModelPlanRows)],
  ["upsertIssueModelPlanCell", op(db.upsertIssueModelPlanCell)],
  ["deleteIssueModelPlanCell", op(db.deleteIssueModelPlanCell)],
  ["deleteIssueModelPlanRowsExceptRepo", op(db.deleteIssueModelPlanRowsExceptRepo)],
]);

function sqlTimeMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether the row's per-run token still authorises ops: while the row runs,
 * and for {@link AGENT_POD_OPS_GRACE_MS} after it reaches a terminal status.
 * A re-queued row has no token hash, so its old pod is refused outright.
 */
export function agentPodTokenLive(row: db.WorkQueueRow, now = Date.now()): boolean {
  if (!row.agent_mcp_token_sha256 || !row.run_id) return false;
  if (row.status === "running") return true;
  if (!TERMINAL_STATUSES.has(row.status)) return false;
  const completedAt = sqlTimeMs(row.completed_at);
  return completedAt !== null && now - completedAt <= AGENT_POD_OPS_GRACE_MS;
}

export type AgentPodOpResult =
  | { status: 200; result: unknown }
  | { status: 400 | 403 | 404 | 500; error: string };

/**
 * Run `opName` with `args` on behalf of `row`'s pod, whose token the caller
 * has already checked. Runs under the row's run context, so `recordTaskStart`
 * stamps the row's run id and any service-side log line lands in that run.
 */
export async function executeAgentPodOp(row: db.WorkQueueRow, opName: string, args: unknown): Promise<AgentPodOpResult> {
  const entry = AGENT_POD_OPS.get(opName);
  if (!entry) return { status: 404, error: `unknown op ${opName}` };
  if (!Array.isArray(args)) return { status: 400, error: "args must be an array" };
  const runId = row.run_id;
  if (!runId) return { status: 403, error: "row has no run" };

  const first: unknown = args[0];
  switch (entry.scope) {
    case "row":
      if (first !== row.id) return { status: 403, error: `${opName} must name row ${row.id}` };
      if (row.status !== "running" && !POST_TERMINAL_ROW_OPS.has(opName)) {
        return { status: 403, error: `row ${row.id} is ${row.status}` };
      }
      break;
    case "run":
      if (first !== runId) return { status: 403, error: `${opName} must name run ${runId}` };
      break;
    case "task":
      if (typeof first !== "number" || await db.getTaskRunId(first) !== runId) {
        return { status: 403, error: `${opName} must name a task of run ${runId}` };
      }
      break;
    case "none":
      break;
  }

  const guarded = GUARDED_ROW_WRITES.get(opName);
  try {
    if (guarded) {
      const changed = await withRunContext(runId, () => guarded(runId, args), workRunContextFields(row));
      return changed ? { status: 200, result: undefined } : { status: 403, error: `row ${row.id} is no longer running under run ${runId}` };
    }
    const result = await withRunContext(runId, () => (entry.fn as (...a: unknown[]) => Promise<unknown>)(...args), workRunContextFields(row));
    return { status: 200, result };
  } catch (err) {
    return { status: 500, error: err instanceof Error ? err.message : String(err) };
  }
}
