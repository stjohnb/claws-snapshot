import { LABELS, SELF_REPO } from "../config.js";
import { hasDampReadingLoggedSince } from "../db.js";
import { closeIssue, commentOnIssue, createIssue, findIssueByExactTitle } from "../github.js";
import * as log from "../log.js";

const LOG_PREFIX = "damp-reminder";
const REMINDER_TITLE = "[damp-reminder] Log this week's damp meter readings";
const REMINDER_WEEKDAY = 1; // Monday, local time
const REMINDER_HOUR = 9; // don't create the weekly reminder before 9 AM local

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

// Once we've handled the close for a given week (closed the issue, or found
// none open), remember it so we don't hit the GitHub API every tick all week.
let closedForWeek: string | null = null;

// Once we've ensured the reminder exists for a given week (created it, or
// found one already open), remember it so we don't hit the GitHub API every
// tick all week.
let ensuredForWeek: string | null = null;

export async function run(now: Date = new Date()): Promise<void> {
  const weekStart = weekStartMonday(now).toISOString();
  const loggedThisWeek = hasDampReadingLoggedSince(weekStart);

  // This week's readings are in — auto-close the open reminder (once per week).
  if (loggedThisWeek) {
    if (closedForWeek === weekStart) return;
    try {
      const existing = await findIssueByExactTitle(SELF_REPO, REMINDER_TITLE);
      if (existing) {
        // Close first: once this succeeds, the issue drops out of findIssueByExactTitle's
        // open-issue search, so a failure below (or on the next tick) can't repost this comment.
        await closeIssue(SELF_REPO, existing.number, "completed");
        closedForWeek = weekStart;
        log.info(`[${LOG_PREFIX}] auto-closed reminder (#${existing.number}) — readings logged this week`);
        await commentOnIssue(
          SELF_REPO,
          existing.number,
          "This week's damp readings have been logged — closing automatically. A fresh reminder is created next Monday.",
        );
      } else {
        closedForWeek = weekStart; // done for this week — no open issue to close
      }
    } catch (err) {
      log.warn(`[${LOG_PREFIX}] auto-close failed: ${(err as Error).message}`); // retry next tick
    }
    return;
  }

  // No readings yet — file the reminder on Monday mornings only.
  if (!isReminderDay(now) || now.getHours() < REMINDER_HOUR) return;
  if (ensuredForWeek === weekStart) return; // already ensured this week
  const body = [
    "Weekly reminder to record damp meter readings.",
    "",
    "Open the dashboard **Damp** page (`/damp`) and log a value for each measurement point.",
    "",
    "Close this issue once you've logged this week's readings (Claws will also close it automatically once it sees them) — a fresh reminder is created next Monday.",
  ].join("\n");
  try {
    const existing = await findIssueByExactTitle(SELF_REPO, REMINDER_TITLE);
    if (existing) {
      ensuredForWeek = weekStart; // already open — leave it untouched
      return;
    }
    const issueNumber = await createIssue(SELF_REPO, REMINDER_TITLE, body, [LABELS.priority]);
    ensuredForWeek = weekStart;
    log.info(`[${LOG_PREFIX}] reminder created (#${issueNumber})`);
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] failed: ${(err as Error).message}`); // retry next tick
  }
}
