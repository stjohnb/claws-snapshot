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

  const isDependabot = gh.isDependabotPR(pr);
  const isClawsIssuePR = pr.headRefName.startsWith("claws/issue-");
  const isDocPR = pr.headRefName.startsWith("claws/docs-");
  const isIdeaCollectionPR = pr.headRefName.startsWith("claws/ideas-collect-");
  const isAutoBump = isAutoBumpPR(pr);
  const isAutomerge = pr.labels.some((l) => l.name === LABELS.automerge);

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
  } else if (!isDependabot && !isDocPR && !isIdeaCollectionPR && !isAutoBump) {
    // Any PR not exempt (dependabot, doc, idea-collection, auto-bump) requires a valid LGTM
    const lgtm = await gh.hasValidLGTM(repo.fullName, pr.number, pr.baseRefName);
    if (!lgtm) {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: no valid LGTM`);
      return false;
    }
  }

  // Doc PRs must only contain doc files
  if (isDocPR) {
    const files = await gh.getPRChangedFiles(repo.fullName, pr.number);
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
    const files = await gh.getPRChangedFiles(repo.fullName, pr.number);
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
  // cleanup-test-data-cronjob.yaml (in the app's base/ or prod/ overlay).
  if (isAutoBump) {
    const files = await gh.getPRChangedFiles(repo.fullName, pr.number);
    const allBumps =
      files.length > 0 &&
      files.every((f) =>
        /^apps\/[^/]+\/(?:base\/|prod\/)?(?:deployment|migrate-job|cleanup-test-data-cronjob)\.yaml$/.test(f),
      );
    if (!allBumps) {
      log.warn(`[auto-merger] Auto-bump PR ${repo.fullName}#${pr.number} touches non-bump files, skipping`);
      return false;
    }
  }

  const status = await gh.getPRCheckStatus(repo.fullName, pr.number);
  const checksOk = status === "passing" || ((isDependabot || isDocPR || isIdeaCollectionPR) && status === "none");
  if (!checksOk) {
    if (status === "failing") {
      log.warn(`[auto-merger] Checks failed for ${repo.fullName}#${pr.number}, skipping`);
    } else {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: checks status=${status}`);
    }
    return false;
  }

  const mergeState = await gh.getPRMergeableState(repo.fullName, pr.number);
  if (mergeState === "CONFLICTING") {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} has merge conflicts, skipping (ci-fixer will resolve)`);
    return false;
  }
  if (mergeState === "UNKNOWN") {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} mergeable state still UNKNOWN after retries, skipping`);
    return false;
  }

  gh.populateQueueCache("auto-mergeable", repo.fullName, { number: pr.number, title: pr.title, type: "pr", updatedAt: pr.updatedAt, priority: gh.hasPriorityLabel(pr.labels), labels: pr.labels.map((l) => l.name) });
  log.info(`[auto-merger] Merging ${repo.fullName}#${pr.number} (status=${status} mergeState=${mergeState}): ${pr.title}`);
  try {
    await gh.mergePR(repo.fullName, pr.number);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not mergeable") || msg.includes("Pull Request is not mergeable")) {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number} was not mergeable at merge time, skipping`);
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

