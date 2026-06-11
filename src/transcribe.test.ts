import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { OPENAI_API_KEY: "sk-test-key", WHISPER_BASE_URL: "" },
}));

vi.mock("./config.js", () => mockConfig);

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockShutdown } = vi.hoisted(() => ({
  mockShutdown: { isShuttingDown: vi.fn().mockReturnValue(false) },
}));

vi.mock("./shutdown.js", () => mockShutdown);

import { transcribe, isAvailable, WhisperRateLimitError, clearWhisperLocalAvailabilityCache } from "./transcribe.js";

describe("transcribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockConfig.OPENAI_API_KEY = "sk-test-key";
    mockConfig.WHISPER_BASE_URL = "";
    mockShutdown.isShuttingDown.mockReturnValue(false);
    clearWhisperLocalAvailabilityCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns true from isAvailable when API key is set", () => {
    expect(isAvailable()).toBe(true);
  });

  it("returns false from isAvailable when API key is empty", () => {
    mockConfig.OPENAI_API_KEY = "";
    expect(isAvailable()).toBe(false);
  });

  it("returns true from isAvailable when only WHISPER_BASE_URL is set", () => {
    mockConfig.OPENAI_API_KEY = "";
    mockConfig.WHISPER_BASE_URL = "http://whisper.local";
    expect(isAvailable()).toBe(true);
  });

  it("returns false from isAvailable when both are empty", () => {
    mockConfig.OPENAI_API_KEY = "";
    mockConfig.WHISPER_BASE_URL = "";
    expect(isAvailable()).toBe(false);
  });

  it("transcribes audio successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "Hello, this is a test" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    const result = await transcribe(audio);

    expect(result).toBe("Hello, this is a test");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ Authorization: "Bearer sk-test-key" });
    const body = opts.body as FormData;
    expect(body.get("prompt")).toBeNull();
  });

  it("includes prompt in form data when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "Kwyjibo is broken" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    const result = await transcribe(audio, "voice-note.ogg", "Kwyjibo, Claws");

    expect(result).toBe("Kwyjibo is broken");
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = opts.body as FormData;
    expect(body.get("prompt")).toBe("Kwyjibo, Claws");
  });

  it("throws when no API key is set", async () => {
    mockConfig.OPENAI_API_KEY = "";
    const audio = Buffer.from("fake-audio-data");
    await expect(transcribe(audio)).rejects.toThrow("set WHISPER_BASE_URL or OPENAI_API_KEY");
  });

  it("throws on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: () => Promise.resolve("Bad request"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    await expect(transcribe(audio)).rejects.toThrow("HTTP 400");
  });

  it("retries on 429 and succeeds on subsequent attempt", async () => {
    vi.useFakeTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "1" }),
        text: () => Promise.resolve("Rate limited"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ text: "Transcribed text" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    const promise = transcribe(audio);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("Transcribed text");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws WhisperRateLimitError after exhausting retries on 429", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: () => Promise.resolve("Rate limited"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    const promise = transcribe(audio);
    const assertion = expect(promise).rejects.toThrow(WhisperRateLimitError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("bails out immediately when shutting down", async () => {
    mockShutdown.isShuttingDown.mockReturnValue(true);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: () => Promise.resolve("Rate limited"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    await expect(transcribe(audio)).rejects.toThrow(WhisperRateLimitError);
    // Should not retry — only 1 fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx and succeeds on subsequent attempt", async () => {
    vi.useFakeTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: () => Promise.resolve("Service Unavailable"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ text: "Recovered" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    const promise = transcribe(audio);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("Recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws generic Error (not WhisperRateLimitError) after exhausting retries on 5xx", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: () => Promise.resolve("Internal Server Error"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    const promise = transcribe(audio);
    const assertion = expect(promise).rejects.toSatisfy((err: Error) => {
      return err.message.includes("HTTP 500") && !(err instanceof WhisperRateLimitError);
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("caps Retry-After delay at 30 seconds", async () => {
    vi.useFakeTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "3600" }),
        text: () => Promise.resolve("Rate limited"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ text: "Done" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    const promise = transcribe(audio);
    // 30s should be enough (capped from 3600s)
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(result).toBe("Done");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  describe("local Whisper", () => {
    beforeEach(() => {
      mockConfig.WHISPER_BASE_URL = "http://whisper.local";
    });

    it("uses local Whisper when WHISPER_BASE_URL is set", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: "Local transcription" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");
      const result = await transcribe(audio);

      expect(result).toBe("Local transcription");
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://whisper.local/v1/audio/transcriptions");
      // No Authorization header for local
      const opts = mockFetch.mock.calls[0][1] as RequestInit;
      expect((opts.headers as Record<string, string> | undefined)?.["Authorization"]).toBeUndefined();
    });

    it("does not call OpenAI when local Whisper succeeds", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: "Local result" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");
      await transcribe(audio);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("whisper.local");
    });

    it("falls back to OpenAI when local Whisper fails", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Server error"),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ text: "OpenAI result" }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");
      const result = await transcribe(audio);

      expect(result).toBe("OpenAI result");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [url1] = mockFetch.mock.calls[0] as [string];
      const [url2] = mockFetch.mock.calls[1] as [string];
      expect(url1).toContain("whisper.local");
      expect(url2).toBe("https://api.openai.com/v1/audio/transcriptions");
    });

    it("falls back to OpenAI when local Whisper returns 429", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve("Rate limited"),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ text: "OpenAI result after 429" }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");
      const result = await transcribe(audio);

      expect(result).toBe("OpenAI result after 429");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [url1] = mockFetch.mock.calls[0] as [string];
      const [url2] = mockFetch.mock.calls[1] as [string];
      expect(url1).toContain("whisper.local");
      expect(url2).toBe("https://api.openai.com/v1/audio/transcriptions");
    });

    it("throws WhisperRateLimitError when local Whisper returns 429 and no OpenAI key", async () => {
      mockConfig.OPENAI_API_KEY = "";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limited"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");
      await expect(transcribe(audio)).rejects.toThrow(WhisperRateLimitError);
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("throws when local Whisper fails and no OpenAI key", async () => {
      mockConfig.OPENAI_API_KEY = "";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("Unavailable"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");
      await expect(transcribe(audio)).rejects.toThrow("HTTP 503");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("circuit breaker trips after 3 consecutive local failures, skips to OpenAI", async () => {
      // 3 failures to trip the circuit breaker, then a success via OpenAI
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("err") })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: "fallback1" }) })
        .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("err") })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: "fallback2" }) })
        .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("err") })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: "fallback3" }) })
        // After 3 failures, circuit is open — next call should go straight to OpenAI
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: "direct-openai" }) });
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");

      // 3 calls that each fail local, fall back to OpenAI
      await transcribe(audio);
      await transcribe(audio);
      await transcribe(audio);

      // Circuit breaker should now be open — 4th call should go straight to OpenAI (1 fetch, not 2)
      const callsBefore = mockFetch.mock.calls.length;
      const result = await transcribe(audio);
      const callsAfter = mockFetch.mock.calls.length;

      expect(result).toBe("direct-openai");
      expect(callsAfter - callsBefore).toBe(1);
      const [url] = mockFetch.mock.calls[callsBefore] as [string];
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    });

    it("throws a clear error when circuit breaker is open and no OpenAI key is set", async () => {
      mockConfig.OPENAI_API_KEY = "";
      // Trip the circuit breaker with 3 consecutive failures (each falls through since no OpenAI key)
      const failResponse = { ok: false, status: 503, text: () => Promise.resolve("err") };
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(failResponse);
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");
      // Each call fails local and rethrows since no OpenAI key; accumulate failures
      await expect(transcribe(audio)).rejects.toThrow("HTTP 503");
      await expect(transcribe(audio)).rejects.toThrow("HTTP 503");
      await expect(transcribe(audio)).rejects.toThrow("HTTP 503");

      // Circuit breaker is now open; next call should skip local Whisper and throw the specific message
      await expect(transcribe(audio)).rejects.toThrow(
        "local Whisper is temporarily disabled and OPENAI_API_KEY is not set"
      );
      // No additional fetch calls — local was skipped entirely
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("circuit breaker trips after 3 consecutive network errors, skips to OpenAI", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: "fallback1" }) })
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: "fallback2" }) })
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: "fallback3" }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: "direct-openai" }) });
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");
      await transcribe(audio);
      await transcribe(audio);
      await transcribe(audio);

      const callsBefore = mockFetch.mock.calls.length;
      const result = await transcribe(audio);
      const callsAfter = mockFetch.mock.calls.length;

      expect(result).toBe("direct-openai");
      expect(callsAfter - callsBefore).toBe(1);
    });

    it("clearWhisperLocalAvailabilityCache resets circuit breaker so local is tried again", async () => {
      // Trip the circuit breaker
      const failResponse = { ok: false, status: 503, text: () => Promise.resolve("err") };
      const openaiSuccess = { ok: true, json: () => Promise.resolve({ text: "openai" }) };
      const localSuccess = { ok: true, json: () => Promise.resolve({ text: "local-again" }) };

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(openaiSuccess)
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(openaiSuccess)
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(openaiSuccess)
        // After reset, local should be tried again
        .mockResolvedValueOnce(localSuccess);
      vi.stubGlobal("fetch", mockFetch);

      const audio = Buffer.from("fake-audio-data");
      await transcribe(audio);
      await transcribe(audio);
      await transcribe(audio);

      clearWhisperLocalAvailabilityCache();

      const result = await transcribe(audio);
      expect(result).toBe("local-again");
      const [url] = mockFetch.mock.calls[6] as [string];
      expect(url).toContain("whisper.local");
    });
  });
});
