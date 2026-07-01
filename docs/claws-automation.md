# How Claws automates this repository

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

## Lifecycle

1. A new issue is auto-planned: a Planner posts an implementation plan as a comment.
2. When the plan looks good, a human applies the **Refined** label.
3. Claws implements the refined issue on a `claws/…` branch and opens a PR.
4. PRs are auto-CI-fixed, reviewed, and (when approved with a human LGTM and green CI) auto-merged.

## Working manually in this repo

When running a manual Claude session here, follow this same lifecycle. Refer to
`docs/OVERVIEW.md` for repo-specific architecture.
