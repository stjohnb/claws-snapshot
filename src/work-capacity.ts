import { parseK8sMemoryQuantity } from "./agent-memory-budget.js";
import { AGENT_POD_SETTINGS, MAX_WORK_WORKERS, MIN_WORK_WORKERS, SESSION_POD_SETTINGS, type AgentPodOffNodePlacement, type AgentPodToleration } from "./config.js";
import type { K8sClient, K8sNode, K8sPodResources, K8sToleration } from "./k8s/api.js";
import { AGENT_WORKLOAD_KIND, LABEL_WORKLOAD } from "./k8s/workload.js";
import * as log from "./log.js";

// Sizes the `k8s-pod` headless fiber lanes from live node capacity
// (#clw_01M5WYJ0PXDD74T9E1EFHZE9NP). Every minute the monitor lists the
// cluster's nodes and the memory already requested on them, and the worker
// grows or shrinks its claiming fibers to match, between MIN_WORK_WORKERS and
// MAX_WORK_WORKERS. Two lanes:
//   - any-kind fibers, sized from the session-placement node(s), whose
//     headroom bounds every kind when the part-time nodes are down;
//   - off-node-only fibers, sized from the part-time nodes every headless
//     kind's pod may use. Despite the name they now claim every kind
//     (#clw_01M5ZCYHRJ9SPXX78HFC21J6GK); only their sizing differs.

/** How often the monitor re-reads node capacity. */
export const WORK_CAPACITY_INTERVAL_MS = 60_000;
/** A failed node read logs a warning at most this often. */
const FAILURE_WARN_INTERVAL_MS = 15 * 60_000;

/** Cluster-scoped reads the monitor needs; the connectivity verifier reviews them with `namespace: ""`. */
export const WORK_CAPACITY_RBAC: ReadonlyArray<{ resource: string; verbs: readonly string[] }> = [
  { resource: "nodes", verbs: ["list"] },
  { resource: "pods", verbs: ["list"] },
];

export type WorkCapacityLane = "session" | "off-node" | "none";

export interface WorkCapacityNode {
  name: string;
  ready: boolean;
  schedulable: boolean;
  lane: WorkCapacityLane;
  /** Whether new session pods may run here: listed in `CLAWS_SESSION_NODES`, else matching the session selector. */
  sessionNode: boolean;
  allocatableBytes: number;
  /**
   * Memory requested by pods on the node, Claws' own agent pods excluded
   * (except a large-class pod's excess over the default request), plus every
   * unscheduled pod that could be placed here.
   */
  requestedBytes: number;
  /** The unscheduled pods' share of `requestedBytes`. */
  pendingBytes: number;
  slots: number;
}

export interface WorkFiberTargets {
  /** Fibers that claim any kind; sized from the session-placement node(s). */
  anyKind: number;
  /** Fibers sized from the part-time nodes; they claim every kind, like `anyKind`. */
  offNodeOnly: number;
}

export interface WorkCapacitySnapshot {
  /** anyKind + offNodeOnly: how many headless runs may be claimed at once, besides the express fiber. */
  ceiling: number;
  min: number;
  max: number;
  lanes: WorkFiberTargets;
  nodes: WorkCapacityNode[];
  /** `fallback` when the node read failed and the ceiling is pinned at the minimum. */
  source: "nodes" | "fallback";
  computedAt: string;
  error?: string;
}

export interface WorkCapacityInput {
  nodes: readonly K8sNode[];
  pods: readonly K8sPodResources[];
  /** `CLAWS_AGENT_POD_MEMORY_REQUEST`, a Kubernetes quantity. */
  memoryRequest: string;
  /** `CLAWS_SESSION_NODE_SELECTOR`; the session-node test when `sessionNodes` is empty. */
  sessionSelector: Readonly<Record<string, string>>;
  /** `CLAWS_SESSION_NODES`; non-empty, it replaces the selector as the session-node test. */
  sessionNodes?: readonly string[];
  /** `CLAWS_SESSION_TOLERATIONS`; the hard taints a session node may carry. */
  sessionTolerations?: readonly AgentPodToleration[];
  /** `AGENT_POD_SETTINGS.offNode`; null means no off-node lane. */
  offNode: AgentPodOffNodePlacement | null;
  min: number;
  max: number;
  now?: Date;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function matchesSelector(labels: Readonly<Record<string, string>>, selector: Readonly<Record<string, string>>): boolean {
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

/** Taints that keep a pod without a matching toleration off the node. */
function hardTaints(node: K8sNode) {
  return (node.spec?.taints ?? []).filter((t) => t.effect === "NoSchedule" || t.effect === "NoExecute");
}

function tolerates(tolerations: readonly AgentPodToleration[], taint: { key: string; value?: string; effect: string }): boolean {
  return tolerations.some((t) =>
    t.key === taint.key &&
    t.effect === taint.effect &&
    (t.operator === "Exists" || (t.value ?? "") === (taint.value ?? "")));
}

/** Pod-toleration matching: an empty-key `Exists` tolerates all, an empty effect matches any effect. */
function podTolerates(tolerations: readonly K8sToleration[], taint: { key: string; value?: string; effect: string }): boolean {
  return tolerations.some((t) => {
    if (t.effect && t.effect !== taint.effect) return false;
    if (t.operator === "Exists") return !t.key || t.key === taint.key;
    return t.key === taint.key && (t.value ?? "") === (taint.value ?? "");
  });
}

/**
 * Whether the scheduler could place the unscheduled `pod` on `node`: its
 * `nodeSelector` matches, one required node-affinity term (ORed; expressions
 * ANDed) matches, and it tolerates every hard taint. `Gt`, `Lt` and
 * `matchFields` are treated as matching, which only ever lowers slots.
 */
function podFitsNode(pod: K8sPodResources, node: K8sNode): boolean {
  const labels = node.metadata?.labels ?? {};
  const spec = pod.spec ?? {};
  if (!matchesSelector(labels, spec.nodeSelector ?? {})) return false;
  const terms = spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (terms && terms.length > 0) {
    const termMatches = (term: (typeof terms)[number]) => (term.matchExpressions ?? []).every((e) => {
      const value = labels[e.key];
      switch (e.operator) {
        case "In": return value !== undefined && (e.values ?? []).includes(value);
        case "NotIn": return value === undefined || !(e.values ?? []).includes(value);
        case "Exists": return value !== undefined;
        case "DoesNotExist": return value === undefined;
        default: return true;
      }
    });
    if (!terms.some(termMatches)) return false;
  }
  const tolerations = spec.tolerations ?? [];
  return hardTaints(node).every((t) => podTolerates(tolerations, t));
}

/**
 * Whether new session pods may run on `node`: its hostname is in
 * `sessionNodes` when that list is non-empty, else it matches
 * `sessionSelector`; either way the session tolerations cover its hard taints.
 */
function isSessionNode(
  node: K8sNode,
  sessionSelector: Readonly<Record<string, string>>,
  sessionNodes: readonly string[],
  sessionTolerations: readonly AgentPodToleration[],
): boolean {
  const labels = node.metadata?.labels ?? {};
  const placed = sessionNodes.length === 0
    ? matchesSelector(labels, sessionSelector)
    : sessionNodes.includes(labels["kubernetes.io/hostname"] ?? node.metadata?.name ?? "");
  return placed && hardTaints(node).every((t) => tolerates(sessionTolerations, t));
}

function laneOf(node: K8sNode, sessionNode: boolean, sessionSelector: Readonly<Record<string, string>>, offNode: AgentPodOffNodePlacement | null): WorkCapacityLane {
  const labels = node.metadata?.labels ?? {};
  const taints = hardTaints(node);
  if (sessionNode && taints.length === 0) return "session";
  if (!offNode) return "none";
  // A null off-node selector keeps the session selector; `{}` matches every node.
  if (!matchesSelector(labels, offNode.nodeSelector ?? sessionSelector)) return "none";
  return taints.every((t) => tolerates(offNode.tolerations, t)) ? "off-node" : "none";
}

function isReady(node: K8sNode): boolean {
  return (node.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
}

function podRequestedBytes(pod: K8sPodResources): number {
  const spec = pod.spec ?? {};
  const memory = (c: { resources?: { requests?: { memory?: string } } }) => parseK8sMemoryQuantity(c.resources?.requests?.memory) ?? 0;
  // Mirrors the scheduler: native sidecars (init containers with
  // restartPolicy Always) keep running beside the app containers, so their
  // requests add to the app sum; an ordinary init container peaks on top of
  // the sidecars started before it. Plus the RuntimeClass overhead.
  const containers = (spec.containers ?? []).reduce((acc, c) => acc + memory(c), 0);
  let sidecarSum = 0;
  let initPeak = 0;
  for (const c of spec.initContainers ?? []) {
    if (c.restartPolicy === "Always") sidecarSum += memory(c);
    else initPeak = Math.max(initPeak, memory(c) + sidecarSum);
  }
  return Math.max(containers + sidecarSum, initPeak, sidecarSum) + (parseK8sMemoryQuantity(spec.overhead?.memory) ?? 0);
}

/**
 * Derive the headless fiber lanes from node capacity. Per node: requested =
 * the memory requests of its non-terminal pods plus those of every
 * unscheduled pod it could take (a pod's nodeSelector, required node affinity
 * and tolerations), Claws' own agent pods excluded either way (so the result
 * does not depend on how many already run) except that an agent pod whose
 * request exceeds `memoryRequest` (a large-class pod) adds that excess; slots =
 * floor((allocatable − requested) / memoryRequest), 0 when the node is
 * NotReady or cordoned. `anyKind = clamp(sessionSlots, min, max)`,
 * `offNodeOnly = clamp(offNodeSlots, 0, max − anyKind)`. Throws when
 * `memoryRequest` is not a positive quantity.
 */
export function computeWorkCapacity(input: WorkCapacityInput): WorkCapacitySnapshot {
  const perPod = parseK8sMemoryQuantity(input.memoryRequest);
  if (!perPod || perPod <= 0) throw new Error(`agent pod memory request "${input.memoryRequest}" is not a positive quantity`);
  const max = Math.max(0, input.max);
  const min = clamp(input.min, 0, max);

  const requestedByNode = new Map<string, number>();
  const pendingByNode = new Map<string, number>();
  const add = (map: Map<string, number>, name: string, bytes: number) => map.set(name, (map.get(name) ?? 0) + bytes);
  for (const pod of input.pods) {
    const phase = pod.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") continue;
    let bytes = podRequestedBytes(pod);
    // An agent pod at the default request is a fiber's own slot; a larger
    // (large-class) one also takes its excess from the node.
    if (pod.metadata?.labels?.[LABEL_WORKLOAD] === AGENT_WORKLOAD_KIND) {
      if (bytes <= perPod) continue;
      bytes -= perPod;
    }
    const nodeName = pod.spec?.nodeName;
    if (nodeName) {
      add(requestedByNode, nodeName, bytes);
      continue;
    }
    // An unscheduled pod (e.g. one preempted and waiting for room) counts on
    // every node it could land on, so its memory is not handed to agents.
    for (const node of input.nodes) {
      const name = node.metadata?.name;
      if (!name || !podFitsNode(pod, node)) continue;
      add(requestedByNode, name, bytes);
      add(pendingByNode, name, bytes);
    }
  }

  let sessionSlots = 0;
  let offNodeSlots = 0;
  const nodes = input.nodes.map((node): WorkCapacityNode => {
    const name = node.metadata?.name ?? "";
    const ready = isReady(node);
    const schedulable = node.spec?.unschedulable !== true;
    const sessionNode = isSessionNode(node, input.sessionSelector, input.sessionNodes ?? [], input.sessionTolerations ?? []);
    const lane = laneOf(node, sessionNode, input.sessionSelector, input.offNode);
    const allocatableBytes = parseK8sMemoryQuantity(node.status?.allocatable?.memory) ?? 0;
    const requestedBytes = requestedByNode.get(name) ?? 0;
    const pendingBytes = pendingByNode.get(name) ?? 0;
    // A session node outside both lanes still reports slots, for the New session memory warning.
    const slots = ready && schedulable && (lane !== "none" || sessionNode)
      ? Math.floor(Math.max(0, allocatableBytes - requestedBytes) / perPod)
      : 0;
    if (lane === "session") sessionSlots += slots;
    else if (lane === "off-node") offNodeSlots += slots;
    return { name, ready, schedulable, lane, sessionNode, allocatableBytes, requestedBytes, pendingBytes, slots };
  });

  const anyKind = clamp(sessionSlots, min, max);
  const offNodeOnly = clamp(offNodeSlots, 0, max - anyKind);
  return {
    ceiling: anyKind + offNodeOnly,
    min,
    max,
    lanes: { anyKind, offNodeOnly },
    nodes,
    source: "nodes",
    computedAt: (input.now ?? new Date()).toISOString(),
  };
}

/** The snapshot when the node read failed: the minimum, any-kind only, so work neither stops nor runs unbounded. */
export function fallbackCapacity(min: number, max: number, error: string, now: Date = new Date()): WorkCapacitySnapshot {
  const hi = Math.max(0, max);
  const lo = clamp(min, 0, hi);
  return {
    ceiling: lo,
    min: lo,
    max: hi,
    lanes: { anyKind: lo, offNodeOnly: 0 },
    nodes: [],
    source: "fallback",
    computedAt: now.toISOString(),
    error,
  };
}

let latest: WorkCapacitySnapshot | null = null;

/** The latest snapshot, or null before the first tick (and always under `in-process`). */
export function workCapacityStatus(): WorkCapacitySnapshot | null {
  return latest;
}

/** One read of nodes and pods; rejects with a log-safe message on failure. */
async function readCapacity(client: K8sClient): Promise<WorkCapacitySnapshot> {
  const [nodes, pods] = await Promise.all([
    client.listNodes(),
    client.listPodsAllNamespaces("status.phase!=Succeeded,status.phase!=Failed"),
  ]);
  if (!nodes.ok) throw new Error(nodes.message);
  if (!pods.ok) throw new Error(pods.message);
  return computeWorkCapacity({
    nodes: nodes.value,
    pods: pods.value,
    memoryRequest: AGENT_POD_SETTINGS.memoryRequest,
    sessionSelector: SESSION_POD_SETTINGS.nodeSelector,
    sessionNodes: SESSION_POD_SETTINGS.nodes,
    sessionTolerations: SESSION_POD_SETTINGS.tolerations,
    offNode: AGENT_POD_SETTINGS.offNode,
    // Read live, so a config-file edit applies at the next tick.
    min: MIN_WORK_WORKERS,
    max: MAX_WORK_WORKERS,
  });
}

/**
 * `k8s-pod`: recompute the lanes now and every `WORK_CAPACITY_INTERVAL_MS`,
 * handing each result to `applyTargets` (the worker's `setFiberTargets`). A
 * failed read applies the minimum and warns at most once per 15 minutes.
 * Returns a stop function.
 */
export function startWorkCapacityMonitor(
  client: K8sClient,
  applyTargets: (targets: WorkFiberTargets) => void,
  opts: { intervalMs?: number; now?: () => number } = {},
): () => void {
  const now = opts.now ?? Date.now;
  let stopped = false;
  let running = false;
  let lastWarnAt = -Infinity;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      let snapshot: WorkCapacitySnapshot;
      try {
        snapshot = await readCapacity(client);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        snapshot = fallbackCapacity(MIN_WORK_WORKERS, MAX_WORK_WORKERS, message);
        if (now() - lastWarnAt >= FAILURE_WARN_INTERVAL_MS) {
          lastWarnAt = now();
          log.warn(`[work-capacity] Could not read node capacity — holding headless concurrency at the minimum ${snapshot.ceiling}: ${message}`);
        }
      }
      if (stopped) return;
      const previous = latest;
      latest = snapshot;
      if (!previous || previous.lanes.anyKind !== snapshot.lanes.anyKind || previous.lanes.offNodeOnly !== snapshot.lanes.offNodeOnly) {
        log.info(`[work-capacity] Headless ceiling ${snapshot.ceiling} (any-kind ${snapshot.lanes.anyKind}, off-node ${snapshot.lanes.offNodeOnly}; min ${snapshot.min}, max ${snapshot.max}; ${snapshot.source})`);
      }
      applyTargets(snapshot.lanes);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, opts.intervalMs ?? WORK_CAPACITY_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** @internal — tests only. */
export function _resetWorkCapacityForTests(): void {
  latest = null;
}

export interface SessionNodeMemoryPressure {
  node: string;
  allocatableBytes: number;
  requestedBytes: number;
  freeBytes: number;
}

/**
 * Memory pressure on every session node, for the New session form's warning:
 * the Ready, schedulable session node (`sessionNode`) with the most free memory
 * has fewer `slots` than the snapshot's `min`, so a new session has nowhere
 * roomy to go. Null when the snapshot is missing or a fallback, no schedulable
 * Ready session node reports memory, or that node has headroom.
 */
export function sessionNodeMemoryPressure(snapshot: WorkCapacitySnapshot | null): SessionNodeMemoryPressure | null {
  if (!snapshot || snapshot.source !== "nodes") return null;
  const candidates = snapshot.nodes.filter((n) => n.sessionNode && n.ready && n.schedulable && n.allocatableBytes > 0);
  if (candidates.length === 0) return null;
  const free = (n: WorkCapacityNode) => Math.max(0, n.allocatableBytes - n.requestedBytes);
  const best = candidates.reduce((a, b) => (free(b) > free(a) ? b : a));
  if (best.slots >= snapshot.min) return null;
  return { node: best.name, allocatableBytes: best.allocatableBytes, requestedBytes: best.requestedBytes, freeBytes: free(best) };
}
