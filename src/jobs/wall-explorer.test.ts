import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  config: {
    SELF_REPO: "St-John-Software/claws",
    FLEET_GRAFANA_URL: "https://grafana.example.net",
    BROWSER_CDP_ENDPOINT: "ws://browser.svc:3000/?token=t",
    isManagedRepo: (r: string) => ["St-John-Software/fleet-infra", "St-John-Software/production-infra", "St-John-Software/forgejo-app"].includes(r),
  },
  db: {
    listOpenClawsIssuesByDedupeKey: vi.fn(async (): Promise<unknown[]> => []),
    listNotPlannedClawsIssuesByDedupeKey: vi.fn(async (_repo: string | null, _key: string): Promise<unknown[]> => []),
    listOpenClawsIssues: vi.fn(async (): Promise<unknown[]> => []),
    withTaskRecording: vi.fn(async (_j: string, _r: string, _n: number, _l: null, fn: (id: number) => Promise<unknown>) => fn(7)),
    recordTaskComplete: vi.fn(async () => undefined),
    trackTaskTokens: vi.fn(() => () => undefined),
  },
  claude: {
    runClaude: vi.fn(async (): Promise<string> => "{}"),
    ensureScratchDir: vi.fn(() => ""),
    agentMcpDir: vi.fn(() => ""),
    writeAgentMcpConfig: vi.fn(() => ""),
  },
  clawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    createIssue: vi.fn(async (): Promise<string> => "clw_1"),
    editIssue: vi.fn(async () => undefined),
    promoteIssue: vi.fn(async (): Promise<boolean> => true),
    findOpenIssueByDedupeKey: vi.fn(async (): Promise<unknown> => undefined),
  },
  attachments: {
    storeIssueAttachment: vi.fn(async (_id: string, name: string) => ({ ok: true, row: { id: `cla_${name}`, issue_id: "clw_1", filename: name } })),
    attachmentUrl: vi.fn((row: { id: string; filename: string }) => `/issues/clw_1/attachments/${row.id}/${row.filename}`),
  },
  grafanaAuthorization: vi.fn((): string | null => "Basic abc"),
  fetchActiveAlerts: vi.fn(async (): Promise<unknown> => ({ ok: true, alerts: [], durationMs: 1 })),
  reportError: vi.fn(async () => undefined),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  wall: {
    resolveWallPlaylist: vi.fn(async (): Promise<unknown> => ({ uids: ["wall-app-forgejo"], source: "grafana" })),
    fetchDashboardInfo: vi.fn(async (_a: string, uid: string) => ({ uid, title: "Forgejo", folder: "Prod", panels: [] })),
    captureWall: vi.fn(async (): Promise<unknown> => ({ dashboards: [], authRedirect: false })),
    emptyDir: vi.fn(),
    writeManifest: vi.fn(() => "/scratch/manifest.json"),
    writeAgentBrowserConfig: vi.fn(() => ""),
  },
  fetch: vi.fn(),
}));

vi.mock("../config.js", async (importOriginal) => (await import("../test-helpers.js")).completeConfigMock(await importOriginal<typeof import("../config.js")>(), m.config));
vi.mock("../db.js", () => m.db);
vi.mock("../claude.js", () => m.claude);
vi.mock("../claws-issues.js", () => m.clawsIssues);
vi.mock("../issue-attachments.js", () => m.attachments);
vi.mock("../model-selector.js", () => ({ getDefaultTier: vi.fn(() => "opus") }));
vi.mock("../capabilities.js", () => ({ plannerCapabilities: () => ["fleet-observability"] }));
vi.mock("../grafana-auth.js", () => ({ grafanaAuthorization: m.grafanaAuthorization }));
vi.mock("../browser-endpoint.js", () => ({ grafanaBrowserMcpServer: (p: string) => ({ command: "npx", args: ["@playwright/mcp@0.0.85", "--config", p] }) }));
vi.mock("./alertmanager-poller.js", () => ({ fetchActiveAlerts: m.fetchActiveAlerts }));
vi.mock("../error-reporter.js", () => ({ reportError: m.reportError }));
vi.mock("../log.js", () => m.log);
vi.mock("../wall-explorer.js", () => m.wall);
vi.stubGlobal("fetch", m.fetch);

import { run, fileFindings, findingDedupeKey, owningRepo, dismissedRecently, mayCoverWallFinding, type WallReply } from "./wall-explorer.js";
import type { DashboardCapture, WallManifest } from "../wall-explorer.js";

let dir: string;

function dashboard(over: Partial<DashboardCapture> = {}): DashboardCapture {
  return {
    uid: "wall-app-forgejo", title: "Forgejo", folder: "Prod", url: "https://grafana.example.net/d/wall-app-forgejo?kiosk&theme=dark",
    screenshot: path.join(dir, "wall-app-forgejo.png"), fullPageScreenshot: null, clipped: false,
    panels: [{ id: 4, title: "Request rate", crop: path.join(dir, "wall-app-forgejo-panel-4.png"), box: null, noData: true, errorText: "" }],
    captureError: null, durationMs: 10, ...over,
  };
}

function manifest(dashboards: DashboardCapture[] = [dashboard()]): WallManifest {
  return { capturedAt: "2026-11-18T05:00:00Z", playlistSource: "grafana", dashboards };
}

function finding(over: Partial<WallReply["findings"][number]> = {}): WallReply["findings"][number] {
  return {
    dashboardUid: "wall-app-forgejo", panelId: 4, category: "operational", kind: "no-data", repo: "",
    title: "Forgejo request rate shows No data", observation: "No data for 7 days", whyNotCovered: "No alert on the recording rule",
    alertGap: "Add an absent() alert", suggestedFix: "Fix the scrape", ...over,
  };
}

function reply(findings: WallReply["findings"], suppressed: WallReply["suppressed"] = []): WallReply {
  return { browserOk: true, findings, suppressed };
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wall-explorer-job-"));
  fs.writeFileSync(path.join(dir, "wall-app-forgejo.png"), "full");
  fs.writeFileSync(path.join(dir, "wall-app-forgejo-panel-4.png"), "crop");
  m.config.BROWSER_CDP_ENDPOINT = "ws://browser.svc:3000/?token=t";
  m.grafanaAuthorization.mockReturnValue("Basic abc");
  m.claude.ensureScratchDir.mockReturnValue(dir);
  m.claude.agentMcpDir.mockReturnValue(path.join(dir, "mcp"));
  m.wall.writeAgentBrowserConfig.mockImplementation(() => {
    fs.mkdirSync(path.join(dir, "mcp"), { recursive: true });
    const f = path.join(dir, "mcp", "browser.json");
    fs.writeFileSync(f, "{}");
    return f;
  });
  m.claude.writeAgentMcpConfig.mockImplementation(() => {
    const f = path.join(dir, "mcp", "mcp.json");
    fs.writeFileSync(f, "{}");
    return f;
  });
  let n = 0;
  m.clawsIssues.createIssue.mockImplementation(async () => `clw_${++n}`);
  m.fetch.mockResolvedValue({ status: 200, json: async () => ({ data: { alerts: [
    { state: "Alerting", labels: { alertname: "DiskFull" }, annotations: { summary: "disk" } },
    { state: "Normal", labels: { alertname: "Quiet" } },
  ] } }) });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("helpers", () => {
  it("builds the stable dedupe key", () => {
    expect(findingDedupeKey("wall-app-forgejo", 4, "no-data")).toBe("wall-explorer-wall-app-forgejo-4-no-data");
    expect(findingDedupeKey("Wall_Overview", null, "layout")).toBe("wall-explorer-wall_overview-dashboard-layout");
  });

  it("falls back by folder and category when the named repo is missing or unmanaged", () => {
    expect(owningRepo({ repo: "St-John-Software/forgejo-app", category: "operational" }, "Prod")).toBe("St-John-Software/forgejo-app");
    expect(owningRepo({ repo: "", category: "operational" }, "Prod")).toBe("St-John-Software/production-infra");
    expect(owningRepo({ repo: "someone/else", category: "operational" }, "Home")).toBe("St-John-Software/fleet-infra");
    expect(owningRepo({ repo: "", category: "presentation" }, "Prod")).toBe("St-John-Software/fleet-infra");
  });

  it("treats a not-planned close within 30 days as a dismissal", () => {
    const now = new Date("2026-11-18T05:00:00Z");
    expect(dismissedRecently({ closed_at: "2026-11-01 10:00:00" }, now)).toBe(true);
    expect(dismissedRecently({ closed_at: "2026-10-01 10:00:00" }, now)).toBe(false);
    expect(dismissedRecently({ closed_at: null }, now)).toBe(false);
  });
});

describe("fileFindings", () => {
  it("files an issue with the dedupe key and embeds both screenshots", async () => {
    const result = await fileFindings(reply([finding()]), manifest());
    expect(result.filed).toEqual(["clw_1"]);
    expect(m.clawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      authorLogin: "claws", source: "automation", autoPromote: false, repos: ["St-John-Software/production-infra"],
      dedupeKey: "wall-explorer-wall-app-forgejo-4-no-data", title: "Wall: Forgejo request rate shows No data",
    }));
    const body = (m.clawsIssues.createIssue.mock.calls[0] as unknown as [{ body: string }])[0].body;
    expect(body).toContain("https://grafana.example.net/d/wall-app-forgejo?viewPanel=panel-4");
    expect(body).toContain("Why no existing alert or issue covers it");
    expect(body).toContain("Add an absent() alert");
    expect(m.attachments.storeIssueAttachment).toHaveBeenCalledWith("clw_1", "wall-app-forgejo-panel-4.png", Buffer.from("crop"), "image/png", "claws");
    expect(m.attachments.storeIssueAttachment).toHaveBeenCalledWith("clw_1", "wall-app-forgejo.png", Buffer.from("full"), "image/png", "claws");
    const edited = (m.clawsIssues.editIssue.mock.calls[0] as unknown as [string, string]);
    expect(edited[0]).toBe("clw_1");
    expect(edited[1]).toContain("![Panel Request rate](/issues/clw_1/attachments/cla_wall-app-forgejo-panel-4.png/wall-app-forgejo-panel-4.png)");
    expect(edited[1]).toContain("![Dashboard Forgejo]");
    expect(m.clawsIssues.promoteIssue).toHaveBeenCalledWith("clw_1", "claws", "ideas");
    expect(m.clawsIssues.editIssue.mock.invocationCallOrder[0]).toBeLessThan(m.clawsIssues.promoteIssue.mock.invocationCallOrder[0]!);
  });

  it("still counts and promotes a filed issue whose screenshot edit fails", async () => {
    m.clawsIssues.editIssue.mockRejectedValueOnce(new Error("db down"));
    const result = await fileFindings(reply([finding()]), manifest());
    expect(result.filed).toEqual(["clw_1"]);
    expect(m.log.warn).toHaveBeenCalledWith("wall explorer screenshots not embedded", expect.objectContaining({ issue: "clw_1" }), expect.any(Error));
    expect(m.clawsIssues.promoteIssue).toHaveBeenCalledWith("clw_1", "claws", "ideas");
  });

  it("leaves an open issue with the same key untouched", async () => {
    m.db.listOpenClawsIssuesByDedupeKey.mockResolvedValueOnce([{ id: "clw_old" }]);
    const result = await fileFindings(reply([finding()]), manifest());
    expect(result.filed).toEqual([]);
    expect(result.suppressed["already-filed"]).toBe(1);
    expect(m.clawsIssues.createIssue).not.toHaveBeenCalled();
    expect(m.clawsIssues.editIssue).not.toHaveBeenCalled();
  });

  it("holds a dismissal for 30 days", async () => {
    const now = new Date("2026-11-18T05:00:00Z");
    m.db.listNotPlannedClawsIssuesByDedupeKey.mockResolvedValueOnce([{ closed_at: "2026-11-10 09:00:00" }]);
    const recent = await fileFindings(reply([finding()]), manifest(), now);
    expect(recent.suppressed.dismissed).toBe(1);
    expect(m.db.listNotPlannedClawsIssuesByDedupeKey).toHaveBeenCalledWith(null, "wall-explorer-wall-app-forgejo-4-no-data");
    m.db.listNotPlannedClawsIssuesByDedupeKey.mockResolvedValueOnce([{ closed_at: "2026-09-01 09:00:00" }]);
    const old = await fileFindings(reply([finding()]), manifest(), now);
    expect(old.filed).toHaveLength(1);
  });

  it("holds a dismissal filed in another repo when the agent names a different repo today", async () => {
    const now = new Date("2026-11-18T05:00:00Z");
    m.db.listNotPlannedClawsIssuesByDedupeKey.mockImplementation(async (repo) =>
      repo === null || repo === "St-John-Software/forgejo-app" ? [{ closed_at: "2026-11-10 09:00:00", repos: ["St-John-Software/forgejo-app"] }] : []);
    try {
      const result = await fileFindings(reply([finding({ repo: "" })]), manifest(), now);
      expect(result.suppressed.dismissed).toBe(1);
      expect(m.clawsIssues.createIssue).not.toHaveBeenCalled();
    } finally {
      m.db.listNotPlannedClawsIssuesByDedupeKey.mockImplementation(async () => []);
    }
  });

  it("files at most five and counts the rest as over the cap", async () => {
    const panels = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, title: `P${i + 1}`, crop: null, box: null, noData: false, errorText: "" }));
    const findings = panels.map((p) => finding({ panelId: p.id, category: "presentation", kind: "units" }));
    const result = await fileFindings(reply(findings), manifest([dashboard({ panels })]));
    expect(result.filed).toHaveLength(5);
    expect(result.overCap).toBe(2);
    expect(m.clawsIssues.createIssue).toHaveBeenCalledTimes(5);
    expect((m.clawsIssues.createIssue.mock.calls[0] as unknown as [{ repos: string[] }])[0].repos).toEqual(["St-John-Software/fleet-infra"]);
  });

  it("drops findings for dashboards, panels or kinds not in the manifest", async () => {
    const result = await fileFindings(reply([
      finding({ dashboardUid: "nope" }),
      finding({ kind: "vibes" }),
      finding({ category: "presentation", kind: "no-data" }),
    ], [{ dashboardUid: "wall-app-forgejo", panelId: 4, kind: "threshold", coveredBy: "DiskFull" }]), manifest());
    expect(result.filed).toEqual([]);
    expect(result.suppressed["unknown-target"]).toBe(3);
    expect(result.suppressed["agent-covered"]).toBe(1);
    expect(m.log.warn).toHaveBeenCalledWith("wall explorer finding dropped", expect.objectContaining({ dashboard_uid: "nope" }));
  });

  it("files a panel id the manifest lacks as a dashboard-level finding", async () => {
    const result = await fileFindings(reply([finding({ panelId: 99 })]), manifest());
    expect(result.filed).toEqual(["clw_1"]);
    expect(m.log.warn).toHaveBeenCalledWith("wall explorer panel not in manifest", expect.objectContaining({ panel_id: 99 }));
    expect(m.clawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "wall-explorer-wall-app-forgejo-dashboard-no-data" }));
  });
});

describe("run", () => {
  function captured(over: Partial<DashboardCapture> = {}) {
    m.wall.captureWall.mockResolvedValueOnce({ dashboards: [dashboard(over)], authRedirect: false });
  }

  it("skips without credentials, filing nothing", async () => {
    m.grafanaAuthorization.mockReturnValue(null);
    const summary = await run();
    expect(summary.outcome).toBe("skipped-unconfigured");
    expect(m.wall.resolveWallPlaylist).not.toHaveBeenCalled();
    expect(m.log.warn).toHaveBeenCalledWith("wall explorer finished", expect.objectContaining({ outcome: "skipped-unconfigured" }));
  });

  it("skips without a browser endpoint", async () => {
    m.config.BROWSER_CDP_ENDPOINT = "";
    expect((await run()).outcome).toBe("skipped-unconfigured");
    expect(m.wall.captureWall).not.toHaveBeenCalled();
  });

  it("fails an auth redirect through reportError and files nothing", async () => {
    m.wall.captureWall.mockResolvedValueOnce({ dashboards: [dashboard({ captureError: "auth-redirect", screenshot: null })], authRedirect: true });
    const summary = await run();
    expect(summary.outcome).toBe("auth-redirect");
    expect(m.reportError).toHaveBeenCalledWith("wall-explorer:run", "wall-explorer", expect.any(Error));
    expect(m.claude.runClaude).not.toHaveBeenCalled();
    expect(m.clawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("reports an unparseable reply and files nothing", async () => {
    captured();
    m.claude.runClaude.mockResolvedValueOnce("I looked and it was fine");
    const summary = await run();
    expect(summary.outcome).toBe("error");
    expect(m.reportError).toHaveBeenCalled();
    expect(m.clawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("runs the agent with the job's tier, the browser and planner grants, then files and deletes the configs", async () => {
    captured();
    m.claude.runClaude.mockResolvedValueOnce(JSON.stringify(reply([finding()])));
    const summary = await run();
    expect(summary.outcome).toBe("ok");
    expect(summary.filed).toEqual(["clw_1"]);
    const [prompt, cwd, opts] = m.claude.runClaude.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(cwd).toBe(dir);
    expect(opts).toEqual(expect.objectContaining({
      tier: "opus", provider: "claude", noProviderFallback: true, plannerCapabilities: ["fleet-observability"],
      captureLabel: "wall-explorer", timeoutMs: 60 * 60 * 1000, disallowedTools: ["Edit", "Write", "NotebookEdit", "Task"],
    }));
    expect(prompt).toContain("/scratch/manifest.json");
    expect(prompt).toContain("DiskFull");
    expect(prompt).not.toContain("Quiet");
    expect(prompt).not.toContain("Basic abc");
    expect(m.fetchActiveAlerts).toHaveBeenCalledWith("fleet", "alertmanager-prod");
    expect(m.claude.writeAgentMcpConfig).toHaveBeenCalledWith(dir, expect.objectContaining({
      fileSuffix: "wall-explorer",
      additionalServers: { playwright: { command: "npx", args: ["@playwright/mcp@0.0.85", "--config", path.join(dir, "mcp", "browser.json")] } },
    }));
    expect(fs.existsSync(path.join(dir, "mcp", "browser.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "mcp", "mcp.json"))).toBe(false);
    expect(m.log.info).toHaveBeenCalledWith("wall explorer finished", expect.objectContaining({ outcome: "ok", findings_filed: 1, dashboards: 1, panels: 1 }));
  });

  it("deletes the browser config even when the agent fails", async () => {
    captured();
    m.claude.runClaude.mockRejectedValueOnce(new Error("timeout"));
    expect((await run()).outcome).toBe("error");
    expect(fs.existsSync(path.join(dir, "mcp", "browser.json"))).toBe(false);
  });

  it("names unreadable alert sources in the prompt", async () => {
    captured();
    m.fetch.mockResolvedValueOnce({ status: 302, body: { cancel: async () => undefined } });
    m.fetchActiveAlerts.mockResolvedValueOnce({ ok: false, httpStatus: 502, durationMs: 1 });
    m.claude.runClaude.mockResolvedValueOnce(JSON.stringify(reply([])));
    const summary = await run();
    expect(summary.filed).toEqual([]);
    const prompt = (m.claude.runClaude.mock.calls[0] as unknown as [string])[0];
    expect(prompt).toContain("home Grafana alerting");
    expect(prompt).toContain("prod Alertmanager (alertmanager-prod)");
  });

  it("lists only open issues that could cover a wall finding in the prompt", async () => {
    captured();
    m.db.listOpenClawsIssues.mockResolvedValueOnce([
      { id: "clw_infra", title: "Infra thing", repos: ["St-John-Software/fleet-infra"], dedupe_keys: [], alert_kind: null },
      { id: "clw_app", title: "Unrelated app feature", repos: ["St-John-Software/forgejo-app"], dedupe_keys: [], alert_kind: null },
      { id: "clw_wall", title: "Wall finding in app", repos: ["St-John-Software/forgejo-app"], dedupe_keys: ["wall-explorer-x-1-units"], alert_kind: null },
      { id: "clw_alert", title: "Alert in app", repos: ["St-John-Software/forgejo-app"], dedupe_keys: [], alert_kind: "bridge" },
    ]);
    m.claude.runClaude.mockResolvedValueOnce(JSON.stringify(reply([])));
    await run();
    const prompt = (m.claude.runClaude.mock.calls[0] as unknown as [string])[0];
    expect(prompt).toContain("clw_infra");
    expect(prompt).toContain("clw_wall");
    expect(prompt).toContain("clw_alert");
    expect(prompt).not.toContain("clw_app");
    expect(mayCoverWallFinding({ repos: ["St-John-Software/production-infra"], dedupe_keys: [], alert_kind: null })).toBe(true);
  });

  it("reports a run where every capture failed", async () => {
    captured({ screenshot: null, captureError: "Error", panels: [] });
    expect((await run()).outcome).toBe("error");
    expect(m.claude.runClaude).not.toHaveBeenCalled();
  });
});
