import fs from "node:fs";
import path from "node:path";
import { type Repo } from "../config.js";
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
import { CLAWS_AUTOMATION_DOC, CLAWS_AUTOMATION_DOC_PATH } from "../resources/claws-info.js";
import { guardContent } from "../prompt-guard.js";
import { mapSettledWithConcurrency } from "../util.js";

function isHumanLogin(login: string, selfLogin: string): boolean {
  if (!login) return false;
  if (selfLogin && login === selfLogin) return false;
  if (login.endsWith("[bot]")) return false;
  if (login.startsWith("app/")) return false;
  return true;
}

function buildDocPrompt(fullName: string, planCount = 0, intentCount = 0, today = ""): string {
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
    ``,
    `A file \`${CLAWS_AUTOMATION_DOC_PATH}\` exists describing how the Claws`,
    `automation service manages this repo's issues, PRs, and labels. It is`,
    `maintained automatically — do NOT edit, rewrite, move, or delete it.`,
    `Ensure \`docs/OVERVIEW.md\` links to it (add a link if missing). Also ensure`,
    `the repo's root \`CLAUDE.md\` exists and points readers to the \`docs/\` folder`,
    `for context. If \`CLAUDE.md\` is absent, create it with: a 2-3 sentence`,
    `description of what the repo does, a "Where to read first" section pointing to`,
    `\`docs/OVERVIEW.md\`, and any key conventions or gotchas a developer needs to know.`,
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

  if (intentCount > 0) {
    lines.push(
      ``,
      `An \`.intent/\` directory has been created containing human-authored issue/PR bodies`,
      `and comments (bot- and Claws-authored content excluded), one file per item. These`,
      `are the highest-signal statements of what the repo owner actually wants.`,
      ``,
      `Read every file in \`.intent/\` and fold the requirements into \`docs/intent-log.md\``,
      `(create it if absent) — a chronological, append-oriented record of the humans'`,
      `stated requirements, intentions, and context for this repo. Rules:`,
      `- Add a new dated section: \`### ${today}\` summarising the new requirements/context.`,
      `- Do NOT delete or rewrite older sections. Newer entries MAY contradict older ones;`,
      `  when they do, keep both and note the newer supersedes the older.`,
      `- Capture intent, constraints, and rationale — not a code changelog.`,
      `- Link \`docs/intent-log.md\` from \`docs/OVERVIEW.md\`.`,
      `- Do NOT commit the \`.intent/\` directory — it is temporary.`,
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
  return smartSchedule.withDailyRepoMarking(
    "doc-maintainer",
    repo.fullName,
    () => processRepoInner(repo),
    (err) => {
      reportError("doc-maintainer:process-repo", repo.fullName, err);
      return { repo: repo.fullName, status: "error" as const };
    },
  );
}

async function processRepoInner(repo: Repo): Promise<ProcessResult> {
  const fullName = repo.fullName;

  // Step 0: Skip repos claws isn't working with
  const repoDir = claude.repoDir(repo);
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

      const clawsDocFsPath = path.join(wtPath, CLAWS_AUTOMATION_DOC_PATH);
      const existingClawsDoc = fs.existsSync(clawsDocFsPath)
        ? fs.readFileSync(clawsDocFsPath, "utf8")
        : null;
      const clawsDocStale = existingClawsDoc !== CLAWS_AUTOMATION_DOC;

      // First INTENT run is detected by absence of docs/intent-log.md — NOT by lastDocSha.
      // lastDocSha is non-null on every repo that doc-maintainer has ever run on, so it
      // cannot signal whether the intent feature has run before.
      const intentLogPath = path.join(wtPath, "docs", "intent-log.md");
      const isFirstIntentRun = !fs.existsSync(intentLogPath);

      // Exempt the no-changes skip when the intent log has never been written, so the
      // historical backfill still fires on dormant repos whose HEAD hasn't moved since
      // the last doc-maintainer commit.
      if (lastDocSha && lastDocSha === headSha && !clawsDocStale && !isFirstIntentRun) {
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
          const guardedTitle = guardContent(p.title, { repo: fullName, source: "issue-title", itemNumber: p.number });
          const content = `# Issue #${p.number}: ${guardedTitle}\n\n${p.plan}`;
          fs.writeFileSync(path.join(plansDir, `${p.number}.md`), content);
        }
        log.info(`[doc-maintainer] Wrote ${plans.length} plan(s) to .plans/ for ${fullName}`);
      }

      // Step 3b: Gather human-authored intent from closed issues and merged PRs.
      // isFirstIntentRun was computed above (before the no-changes skip gate).
      const intentSince = isFirstIntentRun ? null : sinceDate;
      const intentLimit = isFirstIntentRun ? 500 : 100;
      const MAX_INTENT_ITEMS = isFirstIntentRun ? 500 : 25;
      const MAX_INTENT_CHARS = 2_000;

      let selfLogin = "";
      try {
        selfLogin = await gh.getSelfLogin(repo.owner);
      } catch {
        // bot-suffix filtering only
      }

      const mergedPRs = await gh.listRecentlyMergedPRs(fullName, intentSince, intentLimit);
      // closedIssues above used sinceDate (7-day fallback / last-doc-commit window).
      // On a first intent run we need the UNBOUNDED set, so re-fetch with null:
      const intentIssues = isFirstIntentRun
        ? await gh.listRecentlyClosedIssues(fullName, null, intentLimit)
        : closedIssues;

      type IntentItem = { kind: "Issue" | "PR"; number: number; title: string; body: string; author: string; date: string };
      const intentItems: IntentItem[] = [
        ...intentIssues.map((i) => ({ kind: "Issue" as const, number: i.number, title: i.title, body: i.body, author: i.author, date: i.closedAt.slice(0, 10) })),
        ...mergedPRs.map((p) => ({ kind: "PR" as const, number: p.number, title: p.title, body: p.body, author: p.author, date: p.mergedAt.slice(0, 10) })),
      ]
        // Sort newest-first before capping so the cap trims the oldest items
        // rather than always excluding a whole category (e.g. all merged PRs).
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, MAX_INTENT_ITEMS);

      const intentDir = path.join(wtPath, ".intent");
      const truncateIntent = (s: string) => s.length > MAX_INTENT_CHARS ? s.slice(0, MAX_INTENT_CHARS) + "\n\n[... truncated]" : s;

      const INTENT_FETCH_CONCURRENCY = 6;
      const intentFileResults = await mapSettledWithConcurrency(intentItems, INTENT_FETCH_CONCURRENCY, async (item) => {
        const comments = await gh.getIssueComments(fullName, item.number);
        const sections: string[] = [];

        if (isHumanLogin(item.author, selfLogin) && item.body.trim()) {
          const guarded = guardContent(truncateIntent(item.body), { repo: fullName, source: "intent-body", itemNumber: item.number });
          sections.push(`**Opened by @${item.author}:**\n${guarded}`);
        }

        const humanComments = comments.filter(
          (c) => isHumanLogin(c.login, selfLogin) && !gh.isClawsComment(c.body) && c.body.trim(),
        );
        if (humanComments.length > 0) {
          const bullets = humanComments.map((c) => {
            const g = guardContent(truncateIntent(c.body), { repo: fullName, source: "intent-comment", itemNumber: item.number });
            return `- @${c.login}: ${g}`;
          });
          sections.push(`**Human comments:**\n${bullets.join("\n")}`);
        }

        if (sections.length === 0) return null;

        const guardedTitle = guardContent(item.title, { repo: fullName, source: "intent-title", itemNumber: item.number });
        const verb = item.kind === "Issue" ? "closed" : "merged";
        const file = `${item.kind === "Issue" ? "issue" : "pr"}-${item.number}.md`;
        const content = `## ${item.kind} #${item.number}: ${guardedTitle} (${verb} ${item.date})\n\n${sections.join("\n\n")}\n`;
        return { file, content };
      });

      let intentCount = 0;
      for (const result of intentFileResults) {
        if (result.status === "rejected") {
          log.warn(`[doc-maintainer] Failed to fetch intent for an item in ${fullName}: ${result.reason}`);
          continue;
        }
        if (!result.value) continue;
        if (intentCount === 0) fs.mkdirSync(intentDir, { recursive: true });
        fs.writeFileSync(path.join(intentDir, result.value.file), result.value.content);
        intentCount++;
      }
      if (intentCount > 0) {
        log.info(`[doc-maintainer] Wrote human-intent for ${intentCount} item(s) to .intent/ for ${fullName}${isFirstIntentRun ? " (initial full scan)" : ""}`);
      }

      // Step 4: Generate/update documentation
      log.info(`[doc-maintainer] Generating docs for ${fullName}`);
      const today = new Date().toISOString().slice(0, 10);
      const prompt = buildDocPrompt(fullName, plans.length, intentCount, today);
      const model = getModel("sonnet", "tool-use", "claude");
      db.updateTaskModel(taskId, model);
      let actualProvider: Provider = "claude";
      await claude.runClaude(prompt, wtPath, { capability: "tool-use", tier: "sonnet", model, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId) });

      if (intentCount > 0 && !fs.existsSync(intentLogPath)) {
        log.warn(`[doc-maintainer] ${fullName}: agent did not create docs/intent-log.md despite ${intentCount} intent item(s) captured — the next run will re-trigger the full historical scan`);
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

      // Clean up temporary intent directory (must not be committed; docs/intent-log.md itself is real and stays)
      if (fs.existsSync(intentDir)) {
        fs.rmSync(intentDir, { recursive: true });
        try {
          await claude.git(["rm", "-rf", "--cached", ".intent"], wtPath);
        } catch {
          // Not staged, that's fine
        }
      }

      // Sync the canonical Claws automation doc deterministically (Claude must not own its content).
      fs.mkdirSync(path.dirname(clawsDocFsPath), { recursive: true });
      fs.writeFileSync(clawsDocFsPath, CLAWS_AUTOMATION_DOC);
      await claude.git(["add", CLAWS_AUTOMATION_DOC_PATH], wtPath);
      const stagedClawsDoc = await claude.git(["diff", "--cached", "--name-only", "--", CLAWS_AUTOMATION_DOC_PATH], wtPath);
      if (stagedClawsDoc.trim()) {
        await claude.git(["commit", "-m", "docs: sync Claws automation guide [doc-maintainer]"], wtPath);
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
