import type { Repo } from "../config.js";
import { getIssuePreviewSummaryUrl, isForgejoRepo } from "../config.js";
import * as gh from "../github.js";
import { PREVIEW_BRANCH_PREFIX, issueRefFromPreviewBranch, syncIssuePreview } from "../issue-previews.js";
import { reportError } from "../error-reporter.js";

const NAME = "issue-preview-sync";

/**
 * Keep every open issue preview mirrored onto its issue, and retire it once
 * the plan is decided (#clw_01M39H5GCNYYFB3MQNJWY6JT8S, #clw_01M3A0HN2JJWXBPNPK5TET0B1N).
 *
 * A preview PR is found by its head branch alone — `claws/preview-issue-<ref>`
 * — and synced through `syncIssuePreview`: the issue's `## Preview` comment is
 * edited in place when the PR's head or render results change, and the PR is
 * closed (firing the repository's own cleanup workflow) when the issue is
 * `Refined` or closed. A repository that never opens a PR for its preview —
 * pushing the branch alone and setting `claws.json`'s `issuePreviewSummaryUrl`
 * — is synced the same way from its bare branch, once its non-fork PRs are
 * out of the way so an open PR always wins over a leftover branch with the
 * same name.
 *
 * Deliberately does not consult `gh.isDispatchSkippable` on the PR: preview
 * PRs carry `Claws Ignore` by design. Its own timer rather than a step inside
 * `issue-dispatcher`, for the same reason as `issue-shadow-sync`.
 */
export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(
    repos.map(async (repo) => {
      if (gh.isRepoRateLimited(repo.fullName)) return;
      let prs: gh.PR[];
      try {
        prs = await gh.listPRs(repo.fullName);
      } catch (err) {
        await reportError(`${NAME}:repo`, repo.fullName, err, { repo: repo.fullName });
        return;
      }
      const nonForkBranches = new Set(prs.filter((pr) => !gh.isForkPR(pr)).map((pr) => pr.headRefName));
      for (const pr of prs) {
        if (gh.isForkPR(pr)) continue;
        const ref = issueRefFromPreviewBranch(pr.headRefName);
        if (ref === null) continue;
        try {
          await syncIssuePreview(repo.fullName, ref, { kind: "pr", pr });
        } catch (err) {
          await reportError(`${NAME}:pr`, `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
        }
      }

      const template = getIssuePreviewSummaryUrl(repo.fullName);
      if (!template || isForgejoRepo(repo.fullName)) return;

      let branches: gh.BranchHead[];
      try {
        branches = await gh.listBranchesByPrefix(repo.fullName, PREVIEW_BRANCH_PREFIX);
      } catch (err) {
        await reportError(`${NAME}:repo`, repo.fullName, err, { repo: repo.fullName });
        return;
      }
      for (const branch of branches) {
        if (nonForkBranches.has(branch.name)) continue;
        const ref = issueRefFromPreviewBranch(branch.name);
        if (ref === null) continue;
        try {
          await syncIssuePreview(repo.fullName, ref, { kind: "branch", branch: branch.name, headSha: branch.sha });
        } catch (err) {
          await reportError(`${NAME}:branch`, `${repo.fullName}:${branch.name}`, err, { repo: repo.fullName });
        }
      }
    }),
  );
}
