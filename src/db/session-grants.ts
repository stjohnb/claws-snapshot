// Session capability requests and the AWS grants sessions hold. Reached only
// through the src/db.ts façade.
import { getDb, timedDb } from "./core.js";

/** A row of `session_capability_requests`. */
export interface SessionCapabilityRequestRow {
  session_id: string;
  capability: string;
  status: string;
  reason: string;
  requested_at: number;
  decided_at: number | null;
  /** When the agent last hit a request route for the pair. */
  last_polled_at: number | null;
  /** When a request route last returned the pair to the agent as granted. */
  grant_seen_at: number | null;
  /** `auto` or `operator` once decided; null while pending or on a legacy row. */
  decided_by: string | null;
}

const CAPABILITY_REQUEST_COLUMNS = "session_id, capability, status, reason, requested_at, decided_at, last_polled_at, grant_seen_at, decided_by";

function toSessionCapabilityRequestRow(row: SessionCapabilityRequestRow): SessionCapabilityRequestRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ...row,
    requested_at: Number(row.requested_at),
    decided_at: num(row.decided_at),
    last_polled_at: num(row.last_polled_at),
    grant_seen_at: num(row.grant_seen_at),
    decided_by: row.decided_by ?? null,
  };
}

/** Insert or replace the stored request for a (session, capability) pair;
 *  a revoke uses it to store a denial whether or not a request existed. */
export async function upsertSessionCapabilityRequest(row: SessionCapabilityRequestRow): Promise<void> {
  await getDb().run(`
    INSERT INTO session_capability_requests (${CAPABILITY_REQUEST_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, capability) DO UPDATE SET
      status = excluded.status, reason = excluded.reason,
      requested_at = excluded.requested_at, decided_at = excluded.decided_at,
      last_polled_at = excluded.last_polled_at, grant_seen_at = excluded.grant_seen_at,
      decided_by = excluded.decided_by
  `, [row.session_id, row.capability, row.status, row.reason, row.requested_at, row.decided_at, row.last_polled_at, row.grant_seen_at, row.decided_by ?? null]);
}

/** Insert a request unless the pair already has one; true when this call inserted it. */
export async function insertSessionCapabilityRequestIfAbsent(row: SessionCapabilityRequestRow): Promise<boolean> {
  const { changes } = await getDb().run(`
    INSERT INTO session_capability_requests (${CAPABILITY_REQUEST_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, capability) DO NOTHING
  `, [row.session_id, row.capability, row.status, row.reason, row.requested_at, row.decided_at, row.last_polled_at, row.grant_seen_at, row.decided_by ?? null]);
  return changes > 0;
}

/** The stored request for a (session, capability) pair, if any. */
export async function getSessionCapabilityRequest(sessionId: string, capability: string): Promise<SessionCapabilityRequestRow | undefined> {
  const row = await getDb().get<SessionCapabilityRequestRow>(
    `SELECT ${CAPABILITY_REQUEST_COLUMNS} FROM session_capability_requests WHERE session_id = ? AND capability = ?`,
    [sessionId, capability],
  );
  return row ? toSessionCapabilityRequestRow(row) : undefined;
}

/** Every stored request of one session, oldest first. */
export async function listSessionCapabilityRequests(sessionId: string): Promise<SessionCapabilityRequestRow[]> {
  const rows = await getDb().all<SessionCapabilityRequestRow>(
    `SELECT ${CAPABILITY_REQUEST_COLUMNS} FROM session_capability_requests WHERE session_id = ? ORDER BY requested_at, capability`,
    [sessionId],
  );
  return rows.map(toSessionCapabilityRequestRow);
}

/** Every pending stored request across all sessions, oldest first. */
export async function listPendingSessionCapabilityRequests(): Promise<SessionCapabilityRequestRow[]> {
  const rows = await getDb().all<SessionCapabilityRequestRow>(
    `SELECT ${CAPABILITY_REQUEST_COLUMNS} FROM session_capability_requests WHERE status = 'pending' ORDER BY requested_at, capability`,
  );
  return rows.map(toSessionCapabilityRequestRow);
}

/**
 * Set a stored request's status, decision time and decider (`decidedBy`,
 * default `operator`). With `onlyIfPending` the
 * update applies only to a pending request, so two processes deciding the same
 * request at once cannot both win. True when a row changed.
 */
export async function setSessionCapabilityRequestStatus(
  sessionId: string,
  capability: string,
  status: string,
  decidedAt: number,
  opts: { onlyIfPending?: boolean; decidedBy?: string } = {},
): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_capability_requests SET status = ?, decided_at = ?, decided_by = ? WHERE session_id = ? AND capability = ?${opts.onlyIfPending ? " AND status = 'pending'" : ""}`,
    [status, decidedAt, opts.decidedBy ?? "operator", sessionId, capability],
  );
  return changes > 0;
}

/** Record when the agent last polled, or last collected a grant for, a stored request; nothing without one. */
export async function markSessionCapabilityRequest(
  sessionId: string,
  capability: string,
  column: "last_polled_at" | "grant_seen_at",
  at: number,
): Promise<void> {
  await getDb().run(`UPDATE session_capability_requests SET ${column} = ? WHERE session_id = ? AND capability = ?`, [at, sessionId, capability]);
}

/** Delete a session's stored request for one capability, or every one of its
 *  requests when `capability` is omitted. */
export async function deleteSessionCapabilityRequest(sessionId: string, capability?: string): Promise<void> {
  if (capability === undefined) {
    await getDb().run(`DELETE FROM session_capability_requests WHERE session_id = ?`, [sessionId]);
    return;
  }
  await getDb().run(`DELETE FROM session_capability_requests WHERE session_id = ? AND capability = ?`, [sessionId, capability]);
}

/** Delete the stored requests of sessions that have ended or no longer exist;
 *  returns how many rows went. */
export async function pruneSessionCapabilityRequestsForEndedSessions(): Promise<number> {
  return timedDb("prune-session-capability-requests-for-ended-sessions", () => pruneSessionCapabilityRequestsForEndedSessionsUntimed());
}

async function pruneSessionCapabilityRequestsForEndedSessionsUntimed(): Promise<number> {
  const { changes } = await getDb().run(`
    DELETE FROM session_capability_requests
    WHERE session_id NOT IN (SELECT id FROM sessions WHERE ended_at IS NULL)
  `);
  return changes;
}

/**
 * Lifecycle of a `session_aws_grants` row. `granting` is the claim a sign-in
 * takes just before it writes credentials into the pod, so a cancel, deny or
 * expiry sweep (which act only on `awaiting-signin`) can no longer race the
 * write. `revoking` is a `granting` row a cancel, deny, revoke or session end
 * stopped: its credentials may be in the pod, so it stays where the sweep
 * looks until a take-back is confirmed. A row leaves `granting`/`revoking`
 * only once it is `active` or a take-back confirmed the pod holds nothing of it.
 */
export type SessionAwsGrantStatus = "awaiting-signin" | "granting" | "revoking" | "active" | "ended" | "failed";

/** A row of `session_aws_grants` (#clw_01M8426RTMG1TWE224NXW1V02S). */
export interface SessionAwsGrantRow {
  id: string;
  session_id: string;
  capability: string;
  permission_set: string;
  account_id: string;
  status: SessionAwsGrantStatus;
  /** The device sign-in link, only while `awaiting-signin`. */
  verification_url: string | null;
  /** The device user code, only while `awaiting-signin`. */
  user_code: string | null;
  /** When the device code expires (ms). */
  device_expires_at: number | null;
  /** Who approved the grant: the signed-in dashboard user, or `operator`. */
  granted_by: string;
  created_at: number;
  granted_at: number | null;
  credentials_expire_at: number | null;
  ended_at: number | null;
  /** Why an `ended` row ended, or why a `failed` sign-in failed. */
  end_reason: string | null;
}

const AWS_GRANT_COLUMNS = "id, session_id, capability, permission_set, account_id, status, verification_url, user_code, device_expires_at, granted_by, created_at, granted_at, credentials_expire_at, ended_at, end_reason";

function toSessionAwsGrantRow(row: SessionAwsGrantRow): SessionAwsGrantRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ...row,
    verification_url: row.verification_url ?? null,
    user_code: row.user_code ?? null,
    device_expires_at: num(row.device_expires_at),
    created_at: Number(row.created_at),
    granted_at: num(row.granted_at),
    credentials_expire_at: num(row.credentials_expire_at),
    ended_at: num(row.ended_at),
    end_reason: row.end_reason ?? null,
  };
}

/** Store a new `awaiting-signin` grant row. */
export async function insertSessionAwsGrant(row: SessionAwsGrantRow): Promise<void> {
  await getDb().run(
    `INSERT INTO session_aws_grants (${AWS_GRANT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.session_id, row.capability, row.permission_set, row.account_id, row.status, row.verification_url, row.user_code,
      row.device_expires_at, row.granted_by, row.created_at, row.granted_at, row.credentials_expire_at, row.ended_at, row.end_reason],
  );
}

/** One grant row by id. */
export async function getSessionAwsGrant(id: string): Promise<SessionAwsGrantRow | undefined> {
  const row = await getDb().get<SessionAwsGrantRow>(`SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE id = ?`, [id]);
  return row ? toSessionAwsGrantRow(row) : undefined;
}

/** Every grant row of one session, newest first: the session page's AWS audit list. */
export async function listSessionAwsGrants(sessionId: string): Promise<SessionAwsGrantRow[]> {
  const rows = await getDb().all<SessionAwsGrantRow>(
    `SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE session_id = ? ORDER BY created_at DESC, id DESC`,
    [sessionId],
  );
  return rows.map(toSessionAwsGrantRow);
}

/** Every row still `awaiting-signin`, oldest first, across sessions (the Sessions list's sign-in links). */
export async function listAwaitingSignInAwsGrants(): Promise<SessionAwsGrantRow[]> {
  const rows = await getDb().all<SessionAwsGrantRow>(
    `SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE status = 'awaiting-signin' ORDER BY created_at, id`,
  );
  return rows.map(toSessionAwsGrantRow);
}

/** One session's rows still `awaiting-signin`, oldest first (the session page's sign-in link). */
export async function listAwaitingSignInAwsGrantsForSession(sessionId: string): Promise<SessionAwsGrantRow[]> {
  const rows = await getDb().all<SessionAwsGrantRow>(
    `SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE session_id = ? AND status = 'awaiting-signin' ORDER BY created_at, id`,
    [sessionId],
  );
  return rows.map(toSessionAwsGrantRow);
}

/**
 * One session's sign-ins not yet granted or failed — `awaiting-signin` rows and
 * `granting` rows whose credentials are being written — oldest first.
 */
export async function listOpenSignInAwsGrantsForSession(sessionId: string): Promise<SessionAwsGrantRow[]> {
  const rows = await getDb().all<SessionAwsGrantRow>(
    `SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE session_id = ? AND status IN ('awaiting-signin', 'granting') ORDER BY created_at, id`,
    [sessionId],
  );
  return rows.map(toSessionAwsGrantRow);
}

/** The session's `active` grant, if any (a session holds at most one). */
export async function getActiveSessionAwsGrant(sessionId: string): Promise<SessionAwsGrantRow | undefined> {
  const row = await getDb().get<SessionAwsGrantRow>(
    `SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE session_id = ? AND status = 'active' ORDER BY granted_at DESC LIMIT 1`,
    [sessionId],
  );
  return row ? toSessionAwsGrantRow(row) : undefined;
}

/**
 * Claim an `awaiting-signin` row as `granting` just before its credentials are
 * written into the pod, clearing its link and code; `granted_at` holds the
 * claim time until the row turns `active`. True when it was still awaiting.
 */
export async function claimSessionAwsGrantForGranting(id: string, at: number): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_aws_grants SET status = 'granting', granted_at = ?, verification_url = NULL, user_code = NULL
     WHERE id = ? AND status = 'awaiting-signin'`,
    [at, id],
  );
  return changes > 0;
}

/** Turn a `granting` row `active`. True when it was still `granting`. */
export async function markSessionAwsGrantActive(id: string, grantedAt: number, credentialsExpireAt: number): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_aws_grants SET status = 'active', granted_at = ?, credentials_expire_at = ?, verification_url = NULL, user_code = NULL
     WHERE id = ? AND status = 'granting'`,
    [grantedAt, credentialsExpireAt, id],
  );
  return changes > 0;
}

/**
 * Mark a `granting` or `revoking` row `failed` once a take-back confirmed the
 * pod holds none of its credentials: a `granting` row with `reason`, a
 * `revoking` row keeping the reason its canceller recorded. True when it was
 * still `granting` or `revoking`.
 */
export async function failGrantingSessionAwsGrant(id: string, reason: string, at: number): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_aws_grants SET status = 'failed', ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?)
     WHERE id = ? AND status IN ('granting', 'revoking')`,
    [at, reason, id],
  );
  return changes > 0;
}

/**
 * Mark a `granting` row `revoking` with `reason` (a cancel, deny, revoke or
 * session end stopped it mid-write). True when it was still `granting`.
 */
export async function revokeGrantingSessionAwsGrant(id: string, reason: string, at: number): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_aws_grants SET status = 'revoking', ended_at = ?, end_reason = ? WHERE id = ? AND status = 'granting'`,
    [at, reason, id],
  );
  return changes > 0;
}

/**
 * Leave a grant whose credentials may still be in the pod where the sweep
 * takes them back: a `granting` row becomes `revoking` with `reason`, and a
 * `failed` row that was once claimed (`granted_at` set; the sweep failed it
 * while its write was still running) goes back to `revoking`, keeping the
 * reason it was failed for. True when the row changed.
 */
export async function markAwsGrantForTakeBack(id: string, reason: string, at: number): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_aws_grants SET status = 'revoking', ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?)
     WHERE id = ? AND (status = 'granting' OR (status = 'failed' AND granted_at IS NOT NULL))`,
    [at, reason, id],
  );
  return changes > 0;
}

/**
 * `granting` and `revoking` rows claimed at or before `before` (their process
 * died mid-grant, or its take-back was not confirmed), oldest first.
 */
export async function listStaleGrantingAwsGrants(before: number): Promise<SessionAwsGrantRow[]> {
  return timedDb("list-stale-granting-aws-grants", async () => {
    const rows = await getDb().all<SessionAwsGrantRow>(
      `SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE status IN ('granting', 'revoking') AND granted_at <= ? ORDER BY granted_at, id`,
      [before],
    );
    return rows.map(toSessionAwsGrantRow);
  });
}

/** Mark an `awaiting-signin` row `failed` with `reason`, clearing its link and code. True when it was still awaiting. */
export async function failSessionAwsGrant(id: string, reason: string, at: number): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_aws_grants SET status = 'failed', ended_at = ?, end_reason = ?, verification_url = NULL, user_code = NULL
     WHERE id = ? AND status = 'awaiting-signin'`,
    [at, reason, id],
  );
  return changes > 0;
}

/**
 * End a session's open grants: `active` rows become `ended`, `awaiting-signin`
 * rows `failed` and `granting` rows `revoking` (unless `activeOnly`), all with
 * `reason`. A `granting` row made `revoking` here has its credentials taken
 * back by the process writing them, which finds its claim lost, or else by
 * the expiry sweep.
 * With `capability`, only that capability's rows; never the `except` row's
 * `active` state. Returns the rows that were `active`, as they were.
 */
export async function endOpenSessionAwsGrants(
  sessionId: string,
  reason: string,
  at: number,
  opts: { capability?: string; activeOnly?: boolean; except?: string } = {},
): Promise<SessionAwsGrantRow[]> {
  const capFilter = opts.capability === undefined ? "" : " AND capability = ?";
  const capArg = opts.capability === undefined ? [] : [opts.capability];
  const active = (await getDb().all<SessionAwsGrantRow>(
    `SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE session_id = ? AND status = 'active'${capFilter}`,
    [sessionId, ...capArg],
  )).map(toSessionAwsGrantRow).filter((row) => row.id !== opts.except);
  const ended: SessionAwsGrantRow[] = [];
  for (const row of active) {
    const { changes } = await getDb().run(
      `UPDATE session_aws_grants SET status = 'ended', ended_at = ?, end_reason = ? WHERE id = ? AND status = 'active'`,
      [at, reason, row.id],
    );
    if (changes > 0) ended.push(row);
  }
  if (opts.activeOnly) return ended;
  await getDb().run(
    `UPDATE session_aws_grants SET status = 'failed', ended_at = ?, end_reason = ?, verification_url = NULL, user_code = NULL
     WHERE session_id = ? AND status = 'awaiting-signin'${capFilter}`,
    [at, reason, sessionId, ...capArg],
  );
  await getDb().run(
    `UPDATE session_aws_grants SET status = 'revoking', ended_at = ?, end_reason = ?
     WHERE session_id = ? AND status = 'granting'${capFilter}`,
    [at, reason, sessionId, ...capArg],
  );
  return ended;
}

/** `active` grants whose credentials expired at or before `now`, oldest first. */
export async function listExpiredActiveAwsGrants(now: number): Promise<SessionAwsGrantRow[]> {
  return timedDb("list-expired-active-aws-grants", async () => {
    const rows = await getDb().all<SessionAwsGrantRow>(
      `SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE status = 'active' AND credentials_expire_at <= ? ORDER BY credentials_expire_at, id`,
      [now],
    );
    return rows.map(toSessionAwsGrantRow);
  });
}

/**
 * Fail every `awaiting-signin` row whose device code expired at or before
 * `before` (the controller's sweep: a sign-in whose poll died with its web
 * process, or that a rolling update left behind). Returns the rows it failed, as they were.
 */
export async function failExpiredAwaitingSignInAwsGrants(before: number, reason: string, at: number): Promise<SessionAwsGrantRow[]> {
  return timedDb("fail-expired-awaiting-signin-aws-grants", async () => {
    const rows = (await getDb().all<SessionAwsGrantRow>(
      `SELECT ${AWS_GRANT_COLUMNS} FROM session_aws_grants WHERE status = 'awaiting-signin' AND device_expires_at <= ? ORDER BY created_at, id`,
      [before],
    )).map(toSessionAwsGrantRow);
    const failed: SessionAwsGrantRow[] = [];
    for (const row of rows) {
      if (await failSessionAwsGrant(row.id, reason, at)) failed.push(row);
    }
    return failed;
  });
}

/** Claim one `active` row by id as `ended` with `reason`. True when it was still active. */
export async function endActiveSessionAwsGrant(id: string, reason: string, at: number): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_aws_grants SET status = 'ended', ended_at = ?, end_reason = ? WHERE id = ? AND status = 'active'`,
    [at, reason, id],
  );
  return changes > 0;
}

/** Undo `endActiveSessionAwsGrant` (the revoke it guarded could not run). True when the row was put back. */
export async function restoreEndedSessionAwsGrant(id: string): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_aws_grants SET status = 'active', ended_at = NULL, end_reason = NULL WHERE id = ? AND status = 'ended'`,
    [id],
  );
  return changes > 0;
}

/** Replace an ended row's `end_reason`. */
export async function setSessionAwsGrantEndReason(id: string, reason: string): Promise<void> {
  await getDb().run(`UPDATE session_aws_grants SET end_reason = ? WHERE id = ? AND status = 'ended'`, [reason, id]);
}
