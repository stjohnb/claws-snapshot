import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";

export async function run(repos: Repo[]): Promise<void> {
  for (const repo of repos) {
    if (isRateLimited()) break;
    try {
      const prs = await gh.listPRs(repo.fullName);

      for (const pr of prs) {
        if (gh.isItemSkipped(repo.fullName, pr.number)) continue;
        try {
          const isDependabot = pr.author.login === "dependabot[bot]";
          const isClawsPR = pr.headRefName.startsWith("claws/issue-");
          const isDocPR = pr.headRefName.startsWith("claws/docs-");

          if (!isDependabot && !isClawsPR && !isDocPR) continue;

          // Claws PRs require an LGTM comment posted after the latest commit
          if (isClawsPR) {
            const lgtm = await gh.hasValidLGTM(repo.fullName, pr.number, pr.baseRefName);
            if (!lgtm) {
              continue;
            }
          }

          // Doc PRs must only contain doc files
          if (isDocPR) {
            const files = await gh.getPRChangedFiles(repo.fullName, pr.number);
            const allDocs = files.length > 0 && files.every(
              (f) => f.startsWith("docs/") || f.endsWith(".md"),
            );
            if (!allDocs) {
              log.warn(`[auto-merger] Doc PR ${repo.fullName}#${pr.number} contains non-doc changes, skipping`);
              continue;
            }
          }

          const status = await gh.getPRCheckStatus(repo.fullName, pr.number);
          const checksOk = status === "passing" || (isDocPR && status === "none");
          if (!checksOk) {
            if (status === "failing") {
              log.warn(`[auto-merger] Checks failed for ${repo.fullName}#${pr.number}, skipping`);
            }
            continue;
          }

          gh.populateQueueCache("auto-mergeable", repo.fullName, { number: pr.number, title: pr.title, type: "pr", updatedAt: pr.updatedAt, priority: gh.hasPriorityLabel(pr.labels) });
          log.info(`[auto-merger] Merging ${repo.fullName}#${pr.number}: ${pr.title}`);
          await gh.mergePR(repo.fullName, pr.number);

          if (isClawsPR) {
            const match = pr.headRefName.match(/^claws\/issue-(\d+)-/);
            if (match) {
              const issueNumber = parseInt(match[1], 10);
              try {
                await gh.removeLabel(repo.fullName, issueNumber, LABELS.inReview);
              } catch {
                // Label may already be removed or issue closed
              }
            }
          }
        } catch (err) {
          reportError("auto-merger:process-pr", `${repo.fullName}#${pr.number}`, err);
        }
      }
    } catch (err) {
      reportError("auto-merger:list-prs", repo.fullName, err);
    }
  }
}
