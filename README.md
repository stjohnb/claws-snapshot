# claws

> This is a personal, self-hosted project maintained by one author for their own use. It is shared as-is and is not a supported product.

Scheduled GitHub automation powered by the Claude CLI.

Claws periodically scans GitHub repositories and uses Claude to:

- **Plan issues** — issues labelled `Needs Refinement` get an AI-generated implementation plan posted as a comment
- **Work issues** — issues labelled `Refined` are picked up, implemented in an isolated worktree, and submitted as a PR
- **Fix CI** — open PRs with failing checks are analysed and patched automatically

## How it works

Three jobs run on simple timers (5 min for issues, 10 min for CI). Each job:

1. Queries GitHub via the `gh` CLI for matching issues/PRs
2. Creates a git worktree for isolation
3. Runs the `claude` CLI with a task-specific prompt
4. Pushes results (PR, comment, or commits) back to GitHub
5. Cleans up the worktree

A serial queue ensures only one Claude process runs at a time. Labels (`claws-working`, etc.) coordinate state and prevent duplicate work.

For a deeper look at how the modules connect, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (visual Mermaid diagrams) and [docs/OVERVIEW.md](docs/OVERVIEW.md) (prose).

## Prerequisites

| Tool | Purpose |
|------|---------|
| Node.js 22 | Runtime |
| `gh` CLI | GitHub API access (must be authenticated) |
| `claude` CLI | AI execution |
| `git` | Worktree management |

## Building

```sh
git clone https://github.com/stjohnb/claws-snapshot.git
cd claws-snapshot
npm ci
npm run build
```

## Running

Claws is an HTTP server plus a set of scheduled jobs. After building, start it directly:

```sh
node dist/main.js
```

It exposes a health endpoint at `http://localhost:3000/health` (port configurable via `PORT`). The process handles `SIGTERM` gracefully, so it can be run under any process supervisor.

The author runs it as a systemd service with a companion timer that pulls new releases and restarts on change (with health-check rollback). The scripts under `deploy/` are that personal setup, specific to the author's host and release feed — they are included for reference, not as a general installer.

## Configuration

Configuration is resolved per-field in this priority order:

1. **Environment variables** (highest priority)
2. **Config file** at `~/.claws/config.json`
3. **Hardcoded defaults** (where a sensible default exists)

### Slack notifications (optional)

Deploy and error notifications go to a Slack incoming webhook. The service starts without it, but Slack notifications are silently skipped.

Set it in `~/.claws/config.json`:

```json
{
  "slackWebhook": "https://hooks.slack.com/services/T.../B.../xxx"
}
```

### All configuration options

| Config key | Env variable | Default | Description |
|---|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | *(empty — must be set)* | Slack incoming-webhook URL |
| `githubOwners` | `CLAWS_GITHUB_OWNERS` | *(scans configured owners)* | GitHub accounts to scan (env var is comma-separated) |
| `selfRepo` | `CLAWS_SELF_REPO` | *(the source repo)* | Repo used for self-referencing error issues |
| `port` | `PORT` | `3000` | HTTP server port |
| `intervals.issueWorkerMs` | — | `300000` (5 min) | Issue worker poll interval |
| `intervals.issueRefinerMs` | — | `300000` (5 min) | Issue refiner poll interval |
| `intervals.ciFixerMs` | — | `600000` (10 min) | CI fixer poll interval |
| `intervals.reviewAddresserMs` | — | `300000` (5 min) | Review addresser poll interval |

### External tool authentication

These tools must be installed and authenticated on the host — they are **not** configured through `config.json` or environment variables:

| Tool | How to authenticate |
|---|---|
| `gh` CLI | Used as a subprocess. When a GitHub App is configured, Claws injects per-owner installation tokens via `GH_TOKEN`; otherwise it relies on the host's `gh auth login`. |
| `claude` CLI | Follow the Claude CLI setup instructions from Anthropic. |

### GitHub App authentication

Claws can authenticate to GitHub as a GitHub App: it mints short-lived per-owner installation tokens and injects them as `GH_TOKEN` / `GITHUB_TOKEN` into every `gh` and `git` subprocess, so PRs, comments, and pushes appear under the App's bot identity.

**Setup:**

1. Create a GitHub App (org- or user-level) with these repository permissions: **Contents** (read/write), **Issues** (read/write), **Pull requests** (read/write), **Metadata** (read), **Actions** (read), **Checks** (read), **Commit statuses** (read). Install it on each owner whose repos should be scanned.
2. Download the App's private key (`.pem`) and place it somewhere only the service user can read (e.g. `~/.claws/github-app.pem`, mode 0600).
3. Configure Claws:

| Config key | Env variable | Description |
|---|---|---|
| `githubAppId` | `CLAWS_GITHUB_APP_ID` | Numeric App ID |
| `githubAppPrivateKeyPath` | `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH` | Absolute path to the App's private key `.pem` file |
| `githubAppInstallationIds` | — | Optional `Record<owner, installation_id>` overrides; if omitted, Claws resolves installation IDs automatically via `/orgs/{owner}/installation` (falling back to `/users/{owner}/installation`) |

Example `~/.claws/config.json`:

```json
{
  "githubAppId": 123456,
  "githubAppPrivateKeyPath": "/home/claws/.claws/github-app.pem"
}
```

### Label workflow

Issues move through labels to track state:

```
Needs Refinement  →  (refiner runs)  →  Plan Produced
Refined           →  (worker runs)   →  PR created
```

PRs with failing CI are automatically patched. If the fix doesn't resolve the failure, the ci-fixer retries on the next cycle.

## Project structure

See [docs/OVERVIEW.md](docs/OVERVIEW.md) for the full module map. At a high level:

```
src/
├── main.ts       Entry point — sets up jobs and signal handlers
├── config.ts     Constants: owners, labels, intervals
├── scheduler.ts  Interval-based job runner (skip-if-busy)
├── github.ts     gh CLI wrapper
├── claude.ts     Claude CLI runner + git worktree helpers
└── jobs/         The individual automation jobs (refiner, worker, ci-fixer, and more)
```
