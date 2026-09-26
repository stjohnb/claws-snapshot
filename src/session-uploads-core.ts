import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Pure upload storage keyed by directory. Deliberately imports no `config.js`
// or `log.js`, so a process without Claws config (e.g. a session pod) can store
// uploads with the same limits; `session-uploads.ts` wraps these per session id.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Per-file cap for the streaming (`/upload-stream`) route. */
export const MAX_LARGE_UPLOAD_BYTES = 1024 * 1024 * 1024;
/**
 * `requestTimeout` for any HTTP server taking streamed uploads: a 1 GB upload
 * can legitimately take far longer than Node's 300 s default (#2564).
 */
export const UPLOAD_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/** The issue attachment store's directory under `WORK_DIR`. */
export const ISSUE_ATTACHMENT_STORE = "issue-attachments";

/**
 * The absolute path behind an issue attachment's `WORK_DIR`-relative
 * `stored_path`, or null when it would land outside the store — a tampered or
 * corrupted row must not read arbitrary files. Shared by the service and the
 * stdio claws-state server, which cannot import `config.js`.
 */
export function resolveIssueAttachmentPath(workDir: string, storedPath: string): string | null {
  if (!workDir) return null;
  const root = path.resolve(workDir, ISSUE_ATTACHMENT_STORE);
  const full = path.resolve(workDir, storedPath);
  return full.startsWith(root + path.sep) ? full : null;
}

/**
 * Create (or reuse) an upload dir at 0700 and return it. The explicit
 * `chmodSync` is load-bearing, not redundant: the `mode` option on `mkdirSync`
 * is masked by umask and ignored entirely when the target already exists.
 * Throws on any filesystem failure.
 */
export function ensureUploadDir(dir: string): string {
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
  | { ok: false; reason: "too-large" | "write-failed"; detail?: string };

/** Called for unexpected filesystem failures, so a caller can log them in its own voice. */
export type UploadErrorHandler = (stage: "prepare" | "save" | "stream", err: unknown) => void;

type PrepareUploadResult =
  | { ok: true; full: string }
  | Extract<SaveUploadResult, { ok: false }>;

/**
 * Shared setup for both upload paths: ensures the upload dir exists, picks a
 * collision-proof filename, and resolves it to a path guaranteed inside the dir.
 */
function prepareUpload(uploadDir: string, originalName: string, onError?: UploadErrorHandler): PrepareUploadResult {
  try {
    const dir = ensureUploadDir(path.resolve(uploadDir));

    const filename = `${crypto.randomBytes(3).toString("hex")}-${sanitizeUploadFilename(originalName)}`;
    const full = path.resolve(dir, filename);
    if (!full.startsWith(dir + path.sep)) {
      return { ok: false, reason: "write-failed", detail: "path escape" };
    }

    return { ok: true, full };
  } catch (err) {
    onError?.("prepare", err);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
}

/** Store a fully-buffered upload (≤ `MAX_UPLOAD_BYTES`) in `uploadDir`. */
export function saveUploadToDir(uploadDir: string, originalName: string, data: Buffer, onError?: UploadErrorHandler): SaveUploadResult {
  if (data.byteLength === 0) return { ok: false, reason: "write-failed", detail: "empty file" };
  if (data.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "too-large" };

  const prep = prepareUpload(uploadDir, originalName, onError);
  if (!prep.ok) return prep;

  try {
    fs.writeFileSync(prep.full, data, { mode: 0o600 });
    return { ok: true, path: prep.full };
  } catch (err) {
    onError?.("save", err);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
}

/**
 * Streams `source` straight to disk under a byte counter capped at
 * `MAX_LARGE_UPLOAD_BYTES`, so an upload of up to 1 GB never sits fully
 * buffered in process memory. The partial file is unlinked on every failure
 * path so interrupted or rejected uploads do not leave abandoned files behind.
 */
export async function saveUploadStreamToDir(
  uploadDir: string,
  originalName: string,
  source: Readable,
  onError?: UploadErrorHandler,
): Promise<SaveUploadResult> {
  const prep = prepareUpload(uploadDir, originalName, onError);
  if (!prep.ok) return prep;

  let total = 0;
  let overLimit = false;
  try {
    await pipeline(
      source,
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          total += chunk.length;
          if (total > MAX_LARGE_UPLOAD_BYTES) {
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
      await new Promise((resolve) => setImmediate(resolve));
      fs.rmSync(prep.full, { force: true });
    } catch {
      // Best effort — nothing more we can do if cleanup itself fails.
    }
    if (overLimit) {
      return { ok: false, reason: "too-large" };
    }
    onError?.("stream", err);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }

  if (total === 0) {
    fs.rmSync(prep.full, { force: true });
    return { ok: false, reason: "write-failed", detail: "empty file" };
  }

  return { ok: true, path: prep.full };
}
