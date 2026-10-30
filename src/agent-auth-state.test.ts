import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  PROVIDER_RATE_LIMIT_COOLDOWN_MS: 5 * 60_000,
  DASHBOARD_URL: "https://claws.example.com",
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockNotify = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./slack.js", () => ({
  notify: mockNotify,
}));

import {
  agentAuthFingerprint,
  isAgentAuthFailure,
  noteAgentAuthFailure,
  noteAgentAuthSuccess,
  isAgentAuthExpired,
  reauthInstruction,
  REALERT_MS,
  __resetAgentAuthStateForTests,
} from "./agent-auth-state.js";
import { setClaudeAccounts } from "./claude-accounts.js";

describe("agent-auth-state", () => {
  beforeEach(() => {
    __resetAgentAuthStateForTests();
    mockNotify.mockClear();
  });

  it("matches known agent CLI auth failure messages", () => {
    expect(
      isAgentAuthFailure(new Error("Failed to authenticate: OAuth session expired and could not be refreshed")),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isAgentAuthFailure(new Error("API Error: 500"))).toBe(false);
    expect(isAgentAuthFailure(new Error("you're out of usage"))).toBe(false);
  });

  it("alerts on the first failure and suppresses the next five", () => {
    expect(noteAgentAuthFailure("first")).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(noteAgentAuthFailure(`failure ${i}`)).toBe(false);
    }
    expect(isAgentAuthExpired()).toBe(true);
  });

  it("re-alerts once the hourly window has elapsed, then suppresses again", () => {
    const t0 = 1_700_000_000_000;
    expect(noteAgentAuthFailure("first", t0)).toBe(true);
    expect(noteAgentAuthFailure("just under the window", t0 + REALERT_MS - 1)).toBe(false);
    expect(noteAgentAuthFailure("window elapsed", t0 + REALERT_MS)).toBe(true);
    // The re-alert restarts the window rather than re-alerting every call.
    expect(noteAgentAuthFailure("right after the re-alert", t0 + REALERT_MS + 1)).toBe(false);
    expect(noteAgentAuthFailure("second window elapsed", t0 + 2 * REALERT_MS)).toBe(true);
    expect(isAgentAuthExpired()).toBe(true);
  });

  it("clears the latch on success without posting to Slack, and re-alerts on the next failure", () => {
    noteAgentAuthFailure("first");
    expect(isAgentAuthExpired()).toBe(true);

    noteAgentAuthSuccess();
    expect(isAgentAuthExpired()).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();

    expect(noteAgentAuthFailure("second episode")).toBe(true);
  });

  it("does not notify when clearing an already-clear latch", () => {
    noteAgentAuthSuccess();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("builds the reauth URL from DASHBOARD_URL", () => {
    expect(reauthInstruction()).toBe("https://claws.example.com/reauth");
  });

  it("matches pi's missing-credential messages", () => {
    expect(isAgentAuthFailure(new Error('{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}'))).toBe(true);
    expect(isAgentAuthFailure(new Error("No API key found for openai-codex.\n\nUse /login to log into a provider via OAuth or API key."))).toBe(true);
  });

  it("matches codex's refresh-token expiry message", () => {
    expect(
      isAgentAuthFailure(
        new Error(
          "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
        ),
      ),
    ).toBe(true);
  });

  it("latches codex and claude independently", () => {
    expect(noteAgentAuthFailure("codex down", Date.now(), "codex")).toBe(true);
    expect(isAgentAuthExpired("codex")).toBe(true);
    // The claude latch must not be set by a codex failure — a claude re-auth
    // cannot fix a codex credential (#2538).
    expect(isAgentAuthExpired("claude")).toBe(false);

    // A first claude failure is still a fresh episode, alerting on its own.
    expect(noteAgentAuthFailure("claude down", Date.now(), "claude")).toBe(true);
    expect(isAgentAuthExpired("claude")).toBe(true);

    // Clearing one leaves the other latched.
    noteAgentAuthSuccess("claude");
    expect(isAgentAuthExpired("claude")).toBe(false);
    expect(isAgentAuthExpired("codex")).toBe(true);
  });

  it("gives each provider its own re-alert window", () => {
    const t0 = 1_700_000_000_000;
    expect(noteAgentAuthFailure("codex first", t0, "codex")).toBe(true);
    expect(noteAgentAuthFailure("codex second", t0 + 1, "codex")).toBe(false);
    // Inside codex's suppression window, claude's first failure still alerts.
    expect(noteAgentAuthFailure("claude first", t0 + 2, "claude")).toBe(true);
  });

  it("keeps claude's original fingerprint and namespaces the others", () => {
    expect(agentAuthFingerprint()).toBe("agent-auth-expired");
    expect(agentAuthFingerprint("claude")).toBe("agent-auth-expired");
    expect(agentAuthFingerprint("codex")).toBe("agent-auth-expired-codex");
    expect(agentAuthFingerprint("opencode")).toBe("agent-auth-expired-opencode");
  });

  describe("per Claude account", () => {
    beforeEach(() => {
      setClaudeAccounts([{ id: "a", label: "Account A", token: "tok-a" }, { id: "b", label: "b", token: "tok-b" }]);
    });
    afterEach(() => {
      setClaudeAccounts([]);
    });

    it("latches one account without the others, and Claude only when every account is expired", () => {
      expect(noteAgentAuthFailure("a down", Date.now(), "claude", "a")).toBe(true);
      expect(isAgentAuthExpired("claude", "a")).toBe(true);
      expect(isAgentAuthExpired("claude", "b")).toBe(false);
      expect(isAgentAuthExpired("claude")).toBe(false);
      // A second account's first failure is its own episode.
      expect(noteAgentAuthFailure("b down", Date.now(), "claude", "b")).toBe(true);
      expect(isAgentAuthExpired("claude")).toBe(true);
    });

    it("clears only the account whose run or login succeeded", () => {
      noteAgentAuthFailure("a down", Date.now(), "claude", "a");
      noteAgentAuthFailure("b down", Date.now(), "claude", "b");
      noteAgentAuthSuccess("claude", "a");
      expect(isAgentAuthExpired("claude", "a")).toBe(false);
      expect(isAgentAuthExpired("claude", "b")).toBe(true);
    });

    it("names the account in its fingerprint and reauth instruction", () => {
      expect(agentAuthFingerprint("claude", "a")).toBe("agent-auth-expired-claude-a");
      expect(reauthInstruction("claude", "a")).toBe('https://claws.example.com/reauth (Claude account "Account A": Start login in its section)');
    });
  });

  it("points codex and pi at the dashboard too, and names both OpenCode keys", () => {
    expect(reauthInstruction("codex")).toBe("https://claws.example.com/reauth");
    expect(reauthInstruction("pi")).toBe("https://claws.example.com/reauth");
    const opencode = reauthInstruction("opencode");
    expect(opencode).toContain("Anthropic API Key");
    expect(opencode).toContain("`CLAWS_ANTHROPIC_API_KEY`");
    expect(opencode).toContain("`claws-auth` Secret");
    expect(opencode).toContain("invalid x-api-key");
    expect(opencode).toContain("`CLAWS_OPENROUTER_API_KEY`");
    expect(opencode).toContain("User not found.");
  });

  it("classifies Anthropic's 401 'invalid x-api-key' and a missing key as auth failures", () => {
    const raw =
      '{"type":"error","sessionID":"ses_x","error":{"name":"APIError","data":{"message":"invalid x-api-key","statusCode":401,"isRetryable":false}}}';
    expect(isAgentAuthFailure(new Error(raw))).toBe(true);
    expect(isAgentAuthFailure(new Error("invalid x-api-key"))).toBe(true);
    expect(isAgentAuthFailure(new Error("No API key found for anthropic — set the Anthropic API key"))).toBe(true);
    expect(isAgentAuthFailure(new Error("No API key found for openrouter — set the OpenRouter API key"))).toBe(true);
  });

  it("classifies OpenRouter's 401 'User not found.' as an auth failure", () => {
    expect(isAgentAuthFailure(new Error("User not found."))).toBe(true);
    const raw =
      '{"type":"error","sessionID":"ses_x","error":{"name":"APIError","data":{"message":"User not found.","statusCode":401,"isRetryable":false}}}';
    expect(isAgentAuthFailure(new Error(raw))).toBe(true);
    const notFound =
      '{"type":"error","error":{"name":"APIError","data":{"message":"Not Found","statusCode":404,"isRetryable":false}}}';
    expect(isAgentAuthFailure(new Error(notFound))).toBe(false);
    expect(isAgentAuthFailure(new Error("something else broke"))).toBe(false);
  });
});
