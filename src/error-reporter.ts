import { SELF_REPO } from "./config.js";
import { AgentTimeoutError, AgentMemoryLimitError, AgentCliError, PushConflictError } from "./claude.js";
import * as gh from "./github.js";
import { isRateLimited, RateLimitError, TransientGitHubError } from "./github.js";
import * as log from "./log.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";
import { WhisperRateLimitError } from "./transcribe.js";
import { ensureAlertIssue } from "./occurrence-tracking.js";
import { guardContent, makeGuardCtx } from "./prompt-guard.js";

const USAGE_LIMIT_RE = /you['\u2019](?:re out of .*? usage|ve hit your limit)/i;
const API_TRANSIENT_RE = /API Error: 5\d\d|API Error: The socket connection was closed|openai\b.*\berror\b.*\b5\d\d\b/i;
const OUTPUT_TOKEN_LIMIT_RE = /exceeded the \d+ output token maximum/i;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const lastReported = new Map<string, number>();

export async function reportError(
  fingerprint: string,
  context: string,
  error: unknown,
): Promise<void> {
  if (error instanceof ShutdownError) {
    log.info(`[${fingerprint}] ${context}: ${error.message} (shutdown — not reported)`);
    return;
  }

  // RateLimitError is an expected transient condition handled by the circuit
  // breaker — downgrade to warn so individual per-repo failures don't spam Slack.
  if (error instanceof RateLimitError) {
    log.warn(`[${fingerprint}] ${context}: ${error}`);
    return;
  }

  // PushConflictError is a transient race — another actor pushed to the branch
  // while we were working. The task is recorded as failed in the DB so the
  // circuit breaker counts it, and the dispatcher will retry on the next cycle.
  if (error instanceof PushConflictError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (push conflict — not reported)`);
    return;
  }

  // A GitHub-side 5xx that outlived gh()'s retry window (3 retries over ~7s).
  // Self-healing — the task is marked failed in the DB so the circuit breaker
  // counts it, and the dispatcher retries next cycle. Warn only; no issue.
  if (error instanceof TransientGitHubError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (transient GitHub API error — not reported)`);
    return;
  }

  // WhisperRateLimitError is a transient OpenAI rate limit — suppress to warn.
  if (error instanceof WhisperRateLimitError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (Whisper rate limit — not reported)`);
    return;
  }

  // CLI-level errors that match usage-limit messages are transient —
  // the Claude CLI ran out of credits. Downgrade to warn; no GitHub issue needed.
  if (error instanceof AgentCliError && USAGE_LIMIT_RE.test(error.message)) {
    log.warn(`[${fingerprint}] ${context}: ${error.message}`);
    return;
  }

  // Transient API 5xx errors (500, 502, 503, etc.) are self-healing —
  // the dispatcher will re-queue the task. Downgrade to warn; no GitHub issue needed.
  if (error instanceof AgentCliError && API_TRANSIENT_RE.test(error.message)) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (transient API error — not reported)`);
    return;
  }

  // Output token limit errors indicate CLAUDE_CODE_MAX_OUTPUT_TOKENS is not
  // configured. Downgrade to warn with a hint — no GitHub issue needed.
  if (error instanceof AgentCliError && OUTPUT_TOKEN_LIMIT_RE.test(error.message)) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (set CLAUDE_CODE_MAX_OUTPUT_TOKENS in ~/.claws/env to increase the limit — not reported)`);
    return;
  }

  // Transient CLI init failures (0 turns) are already retried in runClaude().
  // If both attempts fail, it's transient — downgrade to warn, no GitHub issue.
  if (error instanceof AgentCliError && error.numTurns === 0) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (transient CLI init failure — not reported)`);
    return;
  }

  // Memory-limit kills are handled by feeding the failure back to the originating
  // issue/PR (see reportMemoryLimitOnItem, called from the worker). The watchdog
  // already killed the process cleanly — no [claws-error] alert needed.
  if (error instanceof AgentMemoryLimitError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (memory limit — reported on the source item, not escalated)`);
    return;
  }

  // Always log to console/Slack regardless of dedup outcome
  log.error(`[${fingerprint}] ${context}: ${error}`);

  if (isShuttingDown()) return;

  if (isRateLimited()) {
    log.warn(`[error-reporter] Skipping report for "${fingerprint}" — rate-limited`);
    return;
  }

  const now = Date.now();
  const lastTime = lastReported.get(fingerprint);
  if (lastTime && now - lastTime < COOLDOWN_MS) {
    log.warn(`[error-reporter] Skipping duplicate report for "${fingerprint}" (cooldown)`);
    return;
  }
  lastReported.set(fingerprint, now);

  try {
    const title = `[claws-error] ${fingerprint}`;
    const errorStr =
      error instanceof Error
        ? error.stack ?? error.message
        : typeof error === "object" && error !== null
          ? JSON.stringify(error, null, 2).slice(0, 5000)
          : String(error);
    const timestamp = new Date().toISOString();

    const diagnostics =
      error instanceof AgentTimeoutError
        ? [
            "",
            "**Diagnostics:**",
            `- Working directory: \`${error.cwd}\``,
            `- Total stdout: ${error.outputBytes} bytes`,
            `- The process ${error.outputBytes === 0 ? "produced no output (likely stuck or waiting for input)" : "was actively producing output"}`,
            "",
            error.lastOutput
              ? `<details><summary>Last stdout (up to 3000 chars)</summary>\n\n\`\`\`\n${error.lastOutput}\n\`\`\`\n</details>`
              : "",
            error.lastStderr
              ? `<details><summary>Last stderr (up to 1000 chars)</summary>\n\n\`\`\`\n${error.lastStderr}\n\`\`\`\n</details>`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "";

    const body = [
      `**Auto-created by Claws error reporter**`,
      "",
      `**Fingerprint:** \`${fingerprint}\``,
      `**Context:** ${context}`,
      `**Timestamp:** ${timestamp}`,
      "",
      "```",
      errorStr,
      "```",
      diagnostics,
    ]
      .filter(Boolean)
      .join("\n");
    await ensureAlertIssue({
      repo: SELF_REPO,
      title,
      body,
      timestamp,
      logPrefix: "error-reporter",
    });
  } catch (reportErr) {
    log.warn(`[error-reporter] Failed to report error for "${fingerprint}": ${reportErr}`);
  }
}

export async function reportFailedAttachments(args: {
  sourceRepo: string;
  sourceIssueNumber: number;
  failedUrls: string[];
  agentName?: string;
}): Promise<void> {
  if (args.failedUrls.length === 0) return;

  if (isShuttingDown()) return;

  if (isRateLimited()) {
    log.warn(`[error-reporter] Skipping reportFailedAttachments — rate-limited`);
    return;
  }

  const fingerprint = `attachment-download-failures:${args.sourceRepo}:${args.sourceIssueNumber}`;
  const now = Date.now();
  const lastTime = lastReported.get(fingerprint);
  if (lastTime && now - lastTime < COOLDOWN_MS) {
    log.warn(`[error-reporter] Skipping duplicate report for "${fingerprint}" (cooldown)`);
    return;
  }
  lastReported.set(fingerprint, now);

  const title = `[claws-error] Attachment download failures`;
  const sourceLink = `https://github.com/${args.sourceRepo}/issues/${args.sourceIssueNumber}`;
  const agentName = args.agentName ?? "(unknown)";
  const timestamp = new Date().toISOString();
  // urls wrapped in backticks so extractImageUrls/extractAttachmentUrls don't re-match them
  const guardCtx = makeGuardCtx(args.sourceRepo, args.sourceIssueNumber);
  const urlList = args.failedUrls
    .map((u) => `- \`${guardContent(u, guardCtx("failed-download-url"))}\``)
    .join("\n");

  try {
    const body = [
      `**Auto-created by Claws error reporter**`,
      "",
      `**Fingerprint:** \`${fingerprint}\``,
      `**Source:** ${sourceLink}`,
      `**Agent:** ${agentName}`,
      `**Timestamp:** ${timestamp}`,
      "",
      `Could not download the following file(s) referenced in the issue/comments:`,
      "",
      urlList,
    ].join("\n");
    await ensureAlertIssue({
      repo: SELF_REPO,
      title,
      body,
      timestamp,
      logPrefix: "error-reporter",
    });
  } catch (reportErr) {
    log.warn(`[error-reporter] Failed to report failed attachments: ${reportErr}`);
  }
}

export async function reportMemoryLimitOnItem(
  repo: string,
  itemNumber: number,
  error: AgentMemoryLimitError,
  count: number,
  skipped: boolean,
): Promise<void> {
  const fingerprint = `memory-limit:${repo}#${itemNumber}`;
  const now = Date.now();
  const lastTime = lastReported.get(fingerprint);
  // Always post the skip comment; only dedup the interim "retrying" comments.
  if (!skipped && lastTime && now - lastTime < COOLDOWN_MS) {
    log.warn(`[error-reporter] Skipping duplicate memory-limit comment for "${fingerprint}" (cooldown)`);
    return;
  }
  lastReported.set(fingerprint, now);

  const observed = Math.round(error.observedRssBytes / 1048576);
  const limit = Math.round(error.limitBytes / 1048576);
  const parts = [
    `### Memory limit reached`,
    "",
    `The CLI process tree for this item exceeded the per-worker memory limit ` +
      `(${observed} MiB observed > ${limit} MiB limit) and was stopped before it could finish.`,
    "",
  ];
  if (skipped) {
    parts.push(
      `This item has hit the memory limit ${count} times in a row and has been ` +
        `temporarily removed from the Claws queue to stop it retrying indefinitely. ` +
        `Use the dashboard to re-queue it once the cause is addressed (e.g. split the task, or raise the per-worker memory cap).`,
    );
  } else if (error.outputBytes === 0) {
    parts.push(
      `The process was killed during startup before producing any output. ` +
        `If this repeats, the item will be removed from the queue after ${3} consecutive memory-limit kills.`,
    );
  } else {
    parts.push(
      `Consider reducing the scope of this task (e.g. splitting it into smaller pieces) so it fits within the worker's memory budget on the next attempt.`,
    );
  }
  await gh.commentOnIssue(repo, itemNumber, parts.join("\n"));
}

export async function reportTimeoutOnItem(
  repo: string,
  itemNumber: number,
  timeoutCount: number,
  error: AgentTimeoutError,
  skipped: boolean,
  newTimeoutMs: number | null,
): Promise<void> {
  const parts = [
    `### CLI Timeout`,
    "",
    `The CLI process timed out while working on this item (${timeoutCount} timeout${timeoutCount > 1 ? "s" : ""} in the last 2 hours).`,
    "",
    error.outputBytes > 0
      ? "The process was actively producing output when the timeout was reached — this item may need a longer timeout or a simpler breakdown."
      : "The process produced no output — this may be a transient issue.",
  ];
  if (newTimeoutMs && !skipped) {
    parts.push("", `The timeout for this item has been increased to ${Math.round(newTimeoutMs / 60_000)} minutes for the next attempt.`);
  }
  if (skipped) {
    parts.push("", "This item has been temporarily removed from the Claws queue to prevent repeated blocking. Use the dashboard to re-queue it when ready.");
  }
  await gh.commentOnIssue(repo, itemNumber, parts.join("\n"));
}
