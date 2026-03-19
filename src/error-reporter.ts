import { SELF_REPO } from "./config.js";
import { ClaudeTimeoutError } from "./claude.js";
import * as gh from "./github.js";
import { isRateLimited, RateLimitError } from "./github.js";
import * as log from "./log.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";

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
      error instanceof ClaudeTimeoutError
        ? [
            "",
            "**Diagnostics:**",
            `- Working directory: \`${error.cwd}\``,
            `- Total stdout: ${error.outputBytes} bytes`,
            `- Claude ${error.outputBytes === 0 ? "produced no output (likely stuck or waiting for input)" : "was actively producing output"}`,
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

    const results = await gh.searchIssues(SELF_REPO, title);
    const existing = results.find((r) => r.title === title);

    if (existing) {
      const comment = [
        `### Recurrence — ${timestamp}`,
        "",
        `**Context:** ${context}`,
        "",
        "```",
        errorStr,
        "```",
        diagnostics,
      ]
        .filter(Boolean)
        .join("\n");
      await gh.commentOnIssue(SELF_REPO, existing.number, comment);
    } else {
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
      await gh.createIssue(SELF_REPO, title, body, []);
    }
  } catch (reportErr) {
    log.warn(`[error-reporter] Failed to report error for "${fingerprint}": ${reportErr}`);
  }
}
