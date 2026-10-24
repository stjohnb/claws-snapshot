/**
 * Event bus for Claws-originated GitHub state changes (#2832), stored in the
 * `claws_events` table so a waiter on one Claws process sees events any other
 * process recorded (#clw_01M5APX7YF3AGWHV1S1WMHJDR6).
 *
 * Upstream of `db.ts` by design: it imports only the driver type, `log.ts` and
 * `issue-id.ts`, so both `github.ts` (which emits the GitHub writes) and `db.ts`
 * (which emits task lifecycle) can depend on it. `initDb()` creates the table
 * from {@link CLAWS_EVENTS_DDL} and registers its connection with
 * {@link setGitHubEventsDriver}.
 *
 * `recordGitHubEvent` stays synchronous: it appends to an outbox that is
 * drained in batches, like job logs, and each drain wakes this process's
 * waiters at once. A waiter also polls the table every {@link EVENT_POLL_MS},
 * which is how it sees events another process recorded. Ids are the table's
 * own, so they survive a restart; rows are pruned after a day
 * (`pruneClawsEvents` in `db.ts`).
 */

import type { SqlDriver } from "./db-driver.js";
import * as log from "./log.js";
import { ISSUE_REF_GUARDED, canonicalIssueRef, refFromColumn, type IssueRef } from "./issue-id.js";

export type GitHubEventKind =
  | "issue-comment"
  | "label-added"
  | "label-removed"
  | "issue-closed"
  | "issue-reopened"
  | "pr-opened"
  | "pr-merged"
  | "pr-closed"
  | "task-started"
  | "task-completed"
  | "task-failed"
  | "requirements-stored"
  | "stage-changed";

export const GITHUB_EVENT_KINDS: GitHubEventKind[] = [
  "issue-comment",
  "label-added",
  "label-removed",
  "issue-closed",
  "issue-reopened",
  "pr-opened",
  "pr-merged",
  "pr-closed",
  "task-started",
  "task-completed",
  "task-failed",
  "requirements-stored",
  "stage-changed",
];

export interface GitHubEvent {
  id: number;
  at: string;
  /** What happened. */
  kind: GitHubEventKind;
  /** Repository full name, `owner/repo`. */
  repo: string;
  /** The issue or PR this event is about. */
  number: IssueRef;
  /** Other item refs referenced in the title/body, so waiting on an issue also catches its PR. */
  related: IssueRef[];
  /**
   * Label name, job name, `"plan"`, a truncated error, `v<N>` for
   * `requirements-stored`, or `<old>-><new>` stored lifecycle for
   * `stage-changed` — kind-dependent.
   */
  detail?: string;
}

export interface EventFilter {
  repo?: string;
  items?: IssueRef[];
  kinds?: GitHubEventKind[];
}

export interface WaitResult {
  /** Always `"db"`: ids come from the table and never reset on a restart. */
  bootId: string;
  lastId: number;
  restarted: boolean;
  events: GitHubEvent[];
}

/** DDL for the table, run by `initDb()`. */
export const CLAWS_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS claws_events (
    id           {{PK_AUTOINC}},
    at           TEXT NOT NULL,
    kind         TEXT NOT NULL,
    repo         TEXT NOT NULL,
    number       TEXT NOT NULL,
    related_json TEXT NOT NULL,
    detail       TEXT
  )
`;
export const CLAWS_EVENTS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_claws_events_at ON claws_events(at)`;

/** How often a waiter re-reads the table for events another process recorded. */
export const EVENT_POLL_MS = 1_000;

const BOOT_ID = "db";
const MAX_RETURNED = 100;
const MAX_RELATED = 10;
/** Rows read per page while filtering on `related`, which SQL cannot match. */
const SCAN_PAGE = 500;
const OUTBOX_LIMIT = 5_000;
const DRAIN_BATCH_SIZE = 200;
const DRAIN_RETRY_MS = 1_000;

interface Waiter {
  after: number;
  filter: EventFilter;
  /** The newest id this waiter has read up to; never beyond a stored event. */
  seenMax: number;
  checking: boolean;
  recheck: boolean;
  resolve: (r: WaitResult) => void;
  timer: NodeJS.Timeout;
  poll: NodeJS.Timeout;
}

let driver: SqlDriver | null = null;
/** An in-memory SQLite connection `resetGitHubEventsForTest` opens when no real one is registered. */
let testDriver: SqlDriver | null = null;
const outbox: Omit<GitHubEvent, "id">[] = [];
let outboxDropped = 0;
let drainScheduled = false;
let drainInFlight: Promise<void> | null = null;
let retryTimer: NodeJS.Timeout | null = null;
const waiters = new Set<Waiter>();

// Guarded, not bare: without a boundary a typo'd `#clw_<27 chars>` matches its
// first 26 and resolves to a *different, real* issue, waking every
// `claws_wait_for_change` waiter on the wrong one.
const RELATED_REF_RE = new RegExp(`#(${ISSUE_REF_GUARDED})`, "g");

/**
 * Item references written as `#123` or `#clw_01JBQ…` in a title or body,
 * canonicalised, deduped and capped.
 *
 * Over-matching is intended: a spurious wake costs one model turn, while an
 * under-match strands a waiting session for its full timeout.
 */
export function extractRelatedNumbers(text: string): IssueRef[] {
  const out: IssueRef[] = [];
  for (const m of text.matchAll(RELATED_REF_RE)) {
    const ref = canonicalIssueRef(m[1]);
    if (ref === null || ref === 0 || out.includes(ref)) continue;
    out.push(ref);
    if (out.length >= MAX_RELATED) break;
  }
  return out;
}

function matchesFilter(e: GitHubEvent, f: EventFilter): boolean {
  if (f.repo && e.repo !== f.repo) return false;
  if (f.kinds && f.kinds.length > 0 && !f.kinds.includes(e.kind)) return false;
  if (f.items && f.items.length > 0) {
    const subjects = [e.number, ...e.related];
    if (!f.items.some((n) => subjects.includes(n))) return false;
  }
  return true;
}

/** Registers (or, with null, clears) the connection events are stored through. */
export function setGitHubEventsDriver(next: SqlDriver | null): void {
  driver = next;
  if (next && outbox.length > 0) scheduleDrain();
}

interface EventRow {
  id: number | string;
  at: string;
  kind: string;
  repo: string;
  number: string;
  related_json: string;
  detail: string | null;
}

function fromRow(row: EventRow): GitHubEvent {
  let related: IssueRef[] = [];
  try {
    const parsed = JSON.parse(row.related_json) as unknown;
    if (Array.isArray(parsed)) related = parsed.map(refFromColumn);
  } catch {
    // a malformed row matches on its own number only
  }
  return {
    id: Number(row.id),
    at: row.at,
    kind: row.kind as GitHubEventKind,
    repo: row.repo,
    number: refFromColumn(row.number),
    related,
    ...(row.detail !== null ? { detail: row.detail } : {}),
  };
}

function requireDriver(): SqlDriver {
  if (!driver) throw new Error("GitHub events store not initialised — call initDb() first");
  return driver;
}

/** The highest stored event id; 0 when nothing has been recorded. */
export async function currentEventId(): Promise<number> {
  const row = await requireDriver().get<{ max_id: number | string | null }>(`SELECT MAX(id) AS max_id FROM claws_events`);
  return row?.max_id == null ? 0 : Number(row.max_id);
}

/** Matching stored events with `after < id <= upTo`, oldest first, at most 100. */
async function eventsBetween(after: number, upTo: number, filter: EventFilter): Promise<GitHubEvent[]> {
  const db = requireDriver();
  const where = ["id > ?", "id <= ?"];
  const base: unknown[] = [];
  if (filter.repo) {
    where.push("repo = ?");
    base.push(filter.repo);
  }
  if (filter.kinds && filter.kinds.length > 0) {
    where.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
    base.push(...filter.kinds);
  }
  const out: GitHubEvent[] = [];
  let cursor = after;
  while (out.length < MAX_RETURNED && cursor < upTo) {
    const rows = await db.all<EventRow>(
      `SELECT id, at, kind, repo, number, related_json, detail FROM claws_events WHERE ${where.join(" AND ")} ORDER BY id LIMIT ${SCAN_PAGE}`,
      [cursor, upTo, ...base],
    );
    for (const row of rows) {
      const event = fromRow(row);
      if (!matchesFilter(event, filter)) continue;
      out.push(event);
      if (out.length >= MAX_RETURNED) break;
    }
    if (rows.length < SCAN_PAGE) break;
    cursor = Number(rows[rows.length - 1]!.id);
  }
  return out;
}

/** Stored events after `after` that match `filter`, oldest first, at most 100. Flushes the outbox first. */
export async function getEventsSince(after: number, filter: EventFilter): Promise<GitHubEvent[]> {
  await flushGitHubEvents();
  return await eventsBetween(after, Number.MAX_SAFE_INTEGER, filter);
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(() => {
    drainScheduled = false;
    void flushGitHubEvents();
  });
}

/** Writes one batch from the outbox. False when there was nothing to write or the write failed. */
async function drainBatch(): Promise<boolean> {
  if (outbox.length === 0 || !driver) return false;
  const db = driver;
  const batch = outbox.splice(0, DRAIN_BATCH_SIZE);
  const params: unknown[] = [];
  for (const e of batch) params.push(e.at, e.kind, e.repo, String(e.number), JSON.stringify(e.related), e.detail ?? null);
  try {
    await db.run(
      `INSERT INTO claws_events (at, kind, repo, number, related_json, detail) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
      params,
    );
  } catch (err) {
    log.warn(`[github-events] Failed to store ${batch.length} event(s): ${err}`);
    const room = OUTBOX_LIMIT - outbox.length;
    if (room > 0) outbox.unshift(...batch.slice(0, room));
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        scheduleDrain();
      }, DRAIN_RETRY_MS);
      retryTimer.unref();
    }
    return false;
  }
  return true;
}

/**
 * Writes every event still in the outbox, then wakes this process's waiters.
 * Concurrent callers share one drain.
 */
export async function flushGitHubEvents(): Promise<void> {
  while (drainInFlight) await drainInFlight;
  if (outbox.length === 0 || !driver) return;
  drainInFlight = (async () => {
    let wrote = false;
    while (await drainBatch()) wrote = true;
    if (wrote) for (const w of [...waiters]) void checkWaiter(w);
  })();
  try {
    await drainInFlight;
  } finally {
    drainInFlight = null;
  }
}

/**
 * Record a Claws-originated change and wake every matching waiter.
 *
 * MUST NEVER THROW: this is called inline from GitHub write paths
 * (`commentOnIssue`, `createPR`, `mergePR`) and from task accounting in
 * `db.ts`, where an exception would abort a real job.
 */
export function recordGitHubEvent(e: Omit<GitHubEvent, "id" | "at">): void {
  try {
    if (outbox.length >= OUTBOX_LIMIT) {
      outbox.shift();
      outboxDropped++;
      if (outboxDropped % 1_000 === 1) log.warn(`[github-events] Outbox full — dropped ${outboxDropped} event(s)`);
    }
    outbox.push({ ...e, related: [...e.related], at: new Date().toISOString() });
    scheduleDrain();
  } catch (err) {
    log.warn(`recordGitHubEvent failed: ${err}`);
  }
}

function settle(w: Waiter, events: GitHubEvent[]): void {
  if (!waiters.delete(w)) return;
  clearTimeout(w.timer);
  clearInterval(w.poll);
  w.resolve({ bootId: BOOT_ID, lastId: w.seenMax, restarted: false, events });
}

async function checkWaiter(w: Waiter): Promise<void> {
  if (!waiters.has(w)) return;
  if (w.checking) {
    w.recheck = true;
    return;
  }
  w.checking = true;
  try {
    do {
      w.recheck = false;
      // Read the max first: an event stored between the two reads is then
      // beyond `seenMax` and is picked up next time rather than skipped.
      const max = await currentEventId();
      const events = await eventsBetween(w.after, max, w.filter);
      if (!waiters.has(w)) return;
      w.seenMax = Math.max(w.seenMax, max);
      if (events.length > 0) {
        settle(w, events);
        return;
      }
    } while (w.recheck && waiters.has(w));
  } catch (err) {
    log.warn(`[github-events] Event poll failed: ${err}`);
  } finally {
    w.checking = false;
  }
}

/**
 * Long-poll for matching events newer than `after`.
 *
 * Omitting `after` starts the cursor at the current id, i.e. "only events from
 * now on". A cursor beyond the current id cannot come from this table (its ids
 * never reset), so it resolves immediately with `restarted: true` and no
 * events, and the caller starts again from `lastId`.
 */
export async function waitForEvents(
  after: number | undefined,
  filter: EventFilter,
  timeoutMs: number,
): Promise<WaitResult> {
  await flushGitHubEvents();
  const max = await currentEventId();
  const cursor = after ?? max;
  if (cursor > max) return { bootId: BOOT_ID, lastId: max, restarted: true, events: [] };
  const existing = await eventsBetween(cursor, max, filter);
  if (existing.length > 0 || timeoutMs <= 0) {
    return { bootId: BOOT_ID, lastId: max, restarted: false, events: existing };
  }
  return new Promise<WaitResult>((resolve) => {
    const waiter: Waiter = {
      after: cursor,
      filter,
      seenMax: max,
      checking: false,
      recheck: false,
      resolve,
      timer: setTimeout(() => settle(waiter, []), timeoutMs),
      poll: setInterval(() => void checkWaiter(waiter), EVENT_POLL_MS),
    };
    waiters.add(waiter);
  });
}

/** Resolve every pending long-poll so a waiter cannot delay server shutdown. */
export function resolveAllWaiters(): void {
  for (const w of [...waiters]) settle(w, []);
}

/**
 * Test-only: drop all waiters and queued events and empty the table. Opens an
 * in-memory SQLite store when `initDb()` has not registered a connection.
 */
export async function resetGitHubEventsForTest(): Promise<void> {
  for (const w of [...waiters]) {
    clearTimeout(w.timer);
    clearInterval(w.poll);
  }
  waiters.clear();
  outbox.length = 0;
  outboxDropped = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (!driver) {
    if (!testDriver) {
      const { createSqliteDriver } = await import("./db-driver.js");
      testDriver = createSqliteDriver(":memory:");
      await testDriver.exec(CLAWS_EVENTS_DDL);
    }
    driver = testDriver;
  }
  await driver.run(`DELETE FROM claws_events`);
  // Restart the id space too, so a test's first event is id 1.
  if (driver.dialect === "sqlite") await driver.run(`DELETE FROM sqlite_sequence WHERE name = 'claws_events'`).catch(() => {});
}
