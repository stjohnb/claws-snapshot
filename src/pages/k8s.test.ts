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
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("../config.js", () => ({
  ACTIVATION_STATE: "active",
}));

import { buildK8sPage, type K8sClusterView } from "./k8s.js";
import type { K8sMonitorStatus } from "../jobs/k3s-monitor.js";

function makeStatus(overrides: Partial<K8sMonitorStatus> = {}): K8sMonitorStatus {
  return {
    logPrefix: "k3s-monitor",
    repo: "St-John-Software/fleet-infra",
    enabled: true,
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastError: null,
    podCount: 5,
    nodeCount: 3,
    nodesNotReady: 0,
    podAlertCount: 0,
    nodeAlertCount: 0,
    fluxAlertCount: 0,
    newIssuesRaised: 0,
    ...overrides,
  };
}

function makeCluster(overrides: Partial<K8sClusterView> = {}): K8sClusterView {
  return {
    label: "k3s",
    status: makeStatus(),
    recentRuns: [],
    alertsUrl: "https://github.com/St-John-Software/fleet-infra/issues?q=is%3Aissue+is%3Aopen+label%3A%22Priority%22",
    ...overrides,
  };
}

describe("buildK8sPage", () => {
  it("renders cluster labels", () => {
    const html = buildK8sPage([
      makeCluster({ label: "k3s" }),
      makeCluster({ label: "Prod k8s", status: makeStatus({ logPrefix: "prod-k8s-monitor", repo: "St-John-Software/production-infra" }) }),
    ], "light");
    expect(html).toContain("k3s");
    expect(html).toContain("Prod k8s");
  });

  it("renders link to open alerts on GitHub", () => {
    const html = buildK8sPage([makeCluster()], "light");
    expect(html).toContain("View on GitHub");
    expect(html).toContain("label%3A%22Priority%22");
  });

  it("renders recent-runs table headers when there are runs", () => {
    const html = buildK8sPage([makeCluster({
      recentRuns: [{
        runId: "abc12345678",
        status: "success",
        startedAt: "2026-01-01T00:00:00",
        completedAt: "2026-01-01T00:01:00",
      }],
    })], "light");
    expect(html).toContain("Run ID");
    expect(html).toContain("Status");
    expect(html).toContain("Started");
    expect(html).toContain("Completed");
  });

  it("renders empty message when no clusters configured", () => {
    const html = buildK8sPage([], "light");
    expect(html).toContain("No k8s integrations configured");
  });
});
