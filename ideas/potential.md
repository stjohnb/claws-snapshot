# Potential Ideas

### Cross-repo improvement propagation

When improvement-identifier discovers and fixes an issue in one repository (e.g., a missing error boundary pattern, an insecure dependency usage, a suboptimal database query pattern), automatically scan all other cloned repos for the same anti-pattern. The current improvement-identifier analyzes each repo independently, which means the same class of bug might be found in repo A on Monday but not noticed in repo B until the following day — or not at all if the codebase structure is different enough. After each successful improvement PR is merged, a follow-up pass could extract the 'pattern signature' (the before/after of what was changed) and run a targeted search across sibling repos. This would compound the value of each improvement discovery across the entire portfolio.

### Cross-repo documentation linking in OVERVIEW.md

When doc-maintainer generates OVERVIEW.md for a repository, include a 'Related Repositories' section that references relevant documentation from sibling repos managed by Claws. For example, if the Kwyjibo game app's OVERVIEW.md references an API endpoint, and the Claws OVERVIEW.md documents the triage-kwyjibo-errors job that calls that endpoint, each doc could cross-reference the other. The doc-maintainer already reads OVERVIEW.md — extending it to read sibling repos' docs and note integration points would help Claude sessions understand the broader system when investigating bugs or planning features that span services.

### Closed-loop outcome tracking for CI fixes

After ci-fixer pushes a fix commit, track whether the subsequent CI run actually passes. Currently, ci-fixer pushes and moves on — it only discovers a fix didn't work when it re-identifies the same PR as failing on the next 10-minute cycle. Add a lightweight follow-up check: after pushing a fix, record the PR and commit SHA in a 'pending verification' list. On the next ci-fixer run, check these first. If CI passed, mark the fix as successful. If it failed again, include the previous fix attempt and its failure log in the new Claude prompt so it doesn't repeat the same approach. Over time, this builds a per-repo history of what fix strategies work and which don't, reducing the number of fix-retry cycles.

### Review-addresser effectiveness scoring

Track how often review-addresser's fix commits actually resolve the reviewer's concern versus triggering another round of review comments on the same topic. When a PR receives new review comments after review-addresser has pushed a fix, check whether the new comments reference the same code locations or topics as the previously addressed ones. Store this as a success/failure signal per task in the database. Surface the 'first-attempt resolution rate' on the dashboard. When the rate drops below a threshold for a specific repo, include recent failure examples in the review-addresser prompt as 'lessons learned' context.

### Daily digest email or Slack summary

Send a single daily summary (Slack message or email) at a configurable hour with: PRs merged in the last 24 hours, PRs awaiting review (with age), issues that moved through the pipeline, any errors or stuck items, and queue health stats. Currently the operator must check the dashboard or individual Slack notifications to understand Claws's overall productivity. A daily digest provides a single touchpoint that replaces the need to visit the dashboard on quiet days. The issue-auditor already performs a daily reconciliation — the digest could piggyback on that job's output, adding a formatted summary of the auditor's findings plus merged-PR counts from the git log.

### Failed task replay from the dashboard

Add a 'Retry' button on the log detail page (GET /logs/:runId) for failed or timed-out tasks. Clicking it would re-enqueue the same task with the same parameters but optionally with an extended timeout (e.g., 1.5x the original). For ClaudeTimeoutError failures, the retry prompt could include a note like 'Previous attempt timed out after 20 minutes with N bytes of output — focus on the most critical changes first.' This avoids the current workaround of waiting for the next scheduled cycle or manually triggering the entire job. The retry should create a new task/run entry linked to the original for traceability.

### MCP tool server for GitHub and database context

Wrap common data lookups (issue details, PR status, CI logs, task history from SQLite, OVERVIEW.md contents) as an MCP (Model Context Protocol) tool server that Claude can call during sessions. Currently, every Claude prompt must include all context upfront — issue body, comments, CI logs, documentation — which consumes context window budget. With MCP tools, Claude could start with a minimal prompt and fetch additional context on demand: 'look up the CI failure log for this PR', 'read the related issue comments', 'check if this error fingerprint has been seen before'. This would reduce prompt sizes, allow Claude to be more surgical about what context it needs, and enable new capabilities like having Claude cross-reference the task database during investigation.

### Structured output mode with JSON schema validation

Several jobs parse Claude's stdout as JSON (improvement-identifier, idea-suggester, whatsapp-handler) using text extraction from fenced code blocks. Replace this with Claude CLI's structured output mode or add a post-processing validation layer using JSON schemas (e.g., with Zod or Ajv). Define schemas for each job's expected output format and validate before acting on the response. When validation fails, retry with the schema included in the error message. This would eliminate silent failures where Claude returns almost-valid JSON (e.g., trailing commas, unquoted keys) and provide better error diagnostics than the current 'failed to parse Claude output' errors.

### Adaptive polling intervals based on activity patterns

Track the hit rate of each polling job — how often it finds actionable work versus finding nothing. If issue-worker polls every 5 minutes but the 'Refined' label is only added a few times per day (typically during working hours), it runs ~280 unnecessary polls per day. Add a simple adaptive backoff: when a job finds no work for N consecutive polls, double its interval (up to a configurable maximum, e.g., 30 minutes). When work is found, immediately reset to the base interval. Additionally, track hourly hit-rate patterns over a rolling 7-day window — if work is never found between midnight and 7 AM, automatically extend intervals during those hours. This reduces GitHub API calls, host resource usage, and log noise without any impact on responsiveness during active periods.
