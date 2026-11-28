import { createSqliteDriver, type SqlDriver } from "./db-driver.js";
import { createPgDriver, createPgLiteDriver } from "./db-driver-pg.js";
import { DB_PATH, DATABASE_URL, DATABASE_PASSWORD } from "./config.js";
import { setConfigStoreDriver } from "./config-store.js";
import * as log from "./log.js";
import { flushGitHubEvents, setGitHubEventsDriver } from "./github-events.js";
import { setGateEventsDriver } from "./gate-events.js";
import { describeDatabaseTarget, driver, setDriver, timedDb } from "./db/core.js";
import { migrateSchema, SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "./db/schema.js";
import { migrateRenamedNodes, migrateRetiredCapabilities } from "./db/migrations.js";
import { flushJobLogs, resetJobLogBuffer, startJobLogDrain, stopJobLogDrain } from "./db/job-logs.js";
import { readControllerStatus, writeControllerStatus } from "./db/usage.js";
export * from "./db/sessions.js";
export * from "./db/session-moves.js";
export * from "./db/session-grants.js";
export * from "./db/misc.js";
export * from "./db/imported-issues.js";
export * from "./db/contracts.js";

// The database façade: every importer reaches SQL through this module, and
// the code lives in src/db/<domain>.ts. Names listed here (rather than
// `export *`) keep each module's shared-but-private helpers off the façade.
export { dbPoolStats, describeDatabaseTarget, describePostgresTarget } from "./db/core.js";
export { SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "./db/schema.js";
export * from "./db/migrations.js";
export * from "./db/tasks.js";
export * from "./db/providers.js";
export * from "./db/pr-reviews.js";
export * from "./db/work-queue.js";
export {
  JOB_LOG_MAX_MESSAGE_CHARS, JOB_LOG_PRUNE_MESSAGE_BYTES, type JobLog, type JobLogRowInput, type JobRun, cancelJobRunIfRunning, capJobLogMessage, completeJobRun, flushJobLogs, getJobRun, getJobRunLogs, getJobRunLogsSince, getLatestRunIdsByJob, getLogsForRuns, getRunsForIssue, getTasksByRunId, getWorkItemsForRuns, insertJobLog, insertJobLogRows, insertJobRun, pruneOldLogs, pruneTasks,
} from "./db/job-logs.js";
export * from "./db/ci-fixer.js";
export {
  type AgentEventMetric, type AgentEventTotal, type AgentTaskOutcomeTotal, type AgentUsageTotal, type ControllerCommandRow, type MainBuildFailureRow, type MainBuildRunRow, type SessionUsageWarningLevel, type UsageFilterOptions, type UsageFilters, type UsageItem, type UsageTotals, type WorkflowRunRow, claimControllerCommands, completeControllerCommand, deleteWorkflowRun, getActiveProviderHolds, getActiveWorkflowRuns, getAgentEventTotals, getAgentTaskOutcomeTotals, getAgentUsageTotals, getControllerCommand, getDailyTaskStats, getDefaultBranchRuns, getExpiredMainBuildRetries, getJobLastRuns, getOpenClawsPrCountsByStage, getPendingMainBuildRetries, getQueueSnapshots, getRecentEffectivenessEvents, getRecentTasksForRepo, getRunningTaskCountsByJob, getTotalUsage, getUnreportedMainBuildFailures, getUsageFilterOptions, getUsageItems, getWorkQueueCounts, getWorkflowRunCount, hasMainBuildFailure, hasRecentlyCompletedTasks, hasUnclosedReportedFailure, insertControllerCommand, markMainBuildFailuresClosed, markMainBuildReported, pruneClawsEvents, pruneControllerCommands, pruneMainBuildFailures, pruneQueueSnapshots, pruneWorkflowRuns, readControllerStatus, recordItemRemovedFromQueue, recordMainBuildFailure, recordQueueSnapshot, setMainBuildRetryOutcome, upsertWorkflowRuns, usageWarningLevel, writeControllerStatus,
} from "./db/usage.js";
export {
  type ClawsIssueCommentRow, type ClawsIssueHistoryRow, type ClawsIssueReactionRow, type ClawsIssueRecord, type ClawsIssueRow, type IssueSource, BlockedReasonRequiredError, ENTRY_LIFECYCLE_SQL, HUMAN_ISSUE_SOURCES, ISSUE_SOURCES, addClawsIssueDedupeKey, addClawsIssueLabel, blockClawsIssue, claimClawsIssueOutageNotice, clawsIssueExists, createClawsIssue, demoteClawsIssue, findOpenImportedIssueByTitle, findOpenUnkeyedIssueByFiledTitle, getClawsIssue, listClawsIssueHistory, listClawsIssues, listClosedClawsIssuesByDedupeKey, listClosedClawsIssuesSince, listDuplicateMarkerBodies, listIssueIdsWithPlans, listNotPlannedClawsIssuesByDedupeKey, listOpenClawsAlerts, listOpenClawsIssues, listOpenClawsIssuesByDedupeKey, moveClawsIssueDedupeKeys, primaryRepoOf, promoteClawsIssue, removeClawsIssueLabel, replaceClawsIssueDedupeKey, setClawsIssueAlertKind, setClawsIssueApprovedThrough, setClawsIssueDedupeKey, setClawsIssueLifecycle, setClawsIssuePrimaryRepo, setClawsIssueRepos, setClawsIssueState, setShadowLifecycle, updateClawsIssueBody, updateClawsIssueTitle,
} from "./db/issues.js";
export {
  type ClawsIssueApprovedRequirementsRow, type ClawsIssuePlanRow, type ClawsIssueRequirementsRow, addClawsIssueComment, addClawsIssueCommentReaction, addClawsIssueRequirementsVersion, approveClawsIssueRequirements, backfillClawsIssuePlans, editClawsIssueComment, listApprovedClawsIssueRequirementsForOpenIssues, listClawsIssueCommentReactions, listClawsIssueComments, listClawsIssueCommentsForOpenIdeasIssues, listClawsIssuePlans, listClawsIssueRequirements, listHeldStageOffOpenIdeasIssueIds, listLatestClawsIssuePlansForOpenIssues, listLatestClawsIssueRequirementsForOpenIssues, setRequirementsVersionListener, softDeleteClawsIssueComments,
} from "./db/issue-comments.js";
export * from "./db/issue-files.js";
export * from "./db/issue-links.js";
export * from "./db/issue-plans.js";
export * from "./db/prs.js";
export * from "./db/delivery-stats.js";

/** Picks the backend from the environment — never from `isContainer()`, so a
 *  container without CLAWS_DATABASE_URL still runs on its own SQLite file. */
async function openDriver(): Promise<SqlDriver> {
  const target = describeDatabaseTarget();
  log.info(`Database backend: ${target}`);
  if (DATABASE_URL) return createPgDriver({ url: DATABASE_URL, password: DATABASE_PASSWORD });
  if (process.env["CLAWS_TEST_PGLITE"] === "1") return await createPgLiteDriver();
  return createSqliteDriver(DB_PATH);
}

/**
 * Opens the database and starts the job-log drain. With `migrate` (the
 * default) it also runs every migration and records {@link SCHEMA_VERSION};
 * only the controller (`CLAWS_ROLE` `controller` or `all`) does that, so the
 * web tier passes `{ migrate: false }`.
 */
export async function initDb(opts: { migrate?: boolean } = {}): Promise<void> {
  const driver = await openDriver();
  setDriver(driver);
  resetJobLogBuffer();
  startJobLogDrain();
  // Operator config (src/config-store.ts); writeConfig publishes through this connection.
  setConfigStoreDriver(driver);
  // Claws-originated change events (src/github-events.ts), read by every
  // process's /api/events long-polls.
  setGitHubEventsDriver(driver);
  // Gate transitions (src/gate-events.ts) behind the derived wait events.
  setGateEventsDriver(driver);
  if (opts.migrate === false) {
    log.info("Database opened (migrations are the controller's)");
    return;
  }
  await timedDb("migrate-schema", migrateSchema);
  // Data only, after every table it touches exists; outside migrateSchema so
  // it needs no SCHEMA_VERSION bump.
  await migrateRetiredCapabilities();
  // Stored node names follow CLAWS_NODE_ALIASES (#clw_01M7RBFFEM2C6DQD1C3Z3EAEZ8).
  await migrateRenamedNodes();
  await recordSchemaVersion();
  log.info("Database initialized");
}

/**
 * Records {@link SCHEMA_VERSION}, never lowering it: a rolled-back controller
 * leaves the newer schema's additive changes in place, so the higher version
 * still describes the database.
 */
async function recordSchemaVersion(): Promise<void> {
  const recorded = await readSchemaVersion();
  if (recorded !== null && recorded >= SCHEMA_VERSION) return;
  await writeControllerStatus(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
}

/**
 * The schema version the controller last recorded, or null when it never has
 * (or `controller_status` does not exist yet, before the first migration).
 */
export async function readSchemaVersion(): Promise<number | null> {
  try {
    const value = await readControllerStatus<unknown>(SCHEMA_VERSION_KEY);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function closeDb(): Promise<void> {
  stopJobLogDrain();
  if (driver) {
    await flushJobLogs();
    await flushGitHubEvents();
    const closing = driver;
    setDriver(null);
    setConfigStoreDriver(null);
    setGitHubEventsDriver(null);
    setGateEventsDriver(null);
    await closing.close();
    log.info("Database closed");
  }
}
