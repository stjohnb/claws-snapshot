import type { K8sObject } from "./api.js";

// Pure Kubernetes workload primitives for Claws-managed pods (#3026): naming,
// labels, object builders, pod classification and the reconcile plan. No I/O —
// callers feed API results in and apply the plan through `k8s/api.ts`. Written
// for interactive session pods but keyed by a workload `kind`, so another
// long-lived workload type can reuse them.

export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const LABEL_WORKLOAD = "claws-workload";
export const LABEL_WORKLOAD_ID = "claws-workload-id";
export const LABEL_NAME = "app.kubernetes.io/name";
export const LABEL_INSTANCE = "app.kubernetes.io/instance";

/** HOME inside a workload pod; the workload's PVC is mounted here. */
export const WORKLOAD_HOME = "/home/claws";
/** In-memory emptyDir for runtime files (0600 env file, SSH material). */
export const WORKLOAD_RUNTIME_DIR = "/run/claws";
/** Where the workload Secret's projected items are mounted, in both containers. */
export const WORKLOAD_SECRET_DIR = "/etc/claws-workload";
export const WORKLOAD_PORT = 7681;
/** uid/gid of the `claws` user in the Claws image. */
export const WORKLOAD_UID = 1000;
/** Compiled entry point of the in-pod runtime (`src/session-pod/main.ts`). */
export const SESSION_POD_ENTRY = "/opt/claws/dist/session-pod/main.js";

/** Workload kind of a headless agent pod running one work-queue row (#clw_01M34R5RECDPPXVXBJZS1DA6C1). */
export const AGENT_WORKLOAD_KIND = "agent";
/** Secret key of an agent pod's `export K='v'` env file, sourced before the container entrypoint. */
export const AGENT_ENV_KEY = "agent.env";

/** Secret key holding the launch spec — the only key besides the clone env the init container sees. */
export const LAUNCH_SPEC_KEY = "launch.json";
/** Secret key holding clone credentials; projected into the init container only. */
export const CLONE_ENV_KEY = "clone-env.json";
/** Secret key holding the bearer token the terminal server requires. */
export const TERMINAL_TOKEN_KEY = "terminal-token";
/** Secret key holding the bearer token the session's `claws-state` MCP endpoint in Claws requires (#3056). */
export const MCP_TOKEN_KEY = "mcp-token";
/** Private key files copied from the service's `~/.ssh` when an `ssh:*` capability is granted. */
export const SSH_PRIVATE_KEY_FILES = ["id_ed25519", "id_rsa"] as const;
/** Secret key carrying the SSH private key file `name`. */
export function sshKeySecretKey(name: string): string {
  return `ssh-${name}`;
}
/**
 * Secret keys holding the SSH private keys. Present on every pod from launch
 * (empty without an `ssh:*` capability), because the Secret volume lists its
 * `items` at launch: an `ssh:*` grant fills them and revoking the last `ssh:*`
 * host empties them, and the pod polls the mounted slots. A pod launched
 * before the slots existed lacks them, so a grant there waits for a resume.
 */
export const SSH_KEY_SECRET_KEYS: readonly string[] = SSH_PRIVATE_KEY_FILES.map(sshKeySecretKey);
/**
 * Secret key marking a pod whose runtime polls the SSH key slots. A pod
 * launched before the poller existed may still carry filled SSH slots (from a
 * launch-time `ssh:*` grant) but copied the keys once at startup, so only this
 * marker — not the slots — says a grant or revoke reaches the running session.
 */
export const SSH_SLOTS_KEY = "ssh-slots";
/**
 * Secret key of the env file for capabilities granted to a running session
 * (#3072). Present from launch, because the pod's Secret volume lists its
 * `items` explicitly and a key added later is never mounted.
 */
export const GRANTED_ENV_KEY = "granted-env";

const SECRET_FILE_MODE = 0o440;

/** `claws-<kind>-<id>` — the shared name of a workload's Pod, Service, Secret and PVC. */
export function workloadName(kind: string, id: string): string {
  return `claws-${kind}-${id}`;
}

/** The three labels that identify a workload; a Service selector matches on these alone. */
export function workloadIdentityLabels(kind: string, id: string): Record<string, string> {
  return { [LABEL_MANAGED_BY]: "claws", [LABEL_WORKLOAD]: kind, [LABEL_WORKLOAD_ID]: id };
}

/**
 * Identity labels plus descriptive ones for object `metadata.labels`.
 * `app.kubernetes.io/name` is what Promtail's default relabel config turns into
 * the Loki `app`/`service_name` label, so every session pod aggregates into one
 * `claws-session` stream instead of one stream per pod; `app.kubernetes.io/instance`
 * becomes Promtail's `instance` label, keeping per-session isolation in Loki.
 */
export function workloadLabels(kind: string, id: string): Record<string, string> {
  return { ...workloadIdentityLabels(kind, id), [LABEL_NAME]: `claws-${kind}`, [LABEL_INSTANCE]: workloadName(kind, id) };
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

/** Merge patch replacing one Secret key. */
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
      selector: workloadIdentityLabels(ref.kind, ref.id),
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
  tolerations?: Array<{ key: string; operator: string; value?: string; effect?: string }>;
  /** Pod `affinity`, emitted as given. */
  affinity?: Record<string, unknown>;
  priorityClassName?: string;
  resources?: { cpuRequest?: string; memoryRequest?: string; ephemeralStorageRequest?: string; memoryLimit?: string; ephemeralStorageLimit?: string };
  /** HOME volume. Defaults to the PVC named after the workload. */
  home?: { emptyDir: { sizeLimit: string } };
  /** `false` omits the terminal port and its `/healthz` readiness probe. */
  terminalPort?: false;
  /** Extra env vars, appended after `HOME` in every container. */
  env?: Array<{ name: string; value: string }>;
  terminationGracePeriodSeconds?: number;
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
 *   updating mounted keys in place (live grants and SSH slot fills depend on it).
 *   The main container never gets `clone-env.json`; the init container gets
 *   only the launch spec and `clone-env.json`.
 * - `args`, never `command`, so the image's `tini` entrypoint stays PID 1.
 * - Both containers set `terminationMessagePolicy: FallbackToLogsOnError`, so a
 *   fatal error logged just before a non-zero exit lands on
 *   `status.containerStatuses[].state.terminated.message` for classification
 *   to surface (#clw_01M3HHA3KY0AMHDMH6C2F2X34Z).
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
  const env = [{ name: "HOME", value: WORKLOAD_HOME }, ...(opts.env ?? [])];
  const homeMount = { name: "home", mountPath: WORKLOAD_HOME };

  const resources: Record<string, Record<string, string>> = {};
  if (opts.resources?.cpuRequest || opts.resources?.memoryRequest || opts.resources?.ephemeralStorageRequest) {
    resources.requests = {
      ...(opts.resources.cpuRequest ? { cpu: opts.resources.cpuRequest } : {}),
      ...(opts.resources.memoryRequest ? { memory: opts.resources.memoryRequest } : {}),
      // Without it Kubernetes copies the ephemeral-storage limit into the
      // request, so each pod would reserve its whole cap of node disk.
      ...(opts.resources.ephemeralStorageRequest ? { "ephemeral-storage": opts.resources.ephemeralStorageRequest } : {}),
    };
  }
  if (opts.resources?.memoryLimit || opts.resources?.ephemeralStorageLimit) {
    resources.limits = {
      ...(opts.resources.memoryLimit ? { memory: opts.resources.memoryLimit } : {}),
      ...(opts.resources.ephemeralStorageLimit ? { "ephemeral-storage": opts.resources.ephemeralStorageLimit } : {}),
    };
  }

  const volumes: Array<Record<string, unknown>> = [
    opts.home ? { name: "home", emptyDir: { sizeLimit: opts.home.emptyDir.sizeLimit } } : { name: "home", persistentVolumeClaim: { claimName: name } },
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
      ...(opts.tolerations?.length ? { tolerations: opts.tolerations } : {}),
      ...(opts.affinity && Object.keys(opts.affinity).length ? { affinity: opts.affinity } : {}),
      ...(opts.priorityClassName ? { priorityClassName: opts.priorityClassName } : {}),
      ...(opts.terminationGracePeriodSeconds !== undefined ? { terminationGracePeriodSeconds: opts.terminationGracePeriodSeconds } : {}),
      ...(initArgs
        ? {
          initContainers: [{
            name: "prepare",
            image: opts.image,
            args: initArgs,
            env,
            securityContext: containerSecurityContext,
            terminationMessagePolicy: "FallbackToLogsOnError",
            volumeMounts: [homeMount, { name: "init-secret", mountPath: WORKLOAD_SECRET_DIR, readOnly: true }],
          }],
        }
        : {}),
      containers: [{
        name: opts.kind,
        image: opts.image,
        args: opts.args ?? ["node", SESSION_POD_ENTRY, "serve"],
        env,
        terminationMessagePolicy: "FallbackToLogsOnError",
        ...(opts.terminalPort === false
          ? {}
          : {
            ports: [{ name: "terminal", containerPort: WORKLOAD_PORT, protocol: "TCP" }],
            readinessProbe: {
              httpGet: { path: "/healthz", port: WORKLOAD_PORT },
              periodSeconds: 5,
              failureThreshold: 3,
            },
          }),
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

/** Workload kind of the one-shot pod that reads an ended session's memory files off its PVC. */
export const MEMORY_CAPTURE_WORKLOAD_KIND = "session-memory";
/** Compiled entry point that prints a HOME's memory files as one JSON line (`src/session-pod/dump-memories.ts`). */
export const MEMORY_DUMP_ENTRY = "/opt/claws/dist/session-pod/dump-memories.js";

export interface MemoryCapturePodOptions {
  id: string;
  namespace: string;
  image: string;
  /** The session's HOME PVC, mounted read-only. */
  homeClaimName: string;
  imagePullSecrets?: string[];
  nodeSelector?: Record<string, string>;
  activeDeadlineSeconds?: number;
}

/**
 * The memory capture Pod: the session's HOME PVC mounted read-only at
 * `WORKLOAD_HOME`, `dump-memories` as its only process, and the same PSA
 * `restricted` securityContext as `buildWorkloadPod`. `restartPolicy: Never`,
 * no ServiceAccount token, no Secret volumes, and a deadline so a wedged
 * process cannot hold the PVC. Its kind differs from the session's, so
 * `workloadSelector` for sessions never lists it.
 */
export function buildMemoryCapturePod(opts: MemoryCapturePodOptions): K8sObject {
  const ref = { kind: MEMORY_CAPTURE_WORKLOAD_KIND, id: opts.id, namespace: opts.namespace };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata(ref),
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: opts.activeDeadlineSeconds ?? 300,
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
      containers: [{
        name: MEMORY_CAPTURE_WORKLOAD_KIND,
        image: opts.image,
        args: ["node", MEMORY_DUMP_ENTRY],
        env: [{ name: "HOME", value: WORKLOAD_HOME }],
        terminationMessagePolicy: "FallbackToLogsOnError",
        resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "256Mi" } },
        securityContext: containerSecurityContext,
        volumeMounts: [{ name: "home", mountPath: WORKLOAD_HOME, readOnly: true }],
      }],
      volumes: [{ name: "home", persistentVolumeClaim: { claimName: opts.homeClaimName, readOnly: true } }],
    },
  };
}

// ── Pod classification ──

interface ContainerStateLike {
  waiting?: { reason?: string; message?: string };
  running?: { startedAt?: string };
  terminated?: { exitCode?: number; reason?: string; message?: string };
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
    creationTimestamp?: string;
  };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string }>;
    containerStatuses?: ContainerStatusLike[];
    initContainerStatuses?: ContainerStatusLike[];
  };
}

export type PodState = "pending" | "running" | "ready" | "succeeded" | "failed" | "unknown";

export interface PodClassification {
  state: PodState;
  /** Human-readable cause, e.g. `Evicted`, `OOMKilled`, `exit code 1`, `ImagePullBackOff`. */
  detail?: string;
  /** Set on a `pending` pod with no stated reason or only an ordinary startup state (`ContainerCreating`, `PodInitializing`): never scheduled, or bound to a node whose containers never started. */
  neverStarted?: "unscheduled" | "scheduled";
  /** The node a `neverStarted: "scheduled"` pod is bound to. */
  node?: string;
  exitCode?: number;
  /** Raw, trimmed `terminated.message`, present only when it summarised to something. */
  terminationMessage?: string;
  /** Set on a `failed` pod whose container the kubelet lost to a node or container-runtime restart. */
  runtimeLost?: boolean;
  /** Set on a `failed` pod the node's kubelet rejected at admission for a resource or affinity reason (`OutOfmemory`, `UnexpectedAdmissionError`, …). */
  admissionRejected?: boolean;
}

/** True for the `status.reason` values the kubelet's admission handlers set when they reject a pod. */
export function isAdmissionRejection(reason: string | undefined): boolean {
  if (!reason) return false;
  return /^OutOf[A-Za-z]/.test(reason) || reason === "UnexpectedAdmissionError" || reason === "NodeAffinity";
}

export const RUNTIME_LOST_DETAIL = "container lost to a node or runtime restart";

/**
 * True when a terminated container carries the kubelet's runtime-loss signature: exit 255 with
 * an `Unknown`/`ContainerStatusUnknown` reason or the kubelet's own log-read error message.
 * A plain exit 255 from agent code does not match.
 */
export function isRuntimeLostTermination(terminated: { exitCode?: number; reason?: string; message?: string } | undefined): boolean {
  if (!terminated || terminated.exitCode !== 255) return false;
  if (terminated.reason === "Unknown" || terminated.reason === "ContainerStatusUnknown") return true;
  return (terminated.message ?? "").trimStart().startsWith("Error on reading termination message from logs");
}

interface TerminationLogLine {
  level?: unknown;
  msg?: unknown;
}

function parseTerminationLogLine(line: string): TerminationLogLine | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object") return parsed as TerminationLogLine;
  } catch {
    // Not a JSON log line (e.g. a plain-text crash) — the caller falls back to the raw line.
  }
  return undefined;
}

const TERMINATION_SUMMARY_MAX_CHARS = 240;

/**
 * Boils a container's `terminated.message` — populated by
 * `terminationMessagePolicy: FallbackToLogsOnError` from the container's stdout/stderr —
 * down to one short line for a failure summary: the last `error`-level JSON log line
 * (`src/log-core.ts` shape), else the last non-blank line verbatim (a `warn` line is
 * usually a side effect, not the crash, so it isn't preferred over a later line).
 * `undefined` when the message is empty or blank.
 */
export function summarizeTerminationMessage(message: string | undefined): string | undefined {
  const lines = (message ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;

  function lastMsgAtLevel(level: string): string | undefined {
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = parseTerminationLogLine(lines[i]);
      if (parsed?.level === level && typeof parsed.msg === "string") return parsed.msg;
    }
    return undefined;
  }

  const lastLine = lines[lines.length - 1];
  const lastParsed = parseTerminationLogLine(lastLine);
  const chosen = lastMsgAtLevel("error") ?? (typeof lastParsed?.msg === "string" ? lastParsed.msg : lastLine);

  const firstLine = chosen.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return undefined;
  return firstLine.length > TERMINATION_SUMMARY_MAX_CHARS ? `${firstLine.slice(0, TERMINATION_SUMMARY_MAX_CHARS)}…` : firstLine;
}

/**
 * Renders a container's raw `terminated.message` as a readable log for the ended-session
 * page: a JSON log line becomes `[LEVEL] msg`; anything else (a plain-text crash) passes
 * through unchanged.
 */
export function renderTerminationMessage(message: string): string {
  return message
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return trimmed;
      const parsed = parseTerminationLogLine(trimmed);
      if (parsed && typeof parsed.level === "string" && typeof parsed.msg === "string") return `[${parsed.level.toUpperCase()}] ${parsed.msg}`;
      return trimmed;
    })
    .join("\n")
    .trim();
}

/** Appends `: <summary>` to `base` when `message` summarises to something, else returns `base` unchanged. */
function withTerminationSummary(base: string, message: string | undefined): string {
  const summary = summarizeTerminationMessage(message);
  return summary ? `${base}: ${summary}` : base;
}

export type PodStartupState = "pending" | "running" | "ready" | "failed" | "ended" | "unknown";

export interface PodStartupClassification {
  state: PodStartupState;
  step: string;
  detail?: string;
  failureReason?: string;
}

// One "first container in state X" helper per container state, shared by both classifiers.

function firstTerminated(statuses: ContainerStatusLike[] | undefined): ContainerStateLike["terminated"] {
  return statuses?.find((s) => s.state?.terminated)?.state?.terminated;
}

function firstWaiting(statuses: ContainerStatusLike[] | undefined): ContainerStateLike["waiting"] {
  return statuses?.find((s) => s.state?.waiting)?.state?.waiting;
}

function firstRunning(statuses: ContainerStatusLike[] | undefined): ContainerStateLike["running"] {
  return statuses?.find((s) => s.state?.running)?.state?.running;
}

function readyCondition(pod: PodLike): boolean {
  return pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
}

function scheduledCondition(pod: PodLike): { status?: string; reason?: string; message?: string; lastTransitionTime?: string } | undefined {
  return pod.status?.conditions?.find((c) => c.type === "PodScheduled");
}

/** When the pod was scheduled (ms epoch), or null while unscheduled or unknown. Read from the pod so it survives a restart. */
export function podScheduledAt(pod: PodLike): number | null {
  const c = scheduledCondition(pod);
  if (c?.status !== "True" || !c.lastTransitionTime) return null;
  const t = Date.parse(c.lastTransitionTime);
  return Number.isNaN(t) ? null : t;
}

/** When the pod object was created (ms epoch), or null if unknown. */
export function podCreatedAt(pod: PodLike): number | null {
  const t = pod.metadata?.creationTimestamp ? Date.parse(pod.metadata.creationTimestamp) : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * Why a pod is being deleted, read before it disappears: the true
 * `DisruptionTarget` condition as `reason: message` (e.g. `PreemptionByScheduler`),
 * else `status.reason`, else null.
 */
export function podDisruptionReason(pod: PodLike): string | null {
  const c = pod.status?.conditions?.find((cond) => cond.type === "DisruptionTarget" && cond.status === "True");
  const reason = c?.reason?.trim();
  if (reason) return c?.message?.trim() ? `${reason}: ${c.message.trim()}` : reason;
  return pod.status?.reason?.trim() || null;
}

function conciseReason(reason: string | undefined, fallback: string): string {
  return reason && reason.trim() ? reason.trim() : fallback;
}

export function classifyPod(pod: PodLike): PodClassification {
  const status = pod.status ?? {};
  switch (status.phase) {
    case "Pending": {
      const waiting = firstWaiting(status.initContainerStatuses)?.reason ?? firstWaiting(status.containerStatuses)?.reason;
      if (waiting === "ContainerCreating" || waiting === "PodInitializing") {
        // Ordinary startup states, not failures: a pod stuck in them is a node-level stall.
        const node = pod.spec?.nodeName || "unknown node";
        return { state: "pending", detail: `scheduled to node ${node} but stuck in ${waiting}`, neverStarted: "scheduled", node };
      }
      if (waiting) return { state: "pending", detail: waiting };
      // Never scheduled, so no container statuses yet: name the scheduler's reason.
      const scheduled = scheduledCondition(pod);
      if (scheduled?.status === "False") {
        const reason = conciseReason(scheduled.reason, "Unschedulable");
        const message = scheduled.message?.trim();
        return { state: "pending", detail: message ? `${reason}: ${message}` : reason };
      }
      const nodeName = pod.spec?.nodeName;
      if (nodeName || scheduled?.status === "True") {
        const node = nodeName || "unknown node";
        return { state: "pending", detail: `scheduled to node ${node} but no container ever started`, neverStarted: "scheduled", node };
      }
      return { state: "pending", detail: "never scheduled (no scheduler decision recorded)", neverStarted: "unscheduled" };
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
      if (status.reason !== "Evicted" && isRuntimeLostTermination(terminated)) {
        return { state: "failed", detail: RUNTIME_LOST_DETAIL, exitCode: 255, runtimeLost: true };
      }
      const admissionRejected = isAdmissionRejection(status.reason);
      let detail: string | undefined;
      if (admissionRejected) {
        const firstLine = status.message?.split("\n").map((l) => l.trim()).find((l) => l);
        detail = firstLine ? `${status.reason}: ${firstLine}` : status.reason;
      } else if (status.reason === "Evicted") detail = "Evicted";
      else if (terminated?.reason === "OOMKilled") detail = "OOMKilled";
      else if (status.reason) detail = status.reason;
      else if (exitCode !== undefined) detail = `exit code ${exitCode}`;
      const summary = summarizeTerminationMessage(terminated?.message);
      if (summary) detail = detail ? `${detail}: ${summary}` : summary;
      return {
        state: "failed",
        ...(detail ? { detail } : {}),
        ...(admissionRejected ? { admissionRejected: true } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(summary && terminated?.message ? { terminationMessage: terminated.message.trim() } : {}),
      };
    }
    default:
      return { state: "unknown", ...(status.phase ? { detail: status.phase } : {}) };
  }
}

/**
 * The same pod as `classifyPod` sees it, told as startup progress for an open terminal.
 *
 * It must never report `failed` for a pod `classifyPod` still calls live: the terminal
 * client treats `failed` as terminal — it disables every input control and stops polling
 * for good — while reconcile would keep the row open and let the session reach Ready, so a
 * disagreement strands the tab on a dead banner over a session that is running fine. That
 * rules out calling `ImagePullBackOff`/`ErrImagePull` a failure: both are kubelet's own
 * retry states and routinely recover (registry rate limit, a pull-secret rotation landing a
 * moment later), so they are `pending` with the reason as `detail`. Only what puts a pod
 * beyond recovery under `restartPolicy: Never` — a container terminated non-zero, or phase
 * `Failed` — is a failure here too.
 */
export function classifyPodStartup(pod: PodLike): PodStartupClassification {
  const status = pod.status ?? {};
  if (pod.metadata?.deletionTimestamp) {
    return { state: "ended", step: "Session pod is terminating", detail: "Deleting old pod" };
  }

  const initFailed = firstTerminated(status.initContainerStatuses);
  if (initFailed && (initFailed.exitCode ?? 0) !== 0) {
    const reason = withTerminationSummary(
      conciseReason(initFailed.reason, initFailed.exitCode === undefined ? "Init container failed" : `exit code ${initFailed.exitCode}`),
      initFailed.message,
    );
    return { state: "failed", step: "Preparing repository checkout failed", detail: reason, failureReason: reason };
  }
  const mainFailed = firstTerminated(status.containerStatuses);
  if (mainFailed && (mainFailed.exitCode ?? 0) !== 0) {
    const reason = withTerminationSummary(
      conciseReason(mainFailed.reason, mainFailed.exitCode === undefined ? "Terminal server failed" : `exit code ${mainFailed.exitCode}`),
      mainFailed.message,
    );
    return { state: "failed", step: "Starting terminal server failed", detail: reason, failureReason: reason };
  }

  if (status.phase === "Failed") {
    const base = status.reason ?? initFailed?.reason ?? mainFailed?.reason ?? (mainFailed?.exitCode === undefined ? "Pod failed" : `exit code ${mainFailed.exitCode}`);
    const reason = withTerminationSummary(base, mainFailed?.message ?? initFailed?.message);
    return { state: "failed", step: "Session pod failed", detail: reason, failureReason: reason };
  }
  if (status.phase === "Succeeded") {
    return { state: "ended", step: "Session process exited", detail: mainFailed?.exitCode === undefined ? undefined : `exit code ${mainFailed.exitCode}` };
  }

  if (readyCondition(pod)) {
    return { state: "ready", step: "Terminal ready" };
  }

  const scheduled = scheduledCondition(pod);
  if (scheduled?.status === "False") {
    const reason = conciseReason(scheduled.reason, "Unschedulable");
    return { state: "pending", step: "Waiting for scheduler", detail: reason };
  }

  const initWaiting = firstWaiting(status.initContainerStatuses);
  if (initWaiting) {
    const reason = conciseReason(initWaiting.reason, "Waiting");
    const imageWaits = new Set(["ContainerCreating", "PodInitializing"]);
    if (reason.includes("Image")) return { state: "pending", step: "Pulling session image", detail: reason };
    return { state: "pending", step: imageWaits.has(reason) ? "Waiting for volume" : "Preparing repository checkout", detail: reason };
  }

  if (firstRunning(status.initContainerStatuses)) {
    return { state: "pending", step: "Preparing repository checkout" };
  }

  const mainWaiting = firstWaiting(status.containerStatuses);
  if (mainWaiting) {
    const reason = conciseReason(mainWaiting.reason, "Waiting");
    if (reason.includes("Image")) return { state: "pending", step: "Pulling session image", detail: reason };
    if (reason === "ContainerCreating" || reason === "PodInitializing") return { state: "pending", step: "Waiting for volume", detail: reason };
    return { state: "running", step: "Starting terminal server", detail: reason };
  }

  if (firstRunning(status.containerStatuses) || status.phase === "Running") {
    return { state: "running", step: "Starting terminal server" };
  }
  if (status.phase === "Pending") {
    return { state: "pending", step: "Waiting for pod to start" };
  }
  return { state: "unknown", step: "Checking session pod", ...(status.phase ? { detail: status.phase } : {}) };
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
  markEnded: Array<{ id: string; reason: string; exitCode: number; terminationMessage?: string }>;
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
        plan.markEnded.push({
          id: row.id,
          reason: `pod ${classification.state}${detail}`,
          exitCode,
          ...(classification.state === "failed" && classification.terminationMessage ? { terminationMessage: classification.terminationMessage } : {}),
        });
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

/**
 * The pod's most recent Warning event (ignoring scheduler `FailedScheduling`)
 * as `<reason>: <message>`, one line, at most 300 characters; null when none.
 */
export function latestWarningEvent(events: ReadonlyArray<{
  type?: string; reason?: string; message?: string;
  lastTimestamp?: string; eventTime?: string; metadata?: { creationTimestamp?: string };
}>): string | null {
  const stamp = (e: (typeof events)[number]): number => {
    const t = Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? "");
    return Number.isNaN(t) ? 0 : t;
  };
  const warnings = events.filter((e) => e.type === "Warning" && e.reason && e.reason !== "FailedScheduling");
  if (warnings.length === 0) return null;
  const latest = warnings.reduce((a, b) => (stamp(b) >= stamp(a) ? b : a));
  const message = (latest.message ?? "").replace(/\s+/g, " ").trim();
  const text = message ? `${latest.reason}: ${message}` : `${latest.reason}`;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
