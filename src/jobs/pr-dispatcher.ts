import { LABELS, type Repo, isAgentDisabled, isJobDisabledForRepo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited, RateLimitError } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { ShutdownError } from "../shutdown.js";
import * as ciFixer from "../agents/ci-fixer.js";
import * as worker from "../worker.js";
import { AGENT_KINDS } from "../worker.js";

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
        const prs = await gh.listPRs(repo.fullName);

        // ── Populate problematic PRs queue + enqueue deeper-diagnosis pass ──
        for (const pr of prs) {
          if (!pr.labels.some((l) => l.name === LABELS.problematic)) continue;
          populated.add(pr.number);
          gh.populateQueueCache("problematic", repo.fullName, {
            number: pr.number,
            title: pr.title,
            type: "pr",
            updatedAt: pr.updatedAt,
            priority: gh.hasPriorityLabel(pr.labels),
            labels: pr.labels.map((l) => l.name),
          });
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
            gh.populateQueueCache("needs-review-addressing", repo.fullName, {
              number: pr.number,
              title: pr.title,
              type: "pr",
              updatedAt: pr.updatedAt,
              priority: gh.hasPriorityLabel(pr.labels),
              labels: pr.labels.map((l) => l.name),
            });
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
          gh.populateQueueCache("ready", repo.fullName, {
            number: pr.number,
            title: pr.title,
            type: "pr",
            updatedAt: pr.updatedAt,
            priority: gh.hasPriorityLabel(pr.labels),
            labels: pr.labels.map((l) => l.name),
          });
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
