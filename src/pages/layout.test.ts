import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  ACTIVATION_STATE: "active",
}));

import { anthropicLabel, openaiLabel, buildPageHeader, buildNav, k8sIntegrationLabel, PAGE_CSS, githubItemUrl } from "./layout.js";
import type { AiProviderStatus } from "./layout.js";

const base: AiProviderStatus = {
  configured: true,
  rateLimited: false,
  lastUsedAt: null,
};

describe("anthropicLabel isPrimary", () => {
  it("appends (primary) to idle label when isPrimary is true", () => {
    const result = anthropicLabel({ ...base, lastUsedAt: null, isPrimary: true });
    expect(result.text).toBe("Idle (primary)");
    expect(result.cls).toBe("idle");
  });

  it("appends (primary) to active label when isPrimary is true", () => {
    const result = anthropicLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: true });
    expect(result.text).toBe("Active (primary)");
    expect(result.cls).toBe("running");
  });

  it("does not append (primary) when isPrimary is false", () => {
    const result = anthropicLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: false });
    expect(result.text).toBe("Active");
  });

  it("appends (primary) to not-configured label when isPrimary is true", () => {
    const result = anthropicLabel({ ...base, configured: false, isPrimary: true });
    expect(result.text).toBe("Not configured (primary)");
  });
});

describe("openaiLabel isPrimary", () => {
  it("appends (primary) to idle label when isPrimary is true", () => {
    const result = openaiLabel({ ...base, lastUsedAt: null, isPrimary: true });
    expect(result.text).toBe("Idle (primary)");
    expect(result.cls).toBe("idle");
  });

  it("appends (primary) to active label when isPrimary is true", () => {
    const result = openaiLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: true });
    expect(result.text).toBe("Active (primary)");
    expect(result.cls).toBe("running");
  });

  it("does not append (primary) when isPrimary is false", () => {
    const result = openaiLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: false });
    expect(result.text).toBe("Active");
  });

  it("appends (primary) to not-configured label when isPrimary is true", () => {
    const result = openaiLabel({ ...base, configured: false, isPrimary: true });
    expect(result.text).toBe("Not configured (primary)");
  });
});

describe("buildPageHeader", () => {
  it("renders site title, nav, and subtitle when pageTitle is set", () => {
    const html = buildPageHeader("Queue", "dark");
    expect(html).toContain("<h1>claws</h1>");
    expect(html).toContain("<nav>");
    expect(html).toContain("<h2>Queue</h2>");
  });

  it("omits the subtitle when pageTitle is null", () => {
    const html = buildPageHeader(null, "dark");
    expect(html).toContain("<h1>claws</h1>");
    expect(html).toContain("<nav>");
    expect(html).not.toContain("<h2>");
  });

  it("escapes HTML in the page title", () => {
    const html = buildPageHeader("<script>alert(1)</script>", "dark");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the nav when showNav is false", () => {
    const html = buildPageHeader("Login", "dark", { showNav: false });
    expect(html).toContain("<h1>claws</h1>");
    expect(html).not.toContain("<nav>");
    expect(html).toContain("<h2>Login</h2>");
  });
});

describe("buildNav", () => {
  it("renders a CSS-only mobile disclosure that keeps existing links intact", () => {
    const html = buildNav("system");
    expect(html).toContain('id="nav-toggle"');
    expect(html).toContain('class="nav-links"');
    expect(html).toContain('for="nav-toggle"');
    expect(html).toContain('href="/prs"');
    expect(html).toContain('id="theme-select"');
  });

  it("renders an always-visible favourites bar with Queue, PRs, Issues and Sessions", () => {
    const html = buildNav("dark");
    const favIdx = html.indexOf('class="nav-favourites"');
    expect(favIdx).toBeGreaterThan(-1);
    const fav = html.slice(favIdx);
    for (const href of ["/queue", "/prs", "/issues", "/sessions"]) {
      expect(fav).toContain(`href="${href}"`);
    }
  });

  it("keeps the favourite links in the full menu as well", () => {
    const html = buildNav("dark");
    const links = html.slice(html.indexOf('class="nav-links"'), html.indexOf('id="theme-select"'));
    for (const href of ["/queue", "/prs", "/issues", "/sessions"]) {
      expect(links).toContain(`href="${href}"`);
    }
  });
});

describe("PAGE_CSS", () => {
  it("ships the shared responsive data-cards block", () => {
    expect(PAGE_CSS).toContain(".data-cards");
    expect(PAGE_CSS).toContain("attr(data-label)");
  });

  it("hides the favourites bar at desktop widths", () => {
    expect(PAGE_CSS).toContain(".nav-favourites");
    expect(PAGE_CSS).toContain("@media (min-width: 768px)");
  });

  it("declares the display/body font tokens", () => {
    expect(PAGE_CSS).toContain("--font-display");
    expect(PAGE_CSS).toContain("IBM Plex Mono");
  });

  it("ships no page-load entrance animation (see docs/DESIGN.md — deliberate)", () => {
    expect(PAGE_CSS).not.toContain("claws-rise");
    expect(PAGE_CSS).not.toContain("prefers-reduced-motion");
  });

  it("ships .cell-summary for responsive summary truncation", () => {
    expect(PAGE_CSS).toContain(".cell-summary");
  });
});

describe("githubItemUrl", () => {
  it("builds an issue URL by default", () => {
    expect(githubItemUrl("org/repo", 1)).toBe("https://github.com/org/repo/issues/1");
  });

  it("builds a pull request URL when kind is pr", () => {
    expect(githubItemUrl("org/repo", 1, "pr")).toBe("https://github.com/org/repo/pull/1");
  });

  it("does not over-escape the slash between owner and repo", () => {
    expect(githubItemUrl("org/repo", 1)).toBe("https://github.com/org/repo/issues/1");
  });
});

describe("k8sIntegrationLabel", () => {
  const base = {
    enabled: true,
    lastRunAt: "2026-01-01T00:00:00Z",
    lastError: null,
    nodesNotReady: 0,
    podAlertCount: 0,
    nodeAlertCount: 0,
    fluxAlertCount: 0,
    mutedNodesNotReady: [],
  };

  it("returns Healthy when all counts are zero", () => {
    expect(k8sIntegrationLabel(base)).toEqual({ text: "Healthy", cls: "running" });
  });

  it("returns Degraded when fluxAlertCount > 0", () => {
    expect(k8sIntegrationLabel({ ...base, fluxAlertCount: 1 })).toEqual({ text: "Degraded", cls: "slack-error" });
  });

  it("returns Degraded when nodeAlertCount > 0", () => {
    expect(k8sIntegrationLabel({ ...base, nodeAlertCount: 2 })).toEqual({ text: "Degraded", cls: "slack-error" });
  });

  it("returns Degraded when nodesNotReady > 0", () => {
    expect(k8sIntegrationLabel({ ...base, nodesNotReady: 1 })).toEqual({ text: "Degraded", cls: "slack-error" });
  });

  it("returns Disabled when null", () => {
    expect(k8sIntegrationLabel(null)).toEqual({ text: "Disabled", cls: "idle" });
  });

  it("returns Configured (untested) when no lastRunAt", () => {
    expect(k8sIntegrationLabel({ ...base, lastRunAt: null })).toEqual({ text: "Configured (untested)", cls: "slack-untested" });
  });

  it("returns Error when lastError is set", () => {
    expect(k8sIntegrationLabel({ ...base, lastError: "connection refused" })).toEqual({ text: "Error", cls: "slack-error" });
  });

  it("returns amber Healthy with muted node name when one muted node is offline", () => {
    expect(k8sIntegrationLabel({ ...base, mutedNodesNotReady: ["k3s-nas"] })).toEqual({
      text: "Healthy · 1 muted node offline (k3s-nas)",
      cls: "slack-untested",
    });
  });

  it("returns amber Healthy pluralized with all muted node names when multiple are offline", () => {
    const result = k8sIntegrationLabel({ ...base, mutedNodesNotReady: ["k3s-nas", "ryzen"] });
    expect(result.cls).toBe("slack-untested");
    expect(result.text).toContain("2 muted nodes offline");
    expect(result.text).toContain("k3s-nas");
    expect(result.text).toContain("ryzen");
  });

  it("returns Degraded when there are alerts even if muted nodes are also offline", () => {
    expect(k8sIntegrationLabel({ ...base, mutedNodesNotReady: ["k3s-nas"], fluxAlertCount: 1 })).toEqual({
      text: "Degraded",
      cls: "slack-error",
    });
  });

  it("returns plain Healthy when mutedNodesNotReady is omitted", () => {
    const { mutedNodesNotReady, ...withoutMuted } = base;
    expect(k8sIntegrationLabel(withoutMuted)).toEqual({ text: "Healthy", cls: "running" });
  });
});
