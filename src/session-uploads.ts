import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WORK_DIR } from "./config.js";
import * as log from "./log.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_SESSION = 20;
/** Per-file cap for the streaming (`/upload-stream`) route. */
export const MAX_LARGE_UPLOAD_BYTES = 1024 * 1024 * 1024;
/** Total bytes one session's upload dir may hold, across all files. */
export const MAX_SESSION_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

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

const AUDIO_EXTENSIONS = [".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".flac", ".aac", ".amr", ".wma"];

/**
 * True when an upload should be treated as a voice note. MIME wins when the
 * browser supplies one (MediaRecorder sends `audio/webm` or `audio/mp4`);
 * the extension list is the fallback for `application/octet-stream` drops and
 * deliberately excludes the ambiguous `.webm`/`.mp4` video containers.
 */
export function isAudioUpload(filename: string, mimeType?: string): boolean {
  const type = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("audio/")) return true;
  if (type && !type.startsWith("application/octet-stream") && type !== "application/ogg") return false;
  const lower = filename.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type SaveUploadResult =
  | { ok: true; path: string }
  | { ok: false; reason: "too-large" | "too-many" | "session-full" | "write-failed"; detail?: string };

/** Sum of file sizes in a session's upload dir, skipping entries removed mid-scan. */
function sessionUploadBytesUsed(dir: string): number {
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    try {
      total += fs.statSync(path.join(dir, f)).size;
    } catch {
      // File removed mid-scan — don't fail the upload over it.
    }
  }
  return total;
}

type PrepareUploadResult =
  | { ok: true; full: string; used: number }
  | Extract<SaveUploadResult, { ok: false }>;

/**
 * Shared setup for both upload paths: ensures the session's upload dir
 * exists, enforces the per-session file-count cap, picks a collision-proof
 * filename, and resolves it to a path guaranteed inside the dir.
 *
 * The `used` byte count returned here is read before either caller writes
 * its file, so two concurrent uploads for the same session can both pass
 * the MAX_SESSION_UPLOAD_BYTES check (TOCTOU) and push the session over
 * quota. Accepted: uploads are sequential per client, the quota is a soft
 * cap rather than a security boundary, and only multi-tab/multi-request
 * use would trigger it.
 */
function prepareUpload(sessionId: string, originalName: string): PrepareUploadResult {
  try {
    const dir = ensureSessionUploadDir(sessionId);
    if (fs.readdirSync(dir).length >= MAX_FILES_PER_SESSION) {
      return { ok: false, reason: "too-many" };
    }

    const filename = `${crypto.randomBytes(3).toString("hex")}-${sanitizeUploadFilename(originalName)}`;
    const full = path.resolve(dir, filename);
    if (!full.startsWith(dir + path.sep)) {
      return { ok: false, reason: "write-failed", detail: "path escape" };
    }

    return { ok: true, full, used: sessionUploadBytesUsed(dir) };
  } catch (err) {
    log.error(`[session-uploads] Failed to prepare upload for session ${sessionId}: ${err}`);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
}

export function saveSessionUpload(sessionId: string, originalName: string, data: Buffer): SaveUploadResult {
  if (data.byteLength === 0) return { ok: false, reason: "write-failed", detail: "empty file" };
  if (data.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "too-large" };

  const prep = prepareUpload(sessionId, originalName);
  if (!prep.ok) return prep;
  if (prep.used + data.byteLength > MAX_SESSION_UPLOAD_BYTES) return { ok: false, reason: "session-full" };

  try {
    fs.writeFileSync(prep.full, data, { mode: 0o600 });
    return { ok: true, path: prep.full };
  } catch (err) {
    log.error(`[session-uploads] Failed to save upload for session ${sessionId}: ${err}`);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
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
  const prep = prepareUpload(sessionId, originalName);
  if (!prep.ok) return prep;

  const limit = Math.min(MAX_LARGE_UPLOAD_BYTES, MAX_SESSION_UPLOAD_BYTES - prep.used);
  if (limit <= 0) return { ok: false, reason: "session-full" };

  let total = 0;
  let overLimit = false;
  try {
    await pipeline(
      source,
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          total += chunk.length;
          if (total > limit) {
            overLimit = true;
            throw new Error("upload exceeds limit");
          }
          yield chunk;
        }
      },
      fs.createWriteStream(prep.full, { mode: 0o600 }),
    );
  } catch (err) {
    try {
      fs.rmSync(prep.full, { force: true });
    } catch {
      // Best effort — nothing more we can do if cleanup itself fails.
    }
    if (overLimit) {
      return { ok: false, reason: total > MAX_LARGE_UPLOAD_BYTES ? "too-large" : "session-full" };
    }
    log.error(`[session-uploads] Failed to stream upload for session ${sessionId}: ${err}`);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }

  if (total === 0) {
    fs.rmSync(prep.full, { force: true });
    return { ok: false, reason: "write-failed", detail: "empty file" };
  }

  return { ok: true, path: prep.full };
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
