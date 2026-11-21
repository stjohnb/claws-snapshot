import { notify } from "./slack.js";
import { insertJobLog } from "./db.js";
import { emit, formatFieldsSuffix, runContext, type LogFields } from "./log-core.js";

import type { DiagnosticReason, DiagnosticContext } from "./diagnostic-queries.js";

// The stdout format (JSON off a TTY, text on one) lives in log-core.ts; this
// module adds the job_logs and Slack sinks on top.
export { runContext, withRunContext } from "./log-core.js";
export type { LogFields, RunContext, RunContextFields } from "./log-core.js";

/** A plain object in a `reason` position is fields: `DiagnosticReason` is always a string. */
function isFields(value: unknown): value is LogFields {
  return typeof value === "object" && value !== null && !(value instanceof Error);
}

function captureLog(level: string, msg: string, reason?: DiagnosticReason, context?: DiagnosticContext, fields?: LogFields): void {
  const store = runContext.getStore();
  if (store) {
    try {
      insertJobLog(store.runId, level, msg + formatFieldsSuffix(fields), reason, context);
    } catch {
      // Don't let DB errors interrupt the job
    }
  }
}

// New code passes ids and values in `fields`, keeping `msg` a constant
// message (docs/observability.md). Fields become top-level snake_case keys on
// stdout and ` key=value` pairs on the job_logs copy.

export function debug(msg: string, fields?: LogFields): void {
  emit("debug", msg, { fields });
  captureLog("debug", msg, undefined, undefined, fields);
}

export function info(msg: string, fields: LogFields): void;
export function info(msg: string, reason?: DiagnosticReason, context?: DiagnosticContext): void;
export function info(msg: string, reasonOrFields?: DiagnosticReason | LogFields, context?: DiagnosticContext): void {
  if (isFields(reasonOrFields)) {
    emit("info", msg, { fields: reasonOrFields });
    captureLog("info", msg, undefined, undefined, reasonOrFields);
    return;
  }
  emit("info", msg, { reason: reasonOrFields, context });
  captureLog("info", msg, reasonOrFields, context);
}

export function warn(msg: string, fields: LogFields, err?: unknown): void;
export function warn(msg: string, reason?: DiagnosticReason, context?: DiagnosticContext, err?: unknown): void;
export function warn(msg: string, reasonOrFields?: DiagnosticReason | LogFields, contextOrErr?: DiagnosticContext | unknown, err?: unknown): void {
  if (isFields(reasonOrFields)) {
    emit("warn", msg, { fields: reasonOrFields, err: contextOrErr });
    captureLog("warn", msg, undefined, undefined, reasonOrFields);
    return;
  }
  const context = contextOrErr as DiagnosticContext | undefined;
  emit("warn", msg, { reason: reasonOrFields, context, err });
  captureLog("warn", msg, reasonOrFields, context);
}

/**
 * Logs an error to stdout and the run's job log. It does not post to Slack:
 * Slack is reserved for urgent attention (see docs/slack-messages.md), so a
 * site whose failure cannot wait for the dashboard calls `slack.notify` itself,
 * naming the action.
 */
export function error(msg: string, err?: unknown, fields?: LogFields): void {
  emit("error", msg, { err, fields });
  captureLog("error", msg, undefined, undefined, fields);
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
export async function errorAndFlush(msg: string, err?: unknown, fields?: LogFields): Promise<void> {
  emit("error", msg, { err, fields });
  captureLog("error", msg, undefined, undefined, fields);
  await Promise.race([
    notify(`[ERROR] ${msg}`),
    new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
  ]);
}
