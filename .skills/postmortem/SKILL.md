---
name: postmortem
description: Run a blameless postmortem for a production incident — assemble timestamped facts from GitHub and git, build a timeline, walk the detection ladder to find the earliest gate that could have caught it, then write docs/postmortems/YYYY-MM-DD-<slug>.md in the affected repo and file action items. Use after any incident that caused downtime, data loss, or required emergency PRs, or after a near-miss caught by luck.
---

You are running a blameless postmortem. This skill is self-contained: everything
you need is below, so it works correctly even if nothing else in this repo is
reachable. You are almost certainly running inside a worktree of the repo where
the incident happened, not the `claws` repo — never assume a `claws`-repo-relative
path exists.

Find the template first: try
`${CODEX_HOME:-$HOME/.codex}/skills/postmortem/TEMPLATE.md`, then
`~/.claude/skills/postmortem/TEMPLATE.md`, then
`.skills/postmortem/TEMPLATE.md` relative to the current working directory,
then `.claude/skills/postmortem/TEMPLATE.md`. Use the first one that exists.
If none exists, build the document directly from the section list in Phase 6
below — every section is restated there.

Work through the phases below, in order. Do not skip ahead to writing prose
before the facts and timeline are down.

## Phase 1 — Facts before prose

Gather every fact from an artifact before writing a single sentence of
analysis. Useful commands:

- `gh issue view <n> --repo <owner>/<repo> --comments`
- `gh pr view <n> --repo <owner>/<repo>`
- `gh pr list --repo <owner>/<repo> --state merged --search <query>`
- `gh run list --repo <owner>/<repo> --workflow <file>`
- `gh run view <id> --repo <owner>/<repo> --log-failed`
- `git log --date=iso --format='%h %ad %s'`

Every timestamp goes in UTC with a source link or command attached. If a fact
is not established by an artifact, write `unknown` — do not infer it, and do
not smooth the gap over with a plausible-sounding narrative. An honest
`unknown` is more useful than a guess that turns out wrong later.

Before moving on, search for a prior incident of the same failure class:
check `docs/postmortems/` in the affected repo and closed incident issues
(`gh issue list --repo <owner>/<repo> --state closed --search <failure-class
terms>`) for the same failure mode. A recurrence is itself a finding — if
this class of failure has happened before, record it and carry it into
`## Contributing factors` (Phase 4).

## Phase 2 — Timeline table before any analysis

Build the `## Timeline` table before writing any analysis or conclusions.
Derive time-to-detect, time-to-mitigate, and time-to-resolve directly from
the timeline rows — never estimate them independently of it.

## Phase 3 — Detection ladder

Walk all seven rungs of the `## Detection ladder`, in order. Answer every
rung — the *would-it-have-caught-this?* column must never be left as "n/a";
give a yes/no with a reason for all seven rungs. (The separate *change*
column below may read "n/a" when the rung already suffices or structurally
cannot help — the ban is only on skipping the would-it-catch answer.) The
question at each rung is: could this rung have caught the problem before it
became an incident, and if not, why not?

1. **Design / issue refinement** — was the failure mode foreseeable from the
   plan, before any code was written?
2. **Human PR review** — was the evidence visible in the diff a reviewer
   actually looked at? State drift, config drift, and dependency bumps are
   frequently invisible in a diff — say so plainly when that's the case
   rather than implying the reviewer should have caught it.
3. **Automated pre-merge checks** — *did the guarding check actually trigger
   for this change?* Do not assume a check that exists in the repo also ran.
   Go read the workflow's `on:`, `paths:`, `branches:`, and `if:` conditions
   and confirm they actually matched this change. **A check that exists but
   was filtered out by its own trigger conditions is a silent failure, and it
   is the single most common finding at this rung.** State the general
   invariant when it applies: any pre-merge check that guards an action must
   trigger on at least every path that triggers the action itself. Worked
   example: an `apply` workflow that runs on changes to `tofu/**` *and* on
   changes to its own workflow file, paired with a `plan` workflow (meant to
   preview every apply) that only triggers on `tofu/**` — a PR touching only
   the apply workflow's YAML then runs a live apply with no plan ever posted
   for a reviewer to see. Both rung 2 and rung 3 fail in that example, and
   rung 3 fails specifically because of the path-filter mismatch, not because
   anyone was careless.
4. **Merge gate** — required status checks, branch protection, required
   approvals.
5. **Deploy-time verification** — a smoke test, a canary, a post-apply
   assertion.
6. **Runtime monitoring / alerting.**
7. **User report** — where you land when every rung above failed.

Name the earliest rung that could plausibly have caught the incident as the
**shift-left target**, and record it below the table exactly as
`**Shift-left target:** <rung>`. The primary action item comes from that
rung, not from whichever rung is easiest to add monitoring to.

## Phase 4 — Contributing factors, plural

Write `## Contributing factors` as a numbered list, one blameless paragraph
each. Reject a single-chain "5 whys" — real incidents are usually several
individually-tolerable conditions that combined. Blameless means: describe
the system and the information visible at the time, never a person's name in
a causal statement, and never "human error" as a cause. If a person made a
reasonable decision given the information in front of them and it still led
to an incident, the finding is about the information, not the person.

## Phase 5 — Action items

Write `## Action items` as a table. Each item is classed **prevent**,
**detect** (faster), or **mitigate** (faster), and must be independently
verifiable by someone reading the linked issue later. Banned as the *sole*
content of an item: "be more careful", "remember to check X", "add
documentation". Cap the list at roughly five items; if more than three seem
to genuinely deserve filing, stop and ask the user before filing the rest —
don't file more than three without checking in.

Every action item that requires a code change gets its own GitHub issue
filed with `gh issue create` in the affected repo — this is the mechanism by
which the postmortem instigates the fix; an action item with no filed issue
does not happen. That issue must be self-contained and actionable on its
own: an implementer reading only the issue, not the postmortem, must be able
to make the change, so include what is wrong, the specific file(s)/function(s)
or config to change, a one-line why linking back to the incident and
postmortem, and a concrete acceptance criterion. Title the issue with the
code change imperatively (e.g. `deploy.sh: verify host Node ABI
compatibility before swapping files`), not a restatement of the incident.
Non-code action items (pure process/monitoring-config changes) still get
filed as issues per the rule above. Record each returned issue number in the
table's `Issue` column. Also fill in `## Considered and rejected` with any
item that came up but didn't make the cut, and why.

## Phase 6 — Write and ship

Write the postmortem to `docs/postmortems/YYYY-MM-DD-<slug>.md` **in the
affected repo's current worktree** (this is very likely your current working
directory — create the `docs/postmortems/` directory if it doesn't exist yet).
Use the template found above, or if none was found, this exact section list:

- `# Postmortem: <short description>` followed by a metadata block: Date,
  Author, Status (draft/final), Severity, Incident issue link.
- `## Summary` — three sentences max: what broke, blast radius, resolution.
- `## Impact` — who/what was affected, and for how long.
- `## Timeline` — table with columns `Time (UTC) | Event | Source`.
- `## Metrics` — time-to-detect / time-to-mitigate / time-to-resolve.
- `## Contributing factors` — numbered, one blameless paragraph each.
- `## Detection ladder` — table with columns `Rung | Would it have caught
  this? | Why / why not | Change that would make it catch this`, all seven
  rungs, followed by `**Shift-left target:** <rung>`.
- `## What went well`
- `## Action items` — table with columns `# | Action | Class
  (prevent/detect/mitigate) | Issue | Status`.
- `## Considered and rejected` — table with columns `Action | Why not`.

Open a PR with the new file. The incident issue may not have pre-existed —
incidents reported by a user often get their issue created during diagnosis,
and in the Claws flow that issue frequently doubles as the fix tracker.

Then branch on whether the incident is resolved at write time:

- **Resolved** (the fix has landed and the system is back to known-good):
  fill in the Mitigated and Resolved timeline rows and all three metrics
  from artifacts, set Status to `final`, comment the PR link on the incident
  issue, and close it.
- **Unresolved** (`/postmortem` is being run right after diagnosis while the
  fix is still an open issue — the common case, and note the incident issue
  often *is* the fix tracker, so closing it would cancel the fix): set
  Status to `draft`; write `pending (#N)` (where `#N` is the fix/incident
  issue) in the Mitigated and Resolved timeline rows and in the
  Time-to-mitigate / Time-to-resolve metrics; comment the PR link on the
  incident issue but **leave it open**.

## Phase 7 — Finalize a draft (when the fix lands)

A draft postmortem is not done. When the fix for an unresolved incident
lands, return to the draft and finalize it:

1. Fill in the Mitigated and Resolved timeline rows from artifacts (the fix
   PR merge time, the deploy/recovery confirmation) — same facts-first
   discipline as Phase 1; cite a source for each.
2. Derive the remaining metrics (time-to-mitigate, time-to-resolve) from
   those rows — never estimate independently of the timeline.
3. Flip Status from `draft` to `final`.
4. Only now comment the final link on the incident issue and close it.

Do not close the incident issue while the postmortem is still `draft`.

## Phase 8 — Safety (hard constraints)

- Never paste secrets, tokens, private keys, raw `terraform`/`tofu` plan or
  state output, or `user_data` into the postmortem.
- Never put a person's name in a causal statement anywhere in the document.
- Identifiers already committed to the incident repo in plaintext (e.g. a
  Secret name in a checked-in YAML file, a resource address in Terraform)
  are fair game to name — the postmortem should not be vaguer than the repo
  it lives in. Keep out anything *not* in git: IPs, tokens, keys,
  tailnet/node names, and raw `terraform`/`tofu` plan/state or `user_data`
  output. When unsure whether an identifier is in git, `git grep` it in the
  incident repo before including it.

## Before opening the PR

Answer every item below before you open the PR. If any answer is no, fix it
first:

- Does every timeline row cite a source?
- Are all seven detection-ladder rungs answered in the would-it-have-
  caught-this column (none left blank or "n/a")?
- Is a shift-left target named?
- Is every action item free of "be more careful" as its sole content?
- Does every action item have a filed issue number?
- If the incident is unresolved, is Status set to `draft`, are
  Mitigated/Resolved rows and metrics `pending (#N)`, and is the incident
  issue left open?
