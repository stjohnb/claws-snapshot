/** Authenticated dashboard actions: job trigger, pause and cancel, verify, Claude accounts, provider auth, providers, client errors and activation. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import type { Context } from "hono";
import { writeConfig } from "../../config.js";
import * as config from "../../config.js";
import { insertClaudeAccount, updateClaudeAccountLabel, deleteClaudeAccount, clearProviderHolds } from "../../db.js";
import * as log from "../../log.js";
import { startClaudeLogin, submitClaudeLoginCode, getClaudeLoginStatus } from "../../claude-auth.js";
import { accountKey, authExpiredKey, refreshProviderHolds } from "../../provider-holds.js";
import { CLAUDE_ACCOUNT_ID_RE, accountToken, claudeAccounts, claudeAccountsStale, findClaudeAccount, refreshClaudeAccounts } from "../../claude-accounts.js";
import { refreshClaudeAccountIdentity } from "../../claude-account-identity.js";
import { startCodexLogin, getCodexLoginStatus } from "../../codex-auth.js";
import { piCredentialStatuses } from "../../pi-auth.js";
import { runConnectivityVerification, loadLatestReport } from "../../jobs/connectivity-verifier.js";
import { listOpenRouterSessionModels } from "../../openrouter.js";
import { reportError } from "../../error-reporter.js";
import { jsonOk, readTextBody } from "../http.js";
import { authMiddleware } from "../auth.js";
import { Hono } from "hono";
import type { Env } from "../http.js";
import type { RouteContext } from "./context.js";

export function registerAccountRoutes(app: Hono<Env>, ctx: RouteContext): void {
  const { controller } = ctx;
  // ── Authenticated routes ──

  app.post("/trigger/:job", authMiddleware, async (c) => {
    const jobName = c.req.param("job");
    const result = await controller.triggerJob(jobName);
    // `queued`: the controller did not answer in time; it runs the trigger when it does.
    const status = result === "started" ? 200 : result === "queued" ? 202 : result === "unknown" ? 404 : 409;
    return jsonOk(c, { result }, status);
  });

  app.post("/pause/:job", authMiddleware, async (c) => {
    const jobName = c.req.param("job");
    const paused = await controller.pausedJobs();
    let result: string;
    if (paused.has(jobName)) {
      if (!await controller.resumeJob(jobName)) {
        return jsonOk(c, { result: "unknown" }, 404);
      }
      result = "resumed";
    } else {
      if (!await controller.pauseJob(jobName)) {
        return jsonOk(c, { result: "unknown" }, 404);
      }
      result = "paused";
    }
    return jsonOk(c, { result });
  });

  app.post("/cancel", authMiddleware, async (c) => {
    return jsonOk(c, { result: await controller.cancelCurrentTask() });
  });

  app.post("/api/verify/run", authMiddleware, async (c) => {
    try {
      const report = await runConnectivityVerification();
      const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
      if (wantsJson) {
        return jsonOk(c, report);
      }
      return c.redirect("/config#activation", 303);
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  // Claude accounts are database state (claude-accounts.ts), managed here on
  // the web tier; the controller reads a change on its next refresh. No
  // response ever carries a token.
  const CLAUDE_ACCOUNT_LABEL_MAX = 64;
  const readAccountLabel = (raw: unknown): string | null | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") return null;
    const label = raw.trim();
    return label.length > CLAUDE_ACCOUNT_LABEL_MAX ? null : label;
  };
  app.post("/api/claude-accounts", authMiddleware, async (c) => {
    const body = await c.req.json<{ id?: unknown; label?: unknown }>().catch(() => ({}) as { id?: unknown; label?: unknown });
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!CLAUDE_ACCOUNT_ID_RE.test(id)) {
      return jsonOk(c, { ok: false, error: "Id must be 1–32 lowercase letters, digits or dashes, starting with a letter or digit" }, 400);
    }
    const label = readAccountLabel(body.label);
    if (label === null) return jsonOk(c, { ok: false, error: `Label must be at most ${CLAUDE_ACCOUNT_LABEL_MAX} characters` }, 400);
    await refreshClaudeAccounts();
    if (findClaudeAccount(id)) return jsonOk(c, { ok: false, error: `A Claude account "${id}" already exists` }, 409);
    try {
      await insertClaudeAccount(id, label || id);
    } catch (err) {
      await refreshClaudeAccounts();
      if (findClaudeAccount(id)) return jsonOk(c, { ok: false, error: `A Claude account "${id}" already exists` }, 409);
      throw err;
    }
    await refreshClaudeAccounts();
    log.info(`[claude-accounts] Added Claude account "${id}" from the dashboard`);
    return jsonOk(c, { ok: true, account: findClaudeAccount(id) ?? { id, label: label || id } });
  });
  app.patch("/api/claude-accounts/:id", authMiddleware, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ label?: unknown }>().catch(() => ({}) as { label?: unknown });
    const label = readAccountLabel(body.label);
    if (label === null || label === undefined) return jsonOk(c, { ok: false, error: `Label must be a string of at most ${CLAUDE_ACCOUNT_LABEL_MAX} characters` }, 400);
    if (!(await updateClaudeAccountLabel(id, label || id))) return jsonOk(c, { ok: false, error: `Unknown Claude account "${id}"` }, 404);
    await refreshClaudeAccounts();
    log.info(`[claude-accounts] Relabelled Claude account "${id}" from the dashboard`);
    return jsonOk(c, { ok: true, account: findClaudeAccount(id) ?? { id, label: label || id } });
  });
  app.post("/api/claude-accounts/:id/identity", authMiddleware, async (c) => {
    const id = c.req.param("id");
    await refreshClaudeAccounts();
    if (!findClaudeAccount(id)) return jsonOk(c, { ok: false, error: `Unknown Claude account "${id}"` }, 404);
    if (!accountToken(id)) return jsonOk(c, { ok: false, error: "Account has no token" }, 400);
    const started = Date.now();
    await refreshClaudeAccountIdentity(id);
    const account = findClaudeAccount(id);
    log.info("claude identity refreshed", { component: "claude-accounts", account: id, source: account?.identity?.source ?? "none", duration_ms: Date.now() - started });
    return jsonOk(c, { ok: true, account: account ?? { id } });
  });
  app.delete("/api/claude-accounts/:id", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!(await deleteClaudeAccount(id))) return jsonOk(c, { ok: false, error: `Unknown Claude account "${id}"` }, 404);
    // Its token went with the row; its holds and auth-expired latch go too.
    // Past tasks keep their recorded account_used.
    await clearProviderHolds(accountKey(id));
    await clearProviderHolds(authExpiredKey(id));
    await refreshProviderHolds();
    log.info(`[claude-accounts] Removed Claude account "${id}" from the dashboard`);
    return jsonOk(c, { ok: true });
  });

  const startClaudeLoginFor = async (c: Context, account: string): Promise<Response> => {
    // An account added on the web tier a moment ago must be startable here.
    await refreshClaudeAccounts();
    if (!findClaudeAccount(account)) return jsonOk(c, { ok: false, error: `Unknown Claude account "${account}"` }, 404);
    const r = await startClaudeLogin(account);
    return jsonOk(c, r, r.ok ? 200 : 500);
  };
  const submitClaudeLoginCodeFor = async (c: Context, account: string): Promise<Response> => {
    const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
    const r = await submitClaudeLoginCode(account, body.code ?? "");
    return jsonOk(c, r, r.ok ? 200 : 400);
  };
  app.post("/api/claude-auth/:account/start", authMiddleware, (c) => startClaudeLoginFor(c, c.req.param("account")));
  app.post("/api/claude-auth/:account/code", authMiddleware, (c) => submitClaudeLoginCodeFor(c, c.req.param("account")));
  // Pre-multi-account routes, mapped to the first account; kept for one release.
  const firstClaudeAccount = async (): Promise<string | undefined> => {
    if (claudeAccountsStale()) await refreshClaudeAccounts();
    return claudeAccounts()[0]?.id;
  };
  const noClaudeAccount = (c: Context): Response => jsonOk(c, { ok: false, error: "No Claude account exists" }, 404);
  app.post("/api/claude-auth/start", authMiddleware, async (c) => {
    const account = await firstClaudeAccount();
    return account ? startClaudeLoginFor(c, account) : noClaudeAccount(c);
  });
  app.post("/api/claude-auth/code", authMiddleware, async (c) => {
    const account = await firstClaudeAccount();
    return account ? submitClaudeLoginCodeFor(c, account) : noClaudeAccount(c);
  });
  app.get("/api/claude-auth/status", authMiddleware, async (c) => {
    if (claudeAccountsStale()) await refreshClaudeAccounts();
    return jsonOk(c, getClaudeLoginStatus());
  });

  app.post("/api/codex-auth/start", authMiddleware, async (c) => {
    const r = await startCodexLogin();
    return jsonOk(c, r, r.ok ? 200 : 500);
  });
  app.get("/api/codex-auth/status", authMiddleware, (c) => jsonOk(c, getCodexLoginStatus()));

  // pi's per-provider readiness from `pi auth check --no-refresh`; never carries a credential.
  app.get("/api/pi-auth/providers", authMiddleware, async (c) => jsonOk(c, await piCredentialStatuses()));

  app.get("/api/providers", authMiddleware, async (c) => {
    const [providers, { agentAuthExpired }] = await Promise.all([controller.providerStatus(), controller.integrations()]);
    function status(provider: "claude" | "codex" | "opencode" | "pi") {
      const until = providers[provider].rateLimitedUntil;
      return {
        rateLimited: until !== null,
        rateLimitedUntil: until !== null ? new Date(until).toISOString() : null,
        authExpired: agentAuthExpired[provider],
      };
    }
    const iso = (t: number | null) => (t !== null ? new Date(t).toISOString() : null);
    // Claude per account; `claude.rateLimited` is true only when every account with a token is held.
    const accounts = Object.fromEntries(Object.entries(providers.claude.accounts ?? {}).map(([id, a]) => [id, {
      label: a.label,
      tokenPresent: a.tokenPresent,
      authExpired: a.authExpired,
      rateLimited: a.rateLimited,
      rateLimitedUntil: iso(a.rateLimitedUntil),
      tierRateLimitedUntil: Object.fromEntries(Object.entries(a.tierRateLimitedUntil).map(([tier, t]) => [tier, iso(t)])),
      lastUsedAt: iso(a.lastUsedAt),
    }]));
    return jsonOk(c, { claude: { ...status("claude"), accounts }, codex: status("codex"), opencode: status("opencode"), pi: status("pi") });
  });

  app.post("/api/providers/claude/accounts/:account/clear-rate-limit", authMiddleware, async (c) => {
    if (claudeAccountsStale()) await refreshClaudeAccounts();
    const account = findClaudeAccount(c.req.param("account"));
    if (!account) return jsonOk(c, { ok: false, error: "unknown account" }, 400);
    const cleared = await controller.clearRateLimit("claude", account.id);
    if (cleared === "queued") return jsonOk(c, { ok: true, cleared: false, result: "queued" }, 202);
    return jsonOk(c, { ok: true, cleared });
  });

  // For `claude`, clears the provider-wide hold and every account's.
  app.post("/api/providers/:provider/clear-rate-limit", authMiddleware, async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "claude" && provider !== "codex" && provider !== "opencode" && provider !== "pi") {
      return jsonOk(c, { ok: false, error: "unknown provider" }, 400);
    }
    const cleared = await controller.clearRateLimit(provider);
    if (cleared === "queued") return jsonOk(c, { ok: true, cleared: false, result: "queued" }, 202);
    return jsonOk(c, { ok: true, cleared });
  });

  app.get("/api/opencode/models", authMiddleware, async (c) => {
    try {
      return jsonOk(c, { models: await listOpenRouterSessionModels() });
    } catch (err) {
      log.warn(`[sessions] OpenRouter model catalogue unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return jsonOk(c, { error: "catalogue unavailable" }, 502);
    }
  });
  app.post("/api/client-error", authMiddleware, async (c) => {
    try {
      const raw = await readTextBody(c, 8192);
      const parsed = JSON.parse(raw);
      const fingerprint = typeof parsed.fingerprint === "string" && parsed.fingerprint
        ? `client-error: ${parsed.fingerprint.slice(0, 200)}`
        : "client-error: unknown";
      const message = typeof parsed.message === "string" ? parsed.message.slice(0, 500) : "unknown";
      const stack = typeof parsed.stack === "string" ? parsed.stack.slice(0, 2000) : "";
      const context = typeof parsed.context === "string" ? parsed.context.slice(0, 200) : "client";
      const err = new Error(message);
      err.stack = stack || `Error: ${message}`;
      void reportError(fingerprint, `client-side JS error on ${context}`, err);
    } catch {
      // ignore malformed payloads
    }
    return c.body(null, 204);
  });

  app.get("/api/activation", authMiddleware, async (c) => {
    const report = await loadLatestReport();
    return jsonOk(c, {
      state: config.ACTIVATION_STATE,
      lastVerification: report ? { generatedAt: report.generatedAt, failures: report.checks.filter((ck) => !ck.ok).length } : null,
    });
  });

  app.post("/api/activation", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = JSON.parse(body) as { state?: string; confirm?: boolean };
      if (!parsed.confirm) {
        return jsonOk(c, { error: "confirm:true required" }, 400);
      }
      if (parsed.state !== "active" && parsed.state !== "staging" && parsed.state !== "verify-only") {
        return jsonOk(c, { error: "state must be 'active', 'staging', or 'verify-only'" }, 400);
      }
      if (parsed.state === config.ACTIVATION_STATE) {
        return jsonOk(c, { result: "unchanged", state: parsed.state });
      }
      await writeConfig({ activationState: parsed.state });
      log.warn(`[activation] Flipped to ${parsed.state}`);
      return jsonOk(c, { result: "flipped", state: parsed.state, restartRequired: true });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });
}
