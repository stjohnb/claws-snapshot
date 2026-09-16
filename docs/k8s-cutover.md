# Kubernetes cutover runbook

**Deep dive.** Read this when you're cutting the k8s deployment over from the
systemd host (`openclaw`), or operating the k8s deployment afterward (#2752).
For the shape of the deployment itself — StatefulSet, ephemeral provider
homes, verify-only rollout, `/verify` — see
[OVERVIEW.md § Kubernetes Deployment](OVERVIEW.md#kubernetes-deployment)
first; this doc is the operator playbook: manifest diffs, secrets, data
migration, activation, traffic cutover, rollback, and known limitations.

## Cutover prerequisite: pod-per-session interactive sessions (#3026)

**Do not cut production over until this section is done and verified.** A DB
sync plus a green staging issue/PR run does not prove readiness. Neither
exercises an interactive session across a rollout. With the default
`local-tmux` backend, the tmux server runs inside the Claws pod, so every image
rollout kills every running shell and agent, along with its scrollback and
uncommitted work.

### Architecture

With `CLAWS_SESSION_BACKEND=k8s-pod`, Claws creates **one Pod per session**
through the Kubernetes API in the `claws-sessions` namespace. It never uses a
shared session runtime. Each session gets four objects, all named
`claws-session-<id>` and labelled `claws-workload=session`,
`claws-workload-id=<id>`:

- **PVC** (`local-path`, RWO, 20Gi): the session's HOME, `/home/claws`. Repos
  are cloned to `~/work/<owner>/<name>`, on branch `claws-wt/<id>` for
  worktree and multi-repo sessions, or the default branch for `repo-zsh` and
  `repo-claude`. An existing checkout is never re-cloned, fetched or reset,
  so resume keeps uncommitted work. There is no reference mirror, so session
  start is slower than on the host. The provisioner must create the volume
  root without world access, so that after fsGroup it is `drwxrws--- root
  claws`: kubelet never strips world bits, and the unprivileged pod cannot
  chmod a root-owned dir (`prepare` only warns). Keep group rw and setgid, or
  kubelet re-chowns the whole volume on every mount. Tracked in St-John-Software/fleet-infra#1382.
- **Secret**: the launch spec, a terminal bearer token (`terminal-token`), a
  `claws-state` MCP bearer token (`mcp-token`), clone credentials (for the
  init container only), and the credentials the operator ticked. Nothing
  else goes in: no `OPENAI_API_KEY`, no database URL or password, no internal
  MCP token.
- **Service** (ClusterIP, port 7681): the pod's terminal server.
- **Pod** (same image as the Claws that created it, `restartPolicy: Never`,
  PSA `restricted`, no `ownerReferences`): tmux session `claws-<id>` behind
  `session-pod/terminal-server.ts`.

Claws only proxies the browser's WebSocket and uploads to the pod's Service,
so a Claws rollout never touches a session. The Kubernetes API is the single
source of truth for whether a session is alive. Reconcile runs every 15 s. It
ends a row only on a real answer: a Succeeded/Failed pod, or no pod 3 min
after launch. An API error, timeout or 403 changes nothing, and End, Delete,
the terminal WebSocket and uploads return 503. Pods with no session row are
logged with a `kubectl` cleanup hint and never deleted, as are PVCs with no
session row. PVCs are deleted only by Delete, by pruning of ended-session
history (the newest 50 `k8s-pod` rows are kept, pruned when End or
reconcile ends a row; host `local-tmux` history is left alone), and when a
create fails before its session ever started. Pruning deletes a row only once
its objects are gone, so a failed delete is retried.
Multi-repo sessions must keep their GitHub repos under one owner: a pod gets
one owner's installation token. Forgejo repos may be mixed in; they clone with
the service's Forgejo token, and a create with a Forgejo repo fails with a clear
error when no Forgejo token is configured.

Provider logins are capabilities on the create form, ticked per session. They
reuse the service's own credentials; there are no `CLAWS_SESSION_*`
credential variables:

| Capability | Carries | Pre-ticked |
|---|---|---|
| `claude-auth` | the service's `CLAUDE_CODE_OAUTH_TOKEN` | Claude sessions |
| `codex-auth` | a copy of the service's Codex `auth.json`, placed in the session's `CODEX_HOME` only if absent | Codex sessions |
| `openrouter-auth` | `OPENROUTER_API_KEY` | OpenCode sessions |
| `github-auth` | a GitHub App installation token behind a `gh` shim and a github.com git credential helper; Claws re-patches it in place before it expires | never, tick it explicitly |

A session without a login starts unauthenticated. Log in inside it
(`/login`, `codex login --device-auth`); HOME is on the PVC, so the login
survives resume. `repo-zsh` pre-ticks nothing.

Claude pod sessions get the `claws-state` MCP server from Claws itself, over
MCP streamable HTTP at `$CLAWS_SESSION_MCP_URL/mcp/sessions/<id>` on the
dashboard port (#3056). The pod never runs the stdio server, so no database
credentials or internal MCP token enter it. Each launch mints a random
`mcp-token`, stored in the session Secret and in the pod's `mcp.json`. It is
accepted only for that session's own URL while its row is open, and it acts
only as that session: the read-only state tools plus retitling itself, never
the Home Assistant tools. End and Delete revoke it. Revive with a fresh pod
mints a new one; reopening a still-running pod keeps it. After a Claws restart
the token is read back from the Secret on first use. With
`CLAWS_SESSION_MCP_URL` empty, Claude pod sessions get no `claws-state`. If it
is set but the NetworkPolicy blocks port 3000, Claude reports `claws-state` as
failed to connect and the session still starts. Codex and OpenCode pod
sessions get no MCP config.

Rows created by the host `local-tmux` backend (`backend` NULL or `local-tmux`)
are ignored by the pod backend. They are never listed as live or reconciled,
and resuming one fails with "created on the host tmux backend".

### fleet-infra dependencies (fleet-infra#1328)

- Namespace `claws-sessions` with Pod Security `restricted` enforced. It is
  deliberately not `default`: create/delete on Secrets in `default` would
  expose `claws-config`, and `apps/claws/rbac.yaml` limits that Role to
  `resourceNames: [claws-auth]`.
- Role + RoleBinding in `claws-sessions` for ServiceAccount
  `default/claws-staging` (the production SA later) with:
  pods `get,list,create,delete`; services `get,create,delete`; secrets
  `get,create,delete,patch`; persistentvolumeclaims `get,list,create,delete`.
- A `ghcr-pull` Secret in `claws-sessions`.
- NetworkPolicy: ingress to `claws-workload=session` pods on 7681 only from
  Claws pods; egress open (clone, provider APIs).
- NetworkPolicy for `claws-state` (fleet-infra#1356): allow TCP 3000 from
  `claws-workload=session` pods in `claws-sessions` to the Claws pod, as
  ingress on Claws and as egress on the session policy if egress is ever
  restricted.
- `CLAWS_SESSION_MCP_URL` set to the Claws Service URL as session pods reach
  it (staging: `http://claws-staging.default.svc.cluster.local:3000`),
  fleet-infra#1356.
- Claws env: `CLAWS_SESSION_NODE_SELECTOR=kubernetes.io/hostname=k3s` (other
  nodes are often off), then `CLAWS_SESSION_BACKEND=k8s-pod`, flipped **after**
  the RBAC is applied. `CLAWS_SESSION_IMAGE` does not need to be set:
  `release.yml` passes the release tag into the Docker build as
  `CLAWS_VERSION`, so the versioned default (`ghcr.io/st-john-software/claws:<tag>`)
  already matches the image the StatefulSet runs. No new credential Secret is
  needed.

The client authenticates only with the pod's projected ServiceAccount token,
never with the cluster-admin `~/.kube/config`. The Claws pod therefore needs
`automountServiceAccountToken: true`, which it already has for
`auth-secret-sync`.

**Interim (fleet-infra#1338), not the live-process guarantee.** Mounting
`~/.claude/projects`, the Codex/opencode session stores and `~/.npm` from the
Claws `data` PVC keeps `local-tmux` sessions on staging resumable with
`--continue` across rollouts. Their processes, scrollback and uncommitted
state still die with every rollout.

### Session lifecycle

| Event | What happens |
|---|---|
| Claws rollout or restart | Session pods are untouched. The browser shows a reconnect and reattaches to the same tmux session. |
| End | The pod, Service and Secret are deleted and the row moves to history. The PVC is kept, so the session is resumable. A Service or Secret delete that fails is retried on every reconcile pass, and again after a Claws restart. Each session has one in-process lock shared by create, Revive, End, Delete, history pruning and reconcile. End and Delete return 503 while a create, Revive, End, Delete, pruning or reconcile is acting on that session. Revive returns 503 while End, Delete, pruning or reconcile is acting on it; a second Revive during a create or Revive just opens the session. |
| Revive | A fresh Secret, Service and Pod start on the same PVC with fresh credentials; agents continue their last conversation. |
| Delete | The pod, Service, Secret and PVC are deleted, then the row. If any delete fails, the row is kept and the call returns 503; objects already deleted stay deleted, so the session may end. |
| Claws image upgrade | Only new (and revived) sessions get the new image; running pods keep theirs. |
| Pod crash, eviction, node failure or drain (or the shell exits) | The processes die and reconcile marks the row ended and deletes its Service and Secret. The PVC is kept, but `local-path` RWO pins it to its node, so revive once that node is back. |
| Kubernetes API unreachable | Nothing is ended or deleted. Rows stay live, and End, Delete, attach and uploads return 503. |
| Session start | Slower than on the host: a full clone per repo, with no reference mirror. |

Session pods and headless agent runs use the Claude, Codex and OpenCode CLIs
baked into the Claws image. The image sets `DISABLE_AUTOUPDATER=1` because its
npm prefix is root-owned and read-only for uid 1000, so the Claude CLI's
self-updater can never succeed there (#3088). Instead, `claude-code-release.yml`
checks npm daily and calls `release.yml` whenever Claude Code has a version the
latest release did not ship (or that release's image was never pushed), and
every GitHub Release records the version it shipped (`Claude Code CLI: x.y.z`).
Running pods keep their CLI version until they are revived.

Provider tokens copied into a pod are not refreshed while it runs, except
`github-token`. When `claude-auth.ts` refreshes the service's Claude token,
running pods keep the old one until they are revived. A fresh session PVC may
show Claude's onboarding or permission prompts once.

### Verification on staging

After the RBAC lands and `CLAWS_SESSION_BACKEND=k8s-pod` is set:

1. `/verify`: the `session-backend` row is green.
2. Create a `repo-zsh` session, and a Claude `worktree-claude` session with
   `claude-auth` + `github-auth`. In each, record `hostname`, `echo $$`,
   `tmux display -p '#S #{pane_pid}'` and `pwd`. Start
   `while true; do date >> ~/tick.log; sleep 5; done` and leave an uncommitted
   file.
3. Deploy a new Claws image to the StatefulSet. `kubectl -n claws-sessions get
   pods` shows unchanged UIDs and restart counts.
4. Reconnect through the dashboard. The pod, PID, tmux name, scrollback, cwd
   and uncommitted file are unchanged, `tick.log` is still growing, and there
   are no ended/cleanup logs.
5. After more than 1 h, `gh api user` or `gh auth status` still works in the
   Claude session.
6. Revoke the RoleBinding and restart Claws. Rows stay live, WS/End/Delete
   return 503, and nothing is deleted.
7. Restore the RoleBinding and reconnect, then End a session: it moves to
   history and its PVC remains. Revive it: the uncommitted file is present and
   the agent continues. Delete a session: its PVC and row are gone.

Deploying with `CLAWS_SESSION_BACKEND` unset keeps staging on `local-tmux`,
and the `session-backend` row stays FAIL as the reminder.

### Rollback

Session pods keep running after a rollback to openclaw, which cannot see
them. End them from the k8s dashboard first, or clean one up by hand:

```
kubectl -n claws-sessions delete pod,svc,secret,pvc -l claws-workload-id=<id>
```

### Migrating sessions off openclaw

`systemctl stop claws` leaves the host's tmux sessions running
(`KillMode=process`), and a DB copy migrates no processes. Before the final
sync, run `tmux -L claws ls` on openclaw and End or finish each session from
the openclaw dashboard. Anything still running afterwards is reachable only
over SSH (`tmux -L claws attach -t claws-<id>`), and the pod backend ignores
its row.

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
| `CLAWS_ACTIVATION_STATE` | `verify-only` for the initial rollout, `staging` for the label-restricted issue/PR pipeline, `active` once cut over |
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
| `WHATSAPP_ENABLED`, `WHATSAPP_ALLOWED_NUMBERS` | WhatsApp gateway; added at cutover, after openclaw is stopped (see Data migration) |

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

On Kubernetes, `~/.claws` (the PVC) holds `config.json`, `repos/`, `worktrees/`,
`pending-ideas/`, `whatsapp-auth/` — everything that must survive a restart. Only `config.json`,
`pending-ideas/` and `whatsapp-auth/` are migrated from a host (see Data
migration); `env` is never copied and exists only if the pod's own `/reauth`
wrote it. Once `CLAWS_DATABASE_URL` is set (#2953) the PVC no longer holds
`claws.db` at all: the database lives in the shared Postgres (fleet-infra#1274)
and is backed up by its 02:30 `postgres-db-backup` dump rather than by the PVC.

Everything else in `$HOME` is ephemeral and rebuilt on every boot by
`deploy/container-entrypoint.sh`: `~/.claude` and `~/.codex` from the Secret
plus the bundled skills, `~/.ssh` and `~/.kube` from the Secret — except for
fleet-infra#1338's `subPath` mounts of the `data` PVC at `~/.claude/projects`,
`~/.local/share/opencode` and `~/.npm`, which persist across rollouts like the
rest of the PVC. **Agent memories are never restored anywhere** — the pod
starts with an empty `~/.claude` every time, by design.

Because the PVC is `local-path`, it (and everything mounted from it, `subPath`
or not) shares the k3s node's root disk — there is no separate volume to run
out of. Node disk alerts come from fleet-infra's Grafana rules (root
filesystem under 15%/5% free, kubelet `DiskPressure`), not from Claws. The
pod's own ephemeral storage is separately bounded by the StatefulSet at 24Gi,
with 12Gi carved out for `/tmp`. Inside the pod, `host-disk-monitor` only
sweeps stale `/tmp` scratch and never files a disk issue — see
[Container mode](jobs/host-disk-monitor.md#container-mode).

## Data migration

`claws.db` is **not** moved by the tar pipeline any more. The nightly
[`staging-db-sync`](jobs/staging-db-sync.md) job has already been loading
openclaw's database into the `claws` Postgres database every night — that job
exists precisely so this step is small and rehearsed rather than a one-shot
`tar | kubectl exec` of a 647 MB file. Apart from the database, only
`config.json`, `pending-ideas/` and `whatsapp-auth/` move. Everything else is
regenerated or comes from a Secret, and `env` is never copied.

**1. Stop claws on openclaw.**

```
sudo systemctl stop claws claws-updater.timer
sudo systemctl disable claws-updater.timer
```

The final sync runs **after** this, never before. A sync taken while the host
instance is still running misses every write between the snapshot and
`systemctl stop`; and once it is stopped, `/trigger/staging-db-sync` no longer
exists to run one. Stop first, then ship the stopped database by hand.

**2. Checkpoint and ship the stopped database**, with the same two `kubectl
exec` commands the nightly job uses:

First check for oversized `job_logs` rows (#3113). Claws normally purges
these itself on startup via `pruneOldLogs()`, but if the cutover happens
before that deploy has reached this host, oversized rows would still be
sitting in the file:

```
sqlite3 ~/.claws/claws.db "SELECT count(*) FROM job_logs WHERE length(CAST(message AS BLOB)) > 128000"
```

`length(CAST(message AS BLOB))` is used here instead of `octet_length()` in
case the host's `sqlite3` CLI predates SQLite 3.43. If the count is
non-zero, delete them before checkpointing:

```
sqlite3 ~/.claws/claws.db "DELETE FROM job_logs WHERE length(CAST(message AS BLOB)) > 128000"
```

The file itself only shrinks after `VACUUM`, which the import doesn't need —
it reads rows, not file size.

```
sqlite3 ~/.claws/claws.db "PRAGMA wal_checkpoint(TRUNCATE)"
kubectl exec -i -n default claws-staging-0 -- sh -c 'cat > /home/claws/.claws/import-snapshot.db' < ~/.claws/claws.db
kubectl exec -n default claws-staging-0 -- node /opt/claws/dist/tools/import-sqlite-db.js /home/claws/.claws/import-snapshot.db
kubectl exec -n default claws-staging-0 -- rm -f /home/claws/.claws/import-snapshot.db
```

A stopped WAL database still has uncheckpointed pages sitting in
`claws.db-wal`, so copying `claws.db` alone would ship a database missing its
most recent writes; the `wal_checkpoint(TRUNCATE)` line is what makes the plain
file copy safe (copying all three of `claws.db`, `-wal` and `-shm` is the
equivalent alternative). The importer replaces the pod's database inside one
transaction and repairs every identity sequence — see
[staging-db-sync.md § Atomicity and failure](jobs/staging-db-sync.md#atomicity-and-failure).
`verification_reports` is left out of that replacement, so the pod keeps its
own connectivity reports — see [staging-db-sync.md § Instance-local tables are
never synced](jobs/staging-db-sync.md#instance-local-tables-are-never-synced).

**3. Copy `config.json`, `pending-ideas/` and `whatsapp-auth/`.**

This step runs only after step 1 has stopped `claws.service` on openclaw. A
copied `whatsapp-auth/` while openclaw's gateway is still connected would give
two live sessions on the same credentials.

```
tar -C "$HOME/.claws" -cf - config.json pending-ideas whatsapp-auth \
  | kubectl exec -i -n default claws-staging-0 -- tar -xf - -C /home/claws/.claws
```

If `ls ~/.claws/pending-ideas` fails on openclaw, drop that argument from the
tar command.

**What is not copied, and why:**

| Path | Why not |
|---|---|
| `repos/`, `worktrees/` | Re-cloned on demand |
| `claws.db*` | Moved by step 2 |
| `session-mcp/`, `session-uploads/` | `local-tmux` session scratch; `k8s-pod` sessions keep state on per-session PVCs |
| `snapshots/`, `scratch/`, `prompt-captures/` | Rebuilt by their jobs, or disposable |
| `claude-memory-backup/`, `claude-memories-fold/` | Memories live on the `claude-memories` branch |
| `claws.pid` | Stale PID lock from openclaw |
| `env` | Never; see the warning below |
| `prod-kubeconfig.yaml`, `github-app.pem`, `stjohnb-github-app.pem`, `grafana-admin-credentials.txt` | The pod gets these from Secrets and mounts; copying puts credentials on the PVC for no reason |
| `config.json.bak-*`, `env.bak-*` | Backups of the above |

Do **not** copy `~/.claude`, `~/.codex` or `~/.ssh` — those come from the
Secret, not from openclaw's host state.

**⚠️ Never copy `~/.claws/env`.**

`loadEnvFile()` (`src/env-file.ts`, called from `src/config.ts` before
`loadConfig()`) lets file values override the pod's existing environment.
openclaw's `env` is its systemd EnvironmentFile, full of host settings. Copying
it would overwrite the StatefulSet's `CLAWS_OIDC_*` values, key-path variables
such as `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH`, and the fresher `CLAUDE_CODE_OAUTH_TOKEN`
that `/reauth` writes. On the pod, `env` is written only by the pod itself
(`persistToken()` in `src/claude-auth.ts`).

If an `env` from a host reaches the PVC despite this warning, recover with:

```
kubectl exec -n default claws-staging-0 -- rm -f /home/claws/.claws/env
```

Then restart the pod. This also discards any `/reauth` token written there, so
redo `/reauth` afterwards if needed.

**4. Fix the stjohnb key path.**

In `/home/claws/.claws/config.json` on the pod, set
`githubOwnerAppCredentials.stjohnb.privateKeyPath` to
`/etc/claws/github-app-stjohnb/private-key.pem`. The copied file still names
openclaw's `/home/brendan/.claws/stjohnb-github-app.pem`, which does not exist
in the pod, so minting stjohnb installation tokens would fail.

```
kubectl exec -n default claws-staging-0 -- node -e \
  'const fs=require("fs"); const c=JSON.parse(fs.readFileSync("/home/claws/.claws/config.json", "utf-8")); c.githubOwnerAppCredentials.stjohnb.privateKeyPath="/etc/claws/github-app-stjohnb/private-key.pem"; fs.writeFileSync("/home/claws/.claws/config.json", JSON.stringify(c, null, 2))'
```

Also grep the file for any other `/home/brendan/` path:

```
kubectl exec -n default claws-staging-0 -- grep -n /home/brendan /home/claws/.claws/config.json
```

**5. Enable WhatsApp on the pod.**

Add `WHATSAPP_ENABLED=true` and `WHATSAPP_ALLOWED_NUMBERS=<openclaw's value>`
to the `claws-config` Secret now, after step 1 and together with step 3's copy.
Copy the two values by hand from openclaw's `~/.claws/env`, never the file
itself. fleet-infra#1302 carries the manual `kubectl patch`/`edit` step to add
them to the Secret.

Today `claws-config` has neither variable, and `/verify` reports
`whatsapp-auth: WhatsApp disabled`. `src/config.ts` enables WhatsApp only when
`WHATSAPP_ENABLED=true` (or `whatsappEnabled: true` in config.json). With no
allowed numbers it accepts no senders. The gateway starts only when the
instance is `active` (`src/main.ts`), so it connects at activation.

`whatsapp-auth/` sits on the `data` PVC at `/home/claws/.claws`, so the copied
session survives image rollouts. Check after activation: the `/verify`
`whatsapp-auth` row is green, and `/whatsapp` shows connected without a new QR
pairing. Only if the copied session does not reconnect, pair again from
`/whatsapp/pair` (see [`docs/whatsapp-setup.md`](whatsapp-setup.md)).

**6. Activate staging** — see [Activation](#activation) below.

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

Activation is explicit on the Postgres backend: set
`CLAWS_ACTIVATION_STATE=verify-only`, `staging`, or `active` in the
`claws-config` Secret and restart, or use `/config`. `verify-only` runs the
dashboard and `/verify` only; it never executes labelled items. `staging`
registers only `issue-dispatcher`/`pr-dispatcher` plus worker handlers, and the
central dispatch guard restricts execution to live issues and PRs carrying
`Claws Staging`. Background jobs stay disabled. `active` is full production
mode and skips `Claws Staging` items. (The "a restored `claws.db` makes
`src/config.ts` auto-select `active`" behaviour only applies on the SQLite
backend, where the database is a file on the PVC.) Check `/verify` is green
before moving out of `verify-only` — the `session-backend` row is the one this
cutover added, and it must be green (see
[the session prerequisite](#cutover-prerequisite-pod-per-session-interactive-sessions-3026)).

A PR the staging implementer opens for a `Claws Staging`-labelled issue carries
a `claws-staging-owned: true` marker line in its body
(`CLAWS_STAGING_PR_MARKER` in `src/github.ts`), even if the `Claws Staging`
label itself is later removed or never applied to the PR — `isDispatchSkippable()`
treats the marker the same as the label. This is what keeps a staging-originated
PR eligible for staging's own review/CI/merge pipeline and, on an `active`
instance, causes it to be skipped rather than picked up as ordinary production
work during the handoff window.

## Traffic cutover

Delete `apps/claws/endpoints.yaml`, drop it from `kustomization.yaml`, and
add `selector: { app: claws-staging }` to `service.yaml` so the Service starts
routing to the pod instead of the hand-written endpoint. `selector.matchLabels`
is immutable and renaming would orphan PVC `data-claws-staging-0`, so the
`claws-staging` names stay after cutover. Rollback is re-adding `endpoints.yaml`
and restarting `claws.service` on openclaw.

## Rollback window

Keep openclaw powered on with `claws.service` installed but stopped for two
weeks after cutover. The PID lock (`claws.pid` in `WORK_DIR`) cannot stop a
cross-host double-run, so both `claws.service` and `claws-updater.timer`
must stay stopped for the whole window while the pod is active. Before
restarting `claws.service` on openclaw for a rollback, stop the pod or remove
the two `WHATSAPP_*` keys from `claws-config` and restart it. openclaw's
`whatsapp-auth/` holds the same credentials, and two connected gateways conflict.

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
  freshly-logged-in `~/.codex/auth.json` reaches the Secret immediately. Disabling Codex in
  `CLAWS_CODEX_ENABLED` / `aiProviders.codex.enabled` covers the gap while that happens. The Claude OAuth token doesn't have this
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
