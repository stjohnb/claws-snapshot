import { PROVIDER_RATE_LIMIT_COOLDOWN_MS } from "./config.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { accountsWithToken, pickClaudeAccount as pickAccountRoundRobin, refreshClaudeAccounts, type ClaudeAccount } from "./claude-accounts.js";
import type { ModelTier } from "./model-selector.js";
import type { Provider } from "./plan-parser.js";

/**
 * Provider usage-limit holds ("circuit breakers"), shared through the
 * `provider_holds` table so the controller, the web tier and agent pods act on
 * the same holds (#clw_01M5YC60E7CR7G1N3ZEHHFHSE9). Keys:
 *
 * - `<provider>` — the whole provider (`codex`, or `claude` for a rate limit
 *   that is not an account usage limit);
 * - `<provider>:<tier>` — one tier on a provider with no accounts;
 * - `claude@<account>` — one Claude account's account-wide usage limit;
 * - `claude@<account>:<tier>` — one tier on one Claude account;
 * - `auth-expired:claude@<account>` — one Claude account's login has expired
 *   (`agent-auth-state.ts` sets it for `providerRateLimitCooldownMs`, renewed on each
 *   further auth failure, and lapses it when a run on the account succeeds or
 *   its login completes). Once it lapses one run probes the account again, so
 *   a token replaced outside `/reauth`, or an error misread as an auth
 *   failure, heals itself. Clearing a cooldown leaves it alone.
 *
 * Reads are synchronous against the in-memory map. Every `mark…` and `clear…`
 * writes through to the table without waiting (failures are logged), and
 * `refreshProviderHolds()` reloads the map from the table. A hold whose write
 * has not landed survives a refresh, so a pod that cannot reach the ops API
 * keeps its own hold for the run.
 */

/** How long a model-specific usage limit holds its tier when the CLI prints no reset time. */
export const MODEL_TIER_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

const holds = new Map<string, number>();
/** Keys marked locally whose write-through has not landed yet. */
const unsynced = new Set<string>();
/** When each Claude account was last held (any of its keys), epoch ms. */
const limitedAt = new Map<string, number>();
const providerLastUsedAt = new Map<Provider, number>();
let lastRefreshAt = 0;

/** A run reads the shared table again only once its last read is this old. */
export const PROVIDER_HOLDS_REFRESH_MS = 5_000;

/** True when the shared holds were last read `PROVIDER_HOLDS_REFRESH_MS` or more ago (or never). */
export function providerHoldsStale(now = Date.now()): boolean {
  return now - lastRefreshAt >= PROVIDER_HOLDS_REFRESH_MS;
}
const accountLastUsedAt = new Map<string, number>();

export function accountKey(account: string): string {
  return `claude@${account}`;
}

/** The shared key latching Claude account `account`'s login as expired. */
export function authExpiredKey(account: string): string {
  return `auth-expired:${accountKey(account)}`;
}

function tierKey(provider: Provider, tier: ModelTier, account?: string): string {
  return provider === "claude" && account ? `${accountKey(account)}:${tier}` : `${provider}:${tier}`;
}

function activeUntil(key: string, now = Date.now()): number | null {
  const until = holds.get(key);
  if (until === undefined) return null;
  if (now >= until) {
    holds.delete(key);
    return null;
  }
  return until;
}

/** Run the shared-table write `fn`; the returned promise settles when it lands or fails (failures are logged, never thrown). */
function writeThrough(what: string, fn: () => Promise<unknown>, onDone?: () => void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => onDone?.())
    .catch((err: unknown) => {
      log.warn(`[provider-holds] ${what} not recorded in the shared table — kept in this process only: ${err instanceof Error ? err.message : String(err)}`);
    });
}

function setHold(key: string, untilMs: number, reason: string): void {
  holds.set(key, untilMs);
  const account = /^claude@([^:]+)/.exec(key)?.[1];
  if (account) limitedAt.set(account, Date.now());
  unsynced.add(key);
  writeThrough(`hold ${key}`, () => db.setProviderHold(key, untilMs, reason), () => {
    if (holds.get(key) === untilMs) unsynced.delete(key);
  });
}

/** Delete `prefix` and every key under it (`<prefix>:…`, `<prefix>@…`); all keys for an empty prefix. `wasOpen` is true when an active hold was removed; `written` settles once the table delete lands or fails. */
function clearHolds(prefix: string): { wasOpen: boolean; written: Promise<void> } {
  const now = Date.now();
  let wasOpen = false;
  for (const key of [...holds.keys()]) {
    if (prefix && key !== prefix && !key.startsWith(`${prefix}:`) && !key.startsWith(`${prefix}@`)) continue;
    if (now < (holds.get(key) ?? 0)) wasOpen = true;
    holds.delete(key);
    unsynced.delete(key);
  }
  const written = writeThrough(`clear ${prefix || "all holds"}`, () => db.clearProviderHolds(prefix));
  return { wasOpen, written };
}

/**
 * Reload the holds from the shared table, and the Claude accounts and tokens
 * (`refreshClaudeAccounts`) with them, so every `providerHoldsStale()` call
 * site keeps both current. Locally-marked holds whose write has not landed are
 * kept. A failed read leaves the map as it was.
 */
export async function refreshProviderHolds(): Promise<void> {
  lastRefreshAt = Date.now();
  await refreshClaudeAccounts();
  let rows: db.ProviderHoldRow[];
  try {
    rows = await db.listProviderHolds();
  } catch (err) {
    log.debug(`[provider-holds] could not read the shared holds — using this process's: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const now = Date.now();
  const local = new Map([...unsynced].flatMap((k) => (holds.has(k) ? [[k, holds.get(k)!] as const] : [])));
  holds.clear();
  for (const row of rows) {
    // Lapsed rows still say when the account was last limited.
    const account = /^claude@([^:]+)/.exec(row.key)?.[1];
    const setAt = row.updated_at ? Date.parse(row.updated_at) : NaN;
    if (account && Number.isFinite(setAt) && setAt > (limitedAt.get(account) ?? 0)) limitedAt.set(account, setAt);
    if (row.until_ms <= now) continue;
    holds.set(row.key, row.until_ms);
  }
  for (const [key, until] of local) holds.set(key, Math.max(until, holds.get(key) ?? 0));
}

// ── Provider-level holds ──

/**
 * True while `provider` is held down. For `claude` that is a provider-wide
 * hold or every account with a token being held or auth-expired.
 */
export function isProviderRateLimited(provider: Provider): boolean {
  return getProviderRateLimitedUntil(provider) !== null;
}

export function markProviderRateLimited(provider: Provider, cooldownMs?: number): void {
  const ms = cooldownMs ?? PROVIDER_RATE_LIMIT_COOLDOWN_MS;
  setHold(provider, Date.now() + ms, "rate-limit");
  log.warn(`[provider-circuit-breaker] Provider "${provider}" rate-limited — cooldown ${ms}ms`);
}

/** When `provider` comes back, or null when it is not held down (see `isProviderRateLimited`). */
export function getProviderRateLimitedUntil(provider: Provider): number | null {
  if (provider === "claude") return claudeProviderHeldUntil();
  return activeUntil(provider);
}

// ── Claude accounts ──

/** True while Claude account `id` is held for an account-wide usage limit. */
export function isAccountRateLimited(id: string): boolean {
  return activeUntil(accountKey(id)) !== null;
}

/** Hold Claude account `id` until epoch-ms `untilMs`. */
export function markAccountRateLimited(id: string, untilMs: number, reason = "usage-limit"): void {
  setHold(accountKey(id), untilMs, reason);
  log.warn(`[provider-circuit-breaker] Claude account "${id}" held until ${new Date(untilMs).toISOString()} (${reason})`);
}

export function getAccountRateLimitedUntil(id: string): number | null {
  return activeUntil(accountKey(id));
}

/** When Claude account `id` was last held, epoch ms; 0 when never. */
export function lastLimitedAt(id: string): number {
  return limitedAt.get(id) ?? 0;
}

// ── Claude account auth expiry ──

/** True while Claude account `id`'s login is latched expired in the shared table (or by this process). */
export function isAccountAuthExpired(id: string): boolean {
  return activeUntil(authExpiredKey(id)) !== null;
}

/** Hold Claude account `id` out of routing as auth-expired for every process for the provider cooldown, renewing an open hold. */
export function markAccountAuthExpired(id: string): void {
  setHold(authExpiredKey(id), Date.now() + PROVIDER_RATE_LIMIT_COOLDOWN_MS, "auth-expired");
}

/**
 * Lapse Claude account `id`'s shared auth-expired hold; a no-op when this
 * process does not see it (unless `force`). Writes a lapsed row rather than
 * deleting, since agent pods may set holds but not delete them.
 */
export function clearAccountAuthExpired(id: string, force = false): void {
  const key = authExpiredKey(id);
  if (!holds.has(key) && !force) return;
  holds.delete(key);
  unsynced.delete(key);
  void writeThrough(`clear ${key}`, () => db.setProviderHold(key, 0, "cleared"));
}

/** When `account` cannot serve `tier` (or any tier, with no tier) until; null when it can. */
function accountBlockedUntil(account: string, tier: ModelTier | undefined, now: number): number | null {
  // A tier hold on `claude` with no account (`claude:<tier>`) holds the tier on every account.
  const times = [activeUntil(authExpiredKey(account), now), activeUntil(accountKey(account), now), ...(tier ? [activeUntil(tierKey("claude", tier, account), now), activeUntil(tierKey("claude", tier), now)] : [])]
    .filter((t): t is number => t !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * When the Claude provider (for `tier`, when given) comes back: null unless a
 * provider-wide hold is open or every account with a token is held, tier-held
 * or auth-expired; otherwise the earliest release.
 */
export function claudeProviderHeldUntil(tier?: ModelTier): number | null {
  const now = Date.now();
  const providerHold = activeUntil("claude", now);
  if (providerHold !== null) return providerHold;
  const accounts = accountsWithToken();
  if (accounts.length === 0) return null;
  let earliest = Number.POSITIVE_INFINITY;
  for (const account of accounts) {
    const until = accountBlockedUntil(account.id, tier, now);
    if (until === null) return null;
    earliest = Math.min(earliest, until);
  }
  return earliest;
}

/** The accounts `pickClaudeAccount` would choose among, in configured order; does not advance the round-robin. */
export function pickableClaudeAccounts(opts: { tier?: ModelTier; exclude?: ReadonlySet<string> } = {}): ClaudeAccount[] {
  const now = Date.now();
  return accountsWithToken().filter((a) => !opts.exclude?.has(a.id) && accountBlockedUntil(a.id, opts.tier, now) === null);
}

/**
 * The Claude account a run should use: one with a token, not auth-expired, not
 * held, not held for `tier` and not in `exclude`, preferring the account
 * limited least recently (never-limited first) and round-robin among ties.
 * Null when no account is eligible.
 */
export function pickClaudeAccount(opts: { tier?: ModelTier; exclude?: ReadonlySet<string> } = {}): ClaudeAccount | null {
  const eligible = pickableClaudeAccounts(opts);
  if (eligible.length === 0) return null;
  const oldest = Math.min(...eligible.map((a) => lastLimitedAt(a.id)));
  const ties = new Set(eligible.filter((a) => lastLimitedAt(a.id) === oldest).map((a) => a.id));
  return pickAccountRoundRobin(new Set(accountsWithToken().filter((a) => !ties.has(a.id)).map((a) => a.id)));
}

// ── Per-model-tier holds ──
//
// A model-specific usage limit ("You've reached your Fable limit. Switch to
// another model to continue.") exhausts one tier, not the account, so it holds
// down only that tier — on the Claude account that produced it — and leaves
// the other tiers and accounts usable.

/**
 * True while `tier` is held on `provider`. For Claude with an `account`, that
 * account's tier hold; for Claude with no account, the tier is held only when
 * no account can serve it.
 */
export function isModelTierRateLimited(provider: Provider, tier: ModelTier, account?: string): boolean {
  return getModelTierRateLimitedUntil(provider, tier, account) !== null;
}

export function markModelTierRateLimited(provider: Provider, tier: ModelTier, ms = MODEL_TIER_RATE_LIMIT_COOLDOWN_MS, account?: string): void {
  setHold(tierKey(provider, tier, account), Date.now() + ms, "model-usage-limit");
  log.warn(`[model-tier-circuit-breaker] Tier "${tier}" on provider "${provider}"${account ? ` account "${account}"` : ""} rate-limited — cooldown ${ms}ms`);
}

export function getModelTierRateLimitedUntil(provider: Provider, tier: ModelTier, account?: string): number | null {
  if (provider === "claude" && account) return activeUntil(tierKey(provider, tier, account));
  const legacy = activeUntil(tierKey(provider, tier));
  if (legacy !== null || provider !== "claude") return legacy;
  // Every account holding this tier (and none free) holds the tier for Claude.
  const accounts = accountsWithToken();
  if (accounts.length === 0) return null;
  const times: number[] = [];
  for (const a of accounts) {
    const until = activeUntil(tierKey("claude", tier, a.id));
    if (until === null) return null;
    times.push(until);
  }
  return Math.min(...times);
}

/**
 * Clear holds. With no provider, every hold. With `claude` and an `account`,
 * that account's hold and tier holds only; with `claude` and no account, the
 * provider-wide hold and every account's. Returns true when an open hold was
 * cleared.
 */
export function clearProviderRateLimitState(provider?: Provider, account?: string): boolean {
  return clearRateLimitHolds(provider, account).wasOpen;
}

/**
 * `clearProviderRateLimitState`, resolving only once the shared table's delete
 * has landed (or failed), so a refresh that follows cannot reload the cleared
 * holds. Service-side only: agent pods cannot delete holds.
 */
export async function clearProviderRateLimitStateShared(provider?: Provider, account?: string): Promise<boolean> {
  const { wasOpen, written } = clearRateLimitHolds(provider, account);
  await written;
  return wasOpen;
}

function clearRateLimitHolds(provider?: Provider, account?: string): { wasOpen: boolean; written: Promise<void> } {
  if (!provider) return clearHolds("");
  const prefix = provider === "claude" && account ? accountKey(account) : provider;
  const cleared = clearHolds(prefix);
  if (cleared.wasOpen) {
    log.info(`[provider-circuit-breaker] Cleared rate-limit cooldown for provider "${provider}"${account ? ` account "${account}"` : ""}`);
  }
  return cleared;
}

// ── Last use ──

export function noteProviderUsed(provider: Provider, account?: string, now = Date.now()): void {
  providerLastUsedAt.set(provider, now);
  if (account) accountLastUsedAt.set(account, now);
}

export function getProviderLastUsedAt(provider: Provider): number | null {
  return providerLastUsedAt.get(provider) ?? null;
}

export function getAccountLastUsedAt(id: string): number | null {
  return accountLastUsedAt.get(id) ?? null;
}

/** Test-only: forget every hold and timestamp without touching the table. */
export function __resetProviderHoldsForTests(): void {
  holds.clear();
  unsynced.clear();
  limitedAt.clear();
  lastRefreshAt = 0;
  providerLastUsedAt.clear();
  accountLastUsedAt.clear();
}
