import { LABELS, type Repo, isAgentDisabled, isJobDisabledForRepo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited, isRepoRateLimited, describeRateLimit, RateLimitError } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { ShutdownError } from "../shutdown.js";
import * as ciFixer from "../agents/ci-fixer.js";
import { finalizeMergedClawsPR, isApprovalExempt, isAutoBumpPR, checkAutoBumpDiff } from "../agents/auto-merger.js";
import * as worker from "../worker.js";
import { AGENT_KINDS } from "../worker.js";
import * as db from "../db.js";
import { sweepSupersededDependabotPRs } from "./superseded-dependabot-sweep.js";
import { FORGE_LABEL_APPROVER, forgeApprover, isAwaitingMerge, isMergeApproved, isProblematic, isReviewedHeadAwaitingMerge } from "../pr-state.js";
import { describeUpdateWindow, isThirdPartyUpdateDeferred } from "../update-window.js";
import { approveHeldRuns, canClearActionRequiredHold, heldRunCount, observeHeldRuns, pruneHeldRunCounts } from "../workflow-hold.js";

const EMPTY_PR_MIN_AGE_MS = 10 * 60 * 1000;

/** Stages review feedback demotes to `addressing-review` (the Ready hook has already moved awaiting-merge on). */
const FEEDBACK_DEMOTABLE_STAGES: ReadonlySet<string> = new Set(["awaiting-merge", "awaiting-review", "opened"]);

/** Auto-bump structural-gate verdicts, keyed on `${repo}#${number}@${headRefOid}` so a force-push
 * naturally invalidates the cached verdict. Capped and evicted oldest-first (insertion order). */
const AUTO_BUMP_GATE_CACHE_MAX = 500;
const autoBumpGateCache = new Map<string, Awaited<ReturnType<typeof checkAutoBumpDiff>>>();

/** `checkAutoBumpDiff`, cached per head SHA so the reviewer phase's two API reads
 * happen once per head rather than every dispatch tick. A PR with no `headRefOid`
 * (Forgejo does not always report one) is never cached — checked fresh each time. */
async function getAutoBumpGateVerdict(repo: Repo, pr: gh.PR): Promise<Awaited<ReturnType<typeof checkAutoBumpDiff>>> {
  if (!pr.headRefOid) return checkAutoBumpDiff(repo.fullName, pr.number);
  const key = `${repo.fullName}#${pr.number}@${pr.headRefOid}`;
  const cached = autoBumpGateCache.get(key);
  if (cached) return cached;
  const verdict = await checkAutoBumpDiff(repo.fullName, pr.number);
  autoBumpGateCache.set(key, verdict);
  if (autoBumpGateCache.size > AUTO_BUMP_GATE_CACHE_MAX) {
    const oldest = autoBumpGateCache.keys().next().value;
    if (oldest !== undefined) autoBumpGateCache.delete(oldest);
  }
  return verdict;
}

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
 * existing PR's branch — so anything that slips through gets `Manual Action` (which
 * blocks auto-merger) and one explanatory comment, deduped by STACKED_PR_MARKER.
 * The base is deliberately not auto-retargeted: that reproduces the giant-diff
 * problem this sweep exists to catch.
 */
export async function sweepStackedPRs(repo: Repo, prs: gh.PR[]): Promise<void> {
  for (const pr of prs) {
    try {
      if (pr.baseRefName === repo.defaultBranch) continue;
      if (!pr.headRefName.startsWith("claws/")) continue;   // never touch human stacks
      if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
      if (gh.isForkPR(pr)) continue;
      const comments = await gh.getIssueComments(repo.fullName, pr.number).catch(() => []);
      if (comments.some((c) => c.body.includes(STACKED_PR_MARKER))) continue;
      await gh.commentOnIssue(repo.fullName, pr.number, [
        `### Stacked PR`,
        ``,
        `This PR targets \`${pr.baseRefName}\` rather than \`${repo.defaultBranch}\`. Claws does not stack PRs — a change either targets the default branch or is committed onto the existing PR's branch. Labelled \`${LABELS.manualAction}\` so it is not auto-merged; a human should either retarget it to \`${repo.defaultBranch}\` or fold its commits into the PR it is stacked on and close it.`,
        ``,
        STACKED_PR_MARKER,
      ].join("\n"), { agentName: "PR Dispatcher" });
      await gh.addLabel(repo.fullName, pr.number, LABELS.manualAction);
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
 * {@link FORGE_LABEL_APPROVER} gets the one-time cutover import: rewritten to
 * whoever last applied `Automerge` on the forge, or cleared when nobody did.
 * Rows still open in the store whose PR has left the open list are marked
 * `merged`/`closed`; a merged row linked to an issue then gets the
 * post-merge cleanup (`finalizeMergedClawsPR`), which closes a native issue
 * a hand-merged PR names. A row that still records a manual action whose
 * `Manual Action` label was removed on the forge gets the label restored: a
 * forge label edit never clears the record, so the forge must not show the
 * PR as unblocked while the record still blocks the merge. `held` (GitHub
 * `action_required`) moves no stage: it is neither a failure nor a pass.
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
        if (row.mergeApprovedBy === FORGE_LABEL_APPROVER) await importForgeAutomerge(repo, pr.number, patch);
      }
      await db.upsertClawsPr(repo.fullName, pr.number, patch);
      if (row) await restoreManualActionLabel(repo, pr, row);
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

/** How long a head SHA found with no held runs is trusted before it is listed again. */
const HELD_RUNS_RECHECK_MS = 10 * 60 * 1000;

/**
 * `repo@headSha` → when its workflow runs were last listed and none was left
 * held, so an open PR costs one `actions/runs?head_sha=` call per head (per
 * {@link HELD_RUNS_RECHECK_MS}) rather than one per tick. A head with a
 * recorded hold ({@link heldRunCount}) is never skipped: held heads are rare,
 * and re-listing them each tick drops the record as soon as a human approves
 * the runs. {@link approveHeldRuns}'s own `rejectedRuns` memory stops a
 * rejected approval from being retried on those re-listings.
 */
const headsListedRecently = new Map<string, number>();

/** Test hook: forget every head checked for held runs. */
export function resetHeldRunChecksForTests(): void {
  headsListedRecently.clear();
}

/**
 * Observe GitHub's `action_required` hold on every open GitHub PR, and approve
 * it on every eligible one ({@link canClearActionRequiredHold}): one API call
 * per run and no work worker, so it runs before the out-of-hours gate.
 * Ineligible held PRs are left for a human and shown as held for approval.
 *
 * The Actions API, not the check rollup, decides whether a PR is held: a
 * held run starts no jobs, so it may add nothing to `statusCheckRollup`. Every
 * PR whose rollup is not `failing` — forks and untrusted authors included —
 * has its head's runs listed and the held count recorded, which is what `/prs`
 * reads. A head found with none held is skipped until it changes, the recheck
 * interval passes, or the rollup reports `held`.
 */
export async function clearActionRequiredHolds(
  repo: Repo,
  prs: gh.PR[],
  statuses: Map<number, gh.PRRepoStatus>,
): Promise<void> {
  // GitHub Actions only: a Forgejo repo's runs cannot be held or approved here.
  if (repo.forge === "forgejo") return;
  const now = Date.now();
  const heads = new Set<string>();
  const liveShas = new Set<string>();
  for (const pr of prs) {
    if (pr.headRefOid) liveShas.add(pr.headRefOid);
    const checkStatus = statuses.get(pr.number)?.checkStatus;
    if (checkStatus === "failing") continue;
    // With no head SHA there is nothing to list; observeHeldRuns warns only for a known hold.
    if (!pr.headRefOid && checkStatus !== "held") continue;
    const key = `${repo.fullName}@${pr.headRefOid ?? ""}`;
    heads.add(key);
    try {
      const checkedAt = headsListedRecently.get(key);
      const recordedHold = pr.headRefOid ? heldRunCount(repo.fullName, pr.headRefOid) : undefined;
      if (checkStatus !== "held" && recordedHold === undefined && checkedAt !== undefined && now - checkedAt < HELD_RUNS_RECHECK_MS) continue;
      const runs = await observeHeldRuns(repo, pr);
      if (runs === null) continue;
      if (runs.length === 0) {
        headsListedRecently.set(key, now);
        continue;
      }
      headsListedRecently.delete(key);
      if (!gh.isDispatchSkippable(repo.fullName, pr) && (await canClearActionRequiredHold(repo.fullName, pr))) {
        await approveHeldRuns(repo, pr, runs);
      }
    } catch (err) {
      reportError("pr-dispatcher:clear-hold", `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
    }
  }
  for (const key of headsListedRecently.keys()) {
    if (key.startsWith(`${repo.fullName}@`) && !heads.has(key)) headsListedRecently.delete(key);
  }
  pruneHeldRunCounts(repo.fullName, liveShas);
}

/**
 * Re-applies `Manual Action` to a PR whose row still records a manual action
 * but whose live labels lack it (removed on the forge, not through Claws).
 * The row is never cleared from the forge label. Re-reads the record
 * immediately before writing, since the `rows` snapshot `refreshPrStore` loops
 * over is taken once at the start of the tick and a clear (dashboard click or
 * `claws_clear_pr_manual_action`) landing mid-tick must not be reverted by a
 * stale reason. A label write failure is logged, not reported, so a
 * persistent forge error does not alert every tick.
 */
async function restoreManualActionLabel(repo: Repo, pr: gh.PR, row: db.ClawsPrRecord): Promise<void> {
  if (row.manualActionReason === null) return;
  if (pr.labels.some((l) => l.name === LABELS.manualAction)) return;
  if (gh.isDispatchSkippable(repo.fullName, pr)) return;
  const current = await db.getClawsPr(repo.fullName, pr.number);
  if (!current || current.manualActionReason === null) return;
  try {
    await gh.addLabel(repo.fullName, pr.number, LABELS.manualAction);
    log.info(`[pr-dispatcher] pr-store: restored ${LABELS.manualAction} on ${repo.fullName}#${pr.number} — removed on the forge but the row still records "${current.manualActionReason}"`);
  } catch (err) {
    log.warn(`[pr-dispatcher] pr-store: could not restore ${LABELS.manualAction} on ${repo.fullName}#${pr.number}: ${err}`);
  }
}

/**
 * The one-time cutover import of a forge-applied `Automerge` (phase 5): a row
 * phases 1–4 approved as {@link FORGE_LABEL_APPROVER} is attributed to whoever
 * last applied the label, or has its approval cleared when no `labeled` event
 * is found. Once rewritten the row never matches again, so a forge label
 * applied later is never honoured. On a read error the row is left for the
 * next tick; the merge gate rejects the legacy marker meanwhile.
 */
async function importForgeAutomerge(repo: Repo, prNumber: number, patch: db.ClawsPrPatch): Promise<void> {
  let login: string | null;
  try {
    login = await gh.getLabelApplier(repo.fullName, prNumber, LABELS.automerge);
  } catch (err) {
    reportError("pr-dispatcher:pr-store-import", `${repo.fullName}#${prNumber}`, err, { repo: repo.fullName });
    return;
  }
  if (login) {
    patch.mergeApprovedBy = forgeApprover(login);
    log.info(`[pr-dispatcher] pr-store: imported forge Automerge on ${repo.fullName}#${prNumber} by ${login}`);
  } else {
    patch.mergeApprovedBy = null;
    patch.mergeApprovedAt = null;
    log.info(`[pr-dispatcher] pr-store: forge Automerge on ${repo.fullName}#${prNumber} dropped (no labeled event)`);
  }
}

export async function run(repos: Repo[]): Promise<void> {
  // The breaker is GitHub-only, so skip GitHub repos and let Forgejo ones
  // dispatch normally — their reads never touch GitHub's budget (#3221).
  let active = repos;
  if (isRateLimited()) {
    active = repos.filter((r) => !isRepoRateLimited(r.fullName));
    const skipped = repos.length - active.length;
    if (skipped > 0) {
      log.warn(`[pr-dispatcher] Skipping ${skipped} GitHub repo(s) — API rate limited ${describeRateLimit()}`);
    }
    if (active.length === 0) return;
  }
  await Promise.allSettled(
    active.map(async (repo) => {
      // Note: all repo callbacks start concurrently, so this check does not prevent
      // other repos from being dispatched — it only short-circuits the current repo's
      // work if rate limiting is already detected when its callback begins executing.
      if (isRepoRateLimited(repo.fullName)) return;
      const ciFixerDisabled =
        isAgentDisabled("ci-fixer") || isJobDisabledForRepo("ci-fixer", repo.fullName);
      const populated = new Set<number>();
      try {
        // Always a fresh read, so the store refresh sees every open PR.
        gh.invalidatePRList(repo.fullName);
        const allPRs = await gh.listPRs(repo.fullName);

        // ── Phase 0a: PR store refresh ──
        // Before the sweeps below: every open PR needs its row before any
        // phase writes a state label (sweepStackedPRs adds Manual Action).
        let statuses = new Map<number, gh.PRRepoStatus>();
        try {
          statuses = await refreshPrStore(repo, allPRs);
        } catch (err) {
          reportError("pr-dispatcher:pr-store", repo.fullName, err, { repo: repo.fullName });
        }

        // ── Held workflow runs: approve GitHub's action_required hold on trusted update PRs ──
        await clearActionRequiredHolds(repo, allPRs, statuses);
        // PR state is read from the rows, loaded once after the refresh. Writes
        // later this tick are tracked in the in-memory sets below.
        const rows = new Map((await db.listClawsPrs(repo.fullName)).map((r) => [r.prNumber, r]));
        const emptyClosed =
          isAgentDisabled("empty-pr-closer") || isJobDisabledForRepo("empty-pr-closer", repo.fullName)
            ? new Set<number>()
            : await sweepEmptyPRs(repo, allPRs);
        let prs = emptyClosed.size ? allPRs.filter((p) => !emptyClosed.has(p.number)) : allPRs;

        const supersededClosed =
          isAgentDisabled("superseded-pr-closer") ||
          isJobDisabledForRepo("superseded-pr-closer", repo.fullName)
            ? new Set<number>()
            : await sweepSupersededDependabotPRs(repo, prs);
        if (supersededClosed.size) prs = prs.filter((p) => !supersededClosed.has(p.number));

        if (!isAgentDisabled("stacked-pr-flagger") && !isJobDisabledForRepo("stacked-pr-flagger", repo.fullName)) {
          await sweepStackedPRs(repo, prs).catch((err) => reportError("pr-dispatcher:stacked-sweep", repo.fullName, err, { repo: repo.fullName }));
        }

        // ── Out-of-hours gate: third-party update PRs get no work outside the window ──
        // Dropped from `prs` here so no later phase enqueues ci-fixer, review-addresser
        // or pr-reviewer work for them; the sweeps above still ran over them.
        const deferred = new Set<number>();
        for (const pr of prs) {
          if (!isThirdPartyUpdateDeferred(repo.fullName, pr)) continue;
          log.info(`[pr-dispatcher] deferred ${repo.fullName}#${pr.number} until the out-of-hours window (${describeUpdateWindow()})`);
          deferred.add(pr.number);
          populated.add(pr.number);
          gh.populateQueueCacheFor("waiting-for-window", repo.fullName, pr, "pr");
        }
        if (deferred.size) prs = prs.filter((p) => !deferred.has(p.number));

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

        // ── Phase 0b: clear stale not-rerunnable Manual Action ──
        // A PR whose CI went green after Claws stopped retrying an un-rerunnable run
        // keeps the label that blocks auto-merger unless something removes it (#2462).
        // No-ops (and costs no API calls) for PRs without the label.
        for (const pr of prs) {
          if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
          try {
            await ciFixer.clearNotRerunnableIfResolved(repo, pr);
          } catch (err) {
            reportError("ci-fixer:clear-not-rerunnable", `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
          }
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

        // ── Phase 2: Enqueue CI work ──
        if (!ciFixerDisabled) {
          let needsRerunSweep = false;
          for (const item of items) {
            if (item.kind === "conflict") {
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
        // This prevents pr-reviewer from adding Ready in the same cycle that review-addresser just worked.
        const reviewAddresserPRNumbers = new Set<number>();
        // Subset of the above that is having advisory-only nits addressed. These
        // keep their Ready label, so Phase 6 must still surface them.
        const advisoryPRNumbers = new Set<number>();
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
            if (await gh.getPRMergeableState(repo.fullName, pr.number) === "CONFLICTING") continue;

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
              log.info(`[pr-dispatcher] Advisory-only review for ${repo.fullName}#${pr.number} — addressing nits during Ready idle time`);
              advisoryPRNumbers.add(pr.number);
              reviewAddresserPRNumbers.add(pr.number); // Phase 4: don't re-review this cycle
              await worker.enqueue(AGENT_KINDS.REVIEW_ADDRESSER, repo.fullName, pr.number, {
                priority: gh.hasPriorityLabel(pr.labels),
                args: { advisory: true },
              });
              continue; // NOTE: Ready is deliberately NOT removed
            }

            populated.add(pr.number);
            gh.populateQueueCacheFor("needs-review-addressing", repo.fullName, pr, "pr");
            await gh.removeLabel(repo.fullName, pr.number, LABELS.ready);
            // The design's "feedback sends a PR back": the approval columns are
            // left alone, so a merge approval survives the feedback. Only a PR
            // in a pre-merge review stage is demoted; problematic, manual-action
            // and ci-failing keep the stage their label or CI implies.
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
        // Subset of PRs given Ready this cycle by the auto-bump skip below. Phase 6's
        // `rows` snapshot predates this write, so it consults this set too.
        const autoBumpReadyPRNumbers = new Set<number>();
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
            if (isAutoBumpPR(pr) && await isApprovalExempt(repo.fullName, pr, rows.get(pr.number))) {
              try {
                const verdict = await getAutoBumpGateVerdict(repo, pr);
                if (verdict.ok) {
                  log.info(`[pr-dispatcher] Skipping pr-reviewer for ${repo.fullName}#${pr.number} — approval-exempt auto-bump image pin, CI is the gate`);
                  if (!isAwaitingMerge(rows.get(pr.number))) {
                    const [checkStatus, mergeable] = await Promise.all([
                      gh.getPRCheckStatus(repo.fullName, pr.number),
                      gh.getPRMergeableState(repo.fullName, pr.number),
                    ]);
                    if (checkStatus === "passing" && mergeable !== "CONFLICTING") {
                      await gh.addLabel(repo.fullName, pr.number, LABELS.ready);
                      autoBumpReadyPRNumbers.add(pr.number);
                    }
                  }
                  continue;
                }
              } catch (err) {
                reportError("pr-dispatcher:auto-bump-gate", `${repo.fullName}#${pr.number}`, err, { repo: repo.fullName });
                // Fall through to the normal review enqueue below.
              }
            }
            await worker.enqueue(AGENT_KINDS.PR_REVIEWER, repo.fullName, pr.number, {
              priority: gh.hasPriorityLabel(pr.labels),
            });
          }
        }

        // (Phase 5, the periodic merge sweep, is owned by the `auto-merger` scheduler job — #2971.)

        // ── Phase 6: Surface Ready PRs on the dashboard ──
        // PRs awaiting merge that aren't auto-merged need a human to merge them.
        // Add them to the "ready" cache so /prs (src/pages/lists.ts) badges
        // them with their pipeline stage beside the Squash & Merge button.
        for (const pr of prs) {
          if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
          if (gh.isForkPR(pr)) continue;
          if (ciFixerPRNumbers.has(pr.number)) continue;
          // Phase 3 just removed Ready from these — the `rows` snapshot is stale,
          // so trust the in-memory set rather than the row. Advisory rounds
          // are the exception: they keep Ready, so they stay surfaced here.
          if (reviewAddresserPRNumbers.has(pr.number) && !advisoryPRNumbers.has(pr.number)) continue;
          if (!isAwaitingMerge(rows.get(pr.number)) && !autoBumpReadyPRNumbers.has(pr.number)) continue;
          populated.add(pr.number);
          gh.populateQueueCacheFor("ready", repo.fullName, pr, "pr");
        }

        if (!isRepoRateLimited(repo.fullName)) {
          const reconcileCategories: gh.QueueCategory[] = ["problematic", "ready", "waiting-for-window"];
          if (!isAgentDisabled("review-addresser")) reconcileCategories.push("needs-review-addressing");
          gh.reconcileQueueCache(repo.fullName, reconcileCategories, populated, "pr");
        }
      } catch (err) {
        reportError("pr-dispatcher:list-prs", repo.fullName, err, { repo: repo.fullName });
      }
    }),
  );
}
