import * as core from "../log-core.js";

// The session pod's logger: same line shape as the service's, stamped with
// `service: "claws-session"`. It wraps `log-core.js` only — the pod runs with
// no Claws config or database, so `log.js` (and its job_logs/Slack sinks) are
// off limits. Messages drop the old `[session-pod] ` prefix; the component
// defaults to `session-pod` instead.
//
// The fields ride on each call rather than being set process-wide: the main
// service imports `session-pod/main.js` for its launch-spec types, and must not
// have its own lines relabelled by that import.
const base: core.BaseFields = { service: "claws-session", component: "session-pod" };

/** Stamps `session_id` on every later line, once the launch spec has been read. */
export function setSessionId(sessionId: string): void {
  base.session_id = sessionId;
}

export function info(msg: string): void {
  core.emit("info", msg, { base });
}

export function warn(msg: string, err?: unknown): void {
  core.emit("warn", msg, { base, err });
}

export function error(msg: string, err?: unknown): void {
  core.emit("error", msg, { base, err });
}
