import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as db from "./db.js";
import * as log from "./log.js";
import { AGENT_POD_SETTINGS, CONFIG_PATH, SELF_REPO, SESSION_POD_SETTINGS, discoveredForgejoRepos, type AgentPodSettings, type SessionPodSettings } from "./config.js";
import * as forgejo from "./forgejo.js";
import { reportError } from "./error-reporter.js";
import { closeAlertIssueIfResolved, ensureAlertIssue } from "./occurrence-tracking.js";
import { REPO_SCOPED_KINDS } from "./work-order.js";
import { hashAgentMcpToken, INTERNAL_MCP_TOKEN_FILE } from "./internal-mcp-token.js";
import { isShuttingDown } from "./shutdown.js";
import { renderSessionEnvFile } from "./session-env-file.js";
import { isClaudeTokenEnvKey } from "./claude-accounts.js";
import { sleep as defaultSleep } from "./util.js";
import { agentPodWatchdogCapBytes, parseK8sMemoryQuantity } from "./agent-memory-budget.js";
import { createK8sClient, type K8sClient, type K8sObject, type K8sResource, type K8sResult } from "./k8s/api.js";
import {
  AGENT_ENV_KEY,
  AGENT_WORKLOAD_KIND,
  LABEL_WORKLOAD_ID,
  LAUNCH_SPEC_KEY,
  MCP_TOKEN_KEY,
  WORKLOAD_LAUNCH_GRACE_MS,
  WORKLOAD_SECRET_DIR,
  buildWorkloadPod,
  buildWorkloadSecret,
  classifyPod,
  latestWarningEvent,
  podCreatedAt,
  podDisruptionReason,
  podScheduledAt,
  workloadName,
  workloadSelector,
  type PodLike,
} from "./k8s/workload.js";
import type { AgentLaunchSpec } from "./agent-pod/main.js";

// Service side of the `k8s-pod` work backend (#clw_01M34R5RECDPPXVXBJZS1DA6C1):
// launches one `claws-agent-<rowId>` Pod + Secret per claimed work-queue row,
// then watches it until the row ends. The pod runs the row itself
// (`agent-pod/run.ts`) and writes its result through the service's agent-pod
// ops API (`agent-pod-ops.ts`) — it never holds database credentials — so a
// Claws restart leaves it running; the next boot adopts it from
// `listPodBackedRunningWork()`. The launcher finalises the row only when the
// pod dies first, is cancelled, or outlives the stale-work ceiling.

/**
 * Env vars never copied from the service into an agent pod's `agent.env`.
 * The database credentials above all: a pod acts only through the enumerated
 * ops API, and Postgres does not admit agent pods.
 */
const ENV_DENY_EXACT = new Set([
  "PATH", "HOME", "PWD", "OLDPWD", "SHLVL", "_", "TERM", "HOSTNAME",
  "CLAWS_SESSION_BACKEND", "CLAWS_WORK_BACKEND", "CLAWS_MAX_WORK_WORKERS", "CLAWS_MIN_WORK_WORKERS",
  "CLAWS_DATABASE_URL", "CLAWS_DATABASE_PASSWORD",
  // Pod memory tuning is derived from the pod's own limit (see
  // `agentPodWatchdogCapBytes` below), not inherited from the service's env —
  // that is sized for the service's own, differently-sized container.
  "CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES", "CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES",
  "CLAWS_AGENT_WORKER_MEMORY_HEADROOM_BYTES", "CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES",
  // Agents hold no Kubernetes credentials (#clw_01M3EW1TJ5FPD17N8JQSHDJXAJ):
  // a stale kubeconfig left in the service env must never reach a pod.
  "CLAWS_KUBECONFIG", "CLAWS_PROD_KUBECONFIG", "KUBECONFIG",
  // Printing is never a headless grant (#clw_01M498X85G9KCWHAX28RHG0F7Y): only
  // an interactive session granted `print` gets a CUPS server.
  "CLAWS_PRINT_SERVER",
]);
// Public snapshot sync, the only GitHub writer, runs in the controller: agent
// pods hold no GitHub App credentials.
const ENV_DENY_PREFIXES = ["KUBERNETES_", "CLAWS_OIDC_", "CLAWS_AUTH_SECRET_", "CLAWS_GITHUB_APP_"];

/** `config.json` keys never shipped to an agent pod: the GitHub App credentials. */
const CONFIG_DENY_KEYS = ["githubAppId", "githubAppPrivateKeyPath", "githubAppInstallationIds", "githubOwnerAppCredentials"];

/**
 * Vars `deploy/container-entrypoint.sh` turns back into HOME files and then
 * unsets, so the service no longer has them in its env: re-read from those files.
 */
const FILE_BACKED_ENV: ReadonlyArray<{ name: string; file: string }> = [
  { name: "CLAWS_SSH_PRIVATE_KEY", file: ".ssh/id_ed25519" },
  { name: "CLAWS_CODEX_AUTH_JSON", file: ".codex/auth.json" },
  { name: "CLAWS_CLAUDE_SETTINGS_JSON", file: ".claude/settings.json" },
];

/** How long a row that reached a terminal status waits for its pod to exit on its own. */
export const TERMINAL_POD_EXIT_WAIT_MS = 2 * 60 * 1000;
/** Prefix of the failure (and of the re-queue note) for a pod that never started; the note marks a row as already retried once. */
export const NEVER_STARTED_PREFIX = "agent pod never started";
/** Marks a row re-queued once after the kubelet rejected its pod at admission (OutOfmemory, …). */
export const ADMISSION_REJECTED_PREFIX = "agent pod rejected by kubelet";
/** Prefix of the re-queue note for a pod deleted outside Claws mid-run; the note marks a row as already retried once. */
export const VANISHED_PREFIX = "agent pod vanished";
/** Failure reason for a pod whose container was lost to a node/runtime restart (not an agent defect). */
export const RUNTIME_LOST_REASON = "agent pod lost to a node or runtime restart";
/**
 * How long a pod may stay Pending (ImagePullBackOff, Unschedulable,
 * CreateContainerConfigError, …) before its row is failed and its worker freed.
 */
export const AGENT_POD_START_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * How long a running row's pod may sit in phase Unknown (its node unreachable)
 * or terminating on a deletion the launcher did not make, before the row is
 * failed and its worker freed.
 */
export const AGENT_POD_LOST_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * How long past its `deletionTimestamp` a pod the taint manager evicted from a
 * NotReady node may stay Terminating before it is force-deleted. Its kubelet
 * is gone (a powered-off node), so nothing else would ever finish the delete.
 */
export const TAINT_EVICTION_FORCE_DELETE_MS = 60 * 1000;
/**
 * How long a pod may wait for cluster capacity (Pending, the scheduler naming
 * an `Insufficient …` resource) before the `agent-pod:capacity` alert opens.
 */
export const AGENT_POD_CAPACITY_ALERT_MS = 30 * 60 * 1000;
/** How long a pod may wait for cluster capacity before its row is failed (matches db.STALE_RUNNING_WORK_MS, not read from db so mocked-db tests can import this module). */
export const AGENT_POD_CAPACITY_WAIT_MAX_MS = 6 * 60 * 60 * 1000;
/** How long a launch waits for a replaced leftover Pod or Secret to be gone. */
const REPLACE_WAIT_MS = 2 * 60 * 1000;
const REPLACE_POLL_MS = 2_000;
/**
 * Consecutive delete failures after which the manual cleanup command is logged
 * and a finished row's watch gives up, leaving the rest to the orphan sweep.
 */
const DELETE_FAILURES_BEFORE_HINT = 5;
const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function isDeniedAgentEnvVar(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true;
  // Claude account tokens are database state the pod reads through the ops
  // API (`listClaudeAccounts`), so a re-login reaches its next attempt; a stale
  // env copy must never ride in its Secret.
  if (isClaudeTokenEnvKey(name) || name === "CLAWS_CLAUDE_ACCOUNTS") return true;
  return ENV_DENY_EXACT.has(name) || ENV_DENY_PREFIXES.some((p) => name.startsWith(p));
}

export interface AgentPodLaunchDeps {
  /** A service-side file's contents, or null when absent/unreadable. */
  readFile: (p: string) => string | null;
  /** The service's HOME, where the file-backed env vars were written. */
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /** The service's `~/.claws/config.json`. */
  configPath: string;
  /** The agent pod's own `memory` limit (e.g. `"6Gi"`), used to derive its watchdog cap. */
  podMemoryLimit: string;
  /** A fresh random MCP bearer token. */
  newToken: () => string;
  /** The service's discovered Forgejo repos, shipped so the pod's managed-repo set matches the service's. */
  forgejoRepos: () => readonly string[];
  /** Whether the service has a Forgejo token, i.e. expects Forgejo repos. */
  forgejoConfigured: () => boolean;
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export const defaultAgentPodLaunchDeps: AgentPodLaunchDeps = {
  readFile: readFileOrNull,
  homeDir: os.homedir(),
  env: process.env,
  // A getter: tests that mock config.js without CONFIG_PATH still import this module.
  get configPath() { return CONFIG_PATH; },
  // A getter, in the same style as `configPath`: tests that mock config.js
  // without AGENT_POD_SETTINGS.memoryLimit still import this module.
  get podMemoryLimit() { return AGENT_POD_SETTINGS.memoryLimit; },
  newToken: () => crypto.randomBytes(32).toString("hex"),
  // Resolved per launch, in the same style as `configPath`: tests that mock
  // config.js without discoveredForgejoRepos still import this module.
  forgejoRepos: () => discoveredForgejoRepos(),
  forgejoConfigured: () => forgejo.isConfigured(),
};

export interface AgentPodLaunch {
  secretData: Record<string, string>;
  spec: AgentLaunchSpec;
  /** SHA-256 of the run's MCP token, persisted before the Secret exists. */
  mcpTokenSha256: string;
}

/**
 * Build the Secret data and launch spec for running `row` under `runId` in a
 * pod. The Secret carries the service's Forgejo and CLI credentials (env,
 * config) — the pod runs service code, not a user session — but never its
 * database or GitHub App ones, plus a fresh per-run MCP token the service accepts by hash
 * while the row runs, for claws-state and the agent-pod ops API.
 */
export function buildAgentPodLaunch(row: db.WorkQueueRow, runId: string, deps: AgentPodLaunchDeps = defaultAgentPodLaunchDeps): AgentPodLaunch {
  const secretData: Record<string, string> = {};
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps.env)) {
    if (v === undefined || isDeniedAgentEnvVar(k)) continue;
    vars[k] = v;
  }
  vars.CLAWS_WORK_BACKEND = "in-process";
  const podMemoryLimitBytes = parseK8sMemoryQuantity(deps.podMemoryLimit);
  if (podMemoryLimitBytes === null) {
    log.warn(`[agent-pod] Pod memory limit "${deps.podMemoryLimit}" is unparseable — using the ${Math.round(agentPodWatchdogCapBytes(null) / (1024 * 1024))}MiB floor for the watchdog cap`);
  }
  vars.CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES = String(agentPodWatchdogCapBytes(podMemoryLimitBytes));
  for (const { name, file } of FILE_BACKED_ENV) {
    const content = deps.readFile(path.join(deps.homeDir, file));
    if (content !== null) vars[name] = content.replace(/\n$/, "");
  }

  const files: AgentLaunchSpec["files"] = [];
  const rawConfig = deps.readFile(deps.configPath);
  if (rawConfig !== null) {
    let content = rawConfig;
    try {
      const parsed = JSON.parse(rawConfig) as Record<string, unknown>;
      // Same reasoning as the ENV_DENY_EXACT entries above: the pod derives its
      // own watchdog cap from its own memory limit.
      for (const key of ["agentWorkerMemoryMaxBytes", "claudeWorkerMemoryMaxBytes", "agentWorkerMemoryHeadroomBytes", "agentWorkerMemorySharedBudgetBytes", ...CONFIG_DENY_KEYS]) {
        delete parsed[key];
      }
      content = `${JSON.stringify(parsed, null, 2)}\n`;
    } catch {
      log.warn(`[agent-pod] ${deps.configPath} is not valid JSON — shipped unchanged`);
    }
    files.push({ path: path.posix.join(".claws", "config.json"), content });
  }

  const mcpToken = deps.newToken();
  secretData[MCP_TOKEN_KEY] = mcpToken;
  files.push({ path: path.posix.join(".claws", INTERNAL_MCP_TOKEN_FILE), content: mcpToken });

  secretData[AGENT_ENV_KEY] = renderSessionEnvFile(vars);
  const forgejoRepos = [...deps.forgejoRepos()];
  if (forgejoRepos.length === 0 && deps.forgejoConfigured()) {
    log.warn(`[agent-pod] Forgejo is configured but no Forgejo repos are discovered yet — ${row.kind} ${row.repo}#${row.item_number} will treat every repo as unmanaged`);
  }
  const spec: AgentLaunchSpec = { rowId: row.id, runId, files, forgejoRepos };
  secretData[LAUNCH_SPEC_KEY] = JSON.stringify(spec);
  return { secretData, spec, mcpTokenSha256: hashAgentMcpToken(mcpToken) };
}

export type AgentPodPlacement = Pick<SessionPodSettings, "namespace" | "image" | "imagePullSecrets" | "nodeSelector" | "priorityClassName">;

export interface AgentPodLauncherSettings extends AgentPodPlacement {
  resources: AgentPodSettings;
}

/**
 * The agent Pod for `rowId`, a `kind` row, whose Secret holds `secretKeys`.
 * Every kind takes the off-node placement when one is configured: losing its
 * pod with a part-time node costs one automatic re-run, which a push-capable
 * kind resumes on its own branch. With none configured, the pod keeps the
 * session placement.
 */
export function buildAgentPod(rowId: number, kind: string, secretKeys: string[], settings: AgentPodLauncherSettings): ReturnType<typeof buildWorkloadPod> {
  const offNode = settings.resources.offNode;
  return buildWorkloadPod({
    kind: AGENT_WORKLOAD_KIND,
    id: String(rowId),
    namespace: settings.namespace,
    image: settings.image,
    secretKeys,
    imagePullSecrets: settings.imagePullSecrets,
    nodeSelector: offNode?.nodeSelector ?? settings.nodeSelector,
    ...(offNode
      ? {
        tolerations: offNode.tolerations,
        affinity: offNode.preferredNodes.length
          ? {
            nodeAffinity: {
              preferredDuringSchedulingIgnoredDuringExecution: [{
                weight: 100,
                preference: { matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: offNode.preferredNodes }] },
              }],
            },
          }
          : undefined,
      }
      : {}),
    priorityClassName: settings.priorityClassName,
    resources: {
      cpuRequest: settings.resources.cpuRequest,
      memoryRequest: settings.resources.memoryRequest,
      memoryLimit: settings.resources.memoryLimit,
      ephemeralStorageRequest: settings.resources.ephemeralStorageRequest,
      ephemeralStorageLimit: settings.resources.ephemeralStorageLimit,
    },
    home: { emptyDir: { sizeLimit: settings.resources.homeSize } },
    terminalPort: false,
    env: [{ name: "CLAWS_AGENT_POD_ROW", value: String(rowId) }],
    initArgs: null,
    args: ["/bin/sh", "-c", `. ${path.posix.join(WORKLOAD_SECRET_DIR, AGENT_ENV_KEY)} && exec /opt/claws/deploy/container-entrypoint.sh`],
  });
}

/** `YYYY-MM-DD HH:MM:SS` (UTC, as db.ts stores it) to epoch ms, or null. */
function sqlTimeMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** The job-run status for a row the launcher cleans up; unlike `agent-pod/run.ts`'s `jobRunStatusFor`, never null. */
function launcherJobRunStatus(status: string): "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "cancelled" ? status : "failed";
}

export interface AgentPodLauncherOptions {
  client: K8sClient;
  settings: AgentPodLauncherSettings;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  launchDeps?: AgentPodLaunchDeps;
}

export interface AgentPodInFlight {
  workerId: number;
  rowId: number;
  runId: string;
  podName: string;
}

export interface AgentPodLauncher {
  /** Launch (or, with `adopt`, re-attach to) `row`'s pod and watch it until the row ends or Claws shuts down. */
  runRowInPod(workerId: number, row: db.WorkQueueRow, opts: { adopt: boolean }): Promise<void>;
  /** Cancel the pod running `runId`; false when this process is not watching it. */
  cancelByRunId(runId: string): boolean;
  /** Cancel every pod this process is watching — recorded on each job run first, so a restart does not lose it; returns how many. */
  cancelAll(): Promise<number>;
  inFlight(): AgentPodInFlight[];
  /** Delete agent Pods and Secrets whose row is missing or no longer running. */
  sweepOrphans(): Promise<void>;
  /** Run `sweepOrphans` now and hourly — then `reconcile` on each later tick; returns a stop function. */
  startOrphanSweep(reconcile?: () => Promise<unknown>): () => void;
}

interface Watch extends AgentPodInFlight {
  cancelRequested: boolean;
  /** The launcher asked for the pod's deletion, so its deletionTimestamp is expected. */
  deleteRequested: boolean;
  /** The pod is Pending because the cluster has no room for it yet. */
  waitingForCapacity: boolean;
}

const IMAGE_PULL_ALERT_TITLE = "[claws-error] agent-pod:image-pull";
const CAPACITY_ALERT_TITLE = "[claws-error] agent-pod:capacity";

/** True when a failRow reason is the kubelet failing to pull or resolve the pod image. */
export function isImagePullFailure(reason: string): boolean {
  return /\b(ImagePullBackOff|ErrImagePull|InvalidImageName|ErrImageNeverPull)\b/.test(reason);
}

/** Set while an image-pull alert may be open; starts true so the first healthy pod after a restart checks once. */
let imagePullAlertMayBeOpen = true;

/**
 * True when a pending reason is the scheduler finding no node with room for
 * the pod — a transient shortage, not a broken run. Other Unschedulable
 * reasons (selector mismatch, taints only) are not.
 */
export function isCapacityShortage(reason: string): boolean {
  return /\bInsufficient\b|Too many pods/.test(reason);
}

/** Set once this process opened a capacity alert, until a waiting pod is scheduled. */
let capacityAlertMayBeOpen = true;

export function createAgentPodLauncher(opts: AgentPodLauncherOptions): AgentPodLauncher {
  const { client, settings } = opts;
  const ns = settings.namespace;
  const pollMs = opts.pollMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const launchDeps = opts.launchDeps ?? defaultAgentPodLaunchDeps;
  const watches = new Map<string, Watch>();
  let secretListForbiddenLogged = false;

  const cleanupHint = (id: string) => `kubectl -n ${ns} delete pod,secret -l ${LABEL_WORKLOAD_ID}=${id}`;

  /** Delete one object; true when it is gone (a 404 counts). A delete that took effect is logged at debug to trace teardown timing. */
  async function deleteObject(resource: K8sResource, name: string, rowId: number): Promise<boolean> {
    const res = await client.delete(resource, ns, name);
    if (res.ok) log.debug(`[agent-pod] Deleted ${resource} ${name} (work row ${rowId})`);
    if (res.ok || res.kind === "not-found") return true;
    log.warn(`[agent-pod] Deleting ${resource} ${name} failed: ${res.message}`);
    return false;
  }

  function requestPodDelete(watch: Watch): void {
    watch.deleteRequested = true;
    void deleteObject("pods", watch.podName, watch.rowId);
  }

  /**
   * Create `obj`, replacing a same-named leftover. The row id, and so the name,
   * is reused: a boot that crashed after `create pods` but before
   * `setWorkAgentPod` re-queues the row and leaves its Secret and a live Pod,
   * which the next claim collides with before the orphan sweep (which skips a
   * running row) can remove them. That pod's run was superseded, so it goes.
   */
  async function createReplacing(resource: K8sResource, name: string, obj: K8sObject, rowId: number): Promise<K8sResult<K8sObject>> {
    const res = await client.create(resource, ns, obj);
    if (res.ok || res.kind !== "conflict") return res;
    log.warn(`[agent-pod] ${resource} ${name} already exists — replacing it`);
    if (!await deleteObject(resource, name, rowId)) return res;
    // A terminating object still holds its name.
    for (let waited = 0; ; waited += REPLACE_POLL_MS) {
      const got = await client.get(resource, ns, name);
      if (!got.ok && got.kind === "not-found") return client.create(resource, ns, obj);
      if (waited >= REPLACE_WAIT_MS) return { ...res, message: `${res.message} (the leftover ${resource} ${name} is still terminating)` };
      await sleep(REPLACE_POLL_MS);
    }
  }

  async function launch(row: db.WorkQueueRow, runId: string, name: string): Promise<boolean> {
    const fail = async (detail: string) => {
      log.warn(`[agent-pod] Launching ${name} for work row ${row.id} failed: ${detail}`);
      await deleteObject("pods", name, row.id);
      await deleteObject("secrets", name, row.id);
      await db.markWorkFailed(row.id, `agent pod launch failed: ${detail}`);
      try { await db.completeJobRun(runId, "failed"); } catch { /* best effort */ }
      return false;
    };
    let built: AgentPodLaunch;
    try {
      built = buildAgentPodLaunch(row, runId, launchDeps);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    // The token is accepted before the pod can use it; `agent_pod` is recorded
    // only once the pod exists, so a boot that crashed before then re-queues
    // the row (recoverWorkOnStartup) and an adopted row always had a pod.
    await db.setWorkAgentMcpToken(row.id, built.mcpTokenSha256);
    const secretObj = buildWorkloadSecret({ kind: AGENT_WORKLOAD_KIND, id: String(row.id), namespace: ns, data: built.secretData });
    const secret = await createReplacing("secrets", name, secretObj, row.id);
    if (!secret.ok) return fail(secret.message);
    const pod = await createReplacing("pods", name, buildAgentPod(row.id, row.kind, Object.keys(built.secretData), settings), row.id);
    if (!pod.ok) return fail(pod.message);
    await db.setWorkAgentPod(row.id, name);
    log.info(`[agent-pod] Launched ${name} for ${row.kind} ${row.repo}#${row.item_number} (run ${runId})`);
    return true;
  }

  async function failTasks(runId: string, reason: string): Promise<void> {
    try {
      for (const task of await db.getTasksByRunId(runId)) {
        if (task.status === "running") await db.recordTaskFailed(task.id, reason, { failureCategory: "external-kill" });
      }
    } catch (err) {
      log.warn(`[agent-pod] Could not fail the tasks of run ${runId}: ${err}`);
    }
  }

  /**
   * Fail a row whose pod died (or vanished, never started, or overran) while it
   * was still 'running'. A no-op when the pod ended the row first.
   */
  async function failRow(row: db.WorkQueueRow, runId: string, reason: string, adopt: boolean, launchedAt: number, cause?: string | null): Promise<void> {
    // The cause is appended only to what is stored and reported; classification uses the bare reason.
    const shown = cause ? `${reason} — last pod event: ${cause}` : reason;
    if (!await db.markWorkFailedIfRunning(row.id, runId, shown)) return;
    const origin = adopt
      ? "adopted after a Claws restart"
      : `launched by this process ${Math.round((now() - launchedAt) / 60_000)}m ago`;
    const context = row.item_number === 0 ? row.repo : `${row.repo}#${row.item_number}`;
    const repeatable = reason.startsWith("agent pod not found") && REPO_SCOPED_KINDS.has(row.kind);
    const runtimeLost = reason.startsWith(RUNTIME_LOST_REASON);
    log.warn(`[agent-pod] ${row.kind} ${context} (id=${row.id}, run=${runId}, ${origin}): ${shown}${repeatable ? " — repeatable kind, next cycle re-runs it; no error report" : ""}${runtimeLost ? " — node/runtime disruption; no error report" : ""}`);
    await failTasks(runId, shown);
    if (repeatable || runtimeLost) return;
    // A capacity shortage is not a defect: the `agent-pod:capacity` alert covers it.
    if (isCapacityShortage(reason)) return;
    if (isImagePullFailure(reason)) {
      imagePullAlertMayBeOpen = true;
      try {
        const image = settings.image;
        const registry = image.includes("/") ? image.slice(0, image.indexOf("/")) : image;
        const secrets = settings.imagePullSecrets.length > 0 ? settings.imagePullSecrets.join(", ") : "(none)";
        await ensureAlertIssue({
          repo: SELF_REPO,
          title: IMAGE_PULL_ALERT_TITLE,
          body: [
            "**Auto-created by the Claws agent pod launcher**",
            "",
            "Agent pods cannot pull their image.",
            "",
            `- Image: \`${image}\``,
            `- Registry: \`${registry}\``,
            `- Namespace: \`${ns}\``,
            `- Pull secrets: ${secrets}`,
            `- Latest affected row: ${row.kind} ${context}`,
            `- Latest reason: ${reason}`,
            "",
            "Check that the tag was published to that registry, and that each listed secret exists in the namespace with credentials for that host.",
            "This issue closes itself when an agent pod next starts.",
          ].join("\n"),
          logPrefix: "agent-pod",
          refreshBody: true,
        });
      } catch {
        // best effort
      }
      return;
    }
    // A reason-less never-started pod reaching here has already stalled twice: one issue, not one per run.
    // Likewise a pod that vanished on its retry too.
    const fingerprint = reason.startsWith(NEVER_STARTED_PREFIX) && /: (never scheduled|scheduled to node )/.test(reason)
      ? "agent-pod:never-started"
      : reason.startsWith(`${VANISHED_PREFIX} on retry`) ? "agent-pod:vanished" : "agent-pod:run";
    try {
      await reportError(fingerprint, context, new Error(`${row.kind}: ${shown} (${origin})`), { repo: row.repo });
    } catch {
      // best effort
    }
  }

  /** The pod's latest Warning event, read once when the start timeout fires; null when none or unreadable. */
  async function podStallCause(name: string): Promise<string | null> {
    const res = await client.listEvents(ns, `involvedObject.kind=Pod,involvedObject.name=${name}`);
    if (!res.ok) {
      log.info(`[agent-pod] Cannot read events for pod ${name}: ${res.message}`);
      return null;
    }
    return latestWarningEvent(res.value);
  }

  /** Open (or refresh) the single capacity alert for a row whose pod has waited `waitedMs`. */
  async function raiseCapacityAlert(row: db.WorkQueueRow, reason: string, waitedMs: number): Promise<void> {
    capacityAlertMayBeOpen = true;
    const context = row.item_number === 0 ? row.repo : `${row.repo}#${row.item_number}`;
    const waiting = [...watches.values()].filter((w) => w.waitingForCapacity).length;
    const r = settings.resources;
    try {
      await ensureAlertIssue({
        repo: SELF_REPO,
        title: CAPACITY_ALERT_TITLE,
        body: [
          "**Auto-created by the Claws agent pod launcher**",
          "",
          "Agent pods are waiting for cluster capacity: the scheduler has no node with room for them. Their runs are not failed; they start once capacity frees.",
          "",
          `- Namespace: \`${ns}\``,
          `- Requests per pod: cpu \`${r.cpuRequest}\`, memory \`${r.memoryRequest}\`, ephemeral-storage \`${r.ephemeralStorageRequest}\``,
          `- Pods waiting for capacity: ${waiting}`,
          `- Latest affected row: ${row.kind} ${context}, waiting ${Math.round(waitedMs / 60_000)}m`,
          `- Scheduler: ${reason}`,
          "",
          "Lower `CLAWS_AGENT_POD_EPHEMERAL_STORAGE_REQUEST`, `CLAWS_AGENT_POD_MEMORY_REQUEST` or `CLAWS_MAX_WORK_WORKERS`, or add node disk.",
          "This issue closes itself when a waiting agent pod is next scheduled.",
        ].join("\n"),
        logPrefix: "agent-pod",
        refreshBody: true,
      });
    } catch {
      // best effort
    }
  }

  async function watch(w: Watch, row: db.WorkQueueRow, adopt: boolean, launchedAt: number): Promise<void> {
    const name = w.podName;
    let lastApiState: string | null = null;
    let terminalSince: number | null = null;
    let jobRunCompleted = false;
    let deleteFailures = 0;
    let staleKillRequested = false;
    let pendingSince: number | null = null;
    let lostSince: number | null = null;
    let forceDeleted = false;
    // Waiting for cluster capacity is not counted toward the stale-work ceiling.
    let capacityWaitSince: number | null = null;
    let capacityAlerted = false;
    let wait = false;

    const apiState = (state: string | null) => {
      if (state !== lastApiState && state !== null) log.warn(`[agent-pod] ${name}: ${state} — will retry`);
      lastApiState = state;
    };

    /** Delete Pod and Secret; true once both are gone. */
    const deleteBoth = async (): Promise<boolean> => {
      const podGone = await deleteObject("pods", name, w.rowId);
      const secretGone = await deleteObject("secrets", name, w.rowId);
      if (podGone && secretGone) return true;
      deleteFailures++;
      if (deleteFailures === DELETE_FAILURES_BEFORE_HINT) {
        log.error(`[agent-pod] Could not delete ${name} after ${deleteFailures} attempts — clean up with: ${cleanupHint(String(w.rowId))}`);
      }
      return false;
    };

    /**
     * Re-queue the row once its pod and Secret are gone, so the next attempt
     * starts clean. False when the objects could not be deleted.
     */
    const requeueOnce = async (reason: string, logLine: string, prior?: string | null): Promise<boolean> => {
      log.warn(logLine);
      await failTasks(w.runId, reason);
      while (!await deleteBoth()) {
        if (deleteFailures >= DELETE_FAILURES_BEFORE_HINT) return false;
        await sleep(pollMs);
      }
      try { await db.completeJobRun(w.runId, "failed"); } catch { /* best effort */ }
      // Carry an earlier retry's marker forward so each budget stays spent.
      const carried = prior && (prior.includes(VANISHED_PREFIX) || prior.includes(NEVER_STARTED_PREFIX) || prior.includes(ADMISSION_REJECTED_PREFIX)) ? ` | earlier: ${prior}` : "";
      await db.releaseClaimedWork(w.rowId, w.runId, `${reason} — retried once${carried}`);
      return true;
    };

    // Why the pod was being deleted by someone else, seen before it disappeared.
    let disruption: string | null = null;
    let runtimeLost = false;

    for (;;) {
      if (wait) await sleep(pollMs);
      wait = true;
      if (isShuttingDown()) return; // left running; the next boot adopts it

      // The pod is read before the row: a pod that has exited wrote its row first,
      // so a terminal pod is never paired with a stale 'running' row.
      const podRes = await client.get<K8sObject & PodLike>("pods", ns, name);
      if (!podRes.ok && podRes.kind !== "not-found") {
        apiState(podRes.message);
        continue;
      }
      let current: db.WorkQueueRow | undefined;
      let cancelled = w.cancelRequested;
      try {
        current = await db.getWorkRow(w.rowId);
        if (!cancelled) cancelled = (await db.getJobRun(w.runId))?.status === "cancelled";
      } catch (err) {
        apiState(`database read failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      apiState(null);
      const pod = podRes.ok ? podRes.value : null;
      const classification = pod ? classifyPod(pod) : null;
      const podEnded = !pod || classification?.state === "succeeded" || classification?.state === "failed";
      if (pod?.metadata?.deletionTimestamp && !w.deleteRequested && !cancelled && disruption === null) {
        disruption = podDisruptionReason(pod) ?? "deleted outside Claws";
        log.warn(`[agent-pod] ${name} (run ${w.runId}): being deleted outside Claws — ${disruption}`);
      }

      if (classification?.runtimeLost && !w.deleteRequested && !cancelled && disruption === null) {
        disruption = classification.detail ?? "container lost to a node or runtime restart";
        runtimeLost = true;
        log.warn(`[agent-pod] ${name} (run ${w.runId}): container lost to a node or runtime restart`);
      }

      // A pod evicted from a powered-off node stays Terminating until its kubelet
      // returns. Force-delete it once; the next poll's 404 takes the vanish path.
      const deletingSince = pod?.metadata?.deletionTimestamp ? Date.parse(pod.metadata.deletionTimestamp) : NaN;
      if (
        pod && !forceDeleted && !Number.isNaN(deletingSince) && now() - deletingSince > TAINT_EVICTION_FORCE_DELETE_MS
        && pod.status?.conditions?.some((c) => c.type === "DisruptionTarget" && c.status === "True" && c.reason === "DeletionByTaintManager")
      ) {
        forceDeleted = true;
        log.warn(`[agent-pod] ${name} (run ${w.runId}): stuck terminating after a taint-manager eviction (node lost) — force-deleting`);
        const res = await client.delete("pods", ns, name, { gracePeriodSeconds: 0 });
        if (res.ok) log.debug(`[agent-pod] Force-deleted pods ${name} (work row ${w.rowId})`);
        else if (res.kind !== "not-found") log.warn(`[agent-pod] Force-deleting pod ${name} failed: ${res.message}`);
        continue;
      }

      try {
        // ── Row finished (by the pod, or by us below): clean up. ──
        if (!current || current.status !== "running" || current.run_id !== w.runId) {
          terminalSince ??= now();
          if (!podEnded && now() - terminalSince < TERMINAL_POD_EXIT_WAIT_MS) continue;
          if (!jobRunCompleted) {
            // The pod completes its own job run; only one it left open is completed here.
            try {
              if ((await db.getJobRun(w.runId))?.status === "running") {
                await db.completeJobRun(w.runId, current && current.run_id === w.runId ? launcherJobRunStatus(current.status) : "failed");
              }
            } catch { /* best effort */ }
            jobRunCompleted = true;
          }
          if (await deleteBoth()) return;
          // Past the hint, free the worker: the orphan sweep deletes a finished row's objects.
          if (deleteFailures >= DELETE_FAILURES_BEFORE_HINT) return;
          continue;
        }

        // ── Dashboard cancel: stop the pod, then end the row. ──
        if (cancelled) {
          if (pod) {
            if (!pod.metadata?.deletionTimestamp) await deleteObject("pods", name, w.rowId);
            continue;
          }
          if (await db.markWorkCancelledIfRunning(w.rowId, w.runId, "run cancelled")) {
            log.info(`[agent-pod] ${row.kind} ${row.repo}#${row.item_number} cancelled`);
          }
          wait = false;
          continue;
        }

        // A pod deleted outside Claws is vanished whether last seen as 404 or in
        // its terminal phase while still being deleted.
        if (!pod || (podEnded && disruption !== null && !w.deleteRequested)) {
          // `agent_pod` is set only after the pod was created, so an adopted row's
          // pod existed too: it was deleted, or lost with its node.
          if (!pod && !adopt && now() - launchedAt < WORKLOAD_LAUNCH_GRACE_MS) continue;
          const notFound = runtimeLost ? RUNTIME_LOST_REASON : disruption ? `agent pod not found (disrupted: ${disruption})` : "agent pod not found";
          if (w.deleteRequested || REPO_SCOPED_KINDS.has(current.kind)) {
            await failRow(current, w.runId, notFound, adopt, launchedAt);
            wait = false;
            continue;
          }
          const detail = disruption ?? "deleted outside Claws";
          if (current.error_message?.includes(VANISHED_PREFIX)) {
            await failRow(current, w.runId, `${VANISHED_PREFIX} on retry: ${detail} (first attempt's pod also vanished)`, adopt, launchedAt);
            wait = false;
            continue;
          }
          const context = current.item_number === 0 ? current.repo : `${current.repo}#${current.item_number}`;
          const reason = `${VANISHED_PREFIX}: ${detail}`;
          if (await requeueOnce(reason, `[agent-pod] ${current.kind} ${context} pod ${name} (run ${w.runId}): ${reason} — re-queueing once`, current.error_message)) return;
          // Could not clear the Secret: fail the row so the worker is still freed.
          await failRow(current, w.runId, notFound, adopt, launchedAt);
          wait = false;
          continue;
        }

        if (podEnded && classification?.admissionRejected) {
          if (current.error_message?.includes(ADMISSION_REJECTED_PREFIX)) {
            await failRow(current, w.runId, `${ADMISSION_REJECTED_PREFIX}: ${classification.detail} (second attempt; first was rejected the same way)`, adopt, launchedAt);
            wait = false;
            continue;
          }
          const context = current.item_number === 0 ? current.repo : `${current.repo}#${current.item_number}`;
          const reason = `${ADMISSION_REJECTED_PREFIX}: ${classification.detail}`;
          if (await requeueOnce(reason, `[agent-pod] ${current.kind} ${context} pod ${name} (run ${w.runId}): ${reason} — re-queueing once`, current.error_message)) return;
          await failRow(current, w.runId, reason, adopt, launchedAt);
          wait = false;
          continue;
        }

        if (podEnded) {
          const detail = classification?.detail ? `: ${classification.detail}` : "";
          await failRow(current, w.runId, `agent pod ${classification?.state}${detail}`, adopt, launchedAt);
          wait = false;
          continue;
        }

        if (imagePullAlertMayBeOpen && (classification?.state === "running" || classification?.state === "ready")) {
          imagePullAlertMayBeOpen = false;
          try {
            await closeAlertIssueIfResolved({ repo: SELF_REPO, title: IMAGE_PULL_ALERT_TITLE, logPrefix: "agent-pod", reason: "an agent pod pulled its image" });
          } catch {
            // best effort
          }
        }

        const scheduled = classification?.state === "running" || classification?.state === "ready";
        if (capacityAlertMayBeOpen && scheduled && ![...watches.values()].some((other) => other !== w && other.waitingForCapacity)) {
          capacityAlertMayBeOpen = false;
          try {
            await closeAlertIssueIfResolved({ repo: SELF_REPO, title: CAPACITY_ALERT_TITLE, logPrefix: "agent-pod", reason: "a waiting agent pod was scheduled" });
          } catch {
            // best effort
          }
        }

        if (classification?.state === "pending" && isCapacityShortage(classification.detail ?? "")) {
          // The scheduler queues the pod until a node has room: keep watching.
          pendingSince = null;
          if (capacityWaitSince === null) {
            capacityWaitSince = podCreatedAt(pod) ?? now();
            log.warn(`[agent-pod] ${name}: waiting for cluster capacity — ${classification.detail}`);
          }
          w.waitingForCapacity = true;
          const waited = now() - capacityWaitSince;
          if (waited > AGENT_POD_CAPACITY_WAIT_MAX_MS) {
            await failRow(current, w.runId, `agent pod never started: ${classification.detail}`, adopt, launchedAt);
            requestPodDelete(w);
            wait = false;
            continue;
          }
          if (!capacityAlerted && waited > AGENT_POD_CAPACITY_ALERT_MS) {
            capacityAlerted = true;
            await raiseCapacityAlert(current, classification.detail ?? "", waited);
          }
          continue;
        }
        if (capacityWaitSince !== null) {
          capacityWaitSince = null;
          w.waitingForCapacity = false;
        }

        if (classification?.state === "pending") {
          pendingSince ??= now();
          if (now() - pendingSince > AGENT_POD_START_TIMEOUT_MS) {
            const cause = await podStallCause(name);
            const causeNote = cause ? ` (last pod event: ${cause})` : "";
            if (classification.neverStarted) {
              if (!current.error_message?.includes(NEVER_STARTED_PREFIX)) {
                // First stall: retry once by re-queueing the row, once pod and Secret are gone.
                const reason = `${NEVER_STARTED_PREFIX}: ${classification.detail}`;
                if (await requeueOnce(reason, `[agent-pod] ${current.kind} ${current.repo}#${current.item_number} pod ${name}: ${reason}${causeNote} — re-queueing once`, current.error_message)) return;
                // Could not clear the objects: fail the row so the worker is still freed.
                await failRow(current, w.runId, reason, adopt, launchedAt, cause);
                requestPodDelete(w);
                wait = false;
                continue;
              }
              await failRow(current, w.runId, `${NEVER_STARTED_PREFIX}: ${classification.detail} (second attempt; first stalled the same way)`, adopt, launchedAt, cause);
              requestPodDelete(w);
              wait = false;
              continue;
            }
            await failRow(current, w.runId, `agent pod never started: ${classification.detail ?? "pending"}`, adopt, launchedAt, cause);
            requestPodDelete(w);
            wait = false;
            continue;
          }
        } else {
          pendingSince = null;
        }

        // Phase Unknown (node unreachable), or a deletion we did not make that
        // never completes (a lost node's pod stays Terminating): neither ends on
        // its own, so bound it well below the stale-work ceiling.
        // A pod the kubelet has not reported on yet has no phase: not lost.
        const lost = classification?.state === "unknown" && classification.detail
          ? `phase ${classification.detail}`
          : pod.metadata?.deletionTimestamp && !w.deleteRequested ? "stuck terminating" : null;
        if (lost) {
          lostSince ??= now();
          if (now() - lostSince > AGENT_POD_LOST_TIMEOUT_MS) {
            await failRow(current, w.runId, `agent pod lost: ${lost}`, adopt, launchedAt);
            requestPodDelete(w);
            wait = false;
            continue;
          }
        } else {
          lostSince = null;
        }

        if (!staleKillRequested && now() - Math.max(launchedAt, podScheduledAt(pod) ?? 0) > db.STALE_RUNNING_WORK_MS) {
          staleKillRequested = true;
          requestPodDelete(w);
          await failRow(current, w.runId, `agent pod exceeded ${db.STALE_RUNNING_WORK_MS / 3_600_000}h ceiling`, adopt, launchedAt);
          wait = false;
          continue;
        }
      } catch (err) {
        apiState(`database write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const launcher: AgentPodLauncher = {
    async runRowInPod(workerId, row, { adopt }) {
      const runId = row.run_id;
      const name = workloadName(AGENT_WORKLOAD_KIND, String(row.id));
      if (!runId) {
        log.warn(`[agent-pod] Work row ${row.id} has no run id — cannot run it in a pod`);
        await db.markWorkFailed(row.id, "agent pod launch failed: row has no run id");
        return;
      }
      let launchedAt: number;
      if (adopt) {
        launchedAt = sqlTimeMs(row.started_at) ?? now();
        log.info(`[agent-pod] Adopting ${name} for ${row.kind} ${row.repo}#${row.item_number} (run ${runId})`);
      } else {
        try {
          if (!await launch(row, runId, name)) return;
        } catch (err) {
          log.warn(`[agent-pod] Launching ${name} failed: ${err}`);
          try {
            await db.markWorkFailed(row.id, `agent pod launch failed: ${err instanceof Error ? err.message : String(err)}`);
            await db.completeJobRun(runId, "failed");
          } catch { /* best effort */ }
          await deleteObject("pods", name, row.id);
          await deleteObject("secrets", name, row.id);
          return;
        }
        launchedAt = now();
      }
      const w: Watch = { workerId, rowId: row.id, runId, podName: name, cancelRequested: false, deleteRequested: false, waitingForCapacity: false };
      watches.set(runId, w);
      try {
        await watch(w, row, adopt, launchedAt);
      } finally {
        watches.delete(runId);
      }
    },

    cancelByRunId(runId) {
      const w = watches.get(runId);
      if (!w) return false;
      w.cancelRequested = true;
      requestPodDelete(w);
      return true;
    },

    async cancelAll() {
      const all = [...watches.values()];
      for (const w of all) {
        w.cancelRequested = true;
        // Persisted before the pod goes, so a restart inside the next poll
        // adopts the row as cancelled instead of failing or re-running it.
        try {
          await db.cancelJobRunIfRunning(w.runId);
        } catch (err) {
          log.warn(`[agent-pod] Could not record the cancel of run ${w.runId}: ${err}`);
        }
        requestPodDelete(w);
      }
      return all.length;
    },

    inFlight() {
      return [...watches.values()].map(({ workerId, rowId, runId, podName }) => ({ workerId, rowId, runId, podName }));
    },

    async sweepOrphans() {
      const selector = workloadSelector(AGENT_WORKLOAD_KIND);
      for (const resource of ["pods", "secrets"] as const) {
        const listed = await client.list(resource, ns, selector);
        if (!listed.ok) {
          // The claws-sessions Role has no `list` on Secrets; an orphan pod's
          // Secret still goes with it below, and adoption deletes a pod-less one.
          if (resource === "secrets" && listed.kind === "forbidden") {
            if (!secretListForbiddenLogged) log.info(`[agent-pod] Orphan sweep cannot list Secrets (${listed.message}) — sweeping them only alongside their pods`);
            secretListForbiddenLogged = true;
          } else {
            log.warn(`[agent-pod] Orphan sweep could not list ${resource}: ${listed.message}`);
          }
          continue;
        }
        for (const obj of listed.value) {
          const name = obj.metadata?.name;
          const id = Number(obj.metadata?.labels?.[LABEL_WORKLOAD_ID]);
          if (!name || obj.metadata?.deletionTimestamp || !Number.isInteger(id)) continue;
          let row: db.WorkQueueRow | undefined;
          try {
            row = await db.getWorkRow(id);
          } catch (err) {
            log.warn(`[agent-pod] Orphan sweep could not read work row ${id}: ${err}`);
            continue;
          }
          if (row?.status === "running") continue;
          log.info(`[agent-pod] Deleting orphaned ${resource} ${name} (work row ${row ? row.status : "missing"})`);
          await deleteObject(resource, name, id);
          if (resource === "pods") await deleteObject("secrets", name, id);
        }
      }
    },

    startOrphanSweep(reconcile) {
      const run = () => {
        launcher.sweepOrphans().catch((err) => log.warn(`[agent-pod] Orphan sweep failed: ${err}`));
      };
      run();
      const timer = setInterval(() => {
        run();
        reconcile?.().catch((err) => log.warn(`[agent-pod] Re-adopting unwatched pod-backed rows failed: ${err}`));
      }, ORPHAN_SWEEP_INTERVAL_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
  return launcher;
}

let defaultLauncher: AgentPodLauncher | undefined;

/** The process-wide launcher on the in-cluster client; created on first use. */
export function getAgentPodLauncher(): AgentPodLauncher {
  defaultLauncher ??= createAgentPodLauncher({
    client: createK8sClient(),
    settings: { ...SESSION_POD_SETTINGS, resources: AGENT_POD_SETTINGS },
  });
  return defaultLauncher;
}
