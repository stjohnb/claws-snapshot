import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { findPlanComment } from "../plan-parser.js";

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

async function processRepo(repo: Repo): Promise<void> {
  const fullName = repo.fullName;

  // Step 0: Skip repos claws isn't working with
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  if (!fs.existsSync(repoDir)) return;

  // Step 1: Check for existing open docs PR
  const prs = await gh.listPRs(fullName);
  const hasDocsPR = prs.some((pr) => pr.headRefName.startsWith("claws/docs-"));
  if (hasDocsPR) {
    log.info(`[doc-maintainer] Skipping ${fullName} — open docs PR exists`);
    return;
  }

  // Step 2: Check if maintenance is needed
  const branchName = `claws/docs-${claude.datestamp()}-${claude.randomSuffix()}`;
  const taskId = db.recordTaskStart("doc-maintainer", fullName, 0, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktree(repo, branchName, "doc-maintainer");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const headSha = await claude.getHeadSha(wtPath);
    const lastDocSha = await claude.getLastDocMaintainerSha(wtPath);

    if (lastDocSha && lastDocSha === headSha) {
      log.info(`[doc-maintainer] Skipping ${fullName} — no changes since last doc update`);
      db.recordTaskComplete(taskId);
      return;
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
    await claude.enqueue(() => claude.runClaude(prompt, wtPath!));

    // Clean up temporary plans directory (must not be committed)
    const plansDir = path.join(wtPath!, ".plans");
    if (fs.existsSync(plansDir)) {
      fs.rmSync(plansDir, { recursive: true });
      try {
        await claude.git(["rm", "-rf", "--cached", ".plans"], wtPath!);
      } catch {
        // Not staged, that's fine
      }
    }

    // Step 5: Push and create PR
    if (await claude.hasNewCommits(wtPath, repo.defaultBranch)) {
      const description = await claude.generateDocsPRDescription(wtPath, repo.defaultBranch);
      await claude.pushBranch(wtPath, branchName);
      const prNumber = await gh.createPR(
        fullName,
        branchName,
        `docs: update documentation for ${repo.name}`,
        description,
      );
      log.info(`[doc-maintainer] Created docs PR #${prNumber} for ${fullName}`);
    } else {
      log.warn(`[doc-maintainer] No commits produced for ${fullName}`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

export async function run(repos: Repo[]): Promise<void> {
  const tasks = repos.map((repo) =>
    processRepo(repo).catch((err) =>
      reportError("doc-maintainer:process-repo", repo.fullName, err),
    ),
  );
  await Promise.allSettled(tasks);
}
