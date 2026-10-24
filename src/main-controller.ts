import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { INTERVALS, SCHEDULES, LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB, WORK_DIR, WHATSAPP_ENABLED, onConfigChange, isActive, getUnknownConfigKeys, SMART_SCHEDULING } from "./config.js";
import * as config from "./config.js";
import * as log from "./log.js";
import { formatMs } from "./format.js";
import * as gh from "./github.js";
import { startJobs, type Job } from "./scheduler.js";
import { canRunJobForActivation, selectStartupJobs, shouldStartWorkersForActivation } from "./startup-mode.js";
import { createServer, warmDashboardCaches } from "./server.js";
import { liveControllerClient } from "./controller-client.js";
import { publishControllerShuttingDown, startControllerPublisher } from "./controller-publisher.js";
import { initDb, stampTasksWithRunContext, getOrphanedTasks, recordTaskFailed, pruneOldLogs, pruneQueueSnapshots, pruneWorkflowRuns, pruneMainBuildFailures, pruneProcessedReposDailyOlderThan, recordQueueSnapshot, recoverWorkOnStartup, reapStaleRunningWork, listPodBackedRunningWork, pruneWorkQueue, pruneTasks, pruneDmarcReports, pruneClawsEvents, pruneControllerCommands, closeDb, setRequirementsVersionListener } from "./db.js";
import { onRequirementsVersionStored } from "./claws-issues.js";
import { materialiseConfig } from "./config-store.js";
import { startConfigWatcher, stopConfigWatcher } from "./config-watch.js";
import { migrateFsAttachmentsToS3 } from "./issue-attachments.js";
import { loadImportedRefs } from "./imported-refs.js";
import { closeRetiredShoppingTrackingIssue } from "./shopping-tracking-retirement.js";
import { loadCapabilityRequests } from "./capability-requests.js";
import * as worker from "./worker.js";
import { getAgentPodLauncher } from "./agent-pod-launcher.js";
import { registerAll as registerWorkHandlers } from "./work-handlers.js";
import * as smartSchedule from "./smart-schedule.js";
import type { Repo } from "./config.js";
import * as issueAgent from "./jobs/issue-dispatcher.js";
import * as prAgent from "./jobs/pr-dispatcher.js";
import * as autoMerger from "./agents/auto-merger.js";
import * as docMaintainer from "./jobs/doc-maintainer.js";
import * as repoStandards from "./jobs/repo-standards.js";
import * as improvementIdentifier from "./jobs/improvement-identifier.js";
import * as publicRepoScanner from "./jobs/public-repo-scanner.js";
import * as publicSnapshotSync from "./jobs/public-snapshot-sync.js";
import * as ideaSuggester from "./jobs/idea-suggester.js";
import * as issueImporter from "./jobs/issue-importer.js";
import * as triageClawsErrors from "./jobs/triage-claws-errors.js";
import * as issueShadowSync from "./jobs/issue-shadow-sync.js";
import * as issuePreviewSync from "./jobs/issue-preview-sync.js";
import * as issueAuditor from "./jobs/issue-auditor.js";
import * as runnerMonitor from "./jobs/runner-monitor.js";
import * as hostDiskMonitor from "./jobs/host-disk-monitor.js";
import * as claudeMemoryBackup from "./jobs/claude-memory-backup.js";
import * as authSecretSync from "./jobs/auth-secret-sync.js";
import * as macRunnerWaker from "./jobs/mac-runner-waker.js";
import * as scannerDispatcher from "./jobs/scanner-dispatcher.js";
import * as staleBranchCleaner from "./jobs/stale-branch-cleaner.js";
import * as emailMonitor from "./jobs/email-monitor.js";
import { resolveAllWaiters } from "./github-events.js";
import * as dependabotAlertMonitor from "./jobs/dependabot-alert-monitor.js";
import * as dependabotRunMonitor from "./jobs/dependabot-run-monitor.js";
import * as runnerMetricsSync from "./jobs/runner-metrics-sync.js";
import * as mainBuildMonitor from "./jobs/main-build-monitor.js";
import * as dependabotTofuUnblocker from "./jobs/dependabot-tofu-unblocker.js";
import * as worktreeCleaner from "./jobs/worktree-cleaner.js";
import * as dampReminder from "./jobs/damp-reminder.js";
import * as reminderMonitor from "./jobs/reminder-monitor.js";
import * as upstreamWatcher from "./jobs/upstream-watcher.js";
import * as blogDraftScanner from "./jobs/blog-draft-scanner.js";
import * as whatsapp from "./whatsapp.js";
import { createHandler as createWhatsAppHandler } from "./jobs/whatsapp-handler.js";
import { setShuttingDown } from "./shutdown.js";
import { mapWithConcurrency, sleep } from "./util.js";
import { cancelCurrentTask, pruneAgentMcpDirs, pruneAgentOutputDir, retuneAgentMemoryGate } from "./claude.js";
import { writeInternalMcpTokenFile } from "./internal-mcp-token.js";
import { resetGitHubAppState, ensureGitHubAppConfigured } from "./github-app.js";
import { reportError } from "./error-reporter.js";
import { ensureAlertIssue } from "./occurrence-tracking.js";
import { getSessionBackend } from "./session-backend.js";
import { runConnectivityVerification } from "./jobs/connectivity-verifier.js";
import { VERSION } from "./version.js";
import { markShuttingDown, recordShutdownMarker, startMetricsServer, type ShutdownMarkerPhases } from "./metrics.js";

// The background controller (CLAWS_ROLE `controller`, or `all` for one process
// doing everything), loaded by main.ts. The single instance that migrates the
// database, runs scheduler jobs, claims work, runs the WhatsApp gateway and
// the session timers, and publishes its state for the web tier
// (controller-publisher.ts). It still serves the dashboard on its own port.

// ── Single-instance file lock ──
// Prevents two claws processes from sharing the same WORK_DIR (which would
// corrupt the SQLite WAL and the worktree metadata). This
// does NOT prevent cross-host duplication (two different machines mounting
// different PVCs) — activation state is the operator-level guard for that.
const PID_FILE = path.join(WORK_DIR, "claws.pid");
try {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  if (fs.existsSync(PID_FILE)) {
    const rawPid = fs.readFileSync(PID_FILE, "utf-8").trim();
    const existingPid = parseInt(rawPid, 10);
    if (!Number.isNaN(existingPid) && existingPid > 0 && existingPid !== process.pid) {
      let alive = false;
      try {
        process.kill(existingPid, 0);
        alive = true;
      } catch (err) {
        // ESRCH → process gone; EPERM → process exists under another user, treat as alive
        alive = (err as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive) {
        await log.errorAndFlush(`Another claws instance is running (pid ${existingPid}). Exiting.`);
        process.exit(1);
      }
      log.warn(`Stale PID file at ${PID_FILE} (pid ${existingPid} not alive) — overwriting`);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
} catch (err) {
  await log.errorAndFlush(`Failed to acquire PID lock at ${PID_FILE}: ${err}`);
  process.exit(1);
}

if (config.shouldRunWorkPipeline()) {
  ensureGitHubAppConfigured();
}

if (isActive()) {
  log.info("ACTIVE MODE — all configured jobs and workers may run.");
} else if (config.isStagingPipelineEnabled()) {
  log.info(`STAGING PIPELINE MODE — only Claws Staging issue/PR pipeline jobs will run; all other jobs remain disabled.`);
} else {
  log.info("VERIFY-ONLY MODE — no jobs will run. Inspect connectivity and toggle to active in the Activation section of /config when ready.");
}

// ── Unknown config key reporting ──

const unknownConfigKeys = getUnknownConfigKeys();
if (unknownConfigKeys.length > 0) {
  const stampFile = path.join(WORK_DIR, "last-unknown-key-report");
  const COOLDOWN_MS = 24 * 60 * 60 * 1000;
  let lastReport = 0;
  try {
    lastReport = Number(fs.readFileSync(stampFile, "utf8").trim());
  } catch {
    // no stamp yet
  }
  if (Date.now() - lastReport >= COOLDOWN_MS) {
    const title = "[claws-config] Unknown keys in config.json";
    const keyList = unknownConfigKeys.map(k => `- \`${k}\``).join("\n");
    const body = [
      "**Auto-created by Claws config validator**",
      "",
      "The following keys in `~/.claws/config.json` are not recognised by Claws and will be discarded:",
      "",
      keyList,
      "",
      "Check for typos or remove keys that are no longer supported.",
    ].join("\n");
    ensureAlertIssue({ repo: config.SELF_REPO, title, body, logPrefix: "config" })
      .then(() => {
        fs.writeFileSync(stampFile, String(Date.now()));
      })
      .catch(err => {
        log.warn(`[config] Failed to report unknown config keys: ${err}`);
      });
  }
}

// ── Database init & recovery ──

await initDb();
// boot.ts materialised config before this process read it, unless a fresh
// host had no database yet (or main.js was started directly); import or
// apply the stored config now that the database is open.
if (await materialiseConfig({ createIfMissing: true })) config.reloadConfig();
startConfigWatcher(5000);
// After `initDb()`, not inside it: `imported-refs.ts` imports `db.ts`, so
// loading the index from there would close a cycle. Every consumer is sync and
// an unloaded index resolves nothing, so a boot-order slip degrades to the
// pre-import behaviour rather than mis-resolving a ref.
await loadImportedRefs();
// Move filesystem attachments into the S3 bucket once one is configured. In
// the background: a large store must not hold up boot, and every `fs` row
// keeps serving from disk until its upload lands. Never throws.
if (config.ATTACHMENTS_S3) void migrateFsAttachmentsToS3();
// One-off: close the retired [shopping] tracking issue. Never blocks boot; a
// failure only warns and the next boot retries. Delete this call and
// shopping-tracking-retirement.ts once production has booted on it.
void closeRetiredShoppingTrackingIssue().catch((err: unknown) => {
  log.warn(`[shopping-retirement] Failed to close the retired [shopping] tracking issue: ${err}`);
});
// Pending capability requests and denials survive a restart; drop the stored
// requests of sessions that ended while Claws was down.
await loadCapabilityRequests();
stampTasksWithRunContext();
// Announce every stored requirements version, then auto-promote on a first one
// (docs/refinements/issue-flow.md "Promotion"). Registered here, where every version write lands — the
// in-process writer's and, through the ops API, an agent pod's.
setRequirementsVersionListener(onRequirementsVersionStored);

const wq = await recoverWorkOnStartup();
if (wq.resetRunning > 0) {
  log.info(`Reset ${wq.resetRunning} stuck work_queue row(s) from previous process back to 'queued'`);
}
// recoverWorkOnStartup() skips pod-backed rows: their pods outlived the last
// process and the worker fibers re-attach to them. Under any other backend
// nothing does, and re-queueing would run the item twice while its pod lives.
const podBacked = await listPodBackedRunningWork();
if (podBacked.length > 0) {
  if (config.WORK_BACKEND === "k8s-pod") log.info(`Adopting ${podBacked.length} pod-backed agent run(s)`);
  else log.warn(`${podBacked.length} pod-backed agent run(s) stay 'running' with nothing watching them — CLAWS_WORK_BACKEND is ${config.WORK_BACKEND}; set it back to k8s-pod until they finish`);
}

const orphaned = await getOrphanedTasks();
if (orphaned.length > 0) {
  log.info(`Found ${orphaned.length} orphaned task(s) from previous run — recovering`);

  const affectedRepoDirs = new Set<string>();

  for (const task of orphaned) {
    log.warn(
      `Recovering orphaned task: ${task.job_name} on ${task.repo}#${task.item_number}`,
    );

    if (task.worktree_path && fs.existsSync(task.worktree_path)) {
      try {
        fs.rmSync(task.worktree_path, { recursive: true, force: true });
        log.info(`Cleaned up orphaned worktree: ${task.worktree_path}`);
      } catch {
        // best effort
      }
    }

    // Track repo dir so we can prune stale worktree metadata below
    const repoDir = path.join(WORK_DIR, "repos", ...task.repo.split("/"));
    if (fs.existsSync(path.join(repoDir, ".git"))) {
      affectedRepoDirs.add(repoDir);
    }

    await recordTaskFailed(task.id, "process restarted before completion");
  }

  // Prune stale git worktree metadata for repos whose worktrees were removed
  for (const dir of affectedRepoDirs) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "prune"], { cwd: dir }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    } catch {
      // best effort
    }
  }

  log.info(`Recovered ${orphaned.length} orphaned task(s)`);
}

// Publish this boot's MCP token where long-lived stdio MCP children can
// re-read it: the token baked into their .mcp-claws.json at spawn time is
// dead after a service restart (#2918).
try {
  writeInternalMcpTokenFile(WORK_DIR, config.INTERNAL_MCP_TOKEN);
} catch (err) {
  log.warn(`Failed to write internal MCP token file: ${err}`);
}

// ── Terminal session recovery (the session backend re-attaches surviving sessions) ──

await getSessionBackend().start();

// ── Log pruning ──
// The startup prune runs after the dashboard listens (`pruneOnStartup` below).

const pruneInterval = setInterval(() => {
  void (async () => {
    try {
      const n = await pruneOldLogs(LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB);
      if (n > 0) log.info(`Pruned ${n} old job run(s)`);
      await pruneQueueSnapshots();
      await pruneWorkflowRuns();
      await pruneMainBuildFailures();
      await pruneProcessedReposDailyOlderThan(30);
      await pruneWorkQueue();
      await pruneDmarcReports(365);
      await pruneClawsEvents(24);
      await pruneControllerCommands(7);
      const t = await pruneTasks(90);
      if (t > 0) log.info(`Pruned ${t} old task(s)`);
    } catch {
      // best effort
    }
  })();
}, 24 * 60 * 60 * 1000);

// Prune on startup too
// Crash-leftover MCP configs can carry a live HA token — clear before any agent runs.
try { pruneAgentMcpDirs(); } catch { /* best effort */ }
try { pruneAgentOutputDir(); } catch { /* best effort */ }
// The DB prunes run in `pruneOnStartup`, after the dashboard listens.

async function pruneOnStartup(): Promise<void> {
  try {
    const pruned = await pruneOldLogs(LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB);
    if (pruned > 0) log.info(`Pruned ${pruned} old job run(s) (retention: ${LOG_RETENTION_DAYS} days)`);
  } catch (err) {
    log.warn(`Startup log prune failed: ${err}`);
  }
  try { await pruneQueueSnapshots(); } catch { /* best effort */ }
  try { await pruneWorkflowRuns(); } catch { /* best effort */ }
  try { await pruneMainBuildFailures(); } catch { /* best effort */ }
  try { await pruneWorkQueue(); } catch { /* best effort */ }
  try { await pruneTasks(90); } catch { /* best effort */ }
  try { await pruneDmarcReports(365); } catch { /* best effort */ }
  try { await pruneClawsEvents(24); } catch { /* best effort */ }
  try { await pruneControllerCommands(7); } catch { /* best effort */ }
}

// ── Jobs ──

function smartScheduledJob(
  name: string,
  processRepo: (repo: Repo) => Promise<unknown>,
  opts?: { skipWeekends?: boolean; weekendPause?: boolean; ignoreBusy?: boolean },
): Job {
  return {
    name,
    intervalMs: SMART_SCHEDULING.tickIntervalMs,
    skipWeekends: opts?.skipWeekends,
    weekendPause: opts?.weekendPause,
    async run(o?: { manual?: boolean }) {
      if (!smartSchedule.shouldRunSmartJob(name, undefined, o?.manual ?? false)) return;
      const allRepos = await gh.listRepos();
      const due = await smartSchedule.selectReposForTick(name, allRepos, undefined, { ignoreBusy: opts?.ignoreBusy });
      if (due.length === 0) return;
      log.info(`[${name}] ${due.length} repo(s) due — dispatching with concurrency cap`);
      await Promise.allSettled(
        due.map((repo) =>
          smartSchedule.withSmartJobSlot(() => processRepo(repo)).catch((err) => {
            log.warn(`[${name}] processRepo failed for ${repo.fullName}: ${err}`);
          }),
        ),
      );
    },
  };
}

function smartScheduledBatchJob(
  name: string,
  runner: (repos: Repo[]) => Promise<void>,
  opts?: { skipWeekends?: boolean },
): Job {
  return {
    name,
    intervalMs: SMART_SCHEDULING.tickIntervalMs,
    skipWeekends: opts?.skipWeekends,
    async run(o?: { manual?: boolean }) {
      if (!smartSchedule.shouldRunSmartJob(name, undefined, o?.manual ?? false)) return;
      const allRepos = await gh.listRepos();
      const due = await smartSchedule.selectReposForTick(name, allRepos);
      if (due.length === 0) return;
      await smartSchedule.withSmartJobSlot(() => runner(due));
    },
  };
}

const jobs: Job[] = [
  {
    name: "issue-dispatcher",
    intervalMs: INTERVALS.issueDispatcherMs,
    triggers: ["pr-dispatcher"],
    async run() {
      const allRepos = await gh.listRepos();
      const repos = allRepos.filter(r => !config.isJobDisabledForRepo("issue-dispatcher", r.fullName));
      log.info(`Discovered ${allRepos.length} repos (${repos.length} enabled for issue-dispatcher)`);
      await issueAgent.run(repos);
    },
  },
  {
    name: "pr-dispatcher",
    intervalMs: INTERVALS.prDispatcherMs,
    triggers: ["pr-dispatcher"],
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("pr-dispatcher", r.fullName));
      await prAgent.run(repos);
    },
  },
  {
    // The merge sweep is pure GitHub API, so it runs inline on the scheduler
    // rather than as a work-queue row that waits behind long agent runs (#2971).
    name: "auto-merger",
    intervalMs: INTERVALS.autoMergerMs,
    async run() {
      if (config.isAgentDisabled("merger")) return;
      const repos = await gh.listRepos();
      // The breaker is GitHub-only — Forgejo merges never touch GitHub's
      // budget, so they keep sweeping through a GitHub cooldown (#3221).
      const { active, skipped } = gh.filterReposForRateLimit(repos);
      if (skipped > 0) {
        log.warn(`[auto-merger] Skipping ${skipped} GitHub repo(s) — API rate limited ${gh.describeRateLimit()}`);
      }
      if (active.length === 0) return;
      await mapWithConcurrency(active, 4, async (repo) => {
        if (gh.isRepoRateLimited(repo.fullName)) return;
        try {
          await autoMerger.sweepRepo(repo);
        } catch (err) {
          await reportError("auto-merger:sweep", repo.fullName, err, { repo: repo.fullName });
        }
      });
    },
  },
  smartScheduledJob("doc-maintainer", docMaintainer.processRepo),
  {
    name: "repo-standards",
    intervalMs: 0,
    scheduledHour: SCHEDULES.repoStandardsHour,
    runOnStart: true,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("repo-standards", r.fullName));
      await repoStandards.run(repos);
    },
  },
  smartScheduledJob("improvement-identifier", improvementIdentifier.processRepo, { weekendPause: true }),
  {
    // Manages its own enumeration (incl. archived repos) and 7-day throttle, so
    // it is NOT a smartScheduledBatchJob (those call gh.listRepos(), which skips
    // archived repos).
    name: "public-repo-scanner",
    intervalMs: 0,
    scheduledHour: SCHEDULES.publicRepoScannerHour,
    async run() {
      await publicRepoScanner.run();
    },
  },
  {
    name: "public-snapshot-sync",
    intervalMs: 0,
    scheduledHour: SCHEDULES.publicSnapshotSyncHour,
    async run() {
      await publicSnapshotSync.run();
    },
  },
  {
    name: "reminder-monitor",
    intervalMs: 0,
    scheduledHour: SCHEDULES.reminderMonitorHour,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("reminder-monitor", r.fullName));
      await reminderMonitor.run(repos);
    },
  },
  {
    name: "upstream-watcher",
    intervalMs: 0,
    scheduledHour: SCHEDULES.upstreamWatcherHour,
    async run() {
      await upstreamWatcher.run();
    },
  },
  {
    name: "blog-draft-scanner",
    intervalMs: 0,
    scheduledHour: SCHEDULES.blogDraftScannerHour,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("blog-draft-scanner", r.fullName));
      await blogDraftScanner.run(repos);
    },
  },
  {
    name: "idea-suggester",
    intervalMs: 0,
    manualOnly: true,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("idea-suggester", r.fullName));
      await ideaSuggester.run(repos);
    },
  },
  {
    name: "issue-importer",
    intervalMs: INTERVALS.issueImporterMs,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("issue-importer", r.fullName));
      await issueImporter.run(repos);
    },
  },
  // API-only and the safety net that closes native issues and restores Ready — waiting for idle starves it.
  smartScheduledJob("issue-auditor", issueAuditor.processRepo, { ignoreBusy: true }),
  smartScheduledJob("dependabot-alert-monitor", dependabotAlertMonitor.processRepo),
  smartScheduledJob("dependabot-run-monitor", dependabotRunMonitor.processRepo),
  {
    name: "triage-claws-errors",
    intervalMs: INTERVALS.triageClawsErrorsMs,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("triage-claws-errors", r.fullName));
      await triageClawsErrors.run(repos);
    },
  },
  {
    name: "issue-shadow-sync",
    intervalMs: INTERVALS.issueShadowSyncMs,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("issue-shadow-sync", r.fullName));
      await issueShadowSync.run(repos);
    },
  },
  {
    name: "issue-preview-sync",
    intervalMs: INTERVALS.issuePreviewSyncMs,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("issue-preview-sync", r.fullName));
      await issuePreviewSync.run(repos);
    },
  },
  {
    name: "runner-monitor",
    intervalMs: INTERVALS.runnerMonitorMs,
    async run() {
      await runnerMonitor.run();
    },
  },
  {
    name: "host-disk-monitor",
    intervalMs: INTERVALS.hostDiskMonitorMs,
    async run() {
      await hostDiskMonitor.run();
    },
  },
  {
    name: "claude-memory-backup",
    intervalMs: INTERVALS.claudeMemoryBackupMs,
    async run() {
      await claudeMemoryBackup.run();
    },
  },
  {
    name: "auth-secret-sync",
    intervalMs: INTERVALS.authSecretSyncMs,
    async run() {
      await authSecretSync.run();
    },
  },
  {
    name: "mac-runner-waker",
    intervalMs: INTERVALS.macRunnerWakerMs,
    async run() {
      await macRunnerWaker.run();
    },
  },
  smartScheduledBatchJob("scanner-dispatcher", scannerDispatcher.run),
  smartScheduledBatchJob("stale-branch-cleaner", staleBranchCleaner.run),
  {
    name: "email-monitor",
    intervalMs: INTERVALS.emailMonitorMs,
    async run() {
      await emailMonitor.run();
    },
  },
  {
    name: "runner-metrics-sync",
    intervalMs: INTERVALS.runnerMetricsSyncMs,
    async run() {
      await runnerMetricsSync.run();
    },
  },
  {
    // Repo filtering (disabled-repo skipping) lives in the job itself.
    name: "main-build-monitor",
    intervalMs: INTERVALS.mainBuildMonitorMs,
    async run() {
      await mainBuildMonitor.run(await gh.listRepos());
    },
  },
  {
    name: "worktree-cleaner",
    intervalMs: INTERVALS.worktreeCleanerMs,
    async run() {
      await worktreeCleaner.run();
    },
  },
  {
    name: "dependabot-tofu-unblocker",
    intervalMs: INTERVALS.dependabotTofuUnblockerMs,
    async run() {
      if (config.isJobDisabledForRepo("dependabot-tofu-unblocker", "St-John-Software/bstjohn-blog")) return;
      await dependabotTofuUnblocker.run();
    },
  },
  {
    name: "damp-reminder",
    intervalMs: INTERVALS.dampReminderMs,
    async run() {
      await dampReminder.run();
    },
  },
];

// In verify-only mode, start the scheduler with an empty job list. In staging
// mode, register only the issue/PR dispatcher lane; the shared dispatch guard
// then restricts actual work to live items carrying `Claws Staging`.
// Materialise the admission gate at boot rather than on the first agent spawn,
// so `agentMemoryAdmissionStatus()` (dashboard, /api/runtime/status) can stay a
// pure read: a status handler that constructed the gate would also drain it,
// and a GET must never be able to admit an agent process.
retuneAgentMemoryGate();

let stopAgentPodSweep: (() => void) | null = null;
if (shouldStartWorkersForActivation(config.ACTIVATION_STATE)) {
  registerWorkHandlers();
  worker.start();
  // Pods and Secrets left behind by finished rows (or a crash mid-launch), and
  // pod-backed running rows no fiber is watching.
  if (config.WORK_BACKEND === "k8s-pod") stopAgentPodSweep = getAgentPodLauncher().startOrphanSweep(() => worker.adoptPodBackedRows());
}
const startupJobs = selectStartupJobs(jobs, config.ACTIVATION_STATE);
const scheduler = startJobs(startupJobs, startupJobs.length > 0 ? config.PAUSED_JOBS : [], {
  canRunJob: (jobName) => canRunJobForActivation(jobName, config.ACTIVATION_STATE),
});
const server = createServer(liveControllerClient(scheduler));
// Publish scheduler/provider/worker state and run commands filed through the
// database (controller-client.ts), including any filed while Claws was down.
startControllerPublisher(scheduler);
// Prometheus scrape target (docs/metrics.md), on its own port so it is never
// reachable through the dashboard's Ingress.
const metricsServer = config.METRICS_PORT > 0 ? startMetricsServer(config.METRICS_PORT, config.BIND_HOST) : null;

// Off the boot path so a rollout's unavailable window does not include them
// (docs/k8s-cutover.md). Fire-and-forget: each step is best effort.
void pruneOnStartup();
// Under `controller` the web tier serves the dashboard and warms its own caches.
if (config.CLAWS_ROLE === "all") void warmDashboardCaches();

if (config.ACTIVATION_STATE === "verify-only") {
  // Fire-and-forget — we don't want to block server startup on slow checks.
  runConnectivityVerification().catch((err) => {
    log.warn(`[verify] Initial connectivity verification failed: ${err}`);
  });
}

// ── Hourly queue depth snapshots ──

async function takeQueueSnapshot(): Promise<void> {
  try {
    const snapshot = gh.getQueueSnapshot(gh.ALL_QUEUE_CATEGORIES);
    await recordQueueSnapshot(snapshot.items.length);
  } catch (err) {
    log.warn(`Queue snapshot failed: ${err}`);
  }
}

const snapshotInterval = setInterval(() => void takeQueueSnapshot(), 60 * 60 * 1000);

// Record initial snapshot 30s after startup (after first job scan populates cache)
const initialSnapshotTimer = setTimeout(takeQueueSnapshot, 30_000);

// ── Stale running work_queue sweep (#3144) ──
// recoverWorkOnStartup() only fires at boot; this catches a between-restart
// wedge — a 'running' row no worker fiber is actually executing.

const staleWorkInterval = setInterval(() => {
  void (async () => {
    if (!config.shouldRunWorkPipeline()) return;
    try {
      const n = await reapStaleRunningWork(worker.inFlightWorkIds());
      if (n > 0) log.warn(`Reaped ${n} stale running work_queue row(s) no worker is executing`);
    } catch {
      // best effort
    }
  })();
}, 60 * 60 * 1000);

// ── Live config reload ──

let prevIntervals = { ...INTERVALS };
let prevSchedules = { ...SCHEDULES };

onConfigChange(() => {
  gh.clearRepoCache();
  resetGitHubAppState();
  // The gate is otherwise only retuned when a new run starts, so an operator
  // raising agentWorkerMemorySharedBudgetBytes to unblock a queue would see no
  // effect while every fiber is parked in it.
  retuneAgentMemoryGate();

  if (!config.isActive()) {
    void whatsapp.stop().catch((err) => {
      log.warn(`[whatsapp] Failed to stop after activation flip to ${config.ACTIVATION_STATE}: ${err}`);
    });
  }

  const newIntervals = config.INTERVALS;
  const newSchedules = config.SCHEDULES;

  for (const [key, value] of Object.entries(newIntervals) as [keyof typeof newIntervals, number][]) {
    if (value !== prevIntervals[key]) {
      const jobName = key.replace(/Ms$/, "").replace(/([A-Z])/g, "-$1").toLowerCase();
      scheduler.updateInterval(jobName, value);
      log.info(`Config change: ${key} updated to ${formatMs(value)}`);
    }
  }

  for (const [key, value] of Object.entries(newSchedules) as [keyof typeof newSchedules, number][]) {
    if (value !== prevSchedules[key]) {
      const jobName = key.replace(/Hour$/, "").replace(/([A-Z])/g, "-$1").toLowerCase();
      scheduler.updateScheduledHour(jobName, value);
      log.info(`Config change: ${key} updated to ${value}:00`);
    }
  }

  prevIntervals = { ...newIntervals };
  prevSchedules = { ...newSchedules };

  // Sync pause state
  const configPaused = new Set(config.PAUSED_JOBS);
  const schedulerPaused = scheduler.pausedJobs();
  for (const name of configPaused) {
    if (!schedulerPaused.has(name)) scheduler.pauseJob(name);
  }
  for (const name of schedulerPaused) {
    if (!configPaused.has(name)) scheduler.resumeJob(name);
  }
});

// ── WhatsApp gateway ──
// Never start in verify-only mode: pairing would claim the device slot the
// active instance currently holds.

if (WHATSAPP_ENABLED && isActive()) {
  const waHandler = createWhatsAppHandler(() => gh.listRepos());
  whatsapp.start(waHandler).catch((err) => {
    log.error(`[whatsapp] Failed to start: ${err}`);
    reportError("whatsapp:start", "WhatsApp gateway failed to start", err).catch(() => {});
  });
  log.info("WhatsApp gateway enabled");
}

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Under `all` the dashboard is unreachable from here on (a Terminating pod
  // leaves the Service's ready endpoints at once), so the rollout window starts
  // now. Under `controller` the web tier keeps serving, and the window
  // measures only how long background processing is stopped.
  const shutdownStartedAt = Date.now();
  markShuttingDown();
  setShuttingDown();
  // First, so the dashboard says background processing is restarting; commands
  // filed from here on wait for the next boot.
  await publishControllerShuttingDown();
  const phases: ShutdownMarkerPhases = { drain: 0, cancel: 0, auth_sync: 0, memory_flush: 0 };
  let phaseStart = shutdownStartedAt;
  const endPhase = (phase: keyof ShutdownMarkerPhases) => {
    const now = Date.now();
    phases[phase] = (now - phaseStart) / 1000;
    phaseStart = now;
  };

  log.info("Shutting down...");
  stopConfigWatcher();
  clearInterval(pruneInterval);
  clearInterval(snapshotInterval);
  clearInterval(staleWorkInterval);
  clearTimeout(initialSnapshotTimer);
  stopAgentPodSweep?.();

  if (WHATSAPP_ENABLED) {
    await whatsapp.stop();
  }

  await scheduler.drain(300_000);
  endPhase("drain");

  if (cancelCurrentTask()) {
    await sleep(5000);
  }
  endPhase("cancel");

  // Persist any Codex/Claude credential rotation before the pod dies, so a planned
  // restart never reverts to the bootstrap Secret. Ungated: it is a no-op without
  // CLAWS_AUTH_SECRET_NAME, and the scheduler registers zero jobs in verify-only,
  // so on the staging pod this shutdown call is the only path that runs it.
  try {
    await authSecretSync.run();
  } catch (err) {
    log.warn(`Shutdown auth secret sync failed: ${err}`);
  }
  endPhase("auth_sync");

  // Push memories off-host before the pod dies: ~/.claude does not persist and is
  // never restored. Bounded — the k8s grace period must not expire mid-push.
  if (isActive()) {
    try {
      await Promise.race([
        claudeMemoryBackup.run(),
        sleep(60_000).then(() => {
          throw new Error("timed out after 60s");
        }),
      ]);
      log.info("Memory backup flushed on shutdown");
    } catch (err) {
      log.warn(`Shutdown memory flush failed: ${err}`);
    }
  }
  endPhase("memory_flush");

  // server.close() only stops accepting new connections; it never fires 'close'
  // itself here because we exit before the event loop's next tick, and even if
  // it did, a pending /api/events long-poll holds its connection open until
  // resolveAllWaiters() answers it — so this must be called directly, not from
  // a server.on("close", ...) handler.
  resolveAllWaiters();
  server.close();
  recordShutdownMarker({
    version: VERSION,
    shutdownStartedAt: new Date(shutdownStartedAt).toISOString(),
    phases,
    serverClosedAt: new Date().toISOString(),
  });
  await metricsServer?.close();
  await closeDb();

  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // best effort
  }

  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

log.info("claws is running");
