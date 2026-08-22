import * as worker from "./worker.js";
import { AGENT_KINDS } from "./worker.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import { LABELS, type Repo } from "./config.js";
import { isShuttingDown } from "./shutdown.js";
import { sleep } from "./util.js";
import * as ciFixer from "./agents/ci-fixer.js";
import * as problematicDiagnoser from "./agents/problematic-pr-diagnoser.js";
import * as reviewAddresser from "./agents/review-addresser.js";
import * as prReviewer from "./agents/pr-reviewer.js";
import * as autoMerger from "./agents/auto-merger.js";
import * as issueRefiner from "./agents/issue-refiner.js";
import * as issueWorker from "./agents/issue-worker.js";
import * as escalationReviewer from "./agents/escalation-reviewer.js";

/** Enqueue an auto-merger sweep for `repoFullName`, with the PR's priority preserved. */
function enqueueSweep(repoFullName: string, pr: gh.PR): void {
  if (isShuttingDown()) return;
  worker.enqueue(AGENT_KINDS.AUTO_MERGER_SWEEP, repoFullName, 0, {
    priority: gh.hasPriorityLabel(pr.labels),
  });
}


async function resolveRepo(fullName: string): Promise<Repo | null> {
  const repos = await gh.listRepos();
  return repos.find((r) => r.fullName === fullName) ?? null;
}

async function fetchOpenIssue(repo: string, num: number): Promise<gh.Issue | null> {
  const issues = await gh.listOpenIssues(repo);
  return issues.find((i) => i.number === num) ?? null;
}

async function fetchPR(repo: string, num: number): Promise<gh.PR | null> {
  const prs = await gh.listPRs(repo);
  return prs.find((p) => p.number === num) ?? null;
}

async function unreactedAfterPlan(
  repo: string,
  issueNumber: number,
  selfLogin: string,
): Promise<{ comments: gh.IssueComment[]; planIdx: number; unreacted: gh.IssueComment[] } | null> {
  const comments = await gh.getIssueComments(repo, issueNumber);
  const lastPlanIdx = comments.findLastIndex(
    (c) => c.body.includes(issueRefiner.PLAN_HEADER) && gh.isClawsComment(c.body),
  );
  if (lastPlanIdx === -1) return null;
  // Same candidate rule as the dispatcher's findUnreactedFeedbackAfterPlan — if the
  // two disagree the dispatcher enqueues work the handler then finds nothing to do.
  const candidates = issueRefiner.selectFeedbackCandidates(comments, lastPlanIdx);
  const unreacted = await issueRefiner.findUnreactedHumanComments(repo, candidates, selfLogin);
  return { comments, planIdx: lastPlanIdx, unreacted };
}

/** Register every handler with the worker. Called once at startup. */
export function registerAll(): void {
  worker.registerHandler(AGENT_KINDS.ISSUE_WORKER, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) {
      log.info(`[work-handler] ISSUE_WORKER: ${row.repo}#${row.item_number} no longer open — skipping`);
      return;
    }
    await issueWorker.processIssue(repo, issue);
  });

  worker.registerHandler(AGENT_KINDS.ISSUE_WORKER_CONTINUE, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    await issueWorker.checkAndContinue(repo, issue);
  });

  worker.registerHandler(AGENT_KINDS.ISSUE_REFINER_PLAN, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    await issueRefiner.processIssue(repo, issue);
  });

  worker.registerHandler(AGENT_KINDS.ESCALATION_REVIEW, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    await escalationReviewer.reviewPlanAndEscalate(repo, issue);
  });

  worker.registerHandler(AGENT_KINDS.ISSUE_REFINER_REFINE, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    const selfLogin = await gh.getSelfLogin(repo.owner);
    const data = await unreactedAfterPlan(row.repo, row.item_number, selfLogin);
    if (!data || data.unreacted.length === 0) {
      log.info(`[work-handler] ISSUE_REFINER_REFINE: no unreacted comments — skipping`);
      return;
    }
    await issueRefiner.processRefinement(repo, issue, data.unreacted);
  });

  worker.registerHandler(AGENT_KINDS.ISSUE_REFINER_REPLAN, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    // Re-evaluate the existing plan against the issue's updated occurrence count.
    await issueRefiner.processRefinement(repo, issue, []);
  });

  worker.registerHandler(AGENT_KINDS.ISSUE_REFINER_FOLLOWUP, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    const openPR = await gh.getOpenPRForIssue(row.repo, row.item_number);
    if (!openPR) {
      log.info(`[work-handler] ISSUE_REFINER_FOLLOWUP: no open PR for ${row.repo}#${row.item_number} — skipping`);
      return;
    }
    const selfLogin = await gh.getSelfLogin(repo.owner);
    const data = await unreactedAfterPlan(row.repo, row.item_number, selfLogin);
    if (!data || data.unreacted.length === 0) {
      log.info(`[work-handler] ISSUE_REFINER_FOLLOWUP: no unreacted comments — skipping`);
      return;
    }
    await issueRefiner.processFollowUp(repo, issue, openPR.number, data.unreacted);
  });

  worker.registerHandler(AGENT_KINDS.CI_FIXER, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, row.item_number);
    if (!pr) {
      log.info(`[work-handler] CI_FIXER: PR ${row.repo}#${row.item_number} no longer open — skipping`);
      return;
    }
    // Both kinds push to the PR's branch. A new-commit grant can clear the
    // problematic label mid-sweep, so a diagnoser enqueued from the pre-grant
    // label snapshot may still be running when this fix job is claimed.
    if (db.hasActiveWorkForPR(row.repo, row.item_number, [AGENT_KINDS.CI_FIXER_CONFLICT, AGENT_KINDS.CI_FIXER_PROBLEMATIC])) {
      log.info(`[work-handler] CI_FIXER: skipping ${row.repo}#${row.item_number} — conflict resolution or problematic diagnosis already running`);
      return;
    }
    try {
      const item = await ciFixer.identifyPRWork(repo, pr);
      if (!item) return;
      if (item.kind === "conflict") {
        log.info(`[work-handler] CI_FIXER: ${row.repo}#${row.item_number} is conflicting — routing to ${AGENT_KINDS.CI_FIXER_CONFLICT}`);
        worker.enqueue(AGENT_KINDS.CI_FIXER_CONFLICT, row.repo, row.item_number, {
          priority: gh.hasPriorityLabel(pr.labels),
        });
        return;
      }
      if (item.kind === "rerun") {
        await ciFixer.performRerun(item);
        return;
      }
      await ciFixer.runCIFix(repo, pr, item.failedCheck);
    } finally {
      enqueueSweep(row.repo, pr);
    }
  });

  worker.registerHandler(AGENT_KINDS.CI_FIXER_CONFLICT, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, row.item_number);
    if (!pr) return;
    if (await gh.getPRMergeableState(row.repo, row.item_number) !== "CONFLICTING") return;
    try {
      await ciFixer.resolveConflicts(repo, pr);
    } finally {
      enqueueSweep(row.repo, pr);
    }
  });

  worker.registerHandler(AGENT_KINDS.CI_FIXER_RERUN, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const prs = await gh.listPRs(row.repo);

    type RerunItem = Extract<ciFixer.WorkItem, { kind: "rerun" }>;
    const rerunItems: RerunItem[] = [];
    for (const pr of prs) {
      if (gh.isItemSkipped(row.repo, pr.number)) continue;
      if (gh.hasIgnoreLabel(pr.labels)) continue;
      const item = await ciFixer.identifyPRWork(repo, pr).catch(() => null);
      if (item && item.kind === "rerun") rerunItems.push(item);
    }
    if (rerunItems.length === 0) return;

    const sortedReruns = rerunItems.sort((a, b) => {
      const ap = gh.hasPriorityLabel(a.pr.labels) ? 0 : 1;
      const bp = gh.hasPriorityLabel(b.pr.labels) ? 0 : 1;
      return ap - bp;
    });

    let rerunCount = 0;
    for (const item of sortedReruns) {
      log.info(`[work-handler] CI_FIXER_RERUN: re-running ${item.infra ? "runner-outage" : "cancelled"} check for ${item.repo.fullName}#${item.pr.number}`);
      if (await ciFixer.performRerun(item)) rerunCount++;
      await sleep(2000);
    }
    log.info(`[work-handler] CI_FIXER_RERUN: re-ran ${rerunCount} workflow(s) for ${row.repo}`);
  });

  worker.registerHandler(AGENT_KINDS.CI_FIXER_PROBLEMATIC, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, row.item_number);
    if (!pr) {
      log.info(`[work-handler] CI_FIXER_PROBLEMATIC: PR ${row.repo}#${row.item_number} no longer open — skipping`);
      return;
    }
    if (!pr.labels.some((l) => l.name === LABELS.problematic)) {
      log.info(`[work-handler] CI_FIXER_PROBLEMATIC: ${row.repo}#${row.item_number} no longer problematic — skipping`);
      return;
    }
    // Symmetric to the CI_FIXER guard above: whichever branch-pushing job is
    // claimed first blocks the other for this PR.
    if (db.hasActiveWorkForPR(row.repo, row.item_number, [AGENT_KINDS.CI_FIXER, AGENT_KINDS.CI_FIXER_CONFLICT])) {
      log.info(`[work-handler] CI_FIXER_PROBLEMATIC: skipping ${row.repo}#${row.item_number} — ci-fixer already running`);
      return;
    }
    await problematicDiagnoser.runDiagnosis(repo, pr);
  });

  worker.registerHandler(AGENT_KINDS.REVIEW_ADDRESSER, async (row, args) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, row.item_number);
    if (!pr) return;
    try {
      if (gh.isForkPR(pr)) return;
      if (await gh.getPRMergeableState(row.repo, row.item_number) === "CONFLICTING") return;
      const advisory = args.advisory === true;
      const reviewData = await gh.getPRReviewComments(row.repo, row.item_number, { includeAdvisory: advisory });
      if (!reviewData.formatted || (!reviewData.prReviewComment && reviewData.commentIds.length === 0 && reviewData.reviewCommentIds.length === 0)) {
        return;
      }
      // State moved between dispatch and claim (e.g. a fresh blocking review landed):
      // this is now a normal round, so apply the Ready removal Phase 3 skipped.
      if (advisory && !reviewData.advisoryOnly) await gh.removeLabel(row.repo, row.item_number, LABELS.ready);
      await reviewAddresser.processPR(repo, pr, reviewData);
    } finally {
      enqueueSweep(row.repo, pr);
    }
  });

  worker.registerHandler(AGENT_KINDS.PR_REVIEWER, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, row.item_number);
    if (!pr) return;
    try {
      const shouldReview =
        (await prReviewer.hasNewCommitsSinceLastReview(row.repo, row.item_number)) ||
        (await prReviewer.getPendingRebuttal(row.repo, row.item_number)) !== null;
      if (!shouldReview) {
        const alreadyReady = pr.labels.some((l) => l.name === LABELS.ready);
        if (!alreadyReady) await prReviewer.maybeAddReadyLabel(row.repo, row.item_number);
        return;
      }
      await prReviewer.processPR(repo, pr);
    } finally {
      enqueueSweep(row.repo, pr);
    }
  });

  worker.registerHandler(AGENT_KINDS.AUTO_MERGER_SWEEP, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    // The sweep is chained off ci-fixer/reviewer completion, so the 60 s PR-list
    // cache may still hold labels captured before that agent mutated the PR (#2354).
    gh.invalidatePRList(row.repo);
    const prs = await gh.listPRs(row.repo);
    const skipKinds = [
      AGENT_KINDS.CI_FIXER,
      AGENT_KINDS.CI_FIXER_CONFLICT,
      AGENT_KINDS.REVIEW_ADDRESSER,
      AGENT_KINDS.PR_REVIEWER,
    ];
    for (const pr of prs) {
      if (gh.isItemSkipped(row.repo, pr.number)) continue;
      if (gh.hasIgnoreLabel(pr.labels)) continue;
      if (db.hasActiveWorkForPR(row.repo, pr.number, skipKinds)) {
        log.info(`[work-handler] AUTO_MERGER_SWEEP: skipping ${row.repo}#${pr.number} — other work running`);
        continue;
      }
      try {
        await autoMerger.tryMerge(repo, pr);
      } catch (err) {
        log.warn(`[work-handler] AUTO_MERGER_SWEEP: tryMerge failed for ${row.repo}#${pr.number}: ${err}`);
      }
    }
  });
}
