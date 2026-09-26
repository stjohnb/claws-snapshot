import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { THIRD_PARTY_UPDATE_WINDOW, type Repo } from "../config.js";
import * as log from "../log.js";
import { getRepoConfig } from "../repo-config.js";
import { describeUpdateWindow, minutesInWindow, parseHHMM, utcOffsetsAcrossYear } from "../update-window.js";
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
        `      timezone: ${THIRD_PARTY_UPDATE_WINDOW.timezone}`,
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
      "If this repo's update PRs must run outside the out-of-hours window, set `\"dependencyUpdateWindow\": false` in its `claws.json` instead — that exempts it from this schedule check and from the window Claws applies to its update PRs.",
    );
  }
  return lines;
}

// ── Schedule check: update PRs should be opened inside the out-of-hours window ──

/** The `time:` to recommend for a Dependabot entry: 03:00 when the window covers it, else the window start. */
export function recommendedDependabotTime(): string {
  const w = THIRD_PARTY_UPDATE_WINDOW;
  return minutesInWindow(3 * 60, parseHHMM(w.start), parseHHMM(w.end)) ? "03:00" : w.start;
}

/** True when the whole range `[from, to)` (minutes of day, wrapping midnight) lies inside the window. */
function rangeInsideWindow(from: number, to: number): boolean {
  const w = THIRD_PARTY_UPDATE_WINDOW;
  const start = parseHHMM(w.start);
  const windowLength = (parseHHMM(w.end) - start + 1440) % 1440 || 1440;
  const rangeLength = (to - from + 1440) % 1440 || 1440;
  return ((from - start + 1440) % 1440) + rangeLength <= windowLength;
}

function sameZone(a: unknown): boolean {
  return typeof a === "string" && a.toLowerCase() === THIRD_PARTY_UPDATE_WINDOW.timezone.toLowerCase();
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

/** Entries whose PRs could open outside the window. Unparseable times warn and count as compliant. */
function dependabotScheduleViolations(repo: Repo, entries: DependabotSchedule[]): DependabotSchedule[] {
  return entries.filter((e) => {
    // `interval: cron` carries its own expression; not checked.
    if (e.interval === "cron") return false;
    if (e.time === null || !sameZone(e.timezone)) return true;
    if (!/^\d{1,2}:\d{2}$/.test(e.time)) {
      log.warn(`[${NAME}] ${repo.fullName}: unparseable dependabot schedule time "${e.time}" — skipping`);
      return false;
    }
    return !minutesInWindow(parseHHMM(e.time), parseHHMM(THIRD_PARTY_UPDATE_WINDOW.start), parseHHMM(THIRD_PARTY_UPDATE_WINDOW.end));
  });
}

function windowPreamble(): string {
  return `Claws only processes third-party dependency-update PRs inside its out-of-hours window (${describeUpdateWindow()}); outside it they wait. A schedule that opens PRs during the day leaves them queued for hours, so update PRs should be opened inside the window.`;
}

function formatDependabotScheduleBody(repo: Repo, path: string, offending: DependabotSchedule[]): string {
  const lines: string[] = [
    windowPreamble(),
    "",
    `\`${path}\` has entries whose schedule falls outside the window, or leaves \`time\`/\`timezone\` unset (Dependabot then picks a time itself, which may be daytime):`,
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
      `      timezone: ${THIRD_PARTY_UPDATE_WINDOW.timezone}`,
      "```",
      "",
    );
  }
  lines.pop();
  lines.push(...optOutFooter(repo, true));
  return lines.join("\n");
}

/** `22:00` → `10pm`, `07:30` → `7:30am`. */
function formatAmPm(hhmm: string): string {
  const minutes = parseHHMM(hhmm);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hour12 = h % 12 || 12;
  return `${hour12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

/** Renovate's canonical form for the configured window: a wrapping (overnight) window recommends the
 *  split `["after X", "before Y"]` form Renovate's own config migration produces; a non-wrapping window
 *  recommends the single `after X and before Y` form, which Renovate does not migrate. */
function recommendedRenovateSchedule(): string[] {
  const w = THIRD_PARTY_UPDATE_WINDOW;
  return parseHHMM(w.start) > parseHHMM(w.end)
    ? [`after ${formatAmPm(w.start)}`, `before ${formatAmPm(w.end)}`]
    : [`after ${formatAmPm(w.start)} and before ${formatAmPm(w.end)}`];
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

/** The first hour into the window, in UTC, that stays inside the window under both winter and summer offsets. Falls back to the window start. */
function recommendedCron(): string {
  const w = THIRD_PARTY_UPDATE_WINDOW;
  const { january, july } = utcOffsetsAcrossYear(w.timezone);
  const start = parseHHMM(w.start);
  const end = parseHHMM(w.end);
  const span = (end - start + 1440 * 2) % 1440 || 1440;
  const utcFor = (local: number) => (local - january + 1440 * 2) % 1440;
  const insideBothSeasons = (utc: number) =>
    [january, july].every((offset) => minutesInWindow((utc + offset + 1440) % 1440, start, end));
  for (let mins = 60; mins < span; mins += 60) {
    const utc = utcFor((start + mins) % 1440);
    if (insideBothSeasons(utc)) return `${utc % 60} ${Math.floor(utc / 60)} * * *`;
  }
  const utc = utcFor(start);
  return `${utc % 60} ${Math.floor(utc / 60)} * * *`;
}

interface RenovateProblems {
  /** Problems with the config's `timezone`/`schedule`. */
  config: string[];
  /** Problems with the trigger workflow's cron. */
  cron: string[];
}

/** Human-readable problems with a Renovate config and its trigger workflow; both empty when compliant. */
function renovateScheduleViolations(repoDir: string, repo: Repo, configPath: string): RenovateProblems {
  const problems: string[] = [];
  const cronProblems: string[] = [];
  const w = THIRD_PARTY_UPDATE_WINDOW;

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
    if (!sameZone(config["timezone"])) {
      problems.push(
        typeof config["timezone"] === "string"
          ? `\`${configPath}\`: \`"timezone"\` is \`"${config["timezone"]}"\`, not \`"${w.timezone}"\``
          : `\`${configPath}\`: \`"timezone"\` is unset`,
      );
    }
    const raw = config["schedule"];
    const schedule = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    if (schedule.length === 0) {
      problems.push(`\`${configPath}\`: \`"schedule"\` is unset, so Renovate opens PRs at any time`);
    }
    for (const entry of schedule) {
      const text = String(entry).trim();
      if (/^at any time$/i.test(text)) {
        problems.push(`\`${configPath}\`: \`"schedule"\` entry \`"${text}"\` allows any time`);
        continue;
      }
      const parsed = parseRenovateScheduleEntry(text);
      if (!parsed) {
        log.warn(`[${NAME}] ${repo.fullName}: unparseable Renovate schedule "${text}" — skipping`);
        continue;
      }
      if (!rangeInsideWindow(parsed.from, parsed.to)) {
        problems.push(`\`${configPath}\`: \`"schedule"\` entry \`"${text}"\` falls outside the window`);
      }
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
      const inside = [january, july].every((offset) =>
        minutesInWindow((utc + offset + 1440) % 1440, parseHHMM(w.start), parseHHMM(w.end)),
      );
      if (!inside) {
        cronProblems.push(`\`${workflowPath}\`: cron \`${cron}\` (UTC) starts Renovate outside the window in at least part of the year`);
      }
    }
  }

  return { config: problems, cron: cronProblems };
}

function formatRenovateScheduleBody(repo: Repo, problems: RenovateProblems): string {
  const w = THIRD_PARTY_UPDATE_WINDOW;
  const lines: string[] = [
    windowPreamble(),
    "",
    "This repo's Renovate setup can open PRs outside the window:",
    "",
    ...[...problems.config, ...problems.cron].map((p) => `- ${p}`),
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
    if (schedule.length > 1) {
      lines.push(
        "",
        "An overnight window is written as two OR'd entries: Renovate's config migration splits a single `after X and before Y` overnight entry into exactly this form, and `renovate-config-validator --strict` fails on the unmigrated form.",
      );
    }
  }
  if (problems.cron.length) {
    lines.push(
      "",
      `Change the Renovate workflow's \`on.schedule\` cron to \`${recommendedCron()}\` — GitHub cron is UTC, and this lies inside the window under both winter and summer time.`,
    );
  }
  lines.push(...optOutFooter(repo, true));
  return lines.join("\n");
}

function scheduleCheckEnabled(repo: Repo): boolean {
  if (!THIRD_PARTY_UPDATE_WINDOW.enabled) return false;
  return getRepoConfig(repo.fullName)?.dependencyUpdateWindow !== false;
}

function scan(repoDir: string, repo: Repo): { body: string; summary?: string } | null {
  if (fs.existsSync(path.join(repoDir, OPT_OUT_PATH))) return null;

  const detected = detectEcosystems(repoDir);
  if (detected.size === 0) return null;

  // Renovate auto-detects every ecosystem by default, so any coverage check against it is a
  // guaranteed false positive. Presence of a config is enough for coverage.
  const renovatePath = RENOVATE_PATHS.find(p => fs.existsSync(path.join(repoDir, p)));
  if (renovatePath) {
    if (!scheduleCheckEnabled(repo)) return null;
    const problems = renovateScheduleViolations(repoDir, repo, renovatePath);
    if (problems.config.length === 0 && problems.cron.length === 0) return null;
    return {
      body: formatRenovateScheduleBody(repo, problems),
      summary: `Renovate schedule outside the out-of-hours window (${describeUpdateWindow()})`,
    };
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

    if (!scheduleCheckEnabled(repo)) return null;
    const offending = dependabotScheduleViolations(repo, parseSchedules(content) ?? []);
    if (offending.length === 0) return null;
    return {
      body: formatDependabotScheduleBody(repo, dependabotPath, offending),
      summary: `Dependabot schedule outside the out-of-hours window (${describeUpdateWindow()}): ${offending.map(e => `${e.ecosystem}@${e.directory}`).join(", ")}`,
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

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  // Deliberately unlabelled: missing dependency-update config is routine hygiene,
  // not an outage, and Priority-queue flooding is a known problem in this repo (#2809).
  scan,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}
