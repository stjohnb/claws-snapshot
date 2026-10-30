import type { Repo } from "../config.js";
import { isJobDisabledForRepo } from "../config.js";
import * as log from "../log.js";
import * as claude from "../claude.js";
import * as db from "../db.js";
import * as smartSchedule from "../smart-schedule.js";
import * as ubuntuLatestScanner from "./ubuntu-latest-scanner.js";
import * as concurrencyScanner from "./concurrency-scanner.js";
import * as migrationScanner from "./migration-scanner.js";
import * as cacheOnSelfHostedScanner from "./cache-on-self-hosted-scanner.js";
import * as issueCommentSpamScanner from "./issue-comment-spam-scanner.js";
import * as runnerOsScanner from "./runner-os-scanner.js";
import * as claudeConfigScanner from "./claude-config-scanner.js";
import * as designGuidelinesScanner from "./design-guidelines-scanner.js";
import * as hostPolicyScanner from "./host-policy-scanner.js";
import * as observabilityContractScanner from "./observability-contract-scanner.js";
import * as repoAvatarScanner from "./repo-avatar-scanner.js";
import { reportError } from "../error-reporter.js";

interface ScannerEntry {
  name: string;
  run: (repos: Repo[]) => Promise<void>;
  /** Former names a repo's disable config may still list; any of them disables the scanner. */
  aliases?: readonly string[];
}

const scanners: readonly ScannerEntry[] = [
  { name: "ubuntu-latest-scanner", run: ubuntuLatestScanner.run },
  { name: "concurrency-scanner", run: concurrencyScanner.run },
  { name: "migration-scanner", run: migrationScanner.run },
  { name: "cache-on-self-hosted-scanner", run: cacheOnSelfHostedScanner.run },
  { name: "issue-comment-spam-scanner", run: issueCommentSpamScanner.run },
  { name: "runner-os-scanner", run: runnerOsScanner.run },
  { name: "claude-config-scanner", run: claudeConfigScanner.run },
  { name: "design-guidelines-scanner", run: designGuidelinesScanner.run },
  { name: "host-policy-scanner", run: hostPolicyScanner.run },
  { name: "observability-contract-scanner", run: observabilityContractScanner.run, aliases: ["logging-conventions-scanner"] },
  { name: "repo-avatar-scanner", run: repoAvatarScanner.run },
];

export async function run(repos: Repo[]): Promise<void> {
  log.info("[scanner-dispatcher] Pre-fetching all repos...");
  await claude.refreshAllRepos(repos);
  log.info("[scanner-dispatcher] Pre-fetch complete, running scanners...");

  for (const scanner of scanners) {
    const names = [scanner.name, ...(scanner.aliases ?? [])];
    const scannerRepos = repos.filter(r => !names.some(name => isJobDisabledForRepo(name, r.fullName)));
    log.info(`[scanner-dispatcher] Running ${scanner.name} (${scannerRepos.length}/${repos.length} repos)...`);
    try {
      await scanner.run(scannerRepos);
      log.info(`[scanner-dispatcher] Completed ${scanner.name}`);
    } catch (err) {
      reportError(`scanner-dispatcher:${scanner.name}`, scanner.name, err);
      // Continue to next scanner — one failure shouldn't block others
    }
  }

  const today = smartSchedule.localDateString();
  for (const repo of repos) {
    await db.markRepoProcessedDaily("scanner-dispatcher", repo.fullName, today);
  }
}
