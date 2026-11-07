# SSH certificates in Claws

**Reference**

Read this when changing how Claws sessions, agent pods or SSH jobs authenticate to fleet hosts, or when adding an SSH host to Claws.

The fleet's SSH certificate authority (step-ca), its provisioners and principals, how humans get a certificate, CA rotation and break-glass access are documented once, in fleet-infra's [`docs/ssh-ca.md`](https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/docs/ssh-ca.md). Host-side trust (`ssh-ca.nix`, host certificates, the paper break-glass key) is in nixos-config's `docs/ssh-ca.md`, and prod's in production-infra's `docs/tailnet-access.md`. This page covers only Claws' side (#clw_01M4TVENKC78XCG6CX2VDCEEEE).

## How Claws gets certificates

Claws signs with the `claws` JWK provisioner, configured by three env vars: `CLAWS_STEP_CA_URL`, `CLAWS_STEP_CA_ROOT` and `CLAWS_STEP_PROVISIONER_PASSWORD_FILE`. fleet-infra must set them, mount the provisioner password and allow egress to `step-ca:9000` on **both** Claws workloads. The controller StatefulSet renews certificates and runs the SSH jobs. The `claws-web` Deployment issues certificates for live grants from the dashboard and at session launch (#clw_01M64REW6QVVASEW2TRG7TRD1V). With any of them unset in a process, that process issues nothing: `ssh:*` grants fail and SSH jobs skip their hosts with a warning. `src/ssh-ca.ts` generates each key with `ssh-keygen` and signs it with the `step` CLI shipped in the image.

- **Sessions.** Each `ssh:<alias>` grant gets its own fresh key and a 15-minute certificate for that host's `access-<host>` principal only, written to the session's `ssh-host-<alias>` / `ssh-host-<alias>-cert` Secret slots. The controller re-issues every held alias every 5 minutes; a revoke empties that alias's slots and the pod drops the files within about 2 s. Because a revoke runs on the web tier, the renewal pass re-reads the held aliases from the database before and after issuing, writes only if the Secret's `resourceVersion` is unchanged, and empties the filled slots of any alias the session no longer holds. The pod writes a `Host <alias>` block per granted alias to `/run/claws/ssh/config`, which the image includes from `/etc/ssh/ssh_config.d/50-claws.conf`. No session or agent pod ever receives the service's own SSH key.
- **Prod.** `ssh:prod-cluster` and `ssh:prod-data` connect as root to the node's MagicDNS name (`CLAWS_PROD_*_TAILNET_HOST`) through the cluster's tailnet SSH egress proxy, on port 22 (`PROD_SSH_PORT` in `src/capabilities.ts`).
- **Background jobs.** runner-monitor, mac-runner-waker and the connectivity check each get a fresh key and a 10-minute certificate per run for only the hosts they touch (`withJobSshIdentity`). The config's `identityFile` is ignored.
- **Host verification.** Every pod built from the image trusts the fleet host CA through one `@cert-authority` line in `/etc/ssh/ssh_known_hosts` (`deploy/ssh-known-hosts`, copied from nixos-config's `ssh-ca/known_hosts`), and Claws' own SSH always uses `StrictHostKeyChecking=yes`. A Mac that `resolveLanHost` rewrites to its LAN IP is verified with `HostKeyAlias <slug>.local`, a principal in its host certificate, since the certificate carries no IP principal.

## Adding an SSH host to Claws

1. Allow `access-<host>` in the `claws` provisioner and give the host its TCP 22 egress rule (fleet-infra `docs/ssh-ca.md#adding-a-principal-or-host`).
2. Map `access-<host>` to the login user and sign the host's key (nixos-config `ssh-ca.nix` and `scripts/sign-host-key.sh`; `bootstrap/mac-bootstrap.sh` on a Mac).
3. Add the alias to `HOME_SSH_TARGETS` in `src/capabilities.ts` (a home host also needs its `SSH_HOST_CAPABILITIES` entry; a Mac comes from `macRunners`). New sessions list the alias's slots at launch; a running session needs a resume to see a new alias.

## Rotating the host CA

Add the new `@cert-authority` line to `deploy/ssh-known-hosts` next to the old one (as nixos-config does in `ssh-ca/known_hosts`), release Claws, and remove the old line only after every host presents a certificate from the new CA. A user-CA or provisioner-password rotation needs no Claws change beyond the updated `step-ca-claws` Secret.
