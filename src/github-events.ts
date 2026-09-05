/**
 * In-memory event bus for Claws-originated GitHub state changes (#2832).
 *
 * A leaf module by design: it imports only `node:crypto` and `log.ts`, so both
 * `github.ts` (which emits the GitHub writes) and `db.ts` (which emits task
 * lifecycle) can depend on it without a circular import.
 *
 * Nothing is persisted. Events are only useful to a live waiter, so a service
 * restart resets the id space; `waitForEvents` reports `restarted: true` rather
 * than replaying a ring under a reset cursor. This is the same trade-off
 * `github-status.ts` makes for incident windows.
 */

import crypto from "node:crypto";
import * as log from "./log.js";

export type GitHubEventKind =
  | "issue-comment"
  | "label-added"
  | "label-removed"
  | "issue-closed"
  | "pr-opened"
  | "pr-merged"
  | "pr-closed"
  | "task-started"
  | "task-completed"
  | "task-failed";

export const GITHUB_EVENT_KINDS: GitHubEventKind[] = [
  "issue-comment",
  "label-added",
  "label-removed",
  "issue-closed",
  "pr-opened",
  "pr-merged",
  "pr-closed",
  "task-started",
  "task-completed",
  "task-failed",
];

export interface GitHubEvent {
  id: number;
  at: string;
  /** What happened. */
  kind: GitHubEventKind;
  /** Repository full name, `owner/repo`. */
  repo: string;
  /** The issue or PR this event is about. */
  number: number;
  /** Other item numbers referenced in the title/body, so waiting on an issue also catches its PR. */
  related: number[];
  /** Label name, job name, `"plan"`, or a truncated error — kind-dependent. */
  detail?: string;
}

export interface EventFilter {
  repo?: string;
  items?: number[];
  kinds?: GitHubEventKind[];
}

export interface WaitResult {
  bootId: string;
  lastId: number;
  restarted: boolean;
  events: GitHubEvent[];
}

interface Waiter {
  after: number;
  filter: EventFilter;
  resolve: (r: WaitResult) => void;
  timer: NodeJS.Timeout;
}

const MAX_EVENTS = 500;
const MAX_RETURNED = 100;
const MAX_RELATED = 10;

const BOOT_ID = crypto.randomUUID();
let nextId = 1;
const ring: GitHubEvent[] = [];
const waiters = new Set<Waiter>();

/**
 * Item numbers referenced as `#123` in a title or body, deduped and capped.
 *
 * Over-matching is intended: a spurious wake costs one model turn, while an
 * under-match strands a waiting session for its full timeout.
 */
export function extractRelatedNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n <= 0 || out.includes(n)) continue;
    out.push(n);
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

/** The highest event id issued so far; 0 when nothing has been recorded. */
export function currentEventId(): number {
  return nextId - 1;
}

export function getEventsSince(after: number, filter: EventFilter): GitHubEvent[] {
  const out: GitHubEvent[] = [];
  for (const e of ring) {
    if (e.id <= after) continue;
    if (!matchesFilter(e, filter)) continue;
    out.push(e);
    if (out.length >= MAX_RETURNED) break;
  }
  return out;
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
    const event: GitHubEvent = { ...e, id: nextId++, at: new Date().toISOString() };
    ring.push(event);
    while (ring.length > MAX_EVENTS) ring.shift();
    for (const w of [...waiters]) {
      if (event.id <= w.after || !matchesFilter(event, w.filter)) continue;
      clearTimeout(w.timer);
      waiters.delete(w);
      w.resolve({
        bootId: BOOT_ID,
        lastId: currentEventId(),
        restarted: false,
        events: getEventsSince(w.after, w.filter),
      });
    }
  } catch (err) {
    log.warn(`recordGitHubEvent failed: ${err}`);
  }
}

/**
 * Long-poll for matching events newer than `after`.
 *
 * Omitting `after` starts the cursor at the current id, i.e. "only events from
 * now on". A cursor beyond the current id means the service restarted since the
 * caller last read; that resolves immediately with `restarted: true` and no
 * events — replaying the ring under a reset id space would hand back stale
 * events as if they were new.
 */
export function waitForEvents(
  after: number | undefined,
  filter: EventFilter,
  timeoutMs: number,
): Promise<WaitResult> {
  const cursor = after ?? currentEventId();
  if (cursor > currentEventId()) {
    return Promise.resolve({ bootId: BOOT_ID, lastId: currentEventId(), restarted: true, events: [] });
  }
  const existing = getEventsSince(cursor, filter);
  if (existing.length > 0 || timeoutMs <= 0) {
    return Promise.resolve({ bootId: BOOT_ID, lastId: currentEventId(), restarted: false, events: existing });
  }
  return new Promise<WaitResult>((resolve) => {
    const waiter: Waiter = {
      after: cursor,
      filter,
      resolve,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        resolve({ bootId: BOOT_ID, lastId: currentEventId(), restarted: false, events: [] });
      }, timeoutMs),
    };
    waiters.add(waiter);
  });
}

/** Resolve every pending long-poll so a waiter cannot delay server shutdown. */
export function resolveAllWaiters(): void {
  for (const w of [...waiters]) {
    clearTimeout(w.timer);
    waiters.delete(w);
    w.resolve({ bootId: BOOT_ID, lastId: currentEventId(), restarted: false, events: [] });
  }
}

/** Test-only: clear the ring, drop all waiters, and reset the id space. */
export function resetGitHubEventsForTest(): void {
  for (const w of [...waiters]) clearTimeout(w.timer);
  waiters.clear();
  ring.length = 0;
  nextId = 1;
}
