# Refinement: Issue flow — requirements stage, stored PR state, board stages

**Deep dive.** Read this when implementing any phase of the issue-flow redesign
agreed in September 2026. It is the design the phase issues cite; the product
requirements it introduces live in
[product/automation-lifecycle.md](../product/automation-lifecycle.md) and
[product/dashboard-and-integrations.md](../product/dashboard-and-integrations.md).
For the flow as built today read [issue-tracker.md](../issue-tracker.md) and
[claws-automation.md](../claws-automation.md); where this document and those
disagree, those describe the present and this describes the target.

Status: **approved design; phase 1 built, later phases unbuilt.** Each phase
below becomes its own tracker issue; the phase list at the end says what each
one leaves behind.

## Summary

Three changes, designed together because they share one state model:

1. **A requirements stage before planning.** A person files a short note; Claws
   reads the repository and writes a proper requirements record (the text a
   well-run interactive session would have filed); the person corrects it by
   commenting and promotes it; only then does the planner run. Every issue goes
   through it, bug or feature, native or forge-filed, with an auto-promote rule
   for unattended sources so alerts do not stall.
2. **Pull request state lives in Claws' own store.** One row per PR that Claws
   works, carrying its stage, CI and mergeable state, the review verdict of its
   head, and the merge approval with the approving identity. Forge labels become
   a write-only mirror. The issue's `In Review` label, which exists only to say
   "a PR is open", goes away.
3. **The board shows the lifecycle's stages, grouped.** Ideas, Planning,
   Awaiting plan review, Approved, Implementing, PR open, Awaiting merge, Done,
   plus Blocked, with Backlog off the board as now. Human-gate columns are drop
   targets; Claws-driven columns are derived and are not.

## Why

- **Plans are only as good as the issue text.** The planner restates the ask in
  its Requirement section, but it is planning at the same time, on the top
  tier, and the person reviews requirement and plan in one go. Sessions file
  better issues than people type by hand because the session read the code
  first; that pass is worth making a stage of its own, on a cheaper tier, with
  its own gate.
- **PR state is scattered across labels.** `Ready`, `Automerge`,
  `Claws Problematic`, `Manual Action`, `Needs LGTM` and `Billing` are written
  by five agents and read by the auto-merger, the PR dispatcher and the
  dashboard. The queue categories the dashboard shows are an in-memory cache
  rebuilt each dispatcher tick. `pr_reviews` and `ci_fixer_breaker` hold
  fragments. Nothing records who approved a merge, which the product requires.
  Native issues already made this move: `claws_issues.lifecycle` replaced
  their state labels, presented back to the pipeline as labels by a façade in
  `db.ts`, and nothing broke. PRs get the same treatment.
- **`Ready` means two things.** On an issue it is "plan awaits a human"; on a PR
  it is "merge awaits a human". The board's In progress column hides three
  states — implementer running, PR cycling through CI and review, PR waiting
  for a person — and the implementer-running state actually renders in
  Approved, because `In Review` is only applied once the PR exists.

## The lifecycle

An issue's stored lifecycle (`claws_issues.lifecycle`) gains one value and
renames two. The derived states are not stored; the board computes them from
the tasks table and the PR store at render time.

| Column | Stored or derived | Meaning | Who moves it on |
|---|---|---|---|
| Ideas | stored `ideas` | Filed. A requirements record is being written or awaits the person's review. | A human promotes it, or the auto-promote rule does. |
| Planning | stored `planning` | Requirements approved. The planner is queued or running. | Claws, when the plan posts. |
| Awaiting plan review | stored `awaiting-plan-review` (today's `awaiting-review`, label `Ready`) | Plan posted. | A human approves it (today's **Refined**, or Auto-Refine). |
| Approved | stored `approved` (label `Refined`) | Queued for implementation. | Claws, when the implementer claims it. |
| Implementing | derived: a running `issue-worker` task for the issue | The implementer is working. | Claws, when the PR opens. |
| PR open | derived: an open PR row whose stage is not `awaiting-merge` | CI, review and fixes are cycling. | Claws. |
| Awaiting merge | derived: an open PR row at stage `awaiting-merge` | Clean review of the head, CI green, mergeable. Needs the merge approval. | A human approves the merge from the dashboard, or sends it back to PR open by leaving feedback on the PR. |
| Done | derived: `state = 'closed'` | Closed. | — |
| Blocked | stored `blocked` | Parked on something external. | A human, or the dependency link clearing. |
| Backlog | stored `backlog`, off the board | Parked; only a human promotes it. | A human. |

Precedence when several apply stays as `columnFor` has it today: closed, then
unassigned, then backlog, then blocked, then the stored stage, then the derived
PR states. A multi-PR issue with one PR open and its next phase approved stays
in Approved, because `Refined` outranks an open PR exactly as `classifyIssue`
already orders them.

Ideas replaces Inbox as the leftmost column. `inbox` is retired as a stored
value; the migration maps an `inbox` issue with no plan to `ideas` and one with
a plan to `planning`, and `awaiting-review` to `awaiting-plan-review`.

## The requirements record

A new versioned record on a native issue, separate from the plan, in a table
of its own (`claws_issue_requirements`, one row per version). The person's
original note stays as the issue body, immutable, shown as the request. The
record is what the planner reads.

Fields, stored as columns rather than one Markdown blob because code consumes
them, not only the reader:

| Field | Type | Consumer |
|---|---|---|
| `issue_id`, `version` | key | — |
| `title` | text | Becomes the issue's displayed title once approved; the original title stays on the body. |
| `kind` | `bug` or `feature` | Filter and display only. It does not change the flow. |
| `context` | Markdown | Planner. What in the code or the product the ask touches. |
| `requirement` | Markdown | Planner. The ask, restated precisely, with the intended outcome. For a bug: observed behaviour, expected behaviour, reproduction. |
| `acceptance_criteria` | list of text | Planner, PR reviewer, verification. Each one checkable against a PR. |
| `out_of_scope` | list of text | Planner, PR reviewer. |
| `comment_id` | ref | The comment the version was posted as, so discussion attaches to it as plan discussion does. |
| `created_at` | time | — |

On the issue: `approved_requirements_version`, `requirements_approved_by`,
`requirements_approved_at`. Approval is the promotion out of Ideas and records
the identity, per the product rule to verify who approved.

The record is versioned exactly as plans are (`claws_issue_plans`): a new
version per rewrite, older versions viewable, feedback comments refine the
latest version in place through the same unreacted-comment mechanism the plan
uses. The requirements writer posts each version as a Claws comment carrying a
marker, so the issue page's request / requirements / plan / discussion split
works the way request / plan / discussion does today.

### Promotion

- **Attended sources** — the New issue form, a voice note, a session's
  `claws_create_issue` call — wait in Ideas for a human. The issue page and the
  board offer **Promote**; dragging the card into Planning is the same action.
- **Unattended sources** — automation jobs (error triage, monitors, upstream
  watches), forge-filed issues arriving as shadows — auto-promote as soon as
  the first requirements version exists. The tracker records each issue's
  `source` for this.
- A repository's `claws.json` can override either default in either direction,
  keeping repository policy with the repository. `claws_create_issue` accepts an
  explicit `autoPromote` for a session that has already done the investigation.
- A human can promote or demote by hand at any time. Demoting from Planning to
  Ideas cancels the queued planner run and does not discard versions.

### The requirements writer

A new agent kind, run through the same worktree machinery as the planner
(`claude.withNewWorktree`), with the repository checked out, reading
`AGENTS.md`, `docs/PRODUCT.md` and the relevant area doc, and any attachments.
Its contract is `requirements-v1`: produce the record above and nothing else.
No Decisions, no Implementation, no step-back pass; a wrong requirement is
caught at the human gate and costs one comment to fix.

Model plan: a new `requirements` phase in the per-issue model plan, defaulting
to `claude / sonnet`, editable per issue like every other cell, escalated by
`Plan: Deep` the way planning is. Feedback refinement runs on `sonnet` too,
matching how `plan-refine` drops to `sonnet` for a follow-up reply. `sonnet` is
the tier for well-defined work following an established pattern, which
restating an ask after reading the code is; the judgement stays with the
planner on `fable`.

The writer is a per-issue agent run, so the rule that an agent pod holds no
database access still applies: it records its result through the agent-pod
ops API like every other headless run.

### Planner changes

- The planner reads the approved requirements version, not the issue body, and
  hashes it (with the body) into `CLAWS_PLAN_BODY_HASH`, so a requirements
  change after planning triggers a re-plan the way a body edit does today.
- The plan's Requirement section is dropped from the planner contract. The plan
  is Decisions, Implementation, Risks and Verification, unstructured as now;
  the PR list stays in `claws_issue_prs` as today.
- Verification and the PR reviewer receive the acceptance criteria as a list
  to check the PR against.
- An issue with a plan and no requirements record — every issue planned before
  this ships — skips Ideas and keeps its plan. Its plan's Requirement section
  (or the Overview of a headingless plan) stands in, and its hash stays
  body-only. No plan is rewritten; an old plan upgrades itself on its next
  re-plan, which the existing feedback and body-edit paths already trigger. If
  the issue page later wants a Requirements block on every issue, a
  deterministic copy of the latest plan's Requirement section into a
  requirements version is a small separate task, no model involved.

## Pull request state

### The row

`claws_prs`, one row per PR Claws works, native and forge alike:

| Column | Meaning |
|---|---|
| `repo`, `pr_number` | key |
| `issue_id`, `phase` | The issue and plan phase it implements, when it has one (a Dependabot or docs-maintainer PR has none). |
| `head_sha`, `observed_at` | What the last dispatcher tick saw. |
| `stage` | `opened`, `ci-failing`, `awaiting-review`, `addressing-review`, `awaiting-merge`, `manual-action`, `problematic`, `merged`, `closed`. |
| `ci_status` | `passing`, `failing`, `pending`. |
| `mergeable_state` | `MERGEABLE`, `CONFLICTING`, `UNKNOWN`. |
| `review_verdict`, `reviewed_sha` | The latest `pr_reviews` row for the head, denormalised so the board needs no join. |
| `merge_approved_by`, `merge_approved_at` | The merge approval. Replaces the `Automerge` label as the thing the auto-merger reads. |
| `manual_action_reason` | Why a human is needed, when the stage is `manual-action`. |
| `needs_human_review` | Today's `Needs LGTM`: the docs and dependency merge exemptions do not apply. |
| `ci_blocked_reason` | Today's `Billing`: informational. |
| `updated_at` | — |

Whether an agent is working on the PR right now is not a stage; it is a
`work_queue` row, which already exists. The stage is what the pipeline last
decided.

### Who writes it

- The PR dispatcher's tick refreshes `head_sha`, `ci_status`,
  `mergeable_state` and `review_verdict` for every open PR it lists, and
  inserts the row for a PR it has not seen. This replaces the in-memory queue
  cache for PRs; `populateQueueCache` for PRs reads the rows instead.
- The implementer inserts the row when it opens the PR, with `issue_id` and
  `phase`, in place of adding `In Review` to the issue.
- The CI fixer, PR reviewer, review addresser, problematic-PR diagnoser and
  auto-merger set `stage`, `manual_action_reason`, `needs_human_review` and
  `ci_blocked_reason` where they add or remove the corresponding label today.
- The dashboard's Automerge control and Merge button set `merge_approved_by`
  and `merge_approved_at` from the session's identity. The product rule that a
  human-in-the-loop gate checks the approving identity is met here for free.

### Stage transitions a human causes

- **Feedback sends a PR back.** A review or review comment from a human — an
  allowed actor that is not one of Claws' own accounts, attributed by login
  per the product rule — on a PR at `awaiting-merge` moves it to
  `addressing-review` on the next dispatcher tick, so its card leaves Awaiting
  merge for PR open. The review addresser runs, and the stage returns to
  `awaiting-merge` only once the head that addressed the feedback has a clean
  review and green CI. This is what the PR dispatcher does today by removing
  `Ready` when it finds unaddressed review comments; the design keeps it and
  makes the board show it.
- **Feedback does not revoke the approval.** A merge approval given before the
  feedback stays on the row, as the `Automerge` label stays today, and fires
  only when the addressed head passes the merge gate. Withdrawing it is the
  explicit act of turning Automerge off on the card; a person who wants the PR
  held after their feedback does that.
- **Claws' own advisory-only review** does not demote the stage. The addresser
  may still pick nits up while the PR idles at `awaiting-merge`, as it does
  today, unless an approval is present.

### Who reads it

The auto-merger, the PR dispatcher, `work-handlers`, the repo page, the
`/prs` list and the board. The auto-merger's merge gate becomes: stage
`awaiting-merge`, `review_verdict` clean for `head_sha`, approval present from
an allowed identity, no `needs_human_review` unless approved, `mergeable_state`
mergeable, re-read live from the forge for CI and mergeability as today.

### The façade and the mirror

Migration follows the issue lifecycle's precedent:

1. The PR row exists and every writer writes it **as well as** the label. The
   façade at the `github.ts` layer is built but starts **inert**: reads still
   hit the real forge labels, so `pr.labels.some((l) => l.name === LABELS.ready)`
   answers from the forge exactly as it does today, while the row accumulates
   alongside it for comparison only. No reader — the auto-merger's merge gate
   included — trusts the row yet.
2. The issue auditor compares row and labels each sweep and reports any
   disagreement as a fix the way it reports stale `In Review` today. A
   disagreement is a bug in a writer, and the sweep is how it is found, before
   anything downstream depends on the row being right.
3. Once the auditor has swept clean for a sustained run (a week of sweeps,
   say), the operator turns the façade on with a config switch read at call
   time, the way `stepBackEnabled()` is, so it can be turned back off without
   a deploy if the auditor starts reporting again. From then it presents the
   row's fields as the labels the readers ask for, so `pr.labels.some(...)`
   now answers from `claws_prs`, and readers are moved onto reading the row
   directly one by one. Phase 5 deletes the switch with the façade.
4. Labels become write-only: Claws keeps mirroring `Ready`, `Claws Problematic`,
   `Manual Action` and `Needs LGTM` onto the forge for anyone reading the PR
   there, and never reads them. A label a human applies on the forge does
   nothing. `Automerge` applied on the forge is imported into the row once
   during the overlap, attributed to the applying login, then ignored.
5. The `In Review` label and its reconciliation sweep are deleted. "Has an open
   PR" is a join.

Routing labels on PRs — `Priority`, `Claws Staging`, `Use Codex` and the other
provider labels — are copied from the issue by the implementer today. They are
inputs, not state, and this design leaves them alone; a later step can read
them from the linked issue through `issue_id` and stop copying.

### Polling

Everything stays polled; there is no webhook receiver and this design does not
add one. The row is as fresh as the last dispatcher tick, which is what the
queue cache is today. A card in Awaiting merge can therefore lag the forge by
one tick, which the board's refresh note should say.

## The board

Eight columns in three groups, plus Blocked and a Backlog tray, rendered as
grouped headers over the existing `<details>` columns:

| Group | Columns | Kind |
|---|---|---|
| Shaping | Ideas, Planning, Awaiting plan review | Ideas and Awaiting plan review are human gates; Planning is derived from a queued or running planner and is not a drop target. |
| Building | Approved, Implementing, PR open | Approved is a drop target (today's **Mark refined**); the other two are derived. |
| Landing | Awaiting merge, Done | Awaiting merge is derived; its human action is the card's Automerge control, not a drop. Done accepts a drop, which closes the issue. |

Blocked sits between Building and Landing as now, and Backlog stays a tray.

- **Derived columns are not drop targets** and say so on hover, as In progress
  does today; a move into one is refused with the same copy.
- **Human-gate columns carry a visual marker** distinct from derived ones, so a
  glance shows where the person is needed. The hint on each column says which.
- **Cards in PR open carry a chip** for `manual-action`, `problematic`,
  `ci-failing` and `needs_human_review`, so the PRs that need a person do not
  hide among the ones mid-review.
- **Narrow widths:** at the phone tier the three groups stack, and each group's
  derived columns collapse into its header as a count, leaving the gate
  columns open. Per [DESIGN.md](../DESIGN.md)'s form-factor rules the plan
  for the board phase names the tablet layout too.
- The `?repo=` filter, the Done window and cap, and the incomplete-sources
  warning are unchanged.

## Rules that keep it simple

- **One pipeline.** No classifier. Every issue enters Ideas; the only variable
  is whether a human or the auto-promote rule moves it on.
- **Issues with a plan skip Ideas.** Stated above; it is the whole migration
  story for existing issues.
- **Forge issues are unattended.** They are filed by automations, so their
  shadow enters Ideas and auto-promotes. The shadow carries the stages that
  have no forge label (`ideas`, `planning`); the forge labels keep mirroring
  the ones that do.
- **Labels are a mirror, never a control surface, on PRs.** On issues, the
  dashboard is already the control surface; this extends it to PRs.

## Phases

Each phase is one tracker issue, linked `depends_on` the one before it so the
planner sizes each plan to one shippable step.

1. **PR state store.** `claws_prs`, the dispatcher refresh, every writer
   writing the row alongside the label, the inert façade, the auditor
   comparison, the façade's config switch defaulting to off. Leaves behind: a
   row per open PR that agrees with its labels, reads still live from the
   forge, nothing consuming the row except the auditor, and an operational
   step rather than a code one: once the auditor has swept clean for the
   sustained run described above, the operator turns the switch on and
   existing readers are served from `claws_prs`, moving onto the row directly
   as later phases touch them.
   **Built.** The row is written at the `github.ts` layer, as the issue
   lifecycle is: `addLabel`, `removeLabel` and `createPR` mirror the six PR
   state labels into an existing row (`src/pr-state.ts`), so no writer calls
   it directly. Only the implementer's issue link, the dispatcher's refresh
   and its `addressing-review` demotion write the row explicitly. `ci_status`
   also takes `none` for a repo with no CI. See
   [database-schema.md](../database-schema.md#claws_prs-table).
2. **Board reads the store.** Split In progress into Implementing, PR open and
   Awaiting merge; the Automerge control writes the row; retire `In Review`
   and its sweep. Leaves behind: the Building and Landing groups as designed,
   Shaping still Inbox / Awaiting review / Approved.
   **Built.** The board's derived columns read `src/issue-flight.ts`, and
   nothing adds or reads `In Review` any more; with the auto-merger's
   reconciling sweep gone, a PR merged by hand closes its native issue when the
   PR dispatcher's `refreshPrStore` sees its row move to `merged` and runs
   `finalizeMergedClawsPR`. See [issue-tracker.md](../issue-tracker.md#board).
3. **Requirements stage.** The record and its table, the writer agent and its
   `requirements` model-plan phase, `source` on issues, promotion and
   auto-promote with the `claws.json` override, the Ideas and Planning
   columns, the lifecycle migration, the New issue form and
   `claws_create_issue` changes, the issue page's Requirements block. Leaves
   behind: every new issue goes through Ideas; the planner still reads the
   body.
   **Built.** The record and `claws_issue_requirements`, the writer agent
   with its `claws_save_requirements` tool and `requirements` model-plan
   phase, and the issue page's Requirements block with its Promote button came
   first; the writer's tool writes the record to a file its own process reads
   back rather than posting to a service-side run registry, so it works in an
   agent pod. The second PR renamed the lifecycle to `ideas` / `planning` /
   `awaiting-plan-review` with a boot migration, added `source`,
   `auto_promote` and `filed_title`, promotion and demotion (board drop, issue
   page, `POST /issues/:id/promote`), auto-promotion on the first version with
   the `claws.json` `autoPromote` override, the Ideas and Planning columns, the
   New issue form's Requirements choice and `claws_create_issue`'s
   `autoPromote`, and the dispatcher's promotion gate. Planning is a stored
   value, not derived: the lifecycle table above and "dragging into Planning
   is the same action" need it stored, so an Ideas → Planning drop is the
   promotion and a Planning → Ideas drop the demotion. A forge issue's stage
   lives on its shadow; a forge issue that already has a plan is treated as
   past Ideas. See
   [issue-dispatcher.md](../jobs/issue-dispatcher.md#promotion-gate) and
   [issue-tracker.md](../issue-tracker.md#requirements).
4. **Planner reads requirements.** The planner contract drops Requirement and
   reads the approved version; the hash covers it; verification and review
   receive acceptance criteria. Leaves behind: the flow as designed end to
   end.
   **Built.** `src/approved-requirements.ts` loads the version
   `approved_requirements_version` names (never a newer unapproved one) and
   the planner, implementer, PR reviewer, dispatcher and importer share it.
   With an approved record, `issueContentHash` appends a serialisation of its
   content and version to the title and body, so re-approving an edited record
   stales the plan exactly as a body edit does; with none the hash input is
   unchanged, so no existing plan went stale on deploy except one stamped
   body-only against an approved record, which re-plans once. The planner
   prompt shows the record first and the body beneath it as background; the
   contract drops `### Requirement` and the first Decisions item cites the
   version planned against and the product requirement served. An issue with
   no approved record keeps the old contract and body-only hash, and upgrades
   on its next re-plan — no record is synthesised. The implementer gets the
   acceptance criteria and must end with an `## Acceptance criteria` list; the
   reviewer gets them beside the plan and must name each as met, not met (a
   blocking finding) or deferred to another PR, still ending a clean review
   with `review-result: clean`.
5. **Retire PR state labels as inputs.** Readers move off the façade, labels
   become write-only, forge-applied `Automerge` stops being honoured, the
   façade is deleted. Leaves behind: `pr.labels` read nowhere for state.

Phase 5 can follow phase 2 directly; it is last only because it is the one
with no user-visible change.

## Non-goals and rejected ideas

- **A bug-or-feature classifier gating the requirements stage.** Rejected: it
  added a model call, a wrong-guess policy and a second flow for a saving of
  one cheap run per bug. One pipeline with auto-promote covers it.
- **Structured storage for plan sections.** Decisions, Implementation, Risks and
  Verification have no consumer in code; the PR list already has its own
  table. Text stays.
- **A model-driven rewrite of old plans into the current headings.** A planner
  run per issue producing text nobody reviewed; the lazy re-plan path does it
  for free.
- **A webhook receiver.** Polling freshness is what the dashboard has today
  and the store does not change it.

## Open questions

- Whether Implementing and Planning should show the running task's start time
  on the card, as the repo page does for tasks.
- Whether `Plan: Deep` should escalate the `requirements` phase or only
  planning. The design says both; a plan may argue for planning only.
- The name of the leftmost column. Ideas is the working name; Intake was the
  alternative.
