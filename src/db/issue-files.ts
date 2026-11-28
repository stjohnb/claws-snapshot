// Issue attachments, published session files and session attachments
// (rows only). Reached only through the src/db.ts façade.
import { newClawsAttachmentId, newClawsSessionFileId } from "../issue-id.js";
import { getDb, nowSql } from "./core.js";

// ── Attachments (#3289) ──
//
// Rows only: `issue-attachments.ts` owns the files (on disk or in S3) and is
// the only caller, so a row and its file are always written and removed together.

/** Where an attachment's bytes live: the local store or the attachments S3 bucket. */
export type AttachmentStorage = "fs" | "s3";

export interface ClawsIssueAttachmentRow {
  id: string;
  /** NULL while the upload is pending on an unsaved New Issue form. */
  issue_id: string | null;
  /** The comment whose body links the file, once one does. */
  comment_id: string | null;
  /** The original filename, sanitised. */
  filename: string;
  /** Relative to WORK_DIR when `storage` is `fs`; the object key when it is `s3`. */
  stored_path: string;
  content_type: string;
  size: number;
  uploader_login: string;
  created_at: string;
  /** Absent (a row built by an older writer) means `fs`. */
  storage?: AttachmentStorage;
}

/** Normalise a row read back from either driver — Postgres may widen `size` to a string. */
function toAttachmentRow(row: ClawsIssueAttachmentRow): ClawsIssueAttachmentRow {
  return { ...row, size: Number(row.size) };
}

/** Record a stored file and return its new id. */
export async function insertClawsIssueAttachment(input: {
  /** Pre-minted id, for an S3 object whose key embeds it; minted here when absent. */
  id?: string;
  issueId: string | null;
  filename: string;
  storedPath: string;
  contentType: string;
  size: number;
  uploaderLogin: string;
  storage?: AttachmentStorage;
}): Promise<ClawsIssueAttachmentRow> {
  const row: ClawsIssueAttachmentRow = {
    id: input.id ?? newClawsAttachmentId(),
    issue_id: input.issueId,
    comment_id: null,
    filename: input.filename,
    stored_path: input.storedPath,
    content_type: input.contentType,
    size: input.size,
    uploader_login: input.uploaderLogin,
    created_at: nowSql(),
    storage: input.storage ?? "fs",
  };
  await getDb().run(
    `INSERT INTO claws_issue_attachments (id, issue_id, comment_id, filename, stored_path, content_type, size, uploader_login, created_at, storage)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.issue_id, row.filename, row.stored_path, row.content_type, row.size, row.uploader_login, row.created_at, row.storage],
  );
  return row;
}

export async function getClawsIssueAttachment(id: string): Promise<ClawsIssueAttachmentRow | undefined> {
  const row = await getDb().get(`SELECT * FROM claws_issue_attachments WHERE id = ?`, [id]) as ClawsIssueAttachmentRow | undefined;
  return row ? toAttachmentRow(row) : undefined;
}

/**
 * How to read an attachment's bytes when they are not on this process's disk,
 * or null when they are. The service reads its own store; `db-remote.ts`
 * overrides this in an agent pod, whose HOME has no `issue-attachments/`.
 */
export function remoteAttachmentReader(): ((attachmentId: string, signal?: AbortSignal) => Promise<Response>) | null {
  return null;
}

/** An issue's attachments in upload order — ids are monotonic ULIDs. */
export async function listClawsIssueAttachments(issueId: string): Promise<ClawsIssueAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_attachments WHERE issue_id = ? ORDER BY id ASC`,
    [issueId],
  ) as ClawsIssueAttachmentRow[];
  return rows.map(toAttachmentRow);
}

/**
 * Assign pending rows to `issueId` and return the rows claimed. A row that
 * already belongs to an issue is left alone, so a hand-edited form cannot move
 * another issue's file.
 */
export async function claimPendingClawsIssueAttachments(ids: readonly string[], issueId: string): Promise<ClawsIssueAttachmentRow[]> {
  const claimed: ClawsIssueAttachmentRow[] = [];
  await getDb().transaction(async (tx) => {
    for (const id of new Set(ids)) {
      const res = await tx.run(`UPDATE claws_issue_attachments SET issue_id = ? WHERE id = ? AND issue_id IS NULL`, [issueId, id]);
      if (res.changes === 0) continue;
      const row = await tx.get(`SELECT * FROM claws_issue_attachments WHERE id = ?`, [id]) as ClawsIssueAttachmentRow | undefined;
      if (row) claimed.push(toAttachmentRow(row));
    }
  });
  return claimed;
}

/** Point a row at a new file location — the pending-to-issue move. */
export async function setClawsIssueAttachmentStoredPath(id: string, storedPath: string): Promise<void> {
  await getDb().run(`UPDATE claws_issue_attachments SET stored_path = ? WHERE id = ?`, [storedPath, id]);
}

/** Move a row to another store — the filesystem-to-S3 migration. */
export async function setClawsIssueAttachmentStorage(id: string, storage: AttachmentStorage, storedPath: string): Promise<void> {
  await getDb().run(`UPDATE claws_issue_attachments SET storage = ?, stored_path = ? WHERE id = ?`, [storage, storedPath, id]);
}

/** Every row whose bytes live in `storage`, oldest first. */
export async function listAttachmentsByStorage(storage: AttachmentStorage): Promise<ClawsIssueAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_attachments WHERE storage = ? ORDER BY id ASC`,
    [storage],
  ) as ClawsIssueAttachmentRow[];
  return rows.map(toAttachmentRow);
}

export async function setClawsIssueAttachmentComment(id: string, commentId: string): Promise<void> {
  await getDb().run(`UPDATE claws_issue_attachments SET comment_id = ? WHERE id = ?`, [commentId, id]);
}

/** Remove a row. Returns false when it was already gone. */
export async function deleteClawsIssueAttachment(id: string): Promise<boolean> {
  return (await getDb().run(`DELETE FROM claws_issue_attachments WHERE id = ?`, [id])).changes > 0;
}

/** Pending rows created before `cutoff` (a stored `YYYY-MM-DD HH:MM:SS` UTC time). */
export async function listPendingClawsIssueAttachmentsOlderThan(cutoff: string): Promise<ClawsIssueAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_attachments WHERE issue_id IS NULL AND created_at < ? ORDER BY id ASC`,
    [cutoff],
  ) as ClawsIssueAttachmentRow[];
  return rows.map(toAttachmentRow);
}

// ── Published session files ──
//
// Rows only: `session-files.ts` owns the files on disk and is the only caller,
// so a row and its file are always written and removed together.

export interface SessionFileRow {
  id: string;
  session_id: string;
  /** The published name, sanitised. */
  filename: string;
  /** Relative to WORK_DIR. */
  stored_path: string;
  content_type: string;
  size: number;
  created_at: string;
}

/** Record a published file and return its row. */
export async function insertSessionFile(input: {
  sessionId: string;
  filename: string;
  storedPath: string;
  contentType: string;
  size: number;
}): Promise<SessionFileRow> {
  const row: SessionFileRow = {
    id: newClawsSessionFileId(),
    session_id: input.sessionId,
    filename: input.filename,
    stored_path: input.storedPath,
    content_type: input.contentType,
    size: input.size,
    created_at: nowSql(),
  };
  await getDb().run(
    `INSERT INTO session_files (id, session_id, filename, stored_path, content_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.session_id, row.filename, row.stored_path, row.content_type, row.size, row.created_at],
  );
  return row;
}

export async function getSessionFile(id: string): Promise<SessionFileRow | undefined> {
  const row = await getDb().get(`SELECT * FROM session_files WHERE id = ?`, [id]) as SessionFileRow | undefined;
  return row ? { ...row, size: Number(row.size) } : undefined;
}

/** A session's published files in publish order — ids are monotonic ULIDs. */
export async function listSessionFiles(sessionId: string): Promise<SessionFileRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM session_files WHERE session_id = ? ORDER BY id ASC`,
    [sessionId],
  ) as SessionFileRow[];
  return rows.map((row) => ({ ...row, size: Number(row.size) }));
}

/** Remove one published file's row; returns how many went (0 or 1). */
export async function deleteSessionFile(id: string): Promise<number> {
  return (await getDb().run(`DELETE FROM session_files WHERE id = ?`, [id])).changes;
}

/** Remove every row for a session; returns how many went. */
export async function deleteSessionFilesForSession(sessionId: string): Promise<number> {
  return (await getDb().run(`DELETE FROM session_files WHERE session_id = ?`, [sessionId])).changes;
}

// ── Session attachments (files staged for a new session's first message) ──
//
// Rows only: `session-attachments.ts` owns the bytes and is the only caller.

export interface SessionAttachmentRow {
  id: string;
  /** NULL while pending: staged on the form, not yet claimed by a create. */
  session_id: string | null;
  /** The uploaded name, sanitised. */
  filename: string;
  /** The file's name in the pod's uploads directory, fixed when claimed. */
  pod_name: string | null;
  /** Relative to WORK_DIR for `fs`; the bucket key for `s3`. */
  stored_path: string;
  storage: AttachmentStorage;
  content_type: string;
  size: number;
  created_at: string;
}

function toSessionAttachmentRow(row: SessionAttachmentRow): SessionAttachmentRow {
  return { ...row, size: Number(row.size) };
}

/** Record a staged (pending) attachment and return its row. */
export async function insertSessionAttachment(input: {
  id: string;
  filename: string;
  storedPath: string;
  storage: AttachmentStorage;
  contentType: string;
  size: number;
}): Promise<SessionAttachmentRow> {
  const row: SessionAttachmentRow = {
    id: input.id,
    session_id: null,
    filename: input.filename,
    pod_name: null,
    stored_path: input.storedPath,
    storage: input.storage,
    content_type: input.contentType,
    size: input.size,
    created_at: nowSql(),
  };
  await getDb().run(
    `INSERT INTO session_attachments (id, session_id, filename, pod_name, stored_path, storage, content_type, size, created_at)
     VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
    [row.id, row.filename, row.stored_path, row.storage, row.content_type, row.size, row.created_at],
  );
  return row;
}

export async function getSessionAttachment(id: string): Promise<SessionAttachmentRow | undefined> {
  const row = await getDb().get(`SELECT * FROM session_attachments WHERE id = ?`, [id]) as SessionAttachmentRow | undefined;
  return row ? toSessionAttachmentRow(row) : undefined;
}

/** A session's attachments in staging order — ids are monotonic ULIDs. */
export async function listSessionAttachments(sessionId: string): Promise<SessionAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM session_attachments WHERE session_id = ? ORDER BY id ASC`,
    [sessionId],
  ) as SessionAttachmentRow[];
  return rows.map(toSessionAttachmentRow);
}

/**
 * Claim pending rows for a session, each with its pod name: a row is claimed
 * only while its `session_id` is still NULL, so one staged file can never go
 * to two sessions. Returns the rows claimed, in the order given.
 */
export async function claimPendingSessionAttachments(
  claims: ReadonlyArray<{ id: string; podName: string }>,
  sessionId: string,
): Promise<SessionAttachmentRow[]> {
  const claimed: SessionAttachmentRow[] = [];
  await getDb().transaction(async (tx) => {
    for (const { id, podName } of claims) {
      const res = await tx.run(
        `UPDATE session_attachments SET session_id = ?, pod_name = ? WHERE id = ? AND session_id IS NULL`,
        [sessionId, podName, id],
      );
      if (res.changes === 0) continue;
      const row = await tx.get(`SELECT * FROM session_attachments WHERE id = ?`, [id]) as SessionAttachmentRow | undefined;
      if (row) claimed.push(toSessionAttachmentRow(row));
    }
  });
  return claimed;
}

/** Hand a session's claimed rows back to pending — a create that failed after claiming. */
export async function releaseSessionAttachments(sessionId: string): Promise<number> {
  return (await getDb().run(
    `UPDATE session_attachments SET session_id = NULL, pod_name = NULL WHERE session_id = ?`,
    [sessionId],
  )).changes;
}

/** Pending rows created before `cutoff` (a stored `YYYY-MM-DD HH:MM:SS` UTC time). */
export async function listPendingSessionAttachmentsOlderThan(cutoff: string): Promise<SessionAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM session_attachments WHERE session_id IS NULL AND created_at < ? ORDER BY id ASC`,
    [cutoff],
  ) as SessionAttachmentRow[];
  return rows.map(toSessionAttachmentRow);
}

export async function deleteSessionAttachmentRow(id: string): Promise<void> {
  await getDb().run(`DELETE FROM session_attachments WHERE id = ?`, [id]);
}

/** Remove every row for a session; returns how many went. */
export async function deleteSessionAttachmentsForSession(sessionId: string): Promise<number> {
  return (await getDb().run(`DELETE FROM session_attachments WHERE session_id = ?`, [sessionId])).changes;
}

