import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DB_PATH,
  FLEET_KUBECONFIG_PATH,
  SELF_REPO,
  STAGING_DB_SYNC_LOG_DAYS,
  STAGING_DB_SYNC_TARGET,
  isActive,
} from "../config.js";
import { ensureAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import { resolveIdentityFile } from "../util.js";
import * as log from "../log.js";

const NAME = "staging-db-sync";
const ALERT_TITLE = "[staging-db-sync] Nightly claws-staging database sync is failing";

/** Where the snapshot lands inside the pod before the importer reads it. */
const POD_SNAPSHOT_PATH = "/home/claws/.claws/import-snapshot.db";
const POD_IMPORTER = "/opt/claws/dist/tools/import-sqlite-db.js";

const STREAM_TIMEOUT_MS = 20 * 60 * 1000;
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;

export function parseTarget(value: string): { namespace: string; pod: string } {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid CLAWS_STAGING_DB_SYNC_TARGET "${value}" — expected <namespace>/<pod>`);
  }
  return { namespace: parts[0], pod: parts[1] };
}

/**
 * Trim the *snapshot copy* down to something worth shipping nightly: the live
 * database is ~647 MB, of which `job_logs` is ~526 MB. Same SQL as
 * `pruneOldLogs()` in src/db.ts. Returns the number of `job_runs` rows removed.
 *
 * This never runs against `~/.claws/claws.db` — see `docs/jobs/staging-db-sync.md`.
 */
export function pruneSnapshot(db: Database.Database, retentionDays: number, keepPerJob = 20): number {
  const result = db.prepare(`
    DELETE FROM job_runs
    WHERE started_at < datetime('now', '-${retentionDays} days')
    AND id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY job_name ORDER BY started_at DESC) AS rn
        FROM job_runs
      ) WHERE rn <= ?
    )
  `).run(keepPerJob);
  db.prepare(`DELETE FROM job_logs WHERE run_id NOT IN (SELECT run_id FROM job_runs)`).run();
  return result.changes;
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Run `kubectl` with our own spawn rather than k3s-monitor's `kubectlExec` —
 * that helper has a 30 s timeout and a maxBuffer, both wrong for a multi-minute
 * streamed upload.
 */
function kubectl(args: string[], opts: { stdinFile?: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: [opts.stdinFile ? "pipe" : "ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", d => { stdout += String(d); });
    child.stderr?.on("data", d => { stderr += String(d); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    if (opts.stdinFile) {
      const source = fs.createReadStream(opts.stdinFile);
      source.on("error", err => {
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(err);
      });
      if (child.stdin) {
        source.pipe(child.stdin);
        child.stdin.on("error", () => { /* surfaced by the exit code */ });
      }
    }

    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`kubectl ${args[2] ?? ""} timed out after ${Math.round(opts.timeoutMs / 60000)} min`));
        return;
      }
      if (code === 0) resolve(stdout);
      else reject(new Error(`kubectl exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

let inFlight: Promise<void> | undefined;

export function run(): Promise<void> {
  if (!inFlight) {
    inFlight = doRun().finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}

async function doRun(): Promise<void> {
  // Read the env var directly — this is a gate on which backend the *local*
  // instance uses, not a connection. It is what makes this job a permanent
  // no-op inside the pod and after the cutover.
  if (process.env["CLAWS_DATABASE_URL"]) {
    log.info(`[${NAME}] Skipping — this instance uses the Postgres backend, so there is no SQLite source to sync`);
    return;
  }
  if (!isActive()) {
    log.info(`[${NAME}] Skipping — instance is verify-only`);
    return;
  }
  if (!STAGING_DB_SYNC_TARGET) {
    log.info(`[${NAME}] Skipping — no CLAWS_STAGING_DB_SYNC_TARGET configured`);
    return;
  }
  if (!FLEET_KUBECONFIG_PATH) {
    log.info(`[${NAME}] Skipping — no fleet kubeconfig configured`);
    return;
  }

  const { namespace, pod } = parseTarget(STAGING_DB_SYNC_TARGET);
  const kubeconfig = resolveIdentityFile(FLEET_KUBECONFIG_PATH);
  const base = ["--kubeconfig", kubeconfig, "exec"];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-dbsync-"));
  const snapshotPath = path.join(tmpDir, "claws-snapshot.db");

  try {
    // 1. Consistent online copy. Never fs.copyFileSync(DB_PATH, ...) — claws.db
    // is a live WAL database and a plain file copy is torn.
    const source = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      await source.backup(snapshotPath);
    } finally {
      source.close();
    }
    const rawSize = fs.statSync(snapshotPath).size;

    // 2. Prune the copy, not the host database.
    const snapshot = new Database(snapshotPath);
    let runsDeleted = 0;
    try {
      runsDeleted = pruneSnapshot(snapshot, STAGING_DB_SYNC_LOG_DAYS);
      snapshot.exec("VACUUM");
    } finally {
      snapshot.close();
    }
    const prunedSize = fs.statSync(snapshotPath).size;

    let wireMs = 0;
    let importMs = 0;
    try {
      // 3. Stream it into the pod through the apiserver.
      const wireStart = Date.now();
      await kubectl(
        [...base, "-i", "-n", namespace, pod, "--", "sh", "-c", `cat > ${POD_SNAPSHOT_PATH}`],
        { stdinFile: snapshotPath, timeoutMs: STREAM_TIMEOUT_MS },
      );
      wireMs = Date.now() - wireStart;

      // 4. Import it there. `kubectl exec` inherits the container's env, so
      // CLAWS_DATABASE_URL and CLAWS_DATABASE_PASSWORD come from the Secret.
      const importStart = Date.now();
      const out = await kubectl(
        [...base, "-n", namespace, pod, "--", "node", POD_IMPORTER, POD_SNAPSHOT_PATH],
        { timeoutMs: IMPORT_TIMEOUT_MS },
      );
      importMs = Date.now() - importStart;
      if (out.trim()) log.info(`[${NAME}] ${out.trim()}`);
    } finally {
      // 5. Don't leave a snapshot on the PVC every night.
      try {
        await kubectl([...base, "-n", namespace, pod, "--", "rm", "-f", POD_SNAPSHOT_PATH], { timeoutMs: 60_000 });
      } catch (err) {
        log.warn(`[${NAME}] Failed to remove ${POD_SNAPSHOT_PATH} from ${namespace}/${pod}: ${err}`);
      }
    }

    log.info(
      `[${NAME}] Synced to ${namespace}/${pod}: snapshot ${mb(rawSize)} → ${mb(prunedSize)} after pruning ` +
        `(${runsDeleted} job_runs removed), streamed in ${Math.round(wireMs / 1000)}s, import ${Math.round(importMs / 1000)}s`,
    );
    await closeAlertIssueIfResolved({ repo: SELF_REPO, title: ALERT_TITLE, logPrefix: NAME, reason: "sync succeeded" });
  } catch (err) {
    await ensureAlertIssue({
      repo: SELF_REPO,
      title: ALERT_TITLE,
      body:
        `The nightly \`${NAME}\` job failed to load openclaw's \`claws.db\` into \`${STAGING_DB_SYNC_TARGET}\`.\n\n` +
        `\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\`\n\n` +
        `Staging is now serving stale data. See \`docs/jobs/staging-db-sync.md\`.`,
      logPrefix: NAME,
    });
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
