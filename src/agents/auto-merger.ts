import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as log from "../log.js";

/** Image-bump PRs from prod-infra's bump-app-version.yml for our own ghcr.io apps. */
function isAutoBumpPR(pr: gh.PR): boolean {
  const labels = pr.labels.map((l) => l.name);
  return (
    pr.headRefName.startsWith("automation/bump-") &&
    labels.includes("auto-bump") &&
    !labels.includes("major-update")
  );
}

/** True when the PR may be auto-merged without a human LGTM (dependabot, docs, ideas-collection, auto-bump). */
export function isLgtmExempt(pr: gh.PR): boolean {
  return (
    gh.isDependabotPR(pr) ||
    pr.headRefName.startsWith("claws/docs-") ||
    pr.headRefName.startsWith("claws/ideas-collect-") ||
    isAutoBumpPR(pr)
  );
}

/** Attempt to merge a single PR if it meets all merge criteria. Returns true if merged. */
export async function tryMerge(repo: Repo, pr: gh.PR): Promise<boolean> {
  if (gh.isForkPR(pr)) {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: fork PR`);
    return false;
  }

  if (pr.labels.some((l) => l.name === LABELS.manualAction)) {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: ${LABELS.manualAction} label present`);
    return false;
  }

  // Everything above is a cheap pre-filter off the (60 s cached) PR list. The
  // sweep is chained off ci-fixer/reviewer completion, so the PR is routinely
  // mutated seconds before this runs — re-read the merge-relevant state live
  // and re-check every gate against it (#2354).
  const live = await gh.getPRMergeGate(repo.fullName, pr.number);
  if (live.state !== "OPEN") {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: state=${live.state}`);
    return false;
  }
  if (live.labels.some((n) => n === LABELS.manualAction)) {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: ${LABELS.manualAction} label present (live)`);
    return false;
  }
  if (gh.hasIgnoreLabel(live.labels.map((name) => ({ name })))) {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: Claws Ignore label present (live)`);
    return false;
  }

  const isDependabot = gh.isDependabotPR(pr);
  const isClawsIssuePR = pr.headRefName.startsWith("claws/issue-");
  const isDocPR = pr.headRefName.startsWith("claws/docs-");
  const isIdeaCollectionPR = pr.headRefName.startsWith("claws/ideas-collect-");
  const isAutoBump = isAutoBumpPR(pr);
  const isAutomerge = pr.labels.some((l) => l.name === LABELS.automerge);

  let cachedFiles: string[] | null = null;
  const changedFiles = async (): Promise<string[]> => (cachedFiles ??= await gh.getPRChangedFiles(repo.fullName, pr.number));

  if (isAutomerge) {
    const review = await gh.getPRReviewStatus(repo.fullName, pr.number);
    if (review.status !== "clean") {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: Automerge but review status=${review.status}`);
      return false;
    }
    const headSha = await gh.getPRHeadSHA(repo.fullName, pr.number);
    if (!review.reviewedCommit || !headSha.startsWith(review.reviewedCommit)) {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: Automerge but clean review is stale`);
      return false;
    }
  } else if (!isLgtmExempt(pr)) {
    // Any PR not exempt (dependabot, doc, idea-collection, auto-bump) requires a valid LGTM
    const lgtm = await gh.hasValidLGTM(repo.fullName, pr.number, pr.baseRefName);
    if (!lgtm) {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: no valid LGTM`);
      return false;
    }
  }

  // Infra (OpenTofu/Terraform) PRs are never auto-merged — merging must be a
  // conscious human action (#2275). This gate outranks Automerge and LGTM.
  const files = await changedFiles();
  if (files.length === 0 && (pr.changedFiles ?? 0) > 0) {
    // getPRChangedFiles swallows errors and returns []; fail closed rather than
    // auto-merge an unreadable diff that may contain tofu changes.
    log.warn(`[auto-merger] ${repo.fullName}#${pr.number} skipped: could not read changed files`);
    return false;
  }
  const infra = gh.infraPathsIn(files);
  if (infra.length > 0) {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: infrastructure changes require a human merge (${infra.slice(0, 5).join(", ")})`);
    return false;
  }

  // Doc PRs must only contain doc files
  if (isDocPR) {
    const files = await changedFiles();
    const allDocs = files.length > 0 && files.every(
      (f) => f.startsWith("docs/") || f.endsWith(".md"),
    );
    if (!allDocs) {
      log.warn(`[auto-merger] Doc PR ${repo.fullName}#${pr.number} contains non-doc changes, skipping`);
      return false;
    }
  }

  // Idea-collection PRs must only contain ideas/ files
  if (isIdeaCollectionPR) {
    const files = await changedFiles();
    const allIdeas = files.length > 0 && files.every(
      (f) => f.startsWith("ideas/"),
    );
    if (!allIdeas) {
      log.warn(`[auto-merger] Ideas PR ${repo.fullName}#${pr.number} contains non-ideas changes, skipping`);
      return false;
    }
  }

  // Auto-bump PRs may only touch the image-pin manifests the bump-app-version
  // workflow rewrites: deployment.yaml plus the optional migrate-job.yaml and
  // cleanup-test-data-cronjob.yaml (under apps/<app>/ or in its base/, prod/, or
  // migrate/ subdirectory, where migrate/ is where production-infra isolates the Job).
  if (isAutoBump) {
    const files = await changedFiles();
    const allBumps =
      files.length > 0 &&
      files.every((f) =>
        /^apps\/[^/]+\/(?:base\/|prod\/|migrate\/)?(?:deployment|migrate-job|cleanup-test-data-cronjob)\.yaml$/.test(f),
      );
    if (!allBumps) {
      log.warn(`[auto-merger] Auto-bump PR ${repo.fullName}#${pr.number} touches non-bump files, skipping`);
      return false;
    }
  }

  const status = live.checkStatus;
  if (status === "none") {
    // A brand-new head SHA has no check runs registered for the first minute or
    // two. Treating that as "this repo has no CI" is how #2354 merged a red PR:
    // the ci-fixer pushed a merge-base commit at 08:32:42 and the sweep merged
    // at 08:32:59, 10 s after the first check run for the new head even started.
    const { settled, age } = await gh.haveChecksSettled(repo.fullName, live.headSha);
    if (!settled) {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: no checks yet on head ${live.headSha.slice(0, 7)} (age ${age}), waiting for CI to register`);
      return false;
    }
  }
  const checksOk = status === "passing" || ((isDependabot || isDocPR || isIdeaCollectionPR) && status === "none");
  if (!checksOk) {
    if (status === "failing") {
      log.warn(`[auto-merger] Checks failed for ${repo.fullName}#${pr.number}, skipping`);
    } else {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: checks status=${status}`);
    }
    return false;
  }

  let mergeState = live.mergeable;
  if (mergeState === "CONFLICTING") {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} has merge conflicts, skipping (ci-fixer will resolve)`);
    return false;
  }
  if (mergeState === "UNKNOWN") {
    // GitHub computes mergeability asynchronously; retry before giving up.
    mergeState = await gh.getPRMergeableState(repo.fullName, pr.number);
    if (mergeState === "CONFLICTING") {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} has merge conflicts, skipping (ci-fixer will resolve)`);
      return false;
    }
    if (mergeState !== "MERGEABLE") {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} mergeable state still UNKNOWN after retries, skipping`);
      return false;
    }
  }

  gh.populateQueueCache("auto-mergeable", repo.fullName, { number: pr.number, title: pr.title, type: "pr", updatedAt: pr.updatedAt, priority: gh.hasPriorityLabel(pr.labels), labels: pr.labels.map((l) => l.name) });
  log.info(`[auto-merger] Merging ${repo.fullName}#${pr.number} (status=${status} mergeState=${mergeState}): ${pr.title}`);
  try {
    await gh.mergePR(repo.fullName, pr.number, live.headSha);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("not mergeable") ||
      msg.includes("Pull Request is not mergeable") ||
      /head branch was modified/i.test(msg) ||
      /match-head-commit|head sha did not match|does not match/i.test(msg)
    ) {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} head moved or was not mergeable at merge time, skipping`);
      gh.removeQueueItem(repo.fullName, pr.number);
      return false;
    }
    throw err;
  }
  gh.removeQueueItem(repo.fullName, pr.number);

  if (isClawsIssuePR) {
    const match = pr.headRefName.match(/^claws\/issue-(\d+)-/);
    if (match) {
      const issueNumber = parseInt(match[1], 10);
      try {
        await gh.removeLabel(repo.fullName, issueNumber, LABELS.inReview);
      } catch {
        // Label may already be removed or issue closed
      }
    }
  }

  return true;
}

