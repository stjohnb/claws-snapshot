# Label audit — 2026-08-12

**Deep dive.** Read this when you need real usage counts for a GitHub label
before adding, removing, or deleting one. For the mechanics of label
sync/cleanup itself, see modules.md's `repo-standards` entry instead.

Method: counts from `gh label list --limit 200` plus `gh issue list`/`gh pr list --state all --limit 1500 --json labels` per repo, run 2026-08-12. Counts include issues **and** PRs; every repo was fully enumerated (largest: `claws` 1207 issues / 1225 PRs), so "0 uses" means genuinely never used.

## Why the labels exist

Nothing in Claws applies `enhancement`. Every label Claws applies comes from `LABELS`/`LABEL_SPECS` (`src/config.ts`) except one ad-hoc name (`runner-maintenance`, now removed — see below). `enhancement` is one of GitHub's nine default labels created at repo creation; an interactive Claude session in `nixos-config` picked it off `gh label list` because it was already there. The label existing was the whole instruction — any label present in a repo is a standing invitation to every agent running `gh issue create --label`.

Fleet-wide label sources:

1. `repo-standards` (`src/jobs/repo-standards.ts`) force-creates all 14 `LABEL_SPECS` keys daily in every repo with a local clone.
2. GitHub's nine defaults at repo creation.
3. Dependabot (`dependencies`, `javascript`, `python`, `docker`, `java`, `github_actions`).
4. Repo-local workflows / Grafana.
5. Claws' own canonical failure-notification snippet (once in `src/jobs/scanner-runner.ts`), which used to tell every repo to file failure issues with `--label bug` — Claws actively propagating a GitHub default. That `--label bug` was first removed from the snippet, and the snippet and the scanner that emitted it have since been deleted outright (#2778): Claws no longer emits any `--label bug` advice.

Two findings changed the deletion list from what was originally proposed:

- **`duplicate` is not a GitHub default any more — it *is* Claws' `Duplicate` label.** GitHub label names are case-insensitively unique, so `gh label create Duplicate --force` (in `ensureLabel`) *updated* the pre-existing lowercase `duplicate` instead of creating a new one. In 11 of the 12 repos that carry `duplicate` it holds Claws' colour `cfd3d7` and description "Issue is a duplicate — the canonical issue will be implemented instead", with 150 applications. Deleting it would delete Claws' own state label and orphan 150 items. It has been **renamed** to `Duplicate` via `LABEL_RENAMES` in `src/config.ts`, applied by `applyLabelRenames` in `repo-standards`, not deleted. (Only `.github`, which has no local clone so never got label sync, still has GitHub's original `duplicate` description.)
- **`bug` was load-bearing in 10 repos and is now deleted.** `notify-failures.yml` in `3d-models`, `bin-scraper`, `bonkus`, `bstjohn-blog`, `claws`, `fleet-infra`, `namey`, `TempoStatusBar`, `vr-rooms` ran `gh issue create --label bug` (several also dedupped with `gh issue list --label bug`), as did `bonkus/.github/workflows/mobile-ios-auto-retry.yml`; `gh issue create --label bug` exits non-zero when the label does not exist, so the label could not be deleted while those workflows lived. The central `main-build-monitor` job (#2778, #2779) replaced them: all eleven `notify-failures.yml` workflows **and** `bonkus`' `mobile-ios-auto-retry.yml` were deleted in that round — the central job treats the iOS workflows like every other workflow, with no Mac-runner special casing — and it files its issues unlabelled (`labels: []` in `reportFailure()`, `src/jobs/main-build-monitor.ts`). With no producer left, `"bug"` was added to `LEGACY_LABELS` (#2782), which strips it from its 44 existing applications.

Three of the six ad-hoc labels originally proposed for deletion are live dedupe keys and are auto-recreated by the workflow that uses them — deleting them would make `repo-standards` fight the workflow nightly and duplicate alert issues:

- `lighthouse` — `vr-rooms/.github/workflows/lighthouse.yml` (`gh label create lighthouse || true`, then `gh issue list --label lighthouse` as the dedupe filter) and `bonkus/.github/workflows/lighthouse-prod.yml` (`getLabel`/`createLabel`, `listForRepo({labels: ISSUE_LABEL})`).
- `ios-build` — `bonkus/.github/workflows/mobile-ios-build.yml`, same pattern.
- `deploy-failure` — `nixos-config/deploy-issue.py`; the NAS `nixos-upgrade-notify-fail.service` searches `label:deploy-failure` and re-creates the label on every run.

`docker-publish` (bonkus, 10 uses) and `production-migration-failure` (bonkus, 3 uses) are dead: `publish-docker.yml` now dedupes by title only and applies no label, and a full-text grep of `bonkus` and `production-infra` finds no producer for `production-migration-failure` (last use 2026-06-11). `runner-maintenance` (claws, 4 uses) was applied only by Claws and read by nothing — the three `ensureAlertIssue` call sites that applied it have been updated to drop it. Also dead: `needs-ios-build` (9 uses) and `needs-android-build` (0 uses) — `bonkus/.github/workflows/mobile-ios-build.yml` records that the label gate was replaced.

Kept: `rebuilds-cluster` (a live PR gate in `production-infra/.github/workflows/rebuild-ack.yml`), `dataset-import` (namey `scripts/pendingDatasets`), `auto-bump` (applied by `production-infra/.github/workflows/bump-app-version.yml` and fleet-infra's `update-garden.yml` / `update-bin-scraper.yml` / `update-claws-staging.yml`, all via `peter-evans/create-pull-request`'s `labels: dependencies,auto-bump`; read by `isAutoBumpPR()` in `src/agents/auto-merger.ts` for the LGTM exemption), `grafana-alert`, `` `alert:boom:` ``, `training`, and the Dependabot ecosystem labels.

## Provenance classes

- **Claws state machine** — the 14 `LABEL_SPECS` keys (`Refined`, `Ready`, `Priority`, `In Review`, `Blocked`, `Claws Ignore`, `Claws Problematic`, `Duplicate`, `Billing`, `Plan: Deep`, `Use Codex`, `Use Claude`, `Manual Action`, `Automerge`), created/updated by `repo-standards` daily at 2 AM. `Blocked`, `Use Codex`, and `Use Claude` were added after this audit's usage counts were taken (2026-08-12) and are not yet reflected in the per-repo tables below; `Plan: Deep` was renamed from `Plan: Fable` in a later change, so the per-repo counts below (still under the old name) also predate that rename.
- **GitHub defaults** — the nine labels GitHub creates on every new repo (`bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`).
- **Dependabot** — `dependencies`, `javascript`, `python`, `docker`, `java`, `github_actions`.
- **Repo-local ad-hoc** — everything else, created by repo-specific workflows or manually.

## Per-repo usage

- `.github` — Ready=3, Priority=1. Unused: Claws Ignore, In Review, Refined, bug, documentation, duplicate, enhancement, good first issue, help wanted, invalid, question, wontfix
- `3d-models` — Ready=172, In Review=121, Priority=14, Automerge=8, Manual Action=7, Claws Ignore=6, Plan: Fable=5, Claws Problematic=5, bug=1, Duplicate=1, Refined=1, dependencies=1, github_actions=1. Unused: Billing
- `astro` — Ready=11, In Review=8, Automerge=8, Priority=4, Manual Action=1. Unused: Billing, Claws Ignore, Claws Problematic, Plan: Fable, Refined, bug, documentation, duplicate, enhancement, good first issue, help wanted, invalid, question, wontfix
- `bin-scraper` — Ready=137, In Review=57, Priority=17, dependencies=9, Automerge=8, Claws Ignore=4, bug=4, Manual Action=4, javascript=4, github_actions=3, duplicate=2, docker=2, Refined=1, Claws Problematic=1. Unused: Billing, Plan: Fable, documentation, enhancement, good first issue, help wanted, invalid, question, wontfix
- `bonkus` — Ready=529, In Review=444, Priority=69, Claws Problematic=36, Automerge=33, Manual Action=29, bug=25, dependencies=25, Duplicate=17, javascript=17, Claws Ignore=15, Refined=14, docker-publish=10, needs-ios-build=9, ios-build=7, lighthouse=6, python=5, Plan: Fable=3, production-migration-failure=3, docker=2, training=1, github_actions=1, Billing=1. Unused: needs-android-build
- `bstjohn-blog` — Ready=177, In Review=142, Priority=20, Automerge=13, Claws Problematic=10, Claws Ignore=5, Manual Action=5, dependencies=4, Refined=3, bug=3, javascript=3, github_actions=1. Unused: Billing, Duplicate, Plan: Fable
- `bstjohn-fractals` — Ready=66, In Review=24, Priority=18, Automerge=17, Claws Ignore=2, Refined=1, duplicate=1, dependencies=1, github_actions=1. Unused: Billing, Claws Problematic, Manual Action, Plan: Fable, bug, documentation, enhancement, good first issue, help wanted, invalid, question, wontfix
- `claws` — Ready=804, In Review=672, dependencies=113, javascript=107, Priority=77, Automerge=72, Duplicate=17, Claws Ignore=16, Manual Action=14, bug=11, Refined=8, runner-maintenance=4, python=2, docker=2, Plan: Fable=1, github_actions=1, Claws Problematic=1. Unused: Billing
- `dot-files` — Ready=187, In Review=84, Priority=15, Automerge=5, Claws Ignore=4, dependencies=2, github_actions=2, Refined=1, bug=1, Manual Action=1. Unused: Billing, Claws Problematic, Plan: Fable, duplicate, enhancement, good first issue, help wanted, invalid, question, wontfix (repo retired into `nixos-config` and archived shortly after this audit — dot-files#297; counts are a 2026-08-12 snapshot)
- `fleet-infra` — Ready=440, In Review=190, Priority=113, grafana-alert=77, duplicate=39, auto-bump=31, dependencies=31, Claws Ignore=11, Automerge=8, Manual Action=4, bug=3, Refined=2, documentation=1, enhancement=1. Unused: Billing, Claws Problematic, Plan: Fable, good first issue, help wanted, invalid, question, wontfix
- `ha-carlink` — Ready=33, Automerge=13, In Review=12, Priority=10, Claws Ignore=2, dependencies=2, github_actions=2, Refined=1, Claws Problematic=1. Unused: Billing, Manual Action, Plan: Fable, bug, documentation, duplicate, enhancement, good first issue, help wanted, invalid, question, wontfix
- `home-assistant-config` — Ready=176, In Review=91, Automerge=24, Priority=12, Manual Action=12, Claws Ignore=8, enhancement=4, bug=4, Claws Problematic=4, duplicate=2, Refined=1, documentation=1, dependencies=1, github_actions=1. Unused: Billing, Plan: Fable, good first issue, help wanted, invalid, question, wontfix
- `namey` — Ready=458, dependencies=269, javascript=219, In Review=190, Priority=61, python=32, Automerge=22, Duplicate=16, github_actions=16, Claws Problematic=13, Manual Action=7, Claws Ignore=3, dataset-import=1, java=1, docker=1. Unused: Billing, Plan: Fable, Refined, needs-android-build, needs-ios-build
- `nixos-config` — Ready=81, In Review=31, Automerge=16, Manual Action=9, Priority=7, duplicate=5, bug=5, Claws Ignore=4, enhancement=3, deploy-failure=3, Claws Problematic=1, dependencies=1, github_actions=1. Unused: Billing, Plan: Fable, Refined, documentation, good first issue, help wanted, invalid, question, wontfix
- `perudo` — Ready=86, In Review=53, Priority=20, dependencies=7, javascript=6, Claws Ignore=4, Automerge=4, Refined=3, Manual Action=3, Duplicate=2, Claws Problematic=2, github_actions=1. Unused: Billing, Plan: Fable
- `production-infra` — Ready=837, dependencies=354, auto-bump=354, In Review=211, Priority=133, `alert:boom:`=114, duplicate=100, Manual Action=16, Automerge=14, bug=12, Claws Ignore=10, Claws Problematic=6, enhancement=4, Refined=3. Unused: Billing, Plan: Fable, documentation, good first issue, help wanted, invalid, question, rebuilds-cluster, wontfix
- `TempoStatusBar` — Ready=71, In Review=38, Priority=28, Billing=7, Claws Problematic=5, bug=4, Claws Ignore=3, dependencies=2, github_actions=2. Unused: Automerge, Manual Action, Plan: Fable, Refined, documentation, duplicate, enhancement, good first issue, help wanted, invalid, question, wontfix
- `vr-rooms` — Ready=372, In Review=243, Priority=56, Automerge=50, dependencies=33, javascript=28, Claws Problematic=10, Manual Action=6, Claws Ignore=4, lighthouse=3, Refined=2, bug=1, duplicate=1, enhancement=1, Plan: Fable=1, github_actions=1. Unused: Billing, documentation, good first issue, help wanted, invalid, question, wontfix

## Verdicts

| Label | Repos | Uses | Verdict |
| --- | --- | --- | --- |
| `documentation` | 6 | 2 | Deleted — GitHub default, nothing references it |
| `enhancement` | 6 | 13 | Deleted — GitHub default, nothing references it |
| `good first issue` | 14 | 0 | Deleted — GitHub default, never used |
| `help wanted` | 14 | 0 | Deleted — GitHub default, never used |
| `invalid` | 14 | 0 | Deleted — GitHub default, never used |
| `question` | 14 | 0 | Deleted — GitHub default, never used |
| `wontfix` | 14 | 0 | Deleted — GitHub default, never used |
| `runner-maintenance` | 1 | 4 | Deleted — applied only by Claws, read by nothing |
| `docker-publish` | 1 | 10 | Deleted — `publish-docker.yml` no longer applies it |
| `production-migration-failure` | 1 | 3 | Deleted — no producer left, last use 2026-06-11 |
| `needs-ios-build` | 1 | 9 | Deleted — superseded by an automatic gate |
| `needs-android-build` | 1 | 0 | Deleted — superseded by an automatic gate |
| `automation` | 1 | 1 | Deleted — created after this audit by bin-scraper's alert code; that code no longer applies or reads it (bin-scraper#272) |
| `duplicate` | 12 | 150 | Renamed to `Duplicate` — case-collision with Claws' own label |
| `bug` | 10 | 44 | Deleted via `LEGACY_LABELS` — producers removed with the fleet's `notify-failures.yml` and `mobile-ios-auto-retry.yml` workflows (#2778, #2779, #2782) |
| `lighthouse` | 2 | 9 | Kept — live dedupe key, recreated by its own workflow |
| `ios-build` | 1 | 7 | Kept — live dedupe key, recreated by its own workflow |
| `deploy-failure` | 1 | 3 | Kept — live dedupe key, recreated on the NAS by `deploy-issue.py` |
| `rebuilds-cluster` | 1 | 0 | Kept — live PR gate in `rebuild-ack.yml`, fires rarely |
| `dataset-import` | 1 | 1 | Kept — used by namey's pending-datasets tooling |
| `training` | 1 | 1 | Kept |
| `auto-bump` | 2 | 385 | Kept — control label, not cosmetic. Applied by four bump workflows (production-infra `bump-app-version.yml`; fleet-infra `update-garden.yml`, `update-bin-scraper.yml`, `update-claws-staging.yml`) and read by `isAutoBumpPR()` in `src/agents/auto-merger.ts`. Deleting it strands every image-bump PR waiting for a human LGTM, and the next bump PR recreates the label anyway (#2822) |
| `grafana-alert` | 1 | 77 | Kept — prod alerting |
| `` `alert:boom:` `` | 1 | 114 | Kept — prod alerting |
| `dependencies` / `javascript` / `python` / `docker` / `java` / `github_actions` | many | many | Kept — Dependabot ecosystem labels, recreated by Dependabot on the next PR; deleting is futile |
| `Billing` | 17 | 8 | Low-value Claws-managed label — flagged for the owner to consider retiring |
| `Plan: Deep` (renamed from `Plan: Fable` in this change — usage counts below predate the rename) | 17 | 10 | Low-value Claws-managed label — flagged for the owner to consider retiring |

## How to action a label

Add the name to `LEGACY_LABELS` (`src/config.ts`); `repo-standards` deletes it from every managed repo with a local clone, daily at 2 AM.

Caveats:

- Deletion strips the label from every issue/PR that carries it, irreversibly.
- Repos with no local clone (currently `.github`) are skipped, so those need manual deletion: `gh label delete <name> --repo St-John-Software/.github --yes`. Its 9 GitHub defaults are: `bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`. `bug` is in `LEGACY_LABELS` as of #2782, but `.github` has no clone so `repo-standards` never reaches it; delete it there manually with `gh label delete bug --repo St-John-Software/.github --yes` (it has 0 applications there).
- Removing a *Claws-managed* label needs its key deleted from both `LABELS` and `LABEL_SPECS` in `src/config.ts` plus every call site, or `ensureAllLabels` recreates it that night.
