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

Pod alerts are titled `[k3s] Workload failing: <namespace>/<workload>` — keyed
on the workload alone, with **no failure reason in the title**. The reason lives
in the body (`**Phase:** Failed`, `**Reason:** CrashLoopBackOff`, …). A broken
workload typically transitions between failure modes (pod Fails → its
replacement crashloops → maybe gets OOMKilled), and a reason-bearing title filed
a separate issue per state for one incident (issue #2298).

Because the reason can change between runs, pod alerts update via
`ensureAlertIssue`'s `refreshBody` option: the issue body is **rewritten
wholesale** on each update (preserving `First seen` and incrementing
`Occurrences`) so the current reason is always what the issue shows. Hand-edited
prose in an alert *body* is therefore discarded; comments are untouched.

Legacy reason-titled issues (`[k3s] Pod Failed: …`, `[k3s] CrashLoopBackOff: …`,
`[k3s] OOMKilled: …`, and the rest of `LEGACY_POD_ALERT_REASONS`) are matched by
`legacyPodAlertTitles()` and **renamed** onto the new title on first touch, so
the rename itself doesn't fork a fresh issue. When several legacy issues exist
for one workload, the lowest-numbered one is kept and the others are commented
and closed as `not_planned` ("Superseded by #N"). That reason list is an
explicit allow-list on purpose — a wildcard `[k3s] *: ns/name` match would also
swallow `[k3s] Flux Kustomization NotReady: ns/name`, which shares the shape.

Node (`[k3s] Node NotReady: <node>`) and Flux
(`[k3s] Flux <Kind> NotReady: <ns>/<name>`) titles are already stable per
resource and are unchanged — they keep the patch-in-place occurrence update.

`workloadNameForPod()` derives the stable workload name from
`metadata.ownerReferences`, which prevents duplicate issues when the same
workload restarts and gets a new pod name:

| Owner kind | Key |
|---|---|
| `Job` | Owner name, with a trailing 7–12 digit CronJob timestamp suffix stripped (`forgejo-backup-29762010` → `forgejo-backup`) |
| `ReplicaSet` | Owner name with trailing `<hash>` segment stripped → Deployment name |
| `StatefulSet` / `DaemonSet` | Owner name directly |
| No controller owner (bare pod) | `podWorkloadName()` regex fallback |

The ReplicaSet stripping uses a length guard (`{9,12}`) with no digit
requirement — this fixes the original bug where all-alpha pod-template hashes
(from Kubernetes' safe-consonant charset, e.g. `zzmdk`) bypassed the old
digit-check regex and caused duplicate issues for the same workload (e.g. two
separate issues for `migration-runner-post-data` because the pod hash happened
to be all-alpha).

## Limits

- Pod alerts are capped at 10 per run — applied *after* same-run title dedup, so
  one workload with many failing pods can't crowd every other workload out of
  the cap.
- Node alerts are capped at 10 per run.
- Flux Kustomization alerts are capped at 10 per run.
- Flux HelmRelease alerts are capped at 10 per run.

## Access

`kubectl` must be available on the Claws host and configured with read-only
access to the k3s cluster. Claws cannot apply, delete, or modify cluster
resources.

`kubectlExec()` runs every `kubectl` call with a 30s timeout and a 20 MB
`maxBuffer` (raised from Node's 1 MB `execFile` default, #2283) — a
`get -o json --all-namespaces` on a busy cluster returns megabytes (roughly
5 KB per pod), so 20 MB covers ~4000 pods before the call fails with a clear
"output exceeded the buffer" error instead of the earlier misleading timeout.
