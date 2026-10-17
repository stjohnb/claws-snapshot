import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as pty from "node-pty";
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Opt-in probes against the installed `claude` CLI (#3022), skipped by default
 * because CI has no Claude installation. Run with:
 *
 *   CLAWS_REAL_CLAUDE_AUTH_TEST=1 npx vitest run src/claude-auth-real.test.ts
 *
 * They run `claude setup-token` under a throwaway HOME, never authorize, and
 * only ever submit a fabricated code, which Anthropic's token endpoint rejects.
 * Assertions compare booleans so a failure never prints the OAuth URL.
 */

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./agent-auth-state.js", () => ({ noteAgentAuthSuccess: vi.fn() }));
vi.mock("./jobs/auth-secret-sync.js", () => ({ syncAuthSecret: vi.fn().mockResolvedValue(undefined) }));

import { startClaudeLogin, submitClaudeLoginCode, getClaudeLoginStatus } from "./claude-auth.js";

/** Same shape and length as a real `code#state` (~100 chars). */
function fakeAuthCode(): string {
  const chunk = (n: number): string =>
    Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[Math.floor(Math.random() * 64)]).join("");
  return `${chunk(64)}#${chunk(43)}`;
}

describe.runIf(process.env["CLAWS_REAL_CLAUDE_AUTH_TEST"] === "1")("claude setup-token (real CLI)", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "claws-claude-auth-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = home;
  });

  afterAll(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("the web flow gets a complete URL and delivers a pasted long code to the token exchange", async () => {
    const start = await startClaudeLogin();
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?\S+$/.test(start.url)).toBe(true);
    expect(start.url.includes("code_challenge=") && start.url.includes("state=")).toBe(true);
    expect(start.url.split("https://").length - 1).toBe(1);

    // A fabricated code must reach the exchange and be rejected quickly. Before
    // #3022 the CLI swallowed the Enter and this timed out after 60s.
    const t0 = Date.now();
    const r = await submitClaudeLoginCode(fakeAuthCode());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.includes("Timed out")).toBe(false);
      expect(r.error.includes("OAuth error")).toBe(true);
      expect(r.error.includes("https://")).toBe(false);
    }
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(getClaudeLoginStatus().lastAttempt?.phase).toBe("submit");
  }, 60_000);

  it("documents the CLI behaviour: a long code written together with Enter is taken as a paste and never submitted", async () => {
    const proc = pty.spawn("claude", ["setup-token"], {
      name: "xterm-color",
      cols: 800,
      rows: 40,
      cwd: home,
      env: { ...process.env, HOME: home },
    });
    let buffer = "";
    proc.onData((d) => {
      buffer += stripVTControlCharacters(d);
    });
    try {
      const deadline = Date.now() + 30_000;
      while (!/Paste\s*code\s*here\s*if\s*prompted\s*>/i.test(buffer) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(/Paste\s*code\s*here\s*if\s*prompted\s*>/i.test(buffer)).toBe(true);

      const scanFrom = buffer.length;
      proc.write(fakeAuthCode() + "\r");
      await new Promise((r) => setTimeout(r, 8_000));
      const after = buffer.slice(scanFrom);
      expect(/\*{10,}/.test(after)).toBe(true); // the masked code was echoed…
      expect(/OAuth error|Invalid code|Press Enter to retry/.test(after)).toBe(false); // …but never submitted
    } finally {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }, 60_000);
});
