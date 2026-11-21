import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #clw_01M7Q9T4AQAGSG48Z3P7B273HR: a session's default or pre-selected
// capability set holds only read-only capabilities, plus `forgejo` and the
// agent logins. Runs against the real capability registry; the config mock is
// copied from capabilities.test.ts, with every write capability configured so
// the filter (not unavailability) is what keeps them out.
const mockConfig = vi.hoisted(() => ({
  HOME_ASSISTANT_BASE_URL: "http://ha.example.test:8123",
  HOME_ASSISTANT_TOKEN: "ha-secret",
  FLEET_GRAFANA_URL: "https://grafana.home.example",
  // Empty: grafana-jwt.ts generates an in-memory key on first mint.
  GRAFANA_JWT_SIGNING_KEY: "",
  writeConfig: async () => {},
  FORGEJO_TOKEN: "fgj-token",
  FORGEJO_READ_TOKEN: "fgj-read",
  FORGEJO_ADMIN_TOKEN: "fgj-admin",
  FORGEJO_BASE_URL: "https://git.example.test",
  FORGEJO_REPOS: [] as string[],
  OPENROUTER_API_KEY: "or-key",
  ANTHROPIC_API_KEY: "ant-key",
  ANTHROPIC_WIF_RULE_ID: "",
  ANTHROPIC_WIF_ORGANIZATION_ID: "",
  ANTHROPIC_WIF_SERVICE_ACCOUNT_ID: "",
  OPENAI_API_KEY: "",
  GITHUB_APP_ID: 0,
  GITHUB_OWNER_APP_CREDENTIALS: {} as Record<string, { appId?: number; privateKeyPath?: string }>,
  PAGES_HOST: {
    endpoint: "https://s3.example.test",
    region: "us-east-1",
    bucket: "pages",
    baseUrl: "https://pages.example.test",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
  },
  PRINT_SERVER: "cups.example.test:631",
  PROD_CLUSTER_TAILNET_HOST: "prod-cluster-2.tailc20cf.ts.net",
  PROD_DATA_TAILNET_HOST: "prod-data-3.tailc20cf.ts.net",
  resolveLanHost: <T extends { host: string; user?: string }>(target: T): T => target,
  getMacRunnerRepos: (): readonly string[] => ["Owner/MacRepo"],
  MAC_RUNNERS: [
    { name: "Brendans-MacBook-Pro", host: "brendans-macbook-pro.local", labels: ["macos", "tempo"] },
  ],
}));

vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), mockConfig));

import { setClaudeAccounts } from "./claude-accounts.js";
import {
  REPO_CAPABILITY_DEFAULTS,
  allCapabilities,
  availableCapabilities,
  isAgentLoginCapability,
  isReadOnlyCapability,
  FORGEJO_CAPABILITY_ID,
} from "./capabilities.js";
import { sessionCapabilityDefaultsKey } from "./db.js";
import { preselectedSessionCapabilities } from "./session-form-defaults.js";
import { SESSION_PROVIDERS } from "./sessions.js";

const cfg = mockConfig as unknown as Record<string, unknown>;
let realPodSettings: unknown;

beforeEach(() => {
  realPodSettings = cfg.SESSION_POD_SETTINGS;
  // home-assistant-read needs a session MCP URL to be offered.
  cfg.SESSION_POD_SETTINGS = { ...(realPodSettings as object), mcpUrl: "https://claws.example.test" };
  setClaudeAccounts([{ id: "primary", label: "primary", token: "claude-token" }]);
});

afterEach(() => {
  cfg.SESSION_POD_SETTINGS = realPodSettings;
  setClaudeAccounts([]);
});

/** True for an id a default or remembered set may hold. */
function allowedInDefaults(id: string): boolean {
  return isReadOnlyCapability(id) || id === FORGEJO_CAPABILITY_ID || isAgentLoginCapability(id);
}

// fleet-observability resolves only with the claws-service credentials mounted
// (#clw_01M7QFE3ZDE06M6JW202445NPX).
const AUTHENTIK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claws-authentik-"));
fs.writeFileSync(path.join(AUTHENTIK_DIR, "username"), "claws-service");
fs.writeFileSync(path.join(AUTHENTIK_DIR, "app-password"), "test-pass");
process.env.CLAWS_AUTHENTIK_CREDENTIALS_DIR = AUTHENTIK_DIR;
afterAll(() => fs.rmSync(AUTHENTIK_DIR, { recursive: true, force: true }));

describe("session default capabilities are read-only (#clw_01M7Q9T4AQAGSG48Z3P7B273HR)", () => {
  it("seeds only read-only capabilities in REPO_CAPABILITY_DEFAULTS", () => {
    for (const [repo, ids] of Object.entries(REPO_CAPABILITY_DEFAULTS)) {
      for (const id of ids) expect(isReadOnlyCapability(id), `${repo}: ${id}`).toBe(true);
    }
  });

  it("drops every write capability from a remembered set, for one and two repos and every provider", () => {
    const available = availableCapabilities().map((c) => c.id);
    // The write capabilities are configured here, so only the filter keeps them out.
    for (const id of ["home-assistant", "forgejo-admin", "pages", "print", "ssh:nas"]) expect(available, id).toContain(id);
    const everyId = [...allCapabilities().map((c) => c.id), "prod-observability"];
    const repoSets = [["St-John-Software/home-assistant-config"], ["St-John-Software/production-infra", "St-John-Software/claws"]];
    for (const repos of repoSets) {
      const remembered = new Map([[sessionCapabilityDefaultsKey(repos), everyId]]);
      for (const provider of SESSION_PROVIDERS) {
        const ids = preselectedSessionCapabilities(repos, remembered, provider);
        for (const id of ids) expect(allowedInDefaults(id), `${repos.join("+")} ${provider}: ${id}`).toBe(true);
        expect(ids).toContain("fleet-observability");
        expect(ids).toContain("home-assistant-read");
        expect(ids).not.toContain("prod-observability");
      }
    }
  });

  it("seeds a home-assistant repo with read-only Home Assistant access when nothing is remembered", () => {
    for (const provider of SESSION_PROVIDERS) {
      const ids = preselectedSessionCapabilities(["St-John-Software/ha-carlink"], new Map(), provider);
      expect(ids).toContain("home-assistant-read");
      expect(ids).not.toContain("home-assistant");
      for (const id of ids) expect(allowedInDefaults(id), `${provider}: ${id}`).toBe(true);
    }
  });
});
