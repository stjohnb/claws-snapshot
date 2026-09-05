import { LABELS, issueUrl, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import * as slack from "../slack.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { parseFirstValidJson } from "../json-extract.js";
import * as issueRefiner from "./issue-refiner.js";
import { z } from "zod";

const VerdictSchema = z.object({
  verdict: z.enum(["proceed", "hold"]),
  reason: z.string(),
});

type Verdict = z.infer<typeof VerdictSchema>["verdict"];

const FALLBACK_REASON = "automated risk assessment failed — see logs";

/**
 * True when an issue is eligible for automated escalation review: a `[k3s] `
 * monitor alert carrying `Priority` that Claws itself filed.
 *
 * The author check is a security gate, not a formality — without it any actor
 * who can open an issue titled `[k3s] …` and apply `Priority` gets a path to
 * fully automated implementation. Both k3s-monitor and prod-k8s-monitor file via
 * `ensureAlertIssue` using the app installation token, so the author equals the
 * value of `gh.getSelfLogin(repo.owner)`.
 *
 * Both logins go through `gh.normalizeBotLogin` first: `issue.author.login` comes
 * from the gh CLI as `app/<slug>`, while `getSelfLogin` returns the REST `/app`
 * form `<slug>[bot]`, so a raw `!==` would never match a real Claws-filed alert.
 */
export function isEscalationCandidate(issue: gh.Issue, selfLogin: string): boolean {
  if (!issue.title.startsWith("[k3s] ")) return false;
  if (!gh.hasPriorityLabel(issue.labels)) return false;
  if (gh.normalizeBotLogin(issue.author.login) !== gh.normalizeBotLogin(selfLogin)) {
    log.info(`[escalation-reviewer] Skipping #${issue.number} — author @${issue.author.login} is not the Claws app (@${selfLogin})`);
    return false;
  }
  return true;
}

function buildPrompt(fullName: string, issue: gh.Issue, planBody: string): string {
  const guardCtx = makeGuardCtx(fullName, issue.number);
  return [
    `You are assessing whether Claws should implement and merge an implementation plan`,
    `WITHOUT human review, on a live production incident in the repository ${fullName}.`,
    ``,
    `Context: this class of alert is filed automatically by a cluster monitor. The last`,
    `time one of these waited for a human to approve the plan, a full production TLS`,
    `outage ran for roughly five hours; the eventual fix was a one-line change that took`,
    `twelve minutes once someone engaged. So a needless "hold" has a real cost — but so`,
    `does auto-merging a change that is wrong or destructive.`,
    ``,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    `The plan Claws produced for it:`,
    ``,
    // The plan is self-authored by Claws — guarding it produces false positives
    // when plans discuss security topics or quote example injection strings.
    planBody,
    ``,
    `Answer "proceed" ONLY when ALL of these hold:`,
    `- The plan is a small, mechanical, low-blast-radius fix with an obvious correct implementation.`,
    `- It touches a bounded set of files.`,
    `- It is reversible by a plain revert.`,
    `- It materially mitigates an ACTIVE incident. Low risk, high reward.`,
    ``,
    `Answer "hold" for ANY of these:`,
    `- The plan requires product or design judgement.`,
    `- It performs an irreversible or destructive action (rotating a secret, deleting data,`,
    `  tearing down or rebuilding a cluster, force-pushing, dropping a database).`,
    `- It is a broad refactor, or its correctness is uncertain.`,
    `- Its root-cause diagnosis is speculative or hedged ("if X then A, if Y then B").`,
    `- The underlying problem is not code-fixable at all (node hardware down, resource`,
    `  exhaustion, an upstream provider outage) — there is nothing for an implementer to do.`,
    ``,
    `When unsure, answer "hold". A human is notified either way; a "hold" asks them to look,`,
    `it does not drop the issue.`,
    ``,
    `Respond with ONLY a JSON object: {"verdict":"proceed"|"hold","reason":"<one or two sentences>"}`,
    `No other text.`,
  ].join("\n");
}

function verdictComment(fullName: string, issueNumber: number, verdict: Verdict, reason: string): string {
  const guardCtx = makeGuardCtx(fullName, issueNumber);
  const tail = verdict === "proceed"
    ? `Applying the \`${LABELS.refined}\` label so implementation starts without waiting for a human.`
    : `Claws is NOT auto-implementing this. It needs a human.`;
  // MUST NOT contain issueRefiner.PLAN_HEADER — plan lookup elsewhere finds the
  // LAST comment containing it, so a second such comment would hijack that lookup.
  return [
    issueRefiner.ESCALATION_REVIEW_HEADER,
    ``,
    `ESCALATION_VERDICT: ${verdict}`,
    ``,
    // The reason is model output derived from untrusted issue content; guarding it
    // here stops it becoming permanently-trusted text when a later agent reads it back.
    guardContent(reason, guardCtx("escalation-review-reason")),
    ``,
    tail,
    ``,
    `Remove nothing — if you disagree with a \`hold\`, apply the \`${LABELS.refined}\` label manually.`,
  ].join("\n");
}

/**
 * Reads the plan already posted on a `Priority` monitor alert, asks a reviewer
 * model whether it is safe to implement unattended, and either applies
 * `Refined` (proceed) or escalates to the operator via Slack (hold).
 *
 * A verdict comment is posted on EVERY path — including parse failure and a
 * thrown reviewer call. That comment is the durable dedup record; without it the
 * dispatcher re-enqueues the review on every tick and burns an LLM call each time.
 */
export async function reviewPlanAndEscalate(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;
  const url = issueUrl(fullName, issue.number);

  const comments = await gh.getIssueComments(fullName, issue.number);
  const planComment = comments.findLast(
    (c) => c.body.includes(issueRefiner.PLAN_HEADER) && gh.isClawsComment(c.body),
  );
  if (!planComment) {
    log.info(`[escalation-reviewer] No plan comment on ${fullName}#${issue.number} yet — nothing to review`);
    return;
  }

  log.info(`[escalation-reviewer] Reviewing plan for ${fullName}#${issue.number}: ${issue.title}`);

  await db.withTaskRecording("escalation-reviewer", fullName, issue.number, null, async (taskId) => {
    let verdict: Verdict = "hold";
    let reason = FALLBACK_REASON;

    try {
      const prompt = buildPrompt(fullName, issue, planComment.body);
      // No repo checkout: the reviewer judges from the plan text alone. That is
      // deliberate — it keeps this call cheap and fast on an active incident.
      const wt = claude.ensureScratchDir("escalation-reviewer");
      const out = await claude.runClaude(prompt, wt, {
        tier: "opus",
        timeoutMs: 180_000,
        provider: "claude",
        disallowedTools: claude.TEXT_ONLY_DISALLOWED_TOOLS,
        onTokensUsed: db.trackTaskTokens(taskId),
        captureLabel: "escalation-reviewer",
      });
      const parsed = parseFirstValidJson(out, VerdictSchema, "escalation-review");
      if (parsed) {
        verdict = parsed.verdict;
        reason = parsed.reason;
      } else {
        log.warn(`[escalation-reviewer] Unparseable verdict for ${fullName}#${issue.number} — holding`);
      }
    } catch (err) {
      log.warn(`[escalation-reviewer] Review failed for ${fullName}#${issue.number}: ${String(err)}`);
    }

    // Post the comment BEFORE labelling so a label failure cannot leave the
    // review unrecorded (which would re-run the reviewer on the next tick).
    await gh.commentOnIssue(
      fullName,
      issue.number,
      verdictComment(fullName, issue.number, verdict, reason),
      { agentName: "Escalation Reviewer" },
    );

    if (verdict === "proceed") {
      if (!issue.labels.some((l) => l.name === LABELS.refined)) {
        await gh.addLabel(fullName, issue.number, LABELS.refined);
      }
      log.info(`[escalation-reviewer] Auto-refined ${fullName}#${issue.number}`);
      slack.notify(`:rotating_light: [escalation-reviewer] Auto-refined ${fullName}#${issue.number} — ${issue.title}\n${url}`);
    } else {
      log.info(`[escalation-reviewer] Held ${fullName}#${issue.number} for a human: ${reason}`);
      slack.notify(`:warning: [escalation-reviewer] ${fullName}#${issue.number} needs a human — ${reason}\n${url}`);
    }

    db.recordTaskComplete(taskId, { commits: 0 });
  });
}
