# Claws security

Claws' own security policy under the [security contract](security-contract.md). The whole
file is the policy. Keep it accurate as the workflows, the Dockerfile, dependencies and the
deployment change: every statement below describes the repo as it is today, and each
shortfall is listed under Known gaps.

## Security

### Scope

Claws ships one container image, `registry.home.bstjohn.net/st-john-software/claws`, built
from this repo's `Dockerfile` by `.forgejo/workflows/release.yml`. It runs in the home/fleet
cluster as the `claws` StatefulSet (controller) and the `claws-web` Deployment (dashboard),
plus short-lived agent and session pods in `claws-sessions` started from the same image. Its
manifests, ingress and network policies live in fleet-infra (`apps/claws/`,
`clusters/my-cluster/claws/`). The dashboard and a small machine-to-machine API are exposed
over HTTPS (see Exposure and authentication).

### Dependency and image vulnerabilities

Claws publishes a container image, and `release.yml` scans the built image before every push:
in both "Build and push image" steps, `docker build` is followed by
`scripts/ci/image-scan.sh "$IMAGE:$TAG"` (trivy from the flake's `scripts` devShell,
`--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`), and `docker push` runs only after
it passes. A fixable High or Critical finding not covered by a `.vex/` OpenVEX statement
fails the step, skips the build retry, and fails the job with nothing pushed.

`.forgejo/workflows/ci.yml`'s `docker-build` job runs the same script on the image it builds,
so a PR that changes the `Dockerfile`, `deploy/**`, `.vex/`, the scan script, `package.json`
or `package-lock.json` sees findings before merge.

When the trivy vulnerability DB cannot be downloaded from any mirror (mirror.gcr.io, ghcr.io,
public.ecr.aws), the script prints a `::warning::`, writes it to the step summary and lets the
push go ahead unscanned; fleet-infra's weekly image scan of everything it deploys, Claws
included, is the backstop.

Renovate (`renovate.json`) opens PRs for npm dependencies, Dockerfile base images (tag and
digest), and the Dockerfile `ARG` pins its `customManagers` regexes track: `gh` and the
`step-cli-build` stage. Prebuilt binaries whose release lags a fix are rebuilt instead: the
`step-cli-build` stage compiles step-cli from its pinned release commit on a fixed Go with
vulnerable modules bumped. Renovate's `step-cli` group moves the step-cli release, its commit
and the module pins together, so a fixed step-cli release or a fixed module surfaces as a
PR.

### Accepted findings

Accepted findings live under `.vex/`, one OpenVEX document per advisory, each statement
`not_affected` with one of the five OpenVEX justifications and an impact statement saying why
the finding does not apply to Claws. `scripts/ci/image-scan.sh` and `validateVexDocument`
(`src/security-contract.ts`, run over `.vex/` by `src/security-contract.test.ts`) reject any
other status, a missing justification or an empty impact statement. There are none today: the
image has no fixable High or Critical finding to accept. Claws' findings are never accepted
through fleet-infra's `security/image-scan/exceptions.yaml`.

### Secrets

Claws' credentials reach its pods as Kubernetes Secrets, read as environment variables
(`secretKeyRef`, `envFrom`) or mounted files by fleet-infra `clusters/my-cluster/claws/statefulset.yaml`:
the Forgejo service, admin and read tokens, the database password, the Authentik OIDC client
secret, the S3 keys, the GitHub App keys and the step-ca provisioner password. Those committed
to fleet-infra are SOPS-encrypted (`*.enc.yaml`, decrypted by Flux); `claws-auth`, which holds
the rotating model-provider credentials, is created in the cluster and never committed in any
form. No secret is committed to this repo in plain text. Agent and session pods are
default-deny for secrets: a capability grant re-adds selected values from a 0600 file so
credentials never appear in argv (`docs/OVERVIEW.md`, capability gating).
Log output carries no secrets, tokens or credentials (`docs/observability.md`).

### Supply chain

- npm dependencies are locked by the committed `package-lock.json` and installed with
  `npm ci`; Renovate proposes bumps.
- Every remote GitHub Action in `.forgejo/workflows/` is SHA-pinned to a full 40-character
  commit SHA, with the version in a trailing comment; local actions (`./.github/actions/...`)
  are exempt.
- The CI toolchain (node, trivy, docker client, jq) comes from `flake.nix`, pinned by
  `flake.lock`.
- The Dockerfile's base images (`node:26.13.0-bookworm-slim`, `golang:1.27.3-bookworm`) are
  pinned by tag and multi-arch index digest (`tag@sha256:…`), and Renovate bumps both
  (`pinDigests`). The step-cli source is pinned to its release commit (`STEP_CLI_COMMIT`), and
  its module bumps (`GO_JOSE_VERSION`, `KLAUSPOST_COMPRESS_VERSION`, `X_NET_VERSION`) are
  checked against sum.golang.org; Renovate tracks all of them.
- `gh` is installed at the exact `GH_VERSION` from the `cli/cli` GitHub release `.deb`,
  verified against that release's checksums file, and bumped by Renovate.
- `release.yml` resolves each agent CLI (`@anthropic-ai/claude-code`, `@openai/codex`,
  `opencode-ai`, `@earendil-works/pi-coding-agent`) to an exact npm version, passes it to
  the Dockerfile as a build arg, and records all four in the release notes.

### Exposure and authentication

- `claws.home.bstjohn.net` (fleet-infra `apps/claws/ingress.yaml`, Traefik `websecure`) serves
  the dashboard, reached over the tailnet; people sign in through Authentik OIDC.
- `claws.ext.bstjohn.net` is the only public host: path-scoped to `/api/alert-bridge/`, which
  authenticates each alert bridge by its own bearer token, and the public
  `/.well-known/claws-jwks.json`. Every other path returns 404.
- Agent and session pods reach the claws-state MCP server with a per-run bearer token.
- Network policies (fleet-infra `clusters/my-cluster/claws/`): `claws-web-isolation` admits
  Traefik, the agent and session pods, and Prometheus (metrics port); `claws-isolation` admits
  only `claws-web`, the agent and session pods, Gatus and Prometheus; both restrict egress.

### Known gaps

- Accepted: the agent CLIs' transitive dependency trees are resolved by npm when
  `release.yml` builds the image, not locked in a reviewed lockfile, so a release can pull
  dependency versions no PR reviewed. Each CLI is an exact, recorded version, the daily
  Claude Code release flow (#3088) depends on picking up new CLI versions without a PR, and
  the image scan gate scans the resolved tree before every push.
- Accepted: `claws-session-shell` is pulled as `:latest`. It is first-party, built by
  nixos-config from its reviewed `flake.lock`, Renovate is deliberately disabled for the
  LAN registry images, and the image scan gate scans the store copied from it.
- Accepted: the Debian packages come from apt at whatever version is current at build time.
  Pinning Debian package versions breaks builds once the mirror drops an old version and
  holds back security updates; the image scan gate checks every build.
- Accepted: a trivy DB outage lets a push through unscanned, with a loud warning; the operator
  chose this over blocking releases on a mirror outage, and fleet-infra's weekly scan is the
  backstop.
