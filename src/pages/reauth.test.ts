import { describe, it, expect, vi } from "vitest";
import vm from "node:vm";

vi.mock("../config.js", () => ({
  ACTIVATION_STATE: "active",
}));
vi.mock("../db.js", () => ({}));

import { buildReauthPage } from "./reauth.js";
import { setClaudeAccounts } from "../claude-accounts.js";

setClaudeAccounts([
  { id: "primary", label: "Primary", token: "sk-ant-oat01-SECRET-PRIMARY" },
  { id: "second-max", label: "Second <Max>", token: null },
]);

describe("buildReauthPage", () => {
  const html = buildReauthPage("system");

  it("renders the Claude authorization URL as a link", () => {
    expect(html).toMatch(/<a id="url-link-primary" class="auth-url-link"[^>]*target="_blank"/);
  });

  it("has a persistent previous-attempt display driven by lastAttempt", () => {
    expect(html).toContain('<div id="previous-status-primary"');
    expect(html).toContain("d.lastAttempt");
    expect(html).toContain("supersededByAttemptId");
    expect(html).toContain("d.lastFailedSubmit");
  });

  it("renders one Claude section per configured account, each with its own login routes and token state", () => {
    expect(html).toContain("<h3>Claude — Primary</h3>");
    expect(html).toContain("<h3>Claude — Second &lt;Max&gt;</h3>");
    for (const id of ["primary", "second-max"]) {
      expect(html).toContain(`id="start-btn-${id}"`);
      expect(html).toContain(`id="code-input-${id}"`);
      expect(html).toContain(`id="complete-btn-${id}"`);
      expect(html).toContain(`<span id="token-${id}">Checking…</span>`);
      expect(html).toContain(`var ACCOUNT = "${id}";`);
    }
    // Accounts are database state: no env key to set, and never a token.
    expect(html).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(html).not.toContain("sk-ant-oat01-SECRET-PRIMARY");
    expect(html).toContain('fetch("/api/claude-auth/" + ACCOUNT + "/start"');
    expect(html).toContain('fetch("/api/claude-auth/" + ACCOUNT + "/code"');
    expect(html).not.toContain('fetch("/api/claude-auth/start"');
  });

  it("has an Add account form posting id and label to /api/claude-accounts, with an inline alert", () => {
    expect(html).toContain('<form id="account-add" class="account-form">');
    expect(html).toMatch(/<input id="account-add-id" type="text" required maxlength="32" pattern="\[a-z0-9\]\[a-z0-9\\-\]\{0,31\}"/);
    expect(html).toContain('id="account-add-label"');
    expect(html).toContain('<button id="account-add-btn" class="auth-btn" type="submit">Add</button>');
    expect(html).toContain('<p id="account-add-error" class="status-err" role="alert"></p>');
    expect(html).toContain('fetch("/api/claude-accounts", {');
  });

  it("gives each account a Rename field and a confirm-guarded Remove button", () => {
    expect(html).toContain('<input id="label-input-second-max" type="text" maxlength="64" autocomplete="off" value="Second &lt;Max&gt;">');
    for (const id of ["primary", "second-max"]) {
      expect(html).toContain(`id="rename-btn-${id}"`);
      expect(html).toContain(`<button id="remove-btn-${id}" class="auth-btn account-remove" type="button">Remove</button>`);
      expect(html).toContain(`<p id="account-error-${id}" class="status-err" role="alert"></p>`);
    }
    expect(html).toContain('fetch("/api/claude-accounts/" + ACCOUNT, {');
    expect(html).toMatch(/if \(!confirm\('Remove Claude account "' \+ ACCOUNT/);
  });

  it("stacks the account forms full-width at 40px on a phone and in one 30px row from 768px", () => {
    expect(html).toContain(".account-form > * { flex: 1 1 100%; min-height: 40px; }");
    expect(html).toMatch(/@media \(min-width: 768px\) \{\s*\.account-form > \* \{ flex: 0 1 auto; min-height: 30px; \}/);
  });

  it("says so, and still offers Add account, when no account exists", () => {
    setClaudeAccounts([]);
    try {
      const empty = buildReauthPage("system");
      expect(empty).toContain('id="no-claude-accounts"');
      expect(empty).toContain('id="account-add"');
      expect(empty).not.toContain('id="start-btn-');
    } finally {
      setClaudeAccounts([
        { id: "primary", label: "Primary", token: "sk-ant-oat01-SECRET-PRIMARY" },
        { id: "second-max", label: "Second <Max>", token: null },
      ]);
    }
  });

  it("shows each account's login state, hold and tier holds, with its own Clear cooldown", () => {
    for (const id of ["primary", "second-max"]) {
      expect(html).toContain(`id="auth-${id}"`);
      expect(html).toContain(`id="hold-${id}"`);
      expect(html).toContain(`id="tier-holds-${id}"`);
      expect(html).toContain(`id="clear-btn-${id}"`);
    }
    expect(html).toContain('"/api/providers/claude/accounts/" + ACCOUNT + "/clear-rate-limit"');
    expect(html).toContain('"Held until " + localTime(a.rateLimitedUntil) : "No hold"');
    expect(html).toContain("a.authExpired ? \"Auth expired\"");
  });

  it("counts held Claude accounts in the cooldowns table", () => {
    expect(html).toContain('" of " + accounts.length + " accounts held"');
    // Expired logins are counted apart and do not enable Clear cooldown.
    expect(html).toContain('(expired === 1 ? " login" : " logins") + " expired"');
    expect(html).toContain("btn.disabled = !canClear;");
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

  it("renders a Pi readiness table between Codex and the cooldowns, with no login controls", () => {
    const codex = html.indexOf("<h2>Codex</h2>");
    const pi = html.indexOf("<h2>Pi</h2>");
    const cooldowns = html.indexOf("<h2>Provider cooldowns</h2>");
    expect(codex).toBeGreaterThan(-1);
    expect(pi).toBeGreaterThan(codex);
    expect(cooldowns).toBeGreaterThan(pi);
    const section = html.slice(pi, cooldowns);
    expect(section).toMatch(/<div class="table-scroll"><table id="pi-auth-table" class="data-cards">/);
    expect(section).toContain("<th>Provider</th><th>Source</th><th>Status</th>");
    expect(section).toContain('fetch("/api/pi-auth/providers")');
    expect(section).toContain('id="pi-refresh-btn"');
    expect(section).not.toMatch(/login",\s*\{\s*method: "POST"/);
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

function runSetUrl(url: string): { href: unknown; textContent: string; source: string } {
  const html = buildReauthPage("system");
  const match = /function isHttp[\s\S]*?function setUrl[\s\S]*?(?=function selectUrlText)/.exec(html);
  if (!match) throw new Error("could not locate setUrl in reauth.ts output");
  const source = match[0];
  const urlLink = { textContent: "", href: "" as unknown };
  const context = vm.createContext({ urlLink });
  vm.runInContext(`(function (url) { ${source}\nsetUrl(url); })(${JSON.stringify(url)});`, context);
  return { href: urlLink.href, textContent: urlLink.textContent, source };
}

describe("setUrl", () => {
  const url =
    "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key%20user%3Aprofile%20user%3Ainference&state=abc123";

  it("sets the link href and text to the authorization URL", () => {
    const result = runSetUrl(url);
    expect(result.href).toBe(url);
    expect(result.textContent).toBe(url);
  });

  it("does not render an unescaped regex literal that swallows the rest of the line", () => {
    expect(buildReauthPage("system")).not.toContain("https?:///");
    expect(runSetUrl(url).source).not.toMatch(/\/\^/);
  });
});
