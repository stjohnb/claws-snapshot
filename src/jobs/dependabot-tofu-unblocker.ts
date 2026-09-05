import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";

export interface UnblockTarget {
  repo: string; // owner/name
  baseBranch: string; // required base ref
  branchPrefix: string; // required head ref prefix
  allowedFiles: readonly string[]; // exact paths the PR diff may touch
  marker: string; // empty-commit subject + recursion break
}

export const UNBLOCK_TARGETS: readonly UnblockTarget[] = [
  {
    repo: "St-John-Software/bstjohn-blog",
    baseBranch: "main",
    branchPrefix: "dependabot/terraform/",
    allowedFiles: ["tofu/versions.tf", "tofu/.terraform.lock.hcl"],
    marker: "ci: run tofu plan",
  },
];

export const NAME = "dependabot-tofu-unblocker";
/** Dedup marker in the decline comment so a re-run never double-comments. */
export const DECLINED_MARKER = "tofu-unblock-declined";

export function isUnblockTargetPR(repoFullName: string, pr: gh.PR): boolean {
  return UNBLOCK_TARGETS.some(
    (target) =>
      target.repo === repoFullName &&
      gh.isDependabotPR(pr) &&
      !gh.isForkPR(pr) &&
      pr.baseRefName === target.baseBranch &&
      pr.headRefName.startsWith(target.branchPrefix),
  );
}

async function noteDeclined(target: UnblockTarget, pr: gh.PR, disallowed: string[]): Promise<void> {
  const comments = await gh.getIssueComments(target.repo, pr.number);
  if (comments.some((c) => c.body.includes(DECLINED_MARKER))) return;

  const guardCtx = makeGuardCtx(target.repo, pr.number);
  const list = disallowed
    .slice(0, 20)
    .map((f) => `- \`${guardContent(f, guardCtx("pr-changed-file"))}\``)
    .join("\n");

  const body = [
    `### Tofu Plan not auto-unblocked`,
    DECLINED_MARKER,
    ``,
    `Claws only pushes the \`${target.marker}\` empty commit when a \`${target.branchPrefix}*\` PR is confined to ${target.allowedFiles.map((f) => `\`${f}\``).join(" and ")}. This PR also changes:`,
    ``,
    list,
    ``,
    `The red Tofu Plan check is left for a human to review, who can push an empty commit themselves after reviewing the diff. The check failing here is correct behaviour — \`tofu-plan-on-pr.yml\` must not be edited to make it pass.`,
  ].join("\n");

  await gh.commentOnIssue(target.repo, pr.number, body, { agentName: "Tofu Unblocker" });
}

async function processTarget(target: UnblockTarget): Promise<void> {
  const prs = (await gh.listPRs(target.repo)).filter((p) => isUnblockTargetPR(target.repo, p));
  if (prs.length === 0) return;

  for (const pr of prs) {
    try {
      const files = await gh.getPRChangedFiles(target.repo, pr.number);
      if (files.length === 0) {
        log.warn(`[${NAME}] ${target.repo}#${pr.number}: getPRChangedFiles returned no files — treating as unknown, skipping`);
        continue;
      }

      const disallowed = files.filter((f) => !target.allowedFiles.includes(f));
      if (disallowed.length > 0) {
        await noteDeclined(target, pr, disallowed);
        continue;
      }

      const tip = await gh.getBranchTipCommit(target.repo, pr.headRefName);
      if (!tip) continue;

      if (tip.message.split("\n")[0].trim() === target.marker) {
        log.debug(`[${NAME}] ${target.repo}#${pr.number}: tip already carries the marker commit, nothing to do`);
        continue;
      }

      const result = await gh.pushEmptyCommit(target.repo, pr.headRefName, target.marker, tip);
      if (result === "pushed") {
        log.info(`[${NAME}] ${target.repo}#${pr.number}: pushed empty '${target.marker}' commit onto ${pr.headRefName} to unblock Tofu Plan`);
      } else {
        log.info(`[${NAME}] ${target.repo}#${pr.number}: ${pr.headRefName} moved before the push landed (not-fast-forward) — retrying next cycle`);
      }
    } catch (err) {
      reportError("dependabot-tofu-unblocker:pr", `${target.repo}#${pr.number}`, err);
    }
  }
}

export async function run(): Promise<void> {
  for (const target of UNBLOCK_TARGETS) {
    if (gh.isRateLimited()) return;
    try {
      await processTarget(target);
    } catch (err) {
      reportError("dependabot-tofu-unblocker:process-target", target.repo, err);
    }
  }
}
