import { describe, it, expect, vi, beforeEach } from "vitest";
import type { K8sClient, K8sError, K8sObject, K8sResult } from "./k8s/api.js";

const { mockDb, mockAlerts, mockLog } = vi.hoisted(() => ({
  mockDb: { recordSessionMemoryCapture: vi.fn(), noteSessionMemoryCaptureFailed: vi.fn() },
  mockAlerts: { ensureAlertIssue: vi.fn(), closeAlertIssueIfResolved: vi.fn() },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./db.js", () => mockDb);
vi.mock("./occurrence-tracking.js", () => mockAlerts);
vi.mock("./log.js", () => mockLog);
vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), { SELF_REPO: "St-John-Software/claws" }));

import { MEMORY_CAPTURE_ALERT_TITLE, captureSessionMemories, memoryCapturePlacement, parseMemoryDump } from "./session-memory-capture.js";

const POD = "claws-session-memory-aa11";
const SLUG = "-home-claws-work-org-app";

function err(kind: K8sError["kind"], status?: number): K8sError {
  return { ok: false, kind, status, applied: "no", message: `HTTP ${status ?? 0}` };
}

/** A namespaced API holding at most the capture pod, whose phase steps through `phases` on each read. */
function fakeClient(opts: { phases?: string[]; log?: K8sResult<string> } = {}) {
  const calls: string[] = [];
  const pods = new Map<string, K8sObject>();
  const phases = [...(opts.phases ?? ["Pending", "Succeeded"])];
  const client = {
    async create(_r: string, _ns: string, obj: K8sObject) {
      calls.push("create");
      pods.set(obj.metadata!.name!, obj);
      return { ok: true, value: obj };
    },
    async get(_r: string, _ns: string, name: string) {
      calls.push("get");
      const pod = pods.get(name);
      if (!pod) return err("not-found", 404);
      const phase = phases.length > 1 ? phases.shift() : phases[0];
      return { ok: true, value: { ...pod, status: { phase } } };
    },
    async delete(_r: string, _ns: string, name: string) {
      calls.push("delete");
      return pods.delete(name) ? { ok: true, value: undefined } : err("not-found", 404);
    },
    async podLog(_ns: string, name: string, logOpts: unknown) {
      calls.push(`log ${name} ${JSON.stringify(logOpts)}`);
      return opts.log ?? { ok: true, value: `${JSON.stringify({ v: 1, projects: { [SLUG]: { "MEMORY.md": "m", "a.md": "a" } }, skipped: 0 })}\n` };
    },
  };
  return { client: client as unknown as K8sClient, calls, pods };
}

const settings: Parameters<typeof captureSessionMemories>[0]["settings"] = { image: "ghcr.io/st-john-software/claws:v1", imagePullSecrets: [], nodeSelector: {}, nodes: [], tolerations: [] };

function capture(client: K8sClient, overrides: Partial<Parameters<typeof captureSessionMemories>[0]> = {}) {
  return captureSessionMemories({
    client, ns: "claws-sessions", settings, id: "aa11", endedAt: 5, homeClaimName: "claws-session-aa11",
    now: () => 1000, sleep: async () => {}, ...overrides,
  });
}

describe("captureSessionMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.recordSessionMemoryCapture.mockResolvedValue(true);
    mockDb.noteSessionMemoryCaptureFailed.mockResolvedValue(undefined);
    mockAlerts.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
    mockAlerts.closeAlertIssueIfResolved.mockResolvedValue(null);
  });

  it("runs the capture pod to completion, records its files and deletes the pod", async () => {
    const { client, calls, pods } = fakeClient();

    expect(await capture(client)).toEqual({ ok: true, files: 2, recorded: true });

    expect(calls[0]).toBe("delete");
    expect(calls[1]).toBe("create");
    expect(calls).toContain(`log ${POD} {"container":"session-memory","limitBytes":4194304}`);
    expect(calls.at(-1)).toBe("delete");
    expect(pods.size).toBe(0);
    expect(mockDb.recordSessionMemoryCapture).toHaveBeenCalledWith("aa11", 5, { [SLUG]: { "MEMORY.md": "m", "a.md": "a" } }, 1000);
    expect(mockAlerts.closeAlertIssueIfResolved).toHaveBeenCalledWith(expect.objectContaining({ title: MEMORY_CAPTURE_ALERT_TITLE }));
    expect(mockAlerts.ensureAlertIssue).not.toHaveBeenCalled();
  });

  it("reports a capture discarded by a resume as ok but not recorded", async () => {
    mockDb.recordSessionMemoryCapture.mockResolvedValue(false);
    expect(await capture(fakeClient().client)).toEqual({ ok: true, files: 2, recorded: false });
  });

  it.each([
    ["the pod fails", { phases: ["Failed"] }, "capture pod failed"],
    ["the log read is forbidden", { log: err("forbidden", 403) }, "reading capture pod log: HTTP 403"],
    ["the log is not a dump", { log: { ok: true as const, value: "Error: boom\n" } }, "no valid memory dump"],
    ["the pod never finishes", { phases: ["Pending"] }, "still Pending"],
  ])("when %s: counts an attempt, upserts the one alert issue and deletes the pod", async (_label, clientOpts, message) => {
    const { client, pods } = fakeClient(clientOpts);

    const res = await capture(client, { timeoutMs: 5_000 });

    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toContain(message);
    expect(pods.size).toBe(0);
    expect(mockDb.recordSessionMemoryCapture).not.toHaveBeenCalled();
    expect(mockDb.noteSessionMemoryCaptureFailed).toHaveBeenCalledWith("aa11", 5);
    expect(mockAlerts.ensureAlertIssue).toHaveBeenCalledTimes(1);
    expect(mockAlerts.ensureAlertIssue).toHaveBeenCalledWith(expect.objectContaining({ repo: "St-John-Software/claws", title: MEMORY_CAPTURE_ALERT_TITLE }));
  });

  it("never throws, even when the alert and attempt writes fail", async () => {
    mockDb.noteSessionMemoryCaptureFailed.mockRejectedValue(new Error("db down"));
    mockAlerts.ensureAlertIssue.mockRejectedValue(new Error("forge down"));
    const res = await capture(fakeClient({ phases: ["Failed"] }).client);
    expect(res).toMatchObject({ ok: false });
  });

  it("fails without creating a pod when there is no session image", async () => {
    const { client, calls } = fakeClient();
    expect(await capture(client, { settings: { ...settings, image: "" } })).toMatchObject({ ok: false });
    expect(calls).not.toContain("create");
  });
});

describe("memoryCapturePlacement", () => {
  const toleration = { key: "node-role.kubernetes.io/storage", operator: "Equal" as const, value: "true", effect: "NoSchedule" as const };

  it("keeps the session node selector when no session nodes are listed", () => {
    expect(memoryCapturePlacement({ nodeSelector: { "kubernetes.io/hostname": "k3s" }, nodes: [], tolerations: [toleration] }))
      .toEqual({ nodeSelector: { "kubernetes.io/hostname": "k3s" } });
  });

  it("requires the listed nodes with no preference, leaving the PV's affinity to pick one, and takes the session tolerations", () => {
    expect(memoryCapturePlacement({ nodeSelector: { "kubernetes.io/hostname": "k3s" }, nodes: ["k3s-nas", "k3s"], tolerations: [toleration] })).toEqual({
      tolerations: [toleration],
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: ["k3s-nas", "k3s"] }] }],
          },
        },
      },
    });
  });

  it("puts that placement on the capture pod", async () => {
    let created: K8sObject | undefined;
    const { client } = fakeClient();
    const wrapped = { ...client, create: async (r: string, ns: string, obj: K8sObject) => { created ??= obj; return (client as unknown as { create: (r: string, ns: string, o: K8sObject) => Promise<unknown> }).create(r, ns, obj); } } as unknown as K8sClient;
    await capture(wrapped, { settings: { ...settings, nodes: ["k3s-nas", "k3s"], tolerations: [toleration] } });
    const spec = (created as { spec: Record<string, unknown> }).spec;
    expect(spec).not.toHaveProperty("nodeSelector");
    expect(spec.tolerations).toEqual([toleration]);
    expect(spec).toHaveProperty("affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution");
  });
});

describe("parseMemoryDump", () => {
  it("takes the last non-empty line", () => {
    expect(parseMemoryDump(`noise\n${JSON.stringify({ v: 1, projects: { "-p": { "a.md": "x" } }, skipped: 0 })}\n\n`)).toEqual({ "-p": { "a.md": "x" } });
  });

  it.each([
    ["an empty log", ""],
    ["another version", JSON.stringify({ v: 2, projects: {} })],
    ["a non-string file", JSON.stringify({ v: 1, projects: { "-p": { "a.md": 1 } } })],
    ["a path in a filename", JSON.stringify({ v: 1, projects: { "-p": { "../a.md": "x" } } })],
    ["a path in a slug", JSON.stringify({ v: 1, projects: { "../p": { "a.md": "x" } } })],
    ["a non-.md file", JSON.stringify({ v: 1, projects: { "-p": { "a.sh": "x" } } })],
  ])("rejects %s", (_label, text) => {
    expect(parseMemoryDump(text)).toBeNull();
  });
});
