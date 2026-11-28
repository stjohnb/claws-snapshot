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
digest), and the Dockerfile `ARG` pins its `customManagers` regexes track: the
`step-cli-build` and `gh-build` stages. Prebuilt binaries whose release lags a fix are rebuilt instead: the
`step-cli-build` stage compiles step-cli, and the `gh-build` stage compiles gh, from their pinned release commits on a fixed Go with
vulnerable modules bumped (both share one `X_NET_VERSION`). A `gh` release and its commit are tracked by Renovate too. Renovate's `step-cli` group moves the step-cli release, its commit
and the module pins together, so a fixed step-cli release or a fixed module surfaces as a
PR.

### Accepted findings

Accepted findings live under `.vex/`, one OpenVEX document per advisory, each statement
`not_affected` with one of the five OpenVEX justifications and an impact statement saying why
the finding does not apply to Claws. `scripts/ci/image-scan.sh` and `validateVexDocument`
(`src/security-contract.ts`, run over `.vex/` by `src/security-contract.test.ts`) reject any
other status, a missing justification or an empty impact statement. One is accepted today:
`.vex/CVE-2026-97054.json` covers the Go 1.27.3 standard library in the session shell's fzf 0.75.0
and direnv 2.38.2 binaries, because the advisory needs a `net/http` HTTP/1 server using
`MaxBytesReader` and fzf links no `net/http` while direnv uses it only as a client. Remove it
once the session shell ships Go 1.27.4 or later. Claws' findings are never accepted
through fleet-infra's `security/image-scan/exceptions.yaml`.

### Secrets

The Forgejo admin token also backs a names-only Actions secrets read (`claws_forgejo_actions_secrets`) served by the service: it parses only secret names, never values, and the token never reaches a caller.

Claws' credentials reach its pods as Kubernetes Secrets, read as environment variables
(`secretKeyRef`, `envFrom`) or mounted files by fleet-infra `clusters/my-cluster/claws/statefulset.yaml`:
the Forgejo service, admin and read tokens, the database password, the Authentik OIDC client
secret, the S3 keys, the GitHub App keys, the step-ca provisioner password and the
`claws-service` Authentik app password Claws signs in to Grafana with. That last one is a mounted
file (`CLAWS_AUTHENTIK_CREDENTIALS_DIR`), not env, because agent pods inherit the Claws pod's env; only planner (`issue-refiner:*`) agent
pods get a copy of it, in their launch spec, so a headless planner can sign in too;
a `fleet-observability` grant passes it to a session as `CLAWS_FLEET_GRAFANA_AUTH`, a credential
that stays valid until the app password is rotated (#clw_01M7QFE3ZDE06M6JW202445NPX). Those committed
to fleet-infra are SOPS-encrypted (`*.enc.yaml`, decrypted by Flux); `claws-auth`, which holds
the rotating model-provider credentials, is created in the cluster and never committed in any
form. No secret is committed to this repo in plain text. Agent and session pods are
default-deny for secrets: a capability grant re-adds selected values from a 0600 file so
credentials never appear in argv (`docs/OVERVIEW.md`, capability gating).
Log output carries no secrets, tokens or credentials (`docs/observability.md`).

Operator AWS access reaches a session only through an operator-approved `aws-admin`,
`aws-ops` or `aws-viewer` grant (#clw_01M8426RTMG1TWE224NXW1V02S, `src/aws-access.ts`).
Claws runs the IAM Identity Center device sign-in itself, from the web pod, with a public
OIDC client registered for the device-code grant only; it calls SSO `Logout` straight
after `GetRoleCredentials`, discards any refresh token unread, and holds the client
secret, device code and access token only in memory for the sign-in. It keeps no SSO
token, and no AWS credential is written to the database or any log. The one-hour role
credentials sit in the session's own Secret (`aws-credentials`, mounted read-only beside
`granted-env` and named by `AWS_SHARED_CREDENTIALS_FILE`) for at most their lifetime:
the controller revokes the grant at expiry, and a revoke, the session's release or the
session's end empties the slot. Credentials the agent has already read stay valid until
they expire, at most an hour. A relaunch of a running session, including a move to
another node, copies a still-active grant's file into its new Secret; nothing else does,
and a relaunch that cannot carry it ends the grant (`relaunched`). Every grant, failed
sign-in and end is a `session_aws_grants` row kept as the audit record.

Claws stores no SOPS age private key and offers no capability that delivers one to a
session or agent; encrypting a secret needs only a repository's public recipient.

### Supply chain

- npm dependencies are locked by the committed `package-lock.json` and installed with
  `npm ci`; Renovate proposes bumps. `playwright-core` is a runtime dependency for the
  wall explorer's capture (`src/wall-explorer.ts`): the client library only, connecting to the
  shared browserless service over CDP, so it downloads no browser and runs no install script.
  The wall explorer's agent browser is `@playwright/mcp` pinned to an exact version
  (`PLAYWRIGHT_MCP_PINNED`), not `@latest`.
- Every remote GitHub Action in `.forgejo/workflows/` is SHA-pinned to a full 40-character
  commit SHA, with the version in a trailing comment; local actions (`./.github/actions/...`)
  are exempt.
- The CI toolchain (node, trivy, docker client, jq) comes from `flake.nix`, pinned by
  `flake.lock`.
- Agent and session pod Nix (`/etc/nix/nix.conf` in the `Dockerfile`) trusts two signing
  keys: `cache.nixos.org-1`, and `bonkus-ci-1` for bonkus's Rust dev shell, which bonkus's
  `nix-cache-push.yml` uploads to the in-cluster `nix-cache` so fresh pods skip a
  14-minute toolchain download (#clw_01M7TVE3PT454WJP70VD0325XB). The `bonkus-ci-1` secret
  is the SSM SecureString `/bonkus/nix-cache-signing-key` (us-east-1), readable only by
  aws-account's `ci-bonkus-cache-signing` role, whose only trusted subject is
  `repo:St-John-Software/bonkus:ref:refs/heads/main`; it is separate from nixos-config's
  `nixos-config-ci-2`, which dashpi trusts as root. A path signed by `bonkus-ci-1` is
  therefore one a reviewed bonkus `main` push built. The image smoke step asserts the key
  is configured.
- The Dockerfile's base images (`node:26.13.1-bookworm-slim`, `golang:1.27.4-bookworm`) are
  pinned by tag and multi-arch index digest (`tag@sha256:…`), and Renovate bumps both
  (`pinDigests`). The step-cli source is pinned to its release commit (`STEP_CLI_COMMIT`), and
  its module bumps (`GO_JOSE_VERSION`, `KLAUSPOST_COMPRESS_VERSION`, `X_NET_VERSION`) are
  checked against sum.golang.org; Renovate tracks all of them.
- The runtime stage runs `apt-get upgrade`, and CI and release pass `APT_REFRESH` (the UTC
  date) so the apt layer is rebuilt daily rather than served from the runner's Docker cache.
- `gh` is rebuilt from source in the `gh-build` stage like step-cli: pinned to its release
  commit (`GH_COMMIT`), built with the shared `X_NET_VERSION` bump, and its tag and commit
  are tracked by Renovate.
- `release.yml` resolves each agent CLI (`@anthropic-ai/claude-code`, `@openai/codex`,
  `opencode-ai`, `@earendil-works/pi-coding-agent`) to an exact npm version, passes it to
  the Dockerfile as a build arg, and records all four in the release notes.

### Exposure and authentication

- `claws.home.bstjohn.net` (fleet-infra `apps/claws/ingress.yaml`, Traefik `websecure`) serves
  the dashboard, reached over the tailnet; people sign in through Authentik OIDC.
- Claws has no public host. Prod consumers read the public JWKS mirror
  `https://www.bstjohn.net/claws-jwks/jwks.json`, and Claws polls prod Alertmanager; prod
  initiates no connection home.
- Agent and session pods reach the claws-state MCP server with a per-run bearer token.
- Session pods holding `home-assistant-read` reach `/api/ha-read/*` on the web tier with a
  per-session HMAC bearer token (`src/ha-read-token.ts`), valid only while the session is
  open and holds the capability. The route (`src/ha-read-proxy.ts`) forwards only an
  allowlist of Home Assistant GET endpoints with the server-held token and no client
  headers, answering 405 to any other method and 403 to any other path, so the session
  never holds the Home Assistant token and cannot write. The web tier's egress to Home
  Assistant (`192.168.0.251:8123`) is in `claws-web-isolation`.
- Session pods holding a `datasette:<db>` capability reach `/api/datasette/*` on the web
  tier with a per-session HMAC bearer token (`src/datasette-token.ts`), valid only while the
  session is open; each request is checked against the `datasette:*` capabilities the
  session holds then (cached 30 s). The route (`src/datasette-proxy.ts`) forwards only GET
  JSON reads (`/<db>.json`, `/<db>/<table>.json`, `/<db>/<table>/<pk>.json`) of a database
  that is both granted and in `CLAWS_DATASETTE_DATABASES`, to the in-cluster Datasette
  Service with no client headers and no credential, answering 405 to any other method and
  403 to any other path or database (`/-/...` and `_memory` included). The served files
  are Datasette's redacted nightly exports; redaction is enforced there, not in the proxy.
- Session pods holding `prod-mail-read` reach `/api/mail-read/*` on the web tier with a
  per-session HMAC bearer token (`src/mail-read-token.ts`), valid only while the session is
  open and holds the capability (cached 30 s); the capability always needs operator
  approval. The mailbox login (`CLAWS_MAIL_READ_PASSWORD`, Secret `claws-mail-reader`) is
  held only by the web tier and is in `SENSITIVE_ENV_KEYS`, so no session or agent env
  carries it. The route (`src/mail-read-proxy.ts`) answers 405 to any method but GET and
  reads over IMAP with STARTTLS required, opening folders with EXAMINE and fetching with
  `BODY.PEEK`; read-only is enforced server-side by the reader login's Dovecot ACL (`lr`),
  which refuses flag changes, copies, moves, appends and expunges. Rotation is in
  production-infra `docs/email.md` ("Credential rotation"). The web tier's egress to the
  prod-data node on tcp/143 is in `claws-web-isolation`.
- `/api/nodes/:node/evacuation` (either tier, no dashboard login) moves every session off a
  session node. Its caller is a machine signed in to Authentik as a listed service account
  (`nas-claws-evacuation`) through the client-credentials grant of the `claws-api` provider,
  sending the 5-minute access token as a bearer; Claws holds no copy of the account's secret
  (#clw_01M7RC7NY8JM8T76FKNBVK53ND). `src/machine-auth.ts` accepts only RS256, verifies the
  signature against the issuer's JWKS (cached by `kid`, refetched at most once a minute, last
  good set kept on a failed fetch), and requires `iss` = `CLAWS_MACHINE_AUTH_ISSUER`, `aud`
  containing `CLAWS_MACHINE_AUTH_AUDIENCE` and an unexpired `exp`; a token whose `groups` lack
  the `node-evacuation` grant in `CLAWS_MACHINE_API_GRANTS` gets 403. The route is off (404)
  without the issuer, audience or grant, or for a node outside `CLAWS_SESSION_NODES`, and
  answers 503 when no signing key could ever be loaded. Outpost `X-authentik-*` headers are not
  trusted, because agent and session pods reach port 3000 directly. A token can only start,
  read or clear an evacuation: it reads no session content and grants no access. The three
  settings are kept out of agent pods (`ENV_DENY_PREFIXES`), and the retired shared bearer
  stays stripped from agent and session environments
  (`src/sensitive-env.ts`).
  Each move's two copy pods share a per-move random bearer from their own Secret, deleted
  with them, and the receiver accepts a single upload.
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
- Accepted: only part of the PR-head code that runs in a managed repo's plan job is gated.
  An edit to a tofu-named workflow, or to a repo's plan-publishing scripts (the
  `PLAN_PUBLISHING_PATHS` list in `src/tofu-plan.ts`: production-infra
  `scripts/summarize-plan.sh`, fleet-infra `scripts/tofu-plan-comment.sh` and the code that
  posts the comment), waits for the board's per-head infra approval
  (#clw_01M7NKT2H402M07VGCAE1TBX8G, #clw_01M7NR1KKSPCEZ5VKSWGD27V8E). Other head code the
  plan job runs (the devShell `flake.nix`, setup actions, the production-infra and bstjohn-blog
  destroy guard `scripts/assert-no-destroy.sh`) is not: gating all of it would hold most
  infra-repo PRs behind the button, so the head's Claws review covers it. A renamed or moved publishing script drops out of the list until it is
  updated.
