import { FRICTION_CATEGORIES } from "../claws-state-tools.js";

export const CLAWS_AUTOMATION_DOC_PATH = "docs/claws-automation.md";

export const CLAWS_AUTOMATION_DOC = `# How Claws automates this repository

Claws is a self-hosted automation service that polls this repo, plans and
implements issues, and reviews/merges PRs via agent CLIs in isolated git
worktrees. This file is maintained automatically by the Claws doc-maintainer —
do not edit it by hand (changes are overwritten on the next sync).

## Where issues live

New issues are filed in [Claws' own tracker](https://git.home.bstjohn.net/St-John-Software/claws/src/branch/main/docs/issue-tracker.md), not on the
forge. A native issue's id is \`clw_…\` — written \`#clw_…\` in PR bodies and
prose (e.g. \`Closes #clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC\`) since Forgejo does
not linkify it. Agents file one with the \`claws_create_issue\` MCP tool; a human
uses the dashboard's New issue page. The forge is only for issues a human
files there by hand — the \`issue-importer\` job mirrors those into the tracker
on its own timer, normally within about half an hour. An issue names every
repository the work touches; the alphabetically first is its primary repository,
which owns planning and labels, and one plan covers the PRs in all of them — no
companion issues. The issue is listed under every repository it names.

## Issue & PR labels

An issue's approval is not a label: it is one stored value on the issue (see
Approval gates below). On a PR, the three state labels — **Claws Problematic**,
**Needs LGTM** and **Billing** — are informational: a write-only
mirror of the PR state Claws stores in its own \`claws_prs\` row. Claws applies and removes them so the PR reads accurately on the forge, but no
decision ever reads one back, so adding or removing one on a forge PR changes
nothing. Change PR state from the dashboard instead.

- **Priority** — high-priority; processed first in all Claws queues, ahead of every non-Priority item whatever its pipeline stage; the label is re-read on each dispatcher pass and again just before an agent starts. Incident labels (\`grafana-alert\`, plus any a repo lists under \`incidentLabels\` in \`claws.json\`) are treated the same in the work queue.
- **Blocked** — parked on an external precondition (an upstream release, another repo's PR, a delivery). Claws skips the issue entirely until the label is removed. It means "not yet": use **Backlog** for "not now", or close the issue as not planned for "not ever".
- **Backlog** — parked for later: off the \`/board\`, listed on \`/backlog\`, and skipped by every Claws job (no planning, auditing or dispatch). Unlike **Blocked**, nothing automated removes it (the planner only *sends* operator-task verdicts here) unless it was parked *until a date*: once that day passes Claws brings a native issue back, checks its plan against the current state (keeping or revising it) and tells the operator. Otherwise a human promotes it back onto the board (Drafting, Requirements review or Planning) from \`/backlog\` or by removing the label.
- **Claws Staging** — opt in to the staging activation state's issue/PR pipeline. Staging only acts on live issues and PRs with this label; active/production Claws skips them. **Blocked** and **Backlog** still stop work, and this label does not approve a plan, review, CI gate, or merge.
- **Claws Problematic** — informational mirror: the PR exceeded CI-fix attempts and needs manual intervention. Clear it with **Unmark problematic** on the dashboard's \`/prs\` page, which also resets the CI-fix budget; removing the label on the forge does nothing.
- **Duplicate** — duplicate; the canonical issue is implemented instead.
- **Billing** — informational mirror of a CI spending-limit block recorded on the PR's \`claws_prs\` row; Forgejo Actions exposes no billing annotations, so Claws no longer sets it, and removing it on the forge does nothing.
- **Plan: Deep** — plan this issue with the best available model at maximum reasoning effort, on whichever provider is selected.
- **Use Claude** / **Use Codex** / **Use OpenCode** / **Use Pi** — force that provider for one issue or PR when it is enabled (weight 0 counts: such a provider is out of the random draw and runs only when pinned). Do not apply multiple provider labels at once; weighted provider selection is used when they conflict.
- **Needs LGTM** — informational mirror: this PR is never exempt from the approval requirement, whatever its branch, and merges only once you approve the merge from the dashboard. Claws sets it on PRs written by a provider that is still on trial for a job (currently \`doc-maintainer\` on Codex), so a docs PR that would otherwise auto-merge waits for you to read it. A dashboard approval lifts it; removing the label on the forge does nothing.
- **Manual Action** — retired; Claws no longer applies it and removes it from repos. A PR that needs a manual step (for example, setting prod secrets) before it can merge carries that step as a hold on its \`claws_prs\` row instead: CI-fix and review work the PR as normal, and the hold gates only that PR's merge: the issue is not moved to Blocked, so Claws keeps implementing, reviewing and merging its other steps. Once the PR is otherwise ready to merge Claws comments once on the issue naming the PR and the step, and Needs-you lists it as **Manual action pending**. Only **Clear manual action** on \`/prs\`, or the session tool \`claws_clear_pr_manual_action\`, lifts the hold once the step is done; moving the issue out of Blocked never does. While a PR has an unmet manual action — its own, or an open operator step on its issue's plan — \`/prs\` and the issue page's PR list name it in a warning, and \`/prs\`'s Merge and Automerge buttons ask you to confirm before acting.
- **Refined**, **Ready**, **Ship**, **Claws Auto-Refine** and **Automerge** — retired: an issue's approval is its stored approval value (below), and Claws removes these labels from repos. Applying one on a forge issue or PR approves nothing.

### Approval gates

An issue passes three gates in order — **Requirements**, **Plan**, **Merge** —
and Claws stores how far a human has approved it as one value,
\`approved_through\` (\`none\`, \`requirements\`, \`plan\` or \`merge\`), with who
set it and when. A forge issue keeps it on its tracker record. The value is
what drives the pipeline:

- **Requirements** — the requirements record is approved; the Planner writes
  a plan and the issue waits in **Awaiting plan review**.
- **Plan** — Claws implements the issue and opens its PRs. This is the only
  thing that makes Claws implement an issue. Approved before a plan exists,
  it is a pre-approval: Claws implements the plan it writes without stopping
  for review, unless the Planner's step-back verdict says \`reconsider\` or a
  human comments after the approval and the issue is re-planned — then the
  Planner lowers the approval to Requirements and the new plan waits for
  review.
- **Merge** — Claws merges each of the issue's PRs once CI is green and the
  Claws review of the current commit is clean. Approving through Merge
  approves every earlier gate too, so use it only when you trust what Claws
  will build.

Set it from the approval track on a board card or the issue page — the
**Approve requirements** / **Approve plan** / **Approve merge** button approves
the next gate, the **& plan** / **& merge** buttons attached to it approve
further ahead, and the ⋯ menu (or a plain button) withdraws
(**Withdraw merge approval** drops the issue back to Plan, **Withdraw plan
pre-approval** drops it to Requirements) — or from a
session with the \`claws_set_issue_approval\` MCP tool. Approval cannot drop
below Requirements; send the issue back to Ideas instead. Each card, the issue
page, \`claws_get_issue\` and \`claws_list_issues\` show a **Stops at** line
naming the next place Claws will wait for a human — "Stops at: requirements
review", "Stops at: plan review",
"Stops at: merge approval", "Runs to merge — no further stop", or an
unplanned stop such as Blocked or a reviewer escalation. An issue sitting in
**Awaiting plan review** with Stops at: plan review will never produce a PR on
its own until someone approves its plan.

### Native issues (\`clw_…\`)

A native issue has no forge copy, so the Forgejo API cannot label it. From an interactive session, set its approval with the
\`claws_set_issue_approval\` MCP tool (it answers with the issue's column and
its Stops at line), apply or remove **Blocked** and **Priority** with the
\`claws_set_issue_label\` MCP tool, promote an issue out of Drafting or Requirements review with \`claws_promote_issue\` (\`claws_get_issue\` returns its stage and requirements record), and read or
set its per-phase model plan with \`claws_get_issue_model_plan\` /
\`claws_set_issue_model_plan\`. The same session also has the issue page's other
actions: \`claws_set_issue_label\` applies or removes its other labels (e.g.
**Plan: Deep**, **Use Codex**, **Use Claude**), \`claws_set_issue_state\` closes
it as completed or not planned or reopens it, \`claws_edit_issue\` edits its title
or body, \`claws_delete_issue_comments\` soft-deletes comments the operator has
confirmed, \`claws_save_issue_requirements\` stores a revised requirements record
as a new, unapproved version, \`claws_set_issue_repos\` sets its repos, and
\`claws_set_issue_column\` moves it to a board column. Each change passes the same checks as the
dashboard and is recorded as made by the session. A Forgejo issue is edited
through the Forgejo API.

## Lifecycle

1. An issue a human files by hand starts in **Drafting**, where Claws writes a requirements record for it — the problem and the outcome it needs, not how to build it. Once a version is stored it sits in **Requirements review** for you to read; feedback you leave sends it back to **Drafting** until the writer stores the next version. Promoting the requirements moves it to **Planning**, where a Planner posts an implementation plan as a comment and moves the issue to **Awaiting plan review**. An issue filed by an automation, a headless agent or an interactive session (\`claws_create_issue\`) skips the requirements record and goes straight to **Planning**, where the Planner plans from its title, body and comments — so write the body as the full problem statement. The New issue form can skip the record for a hand-filed issue too.
2. When the plan looks good, a human approves the issue through **Plan** (the card moves to **Approved**). Nothing is implemented until this happens, unless the plan was pre-approved (see Approval gates).
3. Claws implements the approved issue on a \`claws/…\` branch and opens a PR.
4. PRs are auto-CI-fixed, reviewed, and (once the issue is approved through **Merge**, or the PR's own merge is approved, with a clean Claws review of the current commit and green CI) auto-merged.

### Merging

Approving the merge of a green, cleanly-reviewed PR from the dashboard is what merges it: the merge approval on a board card's or the issue page's approval track (approving the issue through Merge, which covers each of its open PRs and the next one Claws opens), the Automerge control on \`/prs\` or the Merge button (that one PR), or a session's \`claws_set_issue_approval\` or \`claws_approve_pr_merge\` records the approval, with the approver's identity, on the PR's \`claws_prs\` row. That stored approval is the only one Claws accepts. Applying a label such as the retired **Automerge** on a forge PR does nothing, and neither does a bare \`LGTM\` comment, on the forge. Claws re-evaluates open PRs for merge about every three minutes, so a merge normally lands within about three minutes of the approval. If it cannot merge an approved PR, it edits a single "Merge blocked" comment on the PR saying why. An interactive session does not wait for that pass: when a PR's merge is already approved and it is ready now (green CI, a clean Claws review of the head, no hold), the session merges it with \`claws_merge_pr\`, which applies the same checks, refuses with the reason when one fails, and records the merge as \`session:<id>\` with a comment on the PR saying the session merged it directly. A PR touching infrastructure paths is refused there too, unless the operator has granted the session the \`infra-merge\` capability: its merge then counts as the human merge, a clean Claws review of the head and every other check still apply, the PR comment names the capability, and the auto-merger itself still never merges such a PR. A session approves the issue through Merge with \`claws_set_issue_approval\` to approve a merge, or to queue a PR that is not ready yet for the auto-merger. When the operator tells it to merge one particular PR — the issue has other PRs that must not merge yet, or the PR has no native issue — it records a single-PR approval with \`claws_approve_pr_merge\` instead: stored as \`session:<id>\` on that PR's \`claws_prs\` row only, without raising the issue's approval, then merged through the same checks; a refusal withdraws the approval unless the session asked to queue it, in which case the auto-merger merges that PR alone once it is ready. It merges through the Forgejo API. Third-party update PRs merge without a dashboard approval when they are Renovate's from a trusted identity (the Forgejo \`renovate\` account, or an allowed human actor's PAT, as fleet-infra's Renovate uses) and not a major update. Such a PR may not touch infrastructure (tofu/terraform) paths or carry a recorded manual action, needs a clean Claws review of the current head and passing CI, and merges at any hour once green. No label is ever read as approval, so a major update, or any other PR, still waits for a dashboard approval, and \`/prs\` marks such a PR **Awaiting approval**. \`/prs\` offers All, Dependencies, Other and Blocked views (\`/prs?kind=deps\`) over one flat list the operator can also filter (repository, author, author type, label, CI, draft, review, merge, title) and sort (updated, created, repository, title, author, CI) from query parameters kept in the address; a bare \`/prs\` shows all PRs sorted by created, oldest first, and under that default sort the Dependencies view lists PRs needing a human decision before those Claws will merge itself.

## Multi-PR issues

Some plans split an issue into an explicit sequence of PRs, one per
\`### PR 1:\` / \`### PR 2:\` header in the plan comment. Claws implements one
step per dispatcher cycle. The issue is approved through Plan once, for the
whole plan: Claws implements each step in turn as the steps it depends on
merge, with no re-approval between steps.

Claws works out which steps are done from *any* PR that references the issue and
carries a phase marker — so if you take a step by hand, mark it the way Claws
does or Claws will implement it again:

- Title the PR \`fix: <step title> (N/M)\` and begin the body with
  \`## PR N of M: <step title>\`, followed by \`Part of #<issue>\` (or
  \`Closes #<issue>\` only when every other step has already merged). Claws resolves the issue from the
  branch and body, so the ref is not needed in the title.
- For a step that produces no PR at all — a manual apply, a workflow dispatch,
  work already covered elsewhere — comment on the issue with
  \`claws-phase-done: <numbers>\` (a comma list or a hyphen range).
  Only comments from allowed actors count, and the claim must be the first
  text on its own line: a mention inside a code fence, inside a blockquote or
  mid-sentence is discussion, not a claim, and a comment carrying the
  "Automated by Claws" footer is never read as a claim.

Each step depends on the previous one unless its header says otherwise:
\`### PR 3: <title> (after PR 1)\`, \`(after PRs 1 and 2)\`, or \`(parallel)\` /
\`(independent)\` for a step that needs no earlier step. The planner declares a
step parallel only when its files are disjoint from every step it does not
depend on, and records the same list as the step's \`depends_on\`. The
\`claws_issue_phases\` MCP tool reports each step's dependencies and whether it
is ready (every step it depends on, transitively, has merged or been claimed).
When you take a step by hand, a parallel step can be started from the default
branch while its siblings' PRs are still open; keep it inside the files its
section names so the sibling PRs do not conflict.

While a step's PR is still open, Claws waits before starting any step that
depends on it: its worktrees branch off the default branch, so a dependent step
begun before its prerequisite merges would be built without it. A step with no
unmet dependency starts on the next dispatcher tick even while sibling steps'
PRs are open, possibly in other repos. The issue closes once every step has
merged or been claimed, in whatever order they land.

### Manual (operator) steps

Operator work that is not a PR — importing a repo, adding secrets, registering
deploy keys, re-pointing Flux, archiving the source — goes under a
\`### Manual actions (operator)\` heading after the last \`### PR N:\` section
(\`Manual action\`, \`Manual cutover\` and \`Manual steps\` at \`##\`–\`####\` are
recognised too). \`claws_save_plan\` turns that section into one more step, after
every PR and with no PR of its own, so the issue does **not** close when the
last PR merges. When a PR needs the step's output, its \`prs[]\` entry sets
\`after_manual_actions: true\`: the step is stored just before the first such
PR, which is not started until the step is claimed done:

- The step is never ready for the implementer. Once every step it follows has
  landed, \`claws_issue_phases\` lists it with status \`manual\` (and in
  \`awaitingOperator\`), and the auto-merger (or, when no PR is open or ready,
  the implementer) moves the issue to **Blocked** once, quoting the section as the reason and asking for
  \`claws-phase-done: N\` (marker \`claws-awaiting-operator\`), with a Slack
  ping. Moving the issue out of Blocked does not mark the step done.
- The issue closes on the dispatcher tick after an allowed actor comments
  \`claws-phase-done: N\` for that step and the issue is out of Blocked, or
  when someone closes it. The issue
  auditor leaves an issue awaiting its operator alone — it does not move it
  back to Awaiting plan review.
- A PR whose step the plan orders after an operator step carries that step in
  its \`prs[]\` entry as \`manual_action_before_merge\` — a merge hold only,
  unlike \`after_manual_actions\`, which holds the PR's start. The implementer records it
  as a hold on the PR's \`claws_prs\` row, under a "Manual action required
  before merge" body section, with no label and no stage of its own: CI-fix
  and review work the PR as normal. Once the PR is otherwise ready to merge
  (green CI, clean review of its head), Claws comments once on the issue
  naming the PR and the step, without moving the issue to **Blocked**, so its
  other steps carry on; the auto-merger holds the PR even when the issue is
  approved through Merge. Once the step is done, **Clear manual action** on \`/prs\` or the
  session tool \`claws_clear_pr_manual_action\` lifts that PR's hold and it
  merges under the usual rules; moving the issue out of Blocked never does.
  When the step is one CI needs — CI is failing and the CI fixer gave up on
  the PR's head — Claws moves the issue to **Blocked** with a reason naming the
  PR and the step, unless another of its steps is ready or in flight, when it
  comments once instead; it moves the issue out of Blocked on its own once the
  hold is cleared, CI stops failing, or the PR merges or closes. An
  implementer's own \`MANUAL-ACTION-BEFORE-MERGE\` note is recorded the same
  way, its text as the reason.
- Until the step is claimed with \`claws-phase-done: N\`, \`/prs\` and the issue page's PR list show a warning
  on the issue's PRs — "Manual action before merge: …" for a PR's own action,
  "Operator step pending: …" for the open step — and \`/prs\`'s Merge and
  Automerge buttons ask for confirmation first. The issue page lists the step
  as an **Operator step** row. While the issue is in Blocked the board shows
  it there; once it is out of Blocked with the step still unclaimed, it sits
  in Awaiting merge with an **Awaiting operator** chip.

Because the manual step counts as a step, PR markers number against it: a
two-PR plan with a manual section opens \`(1/3)\` and \`(2/3)\`, and its last PR
says \`Part of #<issue>\` rather than \`Closes\`.

Operator steps are only for work no automation can do: a secret or credential, a
physical or hardware action, a third-party account or order, or an approval
reserved for a human. Never use one for post-merge verification, re-running or
\`workflow_dispatch\`-ing a workflow, or checking a deploy or published page —
put any check the plan needs into CI, and Claws raises main-branch failures
automatically. \`claws_save_plan\` rejects a manual step that is only that.

## Forgejo-hosted repositories

Every repository Claws manages is hosted on Forgejo, which owns its issues,
pull requests, releases and default branch. Claws manages no work on GitHub:
a GitHub copy is archived, or a public snapshot Claws pushes a scrubbed copy
to, and is never authoritative. Read and write a managed repository through the Claws MCP tools or
the Forgejo API, never \`gh\`. Its CI and release workflows live in
\`.forgejo/workflows/\` and run on Forgejo Actions, its releases are Forgejo
releases, and its dependency updates come from Renovate rather than
Dependabot. Forgejo review approvals and \`LGTM\` comments never count: the
dashboard's merge approval (the issue approved through Merge, or the PR's
own approval) is the only approval Claws accepts.

## Contributing — all changes land via pull request

All changes land via pull request — never commit or push directly to
\`main\`, even for small or "inert" changes such as docs, config, or binary
assets. Branch, push the branch, and open a PR; let CI and review run before
it merges. This applies to humans and to agent sessions alike, and it holds
even when a change looks too trivial to be worth a PR.

This is a convention, not an enforced rule — \`main\` is not branch-protected,
so nothing stops a direct push except following this.

## Scheduled reminders

Time-based reminders (credential rotation, certificate renewal, licence expiry)
live as Markdown files in \`docs/scheduled-reminders/\`. Claws reads this
directory on the default branch once a day and files an issue in this repo when
a reminder's \`notify_on\` date arrives.

File format — YAML frontmatter followed by the exact steps in Markdown:

\`\`\`markdown
---
id: aws-deploy-key-rotation      # optional; defaults to the filename
title: Rotate the AWS deploy access key
notify_on: 2026-09-01            # YYYY-MM-DD — when Claws files the issue
expires_on: 2026-10-01           # optional — when the credential stops working
owner: stjohnb                   # optional
priority: true                   # optional; false files without the Priority label
---

1. Step-by-step instructions the agent must follow...
\`\`\`

Each reminder fires once per \`notify_on\` value. When completing a reminder,
update \`notify_on\` (and \`expires_on\`) in the same PR to arm the next cycle,
or delete the file if the reminder is no longer needed.

## Working manually in this repo

When running a manual Claude session in this repo, follow the lifecycle above:
file or update an issue in the Claws tracker and let Claws plan and implement
it. The default role of a session is to monitor and steer that pipeline: review plans, approve
an issue through Plan after human approval (or, under an explicit \`/ship <scope>\`, once the session has checked the plan itself), watch PRs and deployments, verify follow-up
plan changes, and inspect Claws state when needed. Do not invoke the
\`.agents/\` role documents (\`issue-refiner\`, \`issue-implementer\`,
\`pr-reviewer\`) as subagents — they exist for the automation pipeline, which
injects them into its own headless runs. Refer to \`docs/PRODUCT.md\` for
what the product must do and \`docs/OVERVIEW.md\` for repo-specific
architecture. To drive a feature end-to-end through those gates, invoke the
\`/ship\` skill.
`;

/**
 * Always injected via a prompt file read by `--append-system-prompt-file` into
 * interactive Claude sessions (`sessions.ts`) so a session follows the Claws
 * issue/PR lifecycle instead of invoking the repo's `.agents/*` role documents
 * — those exist for the headless pipeline (readRepoAgentDoc), not as session
 * subagents (#2360).
 *
 * `gateWritesAvailable` names the session-only native-issue write tools
 * (`claws_set_issue_approval`, `claws_set_issue_label`, `claws_promote_issue`, `claws_set_issue_model_plan`,
 * `claws_set_issue_state`, `claws_edit_issue`, `claws_delete_issue_comments`,
 * `claws_save_issue_requirements`, `claws_set_issue_repos`,
 * `claws_set_issue_column`) only when the session actually has them — the
 * `/mcp/sessions/:id` endpoint, which holds a per-session credential those
 * routes require (#clw_01M3BWP83BQRXE06NWW1GKYT2S).
 *
 * INVARIANT: this text must contain no "=" character (the #2138
 * credential-leak guard, asserted by `claws-info.test.ts`).
 */
export function sessionWorkflowPrompt(gateWritesAvailable: boolean): string {
  const approvePlanNote = gateWritesAvailable
    ? " with the `claws_set_issue_approval` MCP tool"
    : " (this session cannot set it, so ask the user to click the Plan gate on the issue's board card or page)";
  const gateWritesParagraph = gateWritesAvailable
    ? "\n\nA native `clw_…` issue has no forge copy, so the Forgejo API cannot change it. Move it through the gates the user is driving with the session-only MCP tools instead: `claws_set_issue_approval` sets how far the issue is approved — `through` `requirements`, `plan` (Claws implements it; set before a plan exists, it pre-approves the plan Claws writes) or `merge` (Claws merges each of its PRs on green CI and a clean review) — and answers with the issue's board column and its Stops at line, the next place Claws will wait for a human; it cannot lower an issue below `requirements`, which is a send back to Ideas instead. `claws_get_issue` and `claws_list_issues` return the same `approved_through` value and Stops at line. `claws_set_issue_label` applies or removes **Blocked** and **Priority**; `claws_promote_issue` promotes an issue out of Drafting or Requirements review once the user has approved its requirements (an explicit `/ship <scope>` counts as that approval for its in-scope issues), which `claws_get_issue` returns with its stage; `claws_get_issue_model_plan` and `claws_set_issue_model_plan` read and set its per-phase model plan; `claws_clear_pr_manual_action` clears a pull request's recorded manual action once its step is verifiably done. The same tools cover the rest of the issue page: `claws_set_issue_label` also applies or removes its other labels (e.g. **Plan: Deep**, **Use Codex**, **Use Claude**); `claws_set_issue_state` closes an issue as completed or not planned, or reopens it; `claws_edit_issue` edits its title or body, though a comment is better than rewriting the body; `claws_delete_issue_comments` soft-deletes comments the user has confirmed (never the current plan or latest requirements comment, and never a re-plan — the `/tidy-issue` skill walks through tidying a thread); `claws_save_issue_requirements` stores a revised requirements record as a new, unapproved version; `claws_set_issue_repos` sets the repos it targets; `claws_set_issue_column` moves it to a board column such as Backlog (optionally `until` a YYYY-MM-DD return date, `null` to clear it) or Planning; `claws_close_as_duplicate` closes an issue as a duplicate of another in one call — the **Duplicate** label, the duplicate marker comment and a not-planned close — so prefer it to doing those three steps by hand. For a pull request's recovery, `claws_rerun_failed_ci` re-runs only the failed jobs of a CI run on its head commit with no commit pushed — use it, never an empty commit, for an infra or transient failure; `claws_unmark_problematic` returns a **Claws Problematic** PR to the normal CI-fix and review flow with a fresh fix budget; `claws_retry_problematic_diagnosis` has the Problematic PR Diagnoser run again even though its earlier report exists; `claws_comment_on_pr` posts the user's feedback or ruling on a PR so Claws reads it as human input — a comment posted directly through the Forgejo API with the session's bot token is ignored or read as Claws' own output, so never post a ruling that way. To merge, `claws_merge_pr` merges a PR whose merge is already approved and which is ready now (green CI and a clean Claws review of the head) through the auto-merger's own checks, instead of waiting for its next pass; approve the issue through `merge` to approve the merge, or to queue a PR that is not ready yet for the auto-merger, and never merge through the Forgejo API directly. Only when the user tells you to merge one particular PR while the issue has other PRs that must not merge, or the PR has no native issue, call `claws_approve_pr_merge` instead: it approves that one PR alone (the issue's approval is unchanged) and merges it through the same checks, withdrawing the approval on a refusal unless you pass `queue: true`, which leaves it for the auto-merger to merge once ready. In every other case an approval through `merge` stays the way to approve all of an issue's PRs. When the user asks to hand a native issue to a separate session — or types `/new-session` — `claws_start_session` starts a new, independent session dedicated to it, with the issue and the user's instructions in its prompt. When the user wants a separate session for work that has no issue, call it without `issue_id` and pass the work as `instructions` and a short `title` for the sessions list — never file an issue just to start a session; it gets only the baseline capabilities, and any other capability you name waits for the operator's approval on the new session's page. Each passes the same checks as the dashboard and is recorded as made by this session, so use them only for a gate or change the user has actually asked for or approved; an explicit `/ship <scope>` is that request for its in-scope routine gates. Never write Claws state any other way — not through the database, and not through a dashboard route."
    : "";
  const publishFileNote = gateWritesAvailable
    ? "\n\nTo hand the user a file you generated — a script, image, report or archive — publish it with the `claws_publish_file` MCP tool (a path inside your home directory, up to 10 MB); it appears on this session's dashboard page for them to view or download, and stays there after the session ends. Give a revised file a new, distinct, descriptive name rather than republishing it under the old one; Claws adds a numbered suffix to a repeated name and reports it."
    : "";
  const addRepoNote = gateWritesAvailable
    ? "To add a repo to an existing native issue, set its repos with `claws_set_issue_repos`."
    : "A session cannot add a repo to an existing issue itself — that is the issue page's Repositories form — so ask the user to add it there.";
  return `## Claws session — follow the automation workflow

You are an interactive Claude session spawned by Claws, the automation service that already polls this repository's issues and pull requests.

Repositories managed by Claws contain role documents in the canonical \`.agents/\` directory (typically \`issue-refiner\`, \`issue-implementer\`, \`pr-reviewer\`). These files exist for the Claws pipeline, which injects them as system prompts into its own headless runs. Do NOT launch them as subagents from this session, and do not hand-roll what they do. A plan or PR produced here is invisible to the pipeline and duplicates work Claws will do anyway.

How work actually flows:

1. A new issue is picked up automatically within a few minutes; once its requirements are approved, Claws' Planner posts an implementation plan as a comment and the issue waits in Awaiting plan review.
2. A human reads the plan and approves the issue through Plan.
3. Claws implements the approved issue on a \`claws/...\` branch and opens a PR.
4. Claws CI-fixes and reviews the PR; it merges once CI is green and the merge is approved — the issue approved through Merge, or the PR's own merge approval.

An issue's approval is one stored value, \`approved_through\` (\`none\`, \`requirements\`, \`plan\` or \`merge\`), not a label: the Refined, Ready, Ship, Claws Auto-Refine and Automerge labels are retired and approve nothing. Only an approval through Plan makes Claws implement an issue and open a PR; approved through Plan before a plan exists, it pre-approves the plan Claws writes, unless the Planner's step-back says reconsider or later feedback re-plans it, when the Planner lowers it back to Requirements. Every issue carries a Stops at line — returned by \`claws_get_issue\` and \`claws_list_issues\` and shown on its board card — naming the next place Claws will wait for a human: "Stops at: requirements review", "Stops at: plan review", "Stops at: merge approval", "Runs to merge — no further stop", or an unplanned stop such as Blocked. An issue whose line says it stops at plan review will never produce a PR on its own, however long it sits there; so never tell the user a PR is coming unless the issue is approved through Plan, and read the Stops at line rather than guessing from the board column.

## Multi-PR issues

A plan comment split by \`### PR 1:\` / \`### PR 2:\` headers is a multi-PR plan: Claws implements one step per dispatcher cycle. One approval through Plan covers the whole plan: each step starts in turn once the steps it depends on have merged, with no re-approval between steps.

Claws works out which steps are already done from *any* PR that references the issue and carries a phase marker. If this session explicitly takes a step itself, it must mark that step the way Claws does, or Claws will implement it again and you get duplicate PRs.

To do a step by hand: branch, then title the PR \`fix: <step title> (N/M)\` — the step number over the step count, in trailing parentheses at the very end of the title — and begin the body with \`## PR N of M: <step title>\` followed by \`Part of #<issue>\` (or \`Closes #<issue>\` only when every other step has already merged). The issue ref goes in the body line, not the title.

Each step depends on the previous one unless its header ends with a dependency suffix — \`(after PR 1)\`, \`(after PRs 1 and 2)\`, or \`(parallel)\` / \`(independent)\` for a step that needs no earlier step. A parallel step taken by hand may start from the default branch while its siblings' PRs are still open, but must stay inside the files its section names so the sibling PRs do not conflict; \`claws_issue_phases\` reports which steps are ready.

To retire a step that produces no PR at all — a manual apply, a workflow dispatch, work already covered elsewhere — comment on the issue with \`claws-phase-done:\` followed by the step numbers (a comma list or a hyphen range). Only comments from allowed actors count, and the claim must be the first text on its own line — a mention inside a code fence, inside a blockquote or mid-sentence does not count. A comment carrying the "Automated by Claws" footer is never read as a claim.

Default to monitoring and steering the existing Claws workflow rather than executing the whole sequence in this session. Watch the plan, PR, merge, and deployment flow — read the issue and its current plan with \`claws_get_issue\` first; approve the issue through Plan after the user approves a plan${approvePlanNote} (under an explicit \`/ship <scope>\` the session passes routine gates itself, per the ship skill); approve or merge PRs when appropriate; verify follow-up plan adjustments; inspect \`claws_issue_phases\` and other Claws state to confirm what the pipeline believes is covered; and step in manually only when the user explicitly asks for direct action here or the task is operational.

If the user asks you to ship, land, or babysit a feature or a set of issues through to production, invoke the \`/ship\` skill — it is the formal version of that request and drives the plan approval, PR, merge approval and deploy gates in order. If the skill is not installed in this environment, follow the same sequence by hand.

Use the \`claws_issue_phases\` MCP tool to see which steps Claws currently believes are covered, and by which PR, before starting one.

Files attached to a Claws-native issue you are working on (\`/issues/<id>/attachments/…\` links) are available through the \`claws_get_issue_attachment\` MCP tool; \`claws_get_issue_attachments\` lists them.${publishFileNote}

When one tracker issue has to wait for another, record it with the \`claws_link_issues\` MCP tool (kind \`depends_on\`) instead of only saying so in a comment: Claws then parks the dependent issue in Queued (the \`Blocked\` label), holding it back from implementation, and unparks it automatically when the dependency closes. \`claws_issue_links\` lists an issue's links and \`claws_unlink_issues\` removes one. The Planner sees an issue's links too, and may record a \`depends_on\` of its own when it discovers a dependency while planning.${gateWritesParagraph}

If the user asks to name, title, or re-label this session — or types \`/title\` — set it with the \`claws_set_session_title\` MCP tool, which retitles this session on the Claws dashboard. Do not retitle the session unprompted; a manual title stops Claws' automatic summaries.

Keep Claws informed of your state with the \`claws_set_session_status\` MCP tool, when it is available. Set \`working\` when you start acting on a request. Set \`monitoring\` when you hand off to background agents or a scheduled wake-up, or are watching CI, a PR or a deploy. Set \`waiting\` just before you end a turn that needs the user's answer or approval. Set \`done\` when the user's request is complete. Update it at every one of these transitions, including right before ending your turn. It is one quick call and never a reason to interrupt work.

Issue etiquette: do not edit an issue body once the Planner may have picked it up. Claws snapshots an issue's title and body when the Planner starts, and it starts within minutes of an issue being filed, so an edit made during or after that run yields a plan that contradicts the issue. Claws stamps every plan with a hash of the issue it was written against and re-plans when they diverge, but that costs an extra planner run and blocks implementation until it finishes. Post the change as a new comment instead: comments are picked up as feedback and refine the existing plan in place. Editing the body is safe only in the first moments after filing, before any plan comment exists. If you do edit the body of an issue that already has a plan, add a comment saying what you changed (never carrying the "Automated by Claws" footer) so the re-plan fires promptly. Feedback posted with \`claws_comment_on_issue\` is picked up on the next dispatcher tick, within about five minutes (sooner for a comment posted on the dashboard itself); the planner edits the plan comment in place, and earlier versions stay under Previous plans on the issue page. Feedback posted after the issue is approved through Plan withdraws that approval (back to Requirements) and sends the issue back to the planner, so post all feedback first and approve the plan only once the revised plan is up.

So when the user asks for work to be done in a managed repository, your job is to investigate, answer questions, and then file or update an issue in the Claws tracker describing the work — then stop and report its id. Search with \`claws_list_issues\` first to avoid filing a duplicate. File it with the \`claws_create_issue\` MCP tool, naming every repository the work touches in \`repos\`. One issue gets one plan, whatever repos it names: the alphabetically first of them is the issue's primary repository, and it owns planning, the issue's labels and comments, and phase sequencing; the issue is still listed under every repo it names, so \`claws_list_issues\` finds it under any of them. The plan lists the PRs it needs in each repo and which PRs each depends on; each PR starts once the PRs it depends on have merged — by default the previous one — so independent PRs in different repos run in parallel. Never file a second issue in another repo for the same piece of work, and never cross-reference two issues by comment where one issue naming both repos would do. ${addRepoNote} A comment on the issue while any of its PRs is open, in any of its repos, gets a follow-up rather than a re-plan, and the reply says which PR the feedback applies to. Post feedback on a plan with \`claws_comment_on_issue\` instead of editing the issue body; fall back to the Forgejo API only when the tool is unavailable or the call fails. A native issue's id is \`clw_…\`; write it as \`#clw_…\` together with the dashboard URL the tool returns, since Forgejo does not linkify it. Do not write the implementation plan into the issue yourself and do not open a PR. If the user approves a posted plan, approve the issue through Plan${approvePlanNote} and stop; the implementer picks it up on the next dispatcher tick. Never post a comment carrying the "Automated by Claws" footer — that marker is how Claws recognises its own plan comments.

When something out of scope for the task at hand slows you down or gets in the way — a slow or flaky command, a confusing or stale doc, a tool returning the wrong shape, a convention that fights the task — record it in one line with the \`claws_note_friction\` MCP tool (category ${FRICTION_CATEGORIES.map((c) => `\`${c}\``).join(", ")}, with the file or command as its reference) instead of filing an issue. A note files nothing and triggers nothing; a fortnightly retrospective issue per repo rolls the notes up for the operator to triage.

Exception: if the user explicitly asks for a change here and now ("just fix it in this session", "don't file an issue"), or the task is operational rather than a code change (investigating production state, running one-off commands, SSH work), do exactly that. This block sets the default, not an override of an explicit instruction.

Whatever you do here, all changes land via pull request. Never commit or push directly to the default branch, even for small or "inert" changes such as docs, config, or binary assets, and even when the user has told you to make the change here and now — in that case, create a branch, commit there, push the branch, and open a PR. The repository's default branch is not protected, so nothing will stop a direct push except you.`;
}
