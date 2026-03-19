## Feature Ideas

### Dashboard analytics page with job metrics

Add a /metrics or /analytics page to the web dashboard that visualizes job performance over time. The SQLite database already stores task start/completion times and success/failure status — surface this as charts showing: success/failure rates per job, average task duration trends, Claude queue utilization, items processed per day/week, and most-active repositories. This gives the operator visibility into whether Claws is healthy and productive without digging through logs. Could be implemented with server-rendered SVG charts (no external dependencies needed) or a lightweight charting library.

### GitHub webhook support for instant reactions

Currently all jobs discover work by polling on timers (5–10 minute intervals). Add an optional webhook receiver endpoint (e.g. POST /webhook/github) that accepts GitHub webhook payloads and immediately triggers the relevant job. For example: an 'issues' event with action 'labeled' (Refined) could instantly trigger issue-worker, a 'pull_request_review' event could trigger review-addresser, and a 'check_suite' completion with failure could trigger ci-fixer. This would reduce reaction time from minutes to seconds. The polling jobs would remain as a fallback for reliability, but webhooks would provide near-instant responsiveness. The webhook endpoint should validate the X-Hub-Signature-256 header for security.

### Claude token usage and cost tracking

Track Claude CLI token consumption per task and job, and surface usage trends on the dashboard. The claude CLI outputs token usage information that could be parsed from its output. Store per-task token counts (input/output) in a new column or table, then aggregate by job and time period. Display on the dashboard or analytics page: daily/weekly token spend, cost per job type, most expensive tasks, and trend over time. Optionally support configurable daily or weekly budget caps that pause non-essential jobs (like improvement-identifier and idea-suggester) when the budget is exhausted, while still allowing critical jobs (ci-fixer, review-addresser) to run.

### Task priority queue with urgency levels

Replace the current FIFO Claude queue with a priority queue. Assign urgency levels to different task types: critical (ci-fixer on default branch, review-addresser), normal (issue-worker, issue-refiner, triage jobs), and low (improvement-identifier, idea-suggester, doc-maintainer). When multiple tasks are queued, higher-priority tasks run first. Additionally, support a 'priority' label on GitHub issues that bumps their tasks to the front of the queue. This ensures that time-sensitive work like CI fixes and review responses aren't blocked behind a lengthy improvement-identifier run.