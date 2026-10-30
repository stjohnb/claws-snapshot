import { canonicalIssueRef, isClawsIssueId, type IssueRef } from "../issue-id.js";
import type { IssueLifecycle } from "../issue-lifecycle.js";
import { atLeast, type ApprovedThrough } from "../issue-approval.js";
import { LABELS, SELF_REPO, issueUrl, type Repo, isAgentDisabled, isJobDisabledForRepo } from "../config.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import * as planParser from "../plan-parser.js";
import { isPhaseClaimOnly } from "../phase-coverage.js";
import { announceAwaitingOperator } from "../awaiting-operator.js";
import { closeIssueIfPlanComplete, issueHasShippedWork, listOpenPhasePRs, loadIssuePhaseState, peekTotalPhases, resolveTrackerId } from "../planned-prs.js";
import * as issueRefiner from "../agents/issue-refiner.js";
import { approvedRequirementsFromBatch, loadApprovedRequirementsForOpenIssues, type ApprovedRequirements, type ApprovedRequirementsResult } from "../approved-requirements.js";
import * as escalationReviewer from "../agents/escalation-reviewer.js";
import * as requirementsWriter from "../agents/requirements-writer.js";
import * as clawsIssues from "../claws-issues.js";
import { withdrawPlanApproval } from "../issue-approval-write.js";
import * as reapproval from "../reapproval.js";
import { extractFingerprint, REPORT_HEADER as CLAWS_ERROR_REPORT_HEADER } from "./triage-claws-errors.js";
import * as issueImporter from "./issue-importer.js";
import * as worker from "../worker.js";
import { AGENT_KINDS } from "../worker.js";
import * as slack from "../slack.js";
import * as db from "../db.js";
import * as issueLinks from "../issue-links.js";
import { issueGateDetails } from "../issue-stage.js";
import { setIssueAwaitingOperatorGates } from "../gate-events.js";
import { releaseDueBacklogIssues } from "../backlog-until.js";
import { isDuplicateToSettle, parkForHuman, returnToPlanReview, settleDuplicate, settleMergedSingleStep } from "../issue-handback.js";
import { ensureAlertIssue, parseOccurrenceCount } from "../occurrence-tracking.js";
import { isAlertBridgeOwned, isAlertIssue, isConsolidatedAlertBody, untriagedAlertSections } from "../alert-issue.js";

// Re-plan once the live occurrence count has at least doubled vs. what the plan
// was based on. With a default of 1, this fires on the first recurrence (1 -> 2),
// then backs off geometrically (2 -> 4, 4 -> 8) so we don't re-plan every bump.
const REPLAN_OCCURRENCE_FACTOR = 2;

async function notifyUntrustedActorSkip(repoFullName: string, issue: gh.Issue): Promise<void> {
  // DB-backed dedup: returns false if we already notified about this repo#issue
  // in a prior run (survives restarts). Gates the occurrence-tracking bump, so
  // each distinct blocked item counts once.
  if (!await db.markUntrustedActorNotified(repoFullName, issue.number)) return;

  const login = issue.author.login;

  // File/update a tracked GitHub issue in the Claws self-repo so the operator
  // can grant an allowlist exception. One issue per actor; occurrence count
  // reflects how many items that actor has had blocked. Title MUST stay stable
  // for ensureAlertIssue's title-match dedup.
  const alertTitle = `[disallowed-actor] @${login} is blocked from Claws automation`;
  const alertBody = [
    `Claws skipped a dispatch because issue author **@${login}** is not in the \`allowedActors\` allowlist.`,
    ``,
    `\`allowedActors\` is the human trust boundary: a login listed there can also`,
    `👍-approve Claws suggestions and plans. Add \`${login}\` only if it is a person.`,
    `If it is a bot or service account, never add it: extend the trusted-automation`,
    `logins in \`src/github.ts\` instead (\`CI_FAILURE_ALERT_BOT_LOGINS\` for GitHub`,
    `Actions, \`FORGEJO_CI_ALERT_BOT_LOGINS\` for Forgejo Actions), or skip the item`,
    `via \`skippedItems\`.`,
    ``,
    `First blocked item: ${repoFullName}#${issue.number}`,
  ].join("\n");

  try {
    const { outcome, issueNumber } = await ensureAlertIssue({
      repo: SELF_REPO,
      title: alertTitle,
      body: alertBody,
      logPrefix: "issue-dispatcher",
    });
    // Slack once per actor, when its alert is first filed; later blocked items
    // only bump the alert's occurrence count.
    if (outcome === "created") {
      void slack.notify(
        `:no_entry: Claws ignored ${repoFullName}#${issue.number} — author @${login} is not a trusted actor. ` +
          `Add \`@${login}\` to \`allowedActors\` in claws.json if a person, otherwise leave it blocked — ${issueUrl(SELF_REPO, issueNumber)}`,
      );
    }
  } catch (err) {
    // Never let alert-issue filing break the dispatch loop.
    log.warn(`[issue-dispatcher] Failed to file disallowed-actor alert for @${login}: ${String(err)}`);
  }
}

/**
 * The implementer gate: true (and logged) when the issue depends on a tracker
 * issue that is still open. Planning is not gated — only implementation.
 */
async function hasOpenDependencies(repoFullName: string, ref: IssueRef): Promise<boolean> {
  const open = await issueLinks.listOpenDependencies(repoFullName, ref);
  if (open.length === 0) return false;
  log.info(`[issue-dispatcher] Not implementing ${repoFullName}#${ref}: depends on open ${open.map((d) => `#${d.id}`).join(", ")}`);
  return true;
}

/**
 * Enqueue the requirements writer for a plan-less issue: a write when it has
 * no record yet, a refine when a human has commented on the record since.
 * `latest` is this tick's batch read, keyed by tracker id; a forge issue with
 * no shadow yet has no record, and the writer mints the shadow. An issue in
 * Ideas gets only this; the planner waits for its promotion (see
 * {@link issueLifecycle}).
 */
async function dispatchRequirementsWriter(
  repoFullName: string,
  issue: gh.Issue,
  latest: Map<string, db.ClawsIssueRequirementsRow>,
): Promise<void> {
  const trackerId = await resolveTrackerId(repoFullName, issue.number);
  const record = trackerId ? latest.get(trackerId) : undefined;
  const priority = gh.hasPriorityLabel(issue.labels);
  if (!record) {
    await worker.enqueue(AGENT_KINDS.REQUIREMENTS_WRITE, repoFullName, issue.number, { priority });
    return;
  }
  const unreacted = await requirementsWriter.unreactedAfterRequirements(
    repoFullName, issue.number, await gh.getSelfLoginForIssue(repoFullName, issue.number),
  );
  if (unreacted && unreacted.length > 0) {
    await worker.enqueue(AGENT_KINDS.REQUIREMENTS_REFINE, repoFullName, issue.number, { priority });
  }
}

/** An issue's tracker id, stored lifecycle and approval. */
interface IssueStage {
  trackerId: string;
  lifecycle: IssueLifecycle;
  approvedThrough: ApprovedThrough;
}

/**
 * The issue's tracker id, stored lifecycle and approval — the only way to
 * tell Ideas from Planning, which carry no label, and an approved issue from
 * one awaiting plan review. A native issue's come with the listing; a forge
 * issue's live on its shadow, minted here when it has none (unless `mint` is
 * false), so a new forge issue starts in Ideas like a native one. Undefined
 * when the read fails, which the caller treats as "not in Ideas" and "not
 * approved": the planner runs as it always did rather than stalling behind a
 * database hiccup, and the implementer waits a tick.
 */
async function issueLifecycle(repoFullName: string, issue: gh.Issue, opts: { mint?: boolean } = {}): Promise<IssueStage | undefined> {
  const nativeId = canonicalIssueRef(issue.number) ?? issue.number;
  if (isClawsIssueId(nativeId)) {
    return issue.lifecycle !== undefined
      ? { trackerId: String(nativeId), lifecycle: issue.lifecycle, approvedThrough: issue.approvedThrough ?? "none" }
      : undefined;
  }
  try {
    const trackerId = await resolveTrackerId(repoFullName, issue.number, opts.mint === false ? undefined : {
      title: issue.title,
      body: issue.body,
      authorLogin: issue.author.login,
      labels: issue.labels.map((l) => l.name),
    });
    if (!trackerId) return undefined;
    const record = await db.getClawsIssue(trackerId);
    return record?.lifecycle ? { trackerId, lifecycle: record.lifecycle, approvedThrough: record.approved_through ?? "none" } : undefined;
  } catch (err) {
    log.warn(`[issue-dispatcher] Could not read the stage of ${repoFullName}#${issue.number}: ${err}`);
    return undefined;
  }
}

/**
 * Whether a PR opened for tracker issue `trackerId` since its current approval
 * was given has since closed without merging: a human rejected the work that
 * approval produced. Phase 1 tells a fresh approval from work under way by
 * step coverage, and a closed PR leaves its step uncovered, so without this
 * the standing approval would open the PR again on every tick. An approval
 * given after the close (a later `plan_approved_at`) dispatches again; a
 * Plan ↔ Merge change does not move that time, so approving or withdrawing
 * Merge never hides the close. Reads the PR store, so a close counts once the
 * PR dispatcher has recorded it. With no Plan approval time there is nothing
 * to date the PR against, and it is false.
 */
export async function prClosedSinceApproval(trackerId: string): Promise<boolean> {
  const record = await db.getClawsIssue(trackerId);
  const approvedAt = record?.plan_approved_at ? Date.parse(clawsIssues.toIso(record.plan_approved_at)) : NaN;
  if (Number.isNaN(approvedAt)) return false;
  const rows = await db.listClawsPrsForIssue(trackerId);
  return rows.some((pr) => pr.stage === "closed" && Date.parse(pr.createdAt) > approvedAt);
}

/**
 * Whether Phase 1 or Phase 3 must not dispatch approved issue
 * `repoFullName#issueNumber` (tracker `trackerId`) this tick because a PR
 * opened under its Plan approval was closed unmerged
 * ({@link prClosedSinceApproval}): a human said no. Withdraws the approval,
 * as the retired Refined label's removal did, so the issue waits in plan
 * review for a fresh one. The check is level-triggered, so a failed withdraw
 * still dispatches nothing, and a failed PR read skips the issue this tick.
 */
async function stopForRejectedApproval(repoFullName: string, issueNumber: gh.Issue["number"], trackerId: string): Promise<boolean> {
  let rejected: boolean;
  try {
    rejected = await prClosedSinceApproval(trackerId);
  } catch (err) {
    log.warn(`[issue-dispatcher] Not implementing ${repoFullName}#${issueNumber} this tick: could not read its PRs: ${err}`);
    return true;
  }
  if (!rejected) return false;
  const result = await withdrawPlanApproval(repoFullName, issueNumber, "issue-dispatcher", {
    reason: "Why: a pull request opened under this approval was closed without merging. Approve the plan through the Plan gate again to have Claws open another.",
  });
  if (result.ok) log.info(`[issue-dispatcher] ${repoFullName}#${issueNumber}: a PR opened under its approval was closed unmerged — withdrew the Plan approval`);
  else log.warn(`[issue-dispatcher] ${repoFullName}#${issueNumber}: a PR opened under its approval was closed unmerged, and the Plan approval could not be withdrawn: ${result.error}`);
  return true;
}

/** Whether the stage is Approved: a posted plan, in Awaiting plan review, approved through Plan. */
function isApprovedForImplementation(stage: IssueStage | undefined): boolean {
  return stage?.lifecycle === "awaiting-plan-review" && atLeast(stage.approvedThrough, "plan");
}

/**
 * Enforce the Planning invariant for a planned issue whose lifecycle is
 * `planning` (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ): it is in Planning only while a
 * planner run is queued or running for it. Otherwise the first that applies:
 *
 * 1. A multi-step plan with any step covered goes back to Awaiting plan
 *    review, where Phase 3 continues it if it is still approved through Plan
 *    and it waits for review otherwise. Phase 3 never continues an issue in
 *    Planning, so leaving it there would strand it.
 * 2. A single-step plan with shipped work is settled — closed when its merged
 *    PR closes the issue, parked for a human otherwise.
 * 3. An alert inbox with an untriaged section is re-planned, whatever its plan hash.
 * 4. A plan stamped with a body hash — still current, since the stale check
 *    above re-plans one that is not — goes back to Awaiting plan review.
 * 5. Anything else is re-planned.
 *
 * The backstop for any writer that moves an issue to Planning without queuing
 * its planner or saying where it goes next. Exported for tests.
 */
export async function settlePlanningIssue(
  repoFullName: string,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  plannedBodyHash: string | null,
  planText: string | null = planParser.findPlanComment(comments),
): Promise<"pending" | "implementing" | "settled" | "continuing" | "review" | "replan"> {
  if (await db.hasPendingIssueRefinerWork(repoFullName, issue.number)) {
    log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: in Planning awaiting its re-plan`);
    return "pending";
  }
  if (await db.hasRunningTask("issue-worker", repoFullName, issue.number)) return "implementing";
  const peek = await peekTotalPhases(repoFullName, issue.number, planText);
  if (peek.totalPhases > 1) {
    const { coverage } = await loadIssuePhaseState(repoFullName, issue.number, comments, { planText, stored: peek.stored });
    if (coverage.covered.size > 0) {
      log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: in Planning mid-plan with no planner queued — returning it to plan review`);
      await returnToPlanReview(repoFullName, issue.number);
      return "continuing";
    }
  } else if (await settleShippedSingleStep(repoFullName, issue.number, comments)) {
    return "settled";
  }
  if (plannedBodyHash !== null && isAlertIssue({ labels: issue.labels.map((l) => l.name), body: issue.body ?? "" })) {
    // A triage plan comment is stamped too, so a section that arrived mid-run (or a run
    // that saved no triage) would otherwise be sent to plan review untriaged.
    const live = await gh.getIssueTitleBody(repoFullName, issue.number).catch(() => null);
    if (live && untriagedAlertSections(live.body).length > 0) {
      log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: alert inbox in Planning with untriaged section(s) — re-planning`);
      await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repoFullName, issue.number, {
        priority: gh.hasPriorityLabel(issue.labels),
      });
      return "replan";
    }
  }
  if (plannedBodyHash !== null) {
    log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: in Planning with a current plan and no planner queued — returning it to plan review`);
    await returnToPlanReview(repoFullName, issue.number);
    return "review";
  }
  log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: in Planning with no planner queued — re-planning`);
  await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repoFullName, issue.number, {
    priority: gh.hasPriorityLabel(issue.labels),
  });
  return "replan";
}

/**
 * Settle an open issue whose single-step plan has shipped work: closed when
 * its merged PR closes the issue (`settleMergedSingleStep`), parked for a
 * human otherwise. False, writing nothing, when nothing has shipped. Shared by
 * the Planning backstop and Phase 1, where an issue approved through Plan
 * stays approved after its step lands.
 */
async function settleShippedSingleStep(repoFullName: string, issueNumber: IssueRef, comments: gh.IssueComment[]): Promise<boolean> {
  if (!await issueHasShippedWork(repoFullName, issueNumber, comments)) return false;
  const merged = await gh.listMergedPRsForIssue(repoFullName, issueNumber);
  if (merged.length > 0) {
    await settleMergedSingleStep(repoFullName, issueNumber, merged);
  } else {
    // Shipped through a stored link in another repo, which the branch list
    // cannot see: there is no PR body to read, so a person decides.
    await parkForHuman(repoFullName, issueNumber,
      `The plan's only step has landed but this issue is still open — close it if the work is done, or re-plan the remainder.`,
      "Planner", { slug: "single-step-landed", comments });
  }
  return true;
}

/**
 * The issues of `issues` whose design change is still pending re-approval
 * after this tick's level-triggered approval check (`reapproval.ts`): a
 * pending change is approved here when its issue was approved through Plan
 * after the change was recorded, or its approved requirements version has
 * reached the pending one. Runs before Phase 1 so a Plan approval given as the
 * approval approves the change before anything reads it as "implement the
 * plan". One batched read; with nothing
 * pending fleet-wide it resolves no tracker ids. An issue whose check fails is
 * reported as pending, so the implementer waits a tick instead.
 */
async function settlePendingReapprovals(repoFullName: string, issues: readonly gh.Issue[]): Promise<Set<IssueRef>> {
  const pending = new Set<IssueRef>();
  let all: Set<string>;
  try {
    all = await db.listPendingReapprovalIssueIds();
  } catch (err) {
    log.warn(`[issue-dispatcher] Could not read pending re-approvals for ${repoFullName} — holding every issue's implementer this tick: ${err}`);
    for (const issue of issues) pending.add(issue.number);
    return pending;
  }
  if (all.size === 0) return pending;
  for (const issue of issues) {
    try {
      const trackerId = await resolveTrackerId(repoFullName, issue.number);
      if (!trackerId || !all.has(trackerId)) continue;
      if (await reapproval.settlePendingReapproval(trackerId)) {
        log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: design change pending re-approval — not implementing`);
        pending.add(issue.number);
      }
    } catch (err) {
      log.warn(`[issue-dispatcher] Re-approval check failed for ${repoFullName}#${issue.number}: ${err}`);
      pending.add(issue.number);
    }
  }
  return pending;
}

export async function run(repos: Repo[]): Promise<void> {
  // Gate state an old-build web pod wrote after the controller's boot
  // migration, during a rollout: the migration's later-run pass, a single
  // `LIMIT 1` probe when there is none, moves it into `approved_through`.
  try {
    await db.migrateGateLabelsToApprovedThrough();
  } catch (err) {
    log.warn(`[issue-dispatcher] Could not sweep leftover gate state into approved_through: ${err}`);
  }
  // One read per tick for every repo's writer dispatch. A failure skips the
  // writer this tick rather than the planner.
  let latestRequirements: Promise<Map<string, db.ClawsIssueRequirementsRow> | null> | null = null;
  const loadLatestRequirements = () => latestRequirements ??= clawsIssues.getLatestRequirementsForOpenIssues().catch((err) => {
    log.warn(`[issue-dispatcher] Could not read requirements versions — skipping the requirements writer this tick: ${err}`);
    return null;
  });
  // One read per tick for every repo's re-plan check below, instead of a
  // `getClawsIssue` + `listClawsIssueRequirements` per issue on every tick. A
  // failed batch read reports every issue's lookup as "error" this tick (see
  // `approvedRequirementsForIssue`) rather than falling back to per-issue reads.
  let approvedRequirementsBatch: Promise<Map<string, ApprovedRequirements> | null> | null = null;
  const loadApprovedRequirementsBatch = () => approvedRequirementsBatch ??= loadApprovedRequirementsForOpenIssues().catch((err) => {
    log.warn(`[issue-dispatcher] Could not batch-read approved requirements — skipping the re-plan check this tick: ${err}`);
    return null;
  });
  const approvedRequirementsForIssue = async (repoFullName: string, issueNumber: IssueRef): Promise<ApprovedRequirementsResult> => {
    const batch = await loadApprovedRequirementsBatch();
    return batch ? approvedRequirementsFromBatch(repoFullName, issueNumber, batch) : { status: "error" };
  };
  await Promise.allSettled(
    repos.map(async (repo) => {
      try {
        const processedByWorker = new Set<IssueRef>();
        const populated = new Set<IssueRef>();

        // ── Unpark issues whose last open dependency has closed (docs/issue-tracker.md#links) ──
        // Before the listing, and never fatal: a sweep failure must not cost
        // the repo its dispatch cycle. Released issues skip Phases 2 and 3 this
        // tick: the sweep already re-planned the ones that need it, and the
        // native listing reads their new lifecycle.
        try {
          for (const id of await issueLinks.releaseDependencyParkedIssues(repo.fullName)) processedByWorker.add(id);
        } catch (err) {
          reportError("issue-dispatcher:release-dependencies", repo.fullName, err, { repo: repo.fullName });
        }

        // ── Bring back issues parked in the Backlog until a date that has passed (docs/issue-tracker.md#backlog) ──
        // Same footing as the dependency sweep: never fatal, and a released
        // issue skips Phases 2 and 3 this tick — its verify run is queued.
        try {
          for (const id of await releaseDueBacklogIssues(repo.fullName)) processedByWorker.add(id);
        } catch (err) {
          reportError("issue-dispatcher:release-backlog", repo.fullName, err, { repo: repo.fullName });
        }

        // ── Import first (docs/jobs/issue-dispatcher.md#import-first) ──
        // A forge issue is imported into the native tracker before any agent
        // acts on it, so this tick works the native copy rather than one about
        // to be closed as "Moved to …". Never fatal: an issue the pass could not
        // import stays held by `isIssueDispatchSkippable` below. The listing
        // that follows is fresh — `closeIssue` invalidates the open-issues cache.
        if (!isJobDisabledForRepo("issue-importer", repo.fullName)) {
          try {
            await issueImporter.importNewIssues(repo);
          } catch (err) {
            reportError("issue-dispatcher:import", repo.fullName, err, { repo: repo.fullName });
          }
        }

        const allIssues = await gh.listOpenIssues(repo.fullName);

        // ── Design changes pending re-approval: approve, or hold the implementer ──
        const reapprovalPending = await settlePendingReapprovals(repo.fullName, allIssues);

        // One stage read per issue per tick, shared by Phases 1 and 2. It
        // never mints a forge shadow: one with none is not approved.
        const stages = new Map<IssueRef, Promise<IssueStage | undefined>>();
        const stageOf = (issue: gh.Issue): Promise<IssueStage | undefined> => {
          let stage = stages.get(issue.number);
          if (!stage) {
            stage = issueLifecycle(repo.fullName, issue, { mint: false });
            stages.set(issue.number, stage);
          }
          return stage;
        };

        // ── Phase 1: issues approved through Plan → implementer, first step ──
        // Approved means a plan in Awaiting plan review approved through Plan.
        // The approval stays after the implementer starts, so this phase must
        // tell a fresh approval from work already under way: only an issue with
        // no step covered and no implementer running is dispatched. Later steps
        // are Phase 3's continuations.
        if (!isAgentDisabled("implementer")) {
          for (const issue of allIssues) {
            if (gh.isIssueDispatchSkippable(repo.fullName, issue)) continue;
            if (reapprovalPending.has(issue.number)) continue;
            if (!isApprovedForImplementation(await stageOf(issue))) continue;
            if (await hasOpenDependencies(repo.fullName, issue.number)) continue;
            if (!await gh.isAllowedActor(issue.author.login, repo.fullName, issue.number) && !gh.isCiAlertBotAuthor(issue, repo.fullName)) {
              if (gh.isDependencyBotAuthor(issue)) {
                log.info(`[issue-dispatcher] Skipping issue #${issue.number} from dependency bot @${issue.author.login}`);
                continue;
              }
              log.info(`[issue-dispatcher] Skipping approved issue #${issue.number} from non-allowed actor @${issue.author.login}`);
              await notifyUntrustedActorSkip(repo.fullName, issue);
              continue;
            }

            // Work already under way: an implementer running (a queued one is
            // deduplicated by the enqueue below), or a step covered — Phase 3
            // continues those, and Phase 2 answers feedback on an open PR.
            if (await db.hasRunningTask("issue-worker", repo.fullName, issue.number)) {
              processedByWorker.add(issue.number);
              continue;
            }
            const comments = await gh.getIssueComments(repo.fullName, issue.number);
            const planText = planParser.findPlanComment(comments);
            if (!planText) continue;
            // Checked before coverage, so feedback on an issue with a step already
            // covered and no open PR (Phase 2 skips those) is answered too. A human
            // approved the plan while their own comment after it is still
            // unaddressed. Implementing now would build the old plan while the
            // issue text says something else (#2763). Withdraw the Plan approval,
            // hand the issue to the planner, and let the human approve again
            // against the updated plan.
            const { hasPlan, unreacted } = await issueRefiner.findUnreactedFeedbackAfterPlan(
              repo.fullName, issue.number, await gh.getSelfLoginForIssue(repo.fullName, issue.number),
            );
            // A `claws-phase-done:` claim is coverage information for the implementer,
            // not feedback on the plan — exclude it so multi-PR continuations aren't
            // blocked by their own progress-tracking comments.
            const pendingFeedback = unreacted.filter((c) => !isPhaseClaimOnly(c.body));
            if (hasPlan && pendingFeedback.length > 0) {
              // Any open step PR, in any of the issue's repos, makes this a
              // follow-up on that PR, which Phase 2 answers; the approval stands.
              if ((await listOpenPhasePRs(repo.fullName, issue.number)).length > 0) continue;
              await issueRefiner.withdrawPlanApprovalForFeedback(repo.fullName, issue.number, pendingFeedback, "Planner");
              // Phase 2 must not re-plan it again, nor Phase 3 continue it, this tick.
              processedByWorker.add(issue.number);
              if (!isAgentDisabled("planner")) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                // Each enqueue is a candidate, not a decision: workers claim by
                // Priority, then stage rank, then age, and re-enqueueing every
                // tick refreshes a queued row's Priority flag from the live label.
                await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REFINE, repo.fullName, issue.number, {
                  priority: gh.hasPriorityLabel(issue.labels),
                });
              }
              continue;
            }

            const phaseState = await loadIssuePhaseState(repo.fullName, issue.number, comments, { planText });
            const { totalPhases, coverage } = phaseState;
            if (coverage.covered.size > 0 || coverage.readyPhases[0] === undefined) {
              // The approval outlives the step: a single step that landed with the
              // issue still open (merged without `Closes`, or in another repo)
              // has no other backstop.
              if (totalPhases <= 1 && coverage.done.size > 0 && await settleShippedSingleStep(repo.fullName, issue.number, comments)) {
                log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: approved, and its only plan step has landed — settled`);
                processedByWorker.add(issue.number);
              } else if (totalPhases > 1 && coverage.covered.size > 0) {
                // Phase 3 reports a multi-step issue that is under way; logging
                // here too would repeat its line every tick.
              } else if (coverage.nextPhase === null) {
                // An open PR's cover is Phase 2's to report, so only a landed one is logged.
                if (coverage.done.size === coverage.covered.size) log.info(`[issue-dispatcher] Not implementing ${repo.fullName}#${issue.number}: all ${totalPhases} plan phase(s) already covered`);
              } else if (coverage.readyPhases.length === 0 && coverage.awaitingOperator.length > 0) {
                log.info(`[issue-dispatcher] Not implementing ${repo.fullName}#${issue.number}: only the operator step ${coverage.awaitingOperator.join(", ")} remains`);
                // No merge or worker task follows, so the dispatcher tells the operator (idempotent).
                await announceAwaitingOperator({ issueRepo: repo.fullName, state: phaseState, comments, planText }, issue.number, "issue-dispatcher", "Dispatcher");
              } else if (coverage.readyPhases.length === 0) {
                log.info(`[issue-dispatcher] Not implementing ${repo.fullName}#${issue.number}: no plan phase is ready — open: ${coverage.openPhases.join(", ") || "none"}, blocked: ${coverage.blockedPhases.join(", ") || "none"}`);
              }
              continue;
            }

            if (await stopForRejectedApproval(repo.fullName, issue.number, (await stageOf(issue))!.trackerId)) {
              processedByWorker.add(issue.number);
              continue;
            }

            processedByWorker.add(issue.number);
            populated.add(issue.number);
            gh.populateQueueCacheFor("refined", repo.fullName, issue, "issue");
            await worker.enqueue(AGENT_KINDS.ISSUE_WORKER, repo.fullName, issue.number, {
              priority: gh.hasPriorityLabel(issue.labels),
            });
          }
        }

        // ── Phase 2: Plan/refine → planner ──
        if (!isAgentDisabled("planner")) {
          for (const issue of allIssues) {
            // Handed on already this tick — including an issue the sweep above
            // just unparked, which it re-planned itself when that was needed.
            if (processedByWorker.has(issue.number)) continue;
            if (gh.isIssueDispatchSkippable(repo.fullName, issue)) continue;
            if (!await gh.isAllowedActor(issue.author.login, repo.fullName, issue.number) && !gh.isCiAlertBotAuthor(issue, repo.fullName)) {
              if (gh.isDependencyBotAuthor(issue)) {
                log.info(`[issue-dispatcher] Skipping issue #${issue.number} from dependency bot @${issue.author.login}`);
                continue;
              }
              log.info(`[issue-dispatcher] Skipping planner dispatch for issue #${issue.number} from non-allowed actor @${issue.author.login}`);
              await notifyUntrustedActorSkip(repo.fullName, issue);
              continue;
            }
            if (issue.labels.some((l) => l.name === LABELS.duplicate)) {
              // A duplicate is closed, not left open in a column that reads as
              // work to do (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ).
              try {
                await settleDuplicate(repo.fullName, issue);
              } catch (err) {
                log.warn(`[issue-dispatcher] Could not close duplicate ${repo.fullName}#${issue.number}: ${err}`);
              }
              continue;
            }

            // Check for follow-up comments on issues with an open PR — any step's,
            // in any of the issue's repos.
            const openPRs = await listOpenPhasePRs(repo.fullName, issue.number);
            if (openPRs.length > 0) {
              // A duplicate verdict is settled whether or not a PR is open.
              const dupComments = await gh.getIssueComments(repo.fullName, issue.number);
              if (isDuplicateToSettle(issue.labels, dupComments)) {
                try {
                  await settleDuplicate(repo.fullName, issue, dupComments);
                } catch (err) {
                  log.warn(`[issue-dispatcher] Could not close duplicate ${repo.fullName}#${issue.number}: ${err}`);
                }
                continue;
              }
              const { hasPlan, unreacted } = await issueRefiner.findUnreactedFeedbackAfterPlan(
                repo.fullName, issue.number, await gh.getSelfLoginForIssue(repo.fullName, issue.number),
              );
              if (hasPlan && unreacted.length > 0) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_FOLLOWUP, repo.fullName, issue.number, {
                  priority: gh.hasPriorityLabel(issue.labels),
                });
              }
              continue;
            }

            // Approved through Plan: the implementer's (Phases 1 and 3) — no
            // re-plan, no refine. Feedback on its open PR is answered above. It
            // stays in the implementer's queue category between steps.
            if (isApprovedForImplementation(await stageOf(issue))) {
              populated.add(issue.number);
              gh.populateQueueCacheFor("refined", repo.fullName, issue, "issue");
              continue;
            }

            // A pending design change's plan is stamped against requirements
            // nobody has approved yet, so it reads as stale: no re-plan, no
            // refine until the operator decides. Follow-ups
            // above still run, and a second design change replaces this one.
            if (reapprovalPending.has(issue.number)) continue;

            // Triage-before-refinement: skip [claws-error] issues without triage report
            if (extractFingerprint(issue.title) !== null) {
              const comments = await gh.getIssueComments(repo.fullName, issue.number);
              const hasReport = comments.some((c) => c.body.includes(CLAWS_ERROR_REPORT_HEADER));
              if (!hasReport) continue;
            }

            // Fetch comments to determine state
            const { hasPlan, unreacted: unreactedComments, plannedOccurrences, hasEscalationReview, plannedBodyHash } = await issueRefiner.findUnreactedFeedbackAfterPlan(
              repo.fullName, issue.number, await gh.getSelfLoginForIssue(repo.fullName, issue.number),
            );

            // The promotion gate (docs/refinements/issue-flow.md "Promotion"):
            // an issue in Ideas gets the requirements writer and never the
            // planner. A forge issue that already has a plan is past Ideas
            // whatever its shadow says — shadows predate the requirements
            // stage, and the boot migration could not see forge plan comments.
            const native = isClawsIssueId(canonicalIssueRef(issue.number) ?? issue.number);
            // A forge issue with a plan reads its shadow only for the Planning
            // backstop below, never minting one.
            const gated = native || !hasPlan;
            const stage = gated ? await issueLifecycle(repo.fullName, issue) : await stageOf(issue);
            const inIdeas = gated && stage?.lifecycle === "ideas";
            const writerDisabled = isAgentDisabled("requirements-writer");
            // An alert issue is triaged, not specified: it never gets a
            // requirements record (write or comment-triggered refine), so its
            // title stays the bridge's and the inbox stays the inbox
            // (#clw_01M61M73EW1AMEZPD9V06YW18X). It promotes with none.
            const alert = isAlertIssue({ labels: issue.labels.map((l) => l.name), body: issue.body ?? "" });
            // Only a hand-filed issue goes through the requirements stage by
            // default; one filed by an automation, agent or session (or a
            // hand-filed one whose author skipped it) plans from its text,
            // with no record written or refined, and promotes with none.
            let stageOff = false;
            if (stage && (!hasPlan || inIdeas)) {
              try {
                stageOff = !(await clawsIssues.requirementsStageOn(stage.trackerId));
              } catch (err) {
                // A failed read degrades to the stage being on.
                log.warn(`[issue-dispatcher] Requirements-stage read failed for ${repo.fullName}#${issue.number}: ${err}`);
              }
            }
            const skipWriter = writerDisabled || alert || stageOff;

            if ((!hasPlan || inIdeas) && !skipWriter) {
              const latest = await loadLatestRequirements();
              if (latest) {
                try {
                  await dispatchRequirementsWriter(repo.fullName, issue, latest);
                } catch (err) {
                  log.warn(`[issue-dispatcher] Requirements writer dispatch failed for ${repo.fullName}#${issue.number}: ${err}`);
                }
              }
            }
            if (inIdeas && stage) {
              // Level-triggered promotion: an issue can sit here with an
              // unpromoted requirements version already on record — written
              // before an auto-promote listener existed, or by a writer run
              // that predates this deploy — so promoting only on the version
              // write leaves it stuck. With the writer disabled outright no
              // version will ever land, so this checks every tick instead,
              // and treats "no version, and none is coming" as ready too; so
              // does an alert issue or one that skips the requirements stage,
              // neither of which ever gets one.
              try {
                const requirementsReady = skipWriter || !!(await loadLatestRequirements())?.get(stage.trackerId);
                await clawsIssues.autoPromoteIfDue(stage.trackerId, requirementsReady);
              } catch (err) {
                log.warn(`[issue-dispatcher] Auto-promotion check failed for ${repo.fullName}#${issue.number}: ${err}`);
              }
              continue;
            }

            if (!hasPlan) {
              // No plan comment exists — produce a new plan
              populated.add(issue.number);
              gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
              await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, repo.fullName, issue.number, {
                priority: gh.hasPriorityLabel(issue.labels),
              });
            } else if (unreactedComments.length > 0) {
              // Human feedback needs addressing: out of plan review while the
              // planner answers it.
              populated.add(issue.number);
              gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
              if (stage?.lifecycle === "awaiting-plan-review") await gh.setIssueLifecycle(repo.fullName, issue.number, "planning");
              await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REFINE, repo.fullName, issue.number, {
                priority: gh.hasPriorityLabel(issue.labels),
              });
            } else {
              // A plan that is a `CLAWS_DUPLICATE_OF:` verdict, without the
              // label (removed by hand, or never applied): close it rather than
              // offer the pointer for approval.
              const planComments = await gh.getIssueComments(repo.fullName, issue.number);
              const planText = planParser.findPlanComment(planComments);
              if (isDuplicateToSettle(issue.labels, planComments, planText)) {
                try {
                  await settleDuplicate(repo.fullName, issue, planComments);
                } catch (err) {
                  log.warn(`[issue-dispatcher] Could not close duplicate ${repo.fullName}#${issue.number}: ${err}`);
                }
                continue;
              }

              // A Priority monitor alert now has a plan and no outstanding feedback —
              // hand it to the escalation reviewer, which decides whether to approve it
              // through Plan or escalate to a human.
              //
              // This MUST run before the re-plan check below: these alert issues bump
              // their occurrence count on every monitor tick, so the re-plan trigger
              // fires almost immediately and would starve the escalation review forever.
              // Checking here and `continue`ing yields exactly one review per posted plan.
              if (!isAgentDisabled("escalation-reviewer")
                  && !hasEscalationReview
                  && escalationReviewer.isEscalationCandidate(issue, await gh.getSelfLoginForIssue(repo.fullName, issue.number))) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("ready", repo.fullName, issue, "issue");
                await worker.enqueue(AGENT_KINDS.ESCALATION_REVIEW, repo.fullName, issue.number, { priority: true });
                continue;
              }

              // The issue, or its approved requirements record, changed after its plan
              // was written — the plan no longer describes the issue, so re-plan rather
              // than parking it as "ready" (#2524).
              const syntheticPlanBody = plannedBodyHash !== null
                ? `${issueRefiner.PLAN_BODY_HASH_MARKER} ${plannedBodyHash}`
                : null;
              const approvedRequirementsResult = syntheticPlanBody !== null
                ? await approvedRequirementsForIssue(repo.fullName, issue.number)
                : null;
              // A failed read is reported as "error", never folded into "no record" —
              // treating it as such would compare against a body-only hash and could
              // find a record-stamped plan falsely stale, re-planning it for no
              // reason. Skip the whole re-plan check for this tick instead.
              const approvedRequirements = approvedRequirementsResult?.status === "approved" ? approvedRequirementsResult.record : null;
              const requirementsReadFailed = approvedRequirementsResult?.status === "error";
              if (!requirementsReadFailed && syntheticPlanBody !== null && issueRefiner.isPlanStaleForIssue(syntheticPlanBody, issue.title, issue.body, approvedRequirements)) {
                // allIssues is 60 s cached — confirm uncached before spending a planner run.
                const live = await gh.getIssueTitleBody(repo.fullName, issue.number).catch(() => null);
                // A consolidated alert body's hash already ignores the bridge's volatile
                // fields, so a stale hash there means a new/removed alert section or a
                // human edit — re-plan it (#clw_01M4ZN75K7GK0G7AFZEHBNCWD5).
                // A triaged inbox is parked Blocked and never reaches this check: a
                // new untriaged section re-plans it from the bridge's PATCH handler
                // (`updateBridgeIssueHandler` in alert-bridge.ts), and the re-plan
                // triages it rather than planning (`settleAlertTriage` in the refiner).
                const liveConsolidated = live !== null && isConsolidatedAlertBody(live.body);
                if (live && !liveConsolidated && isAlertBridgeOwned({ labels: issue.labels.map((l) => l.name), body: live.body })) {
                  // Shadow sync forwards the alert bridge's body rewrites onto the
                  // native issue; those must not re-plan it (#clw_01M4T6HH3E79290WGDB4E7JY1B).
                  log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number} has a stale plan hash from an alert-bridge edit — not re-planning`);
                } else if (live && issueRefiner.isPlanStaleForIssue(syntheticPlanBody, live.title, live.body, approvedRequirements)) {
                  // Multi-PR continuations are deliberately not gated, mirroring the
                  // implementer's guard in `issue-worker.processIssue`: phase 2+ follows
                  // a plan that was already agreed and partly shipped, so re-planning
                  // mid-way would strand the merged phases — and would race Phase 3
                  // below, which continues the very same plan.
                  // A consolidated alert issue is the exception: a new alert section is
                  // new work, and the re-plan keeps shipped steps as shipped.
                  if (!liveConsolidated && await issueHasShippedWork(repo.fullName, issue.number)) {
                    log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number} has a stale plan but merged PR(s) — leaving the agreed plan in place`);
                  } else {
                    populated.add(issue.number);
                    gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                    if (stage?.lifecycle === "awaiting-plan-review") await gh.setIssueLifecycle(repo.fullName, issue.number, "planning");
                    log.info(liveConsolidated
                      ? `[issue-dispatcher] ${repo.fullName}#${issue.number}: consolidated alert issue content changed — re-planning`
                      : `[issue-dispatcher] Re-planning ${repo.fullName}#${issue.number}: issue or approved requirements changed since the plan was written`);
                    await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repo.fullName, issue.number, {
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
              // A consolidated alert body's trailing total sums every section's count,
              // so it doubles on bridge flaps alone; its hash check above covers it.
              if (currentOcc !== null && currentOcc >= planned * REPLAN_OCCURRENCE_FACTOR && currentOcc > planned
                  && !isConsolidatedAlertBody(issue.body)) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                log.info(`[issue-dispatcher] Re-planning ${repo.fullName}#${issue.number}: occurrences ${currentOcc} >= planned ${planned} * ${REPLAN_OCCURRENCE_FACTOR}`);
                await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repo.fullName, issue.number, {
                  priority: gh.hasPriorityLabel(issue.labels),
                });
              } else if (stage?.lifecycle === "planning") {
                // Planned, and still in Planning. Planning means "the
                // planner is queued or running", so make that true or move the
                // issue on — never park it here silently.
                populated.add(issue.number);
                if (requirementsReadFailed) {
                  gh.populateQueueCacheFor("ready", repo.fullName, issue, "issue");
                  log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: in Planning, approved requirements unreadable this tick — leaving it`);
                } else {
                  try {
                    const outcome = await settlePlanningIssue(repo.fullName, issue, planComments, plannedBodyHash, planText);
                    gh.populateQueueCacheFor(outcome === "replan" || outcome === "pending" ? "needs-refinement" : "ready", repo.fullName, issue, "issue");
                  } catch (err) {
                    log.warn(`[issue-dispatcher] Could not settle Planning issue ${repo.fullName}#${issue.number}: ${err}`);
                  }
                }
              } else {
                populated.add(issue.number);
                gh.populateQueueCacheFor("ready", repo.fullName, issue, "issue");
              }
            }
          }
        }

        // ── Phase 3: Multi-PR continuations → implementer ──
        if (!isAgentDisabled("implementer")) {
          for (const issue of allIssues) {
            if (processedByWorker.has(issue.number)) continue;
            if (gh.isIssueDispatchSkippable(repo.fullName, issue)) continue;
            if (reapprovalPending.has(issue.number)) continue;
            if (await hasOpenDependencies(repo.fullName, issue.number)) continue;
            if (issue.labels.some((l) => l.name === LABELS.duplicate)) continue;
            // Planner work in flight (a Backlog return's verify run, a re-plan)
            // may still revise the plan; continuing now would race it.
            if (await db.hasPendingIssueRefinerWork(repo.fullName, issue.number)) continue;

            const comments = await gh.getIssueComments(repo.fullName, issue.number);
            const planText = planParser.findPlanComment(comments);
            const peek = await peekTotalPhases(repo.fullName, issue.number, planText);
            if (peek.totalPhases <= 1) continue;

            // The stored PR list when there is one, the plan's `### PR N:` headers
            // otherwise. Steps shipped out-of-band (a human PR, an interactive session, an
            // explicit claim) count as covered — otherwise the dispatcher keeps
            // re-dispatching the implementer to redo them (#2594). Coverage, not
            // Claws' own merged-PR count, is also what decides whether this issue
            // is mid-flight at all: gating on `listMergedPRsForIssue` stranded any
            // multi-PR plan whose steps had all been shipped from outside Claws.
            const phaseState = await loadIssuePhaseState(repo.fullName, issue.number, comments, { planText, stored: peek.stored });
            const { totalPhases, coverage } = phaseState;
            if (coverage.covered.size === 0) continue;
            if (coverage.nextPhase === null) {
              // Every step has landed — typically an operator's
              // `claws-phase-done:` on the plan's manual step, which no merge
              // follows to close the issue.
              if (coverage.done.size >= totalPhases) {
                await closeIssueIfPlanComplete(repo.fullName, issue.number, phaseState, { source: "issue-dispatcher" });
              } else {
                log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: all ${totalPhases} plan phases covered — not continuing`);
              }
              continue;
            }
            if (coverage.readyPhases.length === 0 && coverage.awaitingOperator.length > 0) {
              log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: awaiting the operator on step ${coverage.awaitingOperator.join(", ")} — not continuing`);
              await announceAwaitingOperator({ issueRepo: repo.fullName, state: phaseState, comments, planText }, issue.number, "issue-dispatcher", "Dispatcher");
              continue;
            }
            // A step whose dependencies have all landed can start while sibling
            // steps' PRs are still open; a plan that declares nothing waits for
            // the previous step, as before.
            if (coverage.readyPhases.length === 0) {
              log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: no plan phase is ready — open: ${coverage.openPhases.join(", ") || "none"}, blocked: ${coverage.blockedPhases.join(", ") || "none"}`);
              continue;
            }
            // The handler continues only an approved issue; one whose approval was
            // withdrawn would enqueue a row that does nothing, every tick.
            const stage = await stageOf(issue);
            if (!isApprovedForImplementation(stage)) continue;
            if (await stopForRejectedApproval(repo.fullName, issue.number, stage!.trackerId)) continue;

            await worker.enqueue(AGENT_KINDS.ISSUE_WORKER_CONTINUE, repo.fullName, issue.number, {
              priority: gh.hasPriorityLabel(issue.labels),
            });
          }
        }

        const reconcileCategories: gh.QueueCategory[] = [];
        if (!isAgentDisabled("implementer")) reconcileCategories.push("refined");
        if (!isAgentDisabled("planner")) reconcileCategories.push("needs-refinement", "ready");
        if (reconcileCategories.length > 0) {
          gh.reconcileQueueCache(repo.fullName, reconcileCategories, populated, "issue");
        }
      } catch (err) {
        reportError("issue-dispatcher:list-issues", repo.fullName, err, { repo: repo.fullName });
      }
  }),
  );
  await sweepIssueAwaitingOperatorGates(repos);
}

/**
 * Set the `issue-awaiting-operator` gates (src/gate-events.ts) of every open
 * native issue naming one of `repos`, in each repo it names, once per tick —
 * so a waiter hears once when an issue reaches requirements review, plan
 * review or a manual step. Shadows are skipped: `listOpenClawsIssues` never
 * returns one. Best-effort: a failure costs this tick's gate events, never
 * the dispatch.
 */
async function sweepIssueAwaitingOperatorGates(repos: Repo[]): Promise<void> {
  try {
    const names = new Set(repos.map((r) => r.fullName));
    const records = (await db.listOpenClawsIssues()).filter((r) => r.repos.some((repo) => names.has(repo)));
    if (records.length === 0) return;
    const details = await issueGateDetails(records);
    for (const record of records) {
      const detail = details.get(record.id) ?? null;
      for (const repo of record.repos) await setIssueAwaitingOperatorGates(repo, record.id, detail);
    }
  } catch (err) {
    log.warn(`[issue-dispatcher] Could not sweep the issue-awaiting-operator gates: ${err}`);
  }
}
