import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

const mockReadFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ readFileSync: mockReadFileSync }));

const mockK3sEnabled = vi.hoisted(() => ({ value: true }));
const mockK3sIgnoredNodes = vi.hoisted(() => ({ value: [] as string[] }));
const mockFleetInfraRepo = vi.hoisted(() => ({ value: "St-John-Software/fleet-infra" }));
vi.mock("../config.js", () => ({
  get K3S_MONITOR_ENABLED() { return mockK3sEnabled.value; },
  get K3S_IGNORED_NODES() { return mockK3sIgnoredNodes.value; },
  get FLEET_INFRA_REPO() { return mockFleetInfraRepo.value; },
  LABELS: { priority: "Priority" },
}));

const mockFindIssueByExactTitle = vi.hoisted(() => vi.fn());
const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockCommentOnIssue = vi.hoisted(() => vi.fn());
const mockGetIssueBody = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
const mockListOpenIssues = vi.hoisted(() => vi.fn());
const mockEditIssueTitle = vi.hoisted(() => vi.fn());
const mockCloseIssue = vi.hoisted(() => vi.fn());
vi.mock("../github.js", () => ({
  findIssueByExactTitle: mockFindIssueByExactTitle,
  createIssue: mockCreateIssue,
  commentOnIssue: mockCommentOnIssue,
  getIssueBody: mockGetIssueBody,
  editIssue: mockEditIssue,
  listOpenIssues: mockListOpenIssues,
  editIssueTitle: mockEditIssueTitle,
  closeIssue: mockCloseIssue,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({
  notify: mockNotify,
}));

const mockReportError = vi.hoisted(() => vi.fn());
vi.mock("../error-reporter.js", () => ({
  reportError: mockReportError,
}));

const mockRefreshKubeconfig = vi.hoisted(() => vi.fn());
vi.mock("./kubeconfig-refresh.js", () => ({
  refreshKubeconfig: mockRefreshKubeconfig,
  isStaleKubeconfigError: (e: Error) => /timed out after 30s|connection refused|unreachable/i.test(e.message),
}));

import { run, runK8sMonitor, podWorkloadName, workloadNameForPod, detectPodAlerts, detectNodeAlerts, detectFluxAlerts, dedupeAlertsByTitle, podAlertTitle, legacyPodAlertTitles, getK8sMonitorStatus, kubectlExec } from "./k3s-monitor.js";
import * as log from "../log.js";

// ── Helpers ──

function makeKubectlResponse(json: unknown): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, JSON.stringify(json), "");
    },
  );
}

function makeKubectlResponseSequential(responses: Array<string | Error>): void {
  let callIndex = 0;
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const response = responses[callIndex++];
      if (response instanceof Error) {
        cb(response, "", response.message);
      } else {
        cb(null, response ?? "", "");
      }
    },
  );
}

function podList(pods: object[]): { items: object[] } {
  return { items: pods };
}

function nodeList(nodes: object[]): { items: object[] } {
  return { items: nodes };
}

function healthyPod(overrides: Record<string, unknown> = {}): object {
  return {
    metadata: { name: "my-deploy-abc123456-xk9pz", namespace: "default", ...(overrides.metadata as Record<string, unknown> ?? {}) },
    spec: { nodeName: "node-1", ...(overrides.spec as Record<string, unknown> ?? {}) },
    status: { phase: "Running", containerStatuses: [{ name: "app", state: { running: { startedAt: "2024-01-01T00:00:00Z" } }, ready: true, restartCount: 0 }], ...(overrides.status ?? {}) },
  };
}

function crashLoopPod(overrides: Record<string, unknown> = {}): object {
  return {
    metadata: { name: "my-service-abc123456-xk9pz", namespace: "fleet-services" },
    spec: { nodeName: "node-1", ...(overrides.spec as Record<string, unknown> ?? {}) },
    status: {
      phase: "Running",
      containerStatuses: [{
        name: "app",
        state: { waiting: { reason: "CrashLoopBackOff", message: "back-off" } },
        ready: false,
        restartCount: 10,
      }],
    },
    ...overrides,
  };
}

function oomKilledPod(overrides: Record<string, unknown> = {}): object {
  return {
    metadata: { name: "my-worker-abc1234-xk9pz", namespace: "fleet-services" },
    spec: { nodeName: "node-1" },
    status: {
      phase: "Running",
      containerStatuses: [{
        name: "worker",
        state: { terminated: { reason: "OOMKilled", exitCode: 137 } },
        ready: false,
        restartCount: 3,
      }],
    },
    ...overrides,
  };
}

function imagePullPod(overrides: Record<string, unknown> = {}): object {
  return {
    metadata: { name: "my-app-abc1234567-xk9pz", namespace: "production" },
    spec: { nodeName: "node-1" },
    status: {
      phase: "Pending",
      containerStatuses: [{
        name: "app",
        state: { waiting: { reason: "ImagePullBackOff" } },
        ready: false,
        restartCount: 0,
      }],
    },
    ...overrides,
  };
}

function notReadyNode(name: string, minutesAgo: number): object {
  const t = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  return {
    metadata: { name },
    status: {
      conditions: [{ type: "Ready", status: "False", lastTransitionTime: t }],
    },
  };
}

function readyNode(name: string): object {
  return {
    metadata: { name },
    status: {
      conditions: [{ type: "Ready", status: "True", lastTransitionTime: new Date(Date.now() - 10 * 60 * 1000).toISOString() }],
    },
  };
}

const emptyNodeList = nodeList([]);
const emptyNodeJson = JSON.stringify(emptyNodeList);
const emptyKsJson = JSON.stringify({ items: [] });
const emptyPodJson = JSON.stringify({ items: [] });
const emptyHrJson = JSON.stringify({ items: [] });

describe("kubectlExec error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockReturnValue("");
  });

  it("timeout includes server URL when kubeconfig readable", async () => {
    mockReadFileSync.mockReturnValue(
      "apiVersion: v1\nclusters:\n- cluster:\n    server: https://100.86.229.9:6443\n  name: prod\n",
    );
    mockExecFile.mockImplementation((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error, stdout: string, stderr: string) => void) =>
      cb(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null }), "", ""),
    );
    await expect(
      kubectlExec(["get", "pods", "--all-namespaces", "-o", "json"], "/fake/path"),
    ).rejects.toThrow(/timed out after 30s.*https:\/\/100\.86\.229\.9:6443.*cluster unreachable/);
  });

  it("timeout with no kubeconfig path falls back to 'unknown'", async () => {
    mockExecFile.mockImplementation((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error, stdout: string, stderr: string) => void) =>
      cb(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }), "", ""),
    );
    await expect(kubectlExec(["get", "nodes"])).rejects.toThrow(/timed out after 30s.*server unknown/);
  });

  it("non-timeout error preserves stderr exactly", async () => {
    mockExecFile.mockImplementation((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error, stdout: string, stderr: string) => void) =>
      cb(new Error("exit 1"), "", "Forbidden: user cannot list pods"),
    );
    await expect(kubectlExec(["get", "pods"], "/fake/path")).rejects.toMatchObject({ message: "Forbidden: user cannot list pods" });
  });

  it("timeout with kubeconfig missing 'server:' line returns 'unknown'", async () => {
    mockReadFileSync.mockReturnValue("apiVersion: v1\nclusters: []\n");
    mockExecFile.mockImplementation((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error, stdout: string, stderr: string) => void) =>
      cb(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }), "", ""),
    );
    await expect(kubectlExec(["get", "pods"], "/fake/path")).rejects.toThrow(/server unknown/);
  });

  it("maxBuffer is passed through to execFile", async () => {
    mockExecFile.mockImplementation((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(null, "{}", ""),
    );
    await kubectlExec(["get", "pods", "--all-namespaces", "-o", "json"], "/fake/path");
    expect(mockExecFile).toHaveBeenCalledWith(
      "kubectl",
      ["--kubeconfig", "/fake/path", "get", "pods", "--all-namespaces", "-o", "json"],
      expect.objectContaining({ timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }),
      expect.any(Function),
    );
  });

  it("maxBuffer error produces a descriptive, non-stale-looking message", async () => {
    mockReadFileSync.mockReturnValue("");
    mockExecFile.mockImplementation((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error, stdout: string, stderr: string) => void) =>
      cb(Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), "", "W0801 deprecated flag"),
    );
    try {
      await kubectlExec(["get", "pods", "--all-namespaces", "-o", "json"], "/fake/path");
      expect.fail("Should have thrown");
    } catch (err) {
      const message = String(err);
      expect(message).toMatch(/get pods.*exceeded the 20 MB buffer/);
      expect(message).not.toMatch(/timed out after 30s/);
    }
  });
});

describe("k3s-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockK3sEnabled.value = true;
    mockK3sIgnoredNodes.value = [];
    mockFleetInfraRepo.value = "St-John-Software/fleet-infra";
    mockFindIssueByExactTitle.mockResolvedValue(null);
    mockCreateIssue.mockResolvedValue(1);
    mockCommentOnIssue.mockResolvedValue(undefined);
    mockGetIssueBody.mockResolvedValue(
      "**Pod:** `my-service-abc123456-xk9pz`\n\n---\n**First seen:** 2025-01-15T10:00:00.000Z\n**Last seen:** 2025-01-15T10:00:00.000Z\n**Occurrences:** 1",
    );
    mockEditIssue.mockResolvedValue(undefined);
    mockListOpenIssues.mockResolvedValue([]);
    mockEditIssueTitle.mockResolvedValue(undefined);
    mockCloseIssue.mockResolvedValue(undefined);
    mockReportError.mockResolvedValue(undefined);
    mockRefreshKubeconfig.mockResolvedValue(undefined);
  });

  // ── Enabled/disabled ──

  it("skips when disabled", async () => {
    mockK3sEnabled.value = false;
    await run();
    expect(log.info).toHaveBeenCalledWith("[k3s-monitor] Disabled — skipping");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("reports error and skips when kubectl get pods fails", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(new Error("command not found"), "", "command not found");
      },
    );
    await run();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("kubectl get pods failed"));
    expect(mockReportError).toHaveBeenCalledWith("k3s-monitor:kubectl-get-pods", expect.any(String), expect.any(Error));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  // ── CrashLoopBackOff ──

  it("detects CrashLoopBackOff pod and creates issue on fleet-infra", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: fleet-services/my-service",
      expect.stringContaining("**First seen:**"),
      ["Priority"],
    );
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("[k3s] Workload failing: fleet-services/my-service"));
  });

  it("appends recent logs to CrashLoopBackOff issue body", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "ERROR: connection refused\nSTACK: ...", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    const body = mockCreateIssue.mock.calls[0][2] as string;
    expect(body).toContain("Recent logs");
    expect(body).toContain("ERROR: connection refused");
  });

  it("raises CrashLoopBackOff alert even when kubectl logs errors", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      new Error("error: container app does not exist in pod my-service-abc123456-xk9pz"),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: fleet-services/my-service",
      expect.not.stringContaining("Recent logs"),
      ["Priority"],
    );
  });

  // ── Deduplication / occurrence tracking ──

  it("updates occurrence count in issue body on recurrence", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "[k3s] Workload failing: fleet-services/my-service" }]);

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      42,
      expect.stringContaining("**Occurrences:** 2"),
    );
  });

  it("increments occurrence count on each recurrence", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "[k3s] Workload failing: fleet-services/my-service" }]);
    const pods = JSON.stringify(podList([crashLoopPod()]));

    // First recurrence — existing body has count=1, should become 2
    makeKubectlResponseSequential([emptyNodeJson, pods, "", emptyKsJson, emptyHrJson]);
    await run();
    expect(mockEditIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      42,
      expect.stringContaining("**Occurrences:** 2"),
    );

    vi.clearAllMocks();
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "[k3s] Workload failing: fleet-services/my-service" }]);
    mockGetIssueBody.mockResolvedValue(
      "**Pod:** `my-service-abc123456-xk9pz`\n\n---\n**First seen:** 2025-01-15T10:00:00.000Z\n**Last seen:** 2025-01-15T11:00:00.000Z\n**Occurrences:** 2",
    );
    mockEditIssue.mockResolvedValue(undefined);
    mockReportError.mockResolvedValue(undefined);

    // Second recurrence — count should become 3
    makeKubectlResponseSequential([emptyNodeJson, pods, "", emptyKsJson, emptyHrJson]);
    await run();
    expect(mockEditIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      42,
      expect.stringContaining("**Occurrences:** 3"),
    );
  });

  it("rewrites a pod alert body on recurrence, dropping trailing prose", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "[k3s] Workload failing: fleet-services/my-service" }]);
    // A pod alert body is machine-generated and describes the *current* failure
    // reason, so it is rebuilt wholesale rather than patched in place.
    mockGetIssueBody.mockResolvedValue(
      "**Pod:** `my-service-abc123456-xk9pz`\n**Reason:** OOMKilled\n\n---\n**First seen:** 2025-01-15T10:00:00.000Z\n**Last seen:** 2025-01-15T10:00:00.000Z\n**Occurrences:** 1\n\n> Note added by user",
    );

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    const body = mockEditIssue.mock.calls[0][2] as string;
    expect(body).toContain("**Reason:** CrashLoopBackOff");
    expect(body).not.toContain("OOMKilled");
    expect(body).not.toContain("Note added by user");
    expect(body).toContain("**First seen:** 2025-01-15T10:00:00.000Z");
    expect(body).toContain("**Occurrences:** 2");
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Could not update occurrence tracking"),
    );
  });

  it("warns and skips editIssue for a node alert when body has content after the tracking block", async () => {
    // Node alerts keep the patch-in-place path — only pod alerts refresh the body.
    mockFindIssueByExactTitle.mockResolvedValue({ number: 42, title: "[k3s] Node NotReady: node-1" });
    mockGetIssueBody.mockResolvedValue(
      "**Node:** `node-1`\n\n---\n**First seen:** 2025-01-15T10:00:00.000Z\n**Last seen:** 2025-01-15T10:00:00.000Z\n**Occurrences:** 1\n\n> Note added by user",
    );

    makeKubectlResponseSequential([
      JSON.stringify(nodeList([notReadyNode("node-1", 10)])),
      emptyPodJson,
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not update occurrence tracking"),
    );
  });

  it("renames a pre-existing reason-titled issue instead of filing a duplicate", async () => {
    mockListOpenIssues.mockResolvedValue([
      { number: 714, title: "[k3s] CrashLoopBackOff: fleet-services/my-service" },
    ]);

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockEditIssueTitle).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      714,
      "[k3s] Workload failing: fleet-services/my-service",
    );
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).toHaveBeenCalledWith("St-John-Software/fleet-infra", 714, expect.any(String));
  });

  it("does not absorb a Flux alert into a pod alert for the same namespace/name", async () => {
    mockListOpenIssues.mockResolvedValue([
      { number: 800, title: "[k3s] Flux Kustomization NotReady: fleet-services/my-service" },
    ]);

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockEditIssueTitle).not.toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: fleet-services/my-service",
      expect.any(String),
      ["Priority"],
    );
  });

  it("keeps the lowest-numbered legacy issue and closes the rest as superseded", async () => {
    mockListOpenIssues.mockResolvedValue([
      { number: 731, title: "[k3s] CrashLoopBackOff: fleet-services/my-service" },
      { number: 714, title: "[k3s] Pod Failed: fleet-services/my-service" },
    ]);

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockEditIssueTitle).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      714,
      "[k3s] Workload failing: fleet-services/my-service",
    );
    expect(mockCommentOnIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      731,
      expect.stringContaining("Superseded by #714"),
    );
    expect(mockCloseIssue).toHaveBeenCalledWith("St-John-Software/fleet-infra", 731, "not_planned");
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("handles null body (issue with no description) without crashing", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "[k3s] Workload failing: fleet-services/my-service" }]);
    mockGetIssueBody.mockResolvedValue(null);

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockEditIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      42,
      expect.stringMatching(/\n\n---\n\*\*First seen:\*\* .+\n\*\*Last seen:\*\* .+\n\*\*Occurrences:\*\* 2$/),
    );
  });

  it("adds tracking retroactively to issues created before this feature", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "[k3s] Workload failing: fleet-services/my-service" }]);
    // Body without tracking block
    mockGetIssueBody.mockResolvedValue("**Pod:** `my-service-abc123456-xk9pz`\n**Namespace:** `fleet-services`");

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockEditIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      42,
      expect.stringContaining("**Occurrences:** 2"),
    );
    expect(mockEditIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      42,
      expect.stringContaining("**First seen:**"),
    );
  });

  // ── OOMKilled ──

  it("detects OOMKilled pod and creates issue with logs", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([oomKilledPod()])),
      "OOM: killed by kernel\n", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: fleet-services/my-worker",
      expect.stringContaining("OOMKilled"),
      ["Priority"],
    );
    const body = mockCreateIssue.mock.calls[0][2] as string;
    expect(body).toContain("OOM: killed by kernel");
  });

  // ── ImagePullBackOff ──

  it("detects ImagePullBackOff pod", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([imagePullPod()])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: production/my-app",
      expect.stringContaining("ImagePullBackOff"),
      ["Priority"],
    );
  });

  // ── Node NotReady ──

  it("detects node NotReady condition", async () => {
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([notReadyNode("node-1", 10)])),
      JSON.stringify(podList([])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Node NotReady: node-1",
      expect.stringContaining("node-1"),
      ["Priority"],
    );
  });

  it("ignores node NotReady that just transitioned (within 2 minutes)", async () => {
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([notReadyNode("node-1", 1)])),
      JSON.stringify(podList([])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("does not create an issue when a node in the ignored list is NotReady", async () => {
    mockK3sIgnoredNodes.value = ["nas"];
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([notReadyNode("nas", 10)])),
      JSON.stringify(podList([])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("does not create an issue when a pod on an ignored node crashes", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod({ spec: { nodeName: "k3s-nas" } })])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("creates an issue when a pod on a non-ignored node crashes even if some nodes are ignored", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod({ spec: { nodeName: "node-1" } })])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: fleet-services/my-service",
      expect.stringContaining("**Pod:** `my-service-abc123456-xk9pz`"),
      ["Priority"],
    );
  });

  it("ignores OOMKilled pods on ignored nodes", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([oomKilledPod({ spec: { nodeName: "k3s-nas" } })])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("ignores ImagePullBackOff pods on ignored nodes", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([imagePullPod({ spec: { nodeName: "k3s-nas" } })])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("handles mixed scenario: ignores pods on ignored nodes but alerts for others", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([
        crashLoopPod({ spec: { nodeName: "k3s-nas" } }),
        oomKilledPod({ spec: { nodeName: "node-1" } }),
      ])),
      "", // logs for oomKilledPod on node-1
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    // Only the pod on node-1 should trigger an issue
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: fleet-services/my-worker",
      expect.stringContaining("**Pod:** `my-worker-abc1234-xk9pz`"),
      ["Priority"],
    );
  });

  // ── Ignored-node pods monitored when node is online ──

  it("alerts for pods on an ignored node when that node is online (Ready)", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([readyNode("k3s-nas")])),
      JSON.stringify(podList([crashLoopPod({ spec: { nodeName: "k3s-nas" } })])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: fleet-services/my-service",
      expect.stringContaining("**Pod:** `my-service-abc123456-xk9pz`"),
      ["Priority"],
    );
  });

  it("silences pods on an ignored node when that node is offline (NotReady)", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([notReadyNode("k3s-nas", 10)])),
      JSON.stringify(podList([crashLoopPod({ spec: { nodeName: "k3s-nas" } })])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("falls back to silencing all ignored-node pods when node list fetch fails", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      new Error("connection refused"), // node fetch fails
      JSON.stringify(podList([crashLoopPod({ spec: { nodeName: "k3s-nas" } })])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("kubectl get nodes failed"));
  });

  it("monitors pods on an online ignored node even if another ignored node is offline", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas", "k3s-nas-2"];
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([readyNode("k3s-nas"), notReadyNode("k3s-nas-2", 10)])),
      JSON.stringify(podList([
        crashLoopPod({ spec: { nodeName: "k3s-nas" } }),   // should alert: node is Ready
        oomKilledPod({ spec: { nodeName: "k3s-nas-2" } }), // should be silent: node is down
      ])),
      "", // logs for crashloop
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: fleet-services/my-service",
      expect.anything(),
      ["Priority"],
    );
  });

  // ── Healthy pods ignored ──

  it("ignores healthy running pods", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([healthyPod()])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("ignores pods in Succeeded phase", async () => {
    const succeededPod = {
      metadata: { name: "job-abc123456-xk9pz", namespace: "default" },
      status: { phase: "Succeeded", containerStatuses: [] },
    };

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([succeededPod])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("ignores Terminating pods", async () => {
    const terminatingPod = crashLoopPod({ metadata: { name: "my-service-abc123456-xk9pz", namespace: "fleet-services", deletionTimestamp: "2024-01-01T00:00:00Z" } });

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([terminatingPod])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("does not skip pods without nodeName even when ignored nodes are configured", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    const podWithoutNode = crashLoopPod({ spec: {} }); // No nodeName field

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([podWithoutNode])),
      "", // logs for crashloop
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
  });

  // ── Cap at 10 new issues per run ──

  it("caps new pod issues at 10 per run", async () => {
    const pods = Array.from({ length: 15 }, (_, i) => ({
      metadata: { name: `my-service-${i}-abc123456-xk9pz`, namespace: "fleet-services" },
      spec: {
        nodeName: "node-1",
      },
      status: {
        phase: "Running",
        containerStatuses: [{
          name: "app",
          state: { waiting: { reason: "ImagePullBackOff" } },
          ready: false,
          restartCount: 0,
        }],
      },
    }));

    // nodes + pods (no logs calls since ImagePullBackOff doesn't fetch logs)
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList(pods)),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledTimes(10);
  });

  it("dedupes same-run alerts from multiple failed pods of the same Job", async () => {
    // Two pods owned by the same Job produce identical titles. Without in-run
    // dedup, both would call createIssue before either lands in the open-issue list.
    const pods = [
      {
        metadata: { name: "namey-migrate-abc12", namespace: "namey",
          ownerReferences: [{ kind: "Job", name: "namey-migrate", controller: true }] },
        status: { phase: "Failed", containerStatuses: [] },
      },
      {
        metadata: { name: "namey-migrate-def34", namespace: "namey",
          ownerReferences: [{ kind: "Job", name: "namey-migrate", controller: true }] },
        status: { phase: "Failed", containerStatuses: [] },
      },
    ];

    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList(pods)),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Workload failing: namey/namey-migrate",
      expect.any(String),
      ["Priority"],
    );
  });

  it("caps node alerts at 10 per run", async () => {
    const nodes = Array.from({ length: 15 }, (_, i) => notReadyNode(`node-${i}`, 10));

    makeKubectlResponseSequential([
      JSON.stringify(nodeList(nodes)),
      JSON.stringify(podList([])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledTimes(10);
  });

  // ── Slack notification ──

  it("sends Slack notification for each new issue", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod(), imagePullPod()])),
      "", // logs for crashloop
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("[k3s] Workload failing: fleet-services/my-service"));
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("[k3s] Workload failing: production/my-app"));
  });

  it("notification for a new alert flags it as Priority and links the issue", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    const msg = mockNotify.mock.calls[0][0] as string;
    expect(msg).toContain(":rotating_light:");
    expect(msg).toContain("Priority alert");
    expect(msg).toContain("https://github.com/St-John-Software/fleet-infra/issues/1");
  });

  it("does not notify when an existing alert is only updated", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "[k3s] Workload failing: fleet-services/my-service" }]);
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockEditIssue).toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // ── readyNode ignored ──

  it("ignores healthy nodes", async () => {
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([readyNode("node-1")])),
      emptyPodJson,
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("does not create an issue when an ignored node goes NotReady", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([notReadyNode("k3s-nas", 10)])),
      emptyPodJson,
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("creates an issue when a non-ignored node goes NotReady even if some nodes are ignored", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([notReadyNode("node-1", 10)])),
      emptyPodJson,
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Node NotReady: node-1",
      expect.stringContaining("**Node:** `node-1`"),
      ["Priority"],
    );
  });

  it("refreshes kubeconfig and retries get-pods on stale/unreachable error", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,                                                       // get nodes
      new Error("kubectl get pods --all-namespaces timed out after 30s"), // first get-pods fails
      emptyPodJson,                                                        // retry get-pods succeeds
      emptyKsJson,
      emptyHrJson,
    ]);

    await runK8sMonitor({
      repo: "St-John-Software/production-infra",
      kubeconfigPath: "/tmp/kube.yaml",
      kubeconfigRefresh: { tailscaleHostname: "prod-k8s", remotePath: "/etc/rancher/k3s/k3s.yaml" },
      ignoredNodes: [],
      logPrefix: "prod-k8s-monitor",
    });

    expect(mockRefreshKubeconfig).toHaveBeenCalledOnce();
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("reports error when kubeconfig refresh throws (cluster down and SSH unreachable)", async () => {
    mockRefreshKubeconfig.mockRejectedValue(new Error("ssh: connect: Connection timed out"));
    makeKubectlResponseSequential([
      emptyNodeJson,
      new Error("kubectl get pods --all-namespaces timed out after 30s"),
    ]);

    await runK8sMonitor({
      repo: "St-John-Software/production-infra",
      kubeconfigPath: "/tmp/kube.yaml",
      kubeconfigRefresh: { tailscaleHostname: "prod-k8s", remotePath: "/etc/rancher/k3s/k3s.yaml" },
      ignoredNodes: [],
      logPrefix: "prod-k8s-monitor",
    });

    expect(mockRefreshKubeconfig).toHaveBeenCalledOnce();
    expect(mockReportError).toHaveBeenCalledWith(
      "prod-k8s-monitor:kubectl-get-pods",
      expect.any(String),
      expect.any(Error),
    );
  });
});

// ── Status cache ──

describe("k3s-monitor status cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockK3sEnabled.value = true;
    mockK3sIgnoredNodes.value = [];
    mockFleetInfraRepo.value = "St-John-Software/fleet-infra";
    mockFindIssueByExactTitle.mockResolvedValue(null);
    mockCreateIssue.mockResolvedValue(1);
    mockCommentOnIssue.mockResolvedValue(undefined);
    mockGetIssueBody.mockResolvedValue(null);
    mockEditIssue.mockResolvedValue(undefined);
    mockReportError.mockResolvedValue(undefined);
  });

  it("populates status cache with correct counts after a successful run", async () => {
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([readyNode("node-1"), readyNode("node-2")])),
      JSON.stringify(podList([healthyPod(), healthyPod()])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    const status = getK8sMonitorStatus("k3s-monitor");
    expect(status).not.toBeNull();
    expect(status?.enabled).toBe(true);
    expect(status?.lastError).toBeNull();
    expect(status?.lastRunAt).toBeTruthy();
    expect(status?.podCount).toBe(2);
    expect(status?.nodeCount).toBe(2);
    expect(status?.nodesNotReady).toBe(0);
    expect(status?.podAlertCount).toBe(0);
    expect(status?.nodeAlertCount).toBe(0);
    expect(status?.fluxAlertCount).toBe(0);
  });

  it("excludes muted (ignoredNodes) NotReady nodes from nodesNotReady and raises no alert (#2133)", async () => {
    mockK3sIgnoredNodes.value = ["k3s-nas"];
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([readyNode("k3s"), notReadyNode("k3s-nas", 10)])),
      JSON.stringify(podList([healthyPod(), healthyPod()])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    const status = getK8sMonitorStatus("k3s-monitor");
    expect(status?.nodesNotReady).toBe(0);
    expect(status?.mutedNodesNotReady).toEqual(["k3s-nas"]);
    expect(status?.nodeAlertCount).toBe(0);
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("counts an unmuted NotReady node in nodesNotReady with no muted nodes reported", async () => {
    mockK3sIgnoredNodes.value = [];
    makeKubectlResponseSequential([
      JSON.stringify(nodeList([readyNode("k3s"), notReadyNode("k3s-nas", 10)])),
      JSON.stringify(podList([healthyPod(), healthyPod()])),
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    const status = getK8sMonitorStatus("k3s-monitor");
    expect(status?.nodesNotReady).toBe(1);
    expect(status?.mutedNodesNotReady).toEqual([]);
  });

  it("sets lastError in status when pod fetch fails", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      new Error("connection refused"),
    ]);

    await run();

    const status = getK8sMonitorStatus("k3s-monitor");
    expect(status).not.toBeNull();
    expect(status?.lastError).toContain("connection refused");
    expect(status?.lastRunAt).toBeNull();
    expect(mockReportError).toHaveBeenCalledWith("k3s-monitor:kubectl-get-pods", expect.any(String), expect.any(Error));
  });

  it("reports error with pods-json-parse fingerprint when kubectl returns invalid JSON", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      "{not valid json",
      emptyKsJson,
      emptyHrJson,
    ]);

    await run();

    expect(mockReportError).toHaveBeenCalledWith("k3s-monitor:pods-json-parse", expect.any(String), expect.any(Error));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("uses logPrefix in fingerprint for prod-k8s-monitor pod fetch failure", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      new Error("kubeconfig not found"),
    ]);

    await runK8sMonitor({
      repo: "St-John-Software/fleet-infra",
      ignoredNodes: [],
      logPrefix: "prod-k8s-monitor",
    });

    expect(mockReportError).toHaveBeenCalledWith("prod-k8s-monitor:kubectl-get-pods", expect.any(String), expect.any(Error));
  });

  it("sets disabled status when k3s monitor is disabled", async () => {
    mockK3sEnabled.value = false;
    await run();

    const status = getK8sMonitorStatus("k3s-monitor");
    expect(status).not.toBeNull();
    expect(status?.enabled).toBe(false);
    expect(status?.lastRunAt).toBeNull();
  });

  it("populates status with alert counts when runK8sMonitor runs with alerts", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify(podList([crashLoopPod()])),
      "", // logs
      emptyKsJson,
      emptyHrJson,
    ]);

    await runK8sMonitor({
      repo: "St-John-Software/fleet-infra",
      ignoredNodes: [],
      logPrefix: "test-prefix-unique",
    });

    const status = getK8sMonitorStatus("test-prefix-unique");
    expect(status).not.toBeNull();
    expect(status?.enabled).toBe(true);
    expect(status?.lastError).toBeNull();
    expect(status?.podAlertCount).toBe(1);
    expect(status?.nodeAlertCount).toBe(0);
    expect(status?.newIssuesRaised).toBe(1);
  });
});

// ── podWorkloadName unit tests ──

describe("podWorkloadName", () => {
  it("strips deployment hash suffixes", () => {
    expect(podWorkloadName("my-service-7d9f4b8c6-xk9pz")).toBe("my-service");
    expect(podWorkloadName("fleet-api-abc1234567-zxcvb")).toBe("fleet-api");
  });

  it("strips daemonset/statefulset suffix", () => {
    expect(podWorkloadName("my-daemonset-xk9pz")).toBe("my-daemonset");
    expect(podWorkloadName("my-app-abc12")).toBe("my-app");
  });

  it("returns the name unchanged when no hash suffixes", () => {
    expect(podWorkloadName("simple-pod")).toBe("simple-pod");
  });

  it("handles names with numbers in the base", () => {
    expect(podWorkloadName("service-v2-abc1234567-xk9pz")).toBe("service-v2");
  });
});

// ── workloadNameForPod unit tests ──

describe("workloadNameForPod", () => {
  it("returns Job name for Job-owned pod with digit-free suffix (regression case)", () => {
    const pod = {
      metadata: {
        name: "migration-runner-post-data-zzmdk",
        namespace: "default",
        ownerReferences: [{ kind: "Job", name: "migration-runner-post-data", controller: true }],
      },
      status: { phase: "Failed", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("migration-runner-post-data");
  });

  it("returns same Job name for Job-owned pod with digit suffix — both pods produce same key", () => {
    const pod = {
      metadata: {
        name: "migration-runner-post-data-zz2dk",
        namespace: "default",
        ownerReferences: [{ kind: "Job", name: "migration-runner-post-data", controller: true }],
      },
      status: { phase: "Failed", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("migration-runner-post-data");
  });

  it("strips CronJob scheduled-time suffix from Job name", () => {
    const pod = {
      metadata: {
        name: "forgejo-backup-29762010-x7k2p",
        namespace: "default",
        ownerReferences: [{ kind: "Job", name: "forgejo-backup-29762010", controller: true }],
      },
      status: { phase: "Failed", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("forgejo-backup");
  });

  it("produces the same key for the same CronJob across different scheduled runs", () => {
    const podFor = (jobName: string) => ({
      metadata: {
        name: `${jobName}-abcde`,
        namespace: "default",
        ownerReferences: [{ kind: "Job", name: jobName, controller: true }],
      },
      status: { phase: "Failed", containerStatuses: [] },
    });
    expect(workloadNameForPod(podFor("immich-db-backup-29757540") as never)).toBe(
      workloadNameForPod(podFor("immich-db-backup-29757180") as never),
    );
  });

  it("keeps short numeric suffixes on one-off Job names", () => {
    const pod = {
      metadata: {
        name: "backup-2024-abcde",
        namespace: "default",
        ownerReferences: [{ kind: "Job", name: "backup-2024", controller: true }],
      },
      status: { phase: "Failed", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("backup-2024");
  });

  it("strips ReplicaSet hash to Deployment name", () => {
    const pod = {
      metadata: {
        name: "my-service-7d9f4b8c6-xk9pz",
        namespace: "default",
        ownerReferences: [{ kind: "ReplicaSet", name: "my-service-7d9f4b8c6", controller: true }],
      },
      status: { phase: "Running", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("my-service");
  });

  it("strips ReplicaSet hash even when hash is digit-free", () => {
    const pod = {
      metadata: {
        name: "my-service-bcdfghjkl-xk9pz",
        namespace: "default",
        ownerReferences: [{ kind: "ReplicaSet", name: "my-service-bcdfghjkl", controller: true }],
      },
      status: { phase: "Running", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("my-service");
  });

  it("returns StatefulSet owner name directly", () => {
    const pod = {
      metadata: {
        name: "web-0",
        namespace: "default",
        ownerReferences: [{ kind: "StatefulSet", name: "web", controller: true }],
      },
      status: { phase: "Running", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("web");
  });

  it("returns DaemonSet owner name directly", () => {
    const pod = {
      metadata: {
        name: "node-exporter-xk9pz",
        namespace: "default",
        ownerReferences: [{ kind: "DaemonSet", name: "node-exporter", controller: true }],
      },
      status: { phase: "Running", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("node-exporter");
  });

  it("falls back to podWorkloadName when no ownerReferences", () => {
    const pod = {
      metadata: {
        name: "my-service-7d9f4b8c6-xk9pz",
        namespace: "default",
      },
      status: { phase: "Running", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("my-service");
  });

  it("uses first ownerReference when none has controller: true", () => {
    const pod = {
      metadata: {
        name: "migration-runner-post-data-zzmdk",
        namespace: "default",
        ownerReferences: [{ kind: "Job", name: "migration-runner-post-data" }],
      },
      status: { phase: "Failed", containerStatuses: [] },
    };
    expect(workloadNameForPod(pod as never)).toBe("migration-runner-post-data");
  });
});

// ── detectPodAlerts unit tests ──

describe("detectPodAlerts", () => {
  it("returns empty array for healthy pods", () => {
    const pods = [
      {
        metadata: { name: "pod-abc1234567-xk9pz", namespace: "default" },
        status: {
          phase: "Running",
          containerStatuses: [{ name: "app", state: { running: { startedAt: "" } }, ready: true, restartCount: 0 }],
        },
      },
    ];
    expect(detectPodAlerts(pods as never)).toHaveLength(0);
  });

  it("skips Succeeded pods", () => {
    const pods = [
      {
        metadata: { name: "job-abc1234567-xk9pz", namespace: "default" },
        status: { phase: "Succeeded", containerStatuses: [] },
      },
    ];
    expect(detectPodAlerts(pods as never)).toHaveLength(0);
  });

  it("detects Failed phase", () => {
    const pods = [
      {
        metadata: { name: "job-abc1234567-xk9pz", namespace: "default" },
        status: { phase: "Failed", containerStatuses: [] },
      },
    ];
    const alerts = detectPodAlerts(pods as never);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("[k3s] Workload failing: default/job");
    expect(alerts[0].body).toContain("**Phase:** Failed");
  });

  it("detects Error terminated with non-zero exit code", () => {
    const pods = [
      {
        metadata: { name: "worker-abc1234567-xk9pz", namespace: "jobs" },
        status: {
          phase: "Running",
          containerStatuses: [{
            name: "worker",
            state: { terminated: { reason: "Error", exitCode: 1 } },
            ready: false,
            restartCount: 0,
          }],
        },
      },
    ];
    const alerts = detectPodAlerts(pods as never);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("[k3s] Workload failing: jobs/worker");
    expect(alerts[0].body).toContain("**Reason:** Error");
  });

  it("does NOT alert on Error with exitCode 0", () => {
    const pods = [
      {
        metadata: { name: "worker-abc1234567-xk9pz", namespace: "jobs" },
        status: {
          phase: "Running",
          containerStatuses: [{
            name: "worker",
            state: { terminated: { reason: "Error", exitCode: 0 } },
            ready: false,
            restartCount: 0,
          }],
        },
      },
    ];
    expect(detectPodAlerts(pods as never)).toHaveLength(0);
  });

  it("deduplicates Job pods with different all-alpha suffixes to same alert title", () => {
    const pods = [
      {
        metadata: {
          name: "migration-runner-post-data-zzmdk",
          namespace: "default",
          ownerReferences: [{ kind: "Job", name: "migration-runner-post-data", controller: true }],
        },
        status: { phase: "Failed", containerStatuses: [] },
      },
      {
        metadata: {
          name: "migration-runner-post-data-tmkfp",
          namespace: "default",
          ownerReferences: [{ kind: "Job", name: "migration-runner-post-data", controller: true }],
        },
        status: { phase: "Failed", containerStatuses: [] },
      },
    ];
    const alerts = detectPodAlerts(pods as never);
    expect(alerts).toHaveLength(2);
    expect(alerts[0].title).toBe("[k3s] Workload failing: default/migration-runner-post-data");
    expect(alerts[1].title).toBe("[k3s] Workload failing: default/migration-runner-post-data");
  });
});

// ── dedupeAlertsByTitle unit tests ──

describe("dedupeAlertsByTitle", () => {
  it("collapses alerts with identical titles, keeping the first", () => {
    const alerts = [
      { title: "[k3s] Workload failing: namey/namey-migrate", body: "first" },
      { title: "[k3s] Workload failing: namey/namey-migrate", body: "second" },
      { title: "[k3s] Node NotReady: node-a", body: "node" },
    ];
    const result = dedupeAlertsByTitle(alerts);
    expect(result).toHaveLength(2);
    expect(result[0].body).toBe("first");
    expect(result.map((a) => a.title)).toEqual([
      "[k3s] Workload failing: namey/namey-migrate",
      "[k3s] Node NotReady: node-a",
    ]);
  });

  it("returns alerts unchanged when all titles are unique", () => {
    const alerts = [
      { title: "[k3s] A", body: "1" },
      { title: "[k3s] B", body: "2" },
    ];
    expect(dedupeAlertsByTitle(alerts)).toHaveLength(2);
  });

  it("prefers the alert with a podRef, so log enrichment is not discarded", () => {
    const podRef = { namespace: "default", podName: "p", containerName: "c", previous: true };
    const alerts = [
      { title: "[k3s] Workload failing: default/whisper", body: "failed" },
      { title: "[k3s] Workload failing: default/whisper", body: "crashloop", podRef },
    ];
    const result = dedupeAlertsByTitle(alerts);
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("crashloop");
  });

  it("keeps the first podRef alert when a later collision also has one", () => {
    const podRef = { namespace: "default", podName: "p", containerName: "c", previous: true };
    const alerts = [
      { title: "[k3s] Workload failing: default/whisper", body: "first", podRef },
      { title: "[k3s] Workload failing: default/whisper", body: "second", podRef },
    ];
    expect(dedupeAlertsByTitle(alerts)[0].body).toBe("first");
  });

  it("preserves result order when a later alert replaces an earlier one", () => {
    const podRef = { namespace: "default", podName: "p", containerName: "c", previous: true };
    const alerts = [
      { title: "[k3s] Workload failing: default/whisper", body: "failed" },
      { title: "[k3s] Node NotReady: node-a", body: "node" },
      { title: "[k3s] Workload failing: default/whisper", body: "crashloop", podRef },
    ];
    expect(dedupeAlertsByTitle(alerts).map((a) => a.body)).toEqual(["crashloop", "node"]);
  });
});

// ── Workload-keyed pod alert titles (issue #2298) ──

describe("podAlertTitle / legacyPodAlertTitles", () => {
  it("keys the title on the workload alone", () => {
    expect(podAlertTitle("default", "whisper")).toBe("[k3s] Workload failing: default/whisper");
  });

  it("lists the pre-rename reason-bearing titles", () => {
    const legacy = legacyPodAlertTitles("default", "whisper");
    expect(legacy).toContain("[k3s] Pod Failed: default/whisper");
    expect(legacy).toContain("[k3s] CrashLoopBackOff: default/whisper");
    expect(legacy).toContain("[k3s] OOMKilled: default/whisper");
    expect(legacy).toContain("[k3s] ImagePullBackOff: default/whisper");
    expect(legacy).toContain("[k3s] Error: default/whisper");
  });

  it("never matches a Flux alert title for the same namespace/name", () => {
    expect(legacyPodAlertTitles("flux-system", "apps")).not.toContain(
      "[k3s] Flux Kustomization NotReady: flux-system/apps",
    );
  });
});

describe("pod alert consolidation across failure reasons", () => {
  const failedPod = {
    metadata: {
      name: "whisper-69fdfb5997-aaaaa",
      namespace: "default",
      ownerReferences: [{ kind: "ReplicaSet", name: "whisper-69fdfb5997", controller: true }],
    },
    status: { phase: "Failed", containerStatuses: [] },
  };
  const crashLoopReplacement = {
    metadata: {
      name: "whisper-69fdfb5997-bbbbb",
      namespace: "default",
      ownerReferences: [{ kind: "ReplicaSet", name: "whisper-69fdfb5997", controller: true }],
    },
    status: {
      phase: "Running",
      containerStatuses: [{
        name: "app",
        state: { waiting: { reason: "CrashLoopBackOff", message: "back-off" } },
        ready: false,
        restartCount: 7,
      }],
    },
  };

  it("collapses a Failed pod and a CrashLoopBackOff pod of one Deployment into one alert", () => {
    const alerts = dedupeAlertsByTitle(detectPodAlerts([failedPod, crashLoopReplacement] as never));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("[k3s] Workload failing: default/whisper");
    // The surviving alert is the log-enrichable one.
    expect(alerts[0].podRef).toBeDefined();
    expect(alerts[0].body).toContain("**Reason:** CrashLoopBackOff");
  });
});

// ── detectNodeAlerts unit tests ──

describe("detectNodeAlerts", () => {
  it("returns empty for ready nodes", () => {
    const nodes = [
      {
        metadata: { name: "node-1" },
        status: {
          conditions: [{ type: "Ready", status: "True", lastTransitionTime: new Date(Date.now() - 10 * 60 * 1000).toISOString() }],
        },
      },
    ];
    expect(detectNodeAlerts(nodes as never)).toHaveLength(0);
  });

  it("detects NotReady node after 2 minutes", () => {
    const nodes = [
      {
        metadata: { name: "node-1" },
        status: {
          conditions: [{ type: "Ready", status: "False", lastTransitionTime: new Date(Date.now() - 5 * 60 * 1000).toISOString() }],
        },
      },
    ];
    const alerts = detectNodeAlerts(nodes as never);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("Node NotReady: node-1");
  });

  it("skips NotReady within 2-minute transition window", () => {
    const nodes = [
      {
        metadata: { name: "node-1" },
        status: {
          conditions: [{ type: "Ready", status: "False", lastTransitionTime: new Date(Date.now() - 90 * 1000).toISOString() }],
        },
      },
    ];
    expect(detectNodeAlerts(nodes as never)).toHaveLength(0);
  });

  it("skips nodes in the ignored list", () => {
    const nodes = [
      {
        metadata: { name: "nas" },
        status: {
          conditions: [{ type: "Ready", status: "False", lastTransitionTime: new Date(Date.now() - 10 * 60 * 1000).toISOString() }],
        },
      },
    ];
    expect(detectNodeAlerts(nodes as never, ["nas"])).toHaveLength(0);
  });

  it("still alerts on NotReady nodes not in the ignored list", () => {
    const nodes = [
      {
        metadata: { name: "nas" },
        status: {
          conditions: [{ type: "Ready", status: "False", lastTransitionTime: new Date(Date.now() - 10 * 60 * 1000).toISOString() }],
        },
      },
      {
        metadata: { name: "node-1" },
        status: {
          conditions: [{ type: "Ready", status: "False", lastTransitionTime: new Date(Date.now() - 10 * 60 * 1000).toISOString() }],
        },
      },
    ];
    const alerts = detectNodeAlerts(nodes as never, ["nas"]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("Node NotReady: node-1");
  });
});

// ── detectFluxAlerts unit tests ──

function failedKustomization(name: string, namespace: string, minutesAgo: number, reason = "ReconciliationFailed", message = "dry-run failed") {
  return {
    metadata: { name, namespace },
    status: {
      conditions: [{
        type: "Ready",
        status: "False",
        reason,
        message,
        lastTransitionTime: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
      }],
    },
  };
}

function readyKustomization(name: string, namespace: string) {
  return {
    metadata: { name, namespace },
    status: {
      conditions: [{
        type: "Ready",
        status: "True",
        reason: "ReconciliationSucceeded",
        message: "",
        lastTransitionTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }],
    },
  };
}

describe("detectFluxAlerts", () => {
  it("returns empty for a Ready=True Kustomization", () => {
    const resources = [readyKustomization("apps", "flux-system")];
    expect(detectFluxAlerts(resources as never, "Kustomization")).toHaveLength(0);
  });

  it("returns empty within the 2-minute grace period", () => {
    const resources = [failedKustomization("apps", "flux-system", 1)];
    expect(detectFluxAlerts(resources as never, "Kustomization")).toHaveLength(0);
  });

  it("raises alert for ReconciliationFailed Kustomization after grace period", () => {
    const resources = [failedKustomization("apps", "flux-system", 5)];
    const alerts = detectFluxAlerts(resources as never, "Kustomization");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("[k3s] Flux Kustomization NotReady: flux-system/apps");
    expect(alerts[0].body).toContain("**Resource:** `flux-system/apps`");
    expect(alerts[0].body).toContain("**Kind:** Kustomization");
    expect(alerts[0].body).toContain("**Reason:** ReconciliationFailed");
  });

  it("raises alert for SourceNotReady HelmRelease", () => {
    const resources = [failedKustomization("headlamp", "flux-system", 10, "SourceNotReady", "HelmRepository not ready")];
    const alerts = detectFluxAlerts(resources as never, "HelmRelease");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("[k3s] Flux HelmRelease NotReady: flux-system/headlamp");
    expect(alerts[0].body).toContain("**Kind:** HelmRelease");
    expect(alerts[0].body).toContain("**Reason:** SourceNotReady");
  });

  it("includes message in body", () => {
    const resources = [failedKustomization("apps", "flux-system", 5, "ReconciliationFailed", "PVC spec is immutable")];
    const alerts = detectFluxAlerts(resources as never, "Kustomization");
    expect(alerts[0].body).toContain("PVC spec is immutable");
  });

  it("truncates long messages to 2000 chars", () => {
    const longMessage = "x".repeat(3000);
    const resources = [failedKustomization("apps", "flux-system", 5, "ReconciliationFailed", longMessage)];
    const alerts = detectFluxAlerts(resources as never, "Kustomization");
    expect(alerts[0].body).toContain("x".repeat(2000));
    expect(alerts[0].body).not.toContain("x".repeat(2001));
  });

  it("handles resource with no status field", () => {
    const resources = [{ metadata: { name: "apps", namespace: "flux-system" } }];
    expect(detectFluxAlerts(resources as never, "Kustomization")).toHaveLength(0);
  });

  it("suppresses DependencyNotReady cascade alerts (Kustomization)", () => {
    const resources = [
      failedKustomization("migrations-post-data", "flux-system", 5, "DependencyNotReady", "dependency 'flux-system/data' is not ready"),
    ];
    expect(detectFluxAlerts(resources as never, "Kustomization")).toHaveLength(0);
  });

  it("still raises the dependency's own ReconciliationFailed alert while suppressing the cascade", () => {
    const resources = [
      failedKustomization("data", "flux-system", 5, "ReconciliationFailed", "build failed"),
      failedKustomization("migrations-post-data", "flux-system", 5, "DependencyNotReady", "dependency 'flux-system/data' is not ready"),
    ];
    const alerts = detectFluxAlerts(resources as never, "Kustomization");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("[k3s] Flux Kustomization NotReady: flux-system/data");
  });

  it("raises alert for HealthCheckFailed inside the 2-minute grace period (fail-fast flap, #1989)", () => {
    const resources = [
      failedKustomization("migrations-pre-data", "flux-system", 1, "HealthCheckFailed", "Job/migration-runner-pre-data failed"),
    ];
    const alerts = detectFluxAlerts(resources as never, "Kustomization");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("[k3s] Flux Kustomization NotReady: flux-system/migrations-pre-data");
    expect(alerts[0].body).toContain("**Reason:** HealthCheckFailed");
  });

  it("still suppresses a transient Progressing NotReady inside the grace period", () => {
    const resources = [failedKustomization("apps", "flux-system", 1, "Progressing", "reconciliation in progress")];
    expect(detectFluxAlerts(resources as never, "Kustomization")).toHaveLength(0);
  });

  it("suppresses DependencyNotReady even inside the grace period", () => {
    const resources = [
      failedKustomization("data", "flux-system", 1, "DependencyNotReady", "dependency 'flux-system/migrations-pre-data' is not ready"),
    ];
    expect(detectFluxAlerts(resources as never, "Kustomization")).toHaveLength(0);
  });

  it("raises alert for HealthCheckFailed outside the grace period", () => {
    const resources = [failedKustomization("migrations-pre-data", "flux-system", 5, "HealthCheckFailed", "Job failed")];
    expect(detectFluxAlerts(resources as never, "Kustomization")).toHaveLength(1);
  });
});

// ── run() integration tests for Flux ──

describe("run() Flux integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockK3sEnabled.value = true;
    mockFleetInfraRepo.value = "St-John-Software/fleet-infra";
    mockFindIssueByExactTitle.mockResolvedValue(null);
    mockCreateIssue.mockResolvedValue(1);
    mockGetIssueBody.mockResolvedValue(null);
    mockEditIssue.mockResolvedValue(undefined);
    mockReportError.mockResolvedValue(undefined);
  });

  it("creates issue for failed Kustomization", async () => {
    const failedKs = failedKustomization("apps", "flux-system", 5);
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify({ items: [] }), // pods
      JSON.stringify({ items: [failedKs] }), // kustomizations
      emptyHrJson,
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Flux Kustomization NotReady: flux-system/apps",
      expect.stringContaining("**Resource:** `flux-system/apps`"),
      ["Priority"],
    );
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("Kustomization NotReady"));
  });

  it("creates issue for failed HelmRelease", async () => {
    const failedHr = failedKustomization("headlamp", "flux-system", 10, "SourceNotReady", "HelmRepository not ready");
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify({ items: [] }), // pods
      emptyKsJson,
      JSON.stringify({ items: [failedHr] }), // helmreleases
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/fleet-infra",
      "[k3s] Flux HelmRelease NotReady: flux-system/headlamp",
      expect.stringContaining("**Kind:** HelmRelease"),
      ["Priority"],
    );
  });

  it("continues when kubectl get kustomizations fails", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify({ items: [] }), // pods
      new Error("no matches for kind \"Kustomization\""), // kustomizations
      emptyHrJson,
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("kubectl get kustomizations failed"));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("continues when kubectl get helmreleases fails", async () => {
    makeKubectlResponseSequential([
      emptyNodeJson,
      JSON.stringify({ items: [] }), // pods
      emptyKsJson,
      new Error("no matches for kind \"HelmRelease\""), // helmreleases
    ]);

    await run();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("kubectl get helmreleases failed"));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });
});
