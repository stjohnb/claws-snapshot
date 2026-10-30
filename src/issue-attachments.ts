/**
 * Files attached to Claws-native issues (#3289, docs/issue-tracker.md).
 *
 * `db.ts`' `claws_issue_attachments` table records what each file is, which
 * issue owns it and where its bytes live (`storage`):
 *
 * - `s3` — when `ATTACHMENTS_S3` is configured, every new upload goes to that
 *   bucket under `<attachmentId>/<filename>`, so any process sharing the
 *   database can serve it (#clw_01M5APX7YF3AGWHV1S1WMHJDR6). Keys never move.
 * - `fs` — otherwise, under `WORK_DIR/issue-attachments/<issueId>/`, written by
 *   the same helpers the session upload store uses. Uploads made on the New
 *   Issue form before the issue exists go under `pending/`, and
 *   {@link claimPendingAttachments} moves them across once it does.
 *   {@link migrateFsAttachmentsToS3} moves these rows to the bucket once one
 *   is configured.
 *
 * A pending upload has a NULL `issue_id` in either store.
 *
 * Everything that links to a file uses the site-relative URL from
 * {@link attachmentUrl}, never `DASHBOARD_URL`, so a stored body survives a
 * host or domain move.
 *
 * An agent pod has no store of its own: {@link attachmentFileResponse} reads
 * the bytes through the service's agent-pod API instead of the local disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { ATTACHMENTS_S3, WORK_DIR, type AttachmentsS3Config } from "./config.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { canonicalIssueRef, isClawsIssueId, newClawsAttachmentId } from "./issue-id.js";
import { S3Client } from "./pages-s3.js";
import {
  saveUploadToDir,
  saveUploadStreamToDir,
  sanitizeUploadFilename,
  ensureUploadDir,
  ISSUE_ATTACHMENT_STORE,
  resolveIssueAttachmentPath,
  type SaveUploadResult,
  type UploadErrorHandler,
} from "./session-uploads-core.js";

export { MAX_UPLOAD_BYTES, MAX_LARGE_UPLOAD_BYTES } from "./session-uploads-core.js";

/** The `pending/` directory and the `new` URL segment both stand for "no issue yet". */
const PENDING_DIR = "pending";
export const PENDING_URL_SEGMENT = "new";

/** Pending uploads older than this are swept (decision 9 of #3289). */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export type StoreAttachmentResult =
  | { ok: true; row: db.ClawsIssueAttachmentRow }
  | Extract<SaveUploadResult, { ok: false }>;

/** Where an attachment's bytes are read from: a file in the local store or a key in the bucket. */
export type AttachmentSource =
  | { kind: "fs"; absolutePath: string }
  | { kind: "s3"; key: string };

/** An attachment's row and where its bytes are, as {@link readIssueAttachment} returns. */
export interface FoundAttachment {
  row: db.ClawsIssueAttachmentRow;
  source: AttachmentSource;
}

function storeRoot(): string {
  return path.join(WORK_DIR, ISSUE_ATTACHMENT_STORE);
}

let cachedClient: { config: AttachmentsS3Config; client: S3Client } | null = null;

/** The attachments bucket's client, or null when `ATTACHMENTS_S3` is not configured. Shared with `session-attachments.ts`. */
export function objectStore(): S3Client | null {
  const config = ATTACHMENTS_S3;
  if (!config) return null;
  if (cachedClient?.config !== config) cachedClient = { config, client: new S3Client(config) };
  return cachedClient.client;
}

/** Uploads bound for S3 land here first, so the PUT carries a known length. Shared with `session-attachments.ts`. */
export function spoolDir(): string {
  return path.join(os.tmpdir(), "claws-attachment-spool");
}

/** The bucket key for an attachment: under its own id, so it never collides or moves. */
function objectKey(id: string, filename: string): string {
  return `${id}/${sanitizeUploadFilename(filename)}`;
}

/** The directory an issue's files (or the pending uploads) live in. */
export function issueAttachmentDir(issueId: string | typeof PENDING_DIR): string {
  return path.join(storeRoot(), issueId);
}

function logStoreError(owner: string): UploadErrorHandler {
  return (stage, err) => {
    log.error(`[issue-attachments] Failed to ${stage} attachment for ${owner}: ${err}`);
  };
}

/** Lower-case MIME type without parameters; empty becomes `application/octet-stream`. */
export function normaliseContentType(contentType: string | undefined): string {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return type || "application/octet-stream";
}

/** Unlink a file, treating "already gone" as success. */
function unlinkQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    log.warn(`[issue-attachments] Failed to remove ${file}: ${err}`);
  }
}

async function recordStored(
  issueId: string | null,
  name: string,
  savedPath: string,
  size: number,
  contentType: string | undefined,
  uploader: string,
): Promise<StoreAttachmentResult> {
  try {
    const row = await db.insertClawsIssueAttachment({
      issueId,
      filename: sanitizeUploadFilename(name),
      storedPath: path.relative(WORK_DIR, savedPath),
      contentType: normaliseContentType(contentType),
      size,
      uploaderLogin: uploader,
    });
    return { ok: true, row };
  } catch (err) {
    // A file with no row is unreachable and never cleaned up — drop it now.
    unlinkQuietly(savedPath);
    log.error(`[issue-attachments] Failed to record attachment ${name}: ${err}`);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
}

/**
 * Upload a spooled file to the bucket and record it, removing the spool file
 * either way. The object goes before the row, so a row never names a missing
 * key; a failed insert deletes the object again.
 */
async function recordUploaded(
  store: S3Client,
  issueId: string | null,
  name: string,
  spooledPath: string,
  size: number,
  contentType: string | undefined,
  uploader: string,
): Promise<StoreAttachmentResult> {
  const id = newClawsAttachmentId();
  const filename = sanitizeUploadFilename(name);
  const key = objectKey(id, filename);
  const type = normaliseContentType(contentType);
  try {
    await store.putObjectFromFile(key, spooledPath, size, type);
  } catch (err) {
    log.error(`[issue-attachments] Failed to upload attachment ${name} to S3: ${err}`);
    return { ok: false, reason: "write-failed", detail: String(err) };
  } finally {
    unlinkQuietly(spooledPath);
  }
  try {
    const row = await db.insertClawsIssueAttachment({
      id,
      issueId,
      filename,
      storedPath: key,
      contentType: type,
      size,
      uploaderLogin: uploader,
      storage: "s3",
    });
    return { ok: true, row };
  } catch (err) {
    await deleteObjectQuietly(store, key);
    log.error(`[issue-attachments] Failed to record attachment ${name}: ${err}`);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
}

async function deleteObjectQuietly(store: S3Client, key: string): Promise<void> {
  try {
    await store.deleteObject(key);
  } catch (err) {
    log.warn(`[issue-attachments] Failed to remove S3 object ${key}: ${err}`);
  }
}

/** Store a fully-buffered upload (≤ `MAX_UPLOAD_BYTES`); a null `issueId` makes it pending. */
export async function storeIssueAttachment(
  issueId: string | null,
  name: string,
  data: Buffer,
  contentType: string | undefined,
  uploader: string,
): Promise<StoreAttachmentResult> {
  const owner = issueId ?? PENDING_DIR;
  const store = objectStore();
  const saved = saveUploadToDir(store ? spoolDir() : issueAttachmentDir(owner), name, data, logStoreError(owner));
  if (!saved.ok) return saved;
  if (store) return recordUploaded(store, issueId, name, saved.path, data.byteLength, contentType, uploader);
  return recordStored(issueId, name, saved.path, data.byteLength, contentType, uploader);
}

/** {@link storeIssueAttachment} for a streamed body of up to `MAX_LARGE_UPLOAD_BYTES`. */
export async function storeIssueAttachmentStream(
  issueId: string | null,
  name: string,
  source: Readable,
  contentType: string | undefined,
  uploader: string,
): Promise<StoreAttachmentResult> {
  const owner = issueId ?? PENDING_DIR;
  const store = objectStore();
  // Bound for S3, the body spools to tmp first: the PUT needs its length.
  const saved = await saveUploadStreamToDir(store ? spoolDir() : issueAttachmentDir(owner), name, source, logStoreError(owner));
  if (!saved.ok) return saved;
  let size: number;
  try {
    size = fs.statSync(saved.path).size;
  } catch (err) {
    unlinkQuietly(saved.path);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
  if (store) return recordUploaded(store, issueId, name, saved.path, size, contentType, uploader);
  return recordStored(issueId, name, saved.path, size, contentType, uploader);
}

/**
 * The absolute path behind a stored-relative one, or null when it would land
 * outside the store — a tampered or corrupted row must not read arbitrary files.
 */
function resolveStoredPath(storedPath: string): string | null {
  return resolveIssueAttachmentPath(WORK_DIR, storedPath);
}

/**
 * Where a row's bytes are, or null when the row names a location it must not:
 * a stored path escaping the local store, or a key outside the row's own
 * `<id>/` prefix — a tampered or corrupted row must not read arbitrary files.
 */
function sourceFor(row: db.ClawsIssueAttachmentRow): AttachmentSource | null {
  if (row.storage === "s3") {
    return row.stored_path.startsWith(`${row.id}/`) ? { kind: "s3", key: row.stored_path } : null;
  }
  const absolutePath = resolveStoredPath(row.stored_path);
  return absolutePath ? { kind: "fs", absolutePath } : null;
}

/** An attachment's row and where its bytes are, or undefined when the row is missing or unsafe. */
export async function readIssueAttachment(id: string): Promise<FoundAttachment | undefined> {
  const row = await db.getClawsIssueAttachment(id);
  if (!row) return undefined;
  const source = sourceFor(row);
  if (!source) {
    log.warn(`[issue-attachments] Refusing ${id}: stored location escapes the store (${row.stored_path})`);
    return undefined;
  }
  return { row, source };
}

/**
 * An attachment's bytes as a stream with their length, or null when the file
 * or object is gone. Throws when the bucket cannot be reached, or holds the
 * object but `ATTACHMENTS_S3` is not configured in this process.
 */
export async function openIssueAttachment(
  found: FoundAttachment,
  signal?: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
  if (found.source.kind === "fs") {
    let size: number;
    try {
      size = fs.statSync(found.source.absolutePath).size;
    } catch {
      return null;
    }
    const body = Readable.toWeb(fs.createReadStream(found.source.absolutePath)) as unknown as ReadableStream<Uint8Array>;
    return { body, size };
  }
  const store = objectStore();
  if (!store) throw new Error(`attachment ${found.row.id} is in S3 but CLAWS_ATTACHMENTS_S3_* is not configured`);
  const obj = await store.getObjectStream(found.source.key, signal);
  if (!obj.body) return null;
  return { body: obj.body, size: obj.contentLength ?? found.row.size };
}

/**
 * An attachment's whole content. A missing file or object throws an error
 * whose `code` is `ENOENT`, as `fs.readFile` does.
 */
export async function readIssueAttachmentBytes(found: FoundAttachment): Promise<Buffer> {
  const opened = await openIssueAttachment(found);
  if (!opened) throw Object.assign(new Error(`attachment ${found.row.id} file missing`), { code: "ENOENT" });
  return Buffer.from(await new Response(opened.body).arrayBuffer());
}

/**
 * An attachment's bytes as a `Response`: off the local store or the bucket,
 * or in an agent pod through the service (`db.remoteAttachmentReader`). The
 * caller has already checked the row belongs to the issue being processed.
 */
export async function attachmentFileResponse(found: FoundAttachment, signal?: AbortSignal): Promise<Response> {
  const reader = db.remoteAttachmentReader();
  if (reader) return reader(found.row.id, signal);
  let opened: Awaited<ReturnType<typeof openIssueAttachment>>;
  try {
    opened = await openIssueAttachment(found, signal);
  } catch (err) {
    log.warn(`[issue-attachments] Failed to read ${found.row.id}: ${err}`);
    return new Response("attachment store unavailable", { status: 502 });
  }
  if (!opened) return new Response("attachment file missing", { status: 404 });
  return new Response(opened.body, {
    status: 200,
    headers: { "content-type": found.row.content_type, "content-length": String(opened.size) },
  });
}

/** Remove a row's bytes: its file, or its object when this process can reach the bucket. */
async function removeStoredBytes(row: db.ClawsIssueAttachmentRow): Promise<void> {
  const source = sourceFor(row);
  if (!source) return;
  if (source.kind === "fs") {
    unlinkQuietly(source.absolutePath);
    return;
  }
  const store = objectStore();
  if (store) await deleteObjectQuietly(store, source.key);
  else log.warn(`[issue-attachments] Cannot remove S3 object ${source.key}: CLAWS_ATTACHMENTS_S3_* is not configured`);
}

/** Remove an attachment's row, then its file or object. Returns false when the row was already gone. */
export async function deleteIssueAttachment(id: string): Promise<boolean> {
  const row = await db.getClawsIssueAttachment(id);
  if (!row) return false;
  await db.deleteClawsIssueAttachment(id);
  await removeStoredBytes(row);
  return true;
}

/**
 * Remove every file and object stored for `issueId`. The rows go with the
 * issue through the `ON DELETE CASCADE` foreign key, so an issue-delete route
 * must call this before the row delete — the S3 keys are read from the rows.
 * There is no such route yet (docs/issue-tracker.md).
 */
export async function deleteIssueAttachmentFiles(issueId: string): Promise<void> {
  if (!isClawsIssueId(issueId)) return;
  try {
    for (const row of await db.listClawsIssueAttachments(issueId)) {
      if (row.storage === "s3") await removeStoredBytes(row);
    }
  } catch (err) {
    log.warn(`[issue-attachments] Failed to remove S3 objects for ${issueId}: ${err}`);
  }
  try {
    fs.rmSync(issueAttachmentDir(issueId), { recursive: true, force: true });
  } catch (err) {
    log.warn(`[issue-attachments] Failed to remove files for ${issueId}: ${err}`);
  }
}

/**
 * Hand pending uploads to a newly created issue: claim the rows, then move
 * each local file from `pending/` into the issue's directory and repoint the
 * row. An S3 object's key does not name its issue, so only its row changes.
 * Returns the rows claimed, with their new `stored_path`. A file that cannot
 * be moved stays where it is and keeps working — only the directory differs.
 */
export async function claimPendingAttachments(ids: readonly string[], issueId: string): Promise<db.ClawsIssueAttachmentRow[]> {
  if (ids.length === 0) return [];
  const claimed = await db.claimPendingClawsIssueAttachments(ids, issueId);
  const out: db.ClawsIssueAttachmentRow[] = [];
  for (const row of claimed) {
    if (row.storage === "s3") {
      out.push(row);
      continue;
    }
    const from = resolveStoredPath(row.stored_path);
    if (!from) {
      out.push(row);
      continue;
    }
    try {
      const dir = ensureUploadDir(issueAttachmentDir(issueId));
      const to = path.join(dir, path.basename(from));
      fs.renameSync(from, to);
      const storedPath = path.relative(WORK_DIR, to);
      await db.setClawsIssueAttachmentStoredPath(row.id, storedPath);
      out.push({ ...row, stored_path: storedPath });
    } catch (err) {
      log.warn(`[issue-attachments] Failed to move ${row.id} into ${issueId}: ${err}`);
      out.push(row);
    }
  }
  return out;
}

/** Remove pending uploads (row and file) older than {@link PENDING_TTL_MS}. Never throws. */
export async function sweepPendingAttachments(now: number = Date.now()): Promise<number> {
  try {
    const cutoff = new Date(now - PENDING_TTL_MS).toISOString().slice(0, 19).replace("T", " ");
    const stale = await db.listPendingClawsIssueAttachmentsOlderThan(cutoff);
    for (const row of stale) await deleteIssueAttachment(row.id);
    return stale.length;
  } catch (err) {
    log.warn(`[issue-attachments] Pending sweep failed: ${err}`);
    return 0;
  }
}

/**
 * Move every `fs` attachment into the bucket: upload the file, flip the row to
 * `s3`, then remove the local copy. A file that fails is logged and left on
 * the filesystem, where it keeps working, and is retried on the next boot.
 * A row whose file is already gone is skipped the same way. Never throws;
 * a no-op without `ATTACHMENTS_S3`.
 */
export async function migrateFsAttachmentsToS3(): Promise<{ migrated: number; failed: number }> {
  const store = objectStore();
  if (!store) return { migrated: 0, failed: 0 };
  let rows: db.ClawsIssueAttachmentRow[];
  try {
    rows = await db.listAttachmentsByStorage("fs");
  } catch (err) {
    log.warn(`[issue-attachments] S3 migration could not list attachments: ${err}`);
    return { migrated: 0, failed: 0 };
  }
  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    const file = resolveStoredPath(row.stored_path);
    try {
      if (!file) throw new Error(`stored path escapes the store (${row.stored_path})`);
      const size = fs.statSync(file).size;
      const key = objectKey(row.id, row.filename);
      await store.putObjectFromFile(key, file, size, row.content_type);
      await db.setClawsIssueAttachmentStorage(row.id, "s3", key);
      unlinkQuietly(file);
      migrated++;
    } catch (err) {
      failed++;
      log.warn(`[issue-attachments] S3 migration of ${row.id} failed; retrying next boot: ${err}`);
    }
  }
  if (rows.length > 0) log.info(`[issue-attachments] S3 migration: ${migrated} moved, ${failed} left on the filesystem`);
  return { migrated, failed };
}

/** The site-relative URL a body links to and the serve route answers on. */
export function attachmentUrl(row: Pick<db.ClawsIssueAttachmentRow, "id" | "issue_id" | "filename">): string {
  const owner = row.issue_id ?? PENDING_URL_SEGMENT;
  return `/issues/${owner}/attachments/${row.id}/${encodeURIComponent(row.filename)}`;
}

const ATTACHMENT_ID_BODY = "[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}";
const ATTACHMENT_PATH_RE = new RegExp(
  `^/issues/(new|[cC][lL][wW]_${ATTACHMENT_ID_BODY})/attachments/([cC][lL][aA]_${ATTACHMENT_ID_BODY})(?:/[^/]*)?$`,
);

/**
 * The issue and attachment an attachment URL names, relative (`/issues/…`) or
 * absolute (any host), or null when the path is not one. Ids come back
 * canonical: `clw_`/`cla_` prefix with an upper-case body.
 */
export function parseAttachmentUrl(url: string): { issueId: string; attachmentId: string } | null {
  let pathname: string;
  if (url.startsWith("/")) {
    pathname = url.split(/[?#]/)[0]!;
  } else {
    try {
      pathname = new URL(url).pathname;
    } catch {
      return null;
    }
  }
  const match = ATTACHMENT_PATH_RE.exec(pathname);
  if (!match) return null;
  const rawIssue = match[1]!;
  const issueId = rawIssue === PENDING_URL_SEGMENT ? PENDING_URL_SEGMENT : canonicalIssueRef(rawIssue);
  if (typeof issueId !== "string") return null;
  return { issueId, attachmentId: `cla_${match[2]!.slice(4).toUpperCase()}` };
}

/** Image types a browser may render inline. SVG is deliberately absent — it is a script carrier. */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SERVABLE_TYPES = new Set([...INLINE_IMAGE_TYPES, "application/pdf", "application/zip", "application/gzip", "text/plain"]);

/**
 * The `Content-Type` to serve a file with: the stored type when it is on the
 * allowlist, otherwise `application/octet-stream`. Types are never sniffed, so
 * an HTML or SVG upload can only ever download.
 */
export function serveContentType(row: Pick<db.ClawsIssueAttachmentRow, "content_type">): string {
  const type = normaliseContentType(row.content_type);
  if (SERVABLE_TYPES.has(type) || type.startsWith("audio/") || type.startsWith("video/")) return type;
  return "application/octet-stream";
}

/** True when the file is an image the pages and agents may show inline. */
export function isInlineImage(row: Pick<db.ClawsIssueAttachmentRow, "content_type">): boolean {
  return INLINE_IMAGE_TYPES.has(serveContentType(row));
}

/** `inline` for allowlisted images and PDF, `attachment` for everything else. */
export function contentDisposition(row: Pick<db.ClawsIssueAttachmentRow, "content_type" | "filename">): string {
  const type = serveContentType(row);
  const disposition = INLINE_IMAGE_TYPES.has(type) || type === "application/pdf" ? "inline" : "attachment";
  // `filename` is already sanitised to [A-Za-z0-9._-]; re-sanitise so a row
  // written by something else still cannot break out of the quotes.
  return `${disposition}; filename="${sanitizeUploadFilename(row.filename)}"`;
}
