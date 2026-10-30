/**
 * When a Claude usage limit resets, read from the CLI's limit message:
 * `You've hit your limit · resets 2am (Europe/London)`, `… resets 12pm`,
 * `… resets 5:30pm`. The CLI prints a wall-clock time and, usually, the IANA
 * zone it is in; this module turns that into the next such instant.
 */

/** Extra hold past the printed reset, so a run does not start a moment early. */
export const RESET_GRACE_MS = 60 * 1000;

const RESET_RE = /\bresets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)\s]+)\))?/i;

/** This process's IANA zone, the default for a reset time printed without one. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function isValidZone(zone: string | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of `ms` in `zone`. */
function zonedParts(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** `zone`'s offset from UTC at instant `ms`, in ms (positive east of Greenwich). */
function zoneOffsetMs(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant the wall-clock time `y-m-d h:min` reads in `zone`. */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - zoneOffsetMs(naive, zone);
  // Second pass settles a guess that crossed a DST change.
  guess = naive - zoneOffsetMs(guess, zone);
  return guess;
}

/**
 * The next instant after `nowMs` at the reset time printed in `msg`, in the
 * printed zone — else `defaultZone`, else UTC when neither is a valid IANA
 * zone. Null when `msg` has no `resets <h>[:mm]<am|pm>`.
 */
export function parseUsageLimitReset(msg: string, nowMs: number, defaultZone?: string): number | null {
  const m = RESET_RE.exec(msg);
  if (!m) return null;
  const hour12 = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (m[3]!.toLowerCase() === "pm" ? 12 : 0);
  const zone = isValidZone(m[4]) ? m[4] : isValidZone(defaultZone) ? defaultZone : "UTC";
  const today = zonedParts(nowMs, zone);
  let at = zonedToUtc(today.year, today.month, today.day, hour, minute, zone);
  if (at <= nowMs) {
    // Date.UTC normalises day + 1 across month and year ends.
    const tomorrow = zonedParts(Date.UTC(today.year, today.month - 1, today.day + 1, 12), "UTC");
    at = zonedToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, zone);
  }
  return at;
}

/**
 * When a usage-limit hold from `msg` should end: the printed reset plus
 * `RESET_GRACE_MS` (even when that is sooner than the fixed cooldown); the
 * fixed cooldown `fixedCooldownMs` from now when no reset time is printed.
 */
export function usageLimitHoldUntil(msg: string, nowMs: number, fixedCooldownMs: number, defaultZone?: string): number {
  const reset = parseUsageLimitReset(msg, nowMs, defaultZone);
  return reset === null ? nowMs + fixedCooldownMs : reset + RESET_GRACE_MS;
}
