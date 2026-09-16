import fs from "node:fs";
import { type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as smartSchedule from "../smart-schedule.js";

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

/** Returns a reason to skip the branch, or null when it is eligible for deletion. */
function eligibilityReason(prs: gh.BranchPR[], now: number): string | null {
  // Never delete branches with open PRs
  const openPR = prs.find((pr) => pr.state === "OPEN");
  if (openPR) {
    return `has open PR #${openPR.number}`;
  }

  // Check for merged PRs — eligible if merged more than 7 days ago
  for (const pr of prs) {
    if (pr.state === "MERGED" && pr.mergedAt) {
      const mergedAge = now - new Date(pr.mergedAt).getTime();
      if (mergedAge >= STALE_MS) return null; // eligible
      return `PR #${pr.number} merged recently (${Math.floor(mergedAge / 86_400_000)}d ago)`;
    }
  }

  // Check for closed (not merged) PRs — eligible if closed more than 7 days ago
  for (const pr of prs) {
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
  const repoDir = claude.repoDir(repo);
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
  const candidates: RemoteBranch[] = [];
  for (const branch of branches) {
    const ageMs = now - branch.createdAt.getTime();
    if (ageMs < STALE_MS) {
      log.debug(`[stale-branch-cleaner] Skipping ${branch.name}: too young (${Math.floor(ageMs / 86_400_000)}d old)`);
      continue;
    }
    candidates.push(branch);
  }
  if (candidates.length === 0) return;

  if (gh.isRateLimited()) {
    log.warn(`[stale-branch-cleaner] Rate limited — stopping ${repo.fullName}`);
    return;
  }

  // One batched PR lookup for the whole repo instead of one gh subprocess per branch.
  let prsByBranch: Map<string, gh.BranchPR[]>;
  try {
    prsByBranch = await gh.listPRsForBranches(repo.fullName, candidates.map((b) => b.name));
  } catch (err) {
    log.warn(`[stale-branch-cleaner] ${repo.fullName}: PR lookup failed, skipping cleanup: ${err}`);
    return;
  }

  let deleted = 0;

  for (const branch of candidates) {
    if (gh.isRateLimited()) {
      log.warn(`[stale-branch-cleaner] Rate limited — stopping ${repo.fullName}`);
      break;
    }

    const prs = prsByBranch.get(branch.name);
    if (prs === undefined) {
      // Branch omitted by listPRsForBranches (unsafe name) — never delete blind.
      log.warn(`[stale-branch-cleaner] Skipping ${branch.name}: no PR data returned`);
      continue;
    }

    const skipReason = eligibilityReason(prs, now);
    if (skipReason) {
      log.debug(`[stale-branch-cleaner] Skipping ${branch.name}: ${skipReason}`);
      continue;
    }

    try {
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
  await smartSchedule.runDailyRepoLoop("stale-branch-cleaner", repos, processRepo);
}
