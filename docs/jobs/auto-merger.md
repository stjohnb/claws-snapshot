# auto-merger

**Deep dive.** Read this when you're changing how often open PRs are evaluated
for merge, or how a blocked merge is reported. For the merge gates themselves
(the stored merge approval, CI, infra paths), read the Merger section of
[pr-dispatcher.md](pr-dispatcher.md#merger-auto-merger).

**Source**: `src/main.ts` (job) → `sweepRepo()` in `src/agents/auto-merger.ts`
**Trigger**: Every 3 minutes (`intervals.autoMergerMs`); disabled with the `merger` agent

## Why it runs on the scheduler (#2971)

The merge sweep is pure Forgejo API: no worktree, no Claude. It used to
run only as an `auto-merger:sweep` work-queue row, which `claimNextWork`
orders behind multi-hour agent runs on a small worker pool, so an approval
could take 10–20+ minutes to act on. The job now runs inline on the scheduler,
sweeping every repo (4 at a time),
so a PR merges within about three minutes of whatever last unblocked it —
a merge approval from the dashboard, CI going green, or a conflict being resolved.

A merge approval is always a PR row's `merge_approved_by` / `merge_approved_at`.
Approving an issue through Merge (the approval track's Merge gate, or
`claws_set_issue_approval` with `through: "merge"`) writes them on every open
PR row of the issue, and the next PR Claws opens for it inherits them
(`applyIssueApproval` in `src/issue-approval-write.ts`); a single-PR approval
(`claws_approve_pr_merge`, `/prs`) writes them on one row. No label is read:
the `Automerge` label is retired (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F).

pr-dispatcher no longer enqueues a periodic sweep. The ci-fixer handler still
chains an `auto-merger:sweep` row when it finishes; pr-reviewer and
review-addresser chain one only after they reviewed, pushed or changed PR
state, never on a skip path (#clw_01M63KWT4ECG1X4VEHRS2NYHPC). That handler
calls the same `sweepRepo()`.

## Sweep behaviour

- `sweepRepo(repo)` invalidates the cached PR list, lists open PRs, skips any
  rejected by `isDispatchSkippable`, and defers any PR with a **running**
  ci-fixer, conflict fixer, review-addresser or reviewer row
  (`db.hasActiveWorkForPR`) to the next sweep. Each PR's `tryMerge` runs in its
  own try/catch, so one failure does not stop the rest.
- Every PR the sweep leaves unmerged logs a `merge_skipped` diagnostic with
  context `{repo, pr, mergeSkip}`, and every sweep ends with one
  `merge_sweep_done` line carrying `{repo, openPrCount, mergedCount,
  skippedCount}` — so a sweep that merged nothing still leaves a trace. See
  [Skip reason codes](#skip-reason-codes).
- A module-level set of repos being swept makes a second concurrent
  `sweepRepo` for the same repo return immediately, so the scheduler job and a
  chained queue row never sweep one repo at once. The scheduler's
  `runningFlags` already stops the job overlapping itself, and `mergePR` is
  pinned to the evaluated head SHA.
- In staging mode (`CLAWS_ACTIVATION_STATE=staging`) the job is part of the
  staging lane (`STAGING_PIPELINE_JOB_NAMES`); `isDispatchSkippable` still
  limits it to `Claws Staging` PRs.

## Third-party update PRs

`tryMerge` evaluates third-party update PRs (Renovate, or a
`renovate/*` branch) at any hour, like every other PR: a PR that
passes every gate merges whatever the time of day. Update tools are scheduled to
open PRs at 19:00 Europe/London instead
([pr-dispatcher.md](pr-dispatcher.md#third-party-update-prs-and-worker-protection)).
An approved PR whose review status is still `none` (not yet reviewed) is
blocked without a "Merge blocked" comment.

## No CI result on the head (`status=none`)

A head with no commit statuses or check runs reads `status=none`. That means "CI
has not reported", not "green", so it never merges on its own
(#clw_01M50MY5NZYBNSG5X0FZYXVVGS).

- **Unsettled head.** The head commit is under 5 minutes old by committer date
  (`haveChecksSettled`): the block is a quiet `checks-pending`, with the reason
  "CI has not reported on head `<sha7>` yet — waiting for it to register." and
  no "Merge blocked" comment.
- **Settled head, CI not expected.** `gh.repoExpectsCi(repo)` is false: the
  default branch has no `.yml`/`.yaml` file under `.forgejo/workflows/` or
  `.github/workflows/`, or `claws.json` sets `mergeWithoutChecks: true`
  ([repo-config.md](../repo-config.md)). `none` is accepted. The answer is
  cached per repo for 10 minutes; a listing error counts as "CI expected"
  (fail closed) and is not cached.
- **Settled head, CI expected.** The whole PR is judged, not the head commit
  alone:
  - **Case A — the whole diff is CI-exempt** (`docs/**`, `*.md`, `LICENSE`,
    `isCiExemptPath`): `none` is accepted. Doc PRs (`claws/docs-`) are
    all-docs, so this covers them. Ideas-collection PRs (`claws/ideas-collect-`)
    are accepted too.
  - **Case B — CI-exempt commits on top of a commit with a CI result:**
    `carriedForwardCheckStatus` walks the PR's commits newest-first (up to 10)
    and carries forward the status of the first commit that has any, as long as
    every commit above it changes only CI-exempt paths. This runs through
    `forgejo.carriedForwardCheckStatus`.
  - **Case C — no commit in the PR proves its code was tested:** the PR holds
    with `checks-missing`, reported on the PR like any other block of an
    approved PR, and counted on `/prs` as needing the operator.

  The `checks-missing` reason reads: "CI has not reported on head `<sha7>` — no
  commit statuses or check runs exist for it or for any earlier commit in this
  PR whose code it carries, and this repo's CI normally reports on pull
  requests. Claws will merge once CI reports green; push a new commit to start a
  run, or set `mergeWithoutChecks: true` in `claws.json` if this repo's CI never
  runs on pull requests." `claws_merge_pr` and `claws_approve_pr_merge` return
  the same reason, because they go through `attemptMerge`.

A merge approval is not a CI result: it is not accepted on `status=none` by
itself. A no-op infra plan PR is never
accepted on `none` either, since the plan run is itself a check.

### Why PR #105 merged with no CI

On 2026-10-15 claws PR #105 merged about 4 minutes after it opened, with no
statuses on head `cdce0bad`. Two things lined up:

- **No run started.** The branch arrived in one push: a `src/` commit with a
  docs-only tip on top. Forgejo evaluates `push` `paths-ignore` for a new-branch
  push against the tip commit's files only, so `ci.yml`'s
  `paths-ignore: docs/**, **/*.md, LICENSE` matched and no run was created.
  `.forgejo/workflows/ci.yml` no longer has `paths-ignore`, so every push runs CI.
- **The gate accepted the absence.** A merge approval plus a settled head was treated
  as "genuinely no CI". The settle window counts from the committer date, not
  the push time, so an agent commit made more than 5 minutes before its push
  looks settled at once.

Any other managed repo whose CI uses `push` `paths-ignore` can still hit case C
on a new-branch push. That now shows up as a visible `checks-missing` hold
rather than a silent merge.

## Workflow runs held for approval

Forgejo has no approval hold, so no reader reports `checkStatus: "held"` today.
`tryMerge` keeps a `checks-held` arm, reserved for one: it would block at info
level with a reason saying a human has to approve the runs.

## Trusted Renovate updates

A Renovate PR merges without a dashboard approval when
`isRenovateExempt` (`src/agents/auto-merger.ts`, helpers in `src/renovate.ts`)
holds — it is one of `isApprovalExempt`'s categories, alongside
`claws/docs-`, `claws/ideas-collect-` and auto-bump. A merge approval on any of these never adds a review gate (the Renovate and auto-bump review gate applies approved or not):

- **Trusted author.** Not a fork, head branch `renovate/…`, and authored by the
  Forgejo `renovate` account, or by a login `gh.isAllowedHumanActor`
  accepts (fleet-infra's Renovate runs under the operator's PAT). Claws' own
  accounts, other bots and unlisted logins never qualify, and Claws'
  installation token cannot open a PR as any of these, so the #3219 threat
  model holds.
- **Not a major update.** `classifyRenovateUpdate` counts a `major-update`
  label, a title ending `(major)`, a `renovate/major-` branch, Renovate's
  `to v<N>` title shape (no dots; Renovate titles the PR with its first
  commit's subject) and a `major` row in the Update column of *any*
  `| Package | Update | Change |` table in the body (the table may sit below
  text Claws prepended). The `Update` column is read first; when no table has
  one, each row's `Change` cell is compared by leading major version (range
  prefixes such as `^ ~ == >=` and a `v` are ignored, so a 0.x minor bump is
  non-major) and any row whose major differs makes the PR major. A PR is
  classed unknown only when neither column yields a reading or a `Change` row
  cannot be parsed. With no signal at all the PR fails closed and is
  treated as major: the skip is logged as
  `skipped: not approved — update type unknown (body has no Renovate table); approve the merge from the Claws dashboard`,
  and `/prs` shows the same text as the Awaiting approval badge title, so an
  operator can tell a classification failure from a real major. Other
  not-approved PRs keep the generic wording. Claws agents never replace a
  Renovate body (see [pr-dispatcher.md](pr-dispatcher.md)), so the
  table normally survives CI fixes.

The `Automerge` label Renovate adds is never read. An exempt Renovate PR then
runs the same review gate as an approved PR — a clean Claws review whose
reviewed commit prefixes the current head, logging
`skipped: trusted Renovate update but review status=…` or
`… but clean review is stale` otherwise — followed by the infra, CI and
conflict gates every PR runs. Like every PR it is accepted on `status=none`
only under the rules in [No CI result on the head](#no-ci-result-on-the-head-statusnone).
A row with `needsHumanReview` or a recorded merge hold
(`manual_action_reason`) still blocks it.

## Auto-bump PRs

An `auto-bump` PR (`isAutoBumpPR`: an `automation/bump-*` branch with the
`auto-bump` label and no `major-update` label) is approval-exempt
unconditionally; nothing reads its diff (#clw_01M6ZYAQ1GZXRMTZSQP1V0XA4D). Like
a trusted Renovate PR it still needs a clean Claws review whose reviewed commit
prefixes the current head, logging `skipped: auto-bump image bump but review
status=…` or `… but clean review is stale` otherwise, followed by the infra, CI,
deploy and conflict gates every PR runs. A `major-update` bump is not exempt and
needs a stored merge approval. A row with `needsHumanReview` still blocks it.

The PR dispatcher sends auto-bump PRs to the reviewer like any other PR, so a
fresh bump head is reviewed before it merges. On a fresh head with no review yet
the skip is the quiet `review-not-clean` (`review status=none`), not reported on
the PR.

Once per repo per process the sweep closes any still-open
`Auto-bump PRs held by the structural merge gate` issue left by the removed
stalled-bump alert (retirement; delete after 2026-12-01).

## Image-scan snapshot and prune PRs

The weekly `image-cve-scan.yml` in production-infra and fleet-infra opens two
generated PRs, recognised by exact branch name — labels play no part
(#clw_01M61EFZ6ZZM8FWGN2PAH3KNZB, `src/image-scan-prs.ts`):

- **Snapshot refresh** on `automation/image-scan-advisories` (production-infra
  only). Approval-exempt only while its changed files are exactly
  `security/image-scan/advisories.json`.
- **Exception prune** on `automation/image-scan-exceptions-prune`. Approval-exempt
  only while it is still the generator's output, checked in this order:
  1. its changed files are exactly `security/image-scan/exceptions.yaml`;
  2. its body records the commit the source scan ran on, as a line matching
     `/^image-scan-scanned-commit:\s*([0-9a-f]{40})\s*$/m` — the contract the prune
     workflow emits (#clw_01M61EGJAB6D6VZTYVCC4VVDKY); a prune without it is never exempt;
  3. it has exactly one commit, with one parent, and that parent is the scanned
     commit — so no conflict-resolution merge and no commit beyond the generator's;
  4. no image pin under the rendered manifests moved on the base branch between the
     scanned commit and the base branch's **current tip** (the PR's `base.sha`). The
     tip, not the merge base: with rule 3 the merge base is the scanned commit, so
     checking up to it would prove nothing. Claws lists the range with
     `/compare/{scanned}...{base}` and fetches the diff of each commit that touches a
     `.yaml`/`.yml` file under `apps/`, `infrastructure/`, `clusters/`, `data/` or
     `migrations/`; a `+`/`-` line matching `PIN_LINE` (`src/image-scan-prs.ts`: `image:`,
     `newTag:`, env `value:`) or containing `@sha256:` is a pin change.

An exempt image-scan PR still needs a clean Claws review of its current head
(advisory-only counts as clean), green CI and every later gate; the PR dispatcher
keeps reviewing it. The dispatcher pushes no advisory-nit commits to either branch
and never sends a prune PR to the conflict fixer (it logs
`Skipping conflict fixer for <repo>#<n> — generated prune PR; the weekly scan regenerates it`):
either would turn a generated PR into a held one. The next weekly scan regenerates
the prune against main instead.

A failing gate withdraws only the exemption: with a stored merge approval (the PR's
own, or its issue approved through Merge) the PR merges like any other approved PR.
Without one it is skipped with code `image-scan-gate`, logged as
`skipped: not approved — <hold text>; approve the merge from the Claws dashboard`,
and the same text titles the `/prs` Awaiting approval badge (`approvalHoldReason`).
The hold texts:

| Hold text | Reported on the PR |
|---|---|
| `snapshot PR changes files other than security/image-scan/advisories.json: <files>` | yes |
| `snapshot PR has no readable changed files` | no — may be a transient read failure |
| `prune PR changes files other than security/image-scan/exceptions.yaml: <files>` | yes |
| `prune PR records no scanned commit` | yes |
| `prune PR carries a conflict-resolution merge` | yes |
| `prune PR has commits beyond the generator's` | yes |
| `prune PR's scanned commit <sha7> is not on main` (the compare answered 404) | yes |
| `prune scan predates image-pin changes on main (<paths>)` (up to five paths) | yes |
| `could not verify main's image pins since the scanned commit` | no — a failed read, a truncated compare (fewer commits listed than `total_commits`) or more than 50 manifest-touching commits |

Reported holds edit the PR's `### Merge blocked` comment and mark it as needing the
operator on `/prs`. Verdicts are cached per head
(`${gate}:${repo}#${n}@${head}`, 15-minute TTL, 500 entries); the two log-only
reasons are never cached, and each sweep recomputes the verdict against the live head
and base tip.

## Infra paths and the zero-change plan exception

Any PR touching an infra path (`gh.isInfraPath`: `tofu/`/`terraform/`, `*.tf`,
`*.tfvars`, `.terraform.lock.hcl`, a `.github/workflows|actions/**` or `.forgejo/workflows|actions/**` file naming tofu or terraform)
is held for a human merge (#2275). A plan comment alone never gates a merge: it
is spoofable, absent whenever the plan job failed, and a workflow-only change
that never planned destroyed two prod servers (production-infra#841). The gate
outranks a merge approval and every exemption, with one exception.
Forgejo workflows get the same protection as GitHub ones: production-infra's tofu
apply is push-triggered on its own `.forgejo/workflows/` path, so a merged edit
applies at once.

A PR merges without a human when it would otherwise merge and its plan for the
live head is a verified zero-change plan in every root
(#clw_01M7095Y5BKVV7WQ7078Z15GH7). Until #clw_01M5VW1FVEPCYG33BN268PWTWZ
a GitHub path also accepted a trusted dependency PR whose every file was a
provider pin; it went with GitHub as a managed forge.

- "Would otherwise merge" means the PR carries a stored merge approval (any
  author, Claws' own implementer included) or is a trusted non-major Renovate
  update (`isRenovateExempt`). Other approval-exempt PRs that touch infra —
  auto-bump, image-scan, doc — get the plain infra hold:
  `it covers only an approved PR or a trusted non-major Renovate update`.
- `noopMergeDiffVerdict` in `src/tofu-plan.ts` judges the diff. With no
  workflow or action file (`isWorkflowOrActionPath`) it is `plan-only`: the
  plan covers everything the merge can do, whatever the other files are. A
  `tool-version-bump` is a diff whose every infra path is a tofu-named
  workflow or action file (`isInfraWorkflowPath`) whose section has exactly one
  removed and one added line that are identical once one version token
  (`v?N.N(.N)*`, optional `-`/`+` suffix) in each is replaced, the file not
  added, deleted or renamed. Only a trusted Renovate update may merge a tool
  bump (`tofu tool version bump is only auto-merged for a trusted Renovate
  update` otherwise). Any other workflow or action file fails it, tofu-named
  or not, and so does an unreadable diff.
- `gh.getTofuPlanEvidence` groups the plan comments by root (fleet-infra's
  `### Tofu Plan: <dir>` heading; no heading is the one default root) and takes
  the newest per root. Only comments from the forge's Actions account
  (`forgejo-actions`) or a configured human operator (`isAllowedHumanActor`;
  production-infra's workflow posts with a user token) count; other accounts,
  Claws' own included, are ignored before the newest-per-root pick. Every root's
  comment must parse and be last edited at or after the head commit's committer
  date (the workflow PATCHes one comment in place, so `updatedAt` moves on every
  run), and the head must carry a passing commit status whose context starts
  with `Tofu Plan /` (production-infra's is `Tofu Plan / plan (pull_request)`).
  The counts are summed over the roots. A repo without that workflow never has
  evidence and stays held.

It then needs:

- The comments to read as zero changes: production-infra's
  `**0 to add, 0 to change, 0 to replace, 0 to destroy.**` (fleet-infra adds a
  `**N to import**` span before it, counted as a change), or OpenTofu's
  `No changes. Your infrastructure matches the configuration.` A raw
  `Plan: N to add, N to change, N to destroy.` line is read too, with `replace`
  counted from `# … must be replaced` lines and any other term (`to import`)
  counted as a change; a body with neither form is unparseable. fleet-infra's
  tailscale root plans from empty state and always imports, so it never
  qualifies.
- A clean Claws review of the current head, and CI
  `passing` — `status=none` is not accepted, since the plan run is itself a
  check — then the held-run, conflict and merge-window gates every PR runs.

A tool version bump is planned with the bumped binary: production-infra's
`tofu-plan-on-pr.yml` `paths:` include `.github/actions/install-tofu/**`, and
its plan run for #707 logged `install-tofu: cache miss, downloading v1.13.8`.

The trade-off the operator accepted: a template edit, such as the tailscale
`_common_tailscale.sh.tftpl` bump (production-infra #527, #708), can plan as
zero because the rendered `user_data` is `ignore_changes`, and only takes effect
at the next server rebuild. A zero-change plan for such a PR does not mean the
change is inert, only that it reaches the servers later.

Immediately before merging under the exception, the auto-merger creates and adds
the `claws-noop-merge` label (`CLAWS_NOOP_MERGE_LABEL`). production-infra's
merge-time `tofu-apply.yml` re-plans on push; for a merged PR carrying that label
it refuses any plan that is not zero changes — on the initial plan and on every
retry re-plan — and fails the run saying it refused, so drift no human saw is
never applied. Human-merged PRs, merges on a board approval (current or carried
over) and manual dispatches are not subject to it. If
the label cannot be added, the merge is skipped that cycle
(`skipped: could not label the PR for the no-op apply guard`, log-only).

Anything else fails closed. A refused diff logs
`skipped: infrastructure changes require a human merge (…); zero-change plan
exception does not apply: <reason>`, and the Merge blocked comment on an approved PR reads
`Infrastructure changes (…) always need a human merge. The zero-change plan
exception does not apply: <reason>.` — the reason names the file, e.g.
`changes workflow file .forgejo/workflows/ci.yml`, `non-version change in
.github/actions/install-tofu/action.yml`, `… is added, deleted or renamed`,
`tofu tool version bump also changes tofu/main.tf` or `diff unreadable`. A plan with changes
logs `skipped: infrastructure plan shows N changes, human merge required (…)`; a
missing, unparseable, failed, cancelled, running or stale plan logs
`skipped: infrastructure plan not available for head <sha7> (<detail>)`
(log-only, no Merge blocked comment — it usually resolves on a later sweep). The
detail is `no plan comment`, `plan comment[ for <root>] is not parseable`,
`head commit date unknown`, `plan comment[ for <root>] predates the head commit`,
`Tofu Plan check is <state>` or `no Tofu Plan check on this head`. A verified
zero-change plan logs
`no-op Tofu plan verified for head <sha7>; allowing a zero-change infra merge (<plan-only|tool-version-bump>)`.
`/prs` shows the same verdict as one line after the infra badge: `Plan shows N
changes — human merge required`, `Plan not available for this head: <detail>`,
`No-op plan — human merge required (<reason>)` naming why the diff is refused,
`No-op plan — awaiting merge approval`, or `No-op plan — merging on next cycle`.
The dashboard's own **Merge infra** button still needs its confirm dialog (`confirmInfra`).

### Board approvals and plan-neutral commits

An operator's **Approve infra merge** on the board (`/board/infra-approve`)
records the approver and head on the `claws_prs` row, and in
`infra_merge_approved_evidence` the head's plan fingerprint
(`tofuPlanFingerprint` over `parseTofuPlanResources`: one `root address action`
line per resource, from production-infra's `` - `address` — **action** ``
bullets or raw `# address will be …` lines; null when the plan was not verified
or lists no resources) and `infraWorkflowDiffDigest` (sha256 of the PR's
tofu-named workflow and action files and their `+`/`-` lines, hunk headers and
context excluded). It logs whether a fingerprint was recorded.

An approval for the live head is the human merge. One for an older head is
carried over (`infraApprovalCarryOver`) when the live head's evidence is `noop`
or `changes` with resources, its fingerprint equals the stored one, and the
digest of the live PR diff equals the stored digest. The digest is taken from
the PR's own diff against its base, so a merge from the base branch alone, like
the CI-fixer commit on production-infra #706, keeps it. The auto-merger then
writes `infra_merge_carried_sha`/`_note`, logs `infra merge approval by <by> for
<X7> carried over to <Y7> (same plan as <X7>, no tofu workflow change)` and
merges like a current approval, with no `claws-noop-merge` label. Otherwise a
head that does not qualify for the zero-change exception blocks as
`infra-approval-stale` with `Infra merge approval not carried over: <rule>;
approve the infra merge again from the board.` The rule is one of `plan for <Y7>
differs from the approved plan for <X7>: now plans|no longer plans <address>
<action>`, `<file> changed since <X7>`, `plan for <Y7> not available
(<detail>)` or `approved plan for <X7> was not recorded` (every approval made
before this rule existed). The board card shows a carried approval as `Infra
merge approved by <by> for <X7>, carried over to <Y7> (<note>)`, and a stale one
as `Approval by <by> was for <X7>; head is now <Y7> — not carried over: <rule>`
(`waiting for the plan of the new head` until the auto-merger has judged it).

A session holding the operator-granted `infra-merge` capability is the other
human merge: its `claws_merge_pr` / `claws_approve_pr_merge` passes
`infraMergeBy` to `attemptMerge`, which skips this gate (both the plain refusal
and the zero-change plan path) but still requires a clean Claws review of the head,
even for an approval-exempt PR, and then every later gate. `tryMerge` and the
sweep never pass it, so the headless auto-merger still refuses infra PRs.

### Plan-stage infra acknowledgement

The Planner declares, per planned PR that changes infra in a repo with a `Tofu
Plan` workflow, the Tofu changes it expects: `claws_save_plan`'s optional
`prs[].infra_changes` `{resources: [{root, address, actions}], workflow_files}`,
validated by `validateInfraDeclaration` (`src/infra-declaration.ts`: non-empty
root and address, at most 200 resources, `*` only as the address's last
character, actions from `add|change|replace|destroy|import`, workflow files that
`isInfraWorkflowPath` classes as tofu/terraform workflow or action files) and
stored as JSON in `claws_issue_prs.infra_changes`.

The operator acknowledges every declaration of an issue at once from the board
card or issue page (`POST /board/infra-ack`), stored in
`claws_issues.infra_ack_by/at/hash`. The approval posts the hash its block
showed (`data-hash`); the route refuses it with 409 and the re-rendered block
when the declarations have changed since, so a re-plan between render and
click is never approved unseen, and refuses any acknowledgement on a closed
issue. The hash is `declarationsHash`: sha256 of
the canonical sorted JSON of each declaring entry's repo and declaration, so a
re-plan that keeps every declaration identical keeps the acknowledgement, and
any change to one makes it stale (`infraAckState`, `src/issue-infra-ack.ts`).

In `attemptMerge`'s infra branch, after the merge-approval check and before the
zero-change exception, `loadInfraAckForPr` finds the PR's planned entry
(`claws_prs.issue_id`, then `findIssuePlannedPRByNumber`; a PR covering two
positions or not linked to its entry has none). With a `current`
acknowledgement the auto-merger reads `getTofuPlanResourceEvidence`: each root's
newest plan comment from a trusted account (same rule as above; with only
untrusted ones the detail is `no plan comment from the Tofu Plan workflow's account`), edited at or after the head commit's committer date, with
its fenced `tofu-plan-resources` block (`root: <dir>`, then
`<address>\t<kind>` lines; production-infra `summarize-plan.sh`, fleet-infra
`tofu-plan-comment.sh`), and a passing `Tofu Plan /` check. The block must
agree with the rest of its comment (`readTofuPlanResourceBlock`): the comment
has its counts line, is not `Output truncated`, names the same root in its
`### Tofu Plan:` heading, and the block lists exactly the `add`, `replace` and
`destroy` counts and at least the `to change` count (imports excluded), so a
list cut short never passes the resources it leaves out. Unavailable
evidence — including `plan comment has no resource list` and `plan comment
resource list does not match its counts` — does not block: the PR falls
through to the zero-change plan exception, so a verified no-op plan still merges
with `claws-noop-merge`, and a hold that path produces names the reason
(`The acknowledged infra changes could not be checked: <detail>.`, or
`; acknowledged resource list: <detail>` in a log-only not-available hold). `matchInfraDeclaration` then requires every non-import change to
match a declared entry with the same root, an equal address (or one its
trailing `*` covers; `[index]` keys match literally) and an action list holding
that kind (a kind the scripts do not emit matches nothing); a plan doing less than declared passes. Every changed
`isInfraWorkflowPath` file must be in `workflow_files`. A mismatch blocks
`infra-undeclared`, reported on the approved PR as `The Tofu plan for head
<sha7> has changes outside the acknowledged infra changes:` with one line per
item (`tofu: <address> replace not declared (declared as change)`, `root
tofu/tailscale not declared`, `workflow file <path> not declared`), ending
`Approve infra merge from the board to merge anyway.` — or, when a board
approval for an older head did not carry over, ending with the
`infra-approval-stale` line instead (`Infra merge approval not carried over:
<rule>; approve the infra merge again from the board.`), so `infra-undeclared`
takes precedence over `infra-approval-stale` but still names it. A match needs a clean
review of the head, logs `infra changes for head <sha7> match the
acknowledgement by <by>; merging`, and goes on through every later gate; just
before merging it adds the `claws-ack-merge` label (a failure skips the cycle,
like the no-op label), and after merging it posts one PR comment saying so.
production-infra's `tofu-apply.yml` refuses any change the merged PR's plan
comment did not list for a PR with that label. The label is removed whenever a
sweep does not merge the PR under the acknowledgement.

A declared PR whose acknowledgement is `none` or `stale` keeps today's path,
and its `infra` and `infra-plan` reasons end `Approve its infra changes on the
issue, or approve this head from the board.` Claws never adds `allow-destroy`
or `ack-rebuild`; a destroy or replacement the plan declared passes the
repo's destroy guard through the approved-destroys block below instead, and
any other stays held as `infra-plan` until the operator labels the PR and its
`Tofu Plan` check passes.

## Approved-destroys sync

Approving an issue through Plan records the tofu destroy consent: a snapshot of
every planned PR's declared `destroy`/`replace` addresses
(`claws_issues.approved_destroys`, `src/destroy-consent.ts`), cleared by a
withdrawal below Plan or a re-plan (#clw_01M70H3K4B7H0SNSAB5XJ8ZFCJ). The
implementer writes the PR's share into the body it opens and labels the PR
`claws-approved-destroys`. The block is the marker comment and a fence per
root, under a `## Approved destroys` heading:

    <!-- claws-approved-destroys -->
    ```tofu-approved-destroys
    root: tofu
    aws_route53_record.example
    ```

The consent writers push a change out themselves: recording or withdrawing it
(`applyIssueApproval`) and a re-plan (`issue-refiner`'s planned-PR store,
`reapproval.ts`'s design-change approval, which also records the consent for
the revised plan when the issue ends up approved through Plan) call
`syncIssuePrsDestroyConsent`, which syncs every open PR of the issue, plus the
PRs the re-plan unlinked, best-effort; the board approval does not wait for
it. The sweep is the backstop. A plan that declares destroys, saved while the
issue is already approved through Plan, withdraws that approval to
Requirements: consent covers only a plan the operator approved.

On every `attemptMerge` (fork PRs are skipped), right after the `claws_prs`
row is read and before any hold or merge gate, `syncPrDestroyConsent` compares
the body's fence-closed blocks with the PR's planned entry's share of the
current snapshot (the entry linked to the PR, else the one at its phase). It
works off the PR list's labels and body, so a PR with no expected block, no
label and no marker in its listed body costs no forge call; any other reads
the live body. When the blocks differ — including a block nobody approved,
which an agent wrote into the body — the body is rewritten with the expected
section (or without one); the label is then added when the expected block is
non-empty, removed when it is empty, and removed then re-added when the
addresses changed. production-infra's `Tofu Plan` also re-runs on the body
edit; bstjohn-blog's runs only on a label change, so the toggle is what
re-plans there. Each change logs one
`synced approved destroys on PR` line with the outcome. A failure logs a
warning and the sweep carries on; the guard then reads the old block, which
fails closed on any mismatch. A sync that changed anything ends that attempt
with the pre-gate skip `destroy-consent-sync` (not persisted, not reported):
the CI status read before the sync predates the `Tofu Plan` run it triggered,
so the next sweep decides the merge. A PR the sweep skips before
`attemptMerge` (`dispatch-guard`, `other-work`) is synced there too. Only
Claws writes the block: the implementer's PR body and `regenerateAndUpdatePRBody`
(CI fixer, review addresser) strip any block from agent-written text, and the
regenerated body's section is rebuilt from the recorded consent rather than
carried from the old body. bstjohn-blog's and production-infra's
`assert-no-destroy.sh` pass a plan only when its destroy/replace set equals the
block's addresses; bstjohn-blog's reads the block only on a PR carrying the
label.

## Merge-blocked status comment

Once `tryMerge` knows a PR is human-approved — its `claws_prs` row carries a merge
approval with a named approver — any
later gate that stops the merge is reported:

- A single Claws comment headed `### Merge blocked`, ending with the
  `claws-merge-status` marker, states the reason (a recorded manual action,
  review not clean, stale review, unreadable changed files, infra paths, CI
  failing or unfinished, N workflow runs held for approval, merge conflicts,
  or a doc/ideas content mismatch). A recorded manual action is
  checked first and reported whenever the row also carries a merge approval,
  before the review and CI gates run; the comment names the recorded reason
  and how to clear it once the step is done: the dashboard's **Clear manual
  action** button or a session's `claws_clear_pr_manual_action` tool; moving
  the linked issue out of `Blocked` does not lift it. No forge label carries it
  (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK). A reviewer escalation records the reason as
  `review escalated: <summary>`, so the comment and badge say what the human
  must settle; approving the merge does not clear it, because the escalated review
  verdict still blocks the merge; the reason clears when a later review round
  is clean or advisory-only. It is edited in
  place when the reason changes and left untouched when the text is
  unchanged. Once the PR merges, by any route, `settleMergedPrState` edits it
  to `### Merged` ("This PR has merged; the block above no longer applies."),
  keeping the marker, and clears the row's merge skip and the queue entry.
- The same reason is kept in memory (`gh.setMergeBlockReason`, 1-hour TTL,
  cleared on merge) and shown as a `⚠ Merge blocked` badge on
  `/prs`. After a restart the badge is empty until the next sweep.

Apart from an image-scan PR held because its diff fails the image-scan gate (see
above), nothing is reported before approval is established — fork, no `claws_prs` row, a
recorded manual action on an unapproved PR, closed, dispatch guard, or no merge approval — or for four transient
states: no checks registered yet on a fresh head, mergeability still `UNKNOWN`
after retries, the head moving between evaluation and merge, an
approved PR whose Claws review status is still `none` — no review of the
current head has run yet (#3122).

Approval-exempt PRs (`claws/docs-`, `claws/ideas-collect-`,
auto-bump, trusted non-major Renovate) are `approved` only when their row carries a
dashboard merge approval; in that case a later block is reported like any approved
PR's. An unapproved exempt PR's blocks stay log-only — failing CI, infra paths, a
docs PR containing non-doc changes — so the job log is the only place that reason
appears.

An approval never adds a review gate to an exempt PR: `isApprovalExempt` is evaluated
before the merge-approval branch, so an approved docs PR merges on green, settled CI
with no Claws review (#clw_01M46YW6WPNPH0545G6KJB1AWD — bonkus #1956–#1958, then
Dependabot PRs, waited 10–15 minutes for reviewer runs after Automerge was pressed on
2026-10-05, while unapproved ones merged at once). A trusted Renovate PR keeps its review gate, approved or not.
`/prs` shows an **Approval-exempt** chip instead of an Automerge button on these rows.

## Red deploy on an earlier step

A plan step that depends on an earlier, merged step does not auto-merge while
that earlier step's deploy is red (#clw_01M6RPD77S4VCG7068KVFN4GEF). A repo
names its deploy workflows in `claws.json` as `deployWorkflows` — Forgejo
workflow file names such as `tofu-apply.yml` ([repo-config.md](../repo-config.md)).

`deployGateBlock` (`src/deploy-gate.ts`) runs in `attemptMerge` after every CI
gate has passed and just before the mergeability check, so only a PR that is
otherwise ready costs the extra reads. It walks the transitive dependencies of
the PR's step in the issue's plan. For each one a merged PR covers, it reads
that PR's merge time and its own repo's `deployWorkflows` — a cross-repo step
uses the dependency's repo — and for each workflow takes the newest run on
that repo's default branch created at or after the merge, ignoring
`cancelled` and `skipped` runs and pull-request-triggered runs:

- `failure` holds the merge as `deploy-red`. The `### Merge blocked` comment
  names the step, the dependency PR, the merge time, the workflow and the
  failed run, and says Claws will merge once a later run succeeds; it is
  reported even on an unapproved PR. The linked issue gets one
  `## Waiting on a red deploy` comment per held PR and failed run, carrying a
  `claws-needs-human:` marker so a restart does not repeat it. The PR shows
  in Needs-you on the dashboard (`OPERATOR_MERGE_BLOCK_CODES`), but the
  issue is not parked in Blocked — its other steps carry on.
- A queued or running newest run holds quietly as `deploy-pending`, so a
  step never merges mid-apply.
- `success`, or no run since the merge, does not hold.

A Forgejo read error fails closed as `deploy-pending` with a `warn` log.
Nothing is stored as a manual action: each sweep re-checks, and the hold lifts
by itself once a later run of the workflow passes. Only the merge is held; the
step is still implemented and reviewed, since building it early is harmless.
An operator can still merge the PR by hand on Forgejo.

The runs are read per workflow (`actions/runs?workflow_id=…`), because this
Forgejo ignores `limit` on that endpoint and an unfiltered read returns the
repo's whole run history.

## Post-merge cleanup for `claws/issue-…` PRs (#3338)

Merging a `claws/issue-<id>-…` PR runs two independent steps
(`finalizeMergedClawsPR` in `src/agents/auto-merger.ts`). This runs for every
merge route, not just this job's own:

- `tryMerge` calls it after a merge it performs itself.
- The dashboard's `POST /queue/merge` calls it after `mergePR` succeeds — a
  cleanup failure there is logged but does not fail the merge response.
- A PR a human merged directly on Forgejo is caught by the PR
  dispatcher's `refreshPrStore`: when a `claws_prs` row linked to an issue
  moves to `merged`, it calls the same cleanup, tagged `hand-merge` in the
  logs, passing the row's `issueId` since it has no branch name on hand
  (see [pr-dispatcher.md](pr-dispatcher.md)). This is how the operator merges
  past a CI or review gate: in the Forgejo UI, never from the dashboard.

The cleanup is idempotent, so running it twice for one merge is harmless.

- **Multi-PR completion**: `loadMergedIssuePhases` reads the issue's phase
  state (its primary repo for a native id) and, once every step is merged or
  claimed and the issue is still open, `closeCompletedMultiPRIssue` posts one
  Implementer comment and closes it as `completed` — steps of a parallel plan
  can merge in any order, so the PR that completes the plan may carry no
  `Closes` line at all. A single-phase plan skips this read entirely, and a
  failed read only logs; the issue-auditor is the backstop.
- **`closeNativeIssuesClosedBy`** honours any `Closes #clw_…` line for
  Claws-native issues, re-reading the PR body rather than trusting a cached
  copy.

`sweepRepo` itself no longer reads issues at all: the `In Review` label and
the reconciling sweep that cleared it were retired
(#clw_01M39G3H99HV6ED4378ZXHER6K). An issue whose PR closed unmerged goes back
to Awaiting plan review on `issue-auditor`'s next daily run.

## Skip reason codes

`claws_recent_job_logs` redacts free-text log messages and returns only the
structured `diagnostic_reason` and `diagnostic_context`, so each skip carries a
`mergeSkip` code (`MergeSkipCode` in `src/agents/auto-merger.ts`) alongside
its human-readable line (#clw_01M4TK4C1E6VHMC09T13HDCBHJ):

| Code | Meaning |
|---|---|
| `fork` | Fork PR |
| `no-record` | No `claws_prs` row |
| `manual-action` | A manual action or reviewer escalation is recorded |
| `stacked` | A `claws/` PR targets a branch other than the default |
| `reapproval-hold` | Held by a design change on its issue |
| `closed` | Live state is not `OPEN` |
| `dispatch-guard` | `isDispatchSkippable` rejected it (from the PR list or live labels) |
| `other-work` | A ci-fixer, conflict fixer, review-addresser or reviewer is running on it |
| `review-not-clean` / `review-stale` | A required clean review of the current head is missing |
| `image-scan-gate` | An image-scan snapshot or prune PR failed its gate and has no approval |
| `not-approved` | Not approval-exempt and no stored merge approval |
| `unreadable-files` | Changed files could not be read |
| `infra` / `infra-plan` | Infrastructure paths, or a Tofu plan with changes or none for the head |
| `infra-approval-stale` | A board infra merge approval for an older head did not carry over |
| `infra-undeclared` | The head's plan has changes outside the issue's acknowledged infra changes |
| `doc-pr-mixed` / `ideas-pr-mixed` | A docs or ideas PR with other files |
| `checks-pending` / `checks-failed` / `checks-held` | CI not finished (or not yet registered on a fresh head), failing, or held for approval |
| `checks-missing` | A settled head has no CI result, nothing carries one forward, and the repo's CI normally reports on PRs |
| `deploy-red` | An earlier plan step's deploy workflow failed on its default branch since that step merged (see [Red deploy on an earlier step](#red-deploy-on-an-earlier-step)) |
| `deploy-pending` | An earlier plan step's deploy workflow is still queued or running since that step merged, or its runs could not be read |
| `conflict` / `mergeable-unknown` | Merge conflicts, or mergeability still `UNKNOWN` |
| `head-moved` | The head moved or was unmergeable at merge time |
| `destroy-consent-sync` | The approved-destroys sync just changed the PR's block or label, so `Tofu Plan` re-runs; the next sweep decides (not persisted) |
| `error` | `tryMerge` threw (logged at warn) |

Query them with `claws_recent_job_logs` and `job_name: "auto-merger:sweep"`:
that filter also matches the `auto-merger` scheduler job, which runs the
sweep for every repo, and the `work:auto-merger:sweep` queue runs. There is
one `merge_sweep_done` entry per repo per sweep, about every three minutes.
Queue rows exist only for sweeps chained after an agent run, so a repo with no
`auto-merger:sweep` rows in the work queue is still being swept.

## Restart durability

Chained `auto-merger:sweep` rows live in `work_queue` on both SQLite and
Postgres, so they survive a restart; `recoverWorkOnStartup` requeues any row
left `running`. The scheduler job needs no recovery — it simply runs again
after boot. The hand-merge close-out is driven by
the `claws_prs` rows, so a merge that happens across a restart is picked up on
the PR dispatcher's next tick.
