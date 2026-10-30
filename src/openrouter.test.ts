import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("openrouter", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefixes ids with openrouter/, sorts, and dedupes", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: "anthropic/claude-opus-5" }, { id: "google/gemini-3-pro" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { listOpenRouterSessionModels } = await import("./openrouter.js");
    const models = await listOpenRouterSessionModels();
    expect(models).toEqual(["openrouter/anthropic/claude-opus-5", "openrouter/google/gemini-3-pro"]);
  });

  it("drops ~-prefixed ids, which would 400 on session create", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: "~anthropic/claude-fable-latest" }, { id: "anthropic/claude-opus-5" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { listOpenRouterSessionModels } = await import("./openrouter.js");
    const models = await listOpenRouterSessionModels();
    expect(models).toEqual(["openrouter/anthropic/claude-opus-5"]);
  });

  it("does not cache a failed fetch — a later call re-fetches", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "anthropic/claude-opus-5" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const { listOpenRouterSessionModels } = await import("./openrouter.js");
    await expect(listOpenRouterSessionModels()).rejects.toThrow("HTTP 500");
    const models = await listOpenRouterSessionModels();
    expect(models).toEqual(["openrouter/anthropic/claude-opus-5"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent callers into a single fetch", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: "anthropic/claude-opus-5" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { listOpenRouterSessionModels } = await import("./openrouter.js");
    const [a, b] = await Promise.all([listOpenRouterSessionModels(), listOpenRouterSessionModels()]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await listOpenRouterSessionModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
