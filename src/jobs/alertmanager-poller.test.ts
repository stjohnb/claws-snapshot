import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { mockBridge, mockRepoConfig, mockMetrics, mockConfig } = vi.hoisted(() => ({
  mockBridge: {
    MAX_ALERT_INSTANCES: 200,
    createInbox: vi.fn(),
    updateInbox: vi.fn(),
    listOpenInboxes: vi.fn(),
    listRecentlyClosedInboxes: vi.fn(),
    routeAlertEvents: vi.fn(),
  },
  mockRepoConfig: { listRepoConfigs: vi.fn() },
  mockMetrics: { setAlertmanagerPollOk: vi.fn() },
  mockConfig: { isJobDisabledForRepo: vi.fn((_job: string, _repo: string) => false) },
}));

vi.mock("../alert-bridge.js", () => mockBridge);
vi.mock("../repo-config.js", () => mockRepoConfig);
vi.mock("../metrics.js", () => mockMetrics);
vi.mock("../config.js", () => mockConfig);
vi.mock("../claws-issues.js", () => ({ toIso: (stored: string) => `${stored.replace(" ", "T")}.000Z` }));
vi.mock("../grafana-jwt.js", () => ({
  grafanaUrl: (cluster: string) => (cluster === "prod" ? "https://grafana.example" : "https://fleet-grafana.example"),
  mintGrafanaJwt: () => "jwt-token",
}));

import * as log from "../log.js";
import {
  MAX_ISSUE_BODY,
  groupAlerts,
  groupName,
  newState,
  parseBody,
  pollRepo,
  renderBody,
  renderBounded,
  resetAlertmanagerPollerForTest,
  run,
  type AlertmanagerAlert,
  type Section,
} from "./alertmanager-poller.js";

const REPO = "St-John-Software/production-infra";
const TITLE = "[Alert] production-infra alerts firing";
const LABEL = "alert";
const CTX = { repo: REPO, grafanaUrl: "https://grafana.example", reopenWindowHours: 24 };

interface FakeIssue {
  id: string;
  body: string;
  state: "open" | "closed";
  closed_at: string | null;
}

let issues: FakeIssue[] = [];
let nextId = 1;
let fetchMock: ReturnType<typeof vi.fn>;

type Mode = "shadow" | "write";
function bridge(mode: Mode = "write", overrides: Record<string, unknown> = {}) {
  return {
    label: LABEL,
    title: TITLE,
    repo: REPO,
    poll: { cluster: "prod" as const, datasourceUid: "alertmanager", mode, reopenWindowHours: 24, ignoreAlertnames: ["Watchdog"], ...overrides },
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

const openIssues = () => issues.filter((i) => i.state === "open");
const only = () => {
  expect(issues).toHaveLength(1);
  return issues[0]!;
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAlertmanagerPollerForTest();
  issues = [];
  nextId = 1;
  clock = new Date("2026-11-05T12:00:00Z");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockBridge.listOpenInboxes.mockImplementation(async () => openIssues().map((i) => ({ ...i })));
  mockBridge.listRecentlyClosedInboxes.mockImplementation(async () =>
    issues.filter((i) => i.state === "closed").sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? "")).map((i) => ({ ...i })));
  mockBridge.createInbox.mockImplementation(async (_b: unknown, body: string) => {
    const issue: FakeIssue = { id: `clw_${nextId++}`, body, state: "open", closed_at: null };
    issues.push(issue);
    return { ...issue };
  });
  mockBridge.updateInbox.mockImplementation(async (_b: unknown, record: FakeIssue, update: { body?: string; state?: "open" | "closed" }) => {
    const issue = issues.find((i) => i.id === record.id)!;
    if (update.body !== undefined) issue.body = update.body;
    if (update.state === "closed") {
      issue.state = "closed";
      issue.closed_at = clock.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }
    if (update.state === "open") {
      issue.state = "open";
      issue.closed_at = null;
    }
    return { ...issue };
  });
  mockBridge.routeAlertEvents.mockImplementation(async (_b: unknown, events: { alertname: string }[]) =>
    Object.fromEntries(events.map((e) => [e.alertname, { tracked: false }])));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function section(body: string, name: string): Section {
  const state = parseBody(body);
  expect(state).not.toBeNull();
  const s = state!.sections.get(name);
  expect(s, `section ${name}`).toBeDefined();
  return s!;
}

describe("grouping", () => {
  it("names a group <service> / <alert>, preferring claws_service and claws_alertname", () => {
    expect(groupName({ alertname: "A", app: "api" })).toBe("api / A");
    expect(groupName({ alertname: "A", app: "api", claws_service: "svc" })).toBe("svc / A");
    expect(groupName({ alertname: "A", claws_alertname: "Claws error: x" })).toBe("Claws error: x");
    expect(groupName({ alertname: "A" })).toBe("A");
    expect(groupName({ alertname: "A", namespace: "ns", pod: "p-1" })).toBe("A");
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

describe("body model", () => {
  it("renders and parses back the push bridge's format, footer and occurrence block", () => {
    const state = newState("2026-11-05T09:00:00Z");
    state.total = 3;
    state.sections.set("api / A", {
      severity: "critical", status: "firing", first: "2026-11-05T09:00:00Z", last: "2026-11-05T09:10:00Z", count: 3, resolved: "-",
      dashboard: "", source: "", triage: "transient — deploy blip | rolled", tracked: "", summary: "s", description: "d",
      instances: new Set(["f2", "f1"]), seen: new Set(["f1", "f2"]), triaged: new Set(["f1"]),
    });
    const body = renderBody(state, CTX);
    expect(body).toContain("[📊 Grafana](https://grafana.example) · [📈 Explore metrics](https://grafana.example/explore) · [📜 Explore logs](https://grafana.example/explore)");
    expect(body).toContain("| Triage | transient — deploy blip \\| rolled |");
    expect(body).toContain("<!-- firing-instances: f1,f2 -->");
    expect(body).toContain("<!-- triaged-instances: f1 -->");
    expect(body).toContain("*Automatically managed by alert-issue-bridge. Closed when every alert above is resolved or tracked; reopened if an untracked alert re-fires within 24 hours.*");
    expect(body.endsWith("---\n**First seen:** 2026-11-05T09:00:00Z\n**Last seen:** 2026-11-05T09:00:00Z\n**Occurrences:** 3")).toBe(true);
    const parsed = parseBody(body)!;
    expect(parsed.sections.get("api / A")!.triage).toBe("transient — deploy blip | rolled");
    expect(renderBody(parsed, CTX)).toBe(body);
  });

  it("defaults seen to the instances and triaged to seen for a body without those lines", () => {
    const body = [
      "intro", "", "## Currently firing", "", "- api / A (warning)", "", "## Alerts", "",
      "### api / A", "", "| Field | Value |", "|---|---|",
      "| Severity | warning |", "| Status | firing |", "| First occurrence | x |", "| Last occurrence | y |",
      "| Occurrences | 2 |", "| Resolved | - |", "| Triage | transient — fine |", "",
      "<!-- firing-instances: f1 -->", "", "**Summary:** s", "", "**Description:** d", "",
      "*Automatically managed by alert-issue-bridge. Closed when …*", "", "---",
      "**First seen:** a", "**Last seen:** b", "**Occurrences:** 2",
    ].join("\n");
    const s = parseBody(body)!.sections.get("api / A")!;
    expect([...s.seen]).toEqual(["f1"]);
    expect([...s.triaged]).toEqual(["f1"]);
  });

  it("rejects a hand-edited body", () => {
    expect(parseBody("just text")).toBeNull();
    expect(parseBody("## Alerts\n\nstray\n*Automatically managed by alert-issue-bridge.*\n**First seen:** a\n**Last seen:** b\n**Occurrences:** 1")).toBeNull();
  });

  it("bounds the body by dropping the oldest resolved sections first, never a firing one", () => {
    const state = newState("2026-11-05T09:00:00Z");
    const big = "x".repeat(900);
    for (let i = 0; i < 80; i++) {
      state.sections.set(`svc / R${String(i).padStart(2, "0")}`, {
        severity: "warning", status: "resolved", first: "a", last: "b", count: 1,
        resolved: `2026-11-0${1 + (i % 4)}T00:00:${String(i % 60).padStart(2, "0")}Z`,
        dashboard: "", source: "", triage: "", tracked: "", summary: "s", description: big,
        instances: new Set(), seen: new Set([`k${i}`]), triaged: new Set(),
      });
    }
    state.sections.set("svc / Firing", {
      severity: "critical", status: "firing", first: "a", last: "b", count: 1, resolved: "-",
      dashboard: "", source: "", triage: "", tracked: "", summary: "s", description: big,
      instances: new Set(["f"]), seen: new Set(["f"]), triaged: new Set(),
    });
    const body = renderBounded(state, CTX);
    expect(body.length).toBeLessThanOrEqual(MAX_ISSUE_BODY);
    expect(state.sections.has("svc / Firing")).toBe(true);
    // The oldest-resolved (2026-11-01) sections go first.
    expect(state.sections.has("svc / R00")).toBe(false);
    expect(state.sections.has("svc / R03")).toBe(true);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });
});

describe("pollRepo", () => {
  it("files a new inbox for a first untracked firing and reports it as an event", async () => {
    await poll([alert("HighLatency", "f1")]);
    const issue = only();
    const s = section(issue.body, "api / HighLatency");
    expect(s.status).toBe("firing");
    expect(s.count).toBe(1);
    expect(s.first).toBe("2026-11-05T09:00:00Z");
    expect([...s.instances]).toEqual(["f1"]);
    expect(s.source).toBe("http://prometheus:9090/graph");
    expect(parseBody(issue.body)!.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://grafana.example/api/datasources/proxy/uid/alertmanager/api/v2/alerts?active=true&silenced=false&inhibited=false",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }) }),
    );
    const [, events, opts] = mockBridge.routeAlertEvents.mock.calls[0]!;
    expect(opts).toEqual({ dryRun: true });
    expect(events).toEqual([expect.objectContaining({ alertname: "api / HighLatency", status: "firing", instances: [{ key: "f1", startsAt: "2026-11-05T09:00:00.123Z" }] })]);
    expect(mockMetrics.setAlertmanagerPollOk).toHaveBeenCalledWith("prod", true);
  });

  it("counts an occurrence once per new instance, never per poll", async () => {
    await poll([alert("A", "f1")]);
    await poll([alert("A", "f1")]);
    await poll([alert("A", "f1")]);
    expect(mockBridge.updateInbox).not.toHaveBeenCalled();
    await poll([alert("A", "f1"), alert("A", "f2")]);
    const s = section(only().body, "api / A");
    expect(s.count).toBe(2);
    expect([...s.instances].sort()).toEqual(["f1", "f2"]);
    expect(parseBody(only().body)!.total).toBe(2);
  });

  it("adds a section for a new group to the open inbox without bumping the others", async () => {
    await poll([alert("A", "f1")]);
    await poll([alert("A", "f1"), alert("B", "f2")]);
    const body = only().body;
    expect(section(body, "api / A").count).toBe(1);
    expect(section(body, "api / B").count).toBe(1);
    expect(body).toContain("## Currently firing\n\n- api / A (warning)\n- api / B (warning)");
  });

  it("prunes nothing on the first poll after start", async () => {
    await poll([alert("A", "f1"), alert("A", "f2")]);
    resetAlertmanagerPollerForTest();
    await poll([]);
    expect(mockBridge.updateInbox).not.toHaveBeenCalled();
    expect(section(only().body, "api / A").status).toBe("firing");
  });

  it("resolves an instance only once two consecutive polls lack it, then closes when every section resolves", async () => {
    await poll([alert("A", "f1"), alert("A", "f2"), alert("B", "f3")]);
    await poll([alert("A", "f1"), alert("B", "f3")]); // f2 missing once: kept
    expect(mockBridge.updateInbox).not.toHaveBeenCalled();
    await poll([alert("A", "f1"), alert("B", "f3")]); // f2 missing twice: pruned
    let body = only().body;
    expect([...section(body, "api / A").instances]).toEqual(["f1"]);
    expect(section(body, "api / A").status).toBe("firing");
    await poll([alert("B", "f3")]);
    await poll([alert("B", "f3")]);
    body = only().body;
    expect(section(body, "api / A").status).toBe("resolved");
    expect(section(body, "api / A").resolved).toMatch(/^2026-11-05T12:05:00Z$/);
    expect(only().state).toBe("open");
    await poll([]);
    expect(only().state).toBe("open");
    await poll([]);
    expect(only().state).toBe("closed");
    expect(section(only().body, "api / B").status).toBe("resolved");
    // The resolved section was reported as a resolve event.
    const lastEvents = mockBridge.routeAlertEvents.mock.calls.at(-1)![1] as { alertname: string; status: string }[];
    expect(lastEvents).toEqual([expect.objectContaining({ alertname: "api / B", status: "resolved" })]);
  });

  it("touches nothing, sets the gauge to 0 and warns on a failed poll, and never prunes across it", async () => {
    await poll([alert("A", "f1")]);
    respond({ message: "bad gateway" }, 502);
    await pollRepo(bridge(), clock);
    expect(mockMetrics.setAlertmanagerPollOk).toHaveBeenLastCalledWith("prod", false);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("Alertmanager poll failed"), expect.objectContaining({ cluster: "prod", http_status: 502 }));
    expect(mockBridge.listOpenInboxes).toHaveBeenCalledTimes(1);
    respond([], 302);
    await pollRepo(bridge(), clock);
    expect(mockMetrics.setAlertmanagerPollOk).toHaveBeenLastCalledWith("prod", false);
    respond("not a list");
    await pollRepo(bridge(), clock);
    expect(vi.mocked(log.warn)).toHaveBeenLastCalledWith(expect.stringContaining("Alertmanager poll failed"), expect.objectContaining({ probe_error: "unparseable" }));
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    await pollRepo(bridge(), clock);
    expect(vi.mocked(log.warn)).toHaveBeenLastCalledWith(expect.stringContaining("Alertmanager poll failed"), expect.objectContaining({ probe_error: "TimeoutError" }));
    // One successful empty poll after the failures only marks f1 missing once.
    await poll([]);
    expect(section(only().body, "api / A").status).toBe("firing");
    expect(mockBridge.updateInbox).not.toHaveBeenCalled();
  });

  it("reopens the newest inbox closed inside the window", async () => {
    await poll([alert("A", "f1")]);
    await poll([]);
    await poll([]);
    expect(only().state).toBe("closed");
    await poll([alert("A", "f9")]);
    const issue = only();
    expect(issue.state).toBe("open");
    const s = section(issue.body, "api / A");
    expect(s.status).toBe("firing");
    expect(s.count).toBe(2);
    expect([...s.instances]).toEqual(["f9"]);
  });

  it("files a new inbox when the last one closed outside the window", async () => {
    issues.push({ id: "clw_old", body: "old", state: "closed", closed_at: "2026-11-03 00:00:00" });
    await poll([alert("A", "f1")]);
    expect(issues).toHaveLength(2);
    expect(issues.find((i) => i.id === "clw_old")!.state).toBe("closed");
    expect(mockBridge.createInbox).toHaveBeenCalledTimes(1);
  });

  it("adds no section for a tracked group and opens no inbox for tracked-only firings", async () => {
    mockBridge.routeAlertEvents.mockImplementation(async (_b: unknown, events: { alertname: string }[]) =>
      Object.fromEntries(events.map((e) => [e.alertname, e.alertname === "api / Tracked" ? { tracked: true, id: "clw_T", state: "open", reopened: false } : { tracked: false }])));
    await poll([alert("Tracked", "t1")]);
    expect(issues).toHaveLength(0);
    await poll([alert("Tracked", "t1"), alert("Other", "o1")]);
    const body = only().body;
    expect(parseBody(body)!.sections.has("api / Tracked")).toBe(false);
    expect(section(body, "api / Other").status).toBe("firing");
  });

  it("marks an existing section Tracked, freezes it and closes once the rest resolve", async () => {
    await poll([alert("A", "f1"), alert("B", "f2")]);
    mockBridge.routeAlertEvents.mockImplementation(async (_b: unknown, events: { alertname: string }[]) =>
      Object.fromEntries(events.map((e) => [e.alertname, e.alertname === "api / A" ? { tracked: true, id: "clw_T", state: "open", reopened: false } : { tracked: false }])));
    await poll([alert("A", "f1"), alert("A", "f5"), alert("B", "f2")]);
    let s = section(only().body, "api / A");
    expect(s.tracked).toBe("#clw_T");
    expect(s.count).toBe(1);
    expect([...s.instances]).toEqual(["f1"]);
    await poll([alert("A", "f1")]);
    await poll([alert("A", "f1")]);
    expect(only().state).toBe("closed");
    s = section(only().body, "api / A");
    expect(s.status).toBe("firing");
  });

  it("clears a transient verdict when the section fires for an instance it did not cover", async () => {
    await poll([alert("A", "f1")]);
    const issue = only();
    issue.body = issue.body.replace("| Resolved | - |", "| Resolved | - |\n| Triage | transient — blip |");
    await poll([alert("A", "f1")]);
    expect(mockBridge.updateInbox).not.toHaveBeenCalled();
    await poll([alert("A", "f1"), alert("A", "f2", {}, { summary: "second instance" })]);
    const s = section(only().body, "api / A");
    expect(s.triage).toBe("");
    expect(s.summary).toBe("second instance");
    expect([...s.seen].sort()).toEqual(["f1", "f2"]);
  });

  it("rebuilds an unparseable inbox from the active alerts and closes it when nothing fires", async () => {
    issues.push({ id: "clw_edit", body: "hand edited\n\n---\n**First seen:** 2026-11-01T00:00:00Z\n**Last seen:** 2026-11-02T00:00:00Z\n**Occurrences:** 7", state: "open", closed_at: null });
    await poll([]);
    const issue = only();
    expect(issue.state).toBe("closed");
    expect(parseBody(issue.body)).toEqual(expect.objectContaining({ firstSeen: "2026-11-01T00:00:00Z", total: 7 }));
  });

  it("ignores Watchdog by default", async () => {
    await poll([alert("Watchdog", "w1", { app: "" })]);
    expect(issues).toHaveLength(0);
    expect(mockBridge.routeAlertEvents).toHaveBeenCalledWith(expect.anything(), [], { dryRun: true });
  });

  it("omits instances on an event for a group of more than 200", async () => {
    await poll(Array.from({ length: 201 }, (_, i) => alert("Many", `f${i}`)));
    const [, events] = mockBridge.routeAlertEvents.mock.calls[0]!;
    expect((events as { instances?: unknown }[])[0]!.instances).toBeUndefined();
  });

  it("writes nothing in shadow mode, routes with dryRun and logs each decision", async () => {
    await poll([alert("A", "f1")], "shadow");
    expect(issues).toHaveLength(0);
    expect(mockBridge.createInbox).not.toHaveBeenCalled();
    expect(mockBridge.routeAlertEvents.mock.calls[0]![2]).toEqual({ dryRun: true });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("would create alert issue"),
      expect.objectContaining({ decision: "create", sections: "api / A", firing: 1, resolved: 0, mode: "shadow", body_length: expect.any(Number) }));

    issues.push({ id: "clw_live", body: "", state: "open", closed_at: null });
    await poll([alert("A", "f1")], "write");
    vi.mocked(log.info).mockClear();
    mockBridge.updateInbox.mockClear();
    await poll([alert("A", "f1"), alert("B", "f2")], "shadow");
    expect(mockBridge.updateInbox).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("would update alert issue"),
      expect.objectContaining({ inbox_issue: "clw_live", sections: "api / B", firing: 2 }));
  });
});

describe("tracking-issue occurrences", () => {
  it("counts a tracking-issue occurrence only for a new instance, never per poll", async () => {
    await poll([alert("A", "f1")]);
    mockBridge.routeAlertEvents.mockClear();
    await poll([alert("A", "f1")]);
    await poll([alert("A", "f1")]);
    expect(mockBridge.routeAlertEvents.mock.calls.every((c) => c[2].dryRun === true)).toBe(true);
    await poll([alert("A", "f1"), alert("A", "f2")]);
    const live = mockBridge.routeAlertEvents.mock.calls.filter((c) => c[2].dryRun === false);
    expect(live).toHaveLength(1);
  });

  it("sends no live firing on the priming poll", async () => {
    await poll([alert("A", "f1")]);
    expect(mockBridge.routeAlertEvents.mock.calls.every((c) => c[2].dryRun === true)).toBe(true);
  });
});

describe("run", () => {
  it("counts a failed reconcile and still polls the next repo", async () => {
    mockRepoConfig.listRepoConfigs.mockReturnValue([
      { fullName: REPO, config: { enabled: true, alertBridge: { label: LABEL, title: TITLE, poll: bridge().poll } } },
      { fullName: "o/second", config: { enabled: true, alertBridge: { label: LABEL, title: TITLE, poll: bridge().poll } } },
    ]);
    mockBridge.listOpenInboxes.mockRejectedValueOnce(new Error("db down"));
    respond([]);
    respond([]);
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("poll finished"), expect.objectContaining({ repos: 2, failed: 1 }));
  });

  it("polls only repos with alertBridge.poll whose job is enabled", async () => {
    mockRepoConfig.listRepoConfigs.mockReturnValue([
      { fullName: REPO, config: { enabled: true, alertBridge: { label: LABEL, title: TITLE, poll: bridge().poll } } },
      { fullName: "o/pushed", config: { enabled: true, alertBridge: { label: LABEL, title: TITLE, tokenSha256: "a".repeat(64) } } },
      { fullName: "o/disabled", config: { enabled: true, alertBridge: { label: LABEL, title: TITLE, poll: bridge().poll } } },
    ]);
    mockConfig.isJobDisabledForRepo.mockImplementation((_job: string, repo: string) => repo === "o/disabled");
    respond([]);
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("poll finished"), expect.objectContaining({ repos: 1, failed: 0 }));
  });
});
