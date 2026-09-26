# Kubernetes cutover runbook

**Deep dive.** Read this when you're cutting the k8s deployment over from the
systemd host (`openclaw`), or operating the k8s deployment afterward (#2752).
For the shape of the deployment itself — StatefulSet, ephemeral provider
homes, verify-only rollout, the connectivity checks in the Activation section of `/config` — see
[OVERVIEW.md § Kubernetes Deployment](OVERVIEW.md#kubernetes-deployment)
first; this doc is the operator playbook: manifest diffs, secrets, data
migration, activation, traffic cutover, rollback, and known limitations.

**Cutover happened 2026-09-16** (fleet-infra#1405, closing fleet-infra#1302).
The rollback window was closed early on the owner's call: openclaw was
decommissioned on 2026-09-22 (nixos-config#402), so rollback to it is no
longer possible. [Post-window tidy](#post-window-tidy) was completed in
#clw_01M34R5REZGT748AJZ76FYB45B.

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
`claws-workload-id=<id>`, `app.kubernetes.io/name=claws-session` and
`app.kubernetes.io/instance=claws-session-<id>` (the latter two are what
Promtail's default relabel config turns into the Loki `app`/`service_name`
and `instance` labels, so `{app="claws-session"}` in Grafana aggregates every
session instead of one stream per pod — #3273):

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
| `github-auth` | a GitHub App installation token behind a `gh` shim and a github.com git credential helper; Claws re-patches it in place before it expires | GitHub-hosted repos; also grantable mid-session (#3131) |

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

When `CLAWS_SESSION_MCP_URL` is set, every pod session (agent or zsh) also
reports how its process ended (#3311): just before exiting, the pod's
terminal server POSTs the exit code and the final scrollback tail to
`$CLAWS_SESSION_MCP_URL/session-pods/<id>/exit`, authenticated by the
session's terminal token, and Claws stores both on the still-open row. That
lets `/sessions/<id>` show the last output after the pod is deleted. The
report uses the same port 3000 path as `claws-state`; if it fails, the pod
still exits with the process's code, so reconcile marks a crash `failed`
even without it.

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
- The Claws image consumes the `nixos-config` `claws-session-shell` image as a
  pinned Docker source stage, currently
  `ghcr.io/st-john-software/claws-session-shell@sha256:7e25fc170a74828a6620c17186516c466222d43f644019d55c8244a136db7627`,
  published from `nixos-config` PR #411 head
  `8458c8a7a41cf7c4e4ef97f53e7f7837f5a7f256`.
  `nixos-config` owns shared zsh/git/SSH defaults; this repo owns the final
  Node runtime, agent CLIs, terminal server, skills and entrypoint. Updating the
  shell image pin is a Claws runtime change and must pass the Docker smoke
  checks before release. Those checks scan the whole copied payload — the
  extracted `/etc/skel` and every path of the copied `/nix/store`, not only the
  store paths the dotfiles reference — for secret material, and separately
  reject secret-shaped *filenames* (`known_hosts`, `id_rsa`, `*.pem`, `.kube`,
  kubeconfigs, `.netrc`), whose contents carry no give-away string.

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
| Session start | Slower than on the host: a full clone per repo, with no reference mirror. Create/Revive redirects once the row and Kubernetes objects exist; the terminal page polls `/api/sessions/:id/startup` for real startup progress and attaches when the pod is Ready. |

Session pods and headless agent runs use the Claude, Codex and OpenCode CLIs
baked into the Claws image. The image sets `DISABLE_AUTOUPDATER=1` because its
npm prefix is root-owned and read-only for uid 1000, so the Claude CLI's
self-updater can never succeed there (#3088). Instead, `claude-code-release.yml`
checks npm daily and calls `release.yml` whenever Claude Code has a version the
latest release did not ship (or that release's image was never pushed), and
every GitHub Release records the version it shipped (`Claude Code CLI: x.y.z`).
Running pods keep their CLI version until they are revived.

### Startup timing evidence (#3198)

Read-only staging evidence from 2026-09-18, pod
`claws-session-974378c5187d681f` on image
`ghcr.io/st-john-software/claws:v2026-09-17.6`, showed the image was already
present. The `prepare` init container ran from 08:53:33 to 08:53:40 UTC, clone
output began at 08:53:34.108, and the skills/tmux/terminal-server startup logs
were 08:53:41.66 to 08:53:41.71. In that warm-image sample the dominant visible
delay was repository clone/checkout in `prepare`, not image pull or terminal
runtime setup. Cold image-pull and resource/storage policy findings belong in
fleet-infra issues if later measurements show them dominating.

A second read-only sample on 2026-09-18, pod
`claws-session-2d770c6cb12ae83a`, had pod `startTime` 09:27:15 UTC, `prepare`
terminated at 09:27:19 UTC, clone logging began at 09:27:15.856, and the
terminal server listened at 09:27:20.252. That warm start again spent roughly
four seconds in checkout/init and less than one second in runtime setup after
`prepare` completed.

Provider tokens copied into a pod are not refreshed while it runs, except
`github-token`. When `claude-auth.ts` refreshes the service's Claude token,
running pods keep the old one until they are revived. Claude sessions start
with Claude Code's onboarding, folder-trust and bypass-permissions screens
pre-answered (#3131; theme from `CLAWS_SESSION_CLAUDE_THEME`).

### Verification on staging

After the RBAC lands and `CLAWS_SESSION_BACKEND=k8s-pod` is set:

1. `/config` connectivity checks (Activation section): the `session-backend` row is green.
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

### Pod-per-run headless agents (#clw_01M34R5RECDPPXVXBJZS1DA6C1)

With `CLAWS_WORK_BACKEND=k8s-pod` (see `docs/configuration.md`, "Headless work
backend"), each claimed work-queue row runs in its own pod in the session
namespace instead of a worker fiber of the service, so a rollout no longer
kills a 40-minute review. `src/agent-pod-launcher.ts` creates two objects per
row, both named `claws-agent-<rowId>` and labelled `claws-workload=agent`,
`claws-workload-id=<rowId>`:

- **Secret**: `agent.env` (the service's own environment, minus host,
  Kubernetes, OIDC, dashboard-auth and database (`CLAWS_DATABASE_URL`,
  `CLAWS_DATABASE_PASSWORD`) variables, plus the SSH key,
  kubeconfigs, Codex auth and Claude settings the entrypoint rebuilds HOME
  from), the GitHub App private keys as `github-app-<n>.pem`, `launch.json`
  (row id, run id, and the files written into HOME: `~/.claws/config.json`
  with its key paths pointed at the mounted copies, and
  `~/.claws/internal-mcp-token`), and `mcp-token`.
- **Pod** (same image, `restartPolicy: Never`, PSA `restricted`, `emptyDir`
  HOME, no container ports, no init container): sources `agent.env`, runs
  `deploy/container-entrypoint.sh`, which execs `dist/agent-pod/main.js`
  because `CLAWS_AGENT_POD_ROW` is set. The pod runs the row through the same
  `worker.runRow()` as the service, but with every `db.js` import resolved
  to `db-remote.js`: its result, tasks, job logs and tokens go to the
  agent-pod ops API, never to Postgres. The one thing it serves is the
  planner-run routes (`src/planner-run-listener.ts`,
  #clw_01M3A42ZTGECAB11S0BZA6NG1A): a planner run's registry lives in the
  process running the refiner, so the pod binds those three routes on
  `127.0.0.1` at an ephemeral port, guarded by its own `mcp-token`, and the
  MCP child's `claws_save_plan` posts there (`CLAWS_MCP_PLANNER_BASE_URL`)
  instead of to the service, which would answer 404. Loopback only — it is
  not a container port and needs no Service or NetworkPolicy change.

**The Secret holds no database credentials.** Unlike a session Secret, which
carries only what the operator ticked, it holds live forge and CLI credentials
(GitHub App keys, SSH key, agent OAuth tokens), but never the database URL or
password. Only the `claws` ServiceAccount and cluster admins can read
Secrets in `claws-sessions`, session pods mount no ServiceAccount token, and
the Secret is deleted when the run ends and by the hourly orphan sweep.

**Agent-pod ops API** (#clw_01M386P9KPDEVV33TKY512HHBC). The pod calls
`POST /agent-pods/<rowId>/ops/<op>` on the service (`CLAWS_SESSION_MCP_URL`,
TCP 3000) with its per-run token, body `{"args": [...]}`, reply
`{"result": ...}`. `<op>` is one of the named `db.ts` functions in
`src/agent-pod-ops.ts` — no SQL crosses the wire — and an op that names a
row, run or task must name the caller's own (403 otherwise). The token is
accepted while the row is `running` and for 10 minutes after it ends (so the
pod can complete its job run and flush its logs), with row writes refused
once it has ended — each is one `UPDATE … WHERE status = 'running' AND
run_id = ?`, so a row the launcher ends mid-request stays ended; a re-queued
row clears the token hash, so its old pod gets 401 and exits without running.
The pod retries only a failure that cannot have reached an op — a connection
never established, or a 502/503/504 (the service restarting) — for about five
minutes; a reset socket or a timeout is not retried. Job logs ship in batches
of at most 3 MiB, under the route's 4 MiB body cap; a batch the service still
refuses with 413 is halved, and a single line too large is dropped. A native
issue attachment's bytes come from `GET /agent-pods/<rowId>/attachments/<attId>`
instead, streamed with the same token, since the pod's HOME has no
`issue-attachments/`.

**Per-run MCP token.** The service's `INTERNAL_MCP_TOKEN` is minted each boot,
so a pod given it would lose its `claws-state` HTTP tools at the first
restart. Instead each launch mints a random token, stores it in the Secret as
`mcp-token`, and records only its SHA-256 in `work_queue.agent_mcp_token_sha256`
before the Secret is created; `agent_pod` is recorded only once the Pod
exists, so a boot that died mid-launch re-queues the row instead of adopting
it. The `/api/*` routes accept a bearer token whose hash matches a row that
is still `running`, so the token keeps working across service restarts and
stops the moment the row ends or is re-queued.

The service watches each pod every 15 s. A restart leaves pod and row alone;
the next boot logs `Adopting N pod-backed agent run(s)` and re-attaches.
The service ends a row only on a real answer: the pod exited
(Succeeded/Failed — `OOMKilled`, `Evicted`, `exit code N` — while the row was
still `running`, which fails the row and its running tasks), no pod 3 min
after launch (at once for an adopted row, whose pod did exist), a pod still
`Pending` after 15 min (`ImagePullBackOff`, `Unschedulable`, a bad Secret
key, …), a pod in phase `Unknown` or stuck terminating on a lost node for
15 min, a dashboard cancel (recorded on the job run, then the pod is deleted
and the row `cancelled` — a restart in between still cancels it), or the 6 h
stale-work ceiling. Those writes apply only while the row is still `running`
under the run, so they never overwrite the pod's own result. An API error,
timeout or 403 changes nothing. A launch that finds a Pod or Secret already
named `claws-agent-<rowId>` (left by a boot that crashed mid-launch) deletes
it, waits for it to go and creates it again.
The orphan sweep, at boot and hourly, deletes agent Pods whose row is missing
or not `running`, with their Secrets. The `claws-sessions` Role has no `list`
on Secrets, so a Secret with no pod is replaced by the row's next launch. The
same hourly tick re-adopts any pod-backed `running` row no worker is
watching. The `/config` connectivity checks' `work-backend` row checks the image, `CLAWS_SESSION_MCP_URL` and the Pod and
Secret verbs of the Role; `in-process` inside a container fails it.

**In-pod memory watchdog cap** (#clw_01M3A5BDFHK8C03Q8BP0NC37QC). An agent pod
runs the same in-process `runCliProcess` watchdog as the service, but it does
not inherit the service's `agentWorkerMemory*` env or config — those are tuned
for the service's own, differently-sized container. `buildAgentPodLaunch`
derives the pod's own cap from `CLAWS_AGENT_POD_MEMORY_LIMIT`
(`agentPodWatchdogCapBytes()` in `agent-memory-budget.ts`): the limit minus a
2 GiB margin, floored at 2 GiB — 4 GiB at the default 6Gi pod limit — and sets
it as `CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES` in the pod's own env. The watchdog
samples every 5 s (`AGENT_MEMORY_WATCHDOG_INTERVAL_MS` in `claude.ts`) rather
than the previous 15 s (the interval is shared with the service), so a
runaway tree has less room to outgrow the smaller pod-scale margin between
samples and end in a diagnosable `AgentMemoryLimitError` instead of a kernel
`OOMKilled`.

Agent pods do not reach Postgres, and Postgres deliberately does not admit
them: `postgres-ingress-restricted` admits only `default` pods by `app`, and
fleet-infra will not add a `claws-workload=agent` peer
(#clw_01M382CH5H80QHDW5B8R04TGHM). The only traffic that matters for any
future policy is the pod's `claws-state` and ops-API calls to Claws on TCP
3000, so the `claws-state` rule above must cover `claws-workload=agent` as
well as `claws-workload=session` — as ingress on Claws if a policy ever
selects it (none does today), and as egress on the agent pods if egress is
ever restricted. Otherwise every agent run fails at its first op. The pod's
stdio `claws-state` child has no database either, so its DB-backed tools
(`claws_status` running tasks, `claws_task_history`, job runs and logs,
work queue, attachments) report "Database not available" inside an agent pod.

Roll back to `CLAWS_WORK_BACKEND=in-process` only once no pod-backed row is
`running`: startup recovery never re-queues those rows (their pods may still
be writing results), and only the `k8s-pod` backend adopts them, so under
`in-process` they stay `running` — logged as a warning at boot — until the
backend is `k8s-pod` again. Clean up one run by hand with:

```
kubectl -n claws-sessions delete pod,secret -l claws-workload-id=<rowId>
```

## State before cutover (verified 2026-09-01)

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
  `memory: 10Gi`, **no `cpu` limit** — `512Mi`/`500m` cannot host a `claude`
  worker process.
- Headless workers run inside this same service container, unlike interactive
  sessions. As of 2026-09-21, `default/claws-staging-0` runs with
  `CLAWS_ACTIVATION_STATE=active`, `CLAWS_SESSION_BACKEND=k8s-pod`, request
  `2Gi`, limit `10Gi` (`/sys/fs/cgroup/memory.max` reads `10737418240` from
  inside the pod), `CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES=4294967296` and
  `CLAWS_MAX_WORK_WORKERS=2` — fleet-infra commit `61466921` (PR
  [#1469](https://github.com/St-John-Software/fleet-infra/pull/1469), closing
  [#1460](https://github.com/St-John-Software/fleet-infra/issues/1460)) raised
  the limit and restored the second worker, so there is no pending follow-up.
  The app-side policy is a 4 GiB effective headless-agent cap with two queue
  workers and shared memory admission. The headroom default (1.25 GiB) is the
  service's own footprint; the budget is sized by how many concurrent full-cap
  runs it should admit. At `10240 - 1280 = 8960` MiB the budget admits **two**
  4 GiB agent reservations (8192 MiB) plus the 768 MiB auxiliary lane, which is
  a separate lane with its own FIFO queue — so the short bookkeeping calls (PR
  descriptions, no-commit diagnoses, complexity classification) run alongside
  the implementers rather than behind them, and they are *capped* at the
  auxiliary slice, not merely reserved at it. Raising the cap or the headroom
  reduces how many full-cap runs overlap; it can no longer squeeze the
  auxiliary lane.
  **The fit is exact by construction, not by accident:** `2 × 4096 + 768 +
  1280 = 10240` MiB is the container limit to the byte, and fleet-infra's own
  sizing note (`statefulset.yaml`, "2 × 4 GiB watchdog + ~1 GiB service < 10
  GiB") is where the 768 MiB auxiliary lane comes from — it is spent out of
  that slack deliberately. The watchdog samples every 15 s, so a tree can
  overshoot its cap between samples (issue #3168 observed 2599 MiB against a
  2048 MiB cap); the remaining protection against a simultaneous overshoot in
  every lane is the kubelet limit itself. Before raising
  `agentWorkerMemoryMaxBytes` past 4 GiB here, raise the container limit in
  fleet-infra in the same change — a cap above `budget − 768 MiB` no longer
  overlaps at all (it is admitted only with the whole gate empty, and logs a
  warning saying so).
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

Created and patched imperatively with `kubectl`, never declared in a
fleet-infra manifest — a declared Secret risks Flux server-side apply
resetting `.data`. `CLAWS_ACTIVATION_STATE` is not set here — see
[Activation](#activation).

| Key | Purpose |
|---|---|
| `CLAWS_GITHUB_APP_ID` | GitHub App auth |
| `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH` | Set to `/etc/claws/github-app/private-key.pem` (see above) |
| `CLAWS_CLAUDE_SETTINGS_JSON` | Optional — contents of `~/.claude/settings.json` |
| `CLAWS_SSH_PRIVATE_KEY` | Runner SSH access |
| `CLAWS_KUBECONFIG` | Fleet/k3s cluster access for `kubectl` |
| `CLAWS_PROD_KUBECONFIG` | Production cluster kubeconfig; entrypoint writes `/home/claws/.kube/prod-config` for the `prod-infra` session capability |
| `CLAWS_SLACK_WEBHOOK`, `CLAWS_SLACK_BOT_TOKEN` | Slack notifications |
| `CLAWS_OPENROUTER_API_KEY`, `OPENAI_API_KEY` | Provider fallback |
| `BRENDAN_SERVER_GMAIL_APP_PASSWORD`, `CLAWS_EMAIL_USER` | Email monitor |
| `CLAWS_HOME_ASSISTANT_TOKEN` | Home Assistant integration |
| `CLAWS_WHISPER_LOCAL_URL` | See known limitations — no local Whisper server in-pod |
| `WHATSAPP_ENABLED`, `WHATSAPP_ALLOWED_NUMBERS` | WhatsApp gateway; added with `kubectl patch` after openclaw's `claws.service` is stopped (see Data migration) |

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
`pending-ideas/`, `whatsapp-auth/`, `issue-attachments/` — everything that must survive a restart. Only `config.json`,
`pending-ideas/`, `whatsapp-auth/` and `issue-attachments/` are migrated from a host (see Data
migration); `env` is never copied and exists only if the pod's own `/reauth`
wrote it. Once `CLAWS_DATABASE_URL` is set (#2953) the PVC no longer holds
`claws.db` at all: the database lives in the shared Postgres (fleet-infra#1274)
and is backed up by its 02:30 `postgres-db-backup` dump rather than by the PVC.

Everything else in `$HOME` is ephemeral and rebuilt on every boot by
`deploy/container-entrypoint.sh`: create-only defaults from `/etc/skel`
(`nixos-config` shared zsh/git/SSH config), `~/.claude` and `~/.codex` from the
Secret plus the bundled skills, and `~/.ssh`/`~/.kube` materialised from
Secrets. Existing PVC files win: edited `.zshrc`, `.ssh/config`, history and
prompt state survive restart/End/Revive; deleting a file is the migration path
to pick up a newer default. fleet-infra#1338's `subPath` mounts of the `data` PVC at
`~/.claude/projects`, `~/.local/share/opencode` and `~/.npm` persist across
rollouts like the rest of the PVC. **Agent memories are never restored
anywhere** — the pod starts with an empty `~/.claude` every time, by design.

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
`staging-db-sync` job (deleted post-cutover — see [Post-window
tidy](#post-window-tidy)) has already been loading openclaw's database into
the `claws` Postgres database every night — that job existed precisely so
this step is small and rehearsed rather than a one-shot `tar | kubectl exec`
of a 647 MB file. Apart from the database, only
`config.json`, `pending-ideas/`, `whatsapp-auth/` and `issue-attachments/` (the
files behind native issue attachments, whose rows travel with the database)
move. Everything else is
regenerated or comes from a Secret, and `env` is never copied.

**1. Stop and disable claws on openclaw.**

```
sudo systemctl stop claws claws-updater.timer && sudo systemctl disable claws claws-updater.timer
```

Disabling `claws` too, not just stopping it, means a VM reboot during the
rollback window cannot start a second instance.

The final sync runs **after** this, never before. A sync taken while the host
instance is still running misses every write between the snapshot and
`systemctl stop`; and once it is stopped, `/trigger/staging-db-sync` no longer
exists to run one. Stop first, then ship the stopped database by hand.

**2. Checkpoint and ship a compact copy of the stopped database.**

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

openclaw has no `sqlite3` CLI, so checkpoint through `node` and the bundled
`better-sqlite3` module instead of the `sqlite3` binary, then make a compact
copy with `VACUUM INTO` and ship that rather than the raw file — on the
2026-09-16 cutover this took `claws.db` from 3.8 GB down to about 446 MB:

```
/usr/bin/node -e 'const D=require("/opt/claws/node_modules/better-sqlite3");new D(process.env.HOME+"/.claws/claws.db").pragma("wal_checkpoint(TRUNCATE)")'
/usr/bin/node -e 'const D=require("/opt/claws/node_modules/better-sqlite3");new D(process.env.HOME+"/.claws/claws.db").prepare("VACUUM INTO ?").run(process.env.HOME+"/.claws/claws-compact.db")'
```

A stopped WAL database still has uncheckpointed pages sitting in
`claws.db-wal`, so checkpointing first is what makes the `VACUUM INTO` copy
safe — without it, the compact copy would miss the most recent writes.

Checksum the compact copy before shipping it, and again after it lands on the
pod, so a truncated transfer is caught before it is imported:

```
sha256sum ~/.claws/claws-compact.db
kubectl exec -i -n default claws-staging-0 -- sh -c 'cat > /home/claws/.claws/import-snapshot.db' < ~/.claws/claws-compact.db
kubectl exec -n default claws-staging-0 -- sha256sum /home/claws/.claws/import-snapshot.db
```

If the two checksums don't match, redo the copy before importing.

```
kubectl exec -n default claws-staging-0 -- node /opt/claws/dist/tools/import-sqlite-db.js /home/claws/.claws/import-snapshot.db
kubectl exec -n default claws-staging-0 -- rm -f /home/claws/.claws/import-snapshot.db
```

The importer replaces the pod's database inside one transaction and repairs
every identity sequence (see `src/db-import.ts`). On the 2026-09-16
run it imported 700,225 rows across 27 tables and skipped two, as expected:
`verification_reports` is skipped by design (it is in `INSTANCE_LOCAL_TABLES`
in `src/db-import.ts`), so the pod keeps its own connectivity reports.
`ha_deploy_monitor_state` was skipped as present on only one side: it is a
dead table left over from the `ha-deploy-monitor` job removed in #1291
(PR #1294). The live table, `ha_deploy_watcher_state`, exists on both sides
and imported normally, so nothing was lost.

**3. Copy `config.json`, `pending-ideas/`, `whatsapp-auth/` and `issue-attachments/`.**

This step runs only after step 1 has stopped `claws.service` on openclaw. A
copied `whatsapp-auth/` while openclaw's gateway is still connected would give
two live sessions on the same credentials.

```
tar -C "$HOME/.claws" -cf - config.json pending-ideas whatsapp-auth issue-attachments \
  | kubectl exec -i -n default claws-staging-0 -- tar -xf - -C /home/claws/.claws
```

If `ls ~/.claws/pending-ideas` or `ls ~/.claws/issue-attachments` fails on
openclaw, drop that argument from the tar command.

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

**4. Fix the copied `config.json`.**

Two edits are needed on the pod's `/home/claws/.claws/config.json`:

- Set `githubOwnerAppCredentials.stjohnb.privateKeyPath` to
  `/etc/claws/github-app-stjohnb/private-key.pem`. The copied file still
  names openclaw's `/home/brendan/.claws/stjohnb-github-app.pem`, which does
  not exist in the pod, so minting stjohnb installation tokens would fail.
- Remove `stagingDbSyncTarget` so the pod never tries to sync into itself.

```
kubectl exec -n default claws-staging-0 -- node -e \
  'const fs=require("fs"); const c=JSON.parse(fs.readFileSync("/home/claws/.claws/config.json", "utf-8")); c.githubOwnerAppCredentials.stjohnb.privateKeyPath="/etc/claws/github-app-stjohnb/private-key.pem"; delete c.stagingDbSyncTarget; fs.writeFileSync("/home/claws/.claws/config.json", JSON.stringify(c, null, 2))'
```

Also grep the file for any other `/home/brendan/` path:

```
kubectl exec -n default claws-staging-0 -- grep -n /home/brendan /home/claws/.claws/config.json
```

**5. Enable WhatsApp on the pod.**

Add `WHATSAPP_ENABLED=true` and `WHATSAPP_ALLOWED_NUMBERS=<openclaw's value>`
to the `claws-config` Secret now, after step 1 and together with step 3's copy.
Copy the two values by hand from openclaw's `~/.claws/env`, never the file
itself:

```
kubectl -n default patch secret claws-config --type merge -p '{"stringData":{"WHATSAPP_ENABLED":"true","WHATSAPP_ALLOWED_NUMBERS":"<openclaw value>"}}'
kubectl -n default get secret claws-config -o jsonpath='{.data}' | jq 'keys'
```

Never do this via a manifest — a declared Secret risks Flux server-side apply
resetting `.data`. No manual restart is needed here: the pod rolls when the
cutover PR's pod-template change merges (see [Activation](#activation)).

Today `claws-config` has neither variable, and the `/config` connectivity checks report
`whatsapp-auth: WhatsApp disabled`. `src/config.ts` enables WhatsApp only when
`WHATSAPP_ENABLED=true` (or `whatsappEnabled: true` in config.json). With no
allowed numbers it accepts no senders. The gateway starts only when the
instance is `active` (`src/main.ts`), so it connects at activation.

`whatsapp-auth/` sits on the `data` PVC at `/home/claws/.claws`, so the copied
session survives image rollouts. Check after activation: the `/config` connectivity checks'
`whatsapp-auth` row is green, and `/whatsapp` shows connected without a new QR
pairing. Only if the copied session does not reconnect, pair again from
`/whatsapp/pair` (see [`docs/whatsapp-setup.md`](whatsapp-setup.md)).

**6. Activate** — see [Activation](#activation) below.

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

Activation is explicit on the Postgres backend: fleet-infra sets
`CLAWS_ACTIVATION_STATE` directly in the StatefulSet container's `env:` in
`clusters/my-cluster/claws-staging/statefulset.yaml`. An explicit `env:` entry
shadows the same key coming from `envFrom` (`claws-config`), so putting
`CLAWS_ACTIVATION_STATE` in the Secret has no effect. Moving
`verify-only` → `staging` → `active` is a fleet-infra PR; merging it changes
the pod template and rolls the pod. `verify-only` runs the
dashboard (including the `/config` connectivity checks) only; it never executes labelled items. `staging`
registers only `issue-dispatcher`/`pr-dispatcher` plus worker handlers, and the
central dispatch guard restricts execution to live issues and PRs carrying
`Claws Staging`. Background jobs stay disabled. `active` is full production
mode and skips `Claws Staging` items. (The "a restored `claws.db` makes
`src/config.ts` auto-select `active`" behaviour only applies on the SQLite
backend, where the database is a file on the PVC.) Check the `/config` connectivity checks are green
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
`claws-staging` names stay after cutover.

## Rollback window (historical)

Rollback to openclaw is no longer possible: the host was decommissioned on
**2026-09-22** (nixos-config#402), closing the rollback window early on the
owner's call rather than the originally planned **2026-09-30**. The window
previously kept openclaw powered on with `claws.service` installed but
stopped, so a revert of the fleet-infra cutover PR (fleet-infra#1405) plus a
copy of `whatsapp-auth/` back to openclaw could bring the systemd host back
up. None of that is available anymore.

## Post-window tidy

Completed in #clw_01M34R5REZGT748AJZ76FYB45B:

- **Retired `deploy/deploy.sh` and `claws-updater.timer`.** Deleted
  `deploy/deploy.sh`, `deploy/claws-updater.service`, `deploy/claws-updater.timer`,
  `deploy/install.sh`, `deploy/uninstall.sh`, `deploy/claws.service` and the
  docs describing them — the systemd deploy path has no role now that
  openclaw is decommissioned.
- **`staging-db-sync` deleted outright.** The job, its config keys
  (`stagingDbSyncTarget`, `stagingDbSyncLogRetentionDays`,
  `schedules.stagingDbSyncHour`), tests and doc page are gone rather than
  kept as a documented no-op — its only target was openclaw's SQLite
  database.
- **Host decommission is done** — nixos-config#402 closed 2026-09-22.
- **Removed the remaining systemd-era leftovers** (#clw_01M37MNZNKV6R0E0NC1Y5VCYFG):
  the self-deploy drain (`src/deploy-drain.ts`, the `POST`/`DELETE
  /api/deploy/drain` routes, and the drain checks in `worker.ts`, `claude.ts`
  and `pages/layout.ts`), `deploy/whisper.service` and
  `deploy/whisper-server.py` (no installer since the systemd deploy path was
  retired), and the `claws.tar.gz` release asset and the build steps that
  existed only to produce it.
- **The monitor ignore-list tidy item needed nothing.** Verified at cutover:
  no `openclaw` entry existed in the cluster-monitor node ignore lists (both
  unset then, and since removed with the monitors themselves — #3250), none
  in `runners` (`[]`), and no `openclaw` runner is registered among the org's
  Actions runners. `src/jobs/runner-monitor.ts` has no ignore list at all.

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
- **Mac runner SSH uses code-owned LAN aliases.** The two registered `.local`
  names are resolved by Claws' `resolveLanHost()` table before SSH, shared by
  `mac-runner-waker` and Forgejo runner probes. Keep DHCP/DNS reservations
  stable for those addresses; do not add a second Secret or dotfile alias source.
- **A `SIGKILL` at the end of the grace period can cut the shutdown memory
  flush short**, losing whatever was written since the last hourly push.
- **Session pods start without the operator's ambient `gh` and Claude Code
  state.** `gh` auth for session pods and the headless service is fixed by
  #3127 and #3134. #3135 is fixed — a bare `LGTM` no longer approves anything,
  and the **Automerge** label is the only approval Claws accepts. Still open:
  #3136, and #3219 (nothing verifies *who* applied **Automerge**).
- **The 0600 `~/.ssh/id_ed25519` and `~/.kube/config` the entrypoint
  writes are still readable by same-uid agent processes.** Env stripping
  (#2837) removes the trivially scrapable copy in `process.env`, but full
  closure needs uid separation between the service and agent children.
