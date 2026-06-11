# qa-phase

**Source**: `src/jobs/qa-phase.ts`
**Trigger**: PRs with a "QA this" comment (case-insensitive)
**Interval**: 10 minutes (configurable via `intervals.qaPhaseMs`)

Performs exploratory QA testing on deployed PRs using Playwright browser
automation via MCP. Triggered by a human posting "QA this" as a comment
on an open PR.

For each open PR across all repos:

- Skips PRs in the `skippedItems` config list or with the `Claws Ignore` label
- Scans PR comments for a "QA this" trigger (regex: `/^\s*qa\s+this\s*$/i`)
- Skips comments from Claws itself (self-login check)
- Skips comments already reacted with 👀 by Claws (already processed)
- Discovers the preview deployment URL via `getDeploymentUrl()` (GitHub
  Deployments API primary, Vercel API fallback). If no deployment URL is
  found, the PR is skipped and retried next cycle.
- Reacts 👀 to the trigger comment immediately to prevent duplicate runs

## Processing

- Creates a worktree from the PR branch
- Gathers context: PR body, linked issue body (if any), three-dot diff,
  changed files list
- Writes an MCP config that includes both the Claws state server and
  Playwright MCP (`@playwright/mcp@latest`)
- Sends Claude a prompt with all context and instructions to:
  1. Read `docs/OVERVIEW.md` for application context
  2. Navigate to the preview URL using Playwright browser tools
  3. Test the specific feature/fix, edge cases, and error scenarios
  4. Take screenshots of any issues found
  5. Produce a structured QA report
- Posts Claude's QA report as a comment on the PR
- Adds the `Ready` label (signals QA is done, human's turn)
- Uses per-item timeout overrides via `getItemTimeoutMs()`

Does not create PRs or push code — purely a testing and reporting job.
