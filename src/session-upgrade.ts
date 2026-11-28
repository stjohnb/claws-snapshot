/**
 * Whether a Claws deploy happened since an interactive session's agent was
 * launched. The agent lists its MCP tools once at start, so a session that
 * outlives a deploy (#clw_01M45W7WJF4SMWEQ8J15RPJ4Y2) does not see tools the
 * new version added until it is restarted; `claws-state-http.ts` announces
 * that once with `notifications/tools/list_changed`. A leaf: compares `sessions.launched_version` with
 * the running `VERSION` only.
 */

import { VERSION } from "./version.js";

/**
 * True when `launchedVersion` is set and differs from the running version.
 * Null (rows written before the column existed) is never upgraded, and a
 * development build ("dev" versus "dev") never differs.
 */
export function sessionUpgradedSince(launchedVersion: string | null | undefined): boolean {
  return !!launchedVersion && launchedVersion !== VERSION;
}
