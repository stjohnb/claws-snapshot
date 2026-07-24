import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import * as slack from "../slack.js";
import { reportError } from "../error-reporter.js";
import * as smartSchedule from "../smart-schedule.js";
import { formatGuardedTitleList, guardContent, makeGuardCtx } from "../prompt-guard.js";
import { MARKETING_RESOURCE } from "../resources/marketing.js";
import { getModel } from "../model-selector.js";
import { sleep } from "../util.js";
import { parseFirstValidJson } from "../json-extract.js";

const MAX_IDEAS_TEXT_BYTES = 50_000;
const MAX_IDEAS_PER_REPO = 5;

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
    const model = getModel("sonnet", "text-only", "opencode");
    const output = await claude.runClaude(prompt, repoDir, { capability: "text-only", tier: "sonnet", model, agent: "plan" });
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

export const PendingIdeaSchema = z.object({
  messageTs: z.string(),
  title: z.string(),
  description: z.string(),
  focusArea: z.string(),
});

export const PendingIdeasFileSchema = z.object({
  repo: z.string(),
  channel: z.string(),
  threadTs: z.string(),
  postedAt: z.string(),
  ideas: z.array(PendingIdeaSchema),
});

export type PendingIdea = z.infer<typeof PendingIdeaSchema>;
export type PendingIdeasFile = z.infer<typeof PendingIdeasFileSchema>;

interface ProcessResult {
  repo: string;
  status: "posted" | "no-suggestions" | "skipped-pending" | "skipped-no-clone" | "skipped-disabled" | "error";
  ideaCount?: number;
}

const PENDING_IDEAS_DIR = path.join(WORK_DIR, "pending-ideas");

export function getPendingIdeasPath(repo: string): string {
  return path.join(PENDING_IDEAS_DIR, `${repo.replace("/", "-")}.json`);
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
    `- Generate as many ideas as you like, but assign each idea a score from 1 to 10 (10 = highest value). Only the top ${MAX_IDEAS_PER_REPO} will be shown.`,
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
  return smartSchedule.withDailyRepoMarking(
    "idea-suggester",
    repo.fullName,
    () => processRepoInner(repo),
    (err) => {
      reportError("idea-suggester:process-repo", repo.fullName, err);
      return { repo: repo.fullName, status: "error" as const };
    },
  );
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

  // Skip if there's already a pending ideas file for this repo
  const pendingPath = getPendingIdeasPath(fullName);
  if (fs.existsSync(pendingPath)) {
    log.info(`[idea-suggester] Skipping ${fullName} — pending ideas awaiting collection`);
    return { repo: fullName, status: "skipped-pending" };
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
      const model = getModel("sonnet", "text-only", "opencode");
      db.updateTaskModel(taskId, model);
      const output = await claude.runClaude(prompt, wt, { capability: "text-only", tier: "sonnet", model, agent: "plan", onTokensUsed: db.trackTaskTokens(taskId) });

      const suggestions = parseSuggestions(output);

      if (Object.keys(suggestions.ideas).length === 0) {
        log.info(`[idea-suggester] No suggestions for ${fullName}`);
        db.recordTaskComplete(taskId, { commits: 0 });
        return { repo: fullName, status: "no-suggestions" } as ProcessResult;
      }

      const allIdeas = flattenIdeas(suggestions);
      if (allIdeas.length > MAX_IDEAS_PER_REPO) {
        log.info(`[idea-suggester] Ranked ${allIdeas.length} ideas, showing top ${MAX_IDEAS_PER_REPO} for ${fullName}`);
      }
      const ideasList = allIdeas.slice(0, MAX_IDEAS_PER_REPO);
      const { SLACK_IDEAS_CHANNEL } = await import("../config.js");

      // Post header message to start the thread
      const threadTs = await slack.postMessage(
        SLACK_IDEAS_CHANNEL,
        `💡 New ideas for *${fullName}* — React to indicate disposition`,
      );

      // Post each idea as a thread reply with a small delay to avoid rate limits
      const pendingIdeas: PendingIdea[] = [];
      for (const idea of ideasList) {
        const text = [
          `*${idea.title}*`,
          ``,
          idea.description,
          ``,
          `_Focus area: ${idea.focusArea}_`,
          ``,
          `React: ✅ accept | 🤔 potential | ❌ reject`,
        ].join("\n");

        const messageTs = await slack.postMessage(SLACK_IDEAS_CHANNEL, text, threadTs);
        pendingIdeas.push({
          messageTs,
          title: idea.title,
          description: idea.description,
          focusArea: idea.focusArea,
        });

        // Small delay between posts to respect Slack rate limits
        if (ideasList.indexOf(idea) < ideasList.length - 1) {
          await sleep(1000);
        }
      }

      // Write pending ideas file
      fs.mkdirSync(PENDING_IDEAS_DIR, { recursive: true });
      const pendingFile: PendingIdeasFile = {
        repo: fullName,
        channel: SLACK_IDEAS_CHANNEL,
        threadTs,
        postedAt: new Date().toISOString(),
        ideas: pendingIdeas,
      };
      fs.writeFileSync(pendingPath, JSON.stringify(pendingFile, null, 2));

      log.info(`[idea-suggester] Posted ${pendingIdeas.length} ideas to Slack for ${fullName}`);
      db.recordTaskComplete(taskId, { commits: 0 });
      return { repo: fullName, status: "posted", ideaCount: pendingIdeas.length } as ProcessResult;
    });
  });
}

async function postSummary(results: ProcessResult[]): Promise<void> {
  const relevant = results.filter((r) => r.status !== "skipped-no-clone");
  if (relevant.length === 0) return;

  const posted = relevant.filter((r) => r.status === "posted");
  const noSuggestions = relevant.filter((r) => r.status === "no-suggestions");
  const pending = relevant.filter((r) => r.status === "skipped-pending");
  const disabled = relevant.filter((r) => r.status === "skipped-disabled");
  const errors = relevant.filter((r) => r.status === "error");

  const totalIdeas = posted.reduce((sum, r) => sum + (r.ideaCount ?? 0), 0);

  const s = (n: number) => (n === 1 ? "" : "s");

  const lines: string[] = [
    `📊 *Idea Suggester Summary* — ${relevant.length} repo${s(relevant.length)} scanned`,
  ];

  if (posted.length > 0) {
    lines.push(`• ${posted.length} repo${s(posted.length)} received new ideas (${totalIdeas} total)`);
  }
  if (noSuggestions.length > 0) {
    lines.push(`• ${noSuggestions.length} analyzed, no new suggestions: ${noSuggestions.map((r) => r.repo).join(", ")}`);
  }
  if (pending.length > 0) {
    lines.push(`• ${pending.length} skipped (pending collection): ${pending.map((r) => r.repo).join(", ")}`);
  }
  if (disabled.length > 0) {
    lines.push(`• ${disabled.length} skipped (ideas disabled): ${disabled.map((r) => r.repo).join(", ")}`);
  }
  if (errors.length > 0) {
    lines.push(`• ${errors.length} error${s(errors.length)}: ${errors.map((r) => r.repo).join(", ")}`);
  }

  const { SLACK_IDEAS_CHANNEL } = await import("../config.js");
  try {
    await slack.postMessage(SLACK_IDEAS_CHANNEL, lines.join("\n"));
  } catch (err) {
    log.warn(`[idea-suggester] Failed to post summary: ${err}`);
  }
}

export async function run(repos: Repo[]): Promise<void> {
  if (!slack.isSlackBotConfigured()) {
    log.warn("[idea-suggester] Slack bot not configured — skipping all repos");
    return;
  }

  const results = await Promise.all(repos.map((repo) => processRepo(repo)));

  await postSummary(results);
}
