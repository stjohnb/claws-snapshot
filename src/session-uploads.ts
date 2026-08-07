import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WORK_DIR } from "./config.js";
import * as log from "./log.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_SESSION = 20;

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
  const dir = sessionUploadDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function sanitizeUploadFilename(name: string): string {
  const base = path.basename(name)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return base || "upload";
}

export type SaveUploadResult =
  | { ok: true; path: string }
  | { ok: false; reason: "too-large" | "too-many" | "write-failed"; detail?: string };

export function saveSessionUpload(sessionId: string, originalName: string, data: Buffer): SaveUploadResult {
  if (data.byteLength === 0) return { ok: false, reason: "write-failed", detail: "empty file" };
  if (data.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "too-large" };

  let dir: string;
  try {
    dir = ensureSessionUploadDir(sessionId);
    if (fs.readdirSync(dir).length >= MAX_FILES_PER_SESSION) {
      return { ok: false, reason: "too-many" };
    }

    const filename = `${crypto.randomBytes(3).toString("hex")}-${sanitizeUploadFilename(originalName)}`;
    const full = path.resolve(dir, filename);
    if (!full.startsWith(dir + path.sep)) {
      return { ok: false, reason: "write-failed", detail: "path escape" };
    }

    fs.writeFileSync(full, data, { mode: 0o600 });
    return { ok: true, path: full };
  } catch (err) {
    log.error(`[session-uploads] Failed to save upload for session ${sessionId}: ${err}`);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
}

/** Best-effort removal of a session's whole upload dir. Never throws. */
export function removeSessionUploadDir(sessionId: string): void {
  try {
    fs.rmSync(sessionUploadDir(sessionId), { recursive: true, force: true });
  } catch {
    // Best effort — a leftover upload dir is not worth failing a teardown over.
  }
}
