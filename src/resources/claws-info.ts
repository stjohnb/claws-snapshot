export const CLAWS_AUTOMATION_DOC_PATH = "docs/claws-automation.md";

export const CLAWS_AUTOMATION_DOC = `# How Claws automates this repository

Claws is a self-hosted automation service that polls this repo, plans and
implements issues, and reviews/merges PRs via the Claude CLI in isolated git
worktrees. This file is maintained automatically by the Claws doc-maintainer —
do not edit it by hand (changes are overwritten on the next sync).

## Issue & PR labels

- **Refined** — issue has an approved implementation plan and is ready for Claws to implement.
- **Ready** — Claws has finished its work; needs human attention.
- **Priority** — high-priority; processed first in all Claws queues.
- **In Review** — issue has an open PR being reviewed.
- **Claws Ignore** — Claws ignores this issue or PR entirely.
- **Claws Problematic** — PR exceeded CI-fix attempts; needs manual intervention.
- **Duplicate** — duplicate; the canonical issue is implemented instead.
- **Billing** — PR hit a GitHub Actions spending-limit block.
- **Plan: Fable** — plan this issue with Claude Fable 5 instead of the default model.
- **Automerge** — Claws may merge this issue's PR once CI is green and the Claws review is clean; no human LGTM needed.

## Lifecycle

1. A new issue is auto-planned: a Planner posts an implementation plan as a comment.
2. When the plan looks good, a human applies the **Refined** label.
3. Claws implements the refined issue on a \`claws/…\` branch and opens a PR.
4. PRs are auto-CI-fixed, reviewed, and (when approved with a human LGTM and green CI, or carrying **Automerge** with a clean Claws review of the current commit and green CI) auto-merged.

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
file or update an issue and let Claws plan and implement it. Do not invoke the
\`.claude/agents/\` definitions (\`issue-refiner\`, \`issue-implementer\`,
\`pr-reviewer\`) as subagents — they exist for the automation pipeline, which
injects them into its own headless runs. Refer to \`docs/OVERVIEW.md\` for
repo-specific architecture.
`;

/**
 * Always injected via `--append-system-prompt` into interactive Claude
 * sessions (`sessions.ts`) so a session follows the Claws issue/PR lifecycle
 * instead of invoking the repo's `.claude/agents/*` definitions — those exist
 * for the headless pipeline (readRepoAgentDoc), not as session subagents (#2360).
 *
 * INVARIANT: this text must contain no "=" character. Session argv is
 * world-readable via /proc/<pid>/cmdline and `sessions.test.ts` asserts no
 * argv element contains "=" (the #2138 credential-leak guard).
 */
export const SESSION_WORKFLOW_PROMPT = `## Claws session — follow the automation workflow

You are an interactive Claude session spawned by Claws, the automation service that already polls this repository's issues and pull requests.

Repositories managed by Claws contain agent definitions in \`.claude/agents/\` (typically \`issue-refiner\`, \`issue-implementer\`, \`pr-reviewer\`). Those files exist for the Claws pipeline, which injects them as system prompts into its own headless runs. Do NOT launch them as subagents from this session, and do not hand-roll what they do. A plan or PR produced here is invisible to the pipeline and duplicates work Claws will do anyway.

How work actually flows:

1. A new issue is picked up automatically within a few minutes; Claws' Planner posts an implementation plan as a comment.
2. A human applies the **Refined** label once the plan looks right.
3. Claws implements the refined issue on a \`claws/...\` branch and opens a PR.
4. Claws CI-fixes and reviews the PR; it merges once CI is green and a human LGTM (or the **Automerge** label) is present.

So when the user asks for work to be done in a managed repository, your job is to investigate, answer questions, and then file or update a GitHub issue describing the work — then stop and report the issue number. Do not write the implementation plan into the issue yourself and do not open a PR. If the user approves a posted plan, apply the **Refined** label and stop; the implementer picks it up on the next dispatcher tick. Never post a comment carrying the "Automated by Claws" footer — that marker is how Claws recognises its own plan comments.

Exception: if the user explicitly asks for a change here and now ("just fix it in this session", "don't file an issue"), or the task is operational rather than a code change (investigating production state, running one-off commands, SSH/kubectl work), do exactly that. This block sets the default, not an override of an explicit instruction.`;
