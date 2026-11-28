import { LABELS, SELF_REPO } from "../config.js";
import { hasDampReadingLoggedSince } from "../db.js";
import { closeIssue, commentOnIssue, createIssue, findIssueByExactTitle } from "../github.js";
import * as log from "../log.js";

const LOG_PREFIX = "damp-reminder";
const REMINDER_TITLE = "[damp-reminder] Log this fortnight's damp meter readings";
// Title used before the reminder went fortnightly; still recognised so an issue
// filed with it is auto-closed and never duplicated. Drop once none is open.
const LEGACY_REMINDER_TITLE = "[damp-reminder] Log this week's damp meter readings";
const BLOCKED_REASON =
  "Fortnightly reminder — a person logs the damp readings on /damp every 2 weeks; Claws closes it once they are in";
const REMINDER_WEEKDAY = 1; // Monday, local time
const REMINDER_HOUR = 9; // don't create the reminder before 9 AM local
// A reminder Monday (local midnight); reminder weeks are an even number of weeks from it.
const ANCHOR_MONDAY = new Date(2026, 9, 26);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function isReminderDay(now: Date): boolean {
  return now.getDay() === REMINDER_WEEKDAY;
}

// Most recent Monday at local 00:00.
export function weekStartMonday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const diff = (d.getDay() + 6) % 7; // days since Monday (Sun=0 -> 6)
  d.setDate(d.getDate() - diff);
  return d;
}

// Whole weeks from the anchor Monday to this week's Monday (rounded to absorb DST).
function weeksFromAnchor(now: Date): number {
  return Math.round((weekStartMonday(now).getTime() - ANCHOR_MONDAY.getTime()) / WEEK_MS);
}

// True when `now` falls in a week that starts a new 2-week reminder period.
export function isReminderWeek(now: Date): boolean {
  return ((weeksFromAnchor(now) % 2) + 2) % 2 === 0;
}

// Monday (local 00:00) that started the current 2-week reminder period.
export function periodStartMonday(now: Date): Date {
  const d = weekStartMonday(now);
  if (!isReminderWeek(now)) d.setDate(d.getDate() - 7);
  return d;
}

async function findOpenReminder() {
  return (await findIssueByExactTitle(SELF_REPO, REMINDER_TITLE)) ?? (await findIssueByExactTitle(SELF_REPO, LEGACY_REMINDER_TITLE));
}

// Once we've handled the close for a given period (closed the issue, or found
// none open), remember it so we don't hit the GitHub API every tick.
let closedForPeriod: string | null = null;

// Once we've ensured the reminder exists for a given period (created it, or
// found one already open), remember it so we don't hit the GitHub API every tick.
let ensuredForPeriod: string | null = null;

export async function run(now: Date = new Date()): Promise<void> {
  const periodStart = periodStartMonday(now).toISOString();
  const loggedThisPeriod = await hasDampReadingLoggedSince(periodStart);

  // This period's readings are in — auto-close the open reminder (once per period).
  if (loggedThisPeriod) {
    if (closedForPeriod === periodStart) return;
    try {
      const existing = await findOpenReminder();
      if (existing) {
        // Close first: once this succeeds, the issue drops out of findIssueByExactTitle's
        // open-issue search, so a failure below (or on the next tick) can't repost this comment.
        await closeIssue(SELF_REPO, existing.number, "completed");
        closedForPeriod = periodStart;
        log.info(`[${LOG_PREFIX}] auto-closed reminder (#${existing.number}) — readings logged this period`);
        await commentOnIssue(
          SELF_REPO,
          existing.number,
          "This fortnight's damp readings have been logged — closing automatically. The next reminder is created in 2 weeks.",
        );
      } else {
        closedForPeriod = periodStart; // done for this period — no open issue to close
      }
    } catch (err) {
      log.warn(`[${LOG_PREFIX}] auto-close failed: ${(err as Error).message}`); // retry next tick
    }
    return;
  }

  // No readings yet — file the reminder on reminder-week Monday mornings only.
  if (!isReminderDay(now) || !isReminderWeek(now) || now.getHours() < REMINDER_HOUR) return;
  if (ensuredForPeriod === periodStart) return; // already ensured this period
  const body = [
    "Reminder (every 2 weeks) to record damp meter readings.",
    "",
    "Open the dashboard **Damp** page (`/damp`) and log a value for each measurement point.",
    "",
    "Close this issue once you've logged this fortnight's readings (Claws will also close it automatically once it sees them) — the next reminder is created in 2 weeks, on the next reminder Monday.",
    "",
    "This is a reminder, not a work item: it is held in Blocked, never planned, and closed automatically.",
  ].join("\n");
  try {
    const existing = await findOpenReminder();
    if (existing) {
      ensuredForPeriod = periodStart; // already open — leave it untouched
      return;
    }
    // Blocked, not Drafting: a human reminder needs no requirements or planning
    // pass, and Blocked keeps it visible on the board but out of every dispatcher.
    const issueNumber = await createIssue(SELF_REPO, REMINDER_TITLE, body, [LABELS.blocked], { blockedReason: BLOCKED_REASON });
    ensuredForPeriod = periodStart;
    log.info(`[${LOG_PREFIX}] reminder created (#${issueNumber})`);
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] failed: ${(err as Error).message}`); // retry next tick
  }
}
