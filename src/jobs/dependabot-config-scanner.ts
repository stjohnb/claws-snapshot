import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { DEPENDENCY_SCHEDULE_CHECK_ENABLED, FLEET_INFRA_REPO, type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import { runRepoScanner, walkRepoTree, type ScannerSpec } from "./scanner-runner.js";

const NAME = "dependabot-config-scanner";
const ISSUE_TITLE = "Alert: missing dependency-update configuration";
const OPT_OUT_PATH = ".claws/dependency-updates-optout";

const DEPENDABOT_PATHS = [".github/dependabot.yml", ".github/dependabot.yaml"];
const RENOVATE_PATHS = [
  "renovate.json",
  "renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
];

const RENOVATE_WORKFLOW_PATHS = [".github/workflows/renovate.yml", ".github/workflows/renovate.yaml"];

/** The shared self-hosted Renovate CronJob's manifests, read from fleet-infra's local clone. */
const RENOVATE_CONFIGMAP_PATH = "apps/renovate/configmap.yaml";
const RENOVATE_CRONJOB_PATH = "apps/renovate/cronjob.yaml";

const NPM_LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"];

/** Canonical repo-relative directory form: POSIX, leading slash, no trailing slash, root is "/".
 *  Every directory — detected or parsed out of a dependabot.yml — must pass through this before
 *  comparison, or `/apps/mobile` and `apps/mobile/` compare unequal and produce false positives. */
export function normalizeDir(d: string): string {
  let s = d.trim().replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  if (s === "" || s === ".") return "/";
  return s.startsWith("/") ? s : `/${s}`;
}

/** Dependabot's exact `package-ecosystem` identifiers — Dependabot rejects the whole file on an
 *  unknown value, so these must not be prettified (`gomod`, not `golang`; `pip`, not `python`). */
function ecosystemForFile(name: string): string | null {
  if (name === "requirements.txt" || name === "pyproject.toml" || name === "Pipfile") return "pip";
  if (name === "go.mod") return "gomod";
  if (name === "Cargo.toml") return "cargo";
  if (name === "Gemfile") return "bundler";
  if (name === "pom.xml") return "maven";
  if (name === "build.gradle" || name === "build.gradle.kts") return "gradle";
  if (name === "composer.json") return "composer";
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return "docker";
  if (name.endsWith(".csproj") || name.endsWith(".sln")) return "nuget";
  if (name === "Package.swift") return "swift";
  if (name.endsWith(".tf")) return "terraform";
  return null;
}

/** "/" is an ancestor of everything but itself. */
function isProperAncestor(ancestor: string, child: string): boolean {
  if (ancestor === child) return false;
  if (ancestor === "/") return true;
  return child.startsWith(`${ancestor}/`);
}

/** Maps a Dependabot `package-ecosystem` value to the set of directories needing coverage. */
export function detectEcosystems(repoDir: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const npmCandidates: Array<{ dir: string; hasLock: boolean }> = [];

  const add = (eco: string, dir: string): void => {
    const norm = normalizeDir(dir);
    const dirs = found.get(eco);
    if (dirs) dirs.add(norm);
    else found.set(eco, new Set([norm]));
  };

  walkRepoTree(repoDir, {
    maxDepth: 3,
    onDirectory: ({ relPath, entries }) => {
      const fileNames = entries.filter(e => e.isFile()).map(e => e.name);
      for (const name of fileNames) {
        const eco = ecosystemForFile(name);
        if (eco) add(eco, relPath);
      }
      // package.json alone proves nothing — a workspace member has one but is covered by the root
      // lockfile. Decided in a post-pass once every candidate is known.
      if (fileNames.includes("package.json")) {
        npmCandidates.push({
          dir: normalizeDir(relPath),
          hasLock: NPM_LOCKFILES.some(l => fileNames.includes(l)),
        });
      }
    },
  });

  // Register an npm directory only if it owns a lockfile, or no ancestor package.json could be
  // covering it. Lockfile presence is the signal Dependabot itself uses; parsing the `workspaces`
  // key instead means reimplementing npm/yarn/pnpm glob semantics for a worse answer.
  for (const candidate of npmCandidates) {
    const coveredByAncestor = npmCandidates.some(other => isProperAncestor(other.dir, candidate.dir));
    if (candidate.hasLock || !coveredByAncestor) add("npm", candidate.dir);
  }

  // Dependabot resolves workflow files relative to the repo root, so this is always "/" —
  // `/.github/workflows` yields a config Dependabot silently ignores.
  let workflowEntries: fs.Dirent[] = [];
  try {
    workflowEntries = fs.readdirSync(path.join(repoDir, ".github", "workflows"), { withFileTypes: true });
  } catch {
    workflowEntries = [];
  }
  if (workflowEntries.some(e => e.isFile() && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")))) {
    add("github-actions", "/");
  }

  return found;
}

/** Coverage declared by a dependabot.yml. Returns null when the file cannot be read as a config —
 *  the caller must treat that as "unknown", never as "uncovered".
 *
 *  `glob: true` (an entry using `directories:`) marks the ecosystem covered everywhere: the key
 *  supports globs, and matching them properly is a false-positive generator. Conservative by design. */
export function parseCoverage(content: string): Map<string, { dirs: Set<string>; glob: boolean }> | null {
  let doc: unknown;
  try {
    doc = parse(content);
  } catch {
    return null;
  }

  const updates = (doc as { updates?: unknown } | null | undefined)?.updates;
  if (!Array.isArray(updates)) return null;

  const coverage = new Map<string, { dirs: Set<string>; glob: boolean }>();
  for (const entry of updates) {
    if (!entry || typeof entry !== "object") continue;
    const fields = entry as Record<string, unknown>;

    const eco = fields["package-ecosystem"];
    if (typeof eco !== "string" || eco.trim() === "") continue;

    const glob = Array.isArray(fields["directories"]);
    const dir = typeof fields["directory"] === "string" ? normalizeDir(fields["directory"]) : null;
    if (!glob && dir === null) continue;

    let record = coverage.get(eco);
    if (!record) {
      record = { dirs: new Set<string>(), glob: false };
      coverage.set(eco, record);
    }
    if (glob) record.glob = true;
    else if (dir !== null) record.dirs.add(dir);
  }
  return coverage;
}

function sortedDirs(dirs: Set<string>): string[] {
  return [...dirs].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

/** Hand-built rather than `yaml.stringify` so formatting is fixed and test assertions are stable. */
export function renderUpdateEntries(ecosystems: Map<string, Set<string>>): string {
  const blocks: string[] = [];
  for (const eco of [...ecosystems.keys()].sort()) {
    for (const dir of sortedDirs(ecosystems.get(eco) ?? new Set())) {
      blocks.push([
        `  - package-ecosystem: ${eco}`,
        `    directory: ${dir}`,
        "    schedule:",
        "      interval: weekly",
        `      time: "${recommendedDependabotTime()}"`,
        `      timezone: ${OFFICE_HOURS.timezone}`,
        "    open-pull-requests-limit: 5",
        // Grouping is load-bearing, not cosmetic: auto-merger exempts Dependabot PRs from the
        // approval requirement, so ungrouped updates across several entries auto-merge as a flood.
        "    groups:",
        "      all-dependencies:",
        "        patterns:",
        '          - "*"',
        "    labels: []",
      ].join("\n"));
    }
  }
  return blocks.join("\n\n");
}

function pairList(ecosystems: Map<string, Set<string>>): string[] {
  const pairs: string[] = [];
  for (const eco of [...ecosystems.keys()].sort()) {
    for (const dir of sortedDirs(ecosystems.get(eco) ?? new Set())) {
      pairs.push(`\`${eco}\` at \`${dir}\``);
    }
  }
  return pairs;
}

function formatIssueBody(repo: Repo, ecosystems: Map<string, Set<string>>, mode: "full" | "partial"): string {
  const lines: string[] = [];

  if (mode === "full") {
    lines.push(
      "This repo has no dependency-update mechanism — no `.github/dependabot.yml`, no Renovate config — so its dependencies drift indefinitely with nothing to notice.",
      "",
      "St-John-Software/bin-scraper#201 is what that looks like in practice: Express pinned at `4.17.1` (released 2019), carrying known high-severity advisories in `qs`, `body-parser`, `send`, `serve-static`, and `path-to-regexp`, reachable from unauthenticated routes. It drifted for years unnoticed, and `dependabot-alert-monitor` never saw it because that job only reports on repos where Dependabot scanning is already enabled.",
      "",
      "Detected ecosystems needing coverage:",
      "",
      ...pairList(ecosystems).map(p => `- ${p}`),
      "",
      "Create `.github/dependabot.yml` with exactly:",
      "",
      "```yaml",
      "version: 2",
      "updates:",
      renderUpdateEntries(ecosystems),
      "```",
    );
  } else {
    lines.push(
      "`.github/dependabot.yml` exists but does not cover every detected ecosystem/directory pair. Dependabot resolves each `directory` independently, so a manifest in an uncovered directory is never updated — even when the same ecosystem is covered elsewhere in the repo.",
      "",
      "Missing coverage:",
      "",
      ...pairList(ecosystems).map(p => `- ${p}`),
      "",
      "Append these entries under the existing `updates:` key, **without altering the existing entries**:",
      "",
      "```yaml",
      renderUpdateEntries(ecosystems),
      "```",
    );
  }

  lines.push(...optOutFooter(repo, false));

  return lines.join("\n");
}

function optOutFooter(repo: Repo, schedule: boolean): string[] {
  const lines = [
    "",
    "---",
    "",
    "If this repo should not have dependency updates managed, opt out either by committing an empty `" + OPT_OUT_PATH + "` file, or by adding `\"" + NAME + "\"` to `disabledJobsByRepo[\"" + repo.fullName + "\"]` in the Claws config.",
  ];
  if (schedule) {
    lines.push(
      "",
      "To turn off this schedule check for every repo, set `\"dependencyScheduleCheckEnabled\": false` in the Claws config.",
    );
  }
  return lines;
}

// ── Schedule check: update PRs should be opened outside office hours ──

/** Claws processes update PRs at any hour; PRs opened in this range compete with planning and implementation for the work workers. */
const OFFICE_HOURS = { start: "08:00", end: "18:00", timezone: "Europe/London" };
const RECOMMENDED_TIME = "19:00";
const RECOMMENDED_RENOVATE_SCHEDULE = ["after 7pm"];
/** GitHub cron is UTC: 19:00 GMT in winter, 20:00 BST in summer — evening either way. */
const RECOMMENDED_RENOVATE_CRON = "0 19 * * *";

const OFFICE_HOURS_DESC = `${OFFICE_HOURS.start}–${OFFICE_HOURS.end} ${OFFICE_HOURS.timezone}`;
const RENOVATE_SCHEDULE_SUMMARY = `Renovate schedule inside office hours (${OFFICE_HOURS_DESC})`;

/** `HH:MM` → minutes since midnight. */
export function parseHHMM(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/** True when `minutesOfDay` lies in `[start, end)`; a range with `start > end` wraps midnight. */
export function minutesInRange(minutesOfDay: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return minutesOfDay >= start && minutesOfDay < end;
  return minutesOfDay >= start || minutesOfDay < end;
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

/** True when a local minute-of-day falls in office hours. */
function inOfficeHours(minutesOfDay: number): boolean {
  return minutesInRange(minutesOfDay, parseHHMM(OFFICE_HOURS.start), parseHHMM(OFFICE_HOURS.end));
}

/** The `time:` to recommend for a Dependabot entry. */
export function recommendedDependabotTime(): string {
  return RECOMMENDED_TIME;
}

/** True when any part of `[from, to)` (minutes of day, wrapping midnight; `from === to` is the whole day) overlaps office hours. */
function rangeOverlapsOfficeHours(from: number, to: number): boolean {
  const start = parseHHMM(OFFICE_HOURS.start);
  const end = parseHHMM(OFFICE_HOURS.end);
  const overlaps = (a: number, b: number): boolean => a < end && b > start;
  return from < to ? overlaps(from, to) : overlaps(from, 1440) || overlaps(0, to);
}

function sameZone(a: unknown): boolean {
  return typeof a === "string" && a.toLowerCase() === OFFICE_HOURS.timezone.toLowerCase();
}

export interface DependabotSchedule {
  ecosystem: string;
  directory: string;
  interval: string | null;
  day: string | null;
  time: string | null;
  timezone: string | null;
}

/** Every `updates` entry's schedule. Null when the file cannot be read as a config. */
export function parseSchedules(content: string): DependabotSchedule[] | null {
  let doc: unknown;
  try {
    doc = parse(content);
  } catch {
    return null;
  }
  const updates = (doc as { updates?: unknown } | null | undefined)?.updates;
  if (!Array.isArray(updates)) return null;

  const str = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  const out: DependabotSchedule[] = [];
  for (const entry of updates) {
    if (!entry || typeof entry !== "object") continue;
    const fields = entry as Record<string, unknown>;
    const eco = fields["package-ecosystem"];
    if (typeof eco !== "string" || eco.trim() === "") continue;
    const dirs = fields["directories"];
    const directory = Array.isArray(dirs)
      ? dirs.map(String).join(", ")
      : typeof fields["directory"] === "string" ? normalizeDir(fields["directory"]) : "/";
    const schedule = (fields["schedule"] && typeof fields["schedule"] === "object" ? fields["schedule"] : {}) as Record<string, unknown>;
    out.push({
      ecosystem: eco,
      directory,
      interval: str(schedule["interval"]),
      day: str(schedule["day"]),
      time: str(schedule["time"]),
      timezone: str(schedule["timezone"]),
    });
  }
  return out;
}

/** Entries whose PRs could open in office hours. Unparseable times warn and count as compliant. */
function dependabotScheduleViolations(repo: Repo, entries: DependabotSchedule[]): DependabotSchedule[] {
  return entries.filter((e) => {
    // `interval: cron` carries its own expression; not checked.
    if (e.interval === "cron") return false;
    if (e.time === null || !sameZone(e.timezone)) return true;
    if (!/^\d{1,2}:\d{2}$/.test(e.time)) {
      log.warn(`[${NAME}] ${repo.fullName}: unparseable dependabot schedule time "${e.time}" — skipping`);
      return false;
    }
    return inOfficeHours(parseHHMM(e.time));
  });
}

function officeHoursPreamble(): string {
  return `Claws processes dependency-update PRs at any hour, but PRs opened in office hours (${OFFICE_HOURS_DESC}) compete with planning and implementation for the work workers, so schedule update tools to open PRs at ${RECOMMENDED_TIME} ${OFFICE_HOURS.timezone}.`;
}

function formatDependabotScheduleBody(repo: Repo, path: string, offending: DependabotSchedule[]): string {
  const lines: string[] = [
    officeHoursPreamble(),
    "",
    `\`${path}\` has entries whose schedule falls inside office hours, or leaves \`time\`/\`timezone\` unset (Dependabot then picks a time itself, which may be daytime):`,
    "",
  ];
  for (const e of offending) {
    const time = e.time === null ? "no time" : `time "${e.time}"`;
    lines.push(`- \`${e.ecosystem}\` at \`${e.directory}\` — ${time} ${e.timezone ?? "no timezone"}`);
  }
  lines.push("", "Replace each listed entry's `schedule:` block with exactly:", "");
  for (const e of offending) {
    lines.push(
      `\`${e.ecosystem}\` at \`${e.directory}\`:`,
      "",
      "```yaml",
      "    schedule:",
      `      interval: ${e.interval ?? "weekly"}`,
      ...(e.day !== null ? [`      day: ${e.day}`] : []),
      `      time: "${recommendedDependabotTime()}"`,
      `      timezone: ${OFFICE_HOURS.timezone}`,
      "```",
      "",
    );
  }
  lines.pop();
  lines.push(...optOutFooter(repo, true));
  return lines.join("\n");
}

/** The Renovate `schedule` to recommend: a single entry, so no overnight split is needed. */
function recommendedRenovateSchedule(): string[] {
  return RECOMMENDED_RENOVATE_SCHEDULE;
}

const RENOVATE_TIME = "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)";
const RENOVATE_AFTER_AND_BEFORE = new RegExp(`^after ${RENOVATE_TIME} and before ${RENOVATE_TIME}$`, "i");
const RENOVATE_AFTER = new RegExp(`^after ${RENOVATE_TIME}$`, "i");
const RENOVATE_BEFORE = new RegExp(`^before ${RENOVATE_TIME}$`, "i");

function amPmMinutes(hour: string, minute: string | undefined, suffix: string): number {
  return ((Number(hour) % 12) + (suffix.toLowerCase() === "pm" ? 12 : 0)) * 60 + Number(minute ?? 0);
}

/** Parses a standalone Renovate schedule entry into the range it represents. Renovate schedule entries
 *  are OR'd, so `after X` alone means [X, midnight) and `before Y` alone means [midnight, Y). Returns
 *  null for anything else (day-of-week qualifiers, `every weekend`, cron-style strings, …). */
function parseRenovateScheduleEntry(text: string): { from: number; to: number } | null {
  let m = RENOVATE_AFTER_AND_BEFORE.exec(text);
  if (m) return { from: amPmMinutes(m[1]!, m[2], m[3]!), to: amPmMinutes(m[4]!, m[5], m[6]!) };
  m = RENOVATE_AFTER.exec(text);
  if (m) return { from: amPmMinutes(m[1]!, m[2], m[3]!), to: 0 };
  m = RENOVATE_BEFORE.exec(text);
  if (m) return { from: 0, to: amPmMinutes(m[1]!, m[2], m[3]!) };
  return null;
}

/** The GitHub `renovate.yml` cron to recommend. */
function recommendedCron(): string {
  return RECOMMENDED_RENOVATE_CRON;
}

export interface ExternalRenovate {
  /** Lowercased `owner/name` full names the shared CronJob runs Renovate against. */
  repos: Set<string>;
  schedule: string | null;
  timeZone: string | null;
}

/** Reads the shared self-hosted Renovate CronJob's manifests from fleet-infra's local clone.
 *  Synchronous and filesystem-only, like the rest of this scanner — `scanner-dispatcher` refreshes
 *  every repo's clone before running any scanner, so the clone is present and fresh. */
function loadExternalRenovate(): ExternalRenovate | null {
  const [owner, name] = FLEET_INFRA_REPO.split("/");
  const dir = claude.repoDir({ owner, name } as Repo);
  const configmapPath = path.join(dir, RENOVATE_CONFIGMAP_PATH);
  const cronjobPath = path.join(dir, RENOVATE_CRONJOB_PATH);

  if (!fs.existsSync(configmapPath) || !fs.existsSync(cronjobPath)) {
    log.info(`[${NAME}] no self-hosted Renovate manifests in ${FLEET_INFRA_REPO} clone — skipping external schedule check`);
    return null;
  }

  try {
    const configmap = parse(fs.readFileSync(configmapPath, "utf8")) as { data?: Record<string, unknown> };
    const configJson = JSON.parse(String(configmap.data?.["config.json"])) as { repositories?: unknown };
    const repositories = Array.isArray(configJson.repositories) ? configJson.repositories : [];
    const repos = new Set(repositories.map((r) => String(r).toLowerCase()));

    const cronjob = parse(fs.readFileSync(cronjobPath, "utf8")) as { spec?: Record<string, unknown> };
    const schedule = typeof cronjob.spec?.["schedule"] === "string" ? (cronjob.spec["schedule"] as string) : null;
    const timeZone = typeof cronjob.spec?.["timeZone"] === "string" ? (cronjob.spec["timeZone"] as string) : null;

    return { repos, schedule, timeZone };
  } catch {
    log.warn(`[${NAME}] unreadable or unparseable ${FLEET_INFRA_REPO} Renovate manifests — skipping external schedule check`);
    return null;
  }
}

/** Human-readable problems with the shared fleet-infra Renovate CronJob's schedule; empty when compliant. */
export function cronJobScheduleProblems(ext: ExternalRenovate): string[] {
  const problems: string[] = [];
  const w = OFFICE_HOURS;

  if (!sameZone(ext.timeZone)) {
    problems.push(
      ext.timeZone
        ? `\`${RENOVATE_CRONJOB_PATH}\`: \`timeZone\` is \`${ext.timeZone}\`, not \`${w.timezone}\``
        : `\`${RENOVATE_CRONJOB_PATH}\`: \`timeZone\` is unset, not \`${w.timezone}\``,
    );
  }

  if (!ext.schedule) {
    problems.push(`\`${RENOVATE_CRONJOB_PATH}\`: \`schedule\` is unset`);
    return problems;
  }

  const minutes = cronJobStartMinutes(ext);
  if (minutes === null) {
    log.warn(`[${NAME}] ${FLEET_INFRA_REPO}: unparseable ${RENOVATE_CRONJOB_PATH} schedule "${ext.schedule}" — skipping its time check`);
    return problems;
  }

  if (inOfficeHours(minutes)) {
    problems.push(
      `\`${RENOVATE_CRONJOB_PATH}\`: schedule \`${ext.schedule}\` (${w.timezone}) starts Renovate at ${formatMinutes(minutes)}, inside office hours`,
    );
  }
  return problems;
}

/** The shared CronJob's local start time in minutes of day, or null when its schedule is unset or its hour field is not a plain number. */
function cronJobStartMinutes(ext: ExternalRenovate): number | null {
  if (!ext.schedule) return null;
  const [minuteField, hourField] = ext.schedule.trim().split(/\s+/);
  if (!hourField || !/^\d+$/.test(hourField)) return null;
  const minute = minuteField && /^\d+$/.test(minuteField) ? Number(minuteField) : 0;
  return Number(hourField) * 60 + minute;
}

/** Minutes of day → `HH:MM`. */
function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `0 10 * * 1` → `0 19 * * 1`: keeps the original day-of-week, sets the recommended evening time. */
export function recommendedCronJobSchedule(original: string): string {
  const [hour, minute] = RECOMMENDED_TIME.split(":").map(Number);
  const dayOfWeek = original.trim().split(/\s+/)[4] ?? "*";
  return `${minute} ${hour} * * ${dayOfWeek}`;
}

interface RenovateProblems {
  /** Problems with the config's `timezone`/`schedule`. */
  config: string[];
  /** Problems with the trigger workflow's cron. */
  cron: string[];
  /** Problems with the shared fleet-infra Renovate CronJob's schedule (fleet-infra only). */
  cronJob: string[];
}

/** Human-readable problems with a Renovate config and its trigger workflow; both empty when compliant.
 *  `ext` adds the shared CronJob's own schedule problems (fleet-infra only). `overlayOn` marks the config as a
 *  per-repo overlay on that CronJob: an unset `timezone`/`schedule` is fine there (the CronJob sets the timing),
 *  but a `schedule` that excludes the CronJob's start time is flagged, since Renovate would then open no PRs. */
function renovateScheduleViolations(
  repoDir: string,
  repo: Repo,
  configPath: string,
  ext?: ExternalRenovate,
  overlayOn?: ExternalRenovate,
): RenovateProblems {
  const problems: string[] = [];
  const cronProblems: string[] = [];
  const w = OFFICE_HOURS;

  let config: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(repoDir, configPath), "utf8"));
    if (parsed && typeof parsed === "object") config = parsed as Record<string, unknown>;
  } catch {
    config = null;
  }
  const extendsList = config && Array.isArray(config["extends"]) ? config["extends"].map(String) : [];
  const opaquePreset = extendsList.find((e) => /^schedule:/i.test(e) || /^(local|github)>/i.test(e));
  if (!config) {
    log.warn(`[${NAME}] ${repo.fullName}: unparseable ${configPath} — skipping its schedule check`);
  } else if (opaquePreset) {
    log.warn(`[${NAME}] ${repo.fullName}: ${configPath} extends \`"${opaquePreset}"\` — cannot read its schedule, skipping the config-key check`);
  } else {
    if (!sameZone(config["timezone"]) && !(overlayOn && config["timezone"] === undefined)) {
      problems.push(
        typeof config["timezone"] === "string"
          ? `\`${configPath}\`: \`"timezone"\` is \`"${config["timezone"]}"\`, not \`"${w.timezone}"\``
          : `\`${configPath}\`: \`"timezone"\` is unset`,
      );
    }
    const raw = config["schedule"];
    const schedule = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    if (schedule.length === 0 && !overlayOn) {
      problems.push(`\`${configPath}\`: \`"schedule"\` is unset, so Renovate opens PRs at any time`);
    }
    // Whether some entry admits the shared CronJob's start time; stays false only when every entry parsed and none does.
    const cronJobStart = overlayOn ? cronJobStartMinutes(overlayOn) : null;
    let admitsCronJob = schedule.length === 0 || cronJobStart === null;
    for (const entry of schedule) {
      const text = String(entry).trim();
      if (/^at any time$/i.test(text)) {
        admitsCronJob = true;
        problems.push(`\`${configPath}\`: \`"schedule"\` entry \`"${text}"\` allows any time`);
        continue;
      }
      const parsed = parseRenovateScheduleEntry(text);
      if (!parsed) {
        admitsCronJob = true;
        log.warn(`[${NAME}] ${repo.fullName}: unparseable Renovate schedule "${text}" — skipping`);
        continue;
      }
      if (cronJobStart !== null && minutesInRange(cronJobStart, parsed.from, parsed.to)) admitsCronJob = true;
      if (rangeOverlapsOfficeHours(parsed.from, parsed.to)) {
        problems.push(`\`${configPath}\`: \`"schedule"\` entry \`"${text}"\` falls inside office hours`);
      }
    }
    if (!admitsCronJob && cronJobStart !== null) {
      const entries = schedule.map((e) => `"${String(e).trim()}"`).join(", ");
      problems.push(
        `\`${configPath}\`: \`"schedule"\` \`[${entries}]\` excludes the shared ${FLEET_INFRA_REPO} CronJob's ${formatMinutes(cronJobStart)} run, so Renovate opens no PRs for this repo`,
      );
    }
  }

  const workflowPath = RENOVATE_WORKFLOW_PATHS.find((p) => fs.existsSync(path.join(repoDir, p)));
  if (workflowPath) {
    let doc: unknown;
    try {
      doc = parse(fs.readFileSync(path.join(repoDir, workflowPath), "utf8"));
    } catch {
      log.warn(`[${NAME}] ${repo.fullName}: unparseable ${workflowPath} — skipping its cron check`);
      doc = null;
    }
    const on = (doc as { on?: unknown } | null)?.on;
    const crons = on && typeof on === "object" ? (on as { schedule?: unknown }).schedule : undefined;
    const { january, july } = utcOffsetsAcrossYear(w.timezone);
    for (const item of Array.isArray(crons) ? crons : []) {
      const cron = (item as { cron?: unknown } | null)?.cron;
      if (typeof cron !== "string") continue;
      const [minuteField, hourField] = cron.trim().split(/\s+/);
      if (!hourField || !/^\d+$/.test(hourField)) continue;
      const utc = Number(hourField) * 60 + (minuteField && /^\d+$/.test(minuteField) ? Number(minuteField) : 0);
      const daytime = [january, july].some((offset) => inOfficeHours((utc + offset + 1440) % 1440));
      if (daytime) {
        cronProblems.push(`\`${workflowPath}\`: cron \`${cron}\` (UTC) starts Renovate inside office hours in at least part of the year`);
      }
    }
  }

  return { config: problems, cron: cronProblems, cronJob: ext ? cronJobScheduleProblems(ext) : [] };
}

function formatRenovateScheduleBody(repo: Repo, problems: RenovateProblems, ext?: ExternalRenovate): string {
  const w = OFFICE_HOURS;
  const lines: string[] = [
    officeHoursPreamble(),
    "",
    "This repo's Renovate setup can open PRs in office hours, or never opens them:",
    "",
    ...[...problems.config, ...problems.cron, ...problems.cronJob].map((p) => `- ${p}`),
  ];
  if (problems.config.length) {
    const schedule = recommendedRenovateSchedule();
    const scheduleJson = `[${schedule.map((s) => JSON.stringify(s)).join(", ")}]`;
    lines.push(
      "",
      "Set these top-level keys in the Renovate config:",
      "",
      "```json",
      `"timezone": "${w.timezone}",`,
      `"schedule": ${scheduleJson}`,
      "```",
    );
  }
  if (problems.cron.length) {
    lines.push(
      "",
      `Change the Renovate workflow's \`on.schedule\` cron to \`${recommendedCron()}\` — GitHub cron is UTC, so this starts at 19:00 in winter and 20:00 in summer, both outside office hours.`,
    );
  }
  if (problems.cronJob.length) {
    lines.push(
      "",
      "Set these in `apps/renovate/cronjob.yaml` (the CronJob evaluates its cron in `timeZone`, so no UTC conversion is needed; any weekday is fine as long as the run stays weekly and in the evening):",
      "",
      "```yaml",
      `schedule: "${recommendedCronJobSchedule(ext?.schedule ?? "* * * * *")}"`,
      `timeZone: ${w.timezone}`,
      "```",
    );
  }
  lines.push(...optOutFooter(repo, true));
  return lines.join("\n");
}

function scheduleCheckEnabled(): boolean {
  return DEPENDENCY_SCHEDULE_CHECK_ENABLED;
}

function scan(repoDir: string, repo: Repo, external: ExternalRenovate | null): { body: string; summary?: string } | null {
  const isFleetInfra = repo.fullName.toLowerCase() === FLEET_INFRA_REPO.toLowerCase();
  const optedOut = fs.existsSync(path.join(repoDir, OPT_OUT_PATH));

  if (external?.repos.has(repo.fullName.toLowerCase())) {
    const scheduleDesc = `\`${external.schedule ?? "unset"}\` ${external.timeZone ?? "no timezone"}`;
    const cronJob = cronJobScheduleProblems(external);
    const outcome =
      cronJob.length === 0
        ? "outside office hours"
        : scheduleCheckEnabled()
          ? `inside office hours; reported on ${FLEET_INFRA_REPO}`
          : "inside office hours; schedule check disabled";
    log.info(
      `[${NAME}] ${repo.fullName}: dependency updates are scheduled externally by ${FLEET_INFRA_REPO} ${RENOVATE_CRONJOB_PATH} (${scheduleDesc}) — ${outcome}`,
    );
    if (optedOut || !scheduleCheckEnabled()) return null;
    // A listed repo's own Renovate config is an overlay the CronJob applies on top of the shared
    // config, so check it against the CronJob's run time. fleet-infra hosts the CronJob and is
    // listed in its own `repositories`, so its CronJob check runs here too.
    const renovatePath = RENOVATE_PATHS.find(p => fs.existsSync(path.join(repoDir, p)));
    const problems: RenovateProblems = renovatePath
      ? renovateScheduleViolations(repoDir, repo, renovatePath, isFleetInfra ? external : undefined, external)
      : { config: [], cron: [], cronJob: isFleetInfra ? cronJob : [] };
    if (problems.config.length === 0 && problems.cron.length === 0 && problems.cronJob.length === 0) return null;
    return {
      body: formatRenovateScheduleBody(repo, problems, external),
      summary: RENOVATE_SCHEDULE_SUMMARY,
    };
  }

  if (optedOut) return null;

  const detected = detectEcosystems(repoDir);
  if (detected.size === 0) return null;

  // Renovate auto-detects every ecosystem by default, so any coverage check against it is a
  // guaranteed false positive. Presence of a config is enough for coverage.
  const renovatePath = RENOVATE_PATHS.find(p => fs.existsSync(path.join(repoDir, p)));
  if (renovatePath) {
    if (!scheduleCheckEnabled()) return null;
    const ext = isFleetInfra && external ? external : undefined;
    const problems = renovateScheduleViolations(repoDir, repo, renovatePath, ext);
    if (problems.config.length === 0 && problems.cron.length === 0 && problems.cronJob.length === 0) return null;
    return {
      body: formatRenovateScheduleBody(repo, problems, ext),
      summary: RENOVATE_SCHEDULE_SUMMARY,
    };
  }

  // Reached only when fleet-infra is not in the shared CronJob's `repositories` and has no
  // Renovate config of its own, so the CronJob it hosts is the only schedule to check for it.
  if (isFleetInfra && external && scheduleCheckEnabled()) {
    const cronJob = cronJobScheduleProblems(external);
    if (cronJob.length > 0) {
      return {
        body: formatRenovateScheduleBody(repo, { config: [], cron: [], cronJob }, external),
        summary: RENOVATE_SCHEDULE_SUMMARY,
      };
    }
  }

  const dependabotPath = DEPENDABOT_PATHS.find(p => fs.existsSync(path.join(repoDir, p)));
  if (dependabotPath) {
    const content = fs.readFileSync(path.join(repoDir, dependabotPath), "utf8");
    const coverage = parseCoverage(content);
    if (!coverage) {
      log.warn(`[${NAME}] ${repo.fullName}: unparseable ${dependabotPath} — skipping`);
      return null;
    }

    const missing = new Map<string, Set<string>>();
    for (const [eco, dirs] of detected) {
      const covered = coverage.get(eco);
      for (const dir of dirs) {
        if (covered && (covered.glob || covered.dirs.has(dir))) continue;
        const existing = missing.get(eco);
        if (existing) existing.add(dir);
        else missing.set(eco, new Set([dir]));
      }
    }

    if (missing.size > 0) {
      return {
        body: formatIssueBody(repo, missing, "partial"),
        summary: `Missing dependabot coverage: ${summarize(missing)}`,
      };
    }

    if (!scheduleCheckEnabled()) return null;
    const offending = dependabotScheduleViolations(repo, parseSchedules(content) ?? []);
    if (offending.length === 0) return null;
    return {
      body: formatDependabotScheduleBody(repo, dependabotPath, offending),
      summary: `Dependabot schedule inside office hours (${OFFICE_HOURS_DESC}): ${offending.map(e => `${e.ecosystem}@${e.directory}`).join(", ")}`,
    };
  }

  return {
    body: formatIssueBody(repo, detected, "full"),
    summary: `No dependency-update mechanism; needs coverage for ${summarize(detected)}`,
  };
}

function summarize(ecosystems: Map<string, Set<string>>): string {
  const parts: string[] = [];
  for (const eco of [...ecosystems.keys()].sort()) {
    for (const dir of sortedDirs(ecosystems.get(eco) ?? new Set())) parts.push(`${eco}@${dir}`);
  }
  return parts.join(", ");
}

const SPEC: Omit<ScannerSpec, "scan"> = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  // Deliberately unlabelled: missing dependency-update config is routine hygiene,
  // not an outage, and Priority-queue flooding is a known problem in this repo (#2809).
};

export function run(repos: Repo[]): Promise<void> {
  const external = loadExternalRenovate();
  return runRepoScanner({ ...SPEC, scan: (dir, repo) => scan(dir, repo, external) }, repos);
}
