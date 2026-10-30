import { type Repo, isAgentDisabled, isJobDisabledForRepo } from "../config.js";
import * as gh from "../github.js";
import { RateLimitError } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { ShutdownError } from "../shutdown.js";
import * as ciFixer from "../agents/ci-fixer.js";
import * as prReviewer from "../agents/pr-reviewer.js";
import { finalizeMergedClawsPR, isApprovalExempt, isAutoBumpPR, isImageScanPR, isImageScanPrunePR } from "../agents/auto-merger.js";
import * as worker from "../worker.js";
import { AGENT_KINDS } from "../worker.js";
import * as db from "../db.js";
import { FORGE_LABEL_APPROVER, hasManualAction, isAwaitingMerge, isMergeApproved, isProblematic, isReviewedHeadAwaitingMerge, markPrAwaitingMerge, markPrAwaitingReview } from "../pr-state.js";
import { STACKED_PREFIX, blockLinkedIssue, clearPrHold, recordPrHold, settleOperatorStepHold } from "../pr-hold.js";
import { releasePrStallParks, settlePrStallPark } from "../pr-stall-park.js";
import { releasePrWaitParks } from "../pr-wait-park.js";
import { isStalledPr } from "../issue-board.js";

const EMPTY_PR_MIN_AGE_MS = 10 * 60 * 1000;

/** Stages review feedback demotes to `addressing-review` (`markPrAwaitingReview` has already moved awaiting-merge on). */
const FEEDBACK_DEMOTABLE_STAGES: ReadonlySet<string> = new Set(["awaiting-merge", "awaiting-review", "opened"]);

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
        await db.hasActiveWorkForPR(repo.fullName, pr.number, [
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
      let issueState: { state: gh.IssueState; stateReason: string | null };
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
      reportError("pr-dispatcher:empty-pr", `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
    }
  }
  return closed;
}

const STACKED_PR_MARKER = "claws-stacked-pr-flagged";

/**
 * Flags any Claws PR whose base is not the default branch (#2720). Claws does not
 * stack PRs — a change either targets the default branch or is committed onto the
 * existing PR's branch — so anything that slips through gets a {@link STACKED_PREFIX}
 * hold (which blocks auto-merger), its issue parked in Blocked, and one explanatory
 * comment, deduped by STACKED_PR_MARKER. The base is deliberately not
 * auto-retargeted: that reproduces the giant-diff problem this sweep exists to
 * catch. A Claws PR on the default branch — retargeted by a human — has its
 * stacked hold lifted.
 */
export async function sweepStackedPRs(repo: Repo, prs: gh.PR[]): Promise<void> {
  for (const pr of prs) {
    try {
      if (!pr.headRefName.startsWith("claws/")) continue;   // never touch human stacks
      if (pr.baseRefName === repo.defaultBranch) {
        await clearPrHold(repo.fullName, pr.number, STACKED_PREFIX);
        continue;
      }
      if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
      if (gh.isForkPR(pr)) continue;
      const comments = await gh.getIssueComments(repo.fullName, pr.number).catch(() => []);
      if (comments.some((c) => c.body.includes(STACKED_PR_MARKER))) continue;
      // Hold and park first: the comment's marker ends the retries.
      const reason = `${STACKED_PREFIX} targets \`${pr.baseRefName}\` rather than \`${repo.defaultBranch}\``;
      await recordPrHold(repo.fullName, pr.number, reason);
      await blockLinkedIssue(repo.fullName, pr.number,
        `PR \`${repo.fullName}#${pr.number}\` targets \`${pr.baseRefName}\` rather than \`${repo.defaultBranch}\`, and Claws does not stack PRs. Retarget it to \`${repo.defaultBranch}\` or fold its commits into the PR it is stacked on, then move this issue out of Blocked.`,
        `stacked-pr-${pr.number}`, { headRefName: pr.headRefName });
      await gh.commentOnIssue(repo.fullName, pr.number, [
        `### Stacked PR`,
        ``,
        `This PR targets \`${pr.baseRefName}\` rather than \`${repo.defaultBranch}\`. Claws does not stack PRs — a change either targets the default branch or is committed onto the existing PR's branch. Claws will not merge it, and its issue is parked in Blocked; a human should either retarget it to \`${repo.defaultBranch}\` or fold its commits into the PR it is stacked on and close it. Retargeting it lifts the hold.`,
        ``,
        STACKED_PR_MARKER,
      ].join("\n"), { agentName: "PR Dispatcher" });
      log.info(`[pr-dispatcher] Flagged stacked PR ${repo.fullName}#${pr.number} (base ${pr.baseRefName})`);
    } catch (err) {
      reportError("pr-dispatcher:stacked-pr", `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
    }
  }
}

/**
 * Phase 0a: the PR state store (`claws_prs`, src/pr-state.ts) — the only PR
 * state input; forge state labels are a write-only mirror never read here.
 * Seeds a row for every open PR not yet seen, from CI alone (`ci-failing`
 * when CI is failing, otherwise `opened`, every flag empty), and refreshes
 * the observed fields. An open row still carrying the legacy
 * {@link FORGE_LABEL_APPROVER} has its approval cleared: a forge label
 * approves nothing.
 * Rows still open in the store whose PR has left the open list are marked
 * `merged`/`closed`; a merged row linked to an issue then gets the
 * post-merge cleanup (`finalizeMergedClawsPR`), which closes a native issue
 * a hand-merged PR names. A row holding an operator step is settled on the
 * fresh row (`settleOperatorStepHold`): once the PR is otherwise ready to
 * merge its issue is told, once per PR and step, that the PR waits on the
 * step. The issue is not parked, and only an explicit per-PR clear lifts the
 * hold. A stalled row (`problematic`, CI-blocked, or an operator step CI
 * cannot pass without) parks its linked issue in Blocked
 * (`settlePrStallPark`); `run` releases those
 * parks once a tick. `held` (an
 * approval-pending run) moves no stage: it is neither a failure nor a pass.
 * Returns the `listPRStatuses` map it read, so later phases this tick need
 * not refetch it.
 */
export async function refreshPrStore(repo: Repo, prs: gh.PR[]): Promise<Map<number, gh.PRRepoStatus>> {
  const [statuses, rows] = await Promise.all([
    gh.listPRStatuses(repo.fullName),
    db.listClawsPrs(repo.fullName),
  ]);
  const byNumber = new Map(rows.map((r) => [r.prNumber, r]));
  const now = new Date().toISOString();
  for (const pr of prs) {
    try {
      const status = statuses.get(pr.number);
      const ciStatus = status?.checkStatus ?? null;
      const row = byNumber.get(pr.number) ?? null;
      const patch: db.ClawsPrPatch = {};
      if (!row) {
        patch.stage = ciStatus === "failing" ? "ci-failing" : "opened";
        log.info(`[pr-dispatcher] pr-store: seeded ${repo.fullName}#${pr.number} (${patch.stage})`);
      }
      // Look the plan link up once, at seeding; after that only a Claws branch
      // can still gain one (its plan is stored after the PR opens).
      if (!row || (!row.issueId && pr.headRefName.startsWith("claws/"))) {
        const planned = await db.findIssuePlannedPRByNumber(repo.fullName, pr.number);
        if (planned) {
          patch.issueId = planned.issueId;
          patch.phase = planned.position;
        }
      }
      if (pr.headRefOid) patch.headSha = pr.headRefOid;
      patch.observedAt = now;
      patch.title = pr.title;
      if (status) {
        patch.ciStatus = status.checkStatus;
        patch.mergeableState = status.mergeableState;
      }
      const review = await db.getLatestPRReview(repo.fullName, pr.number);
      if (review) {
        patch.reviewVerdict = review.verdict;
        patch.reviewedSha = review.headSha;
      }
      if (row) {
        // CI corrects the stages the label hook cannot know.
        if (ciStatus === "failing" && (row.stage === "opened" || row.stage === "awaiting-review")) {
          patch.stage = "ci-failing";
        } else if ((ciStatus === "passing" || ciStatus === "none") && row.stage === "ci-failing") {
          patch.stage = "awaiting-review";
        }
        if (row.mergeApprovedBy === FORGE_LABEL_APPROVER) {
          patch.mergeApprovedBy = null;
          patch.mergeApprovedAt = null;
          log.info(`[pr-dispatcher] pr-store: cleared the legacy forge-label merge approval on ${repo.fullName}#${pr.number}`);
        }
      }
      await db.upsertClawsPr(repo.fullName, pr.number, patch);
      if ((row?.manualActionReason || (row && isStalledPr(row))) && !gh.isDispatchSkippable(repo.fullName, pr)) {
        const fresh = await db.getClawsPr(repo.fullName, pr.number);
        if (fresh) {
          await settleOperatorStepHold(repo.fullName, pr, fresh);
          await settlePrStallPark(repo.fullName, pr, fresh);
        }
      }
    } catch (err) {
      reportError("pr-dispatcher:pr-store", `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
    }
  }

  const open = new Set(prs.map((p) => p.number));
  for (const row of rows) {
    if (open.has(row.prNumber) || row.stage === "merged" || row.stage === "closed") continue;
    try {
      const state = await gh.getPRState(repo.fullName, row.prNumber);
      // null: the forge no longer knows the PR (deleted or transferred repo).
      // Close the row so it is not re-queried every tick.
      if (state === "MERGED" || state === "CLOSED" || state === null) {
        const stage = state === "MERGED" ? "merged" : "closed";
        await db.upsertClawsPr(repo.fullName, row.prNumber, { stage, observedAt: now });
        log.info(`[pr-dispatcher] pr-store: ${repo.fullName}#${row.prNumber} is ${stage}${state === null ? " (not found on the forge)" : ""}`);
        if (stage === "merged" && row.issueId) {
          await finalizeMergedClawsPR(repo, { number: row.prNumber, headRefName: "", body: undefined }, "hand-merge");
        }
      }
    } catch (err) {
      reportError("pr-dispatcher:pr-store", `${repo.fullName}#${row.prNumber}`, err, { repo: repo.fullName });
    }
  }
  return statuses;
}

/**
 * Phase 7's queue category for a PR no earlier phase populated, from its
 * `claws_prs` stage. A PR in `addressing-review` is shown as
 * needs-review-addressing only when Phase 3 found feedback to address this
 * cycle; otherwise it is shown as needing review.
 * Null for merged/closed rows.
 */
export function stageQueueCategory(stage: db.ClawsPrStage | undefined, hasAddressableFeedback: boolean): gh.QueueCategory | null {
  switch (stage) {
    case "ci-failing":
      return "ci-failing";
    case undefined:
    case "opened":
    case "awaiting-review":
      return "needs-review";
    case "addressing-review":
      return hasAddressableFeedback ? "needs-review-addressing" : "needs-review";
    case "awaiting-merge":
      return "ready";
    case "problematic":
      return "problematic";
    case "merged":
    case "closed":
      return null;
  }
}

/** Phase 3's note for a PR whose review is waiting on a merge conflict; cleared once it is not conflicting. */
const CONFLICT_NOTE = "merge conflict — waiting for conflict resolution";
/** Phase 4's notes for a PR it sends no reviewer; worded like the pr-reviewer handler's own skips. */
const ACTIVE_WORK_NOTE = "branch-modifying work already running";
const NO_NEW_COMMITS_NOTE = "reviewer: no new commits since the last review";

/**
 * The first known reason no agent will act on this PR this cycle, if any.
 * `storedNote` is the row's fresh dispatch note, recorded by a work handler
 * (often in an agent pod) or by an earlier phase.
 */
function dispatchNoteFor(repo: Repo, pr: gh.PR, row: db.ClawsPrRecord | undefined, ciFixerDisabled: boolean, storedNote: string | undefined): string | undefined {
  const skipReason = gh.dispatchSkipReason(repo.fullName, pr);
  if (skipReason) return `not dispatched: ${skipReason}`;
  if (gh.isForkPR(pr)) return "fork PR — never dispatched";
  if (row?.stage === "ci-failing" && ciFixerDisabled) return "CI fixer disabled for this repo";
  const manualNote = row?.stage === "awaiting-merge" && row.manualActionReason ? `held: ${row.manualActionReason}` : undefined;
  // A ready PR's hold is what the operator must act on; a handler note
  // (rewritten every tick) must not hide it.
  return ciFixer.getIdentifySkipReason(repo.fullName, pr.number) ?? manualNote ?? storedNote;
}

export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(
    repos.map(async (repo) => {
      const ciFixerDisabled =
        isAgentDisabled("ci-fixer") || isJobDisabledForRepo("ci-fixer", repo.fullName);
      const populated = new Set<number>();
      try {
        // Always a fresh read, so the store refresh sees every open PR.
        gh.invalidatePRList(repo.fullName);
        const allPRs = await gh.listPRs(repo.fullName);

        // ── Phase 0a: PR store refresh ──
        // Before the sweeps below: every open PR needs its row before any
        // phase writes PR state (sweepStackedPRs records a hold).
        try {
          await refreshPrStore(repo, allPRs);
        } catch (err) {
          reportError("pr-dispatcher:pr-store", repo.fullName, err, { repo: repo.fullName });
        }

        // PR state is read from the rows, loaded once after the refresh. Writes
        // later this tick are tracked in the in-memory sets below.
        const rows = new Map((await db.listClawsPrs(repo.fullName)).map((r) => [r.prNumber, r]));
        // Dispatch notes written (or cleared, as null) this tick, which `rows` predates.
        const cycleNotes = new Map<number, string | null>();
        const emptyClosed =
          isAgentDisabled("empty-pr-closer") || isJobDisabledForRepo("empty-pr-closer", repo.fullName)
            ? new Set<number>()
            : await sweepEmptyPRs(repo, allPRs);
        const prs = emptyClosed.size ? allPRs.filter((p) => !emptyClosed.has(p.number)) : allPRs;

        if (!isAgentDisabled("stacked-pr-flagger") && !isJobDisabledForRepo("stacked-pr-flagger", repo.fullName)) {
          await sweepStackedPRs(repo, prs).catch((err) => reportError("pr-dispatcher:stacked-sweep", repo.fullName, err, { repo: repo.fullName }));
        }

        // ── Populate problematic PRs queue + enqueue deeper-diagnosis pass ──
        for (const pr of prs) {
          if (!isProblematic(rows.get(pr.number))) continue;
          populated.add(pr.number);
          gh.populateQueueCacheFor("problematic", repo.fullName, pr, "pr");
          if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
          if (ciFixerDisabled) continue;
          // Each enqueue is a candidate, not a decision: workers claim by
          // Priority, then stage rank (merge-nearest first), then age, and
          // re-enqueueing every tick refreshes a queued row's Priority flag.
          await worker.enqueue(AGENT_KINDS.CI_FIXER_PROBLEMATIC, repo.fullName, pr.number, {
            priority: gh.hasPriorityLabel(pr.labels),
          });
        }

        // ── Phase 0b: clear a stale refused-CI-re-run hold ──
        // A PR whose CI went green after Claws stopped retrying an un-rerunnable run
        // keeps the hold that blocks auto-merger unless something lifts it (#2462).
        // No-ops (and costs no API calls) for PRs without a hold.
        for (const pr of prs) {
          if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
          try {
            await ciFixer.clearNotRerunnableIfResolved(repo, pr);
          } catch (err) {
            reportError("ci-fixer:clear-not-rerunnable", `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
          }
        }

        // ── Phase 1: CI identification (pure forge API — no claude) ──
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
                reportError("ci-fixer:identify", `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
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
        // A PR being fixed is shown as CI failing while it is worked.
        for (const item of items) {
          if (item.kind !== "fix" && item.kind !== "conflict") continue;
          populated.add(item.pr.number);
          gh.populateQueueCacheFor("ci-failing", repo.fullName, item.pr, "pr");
        }

        // ── Phase 2: Enqueue CI work ──
        if (!ciFixerDisabled) {
          let needsRerunSweep = false;
          for (const item of items) {
            if (item.kind === "conflict") {
              // A conflict-resolution merge turns a generated prune into a held one;
              // the weekly scan regenerates it against main instead.
              if (isImageScanPrunePR(item.pr)) {
                log.info(`[pr-dispatcher] Skipping conflict fixer for ${item.repo.fullName}#${item.pr.number} — generated prune PR; the weekly scan regenerates it`);
                continue;
              }
              await worker.enqueue(AGENT_KINDS.CI_FIXER_CONFLICT, item.repo.fullName, item.pr.number, {
                priority: gh.hasPriorityLabel(item.pr.labels),
              });
            } else if (item.kind === "rerun") {
              needsRerunSweep = true;
            } else if (item.kind === "fix") {
              await worker.enqueue(AGENT_KINDS.CI_FIXER, item.repo.fullName, item.pr.number, {
                priority: gh.hasPriorityLabel(item.pr.labels),
              });
            }
          }
          if (needsRerunSweep) {
            await worker.enqueue(AGENT_KINDS.CI_FIXER_RERUN, repo.fullName, 0);
          }
        }

        // ── Phase 3: Review addresser ──
        // Track PRs processed by review-addresser this cycle so pr-reviewer (Phase 4) can skip them.
        // This prevents pr-reviewer from marking the PR awaiting merge in the same cycle that review-addresser just worked.
        const reviewAddresserPRNumbers = new Set<number>();
        // Subset of the above that is having advisory-only nits addressed. These
        // stay awaiting merge, so Phase 6 must still surface them.
        const advisoryPRNumbers = new Set<number>();
        // PRs with feedback for the addresser this cycle (even if a conflict defers it).
        const addressablePRNumbers = new Set<number>();
        if (!isAgentDisabled("review-addresser")) {
          for (const pr of prs) {
            if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
            if (gh.isForkPR(pr)) continue;
            if (ciFixerPRNumbers.has(pr.number)) {
              log.info(`[pr-dispatcher] Skipping review-addresser for ${repo.fullName}#${pr.number} — ci-fixer active this cycle`);
              continue;
            }
            const reviewData = await gh.getPRReviewComments(repo.fullName, pr.number, { includeAdvisory: true });
            if (!reviewData.formatted || (!reviewData.prReviewComment && reviewData.commentIds.length === 0 && reviewData.reviewCommentIds.length === 0)) {
              continue;
            }
            addressablePRNumbers.add(pr.number);
            if (await gh.getPRMergeableState(repo.fullName, pr.number) === "CONFLICTING") {
              cycleNotes.set(pr.number, CONFLICT_NOTE);
              await gh.setDispatchNote(repo.fullName, pr.number, CONFLICT_NOTE);
              continue;
            }
            // The conflict is resolved: drop the note Phase 3 left on an earlier tick.
            if (rows.get(pr.number)?.dispatchNote === CONFLICT_NOTE) {
              cycleNotes.set(pr.number, null);
              await gh.setDispatchNote(repo.fullName, pr.number, null);
            }

            if (reviewData.advisoryOnly) {
              // Advisory nits are only worth fixing while the PR is idle. Any signal that a
              // merge may be imminent (a merge approval, or an approval-exempt category) means
              // skip: pushing then can restart CI mid-merge. Awaiting merge is required too —
              // the advisory branch only moves there when CI passes and there are no conflicts,
              // so its absence means the PR isn't idle-and-mergeable. The exemption covers a
              // trusted Renovate PR as well, which must be left alone anyway: pushing nits to a
              // Renovate branch fights Renovate's own rebases.
              const row = rows.get(pr.number);
              if (!isAwaitingMerge(row)) continue;
              if (isMergeApproved(row)) continue;
              if (await isApprovalExempt(repo.fullName, pr, row)) continue;
              // An auto-bump or image-scan branch is automation-owned: even one held for
              // approval because its diff fails its gate gets no nit commits.
              if (isAutoBumpPR(pr) || isImageScanPR(pr)) continue;
              log.info(`[pr-dispatcher] Advisory-only review for ${repo.fullName}#${pr.number} — addressing nits while it idles awaiting merge`);
              advisoryPRNumbers.add(pr.number);
              reviewAddresserPRNumbers.add(pr.number); // Phase 4: don't re-review this cycle
              await worker.enqueue(AGENT_KINDS.REVIEW_ADDRESSER, repo.fullName, pr.number, {
                priority: gh.hasPriorityLabel(pr.labels),
                args: { advisory: true },
              });
              continue; // NOTE: the PR deliberately stays awaiting merge
            }

            populated.add(pr.number);
            gh.populateQueueCacheFor("needs-review-addressing", repo.fullName, pr, "pr");
            await markPrAwaitingReview(repo.fullName, pr.number);
            // The design's "feedback sends a PR back": the approval columns are
            // left alone, so a merge approval survives the feedback. Only a PR
            // in a pre-merge review stage is demoted; problematic and
            // ci-failing keep the stage their label or CI implies.
            try {
              const row = await db.getClawsPr(repo.fullName, pr.number);
              if (row && FEEDBACK_DEMOTABLE_STAGES.has(row.stage)) {
                await db.upsertClawsPr(repo.fullName, pr.number, { stage: "addressing-review" });
              }
            } catch (err) {
              reportError("pr-dispatcher:pr-store", `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
            }
            reviewAddresserPRNumbers.add(pr.number);
            await worker.enqueue(AGENT_KINDS.REVIEW_ADDRESSER, repo.fullName, pr.number, {
              priority: gh.hasPriorityLabel(pr.labels),
            });
          }
        }

        // ── Phase 4: PR reviewer ──
        // Subset of PRs marked awaiting merge this cycle by the skips below. Phase 6's
        // `rows` snapshot predates this write, so it consults this set too.
        const readyThisCyclePRNumbers = new Set<number>();
        if (!isAgentDisabled("reviewer")) {
          for (const pr of prs) {
            if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
            // A ci-fixer fix/conflict push will replace this head within the cycle —
            // reviewing the pre-push head wastes a review round and can stamp the
            // review with a superseded `Reviewed commit:` SHA (#2667).
            if (ciFixerPRNumbers.has(pr.number)) {
              log.info(`[pr-dispatcher] Skipping pr-reviewer for ${repo.fullName}#${pr.number} — ci-fixer active this cycle`);
              continue;
            }
            if (reviewAddresserPRNumbers.has(pr.number)) {
              log.info(`[pr-dispatcher] Skipping pr-reviewer for ${repo.fullName}#${pr.number} — review-addresser active this cycle`);
              continue;
            }
            // A PR whose current head already carries a clean review is waiting only on
            // a human to merge — a fresh reviewer run here would be work nothing asked
            // for (issue clw_01M3F9340HHVH185YR16PXVKWK).
            const row = rows.get(pr.number);
            if (isReviewedHeadAwaitingMerge(row, pr.headRefOid) && row?.reviewVerdict === "clean") {
              log.info(`[pr-dispatcher] Skipping pr-reviewer for ${repo.fullName}#${pr.number} — clean review of the current head, awaiting merge`);
              continue;
            }
            // An approval-exempt auto-bump PR (own-image bump, image-pin-only diff) is
            // already accepted by the auto-merger without a human review — the model
            // review is pure cost there, since CI is the real gate (issue clw_01M3A3Q2250GM0NRAW0J86YX3T).
            // Exemption already means the diff gate passed; a failing diff is reviewed normally.
            if (isAutoBumpPR(pr) && await isApprovalExempt(repo.fullName, pr, rows.get(pr.number))) {
              log.info(`[pr-dispatcher] Skipping pr-reviewer for ${repo.fullName}#${pr.number} — approval-exempt auto-bump image pin, CI is the gate`);
              if (!isAwaitingMerge(rows.get(pr.number))) {
                const [checkStatus, mergeable] = await Promise.all([
                  gh.getPRCheckStatus(repo.fullName, pr.number),
                  gh.getPRMergeableState(repo.fullName, pr.number),
                ]);
                if (checkStatus === "passing" && mergeable !== "CONFLICTING") {
                  await markPrAwaitingMerge(repo.fullName, pr.number);
                  readyThisCyclePRNumbers.add(pr.number);
                }
              }
              continue;
            }
            // The cheap checks the pr-reviewer handler makes run here too, so a PR
            // with nothing to review costs no agent pod (#clw_01M63KWT4ECG1X4VEHRS2NYHPC).
            if (
              await db.hasActiveWorkForPR(repo.fullName, pr.number, [
                AGENT_KINDS.CI_FIXER,
                AGENT_KINDS.CI_FIXER_CONFLICT,
                AGENT_KINDS.CI_FIXER_PROBLEMATIC,
                AGENT_KINDS.REVIEW_ADDRESSER,
              ])
            ) {
              log.info(`[pr-dispatcher] Skipping pr-reviewer for ${repo.fullName}#${pr.number} — branch-modifying work already running`);
              cycleNotes.set(pr.number, ACTIVE_WORK_NOTE);
              await gh.setDispatchNote(repo.fullName, pr.number, ACTIVE_WORK_NOTE);
              continue;
            }
            // This head must change before the PR can merge; Phase 7 shows the give-up reason.
            if (gh.ciFixerGaveUpOnHead(repo.fullName, pr.number, pr.headRefOid)) {
              log.info(`[pr-dispatcher] Skipping pr-reviewer for ${repo.fullName}#${pr.number} — CI fixer gave up on the current head`);
              continue;
            }
            // A held PR still gets its first review of a head (the operator is told
            // only after a clean review); once that head is reviewed this skip holds it.
            if (
              !(await prReviewer.hasNewCommitsSinceLastReview(repo.fullName, pr.number, pr.headRefOid)) &&
              (await prReviewer.getPendingRebuttal(repo.fullName, pr.number, pr.headRefOid)) === null
            ) {
              log.debug(`[pr-dispatcher] Skipping pr-reviewer for ${repo.fullName}#${pr.number} — no new commits since the last review`);
              const note = hasManualAction(row) ? `${NO_NEW_COMMITS_NOTE} — held: ${row?.manualActionReason}` : NO_NEW_COMMITS_NOTE;
              cycleNotes.set(pr.number, note);
              await gh.setDispatchNote(repo.fullName, pr.number, note);
              if (!isAwaitingMerge(row) && await prReviewer.maybeMarkAwaitingMerge(repo.fullName, pr.number)) {
                readyThisCyclePRNumbers.add(pr.number);
              }
              continue;
            }
            await worker.enqueue(AGENT_KINDS.PR_REVIEWER, repo.fullName, pr.number, {
              priority: gh.hasPriorityLabel(pr.labels),
            });
          }
        }

        // (Phase 5, the periodic merge sweep, is owned by the `auto-merger` scheduler job — #2971.)

        // ── Phase 6: Surface PRs awaiting merge on the dashboard ──
        // PRs awaiting merge that aren't auto-merged need a human to merge them.
        // Add them to the "ready" cache so /prs (src/pages/lists.ts) badges
        // them with their pipeline stage beside the Squash & Merge button.
        for (const pr of prs) {
          if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
          if (gh.isForkPR(pr)) continue;
          if (ciFixerPRNumbers.has(pr.number)) continue;
          // Phase 3 just stepped these back to review — the `rows` snapshot is stale,
          // so trust the in-memory set rather than the row. Advisory rounds
          // are the exception: they stay awaiting merge, so they stay surfaced here.
          if (reviewAddresserPRNumbers.has(pr.number) && !advisoryPRNumbers.has(pr.number)) continue;
          if (!isAwaitingMerge(rows.get(pr.number)) && !readyThisCyclePRNumbers.has(pr.number)) continue;
          populated.add(pr.number);
          gh.populateQueueCacheFor("ready", repo.fullName, pr, "pr");
        }

        // ── Phase 7: every other open PR, categorised from its stage ──
        // No open PR may vanish from the queue: one no phase above populated
        // gets a category from its claws_prs row and, where known, a note
        // saying why no agent acts on it this cycle.
        for (const pr of prs) {
          if (populated.has(pr.number)) continue;
          const row = rows.get(pr.number);
          const category = stageQueueCategory(row?.stage, addressablePRNumbers.has(pr.number));
          if (!category) continue;
          populated.add(pr.number);
          const storedNote = cycleNotes.has(pr.number) ? cycleNotes.get(pr.number) ?? undefined : gh.freshDispatchNote(row);
          const note = dispatchNoteFor(repo, pr, row, ciFixerDisabled, storedNote);
          gh.populateQueueCacheFor(category, repo.fullName, pr, "pr", note);
        }
        ciFixer.pruneIdentifySkipReasons(repo.fullName, new Set(allPRs.map((p) => p.number)));

        // Every category the phases above can populate, so a closed PR's entry is evicted.
        const reconcileCategories: gh.QueueCategory[] = ["problematic", "ready", "ci-failing", "needs-review", "needs-review-addressing"];
        gh.reconcileQueueCache(repo.fullName, reconcileCategories, populated, "pr");
      } catch (err) {
        reportError("pr-dispatcher:list-prs", repo.fullName, err, { repo: repo.fullName });
      }
    }),
  );
  // After every repo's PR store is fresh: release issues parked for a PR that
  // is back in the normal flow (#clw_01M4TJEHAP19S2N3SE6EHE6VNA), and those
  // waiting on PRs that have since merged (#clw_01M4XWHG3A2Q5Y06GN2SC7K06X).
  try {
    await releasePrStallParks();
  } catch (err) {
    reportError("pr-dispatcher:pr-stall-release", "all", err);
  }
  try {
    await releasePrWaitParks();
  } catch (err) {
    reportError("pr-dispatcher:pr-wait-release", "all", err);
  }
}
