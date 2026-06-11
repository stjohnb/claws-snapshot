import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import * as smartSchedule from "../smart-schedule.js";
import { reportError } from "../error-reporter.js";

const STALE_DAYS = 7;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

interface RemoteBranch {
  name: string;
  createdAt: Date;
}

function parseForEachRefOutput(output: string): RemoteBranch[] {
  const branches: RemoteBranch[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    // Format: "origin/claws/issue-123-abcd 2025-01-15 12:00:00 +0000"
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;
    const ref = line.slice(0, spaceIdx);
    const dateStr = line.slice(spaceIdx + 1).trim();
    // Strip "origin/" prefix
    const name = ref.replace(/^origin\//, "");
    const createdAt = new Date(dateStr);
    if (!isNaN(createdAt.getTime())) {
      branches.push({ name, createdAt });
    }
  }
  return branches;
}

async function isBranchEligible(repo: Repo, branch: RemoteBranch, now: number): Promise<string | null> {
  const ageMs = now - branch.createdAt.getTime();
  if (ageMs < STALE_MS) {
    return `too young (${Math.floor(ageMs / 86_400_000)}d old)`;
  }

  // Fetch all PRs for this branch in a single API call
  const allPRs = await gh.listPRsForBranch(repo.fullName, branch.name, "all");

  // Never delete branches with open PRs
  const openPR = allPRs.find((pr) => pr.state === "OPEN");
  if (openPR) {
    return `has open PR #${openPR.number}`;
  }

  // Check for merged PRs — eligible if merged more than 7 days ago
  for (const pr of allPRs) {
    if (pr.state === "MERGED" && pr.mergedAt) {
      const mergedAge = now - new Date(pr.mergedAt).getTime();
      if (mergedAge >= STALE_MS) return null; // eligible
      return `PR #${pr.number} merged recently (${Math.floor(mergedAge / 86_400_000)}d ago)`;
    }
  }

  // Check for closed (not merged) PRs — eligible if closed more than 7 days ago
  for (const pr of allPRs) {
    if (pr.state === "CLOSED" && pr.closedAt) {
      const closedAge = now - new Date(pr.closedAt).getTime();
      if (closedAge >= STALE_MS) return null; // eligible
      return `PR #${pr.number} closed recently (${Math.floor(closedAge / 86_400_000)}d ago)`;
    }
  }

  // No PR at all — orphaned branch, eligible if old enough (already checked above)
  return null;
}

async function processRepo(repo: Repo): Promise<void> {
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  if (!fs.existsSync(repoDir)) return;

  await claude.ensureClone(repo, { skipFetchIfRecent: true });

  let output: string;
  try {
    output = await claude.git(
      ["for-each-ref", "--format=%(refname:strip=2) %(creatordate:iso8601)", "refs/remotes/origin/claws/"],
      repoDir,
    );
  } catch {
    // No claws/* branches — nothing to clean
    return;
  }

  const branches = parseForEachRefOutput(output);
  if (branches.length === 0) return;

  log.info(`[stale-branch-cleaner] ${repo.fullName}: found ${branches.length} claws/* branch(es)`);

  const now = Date.now();
  let deleted = 0;

  for (const branch of branches) {
    if (gh.isRateLimited()) {
      log.warn(`[stale-branch-cleaner] Rate limited — stopping ${repo.fullName}`);
      break;
    }

    try {
      const skipReason = await isBranchEligible(repo, branch, now);
      if (skipReason) {
        log.debug(`[stale-branch-cleaner] Skipping ${branch.name}: ${skipReason}`);
        continue;
      }

      await gh.deleteRemoteBranch(repo.fullName, branch.name);
      log.info(`[stale-branch-cleaner] Deleted ${repo.fullName}:${branch.name}`);
      deleted++;
    } catch (err) {
      // 422/404 = branch already deleted (e.g. by auto-delete on merge) — not an error
      const msg = String(err);
      if (msg.includes("422") || msg.includes("404") || msg.includes("Reference does not exist")) {
        log.info(`[stale-branch-cleaner] Branch already gone: ${branch.name}`);
      } else {
        log.warn(`[stale-branch-cleaner] Failed to delete ${branch.name}: ${err}`);
      }
    }
  }

  if (deleted > 0) {
    log.info(`[stale-branch-cleaner] ${repo.fullName}: deleted ${deleted} stale branch(es)`);
  }
}

export async function run(repos: Repo[]): Promise<void> {
  for (const repo of repos) {
    if (gh.isRateLimited()) break;
    try {
      await processRepo(repo);
    } catch (err) {
      reportError("stale-branch-cleaner:process-repo", repo.fullName, err);
    }
    db.markRepoProcessedDaily("stale-branch-cleaner", repo.fullName, smartSchedule.localDateString());
  }
}
