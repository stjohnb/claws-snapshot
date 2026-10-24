import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { Hono } from "hono";

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockGh, mockClawsIssues, mockWorker, mockResolveImportedRef, mockImportRepo, mockIsAgentDisabled, actors } = vi.hoisted(() => ({
  mockGh: {
    isNativeIssue: vi.fn((ref: unknown) => typeof ref === "string" && ref.toLowerCase().startsWith("clw_")),
    listOpenIssues: vi.fn(),
    fetchRepoFileContent: vi.fn(),
    closeIssue: vi.fn(),
    hasPriorityLabel: vi.fn((labels: { name: string }[]) => labels.some((l) => l.name === "Priority")),
  },
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    toIso: (stored: string) => `${stored.replace(" ", "T")}.000Z`,
    primaryRepo: vi.fn((repos: readonly string[]) => [...repos].sort()[0] ?? ""),
    listIssuesByLabel: vi.fn(),
    listClosedIssuesSince: vi.fn(),
    getIssue: vi.fn(),
    createIssue: vi.fn(),
    editIssue: vi.fn(),
    closeIssue: vi.fn(),
    reopenIssue: vi.fn(),
    setLifecycle: vi.fn(),
    findOpenIssueByDedupeKey: vi.fn(),
    findRecentlyClosedIssueByDedupeKey: vi.fn(),
    commentOnIssue: vi.fn(),
  },
  mockWorker: {
    enqueue: vi.fn(),
    AGENT_KINDS: { ISSUE_REFINER_REPLAN: "work:issue-refiner:replan" },
  },
  mockResolveImportedRef: vi.fn(),
  mockImportRepo: vi.fn(),
  mockIsAgentDisabled: vi.fn(() => false),
  actors: [] as unknown[],
}));

vi.mock("./github.js", () => mockGh);
vi.mock("./db.js", () => ({}));
vi.mock("./claws-issues.js", () => mockClawsIssues);
vi.mock("./worker.js", () => mockWorker);
vi.mock("./imported-refs.js", () => ({ resolveImportedRef: mockResolveImportedRef }));
vi.mock("./jobs/issue-importer.js", () => ({ importRepo: mockImportRepo }));
vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  isAgentDisabled: mockIsAgentDisabled,
}));

import * as config from "./config.js";
import { currentIssueActor } from "./issue-history-actor.js";
import { clearRepoConfigCache, refreshRepoConfigs } from "./repo-config.js";
import {
  alertBridgeAuthMiddleware,
  alertEventsHandler,
  createBridgeIssueHandler,
  listBridgeIssuesHandler,
  requeueReopenedIssue,
  resetAlertBridgeCutoverForTest,
  updateBridgeIssueHandler,
  MAX_ALERT_EVENTS,
  MAX_ALERT_FIELD_LENGTH,
  MAX_BODY_LENGTH,
} from "./alert-bridge.js";
import { ALERT_BRIDGE_FOOTER } from "./alert-issue.js";

const REPO = "St-John-Software/production-infra";
const OTHER = "St-John-Software/fleet-infra";
const TITLE = "[Alert] production-infra alerts firing";
const LABEL = "alert";
const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// Mirrors server.ts's registration.
const app = new Hono();
app.get("/api/alert-bridge/:owner/:name/issues", alertBridgeAuthMiddleware, listBridgeIssuesHandler);
app.post("/api/alert-bridge/:owner/:name/issues", alertBridgeAuthMiddleware, createBridgeIssueHandler);
app.patch("/api/alert-bridge/:owner/:name/issues/:id", alertBridgeAuthMiddleware, updateBridgeIssueHandler);
app.post("/api/alert-bridge/:owner/:name/alerts/events", alertBridgeAuthMiddleware, alertEventsHandler);

function call(method: string, path: string, opts: { token?: string | null; body?: unknown; repo?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request(`/api/alert-bridge/${opts.repo ?? REPO}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
}

function record(overrides: Record<string, unknown> = {}) {
  return {
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
  };
}

function forgeIssue(number: number | string, overrides: Record<string, unknown> = {}) {
  return { number, title: TITLE, body: "b", labels: [{ name: LABEL }], author: { login: "bot" }, ...overrides };
}

function seededConfig(fullName: string): string {
  if (fullName === REPO) return JSON.stringify({ alertBridge: { label: LABEL, title: TITLE, tokenSha256: sha(TOKEN) } });
  if (fullName === OTHER) return JSON.stringify({ alertBridge: { label: "grafana-alert", title: "[Alert] Grafana alerts firing", tokenSha256: sha(OTHER_TOKEN) } });
  return "{}";
}

beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  actors.length = 0;
  resetAlertBridgeCutoverForTest();
  clearRepoConfigCache();
  await refreshRepoConfigs([{ fullName: REPO }, { fullName: OTHER }, { fullName: "St-John-Software/plain" }], async (fullName) => {
    if (fullName === REPO) return JSON.stringify({ alertBridge: { label: LABEL, title: TITLE, tokenSha256: sha(TOKEN) } });
    if (fullName === OTHER) return JSON.stringify({ alertBridge: { label: "grafana-alert", title: "[Alert] Grafana alerts firing", tokenSha256: sha(OTHER_TOKEN) } });
    return "{}";
  });
  mockGh.isNativeIssue.mockImplementation((ref: unknown) => typeof ref === "string" && ref.toLowerCase().startsWith("clw_"));
  mockGh.listOpenIssues.mockResolvedValue([]);
  mockGh.fetchRepoFileContent.mockImplementation(async (fullName: string) => seededConfig(fullName));
  mockResolveImportedRef.mockImplementation((_repo: string, ref: unknown) => ref);
  mockClawsIssues.listIssuesByLabel.mockResolvedValue([]);
  mockClawsIssues.listClosedIssuesSince.mockResolvedValue([]);
  mockClawsIssues.getIssue.mockResolvedValue(undefined);
  mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
  mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(undefined);
  mockClawsIssues.primaryRepo.mockImplementation((repos: readonly string[]) => [...repos].sort()[0] ?? "");
  mockIsAgentDisabled.mockReturnValue(false);
  mockClawsIssues.editIssue.mockImplementation(async () => { actors.push(currentIssueActor()); });
});

describe("alertBridgeAuthMiddleware", () => {
  const NEW_TOKEN = "n".repeat(64);
  const rotated = (fullName: string) =>
    fullName === REPO ? JSON.stringify({ alertBridge: { label: LABEL, title: TITLE, tokenSha256: sha(NEW_TOKEN) } }) : seededConfig(fullName);

  it("accepts a rotated token after re-reading a stale claws.json", async () => {
    mockGh.fetchRepoFileContent.mockImplementation(async (n: string) => rotated(n));
    const res = await call("GET", "/issues?state=open", { token: NEW_TOKEN, repo: REPO });
    expect(res.status).toBe(200);
    expect(mockGh.fetchRepoFileContent).toHaveBeenCalledTimes(1);
  });

  it("accepts the first token of a repo whose cache had no alertBridge", async () => {
    const plain = "St-John-Software/plain";
    mockGh.fetchRepoFileContent.mockImplementation(async () =>
      JSON.stringify({ alertBridge: { label: LABEL, title: TITLE, tokenSha256: sha(NEW_TOKEN) } }));
    const res = await call("GET", "/issues?state=open", { token: NEW_TOKEN, repo: plain });
    expect(res.status).toBe(200);
  });

  it("re-reads at most once per window for a wrong token", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) {
      expect((await call("GET", "/issues?state=open", { token: "c".repeat(64), repo: REPO })).status).toBe(401);
    }
    expect(mockGh.fetchRepoFileContent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    expect((await call("GET", "/issues?state=open", { token: "c".repeat(64), repo: REPO })).status).toBe(401);
    expect(mockGh.fetchRepoFileContent).toHaveBeenCalledTimes(2);
  });

  it("keeps the old config when the re-read fails", async () => {
    mockGh.fetchRepoFileContent.mockRejectedValue(new Error("forge down"));
    expect((await call("GET", "/issues?state=open", { token: NEW_TOKEN, repo: REPO })).status).toBe(401);
    expect((await call("GET", "/issues?state=open", { token: TOKEN, repo: REPO })).status).toBe(200);
  });

  it("shares one re-read between concurrent wrong-token requests", async () => {
    const bad = { token: "c".repeat(64), repo: REPO };
    const [a, b] = await Promise.all([call("GET", "/issues?state=open", bad), call("GET", "/issues?state=open", bad)]);
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(mockGh.fetchRepoFileContent).toHaveBeenCalledTimes(1);
  });

  it("never fetches without a token or for an unmanaged repo", async () => {
    await call("GET", "/issues?state=open", { token: null, repo: REPO });
    await call("GET", "/issues?state=open", { token: TOKEN, repo: "Someone/else" });
    expect(mockGh.fetchRepoFileContent).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", null, REPO],
    ["a wrong token", "c".repeat(64), REPO],
    ["another repo's bridge token", OTHER_TOKEN, REPO],
    ["a repo without alertBridge", TOKEN, "St-John-Software/plain"],
    ["an unmanaged repo", TOKEN, "Someone/else"],
    ["the agents' internal MCP token", config.INTERNAL_MCP_TOKEN || "internal-token", REPO],
  ])("answers 401 JSON for %s", async (_name, token, repo) => {
    const res = await call("GET", "/issues?state=open", { token, repo });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mockGh.listOpenIssues).not.toHaveBeenCalled();
    expect(mockClawsIssues.listIssuesByLabel).not.toHaveBeenCalled();
  });

  it("admits the repo's own token, case-insensitively on the path, and writes as the alert bridge", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record());
    const res = await call("PATCH", "/issues/clw_01ALERT", { repo: REPO.toLowerCase(), body: { body: "new body" } });
    expect(res.status).toBe(200);
    expect(actors).toEqual([{ kind: "automation", name: "alert bridge" }]);
  });
});

describe("GET issues?state=open", () => {
  it("returns open native issues with the label and filed title, oldest first", async () => {
    mockClawsIssues.listIssuesByLabel.mockResolvedValue([
      { number: "clw_02NEWER", title: TITLE, labels: [{ name: LABEL }] },
      { number: "clw_03OTHER", title: "[Alert] something else", labels: [{ name: LABEL }] },
      { number: "clw_01OLDER", title: TITLE, labels: [{ name: LABEL }] },
    ]);
    mockClawsIssues.getIssue.mockImplementation(async (id: string) => record({ id }));
    const res = await call("GET", "/issues?state=open");
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string }[];
    expect(body.map((i) => i.id)).toEqual(["clw_01OLDER", "clw_02NEWER"]);
    expect(body[0]).toEqual({ id: "clw_01OLDER", title: TITLE, body: record().body, state: "open", closedAt: null, labels: [LABEL] });
    expect(mockClawsIssues.listIssuesByLabel).toHaveBeenCalledWith(REPO, LABEL);
  });

  it("returns an inbox the requirements writer retitled, but not a hand-filed labelled issue", async () => {
    const retitled = "Resolve bonkus pr-37 preview pod not-ready alerts (KubePodNotReady, KubeDeploymentReplicasMismatch)";
    mockClawsIssues.listIssuesByLabel.mockResolvedValue([
      { number: "clw_02NEWER", title: TITLE, labels: [{ name: LABEL }] },
      { number: "clw_01M57TEZT3E98XSHV98QM84T15", title: retitled, filedTitle: TITLE, labels: [{ name: LABEL }, { name: "Blocked" }], lifecycle: "blocked" },
      { number: "clw_03HAND", title: "Registry 503s", labels: [{ name: LABEL }] },
    ]);
    mockClawsIssues.getIssue.mockImplementation(async (id: string) =>
      record({ id, title: id === "clw_01M57TEZT3E98XSHV98QM84T15" ? retitled : TITLE, filed_title: id === "clw_01M57TEZT3E98XSHV98QM84T15" ? TITLE : null }));
    const res = await call("GET", "/issues?state=open");
    const body = await res.json() as { id: string; title: string }[];
    expect(body.map((i) => [i.id, i.title])).toEqual([["clw_01M57TEZT3E98XSHV98QM84T15", retitled], ["clw_02NEWER", TITLE]]);
  });

  it("closes an already-imported forge copy as not planned", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      forgeIssue(63),
      forgeIssue(64, { title: "Unrelated" }),
      forgeIssue(65, { labels: [] }),
      forgeIssue("clw_01NATIVE"),
    ]);
    mockResolveImportedRef.mockImplementation((_repo: string, ref: unknown) => (ref === 63 ? "clw_01ALERT" : ref));
    const res = await call("GET", "/issues?state=open");
    expect(res.status).toBe(200);
    expect(mockGh.listOpenIssues).toHaveBeenCalledWith(REPO, { includeImported: true });
    expect(mockGh.closeIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.closeIssue).toHaveBeenCalledWith(REPO, 63, "not_planned");
    expect(mockImportRepo).not.toHaveBeenCalled();
  });

  it("imports a forge copy that was never imported", async () => {
    const issue = forgeIssue(63);
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockImportRepo.mockImplementation(async () => {
      mockResolveImportedRef.mockImplementation((_repo: string, ref: unknown) => (ref === 63 ? "clw_01ALERT" : ref));
      return { repo: REPO, imported: 1, failed: 0, skipped: 0 };
    });
    const res = await call("GET", "/issues?state=open");
    expect(res.status).toBe(200);
    expect(mockImportRepo).toHaveBeenCalledWith(REPO, [issue]);
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
  });

  it("answers 503 while the forge copy is still not imported, and retries next time", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue(63)]);
    mockImportRepo.mockResolvedValue({ repo: REPO, imported: 0, failed: 0, skipped: 1 });
    expect((await call("GET", "/issues?state=open")).status).toBe(503);
    expect(mockClawsIssues.listIssuesByLabel).not.toHaveBeenCalled();
    expect((await call("GET", "/issues?state=open")).status).toBe(503);
    expect(mockGh.listOpenIssues).toHaveBeenCalledTimes(2);
  });

  it("answers 503 when the forge listing fails", async () => {
    mockGh.listOpenIssues.mockRejectedValue(new Error("forge down"));
    expect((await call("GET", "/issues?state=open")).status).toBe(503);
  });

  it("makes no forge call once a pass finds no open forge copy", async () => {
    mockGh.listOpenIssues.mockResolvedValueOnce([forgeIssue(63)]);
    mockResolveImportedRef.mockImplementation(() => "clw_01ALERT");
    await call("GET", "/issues?state=open");
    await call("GET", "/issues?state=open");
    await call("GET", "/issues?state=open");
    expect(mockGh.listOpenIssues).toHaveBeenCalledTimes(2);
  });
});

describe("GET issues?state=closed", () => {
  it("returns recently closed native issues with the label and filed title, newest closed first", async () => {
    mockClawsIssues.listClosedIssuesSince.mockResolvedValue([
      record({ id: "clw_02", state: "closed", closed_at: "2026-10-14 10:00:00" }),
      record({ id: "clw_03", state: "closed", closed_at: "2026-10-13 10:00:00", labels: ["bug"] }),
      record({ id: "clw_01", state: "closed", closed_at: "2026-10-12 10:00:00" }),
    ]);
    const before = Date.now();
    const res = await call("GET", "/issues?state=closed");
    const body = await res.json() as { id: string; closedAt: string }[];
    expect(body.map((i) => i.id)).toEqual(["clw_02", "clw_01"]);
    expect(body[0]!.closedAt).toBe("2026-10-14T10:00:00.000Z");
    const [repo, since, limit] = mockClawsIssues.listClosedIssuesSince.mock.calls[0]!;
    expect(repo).toBe(REPO);
    expect(before - (since as Date).getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
    expect(limit).toBe(100);
    expect(mockGh.listOpenIssues).not.toHaveBeenCalled();
  });
  it("returns a retitled inbox closed within the lookback and not one filed under another title", async () => {
    mockClawsIssues.listClosedIssuesSince.mockResolvedValue([
      record({ id: "clw_02", title: "Resolve pods", filed_title: TITLE, state: "closed", closed_at: "2026-10-14 10:00:00" }),
      record({ id: "clw_01", title: "Resolve pods", filed_title: "Something else", state: "closed", closed_at: "2026-10-13 10:00:00" }),
    ]);
    const body = await (await call("GET", "/issues?state=closed")).json() as { id: string; closedAt: string }[];
    expect(body.map((i) => i.id)).toEqual(["clw_02"]);
    expect(body[0]!.closedAt).toBe("2026-10-14T10:00:00.000Z");
  });

});

describe("POST issues", () => {
  it("creates the alert issue with the configured title and label, as automation", async () => {
    mockClawsIssues.createIssue.mockResolvedValue("clw_01NEW");
    mockClawsIssues.getIssue.mockResolvedValue(record({ id: "clw_01NEW", body: "firing" }));
    const res = await call("POST", "/issues", { body: { body: "firing", title: "ignored" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "clw_01NEW", title: TITLE, state: "open", labels: [LABEL] });
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith({
      title: TITLE, body: "firing", authorLogin: "claws", repos: [REPO], labels: [LABEL], source: "automation",
    });
  });

  it.each([
    ["a missing body", {}],
    ["a non-string body", { body: 5 }],
    ["an oversized body", { body: "x".repeat(MAX_BODY_LENGTH + 1) }],
    ["invalid JSON", "{nope"],
  ])("rejects %s with 400", async (_name, body) => {
    expect((await call("POST", "/issues", { body })).status).toBe(400);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });
});

describe("PATCH issues/:id", () => {
  it("writes a changed body with a plain edit and queues no re-plan", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record());
    const res = await call("PATCH", "/issues/clw_01ALERT", { body: { body: "updated" } });
    expect(res.status).toBe(200);
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_01ALERT", "updated");
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  it("bumps a retitled blocked inbox without queueing a re-plan", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record({ title: "Resolve pods", filed_title: TITLE, lifecycle: "blocked" }));
    const res = await call("PATCH", "/issues/clw_01ALERT", { body: { body: "updated" } });
    expect(res.status).toBe(200);
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_01ALERT", "updated");
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  it("skips the write when the body is unchanged", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record());
    await call("PATCH", "/issues/clw_01ALERT", { body: { body: record().body } });
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
  });

  it("closes the issue as completed", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record());
    const res = await call("PATCH", "/issues/clw_01ALERT", { body: { body: "resolved", state: "closed" } });
    expect(res.status).toBe(200);
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_01ALERT", "resolved");
    expect(mockClawsIssues.closeIssue).toHaveBeenCalledWith(REPO, "clw_01ALERT", "completed");
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  it("reopens a closed issue and queues a re-plan", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record({ state: "closed", labels: [LABEL, "Priority"] }));
    const res = await call("PATCH", "/issues/clw_01ALERT", { body: { body: "firing again", state: "open" } });
    expect(res.status).toBe(200);
    expect(mockClawsIssues.reopenIssue).toHaveBeenCalledWith("clw_01ALERT");
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, "clw_01ALERT", "planning");
    expect(mockWorker.enqueue).toHaveBeenCalledWith("work:issue-refiner:replan", REPO, "clw_01ALERT", { priority: true });
  });

  it.each([
    ["another repo's issue", record({ repos: [OTHER] })],
    ["a non-alert issue", record({ labels: ["bug"] })],
    ["a different title", record({ title: "Something else" })],
    ["a shadow", record({ kind: "shadow" })],
  ])("answers 404 for %s", async (_name, issue) => {
    mockClawsIssues.getIssue.mockResolvedValue(issue);
    expect((await call("PATCH", "/issues/clw_01ALERT", { body: { state: "closed" } })).status).toBe(404);
    expect(mockClawsIssues.closeIssue).not.toHaveBeenCalled();
  });

  it("answers 404 for a forge number", async () => {
    expect((await call("PATCH", "/issues/63", { body: { state: "closed" } })).status).toBe(404);
    expect(mockClawsIssues.getIssue).not.toHaveBeenCalled();
  });

  it("rejects a bad state with 400", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record());
    expect((await call("PATCH", "/issues/clw_01ALERT", { body: { state: "deleted" } })).status).toBe(400);
  });
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

  it("re-plans a blocked alert issue: Blocked is where a triaged inbox is parked", async () => {
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

function inboxBody(sections: { name: string; count?: number; row?: string }[]): string {
  const lines = ["## Currently firing", "", "- none", "", "## Alerts", ""];
  for (const { name, count = 1, row } of sections) {
    lines.push(`### ${name}`, "", "| Field | Value |", "|---|---|", "| Severity | warning |", `| Occurrences | ${count} |`);
    if (row) lines.push(row);
    lines.push("", "**Summary:** s", "", "**Description:** d", "");
  }
  lines.push(`*${ALERT_BRIDGE_FOOTER}. Closed when every alert above is resolved.*`);
  return lines.join("\n");
}

describe("PATCH issues/:id untriaged-section trigger", () => {
  const triaged = inboxBody([{ name: "Disk", row: "| Triage | transient — flap |" }, { name: "CPU", row: "| Tracked | #clw_01CPU |" }]);

  it("queues a triage re-plan when a rewrite adds an untriaged section", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record({ body: triaged, lifecycle: "approved" }));
    const body = inboxBody([{ name: "Disk", row: "| Triage | transient — flap |" }, { name: "CPU", row: "| Tracked | #clw_01CPU |" }, { name: "Memory" }]);
    expect((await call("PATCH", "/issues/clw_01ALERT", { body: { body } })).status).toBe(200);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, "clw_01ALERT", "planning");
    expect(mockWorker.enqueue).toHaveBeenCalledWith("work:issue-refiner:replan", REPO, "clw_01ALERT", { priority: false });
  });

  it("queues nothing when only an occurrence count changes", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record({ body: inboxBody([{ name: "Disk", row: "| Triage | transient — flap |" }, { name: "New" }]) }));
    const body = inboxBody([{ name: "Disk", count: 5, row: "| Triage | transient — flap |" }, { name: "New", count: 3 }]);
    await call("PATCH", "/issues/clw_01ALERT", { body: { body } });
    expect(mockClawsIssues.editIssue).toHaveBeenCalled();
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  it("re-plans when a verdict row is removed, so the section is re-triaged", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record({ body: triaged }));
    const body = inboxBody([{ name: "Disk" }, { name: "CPU", row: "| Tracked | #clw_01CPU |" }]);
    await call("PATCH", "/issues/clw_01ALERT", { body: { body } });
    expect(mockWorker.enqueue).toHaveBeenCalledTimes(1);
  });

  it("re-plans a Blocked inbox: Blocked is not a hold for alert issues", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record({ body: triaged, lifecycle: "blocked" }));
    await call("PATCH", "/issues/clw_01ALERT", { body: { body: `${triaged}\n`.replace("*Automatically", "### Memory\n\n| Severity | x |\n\n*Automatically") } });
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, "clw_01ALERT", "planning");
    expect(mockWorker.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["backlog", { lifecycle: "backlog" }],
    ["ideas", { lifecycle: "ideas" }],
    ["planning", { lifecycle: "planning" }],
  ])("leaves a %s inbox alone", async (_name, overrides) => {
    mockClawsIssues.getIssue.mockResolvedValue(record({ body: triaged, ...overrides }));
    await call("PATCH", "/issues/clw_01ALERT", { body: { body: inboxBody([{ name: "Memory" }]) } });
    expect(mockClawsIssues.editIssue).toHaveBeenCalled();
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  it("does not move the issue while the planner is disabled", async () => {
    mockIsAgentDisabled.mockReturnValue(true);
    mockClawsIssues.getIssue.mockResolvedValue(record({ body: triaged }));
    await call("PATCH", "/issues/clw_01ALERT", { body: { body: inboxBody([{ name: "Memory" }]) } });
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  it("queues no triage re-plan on a close, and only the reopen's on a reopen", async () => {
    mockClawsIssues.getIssue.mockResolvedValue(record({ body: triaged }));
    await call("PATCH", "/issues/clw_01ALERT", { body: { body: inboxBody([{ name: "Memory" }]), state: "closed" } });
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
    mockClawsIssues.getIssue.mockResolvedValue(record({ body: triaged, state: "closed" }));
    await call("PATCH", "/issues/clw_01ALERT", { body: { body: inboxBody([{ name: "Memory" }]), state: "open" } });
    expect(mockWorker.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("POST alerts/events", () => {
  const OCCURRENCE = "---\n**First seen:** 2026-10-10T00:00:00Z\n**Last seen:** 2026-10-12T00:00:00Z\n**Occurrences:** 4";
  const tracking = (overrides: Record<string, unknown> = {}) => record({
    id: "clw_01TRACK",
    title: "Workload CI Runner Evicted",
    body: `Runner evicted.\n\n${OCCURRENCE}`,
    labels: ["bug"],
    lifecycle: "awaiting-plan-review",
    dedupe_key: "alert-workload-ci-runner-evicted",
    ...overrides,
  });
  const event = (overrides: Record<string, unknown> = {}) => ({
    alertname: "Workload CI Runner Evicted",
    status: "firing",
    at: "2026-10-16T09:00:00Z",
    severity: "warning",
    summary: "Runner pod evicted",
    description: "d",
    ...overrides,
  });
  const post = (alerts: unknown[], opts: { token?: string | null; repo?: string; reopenWindowHours?: unknown } = {}) =>
    call("POST", "/alerts/events", { token: opts.token, repo: opts.repo, body: { reopenWindowHours: "reopenWindowHours" in opts ? opts.reopenWindowHours : 24, alerts } });

  it("answers tracked: false for an alertname no issue tracks", async () => {
    const res = await post([event(), event({ alertname: "Disk Low", status: "resolved" })]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: false }, "Disk Low": { tracked: false } } });
    expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith(REPO, "alert-workload-ci-runner-evicted");
    expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith(REPO, "alert-disk-low");
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
  });

  it("never reports an alert inbox holding an alert- key as the tracking issue", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(record({ dedupe_key: "alert-workload-ci-runner-evicted" }));
    const res = await post([event({ status: "resolved" })]);
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: false } } });
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
  });

  it("treats a retitled inbox (label plus filed title) holding an alert- key as untracked", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(
      record({ title: "Bring the PVC back below 80%", filed_title: TITLE, body: "plain", dedupe_key: "alert-workload-ci-runner-evicted" }),
    );
    const res = await post([event()]);
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: false } } });
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
  });

  it("does not reopen a closed inbox holding an alert- key", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(
      record({ state: "closed", closed_at: "2026-10-16 00:00:00", dedupe_key: "alert-workload-ci-runner-evicted" }),
    );
    const res = await post([event()]);
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: false } } });
    expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
  });

  it("bumps an open tracking issue's occurrence block with no comment", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(tracking());
    const res = await post([event()]);
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: true, id: "clw_01TRACK", state: "open", reopened: false } } });
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_01TRACK",
      "Runner evicted.\n\n---\n**First seen:** 2026-10-10T00:00:00Z\n**Last seen:** 2026-10-16T09:00:00Z\n**Occurrences:** 5");
    expect(actors).toEqual([{ kind: "automation", name: "alert bridge" }]);
    expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.findRecentlyClosedIssueByDedupeKey).not.toHaveBeenCalled();
  });

  it("appends an occurrence block to an open tracking issue that has none", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(tracking({ body: "Runner evicted." }));
    await post([event()]);
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_01TRACK",
      "Runner evicted.\n\n---\n**First seen:** 2026-10-01T00:00:00Z\n**Last seen:** 2026-10-16T09:00:00Z\n**Occurrences:** 2");
  });

  it("dates First seen from creation when reopening a closed tracking issue with no block", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(tracking({ state: "closed", closed_at: "2026-10-16 00:00:00", lifecycle: "approved", body: "Runner evicted." }));
    await post([event()]);
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_01TRACK",
      "Runner evicted.\n\n---\n**First seen:** 2026-10-01T00:00:00Z\n**Last seen:** 2026-10-16T09:00:00Z\n**Occurrences:** 2");
  });

  it("changes nothing for a resolve of a tracked alert", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(tracking());
    const res = await post([event({ status: "resolved" })]);
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: true, id: "clw_01TRACK", state: "open", reopened: false } } });
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
  });

  it("reopens a tracking issue closed within the window, bumps it, comments once and re-plans", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(tracking({ state: "closed", closed_at: "2026-10-16 00:00:00", lifecycle: "approved" }));
    const before = Date.now();
    const res = await post([event(), event({ at: "2026-10-16T09:05:00Z" })], { reopenWindowHours: 6 });
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: true, id: "clw_01TRACK", state: "open", reopened: true } } });
    const [repo, key, since] = mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mock.calls[0]!;
    expect([repo, key]).toEqual([REPO, "alert-workload-ci-runner-evicted"]);
    expect(before - (since as Date).getTime()).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000 - 1000);
    expect(before - (since as Date).getTime()).toBeLessThan(6 * 60 * 60 * 1000 + 5000);
    expect(mockClawsIssues.reopenIssue).toHaveBeenCalledWith("clw_01TRACK");
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_01TRACK",
      "Runner evicted.\n\n---\n**First seen:** 2026-10-10T00:00:00Z\n**Last seen:** 2026-10-16T09:05:00Z\n**Occurrences:** 6");
    expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith(REPO, "clw_01TRACK",
      "Alert Workload CI Runner Evicted fired again at 2026-10-16T09:00:00Z (Runner pod evicted); reopened.", "claws");
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, "clw_01TRACK", "planning");
    expect(mockWorker.enqueue).toHaveBeenCalledWith("work:issue-refiner:replan", REPO, "clw_01TRACK", { priority: false });
  });

  it("reports a resolve of a recently closed tracked alert as tracked without reopening", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(tracking({ state: "closed", closed_at: "2026-10-16 00:00:00" }));
    const res = await post([event({ status: "resolved" })]);
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: true, id: "clw_01TRACK", state: "closed", reopened: false } } });
    expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
  });

  it("caps the window at the closed lookback", async () => {
    const before = Date.now();
    await post([event()], { reopenWindowHours: 10_000 });
    const since = mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mock.calls[0]![2] as Date;
    expect(before - since.getTime()).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 5000);
  });

  it("answers tracked: false for an issue closed outside the window", async () => {
    // The lookup is bounded by the window, so nothing comes back.
    const res = await post([event()], { reopenWindowHours: 1 });
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: false } } });
    expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-alert dedupe key", { dedupe_key: "renovate-x" }],
    ["no dedupe key", { dedupe_key: null }],
    ["another repo's issue", { repos: [OTHER] }],
    ["an issue whose primary repo is another repo", { repos: ["Aa/first", REPO] }],
    ["a shadow", { kind: "shadow" }],
  ])("never touches %s", async (_name, overrides) => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(tracking(overrides));
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(tracking({ state: "closed", ...overrides }));
    const res = await post([event()]);
    expect(await res.json()).toEqual({ results: { "Workload CI Runner Evicted": { tracked: false } } });
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
  });

  it("looks only in the token's own repo", async () => {
    await post([event()], { token: OTHER_TOKEN, repo: OTHER });
    expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith(OTHER, "alert-workload-ci-runner-evicted");
    expect(mockClawsIssues.findOpenIssueByDedupeKey).not.toHaveBeenCalledWith(REPO, expect.anything());
  });

  it.each([
    ["another repo's bridge token", { token: OTHER_TOKEN }],
    ["the agents' internal MCP token", { token: config.INTERNAL_MCP_TOKEN || "internal-token" }],
    ["no token", { token: null }],
  ])("answers 401 for %s", async (_name, opts) => {
    expect((await post([event()], opts)).status).toBe(401);
    expect(mockClawsIssues.findOpenIssueByDedupeKey).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing window", [event()], { reopenWindowHours: undefined }],
    ["a negative window", [event()], { reopenWindowHours: -1 }],
    ["too many alerts", Array.from({ length: MAX_ALERT_EVENTS + 1 }, () => event()), {}],
    ["a bad status", [event({ status: "pending" })], {}],
    ["an empty alertname", [event({ alertname: " " })], {}],
    ["a missing summary", [event({ summary: undefined })], {}],
    ["a non-string source", [event({ source: 5 })], {}],
    ["an oversized description", [event({ description: "x".repeat(MAX_ALERT_FIELD_LENGTH + 1) })], {}],
    ["a non-object alert", ["nope"], {}],
  ])("rejects %s with 400", async (_name, alerts, opts) => {
    expect((await post(alerts, opts)).status).toBe(400);
    expect(mockClawsIssues.findOpenIssueByDedupeKey).not.toHaveBeenCalled();
  });

  it("accepts exactly the maximum number of alerts", async () => {
    expect((await post(Array.from({ length: MAX_ALERT_EVENTS }, (_, i) => event({ alertname: `A${i}`, source: "s" })))).status).toBe(200);
  });
});
