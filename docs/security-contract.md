# Security contract

This is the canonical security contract for every St-John-Software repo. Every managed repo
declares a security policy: what it ships and runs, how dependency and image vulnerabilities
are found, where accepted findings live, how secrets reach the code, how the supply chain is
pinned, what is exposed and how it authenticates, and its Known gaps. A repo that publishes a
container image scans it before every push and blocks the push on a fixable High or Critical
finding until it is fixed or covered by an OpenVEX statement under `.vex/`.

The machine source of truth is [`src/security-contract.ts`](../src/security-contract.ts): the
starter template below, the fallback prompt block given to agents, the compliance rules, the
OpenVEX checks and the per-kind guidance are all generated from it, and a test keeps the
template on this page byte-identical to it. Claws' own policy is [`security.md`](security.md).

## Scope

No repo is exempt by type and there is no single waiver sentence: services, infra repos,
static sites, libraries, CLIs, firmware and config-only repos all declare a policy. A repo
that does not publish a container image says so in its vulnerabilities subsection, and any
subsection that does not apply opens with `does not apply` (or `none`, `not applicable`,
`n/a`) followed by a reason of at least three words; the phrase in the middle of other prose
does not count. Whether a repo is compliant is judged on the policy text alone; its workflows
are never parsed to decide it.

## Where a repo declares its policy

The scanner checks these locations in order and passes the repo when one is complete:

1. `docs/security.md` — the whole file is the policy, no heading needed.
2. A `## Security` section in `AGENTS.md` (a heading naming security, up to the next heading of
   the same or a higher level).

Headings inside fenced code are ignored, and when several headings match, the section missing
the fewest rules wins.

## Rules

One rule per subsection, plus `no-placeholders`. A subsection passes when it is present and
non-empty, has no `TODO(security):` line, and either mentions its keywords or says it does not
apply, followed by a reason of at least three words. A bare `None.` passes only for Known gaps.

| Rule | Subsection heading | Passes when the subsection mentions |
|---|---|---|
| `scope` | Scope | what the repo ships, runs or has exposed |
| `vulnerabilities` | Dependency and image vulnerabilities | scan, audit, trivy, grype or Renovate, or "no container image"; once the policy anywhere claims the repo publishes or pushes an image (and this subsection does not say it publishes none), it must also say the image is scanned before the push, that High/Critical findings block, and `.vex` |
| `accepted-findings` | Accepted findings | `.vex`, OpenVEX or `not_affected`, or none with a reason |
| `secrets` | Secrets | secrets, tokens or credentials |
| `supply-chain` | Supply chain | pinning, a lockfile or Renovate |
| `exposure` | Exposure and authentication | public, auth or network |
| `known-gaps` | Known gaps | list items, or `None.` (see [Known gaps](#known-gaps)) |
| `no-placeholders` | the whole policy | no `TODO(security):` marker remains |

The rules are deliberately loose: they check that each topic is addressed, not how well. The
PR reviewer and the doc-maintainer judge quality and truth.

## Policies describe the code as it is

Every statement a policy makes about current behaviour must be true of the repo today: its
workflows, Dockerfiles, lockfiles, `.vex/` statements and Renovate config, and its ingress and
network policy in fleet-infra or production-infra. A rule for future changes is allowed,
worded as a rule for new changes, never as current behaviour. Each place the repo falls short
is listed under Known gaps rather than claimed.

## Known gaps

The grammar is identical to the [observability contract's](observability-contract.md#known-gaps)
(the same parser, `parseKnownGaps`):

- One top-level list item per gap (`-`, `*`, `+` or `1.`); continuation and nested lines
  belong to the item above.
- A gap the repo accepts starts its item with `Accepted: <reason>` (bold is fine).
- A repo with no gaps writes `None.`. The Known gaps subsection is never waived.

## The image scan gate

A repo that publishes a container image runs a scan between `docker build` and `docker push`
in the same step, so a finding fails the step before anything is pushed:

```sh
trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
  --skip-db-update --skip-java-db-update --vex .vex/<one>.json --vex .vex/<two>.json "$img"
```

[`scripts/ci/image-scan.sh`](../scripts/ci/image-scan.sh) is the reference gate; copy it.
It:

1. validates every `.vex/*.json` with `jq`, using the same checks as `validateVexDocument`, and
   fails on any invalid statement;
2. downloads the trivy DB itself from mirror.gcr.io, ghcr.io and public.ecr.aws in turn (with
   `GITHUB_TOKEN` unset, which ghcr.io would reject). If every source fails, it prints a
   `::warning::`, writes the warning to the step summary and exits 0, so the push goes ahead
   unscanned; the weekly fleet-infra and production-infra image scans are the backstop;
3. scans each image with one `--vex` per statement file.

It never uses `set -x`, because the step's environment holds registry credentials. trivy
comes from the repo's flake devShell, pinned by `flake.lock`. trivy marks VEX support
experimental; the operator chose it anyway.

The default response to a finding is a fix: bump the base image, the dependency or the tool.
A prebuilt binary whose release lags a fix can be rebuilt from source on a fixed toolchain
(Claws' `step-cli-build` Dockerfile stage), dropped, or, only if the finding truly does not
apply, covered by a VEX statement.

## Accepted findings: OpenVEX under `.vex/`

A finding that truly does not apply is recorded as one OpenVEX document per advisory under
`.vex/`, never as a blanket statement:

```json
{
  "@context": "https://openvex.dev/ns/v0.2.0",
  "@id": "https://git.home.bstjohn.net/St-John-Software/<repo>/.vex/CVE-2026-0001",
  "author": "St-John-Software",
  "timestamp": "2026-11-05T00:00:00Z",
  "version": 1,
  "statements": [
    {
      "vulnerability": { "name": "CVE-2026-0001" },
      "products": [
        {
          "@id": "pkg:oci/<name>?repository_url=<registry>/<path>",
          "subcomponents": [{ "@id": "pkg:golang/stdlib" }]
        }
      ],
      "status": "not_affected",
      "justification": "vulnerable_code_not_in_execute_path",
      "impact_statement": "Why this finding cannot affect this image, specifically."
    }
  ]
}
```

- The product is the image as `pkg:oci/<name>?repository_url=<registry>/<path>` (for Claws,
  `pkg:oci/claws?repository_url=registry.home.bstjohn.net/st-john-software/claws`), and the
  vulnerable package's PURL goes in `subcomponents`. A product may be named by `identifiers`
  (e.g. `identifiers.purl`) instead of `@id`. A wrong PURL does not match the finding, so the
  scan still fails; a green scan proves the statement applied. Build and scan the image under
  its registry reference (as Claws' `ci.yml` and `release.yml` do), never a bare local tag
  such as `claws:ci-scan`, so the scanned image's PURL can match the product.
- `status` must be `not_affected`; `affected`, `under_investigation` and `fixed` are rejected.
- `justification` must be one of the five OpenVEX justifications:
  `component_not_present`, `vulnerable_code_not_present`,
  `vulnerable_code_not_in_execute_path`, `vulnerable_code_cannot_be_controlled_by_adversary`,
  `inline_mitigations_already_exist`.
- `impact_statement` must be non-empty and honest about why the finding does not apply here.

## `exceptions.yaml` holds only exposure and risk decisions

fleet-infra and production-infra keep `security/image-scan/exceptions.yaml` for the images
they deploy. It holds only exposure and risk decisions about third-party images. A
first-party image (`registry.home.bstjohn.net/st-john-software/*` or
`registry.bstjohn.net/*`) never gets an entry: its finding is fixed in its source repo or
covered by that repo's `.vex/`, where the source context to judge it lives.

## Guidance by repo kind

`detectRepoKind` picks which guidance a repo without a policy is shown, from file signals only
(never its workflows), first match wins: a `Dockerfile` or `Containerfile` at the root or one
level down (container service); `kustomization.yaml`, `clusters/`, `tofu/` or `*.tf` (infra);
an astro, vite or next config (static site); a `package.json` `bin`, `go.mod` or `Cargo.toml`
(CLI or library); `*.kicad_pro`, `*.scad`, `platformio.ini` or ESPHome YAML (firmware or
hardware); otherwise config-only. The kind never decides compliance.

- **Container service:** the image scan gate, `.vex/` for findings that truly do not apply,
  and base-image freshness through Renovate.
- **Infra repo:** `exceptions.yaml` holds only exposure and risk decisions; scan the images it
  deploys and its infrastructure-as-code; describe what its ingress and network policies
  expose.
- **Static site:** `npm audit` or the equivalent, the CSP and security headers it is served
  with, and no secrets in the client bundle.
- **CLI or library:** a dependency audit and a committed lockfile.
- **Firmware, hardware or config-only:** secrets and supply chain apply; the image gate does
  not.

## Placeholders

Every fill-in line of the starter template starts with `TODO(security):`. The
`no-placeholders` rule fails while any remains, so pasting the template unchanged does not
pass. Replace each with the repo's answer, or with `does not apply` and the reason.

## Starter template

## Security

This is the repo's security policy under the St-John-Software security contract.
Replace each placeholder line below with this repo's answer, or with `does not apply` and the
reason. Every statement below must be true of this repo's code and config today; word a rule
for future changes as a rule for new changes, and list each place existing code falls short
under Known gaps.

### Scope

TODO(security): what this repo ships and runs (container image, static site, library, CLI, firmware, config), where it runs, and what of it is exposed to a network.

### Dependency and image vulnerabilities

TODO(security): how dependency vulnerabilities are found (Renovate, `npm audit`, trivy, grype). A repo that publishes a container image scans the built image before every push and fails the push on a fixable High or Critical finding not covered by a `.vex/` statement: name the workflow and script that do it. A repo that publishes no container image says so here.

### Accepted findings

TODO(security): where accepted findings live: one OpenVEX `not_affected` statement per advisory under `.vex/`, with a justification and an impact statement; or `none` and why.

### Secrets

TODO(security): which secrets, tokens and credentials the code uses, where they are stored, and how they reach it at runtime.

### Supply chain

TODO(security): how dependencies, base images and CI actions are pinned (lockfile, digest, commit SHA) and how they are kept fresh (Renovate).

### Exposure and authentication

TODO(security): what is reachable from the public internet or the network and how each entry point authenticates; name the ingress and network policy in fleet-infra or production-infra.

### Known gaps

TODO(security): list every place existing code falls short of the contract or of this policy, one list item each, or write `None.`; start an accepted gap's item with `Accepted: <reason>`.

## What the daily scanner checks

The [`security-contract-scanner`](jobs/security-contract-scanner.md) job checks every managed
repo once a day:

- **Declaration.** It finds the policy in the locations above and runs the rules. When any
  fail, it files `chore: declare this repo's security policy`, listing the missing
  subsections, the guidance for the repo's kind and this starter template. A repo opts out
  only by disabling the job (`disabledJobs` in its `claws.json`).
- **Known gaps and drift.** For a repo whose policy lists unaccepted gaps, or whose code no
  longer matches what the policy claims, it files one follow-up issue,
  `chore: close this repo's known security gaps` (dedupe key `security-known-gaps`), listing
  both. While it is open the body is rewritten in place; after it is closed as not planned it
  is never re-filed, and after it is closed as completed it is re-filed only while gaps or
  drift remain.
- **Drift checks** run only against claims the policy itself makes: a policy that says the
  repo publishes an image needs a scan line before each push in the workflows; a policy that
  says it publishes none must have no push in them; a claim that actions are SHA-pinned needs
  every remote `uses:` pinned to a full commit SHA; and every `.vex/*.json` must pass the
  OpenVEX checks. A drift item whose file a Known gaps item names in backticks is already
  tracked and is dropped.

The doc-maintainer agent also checks each current-behaviour claim against the code after code
changes, and the PR reviewer flags a change that makes a claim untrue.
