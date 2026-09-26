import { LABELS, prUrl, isClawsIssueId, type Repo } from "../config.js";
import { AGENT_KINDS } from "../worker.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import * as slack from "../slack.js";
import * as db from "../db.js";
import { guardContent } from "../prompt-guard.js";
import { POST_MERGE_ACTION_HEADING, extractPostMergeActionSection, isVerificationOnlyAction } from "./issue-worker.js";
import { extractClosedIssueRefs } from "../phase-coverage.js";
import * as clawsIssues from "../claws-issues.js";
import { ISSUE_REF_PATTERN, canonicalIssueRef, type IssueRef } from "../issue-id.js";
import { loadIssuePhaseState, peekTotalPhases, type IssuePhaseState } from "../planned-prs.js";
import * as planParser from "../plan-parser.js";
import { describeUpdateWindow, isThirdPartyUpdateDeferred } from "../update-window.js";

const ISSUE_BRANCH_RE = new RegExp(`^claws/issue-(${ISSUE_REF_PATTERN})-`);

/** Image-bump PRs from prod-infra's bump-app-version.yml for our own ghcr.io apps. */
export function isAutoBumpPR(pr: gh.PR): boolean {
  const labels = pr.labels.map((l) => l.name);
  return (
    pr.headRefName.startsWith("automation/bump-") &&
    labels.includes("auto-bump") &&
    !labels.includes("major-update")
  );
}

/**
 * True when the PR may be auto-merged without the **Automerge** label
 * (dependabot, docs, ideas-collection, auto-bump).
 *
 * `Needs LGTM` outranks every exemption: a job running on a trial provider
 * (currently `doc-maintainer` on Codex) labels the PRs it writes so they wait
 * for a human, and a human can remove the label to restore auto-merge.
 * `liveLabels` is checked alongside the cached `pr.labels` so a label added
 * seconds ago is not missed (#3124). It is required rather than optional so a
 * caller with no live labels has to pass `undefined` explicitly — omitting it
 * would silently buy the permissive answer from a safety check.
 */
export function isApprovalExempt(pr: gh.PR, liveLabels: readonly string[] | undefined): boolean {
  if (pr.labels.some((l) => l.name === LABELS.needsLgtm)) return false;
  if (liveLabels?.includes(LABELS.needsLgtm)) return false;
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

/** Why an auto-bump PR's diff does not clear the structural gate: `checkAutoBumpDiff`'s failure reasons. */
export type AutoBumpDiffFailure = "no-files" | "non-bump-files" | "not-image-pin-only";

/**
 * The auto-bump structural gate: every changed file must be a YAML manifest
 * outside `.github/`, and the whole diff must be image-pin rewrites only (same
 * image name, new tag or digest). Shared by `tryMerge` (the merge gate itself)
 * and the PR dispatcher (which skips the model review for a PR this gate would
 * already accept without approval). `knownFiles`, when passed, is used instead
 * of a second `getPRChangedFiles` call — the diff is only fetched once the file
 * check passes.
 */
export async function checkAutoBumpDiff(
  repoFullName: string,
  prNumber: number,
  knownFiles?: readonly string[],
): Promise<{ ok: true } | { ok: false; reason: AutoBumpDiffFailure }> {
  const files = knownFiles ?? (await gh.getPRChangedFiles(repoFullName, prNumber));
  if (files.length === 0) return { ok: false, reason: "no-files" };
  const allManifests = files.every((f) => /\.ya?ml$/.test(f) && !f.startsWith(".github/") && !f.includes("/.github/"));
  if (!allManifests) return { ok: false, reason: "non-bump-files" };
  const diff = await gh.getPRDiff(repoFullName, prNumber);
  if (!isImagePinOnlyDiff(diff)) return { ok: false, reason: "not-image-pin-only" };
  return { ok: true };
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

/** Marker identifying the single, edited-in-place "Merge blocked" comment on a PR. */
export const MERGE_STATUS_MARKER = "claws-merge-status";

/**
 * Tell the humans on an approved PR why it did not merge: one comment carrying
 * MERGE_STATUS_MARKER, edited in place and left alone when the text is
 * unchanged, plus the in-memory reason the dashboard renders (#2971). Never
 * throws — a reporting failure must not abort a sweep.
 */
async function reportMergeBlock(repo: Repo, pr: gh.PR, message: string): Promise<void> {
  try {
    gh.setMergeBlockReason(repo.fullName, pr.number, message);
    const body = [
      "### Merge blocked",
      "",
      message,
      "",
      "Claws re-checks this every few minutes; this comment is edited in place.",
      "",
      MERGE_STATUS_MARKER,
    ].join("\n");
    const comments = await gh.getIssueComments(repo.fullName, pr.number);
    const existing = comments.find((c) => gh.isClawsComment(c.body) && c.body.includes(MERGE_STATUS_MARKER));
    if (existing) {
      if (gh.stripClawsMarker(existing.body).trim() === body) return;
      await gh.editIssueComment(repo.fullName, existing.id, body, { agentName: "Auto Merger" });
    } else {
      await gh.commentOnIssue(repo.fullName, pr.number, body, { agentName: "Auto Merger" });
    }
  } catch (err) {
    log.warn(`[auto-merger] Could not report merge block on ${repo.fullName}#${pr.number}: ${err}`);
  }
}

/** Repos with a sweep in flight — the scheduler job and a chained queue row must not overlap. */
const sweepsInFlight = new Set<string>();

/**
 * Evaluate every open PR in `repo` for merge. A PR merged by hand is closed
 * out by the PR dispatcher's `refreshPrStore`, not here. Run by the
 * `auto-merger` scheduler job and by chained `auto-merger:sweep` queue rows
 * (#2971).
 */
export async function sweepRepo(repo: Repo): Promise<void> {
  if (sweepsInFlight.has(repo.fullName)) return;
  sweepsInFlight.add(repo.fullName);
  try {
    // The sweep is chained off ci-fixer/reviewer completion, so the 60 s PR-list
    // cache may still hold labels captured before that agent mutated the PR (#2354).
    gh.invalidatePRList(repo.fullName);
    const prs = await gh.listPRs(repo.fullName);
    const skipKinds = [
      AGENT_KINDS.CI_FIXER,
      AGENT_KINDS.CI_FIXER_CONFLICT,
      AGENT_KINDS.REVIEW_ADDRESSER,
      AGENT_KINDS.PR_REVIEWER,
    ];
    for (const pr of prs) {
      if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
      if (await db.hasActiveWorkForPR(repo.fullName, pr.number, skipKinds)) {
        log.info(`[auto-merger] sweep: skipping ${repo.fullName}#${pr.number} — other work running`);
        continue;
      }
      try {
        await tryMerge(repo, pr);
      } catch (err) {
        log.warn(`[auto-merger] sweep: tryMerge failed for ${repo.fullName}#${pr.number}: ${err}`);
      }
    }
  } finally {
    sweepsInFlight.delete(repo.fullName);
  }
}

/** Attempt to merge a single PR if it meets all merge criteria. Returns true if merged. */
export async function tryMerge(repo: Repo, pr: gh.PR): Promise<boolean> {
  // Set once the PR is known to be human-approved (the **Automerge** label);
  // from then on a block is reported on the PR, not only logged (#2971).
  let approved = false;
  const block = async (
    message: string,
    opts: { level?: "info" | "warn"; notify?: boolean; reason?: string } = {},
  ): Promise<false> => {
    const line = `[auto-merger] ${repo.fullName}#${pr.number} ${message}`;
    if (opts.level === "warn") log.warn(line);
    else log.info(line);
    if (approved && opts.notify !== false && opts.reason) {
      await reportMergeBlock(repo, pr, opts.reason);
    }
    return false;
  };

  if (gh.isForkPR(pr)) {
    return block("skipped: fork PR");
  }

  if (pr.labels.some((l) => l.name === LABELS.manualAction)) {
    return block(`skipped: ${LABELS.manualAction} label present`);
  }

  // No merge comment: every Renovate/Dependabot PR would otherwise collect one daily.
  if (isThirdPartyUpdateDeferred(repo.fullName, pr)) {
    return block(`skipped: third-party update outside the out-of-hours window (${describeUpdateWindow()})`, { notify: false });
  }

  // Everything above is a cheap pre-filter off the (60 s cached) PR list. The
  // sweep is chained off ci-fixer/reviewer completion, so the PR is routinely
  // mutated seconds before this runs — re-read the merge-relevant state live
  // and re-check every gate against it (#2354).
  const live = await gh.getPRMergeGate(repo.fullName, pr.number);
  if (live.state !== "OPEN") {
    return block(`skipped: state=${live.state}`);
  }
  if (live.labels.some((n) => n === LABELS.manualAction)) {
    return block(`skipped: ${LABELS.manualAction} label present (live)`);
  }
  if (gh.isDispatchSkippable(repo.fullName, { number: pr.number, labels: live.labels.map((name) => ({ name })) })) {
    return block("skipped: dispatch guard rejected live labels");
  }

  const isDependabot = gh.isDependabotPR(pr);
  const isDocPR = pr.headRefName.startsWith("claws/docs-");
  const isIdeaCollectionPR = pr.headRefName.startsWith("claws/ideas-collect-");
  const isAutoBump = isAutoBumpPR(pr);
  const isAutomerge = pr.labels.some((l) => l.name === LABELS.automerge);

  let cachedFiles: string[] | null = null;
  const changedFiles = async (): Promise<string[]> => (cachedFiles ??= await gh.getPRChangedFiles(repo.fullName, pr.number));

  if (isAutomerge) {
    approved = true;
    const review = await gh.getPRReviewStatus(repo.fullName, pr.number);
    if (review.status !== "clean") {
      return block(`skipped: Automerge but review status=${review.status}`, {
        // "none" means no review of the current head has run yet — the same
        // transient, nothing-to-act-on state as "no checks registered yet" (#3122).
        notify: review.status !== "none",
        reason: `**${LABELS.automerge}** is set but the Claws review status is \`${review.status}\`, not clean.`,
      });
    }
    const headSha = await gh.getPRHeadSHA(repo.fullName, pr.number);
    if (!review.reviewedCommit || !headSha.startsWith(review.reviewedCommit)) {
      return block("skipped: Automerge but clean review is stale", {
        reason: `**${LABELS.automerge}** is set but the clean Claws review is for an older commit — a fresh review of the current head is required.`,
      });
    }
  } else if (!isApprovalExempt(pr, live.labels)) {
    // Any PR not exempt (dependabot, doc, idea-collection, auto-bump) needs the
    // **Automerge** label — it is the only approval Claws accepts (#3135).
    return block("skipped: not approved — apply the Automerge label");
  }

  // Infra (OpenTofu/Terraform) PRs are never auto-merged — merging must be a
  // conscious human action (#2275). This gate outranks Automerge and every exemption.
  const files = await changedFiles();
  if (files.length === 0 && (pr.changedFiles ?? 0) > 0) {
    // getPRChangedFiles swallows errors and returns []; fail closed rather than
    // auto-merge an unreadable diff that may contain tofu changes.
    return block("skipped: could not read changed files", {
      level: "warn",
      reason: "Claws could not read this PR's changed files, so it will not merge it.",
    });
  }
  const infra = gh.infraPathsIn(files);
  if (infra.length > 0) {
    const paths = infra.slice(0, 5).join(", ");
    return block(`skipped: infrastructure changes require a human merge (${paths})`, {
      reason: `Infrastructure changes (${paths}) always need a human merge.`,
    });
  }
  // Since #3135 the #3051 case — a human accepting "no checks" on an all-docs diff —
  // arrives as **Automerge**, which is already allowlisted on status=none below. What
  // is left for this flag is the one approval-exempt category that is not: an auto-bump
  // PR whose manifests all sit under docs/ (a `.yaml` that is also a CI-exempt path).
  const ciExemptOnly = files.length > 0 && files.every(gh.isCiExemptPath);

  // Doc PRs must only contain doc files
  if (isDocPR) {
    const files = await changedFiles();
    const allDocs = files.length > 0 && files.every(
      (f) => f.startsWith("docs/") || f.endsWith(".md"),
    );
    if (!allDocs) {
      return block("skipped: doc PR contains non-doc changes", {
        level: "warn",
        reason: "This doc PR contains non-doc changes.",
      });
    }
  }

  // Idea-collection PRs must only contain ideas/ files
  if (isIdeaCollectionPR) {
    const files = await changedFiles();
    const allIdeas = files.length > 0 && files.every(
      (f) => f.startsWith("ideas/"),
    );
    if (!allIdeas) {
      return block("skipped: ideas PR contains non-ideas changes", {
        level: "warn",
        reason: "This ideas PR contains non-ideas changes.",
      });
    }
  }

  // Auto-bump PRs merge with no human approval, so the diff itself is the gate: every
  // changed file must be a YAML manifest outside .github/, and the whole diff must
  // be image-pin rewrites only (same image name, new tag or digest). This replaces
  // the apps/<app>/deployment.yaml path allowlist, which encoded production-infra's
  // layout and rejected fleet-infra's apps/claws/deployment-staging.yaml (#2777).
  if (isAutoBump) {
    const files = await changedFiles();
    const verdict = await checkAutoBumpDiff(repo.fullName, pr.number, files);
    if (!verdict.ok) {
      if (verdict.reason === "not-image-pin-only") {
        return block("skipped: auto-bump PR diff is not an image-pin-only bump", {
          level: "warn",
          reason: "This auto-bump PR's diff is not an image-pin-only bump.",
        });
      }
      return block("skipped: auto-bump PR touches non-bump files", {
        level: "warn",
        reason: "This auto-bump PR touches files other than YAML manifests.",
      });
    }
  }

  let status = live.checkStatus;
  if (status === "none") {
    // A brand-new head SHA has no check runs registered for the first minute or
    // two. Treating that as "this repo has no CI" is how #2354 merged a red PR:
    // the ci-fixer pushed a merge-base commit at 08:32:42 and the sweep merged
    // at 08:32:59, 10 s after the first check run for the new head even started.
    const { settled, age } = await gh.haveChecksSettled(repo.fullName, live.headSha);
    if (!settled) {
      return block(`skipped: no checks yet on head ${live.headSha.slice(0, 7)} (age ${age}), waiting for CI to register`, { notify: false });
    }
    // Head is docs-only on top of a commit CI already validated (#2929):
    // carry that result forward rather than treating the PR as unchecked.
    // Skip the check entirely when the PR is already exempt on "none" below —
    // its result would be thrown away.
    const alreadyExemptOnNone = isDependabot || isDocPR || isIdeaCollectionPR || isAutomerge || ciExemptOnly;
    if (!alreadyExemptOnNone && await gh.carriedForwardCheckStatus(repo.fullName, pr.number) === "passing") {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number}: head ${live.headSha.slice(0, 7)} has no checks but every commit since the last CI-validated commit is CI-exempt — carrying its passing status forward`);
      status = "passing";
    }
    if (ciExemptOnly && !(isDependabot || isDocPR || isIdeaCollectionPR || isAutomerge)) {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number}: no checks on head ${live.headSha.slice(0, 7)} but every changed file is CI-exempt — accepting status=none`);
    }
  }
  // isAutomerge/ciExemptOnly reaching here with status === "none" has already passed
  // haveChecksSettled above, which proves the head commit is old enough that "no checks"
  // means the repo/path genuinely registers none — not that CI hasn't started yet. An
  // all-CI-exempt diff is the case where the reviewer applies Ready on "none" (#3051);
  // post-#3135 that arrives via isAutomerge, leaving ciExemptOnly to cover only the
  // approval-exempt auto-bump PR whose manifests are all under docs/.
  const checksOk = status === "passing" || ((isDependabot || isDocPR || isIdeaCollectionPR || isAutomerge || ciExemptOnly) && status === "none");
  if (!checksOk) {
    if (status === "failing") {
      return block("skipped: checks failed", { level: "warn", reason: "CI is failing." });
    }
    return block(`skipped: checks status=${status}`, {
      reason: `CI status is \`${status}\` — waiting for it to finish.`,
    });
  }

  const conflictReason = `This branch has merge conflicts with \`${pr.baseRefName}\` — the ci-fixer will try to resolve them.`;
  let mergeState = live.mergeable;
  if (mergeState === "CONFLICTING") {
    return block("has merge conflicts, skipping (ci-fixer will resolve)", { reason: conflictReason });
  }
  if (mergeState === "UNKNOWN") {
    // GitHub computes mergeability asynchronously; retry before giving up.
    mergeState = await gh.getPRMergeableState(repo.fullName, pr.number);
    if (mergeState === "CONFLICTING") {
      return block("has merge conflicts, skipping (ci-fixer will resolve)", { reason: conflictReason });
    }
    if (mergeState !== "MERGEABLE") {
      return block("mergeable state still UNKNOWN after retries, skipping", { notify: false });
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
      gh.removeQueueItem(repo.fullName, pr.number);
      return block("head moved or was not mergeable at merge time, skipping", { notify: false });
    }
    throw err;
  }
  gh.setMergeBlockReason(repo.fullName, pr.number, null);
  try {
    const task = await db.findLatestCompletedTaskForPrHead(repo.fullName, pr.number, live.headSha);
    if (task) {
      await db.recordTaskEffectivenessEvent({
        taskId: task.id,
        source: "pr-merge",
        sourceRepo: repo.fullName,
        sourceNumber: pr.number,
        sourceSha: live.headSha,
        signal: "pr-merged",
        score: null,
        details: { mergedBy: "auto-merger" },
      });
    } else {
      log.info(`[auto-merger] No completed producer task found for ${repo.fullName}#${pr.number} head ${live.headSha.slice(0, 12)}; skipping merge effectiveness signal`);
    }
  } catch (err) {
    log.warn(`[auto-merger] Could not record merge effectiveness for ${repo.fullName}#${pr.number}: ${err}`);
  }
  gh.removeQueueItem(repo.fullName, pr.number);
  await announcePostMergeAction(repo, pr);

  await finalizeMergedClawsPR(repo, pr, "auto-merger");

  return true;
}

/**
 * Post-merge cleanup for a merged `claws/issue-…` PR, regardless of which route
 * merged it (auto-merger, dashboard, or a human merging directly, which the PR
 * dispatcher's `refreshPrStore` catches): close a multi-PR issue whose every
 * step has now landed, then honour any `Closes #clw_…` line for Claws-native
 * issues. Idempotent — safe to call more than once for the same PR.
 */
export async function finalizeMergedClawsPR(
  repo: Repo,
  pr: Pick<gh.PR, "number" | "headRefName" | "body"> & { title?: string },
  source: string,
): Promise<void> {
  const match = pr.headRefName.match(ISSUE_BRANCH_RE);
  const issueRef = match ? canonicalIssueRef(match[1]!) : null;
  if (issueRef !== null) {
    const phases = await loadMergedIssuePhases(repo, pr, issueRef, source);
    if (phases) await closeCompletedMultiPRIssue(phases.issueRepo, issueRef, phases.state, repo, pr, source);
  }

  await closeNativeIssuesClosedBy(repo, pr, source);
}

/**
 * The phase state of the issue a merged PR belongs to, read from the issue's
 * own repo: the PR's repo for a forge ref, the primary repo for a native id
 * (whose steps may be in any of its repos). Null when the plan has at most one
 * phase — the ordinary case, and no forge read for it at all: the caller then
 * skips closing a multi-PR issue for this merge — or when the load failed
 * (logged); this runs on every merge and must never throw out of the merge path.
 *
 * `mergedPRs` seeds in `pr` itself, deduplicated by number against the
 * dedicated read, whenever the caller knows its title: that read is a lagging
 * search index, and without this a phase state read immediately after the
 * merge can still show `pr` as open. A caller with no title on hand (a
 * reconciled row, whose merge this function only learns about on a later
 * tick, well after the search index has caught up) relies on the dedicated
 * read alone.
 */
async function loadMergedIssuePhases(
  repo: Repo,
  pr: Pick<gh.PR, "number" | "body"> & { title?: string },
  issueRef: IssueRef,
  source: string,
): Promise<{ issueRepo: string; state: IssuePhaseState } | null> {
  try {
    let issueRepo = repo.fullName;
    if (isClawsIssueId(issueRef)) {
      const record = await clawsIssues.getIssue(issueRef);
      if (!record || record.repos.length === 0) return null;
      issueRepo = clawsIssues.primaryRepo(record.repos);
    }
    const comments = await gh.getIssueComments(issueRepo, issueRef);
    const planText = planParser.findPlanComment(comments);
    const { totalPhases, stored } = await peekTotalPhases(issueRepo, issueRef, planText);
    if (totalPhases <= 1) return null;
    const merged = await gh.listMergedPRsForIssue(issueRepo, issueRef);
    const byNumber = new Map<number, { number: number; title: string; body?: string }>(merged.map((m) => [m.number, m]));
    if (pr.title !== undefined) byNumber.set(pr.number, { number: pr.number, title: pr.title, body: pr.body });
    const state = await loadIssuePhaseState(issueRepo, issueRef, comments, { planText, stored, mergedPRs: [...byNumber.values()] });
    return { issueRepo, state };
  } catch (err) {
    log.warn(`[${source}] Could not load phase state for issue ${issueRef} after merging ${repo.fullName}#${pr.number}: ${err}`);
    return null;
  }
}

/**
 * Close a multi-PR issue once its last outstanding step merges. Only a step
 * opened when every other step had already landed carries `Closes`; steps of
 * a parallel plan can merge in any order, so the one that completes the plan
 * may not be that PR. Failures are logged — the issue-auditor's `done`
 * classification is the backstop.
 */
async function closeCompletedMultiPRIssue(
  issueRepo: string,
  issueRef: IssueRef,
  state: IssuePhaseState,
  repo: Repo,
  pr: Pick<gh.PR, "number">,
  source: string,
): Promise<void> {
  if (state.totalPhases <= 1 || state.coverage.done.size < state.totalPhases) return;
  try {
    if ((await gh.getIssueState(issueRepo, issueRef)).state !== "OPEN") return;
    await gh.commentOnIssue(
      issueRepo, issueRef,
      `All ${state.totalPhases} steps of the plan have landed or been marked done (last: ${repo.fullName}#${pr.number}) — closing this issue.`,
      { agentName: "Implementer" },
    );
    await gh.closeIssue(issueRepo, issueRef, "completed");
    log.info(`[${source}] Closed ${issueRepo}#${issueRef}: all ${state.totalPhases} plan steps landed or were marked done`);
  } catch (err) {
    log.warn(`[${source}] Could not close ${issueRepo}#${issueRef} after its last plan step merged: ${err}`);
  }
}

/**
 * Close the Claws-native issues a merged PR says it closes.
 *
 * GitHub does this itself for its own issues, but a `Closes #clw_01JBQ…` in a
 * GitHub or Forgejo PR body points at nothing the forge knows about, so the
 * merger has to honour it. `issue-auditor` covers the same ground for PRs
 * merged by hand.
 *
 * The body is re-read rather than taken from `pr`: the merge sweep's `pr` is a
 * 60 s-cached copy, and a body edited between the sweep's read and the merge
 * would close the wrong issue — or miss the right one. A caller with no cached
 * body at all (`undefined`, e.g. the dashboard or hand-merge paths) always
 * re-reads rather than risk skipping a `Closes #clw_…` it never had a chance to see.
 */
async function closeNativeIssuesClosedBy(
  repo: Repo,
  pr: Pick<gh.PR, "number" | "headRefName" | "body">,
  source = "auto-merger",
): Promise<void> {
  // Cheap guard before the extra round trip: every merged PR reaches here —
  // Dependabot bumps, image bumps, hand-written PRs — and most never mention a
  // native issue at all. Claws' own `claws/issue-…` PRs always re-read, since
  // those are exactly the bodies an agent rewrites between the sweep and the
  // merge; for anything else, a cached body with no `clw_` in it is enough to
  // decide there is nothing to do.
  if (!pr.headRefName.startsWith("claws/issue-") && typeof pr.body === "string" && !/clw_/i.test(pr.body)) return;
  let body: string;
  try {
    body = await gh.getPRBody(repo.fullName, pr.number);
  } catch (err) {
    log.warn(`[${source}] Could not re-read ${repo.fullName}#${pr.number} body to close native issues: ${err}`);
    return;
  }
  for (const ref of extractClosedIssueRefs(body)) {
    if (!isClawsIssueId(ref)) continue;
    try {
      // Ownership check: only a repo the native issue names may close it — a
      // multi-repo plan's last PR carries the `Closes`, whichever of the
      // issue's repos it is in. Anything else — already closed, unassigned, or
      // another repo's — is left alone and logged.
      const issue = await clawsIssues.getIssue(ref);
      if (!issue) {
        log.warn(`[${source}] ${repo.fullName}#${pr.number} names unknown native issue ${ref}`);
        continue;
      }
      if (issue.state !== "open") continue;
      // A shadow is the hidden native record of an issue that is still live on
      // a forge (#3246). Closing it would hide the row without touching the
      // issue the PR actually closes, so a `Closes #clw_…` naming one is
      // ignored — the forge closes its own issue from the same line.
      if (issue.kind !== "issue") {
        log.info(`[${source}] Leaving native issue ${ref} open: it is a shadow of a live forge issue`);
        continue;
      }
      if (!issue.repos.includes(repo.fullName)) {
        log.info(`[${source}] Leaving native issue ${ref} open: ${repo.fullName} is not among its repos ${JSON.stringify(issue.repos)}`);
        continue;
      }
      await gh.closeIssue(repo.fullName, ref, "completed");
      log.info(`[${source}] Closed native issue ${ref} from ${repo.fullName}#${pr.number}`);
    } catch (err) {
      log.warn(`[${source}] Could not close native issue ${ref} from ${repo.fullName}#${pr.number}: ${err}`);
    }
  }
}
