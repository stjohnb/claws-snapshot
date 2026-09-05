import { LABELS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import type { TaskOutcome } from "../db.js";
import { buildSuccessOutcome } from "../outcome.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { processTextForImages } from "../images.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { FAST_CHECKS_GUIDANCE, RUNNER_POLICY_CONTEXT, HOST_EXECUTION_POLICY, NO_STACKED_PRS_POLICY, frontendContext, forgeContext, homeAssistantContext } from "./agent-context.js";
import { isHomeAssistantConfigRepo, homeAssistantMcpAvailable } from "../home-assistant.js";
import { getModel, getProviderSelectionForItem } from "../model-selector.js";
import { extractRecommendedModel } from "./pr-reviewer.js";
import { regenerateAndUpdatePRBody } from "./issue-worker.js";
import type { Provider } from "../plan-parser.js";

/** Marker identifying the single rolling addresser summary comment (edited in place each round). */
const ADDRESSER_COMMENT_MARKER = "review-addresser-summary";

/**
 * Post the addresser's summary, editing the existing rolling comment in place if
 * one exists rather than posting a fresh comment every round (see #1927).
 */
async function postOrEditAddresserComment(fullName: string, prNumber: number, body: string): Promise<void> {
  const withMarker = `${body.trim()}\n\n${ADDRESSER_COMMENT_MARKER}`;
  let existingId: number | null = null;
  try {
    const comments = await gh.getIssueComments(fullName, prNumber);
    for (const c of comments) if (gh.isClawsComment(c.body) && c.body.includes(ADDRESSER_COMMENT_MARKER)) existingId = c.id;
  } catch { /* fall through to create */ }
  if (existingId !== null) await gh.editIssueComment(fullName, existingId, withMarker, { agentName: "Review Addresser" });
  else await gh.commentOnIssue(fullName, prNumber, withMarker, { agentName: "Review Addresser" });
}

/**
 * Detect Review-Addresser text output that merely confirms there was nothing to
 * change (e.g. a reviewer nit that was already addressed, or a false-positive
 * finding) rather than flagging a real blocker, question-answer-with-caveats, or
 * error. Such output should NOT withhold the Ready label. See #1730.
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

export async function processPR(repo: Repo, pr: gh.PR, reviewData: gh.PRReviewData): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[review-addresser] Processing PR #${pr.number} in ${fullName}`);

  await db.withTaskRecording("review-addresser", fullName, pr.number, null, async (taskId) => {
    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "review-addresser",
      async (wtPath) => {
        db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const imageContext = await processTextForImages([reviewData.formatted], wtPath, repo, { repo: fullName, issueNumber: pr.number, agentName: "Review Addresser" }, reviewData.htmlBodies);

        const guardCtx = makeGuardCtx(fullName, pr.number);
        const prompt = [
          `You are addressing PR review comments on a pull request in the repository ${fullName}.`,
          `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
          `Branch: ${guardContent(pr.headRefName, guardCtx("pr-branch"))}`,
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
          forgeContext(repo),
          ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
          imageContext,
        ].join("\n");

        const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
        const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-implementer");
        const timeoutMs = getItemTimeoutMs(fullName, pr.number);
        const recommendedTier = extractRecommendedModel(reviewData.formatted);
        const { provider, strictProvider } = getProviderSelectionForItem(pr.labels, { requiresMcp: homeAssistantMcpAvailable(fullName) });
        const model = getModel(recommendedTier, provider);
        db.updateTaskModel(taskId, model);
        let actualProvider: Provider = provider;
        const claudeOutput = await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier: recommendedTier, model, provider, strictProvider, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId), agent: "build", captureLabel: "review-addresser", githubTokenOwner: repo.owner });

        let outcome: TaskOutcome = { commits: 0 };

        const hasNewCommits = await claude.hasNewCommits(wtPath, pr.headRefName);
        if (hasNewCommits) {
          await claude.pushBranch(wtPath, pr.headRefName, repo.owner);
          // Record it as a Claws push. pr-dispatcher does not skip PRs carrying the
          // problematic label, so without this the ci-fixer's new-commit grant reads
          // our own review fix as manual intervention and burns a bounded grant.
          try {
            db.recordCIFixerPush(fullName, pr.number, (await claude.getHeadSha(wtPath)).trim());
          } catch (err) {
            log.warn(`[review-addresser] Could not record pushed head SHA for ${fullName}#${pr.number}: ${err}`);
          }
          if (pr.headRefName.startsWith("claws/")) {
            await regenerateAndUpdatePRBody(wtPath, fullName, pr, model, actualProvider, "Addressed with", "[review-addresser]");
          }
          log.info(`[review-addresser] Pushed changes for ${fullName}#${pr.number}`);
          outcome = await buildSuccessOutcome(wtPath, pr.baseRefName, pr.number, "updated");

          // pr-dispatcher deliberately leaves Ready in place for advisory rounds (the PR
          // was idle-and-mergeable when dispatched), but that snapshot is now stale: the
          // new commit hasn't been through CI or pr-reviewer yet. Remove Ready so the PR
          // isn't surfaced as mergeable until pr-reviewer re-verifies the fresh HEAD and
          // re-applies it (see #2230 review follow-up).
          if (reviewData.advisoryOnly) {
            await gh.removeLabel(fullName, pr.number, LABELS.ready);
            log.info(`[review-addresser] Removed Ready label for ${fullName}#${pr.number} — advisory round pushed new commits, awaiting fresh CI/review`);
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
        // with no Ready and no Manual Action (#2128).
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
          await postOrEditAddresserComment(fullName, pr.number, claudeOutput.trim());
          log.info(`[review-addresser] Posted issue comment for ${fullName}#${pr.number}`);
        }

        // When no commits were pushed and no issues reported, restore Ready label.
        // Since HEAD is unchanged, pr-reviewer's hasNewCommitsSinceLastReview()
        // will return false and it will never re-fire — so we must restore Ready here.
        // When there IS a genuine issue, don't add Ready — human attention needed.
        // When commits were pushed, pr-reviewer will detect the new HEAD next cycle.
        if (!hasNewCommits && !claudeOutput.trim()) {
          await gh.addLabel(fullName, pr.number, LABELS.ready);
        } else if (!hasNewCommits && isBenignNoChangeOutput(claudeOutput)) {
          // The addresser produced text, but it only confirms there was nothing to
          // change (e.g. a reviewer nit already addressed, or a false-positive
          // finding). This is not a blocker, so the PR is still ready — apply Ready
          // if CI passes and there are no merge conflicts. See #1730.
          try {
            const [ciStatus, mergeState] = await Promise.all([
              gh.getPRCheckStatus(fullName, pr.number),
              gh.getPRMergeableState(fullName, pr.number),
            ]);
            if (ciStatus === "passing" && mergeState !== "CONFLICTING") {
              await gh.addLabel(fullName, pr.number, LABELS.ready);
            } else {
              log.info(`[review-addresser] Benign no-change output for ${fullName}#${pr.number} but CI=${ciStatus}/merge=${mergeState} — not applying Ready`);
            }
          } catch (err) {
            log.warn(`[review-addresser] Could not check CI/merge state for benign no-change output on ${fullName}#${pr.number} — skipping ready label: ${err}`);
          }
        }
        db.recordTaskComplete(taskId, outcome);
      },
    );

    if (result === null) {
      log.info(`[review-addresser] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping (likely merged/closed)`);
      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  });
}
