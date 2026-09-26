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
}));

vi.mock("../config.js", () => ({
  getConfigForDisplay: () => ({
    slackWebhook: "****cdef",
    oidcClientSecret: "****wxyz",
    openrouterApiKey: "Not configured",
    aiProviders: {
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 1 },
    },
    githubOwners: ["owner1"],
    port: 3000,
    intervals: {}, schedules: {},
    whatsappAllowedNumbers: [], disabledAgents: [],
  }),
  VALID_AGENT_NAMES: [],
  AI_PROVIDER_NAMES: ["claude", "codex", "opencode"],
  DEFAULT_AI_PROVIDERS: {
    claude: { enabled: true, weight: 4 },
    codex: { enabled: true, weight: 2 },
    opencode: { enabled: true, weight: 1 },
  },
  getUnknownConfigKeys: () => [],
  get ACTIVATION_STATE() {
    return mocks.activationState;
  },
  OPENROUTER_API_KEY: "",
  getMacRunnerRepos: vi.fn(() => mocks.repoDeclaredMacRunnerRepos),
}));
vi.mock("../claude.js", () => ({ isOpenCodeBinaryAvailable: () => false }));

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

  it("shows the (no API key set) hint when no OpenRouter key is configured", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).toContain("(no API key set)");
  });

  it("renders provider enabled and weight fields instead of primary fallback controls", () => {
    const html = buildConfigPage(false, "dark");
    expect(html).not.toContain('name="primaryProvider"');
    expect(html).not.toContain('name="fallback_');
    for (const provider of ["claude", "codex", "opencode"]) {
      expect(html).toContain(`name="providerEnabled_${provider}"`);
      expect(html).toContain(`name="providerWeight_${provider}"`);
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
