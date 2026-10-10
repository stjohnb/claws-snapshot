# Forgejo cutover runbook

**Deep dive. Completed.** This records how Claws' own repository moved from
GitHub to Forgejo (`git.home.bstjohn.net`) and how its release pipeline moved
to Forgejo Actions (#clw_01M45RQ4Q5W61CGKQ3XC6YBPG4). Read it if you need to
understand the current layout, or to repeat a similar move. Claws moved last
because the GitHub App drives pull-request flow for every repo still on GitHub.

The cutover is done. Forgejo is the source of truth for the repo. The GitHub
copy is private and archived, with no push mirror. The GitHub workflows and
the one-off secret export workflow have been deleted. Only
`.github/actions/setup-nix` remains under `.github/`, because the Forgejo
workflows use it.

| Workflow | Before (GitHub) | Now (Forgejo) |
| --- | --- | --- |
| CI | `.github/workflows/ci.yml` | `.forgejo/workflows/ci.yml` |
| Release | GitHub Release + `ghcr.io/st-john-software/claws` | Forgejo release + `registry.home.bstjohn.net/st-john-software/claws` |
| Claude Code release check | read the latest GitHub Release | reads `GET /api/v1/repos/St-John-Software/claws/releases/latest` |
| History cleanup | rewrote the GitHub repo | rewrites the Forgejo repo |
| Dependency updates | Dependabot | Renovate (`renovate.json`; fleet-infra's Renovate CronJob) |
| Session and agent pod image | `ghcr.io/…/claws:<tag>` with `ghcr-pull` | `registry.home.bstjohn.net/…/claws:<tag>` with `registry-pull` |

The release pipeline dispatches fleet-infra's `update-claws.yml` with only a
`tag` input, the same as before the move.

Pre-migration `ghcr.io/st-john-software/claws` tags still exist for rollback.
fleet-infra keeps `ghcr-pull` next to `registry-pull` on `claws-0` and
`claws-prepull` for that reason. To roll session pods back to one of those
tags, set `CLAWS_SESSION_IMAGE` to the `ghcr.io` image and
`CLAWS_SESSION_IMAGE_PULL_SECRETS=registry-pull,ghcr-pull`.

## Why the ordering mattered

A Forgejo release pushes its tag **only** to the LAN registry. The tag never
exists on GHCR. Before the fleet-infra change (fleet-infra "PR 4" in the plan),
`update-claws.yml` only accepted and rewrote a `ghcr.io/…/claws:` reference.
After that change, it rewrites any claws reference to the LAN registry.

- **Fleet-infra PR 4 merged after GitHub was archived (step 5).** Otherwise a
  late GitHub release (GHCR-only tag) would have been rewritten to a LAN
  reference that did not exist.
- **Fleet-infra PR 4 merged before Forgejo Actions were enabled (step 8).**
  Otherwise the first Forgejo release (LAN-only tag) would have been written
  into a GHCR reference that did not exist, and `claws-prepull` would have
  failed to pull.

So PR 4 sat between archiving GitHub and enabling Forgejo Actions, and at no
point could a release dispatch a tag the receiver could not resolve. If a
similar move breaks that order, merge the receiver change and re-dispatch
`update-claws.yml` with the tag.

## Steps (as run)

1. **Preconditions.** The PR adding `.forgejo/workflows/` and a one-off
   secret export workflow merged on GitHub.
   #clw_01M46Y0SPCSBWN4AK81F09QKE0 (session shell on the LAN registry) was
   closed. Claws had no open PRs on GitHub.
2. **Import.** In Forgejo, "New Migration" from GitHub into
   `St-John-Software/claws`: private, **mirror off**, releases included. The
   import fires no push workflows. The repo's **Actions** unit was disabled
   right away (Settings → Units), and the Claws bot was given write access.
3. **Secrets.** GitHub never shows a secret's value, so the one-off export
   workflow encrypted the repo's secrets to an operator's
   [age](https://age-encryption.org) public key and uploaded only the
   ciphertext as a one-day artifact. Only the names a `.forgejo/workflows/`
   file references and that are not Forgejo org secrets were PUT into the
   Forgejo repo: `LAN_REGISTRY_PULL_USER`, `LAN_REGISTRY_PULL_PASSWORD` and
   `SLACK_WEBHOOK_TO_SCRUB`. The artifact and the plaintext were then deleted.
4. **Org secrets.** The Forgejo org secrets `REGISTRY_USER`,
   `REGISTRY_PASSWORD` and `FLEET_INFRA_VERSION_BUMP` were confirmed visible to
   the repo. The release workflow uses them to push the image and dispatch
   fleet-infra.
5. **Archive GitHub.** `St-John-Software/claws` on GitHub was made private and
   archived, with no push mirror, deploy keys or webhooks. This had to follow
   step 3, because an archived repo cannot run workflows.
6. **Host config.** Where the host config overrides `publicSnapshots`, add
   `.forgejo/workflows/history-cleanup.yml` to the claws `scrubPaths`. Forgejo
   names workflows by file, so the claws entries in `prodAlertWorkflows` and
   `mainBuildMonitorIgnoreWorkflows` were re-keyed from `Release`/`CI` to
   `release.yml` and `ci.yml`.
7. **Merge fleet-infra PR 4.** `claws-0` rolled once for the
   `imagePullSecrets` change and still ran the GHCR tag.
8. **Enable Actions and release.** The repo's Actions unit was enabled and
   `release.yml` dispatched. The checks were:
   - the Forgejo release exists, with `Claude Code CLI: x.y.z` as the first
     body line;
   - `registry.home.bstjohn.net/st-john-software/claws:<tag>` exists;
   - the fleet-infra `automation/bump-claws` PR rewrote both manifests to the
     LAN reference and merged;
   - `claws-0` rolled from the LAN registry.

   Then the hold was cleared on the follow-up claws PR that deleted the GitHub
   workflows and moved the session-image default to the LAN registry.
9. **Close #clw_01M48CCX3FGET9ZFTEZ70106KE** as covered by this migration.
10. **After the follow-up PR merged,** dispatch `claude-code-release.yml` and a
    dry-run `history-cleanup.yml` on Forgejo, and confirm both are green.
    Confirm `stjohnb/claws-snapshot` updated from the Forgejo release, and that
    Claws lists claws as a Forgejo repo.

A stale `Build failure: Release` alert from the GitHub workflow will not dedupe
against `release.yml` failures. Close it by hand.
