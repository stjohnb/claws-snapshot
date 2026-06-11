import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";

export interface ScannerSpec {
  name: string;
  issueTitle: string;
  searchQuery: string;
  label?: string;
  scan: (repoDir: string, repo: Repo) => { body: string; summary?: string } | null;
}

async function processRepo(spec: ScannerSpec, repo: Repo): Promise<void> {
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  if (!fs.existsSync(repoDir)) return;

  await claude.ensureClone(repo, { skipFetchIfRecent: true });

  const result = spec.scan(repoDir, repo);
  if (!result) return;

  const existing = await gh.searchIssues(repo.fullName, spec.searchQuery);
  if (existing.length > 0) {
    log.info(
      `[${spec.name}] Skipping ${repo.fullName} — open issue #${existing[0]!.number} already exists`,
    );
    return;
  }

  log.info(`[${spec.name}] ${result.summary ?? "Creating issue"} for ${repo.fullName}`);
  await gh.createIssue(repo.fullName, spec.issueTitle, result.body, spec.label ? [spec.label] : []);
}

export async function runRepoScanner(
  spec: ScannerSpec,
  repos: Repo[],
): Promise<void> {
  for (const repo of repos) {
    try {
      await processRepo(spec, repo);
    } catch (err) {
      reportError(`${spec.name}:process-repo`, repo.fullName, err);
    }
  }
}
