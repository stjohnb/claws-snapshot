import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import * as smartSchedule from "../smart-schedule.js";
import { buildSuccessOutcome } from "../outcome.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../slack.js";
import { findPlanComment, type Provider } from "../plan-parser.js";
import { getModel } from "../model-selector.js";

function buildDocPrompt(fullName: string, planCount = 0): string {
  const lines = [
    `You are maintaining documentation for the repository ${fullName}.`,
    ``,
    `Your goal is to create or update documentation under \`docs/\` that is`,
    `optimized for providing context when planning and implementing new features`,
    `and bug fixes.`,
    ``,
    `Steps:`,
    `1. Run \`mkdir -p docs\` to ensure the directory exists.`,
    `2. Read the codebase to understand its current structure, purpose, and key`,
    `   patterns.`,
    `3. If \`docs/OVERVIEW.md\` exists, read it and all docs it links to, then`,
    `   update them to reflect the current state of the code. Preserve accurate`,
    `   content and update anything outdated. If it doesn't exist, create it`,
    `   from scratch.`,
    `4. \`docs/OVERVIEW.md\` is the main entry point and should include:`,
    `   - **Purpose**: What this repo does and its role (2-3 sentences)`,
    `   - **Architecture**: Key directories, modules, and how they fit together`,
    `   - **Key Patterns**: Important conventions, data flow, and design decisions`,
    `   - **Configuration**: Key config values and environment variables`,
    `5. For complex subsystems that need detailed coverage, create dedicated`,
    `   documents (e.g., \`docs/database-schema.md\`, \`docs/api-design.md\`) and`,
    `   link to them from OVERVIEW.md. Keep each focused on one subject.`,
    `6. Keep OVERVIEW.md concise (200-500 lines). Dedicated docs can be longer`,
    `   as needed for thorough coverage.`,
    `7. Commit with message: "docs: update documentation [doc-maintainer]"`,
    ``,
    `Do NOT make any code changes. Only update documentation.`,
  ];

  if (planCount > 0) {
    lines.push(
      ``,
      `A \`.plans/\` directory has been created in the repo root containing implementation`,
      `plans from ${planCount} recently-closed issues. Each file is named by issue number`,
      `(e.g., \`.plans/42.md\`).`,
      ``,
      `Read these plans and extract any valuable architectural context, design decisions,`,
      `conventions, or patterns into the existing documentation. Only add information that`,
      `is actually reflected in the current codebase. If a plan contains nothing new for`,
      `the docs, skip it. Do NOT commit the \`.plans/\` directory — it is temporary.`,
    );
  }

  return lines.join("\n");
}

interface ProcessResult {
  repo: string;
  status:
    | "pr-created"
    | "no-commits"
    | "skipped-no-clone"
    | "skipped-has-pr"
    | "skipped-no-changes"
    | "error";
  prNumber?: number;
  planTitles?: string[];
}

export async function processRepo(repo: Repo): Promise<ProcessResult> {
  try {
    return await processRepoInner(repo);
  } catch (err) {
    reportError("doc-maintainer:process-repo", repo.fullName, err);
    return { repo: repo.fullName, status: "error" };
  } finally {
    db.markRepoProcessedDaily("doc-maintainer", repo.fullName, smartSchedule.localDateString());
  }
}

async function processRepoInner(repo: Repo): Promise<ProcessResult> {
  const fullName = repo.fullName;

  // Step 0: Skip repos claws isn't working with
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  if (!fs.existsSync(repoDir)) return { repo: fullName, status: "skipped-no-clone" };

  // Step 1: Check for existing open docs PR
  const prs = await gh.listPRs(fullName);
  const hasDocsPR = prs.some((pr) => pr.headRefName.startsWith("claws/docs-"));
  if (hasDocsPR) {
    log.info(`[doc-maintainer] Skipping ${fullName} — open docs PR exists`);
    return { repo: fullName, status: "skipped-has-pr" };
  }

  // Step 2: Check if maintenance is needed
  const branchName = `claws/docs-${claude.datestamp()}-${claude.randomSuffix()}`;

  return await db.withTaskRecording("doc-maintainer", fullName, 0, null, async (taskId) => {
    return await claude.withNewWorktree(repo, branchName, "doc-maintainer", async (wtPath): Promise<ProcessResult> => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const headSha = await claude.getHeadSha(wtPath);
      const lastDocSha = await claude.getLastDocMaintainerSha(wtPath);

      if (lastDocSha && lastDocSha === headSha) {
        log.info(`[doc-maintainer] Skipping ${fullName} — no changes since last doc update`);
        db.recordTaskComplete(taskId, { commits: 0 });
        return { repo: fullName, status: "skipped-no-changes" };
      }

      // Step 3: Fetch recently-closed issues with implementation plans
      const sinceDate = lastDocSha
        ? await claude.getCommitDate(wtPath, lastDocSha)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // fallback: 7 days

      const closedIssues = await gh.listRecentlyClosedIssues(fullName, sinceDate);

      const MAX_PLANS = 10;
      const MAX_PLAN_LENGTH = 5_000;
      const plans: { number: number; title: string; plan: string }[] = [];
      for (const issue of closedIssues) {
        if (plans.length >= MAX_PLANS) break;
        const comments = await gh.getIssueComments(fullName, issue.number);
        const plan = findPlanComment(comments);
        if (plan) {
          const truncated = plan.length > MAX_PLAN_LENGTH
            ? plan.slice(0, MAX_PLAN_LENGTH) + "\n\n[... truncated]"
            : plan;
          if (plan.length > MAX_PLAN_LENGTH) {
            log.warn(`[doc-maintainer] Truncated plan for issue #${issue.number} (${plan.length} chars)`);
          }
          plans.push({ number: issue.number, title: issue.title, plan: truncated });
        }
      }

      // Write plans to temporary .plans/ directory
      if (plans.length > 0) {
        const plansDir = path.join(wtPath, ".plans");
        fs.mkdirSync(plansDir, { recursive: true });
        for (const p of plans) {
          const content = `# Issue #${p.number}: ${p.title}\n\n${p.plan}`;
          fs.writeFileSync(path.join(plansDir, `${p.number}.md`), content);
        }
        log.info(`[doc-maintainer] Wrote ${plans.length} plan(s) to .plans/ for ${fullName}`);
      }

      // Step 4: Generate/update documentation
      log.info(`[doc-maintainer] Generating docs for ${fullName}`);
      const prompt = buildDocPrompt(fullName, plans.length);
      const model = getModel("sonnet", "tool-use", "claude");
      db.updateTaskModel(taskId, model);
      let actualProvider: Provider = "claude";
      let taskTokensUsed: number | undefined;
      let taskCostUsd: number | undefined;
      await claude.runClaude(prompt, wtPath, { capability: "tool-use", tier: "sonnet", model, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: (t, c) => { taskTokensUsed = t; taskCostUsd = c; } });
      if (taskTokensUsed !== undefined && taskCostUsd !== undefined) {
        db.updateTaskTokenUsage(taskId, taskTokensUsed, taskCostUsd);
      }

      // Clean up temporary plans directory (must not be committed)
      const plansDir = path.join(wtPath, ".plans");
      if (fs.existsSync(plansDir)) {
        fs.rmSync(plansDir, { recursive: true });
        try {
          await claude.git(["rm", "-rf", "--cached", ".plans"], wtPath);
        } catch {
          // Not staged, that's fine
        }
      }

      // Step 5: Push and create PR
      if (await claude.hasNewCommits(wtPath, repo.defaultBranch)) {
        const attribution = `*— Docs generated with: ${model} (provider: ${actualProvider}) —*`;
        const description = await claude.generateDocsPRDescription(wtPath, repo.defaultBranch, attribution);
        await claude.pushBranch(wtPath, branchName, repo.owner);
        const prNumber = await gh.createPR(
          fullName,
          branchName,
          `docs: update documentation for ${repo.name}`,
          description,
        );
        log.info(`[doc-maintainer] Created docs PR #${prNumber} for ${fullName}`);
        db.recordTaskComplete(taskId, await buildSuccessOutcome(wtPath, repo.defaultBranch, prNumber, "created"));
        return { repo: fullName, status: "pr-created", prNumber, planTitles: plans.map((p) => p.title) };
      } else {
        log.warn(`[doc-maintainer] No commits produced for ${fullName}`);
        db.recordTaskComplete(taskId, { commits: 0 });
        return { repo: fullName, status: "no-commits", planTitles: plans.map((p) => p.title) };
      }
    });
  });
}

function postSummary(results: ProcessResult[]): void {
  const created = results.filter((r) => r.status === "pr-created");
  const noCommits = results.filter((r) => r.status === "no-commits");
  const noChanges = results.filter((r) => r.status === "skipped-no-changes");
  const hasPr = results.filter((r) => r.status === "skipped-has-pr");
  const errors = results.filter((r) => r.status === "error");

  if (created.length === 0 && errors.length === 0 && noCommits.length === 0) {
    return;
  }

  const s = (n: number) => (n === 1 ? "" : "s");
  const attempted = results.filter((r) => r.status !== "skipped-no-clone");
  const lines: string[] = [
    `📚 Doc maintainer: ${created.length} PR${s(created.length)} opened across ${attempted.length} repo${s(attempted.length)}`,
  ];

  for (const r of created) {
    const featurePart =
      r.planTitles && r.planTitles.length > 0
        ? ` — features: ${r.planTitles.join("; ")}`
        : " — no recent feature plans";
    lines.push(`• ${r.repo} #${r.prNumber}${featurePart}`);
  }

  if (noCommits.length > 0) {
    lines.push(`• No-op (Claude produced no commits): ${noCommits.map((r) => r.repo).join(", ")}`);
  }
  if (hasPr.length > 0) {
    lines.push(`• Skipped (open docs PR): ${hasPr.map((r) => r.repo).join(", ")}`);
  }
  if (noChanges.length > 0) {
    lines.push(`• Skipped (no code changes since last doc update): ${noChanges.map((r) => r.repo).join(", ")}`);
  }
  if (errors.length > 0) {
    lines.push(`• Errors: ${errors.map((r) => r.repo).join(", ")}`);
  }

  notify(lines.join("\n"));
}

export async function run(repos: Repo[]): Promise<void> {
  const results = await Promise.all(repos.map((repo) => processRepo(repo)));
  postSummary(results);
}
