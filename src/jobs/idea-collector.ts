import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as slack from "../slack.js";
import { reportError } from "../error-reporter.js";
import { parseFocusAreasFromOverview, type PendingIdeasFile, type PendingIdea, PendingIdeasFileSchema } from "./idea-suggester.js";

const PENDING_IDEAS_DIR = path.join(WORK_DIR, "pending-ideas");

/** Maximum time to wait for reactions before treating unreacted ideas as "potential". */
const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Upper-bound timeout: if no reactions arrive at all within this window, give up. */
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type Disposition = "accepted" | "potential" | "rejected";

interface ClassifiedIdea extends PendingIdea {
  disposition: Disposition;
  issueNumber?: number;
}

/**
 * Append formatted entries to a Markdown file, creating it with `defaultHeader`
 * if absent. Reads current content once, appends all entries, writes once.
 * No-op when `ideas` is empty so an empty file is never created.
 */
function appendEntries(
  filePath: string,
  defaultHeader: string,
  ideas: ClassifiedIdea[],
  formatEntry: (idea: ClassifiedIdea) => string,
): void {
  if (ideas.length === 0) return;
  let content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : defaultHeader;
  for (const idea of ideas) {
    content += formatEntry(idea);
  }
  fs.writeFileSync(filePath, content);
}

/**
 * Determine disposition from Slack reactions.
 * Priority: ✅ > ❌ > 🤔
 */
export function classifyReactions(reactions: slack.SlackReaction[]): Disposition | null {
  const names = new Set(reactions.map((r) => r.name));
  if (names.has("white_check_mark")) return "accepted";
  if (names.has("x")) return "rejected";
  if (names.has("thinking_face")) return "potential";
  return null;
}

/**
 * Check if all ideas in a pending file have been resolved (reacted to),
 * or if the timeout has elapsed once at least one idea has a reaction.
 * When zero ideas have reactions, waits up to {@link MAX_WAIT_MS} before
 * treating the batch as ready to prevent indefinite accumulation.
 */
function isReady(
  ideas: { disposition: Disposition | null }[],
  postedAt: string,
): boolean {
  const allResolved = ideas.every((i) => i.disposition !== null);
  if (allResolved) return true;

  const elapsed = Date.now() - new Date(postedAt).getTime();

  const anyResolved = ideas.some((i) => i.disposition !== null);
  if (!anyResolved) {
    if (elapsed >= MAX_WAIT_MS) {
      log.warn(`[idea-collector] No reactions received after ${Math.round(elapsed / 86_400_000)}d — giving up on batch posted at ${postedAt}`);
      return true;
    }
    return false;
  }

  return elapsed >= TIMEOUT_MS;
}

const PR_TITLE_PREFIX = "[claws-ideas]";

export async function run(repos: Repo[]): Promise<void> {
  if (!fs.existsSync(PENDING_IDEAS_DIR)) return;

  const files = fs.readdirSync(PENDING_IDEAS_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return;

  for (const file of files) {
    try {
      await processPendingFile(path.join(PENDING_IDEAS_DIR, file), repos);
    } catch (err) {
      reportError("idea-collector:process-file", file, err);
    }
  }
}

async function processPendingFile(filePath: string, repos: Repo[]): Promise<void> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const pending: PendingIdeasFile = PendingIdeasFileSchema.parse(JSON.parse(raw));

  // Find the matching Repo object
  const repo = repos.find((r) => r.fullName === pending.repo);
  if (!repo) {
    log.info(`[idea-collector] Skipping ${pending.repo} — repo not in current repos list`);
    return;
  }

  // Poll reactions for each idea
  const classified: (PendingIdea & { disposition: Disposition | null })[] = [];
  for (const idea of pending.ideas) {
    try {
      const reactions = await slack.getReactions(pending.channel, idea.messageTs);
      const disposition = classifyReactions(reactions);
      classified.push({ ...idea, disposition });
    } catch (err) {
      log.warn(`[idea-collector] Failed to get reactions for ${idea.title}: ${err}`);
      classified.push({ ...idea, disposition: null });
    }
  }

  // Check if ready to process
  if (!isReady(classified, pending.postedAt)) {
    log.info(`[idea-collector] ${pending.repo} — not all ideas resolved yet, will check later`);
    return;
  }

  // Resolve dispositions: unreacted ideas become "potential" after timeout
  const resolved: ClassifiedIdea[] = classified.map((idea) => ({
    ...idea,
    disposition: idea.disposition ?? "potential",
  }));

  // Create GH issues for accepted ideas
  const accepted = resolved.filter((i) => i.disposition === "accepted");
  for (const idea of accepted) {
    try {
      // Dedup: skip if an open issue with the same title already exists
      const exactMatch = await gh.findIssueByExactTitle(pending.repo, idea.title);
      if (exactMatch) {
        log.info(`[idea-collector] Skipping issue creation for "${idea.title}" — already exists as #${exactMatch.number}`);
        idea.issueNumber = exactMatch.number;
        continue;
      }

      const issueNumber = await gh.createIssue(
        pending.repo,
        idea.title,
        idea.description,
        [],
      );
      idea.issueNumber = issueNumber;
      log.info(`[idea-collector] Created issue #${issueNumber} for "${idea.title}" in ${pending.repo}`);
    } catch (err) {
      log.error(`[idea-collector] Failed to create issue for "${idea.title}": ${err}`);
    }
  }

  const potential = resolved.filter((i) => i.disposition === "potential");
  const rejected = resolved.filter((i) => i.disposition === "rejected");

  // Create collection PR
  const branch = `claws/ideas-collect-${claude.randomSuffix()}`;

  await claude.withNewWorktree(repo, branch, "idea-collector", async (wt) => {
    const ideasDir = path.join(wt, "ideas");
    fs.mkdirSync(ideasDir, { recursive: true });

    // Populate focus areas in overview.md if none are declared yet
    const overviewPath = path.join(ideasDir, "overview.md");
    const hasExplicitAreas = (() => {
      if (fs.existsSync(overviewPath)) {
        const content = fs.readFileSync(overviewPath, "utf-8");
        if (parseFocusAreasFromOverview(content).length > 0) return true;
      }
      // Fallback: check legacy focus-areas.md
      const legacyPath = path.join(ideasDir, "focus-areas.md");
      if (fs.existsSync(legacyPath)) {
        const content = fs.readFileSync(legacyPath, "utf-8");
        return content.split("\n").some((line) => /^\s*[-*]\s+.+$/.test(line));
      }
      return false;
    })();

    if (!hasExplicitAreas) {
      const seen = new Set<string>();
      const uniqueAreas: string[] = [];
      for (const idea of resolved) {
        const lower = idea.focusArea.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          uniqueAreas.push(idea.focusArea);
        }
      }
      if (uniqueAreas.length > 0) {
        const focusSection = [
          "",
          "## Focus Areas",
          "",
          ...uniqueAreas.map((a) => `- ${a}`),
          "",
        ].join("\n");

        if (fs.existsSync(overviewPath)) {
          const existing = fs.readFileSync(overviewPath, "utf-8");
          fs.writeFileSync(overviewPath, existing.trimEnd() + "\n" + focusSection);
        } else {
          fs.writeFileSync(overviewPath, "# Ideas\n" + focusSection);
        }
      }
    }

    // Append accepted ideas to focus-area files, grouped by target file
    const acceptedByFile = new Map<string, { file: string; focusArea: string; ideas: ClassifiedIdea[] }>();
    for (const idea of accepted) {
      const areaSlug = idea.focusArea.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const areaFile = path.join(ideasDir, `${areaSlug}.md`);
      const group = acceptedByFile.get(areaFile);
      if (group) group.ideas.push(idea);
      else acceptedByFile.set(areaFile, { file: areaFile, focusArea: idea.focusArea, ideas: [idea] });
    }
    for (const { file, focusArea, ideas } of acceptedByFile.values()) {
      appendEntries(file, `# ${focusArea}\n`, ideas, (idea) => {
        const issueRef = idea.issueNumber ? ` (#${idea.issueNumber})` : "";
        return `\n### ${idea.title}${issueRef}\n\n${idea.description}\n`;
      });
    }

    // Append potential ideas to potential.md
    appendEntries(
      path.join(ideasDir, "potential.md"),
      "# Potential Ideas\n",
      potential,
      (idea) => `\n### ${idea.title}\n\n${idea.description}\n`,
    );

    // Append rejected ideas to rejected.md (title only)
    appendEntries(
      path.join(ideasDir, "rejected.md"),
      "# Rejected Ideas\n",
      rejected,
      (idea) => `\n- ${idea.title}\n`,
    );

    // Stage, commit, push, create PR
    await claude.git(["add", "ideas/"], wt);

    // Check if there are any changes to commit
    const statusOut = await claude.git(["status", "--porcelain"], wt);
    if (!statusOut.trim()) {
      log.info(`[idea-collector] No changes to commit for ${pending.repo}`);
    } else {
      await claude.git(["commit", "-m", `ideas: collect idea responses for ${repo.name}`], wt);

      await claude.pushBranch(wt, branch, repo.owner);

      const summary = [
        `## Collected Idea Responses`,
        ``,
        `| Idea | Disposition |`,
        `|------|------------|`,
        ...resolved.map((idea) => {
          const disp = idea.disposition === "accepted"
            ? `✅ Accepted${idea.issueNumber ? ` (#${idea.issueNumber})` : ""}`
            : idea.disposition === "rejected"
              ? "❌ Rejected"
              : "🤔 Potential";
          return `| ${idea.title} | ${disp} |`;
        }),
        ``,
        `*Automated by claws idea-collector*`,
      ].join("\n");

      await gh.createPR(
        pending.repo,
        branch,
        `${PR_TITLE_PREFIX} Collected idea responses for ${repo.name}`,
        summary,
      );
    }

    // Post summary to Slack thread
    try {
      const slackSummary = [
        `Collection complete:`,
        `• ${accepted.length} accepted${accepted.length > 0 ? ` (issues created)` : ""}`,
        `• ${potential.length} potential`,
        `• ${rejected.length} rejected`,
      ].join("\n");
      await slack.postMessage(pending.channel, slackSummary, pending.threadTs);
    } catch {
      // Best effort — don't fail the whole process if Slack reply fails
    }

    // Delete pending file
    fs.unlinkSync(filePath);

    log.info(
      `[idea-collector] Processed ${pending.repo}: ${accepted.length} accepted, ${potential.length} potential, ${rejected.length} rejected`,
    );
  });
}
