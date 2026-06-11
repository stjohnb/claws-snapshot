import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, LEGACY_LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";

async function processRepo(repo: Repo): Promise<void> {
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  if (!fs.existsSync(repoDir)) return;

  log.info(`[repo-standards] Syncing labels for ${repo.fullName}`);
  await gh.ensureAllLabels(repo.fullName);
  await gh.deleteStaleLabels(repo.fullName, LEGACY_LABELS);
}

function cleanupStaleRepos(repos: Repo[]): void {
  if (repos.length === 0) {
    log.info("[repo-standards] Skipping stale repo cleanup: active repos list is empty");
    return;
  }
  if (gh.isRateLimited()) {
    log.info("[repo-standards] Skipping stale repo cleanup: rate limited");
    return;
  }

  const activeRepos = new Set(repos.map((r) => r.fullName));
  const reposDir = path.join(WORK_DIR, "repos");
  const worktreesDir = path.join(WORK_DIR, "worktrees");
  const pendingIdeasDir = path.join(WORK_DIR, "pending-ideas");

  if (!fs.existsSync(reposDir)) return;

  let owners: string[];
  try {
    owners = fs.readdirSync(reposDir);
  } catch {
    return;
  }

  for (const owner of owners) {
    const ownerDir = path.join(reposDir, owner);
    let repoNames: string[];
    try {
      repoNames = fs.readdirSync(ownerDir);
    } catch {
      continue;
    }

    for (const name of repoNames) {
      const fullName = `${owner}/${name}`;
      if (activeRepos.has(fullName)) continue;

      log.info(`[repo-standards] Cleaning up stale repo: ${fullName}`);

      // Remove main clone
      try {
        fs.rmSync(path.join(reposDir, owner, name), { recursive: true, force: true });
      } catch (err) {
        reportError("repo-standards:cleanup", `${fullName} (repos)`, err);
      }

      // Remove worktree directory
      try {
        const wtDir = path.join(worktreesDir, owner, name);
        if (fs.existsSync(wtDir)) {
          fs.rmSync(wtDir, { recursive: true, force: true });
        }
      } catch (err) {
        reportError("repo-standards:cleanup", `${fullName} (worktrees)`, err);
      }

      // Remove pending-ideas file
      try {
        const ideasFile = path.join(pendingIdeasDir, `${owner}-${name}.json`);
        if (fs.existsSync(ideasFile)) {
          fs.rmSync(ideasFile);
        }
      } catch (err) {
        reportError("repo-standards:cleanup", `${fullName} (pending-ideas)`, err);
      }
    }

    // Clean up empty owner directories
    try {
      const remaining = fs.readdirSync(ownerDir);
      if (remaining.length === 0) {
        fs.rmSync(ownerDir, { recursive: true, force: true });
      }
    } catch {
      // Owner dir may have already been removed
    }

    try {
      const wtOwnerDir = path.join(worktreesDir, owner);
      if (fs.existsSync(wtOwnerDir)) {
        const remaining = fs.readdirSync(wtOwnerDir);
        if (remaining.length === 0) {
          fs.rmSync(wtOwnerDir, { recursive: true, force: true });
        }
      }
    } catch {
      // Worktree owner dir may not exist
    }
  }
}

export async function run(repos: Repo[]): Promise<void> {
  for (const repo of repos) {
    try {
      await processRepo(repo);
    } catch (err) {
      reportError("repo-standards:process-repo", repo.fullName, err);
    }
  }
  cleanupStaleRepos(repos);
}
