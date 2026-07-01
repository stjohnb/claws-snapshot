import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { K3S_MONITOR_ENABLED, K3S_IGNORED_NODES, FLEET_INFRA_REPO, LABELS } from "../config.js";
import type { KubeconfigRefresh } from "../config.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { notify } from "../slack.js";
import { reportError } from "../error-reporter.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";
import { refreshKubeconfig, isStaleKubeconfigError } from "./kubeconfig-refresh.js";

// ── Kubernetes types ──

interface ContainerState {
  waiting?: { reason: string; message?: string };
  terminated?: { reason: string; exitCode: number };
  running?: { startedAt: string };
}

interface ContainerStatus {
  name: string;
  state: ContainerState;
  ready: boolean;
  restartCount: number;
}

interface OwnerReference {
  kind: string;
  name: string;
  controller?: boolean;
}

interface K8sPod {
  metadata: {
    name: string;
    namespace: string;
    deletionTimestamp?: string;
    ownerReferences?: OwnerReference[];
  };
  spec?: {
    nodeName?: string;
  };
  status: {
    phase: string;
    containerStatuses?: ContainerStatus[];
  };
}

interface NodeCondition {
  type: string;
  status: string;
  lastTransitionTime: string;
}

interface K8sNode {
  metadata: { name: string };
  status: {
    conditions: NodeCondition[];
  };
}

interface FluxCondition {
  type: string;
  status: string;
  reason: string;
  message: string;
  lastTransitionTime: string;
}

interface FluxResource {
  metadata: { name: string; namespace: string };
  status?: { conditions?: FluxCondition[] };
}

interface Alert {
  title: string;
  body: string;
  podRef?: { namespace: string; podName: string; containerName: string; previous: boolean };
}

// ── kubectl wrapper ──

function extractKubeconfigServer(kubeconfigPath?: string): string {
  if (!kubeconfigPath) return "unknown";
  try {
    const contents = readFileSync(kubeconfigPath, "utf8");
    const match = contents.match(/^\s*server:\s*(\S+)\s*$/m);
    if (!match) return "unknown";
    return match[1].replace(/^["']|["',]+$/g, "");
  } catch {
    return "unknown";
  }
}

export function kubectlExec(args: string[], kubeconfigPath?: string): Promise<string> {
  const fullArgs = kubeconfigPath ? ["--kubeconfig", kubeconfigPath, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile("kubectl", fullArgs, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { killed?: boolean; signal?: string };
        if (e.killed === true && e.signal === "SIGTERM") {
          const server = extractKubeconfigServer(kubeconfigPath);
          const summary = `kubectl ${args.slice(0, 3).join(" ")}`.trim();
          reject(new Error(`${summary} timed out after 30s (server ${server}, cluster unreachable?)`));
        } else {
          reject(new Error(stderr?.trim() || (err as Error).message));
        }
      } else {
        resolve(stdout);
      }
    });
  });
}

// ── Pod name normalisation ──

/**
 * Strip Kubernetes random hash suffixes for stable deduplication keys.
 * e.g. "my-service-7d9f4b8c6-xk9pz" → "my-service"
 *
 * Kubernetes RS hashes are derived from uint32 FNV hashes, so they always
 * contain at least one digit. We use this to distinguish them from words in
 * a workload name (e.g. "my-daemonset" must not be stripped as a hash).
 */
export function podWorkloadName(podName: string): string {
  // Deployment: name-<rshash(7-12, at least 1 digit)>-<podhash(5)>
  const deployMatch = podName.match(/^(.*)-([a-z0-9]{7,12})-([a-z0-9]{5})$/);
  if (deployMatch && /\d/.test(deployMatch[2])) {
    return deployMatch[1];
  }
  // DaemonSet / StatefulSet: name-<podhash(5, at least 1 digit)>
  const dsMatch = podName.match(/^(.*)-([a-z0-9]{5})$/);
  if (dsMatch && /\d/.test(dsMatch[2])) {
    return dsMatch[1];
  }
  return podName;
}

/**
 * Stable dedup key for a pod, derived from its controller ownerReference when
 * present. Robust to all-alpha (digit-free) pod-template hashes that escape
 * podWorkloadName()'s regex. Falls back to podWorkloadName() for pods with no
 * controller owner (e.g. static/bare pods).
 */
export function workloadNameForPod(pod: K8sPod): string {
  const refs = pod.metadata.ownerReferences;
  const owner = refs?.find((r) => r.controller) ?? refs?.[0];
  if (owner) {
    switch (owner.kind) {
      case "Job":
        return owner.name;
      case "ReplicaSet": {
        // RS name is "<deployment>-<pod-template-hash>". Strip the last segment.
        // No digit guard — the hash can be all-alpha (same safe-charset).
        const m = owner.name.match(/^(.+)-([a-z0-9]{9,12})$/);
        return m ? m[1] : owner.name;
      }
      case "StatefulSet":
      case "DaemonSet":
        return owner.name;
    }
  }
  return podWorkloadName(pod.metadata.name);
}

/**
 * Collapse alerts that share a title to a single alert (keeping the first).
 * Multiple failed pods of the same workload (e.g. a Job's retry pods) produce
 * identical-titled alerts that each create a separate issue, because
 * ensureAlertIssue's GitHub search-based dedup cannot see an issue created
 * moments earlier in the same run. See issue #1541.
 */
export function dedupeAlertsByTitle(alerts: Alert[]): Alert[] {
  const seen = new Set<string>();
  const result: Alert[] = [];
  for (const alert of alerts) {
    if (seen.has(alert.title)) continue;
    seen.add(alert.title);
    result.push(alert);
  }
  return result;
}

// ── Alert detection ──

const BAD_WAITING_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "CreateContainerError",
]);

export function detectPodAlerts(pods: K8sPod[], ignoredNodes: ReadonlyArray<string> = []): Alert[] {
  const alerts: Alert[] = [];

  for (const pod of pods) {
    const { name, namespace, deletionTimestamp } = pod.metadata;
    const { phase, containerStatuses = [] } = pod.status;

    // Skip completed jobs
    if (phase === "Succeeded") continue;

    // Skip pods in the process of being deleted
    if (deletionTimestamp) continue;

    // Skip pods running on ignored nodes
    const nodeName = pod.spec?.nodeName;
    if (nodeName && ignoredNodes.includes(nodeName)) continue;

    if (phase === "Failed") {
      alerts.push({
        title: `[k3s] Pod Failed: ${namespace}/${workloadNameForPod(pod)}`,
        body: [
          `**Pod:** \`${name}\``,
          `**Namespace:** \`${namespace}\``,
          `**Phase:** Failed`,
        ].join("\n"),
      });
      continue;
    }

    for (const cs of containerStatuses) {
      const { waiting, terminated } = cs.state;

      if (waiting && BAD_WAITING_REASONS.has(waiting.reason)) {
        const lines = [
          `**Pod:** \`${name}\``,
          `**Namespace:** \`${namespace}\``,
          `**Container:** \`${cs.name}\``,
          `**Reason:** ${waiting.reason}`,
          `**Restart count:** ${cs.restartCount}`,
        ];
        if (waiting.message) lines.push(`**Message:** ${waiting.message}`);
        alerts.push({
          title: `[k3s] ${waiting.reason}: ${namespace}/${workloadNameForPod(pod)}`,
          body: lines.join("\n"),
          ...(waiting.reason === "CrashLoopBackOff"
            ? { podRef: { namespace, podName: name, containerName: cs.name, previous: true } }
            : {}),
        });
      } else if (
        terminated &&
        (terminated.reason === "OOMKilled" ||
          (terminated.reason === "Error" && terminated.exitCode !== 0))
      ) {
        alerts.push({
          title: `[k3s] ${terminated.reason}: ${namespace}/${workloadNameForPod(pod)}`,
          body: [
            `**Pod:** \`${name}\``,
            `**Namespace:** \`${namespace}\``,
            `**Container:** \`${cs.name}\``,
            `**Reason:** ${terminated.reason}`,
            `**Exit code:** ${terminated.exitCode}`,
          ].join("\n"),
          ...(terminated.reason === "OOMKilled"
            ? { podRef: { namespace, podName: name, containerName: cs.name, previous: false } }
            : {}),
        });
      }
    }
  }

  return alerts;
}

function isNodeNotReady(node: K8sNode): boolean {
  const ready = node.status.conditions.find((c) => c.type === "Ready");
  return !ready || ready.status !== "True";
}

function countNodesNotReady(nodes: K8sNode[]): number {
  return nodes.filter(isNodeNotReady).length;
}

export function detectNodeAlerts(nodes: K8sNode[], ignoredNodes: ReadonlyArray<string> = []): Alert[] {
  const alerts: Alert[] = [];
  const TWO_MINUTES_MS = 2 * 60 * 1000;
  const now = Date.now();

  for (const node of nodes) {
    if (ignoredNodes.includes(node.metadata.name)) continue;

    const ready = node.status.conditions.find((c) => c.type === "Ready");
    if (!ready || ready.status === "True") continue;

    // Only alert if the condition has been stable for > 2 minutes (not in transition)
    const transitionTime = new Date(ready.lastTransitionTime).getTime();
    if (now - transitionTime <= TWO_MINUTES_MS) continue;

    alerts.push({
      title: `[k3s] Node NotReady: ${node.metadata.name}`,
      body: [
        `**Node:** \`${node.metadata.name}\``,
        `**Condition:** Ready = ${ready.status}`,
        `**Since:** ${ready.lastTransitionTime}`,
      ].join("\n"),
    });
  }

  return alerts;
}

export function detectFluxAlerts(resources: FluxResource[], kind: string): Alert[] {
  const alerts: Alert[] = [];
  const TWO_MINUTES_MS = 2 * 60 * 1000;
  const now = Date.now();

  for (const resource of resources) {
    const { name, namespace } = resource.metadata;
    const conditions = resource.status?.conditions ?? [];
    const ready = conditions.find((c) => c.type === "Ready");
    if (!ready || ready.status === "True") continue;

    // Grace period — skip if the condition only just turned false
    const transitionTime = new Date(ready.lastTransitionTime).getTime();
    if (now - transitionTime <= TWO_MINUTES_MS) continue;

    // Suppress DependencyNotReady cascades — they are noise. If the named
    // dependency is genuinely stuck, that dependency raises its own alert
    // (the real root cause); if it is merely mid-reconcile, the dependent
    // self-heals within one Flux retryInterval. See issue #1526.
    if (ready.reason === "DependencyNotReady") continue;

    const lines = [
      `**Resource:** \`${namespace}/${name}\``,
      `**Kind:** ${kind}`,
      `**Reason:** ${ready.reason}`,
    ];
    if (ready.message) {
      lines.push(`**Message:**\n\`\`\`\n${ready.message.slice(0, 2000)}\n\`\`\``);
    }

    alerts.push({
      title: `[k3s] Flux ${kind} NotReady: ${namespace}/${name}`,
      body: lines.join("\n"),
    });
  }

  return alerts;
}

// ── Log fetching ──

async function fetchPodLogs(
  namespace: string,
  podName: string,
  containerName: string,
  previous: boolean,
  kubeconfigPath?: string,
  tailLines = 30,
): Promise<string> {
  const args = ["logs", `--tail=${tailLines}`, podName, "-n", namespace, "-c", containerName];
  if (previous) args.push("--previous");
  try {
    return await kubectlExec(args, kubeconfigPath);
  } catch {
    return "";
  }
}

// ── Issue raising with deduplication ──

async function raiseAlert(alert: Alert, repo: string, logPrefix: string): Promise<boolean> {
  const result = await ensureAlertIssue({
    repo,
    title: alert.title,
    body: alert.body,
    labels: [LABELS.priority],
    logPrefix,
  });
  if (result.outcome === "created") {
    notify(`[${logPrefix}] New alert: ${alert.title}`);
    return true;
  }
  if (result.outcome === "updated") {
    log.info(`[${logPrefix}] Updated occurrence tracking for "${alert.title}"`);
  }
  return false;
}

// ── Shared monitor orchestration ──

export interface K8sMonitorConfig {
  repo: string;
  kubeconfigPath?: string;
  kubeconfigRefresh?: KubeconfigRefresh;
  ignoredNodes: ReadonlyArray<string>;
  logPrefix: string;
  tailLines?: number;
}

export interface K8sMonitorStatus {
  logPrefix: string;
  repo: string;
  enabled: boolean;
  kubeconfigPath?: string;
  lastRunAt: string | null;
  lastError: string | null;
  podCount: number;
  nodeCount: number;
  nodesNotReady: number;
  podAlertCount: number;
  nodeAlertCount: number;
  fluxAlertCount: number;
  newIssuesRaised: number;
}

const statusByLogPrefix = new Map<string, K8sMonitorStatus>();

export function getK8sMonitorStatus(logPrefix: string): K8sMonitorStatus | null {
  return statusByLogPrefix.get(logPrefix) ?? null;
}

export function setDisabledStatus(logPrefix: string, repo: string, kubeconfigPath?: string): void {
  statusByLogPrefix.set(logPrefix, {
    logPrefix, repo, enabled: false, kubeconfigPath,
    lastRunAt: null, lastError: null,
    podCount: 0, nodeCount: 0, nodesNotReady: 0,
    podAlertCount: 0, nodeAlertCount: 0, fluxAlertCount: 0, newIssuesRaised: 0,
  });
}

export async function runK8sMonitor(config: K8sMonitorConfig): Promise<void> {
  const { repo, kubeconfigPath, kubeconfigRefresh, ignoredNodes, logPrefix, tailLines = 30 } = config;

  // Fetch nodes first so we can determine which ignored nodes are actually down.
  // Best-effort — don't abort the run if this fails.
  let fetchedNodes: K8sNode[] = [];
  try {
    const nodeJson = await kubectlExec(["get", "nodes", "-o", "json"], kubeconfigPath);
    fetchedNodes = (JSON.parse(nodeJson) as { items: K8sNode[] }).items;
  } catch (err) {
    log.warn(`[${logPrefix}] kubectl get nodes failed: ${err}`);
  }

  const setErrorStatus = (err: unknown): void => {
    statusByLogPrefix.set(logPrefix, {
      logPrefix, repo, enabled: true, kubeconfigPath,
      lastRunAt: null, lastError: String(err),
      podCount: 0, nodeCount: fetchedNodes.length,
      nodesNotReady: countNodesNotReady(fetchedNodes),
      podAlertCount: 0, nodeAlertCount: 0, fluxAlertCount: 0, newIssuesRaised: 0,
    });
  };

  // Only suppress pods on an ignored node while that node is actually NotReady.
  // When fetchedNodes is empty (node fetch failed) we conservatively treat every
  // ignored node as down, preserving the old behaviour.
  const downIgnoredNodes: string[] =
    fetchedNodes.length > 0
      ? ignoredNodes.filter((nodeName) => {
          const node = fetchedNodes.find((n) => n.metadata.name === nodeName);
          if (!node) return true; // not visible in cluster → treat as down
          return isNodeNotReady(node);
        })
      : [...ignoredNodes];

  // Fetch pods
  let podJson: string;
  try {
    podJson = await kubectlExec(["get", "pods", "--all-namespaces", "-o", "json"], kubeconfigPath);
  } catch (firstErr) {
    log.warn(`[${logPrefix}] kubectl get pods failed: ${firstErr}`);

    // When the kubeconfig goes stale (cluster rebuilt → endpoint/cert changed),
    // discover the current host via tailscale, SSH in, pull a fresh kubeconfig,
    // and retry once. Best-effort: any failure falls through to reportError.
    let recovered: string | null = null;
    if (kubeconfigPath && kubeconfigRefresh && firstErr instanceof Error && isStaleKubeconfigError(firstErr)) {
      try {
        await refreshKubeconfig(kubeconfigRefresh, kubeconfigPath, logPrefix);
        recovered = await kubectlExec(["get", "pods", "--all-namespaces", "-o", "json"], kubeconfigPath);
        log.info(`[${logPrefix}] kubectl get pods succeeded after kubeconfig refresh`);
      } catch (retryErr) {
        log.warn(`[${logPrefix}] kubeconfig refresh + retry failed: ${retryErr}`);
      }
    }

    if (recovered === null) {
      try {
        await reportError(`${logPrefix}:kubectl-get-pods`, "kubectl get pods --all-namespaces failed", firstErr);
      } catch { /* reporter failure must not crash the monitor */ }
      setErrorStatus(firstErr);
      return;
    }
    podJson = recovered;
  }

  let pods: K8sPod[];
  try {
    const parsed = JSON.parse(podJson) as { items: K8sPod[] };
    pods = parsed.items;
  } catch (err) {
    log.warn(`[${logPrefix}] Failed to parse pod JSON: ${err}`);
    try {
      await reportError(`${logPrefix}:pods-json-parse`, "Failed to parse pods JSON from kubectl", err);
    } catch { /* reporter failure must not crash the monitor */ }
    setErrorStatus(err);
    return;
  }

  // Cap pod alerts at 10 per run to prevent issue storms on cascading failures.
  // Use downIgnoredNodes so pods on an online-but-ignored node are still caught.
  const podAlerts = detectPodAlerts(pods, downIgnoredNodes).slice(0, 10);

  // Enrich CrashLoopBackOff and OOMKilled alerts with recent logs
  const enrichedPodAlerts: Alert[] = [];
  for (const alert of podAlerts) {
    if (alert.podRef) {
      const { namespace, podName, containerName, previous } = alert.podRef;
      const logs = await fetchPodLogs(namespace, podName, containerName, previous, kubeconfigPath, tailLines);
      if (logs) {
        enrichedPodAlerts.push({
          ...alert,
          body: `${alert.body}\n\n**Recent logs:**\n\`\`\`\n${logs.slice(0, 3000)}\n\`\`\``,
        });
        continue;
      }
    }
    enrichedPodAlerts.push(alert);
  }

  // Node alerts — still suppress all configured ignored nodes (expected downtime
  // nodes should not raise "Node NotReady" alerts even when they go offline).
  // Cap node alerts at 10 per run — same rationale as pod alert cap.
  const nodeAlerts = detectNodeAlerts(fetchedNodes, ignoredNodes).slice(0, 10);

  // Fetch Flux Kustomizations (best-effort — Flux may not be installed)
  let fluxKustomizationAlerts: Alert[] = [];
  try {
    const ksJson = await kubectlExec(["get", "kustomizations", "--all-namespaces", "-o", "json"], kubeconfigPath);
    const parsed = JSON.parse(ksJson) as { items: FluxResource[] };
    fluxKustomizationAlerts = detectFluxAlerts(parsed.items, "Kustomization").slice(0, 10);
  } catch (err) {
    log.warn(`[${logPrefix}] kubectl get kustomizations failed: ${err}`);
  }

  // Fetch Flux HelmReleases (best-effort)
  let fluxHelmReleaseAlerts: Alert[] = [];
  try {
    const hrJson = await kubectlExec(["get", "helmreleases", "--all-namespaces", "-o", "json"], kubeconfigPath);
    const parsed = JSON.parse(hrJson) as { items: FluxResource[] };
    fluxHelmReleaseAlerts = detectFluxAlerts(parsed.items, "HelmRelease").slice(0, 10);
  } catch (err) {
    log.warn(`[${logPrefix}] kubectl get helmreleases failed: ${err}`);
  }

  const allAlerts = dedupeAlertsByTitle([...enrichedPodAlerts, ...nodeAlerts, ...fluxKustomizationAlerts, ...fluxHelmReleaseAlerts]);
  let newIssues = 0;

  for (const alert of allAlerts) {
    try {
      const isNew = await raiseAlert(alert, repo, logPrefix);
      if (isNew) newIssues++;
    } catch (err) {
      await reportError(`${logPrefix}:raise-alert`, alert.title, err);
    }
  }

  log.info(`[${logPrefix}] Found ${allAlerts.length} alert(s), raised ${newIssues} new issue(s)`);

  const nodesNotReady = countNodesNotReady(fetchedNodes);
  statusByLogPrefix.set(logPrefix, {
    logPrefix, repo, enabled: true, kubeconfigPath,
    lastRunAt: new Date().toISOString(), lastError: null,
    podCount: pods.length, nodeCount: fetchedNodes.length, nodesNotReady,
    podAlertCount: enrichedPodAlerts.length, nodeAlertCount: nodeAlerts.length,
    fluxAlertCount: fluxKustomizationAlerts.length + fluxHelmReleaseAlerts.length,
    newIssuesRaised: newIssues,
  });
}

// ── Main run function ──

export async function run(): Promise<void> {
  if (!K3S_MONITOR_ENABLED) {
    setDisabledStatus("k3s-monitor", FLEET_INFRA_REPO);
    log.info("[k3s-monitor] Disabled — skipping");
    return;
  }
  await runK8sMonitor({
    repo: FLEET_INFRA_REPO,
    ignoredNodes: K3S_IGNORED_NODES,
    logPrefix: "k3s-monitor",
  });
}
