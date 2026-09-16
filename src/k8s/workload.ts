import type { K8sObject } from "./api.js";

// Pure Kubernetes workload primitives for Claws-managed pods (#3026): naming,
// labels, object builders, pod classification and the reconcile plan. No I/O —
// callers feed API results in and apply the plan through `k8s/api.ts`. Written
// for interactive session pods but keyed by a workload `kind`, so another
// long-lived workload type can reuse them.

export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const LABEL_WORKLOAD = "claws-workload";
export const LABEL_WORKLOAD_ID = "claws-workload-id";

/** HOME inside a workload pod; the workload's PVC is mounted here. */
export const WORKLOAD_HOME = "/home/claws";
/** In-memory emptyDir for runtime files (0600 env file, SSH material, `gh` shim). */
export const WORKLOAD_RUNTIME_DIR = "/run/claws";
/** Where the workload Secret's projected items are mounted, in both containers. */
export const WORKLOAD_SECRET_DIR = "/etc/claws-workload";
export const WORKLOAD_PORT = 7681;
/** uid/gid of the `claws` user in the Claws image. */
export const WORKLOAD_UID = 1000;
/** Compiled entry point of the in-pod runtime (`src/session-pod/main.ts`). */
export const SESSION_POD_ENTRY = "/opt/claws/dist/session-pod/main.js";

/** Secret key holding the launch spec — the only key besides the clone env the init container sees. */
export const LAUNCH_SPEC_KEY = "launch.json";
/** Secret key holding clone credentials; projected into the init container only. */
export const CLONE_ENV_KEY = "clone-env.json";
/** Secret key holding the bearer token the terminal server requires. */
export const TERMINAL_TOKEN_KEY = "terminal-token";
/** Secret key holding the bearer token the session's `claws-state` MCP endpoint in Claws requires (#3056). */
export const MCP_TOKEN_KEY = "mcp-token";
/** Secret key holding a GitHub App installation token, refreshed in place by patching the Secret. */
export const GITHUB_TOKEN_KEY = "github-token";
/**
 * Secret key of the env file for capabilities granted to a running session
 * (#3072). Present from launch, because the pod's Secret volume lists its
 * `items` explicitly and a key added later is never mounted.
 */
export const GRANTED_ENV_KEY = "granted-env";

/** Secret key of the kubeconfig slot for a capability granted mid-session (#3072). */
export function grantedKubeconfigKey(capId: string): string {
  return `granted-kubeconfig-${capId}`;
}

const SECRET_FILE_MODE = 0o440;

/** `claws-<kind>-<id>` — the shared name of a workload's Pod, Service, Secret and PVC. */
export function workloadName(kind: string, id: string): string {
  return `claws-${kind}-${id}`;
}

export function workloadLabels(kind: string, id: string): Record<string, string> {
  return { [LABEL_MANAGED_BY]: "claws", [LABEL_WORKLOAD]: kind, [LABEL_WORKLOAD_ID]: id };
}

/** Label selector for every workload of `kind`, or for one workload when `id` is given. */
export function workloadSelector(kind: string, id?: string): string {
  const parts = [`${LABEL_MANAGED_BY}=claws`, `${LABEL_WORKLOAD}=${kind}`];
  if (id !== undefined) parts.push(`${LABEL_WORKLOAD_ID}=${id}`);
  return parts.join(",");
}

interface WorkloadRef {
  kind: string;
  id: string;
  namespace: string;
}

function metadata(ref: WorkloadRef): K8sObject["metadata"] {
  return { name: workloadName(ref.kind, ref.id), namespace: ref.namespace, labels: workloadLabels(ref.kind, ref.id) };
}

/** Opaque Secret; string values are base64-encoded into `data`. */
export function buildWorkloadSecret(ref: WorkloadRef & { data: Record<string, string> }): K8sObject {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(ref.data)) data[key] = Buffer.from(value, "utf8").toString("base64");
  return { apiVersion: "v1", kind: "Secret", metadata: metadata(ref), type: "Opaque", data };
}

/** Merge patch replacing one Secret key (e.g. a refreshed `github-token`). */
export function buildSecretKeyPatch(key: string, value: string): { data: Record<string, string> } {
  return buildSecretKeysPatch({ [key]: value });
}

/** Merge patch replacing several Secret keys in one write. */
export function buildSecretKeysPatch(values: Record<string, string>): { data: Record<string, string> } {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) data[key] = Buffer.from(value, "utf8").toString("base64");
  return { data };
}

/** ReadWriteOnce PVC that holds the workload's HOME. */
export function buildWorkloadPvc(ref: WorkloadRef & { storageClassName?: string; size: string }): K8sObject {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: metadata(ref),
    spec: {
      accessModes: ["ReadWriteOnce"],
      ...(ref.storageClassName ? { storageClassName: ref.storageClassName } : {}),
      resources: { requests: { storage: ref.size } },
    },
  };
}

/** ClusterIP Service on the terminal port, selecting exactly this workload's pod. */
export function buildWorkloadService(ref: WorkloadRef): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: metadata(ref),
    spec: {
      type: "ClusterIP",
      selector: workloadLabels(ref.kind, ref.id),
      ports: [{ name: "terminal", port: WORKLOAD_PORT, targetPort: WORKLOAD_PORT, protocol: "TCP" }],
    },
  };
}

export interface WorkloadPodOptions extends WorkloadRef {
  image: string;
  /** Every key present in the workload Secret. Decides the projected items. */
  secretKeys: string[];
  imagePullSecrets?: string[];
  nodeSelector?: Record<string, string>;
  priorityClassName?: string;
  resources?: { cpuRequest?: string; memoryRequest?: string; memoryLimit?: string };
  /** Main container args (after the image's `tini --` entrypoint). Defaults to the session-pod `serve`. */
  args?: string[];
  /** Init container args, or null for no init container. Defaults to the session-pod `prepare`. */
  initArgs?: string[] | null;
}

const containerSecurityContext = {
  runAsNonRoot: true,
  runAsUser: WORKLOAD_UID,
  runAsGroup: WORKLOAD_UID,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};

/**
 * The workload Pod. Invariants the tests pin:
 * - `restartPolicy: Never` — a pod whose process exits becomes Succeeded/Failed
 *   and reconcile ends the row; kubelet must not silently restart a session.
 * - No `ownerReferences`, so nothing Claws owns can garbage-collect it.
 * - `automountServiceAccountToken: false` and `enableServiceLinks: false`.
 * - PSA `restricted` securityContext (uid/gid 1000, fsGroup 1000, RuntimeDefault
 *   seccomp, no privilege escalation, all capabilities dropped).
 * - The Secret volume uses `items` and no `subPath` anywhere, so kubelet keeps
 *   updating mounted keys in place (the `github-token` refresh depends on it).
 *   The main container never gets `clone-env.json`; the init container gets
 *   only the launch spec and `clone-env.json`.
 * - `args`, never `command`, so the image's `tini` entrypoint stays PID 1.
 */
export function buildWorkloadPod(opts: WorkloadPodOptions): K8sObject {
  const name = workloadName(opts.kind, opts.id);
  const mainItems = opts.secretKeys
    .filter((key) => key !== CLONE_ENV_KEY)
    .map((key) => ({ key, path: key }));
  const initItems = [LAUNCH_SPEC_KEY, CLONE_ENV_KEY]
    .filter((key) => opts.secretKeys.includes(key))
    .map((key) => ({ key, path: key }));
  const initArgs = opts.initArgs === undefined ? ["node", SESSION_POD_ENTRY, "prepare"] : opts.initArgs;
  const env = [{ name: "HOME", value: WORKLOAD_HOME }];
  const homeMount = { name: "home", mountPath: WORKLOAD_HOME };

  const resources: Record<string, Record<string, string>> = {};
  if (opts.resources?.cpuRequest || opts.resources?.memoryRequest) {
    resources.requests = {
      ...(opts.resources.cpuRequest ? { cpu: opts.resources.cpuRequest } : {}),
      ...(opts.resources.memoryRequest ? { memory: opts.resources.memoryRequest } : {}),
    };
  }
  if (opts.resources?.memoryLimit) resources.limits = { memory: opts.resources.memoryLimit };

  const volumes: Array<Record<string, unknown>> = [
    { name: "home", persistentVolumeClaim: { claimName: name } },
    { name: "runtime", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
    { name: "secret", secret: { secretName: name, defaultMode: SECRET_FILE_MODE, items: mainItems } },
  ];
  if (initArgs) {
    volumes.push({ name: "init-secret", secret: { secretName: name, defaultMode: SECRET_FILE_MODE, items: initItems } });
  }

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata(opts),
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: WORKLOAD_UID,
        runAsGroup: WORKLOAD_UID,
        fsGroup: WORKLOAD_UID,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      },
      ...(opts.imagePullSecrets?.length ? { imagePullSecrets: opts.imagePullSecrets.map((n) => ({ name: n })) } : {}),
      ...(opts.nodeSelector && Object.keys(opts.nodeSelector).length ? { nodeSelector: opts.nodeSelector } : {}),
      ...(opts.priorityClassName ? { priorityClassName: opts.priorityClassName } : {}),
      ...(initArgs
        ? {
          initContainers: [{
            name: "prepare",
            image: opts.image,
            args: initArgs,
            env,
            securityContext: containerSecurityContext,
            volumeMounts: [homeMount, { name: "init-secret", mountPath: WORKLOAD_SECRET_DIR, readOnly: true }],
          }],
        }
        : {}),
      containers: [{
        name: opts.kind,
        image: opts.image,
        args: opts.args ?? ["node", SESSION_POD_ENTRY, "serve"],
        env,
        ports: [{ name: "terminal", containerPort: WORKLOAD_PORT, protocol: "TCP" }],
        readinessProbe: {
          httpGet: { path: "/healthz", port: WORKLOAD_PORT },
          periodSeconds: 5,
          failureThreshold: 3,
        },
        ...(Object.keys(resources).length ? { resources } : {}),
        securityContext: containerSecurityContext,
        volumeMounts: [
          homeMount,
          { name: "runtime", mountPath: WORKLOAD_RUNTIME_DIR },
          { name: "secret", mountPath: WORKLOAD_SECRET_DIR, readOnly: true },
        ],
      }],
      volumes,
    },
  };
}

// ── Pod classification ──

interface ContainerStateLike {
  waiting?: { reason?: string };
  terminated?: { exitCode?: number; reason?: string };
}

interface ContainerStatusLike {
  name?: string;
  ready?: boolean;
  state?: ContainerStateLike;
}

/** The subset of a Pod object that classification and reconcile read. */
export interface PodLike {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    deletionTimestamp?: string;
  };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    conditions?: Array<{ type?: string; status?: string }>;
    containerStatuses?: ContainerStatusLike[];
    initContainerStatuses?: ContainerStatusLike[];
  };
}

export type PodState = "pending" | "running" | "ready" | "succeeded" | "failed" | "unknown";

export interface PodClassification {
  state: PodState;
  /** Human-readable cause, e.g. `Evicted`, `OOMKilled`, `exit code 1`, `ImagePullBackOff`. */
  detail?: string;
  exitCode?: number;
}

function firstTerminated(statuses: ContainerStatusLike[] | undefined): { exitCode?: number; reason?: string } | undefined {
  return statuses?.find((s) => s.state?.terminated)?.state?.terminated;
}

function firstWaitingReason(statuses: ContainerStatusLike[] | undefined): string | undefined {
  return statuses?.find((s) => s.state?.waiting?.reason)?.state?.waiting?.reason;
}

export function classifyPod(pod: PodLike): PodClassification {
  const status = pod.status ?? {};
  switch (status.phase) {
    case "Pending": {
      const waiting = firstWaitingReason(status.initContainerStatuses) ?? firstWaitingReason(status.containerStatuses);
      return waiting ? { state: "pending", detail: waiting } : { state: "pending" };
    }
    case "Running": {
      const ready = status.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
      return { state: ready ? "ready" : "running" };
    }
    case "Succeeded": {
      const exitCode = firstTerminated(status.containerStatuses)?.exitCode;
      return exitCode === undefined ? { state: "succeeded" } : { state: "succeeded", exitCode };
    }
    case "Failed": {
      const terminated = firstTerminated(status.containerStatuses) ?? firstTerminated(status.initContainerStatuses);
      const exitCode = terminated?.exitCode;
      let detail: string | undefined;
      if (status.reason === "Evicted") detail = "Evicted";
      else if (terminated?.reason === "OOMKilled") detail = "OOMKilled";
      else if (status.reason) detail = status.reason;
      else if (exitCode !== undefined) detail = `exit code ${exitCode}`;
      return { state: "failed", ...(detail ? { detail } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
    }
    default:
      return { state: "unknown", ...(status.phase ? { detail: status.phase } : {}) };
  }
}

// ── Reconcile ──

/** A DB row as reconcile sees it; `launched_at`/`ended_at` are epoch milliseconds. */
export interface WorkloadRow {
  id: string;
  /**
   * When the workload's pod was last launched. Set on create and again on every
   * resume, so a resumed row gets the full launch grace — not its original
   * creation time, which would give it none.
   */
  launched_at: number;
  ended_at: number | null;
}

export interface WorkloadReconcileInput {
  rows: WorkloadRow[];
  /** Pods listed by the workload label selector. */
  pods: PodLike[];
  /**
   * Snapshot of the ids with a create/resume in flight in this process, taken
   * BEFORE listing pods — not a live set. A launch that finishes between the
   * pod list and the DB read then stays excluded, instead of its reopened row
   * being matched against a stale list that lacks its new pod.
   */
  launching: ReadonlySet<string>;
  now: number;
  graceMs: number;
}

export interface WorkloadReconcilePlan {
  /** Open rows whose pod is not terminal. */
  live: Array<{ id: string; podName: string; classification: PodClassification }>;
  /** Open rows to mark ended, with the reason and the exit code to report to open terminals. */
  markEnded: Array<{ id: string; reason: string; exitCode: number }>;
  /** Names of pods whose row has already ended. */
  deletePodsForEndedRows: string[];
  /** Names of managed pods with no DB row and no `deletionTimestamp` — report only, never delete. */
  orphanPods: string[];
}

/** Default grace for a row with no pod before reconcile treats it as ended. */
export const WORKLOAD_LAUNCH_GRACE_MS = 3 * 60 * 1000;

/**
 * Decide what reconcile should do, from one successful pod list and DB read.
 * The caller must not call this at all when either read failed — only a real
 * Kubernetes answer may end a row. The plan never includes a PVC action.
 *
 * Ids in `launching` get no action at all: during a resume the row is still
 * ended and the old pod may still be terminating, and acting on either would
 * delete the pod being created.
 */
export function planWorkloadReconcile(input: WorkloadReconcileInput): WorkloadReconcilePlan {
  const plan: WorkloadReconcilePlan = { live: [], markEnded: [], deletePodsForEndedRows: [], orphanPods: [] };
  const rowsById = new Map(input.rows.map((r) => [r.id, r]));
  const podsById = new Map<string, PodLike>();

  for (const pod of input.pods) {
    const name = pod.metadata?.name ?? "";
    const id = pod.metadata?.labels?.[LABEL_WORKLOAD_ID];
    const row = id === undefined ? undefined : rowsById.get(id);
    if (id === undefined || !row) {
      // A terminating pod with no row is one Delete or a prune just removed, not an orphan.
      if (!pod.metadata?.deletionTimestamp) plan.orphanPods.push(name);
      continue;
    }
    podsById.set(id, pod);
    if (input.launching.has(id)) continue;
    if (row.ended_at !== null && !pod.metadata?.deletionTimestamp) plan.deletePodsForEndedRows.push(name);
  }

  for (const row of input.rows) {
    if (row.ended_at !== null || input.launching.has(row.id)) continue;
    const pod = podsById.get(row.id);
    if (pod) {
      const classification = classifyPod(pod);
      if (classification.state === "succeeded" || classification.state === "failed") {
        const detail = classification.detail ? `: ${classification.detail}` : "";
        const exitCode = classification.exitCode ?? (classification.state === "succeeded" ? 0 : 1);
        plan.markEnded.push({ id: row.id, reason: `pod ${classification.state}${detail}`, exitCode });
      } else {
        plan.live.push({ id: row.id, podName: pod.metadata?.name ?? "", classification });
      }
      continue;
    }
    if (input.now - row.launched_at > input.graceMs) {
      plan.markEnded.push({ id: row.id, reason: "pod not found", exitCode: 1 });
    }
  }

  return plan;
}
