import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { LABELS, type Repo } from "../config.js";
import * as log from "../log.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";

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

const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "target", "coverage",
  ".venv", "venv", "__pycache__", ".next", ".tox", ".gradle", "Pods", ".expo",
]);
const MAX_DEPTH = 3;
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

  const walk = (absDir: string, relDir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const fileNames = entries.filter(e => e.isFile()).map(e => e.name);
    for (const name of fileNames) {
      const eco = ecosystemForFile(name);
      if (eco) add(eco, relDir);
    }
    // package.json alone proves nothing — a workspace member has one but is covered by the root
    // lockfile. Decided in a post-pass once every candidate is known.
    if (fileNames.includes("package.json")) {
      npmCandidates.push({
        dir: normalizeDir(relDir),
        hasLock: NPM_LOCKFILES.some(l => fileNames.includes(l)),
      });
    }

    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const childRel = relDir === "/" ? `/${entry.name}` : `${relDir}/${entry.name}`;
      walk(path.join(absDir, entry.name), childRel, depth + 1);
    }
  };

  walk(repoDir, "/", 0);

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
        '      time: "03:00"',
        "      timezone: Europe/London",
        "    open-pull-requests-limit: 5",
        // Grouping is load-bearing, not cosmetic: auto-merger exempts Dependabot PRs from the
        // LGTM requirement, so ungrouped updates across several entries auto-merge as a flood.
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

  lines.push(
    "",
    "---",
    "",
    "If this repo should not have dependency updates managed, opt out either by committing an empty `" + OPT_OUT_PATH + "` file, or by adding `\"" + NAME + "\"` to `disabledJobsByRepo[\"" + repo.fullName + "\"]` in the Claws config.",
  );

  return lines.join("\n");
}

function scan(repoDir: string, repo: Repo): { body: string; summary?: string } | null {
  if (fs.existsSync(path.join(repoDir, OPT_OUT_PATH))) return null;

  const detected = detectEcosystems(repoDir);
  if (detected.size === 0) return null;

  // Renovate auto-detects every ecosystem by default, so any coverage check against it is a
  // guaranteed false positive. Presence of a config is enough.
  if (RENOVATE_PATHS.some(p => fs.existsSync(path.join(repoDir, p)))) return null;

  const dependabotPath = DEPENDABOT_PATHS.find(p => fs.existsSync(path.join(repoDir, p)));
  if (dependabotPath) {
    const coverage = parseCoverage(fs.readFileSync(path.join(repoDir, dependabotPath), "utf8"));
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

    if (missing.size === 0) return null;
    return {
      body: formatIssueBody(repo, missing, "partial"),
      summary: `Missing dependabot coverage: ${summarize(missing)}`,
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
  searchQuery: ISSUE_TITLE,
  label: LABELS.priority,
  scan,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}
