/**
 * The one-shot completion API: `POST /api/completion/:owner/:name`
 * (docs/completion-api.md).
 *
 * A service Claws manages — growth-engine's social drafter first — sends a
 * prompt and gets one non-interactive completion back, on the subscriptions
 * Claws already logs into, instead of bundling an agent CLI and a copy of the
 * login itself. The run has no tools, no MCP servers, no checkout and none of
 * Claws' secrets (`RunClaudeOptions.isolatedCompletion`), is bounded in size,
 * time and per-caller concurrency, and is recorded as a `completion-api` task
 * attributed to the calling repo so it counts toward the usage tracking every
 * other run does.
 *
 * Auth mirrors the issue filer's: a per-repo bearer token whose SHA-256 the
 * calling repo commits as `claws.json`'s `completion.tokenSha256`. The token
 * only matches its own repo's path, and reaches no other route.
 *
 * Nothing here logs the prompt, the system prompt, the output or an error's
 * text — only the repo, provider, model, status, duration and character counts.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import {
  AgentCliError,
  AgentTimeoutError,
  AllProvidersRateLimitedError,
  classifyUsageLimit,
  getProviderRateLimitedUntil,
  runClaude,
  UNSUPPORTED_MODEL_RE,
} from "./claude.js";
import { claudeProviderHeldUntil, providerHoldsStale, refreshProviderHolds } from "./provider-holds.js";
import { AUXILIARY_AGENT_ADMISSION_BYTES } from "./agent-memory-budget.js";
import { getEnabledProviderWeights, getPinnableProviders, NoEligibleProviderError, normalizeTier, type ModelTier } from "./model-selector.js";
import { sessionModelsFor } from "./session-models.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";
import { safeCompare } from "./internal-mcp-token.js";
import { forceRefreshRepoConfig, getRepoConfig, listRepoConfigs } from "./repo-config.js";
import type { Provider } from "./plan-parser.js";

const NAME = "completion-api";

/** Most characters `prompt` and `system` may hold together (413 beyond). */
export const MAX_COMPLETION_INPUT_CHARS = 100_000;
/** Largest request body the route accepts (413 beyond), enforced by its `bodyLimit`. */
export const MAX_COMPLETION_BODY_BYTES = 512 * 1024;
/** The CLI run's own timeout (504 beyond). */
export const COMPLETION_TIMEOUT_MS = 120_000;
/**
 * The whole request's deadline: the run's timeout plus the longest it may wait
 * for the auxiliary memory lane first, which the run's own timer does not cover.
 */
export const COMPLETION_DEADLINE_MS = COMPLETION_TIMEOUT_MS + 25_000;
/** Completions one caller repo may have running at once (429 beyond). */
export const MAX_CONCURRENT_COMPLETIONS_PER_REPO = 2;
/** `Retry-After` for a caller over its concurrency cap. */
export const CONCURRENCY_RETRY_AFTER_SECONDS = 5;
/** `Retry-After` for a usage-limited provider whose breaker has no known end. */
export const USAGE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS = 60;

/** The backends a caller may name; `pi` is deliberately not one. */
export const COMPLETION_PROVIDERS = ["claude", "codex", "opencode"] as const;
type CompletionProvider = (typeof COMPLETION_PROVIDERS)[number];

/** The provider and Claude tier a request that names neither runs on. */
export const DEFAULT_COMPLETION_PROVIDER: CompletionProvider = "claude";
export const DEFAULT_COMPLETION_TIER: ModelTier = "sonnet";

/** Running completions per caller repo, keyed by lowercased full name. */
const running = new Map<string, number>();

/** The path's repo in its configured casing, when it has a `completion` entry. */
function callerFor(c: Context): { repo: string; tokenSha256: string } | null {
  const wanted = `${c.req.param("owner") ?? ""}/${c.req.param("name") ?? ""}`;
  const completion = getRepoConfig(wanted)?.completion;
  if (!completion) return null;
  const repo = listRepoConfigs().find((r) => r.fullName.toLowerCase() === wanted.toLowerCase())?.fullName ?? wanted;
  return { repo, tokenSha256: completion.tokenSha256 };
}

/**
 * Admit only the bearer token whose SHA-256 is the path repo's
 * `completion.tokenSha256`. Never `apiAuthMiddleware`'s tokens or an operator
 * session: they get a 401 here, and this token gets one everywhere else.
 */
export const completionAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  let caller = callerFor(c);
  if (!caller || !safeCompare(hash, caller.tokenSha256)) {
    // The cached claws.json may predate a merged rotation or first opt-in:
    // re-read it (rate-limited per repo) before refusing.
    const wanted = `${c.req.param("owner") ?? ""}/${c.req.param("name") ?? ""}`;
    if (!(await forceRefreshRepoConfig(wanted, gh.fetchRepoFileContent))) return c.json({ error: "unauthorized" }, 401);
    caller = callerFor(c);
    if (!caller || !safeCompare(hash, caller.tokenSha256)) return c.json({ error: "unauthorized" }, 401);
    log.info(`[${NAME}] ${caller.repo}: re-read claws.json after a token mismatch; the new token is accepted`);
  }
  await next();
};

/** Providers a caller may name right now: the three completion backends the operator has enabled. */
export function validCompletionProviders(): CompletionProvider[] {
  const pinnable = new Set<Provider>(getPinnableProviders());
  return COMPLETION_PROVIDERS.filter((p) => pinnable.has(p));
}

/** Model ids a caller may name for `provider`. */
export function validCompletionModels(provider: CompletionProvider): string[] {
  return sessionModelsFor(provider).map((m) => m.id);
}

interface CompletionRequest {
  prompt: string;
  system: string | undefined;
  provider: CompletionProvider;
  /** Only for Codex and OpenCode; a Claude model is carried as `tier`. */
  model: string | undefined;
  tier: ModelTier;
  /** The caller named a provider, or a model (which implies Claude). */
  pinned: boolean;
}

type Parsed = { ok: true; request: CompletionRequest } | { ok: false; status: 400 | 413 | 503; error: string };

/** Validate a request body. Exported for tests. */
export function parseCompletionRequest(input: unknown): Parsed {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
  const body = input as Record<string, unknown>;
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return { ok: false, status: 400, error: "prompt must be a non-empty string" };
  if (body.system !== undefined && typeof body.system !== "string") return { ok: false, status: 400, error: "system must be a string" };
  if (body.provider !== undefined && typeof body.provider !== "string") return { ok: false, status: 400, error: "provider must be a string" };
  if (body.model !== undefined && typeof body.model !== "string") return { ok: false, status: 400, error: "model must be a string" };
  const prompt = body.prompt;
  const system = (body.system as string | undefined) || undefined;
  if (prompt.length + (system?.length ?? 0) > MAX_COMPLETION_INPUT_CHARS) {
    return { ok: false, status: 413, error: `prompt and system together must be at most ${MAX_COMPLETION_INPUT_CHARS} characters` };
  }

  const providers = validCompletionProviders();
  const requestedProvider = body.provider as string | undefined;
  if (requestedProvider !== undefined && !(providers as string[]).includes(requestedProvider)) {
    return { ok: false, status: 400, error: `provider must be one of: ${providers.join(", ")}` };
  }
  const provider = (requestedProvider as CompletionProvider | undefined)
    ?? (providers.includes(DEFAULT_COMPLETION_PROVIDER) ? DEFAULT_COMPLETION_PROVIDER : providers[0]);
  if (provider === undefined) return { ok: false, status: 503, error: "no completion provider is enabled" };
  const requestedModel = body.model as string | undefined;
  if (requestedModel !== undefined) {
    const models = validCompletionModels(provider);
    if (!models.includes(requestedModel)) {
      return { ok: false, status: 400, error: `model for provider ${provider} must be one of: ${models.join(", ")}` };
    }
  }
  const claudeTier = provider === "claude" && requestedModel !== undefined ? normalizeTier(requestedModel) : null;
  return {
    ok: true,
    request: {
      prompt,
      system,
      provider,
      model: provider === "claude" ? undefined : requestedModel,
      tier: claudeTier ?? DEFAULT_COMPLETION_TIER,
      pinned: requestedProvider !== undefined || requestedModel !== undefined,
    },
  };
}

/** Whole seconds until `until`, at least 1; the default when unknown. */
function retryAfterSeconds(until: number | null): number {
  if (until === null) return USAGE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS;
  return Math.max(1, Math.ceil((until - Date.now()) / 1000));
}

/**
 * When `provider` comes back, or null when it is not held down. Claude (for
 * `tier`) is held only while every account is held, tier-held or auth-expired,
 * and comes back when the first account does.
 */
function breakerUntil(provider: Provider, tier: ModelTier): number | null {
  return provider === "claude" ? claudeProviderHeldUntil(tier) : getProviderRateLimitedUntil(provider);
}

function isHeldDown(provider: Provider, tier: ModelTier): boolean {
  return breakerUntil(provider, tier) !== null;
}

/** The soonest a usage-limited run could succeed: the pinned provider's breaker, or the earliest of the pool's. */
function usageLimitRetryAfter(request: CompletionRequest, pool: readonly Provider[]): number {
  const candidates = request.pinned ? [request.provider] : pool;
  const times = candidates.map((p) => breakerUntil(p, request.tier)).filter((t): t is number => t !== null);
  return retryAfterSeconds(times.length > 0 ? Math.min(...times) : null);
}

function tooManyRequests(c: Context, retryAfter: number, error: string): Response {
  c.header("Retry-After", String(retryAfter));
  return c.json({ error, retryAfterSeconds: retryAfter }, 429);
}

class CompletionDeadlineError extends Error {
  constructor() {
    super("completion deadline exceeded");
    this.name = "CompletionDeadlineError";
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * `POST /api/completion/:owner/:name` with `{ prompt, system?, provider?, model? }`:
 * run one isolated completion attributed to the path repo. Answers
 * `{ text, provider, model }` with the provider and model actually used.
 */
export async function completionHandler(c: Context): Promise<Response> {
  const caller = callerFor(c);
  if (!caller) return c.json({ error: "unauthorized" }, 401);
  const parsed = parseCompletionRequest(await readJson(c));
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const { request } = parsed;
  if (isShuttingDown()) return c.json({ error: "Claws is shutting down; retry shortly" }, 503);

  // An unpinned request may fall back across the enabled weighted pool, but
  // only onto the completion backends.
  const pool = getEnabledProviderWeights().filter(({ provider }) => (COMPLETION_PROVIDERS as readonly string[]).includes(provider));
  // The web tier holds no holds of its own: read the ones the controller and agent pods recorded.
  if (providerHoldsStale()) await refreshProviderHolds();
  if (request.pinned && isHeldDown(request.provider, request.tier)) {
    const retryAfter = usageLimitRetryAfter(request, []);
    logOutcome(caller.repo, request, 429, 0, null, null);
    return tooManyRequests(c, retryAfter, `provider ${request.provider} is at its usage limit`);
  }

  const key = caller.repo.toLowerCase();
  const inFlight = running.get(key) ?? 0;
  if (inFlight >= MAX_CONCURRENT_COMPLETIONS_PER_REPO) {
    logOutcome(caller.repo, request, 429, 0, null, null);
    return tooManyRequests(c, CONCURRENCY_RETRY_AFTER_SECONDS, `at most ${MAX_CONCURRENT_COMPLETIONS_PER_REPO} completions may run at once for ${caller.repo}`);
  }
  running.set(key, inFlight + 1);

  const startedAt = Date.now();
  let used: { provider: Provider; model: string | null } = { provider: request.provider, model: request.model ?? null };
  // The slot and the temp dirs belong to the run, not the response: a run that
  // outlives the deadline still holds them until its CLI exits.
  const run = runIsolated(caller.repo, request, pool, (provider, model) => { used = { provider, model: model ?? null }; })
    .finally(() => {
      const left = (running.get(key) ?? 1) - 1;
      if (left > 0) running.set(key, left);
      else running.delete(key);
    });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CompletionDeadlineError()), COMPLETION_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    const text = await Promise.race([run, deadline]);
    logOutcome(caller.repo, request, 200, Date.now() - startedAt, used, text.length);
    return c.json({ text, provider: used.provider, model: used.model });
  } catch (err) {
    // A run abandoned at the deadline still settles later; keep that from being unhandled.
    run.catch(() => {});
    const status = errorStatus(err, used.provider, request);
    logOutcome(caller.repo, request, status, Date.now() - startedAt, used, null);
    if (status === 429) return tooManyRequests(c, usageLimitRetryAfter(request, pool.map((p) => p.provider)), "the provider is at its usage limit");
    if (status === 504) return c.json({ error: `completion did not finish within ${COMPLETION_TIMEOUT_MS / 1000} s` }, 504);
    if (status === 400) return c.json({ error: `model is not available on provider ${used.provider}` }, 400);
    if (status === 503) return c.json({ error: "no provider is available; retry shortly" }, 503);
    return c.json({ error: "completion failed" }, 502);
  } finally {
    clearTimeout(timer);
  }
}

/** The status a failed run answers with. Never reads the error's text into a response or a log. */
function errorStatus(err: unknown, provider: Provider, request: CompletionRequest): 400 | 429 | 502 | 503 | 504 {
  if (err instanceof CompletionDeadlineError || err instanceof AgentTimeoutError) return 504;
  if (err instanceof AllProvidersRateLimitedError) return 429;
  if (err instanceof NoEligibleProviderError || err instanceof ShutdownError || isShuttingDown()) return 503;
  if (err instanceof AgentCliError) {
    if (UNSUPPORTED_MODEL_RE.test(err.message)) return 400;
    // runClaude has already classified it: a usage limit or a detected rate
    // limit leaves the provider's (or Claude tier's) breaker open.
    if (classifyUsageLimit(err.message) !== null || isHeldDown(err.provider ?? provider, request.tier)) return 429;
  }
  return 502;
}

/** Thrown by `runIsolatedCompletion` when the provider's usage-limit breaker is open. */
export class CompletionProviderHeldError extends Error {
  constructor(readonly provider: Provider, readonly until: number) {
    super(`provider ${provider} is at its usage limit`);
    this.name = "CompletionProviderHeldError";
  }
}

/**
 * Run one isolated completion for a Claws job, attributed to `repo` as a
 * `completion-api` task: the same isolation, task recording and breaker the
 * HTTP route uses, pinned to the default provider at `tier` (default tier
 * when omitted). Throws `CompletionProviderHeldError` without running while
 * the breaker is open, and whatever `runClaude` throws otherwise. Bypasses
 * the per-caller HTTP concurrency cap; callers run one at a time.
 */
export async function runIsolatedCompletion(
  repo: string,
  options: { prompt: string; system?: string; tier?: ModelTier },
): Promise<{ text: string; provider: Provider; model: string }> {
  const request: CompletionRequest = {
    prompt: options.prompt,
    system: options.system || undefined,
    provider: DEFAULT_COMPLETION_PROVIDER,
    model: undefined,
    tier: options.tier ?? DEFAULT_COMPLETION_TIER,
    pinned: true,
  };
  const heldUntil = breakerUntil(request.provider, request.tier);
  if (heldUntil !== null) throw new CompletionProviderHeldError(request.provider, heldUntil);
  let used: { provider: Provider; model: string | undefined } = { provider: request.provider, model: undefined };
  const text = await runIsolated(repo, request, [], (provider, model) => { used = { provider, model }; });
  return { text, provider: used.provider, model: used.model ?? request.tier };
}

async function runIsolated(
  repo: string,
  request: CompletionRequest,
  pool: ReturnType<typeof getEnabledProviderWeights>,
  onModel: (provider: Provider, model: string | undefined) => void,
): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "claws-completion-"));
  const systemDir = request.system ? await fs.mkdtemp(path.join(os.tmpdir(), "claws-completion-system-")) : null;
  try {
    let systemPromptFile: string | undefined;
    if (systemDir && request.system) {
      systemPromptFile = path.join(systemDir, "system.md");
      await fs.writeFile(systemPromptFile, request.system, { mode: 0o600 });
    }
    return await db.withTaskRecording(NAME, repo, 0, null, async (taskId) => {
      const text = await runClaude(request.prompt, cwd, {
        tier: request.tier,
        model: request.model,
        provider: request.provider,
        strictProvider: request.pinned,
        ...(request.pinned ? {} : { eligibleProviders: pool }),
        timeoutMs: COMPLETION_TIMEOUT_MS,
        admissionBytes: AUXILIARY_AGENT_ADMISSION_BYTES,
        captureLabel: NAME,
        isolatedCompletion: { systemPrompt: request.system, systemPromptFile },
        onTokensUsed: db.trackTaskTokens(taskId),
        onAttemptModelUsed: onModel,
      });
      await db.recordTaskComplete(taskId, { commits: 0 });
      return text;
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    if (systemDir) await fs.rm(systemDir, { recursive: true, force: true }).catch(() => {});
  }
}

function logOutcome(
  repo: string,
  request: CompletionRequest,
  status: number,
  durationMs: number,
  used: { provider: Provider; model: string | null } | null,
  outputChars: number | null,
): void {
  const line =
    `[${NAME}] ${repo}: ${status} provider=${used?.provider ?? request.provider} model=${used?.model ?? request.model ?? request.tier} ` +
    `pinned=${request.pinned} durationMs=${durationMs} promptChars=${request.prompt.length} systemChars=${request.system?.length ?? 0}` +
    (outputChars === null ? "" : ` outputChars=${outputChars}`);
  if (status >= 500) log.warn(line);
  else log.info(line);
}

/** Exposed for tests. */
export function resetCompletionConcurrencyForTests(): void {
  running.clear();
}
