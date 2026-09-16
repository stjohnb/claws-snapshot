import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { WORK_DIR } from "./config.js";
import * as log from "./log.js";
import {
  ensureUploadDir,
  saveUploadToDir,
  saveUploadStreamToDir,
  type SaveUploadResult,
  type UploadErrorHandler,
} from "./session-uploads-core.js";

export {
  MAX_UPLOAD_BYTES,
  MAX_FILES_PER_SESSION,
  MAX_LARGE_UPLOAD_BYTES,
  MAX_SESSION_UPLOAD_BYTES,
  UPLOAD_REQUEST_TIMEOUT_MS,
  sanitizeUploadFilename,
  isAudioUpload,
  type SaveUploadResult,
} from "./session-uploads-core.js";

export function sessionUploadDir(sessionId: string): string {
  return path.join(WORK_DIR, "session-uploads", sessionId);
}

/**
 * Create (or reuse) a session's upload dir at 0700 and return its absolute
 * path. The explicit `chmodSync` is load-bearing, not redundant: the `mode`
 * option on `mkdirSync` is masked by umask and ignored entirely when the
 * target already exists. Throws on any filesystem failure.
 */
export function ensureSessionUploadDir(sessionId: string): string {
  return ensureUploadDir(sessionUploadDir(sessionId));
}

function logUploadError(sessionId: string): UploadErrorHandler {
  return (stage, err) => {
    log.error(`[session-uploads] Failed to ${stage} upload for session ${sessionId}: ${err}`);
  };
}

export function saveSessionUpload(sessionId: string, originalName: string, data: Buffer): SaveUploadResult {
  return saveUploadToDir(sessionUploadDir(sessionId), originalName, data, logUploadError(sessionId));
}

/**
 * Streams `source` straight to disk under a byte counter capped at
 * `MAX_LARGE_UPLOAD_BYTES` (and the session's remaining quota), so an
 * upload of up to 1 GB never sits fully buffered in process memory. The
 * partial file is unlinked on every failure path — leaving it behind would
 * silently eat both the session's byte quota and its file-count budget.
 */
export async function saveSessionUploadStream(
  sessionId: string,
  originalName: string,
  source: Readable,
): Promise<SaveUploadResult> {
  return saveUploadStreamToDir(sessionUploadDir(sessionId), originalName, source, logUploadError(sessionId));
}

/** Best-effort removal of a session's whole upload dir. Never throws. */
export function removeSessionUploadDir(sessionId: string): void {
  try {
    fs.rmSync(sessionUploadDir(sessionId), { recursive: true, force: true });
  } catch {
    // Best effort — a leftover upload dir is not worth failing a teardown over.
  }
}

/**
 * Remove abandoned per-session upload dirs whose ids are no longer backed by a
 * live or resumable session row. Never throws.
 */
export function pruneOrphanSessionUploadDirs(activeSessionIds: Iterable<string>): void {
  const root = path.join(WORK_DIR, "session-uploads");
  try {
    const keep = new Set(activeSessionIds);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (keep.has(entry.name)) continue;
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  } catch {
    // Best effort — recovery must not be blocked by stale private state.
  }
}
