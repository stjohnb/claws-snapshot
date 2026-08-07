# public-snapshot-sync

**Source**: `src/jobs/public-snapshot-sync.ts`
**Trigger**: Daily at 3 AM local time (`publicSnapshotSyncHour`, #1826, #2106 — was weekly via `publicSnapshotSyncMs`; idempotent via the stored source SHA, so a no-op day is a fast no-op)
**Targets**: `PUBLIC_SNAPSHOTS` source→target pairs (currently `claws`, `3d-models`,
`TempoStatusBar`, `fleet-infra` → `stjohnb/*`)

Rebuilds each public `stjohnb/*` target repo from its private source on every run, so a
public mirror can exist without ever exposing the source's untracked files, development
process, or private CI topology details it hasn't been scrubbed for.

## Rebuild

For each `source → target` pair, `git archive <srcSha>` is piped into a tar extracted over the
target — **tracked files only**, never an rsync of the source's working tree, which would leak
untracked artefacts (e.g. `node_modules`) onto a PUBLIC target (#1833).

## Scrubbing

Development-process artefacts are stripped: `.claude`, `.plans`, `ideas/`, MCP config, dependabot files,
`BLOG_IDEAS.md`, and `HOMELAB_IDEAS.md`. `.github/workflows` is published but **disabled**: `disableWorkflowTriggers()`
replaces each workflow's top-level `on:` block with a `workflow_dispatch:`-only placeholder via a
targeted text rewrite — never a YAML parse/reserialize, which would reflow the file and, under
YAML 1.1, coerce the bare `on` key to `true` (#1835). CI topology and self-hosted runner labels are
otherwise left visible; this is intentionally public per the repo owner.

A pair may additionally declare `scrubPaths` in the `publicSnapshots` config entry to remove
repo-specific sensitive paths on top of the global list above (#1962) — e.g. `fleet-infra` scrubs
`apps/authentik/configmap-blueprints.yaml`, which holds personal data that the private source is
entitled to contain but that must never reach the public `stjohnb/homelab` snapshot. Because the
path may already exist in the target's *published history* from an earlier sync, a `scrubPaths`
pair does not just scrub HEAD — every sync for that pair rebuilds the tree, then `git checkout
--orphan`s a fresh branch and `git push --force`s it as a single root commit, so nothing scrubbed
can survive in an ancestor commit. This is mutually exclusive with `mirrorReleases` (rejected at
config-parse time): `mirrorReleases` anchors public releases at specific snapshot SHAs, which a
rewritten history would orphan. A force push doesn't erase the old commits from GitHub immediately
— they stay fetchable by SHA until GC — so if the values must be gone right away, delete and
recreate the target as an empty public repo; the next sync repopulates it.

A `public-repo-scanner` finding on a snapshot target (see that job's docs) is resolved by adding the
offending path to that pair's `scrubPaths`, not by fixing the private source.

`README.md` is rewritten for a public audience via a text-only Claude call before the secret scan
runs (#1848) — best-effort, falling back to the verbatim source README on any failure. If the source
ships a `README.public.md` at its root, `rebuildTargetTree()` renames it over `README.md` on every
commit it produces (release-tag commits included) instead — the author-controlled variant is
published **verbatim**, and the LLM `tailorPublicReadme()` call is skipped entirely for that commit
(#1948). `St-John-Software/claws` ships a `README.public.md` (#1949), so `stjohnb/claws-snapshot`
always gets the verbatim variant; `3d-models` and `TempoStatusBar` (no `README.public.md`) still get
the LLM-tailored README.

## Secret scan

Runs a fail-closed secret scan (never pushes on a match) against a `SCAN_ALLOWLIST` of known-safe
path+pattern-name matches — documentation/test placeholders that look like real secrets, e.g.
`docs/home-assistant.md`'s templated `-----BEGIN OPENSSH PRIVATE KEY-----` example,
`docs/OVERVIEW.md`'s own prose describing that placeholder (#1857), and this module's own doc
comment/test fixtures quoting it (#1833/#1836). Entries are narrowly scoped by exact repo-relative
path *and* pattern name, so a real key elsewhere at the same path is still caught. **Any doc that
newly quotes a secret-shaped placeholder string** (rather than just naming the pattern) will trip
this scan and needs its own allowlist entry.

## Publish

Disables Dependabot on the target, then pushes new commit(s) whose HEAD-commit body summarises
features since the last sync. A plain (non-release) sync pushes exactly **one** commit; a release
pair (see Releases) can push several in one run. Idempotent via a stored source SHA in
`.claws-snapshot.json` on the target — a no-op sync (source unchanged, no pending release) still
runs the rest of this pipeline (see Releases below).

The HEAD commit's **subject** is derived by the same LLM call that writes the body, so it describes
the changes ported across (#2362). It falls back to `Update snapshot` when the model returns no
usable subject line (bullets only, an over-long line, or one naming the source), and to a fixed
`Resync snapshot with the latest source state` on a first sync or after the source rewrote history —
the log then spans up to 200 subjects, which don't distil honestly into one line. **Neither the
subject nor the body may name the private source**: the owner, the `owner/name` path, and (when the
target was renamed, e.g. `fleet-infra` → `homelab`) the bare source repo name are replaced with
"the source repository" before the message is committed. `claws` → `claws-snapshot` deliberately
keeps the bare word "claws", which is the public identity. The derived subject is committed text, so
it is fed to the fail-closed secret scan as `commit-subject-line`.

**Never un-archives** a target: a missing or archived target files a single updating
`ensureAlertIssue` on `SELF_REPO` and skips that pair.

## Releases

When a pair sets `mirrorReleases: true` (currently only `TempoStatusBar`, #1851), each new
**stable** source release tag (skips prereleases/drafts) is anchored on the target at a
**source-accurate snapshot commit** whose tree is `git archive <tag-sha>` (scrubbed), rather than at
the target's HEAD (#1941). For each pending tag, in release order (oldest first), the pipeline
rebuilds the tree from that tag, secret-scans it, commits `Release <tag>` (#2362), and — after
a single push of the whole batch — creates the public release anchored at that commit, uploading the
`.dmg` asset via `gh release create`. The DMG itself is fetched via `gh release download` when the source
release still carries it as a GitHub Release asset, falling back to an HTTPS fetch of the pair's
`releaseAssetUrl` (#2115) when it doesn't — TempoStatusBar's release workflow moved DMG storage to a
public-read S3 prefix after exhausting GitHub's storage/bandwidth quota. The run finishes with the regular HEAD
snapshot commit (unless a release was cut exactly at HEAD, which folds into that release commit and
carries the tailored README + summary body). Because every tree is built locally and pushed once, a
secret-scan hit on **any** commit aborts the whole run with nothing on the remote (no partial history).

Decisions (#1941):

- **Pre-existing public releases** (e.g. `v1.3.1`, anchored at an old snapshot HEAD before this change)
  are **left alone** — recorded as `"preexisting"` in `publishedReleases` and never re-anchored. Only
  future releases get source-accurate anchoring. `.claws-snapshot.json` gains a `publishedReleases` map
  (tag → public commit SHA) alongside `sourceSha`.
- **Backfill** of `v1.3.0` and earlier is explicitly not done.
- **Intermediate release commits** keep the verbatim source README (no per-tag LLM call); README
  tailoring runs only on the HEAD commit.
- A **DMG-download failure** files a single `Release mirror failed` alert but does not fail the (already
  pushed) sync; a source release with no `.dmg` asset AND no `releaseAssetUrl` fallback configured needs
  manual attention.

When a sync is a pure no-op (source unchanged, no pending release tags), the legacy most-recent-only
`mirrorLatestRelease` fallback still runs so an already-tagged upstream release's DMG is topped up.

## History cleanup (#2362)

Syncs before #2362 baked the private source path into every committed subject, so fixing new commits
alone would have left the leak sitting in published history. Every run therefore checks the target's
**published** messages (`git log --format=%B --branches --tags`) for the same owner/path literals the
scrubbing uses; a hit forces a resync of that pair even when the source hasn't advanced.

- A **`scrubPaths` pair** needs nothing more: bypassing the idempotency gate already republishes its
  entire history as one squashed root commit.
- **Any other pair** gets `git filter-branch --msg-filter … --tag-name-filter cat -- --branches --tags`,
  which rewrites `snapshot: update from <source>` → `Update snapshot`, `snapshot: <tag> from <source>`
  → `Release <tag>`, and any remaining literal → "the source repository". Trees, authors and dates are
  untouched, so published release trees still match the source exactly; the release **tags** move to
  the rewritten SHAs, and the branch and tags are both force-pushed. Release assets are keyed by tag
  name on the Release object, so DMGs stay attached across the re-point.

The `publishedReleases` SHAs in `.claws-snapshot.json` go stale after a rewrite. That is harmless —
they are only ever read for truthiness ("already mirrored"), never resolved.

The check is **self-clearing**: once no message names the source it never fires again, so there is no
flag to remember to turn off. Detection and rewriting share one literal list and are both
**case-sensitive** — a mismatch between the two would make the job force-push a no-op rewrite every
single day. `rewriteHistoryMessages` also refuses to run if a configured literal isn't a plain repo
path, because the sed program is assembled as a shell string.

## Dashboard

Registered in `main.ts`, so the dashboard renders a **Run** button — the manual "sync now" trigger.

## Owner requirements

Constraints the repo owner stated directly. They explain why the pipeline above is
shaped the way it is, and must survive refactors of it.

- **The mirrors exist to share code, not development process** (#1826). Scrubbing
  `ideas/` and the other process artefacts is load-bearing, not cosmetic.
- **Never un-archive a target repo.** "I will unarchive that repo manually and that
  shouldn't be automated" (#1826) — hence the alert-and-skip behaviour on a missing
  or archived target rather than an automatic un-archive.
- **CI workflows are published in a disabled state**, not omitted (#1835) — remove or
  neuter the triggers, keep the files.
- **Public READMEs should diverge in content from the private ones** (#1848). The LLM
  rewrite was the first answer; the owner then wanted direct control, so an opt-in
  `README.public.md` is published verbatim with no LLM call (#1948/#1949) and must
  not mention that the repo is a sync of a private one ("don't mention the public
  sync of a private repo bit", #1949).
- **The owner asked (#1942) for the LLM-tailored README to drop its "this is an
  automated mirror" disclosure line entirely** ("remove it, or its equivalent, from
  all public sync repos"). This is only fully honored for pairs that ship a
  `README.public.md` (verbatim, no disclosure line, per #1948/#1949 above). Pairs
  without one (`3d-models`, `TempoStatusBar`) still go through `tailorPublicReadme()`,
  whose `PUBLIC_README_PROMPT` still instructs the model to add a short "this is a
  public snapshot of a personal, self-hosted project" opening note — the #1942 request
  was never carried through to that prompt. Treat this as an open gap, not settled
  behavior, if working on the LLM-tailoring path.
- **Sensitive data that leaks into a snapshot is fixed here, not in the leaking repo**
  (#1962, re: `fleet-infra`) — scrub at the source pipeline via `scrubPaths`, and
  force-push to rewrite the exposed history on the next sync.
- **A misfiled issue caused by this job belongs in `claws`**, not in the public target
  repo (#1875) — even when it was discovered via a `stjohnb/*` public repo.
- PII scrubbing of the (then archived) `claws-snapshot` mirror was a **one-time**
  remediation (#1770, done via PR #1793), verified clean of maintainer
  emails/domains/IPs/paths; going forward, scrubbing happens at publish time.
- **Release mirroring** was requested for TempoStatusBar (#1851): most-recent stable
  only, skipping RC/prereleases, and anchored at a commit whose tree matches the
  private source *at that tag* (#1941) rather than at whatever the target HEAD is —
  which is why a sync may need to push several commits in one run.
- `fleet-infra` → `stjohnb/homelab` was added to the pair list later (#1956).
- **Schedule**: daily, kept outside UK office hours — landed as 3 AM local time
  (#2106). This *supersedes* the original "weekly" framing in #1826.
