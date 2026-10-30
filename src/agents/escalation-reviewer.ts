import type { IssueRef } from "../issue-id.js";
import { issueUrl, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import * as slack from "../slack.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { parseFirstValidJson } from "../json-extract.js";
import * as issueRefiner from "./issue-refiner.js";
import { applyIssueApproval } from "../issue-approval-write.js";
import { z } from "zod";

const VerdictSchema = z.object({
  verdict: z.enum(["proceed", "hold"]),
  reason: z.string(),
});

type Verdict = z.infer<typeof VerdictSchema>["verdict"];

const FALLBACK_REASON = "automated risk assessment failed — see logs";

/**
 * True when an issue is eligible for automated escalation review: a `[k3s] `
 * cluster alert carrying `Priority` that Claws itself filed.
 *
 * Claws no longer files such alerts itself — cluster pod/node/Flux alerting
 * moved out to Prometheus/Grafana/Alertmanager (#3250) — so no monitor refreshes
 * or newly files `[k3s] …` issues any more. Pre-existing Claws-filed alerts can
 * still match: any of them can gain `Priority` from a human at any time, which
 * is exactly the case this gate must keep handling. The author check remains the
 * security gate: without it any actor who can open an issue titled `[k3s] …` and
 * apply `Priority` gets a path to fully automated implementation. A Claws-filed
 * alert carries the app installation token's identity, so the author equals the
 * value of `gh.getSelfLogin(repo.owner)`; a Grafana-bridged issue has a different
 * author and is rejected here.
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

async function buildPrompt(fullName: string, issue: gh.Issue, planBody: string): Promise<string> {
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
    `Issue #${issue.number}: ${await guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    await guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
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
    `You may read any managed repository over the Forgejo API when the plan's safety depends on a file there, but otherwise judge from the plan text; reads are optional.`,
    ``,
    `When unsure, answer "hold". A human is notified either way; a "hold" asks them to look,`,
    `it does not drop the issue.`,
    ``,
    `Respond with ONLY a JSON object: {"verdict":"proceed"|"hold","reason":"<one or two sentences>"}`,
    `No other text.`,
  ].join("\n");
}

async function verdictComment(fullName: string, issueNumber: IssueRef, verdict: Verdict, reason: string): Promise<string> {
  const guardCtx = makeGuardCtx(fullName, issueNumber);
  const tail = verdict === "proceed"
    ? `Approving the issue through the Plan gate so implementation starts without waiting for a human.`
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
    await guardContent(reason, guardCtx("escalation-review-reason")),
    ``,
    tail,
    ``,
    `Remove nothing — if you disagree with a \`hold\`, approve the issue through the Plan gate manually.`,
  ].join("\n");
}

/**
 * Reads the plan already posted on a `Priority` monitor alert, asks a reviewer
 * model whether it is safe to implement unattended, and either applies
 * approves it through the Plan gate (proceed) or escalates to the operator via Slack (hold).
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
      const prompt = await buildPrompt(fullName, issue, planComment.body);
      // No repo checkout: the reviewer judges from the plan text, and may read
      // other managed repos over the Forgejo API (read-only token injected by
      // runClaude) to check a claim the plan makes. Edit/Write stay denied.
      const wt = claude.ensureScratchDir("escalation-reviewer");
      const out = await claude.runClaude(prompt, wt, {
        tier: "opus",
        timeoutMs: 300_000,
        provider: "claude",
        disallowedTools: claude.READ_ONLY_DISALLOWED_TOOLS,
        noProviderFallback: true,
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

    // Post the comment BEFORE approving so an approval failure cannot leave the
    // review unrecorded (which would re-run the reviewer on the next tick).
    await gh.commentOnIssue(
      fullName,
      issue.number,
      await verdictComment(fullName, issue.number, verdict, reason),
      { agentName: "Escalation Reviewer" },
    );

    if (verdict === "proceed") {
      // A no-op (and no comment) when the issue is already approved through Plan.
      const approved = await applyIssueApproval(fullName, issue.number, "plan", "escalation-reviewer");
      if (!approved.ok) throw new Error(`Approving ${fullName}#${issue.number} through Plan failed: ${approved.error}`);
      log.info(`[escalation-reviewer] Approved ${fullName}#${issue.number} through Plan`);
    } else {
      log.info(`[escalation-reviewer] Held ${fullName}#${issue.number} for a human: ${reason}`);
      slack.notify(`:warning: [escalation-reviewer] ${fullName}#${issue.number} needs a human — ${reason}. Review and approve or close it at ${url}`);
    }

    await db.recordTaskComplete(taskId, { commits: 0 });
  });
}
