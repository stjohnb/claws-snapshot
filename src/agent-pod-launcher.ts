import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as db from "./db.js";
import * as log from "./log.js";
import { AGENT_POD_SETTINGS, CONFIG_PATH, SESSION_POD_SETTINGS, type AgentPodSettings, type SessionPodSettings } from "./config.js";
import { reportError } from "./error-reporter.js";
import { hashAgentMcpToken, INTERNAL_MCP_TOKEN_FILE } from "./internal-mcp-token.js";
import { isShuttingDown } from "./shutdown.js";
import { renderSessionEnvFile } from "./session-env-file.js";
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
  "CLAWS_SESSION_BACKEND", "CLAWS_WORK_BACKEND", "CLAWS_MAX_WORK_WORKERS",
  "CLAWS_DATABASE_URL", "CLAWS_DATABASE_PASSWORD",
  // Pod memory tuning is derived from the pod's own limit (see
  // `agentPodWatchdogCapBytes` below), not inherited from the service's env —
  // that is sized for the service's own, differently-sized container.
  "CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES", "CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES",
  "CLAWS_AGENT_WORKER_MEMORY_HEADROOM_BYTES", "CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES",
]);
const ENV_DENY_PREFIXES = ["KUBERNETES_", "CLAWS_OIDC_", "CLAWS_AUTH_SECRET_"];

/**
 * Vars `deploy/container-entrypoint.sh` turns back into HOME files and then
 * unsets, so the service no longer has them in its env: re-read from those files.
 */
const FILE_BACKED_ENV: ReadonlyArray<{ name: string; file: string }> = [
  { name: "CLAWS_SSH_PRIVATE_KEY", file: ".ssh/id_ed25519" },
  { name: "CLAWS_KUBECONFIG", file: ".kube/config" },
  { name: "CLAWS_PROD_KUBECONFIG", file: ".kube/prod-config" },
  { name: "CLAWS_CODEX_AUTH_JSON", file: ".codex/auth.json" },
  { name: "CLAWS_CLAUDE_SETTINGS_JSON", file: ".claude/settings.json" },
];

/** How long a row that reached a terminal status waits for its pod to exit on its own. */
export const TERMINAL_POD_EXIT_WAIT_MS = 2 * 60 * 1000;
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
  return ENV_DENY_EXACT.has(name) || ENV_DENY_PREFIXES.some((p) => name.startsWith(p));
}

/** Secret key of the `n`th GitHub App private key (1-based). */
export function githubAppKeySecretKey(n: number): string {
  return `github-app-${n}.pem`;
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
};

export interface AgentPodLaunch {
  secretData: Record<string, string>;
  spec: AgentLaunchSpec;
  /** SHA-256 of the run's MCP token, persisted before the Secret exists. */
  mcpTokenSha256: string;
}

/**
 * Build the Secret data and launch spec for running `row` under `runId` in a
 * pod. The Secret carries the service's forge and CLI credentials (env, GitHub
 * App keys, config) — the pod runs service code, not a user session — but never
 * its database ones, plus a fresh per-run MCP token the service accepts by hash
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

  // GitHub App private keys are service-side paths: ship their contents as
  // Secret keys and point the env var and config.json at the mounted copies.
  const keyPaths = new Map<string, string>();
  const relocate = (src: string): string => {
    const existing = keyPaths.get(src);
    if (existing) return existing;
    const content = deps.readFile(src);
    if (content === null) {
      log.warn(`[agent-pod] GitHub App private key ${src} is unreadable — not shipped to agent pods`);
      return src;
    }
    const key = githubAppKeySecretKey(keyPaths.size + 1);
    secretData[key] = content;
    const mounted = path.posix.join(WORKLOAD_SECRET_DIR, key);
    keyPaths.set(src, mounted);
    return mounted;
  };
  if (vars.CLAWS_GITHUB_APP_PRIVATE_KEY_PATH) {
    vars.CLAWS_GITHUB_APP_PRIVATE_KEY_PATH = relocate(vars.CLAWS_GITHUB_APP_PRIVATE_KEY_PATH);
  }

  const files: AgentLaunchSpec["files"] = [];
  const rawConfig = deps.readFile(deps.configPath);
  if (rawConfig !== null) {
    let content = rawConfig;
    try {
      const parsed = JSON.parse(rawConfig) as Record<string, unknown>;
      // Same reasoning as the ENV_DENY_EXACT entries above: the pod derives its
      // own watchdog cap from its own memory limit.
      for (const key of ["agentWorkerMemoryMaxBytes", "claudeWorkerMemoryMaxBytes", "agentWorkerMemoryHeadroomBytes", "agentWorkerMemorySharedBudgetBytes"]) {
        delete parsed[key];
      }
      if (typeof parsed.githubAppPrivateKeyPath === "string" && parsed.githubAppPrivateKeyPath) {
        parsed.githubAppPrivateKeyPath = relocate(parsed.githubAppPrivateKeyPath);
      }
      const owners = parsed.githubOwnerAppCredentials;
      if (owners && typeof owners === "object") {
        for (const cred of Object.values(owners as Record<string, { privateKeyPath?: unknown }>)) {
          if (cred && typeof cred.privateKeyPath === "string" && cred.privateKeyPath) {
            cred.privateKeyPath = relocate(cred.privateKeyPath);
          }
        }
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
  const spec: AgentLaunchSpec = { rowId: row.id, runId, files };
  secretData[LAUNCH_SPEC_KEY] = JSON.stringify(spec);
  return { secretData, spec, mcpTokenSha256: hashAgentMcpToken(mcpToken) };
}

export type AgentPodPlacement = Pick<SessionPodSettings, "namespace" | "image" | "imagePullSecrets" | "nodeSelector" | "priorityClassName">;

export interface AgentPodLauncherSettings extends AgentPodPlacement {
  resources: AgentPodSettings;
}

/** The agent Pod for `rowId`, whose Secret holds `secretKeys`. */
export function buildAgentPod(rowId: number, secretKeys: string[], settings: AgentPodLauncherSettings): ReturnType<typeof buildWorkloadPod> {
  return buildWorkloadPod({
    kind: AGENT_WORKLOAD_KIND,
    id: String(rowId),
    namespace: settings.namespace,
    image: settings.image,
    secretKeys,
    imagePullSecrets: settings.imagePullSecrets,
    nodeSelector: settings.nodeSelector,
    priorityClassName: settings.priorityClassName,
    resources: {
      cpuRequest: settings.resources.cpuRequest,
      memoryRequest: settings.resources.memoryRequest,
      memoryLimit: settings.resources.memoryLimit,
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
}

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

  /** Delete one object; true when it is gone (a 404 counts). */
  async function deleteObject(resource: K8sResource, name: string): Promise<boolean> {
    const res = await client.delete(resource, ns, name);
    if (res.ok || res.kind === "not-found") return true;
    log.warn(`[agent-pod] Deleting ${resource} ${name} failed: ${res.message}`);
    return false;
  }

  function requestPodDelete(watch: Watch): void {
    watch.deleteRequested = true;
    void deleteObject("pods", watch.podName);
  }

  /**
   * Create `obj`, replacing a same-named leftover. The row id, and so the name,
   * is reused: a boot that crashed after `create pods` but before
   * `setWorkAgentPod` re-queues the row and leaves its Secret and a live Pod,
   * which the next claim collides with before the orphan sweep (which skips a
   * running row) can remove them. That pod's run was superseded, so it goes.
   */
  async function createReplacing(resource: K8sResource, name: string, obj: K8sObject): Promise<K8sResult<K8sObject>> {
    const res = await client.create(resource, ns, obj);
    if (res.ok || res.kind !== "conflict") return res;
    log.warn(`[agent-pod] ${resource} ${name} already exists — replacing it`);
    if (!await deleteObject(resource, name)) return res;
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
      await deleteObject("pods", name);
      await deleteObject("secrets", name);
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
    const secret = await createReplacing("secrets", name, secretObj);
    if (!secret.ok) return fail(secret.message);
    const pod = await createReplacing("pods", name, buildAgentPod(row.id, Object.keys(built.secretData), settings));
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
  async function failRow(row: db.WorkQueueRow, runId: string, reason: string): Promise<void> {
    if (!await db.markWorkFailedIfRunning(row.id, runId, reason)) return;
    log.warn(`[agent-pod] ${row.kind} ${row.repo}#${row.item_number} (id=${row.id}): ${reason}`);
    await failTasks(runId, reason);
    try {
      await reportError("agent-pod:run", `${row.repo}#${row.item_number}`, new Error(`${row.kind}: ${reason}`), { repo: row.repo });
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
    let wait = false;

    const apiState = (state: string | null) => {
      if (state !== lastApiState && state !== null) log.warn(`[agent-pod] ${name}: ${state} — will retry`);
      lastApiState = state;
    };

    /** Delete Pod and Secret; true once both are gone. */
    const deleteBoth = async (): Promise<boolean> => {
      const podGone = await deleteObject("pods", name);
      const secretGone = await deleteObject("secrets", name);
      if (podGone && secretGone) return true;
      deleteFailures++;
      if (deleteFailures === DELETE_FAILURES_BEFORE_HINT) {
        log.error(`[agent-pod] Could not delete ${name} after ${deleteFailures} attempts — clean up with: ${cleanupHint(String(w.rowId))}`);
      }
      return false;
    };

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
            if (!pod.metadata?.deletionTimestamp) await deleteObject("pods", name);
            continue;
          }
          if (await db.markWorkCancelledIfRunning(w.rowId, w.runId, "run cancelled")) {
            log.info(`[agent-pod] ${row.kind} ${row.repo}#${row.item_number} cancelled`);
          }
          wait = false;
          continue;
        }

        if (!pod) {
          // `agent_pod` is set only after the pod was created, so an adopted row's
          // pod existed too: it was deleted, or lost with its node.
          if (!adopt && now() - launchedAt < WORKLOAD_LAUNCH_GRACE_MS) continue;
          await failRow(current, w.runId, "agent pod not found");
          wait = false;
          continue;
        }

        if (podEnded) {
          const detail = classification?.detail ? `: ${classification.detail}` : "";
          await failRow(current, w.runId, `agent pod ${classification?.state}${detail}`);
          wait = false;
          continue;
        }

        if (classification?.state === "pending") {
          pendingSince ??= now();
          if (now() - pendingSince > AGENT_POD_START_TIMEOUT_MS) {
            await failRow(current, w.runId, `agent pod never started: ${classification.detail ?? "pending"}`);
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
            await failRow(current, w.runId, `agent pod lost: ${lost}`);
            requestPodDelete(w);
            wait = false;
            continue;
          }
        } else {
          lostSince = null;
        }

        if (!staleKillRequested && now() - launchedAt > db.STALE_RUNNING_WORK_MS) {
          staleKillRequested = true;
          requestPodDelete(w);
          await failRow(current, w.runId, `agent pod exceeded ${db.STALE_RUNNING_WORK_MS / 3_600_000}h ceiling`);
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
          await deleteObject("pods", name);
          await deleteObject("secrets", name);
          return;
        }
        launchedAt = now();
      }
      const w: Watch = { workerId, rowId: row.id, runId, podName: name, cancelRequested: false, deleteRequested: false };
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
          await deleteObject(resource, name);
          if (resource === "pods") await deleteObject("secrets", name);
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
