import { notify } from "./slack.js";
import { insertJobLog } from "./db.js";
import { emit, runContext } from "./log-core.js";

import type { DiagnosticReason, DiagnosticContext } from "./diagnostic-queries.js";

// The stdout format (JSON off a TTY, text on one) lives in log-core.ts; this
// module adds the job_logs and Slack sinks on top.
export { runContext, withRunContext } from "./log-core.js";
export type { RunContext, RunContextFields } from "./log-core.js";

function captureLog(level: string, msg: string, reason?: DiagnosticReason, context?: DiagnosticContext): void {
  const store = runContext.getStore();
  if (store) {
    try {
      insertJobLog(store.runId, level, msg, reason, context);
    } catch {
      // Don't let DB errors interrupt the job
    }
  }
}

export function debug(msg: string): void {
  emit("debug", msg);
  captureLog("debug", msg);
}

export function info(msg: string, reason?: DiagnosticReason, context?: DiagnosticContext): void {
  emit("info", msg, { reason, context });
  captureLog("info", msg, reason, context);
}

export function warn(msg: string, reason?: DiagnosticReason, context?: DiagnosticContext, err?: unknown): void {
  emit("warn", msg, { reason, context, err });
  captureLog("warn", msg, reason, context);
}

/**
 * Logs an error to stdout and the run's job log. It does not post to Slack:
 * Slack is reserved for operator attention (see docs/slack-messages.md), so a
 * site that needs a person calls `slack.notify` itself, naming the action.
 */
export function error(msg: string, err?: unknown): void {
  emit("error", msg, { err });
  captureLog("error", msg);
}

const FLUSH_TIMEOUT_MS = 5000;

/**
 * Like error(), but also posts to Slack and resolves once the notification has
 * actually been delivered (or FLUSH_TIMEOUT_MS has elapsed). This is the one
 * logging path that still reaches Slack: a fatal startup exit leaves no
 * dashboard to show the alert on. Use this instead of error()
 * immediately before process.exit(), which would otherwise destroy the
 * in-flight webhook request and silently drop the alert.
 */
export async function errorAndFlush(msg: string, err?: unknown): Promise<void> {
  emit("error", msg, { err });
  captureLog("error", msg);
  await Promise.race([
    notify(`[ERROR] ${msg}`),
    new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
  ]);
}
