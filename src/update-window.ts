/**
 * Out-of-hours window for third-party dependency-update PRs (Renovate,
 * Dependabot). Outside the window the dispatcher enqueues no work for them and
 * the auto-merger does not merge them, so they never hold a work worker during
 * the day. Own-app `automation/bump-*` image PRs are never third-party and are
 * never deferred.
 *
 * Time of day is always computed in the configured zone, never host-local time.
 */

import { THIRD_PARTY_UPDATE_WINDOW } from "./config.js";
import { isDependabotPR, normalizeBotLogin, type PR } from "./github.js";
import { getRepoConfig } from "./repo-config.js";

/** `HH:MM` → minutes since midnight. */
export function parseHHMM(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/** True when `minutesOfDay` lies in `[start, end)`; a window with `start > end` wraps midnight. */
export function minutesInWindow(minutesOfDay: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return minutesOfDay >= start && minutesOfDay < end;
  return minutesOfDay >= start || minutesOfDay < end;
}

/** Minutes since local midnight of `date` in `timezone`. */
export function localMinutesOfDay(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** True when `now` is inside the configured window, or the window is disabled. */
export function isInsideUpdateWindow(now: Date = new Date()): boolean {
  const w = THIRD_PARTY_UPDATE_WINDOW;
  if (!w.enabled) return true;
  return minutesInWindow(localMinutesOfDay(now, w.timezone), parseHHMM(w.start), parseHHMM(w.end));
}

/**
 * A Renovate or Dependabot PR. Branch prefix counts as well as author because
 * fleet-infra's Renovate runs with a PAT, so its PRs are authored by a human
 * login on `renovate/*` branches.
 */
export function isThirdPartyUpdatePR(pr: PR): boolean {
  if (isDependabotPR(pr)) return true;
  if (normalizeBotLogin(pr.author.login) === "renovate[bot]") return true;
  return pr.headRefName.startsWith("renovate/") || pr.headRefName.startsWith("dependabot/");
}

/** Whether Claws must leave this PR alone right now because the window is closed. */
export function isThirdPartyUpdateDeferred(repoFullName: string, pr: PR, now: Date = new Date()): boolean {
  if (!THIRD_PARTY_UPDATE_WINDOW.enabled) return false;
  if (getRepoConfig(repoFullName)?.dependencyUpdateWindow === false) return false;
  if (!isThirdPartyUpdatePR(pr)) return false;
  return !isInsideUpdateWindow(now);
}

/** e.g. `22:00–07:00 Europe/London`. */
export function describeUpdateWindow(): string {
  const w = THIRD_PARTY_UPDATE_WINDOW;
  return `${w.start}–${w.end} ${w.timezone}`;
}

/** Offset of `timezone` from UTC in minutes (positive east) at `date`. */
function utcOffsetMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** The zone's UTC offsets (minutes) on 1 January and 1 July, so a UTC cron can be checked across DST. */
export function utcOffsetsAcrossYear(timezone: string, year: number = new Date().getUTCFullYear()): { january: number; july: number } {
  return {
    january: utcOffsetMinutes(new Date(Date.UTC(year, 0, 1, 12)), timezone),
    july: utcOffsetMinutes(new Date(Date.UTC(year, 6, 1, 12)), timezone),
  };
}
