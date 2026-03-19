import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as slack from "../slack.js";
import { reportError } from "../error-reporter.js";
import type { PendingIdeasFile, PendingIdea } from "./idea-suggester.js";

const execFile = promisify(execFileCb);

const PENDING_IDEAS_DIR = path.join(WORK_DIR, "pending-ideas");

/** Maximum time to wait for reactions before treating unreacted ideas as "potential". */
const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

type Disposition = "accepted" | "potential" | "rejected";

interface ClassifiedIdea extends PendingIdea {
  disposition: Disposition;
  issueNumber?: number;
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
 * or if the timeout has elapsed.
 */
function isReady(
  ideas: { disposition: Disposition | null }[],
  postedAt: string,
): boolean {
  const allResolved = ideas.every((i) => i.disposition !== null);
  if (allResolved) return true;

  const elapsed = Date.now() - new Date(postedAt).getTime();
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
  const pending: PendingIdeasFile = JSON.parse(raw);

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
  let wt: string | undefined;

  try {
    wt = await claude.createWorktree(repo, branch, "idea-collector");

    const ideasDir = path.join(wt, "ideas");
    fs.mkdirSync(ideasDir, { recursive: true });

    // Append accepted ideas to focus-area files
    for (const idea of accepted) {
      const areaSlug = idea.focusArea.toLowerCase().replace(/\s+/g, "-");
      const areaFile = path.join(ideasDir, `${areaSlug}.md`);
      let existing = "";
      if (fs.existsSync(areaFile)) {
        existing = fs.readFileSync(areaFile, "utf-8");
      } else {
        existing = `# ${idea.focusArea}\n`;
      }

      const issueRef = idea.issueNumber ? ` (#${idea.issueNumber})` : "";
      const entry = `\n### ${idea.title}${issueRef}\n\n${idea.description}\n`;
      fs.writeFileSync(areaFile, existing + entry);
    }

    // Append potential ideas to potential.md
    if (potential.length > 0) {
      const potentialFile = path.join(ideasDir, "potential.md");
      let existing = "";
      if (fs.existsSync(potentialFile)) {
        existing = fs.readFileSync(potentialFile, "utf-8");
      } else {
        existing = "# Potential Ideas\n";
      }

      for (const idea of potential) {
        existing += `\n### ${idea.title}\n\n${idea.description}\n`;
      }
      fs.writeFileSync(potentialFile, existing);
    }

    // Append rejected ideas to rejected.md (title only)
    if (rejected.length > 0) {
      const rejectedFile = path.join(ideasDir, "rejected.md");
      let existing = "";
      if (fs.existsSync(rejectedFile)) {
        existing = fs.readFileSync(rejectedFile, "utf-8");
      } else {
        existing = "# Rejected Ideas\n";
      }

      for (const idea of rejected) {
        existing += `\n- ${idea.title}\n`;
      }
      fs.writeFileSync(rejectedFile, existing);
    }

    // Stage, commit, push, create PR
    await execFile("git", ["add", "ideas/"], { cwd: wt });

    // Check if there are any changes to commit
    const { stdout: statusOut } = await execFile("git", ["status", "--porcelain"], { cwd: wt });
    if (!statusOut.trim()) {
      log.info(`[idea-collector] No changes to commit for ${pending.repo}`);
    } else {
      await execFile(
        "git",
        ["commit", "-m", `ideas: collect idea responses for ${repo.name}`],
        { cwd: wt },
      );

      await claude.pushBranch(wt, branch);

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
  } finally {
    if (wt) {
      await claude.removeWorktree(repo, wt);
    }
  }
}
