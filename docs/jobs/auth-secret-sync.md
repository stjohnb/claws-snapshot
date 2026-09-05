# auth-secret-sync

**Source**: `src/jobs/auth-secret-sync.ts`
**Trigger**: Interval-based
**Interval**: 10 minutes (configurable via `intervals.authSecretSyncMs`)

Writes a rotated `~/.codex/auth.json` (and, secondarily, a refreshed
`CLAUDE_CODE_OAUTH_TOKEN` from `~/.claws/env`) back into the `claws-auth`
Kubernetes Secret, so a pod restart re-materialises the *current* credential
instead of reverting to whatever the Secret held at bootstrap (#2794).

## The gap this closes

`deploy/container-entrypoint.sh` unconditionally rewrites `~/.codex/auth.json`
from `CLAWS_CODEX_AUTH_JSON` on every boot. Codex rotates the ChatGPT refresh
token inside that file in place, so without this job every restart discards
the rotation and eventually the seed token is revoked. Claude does not have
this problem: `/reauth` already persists a refreshed
`CLAUDE_CODE_OAUTH_TOKEN` to `~/.claws/env` on the PVC, and `loadEnvFile()`
(`src/env-file.ts`) makes that win over the Secret on the next boot — this job
covers Codex, and also seeds `CLAUDE_CODE_OAUTH_TOKEN` back for the case of a
fresh PVC.

Interactive Codex *sessions* use a private `CODEX_HOME` copy
(`ensureSessionCodexHome`, `src/session-env-file.ts`), but Claws task runs use
the real `~/.codex`, which is what actually rotates — only `~/.codex/auth.json`
is synced.

## RBAC contract

The pod runs under a dedicated `claws-staging` ServiceAccount
(`automountServiceAccountToken: true`) with a namespaced Role granting **only**
`get` and `patch` on Secrets, scoped to `resourceNames: [claws-auth]`. No
`create`, `update`, `list`, or `delete` — the job does a read-modify-write via
`kubectl get` then a `--type=merge` patch of just the changed keys. If
`claws-auth` doesn't exist, `get` 404s, is reported once via `reportError`, and
nothing else happens (fleet-infra#1036). That Role is only actually enforced
because `runKubectl` spawns kubectl with `KUBECONFIG=/dev/null` — see below
(#2801).

`CLAWS_AUTH_SECRET_NAME` and `CLAWS_AUTH_SECRET_NAMESPACE` name the target;
`claws-auth` holds exactly two keys, `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAWS_CODEX_AUTH_JSON`.

## Why KUBECONFIG=/dev/null, not just SA-token flags

The entrypoint writes `~/.kube/config` from `CLAWS_KUBECONFIG`, carrying the
k3s cluster-admin **client certificate**. Historically the job authenticated
with `--server`/`--certificate-authority`/`--token` override flags, but those
are merged *over* a loaded kubeconfig, not instead of it: the file's client
certificate was still presented in the TLS handshake, and the API server's
authenticator chain tries x509 before bearer tokens, so the cert wins: before
#2801 this job actually ran as `system:admin` (`system:masters`) and could
get/patch any Secret in the namespace, silently voiding the fleet-infra#1036
confinement contract. `runKubectl` therefore spawns kubectl with `env:
{ ...process.env, KUBECONFIG: "/dev/null" }`, so there is no kubeconfig to
merge. The override is scoped to this job's child processes only —
`k3s-monitor.ts` and `kubeconfig-refresh.ts` still need the cluster-admin
kubeconfig, which is also why a local wrapper is used rather than
`kubectlExec` (that one prepends `--kubeconfig`).

The job now writes a minimal `0600` kubeconfig (server, `certificate-authority`,
token, single context) into its `mkdtemp` dir and passes `--kubeconfig
<path>`, rather than putting the SA token on kubectl's argv (#2839).
`KUBECONFIG=/dev/null` is retained as defence in depth so an explicit
`--kubeconfig` flag is always required for any credential to apply — see
below.

Verified in-pod with kubectl v1.31.4: with the kubeconfig loaded, `auth
whoami` returns `system:admin` and `get secret claws-config` succeeds; with
`KUBECONFIG=/dev/null` it returns
`system:serviceaccount:default:claws-staging`, `get`/`patch secret
claws-auth` succeed, and `get secret claws-config` / `get secrets` are
Forbidden.

## No-op off-cluster

If `CLAWS_AUTH_SECRET_NAME` is unset — the systemd host on openclaw, which has
no ServiceAccount token — the job returns immediately with no log line. If the
projected SA token is unreadable (also the openclaw case, and any pod not
carrying the ServiceAccount), it logs a warning and returns. Neither path
calls `kubectl`.

## Invalid-JSON guard

Codex can be mid-rewrite of `~/.codex/auth.json` when this job reads it. The
file is JSON-parsed before it's considered for syncing; a parse failure logs a
warning and skips that key for this tick rather than pushing a torn write over
a good Secret value. The same applies to `CLAUDE_CODE_OAUTH_TOKEN`: if
`~/.claws/env` has no such line, that key is simply skipped and the Secret
stays the source of truth.

Both sides of the comparison are trimmed before diffing — the entrypoint
writes `~/.codex/auth.json` with `printf '%s\n'`, so the on-disk file carries a
trailing newline the Secret value does not, and comparing untrimmed values
would patch needlessly every tick.

## Credential handling

No value — Codex auth contents or the Claude token — is ever logged; only key
names appear in the success log line. The patch payload is written to a
`0600` file inside a `mkdtemp` directory and passed via `--patch-file` (never
inline `-p`, which some kubectl error messages echo back) and the directory is
always removed in a `finally`.

The SA token is no longer on kubectl's argv at all — it lives only in the
`0600` kubeconfig written into that same `mkdtemp` directory, removed in the
`finally` alongside the patch file — since `/proc/<pid>/cmdline` is readable
by every process sharing the pod's PID namespace (#2839). The temp directory
is now created before the `get` call, so it covers both kubectl invocations.

## Shutdown flush

`src/main.ts`'s `shutdown()` calls `run()` once, ungated by `isActive()`, so a
planned pod restart never loses a rotation that landed since the last 10-minute
tick. It's ungated because it's a no-op without `CLAWS_AUTH_SECRET_NAME`, and
because the scheduler registers zero jobs in verify-only mode — on the staging
pod, this shutdown call is the only path that ever runs the sync. No extra
`terminationGracePeriodSeconds` budget is needed: the kubectl calls carry a 20s
timeout each, well within the existing 420s grace period's headroom.
