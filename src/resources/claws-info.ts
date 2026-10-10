export const CLAWS_AUTOMATION_DOC_PATH = "docs/claws-automation.md";

export const CLAWS_AUTOMATION_DOC = `# How Claws automates this repository

Claws is a self-hosted automation service that polls this repo, plans and
implements issues, and reviews/merges PRs via agent CLIs in isolated git
worktrees. This file is maintained automatically by the Claws doc-maintainer —
do not edit it by hand (changes are overwritten on the next sync).

## Where issues live

New issues are filed in [Claws' own tracker](issue-tracker.md), not on the
forge. A native issue's id is \`clw_…\` — written \`#clw_…\` in PR bodies and
prose (e.g. \`Closes #clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC\`) since neither forge
linkifies it. Agents file one with the \`claws_create_issue\` MCP tool; a human
uses the dashboard's New issue page. The forge is only for issues a human
files there by hand — the \`issue-importer\` job mirrors those into the tracker
on its own timer, normally within about half an hour. An issue names every
repository the work touches; the alphabetically first is its primary repository,
which owns planning and labels, and one plan covers the PRs in all of them — no
companion issues. The issue is listed under every repository it names.

## Issue & PR labels

On a PR, the six state labels — **Ready**, **Claws Problematic**, **Manual
Action**, **Needs LGTM**, **Billing** and **Automerge** — are informational: a
write-only mirror of the PR state Claws stores in its own \`claws_prs\` row.
Claws applies and removes them so the PR reads accurately on the forge, but no
decision ever reads one back, so adding or removing one on a forge PR changes
nothing. Change PR state from the dashboard instead.

- **Refined** — issue has an approved implementation plan. This is the only label that makes Claws implement an issue and open a PR.
- **Ready** — Claws has finished its turn and is waiting on a human. On an issue it means a plan is posted and awaiting approval. On a PR it is an informational mirror: Claws' stored state says the review is clean and the PR awaits merge — approve it from the dashboard (the **Automerge** control or Merge). Ready never triggers implementation.
- **Priority** — high-priority; processed first in all Claws queues, ahead of every non-Priority item whatever its pipeline stage; the label is re-read on each dispatcher pass and again just before an agent starts. Incident labels (\`grafana-alert\`, plus any a repo lists under \`incidentLabels\` in \`claws.json\`) are treated the same in the work queue.
- **Blocked** — parked on an external precondition (an upstream release, another repo's PR, a delivery). Claws skips the issue entirely until the label is removed. Unlike **Claws Ignore** it means "not yet", not "not ever".
- **Backlog** — parked for later: off the \`/board\`, listed on \`/backlog\`, and skipped by every Claws job (no planning, auditing or dispatch). Unlike **Blocked**, nothing automated ever removes it; a human promotes it back onto the board (Drafting, Requirements review or Planning) from \`/backlog\` or by removing the label.
- **Claws Ignore** — Claws ignores this issue or PR entirely.
- **Claws Staging** — opt in to the staging activation state's issue/PR pipeline. Staging only acts on live issues and PRs with this label; active/production Claws skips them. **Claws Ignore** and **Blocked** still stop work, and this label does not approve a plan, review, CI gate, or merge.
- **Claws Problematic** — informational mirror: the PR exceeded CI-fix attempts and needs manual intervention. Clear it with **Unmark problematic** on the dashboard's \`/prs\` page, which also resets the CI-fix budget; removing the label on the forge does nothing.
- **Duplicate** — duplicate; the canonical issue is implemented instead.
- **Billing** — informational mirror: the PR hit a GitHub Actions spending-limit block.
- **Plan: Deep** — plan this issue with the best available model at maximum reasoning effort, on whichever provider is selected.
- **Use Claude** / **Use Codex** / **Use OpenCode** / **Use Pi** — force that provider for one issue or PR when it is enabled (weight 0 counts: such a provider is out of the random draw and runs only when pinned). Do not apply multiple provider labels at once; weighted provider selection is used when they conflict.
- **Automerge** — on an issue, approves the merge of the issue's PRs: Claws may merge each once CI is green and the Claws review of the current commit is clean. On a PR it is an informational mirror of the merge approval stored on the PR's \`claws_prs\` row, with the identity of whoever approved; applying it on a forge PR does **not** approve the merge. Nor does Renovate adding it: a trusted Renovate PR merges without approval because of who opened it and its update type, not the label (see Merging). Approve from the dashboard — the board card's compact **M** toggle, the issue page, the Automerge control on \`/prs\`, or the Merge button — or from a session's gate tool. It does **not** approve the plan — approving the merge of an issue with no plan yet does not skip human plan review. Use it together with **Refined** (or the queue's "Refine & Merge" action, or the issue page's "Refine & Automerge" button) once you have actually read the plan.
- **Needs LGTM** — informational mirror: this PR is never exempt from the approval requirement, whatever its branch, and merges only once you approve the merge from the dashboard. Claws sets it on PRs written by a provider that is still on trial for a job (currently \`doc-maintainer\` on Codex), so a docs PR that would otherwise auto-merge waits for you to read it. A dashboard approval lifts it; removing the label on the forge does nothing.
- **Manual Action** — on an issue, Claws has paused for your decision. On a PR, an informational mirror: the PR needs a manual step (for example, setting prod secrets) before it can merge, and Claws will not merge it until that is cleared. Clear it with **Clear manual action** on the dashboard's \`/prs\` page; removing the label on the forge does nothing. While a PR has an unmet manual action — its own, or an open operator step on its issue's plan — \`/prs\` and the issue page's PR list name it in a warning, and \`/prs\`'s Merge and Automerge buttons ask you to confirm before acting.
- **Claws Auto-Refine** — explicit opt-in for an issue Claws may plan *and* auto-apply **Refined** to itself once a plan is posted, skipping human plan review entirely. Reserved for deterministic, low-risk auto-filed issues (e.g. routine Dependabot remediation); a human should not normally need to apply this label by hand. Auto-refine is withheld whenever the planner's step-back pass returns \`reconsider\` on the plan — even if step-back posted a revised plan — so the issue stays at **Ready** with a \`## Step Back\` comment until a human reads it and applies **Refined** by hand.

### Refined vs Ready

These two are easy to confuse. **Refined** is an instruction to Claws: implement
this issue and open a PR. **Ready** is a status for humans: Claws has stopped and
is waiting on you. An issue labelled **Ready** will sit there indefinitely — no PR
is ever created for it — until a human reads the plan and applies **Refined**.

### Native issues (\`clw_…\`)

A native issue has no forge copy, so \`gh issue edit\` and \`gh pr edit\` cannot
label it or its PRs. From an interactive session, apply or remove **Refined**,
**Automerge**, **Blocked** and **Priority** with the \`claws_set_issue_label\`
MCP tool, promote an issue out of Drafting or Requirements review with \`claws_promote_issue\` (\`claws_get_issue\` returns its stage and requirements record), and read or
set its per-phase model plan with \`claws_get_issue_model_plan\` /
\`claws_set_issue_model_plan\`. The same session also has the issue page's other
actions: \`claws_set_issue_label\` applies or removes its other labels (e.g.
**Claws Ignore**, **Plan: Deep**, **Use Codex**), \`claws_set_issue_state\` closes
it as completed or not planned or reopens it, \`claws_edit_issue\` edits its title
or body, \`claws_set_issue_repos\` sets its repos, and \`claws_set_issue_column\`
moves it to a board column. Each change passes the same checks as the
dashboard and is recorded as made by the session. \`gh issue edit\` still
applies to GitHub issues; a Forgejo issue is edited through the Forgejo API.

## Lifecycle

1. A new issue starts in **Drafting**, where Claws writes a requirements record for it — what it asks for, not how to build it. Once a version is stored it sits in **Requirements review** for you to read; feedback you leave sends it back to **Drafting** until the writer stores the next version. Promoting the requirements (you do it for issues you filed; issues filed by automation or a forge promote themselves) moves it to **Planning**, where a Planner posts an implementation plan as a comment and labels the issue **Ready** (awaiting your review of the plan).
2. When the plan looks good, a human applies the **Refined** label. Nothing is implemented until this happens.
3. Claws implements the refined issue on a \`claws/…\` branch and opens a PR.
4. PRs are auto-CI-fixed, reviewed, and (once the merge is approved from the dashboard, with a clean Claws review of the current commit and green CI) auto-merged.

### Merging

Approving the merge of a green, cleanly-reviewed PR from the dashboard is what merges it: the **Automerge** control (the board card's **M** toggle, the issue page, \`/prs\`), the Merge button, or a session's gate tool records the approval, with the approver's identity, on the PR's \`claws_prs\` row. That stored approval is the only one Claws accepts. Applying the **Automerge** label on a forge PR does nothing, and neither does a bare \`LGTM\` comment, on either forge. Forge **Automerge** labels already on open PRs when this took effect were imported once, attributed to whoever applied them. Claws re-evaluates open PRs for merge about every three minutes, so a merge normally lands within about three minutes of the approval. If it cannot merge an approved PR, it edits a single "Merge blocked" comment on the PR saying why. Third-party update PRs merge without a dashboard approval when they are Dependabot's, or when they are Renovate's from a trusted identity (the Renovate app, the Forgejo \`renovate\` account, or an allowed human actor's PAT, as fleet-infra's Renovate uses) and not a major update. Neither kind may touch infrastructure (tofu/terraform) paths or carry a Manual Action, and both merge at any hour once green; a Renovate PR also needs a clean Claws review of the current head and passing CI. The **Automerge** label is never read as approval, so a major update, or any other PR, still waits for a dashboard approval, and \`/prs\` marks such a PR **Awaiting approval**. \`/prs\` offers All, Dependencies and Other views (\`/prs?kind=deps\`), remembers the last choice per browser, and the Dependencies view lists PRs needing a human decision before those Claws will merge itself.

## Multi-PR issues

Some plans split an issue into an explicit sequence of PRs, one per
\`### PR 1:\` / \`### PR 2:\` header in the plan comment. Claws implements one
step per dispatcher cycle, re-applying **Refined** after each merge.

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
last PR merges:

- The step is never ready for the implementer. Once every PR step has merged,
  \`claws_issue_phases\` lists it with status \`manual\` (and in
  \`awaitingOperator\`), and the auto-merger posts one comment on the issue
  (marker \`claws-awaiting-operator\`) quoting the section and asking for
  \`claws-phase-done: N\`, with a Slack ping.
- The issue closes on the dispatcher tick after an allowed actor comments
  \`claws-phase-done: N\` for that step, or when someone closes it. The issue
  auditor leaves an issue awaiting its operator alone — it adds no \`Ready\`.
- A PR whose step the plan orders after an operator step carries that step in
  its \`prs[]\` entry as \`manual_action_before_merge\`. The implementer records it
  as the PR's **Manual Action** from creation — the reason on the PR's
  \`claws_prs\` row, then the label, under a "Manual action required before
  merge" body section — so the auto-merger holds the PR even when the issue
  has Automerge, until the action is cleared. An implementer's own
  \`MANUAL-ACTION-BEFORE-MERGE\` note is recorded the same way, its text as the
  reason.
- While the step is open, \`/prs\` and the issue page's PR list show a warning
  on the issue's PRs — "Manual action before merge: …" for a PR's own action,
  "Operator step pending: …" for the open step — and \`/prs\`'s Merge and
  Automerge buttons ask for confirmation first. The issue page lists the step
  as an **Operator step** row, and once every PR has merged the board shows
  the issue in Awaiting merge with an **Awaiting operator** chip.

Because the manual step counts as a step, PR markers number against it: a
two-PR plan with a manual section opens \`(1/3)\` and \`(2/3)\`, and its last PR
says \`Part of #<issue>\` rather than \`Closes\`.

## Forgejo-hosted repositories

On a repository hosted on Forgejo, Forgejo owns its issues, pull requests,
releases and default branch; any GitHub copy is archived or a read-only mirror
and is never authoritative. Read and write it through the Claws MCP tools or
the Forgejo API, never \`gh\`. Its CI and release workflows live in
\`.forgejo/workflows/\` and run on Forgejo Actions, its releases are Forgejo
releases, and its dependency updates come from Renovate rather than
Dependabot. Forgejo review approvals and \`LGTM\` comments never count: the
dashboard's **Automerge** approval is the only approval Claws accepts.

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
it. The default role of a session is to monitor and steer that pipeline: review plans, apply
**Refined** after human approval, watch PRs and deployments, verify follow-up
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
 * (`claws_set_issue_label`, `claws_promote_issue`, `claws_set_issue_model_plan`,
 * `claws_set_issue_state`, `claws_edit_issue`, `claws_set_issue_repos`,
 * `claws_set_issue_column`) only when the session actually has them — the
 * `/mcp/sessions/:id` endpoint, which holds a per-session credential those
 * routes require (#clw_01M3BWP83BQRXE06NWW1GKYT2S). A browser session has no
 * `claws-state` server, so telling it about tools it cannot call would just
 * steer it into a failing tool call; pass `false` there.
 *
 * INVARIANT: this text must contain no "=" character (the #2138
 * credential-leak guard, asserted by `claws-info.test.ts`).
 */
export function sessionWorkflowPrompt(gateWritesAvailable: boolean): string {
  const applyRefinedNote = gateWritesAvailable
    ? " (on a native `clw_…` issue with the `claws_set_issue_label` MCP tool, not `gh issue edit`)"
    : "";
  const gateWritesParagraph = gateWritesAvailable
    ? "\n\nA native `clw_…` issue has no forge copy, so `gh issue edit` and `gh pr edit` cannot change it. Move it through the gates the user is driving with the session-only MCP tools instead: `claws_set_issue_label` applies or removes **Refined**, **Automerge** (the merge approval for every open PR of the issue), **Blocked** and **Priority**; `claws_promote_issue` promotes an issue out of Drafting or Requirements review once the user has approved its requirements, which `claws_get_issue` returns with its stage; `claws_get_issue_model_plan` and `claws_set_issue_model_plan` read and set its per-phase model plan; `claws_clear_pr_manual_action` clears a pull request's recorded manual action once its step is verifiably done — removing the **Manual Action** label on the forge (`gh pr edit --remove-label`) does not clear that record, and Claws restores the label. The same tools cover the rest of the issue page: `claws_set_issue_label` also applies or removes its other labels (e.g. **Claws Ignore**, **Plan: Deep**, **Use Codex**, **Use Claude**); `claws_set_issue_state` closes an issue as completed or not planned, or reopens it; `claws_edit_issue` edits its title or body, though a comment is better than rewriting the body; `claws_set_issue_repos` sets the repos it targets; `claws_set_issue_column` moves it to a board column such as Backlog or Planning; `claws_close_as_duplicate` closes an issue as a duplicate of another in one call — the **Duplicate** label, the duplicate marker comment and a not-planned close — so prefer it to doing those three steps by hand. For a pull request's recovery, `claws_rerun_failed_ci` re-runs only the failed jobs of a CI run on its head commit with no commit pushed — use it, never an empty commit, for an infra or transient failure; `claws_unmark_problematic` returns a **Claws Problematic** PR to the normal CI-fix and review flow with a fresh fix budget; `claws_retry_problematic_diagnosis` has the Problematic PR Diagnoser run again even though its earlier report exists; `claws_comment_on_pr` posts the user's feedback or ruling on a PR so Claws reads it as human input — a `gh pr comment` or curl comment made with the session's bot token is ignored or read as Claws' own output, so never post a ruling that way. When the user asks to hand a native issue to a separate session — or types `/new-session` — `claws_start_session` starts a new, independent session dedicated to it, with the issue and the user's instructions in its prompt. When the user wants a separate session for work that has no issue, call it without `issue_id` and pass the work as `instructions` — never file an issue just to start a session; it gets only the baseline capabilities, and any other capability you name waits for the operator's approval on the new session's page. Each passes the same checks as the dashboard and is recorded as made by this session, so use them only for a gate or change the user has actually asked for or approved. Never write Claws state any other way — not through the database, and not through a dashboard route."
    : "";
  const applyRefinedLabelNote = gateWritesAvailable ? " (`claws_set_issue_label` on a native issue)" : "";
  const addRepoNote = gateWritesAvailable
    ? "To add a repo to an existing native issue, set its repos with `claws_set_issue_repos`."
    : "A session cannot add a repo to an existing issue itself — that is the issue page's Repositories form — so ask the user to add it there.";
  return `## Claws session — follow the automation workflow

You are an interactive Claude session spawned by Claws, the automation service that already polls this repository's issues and pull requests.

Repositories managed by Claws contain role documents in the canonical \`.agents/\` directory (typically \`issue-refiner\`, \`issue-implementer\`, \`pr-reviewer\`). These files exist for the Claws pipeline, which injects them as system prompts into its own headless runs. Do NOT launch them as subagents from this session, and do not hand-roll what they do. A plan or PR produced here is invisible to the pipeline and duplicates work Claws will do anyway.

How work actually flows:

1. A new issue is picked up automatically within a few minutes; Claws' Planner posts an implementation plan as a comment and labels the issue **Ready**.
2. A human reads the plan and applies the **Refined** label.
3. Claws implements the refined issue on a \`claws/...\` branch and opens a PR.
4. Claws CI-fixes and reviews the PR; it merges once CI is green and the merge is approved from the dashboard.

**Refined** and **Ready** are not the same thing, and the names are misleading. **Refined** is the only label that causes Claws to implement an issue and open a PR. **Ready** means the opposite: Claws has stopped and is waiting on a human — on an issue, a plan is posted and awaiting approval; on a PR, the Claws review is clean and applying **Automerge** (or pressing Merge on the dashboard) merges it. An issue labelled **Ready** will never produce a PR on its own, however long it sits there. So never tell the user that a PR is coming because an issue is **Ready**, and never treat **Ready** as confirmation that work is queued — look for **Refined**.

## Multi-PR issues

A plan comment split by \`### PR 1:\` / \`### PR 2:\` headers is a multi-PR plan: Claws implements one step per dispatcher cycle, re-applying **Refined** after each merge.

Claws works out which steps are already done from *any* PR that references the issue and carries a phase marker. If this session explicitly takes a step itself, it must mark that step the way Claws does, or Claws will implement it again and you get duplicate PRs.

To do a step by hand: branch, then title the PR \`fix: <step title> (N/M)\` — the step number over the step count, in trailing parentheses at the very end of the title — and begin the body with \`## PR N of M: <step title>\` followed by \`Part of #<issue>\` (or \`Closes #<issue>\` only when every other step has already merged). The issue ref goes in the body line, not the title.

Each step depends on the previous one unless its header ends with a dependency suffix — \`(after PR 1)\`, \`(after PRs 1 and 2)\`, or \`(parallel)\` / \`(independent)\` for a step that needs no earlier step. A parallel step taken by hand may start from the default branch while its siblings' PRs are still open, but must stay inside the files its section names so the sibling PRs do not conflict; \`claws_issue_phases\` reports which steps are ready.

To retire a step that produces no PR at all — a manual apply, a workflow dispatch, work already covered elsewhere — comment on the issue with \`claws-phase-done:\` followed by the step numbers (a comma list or a hyphen range). Only comments from allowed actors count, and the claim must be the first text on its own line — a mention inside a code fence, inside a blockquote or mid-sentence does not count. A comment carrying the "Automated by Claws" footer is never read as a claim.

Default to monitoring and steering the existing Claws workflow rather than executing the whole sequence in this session. Watch the plan, PR, merge, and deployment flow — read the issue and its current plan with \`claws_get_issue\` first; apply **Refined** after the user approves a plan${applyRefinedNote}; merge or label PRs when appropriate; verify follow-up plan adjustments; inspect \`claws_issue_phases\` and other Claws state to confirm what the pipeline believes is covered; and step in manually only when the user explicitly asks for direct action here or the task is operational.

If the user asks you to ship, land, or babysit a feature or a set of issues through to production, invoke the \`/ship\` skill — it is the formal version of that request and drives the plan, **Refined**, PR, merge and deploy gates in order. If the skill is not installed in this environment, follow the same sequence by hand.

Use the \`claws_issue_phases\` MCP tool to see which steps Claws currently believes are covered, and by which PR, before starting one.

Files attached to a Claws-native issue you are working on (\`/issues/<id>/attachments/…\` links) are available through the \`claws_get_issue_attachment\` MCP tool; \`claws_get_issue_attachments\` lists them.

When one tracker issue has to wait for another, record it with the \`claws_link_issues\` MCP tool (kind \`depends_on\`) instead of only saying so in a comment: Claws then holds the dependent issue back from implementation and unparks it automatically when the dependency closes. \`claws_issue_links\` lists an issue's links and \`claws_unlink_issues\` removes one. The Planner sees an issue's links too, and may record a \`depends_on\` of its own when it discovers a dependency while planning.${gateWritesParagraph}

If the user asks to name, title, or re-label this session — or types \`/title\` — set it with the \`claws_set_session_title\` MCP tool, which retitles this session on the Claws dashboard. Do not retitle the session unprompted; a manual title stops Claws' automatic summaries.

Keep Claws informed of your state with the \`claws_set_session_status\` MCP tool, when it is available. Set \`working\` when you start acting on a request. Set \`monitoring\` when you hand off to background agents or a scheduled wake-up, or are watching CI, a PR or a deploy. Set \`waiting\` just before you end a turn that needs the user's answer or approval. Set \`done\` when the user's request is complete. Update it at every one of these transitions, including right before ending your turn. It is one quick call and never a reason to interrupt work.

Issue etiquette: do not edit an issue body once the Planner may have picked it up. Claws snapshots an issue's title and body when the Planner starts, and it starts within minutes of an issue being filed, so an edit made during or after that run yields a plan that contradicts the issue. Claws stamps every plan with a hash of the issue it was written against and re-plans when they diverge, but that costs an extra planner run and blocks implementation until it finishes. Post the change as a new comment instead: comments are picked up as feedback and refine the existing plan in place. Editing the body is safe only in the first moments after filing, before any plan comment exists. If you do edit the body of an issue that already has a plan, add a comment saying what you changed (never carrying the "Automated by Claws" footer) so the re-plan fires promptly. Feedback posted with \`claws_comment_on_issue\` is picked up on the next dispatcher tick, within about five minutes (sooner for a comment posted on the dashboard itself); the planner edits the plan comment in place, and earlier versions stay under Previous plans on the issue page. Feedback posted after the issue is marked **Refined** strips **Refined** and sends the issue back to the planner, so post all feedback first and apply **Refined** only once the revised plan is up.

So when the user asks for work to be done in a managed repository, your job is to investigate, answer questions, and then file or update an issue in the Claws tracker describing the work — then stop and report its id. Search with \`claws_list_issues\` first to avoid filing a duplicate. File it with the \`claws_create_issue\` MCP tool, naming every repository the work touches in \`repos\`. One issue gets one plan, whatever repos it names: the alphabetically first of them is the issue's primary repository, and it owns planning, the issue's labels and comments, and phase sequencing; the issue is still listed under every repo it names, so \`claws_list_issues\` finds it under any of them. The plan lists the PRs it needs in each repo and which PRs each depends on; each PR starts once the PRs it depends on have merged — by default the previous one — so independent PRs in different repos run in parallel. Never file a second issue in another repo for the same piece of work, and never cross-reference two issues by comment where one issue naming both repos would do. ${addRepoNote} A comment on the issue while any of its PRs is open, in any of its repos, gets a follow-up rather than a re-plan, and the reply says which PR the feedback applies to. Post feedback on a plan with \`claws_comment_on_issue\` instead of editing the issue body; fall back to \`gh issue create\` or the Forgejo API only when the tool is unavailable or the call fails. A native issue's id is \`clw_…\`; write it as \`#clw_…\` together with the dashboard URL the tool returns, since neither forge linkifies it. Do not write the implementation plan into the issue yourself and do not open a PR. If the user approves a posted plan, apply the **Refined** label${applyRefinedLabelNote} and stop; the implementer picks it up on the next dispatcher tick. Never post a comment carrying the "Automated by Claws" footer — that marker is how Claws recognises its own plan comments.

Exception: if the user explicitly asks for a change here and now ("just fix it in this session", "don't file an issue"), or the task is operational rather than a code change (investigating production state, running one-off commands, SSH work), do exactly that. This block sets the default, not an override of an explicit instruction.

Whatever you do here, all changes land via pull request. Never commit or push directly to the default branch, even for small or "inert" changes such as docs, config, or binary assets, and even when the user has told you to make the change here and now — in that case, create a branch, commit there, push the branch, and open a PR. The repository's default branch is not protected, so nothing will stop a direct push except you.`;
}
