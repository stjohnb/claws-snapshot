# Postmortem process

This document is the standard for writing a postmortem after an incident in any
repository this organization runs. It is prose for a human — read it once to
understand *why* the process looks the way it does. To actually run a
postmortem, use the `/postmortem` Claude Code skill (see [How to run one](#how-to-run-one)
below); don't write one freehand from memory of this doc, because the skill
carries the full checklist and the skill and this document are kept in sync
deliberately.

This process exists because of a real incident:
[St-John-Software/production-infra#841](https://github.com/St-John-Software/production-infra/issues/841).
A stale provider pin met a cloud-API deprecation and destroyed production
servers on merge. The postmortem that Claude produced for that incident was
useful but ad hoc — it was written from a single Claude session's judgment
about what a postmortem should contain, with no fixed structure to check it
against, and it took a human's note to surface the most important finding
(a pre-merge check that looked like it should have caught the change never
actually ran). This document and the skill it backs are the fix: a repeatable
structure that forces the facts-first, ladder-based analysis a good postmortem
needs, instead of leaving it to whatever the model happens to think of on a
given day.

## When to write one

Write a postmortem for:

- Production downtime, however brief.
- Any data loss, even if fully recovered from backup.
- Any incident that required more than one emergency PR to resolve.
- A near-miss that was caught by luck rather than by a working safeguard —
  if the same conditions recur without the lucky catch, would it have been
  an incident? If yes, it's near-miss-worthy.

Do not write one for routine bugs, typical PR review catches, or anything
that was caught by the process working as designed. A postmortem is for when
something got through that shouldn't have, or something broke that matters.
Writing one for every minor bug fix dilutes the practice and trains people to
skim them.

## What "blameless" actually means

Blameless does not mean "no one is responsible" — it means the postmortem
describes the *system* and the *information available at the time*, not the
judgment of the person who acted on it. Concretely:

- No person's name appears in a causal statement. "The engineer merged a PR
  without noticing state drift" is banned; "the PR review surfaced no signal
  of state drift because the change was a workflow-file edit, not a Terraform
  diff" is the same fact, told correctly.
- "Human error" is banned as a root cause. If a human made a mistake, the
  question is always: what made the mistake easy to make, and why didn't a
  system catch it? A person acting reasonably on the information in front of
  them, and still causing an incident, is a system problem — the information
  in front of them was wrong or incomplete.
- This isn't about protecting feelings for their own sake. It's that blame
  makes people defensive, and defensive postmortems produce shallow analysis
  and thin action items ("be more careful next time"). Blameless postmortems
  produce action items that change the system, which is the only thing that
  actually prevents a recurrence.

## Facts before narrative

The single most common way a postmortem goes wrong is that it becomes a
plausible story before it's a collection of verified facts. Plausible stories
smooth over gaps — "the deploy probably picked up the change around 21:00"
— and once smoothed over, the gap is invisible and never gets questioned
again. If a later fact contradicts the smoothed-over guess, the whole
timeline is wrong and nobody notices.

The discipline: gather every fact from an artifact — a `gh` command, a
`git log` entry, a workflow run, a log line — before writing a single
sentence of analysis. Every timestamp gets a source. If something isn't
established by an artifact, it is written as `unknown`, not filled in with
what seems likely. An `unknown` in a timeline is honest and useful — it tells
the next reader exactly where the evidence ran out. A smoothed-over guess
that turns out wrong is worse than useless, because it looks authoritative.

## Contributing factors, not a root cause

Resist the urge to trace a single causal chain back to one root cause (the
classic "5 whys" pattern). Real incidents are rarely one broken thing; they're
usually several conditions that were all individually tolerable and became
intolerable together. A stale dependency pin can sit unnoticed for a long
time. A `paths:` filter mismatch between two related workflows can sit
unnoticed for just as long, waiting for the one PR that happens to touch
only the narrower workflow's trigger surface. An upstream API deprecation can
be announced with plenty of lead time and still go unacted on. None of those
alone causes an outage; the combination does.

List contributing factors as a plain numbered list, one blameless paragraph
each, describing what was true and why it didn't get caught. Don't rank them
by "real" cause vs. contributing cause — they're all just factors, and the
value of the postmortem is in the list, not in picking a winner.

A recurrence of a prior incident's failure class is itself a contributing
factor. Before analysis begins, the process searches `docs/postmortems/` in
the affected repo and closed incident issues for the same failure mode; if
this class of failure has happened before, that recurrence belongs in this
list.

## The detection ladder

This is the heart of the process, and the part most likely to be skipped or
rushed. For every incident, walk seven rungs in order and answer each one —
never "n/a". The question at each rung is the same: **could this rung have
caught the problem before it became an incident, and if not, why not?** That
ban is on the *would-it-have-caught-this* answer specifically; the separate
"what change would make it catch this" column may legitimately read "n/a"
when the rung already suffices or structurally cannot help.

1. **Design / issue refinement.** Was the failure mode foreseeable from the
   plan, before any code was written? If the plan had said "this bumps a
   provider that reads live cloud state," would refinement have asked "what
   happens if that state format changes upstream?" Sometimes yes — and that's
   a process gap in planning. Often no — some failure modes genuinely can't
   be predicted from a plan, and that's a legitimate answer too.

2. **Human PR review.** Was the evidence of the problem visible in the diff a
   reviewer actually looked at? This is where people default to blaming the
   reviewer, and it's usually wrong. State drift, config drift, and
   dependency version bumps are frequently *invisible in a diff* — the diff
   shows only the version number changing, with nothing about what the new
   version will do differently against live infrastructure the next time it
   runs. A reviewer cannot review information that isn't rendered anywhere
   they can see it.

3. **Automated pre-merge checks.** This is the rung to be most suspicious of,
   because it's where "a check exists" quietly substitutes for "a check ran."
   Don't assume a CI check that exists in the repo also *triggered* for this
   specific change — go read the workflow file's `on:`, `paths:`, `branches:`,
   and `if:` conditions and confirm the change actually matched them. **A
   check that exists but was filtered out by its own trigger conditions is a
   silent failure, and it is the single most common finding in this whole
   ladder.** It looks identical from the outside to "the check ran and
   passed" — there's a green checkmark, or no failing check at all, and
   nothing distinguishes "didn't run" from "ran clean" unless you go read the
   trigger config.

   The general invariant this rung exists to check: **any pre-merge check
   that guards an action must trigger on at least every path that triggers
   the action itself.** If an `apply` workflow runs on changes to `tofu/**`
   *and* on changes to its own workflow file, but the `plan` workflow that's
   supposed to preview every apply only triggers on `tofu/**`, there is a
   whole class of change — edits to the apply workflow's trigger config
   itself — that can run a real apply with no plan ever posted for a
   reviewer to see. That is exactly the gap that let #841 through: a PR that
   touched only workflow YAML ran a live `tofu apply` against production with
   zero preview, because the plan workflow's path filter was a strict subset
   of the apply workflow's.

4. **Merge gate.** Required status checks, branch protection, required
   approvals — the mechanical enforcement layer. Even if rung 3's check ran
   and found something, could it still have been merged past a missing
   required-check setting or an admin override?

5. **Deploy-time verification.** A smoke test, a canary, a post-apply
   assertion that checks the world actually looks like what was intended
   before calling the change done. For infrastructure changes, this is
   "does the plan output match what the diff implied," or "does the running
   service respond after the apply."

6. **Runtime monitoring / alerting.** Once the bad state is live, how long
   before something notices? Uptime checks, error-rate alerts, log-based
   alerting. This rung answers "how did we find out" separately from "when
   did it start."

7. **User report.** The rung you land on when every rung above failed. If a
   postmortem's answer to "which rung caught this" is rung 7, that is itself
   the headline finding — every automated and human safeguard missed it, and
   a person had to notice by using the product.

For every rung, the postmortem states plainly whether it *could* have caught
the incident and, if it didn't, exactly why not — citing a checked artifact
(a workflow file's trigger config, a missing alert threshold, an absent
smoke test) rather than a guess. The earliest rung that *could plausibly*
have caught the incident is the **shift-left target** — the rung the primary
action item should aim at. Fixing rung 6 (add monitoring) when rung 3 was
fixable (a filter bug) treats a symptom instead of the defect.

## Metrics

Every postmortem reports three durations, each derived from the timeline
(never estimated independently of it):

- **Time to detect** — from when the defect went live to when it was first
  noticed by any rung.
- **Time to mitigate** — from detection to when the immediate harm stopped
  (even if full resolution took longer).
- **Time to resolve** — from detection to when the system was fully back to
  a known-good state.

These numbers matter less as absolute values and more as a trend across
incidents over time — a repeated pattern of long time-to-detect points at
rung 6 (monitoring) as a systemic gap, independent of any single incident's
specific cause.

A postmortem is often written right after diagnosis, before the fix has
landed. In that case it is a `draft`: the Mitigated/Resolved timeline rows
and the time-to-mitigate/time-to-resolve metrics are written as `pending
(#N)` (the fix or incident issue number), and the incident issue is left
open — closing it would cancel the fix if that issue doubles as the fix
tracker. It is finalized later, once the fix lands: the pending rows and
metrics are filled in from artifacts, Status flips to `final`, and only then
is the incident issue closed.

## Action items

Every action item is classed as one of:

- **Prevent** — stops this exact failure mode from recurring.
- **Detect faster** — shrinks time-to-detect for this failure mode or its
  siblings.
- **Mitigate faster** — shrinks time-to-mitigate, independent of prevention.

Each action item must be independently verifiable — a reviewer, weeks later,
should be able to look at the linked issue and its resolution and tell
whether it actually happened, not just whether someone said it would.
Concretely: "add a path-filter parity check between plan and apply
workflows" is verifiable; "be more careful with Terraform" is not, because
there is no artifact that proves anyone was more careful.

Banned as the *sole* content of an action item (they may appear as one line
in a longer item, but never stand alone):

- "Be more careful."
- "Remember to check X next time."
- "Add documentation" (documentation doesn't prevent a check from not
  running — the code should enforce what the docs describe).

Cap the list at roughly five action items. A longer list dilutes follow-
through — everything becomes low priority. If more than three items seem to
genuinely deserve filing, stop and ask the person running the postmortem
before filing them; more than three is usually a sign the postmortem is
trying to fix everything discovered along the way rather than the specific
failure mode that caused this incident.

File every action item as its own GitHub issue in the affected repository
(`gh issue create`) and record the returned issue number in the postmortem's
action items table — an action item without an issue number is not tracked
anywhere and will not happen.

Filing these issues is how the postmortem instigates the code changes it
identifies — this is a core responsibility of the process, not a bookkeeping
afterthought. Each code-change action item's issue must be self-contained
and actionable without reading the postmortem: it must state what is wrong,
where (the specific file(s)/function(s) or config), why (a one-line link
back to the incident and the postmortem), and a concrete acceptance
criterion, with an imperative title describing the change rather than the
incident. Non-code action items (e.g. a monitoring threshold that lives in
external infra) are still filed as issues per the rule above; the
self-containment requirements above apply specifically to the code-change
items.

Also record items that were considered and explicitly rejected, with the
reason. This is as valuable as the accepted list: it stops the same
rejected idea from being re-proposed cold in a future incident review, and
it shows the postmortem considered a wider set of options than just the
ones that made the cut.

## Where postmortems live

A postmortem for an incident in repo `X` lives at
`docs/postmortems/YYYY-MM-DD-<slug>.md` **in repo `X`** — never in this repo
(`claws`), regardless of which repo's Claude session happened to write it.
This repo has no `docs/postmortems/` directory and shouldn't gain one; no
incidents happen here. If an incident does happen in `claws` itself, its
postmortem still lives under `docs/postmortems/` in the `claws` repo, using
this same process.

## How to run one

Run the `/postmortem` skill in a Claude Code session in the affected repo —
the same kind of session you'd already be using to triage and fix the
incident. The skill walks all seven phases (facts, timeline, detection
ladder, contributing factors, action items, writing, and a self-review
checklist) and writes the postmortem file, opens a PR, and links it back on
the incident issue.

The skill is installed automatically: `deploy/install-skills.sh` copies
`.claude/skills/` into `~/.claude/skills/` on the machine that runs Claws,
and `deploy/deploy.sh` calls it on every release. Because every Claws session
— in every managed repo — runs as the same service user and inherits that
user's `$HOME`, the skill becomes available everywhere with no per-repo
rollout step. You don't need to copy anything into `production-infra` or any
other managed repo for `/postmortem` to work there.

On a developer machine (not the Claws host), run
`deploy/install-skills.sh` directly from a checkout of this repo to get the
same skill under your own `~/.claude/skills/`.

## A note on future automation

If postmortems become frequent enough that consistency starts to slip —
inconsistent formatting, skipped rungs, missing action-item issue numbers —
a natural next step would be a Claws job that files a postmortem stub
automatically whenever an issue is labeled `incident`, so the structure
exists from the start rather than being reconstructed after the fact. That
is not built today, and this document is not a proposal to build it now —
it's a note for whoever revisits this process once there's enough incident
volume to justify it.
