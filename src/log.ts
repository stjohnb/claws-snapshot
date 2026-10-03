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

export function error(msg: string, err?: unknown): void {
  emit("error", msg, { err });
  notify(`[ERROR] ${msg}`);
  captureLog("error", msg);
}

const FLUSH_TIMEOUT_MS = 5000;

/**
 * Like error(), but resolves once the Slack notification has actually been
 * delivered (or FLUSH_TIMEOUT_MS has elapsed). Use this instead of error()
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
