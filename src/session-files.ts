/**
 * Files an interactive session published for the user to download
 * (`claws_publish_file`, docs/product/interactive-sessions.md "Let a session
 * present generated files for download").
 *
 * Claws pulls the bytes from the session pod's terminal server and keeps them
 * under `WORK_DIR/session-files/<sessionId>/`, written by the same helpers the
 * upload stores use; `db.ts`' `session_files` table records what each file is
 * and which session owns it. Keeping them on the Claws side means a file stays
 * downloadable after the pod restarts or the session ends, until the session
 * is deleted or pruned, when {@link deleteSessionFiles} removes them.
 *
 * Serving reuses the issue attachment allowlist (`serveContentType`,
 * `contentDisposition`): allowlisted images open inline, everything else
 * downloads, and types are never sniffed.
 */

import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { WORK_DIR } from "./config.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { isInlineImage } from "./issue-attachments.js";
import {
  MAX_UPLOAD_BYTES,
  SESSION_FILE_STORE,
  resolveSessionFilePath,
  sanitizeUploadFilename,
  saveUploadStreamToDir,
  type SaveUploadResult,
} from "./session-uploads-core.js";

/** Per-file limit for a published file — the same 10 MB as an inline upload. */
export const MAX_SESSION_FILE_BYTES = MAX_UPLOAD_BYTES;

const SESSION_ID_RE = /^[a-f0-9]+$/;

export type StoreSessionFileResult =
  | { ok: true; row: db.SessionFileRow; requestedName: string }
  | Extract<SaveUploadResult, { ok: false }>;

/** What the session page, its poll and the publish route say about one file. */
export interface SessionFileView {
  id: string;
  name: string;
  size: number;
  contentType: string;
  /** Opens the file: inline for an allowlisted image, else a download. */
  url: string;
  /** Always a download (`?download=1`). */
  downloadUrl: string;
  isImage: boolean;
  createdAt: string;
  /** ISO 8601 UTC publish time. */
  publishedAt: string;
  /** Short UTC label: `HH:MM:SS UTC` for today, else `YYYY-MM-DD HH:MM UTC`. */
  publishedLabel: string;
  /** True on the newest file of a same-named family that has several members. */
  latest: boolean;
}

/** The directory a session's published files live in. */
export function sessionFileDir(sessionId: string): string {
  return path.join(WORK_DIR, SESSION_FILE_STORE, sessionId);
}

const EXTENSION_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".svg": "image/svg+xml",
};

/**
 * The content type recorded for a published file, from its extension only —
 * the bytes are never sniffed. Unknown extensions are `application/octet-stream`.
 * What a browser is actually served is narrowed further by `serveContentType`.
 */
export function guessSessionFileContentType(name: string): string {
  return EXTENSION_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

const MAX_FILENAME_LENGTH = 80;

/**
 * The name a published file gets: `requested` when no existing name matches it
 * (case-insensitively), else `-2`, `-3`, … before the last extension, using the
 * lowest free number. The result stays within the 80-character filename limit
 * by truncating the stem.
 */
export function uniqueSessionFileName(requested: string, existingNames: Iterable<string>): string {
  const taken = new Set<string>();
  for (const n of existingNames) taken.add(n.toLowerCase());
  if (!taken.has(requested.toLowerCase())) return requested;
  const ext = path.extname(requested);
  const stem = ext ? requested.slice(0, -ext.length) : requested;
  for (let n = 2; ; n++) {
    const suffix = `-${n}${ext}`;
    const candidate = stem.slice(0, Math.max(1, MAX_FILENAME_LENGTH - suffix.length)) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

const sessionLocks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for the same session has settled. */
async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  sessionLocks.set(sessionId, tail);
  try {
    return await run;
  } finally {
    if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId);
  }
}

/**
 * Stream `source` into the session's directory under the 10 MB per-file limit
 * and record it. A name already published in the session gets a numbered
 * suffix (see {@link uniqueSessionFileName}); `requestedName` is the sanitised
 * name asked for. A file over the limit is refused with `too-large` and leaves
 * nothing behind; a failed row insert unlinks the file it would have described.
 */
export async function storeSessionFile(
  sessionId: string,
  name: string,
  source: Readable,
  contentType: string = guessSessionFileContentType(name),
): Promise<StoreSessionFileResult> {
  if (!SESSION_ID_RE.test(sessionId)) {
    source.resume();
    return { ok: false, reason: "write-failed", detail: "invalid session id" };
  }
  return withSessionLock(sessionId, async (): Promise<StoreSessionFileResult> => {
    const requestedName = sanitizeUploadFilename(name);
    let finalName: string;
    try {
      const existing = await db.listSessionFiles(sessionId);
      finalName = uniqueSessionFileName(requestedName, existing.map((r) => r.filename));
    } catch (err) {
      source.resume();
      log.error(`[session-files] Failed to list files for session ${sessionId}: ${err}`);
      return { ok: false, reason: "write-failed", detail: String(err) };
    }
    const saved = await saveUploadStreamToDir(
      sessionFileDir(sessionId),
      finalName,
      source,
      (stage, err) => log.error(`[session-files] Failed to ${stage} published file for session ${sessionId}: ${err}`),
      MAX_SESSION_FILE_BYTES,
    );
    if (!saved.ok) return saved;
    try {
      const size = fs.statSync(saved.path).size;
      const row = await db.insertSessionFile({
        sessionId,
        filename: finalName,
        storedPath: path.relative(WORK_DIR, saved.path),
        contentType,
        size,
      });
      return { ok: true, row, requestedName };
    } catch (err) {
      // A file with no row is unreachable and never cleaned up — drop it now.
      fs.rmSync(saved.path, { force: true });
      log.error(`[session-files] Failed to record published file ${name} for session ${sessionId}: ${err}`);
      return { ok: false, reason: "write-failed", detail: String(err) };
    }
  });
}

/** A published file's row and the file behind it, or undefined when either is missing or unsafe. */
export async function readSessionFile(id: string): Promise<{ row: db.SessionFileRow; absolutePath: string } | undefined> {
  const row = await db.getSessionFile(id);
  if (!row) return undefined;
  const absolutePath = resolveSessionFilePath(WORK_DIR, row.stored_path);
  if (!absolutePath) {
    log.warn(`[session-files] Refusing ${id}: stored path escapes the store (${row.stored_path})`);
    return undefined;
  }
  return { row, absolutePath };
}

/** Remove every file a session published — its rows, then its directory. Never throws. */
export async function deleteSessionFiles(sessionId: string): Promise<void> {
  if (!SESSION_ID_RE.test(sessionId)) return;
  try {
    await db.deleteSessionFilesForSession(sessionId);
  } catch (err) {
    log.warn(`[session-files] Failed to delete file rows for session ${sessionId}: ${err}`);
  }
  try {
    fs.rmSync(sessionFileDir(sessionId), { recursive: true, force: true });
  } catch (err) {
    log.warn(`[session-files] Failed to remove files for session ${sessionId}: ${err}`);
  }
}

/** The site-relative URL the session page links to and the serve route answers on. */
export function sessionFileUrl(row: Pick<db.SessionFileRow, "id" | "session_id" | "filename">): string {
  return `/sessions/${row.session_id}/files/${row.id}/${encodeURIComponent(row.filename)}`;
}

/** `created_at` is a zone-less UTC `YYYY-MM-DD HH:MM:SS`; render it as ISO and a short label. */
function publishTime(createdAt: string, now: Date): { publishedAt: string; publishedLabel: string } {
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return { publishedAt: createdAt, publishedLabel: createdAt };
  const iso = d.toISOString();
  const sameDay = iso.slice(0, 10) === now.toISOString().slice(0, 10);
  const publishedLabel = sameDay ? `${iso.slice(11, 19)} UTC` : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  return { publishedAt: iso, publishedLabel };
}

export function describeSessionFile(row: db.SessionFileRow): SessionFileView {
  const url = sessionFileUrl(row);
  return {
    id: row.id,
    name: row.filename,
    size: row.size,
    contentType: row.content_type,
    url,
    downloadUrl: `${url}?download=1`,
    isImage: isInlineImage(row),
    createdAt: row.created_at,
    ...publishTime(row.created_at, new Date()),
    latest: false,
  };
}

/**
 * The family a file name belongs to: lowercased, with a trailing `-<n>` (n ≥ 2)
 * before the extension removed, so `Deploy-3.sh` and `deploy.sh` share one.
 */
export function sessionFileFamily(name: string): string {
  const lower = name.toLowerCase();
  const ext = path.extname(lower);
  const stem = ext ? lower.slice(0, -ext.length) : lower;
  return stem.replace(/-([2-9]|[1-9]\d+)$/, "") + ext;
}

/** {@link describeSessionFile} for a list (oldest first), marking the newest file of each multi-member family `latest`. */
export function describeSessionFiles(rows: db.SessionFileRow[]): SessionFileView[] {
  const views = rows.map(describeSessionFile);
  const families = new Map<string, SessionFileView[]>();
  for (const v of views) {
    const key = sessionFileFamily(v.name);
    const list = families.get(key);
    if (list) list.push(v);
    else families.set(key, [v]);
  }
  for (const list of families.values()) {
    if (list.length >= 2) list[list.length - 1].latest = true;
  }
  return views;
}
