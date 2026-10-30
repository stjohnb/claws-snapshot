import * as db from "./db.js";
import * as log from "./log.js";


/**
 * The named Claude Max accounts Claws runs Claude work on, and each one's
 * OAuth token: Claws database state in the `claude_accounts` table
 * (#clw_01M5Z3N6TRQVWVYZCFK56YVN8J), managed on `/reauth` (Add account,
 * rename, remove) and written by each account's Reauth login. No config key,
 * env var, env file or Secret holds them; the controller's first boot imports
 * what those used to hold (`claude-accounts-import.ts`).
 *
 * Every reader is synchronous against an in-memory cache that
 * `refreshClaudeAccounts()` reloads from the table (through the ops API in an
 * agent pod). `provider-holds.ts`'s `refreshProviderHolds()` refreshes it too,
 * so every `providerHoldsStale()` call site keeps both current. Tokens never
 * come from `process.env`.
 */

export interface ClaudeAccount {
  id: string;
  label: string;
}

/** A Claude account id: 1–32 lowercase letters, digits or dashes, not starting with a dash. */
export const CLAUDE_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The legacy single-account token key; the importer reads it, and child envs are scrubbed of it. */
export const LEGACY_CLAUDE_TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

interface CachedAccount {
  label: string;
  token: string | null;
  position: number;
}

let cache = new Map<string, CachedAccount>();
let lastRefreshAt = 0;

/** A process reads the table again only once its last read is this old (the provider holds' window). */
export const CLAUDE_ACCOUNTS_REFRESH_MS = 5_000;

/** True when the accounts were last read `CLAUDE_ACCOUNTS_REFRESH_MS` or more ago (or never). */
export function claudeAccountsStale(now = Date.now()): boolean {
  return now - lastRefreshAt >= CLAUDE_ACCOUNTS_REFRESH_MS;
}

/** Replace the cache with `rows`, in their `position` order. */
export function setClaudeAccounts(rows: ReadonlyArray<{ id: string; label: string; token?: string | null; position?: number }>): void {
  const sorted = rows.map((r, i) => ({ ...r, position: r.position ?? i })).sort((a, b) => a.position - b.position);
  cache = new Map(sorted.map((r) => [r.id, { label: r.label, token: r.token ?? null, position: r.position }]));
}

/**
 * Reload the accounts and tokens from the `claude_accounts` table. A failed
 * read is logged and leaves the cache as it was.
 */
export async function refreshClaudeAccounts(): Promise<void> {
  lastRefreshAt = Date.now();
  let rows: db.ClaudeAccountRow[];
  try {
    rows = await db.listClaudeAccounts();
  } catch (err) {
    log.debug(`[claude-accounts] could not read the Claude accounts — using this process's: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  setClaudeAccounts(rows);
}

/** The stored accounts, in order; empty when there are none (Claude is then skipped like a provider with no token). */
export function claudeAccounts(): ReadonlyArray<ClaudeAccount> {
  return [...cache].map(([id, a]) => ({ id, label: a.label }));
}

/** The stored account with `id`, or undefined. */
export function findClaudeAccount(id: string): ClaudeAccount | undefined {
  const a = cache.get(id);
  return a ? { id, label: a.label } : undefined;
}

/** The env key that held account `id`'s OAuth token before the import: `CLAUDE_CODE_OAUTH_TOKEN_<ID>`, dashes as underscores. */
export function accountTokenEnvKey(id: string): string {
  return `${LEGACY_CLAUDE_TOKEN_ENV_KEY}_${id.toUpperCase().replace(/-/g, "_")}`;
}

/** Account `id`'s OAuth token from the cache; undefined when the account has none or does not exist. */
export function accountToken(id: string): string | undefined {
  return cache.get(id)?.token ?? undefined;
}

/** The stored accounts that currently have a token, in order. */
export function accountsWithToken(): ClaudeAccount[] {
  return claudeAccounts().filter((a) => !!accountToken(a.id));
}

/** True for the bare legacy token key and every per-account `CLAUDE_CODE_OAUTH_TOKEN_<ID>` key. */
export function isClaudeTokenEnvKey(key: string): boolean {
  return key === LEGACY_CLAUDE_TOKEN_ENV_KEY || key.startsWith(`${LEGACY_CLAUDE_TOKEN_ENV_KEY}_`);
}

/**
 * Where this process's round-robin starts. An agent pod is a fresh process per
 * work row, so a cursor starting at 0 would put every single-run task on the
 * first account: seed it from the pod's sequential row id
 * (`CLAWS_AGENT_POD_ROW`) so consecutive rows alternate, else from a random
 * offset.
 */
function initialRoundRobinCursor(): number {
  const row = Number.parseInt(process.env["CLAWS_AGENT_POD_ROW"] ?? "", 10);
  if (Number.isSafeInteger(row) && row >= 0) return row;
  return Math.floor(Math.random() * 1_000_000);
}

let roundRobinCursor = initialRoundRobinCursor();

/**
 * The next account with a token, round-robin across calls, skipping any id in
 * `exclude`. Null when no eligible account has a token. The cursor is seeded
 * per process (see `initialRoundRobinCursor`), so pods spread across accounts.
 */
export function pickClaudeAccount(exclude?: Set<string>): ClaudeAccount | null {
  const eligible = accountsWithToken().filter((a) => !exclude?.has(a.id));
  if (eligible.length === 0) return null;
  const account = eligible[roundRobinCursor % eligible.length]!;
  roundRobinCursor = (roundRobinCursor + 1) % Number.MAX_SAFE_INTEGER;
  return account;
}

/** Test hook: restart the round-robin from the first account. */
export function resetClaudeAccountRoundRobin(): void {
  roundRobinCursor = 0;
}

/**
 * Store account `id`'s freshly-minted OAuth token in the `claude_accounts`
 * table, then in this process's cache so its next spawn uses it; every other
 * process reads it on its next refresh. Resolves false when the account no
 * longer exists (removed mid-login). The token is NEVER logged.
 */
export async function setAccountToken(id: string, token: string): Promise<boolean> {
  if (!(await db.setClaudeAccountToken(id, token))) {
    cache.delete(id);
    return false;
  }
  const cached = cache.get(id);
  if (cached) cached.token = token;
  else await refreshClaudeAccounts();
  return true;
}

/** Test hook: empty the cache and mark it stale. */
export function __resetClaudeAccountsForTests(): void {
  cache = new Map();
  lastRefreshAt = 0;
}
