# auth-secret-sync

**Deep dive.** Read this when you're changing provider credential sync into
the `claws-auth` Secret. For general Kubernetes cutover state, read
../k8s-cutover.md instead.

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

The pod runs under a dedicated `claws` ServiceAccount
(`automountServiceAccountToken: true`) with a namespaced Role granting **only**
`get` and `patch` on Secrets, scoped to `resourceNames: [claws-auth]`. No
`create`, `update`, `list`, or `delete` — the job does a read-modify-write via
a `GET` of the Secret then a JSON merge patch
(`application/merge-patch+json`) of just the changed keys. If `claws-auth`
doesn't exist, the `GET` 404s, is reported once via `reportError`, and nothing
else happens (fleet-infra#1036).

`CLAWS_AUTH_SECRET_NAME` and `CLAWS_AUTH_SECRET_NAMESPACE` name the target;
`claws-auth` holds exactly two keys, `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAWS_CODEX_AUTH_JSON`.

## Talking to the API server

Both calls go through the in-process client in `src/k8s/api.ts`
(`createK8sClient({ saDir })`, injectable via `opts.client` for tests). It
authenticates only with the projected ServiceAccount token under
`/var/run/secrets/kubernetes.io/serviceaccount`, trusts that directory's
`ca.crt`, and **never loads a kubeconfig**. That is what keeps the Role above
enforced: the entrypoint once wrote `~/.kube/config` from `CLAWS_KUBECONFIG`
with the k3s cluster-admin client certificate, and a stale copy may remain on
the PVC; before #2801 the job's kubectl calls presented that certificate and
ran as `system:admin`. The token travels only as an `Authorization` header —
never argv or a temp file (#2839) — and is re-read on every request, so
kubelet's token rotation is picked up.

The image no longer ships kubectl at all; this job was its only caller.

## No-op off-cluster

If `CLAWS_AUTH_SECRET_NAME` is unset — the systemd host on openclaw, which has
no ServiceAccount token — the job returns immediately with no log line. If the
projected SA token is unreadable (also the openclaw case, and any pod not
carrying the ServiceAccount), it logs a warning and returns. Neither path
makes an API call.

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
names appear in the success log line. A failed `GET` or `PATCH` is reported
with the client's `K8sError.message`, which names only the method, path and
HTTP status (or transport error code), never a request or response body.

## Shutdown flush

`src/main.ts`'s `shutdown()` calls `run()` once, ungated by `isActive()`, so a
planned pod restart never loses a rotation that landed since the last 10-minute
tick. It's ungated because it's a no-op without `CLAWS_AUTH_SECRET_NAME`, and
because the scheduler registers zero jobs in verify-only mode — on the staging
pod, this shutdown call is the only path that ever runs the sync. No extra
`terminationGracePeriodSeconds` budget is needed: the client's calls carry a
15s timeout each, well within the existing 420s grace period's headroom.
