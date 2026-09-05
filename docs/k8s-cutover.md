# Kubernetes cutover runbook

**Deep dive.** Read this when you're cutting the k8s deployment over from the
systemd host (`openclaw`), or operating the k8s deployment afterward (#2752).
For the shape of the deployment itself — StatefulSet, ephemeral provider
homes, verify-only rollout, `/verify` — see
[OVERVIEW.md § Kubernetes Deployment](OVERVIEW.md#kubernetes-deployment)
first; this doc is the operator playbook: manifest diffs, secrets, data
migration, activation, traffic cutover, rollback, and known limitations.

## Current state (verified 2026-09-01)

The fleet-infra repo's `apps/claws/` holds `service.yaml`, `endpoints.yaml`,
`ingress.yaml`, `pvc-staging.yaml`, `deployment-staging.yaml`,
`service-staging.yaml`, `ingress-staging.yaml`, `kustomization.yaml`.

`Deployment claws-staging` (namespace `default`, `strategy: Recreate`,
`replicas: 1`) runs `ghcr.io/st-john-software/claws:v2026-05-09.2` with
`CLAWS_ACTIVATION_STATE=verify-only`, five literal OIDC env vars
(`CLAWS_OIDC_CLIENT_ID`, `CLAWS_OIDC_BASE_URL`, `CLAWS_OIDC_APPLICATION_SLUG`,
`CLAWS_OIDC_REDIRECT_URI`, `CLAWS_OIDC_HOST_MAP`) plus `CLAWS_OIDC_CLIENT_SECRET` from Secret
`authentik-secrets`, `imagePullSecrets: [ghcr-pull]`,
`automountServiceAccountToken: false`, `enableServiceLinks: false`,
`priorityClassName: standard`, `fsGroup: 1000` plus container
`runAsNonRoot`/`runAsUser: 1000`/`allowPrivilegeEscalation: false`/
`capabilities.drop: [ALL]`, three `/health` probes (startup
`failureThreshold: 30`), requests `50m`/`64Mi`, limits `500m`/`512Mi`, and a
`data` volume (PVC `claws-staging-data`, **1Gi**, `local-path` storage class)
at `/home/claws/.claws`. `terminationGracePeriodSeconds` is the Kubernetes
default (30s) today — nowhere near the 420s this cutover needs.

Production `claws.home.bstjohn.net` is a selector-less `service.yaml` plus a
hand-written `endpoints.yaml` pointing at `192.168.0.73:3000` — the openclaw
box, reached directly rather than through pod selection.

## Manifest changes for fleet-infra

Replace `deployment-staging.yaml` + `pvc-staging.yaml` with a `StatefulSet`
and a `volumeClaimTemplate`. Key changes from the current staging manifest:

- `Deployment` → `StatefulSet`, `replicas: 1`, `podManagementPolicy:
  OrderedReady`.
- `terminationGracePeriodSeconds: 420` — derived from 300s scheduler drain +
  5s task-cancel + 60s memory flush (`src/main.ts`'s `shutdown()`) plus
  headroom. Changing the flush's 60s cap means changing this number too.
- `volumeClaimTemplate` of **50Gi** `local-path` at the unchanged
  `/home/claws/.claws` — 1Gi cannot hold `repos/` plus `worktrees/` once the
  pod does real work.
- `resources.requests`: `cpu: 500m`, `memory: 2Gi`; `resources.limits`:
  `memory: 6Gi`, **no `cpu` limit** — `512Mi`/`500m` cannot host a `claude`
  worker process.
- `envFrom: [{ secretRef: { name: claws-config } }]` alongside the existing
  explicit OIDC env vars (those stay as literals plus the one secretKeyRef,
  unchanged).
- Add a read-only Secret volume `github-app-key` mounted at
  `/etc/claws/github-app`, with `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH=/etc/claws/github-app/private-key.pem`
  added to `claws-config` — a `0440` projected file is fine since JWT signing
  only reads it.
- Keep the existing `securityContext` (pod and container), probes, and
  `imagePullSecrets` as-is.

## Secret `claws-config`

Static material — SOPS-appropriate, committed encrypted to fleet-infra.

| Key | Purpose |
|---|---|
| `CLAWS_ACTIVATION_STATE` | `verify-only` for the initial rollout, `active` once cut over |
| `CLAWS_GITHUB_APP_ID` | GitHub App auth |
| `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH` | Set to `/etc/claws/github-app/private-key.pem` (see above) |
| `CLAWS_CLAUDE_SETTINGS_JSON` | Optional — contents of `~/.claude/settings.json` |
| `CLAWS_SSH_PRIVATE_KEY` | Runner SSH access |
| `CLAWS_KUBECONFIG` | Cluster access for `kubectl`/`k3s-monitor`/`prod-k8s-monitor` |
| `CLAWS_SLACK_WEBHOOK`, `CLAWS_SLACK_BOT_TOKEN` | Slack notifications |
| `CLAWS_OPENROUTER_API_KEY`, `OPENAI_API_KEY` | Provider fallback |
| `BRENDAN_SERVER_GMAIL_APP_PASSWORD`, `CLAWS_EMAIL_USER` | Email monitor |
| `CLAWS_HOME_ASSISTANT_TOKEN` | Home Assistant integration |
| `CLAWS_WHISPER_LOCAL_URL` | See known limitations — no local Whisper server in-pod |

## Secret `claws-auth`

Provider credentials — created imperatively (`kubectl create secret ...`),
**never committed**, not SOPS-managed. Holds exactly two keys:

| Key | Purpose |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude CLI auth |
| `CLAWS_CODEX_AUTH_JSON` | Contents of `~/.codex/auth.json` |

`/reauth` writes a freshly refreshed `CLAUDE_CODE_OAUTH_TOKEN` into
`~/.claws/env` on the PVC (`persistToken()`, `src/claude-auth.ts`), and
**that file wins over the Secret** on the next boot (`loadEnvFile()`,
`src/env-file.ts`, called from `config.ts` before `loadConfig()`).

The pod runs under a dedicated `claws-staging` ServiceAccount
(`automountServiceAccountToken: true`) with a namespaced Role granting only
`get` and `patch` on Secrets, scoped to `resourceNames: [claws-auth]`
(fleet-infra#1036). Two env vars point the pod at the write target:

| Env var | Purpose |
|---|---|
| `CLAWS_AUTH_SECRET_NAME` | Name of the Secret to write rotated credentials back to (`claws-auth`) |
| `CLAWS_AUTH_SECRET_NAMESPACE` | Namespace of that Secret (`default`) |

Both are consumed by [`auth-secret-sync`](jobs/auth-secret-sync.md), which
pushes a rotated `~/.codex/auth.json` (and, secondarily, a refreshed
`CLAUDE_CODE_OAUTH_TOKEN`) back into `claws-auth` every 10 minutes and once
more on shutdown — see the known-limitations note below.

## Where state lives

`~/.claws` (the PVC) holds `claws.db`, `config.json`, `env`, `repos/`,
`worktrees/`, `whatsapp-auth/` — everything that must survive a restart.

Everything else in `$HOME` is ephemeral and rebuilt on every boot by
`deploy/container-entrypoint.sh`: `~/.claude` and `~/.codex` from the Secret
plus the bundled skills, `~/.ssh` and `~/.kube` from the Secret. **Agent
memories are never restored anywhere** — the pod starts with an empty
`~/.claude` every time, by design.

## Data migration

On openclaw:

```
sudo systemctl stop claws claws-updater.timer
sudo systemctl disable claws-updater.timer
```

Then copy the data directory, excluding the re-clonable parts:

```
tar -C "$HOME" -cf - --exclude=.claws/worktrees --exclude=.claws/repos .claws \
  | kubectl exec -i <pod> -- tar -xf - -C /home/claws
```

`repos/` and `worktrees/` are excluded — they're re-cloned on demand, and
copying a tree that size with `kubectl cp` is not viable. Do **not** copy
`~/.claude`, `~/.codex` or `~/.ssh` — those come from the Secret, not from
openclaw's host state.

**Before decommissioning openclaw, confirm the last memory push landed:**

```
git ls-remote https://github.com/St-John-Software/claws.git claude-memories
```

and check that branch's newest commit timestamp is after the last agent
activity on openclaw. The hourly `claude-memory-backup` job plus the
shutdown flush normally cover this on their own — this is a confirmation
step, not a data-movement step. No `mv`, no slug rewrite, no manual restore:
memories stay on the branch and reach `docs/` via `doc-maintainer` (#2757).

## Memory durability

`~/.claude` is ephemeral by design and nothing rehydrates it on boot. The
durable store is the `claude-memories` branch of this repo, written by the
hourly `claude-memory-backup` job and once more during `shutdown()` (60s
cap, gated on `isActive()` — see
[claude-memory-backup.md § Shutdown flush](jobs/claude-memory-backup.md#shutdown-flush)).
Worst case is losing memories written since the last hourly push if the pod
is SIGKILLed before the flush completes. `doc-maintainer` folds the branch
(all host slug prefixes, not just the current pod's) into each repo's
`docs/` (#2757), so durable facts reach agents on any host or provider
regardless of which pod wrote them.

## Activation

A restored `claws.db` makes `src/config.ts` auto-select `active`; otherwise
set `CLAWS_ACTIVATION_STATE=active` in the Secret and restart, or click
**Activate** on `/config`. Check `/verify` is green first — the `kubectl`
and `tmux` rows are the ones this cutover added.

## Traffic cutover

Delete `apps/claws/endpoints.yaml`, drop it from `kustomization.yaml`, and
add `selector: { app: claws }` to `service.yaml` so the Service starts
routing to the pod instead of the hand-written endpoint. Rollback is
re-adding `endpoints.yaml` and restarting `claws.service` on openclaw.

## Rollback window

Keep openclaw powered on with `claws.service` installed but stopped for two
weeks after cutover. The PID lock (`claws.pid` in `WORK_DIR`) cannot stop a
cross-host double-run, so both `claws.service` and `claws-updater.timer`
must stay stopped for the whole window while the pod is active.

## Known limitations

- **Codex auth staleness (mitigated).** Codex rotates its ChatGPT refresh
  token inside `~/.codex/auth.json`, and that file is still overwritten from
  the `claws-auth` Secret on every boot — but
  [`auth-secret-sync`](jobs/auth-secret-sync.md) now pushes a rotated
  `~/.codex/auth.json` back into the Secret within 10 minutes, and again on
  shutdown, so a routine rotation survives a restart. The remaining manual
  step is only the *initial* auth: if Codex auth is fully dead (the seed
  token itself was revoked, e.g. from before this job existed), open `/reauth`
  and run the Codex device-code login (#2802) — it drives
  `codex login --device-auth` in the pod and kicks a sync itself, so the
  freshly-logged-in `~/.codex/auth.json` reaches the Secret immediately. `CLAWS_PROVIDER_FALLBACK_ORDER`
  covers the gap while that happens. The Claude OAuth token doesn't have this
  problem — see the `env` file note above.
- **No local Whisper server in-pod.** `whisperLocalUrl` defaults to
  `http://127.0.0.1:9000` with nothing listening in the pod; set
  `CLAWS_WHISPER_LOCAL_URL` to a reachable server or accept the
  `whisperBaseUrl` remote fallback.
- **Mac runners are unreachable by mDNS.** `DEFAULT_MAC_RUNNERS` hosts are
  `.local` mDNS names; a pod has no mDNS resolver, so those SSH checks fail
  until given real IPs/DNS names in `config.json`.
- **`deploy/deploy.sh` and `claws-updater.timer` have no role under k8s** —
  the systemd path stays supported for the rollback window and any host
  that continues to run it directly.
- **A `SIGKILL` at the end of the grace period can cut the shutdown memory
  flush short**, losing whatever was written since the last hourly push.
- **The 0600 `~/.ssh/id_ed25519` and `~/.kube/config` the entrypoint
  writes are still readable by same-uid agent processes.** Env stripping
  (#2837) removes the trivially scrapable copy in `process.env`, but full
  closure needs uid separation between the service and agent children.
