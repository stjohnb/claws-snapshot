import * as config from "./config.js";
import type { Provider } from "./plan-parser.js";
import * as log from "./log.js";
import { notify } from "./slack.js";

/**
 * Agent-CLI credential expiry is a *global* condition per provider: once a
 * CLI's OAuth session dies, every queued task routed to it fails identically
 * within minutes (#2538 — ~30 Slack [ERROR] lines per dispatcher tick). This
 * module latches that condition so error-reporter alerts once per episode
 * instead of once per task, mirroring github-status.ts's incident latch.
 *
 * The latch is keyed by provider: a codex credential failure must not claim the
 * claude session is dead (they expire independently, and a claude re-auth on
 * `/reauth` cannot fix a codex credential — that page has a separate Codex
 * device-code flow). Callers pass the provider from the `AgentCliError`
 * that failed; `claude.ts` clears only the provider whose run succeeded.
 * Provider "claude" is the default everywhere so existing call sites and the
 * existing [claws-error] fingerprint are unchanged.
 */
export const AGENT_AUTH_FAILURE_RE =
  /OAuth (?:session|token) (?:expired|revoked)|Failed to authenticate\b|Please run `?\/?login`?\b|Invalid API key.*login|authentication_error|refresh token|Please log out and sign in again/i;

/**
 * Stable fingerprint for the single [claws-error] issue filed per episode.
 * Claude keeps the original bare fingerprint so issues opened before the latch
 * became per-provider still match.
 */
export function agentAuthFingerprint(provider: Provider = "claude"): string {
  return provider === "claude" ? "agent-auth-expired" : `agent-auth-expired-${provider}`;
}

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

function clearedState(): AgentAuthState {
  return { expired: false, firstSeenAt: null, lastSeenAt: null, failures: 0, lastAlertAtMs: null, firstDetail: null };
}

const states = new Map<Provider, AgentAuthState>();

function getState(provider: Provider): AgentAuthState {
  let s = states.get(provider);
  if (!s) {
    s = clearedState();
    states.set(provider, s);
  }
  return s;
}

export function isAgentAuthFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return AGENT_AUTH_FAILURE_RE.test(msg);
}

/**
 * What the operator must do to re-authenticate. Claude and codex both have web
 * flows on the `/reauth` dashboard page, so they get a URL; opencode has none,
 * so it is a shell instruction.
 */
export function reauthInstruction(provider: Provider = "claude"): string {
  if (provider === "opencode") return "run `opencode auth login` on the Claws host";
  const base = (config.DASHBOARD_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/reauth` : "/reauth";
}

/**
 * Record an agent-CLI auth failure. Returns true when the caller should raise a
 * full alert (first failure of an episode, or the hourly re-alert), false when
 * the failure should be downgraded to a warning.
 *
 * `now` is an injectable clock for tests; production callers omit it.
 */
export function noteAgentAuthFailure(detail: string, now: number = Date.now(), provider: Provider = "claude"): boolean {
  const nowIso = new Date(now).toISOString();
  const state = getState(provider);
  if (!state.expired) {
    states.set(provider, { expired: true, firstSeenAt: nowIso, lastSeenAt: nowIso, failures: 1, lastAlertAtMs: now, firstDetail: detail });
    return true;
  }
  state.lastSeenAt = nowIso;
  state.failures += 1;
  if (state.lastAlertAtMs !== null && now - state.lastAlertAtMs < REALERT_MS) return false;
  state.lastAlertAtMs = now;
  return true;
}

/**
 * Clear the latch for `provider` after a successful run on that CLI or a
 * successful web re-auth. A no-op when the latch is already clear, so callers
 * need not check first.
 */
export function noteAgentAuthSuccess(provider: Provider = "claude"): void {
  const state = getState(provider);
  if (!state.expired) return;
  const failures = state.failures;
  states.set(provider, clearedState());
  const label = provider === "claude" ? "Claude CLI" : provider === "codex" ? "Codex CLI" : "OpenCode CLI";
  log.info(`[agent-auth] ${label} authentication recovered after ${failures} failed task(s)`);
  notify(`[INFO] ${label} authentication recovered — resuming normal error reporting.`);
}

export function isAgentAuthExpired(provider: Provider = "claude"): boolean {
  return getState(provider).expired;
}

/** Test-only: reset module state between test cases. */
export function __resetAgentAuthStateForTests(): void {
  states.clear();
}
