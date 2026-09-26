import { sameIssueRef, type IssueRef } from "./issue-id.js";
import * as worker from "./worker.js";
import { AGENT_KINDS } from "./worker.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import { LABELS, type Repo } from "./config.js";
import { isShuttingDown } from "./shutdown.js";
import { sleep } from "./util.js";
import { listOpenPhasePRs } from "./planned-prs.js";
import { isThirdPartyUpdateDeferred } from "./update-window.js";
import * as ciFixer from "./agents/ci-fixer.js";
import * as problematicDiagnoser from "./agents/problematic-pr-diagnoser.js";
import * as reviewAddresser from "./agents/review-addresser.js";
import * as prReviewer from "./agents/pr-reviewer.js";
import * as autoMerger from "./agents/auto-merger.js";
import * as issueRefiner from "./agents/issue-refiner.js";
import * as issueWorker from "./agents/issue-worker.js";
import * as escalationReviewer from "./agents/escalation-reviewer.js";
import * as requirementsWriter from "./agents/requirements-writer.js";

/** Enqueue an auto-merger sweep for `repoFullName`, with the PR's priority preserved. */
async function enqueueSweep(repoFullName: string, pr: gh.PR): Promise<void> {
  if (isShuttingDown()) return;
  await worker.enqueue(AGENT_KINDS.AUTO_MERGER_SWEEP, repoFullName, 0, {
    priority: gh.hasPriorityLabel(pr.labels),
  });
}


async function resolveRepo(fullName: string): Promise<Repo | null> {
  const repos = await gh.listRepos();
  return repos.find((r) => r.fullName === fullName) ?? null;
}

async function fetchOpenIssue(repo: string, num: IssueRef): Promise<gh.Issue | null> {
  const issues = await gh.listOpenIssues(repo);
  return issues.find((i) => sameIssueRef(i.number, num)) ?? null;
}

/**
 * A work row's item as a pull-request number.
 *
 * PR-keyed handlers are the one place a work row can never carry a native
 * reference: PRs live on a forge, and a native issue's PR is still a forge PR.
 * A `clw_…` here means the row was enqueued against the wrong handler, which
 * should fail the row loudly rather than silently match no PR.
 */
function prNumberOf(row: db.WorkQueueRow): number {
  if (typeof row.item_number !== "number") {
    throw new Error(`work-handlers: ${row.kind} expects a PR number, got ${row.item_number}`);
  }
  return row.item_number;
}

async function fetchPR(repo: string, num: number): Promise<gh.PR | null> {
  const prs = await gh.listPRs(repo);
  return prs.find((p) => p.number === num) ?? null;
}

async function unreactedAfterPlan(
  repo: string,
  issueNumber: IssueRef,
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
  const unreacted = await issueRefiner.findUnreactedHumanComments(repo, candidates, selfLogin, issueNumber);
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
    if (gh.isDispatchSkippable(row.repo, issue)) {
      log.info(`[work-handler] ISSUE_WORKER: ${row.repo}#${row.item_number} parked/staging — skipping`);
      return;
    }
    await issueWorker.processIssue(repo, issue);
  });

  worker.registerHandler(AGENT_KINDS.ISSUE_WORKER_CONTINUE, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    if (gh.isDispatchSkippable(row.repo, issue)) {
      log.info(`[work-handler] ISSUE_WORKER_CONTINUE: ${row.repo}#${row.item_number} parked/staging — skipping`);
      return;
    }
    await issueWorker.checkAndContinue(repo, issue);
  });

  worker.registerHandler(AGENT_KINDS.ISSUE_REFINER_PLAN, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    if (gh.isDispatchSkippable(row.repo, issue)) {
      log.info(`[work-handler] ISSUE_REFINER_PLAN: ${row.repo}#${row.item_number} parked/staging — skipping`);
      return;
    }
    await issueRefiner.processIssue(repo, issue);
  });

  worker.registerHandler(AGENT_KINDS.REQUIREMENTS_WRITE, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    if (gh.isDispatchSkippable(row.repo, issue)) {
      log.info(`[work-handler] REQUIREMENTS_WRITE: ${row.repo}#${row.item_number} parked/staging — skipping`);
      return;
    }
    if (await requirementsWriter.loadLatestRequirements(row.repo, row.item_number)) {
      log.info(`[work-handler] REQUIREMENTS_WRITE: ${row.repo}#${row.item_number} already has requirements — skipping`);
      return;
    }
    await requirementsWriter.writeRequirements(repo, issue);
  });

  worker.registerHandler(AGENT_KINDS.REQUIREMENTS_REFINE, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    if (gh.isDispatchSkippable(row.repo, issue)) {
      log.info(`[work-handler] REQUIREMENTS_REFINE: ${row.repo}#${row.item_number} parked/staging — skipping`);
      return;
    }
    const selfLogin = await gh.getSelfLoginForIssue(repo.fullName, row.item_number);
    const unreacted = await requirementsWriter.unreactedAfterRequirements(row.repo, row.item_number, selfLogin);
    if (!unreacted || unreacted.length === 0) {
      log.info(`[work-handler] REQUIREMENTS_REFINE: no unreacted comments — skipping`);
      return;
    }
    await requirementsWriter.refineRequirements(repo, issue, unreacted);
  });

  worker.registerHandler(AGENT_KINDS.ESCALATION_REVIEW, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    if (gh.isDispatchSkippable(row.repo, issue)) {
      log.info(`[work-handler] ESCALATION_REVIEW: ${row.repo}#${row.item_number} parked/staging — skipping`);
      return;
    }
    await escalationReviewer.reviewPlanAndEscalate(repo, issue);
  });

  worker.registerHandler(AGENT_KINDS.ISSUE_REFINER_REFINE, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    if (gh.isDispatchSkippable(row.repo, issue)) {
      log.info(`[work-handler] ISSUE_REFINER_REFINE: ${row.repo}#${row.item_number} parked/staging — skipping`);
      return;
    }
    const selfLogin = await gh.getSelfLoginForIssue(repo.fullName, row.item_number);
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
    if (gh.isDispatchSkippable(row.repo, issue)) {
      log.info(`[work-handler] ISSUE_REFINER_REPLAN: ${row.repo}#${row.item_number} parked/staging — skipping`);
      return;
    }
    // Re-evaluate the existing plan against the issue's updated occurrence count.
    await issueRefiner.processRefinement(repo, issue, []);
  });

  worker.registerHandler(AGENT_KINDS.ISSUE_REFINER_FOLLOWUP, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const issue = await fetchOpenIssue(row.repo, row.item_number);
    if (!issue) return;
    if (gh.isDispatchSkippable(row.repo, issue)) {
      log.info(`[work-handler] ISSUE_REFINER_FOLLOWUP: ${row.repo}#${row.item_number} parked/staging — skipping`);
      return;
    }
    // Every open step PR, in any of the issue's repos — a parallel or
    // multi-repo plan's current PR need not be on this repo's issue branch.
    const openPRs = await listOpenPhasePRs(row.repo, row.item_number);
    if (openPRs.length === 0) {
      log.info(`[work-handler] ISSUE_REFINER_FOLLOWUP: no open step PR for ${row.repo}#${row.item_number} — skipping`);
      return;
    }
    const selfLogin = await gh.getSelfLoginForIssue(repo.fullName, row.item_number);
    const data = await unreactedAfterPlan(row.repo, row.item_number, selfLogin);
    if (!data || data.unreacted.length === 0) {
      log.info(`[work-handler] ISSUE_REFINER_FOLLOWUP: no unreacted comments — skipping`);
      return;
    }
    await issueRefiner.processFollowUp(repo, issue, openPRs, data.unreacted);
  });

  worker.registerHandler(AGENT_KINDS.CI_FIXER, async (row) => {
    const prNumber = prNumberOf(row);
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, prNumber);
    if (!pr) {
      log.info(`[work-handler] CI_FIXER: PR ${row.repo}#${prNumber} no longer open — skipping`);
      return;
    }
    if (gh.isDispatchSkippable(row.repo, pr)) {
      log.info(`[work-handler] CI_FIXER: ${row.repo}#${prNumber} parked/staging — skipping`);
      return;
    }
    // Both kinds push to the PR's branch. A new-commit grant can clear the
    // problematic label mid-sweep, so a diagnoser enqueued from the pre-grant
    // label snapshot may still be running when this fix job is claimed.
    if (await db.hasActiveWorkForPR(row.repo, prNumber, [AGENT_KINDS.CI_FIXER_CONFLICT, AGENT_KINDS.CI_FIXER_PROBLEMATIC])) {
      log.info(`[work-handler] CI_FIXER: skipping ${row.repo}#${prNumber} — conflict resolution or problematic diagnosis already running`);
      return;
    }
    try {
      const item = await ciFixer.identifyPRWork(repo, pr);
      if (!item) return;
      if (item.kind === "conflict") {
        log.info(`[work-handler] CI_FIXER: ${row.repo}#${prNumber} is conflicting — routing to ${AGENT_KINDS.CI_FIXER_CONFLICT}`);
        await worker.enqueue(AGENT_KINDS.CI_FIXER_CONFLICT, row.repo, prNumber, {
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
      await enqueueSweep(row.repo, pr);
    }
  });

  worker.registerHandler(AGENT_KINDS.CI_FIXER_CONFLICT, async (row) => {
    const prNumber = prNumberOf(row);
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, prNumber);
    if (!pr) return;
    if (gh.isDispatchSkippable(row.repo, pr)) {
      log.info(`[work-handler] CI_FIXER_CONFLICT: ${row.repo}#${prNumber} parked/staging — skipping`);
      return;
    }
    if (await gh.getPRMergeableState(row.repo, prNumber) !== "CONFLICTING") return;
    try {
      await ciFixer.resolveConflicts(repo, pr);
    } finally {
      await enqueueSweep(row.repo, pr);
    }
  });

  worker.registerHandler(AGENT_KINDS.CI_FIXER_RERUN, async (row) => {
    // No `prNumberOf(row)` here: this is a repo-level kind, enqueued with the
    // `0` sentinel, and the handler sweeps the repo's PRs rather than acting
    // on `row.item_number`.
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const prs = await gh.listPRs(row.repo);

    type RerunItem = Extract<ciFixer.WorkItem, { kind: "rerun" }>;
    const rerunItems: RerunItem[] = [];
    for (const pr of prs) {
      if (gh.isDispatchSkippable(row.repo, pr)) continue;
      if (isThirdPartyUpdateDeferred(row.repo, pr)) continue;
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
    const prNumber = prNumberOf(row);
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, prNumber);
    if (!pr) {
      log.info(`[work-handler] CI_FIXER_PROBLEMATIC: PR ${row.repo}#${prNumber} no longer open — skipping`);
      return;
    }
    if (gh.isDispatchSkippable(row.repo, pr)) {
      log.info(`[work-handler] CI_FIXER_PROBLEMATIC: ${row.repo}#${prNumber} parked/staging — skipping`);
      return;
    }
    if (!pr.labels.some((l) => l.name === LABELS.problematic)) {
      log.info(`[work-handler] CI_FIXER_PROBLEMATIC: ${row.repo}#${prNumber} no longer problematic — skipping`);
      return;
    }
    // Symmetric to the CI_FIXER guard above: whichever branch-pushing job is
    // claimed first blocks the other for this PR.
    if (await db.hasActiveWorkForPR(row.repo, prNumber, [AGENT_KINDS.CI_FIXER, AGENT_KINDS.CI_FIXER_CONFLICT])) {
      log.info(`[work-handler] CI_FIXER_PROBLEMATIC: skipping ${row.repo}#${prNumber} — ci-fixer already running`);
      return;
    }
    await problematicDiagnoser.runDiagnosis(repo, pr);
  });

  worker.registerHandler(AGENT_KINDS.REVIEW_ADDRESSER, async (row, args) => {
    const prNumber = prNumberOf(row);
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, prNumber);
    if (!pr) return;
    if (gh.isDispatchSkippable(row.repo, pr)) {
      log.info(`[work-handler] REVIEW_ADDRESSER: ${row.repo}#${prNumber} parked/staging — skipping`);
      return;
    }
    try {
      if (gh.isForkPR(pr)) return;
      if (await gh.getPRMergeableState(row.repo, prNumber) === "CONFLICTING") return;
      const advisory = args.advisory === true;
      const reviewData = await gh.getPRReviewComments(row.repo, prNumber, { includeAdvisory: advisory });
      if (!reviewData.formatted || (!reviewData.prReviewComment && reviewData.commentIds.length === 0 && reviewData.reviewCommentIds.length === 0)) {
        return;
      }
      // State moved between dispatch and claim (e.g. a fresh blocking review landed):
      // this is now a normal round, so apply the Ready removal Phase 3 skipped.
      if (advisory && !reviewData.advisoryOnly) await gh.removeLabel(row.repo, prNumber, LABELS.ready);
      await reviewAddresser.processPR(repo, pr, reviewData);
    } finally {
      await enqueueSweep(row.repo, pr);
    }
  });

  worker.registerHandler(AGENT_KINDS.PR_REVIEWER, async (row) => {
    const prNumber = prNumberOf(row);
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    const pr = await fetchPR(row.repo, prNumber);
    if (!pr) return;
    if (gh.isDispatchSkippable(row.repo, pr)) {
      log.info(`[work-handler] PR_REVIEWER: ${row.repo}#${prNumber} parked/staging — skipping`);
      return;
    }
    // A queued pr-reviewer row can outlive the cycle that created it (enqueueWork
    // dedupes on kind+repo+item while queued/running), so the Phase 4 dispatch skip
    // alone can't stop a stale row from being claimed while a branch-pushing agent
    // is mid-run. Reviewing then stamps the review with a SHA that push replaces
    // (#2667). pr-dispatcher re-enqueues pr-reviewer every cycle, so returning here
    // just defers the review by one cycle, against the correct head.
    if (
      await db.hasActiveWorkForPR(row.repo, prNumber, [
        AGENT_KINDS.CI_FIXER,
        AGENT_KINDS.CI_FIXER_CONFLICT,
        AGENT_KINDS.CI_FIXER_PROBLEMATIC,
        AGENT_KINDS.REVIEW_ADDRESSER,
      ])
    ) {
      log.info(`[work-handler] PR_REVIEWER: skipping ${row.repo}#${prNumber} — branch-modifying work already running`);
      return;
    }
    try {
      const shouldReview =
        (await prReviewer.hasNewCommitsSinceLastReview(row.repo, prNumber)) ||
        (await prReviewer.getPendingRebuttal(row.repo, prNumber)) !== null;
      if (!shouldReview) {
        const alreadyReady = pr.labels.some((l) => l.name === LABELS.ready);
        if (!alreadyReady) await prReviewer.maybeAddReadyLabel(row.repo, prNumber);
        return;
      }
      await prReviewer.processPR(repo, pr);
    } finally {
      await enqueueSweep(row.repo, pr);
    }
  });

  worker.registerHandler(AGENT_KINDS.AUTO_MERGER_SWEEP, async (row) => {
    const repo = await resolveRepo(row.repo);
    if (!repo) throw new Error(`Unknown repo ${row.repo}`);
    await autoMerger.sweepRepo(repo);
  });
}
