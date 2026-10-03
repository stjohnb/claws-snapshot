import { describe, it, expect, vi } from "vitest";
import vm from "node:vm";

vi.mock("../config.js", () => ({
  ACTIVATION_STATE: "active",
}));

import { buildReauthPage } from "./reauth.js";

describe("buildReauthPage", () => {
  const html = buildReauthPage("system");

  it("renders the Claude authorization URL as a link", () => {
    expect(html).toMatch(/<a id="url-link" class="auth-url-link"[^>]*target="_blank"/);
  });

  it("has a persistent previous-attempt display driven by lastAttempt", () => {
    expect(html).toContain('<div id="previous-status"');
    expect(html).toContain("d.lastAttempt");
    expect(html).toContain("supersededByAttemptId");
    expect(html).toContain("d.lastFailedSubmit");
  });

  it("renders a provider cooldowns section with a row per provider and a clear-cooldown control", () => {
    expect(html).toContain("Provider cooldowns");
    expect(html).toContain('data-provider="claude"');
    expect(html).toContain('data-provider="codex"');
    expect(html).toContain('data-provider="opencode"');
    expect(html).toContain("cooldown-clear-btn");
    expect(html).toContain("/api/providers");
    expect(html).toContain("/api/providers/\" + provider + \"/clear-rate-limit");
  });

  it("collapses the cooldowns table to cards on narrow viewports", () => {
    expect(html).toMatch(/<div class="table-scroll"><table id="cooldowns-table" class="data-cards">/);
    expect(html).toContain('data-label="Provider"');
    expect(html).toContain('data-label="Status"');
    expect(html).toContain('data-label="Action"');
  });
});

/**
 * `showLastAttempt`/`describeAttempt` are pure functions embedded in the
 * page's inline `<script>` (no build step splits client logic into a
 * separately-testable module here, see docs/modules.md). Extract their exact
 * source out of the rendered HTML and run it against a stubbed
 * `previousStatus` element so the branch behaviour — which sentence is
 * appended, and when a stale lastFailedSubmit is suppressed — has real
 * coverage instead of only a substring check.
 */
function runShowLastAttempt(status: unknown): string {
  const html = buildReauthPage("system");
  const match = /function describeAttempt[\s\S]*?function refreshLastAttempt/.exec(html);
  if (!match) throw new Error("could not locate describeAttempt/showLastAttempt in reauth.ts output");
  const source = match[0].replace(/function refreshLastAttempt$/, "");

  const previousStatus = { textContent: "" };
  const context = vm.createContext({ previousStatus });
  vm.runInContext(`(function (status) { ${source}\nshowLastAttempt(status); })(${JSON.stringify(status)});`, context);
  return previousStatus.textContent;
}

describe("showLastAttempt", () => {
  it("shows nothing when there is no prior attempt", () => {
    expect(runShowLastAttempt({ status: "idle", lastAttempt: null, lastFailedSubmit: null })).toBe("");
  });

  it("points at the current URL once a fresh login is ready", () => {
    const text = runShowLastAttempt({
      status: "awaiting-code",
      url: "https://claude.ai/oauth/authorize?x=1",
      lastAttempt: {
        attemptId: 1,
        status: "failed",
        phase: "submit",
        message: "boom",
        occurredAt: "2026-01-01T00:00:00Z",
        promptReady: true,
        supersededByAttemptId: 2,
      },
      lastFailedSubmit: null,
    });
    expect(text).toContain("failed during code submission");
    expect(text).toContain("A fresh login has since been started");
  });

  it("prompts to retry instead of claiming a fresh login when the retry itself failed", () => {
    const text = runShowLastAttempt({
      status: "failed",
      url: null,
      lastAttempt: {
        attemptId: 2,
        status: "failed",
        phase: "start",
        message: "start boom",
        occurredAt: "2026-01-01T00:00:00Z",
        promptReady: false,
      },
      lastFailedSubmit: {
        attemptId: 1,
        status: "failed",
        phase: "submit",
        message: "submit boom",
        occurredAt: "2026-01-01T00:00:00Z",
        promptReady: true,
        supersededByAttemptId: 2,
      },
    });
    expect(text).toContain("failed during code submission");
    expect(text).toContain("Click Start login to try again.");
    expect(text).not.toContain("A fresh login has since been started");
  });

  it("hides lastFailedSubmit once a completed login clears it", () => {
    const text = runShowLastAttempt({
      status: "completed",
      url: null,
      lastAttempt: { attemptId: 3, status: "completed", phase: "submit", message: null, occurredAt: "2026-01-01T00:00:00Z", promptReady: true },
      lastFailedSubmit: {
        attemptId: 1,
        status: "failed",
        phase: "submit",
        message: "submit boom",
        occurredAt: "2026-01-01T00:00:00Z",
        promptReady: true,
        supersededByAttemptId: 2,
      },
    });
    expect(text).toBe("");
  });
});
