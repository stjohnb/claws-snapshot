import fs from "node:fs";
import path from "node:path";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { WORK_DIR, WORKTREE_STALE_MS, type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as gh from "../github.js";
import { getRunningTasks, getAllPersistedSessions } from "../db.js";
import * as log from "../log.js";

const execFile = promisify(_execFile);

function* walkWorktreeLeaves(root: string): Iterable<string> {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(root, d.name));
  } catch {
    return;
  }
  for (const dir of dirs) {
    const gitMarker = path.join(dir, ".git");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(gitMarker);
    } catch {
      // No .git here; descend further
      yield* walkWorktreeLeaves(dir);
      continue;
    }
    if (stat.isFile()) {
      yield dir;
    } else {
      // .git is a directory — not a worktree leaf; descend
      yield* walkWorktreeLeaves(dir);
    }
  }
}

async function gitWorktreeList(repoDir: string): Promise<string[]> {
  const { stdout } = await execFile("git", ["-C", repoDir, "worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

async function getDirBytes(p: string): Promise<number> {
  try {
    const { stdout } = await execFile("du", ["-sb", p]);
    const first = stdout.split("\t")[0];
    const n = parseInt(first ?? "0", 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    log.debug(`[worktree-cleaner] du failed for ${p}, treating as 0 bytes`);
    return 0;
  }
}

async function processRepo(
  repo: Repo,
  inUse: Set<string>,
  staleMs: number,
): Promise<{ removed: number; freedBytes: number }> {
  const repoDir = claude.repoDir(repo);
  const wtRootDir = path.join(WORK_DIR, "worktrees", repo.owner, repo.name);

  if (!fs.existsSync(path.join(repoDir, ".git")) || !fs.existsSync(wtRootDir)) {
    return { removed: 0, freedBytes: 0 };
  }

  const wtRootResolved = path.resolve(wtRootDir) + path.sep;

  let registeredPaths: string[];
  try {
    registeredPaths = await gitWorktreeList(repoDir);
  } catch (err) {
    log.warn(`[worktree-cleaner] git worktree list failed for ${repoDir}: ${err}`);
    return { removed: 0, freedBytes: 0 };
  }

  // Skip the bare clone itself (first entry from git worktree list)
  const registeredSet = new Set(
    registeredPaths
      .filter(p => path.resolve(p) !== path.resolve(repoDir))
      .map(p => path.resolve(p)),
  );

  let removed = 0;
  let freedBytes = 0;
  const prunesNeeded = new Set<string>();

  const now = Date.now();

  // Remove stale registered worktrees
  for (const wtPath of registeredSet) {
    if (!wtPath.startsWith(wtRootResolved)) continue;
    if (inUse.has(wtPath)) continue;

    let mtime: number;
    try {
      mtime = fs.statSync(wtPath).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        prunesNeeded.add(repoDir);
        continue;
      }
      log.debug(`[worktree-cleaner] stat failed for ${wtPath}: ${err}`);
      continue;
    }

    if (now - mtime < staleMs) continue;

    const bytes = await getDirBytes(wtPath);

    try {
      await execFile("git", ["-C", repoDir, "worktree", "remove", "--force", wtPath]);
    } catch {
      // Fallback: rm -rf then prune
      try {
        fs.rmSync(wtPath, { recursive: true, force: true });
      } catch (rmErr) {
        log.warn(`[worktree-cleaner] rm -rf failed for ${wtPath}: ${rmErr}`);
        continue;
      }
      prunesNeeded.add(repoDir);
    }

    freedBytes += bytes;
    removed++;
    log.debug(`[worktree-cleaner] Removed ${wtPath} (${(bytes / (1024 ** 2)).toFixed(1)} MiB)`);
  }

  // Remove orphaned leaf dirs (have a .git file but not in porcelain list)
  for (const leafPath of walkWorktreeLeaves(wtRootDir)) {
    const leafResolved = path.resolve(leafPath);
    if (!leafResolved.startsWith(wtRootResolved)) continue;
    if (registeredSet.has(leafResolved)) continue;
    if (inUse.has(leafResolved)) continue;

    let mtime: number;
    try {
      mtime = fs.statSync(leafPath).mtimeMs;
    } catch {
      continue;
    }

    if (now - mtime < staleMs) continue;

    const bytes = await getDirBytes(leafPath);
    try {
      fs.rmSync(leafPath, { recursive: true, force: true });
    } catch (rmErr) {
      log.warn(`[worktree-cleaner] rm -rf orphan failed for ${leafPath}: ${rmErr}`);
      continue;
    }
    prunesNeeded.add(repoDir);
    freedBytes += bytes;
    removed++;
    log.debug(`[worktree-cleaner] Removed orphan ${leafPath} (${(bytes / (1024 ** 2)).toFixed(1)} MiB)`);
  }

  // Prune worktree admin metadata for any repos that needed it
  for (const dir of prunesNeeded) {
    try {
      await execFile("git", ["-C", dir, "worktree", "prune"]);
    } catch (err) {
      log.debug(`[worktree-cleaner] git worktree prune failed for ${dir}: ${err}`);
    }
  }

  return { removed, freedBytes };
}

export async function run(): Promise<void> {
  // Snapshot in-use paths before any enumeration
  const inUse = new Set<string>();
  for (const task of getRunningTasks()) {
    if (task.worktree_path) inUse.add(path.resolve(task.worktree_path));
  }
  for (const session of getAllPersistedSessions()) {
    if (session.worktree_path) inUse.add(path.resolve(session.worktree_path));
  }

  const repos = await gh.listRepos();
  const staleMs = WORKTREE_STALE_MS;

  let totalRemoved = 0;
  let totalFreedBytes = 0;
  let reposProcessed = 0;

  for (const repo of repos) {
    try {
      const { removed, freedBytes } = await processRepo(repo, inUse, staleMs);
      totalRemoved += removed;
      totalFreedBytes += freedBytes;
      if (removed > 0) reposProcessed++;
    } catch (err) {
      log.warn(`[worktree-cleaner] Error processing ${repo.fullName}: ${err}`);
    }
  }

  if (totalRemoved > 0) {
    log.info(`[worktree-cleaner] Removed ${totalRemoved} worktree(s), freed ${(totalFreedBytes / (1024 ** 3)).toFixed(2)} GiB across ${reposProcessed} repo(s)`);
  } else {
    log.debug("[worktree-cleaner] No stale worktrees found");
  }
}
