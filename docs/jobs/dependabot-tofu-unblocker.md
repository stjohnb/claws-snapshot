# dependabot-tofu-unblocker

**Source**: `src/jobs/dependabot-tofu-unblocker.ts`
**Trigger**: Plain interval, `dependabotTofuUnblockerMs` (default 15 min)

Pushes an empty `ci: run tofu plan` commit onto confined `dependabot/terraform/*` PRs in
`St-John-Software/bstjohn-blog` so the repo's Tofu Plan gate can actually run.

## Why this job exists

`bstjohn-blog` has a `terraform` Dependabot ecosystem for `/tofu`. Every PR it produces edits
`tofu/versions.tf`, which triggers that repo's `tofu-plan-on-pr.yml`. That workflow computes:

```yaml
env:
  TOFU_PLANNABLE: ${{ github.actor != 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == github.repository }}
```

When `TOFU_PLANNABLE != 'true'` the step *"Skip plan — verify no infrastructure change"* diffs
`base.sha..HEAD` and **exits 1** if anything under `tofu/` changed. This is by design: Dependabot
runs get a restricted secret store and no `id-token: write`, so the AWS OIDC role is unassumable
and no real plan can be produced. Merging infra changes unplanned is the exact failure mode this
gate exists to prevent (production-infra#841), so it must stay red until a real plan exists — this
job must never edit `tofu-plan-on-pr.yml`, its `paths:` filter, or its skip guard.

The documented remedy is for a non-Dependabot actor to push a commit to the PR branch: that flips
`github.actor` on the next `synchronize` event, lets secrets/OIDC resolve, and produces a real
plan. A repo-side `pull_request_target` + PAT implementation of this was tried and closed
(bstjohn-blog PR #641) — minting and maintaining another repo PAT was worse than reusing the
credentials Claws already has. Claws' GitHub App installation token already has push access to
these PRs and, unlike a workflow's own `GITHUB_TOKEN`, pushes made with it do trigger downstream
workflow runs, so the unblock belongs here instead.

## How it works

This job is deliberately **deterministic — no LLM in the loop**. The push it makes authorises a
workflow run that holds AWS credentials, so the guards must be code, not judgement.

1. For each configured target (currently just `St-John-Software/bstjohn-blog`), find open PRs
   authored by `dependabot[bot]` on branches matching the target's `branchPrefix`
   (`dependabot/terraform/`), based on the target's `baseBranch` (`main`), with the PR's head repo
   equal to the base repo (`isForkPR()` excludes anything cross-repository).
2. Fetch the PR's changed files (`gh pr diff --name-only`, 60 s-cached) and confirm every path is
   in the target's `allowedFiles` set (`tofu/versions.tf`, `tofu/.terraform.lock.hcl`). Anything
   else: leave the check red and post a decline comment (deduped via the `tofu-unblock-declined`
   marker) explaining why, so a human knows to review the diff themselves. An **empty** changed-file
   list (the diff fetch failed) is treated as unknown and produces no action either way — it is
   never read as "confined".
3. Read the branch tip commit straight from the ref (`GET git/ref/heads/<branch>` +
   `GET git/commits/<sha>`, not the cached PR list). If the tip commit's first message line is
   already the marker (`ci: run tofu plan`), do nothing — this is the recursion break and the
   steady state on every cycle after the first.
4. Otherwise create an **empty commit** via the Git Data API (`POST git/commits` with the tip's
   tree and the tip as sole parent — the PR's head tree is never fetched or checked out) and
   fast-forward the branch ref onto it (`PATCH git/refs/heads/<branch>`, `force=false`). A
   non-fast-forward failure (Dependabot rewrote the branch mid-cycle) is expected and logged at
   info level, not escalated — the next cycle retries against the new tip.

The resulting `synchronize` event has a non-Dependabot actor, so `tofu-plan-on-pr.yml` runs a real
plan and posts it as a PR comment. A human still reviews that plan and merges — only the
unblocking push is automated.

## What this job deliberately does not do

- **Never fetches or executes the PR's head tree.** The empty-commit approach only ever reads a
  tree SHA and commit SHA through the Git Data API; Dependabot-controlled file content is never
  checked out or run.
- **Never force-pushes.** A ref update always uses `force=false`; a race with a Dependabot
  force-push is left to resolve itself on the next cycle.
- **Never edits `bstjohn-blog`'s `tofu-plan-on-pr.yml`, its `paths:` filter, or its skip guard.**
  The gate failing on unplanned infra changes is correct behaviour, not a bug to route around.
- **ci-fixer is excluded from these PRs.** `isUnblockTargetPR()` is checked at the top of
  `identifyPRWork()` before any other classification, so the general CI-fixer never independently
  tries to "fix" a red Tofu Plan check here — this job is the only actor that touches them,
  precisely because its remit is deliberately narrow.
- **Auto-merger still refuses infra PRs** (`gh.isInfraPath` covers `tofu/`), so a human always
  reviews the posted plan and merges by hand; this job only unblocks the plan from running.
- Note also: Dependabot stops auto-rebasing a branch once a non-Dependabot commit lands on it.
  This is expected and acceptable — the PR is merged by a human after reading the plan — and
  recoverable with `@dependabot recreate` if needed.

## Adding a target

`UNBLOCK_TARGETS` in `src/jobs/dependabot-tofu-unblocker.ts` is a code constant, not
`config.json` — these are security guards (which files may be touched, which branch prefix is
trusted), not tunables. To cover another repo with the same shape, append an entry:

```ts
{
  repo: "owner/name",
  baseBranch: "main",
  branchPrefix: "dependabot/terraform/",
  allowedFiles: ["path/to/versions.tf", "path/to/.terraform.lock.hcl"],
  marker: "ci: run tofu plan",
}
```
