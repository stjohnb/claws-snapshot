import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { OPENAI_API_KEY: "sk-test-key" },
}));

vi.mock("./config.js", () => mockConfig);

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { transcribe, isAvailable } from "./transcribe.js";

describe("transcribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockConfig.OPENAI_API_KEY = "sk-test-key";
  });

  it("returns true from isAvailable when API key is set", () => {
    expect(isAvailable()).toBe(true);
  });

  it("returns false from isAvailable when API key is empty", () => {
    mockConfig.OPENAI_API_KEY = "";
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
    await expect(transcribe(audio)).rejects.toThrow("OPENAI_API_KEY not set");
  });

  it("throws on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Rate limited"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const audio = Buffer.from("fake-audio-data");
    await expect(transcribe(audio)).rejects.toThrow("HTTP 429");
  });
});
