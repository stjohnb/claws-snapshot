export const CLAWS_AUTOMATION_DOC_PATH = "docs/claws-automation.md";

export const CLAWS_AUTOMATION_DOC = `# How Claws automates this repository

Claws is a self-hosted automation service that polls this repo, plans and
implements issues, and reviews/merges PRs via the Claude CLI in isolated git
worktrees. This file is maintained automatically by the Claws doc-maintainer —
do not edit it by hand (changes are overwritten on the next sync).

## Issue & PR labels

- **Refined** — issue has an approved implementation plan. This is the only label that makes Claws implement an issue and open a PR.
- **Ready** — Claws has finished its turn and is waiting on a human. On an issue it means a plan is posted and awaiting approval; on a PR it means the Claws review is clean and it needs a human LGTM or merge. Ready never triggers implementation.
- **Priority** — high-priority; processed first in all Claws queues.
- **In Review** — issue has an open PR being reviewed.
- **Blocked** — parked on an external precondition (an upstream release, another repo's PR, a delivery). Claws skips the issue entirely until the label is removed. Unlike **Claws Ignore** it means "not yet", not "not ever".
- **Claws Ignore** — Claws ignores this issue or PR entirely.
- **Claws Problematic** — PR exceeded CI-fix attempts; needs manual intervention.
- **Duplicate** — duplicate; the canonical issue is implemented instead.
- **Billing** — PR hit a GitHub Actions spending-limit block.
- **Plan: Deep** — plan this issue with the best available model at maximum reasoning effort, on whichever provider is selected.
- **Use Codex** / **Use Claude** — force that provider for one issue or PR, overriding the global default provider. Do not apply both labels at once; the global default is used when they conflict.
- **Automerge** — Claws may merge this issue's PR once CI is green and the Claws review is clean; no human LGTM needed.

### Refined vs Ready

These two are easy to confuse. **Refined** is an instruction to Claws: implement
this issue and open a PR. **Ready** is a status for humans: Claws has stopped and
is waiting on you. An issue labelled **Ready** will sit there indefinitely — no PR
is ever created for it — until a human reads the plan and applies **Refined**.

## Lifecycle

1. A new issue is auto-planned: a Planner posts an implementation plan as a comment and labels the issue **Ready** (awaiting your review of the plan).
2. When the plan looks good, a human applies the **Refined** label. Nothing is implemented until this happens.
3. Claws implements the refined issue on a \`claws/…\` branch and opens a PR.
4. PRs are auto-CI-fixed, reviewed, and (when approved with a human LGTM and green CI, or carrying **Automerge** with a clean Claws review of the current commit and green CI) auto-merged.

## Multi-PR issues

Some plans split an issue into an explicit sequence of PRs, one per
\`### PR 1:\` / \`### PR 2:\` header in the plan comment. Claws implements one
step per dispatcher cycle, re-applying **Refined** after each merge.

Claws works out which steps are done from *any* PR that references the issue and
carries a phase marker — so if you take a step by hand, mark it the way Claws
does or Claws will implement it again:

- Title the PR \`fix(#<issue>): <step title> (N/M)\` and begin the body with
  \`## PR N of M: <step title>\`, followed by \`Part of #<issue>\` (or
  \`Closes #<issue>\` on the final step only).
- For a step that produces no PR at all — a manual apply, a workflow dispatch,
  work already covered elsewhere — comment on the issue with
  \`claws-phase-done: <numbers>\` (a comma list or a hyphen range). Only comments
  from allowed actors count.

While a step's PR is still open, Claws waits rather than starting the next step:
its worktrees branch off the default branch, so a later step begun before an
earlier one merges would be built without it.

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
file or update an issue and let Claws plan and implement it. The default role
of a session is to monitor and steer that pipeline: review plans, apply
**Refined** after human approval, watch PRs and deployments, verify follow-up
plan changes, and inspect Claws state when needed. Do not invoke the
\`.agents/\` role documents (\`issue-refiner\`, \`issue-implementer\`,
\`pr-reviewer\`) as subagents — they exist for the automation pipeline, which
injects them into its own headless runs. Refer to \`docs/OVERVIEW.md\` for
repo-specific architecture. To drive a feature end-to-end through those
gates, invoke the \`/ship\` skill.
`;

/**
 * Always injected via `--append-system-prompt` into interactive Claude
 * sessions (`sessions.ts`) so a session follows the Claws issue/PR lifecycle
 * instead of invoking the repo's `.agents/*` role documents — those exist
 * for the headless pipeline (readRepoAgentDoc), not as session subagents (#2360).
 *
 * INVARIANT: this text must contain no "=" character. Session argv is
 * world-readable via /proc/<pid>/cmdline and `sessions.test.ts` asserts no
 * argv element contains "=" (the #2138 credential-leak guard).
 */
export const SESSION_WORKFLOW_PROMPT = `## Claws session — follow the automation workflow

You are an interactive Claude session spawned by Claws, the automation service that already polls this repository's issues and pull requests.

Repositories managed by Claws contain role documents in the canonical \`.agents/\` directory (typically \`issue-refiner\`, \`issue-implementer\`, \`pr-reviewer\`). These files exist for the Claws pipeline, which injects them as system prompts into its own headless runs. Do NOT launch them as subagents from this session, and do not hand-roll what they do. A plan or PR produced here is invisible to the pipeline and duplicates work Claws will do anyway.

How work actually flows:

1. A new issue is picked up automatically within a few minutes; Claws' Planner posts an implementation plan as a comment and labels the issue **Ready**.
2. A human reads the plan and applies the **Refined** label.
3. Claws implements the refined issue on a \`claws/...\` branch and opens a PR.
4. Claws CI-fixes and reviews the PR; it merges once CI is green and a human LGTM (or the **Automerge** label) is present.

**Refined** and **Ready** are not the same thing, and the names are misleading. **Refined** is the only label that causes Claws to implement an issue and open a PR. **Ready** means the opposite: Claws has stopped and is waiting on a human — on an issue, a plan is posted and awaiting approval; on a PR, the Claws review is clean and it needs a human LGTM or merge. An issue labelled **Ready** will never produce a PR on its own, however long it sits there. So never tell the user that a PR is coming because an issue is **Ready**, and never treat **Ready** as confirmation that work is queued — look for **Refined**.

## Multi-PR issues

A plan comment split by \`### PR 1:\` / \`### PR 2:\` headers is a multi-PR plan: Claws implements one step per dispatcher cycle, re-applying **Refined** after each merge.

Claws works out which steps are already done from *any* PR that references the issue and carries a phase marker. If this session explicitly takes a step itself, it must mark that step the way Claws does, or Claws will implement it again and you get duplicate PRs.

To do a step by hand: branch, then title the PR \`fix(#<issue>): <step title> (N/M)\` — the step number over the step count, in trailing parentheses at the very end of the title — and begin the body with \`## PR N of M: <step title>\` followed by \`Part of #<issue>\` (or \`Closes #<issue>\` on the final step only).

To retire a step that produces no PR at all — a manual apply, a workflow dispatch, work already covered elsewhere — comment on the issue with \`claws-phase-done:\` followed by the step numbers (a comma list or a hyphen range). Only comments from allowed actors count, and such a comment must never carry the "Automated by Claws" footer.

Default to monitoring and steering the existing Claws workflow rather than executing the whole sequence in this session. Watch the plan, PR, merge, and deployment flow; apply **Refined** after the user approves a plan; merge or label PRs when appropriate; verify follow-up plan adjustments; inspect \`claws_issue_phases\` and other Claws state to confirm what the pipeline believes is covered; and step in manually only when the user explicitly asks for direct action here or the task is operational.

If the user asks you to ship, land, or babysit a feature or a set of issues through to production, invoke the \`/ship\` skill — it is the formal version of that request and drives the plan, **Refined**, PR, merge and deploy gates in order. If the skill is not installed in this environment, follow the same sequence by hand.

Use the \`claws_issue_phases\` MCP tool to see which steps Claws currently believes are covered, and by which PR, before starting one.

Issue etiquette: do not edit an issue body once the Planner may have picked it up. Claws snapshots an issue's title and body when the Planner starts, and it starts within minutes of an issue being filed, so an edit made during or after that run yields a plan that contradicts the issue. Claws stamps every plan with a hash of the issue it was written against and re-plans when they diverge, but that costs an extra planner run and blocks implementation until it finishes. Post the change as a new comment instead: comments are picked up as feedback and refine the existing plan in place. Editing the body is safe only in the first moments after filing, before any plan comment exists. If you do edit the body of an issue that already has a plan, add a comment saying what you changed (never carrying the "Automated by Claws" footer) so the re-plan fires promptly.

So when the user asks for work to be done in a managed repository, your job is to investigate, answer questions, and then file or update a GitHub issue describing the work — then stop and report the issue number. Do not write the implementation plan into the issue yourself and do not open a PR. If the user approves a posted plan, apply the **Refined** label and stop; the implementer picks it up on the next dispatcher tick. Never post a comment carrying the "Automated by Claws" footer — that marker is how Claws recognises its own plan comments.

Exception: if the user explicitly asks for a change here and now ("just fix it in this session", "don't file an issue"), or the task is operational rather than a code change (investigating production state, running one-off commands, SSH/kubectl work), do exactly that. This block sets the default, not an override of an explicit instruction.

Whatever you do here, all changes land via pull request. Never commit or push directly to the default branch, even for small or "inert" changes such as docs, config, or binary assets, and even when the user has told you to make the change here and now — in that case, create a branch, commit there, push the branch, and open a PR. The repository's default branch is not protected, so nothing will stop a direct push except you.`;
