import fs from "node:fs";
import path from "node:path";
import { type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { mapSettledWithConcurrency } from "../util.js";

export interface ScannerSpec {
  name: string;
  issueTitle: string;
  label?: string;
  /** Labels kept on the scanner's issue on every scan, not just at creation.
   *  Used for `Automerge` on the deterministic chore scanners so already-open
   *  issues are picked up too, not only ones filed after this shipped (#2730). */
  enforcedLabels?: readonly string[];
  scan: (repoDir: string, repo: Repo) => { body: string; summary?: string } | null;
}

export interface ViolationTableOptions<T> {
  /** Optional prose emitted before the table, including any trailing "\n" needed
   *  to produce a blank line between the prose and the header row. */
  intro?: string;
  /** Header cell labels, e.g. ["File", "Job", "`runs-on`"]. */
  columns: string[];
  /** Violation rows to render. */
  rows: T[];
  /** Maps one row to its already-escaped cell strings (one per column). */
  cells: (row: T) => string[];
  /** Prose lines appended after a single blank-line spacer. */
  footer: string[];
}

export function renderViolationTable<T>(opts: ViolationTableOptions<T>): string {
  const lines: string[] = [];
  if (opts.intro !== undefined) lines.push(opts.intro);
  lines.push(`| ${opts.columns.join(" | ")} |`);
  lines.push(`|${opts.columns.map(() => "---").join("|")}|`);
  for (const row of opts.rows) {
    lines.push(`| ${opts.cells(row).join(" | ")} |`);
  }
  lines.push("", ...opts.footer);
  return lines.join("\n");
}

/** Directory basenames every repo-tree scan skips. Single source of truth — add new entries here,
 *  never in an individual scanner. Symlinked directories are never followed, because
 *  Dirent.isDirectory() is false for a symlink (this is what keeps the walk cycle-free). */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "target", "coverage",
  ".venv", "venv", "__pycache__", ".next", ".tox", ".gradle", "Pods", ".expo",
]);

export interface RepoTreeDir {
  /** Absolute path of the directory being visited. */
  absPath: string;
  /** Path relative to the walk root, POSIX-separated; "" for the root itself. */
  relPath: string;
  /** 0 for the root. */
  depth: number;
  /** Everything readdirSync returned, including directories the walk will skip. */
  entries: fs.Dirent[];
}

export interface WalkRepoTreeOptions {
  /** Deepest directory level that is read; the root is 0, so maxDepth: 3 reads four levels. */
  maxDepth: number;
  /** Extra basenames skipped in addition to DEFAULT_SKIP_DIRS. */
  extraSkipDirs?: readonly string[];
  /** Called once per readable directory, pre-order: a directory before its children, entries in
   *  readdir order. Unreadable directories are silently skipped. */
  onDirectory: (dir: RepoTreeDir) => void;
}

/** Bounded-depth pre-order walk of a repo clone. Unreadable directories (permissions, a race with
 *  git) are skipped, not thrown — a scan must not fail the whole repo over one bad directory. */
export function walkRepoTree(rootDir: string, opts: WalkRepoTreeOptions): void {
  const skip = opts.extraSkipDirs?.length
    ? new Set([...DEFAULT_SKIP_DIRS, ...opts.extraSkipDirs])
    : DEFAULT_SKIP_DIRS;

  const visit = (absPath: string, relPath: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absPath, { withFileTypes: true });
    } catch {
      return;
    }
    opts.onDirectory({ absPath, relPath, depth, entries });
    if (depth >= opts.maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      visit(
        path.join(absPath, entry.name),
        relPath === "" ? entry.name : `${relPath}/${entry.name}`,
        depth + 1,
      );
    }
  };

  visit(rootDir, "", 0);
}

async function processRepo(spec: ScannerSpec, repo: Repo): Promise<void> {
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return;

  await claude.ensureClone(repo, { skipFetchIfRecent: true });

  const result = spec.scan(repoDir, repo);
  if (!result) return;

  const existing = await gh.findIssueByExactTitle(repo.fullName, spec.issueTitle);
  if (existing) {
    for (const label of spec.enforcedLabels ?? []) {
      if (existing.labels.includes(label)) continue;
      await gh.addLabel(repo.fullName, existing.number, label);
      log.info(`[${spec.name}] Applied ${label} to existing ${repo.fullName}#${existing.number}`);
    }
    log.info(
      `[${spec.name}] Skipping ${repo.fullName} — open issue #${existing.number} already exists`,
    );
    return;
  }

  log.info(`[${spec.name}] ${result.summary ?? "Creating issue"} for ${repo.fullName}`);
  await gh.createIssue(repo.fullName, spec.issueTitle, result.body, [...(spec.label ? [spec.label] : []), ...(spec.enforcedLabels ?? [])]);
}

/** Bounded per-repo concurrency. Matches the "max 4 concurrent repos" cap the
 *  dispatcher already uses for smart-scheduled jobs; per-repo work here is
 *  network-bound (git fetch + gh issue list) and touches only that repo's clone. */
const REPO_CONCURRENCY = 4;

export async function runRepoScanner(
  spec: ScannerSpec,
  repos: Repo[],
): Promise<void> {
  await mapSettledWithConcurrency(repos, REPO_CONCURRENCY, async (repo) => {
    try {
      await processRepo(spec, repo);
    } catch (err) {
      await reportError(`${spec.name}:process-repo`, repo.fullName, err);
    }
  });
}
