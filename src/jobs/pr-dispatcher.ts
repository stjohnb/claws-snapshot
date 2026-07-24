import { LABELS, type Repo, isAgentDisabled, isJobDisabledForRepo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited, RateLimitError } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { ShutdownError } from "../shutdown.js";
import * as ciFixer from "../agents/ci-fixer.js";
import * as worker from "../worker.js";
import { AGENT_KINDS } from "../worker.js";
import * as db from "../db.js";

const EMPTY_PR_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * Detects and closes PRs with zero net diff against their base branch (0 changed
 * files, 0 additions, 0 deletions) — e.g. an automation bump PR whose sole commit
 * was later cancelled out by a conflict-resolution merge. Also closes the PR's
 * linked issue when a merged PR already exists for it.
 */
export async function sweepEmptyPRs(repo: Repo, prs: gh.PR[]): Promise<Set<number>> {
  const closed = new Set<number>();
  for (const pr of prs) {
    try {
      if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
      if (gh.isForkPR(pr)) continue;
      if (pr.isDraft) continue;
      if (pr.changedFiles === undefined) continue;
      if (pr.changedFiles !== 0 || (pr.additions ?? 0) !== 0 || (pr.deletions ?? 0) !== 0) continue;
      if (!pr.createdAt) continue;
      const age = Date.now() - Date.parse(pr.createdAt);
      if (!Number.isFinite(age) || age < EMPTY_PR_MIN_AGE_MS) continue;
      if (
        db.hasActiveWorkForPR(repo.fullName, pr.number, [
          AGENT_KINDS.CI_FIXER,
          AGENT_KINDS.CI_FIXER_CONFLICT,
          AGENT_KINDS.REVIEW_ADDRESSER,
          AGENT_KINDS.PR_REVIEWER,
        ])
      ) {
        continue;
      }

      const stats = await gh.getPRDiffStats(repo.fullName, pr.number);
      if (!stats || stats.state !== "OPEN") continue;
      if (stats.changedFiles !== 0 || stats.additions !== 0 || stats.deletions !== 0) continue;

      await gh.commentOnIssue(
        repo.fullName,
        pr.number,
        "### Closing empty PR\n\nThis PR contains no changes (0 files changed, 0 additions, 0 deletions) — its branch has no net difference from the base branch, so it can never be merged usefully. Closing automatically.\n\nReopen it if this is wrong.",
        { agentName: "Empty PR Closer" },
      );
      await gh.closePR(repo.fullName, pr.number);
      log.info(`[pr-dispatcher] Closed empty PR ${repo.fullName}#${pr.number}`);
      closed.add(pr.number);

      const linked = gh.getLinkedIssueNumber(pr);
      if (linked === null) continue;
      let issueState: { state: string; stateReason: string | null };
      try {
        issueState = await gh.getIssueState(repo.fullName, linked);
      } catch {
        continue;
      }
      if (issueState.state !== "OPEN") continue;

      const merged = await gh.listMergedPRsForIssue(repo.fullName, linked);
      if (merged.length > 0) {
        await gh.commentOnIssue(
          repo.fullName,
          linked,
          `PR #${pr.number} was closed because it contained no changes. A PR for this issue has already been merged, so the work is done — closing this issue.`,
          { agentName: "Empty PR Closer" },
        );
        await gh.closeIssue(repo.fullName, linked, "completed");
      } else {
        await gh.commentOnIssue(
          repo.fullName,
          linked,
          `PR #${pr.number} was closed because it contained no changes — the branch had no net difference from the base branch, so nothing was actually implemented. Leaving this issue open so it can be re-implemented.`,
          { agentName: "Empty PR Closer" },
        );
      }
    } catch (err) {
      reportError("pr-dispatcher:empty-pr", `${repo.fullName}#${pr.number}`, err);
    }
  }
  return closed;
}

export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(
    repos.map(async (repo) => {
      // Note: all repo callbacks start concurrently, so this check does not prevent
      // other repos from being dispatched — it only short-circuits the current repo's
      // work if rate limiting is already detected when its callback begins executing.
      if (isRateLimited()) return;
      const ciFixerDisabled =
        isAgentDisabled("ci-fixer") || isJobDisabledForRepo("ci-fixer", repo.fullName);
      const populated = new Set<number>();
      try {
        const allPRs = await gh.listPRs(repo.fullName);
        const emptyClosed =
          isAgentDisabled("empty-pr-closer") || isJobDisabledForRepo("empty-pr-closer", repo.fullName)
            ? new Set<number>()
            : await sweepEmptyPRs(repo, allPRs);
        const prs = emptyClosed.size ? allPRs.filter((p) => !emptyClosed.has(p.number)) : allPRs;

        // ── Populate problematic PRs queue + enqueue deeper-diagnosis pass ──
        for (const pr of prs) {
          if (!pr.labels.some((l) => l.name === LABELS.problematic)) continue;
          populated.add(pr.number);
          gh.populateQueueCacheFor("problematic", repo.fullName, pr, "pr");
          if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
          if (ciFixerDisabled) continue;
          worker.enqueue(AGENT_KINDS.CI_FIXER_PROBLEMATIC, repo.fullName, pr.number, {
            priority: gh.hasPriorityLabel(pr.labels),
          });
        }

        // ── Phase 1: CI identification (pure GitHub API — no claude) ──
        const items: ciFixer.WorkItem[] = [];
        if (!ciFixerDisabled) {
          for (const pr of prs) {
            if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
            try {
              const item = await ciFixer.identifyPRWork(repo, pr);
              if (item) items.push(item);
            } catch (err) {
              if (err instanceof ShutdownError) {
                log.info(`[pr-dispatcher] Shutdown during CI identification for ${repo.fullName}#${pr.number}`);
              } else if (err instanceof RateLimitError) {
                log.warn(`[pr-dispatcher] Rate limited during CI identification for ${repo.fullName}#${pr.number}`);
              } else {
                reportError("ci-fixer:identify", `${repo.fullName}#${pr.number}`, err);
              }
            }
          }
        }

        // Track PRs with active ci-fixer push work (fix/conflict) to avoid
        // concurrent branch modifications by review-addresser (see #701)
        const ciFixerPRNumbers = new Set(
          items
            .filter((i) => i.kind === "fix" || i.kind === "conflict")
            .map((i) => i.pr.number),
        );

        // ── Phase 2: Enqueue CI work ──
        if (!ciFixerDisabled) {
          let needsRerunSweep = false;
          for (const item of items) {
            if (item.kind === "conflict") {
              worker.enqueue(AGENT_KINDS.CI_FIXER_CONFLICT, item.repo.fullName, item.pr.number, {
                priority: gh.hasPriorityLabel(item.pr.labels),
              });
            } else if (item.kind === "rerun") {
              needsRerunSweep = true;
            } else if (item.kind === "fix") {
              worker.enqueue(AGENT_KINDS.CI_FIXER, item.repo.fullName, item.pr.number, {
                priority: gh.hasPriorityLabel(item.pr.labels),
              });
            }
          }
          if (needsRerunSweep) {
            worker.enqueue(AGENT_KINDS.CI_FIXER_RERUN, repo.fullName, 0);
          }
        }

        // ── Phase 3: Review addresser ──
        // Track PRs processed by review-addresser this cycle so pr-reviewer (Phase 4) can skip them.
        // This prevents pr-reviewer from adding Ready in the same cycle that review-addresser just worked.
        const reviewAddresserPRNumbers = new Set<number>();
        if (!isAgentDisabled("review-addresser")) {
          for (const pr of prs) {
            if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
            if (gh.isForkPR(pr)) continue;
            if (ciFixerPRNumbers.has(pr.number)) {
              log.info(`[pr-dispatcher] Skipping review-addresser for ${repo.fullName}#${pr.number} — ci-fixer active this cycle`);
              continue;
            }
            const reviewData = await gh.getPRReviewComments(repo.fullName, pr.number);
            if (!reviewData.formatted || (!reviewData.prReviewComment && reviewData.commentIds.length === 0 && reviewData.reviewCommentIds.length === 0)) {
              continue;
            }
            if (await gh.getPRMergeableState(repo.fullName, pr.number) === "CONFLICTING") continue;

            populated.add(pr.number);
            gh.populateQueueCacheFor("needs-review-addressing", repo.fullName, pr, "pr");
            await gh.removeLabel(repo.fullName, pr.number, LABELS.ready);
            reviewAddresserPRNumbers.add(pr.number);
            worker.enqueue(AGENT_KINDS.REVIEW_ADDRESSER, repo.fullName, pr.number, {
              priority: gh.hasPriorityLabel(pr.labels),
            });
          }
        }

        // ── Phase 4: PR reviewer ──
        if (!isAgentDisabled("reviewer")) {
          for (const pr of prs) {
            if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
            if (reviewAddresserPRNumbers.has(pr.number)) {
              log.info(`[pr-dispatcher] Skipping pr-reviewer for ${repo.fullName}#${pr.number} — review-addresser active this cycle`);
              continue;
            }
            worker.enqueue(AGENT_KINDS.PR_REVIEWER, repo.fullName, pr.number, {
              priority: gh.hasPriorityLabel(pr.labels),
            });
          }
        }

        // ── Phase 5: Auto-merger sweep ──
        // Auto-merger ordering vs ci-fixer/review-addresser/pr-reviewer is enforced
        // by `db.hasActiveWorkForPR` inside the sweep handler — it skips PRs that
        // already have running work and re-iterates next sweep cycle.
        if (!isAgentDisabled("merger")) {
          worker.enqueue(AGENT_KINDS.AUTO_MERGER_SWEEP, repo.fullName, 0);
        }

        // ── Phase 6: Surface Ready PRs in queue UI ──
        // PRs labeled Ready that aren't auto-merged need a human to merge them.
        // Add them to the "ready" cache so they show up in "Needs My Attention"
        // with a Squash & Merge button (see src/pages/queue.ts:192).
        for (const pr of prs) {
          if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
          if (gh.isForkPR(pr)) continue;
          if (ciFixerPRNumbers.has(pr.number)) continue;
          // Phase 3 just removed Ready from these — local pr.labels is stale,
          // so trust the in-memory set rather than the label list.
          if (reviewAddresserPRNumbers.has(pr.number)) continue;
          if (!pr.labels.some((l) => l.name === LABELS.ready)) continue;
          populated.add(pr.number);
          gh.populateQueueCacheFor("ready", repo.fullName, pr, "pr");
        }

        if (!isRateLimited()) {
          const reconcileCategories: gh.QueueCategory[] = ["problematic", "ready"];
          if (!isAgentDisabled("review-addresser")) reconcileCategories.push("needs-review-addressing");
          gh.reconcileQueueCache(repo.fullName, reconcileCategories, populated, "pr");
        }
      } catch (err) {
        reportError("pr-dispatcher:list-prs", repo.fullName, err);
      }
    }),
  );
}
