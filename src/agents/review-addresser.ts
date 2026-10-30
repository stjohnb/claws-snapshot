import type { CommentRef } from "../issue-id.js";
import { HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import { OversizedPushError } from "../push-guard.js";
import * as log from "../log.js";
import * as db from "../db.js";
import type { TaskOutcome } from "../db.js";
import { markPrAwaitingMerge, markPrAwaitingReview } from "../pr-state.js";
import { buildSuccessOutcome } from "../outcome.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { FAST_CHECKS_GUIDANCE, RUNNER_POLICY_CONTEXT, HOST_EXECUTION_POLICY, NO_STACKED_PRS_POLICY, frontendContext, observabilityContext, forgeContext, homeAssistantContext, loadRepoAgentDoc } from "./agent-context.js";
import { isHomeAssistantConfigRepo, homeAssistantMcpAvailable } from "../home-assistant.js";
import { resolveModelPlanCell } from "../model-plan.js";
import { extractRecommendedModel } from "./pr-reviewer.js";
import { regenerateAndUpdatePRBody } from "./issue-worker.js";
import type { Provider } from "../plan-parser.js";

/**
 * Post the addresser's summary, editing the existing rolling comment in place if
 * one exists rather than posting a fresh comment every round (see #1927).
 */
async function postOrEditAddresserComment(fullName: string, prNumber: number, body: string): Promise<void> {
  const withMarker = `${body.trim()}\n\n${gh.ADDRESSER_COMMENT_MARKER}`;
  let existingId: CommentRef | null = null;
  try {
    const comments = await gh.getIssueComments(fullName, prNumber);
    for (const c of comments) if (gh.isClawsComment(c.body) && c.body.includes(gh.ADDRESSER_COMMENT_MARKER)) existingId = c.id;
  } catch { /* fall through to create */ }
  if (existingId !== null) await gh.editIssueComment(fullName, existingId, withMarker, { agentName: "Review Addresser" });
  else await gh.commentOnIssue(fullName, prNumber, withMarker, { agentName: "Review Addresser" });
}

/**
 * Detect Review-Addresser text output that merely confirms there was nothing to
 * change (e.g. a reviewer nit that was already addressed, or a false-positive
 * finding) rather than flagging a real blocker, question-answer-with-caveats, or
 * error. Such output should NOT keep the PR from awaiting merge. See #1730.
 * Conservative: returns false if ANY blocker/error/uncertainty signal is present.
 */
export function isBenignNoChangeOutput(output: string): boolean {
  const text = output.trim();
  if (!text) return false; // empty is handled separately

  // Blocker / error / uncertainty signals → NOT benign.
  if (/\b(error|errors|failed|failure|exception|could ?n[o']?t|cannot|can['']t|unable to|blocked|requires? (a )?manual|needs? (a )?manual|human (intervention|attention|review)|please (review|advise|clarify|confirm)|i (was|am) unable|did not implement|didn['']t implement|left (un)?(addressed|changed)|out of scope|TODO|FIXME)\b/i.test(text)) {
    return false;
  }

  // Positive "no change needed" confirmation required.
  return /\b(already (addressed|removed|fixed|resolved|done|present|correct|handled|in place)|no (changes?|action|modifications?|edits?|fixes?)\s+(needed|required|necessary)|nothing to (address|change|fix|do)|no further (changes?|action)\s+(needed|required|necessary)?|not applicable|false positive|(was|were|is|are) already (addressed|fixed|removed|resolved|correct|present|handled))\b/i.test(text);
}

/**
 * Whether the addresser's text describes a finding as fixed. Used only when HEAD
 * did not move, where any such claim is false: nothing was committed.
 */
export function claimsFix(text: string): boolean {
  return /\b(fixed|resolved|implemented|applied|committed|pushed)\b/i.test(text);
}

export async function processPR(repo: Repo, pr: gh.PR, reviewData: gh.PRReviewData): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[review-addresser] Processing PR #${pr.number} in ${fullName}`);

  await db.withTaskRecording("review-addresser", fullName, pr.number, null, async (taskId) => {
    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "review-addresser",
      async (wtPath) => {
        await db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const guardCtx = makeGuardCtx(fullName, pr.number);
        const prompt = [
          `You are addressing PR review comments on a pull request in the repository ${fullName}.`,
          `PR #${pr.number}: ${await guardContent(pr.title, guardCtx("pr-title"))}`,
          `Branch: ${await guardContent(pr.headRefName, guardCtx("pr-branch"))}`,
          ``,
          `The following review comments have been left on this PR:`,
          ``,
          // Human-authored content in reviewData.formatted is already guarded in getPRReviewComments.
          reviewData.formatted,
          ...(reviewData.advisoryOnly ? [
            ``,
            `IMPORTANT — these findings are ADVISORY ONLY (optional polish, not blocking defects).`,
            `The PR is already approved-for-merge and may be merged at any moment, so keep the diff minimal and low-risk.`,
            `- Apply only self-contained, obviously-correct improvements. Do NOT refactor, rename broadly, or restructure.`,
            `- If a finding is not worth the churn, or would need a design decision, SKIP it and say so briefly in text output.`,
            `- Never introduce behaviour changes beyond what the finding names.`,
          ] : []),
          ``,
          `IMPORTANT — handling conflicts between human and automated comments:`,
          `- Human reviewer comments are AUTHORITATIVE instructions from the repo owner. You MUST follow them exactly, even if you disagree with the reasoning, and even if a Claws automated review comment recommends the opposite.`,
          `- If a human comment conflicts with an automated Claws review comment, follow the human comment and IGNORE the conflicting automated comment. Do NOT revert a change that a human explicitly directed.`,
          `- If you believe the human's instruction is genuinely wrong (e.g., introduces a security bug), implement it anyway and raise the concern as text output for human review — do not silently disobey.`,
          ``,
          `Please address each review comment by making the necessary code changes.`,
          `Make commits with clear messages as you work.`,
          `Describe a finding as fixed only after \`git log\` in this worktree shows your commit for it; if you could not commit a fix, say the finding is NOT fixed and why.`,
          `Do NOT push the branch, open a pull request or change any PR's base branch. Claws pushes your commits with its own credentials after you finish and reports the push result on the PR. Do not report a push failure yourself.`,
          ``,
          `Text output — when to produce it:`,
          `- If a review comment asks a QUESTION (e.g. "why did you…", "what about…", "can you explain…", "is X correct?", "did you consider…", "should this…"), you MUST answer it directly in text output, EVEN IF you also addressed it with a code change. A question always needs a written answer — answering only with a commit is not acceptable. State the answer, and if a commit addresses it, say which change you made.`,
          `- If a review suggestion could not be implemented, explain why.`,
          `- If an error was encountered during implementation, describe it.`,
          `If every review comment was a pure change request that you fully addressed via code changes (no questions asked, no problems encountered), do not produce any text output.`,
          ``,
          FAST_CHECKS_GUIDANCE,
          RUNNER_POLICY_CONTEXT,
          HOST_EXECUTION_POLICY,
          NO_STACKED_PRS_POLICY,
          frontendContext(wtPath),
          observabilityContext(wtPath),
          forgeContext(repo),
          ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
        ].join("\n");

        const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName), taskId });
        const agentDoc = loadRepoAgentDoc(wtPath, fullName, "issue-implementer");
        const timeoutMs = getItemTimeoutMs(fullName, pr.number);
        const recommendedTier = extractRecommendedModel(reviewData.formatted);
        // The linked issue's model plan (docs/model-selection.md) outranks the
        // reviewer's recommendation.
        const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier, model } = await resolveModelPlanCell(fullName, gh.getLinkedIssueNumber(pr), "review-address", {
          tier: recommendedTier,
          labels: pr.labels,
          requiresMcp: homeAssistantMcpAvailable(fullName),
        });
        if (overrideIgnoredReason) log.warn(`[review-addresser] ${fullName}#${pr.number}: ${overrideIgnoredReason}`);
        const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
        let tierNote = "";
        let actualProvider: Provider = provider;
        let actualAccount: string | undefined;
        let actualModel = model;
        const startSha = (await claude.getHeadSha(wtPath)).trim();
        const claudeOutput = await (async () => {
          try {
            return await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider, strictProvider, eligibleProviders, appendSystemPrompt: agentDoc, onProviderUsed: (p, a) => { actualProvider = p; actualAccount = a; }, onAttemptModelUsed: (_p, m) => { actualModel = m ?? "default"; }, onTierFallback: (from) => { tierNote = claude.tierFallbackNote(from); }, onTokensUsed: db.trackTaskTokens(taskId), agent: "build", captureLabel: "review-addresser", forgejoAccessRepo: repo.fullName });
          } finally {
            const results = await Promise.allSettled([
              db.updateTaskProvider(taskId, actualProvider, actualAccount),
              db.updateTaskModel(taskId, actualModel),
            ]);
            for (const r of results) {
              if (r.status === "rejected") log.warn(`[review-addresser] Could not persist provider/model for task ${taskId}: ${r.reason}`);
            }
          }
        })();
        if (claudeOutput.length > 100_000) {
          log.warn(`[review-addresser] ${fullName}#${pr.number}: Claude output was pathologically large (${claudeOutput.length} characters).`);
        }

        let outcome: TaskOutcome = { commits: 0 };

        // Detect commits by HEAD movement, not origin divergence: an agent-issued push
        // updates origin/<branch> and would make hasNewCommits() read false.
        const hasNewCommits = (await claude.getHeadSha(wtPath)).trim() !== startSha;
        let pushedSha: string | undefined;
        if (hasNewCommits) {
          try {
            await claude.pushBranch(wtPath, pr.headRefName, repo);
          } catch (err) {
            if (err instanceof OversizedPushError) {
              await gh.commentOnIssue(fullName, pr.number, "## Push refused\n\n" + err.message, { agentName: "Review Addresser" })
                .catch((commentErr) => log.warn(`[review-addresser] Could not post push refusal on ${fullName}#${pr.number}: ${commentErr}`));
            }
            log.error(`[review-addresser] push of ${pr.headRefName} for ${fullName}#${pr.number} failed — run recorded as failed, no comment/reactions posted; pr-dispatcher retries next cycle: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
          }
          pushedSha = (await claude.getHeadSha(wtPath)).trim();
          // Record it as a Claws push. pr-dispatcher does not skip PRs carrying the
          // problematic label, so without this the ci-fixer's new-commit grant reads
          // our own review fix as manual intervention and burns a bounded grant.
          try {
            await db.recordCIFixerPush(fullName, pr.number, pushedSha);
          } catch (err) {
            log.warn(`[review-addresser] Could not record pushed head SHA for ${fullName}#${pr.number}: ${err}`);
          }
          if (pr.headRefName.startsWith("claws/")) {
            await regenerateAndUpdatePRBody(wtPath, fullName, pr, actualModel, actualProvider, "Addressed with", "[review-addresser]", providerNote + tierNote);
          }
          log.info(`[review-addresser] Pushed changes for ${fullName}#${pr.number}`);
          outcome = await buildSuccessOutcome(wtPath, pr.baseRefName, pr.number, "updated");

          // pr-dispatcher deliberately leaves the PR awaiting merge for advisory rounds
          // (it was idle-and-mergeable when dispatched), but that snapshot is now stale:
          // the new commit hasn't been through CI or pr-reviewer yet. Step it back to
          // awaiting review until pr-reviewer re-verifies the fresh HEAD and marks it
          // again (see #2230 review follow-up).
          if (reviewData.advisoryOnly) {
            await markPrAwaitingReview(fullName, pr.number);
            log.info(`[review-addresser] Marked awaiting review for ${fullName}#${pr.number} — advisory round pushed new commits, awaiting fresh CI/review`);
          }
        }

        if (!claudeOutput.trim()) {
          log.info(`[review-addresser] All review comments addressed without issues for ${fullName}#${pr.number}`);
        }

        // React 🚀 to each addressed comment (non-PR-review Claws comments and inline review comments)
        for (const id of reviewData.commentIds) {
          await gh.addReaction(fullName, id, gh.ADDRESSED_REACTION);
        }
        for (const id of reviewData.reviewCommentIds) {
          await gh.addReviewCommentReaction(fullName, id, gh.ADDRESSED_REACTION);
        }

        // The addresser produced text that isn't a benign "nothing to change" note —
        // it declined the review's request (or failed), without pushing a fix.
        const declined = !!claudeOutput.trim() && !isBenignNoChangeOutput(claudeOutput);

        // When no commits were pushed, mark the PR review comment as addressed so it isn't
        // re-processed next cycle. pr-reviewer overwrites the body on re-review, clearing
        // this marker automatically. When the addresser *declined*, additionally stamp
        // `review-rebutted: <sha>` so pr-reviewer re-fires exactly once for this HEAD to
        // reconsider its finding — otherwise a refuted blocking review deadlocks the PR
        // without marking it awaiting merge and with no escalation (#2128).
        //
        // An advisory round instead stamps `advisory-addressed: <sha>` — the one-shot
        // guard for #2230. It is written whether or not commits were pushed (that is the
        // whole point: a push triggers a re-review that could raise fresh advisories) and
        // pr-reviewer carries it forward across re-reviews. Both stamps go in a single
        // edit because both derive from the same now-stale `body`.
        if (reviewData.prReviewComment) {
          const { id, body, reviewedCommit } = reviewData.prReviewComment;
          const additions: string[] = [];
          if (!hasNewCommits) {
            const addressed = `${gh.REVIEW_ADDRESSED_MARKER}: ${reviewedCommit}`;
            const rebutted = `${gh.REVIEW_REBUTTED_MARKER}: ${reviewedCommit}`;
            if (!body.includes(addressed)) additions.push(addressed);
            if (declined && !body.includes(rebutted)) additions.push(rebutted);
          }
          if (reviewData.advisoryOnly) {
            const advisoryStamp = `${gh.ADVISORY_ADDRESSED_MARKER}: ${reviewedCommit}`;
            if (!body.includes(advisoryStamp)) additions.push(advisoryStamp);
          }
          if (additions.length > 0) {
            await gh.editIssueComment(fullName, id, gh.stripClawsMarker(body) + "\n" + additions.join("\n"), { agentName: "Reviewer" });
          }
        }

        // Only post a comment when Claude reports an issue (not routine summaries)
        if (claudeOutput.trim()) {
          const pushedLine = pushedSha ? `\n\nClaws pushed \`${pushedSha.slice(0, 7)}\` to \`${pr.headRefName}\`.` : "";
          // A declined round whose text still claims a fix: HEAD did not move, so
          // say plainly that nothing landed rather than let the claim stand.
          let noCommitLine = "";
          if (!hasNewCommits && declined && claimsFix(claudeOutput)) {
            log.warn(`[review-addresser] ${fullName}#${pr.number}: output claims a fix but no commit was made (HEAD still ${startSha.slice(0, 7)})`);
            noCommitLine = `**No commit was pushed in this round.** HEAD is still \`${startSha.slice(0, 7)}\`, so every finding described below as fixed is still open.\n\n`;
          }
          await postOrEditAddresserComment(fullName, pr.number, noCommitLine + claudeOutput.trim() + pushedLine);
          log.info(`[review-addresser] Posted issue comment for ${fullName}#${pr.number}`);
        }

        // When no commits were pushed and no issues reported, mark awaiting merge again.
        // Since HEAD is unchanged, pr-reviewer's hasNewCommitsSinceLastReview()
        // will return false and it will never re-fire — so we must mark it here.
        // When there IS a genuine issue, don't — human attention needed.
        // When commits were pushed, pr-reviewer will detect the new HEAD next cycle.
        if (!hasNewCommits && !claudeOutput.trim()) {
          await markPrAwaitingMerge(fullName, pr.number);
        } else if (!hasNewCommits && isBenignNoChangeOutput(claudeOutput)) {
          // The addresser produced text, but it only confirms there was nothing to
          // change (e.g. a reviewer nit already addressed, or a false-positive
          // finding). This is not a blocker, so the PR is still ready — mark it awaiting
          // merge if CI passes and there are no merge conflicts. See #1730.
          try {
            const [ciStatus, mergeState] = await Promise.all([
              gh.getPRCheckStatus(fullName, pr.number),
              gh.getPRMergeableState(fullName, pr.number),
            ]);
            if (ciStatus === "passing" && mergeState !== "CONFLICTING") {
              await markPrAwaitingMerge(fullName, pr.number);
            } else {
              log.info(`[review-addresser] Benign no-change output for ${fullName}#${pr.number} but CI=${ciStatus}/merge=${mergeState} — not marking it awaiting merge`);
            }
          } catch (err) {
            log.warn(`[review-addresser] Could not check CI/merge state for benign no-change output on ${fullName}#${pr.number} — not marking it awaiting merge: ${err}`);
          }
        }
        await db.recordTaskComplete(taskId, outcome);
      },
    );

    if (result === null) {
      log.info(`[review-addresser] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping (likely merged/closed)`);
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  });
}
