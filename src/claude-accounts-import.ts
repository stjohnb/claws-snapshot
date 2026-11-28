import fs from "node:fs";
import { CONFIG_PATH, parseClaudeAccounts, type ConfigFile } from "./config.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { LEGACY_CLAUDE_TOKEN_ENV_KEY, accountTokenEnvKey } from "./claude-accounts.js";

/**
 * One-shot upgrade import of the Claude accounts and tokens Claws used to read
 * from config and env (#clw_01M5Z3N6TRQVWVYZCFK56YVN8J) into the
 * `claude_accounts` table, so the current account keeps working with no
 * operator step. Run by the controller at boot, after config is materialised.
 *
 * Accounts come from `CLAWS_CLAUDE_ACCOUNTS`, else `claudeAccounts` in
 * config.json (default one `primary`); each one's token from its
 * `CLAUDE_CODE_OAUTH_TOKEN_<ID>` env key, else — for the first account only —
 * the bare `CLAUDE_CODE_OAUTH_TOKEN`. An id already in the table is left as it
 * is. Once the `claude_accounts_imported` key is in `controller_status` this
 * is a no-op, so those settings are never read again. Logs counts only, never
 * a token.
 */

/** The `controller_status` key recording that the import ran. */
export const CLAUDE_ACCOUNTS_IMPORTED_KEY = "claude_accounts_imported";

export interface ClaudeAccountsImportResult {
  at: string;
  accounts: number;
  tokens: number;
}

function readFileAccounts(configPath: string): ConfigFile["claudeAccounts"] {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { claudeAccounts?: unknown };
    return Array.isArray(parsed.claudeAccounts) ? (parsed.claudeAccounts as ConfigFile["claudeAccounts"]) : undefined;
  } catch {
    return undefined;
  }
}

/** Import once; resolves the import's counts, or null when it already ran. */
export async function importLegacyClaudeAccounts(opts: { env?: NodeJS.ProcessEnv; configPath?: string } = {}): Promise<ClaudeAccountsImportResult | null> {
  if ((await db.readControllerStatus(CLAUDE_ACCOUNTS_IMPORTED_KEY)) !== null) return null;
  const env = opts.env ?? process.env;
  const legacy = parseClaudeAccounts(env["CLAWS_CLAUDE_ACCOUNTS"], readFileAccounts(opts.configPath ?? CONFIG_PATH));
  const existing = new Set((await db.listClaudeAccounts()).map((a) => a.id));
  let accounts = 0;
  let tokens = 0;
  for (const [i, account] of legacy.entries()) {
    if (existing.has(account.id)) continue;
    await db.insertClaudeAccount(account.id, account.label);
    accounts++;
    const token = env[accountTokenEnvKey(account.id)] || (i === 0 ? env[LEGACY_CLAUDE_TOKEN_ENV_KEY] : undefined);
    if (token && (await db.setClaudeAccountToken(account.id, token))) tokens++;
  }
  const result = { at: new Date().toISOString(), accounts, tokens };
  await db.writeControllerStatus(CLAUDE_ACCOUNTS_IMPORTED_KEY, result);
  log.info(`[claude-accounts] Imported ${accounts} Claude account(s) and ${tokens} token(s) from config and env; they are database state from now on`);
  return result;
}
