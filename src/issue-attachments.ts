/**
 * Files attached to Claws-native issues (#3289, docs/issue-tracker.md).
 *
 * The bytes live under `WORK_DIR/issue-attachments/<issueId>/`, written by the
 * same helpers the session upload store uses; `db.ts`' `claws_issue_attachments`
 * table records what each file is and which issue owns it. Uploads made on the
 * New Issue form before the issue exists go under `pending/` with a NULL
 * `issue_id`, and {@link claimPendingAttachments} moves them across once it does.
 *
 * Everything that links to a file uses the site-relative URL from
 * {@link attachmentUrl}, never `DASHBOARD_URL`, so a stored body survives a
 * host or domain move.
 *
 * An agent pod has no store of its own: {@link attachmentFileResponse} reads
 * the bytes through the service's agent-pod API instead of the local disk.
 */

import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { WORK_DIR } from "./config.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { canonicalIssueRef, isClawsIssueId } from "./issue-id.js";
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

function storeRoot(): string {
  return path.join(WORK_DIR, ISSUE_ATTACHMENT_STORE);
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
function normaliseContentType(contentType: string | undefined): string {
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

/** Store a fully-buffered upload (≤ `MAX_UPLOAD_BYTES`); a null `issueId` makes it pending. */
export async function storeIssueAttachment(
  issueId: string | null,
  name: string,
  data: Buffer,
  contentType: string | undefined,
  uploader: string,
): Promise<StoreAttachmentResult> {
  const owner = issueId ?? PENDING_DIR;
  const saved = saveUploadToDir(issueAttachmentDir(owner), name, data, logStoreError(owner));
  if (!saved.ok) return saved;
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
  const saved = await saveUploadStreamToDir(issueAttachmentDir(owner), name, source, logStoreError(owner));
  if (!saved.ok) return saved;
  let size: number;
  try {
    size = fs.statSync(saved.path).size;
  } catch (err) {
    unlinkQuietly(saved.path);
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
  return recordStored(issueId, name, saved.path, size, contentType, uploader);
}

/**
 * The absolute path behind a stored-relative one, or null when it would land
 * outside the store — a tampered or corrupted row must not read arbitrary files.
 */
function resolveStoredPath(storedPath: string): string | null {
  return resolveIssueAttachmentPath(WORK_DIR, storedPath);
}

/** An attachment's row and the file behind it, or undefined when either is missing or unsafe. */
export async function readIssueAttachment(id: string): Promise<{ row: db.ClawsIssueAttachmentRow; absolutePath: string } | undefined> {
  const row = await db.getClawsIssueAttachment(id);
  if (!row) return undefined;
  const absolutePath = resolveStoredPath(row.stored_path);
  if (!absolutePath) {
    log.warn(`[issue-attachments] Refusing ${id}: stored path escapes the store (${row.stored_path})`);
    return undefined;
  }
  return { row, absolutePath };
}

/**
 * An attachment's bytes as a `Response`: off the local store, or in an agent
 * pod through the service (`db.remoteAttachmentReader`). The caller has
 * already checked the row belongs to the issue being processed.
 */
export async function attachmentFileResponse(
  found: { row: db.ClawsIssueAttachmentRow; absolutePath: string },
  signal?: AbortSignal,
): Promise<Response> {
  const reader = db.remoteAttachmentReader();
  if (reader) return reader(found.row.id, signal);
  let blob: Blob;
  try {
    blob = await fs.openAsBlob(found.absolutePath);
  } catch {
    return new Response("attachment file missing", { status: 404 });
  }
  return new Response(blob, {
    status: 200,
    headers: { "content-type": found.row.content_type, "content-length": String(blob.size) },
  });
}

/** Remove an attachment's row, then its file. Returns false when the row was already gone. */
export async function deleteIssueAttachment(id: string): Promise<boolean> {
  const row = await db.getClawsIssueAttachment(id);
  if (!row) return false;
  await db.deleteClawsIssueAttachment(id);
  const file = resolveStoredPath(row.stored_path);
  if (file) unlinkQuietly(file);
  return true;
}

/**
 * Remove every file stored for `issueId`. The rows go with the issue through
 * the `ON DELETE CASCADE` foreign key, so an issue-delete route must call this
 * alongside the row delete — there is no such route yet (docs/issue-tracker.md).
 */
export function deleteIssueAttachmentFiles(issueId: string): void {
  if (!isClawsIssueId(issueId)) return;
  try {
    fs.rmSync(issueAttachmentDir(issueId), { recursive: true, force: true });
  } catch (err) {
    log.warn(`[issue-attachments] Failed to remove files for ${issueId}: ${err}`);
  }
}

/**
 * Hand pending uploads to a newly created issue: claim the rows, then move
 * each file from `pending/` into the issue's directory and repoint the row.
 * Returns the rows claimed, with their new `stored_path`. A file that cannot
 * be moved stays where it is and keeps working — only the directory differs.
 */
export async function claimPendingAttachments(ids: readonly string[], issueId: string): Promise<db.ClawsIssueAttachmentRow[]> {
  if (ids.length === 0) return [];
  const claimed = await db.claimPendingClawsIssueAttachments(ids, issueId);
  const out: db.ClawsIssueAttachmentRow[] = [];
  for (const row of claimed) {
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
