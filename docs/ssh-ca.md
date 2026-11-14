# SSH certificates in Claws

**Reference**

Read this when changing how Claws sessions, agent pods or SSH jobs authenticate to fleet hosts, or when adding an SSH host to Claws.

The fleet's SSH certificate authority (step-ca), its provisioners and principals, how humans get a certificate, CA rotation and break-glass access are documented once, in fleet-infra's [`docs/ssh-ca.md`](https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/docs/ssh-ca.md). Host-side trust (`ssh-ca.nix`, host certificates, the paper break-glass key) is in nixos-config's `docs/ssh-ca.md`, and prod's in production-infra's `docs/tailnet-access.md`. This page covers only Claws' side (#clw_01M4TVENKC78XCG6CX2VDCEEEE).

## How Claws gets certificates

Claws signs with the `claws` JWK provisioner, configured by three env vars: `CLAWS_STEP_CA_URL`, `CLAWS_STEP_CA_ROOT` and `CLAWS_STEP_PROVISIONER_PASSWORD_FILE`. fleet-infra must set them, mount the provisioner password and allow egress to `step-ca:9000` on **both** Claws workloads. The controller StatefulSet runs the SSH jobs. Whichever workload serves the session signing route (`POST /api/sessions/:sid/ssh/:alias/sign`, normally `claws-web`) signs session keys (#clw_01M64REW6QVVASEW2TRG7TRD1V, #clw_01M78063FGCMSJVSGS7ZDV1Z9C). With any of them unset in a process, that process signs nothing: the signing route answers 503, so a session's ssh fails with `Permission denied (publickey)`, and SSH jobs skip their hosts with a warning. `src/ssh-ca.ts` signs with the `step` CLI shipped in the image; for a job it first generates the key with `ssh-keygen`.

- **Sessions.** Certificates are signed on demand, never in the background (#clw_01M78063FGCMSJVSGS7ZDV1Z9C). Each `ssh:<alias>` grant fills the session's `ssh-grant-<alias>` Secret slot, and the pod writes a `Match originalhost <alias>,<hostName> exec` hook and a `Host <alias>` block to `/run/claws/ssh/config`, which the image includes from `/etc/ssh/ssh_config.d/50-claws.conf`. Before each ssh to that host the hook runs the refresh helper (`dist/session-pod/ssh-refresh.js`). On first use the helper makes the pod's own ed25519 key in `/run/claws/ssh`. When the certificate is missing or has under 2 minutes left, it posts the public key to `POST /api/sessions/:sid/ssh/:alias/sign` with the session's own MCP token. Claws re-checks that the session is live and holds `ssh:<alias>`, then signs a 15-minute certificate for that host's `access-<host>` principal only, with key ID `claws-session-<id>-<alias>`. It accepts only ed25519 keys and allows one signing per session and host per minute. The private key never leaves the pod. A revoke empties the grant slot; within about 2 s the pod drops the host's block, key and certificate, and the route refuses to sign it again. Nothing calls the CA at launch or on a grant, so a grant succeeds while step-ca is down and the failure shows at the first ssh. No session or agent pod ever receives the service's own SSH key.
- **Pods launched before on-demand signing.** Their Secret-delivered certificates are no longer renewed and lapse within 15 minutes of the deploy. A new `ssh:*` grant to one is recorded for its next resume, which relaunches it with grant slots and the helper. This lapse broke a running session on 2026-11-12, and resuming the session is the fix (#clw_01M78ASKF97TSV2VYKF7CFN7A6).
- **Prod.** `ssh:prod-cluster` and `ssh:prod-data` connect as root to the node's MagicDNS name (`CLAWS_PROD_*_TAILNET_HOST`) through the cluster's tailnet SSH egress proxy, on port 22 (`PROD_SSH_PORT` in `src/capabilities.ts`).
- **Background jobs.** runner-monitor, mac-runner-waker and the connectivity check each get a fresh key and a 10-minute certificate per run for only the hosts they touch (`withJobSshIdentity`). The config's `identityFile` is ignored.
- **Host verification.** Every pod built from the image trusts the fleet host CA through one `@cert-authority` line in `/etc/ssh/ssh_known_hosts` (`deploy/ssh-known-hosts`, copied from nixos-config's `ssh-ca/known_hosts`), and Claws' own SSH always uses `StrictHostKeyChecking=yes`. A Mac that `resolveLanHost` rewrites to its LAN IP is verified with `HostKeyAlias <slug>.local`, a principal in its host certificate, since the certificate carries no IP principal.

## Signing volume

A session signs a host's certificate only when it runs ssh to that host and the current certificate is missing or within 2 minutes of expiry. A host in continuous use is therefore signed about every 13 minutes, at most about 4.6 times an hour, and an idle session signs nothing. The fleet's `SSH CA Signing Volume Spike` alert fires above 300 `claws` signings an hour, which leaves room for roughly 60 hosts in continuous use at once, alongside the background jobs' one signing per run. Before on-demand signing, a 5-minute controller loop re-signed every held host of every open session, about 288 certificates per host per day whether the session was used or not.

## Adding an SSH host to Claws

1. Allow `access-<host>` in the `claws` provisioner and give the host its TCP 22 egress rule (fleet-infra `docs/ssh-ca.md#adding-a-principal-or-host`).
2. Map `access-<host>` to the login user and sign the host's key (nixos-config `ssh-ca.nix` and `scripts/sign-host-key.sh`; `bootstrap/mac-bootstrap.sh` on a Mac).
3. Add the alias to `HOME_SSH_TARGETS` in `src/capabilities.ts` (a home host also needs its `SSH_HOST_CAPABILITIES` entry; a Mac comes from `macRunners`). New sessions list the alias's slots at launch; a running session needs a resume to see a new alias.

## Rotating the host CA

Add the new `@cert-authority` line to `deploy/ssh-known-hosts` next to the old one (as nixos-config does in `ssh-ca/known_hosts`), release Claws, and remove the old line only after every host presents a certificate from the new CA. A user-CA or provisioner-password rotation needs no Claws change beyond the updated `step-ca-claws` Secret.
