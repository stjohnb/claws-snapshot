# dependabot-config-scanner

**Source**: `src/jobs/dependabot-config-scanner.ts`
**Trigger**: Via `scanner-dispatcher` (daily schedule)

Ensures every managed repo has a dependency-update mechanism covering all of its
dependency manifests. Repos with no mechanism — or with a `dependabot.yml` that
misses some manifests — get a deduped `Priority` alert issue containing the exact
YAML to add.

This closes a gap the adjacent jobs leave open: `dependabot-alert-monitor` only
reports on repos where Dependabot scanning is *already* enabled, so a repo with
nothing configured is invisible to it. Note that Dependabot **alerts** are an org
default and arrive without any config; **version updates** are what
`.github/dependabot.yml` enables. The two are not the same thing.

The motivating case is St-John-Software/bin-scraper#201: Express pinned at
`4.17.1` (2019) with high-severity advisories reachable from unauthenticated
routes, drifting for years because the repo had no update mechanism.

## Detection rule

`scan` returns "compliant" (no issue) at the first of these that applies:

1. `.claws/dependency-updates-optout` exists.
2. No dependency manifests are detected.
3. A Renovate config exists (`renovate.json`, `renovate.json5`, `.renovaterc`,
   `.renovaterc.json`, `.github/renovate.json`, `.github/renovate.json5`,
   `.gitlab/renovate.json`).
4. `.github/dependabot.yml` (or `.yaml`) covers every detected pair — or cannot
   be parsed, which logs a `log.warn` and files nothing. An alert is never raised
   off a file that could not be read.

Otherwise it files an issue: **full** (no mechanism at all) or **partial**
(config exists but omits pairs).

## Ecosystem detection

The repo is walked to a **max depth of 3**, skipping `.git`, `node_modules`,
`vendor`, `dist`, `build`, `target`, `coverage`, `.venv`, `venv`, `__pycache__`,
`.next`, `.tox`, `.gradle`, `Pods` and `.expo`. Each manifest registers its
containing directory.

| Filename | Ecosystem |
|---|---|
| `requirements.txt`, `pyproject.toml`, `Pipfile` | `pip` |
| `go.mod` | `gomod` |
| `Cargo.toml` | `cargo` |
| `Gemfile` | `bundler` |
| `pom.xml` | `maven` |
| `build.gradle`, `build.gradle.kts` | `gradle` |
| `composer.json` | `composer` |
| `Dockerfile`, `Dockerfile.*` | `docker` |
| `*.csproj`, `*.sln` | `nuget` |
| `Package.swift` | `swift` |
| `*.tf` | `terraform` |
| `package.json` | `npm` — see below |

These are Dependabot's exact `package-ecosystem` identifiers (`gomod`, not
`golang`; `pip`, not `python`). An unknown value makes Dependabot reject the file.

`github-actions` is special-cased rather than walked: if `.github/workflows/`
holds at least one `.yml`/`.yaml`, it registers at **`/`**. Dependabot resolves
workflow files relative to the repo root, so `/.github/workflows` would produce a
config Dependabot silently ignores.

## Coverage is per (ecosystem, directory)

Comparing at ecosystem level alone is unsafe. In `bonkus`, `apps/mobile` is an
independent npm project with its own lockfile; a `dependabot.yml` covering `npm`
at `/` would mark the repo fully covered while the iOS build drifts unwatched —
reproducing the bin-scraper failure mode. Every directory string, detected or
parsed, is normalized (POSIX, leading slash, no trailing slash, root as `/`)
before comparison.

## npm is anchored on lockfiles, not manifests

An npm directory is registered only if it **owns a lockfile**
(`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `npm-shrinkwrap.json`) **or**
no other `package.json` sits in an ancestor directory.

Workspace members are the reason. `bonkus`'s root `package.json` declares
`workspaces: ["packages/*"]`, so `packages/game-client` and `packages/game-core`
have no lockfiles of their own — they are covered by the root. Emitting entries
for them yields a config Dependabot errors on ("no lockfile found"). The
lockfile is the discriminator; `bonkus` correctly resolves to `/` and
`/apps/mobile` only.

The `workspaces` key is deliberately **not** parsed — glob semantics across
npm/yarn/pnpm are a rabbit hole with worse accuracy than the signal Dependabot
itself uses.

**Accepted trade-off**: a repo with `/package.json` and `/sub/package.json` and no
lockfiles anywhere registers only `/`. Conservative under-reporting beats emitting
an entry Dependabot errors on.

## Deliberate conservatism

- An entry using `directories:` (which supports globs like `/apps/*`) marks that
  ecosystem covered **everywhere**. Implementing glob matching would be a
  false-positive generator.
- A Renovate config exempts the repo outright; Renovate auto-detects all
  ecosystems by default, so any coverage check against it is a guaranteed false
  positive.
- A `pyproject.toml` holding only tool config (e.g. `ruff`) still registers
  `pip`. Accepted — Dependabot handles it harmlessly.
- A manifest deeper than depth 3 is missed.

## Generated config

`renderUpdateEntries` builds YAML by hand (not `yaml.stringify`) for fixed
formatting, matching the house style in `namey`'s `.github/dependabot.yml`.
Entries are sorted by ecosystem, then directory with `/` first. Each uses a
`weekly` schedule and `open-pull-requests-limit: 5`.

The `groups` block is load-bearing, not cosmetic: `src/agents/auto-merger.ts`
exempts Dependabot PRs from the LGTM requirement, so ungrouped weekly updates
across several entries would auto-merge as a flood.

## Opt-out

Two escape hatches, both documented in every issue the scanner files:

- Commit an empty `.claws/dependency-updates-optout` (sibling convention to
  `.claws/dependabot-deferrals.json`, used by `dependabot-alert-monitor`).
- Add `"dependabot-config-scanner"` to `disabledJobsByRepo["<repo>"]` in the
  Claws config, which the `scanner-dispatcher` filter honours.

## Implementation notes

- Issue title: `Alert: missing dependency-update configuration`
- `searchQuery` equals `issueTitle` exactly for dedupe via
  `gh.findIssueByExactTitle`
- Standard `ScannerSpec`/`runRepoScanner`; `scan` is synchronous and filesystem-only
- Does not create worktrees, PRs, or invoke Claude. The filed issue flows through
  the normal `issue-dispatcher` → `issue-refiner` → `issue-worker` pipeline to
  produce the PR
