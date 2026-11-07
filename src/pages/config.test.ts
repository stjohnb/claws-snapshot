import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// getMacRunnerRepos() is the union of the host's macRunnerRepos and repos that
// enrol themselves via their own claws.json (#2898/#2932); tests mutate this to
// exercise the union hint on the Mac Runner Repos field.
const mocks = vi.hoisted(() => ({
  repoDeclaredMacRunnerRepos: [] as string[],
  activationState: "active",
  piBinary: false,
  piSources: [] as string[],
  defaultModelTiers: undefined as Record<string, string> | undefined,
  wif: {
    configured: false,
    lastExchange: null as { ok: boolean; at: string; detail: string } | null,
  },
}));

vi.mock("../config.js", () => ({
  getConfigForDisplay: () => ({
    slackWebhook: "****cdef",
    oidcClientSecret: "****wxyz",
    openrouterApiKey: "Not configured",
    anthropicApiKey: "****9xyz",
    aiProviders: {
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 1 },
    },
    port: 3000,
    intervals: {}, schedules: {},
    whatsappAllowedNumbers: [], disabledAgents: [],
    ...(mocks.defaultModelTiers ? { defaultModelTiers: mocks.defaultModelTiers } : {}),
  }),
  VALID_AGENT_NAMES: [],
  AI_PROVIDER_NAMES: ["claude", "codex", "opencode", "pi"],
  DEFAULT_AI_PROVIDERS: {
    claude: { enabled: true, weight: 4 },
    codex: { enabled: true, weight: 2 },
    opencode: { enabled: true, weight: 1 },
    pi: { enabled: true, weight: 0 },
  },
  getUnknownConfigKeys: () => [],
  get ACTIVATION_STATE() {
    return mocks.activationState;
  },
  OPENROUTER_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_WIF_RULE_ID: "fdrl_rule",
  ANTHROPIC_WIF_SERVICE_ACCOUNT_ID: "svac_sa",
  ANTHROPIC_WIF_K8S_SERVICE_ACCOUNT: "claws-anthropic",
  getMacRunnerRepos: vi.fn(() => mocks.repoDeclaredMacRunnerRepos),
}));
vi.mock("../claude.js", () => ({ isOpenCodeBinaryAvailable: () => false, isPiBinaryAvailable: () => mocks.piBinary }));
vi.mock("../pi-auth.js", () => ({ piCredentialSources: () => mocks.piSources }));
vi.mock("../anthropic-wif.js", () => ({
  isAnthropicWifConfigured: () => mocks.wif.configured,
  anthropicCredentialState: () => ({ mode: mocks.wif.configured ? "wif" : "none", lastExchange: mocks.wif.lastExchange }),
}));

import { buildConfigPage } from "./config.js";

const srcRoot = path.dirname(fileURLToPath(import.meta.url));

describe("config page never leaks live secret values", () => {
  it("reads config through getConfigForDisplay(), never loadConfig() (#2903)", () => {
    // Switching to loadConfig() would put plaintext secrets in the page HTML —
    // getConfigForDisplay() masks every SENSITIVE_KEYS entry before it reaches this page.
    const source = fs.readFileSync(path.join(srcRoot, "config.ts"), "utf-8");
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(source).toContain("getConfigForDisplay()");
    expect(code).not.toMatch(/\bloadConfig\s*\(/);
    expect(code).not.toMatch(/import\s*\{[^}]*\bloadConfig\b[^}]*\}\s*from\s*"\.\.\/config\.js"/);
  });

  it("renders masked placeholders, not plaintext secret values", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).toContain('placeholder="****cdef"');
    expect(html).toContain('placeholder="****wxyz"');
    expect(html).toContain('placeholder="Not configured"');
  });

  it("renders the Anthropic API key as a masked secret field and the OpenCode spend warning", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).toContain('name="anthropicApiKey"');
    expect(html).toContain('placeholder="****9xyz"');
    expect(html).toContain("Anthropic API Key");
    expect(html).toContain("Used by OpenCode for <code>anthropic/</code> models only");
    expect(html).toContain("Optional; used for <code>openrouter/</code> models");
    expect(html).toMatch(/name="opencodeSpendWarnUsd" id="opencodeSpendWarnUsd" value="150" min="0"/);
  });

  it("notes that workload identity federation is not configured under the Anthropic key", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).toContain("Workload identity federation: not configured — the static key is used.");
    expect(html).not.toContain("Ignored while workload identity federation is configured");
  });

  it("shows the federation rule, service accounts and last exchange when configured", () => {
    mocks.wif.configured = true;
    mocks.wif.lastExchange = { ok: false, at: "2026-11-04T12:00:00.000Z", detail: "HTTP 401 authentication_error" };
    try {
      const html = buildConfigPage(false, "dark");
      expect(html).toContain("Workload identity federation: configured (rule <code>fdrl_rule</code>, service account <code>svac_sa</code>, k8s SA <code>claws-anthropic</code>); last exchange: failed (HTTP 401 authentication_error) at");
      expect(html).toContain('datetime="2026-11-04T12:00:00.000Z"');
      expect(html).toContain("Ignored while workload identity federation is configured");
    } finally {
      mocks.wif.configured = false;
      mocks.wif.lastExchange = null;
    }
  });

  it("shows the (no API key set) hint when no OpenRouter key is configured", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).toContain("(no API key set)");
  });

  it("renders provider enabled and weight fields instead of primary fallback controls", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).not.toContain('name="primaryProvider"');
    expect(html).not.toContain('name="fallback_');
    for (const provider of ["claude", "codex", "opencode", "pi"]) {
      expect(html).toContain(`name="providerEnabled_${provider}"`);
      expect(html).toContain(`name="providerWeight_${provider}"`);
    }
  });

  it("renders the Pi provider row at weight 0, and lets every weight go to 0 (pin-only)", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).not.toContain("Pi (via OpenRouter)");
    expect(html).toContain("(pi CLI not installed)");
    expect(html).toMatch(/name="providerWeight_pi" id="providerWeight_pi" value="0" min="0"/);
    expect(html).not.toContain('min="0.01"');
    expect(html).toContain("<strong>Use Pi</strong>");
    expect(html).toContain("Weight 0 keeps a provider out of the random draw; it then runs only when a Use label or model-plan cell pins it.");
    expect(html).toContain('name="piCheapModel"');
  });

  it("asks for a pi credential only when the binary is installed and no source exists", () => {
    mocks.piBinary = true;
    try {
      mocks.piSources = [];
      expect(buildConfigPage(false, "dark")).toContain("(no pi credential — log in on /reauth or set an API key)");
      mocks.piSources = ["anthropic"];
      const html = buildConfigPage(false, "dark");
      expect(html).not.toContain("no pi credential");
      expect(html).not.toContain("(pi CLI not installed)");
    } finally {
      mocks.piBinary = false;
      mocks.piSources = [];
    }
  });

  it("documents pi's provider/id model prefixes in the tier table", () => {
    const html = buildConfigPage(false, "dark");
    for (const prefix of ["anthropic/", "openai-codex/", "openai/", "openrouter/"]) {
      expect(html).toContain(`<code>${prefix}</code>`);
    }
  });

  it("does not render the retired issue-tracker checkbox (#3294)", () => {
    expect(buildConfigPage(false, "dark")).not.toContain('name="issueTracker"');
  });

  it("renders staging activation controls from verify-only", () => {
    const previous = mocks.activationState;
    mocks.activationState = "verify-only";
    try {
      const html = buildConfigPage(false, "dark");
      expect(html).toContain("verify-only");
      expect(html).toContain("Enable staging pipeline");
      expect(html).toContain("Activate fully");
    } finally {
      mocks.activationState = previous;
    }
  });

  it("describes staging as a label-restricted issue/PR pipeline", () => {
    const previous = mocks.activationState;
    mocks.activationState = "staging";
    try {
      const html = buildConfigPage(false, "dark");
      expect(html).toContain("only issue/PR pipeline workers run");
      expect(html).toContain("Claws Staging");
      expect(html).toContain("Switch to verify-only");
    } finally {
      mocks.activationState = previous;
    }
  });

  it("renders the shipped Codex tier fallback values", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).toContain('name="codexDefaultModel"');
    expect(html).toContain('value="gpt-5.5"');
    expect(html).toContain('name="codexLightModel"');
    expect(html).toContain('value="gpt-5.6-terra"');
    expect(html).toContain('name="codexCheapModel"');
    expect(html).toContain('value="gpt-5.6-luna"');
  });

  it("renders one tier-table row per tier, with every configurable cell", () => {
    const html = buildConfigPage(false, "dark");
    for (const label of ["Fable", "Opus", "Sonnet", "Haiku"]) {
      expect(html).toContain(`<span class="tier-name">${label}</span>`);
    }
    for (const name of ["claudeFableModel", "codexFableModel", "opencodeFableModel", "claudeCheapModel", "opencodeBestModel", "opencodeAdequateModel", "opencodeCheapModel"]) {
      expect(html).toContain(`name="${name}"`);
    }
    // Claude's opus and sonnet cells are CLI aliases with nothing to configure.
    expect(html).not.toContain('name="claudeOpusModel"');
    expect(html).toContain('<div class="tier-fixed"><code>opus</code></div>');
    expect(html).toContain('<div class="tier-fixed"><code>sonnet</code></div>');
  });

  it("renders the review model tier as a select over all four tiers (#3253)", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).toContain('name="reviewModelTier"');
    expect(html).toContain('<option value="fable">Fable</option>');
    expect(html).toContain('<option value="haiku">Haiku</option>');
    expect(html).toContain('<option value="sonnet" selected>Sonnet</option>');
  });

  it("renders a default-tier select for every DEFAULT_TIER_TABLE row with its shipped default", async () => {
    const { DEFAULT_TIER_TABLE, defaultTierFieldName } = await import("../model-selector.js");
    const html = buildConfigPage(false, "dark");
    expect(html).toContain("<h3>Pipeline phases</h3>");
    expect(html).toContain("<h3>Scheduled and background jobs</h3>");
    expect(DEFAULT_TIER_TABLE.map((r) => r.key)).toEqual([
      "requirements", "plan", "plan-refine", "implement", "review", "ci-fix", "review-address",
      "doc-maintainer", "idea-suggester", "friction-retrospective", "email-monitor", "whatsapp-handler",
      "public-snapshot-sync", "escalation-reviewer", "prompt-guard-judge",
    ]);
    for (const row of DEFAULT_TIER_TABLE) {
      const name = defaultTierFieldName(row.key);
      const select = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>(.*?)</select>`))?.[1];
      expect(select, name).toBeDefined();
      expect(select).toContain(`<option value="${row.shippedDefault}" selected>`);
    }
    expect(html).toContain('name="defaultTier_requirements"');
    expect(html).toContain("Shipped default: Opus");
    expect(html).toContain("Shipped default: Fable");
    expect(html).toContain("Shipped default: Haiku");
    // The review row is the existing reviewModelTier setting, not a second field.
    expect(html).not.toContain('name="defaultTier_review"');
  });

  it("shows an operator-changed default tier as the current value", () => {
    mocks.defaultModelTiers = { requirements: "fable" };
    try {
      const html = buildConfigPage(false, "dark");
      expect(html).toMatch(/name="defaultTier_requirements"[^>]*><option value="fable" selected>/);
    } finally {
      mocks.defaultModelTiers = undefined;
    }
  });

  it("pins a default tier set by environment variable", () => {
    process.env["CLAWS_DEFAULT_TIER_REQUIREMENTS"] = "fable";
    try {
      const html = buildConfigPage(false, "dark");
      expect(html).toMatch(/<select class="form-select" name="defaultTier_requirements" id="defaultTier_requirements" disabled>/);
      expect(html).toContain("Set via environment variable CLAWS_DEFAULT_TIER_REQUIREMENTS");
      expect(html).not.toMatch(/name="defaultTier_plan" id="defaultTier_plan" disabled/);
    } finally {
      delete process.env["CLAWS_DEFAULT_TIER_REQUIREMENTS"];
    }
  });

  it("credits claws.json-declared repos in the Mac Runner Repos note (#2932)", () => {
    expect(buildConfigPage(false, "dark")).not.toContain("also enabled by their own claws.json");

    mocks.repoDeclaredMacRunnerRepos = ["Owner/SelfDeclared"];
    try {
      const html = buildConfigPage(false, "dark");
      expect(html).toContain("also enabled by their own claws.json");
      expect(html).toContain("Owner/SelfDeclared");
    } finally {
      mocks.repoDeclaredMacRunnerRepos = [];
    }
  });
});

describe("connectivity checks in the Activation section", () => {
  it("renders the latest report's failing check and the Run checks form", () => {
    const html = buildConfigPage(false, "dark", {
      generatedAt: "2026-09-23T10:00:00Z",
      checks: [
        { name: "github-api", ok: true, ms: 120 },
        { name: "slack-dns", ok: false, ms: 45, detail: "ENOTFOUND hooks.slack.com" },
      ],
    });
    expect(html).toContain('<section class="config-static-block" id="activation">');
    expect(html).toContain('<td class="cell-title" data-label="Check">slack-dns</td>');
    expect(html).toContain('<td data-label="Status" class="slack-error">FAIL</td>');
    expect(html).toContain("ENOTFOUND hooks.slack.com");
    expect(html).toContain('<form method="POST" action="/api/verify/run">');
    expect(html).toContain(">Run checks</button>");
    expect(html).not.toContain('href="/verify"');
  });

  it("shows an empty state and still offers Run checks when no report exists", () => {
    const html = buildConfigPage(false, "dark", null);
    expect(html).toContain("No verification report yet");
    expect(html).toContain(">Run checks</button>");
  });
});
