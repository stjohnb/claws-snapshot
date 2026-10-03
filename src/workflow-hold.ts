/**
 * Clearing GitHub's `action_required` hold on trusted dependency-update PRs.
 *
 * GitHub can create a head commit's workflow runs held for manual approval
 * (conclusion `action_required`, zero jobs started) — e.g. after a repo
 * workflow pushes a follow-up commit to a Dependabot branch. For a trusted
 * third-party update from a branch in the base repository Claws approves the
 * runs itself; anything else (fork PRs, human or untrusted authors) stays held
 * for a human and is reported as "held for approval", never as CI failing.
 */
import type { Repo } from "./config.js";
import {
  approveWorkflowRun,
  isAllowedHumanActor,
  isDependabotPR,
  isForkPR,
  listHeldWorkflowRuns,
  normalizeBotLogin,
  type PR,
} from "./github.js";
import * as log from "./log.js";
import { isThirdPartyUpdatePR } from "./update-window.js";

/**
 * `repo#runId` of every approval GitHub rejected (e.g. 403), so a run that
 * cannot be cleared is not retried every dispatcher tick until restart.
 */
const rejectedRuns = new Set<string>();

/** Test hook: forget every rejected approval. */
export function resetRejectedHeldRunsForTests(): void {
  rejectedRuns.clear();
}

/**
 * `repo@headSha` → the number of held runs last observed live on that head, by
 * either the dispatcher's per-tick {@link observeHeldRuns} /
 * {@link approveHeldRuns}, which cover every open GitHub PR, or the merge
 * gate's own listing in `tryMerge` (`src/agents/auto-merger.ts`). A held run starts no jobs, so it
 * can be entirely missing from `statusCheckRollup`; this is how `/prs`
 * (`resolvePRStatus` in `src/pages/pr-status.ts`) still reports a hold the
 * rollup misses instead of showing the PR as passing.
 */
const heldRunCounts = new Map<string, number>();

/** Record that `repo`'s `headSha` has `count` held runs; 0 clears any prior entry. */
export function recordHeldRuns(repo: string, headSha: string, count: number): void {
  const key = `${repo}@${headSha}`;
  if (count > 0) heldRunCounts.set(key, count);
  else heldRunCounts.delete(key);
}

/** The held-run count last recorded for `repo`'s `headSha`, or `undefined` if none is known. */
export function heldRunCount(repo: string, headSha: string): number | undefined {
  return heldRunCounts.get(`${repo}@${headSha}`);
}

/**
 * Drop every count recorded for `repo` whose head SHA is not in `liveHeads`
 * (the heads of its open PRs), so a head pushed over, closed or merged while
 * held does not linger until restart.
 */
export function pruneHeldRunCounts(repo: string, liveHeads: Set<string>): void {
  const prefix = `${repo}@`;
  for (const key of heldRunCounts.keys()) {
    if (key.startsWith(prefix) && !liveHeads.has(key.slice(prefix.length))) heldRunCounts.delete(key);
  }
}

/** Test hook: forget every recorded held-run count. */
export function resetHeldRunCountsForTests(): void {
  heldRunCounts.clear();
}

/**
 * Whether Claws may approve `pr`'s held workflow runs: a third-party update
 * PR (same test as {@link isThirdPartyUpdatePR}) whose head branch lives in
 * the base repository and whose author is a trusted bot — Dependabot,
 * `renovate[bot]`, or an allowed human actor ({@link isAllowedHumanActor}) on a
 * `renovate/*` branch (fleet-infra's Renovate runs with a PAT). Fork PRs,
 * human-authored PRs and Claws' own accounts are never cleared.
 */
export async function canClearActionRequiredHold(
  repo: string,
  pr: PR,
  allowedActor: (login: string, repo: string) => Promise<boolean> = isAllowedHumanActor,
): Promise<boolean> {
  if (!isThirdPartyUpdatePR(pr)) return false;
  if (isForkPR(pr)) return false;
  if (isDependabotPR(pr)) return true;
  if (normalizeBotLogin(pr.author.login) === "renovate[bot]") return true;
  return pr.headRefName.startsWith("renovate/") && (await allowedActor(pr.author.login, repo));
}

type HeldRun = Awaited<ReturnType<typeof listHeldWorkflowRuns>>[number];

/**
 * List `pr`'s held (`action_required`) workflow runs on its head commit and
 * record their count ({@link recordHeldRuns}). Read-only, so the dispatcher
 * runs it for every open GitHub PR — forks and untrusted authors included —
 * which is what lets `/prs` report a hold the rollup misses. Never throws:
 * returns `null`, leaving any recorded count untouched, when the head SHA is
 * unknown or the runs could not be listed.
 */
export async function observeHeldRuns(repo: Repo, pr: PR): Promise<HeldRun[] | null> {
  if (!pr.headRefOid) {
    log.warn(`[workflow-hold] ${repo.fullName}#${pr.number} has no head SHA — cannot look up held workflow runs`);
    return null;
  }
  let runs;
  try {
    runs = await listHeldWorkflowRuns(repo.fullName, pr.headRefOid);
  } catch (err) {
    log.warn(`[workflow-hold] Could not list held workflow runs for ${repo.fullName}#${pr.number}: ${err}`);
    return null;
  }
  recordHeldRuns(repo.fullName, pr.headRefOid, runs.length);
  return runs;
}

/**
 * Approve each of `runs` (from {@link observeHeldRuns}) on `pr`, logging one
 * line per run, then record how many are still held. Never throws: a rejected
 * approval is logged and remembered so it is not retried. Callers must check
 * {@link canClearActionRequiredHold} first.
 */
export async function approveHeldRuns(
  repo: Repo,
  pr: PR,
  runs: HeldRun[],
): Promise<{ cleared: number; rejected: number }> {
  const result = { cleared: 0, rejected: 0 };
  for (const run of runs) {
    const key = `${repo.fullName}#${run.run_id}`;
    if (rejectedRuns.has(key)) continue;
    try {
      await approveWorkflowRun(repo.fullName, run.run_id);
      result.cleared++;
      log.info(`[workflow-hold] Approved held workflow run ${run.run_id} (${run.workflow_name}) on ${repo.fullName}#${pr.number}`);
    } catch (err) {
      rejectedRuns.add(key);
      result.rejected++;
      log.warn(`[workflow-hold] GitHub rejected approval of held workflow run ${run.run_id} (${run.workflow_name}) on ${repo.fullName}#${pr.number} — leaving it held: ${err}`);
    }
  }
  if (pr.headRefOid) recordHeldRuns(repo.fullName, pr.headRefOid, runs.length - result.cleared);
  return result;
}
