import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isRateLimitError, clearOllamaAvailabilityCache, RATE_LIMIT_RE } from "./ollama-rate-limit-classifier.js";

// Mock the config module
vi.mock("./config.js", () => ({
  OLLAMA_BASE_URL: "https://ollama.test",
  OLLAMA_TIMEOUT_MS: 100, // short for tests
  OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE: 3,
}));

// Mock log module
vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

describe("RATE_LIMIT_RE", () => {
  it("matches rate limit patterns", () => {
    expect(RATE_LIMIT_RE.test("You have hit your rate limit")).toBe(true);
    expect(RATE_LIMIT_RE.test("quota exceeded for this month")).toBe(true);
    expect(RATE_LIMIT_RE.test("HTTP 429 Too Many Requests")).toBe(true);
    expect(RATE_LIMIT_RE.test("HTTP 529")).toBe(true);
    expect(RATE_LIMIT_RE.test("API overloaded")).toBe(true);
    expect(RATE_LIMIT_RE.test("too many requests")).toBe(true);
  });

  it("does not match non-rate-limit errors", () => {
    expect(RATE_LIMIT_RE.test("Internal server error")).toBe(false);
    expect(RATE_LIMIT_RE.test("ECONNREFUSED")).toBe(false);
    expect(RATE_LIMIT_RE.test("syntax error in line 42")).toBe(false);
  });
});

describe("isRateLimitError", () => {
  beforeEach(() => {
    clearOllamaAvailabilityCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    clearOllamaAvailabilityCache();
  });

  it("returns true when Ollama responds YES", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: "YES, this is a rate limit error" }),
    }));

    const result = await isRateLimitError("You have hit your rate limit");
    expect(result).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns false when Ollama responds NO", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: "NO" }),
    }));

    const result = await isRateLimitError("Internal server error");
    expect(result).toBe(false);
    vi.unstubAllGlobals();
  });

  it("falls back to regex when fetch throws ECONNREFUSED", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    // Regex would match this
    const result = await isRateLimitError("rate limit exceeded");
    expect(result).toBe(true);
    vi.unstubAllGlobals();
  });

  it("falls back to regex and returns false for non-rate-limit error on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await isRateLimitError("Internal server error");
    expect(result).toBe(false);
    vi.unstubAllGlobals();
  });

  it("trips circuit breaker after N consecutive failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    // 3 failures should trip the breaker
    await isRateLimitError("error 1");
    await isRateLimitError("error 2");
    await isRateLimitError("error 3");

    // Circuit breaker is now tripped. Next call should NOT call fetch
    const fetchMock = vi.fn().mockRejectedValue(new Error("should not be called"));
    vi.stubGlobal("fetch", fetchMock);

    await isRateLimitError("rate limit exceeded");

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("resets consecutive failure counter on successful response", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: "NO" }),
      })
    );

    await isRateLimitError("error 1");
    await isRateLimitError("error 2");
    await isRateLimitError("error 3 — success"); // success resets counter

    // Should have called fetch 3 times (not skipped due to breaker)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("clearOllamaAvailabilityCache resets state between tests", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    // Trip the breaker
    await isRateLimitError("e1");
    await isRateLimitError("e2");
    await isRateLimitError("e3");

    clearOllamaAvailabilityCache();

    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    // After clearing, Ollama should be attempted again
    await isRateLimitError("e4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
