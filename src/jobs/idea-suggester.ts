import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { formatGuardedTitleList, guardContent, makeGuardCtx } from "../prompt-guard.js";
import { MARKETING_RESOURCE } from "../resources/marketing.js";
import { getModel } from "../model-selector.js";
import { mapSettledWithConcurrency } from "../util.js";
import { parseFirstValidJson } from "../json-extract.js";
import { HOST_EXECUTION_POLICY } from "../host-policy.js";

const MAX_IDEAS_TEXT_BYTES = 50_000;
// With the human ✅-reaction gate gone, every filed idea is auto-planned by
// issue-refiner — so keep the cap low and only file high-scoring ideas.
const MAX_IDEAS_PER_REPO = 3;
const MIN_IDEA_SCORE = 7;
const MAX_CONCURRENT_REPOS = 3;

export async function isIdeaGenerationDisabled(
  repoDir: string,
  fullName: string,
): Promise<{ disabled: boolean; overviewContent: string | null }> {
  const overviewPath = path.join(repoDir, "ideas", "overview.md");
  if (!fs.existsSync(overviewPath)) return { disabled: false, overviewContent: null };
  const content = fs.readFileSync(overviewPath, "utf-8");
  if (!content.trim()) return { disabled: false, overviewContent: content };

  const guarded = guardContent(content, { repo: fullName, source: "overview.md", itemNumber: 0 });

  const prompt = [
    `Read the following content from a repository's ideas/overview.md file.`,
    `Determine whether the repository owner wants idea generation to be disabled or turned off.`,
    ``,
    `<content>`,
    guarded,
    `</content>`,
    ``,
    `Respond with ONLY "yes" if idea generation should be disabled, or "no" if it should remain enabled.`,
  ].join("\n");

  try {
    const model = getModel("sonnet", "opencode");
    const output = await claude.runClaude(prompt, repoDir, { tier: "sonnet", model, agent: "plan" });
    const disabled = /\byes\b/i.test(output.trim());
    return { disabled, overviewContent: content };
  } catch (err) {
    log.warn(`[idea-suggester] Failed to check disable status via Claude, defaulting to enabled: ${err}`);
    return { disabled: false, overviewContent: content };
  }
}

export function parseFocusAreasFromOverview(content: string): string[] {
  const lines = content.split("\n");
  let inSection = false;
  const areas: string[] = [];
  for (const line of lines) {
    if (/^##\s+Focus Areas\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) break;
    if (inSection) {
      const match = line.match(/^\s*[-*]\s+(.+)$/);
      if (match) areas.push(match[1].trim());
    }
  }
  return areas;
}

export function loadFocusAreas(repoDir: string, overviewContent?: string | null): string[] {
  const content = overviewContent ?? (() => {
    const overviewPath = path.join(repoDir, "ideas", "overview.md");
    if (!fs.existsSync(overviewPath)) return null;
    return fs.readFileSync(overviewPath, "utf-8");
  })();

  if (content) {
    const areas = parseFocusAreasFromOverview(content);
    if (areas.length > 0) return areas;
  }

  // Fallback to legacy focus-areas.md
  const legacyPath = path.join(repoDir, "ideas", "focus-areas.md");
  if (!fs.existsSync(legacyPath)) return [];
  const legacyContent = fs.readFileSync(legacyPath, "utf-8");
  const areas: string[] = [];
  for (const line of legacyContent.split("\n")) {
    const match = line.match(/^\s*[-*]\s+(.+)$/);
    if (match) areas.push(match[1].trim());
  }
  return areas;
}

const IdeaSchema = z.object({
  title: z.string(),
  description: z.string(),
  score: z.number().catch(0),
});
const SuggestionsResponseSchema = z.object({
  focusAreas: z.array(z.unknown()).optional(),
  ideas: z.record(z.string(), z.array(z.unknown())).optional(),
});

export type Idea = z.infer<typeof IdeaSchema>;

interface Suggestions {
  focusAreas: string[];
  ideas: Record<string, Idea[]>;
}

export interface ProcessResult {
  repo: string;
  status: "filed" | "no-suggestions" | "skipped-no-clone" | "skipped-disabled" | "error";
  ideaCount?: number;
  duplicateCount?: number;
}

export function loadExistingIdeas(repoDir: string): string {
  const ideasDir = path.join(repoDir, "ideas");
  if (!fs.existsSync(ideasDir)) return "";

  const chunks: string[] = [];
  let totalBytes = 0;

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (totalBytes >= MAX_IDEAS_TEXT_BYTES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const content = fs.readFileSync(full, "utf-8");
        const relative = path.relative(path.join(repoDir, "ideas"), full);
        const header = `\n## File: ideas/${relative}\n\n`;
        const available = MAX_IDEAS_TEXT_BYTES - totalBytes;
        const text = header + content.slice(0, available);
        chunks.push(text);
        totalBytes += Buffer.byteLength(text, "utf-8");
      }
    }
  }

  walk(ideasDir);
  return chunks.join("\n");
}

export function buildPrompt(
  fullName: string,
  existingIdeasText: string,
  openIssueTitles: string[],
  openPRTitles: string[],
  resources: string = "",
  declaredFocusAreas: string[] = [],
): string {
  const guardCtx = makeGuardCtx(fullName, 0);
  const issueList = formatGuardedTitleList(openIssueTitles, guardCtx, "issue-title");
  const prList = formatGuardedTitleList(openPRTitles, guardCtx, "pr-title");

  const existingSection = existingIdeasText
    ? [
        `The following ideas have already been suggested, investigated, or rejected.`,
        `Do NOT re-suggest any of these:`,
        ``,
        existingIdeasText,
        ``,
      ].join("\n")
    : "No previous ideas exist for this repository yet.";

  return [
    `You are analyzing the repository ${fullName} to suggest new ideas.`,
    ``,
    HOST_EXECUTION_POLICY,
    ``,
    `If \`docs/OVERVIEW.md\` exists, read it first (and any linked documents that`,
    `seem relevant) for context about the codebase, its audience, and goals.`,
    ``,
    `Analyze the repository to understand what it does, who its users are, and`,
    `what direction it could grow in. Then:`,
    ``,
    ...(declaredFocusAreas.length > 0
      ? [
          `1. This repository has declared the following focus areas:`,
          ...declaredFocusAreas.map((a) => `   - ${a}`),
          ``,
          `   Generate ideas for these areas. You may also suggest up to 2 additional`,
          `   focus areas if you identify strong opportunities, but the declared areas`,
          `   should be the primary focus.`,
        ]
      : [
          `1. Identify 3-7 **focus areas** — broad categories where this repository`,
          `   would benefit from new ideas. These should be specific to the repo, not`,
          `   generic. Examples: "multiplayer support", "developer onboarding",`,
          `   "performance optimization", "community engagement".`,
        ]),
    `2. Generate ideas grouped by those focus areas.`,
    ``,
    ...(resources
      ? [
          `The following reference material may help inspire ideas. Use it where relevant`,
          `to the repository — not every strategy applies to every project:`,
          ``,
          `<resources>`,
          resources,
          `</resources>`,
          ``,
        ]
      : []),
    existingSection,
    ``,
    `The following issues are already open — do NOT re-suggest these:`,
    issueList,
    ``,
    `The following PRs are already open — do NOT re-suggest these:`,
    prList,
    ``,
    `Guidelines:`,
    `- Be creative but realistic. Suggestions should be actionable and relevant.`,
    `- Empty results are perfectly acceptable — do not manufacture suggestions.`,
    `- Each suggestion needs a short title and a detailed description.`,
    `- Generate as many ideas as you like, but assign each idea a score from 1 to 10 (10 = highest value). Only ideas scoring ${MIN_IDEA_SCORE} or above are kept, and at most ${MAX_IDEAS_PER_REPO} are filed.`,
    `- Filed ideas become GitHub issues directly with no human triage step, so only score ${MIN_IDEA_SCORE}+ if you would be happy for the work to be planned.`,
    `- Score ideas based on impact, feasibility, and alignment with the project's goals.`,
    ``,
    `Respond with ONLY a JSON block in this exact format, no other text:`,
    ``,
    "```json",
    `{`,
    `  "focusAreas": ["Area 1", "Area 2", "Area 3"],`,
    `  "ideas": {`,
    `    "Area 1": [`,
    `      { "title": "Short title", "description": "Detailed description", "score": 8 }`,
    `    ],`,
    `    "Area 2": [`,
    `      { "title": "Short title", "description": "Detailed description", "score": 6 }`,
    `    ]`,
    `  }`,
    `}`,
    "```",
  ].join("\n");
}

export function parseSuggestions(output: string): Suggestions {
  const empty: Suggestions = { focusAreas: [], ideas: {} };

  const data = parseFirstValidJson(output, SuggestionsResponseSchema, "idea-suggester");
  if (!data) return empty;

  const focusAreas = (data.focusAreas ?? []).filter(
    (a): a is string => typeof a === "string",
  );
  const ideas: Record<string, Idea[]> = {};
  for (const [area, entries] of Object.entries(data.ideas ?? {})) {
    const valid = entries
      .map((item) => IdeaSchema.safeParse(item))
      .filter((r): r is z.ZodSafeParseSuccess<Idea> => r.success)
      .map((r) => r.data);
    if (valid.length > 0) ideas[area] = valid;
  }
  return { focusAreas, ideas };
}

/** Flatten all ideas from a Suggestions object into a list with focus area attached, sorted by score descending. */
function flattenIdeas(suggestions: Suggestions): { title: string; description: string; focusArea: string; score: number }[] {
  const result: { title: string; description: string; focusArea: string; score: number }[] = [];
  for (const area of suggestions.focusAreas) {
    const areaIdeas = suggestions.ideas[area];
    if (!areaIdeas) continue;
    for (const idea of areaIdeas) {
      result.push({ title: idea.title, description: idea.description, focusArea: area, score: idea.score });
    }
  }
  result.sort((a, b) => b.score - a.score);
  return result;
}

export async function processRepo(repo: Repo): Promise<ProcessResult> {
  try {
    return await processRepoInner(repo);
  } catch (err) {
    reportError("idea-suggester:process-repo", repo.fullName, err);
    return { repo: repo.fullName, status: "error" };
  }
}

async function processRepoInner(repo: Repo): Promise<ProcessResult> {
  const fullName = repo.fullName;

  // Skip repos without local clones
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return { repo: fullName, status: "skipped-no-clone" };

  // Skip if idea generation is disabled via overview.md
  const { disabled, overviewContent } = await isIdeaGenerationDisabled(repoDir, fullName);
  if (disabled) {
    log.info(`[idea-suggester] Skipping ${fullName} — idea generation disabled via overview.md`);
    return { repo: fullName, status: "skipped-disabled" };
  }

  // Load existing ideas from the local clone for dedup context
  const existingIdeasText = loadExistingIdeas(repoDir);

  // Fetch open issue/PR titles for dedup context
  const openIssues = await gh.listOpenIssues(fullName);
  const openIssueTitles = openIssues.map((i) => i.title);
  const openPRs = await gh.listPRs(fullName);
  const openPRTitles = openPRs.map((p) => p.title);

  // Create worktree and run Claude
  const branch = `claws/ideas-${claude.randomSuffix()}`;

  return await db.withTaskRecording("idea-suggester", fullName, 0, null, async (taskId) => {
    return await claude.withNewWorktree(repo, branch, "idea-suggester", async (wt) => {
      db.updateTaskWorktree(taskId, wt, branch);

      const declaredFocusAreas = loadFocusAreas(repoDir, overviewContent);

      log.info(`[idea-suggester] Analyzing ${fullName}`);
      const prompt = buildPrompt(fullName, existingIdeasText, openIssueTitles, openPRTitles, MARKETING_RESOURCE, declaredFocusAreas);
      const model = getModel("sonnet", "opencode");
      db.updateTaskModel(taskId, model);
      const output = await claude.runClaude(prompt, wt, { tier: "sonnet", model, agent: "plan", onTokensUsed: db.trackTaskTokens(taskId) });

      const suggestions = parseSuggestions(output);

      if (Object.keys(suggestions.ideas).length === 0) {
        log.info(`[idea-suggester] No suggestions for ${fullName}`);
        db.recordTaskComplete(taskId, { commits: 0 });
        return { repo: fullName, status: "no-suggestions" } as ProcessResult;
      }

      const allIdeas = flattenIdeas(suggestions).filter((i) => i.score >= MIN_IDEA_SCORE);
      if (allIdeas.length === 0) {
        log.info(`[idea-suggester] No ideas scoring ${MIN_IDEA_SCORE}+ for ${fullName}`);
        db.recordTaskComplete(taskId, { commits: 0 });
        return { repo: fullName, status: "no-suggestions" } as ProcessResult;
      }
      if (allIdeas.length > MAX_IDEAS_PER_REPO) {
        log.info(`[idea-suggester] Ranked ${allIdeas.length} ideas, filing top ${MAX_IDEAS_PER_REPO} for ${fullName}`);
      }
      const ideasList = allIdeas.slice(0, MAX_IDEAS_PER_REPO);

      // Sequential on purpose: createIssue invalidates the open-issues cache, so the
      // next findIssueByExactTitle re-reads it and dedups against ideas filed moments ago.
      const filed: number[] = [];
      let duplicateCount = 0;
      for (const idea of ideasList) {
        const existing = await gh.findIssueByExactTitle(fullName, idea.title);
        if (existing) {
          duplicateCount++;
          log.info(`[idea-suggester] Skipping "${idea.title}" — already open as #${existing.number} in ${fullName}`);
          continue;
        }
        const body = [
          idea.description,
          ``,
          `*Focus area: ${idea.focusArea}*`,
          ``,
          `*Filed automatically by the claws idea-suggester (score ${idea.score}/10).*`,
        ].join("\n");
        try {
          const number = await gh.createIssue(fullName, idea.title, body, []);
          filed.push(number);
          log.info(`[idea-suggester] Filed #${number} "${idea.title}" in ${fullName}`);
        } catch (err) {
          log.error(`[idea-suggester] Failed to file issue "${idea.title}" in ${fullName}: ${err}`);
        }
      }

      db.recordTaskComplete(taskId, { commits: 0 });
      return { repo: fullName, status: "filed", ideaCount: filed.length, duplicateCount } as ProcessResult;
    });
  });
}

export function buildSummary(results: ProcessResult[]): string {
  const relevant = results.filter((r) => r.status !== "skipped-no-clone");
  if (relevant.length === 0) return "";

  const filed = relevant.filter((r) => r.status === "filed");
  const noSuggestions = relevant.filter((r) => r.status === "no-suggestions");
  const disabled = relevant.filter((r) => r.status === "skipped-disabled");
  const errors = relevant.filter((r) => r.status === "error");

  const totalIdeas = filed.reduce((sum, r) => sum + (r.ideaCount ?? 0), 0);
  const totalDuplicates = filed.reduce((sum, r) => sum + (r.duplicateCount ?? 0), 0);

  const s = (n: number) => (n === 1 ? "" : "s");

  const lines: string[] = [
    `Idea Suggester Summary — ${relevant.length} repo${s(relevant.length)} scanned`,
  ];

  if (filed.length > 0) {
    lines.push(`- ${filed.length} repo${s(filed.length)} had ideas filed (${totalIdeas} issue${s(totalIdeas)} created, ${totalDuplicates} duplicate${s(totalDuplicates)} skipped)`);
  }
  if (noSuggestions.length > 0) {
    lines.push(`- ${noSuggestions.length} analyzed, no new suggestions: ${noSuggestions.map((r) => r.repo).join(", ")}`);
  }
  if (disabled.length > 0) {
    lines.push(`- ${disabled.length} skipped (ideas disabled): ${disabled.map((r) => r.repo).join(", ")}`);
  }
  if (errors.length > 0) {
    lines.push(`- ${errors.length} error${s(errors.length)}: ${errors.map((r) => r.repo).join(", ")}`);
  }

  return lines.join("\n");
}

export async function run(repos: Repo[]): Promise<void> {
  const settled = await mapSettledWithConcurrency(repos, MAX_CONCURRENT_REPOS, processRepo);
  const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const summary = buildSummary(results);
  if (summary) log.info(`[idea-suggester] ${summary}`);
}
