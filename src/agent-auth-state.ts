import * as config from "./config.js";
import type { Provider } from "./plan-parser.js";
import * as log from "./log.js";
import { accountsWithToken, findClaudeAccount } from "./claude-accounts.js";
import { clearAccountAuthExpired, isAccountAuthExpired, markAccountAuthExpired } from "./provider-holds.js";

/**
 * Agent-CLI credential expiry is a *global* condition per provider: once a
 * CLI's OAuth session dies, every queued task routed to it fails identically
 * within minutes (#2538 — ~30 Slack [ERROR] lines per dispatcher tick). This
 * module latches that condition so error-reporter alerts once per episode
 * instead of once per task.
 *
 * The latch is keyed by provider: a codex credential failure must not claim the
 * claude session is dead (they expire independently, and a claude re-auth on
 * `/reauth` cannot fix a codex credential — that page has a separate Codex
 * device-code flow). Callers pass the provider from the `AgentCliError`
 * that failed; `claude.ts` clears only the provider whose run succeeded.
 * Provider "claude" is the default everywhere so existing call sites and the
 * existing [claws-error] fingerprint are unchanged.
 *
 * Claude runs on named accounts (`claude-accounts.ts`), each with its own
 * OAuth token, so a Claude failure that names its account latches
 * `claude@<id>` alone: the other accounts keep serving runs. The bare
 * `claude` latch remains for failures that name no account. An account's
 * latch is also written to the shared `provider_holds` table
 * (`provider-holds.ts`), so the controller, the Reauth page and every agent
 * pod see an account a pod found expired; the alert cadence stays per process.
 */
export const AGENT_AUTH_FAILURE_RE =
  /OAuth (?:session|token) (?:expired|revoked)|Failed to authenticate\b|Please run `?\/?login`?\b|Invalid API key.*login|authentication_error|refresh token|Please log out and sign in again|credentials_not_configured|No API key found for [\w-]+|\bUser not found\b|invalid x-api-key|"statusCode":\s*401\b/i;

/**
 * Stable fingerprint for the single [claws-error] issue filed per episode.
 * Claude keeps the original bare fingerprint so issues opened before the latch
 * became per-provider still match.
 */
export function agentAuthFingerprint(provider: Provider = "claude", account?: string): string {
  if (provider === "claude" && account) return `agent-auth-expired-claude-${account}`;
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

/** Keyed by provider, or `claude@<account>` for one Claude account. */
const states = new Map<string, AgentAuthState>();

function stateKey(provider: Provider, account?: string): string {
  return provider === "claude" && account ? `claude@${account}` : provider;
}

function getState(key: string): AgentAuthState {
  let s = states.get(key);
  if (!s) {
    s = clearedState();
    states.set(key, s);
  }
  return s;
}

export function isAgentAuthFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return AGENT_AUTH_FAILURE_RE.test(msg);
}

/**
 * What the operator must do to re-authenticate. Claude and codex both have web
 * flows on the `/reauth` dashboard page, so they get a URL, as does pi, whose
 * credentials derive from those two logins (the page lists pi's readiness);
 * opencode has none and two keys (Anthropic's for `anthropic/` models,
 * OpenRouter's for `openrouter/` ones), so its instruction names both and the
 * error each provider gives. A Claude `account` is named, since
 * the page has one login per account.
 */
export function reauthInstruction(provider: Provider = "claude", account?: string): string {
  if (provider === "opencode") {
    return "set or replace the Anthropic API key (the \"Anthropic API Key\" field on the dashboard config page, `CLAWS_ANTHROPIC_API_KEY`, or that key in the `claws-auth` Secret) if Anthropic rejected it (`invalid x-api-key`) or none is set; or the OpenRouter API key (the \"OpenRouter API Key\" field, or `CLAWS_OPENROUTER_API_KEY`) if an `openrouter/` model got \"User not found.\"";
  }
  const base = (config.DASHBOARD_URL ?? "").replace(/\/+$/, "");
  const url = base ? `${base}/reauth` : "/reauth";
  if (provider !== "claude" || !account) return url;
  const label = findClaudeAccount(account)?.label ?? account;
  return `${url} (Claude account "${label}": Start login in its section)`;
}

/**
 * Record an agent-CLI auth failure. Returns true when the caller should raise a
 * full alert (first failure of an episode, or the hourly re-alert), false when
 * the failure should be downgraded to a warning.
 *
 * `now` is an injectable clock for tests; production callers omit it.
 */
export function noteAgentAuthFailure(detail: string, now: number = Date.now(), provider: Provider = "claude", account?: string): boolean {
  const nowIso = new Date(now).toISOString();
  const key = stateKey(provider, account);
  const state = getState(key);
  if (provider === "claude" && account) markAccountAuthExpired(account);
  if (!state.expired) {
    states.set(key, { expired: true, firstSeenAt: nowIso, lastSeenAt: nowIso, failures: 1, lastAlertAtMs: now, firstDetail: detail });
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
 * successful web re-auth. With a Claude `account`, clears that account's latch
 * and the bare `claude` one (a run on any account proves the CLI works). A
 * no-op when the latch is already clear, so callers need not check first.
 */
export function noteAgentAuthSuccess(provider: Provider = "claude", account?: string): void {
  if (provider === "claude" && account) {
    clearLatch("claude");
    clearAccountAuthExpired(account, getState(stateKey(provider, account)).expired);
  }
  clearLatch(provider, account);
}

function clearLatch(provider: Provider, account?: string): void {
  const key = stateKey(provider, account);
  const state = getState(key);
  if (!state.expired) return;
  const failures = state.failures;
  states.set(key, clearedState());
  const cli = provider === "claude" ? "Claude CLI" : provider === "codex" ? "Codex CLI" : provider === "pi" ? "Pi CLI" : "OpenCode CLI";
  const label = provider === "claude" && account ? `${cli} (account "${account}")` : cli;
  log.info(`[agent-auth] ${label} authentication recovered after ${failures} failed task(s)`);
}

/**
 * Whether `provider`'s credentials are latched expired. For Claude with an
 * `account`, that account's latch; for Claude with no account, the bare latch
 * or every account with a token being expired.
 */
export function isAgentAuthExpired(provider: Provider = "claude", account?: string): boolean {
  if (provider !== "claude") return getState(provider).expired;
  if (account) return getState(stateKey(provider, account)).expired || isAccountAuthExpired(account);
  if (getState("claude").expired) return true;
  const accounts = accountsWithToken();
  return accounts.length > 0 && accounts.every((a) => getState(stateKey("claude", a.id)).expired || isAccountAuthExpired(a.id));
}

/** Test-only: reset module state between test cases. */
export function __resetAgentAuthStateForTests(): void {
  states.clear();
}
