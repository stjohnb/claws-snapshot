import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { INTERVALS, SCHEDULES, LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB, WORK_DIR, WHATSAPP_ENABLED, onConfigChange, isActive, getUnknownConfigKeys, SMART_SCHEDULING } from "./config.js";
import * as config from "./config.js";
import * as log from "./log.js";
import { formatMs } from "./format.js";
import * as gh from "./github.js";
import { startJobs, type Job } from "./scheduler.js";
import { createServer } from "./server.js";
import { initDb, setRunIdProvider, getOrphanedTasks, recordTaskFailed, pruneOldLogs, pruneQueueSnapshots, pruneWorkflowRuns, pruneProcessedReposDailyOlderThan, recordQueueSnapshot, recoverWorkOnStartup, pruneWorkQueue, closeDb } from "./db.js";
import * as worker from "./worker.js";
import { registerAll as registerWorkHandlers } from "./work-handlers.js";
import * as smartSchedule from "./smart-schedule.js";
import type { Repo } from "./config.js";
import { runContext } from "./log.js";
import * as issueAgent from "./jobs/issue-dispatcher.js";
import * as prAgent from "./jobs/pr-dispatcher.js";
import * as triageKwyjiboErrors from "./jobs/triage-kwyjibo-errors.js";
import * as docMaintainer from "./jobs/doc-maintainer.js";
import * as repoStandards from "./jobs/repo-standards.js";
import * as improvementIdentifier from "./jobs/improvement-identifier.js";
import * as ideaSuggester from "./jobs/idea-suggester.js";
import * as ideaCollector from "./jobs/idea-collector.js";
import * as triageClawsErrors from "./jobs/triage-claws-errors.js";
import * as issueAuditor from "./jobs/issue-auditor.js";
import * as runnerMonitor from "./jobs/runner-monitor.js";
import * as datasetteExport from "./jobs/datasette-export.js";
import * as scannerDispatcher from "./jobs/scanner-dispatcher.js";
import * as staleBranchCleaner from "./jobs/stale-branch-cleaner.js";
import * as ideaReconciler from "./jobs/idea-reconciler.js";
import * as emailMonitor from "./jobs/email-monitor.js";
import * as qaPhase from "./jobs/qa-phase.js";
import * as k3sMonitor from "./jobs/k3s-monitor.js";
import * as prodK8sMonitor from "./jobs/prod-k8s-monitor.js";
import * as runnerMetricsSync from "./jobs/runner-metrics-sync.js";
import * as haUpgrader from "./jobs/ha-upgrader.js";
import * as haDeployWatcher from "./jobs/ha-deploy-watcher.js";
import * as worktreeCleaner from "./jobs/worktree-cleaner.js";
import * as whatsapp from "./whatsapp.js";
import { createHandler as createWhatsAppHandler } from "./jobs/whatsapp-handler.js";
import { setShuttingDown } from "./shutdown.js";
import { sleep } from "./util.js";
import { cancelCurrentTask } from "./claude.js";
import { resetGitHubAppState, ensureGitHubAppConfigured } from "./github-app.js";
import { reportError } from "./error-reporter.js";
import { recoverSessions } from "./sessions.js";
import { runConnectivityVerification } from "./jobs/connectivity-verifier.js";
import { VERSION } from "./version.js";

log.info(`claws ${VERSION} starting up`);

// ── Single-instance file lock ──
// Prevents two claws processes from sharing the same WORK_DIR (which would
// corrupt the SQLite WAL, the tmux sessions, and the worktree metadata). This
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
        // eslint-disable-next-line no-console
        console.error(`Another claws instance is running (pid ${existingPid}). Exiting.`);
        process.exit(1);
      }
      log.warn(`Stale PID file at ${PID_FILE} (pid ${existingPid} not alive) — overwriting`);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`Failed to acquire PID lock at ${PID_FILE}: ${err}`);
  process.exit(1);
}

if (isActive()) {
  ensureGitHubAppConfigured();
} else {
  log.info("VERIFY-ONLY MODE — no jobs will run. Use the /verify page to inspect connectivity; toggle to active via /config when ready.");
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
    gh.searchIssues(config.SELF_REPO, title).then(async results => {
      const existing = results.find(r => r.title === title);
      if (existing) {
        const comment = [
          `### Recurrence — ${new Date().toISOString()}`,
          "",
          "The following unknown keys are still present in `~/.claws/config.json` and will be discarded:",
          "",
          keyList,
          "",
          "Check for typos or remove keys that are no longer supported.",
        ].join("\n");
        await gh.commentOnIssue(config.SELF_REPO, existing.number, comment);
      } else {
        const body = [
          "**Auto-created by Claws config validator**",
          "",
          `The following keys in \`~/.claws/config.json\` are not recognised by Claws and will be discarded:`,
          "",
          keyList,
          "",
          "Check for typos or remove keys that are no longer supported.",
        ].join("\n");
        await gh.createIssue(config.SELF_REPO, title, body, []);
      }
      fs.writeFileSync(stampFile, String(Date.now()));
    }).catch(err => {
      log.warn(`[config] Failed to report unknown config keys: ${err}`);
    });
  }
}

// ── Database init & recovery ──

initDb();
setRunIdProvider(() => runContext.getStore()?.runId);

const wq = recoverWorkOnStartup();
if (wq.resetRunning > 0) {
  log.info(`Reset ${wq.resetRunning} stuck work_queue row(s) from previous process back to 'queued'`);
}

const orphaned = getOrphanedTasks();
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

    recordTaskFailed(task.id, "process restarted before completion");
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

// ── Terminal session recovery (tmux-backed sessions survive restarts) ──

await recoverSessions();

// ── Log pruning ──

const pruned = pruneOldLogs(LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB);
if (pruned > 0) {
  log.info(`Pruned ${pruned} old job run(s) (retention: ${LOG_RETENTION_DAYS} days)`);
}

const pruneInterval = setInterval(() => {
  try {
    const n = pruneOldLogs(LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB);
    if (n > 0) log.info(`Pruned ${n} old job run(s)`);
    pruneQueueSnapshots();
    pruneWorkflowRuns();
    pruneProcessedReposDailyOlderThan(30);
    pruneWorkQueue();
  } catch {
    // best effort
  }
}, 24 * 60 * 60 * 1000);

// Prune on startup too
try { pruneQueueSnapshots(); } catch { /* best effort */ }
try { pruneWorkflowRuns(); } catch { /* best effort */ }
try { pruneWorkQueue(); } catch { /* best effort */ }

// ── Jobs ──

function smartScheduledJob(
  name: string,
  processRepo: (repo: Repo) => Promise<unknown>,
  opts?: { skipWeekends?: boolean },
): Job {
  return {
    name,
    intervalMs: SMART_SCHEDULING.tickIntervalMs,
    skipWeekends: opts?.skipWeekends,
    async run(o?: { manual?: boolean }) {
      if (!smartSchedule.shouldRunSmartJob(name, undefined, o?.manual ?? false)) return;
      const allRepos = (await gh.listRepos()).filter((r) => !config.isJobDisabledForRepo(name, r.fullName));
      const due = smartSchedule.selectReposForTick(name, allRepos);
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
      const allRepos = (await gh.listRepos()).filter((r) => !config.isJobDisabledForRepo(name, r.fullName));
      const due = smartSchedule.selectReposForTick(name, allRepos);
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
    name: "triage-kwyjibo-errors",
    intervalMs: INTERVALS.triageKwyjiboErrorsMs,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("triage-kwyjibo-errors", r.fullName));
      await triageKwyjiboErrors.run(repos);
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
  smartScheduledJob("improvement-identifier", improvementIdentifier.processRepo),
  smartScheduledJob("idea-suggester", ideaSuggester.processRepo, { skipWeekends: true }),
  {
    name: "idea-collector",
    intervalMs: INTERVALS.ideaCollectorMs,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("idea-collector", r.fullName));
      await ideaCollector.run(repos);
    },
  },
  smartScheduledJob("issue-auditor", issueAuditor.processRepo),
  {
    name: "triage-claws-errors",
    intervalMs: INTERVALS.triageClawsErrorsMs,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("triage-claws-errors", r.fullName));
      await triageClawsErrors.run(repos);
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
    name: "datasette-export",
    intervalMs: INTERVALS.datasetteExportMs,
    async run() {
      await datasetteExport.run();
    },
  },
  smartScheduledBatchJob("scanner-dispatcher", scannerDispatcher.run),
  smartScheduledBatchJob("stale-branch-cleaner", staleBranchCleaner.run),
  smartScheduledBatchJob("idea-reconciler", ideaReconciler.run),
  {
    name: "email-monitor",
    intervalMs: INTERVALS.emailMonitorMs,
    async run() {
      await emailMonitor.run();
    },
  },
  {
    name: "qa-phase",
    intervalMs: INTERVALS.qaPhaseMs,
    async run() {
      const repos = (await gh.listRepos()).filter(r => !config.isJobDisabledForRepo("qa-phase", r.fullName));
      await qaPhase.run(repos);
    },
  },
  {
    name: "k3s-monitor",
    intervalMs: INTERVALS.k3sMonitorMs,
    async run() {
      await k3sMonitor.run();
    },
  },
  {
    name: "prod-k8s-monitor",
    intervalMs: INTERVALS.prodK8sMonitorMs,
    async run() {
      await prodK8sMonitor.run();
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
    name: "ha-upgrader",
    intervalMs: INTERVALS.haUpgraderMs,
    async run() {
      await haUpgrader.run();
    },
  },
  {
    name: "ha-deploy-watcher",
    intervalMs: INTERVALS.haDeployWatcherMs,
    async run() {
      await haDeployWatcher.run();
    },
  },
  {
    name: "worktree-cleaner",
    intervalMs: INTERVALS.worktreeCleanerMs,
    async run() {
      await worktreeCleaner.run();
    },
  },
];

// In verify-only mode, start the scheduler with an empty job list. This keeps
// the dashboard/queue UI functional but guarantees no side-effecting work runs
// until an operator toggles to active via /config.
if (isActive()) {
  registerWorkHandlers();
  worker.start();
}
const scheduler = startJobs(isActive() ? jobs : [], isActive() ? config.PAUSED_JOBS : []);
const server = createServer(scheduler);

if (!isActive()) {
  // Fire-and-forget — we don't want to block server startup on slow checks.
  runConnectivityVerification().catch((err) => {
    log.warn(`[verify] Initial connectivity verification failed: ${err}`);
  });
}

// ── Hourly queue depth snapshots ──

function takeQueueSnapshot(): void {
  try {
    const snapshot = gh.getQueueSnapshot(gh.ALL_QUEUE_CATEGORIES);
    recordQueueSnapshot(snapshot.items.length);
  } catch (err) {
    log.warn(`Queue snapshot failed: ${err}`);
  }
}

const snapshotInterval = setInterval(takeQueueSnapshot, 60 * 60 * 1000);

// Record initial snapshot 30s after startup (after first job scan populates cache)
const initialSnapshotTimer = setTimeout(takeQueueSnapshot, 30_000);

// ── Live config reload ──

let prevIntervals = { ...INTERVALS };
let prevSchedules = { ...SCHEDULES };

onConfigChange(() => {
  gh.clearRepoCache();
  resetGitHubAppState();

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
  setShuttingDown();

  log.info("Shutting down...");
  clearInterval(pruneInterval);
  clearInterval(snapshotInterval);
  clearTimeout(initialSnapshotTimer);

  if (WHATSAPP_ENABLED) {
    await whatsapp.stop();
  }

  await scheduler.drain(300_000);

  if (cancelCurrentTask()) {
    await sleep(5000);
  }

  server.close();
  closeDb();

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
