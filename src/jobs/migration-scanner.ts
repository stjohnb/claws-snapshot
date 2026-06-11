import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";

interface Violation {
  dir: string;
  files: string[];
  totalCount: number;
}

const NAME = "migration-scanner";
const ISSUE_TITLE = "Alert: migrations using incremental numbering instead of date stamps";
const MIGRATION_FILE_REGEX = /^(\d+)_.*\.(ts|js|sql|py|rb|go|php)$/;
const COMMON_MIGRATION_DIRS = ["migrations", "db/migrations", "src/migrations", "database/migrations"];
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", ".next", "__pycache__"]);

function scanForMigrationDirs(repoDir: string): string[] {
  const dirs = new Set<string>();

  // Check common paths
  for (const rel of COMMON_MIGRATION_DIRS) {
    const abs = path.join(repoDir, rel);
    if (fs.existsSync(abs)) {
      dirs.add(abs);
    }
  }

  // Shallow scan up to 4 levels deep for any directory named "migrations"
  // (depth 4 covers monorepo patterns like packages/<name>/db/migrations)
  const maxDepth = 4;
  function scan(dir: string, depth: number): void {
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "migrations") {
        dirs.add(full);
        continue; // don't recurse into the migration dir itself
      }
      scan(full, depth + 1);
    }
  }

  scan(repoDir, 0);
  return [...dirs];
}

function looksLikeUnixTimestamp(prefix: string): boolean {
  // 10-digit prefixes that look like Unix timestamps (seconds since epoch).
  // These are date-based and don't suffer from the merge-conflict problem.
  return prefix.length >= 10 && Number(prefix) > 946684800; // 2000-01-01
}

function looksLikeDatePrefix(prefix: string): boolean {
  // Validate leading YYYYMMDD as a plausible date.
  // Intentionally loose on day-of-month (allows day 31 for all months) —
  // this is a heuristic, not a calendar validator.
  const year = Number(prefix.slice(0, 4));
  const month = Number(prefix.slice(4, 6));
  const day = Number(prefix.slice(6, 8));
  return year >= 1970 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function scanMigrationDir(dirPath: string, repoDir: string): Violation | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return null;
  }

  const incrementalFiles: string[] = [];
  let hasTimestamp = false;

  for (const entry of entries) {
    const match = entry.match(MIGRATION_FILE_REGEX);
    if (!match) continue;

    const prefix = match[1]!;
    if (looksLikeUnixTimestamp(prefix) || (prefix.length >= 8 && looksLikeDatePrefix(prefix))) {
      hasTimestamp = true;
    } else {
      incrementalFiles.push(entry);
    }
  }

  // Even a single timestamp-prefixed file signals the repo has begun migrating
  // to date-stamped conventions — suppress the warning to avoid nagging repos
  // that are mid-transition.
  if (hasTimestamp) return null;

  // Not enough files to determine a pattern
  if (incrementalFiles.length < 2) return null;

  incrementalFiles.sort();

  return {
    dir: path.relative(repoDir, dirPath),
    files: incrementalFiles.slice(0, 5),
    totalCount: incrementalFiles.length,
  };
}

function formatIssueBody(violations: Violation[]): string {
  const lines = [
    "The following directories contain migration files using incremental numbering instead of date stamps.\n",
    "| Directory | Example files | Total |",
    "|-----------|--------------|-------|",
  ];

  for (const v of violations) {
    const examples = v.files.map((f) => `\`${f}\``).join(", ");
    lines.push(`| \`${v.dir}\` | ${examples} | ${v.totalCount} |`);
  }

  lines.push(
    "",
    "**Why this matters:** Incrementally numbered migrations cause merge conflicts when concurrent PRs add migrations — both PRs may claim the same number. Date-stamped migrations avoid this entirely and support out-of-order application.",
    "",
    "**Recommended convention:**",
    "- Use `YYYYMMDDHHMMSS_description.ext` filenames (e.g. `20260321143000_add_orders.ts`)",
    "- The migration runner discovers files by scanning the directory (no barrel/index file)",
    "- Track applied migrations by name in a `schema_migrations` table",
    "- Apply any unapplied migration regardless of whether later-timestamped migrations have already run",
    "- Each migration file exports an `up()` function (or equivalent)",
  );

  return lines.join("\n");
}

function scanRepo(repoDir: string, repo: Repo): { body: string; summary?: string } | null {
  const migrationDirs = scanForMigrationDirs(repoDir);
  if (migrationDirs.length === 0) return null;

  const violations: Violation[] = [];
  for (const dir of migrationDirs) {
    const violation = scanMigrationDir(dir, repoDir);
    if (violation) violations.push(violation);
  }

  if (violations.length === 0) return null;

  return { body: formatIssueBody(violations), summary: `Found ${violations.length} migration violation(s)` };
}

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  searchQuery: ISSUE_TITLE,
  label: LABELS.priority,
  scan: scanRepo,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}
