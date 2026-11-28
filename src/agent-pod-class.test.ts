import { describe, it, expect, vi, beforeEach } from "vitest";

const { labels, prs, linked, mockLog, settings } = vi.hoisted(() => ({
  labels: new Map<string, string[] | Error>(),
  prs: new Map<string, { issueRef?: string | null; issueId?: string | null }>(),
  linked: new Map<string, string>(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  settings: { large: { memoryRequest: "6Gi", memoryLimit: "16Gi", ephemeralStorageLimit: "48Gi", homeSize: "40Gi", nodes: ["ryzen"] } as { memoryRequest: string; memoryLimit: string; ephemeralStorageLimit: string; homeSize: string; nodes: string[] } | null },
}));

vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), {
  get AGENT_POD_SETTINGS() { return settings; },
  LABELS: { agentLarge: "Agent: Large" },
}));
vi.mock("./github.js", () => ({
  getLiveLabels: vi.fn(async (repo: string, ref: string | number) => {
    const got = labels.get(`${repo}#${ref}`) ?? [];
    if (got instanceof Error) throw got;
    return got;
  }),
  addLabel: vi.fn(async () => undefined),
  commentOnIssue: vi.fn(async () => undefined),
}));
vi.mock("./db.js", () => ({
  getClawsPr: vi.fn(async (repo: string, n: number) => prs.get(`${repo}#${n}`) ?? null),
  getLinkedNativeId: vi.fn(async (repo: string, ref: string | number) => linked.get(`${repo}#${ref}`) ?? null),
}));
vi.mock("./log.js", () => mockLog);

import * as gh from "./github.js";
import { agentPodClassOf, escalateAfterPodResourceKill, escalateItemToLarge, resolveAgentPodClass } from "./agent-pod-class.js";

const REPO = "St-John-Software/claws";
const row = (item_number: number | string, kind = "issue-worker") => ({ id: 1, kind, repo: REPO, item_number });

beforeEach(() => {
  labels.clear();
  prs.clear();
  linked.clear();
  settings.large = { memoryRequest: "6Gi", memoryLimit: "16Gi", ephemeralStorageLimit: "48Gi", homeSize: "40Gi", nodes: ["ryzen"] };
  vi.mocked(gh.getLiveLabels).mockClear();
  vi.mocked(gh.addLabel).mockReset().mockResolvedValue(undefined);
  vi.mocked(gh.commentOnIssue).mockReset().mockResolvedValue(undefined);
  mockLog.warn.mockClear();
  mockLog.info.mockClear();
});

describe("resolveAgentPodClass", () => {
  it("is large when the item carries Agent: Large", async () => {
    labels.set(`${REPO}#42`, ["Priority", "Agent: Large"]);
    expect(await resolveAgentPodClass(row(42))).toBe("large");
    labels.set(`${REPO}#clw_01ABC`, ["Agent: Large"]);
    expect(await resolveAgentPodClass(row("clw_01ABC"))).toBe("large");
  });

  it("is default without the label", async () => {
    labels.set(`${REPO}#42`, ["Priority"]);
    expect(await resolveAgentPodClass(row(42))).toBe("default");
  });

  it("never reads labels when the large class is not configured or the row names no item", async () => {
    labels.set(`${REPO}#42`, ["Agent: Large"]);
    settings.large = null;
    expect(await resolveAgentPodClass(row(42))).toBe("default");
    settings.large = { memoryRequest: "6Gi", memoryLimit: "16Gi", ephemeralStorageLimit: "48Gi", homeSize: "40Gi", nodes: ["ryzen"] };
    expect(await resolveAgentPodClass(row(0, "repo-standards"))).toBe("default");
    expect(gh.getLiveLabels).not.toHaveBeenCalled();
  });

  it("follows a pull request's stored relation to its source issue's label", async () => {
    prs.set(`${REPO}#77`, { issueRef: "clw_01SRC", issueId: "clw_01SRC" });
    labels.set(`${REPO}#clw_01SRC`, ["Agent: Large"]);
    expect(await resolveAgentPodClass(row(77, "ci-fixer"))).toBe("large");
    prs.set(`${REPO}#78`, { issueRef: "12", issueId: null });
    labels.set(`${REPO}#12`, ["Agent: Large"]);
    expect(await resolveAgentPodClass(row(78, "pr-reviewer"))).toBe("large");
    prs.set(`${REPO}#79`, { issueRef: "13", issueId: null });
    expect(await resolveAgentPodClass(row(79, "pr-reviewer"))).toBe("default");
  });

  it("reads a PR's source issue by its tracker id before the body ref", async () => {
    // Imported issue: the forge copy #12 is closed and stale; labels live on the native record.
    prs.set(`${REPO}#80`, { issueRef: "12", issueId: "clw_X" });
    labels.set(`${REPO}#clw_X`, ["Agent: Large"]);
    expect(await resolveAgentPodClass(row(80, "pr-reviewer"))).toBe("large");
    expect(gh.getLiveLabels).not.toHaveBeenCalledWith(REPO, "12");
    // No stored id: the body ref resolves through its import link.
    prs.set(`${REPO}#81`, { issueRef: "14", issueId: null });
    linked.set(`${REPO}#14`, "clw_Y");
    labels.set(`${REPO}#clw_Y`, ["Agent: Large"]);
    expect(await resolveAgentPodClass(row(81, "pr-reviewer"))).toBe("large");
  });

  it("fails open to default and warns when a label read fails", async () => {
    labels.set(`${REPO}#42`, new Error("forge down"));
    expect(await resolveAgentPodClass(row(42))).toBe("default");
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("label read failed"), expect.objectContaining({ row: 1 }), expect.any(Error));
  });
});

describe("agentPodClassOf", () => {
  it("reads only `large` as large", () => {
    expect(agentPodClassOf("large")).toBe("large");
    for (const v of ["default", null, undefined, "huge"]) expect(agentPodClassOf(v)).toBe("default");
  });
});

describe("escalateItemToLarge", () => {
  it("adds Agent: Large to an item without it, logs, and returns true", async () => {
    labels.set(`${REPO}#clw_01ABC`, ["Priority"]);
    expect(await escalateItemToLarge(REPO, "clw_01ABC")).toBe(true);
    expect(gh.addLabel).toHaveBeenCalledWith(REPO, "clw_01ABC", "Agent: Large");
    expect(mockLog.info).toHaveBeenCalledWith("agent pod class escalated to large", expect.objectContaining({ repo: REPO, item: "clw_01ABC" }));
  });

  it("returns false when the label is already present", async () => {
    labels.set(`${REPO}#42`, ["Agent: Large"]);
    expect(await escalateItemToLarge(REPO, 42)).toBe(false);
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("returns false without reading labels when the large class is not configured or there is no item", async () => {
    settings.large = null;
    expect(await escalateItemToLarge(REPO, 42)).toBe(false);
    settings.large = { memoryRequest: "6Gi", memoryLimit: "16Gi", ephemeralStorageLimit: "48Gi", homeSize: "40Gi", nodes: ["ryzen"] };
    expect(await escalateItemToLarge(REPO, 0)).toBe(false);
    expect(gh.getLiveLabels).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("propagates a label write failure", async () => {
    vi.mocked(gh.addLabel).mockRejectedValueOnce(new Error("forge down"));
    await expect(escalateItemToLarge(REPO, 42)).rejects.toThrow("forge down");
  });
});

describe("escalateAfterPodResourceKill", () => {
  const STORAGE = { kind: "storage" as const, detail: "Evicted: disk" };
  it("posts nothing when the item is already large", async () => {
    labels.set(`${REPO}#42`, ["Agent: Large"]);
    expect(await escalateAfterPodResourceKill(row(42), STORAGE)).toBe(false);
    expect(gh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("logs and returns false when the label write fails", async () => {
    vi.mocked(gh.addLabel).mockRejectedValueOnce(new Error("forge down"));
    expect(await escalateAfterPodResourceKill(row(42), STORAGE)).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith("agent pod class escalation failed", expect.any(Object), expect.any(Error));
    expect(gh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("names the disk limit for a storage eviction", async () => {
    const detail = 'Evicted: Usage of EmptyDir volume "home" exceeds the limit "20Gi".';
    expect(await escalateAfterPodResourceKill(row(42), { kind: "storage", detail })).toBe(true);
    const body = vi.mocked(gh.commentOnIssue).mock.calls[0]![2];
    expect(body).toContain("Disk limit reached");
    expect(body).toContain(detail);
    expect(body).toContain("Agent: Large");
  });
});
