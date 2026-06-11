import fs from "node:fs";
import path from "node:path";
import { KWYJIBO_BASE_URL, KWYJIBO_API_KEY, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { getItemTimeoutMs, handleTimeoutIfApplicable } from "../timeout-handler.js";
import { processTextForImages } from "../images.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { getModel } from "../model-selector.js";
import { classifyComplexity } from "../classify-complexity.js";

export const REPORT_HEADER = "## Bug Investigation Report";
const MAX_DEBUG_LOG_SIZE = 50_000;

interface DebugData {
  debugLogs: string | null;
  debugLogsFetchError: string | null;
  turns: string | null;
  pgNetErrors: string | null;
  pgNetErrorsFetchError: string | null;
}

export function extractGameId(body: string): string | null {
  // URL pattern: /games/<uuid>/
  const urlMatch = body.match(/\/games\/([a-f0-9-]{36})\b/i);
  if (urlMatch) return urlMatch[1];

  // Labeled pattern: game_id: <uuid> or gameId: <uuid>
  const labelMatch = body.match(/game.?id[:\s]+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (labelMatch) return labelMatch[1];

  // Bare UUID — strip URLs first to avoid matching UUIDs in image/attachment URLs
  const stripped = body.replace(/https?:\/\/\S+/gi, "");
  const uuidMatch = stripped.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (uuidMatch) return uuidMatch[1];

  return null;
}

async function fetchDebugData(gameId: string): Promise<DebugData> {
  const result: DebugData = { debugLogs: null, debugLogsFetchError: null, turns: null, pgNetErrors: null, pgNetErrorsFetchError: null };

  // Debug logs (requires API key)
  if (KWYJIBO_API_KEY) {
    try {
      const resp = await fetch(`${KWYJIBO_BASE_URL}/api/games/${gameId}/debug-logs`, {
        headers: { "x-api-key": KWYJIBO_API_KEY },
      });
      if (resp.ok) {
        const text = await resp.text();
        result.debugLogs = text.length > MAX_DEBUG_LOG_SIZE
          ? text.slice(0, MAX_DEBUG_LOG_SIZE / 2) +
            "\n\n... [TRUNCATED — log too large] ...\n\n" +
            text.slice(-MAX_DEBUG_LOG_SIZE / 2)
          : text;
      } else {
        result.debugLogsFetchError = `HTTP ${resp.status}`;
        log.warn(`[triage-kwyjibo-errors] debug-logs returned ${resp.status} for game ${gameId}`);
      }
    } catch (err) {
      result.debugLogsFetchError = String(err);
      log.warn(`[triage-kwyjibo-errors] Failed to fetch debug-logs for game ${gameId}: ${err}`);
    }
  }

  // Turns (public)
  try {
    const resp = await fetch(`${KWYJIBO_BASE_URL}/api/games/${gameId}/turns`);
    if (resp.ok) {
      result.turns = await resp.text();
    } else {
      log.warn(`[triage-kwyjibo-errors] turns returned ${resp.status} for game ${gameId}`);
    }
  } catch (err) {
    log.warn(`[triage-kwyjibo-errors] Failed to fetch turns for game ${gameId}: ${err}`);
  }

  // pg_net errors (requires API key)
  if (KWYJIBO_API_KEY) {
    try {
      const resp = await fetch(`${KWYJIBO_BASE_URL}/api/games/${gameId}/pg-net-errors`, {
        headers: { "x-api-key": KWYJIBO_API_KEY },
      });
      if (resp.ok) {
        result.pgNetErrors = await resp.text();
      } else {
        result.pgNetErrorsFetchError = `HTTP ${resp.status}`;
        log.warn(`[triage-kwyjibo-errors] pg-net-errors returned ${resp.status} for game ${gameId}`);
      }
    } catch (err) {
      result.pgNetErrorsFetchError = String(err);
      log.warn(`[triage-kwyjibo-errors] Failed to fetch pg-net-errors for game ${gameId}: ${err}`);
    }
  }

  return result;
}

function readDebuggingGuide(wtPath: string): string | null {
  const guidePath = path.join(wtPath, "docs", "debugging-games.md");
  try {
    if (fs.existsSync(guidePath)) {
      return fs.readFileSync(guidePath, "utf-8");
    }
  } catch {
    // Guide not found — this repo may not be kwyjibo
  }
  return null;
}

export function buildInvestigationPrompt(
  fullName: string,
  issue: gh.Issue,
  debugData: DebugData,
  debugGuide: string | null,
): string {
  const guardCtx = makeGuardCtx(fullName, issue.number);
  const sections: string[] = [
    `You are investigating a production bug report for the ${fullName} game.`,
    ``,
    `## Bug Report (GitHub Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))})`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")),
  ];

  if (debugGuide) {
    sections.push(``, `## Debugging Guide`, ``, debugGuide);
  }

  // debugData fields (debugLogs, turns, pgNetErrors) are server-side JSON from the
  // game database / pg_net infrastructure — not user-generated content. Intentionally
  // left unguarded, similar to CI logs in ci-fixer.ts.
  if (debugData.debugLogs) {
    sections.push(``, `## Debug Logs`, ``, "```json", debugData.debugLogs, "```");
  } else if (!KWYJIBO_API_KEY) {
    sections.push(``, `## Debug Logs`, ``, "API key not configured — debug logs could not be retrieved.");
  } else if (debugData.debugLogsFetchError) {
    sections.push(``, `## Debug Logs`, ``, `Failed to retrieve debug logs: ${debugData.debugLogsFetchError}`);
  } else {
    sections.push(``, `## Debug Logs`, ``, "Debug logs unavailable.");
  }

  if (debugData.turns) {
    sections.push(``, `## Turn Results`, ``, "```json", debugData.turns, "```");
  }

  if (debugData.pgNetErrors) {
    sections.push(``, `## pg_net Errors`, ``, "```json", debugData.pgNetErrors, "```");
  } else if (!KWYJIBO_API_KEY) {
    sections.push(``, `## pg_net Errors`, ``, "API key not configured — pg_net errors could not be retrieved.");
  } else if (debugData.pgNetErrorsFetchError) {
    sections.push(``, `## pg_net Errors`, ``, `Failed to retrieve pg_net errors: ${debugData.pgNetErrorsFetchError}`);
  } else {
    sections.push(``, `## pg_net Errors`, ``, "pg_net errors unavailable.");
  }

  sections.push(
    ``,
    `All available debug data (debug logs, turn results, pg_net errors) has already been`,
    `fetched and included above. Do not recommend manually retrieving any of this data.`,
    `Focus your next-step recommendations on code fixes or additional server-side logging.`,
    ``,
    `Follow the debugging workflow from the guide above (if provided). Analyze the data and produce`,
    `an investigation report that includes:`,
    `1. The identified symptom`,
    `2. A timeline of relevant events`,
    `3. The likely root cause (or top candidates if unclear)`,
    `4. Recommended next steps or fix`,
    ``,
    `Be specific — reference event types, timestamps, and data values from the logs.`,
    `If there is insufficient data to determine the cause, say so and suggest what`,
    `additional information would help.`,
    ``,
    `Do NOT make any code changes. Only produce the investigation report as text output.`,
  );

  return sections.join("\n");
}

async function processIssue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[triage-kwyjibo-errors] Investigating ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/investigate-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("triage-kwyjibo-errors", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "triage-kwyjibo-errors", async (wtPath) => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const debugGuide = readDebuggingGuide(wtPath);
      const gameId = extractGameId(issue.body);

      let debugData: DebugData = { debugLogs: null, debugLogsFetchError: null, turns: null, pgNetErrors: null, pgNetErrorsFetchError: null };
      if (gameId) {
        log.info(`[triage-kwyjibo-errors] Extracted game ID ${gameId} from ${fullName}#${issue.number}`);
        debugData = await fetchDebugData(gameId);
      } else {
        log.warn(`[triage-kwyjibo-errors] No game ID found in ${fullName}#${issue.number}, investigating from issue body only`);
      }

      const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
      const imageContext = await processTextForImages([issue.body], wtPath, repo.owner, { repo: fullName, issueNumber: issue.number }, [issueBodyHtml]);
      const prompt = buildInvestigationPrompt(fullName, issue, debugData, debugGuide) + imageContext;
      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      const tier = await classifyComplexity(
        [
          `Bug investigation for ${fullName}#${issue.number}.`,
          `Issue title: ${issue.title}`,
          `Issue body (first 2000 chars):`,
          (issue.body ?? "").slice(0, 2000),
        ].join("\n"),
        wtPath,
      );
      const model = getModel(tier, "text-only", "opencode");
      db.updateTaskModel(taskId, model);
      log.info(`[triage-kwyjibo-errors] Using model "${model}" for ${fullName}#${issue.number}`);
      let taskTokensUsed: number | undefined;
      let taskCostUsd: number | undefined;
      const output = await claude.runClaude(prompt, wtPath, { capability: "text-only", timeoutMs, tier, model, agent: "plan", onTokensUsed: (t, c) => { taskTokensUsed = t; taskCostUsd = c; } });
      if (taskTokensUsed !== undefined && taskCostUsd !== undefined) {
        db.updateTaskTokenUsage(taskId, taskTokensUsed, taskCostUsd);
      }

      if (output.trim()) {
        await gh.commentOnIssue(fullName, issue.number, `${REPORT_HEADER}\n\n${output}`);
        log.info(`[triage-kwyjibo-errors] Posted investigation report for ${fullName}#${issue.number}`);
      } else {
        log.warn(`[triage-kwyjibo-errors] Empty investigation output for ${fullName}#${issue.number}`);
      }

      db.recordTaskComplete(taskId, { commits: 0 });
    });
  });
}

export async function run(repos: Repo[]): Promise<void> {
  const repo = repos.find((r) => r.name === "kwyjibo");
  if (!repo) return;
  if (isRateLimited()) return;

  const tasks: Promise<void>[] = [];

  try {
    const issues = await gh.listOpenIssues(repo.fullName);
    for (const issue of issues) {
      if (gh.isItemSkipped(repo.fullName, issue.number)) continue;
      if (gh.hasIgnoreLabel(issue.labels)) continue;
      if (!await gh.isAllowedActor(issue.author.login)) continue;
      const gameId = extractGameId(issue.body);
      if (!gameId) continue;

      // Check if investigation report already exists
      const comments = await gh.getIssueComments(repo.fullName, issue.number);
      const hasReport = comments.some((c) => c.body.includes(REPORT_HEADER));
      if (hasReport) {
        gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels), labels: issue.labels.map((l) => l.name) });
        continue;
      }

      gh.populateQueueCache("needs-triage", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels), labels: issue.labels.map((l) => l.name) });
      tasks.push(
        processIssue(repo, issue).catch(async (err) => {
          await handleTimeoutIfApplicable("triage-kwyjibo-errors", repo.fullName, issue.number, err);
          await reportError("triage-kwyjibo-errors:process-issue", `${repo.fullName}#${issue.number}`, err);
        }),
      );
    }
  } catch (err) {
    reportError("triage-kwyjibo-errors:list-issues", repo.fullName, err);
  }

  await Promise.allSettled(tasks);
}
