/**
 * Deploy-aware merge gate (#clw_01M6RPD77S4VCG7068KVFN4GEF): a plan step whose
 * earlier step has merged does not auto-merge while that earlier step's
 * repo has a declared deploy workflow (`claws.json` `deployWorkflows`) that is
 * red, or still running, on its default branch since the merge.
 *
 * Only the merge is held — the step is still built and reviewed — and nothing
 * is persisted as a manual action, so the auto-merger re-evaluates every sweep
 * and the hold lifts by itself once a later run of the workflow passes.
 */

import type { Repo } from "./config.js";
import * as gh from "./github.js";
import * as forgejo from "./forgejo.js";
import * as log from "./log.js";
import type * as db from "./db.js";
import { getRepoConfig } from "./repo-config.js";
import { loadIssuePhaseState } from "./planned-prs.js";
import { hasNeedsHumanMarker, needsHumanMarker } from "./issue-handback.js";
import type { IssueRef } from "./issue-id.js";

/** Why the gate holds a PR's merge. `deploy-red` needs a person; `deploy-pending` waits quietly. */
export interface DeployGateBlock {
  code: "deploy-red" | "deploy-pending";
  reason: string;
  /** Identifies the hold for the issue notice's needs-human marker; one per held PR, workflow and failed run. */
  slug: string;
}

/** Statuses that never decide the gate: the run before such a run decides instead. */
const IGNORED_RUN_STATUSES = new Set(["cancelled", "skipped"]);

/**
 * The deploy hold on `row`'s PR, or null when it may merge. Walks the
 * transitive dependencies of `row.phase` in `issue`'s plan; for each one a
 * merged PR covers, reads that PR's merge time and its repo's
 * `deployWorkflows`, and checks each workflow's newest default-branch run
 * created at or after the merge, ignoring cancelled and skipped runs:
 * `failure` holds as `deploy-red`, any non-terminal status as
 * `deploy-pending`, and `success` or no run since the merge does not hold.
 * A `deploy-red` outranks a `deploy-pending`. A Forgejo read error fails
 * closed as `deploy-pending` with a warning. Never throws.
 */
export async function deployGateBlock(
  prRepo: Repo,
  row: Pick<db.ClawsPrRecord, "prNumber" | "phase">,
  issue: { repo: string; ref: IssueRef } | null,
): Promise<DeployGateBlock | null> {
  if (row.phase == null || !issue) return null;
  const step = row.phase;
  const pending = (reason: string): DeployGateBlock => ({
    code: "deploy-pending",
    reason,
    slug: `deploy-pending-${prRepo.fullName}#${row.prNumber}`,
  });

  let coverage: Awaited<ReturnType<typeof loadIssuePhaseState>>["coverage"];
  let entries: Awaited<ReturnType<typeof loadIssuePhaseState>>["entries"];
  try {
    const comments = await gh.getIssueComments(issue.repo, issue.ref);
    ({ coverage, entries } = await loadIssuePhaseState(issue.repo, issue.ref, comments));
  } catch (err) {
    log.warn(`[deploy-gate] Could not read the plan of ${issue.repo}#${issue.ref} for ${prRepo.fullName}#${row.prNumber}: ${err}`, {
      repo: prRepo.fullName, pr: row.prNumber, issue: String(issue.ref),
    });
    if ((getRepoConfig(issue.repo)?.deployWorkflows ?? []).length === 0) return null;
    return pending(`Claws could not read the plan of ${issue.repo}#${issue.ref} to check earlier steps' deploys.`);
  }

  // Every step `step` transitively depends on, lowest first.
  const deps = new Set<number>();
  const stack = [...(coverage.dependencies.get(step) ?? [])];
  while (stack.length > 0) {
    const d = stack.pop()!;
    if (d === step || deps.has(d)) continue;
    deps.add(d);
    stack.push(...(coverage.dependencies.get(d) ?? []));
  }

  let firstPending: DeployGateBlock | null = null;
  for (const d of [...deps].sort((a, b) => a - b)) {
    const covering = coverage.coveringPRs.get(d);
    if (!covering || covering.state !== "merged") continue;
    const depRepo = entries?.[d - 1]?.repo ?? issue.repo;
    const workflows = getRepoConfig(depRepo)?.deployWorkflows ?? [];
    if (workflows.length === 0) continue;
    const depLabel = `${depRepo}#${covering.number}`;
    try {
      const status = await gh.getUpstreamPRStatus(depRepo, covering.number);
      const mergedAt = status?.mergedAt ?? null;
      if (!mergedAt) throw new Error(`no merge time for ${depLabel}`);
      const mergedMs = Date.parse(mergedAt);
      const branch = depRepo.toLowerCase() === prRepo.fullName.toLowerCase() ? prRepo.defaultBranch : await gh.getDefaultBranch(depRepo);
      for (const workflow of workflows) {
        const runs = await forgejo.listDefaultBranchWorkflowRuns(depRepo, branch, workflow);
        const latest = runs.find((r) => Date.parse(r.createdAt) >= mergedMs && !IGNORED_RUN_STATUSES.has(r.status));
        if (!latest || latest.status === "success") continue;
        const runRef = latest.htmlUrl ?? `#${latest.runNumber ?? "?"}`;
        if (latest.status === "failure") {
          return {
            code: "deploy-red",
            reason: `Step ${step} depends on step ${d} (\`${depLabel}\`), merged at ${mergedAt}, and its deploy workflow \`${workflow}\` failed on \`${branch}\` (run ${runRef}). Claws will merge this PR once a later \`${workflow}\` run on \`${branch}\` succeeds.`,
            slug: `deploy-red-${prRepo.fullName}#${row.prNumber}-${workflow}`,
          };
        }
        firstPending ??= pending(`Step ${step} depends on step ${d} (\`${depLabel}\`), whose deploy workflow \`${workflow}\` is still \`${latest.status}\` on \`${branch}\` (run ${runRef}); Claws merges this PR once it passes.`);
      }
    } catch (err) {
      log.warn(`[deploy-gate] Could not check the deploy of ${depLabel} for ${prRepo.fullName}#${row.prNumber}; holding the merge: ${err}`, {
        repo: prRepo.fullName, pr: row.prNumber, depRepo, depPr: covering.number,
      });
      firstPending ??= pending(`Claws could not read the deploy workflow runs of step ${d} (\`${depLabel}\`), so it holds this merge until it can.`);
    }
  }
  return firstPending;
}

/** `${prFullName}#${pr}:${slug}` of every deploy hold the linked issue has been told about this process. */
const deployHoldNotices = new Set<string>();

/** Test-only: forget which deploy holds were announced. */
export function clearDeployHoldNotices(): void {
  deployHoldNotices.clear();
}

/**
 * Tell the open issue `issue` once that PR `prFullName#pr` waits on a red
 * deploy: a `## Waiting on a red deploy` comment carrying the block's reason
 * and its needs-human marker, deduplicated in memory and by that marker. The
 * issue is not parked — its other steps carry on. A `deploy-pending` block
 * posts nothing. Never throws.
 */
export async function noticeDeployHold(
  issue: { repo: string; ref: IssueRef } | null,
  prFullName: string,
  pr: number,
  block: DeployGateBlock,
): Promise<void> {
  if (!issue || block.code !== "deploy-red") return;
  const key = `${prFullName}#${pr}:${block.slug}`;
  if (deployHoldNotices.has(key)) return;
  try {
    const state = await gh.getIssueState(issue.repo, issue.ref);
    if (state.state !== "OPEN") return;
    const comments = await gh.getIssueComments(issue.repo, issue.ref);
    if (hasNeedsHumanMarker(comments, block.slug)) {
      deployHoldNotices.add(key);
      return;
    }
    await gh.commentOnIssue(issue.repo, issue.ref, [
      "## Waiting on a red deploy",
      "",
      `PR \`${prFullName}#${pr}\` is otherwise ready to merge. ${block.reason} ` +
        "Claws keeps working on this issue's other steps; fix or re-run the deploy, or merge the PR by hand on the forge.",
      "",
      needsHumanMarker(block.slug),
    ].join("\n"), { agentName: "Auto Merger" });
    deployHoldNotices.add(key);
    log.info(`[deploy-gate] Told ${issue.repo}#${issue.ref} that ${prFullName}#${pr} waits on a red deploy (${block.slug})`, {
      repo: prFullName, pr, issue: String(issue.ref), slug: block.slug,
    });
  } catch (err) {
    log.warn(`[deploy-gate] Could not tell ${issue.repo}#${issue.ref} about ${prFullName}#${pr}'s deploy hold: ${err}`);
  }
}
