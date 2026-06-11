import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  ACTIVATION_STATE: "active",
}));

import { anthropicLabel, openaiLabel, openrouterLabel, buildPageHeader, k8sIntegrationLabel } from "./layout.js";
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

describe("openrouterLabel isPrimary", () => {
  it("appends (primary) to idle label when isPrimary is true", () => {
    const result = openrouterLabel({ ...base, lastUsedAt: null, isPrimary: true });
    expect(result.text).toBe("Idle (primary)");
    expect(result.cls).toBe("idle");
  });

  it("appends (primary) to active label when isPrimary is true", () => {
    const result = openrouterLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: true });
    expect(result.text).toBe("Active (primary)");
    expect(result.cls).toBe("running");
  });

  it("does not append (primary) when isPrimary is false", () => {
    const result = openrouterLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: false });
    expect(result.text).toBe("Active");
  });

  it("appends (primary) to not-configured label when isPrimary is true", () => {
    const result = openrouterLabel({ ...base, configured: false, isPrimary: true });
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

describe("k8sIntegrationLabel", () => {
  const base = {
    enabled: true,
    lastRunAt: "2026-01-01T00:00:00Z",
    lastError: null,
    nodesNotReady: 0,
    podAlertCount: 0,
    nodeAlertCount: 0,
    fluxAlertCount: 0,
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
});
