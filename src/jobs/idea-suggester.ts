import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import * as slack from "../slack.js";
import { reportError } from "../error-reporter.js";
import { MARKETING_RESOURCE } from "../resources/marketing.js";

const MAX_IDEAS_TEXT_BYTES = 50_000;

interface Idea {
  title: string;
  description: string;
}

interface Suggestions {
  focusAreas: string[];
  ideas: Record<string, Idea[]>;
}

export interface PendingIdea {
  messageTs: string;
  title: string;
  description: string;
  focusArea: string;
}

export interface PendingIdeasFile {
  repo: string;
  channel: string;
  threadTs: string;
  postedAt: string;
  ideas: PendingIdea[];
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
): string {
  const issueList =
    openIssueTitles.length > 0
      ? openIssueTitles.map((t) => `  - ${t}`).join("\n")
      : "  (none)";

  const prList =
    openPRTitles.length > 0
      ? openPRTitles.map((t) => `  - ${t}`).join("\n")
      : "  (none)";

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
    `1. Identify 3-7 **focus areas** — broad categories where this repository`,
    `   would benefit from new ideas. These should be specific to the repo, not`,
    `   generic. Examples: "multiplayer support", "developer onboarding",`,
    `   "performance optimization", "community engagement".`,
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
    ``,
    `Respond with ONLY a JSON block in this exact format, no other text:`,
    ``,
    "```json",
    `{`,
    `  "focusAreas": ["Area 1", "Area 2", "Area 3"],`,
    `  "ideas": {`,
    `    "Area 1": [`,
    `      { "title": "Short title", "description": "Detailed description" }`,
    `    ],`,
    `    "Area 2": [`,
    `      { "title": "Short title", "description": "Detailed description" }`,
    `    ]`,
    `  }`,
    `}`,
    "```",
  ].join("\n");
}

export function parseSuggestions(output: string): Suggestions {
  const empty: Suggestions = { focusAreas: [], ideas: {} };

  const fenceMatch = output.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : null;

  const rawMatch =
    jsonStr ??
    (output.match(/\{[\s\S]*"focusAreas"[\s\S]*\}/)?.[0] ?? null);

  if (!rawMatch) {
    log.warn("[idea-suggester] Could not find JSON in Claude output");
    return empty;
  }

  try {
    const parsed = JSON.parse(rawMatch) as {
      focusAreas?: unknown;
      ideas?: unknown;
    };

    const isValidEntry = (
      item: unknown,
    ): item is Idea =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { title: unknown }).title === "string" &&
      typeof (item as { description: unknown }).description === "string";

    const focusAreas = Array.isArray(parsed.focusAreas)
      ? parsed.focusAreas.filter((a): a is string => typeof a === "string")
      : [];

    const ideas: Record<string, Idea[]> = {};
    if (parsed.ideas && typeof parsed.ideas === "object" && !Array.isArray(parsed.ideas)) {
      for (const [area, entries] of Object.entries(parsed.ideas)) {
        if (Array.isArray(entries)) {
          const valid = entries.filter(isValidEntry);
          if (valid.length > 0) ideas[area] = valid;
        }
      }
    }

    return { focusAreas, ideas };
  } catch (err) {
    log.warn(`[idea-suggester] Failed to parse JSON: ${err}`);
    return empty;
  }
}

export function formatOverviewContent(suggestions: Suggestions): string {
  const sections: string[] = ["# Suggested Ideas"];

  if (suggestions.focusAreas.length > 0) {
    sections.push("");
    sections.push("## Focus Areas");
    sections.push("Areas where this repository is looking for ideas:");
    for (const area of suggestions.focusAreas) {
      sections.push(`- ${area}`);
    }
  }

  for (const area of suggestions.focusAreas) {
    const areaIdeas = suggestions.ideas[area];
    if (!areaIdeas || areaIdeas.length === 0) continue;
    sections.push("");
    sections.push(`## ${area}`);
    for (const idea of areaIdeas) {
      sections.push("");
      sections.push(`### ${idea.title}`);
      sections.push("");
      sections.push(idea.description);
    }
  }

  sections.push("");
  sections.push("---");
  sections.push("*Automated suggestions by claws idea-suggester*");
  sections.push("");

  return sections.join("\n");
}

/** Flatten all ideas from a Suggestions object into a list with focus area attached. */
function flattenIdeas(suggestions: Suggestions): { title: string; description: string; focusArea: string }[] {
  const result: { title: string; description: string; focusArea: string }[] = [];
  for (const area of suggestions.focusAreas) {
    const areaIdeas = suggestions.ideas[area];
    if (!areaIdeas) continue;
    for (const idea of areaIdeas) {
      result.push({ title: idea.title, description: idea.description, focusArea: area });
    }
  }
  return result;
}

async function processRepo(repo: Repo): Promise<void> {
  const fullName = repo.fullName;

  // Skip repos without local clones
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  if (!fs.existsSync(repoDir)) return;

  if (!slack.isSlackBotConfigured()) {
    log.warn(`[idea-suggester] Skipping ${fullName} — Slack bot not configured`);
    return;
  }

  // Skip if there's already a pending ideas file for this repo
  const pendingPath = getPendingIdeasPath(fullName);
  if (fs.existsSync(pendingPath)) {
    log.info(`[idea-suggester] Skipping ${fullName} — pending ideas awaiting collection`);
    return;
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
  const taskId = db.recordTaskStart("idea-suggester", fullName, 0, null);
  let wt: string | undefined;

  try {
    wt = await claude.createWorktree(repo, branch, "idea-suggester");
    db.updateTaskWorktree(taskId, wt, branch);

    log.info(`[idea-suggester] Analyzing ${fullName}`);
    const prompt = buildPrompt(fullName, existingIdeasText, openIssueTitles, openPRTitles, MARKETING_RESOURCE);
    const output = await claude.enqueue(() => claude.runClaude(prompt, wt!));

    const suggestions = parseSuggestions(output);

    if (Object.keys(suggestions.ideas).length === 0) {
      log.info(`[idea-suggester] No suggestions for ${fullName}`);
      db.recordTaskComplete(taskId);
      return;
    }

    const ideasList = flattenIdeas(suggestions);
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
        await new Promise((resolve) => setTimeout(resolve, 1000));
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
    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wt) {
      await claude.removeWorktree(repo, wt);
    }
  }
}

export async function run(repos: Repo[]): Promise<void> {
  const tasks = repos.map((repo) =>
    processRepo(repo).catch((err) =>
      reportError("idea-suggester:process-repo", repo.fullName, err),
    ),
  );
  await Promise.allSettled(tasks);
}
