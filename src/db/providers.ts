// Provider holds, content-moderation flags and Claude accounts.
// Reached only through the src/db.ts façade.
import { getDb } from "./core.js";

export interface ProviderHoldRow {
  key: string;
  until_ms: number;
  reason: string | null;
  updated_at: string | null;
}

/** Every recorded provider hold, lapsed ones included (callers judge `until_ms` against the clock). */
export async function listProviderHolds(): Promise<ProviderHoldRow[]> {
  const rows = await getDb().all<ProviderHoldRow>(`SELECT key, until_ms, reason, updated_at FROM provider_holds`);
  return rows.map((r) => ({ ...r, until_ms: Number(r.until_ms) }));
}

/** Epoch-ms when `repo`'s moderation endpoint first answered 404/405, or null when it is live. */
export async function getContentModerationNotLiveSince(repo: string): Promise<number | null> {
  const row = await getDb().get<{ since_ms: number }>(`SELECT since_ms FROM content_moderation_not_live WHERE repo = ?`, [repo]);
  return row ? Number(row.since_ms) : null;
}

/** Record the first sighting of the not-live state; an existing row keeps its earlier time. */
export async function markContentModerationNotLive(repo: string, sinceMs: number): Promise<void> {
  await getDb().run(`INSERT INTO content_moderation_not_live (repo, since_ms) VALUES (?, ?) ON CONFLICT(repo) DO NOTHING`, [repo, Math.round(sinceMs)]);
}

/** Forget `repo`'s not-live state. */
export async function clearContentModerationNotLive(repo: string): Promise<void> {
  await getDb().run(`DELETE FROM content_moderation_not_live WHERE repo = ?`, [repo]);
}

/** Record (or replace) the hold `key` until epoch-ms `untilMs`. */
export async function setProviderHold(key: string, untilMs: number, reason: string | null): Promise<void> {
  await getDb().run(
    `INSERT INTO provider_holds (key, until_ms, reason, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET until_ms = excluded.until_ms, reason = excluded.reason, updated_at = excluded.updated_at`,
    [key, Math.round(untilMs), reason, new Date().toISOString()],
  );
}

/**
 * Delete the hold `prefix` and every hold under it (`<prefix>:…` tier holds and
 * `<prefix>@…` account holds); an empty prefix deletes every hold. Returns the
 * number of rows deleted.
 */
export async function clearProviderHolds(prefix: string): Promise<number> {
  if (!prefix) return (await getDb().run(`DELETE FROM provider_holds`)).changes;
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const res = await getDb().run(
    `DELETE FROM provider_holds WHERE key = ? OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'`,
    [prefix, `${escaped}:%`, `${escaped}@%`],
  );
  return res.changes;
}

export interface ClaudeAccountRow {
  id: string;
  label: string;
  token: string | null;
  position: number;
  email?: string | null;
  org_uuid?: string | null;
  org_name?: string | null;
  plan?: string | null;
  identity_source?: string | null;
  identity_checked_at?: string | null;
}

/** The Anthropic identity a Claude account's token resolved to (src/claude-account-identity.ts). */
export interface ClaudeAccountIdentityRow {
  email: string | null;
  orgUuid: string | null;
  orgName: string | null;
  plan: string | null;
  source: string | null;
  checkedAt: string;
}

/** Every stored Claude account, tokens included, in `position` order. Never send a row to a browser. */
export async function listClaudeAccounts(): Promise<ClaudeAccountRow[]> {
  const rows = await getDb().all<ClaudeAccountRow>(
    `SELECT id, label, token, position, email, org_uuid, org_name, plan, identity_source, identity_checked_at
     FROM claude_accounts ORDER BY position, id`,
  );
  return rows.map((r) => ({ ...r, position: Number(r.position) }));
}

/** Add Claude account `id` after every existing one, with no token. Throws when `id` already exists. */
export async function insertClaudeAccount(id: string, label: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO claude_accounts (id, label, token, position, created_at, updated_at)
     VALUES (?, ?, NULL, (SELECT COALESCE(MAX(position), -1) + 1 FROM claude_accounts), ?, ?)`,
    [id, label, now, now],
  );
}

/** Relabel Claude account `id`; false when it does not exist. */
export async function updateClaudeAccountLabel(id: string, label: string): Promise<boolean> {
  const res = await getDb().run(`UPDATE claude_accounts SET label = ?, updated_at = ? WHERE id = ?`, [label, new Date().toISOString(), id]);
  return res.changes > 0;
}

/**
 * Store Claude account `id`'s OAuth token and clear the identity the old token
 * resolved to; false when the account does not exist.
 */
export async function setClaudeAccountToken(id: string, token: string | null): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE claude_accounts SET token = ?, email = NULL, org_uuid = NULL, org_name = NULL, plan = NULL,
       identity_source = NULL, identity_checked_at = NULL, updated_at = ? WHERE id = ?`,
    [token, new Date().toISOString(), id],
  );
  return res.changes > 0;
}

/**
 * Record (or with null, clear) the identity Claude account `id`'s `token`
 * resolved to; false when the account does not exist or no longer holds that
 * token (a newer login replaced it while the lookup ran), so a late lookup
 * never stamps an old token's identity on a new one.
 */
export async function setClaudeAccountIdentity(id: string, token: string, identity: ClaudeAccountIdentityRow | null): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE claude_accounts SET email = ?, org_uuid = ?, org_name = ?, plan = ?, identity_source = ?, identity_checked_at = ?, updated_at = ?
     WHERE id = ? AND token = ?`,
    [
      identity?.email ?? null,
      identity?.orgUuid ?? null,
      identity?.orgName ?? null,
      identity?.plan ?? null,
      identity?.source ?? null,
      identity?.checkedAt ?? null,
      new Date().toISOString(),
      id,
      token,
    ],
  );
  return res.changes > 0;
}

/**
 * Relabel Claude account `id` only while its label is still the default (the
 * id, or empty), in the same statement, so a label the operator typed in the
 * meantime is never replaced; false when it was not relabelled.
 */
export async function labelClaudeAccountIfDefault(id: string, label: string): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE claude_accounts SET label = ?, updated_at = ? WHERE id = ? AND (label = '' OR label = id)`,
    [label, new Date().toISOString(), id],
  );
  return res.changes > 0;
}

/** Delete Claude account `id` and its token; false when it does not exist. */
export async function deleteClaudeAccount(id: string): Promise<boolean> {
  const res = await getDb().run(`DELETE FROM claude_accounts WHERE id = ?`, [id]);
  return res.changes > 0;
}

