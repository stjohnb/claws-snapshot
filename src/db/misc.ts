// Small tables: WhatsApp events, health check, verification reports, damp,
// DMARC, reminders, upstream watch, spend warnings, blog drafts, friction
// notes and doc-maintainer state. Reached only through the src/db.ts façade.
import type { SqlDriver } from "../db-driver.js";
import * as log from "../log.js";
import type { DmarcReport } from "../dmarc.js";
import { canonicalIssueRef, isClawsIssueId, normalizeItemNumbers, type IssueRef } from "../issue-id.js";
import { DAY_MS, getDb, nowSql, nowSqlOffsetMs, refParam, timedDb } from "./core.js";
import type { Task } from "./tasks.js";

export interface WhatsappEvent {
  id: number;
  event_type: string;
  detail: string | null;
  occurred_at: string;
}

export async function recordWhatsappEvent(eventType: string, detail?: string): Promise<void> {
  try {
    await getDb().run(`INSERT INTO whatsapp_events (event_type, detail) VALUES (?, ?)`, [eventType, detail ?? null]);
  } catch (err) {
    log.warn(`[whatsapp] Failed to record event: ${err}`);
  }
}

export async function getRecentWhatsappEvents(limit = 50): Promise<WhatsappEvent[]> {
  return await getDb().all(`SELECT id, event_type, detail, occurred_at FROM whatsapp_events ORDER BY occurred_at DESC LIMIT ?`, [Math.min(limit, 200)]) as WhatsappEvent[];
}

/** @internal — only for tests that need raw SQL (e.g. backdating timestamps) */
export function _rawDb(): SqlDriver {
  return getDb();
}

export async function healthCheck(): Promise<void> {
  await getDb().get("SELECT 1");
}

export interface VerificationReportRow {
  id: number;
  ts: number;
  payload: string;
}

export async function insertVerificationReport(payload: string): Promise<void> {
  await getDb().run(`INSERT INTO verification_reports (ts, payload) VALUES (?, ?)`, [Date.now(), payload]);
}

export async function getLatestVerificationReport(): Promise<VerificationReportRow | null> {
  const row = await getDb().get(`SELECT id, ts, payload FROM verification_reports ORDER BY ts DESC LIMIT 1`) as VerificationReportRow | undefined;
  return row ?? null;
}

export interface DampReadingRow {
  id: number;
  location: string;
  point: string;
  value: number;
  reading_date: string;
  recorded_at: string;
}

export async function upsertDampReading(
  location: string,
  point: string,
  value: number,
  readingDate: string,
  recordedAt: string,
): Promise<void> {
  const res = await getDb()
    .run(`UPDATE damp_readings SET value = ?, recorded_at = ?
       WHERE location = ? AND point = ? AND reading_date = ?`, [value, recordedAt, location, point, readingDate]);
  if (res.changes === 0) {
    await getDb().run(`INSERT INTO damp_readings (location, point, value, reading_date, recorded_at) VALUES (?, ?, ?, ?, ?)`, [location, point, value, readingDate, recordedAt]);
  }
}

export async function deleteDampReading(
  location: string,
  point: string,
  readingDate: string,
): Promise<void> {
  await getDb().run(`DELETE FROM damp_readings WHERE location = ? AND point = ? AND reading_date = ?`, [location, point, readingDate]);
}

export async function getRecentDampReadings(limit = 200): Promise<DampReadingRow[]> {
  return await getDb().all(`SELECT * FROM damp_readings ORDER BY reading_date DESC, recorded_at DESC, location, point LIMIT ?`, [limit]) as DampReadingRow[];
}

export async function getDampTrendRows(): Promise<DampReadingRow[]> {
  return await getDb().all(`SELECT * FROM damp_readings ORDER BY location, point, reading_date DESC, recorded_at DESC`) as DampReadingRow[];
}

export async function hasDampReadingLoggedSince(sinceIso: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM damp_readings WHERE recorded_at >= ? LIMIT 1`, [sinceIso]) as { n: number } | undefined;
  return row !== undefined;
}

/** A `dmarc_reports` row minus `raw_xml`, which every read path except getDmarcReportXml() excludes. */
export interface DmarcReportRow {
  org_name: string;
  report_id: string;
  report_email: string;
  domain: string;
  date_begin: string;
  date_end: string;
  policy_p: string;
  policy_sp: string;
  policy_adkim: string;
  policy_aspf: string;
  policy_pct: number | null;
  row_count: number;
  received_at: string;
}

export interface DmarcRowRow {
  id: number;
  org_name: string;
  report_id: string;
  row_index: number;
  domain: string;
  date_begin: string;
  date_end: string;
  source_ip: string;
  count: number;
  disposition: string;
  eval_dkim: string;
  eval_spf: string;
  header_from: string;
  envelope_from: string;
  envelope_to: string;
  dkim_results: string;
  spf_results: string;
  reasons: string;
  verdict: string;
  received_at: string;
}

const DMARC_REPORT_COLUMNS = `org_name, report_id, report_email, domain, date_begin, date_end,
       policy_p, policy_sp, policy_adkim, policy_aspf, policy_pct, row_count, received_at`;

export async function hasDmarcReport(orgName: string, reportId: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM dmarc_reports WHERE org_name = ? AND report_id = ? LIMIT 1`, [orgName, reportId]) as { n: number } | undefined;
  return row !== undefined;
}

export async function getLatestDmarcReportForDomain(domain: string): Promise<DmarcReportRow | undefined> {
  return await getDb().get(`SELECT ${DMARC_REPORT_COLUMNS} FROM dmarc_reports WHERE domain = ?
       ORDER BY date_begin DESC, received_at DESC LIMIT 1`, [domain]) as DmarcReportRow | undefined;
}

/** The only read path that touches `raw_xml` — kept separate so the hot queries stay small. */
export async function getDmarcReportXml(orgName: string, reportId: string): Promise<string | undefined> {
  const row = await getDb().get(`SELECT raw_xml FROM dmarc_reports WHERE org_name = ? AND report_id = ?`, [orgName, reportId]) as { raw_xml: string } | undefined;
  return row?.raw_xml;
}

/**
 * Store a parsed report and its rows in one transaction. Returns false without
 * writing anything when `(org_name, report_id)` is already present, so a
 * re-forwarded or duplicate report is idempotent and raises no second alert.
 */
export async function insertDmarcReport(report: DmarcReport, rawXml: string, receivedAt: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const dup = await tx.get(`SELECT 1 AS n FROM dmarc_reports WHERE org_name = ? AND report_id = ? LIMIT 1`, [report.orgName, report.reportId]) as { n: number } | undefined;
    if (dup !== undefined) return false;
    await tx.run(
      `INSERT INTO dmarc_reports (org_name, report_id, report_email, domain, date_begin, date_end,
         policy_p, policy_sp, policy_adkim, policy_aspf, policy_pct, row_count, received_at, raw_xml)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        report.orgName,
        report.reportId,
        report.reportEmail,
        report.domain,
        report.dateBegin,
        report.dateEnd,
        report.policyP,
        report.policySp,
        report.policyAdkim,
        report.policyAspf,
        report.policyPct,
        report.rows.length,
        receivedAt,
        rawXml,
      ],
    );
    for (const [i, r] of report.rows.entries()) {
      await tx.run(
        `INSERT INTO dmarc_rows (org_name, report_id, row_index, domain, date_begin, date_end,
           source_ip, count, disposition, eval_dkim, eval_spf, header_from, envelope_from, envelope_to,
           dkim_results, spf_results, reasons, verdict, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          report.orgName,
          report.reportId,
          i,
          report.domain,
          report.dateBegin,
          report.dateEnd,
          r.sourceIp,
          r.count,
          r.disposition,
          r.evalDkim,
          r.evalSpf,
          r.headerFrom,
          r.envelopeFrom,
          r.envelopeTo,
          JSON.stringify(r.dkimResults),
          JSON.stringify(r.spfResults),
          JSON.stringify(r.reasons),
          r.verdict,
          receivedAt,
        ],
      );
    }
    return true;
  });
}

export async function getDmarcVerdictCounts(sinceIso: string): Promise<Array<{ domain: string; verdict: string; n: number }>> {
  return await getDb().all(`SELECT domain, verdict, COUNT(*) AS n FROM dmarc_rows WHERE date_begin >= ?
       GROUP BY domain, verdict ORDER BY domain, verdict`, [sinceIso]) as Array<{ domain: string; verdict: string; n: number }>;
}

export interface DmarcSourceIpRow {
  source_ip: string;
  verdict: string;
  domain: string;
  messages: number;
  last_seen: string;
}

export async function getDmarcSourceIps(sinceIso: string, limit = 200): Promise<DmarcSourceIpRow[]> {
  return await getDb().all(`SELECT source_ip, verdict, domain, SUM(count) AS messages, MAX(date_end) AS last_seen
       FROM dmarc_rows WHERE date_begin >= ?
       GROUP BY source_ip, verdict, domain ORDER BY last_seen DESC LIMIT ?`, [sinceIso, limit]) as DmarcSourceIpRow[];
}

/** Latest report per (domain, reporter) pair — the "is anything still arriving?" view. */
export async function getLatestDmarcReportsPerReporter(): Promise<DmarcReportRow[]> {
  return await getDb().all(`SELECT ${DMARC_REPORT_COLUMNS}, max_begin FROM (
         SELECT ${DMARC_REPORT_COLUMNS}, date_begin AS max_begin,
                ROW_NUMBER() OVER (PARTITION BY domain, org_name ORDER BY date_begin DESC) AS rn
         FROM dmarc_reports
       ) AS latest
       WHERE rn = 1
       ORDER BY max_begin DESC, domain, org_name`) as DmarcReportRow[];
}

/**
 * Delete reports and their rows past the retention window. `received_at` is ISO 8601, which
 * still compares correctly against datetime('now', …) at day granularity — same as pruneWorkflowRuns.
 */
export async function pruneDmarcReports(retentionDays = 365): Promise<number> {
  return timedDb("prune-dmarc-reports", () => pruneDmarcReportsUntimed(retentionDays));
}

async function pruneDmarcReportsUntimed(retentionDays = 365): Promise<number> {
  const cutoff = nowSqlOffsetMs(-retentionDays * DAY_MS);
  return await getDb().transaction(async (tx) => {
    await tx.run(`DELETE FROM dmarc_rows WHERE received_at < ?`, [cutoff]);
    return (await tx.run(`DELETE FROM dmarc_reports WHERE received_at < ?`, [cutoff])).changes;
  });
}

export async function getRecentDmarcRows(limit = 100): Promise<DmarcRowRow[]> {
  return await getDb().all(`SELECT * FROM dmarc_rows ORDER BY date_begin DESC, id DESC LIMIT ?`, [limit]) as DmarcRowRow[];
}

export async function hasReminderFired(repo: string, reminderId: string, notifyOn: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM reminder_notifications WHERE repo = ? AND reminder_id = ? AND notify_on = ? LIMIT 1`, [repo, reminderId, notifyOn]) as { n: number } | undefined;
  return row !== undefined;
}

export async function recordReminderFired(repo: string, reminderId: string, notifyOn: string, issueNumber: IssueRef): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO reminder_notifications (repo, reminder_id, notify_on, issue_number) VALUES (?, ?, ?, ?)`, [repo, reminderId, notifyOn, refParam(issueNumber)]);
}

/** True once `watchId` has unblocked `repo#issueNumber` — stops a re-comment
 *  loop if a human later re-applies `Blocked`. (#2617) */
/**
 * Whether watch `watchId` has already fired for the issue. A native `clw_…` id
 * is globally unique, so its match ignores `repo` — a later change of the
 * issue's primary repo must not re-fire the watch; a forge number matches on
 * repo too.
 */
export async function hasUpstreamWatchFired(watchId: string, repo: string, issueNumber: IssueRef): Promise<boolean> {
  const row = isClawsIssueId(canonicalIssueRef(issueNumber))
    ? await getDb().get(`SELECT 1 AS n FROM upstream_watch_fires WHERE watch_id = ? AND issue_number = ? LIMIT 1`, [watchId, refParam(issueNumber)]) as { n: number } | undefined
    : await getDb().get(`SELECT 1 AS n FROM upstream_watch_fires WHERE watch_id = ? AND repo = ? AND issue_number = ? LIMIT 1`, [watchId, repo, refParam(issueNumber)]) as { n: number } | undefined;
  return row !== undefined;
}

export async function recordUpstreamWatchFired(watchId: string, repo: string, issueNumber: IssueRef): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO upstream_watch_fires (watch_id, repo, issue_number) VALUES (?, ?, ?)`, [watchId, repo, refParam(issueNumber)]);
}

/**
 * All-time reported OpenCode-on-Anthropic spend in USD: the CLI's own
 * `cost_usd` for every OpenCode task and session whose model is `anthropic/…`.
 * Not limited to the Usage page's day window.
 */
export async function getOpencodeAnthropicSpendUsd(): Promise<number> {
  const row = await timedDb("opencode-anthropic-spend", () => getDb().get(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total FROM (
      SELECT cost_usd FROM tasks
      WHERE provider_used = 'opencode' AND model_used LIKE 'anthropic/%' AND cost_usd IS NOT NULL
      UNION ALL
      SELECT cost_usd FROM sessions
      WHERE provider = 'opencode' AND model LIKE 'anthropic/%' AND cost_usd IS NOT NULL
    ) opencode_anthropic_spend
  `)) as { total: number | string | null } | undefined;
  return Number(row?.total ?? 0);
}

/** The threshold (USD) the `key` spend warning last fired at, or null when it never has. */
export async function getSpendWarningThreshold(key: string): Promise<number | null> {
  const row = await getDb().get(`SELECT threshold_usd FROM spend_warnings WHERE key = ?`, [key]) as { threshold_usd: number | string } | undefined;
  return row ? Number(row.threshold_usd) : null;
}

/** Records that the `key` spend warning fired at `thresholdUsd`. */
export async function recordSpendWarning(key: string, thresholdUsd: number): Promise<void> {
  await getDb().run(
    `INSERT INTO spend_warnings (key, threshold_usd, notified_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET threshold_usd = excluded.threshold_usd, notified_at = excluded.notified_at`,
    [key, thresholdUsd, nowSql()],
  );
}
export async function hasBlogDraftPortFiled(repo: string, path: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM blog_draft_ports WHERE repo = ? AND path = ? LIMIT 1`, [repo, path]) as { n: number } | undefined;
  return row !== undefined;
}

export async function recordBlogDraftPortFiled(repo: string, path: string, issueNumber: IssueRef): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO blog_draft_ports (repo, path, issue_number) VALUES (?, ?, ?)`, [repo, path, refParam(issueNumber)]);
}

export interface BlogDraftRow {
  repo: string;
  path: string;
  content: string;
  base_sha: string | null;
  title: string | null;
  status: string;
  pr_number: number | null;
  pr_branch: string | null;
  updated_at: string;
}

export async function upsertBlogDraft(
  repo: string,
  path: string,
  content: string,
  baseSha: string | null,
  title: string | null,
  updatedAt: string,
): Promise<void> {
  await getDb().run(`INSERT INTO blog_drafts (repo, path, content, base_sha, title, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)
       ON CONFLICT(repo, path) DO UPDATE SET
         content = excluded.content,
         base_sha = excluded.base_sha,
         title = excluded.title,
         status = 'draft',
         updated_at = excluded.updated_at`, [repo, path, content, baseSha, title, updatedAt]);
}

export async function getBlogDraft(repo: string, path: string): Promise<BlogDraftRow | null> {
  return (
    (await getDb().get(`SELECT * FROM blog_drafts WHERE repo = ? AND path = ?`, [repo, path]) as BlogDraftRow | undefined) ?? null
  );
}

export async function listBlogDrafts(repo: string): Promise<BlogDraftRow[]> {
  return await getDb().all(`SELECT * FROM blog_drafts WHERE repo = ? ORDER BY updated_at DESC`, [repo]) as BlogDraftRow[];
}

export async function setBlogDraftPushed(
  repo: string,
  path: string,
  prNumber: number,
  branch: string,
): Promise<void> {
  await getDb().run(`UPDATE blog_drafts SET status = 'pushed', pr_number = ?, pr_branch = ? WHERE repo = ? AND path = ?`, [prNumber, branch, repo, path]);
}

// Drop a stale PR pointer (PR merged/closed/deleted) so the next push opens a fresh PR.
export async function clearBlogDraftPR(repo: string, path: string): Promise<void> {
  await getDb().run(`UPDATE blog_drafts SET status = 'draft', pr_number = NULL, pr_branch = NULL WHERE repo = ? AND path = ?`, [repo, path]);
}

// Discard a Claws-saved draft. Only the stored row goes; the blog repo is never touched.
export async function deleteBlogDraft(repo: string, path: string): Promise<void> {
  await getDb().run(`DELETE FROM blog_drafts WHERE repo = ? AND path = ?`, [repo, path]);
}

// ── friction notes (claws_note_friction → jobs/friction-retrospective.ts) ──

export interface FrictionNoteRow {
  id: number;
  repo: string;
  category: string;
  text: string;
  reference: string | null;
  task_id: number | null;
  session_id: string | null;
  origin: string | null;
  created_at: string;
  triaged_at: string | null;
  retrospective_issue_id: string | null;
}

export interface FrictionNoteInput {
  repo: string;
  category: string;
  text: string;
  reference?: string | null;
  taskId?: number | null;
  sessionId?: string | null;
  origin?: string | null;
}

/** Stores one untriaged friction note and returns its id. Triggers nothing else. */
export async function insertFrictionNote(note: FrictionNoteInput): Promise<number> {
  const { id } = await getDb().insert(
    `INSERT INTO friction_notes (repo, category, text, reference, task_id, session_id, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [note.repo, note.category, note.text, note.reference ?? null, note.taskId ?? null, note.sessionId ?? null, note.origin ?? null, nowSql()],
  );
  return id;
}

function normalizeFrictionNote(row: FrictionNoteRow): FrictionNoteRow {
  return { ...row, id: Number(row.id), task_id: row.task_id === null ? null : Number(row.task_id) };
}

/** Untriaged notes, oldest first; every repo's when `repo` is omitted. */
export async function listUntriagedFrictionNotes(repo?: string): Promise<FrictionNoteRow[]> {
  const rows = repo === undefined
    ? await getDb().all(`SELECT * FROM friction_notes WHERE triaged_at IS NULL ORDER BY created_at ASC, id ASC`)
    : await getDb().all(`SELECT * FROM friction_notes WHERE repo = ? AND triaged_at IS NULL ORDER BY created_at ASC, id ASC`, [repo]);
  return (rows as FrictionNoteRow[]).map(normalizeFrictionNote);
}

/** Untriaged note counts keyed by repo, then category. */
export async function countUntriagedFrictionNotesByRepoAndCategory(): Promise<Map<string, Map<string, number>>> {
  const rows = await getDb().all(
    `SELECT repo, category, COUNT(*) AS n FROM friction_notes WHERE triaged_at IS NULL GROUP BY repo, category`,
  ) as Array<{ repo: string; category: string; n: number | string }>;
  const out = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const byCategory = out.get(row.repo) ?? new Map<string, number>();
    byCategory.set(row.category, Number(row.n));
    out.set(row.repo, byCategory);
  }
  return out;
}

/** Marks notes triaged by retrospective issue `issueId`; a note already triaged keeps its first retrospective. */
export async function markFrictionNotesTriaged(ids: number[], issueId: string): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await getDb().run(
    `UPDATE friction_notes SET triaged_at = ?, retrospective_issue_id = ? WHERE triaged_at IS NULL AND id IN (${placeholders})`,
    [nowSql(), issueId, ...ids],
  );
}

/** When the fleet's last retrospective triaged notes (`YYYY-MM-DD HH:MM:SS` UTC), or null when it has had none. */
export async function lastFrictionRetrospectiveAt(): Promise<string | null> {
  const row = await getDb().get(`SELECT MAX(triaged_at) AS at FROM friction_notes`) as { at: string | null } | undefined;
  return row?.at ?? null;
}

export interface FrictionRetrospective {
  issueId: string;
  triagedAt: string;
  noteCount: number;
}

/** Past retrospective issues across every repo, newest first. */
export async function listFrictionRetrospectives(): Promise<FrictionRetrospective[]> {
  const rows = await getDb().all(
    `SELECT retrospective_issue_id AS issue_id, MAX(triaged_at) AS triaged_at, COUNT(*) AS n
       FROM friction_notes WHERE retrospective_issue_id IS NOT NULL
       GROUP BY retrospective_issue_id ORDER BY MAX(triaged_at) DESC`,
  ) as Array<{ issue_id: string; triaged_at: string; n: number | string }>;
  return rows.map((r) => ({ issueId: r.issue_id, triagedAt: r.triaged_at, noteCount: Number(r.n) }));
}

/** The task rows among `ids` that still exist; pruned ones are simply absent. */
export async function getTasksByIds(ids: number[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return normalizeItemNumbers(await getDb().all(`SELECT * FROM tasks WHERE id IN (${placeholders}) ORDER BY id ASC`, [...ids]) as Task[]);
}

// ── doc-maintainer human-intent backfill watermark ──
//
// The intent pass walks a repo's history BACKWARDS in dated chunks across
// successive nightly runs (a single unbounded pass would need thousands of
// per-item comment fetches). `oldest_scanned` is the oldest `YYYY-MM-DD` the
// walk has reached; `complete` flips to 1 once a chunk exhausts history.
// `window_exhausted` is the other terminal state: the walk consumed everything
// the fixed-size `gh list` window can reach but older history exists beyond it,
// so the walk stops WITHOUT having covered full history — distinguishable from
// `complete` so an operator can tell the two apart (clear the column to resume
// after raising the fetch limit).
// `source_version` records which INTENT_SOURCE_VERSION captured the walk; when
// doc-maintainer learns a new source (review comments, closed-unmerged PRs, …) it
// bumps that constant and the stale stamp restarts the walk so the new source
// reaches old items.
// An absent row means the backfill has never started for that repo.

/** Returns the backfill watermark for `repo`, or null if the walk never started. */
export async function getIntentBackfillState(
  repo: string,
): Promise<{ oldestScanned: string | null; complete: boolean; windowExhausted: boolean; sourceVersion: number } | null> {
  const row = await getDb().get(`SELECT oldest_scanned, complete, window_exhausted, source_version FROM doc_intent_backfill WHERE repo = ?`, [repo]) as { oldest_scanned: string | null; complete: number; window_exhausted: number; source_version: number } | undefined;
  if (!row) return null;
  return {
    oldestScanned: row.oldest_scanned,
    complete: row.complete === 1,
    windowExhausted: row.window_exhausted === 1,
    sourceVersion: row.source_version ?? 0,
  };
}

/** Records how far back the intent backfill has walked for `repo`. */
export async function recordIntentBackfillChunk(
  repo: string,
  oldestScanned: string | null,
  complete: boolean,
  windowExhausted: boolean,
  sourceVersion: number,
): Promise<void> {
  await getDb().run(`
    INSERT INTO doc_intent_backfill (repo, oldest_scanned, complete, window_exhausted, source_version)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      oldest_scanned = excluded.oldest_scanned,
      complete = excluded.complete,
      window_exhausted = excluded.window_exhausted,
      source_version = excluded.source_version,
      updated_at = ?
  `, [repo, oldestScanned, complete ? 1 : 0, windowExhausted ? 1 : 0, sourceVersion, nowSql()]);
}

/** Returns the SHA-256 digest of the agent memory files last folded into docs for `repo`, or null if never folded. */
export async function getDocMemoryDigest(repo: string): Promise<string | null> {
  const row = await getDb().get(`SELECT memory_digest FROM doc_intent_backfill WHERE repo = ?`, [repo]) as { memory_digest: string | null } | undefined;
  return row?.memory_digest ?? null;
}

/** Records the digest of the agent memory files last folded into docs for `repo`. */
export async function recordDocMemoryDigest(repo: string, digest: string): Promise<void> {
  await getDb().run(`
    INSERT INTO doc_intent_backfill (repo, memory_digest)
    VALUES (?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      memory_digest = excluded.memory_digest,
      updated_at = ?
  `, [repo, digest, nowSql()]);
}

/** Returns the SHA-256 digest of the generated Related repositories section last synced into `repo`'s docs, or null if never synced. */
export async function getDocFleetLinksDigest(repo: string): Promise<string | null> {
  const row = await getDb().get(`SELECT fleet_links_digest FROM doc_intent_backfill WHERE repo = ?`, [repo]) as { fleet_links_digest: string | null } | undefined;
  return row?.fleet_links_digest ?? null;
}

/** Records the digest of the generated Related repositories section last synced into `repo`'s docs. */
export async function recordDocFleetLinksDigest(repo: string, digest: string): Promise<void> {
  await getDb().run(`
    INSERT INTO doc_intent_backfill (repo, fleet_links_digest)
    VALUES (?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      fleet_links_digest = excluded.fleet_links_digest,
      updated_at = ?
  `, [repo, digest, nowSql()]);
}
