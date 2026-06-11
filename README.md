# claws

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

## Deployment

Claws runs as a systemd service on a Linux server. An accompanying timer-based updater automatically pulls new GitHub releases, swaps the build artefacts, and restarts the service (with automatic rollback on health-check failure).

### Prerequisites

| Tool | Purpose |
|------|---------|
| Node.js 22 | Runtime |
| `gh` CLI | GitHub API access (must be authenticated) |
| `claude` CLI | AI execution |
| `git` | Worktree management |

### Building

```sh
npm ci
npm run build
```

### Installing

```sh
gh api repos/St-John-Software/claws/contents/deploy/install.sh --jq .content | base64 -d | bash
```

This downloads the latest release to `/opt/claws`, installs the systemd units (templated to the current user), and starts the service. Requires `gh` CLI to be installed and authenticated.

### Running

The service is managed by systemd:

```sh
sudo systemctl start claws      # start
sudo systemctl stop claws       # stop (sends SIGTERM, waits for in-flight jobs)
sudo systemctl status claws     # check status
journalctl -u claws -f          # tail logs
```

The process handles `SIGTERM` gracefully, so systemd can stop it cleanly.

### Auto-updates

The `claws-updater.timer` checks for new GitHub releases every 60 seconds. When a new release is found, `deploy/deploy.sh` downloads the tarball, swaps the `dist/` directory, restarts the service, and verifies health via `http://localhost:3000/health`. If the health check fails, it automatically rolls back to the previous version.

## Configuration

Configuration is resolved per-field in this priority order:

1. **Environment variables** (highest priority)
2. **Config file** at `~/.claws/config.json`
3. **Hardcoded defaults** (where a sensible default exists)

### Required setup before first run

The `install.sh` script creates a skeleton `~/.claws/config.json`. Before starting the service you **must** populate the following value — it has no usable default:

| Config key | Env variable | Description |
|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | Slack incoming-webhook URL for deploy/error notifications |

Set it in **either** `~/.claws/config.json`:

```json
{
  "slackWebhook": "https://hooks.slack.com/services/T.../B.../xxx"
}
```

**or** in `~/.claws/env` (loaded by the systemd unit):

```sh
CLAWS_SLACK_WEBHOOK=https://hooks.slack.com/services/T.../B.../xxx
```

The service will start without it, but all Slack notifications will be silently skipped.

### All configuration options

| Config key | Env variable | Default | Description |
|---|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | *(empty — must be set)* | Slack incoming-webhook URL |
| `githubOwners` | `CLAWS_GITHUB_OWNERS` | `["stjohnb","St-John-Software"]` | GitHub accounts to scan (env var is comma-separated) |
| `selfRepo` | `CLAWS_SELF_REPO` | `St-John-Software/claws` | Repo used for self-referencing error issues |
| `port` | `PORT` | `3000` | HTTP server port |
| `intervals.issueWorkerMs` | — | `300000` (5 min) | Issue worker poll interval |
| `intervals.issueRefinerMs` | — | `300000` (5 min) | Issue refiner poll interval |
| `intervals.ciFixerMs` | — | `600000` (10 min) | CI fixer poll interval |
| `intervals.reviewAddresserMs` | — | `300000` (5 min) | Review addresser poll interval |

### External tool authentication

These tools must be installed and authenticated on the host — they are **not** configured through `config.json` or environment variables:

| Tool | How to authenticate |
|---|---|
| `gh` CLI | Used as a subprocess; Claws injects per-owner GitHub App installation tokens via `GH_TOKEN`. The host's `gh auth login` is still used by the Claude CLI subprocess (see GitHub App section). |
| `claude` CLI | Follow [Claude CLI setup](https://docs.anthropic.com/en/docs/claude-cli) |

### GitHub App authentication (required)

Claws authenticates to GitHub as a GitHub App. It mints short-lived per-owner installation tokens and injects them as `GH_TOKEN` / `GITHUB_TOKEN` into every `gh` and `git` subprocess. PRs, comments, and pushes appear under the App's bot identity (`<slug>[bot]`) rather than a personal user.

Claws requires a GitHub App for its own `gh` and `git` calls — startup will fail if `githubAppId` and `githubAppPrivateKeyPath` are not set (or if at least one entry in `githubOwnerAppCredentials` doesn't resolve).

**Setup:**

1. Create a GitHub App (org- or user-level) with these repository permissions: **Contents** (read/write), **Issues** (read/write), **Pull requests** (read/write), **Metadata** (read), **Actions** (read), **Checks** (read), **Commit statuses** (read). Install it on each owner whose repos should be scanned (owners listed in `githubOwners`).
2. Download the App's private key (`.pem`) and place it somewhere on the Claws host that only the `claws` user can read (e.g. `~/.claws/github-app.pem`, mode 0600).
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

**Note:** The Claude CLI subprocess still uses the host's `gh auth` token for anything it invokes itself (it inherits the host's `gh` configuration). Only Claws's own `gh` and `git` calls are re-signed with the installation token.

### Label workflow

Issues move through labels to track state:

```
Needs Refinement  →  (refiner runs)  →  Plan Produced
Refined           →  (worker runs)   →  PR created
```

PRs with failing CI are automatically patched. If the fix doesn't resolve the failure, the ci-fixer will retry on the next cycle.

## Project structure

```
src/
├── main.ts              Entry point — sets up jobs and signal handlers
├── config.ts            Constants: owners, labels, intervals
├── scheduler.ts         Interval-based job runner (skip-if-busy)
├── github.ts            gh CLI wrapper
├── claude.ts            Claude CLI runner + git worktree helpers
├── log.ts               Timestamped logging
└── jobs/
    ├── issue-refiner.ts   Refines issues into implementation plans
    ├── issue-worker.ts    Implements issues as PRs
    └── ci-fixer.ts        Fixes failing CI on PRs
```

