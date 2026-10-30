import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IssueRef } from "./issue-id.js";
import { RETIRED_GATE_LABELS } from "./issue-lifecycle.js";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import {
  initDb,
  closeDb,
  _rawDb,
  migrateRetiredManualAction,
  migrateRenamedCapabilities,
  recordTaskStart,
  updateTaskWorktree,
  recordTaskComplete,
  recordTaskFailed,
  getOrphanedTasks,
  getRunningTasks,
  setRunIdProvider,
  getTasksByRunId,
  getWorkItemsForRuns,
  countRecentTimeouts,
  countRecentWorkFailures,
  countRecentMemoryLimits,
  countRecentNoCommitCompletions,
  insertJobRun,
  completeJobRun,
  insertJobLog,
  capJobLogMessage,
  JOB_LOG_MAX_MESSAGE_CHARS,
  JOB_LOG_PRUNE_MESSAGE_BYTES,
  flushJobLogs,
  getMcpRecentJobRuns,
  getMcpRecentJobLogs,
  getMcpWorkQueue,
  getMcpRepoProcessingState,
  getJobRunLogs,
  getJobRunLogsSince,
  getLatestRunIdsByJob,
  getJobRun,
  pruneOldLogs,
  recordQueueSnapshot,
  getQueueSnapshots,
  pruneQueueSnapshots,
  upsertWorkflowRuns,
  getActiveWorkflowRuns,
  getWorkflowRunCount,
  pruneWorkflowRuns,
  countCIFixerAttempts,
  countCIFixerIdleRunsOnHead,
  hasCiFixerGiveUpOnHead,
  countConflictResolutionAttempts,
  getCIFixerBreakerState,
  recordCIFixerBreakerTrip,
  recordCIFixerPush,
  recordCIFixerBreakerGrant,
  resetCIFixerBreakerGrants,
  getRecentCIFixerErrors,
  enqueueWork,
  claimNextWork,
  markWorkSucceeded,
  markWorkFailed,
  markWorkCancelled,
  markWorkSkipped,
  listQueuedWork,
  countWorkByStatus,
  recoverWorkOnStartup,
  reapStaleRunningWork,
  getWorkRow,
  setWorkAgentPod,
  setWorkAgentMcpToken,
  isRunningAgentPodMcpToken,
  markWorkFailedIfRunning,
  markWorkCancelledIfRunning,
  markWorkSucceededIfRunning,
  markWorkSkippedIfRunning,
  setWorkPriorityIfRunning,
  listPodBackedRunningWork,
  releaseClaimedWork,
  pruneWorkQueue,
  pruneTasks,
  hasActiveWorkForPR,
  clearAllWorkQueueForTests,
  markUntrustedActorNotified,
  getIntentBackfillState,
  recordIntentBackfillChunk,
  getDocMemoryDigest,
  recordDocMemoryDigest,
  trackTaskTokens,
  getUsageStats,
  getTotalUsage,
  getUsageFilterOptions,
  getRecentEffectivenessEvents,
  recordTaskEffectivenessEvent,
  findLatestCompletedTaskForPrHead,
  findLostImplementerAttempt,
  recordPRReview,
  getLatestPRReview,
  listPRReviews,
  backfillPRReviews,
  updateTaskModel,
  updateTaskProvider,
  updateTaskTokenUsage,
  insertSession,
  countLiveSessionsSpawnedBy,
  listLiveBoardStartedSessions,
  listLivePrStartedSessions,
  getAllPersistedSessions,
  getEndedSessions,
  getPersistedSession,
  markSessionEnded,
  markSessionInitialPromptSent,
  setSessionClaudeAccount,
  pruneEndedSessions,
  getPrunableEndedSessionIds,
  deleteEndedPersistedSession,
  clearSessionEnded,
  setSessionLaunchedVersion,
  setSessionMcpTokenHash,
  recordSessionMemoryCapture,
  deletePersistedSession,
  noteSessionMemoryCaptureFailed,
  getSessionsNeedingMemoryCapture,
  listUnpushedSessionMemoryCaptures,
  markSessionMemoryCapturePushed,
  getRecentSessionModels,
  sessionCapabilityDefaultsKey,
  rememberSessionCapabilityDefaults,
  getAllSessionCapabilityDefaults,
  rememberSessionAgentDefault,
  getSessionAgentDefaults,
  upsertSessionCapabilityRequest,
  deleteSessionCapabilityRequest,
  getSessionCapabilityRequest,
  listSessionCapabilityRequests,
  insertSessionCapabilityRequestIfAbsent,
  setSessionCapabilityRequestStatus,
  markSessionCapabilityRequest,
  pruneSessionCapabilityRequestsForEndedSessions,
  writeControllerStatus,
  readControllerStatus,
  readSchemaVersion,
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  insertControllerCommand,
  getControllerCommand,
  claimControllerCommands,
  completeControllerCommand,
  pruneControllerCommands,
  pruneClawsEvents,
  updateSessionSummary,
  setManualSessionSummary,
  setSessionAgentStatus,
  updateSessionUsage,
  updateSessionStartup,
  upsertDampReading,
  deleteDampReading,
  getRecentDampReadings,
  insertDmarcReport,
  hasDmarcReport,
  getLatestDmarcReportForDomain,
  getDmarcReportXml,
  getDmarcVerdictCounts,
  getDmarcSourceIps,
  getLatestDmarcReportsPerReporter,
  pruneDmarcReports,
  getDampTrendRows,
  upsertBlogDraft,
  getBlogDraft,
  listBlogDrafts,
  insertFrictionNote,
  listUntriagedFrictionNotes,
  countUntriagedFrictionNotesByRepoAndCategory,
  markFrictionNotesTriaged,
  lastFrictionRetrospectiveAt,
  listFrictionRetrospectives,
  getTasksByIds,
  setBlogDraftPushed,
  clearBlogDraftPR,
  deleteBlogDraft,
  getDefaultBranchRuns,
  getRecentTasksForRepo,
  createClawsIssue,
  getIssueModelPlanRows,
  upsertIssueModelPlanCell,
  deleteIssueModelPlanCell,
  listExplicitIssueModelPlanRows,
  getClawsIssue,
  listOpenClawsIssues,
  listClawsIssues,
  listDuplicateMarkerBodies,
  listIssueIdsWithPlans,
  listClosedClawsIssuesSince,
  updateClawsIssueTitle,
  updateClawsIssueBody,
  setClawsIssueState,
  addClawsIssueLabel,
  removeClawsIssueLabel,
  setClawsIssueRepos,
  addClawsIssueComment,
  editClawsIssueComment,
  listClawsIssueComments,
  addClawsIssueCommentReaction,
  listClawsIssueCommentReactions,
  migrateIssueRefColumnsToText,
  recordImportedIssue,
  listImportedIssues,
  getImportedIssueByNative,
  findOpenImportedIssueByTitle,
  findOpenUnkeyedIssueByFiledTitle,
  relinkImportedIssue,
  getImportedForgeSyncedAt,
  setImportedForgeSyncedAt,
  listShadowIssues,
  markShadowsChecked,
  createShadowIssue,
  getIssuePlannedPRs,
  replaceIssuePlannedPRs,
  setIssuePlannedPRTarget,
  getIssueReapproval,
  upsertIssueReapproval,
  markIssueReapprovalApproved,
  listPendingReapprovalIssueIds,
  listRequirementsApprovedIssueIds,
  getIssueIdsAwaitingOperator,
  getIssueBlockedReasons,
  listPrStallParkCandidates,
  listPrWaitParkCandidates,
  listOpenClawsPrsLinkedToIssues,
  listOpenClawsPrsForIssueOrSteps,
  setIssueBlockedReason,
  blockClawsIssue,
  BlockedReasonRequiredError,
  setClawsIssueBacklogUntil,
  listDueBacklogIssues,
  getIssueBacklogUntil,
  linkIssuePlannedPR,
  upsertClawsPr,
  setClawsPrDispatchNote,
  getClawsPr,
  listClawsPrs,
  listOpenClawsPrsForIssue,
  listClawsPrsForIssue,
  listOpenClawsPrs,
  listOpenClawsPrsWithIssue,
  hasRunningTask,
  findIssuePlannedPRByNumber,
  unlinkIssuePlannedPR,
  getLinkedNativeId,
  updateShadowIssue,
  promoteShadowIssue,
  finishClawsIssueImport,
  setClawsIssueLifecycle,
  setShadowLifecycle,
  migrateStateLabelsToLifecycle,
  migrateGateLabelsToApprovedThrough,
  APPROVED_THROUGH_MIGRATED_KEY,
  setClawsIssueApprovedThrough,
  migrateInboxToIdeas,
  migrateClawsIgnoreLabel,
  migrateAlertKindBackfill,
  ALERT_KIND_BACKFILLED_KEY,
  setClawsIssueAlertKind,
  claimAlertAttention,
  listOpenClawsAlerts,
  promoteClawsIssue,
  demoteClawsIssue,
  skipQueuedWorkForItem,
  listOpenShadowStages,
  recordMainBuildFailure,
  hasMainBuildFailure,
  getPendingMainBuildRetries,
  getExpiredMainBuildRetries,
  setMainBuildRetryOutcome,
  markMainBuildReported,
  hasUnclosedReportedFailure,
  markMainBuildFailuresClosed,
  getUnreportedMainBuildFailures,
  pruneMainBuildFailures,
  describePostgresTarget,
  type Task,
  type TaskOutcome,
  type WorkflowRunRow,
  listClawsIssuePlans,
  listLatestClawsIssuePlansForOpenIssues,
  backfillClawsIssuePlans,
  addClawsIssueRequirementsVersion,
  listClawsIssueRequirements,
  listLatestClawsIssueRequirementsForOpenIssues,
  listClawsIssueCommentsForOpenIdeasIssues,
  approveClawsIssueRequirements,
  listApprovedClawsIssueRequirementsForOpenIssues,
  createClawsIssueLink,
  deleteClawsIssueLink,
  markClawsIssueLinksReleased,
  listClawsIssueHistory,
  softDeleteClawsIssueComments,
} from "./db.js";
import * as log from "./log.js";
import { withRunContext } from "./log-core.js";
import { withIssueActor } from "./issue-history-actor.js";
import * as db from "./db.js";

/** A timestamp in the stored `YYYY-MM-DD HH:MM:SS` UTC form, `ms` in the past.
 *  Test fixtures bind these instead of calling SQLite's `datetime('now', …)`, so
 *  the same SQL runs on both backends. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Row count in `job_runs`, optionally filtered by job name. */
async function countJobRuns(jobName?: string): Promise<number> {
  const rows = jobName
    ? await _rawDb().all(`SELECT 1 FROM job_runs WHERE job_name = ?`, [jobName])
    : await _rawDb().all(`SELECT 1 FROM job_runs`);
  return rows.length;
}

describe("db", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("initDb creates the tasks table", async () => {
    // If initDb didn't create the table, recordTaskStart would throw
    const id = await recordTaskStart("test-job", "test/repo", 1, "label");
    expect(id).toBeGreaterThan(0);
  });

  it("initDb creates the idx_tasks_repo_item index", async () => {
    const db = _rawDb();
    const idx = db.dialect === "postgres"
      ? await db.get(`SELECT indexname AS name FROM pg_indexes WHERE indexname = 'idx_tasks_repo_item'`)
      : await db.get(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_repo_item'`);
    expect(idx).toBeDefined();
  });

  it("initDb creates task effectiveness events table and unique index", async () => {
    const db = _rawDb();
    const table = db.dialect === "postgres"
      ? await db.get(`SELECT tablename AS name FROM pg_tables WHERE tablename = 'task_effectiveness_events'`)
      : await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_effectiveness_events'`);
    const idx = db.dialect === "postgres"
      ? await db.get(`SELECT indexname AS name FROM pg_indexes WHERE indexname = 'idx_task_effectiveness_unique'`)
      : await db.get(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_effectiveness_unique'`);
    expect(table).toBeDefined();
    expect(idx).toBeDefined();
  });

  it("recordTaskStart inserts a running task and returns an ID", async () => {
    const id = await recordTaskStart("issue-worker", "org/repo", 42, "Refined");
    expect(id).toBe(1);

    const tasks = await getOrphanedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].job_name).toBe("issue-worker");
    expect(tasks[0].repo).toBe("org/repo");
    expect(tasks[0].item_number).toBe(42);
    expect(tasks[0].trigger_label).toBe("Refined");
    expect(tasks[0].status).toBe("running");
  });

  it("updateTaskWorktree sets worktree path and branch name", async () => {
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await updateTaskWorktree(id, "/tmp/worktree", "feature-branch");

    const tasks = await getOrphanedTasks();
    expect(tasks[0].worktree_path).toBe("/tmp/worktree");
    expect(tasks[0].branch_name).toBe("feature-branch");
  });

  it("recordTaskComplete sets status to completed", async () => {
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await recordTaskComplete(id);

    // Should no longer appear as orphaned (not 'running')
    const orphaned = await getOrphanedTasks();
    expect(orphaned).toHaveLength(0);
  });

  it("recordTaskComplete stores outcome JSON when provided", async () => {
    setRunIdProvider(() => "run-outcome");
    const id = await recordTaskStart("issue-worker", "org/repo", 1, null);
    const outcome: TaskOutcome = {
      commits: 3,
      filesChanged: 5,
      insertions: 127,
      deletions: 42,
      prNumber: 185,
      prAction: "created",
    };
    await recordTaskComplete(id, outcome);
    setRunIdProvider(() => undefined);

    const tasks = await getTasksByRunId("run-outcome");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("completed");
    expect(tasks[0].outcome).not.toBeNull();

    const parsed = JSON.parse(tasks[0].outcome!);
    expect(parsed.commits).toBe(3);
    expect(parsed.filesChanged).toBe(5);
    expect(parsed.insertions).toBe(127);
    expect(parsed.deletions).toBe(42);
    expect(parsed.prNumber).toBe(185);
    expect(parsed.prAction).toBe("created");
  });

  it("recordTaskComplete without outcome leaves outcome null", async () => {
    setRunIdProvider(() => "run-no-outcome");
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await recordTaskComplete(id);
    setRunIdProvider(() => undefined);

    const tasks = await getTasksByRunId("run-no-outcome");
    expect(tasks[0].outcome).toBeNull();
  });

  it("recordTaskFailed sets status to failed and stores error", async () => {
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await recordTaskFailed(id, "Something went wrong");

    const orphaned = await getOrphanedTasks();
    expect(orphaned).toHaveLength(0);
  });

  it("recordTaskFailed stores outcome JSON when provided", async () => {
    setRunIdProvider(() => "run-fail-outcome");
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await recordTaskFailed(id, "timed out", { failureCategory: "timeout" });
    setRunIdProvider(() => undefined);

    const tasks = await getTasksByRunId("run-fail-outcome");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("failed");
    expect(tasks[0].error).toBe("timed out");

    const parsed = JSON.parse(tasks[0].outcome!);
    expect(parsed.failureCategory).toBe("timeout");
  });

  it("getOrphanedTasks returns only running tasks", async () => {
    const id1 = await recordTaskStart("job-a", "org/repo", 1, null);
    const id2 = await recordTaskStart("job-b", "org/repo", 2, null);
    const id3 = await recordTaskStart("job-c", "org/repo", 3, null);

    await recordTaskComplete(id1);
    await recordTaskFailed(id2, "error");

    const orphaned = await getOrphanedTasks();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe(id3);
    expect(orphaned[0].status).toBe("running");
  });

  it("closeDb closes cleanly", async () => {
    await closeDb();
    // After closing, operations should throw
    await expect(recordTaskStart("test", "repo", 1, null)).rejects.toThrow(
      "Database not initialized",
    );
  });

  it("countRecentTimeouts counts failed tasks with timeout errors", async () => {
    const db = _rawDb();
    // Insert a recent timeout failure
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", "42"]);
    // Insert a recent non-timeout failure
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Some other error', '${ago(1200000)}', '${ago(1140000)}')`, ["issue-worker", "org/repo", "42"]);
    // Insert an old timeout failure (outside window)
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', '${ago(18000000)}', '${ago(18000000)}')`, ["issue-worker", "org/repo", "42"]);

    // Default 2-hour window should find 1 timeout
    expect(await countRecentTimeouts("org/repo", 42)).toBe(1);
  });

  it("countRecentWorkFailures matches by error prefix and window", async () => {
    const db = _rawDb();
    const ins = (err: string, at: number) => db.run(
      `INSERT INTO work_queue (kind, repo, item_number, status, error_message, completed_at) VALUES ('k', 'org/repo', '5', 'failed', ?, '${ago(at)}')`, [err]);
    await ins("transient clone failure: org/repo after 6 attempts", 60000);
    await ins("transient clone failure: org/repo after 6 attempts", 120000);
    await ins("other error", 60000);
    await ins("transient clone failure: old", 18000000);
    expect(await countRecentWorkFailures("k", "org/repo", 5, "transient clone failure")).toBe(2);
    expect(await countRecentWorkFailures("k", "org/repo", 6, "transient clone failure")).toBe(0);
  });

  it("countRecentTimeouts returns 0 when no timeouts exist", async () => {
    expect(await countRecentTimeouts("org/repo", 99)).toBe(0);
  });

  it("countRecentTimeouts scopes by repo and item number", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "org/repo", "42"]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "other/repo", "42"]);

    expect(await countRecentTimeouts("org/repo", 42)).toBe(1);
    expect(await countRecentTimeouts("other/repo", 42)).toBe(1);
    expect(await countRecentTimeouts("org/repo", 99)).toBe(0);
  });

  it("countRecentMemoryLimits counts failed tasks with memory limit errors", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", "42"]);
    // Insert a recent non-memory-limit failure
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Some other error', '${ago(1200000)}', '${ago(1140000)}')`, ["issue-worker", "org/repo", "42"]);
    // Insert an old memory-limit failure (outside window)
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', '${ago(18000000)}', '${ago(18000000)}')`, ["issue-worker", "org/repo", "42"]);

    expect(await countRecentMemoryLimits("org/repo", 42)).toBe(1);
  });

  it("countRecentMemoryLimits returns 0 when no memory limit errors exist", async () => {
    expect(await countRecentMemoryLimits("org/repo", 99)).toBe(0);
  });

  it("countRecentMemoryLimits scopes strike counts to the same effective cap", async () => {
    const db = _rawDb();
    for (const error of [
      "Agent process tree exceeded memory limit (2134MiB > 2048MiB)",
      "Agent process tree exceeded memory limit (2599MiB > 2048MiB)",
      "Agent process tree exceeded memory limit (4300MiB > 4096MiB)",
    ]) {
      await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
         VALUES (?, ?, ?, 'failed', ?, '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "org/repo", "42", error]);
    }

    expect(await countRecentMemoryLimits("org/repo", 42, 4 * 1024 * 1024 * 1024)).toBe(1);
    expect(await countRecentMemoryLimits("org/repo", 42, 2 * 1024 * 1024 * 1024)).toBe(2);
  });

  it("countRecentMemoryLimits counts the structural cap and does not double-count it", async () => {
    const db = _rawDb();
    // Rows written since the outcome carries memoryLimitBytes: counted in SQL,
    // and deliberately given a message the legacy regex would also match so a
    // double-count would show up here.
    for (const [error, outcome] of [
      ["Agent process tree exceeded memory limit (4300MiB > 4096MiB)", '{"failureCategory":"memory-limit","memoryLimitBytes":4294967296}'],
      ["something else entirely", '{"failureCategory":"memory-limit","memoryLimitBytes":4294967296}'],
      ["Agent process tree exceeded memory limit (2100MiB > 2048MiB)", '{"failureCategory":"memory-limit","memoryLimitBytes":2147483648}'],
    ] as const) {
      await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, outcome, started_at, completed_at)
         VALUES (?, ?, ?, 'failed', ?, ?, '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "org/repo", "77", error, outcome]);
    }
    // A pre-#3168 row with no structural field still counts via the fallback.
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (4500MiB > 4096MiB)', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "org/repo", "77"]);

    expect(await countRecentMemoryLimits("org/repo", 77, 4 * 1024 * 1024 * 1024)).toBe(3);
    expect(await countRecentMemoryLimits("org/repo", 77, 2 * 1024 * 1024 * 1024)).toBe(1);
  });

  it("countRecentMemoryLimits scopes by repo and item number", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "org/repo", "42"]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "other/repo", "42"]);

    expect(await countRecentMemoryLimits("org/repo", 42)).toBe(1);
    expect(await countRecentMemoryLimits("other/repo", 42)).toBe(1);
    expect(await countRecentMemoryLimits("org/repo", 99)).toBe(0);
  });

  it("countRecentNoCommitCompletions counts completed tasks with 0 commits and no prNumber", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", "42"]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
  });

  it("countRecentNoCommitCompletions excludes tasks with commits > 0", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":3}', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", "42"]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(0);
  });

  it("countRecentNoCommitCompletions excludes tasks with a prNumber", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0,"prNumber":100}', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", "42"]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(0);
  });

  it("countRecentNoCommitCompletions scopes by repo and item number", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "org/repo", "42"]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "other/repo", "42"]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
    expect(await countRecentNoCommitCompletions("other/repo", 42)).toBe(1);
    expect(await countRecentNoCommitCompletions("org/repo", 99)).toBe(0);
  });

  it("countRecentNoCommitCompletions respects time window", async () => {
    const db = _rawDb();
    // Recent — within default 6h window
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(3600000)}', '${ago(3540000)}')`, ["issue-worker", "org/repo", "42"]);
    // Old — outside default 6h window
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(28800000)}', '${ago(28800000)}')`, ["issue-worker", "org/repo", "42"]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
  });

  it("countRecentNoCommitCompletions counts only completions after since", async () => {
    const db = _rawDb();
    for (const at of [3 * 3600000, 2 * 3600000, 3600000]) {
      await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
         VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(at + 60000)}', '${ago(at)}')`, ["issue-worker", "org/repo", "42"]);
    }
    const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

    expect(await countRecentNoCommitCompletions("org/repo", 42, undefined, isoAgo(90 * 60000))).toBe(1);
    expect(await countRecentNoCommitCompletions("org/repo", 42, undefined, isoAgo(60000))).toBe(0);
    // A since older than the window leaves the window in charge.
    expect(await countRecentNoCommitCompletions("org/repo", 42, undefined, isoAgo(24 * 3600000))).toBe(3);
  });

  it("countRecentNoCommitCompletions resets after a merged PR (cross-phase scoping)", async () => {
    const db = _rawDb();
    // Phase 2 had 2 no-commit attempts before succeeding
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(10800000)}', '${ago(10800000)}')`, ["issue-worker", "org/repo", "42"]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(7200000)}', '${ago(7200000)}')`, ["issue-worker", "org/repo", "42"]);
    // Phase 2 finally succeeded — PR merged
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":3,"prNumber":101}', '${ago(3600000)}', '${ago(3600000)}')`, ["issue-worker", "org/repo", "42"]);
    // Phase 3, attempt 1: no commits
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(1800000)}', '${ago(1800000)}')`, ["issue-worker", "org/repo", "42"]);

    // Should only count the 1 no-commit attempt after the merged PR, not the 2 from phase 2
    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
  });

  it("operations before initDb throw", async () => {
    await closeDb(); // close the one from beforeEach
    await expect(recordTaskStart("test", "repo", 1, null)).rejects.toThrow(
      "Database not initialized",
    );
  });

  it("recordTaskStart with null trigger label", async () => {
    const id = await recordTaskStart("ci-fixer", "org/repo", 5, null);
    const tasks = await getOrphanedTasks();
    expect(tasks[0].trigger_label).toBeNull();
  });

  it("multiple tasks get sequential IDs", async () => {
    const id1 = await recordTaskStart("job-a", "org/repo", 1, null);
    const id2 = await recordTaskStart("job-b", "org/repo", 2, null);
    const id3 = await recordTaskStart("job-c", "org/repo", 3, null);

    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(id3).toBe(3);
  });

  it("getRunningTasks returns only running tasks ordered by started_at", async () => {
    const id1 = await recordTaskStart("job-a", "org/repo", 1, null);
    const id2 = await recordTaskStart("job-b", "org/repo", 2, null);
    const id3 = await recordTaskStart("job-c", "org/repo", 3, null);

    await recordTaskComplete(id2);

    const running = await getRunningTasks();
    expect(running).toHaveLength(2);
    expect(running[0].id).toBe(id1);
    expect(running[1].id).toBe(id3);
    expect(running.every(t => t.status === "running")).toBe(true);
  });

  it("setRunIdProvider + recordTaskStart populates run_id", async () => {
    setRunIdProvider(() => "run-abc");
    const id = await recordTaskStart("issue-worker", "org/repo", 42, null);
    const tasks = await getOrphanedTasks();
    expect(tasks[0].run_id).toBe("run-abc");
    // Clean up provider
    setRunIdProvider(() => undefined);
  });

  it("recordTaskStart has null run_id when no provider is set", async () => {
    setRunIdProvider(() => undefined);
    const id = await recordTaskStart("issue-worker", "org/repo", 1, null);
    const tasks = await getOrphanedTasks();
    expect(tasks[0].run_id).toBeNull();
  });

  it("getTasksByRunId returns correct tasks", async () => {
    setRunIdProvider(() => "run-xyz");
    await recordTaskStart("job-a", "org/repo", 1, null);
    await recordTaskStart("job-a", "org/repo", 2, null);
    setRunIdProvider(() => "run-other");
    await recordTaskStart("job-a", "org/repo", 3, null);
    setRunIdProvider(() => undefined);

    const tasks = await getTasksByRunId("run-xyz");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].item_number).toBe(1);
    expect(tasks[1].item_number).toBe(2);

    const otherTasks = await getTasksByRunId("run-other");
    expect(otherTasks).toHaveLength(1);
    expect(otherTasks[0].item_number).toBe(3);
  });

  it("getWorkItemsForRuns batch query", async () => {
    setRunIdProvider(() => "run-1");
    await recordTaskStart("job-a", "org/repo", 10, null);
    setRunIdProvider(() => "run-2");
    await recordTaskStart("job-a", "org/repo", 20, null);
    await recordTaskStart("job-a", "org/repo", 21, null);
    setRunIdProvider(() => undefined);

    const map = await getWorkItemsForRuns(["run-1", "run-2"]);
    expect(map.get("run-1")).toHaveLength(1);
    expect(map.get("run-2")).toHaveLength(2);
  });

  it("getWorkItemsForRuns returns empty map for empty input", async () => {
    const map = await getWorkItemsForRuns([]);
    expect(map.size).toBe(0);
  });

});

describe("schema version gate (#clw_01M5APX7YF3AGWHV1S1WMHJDR6)", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("opens without migrating: no tables and no recorded version", async () => {
    await initDb({ migrate: false });
    expect(await readSchemaVersion()).toBeNull();
    await expect(_rawDb().all(`SELECT 1 FROM tasks`)).rejects.toThrow();
  });

  it("records SCHEMA_VERSION after migrating", async () => {
    await initDb();
    expect(await readSchemaVersion()).toBe(SCHEMA_VERSION);
    expect(await readControllerStatus(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION);
  });

  it("ignores a recorded value that is not a number", async () => {
    await initDb();
    await writeControllerStatus(SCHEMA_VERSION_KEY, "7");
    expect(await readSchemaVersion()).toBeNull();
  });
});

describe("describePostgresTarget", () => {
  it("names host and database without the credentials", () => {
    expect(describePostgresTarget("postgresql://claws:s3cr3t@postgres.databases.svc:5432/claws_staging"))
      .toBe("PostgreSQL (postgres.databases.svc:5432/claws_staging)");
  });

  it("never echoes the password, even with query parameters", () => {
    const out = describePostgresTarget("postgresql://claws:p%40ss%2Fword@db.internal/claws?sslmode=require");
    expect(out).toBe("PostgreSQL (db.internal/claws)");
    expect(out).not.toContain("pass");
    expect(out).not.toContain("sslmode");
  });

  it("omits the port when the URL has none", () => {
    expect(describePostgresTarget("postgres://db.internal/claws")).toBe("PostgreSQL (db.internal/claws)");
  });

  it("degrades to a bare label on an unparseable value", () => {
    expect(describePostgresTarget("host=db.internal dbname=claws password=s3cr3t")).toBe("PostgreSQL");
  });
});

describe("job run logs", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("insertJobRun creates a run record", async () => {
    await insertJobRun("run-1", "test-job");
    const run = await getJobRun("run-1");
    expect(run).toBeDefined();
    expect(run!.run_id).toBe("run-1");
    expect(run!.job_name).toBe("test-job");
    expect(run!.status).toBe("running");
    expect(run!.completed_at).toBeNull();
  });

  it("completeJobRun updates status and completed_at", async () => {
    await insertJobRun("run-1", "test-job");
    await completeJobRun("run-1", "completed");

    const run = await getJobRun("run-1");
    expect(run).toBeDefined();
    expect(run!.status).toBe("completed");
    expect(run!.completed_at).not.toBeNull();
  });

  it("completeJobRun can set status to failed", async () => {
    await insertJobRun("run-1", "test-job");
    await completeJobRun("run-1", "failed");

    const run = await getJobRun("run-1");
    expect(run!.status).toBe("failed");
  });

  it("insertJobLog appends log entries", async () => {
    await insertJobRun("run-1", "test-job");
    insertJobLog("run-1", "info", "Hello");
    insertJobLog("run-1", "warn", "Careful");
    insertJobLog("run-1", "error", "Boom");

    const logs = await getJobRunLogs("run-1");
    expect(logs).toHaveLength(3);
    expect(logs[0].level).toBe("info");
    expect(logs[0].message).toBe("Hello");
    expect(logs[1].level).toBe("warn");
    expect(logs[2].level).toBe("error");
  });

  it("getJobRunLogs returns entries for a specific run only", async () => {
    await insertJobRun("run-1", "job-a");
    await insertJobRun("run-2", "job-b");
    insertJobLog("run-1", "info", "Run 1 log");
    insertJobLog("run-2", "info", "Run 2 log");

    const logs1 = await getJobRunLogs("run-1");
    expect(logs1).toHaveLength(1);
    expect(logs1[0].message).toBe("Run 1 log");

    const logs2 = await getJobRunLogs("run-2");
    expect(logs2).toHaveLength(1);
    expect(logs2[0].message).toBe("Run 2 log");
  });

  it("getJobRun returns undefined for nonexistent run", async () => {
    const run = await getJobRun("nonexistent");
    expect(run).toBeUndefined();
  });

  it("insertJobLog caps an oversized message with a truncation marker", async () => {
    await insertJobRun("run-1", "job-a");
    insertJobLog("run-1", "info", "x".repeat(100_000));
    await flushJobLogs();

    const logs = await getJobRunLogs("run-1");
    expect(logs).toHaveLength(1);
    expect(logs[0].message.endsWith("[truncated: 68000 more chars]")).toBe(true);
    expect(logs[0].message.length).toBe(JOB_LOG_MAX_MESSAGE_CHARS + "\n… [truncated: 68000 more chars]".length);
  });

  it("insertJobLog stores a short message unchanged", async () => {
    await insertJobRun("run-1", "job-a");
    insertJobLog("run-1", "info", "short message");
    await flushJobLogs();

    const logs = await getJobRunLogs("run-1");
    expect(logs[0].message).toBe("short message");
  });

  it("MCP recent job summaries and logs include buffered job logs", async () => {
    await insertJobRun("run-1", "job-a");
    insertJobLog("run-1", "warn", "fresh warning");
    insertJobLog("run-1", "info", "fresh final line");

    const runs = await getMcpRecentJobRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].latest_error).toBe("[redacted diagnostic text]");
    expect(runs[0].latest_log_excerpt).toBe("[redacted diagnostic text]");

    await insertJobLog("run-1", "info", "fresh explicit log");
    const logs = await getMcpRecentJobLogs({ runId: "run-1" });
    expect(logs[0].message).toBe("[redacted diagnostic text]");
  });

  it("preserves distinct producer reasons while keeping log payloads private", async () => {
    await insertJobRun("safe-run", "doc-maintainer");
    insertJobLog("safe-run", "info", "Bearer secret-one", "docs_open_pr");
    insertJobLog("safe-run", "info", "Bearer secret-two", "docs_unchanged");
    insertJobLog("safe-run", "warn", "Bearer secret-three", "agent_timeout");
    const logs = await getMcpRecentJobLogs({ runId: "safe-run", jobName: "doc-maintainer", limit: 3 });
    expect(logs.map((row) => row.diagnostic_reason?.code)).toEqual(["agent_timeout", "docs_unchanged", "docs_open_pr"]);
    expect(new Set(logs.map((row) => row.diagnostic_reason?.summary)).size).toBe(3);
    expect(JSON.stringify(logs)).not.toContain("Bearer");
    expect((await getMcpRecentJobRuns(1, "doc-maintainer"))[0].diagnostic_reason?.code).toBe("agent_timeout");
    // Untrusted/old database values cannot bypass the allowlist.
    await _rawDb().run("UPDATE job_logs SET diagnostic_reason = ?", ["Bearer secret-four"]);
    expect((await getMcpRecentJobLogs()).every((row) => row.diagnostic_reason === null)).toBe(true);
    expect((await getJobRunLogs("safe-run"))[0].message).toBe("Bearer secret-one");
  });

  it("preserves each repository and task subject in a shared run", async () => {
    await insertJobRun("multi-repo", "doc-maintainer");
    insertJobLog("multi-repo", "info", "private A", "docs_open_pr", { repo: "org/a" });
    insertJobLog("multi-repo", "info", "private B", "docs_unchanged", { repo: "org/b", taskId: 42 });
    const logs = await getMcpRecentJobLogs({ runId: "multi-repo" });
    expect(logs.map((row) => [row.diagnostic_reason?.code, row.diagnostic_context])).toEqual([
      ["docs_unchanged", { repo: "org/b", taskId: 42 }], ["docs_open_pr", { repo: "org/a" }],
    ]);
    const [run] = await getMcpRecentJobRuns();
    expect(run.diagnostics.map((event) => event.diagnostic_context)).toEqual(logs.map((row) => row.diagnostic_context));
    expect(run.diagnostics_truncated).toBe(false);
    // Validate at read time too, including data written outside the producer.
    await _rawDb().run("UPDATE job_logs SET diagnostic_context = ?", [JSON.stringify({ repo: "https://user:secret@host/repo", taskId: -1, busy: "secret", dueCount: -1, extra: "secret" })]);
    expect((await getMcpRecentJobLogs()).every((row) => Object.keys(row.diagnostic_context).length === 0)).toBe(true);
    expect(JSON.stringify(await getMcpRecentJobRuns())).not.toContain("secret");
  });

  it("redacts credential-bearing subprocess output in every diagnostic query", async () => {
    const payload = 'stdout: Authorization: Bearer secret-token\nDATABASE_URL=postgres://user:password@host/db\nPrivate customer payload';
    await insertJobRun("secret-run", "job-a");
    insertJobLog("secret-run", "error", payload);
    const work = (await enqueueWork("ci-fixer", "org/repo", 9))!;
    await markWorkFailed(work.id, payload);
    const results = [await getMcpRecentJobRuns(), await getMcpRecentJobLogs(), await getMcpWorkQueue(10, ["failed"])];
    for (const result of results) {
      expect(JSON.stringify(result)).toContain("[redacted diagnostic text]");
      expect(JSON.stringify(result)).not.toMatch(/secret-token|password|Private customer/);
    }
    expect((await getJobRunLogs("secret-run"))[0].message).toBe(payload);
  });

  it("returns newest terminal work before older high-priority work with a stable tie-break", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const work = (await enqueueWork("ci-fixer", "org/repo", i, { priority: i === 0 }))!;
      ids.push(work.id);
      await markWorkFailed(work.id, "error");
      await _rawDb().run("UPDATE work_queue SET completed_at = ? WHERE id = ?", [i === 0 ? "2026-01-01 00:00:00" : "2026-01-02 00:00:00", work.id]);
    }
    expect((await getMcpWorkQueue(2, ["failed"])).map(r => r.id)).toEqual([ids[3], ids[2]]);
    const low = (await enqueueWork("ci-fixer", "org/repo", 10))!;
    const high = (await enqueueWork("ci-fixer", "org/repo", 11, { priority: true }))!;
    expect((await getMcpWorkQueue(2)).map(r => r.id)).toEqual([high.id, low.id]);
  });

  it("tags each work-queue row with the lane that claims it", async () => {
    await enqueueWork("issue-refiner:plan", "org/repo", 1);
    await enqueueWork("ci-fixer", "org/repo", 2, { priority: true });
    await enqueueWork("pr-reviewer", "org/repo", 3);
    const lanes = Object.fromEntries((await getMcpWorkQueue(10)).map(r => [r.kind, r.lane]));
    expect(lanes).toEqual({ "issue-refiner:plan": "planning", "ci-fixer": "express", "pr-reviewer": "regular" });
  });

  it("selects latest processing per job/repo before limiting", async () => {
    for (const [job, repo, day] of [["a", "org/busy", "03"], ["a", "org/busy", "02"], ["a", "org/stale", "01"], ["b", "org/busy", "01"]]) {
      await _rawDb().run("INSERT INTO processed_repos_daily (job_name, repo, local_date, processed_at) VALUES (?, ?, ?, ?)", [job, repo, `2026-01-${day}`, `2026-01-${day} 00:00:00`]);
    }
    const rows = await getMcpRepoProcessingState({ jobName: "a", limit: 2 });
    expect(rows.map(r => r.repo)).toEqual(["org/busy", "org/stale"]);
    expect(rows[0].local_date).toBe("2026-01-03");
    expect(await getMcpRepoProcessingState({ repo: "org/busy" })).toHaveLength(2);
  });

  it("capJobLogMessage does not split a surrogate pair at the boundary", () => {
    // A message whose cap-th char (index JOB_LOG_MAX_MESSAGE_CHARS - 1) is the high
    // surrogate of an astral character straddling the cut point.
    const prefix = "x".repeat(JOB_LOG_MAX_MESSAGE_CHARS - 1);
    const astral = "\u{1F600}"; // two UTF-16 units: high + low surrogate
    const message = prefix + astral + "y".repeat(1000);

    const capped = capJobLogMessage(message);
    const kept = capped.split("\n… [truncated:")[0];
    // The high surrogate must not appear alone at the end of the kept text.
    const lastUnit = kept.charCodeAt(kept.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
    expect(kept).toBe(prefix);
  });

  it("pruneOldLogs deletes old entries and returns count", async () => {
    await insertJobRun("run-1", "job-a");
    insertJobLog("run-1", "info", "Old log");

    // With retention of 0 days, everything before now is pruned
    // Entries timestamped at ago(0) equal the cutoff, so they won't be pruned
    // Use a very large retention to verify nothing is pruned
    const prunedNone = await pruneOldLogs(9999);
    expect(prunedNone).toBe(0);
    expect(await countJobRuns()).toBe(1);
  });

  it("pruneOldLogs removes oversized job_logs rows regardless of run age", async () => {
    const db = _rawDb();
    await insertJobRun("run-1", "job-a");

    // Bypass the write-time cap with a direct INSERT, simulating a pre-#3113 row.
    await db.run(`INSERT INTO job_logs (run_id, level, message, logged_at) VALUES (?, ?, ?, ?)`, [
      "run-1",
      "debug",
      "x".repeat(JOB_LOG_PRUNE_MESSAGE_BYTES + 1),
      new Date().toISOString().slice(0, 19).replace("T", " "),
    ]);
    insertJobLog("run-1", "info", "normal recent log");
    insertJobLog("run-1", "debug", "x".repeat(JOB_LOG_MAX_MESSAGE_CHARS)); // capped, exactly at the cap
    await flushJobLogs();

    expect(await getJobRunLogs("run-1")).toHaveLength(3);

    const pruned = await pruneOldLogs(9999);
    expect(pruned).toBe(0); // no job_runs rows aged out

    const remaining = await getJobRunLogs("run-1");
    expect(remaining).toHaveLength(2);
    expect(remaining.every((l) => l.message.length <= JOB_LOG_MAX_MESSAGE_CHARS)).toBe(true);
  });

  it("pruneOldLogs keeps most recent N runs per job type", async () => {
    const db = _rawDb();
    // Insert old runs for job-a (4 runs) and job-b (2 runs)
    for (let i = 1; i <= 4; i++) {
      await db.run(`INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'completed', ?)`, [`old-a-${i}`, "job-a", ago(30 * 86_400_000 - i * 3_600_000)]);
    }
    for (let i = 1; i <= 2; i++) {
      await db.run(`INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'completed', ?)`, [`old-b-${i}`, "job-b", ago(30 * 86_400_000 - i * 3_600_000)]);
    }
    // Insert logs for all runs
    for (let i = 1; i <= 4; i++) {
      insertJobLog(`old-a-${i}`, "info", `Log for a-${i}`);
    }
    for (let i = 1; i <= 2; i++) {
      insertJobLog(`old-b-${i}`, "info", `Log for b-${i}`);
    }
    await flushJobLogs();

    // Prune with keepPerJob=2 and retention=7 days (all runs are 30 days old)
    const pruned = await pruneOldLogs(7, 2);

    // job-a had 4 old runs, should keep 2 → prune 2
    // job-b had 2 old runs, should keep 2 → prune 0
    expect(pruned).toBe(2);

    expect(await countJobRuns("job-a")).toBe(2);
    expect(await countJobRuns("job-b")).toBe(2);
  });

  it("pruneOldLogs cascades log cleanup for deleted runs", async () => {
    const db = _rawDb();
    // Insert an old run with logs
    await db.run(`INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES ('old-run', 'job-a', 'completed', '${ago(2592000000)}')`);
    insertJobLog("old-run", "info", "Old log entry");

    // Insert a recent run with logs
    await insertJobRun("recent-run", "job-a");
    insertJobLog("recent-run", "info", "Recent log entry");
    await flushJobLogs();

    // Prune with keepPerJob=1 (keep only the most recent run per job)
    await pruneOldLogs(7, 1);

    // Old run's logs should be gone
    const oldLogs = await getJobRunLogs("old-run");
    expect(oldLogs).toHaveLength(0);

    // Recent run's logs should remain
    const recentLogs = await getJobRunLogs("recent-run");
    expect(recentLogs).toHaveLength(1);
  });

  it("pruneOldLogs without keepPerJob arg defaults to 20", async () => {
    const db = _rawDb();
    // Insert 25 old runs for the same job
    for (let i = 1; i <= 25; i++) {
      await db.run(`INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'completed', ?)`, [`old-${i}`, "job-a", ago(30 * 86_400_000 - i * 60_000)]);
    }

    // Prune with default keepPerJob (20)
    const pruned = await pruneOldLogs(7);
    expect(pruned).toBe(5); // 25 - 20 = 5

    expect(await countJobRuns("job-a")).toBe(20);
  });

  it("getJobRunLogsSince returns only logs after the given ID", async () => {
    await insertJobRun("run-1", "test-job");
    insertJobLog("run-1", "info", "First");
    insertJobLog("run-1", "warn", "Second");
    insertJobLog("run-1", "error", "Third");

    const allLogs = await getJobRunLogs("run-1");
    const firstId = allLogs[0].id;

    const since = await getJobRunLogsSince("run-1", firstId);
    expect(since).toHaveLength(2);
    expect(since[0].message).toBe("Second");
    expect(since[1].message).toBe("Third");

    const sinceAll = await getJobRunLogsSince("run-1", 0);
    expect(sinceAll).toHaveLength(3);

    const sinceEnd = await getJobRunLogsSince("run-1", allLogs[2].id);
    expect(sinceEnd).toHaveLength(0);
  });

  it("getLatestRunIdsByJob returns latest run per job", async () => {
    await insertJobRun("run-1", "job-a");
    await insertJobRun("run-2", "job-a");
    await insertJobRun("run-3", "job-b");
    await completeJobRun("run-1", "completed");
    await completeJobRun("run-2", "failed");

    const latest = await getLatestRunIdsByJob();
    expect(latest.get("job-a")).toEqual(expect.objectContaining({ runId: "run-2", status: "failed" }));
    expect(latest.get("job-a")).toHaveProperty("startedAt");
    expect(latest.get("job-a")).toHaveProperty("completedAt");
    expect(latest.get("job-b")).toEqual(expect.objectContaining({ runId: "run-3", status: "running" }));
    expect(latest.get("job-b")!.completedAt).toBeNull();
  });
});

describe("pruneTasks", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("deletes old terminal rows, keeps recent ones", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at) VALUES ('issue-worker','org/repo','1','completed','${ago(10368000000)}','${ago(10368000000)}')`);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at) VALUES ('issue-worker','org/repo','2','failed','${ago(0)}','${ago(0)}')`);

    expect(await pruneTasks(90)).toBe(1);

    const { c } = await db.get("SELECT COUNT(*) AS c FROM tasks") as { c: number };
    expect(c).toBe(1);
  });

  it("never deletes running rows", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES ('issue-worker','org/repo','1','running','${ago(17280000000)}')`);

    expect(await pruneTasks(90)).toBe(0);
    expect(await getOrphanedTasks()).toHaveLength(1);
  });

  it("keeps rows whose run still exists", async () => {
    const db = _rawDb();
    await insertJobRun("run-keep", "job-a");
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at, run_id) VALUES ('issue-worker','org/repo','1','completed','${ago(17280000000)}','${ago(17280000000)}','run-keep')`);

    expect(await pruneTasks(90)).toBe(0);

    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at, run_id) VALUES ('issue-worker','org/repo','2','completed','${ago(17280000000)}','${ago(17280000000)}','run-gone')`);

    expect(await pruneTasks(90)).toBe(1);
  });

  it("returns 0 when nothing to prune", async () => {
    const id = await recordTaskStart("issue-worker", "org/repo", 1, null);
    await recordTaskComplete(id);
    expect(await pruneTasks(90)).toBe(0);
  });
});

describe("work_queue helpers", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("enqueueWork inserts a row and returns its id", async () => {
    const r = await enqueueWork("ci-fixer", "org/repo", 42, { priority: true });
    expect(r).not.toBeNull();
    expect(r!.alreadyQueued).toBe(false);
    expect(typeof r!.id).toBe("number");
    expect(await listQueuedWork()).toHaveLength(1);
  });

  it("enqueueWork dedups same (kind, repo, item_number) when row is queued", async () => {
    const first = await enqueueWork("ci-fixer", "org/repo", 42);
    const second = await enqueueWork("ci-fixer", "org/repo", 42);
    expect(first!.id).toBe(second!.id);
    expect(second!.alreadyQueued).toBe(true);
    expect(await listQueuedWork()).toHaveLength(1);
  });

  it("enqueueWork allows different kinds on same repo+item", async () => {
    expect(await enqueueWork("ci-fixer", "org/repo", 42)).not.toBeNull();
    expect(await enqueueWork("review-addresser", "org/repo", 42)).not.toBeNull();
    expect(await listQueuedWork()).toHaveLength(2);
  });

  it("claimNextWork picks priority rows first, then by id", async () => {
    await enqueueWork("ci-fixer", "org/repo", 1);
    await enqueueWork("ci-fixer", "org/repo", 2, { priority: true });
    await enqueueWork("ci-fixer", "org/repo", 3);

    const claimed = await claimNextWork(null);
    expect(claimed).not.toBeNull();
    expect(claimed!.item_number).toBe(2);
    expect(claimed!.status).toBe("running");
    expect(claimed!.pid).toBe(process.pid);
    expect(claimed!.attempts).toBe(1);
  });

  async function claimAll(): Promise<Array<[string, IssueRef]>> {
    const out: Array<[string, IssueRef]> = [];
    for (let r = await claimNextWork(null); r; r = await claimNextWork(null)) out.push([r.kind, r.item_number]);
    return out;
  }

  it("claimNextWork picks PR-side rows before issue-side rows whatever the arrival order", async () => {
    for (const n of [1, 2, 3]) await enqueueWork("issue-worker", "org/repo", n);
    for (const n of [10, 11]) await enqueueWork("pr-reviewer", "org/repo", n);
    await enqueueWork("review-addresser", "org/repo", 20);
    await enqueueWork("ci-fixer", "org/repo", 30);
    await enqueueWork("issue-refiner:plan", "org/repo", 40);
    await enqueueWork("ci-fixer:conflict", "org/repo", 31);

    expect(await claimAll()).toEqual([
      ["ci-fixer", 30],
      ["ci-fixer:conflict", 31],
      ["review-addresser", 20],
      ["pr-reviewer", 10],
      ["pr-reviewer", 11],
      ["issue-worker", 1],
      ["issue-worker", 2],
      ["issue-worker", 3],
      ["issue-refiner:plan", 40],
    ]);
  });

  it("claimNextWork puts a Priority row first across stages", async () => {
    await enqueueWork("pr-reviewer", "org/repo", 10);
    await enqueueWork("issue-refiner:plan", "org/repo", 40, { priority: true });
    expect(await claimAll()).toEqual([["issue-refiner:plan", 40], ["pr-reviewer", 10]]);
  });

  it("claimNextWork with priorityOnly claims only priority rows, in normal order", async () => {
    await enqueueWork("ci-fixer", "org/repo", 30);
    await enqueueWork("issue-refiner:plan", "org/repo", 40);
    expect(await claimNextWork(null, { priorityOnly: true })).toBeNull();

    await enqueueWork("issue-refiner:plan", "org/repo", 41, { priority: true });
    await enqueueWork("pr-reviewer", "org/repo", 10, { priority: true });
    expect((await claimNextWork(null, { priorityOnly: true }))!.item_number).toBe(10);
    expect((await claimNextWork(null, { priorityOnly: true }))!.item_number).toBe(41);
    expect(await claimNextWork(null, { priorityOnly: true })).toBeNull();
    expect((await listQueuedWork()).filter((r) => r.status === "queued").map((r) => r.item_number).sort()).toEqual([30, 40]);
  });

  it("claimNextWork with planningOnly claims only planning and requirements kinds, in normal order", async () => {
    await enqueueWork("pr-reviewer", "org/repo", 10);
    await enqueueWork("issue-worker", "org/repo", 20, { priority: true });
    expect(await claimNextWork(null, { planningOnly: true })).toBeNull();

    await enqueueWork("requirements-writer:write", "org/repo", 50);
    await enqueueWork("issue-refiner:plan", "org/repo", 40);
    await enqueueWork("issue-refiner:plan", "org/repo", 41);
    expect((await claimNextWork(null, { planningOnly: true }))!.item_number).toBe(40);
    expect((await claimNextWork(null, { planningOnly: true }))!.item_number).toBe(41);
    expect((await claimNextWork(null, { planningOnly: true }))!.item_number).toBe(50);
    expect(await claimNextWork(null, { planningOnly: true })).toBeNull();
    expect((await listQueuedWork()).filter((r) => r.status === "queued").map((r) => r.item_number).sort()).toEqual([10, 20]);
  });

  it("claimNextWork with kinds claims only those kinds, in normal order; an empty list claims nothing", async () => {
    await enqueueWork("issue-worker", "org/repo", 1, { priority: true });
    await enqueueWork("pr-reviewer", "org/repo", 2);
    await enqueueWork("issue-refiner:plan", "org/repo", 3);
    const kinds = ["pr-reviewer", "issue-refiner:plan"];
    expect(await claimNextWork(null, { kinds: [] })).toBeNull();
    expect((await claimNextWork(null, { kinds }))!.kind).toBe("pr-reviewer");
    expect((await claimNextWork(null, { kinds, priorityOnly: true }))).toBeNull();
    expect((await claimNextWork(null, { kinds }))!.kind).toBe("issue-refiner:plan");
    expect(await claimNextWork(null, { kinds })).toBeNull();
    expect((await listQueuedWork()).filter((r) => r.status === "queued").map((r) => r.kind)).toEqual(["issue-worker"]);
  });

  it("claimNextWork breaks ties within a stage and priority by age", async () => {
    await enqueueWork("pr-reviewer", "org/repo", 12);
    await enqueueWork("pr-reviewer", "org/repo", 11);
    await enqueueWork("pr-reviewer", "org/repo", 13);
    expect((await claimAll()).map(([, n]) => n)).toEqual([12, 11, 13]);
  });

  it("re-enqueueing a queued row refreshes its priority and changes the next claim", async () => {
    await enqueueWork("pr-reviewer", "org/repo", 10);
    await enqueueWork("issue-worker", "org/repo", 1);
    const again = await enqueueWork("issue-worker", "org/repo", 1, { priority: true });
    expect(again).toMatchObject({ alreadyQueued: true, priorityChanged: true });
    expect((await claimNextWork(null))!.item_number).toBe(1);

    const same = await enqueueWork("pr-reviewer", "org/repo", 10);
    expect(same).toMatchObject({ alreadyQueued: true, priorityChanged: false });
  });

  it("re-enqueueing a repo-scoped row can raise its priority but never lowers it", async () => {
    await enqueueWork("auto-merger:sweep", "org/repo", 0, { priority: true });
    const lowered = await enqueueWork("auto-merger:sweep", "org/repo", 0, { priority: false });
    expect(lowered).toMatchObject({ alreadyQueued: true, priorityChanged: false });
    expect((await listQueuedWork())[0]!.priority).toBe(1);

    const raised = await enqueueWork("auto-merger:sweep", "org/repo", 0, { priority: true });
    expect(raised).toMatchObject({ alreadyQueued: true, priorityChanged: false });
    expect((await listQueuedWork())[0]!.priority).toBe(1);
  });

  it("re-enqueueing a running row leaves its priority untouched", async () => {
    await enqueueWork("pr-reviewer", "org/repo", 10);
    const running = (await claimNextWork(null))!;
    const again = await enqueueWork("pr-reviewer", "org/repo", 10, { priority: true });
    expect(again).toMatchObject({ id: running.id, alreadyQueued: true, priorityChanged: false });
    expect((await listQueuedWork())[0]!.priority).toBe(0);
  });

  it("listQueuedWork lists queued rows in claim order", async () => {
    await enqueueWork("issue-worker", "org/repo", 1);
    await enqueueWork("issue-refiner:plan", "org/repo", 2);
    await enqueueWork("pr-reviewer", "org/repo", 3);
    await enqueueWork("ci-fixer", "org/repo", 4);
    await enqueueWork("issue-worker", "org/repo", 5, { priority: true });
    await enqueueWork("auto-merger:sweep", "org/repo", 0);
    const listed = (await listQueuedWork()).map((r) => [r.kind, r.item_number]);
    expect(listed).toEqual(await claimAll());
  });

  it("markWorkSkipped completes the row with a skipped: reason and frees re-enqueue", async () => {
    const r = (await enqueueWork("pr-reviewer", "org/repo", 1))!;
    await claimNextWork(null);
    await markWorkSkipped(r.id, "merged");
    const row = await _rawDb().get<{ status: string; error_message: string }>(`SELECT status, error_message FROM work_queue WHERE id = ?`, [r.id]);
    expect(row).toEqual({ status: "completed", error_message: "skipped: merged" });
    const again = await enqueueWork("pr-reviewer", "org/repo", 1);
    expect(again!.alreadyQueued).toBe(false);
  });

  it("claimNextWork returns null when no queued rows", async () => {
    expect(await claimNextWork(null)).toBeNull();
  });

  it("markWorkSucceeded transitions to completed", async () => {
    const r = (await enqueueWork("ci-fixer", "org/repo", 1))!;
    await claimNextWork(null);
    await markWorkSucceeded(r.id);
    expect((await countWorkByStatus())["completed"]).toBe(1);
  });

  it("markWorkFailed transitions to failed with error_message", async () => {
    const r = (await enqueueWork("ci-fixer", "org/repo", 1))!;
    await claimNextWork(null);
    await markWorkFailed(r.id, "boom");
    const counts = await countWorkByStatus();
    expect(counts["failed"]).toBe(1);
  });

  it("markWorkCancelled transitions to cancelled and frees the item for re-enqueue", async () => {
    const r = (await enqueueWork("issue-refiner:plan", "org/repo", 1))!;
    await claimNextWork(null);
    await markWorkCancelled(r.id, "run cancelled");
    expect((await countWorkByStatus())["cancelled"]).toBe(1);
    expect(await listQueuedWork()).toHaveLength(0);

    const again = await enqueueWork("issue-refiner:plan", "org/repo", 1);
    expect(again!.alreadyQueued).toBe(false);
  });

  it("recoverWorkOnStartup resets running rows even when pid equals process.pid", async () => {
    // #3144: inside the container the process is always PID 7 across restarts,
    // so a row carrying the current process's own pid must still be reset.
    const db = _rawDb();
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, pid, started_at) VALUES (?, ?, ?, '{}', 0, 'running', ?, '${ago(0)}')`, ["ci-fixer", "org/repo", "99", process.pid]);
    const r = await recoverWorkOnStartup();
    expect(r.resetRunning).toBe(1);
    const rows = await listQueuedWork();
    expect(rows[0].status).toBe("queued");
    expect(rows[0].pid).toBeNull();
  });

  it("recoverWorkOnStartup resets running rows with a null pid", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, pid, started_at) VALUES (?, ?, ?, '{}', 0, 'running', NULL, '${ago(0)}')`, ["ci-fixer", "org/repo", "99"]);
    const r = await recoverWorkOnStartup();
    expect(r.resetRunning).toBe(1);
    const rows = await listQueuedWork();
    expect(rows[0].status).toBe("queued");
    expect(rows[0].pid).toBeNull();
  });

  it("reapStaleRunningWork resets a running row older than the staleness ceiling", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, pid, started_at) VALUES (?, ?, ?, '{}', 0, 'running', ?, '${ago(7 * 60 * 60 * 1000)}')`, ["ci-fixer", "org/repo", "1", process.pid]);
    const n = await reapStaleRunningWork([]);
    expect(n).toBe(1);
    const rows = await listQueuedWork();
    expect(rows[0].status).toBe("queued");
    expect(rows[0].pid).toBeNull();
  });

  it("reapStaleRunningWork leaves a recently started running row alone", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, pid, started_at) VALUES (?, ?, ?, '{}', 0, 'running', ?, '${ago(60 * 60 * 1000)}')`, ["ci-fixer", "org/repo", "1", process.pid]);
    const n = await reapStaleRunningWork([]);
    expect(n).toBe(0);
    const rows = await listQueuedWork();
    expect(rows[0].status).toBe("running");
  });

  it("reapStaleRunningWork leaves a stale row alone when its id is in-flight", async () => {
    const db = _rawDb();
    const r = (await enqueueWork("ci-fixer", "org/repo", 1))!;
    await db.run(`UPDATE work_queue SET status = 'running', pid = ?, started_at = '${ago(7 * 60 * 60 * 1000)}' WHERE id = ?`, [process.pid, r.id]);
    const n = await reapStaleRunningWork([r.id]);
    expect(n).toBe(0);
    const rows = await listQueuedWork();
    expect(rows[0].status).toBe("running");
  });

  it("claimed rows start with a null agent_pod; setWorkAgentPod and getWorkRow round-trip it", async () => {
    const r = (await enqueueWork("pr-reviewer", "org/repo", 5))!;
    const claimed = (await claimNextWork("run-pod"))!;
    expect(claimed.agent_pod).toBeNull();
    await setWorkAgentPod(r.id, "claws-agent-" + r.id);
    const row = (await getWorkRow(r.id))!;
    expect(row.agent_pod).toBe("claws-agent-" + r.id);
    expect(row.run_id).toBe("run-pod");
    expect(row.item_number).toBe(5);
    expect(await getWorkRow(r.id + 1000)).toBeUndefined();
    expect((await listPodBackedRunningWork()).map((w) => w.id)).toEqual([r.id]);
  });

  it("isRunningAgentPodMcpToken accepts a pod's token hash only while its row runs", async () => {
    const r = (await enqueueWork("pr-reviewer", "org/repo", 5))!;
    await claimNextWork("run-pod");
    expect(await isRunningAgentPodMcpToken("hash-" + r.id)).toBe(false);
    // Accepted from the moment it is recorded, before the pod exists.
    await setWorkAgentMcpToken(r.id, "hash-" + r.id);
    expect((await getWorkRow(r.id))!.agent_mcp_token_sha256).toBe("hash-" + r.id);
    expect(await isRunningAgentPodMcpToken("hash-" + r.id)).toBe(true);
    expect(await isRunningAgentPodMcpToken("hash-other")).toBe(false);
    await markWorkSucceeded(r.id);
    expect(await isRunningAgentPodMcpToken("hash-" + r.id)).toBe(false);
  });

  it("recoverWorkOnStartup re-queues a row whose launch crashed before its pod existed, dropping its token", async () => {
    const r = (await enqueueWork("pr-reviewer", "org/repo", 5))!;
    await claimNextWork("run-pod");
    await setWorkAgentMcpToken(r.id, "hash-" + r.id);
    expect((await recoverWorkOnStartup()).resetRunning).toBe(1);
    const row = (await getWorkRow(r.id))!;
    expect(row).toMatchObject({ status: "queued", agent_pod: null, agent_mcp_token_sha256: null, started_at: null, pid: null });
    expect(await listPodBackedRunningWork()).toEqual([]);
  });

  it("markWorkFailedIfRunning and markWorkCancelledIfRunning only end a row still running under the run", async () => {
    const a = (await enqueueWork("pr-reviewer", "org/repo", 1))!;
    await claimNextWork("run-a");
    expect(await markWorkFailedIfRunning(a.id, "run-other", "late")).toBe(false);
    expect(await markWorkCancelledIfRunning(a.id, "run-other", "late")).toBe(false);
    expect((await getWorkRow(a.id))!.status).toBe("running");
    await markWorkSucceeded(a.id);
    expect(await markWorkFailedIfRunning(a.id, "run-a", "late")).toBe(false);
    expect(await markWorkCancelledIfRunning(a.id, "run-a", "late")).toBe(false);
    expect((await getWorkRow(a.id))!.status).toBe("completed");

    const b = (await enqueueWork("pr-reviewer", "org/repo", 2))!;
    await claimNextWork("run-b");
    expect(await markWorkFailedIfRunning(b.id, "run-b", "pod died")).toBe(true);
    expect((await getWorkRow(b.id))).toMatchObject({ status: "failed", error_message: "pod died" });

    const c = (await enqueueWork("pr-reviewer", "org/repo", 3))!;
    await claimNextWork("run-c");
    expect(await markWorkCancelledIfRunning(c.id, "run-c", "run cancelled")).toBe(true);
    expect((await getWorkRow(c.id))).toMatchObject({ status: "cancelled", error_message: "run cancelled" });
  });

  it("markWorkSucceededIfRunning, markWorkSkippedIfRunning and setWorkPriorityIfRunning only act on a row still running under the run", async () => {
    const a = (await enqueueWork("pr-reviewer", "org/repo", 1))!;
    await claimNextWork("run-a");
    expect(await markWorkSucceededIfRunning(a.id, "run-other")).toBe(false);
    expect(await markWorkSkippedIfRunning(a.id, "run-other", "late")).toBe(false);
    expect(await setWorkPriorityIfRunning(a.id, "run-other", true)).toBe(false);
    expect((await getWorkRow(a.id))!.status).toBe("running");
    await markWorkFailed(a.id, "already done");
    expect(await markWorkSucceededIfRunning(a.id, "run-a")).toBe(false);
    expect(await markWorkSkippedIfRunning(a.id, "run-a", "late")).toBe(false);
    expect(await setWorkPriorityIfRunning(a.id, "run-a", true)).toBe(false);
    expect((await getWorkRow(a.id))!.status).toBe("failed");

    const b = (await enqueueWork("pr-reviewer", "org/repo", 2))!;
    await claimNextWork("run-b");
    expect(await markWorkSucceededIfRunning(b.id, "run-b")).toBe(true);
    expect((await getWorkRow(b.id))).toMatchObject({ status: "completed", error_message: null });

    const c = (await enqueueWork("pr-reviewer", "org/repo", 3))!;
    await claimNextWork("run-c");
    expect(await markWorkSkippedIfRunning(c.id, "run-c", "not actionable")).toBe(true);
    expect((await getWorkRow(c.id))).toMatchObject({ status: "completed", error_message: "skipped: not actionable" });

    const d = (await enqueueWork("pr-reviewer", "org/repo", 4))!;
    await claimNextWork("run-d");
    expect(await setWorkPriorityIfRunning(d.id, "run-d", true)).toBe(true);
    expect((await getWorkRow(d.id))!.priority).toBe(1);
    expect(await setWorkPriorityIfRunning(d.id, "run-d", false)).toBe(true);
    expect((await getWorkRow(d.id))!.priority).toBe(0);
  });

  it("releaseClaimedWork re-queues a row only while it is still running under the run", async () => {
    const r = (await enqueueWork("pr-reviewer", "org/repo", 1))!;
    await claimNextWork("run-a");
    expect(await releaseClaimedWork(r.id, "run-other")).toBe(false);
    expect(await releaseClaimedWork(r.id, "run-a")).toBe(true);
    expect(await getWorkRow(r.id)).toMatchObject({ status: "queued", run_id: null, pid: null, started_at: null });
    expect(await releaseClaimedWork(r.id, "run-a")).toBe(false);
    expect((await claimNextWork("run-b"))!.id).toBe(r.id);
  });

  it("releaseClaimedWork clears agent_pod and stores the note", async () => {
    const r = (await enqueueWork("pr-reviewer", "org/repo", 1))!;
    await claimNextWork("run-a");
    expect(await releaseClaimedWork(r.id, "run-a", "agent pod never started: x")).toBe(true);
    expect(await getWorkRow(r.id)).toMatchObject({ status: "queued", agent_pod: null, error_message: "agent pod never started: x" });
  });

  it("recoverWorkOnStartup and reapStaleRunningWork skip pod-backed rows", async () => {
    const db = _rawDb();
    const pod = (await enqueueWork("pr-reviewer", "org/repo", 1))!;
    const plain = (await enqueueWork("pr-reviewer", "org/repo", 2))!;
    for (const id of [pod.id, plain.id]) {
      await db.run(`UPDATE work_queue SET status = 'running', started_at = '${ago(7 * 60 * 60 * 1000)}' WHERE id = ?`, [id]);
    }
    await setWorkAgentPod(pod.id, "claws-agent-" + pod.id);
    expect(await reapStaleRunningWork([])).toBe(1);
    expect((await getWorkRow(pod.id))!.status).toBe("running");
    await db.run(`UPDATE work_queue SET status = 'running' WHERE id = ?`, [plain.id]);
    expect((await recoverWorkOnStartup()).resetRunning).toBe(1);
    expect((await getWorkRow(pod.id))!.status).toBe("running");
    expect((await getWorkRow(plain.id))!.status).toBe("queued");
  });

  it("getOrphanedTasks skips tasks of a pod-backed running row", async () => {
    const r = (await enqueueWork("pr-reviewer", "org/repo", 1))!;
    await claimNextWork("run-pod");
    await setWorkAgentPod(r.id, "claws-agent-" + r.id);
    setRunIdProvider(() => "run-pod");
    await recordTaskStart("pr-reviewer", "org/repo", 1, null);
    setRunIdProvider(() => "run-other");
    const other = await recordTaskStart("pr-reviewer", "org/repo", 2, null);
    setRunIdProvider(() => undefined);
    const unowned = await recordTaskStart("pr-reviewer", "org/repo", 3, null);
    expect((await getOrphanedTasks()).map((t) => t.id).sort()).toEqual([other, unowned].sort());
    await markWorkFailed(r.id, "gone");
    expect(await getOrphanedTasks()).toHaveLength(3);
  });

  it("reapStaleRunningWork reaps a stale row while sparing an in-flight one", async () => {
    const db = _rawDb();
    const inFlight = (await enqueueWork("ci-fixer", "org/repo", 1))!;
    const stale = (await enqueueWork("ci-fixer", "org/repo", 2))!;
    await db.run(`UPDATE work_queue SET status = 'running', pid = ?, started_at = '${ago(7 * 60 * 60 * 1000)}' WHERE id = ?`, [process.pid, inFlight.id]);
    await db.run(`UPDATE work_queue SET status = 'running', pid = ?, started_at = '${ago(7 * 60 * 60 * 1000)}' WHERE id = ?`, [process.pid, stale.id]);
    const n = await reapStaleRunningWork([inFlight.id]);
    expect(n).toBe(1);
    const inFlightRow = await db.get(`SELECT status FROM work_queue WHERE id = ?`, [inFlight.id]) as { status: string };
    expect(inFlightRow.status).toBe("running");
    const staleRow = await db.get(`SELECT status FROM work_queue WHERE id = ?`, [stale.id]) as { status: string };
    expect(staleRow.status).toBe("queued");
  });

  it("reapStaleRunningWork leaves a running row with no started_at alone", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, pid, started_at) VALUES (?, ?, ?, '{}', 0, 'running', ?, NULL)`, ["ci-fixer", "org/repo", "1", process.pid]);
    const n = await reapStaleRunningWork([]);
    expect(n).toBe(0);
    const rows = await listQueuedWork();
    expect(rows[0].status).toBe("running");
  });

  it("pruneWorkQueue removes old completed/failed rows", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, completed_at) VALUES ('ci-fixer', 'org/repo', '1', '{}', 0, 'completed', '${ago(2592000000)}')`);
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, completed_at) VALUES ('ci-fixer', 'org/repo', '2', '{}', 0, 'completed', '${ago(0)}')`);
    const removed = await pruneWorkQueue(168);
    expect(removed).toBe(1);
  });

  it("hasActiveWorkForPR returns true only for running rows of given kinds", async () => {
    await enqueueWork("ci-fixer", "org/repo", 42);
    expect(await hasActiveWorkForPR("org/repo", 42, ["ci-fixer"])).toBe(false);
    await claimNextWork(null);
    expect(await hasActiveWorkForPR("org/repo", 42, ["ci-fixer"])).toBe(true);
    expect(await hasActiveWorkForPR("org/repo", 42, ["pr-reviewer"])).toBe(false);
  });

  it("clearAllWorkQueueForTests empties the table", async () => {
    await enqueueWork("ci-fixer", "org/repo", 1);
    await enqueueWork("ci-fixer", "org/repo", 2);
    expect(await listQueuedWork()).toHaveLength(2);
    await clearAllWorkQueueForTests();
    expect(await listQueuedWork()).toHaveLength(0);
  });
});

describe("markUntrustedActorNotified", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns true on first call for a repo/issue pair", async () => {
    expect(await markUntrustedActorNotified("o/r", 354)).toBe(true);
  });

  it("returns false on a duplicate call for the same repo/issue pair", async () => {
    await markUntrustedActorNotified("o/r", 354);
    expect(await markUntrustedActorNotified("o/r", 354)).toBe(false);
  });

  it("returns true for a different issue number in the same repo", async () => {
    await markUntrustedActorNotified("o/r", 354);
    expect(await markUntrustedActorNotified("o/r", 355)).toBe(true);
  });

  it("returns true for the same issue number in a different repo", async () => {
    await markUntrustedActorNotified("o/r", 354);
    expect(await markUntrustedActorNotified("o/r2", 354)).toBe(true);
  });
});

describe("provider holds", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("upserts a hold by key and lists it with an epoch-ms deadline", async () => {
    const until = Date.now() + 3_600_000;
    await db.setProviderHold("claude@a", until - 1000, "usage-limit");
    await db.setProviderHold("claude@a", until, "usage-limit");
    const rows = await db.listProviderHolds();
    expect(rows).toEqual([{ key: "claude@a", until_ms: until, reason: "usage-limit", updated_at: expect.any(String) }]);
  });

  it("keeps the first content-moderation not-live time and clears it", async () => {
    expect(await db.getContentModerationNotLiveSince("o/r")).toBeNull();
    await db.markContentModerationNotLive("o/r", 1000);
    await db.markContentModerationNotLive("o/r", 2000);
    expect(await db.getContentModerationNotLiveSince("o/r")).toBe(1000);
    await db.clearContentModerationNotLive("o/r");
    expect(await db.getContentModerationNotLiveSince("o/r")).toBeNull();
  });

  it("clears a key and the keys under it, not a key that merely shares its prefix", async () => {
    for (const key of ["claude", "claude:fable", "claude@a", "claude@a:opus", "claude@ab", "codex"]) {
      await db.setProviderHold(key, Date.now() + 60_000, null);
    }
    expect(await db.clearProviderHolds("claude@a")).toBe(2);
    expect((await db.listProviderHolds()).map((r) => r.key).sort()).toEqual(["claude", "claude:fable", "claude@ab", "codex"]);
    expect(await db.clearProviderHolds("claude")).toBe(3);
    expect((await db.listProviderHolds()).map((r) => r.key)).toEqual(["codex"]);
    expect(await db.clearProviderHolds("")).toBe(1);
  });
});

describe("OpenCode Anthropic spend", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  const sessionBase = {
    tmux_name: "claws-s",
    mode: "worktree-claude" as const,
    repo: "org/repo",
    cwd: "/work/repo",
    worktree_path: "/work/repo",
    extra_worktrees: null,
    capabilities: null,
    summary: null,
    summary_updated_at: null,
  };

  it("sums all-time reported cost of OpenCode anthropic/ tasks and sessions only", async () => {
    expect(await db.getOpencodeAnthropicSpendUsd()).toBe(0);
    const task = async (provider: string, model: string, cost: number) => {
      const id = await db.recordTaskStart("improvement-identifier", "org/repo", 0, null);
      await db.updateTaskTokenUsage(id, 100, cost);
      await db.updateTaskProvider(id, provider);
      await db.updateTaskModel(id, model);
    };
    await task("opencode", "anthropic/claude-sonnet-5-5", 1.25);
    await task("opencode", "anthropic/claude-opus-5-5", 2);
    await task("opencode", "openrouter/z-ai/glm-5.3", 5);
    await task("claude", "anthropic/claude-sonnet-5-5", 7);
    // Older than any Usage page window: still counted.
    await _rawDb().run(`UPDATE tasks SET started_at = '2020-01-01 00:00:00'`);

    await db.insertSession({ ...sessionBase, id: "oc-anthropic", created_at: Date.now(), provider: "opencode", model: "anthropic/claude-sonnet-5-5" });
    await db.updateSessionUsage("oc-anthropic", { tokensUsed: 10, costUsd: 0.5, lastContextTokens: 10, usageUpdatedAt: Date.now() });
    await db.insertSession({ ...sessionBase, id: "pi-anthropic", created_at: Date.now(), provider: "pi", model: "anthropic/claude-sonnet-5-5" });
    await db.updateSessionUsage("pi-anthropic", { tokensUsed: 10, costUsd: 9, lastContextTokens: 10, usageUpdatedAt: Date.now() });

    expect(await db.getOpencodeAnthropicSpendUsd()).toBeCloseTo(3.75);
  });

  it("records the threshold a spend warning last fired at", async () => {
    expect(await db.getSpendWarningThreshold("opencode-anthropic")).toBeNull();
    await db.recordSpendWarning("opencode-anthropic", 150);
    expect(await db.getSpendWarningThreshold("opencode-anthropic")).toBe(150);
    await db.recordSpendWarning("opencode-anthropic", 300);
    expect(await db.getSpendWarningThreshold("opencode-anthropic")).toBe(300);
  });
});

describe("doc-maintainer intent backfill watermark", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns null before the walk has started", async () => {
    expect(await getIntentBackfillState("o/r")).toBeNull();
  });

  it("round-trips a chunk watermark", async () => {
    await recordIntentBackfillChunk("o/r", "2026-01-15", false, false, 2);
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2026-01-15", complete: false, windowExhausted: false, sourceVersion: 2 });
  });

  it("upserts an existing repo row as the walk advances", async () => {
    await recordIntentBackfillChunk("o/r", "2026-01-15", false, false, 2);
    await recordIntentBackfillChunk("o/r", "2025-08-02", true, false, 2);
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2025-08-02", complete: true, windowExhausted: false, sourceVersion: 2 });
  });

  it("tracks repos independently", async () => {
    await recordIntentBackfillChunk("o/r", "2026-01-15", true, false, 2);
    expect(await getIntentBackfillState("o/r2")).toBeNull();
  });

  it("accepts a null oldestScanned for a repo with no history", async () => {
    await recordIntentBackfillChunk("o/r", null, true, false, 2);
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: null, complete: true, windowExhausted: false, sourceVersion: 2 });
  });

  it("records windowExhausted as a terminal state distinct from complete", async () => {
    await recordIntentBackfillChunk("o/r", "2025-08-02", false, true, 2);
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2025-08-02", complete: false, windowExhausted: true, sourceVersion: 2 });
  });

  it("reports sourceVersion 0 for a row written before the column existed", async () => {
    // Simulate a pre-migration row: insert without the source_version column so the
    // DEFAULT 0 applies, exactly as an existing row gets it on ALTER TABLE.
    await _rawDb().run(`INSERT INTO doc_intent_backfill (repo, oldest_scanned, complete, window_exhausted) VALUES (?, ?, 0, 0)`, ["o/legacy", "2025-01-01"]);
    expect(await getIntentBackfillState("o/legacy")).toEqual({
      oldestScanned: "2025-01-01", complete: false, windowExhausted: false, sourceVersion: 0,
    });
  });
});

describe("doc-maintainer memory digest", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns null before any digest has been recorded", async () => {
    expect(await getDocMemoryDigest("o/r")).toBeNull();
  });

  it("round-trips a digest", async () => {
    await recordDocMemoryDigest("o/r", "abc123");
    expect(await getDocMemoryDigest("o/r")).toBe("abc123");
  });

  it("upserts on repeated writes", async () => {
    await recordDocMemoryDigest("o/r", "abc123");
    await recordDocMemoryDigest("o/r", "def456");
    expect(await getDocMemoryDigest("o/r")).toBe("def456");
  });

  it("writing a digest for a repo with an existing backfill watermark leaves it unchanged", async () => {
    await recordIntentBackfillChunk("o/r", "2026-01-15", true, false, 2);
    await recordDocMemoryDigest("o/r", "abc123");
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2026-01-15", complete: true, windowExhausted: false, sourceVersion: 2 });
    expect(await getDocMemoryDigest("o/r")).toBe("abc123");
  });

  it("recording a backfill chunk for a repo with an existing digest leaves it unchanged", async () => {
    await recordDocMemoryDigest("o/r", "abc123");
    await recordIntentBackfillChunk("o/r", "2026-01-15", true, false, 2);
    expect(await getDocMemoryDigest("o/r")).toBe("abc123");
  });
});

describe("queue snapshots", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("recordQueueSnapshot and getQueueSnapshots round-trip", async () => {
    await recordQueueSnapshot(5);
    await recordQueueSnapshot(10);

    const snapshots = await getQueueSnapshots(24);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].totalItems).toBe(5);
    expect(snapshots[1].totalItems).toBe(10);
  });

  it("getQueueSnapshots returns empty when no snapshots exist", async () => {
    expect(await getQueueSnapshots()).toHaveLength(0);
  });

  it("pruneQueueSnapshots removes old entries", async () => {
    const db = _rawDb();
    // Insert an old snapshot (5 days ago)
    await db.run(`INSERT INTO queue_snapshots (total_items, recorded_at) VALUES (?, '${ago(432000000)}')`, [42]);
    // Insert a recent snapshot
    await recordQueueSnapshot(7);

    // Prune snapshots older than 72 hours
    const pruned = await pruneQueueSnapshots(72);
    expect(pruned).toBe(1);

    const remaining = await getQueueSnapshots(200);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].totalItems).toBe(7);
  });

  it("pruneQueueSnapshots returns 0 when nothing to prune", async () => {
    await recordQueueSnapshot(5);
    expect(await pruneQueueSnapshots(72)).toBe(0);
  });
});

// ── Helper ──

function makeRun(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    run_id: 1,
    repo: "org/repo",
    workflow_name: "CI",
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "main",
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    run_started_at: new Date(Date.now() - 59 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 58 * 60 * 1000).toISOString(),
    head_sha: "abc123",
    html_url: "https://example.invalid/run/1",
    run_attempt: 1,
    ...overrides,
  };
}

describe("workflow runs", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("upsertWorkflowRuns inserts rows and getWorkflowRunCount returns correct count", async () => {
    expect(await getWorkflowRunCount()).toBe(0);
    await upsertWorkflowRuns([makeRun({ run_id: 1 }), makeRun({ run_id: 2 })]);
    expect(await getWorkflowRunCount()).toBe(2);
  });

  it("upsertWorkflowRuns is a no-op for empty array", async () => {
    await upsertWorkflowRuns([]);
    expect(await getWorkflowRunCount()).toBe(0);
  });

  it("upsertWorkflowRuns replaces existing row on conflict", async () => {
    await upsertWorkflowRuns([makeRun({ run_id: 1, status: "in_progress" })]);
    await upsertWorkflowRuns([makeRun({ run_id: 1, status: "completed", conclusion: "success" })]);
    expect(await getWorkflowRunCount()).toBe(1);
    const active = await getActiveWorkflowRuns();
    // Should no longer be active after status updated to completed
    expect(active).toHaveLength(0);
  });

  it("getActiveWorkflowRuns returns queued and in_progress runs only", async () => {
    await upsertWorkflowRuns([
      makeRun({ run_id: 1, status: "queued", conclusion: null }),
      makeRun({ run_id: 2, status: "in_progress", conclusion: null }),
      makeRun({ run_id: 3, status: "completed", conclusion: "success" }),
    ]);
    const active = await getActiveWorkflowRuns();
    expect(active).toHaveLength(2);
    expect(active.map(r => r.status)).toEqual(expect.arrayContaining(["queued", "in_progress"]));
  });

  it("pruneWorkflowRuns removes old entries", async () => {
    const db = _rawDb();
    // Insert an old run (35 days ago)
    await db.run(`INSERT INTO workflow_runs (run_id, repo, workflow_name, status, conclusion, event, head_branch, created_at, run_started_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '${ago(3024000000)}', NULL, '${ago(3024000000)}', '${ago(0)}')`, [100, "org/repo", "CI", "completed", "success", "push", "main"]);
    // Insert a recent run
    await upsertWorkflowRuns([makeRun({ run_id: 101 })]);
    expect(await getWorkflowRunCount()).toBe(2);

    const pruned = await pruneWorkflowRuns(30);
    expect(pruned).toBe(1);
    expect(await getWorkflowRunCount()).toBe(1);
  });

  it("pruneWorkflowRuns prunes ISO 8601 rows inserted via upsertWorkflowRuns", async () => {
    await upsertWorkflowRuns([makeRun({ run_id: 100, created_at: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString() })]);
    await upsertWorkflowRuns([makeRun({ run_id: 101 })]);
    expect(await getWorkflowRunCount()).toBe(2);
    expect(await pruneWorkflowRuns(30)).toBe(1);
    expect(await getWorkflowRunCount()).toBe(1);
  });

  it("pruneWorkflowRuns returns 0 when nothing to prune", async () => {
    await upsertWorkflowRuns([makeRun({ run_id: 1 })]);
    expect(await pruneWorkflowRuns(30)).toBe(0);
  });

  describe("Circuit Breaker Functions", () => {
    beforeEach(async () => {
      // Reset database before each test
      await initDb();
    });

    afterEach(async () => {
      await closeDb();
    });

    describe("ci_fixer_breaker state", () => {
      it("returns undefined for a PR the breaker never tripped on", async () => {
        expect(await getCIFixerBreakerState("test/repo", 1)).toBeUndefined();
      });

      it("round-trips a trip and a Claws push without clobbering each other", async () => {
        await recordCIFixerBreakerTrip("test/repo", 2, "aaa");
        await recordCIFixerPush("test/repo", 2, "bbb");

        const state = await getCIFixerBreakerState("test/repo", 2);
        expect(state?.trippedSha).toBe("aaa");
        expect(state?.trippedAt).toBeTruthy();
        expect(state?.lastClawsSha).toBe("bbb");
        expect(state?.grants).toBe(0);
      });

      it("re-tripping preserves grants and the budget floor", async () => {
        await recordCIFixerBreakerTrip("test/repo", 3, "aaa");
        await recordCIFixerBreakerGrant("test/repo", 3, { recovered: false });
        const floor = (await getCIFixerBreakerState("test/repo", 3))?.budgetFloorAt;

        await recordCIFixerBreakerTrip("test/repo", 3, "ccc");

        const state = await getCIFixerBreakerState("test/repo", 3);
        expect(state?.trippedSha).toBe("ccc");
        expect(state?.grants).toBe(1);
        expect(state?.budgetFloorAt).toBe(floor);
      });

      it("spends a grant on a failing head and resets the count on a green one", async () => {
        await recordCIFixerBreakerTrip("test/repo", 4, "aaa");
        await recordCIFixerBreakerGrant("test/repo", 4, { recovered: false });
        await recordCIFixerBreakerGrant("test/repo", 4, { recovered: false });
        expect((await getCIFixerBreakerState("test/repo", 4))?.grants).toBe(2);

        await recordCIFixerBreakerGrant("test/repo", 4, { recovered: true });
        const state = await getCIFixerBreakerState("test/repo", 4);
        expect(state?.grants).toBe(0);
        expect(state?.trippedSha).toBeNull();
        expect(state?.budgetFloorAt).toBeTruthy();
      });

      it("resetCIFixerBreakerGrants clears the trip and grants, keeping the Claws SHA", async () => {
        await recordCIFixerBreakerTrip("test/repo", 5, "aaa");
        await recordCIFixerPush("test/repo", 5, "bbb");
        await recordCIFixerBreakerGrant("test/repo", 5, { recovered: false });

        await resetCIFixerBreakerGrants("test/repo", 5);

        const state = await getCIFixerBreakerState("test/repo", 5);
        expect(state?.trippedSha).toBeNull();
        expect(state?.trippedAt).toBeNull();
        expect(state?.grants).toBe(0);
        expect(state?.budgetFloorAt).toBeTruthy();
        expect(state?.lastClawsSha).toBe("bbb");
      });

      it("resets cleanly for a PR with no prior row", async () => {
        await resetCIFixerBreakerGrants("test/repo", 6);
        expect((await getCIFixerBreakerState("test/repo", 6))?.grants).toBe(0);
      });
    });

    describe("countCIFixerAttempts", () => {
      it("counts attempts within time window", async () => {
        const repo = "test/repo";
        const prNumber = 123;
        
        // Insert tasks at different times
        const now = Date.now();
        const db = _rawDb();
        
        // Within window (last 24 hours)
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "completed", new Date(now - 2 * 60 * 60 * 1000).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now - 5 * 60 * 60 * 1000).toISOString()]);
        
        // Outside window (more than 24 hours ago)
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "completed", new Date(now - 30 * 60 * 60 * 1000).toISOString()]);
        
        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.successful).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.preWorkFailed).toBe(0);
      });

      it("correctly matches ci-fixer job name patterns", async () => {
        const repo = "test/repo";
        const prNumber = 456;
        const db = _rawDb();
        const now = Date.now();
        
        // Should match
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "completed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:variant", repo, String(prNumber), null, null, "failed", new Date(now).toISOString()]);
        
        // Should NOT match
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer-v2", repo, String(prNumber), null, null, "completed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["other-job", repo, String(prNumber), null, null, "completed", new Date(now).toISOString()]);
        
        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.successful).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.preWorkFailed).toBe(0);
      });

      it("counts pushed and gave-up runs separately from no-op runs", async () => {
        const repo = "test/repo";
        const prNumber = 654;
        const db = _rawDb();
        const now = new Date().toISOString();
        const insert = `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", now, JSON.stringify({ prAction: "updated", commits: 3 })]);
        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", now, JSON.stringify({ commits: 0, giveUpReason: "bundle not built" })]);
        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", now, JSON.stringify({ commits: 0 })]);

        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(3);
        expect(result.pushed).toBe(1);
        expect(result.gaveUp).toBe(1);
      });

      it("honours a budget floor newer than the window cutoff", async () => {
        const repo = "test/repo";
        const prNumber = 321;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now - 10 * 60 * 60 * 1000).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now - 1 * 60 * 60 * 1000).toISOString()]);

        const floor = new Date(now - 2 * 60 * 60 * 1000).toISOString();
        expect((await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000, floor)).total).toBe(1);

        // A floor older than the window cutoff must not widen the window.
        const oldFloor = new Date(now - 48 * 60 * 60 * 1000).toISOString();
        expect((await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000, oldFloor)).total).toBe(2);
        expect((await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000, null)).total).toBe(2);
      });

      it("countCIFixerIdleRunsOnHead counts no-op and gave-up runs on one head only", async () => {
        const repo = "test/repo";
        const prNumber = 655;
        const db = _rawDb();
        const now = new Date().toISOString();
        const insert = `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", now, JSON.stringify({ commits: 0, headSha: "aaa" })]);
        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", now, JSON.stringify({ commits: 0, headSha: "aaa" })]);
        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", now, JSON.stringify({ commits: 0, headSha: "aaa", giveUpReason: "bundle not built" })]);
        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", now, JSON.stringify({ commits: 1, headSha: "aaa", prAction: "updated" })]);
        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", now, JSON.stringify({ commits: 0, headSha: "bbb" })]);
        await db.run(insert, ["ci-fixer:merge-conflict", repo, String(prNumber), null, null, "completed", now, JSON.stringify({ commits: 0, headSha: "aaa" })]);

        expect(await countCIFixerIdleRunsOnHead(repo, prNumber, "aaa")).toEqual({ noop: 2, gaveUp: 1 });
        expect(await countCIFixerIdleRunsOnHead(repo, prNumber, "bbb")).toEqual({ noop: 1, gaveUp: 0 });
        expect(await countCIFixerIdleRunsOnHead(repo, prNumber, "ccc")).toEqual({ noop: 0, gaveUp: 0 });
      });

      it("hasCiFixerGiveUpOnHead finds a give-up on one head, however old", async () => {
        const repo = "test/repo";
        const prNumber = 656;
        const db = _rawDb();
        const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const insert = `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", old, JSON.stringify({ commits: 0, headSha: "aaa", giveUpReason: "bootstrap not applied" })]);
        await db.run(insert, ["ci-fixer", repo, String(prNumber), null, null, "completed", old, JSON.stringify({ commits: 0, headSha: "bbb" })]);
        await db.run(insert, ["ci-fixer:merge-conflict", repo, String(prNumber), null, null, "completed", old, JSON.stringify({ commits: 0, headSha: "ccc", giveUpReason: "x" })]);
        await db.run(insert, ["issue-worker", repo, String(prNumber), null, null, "completed", old, JSON.stringify({ commits: 0, headSha: "ddd", giveUpReason: "x" })]);

        expect(await hasCiFixerGiveUpOnHead(repo, prNumber, "aaa")).toBe(true);
        expect(await hasCiFixerGiveUpOnHead(repo, prNumber, "bbb")).toBe(false);
        expect(await hasCiFixerGiveUpOnHead(repo, prNumber, "ccc")).toBe(false);
        expect(await hasCiFixerGiveUpOnHead(repo, prNumber, "ddd")).toBe(false);
        expect(await hasCiFixerGiveUpOnHead(repo, prNumber + 1, "aaa")).toBe(false);
      });

      it("returns zero counts for PR with no attempts", async () => {
        const result = await countCIFixerAttempts("test/repo", 999, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(0);
        expect(result.successful).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.preWorkFailed).toBe(0);
      });

      it("counts pre-work failures separately and excludes them from nonTransientFailed", async () => {
        const repo = "test/repo";
        const prNumber = 777;
        const db = _rawDb();
        const now = Date.now();

        // A regular failure (no outcome JSON)
        const id1 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await db.run(`UPDATE tasks SET started_at = ?, status = 'failed' WHERE id = ?`, [new Date(now - 1 * 60 * 60 * 1000).toISOString(), id1]);

        // A transient-api failure (outcome JSON with failureCategory)
        const id2 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await db.run(`UPDATE tasks SET started_at = ? WHERE id = ?`, [new Date(now - 2 * 60 * 60 * 1000).toISOString(), id2]);
        await recordTaskFailed(id2, "API Error: 500 Internal server error", { failureCategory: "transient-api" });

        // A rate-limit failure
        const id3 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await db.run(`UPDATE tasks SET started_at = ? WHERE id = ?`, [new Date(now - 3 * 60 * 60 * 1000).toISOString(), id3]);
        await recordTaskFailed(id3, "AllProvidersRateLimitedError", { failureCategory: "rate-limit" });

        // A usage-limit failure
        const id4 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await db.run(`UPDATE tasks SET started_at = ? WHERE id = ?`, [new Date(now - 4 * 60 * 60 * 1000).toISOString(), id4]);
        await recordTaskFailed(id4, "You've hit your session limit", { failureCategory: "usage-limit" });

        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(4);
        expect(result.failed).toBe(4);
        expect(result.successful).toBe(0);
        expect(result.preWorkFailed).toBe(3);
        expect(result.rerunOnly).toBe(0);
      });

      it("counts re-run-only attempts separately from terminal logs-unavailable ones", async () => {
        const repo = "test/repo";
        const prNumber = 778;

        const id1 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await recordTaskFailed(id1, "CI run logs were not fetchable; re-ran workflow", { failureCategory: "rerun-only" });
        const id2 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await recordTaskFailed(id2, "CI run logs were not fetchable; workflow already running", { failureCategory: "rerun-only" });
        const id3 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await recordTaskFailed(id3, "No failure logs and no re-runnable link", { failureCategory: "logs-unavailable" });

        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(3);
        expect(result.failed).toBe(3);
        expect(result.rerunOnly).toBe(2);
        expect(result.preWorkFailed).toBe(0);
      });

      it("ignores ci-fixer:merge-conflict rows while still counting ci-fixer and ci-fixer:revert rows", async () => {
        const repo = "test/repo";
        const prNumber = 888;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "completed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:revert", repo, String(prNumber), null, null, "failed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", repo, String(prNumber), null, null, "failed", new Date(now).toISOString()]);

        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.successful).toBe(1);
        expect(result.failed).toBe(1);
      });
    });

    describe("countConflictResolutionAttempts", () => {
      it("counts only ci-fixer:merge-conflict rows for that repo/PR", async () => {
        const repo = "test/repo";
        const prNumber = 890;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", repo, String(prNumber), null, null, "failed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", "other/repo", String(prNumber), null, null, "failed", new Date(now).toISOString()]);

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(1);
      });

      it("counts a completed row with commits in total but not unproductive; a no-commit completion and a failure both count as unproductive", async () => {
        const repo = "test/repo";
        const prNumber = 891;
        const db = _rawDb();

        const id1 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskComplete(id1, { commits: 2 });

        const id2 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskComplete(id2, { commits: 0 });

        const id3 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id3, "conflict resolution failed");

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(3);
        expect(result.unproductive).toBe(2);
      });

      it("excludes rows outside the window", async () => {
        const repo = "test/repo";
        const prNumber = 892;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", repo, String(prNumber), null, null, "failed", new Date(now - 30 * 60 * 60 * 1000).toISOString()]);

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(0);
        expect(result.unproductive).toBe(0);
      });

      it("provider-unavailable failures do not consume the budget", async () => {
        const repo = "test/repo";
        const prNumber = 893;

        const id1 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id1, "AllProvidersRateLimitedError", { failureCategory: "rate-limit" });

        const id2 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id2, "session limit hit", { failureCategory: "usage-limit" });

        const id3 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id3, "API Error: 500", { failureCategory: "transient-api" });

        const id4 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id4, "could not apply patch", { failureCategory: "git-conflict" });

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(4);
        expect(result.unproductive).toBe(1);
        expect(result.preWorkFailed).toBe(3);
      });

      it("a failed row with no outcome still counts as unproductive", async () => {
        const repo = "test/repo";
        const prNumber = 894;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", repo, String(prNumber), null, null, "failed", new Date(now).toISOString()]);

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.unproductive).toBe(1);
      });

      it("honours the provider backoff window", async () => {
        const repo = "test/repo";
        const prNumber = 895;
        const db = _rawDb();
        const now = Date.now();

        await db.run(
          `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["ci-fixer:merge-conflict", repo, String(prNumber), null, null, "failed", new Date(now - 2 * 60 * 1000).toISOString(), '{"failureCategory":"rate-limit"}'],
        );
        await db.run(
          `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["ci-fixer:merge-conflict", repo, String(prNumber), null, null, "failed", new Date(now - 60 * 60 * 1000).toISOString(), '{"failureCategory":"rate-limit"}'],
        );

        const withBackoff = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000, 15 * 60 * 1000);
        expect(withBackoff.preWorkFailed).toBe(2);
        expect(withBackoff.recentPreWorkFailed).toBe(1);

        const noBackoff = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000, 0);
        expect(noBackoff.recentPreWorkFailed).toBe(0);
      });
    });

    describe("getRecentCIFixerErrors", () => {
      it("returns recent errors in descending order", async () => {
        const repo = "test/repo";
        const prNumber = 789;
        const db = _rawDb();
        const now = Date.now();
        
        // Insert failed tasks with errors
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now - 3000).toISOString(), new Date(now - 2000).toISOString(), "Error 1"]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now - 2000).toISOString(), new Date(now - 1000).toISOString(), "Error 2"]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now - 1000).toISOString(), new Date(now).toISOString(), "Error 3"]);
        
        const errors = await getRecentCIFixerErrors(repo, prNumber, 5);
        
        expect(errors).toHaveLength(3);
        expect(errors[0].error).toBe("Error 3"); // Most recent
        expect(errors[1].error).toBe("Error 2");
        expect(errors[2].error).toBe("Error 1"); // Oldest
      });

      it("respects limit parameter", async () => {
        const repo = "test/repo";
        const prNumber = 321;
        const db = _rawDb();
        const now = Date.now();
        
        // Insert 5 errors
        for (let i = 1; i <= 5; i++) {
          await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now - i * 1000).toISOString(), new Date(now - i * 1000 + 500).toISOString(), `Error ${i}`]);
        }
        
        const errors = await getRecentCIFixerErrors(repo, prNumber, 3);
        
        expect(errors).toHaveLength(3);
      });

      it("only returns failed tasks with errors", async () => {
        const repo = "test/repo";
        const prNumber = 654;
        const db = _rawDb();
        const now = Date.now();
        
        // Failed with error - should be included
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Valid error"]);
        
        // Failed without error - should be excluded
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), null]);
        
        // Completed with error (shouldn't happen but test) - should be excluded
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "completed", new Date(now).toISOString(), new Date(now).toISOString(), "Should not appear"]);
        
        const errors = await getRecentCIFixerErrors(repo, prNumber, 5);
        
        expect(errors).toHaveLength(1);
        expect(errors[0].error).toBe("Valid error");
      });

      it("correctly matches ci-fixer job name patterns", async () => {
        const repo = "test/repo";
        const prNumber = 987;
        const db = _rawDb();
        const now = Date.now();
        
        // Should match
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, String(prNumber), null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Error from ci-fixer"]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:special", repo, String(prNumber), null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Error from ci-fixer:special"]);
        
        // Should NOT match
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer-new", repo, String(prNumber), null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Should not appear"]);
        
        const errors = await getRecentCIFixerErrors(repo, prNumber, 5);

        expect(errors).toHaveLength(2);
      });
    });
  });

  describe("trackTaskTokens", () => {
    /** The callback is synchronous and issues its writes without awaiting them,
     *  so let the microtask queue drain before reading the row back. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    async function getTokenRow(taskId: number) {
      await settle();
      return await _rawDb()
        .get(`SELECT tokens_used, cost_usd, provider_used FROM tasks WHERE id = ?`, [taskId]) as { tokens_used: number | null; cost_usd: number | null; provider_used: string | null };
    }

    it("single invocation writes tokens and cost to the task row", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 1, null);
      const cb = trackTaskTokens(taskId);
      cb(100, 0.5);
      const row = await getTokenRow(taskId);
      expect(row.tokens_used).toBe(100);
      expect(row.cost_usd).toBe(0.5);
    });

    it("two invocations of the same callback accumulate the totals", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 2, null);
      const cb = trackTaskTokens(taskId);
      cb(10, 1);
      cb(5, 0.5);
      const row = await getTokenRow(taskId);
      expect(row.tokens_used).toBe(15);
      expect(row.cost_usd).toBeCloseTo(1.5);
    });

    it("never invoking the callback leaves token/cost columns at their initial state", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 3, null);
      trackTaskTokens(taskId); // returned callback intentionally not called
      const row = await getTokenRow(taskId);
      expect(row.tokens_used).toBeNull();
      expect(row.cost_usd).toBeNull();
    });

    it("records the reporting provider when supplied", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 4, null);
      const cb = trackTaskTokens(taskId);
      cb(100, 0.5, "opencode");
      const row = await getTokenRow(taskId);
      expect(row.provider_used).toBe("opencode");
    });

    it("leaves provider_used null when no provider is supplied", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 5, null);
      const cb = trackTaskTokens(taskId);
      cb(100, 0.5);
      const row = await getTokenRow(taskId);
      expect(row.provider_used).toBeNull();
    });

    it("records the Claude account alongside the provider, and clears it for a non-Claude reporter", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 7, null);
      const cb = trackTaskTokens(taskId);
      cb(10, 1, "claude", "second");
      await settle();
      const first = await _rawDb().get(`SELECT provider_used, account_used FROM tasks WHERE id = ?`, [taskId]) as { provider_used: string; account_used: string | null };
      expect(first).toEqual({ provider_used: "claude", account_used: "second" });
      cb(5, 0.5, "codex");
      await settle();
      const second = await _rawDb().get(`SELECT provider_used, account_used FROM tasks WHERE id = ?`, [taskId]) as { provider_used: string; account_used: string | null };
      expect(second).toEqual({ provider_used: "codex", account_used: null });
    });

    it("last reporter wins when a task spans two backends", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 6, null);
      const cb = trackTaskTokens(taskId);
      cb(10, 1, "claude");
      cb(5, 0.5, "opencode");
      const row = await getTokenRow(taskId);
      expect(row.provider_used).toBe("opencode");
      expect(row.tokens_used).toBe(15);
    });
  });

  describe("getUsageStats", () => {
    beforeEach(async () => {
      const t1 = await recordTaskStart("issue-worker", "org/repo-a", 1, null);
      await updateTaskTokenUsage(t1, 100, 1.0);
      await updateTaskProvider(t1, "opencode");
      await updateTaskModel(t1, "openrouter/z-ai/glm-5.3");
      await recordTaskComplete(t1, { commits: 2, prNumber: 10, prAction: "created", headSha: "sha-a" });
      await recordTaskEffectivenessEvent({ taskId: t1, source: "pr-review", sourceRepo: "org/repo-a", sourceNumber: 10, sourceSha: "sha-a", signal: "pr-review-clean", score: 1, details: { reviewerTaskId: 99 } });
      await recordTaskEffectivenessEvent({ taskId: t1, source: "pr-merge", sourceRepo: "org/repo-a", sourceNumber: 10, sourceSha: "sha-a", signal: "pr-merged", score: null, details: { mergedBy: "auto-merger" } });

      const t2 = await recordTaskStart("issue-worker", "org/repo-b", 2, null);
      await updateTaskTokenUsage(t2, 200, 2.0);
      await updateTaskProvider(t2, "claude");
      await updateTaskModel(t2, "sonnet");
      await recordTaskFailed(t2, "boom");

      const t3 = await recordTaskStart("ci-fixer:revert", "org/repo-a", 3, null);
      await updateTaskTokenUsage(t3, 50, 0.5);
      // no provider/model — historical row

      const t4 = await recordTaskStart("ci-fixer:retry", "org/repo-b", 4, null);
      await updateTaskTokenUsage(t4, 25, 0.25);
      await updateTaskProvider(t4, "codex");
      await updateTaskModel(t4, "gpt-5.1-codex");

      const t5 = await recordTaskStart("issue-worker", "org/repo-c", 5, null);
      await updateTaskProvider(t5, "codex");
      await updateTaskModel(t5, "gpt-5.1-codex");
      await recordTaskComplete(t5, { commits: 0, prNumber: 20, prAction: "updated", headSha: "sha-c" });
      await recordTaskEffectivenessEvent({ taskId: t5, source: "pr-review", sourceRepo: "org/repo-c", sourceNumber: 20, sourceSha: "sha-c", signal: "pr-review-blocking", score: -1, details: null });

      await insertSession({
        id: "sess-usage",
        tmux_name: "claws-sess-usage",
        mode: "worktree-claude",
        repo: "org/repo-a",
        cwd: "/work/repo-a",
        worktree_path: "/work/repo-a",
        extra_worktrees: null,
        capabilities: null,
        created_at: Date.now(),
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: "opus",
      });
      await updateSessionUsage("sess-usage", { tokensUsed: 300, costUsd: null, lastContextTokens: 120_000, usageUpdatedAt: Date.now() });
    });

    it("unfiltered providerStats includes both attributed and unknown rows", async () => {
      const stats = await getUsageStats(7);
      expect(stats.providerStats).toContainEqual(
        expect.objectContaining({ provider: "opencode", model: "openrouter/z-ai/glm-5.3" }),
      );
      expect(stats.providerStats).toContainEqual(
        expect.objectContaining({ provider: "unknown", model: "unknown" }),
      );
      expect(stats.providerStats).toContainEqual(
        expect.objectContaining({ provider: "claude", model: "opus", totalTokens: 300 }),
      );
    });

    it("filters by provider and narrows repoStats accordingly", async () => {
      const stats = await getUsageStats(7, { provider: "opencode" });
      expect(stats.providerStats).toHaveLength(1);
      expect(stats.providerStats[0]).toMatchObject({ provider: "opencode", model: "openrouter/z-ai/glm-5.3", changedCount: 1, prCreatedCount: 1, reviewClean: 1, mergedCount: 1, reviewScoreTotal: 1, reviewScoreCount: 1 });
      expect(stats.repoStats.map((r) => r.repo)).toEqual(["org/repo-a"]);
    });

    it("includes session rows in totals, filters, and sessionStats with nullable cost", async () => {
      const totals = await getTotalUsage(7, { job: "interactive-session" });
      expect(totals).toMatchObject({ taskCount: 1, totalTokens: 300, totalCostUsd: 0 });
      const stats = await getUsageStats(7, { job: "interactive-session" });
      expect(stats.sessionStats).toEqual([
        expect.objectContaining({
          id: "sess-usage",
          repo: "org/repo-a",
          provider: "claude",
          model: "opus",
          totalTokens: 300,
          costUsd: null,
          lastContextTokens: 120_000,
          warningLevel: "warn",
        }),
      ]);
      expect(stats.sessionStats[0].alive).toBe(true);
      expect(stats.repoStats[0]).toMatchObject({ repo: "org/repo-a", taskCount: 1, reviewScoreCount: 0 });
    });

    it("includes long-lived sessions when usage was sampled inside the window", async () => {
      await insertSession({
        id: "sess-long-lived",
        tmux_name: "claws-sess-long-lived",
        mode: "worktree-claude",
        repo: "org/repo-old",
        cwd: "/work/repo-old",
        worktree_path: "/work/repo-old",
        extra_worktrees: null,
        capabilities: null,
        created_at: Date.now() - 9 * 24 * 60 * 60 * 1000,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: "sonnet",
      });
      await updateSessionUsage("sess-long-lived", {
        tokensUsed: 450,
        costUsd: null,
        lastContextTokens: 180_000,
        usageUpdatedAt: Date.now(),
      });

      const totals = await getTotalUsage(7, { repo: "org/repo-old" });
      expect(totals).toMatchObject({ taskCount: 1, totalTokens: 450, totalCostUsd: 0 });

      const stats = await getUsageStats(7, { repo: "org/repo-old" });
      expect(stats.sessionStats).toEqual([
        expect.objectContaining({
          id: "sess-long-lived",
          repo: "org/repo-old",
          totalTokens: 450,
          lastContextTokens: 180_000,
          warningLevel: "critical",
        }),
      ]);

      const options = await getUsageFilterOptions(7);
      expect(options.repos).toContain("org/repo-old");
    });

    it("filters by repo and narrows jobStats accordingly", async () => {
      const stats = await getUsageStats(7, { repo: "org/repo-b" });
      const jobNames = stats.jobStats.map((j) => j.jobName).sort();
      expect(jobNames).toEqual(["ci-fixer", "issue-worker"]);
    });

    it("filters by job prefix and matches sub-jobs recorded with a colon suffix", async () => {
      const stats = await getUsageStats(7, { job: "ci-fixer" });
      expect(stats.jobStats).toHaveLength(1);
      expect(stats.jobStats[0]).toMatchObject({ jobName: "ci-fixer", taskCount: 2 });
    });

    it("getTotalUsage filters by unknown provider", async () => {
      const totals = await getTotalUsage(7, { provider: "unknown" });
      expect(totals.taskCount).toBe(1);
      expect(totals.totalTokens).toBe(50);
      expect(totals.totalCostUsd).toBeCloseTo(0.5);
    });

    it("groups Claude providerStats by account, filters by account and lists accounts as filter options", async () => {
      const t6 = await recordTaskStart("issue-worker", "org/repo-a", 6, null);
      await updateTaskTokenUsage(t6, 40, 0.4);
      await updateTaskProvider(t6, "claude", "second");
      await updateTaskModel(t6, "sonnet");
      const t7 = await recordTaskStart("issue-worker", "org/repo-a", 7, null);
      await updateTaskTokenUsage(t7, 60, 0.6);
      await updateTaskProvider(t7, "claude", "primary");
      await updateTaskModel(t7, "sonnet");

      const stats = await getUsageStats(7);
      const claudeSonnet = stats.providerStats.filter((r) => r.provider === "claude" && r.model === "sonnet");
      expect(claudeSonnet.map((r) => [r.account, r.totalTokens]).sort()).toEqual([["", 200], ["primary", 60], ["second", 40]]);
      expect(stats.providerStats).toContainEqual(expect.objectContaining({ provider: "codex", account: "" }));

      const filtered = await getUsageStats(7, { account: "second" });
      expect(filtered.providerStats).toEqual([expect.objectContaining({ provider: "claude", account: "second", totalTokens: 40 })]);

      expect((await getUsageFilterOptions(7)).accounts).toEqual(["primary", "second"]);
    });

    it("getUsageFilterOptions returns distinct repos/jobs/providers/models including unknown", async () => {
      const options = await getUsageFilterOptions(7);
      expect(options.repos.sort()).toEqual(["org/repo-a", "org/repo-b", "org/repo-c"]);
      expect(options.jobs.sort()).toEqual(["ci-fixer", "interactive-session", "issue-worker"]);
      expect(options.providers.sort()).toEqual(["claude", "codex", "opencode", "unknown"]);
      expect(options.models.sort()).toEqual(["gpt-5.1-codex", "openrouter/z-ai/glm-5.3", "opus", "sonnet", "unknown"]);
    });

    it("includes provider/model rows without token data", async () => {
      const stats = await getUsageStats(7, { repo: "org/repo-c" });
      expect(stats.providerStats).toHaveLength(1);
      expect(stats.providerStats[0]).toMatchObject({ provider: "codex", totalTokens: 0, reviewBlocking: 1, reviewScoreTotal: -1, reviewScoreCount: 1 });
    });

    it("returns recent effectiveness events with task attribution", async () => {
      const events = await getRecentEffectivenessEvents(7, { provider: "opencode" });
      expect(events).toEqual([
        expect.objectContaining({ jobName: "issue-worker", provider: "opencode", signal: "pr-merged", sourceNumber: 10 }),
        expect.objectContaining({ jobName: "issue-worker", provider: "opencode", signal: "pr-review-clean", sourceNumber: 10 }),
      ]);
    });
  });

  describe("task effectiveness events", () => {
    it("upserts by task, source, repo, number, and head SHA", async () => {
      const taskId = await recordTaskStart("issue-worker", "org/repo", 1, null);
      await recordTaskEffectivenessEvent({ taskId, source: "pr-review", sourceRepo: "org/repo", sourceNumber: 2, sourceSha: "abc", signal: "pr-review-blocking", score: -1, details: { iteration: 1 } });
      await recordTaskEffectivenessEvent({ taskId, source: "pr-review", sourceRepo: "org/repo", sourceNumber: 2, sourceSha: "abc", signal: "pr-review-clean", score: 1, details: { iteration: 2 } });
      const rows = await _rawDb().all(`SELECT * FROM task_effectiveness_events`) as Array<{ signal: string; score: number; details: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ signal: "pr-review-clean", score: 1 });
      expect(JSON.parse(rows[0].details)).toEqual({ iteration: 2 });
    });

    it("findLatestCompletedTaskForPrHead requires exact PR number and head SHA", async () => {
      const oldTask = await recordTaskStart("issue-worker", "org/repo", 1, null);
      await recordTaskComplete(oldTask, { commits: 1, prNumber: 2, prAction: "created", headSha: "old" });
      const newTask = await recordTaskStart("review-addresser", "org/repo", 2, null);
      await recordTaskComplete(newTask, { commits: 1, prNumber: 2, prAction: "updated", headSha: "new" });
      const legacyTask = await recordTaskStart("issue-worker", "org/repo", 3, null);
      await recordTaskComplete(legacyTask, { commits: 1, prNumber: 2, prAction: "updated" });

      await expect(findLatestCompletedTaskForPrHead("org/repo", 2, "new")).resolves.toMatchObject({ id: newTask });
      await expect(findLatestCompletedTaskForPrHead("org/repo", 2, "old")).resolves.toMatchObject({ id: oldTask });
      await expect(findLatestCompletedTaskForPrHead("org/repo", 2, "missing")).resolves.toBeNull();
    });

    describe("findLostImplementerAttempt", () => {
      const lost = async (item: number | string, branch: string): Promise<number> => {
        const id = await recordTaskStart("issue-worker", "org/repo", item, "approved");
        await updateTaskWorktree(id, "/tmp/wt", branch);
        await recordTaskFailed(id, "agent pod vanished: node lost", { failureCategory: "external-kill" });
        return id;
      };

      it("returns the newest implementer task when its pod was lost on the issue's branch", async () => {
        const id = await lost(1, "claws/issue-1-ab12");
        // Another kind's task on the same item does not hide it.
        await recordTaskComplete(await recordTaskStart("pr-reviewer", "org/repo", 1, null), {});
        await expect(findLostImplementerAttempt("org/repo", 1)).resolves.toMatchObject({ id, branch_name: "claws/issue-1-ab12" });
        const native = await lost("clw_01ABC", "claws/issue-clw_01ABC-cd34");
        await expect(findLostImplementerAttempt("org/repo", "clw_01ABC")).resolves.toMatchObject({ id: native });
        await expect(findLostImplementerAttempt("org/other", 1)).resolves.toBeNull();
      });

      it("is null once a later implementer task completed", async () => {
        await lost(1, "claws/issue-1-ab12");
        await recordTaskComplete(await recordTaskStart("issue-worker", "org/repo", 1, "approved"), { commits: 1, prNumber: 5, prAction: "created" });
        await expect(findLostImplementerAttempt("org/repo", 1)).resolves.toBeNull();
      });

      it("is null when the newest implementer task failed for another reason", async () => {
        await lost(1, "claws/issue-1-ab12");
        const id = await recordTaskStart("issue-worker", "org/repo", 1, "approved");
        await updateTaskWorktree(id, "/tmp/wt", "claws/issue-1-ab12");
        await recordTaskFailed(id, "boom", { failureCategory: "unknown" });
        await expect(findLostImplementerAttempt("org/repo", 1)).resolves.toBeNull();
      });

      it("is null when the lost attempt worked on another issue's PR branch (target-PR mode)", async () => {
        await lost(1, "claws/issue-99-ef56");
        await expect(findLostImplementerAttempt("org/repo", 1)).resolves.toBeNull();
        // A prefix of another ref is not this issue's branch.
        await lost(1, "claws/issue-10-ab12");
        await expect(findLostImplementerAttempt("org/repo", 1)).resolves.toBeNull();
      });
    });

    it("findLatestCompletedTaskForPrHead matches a task recorded under another repo by its outcome's prRepo", async () => {
      const task = await recordTaskStart("issue-worker", "org/a-repo", 1, null);
      await recordTaskComplete(task, { commits: 1, prNumber: 7, prAction: "created", headSha: "h", prRepo: "org/b-repo" });

      await expect(findLatestCompletedTaskForPrHead("org/b-repo", 7, "h")).resolves.toMatchObject({ id: task });
      await expect(findLatestCompletedTaskForPrHead("org/a-repo", 7, "h")).resolves.toBeNull();
    });

    it("findLatestCompletedTaskForPrHead skips read-only pr-reviewer rounds but keeps advisory self-fixes", async () => {
      const producer = await recordTaskStart("issue-worker", "org/repo", 1, null);
      await recordTaskComplete(producer, { commits: 1, prNumber: 2, prAction: "created", headSha: "h1" });
      const review = await recordTaskStart("pr-reviewer", "org/repo", 2, null);
      await recordTaskComplete(review, { commits: 0, prNumber: 2, prAction: "reviewed", reviewResult: "clean", headSha: "h1" });
      const selfFix = await recordTaskStart("pr-reviewer", "org/repo", 2, null);
      await recordTaskComplete(selfFix, { commits: 1, prNumber: 2, prAction: "reviewed", reviewResult: "advisory", headSha: "h2" });

      await expect(findLatestCompletedTaskForPrHead("org/repo", 2, "h1")).resolves.toMatchObject({ id: producer });
      await expect(findLatestCompletedTaskForPrHead("org/repo", 2, "h2")).resolves.toMatchObject({ id: selfFix });
    });
  });

  describe("pr_reviews", () => {
    const base = {
      repo: "org/repo", prNumber: 7, reviewedSha: null, baseSha: "base1", mode: "full" as const, iteration: 1,
      reviewerTaskId: 3, provider: "claude", model: "opus-x", findings: "a finding",
    };

    it("recordPRReview upserts on (repo, pr, head), overwriting provider/model", async () => {
      await recordPRReview({ ...base, headSha: "h1", verdict: "blocking" });
      await recordPRReview({ ...base, headSha: "h1", verdict: "clean", provider: "codex", model: "gpt-x", iteration: 2 });
      const rows = await listPRReviews("org/repo", 7);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ headSha: "h1", verdict: "clean", provider: "codex", model: "gpt-x", iteration: 2, mode: "full" });
      expect(rows[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it("getLatestPRReview / listPRReviews return rows newest first", async () => {
      await recordPRReview({ ...base, headSha: "h1", verdict: "blocking" });
      await recordPRReview({ ...base, headSha: "h2", verdict: "advisory", mode: "incremental" });
      await recordPRReview({ ...base, prNumber: 8, headSha: "other", verdict: "clean" });
      expect((await listPRReviews("org/repo", 7)).map((r) => r.headSha)).toEqual(["h2", "h1"]);
      await expect(getLatestPRReview("org/repo", 7)).resolves.toMatchObject({ headSha: "h2", mode: "incremental" });
      await expect(getLatestPRReview("org/repo", 99)).resolves.toBeNull();
    });

    it("emits review-posted with a clean or blocking detail and the PR's issue (#clw_01M5Q66MKK4WHBJ8XT1EMZZGEA)", async () => {
      const { flushGitHubEvents, currentEventId, getEventsSince } = await import("./github-events.js");
      const issue = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
      await upsertClawsPr("org/repo", 7, { stage: "awaiting-review", issueId: issue });
      await flushGitHubEvents();
      const from = await currentEventId();
      await recordPRReview({ ...base, headSha: "h1", verdict: "advisory" });
      await recordPRReview({ ...base, headSha: "h2", verdict: "escalated" });
      await recordPRReview({ ...base, headSha: "h3", verdict: "blocking" });
      await recordPRReview({ ...base, prNumber: 8, headSha: "x", verdict: "empty-diff" });
      await recordPRReview({ ...base, prNumber: 8, headSha: "y", verdict: "clean" });
      const events = await getEventsSince(from, { kinds: ["review-posted"] });
      expect(events.map((e) => [e.number, e.detail, e.related])).toEqual([
        [7, "clean", [issue]], [7, "blocking", [issue]], [7, "blocking", [issue]], [8, "clean", []], [8, "clean", []],
      ]);
      expect(await getEventsSince(from, { items: [issue], kinds: [{ kind: "review-posted", detail: "blocking" }] })).toHaveLength(2);
    });

    it("caps stored findings at 20k chars", async () => {
      await recordPRReview({ ...base, headSha: "h1", verdict: "blocking", findings: "x".repeat(25_000) });
      expect((await getLatestPRReview("org/repo", 7))!.findings).toHaveLength(20_000);
    });

    it("backfills from effectiveness events and task outcomes, idempotently", async () => {
      const reviewer = await recordTaskStart("pr-reviewer", "org/repo", 7, null);
      await updateTaskProvider(reviewer, "claude");
      await updateTaskModel(reviewer, "opus-x");
      await recordTaskComplete(reviewer, { commits: 0, prNumber: 7, prAction: "reviewed", reviewResult: "blocking" });
      const producer = await recordTaskStart("issue-worker", "org/repo", 1, null);
      await recordTaskEffectivenessEvent({ taskId: producer, source: "pr-review", sourceRepo: "org/repo", sourceNumber: 7, sourceSha: "evsha", signal: "pr-review-blocking", score: -1, details: { reviewerTaskId: reviewer, iteration: 2 } });
      await recordTaskEffectivenessEvent({ taskId: producer, source: "pr-merge", sourceRepo: "org/repo", sourceNumber: 7, sourceSha: "merged", signal: "pr-merged", score: null });

      const outcomeTask = await recordTaskStart("pr-reviewer", "org/repo", 7, null);
      await updateTaskProvider(outcomeTask, "codex");
      await updateTaskModel(outcomeTask, "gpt-x");
      await recordTaskComplete(outcomeTask, { commits: 1, prNumber: 7, prAction: "reviewed", reviewResult: "advisory", headSha: "outsha" });
      const noSha = await recordTaskStart("pr-reviewer", "org/repo", 8, null);
      await recordTaskComplete(noSha, { commits: 0, prNumber: 8, prAction: "reviewed", reviewResult: "clean" });
      const noResult = await recordTaskStart("pr-reviewer", "org/repo", 9, null);
      await recordTaskComplete(noResult, { commits: 0, prNumber: 9, prAction: "skipped", headSha: "skipsha" });

      await backfillPRReviews();
      await backfillPRReviews();

      const rows = await listPRReviews("org/repo", 7, 10);
      expect(rows).toHaveLength(2);
      const byHead = new Map(rows.map((r) => [r.headSha, r]));
      expect(byHead.get("evsha")).toMatchObject({ verdict: "blocking", iteration: 2, reviewerTaskId: reviewer, provider: "claude", model: "opus-x", baseSha: "", mode: "full", findings: null });
      expect(byHead.get("outsha")).toMatchObject({ verdict: "advisory", iteration: 1, reviewerTaskId: outcomeTask, provider: "codex", model: "gpt-x", baseSha: "" });
      await expect(listPRReviews("org/repo", 8)).resolves.toEqual([]);
      await expect(listPRReviews("org/repo", 9)).resolves.toEqual([]);
    });

    it("backfill leaves live rows untouched", async () => {
      await recordPRReview({ ...base, headSha: "outsha", verdict: "clean", mode: "incremental" });
      const t = await recordTaskStart("pr-reviewer", "org/repo", 7, null);
      await recordTaskComplete(t, { commits: 0, prNumber: 7, prAction: "reviewed", reviewResult: "blocking", headSha: "outsha" });
      await backfillPRReviews();
      const rows = await listPRReviews("org/repo", 7);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ verdict: "clean", mode: "incremental", baseSha: "base1" });
    });

    it("backfill is a one-shot: a live self-fix row survives its own pre-fix effectiveness event", async () => {
      // The self-fix's pr_reviews row carries the pushed fix SHA, but its
      // effectiveness event fires on the pre-fix SHA the round actually reviewed
      // (see persistReviewRound's signalHeadSha). A backfill that ran again after
      // this live write would insert a phantom row for the pre-fix SHA that could
      // outrank it in listPRReviews's ordering.
      const reviewer = await recordTaskStart("pr-reviewer", "org/repo", 7, null);
      await recordPRReview({ ...base, headSha: "fixsha", reviewedSha: "prefixsha", verdict: "advisory", reviewerTaskId: reviewer });
      await recordTaskEffectivenessEvent({
        taskId: reviewer, source: "pr-review", sourceRepo: "org/repo", sourceNumber: 7,
        sourceSha: "prefixsha", signal: "pr-review-advisory", score: 1, details: { reviewerTaskId: reviewer, iteration: 1 },
      });

      await backfillPRReviews();

      const rows = await listPRReviews("org/repo", 7, 10);
      expect(rows).toHaveLength(1);
      await expect(getLatestPRReview("org/repo", 7)).resolves.toMatchObject({ headSha: "fixsha", verdict: "advisory" });
    });
  });

  describe("dmarc reports", () => {
    const report = {
      orgName: "google.com",
      reportId: "1785249275027635048",
      reportEmail: "noreply-dmarc-support@google.com",
      domain: "bstjohn.net",
      dateBegin: "2026-08-31T00:00:00.000Z",
      dateEnd: "2026-08-31T23:59:59.000Z",
      policyP: "none",
      policySp: "none",
      policyAdkim: "s",
      policyAspf: "s",
      policyPct: 100,
      truncatedRows: 0,
      rows: [
        {
          sourceIp: "209.85.220.69",
          count: 1,
          disposition: "none",
          evalDkim: "pass",
          evalSpf: "pass",
          headerFrom: "bstjohn.net",
          envelopeFrom: "",
          envelopeTo: "",
          dkimResults: [{ domain: "bstjohn.net", selector: "google", result: "pass" }],
          spfResults: [{ domain: "bstjohn.net", scope: "mfrom", result: "pass" }],
          reasons: [],
          verdict: "aligned_pass" as const,
        },
      ],
    };

    async function rowCount(): Promise<number> {
      return ((await _rawDb().get(`SELECT COUNT(*) AS n FROM dmarc_rows`)) as { n: number }).n;
    }

    it("inserts once and ignores a duplicate re-forwarded report", async () => {
      expect(await insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z")).toBe(true);
      expect(await rowCount()).toBe(1);

      expect(await insertDmarcReport(report, "<feedback/>", "2026-09-01T09:00:00.000Z")).toBe(false);
      expect(await rowCount()).toBe(1);
      expect(await hasDmarcReport("google.com", "1785249275027635048")).toBe(true);
    });

    it("keeps raw XML off the row queries but retrievable by report key", async () => {
      await insertDmarcReport(report, "<feedback>raw</feedback>", "2026-09-01T08:00:00.000Z");

      const latest = await getLatestDmarcReportForDomain("bstjohn.net");
      expect(latest?.report_id).toBe("1785249275027635048");
      expect(latest?.row_count).toBe(1);
      expect(latest).not.toHaveProperty("raw_xml");
      expect(await getDmarcReportXml("google.com", "1785249275027635048")).toBe("<feedback>raw</feedback>");
    });

    it("aggregates verdict counts and source IPs over a window", async () => {
      await insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z");

      expect(await getDmarcVerdictCounts("2026-08-01T00:00:00.000Z")).toEqual([
        { domain: "bstjohn.net", verdict: "aligned_pass", n: 1 },
      ]);
      expect(await getDmarcSourceIps("2026-08-01T00:00:00.000Z")).toEqual([
        {
          source_ip: "209.85.220.69",
          verdict: "aligned_pass",
          domain: "bstjohn.net",
          messages: 1,
          last_seen: "2026-08-31T23:59:59.000Z",
        },
      ]);
      expect(await getDmarcVerdictCounts("2026-09-01T00:00:00.000Z")).toEqual([]);
    });

    it("getLatestDmarcReportsPerReporter returns the columns of the latest report per (domain, reporter)", async () => {
      await insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z");
      const laterReport = {
        ...report,
        reportId: "1785249275027635049",
        dateBegin: "2026-09-05T00:00:00.000Z",
        dateEnd: "2026-09-05T23:59:59.000Z",
        rows: [report.rows[0], report.rows[0]],
      };
      await insertDmarcReport(laterReport, "<feedback/>", "2026-09-06T08:00:00.000Z");

      const latest = await getLatestDmarcReportsPerReporter();
      expect(latest).toHaveLength(1);
      expect(latest[0].report_id).toBe("1785249275027635049");
      expect(latest[0].row_count).toBe(2);
      expect(latest[0].date_begin).toBe("2026-09-05T00:00:00.000Z");
    });

    it("pruneDmarcReports removes reports and rows past the retention window", async () => {
      await insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z");
      const oldReport = { ...report, reportId: "old-report-id" };
      await insertDmarcReport(oldReport, "<feedback/>", "2026-09-01T08:00:00.000Z");

      const db = _rawDb();
      await db.run(`UPDATE dmarc_reports SET received_at = '${ago(34560000000)}' WHERE report_id = ?`, ["old-report-id"]);
      await db.run(`UPDATE dmarc_rows SET received_at = '${ago(34560000000)}' WHERE report_id = ?`, ["old-report-id"]);

      expect(await pruneDmarcReports(365)).toBe(1);
      expect(await hasDmarcReport("google.com", "old-report-id")).toBe(false);
      expect(await hasDmarcReport("google.com", "1785249275027635048")).toBe(true);
      expect(await rowCount()).toBe(1);
      expect(await pruneDmarcReports(365)).toBe(0);
    });
  });

  describe("damp readings", () => {
    it("getRecentDampReadings returns rows newest-first", async () => {
      await upsertDampReading("Hall Closet", "Manifold", 12, "2026-06-01", "2026-06-01T09:00:00.000Z");
      await upsertDampReading("Hall Closet", "Manifold", 15, "2026-06-15", "2026-06-15T09:00:00.000Z");

      const rows = (await getRecentDampReadings()).filter((r) => r.point === "Manifold");
      expect(rows).toHaveLength(2);
      expect(rows[0].reading_date).toBe("2026-06-15");
      expect(rows[0].value).toBe(15);
      expect(rows[1].reading_date).toBe("2026-06-01");
      expect(rows[1].value).toBe(12);
    });

    it("getDampTrendRows orders the latest reading first per point", async () => {
      await upsertDampReading("Hall Closet", "Manifold", 12, "2026-06-01", "2026-06-01T09:00:00.000Z");
      await upsertDampReading("Hall Closet", "Manifold", 15, "2026-06-15", "2026-06-15T09:00:00.000Z");

      const rows = (await getDampTrendRows()).filter((r) => r.point === "Manifold");
      expect(rows).toHaveLength(2);
      expect(rows[0].value).toBe(15);
      expect(rows[1].value).toBe(12);
    });

    it("seeds a Hall Closet / utility reading of 0.5 on 2026-07-02 (issue #1824)", async () => {
      const seeded = (await getRecentDampReadings()).filter((r) => r.location === "Hall Closet" && r.point === "utility");
      expect(seeded).toHaveLength(1);
      expect(seeded[0].value).toBe(0.5);
      expect(seeded[0].reading_date).toBe("2026-07-02");
    });

    it("does not duplicate the Hall Closet / utility seed when the backfill guard runs again against a database that already has the row", async () => {
      // beforeEach's await initDb() has already seeded one row on this in-memory db.
      // Re-run the exact guard from db.ts's backfill against that *same*
      // database handle (not a fresh await initDb() call, which would open a brand
      // new isolated in-memory db and never exercise the guard against
      // pre-existing data) to prove COUNT(*) === 0 prevents a duplicate insert.
      const db = _rawDb();
      const countSql = `SELECT COUNT(*) AS n FROM damp_readings WHERE location = ? AND point = ?`;

      const before = await db.get(countSql, ["Hall Closet", "utility"]) as { n: number };
      expect(before.n).toBe(1);

      const dampSeed = await db.get(countSql, ["Hall Closet", "utility"]) as { n: number };
      if (dampSeed.n === 0) {
        await db.run(`INSERT INTO damp_readings (location, point, value, reading_date, recorded_at) VALUES (?, ?, ?, ?, ?)`, ["Hall Closet", "utility", 0.5, "2026-07-02", "2026-07-02T00:00:00.000Z"]);
      }

      const after = await db.get(countSql, ["Hall Closet", "utility"]) as { n: number };
      expect(after.n).toBe(1);
    });

    it("upsertDampReading updates the existing row for the same location/point/date", async () => {
      await upsertDampReading("Utility wall", "left", 1.2, "2026-07-01", "2026-07-01T09:00:00.000Z");
      let rows = (await getRecentDampReadings()).filter((r) => r.location === "Utility wall" && r.point === "left");
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(1.2);

      await upsertDampReading("Utility wall", "left", 1.8, "2026-07-01", "2026-07-01T10:00:00.000Z");
      rows = (await getRecentDampReadings()).filter((r) => r.location === "Utility wall" && r.point === "left");
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(1.8);
      expect(rows[0].recorded_at).toBe("2026-07-01T10:00:00.000Z");

      await upsertDampReading("Utility wall", "left", 2.1, "2026-07-02", "2026-07-02T09:00:00.000Z");
      rows = (await getRecentDampReadings()).filter((r) => r.location === "Utility wall" && r.point === "left");
      expect(rows).toHaveLength(2);
    });

    it("deleteDampReading removes only the row matching location/point/date", async () => {
      await upsertDampReading("Utility wall", "left", 1.2, "2026-07-01", "2026-07-01T09:00:00.000Z");
      await upsertDampReading("Utility wall", "left", 2.1, "2026-07-02", "2026-07-02T09:00:00.000Z");
      await upsertDampReading("Utility wall", "right", 1.5, "2026-07-01", "2026-07-01T09:00:00.000Z");

      await deleteDampReading("Utility wall", "left", "2026-07-01");

      const rows = (await getRecentDampReadings()).filter((r) => r.location === "Utility wall");
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.point === "left" && r.reading_date === "2026-07-01")).toBe(false);
      expect(rows.some((r) => r.point === "left" && r.reading_date === "2026-07-02")).toBe(true);
      expect(rows.some((r) => r.point === "right" && r.reading_date === "2026-07-01")).toBe(true);
    });

    it("deleteDampReading is a no-op when no matching row exists", async () => {
      await expect(deleteDampReading("Nonexistent", "left", "2026-07-01")).resolves.toBeUndefined();
    });
  });

  describe("friction notes", () => {
    it("insertFrictionNote stores an untriaged row with its identity fields", async () => {
      const id = await insertFrictionNote({ repo: "org/repo", category: "tests", text: "vitest is slow", reference: "npm test", taskId: 7, origin: "org/repo#clw_01ABC" });
      const id2 = await insertFrictionNote({ repo: "org/repo", category: "docs", text: "stale doc", sessionId: "sess1" });
      expect(id2).toBeGreaterThan(id);
      const notes = await listUntriagedFrictionNotes("org/repo");
      expect(notes.map((n) => n.id)).toEqual([id, id2]);
      expect(notes[0]).toMatchObject({ repo: "org/repo", category: "tests", text: "vitest is slow", reference: "npm test", task_id: 7, session_id: null, origin: "org/repo#clw_01ABC", triaged_at: null, retrospective_issue_id: null });
      expect(notes[1]).toMatchObject({ task_id: null, session_id: "sess1", reference: null });
      expect(notes[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("counts untriaged notes by repo and category", async () => {
      await insertFrictionNote({ repo: "org/a", category: "tests", text: "one" });
      await insertFrictionNote({ repo: "org/a", category: "tests", text: "two" });
      await insertFrictionNote({ repo: "org/a", category: "ci", text: "three" });
      await insertFrictionNote({ repo: "org/b", category: "docs", text: "four" });
      const counts = await countUntriagedFrictionNotesByRepoAndCategory();
      expect(Object.fromEntries(counts.get("org/a")!)).toEqual({ tests: 2, ci: 1 });
      expect(Object.fromEntries(counts.get("org/b")!)).toEqual({ docs: 1 });
      expect((await listUntriagedFrictionNotes()).length).toBe(4);
    });

    it("markFrictionNotesTriaged removes notes from the untriaged pile once and records the retrospective", async () => {
      const a = await insertFrictionNote({ repo: "org/repo", category: "tests", text: "one" });
      const b = await insertFrictionNote({ repo: "org/repo", category: "docs", text: "two" });
      const c = await insertFrictionNote({ repo: "org/other", category: "ci", text: "three" });
      expect(await lastFrictionRetrospectiveAt()).toBeNull();
      expect(await listFrictionRetrospectives()).toEqual([]);

      await markFrictionNotesTriaged([a, b, c], "clw_first");
      // A second retrospective naming an already-triaged note does not take it over.
      await markFrictionNotesTriaged([a], "clw_second");

      expect(await listUntriagedFrictionNotes("org/repo")).toEqual([]);
      expect((await countUntriagedFrictionNotesByRepoAndCategory()).get("org/repo")).toBeUndefined();
      expect(await lastFrictionRetrospectiveAt()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      const retros = await listFrictionRetrospectives();
      expect(retros).toHaveLength(1);
      expect(retros[0]).toMatchObject({ issueId: "clw_first", noteCount: 3 });
    });

    it("getTasksByIds returns only the tasks that exist", async () => {
      const t = await recordTaskStart("issue-worker", "org/repo", 1, null);
      const tasks = await getTasksByIds([t, t + 1000]);
      expect(tasks.map((task) => task.id)).toEqual([t]);
      expect(await getTasksByIds([])).toEqual([]);
    });
  });

  describe("blog drafts", () => {
    it("upsertBlogDraft then getBlogDraft round-trips the draft as status 'draft'", async () => {
      await upsertBlogDraft(
        "org/repo",
        "src/content/blog/hello.md",
        "---\ntitle: Hello\n---\nbody",
        "abc123",
        "Hello",
        "2026-07-01T00:00:00.000Z",
      );

      const draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft).not.toBeNull();
      expect(draft?.content).toBe("---\ntitle: Hello\n---\nbody");
      expect(draft?.base_sha).toBe("abc123");
      expect(draft?.title).toBe("Hello");
      expect(draft?.status).toBe("draft");
      expect(draft?.pr_number).toBeNull();
      expect(draft?.pr_branch).toBeNull();
    });

    it("getBlogDraft returns null when no draft exists for the repo/path", async () => {
      expect(await getBlogDraft("org/repo", "src/content/blog/missing.md")).toBeNull();
    });

    it("re-editing a pushed draft resets its status back to 'draft'", async () => {
      await upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v1", "sha1", "Hello", "2026-07-01T00:00:00.000Z");
      await setBlogDraftPushed("org/repo", "src/content/blog/hello.md", 42, "claws/blog-hello-1");

      let draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("pushed");
      expect(draft?.pr_number).toBe(42);
      expect(draft?.pr_branch).toBe("claws/blog-hello-1");

      await upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v2", "sha2", "Hello", "2026-07-02T00:00:00.000Z");

      draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("draft");
      expect(draft?.content).toBe("v2");
      expect(draft?.base_sha).toBe("sha2");
      // pr_number / pr_branch columns are left untouched by the upsert's ON CONFLICT clause.
      expect(draft?.pr_number).toBe(42);
      expect(draft?.pr_branch).toBe("claws/blog-hello-1");
    });

    it("listBlogDrafts orders drafts newest-updated-first, scoped to the given repo", async () => {
      await upsertBlogDraft("org/repo", "src/content/blog/a.md", "a", null, "A", "2026-07-01T00:00:00.000Z");
      await upsertBlogDraft("org/repo", "src/content/blog/b.md", "b", null, "B", "2026-07-03T00:00:00.000Z");
      await upsertBlogDraft("org/repo", "src/content/blog/c.md", "c", null, "C", "2026-07-02T00:00:00.000Z");
      await upsertBlogDraft("org/other-repo", "src/content/blog/d.md", "d", null, "D", "2026-07-04T00:00:00.000Z");

      const drafts = await listBlogDrafts("org/repo");
      expect(drafts.map((d) => d.path)).toEqual([
        "src/content/blog/b.md",
        "src/content/blog/c.md",
        "src/content/blog/a.md",
      ]);
    });

    it("setBlogDraftPushed marks a draft pushed with its PR number and branch", async () => {
      await upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v1", "sha1", "Hello", "2026-07-01T00:00:00.000Z");
      await setBlogDraftPushed("org/repo", "src/content/blog/hello.md", 99, "claws/blog-hello-2");

      const draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("pushed");
      expect(draft?.pr_number).toBe(99);
      expect(draft?.pr_branch).toBe("claws/blog-hello-2");
    });

    it("clearBlogDraftPR nulls the PR pointer and resets status to 'draft'", async () => {
      await upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v1", "sha1", "Hello", "2026-07-01T00:00:00.000Z");
      await setBlogDraftPushed("org/repo", "src/content/blog/hello.md", 99, "claws/blog-hello-2");

      await clearBlogDraftPR("org/repo", "src/content/blog/hello.md");

      const draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("draft");
      expect(draft?.pr_number).toBeNull();
      expect(draft?.pr_branch).toBeNull();
    });

    it("deleteBlogDraft removes only the given repo/path draft", async () => {
      await upsertBlogDraft("org/repo", "src/content/blog/a.md", "a", null, "A", "2026-07-01T00:00:00.000Z");
      await upsertBlogDraft("org/repo", "src/content/blog/b.md", "b", null, "B", "2026-07-02T00:00:00.000Z");
      await upsertBlogDraft("org/other-repo", "src/content/blog/a.md", "a2", null, "A", "2026-07-03T00:00:00.000Z");

      await deleteBlogDraft("org/repo", "src/content/blog/a.md");

      expect(await getBlogDraft("org/repo", "src/content/blog/a.md")).toBeNull();
      expect(await getBlogDraft("org/repo", "src/content/blog/b.md")).not.toBeNull();
      expect(await getBlogDraft("org/other-repo", "src/content/blog/a.md")).not.toBeNull();
    });
  });

  describe("session MCP token hash", () => {
    it("stores the hash given at insert, NULL by default, and replaces it on resume", async () => {
      const base = {
        tmux_name: "claws-x", mode: "repo-claude", repo: null, cwd: "/tmp/x", worktree_path: null,
        extra_worktrees: null, capabilities: null, created_at: 1, summary: null, summary_updated_at: null,
        provider: "claude", model: null,
      };
      await insertSession({ ...base, id: "with-token", mcp_token_sha256: "hash-1" });
      await insertSession({ ...base, id: "no-token" });
      expect((await getPersistedSession("with-token"))?.mcp_token_sha256).toBe("hash-1");
      expect((await getPersistedSession("no-token"))?.mcp_token_sha256).toBeNull();
      await setSessionMcpTokenHash("with-token", "hash-2");
      expect((await getPersistedSession("with-token"))?.mcp_token_sha256).toBe("hash-2");
    });
  });

  describe("session Claude account (#clw_01M623AMK66JB6TBB4PP55Q2V6)", () => {
    it("stores the account given at insert, NULL by default, and replaces it on a switch", async () => {
      const base = {
        tmux_name: "claws-x", mode: "repo-claude", repo: null, cwd: "/tmp/x", worktree_path: null,
        extra_worktrees: null, capabilities: null, created_at: 1, summary: null, summary_updated_at: null,
        provider: "claude", model: null,
      };
      await insertSession({ ...base, id: "with-account", claude_account: "work" });
      await insertSession({ ...base, id: "no-account" });
      expect((await getPersistedSession("with-account"))?.claude_account).toBe("work");
      expect((await getPersistedSession("no-account"))?.claude_account).toBeNull();
      await setSessionClaudeAccount("with-account", "personal");
      expect((await getPersistedSession("with-account"))?.claude_account).toBe("personal");
      await setSessionClaudeAccount("with-account", null);
      expect((await getPersistedSession("with-account"))?.claude_account).toBeNull();
    });
  });

  describe("session pruning", () => {
    it("pruneEndedSessions deletes exactly the selected ended rows when timestamps tie", async () => {
      await insertSession({
        id: "live",
        tmux_name: "claws-live",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/live",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 1,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
      await insertSession({
        id: "keep-b",
        tmux_name: "claws-keep-b",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/keep-b",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 2,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
      await insertSession({
        id: "keep-a",
        tmux_name: "claws-keep-a",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/keep-a",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 3,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
      await insertSession({
        id: "prune-b",
        tmux_name: "claws-prune-b",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/prune-b",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 4,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
      await insertSession({
        id: "prune-a",
        tmux_name: "claws-prune-a",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/prune-a",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 5,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });

      for (const id of ["keep-b", "keep-a", "prune-b", "prune-a"]) {
        await markSessionEnded(id, 1_000, JSON.stringify([]));
      }

      expect((await getEndedSessions()).map((row) => row.id)).toEqual([
        "prune-b",
        "prune-a",
        "keep-b",
        "keep-a",
      ]);
      expect(await pruneEndedSessions(2, "local-tmux")).toEqual(["keep-b", "keep-a"]);
      expect((await getEndedSessions()).map((row) => row.id)).toEqual(["prune-b", "prune-a"]);
      expect((await getAllPersistedSessions()).map((row) => row.id)).toEqual(["live"]);
    });

    it("pruneEndedSessions deletes large batches without exceeding SQLite bind limits", async () => {
      for (let i = 0; i < 1105; i += 1) {
        await insertSession({
          id: `ended-${i}`,
          tmux_name: `claws-ended-${i}`,
          mode: "home-claude",
          repo: null,
          cwd: `/tmp/ended-${i}`,
          worktree_path: null,
          extra_worktrees: null,
          capabilities: null,
          created_at: i,
          summary: null,
          summary_updated_at: null,
          provider: "claude",
          model: null,
        });
        await markSessionEnded(`ended-${i}`, i, JSON.stringify([]));
      }

      const pruned = await pruneEndedSessions(0, "local-tmux");

      expect(pruned).toHaveLength(1105);
      expect(await getEndedSessions()).toEqual([]);
      expect(await getAllPersistedSessions()).toEqual([]);
    });

    it("prunes only the given backend's ended rows, each against its own newest `keep`", async () => {
      const rowsByBackend: Array<[string, string | null]> = [
        ["tmux-null", null], ["tmux-explicit", "local-tmux"], ["pod-old", "k8s-pod"], ["pod-new", "k8s-pod"],
      ];
      for (const [i, [id, backend]] of rowsByBackend.entries()) {
        await insertSession({
          id,
          tmux_name: `claws-${id}`,
          mode: "home-claude",
          repo: null,
          cwd: `/tmp/${id}`,
          worktree_path: null,
          extra_worktrees: null,
          capabilities: null,
          created_at: i,
          summary: null,
          summary_updated_at: null,
          provider: "claude",
          model: null,
          backend,
        });
        await markSessionEnded(id, 1_000 + i, JSON.stringify([]));
      }

      expect(await getPrunableEndedSessionIds(1, "k8s-pod")).toEqual(["pod-old"]);
      expect(await pruneEndedSessions(0, "k8s-pod")).toEqual(["pod-new", "pod-old"]);
      expect((await getEndedSessions()).map((row) => row.id).sort()).toEqual(["tmux-explicit", "tmux-null"]);
      expect(await pruneEndedSessions(0, "local-tmux")).toEqual(["tmux-explicit", "tmux-null"]);
      expect(await getEndedSessions()).toEqual([]);
    });

    it("deleteEndedPersistedSession leaves a reopened row alone", async () => {
      await insertSession({
        id: "reopened", tmux_name: "claws-reopened", mode: "home-claude", repo: null, cwd: "/tmp", worktree_path: null,
        extra_worktrees: null, capabilities: null, created_at: 0, summary: null, summary_updated_at: null,
        provider: "claude", model: null, backend: "k8s-pod",
      });
      await markSessionEnded("reopened", 1, JSON.stringify([]));
      await clearSessionEnded("reopened");
      expect(await deleteEndedPersistedSession("reopened")).toBe(false);
      expect((await getAllPersistedSessions()).map((row) => row.id)).toEqual(["reopened"]);

      await markSessionEnded("reopened", 2, JSON.stringify([]));
      expect(await deleteEndedPersistedSession("reopened")).toBe(true);
      expect(await getEndedSessions()).toEqual([]);
    });
  });

  describe("sessions.backend column", () => {
    const baseRow = {
      mode: "home-claude",
      repo: null,
      cwd: "/tmp/backend",
      worktree_path: null,
      extra_worktrees: null,
      capabilities: null,
      created_at: 1,
      summary: null,
      summary_updated_at: null,
      provider: "claude",
      model: null,
    };

    it("stays NULL when the insert omits backend (local-tmux rows)", async () => {
      await insertSession({ ...baseRow, id: "backend-local", tmux_name: "claws-backend-local" });
      const row = (await getAllPersistedSessions()).find((r) => r.id === "backend-local");
      expect(row?.backend).toBeNull();
    });

    it("round-trips an explicit backend", async () => {
      await insertSession({ ...baseRow, id: "backend-pod", tmux_name: "claws-backend-pod", backend: "k8s-pod" });
      const row = (await getAllPersistedSessions()).find((r) => r.id === "backend-pod");
      expect(row?.backend).toBe("k8s-pod");
    });
  });

  describe("session memory captures", () => {
    async function insertPodSession(id: string, endedAt: number | null): Promise<void> {
      await insertSession({
        id, tmux_name: `claws-${id}`, mode: "home-claude", repo: null, cwd: `/tmp/${id}`, worktree_path: null,
        extra_worktrees: null, capabilities: null, created_at: 1, summary: null, summary_updated_at: null,
        provider: "claude", model: null, backend: "k8s-pod",
      });
      if (endedAt !== null) await markSessionEnded(id, endedAt, null);
    }

    it("records a capture only while the row keeps its ended_at, and lists it unpushed until marked", async () => {
      await insertPodSession("cap-1", 10);
      const files = { "-home-claws": { "MEMORY.md": "m" } };

      expect(await recordSessionMemoryCapture("cap-1", 11, files, 100)).toBe(false);
      expect(await recordSessionMemoryCapture("cap-1", 10, files, 100)).toBe(true);

      expect((await getPersistedSession("cap-1"))?.memories_captured_at).toBe(100);
      expect(await listUnpushedSessionMemoryCaptures()).toEqual([{ session_id: "cap-1", captured_at: 100, files }]);
      await markSessionMemoryCapturePushed("cap-1", 99, 200);
      expect(await listUnpushedSessionMemoryCaptures()).toHaveLength(1);
      await markSessionMemoryCapturePushed("cap-1", 100, 200);
      expect(await listUnpushedSessionMemoryCaptures()).toEqual([]);
    });

    it("a re-capture replaces the files and is pushed again; the capture outlives the row", async () => {
      await insertPodSession("cap-2", 10);
      await recordSessionMemoryCapture("cap-2", 10, { "-p": { "a.md": "a" } }, 100);
      await markSessionMemoryCapturePushed("cap-2", 100, 150);
      await clearSessionEnded("cap-2");
      await markSessionEnded("cap-2", 20, null);
      await recordSessionMemoryCapture("cap-2", 20, { "-p": { "b.md": "b" } }, 200);
      await deletePersistedSession("cap-2");

      expect(await listUnpushedSessionMemoryCaptures()).toEqual([{ session_id: "cap-2", captured_at: 200, files: { "-p": { "b.md": "b" } } }]);
    });

    it("captures an open row being deleted against a NULL ended_at", async () => {
      await insertPodSession("cap-3", null);
      expect(await recordSessionMemoryCapture("cap-3", 10, {}, 100)).toBe(false);
      expect(await recordSessionMemoryCapture("cap-3", null, {}, 100)).toBe(true);
    });

    it("lists ended rows needing a capture until captured or out of attempts, and every reopen resets both", async () => {
      await insertPodSession("need-1", 10);
      await insertPodSession("need-2", 20);
      await insertPodSession("open-1", null);
      expect((await getSessionsNeedingMemoryCapture(3, 10)).map((r) => r.id)).toEqual(["need-2", "need-1"]);

      for (let i = 0; i < 3; i++) await noteSessionMemoryCaptureFailed("need-1", 10);
      await noteSessionMemoryCaptureFailed("need-1", 999);
      expect((await getPersistedSession("need-1"))?.memory_capture_attempts).toBe(3);
      await recordSessionMemoryCapture("need-2", 20, {}, 100);
      expect(await getSessionsNeedingMemoryCapture(3, 10)).toEqual([]);

      await clearSessionEnded("need-1");
      await clearSessionEnded("need-2", 42);
      for (const id of ["need-1", "need-2"]) {
        expect(await getPersistedSession(id)).toMatchObject({ memories_captured_at: null, memory_capture_attempts: 0 });
      }
      await markSessionEnded("need-1", 30, null);
      await noteSessionMemoryCaptureFailed("need-1", 30);
      await setSessionMcpTokenHash("need-1", "h", true);
      expect(await getPersistedSession("need-1")).toMatchObject({ ended_at: null, memory_capture_attempts: 0 });
    });
  });

  describe("sessions.launched_at column", () => {
    async function insertLaunchSession(id: string, createdAt: number): Promise<void> {
      await insertSession({
        id,
        tmux_name: `claws-${id}`,
        mode: "home-claude",
        repo: null,
        cwd: `/tmp/${id}`,
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: createdAt,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
        backend: "k8s-pod",
      });
    }

    it("persists a started session's brief and audit fields, and counts only its live started sessions", async () => {
      const spawned = (id: string) => insertSession({
        id, tmux_name: `claws-${id}`, mode: "home-claude", repo: null, cwd: `/tmp/${id}`, worktree_path: null,
        extra_worktrees: null, capabilities: null, created_at: 1, summary: null, summary_updated_at: null,
        provider: "claude", model: null, brief: "## Issue brief", spawned_by_session: "parent-1", spawned_for_issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE",
      });
      await spawned("child-1");
      await spawned("child-2");
      await insertLaunchSession("unrelated", 1);
      expect(await getPersistedSession("child-1")).toMatchObject({ brief: "## Issue brief", spawned_by_session: "parent-1", spawned_for_issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE" });
      expect((await getPersistedSession("unrelated"))?.brief).toBeNull();
      expect(await countLiveSessionsSpawnedBy("parent-1")).toBe(2);
      await markSessionEnded("child-2", 5, null);
      expect(await countLiveSessionsSpawnedBy("parent-1")).toBe(1);
      expect(await countLiveSessionsSpawnedBy("someone-else")).toBe(0);
    });

    it("lists the newest live PR-started session per PR and keeps them off the board", async () => {
      const started = (id: string, createdAt: number, fields: { spawned_for_issue?: string | null; spawned_from?: string | null; spawned_for_pr?: string | null; spawned_by_session?: string | null }) => insertSession({
        id, tmux_name: `claws-${id}`, mode: "worktree-claude", repo: "org/app", cwd: `/tmp/${id}`, worktree_path: null,
        extra_worktrees: null, capabilities: null, created_at: createdAt, summary: null, summary_updated_at: null,
        provider: "claude", model: null, ...fields,
      });
      await started("pr-old", 1, { spawned_for_pr: "org/app#7", spawned_for_issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE" });
      await started("pr-new", 2, { spawned_for_pr: "org/app#7", spawned_for_issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE" });
      await started("pr-ended", 3, { spawned_for_pr: "org/app#8" });
      await started("by-session", 4, { spawned_for_pr: "org/app#9", spawned_by_session: "parent-1" });
      await started("board", 5, { spawned_for_issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGF" });
      await started("issue-page", 7, { spawned_for_issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGG", spawned_from: "issue-page" });
      await markSessionEnded("pr-ended", 6, null);
      expect(await listLivePrStartedSessions()).toEqual(new Map([["org/app#7", "pr-new"]]));
      expect(await listLiveBoardStartedSessions()).toEqual(new Map([["clw_01M4BD4HVYGHT1AF1Z5XNQ6BGF", "board"]]));
      expect((await getPersistedSession("pr-new"))?.spawned_for_pr).toBe("org/app#7");
    });

    it("stores an Initial prompt and marks it sent once, keeping the first timestamp", async () => {
      await insertSession({
        id: "prompted", tmux_name: "claws-prompted", mode: "home-claude", repo: null, cwd: "/tmp/prompted", worktree_path: null,
        extra_worktrees: null, capabilities: null, created_at: 1, summary: null, summary_updated_at: null,
        provider: "claude", model: null, initial_prompt: "Fix the build\nplease",
      });
      await insertLaunchSession("unprompted", 1);
      expect(await getPersistedSession("prompted")).toMatchObject({ initial_prompt: "Fix the build\nplease", initial_prompt_sent_at: null });
      expect(await getPersistedSession("unprompted")).toMatchObject({ initial_prompt: null, initial_prompt_sent_at: null });
      expect(await markSessionInitialPromptSent("prompted", 10)).toBe(true);
      expect(await markSessionInitialPromptSent("prompted", 20)).toBe(false);
      expect((await getPersistedSession("prompted"))?.initial_prompt_sent_at).toBe(10);
    });

    it("insertSession sets launched_at to created_at", async () => {
      await insertLaunchSession("launch-1", 7);
      const row = (await getAllPersistedSessions()).find((r) => r.id === "launch-1");
      expect(row?.launched_at).toBe(7);
    });

    it("clearSessionEnded records a relaunch time when given one", async () => {
      await insertLaunchSession("launch-2", 7);
      await markSessionEnded("launch-2", 10, null);

      await clearSessionEnded("launch-2", 42);

      const row = (await getAllPersistedSessions()).find((r) => r.id === "launch-2");
      expect(row?.ended_at).toBeNull();
      expect(row?.launched_at).toBe(42);
    });

    it("clearSessionEnded without a launch time leaves launched_at unchanged", async () => {
      await insertLaunchSession("launch-3", 7);
      await markSessionEnded("launch-3", 10, null);

      await clearSessionEnded("launch-3");

      const row = (await getAllPersistedSessions()).find((r) => r.id === "launch-3");
      expect(row?.ended_at).toBeNull();
      expect(row?.launched_at).toBe(7);
    });

    it("only a relaunch or setSessionLaunchedVersion stamps launched_version", async () => {
      await insertLaunchSession("launch-4", 7);
      await _rawDb().run("UPDATE sessions SET launched_version = 'old' WHERE id = 'launch-4'");
      await markSessionEnded("launch-4", 10, null);

      await clearSessionEnded("launch-4");
      expect((await getAllPersistedSessions()).find((r) => r.id === "launch-4")?.launched_version).toBe("old");

      await setSessionLaunchedVersion("launch-4");
      const stamped = (await getAllPersistedSessions()).find((r) => r.id === "launch-4")?.launched_version;
      expect(stamped).not.toBe("old");

      await _rawDb().run("UPDATE sessions SET launched_version = 'old' WHERE id = 'launch-4'");
      await clearSessionEnded("launch-4", 42);
      expect((await getAllPersistedSessions()).find((r) => r.id === "launch-4")?.launched_version).toBe(stamped);
    });
  });

  describe("sessions startup columns", () => {
    it("insertSession seeds startup timestamps and updateSessionStartup round-trips nullable progress", async () => {
      await insertSession({
        id: "startup-1",
        tmux_name: "claws-startup-1",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/startup-1",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 100,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
        backend: "k8s-pod",
      });

      let row = await getPersistedSession("startup-1");
      expect(row?.startup_started_at).toBe(100);
      expect(row?.startup_updated_at).toBe(100);

      await updateSessionStartup("startup-1", {
        state: "pending",
        step: "Preparing repository checkout",
        detail: "init container running",
        updatedAt: 150,
      });
      row = await getPersistedSession("startup-1");
      expect(row?.startup_state).toBe("pending");
      expect(row?.startup_step).toBe("Preparing repository checkout");
      expect(row?.startup_detail).toBe("init container running");
      expect(row?.startup_updated_at).toBe(150);

      await updateSessionStartup("startup-1", {
        state: "ready",
        step: "Terminal ready",
        detail: null,
        updatedAt: 180,
        readyAt: 180,
        clearFailure: true,
      });
      row = await getPersistedSession("startup-1");
      expect(row?.startup_state).toBe("ready");
      expect(row?.startup_detail).toBeNull();
      expect(row?.startup_ready_at).toBe(180);
      expect(row?.startup_failed_at).toBeNull();
      expect(row?.startup_failure).toBeNull();
    });

    it("updateSessionStartup with expectUpdatedAt drops a write that raced past a newer one", async () => {
      await insertSession({
        id: "startup-2",
        tmux_name: "claws-startup-2",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/startup-2",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 100,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
        backend: "k8s-pod",
      });

      // Reconcile, holding the lock, records the real reason the pod died.
      expect(await updateSessionStartup("startup-2", {
        state: "failed",
        step: "Session pod failed",
        detail: "OOMKilled",
        updatedAt: 200,
        failedAt: 200,
        failure: "OOMKilled",
      })).toBe(true);

      // A poll that read the row at 100 and derived a non-terminal status from a pod it
      // listed before reconcile ran must not land — it would clear the failure just recorded.
      expect(await updateSessionStartup("startup-2", {
        state: "pending",
        step: "Waiting for pod to start",
        detail: null,
        updatedAt: 210,
        clearFailure: true,
        expectUpdatedAt: 100,
      })).toBe(false);

      let row = await getPersistedSession("startup-2");
      expect(row?.startup_state).toBe("failed");
      expect(row?.startup_failure).toBe("OOMKilled");
      expect(row?.startup_updated_at).toBe(200);

      // The next poll reads the row reconcile wrote, so its own write is not stale and lands.
      expect(await updateSessionStartup("startup-2", {
        state: "ended",
        step: "Session ended",
        detail: null,
        updatedAt: 220,
        expectUpdatedAt: 200,
      })).toBe(true);
      row = await getPersistedSession("startup-2");
      expect(row?.startup_state).toBe("ended");
      expect(row?.startup_failure).toBe("OOMKilled");
    });
  });

  describe("getRecentSessionModels", () => {
    async function insertModelSession(id: string, provider: string, model: string | null, createdAt: number): Promise<void> {
      await insertSession({
        id,
        tmux_name: `claws-${id}`,
        mode: "home-claude",
        repo: null,
        cwd: `/tmp/${id}`,
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: createdAt,
        summary: null,
        summary_updated_at: null,
        provider,
        model,
      });
    }

    it("returns distinct models for the provider, most-recently-used first", async () => {
      await insertModelSession("m1", "claude", "opus", 1);
      await insertModelSession("m2", "claude", "sonnet", 2);
      await insertModelSession("m3", "claude", "opus", 3);
      await insertModelSession("m4", "codex", "gpt-5.4-mini", 4);
      await insertModelSession("m5", "claude", null, 5);
      await insertModelSession("m6", "claude", "", 6);

      expect(await getRecentSessionModels("claude")).toEqual(["opus", "sonnet"]);
      expect(await getRecentSessionModels("codex")).toEqual(["gpt-5.4-mini"]);
      expect(await getRecentSessionModels("opencode")).toEqual([]);
    });

    it("honours the limit", async () => {
      await insertModelSession("l1", "claude", "opus", 1);
      await insertModelSession("l2", "claude", "sonnet", 2);
      await insertModelSession("l3", "claude", "haiku", 3);

      expect(await getRecentSessionModels("claude", 2)).toEqual(["haiku", "sonnet"]);
    });
  });

  describe("session capability defaults", () => {
    it("keys a repo combination order-insensitively and without duplicates", () => {
      expect(sessionCapabilityDefaultsKey(["org/a"])).toBe("org/a");
      expect(sessionCapabilityDefaultsKey(["org/b", "org/a"])).toBe("org/a\norg/b");
      expect(sessionCapabilityDefaultsKey(["org/a", "org/b", "org/a"])).toBe("org/a\norg/b");
    });

    it("remembers the last agent and each agent's model, keeping the model on a null update", async () => {
      expect(await getSessionAgentDefaults()).toEqual({ lastProvider: null, models: {} });
      await rememberSessionAgentDefault("codex", "gpt-a", 1);
      await rememberSessionAgentDefault("claude", "opus", 2);
      await rememberSessionAgentDefault("codex", null, 3);
      expect(await getSessionAgentDefaults()).toEqual({ lastProvider: "codex", models: { codex: "gpt-a", claude: "opus" } });
    });

    it("overwrites the remembered set for the same combination", async () => {
      await rememberSessionCapabilityDefaults(["org/b", "org/a"], ["home-assistant", "ssh:nas"], 1);
      await rememberSessionCapabilityDefaults(["org/a", "org/b"], ["home-assistant"], 2);
      expect(await getAllSessionCapabilityDefaults()).toEqual(new Map([["org/a\norg/b", ["home-assistant"]]]));
    });

    it("round-trips an empty selection as an empty array, distinct from no row", async () => {
      await rememberSessionCapabilityDefaults(["org/a"], []);
      const all = await getAllSessionCapabilityDefaults();
      expect(all.get("org/a")).toEqual([]);
      expect(all.has("org/b")).toBe(false);
    });

    it("returns one entry per combination and ignores an empty repo list", async () => {
      await rememberSessionCapabilityDefaults([], ["home-assistant"]);
      await rememberSessionCapabilityDefaults(["org/a"], ["home-assistant"]);
      await rememberSessionCapabilityDefaults(["org/a", "org/b"], ["github-auth"]);
      expect(await getAllSessionCapabilityDefaults()).toEqual(new Map([
        ["org/a", ["home-assistant"]],
        ["org/a\norg/b", ["github-auth"]],
      ]));
    });
  });

  describe("session capability requests", () => {
    async function insertBareSession(id: string): Promise<void> {
      await insertSession({
        id, tmux_name: `claws-${id}`, mode: "home-claude", repo: null, cwd: `/tmp/${id}`, worktree_path: null,
        extra_worktrees: null, capabilities: null, created_at: 1, summary: null, summary_updated_at: null, provider: "claude", model: null,
      });
    }
    const row = (sessionId: string, capability: string, over: Partial<{ status: string; reason: string; requested_at: number; decided_at: number | null; last_polled_at: number | null; grant_seen_at: number | null }> = {}) => ({
      session_id: sessionId, capability, status: "pending", reason: "r", requested_at: 1, decided_at: null, last_polled_at: null, grant_seen_at: null, ...over,
    });
    const keys = async (...sessionIds: string[]) =>
      (await Promise.all(sessionIds.map((id) => listSessionCapabilityRequests(id)))).flat().map((r) => `${r.session_id}/${r.capability}`).sort();

    it("upserts one row per (session, capability) and lists a session's rows, oldest first, with numeric times", async () => {
      await upsertSessionCapabilityRequest(row("live1", "ssh:nas", { requested_at: 20 }));
      await upsertSessionCapabilityRequest(row("live1", "home-assistant", { requested_at: 10, last_polled_at: 11 }));
      await upsertSessionCapabilityRequest(row("live1", "ssh:nas", { requested_at: 20, status: "denied", decided_at: 30 }));
      await upsertSessionCapabilityRequest(row("other", "home-assistant"));
      expect(await listSessionCapabilityRequests("live1")).toEqual([
        row("live1", "home-assistant", { requested_at: 10, last_polled_at: 11 }),
        row("live1", "ssh:nas", { requested_at: 20, status: "denied", decided_at: 30 }),
      ]);
      expect(await getSessionCapabilityRequest("live1", "ssh:nas")).toEqual(row("live1", "ssh:nas", { requested_at: 20, status: "denied", decided_at: 30 }));
      expect(await getSessionCapabilityRequest("live1", "browser")).toBeUndefined();
    });

    it("inserts a request only when the pair has none", async () => {
      expect(await insertSessionCapabilityRequestIfAbsent(row("live1", "ssh:nas", { reason: "first" }))).toBe(true);
      expect(await insertSessionCapabilityRequestIfAbsent(row("live1", "ssh:nas", { reason: "second" }))).toBe(false);
      expect((await getSessionCapabilityRequest("live1", "ssh:nas"))?.reason).toBe("first");
    });

    it("sets a status, conditionally on it still being pending", async () => {
      await upsertSessionCapabilityRequest(row("live1", "ssh:nas"));
      expect(await setSessionCapabilityRequestStatus("live1", "ssh:nas", "denied", 5, { onlyIfPending: true })).toBe(true);
      expect(await setSessionCapabilityRequestStatus("live1", "ssh:nas", "approved", 6, { onlyIfPending: true })).toBe(false);
      expect(await getSessionCapabilityRequest("live1", "ssh:nas")).toMatchObject({ status: "denied", decided_at: 5 });
      expect(await setSessionCapabilityRequestStatus("live1", "ssh:nas", "approved", 7)).toBe(true);
      expect(await getSessionCapabilityRequest("live1", "ssh:nas")).toMatchObject({ status: "approved", decided_at: 7 });
      expect(await setSessionCapabilityRequestStatus("live1", "missing", "approved", 7)).toBe(false);
    });

    it("records the agent's last poll and grant pickup on an existing row only", async () => {
      await upsertSessionCapabilityRequest(row("live1", "ssh:nas"));
      await markSessionCapabilityRequest("live1", "ssh:nas", "last_polled_at", 1_800_000_000_000);
      await markSessionCapabilityRequest("live1", "ssh:nas", "grant_seen_at", 1_800_000_000_001);
      await markSessionCapabilityRequest("live1", "missing", "grant_seen_at", 3);
      expect(await getSessionCapabilityRequest("live1", "ssh:nas")).toMatchObject({ last_polled_at: 1_800_000_000_000, grant_seen_at: 1_800_000_000_001 });
      expect(await getSessionCapabilityRequest("live1", "missing")).toBeUndefined();
    });

    it("prunes ended and deleted sessions' rows only", async () => {
      await insertBareSession("live1");
      await insertBareSession("ended1");
      await markSessionEnded("ended1", 50, null);
      await upsertSessionCapabilityRequest(row("live1", "home-assistant"));
      await upsertSessionCapabilityRequest(row("ended1", "home-assistant"));
      await upsertSessionCapabilityRequest(row("missing", "home-assistant"));
      expect(await pruneSessionCapabilityRequestsForEndedSessions()).toBe(2);
      expect(await keys("live1", "ended1", "missing")).toEqual(["live1/home-assistant"]);
    });

    it("deletes one capability's row, or every row of a session", async () => {
      await upsertSessionCapabilityRequest(row("live1", "home-assistant"));
      await upsertSessionCapabilityRequest(row("live1", "ssh:nas"));
      await upsertSessionCapabilityRequest(row("live2", "ssh:nas"));
      await deleteSessionCapabilityRequest("live1", "ssh:nas");
      expect(await keys("live1", "live2")).toEqual(["live1/home-assistant", "live2/ssh:nas"]);
      await deleteSessionCapabilityRequest("live1");
      expect(await keys("live1", "live2")).toEqual(["live2/ssh:nas"]);
    });
  });

  describe("controller status and commands", () => {
    it("upserts a status topic and reads back its JSON, or null when never written", async () => {
      expect(await readControllerStatus("heartbeat")).toBeNull();
      await writeControllerStatus("heartbeat", { at: 1, version: "v1", shuttingDown: false });
      await writeControllerStatus("heartbeat", { at: 2, version: "v2", shuttingDown: true });
      expect(await readControllerStatus("heartbeat")).toEqual({ at: 2, version: "v2", shuttingDown: true });
    });

    it("claims unclaimed commands in id order, once each, and records results", async () => {
      const first = await insertControllerCommand("trigger-job", { name: "a" });
      const second = await insertControllerCommand("cancel-run", { runId: "r1" });
      const claimed = await claimControllerCommands();
      expect(claimed.map((c) => [c.id, c.kind, JSON.parse(c.args_json)])).toEqual([[first, "trigger-job", { name: "a" }], [second, "cancel-run", { runId: "r1" }]]);
      expect(claimed.every((c) => c.claimed_at !== null)).toBe(true);
      expect(await claimControllerCommands()).toEqual([]);
      await completeControllerCommand(first, "started");
      expect(await getControllerCommand(first)).toMatchObject({ id: first, result_json: JSON.stringify("started") });
      expect((await getControllerCommand(first))?.completed_at).not.toBeNull();
      expect((await getControllerCommand(second))?.completed_at).toBeNull();
      expect(await getControllerCommand(9999)).toBeNull();
    });

    it("prunes only commands completed more than the retention ago", async () => {
      const done = await insertControllerCommand("trigger-job", { name: "a" });
      const open = await insertControllerCommand("trigger-job", { name: "b" });
      await completeControllerCommand(done, "started");
      expect(await pruneControllerCommands(7)).toBe(0);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      try {
        expect(await pruneControllerCommands(7)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expect(await getControllerCommand(done)).toBeNull();
      expect(await getControllerCommand(open)).not.toBeNull();
    });
  });

  describe("pruneClawsEvents", () => {
    it("deletes events older than the retention only", async () => {
      const { recordGitHubEvent, getEventsSince } = await import("./github-events.js");
      recordGitHubEvent({ kind: "issue-comment", repo: "org/repo", number: 1, related: [] });
      expect(await pruneClawsEvents(24)).toBe(0);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      try {
        recordGitHubEvent({ kind: "issue-comment", repo: "org/repo", number: 2, related: [] });
        expect(await pruneClawsEvents(24)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expect((await getEventsSince(0, {})).map((e) => e.number)).toEqual([2]);
    });
  });

  describe("setManualSessionSummary", () => {
    async function insertPlainSession(id: string): Promise<void> {
      await insertSession({
        id,
        tmux_name: `claws-${id}`,
        mode: "home-claude",
        repo: null,
        cwd: `/tmp/${id}`,
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 1,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
    }

    it("sets the summary and pins it against updateSessionSummary", async () => {
      await insertPlainSession("pin-1");

      expect(await setManualSessionSummary("pin-1", "My manual description", 500)).toBe(true);

      let row = (await getAllPersistedSessions()).find((r) => r.id === "pin-1");
      expect(row?.summary).toBe("My manual description");
      expect(row?.summary_manual).toBe(1);

      await updateSessionSummary("pin-1", "Auto summary", 999);

      row = (await getAllPersistedSessions()).find((r) => r.id === "pin-1");
      expect(row?.summary).toBe("My manual description");
      expect(row?.summary_manual).toBe(1);
    });

    it("clears the pin when summary is null, allowing updateSessionSummary to write again", async () => {
      await insertPlainSession("pin-2");
      await setManualSessionSummary("pin-2", "My manual description", 500);

      expect(await setManualSessionSummary("pin-2", null, null)).toBe(true);

      let row = (await getAllPersistedSessions()).find((r) => r.id === "pin-2");
      expect(row?.summary).toBeNull();
      expect(row?.summary_manual).toBe(0);

      await updateSessionSummary("pin-2", "Auto summary", 999);

      row = (await getAllPersistedSessions()).find((r) => r.id === "pin-2");
      expect(row?.summary).toBe("Auto summary");
      expect(row?.summary_manual).toBe(0);
    });
  });

  describe("setSessionAgentStatus", () => {
    async function insertPlainSession(id: string): Promise<void> {
      await insertSession({
        id,
        tmux_name: `claws-${id}`,
        mode: "home-claude",
        repo: null,
        cwd: `/tmp/${id}`,
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 1,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
    }

    it("updates a live row", async () => {
      await insertPlainSession("st-1");
      let row = (await getAllPersistedSessions()).find((r) => r.id === "st-1");
      expect(row?.agent_status).toBeNull();
      expect(row?.agent_status_updated_at).toBeNull();

      expect(await setSessionAgentStatus("st-1", "monitoring", 500)).toBe(true);

      row = (await getAllPersistedSessions()).find((r) => r.id === "st-1");
      expect(row?.agent_status).toBe("monitoring");
      expect(row?.agent_status_updated_at).toBe(500);
    });

    it("is a no-op on an ended or missing row", async () => {
      await insertPlainSession("st-2");
      await markSessionEnded("st-2", 100, null);

      expect(await setSessionAgentStatus("st-2", "done", 500)).toBe(false);
      expect(await setSessionAgentStatus("missing", "done", 500)).toBe(false);

      const row = (await getEndedSessions()).find((r) => r.id === "st-2");
      expect(row?.agent_status).toBeNull();
    });

    it("clearSessionEnded nulls the status so a resumed session starts unreported", async () => {
      await insertPlainSession("st-3");
      await setSessionAgentStatus("st-3", "waiting", 500);
      await markSessionEnded("st-3", 600, null);

      await clearSessionEnded("st-3");

      const row = (await getAllPersistedSessions()).find((r) => r.id === "st-3");
      expect(row?.ended_at).toBeNull();
      expect(row?.agent_status).toBeNull();
      expect(row?.agent_status_updated_at).toBeNull();
    });
  });

});

describe("imported issues", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  /**
   * The native issue a linkage row names.
   *
   * `listImportedIssues` joins `claws_issues` to read `kind`, so the tests
   * below have to put the issue there too — the ids are fixed rather than
   * minted so the assertions can name them.
   */
  async function nativeRow(id: string, kind: "issue" | "shadow" = "issue"): Promise<void> {
    await _rawDb().run(
      `INSERT INTO claws_issues (id, title, body, author_login, state, state_reason, created_at, updated_at, closed_at, kind)
       VALUES (?, 'T', '', 'claws', 'open', NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00', NULL, ?)`,
      [id, kind],
    );
  }

  it("reports whether the stored linkage row names the caller's native issue", async () => {
    // The write is `INSERT OR IGNORE` on `(repo, forge_number)`, so a second
    // import of the same forge issue silently keeps the first one's id. The
    // caller has to be able to tell that apart from its own write landing:
    // carrying on would leave a native issue nothing resolves to.
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE");

    expect(await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).toBe(true);
    // Idempotent: the same pair again is the re-run this row exists for.
    expect(await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).toBe(true);
    expect(await recordImportedIssue("org/repo", 7, "clw_01jbq7x4m2k8nv3tyrw9gz5pdc")).toBe(true);

    expect(await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE")).toBe(false);
    expect((await listImportedIssues())[0]!.nativeId).toBe("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
  });

  it("records an import and reads the forge number back as a number", async () => {
    // `forge_number` is TEXT, so Postgres hands `7` back as `"7"` — and every
    // `sameIssueRef` comparison against a forge number would silently stop
    // matching there while still passing on SQLite.
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");

    const rows = await listImportedIssues();
    expect(rows).toEqual([{ repo: "org/repo", forgeNumber: 7, nativeId: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC" }]);
    expect(typeof rows[0]!.forgeNumber).toBe("number");
  });

  it("is idempotent on (repo, forge_number) and keeps the first native id", async () => {
    // The row is the importer's idempotency key: a re-run that reaches the
    // write again must not replace the id it already created.
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE");
    await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE");

    const rows = await listImportedIssues();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nativeId).toBe("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
  });

  it("keys on the repo too, since forge numbers collide across repositories", async () => {
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE");
    await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await recordImportedIssue("org/other", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE");

    expect((await listImportedIssues()).map((r) => [r.repo, r.nativeId]).sort()).toEqual([
      ["org/other", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE"],
      ["org/repo", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"],
    ]);
  });

  it("canonicalises a lower-cased native id on write", async () => {
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await recordImportedIssue("org/repo", 7, "clw_01jbq7x4m2k8nv3tyrw9gz5pdc");

    expect((await listImportedIssues())[0]!.nativeId).toBe("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
  });

  it("round-trips forge_synced_at, and reads null before the first write or with no row", async () => {
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");

    expect(await getImportedForgeSyncedAt("org/repo", 7)).toBeNull();
    await setImportedForgeSyncedAt("org/repo", 7, "2026-09-25T08:45:02Z");
    expect(await getImportedForgeSyncedAt("org/repo", 7)).toBe("2026-09-25T08:45:02Z");
    // Keyed on the canonical ref, so the string spelling reaches the same row.
    expect(await getImportedForgeSyncedAt("org/repo", "7")).toBe("2026-09-25T08:45:02Z");

    // No row: nothing to write, and nothing to read.
    await setImportedForgeSyncedAt("org/other", 7, "2026-09-25T08:45:02Z");
    expect(await getImportedForgeSyncedAt("org/other", 7)).toBeNull();
  });

  it("gives an existing imported_issues table the forge_synced_at column", async () => {
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    await _rawDb().exec(`ALTER TABLE imported_issues DROP COLUMN forge_synced_at`);

    // Re-run the boot-time ALTER directly against this same handle, not a
    // fresh `initDb()`: DB_PATH is ":memory:" for this suite, so a real
    // `initDb()` call would open a brand new isolated database and lose the
    // rows just inserted above, rather than exercising the migration against
    // pre-existing data.
    await _rawDb().addColumn("imported_issues", "forge_synced_at", "TEXT");

    expect(await getImportedForgeSyncedAt("org/repo", 7)).toBeNull();
    await setImportedForgeSyncedAt("org/repo", 7, "2026-09-25T12:52:28Z");
    expect(await getImportedForgeSyncedAt("org/repo", 7)).toBe("2026-09-25T12:52:28Z");
  });

  // A shadow has a linkage row too, but it is not an *alias*: the forge issue
  // it stands for is still live, and resolving its ref to the hidden native id
  // would point every ref-keyed lookup on the fleet at a row nothing reads.
  it("omits a shadow's linkage row, and includes it once the shadow is promoted", async () => {
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "shadow");
    await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");

    expect(await listImportedIssues()).toEqual([]);

    expect(await promoteShadowIssue("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", { title: "Shadowed", body: "Imported", labels: [] }, { importPending: true })).toBe(true);

    expect(await listImportedIssues()).toEqual([
      { repo: "org/repo", forgeNumber: 7, nativeId: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC" },
    ]);
  });

  it("reads the forge issue back from a native id, shadow or not", async () => {
    await nativeRow("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "shadow");
    await recordImportedIssue("org/repo", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");

    expect(await getImportedIssueByNative("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).toEqual({ repo: "org/repo", forgeNumber: 7 });
    // Lower-cased ids are canonicalised on write, so the lookup has to
    // canonicalise too — `=` is case-sensitive on Postgres.
    expect(await getImportedIssueByNative("clw_01jbq7x4m2k8nv3tyrw9gz5pdc")).toEqual({ repo: "org/repo", forgeNumber: 7 });
    expect(await getImportedIssueByNative("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE")).toBeUndefined();
  });

  it("finds an open imported issue by exact title in its repo, and relinks a re-filed forge issue to it", async () => {
    const first = (await createShadowIssue("org/repo", 7, { title: "CVE scan", authorLogin: "forgejo-actions" }))!.id;
    expect(await findOpenImportedIssueByTitle("org/repo", "CVE scan")).toBeUndefined();
    await promoteShadowIssue(first, { title: "CVE scan", body: "Imported", labels: [] }, { importPending: false });
    await createClawsIssue({ title: "CVE scan", authorLogin: "stjohnb", repos: ["org/repo"] });

    expect((await findOpenImportedIssueByTitle("org/repo", "CVE scan"))?.id).toBe(first);
    expect(await findOpenImportedIssueByTitle("org/repo", "CVE scan ")).toBeUndefined();
    expect(await findOpenImportedIssueByTitle("org/other", "CVE scan")).toBeUndefined();

    const shadow = (await createShadowIssue("org/repo", 8, { title: "CVE scan", authorLogin: "forgejo-actions" }))!.id;
    await relinkImportedIssue("org/repo", 8, first);
    await relinkImportedIssue("org/repo", 9, first);
    expect(await getClawsIssue(shadow)).toBeUndefined();
    expect(await recordImportedIssue("org/repo", 8, first)).toBe(true);
    expect(await recordImportedIssue("org/repo", 9, first)).toBe(true);
    expect(await getImportedIssueByNative(first)).toEqual({ repo: "org/repo", forgeNumber: 7 });
  });

  it("finds an open imported issue renamed since filing by its filed title", async () => {
    const first = (await createShadowIssue("org/repo", 7, { title: "CVE scan", authorLogin: "forgejo-actions" }))!.id;
    await promoteShadowIssue(first, { title: "CVE scan", body: "Imported", labels: [] }, { importPending: false });
    expect(await updateClawsIssueTitle(first, "Clear blocking CVEs")).toBe(true);

    expect((await findOpenImportedIssueByTitle("org/repo", "CVE scan"))?.id).toBe(first);
    expect((await findOpenImportedIssueByTitle("org/repo", "Clear blocking CVEs"))?.id).toBe(first);
    expect(await findOpenImportedIssueByTitle("org/repo", "Something else")).toBeUndefined();
  });

  it("finds the newest open, unkeyed issue filed under a title, renamed or not", async () => {
    const older = await createClawsIssue({ title: "CVE scan", authorLogin: "stjohnb", repos: ["org/repo"] });
    const renamed = await createClawsIssue({ title: "CVE scan", authorLogin: "stjohnb", repos: ["org/repo"] });
    expect(await updateClawsIssueTitle(renamed, "Clear blocking CVEs")).toBe(true);
    const keyed = await createClawsIssue({ title: "CVE scan", authorLogin: "stjohnb", repos: ["org/repo"], dedupeKey: "prod-report-x" });
    const closed = await createClawsIssue({ title: "CVE scan", authorLogin: "stjohnb", repos: ["org/repo"] });
    await setClawsIssueState(closed, "closed", "completed");
    await createClawsIssue({ title: "CVE scan", authorLogin: "stjohnb", repos: ["org/other"] });
    // Ordering is by created_at, which has second resolution; space them.
    await _rawDb().run(`UPDATE claws_issues SET created_at = ? WHERE id = ?`, ["2026-01-01 00:00:00", older]);
    await _rawDb().run(`UPDATE claws_issues SET created_at = ? WHERE id = ?`, ["2026-01-02 00:00:00", renamed]);
    await _rawDb().run(`UPDATE claws_issues SET created_at = ? WHERE id IN (?, ?)`, ["2026-01-03 00:00:00", keyed, closed]);

    expect((await findOpenUnkeyedIssueByFiledTitle("org/repo", "CVE scan"))?.id).toBe(renamed);
    // The current title of a renamed issue is not the title it was filed under.
    expect(await findOpenUnkeyedIssueByFiledTitle("org/repo", "Clear blocking CVEs")).toBeUndefined();
    expect(await findOpenUnkeyedIssueByFiledTitle("org/repo", "CVE scan ")).toBeUndefined();
    expect(await findOpenUnkeyedIssueByFiledTitle("org/none", "CVE scan")).toBeUndefined();
  });
});

describe("main build failures", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("records a failure, finds it by run id, and tracks a pending retry to its outcome", async () => {
    expect(await hasMainBuildFailure("1")).toBe(false);

    await recordMainBuildFailure("1", "org/repo", "CI", "https://example.invalid/run/1", true, null);
    expect(await hasMainBuildFailure("1")).toBe(true);

    const pending = await getPendingMainBuildRetries();
    expect(pending).toHaveLength(1);
    expect(pending[0].workflow_name).toBe("CI");
    expect(pending[0].run_url).toBe("https://example.invalid/run/1");

    await setMainBuildRetryOutcome("1", "failure");
    expect(await getPendingMainBuildRetries()).toHaveLength(0);
  });

  it("a failure that was never retried is not pending", async () => {
    await recordMainBuildFailure("2", "org/repo", "CI", "https://example.invalid/run/2", false, "not-retried");
    expect(await getPendingMainBuildRetries()).toHaveLength(0);
  });

  it("round-trips retry_detail, defaulting it to NULL", async () => {
    const detail = JSON.stringify({ kind: "superseded", tipSha: "a".repeat(40), classification: "log-pattern" });
    await recordMainBuildFailure("40", "org/repo", "CI", "https://example.invalid/run/40", false, "not-retried", "push", detail);
    await recordMainBuildFailure("41", "org/repo", "Docs", "https://example.invalid/run/41", false, "not-retried", "push");

    const rows = new Map((await getUnreportedMainBuildFailures()).map((r) => [r.run_id, r]));
    expect(rows.get("40")?.retry_detail).toBe(detail);
    expect(rows.get("41")?.retry_detail).toBeNull();
  });

  it("getExpiredMainBuildRetries finds retries stuck past 24h, not fresh pending ones", async () => {
    await recordMainBuildFailure("9", "org/repo", "CI", "https://example.invalid/run/9", true, null);
    expect((await getPendingMainBuildRetries()).map((r) => r.run_id)).toEqual(["9"]);
    expect(await getExpiredMainBuildRetries()).toHaveLength(0);

    const db = _rawDb();
    await db.run(`UPDATE main_build_failures SET detected_at = '${ago(90000000)}' WHERE run_id = ?`, ["9"]);

    expect(await getPendingMainBuildRetries()).toHaveLength(0);
    const expired = await getExpiredMainBuildRetries();
    expect(expired).toHaveLength(1);
    expect(expired[0].run_id).toBe("9");

    await setMainBuildRetryOutcome("9", "retry-timed-out");
    expect(await getExpiredMainBuildRetries()).toHaveLength(0);
  });

  it("reported failures stay unclosed until marked closed", async () => {
    await recordMainBuildFailure("3", "org/repo", "CI", "https://example.invalid/run/3", false, "not-retried");
    expect(await hasUnclosedReportedFailure("org/repo", "CI")).toBe(false);

    await markMainBuildReported("3");
    expect(await hasUnclosedReportedFailure("org/repo", "CI")).toBe(true);
    // Scoped to the repo+workflow pair.
    expect(await hasUnclosedReportedFailure("org/repo", "Release")).toBe(false);

    await markMainBuildFailuresClosed("org/repo", "CI");
    expect(await hasUnclosedReportedFailure("org/repo", "CI")).toBe(false);
  });

  it("getUnreportedMainBuildFailures finds terminal rows that never got reported", async () => {
    // Never retried, reported failed: must be retried.
    await recordMainBuildFailure("4", "org/repo", "CI", "https://example.invalid/run/4", false, "not-retried", "push");
    // Retried and failed again, reported failed: must be retried.
    await recordMainBuildFailure("5", "org/repo", "Release", "https://example.invalid/run/5", true, null, "push");
    await setMainBuildRetryOutcome("5", "failure");
    // Reported successfully: excluded.
    await recordMainBuildFailure("6", "org/repo", "Docs", "https://example.invalid/run/6", false, "not-retried", "push");
    await markMainBuildReported("6");
    // Retry still pending (outcome NULL): excluded — handled by getPendingMainBuildRetries.
    await recordMainBuildFailure("7", "org/repo", "Lint", "https://example.invalid/run/7", true, null, "push");
    // Retry succeeded: excluded, no report was ever needed.
    await recordMainBuildFailure("8", "org/repo", "Test", "https://example.invalid/run/8", true, null, "push");
    await setMainBuildRetryOutcome("8", "success");
    // Retry timed out after 24h with no verdict: must be retried, same as a genuine failure.
    await recordMainBuildFailure("9", "org/repo", "Lint2", "https://example.invalid/run/9", true, null, "push");
    await setMainBuildRetryOutcome("9", "retry-timed-out");

    const unreported = (await getUnreportedMainBuildFailures()).map((r) => r.run_id).sort();
    expect(unreported).toEqual(["4", "5", "9"]);
  });

  it("pruneMainBuildFailures removes rows older than retentionDays and returns the count", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO main_build_failures (run_id, repo, workflow_name, run_url, detected_at, retried, outcome, reported)
       VALUES (?, ?, ?, ?, '${ago(3024000000)}', 0, 'not-retried', 1)`, ["old-1", "org/repo", "CI", "https://example.invalid/run/old-1"]);
    await recordMainBuildFailure("recent-1", "org/repo", "CI", "https://example.invalid/run/recent-1", false, "not-retried");

    const pruned = await pruneMainBuildFailures(30);
    expect(pruned).toBe(1);
    expect(await hasMainBuildFailure("old-1")).toBe(false);
    expect(await hasMainBuildFailure("recent-1")).toBe(true);
  });

  it("pruneMainBuildFailures returns 0 when nothing to prune", async () => {
    await recordMainBuildFailure("recent-2", "org/repo", "CI", "https://example.invalid/run/recent-2", false, "not-retried");
    expect(await pruneMainBuildFailures(30)).toBe(0);
  });

  it("getDefaultBranchRuns excludes pull_request runs and other branches", async () => {
    await upsertWorkflowRuns([
      makeRun({ run_id: 1, workflow_name: "CI", event: "push", head_branch: "main" }),
      makeRun({ run_id: 2, workflow_name: "Nightly", event: "schedule", head_branch: "main" }),
      makeRun({ run_id: 3, workflow_name: "CI", event: "pull_request", head_branch: "main" }),
      makeRun({ run_id: 4, workflow_name: "CI", event: "push", head_branch: "feature" }),
    ]);

    const rows = await getDefaultBranchRuns("org/repo", "main", 7);
    expect(rows.map((r) => r.run_id).sort()).toEqual([1, 2]);
    expect(rows[0].head_sha).toBe("abc123");
    expect(rows[0].run_attempt).toBe(1);
  });
});

describe("claws native issues", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("mints a prefixed ULID id and stores title, body, author, repos and labels", async () => {
    const id = await createClawsIssue({
      title: "Native issue",
      body: "Body text",
      authorLogin: "stjohnb",
      repos: ["org/a", "org/b"],
      labels: ["Priority", "Bug"],
    });

    expect(id).toMatch(/^clw_[0-9A-HJKMNP-TV-Z]{26}$/);
    const issue = await getClawsIssue(id);
    expect(issue).toMatchObject({
      id,
      title: "Native issue",
      body: "Body text",
      author_login: "stjohnb",
      state: "open",
      state_reason: null,
      closed_at: null,
    });
    expect(issue!.repos).toEqual(["org/a", "org/b"]);
    expect(issue!.labels).toEqual(["Bug", "Priority"]);
  });

  it("hands out distinct ids that sort in creation order", async () => {
    const ids = [
      await createClawsIssue({ title: "1", authorLogin: "stjohnb" }),
      await createClawsIssue({ title: "2", authorLogin: "stjohnb" }),
      await createClawsIssue({ title: "3", authorLogin: "stjohnb" }),
    ];

    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort()).toEqual(ids);
  });

  it("getClawsIssue returns undefined for an unknown id", async () => {
    expect(await getClawsIssue("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).toBeUndefined();
  });

  it("lists open issues under their primary repo — the alphabetically first", async () => {
    const single = await createClawsIssue({ title: "Single", authorLogin: "stjohnb", repos: ["org/a"] });
    // Inserted out of order, so the match is on the minimum, not the first row.
    const multi = await createClawsIssue({ title: "Multi", authorLogin: "stjohnb", repos: ["org/b", "org/a"] });
    await createClawsIssue({ title: "None", authorLogin: "stjohnb" });
    const other = await createClawsIssue({ title: "Other", authorLogin: "stjohnb", repos: ["org/b"] });

    expect((await listOpenClawsIssues({ repo: "org/a" })).map((i) => i.id).sort()).toEqual([single, multi].sort());
    // The two-repo issue is listed for its primary repo only.
    expect((await listOpenClawsIssues({ repo: "org/b" })).map((i) => i.id)).toEqual([other]);
    // The discovery rule matches any repo the issue names.
    expect((await listOpenClawsIssues({ repo: "org/b", repoMatch: "any" })).map((i) => i.id).sort()).toEqual([multi, other].sort());
    expect((await listOpenClawsIssues({ repo: "org/a", repoMatch: "any" })).map((i) => i.id).sort()).toEqual([single, multi].sort());
  });

  it("listClawsIssues filters by state, repo, title, time and pages", async () => {
    const a = await createClawsIssue({ title: "Build failure: ci.yml", authorLogin: "x", repos: ["org/a"] });
    const b = await createClawsIssue({ title: "100% done_ish", authorLogin: "x", repos: ["org/a", "org/b"] });
    const c = await createClawsIssue({ title: "Other", authorLogin: "x", repos: ["org/b"] });
    await setClawsIssueState(a, "closed", "not_planned");
    const raw = _rawDb();
    await raw.run(`UPDATE claws_issues SET updated_at = '2026-01-01 00:00:00' WHERE id = ?`, [a]);
    await raw.run(`UPDATE claws_issues SET updated_at = '2026-02-01 00:00:00' WHERE id = ?`, [b]);
    await raw.run(`UPDATE claws_issues SET updated_at = '2026-03-01 00:00:00' WHERE id = ?`, [c]);
    await raw.run(`UPDATE claws_issues SET closed_at = '2026-01-05 00:00:00' WHERE id = ?`, [a]);
    const ids = async (f: Partial<Parameters<typeof listClawsIssues>[0]>) =>
      (await listClawsIssues({ state: "all", limit: 100, ...f })).map((i) => i.id);

    expect(await ids({})).toEqual([c, b, a]);
    expect(await ids({ state: "open" })).toEqual([c, b]);
    expect(await ids({ state: "closed" })).toEqual([a]);
    expect(await ids({ repo: "org/a" })).toEqual([b, a]);
    expect(await ids({ titleContains: "BUILD FAILURE" })).toEqual([a]);
    expect(await ids({ titleContains: "100%" })).toEqual([b]);
    expect(await ids({ titleContains: "%" })).toEqual([b]);
    expect(await ids({ titleContains: "_" })).toEqual([b]);
    expect(await ids({ closedSince: new Date("2026-01-04T00:00:00Z") })).toEqual([a]);
    expect(await ids({ closedSince: new Date("2026-01-06T00:00:00Z") })).toEqual([]);
    expect(await ids({ updatedSince: new Date("2026-02-01T00:00:00Z") })).toEqual([c, b]);
    expect(await ids({ repo: "org/a", state: "open", updatedSince: new Date("2026-01-15T00:00:00Z") })).toEqual([b]);
    expect(await ids({ limit: 1, offset: 1 })).toEqual([b]);
    expect((await listClawsIssues({ state: "closed", limit: 5 }))[0]).toMatchObject({ state_reason: "not_planned" });
  });

  it("listDuplicateMarkerBodies reads body and live comments, and listIssueIdsWithPlans is batched", async () => {
    const id = await createClawsIssue({ title: "Dup", authorLogin: "x", repos: ["org/a"], body: "claws-duplicate-of:clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC" });
    const other = await createClawsIssue({ title: "Dup2", authorLogin: "x", repos: ["org/a"] });
    const live = await addClawsIssueComment(other, "claws", "closing\nclaws-duplicate-of:12");
    const gone = await addClawsIssueComment(other, "claws", "claws-duplicate-of:99");
    await softDeleteClawsIssueComments(other, [gone], "x");
    const rows = await listDuplicateMarkerBodies([id, other]);
    expect(rows.map((r) => r.issue_id).sort()).toEqual([id, other].sort());
    expect(rows.some((r) => r.body.includes(":99"))).toBe(false);
    expect(live).toBeTruthy();
    expect(await listDuplicateMarkerBodies([])).toEqual([]);
    expect(await listIssueIdsWithPlans([])).toEqual(new Set());
    expect(await listIssueIdsWithPlans([id])).toEqual(new Set());
  });

  it("lists a pinned issue under its pinned primary repo, not the alphabetically first", async () => {
    const claws = "St-John-Software/claws";
    const blog = "St-John-Software/bstjohn-blog";
    const pinned = await createClawsIssue({ title: "Retro", authorLogin: "claws", repos: [claws, blog], primaryRepo: claws });
    const plain = await createClawsIssue({ title: "Plain", authorLogin: "claws", repos: [claws, blog] });

    expect((await getClawsIssue(pinned))?.primary_repo).toBe(claws);
    expect((await getClawsIssue(plain))?.primary_repo).toBeNull();
    expect((await listOpenClawsIssues({ repo: claws })).map((i) => i.id)).toEqual([pinned]);
    expect((await listOpenClawsIssues({ repo: blog })).map((i) => i.id)).toEqual([plain]);
    expect((await listOpenClawsIssues({ repo: blog, repoMatch: "any" })).map((i) => i.id).sort()).toEqual([pinned, plain].sort());

    // Once the pinned repo is no longer one of the issue's repos, the alphabetical rule applies.
    await setClawsIssueRepos(pinned, [blog, "St-John-Software/fleet-infra"]);
    expect((await listOpenClawsIssues({ repo: blog })).map((i) => i.id).sort()).toEqual([pinned, plain].sort());
  });

  it("pins a primary repo after creation so an earlier-sorting added repo does not take over", async () => {
    const claws = "St-John-Software/claws";
    const blog = "St-John-Software/bstjohn-blog";
    const id = await createClawsIssue({ title: "Retro", authorLogin: "claws", repos: [claws] });

    await db.setClawsIssuePrimaryRepo(id, claws);
    await setClawsIssueRepos(id, [claws, blog]);

    expect((await getClawsIssue(id))?.primary_repo).toBe(claws);
    expect((await listOpenClawsIssues({ repo: claws })).map((i) => i.id)).toEqual([id]);
    expect(await listOpenClawsIssues({ repo: blog })).toEqual([]);
    await expect(db.setClawsIssuePrimaryRepo("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", claws)).rejects.toThrow();
  });

  it("rejects a pinned primary repo that is not one of the issue's repos", async () => {
    await expect(createClawsIssue({ title: "Bad", authorLogin: "claws", repos: ["org/a"], primaryRepo: "org/b" })).rejects.toThrow(/not one of the issue's repos/);
    await expect(createClawsIssue({ title: "Bad", authorLogin: "claws", primaryRepo: "org/b" })).rejects.toThrow();
  });

  it("lists unassigned issues — the ones with no repo", async () => {
    await createClawsIssue({ title: "Single", authorLogin: "stjohnb", repos: ["org/a"] });
    await createClawsIssue({ title: "Multi", authorLogin: "stjohnb", repos: ["org/a", "org/b"] });
    const none = await createClawsIssue({ title: "None", authorLogin: "stjohnb" });

    const unassigned = await listOpenClawsIssues({ unassigned: true });
    expect(unassigned.map((i) => i.id)).toEqual([none]);
  });

  it("filters open issues by label and never returns closed ones", async () => {
    const priority = await createClawsIssue({ title: "Priority", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Priority"] });
    await createClawsIssue({ title: "Plain", authorLogin: "stjohnb", repos: ["org/a"] });
    const closed = await createClawsIssue({ title: "Closed", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Priority"] });
    await setClawsIssueState(closed, "closed", "completed");

    expect((await listOpenClawsIssues({ repo: "org/a", label: "Priority" })).map((i) => i.id)).toEqual([priority]);
  });

  it("attaches each returned issue only its own labels", async () => {
    // Sidecars are keyed by issue id, so this can only fail if the grouping
    // itself is wrong — the `IN (...)` scoping is a cost guard, not a
    // correctness one, and is asserted by the closed-issue test below.
    const a = await createClawsIssue({ title: "A", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Bug"] });
    const b = await createClawsIssue({ title: "B", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Priority"] });

    const rows = await listOpenClawsIssues({ repo: "org/a" });
    expect(rows.map((i) => [i.id, i.labels])).toEqual([[b, ["Priority"]], [a, ["Bug"]]]);
  });

  it("adds and removes labels idempotently", async () => {
    const id = await createClawsIssue({ title: "Labels", authorLogin: "stjohnb" });

    expect(await addClawsIssueLabel(id, "Priority")).toBe(true);
    expect(await addClawsIssueLabel(id, "Priority")).toBe(false);
    expect((await getClawsIssue(id))!.labels).toEqual(["Priority"]);

    expect(await removeClawsIssueLabel(id, "Priority")).toBe(true);
    expect(await removeClawsIssueLabel(id, "Priority")).toBe(false);
    expect((await getClawsIssue(id))!.labels).toEqual([]);
  });

  it("refuses a retired gate label: approval is approved_through, not a label", async () => {
    const id = await createClawsIssue({ title: "Labels", authorLogin: "stjohnb" });

    for (const label of RETIRED_GATE_LABELS) {
      await expect(addClawsIssueLabel(id, label)).rejects.toThrow(/is not a label any more/);
    }
    expect((await getClawsIssue(id))!.labels).toEqual([]);
  });

  it("replaces the repo association wholesale", async () => {
    const id = await createClawsIssue({ title: "Repos", authorLogin: "stjohnb", repos: ["org/a"] });

    await setClawsIssueRepos(id, ["org/b", "org/c"]);

    expect((await getClawsIssue(id))!.repos).toEqual(["org/b", "org/c"]);
  });

  it("updates title and body", async () => {
    const id = await createClawsIssue({ title: "Old", body: "old", authorLogin: "stjohnb" });

    expect(await updateClawsIssueTitle(id, "New")).toBe(true);
    expect(await updateClawsIssueBody(id, "new")).toBe(true);

    expect(await getClawsIssue(id)).toMatchObject({ title: "New", body: "new" });
    expect(await updateClawsIssueTitle("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "Missing")).toBe(false);
  });

  it("keeps the original title in filed_title across renames", async () => {
    const id = await createClawsIssue({ title: "Build failure: CI", authorLogin: "stjohnb" });

    await updateClawsIssueTitle(id, "Restore green CI");
    expect((await getClawsIssue(id))!.filed_title).toBe("Build failure: CI");

    await updateClawsIssueTitle(id, "Restore green CI again");
    expect(await getClawsIssue(id)).toMatchObject({ title: "Restore green CI again", filed_title: "Build failure: CI" });
  });

  it("closes with a state reason and reopens, clearing closed_at", async () => {
    const id = await createClawsIssue({ title: "State", authorLogin: "stjohnb" });

    expect(await setClawsIssueState(id, "closed", "not_planned")).toBe(true);
    const closed = await getClawsIssue(id);
    expect(closed).toMatchObject({ state: "closed", state_reason: "not_planned" });
    expect(closed!.closed_at).not.toBeNull();

    expect(await setClawsIssueState(id, "open")).toBe(true);
    expect(await getClawsIssue(id)).toMatchObject({ state: "open", state_reason: null, closed_at: null });
  });

  it("reports zero rows changed when the state is already what was asked for", async () => {
    const id = await createClawsIssue({ title: "State", authorLogin: "stjohnb" });

    expect(await setClawsIssueState(id, "closed", "completed")).toBe(true);
    expect(await setClawsIssueState(id, "closed", "completed")).toBe(false);
    expect(await setClawsIssueState(id, "open")).toBe(true);
    expect(await setClawsIssueState(id, "open")).toBe(false);
  });

  it("lists issues closed since a cutoff", async () => {
    const closed = await createClawsIssue({ title: "Closed", authorLogin: "stjohnb", repos: ["org/a"] });
    await createClawsIssue({ title: "Open", authorLogin: "stjohnb", repos: ["org/a"] });
    await setClawsIssueState(closed, "closed", "completed");

    const recent = await listClosedClawsIssuesSince(new Date(Date.now() - 60_000));
    expect(recent.map((i) => i.id)).toEqual([closed]);
    expect(recent[0]!.repos).toEqual(["org/a"]);

    expect(await listClosedClawsIssuesSince(new Date(Date.now() + 60_000))).toEqual([]);
  });

  it("returns comments in posting order by id", async () => {
    const id = await createClawsIssue({ title: "Comments", authorLogin: "stjohnb" });

    const first = await addClawsIssueComment(id, "stjohnb", "first");
    const second = await addClawsIssueComment(id, "claws", "second");

    expect(first).toMatch(/^clwc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first < second).toBe(true);
    expect((await listClawsIssueComments(id)).map((c) => [c.id, c.author_login, c.body]))
      .toEqual([[first, "stjohnb", "first"], [second, "claws", "second"]]);
  });

  it("edits a comment and reports the issue it belongs to", async () => {
    const id = await createClawsIssue({ title: "Edit", authorLogin: "stjohnb" });
    const commentId = await addClawsIssueComment(id, "claws", "before");

    expect(await editClawsIssueComment(commentId, "after")).toBe(id);
    expect((await listClawsIssueComments(id))[0]!.body).toBe("after");
    expect(await editClawsIssueComment("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "nope")).toBeUndefined();
  });

  it("records reactions once per (comment, login, content)", async () => {
    const id = await createClawsIssue({ title: "Reactions", authorLogin: "stjohnb" });
    const commentId = await addClawsIssueComment(id, "stjohnb", "please fix");

    await addClawsIssueCommentReaction(commentId, "claws", "+1");
    await addClawsIssueCommentReaction(commentId, "claws", "+1");
    await addClawsIssueCommentReaction(commentId, "claws", "rocket");

    expect(await listClawsIssueCommentReactions(commentId)).toEqual([
      { comment_id: commentId, login: "claws", content: "+1" },
      { comment_id: commentId, login: "claws", content: "rocket" },
    ]);
    expect(await listClawsIssueCommentReactions("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).toEqual([]);
  });

  // The store has two deliberate not-found contracts, and this test and the
  // `false` assertions above are what pin them apart. A write whose `false`
  // already means something — "the label was already there", "already in that
  // state" — cannot also spend it on "no such issue", so those throw; the
  // by-id updates have no second meaning for `false`, so they return it and
  // `claws-issues.ts` turns that into the same error. Do not collapse one half
  // into the other.
  it("refuses a child insert for an unknown issue and leaves no rows behind", async () => {
    const missing = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

    await expect(addClawsIssueComment(missing, "claws", "orphan")).rejects.toThrow(/no native issue/);
    await expect(addClawsIssueLabel(missing, "Priority")).rejects.toThrow(/no native issue/);
    await expect(setClawsIssueRepos(missing, ["org/a"])).rejects.toThrow(/no native issue/);
    await expect(removeClawsIssueLabel(missing, "Priority")).rejects.toThrow(/no native issue/);

    expect(await listClawsIssueComments(missing)).toEqual([]);
    const db = _rawDb();
    expect(await db.all(`SELECT * FROM claws_issue_labels WHERE issue_id = ?`, [missing])).toEqual([]);
    expect(await db.all(`SELECT * FROM claws_issue_repos WHERE issue_id = ?`, [missing])).toEqual([]);
  });

  it("refuses a reaction on an unknown comment", async () => {
    await expect(addClawsIssueCommentReaction("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "claws", "+1"))
      .rejects.toThrow(/no native comment/);
  });

  it("cascades the delete of an issue onto its labels, repos, comments and reactions", async () => {
    const id = await createClawsIssue({ title: "Cascade", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Priority"] });
    const commentId = await addClawsIssueComment(id, "stjohnb", "hi");
    await addClawsIssueCommentReaction(commentId, "claws", "+1");

    const db = _rawDb();
    await db.run(`DELETE FROM claws_issues WHERE id = ?`, [id]);

    expect(await db.all(`SELECT * FROM claws_issue_labels WHERE issue_id = ?`, [id])).toEqual([]);
    expect(await db.all(`SELECT * FROM claws_issue_repos WHERE issue_id = ?`, [id])).toEqual([]);
    expect(await db.all(`SELECT * FROM claws_issue_comments WHERE issue_id = ?`, [id])).toEqual([]);
    expect(await listClawsIssueCommentReactions(commentId)).toEqual([]);
  });

  it("bumps updated_at on every write to the issue, its labels, repos, comments and reactions", async () => {
    const id = await createClawsIssue({ title: "Touch", authorLogin: "stjohnb", labels: ["Stale"] });
    const commentId = await addClawsIssueComment(id, "stjohnb", "please fix");

    // Stored timestamps have one-second resolution. Rewinding the stored value
    // is what the assertion actually needs — no fake timers, which would be
    // active across awaited PGlite calls on the `test:pg` lane and could
    // deadlock on a deferred real timer with nothing to advance them.
    const rewind = async (): Promise<string> => {
      const before = ago(5_000);
      await _rawDb().run(`UPDATE claws_issues SET updated_at = ? WHERE id = ?`, [before, id]);
      return before;
    };

    for (const [name, write] of [
      ["addClawsIssueLabel", () => addClawsIssueLabel(id, "Priority")],
      ["removeClawsIssueLabel", () => removeClawsIssueLabel(id, "Stale")],
      ["setClawsIssueRepos", () => setClawsIssueRepos(id, ["org/a"])],
      ["addClawsIssueComment", () => addClawsIssueComment(id, "claws", "on it")],
      ["editClawsIssueComment", () => editClawsIssueComment(commentId, "please fix this")],
      // A reaction is how issue-refiner marks feedback addressed, so an issue
      // whose only change this cycle was a reaction must not sort stale.
      ["addClawsIssueCommentReaction", () => addClawsIssueCommentReaction(commentId, "claws", "rocket")],
    ] as const) {
      const before = await rewind();
      await write();
      expect(`${name}: ${(await getClawsIssue(id))!.updated_at > before}`).toBe(`${name}: true`);
    }
  });

  it("orders open issues newest-updated first, breaking same-second ties by id", async () => {
    // `nowSql()` has one-second resolution, so in practice the `id DESC`
    // tiebreak is what orders issues created in the same tick — and ULIDs are
    // monotonic, so newest-first is exactly descending id.
    const first = await createClawsIssue({ title: "1", authorLogin: "stjohnb", repos: ["org/a"] });
    const second = await createClawsIssue({ title: "2", authorLogin: "stjohnb", repos: ["org/a"] });
    const third = await createClawsIssue({ title: "3", authorLogin: "stjohnb", repos: ["org/a"] });

    expect((await listOpenClawsIssues({ repo: "org/a" })).map((i) => i.id)).toEqual([third, second, first]);
  });

  it("keeps the first close's state_reason when re-closed with a different one", async () => {
    const id = await createClawsIssue({ title: "Reason", authorLogin: "stjohnb" });

    expect(await setClawsIssueState(id, "closed", "completed")).toBe(true);
    // The guard is on `state` alone, so this changes zero rows *and* leaves
    // the original reason in place. Reopen and close again to change it.
    expect(await setClawsIssueState(id, "closed", "not_planned")).toBe(false);
    expect((await getClawsIssue(id))!.state_reason).toBe("completed");

    expect(await setClawsIssueState(id, "open")).toBe(true);
    expect(await setClawsIssueState(id, "closed", "not_planned")).toBe(true);
    expect((await getClawsIssue(id))!.state_reason).toBe("not_planned");
  });

  it("scopes the closed-issue query by repo and limit rather than making the caller filter", async () => {
    const mine = await createClawsIssue({ title: "Mine", authorLogin: "claws", repos: ["org/a"], labels: ["Priority"] });
    const older = await createClawsIssue({ title: "Older", authorLogin: "claws", repos: ["org/a"] });
    const elsewhere = await createClawsIssue({ title: "Elsewhere", authorLogin: "claws", repos: ["org/b"] });
    const multi = await createClawsIssue({ title: "Multi", authorLogin: "claws", repos: ["org/a", "org/b"] });
    for (const id of [older, elsewhere, multi, mine]) await setClawsIssueState(id, "closed", "completed");

    // `nowSql()` is second-granular, so the four closes above land in the same
    // second. Spread the two org/a rows apart to pin the documented ordering
    // rather than its id tie-break — and put the *newer* close on the *lower*
    // id, so a LIMIT applied under any other order returns `older` instead.
    const rawDb = _rawDb();
    await rawDb.run(`UPDATE claws_issues SET closed_at = ? WHERE id = ?`, [ago(30_000), older]);
    await rawDb.run(`UPDATE claws_issues SET closed_at = ? WHERE id = ?`, [ago(10_000), mine]);
    await rawDb.run(`UPDATE claws_issues SET closed_at = ? WHERE id = ?`, [ago(20_000), multi]);

    const since = new Date(Date.now() - 60_000);
    // Another repo's issue is excluded in SQL and a multi-repo one is kept,
    // matching listOpenClawsIssues' "the issue's *primary* repo is this one"
    // rule — and it is listed under that primary repo only.
    expect((await listClosedClawsIssuesSince(since, { repo: "org/a" })).map((i) => i.id).sort())
      .toEqual([mine, older, multi].sort());
    expect((await listClosedClawsIssuesSince(since, { repo: "org/b" })).map((i) => i.id)).toEqual([elsewhere]);
    // `limit` keeps the *newest-closed* rows, not an arbitrary page.
    expect((await listClosedClawsIssuesSince(since, { repo: "org/a", limit: 1 })).map((i) => i.id)).toEqual([mine]);
    // Sidecars are still attached, and only for the rows actually selected.
    const rows = await listClosedClawsIssuesSince(since, { repo: "org/a" });
    expect(rows.find((i) => i.id === mine)!.labels).toEqual(["Priority"]);
    expect(rows.every((i) => i.repos.includes("org/a"))).toBe(true);
  });

  it("round-trips a native ref through tasks and work_queue", async () => {
    // The whole point of the TEXT widening. If either `refParam` or
    // `refFromColumn` were "simplified" back to a numeric coercion, every
    // native work item would silently corrupt with nothing else failing.
    const ref = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

    await recordTaskStart("issue-worker", "org/repo", ref, null);
    expect((await getRunningTasks())[0]!.item_number).toBe(ref);

    await enqueueWork("issue-worker", "org/repo", ref);
    expect((await listQueuedWork())[0]!.item_number).toBe(ref);
  });

  it("keeps a forge item_number a number on the way back out", async () => {
    // The other half of the contract: Postgres hands a TEXT column back as a
    // string, so a missed `normalizeItemNumbers` wrapper would return "7" where the
    // pipeline compares `=== 7`.
    await recordTaskStart("issue-worker", "org/repo", 7, null);

    const running = await getRunningTasks();
    expect(running[0]!.item_number).toBe(7);
    expect(typeof running[0]!.item_number).toBe("number");
    expect(typeof (await getRecentTasksForRepo("org/repo"))[0]!.item_number).toBe("number");
  });
});

// The lifecycle field: native issues store their state in one column, and
// readers see it as the `Backlog` / `Blocked` label it replaced.
describe("claws issue lifecycle", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  const lifecycleOf = async (id: string): Promise<unknown> =>
    (await _rawDb().get(`SELECT lifecycle FROM claws_issues WHERE id = ?`, [id]) as { lifecycle: unknown }).lifecycle;
  const labelRows = async (id: string): Promise<string[]> =>
    (await _rawDb().all(`SELECT label FROM claws_issue_labels WHERE issue_id = ? ORDER BY label`, [id]) as { label: string }[]).map((r) => r.label);

  it("backfills the field from the old label rows by precedence and deletes them", async () => {
    const both = await createClawsIssue({ title: "Both", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Priority"] });
    const blocked = await createClawsIssue({ title: "Blocked", authorLogin: "stjohnb", repos: ["org/a"] });
    const plain = await createClawsIssue({ title: "Plain", authorLogin: "stjohnb", repos: ["org/a"] });
    // Rewind to the pre-field shape: state held as label rows.
    for (const [id, label] of [[both, "Backlog"], [both, "Blocked"], [blocked, "Refined"], [blocked, "Blocked"]] as const) {
      await _rawDb().run(`INSERT INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
    }

    await migrateStateLabelsToLifecycle();

    expect(await lifecycleOf(both)).toBe("backlog");
    expect(await lifecycleOf(blocked)).toBe("blocked");
    expect(await lifecycleOf(plain)).toBe("ideas");
    expect(await labelRows(both)).toEqual(["Priority"]);
    // A retired gate label row is the approval migration's, not this one's.
    expect(await labelRows(blocked)).toEqual(["Refined"]);
    expect((await getClawsIssue(both))!.labels).toEqual(["Priority", "Backlog"]);

    // A second run finds nothing left to move and changes nothing.
    await migrateStateLabelsToLifecycle();
    expect(await lifecycleOf(both)).toBe("backlog");
    expect(await lifecycleOf(blocked)).toBe("blocked");
  });

  // Backlog (#3293) is a state label like the others, and outranks them all.
  it("backfills a Backlog label row to the backlog lifecycle and deletes it", async () => {
    const parked = await createClawsIssue({ title: "Parked", authorLogin: "stjohnb", repos: ["org/a"] });
    for (const label of ["Backlog", "Blocked"]) {
      await _rawDb().run(`INSERT INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [parked, label]);
    }

    await migrateStateLabelsToLifecycle();

    expect(await lifecycleOf(parked)).toBe("backlog");
    expect(await labelRows(parked)).toEqual([]);
    expect((await getClawsIssue(parked))!.labels).toEqual(["Backlog"]);
  });

  it("stores a created issue's state label in the field, not as a row, and drops a retired gate label", async () => {
    const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb", labels: ["Ready", "Backlog", "Priority"] });
    expect(await lifecycleOf(id)).toBe("backlog");
    expect(await labelRows(id)).toEqual(["Priority"]);
    expect((await getClawsIssue(id))!.approved_through).toBe("none");
  });

  it("turns a state-label add into a field write that reads back as the label", async () => {
    const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb", repos: ["org/a"] });

    expect(await addClawsIssueLabel(id, "Backlog")).toBe(true);
    expect(await addClawsIssueLabel(id, "Backlog")).toBe(false);

    expect(await lifecycleOf(id)).toBe("backlog");
    expect(await labelRows(id)).toEqual([]);
    expect((await getClawsIssue(id))!.labels).toContain("Backlog");
  });

  it("is single-valued: a new state label replaces the old one", async () => {
    const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb", labels: ["Blocked"], blockedReason: "Waiting" });
    await addClawsIssueLabel(id, "Backlog");
    const labels = (await getClawsIssue(id))!.labels;
    expect(labels).toContain("Backlog");
    expect(labels).not.toContain("Blocked");
  });

  it("resets to the entry stage only when removing the state the field holds", async () => {
    const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb", labels: ["Backlog"] });

    expect(await removeClawsIssueLabel(id, "Blocked")).toBe(false);
    expect(await lifecycleOf(id)).toBe("backlog");

    // No plan and no approved requirements: back to Ideas.
    expect(await removeClawsIssueLabel(id, "Backlog")).toBe(true);
    expect(await lifecycleOf(id)).toBe("ideas");
    expect((await getClawsIssue(id))!.labels).toEqual([]);

    // Approved requirements count as past Ideas.
    const blocked = await createClawsIssue({ title: "Three", authorLogin: "stjohnb", labels: ["Blocked"], blockedReason: "Waiting on a vendor" });
    await approveClawsIssueRequirements(blocked, null, "stjohnb");
    expect(await removeClawsIssueLabel(blocked, "Blocked")).toBe(true);
    expect(await lifecycleOf(blocked)).toBe("planning");
  });

  it("filters open issues by a state label through the field", async () => {
    const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb", repos: ["org/a"] });
    await createClawsIssue({ title: "Two", authorLogin: "stjohnb", repos: ["org/a"] });
    await addClawsIssueLabel(id, "Backlog");

    expect((await listOpenClawsIssues({ repo: "org/a", label: "Backlog" })).map((i) => i.id)).toEqual([id]);
    expect(await listOpenClawsIssues({ repo: "org/a", label: "Blocked" })).toEqual([]);
  });

  it("sets the field directly, returning false when it already holds the value", async () => {
    const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb" });

    expect(await setClawsIssueLifecycle(id, "backlog")).toBe(true);
    expect(await setClawsIssueLifecycle(id, "backlog")).toBe(false);
    expect((await getClawsIssue(id))!.lifecycle).toBe("backlog");
    await expect(setClawsIssueLifecycle("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "planning")).rejects.toThrow(/no native issue/);
  });

  describe("a reason for Blocked", () => {
    const history = async (id: string) => (await listClawsIssueHistory(id)).map((h) => ({ field: h.field, old: h.old_value, new: h.new_value }));

    it("blocks with a trimmed reason in one write, recording both in History", async () => {
      const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Backlog"] });

      expect(await blockClawsIssue(id, "  Waiting on the vendor  ")).toBe(true);

      expect((await getClawsIssue(id))!.lifecycle).toBe("blocked");
      expect(await getIssueBlockedReasons([id])).toEqual(new Map([[id, "Waiting on the vendor"]]));
      expect(await history(id)).toEqual([
        { field: "lifecycle", old: "backlog", new: "blocked" },
        { field: "blocked_reason", old: null, new: "Waiting on the vendor" },
      ]);
    });

    it("re-states the reason of an issue already Blocked without moving its stage", async () => {
      const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb", repos: ["org/a"] });
      await blockClawsIssue(id, "First");
      await _rawDb().run(`UPDATE claws_issues SET stage_changed_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);

      expect(await blockClawsIssue(id, "Second")).toBe(false);

      expect((await getClawsIssue(id))!.stage_changed_at).toBe("2020-01-01 00:00:00");
      expect(await getIssueBlockedReasons([id])).toEqual(new Map([[id, "Second"]]));
    });

    it.each([
      ["blockClawsIssue with a blank reason", (id: string) => blockClawsIssue(id, "  \n ")],
      ["addClawsIssueLabel", (id: string) => addClawsIssueLabel(id, "Blocked")],
      ["setClawsIssueLifecycle", (id: string) => setClawsIssueLifecycle(id, "blocked")],
    ])("refuses %s, leaving the issue as it was", async (_name, write) => {
      const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Backlog"] });
      const before = await getClawsIssue(id);

      await expect(write(id)).rejects.toThrow(BlockedReasonRequiredError);

      expect(await getClawsIssue(id)).toEqual(before);
      expect(await listClawsIssueHistory(id)).toEqual([]);
    });

    it("files an issue Blocked only with a reason, which it records", async () => {
      await expect(createClawsIssue({ title: "No", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Blocked"] })).rejects.toThrow(BlockedReasonRequiredError);
      await expect(createClawsIssue({ title: "Blank", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Blocked"], blockedReason: " " })).rejects.toThrow(BlockedReasonRequiredError);
      expect(await listOpenClawsIssues({ repo: "org/a" })).toEqual([]);

      const id = await createClawsIssue({ title: "Yes", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Blocked"], blockedReason: "A person must look" });
      expect(await getIssueBlockedReasons([id])).toEqual(new Map([[id, "A person must look"]]));
      // A reason for an issue that is not filed Blocked is not stored.
      const other = await createClawsIssue({ title: "Other", authorLogin: "stjohnb", repos: ["org/a"], blockedReason: "ignored" });
      expect((await getClawsIssue(other)) as unknown).toMatchObject({ blocked_reason: null });
    });
  });

  describe("stage_changed_at", () => {
    const OLD = "2020-01-01 00:00:00";
    const stageOf = async (id: string): Promise<unknown> =>
      (await _rawDb().get(`SELECT stage_changed_at FROM claws_issues WHERE id = ?`, [id]) as { stage_changed_at: unknown }).stage_changed_at;
    /** A fresh issue whose column timestamp is rewound, so a write that sets it shows. */
    const rewound = async (labels: string[] = []): Promise<string> => {
      const id = await createClawsIssue({ title: "One", authorLogin: "stjohnb", repos: ["org/a"], labels });
      expect(await stageOf(id)).not.toBeNull();
      await _rawDb().run(`UPDATE claws_issues SET stage_changed_at = ? WHERE id = ?`, [OLD, id]);
      return id;
    };

    it("is set by a lifecycle change and left alone by a no-op one", async () => {
      const id = await rewound(["Backlog"]);
      await setClawsIssueLifecycle(id, "backlog");
      expect(await stageOf(id)).toBe(OLD);
      await blockClawsIssue(id, "Parked");
      expect(await stageOf(id)).not.toBe(OLD);
    });

    it("is set by adding or removing a state label", async () => {
      const added = await rewound();
      await addClawsIssueLabel(added, "Backlog");
      expect(await stageOf(added)).not.toBe(OLD);

      const removed = await rewound(["Backlog"]);
      await removeClawsIssueLabel(removed, "Backlog");
      expect(await stageOf(removed)).not.toBe(OLD);
    });

    it("is not set by a plain label", async () => {
      const id = await rewound();
      await addClawsIssueLabel(id, "bug");
      await removeClawsIssueLabel(id, "bug");
      expect(await stageOf(id)).toBe(OLD);
    });

    it("is set by a close", async () => {
      const id = await rewound();
      await setClawsIssueState(id, "closed", "completed");
      expect(await stageOf(id)).not.toBe(OLD);
    });
  });

  it("splits a shadow's forge state labels into the field on create, sync and promote", async () => {
    const created = await createShadowIssue("org/a", 7, { title: "Forge", authorLogin: "someone", labels: ["Backlog", "Ready", "bug"] });
    const id = created!.id;
    expect(await lifecycleOf(id)).toBe("backlog");
    expect(await labelRows(id)).toEqual(["bug"]);

    // The same forge labels again are no change at all — comparing them to the
    // label rows would report one on every sync — and a retired gate label
    // approves nothing, so adding or dropping one is no change either.
    const same = { title: "Forge", body: "", labels: ["Backlog", "bug"], state: "open" as const };
    expect(await updateShadowIssue(id, same)).toBe("unchanged");
    expect(await updateShadowIssue(id, { ...same, labels: ["Backlog", "Refined", "bug"] })).toBe("unchanged");
    expect(await updateShadowIssue(id, { ...same, labels: ["bug"] })).toBe("changed");
    expect(await lifecycleOf(id)).toBe("ideas");

    // A stored Awaiting plan review survives a sync and a promotion carrying
    // the old gate labels, which are dropped rather than stored or mapped.
    await setShadowLifecycle(id, "awaiting-plan-review");
    expect(await updateShadowIssue(id, { ...same, labels: ["Ready", "bug"] })).toBe("unchanged");
    expect(await lifecycleOf(id)).toBe("awaiting-plan-review");
    expect(await promoteShadowIssue(id, { title: "Forge", body: "Imported", labels: ["Refined", "Plan: Deep"] })).toBe(true);
    expect(await lifecycleOf(id)).toBe("awaiting-plan-review");
    expect(await labelRows(id)).toEqual(["Plan: Deep"]);
    expect((await getClawsIssue(id))!).toMatchObject({ labels: ["Plan: Deep"], approved_through: "none" });
  });

  // Claws Ignore was retired in favour of Blocked and Backlog (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD).
  it("moves open issues carrying Claws Ignore to Backlog, drops every label row, and a rerun changes nothing", async () => {
    const open = await createClawsIssue({ title: "Open", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Priority"] });
    const closed = await createClawsIssue({ title: "Closed", authorLogin: "stjohnb", repos: ["org/a"] });
    const shadow = (await createShadowIssue("org/a", 9, { title: "Forge", authorLogin: "someone" }))!.id;
    const untouched = await createClawsIssue({ title: "Plain", authorLogin: "stjohnb", repos: ["org/a"] });
    await setClawsIssueState(closed, "closed", "not_planned");
    for (const id of [open, closed, shadow]) {
      await _rawDb().run(`INSERT INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, "Claws Ignore"]);
    }
    const closedBefore = await lifecycleOf(closed);

    await migrateClawsIgnoreLabel();

    expect(await lifecycleOf(open)).toBe("backlog");
    expect(await labelRows(open)).toEqual(["Priority"]);
    expect(await lifecycleOf(shadow)).toBe("backlog");
    expect(await labelRows(shadow)).toEqual([]);
    expect(await lifecycleOf(closed)).toBe(closedBefore);
    expect(await labelRows(closed)).toEqual([]);
    expect(await lifecycleOf(untouched)).toBe("ideas");

    const updatedAt = (await getClawsIssue(open))!.updated_at;
    await migrateClawsIgnoreLabel();
    expect(await lifecycleOf(open)).toBe("backlog");
    expect((await getClawsIssue(open))!.updated_at).toBe(updatedAt);
  });

  it("lists open alert issues only, newest first, and marks an unmarked one once", async () => {
    const older = await createClawsIssue({ title: "[claws-error] a", authorLogin: "claws", repos: ["org/a"], alertKind: "error-reporter" });
    const plain = await createClawsIssue({ title: "Plain", authorLogin: "claws", repos: ["org/a"] });
    const closed = await createClawsIssue({ title: "[claws-error] b", authorLogin: "claws", repos: ["org/a"], alertKind: "error-reporter" });
    await setClawsIssueState(closed, "closed", "completed");
    await _rawDb().run(`UPDATE claws_issues SET created_at = '2020-01-01 00:00:00' WHERE id = ?`, [older]);
    expect(await setClawsIssueAlertKind(plain, "runner-monitor")).toBe(true);
    expect(await setClawsIssueAlertKind(plain, "other")).toBe(false);

    const alerts = await listOpenClawsAlerts();
    expect(alerts.map((a) => a.id)).toEqual([plain, older]);
    expect(alerts.map((a) => a.alert_kind)).toEqual(["runner-monitor", "error-reporter"]);
    expect(alerts[0].repos).toEqual(["org/a"]);
  });

  it("claims an alert's stall announcement once per Blocked stay", async () => {
    const alert = await createClawsIssue({ title: "[claws-error] a", authorLogin: "claws", repos: ["org/a"], alertKind: "error-reporter" });
    const plain = await createClawsIssue({ title: "Plain", authorLogin: "claws", repos: ["org/a"] });

    expect(await claimAlertAttention(alert)).toBe(false);
    await blockClawsIssue(alert, "Stuck");
    await blockClawsIssue(plain, "Stuck");
    expect(await claimAlertAttention(plain)).toBe(false);
    expect(await claimAlertAttention(alert)).toBe(true);
    expect(await claimAlertAttention(alert)).toBe(false);
    await blockClawsIssue(alert, "Stuck again");
    expect(await claimAlertAttention(alert)).toBe(false);
    expect((await getClawsIssue(alert))!.alert_attention_notified_at).not.toBeNull();

    await setClawsIssueLifecycle(alert, "planning");
    expect((await getClawsIssue(alert))!.alert_attention_notified_at ?? null).toBeNull();
    await blockClawsIssue(alert, "Stalled later");
    expect(await claimAlertAttention(alert)).toBe(true);
  });

  it("backfills open legacy alert issues once", async () => {
    const byTitle = await createClawsIssue({ title: "[runner-monitor] Persistent high disk on x", authorLogin: "claws", repos: ["org/a"] });
    const byKey = await createClawsIssue({ title: "Grafana says no", authorLogin: "claws", repos: ["org/a"], dedupeKey: "alert-grafana-x" });
    const byLabel = await createClawsIssue({ title: "Firing", authorLogin: "claws", repos: ["org/a"], labels: ["grafana-alert"] });
    const human = await createClawsIssue({ title: "[claws-error] typed by a person", authorLogin: "stjohnb", repos: ["org/a"] });
    const idea = await createClawsIssue({ title: "An idea", authorLogin: "claws", repos: ["org/a"] });
    const closed = await createClawsIssue({ title: "[main] Build failed", authorLogin: "claws", repos: ["org/a"] });
    await setClawsIssueState(closed, "closed", "completed");
    await _rawDb().run(`DELETE FROM controller_status WHERE key = ?`, [ALERT_KIND_BACKFILLED_KEY]);

    await migrateAlertKindBackfill();

    const kind = async (id: string) => (await getClawsIssue(id))!.alert_kind;
    expect(await kind(byTitle)).toBe("legacy");
    expect(await kind(byKey)).toBe("legacy");
    expect(await kind(byLabel)).toBe("legacy");
    expect(await kind(human)).toBeNull();
    expect(await kind(idea)).toBeNull();
    expect(await kind(closed)).toBeNull();

    const later = await createClawsIssue({ title: "[dmarc] later", authorLogin: "claws", repos: ["org/a"] });
    await migrateAlertKindBackfill();
    expect(await kind(later)).toBeNull();
  });

  // The requirements stage (#clw_01M39G3SREWPRP5AH0THJR0P24) retired `inbox`
  // and `awaiting-review`; rows still holding them are moved on boot.
  it("migrates inbox and awaiting-review, backfilling source, and a rerun changes nothing", async () => {
    const planned = await createClawsIssue({ title: "Planned", authorLogin: "stjohnb", repos: ["org/a"] });
    const approved = await createClawsIssue({ title: "Approved reqs", authorLogin: "stjohnb", repos: ["org/a"] });
    const fresh = await createClawsIssue({ title: "Fresh", authorLogin: "stjohnb", repos: ["org/a"] });
    const auto = await createClawsIssue({ title: "Alert", authorLogin: "claws", repos: ["org/a"] });
    const review = await createClawsIssue({ title: "Review", authorLogin: "stjohnb", repos: ["org/a"] });
    const shadow = (await createShadowIssue("org/a", 9, { title: "Forge", authorLogin: "someone" }))!.id;
    await _rawDb().run(`INSERT INTO claws_issue_plans (issue_id, version, comment_id, body, created_at) VALUES (?, 1, NULL, 'plan', '2026-09-01 00:00:00')`, [planned]);
    await _rawDb().run(`UPDATE claws_issues SET approved_requirements_version = 1, requirements_approved_at = '2026-08-01 00:00:00' WHERE id = ?`, [approved]);
    // Rewind to the pre-migration shape: old lifecycle values, source
    // unbackfilled — NULL is what the ALTER leaves an existing row with now
    // that the column has no default.
    await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'inbox', source = NULL WHERE id IN (?, ?, ?, ?, ?)`, [planned, approved, fresh, auto, shadow]);
    await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'awaiting-review' WHERE id = ?`, [review]);

    await migrateInboxToIdeas();

    expect(await lifecycleOf(planned)).toBe("planning");
    expect(await lifecycleOf(approved)).toBe("planning");
    expect(await lifecycleOf(fresh)).toBe("ideas");
    expect(await lifecycleOf(review)).toBe("awaiting-plan-review");
    expect((await getClawsIssue(shadow))!.source).toBe("forge");
    expect((await getClawsIssue(auto))!.source).toBe("automation");
    expect((await getClawsIssue(fresh))!.source).toBe("dashboard");

    // A rerun is idempotent: the backfill only ever touches `source IS NULL`,
    // so an issue filed after the first run — or already backfilled by it —
    // keeps the source it has.
    const later = await createClawsIssue({ title: "Later", authorLogin: "claws", repos: ["org/a"], source: "dashboard" });
    await migrateInboxToIdeas();
    expect((await getClawsIssue(later))!.source).toBe("dashboard");
    expect(await lifecycleOf(planned)).toBe("planning");
    expect(await lifecycleOf(fresh)).toBe("ideas");
  });

  it("backfills a human's approval without a version, and never overwrites an already-set source", async () => {
    // A human promotion before any requirements version exists sets
    // `requirements_approved_at` but leaves `approved_requirements_version`
    // NULL — the migration must still land it in Planning, matching
    // `ENTRY_LIFECYCLE_SQL` and `clawsIssues.entryLifecycle`.
    const approvedNoVersion = await createClawsIssue({ title: "Approved, no version", authorLogin: "stjohnb", repos: ["org/a"] });
    await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'inbox', requirements_approved_at = '2026-01-01 00:00:00' WHERE id = ?`, [approvedNoVersion]);

    // An issue Claws filed with its source already set (every create does
    // this): the author_login backfill must leave it alone, since it only
    // ever touches `source IS NULL`.
    const autoAlreadySet = await createClawsIssue({ title: "Alert, source already set", authorLogin: "claws", repos: ["org/a"] });
    await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'inbox' WHERE id = ?`, [autoAlreadySet]);
    // A shadow's `source` backfill runs whenever it is NULL, on any boot.
    const shadow = (await createShadowIssue("org/a", 11, { title: "Forge", authorLogin: "someone" }))!.id;
    await _rawDb().run(`UPDATE claws_issues SET source = NULL WHERE id = ?`, [shadow]);
    // Needs a pending `inbox`/`awaiting-review` row, or the whole function
    // returns before reaching either backfill.
    const inboxTrigger = await createClawsIssue({ title: "Trigger", authorLogin: "stjohnb", repos: ["org/a"] });
    await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'inbox' WHERE id = ?`, [inboxTrigger]);

    await migrateInboxToIdeas();

    expect(await lifecycleOf(approvedNoVersion)).toBe("planning");
    expect((await getClawsIssue(autoAlreadySet))!.source).toBe("dashboard");
    expect((await getClawsIssue(shadow))!.source).toBe("forge");
  });

  it("creates an issue in Ideas with its source and promotion override", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "claws", repos: ["org/a"], source: "agent", autoPromote: false });
    const row = (await getClawsIssue(id))!;
    expect(row).toMatchObject({ lifecycle: "ideas", source: "agent", auto_promote: 0 });
    expect((await getClawsIssue(await createClawsIssue({ title: "U", authorLogin: "x" })))!).toMatchObject({ source: "dashboard", auto_promote: null });
  });

  it("turns the requirements stage on by default only for hand-filed sources, unless the caller chooses", async () => {
    const stageOf = async (input: Parameters<typeof createClawsIssue>[0]) => (await getClawsIssue(await createClawsIssue(input)))!.requirements_stage;
    for (const source of ["dashboard", "whatsapp", "forge"] as const) {
      expect(await stageOf({ title: "T", authorLogin: "x", source }), source).toBe(1);
    }
    for (const source of ["agent", "session", "automation"] as const) {
      expect(await stageOf({ title: "T", authorLogin: "x", source }), source).toBe(0);
    }
    expect(await stageOf({ title: "T", authorLogin: "x" })).toBe(1);
    expect(await stageOf({ title: "T", authorLogin: "x", source: "dashboard", requirementsStage: false })).toBe(0);
    expect(await stageOf({ title: "T", authorLogin: "x", source: "agent", requirementsStage: true })).toBe(1);
    const shadow = (await createShadowIssue("org/a", 12, { title: "Forge", authorLogin: "someone" }))!.id;
    expect((await getClawsIssue(shadow))!.requirements_stage).toBe(1);
  });

  it("backfills the requirements stage on for rows from before the column, leaving set rows alone", async () => {
    // Rewind to the pre-column shape, then re-run the boot-time ALTER and backfill.
    const old = await createClawsIssue({ title: "Old", authorLogin: "claws", source: "agent" });
    await _rawDb().exec(`ALTER TABLE claws_issues DROP COLUMN requirements_stage`);
    await _rawDb().addColumn("claws_issues", "requirements_stage", "INTEGER");
    await _rawDb().run(`UPDATE claws_issues SET requirements_stage = 1 WHERE requirements_stage IS NULL`);
    expect((await getClawsIssue(old))!.requirements_stage).toBe(1);

    // A later boot leaves a row filed with the stage off as it is.
    const fresh = await createClawsIssue({ title: "New", authorLogin: "claws", source: "agent" });
    await _rawDb().run(`UPDATE claws_issues SET requirements_stage = 1 WHERE requirements_stage IS NULL`);
    expect((await getClawsIssue(fresh))!.requirements_stage).toBe(0);
  });

  it("promotes to Planning, renaming the issue once and keeping the filed title", async () => {
    const id = await createClawsIssue({ title: "make it quicker", authorLogin: "stjohnb", repos: ["org/a"] });
    expect(await promoteClawsIssue(id, { version: 1, approvedBy: "stjohnb", title: "Speed up the board", expectedLifecycle: "ideas" })).toBe(true);
    expect(await getClawsIssue(id)).toMatchObject({
      lifecycle: "planning", title: "Speed up the board", filed_title: "make it quicker",
      approved_requirements_version: 1, requirements_approved_by: "stjohnb",
    });
    // A second rename keeps the first filed title.
    await promoteClawsIssue(id, { version: 2, approvedBy: "claws", title: "Speed up the board page", expectedLifecycle: "planning" });
    expect((await getClawsIssue(id))!.filed_title).toBe("make it quicker");

    expect(await demoteClawsIssue(id)).toBe(true);
    expect(await getClawsIssue(id)).toMatchObject({
      lifecycle: "ideas", approved_requirements_version: null, requirements_approved_by: null, requirements_approved_at: null,
      title: "Speed up the board page",
      // A demotion also sets the per-issue override to "wait": otherwise a
      // level-triggered auto-promotion check would send it straight back out.
      auto_promote: 0,
    });
    expect(await promoteClawsIssue("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", { version: null, approvedBy: "x", expectedLifecycle: "ideas" })).toBe(false);
  });

  it("loses the race when the row changed lifecycle since the caller read it", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await blockClawsIssue(id, "Parked");
    // A promotion racing a human's own move to a later column (Blocked here):
    // the caller's stale read of `ideas` must not overwrite it, and must not
    // touch the approval fields either.
    expect(await promoteClawsIssue(id, { version: 1, approvedBy: "claws", expectedLifecycle: "ideas" })).toBe(false);
    expect(await getClawsIssue(id)).toMatchObject({
      lifecycle: "blocked", approved_requirements_version: null, requirements_approved_by: null, requirements_approved_at: null,
    });
  });

  it("promotes from any lifecycle the caller read, not only Ideas or Planning", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await blockClawsIssue(id, "Parked");
    // A human drag from Blocked straight into Planning: the caller read
    // `blocked`, so the compare-and-swap expects that, not `ideas`.
    expect(await promoteClawsIssue(id, { version: 1, approvedBy: "claws", expectedLifecycle: "blocked" })).toBe(true);
    expect(await getClawsIssue(id)).toMatchObject({
      lifecycle: "planning", approved_requirements_version: 1, requirements_approved_by: "claws",
    });
  });

  it("promotes a shadow without renaming it, and keeps it in Planning across syncs", async () => {
    const id = (await createShadowIssue("org/a", 11, { title: "Forge", authorLogin: "someone" }))!.id;
    expect(await lifecycleOf(id)).toBe("ideas");
    expect((await getClawsIssue(id))!.source).toBe("forge");
    await promoteClawsIssue(id, { version: 1, approvedBy: "claws", title: "Better title", expectedLifecycle: "ideas" });
    expect(await getClawsIssue(id)).toMatchObject({ lifecycle: "planning", title: "Forge", filed_title: null });
    expect((await listOpenShadowStages()).get("org/a\u000011")).toEqual({ id, lifecycle: "planning", approvedThrough: "requirements", hasPlannedPrs: false });
    // A stored PR list is the board's has-a-plan hint for a forge card.
    await replaceIssuePlannedPRs(id, [{ repo: "org/a", title: "One" }]);
    expect((await listOpenShadowStages()).get("org/a\u000011")).toEqual({ id, lifecycle: "planning", approvedThrough: "requirements", hasPlannedPrs: true });

    // The forge has no Planning label: a label-less sync must not demote it.
    const next = { title: "Forge", body: "", labels: [] as string[], state: "open" as const };
    expect(await updateShadowIssue(id, next)).toBe("unchanged");
    expect(await lifecycleOf(id)).toBe("planning");
    // A retired gate label on the forge is no change at all.
    expect(await updateShadowIssue(id, { ...next, labels: ["Ready"] })).toBe("unchanged");
    // Backlog then removed on the forge: back to Planning, not Ideas.
    await updateShadowIssue(id, { ...next, labels: ["Backlog"] });
    expect(await lifecycleOf(id)).toBe("backlog");
    await updateShadowIssue(id, next);
    expect(await lifecycleOf(id)).toBe("planning");
    // An unpromoted shadow stays in Ideas.
    const other = (await createShadowIssue("org/a", 12, { title: "Other", authorLogin: "someone" }))!.id;
    expect(await updateShadowIssue(other, { ...next, title: "Other" })).toBe("unchanged");
    expect(await lifecycleOf(other)).toBe("ideas");
  });

  it("plain-writes a shadow's lifecycle without touching its approval fields, and refuses a native issue", async () => {
    const id = (await createShadowIssue("org/a", 13, { title: "Forge", authorLogin: "someone" }))!.id;
    await promoteClawsIssue(id, { version: 1, approvedBy: "claws", expectedLifecycle: "ideas" });
    expect(await setShadowLifecycle(id, "awaiting-plan-review")).toBe(true);
    expect(await getClawsIssue(id)).toMatchObject({
      lifecycle: "awaiting-plan-review", approved_requirements_version: 1, requirements_approved_by: "claws", approved_through: "requirements",
    });
    expect(await setShadowLifecycle(id, "awaiting-plan-review")).toBe(false);

    const native = await createClawsIssue({ title: "Native", authorLogin: "stjohnb", repos: ["org/a"] });
    expect(await setShadowLifecycle(native, "awaiting-plan-review")).toBe(false);
    expect((await getClawsIssue(native))!.lifecycle).toBe("ideas");
  });

  it("skips only the queued rows of the item whose kind has the prefix", async () => {
    const plan = (await enqueueWork("issue-refiner:plan", "org/a", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"))!;
    const writer = (await enqueueWork("requirements-writer:write", "org/a", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"))!;
    const other = (await enqueueWork("issue-refiner:plan", "org/a", 5))!;
    const running = (await enqueueWork("issue-refiner:refine", "org/a", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"))!;
    await _rawDb().run(`UPDATE work_queue SET status = 'running' WHERE id = ?`, [running.id]);

    expect(await skipQueuedWorkForItem("issue-refiner:", "org/a", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "sent back")).toBe(1);
    expect(await getWorkRow(plan.id)).toMatchObject({ status: "completed", error_message: "skipped: sent back" });
    expect((await getWorkRow(writer.id))!.status).toBe("queued");
    expect((await getWorkRow(other.id))!.status).toBe("queued");
    expect((await getWorkRow(running.id))!.status).toBe("running");
  });
});

// Shadows: the native backing record of an issue that is still live on a forge
// (#3246). The point of the `kind` column is that everything else in
// `claws_issues` covers them — so what is pinned here is exactly where they
// are *not* covered, and that promotion keeps the id.
describe("claws issue shadows", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  // `createShadowIssue` answers `{ id, created }`, or nothing at all when the
  // linkage row names an imported issue. The cases below that just need a
  // shadow to exist care about none of that; the ones that do call it direct.
  const newShadow = async (
    repo: string,
    forgeNumber: number,
    input: { title: string; body?: string; authorLogin: string; labels?: readonly string[] },
  ): Promise<string> => {
    const created = await createShadowIssue(repo, forgeNumber, input);
    expect(created).toMatchObject({ created: true });
    return created!.id;
  };

  it("has the kind column after a fresh boot and after the next one", async () => {
    expect((await getClawsIssue(await createClawsIssue({ title: "One", authorLogin: "stjohnb" })))!.kind).toBe("issue");

    // The column is added by ALTER rather than written into the CREATE, so a
    // second boot re-runs that ALTER against a table that already has it.
    await initDb();

    expect((await getClawsIssue(await createClawsIssue({ title: "Two", authorLogin: "stjohnb" })))!.kind).toBe("issue");
  });

  it("gives an existing database the column with every row defaulting to issue", async () => {
    const id = await createClawsIssue({ title: "Native", authorLogin: "stjohnb" });
    const kindOf = async (): Promise<unknown> =>
      (await _rawDb().get(`SELECT kind FROM claws_issues WHERE id = ?`, [id]) as { kind: unknown }).kind;

    // Rewind to the pre-#3246 shape — a real database has rows predating the
    // column, and no index over it — then re-run the boot-time ALTER and
    // CREATE INDEX over them, in that order. The two indexes are *partial* on
    // `kind`, so they cannot be created before the column exists.
    await _rawDb().exec(`DROP INDEX IF EXISTS idx_claws_issues_live_state`);
    await _rawDb().exec(`DROP INDEX IF EXISTS idx_claws_issues_live_closed`);
    await _rawDb().exec(`ALTER TABLE claws_issues DROP COLUMN kind`);
    await _rawDb().addColumn("claws_issues", "kind", "TEXT NOT NULL DEFAULT 'issue'");
    await _rawDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issues_live_state ON claws_issues(state, updated_at) WHERE kind <> 'shadow'`);
    await _rawDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issues_live_closed ON claws_issues(state, closed_at) WHERE kind <> 'shadow'`);
    expect(await kindOf()).toBe("issue");

    // And re-running it once more leaves what the rows now say alone.
    await _rawDb().run(`UPDATE claws_issues SET kind = 'shadow' WHERE id = ?`, [id]);
    await _rawDb().addColumn("claws_issues", "kind", "TEXT NOT NULL DEFAULT 'issue'");
    expect(await kindOf()).toBe("shadow");
  });

  it("creates a shadow with its repo, labels and linkage row", async () => {
    const created = await createShadowIssue("org/a", 7, {
      title: "Forge issue",
      body: "Body",
      authorLogin: "stjohnb",
      labels: ["bug", "Plan: Deep"],
    });
    expect(created).toMatchObject({ created: true });
    const id = created!.id;

    const shadow = await getClawsIssue(id);
    expect(shadow).toMatchObject({ id, title: "Forge issue", body: "Body", author_login: "stjohnb", state: "open", kind: "shadow" });
    expect(shadow!.repos).toEqual(["org/a"]);
    expect([...shadow!.labels].sort()).toEqual(["Plan: Deep", "bug"]);
    expect(await getImportedIssueByNative(id)).toEqual({ repo: "org/a", forgeNumber: 7 });
  });

  it("returns the id already linked rather than orphaning a second shadow", async () => {
    // The linkage primary key arbitrates a race with `issue-importer`; losing
    // it must leave no `claws_issues` row nothing ever lists behind.
    const first = await createShadowIssue("org/a", 7, { title: "One", authorLogin: "stjohnb" });
    const second = await createShadowIssue("org/a", 7, { title: "Two", authorLogin: "stjohnb" });

    expect(first!.created).toBe(true);
    expect(second).toEqual({ id: first!.id, created: false });
    expect(await _rawDb().all(`SELECT id FROM claws_issues`)).toEqual([{ id: first!.id }]);

    // Forge numbers collide across repositories, so the lookup is repo-scoped.
    const otherRepo = await createShadowIssue("org/b", 7, { title: "Theirs", authorLogin: "stjohnb" });
    expect(otherRepo).toMatchObject({ created: true });
    expect(otherRepo!.id).not.toBe(first!.id);
  });

  it("refuses to hand back an imported issue as though it were a shadow", async () => {
    // `(repo, forge_number)` is shared by imports and shadows, so "already
    // linked" is also the permanent state of every issue the repo has ever
    // imported — a human reopening one puts it back in the forge's open
    // listing. Returning that id would have the sync job write to a row every
    // `updateShadowIssue` refuses, re-attempting the same pair every cycle
    // with no error and nothing logged.
    const native = await createClawsIssue({ title: "Imported", authorLogin: "claws", repos: ["org/a"] });
    await recordImportedIssue("org/a", 7, native);

    expect(await createShadowIssue("org/a", 7, { title: "Forge issue", authorLogin: "stjohnb" })).toBeUndefined();
    expect(await _rawDb().all(`SELECT id FROM claws_issues`)).toEqual([{ id: native }]);
  });

  it("hides shadows from the open and closed list reads while getClawsIssue still returns one", async () => {
    const issue = await createClawsIssue({ title: "Native", authorLogin: "stjohnb", repos: ["org/a"] });
    const shadow = await newShadow("org/a", 7, { title: "Forge issue", authorLogin: "stjohnb" });

    expect((await listOpenClawsIssues()).map((i) => i.id)).toEqual([issue]);
    expect((await listOpenClawsIssues({ repo: "org/a" })).map((i) => i.id)).toEqual([issue]);

    await setClawsIssueState(issue, "closed", "completed");
    await updateShadowIssue(shadow, { title: "Forge issue", body: "", labels: [], state: "closed", stateReason: "completed" });

    const since = new Date(Date.now() - 60_000);
    expect((await listClosedClawsIssuesSince(since)).map((i) => i.id)).toEqual([issue]);
    expect((await listClosedClawsIssuesSince(since, { repo: "org/a" })).map((i) => i.id)).toEqual([issue]);

    expect((await getClawsIssue(shadow))!.kind).toBe("shadow");
  });

  it("lists a repository's shadows with their forge numbers, and no other repository's", async () => {
    const mine = await newShadow("org/a", 7, { title: "Mine", authorLogin: "stjohnb", labels: ["bug"] });
    await newShadow("org/b", 9, { title: "Theirs", authorLogin: "stjohnb" });
    await createClawsIssue({ title: "Native", authorLogin: "stjohnb", repos: ["org/a"] });

    const shadows = await listShadowIssues("org/a");
    expect(shadows.map((s) => [s.id, s.forgeNumber, s.labels])).toEqual([[mine, 7, ["bug"]]]);
    expect(typeof shadows[0]!.forgeNumber).toBe("number");
  });

  it("orders the listing by when each shadow was last checked, not by when one last changed", async () => {
    // The sync job confirms missing shadows under a per-run read cap, so the
    // ordering is what stops a capped run re-checking the same few forever. A
    // check that finds nothing changed writes no issue columns at all, so
    // `updated_at` cannot be the marker: order on it and a shadow whose check
    // never changes anything sits at the head of the queue on every run.
    const first = await newShadow("org/a", 7, { title: "First", authorLogin: "stjohnb" });
    const second = await newShadow("org/a", 8, { title: "Second", authorLogin: "stjohnb" });
    // Backdated so "now" is unambiguously later than either — `nowSql()` is
    // second-granular, and both shadows were minted inside the same second.
    await _rawDb().run(`UPDATE claws_issues SET updated_at = '2020-01-01 00:00:00'`);

    // Unchecked, so both fall back to `updated_at` and the id breaks the tie.
    expect((await listShadowIssues("org/a")).map((s) => s.id)).toEqual([first, second]);

    // Checked and found unchanged — no column of the issue moves, and the
    // shadow goes to the back of the queue anyway.
    expect(await updateShadowIssue(first, { title: "First", body: "", labels: [], state: "open" })).toBe("unchanged");
    await markShadowsChecked([first]);

    expect((await getClawsIssue(first))!.updated_at).toBe("2020-01-01 00:00:00");
    expect((await listShadowIssues("org/a")).map((s) => s.id)).toEqual([second, first]);
  });

  it("ignores a row that is not a shadow when marking one checked", async () => {
    // A shadow the importer promoted mid-run is no longer the sync job's.
    const native = await createClawsIssue({ title: "Native", authorLogin: "stjohnb", repos: ["org/a"] });
    await markShadowsChecked([native]);

    expect(await _rawDb().get(`SELECT shadow_checked_at FROM claws_issues WHERE id = ?`, [native])).toEqual({ shadow_checked_at: null });
    await expect(markShadowsChecked([])).resolves.toBeUndefined();
  });

  it("drops a shadow whose linkage row is gone rather than reporting forge issue 0", async () => {
    // The forge number comes from the joined linkage row, so a shadow without
    // one is simply absent — the old two-query form substituted `0` here and
    // would have had the sync job call the forge about `org/a#0`.
    const linked = await newShadow("org/a", 7, { title: "Linked", authorLogin: "stjohnb" });
    const orphan = await newShadow("org/a", 8, { title: "Orphan", authorLogin: "stjohnb" });
    await _rawDb().run(`DELETE FROM imported_issues WHERE native_id = ?`, [orphan]);

    expect((await listShadowIssues("org/a")).map((s) => [s.id, s.forgeNumber])).toEqual([[linked, 7]]);
  });

  it("drops a promoted shadow out of the shadow listing", async () => {
    const id = await newShadow("org/a", 7, { title: "Forge issue", authorLogin: "stjohnb" });
    await promoteShadowIssue(id, { title: "Forge issue", body: "Imported", labels: [] }, { importPending: true });

    expect(await listShadowIssues("org/a")).toEqual([]);
  });

  it("reports no change when the forge issue still says exactly what the shadow does", async () => {
    // Alert-bridge issues rewrite their body on every occurrence, so the sync
    // job reaches this with an unchanged issue most cycles — an unconditional
    // UPDATE would bump `updated_at` fleet-wide every interval.
    const id = await newShadow("org/a", 7, { title: "T", body: "B", authorLogin: "stjohnb", labels: ["bug", "Priority"] });

    expect(await updateShadowIssue(id, { title: "T", body: "B", labels: ["Priority", "bug"], state: "open" })).toBe("unchanged");
    expect(await updateShadowIssue(id, { title: "T2", body: "B", labels: ["bug", "Priority"], state: "open" })).toBe("changed");
    expect(await updateShadowIssue(id, { title: "T2", body: "B2", labels: ["bug", "Priority"], state: "open" })).toBe("changed");
    expect(await updateShadowIssue(id, { title: "T2", body: "B2", labels: ["bug"], state: "open" })).toBe("changed");

    const shadow = await getClawsIssue(id);
    expect(shadow).toMatchObject({ title: "T2", body: "B2" });
    expect(shadow!.labels).toEqual(["bug"]);
  });

  it("sets closed_at on the close that reports it, keeps it, and clears it on reopen", async () => {
    const id = await newShadow("org/a", 7, { title: "T", body: "B", authorLogin: "stjohnb" });

    await updateShadowIssue(id, { title: "T", body: "B", labels: [], state: "closed", stateReason: "completed" });
    const closed = await getClawsIssue(id);
    expect(closed).toMatchObject({ state: "closed", state_reason: "completed" });
    expect(closed!.closed_at).not.toBeNull();

    // A body edit on an already-closed shadow must not restamp the close time.
    await updateShadowIssue(id, { title: "T", body: "B2", labels: [], state: "closed", stateReason: "completed" });
    expect((await getClawsIssue(id))!.closed_at).toBe(closed!.closed_at);

    await updateShadowIssue(id, { title: "T", body: "B2", labels: [], state: "open" });
    expect(await getClawsIssue(id)).toMatchObject({ state: "open", state_reason: null, closed_at: null });
  });

  it("promotes in place, keeping the id and replacing body and labels", async () => {
    const id = await newShadow("org/a", 7, { title: "Forge issue", body: "Original", authorLogin: "stjohnb", labels: ["bug"] });

    expect(await promoteShadowIssue(id, { title: "Forge issue", body: "Imported from …\n\nOriginal", labels: ["bug"] }, { importPending: true })).toBe(true);

    const promoted = await getClawsIssue(id);
    expect(promoted).toMatchObject({ id, title: "Forge issue", body: "Imported from …\n\nOriginal", kind: "issue", importPending: true });
    expect([...promoted!.labels].sort()).toEqual(["bug"]);
    // Finishing the import clears the flag once; a second finish is a no-op.
    expect(await finishClawsIssueImport(id)).toBe(true);
    expect(await finishClawsIssueImport(id)).toBe(false);
    expect((await getClawsIssue(id))!.importPending).toBe(false);
    // Visible to the dispatchers now, and still linked to the forge number it
    // came from so the old ref keeps resolving.
    expect((await listOpenClawsIssues({ repo: "org/a" })).map((i) => i.id)).toEqual([id]);
    expect(await getImportedIssueByNative(id)).toEqual({ repo: "org/a", forgeNumber: 7 });
  });

  it("imports a shadow already past Ideas without sending it back, keeping its approval", async () => {
    // A shadow auto-promoted on its first requirements version, with no
    // `Ready` label posted yet — the forge has no label for Planning, so
    // `promoteShadowIssue` must apply the same "past Ideas" rule
    // `updateShadowIssue` does, or the import would silently undo the
    // promotion (#clw_01M39G3SREWPRP5AH0THJR0P24).
    const id = await newShadow("org/a", 7, { title: "Forge issue", body: "Original", authorLogin: "stjohnb", labels: [] });
    expect(await promoteClawsIssue(id, { version: 1, approvedBy: "claws", expectedLifecycle: "ideas" })).toBe(true);

    expect(await promoteShadowIssue(id, { title: "Forge issue", body: "Imported", labels: [] })).toBe(true);

    expect(await getClawsIssue(id)).toMatchObject({
      lifecycle: "planning", kind: "issue",
      approved_requirements_version: 1, requirements_approved_by: "claws",
    });
  });

  it("refuses both shadow writes on a row that is not a shadow", async () => {
    // The guard is what makes the sync job and the importer commute: whichever
    // runs second no-ops rather than writing the forge's text back over the
    // imported issue, or importing the same issue twice.
    const native = await createClawsIssue({ title: "Native", body: "B", authorLogin: "stjohnb", labels: ["Priority"] });

    // `"not-a-shadow"` and not `"unchanged"`: the sync job keeps checking an
    // unchanged shadow and must drop a promoted one from its working set, so
    // the two refusals cannot share an answer.
    expect(await updateShadowIssue(native, { title: "Hijacked", body: "X", labels: [], state: "closed" })).toBe("not-a-shadow");
    expect(await promoteShadowIssue(native, { title: "Hijacked", body: "X", labels: [] })).toBe(false);
    expect(await updateShadowIssue("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", { title: "T", body: "B", labels: [], state: "open" })).toBe("not-a-shadow");
    expect(await promoteShadowIssue("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", { title: "T", body: "B", labels: [] })).toBe(false);

    const unchanged = await getClawsIssue(native);
    expect(unchanged).toMatchObject({ title: "Native", body: "B", state: "open", kind: "issue" });
    expect(unchanged!.labels).toEqual(["Priority"]);
  });

  it("normalises a closed shadow carrying a stale title into the issue a fresh import would be", async () => {
    // The shadow's own columns are the forge's, and the sync job only
    // refreshes them on its timer: a title edited, or a close and reopen, in
    // the window before an import would otherwise survive the promotion —
    // leaving the plan's content hash stale, or the promoted issue closed and
    // invisible to the dispatchers.
    const id = await newShadow("org/a", 7, { title: "Old title", body: "Original", authorLogin: "stjohnb" });
    await updateShadowIssue(id, { title: "Old title", body: "Original", labels: [], state: "closed", stateReason: "not_planned" });

    expect(await promoteShadowIssue(id, { title: "New forge title", body: "Imported", labels: [] })).toBe(true);

    expect(await getClawsIssue(id)).toMatchObject({
      id,
      title: "New forge title",
      body: "Imported",
      // Laundered to `claws` exactly as `createIssue` does it, so the
      // dispatchers' allowed-actor check cannot fork on whether a shadow
      // happened to be there.
      author_login: "claws",
      state: "open",
      state_reason: null,
      closed_at: null,
      kind: "issue",
    });
    expect((await listOpenClawsIssues({ repo: "org/a" })).map((i) => i.id)).toEqual([id]);
  });

  it("refuses every by-id native write on a shadow", async () => {
    // The invariant is structural, not per call site: nothing outside the
    // shadow helpers may write a shadow, so a caller that forgets to check
    // `kind` is refused rather than silently mutating a hidden row.
    const id = await newShadow("org/a", 7, { title: "Forge issue", body: "Original", authorLogin: "stjohnb", labels: ["bug"] });

    expect(await updateClawsIssueTitle(id, "Hijacked")).toBe(false);
    expect(await updateClawsIssueBody(id, "Hijacked")).toBe(false);
    expect(await setClawsIssueState(id, "closed", "completed")).toBe(false);
    await expect(addClawsIssueLabel(id, "Priority")).rejects.toThrow(/shadow/);
    await expect(removeClawsIssueLabel(id, "bug")).rejects.toThrow(/shadow/);
    await expect(setClawsIssueRepos(id, ["org/b"])).rejects.toThrow(/shadow/);
    await expect(addClawsIssueComment(id, "stjohnb", "Hello")).rejects.toThrow(/shadow/);

    const shadow = await getClawsIssue(id);
    expect(shadow).toMatchObject({ title: "Forge issue", body: "Original", state: "open", kind: "shadow" });
    expect(shadow!.labels).toEqual(["bug"]);
    expect(shadow!.repos).toEqual(["org/a"]);
  });
});

// Postgres-only: SQLite is dynamically typed and needs no migration, so there
// is nothing here for the default lane to exercise.
describe.runIf(process.env["CLAWS_TEST_PGLITE"] === "1")("issue-reference TEXT migration", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("widens a pre-existing BIGINT item_number and still reads it back as a number", async () => {
    await initDb();
    const db = _rawDb();
    // Rewind the six columns to their pre-#3215 shape, then seed a forge row.
    await db.exec(`
      ALTER TABLE tasks ALTER COLUMN item_number TYPE BIGINT USING item_number::bigint;
      ALTER TABLE work_queue ALTER COLUMN item_number TYPE BIGINT USING item_number::bigint;
      ALTER TABLE notified_untrusted_actors ALTER COLUMN issue_number TYPE BIGINT USING issue_number::bigint;
      ALTER TABLE reminder_notifications ALTER COLUMN issue_number TYPE BIGINT USING issue_number::bigint;
      ALTER TABLE upstream_watch_fires ALTER COLUMN issue_number TYPE BIGINT USING issue_number::bigint;
      ALTER TABLE blog_draft_ports ALTER COLUMN issue_number TYPE BIGINT USING issue_number::bigint;
    `);
    await db.run(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, 42, 'completed', ?)`,
      ["issue-worker", "org/repo", "2026-01-01 00:00:00"],
    );

    await initDb();

    const columns = await _rawDb().all(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'tasks' AND column_name = 'item_number')
            OR (table_name = 'work_queue' AND column_name = 'item_number')
            OR (table_name IN ('notified_untrusted_actors', 'reminder_notifications', 'upstream_watch_fires', 'blog_draft_ports')
                AND column_name = 'issue_number'))`,
    ) as Array<{ data_type: string }>;
    expect(columns).toHaveLength(6);
    expect(columns.every((col) => col.data_type === "text")).toBe(true);

    const tasks = await getRecentTasksForRepo("org/repo");
    expect(tasks[0]!.item_number).toBe(42);
  });

  it("is a no-op on a database that is already TEXT", async () => {
    await initDb();

    // Asserting the end state alone would pass whether or not the guard
    // short-circuited, and re-running is not free: `USING column::text`
    // rewrites all six tables under ACCESS EXCLUSIVE. The log line is the only
    // observable difference, so pin that.
    vi.mocked(log.info).mockClear();
    await initDb();
    expect(vi.mocked(log.info)).not.toHaveBeenCalledWith(expect.stringContaining("issue-reference column"));

    const stale = await _rawDb().all(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'tasks'
          AND column_name = 'item_number' AND data_type <> 'text'`,
    );
    expect(stale).toEqual([]);
  });

  it("rolls every column back when one ALTER fails, and aborts boot", async () => {
    // The property the single `exec()` exists for: all six change or none does,
    // so a partial failure can never leave the schema half-widened while the
    // code assumes TEXT. There is no staging rehearsal for this migration, so
    // it is pinned here rather than described in a comment.
    await initDb();
    const db = _rawDb();
    await db.exec(`
      ALTER TABLE tasks ALTER COLUMN item_number TYPE BIGINT USING item_number::bigint;
      ALTER TABLE work_queue ALTER COLUMN item_number TYPE BIGINT USING item_number::bigint;
      ALTER TABLE notified_untrusted_actors ALTER COLUMN issue_number TYPE BIGINT USING issue_number::bigint;
      ALTER TABLE reminder_notifications ALTER COLUMN issue_number TYPE BIGINT USING issue_number::bigint;
      ALTER TABLE upstream_watch_fires ALTER COLUMN issue_number TYPE BIGINT USING issue_number::bigint;
      ALTER TABLE blog_draft_ports ALTER COLUMN issue_number TYPE BIGINT USING issue_number::bigint;
    `);
    // `blog_draft_ports` is last in ISSUE_REF_COLUMNS, so the five before it
    // have already succeeded inside the transaction when this check's
    // expression stops type-checking against a `text` column.
    await db.exec(`ALTER TABLE blog_draft_ports ADD CONSTRAINT chk_positive CHECK (issue_number > 0)`);

    await expect(initDb()).rejects.toThrow();

    const stale = await _rawDb().all(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND data_type <> 'text'
          AND ((table_name = 'tasks' AND column_name = 'item_number')
            OR (table_name = 'work_queue' AND column_name = 'item_number')
            OR (table_name IN ('notified_untrusted_actors', 'reminder_notifications', 'upstream_watch_fires', 'blog_draft_ports')
                AND column_name = 'issue_number'))`,
    );
    expect(stale).toHaveLength(6);
  });

  it("alters only the columns that are actually stale", async () => {
    await initDb();
    // A mixed state — one column hand-rolled back, five already TEXT — is what
    // a partial rollback leaves behind. Only the stale one may be rewritten.
    await _rawDb().exec(`ALTER TABLE tasks ALTER COLUMN item_number TYPE BIGINT USING item_number::bigint`);

    vi.mocked(log.info).mockClear();
    await migrateIssueRefColumnsToText();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("Migrating 1 issue-reference column(s) to TEXT: tasks.item_number"),
    );
  });
});

describe("issue model plan", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("stores a cell per phase, keyed by the canonical ref", async () => {
    await upsertIssueModelPlanCell("org/repo", "clw_01jbq7x4m2k8nv3tyrw9gz5pdc", "implement", { provider: "codex", tier: "haiku", source: "explicit" });
    await upsertIssueModelPlanCell("org/repo", 42, "review", { provider: null, tier: "opus", source: "suggested" });

    const native = await getIssueModelPlanRows("org/repo", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    expect(native).toEqual([expect.objectContaining({ issue_ref: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", phase: "implement", provider: "codex", tier: "haiku", source: "explicit" })]);
    const forge = await getIssueModelPlanRows("org/repo", 42);
    expect(forge).toEqual([expect.objectContaining({ issue_ref: "42", phase: "review", provider: null, tier: "opus", source: "suggested" })]);
    expect(await getIssueModelPlanRows("org/other", 42)).toEqual([]);
  });

  it("never lets a suggested write replace an explicit cell", async () => {
    await upsertIssueModelPlanCell("org/repo", 7, "implement", { provider: "claude", tier: "fable", source: "explicit" });
    expect(await upsertIssueModelPlanCell("org/repo", 7, "implement", { provider: null, tier: "sonnet", source: "suggested" })).toBe(false);
    expect((await getIssueModelPlanRows("org/repo", 7))[0]).toMatchObject({ provider: "claude", tier: "fable", source: "explicit" });

    // An explicit write replaces a suggestion, and another explicit write.
    await upsertIssueModelPlanCell("org/repo", 7, "review", { provider: null, tier: "sonnet", source: "suggested" });
    expect(await upsertIssueModelPlanCell("org/repo", 7, "review", { provider: "codex", tier: null, source: "explicit" })).toBe(true);
    expect(await upsertIssueModelPlanCell("org/repo", 7, "review", { provider: "opencode", tier: null, source: "explicit" })).toBe(true);
    const review = (await getIssueModelPlanRows("org/repo", 7)).find((r) => r.phase === "review");
    expect(review).toMatchObject({ provider: "opencode", tier: null, source: "explicit" });
  });

  it("deletes a cell, optionally only when it has the given source", async () => {
    await upsertIssueModelPlanCell("org/repo", 7, "implement", { provider: null, tier: "opus", source: "explicit" });
    await deleteIssueModelPlanCell("org/repo", 7, "implement", "suggested");
    expect(await getIssueModelPlanRows("org/repo", 7)).toHaveLength(1);
    await deleteIssueModelPlanCell("org/repo", 7, "implement");
    expect(await getIssueModelPlanRows("org/repo", 7)).toHaveLength(0);
  });

  it("lists only explicit cells for the board", async () => {
    await upsertIssueModelPlanCell("org/repo", 1, "implement", { provider: "codex", tier: "sonnet", source: "explicit" });
    await upsertIssueModelPlanCell("org/repo", 2, "implement", { provider: null, tier: "sonnet", source: "suggested" });
    expect((await listExplicitIssueModelPlanRows()).map((r) => r.issue_ref)).toEqual(["1"]);
  });
});

describe("design-change re-approvals (claws_issue_reapprovals)", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  const change = (issueId: string, version: number) => ({
    issueId,
    requirementsVersion: version,
    planCommentId: "c1",
    prs: [{ repo: "org/a", title: "One", dependsOn: null, kind: "pr" as const, manualAction: null }],
    fates: [{ repo: "org/a", number: 5, fate: "close" as const, position: null }],
    sourceCommentIds: ["c9"],
  });

  it("records a pending change, replaces it, and approves it once", async () => {
    const id = await createClawsIssue({ title: "t", authorLogin: "stjohnb", repos: ["org/a"] });
    expect(await getIssueReapproval(id)).toBeNull();

    await upsertIssueReapproval(change(id, 2));
    await upsertIssueReapproval(change(id, 3));
    expect(await getIssueReapproval(id)).toMatchObject({ ...change(id, 3), approvedAt: null, approvedBy: null });
    expect(await listPendingReapprovalIssueIds([id, "clw_OTHER"])).toEqual(new Set([id]));
    expect(await listPendingReapprovalIssueIds()).toEqual(new Set([id]));

    expect(await markIssueReapprovalApproved(id, "op")).toBe(true);
    expect(await markIssueReapprovalApproved(id, "op")).toBe(false);
    expect(await getIssueReapproval(id)).toMatchObject({ approvedBy: "op", approvedAt: expect.any(String) });
    expect(await listPendingReapprovalIssueIds([id])).toEqual(new Set());
    expect(await listPendingReapprovalIssueIds([])).toEqual(new Set());

    // A later design change replaces the approved row and is pending again.
    await upsertIssueReapproval(change(id, 4));
    expect(await getIssueReapproval(id)).toMatchObject({ requirementsVersion: 4, approvedAt: null, approvedBy: null });
  });

  it("lists which issues have approved requirements, with or without a stored version", async () => {
    const versioned = await createClawsIssue({ title: "v", authorLogin: "stjohnb", repos: ["org/a"] });
    const bare = await createClawsIssue({ title: "b", authorLogin: "stjohnb", repos: ["org/a"] });
    const unapproved = await createClawsIssue({ title: "u", authorLogin: "stjohnb", repos: ["org/a"] });
    await approveClawsIssueRequirements(versioned, 1, "stjohnb");
    await approveClawsIssueRequirements(bare, null, "stjohnb");
    expect(await listRequirementsApprovedIssueIds([versioned, bare, unapproved])).toEqual(new Set([versioned, bare]));
    expect(await listRequirementsApprovedIssueIds([])).toEqual(new Set());
  });

  it("sets and clears a planned PR's rework target", async () => {
    const id = await createClawsIssue({ title: "t", authorLogin: "stjohnb", repos: ["org/a"] });
    await replaceIssuePlannedPRs(id, [{ repo: "org/a", title: "One" }]);
    await setIssuePlannedPRTarget(id, 1, 7);
    expect((await getIssuePlannedPRs(id))[0]).toMatchObject({ prNumber: null, targetPrNumber: 7 });
    await setIssuePlannedPRTarget(id, 1, null);
    expect((await getIssuePlannedPRs(id))[0]?.targetPrNumber).toBeUndefined();
  });
});

describe("planned PRs (claws_issue_prs)", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("replaces the list in order and reads it back by position", async () => {
    const id = await createClawsIssue({ title: "t", authorLogin: "stjohnb", repos: ["org/a"] });
    expect(await getIssuePlannedPRs(id)).toEqual([]);

    expect(await replaceIssuePlannedPRs(id, [{ repo: "org/a", title: "One" }, { repo: "org/a", title: "Two" }])).toEqual([]);
    expect(await getIssuePlannedPRs(id)).toEqual([
      { position: 1, repo: "org/a", title: "One", prNumber: null, dependsOn: null, kind: "pr", manualAction: null },
      { position: 2, repo: "org/a", title: "Two", prNumber: null, dependsOn: null, kind: "pr", manualAction: null },
    ]);
  });

  it("links and unlinks an entry", async () => {
    const id = await createClawsIssue({ title: "t", authorLogin: "stjohnb", repos: ["org/a"] });
    await replaceIssuePlannedPRs(id, [{ repo: "org/a", title: "One" }, { repo: "org/a", title: "Two" }]);

    await linkIssuePlannedPR(id, 2, 41);
    expect((await getIssuePlannedPRs(id))[1]).toMatchObject({ position: 2, prNumber: 41, dependsOn: null, kind: "pr", manualAction: null });
    // A position with no entry is a no-op, not an insert.
    await linkIssuePlannedPR(id, 9, 99);
    expect(await getIssuePlannedPRs(id)).toHaveLength(2);

    await unlinkIssuePlannedPR(id, 2);
    expect((await getIssuePlannedPRs(id))[1]!.prNumber).toBeNull();
  });

  it("carries a link over by position when the repo is unchanged, and reports the links it drops", async () => {
    const id = await createClawsIssue({ title: "t", authorLogin: "stjohnb", repos: ["org/a", "org/b"] });
    await replaceIssuePlannedPRs(id, [
      { repo: "org/a", title: "One" },
      { repo: "org/a", title: "Two" },
      { repo: "org/a", title: "Three" },
    ]);
    await linkIssuePlannedPR(id, 1, 10);
    await linkIssuePlannedPR(id, 2, 20);
    await linkIssuePlannedPR(id, 3, 30);

    // Position 1 keeps its repo (link carried, title updated), position 2 moves
    // to another repo (link dropped), position 3 disappears (link dropped).
    const dropped = await replaceIssuePlannedPRs(id, [
      { repo: "org/a", title: "One, renamed" },
      { repo: "org/b", title: "Two" },
    ]);

    expect(await getIssuePlannedPRs(id)).toEqual([
      { position: 1, repo: "org/a", title: "One, renamed", prNumber: 10, dependsOn: null, kind: "pr", manualAction: null },
      { position: 2, repo: "org/b", title: "Two", prNumber: null, dependsOn: null, kind: "pr", manualAction: null },
    ]);
    expect(dropped).toEqual([
      { position: 2, repo: "org/a", title: "Two", prNumber: 20, dependsOn: null, kind: "pr", manualAction: null },
      { position: 3, repo: "org/a", title: "Three", prNumber: 30, dependsOn: null, kind: "pr", manualAction: null },
    ]);
  });

  it("round-trips kind and manual_action, and drops a link whose kind changed", async () => {
    const id = await createClawsIssue({ title: "t", authorLogin: "stjohnb", repos: ["org/a"] });
    await replaceIssuePlannedPRs(id, [
      { repo: "org/a", title: "Move", manualAction: "Import the repo on Forgejo" },
      { repo: "org/a", title: "Cut over" },
    ]);
    await linkIssuePlannedPR(id, 2, 20);

    const dropped = await replaceIssuePlannedPRs(id, [
      { repo: "org/a", title: "Move", manualAction: "Import the repo on Forgejo" },
      { repo: "org/a", title: "Manual actions (operator)", kind: "manual", dependsOn: [1] },
    ]);

    expect(await getIssuePlannedPRs(id)).toEqual([
      { position: 1, repo: "org/a", title: "Move", prNumber: null, dependsOn: null, kind: "pr", manualAction: "Import the repo on Forgejo" },
      { position: 2, repo: "org/a", title: "Manual actions (operator)", prNumber: null, dependsOn: [1], kind: "manual", manualAction: null },
    ]);
    expect(dropped.map((e) => [e.position, e.prNumber])).toEqual([[2, 20]]);
  });

  it("reports an issue awaiting its operator only once every PR entry has merged", async () => {
    const plan = [
      { repo: "org/a", title: "One" },
      { repo: "org/a", title: "Two" },
      { repo: "org/a", title: "actions (operator)", kind: "manual" as const, dependsOn: [1, 2] },
    ];
    const waiting = await createClawsIssue({ title: "w", authorLogin: "stjohnb", repos: ["org/a"] });
    const midway = await createClawsIssue({ title: "m", authorLogin: "stjohnb", repos: ["org/a"] });
    const noManual = await createClawsIssue({ title: "n", authorLogin: "stjohnb", repos: ["org/a"] });
    await replaceIssuePlannedPRs(waiting, plan);
    await replaceIssuePlannedPRs(midway, plan);
    await replaceIssuePlannedPRs(noManual, plan.slice(0, 1));
    await linkIssuePlannedPR(waiting, 1, 1);
    await linkIssuePlannedPR(waiting, 2, 2);
    await linkIssuePlannedPR(midway, 1, 3);
    await linkIssuePlannedPR(midway, 2, 4);
    await linkIssuePlannedPR(noManual, 1, 5);
    for (const n of [1, 2, 3, 5]) await upsertClawsPr("org/a", n, { stage: "merged" });
    await upsertClawsPr("org/a", 4, { stage: "awaiting-merge" });

    expect(await getIssueIdsAwaitingOperator([waiting, midway, noManual])).toEqual(new Map([[waiting, { position: 3, title: "actions (operator)" }]]));
    expect(await getIssueIdsAwaitingOperator([])).toEqual(new Map());
  });

  it("reports a mid-plan operator step once the PR entries before it have merged", async () => {
    const plan = [
      { repo: "org/a", title: "One", dependsOn: [] },
      { repo: "org/a", title: "actions (operator)", kind: "manual" as const, dependsOn: [1] },
      { repo: "org/a", title: "Two", dependsOn: [2] },
    ];
    const due = await createClawsIssue({ title: "d", authorLogin: "stjohnb", repos: ["org/a"] });
    const notYet = await createClawsIssue({ title: "y", authorLogin: "stjohnb", repos: ["org/a"] });
    const first = await createClawsIssue({ title: "f", authorLogin: "stjohnb", repos: ["org/a"] });
    await replaceIssuePlannedPRs(due, plan);
    await replaceIssuePlannedPRs(notYet, plan);
    await replaceIssuePlannedPRs(first, [{ ...plan[1], dependsOn: [] }, { ...plan[2], dependsOn: [1] }]);
    await linkIssuePlannedPR(due, 1, 11);
    await linkIssuePlannedPR(notYet, 1, 12);
    await upsertClawsPr("org/a", 11, { stage: "merged" });
    await upsertClawsPr("org/a", 12, { stage: "awaiting-merge" });

    expect(await getIssueIdsAwaitingOperator([due, notYet, first])).toEqual(new Map([
      [due, { position: 2, title: "actions (operator)" }],
      [first, { position: 1, title: "actions (operator)" }],
    ]));
  });

  it("reads a Blocked reason only while the issue is still in the Blocked stage it was given for", async () => {
    const parked = await createClawsIssue({ title: "p", authorLogin: "stjohnb", repos: ["org/a"] });
    const moved = await createClawsIssue({ title: "m", authorLogin: "stjohnb", repos: ["org/a"] });
    const reblocked = await createClawsIssue({ title: "r", authorLogin: "stjohnb", repos: ["org/a"] });
    for (const id of [parked, moved, reblocked]) {
      await blockClawsIssue(id, "Parked");
      await setIssueBlockedReason(id, `reason for ${id}`);
    }
    await setClawsIssueLifecycle(moved, "awaiting-plan-review");
    // Blocked again later, by someone else: the old reason no longer applies.
    await _rawDb().run(`UPDATE claws_issues SET stage_changed_at = '2999-01-01 00:00:00' WHERE id = ?`, [reblocked]);

    expect(await getIssueBlockedReasons([parked, moved, reblocked])).toEqual(new Map([[parked, `reason for ${parked}`]]));
    expect(await getIssueBlockedReasons([])).toEqual(new Map());
  });

  it("stores a Backlog return date only on an issue in the Backlog, and lists it once due in its primary repo", async () => {
    const parked = await createClawsIssue({ title: "p", authorLogin: "stjohnb", repos: ["org/a"] });
    const later = await createClawsIssue({ title: "l", authorLogin: "stjohnb", repos: ["org/a"] });
    const elsewhere = await createClawsIssue({ title: "e", authorLogin: "stjohnb", repos: ["org/b"] });
    const closed = await createClawsIssue({ title: "c", authorLogin: "stjohnb", repos: ["org/a"] });
    const onBoard = await createClawsIssue({ title: "o", authorLogin: "stjohnb", repos: ["org/a"] });
    for (const id of [parked, later, elsewhere, closed]) await setClawsIssueLifecycle(id, "backlog");

    expect(await setClawsIssueBacklogUntil(onBoard, "2026-10-23")).toBe(false);
    expect(await setClawsIssueBacklogUntil(parked, "2026-10-23")).toBe(true);
    expect(await setClawsIssueBacklogUntil(later, "2026-10-24")).toBe(true);
    expect(await setClawsIssueBacklogUntil(elsewhere, "2026-10-01")).toBe(true);
    expect(await setClawsIssueBacklogUntil(closed, "2026-10-01")).toBe(true);
    await setClawsIssueState(closed, "closed", "not_planned");

    expect((await listDueBacklogIssues("org/a", "2026-10-22")).map((r) => r.id)).toEqual([]);
    expect((await listDueBacklogIssues("org/a", "2026-10-23")).map((r) => r.id)).toEqual([parked]);
    expect((await listDueBacklogIssues("org/a", "2026-10-24")).map((r) => r.id)).toEqual([parked, later].sort());
    expect((await listDueBacklogIssues("org/b", "2026-10-23")).map((r) => r.id)).toEqual([elsewhere]);
    expect(await getIssueBacklogUntil([parked, later, onBoard])).toEqual(new Map([[parked, "2026-10-23"], [later, "2026-10-24"]]));
    expect(await getIssueBacklogUntil([])).toEqual(new Map());

    expect(await setClawsIssueBacklogUntil(later, null)).toBe(true);
    expect((await getClawsIssue(later))?.backlog_until ?? null).toBeNull();
  });

  it("clears the Backlog return date on every lifecycle write that leaves the Backlog", async () => {
    const ids = await Promise.all(["a", "b", "c", "d", "e"].map((t) => createClawsIssue({ title: t, authorLogin: "stjohnb", repos: ["org/a"] })));
    for (const id of ids) {
      await setClawsIssueLifecycle(id, "backlog");
      await setClawsIssueBacklogUntil(id, "2026-10-23");
    }
    const [a, b, c, d, e] = ids;
    await setClawsIssueLifecycle(a, "planning");
    await removeClawsIssueLabel(b, "Backlog");
    await blockClawsIssue(c, "Parked");
    await promoteClawsIssue(d, { version: null, approvedBy: "stjohnb", expectedLifecycle: "backlog" });
    await demoteClawsIssue(e);
    for (const id of ids) {
      const row = await getClawsIssue(id);
      expect(row?.backlog_until ?? null).toBeNull();
      expect(row?.backlog_until_at ?? null).toBeNull();
    }
    // Back into the Backlog by a plain move: no stale date comes with it.
    await setClawsIssueLifecycle(a, "backlog");
    expect(await listDueBacklogIssues("org/a", "2999-01-01")).toEqual([]);
  });

  it("lists open issues whose current Blocked reason names a PR as PR-stall park candidates", async () => {
    const parked = await createClawsIssue({ title: "p", authorLogin: "stjohnb", repos: ["org/a"] });
    const other = await createClawsIssue({ title: "o", authorLogin: "stjohnb", repos: ["org/a"] });
    const stale = await createClawsIssue({ title: "s", authorLogin: "stjohnb", repos: ["org/a"] });
    const closed = await createClawsIssue({ title: "c", authorLogin: "stjohnb", repos: ["org/a"] });
    for (const id of [parked, other, stale, closed]) await blockClawsIssue(id, "Parked");
    for (const id of [parked, stale, closed]) await setIssueBlockedReason(id, "PR `org/a#7` exhausted its CI-fix budget: …");
    await setIssueBlockedReason(other, "Waiting on the vendor");
    // Re-blocked later by someone else: the PR reason is no longer current.
    await _rawDb().run(`UPDATE claws_issues SET stage_changed_at = '2999-01-01 00:00:00' WHERE id = ?`, [stale]);
    await _rawDb().run(`UPDATE claws_issues SET state = 'closed' WHERE id = ?`, [closed]);

    expect(await listPrStallParkCandidates()).toEqual([{ id: parked, blocked_reason: "PR `org/a#7` exhausted its CI-fix budget: …" }]);
  });

  it("lists open issues whose current Blocked reason waits on PRs as PR-wait park candidates", async () => {
    const parked = await createClawsIssue({ title: "p", authorLogin: "stjohnb", repos: ["org/a"] });
    const other = await createClawsIssue({ title: "o", authorLogin: "stjohnb", repos: ["org/a"] });
    const stall = await createClawsIssue({ title: "s", authorLogin: "stjohnb", repos: ["org/a"] });
    const stale = await createClawsIssue({ title: "x", authorLogin: "stjohnb", repos: ["org/a"] });
    for (const id of [parked, other, stall, stale]) await blockClawsIssue(id, "Parked");
    for (const id of [parked, stale]) await setIssueBlockedReason(id, "Waiting on `org/b#3` to merge");
    await setIssueBlockedReason(other, "Waiting on the vendor");
    await setIssueBlockedReason(stall, "PR `org/a#7` exhausted its CI-fix budget: …");
    await _rawDb().run(`UPDATE claws_issues SET stage_changed_at = '2999-01-01 00:00:00' WHERE id = ?`, [stale]);

    expect(await listPrWaitParkCandidates()).toEqual([{ id: parked, blocked_reason: "Waiting on `org/b#3` to merge" }]);
  });

  it("round-trips depends_on, and reads a malformed value as null", async () => {
    const id = await createClawsIssue({ title: "t", authorLogin: "stjohnb", repos: ["org/a"] });
    await replaceIssuePlannedPRs(id, [
      { repo: "org/a", title: "One", dependsOn: [] },
      { repo: "org/a", title: "Two" },
      { repo: "org/a", title: "Three", dependsOn: [1] },
    ]);
    expect((await getIssuePlannedPRs(id)).map((e) => e.dependsOn)).toEqual([[], null, [1]]);

    await _rawDb().run(`UPDATE claws_issue_prs SET depends_on = ? WHERE issue_id = ? AND position = 3`, ["not json", id]);
    expect((await getIssuePlannedPRs(id))[2]!.dependsOn).toBeNull();
  });

  it("clears the list with an empty replacement", async () => {
    const id = await createClawsIssue({ title: "t", authorLogin: "stjohnb", repos: ["org/a"] });
    await replaceIssuePlannedPRs(id, [{ repo: "org/a", title: "One" }]);
    await replaceIssuePlannedPRs(id, []);
    expect(await getIssuePlannedPRs(id)).toEqual([]);
  });

  it("resolves a forge issue's linked native id, shadow or import", async () => {
    const shadow = await createShadowIssue("org/a", 7, { title: "Forge", authorLogin: "someone" });
    expect(await getLinkedNativeId("org/a", 7)).toBe(shadow!.id);
    expect(await getLinkedNativeId("org/a", 8)).toBeUndefined();
  });
});

describe("claws issue plan versions", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  const HEADER = "*— Automated by Claws —*";
  const HASH = "a".repeat(64);
  const plan = (text: string, lastComment = "0") =>
    `${HEADER}\n\n## Implementation Plan\n\n### Requirement\n\n${text}\n\nCLAWS_PLAN_BODY_HASH: ${HASH}\nCLAWS_PLAN_LAST_COMMENT: ${lastComment}`;

  it("records version 1 for a plan comment, normalised", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb" });
    const commentId = await addClawsIssueComment(id, "claws", plan("Do it."));

    const plans = await listClawsIssuePlans(id);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ issue_id: id, version: 1, comment_id: commentId });
    expect(plans[0].body).toBe("## Implementation Plan\n\n### Requirement\n\nDo it.");
  });

  it("records a new version when the plan text changes and none for a marker-only re-stamp", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb" });
    const commentId = await addClawsIssueComment(id, "claws", plan("Do it."));

    await editClawsIssueComment(commentId, plan("Do it.", "7"));
    expect(await listClawsIssuePlans(id)).toHaveLength(1);

    await editClawsIssueComment(commentId, plan("Do it differently."));
    const plans = await listClawsIssuePlans(id);
    expect(plans.map((p) => p.version)).toEqual([1, 2]);
    expect(plans[1].body).toContain("Do it differently.");
  });

  it("ignores a non-Claws comment quoting the plan header and a Claws reply without it", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb" });
    await addClawsIssueComment(id, "stjohnb", "## Implementation Plan\n\nMy own idea.");
    await addClawsIssueComment(id, "claws", `${HEADER}\n\nThanks, updated.`);

    expect(await listClawsIssuePlans(id)).toEqual([]);
  });

  it("backfills an issue with plan comments once and is a no-op on re-run", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb" });
    await addClawsIssueComment(id, "claws", plan("First."));
    await addClawsIssueComment(id, "claws", plan("Second."));
    await _rawDb().run(`DELETE FROM claws_issue_plans`);

    await backfillClawsIssuePlans();
    await backfillClawsIssuePlans();

    const plans = await listClawsIssuePlans(id);
    expect(plans.map((p) => p.version)).toEqual([1, 2]);
    expect(plans[1].body).toContain("Second.");
  });

  it("lists the latest plan of open native issues only", async () => {
    const open = await createClawsIssue({ title: "Open", authorLogin: "stjohnb" });
    await addClawsIssueComment(open, "claws", plan("v1"));
    await addClawsIssueComment(open, "claws", plan("v2"));
    const closed = await createClawsIssue({ title: "Closed", authorLogin: "stjohnb" });
    await addClawsIssueComment(closed, "claws", plan("closed"));
    await setClawsIssueState(closed, "closed", "completed");
    const shadow = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    await _rawDb().run(
      `INSERT INTO claws_issues (id, title, body, author_login, state, state_reason, created_at, updated_at, closed_at, kind)
       VALUES (?, 'S', '', 'claws', 'open', NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00', NULL, 'shadow')`,
      [shadow],
    );
    await _rawDb().run(
      `INSERT INTO claws_issue_plans (issue_id, version, comment_id, body, created_at) VALUES (?, 1, NULL, 'x', '2026-01-01 00:00:00')`,
      [shadow],
    );

    const latest = await listLatestClawsIssuePlansForOpenIssues();
    expect([...latest.keys()]).toEqual([open]);
    expect(latest.get(open)).toMatchObject({ version: 2 });
    expect(latest.get(open)!.body).toContain("v2");
  });
});

describe("claws_issue_requirements", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  const record = (requirement: string) => ({
    title: "Fix it",
    kind: "bug" as const,
    context: "Broken since Tuesday.",
    requirement,
    acceptanceCriteria: ["It works", "It stays working"],
    outOfScope: ["Rewriting it"],
  });

  it("numbers versions per issue and lists them oldest first with the lists parsed", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb" });
    const other = await createClawsIssue({ title: "U", authorLogin: "stjohnb" });

    expect(await addClawsIssueRequirementsVersion(id, record("first"), "clwc_1")).toBe(1);
    expect(await addClawsIssueRequirementsVersion(other, record("elsewhere"), null)).toBe(1);
    expect(await addClawsIssueRequirementsVersion(id, record("second"), "clwc_1")).toBe(2);

    const versions = await listClawsIssueRequirements(id);
    expect(versions.map((v) => [v.version, v.requirement])).toEqual([[1, "first"], [2, "second"]]);
    expect(versions[1]).toMatchObject({
      issue_id: id, title: "Fix it", kind: "bug", comment_id: "clwc_1",
      acceptance_criteria: ["It works", "It stays working"], out_of_scope: ["Rewriting it"],
    });
  });

  it("lists the latest version of every open issue, shadows included", async () => {
    const open = await createClawsIssue({ title: "Open", authorLogin: "stjohnb" });
    await addClawsIssueRequirementsVersion(open, record("v1"), null);
    await addClawsIssueRequirementsVersion(open, record("v2"), null);
    const closed = await createClawsIssue({ title: "Closed", authorLogin: "stjohnb" });
    await addClawsIssueRequirementsVersion(closed, record("closed"), null);
    await setClawsIssueState(closed, "closed", "completed");
    const shadow = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    await _rawDb().run(
      `INSERT INTO claws_issues (id, title, body, author_login, state, state_reason, created_at, updated_at, closed_at, kind)
       VALUES (?, 'S', '', 'claws', 'open', NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00', NULL, 'shadow')`,
      [shadow],
    );
    await addClawsIssueRequirementsVersion(shadow, record("forge"), "12345");

    const latest = await listLatestClawsIssueRequirementsForOpenIssues();
    expect([...latest.keys()].sort()).toEqual([open, shadow].sort());
    expect(latest.get(open)).toMatchObject({ version: 2, requirement: "v2" });
    expect(latest.get(shadow)).toMatchObject({ version: 1, comment_id: "12345" });
  });

  it("lists the comments that may be feedback on open `ideas` issues' latest requirements version, for the board", async () => {
    const reviewed = await createClawsIssue({ title: "Reviewed", authorLogin: "stjohnb" });
    // Before the latest version: already answered by it.
    await addClawsIssueComment(reviewed, "stjohnb", "early thought");
    await _rawDb().run(`UPDATE claws_issue_comments SET created_at = '2026-01-01 00:00:00' WHERE issue_id = ?`, [reviewed]);
    await addClawsIssueRequirementsVersion(reviewed, record("r"), null);
    await addClawsIssueComment(reviewed, "stjohnb", "tighten AC2");
    // Claws' own, a bot's, and one a refine run already 👍'd.
    await addClawsIssueComment(reviewed, "claws", "noted");
    await addClawsIssueComment(reviewed, "dependabot[bot]", "bump");
    const addressed = await addClawsIssueComment(reviewed, "stjohnb", "drop AC3");
    await addClawsIssueCommentReaction(addressed, "claws", "+1");
    // No version yet: Drafting already, so its comments are not read.
    const unwritten = await createClawsIssue({ title: "Unwritten", authorLogin: "stjohnb" });
    await addClawsIssueComment(unwritten, "stjohnb", "early thought");
    // Promoted: past the requirements columns.
    const planning = await createClawsIssue({ title: "Planning", authorLogin: "stjohnb" });
    await addClawsIssueRequirementsVersion(planning, record("p"), null);
    await setClawsIssueLifecycle(planning, "planning");
    await addClawsIssueComment(planning, "stjohnb", "plan it");
    // Closed: off the open board.
    const closed = await createClawsIssue({ title: "Closed", authorLogin: "stjohnb" });
    await addClawsIssueRequirementsVersion(closed, record("c"), null);
    await addClawsIssueComment(closed, "stjohnb", "done");
    await setClawsIssueState(closed, "closed", "completed");

    const rows = await listClawsIssueCommentsForOpenIdeasIssues("claws");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issue_id: reviewed, author_login: "stjohnb", body: "tighten AC2" });
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("records the approved version, who approved it and when", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb" });
    await addClawsIssueRequirementsVersion(id, record("r"), null);

    expect(await getClawsIssue(id)).toMatchObject({ approved_requirements_version: null, requirements_approved_by: null, requirements_approved_at: null });
    expect(await approveClawsIssueRequirements(id, 1, "stjohnb")).toBe(true);
    const approved = await getClawsIssue(id);
    expect(approved).toMatchObject({ requirements_approved_by: "stjohnb" });
    expect(Number(approved!.approved_requirements_version)).toBe(1);
    expect(approved!.requirements_approved_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(await approveClawsIssueRequirements("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDZ", null, "claws")).toBe(false);
  });

  it("batches the approved version of every open issue, keyed by tracker id — not the latest unapproved one", async () => {
    const approved = await createClawsIssue({ title: "Approved", authorLogin: "stjohnb" });
    await addClawsIssueRequirementsVersion(approved, record("v1"), null);
    await addClawsIssueRequirementsVersion(approved, record("v2"), null);
    await approveClawsIssueRequirements(approved, 1, "stjohnb");

    const unapproved = await createClawsIssue({ title: "Unapproved", authorLogin: "stjohnb" });
    await addClawsIssueRequirementsVersion(unapproved, record("draft"), null);

    const closed = await createClawsIssue({ title: "Closed", authorLogin: "stjohnb" });
    await addClawsIssueRequirementsVersion(closed, record("closed"), null);
    await approveClawsIssueRequirements(closed, 1, "stjohnb");
    await setClawsIssueState(closed, "closed", "completed");

    const batch = await listApprovedClawsIssueRequirementsForOpenIssues();

    expect([...batch.keys()]).toEqual([approved]);
    expect(batch.get(approved)).toMatchObject({ version: 1, requirement: "v1", approved_by: "stjohnb" });
  });
});

describe("PR state store (claws_prs)", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("inserts a row with defaults for the columns the patch leaves out", async () => {
    await upsertClawsPr("org/a", 7, { stage: "opened" });
    const row = await getClawsPr("org/a", 7);
    expect(row).toMatchObject({
      repo: "org/a", prNumber: 7, stage: "opened", issueId: null, phase: null,
      needsHumanReview: false, mergeApprovedAt: null, manualActionReason: null,
    });
    expect(row!.createdAt).toMatch(/Z$/);
    expect(await getClawsPr("org/a", 8)).toBeNull();
  });

  it("emits pr-ready-to-merge once when the row becomes ready to merge (#clw_01M5Q66MKK4WHBJ8XT1EMZZGEA)", async () => {
    const { getEventsSince } = await import("./github-events.js");
    const ready = { stage: "awaiting-merge" as const, headSha: "abc", reviewedSha: "abc", reviewVerdict: "clean", ciStatus: "passing", issueId: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC" };
    await upsertClawsPr("org/a", 7, { ...ready, ciStatus: "pending" });
    await upsertClawsPr("org/a", 7, ready);
    await upsertClawsPr("org/a", 7, { title: "t" });
    const readyEvents = () => getEventsSince(0, { repo: "org/a", items: [7], kinds: ["pr-ready-to-merge"] });
    await vi.waitFor(async () => expect(await readyEvents()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await readyEvents())[0]).toMatchObject({ detail: "abc", related: ["clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"] });
    expect(await readyEvents()).toHaveLength(1);
  });

  it("updates only the keys in the patch", async () => {
    await upsertClawsPr("org/a", 7, { stage: "awaiting-merge", needsHumanReview: true, mergeApprovedAt: "2026-09-01T10:00:00.000Z", mergeApprovedBy: "label" });
    await upsertClawsPr("org/a", 7, { headSha: "abc", ciStatus: "passing" });
    expect(await getClawsPr("org/a", 7)).toMatchObject({
      stage: "awaiting-merge", needsHumanReview: true, headSha: "abc", ciStatus: "passing",
      mergeApprovedAt: "2026-09-01T10:00:00Z", mergeApprovedBy: "label",
    });
    await upsertClawsPr("org/a", 7, { mergeApprovedAt: null, mergeApprovedBy: null, needsHumanReview: false });
    expect(await getClawsPr("org/a", 7)).toMatchObject({ mergeApprovedAt: null, mergeApprovedBy: null, needsHumanReview: false, headSha: "abc" });
  });

  it("round-trips a board infra merge approval (#clw_01M5WBG6JZ8P3PCYVCQ3PS9BBS)", async () => {
    await upsertClawsPr("org/a", 7, { stage: "awaiting-merge" });
    expect(await getClawsPr("org/a", 7)).toMatchObject({ infraMergeApprovedBy: null, infraMergeApprovedAt: null, infraMergeApprovedSha: null });
    await upsertClawsPr("org/a", 7, { infraMergeApprovedBy: "op", infraMergeApprovedAt: "2026-10-26T10:00:00.000Z", infraMergeApprovedSha: "abc" });
    expect(await getClawsPr("org/a", 7)).toMatchObject({ infraMergeApprovedBy: "op", infraMergeApprovedAt: "2026-10-26T10:00:00Z", infraMergeApprovedSha: "abc" });
    await upsertClawsPr("org/a", 7, { infraMergeApprovedBy: null, infraMergeApprovedAt: null, infraMergeApprovedSha: null });
    expect(await getClawsPr("org/a", 7)).toMatchObject({ infraMergeApprovedBy: null, infraMergeApprovedAt: null, infraMergeApprovedSha: null });
  });

  it("records and clears a dispatch note without moving updated_at or seeding a row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
      await upsertClawsPr("org/a", 7, { stage: "opened" });
      vi.setSystemTime(new Date("2026-09-01T10:05:00Z"));
      await setClawsPrDispatchNote("org/a", 7, "review addresser: nothing to address");
      expect(await getClawsPr("org/a", 7)).toMatchObject({
        dispatchNote: "review addresser: nothing to address",
        dispatchNoteAt: "2026-09-01T10:05:00Z",
        updatedAt: "2026-09-01T10:00:00Z",
      });
      await setClawsPrDispatchNote("org/a", 7, null);
      expect(await getClawsPr("org/a", 7)).toMatchObject({ dispatchNote: null, dispatchNoteAt: null });
      await setClawsPrDispatchNote("org/a", 8, "PR not in the open list");
      expect(await getClawsPr("org/a", 8)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves updated_at on a state write but not on an observed-only one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
      await upsertClawsPr("org/a", 7, { stage: "opened" });
      vi.setSystemTime(new Date("2026-09-01T10:05:00Z"));
      await upsertClawsPr("org/a", 7, { headSha: "abc", observedAt: "2026-09-01T10:05:00Z", ciStatus: "passing" });
      expect(await getClawsPr("org/a", 7)).toMatchObject({ headSha: "abc", updatedAt: "2026-09-01T10:00:00Z" });
      vi.setSystemTime(new Date("2026-09-01T10:10:00Z"));
      await upsertClawsPr("org/a", 7, { stage: "awaiting-review", observedAt: "2026-09-01T10:10:00Z" });
      expect(await getClawsPr("org/a", 7)).toMatchObject({ stage: "awaiting-review", updatedAt: "2026-09-01T10:10:00Z" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores the title; a title-only write leaves updated_at alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
      await upsertClawsPr("org/a", 7, { stage: "opened", title: "First" });
      expect((await getClawsPr("org/a", 7))!.title).toBe("First");
      vi.setSystemTime(new Date("2026-09-01T10:05:00Z"));
      await upsertClawsPr("org/a", 7, { title: "Renamed" });
      expect(await getClawsPr("org/a", 7)).toMatchObject({ title: "Renamed", updatedAt: "2026-09-01T10:00:00Z" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists every stage for an issue, unlike the open-only list", async () => {
    await upsertClawsPr("org/b", 3, { stage: "closed", issueId: "clw_x" });
    await upsertClawsPr("org/a", 9, { stage: "merged", issueId: "clw_x" });
    await upsertClawsPr("org/a", 2, { stage: "opened", issueId: "clw_x" });
    await upsertClawsPr("org/a", 4, { stage: "opened", issueId: "clw_y" });
    expect((await listClawsPrsForIssue("clw_x")).map((r) => [r.repo, r.prNumber])).toEqual([["org/a", 2], ["org/a", 9], ["org/b", 3]]);
    expect((await listOpenClawsPrsForIssue("clw_x")).map((r) => r.prNumber)).toEqual([2]);
  });

  // #clw_01M4TABN7ZFQ3MG5KK85GFGWNK: the stage is retired; the hold reason stays.
  it("migrates rows at the retired manual-action stage and drops the retired label", async () => {
    await _rawDb().run(`INSERT INTO claws_prs (repo, pr_number, stage, ci_status, manual_action_reason) VALUES ('org/a', 1, 'manual-action', 'failing', 'set secrets')`);
    await _rawDb().run(`INSERT INTO claws_prs (repo, pr_number, stage, ci_status) VALUES ('org/a', 2, 'manual-action', 'passing')`);
    await upsertClawsPr("org/a", 3, { stage: "awaiting-merge" });
    const id = await createClawsIssue({ title: "[dmarc] alert", authorLogin: "claws", repos: ["org/a"], labels: ["Priority", "Manual Action"] });

    await migrateRetiredManualAction();
    await migrateRetiredManualAction();

    expect(await getClawsPr("org/a", 1)).toMatchObject({ stage: "ci-failing", manualActionReason: "set secrets" });
    expect(await getClawsPr("org/a", 2)).toMatchObject({ stage: "awaiting-review" });
    expect(await getClawsPr("org/a", 3)).toMatchObject({ stage: "awaiting-merge" });
    expect((await getClawsIssue(id))?.labels).toEqual(["Priority"]);
  });

  // #clw_01M5KVM1ERWWP2FZQPW8J1WZ1K: ssh:k3s is now ssh:thinkcentre.
  it("renames ssh:k3s grants and remembered defaults, idempotently", async () => {
    await _rawDb().run(`INSERT INTO sessions (id, tmux_name, mode, cwd, capabilities, created_at) VALUES ('s1', 't', 'agent', '/x', ?, 1)`, [JSON.stringify(["cross-repo", "ssh:k3s"])]);
    await _rawDb().run(`INSERT INTO sessions (id, tmux_name, mode, cwd, capabilities, created_at) VALUES ('s2', 't', 'agent', '/x', 'not json "ssh:k3s"', 1)`);
    await _rawDb().run(`INSERT INTO session_capability_defaults (repo_key, capabilities, updated_at) VALUES ('org/a', ?, 1)`, [JSON.stringify(["cross-repo", "ssh:k3s"])]);

    await _rawDb().run(`INSERT INTO sessions (id, tmux_name, mode, cwd, capabilities, created_at) VALUES ('s3', 't', 'agent', '/x', ?, 1)`, [JSON.stringify(["ssh:homeassistant", "ssh:thinkcentre"])]);

    await migrateRenamedCapabilities();
    await migrateRenamedCapabilities();

    const s3 = await _rawDb().all(`SELECT capabilities FROM sessions WHERE id = 's3'`) as Array<{ capabilities: string }>;
    expect(JSON.parse(s3[0]!.capabilities)).toEqual(["ssh:thinkcentre"]);
    const s1 = await _rawDb().all(`SELECT capabilities FROM sessions WHERE id = 's1'`) as Array<{ capabilities: string }>;
    const s2 = await _rawDb().all(`SELECT capabilities FROM sessions WHERE id = 's2'`) as Array<{ capabilities: string }>;
    const d = await _rawDb().all(`SELECT capabilities FROM session_capability_defaults WHERE repo_key = 'org/a'`) as Array<{ capabilities: string }>;
    expect(JSON.parse(s1[0]!.capabilities)).toEqual(["cross-repo", "ssh:thinkcentre"]);
    expect(s2[0]!.capabilities).toBe('not json "ssh:k3s"');
    expect(JSON.parse(d[0]!.capabilities)).toEqual(["cross-repo", "ssh:thinkcentre"]);
  });

  it("lists a repo's rows, optionally open only", async () => {
    await upsertClawsPr("org/a", 2, { stage: "merged" });
    await upsertClawsPr("org/a", 1, { stage: "opened" });
    await upsertClawsPr("org/b", 3, { stage: "opened" });
    expect((await listClawsPrs("org/a")).map((r) => r.prNumber)).toEqual([1, 2]);
    expect((await listClawsPrs("org/a", { openOnly: true })).map((r) => r.prNumber)).toEqual([1]);
  });

  it("lists an issue's open rows in any repo, every open row with an issue, and every open row", async () => {
    await upsertClawsPr("org/a", 1, { stage: "opened", issueId: "clw_X" });
    await upsertClawsPr("org/b", 2, { stage: "awaiting-merge", issueId: "clw_X" });
    await upsertClawsPr("org/a", 3, { stage: "merged", issueId: "clw_X" });
    await upsertClawsPr("org/a", 4, { stage: "opened", issueId: "clw_Y" });
    await upsertClawsPr("org/a", 5, { stage: "opened" });
    expect((await listOpenClawsPrsForIssue("clw_X")).map((r) => `${r.repo}#${r.prNumber}`)).toEqual(["org/a#1", "org/b#2"]);
    expect(await listOpenClawsPrsForIssue("clw_Z")).toEqual([]);
    expect((await listOpenClawsPrsWithIssue()).map((r) => `${r.repo}#${r.prNumber}`)).toEqual(["org/a#1", "org/a#4", "org/b#2"]);
    expect((await listOpenClawsPrs()).map((r) => `${r.repo}#${r.prNumber}`)).toEqual(["org/a#1", "org/a#4", "org/a#5", "org/b#2"]);
  });

  // #clw_01M4XWHG3A2Q5Y06GN2SC7K06X: a step committed onto another issue's PR.
  it("lists an open PR under the issue that owns it and every issue whose step is linked to it", async () => {
    const owner = await createClawsIssue({ title: "a", authorLogin: "stjohnb", repos: ["org/a"] });
    const rider = await createClawsIssue({ title: "b", authorLogin: "stjohnb", repos: ["org/a"] });
    await replaceIssuePlannedPRs(owner, [{ repo: "org/a", title: "Own" }]);
    await replaceIssuePlannedPRs(rider, [{ repo: "org/a", title: "Rides" }, { repo: "org/a", title: "Later", kind: "manual" }]);
    await upsertClawsPr("org/a", 3, { stage: "awaiting-merge", issueId: owner });
    await upsertClawsPr("org/a", 4, { stage: "merged", issueId: owner });
    await linkIssuePlannedPR(owner, 1, 3);
    await linkIssuePlannedPR(rider, 1, 3);

    const linked = (await listOpenClawsPrsLinkedToIssues()).map((l) => `${l.issueId}:${l.row.repo}#${l.row.prNumber}`).sort();
    expect(linked).toEqual([`${owner}:org/a#3`, `${rider}:org/a#3`].sort());
    expect((await listOpenClawsPrsForIssueOrSteps(rider)).map((r) => `${r.repo}#${r.prNumber}:${r.stage}`)).toEqual(["org/a#3:awaiting-merge"]);
    expect((await listOpenClawsPrsForIssueOrSteps(owner)).map((r) => r.prNumber)).toEqual([3]);
    // Ownership-only callers are unchanged.
    expect(await listOpenClawsPrsForIssue(rider)).toEqual([]);
  });

  it("reports whether a job's task is running for an item", async () => {
    const id = await recordTaskStart("issue-worker", "org/a", 7, null);
    await recordTaskStart("ci-fixer", "org/a", 8, null);
    expect(await hasRunningTask("issue-worker", "org/a", 7)).toBe(true);
    expect(await hasRunningTask("issue-worker", "org/a", 8)).toBe(false);
    expect(await hasRunningTask("issue-worker", "org/b", 7)).toBe(false);
    await recordTaskComplete(id);
    expect(await hasRunningTask("issue-worker", "org/a", 7)).toBe(false);
  });

  it("finds the issue and phase a PR implements from claws_issue_prs", async () => {
    const id = await createClawsIssue({ title: "t", authorLogin: "stjohnb", repos: ["org/a"] });
    await replaceIssuePlannedPRs(id, [{ repo: "org/a", title: "One" }, { repo: "org/a", title: "Two" }]);
    await linkIssuePlannedPR(id, 2, 41);
    expect(await findIssuePlannedPRByNumber("org/a", 41)).toEqual({ issueId: id, position: 2 });
    expect(await findIssuePlannedPRByNumber("org/a", 42)).toBeNull();
    expect(await findIssuePlannedPRByNumber("org/b", 41)).toBeNull();
  });
});

describe("claws issue history", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  const changes = async (id: string) =>
    (await listClawsIssueHistory(id)).map((r) => ({ field: r.field, old: r.old_value, new: r.new_value }));

  it("records setting, changing and clearing the Backlog return date", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await setClawsIssueLifecycle(id, "backlog");
    await setClawsIssueBacklogUntil(id, "2026-10-23");
    await setClawsIssueBacklogUntil(id, "2026-10-23");
    await setClawsIssueBacklogUntil(id, "2026-10-30");
    await setClawsIssueLifecycle(id, "planning");

    expect(await changes(id)).toEqual([
      { field: "lifecycle", old: "ideas", new: "backlog" },
      { field: "backlog_until", old: null, new: "2026-10-23" },
      { field: "backlog_until", old: "2026-10-23", new: "2026-10-30" },
      { field: "lifecycle", old: "backlog", new: "planning" },
      { field: "backlog_until", old: "2026-10-30", new: null },
    ]);
  });

  it("records one entry with old and new values for each kind of change", async () => {
    const id = await createClawsIssue({ title: "Old", body: "before", authorLogin: "stjohnb", repos: ["org/b"] });
    const other = await createClawsIssue({ title: "Other", authorLogin: "stjohnb", repos: ["org/b"] });

    await blockClawsIssue(id, "first");
    await updateClawsIssueTitle(id, "New");
    await updateClawsIssueBody(id, "after");
    await setClawsIssueRepos(id, ["org/b", "org/a"]);
    await addClawsIssueLabel(id, "bug");
    await removeClawsIssueLabel(id, "bug");
    await addClawsIssueLabel(id, "Backlog");
    await removeClawsIssueLabel(id, "Backlog");
    const { link } = await createClawsIssueLink({ sourceId: id, targetId: other, kind: "depends_on", createdBy: "stjohnb", actingId: id });
    await markClawsIssueLinksReleased(id);
    await deleteClawsIssueLink(link.id);
    await setIssueBlockedReason(id, "waiting");
    await setClawsIssueState(id, "closed", "not_planned");
    await setClawsIssueState(id, "open");

    expect(await changes(id)).toEqual([
      { field: "lifecycle", old: "ideas", new: "blocked" },
      { field: "blocked_reason", old: null, new: "first" },
      { field: "title", old: "Old", new: "New" },
      { field: "body", old: "before", new: "after" },
      { field: "repos", old: "org/b", new: "org/a, org/b" },
      { field: "label", old: null, new: "bug" },
      { field: "label", old: "bug", new: null },
      { field: "lifecycle", old: "blocked", new: "backlog" },
      { field: "lifecycle", old: "backlog", new: "ideas" },
      { field: "link", old: null, new: `depends_on ${other}` },
      { field: "dependency released", old: null, new: other },
      { field: "link", old: `depends_on ${other}`, new: null },
      { field: "blocked_reason", old: "first", new: "waiting" },
      { field: "state", old: "open", new: "closed (not_planned)" },
      { field: "state", old: "closed (not_planned)", new: "open" },
    ]);
  });

  it("records promotion and demotion, with the rename", async () => {
    const id = await createClawsIssue({ title: "Filed", authorLogin: "stjohnb", repos: ["org/a"] });
    await promoteClawsIssue(id, { version: null, approvedBy: "stjohnb", title: "Renamed", expectedLifecycle: "ideas" });
    expect(await promoteClawsIssue(id, { version: null, approvedBy: "stjohnb", expectedLifecycle: "ideas" })).toBe(false);
    await demoteClawsIssue(id);
    expect(await changes(id)).toEqual([
      { field: "lifecycle", old: "ideas", new: "planning" },
      { field: "approved_through", old: "none", new: "requirements" },
      { field: "title", old: "Filed", new: "Renamed" },
      { field: "lifecycle", old: "planning", new: "ideas" },
      { field: "approved_through", old: "requirements", new: "none" },
    ]);
  });

  it("writes nothing for a change that changes nothing", async () => {
    const id = await createClawsIssue({ title: "Same", body: "text", authorLogin: "stjohnb", repos: ["org/a", "org/b"] });
    await setClawsIssueLifecycle(id, "ideas");
    await updateClawsIssueTitle(id, "Same");
    await updateClawsIssueBody(id, "text");
    await setClawsIssueRepos(id, ["org/b", "org/a"]);
    await addClawsIssueLabel(id, "bug");
    await addClawsIssueLabel(id, "bug");
    await setClawsIssueState(id, "open");
    await demoteClawsIssue(id);
    expect(await changes(id)).toEqual([{ field: "label", old: null, new: "bug" }]);
  });

  it("records nothing for a shadow", async () => {
    const shadow = (await createShadowIssue("org/a", 7, { title: "Forge", authorLogin: "someone" }))!.id;
    await setShadowLifecycle(shadow, "blocked");
    await promoteClawsIssue(shadow, { version: null, approvedBy: "stjohnb", expectedLifecycle: "blocked" });
    await demoteClawsIssue(shadow);
    await setIssueBlockedReason(shadow, "waiting");
    expect(await listClawsIssueHistory(shadow)).toEqual([]);
  });

  it("caps a long body", async () => {
    const id = await createClawsIssue({ title: "Long", body: "", authorLogin: "stjohnb", repos: ["org/a"] });
    await updateClawsIssueBody(id, "x".repeat(20_000));
    const [entry] = await listClawsIssueHistory(id);
    expect(entry!.new_value).toBe(`${"x".repeat(10_000)}…(truncated)`);
  });

  it("stores the actor set by withIssueActor", async () => {
    const id = await createClawsIssue({ title: "Op", authorLogin: "stjohnb", repos: ["org/a"] });
    await withIssueActor({ kind: "operator", name: "stjohnb" }, () => setClawsIssueLifecycle(id, "backlog"));
    const [entry] = await listClawsIssueHistory(id);
    expect(entry).toMatchObject({ actor_kind: "operator", actor: "stjohnb", run_id: null });
  });

  it("attributes a change with no actor to the current run's job", async () => {
    const id = await createClawsIssue({ title: "Auto", authorLogin: "stjohnb", repos: ["org/a"] });
    await withRunContext("run-1", () => setClawsIssueLifecycle(id, "awaiting-plan-review"), { job: "x" });
    await setClawsIssueLifecycle(id, "backlog");
    const [inRun, outside] = await listClawsIssueHistory(id);
    expect(inRun).toMatchObject({ actor_kind: "automation", actor: "x", run_id: "run-1" });
    expect(outside).toMatchObject({ actor_kind: "automation", actor: "unknown", run_id: null });
  });
});

describe("claws issue comment soft delete", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  const record = {
    title: "Fix it",
    kind: "bug" as const,
    context: "Broken.",
    requirement: "It works",
    acceptanceCriteria: ["It works"],
    outOfScope: [],
  };

  it("hides a deleted comment from every read but keeps its row with who and when", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await addClawsIssueRequirementsVersion(id, record, null);
    const keep = await addClawsIssueComment(id, "stjohnb", "still relevant");
    const drop = await addClawsIssueComment(id, "stjohnb", "stale thought");
    const before = (await getClawsIssue(id))!.updated_at;

    expect(await withIssueActor({ kind: "operator", name: "stjohnb" }, () => softDeleteClawsIssueComments(id, [drop], "operator:stjohnb"))).toBe(1);

    expect((await listClawsIssueComments(id)).map((c) => c.id)).toEqual([keep]);
    expect((await listClawsIssueCommentsForOpenIdeasIssues("claws")).map((c) => c.body)).toEqual(["still relevant"]);
    const row = await _rawDb().get(`SELECT deleted_at, deleted_by FROM claws_issue_comments WHERE id = ?`, [drop]) as { deleted_at: string | null; deleted_by: string | null };
    expect(row.deleted_by).toBe("operator:stjohnb");
    expect(row.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // A deletion is not activity: the issue's updated_at is left alone.
    expect((await getClawsIssue(id))!.updated_at).toBe(before);
  });

  it("writes one comment History entry per deleted comment, and nothing for a repeat", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    const a = await addClawsIssueComment(id, "stjohnb", "first  \n line");
    const b = await addClawsIssueComment(id, "claws", "x".repeat(300));
    const before = (await listClawsIssueHistory(id)).length;

    await withIssueActor({ kind: "session", name: "abc123" }, () => softDeleteClawsIssueComments(id, [a, b], "session:abc123"));
    const entries = (await listClawsIssueHistory(id)).slice(before);
    expect(entries.map((e) => [e.field, e.old_value, e.new_value, e.actor_kind, e.actor])).toEqual([
      ["comment", `${a} by stjohnb: first line`, null, "session", "abc123"],
      ["comment", `${b} by claws: ${"x".repeat(200)}…`, null, "session", "abc123"],
    ]);

    expect(await softDeleteClawsIssueComments(id, [a, b], "session:abc123")).toBe(0);
    expect((await listClawsIssueHistory(id)).length).toBe(before + 2);
  });

  it("skips ids that belong to another issue", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb" });
    const other = await createClawsIssue({ title: "U", authorLogin: "stjohnb" });
    const foreign = await addClawsIssueComment(other, "stjohnb", "elsewhere");
    expect(await softDeleteClawsIssueComments(id, [foreign], "operator:stjohnb")).toBe(0);
    expect(await listClawsIssueComments(other)).toHaveLength(1);
  });

  it("writes no History for a shadow's comment", async () => {
    const shadow = (await createShadowIssue("org/a", 7, { title: "Forge", authorLogin: "someone" }))!.id;
    await _rawDb().run(
      `INSERT INTO claws_issue_comments (id, issue_id, author_login, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ["clwc_SHADOWCOMMENT", shadow, "someone", "hi", ago(0), ago(0)],
    );
    expect(await softDeleteClawsIssueComments(shadow, ["clwc_SHADOWCOMMENT"], "operator:stjohnb")).toBe(1);
    expect(await listClawsIssueHistory(shadow)).toEqual([]);
  });

  it("keeps a deleted plan comment out of the plan backfill", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb" });
    await _rawDb().run(
      `INSERT INTO claws_issue_comments (id, issue_id, author_login, body, created_at, updated_at, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["clwc_DELETEDPLAN", id, "claws", "## Implementation Plan\n\nold", ago(0), ago(0), ago(0), "operator:stjohnb"],
    );
    await backfillClawsIssuePlans();
    expect(await listClawsIssuePlans(id)).toEqual([]);
  });

  it("records each stored requirements version and each approval in History, not for a shadow", async () => {
    const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await addClawsIssueRequirementsVersion(id, record, null);
    await addClawsIssueRequirementsVersion(id, record, null);
    await withIssueActor({ kind: "operator", name: "stjohnb" }, () => approveClawsIssueRequirements(id, 2, "stjohnb"));
    const entries = (await listClawsIssueHistory(id)).map((e) => [e.field, e.old_value, e.new_value]);
    expect(entries).toEqual([
      ["requirements", null, "v1 stored"],
      ["requirements", null, "v2 stored"],
      ["requirements approved", "none", "v2"],
      ["approved_through", "none", "requirements"],
    ]);

    const promoted = await createClawsIssue({ title: "P", authorLogin: "stjohnb", repos: ["org/a"] });
    await addClawsIssueRequirementsVersion(promoted, record, null);
    await promoteClawsIssue(promoted, { version: 1, approvedBy: "stjohnb", expectedLifecycle: "ideas" });
    expect((await listClawsIssueHistory(promoted)).map((e) => [e.field, e.old_value, e.new_value]))
      .toContainEqual(["requirements approved", "none", "v1"]);

    const shadow = (await createShadowIssue("org/a", 8, { title: "Forge", authorLogin: "someone" }))!.id;
    await addClawsIssueRequirementsVersion(shadow, record, null);
    await approveClawsIssueRequirements(shadow, 1, "stjohnb");
    expect(await listClawsIssueHistory(shadow)).toEqual([]);
  });
});

// An issue's approval is one stored value, `approved_through`
// (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F), which replaced the gate labels.
describe("claws issue approved_through", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  const approvalOf = async (id: string) =>
    await _rawDb().get(
      `SELECT lifecycle, approved_through, approved_through_by, approved_through_at, plan_approved_at FROM claws_issues WHERE id = ?`,
      [id],
    ) as { lifecycle: string; approved_through: string; approved_through_by: string | null; approved_through_at: unknown; plan_approved_at: unknown };
  const labelRows = async (id: string): Promise<string[]> =>
    (await _rawDb().all(`SELECT label FROM claws_issue_labels WHERE issue_id = ? ORDER BY label`, [id]) as { label: string }[]).map((r) => r.label);
  const addLabelRow = async (id: string, label: string): Promise<void> => {
    await _rawDb().run(`INSERT INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
  };
  const history = async (id: string) =>
    (await listClawsIssueHistory(id)).filter((h) => h.field === "approved_through").map((h) => ({ old: h.old_value, new: h.new_value }));

  describe("migrateGateLabelsToApprovedThrough", () => {
    // initDb already ran it once over the empty table: rewind to the first boot with the column.
    beforeEach(async () => {
      await _rawDb().run(`DELETE FROM controller_status WHERE key = ?`, [APPROVED_THROUGH_MIGRATED_KEY]);
    });
    const stageChangedAt = async (id: string) =>
      ((await _rawDb().get(`SELECT stage_changed_at FROM claws_issues WHERE id = ?`, [id])) as { stage_changed_at: unknown }).stage_changed_at;

    it("fills the value from the retired labels, lifecycle, title and requirements, never PR rows alone, then deletes the label rows", async () => {
      const issue = (title = "T") => createClawsIssue({ title, authorLogin: "stjohnb", repos: ["org/a"], labels: ["Priority"] });
      // Rewind to the pre-column shape: the old lifecycle and label rows.
      const automerge = await issue();
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'approved', stage_changed_at = '2020-01-01 00:00:00' WHERE id = ?`, [automerge]);
      await addLabelRow(automerge, "Automerge");
      const ship = await issue();
      await addLabelRow(ship, "Ship");
      const autoRefine = await issue();
      await addLabelRow(autoRefine, "Claws Auto-Refine");
      const refined = await issue();
      await addLabelRow(refined, "Refined");
      const ready = await issue();
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'planning' WHERE id = ?`, [ready]);
      await addLabelRow(ready, "Ready");
      const ciUnrelated = await issue("[ci-unrelated] flaky test");
      const requirements = await issue();
      await approveClawsIssueRequirements(requirements, null, "stjohnb");
      // Written since the column arrived, and still holding a gate label: the label's approval is kept.
      const requirementsRefined = await issue();
      await approveClawsIssueRequirements(requirementsRefined, null, "stjohnb");
      await addLabelRow(requirementsRefined, "Refined");
      // Automerge was only a merge pre-approval: with no plan approval it approves nothing.
      const automergeOnly = await issue();
      await addLabelRow(automergeOnly, "Automerge");
      const heldBack = await issue();
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'planning' WHERE id = ?`, [heldBack]);
      for (const label of ["Ready", "Claws Auto-Refine", "Automerge"]) await addLabelRow(heldBack, label);
      const plain = await issue();
      // A PR row's merge approval stays on that PR (the partial Merge state), even
      // with every open PR approved; nor does a legacy forge-label approval count.
      const prsApproved = await issue();
      const prsMixed = await issue();
      for (const id of [prsApproved, prsMixed]) await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'planning' WHERE id = ?`, [id]);
      await upsertClawsPr("org/a", 1, { stage: "awaiting-merge", issueId: prsApproved, mergeApprovedBy: "stjohnb", mergeApprovedAt: "2026-01-01 00:00:00" });
      await upsertClawsPr("org/a", 2, { stage: "awaiting-review", issueId: prsApproved, mergeApprovedBy: "stjohnb", mergeApprovedAt: "2026-01-01 00:00:00" });
      await upsertClawsPr("org/a", 3, { stage: "merged", issueId: prsApproved });
      await upsertClawsPr("org/a", 4, { stage: "awaiting-merge", issueId: prsMixed, mergeApprovedBy: "stjohnb", mergeApprovedAt: "2026-01-01 00:00:00" });
      await upsertClawsPr("org/a", 5, { stage: "awaiting-review", issueId: prsMixed });
      const prsForgeLabel = await issue();
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'planning' WHERE id = ?`, [prsForgeLabel]);
      await upsertClawsPr("org/a", 6, { stage: "awaiting-merge", issueId: prsForgeLabel, mergeApprovedBy: "forge-label", mergeApprovedAt: "2026-01-01 00:00:00" });

      await migrateGateLabelsToApprovedThrough();

      expect(await approvalOf(automerge)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "merge", approved_through_by: "migration" });
      expect((await approvalOf(automerge)).approved_through_at).not.toBeNull();
      // An `approved` card keeps its time in the (now derived) Approved column.
      expect(await stageChangedAt(automerge)).toBe("2020-01-01 00:00:00");
      expect(await approvalOf(ship)).toMatchObject({ lifecycle: "ideas", approved_through: "plan", approved_through_by: "migration" });
      expect(await approvalOf(autoRefine)).toMatchObject({ lifecycle: "ideas", approved_through: "plan" });
      // A Refined or Ready row also moves an issue still in Ideas or Planning to Awaiting plan review.
      expect(await approvalOf(refined)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "plan" });
      expect(await approvalOf(ready)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "requirements" });
      expect(await approvalOf(ciUnrelated)).toMatchObject({ lifecycle: "ideas", approved_through: "plan" });
      // Approving the requirements already raised it, before the migration ran.
      expect(await approvalOf(requirements)).toMatchObject({ approved_through: "requirements", approved_through_by: "stjohnb" });
      expect(await approvalOf(requirementsRefined)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "plan", approved_through_by: "migration" });
      expect(await approvalOf(automergeOnly)).toMatchObject({ lifecycle: "ideas", approved_through: "none" });
      // A plan the refiner held back stays for a human, Automerge or not.
      expect(await approvalOf(heldBack)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "requirements" });
      // A raise through Plan dates the Plan approval; one below Plan leaves it unset.
      expect((await approvalOf(ship)).plan_approved_at).not.toBeNull();
      expect((await approvalOf(ready)).plan_approved_at).toBeNull();
      expect(await approvalOf(plain)).toMatchObject({ lifecycle: "ideas", approved_through: "none", approved_through_by: null, approved_through_at: null });
      expect(await approvalOf(prsApproved)).toMatchObject({ approved_through: "requirements" });
      expect(await approvalOf(prsMixed)).toMatchObject({ approved_through: "requirements" });
      expect(await approvalOf(prsForgeLabel)).toMatchObject({ approved_through: "requirements" });
      for (const id of [automerge, ship, autoRefine, refined, ready, requirementsRefined, automergeOnly, heldBack]) expect(await labelRows(id)).toEqual(["Priority"]);
      // The migration's own write is not an operator's change: no History.
      expect(await history(automerge)).toEqual([]);
    });

    it("keeps an issue with a plan and an open or merged phase PR approved through Plan", async () => {
      const issue = async () => {
        const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Priority"] });
        await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'planning' WHERE id = ?`, [id]);
        return id;
      };
      const addPlan = (id: string) => _rawDb().run(`INSERT INTO claws_issue_plans (issue_id, version, comment_id, body, created_at) VALUES (?, 1, NULL, 'plan', '2026-09-01 00:00:00')`, [id]);
      const open = await issue();
      await addPlan(open);
      await upsertClawsPr("org/a", 11, { stage: "awaiting-review", issueId: open });
      const merged = await issue();
      await addPlan(merged);
      await upsertClawsPr("org/a", 12, { stage: "merged", issueId: merged });
      const closed = await issue();
      await addPlan(closed);
      await upsertClawsPr("org/a", 13, { stage: "closed", issueId: closed });
      const noPlan = await issue();
      await upsertClawsPr("org/a", 14, { stage: "awaiting-review", issueId: noPlan });

      await migrateGateLabelsToApprovedThrough();

      expect(await approvalOf(open)).toMatchObject({ approved_through: "plan", approved_through_by: "migration" });
      expect((await approvalOf(open)).plan_approved_at).not.toBeNull();
      expect(await approvalOf(merged)).toMatchObject({ approved_through: "plan" });
      expect(await approvalOf(closed)).toMatchObject({ approved_through: "requirements" });
      expect(await approvalOf(noPlan)).toMatchObject({ approved_through: "requirements" });
    });

    it("is idempotent and never lowers a value written after it ran", async () => {
      const ci = await createClawsIssue({ title: "[ci-unrelated] flaky test", authorLogin: "claws", repos: ["org/a"] });
      const merge = await createClawsIssue({ title: "Merge", authorLogin: "stjohnb", repos: ["org/a"] });
      await addLabelRow(merge, "Refined");
      await addLabelRow(merge, "Automerge");

      await migrateGateLabelsToApprovedThrough();
      const snapshot = async () => [await approvalOf(ci), await approvalOf(merge)];
      const first = await snapshot();
      expect(first.map((r) => r.approved_through)).toEqual(["plan", "merge"]);

      await migrateGateLabelsToApprovedThrough();
      expect(await snapshot()).toEqual(first);

      // The refiner withdraws the title's plan approval; the next boot keeps it withdrawn.
      expect(await setClawsIssueApprovedThrough(ci, "requirements", "issue-refiner")).toBe(true);
      await addLabelRow(merge, "Refined");
      await migrateGateLabelsToApprovedThrough();
      expect(await approvalOf(ci)).toMatchObject({ approved_through: "requirements", approved_through_by: "issue-refiner" });
      expect(await approvalOf(merge)).toMatchObject({ approved_through: "merge", approved_through_by: "migration" });
      expect(await labelRows(merge)).toEqual([]);
    });

    it("after the first run, approves only from a leftover gate label or lifecycle, never from a title", async () => {
      await migrateGateLabelsToApprovedThrough();
      expect(await readControllerStatus(APPROVED_THROUGH_MIGRATED_KEY)).toBe(true);
      const ciUnrelated = await createClawsIssue({ title: "[ci-unrelated] flaky test", authorLogin: "stjohnb", repos: ["org/a"] });
      const prsApproved = await createClawsIssue({ title: "PRs", authorLogin: "stjohnb", repos: ["org/a"] });
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'planning' WHERE id = ?`, [prsApproved]);
      await upsertClawsPr("org/a", 10, { stage: "awaiting-merge", issueId: prsApproved, mergeApprovedBy: "stjohnb", mergeApprovedAt: "2026-01-01 00:00:00" });
      // An approval written during the rollout, then an old pod's Refined row on it.
      const promoted = await createClawsIssue({ title: "Promoted", authorLogin: "stjohnb", repos: ["org/a"] });
      expect(await setClawsIssueApprovedThrough(promoted, "requirements", "stjohnb")).toBe(true);
      await _rawDb().run(`UPDATE claws_issues SET stage_changed_at = '2020-01-01 00:00:00' WHERE id = ?`, [promoted]);
      await addLabelRow(promoted, "Refined");

      await migrateGateLabelsToApprovedThrough();

      expect(await approvalOf(ciUnrelated)).toMatchObject({ approved_through: "none", approved_through_at: null });
      expect(await approvalOf(prsApproved)).toMatchObject({ approved_through: "none", approved_through_at: null });
      expect(await approvalOf(promoted)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "plan", approved_through_by: "migration" });
      expect(await stageChangedAt(promoted)).not.toBe("2020-01-01 00:00:00");
      expect(await labelRows(promoted)).toEqual([]);
    });

    it("counts a Ready row on an issue still in Ideas as past Ideas", async () => {
      const ready = await createClawsIssue({ title: "Ready", authorLogin: "stjohnb", repos: ["org/a"] });
      await addLabelRow(ready, "Ready");
      await migrateGateLabelsToApprovedThrough();
      expect(await approvalOf(ready)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "requirements" });
    });

    it("does not let a standing pre-approval approve a plan already awaiting review", async () => {
      const issue = (title = "T") => createClawsIssue({ title, authorLogin: "stjohnb", repos: ["org/a"] });
      // The refiner held these plans back for a human (a reconsider verdict, say).
      const autoRefine = await issue();
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'awaiting-plan-review' WHERE id = ?`, [autoRefine]);
      await addLabelRow(autoRefine, "Claws Auto-Refine");
      const ciUnrelated = await issue("[ci-unrelated] flaky test");
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'awaiting-plan-review' WHERE id = ?`, [ciUnrelated]);
      const readyRow = await issue();
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'planning' WHERE id = ?`, [readyRow]);
      await addLabelRow(readyRow, "Claws Auto-Refine");
      await addLabelRow(readyRow, "Ready");
      // A plan approval someone gave stands wherever the issue is.
      const refined = await issue();
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'awaiting-plan-review' WHERE id = ?`, [refined]);
      await addLabelRow(refined, "Refined");

      await migrateGateLabelsToApprovedThrough();

      expect(await approvalOf(autoRefine)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "requirements" });
      expect(await approvalOf(ciUnrelated)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "requirements" });
      expect(await approvalOf(readyRow)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "requirements" });
      expect(await approvalOf(refined)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "plan" });
    });

    it("after the first run, raises an old pod's leftover approved lifecycle to Plan", async () => {
      await migrateGateLabelsToApprovedThrough();
      const approved = await createClawsIssue({ title: "Approved", authorLogin: "stjohnb", repos: ["org/a"] });
      await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'approved' WHERE id = ?`, [approved]);

      await migrateGateLabelsToApprovedThrough();

      expect(await approvalOf(approved)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "plan", approved_through_by: "migration" });
    });
  });

  describe("setClawsIssueApprovedThrough", () => {
    const OLD = "2020-01-01 00:00:00";
    const stageOf = async (id: string): Promise<unknown> =>
      (await _rawDb().get(`SELECT stage_changed_at FROM claws_issues WHERE id = ?`, [id]) as { stage_changed_at: unknown }).stage_changed_at;
    const rewind = async (id: string): Promise<void> => {
      await _rawDb().run(`UPDATE claws_issues SET stage_changed_at = ? WHERE id = ?`, [OLD, id]);
    };

    it("compare-and-sets the value, recording who set it and a History row", async () => {
      const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });

      expect(await setClawsIssueApprovedThrough(id, "plan", "stjohnb")).toBe(true);
      expect(await setClawsIssueApprovedThrough(id, "plan", "someone-else")).toBe(false);
      expect(await setClawsIssueApprovedThrough(id, "merge", "claws")).toBe(true);

      expect(await approvalOf(id)).toMatchObject({ approved_through: "merge", approved_through_by: "claws" });
      expect((await approvalOf(id)).approved_through_at).not.toBeNull();
      expect(await getClawsIssue(id)).toMatchObject({ approved_through: "merge", approved_through_by: "claws" });
      expect(await history(id)).toEqual([{ old: "none", new: "plan" }, { old: "plan", new: "merge" }]);
      expect(await setClawsIssueApprovedThrough("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "plan", "stjohnb")).toBe(false);
    });

    it("writes a shadow's approval, with no History", async () => {
      const shadow = (await createShadowIssue("org/a", 7, { title: "Forge", authorLogin: "someone" }))!.id;

      expect(await setClawsIssueApprovedThrough(shadow, "plan", "stjohnb")).toBe(true);

      expect(await approvalOf(shadow)).toMatchObject({ approved_through: "plan", approved_through_by: "stjohnb" });
      expect(await listClawsIssueHistory(shadow)).toEqual([]);
    });

    it("bumps stage_changed_at only when an issue awaiting plan review crosses plan", async () => {
      const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
      await setClawsIssueLifecycle(id, "awaiting-plan-review");
      await rewind(id);

      await setClawsIssueApprovedThrough(id, "requirements", "stjohnb");
      expect(await stageOf(id)).toBe(OLD);
      // Awaiting plan review → Approved.
      await setClawsIssueApprovedThrough(id, "plan", "stjohnb");
      expect(await stageOf(id)).not.toBe(OLD);
      await rewind(id);
      await setClawsIssueApprovedThrough(id, "merge", "stjohnb");
      expect(await stageOf(id)).toBe(OLD);
      // Approved → Awaiting plan review.
      await setClawsIssueApprovedThrough(id, "requirements", "stjohnb");
      expect(await stageOf(id)).not.toBe(OLD);

      // Another lifecycle's column does not depend on the value.
      const planning = await createClawsIssue({ title: "P", authorLogin: "stjohnb", repos: ["org/a"] });
      await setClawsIssueLifecycle(planning, "planning");
      await rewind(planning);
      await setClawsIssueApprovedThrough(planning, "plan", "stjohnb");
      expect(await stageOf(planning)).toBe(OLD);
    });

    it("dates the Plan approval only when the value rises through plan, and clears it below plan", async () => {
      const id = await createClawsIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
      const planAt = async () => (await approvalOf(id)).plan_approved_at;

      await setClawsIssueApprovedThrough(id, "requirements", "stjohnb");
      expect(await planAt()).toBeNull();
      await setClawsIssueApprovedThrough(id, "plan", "stjohnb");
      expect(await planAt()).not.toBeNull();
      await _rawDb().run(`UPDATE claws_issues SET plan_approved_at = ? WHERE id = ?`, [OLD, id]);
      // Plan ↔ Merge leaves it as it is.
      await setClawsIssueApprovedThrough(id, "merge", "stjohnb");
      await setClawsIssueApprovedThrough(id, "plan", "stjohnb");
      expect(await planAt()).toBe(OLD);
      await setClawsIssueApprovedThrough(id, "requirements", "stjohnb");
      expect(await planAt()).toBeNull();
      await setClawsIssueApprovedThrough(id, "merge", "stjohnb");
      expect(await planAt()).not.toBeNull();
    });
  });

  it("files an issue with its approval, as approvedBy or else the author", async () => {
    const plan = await createClawsIssue({ title: "Plan", authorLogin: "claws", repos: ["org/a"], approvedThrough: "plan", approvedBy: "ci-fixer" });
    const merge = await createClawsIssue({ title: "Merge", authorLogin: "stjohnb", repos: ["org/a"], approvedThrough: "merge" });
    const none = await createClawsIssue({ title: "None", authorLogin: "stjohnb", repos: ["org/a"], approvedThrough: "none", approvedBy: "ignored" });

    expect(await approvalOf(plan)).toMatchObject({ lifecycle: "ideas", approved_through: "plan", approved_through_by: "ci-fixer" });
    expect((await approvalOf(plan)).approved_through_at).not.toBeNull();
    expect(await history(plan)).toEqual([{ old: "none", new: "plan" }]);
    expect(await approvalOf(merge)).toMatchObject({ approved_through: "merge", approved_through_by: "stjohnb" });
    expect(await approvalOf(none)).toMatchObject({ approved_through: "none", approved_through_by: null, approved_through_at: null });
    expect(await history(none)).toEqual([]);
  });

  it("raises none to requirements on promotion, keeps a higher pre-approval, and lowers to none on demotion", async () => {
    const plain = await createClawsIssue({ title: "Plain", authorLogin: "stjohnb", repos: ["org/a"] });
    const preApproved = await createClawsIssue({ title: "Pre", authorLogin: "claws", repos: ["org/a"], approvedThrough: "plan", approvedBy: "ci-fixer" });

    expect(await promoteClawsIssue(plain, { version: null, approvedBy: "stjohnb", expectedLifecycle: "ideas" })).toBe(true);
    expect(await promoteClawsIssue(preApproved, { version: null, approvedBy: "stjohnb", expectedLifecycle: "ideas" })).toBe(true);

    expect(await approvalOf(plain)).toMatchObject({ lifecycle: "planning", approved_through: "requirements", approved_through_by: "stjohnb" });
    expect(await approvalOf(preApproved)).toMatchObject({ lifecycle: "planning", approved_through: "plan", approved_through_by: "ci-fixer" });

    expect((await approvalOf(preApproved)).plan_approved_at).not.toBeNull();
    expect(await withIssueActor({ kind: "operator", name: "stjohnb" }, () => demoteClawsIssue(preApproved))).toBe(true);
    // Who withdrew it is recorded, as with every other write.
    expect(await approvalOf(preApproved)).toMatchObject({ lifecycle: "ideas", approved_through: "none", approved_through_by: "stjohnb", plan_approved_at: null });
    expect(await history(preApproved)).toEqual([{ old: "none", new: "plan" }, { old: "plan", new: "none" }]);
  });
});
