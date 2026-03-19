import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";

const MAX_IMPROVEMENTS_PER_RUN = 10;

function buildPrompt(fullName: string, openIssueTitles: string[], openPRTitles: string[]): string {
  const issueList =
    openIssueTitles.length > 0
      ? openIssueTitles.map((t) => `  - ${t}`).join("\n")
      : "  (none)";

  const prList =
    openPRTitles.length > 0
      ? openPRTitles.map((t) => `  - ${t}`).join("\n")
      : "  (none)";

  return [
    `You are analyzing the repository ${fullName} for opportunities to improve the codebase.`,
    ``,
    `Read the codebase thoroughly. If \`docs/OVERVIEW.md\` exists, read it first`,
    `(and any linked documents) for context about the architecture and patterns.`,
    ``,
    `Look for meaningful opportunities such as:`,
    `- Code that could be consolidated (duplicate or near-duplicate logic)`,
    `- Overcomplicated code that could be simplified`,
    `- Dead code or unused exports/dependencies`,
    `- Performance issues or inefficiencies`,
    `- Security concerns`,
    `- Missing error handling at system boundaries`,
    `- Stale TODOs or FIXMEs that should be addressed`,
    ``,
    `Guidelines:`,
    `- Be conservative. Only suggest improvements that provide clear, tangible value.`,
    `- Do NOT suggest stylistic changes, comment additions, or trivial refactors.`,
    `- Do NOT suggest adding type annotations, docstrings, or documentation.`,
    `- "No improvements found" is perfectly acceptable — do not manufacture suggestions.`,
    `- Group related improvements into a single suggestion when they should be addressed together.`,
    `- Each suggestion should be specific and actionable, referencing exact files and line numbers.`,
    ``,
    `The following issues are already open in this repository — do NOT re-suggest these:`,
    issueList,
    ``,
    `The following PRs are already open in this repository — do NOT re-suggest these:`,
    prList,
    ``,
    `Respond with ONLY a JSON block in this exact format, no other text:`,
    ``,
    "```json",
    `{`,
    `  "improvements": [`,
    `    {`,
    `      "title": "Short descriptive title (imperative mood)",`,
    `      "body": "Detailed description with file references, what to change, and why"`,
    `    }`,
    `  ]`,
    `}`,
    "```",
    ``,
    `If no improvements are worth suggesting, respond with:`,
    "```json",
    `{ "improvements": [] }`,
    "```",
  ].join("\n");
}

function buildImplementationPrompt(fullName: string, improvement: Improvement): string {
  return [
    `You are implementing a specific improvement in the repository ${fullName}.`,
    ``,
    `**Improvement: ${improvement.title}**`,
    improvement.body,
    ``,
    `If \`docs/OVERVIEW.md\` exists, read it first (and any linked documents) for context.`,
    ``,
    `Implement this improvement. Make clean, focused commits with clear messages.`,
    `Do not make changes beyond what is described above.`,
  ].join("\n");
}

interface Improvement {
  title: string;
  body: string;
}

export function parseImprovements(output: string): Improvement[] {
  // Try extracting from a JSON code fence first
  const fenceMatch = output.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : null;

  // Fall back to finding raw JSON object
  const rawMatch = jsonStr ?? (output.match(/\{[\s\S]*"improvements"[\s\S]*\}/)?.[0] ?? null);

  if (!rawMatch) {
    log.warn("[improvement-identifier] Could not find JSON in Claude output");
    return [];
  }

  try {
    const parsed = JSON.parse(rawMatch) as { improvements?: unknown[] };
    if (!Array.isArray(parsed.improvements)) return [];

    return parsed.improvements.filter(
      (item): item is Improvement =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Improvement).title === "string" &&
        typeof (item as Improvement).body === "string",
    );
  } catch (err) {
    log.warn(`[improvement-identifier] Failed to parse JSON: ${err}`);
    return [];
  }
}

const FOOTER = "\n\n---\n*Automated improvement by claws improvement-identifier*";

async function processRepo(repo: Repo): Promise<void> {
  const fullName = repo.fullName;

  // Skip repos without local clones
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  if (!fs.existsSync(repoDir)) return;

  // Fetch open issue titles and PR titles for dedup context
  const openIssues = await gh.listOpenIssues(fullName);
  const openIssueTitles = openIssues.map((i) => i.title);
  const openPRs = await gh.listPRs(fullName);

  // Skip if improvement PRs are already open
  if (openPRs.some((pr) => pr.headRefName.startsWith("claws/improve-"))) {
    log.info(`[improvement-identifier] Skipping ${fullName} — open improvement PR(s) exist`);
    return;
  }

  const openPRTitles = openPRs.map((p) => p.title);

  // Phase 1: Analysis — identify improvements via Claude
  const analysisBranch = `claws/improve-${claude.randomSuffix()}`;
  const analysisTaskId = db.recordTaskStart("improvement-identifier", fullName, 0, null);
  let analysisWt: string | undefined;
  let improvements: Improvement[];

  try {
    analysisWt = await claude.createWorktree(repo, analysisBranch, "improvement-identifier");
    db.updateTaskWorktree(analysisTaskId, analysisWt, analysisBranch);

    log.info(`[improvement-identifier] Analyzing ${fullName}`);
    const prompt = buildPrompt(fullName, openIssueTitles, openPRTitles);
    const output = await claude.enqueue(() => claude.runClaude(prompt, analysisWt!));

    improvements = parseImprovements(output);
    db.recordTaskComplete(analysisTaskId);
  } catch (err) {
    db.recordTaskFailed(analysisTaskId, String(err));
    throw err;
  } finally {
    if (analysisWt) {
      await claude.removeWorktree(repo, analysisWt);
    }
  }

  if (improvements.length === 0) {
    log.info(`[improvement-identifier] No improvements identified for ${fullName}`);
    return;
  }

  // Phase 2: Implementation — implement each improvement as a PR (concurrently)
  const capped = improvements.slice(0, MAX_IMPROVEMENTS_PER_RUN);
  if (improvements.length > MAX_IMPROVEMENTS_PER_RUN) {
    log.info(`[improvement-identifier] Capping at ${MAX_IMPROVEMENTS_PER_RUN} improvements for ${fullName} (${improvements.length} identified)`);
  }

  const tasks = capped.map(async (improvement) => {
    // Dedup check against both issues and PRs
    const existingIssues = await gh.searchIssues(fullName, improvement.title);
    const existingPRs = await gh.searchPRs(fullName, improvement.title);
    if (existingIssues.length > 0 || existingPRs.length > 0) {
      log.info(
        `[improvement-identifier] Skipping "${improvement.title}" — similar issue or PR already exists`,
      );
      return;
    }

    const implBranch = `claws/improve-${claude.randomSuffix()}`;
    const implTaskId = db.recordTaskStart("improvement-identifier", fullName, 0, null);
    let implWt: string | undefined;

    try {
      implWt = await claude.createWorktree(repo, implBranch, "improvement-identifier");
      db.updateTaskWorktree(implTaskId, implWt, implBranch);

      const implPrompt = buildImplementationPrompt(fullName, improvement);
      await claude.enqueue(() => claude.runClaude(implPrompt, implWt!));

      if (await claude.hasNewCommits(implWt, repo.defaultBranch)) {
        await claude.pushBranch(implWt, implBranch);
        const prBody = improvement.body + FOOTER;
        await gh.createPR(fullName, implBranch, `refactor: ${improvement.title}`, prBody);
        log.info(`[improvement-identifier] Created PR for "${improvement.title}" in ${fullName}`);
      } else {
        log.warn(`[improvement-identifier] No commits produced for "${improvement.title}" in ${fullName}`);
      }

      db.recordTaskComplete(implTaskId);
    } catch (err) {
      db.recordTaskFailed(implTaskId, String(err));
      reportError("improvement-identifier:implement", `${fullName}: ${improvement.title}`, err);
    } finally {
      if (implWt) {
        await claude.removeWorktree(repo, implWt);
      }
    }
  });

  await Promise.allSettled(tasks);
}

export async function run(repos: Repo[]): Promise<void> {
  const tasks = repos.map((repo) =>
    processRepo(repo).catch((err) =>
      reportError("improvement-identifier:process-repo", repo.fullName, err),
    ),
  );
  await Promise.allSettled(tasks);
}
