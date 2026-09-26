import * as db from "../db-remote.js";
import { SESSION_POD_SETTINGS, WORK_DIR } from "../config.js";
import { internalMcpTokenPath, readMcpTokenFile } from "../internal-mcp-token.js";
import { loadImportedRefs } from "../imported-refs.js";
import * as log from "../log.js";
import { setShuttingDown } from "../shutdown.js";
import { cancelCurrentTask, retuneAgentMemoryGate } from "../claude.js";
import { registerAll as registerWorkHandlers } from "../work-handlers.js";
import * as worker from "../worker.js";
import { startPlannerRunListener, type PlannerRunListener } from "../planner-run-listener.js";

// The service half of the agent pod runtime, loaded by `agent-pod/main.ts`
// only after it has written `~/.claws/config.json`. Boots the same modules the
// service does for a worker fiber and runs one claimed row through the
// unchanged `worker.runRow()`. The pod holds no database credentials: every
// `db.js` import resolves to `db-remote.js` (`main.ts`'s resolve hook), which
// writes the row's result, tasks, job logs and tokens through the service's
// enumerated agent-pod ops API with the row's per-run token. The service
// launched this pod and finalises the row only if the pod dies first.
//
// A planner run (issue-refiner) registers itself in this process's memory, so
// the planner MCP tools must post their submissions here, not to the service:
// before running the row this process starts the loopback planner-run listener
// (`planner-run-listener.ts`) and publishes its URL as
// `CLAWS_PLANNER_RUN_BASE_URL` for `claude.ts`'s MCP config writer
// (#clw_01M3A42ZTGECAB11S0BZA6NG1A).
//
// Claude memories written in the pod's emptyDir HOME are not backed up:
// `claude-memory-backup` replaces each project's directory on the branch with
// the local set, and a pod's HOME holds only this run's files.

/** The `job_runs` status matching a finished row's status, or null while it is still running. */
export function jobRunStatusFor(status: string): "completed" | "failed" | "cancelled" | null {
  switch (status) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: return null;
  }
}

/**
 * Complete the row's `job_runs` run, which the service opened when it claimed
 * the row: `runRow` completes only a run it opened itself. A row left
 * 'running' (interrupted by shutdown) is left for the service's launcher.
 */
export async function finishJobRun(rowId: number, runId: string): Promise<void> {
  try {
    const row = await db.getWorkRow(rowId);
    const status = row ? jobRunStatusFor(row.status) : null;
    if (!status) return;
    await db.completeJobRun(runId, status);
  } catch (err) {
    log.warn(`[agent-pod] Could not complete run ${runId}: ${err}`);
  }
}

let plannerListener: PlannerRunListener | null = null;

/** Run work row `rowId` claimed under `runId`, then exit the process. */
export async function runWorkRow(rowId: number, runId: string): Promise<never> {
  const token = readMcpTokenFile(internalMcpTokenPath(WORK_DIR), "");
  db.configureRemoteDb({
    baseUrl: SESSION_POD_SETTINGS.mcpUrl,
    token,
    rowId,
    runId,
  });
  try {
    let row: db.WorkQueueRow | undefined;
    try {
      row = await db.getWorkRow(rowId);
    } catch (err) {
      if (!(err instanceof db.AgentPodOpUnauthorizedError)) throw err;
      // The service already ended or re-queued the row, which revoked this pod's token.
      log.warn(`[agent-pod] Work row ${rowId} no longer accepts this pod's token — exiting without running it`);
      return await exitAfterClose(0);
    }
    // A re-queued or stale launch must not run the row a second time.
    if (!row || row.status !== "running" || row.run_id !== runId) {
      log.warn(`[agent-pod] Work row ${rowId} is ${row ? `${row.status} under run ${row.run_id}` : "missing"}, not running under run ${runId} — exiting without running it`);
      return await exitAfterClose(0);
    }

    await loadImportedRefs();
    retuneAgentMemoryGate();
    registerWorkHandlers();

    // Before runRow, because writeClawsMcpConfig reads the variable when the
    // refiner writes each planner invocation's MCP config. Any row kind may
    // run here; for one that opens no planner run the listener just idles.
    plannerListener = await startPlannerRunListener({ token });
    process.env["CLAWS_PLANNER_RUN_BASE_URL"] = plannerListener.baseUrl;

    // The service's launcher finalises a row whose pod is killed; leave it
    // 'running' (runRow does, while shutting down) and stop the agent quickly.
    const onSignal = (signal: string) => {
      log.info(`[agent-pod] ${signal} received — cancelling the agent`);
      setShuttingDown();
      cancelCurrentTask();
    };
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGINT", () => onSignal("SIGINT"));

    await worker.runRow(0, row);
    await finishJobRun(rowId, runId);
  } catch (err) {
    // Boot (the ops API, imported refs, handlers) or runRow itself threw: flush the job logs first.
    log.error(`[agent-pod] Failed to run work row ${rowId}`, err);
    return await exitAfterClose(1);
  }
  return await exitAfterClose(0);
}

/** Close the planner-run listener, flush buffered job logs to the service, then exit with `code`. */
async function exitAfterClose(code: number): Promise<never> {
  if (plannerListener) {
    try {
      await plannerListener.close();
    } catch (err) {
      log.warn(`[agent-pod] Closing the planner-run listener failed: ${err}`);
    }
    plannerListener = null;
  }
  try {
    await db.closeDb();
  } catch (err) {
    log.warn(`[agent-pod] Flushing job logs failed: ${err}`);
  }
  process.exit(code);
}
