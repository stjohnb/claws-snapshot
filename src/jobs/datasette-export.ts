import fs from "node:fs";
import path from "node:path";
import { DATASETTE_EXPORT, WORK_DIR, type DatasetteExport } from "../config.js";
import { backupDb } from "../db.js";
import * as log from "../log.js";
import { buildSshArgs, execCapture, isSafeAbsolutePath } from "../ssh.js";

// Accepts new host keys automatically — intentional for self-hosted LAN deployments
// where the host key isn't known in advance. Leaves a first-connection MITM window.
function scpFile(cfg: DatasetteExport, localPath: string): Promise<void> {
  if (!isSafeAbsolutePath(cfg.remotePath)) throw new Error(`unsafe remotePath: ${cfg.remotePath}`);
  const args = buildSshArgs(cfg, { scp: true });
  const target = cfg.user ? `${cfg.user}@${cfg.host}` : cfg.host;
  args.push(localPath, `${target}:${cfg.remotePath}`);
  return execCapture("scp", args, { timeout: 120_000 }).then(() => undefined);
}

export async function run(): Promise<void> {
  const cfg = DATASETTE_EXPORT;
  if (!cfg) {
    log.debug("[datasette-export] Not configured — skipping");
    return;
  }

  const tmpPath = path.join(WORK_DIR, "claws-datasette-export.db");

  try {
    log.info("[datasette-export] Creating database snapshot");
    await backupDb(tmpPath);

    const stat = fs.statSync(tmpPath);
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    log.info(`[datasette-export] Snapshot created (${sizeMb} MB) — uploading to ${cfg.host}`);

    await scpFile(cfg, tmpPath);
    log.info("[datasette-export] Upload complete");
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
  }
}
