import { describe, it, expect, vi } from "vitest";

vi.mock("../db.js", () => ({
  insertJobRun: vi.fn(),
  completeJobRun: vi.fn(),
}));

vi.mock("../log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withRunContext: vi.fn((fn: () => unknown) => fn),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

import { buildSparkline, buildStatusPage } from "./dashboard.js";

describe("buildSparkline", () => {
  it("returns 'No data' for empty snapshots", () => {
    expect(buildSparkline([])).toContain("No data");
  });

  it("returns flat line for single data point", () => {
    const result = buildSparkline([{ totalItems: 5, recordedAt: "2026-01-01T00:00:00Z" }]);
    expect(result).toContain("<svg");
    expect(result).toContain("polyline");
  });

  it("returns flat line when all values are equal", () => {
    const result = buildSparkline([
      { totalItems: 3, recordedAt: "2026-01-01T00:00:00Z" },
      { totalItems: 3, recordedAt: "2026-01-01T01:00:00Z" },
      { totalItems: 3, recordedAt: "2026-01-01T02:00:00Z" },
    ]);
    expect(result).toContain("<svg");
    // All-equal case draws a flat line at mid-height, starting after the label margin
    const y = 24 / 2; // h / 2
    expect(result).toContain(`32,${y} 150,${y}`);
    // Shows the constant value as a label
    expect(result).toContain(">3<");
  });

  it("returns SVG polyline for varying data", () => {
    const result = buildSparkline([
      { totalItems: 0, recordedAt: "2026-01-01T00:00:00Z" },
      { totalItems: 10, recordedAt: "2026-01-01T01:00:00Z" },
      { totalItems: 5, recordedAt: "2026-01-01T02:00:00Z" },
    ]);
    expect(result).toContain("<svg");
    expect(result).toContain("polyline");
    expect(result).toContain("points=");
    // Shows min and max labels
    expect(result).toContain(">10<");
    expect(result).toContain(">0<");
  });

  it("uses compact format for large values", () => {
    const result = buildSparkline([
      { totalItems: 0, recordedAt: "2026-01-01T00:00:00Z" },
      { totalItems: 12500, recordedAt: "2026-01-01T01:00:00Z" },
    ]);
    expect(result).toContain(">13k<");
    expect(result).toContain(">0<");
  });

  it("uses decimal format for thousands", () => {
    const result = buildSparkline([
      { totalItems: 0, recordedAt: "2026-01-01T00:00:00Z" },
      { totalItems: 1500, recordedAt: "2026-01-01T01:00:00Z" },
    ]);
    expect(result).toContain(">1.5k<");
  });

  it("single data point shows value label", () => {
    const result = buildSparkline([{ totalItems: 7, recordedAt: "2026-01-01T00:00:00Z" }]);
    expect(result).toContain("<svg");
    expect(result).toContain(">7<");
  });
});

function minimalStatusPageArgs(ha: { configured: boolean; lastCheck: string | null; lastError: string | null }) {
  return buildStatusPage(
    "1.0.0",
    0,
    {},
    { pending: 0, active: 0 },
    { configured: false, lastResult: null },
    { configured: false },
    { configured: false, connected: false, pairingRequired: false },
    { configured: false, lastCheck: null, lastError: null },
    ha,
    [],
    new Map(),
    "light",
    new Date().toISOString(),
  );
}

describe("buildStatusPage HA integration", () => {
  it("shows Home Assistant row in integrations section", () => {
    const html = minimalStatusPageArgs({ configured: false, lastCheck: null, lastError: null });
    expect(html).toContain("Home Assistant");
    expect(html).toContain("ha-status");
  });

  it("shows Not configured when HA is not set up", () => {
    const html = minimalStatusPageArgs({ configured: false, lastCheck: null, lastError: null });
    expect(html).toContain("Not configured");
    expect(html).toContain('class="idle"');
  });

  it("shows Connected when HA is reachable", () => {
    const html = minimalStatusPageArgs({ configured: true, lastCheck: "2026-01-01T00:00:00Z", lastError: null });
    expect(html).toContain("Connected");
    expect(html).toContain('class="running"');
  });

  it("shows Error when HA ping failed", () => {
    const html = minimalStatusPageArgs({ configured: true, lastCheck: "2026-01-01T00:00:00Z", lastError: "HTTP 401" });
    expect(html).toContain("Error");
    expect(html).toContain('class="slack-error"');
  });

  it("shows Configured (untested) when configured but not yet checked", () => {
    const html = minimalStatusPageArgs({ configured: true, lastCheck: null, lastError: null });
    expect(html).toContain("Configured (untested)");
    expect(html).toContain('class="slack-untested"');
  });
});
