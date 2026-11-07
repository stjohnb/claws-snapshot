import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import { Hono } from "hono";

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockClaude, mockHolds, mockDb, mockSelector, breakers, shutdown } = vi.hoisted(() => {
  class AgentCliError extends Error {
    constructor(message: string, public provider?: string) {
      super(message);
      this.name = "AgentCliError";
    }
  }
  class AgentTimeoutError extends Error {
    constructor() {
      super("timed out");
      this.name = "AgentTimeoutError";
    }
  }
  class AllProvidersRateLimitedError extends Error {}
  class NoEligibleProviderError extends Error {}
  /** Open breakers: provider → until, and `claude:<tier>` → until. */
  const breakers = new Map<string, number>();
  return {
    breakers,
    shutdown: { value: false },
    mockClaude: {
      AgentCliError,
      AgentTimeoutError,
      AllProvidersRateLimitedError,
      runClaude: vi.fn(),
      classifyUsageLimit: (msg: string) => (/hit your .*limit/i.test(msg) ? "account" : null),
      UNSUPPORTED_MODEL_RE: /\bmodel_not_found\b/,
      getProviderRateLimitedUntil: (p: string) => ((breakers.get(p) ?? 0) > Date.now() ? breakers.get(p)! : null),
    },
    // `claude` / `claude:<tier>` stand for "every account is held" (for that tier).
    mockHolds: {
      providerHoldsStale: vi.fn(() => true),
      refreshProviderHolds: vi.fn(async () => {}),
      claudeProviderHeldUntil: vi.fn((t?: string) => {
        const times = ["claude", ...(t ? [`claude:${t}`] : [])].map((k) => breakers.get(k) ?? 0).filter((u) => u > Date.now());
        return times.length > 0 ? Math.max(...times) : null;
      }),
    },
    mockDb: {
      withTaskRecording: vi.fn(async (_job: string, _repo: string, _item: unknown, _label: unknown, fn: (id: number) => Promise<unknown>) => fn(77)),
      trackTaskTokens: vi.fn(() => vi.fn()),
      recordTaskComplete: vi.fn(async () => {}),
    },
    mockSelector: {
      NoEligibleProviderError,
      normalizeTier: (raw: string) => (["fable", "opus", "sonnet", "haiku"].includes(raw) ? raw : null),
      getPinnableProviders: vi.fn(() => ["claude", "codex", "opencode", "pi"]),
      getEnabledProviderWeights: vi.fn(() => [
        { provider: "claude", weight: 4 },
        { provider: "codex", weight: 2 },
        { provider: "pi", weight: 1 },
      ]),
    },
  };
});

vi.mock("./claude.js", () => mockClaude);
vi.mock("./provider-holds.js", () => mockHolds);
vi.mock("./db.js", () => mockDb);
vi.mock("./model-selector.js", () => mockSelector);
vi.mock("./github.js", () => ({ fetchRepoFileContent: vi.fn(async () => null) }));
vi.mock("./agent-memory-budget.js", () => ({ AUXILIARY_AGENT_ADMISSION_BYTES: 123 }));
vi.mock("./session-models.js", () => ({
  sessionModelsFor: (provider: string) =>
    provider === "claude"
      ? [{ id: "fable" }, { id: "opus" }, { id: "sonnet" }, { id: "haiku" }]
      : provider === "codex"
        ? [{ id: "gpt-5.5" }, { id: "gpt-5.6-luna" }]
        : [{ id: "openrouter/x" }],
}));
vi.mock("./shutdown.js", () => ({
  isShuttingDown: () => shutdown.value,
  ShutdownError: class ShutdownError extends Error {},
}));

import * as log from "./log.js";
import { clearRepoConfigCache, refreshRepoConfigs } from "./repo-config.js";
import {
  completionAuthMiddleware,
  completionHandler,
  COMPLETION_TIMEOUT_MS,
  CONCURRENCY_RETRY_AFTER_SECONDS,
  MAX_COMPLETION_INPUT_CHARS,
  resetCompletionConcurrencyForTests,
  parseCompletionRequest,
  runIsolatedCompletion,
  CompletionProviderHeldError,
} from "./completion-api.js";

const TOKEN = "caller-token";
const OTHER_TOKEN = "other-caller-token";
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

const app = new Hono();
app.post("/api/completion/:owner/:name", completionAuthMiddleware, completionHandler);

function post(body: unknown, { token = TOKEN as string | null, repo = "org/Caller" } = {}) {
  return app.request(`/api/completion/${repo}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The options of the last `runClaude` call. */
function lastRunOptions(): Record<string, any> {
  const calls = mockClaude.runClaude.mock.calls;
  return calls[calls.length - 1]![2];
}

/** Make `runClaude` report `provider`/`model` as used and return `text`. */
function answerWith(text: string, provider = "claude", model: string | undefined = "sonnet") {
  mockClaude.runClaude.mockImplementation(async (_p: string, _cwd: string, opts: any) => {
    opts.onAttemptModelUsed?.(provider, model);
    return text;
  });
}

function allLogged(): string {
  return [log.debug, log.info, log.warn, log.error].flatMap((fn) => vi.mocked(fn).mock.calls.flat()).map(String).join("\n");
}

beforeEach(async () => {
  clearRepoConfigCache();
  resetCompletionConcurrencyForTests();
  breakers.clear();
  shutdown.value = false;
  mockClaude.runClaude.mockReset();
  mockDb.withTaskRecording.mockClear();
  mockDb.recordTaskComplete.mockClear();
  for (const fn of [log.debug, log.info, log.warn, log.error]) vi.mocked(fn).mockClear();
  const files: Record<string, string> = {
    "org/Caller": JSON.stringify({ completion: { tokenSha256: sha(TOKEN) } }),
    "org/other": JSON.stringify({ completion: { tokenSha256: sha(OTHER_TOKEN) } }),
    "org/plain": JSON.stringify({}),
  };
  await refreshRepoConfigs(Object.keys(files).map((fullName) => ({ fullName })), async (name) => files[name] ?? null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auth", () => {
  it.each([
    ["missing", null, "org/Caller"],
    ["wrong", "nope", "org/Caller"],
    ["another repo's", OTHER_TOKEN, "org/Caller"],
    ["own token on another repo's path", TOKEN, "org/other"],
    ["any token on a repo with no completion entry", TOKEN, "org/plain"],
  ])("answers a bare 401 to a %s token", async (_name, token, repo) => {
    const res = await post({ prompt: "hi" }, { token, repo });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });
});

describe("a successful completion", () => {
  it("returns the text plus the provider and model used, on Claude sonnet by default, unpinned", async () => {
    answerWith("the answer");
    const res = await post({ prompt: "hi" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "the answer", provider: "claude", model: "sonnet" });
    const opts = lastRunOptions();
    expect(opts).toMatchObject({
      tier: "sonnet",
      provider: "claude",
      strictProvider: false,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      admissionBytes: 123,
      captureLabel: "completion-api",
    });
    expect(opts.model).toBeUndefined();
    // The fallback pool is the completion backends only — never pi.
    expect(opts.eligibleProviders).toEqual([{ provider: "claude", weight: 4 }, { provider: "codex", weight: 2 }]);
    expect(opts.isolatedCompletion).toEqual({ systemPrompt: undefined, systemPromptFile: undefined });
  });

  it("runs in an empty temporary directory that is removed afterwards, with the system prompt in a separate file", async () => {
    let seen: { cwd: string; entries: string[]; systemFile: string; system: string } | undefined;
    mockClaude.runClaude.mockImplementation(async (_p: string, cwd: string, opts: any) => {
      seen = { cwd, entries: fs.readdirSync(cwd), systemFile: opts.isolatedCompletion.systemPromptFile, system: fs.readFileSync(opts.isolatedCompletion.systemPromptFile, "utf8") };
      return "ok";
    });
    expect((await post({ prompt: "hi", system: "Be terse." })).status).toBe(200);
    expect(seen!.entries).toEqual([]);
    expect(seen!.system).toBe("Be terse.");
    expect(seen!.systemFile.startsWith(seen!.cwd)).toBe(false);
    expect(fs.existsSync(seen!.cwd)).toBe(false);
    expect(fs.existsSync(seen!.systemFile)).toBe(false);
    expect(lastRunOptions().isolatedCompletion.systemPrompt).toBe("Be terse.");
  });

  it("records a completion-api task attributed to the caller, with token tracking", async () => {
    answerWith("ok");
    await post({ prompt: "hi" });
    expect(mockDb.withTaskRecording).toHaveBeenCalledWith("completion-api", "org/Caller", 0, null, expect.any(Function));
    expect(mockDb.trackTaskTokens).toHaveBeenCalledWith(77);
    expect(lastRunOptions().onTokensUsed).toBe(mockDb.trackTaskTokens.mock.results.at(-1)!.value);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(77, { commits: 0 });
  });

  it("honours a pinned provider and model", async () => {
    answerWith("ok", "codex", "gpt-5.6-luna");
    const res = await post({ prompt: "hi", provider: "codex", model: "gpt-5.6-luna" });
    expect(await res.json()).toEqual({ text: "ok", provider: "codex", model: "gpt-5.6-luna" });
    expect(lastRunOptions()).toMatchObject({ provider: "codex", model: "gpt-5.6-luna", strictProvider: true, tier: "sonnet" });
    expect(lastRunOptions().eligibleProviders).toBeUndefined();
  });

  it("pins a model without a provider to Claude and carries it as the tier", async () => {
    answerWith("ok", "claude", "haiku");
    await post({ prompt: "hi", model: "haiku" });
    expect(lastRunOptions()).toMatchObject({ provider: "claude", tier: "haiku", strictProvider: true });
    expect(lastRunOptions().model).toBeUndefined();
  });

  it("logs counts only, never the prompt, system prompt or output", async () => {
    answerWith("SECRET-OUTPUT");
    await post({ prompt: "SECRET-PROMPT", system: "SECRET-SYSTEM" });
    const logged = allLogged();
    expect(logged).toContain("promptChars=13");
    for (const secret of ["SECRET-OUTPUT", "SECRET-PROMPT", "SECRET-SYSTEM", TOKEN]) expect(logged).not.toContain(secret);
  });
});

describe("validation", () => {
  it.each([
    ["no prompt", {}],
    ["an empty prompt", { prompt: "  " }],
    ["a non-string system", { prompt: "x", system: 1 }],
    ["an array body", [1]],
    ["invalid JSON", "{"],
  ])("answers 400 to %s", async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("answers 400 naming the valid providers for an unknown provider, pi included", async () => {
    for (const provider of ["gemini", "pi"]) {
      const res = await post({ prompt: "x", provider });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("provider must be one of: claude, codex, opencode");
    }
  });

  it("drops a provider the operator has disabled from the valid choices", async () => {
    mockSelector.getPinnableProviders.mockReturnValueOnce(["claude"]);
    const res = await post({ prompt: "x", provider: "codex" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("provider must be one of: claude");
  });

  it("starts an unpinned request on an enabled provider when Claude is disabled", async () => {
    mockSelector.getPinnableProviders.mockReturnValue(["codex"]);
    try {
      const parsed = parseCompletionRequest({ prompt: "x" });
      expect(parsed.ok && parsed.request.provider).toBe("codex");
      expect(parsed.ok && parsed.request.pinned).toBe(false);
    } finally {
      mockSelector.getPinnableProviders.mockReturnValue(["claude", "codex", "opencode", "pi"]);
    }
  });

  it("answers 400 naming the valid models for an unknown model", async () => {
    const res = await post({ prompt: "x", provider: "codex", model: "gpt-4" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("model for provider codex must be one of: gpt-5.5, gpt-5.6-luna");
    const claude = await post({ prompt: "x", model: "gpt-5.5" });
    expect(((await claude.json()) as { error: string }).error).toBe("model for provider claude must be one of: fable, opus, sonnet, haiku");
  });

  it("answers 413 when prompt and system together exceed the cap, without logging them", async () => {
    const half = "p".repeat(MAX_COMPLETION_INPUT_CHARS / 2);
    answerWith("ok");
    // Exactly at the cap is allowed.
    expect((await post({ prompt: half, system: half })).status).toBe(200);
    mockClaude.runClaude.mockClear();
    const res = await post({ prompt: half, system: `${half}x` });
    expect(res.status).toBe(413);
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(allLogged()).not.toContain(half);
  });
});

describe("limits and errors", () => {
  it("answers 429 with Retry-After once the caller has two completions running", async () => {
    const releases: Array<() => void> = [];
    mockClaude.runClaude.mockImplementation(() => new Promise<string>((resolve) => releases.push(() => resolve("ok"))));
    const first = post({ prompt: "1" });
    const second = post({ prompt: "2" });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const third = await post({ prompt: "3" });
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBe(String(CONCURRENCY_RETRY_AFTER_SECONDS));
    // Another caller has its own cap.
    answerWith("ok");
    expect((await post({ prompt: "x" }, { token: OTHER_TOKEN, repo: "org/other" })).status).toBe(200);
    for (const release of releases) release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await post({ prompt: "4" })).status).toBe(200);
  });

  it("answers 429 with the breaker's Retry-After for a pinned provider at its usage limit, spawning nothing", async () => {
    breakers.set("codex", Date.now() + 90_000);
    const res = await post({ prompt: "x", provider: "codex" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(89);
    expect(Number(res.headers.get("Retry-After"))).toBeLessThanOrEqual(90);
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("answers 429 for a pinned Claude tier that is held down", async () => {
    breakers.set("claude:opus", Date.now() + 30_000);
    expect((await post({ prompt: "x", model: "opus" })).status).toBe(429);
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    // Judged across the Claude accounts for the requested tier, after reading the shared holds.
    expect(mockHolds.refreshProviderHolds).toHaveBeenCalled();
    expect(mockHolds.claudeProviderHeldUntil).toHaveBeenCalledWith("opus");
  });

  it("lets an unpinned request run while Claude is held down, so runClaude can fall back", async () => {
    breakers.set("claude", Date.now() + 30_000);
    answerWith("from codex", "codex", "gpt-5.5");
    const res = await post({ prompt: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "from codex", provider: "codex", model: "gpt-5.5" });
    expect(lastRunOptions().strictProvider).toBe(false);
  });

  it("maps a run's usage-limit error to 429 with Retry-After", async () => {
    mockClaude.runClaude.mockImplementation(async () => {
      breakers.set("claude", Date.now() + 3_600_000);
      throw new mockClaude.AgentCliError("You've hit your weekly limit", "claude");
    });
    const res = await post({ prompt: "x", provider: "claude" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(3_000);
  });

  it("maps every provider being rate-limited to 429, defaulting Retry-After to 60 s", async () => {
    mockClaude.runClaude.mockRejectedValue(new mockClaude.AllProvidersRateLimitedError());
    const res = await post({ prompt: "x" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("maps a timeout to 504 without leaking the prompt", async () => {
    mockClaude.runClaude.mockRejectedValue(new mockClaude.AgentTimeoutError());
    const res = await post({ prompt: "SECRET-PROMPT" });
    expect(res.status).toBe(504);
    expect(allLogged()).not.toContain("SECRET-PROMPT");
  });

  it("answers 504 when admission plus the run outlast the overall deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockClaude.runClaude.mockImplementation(() => new Promise<string>(() => {}));
    const pending = post({ prompt: "x" });
    await vi.waitFor(() => expect(mockClaude.runClaude).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(COMPLETION_TIMEOUT_MS + 25_000);
    expect((await pending).status).toBe(504);
  });

  it("maps an unsupported model to 400, no provider to 503, and anything else to a bare 502", async () => {
    mockClaude.runClaude.mockRejectedValueOnce(new mockClaude.AgentCliError("model_not_found", "codex"));
    expect((await post({ prompt: "x", provider: "codex" })).status).toBe(400);
    mockClaude.runClaude.mockRejectedValueOnce(new mockSelector.NoEligibleProviderError());
    expect((await post({ prompt: "x" })).status).toBe(503);
    mockClaude.runClaude.mockRejectedValueOnce(new mockClaude.AgentCliError("SECRET-STDERR crash", "claude"));
    const res = await post({ prompt: "x" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "completion failed" });
    expect(allLogged()).not.toContain("SECRET-STDERR");
  });

  it("answers 503 while shutting down", async () => {
    shutdown.value = true;
    expect((await post({ prompt: "x" })).status).toBe(503);
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });
});

describe("runIsolatedCompletion", () => {
  it("runs pinned to Claude at the default tier, recorded as a completion-api task for the repo", async () => {
    answerWith("{}", "claude", "claude-sonnet-x");
    const result = await runIsolatedCompletion("org/plain", { prompt: "p", system: "s" });
    expect(result).toEqual({ text: "{}", provider: "claude", model: "claude-sonnet-x" });
    expect(lastRunOptions()).toMatchObject({ tier: "sonnet", provider: "claude", strictProvider: true, captureLabel: "completion-api" });
    expect(lastRunOptions().eligibleProviders).toBeUndefined();
    expect(mockDb.withTaskRecording).toHaveBeenCalledWith("completion-api", "org/plain", 0, null, expect.any(Function));
  });

  it("falls back to the tier as the model name when the CLI reports none", async () => {
    answerWith("ok", "claude", undefined);
    expect((await runIsolatedCompletion("org/plain", { prompt: "p" })).model).toBe("sonnet");
  });

  it("throws without running while Claude is held down", async () => {
    breakers.set("claude", Date.now() + 60_000);
    await expect(runIsolatedCompletion("org/plain", { prompt: "p" })).rejects.toBeInstanceOf(CompletionProviderHeldError);
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });
});
