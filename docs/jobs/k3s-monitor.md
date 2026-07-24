# k3s-monitor

**Source**: `src/jobs/k3s-monitor.ts`
**Trigger**: Interval
**Interval**: `intervals.k3sMonitorMs` (default: 15 min)

Monitors the k3s Kubernetes cluster for pod failures, unhealthy nodes, and Flux
resource reconciliation failures. Raises alert issues in `FLEET_INFRA_REPO`
(default: `St-John-Software/fleet-infra`). Can be disabled via
`k3sMonitorEnabled: false` in config.

## Ignored Nodes

Nodes can be excluded from some alerting via `k3sIgnoredNodes` in config (array
of node names). The suppression behaviour differs by alert type:

- **Node health alerts**: Ignored nodes are unconditionally excluded — a
  `NotReady` condition on an ignored node never raises a "Node NotReady" issue.
- **Pod alerts**: Pods on an ignored node are only suppressed while that node is
  actually `NotReady`. When the node is `Ready`, pod failures on it are reported
  normally. This prevents pods from being silently ignored when the node is
  online. If the node status fetch fails, the monitor falls back to suppressing
  all pods on ignored nodes (preserving the pre-failure-safe behaviour).
- **Flux alerts**: Not node-specific — raised regardless of ignored nodes.

This is useful for nodes with expected regular downtime (e.g., NAS nodes with
scheduled maintenance windows), while still catching pod issues when those nodes
are online.

Default: `["k3s-nas", "ryzen"]` (when `k3sIgnoredNodes` is not set in config). `ryzen` is a GPU node that is powered down regularly; the cluster-side Prometheus rules in `fleet-infra` already exclude it via `node!~"ryzen|k3s-nas"`, and this default keeps the Claws-side suppression in sync.

## Detection

Three classes of problems are detected per run:

- **Pod alerts**: Pods in `CrashLoopBackOff`, `OOMKilled`, `Error`, `Failed`,
  `ImagePullBackOff`, `ErrImagePull`, or `Pending` (>5 min) states via
  `kubectl get pods --all-namespaces -o json`.
- **Node alerts**: Nodes not in `Ready=True` condition via
  `kubectl get nodes -o json`.
- **Flux resource alerts**: `Kustomization` and `HelmRelease` resources with
  `Ready=False` condition, fetched via `kubectl get kustomizations/helmreleases
  --all-namespaces -o json`. Flux fetches are best-effort — if Flux is not
  installed or the CRDs are missing, the kubectl call fails and is logged at
  warn level without aborting the run.
  Resources whose `Ready` reason is `DependencyNotReady` are suppressed entirely
  (checked before the grace period below): if the named dependency is
  genuinely stuck it raises its own alert (the real root cause); if it is
  merely mid-reconcile, the dependent self-heals within one Flux
  `retryInterval`. Surfacing the cascade would only duplicate the dependency's
  own alert.
  A 2-minute grace period is then applied: resources whose `Ready` condition
  only just transitioned away from `True` are skipped, to ride out transient
  reconcile blips (`Progressing`/`Unknown`). Reasons in
  `TERMINAL_FLUX_FAILURE_REASONS` (currently just `HealthCheckFailed`) bypass
  the grace period, since they represent a *concluded* failure rather than a
  transient one — a Kustomization with `wait: true` health-checking a Failed
  Job fails fast every `retryInterval`, flapping `Ready` `False→Unknown→False`
  and refreshing `lastTransitionTime` on each flip, which would otherwise keep
  the condition permanently inside the grace window and suppress the alert
  indefinitely (issue #1989).

## Issue Management

Each distinct alert (identified by its title) is managed as a single GitHub
issue in `FLEET_INFRA_REPO`:

- If no open issue with that title exists, a new one is created.
- If an open issue already exists, its body is updated with occurrence tracking:
  a `---`-separated block appended to the end containing `**First seen:**`,
  `**Last seen:**`, and `**Occurrences:**`. Retroactively adds this block to
  pre-existing issues that lack it.

This avoids spammy comment threads while preserving a visible count of
recurrences in the issue body.

### Pod alert dedup key

Pod alert titles use `workloadNameForPod()` to derive a stable workload name
from `metadata.ownerReferences`, which prevents duplicate issues when the same
workload restarts and gets a new pod name:

| Owner kind | Key |
|---|---|
| `Job` | Owner name (the Job name) |
| `ReplicaSet` | Owner name with trailing `<hash>` segment stripped → Deployment name |
| `StatefulSet` / `DaemonSet` | Owner name directly |
| No controller owner (bare pod) | `podWorkloadName()` regex fallback |

The ReplicaSet stripping uses a length guard (`{5,10}`) with no digit
requirement — this fixes the original bug where all-alpha pod-template hashes
(from Kubernetes' safe-consonant charset, e.g. `zzmdk`) bypassed the old
digit-check regex and caused duplicate `[k3s] Pod Failed` issues for the same
workload (e.g. two separate issues for `migration-runner-post-data` because
the pod hash happened to be all-alpha).

## Limits

- Pod alerts are capped at 10 per run.
- Node alerts are capped at 10 per run.
- Flux Kustomization alerts are capped at 10 per run.
- Flux HelmRelease alerts are capped at 10 per run.

## Access

`kubectl` must be available on the Claws host and configured with read-only
access to the k3s cluster. Claws cannot apply, delete, or modify cluster
resources.
