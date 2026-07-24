# Intent Log

A chronological, append-oriented record of the repo owner's (@stjohnb's) stated
requirements, intentions, and rationale — drawn from human-authored issue/PR
bodies and comments (bot- and Claws-authored content excluded). This captures
*why*, not *what changed*; see git history and `docs/OVERVIEW.md` for the
latter. Entries are never deleted or rewritten. When a later entry supersedes
or contradicts an earlier one, both are kept and the newer is marked as
superseding.

Maintained automatically by the `doc-maintainer` job (#2090) — see
[jobs/doc-maintainer.md](jobs/doc-maintainer.md) for how this file is
populated.

### 2026-07-23 (initial historical capture — issues/PRs closed or merged 2026-06-13 through 2026-07-23)

This is the first run of the human-intent capture feature (#2090), so it
covers the full backlog rather than a since-last-run delta. Grouped by theme
below rather than strict chronological order, since the underlying items span
~6 weeks and group naturally by subsystem.

#### Public-repo snapshot publishing

- Motivation (#1826): share code but not development process. Set up weekly
  (later daily, see below) syncs of private repos to public mirrors
  (`stjohnb/claws-snapshot`, `stjohnb/3d-models`, `stjohnb/TempoStatusBar`,
  `stjohnb/homelab`) that scrub secrets, disable Dependabot, and squash to one
  summarising commit. The author manually un-archives target repos when ready
  ("I will unarchive that repo manually and that shouldn't be automated");
  Claws should never do this itself. The `ideas/` folder must be scrubbed
  before syncing.
- CI workflows should publish in a disabled state — remove/neuter triggers
  rather than omit the files (#1835).
- Public READMEs should diverge in content from the private ones (#1848) —
  initially via an LLM rewrite, but the author later wanted more direct
  control: #1948/#1949 introduced an opt-in `README.public.md` that, when
  present, is published verbatim (no LLM call) and must not mention that the
  repo is a sync of a private one (#1949 explicitly: "don't mention the
  public sync of a private repo bit").
- Sensitive info that leaks into a public snapshot must be fixed by not
  syncing it in the first place (scrub at the source pipeline), not by
  requiring a change in the leaking repo itself (#1962, re: fleet-infra);
  the next sync should force-push to rewrite the exposed history.
- A misfiled issue caused by the sync job (e.g. found via a `stjohnb/*`
  public repo) belongs in `claws`, not in the public target repo (#1875).
- PII scrubbing for the (at-the-time archived) `claws-snapshot` mirror was a
  one-time remediation (#1770, done via PR #1793) — scrub at publish time
  going forward, verified clean of maintainer emails/domains/IPs/paths.
- Extend sync to mirror stable release DMGs for TempoStatusBar (#1851) —
  most-recent-only, skip RC/prereleases, and anchor the public release tag at
  a commit whose tree matches the private source at that tag (#1941), not at
  whatever the target HEAD happens to be — this requires breaking a sync into
  multiple commits when release tags landed since the last sync.
- Sync `fleet-infra` → `stjohnb/homelab` too (#1956).
- **Schedule**: originally weekly; #2106 asked for daily, but kept outside UK
  office hours — landed as 3 AM local time. *Supersedes* the "weekly" framing
  in #1826.

#### Dependency management & Dependabot

- Monitor and action open Dependabot alerts (#1603) — but leave repos with
  scanning disabled alone rather than force-enabling it, and if the App lacks
  the `dependabot_alerts: read` permission, that itself should raise a
  remediation issue.
- Auto-remediation must not indiscriminately pin every alerted package via
  `package.json` overrides (#1739) — no dev/runtime triage, exact pins that
  guarantee future staleness, forcing incompatible majors without
  verification, and no pruning of stale overrides were all flagged as
  unsustainable. Also: minimise dependencies and transitive dependencies
  where possible to avoid the underlying problem recurring (#1739 comment).
- Close/auto-dismiss *stale* Dependabot alerts, not just open ones (#1733).
- Every managed repo should have *some* dependency-management mechanism in
  place — Dependabot in most cases, but whatever fits the codebase; repos
  with no manifests are compliant by definition (#2034). Some repos have
  sub-project build roots (e.g. bonkus's separate iOS directory) that need
  accounting for.
- Failing major-version dependency bumps need a real solution, not a
  blocklist entry in `dependabot.yml` (#2065, following on from a
  bstjohn-blog PR comment).
- The DSPy prompt-capture analysis (#1844, #1828 origin) was allowed to run
  for real production data ("I'm ok to start capturing production prompts...
  We can write to a well known location on disk for analysis and easy
  cleanup") specifically to find `pr-reviewer` cost/behaviour issues — once
  that analysis was done, capture should flip back to **opt-in by default**
  (#1924) since it accumulates sensitive prompt/output data with no retention
  automation. Follow-on: `pr-reviewer` should skip re-review when the
  reviewable diff hasn't actually changed since a rebase/merge, even if the
  head SHA has (#1923).

#### GitHub Actions usage & self-hosted runners

- Hitting the Actions storage quota (#1698) and minutes quota (#1740) should
  trigger continual monitoring, with deduplicated per-repo issues raised when
  a repo is the culprit. Accept that some repos (e.g. with heavy build
  caches) won't get to zero usage — as long as Actions storage isn't used for
  *caching* and artifact retention is low, that's acceptable (#1738). Several
  storage alerts (#1724, #1759) were resolved by one-time operational cleanup
  (purging orphaned caches/artifacts) rather than a Claws code change — the
  monitor was working as designed.
- Move all macOS GH Actions runners to self-hosted (#1855) — mirrors the
  existing Linux self-hosted policy, except mac-os runners remain the one
  Actions-hosted exception the author called out for Actions-minutes
  monitoring (#1740).
- Self-hosted Macs may be asleep; Claws has SSH access and should wake them
  over the network when a CI job is stuck queued (#1959). A bare network wake
  produces only a "dark wake" that re-sleeps within seconds — a bounded
  `caffeinate` assertion is needed to actually hold the machine up through job
  pickup (landed in PR #2035, following #1934's restore-the-manual-step
  correction: "restore those commits. they were intentionally added to
  remove the need for manual steps"). Persistent SSH wake failures for one
  Mac should surface as a per-host alert (#1963), and provide a UI toggle per
  Mac so a laptop taken off the LAN can be silenced (#1980) rather than
  perpetually alerting — used in practice for `Brendans-MacBook-Pro` (#2112,
  no code change needed, alert worked as designed).

#### Sessions, terminal UX, and Claude CLI operations

- Support launching a Claude session with multiple repos at once (e.g. an
  infra repo + an app repo) via a UI checkbox list (#1699).
- Session resume was broken — worktrees were deleted but conversation history
  should survive so `/resume` (or a UI resume action) works; important
  worktrees get pushed as branches anyway so deleting them is fine as long as
  history isn't lost (#1704).
- Session summaries were stuck on "Pending…" — prefer a single summary
  generated at session start over continuously regenerating one (#1706,
  explicitly rejecting the more complex continuously-updated approach); they
  should also be more informative than a generic "Idle at…" given limited
  screen space (#1882), and the list should show one row per session even
  when a session spans multiple repos (#1881); provide a way to view/resume
  session history from the UI (#1883).
- Claude's own memory (in the home directory) is fragile — losing the host
  loses the memories (#1708); needs a durable-storage answer.
- Mobile terminal usability: can't select/copy text (#1671, #1822) — fixed by
  using xterm.js's own selection/copy path instead of relying on native DOM
  copy, which was nearly invisible on the canvas-rendered terminal.
- An iOS app to interface with Claws was requested (#1818) — PWA support
  (manifest, home-screen icons) was the concrete step taken.
- `claude`'s OAuth re-login flow is painful over a narrow browser terminal —
  needed a server-side flow that surfaces the OAuth URL as easily-copyable
  text in the web UI (#2082) — landed as `/claude-auth` (the "Reauth" page).
- Explicit per-capability access model wanted (#1727): sessions should know
  which capabilities are granted, but *not* be told about ones that weren't
  ("no need to inform claude of capabilities that were not granted, that
  will just be noise"). `fleet-infra` needed its own kubectl capability,
  distinct from the existing prod-infra one, since there are two separate
  k8s clusters (#1782). SSH capabilities should be derived from a hardcoded
  list read from `.ssh/config` at refinement time, not read at runtime — and
  trimmed to the hosts that actually matter: `truenas, homeassistant, k3s,
  hetzner-actions-runner, hetzner-beefy-actions, ryzen, k3s-nas, proxmox`
  (#1982). Capability checkboxes shown at session-create time should be
  filtered by which repo is selected, using an explicit
  repo→capability/SSH-host mapping (#2095), with a "view all" escape hatch
  for capabilities outside the default set. The `namey-db` capability was
  later found to be dead (pointed at a retired public DB) and removed
  entirely (#2098) — *supersedes* any earlier assumption that `namey-db` is
  one of the standard capability bundles; `docs/database-schema.md` and
  `capabilities.ts` examples were updated accordingly.

#### Issue/PR lifecycle correctness

- `Ready`/label bugs: a green PR not getting the `Ready` label (#1642, #1730 —
  traced to reviewer confusion) and a green PR keeping the `problematic` label
  after recovery (#1653) both indicate the label-sync logic needs to track
  CI/review state more reliably; #2110 later formalized this as "don't show
  Squash & Merge unless CI is green and review is clean; always show CI
  status."
- Auto-merge not firing on an apparently-mergeable PR (#1623) — a recurring
  class of bug also touched by #1876 ("different agents not agreeing on the
  facts" — prompted a question about whether the reviewer should stop using
  text-only mode).
- A refined-as-"nothing to do" issue, or a no-action Dependabot issue, should
  be filtered out **before** creating the issue in the target repo (#1747,
  #1757, #1769/#1775 — the latter also asked, more broadly, "is alert
  monitoring actually giving us anything except noise?").
- PR review must evaluate the **refined** version of a plan, not force an
  implementation back toward the original/initial issue description that
  refinement had already superseded (#1795). Similarly, PR descriptions
  should reflect what the PR actually contains, not stay pinned to an issue's
  initial framing when refinement changed the implementation (#2028).
- Review-loop churn (#1927, postmortem of bonkus#1513): single-comment
  editing lost per-round reassessment context, there was no blocking/advisory
  distinction, and review-addresser posted a fresh comment every round. Fixed
  by preserving a collapsed audit-log history, adding a `clean`/`advisory`/
  blocking classification, and editing one summary comment per addresser
  round instead of appending.
- A repo can add its own labels (e.g. bonkus's `needs-ios-build`) without
  Claws stripping them, and matching labels across repos should share a
  consistent colour (#1807) — later found to be genuinely dead machinery
  (nothing consumed the labels anywhere) and removed (#1928); *supersedes*
  #1807's premise that the labels were needed long-term.
- "Process all issues" mode wanted for incident-heavy repos (#2103): process
  one issue at a time, auto-refine+merge non-controversial fixes, defer to a
  human otherwise. Two corrections from the initial draft: (1) issue number
  is **not** a valid proxy for priority — "issues may be filed in an
  arbitrary order... a priority ordering must be established by looking at
  all open issues" — landed as a single LLM ranking call over all candidates
  each tick; (2) opting a repo into this mode must be UI-driven, not a raw
  config edit.
- Bonkus's separate triage bot ("kwyjibo") was judged no longer needed after
  a bonkus PR closed the gap (#1612); each managed repo should have Claws
  lifecycle info surfaced so manual sessions don't need re-explaining every
  time (#1657) — folded into the existing doc-maintainer job (via
  `claws-automation.md`) rather than a new mechanism, per the author's own
  suggestion; every repo should also have a `CLAUDE.md` (PR #1658 comment).
- Bookmark-based PR searches broke after Claws switched from a personal
  `gh auth login` account to GitHub App installation tokens for its own `gh`/
  `git` calls (#2104) — PRs are now authored by the App's bot identity
  (`clawsstjohn[bot]`, i.e. `app/clawsstjohn`), which GitHub's involvement-
  scoped dashboard search doesn't match under a `user:` filter. No code
  defect; resolution is to filter by `author:app/clawsstjohn` instead.
- Dashboard aggregate views wanted: all open PRs and all open issues across
  every repo, not just the priority queue (#2096); actionable buttons
  (Squash & Merge, Refined) on those rows reusing existing endpoints (#2099);
  the merge button gated on CI-green + clean-review, with CI status always
  shown regardless (#2110). Empty (0-diff) PRs — e.g. an image-bump PR
  cancelled out by a later merge-commit — should be detected and closed, and
  their linked issue closed too when appropriate (#2111).
- Queue page ordering: open PRs by last-update desc, then open issues by
  last-update desc (#1763).

#### Home Assistant integrations

- Bin-day sensor monitoring (#1650): alert when HA's bin-day sensors have no
  value; run every 15 min; the tracking issue should stay open and track the
  available/unavailable pattern rather than closing on each recovery — later
  tightened from a 24h poll to something hooked into a faster-polling path
  (#1880's comment thread, though the concrete bin-day job itself runs on a
  15 min interval).
- Battery-level device alerting (#1783): one GitHub issue in the HA config
  repo tracks *all* currently-low devices at once, not one issue per device.
- The HA config repo's planner had no live HA access to query entities during
  refinement (#1814) — needed MCP tool access scoped to that repo.

#### Damp meter tracking (new internal tool)

- Track damp-meter readings over time for a fixed set of measurement points
  around the house (#1819), enumerated precisely by location (downstairs
  toilet N/S/E/W, sitting room wall near/centre/far, sitting room bay window
  corner/bay corner/centre bay, Hall Closet Manifold/utility, utility wall
  left/centre/right) — a Hall Closet "utility" point was added after the
  first pass (#1824), which also asked for a weekly deduplicated GitHub
  reminder to log readings.
- Readings must be saved incrementally as entered so a full batch can't be
  lost (#1890); show them as a single combined chart, not per-location
  (#1891, #1904); add wall construction type (masonry/stud) and
  interior/exterior exposure per point (#1900) with contextual guidance text
  so a reading is judged against its own construction type (#1892, #1900's
  comment); the meter's max reading (2.5) is being hit at some points.
- The weekly damp-reminder issue should stay a single open issue rather than
  getting its body rewritten on every check tick (#1999) — deliberately not
  using `ensureAlertIssue()` for this reminder, since that helper is for
  recurring alerts that should be tracked as "occurrences," not one-shot
  reminders that should be left untouched until closed.

#### Infra monitoring, incidents, and postmortems

- Recurring `prod-k8s-monitor` kubeconfig alerts (#1686, #1694, #1703) traced
  to a stale kubeconfig after cluster/Tailscale node rebuilds — Claws should
  be able to refresh the kubeconfig itself via SSH (discoverable via
  Tailscale), and a multi-occurrence issue that was only ever planned once
  (at its first occurrence) needs its plan reassessed as occurrences
  accumulate, not left stale (#1703).
- A 6-hour production Flux reconciliation wedge produced **zero** Flux
  alerts despite the underlying Pod-Failed alerts firing (#1989) — root cause
  was a 2-minute grace-period suppression that a fast-failing Job flapped
  around every ~1 minute, permanently resetting the suppression window.
- A failed Node-version-mismatch deploy + failed rollback caused a ~23h
  outage (postmortem in PR #2057); action items: verify Node ABI
  compatibility before swapping in a new release (#2054, "prevent"), back up
  and restore `node_modules` alongside `dist` on rollback (#2055,
  "mitigate"), and keep re-alerting on Slack while the service stays
  unhealthy after a failed rollback, since Claws's own error-escalation path
  can't fire when Claws itself is down (#2056, "detect").
- After running a postmortem, the author had no formal process and asked
  what practices would help (#1968) — landed as the `/postmortem` skill,
  rolled out via the release process to `~/.claude/skills` so it's available
  from any "prod incident" session, keeping it automated rather than a
  manual per-repo install. Running it end-to-end (#2070) surfaced three
  follow-ups: handle the case where the incident isn't resolved yet at
  write-time (draft status, `pending (#N)` metrics, explicit finalize-later
  step); clarify that the "never write n/a" rule applies to the
  detection-ladder *answer*, not the *change* column; and add a
  prior-incident-of-same-class check to phase 1. The postmortem skill should
  itself be responsible for filing the issues that track its action items
  (#2058), rather than that being a separate manual step.
- Reduce Slack notification noise for routine UI-driven actions (issue
  refined, session created, etc.) — no human needs to be paged for those
  (#1896).

#### Security posture

- The security reviewer was over-flagging attacker-controlled-issue-text
  concerns given Claws is already restricted to private repos — needs to be
  told that context so it doesn't focus disproportionately on that class of
  finding (#1874).
- An OIDC-allowlist finding was rejected (#1792) because the assumed
  default-allow IdP behaviour doesn't hold here — Authentik already enforces
  group-policy bindings upstream, so a parallel in-app allowlist would
  duplicate authorization logic across two systems for no real gain; a
  documentation comment at the callback site was preferred over new code.
  Similarly, client-supplied `X-Forwarded-For` for audit-log attribution was
  judged not worth trusting or even keeping if it's unreliable and only used
  for logging (#1988) — simplest fix is to drop it, not harden it.

#### Audio transcription

- Prior OpenAI/remote-Whisper transcription for WhatsApp voice notes was
  unreliable (OpenAI ran out of credit; the remote Whisper host had less
  uptime than the Claws host) — wanted transcription in-process or
  same-VM (#1920). Landed as a same-VM Whisper server, but it shipped
  effectively off-by-default in two places, so voice notes kept failing
  (#1931, #1975) until both defaults were flipped on (fixed in PR #1979).

#### Other

- The `idea-suggester` job repeatedly logged "Slack bot not configured" even
  though "Slack" (the incoming-webhook integration) was configured — asked
  whether the separate, unconfigured "Slack Bot" integration could be
  decommissioned in favour of the one already in use everywhere (#1071).
  When "Openrouter is out of credits" caused an `email-monitor` failure,
  fall back to Claude for that task instead of failing (#1764).
- Blog post editing (#1849): edit `bstjohn-blog` posts from the Claws UI,
  save drafts server-side first (so edits move between browsers), then push
  to a PR on demand. Editing a post that already had an open PR was
  incorrectly opening a second PR instead of updating the first (#1953,
  fixed in PR #1954) — the duplicate PRs from before the fix were closed
  manually as part of resolving the issue, confirmed against the
  `blog_drafts` DB pointer.
- Explicitly instructed: for the *initial* doc-maintainer intent-capture run
  on each repo, process **all** available issues and PRs, not just a recent
  window (#2090) — this is why this entry covers ~6 weeks in one pass rather
  than the usual since-last-run delta.
