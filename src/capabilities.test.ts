import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  NAMEY_DB_URL: "",
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  PROD_K8S_KUBECONFIG_PATH: "",
  FLEET_KUBECONFIG_PATH: "",
}));

vi.mock("./config.js", () => mockConfig);

import {
  buildCapabilityEnvArgs,
  buildCapabilityPrompt,
  validCapabilityIds,
  availableCapabilities,
} from "./capabilities.js";

// The gated env keys across the whole registry.
const ALL_KEYS = [
  "HOME_ASSISTANT_BASE_URL",
  "HOME_ASSISTANT_TOKEN",
  "CLAWS_HOME_ASSISTANT_TOKEN",
  "NAMEY_DB_URL",
  "CLAWS_NAMEY_DB_URL",
  "KUBECONFIG",
];

describe("capabilities", () => {
  beforeEach(() => {
    mockConfig.NAMEY_DB_URL = "postgres://namey";
    mockConfig.HOME_ASSISTANT_BASE_URL = "https://ha.example";
    mockConfig.HOME_ASSISTANT_TOKEN = "ha-token";
    mockConfig.PROD_K8S_KUBECONFIG_PATH = "/etc/prod.kubeconfig";
    mockConfig.FLEET_KUBECONFIG_PATH = "/etc/fleet.kubeconfig";
  });

  it("empty selection strips every gated key with -u and injects nothing", () => {
    const args = buildCapabilityEnvArgs([]);
    expect(args[0]).toBe("env");
    expect(args.some((a) => a.includes("="))).toBe(false);
    for (const key of ALL_KEYS) {
      const idx = args.indexOf(key);
      expect(idx).toBeGreaterThan(0);
      expect(args[idx - 1]).toBe("-u");
    }
  });

  it("granting home-assistant injects the three HA vars and strips others", () => {
    const args = buildCapabilityEnvArgs(["home-assistant"]);
    expect(args).toContain("HOME_ASSISTANT_BASE_URL=https://ha.example");
    expect(args).toContain("HOME_ASSISTANT_TOKEN=ha-token");
    expect(args).toContain("CLAWS_HOME_ASSISTANT_TOKEN=ha-token");
    // HA keys are not stripped.
    expect(args).not.toContain("HOME_ASSISTANT_TOKEN");
    // Other keys are still stripped.
    const namey = args.indexOf("NAMEY_DB_URL");
    expect(args[namey - 1]).toBe("-u");
    const kube = args.indexOf("KUBECONFIG");
    expect(args[kube - 1]).toBe("-u");
  });

  it("drops a requested capability whose credentials are unavailable", () => {
    mockConfig.HOME_ASSISTANT_TOKEN = "";
    const args = buildCapabilityEnvArgs(["home-assistant"]);
    expect(args.some((a) => a.startsWith("HOME_ASSISTANT_TOKEN="))).toBe(false);
    const idx = args.indexOf("HOME_ASSISTANT_TOKEN");
    expect(args[idx - 1]).toBe("-u");
  });

  it("colon-merges KUBECONFIG when both prod and fleet are granted", () => {
    const args = buildCapabilityEnvArgs(["prod-infra", "fleet-infra"]);
    expect(args).toContain("KUBECONFIG=/etc/prod.kubeconfig:/etc/fleet.kubeconfig");
    // KUBECONFIG must not be stripped when granted.
    expect(args.includes("KUBECONFIG")).toBe(false);
  });

  it("validCapabilityIds rejects unknown ids and dedupes", () => {
    expect(validCapabilityIds(["bogus", "home-assistant", "home-assistant"])).toEqual([
      "home-assistant",
    ]);
  });

  it("availableCapabilities reflects configured credentials", () => {
    mockConfig.FLEET_KUBECONFIG_PATH = "";
    const ids = availableCapabilities().map((c) => c.id);
    expect(ids).toContain("home-assistant");
    expect(ids).toContain("prod-infra");
    expect(ids).not.toContain("fleet-infra");
  });

  it("expands ~ in FLEET_KUBECONFIG_PATH for the granted KUBECONFIG", () => {
    mockConfig.FLEET_KUBECONFIG_PATH = "~/.kube/config";
    const args = buildCapabilityEnvArgs(["fleet-infra"]);
    const kube = args.find((a) => a.startsWith("KUBECONFIG="));
    expect(kube).toBeDefined();
    expect(kube).not.toContain("~");
    expect(kube).toMatch(/\/\.kube\/config$/);
  });

  it("buildCapabilityPrompt([]) returns empty string", () => {
    expect(buildCapabilityPrompt([])).toBe("");
  });

  it("buildCapabilityPrompt names only granted capabilities", () => {
    const prompt = buildCapabilityPrompt(["home-assistant"]);
    expect(prompt).toContain("Home Assistant");
    expect(prompt).not.toContain("Namey");
    expect(prompt).not.toContain("Prod infra");
    expect(prompt).not.toContain("NOT granted");
  });
});
