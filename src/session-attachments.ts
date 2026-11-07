/**
 * Files the operator attaches to a new session's Initial prompt on the
 * Sessions page (docs/product/interactive-sessions.md "Attach files to a new
 * session's first message").
 *
 * The session and its pod do not exist yet when a file is picked, so the bytes
 * are staged on the Claws side in the same store the issue attachments use:
 * the attachments bucket under `<id>/<filename>` when `ATTACHMENTS_S3` is set,
 * else `WORK_DIR/session-attachments/pending/`. `db.ts`' `session_attachments`
 * table records each file; a pending row has a NULL `session_id`.
 *
 * A create claims the rows ({@link claimSessionAttachments}), fixing each
 * file's name in the pod's uploads directory, and stores the composed first
 * message ({@link composeInitialPrompt}) as the row's `initial_prompt`. The
 * pod fetches the files through `GET /api/sessions/:sid/attachments/:aid`
 * before its agent starts. Staged files are deleted once the prompt is marked
 * delivered, when the session is deleted or pruned, and when left unclaimed
 * for {@link PENDING_SESSION_ATTACHMENT_TTL_MS}.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { WORK_DIR } from "./config.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { newUlid } from "./issue-id.js";
import { normaliseContentType, objectStore, spoolDir } from "./issue-attachments.js";
import type { S3Client } from "./pages-s3.js";
import { POD_UPLOAD_DIR } from "./session-pod-launch.js";
import {
  saveUploadToDir,
  saveUploadStreamToDir,
  sanitizeUploadFilename,
  type SaveUploadResult,
  type UploadErrorHandler,
} from "./session-uploads-core.js";

/** The store's directory under `WORK_DIR`. */
export const SESSION_ATTACHMENT_STORE = "session-attachments";
const PENDING_DIR = "pending";

/** Unclaimed staged files older than this are swept. */
export const PENDING_SESSION_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const ID_RE = /^sat_[0-9A-HJKMNP-TV-Z]{26}$/;

export type StageSessionAttachmentResult =
  | { ok: true; row: db.SessionAttachmentRow }
  | Extract<SaveUploadResult, { ok: false }>;

/** A fresh staged-attachment id: `sat_` plus a ULID. */
export function newSessionAttachmentId(): string {
  return `sat_${newUlid()}`;
}

/** True when `id` has the shape of a staged-attachment id. */
export function isSessionAttachmentId(id: string): boolean {
  return ID_RE.test(id);
}

function pendingDir(): string {
  return path.join(WORK_DIR, SESSION_ATTACHMENT_STORE, PENDING_DIR);
}

function logStoreError(stage: Parameters<UploadErrorHandler>[0], err: unknown): void {
  log.error(`[session-attachments] Failed to ${stage} staged attachment: ${err}`);
}

function unlinkQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    log.warn(`[session-attachments] Failed to remove ${file}: ${err}`);
  }
}

async function deleteObjectQuietly(store: S3Client, key: string): Promise<void> {
  try {
    await store.deleteObject(key);
  } catch (err) {
    log.warn(`[session-attachments] Failed to remove S3 object ${key}: ${err}`);
  }
}

/** The absolute path of an `fs` row's file, or null when it would land outside the store. */
function resolveStoredPath(storedPath: string): string | null {
  const root = path.resolve(WORK_DIR, SESSION_ATTACHMENT_STORE);
  const full = path.resolve(WORK_DIR, storedPath);
  return full.startsWith(root + path.sep) ? full : null;
}

/**
 * Record a saved file: upload it to the bucket first when one is configured
 * (the spool file is removed either way), then insert the row. A failed insert
 * removes the file or object again, so nothing is left unreachable.
 */
async function recordStaged(name: string, savedPath: string, size: number, contentType: string | undefined): Promise<StageSessionAttachmentResult> {
  const id = newSessionAttachmentId();
  const filename = sanitizeUploadFilename(name);
  const type = normaliseContentType(contentType);
  const store = objectStore();
  let storedPath: string;
  if (store) {
    storedPath = `${id}/${filename}`;
    try {
      await store.putObjectFromFile(storedPath, savedPath, size, type);
    } catch (err) {
      log.error(`[session-attachments] Failed to upload ${name} to S3: ${err}`);
      return { ok: false, reason: "write-failed", detail: String(err) };
    } finally {
      unlinkQuietly(savedPath);
    }
  } else {
    storedPath = path.relative(WORK_DIR, savedPath);
  }
  try {
    const row = await db.insertSessionAttachment({ id, filename, storedPath, storage: store ? "s3" : "fs", contentType: type, size });
    return { ok: true, row };
  } catch (err) {
    if (store) await deleteObjectQuietly(store, storedPath);
    else unlinkQuietly(savedPath);
    log.error(`[session-attachments] Failed to record ${name}: ${err}`);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
}

/** Stage a fully-buffered upload (≤ `MAX_UPLOAD_BYTES`): empty and oversized files are refused. */
export async function stageSessionAttachment(name: string, data: Buffer, contentType: string | undefined): Promise<StageSessionAttachmentResult> {
  const saved = saveUploadToDir(objectStore() ? spoolDir() : pendingDir(), name, data, logStoreError);
  if (!saved.ok) return saved;
  return recordStaged(name, saved.path, data.byteLength, contentType);
}

/** {@link stageSessionAttachment} for a streamed body of up to `MAX_LARGE_UPLOAD_BYTES`. */
export async function stageSessionAttachmentStream(name: string, source: Readable, contentType: string | undefined): Promise<StageSessionAttachmentResult> {
  // Bound for S3, the body spools to tmp first: the PUT needs its length.
  const saved = await saveUploadStreamToDir(objectStore() ? spoolDir() : pendingDir(), name, source, logStoreError);
  if (!saved.ok) return saved;
  let size: number;
  try {
    size = fs.statSync(saved.path).size;
  } catch (err) {
    unlinkQuietly(saved.path);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
  return recordStaged(name, saved.path, size, contentType);
}

/** The pending rows behind `ids`, in order, or null when any id is unknown or already claimed. */
export async function findPendingSessionAttachments(ids: readonly string[]): Promise<db.SessionAttachmentRow[] | null> {
  const rows: db.SessionAttachmentRow[] = [];
  for (const id of new Set(ids)) {
    if (!isSessionAttachmentId(id)) return null;
    const row = await db.getSessionAttachment(id);
    if (!row || row.session_id !== null) return null;
    rows.push(row);
  }
  return rows;
}

/** The name a staged file gets in the pod's uploads directory: `<6 hex>-<sanitised name>`, as a terminal upload does. */
export function newPodAttachmentName(filename: string): string {
  return `${crypto.randomBytes(3).toString("hex")}-${sanitizeUploadFilename(filename)}`;
}

/**
 * Claim pending rows for `sessionId` with the pod names already chosen for
 * them. Returns the claimed rows, or null when any of them was claimed by
 * another create first — the caller then fails the create.
 */
export async function claimSessionAttachments(
  claims: ReadonlyArray<{ id: string; podName: string }>,
  sessionId: string,
): Promise<db.SessionAttachmentRow[] | null> {
  if (claims.length === 0) return [];
  const claimed = await db.claimPendingSessionAttachments(claims, sessionId);
  if (claimed.length === claims.length) return claimed;
  await db.releaseSessionAttachments(sessionId);
  return null;
}

/** Hand a session's claimed rows back to pending, for a create that failed after claiming. Never throws. */
export async function releaseSessionAttachments(sessionId: string): Promise<void> {
  try {
    await db.releaseSessionAttachments(sessionId);
  } catch (err) {
    log.warn(`[session-attachments] Failed to release the attachments of ${sessionId}: ${err}`);
  }
}

/** Where a claimed file lands in the pod: `POD_UPLOAD_DIR/<pod name>`. */
export function podAttachmentPath(podName: string): string {
  return path.posix.join(POD_UPLOAD_DIR, podName);
}

/**
 * The agent's first message: the operator's prompt, a blank line, then one
 * absolute pod path per attached file — or the paths alone when the prompt is
 * empty. With no files it is the prompt unchanged.
 */
export function composeInitialPrompt(prompt: string | null, podNames: readonly string[]): string | null {
  if (podNames.length === 0) return prompt;
  const paths = podNames.map(podAttachmentPath).join("\n");
  return prompt ? `${prompt}\n\n${paths}` : paths;
}

/**
 * A row's bytes as a stream with their length, or null when the file or object
 * is gone or the row names a location it must not. Throws when the bucket
 * cannot be reached, or holds the object but this process has no bucket.
 */
export async function openSessionAttachment(
  row: db.SessionAttachmentRow,
  signal?: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
  if (row.storage === "s3") {
    if (!row.stored_path.startsWith(`${row.id}/`)) return null;
    const store = objectStore();
    if (!store) throw new Error(`session attachment ${row.id} is in S3 but CLAWS_ATTACHMENTS_S3_* is not configured`);
    const obj = await store.getObjectStream(row.stored_path, signal);
    if (!obj.body) return null;
    return { body: obj.body, size: obj.contentLength ?? row.size };
  }
  const file = resolveStoredPath(row.stored_path);
  if (!file) return null;
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  return { body: Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream<Uint8Array>, size };
}

async function removeStoredBytes(row: db.SessionAttachmentRow): Promise<void> {
  if (row.storage === "s3") {
    if (!row.stored_path.startsWith(`${row.id}/`)) return;
    const store = objectStore();
    if (store) await deleteObjectQuietly(store, row.stored_path);
    else log.warn(`[session-attachments] Cannot remove S3 object ${row.stored_path}: CLAWS_ATTACHMENTS_S3_* is not configured`);
    return;
  }
  const file = resolveStoredPath(row.stored_path);
  if (file) unlinkQuietly(file);
}

/** Remove a staged file's bytes, then its row. Returns false when the row was already gone. */
export async function deleteSessionAttachment(id: string): Promise<boolean> {
  const row = await db.getSessionAttachment(id);
  if (!row) return false;
  await removeStoredBytes(row);
  await db.deleteSessionAttachmentRow(id);
  return true;
}

/**
 * Remove every staged file of a session, bytes before rows. The rows would go
 * with the session through `ON DELETE CASCADE`, which leaves the bytes behind,
 * so a session delete or prune calls this before the row delete. Never throws.
 */
export async function deleteSessionAttachments(sessionId: string): Promise<void> {
  try {
    const rows = await db.listSessionAttachments(sessionId);
    for (const row of rows) await removeStoredBytes(row);
    if (rows.length > 0) await db.deleteSessionAttachmentsForSession(sessionId);
  } catch (err) {
    log.warn(`[session-attachments] Failed to remove the attachments of ${sessionId}: ${err}`);
  }
}

/** Remove staged files nobody claimed within {@link PENDING_SESSION_ATTACHMENT_TTL_MS}. Never throws. */
export async function sweepPendingSessionAttachments(now: number = Date.now()): Promise<number> {
  try {
    const cutoff = new Date(now - PENDING_SESSION_ATTACHMENT_TTL_MS).toISOString().slice(0, 19).replace("T", " ");
    const stale = await db.listPendingSessionAttachmentsOlderThan(cutoff);
    for (const row of stale) await deleteSessionAttachment(row.id);
    return stale.length;
  } catch (err) {
    log.warn(`[session-attachments] Pending sweep failed: ${err}`);
    return 0;
  }
}
