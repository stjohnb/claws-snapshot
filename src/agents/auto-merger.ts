import { LABELS, prUrl, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import * as slack from "../slack.js";
import { guardContent } from "../prompt-guard.js";
import { POST_MERGE_ACTION_HEADING, extractPostMergeActionSection, isVerificationOnlyAction } from "./issue-worker.js";

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

/** An `image:`/`newTag:` pin line — captures the prefix (indent + optional "- " + key) and value. */
const PIN_LINE = /^(\s*(?:-\s+)?(?:image|newTag):\s*)(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;

/** Split `registry/name:tag@sha256:…` into its name and its version (tag+digest). */
function splitImageRef(ref: string): { name: string; version: string } | null {
  const at = ref.indexOf("@");
  const digest = at >= 0 ? ref.slice(at + 1) : "";
  const head = at >= 0 ? ref.slice(0, at) : ref;
  if (at >= 0 && !/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  const colon = head.lastIndexOf(":");
  let name = head;
  let tag = "";
  // A colon with a "/" after it is a registry port (registry:5000/app), not a tag.
  if (colon > 0 && !head.slice(colon + 1).includes("/")) {
    name = head.slice(0, colon);
    tag = head.slice(colon + 1);
    if (!/^[\w][\w.-]{0,127}$/.test(tag)) return null;
  }
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/.test(name)) return null;
  if (!tag && !digest) return null; // an unpinned image is not a version pin
  return { name, version: `${tag}@${digest}` };
}

/** True when a removed/added line pair is the same image:/newTag: key re-pinned to a new value. */
function pinPairOk(removed: string, added: string): boolean {
  const rm = PIN_LINE.exec(removed);
  const ad = PIN_LINE.exec(added);
  if (!rm || !ad) return false;
  if (rm[1] !== ad[1]) return false;
  const rmValue = rm[2] ?? rm[3] ?? rm[4];
  const adValue = ad[2] ?? ad[3] ?? ad[4];
  if (/newTag:\s*$/.test(rm[1])) {
    return (
      /^[\w][\w.-]{0,127}$/.test(rmValue) &&
      /^[\w][\w.-]{0,127}$/.test(adValue) &&
      rmValue !== adValue
    );
  }
  const rmRef = splitImageRef(rmValue);
  const adRef = splitImageRef(adValue);
  if (!rmRef || !adRef) return false;
  return rmRef.name === adRef.name && rmRef.version !== adRef.version;
}

/**
 * True when a unified diff does nothing but re-pin image versions: every changed
 * line is an image:/newTag: pin whose image name is unchanged and whose tag or
 * digest moved. Layout-independent, so it covers production-infra's
 * apps/<app>/[base|prod|migrate/]deployment.yaml and fleet-infra's
 * apps/<app>/deployment-staging.yaml alike (#2777). Fails closed.
 */
export function isImagePinOnlyDiff(diff: string): boolean {
  if (!diff.trim()) return false;
  if (diff.length > 200_000) return false;

  const lines = diff.split("\n");
  if (!lines[0]?.startsWith("diff --git ")) return false;

  type Hunk = { removed: string[]; added: string[] };
  type Section = { headers: string[]; hunks: Hunk[] };
  const sections: Section[] = [];
  let current: Section | null = null;
  let currentHunk: Hunk | null = null;
  let inHeader = true;

  const BAD_HEADER_PREFIXES = [
    "new file mode",
    "deleted file mode",
    "rename from",
    "rename to",
    "copy from",
    "copy to",
    "old mode",
    "new mode",
    "Binary files",
    "GIT binary patch",
  ];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = { headers: [], hunks: [] };
      sections.push(current);
      currentHunk = null;
      inHeader = true;
      continue;
    }
    if (!current) return false;
    if (inHeader) {
      if (line.startsWith("@@")) {
        inHeader = false;
        currentHunk = { removed: [], added: [] };
        current.hunks.push(currentHunk);
      } else {
        if (BAD_HEADER_PREFIXES.some((p) => line.startsWith(p))) return false;
        current.headers.push(line);
      }
      continue;
    }
    if (line.startsWith("@@")) {
      currentHunk = { removed: [], added: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) return false;
    if (line.startsWith("+")) {
      currentHunk.added.push(line.slice(1));
    } else if (line.startsWith("-")) {
      currentHunk.removed.push(line.slice(1));
    } else if (line.startsWith(" ") || line === "" || line.startsWith("\\")) {
      // context, blank, or "\ No newline at end of file" — ignore
    } else {
      return false;
    }
  }

  for (const section of sections) {
    if (section.hunks.length === 0) return false;
    for (const hunk of section.hunks) {
      if (hunk.removed.length !== hunk.added.length || hunk.added.length === 0) return false;
      for (let i = 0; i < hunk.removed.length; i++) {
        if (!pinPairOk(hunk.removed[i], hunk.added[i])) return false;
      }
    }
  }

  return true;
}

/** After a successful merge, surface a "## 📋 Manual action required after merge" note from the
 * PR body as a comment plus a Slack ping — the merged body is not something anyone re-reads. */
async function announcePostMergeAction(repo: Repo, pr: gh.PR): Promise<void> {
  try {
    const body = await gh.getPRBody(repo.fullName, pr.number);
    const section = extractPostMergeActionSection(body);
    if (!section) return;
    const note = section.slice(POST_MERGE_ACTION_HEADING.length).trim();
    if (!note) return;
    if (isVerificationOnlyAction(note)) {
      log.info(`[auto-merger] Skipped verification-only post-merge note for ${repo.fullName}#${pr.number}: ${note}`);
      return;
    }
    const url = prUrl(repo.fullName, pr.number);
    const guarded = guardContent(note, { repo: repo.fullName, source: "pr-post-merge-action", itemNumber: pr.number });
    await gh.commentOnIssue(
      repo.fullName, pr.number,
      `## 📋 Manual action required now this is merged\n\n${guarded}`,
      { agentName: "Auto Merger" },
    );
    await slack.notify(`:memo: [auto-merger] Merged ${repo.fullName}#${pr.number} — manual action required: ${note}\n${url}`);
    log.info(`[auto-merger] Announced post-merge manual action for ${repo.fullName}#${pr.number}`);
  } catch (err) {
    log.warn(`[auto-merger] Could not announce post-merge manual action for ${repo.fullName}#${pr.number}: ${err}`);
  }
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
  if (gh.isParked(live.labels.map((name) => ({ name })))) {
    log.info(`[auto-merger] ${repo.fullName}#${pr.number} skipped: Claws Ignore/Blocked label present (live)`);
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

  // Auto-bump PRs merge with no human LGTM, so the diff itself is the gate: every
  // changed file must be a YAML manifest outside .github/, and the whole diff must
  // be image-pin rewrites only (same image name, new tag or digest). This replaces
  // the apps/<app>/deployment.yaml path allowlist, which encoded production-infra's
  // layout and rejected fleet-infra's apps/claws/deployment-staging.yaml (#2777).
  if (isAutoBump) {
    const files = await changedFiles();
    const allManifests =
      files.length > 0 &&
      files.every((f) => /\.ya?ml$/.test(f) && !f.startsWith(".github/") && !f.includes("/.github/"));
    if (!allManifests) {
      log.warn(`[auto-merger] Auto-bump PR ${repo.fullName}#${pr.number} touches non-bump files, skipping`);
      return false;
    }
    const diff = await gh.getPRDiff(repo.fullName, pr.number);
    if (!isImagePinOnlyDiff(diff)) {
      log.warn(`[auto-merger] Auto-bump PR ${repo.fullName}#${pr.number} diff is not an image-pin-only bump, skipping`);
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
  // isAutomerge reaching here with status === "none" has already passed haveChecksSettled
  // above, which proves the head commit is old enough that "no checks" means the repo/path
  // genuinely registers none — not that CI hasn't started yet.
  const checksOk = status === "passing" || ((isDependabot || isDocPR || isIdeaCollectionPR || isAutomerge) && status === "none");
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
  await announcePostMergeAction(repo, pr);

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

