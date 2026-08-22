import * as config from "./config.js";
import * as log from "./log.js";
import { notify } from "./slack.js";

/**
 * Claude-CLI credential expiry is a *global* condition: once the claude CLI's
 * OAuth session dies, every queued task fails identically within minutes
 * (#2538 — ~30 Slack [ERROR] lines per dispatcher tick). This module latches
 * that condition so error-reporter alerts once per episode instead of once
 * per task, mirroring github-status.ts's incident latch.
 *
 * The latch tracks the *claude* provider only. Callers must scope it there
 * themselves — `AgentCliError` is thrown identically by the codex and
 * opencode backends, and AGENT_AUTH_FAILURE_RE is deliberately broad — so
 * `error-reporter.ts` checks `AgentCliError.provider === "claude"` before
 * calling `noteAgentAuthFailure`, and `claude.ts` only calls
 * `noteAgentAuthSuccess` when the successful attempt was the claude provider.
 * A codex/opencode outcome says nothing about the claude OAuth session, and
 * `/claude-auth` cannot fix a non-claude credential problem.
 */
export const AGENT_AUTH_FAILURE_RE =
  /OAuth (?:session|token) (?:expired|revoked)|Failed to authenticate\b|Please run `?\/?login`?\b|Invalid API key.*login|authentication_error/i;

/** Stable fingerprint for the single [claws-error] issue filed per episode. */
export const AGENT_AUTH_FINGERPRINT = "agent-auth-expired";

/** Re-alert at most this often while the condition persists. */
export const REALERT_MS = 60 * 60 * 1000;

interface AgentAuthState {
  expired: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  failures: number;
  lastAlertAtMs: number | null;
  firstDetail: string | null;
}

let state: AgentAuthState = { expired: false, firstSeenAt: null, lastSeenAt: null, failures: 0, lastAlertAtMs: null, firstDetail: null };

export function isAgentAuthFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return AGENT_AUTH_FAILURE_RE.test(msg);
}

/** URL the operator must visit to re-authenticate. */
export function reauthUrl(): string {
  const base = (config.DASHBOARD_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/claude-auth` : "/claude-auth";
}

/**
 * Record a claude-CLI auth failure. Returns true when the caller should raise a
 * full alert (first failure of an episode, or the hourly re-alert), false when
 * the failure should be downgraded to a warning.
 *
 * `now` is an injectable clock for tests; production callers omit it.
 */
export function noteAgentAuthFailure(detail: string, now: number = Date.now()): boolean {
  const nowIso = new Date(now).toISOString();
  if (!state.expired) {
    state = { expired: true, firstSeenAt: nowIso, lastSeenAt: nowIso, failures: 1, lastAlertAtMs: now, firstDetail: detail };
    return true;
  }
  state.lastSeenAt = nowIso;
  state.failures += 1;
  if (state.lastAlertAtMs !== null && now - state.lastAlertAtMs < REALERT_MS) return false;
  state.lastAlertAtMs = now;
  return true;
}

/**
 * Clear the latch after a successful *claude* run or a successful web re-auth.
 * A no-op when the latch is already clear, so callers need not check first.
 */
export function noteAgentAuthSuccess(): void {
  if (!state.expired) return;
  const failures = state.failures;
  state = { expired: false, firstSeenAt: null, lastSeenAt: null, failures: 0, lastAlertAtMs: null, firstDetail: null };
  log.info(`[agent-auth] Claude CLI authentication recovered after ${failures} failed task(s)`);
  notify("[INFO] Claude CLI authentication recovered — resuming normal error reporting.");
}

export function isAgentAuthExpired(): boolean {
  return state.expired;
}

/** Test-only: reset module state between test cases. */
export function __resetAgentAuthStateForTests(): void {
  state = { expired: false, firstSeenAt: null, lastSeenAt: null, failures: 0, lastAlertAtMs: null, firstDetail: null };
}
