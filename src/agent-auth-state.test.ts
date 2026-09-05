import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
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

  it("clears the latch on success, notifies once, and re-alerts on the next failure", () => {
    noteAgentAuthFailure("first");
    expect(isAgentAuthExpired()).toBe(true);

    noteAgentAuthSuccess();
    expect(isAgentAuthExpired()).toBe(false);
    expect(mockNotify).toHaveBeenCalledTimes(1);

    expect(noteAgentAuthFailure("second episode")).toBe(true);
  });

  it("does not notify when clearing an already-clear latch", () => {
    noteAgentAuthSuccess();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("builds the reauth URL from DASHBOARD_URL", () => {
    expect(reauthInstruction()).toBe("https://claws.example.com/reauth");
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

  it("points codex at the dashboard too, and gives opencode a shell instruction", () => {
    expect(reauthInstruction("codex")).toBe("https://claws.example.com/reauth");
    expect(reauthInstruction("opencode")).toBe("run `opencode auth login` on the Claws host");
  });
});
