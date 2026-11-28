import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cfg = vi.hoisted(() => ({
  MIN_WORK_WORKERS: 2,
  MAX_WORK_WORKERS: 12,
  SESSION_POD_SETTINGS: { nodeSelector: { "kubernetes.io/hostname": "k3s" } as Record<string, string> },
  AGENT_POD_SETTINGS: {
    memoryRequest: "1Gi",
    offNode: {
      nodeSelector: {} as Record<string, string> | null,
      tolerations: [
        { key: "node-role.kubernetes.io/gpu", operator: "Equal" as const, value: "true", effect: "NoSchedule" as const },
        { key: "node-role.kubernetes.io/storage", operator: "Equal" as const, value: "true", effect: "NoSchedule" as const },
      ],
      preferredNodes: ["ryzen", "k3s-nas"],
    },
  },
}));
vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), cfg));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import * as log from "./log.js";
import { setNodeAliasesForTest } from "./node-names.js";
import type { K8sClient, K8sNode, K8sPodResources } from "./k8s/api.js";
import {
  computeWorkCapacity,
  fallbackCapacity,
  startWorkCapacityMonitor,
  workCapacityStatus,
  _resetWorkCapacityForTests,
  type WorkFiberTargets,
  sessionNodeMemoryPressure,
} from "./work-capacity.js";

const GI = 1024 ** 3;

function node(name: string, opts: { allocatable: string; ready?: boolean; unschedulable?: boolean; taints?: Array<{ key: string; value?: string; effect: string }> }): K8sNode {
  return {
    metadata: { name, labels: { "kubernetes.io/hostname": name } },
    spec: { unschedulable: opts.unschedulable, taints: opts.taints },
    status: {
      conditions: [{ type: "Ready", status: opts.ready === false ? "Unknown" : "True" }],
      allocatable: { memory: opts.allocatable },
    },
  };
}

function pod(nodeName: string, memory: string, opts: { agent?: boolean; phase?: string; overhead?: string } = {}): K8sPodResources {
  return {
    metadata: { labels: opts.agent ? { "claws-workload": "agent" } : {} },
    spec: { nodeName, containers: [{ resources: { requests: { memory } } }], ...(opts.overhead ? { overhead: { memory: opts.overhead } } : {}) },
    status: { phase: opts.phase ?? "Running" },
  };
}

// The cluster as fleet-infra describes it: k3s always on, ryzen and the NAS
// part-time and tainted so only tolerating pods land there.
const k3s = (ready = true) => node("k3s", { allocatable: "26Gi", ready });
const ryzen = (ready = true) => node("ryzen", { allocatable: "30Gi", ready, taints: [{ key: "node-role.kubernetes.io/gpu", value: "true", effect: "NoSchedule" }] });
const nas = (ready = true) => node("k3s-nas", { allocatable: "60Gi", ready, taints: [{ key: "node-role.kubernetes.io/storage", value: "true", effect: "NoSchedule" }] });

function compute(nodes: K8sNode[], pods: K8sPodResources[] = [], over: Partial<Parameters<typeof computeWorkCapacity>[0]> = {}) {
  return computeWorkCapacity({
    nodes,
    pods,
    memoryRequest: "1Gi",
    sessionSelector: cfg.SESSION_POD_SETTINGS.nodeSelector,
    offNode: cfg.AGENT_POD_SETTINGS.offNode,
    min: 2,
    max: 12,
    now: new Date("2026-10-26T12:00:00Z"),
    ...over,
  });
}

describe("computeWorkCapacity", () => {
  it("bounds the any-kind lane by k3s headroom alone while the part-time nodes are NotReady", () => {
    const snap = compute([k3s(), ryzen(false), nas(false)], [pod("k3s", "16Gi"), pod("k3s", "512Mi")]);
    // (26 − 16.5) GiB / 1 GiB = 9 slots on k3s.
    expect(snap.lanes).toEqual({ anyKind: 9, offNodeOnly: 0 });
    expect(snap.ceiling).toBe(9);
    expect(snap.source).toBe("nodes");
    expect(snap.computedAt).toBe("2026-10-26T12:00:00.000Z");
    expect(snap.nodes).toEqual([
      { name: "k3s", ready: true, schedulable: true, lane: "session", sessionNode: true, allocatableBytes: 26 * GI, requestedBytes: 16.5 * GI, pendingBytes: 0, slots: 9 },
      { name: "ryzen", ready: false, schedulable: true, lane: "off-node", sessionNode: false, allocatableBytes: 30 * GI, requestedBytes: 0, pendingBytes: 0, slots: 0 },
      { name: "k3s-nas", ready: false, schedulable: true, lane: "off-node", sessionNode: false, allocatableBytes: 60 * GI, requestedBytes: 0, pendingBytes: 0, slots: 0 },
    ]);
  });

  it("adds an off-node lane when a tolerated part-time node is Ready, capped by the hard maximum", () => {
    const snap = compute([k3s(), ryzen(), nas(false)], [pod("k3s", "20Gi"), pod("ryzen", "2Gi")]);
    // k3s: 6 slots; ryzen: 28 slots, but only max − 6 = 6 remain.
    expect(snap.lanes).toEqual({ anyKind: 6, offNodeOnly: 6 });
    expect(snap.ceiling).toBe(12);
    expect(snap.nodes.find((n) => n.name === "ryzen")).toMatchObject({ lane: "off-node", slots: 28 });
  });

  it("never lets the off-node lane raise the any-kind lane above k3s headroom", () => {
    const snap = compute([k3s(), ryzen(), nas()], [pod("k3s", "23Gi")], { max: 40 });
    expect(snap.lanes.anyKind).toBe(3);
    expect(snap.lanes.offNodeOnly).toBe(37);
  });

  it("gives a NotReady or cordoned node 0 slots but still lists it", () => {
    const snap = compute([k3s(), node("ryzen", { allocatable: "30Gi", unschedulable: true, taints: ryzen().spec!.taints })]);
    expect(snap.nodes.find((n) => n.name === "ryzen")).toMatchObject({ ready: true, schedulable: false, slots: 0 });
    expect(compute([k3s(false)]).nodes[0]).toMatchObject({ ready: false, slots: 0 });
  });

  it("excludes Claws' own agent pods and finished pods from requested memory, and adds pod overhead", () => {
    const snap = compute([k3s()], [
      pod("k3s", "10Gi"),
      pod("k3s", "1Gi", { agent: true }),
      pod("k3s", "1Gi", { agent: true }),
      pod("k3s", "4Gi", { phase: "Succeeded" }),
      pod("k3s", "4Gi", { phase: "Failed" }),
      pod("k3s", "1Gi", { overhead: "1Gi" }),
    ]);
    expect(snap.nodes[0]!.requestedBytes).toBe(12 * GI);
    expect(snap.lanes.anyKind).toBe(12);
  });

  it("counts an unscheduled pod with no constraints on the session node", () => {
    const snap = compute([k3s()], [pod("k3s", "20Gi"), pod("", "3360Mi", { phase: "Pending" })]);
    // (26 GiB − 20 GiB − 3360 MiB) / 1 GiB = 2 slots, not 6.
    expect(snap.nodes[0]).toMatchObject({ requestedBytes: 20 * GI + 3360 * 1024 ** 2, pendingBytes: 3360 * 1024 ** 2, slots: 2 });
    expect(snap.lanes.anyKind).toBe(2);
  });

  it("counts an unscheduled pod whose affinity excludes the part-time roles on k3s only", () => {
    const p = pod("", "3Gi", { phase: "Pending" });
    p.spec!.affinity = { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [
      { key: "node-role.kubernetes.io/gpu", operator: "DoesNotExist" },
      { key: "node-role.kubernetes.io/storage", operator: "DoesNotExist" },
    ] }] } } };
    // Tolerating every taint, only the affinity keeps it off ryzen and the NAS.
    p.spec!.tolerations = [{ operator: "Exists" }];
    const gpu = ryzen();
    gpu.metadata!.labels!["node-role.kubernetes.io/gpu"] = "true";
    const storage = nas();
    storage.metadata!.labels!["node-role.kubernetes.io/storage"] = "true";
    const snap = compute([k3s(), gpu, storage], [p]);
    expect(snap.nodes.map((n) => n.pendingBytes)).toEqual([3 * GI, 0, 0]);
  });

  it("does not count an unscheduled pod on k3s when its nodeSelector or tolerations point elsewhere", () => {
    const pinned = pod("", "4Gi", { phase: "Pending" });
    pinned.spec!.nodeSelector = { "kubernetes.io/hostname": "k3s-nas" };
    pinned.spec!.tolerations = [{ key: "node-role.kubernetes.io/storage", operator: "Equal", value: "true", effect: "NoSchedule" }];
    expect(compute([k3s(), ryzen(), nas()], [pinned]).nodes.map((n) => n.pendingBytes)).toEqual([0, 0, 4 * GI]);

    // No toleration for ryzen's taint, and an In affinity that rules out k3s.
    const ryzenOnly = pod("", "5Gi", { phase: "Pending" });
    ryzenOnly.spec!.affinity = { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [
      { key: "kubernetes.io/hostname", operator: "In", values: ["ryzen"] },
    ] }] } } };
    expect(compute([k3s(), ryzen(), nas()], [ryzenOnly]).nodes.map((n) => n.pendingBytes)).toEqual([0, 0, 0]);
  });

  it("matches pod tolerations by Exists key, Equal value and any effect when unset", () => {
    const tolerant = (t: NonNullable<NonNullable<K8sPodResources["spec"]>["tolerations"]>) => {
      const p = pod("", "1Gi", { phase: "Pending" });
      p.spec!.tolerations = t;
      return compute([nas()], [p]).nodes[0]!.pendingBytes;
    };
    expect(tolerant([{ key: "node-role.kubernetes.io/storage", operator: "Exists" }])).toBe(GI);
    expect(tolerant([{ key: "node-role.kubernetes.io/storage", value: "true" }])).toBe(GI);
    expect(tolerant([{ key: "node-role.kubernetes.io/storage", value: "false" }])).toBe(0);
    expect(tolerant([{ key: "node-role.kubernetes.io/storage", operator: "Exists", effect: "NoExecute" }])).toBe(0);
  });

  it("never counts an unscheduled agent pod or a finished unscheduled pod", () => {
    const snap = compute([k3s()], [
      pod("", "1Gi", { agent: true, phase: "Pending" }),
      pod("", "4Gi", { phase: "Succeeded" }),
      pod("", "4Gi", { phase: "Failed" }),
    ]);
    expect(snap.nodes[0]).toMatchObject({ requestedBytes: 0, pendingBytes: 0, slots: 26 });
  });

  it("adds a scheduled large agent pod's excess over the default request to its node only", () => {
    const snap = compute([k3s(), ryzen(), nas()], [pod("ryzen", "6Gi", { agent: true }), pod("ryzen", "1Gi", { agent: true })]);
    // ryzen: 30 GiB − (6 − 1) GiB excess = 25 slots; the default-sized pod stays excluded.
    expect(snap.nodes.find((n) => n.name === "ryzen")).toMatchObject({ requestedBytes: 5 * GI, pendingBytes: 0, slots: 25 });
    expect(snap.nodes.find((n) => n.name === "k3s")).toMatchObject({ requestedBytes: 0, slots: 26 });
  });

  it("adds an unscheduled large agent pod's excess to every node its required affinity allows", () => {
    const large: K8sPodResources = {
      metadata: { labels: { "claws-workload": "agent" } },
      spec: {
        containers: [{ resources: { requests: { memory: "6Gi" } } }],
        tolerations: cfg.AGENT_POD_SETTINGS.offNode.tolerations,
        affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: ["ryzen", "k3s-nas"] }] }] } } },
      },
      status: { phase: "Pending" },
    };
    const snap = compute([k3s(), ryzen(), nas()], [large]);
    expect(snap.nodes.find((n) => n.name === "k3s")).toMatchObject({ requestedBytes: 0, pendingBytes: 0 });
    expect(snap.nodes.find((n) => n.name === "ryzen")).toMatchObject({ requestedBytes: 5 * GI, pendingBytes: 5 * GI, slots: 25 });
    expect(snap.nodes.find((n) => n.name === "k3s-nas")).toMatchObject({ requestedBytes: 5 * GI, pendingBytes: 5 * GI, slots: 55 });
  });

  it("counts an init container that requests more than the app containers", () => {
    const p = pod("k3s", "1Gi");
    p.spec!.initContainers = [{ resources: { requests: { memory: "6Gi" } } }];
    expect(compute([k3s()], [p]).nodes[0]!.requestedBytes).toBe(6 * GI);
  });

  it("adds a native sidecar's request to the app containers", () => {
    const p = pod("k3s", "256Mi");
    p.spec!.initContainers = [{ restartPolicy: "Always", resources: { requests: { memory: "3Gi" } } }];
    expect(compute([k3s()], [p]).nodes[0]!.requestedBytes).toBe(3 * GI + 256 * 1024 * 1024);
  });

  it("stacks an ordinary init container on the sidecars declared before it", () => {
    const p = pod("k3s", "256Mi");
    p.spec!.initContainers = [
      { restartPolicy: "Always", resources: { requests: { memory: "1Gi" } } },
      { resources: { requests: { memory: "6Gi" } } },
    ];
    expect(compute([k3s()], [p]).nodes[0]!.requestedBytes).toBe(7 * GI);
  });

  it("puts a node with an untolerated taint in no lane", () => {
    const gpuOnly = { ...cfg.AGENT_POD_SETTINGS.offNode, tolerations: [cfg.AGENT_POD_SETTINGS.offNode.tolerations[0]!] };
    const snap = compute([k3s(), ryzen(), nas()], [], { offNode: gpuOnly });
    expect(snap.nodes.map((n) => n.lane)).toEqual(["session", "off-node", "none"]);
  });

  it("matches an Exists toleration on the key alone, and only the same effect", () => {
    const exists = { nodeSelector: {}, preferredNodes: [], tolerations: [{ key: "node-role.kubernetes.io/storage", operator: "Exists" as const, effect: "NoSchedule" as const }] };
    expect(compute([nas()], [], { offNode: exists }).nodes[0]!.lane).toBe("off-node");
    const noExecute = { ...exists, tolerations: [{ ...exists.tolerations[0]!, effect: "NoExecute" as const }] };
    expect(compute([nas()], [], { offNode: noExecute }).nodes[0]!.lane).toBe("none");
  });

  it("has no off-node lane when no off-node placement is configured", () => {
    const snap = compute([k3s(), ryzen(), nas()], [], { offNode: null });
    expect(snap.nodes.map((n) => n.lane)).toEqual(["session", "none", "none"]);
    expect(snap.lanes.offNodeOnly).toBe(0);
  });

  it("applies the off-node selector when one is set", () => {
    const onlyNas = { ...cfg.AGENT_POD_SETTINGS.offNode, nodeSelector: { "kubernetes.io/hostname": "k3s-nas" } };
    expect(compute([k3s(), ryzen(), nas()], [], { offNode: onlyNas }).nodes.map((n) => n.lane)).toEqual(["session", "none", "off-node"]);
  });

  it("clamps the any-kind lane to the minimum and maximum", () => {
    expect(compute([k3s()], [pod("k3s", "26Gi")]).lanes.anyKind).toBe(2);
    expect(compute([k3s()], [], { max: 4 }).lanes).toEqual({ anyKind: 4, offNodeOnly: 0 });
    // A minimum above the maximum is held at the maximum.
    expect(compute([], [], { min: 6, max: 4 })).toMatchObject({ min: 4, max: 4, ceiling: 4 });
  });

  it("throws on an unusable agent pod memory request", () => {
    expect(() => compute([k3s()], [], { memoryRequest: "0" })).toThrow(/not a positive quantity/);
    expect(() => compute([k3s()], [], { memoryRequest: "lots" })).toThrow(/not a positive quantity/);
  });
});

describe("computeWorkCapacity with several session nodes", () => {
  const storageToleration = { key: "node-role.kubernetes.io/storage", operator: "Equal" as const, value: "true", effect: "NoSchedule" as const };
  const twoNodes = { sessionNodes: ["k3s-nas", "k3s"], sessionTolerations: [storageToleration] };
  // A pending session pod as `sessionPodPlacement` builds it with both nodes listed.
  const pendingSession = (memory: string): K8sPodResources => ({
    metadata: { labels: { "claws-workload": "session" } },
    spec: {
      nodeName: "",
      tolerations: [storageToleration],
      affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: ["k3s-nas", "k3s"] }] }] } } },
      containers: [{ resources: { requests: { memory } } }],
    },
    status: { phase: "Pending" },
  });

  it("marks both listed nodes as session nodes while the tainted NAS stays in the off-node lane", () => {
    const snap = compute([k3s(), ryzen(), nas()], [], twoNodes);
    expect(snap.nodes.map((n) => [n.name, n.lane, n.sessionNode])).toEqual([
      ["k3s", "session", true],
      ["ryzen", "off-node", false],
      ["k3s-nas", "off-node", true],
    ]);
  });

  it("counts a session pod running on the NAS against the NAS only", () => {
    const snap = compute([k3s(), nas()], [pod("k3s-nas", "768Mi")], twoNodes);
    expect(snap.nodes.find((n) => n.name === "k3s-nas")).toMatchObject({ requestedBytes: 768 * 1024 ** 2, pendingBytes: 0 });
    expect(snap.nodes.find((n) => n.name === "k3s")).toMatchObject({ requestedBytes: 0 });
  });

  it("counts a pending session pod on both session nodes", () => {
    const snap = compute([k3s(), ryzen(), nas()], [pendingSession("2Gi")], twoNodes);
    expect(snap.nodes.find((n) => n.name === "k3s")).toMatchObject({ pendingBytes: 2 * GI });
    expect(snap.nodes.find((n) => n.name === "k3s-nas")).toMatchObject({ pendingBytes: 2 * GI });
    expect(snap.nodes.find((n) => n.name === "ryzen")).toMatchObject({ pendingBytes: 0 });
  });

  it("does not treat a listed node as a session node when the session tolerations miss its taint", () => {
    const snap = compute([k3s(), nas()], [], { sessionNodes: ["k3s-nas", "k3s"] });
    expect(snap.nodes.find((n) => n.name === "k3s-nas")).toMatchObject({ sessionNode: false });
  });

  describe("across a node rename (#clw_01M7RBFFEM2C6DQD1C3Z3EAEZ8)", () => {
    beforeEach(() => setNodeAliasesForTest(new Map([["k3s", "thinkcentre"], ["k3s-nas", "nas"]])));
    afterEach(() => setNodeAliasesForTest(null));
    const renamed = { sessionNodes: ["nas", "thinkcentre"], sessionTolerations: [storageToleration] };
    const thinkcentre = (ready = true) => node("thinkcentre", { allocatable: "26Gi", ready });

    it("reports a lingering NotReady old Node beside its Ready new one as one Ready node", () => {
      for (const order of [[k3s(false), thinkcentre()], [thinkcentre(), k3s(false)]]) {
        const snap = compute(order, [], renamed);
        expect(snap.nodes.map((n) => [n.name, n.ready, n.sessionNode])).toEqual([["thinkcentre", true, true]]);
      }
    });

    it("reports a node still under its old name by its new one, and counts pods on it there", () => {
      const snap = compute([k3s(), nas()], [pod("k3s-nas", "768Mi"), pendingSession("2Gi")], renamed);
      expect(snap.nodes.map((n) => [n.name, n.sessionNode])).toEqual([["thinkcentre", true], ["nas", true]]);
      expect(snap.nodes.find((n) => n.name === "nas")).toMatchObject({ requestedBytes: 768 * 1024 ** 2 + 2 * GI, pendingBytes: 2 * GI });
      expect(snap.nodes.find((n) => n.name === "thinkcentre")).toMatchObject({ pendingBytes: 2 * GI });
    });
  });
});

describe("fallbackCapacity", () => {
  it("pins the ceiling at the minimum, any-kind only", () => {
    expect(fallbackCapacity(2, 12, "GET /api/v1/nodes: HTTP 403", new Date("2026-10-26T12:00:00Z"))).toEqual({
      ceiling: 2, min: 2, max: 12, lanes: { anyKind: 2, offNodeOnly: 0 }, nodes: [],
      source: "fallback", computedAt: "2026-10-26T12:00:00.000Z", error: "GET /api/v1/nodes: HTTP 403",
    });
  });
});

describe("startWorkCapacityMonitor", () => {
  let nodesResult: Awaited<ReturnType<K8sClient["listNodes"]>>;
  let applied: WorkFiberTargets[];
  let stop: () => void;
  const client = {
    listNodes: async () => nodesResult,
    listPodsAllNamespaces: async () => ({ ok: true as const, value: [pod("k3s", "16Gi")] }),
  } as unknown as K8sClient;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetWorkCapacityForTests();
    vi.mocked(log.warn).mockClear();
    applied = [];
    nodesResult = { ok: true, value: [k3s(), ryzen(false), nas(false)] };
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it("applies the targets at once and again each interval, growing and shrinking with node readiness", async () => {
    stop = startWorkCapacityMonitor(client, (t) => applied.push(t), { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([{ anyKind: 10, offNodeOnly: 0 }]);
    expect(workCapacityStatus()).toMatchObject({ ceiling: 10, source: "nodes" });

    nodesResult = { ok: true, value: [k3s(), ryzen(), nas(false)] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(applied.at(-1)).toEqual({ anyKind: 10, offNodeOnly: 2 });

    nodesResult = { ok: true, value: [k3s(), ryzen(false), nas(false)] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(applied.at(-1)).toEqual({ anyKind: 10, offNodeOnly: 0 });
  });

  it("falls back to the minimum on a failed node read and warns at most once per 15 minutes", async () => {
    nodesResult = { ok: false, kind: "forbidden", status: 403, applied: "no", message: "GET /api/v1/nodes: HTTP 403" };
    stop = startWorkCapacityMonitor(client, (t) => applied.push(t), { intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([{ anyKind: 2, offNodeOnly: 0 }]);
    expect(workCapacityStatus()).toMatchObject({ source: "fallback", ceiling: 2, error: "GET /api/v1/nodes: HTTP 403" });
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(2);

    // Recovery resumes sizing from the nodes.
    nodesResult = { ok: true, value: [k3s()] };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applied.at(-1)).toEqual({ anyKind: 10, offNodeOnly: 0 });
  });

  it("stops applying targets once stopped", async () => {
    stop = startWorkCapacityMonitor(client, (t) => applied.push(t), { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(applied).toHaveLength(1);
  });
});

describe("sessionNodeMemoryPressure", () => {
  // memoryRequest 1Gi, k3s allocatable 26Gi → slots = free GiB; min 2.
  const pressure = (nodes: K8sNode[], pods: K8sPodResources[] = []) => sessionNodeMemoryPressure(compute(nodes, pods));

  it("reports the node when slots are below min", () => {
    expect(pressure([k3s()], [pod("k3s", "25Gi")])).toEqual({ node: "k3s", allocatableBytes: 26 * GI, requestedBytes: 25 * GI, freeBytes: GI });
  });
  it("is null when slots equal or exceed min", () => {
    expect(pressure([k3s()], [pod("k3s", "24Gi")])).toBeNull();
    expect(pressure([k3s()], [pod("k3s", "10Gi")])).toBeNull();
  });
  it("is null for no snapshot, a fallback snapshot, NotReady, cordoned, zero allocatable or no session lane", () => {
    expect(sessionNodeMemoryPressure(null)).toBeNull();
    expect(sessionNodeMemoryPressure(fallbackCapacity(2, 12, "boom"))).toBeNull();
    expect(pressure([k3s(false)], [pod("k3s", "25Gi")])).toBeNull();
    expect(pressure([node("k3s", { allocatable: "26Gi", unschedulable: true })], [pod("k3s", "25Gi")])).toBeNull();
    expect(pressure([node("k3s", { allocatable: "0" })])).toBeNull();
    expect(pressure([nas()])).toBeNull();
  });

  describe("with two session nodes", () => {
    const storageToleration = { key: "node-role.kubernetes.io/storage", operator: "Equal" as const, value: "true", effect: "NoSchedule" as const };
    const pressureTwo = (nodes: K8sNode[], pods: K8sPodResources[] = []) =>
      sessionNodeMemoryPressure(compute(nodes, pods, { sessionNodes: ["k3s-nas", "k3s"], sessionTolerations: [storageToleration] }));

    it("does not warn when k3s is full but the NAS has room", () => {
      expect(pressureTwo([k3s(), nas()], [pod("k3s", "25Gi")])).toBeNull();
    });
    it("does not warn when the NAS is full but k3s has room", () => {
      expect(pressureTwo([k3s(), nas()], [pod("k3s-nas", "59Gi")])).toBeNull();
    });
    it("warns with the roomier node when both are full", () => {
      expect(pressureTwo([k3s(), nas()], [pod("k3s", "25.5Gi"), pod("k3s-nas", "59Gi")]))
        .toEqual({ node: "k3s-nas", allocatableBytes: 60 * GI, requestedBytes: 59 * GI, freeBytes: GI });
    });
    it("warns on k3s when the NAS is down", () => {
      expect(pressureTwo([k3s(), nas(false)], [pod("k3s", "25Gi")])).toMatchObject({ node: "k3s" });
    });
  });
});
