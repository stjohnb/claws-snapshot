/**
 * The requirements writer (docs/refinements/issue-flow.md "The requirements
 * writer"): reads the repo and writes an issue's requirements record — what it
 * asks for, never how to build it — before anyone plans it.
 *
 * A write run posts the record as a `## Requirements` Claws comment and stores
 * it as version 1 in `claws_issue_requirements`; a refine run answers human
 * comments left after that comment by editing it in place and storing the next
 * version. The agent hands the record over through `claws_save_requirements`
 * (src/requirements-tools.ts), which writes it to a file beside the run's MCP
 * config; this module reads the file after the CLI exits, so the path works the
 * same in an agent pod as on the host.
 *
 * In this phase the planner still plans from the issue body and runs alongside
 * the writer; see docs/jobs/issue-dispatcher.md "Requirements writer".
 */

import fs from "node:fs";
import path from "node:path";
import { canonicalCommentRef, type IssueRef } from "../issue-id.js";
import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { HOST_EXECUTION_POLICY, REPO_DOCS_CONTEXT, formatIssueCommentsForPrompt, loadRepoAgentDoc } from "./agent-context.js";
import { WORKTREE_ENVIRONMENT_NOTE, findUnreactedHumanComments } from "./issue-refiner.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { resolveModelPlanCell } from "../model-plan.js";
import { resolveTrackerId } from "../planned-prs.js";
import { isRequirementsComment } from "../marker-text.js";
import { parseRequirementsFile, renderRequirementsComment, type RequirementsRecord } from "../requirements-record.js";
import type { Provider } from "../plan-parser.js";
import * as clawsIssues from "../claws-issues.js";
import type { IssueRequirementsVersion } from "../claws-issues.js";

export const REQUIREMENTS_WRITER_JOB = "requirements-writer";
export const REQUIREMENTS_WRITER_AGENT_NAME = "Requirements writer";
/** The out file's name inside the run's agent MCP dir. */
const OUT_FILE_NAME = "requirements.json";

type WriterMode =
  | { kind: "write" }
  | { kind: "refine"; latest: IssueRequirementsVersion; unreacted: gh.IssueComment[] };

/** The newest stored version for an issue, or undefined when it has none. */
export async function loadLatestRequirements(repo: string, ref: IssueRef): Promise<IssueRequirementsVersion | undefined> {
  const trackerId = await resolveTrackerId(repo, ref);
  if (!trackerId) return undefined;
  return (await clawsIssues.listRequirements(trackerId)).at(-1);
}

/**
 * Human comments left after an issue's requirements record comment that the
 * writer has not 👍'd yet, or null when the issue has no record comment. The
 * dispatcher and the refine handler share this rule, so the dispatcher never
 * enqueues work the handler then finds nothing to do for.
 */
export async function unreactedAfterRequirements(
  repo: string,
  issueNumber: IssueRef,
  selfLogin: string,
): Promise<gh.IssueComment[] | null> {
  const comments = await gh.getIssueComments(repo, issueNumber);
  const recordIdx = comments.findLastIndex((c) => isRequirementsComment(c.body));
  if (recordIdx === -1) return null;
  return await findUnreactedHumanComments(repo, comments.slice(recordIdx + 1), selfLogin, issueNumber);
}

/** The latest stored version as the record shape the agent writes. */
export function recordFromVersion(v: IssueRequirementsVersion): RequirementsRecord {
  return {
    title: v.title,
    kind: v.kind,
    context: v.context,
    requirement: v.requirement,
    acceptanceCriteria: v.acceptanceCriteria,
    outOfScope: v.outOfScope,
  };
}

const CONTRACT_INSTRUCTIONS = [
  `YOUR TASK: write this issue's requirements record — what the issue asks for, not how to build it.`,
  ``,
  `1. Read \`AGENTS.md\`, \`docs/PRODUCT.md\` and the \`docs/product/\` area doc this issue touches`,
  `   (when the repository has them). Read code only as far as you need to describe the current`,
  `   behaviour accurately.`,
  `2. Produce ONLY the record: title, kind (bug or feature), context, requirement, acceptance`,
  `   criteria and out of scope. Do NOT make design decisions, describe an implementation, name`,
  `   files or functions to change, or write a plan — a planner does that after a human approves`,
  `   the record.`,
  `3. Call the \`claws_save_requirements\` tool exactly once with the final record. Claws posts it on`,
  `   the issue after you finish; nothing you print is published. Do not edit files, commit or push.`,
  ``,
  `Never run a shell command in the background and never finish with one still running.`,
].join("\n");

/** The prompt for a write or refine run. Exported for tests. */
export function buildRequirementsPrompt(
  repo: Repo,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  selfLogin: string,
  attachmentNames: readonly string[],
  mode: WriterMode,
): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  const discussion = mode.kind === "refine"
    ? comments.filter((c) => String(c.id) !== mode.latest.commentId && !mode.unreacted.some((u) => u.id === c.id))
    : comments;
  return [
    `You are writing the requirements for an issue in the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    ...(attachmentNames.length > 0
      ? [
          `Attached files (read them with the \`claws_get_issue_attachments\` / \`claws_get_issue_attachment\` tools when they matter):`,
          ...attachmentNames.map((name) => `- ${name}`),
          ``,
        ]
      : []),
    ...(discussion.length > 0
      ? [`Discussion on the issue:`, ``, ...formatIssueCommentsForPrompt(discussion, selfLogin, guardCtx), ``]
      : []),
    ...(mode.kind === "refine"
      ? [
          `The current requirements record (version ${mode.latest.version}), as JSON:`,
          ``,
          // Self-authored by Claws — guarding it produces false positives.
          JSON.stringify(recordFromVersion(mode.latest), null, 2),
          ``,
          `A human has since commented on it:`,
          ``,
          ...formatIssueCommentsForPrompt(mode.unreacted, selfLogin, guardCtx),
          ``,
          `Write a corrected record that takes these comments into account. Keep what they do not`,
          `dispute; change what they correct. Save the COMPLETE record, not a diff.`,
          ``,
        ]
      : []),
    REPO_DOCS_CONTEXT,
    HOST_EXECUTION_POLICY,
    WORKTREE_ENVIRONMENT_NOTE,
    ``,
    CONTRACT_INSTRUCTIONS,
  ].join("\n");
}

/**
 * The record the run saved, read from `outFile`. Throws when the agent never
 * called the tool or the file does not validate, so the task fails and nothing
 * is posted.
 */
export function readRequirementsOutFile(outFile: string): RequirementsRecord {
  let text: string;
  try {
    text = fs.readFileSync(outFile, "utf8");
  } catch {
    throw new Error("Requirements writer finished without calling claws_save_requirements — nothing posted");
  }
  return parseRequirementsFile(text);
}

async function persistProviderModel(taskId: number, provider: Provider, model: string): Promise<void> {
  const results = await Promise.allSettled([
    db.updateTaskProvider(taskId, provider),
    db.updateTaskModel(taskId, model),
  ]);
  for (const r of results) {
    if (r.status === "rejected") log.warn(`[requirements-writer] Could not persist provider/model for task ${taskId}: ${r.reason}`);
  }
}

/** Write the first requirements record for an issue that has none. */
export async function writeRequirements(repo: Repo, issue: gh.Issue): Promise<void> {
  await runWriter(repo, issue, { kind: "write" });
}

/**
 * Answer the human comments left on an issue's requirements record: edit the
 * record comment in place, store the next version and 👍 each addressed
 * comment.
 */
export async function refineRequirements(repo: Repo, issue: gh.Issue, unreacted: gh.IssueComment[]): Promise<void> {
  const latest = await loadLatestRequirements(repo.fullName, issue.number);
  if (!latest) {
    log.warn(`[requirements-writer] ${repo.fullName}#${issue.number} has no requirements to refine — writing them fresh`);
    await runWriter(repo, issue, { kind: "write" });
    return;
  }
  await runWriter(repo, issue, { kind: "refine", latest, unreacted });
}

async function runWriter(repo: Repo, issue: gh.Issue, mode: WriterMode): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[requirements-writer] ${mode.kind === "write" ? "Writing" : "Refining"} requirements for ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/req-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording(REQUIREMENTS_WRITER_JOB, fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, REQUIREMENTS_WRITER_JOB, async (wtPath) => {
      await db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin, live, attachments] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLoginForIssue(fullName, issue.number),
        gh.getIssueTitleBody(fullName, issue.number).catch(() => null),
        gh.getIssueAttachments(fullName, issue.number).catch(() => []),
      ]);
      const current: gh.Issue = live ? { ...issue, title: live.title, body: live.body } : issue;

      // A write run honours `Plan: Deep` the way a fresh plan does; a refine
      // run is a correction and stays on the default tier.
      const labelDeep = mode.kind === "write" && issue.labels.some((l) => l.name === LABELS.planDeep);
      const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier, model } = await resolveModelPlanCell(
        fullName, issue.number, "requirements",
        {
          ...(labelDeep ? { tier: "fable" as const, tierSource: "label" as const } : mode.kind === "refine" ? { tier: "sonnet" as const } : {}),
          labels: issue.labels,
        },
      );
      if (overrideIgnoredReason) log.warn(`[requirements-writer] ${fullName}#${issue.number}: ${overrideIgnoredReason}`);
      const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";

      const prompt = buildRequirementsPrompt(repo, current, comments, selfLogin, attachments.map((a) => a.name), mode);
      const agentDoc = loadRepoAgentDoc(wtPath, fullName, REQUIREMENTS_WRITER_JOB);
      // Beside the MCP config, outside the worktree, so the agent's own
      // `git add -A` can never pick it up.
      const outFile = path.join(claude.agentMcpDir(wtPath), OUT_FILE_NAME);
      const mcpConfig = claude.writeAgentMcpConfig(wtPath, { requirementsRun: { outFile }, fileSuffix: "requirements" });
      fs.rmSync(outFile, { force: true });

      let actualProvider: Provider = provider;
      let actualModel = model;
      try {
        await claude.runClaude(prompt, wtPath, {
          mcpConfig,
          timeoutMs: getItemTimeoutMs(fullName, issue.number),
          tier,
          model,
          provider,
          strictProvider,
          eligibleProviders,
          deepThinking: tier === "fable",
          appendSystemPrompt: agentDoc,
          onProviderUsed: (p) => { actualProvider = p; },
          onAttemptModelUsed: (_p, m) => { actualModel = m ?? "default"; },
          onTokensUsed: db.trackTaskTokens(taskId),
          captureLabel: REQUIREMENTS_WRITER_JOB,
          // No forge token: the writer reads its worktree and saves through
          // its MCP tool, so it has no call for owner-wide access.
        });
      } finally {
        await persistProviderModel(taskId, actualProvider, actualModel);
      }

      const record = readRequirementsOutFile(outFile);
      const attribution = `*Models used: ${actualModel} (provider: ${actualProvider}${providerNote})*`;
      const body = `${renderRequirementsComment(record)}\n\n${attribution}`;

      // Stored as text; a forge comment id goes back to the façade as a number.
      const recordComment = mode.kind === "refine" ? canonicalCommentRef(mode.latest.commentId) : null;
      if (mode.kind === "refine" && mode.latest.commentId && recordComment !== null) {
        await gh.editIssueComment(fullName, recordComment, body, { agentName: REQUIREMENTS_WRITER_AGENT_NAME });
        const trackerId = await resolveTrackerId(fullName, issue.number);
        if (!trackerId) throw new Error(`No tracker record for ${fullName}#${issue.number} — cannot store the refined requirements`);
        const version = await db.addClawsIssueRequirementsVersion(trackerId, record, mode.latest.commentId);
        log.info(`[requirements-writer] Updated requirements for ${fullName}#${issue.number} (v${version})`);
      } else {
        await gh.commentOnIssue(fullName, issue.number, body, { agentName: REQUIREMENTS_WRITER_AGENT_NAME });
        const posted = (await gh.getIssueComments(fullName, issue.number)).findLast((c) => isRequirementsComment(c.body));
        const trackerId = await resolveTrackerId(fullName, issue.number, {
          title: current.title,
          body: current.body,
          authorLogin: issue.author.login,
          labels: issue.labels.map((l) => l.name),
        });
        if (!trackerId) throw new Error(`No tracker record for ${fullName}#${issue.number} — the requirements comment is posted but not stored`);
        const version = await db.addClawsIssueRequirementsVersion(trackerId, record, posted ? String(posted.id) : null);
        log.info(`[requirements-writer] Posted requirements for ${fullName}#${issue.number} (v${version})`);
      }

      if (mode.kind === "refine") {
        for (const comment of mode.unreacted) {
          await gh.addReaction(fullName, comment.id, "+1");
        }
      }

      await db.recordTaskComplete(taskId, { commits: 0 });
    });
  });
}
