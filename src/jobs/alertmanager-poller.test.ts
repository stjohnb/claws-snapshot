import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { mockBridge, mockRepoConfig, mockMetrics, mockConfig } = vi.hoisted(() => ({
  mockBridge: { routeDirectAlerts: vi.fn() },
  mockRepoConfig: { listRepoConfigs: vi.fn() },
  mockMetrics: { setAlertmanagerPollOk: vi.fn() },
  mockConfig: { isJobDisabledForRepo: vi.fn((_job: string, _repo: string) => false) },
}));

vi.mock("../alert-bridge.js", () => mockBridge);
vi.mock("../repo-config.js", () => mockRepoConfig);
vi.mock("../metrics.js", () => mockMetrics);
vi.mock("../config.js", () => mockConfig);
vi.mock("../grafana-jwt.js", () => ({
  grafanaUrl: (cluster: string) => (cluster === "prod" ? "https://grafana.example" : "https://fleet-grafana.example"),
  mintGrafanaJwt: () => "jwt-token",
}));

import * as log from "../log.js";
import { currentIssueActor } from "../issue-history-actor.js";
import {
  groupAlerts,
  groupName,
  pollRepo,
  resetAlertmanagerPollerForTest,
  run,
  type AlertmanagerAlert,
} from "./alertmanager-poller.js";

const REPO = "St-John-Software/production-infra";
const TITLE = "[Alert] production-infra alerts firing";
const LABEL = "alert";

let fetchMock: ReturnType<typeof vi.fn>;

type Mode = "shadow" | "write" | "direct";
function bridge(mode: Mode = "write", overrides: Record<string, unknown> = {}) {
  return {
    label: LABEL,
    title: TITLE,
    repo: REPO,
    poll: {
      cluster: "prod" as const, datasourceUid: "alertmanager", mode, source: "alertmanager" as const, maxNewIssuesPerPoll: 3,
      ignoreAlertnames: ["Watchdog"], ...overrides,
    },
  };
}

function alert(alertname: string, fingerprint: string, labels: Record<string, string> = {}, annotations: Record<string, string> = {}): AlertmanagerAlert {
  return {
    labels: { alertname, severity: "warning", app: "api", ...labels },
    annotations: { summary: `${alertname} summary`, description: `${alertname} description`, ...annotations },
    startsAt: "2026-11-05T09:00:00.123Z",
    endsAt: "2026-11-05T10:00:00Z",
    generatorURL: "http://prometheus:9090/graph",
    fingerprint,
    status: { state: "active" },
  } as AlertmanagerAlert;
}

function respond(alerts: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(alerts), { status }));
}

let clock = new Date("2026-11-05T12:00:00Z");
async function poll(alerts: unknown, mode: Mode = "write", overrides: Record<string, unknown> = {}) {
  respond(alerts);
  clock = new Date(clock.getTime() + 60_000);
  await pollRepo(bridge(mode, overrides), clock);
}

type DirectCall = [unknown, { name: string; fresh: boolean; [k: string]: unknown }[], { dryRun: boolean; now: string }];
const directCalls = () => mockBridge.routeDirectAlerts.mock.calls as DirectCall[];
const actors: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  resetAlertmanagerPollerForTest();
  actors.length = 0;
  clock = new Date("2026-11-05T12:00:00Z");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockBridge.routeDirectAlerts.mockImplementation(async (_b: unknown, groups: { name: string }[]) => {
    actors.push(currentIssueActor());
    return groups.map((g) => ({ group: g.name, key: "k", decision: "none", issue: "clw_x" }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("grouping", () => {
  it("names a group <service> / <alert>, preferring claws_service and claws_alertname", () => {
    expect(groupName({ alertname: "A", app: "api" })).toBe("api / A");
    expect(groupName({ alertname: "A", app: "api", claws_service: "svc" })).toBe("svc / A");
    expect(groupName({ alertname: "A", claws_alertname: "Claws error: x" })).toBe("Claws error: x");
    expect(groupName({ alertname: "A" })).toBe("A");
    expect(groupName({ alertname: "A", namespace: "ns", pod: "p-1" })).toBe("A");
  });

  it("follows fleet's service rule: container and job fall back, scrape targets are skipped, ' / ' never leaks", () => {
    expect(groupName({ alertname: "A", container: "web", job: "j" })).toBe("web / A");
    expect(groupName({ alertname: "A", job: "backup" })).toBe("backup / A");
    expect(groupName({ alertname: "A", container: "kube-state-metrics", job: "Kubelet", node: "n1" })).toBe("n1 / A");
    expect(groupName({ alertname: "A", job: "node-exporter" })).toBe("A");
    expect(groupName({ alertname: "A", claws_service: "kube-state-metrics", job: "x" })).toBe("kube-state-metrics / A");
    expect(groupName({ alertname: "a / b" })).toBe("a - b");
    expect(groupName({ alertname: "x / y", app: "s / t" })).toBe("s - t / x - y");
  });

  it("splits one alertname into a group per claws_alertname", () => {
    const groups = groupAlerts([
      alert("Errors", "f1", { claws_alertname: "error one" }),
      alert("Errors", "f2", { claws_alertname: "error two" }),
      alert("Errors", "f3", { claws_alertname: "error one" }),
    ]);
    expect([...groups.keys()]).toEqual(["api / error one", "api / error two"]);
    expect([...groups.get("api / error one")!.firingKeys]).toEqual(["f1", "f3"]);
  });

  it("keys an instance with no usable fingerprint by a 16-hex hash of its sorted labels", () => {
    const a = groupAlerts([{ labels: { b: "2", alertname: "X" } }]).get("X")!;
    const b = groupAlerts([{ labels: { alertname: "X", b: "2" } }]).get("X")!;
    const [key] = [...a.firingKeys];
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect([...b.firingKeys]).toEqual([key]);
  });
});

describe("pollRepo", () => {
  it("reads the Alertmanager datasource proxy with the Claws JWT", async () => {
    await poll([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://grafana.example/api/datasources/proxy/uid/alertmanager/api/v2/alerts?active=true&silenced=false&inhibited=false",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }) }),
    );
  });

  it("reads Grafana's managed-alerts Alertmanager for source grafana", async () => {
    await poll([], "shadow", { source: "grafana", cluster: "fleet" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://fleet-grafana.example/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false",
      expect.anything(),
    );
  });

  for (const mode of ["write", "direct"] as const) {
    it(`routes live in ${mode} mode, as the poller, fresh only for an instance new since the last poll`, async () => {
      await poll([alert("A", "f1")], mode);
      await poll([alert("A", "f1")], mode);
      await poll([alert("A", "f1"), alert("B", "f2")], mode);
      await poll([alert("A", "f1"), alert("A", "f3"), alert("B", "f2")], mode);
      expect(directCalls().map(([, groups, opts]) => [opts.dryRun, groups.map((g) => [g.name, g.fresh])])).toEqual([
        [false, [["api / A", false]]],
        [false, [["api / A", false]]],
        [false, [["api / A", false], ["api / B", true]]],
        [false, [["api / A", true], ["api / B", false]]],
      ]);
      expect(directCalls()[0]![2].now).toBe("2026-11-05T12:01:00Z");
      expect(actors.every((a) => JSON.stringify(a) === JSON.stringify({ kind: "automation", name: "alertmanager poller" }))).toBe(true);
      expect(mockMetrics.setAlertmanagerPollOk).toHaveBeenLastCalledWith("prod", true);
    });
  }

  it("only logs in shadow mode: the router runs as a dry run", async () => {
    await poll([alert("A", "f1")], "shadow");
    await poll([alert("A", "f1"), alert("A", "f2")], "shadow");
    expect(directCalls()).toHaveLength(2);
    expect(directCalls().every(([, , opts]) => opts.dryRun)).toBe(true);
    expect(directCalls()[1]![1]).toEqual([expect.objectContaining({ name: "api / A", fresh: true })]);
  });

  it("hands the router each group's evidence and instances", async () => {
    await poll([alert("A", "f1", {}, { dashboard: "https://grafana.example/d/a" })]);
    expect(directCalls()[0]![1]).toEqual([{
      name: "api / A", severity: "warning", summary: "A summary", description: "A description", dashboard: "https://grafana.example/d/a",
      source: "http://prometheus:9090/graph", startsAt: "2026-11-05T09:00:00.123Z",
      instances: [{ key: "f1", startsAt: "2026-11-05T09:00:00.123Z" }], fresh: false,
    }]);
  });

  it("ignores Watchdog by default and an ignored claws_alertname", async () => {
    await poll([alert("Watchdog", "w1", { app: "" }), alert("Errors", "e1", { claws_alertname: "noisy" })], "write", { ignoreAlertnames: ["Watchdog", "noisy"] });
    expect(directCalls()[0]![1]).toEqual([]);
  });

  it("logs one no-change line when every group is unchanged or none fires", async () => {
    await poll([]);
    expect(vi.mocked(log.info)).toHaveBeenLastCalledWith(expect.stringContaining("no alert issue change"),
      expect.objectContaining({ bridge_repo: REPO, cluster: "prod", mode: "write", decision: "none", reason: "no_firing", firing: 0 }));
    await poll([alert("A", "f1")]);
    expect(vi.mocked(log.info)).toHaveBeenLastCalledWith(expect.stringContaining("no alert issue change"), expect.objectContaining({ reason: "unchanged", firing: 1 }));
    vi.mocked(log.info).mockClear();
    mockBridge.routeDirectAlerts.mockResolvedValueOnce([{ group: "api / A", key: "k", decision: "bump", issue: "clw_x" }]);
    await poll([alert("A", "f1"), alert("A", "f2")]);
    expect(vi.mocked(log.info)).not.toHaveBeenCalledWith(expect.stringContaining("no alert issue change"), expect.anything());
  });

  it("touches nothing, sets the gauge to 0 and warns on a failed poll, and never counts across it", async () => {
    await poll([alert("A", "f1")]);
    respond({ message: "bad gateway" }, 502);
    await pollRepo(bridge(), clock);
    expect(mockMetrics.setAlertmanagerPollOk).toHaveBeenLastCalledWith("prod", false);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("Alertmanager poll failed"), expect.objectContaining({ cluster: "prod", http_status: 502 }));
    respond([], 302);
    await pollRepo(bridge(), clock);
    respond("not a list");
    await pollRepo(bridge(), clock);
    expect(vi.mocked(log.warn)).toHaveBeenLastCalledWith(expect.stringContaining("Alertmanager poll failed"), expect.objectContaining({ probe_error: "unparseable" }));
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    await pollRepo(bridge(), clock);
    expect(vi.mocked(log.warn)).toHaveBeenLastCalledWith(expect.stringContaining("Alertmanager poll failed"), expect.objectContaining({ probe_error: "TimeoutError" }));
    expect(directCalls()).toHaveLength(1);
    // The next successful poll compares against the last successful one.
    await poll([alert("A", "f1")]);
    expect(directCalls()[1]![1]).toEqual([expect.objectContaining({ name: "api / A", fresh: false })]);
  });
});

describe("run", () => {
  it("counts a failed reconcile and still polls the next repo", async () => {
    mockRepoConfig.listRepoConfigs.mockReturnValue([
      { fullName: REPO, config: { enabled: true, alertBridge: { label: LABEL, title: TITLE, poll: bridge().poll } } },
      { fullName: "o/second", config: { enabled: true, alertBridge: { label: LABEL, title: TITLE, poll: bridge().poll } } },
    ]);
    mockBridge.routeDirectAlerts.mockRejectedValueOnce(new Error("db down"));
    respond([]);
    respond([]);
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("poll finished"), expect.objectContaining({ repos: 2, failed: 1 }));
  });

  it("polls only enabled repos with alertBridge.poll whose job is enabled", async () => {
    mockRepoConfig.listRepoConfigs.mockReturnValue([
      { fullName: REPO, config: { enabled: true, alertBridge: { label: LABEL, title: TITLE, poll: bridge().poll } } },
      { fullName: "o/plain", config: { enabled: true, alertBridge: null } },
      { fullName: "o/off", config: { enabled: false, alertBridge: { label: LABEL, title: TITLE, poll: bridge().poll } } },
      { fullName: "o/disabled", config: { enabled: true, alertBridge: { label: LABEL, title: TITLE, poll: bridge().poll } } },
    ]);
    mockConfig.isJobDisabledForRepo.mockImplementation((_job: string, repo: string) => repo === "o/disabled");
    respond([]);
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("poll finished"), expect.objectContaining({ repos: 1, failed: 0 }));
  });
});
