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

export async function run(repos: Repo[]): Promise<void> {
  for (const repo of repos) {
    try {
      await processRepo(repo);
    } catch (err) {
      reportError("repo-standards:process-repo", repo.fullName, err);
    }
  }
}
