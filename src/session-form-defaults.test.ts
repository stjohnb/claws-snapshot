import { describe, it, expect, vi, beforeEach } from "vitest";

// A small stand-in registry: which ids are configured, which repos are
// Forgejo-hosted and the static per-repo seed. The real helpers' shapes are
// kept so the test exercises the orchestration the form mirrors.
const state = vi.hoisted(() => ({
  available: new Set<string>(),
  forgejoRepos: new Set<string>(),
  seeds: {} as Record<string, string[]>,
}));

vi.mock("./capabilities.js", () => {
  const validCapabilityIds = (ids: string[]) => [...new Set(ids)].filter((id) => state.available.has(id));
  return {
    GITHUB_AUTH_CAPABILITY_ID: "github-auth",
    isCapabilityAvailable: (id: string) => state.available.has(id),
    isAgentLoginCapability: (id: string) => id === "claude-auth" || id === "codex-auth",
    validCapabilityIds,
    defaultCapabilitiesForRepo: (repo: string) => validCapabilityIds([...(state.seeds[repo] ?? []), "github-auth"]),
    defaultProviderAuthCapabilities: (provider: string, mode: string) =>
      mode === "repo-zsh" ? [] : provider === "claude" ? ["claude-auth"] : provider === "codex" ? ["codex-auth"] : [],
    withImplicitCapabilities: (selected: string[], repos: string[]) =>
      validCapabilityIds([...selected, "cross-repo", ...(repos.some((r) => state.forgejoRepos.has(r)) ? ["forgejo"] : [])]),
  };
});

vi.mock("./db.js", () => ({
  sessionCapabilityDefaultsKey: (repos: string[]) => [...new Set(repos)].sort().join("\n"),
}));

import { preselectedSessionCapabilities } from "./session-form-defaults.js";

beforeEach(() => {
  state.available = new Set(["github-auth", "claude-auth", "codex-auth", "cross-repo", "forgejo", "browser", "grafana"]);
  state.forgejoRepos = new Set();
  state.seeds = {};
});

describe("preselectedSessionCapabilities", () => {
  it("gives a home-directory session only the agent login and implicit grants", () => {
    expect(preselectedSessionCapabilities([], new Map(), "claude")).toEqual(["claude-auth", "cross-repo"]);
  });

  it("seeds a single repo from its static defaults when nothing is remembered", () => {
    state.seeds = { "o/a": ["grafana"] };
    expect(preselectedSessionCapabilities(["o/a"], new Map(), "claude")).toEqual(["grafana", "github-auth", "claude-auth", "cross-repo"]);
  });

  it("prefers a remembered single-repo set, even an empty one, over the seed", () => {
    state.seeds = { "o/a": ["grafana"] };
    expect(preselectedSessionCapabilities(["o/a"], new Map([["o/a", ["browser"]]]), "codex")).toEqual(["browser", "codex-auth", "cross-repo"]);
    expect(preselectedSessionCapabilities(["o/a"], new Map([["o/a", []]]), "claude")).toEqual(["claude-auth", "cross-repo"]);
  });

  it("pre-ticks only github-auth for an unremembered combination", () => {
    expect(preselectedSessionCapabilities(["o/b", "o/a"], new Map(), "claude")).toEqual(["github-auth", "claude-auth", "cross-repo"]);
  });

  it("uses the remembered set for a combination, whatever the repo order", () => {
    const remembered = new Map([["o/a\no/b", ["browser"]]]);
    expect(preselectedSessionCapabilities(["o/b", "o/a"], remembered, "codex")).toEqual(["browser", "codex-auth", "cross-repo"]);
  });

  it("forces forgejo when any repo is Forgejo-hosted", () => {
    state.forgejoRepos = new Set(["o/b"]);
    expect(preselectedSessionCapabilities(["o/a", "o/b"], new Map(), "claude")).toContain("forgejo");
    expect(preselectedSessionCapabilities(["o/a"], new Map(), "claude")).not.toContain("forgejo");
  });

  it("drops remembered ids that are no longer available", () => {
    state.available.delete("browser");
    expect(preselectedSessionCapabilities(["o/a"], new Map([["o/a", ["browser", "grafana"]]]), "claude")).toEqual(["grafana", "claude-auth", "cross-repo"]);
  });

  it("drops github-auth from the multi-repo default when it is unconfigured", () => {
    state.available.delete("github-auth");
    expect(preselectedSessionCapabilities(["o/a", "o/b"], new Map(), "claude")).toEqual(["claude-auth", "cross-repo"]);
  });

  it("takes the agent login from the provider, not a remembered set", () => {
    expect(preselectedSessionCapabilities(["o/a"], new Map([["o/a", ["codex-auth"]]]), "claude")).toEqual(["claude-auth", "cross-repo"]);
  });
});
