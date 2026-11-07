import { createHash } from "node:crypto";
import * as db from "./db.js";
import * as log from "./log.js";
import { accountToken, accountsWithToken, refreshClaudeAccounts } from "./claude-accounts.js";

/**
 * Which Anthropic identity a Claude account's OAuth token belongs to
 * (#clw_01M66TF4Q1NES26XN64XW1DXP5), shown on `/reauth`. `claude setup-token`
 * prints only the opaque token, so Claws asks Anthropic: first the OAuth
 * profile endpoint Claude Code calls after `/login` (email, org, plan), and,
 * when that refuses the token, the `anthropic-organization-id` header of a
 * `/v1/models` call (the org UUID only). Which one answered is stored as the
 * identity's `source`. A lookup never fails a login, and the token is never
 * logged, stored outside `claude_accounts` or returned.
 */

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const MODELS_URL = "https://api.anthropic.com/v1/models";
const OAUTH_BETA = "oauth-2025-04-20";
const LOOKUP_TIMEOUT_MS = 10_000;
/** The longest label `/api/claude-accounts` accepts; an auto-label is cut to it. */
const LABEL_MAX = 64;

export interface ClaudeIdentityLookup {
  email: string | null;
  orgUuid: string | null;
  orgName: string | null;
  plan: string | null;
  source: "profile" | "org-header";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** The identity in a profile response body, or null when it names none. The shape is unverified, so read it tolerantly. */
export function parseProfile(body: unknown): Omit<ClaudeIdentityLookup, "source"> | null {
  const account = obj(obj(body)["account"]);
  const org = obj(obj(body)["organization"]);
  const email = str(account["email_address"]) ?? str(account["email"]);
  const orgUuid = str(org["uuid"]);
  const orgName = str(org["name"]);
  const plan =
    str(org["organization_type"]) ??
    str(org["rate_limit_tier"]) ??
    (account["has_claude_max"] === true ? "max" : account["has_claude_pro"] === true ? "pro" : null);
  if (!email && !orgUuid) return null;
  return { email, orgUuid, orgName, plan };
}

/** One timed GET; logs the target path, status and duration, never the token or body. Null when the request itself failed. */
async function timedGet(url: string, headers: Record<string, string>): Promise<Response | null> {
  const path = new URL(url).pathname;
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    log.info("claude identity lookup", { component: "claude-identity", target: path, status: res.status, duration_ms: Date.now() - started });
    return res;
  } catch (err) {
    log.warn("claude identity lookup failed", {
      component: "claude-identity",
      target: path,
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/**
 * Who `token` belongs to: the profile endpoint's email/org/plan, else the
 * `anthropic-organization-id` header of a `/v1/models` call (read whatever its
 * status), else null.
 */
export async function lookupClaudeIdentity(token: string): Promise<ClaudeIdentityLookup | null> {
  const auth = { Authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA };
  const profile = await timedGet(PROFILE_URL, auth);
  if (profile?.ok) {
    const parsed = parseProfile(await profile.json().catch(() => null));
    if (parsed) return { ...parsed, source: "profile" };
  } else {
    await profile?.body?.cancel().catch(() => {});
  }
  const models = await timedGet(MODELS_URL, { ...auth, "anthropic-version": "2023-06-01" });
  if (!models) return null;
  const orgUuid = str(models.headers.get("anthropic-organization-id"));
  await models.body?.cancel().catch(() => {});
  return orgUuid ? { email: null, orgUuid, orgName: null, plan: null, source: "org-header" } : null;
}

/** In-flight lookups, keyed by account id and a hash of the token being looked up, so a new token always gets its own. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Look up account `id`'s token's identity and store it (with
 * `identity_checked_at` now, even when nothing came back, so a page load does
 * not ask again). The write only lands while the account still holds the
 * token that was looked up; a lookup a newer login superseded is dropped. An
 * email replaces a label still at its default (the id, or empty), checked in
 * the write itself; a label the operator typed is kept. Concurrent calls for
 * one id and token share a lookup. Never throws.
 */
export function refreshClaudeAccountIdentity(id: string): Promise<void> {
  const token = accountToken(id);
  if (!token) return Promise.resolve();
  const key = `${id}:${createHash("sha256").update(token).digest("hex")}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = (async () => {
    try {
      const found = await lookupClaudeIdentity(token);
      const stored = await db.setClaudeAccountIdentity(id, token, {
        email: found?.email ?? null,
        orgUuid: found?.orgUuid ?? null,
        orgName: found?.orgName ?? null,
        plan: found?.plan ?? null,
        source: found?.source ?? null,
        checkedAt: new Date().toISOString(),
      });
      if (!stored) {
        log.info("claude identity superseded", { component: "claude-identity", account: id });
        return;
      }
      if (found?.email) await db.labelClaudeAccountIfDefault(id, found.email.slice(0, LABEL_MAX));
      log.info("claude identity stored", { component: "claude-identity", account: id, source: found?.source ?? "none" });
      await refreshClaudeAccounts();
    } catch (err) {
      log.warn("claude identity refresh failed", { component: "claude-identity", account: id }, err);
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/** Fire-and-forget: look up every account with a token that has never been checked. */
export function backfillClaudeAccountIdentities(): void {
  for (const account of accountsWithToken()) {
    if (!account.identity?.checkedAt) void refreshClaudeAccountIdentity(account.id);
  }
}
