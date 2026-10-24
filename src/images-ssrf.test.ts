import { describe, it, expect, vi } from "vitest";
import { fetch as undiciFetch } from "undici";

// images.ts now imports isForgejoRepo/forgejo helpers directly (not just via
// github.js) to route Forgejo attachment URLs around this SSRF guard; mock
// them out so this file's import of images.js doesn't pull in real config/API
// client code that this test has no interest in exercising.
vi.mock("./config.js", () => ({ isForgejoRepo: () => false }));
vi.mock("./forgejo.js", () => ({
  isConfigured: () => false,
  isAttachmentUrl: () => false,
  fetchAttachment: vi.fn(),
}));

import { ssrfSafeDispatcher } from "./images.js";

describe("ssrfSafeDispatcher", () => {
  it("refuses to connect when the hostname resolves to loopback", async () => {
    // If ssrfSafeDispatcher's connect.lookup weren't wired up this would fail
    // with ECONNREFUSED instead — so this also proves the guard is honoured by
    // the fetch/Agent pairing images.ts actually uses in fetchWithGuard.
    const err = await undiciFetch("http://localhost:65535/", {
      dispatcher: ssrfSafeDispatcher,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const cause = (err as { cause?: unknown }).cause;
    expect(cause instanceof Error ? cause.message : String(err)).toMatch(/blocked: private address/);
  });
});
