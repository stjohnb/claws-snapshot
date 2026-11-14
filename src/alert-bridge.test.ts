import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockGh, mockClawsIssues, mockWorker, mockIsAgentDisabled, mockDb, mockMetrics, actors } = vi.hoisted(() => ({
  mockDb: { addClawsIssueDedupeKey: vi.fn() },
  mockMetrics: { recordAlertIssueFiled: vi.fn(), recordAlertFilingCapped: vi.fn(), recordDedupeKeyMoves: vi.fn() },
  mockGh: {
    listRepos: vi.fn(),
    hasPriorityLabel: vi.fn((labels: { name: string }[]) => labels.some((l) => l.name === "Priority")),
  },
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    toIso: (stored: string) => `${stored.replace(" ", "T")}.000Z`,
    primaryRepo: vi.fn((issue: { repos: readonly string[] }) => [...issue.repos].sort()[0] ?? ""),
    createIssue: vi.fn(),
    editIssue: vi.fn(),
    setLifecycle: vi.fn(),
    findOpenIssueByDedupeKey: vi.fn(),
    findRecentlyClosedIssueByDedupeKey: vi.fn(),
    commentOnIssue: vi.fn(),
    listCommentDetails: vi.fn(),
    listOpenIssuesTouching: vi.fn(),
  },
  mockWorker: {
    enqueue: vi.fn(),
    AGENT_KINDS: { ISSUE_REFINER_REPLAN: "work:issue-refiner:replan" },
  },
  mockIsAgentDisabled: vi.fn(() => false),
  actors: [] as unknown[],
}));

vi.mock("./github.js", () => mockGh);
vi.mock("./db.js", () => mockDb);
vi.mock("./metrics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./metrics.js")>()),
  ...mockMetrics,
}));
vi.mock("./claws-issues.js", () => mockClawsIssues);
vi.mock("./worker.js", () => mockWorker);
vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  isAgentDisabled: mockIsAgentDisabled,
}));

import { currentIssueActor, withIssueActor } from "./issue-history-actor.js";
import { clearRepoConfigCache, refreshRepoConfigs } from "./repo-config.js";
import * as log from "./log.js";
import {
  fileAlertIssue,
  routeDirectAlerts,
  type DirectAlertGroup,
  type PolledBridge,
  requeueReopenedIssue,
  resolveAlertIssue,
} from "./alert-bridge.js";
import { alertGroupKey } from "./alert-issue.js";

const REPO = "St-John-Software/production-infra";
const OTHER = "St-John-Software/fleet-infra";
const TITLE = "[Alert] production-infra alerts firing";
const LABEL = "alert";
const DAY_MS = 24 * 60 * 60 * 1000;

function record(overrides: Record<string, unknown> = {}) {
  const merged = {
    id: "clw_01ALERT",
    title: TITLE,
    body: "## Currently firing\n\n## Alerts\n",
    state: "open",
    state_reason: null,
    filed_title: null,
    closed_at: null,
    labels: [LABEL],
    repos: [REPO],
    kind: "issue",
    lifecycle: "approved",
    author_login: "claws",
    created_at: "2026-10-01 00:00:00",
    updated_at: "2026-10-01 00:00:00",
    ...overrides,
  } as Record<string, unknown>;
  // A record's `dedupe_keys` follow its `dedupe_key` unless the test names them.
  const key = merged["dedupe_key"];
  return { ...merged, dedupe_keys: merged["dedupe_keys"] ?? (typeof key === "string" ? [key] : []) } as any;
}

const POLL = { cluster: "prod", mode: "direct" };

beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  actors.length = 0;
  clearRepoConfigCache();
  await refreshRepoConfigs([{ fullName: REPO }, { fullName: OTHER }, { fullName: "St-John-Software/plain" }], async (fullName) => {
    if (fullName === REPO) return JSON.stringify({ alertBridge: { label: LABEL, title: TITLE, poll: POLL } });
    if (fullName === OTHER) return JSON.stringify({ alertBridge: { label: "grafana-alert", title: "[Alert] Grafana alerts firing", poll: { ...POLL, cluster: "fleet" } } });
    return "{}";
  });
  mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
  mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(undefined);
  mockClawsIssues.listCommentDetails.mockResolvedValue([]);
  mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([]);
  mockGh.listRepos.mockResolvedValue([]);
  mockDb.addClawsIssueDedupeKey.mockResolvedValue(true);
  mockClawsIssues.primaryRepo.mockImplementation((issue: { repos: readonly string[] }) => [...issue.repos].sort()[0] ?? "");
  mockIsAgentDisabled.mockReturnValue(false);
  mockClawsIssues.editIssue.mockImplementation(async () => { actors.push(currentIssueActor()); });
});

describe("requeueReopenedIssue", () => {
  it("plans in the issue's primary repo", async () => {
    const queued = await requeueReopenedIssue(record({ repos: ["Aa/first", REPO] }) as never, REPO);
    expect(queued).toBe(true);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("Aa/first", "clw_01ALERT", "planning");
    expect(mockWorker.enqueue).toHaveBeenCalledWith("work:issue-refiner:replan", "Aa/first", "clw_01ALERT", { priority: false });
  });

  it.each([
    ["ideas", { lifecycle: "ideas" }],
    ["backlog", { lifecycle: "backlog" }],
    ["blocked non-alert", { lifecycle: "blocked", labels: ["bug"], body: "plain" }],
  ])("leaves a %s issue alone", async (_name, overrides) => {
    expect(await requeueReopenedIssue(record(overrides) as never, REPO)).toBe(false);
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  it("re-plans a blocked alert issue: Blocked is not a hold for alert issues", async () => {
    expect(await requeueReopenedIssue(record({ lifecycle: "blocked" }) as never, REPO)).toBe(true);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, "clw_01ALERT", "planning");
  });

  it("moves to planning but queues nothing while the planner is disabled", async () => {
    mockIsAgentDisabled.mockReturnValue(true);
    expect(await requeueReopenedIssue(record() as never, REPO)).toBe(false);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalled();
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });
});

describe("resolveAlertIssue", () => {
  const dedicated = (overrides: Record<string, unknown> = {}) =>
    record({ id: "clw_01DEDICATED", title: "KubeJobFailed in prod", body: "The migration Job failed.", dedupe_key: "alert-kubejobfailed", labels: [], ...overrides });

  it("prefers the open issue holding the alert's key, case-insensitively on the repo", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(dedicated());
    expect(await resolveAlertIssue(REPO.toLowerCase(), "KubeJobFailed")).toBe("clw_01DEDICATED");
    expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith(REPO, "alert-kubejobfailed");
  });

  it("tries the group key, then the bare alert's key", async () => {
    const group = dedicated({ id: "clw_01GROUP", dedupe_key: alertGroupKey("api / KubeJobFailed") });
    mockClawsIssues.findOpenIssueByDedupeKey.mockImplementation(async (_repo: string, key: string) => (key === group.dedupe_key ? group : undefined));
    expect(await resolveAlertIssue(REPO, "api / KubeJobFailed")).toBe("clw_01GROUP");
    mockClawsIssues.findOpenIssueByDedupeKey.mockImplementation(async (_repo: string, key: string) => (key === "alert-kubejobfailed" ? dedicated() : undefined));
    expect(await resolveAlertIssue(REPO, "api / KubeJobFailed")).toBe("clw_01DEDICATED");
    expect(mockClawsIssues.findOpenIssueByDedupeKey.mock.calls.slice(-2).map((c) => c[1])).toEqual(["alert-group-api.kubejobfailed", "alert-kubejobfailed"]);
  });

  it("never answers a legacy inbox holding the key", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(record({ id: "clw_01INBOX", dedupe_key: "alert-kubejobfailed" }));
    expect(await resolveAlertIssue(REPO, "KubeJobFailed")).toBeNull();
  });

  it("then the oldest open alert- keyed issue whose Alerts line lists the bare alertname", async () => {
    const block = "\n\n---\n**Alerts:** KubeJobFailed, Other\n**First seen:** 2026-10-01T00:00:00Z\n**Last seen:** 2026-10-01T00:00:00Z\n**Occurrences:** 1";
    mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([
      dedicated({ id: "clw_03UNLISTED", dedupe_key: "alert-group-api.other", body: "x\n\n---\n**Alerts:** Other\n**First seen:** a\n**Last seen:** b\n**Occurrences:** 1" }),
      dedicated({ id: "clw_02LISTED", dedupe_key: "alert-group-db.kubejobfailed", body: `x${block}` }),
      dedicated({ id: "clw_01OTHERREPO", dedupe_key: "alert-group-api.kubejobfailed", body: `x${block}`, repos: [OTHER] }),
      dedicated({ id: "clw_01UNKEYED", dedupe_key: null, body: `x${block}` }),
    ]);
    expect(await resolveAlertIssue(REPO, "KubeJobFailed")).toBe("clw_02LISTED");
  });

  it("then an issue holding the key closed within 14 days", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(dedicated({ state: "closed", closed_at: "2026-10-20 00:00:00" }));
    const before = Date.now();
    expect(await resolveAlertIssue(REPO, "KubeJobFailed")).toBe("clw_01DEDICATED");
    const [repo, key, since] = mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mock.calls[0]!;
    expect([repo, key]).toEqual([REPO, "alert-kubejobfailed"]);
    expect(before - (since as Date).getTime()).toBeGreaterThanOrEqual(14 * DAY_MS - 1000);
  });

  it("is null for an empty alertname, with nothing to show, or for a repo without an alertBridge", async () => {
    expect(await resolveAlertIssue(REPO, "  ")).toBeNull();
    expect(mockClawsIssues.findOpenIssueByDedupeKey).not.toHaveBeenCalled();
    expect(await resolveAlertIssue(REPO, "KubeJobFailed")).toBeNull();
    expect(await resolveAlertIssue("St-John-Software/plain", "KubeJobFailed")).toBeNull();
    expect(await resolveAlertIssue("Someone/else", "KubeJobFailed")).toBeNull();
  });
});

describe("direct filing", () => {
  const NOW = "2026-11-05T12:00:00Z";
  const OWNER = "St-John-Software/api";
  const polled = (overrides: Record<string, unknown> = {}): PolledBridge => ({
    label: LABEL, title: TITLE, repo: REPO, serviceRepos: { api: [OWNER, "St-John-Software/unmanaged"] },
    poll: { cluster: "prod", datasourceUid: "alertmanager", mode: "direct", source: "alertmanager", maxNewIssuesPerPoll: 3, ignoreAlertnames: [], ...overrides },
  });
  const group = (name: string, overrides: Partial<DirectAlertGroup> = {}): DirectAlertGroup => ({
    name, severity: "critical", summary: `${name} summary`, description: `${name} description`, dashboard: "https://grafana.example/d/x",
    source: "http://prometheus/graph", startsAt: "2026-11-05T09:00:00.123Z",
    instances: [{ key: "f1", startsAt: "2026-11-05T09:00:00.123Z" }], fresh: true, ...overrides,
  });
  const block = (alerts: string, count = 2) =>
    `Body\n\n---\n**Alerts:** ${alerts}\n**First seen:** 2026-11-01T00:00:00Z\n**Last seen:** 2026-11-02T00:00:00Z\n**Occurrences:** ${count}`;
  const holder = (overrides: Record<string, unknown> = {}) =>
    record({ id: "clw_01HOLDER", title: "[Alert] api / HighLatency", labels: [], dedupe_key: "alert-group-api.highlatency", body: block("HighLatency"), ...overrides });
  const byKey = (open: Record<string, unknown>, closed: Record<string, unknown> = {}) => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockImplementation(async (_repo: string, key: string) => open[key]);
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockImplementation(async (_repo: string, key: string) => closed[key]);
  };

  beforeEach(() => {
    mockGh.listRepos.mockResolvedValue([{ fullName: OWNER }, { fullName: REPO }]);
    let n = 0;
    mockClawsIssues.createIssue.mockImplementation(async () => `clw_NEW${++n}`);
  });

  it("files a dedicated issue per group none holds, keyed exactly, with the evidence", async () => {
    const outcomes = await routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW });
    expect(outcomes).toEqual([{ group: "api / HighLatency", key: "alert-group-api.highlatency", decision: "file", issue: "clw_NEW1" }]);
    const input = mockClawsIssues.createIssue.mock.calls[0]![0];
    expect(input).toEqual(expect.objectContaining({
      title: "[Alert] api / HighLatency", authorLogin: "claws", repos: [REPO, OWNER], primaryRepo: REPO,
      source: "automation", autoPromote: true, dedupeKey: "alert-group-api.highlatency", alertKind: "alert-bridge",
    }));
    expect(input.labels).toBeUndefined();
    expect(input.body).toContain("| Severity | critical |");
    expect(input.body).toContain("| Key | `alert-group-api.highlatency` |");
    expect(input.body).toContain("| Source | http://prometheus/graph |");
    expect(input.body).toContain("| Dashboard | https://grafana.example/d/x |");
    expect(input.body).toContain("**Summary:** api / HighLatency summary");
    expect(input.body).toContain("**Description:** api / HighLatency description");
    expect(input.body).toMatch(/\*\*Alerts:\*\* HighLatency\n\*\*First seen:\*\* 2026-11-05T09:00:00Z\n\*\*Last seen:\*\* 2026-11-05T12:00:00Z\n\*\*Occurrences:\*\* 1$/);
    expect(input.body).not.toContain("Previous issue");
    expect(mockMetrics.recordAlertIssueFiled).toHaveBeenCalledWith("prod");
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("filed alert issue"), expect.objectContaining({
      bridge_repo: REPO, cluster: "prod", mode: "direct", group: "api / HighLatency", key: "alert-group-api.highlatency", issue: "clw_NEW1",
    }));
  });

  it("files even on a group that is not fresh, such as the first poll after a restart", async () => {
    await routeDirectAlerts(polled(), [group("KubeJobFailed", { fresh: false })], { dryRun: false, now: NOW });
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "alert-kubejobfailed", repos: [REPO] }));
  });

  it("bumps the open holder and records the alert only for a fresh instance", async () => {
    byKey({ "alert-group-api.highlatency": holder({ body: block("Other") }) });
    expect((await routeDirectAlerts(polled(), [group("api / HighLatency", { fresh: false })], { dryRun: false, now: NOW }))[0]!.decision).toBe("none");
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    const [outcome] = await routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW });
    expect(outcome).toEqual(expect.objectContaining({ decision: "bump", issue: "clw_01HOLDER" }));
    const [id, body] = mockClawsIssues.editIssue.mock.calls[0]!;
    expect(id).toBe("clw_01HOLDER");
    expect(body).toMatch(/\*\*Alerts:\*\* HighLatency, Other\n\*\*First seen:\*\* 2026-11-01T00:00:00Z\n\*\*Last seen:\*\* 2026-11-05T12:00:00Z\n\*\*Occurrences:\*\* 3$/);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("bumped alert issue"), expect.objectContaining({ issue: "clw_01HOLDER", key: "alert-group-api.highlatency" }));
  });

  it("never treats an inbox holding the key as its holder", async () => {
    byKey({ "alert-group-api.highlatency": record({ id: "clw_01INBOX", dedupe_key: "alert-group-api.highlatency" }) });
    expect((await routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW }))[0]!.decision).toBe("file");
  });

  it("adopts an open per-service issue whose Alerts line lists the alert, adding the group key", async () => {
    const legacy = holder({ id: "clw_01LEGACY", dedupe_key: "alert-service-api", body: block("HighLatency") });
    byKey({ "alert-service-api": legacy });
    const [outcome] = await routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW });
    expect(outcome).toEqual(expect.objectContaining({ decision: "bump", issue: "clw_01LEGACY" }));
    expect(mockDb.addClawsIssueDedupeKey).toHaveBeenCalledWith("clw_01LEGACY", "alert-group-api.highlatency");
    expect(mockMetrics.recordDedupeKeyMoves).toHaveBeenCalledWith("adopt", 1);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("adopted alert issue"), expect.objectContaining({ issue: "clw_01LEGACY" }));
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("does not adopt a per-service issue that never listed the alert: the group files its own", async () => {
    byKey({ "alert-service-api": holder({ id: "clw_01LEGACY", dedupe_key: "alert-service-api", body: block("Other") }) });
    expect((await routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW }))[0]!.decision).toBe("file");
    expect(mockDb.addClawsIssueDedupeKey).not.toHaveBeenCalled();
  });

  it("counts a pre-close re-notification on the closed holder, comments once and files nothing", async () => {
    const closed = holder({ state: "closed", closed_at: "2026-11-05 10:00:00" });
    byKey({}, { "alert-group-api.highlatency": closed });
    const [outcome] = await routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW });
    expect(outcome).toEqual(expect.objectContaining({ decision: "pre-close", issue: "clw_01HOLDER" }));
    expect(mockClawsIssues.editIssue).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith(REPO, "clw_01HOLDER", expect.stringContaining("began before this issue closed"), "claws");
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    vi.clearAllMocks();
    await routeDirectAlerts(polled(), [group("api / HighLatency", { fresh: false })], { dryRun: false, now: NOW });
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
  });

  it("files a new issue citing the closed holder for an instance that began after the close", async () => {
    byKey({}, { "alert-group-api.highlatency": holder({ state: "closed", closed_at: "2026-11-05 08:00:00" }) });
    const [outcome] = await routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW });
    expect(outcome!.decision).toBe("file");
    expect(mockClawsIssues.createIssue.mock.calls[0]![0].body).toContain("| Previous issue | #clw_01HOLDER (closed 2026-11-05T08:00:00Z) |");
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("filed alert issue"), expect.objectContaining({ previous_issue: "clw_01HOLDER" }));
  });

  it("caps new issues per poll, defers the rest with one warn and counts the cap", async () => {
    const names = ["a / A", "b / B", "c / C", "d / D", "e / E"];
    const outcomes = await routeDirectAlerts(polled({ maxNewIssuesPerPoll: 2 }), names.map((n) => group(n)), { dryRun: false, now: NOW });
    expect(outcomes.map((o) => o.decision)).toEqual(["file", "file", "deferred", "deferred", "deferred"]);
    expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(2);
    expect(mockMetrics.recordAlertFilingCapped).toHaveBeenCalledTimes(1);
    expect(mockMetrics.recordAlertFilingCapped).toHaveBeenCalledWith("prod");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("alert filing capped"), expect.objectContaining({ deferred: "c / C, d / D, e / E", cap: 2 }));
  });

  it("writes nothing in a dry run and logs what it would do", async () => {
    const legacy = holder({ id: "clw_01LEGACY", dedupe_key: "alert-service-api", body: block("HighLatency") });
    byKey({ "alert-service-api": legacy }, { "alert-group-db.down": holder({ id: "clw_01CLOSED", state: "closed", closed_at: "2026-11-05 10:00:00" }) });
    const groups = [group("api / HighLatency"), group("db / Down"), group("x / New"), group("y / New"), group("z / New")];
    const outcomes = await routeDirectAlerts(polled({ mode: "shadow", maxNewIssuesPerPoll: 2 }), groups, { dryRun: true, now: NOW });
    expect(outcomes.map((o) => o.decision)).toEqual(["bump", "pre-close", "file", "file", "deferred"]);
    for (const fn of [mockClawsIssues.createIssue, mockClawsIssues.editIssue, mockClawsIssues.commentOnIssue, mockDb.addClawsIssueDedupeKey,
      mockMetrics.recordAlertIssueFiled, mockMetrics.recordAlertFilingCapped, mockMetrics.recordDedupeKeyMoves, vi.mocked(log.warn)]) {
      expect(fn).not.toHaveBeenCalled();
    }
    const messages = vi.mocked(log.info).mock.calls.map(([msg]) => String(msg));
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining("would adopt alert issue"),
      expect.stringContaining("would bump alert issue"),
      expect.stringContaining("would file alert issue"),
      expect.stringContaining("would cap alert filing"),
    ]));
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("would file alert issue"), expect.objectContaining({ mode: "shadow", group: "x / New", key: "alert-group-x.new" }));
  });

  it("fileAlertIssue skips a mapped repo Claws does not manage", async () => {
    await fileAlertIssue(polled(), group("api / X"), "alert-group-api.x", NOW);
    expect(mockClawsIssues.createIssue.mock.calls[0]![0].repos).toEqual([REPO, OWNER]);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("does not manage"), expect.objectContaining({ owner: "St-John-Software/unmanaged" }));
  });

  it("comments again on a pre-close firing only when no marker comment follows this close, and writes as the poller", async () => {
    const closed = holder({ state: "closed", closed_at: "2026-11-05 10:00:00" });
    byKey({}, { "alert-group-api.highlatency": closed });
    mockClawsIssues.listCommentDetails.mockResolvedValue([
      { id: "c1", body: "… began before this issue closed …", author: { login: "claws" }, createdAt: "2026-11-05T10:00:01.000Z" },
    ]);
    const poller = { kind: "automation", name: "alertmanager poller" } as const;
    await withIssueActor(poller, () => routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW }));
    expect(mockClawsIssues.editIssue).toHaveBeenCalledTimes(1);
    expect(actors).toEqual([poller]);
    expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
    mockClawsIssues.listCommentDetails.mockResolvedValue([
      { id: "c0", body: "… began before this issue closed …", author: { login: "claws" }, createdAt: "2026-11-01T00:00:00.000Z" },
    ]);
    await routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW });
    expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledTimes(1);
  });

  it("looks a closed holder up over the 14-day lookback only", async () => {
    await routeDirectAlerts(polled(), [group("api / HighLatency")], { dryRun: false, now: NOW });
    const [repo, key, since] = mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mock.calls[0]!;
    expect([repo, key]).toEqual([REPO, "alert-group-api.highlatency"]);
    expect(Date.parse(NOW) - (since as Date).getTime()).toBe(14 * DAY_MS);
  });

  it("files a group that a pre-close instance shares with a later one", async () => {
    byKey({}, { "alert-group-api.highlatency": holder({ state: "closed", closed_at: "2026-11-05 10:00:00" }) });
    const instances = [{ key: "old", startsAt: "2026-11-05T09:00:00Z" }, { key: "new", startsAt: "2026-11-05T11:00:00Z" }];
    expect((await routeDirectAlerts(polled(), [group("api / HighLatency", { instances })], { dryRun: false, now: NOW }))[0]!.decision).toBe("file");
  });
});
