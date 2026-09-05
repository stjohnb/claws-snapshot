import { LABELS, SELF_REPO, type Repo, isAgentDisabled } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import * as planParser from "../plan-parser.js";
import { loadPhaseCoverage, PHASE_CLAIM_ONLY_RE } from "../phase-coverage.js";
import * as issueRefiner from "../agents/issue-refiner.js";
import * as escalationReviewer from "../agents/escalation-reviewer.js";
import { extractFingerprint, REPORT_HEADER as CLAWS_ERROR_REPORT_HEADER } from "./triage-claws-errors.js";
import * as worker from "../worker.js";
import { AGENT_KINDS } from "../worker.js";
import * as slack from "../slack.js";
import * as db from "../db.js";
import { ensureAlertIssue, parseOccurrenceCount } from "../occurrence-tracking.js";

// Re-plan once the live occurrence count has at least doubled vs. what the plan
// was based on. With a default of 1, this fires on the first recurrence (1 -> 2),
// then backs off geometrically (2 -> 4, 4 -> 8) so we don't re-plan every bump.
const REPLAN_OCCURRENCE_FACTOR = 2;

async function notifyUntrustedActorSkip(repoFullName: string, issue: gh.Issue): Promise<void> {
  // DB-backed dedup: returns false if we already notified about this repo#issue
  // in a prior run (survives restarts). Gates BOTH the Slack ping and the
  // occurrence-tracking bump, so each distinct blocked item counts once.
  if (!db.markUntrustedActorNotified(repoFullName, issue.number)) return;

  const login = issue.author.login;
  // Untrusted author controls the title — collapse whitespace and truncate.
  const safeTitle = issue.title.replace(/\s+/g, " ").slice(0, 100);
  slack.notify(
    `:no_entry: Claws ignored ${repoFullName}#${issue.number} "${safeTitle}" — author @${login} is not a trusted actor`,
  );

  // File/update a tracked GitHub issue in the Claws self-repo so the operator
  // can grant an allowlist exception. One issue per actor; occurrence count
  // reflects how many items that actor has had blocked. Title MUST stay stable
  // for ensureAlertIssue's title-match dedup.
  const alertTitle = `[disallowed-actor] @${login} is blocked from Claws automation`;
  const alertBody = [
    `Claws skipped a dispatch because issue author **@${login}** is not in the \`allowedActors\` allowlist.`,
    ``,
    `This is usually a missing exception rather than an attack. To allow this`,
    `actor, add \`${login}\` to \`allowedActors\` in the Claws config.`,
    ``,
    `First blocked item: ${repoFullName}#${issue.number}`,
  ].join("\n");

  try {
    await ensureAlertIssue({
      repo: SELF_REPO,
      title: alertTitle,
      body: alertBody,
      logPrefix: "issue-dispatcher",
    });
  } catch (err) {
    // Never let alert-issue filing break the dispatch loop.
    log.warn(`[issue-dispatcher] Failed to file disallowed-actor alert for @${login}: ${String(err)}`);
  }
}

export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(
    repos.map(async (repo) => {
      // Note: all repo callbacks start concurrently, so this check does not prevent
      // other repos from being dispatched — it only short-circuits the current repo's
      // work if rate limiting is already detected when its callback begins executing.
      if (isRateLimited()) return;
      try {
        const allIssues = await gh.listOpenIssues(repo.fullName);
        const selfLogin = await gh.getSelfLoginForRepo(repo.fullName);
        const processedByWorker = new Set<number>();
        const populated = new Set<number>();

        // ── Phase 1: Refined issues → implementer ──
        if (!isAgentDisabled("implementer")) {
          const refinedIssues = allIssues.filter((i) =>
            i.labels.some((l) => l.name === LABELS.refined),
          );
          for (const issue of refinedIssues) {
            if (isRateLimited()) break;
            if (gh.isDispatchSkippable(repo.fullName, issue)) continue;
            if (!await gh.isAllowedActor(issue.author.login, repo.fullName) && !gh.isCiAlertBotAuthor(issue)) {
              log.info(`[issue-dispatcher] Skipping refined issue #${issue.number} from non-allowed actor @${issue.author.login}`);
              await notifyUntrustedActorSkip(repo.fullName, issue);
              continue;
            }

            // A human applied `Refined` while their own comment after the plan is
            // still unaddressed. Implementing now would build the old plan while the
            // issue text says something else (#2763). Strip `Refined`, hand the issue
            // to the planner, and let the human re-apply it against the updated plan.
            const { hasPlan, unreacted } = await issueRefiner.findUnreactedFeedbackAfterPlan(
              repo.fullName, issue.number, selfLogin,
            );
            // A `claws-phase-done:` claim is coverage information for the implementer,
            // not feedback on the plan — exclude it so multi-PR continuations aren't
            // blocked by their own progress-tracking comments.
            const pendingFeedback = unreacted.filter((c) => !PHASE_CLAIM_ONLY_RE.test(c.body));
            if (hasPlan && pendingFeedback.length > 0) {
              await issueRefiner.stripRefinedForPendingFeedback(repo.fullName, issue.number, pendingFeedback, "Planner");
              // Phase 3 must not pick this issue up as a multi-PR continuation this tick.
              processedByWorker.add(issue.number);
              if (!isAgentDisabled("planner")) {
                await gh.removeLabel(repo.fullName, issue.number, LABELS.ready);
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                const openPR = await gh.getOpenPRForIssue(repo.fullName, issue.number);
                worker.enqueue(
                  openPR ? AGENT_KINDS.ISSUE_REFINER_FOLLOWUP : AGENT_KINDS.ISSUE_REFINER_REFINE,
                  repo.fullName, issue.number,
                  { priority: gh.hasPriorityLabel(issue.labels) },
                );
              }
              continue;
            }

            processedByWorker.add(issue.number);
            populated.add(issue.number);
            gh.populateQueueCacheFor("refined", repo.fullName, issue, "issue");
            worker.enqueue(AGENT_KINDS.ISSUE_WORKER, repo.fullName, issue.number, {
              priority: gh.hasPriorityLabel(issue.labels),
            });
          }
        }

        // ── Phase 2: Plan/refine → planner ──
        if (!isAgentDisabled("planner")) {
          for (const issue of allIssues) {
            if (isRateLimited()) break;
            if (gh.isDispatchSkippable(repo.fullName, issue)) continue;
            if (!await gh.isAllowedActor(issue.author.login, repo.fullName) && !gh.isCiAlertBotAuthor(issue)) {
              log.info(`[issue-dispatcher] Skipping planner dispatch for issue #${issue.number} from non-allowed actor @${issue.author.login}`);
              await notifyUntrustedActorSkip(repo.fullName, issue);
              continue;
            }
            if (issue.labels.some((l) => l.name === LABELS.refined)) continue;
            if (issue.labels.some((l) => l.name === LABELS.duplicate)) continue;

            // Check for follow-up comments on issues with an open PR
            const openPR = await gh.getOpenPRForIssue(repo.fullName, issue.number);
            if (openPR) {
              const { hasPlan, unreacted } = await issueRefiner.findUnreactedFeedbackAfterPlan(
                repo.fullName, issue.number, selfLogin,
              );
              if (hasPlan && unreacted.length > 0) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                worker.enqueue(AGENT_KINDS.ISSUE_REFINER_FOLLOWUP, repo.fullName, issue.number, {
                  priority: gh.hasPriorityLabel(issue.labels),
                });
              }
              continue;
            }

            // Triage-before-refinement: skip [claws-error] issues without triage report
            if (extractFingerprint(issue.title) !== null) {
              const comments = await gh.getIssueComments(repo.fullName, issue.number);
              const hasReport = comments.some((c) => c.body.includes(CLAWS_ERROR_REPORT_HEADER));
              if (!hasReport) continue;
            }

            // Fetch comments to determine state
            const { hasPlan, unreacted: unreactedComments, plannedOccurrences, hasEscalationReview, plannedBodyHash } = await issueRefiner.findUnreactedFeedbackAfterPlan(
              repo.fullName, issue.number, selfLogin,
            );

            if (!hasPlan) {
              // No plan comment exists — produce a new plan
              populated.add(issue.number);
              gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
              worker.enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, repo.fullName, issue.number, {
                priority: gh.hasPriorityLabel(issue.labels),
              });
            } else if (unreactedComments.length > 0) {
              // Human feedback needs addressing
              populated.add(issue.number);
              gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
              await gh.removeLabel(repo.fullName, issue.number, LABELS.ready);
              worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REFINE, repo.fullName, issue.number, {
                priority: gh.hasPriorityLabel(issue.labels),
              });
            } else {
              // A Priority monitor alert now has a plan and no outstanding feedback —
              // hand it to the escalation reviewer, which decides whether to auto-apply
              // `Refined` or escalate to a human.
              //
              // This MUST run before the re-plan check below: these alert issues bump
              // their occurrence count on every monitor tick, so the re-plan trigger
              // fires almost immediately and would starve the escalation review forever.
              // Checking here and `continue`ing yields exactly one review per posted plan.
              if (!isAgentDisabled("escalation-reviewer")
                  && !hasEscalationReview
                  && escalationReviewer.isEscalationCandidate(issue, selfLogin)) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("ready", repo.fullName, issue, "issue");
                worker.enqueue(AGENT_KINDS.ESCALATION_REVIEW, repo.fullName, issue.number, { priority: true });
                continue;
              }

              // The issue was edited after its plan was written — the plan no longer
              // describes the issue, so re-plan rather than parking it as "ready" (#2524).
              const syntheticPlanBody = plannedBodyHash !== null
                ? `${issueRefiner.PLAN_BODY_HASH_MARKER} ${plannedBodyHash}`
                : null;
              if (syntheticPlanBody !== null && issueRefiner.isPlanStaleForIssue(syntheticPlanBody, issue.title, issue.body)) {
                // allIssues is 60 s cached — confirm uncached before spending a planner run.
                const live = await gh.getIssueTitleBody(repo.fullName, issue.number).catch(() => null);
                if (live && issueRefiner.isPlanStaleForIssue(syntheticPlanBody, live.title, live.body)) {
                  // Multi-PR continuations are deliberately not gated, mirroring the
                  // implementer's guard in `issue-worker.processIssue`: phase 2+ follows
                  // a plan that was already agreed and partly shipped, so re-planning
                  // mid-way would strand the merged phases — and would race Phase 3
                  // below, which re-applies `Refined` to continue the very same plan.
                  const mergedPRs = await gh.listMergedPRsForIssue(repo.fullName, issue.number);
                  if (mergedPRs.length > 0) {
                    log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number} has a stale plan but ${mergedPRs.length} merged PR(s) — leaving the agreed plan in place`);
                  } else {
                    populated.add(issue.number);
                    gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                    await gh.removeLabel(repo.fullName, issue.number, LABELS.ready);
                    log.info(`[issue-dispatcher] Re-planning ${repo.fullName}#${issue.number}: issue edited since the plan was written`);
                    worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repo.fullName, issue.number, {
                      priority: gh.hasPriorityLabel(issue.labels),
                    });
                    continue;
                  }
                }
              }

              // All feedback addressed. Before parking it as "ready", check whether the
              // issue has recurred enough since the plan was written to warrant a re-plan.
              const currentOcc = parseOccurrenceCount(issue.body);
              // Legacy plans (posted before the marker existed) default to 1 — the count
              // every pre-marker plan implicitly assumed. This backfills existing stale
              // alert issues with one re-plan that then stamps the marker.
              const planned = plannedOccurrences ?? 1;
              if (currentOcc !== null && currentOcc >= planned * REPLAN_OCCURRENCE_FACTOR && currentOcc > planned) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                log.info(`[issue-dispatcher] Re-planning ${repo.fullName}#${issue.number}: occurrences ${currentOcc} >= planned ${planned} * ${REPLAN_OCCURRENCE_FACTOR}`);
                worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repo.fullName, issue.number, {
                  priority: gh.hasPriorityLabel(issue.labels),
                });
              } else {
                populated.add(issue.number);
                gh.populateQueueCacheFor("ready", repo.fullName, issue, "issue");
                if (issueRefiner.isAutoRefineIssue(issue) && !issue.labels.some((l) => l.name === LABELS.refined)) {
                  // Don't hand the implementer an issue whose every plan phase is already
                  // covered: its all-covered guard strips `Refined` in seconds and we re-apply
                  // it on the next tick, relabelling forever (#2821). Same predicate Phase 3
                  // uses below; Phase 3 misses this case because it only runs for
                  // `totalPhases > 1`, and a re-plan that drops `### PR N:` headers is exactly
                  // what collapses the count to 1.
                  const planComments = await gh.getIssueComments(repo.fullName, issue.number);
                  const planText = planParser.findPlanComment(planComments);
                  const totalPhases = planText ? planParser.parsePlan(planText).totalPhases : 1;
                  const mergedPRs = await gh.listMergedPRsForIssue(repo.fullName, issue.number);
                  const coverage = await loadPhaseCoverage(repo.fullName, issue.number, totalPhases, planComments, mergedPRs);
                  if (coverage.nextPhase === null) {
                    log.info(`[issue-dispatcher] Not auto-refining ${repo.fullName}#${issue.number}: all ${totalPhases} plan phase(s) already covered`);
                  } else {
                    await gh.addLabel(repo.fullName, issue.number, LABELS.refined);
                    log.info(`[issue-dispatcher] Auto-refined issue ${repo.fullName}#${issue.number}`);
                  }
                }
              }
            }
          }
        }

        // ── Phase 3: Multi-PR continuations → implementer ──
        if (!isAgentDisabled("implementer")) {
          for (const issue of allIssues) {
            if (processedByWorker.has(issue.number)) continue;
            if (gh.isDispatchSkippable(repo.fullName, issue)) continue;
            if (issue.labels.some((l) => l.name === LABELS.duplicate)) continue;

            const comments = await gh.getIssueComments(repo.fullName, issue.number);
            const planText = planParser.findPlanComment(comments);
            const plan = planText ? planParser.parsePlan(planText) : null;
            const totalPhases = plan?.totalPhases ?? 1;
            if (totalPhases <= 1) continue;

            // Steps shipped out-of-band (a human PR, an interactive session, an
            // explicit claim) count as covered — otherwise the dispatcher keeps
            // re-dispatching the implementer to redo them (#2594). Coverage, not
            // Claws' own merged-PR count, is also what decides whether this issue
            // is mid-flight at all: gating on `listMergedPRsForIssue` stranded any
            // multi-PR plan whose steps had all been shipped from outside Claws.
            const mergedPRs = await gh.listMergedPRsForIssue(repo.fullName, issue.number);
            const coverage = await loadPhaseCoverage(repo.fullName, issue.number, totalPhases, comments, mergedPRs);
            if (coverage.covered.size === 0) continue;
            if (coverage.nextPhase === null) {
              log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: all ${totalPhases} plan phases covered — not continuing`);
              continue;
            }
            if (coverage.pendingPhases.length > 0) {
              log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: phase(s) ${coverage.pendingPhases.join(", ")} have an open, unmerged PR — not continuing to phase ${coverage.nextPhase}`);
              continue;
            }

            worker.enqueue(AGENT_KINDS.ISSUE_WORKER_CONTINUE, repo.fullName, issue.number, {
              priority: gh.hasPriorityLabel(issue.labels),
            });
          }
        }

        if (!isRateLimited()) {
          const reconcileCategories: gh.QueueCategory[] = [];
          if (!isAgentDisabled("implementer")) reconcileCategories.push("refined");
          if (!isAgentDisabled("planner")) reconcileCategories.push("needs-refinement", "ready");
          if (reconcileCategories.length > 0) {
            gh.reconcileQueueCache(repo.fullName, reconcileCategories, populated, "issue");
          }
        }
      } catch (err) {
        reportError("issue-dispatcher:list-issues", repo.fullName, err);
      }
  }),
  );
}
