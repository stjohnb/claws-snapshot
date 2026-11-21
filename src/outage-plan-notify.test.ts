import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), {
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  ATTACHMENTS_S3: null,
  DASHBOARD_URL: "https://claws.example",
  getAutoPromotePolicy: () => ({}),
  isAgentDisabled: () => false,
  isJobDisabledForRepo: () => false,
}));

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  runContext: { getStore: () => undefined, run: (_ctx: unknown, fn: () => unknown) => fn() },
}));

const { mockSlack } = vi.hoisted(() => ({
  mockSlack: { notify: vi.fn(async (_text: string) => undefined), notifyProdAlert: vi.fn(async (_text: string) => undefined) },
}));
vi.mock("./slack.js", () => mockSlack);
vi.mock("./github.js", () => ({ listRepos: vi.fn(async () => []), hasPriorityLabel: () => false }));
vi.mock("./worker.js", () => ({ enqueue: vi.fn(), AGENT_KINDS: { ISSUE_REFINER_REPLAN: "work:issue-refiner:replan" } }));
vi.mock("./grafana-jwt.js", () => ({ grafanaUrl: () => "https://grafana.example" }));
vi.mock("./grafana-auth.js", () => ({ grafanaAuthorization: () => "Basic eDp5" }));

import * as log from "./log.js";
import * as db from "./db.js";
import { alertGroupKey } from "./alert-issue.js";
import { pollRepo, resetAlertmanagerPollerForTest, type AlertmanagerAlert } from "./jobs/alertmanager-poller.js";
import type { PolledBridge } from "./alert-bridge.js";
import { isDownSignal, planHeadline } from "./outage-plan-notify.js";

const REPO = "St-John-Software/production-infra";
const PLAN = "## Implementation Plan\n\n### What changes\n- Raise   bonkus's memory limit so it stops crashing.\n- Second line.\n\n### Requirement\nIt stays up.";

let fetchMock: ReturnType<typeof vi.fn>;
let clock: Date;

function bridge(opts: { mode?: "shadow" | "write" | "direct"; downNotify?: Partial<PolledBridge["downNotify"]> } = {}): PolledBridge {
  return {
    label: "alert", title: "[Alert] production-infra alerts firing", repo: REPO,
    downNotify: { alertnames: [], windowMinutes: 360, channel: "home", ...opts.downNotify },
    poll: { cluster: "fleet", datasourceUid: "alertmanager", mode: opts.mode ?? "direct", source: "alertmanager", maxNewIssuesPerPoll: 3, ignoreAlertnames: [] },
  };
}

function alert(alertname: string, fingerprint: string, severity = "warning", app = "bonkus"): AlertmanagerAlert {
  return {
    labels: { alertname, severity, app },
    annotations: { summary: `${alertname} summary`, description: `${alertname} description` },
    startsAt: "2026-11-20T07:00:00Z",
    fingerprint,
  };
}

async function poll(alerts: AlertmanagerAlert[], b: PolledBridge = bridge(), minutes = 1): Promise<void> {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(alerts), { status: 200 }));
  clock = new Date(clock.getTime() + minutes * 60_000);
  await pollRepo(b, clock);
}

async function issueFor(name: string): Promise<db.ClawsIssueRecord> {
  const [issue] = await db.listOpenClawsIssuesByDedupeKey(alertGroupKey(name));
  expect(issue).toBeDefined();
  return issue!;
}

let planVersion = 0;
async function storePlan(id: string, body = PLAN): Promise<void> {
  planVersion += 1;
  await db._rawDb().run(
    `INSERT INTO claws_issue_plans (issue_id, version, comment_id, body, created_at) VALUES (?, ?, NULL, ?, '2026-11-20 07:01:00')`,
    [id, planVersion, body],
  );
  await db.setClawsIssueLifecycle(id, "awaiting-plan-review");
}

const sent = () => [...mockSlack.notify.mock.calls, ...mockSlack.notifyProdAlert.mock.calls].map(([text]) => text);

beforeEach(async () => {
  vi.clearAllMocks();
  resetAlertmanagerPollerForTest();
  planVersion = 0;
  clock = new Date("2026-11-20T07:00:00Z");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await db.initDb();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.closeDb();
});

describe("isDownSignal", () => {
  it("matches the built-in names, a configured name and critical, exactly", () => {
    expect(isDownSignal({ name: "bonkus / TargetDown", critical: false })).toBe(true);
    expect(isDownSignal({ name: "KubePodCrashLooping", critical: false })).toBe(true);
    expect(isDownSignal({ name: "bonkus / KubeDeploymentReplicasMismatch", critical: false })).toBe(true);
    expect(isDownSignal({ name: "bonkus / targetdown", critical: false })).toBe(false);
    expect(isDownSignal({ name: "bonkus / ContainerRestarting", critical: false })).toBe(false);
    expect(isDownSignal({ name: "bonkus / ContainerRestarting", critical: true })).toBe(true);
    expect(isDownSignal({ name: "bonkus / BonkusDown", critical: false }, ["BonkusDown"])).toBe(true);
  });
});

describe("planHeadline", () => {
  it("quotes the What changes section's first line, marker stripped and whitespace collapsed", () => {
    expect(planHeadline(PLAN)).toBe("Raise bonkus's memory limit so it stops crashing.");
  });

  it("cuts a long line to 300 characters and falls back when there is no section", () => {
    expect(planHeadline(`### What changes\n${"x".repeat(400)}`)).toHaveLength(300);
    expect(planHeadline("### Requirement\nSomething.")).toBe("see the plan");
  });
});

describe("down-service page", () => {
  it("pages once with the issue URL when a TargetDown issue gets a plan awaiting review", async () => {
    await poll([alert("TargetDown", "f1")]);
    const issue = await issueFor("bonkus / TargetDown");
    expect(sent()).toEqual([]);
    await storePlan(issue.id);

    await poll([alert("TargetDown", "f1"), alert("KubePodCrashLooping", "f2")]);

    expect(mockSlack.notify).toHaveBeenCalledTimes(1);
    expect(mockSlack.notifyProdAlert).not.toHaveBeenCalled();
    expect(sent()[0]).toBe([
      `:rotating_light: [fleet] bonkus is down and a fix plan is waiting for you: ${issue.title} https://claws.example/issues/${issue.id}`,
      "Down alerts: TargetDown, KubePodCrashLooping",
      "Plan: Raise bonkus's memory limit so it stops crashing.",
      "Stops at: plan review. Review and approve the plan to ship it.",
    ].join("\n"));
    expect(log.info).toHaveBeenCalledWith("outage plan notification sent", {
      issue: issue.id, bridge_repo: REPO, service: "bonkus", alerts: "TargetDown, KubePodCrashLooping", channel: "home",
    });
  });

  it("pages when the plan came first on a warning-only issue and the service then goes down", async () => {
    await poll([alert("ContainerRestarting", "f1")]);
    const issue = await issueFor("bonkus / ContainerRestarting");
    await storePlan(issue.id);
    await poll([alert("ContainerRestarting", "f1")]);
    expect(sent()).toEqual([]);

    await poll([alert("ContainerRestarting", "f1"), alert("TargetDown", "f2")]);

    const pages = sent().filter((t) => t.includes(`/issues/${issue.id}`));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("Down alerts: TargetDown");
  });

  it("sends nothing for a warning-only ContainerRestarting", async () => {
    await poll([alert("ContainerRestarting", "f1")]);
    await storePlan((await issueFor("bonkus / ContainerRestarting")).id);
    await poll([alert("ContainerRestarting", "f1")]);
    await poll([alert("ContainerRestarting", "f1")]);
    expect(sent()).toEqual([]);
  });

  it("does not repeat inside the window, even after a re-plan, and pages again after it", async () => {
    await poll([alert("TargetDown", "f1")]);
    const issue = await issueFor("bonkus / TargetDown");
    await storePlan(issue.id);
    await poll([alert("TargetDown", "f1")]);
    expect(sent()).toHaveLength(1);

    await poll([alert("TargetDown", "f1")]);
    await storePlan(issue.id, PLAN.replace("Raise", "Lower"));
    await poll([alert("TargetDown", "f1")], bridge(), 60);
    expect(sent()).toHaveLength(1);

    await poll([alert("TargetDown", "f1")], bridge(), 360);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toContain("Plan: Lower bonkus's memory limit");
  });

  it("pages for a critical group and for a configured extra alertname, on the configured channel", async () => {
    await poll([alert("HighLatency", "f1", "critical", "api")]);
    const critical = await issueFor("api / HighLatency");
    await storePlan(critical.id);
    await poll([alert("HighLatency", "f1", "critical", "api")]);
    expect(mockSlack.notify).toHaveBeenCalledTimes(1);
    expect(sent()[0]).toContain(`/issues/${critical.id}`);

    const extra = bridge({ downNotify: { alertnames: ["BonkusDown"], channel: "prod" } });
    await poll([alert("BonkusDown", "f2")], extra);
    const configured = await issueFor("bonkus / BonkusDown");
    await storePlan(configured.id);
    await poll([alert("BonkusDown", "f2")], extra);
    expect(mockSlack.notifyProdAlert).toHaveBeenCalledTimes(1);
    expect(mockSlack.notifyProdAlert.mock.calls[0]![0]).toMatch(/^:rotating_light: \[prod\] bonkus is down/);
  });

  it("sends nothing for an issue approved through Plan, one still planning, or in shadow mode", async () => {
    await poll([alert("TargetDown", "f1"), alert("KubePodCrashLooping", "f2", "warning", "api"), alert("TargetDown", "f3", "warning", "web")]);
    const approved = await issueFor("bonkus / TargetDown");
    await storePlan(approved.id);
    await db.setClawsIssueApprovedThrough(approved.id, "plan", "operator");
    await db.setClawsIssueLifecycle(approved.id, "awaiting-plan-review");
    const planning = await issueFor("api / KubePodCrashLooping");
    await db.setClawsIssueLifecycle(planning.id, "planning");
    const shadowed = await issueFor("web / TargetDown");
    await storePlan(shadowed.id);

    await poll([alert("TargetDown", "f1"), alert("KubePodCrashLooping", "f2", "warning", "api")]);
    await poll([alert("TargetDown", "f3", "warning", "web")], bridge({ mode: "shadow" }));

    expect(sent()).toEqual([]);
    expect(log.info).toHaveBeenCalledWith("would send outage plan notification", expect.objectContaining({ issue: shadowed.id, service: "web" }));
    expect((await db.getClawsIssue(shadowed.id))!.alert_attention_notified_at ?? null).toBeNull();
  });

  it("sends nothing on a failed poll", async () => {
    await poll([alert("TargetDown", "f1")]);
    await storePlan((await issueFor("bonkus / TargetDown")).id);
    fetchMock.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    await pollRepo(bridge(), new Date(clock.getTime() + 60_000));
    expect(sent()).toEqual([]);
  });
});
