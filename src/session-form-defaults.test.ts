import { describe, it, expect, vi, beforeEach } from "vitest";

// A small stand-in registry: which ids are configured and the static per-repo
// seed. The real helpers' shapes are
// kept so the test exercises the orchestration the form mirrors.
const state = vi.hoisted(() => ({
  available: new Set<string>(),
  seeds: {} as Record<string, string[]>,
}));

vi.mock("./capabilities.js", () => {
  const validCapabilityIds = (ids: string[]) => [...new Set(ids)].filter((id) => state.available.has(id));
  return {
    isAgentLoginCapability: (id: string) => id === "claude-auth" || id === "codex-auth",
    validCapabilityIds,
    defaultCapabilitiesForRepo: (repo: string) => validCapabilityIds(state.seeds[repo] ?? []),
    defaultProviderAuthCapabilities: (provider: string, mode: string) =>
      mode === "repo-zsh" ? [] : provider === "claude" ? ["claude-auth"] : provider === "codex" ? ["codex-auth"] : [],
    withImplicitCapabilities: (selected: string[], repos: string[]) =>
      validCapabilityIds([...selected, "cross-repo", ...(repos.some((r) => !!r) ? ["forgejo"] : [])]),
  };
});

vi.mock("./db.js", () => ({
  sessionCapabilityDefaultsKey: (repos: string[]) => [...new Set(repos)].sort().join("\n"),
}));

import { preselectedSessionCapabilities } from "./session-form-defaults.js";

beforeEach(() => {
  state.available = new Set(["claude-auth", "codex-auth", "cross-repo", "forgejo", "browser", "grafana"]);
  state.seeds = {};
});

describe("preselectedSessionCapabilities", () => {
  it("gives a home-directory session only the agent login and implicit grants", () => {
    expect(preselectedSessionCapabilities([], new Map(), "claude")).toEqual(["claude-auth", "cross-repo"]);
  });

  it("seeds a single repo from its static defaults when nothing is remembered", () => {
    state.seeds = { "o/a": ["grafana"] };
    expect(preselectedSessionCapabilities(["o/a"], new Map(), "claude")).toEqual(["grafana", "claude-auth", "cross-repo", "forgejo"]);
  });

  it("prefers a remembered single-repo set, even an empty one, over the seed", () => {
    state.seeds = { "o/a": ["grafana"] };
    expect(preselectedSessionCapabilities(["o/a"], new Map([["o/a", ["browser"]]]), "codex")).toEqual(["browser", "codex-auth", "cross-repo", "forgejo"]);
    expect(preselectedSessionCapabilities(["o/a"], new Map([["o/a", []]]), "claude")).toEqual(["claude-auth", "cross-repo", "forgejo"]);
  });

  it("pre-ticks nothing repo-specific for an unremembered combination, and never github-auth", () => {
    expect(preselectedSessionCapabilities(["o/b", "o/a"], new Map(), "claude")).toEqual(["claude-auth", "cross-repo", "forgejo"]);
  });

  it("uses the remembered set for a combination, whatever the repo order", () => {
    const remembered = new Map([["o/a\no/b", ["browser"]]]);
    expect(preselectedSessionCapabilities(["o/b", "o/a"], remembered, "codex")).toEqual(["browser", "codex-auth", "cross-repo", "forgejo"]);
  });

  it("forces forgejo for any session with a repo, and not for a home session", () => {
    expect(preselectedSessionCapabilities(["o/a", "o/b"], new Map(), "claude")).toContain("forgejo");
    expect(preselectedSessionCapabilities(["o/a"], new Map(), "claude")).toContain("forgejo");
    expect(preselectedSessionCapabilities([], new Map(), "claude")).not.toContain("forgejo");
  });

  it("drops remembered ids that are no longer available", () => {
    state.available.delete("browser");
    expect(preselectedSessionCapabilities(["o/a"], new Map([["o/a", ["browser", "grafana"]]]), "claude")).toEqual(["grafana", "claude-auth", "cross-repo", "forgejo"]);
  });

  it("drops a remembered github-auth, which no longer exists", () => {
    expect(preselectedSessionCapabilities(["o/a", "o/b"], new Map([["o/a\no/b", ["github-auth"]]]), "claude")).toEqual(["claude-auth", "cross-repo", "forgejo"]);
  });

  it("takes the agent login from the provider, not a remembered set", () => {
    expect(preselectedSessionCapabilities(["o/a"], new Map([["o/a", ["codex-auth"]]]), "claude")).toEqual(["claude-auth", "cross-repo", "forgejo"]);
  });
});
