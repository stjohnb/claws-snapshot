import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import * as smartSchedule from "../smart-schedule.js";
import { reportError } from "../error-reporter.js";

export interface AcceptedIdea {
  issueNumber: number;
  title: string;
  /** Full block text after the heading (may include leading/trailing newlines). */
  block: string;
  sourceFile: string;
  startLine: number;
  /** Exclusive end line. */
  endLine: number;
}

/** Files that are not focus-area files and should not be scanned. */
const SKIP_FILES = new Set(["potential.md", "rejected.md", "overview.md", "focus-areas.md"]);

const HEADING_RE = /^### (.+?) \(#(\d+)\)\s*$/;

const PR_TITLE_PREFIX = "[claws-ideas]";

/**
 * Parse a focus-area markdown file for accepted ideas with issue references.
 * Returns ideas with their line ranges (0-indexed, endLine exclusive).
 */
export function parseAcceptedIdeas(content: string, fileName: string): AcceptedIdea[] {
  const lines = content.split("\n");
  const ideas: AcceptedIdea[] = [];
  let current: { title: string; issueNumber: number; startLine: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]);
    if (match) {
      // Close previous idea
      if (current) {
        ideas.push({
          ...current,
          block: lines.slice(current.startLine + 1, i).join("\n"),
          sourceFile: fileName,
          endLine: i,
        });
      }
      current = {
        title: match[1],
        issueNumber: parseInt(match[2], 10),
        startLine: i,
      };
    } else if (current && /^#{1,3}\s/.test(lines[i])) {
      // Any heading (#, ##, or untracked ###) closes the current block
      ideas.push({
        ...current,
        block: lines.slice(current.startLine + 1, i).join("\n"),
        sourceFile: fileName,
        endLine: i,
      });
      current = null;
    }
  }

  // Close final idea
  if (current) {
    ideas.push({
      ...current,
      block: lines.slice(current.startLine + 1).join("\n"),
      sourceFile: fileName,
      endLine: lines.length,
    });
  }

  return ideas;
}

/**
 * Remove idea blocks (by line range) from file content.
 * Ideas must be sorted by startLine descending to preserve indices.
 */
export function removeIdeasFromContent(content: string, ideas: AcceptedIdea[]): string {
  const lines = content.split("\n");
  // Sort descending by startLine so removals don't shift earlier indices
  const sorted = [...ideas].sort((a, b) => b.startLine - a.startLine);
  for (const idea of sorted) {
    lines.splice(idea.startLine, idea.endLine - idea.startLine);
  }
  // Clean up consecutive blank lines
  const result = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return result;
}

/**
 * Append reconciled ideas to potential.md content.
 */
export function appendToPotential(existing: string, ideas: AcceptedIdea[]): string {
  let result = existing;
  for (const idea of ideas) {
    // Strip leading/trailing blank lines from the block
    const desc = idea.block.replace(/^\n+/, "").replace(/\n+$/, "");
    result += `\n### ${idea.title}\n\n`;
    if (desc) {
      result += `${desc}\n\n`;
    }
    result += `*Previously accepted as #${idea.issueNumber}, closed without implementation.*\n`;
  }
  return result;
}

async function processRepo(repo: Repo): Promise<void> {
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  // Only process repos already cloned by other jobs — don't trigger a fresh clone
  // just for idea reconciliation. ensureClone below pulls the latest changes.
  if (!fs.existsSync(repoDir)) return;

  await claude.ensureClone(repo, { skipFetchIfRecent: true });

  const ideasDir = path.join(repoDir, "ideas");
  if (!fs.existsSync(ideasDir)) return;

  const files = fs.readdirSync(ideasDir).filter(
    (f) => f.endsWith(".md") && !SKIP_FILES.has(f),
  );
  if (files.length === 0) return;

  // Collect all accepted ideas with issue refs across all focus-area files
  const allIdeas: AcceptedIdea[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(ideasDir, file), "utf-8");
    const ideas = parseAcceptedIdeas(content, file);
    allIdeas.push(...ideas);
  }

  if (allIdeas.length === 0) return;

  log.info(
    `[idea-reconciler] ${repo.fullName}: found ${allIdeas.length} accepted idea(s) with issue refs`,
  );

  // Check each issue's state
  const toMove: AcceptedIdea[] = [];
  for (const idea of allIdeas) {
    if (gh.isRateLimited()) {
      log.warn(`[idea-reconciler] Rate limited — stopping ${repo.fullName}`);
      break;
    }

    try {
      const { state, stateReason } = await gh.getIssueState(repo.fullName, idea.issueNumber);
      if (state === "CLOSED" && stateReason !== "COMPLETED") {
        toMove.push(idea);
        log.info(
          `[idea-reconciler] #${idea.issueNumber} "${idea.title}" closed without implementation (reason: ${stateReason ?? "none"})`,
        );
      }
    } catch (err) {
      log.warn(
        `[idea-reconciler] Failed to check issue #${idea.issueNumber}: ${err}`,
      );
    }
  }

  if (toMove.length === 0) {
    log.info(`[idea-reconciler] ${repo.fullName}: no ideas to reconcile`);
    return;
  }

  // Skip if there's already an open reconciliation PR for this repo
  const existingPRs = await gh.searchPRs(repo.fullName, PR_TITLE_PREFIX);
  if (existingPRs.length > 0) {
    log.info(
      `[idea-reconciler] ${repo.fullName}: skipping — open reconciliation PR already exists (#${existingPRs[0].number})`,
    );
    return;
  }

  // Create a worktree and apply changes
  const branch = `claws/ideas-reconcile-${claude.randomSuffix()}`;

  await claude.withNewWorktree(repo, branch, "idea-reconciler", async (wt) => {
    const wtIdeasDir = path.join(wt, "ideas");

    // Group ideas by source file
    const byFile = new Map<string, AcceptedIdea[]>();
    for (const idea of toMove) {
      const list = byFile.get(idea.sourceFile) ?? [];
      list.push(idea);
      byFile.set(idea.sourceFile, list);
    }

    // Remove ideas from focus-area files.
    // Re-parse from worktree content (which may be newer than the main clone)
    // and match by issue number to avoid stale line ranges.
    // Also collect fresh blocks for appending to potential.md.
    const freshIdeas: AcceptedIdea[] = [];
    for (const [file, mainCloneIdeas] of byFile) {
      const filePath = path.join(wtIdeasDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const wtIdeas = parseAcceptedIdeas(content, file);
      const issueNumbers = new Set(mainCloneIdeas.map((i) => i.issueNumber));
      const toRemove = wtIdeas.filter((i) => issueNumbers.has(i.issueNumber));
      freshIdeas.push(...toRemove);
      const updated = removeIdeasFromContent(content, toRemove);
      fs.writeFileSync(filePath, updated);
    }

    // Append to potential.md using fresh worktree blocks (not main clone)
    const potentialPath = path.join(wtIdeasDir, "potential.md");
    let potentialContent = "";
    if (fs.existsSync(potentialPath)) {
      potentialContent = fs.readFileSync(potentialPath, "utf-8");
    } else {
      potentialContent = "# Potential Ideas\n";
    }
    potentialContent = appendToPotential(potentialContent, freshIdeas);
    fs.writeFileSync(potentialPath, potentialContent);

    // Stage, commit, push, create PR
    await claude.git(["add", "ideas/"], wt);

    const statusOut = await claude.git(["status", "--porcelain"], wt);
    if (!statusOut.trim()) {
      log.info(`[idea-reconciler] ${repo.fullName}: no file changes after reconciliation`);
      return;
    }

    const movedList = freshIdeas.map((i) => `#${i.issueNumber} "${i.title}"`).join(", ");
    await claude.git(["commit", "-m", `ideas: reconcile closed ideas back to potential\n\nMoved: ${movedList}`], wt);

    await claude.pushBranch(wt, branch, repo.owner);

    const body = [
      `## Reconciled Ideas`,
      ``,
      `The following accepted ideas had their GitHub issues closed without`,
      `implementation. They have been moved back to \`ideas/potential.md\`.`,
      ``,
      `| Idea | Issue | Close Reason |`,
      `|------|-------|-------------|`,
      ...freshIdeas.map((i) => `| ${i.title} | #${i.issueNumber} | Closed without implementation |`),
      ``,
      `*Automated by claws idea-reconciler*`,
    ].join("\n");

    await gh.createPR(
      repo.fullName,
      branch,
      `${PR_TITLE_PREFIX} Reconcile closed ideas for ${repo.name}`,
      body,
    );

    log.info(
      `[idea-reconciler] ${repo.fullName}: created PR to move ${freshIdeas.length} idea(s) back to potential`,
    );
  });
}

export async function run(repos: Repo[]): Promise<void> {
  for (const repo of repos) {
    if (gh.isRateLimited()) break;
    try {
      await processRepo(repo);
    } catch (err) {
      reportError("idea-reconciler:process-repo", repo.fullName, err);
    }
    db.markRepoProcessedDaily("idea-reconciler", repo.fullName, smartSchedule.localDateString());
  }
}
