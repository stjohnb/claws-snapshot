import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, LEGACY_LABELS, LEGACY_LABEL_REPLACEMENTS, LABEL_RENAMES, type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";

async function processRepo(repo: Repo): Promise<void> {
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return;

  log.info(`[repo-standards] Syncing labels for ${repo.fullName}`);
  await gh.applyLabelRenames(repo.fullName, LABEL_RENAMES);
  await gh.ensureAllLabels(repo.fullName);
  await relabelLegacyItems(repo.fullName);
  await gh.deleteStaleLabels(repo.fullName, LEGACY_LABELS);
}

/**
 * Give every open forge issue and PR that carries a retired label its
 * {@link LEGACY_LABEL_REPLACEMENTS} replacement before `deleteStaleLabels`
 * strips the old one, so an item a human parked with `Claws Ignore` stays
 * parked in `Backlog` (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD). Closed items are left
 * alone: deleting the label removes it from them. Native issues are migrated
 * in the database instead (`db.migrateClawsIgnoreLabel`).
 */
async function relabelLegacyItems(repo: string): Promise<void> {
  const entries = Object.entries(LEGACY_LABEL_REPLACEMENTS);
  if (entries.length === 0) return;
  const [prs, issues] = await Promise.all([
    gh.listPRs(repo),
    gh.listOpenIssues(repo, { includeImported: true }),
  ]);
  const items = [
    ...prs.map((pr) => ({ number: pr.number, labels: pr.labels, kind: "PR" })),
    ...issues.filter((i) => !gh.isNativeIssue(i.number)).map((i) => ({ number: i.number, labels: i.labels, kind: "issue" })),
  ];
  for (const [legacy, replacement] of entries) {
    for (const item of items) {
      if (!item.labels.some((l) => l.name === legacy)) continue;
      if (item.labels.some((l) => l.name === replacement)) continue;
      await gh.addLabel(repo, item.number, replacement);
      log.info(`[repo-standards] ${repo}#${item.number}: ${item.kind} carried retired label "${legacy}" — added "${replacement}"`);
    }
  }
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
        reportError("repo-standards:cleanup", `${fullName} (repos)`, err, { repo: fullName });
      }

      // Remove worktree directory
      try {
        const wtDir = path.join(worktreesDir, owner, name);
        if (fs.existsSync(wtDir)) {
          fs.rmSync(wtDir, { recursive: true, force: true });
        }
      } catch (err) {
        reportError("repo-standards:cleanup", `${fullName} (worktrees)`, err, { repo: fullName });
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
      reportError("repo-standards:process-repo", repo.fullName, err, { repo: repo.fullName });
    }
  }
  cleanupStaleRepos(repos);
}
