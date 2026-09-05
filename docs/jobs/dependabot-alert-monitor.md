# dependabot-alert-monitor

**Source**: `src/jobs/dependabot-alert-monitor.ts`
**Trigger**: Smart-scheduled (see [OVERVIEW.md](../OVERVIEW.md) "Smart Scheduling")

Polls the GitHub Dependabot Alerts API (`GET /repos/{owner}/{repo}/dependabot/alerts?state=open`)
per repo and auto-dismisses stale alerts in two passes:

1. **SBOM-based pass** (gated by `dependabotAutoDismissStale`, default on) — fetches the repo's
   SPDX dependency graph via `fetchRepoSbomPackages` and dismisses alerts whose fixed version is
   already present in the graph.
2. **Manifest-pin pass** via `dismissAlreadyPinnedAlerts()` — reads the committed manifest file
   (`fetchRepoFileContent` in `github.ts`) for pip `==`-pinned packages using
   `parsePinnedRequirement()` + `manifestSatisfiesPatch()` (which strips pre-release suffixes via
   `versionCore()` before comparing). This handles the common case where the SBOM lags behind a
   committed version bump that the first pass would otherwise miss.

## Suppression sources

Before filing, alerts are suppressed by merging two sources:

- The central `dependabotIgnoredAdvisories` config (keyed by repo full name, or `"*"` for a global
  list, matched case-insensitively).
- A repo-local deferral manifest at `.claws/dependabot-deferrals.json` — a PR-reviewable committed
  file that lets teams consciously defer unfixable alerts (e.g. a major-version bump that breaks
  the build). Read via `fetchRepoFileContent` and parsed by the exported
  `parseDeferredAdvisories(content)` helper, which accepts either a flat `["GHSA-..."]` array or a
  `{ deferrals: [{ ghsa, reason, reviewAfter }] }` object; `reason`/`reviewAfter` are
  documentation-only and never enforced.

When all alerts on a repo are suppressed via either source, the alert issue is closed — giving an
agent-authored deferral PR a durable effect instead of no-op churn.

## Alert issue

Files an occurrence-tracked (`ensureAlertIssue()`, `refreshBody: true`) alert issue listing the
remaining open alerts. The body includes a `REMEDIATION_GUIDANCE` block with ordered steps: prefer
removing unnecessary deps, classify dev vs runtime, bump direct deps before adding overrides, use
`>=` ranges (not exact pins) in overrides. Auto-closes the issue once all alerts clear. No
`Priority` label: open advisories are steady-state hygiene, not an outage, and Priority-queue
flooding is a known problem in this repo. Issues filed before #2809 keep their label; they are not
remediated.

### Automated remediation

Each tick, `classifyRemediation()` decides whether the open alert set is **routine** enough to
implement and merge without a human:

- Every alert's ecosystem must be in `AUTO_REMEDIABLE_ECOSYSTEMS` (currently `npm` only — the only
  ecosystem Claws can install/build/test end-to-end before merging).
- Every alert must have a patched version available.
- The bump from the vulnerable range's upper bound to the patched version must not cross a major
  version (or a minor version while on major `0`, since 0.x is unstable under semver) —
  `rangeUpperBound()` + `isBreakingBump()`.
- The set must have at most `ROUTINE_MAX_ALERTS` (10) open alerts — past that the remediation diff
  is too big to merge unreviewed.

All of these fail closed: an absent/unparseable version or an unrecognised ecosystem makes the set
non-routine.

A routine issue carries the `Automerge` label, which is the only automation needed to fulfil the
rest of the pipeline — `issue-refiner.isAutoRefineIssue()` auto-applies `Refined` after planning,
`issue-worker` copies `Automerge` onto the PR it opens, and `auto-merger.tryMerge()` merges once
the Claws review is clean against the current HEAD SHA and CI is green. A non-routine issue omits
the label and lists its blockers under "Remediation class: needs human review" in the body; a
human must apply `Refined` themselves.

`syncAutomergeLabel()` re-syncs the label in both directions on every tick (adding it if the set
newly became routine, removing it if it stopped being routine), since `ensureAlertIssue` only
passes `labels` when it creates the issue and every alert issue open before this shipped was
created earlier. Stripping the label from the issue does not reach a PR already in flight — that
PR keeps its own copy of `Automerge` and can still merge.

Gated by the `dependabotAutoRemediate` config flag (`CLAWS_DEPENDABOT_AUTO_REMEDIATE` env var),
default on. Set to `false` to always require a human `Refined`.

## Owner requirements

- **Monitor and action open alerts, but never force scanning on** (#1603): repos with
  Dependabot scanning disabled are left alone, and a missing `dependabot_alerts: read`
  App permission raises a remediation issue rather than being swallowed as "no alerts".
- **Stale alerts must be closed/auto-dismissed too**, not just reported while open
  (#1733) — the two auto-dismiss passes above.
- **Auto-remediation must not indiscriminately pin every alerted package** via
  `package.json` overrides (#1739). The flagged failure modes were: no dev/runtime
  triage, exact pins that guarantee future staleness, forcing incompatible majors
  without verification, and no pruning of stale overrides. `REMEDIATION_GUIDANCE`
  encodes the resulting rules, and the broader instruction stands — minimise
  dependencies and transitive dependencies so the problem recurs less often
  (#1739 comment).
- **A failing major-version bump needs a real fix, not a blocklist entry** in
  `dependabot.yml` (#2065). When a `@hono/node-server` major broke CI the ask was
  "We need to resolve this. Can we use an alternative library?" (#2081) — resolved by
  moving to v2 and dropping the then-obsolete `@hono/node-ws`, not by ignoring the
  bump. `.claws/dependabot-deferrals.json` is the sanctioned escape hatch for a
  genuinely unfixable alert, and is deliberately a committed, PR-reviewable file so a
  deferral is a conscious decision with a recorded reason.

## Edge cases

- Leaves repos with Dependabot scanning disabled as-is.
- If the GitHub App lacks the `dependabot_alerts: read` permission, files a remediation issue on
  `SELF_REPO` instead (the permission check runs before the 404/"disabled" swallow, so a permission
  failure is never misclassified as "no alerts").
