# Claws Overview

## Doc Map

| Doc | Read this when | Depth |
|---|---|---|
| [PRODUCT.md](PRODUCT.md) | You're planning a change and need the product constraints and rationale. | **Entry point** |
| [OVERVIEW.md](OVERVIEW.md) | You're starting implementation work and need to route to technical context. | **Entry point** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | You want the system map as Mermaid diagrams instead of prose. | **Reference** |
| [DESIGN.md](DESIGN.md) | You're touching dashboard HTML/CSS or client interaction patterns. | **Reference** |
| [agent-notes.md](agent-notes.md) | You hit an operator, host, or CI gotcha that does not belong to one subsystem. | **Reference** |
| [blog-post.md](blog-post.md) | You want the public narrative article, not implementation guidance. | **Deep dive** |
| [capabilities-scala3.md](capabilities-scala3.md) | You're comparing Claws' capability model to Scala 3 capture checking. | **Deep dive** |
| [claws-automation.md](claws-automation.md) | You need this repo's issue, PR, label, and merge lifecycle rules. | **Reference** |
| [completion-api.md](completion-api.md) | You're changing the one-shot completion API for managed services, its auth, limits or run isolation. | **Reference** |
| [configuration.md](configuration.md) | You need a config key, environment variable, default, or sensitive-value rule. | **Reference** |
| [database-schema.md](database-schema.md) | You're adding tables, migrating SQL, or touching SQLite/PostgreSQL compatibility. | **Deep dive** |
| [dspy-prompt-analysis.md](dspy-prompt-analysis.md) | You're evaluating DSPy or prompt-analysis options for Claws agents. | **Deep dive** |
| [harness-landscape.md](harness-landscape.md) | You're about to propose adopting a coding harness or agent framework. | **Deep dive** |
| [home-assistant.md](home-assistant.md) | You're setting up or debugging the Home Assistant integration's HA-side steps. | **Deep dive** |
| [issue-tracker.md](issue-tracker.md) | You're changing Claws' own issue store, its id format and routing, or the issue pages. | **Reference** |
| [jobs/README.md](jobs/README.md) | You're changing a job and need the shared lifecycle plus the per-job doc index. | **Reference** |
| [jobs/auth-secret-sync.md](jobs/auth-secret-sync.md) | You're changing provider credential sync into the `claws-auth` Secret. | **Deep dive** |
| [jobs/auto-merger.md](jobs/auto-merger.md) | You're changing merge-sweep cadence or the "Merge blocked" status comment. | **Deep dive** |
| [jobs/blog-draft-scanner.md](jobs/blog-draft-scanner.md) | You're changing draft-blog detection or blog issue creation. | **Deep dive** |
| [jobs/claude-memory-backup.md](jobs/claude-memory-backup.md) | You're changing memory backup to the `claude-memories` branch. | **Deep dive** |
| [jobs/content-moderator.md](jobs/content-moderator.md) | You're changing the automated pre-moderation of an app's user-submitted content (Bonkus feature requests). | **Deep dive** |
| [jobs/concurrency-scanner.md](jobs/concurrency-scanner.md) | You're changing GitHub Actions concurrency checks. | **Deep dive** |
| [jobs/dmarc-monitor.md](jobs/dmarc-monitor.md) | You're changing DMARC aggregate-report parsing or alerting. | **Deep dive** |
| [jobs/doc-maintainer.md](jobs/doc-maintainer.md) | You're changing this documentation maintenance workflow. | **Deep dive** |
| [jobs/email-monitor.md](jobs/email-monitor.md) | You're changing unread-email polling or mailbox routing. | **Deep dive** |
| [jobs/friction-retrospective.md](jobs/friction-retrospective.md) | You're changing agent friction notes, the fortnightly retrospective issue or the `/retro` page. | **Deep dive** |
| [jobs/host-disk-monitor.md](jobs/host-disk-monitor.md) | You're changing cleanup or disk alerts for the Claws host itself. | **Deep dive** |
| [jobs/host-policy-scanner.md](jobs/host-policy-scanner.md) | You're changing the scanner that enforces automation-host guidance. | **Deep dive** |
| [jobs/observability-contract-scanner.md](jobs/observability-contract-scanner.md) | You're changing the scanner that asks every repo to declare an observability policy. | **Deep dive** |
| [jobs/repo-avatar-scanner.md](jobs/repo-avatar-scanner.md) | You're changing the scanner that asks repos to declare an avatar in `claws.json`. | **Deep dive** |
| [jobs/idea-suggester.md](jobs/idea-suggester.md) | You're changing manually-triggered idea generation. | **Deep dive** |
| [jobs/improvement-identifier.md](jobs/improvement-identifier.md) | You're changing whole-repo improvement/security scanning. | **Deep dive** |
| [jobs/issue-auditor.md](jobs/issue-auditor.md) | You're changing plan-review reconciliation or native-issue close-out for issues. | **Deep dive** |
| [jobs/issue-dispatcher.md](jobs/issue-dispatcher.md) | You're changing issue planning, refinement, duplicate handling, or implementation dispatch. | **Deep dive** |
| [jobs/issue-importer.md](jobs/issue-importer.md) | You're moving a repository's forge issues into the native tracker. | **Deep dive** |
| [jobs/issue-shadow-sync.md](jobs/issue-shadow-sync.md) | You're changing how a live forge issue's native shadow record is kept in step. | **Deep dive** |
| [jobs/issue-preview-sync.md](jobs/issue-preview-sync.md) | You're changing how a planner's disposable preview — a PR or a bare branch — is mirrored onto its issue or retired. | **Deep dive** |
| [jobs/main-build-monitor.md](jobs/main-build-monitor.md) | You're changing default-branch build monitoring and build-failure issues. | **Deep dive** |
| [jobs/migration-scanner.md](jobs/migration-scanner.md) | You're changing migration filename convention checks. | **Deep dive** |
| [jobs/pr-dispatcher.md](jobs/pr-dispatcher.md) | You're changing PR review, CI fixing, conflict handling, or automerge dispatch. | **Deep dive** |
| [jobs/public-snapshot-sync.md](jobs/public-snapshot-sync.md) | You're changing private-to-public mirror publishing or scrubbing. | **Deep dive** |
| [jobs/reminder-monitor.md](jobs/reminder-monitor.md) | You're changing scheduled reminder issue creation. | **Deep dive** |
| [jobs/repo-standards.md](jobs/repo-standards.md) | You're changing label sync, legacy label cleanup, or repo standards. | **Deep dive** |
| [jobs/runner-monitor.md](jobs/runner-monitor.md) | You're changing self-hosted runner health or disk cleanup. | **Deep dive** |
| [jobs/runner-os-scanner.md](jobs/runner-os-scanner.md) | You're changing self-hosted runner OS-label checks. | **Deep dive** |
| [jobs/stale-branch-cleaner.md](jobs/stale-branch-cleaner.md) | You're changing stale `claws/*` branch cleanup. | **Deep dive** |
| [jobs/triage-claws-errors.md](jobs/triage-claws-errors.md) | You're changing automated investigation of `[claws-error]` issues. | **Deep dive** |
| [jobs/ubuntu-latest-scanner.md](jobs/ubuntu-latest-scanner.md) | You're changing checks for billed GitHub-hosted runners. | **Deep dive** |
| [jobs/upstream-watcher.md](jobs/upstream-watcher.md) | You're changing blocked-issue watches for upstream PRs, issues, or releases. | **Deep dive** |
| [jobs/whatsapp-handler.md](jobs/whatsapp-handler.md) | You're changing WhatsApp message-to-issue handling. | **Deep dive** |
| [k8s-cutover.md](k8s-cutover.md) | You need the history of the openclaw → Kubernetes cutover and k8s operating notes. | **Deep dive** |
| [label-audit.md](label-audit.md) | You need real label usage before adding, renaming, or deleting a label. | **Deep dive** |
| [metrics.md](metrics.md) | You're measuring dashboard latency, forge call timings or the rollout window, or changing Claws' Prometheus metrics. | **Reference** |
| [model-selection.md](model-selection.md) | You need to know which model tier a phase runs on, or where to change one. | **Reference** |
| [modules.md](modules.md) | You know the source file you're changing and need exports, gotchas, and rationale. | **Reference** |
| [observability.md](observability.md) | You're adding a route, DB query, background job or external call to Claws and need its required logs, metrics, latency budget and alerts. | **Reference** |
| [observability-contract.md](observability-contract.md) | You're changing the observability contract (logging rules included) every managed repo declares. | **Reference** |
| [observability-access.md](observability-access.md) | You are setting up or using the Grafana observability session capabilities. | **Deep dive** |
| [patterns.md](patterns.md) | You need the edge cases behind a named pattern from this overview. | **Reference** |
| [postmortem-process.md](postmortem-process.md) | You're writing an incident postmortem for any managed repo. | **Deep dive** |
| [postmortems/2026-07-18-node-runtime-mismatch-failed-rollback.md](postmortems/2026-07-18-node-runtime-mismatch-failed-rollback.md) | You're investigating the Node runtime mismatch deploy incident. | **Deep dive** |
| [refinements/71.doc.md](refinements/71.doc.md) | You need the original design notes for automated documentation maintenance. | **Deep dive** |
| [refinements/issue-flow.md](refinements/issue-flow.md) | You're implementing a phase of the issue-flow redesign: the requirements stage, stored PR state, or the board's stage columns. | **Deep dive** |
| [repo-config.md](repo-config.md) | You're onboarding a repo or adding a per-repo `claws.json` setting. | **Reference** |
| [slack-messages.md](slack-messages.md) | You're adding, changing or removing a Slack message, or need the inventory of what Claws posts and why. | **Reference** |
| [tool-evaluations.md](tool-evaluations.md) | You're about to propose a third-party tool or framework. | **Deep dive** |
| [upstream-watches/README.md](upstream-watches/README.md) | You're adding or debugging upstream watch manifests. | **Reference** |
| [upstream-watches/seerr-oidc-stable.yaml](upstream-watches/seerr-oidc-stable.yaml) | You're checking the Seerr OIDC upstream blocker. | **Deep dive** |
| [whatsapp-setup.md](whatsapp-setup.md) | You're setting up or debugging WhatsApp pairing and voice-note transcription. | **Deep dive** |

## Purpose

Claws is a self-hosted Forgejo automation service for the `St-John-Software` repos. It polls repositories, turns issue and PR state into work items, and runs Claude, Codex, or OpenCode in isolated git worktrees to plan, implement, review, fix CI, and maintain documentation.

This repo is both the product and one of the repos Claws manages, so documentation must preserve operational constraints that future agents need before changing automation behaviour.

## Architecture

Start with [modules.md](modules.md) once you know which source file matters; start with [ARCHITECTURE.md](ARCHITECTURE.md) when a diagram is faster. The compact flow is:

- `src/main.ts` dispatches on `CLAWS_ROLE` (#clw_01M5APX7YF3AGWHV1S1WMHJDR6). `all` (the default, one process) and `controller` run `src/main-controller.ts`: PID lock, config, database init and migrations, work-queue recovery, session backend start (pod reconcile), job registration, scheduler, the controller publisher and Hono server. Only this single instance runs jobs, claims work or migrates.
- `web` runs `src/main-web.ts`: the dashboard, API, agent-pod callbacks and terminal relays, with no persistent volume, scheduler, worker, WhatsApp gateway or migrations. It reads and changes background processing through the database (`src/controller-client.ts`), waits for the controller to record the schema version before it listens, proxies re-auth and WhatsApp pairing to the controller, and shows a "background processing is restarting" banner while the controller's heartbeat is stale. See [k8s-cutover.md](k8s-cutover.md#webcontroller-split).
- `src/config.ts`, `src/repo-config.ts`, and `claws.json` decide which repos and jobs exist. A root `claws.json` on the repo default branch is the mandatory opt-in gate.
- `src/github.ts` (the Forgejo-only forge façade) and `src/forgejo.ts` are the only managed-repo API layers, and `buildEnvForForgejoGit` in `src/github-app.ts` is the git-auth layer for them. `src/github-external.ts` is the only GitHub client, used by public snapshot sync and the upstream watcher; callers should not shell out to `api.github.com` directly.
- `src/db.ts` owns SQL through `src/db-driver.ts` and `src/db-driver-pg.ts`. SQLite is the default host backend; `CLAWS_DATABASE_URL` selects PostgreSQL for Kubernetes/staging.
- `src/jobs/*` are scheduled or event-driven scanners and monitors. `src/agents/*` are the task-specific planner, implementer, reviewer, CI fixer, review addresser, and merger flows they enqueue.
- `src/worker.ts` owns the persistent work queue. Dispatchers should identify work quickly and enqueue rows, not hold scheduler slots while agent processes run. With `CLAWS_WORK_BACKEND=k8s-pod`, `src/agent-pod-launcher.ts` runs each claimed row in its own pod (`src/agent-pod/*`), so a restart no longer kills it; the pod has no database access and acts through the enumerated agent-pod ops API (`src/agent-pod-ops.ts`).
- `src/claude.ts`, `src/capabilities.ts`, `src/sessions.ts`, and `src/session-env-file.ts` own agent execution, worktree/session isolation, provider selection, and capability-gated environment injection.
- `src/provider-holds.ts` owns provider, per-Claude-account and per-tier usage-limit holds, shared with agent pods through the `provider_holds` table.
- `src/server.ts`, `src/pages/*`, `src/client/*`, and generated `src/resources/*` make the dashboard. Read [DESIGN.md](DESIGN.md) before changing user-facing UI. The repo page, All PRs and the board's PR chips all read open-PR status from the cached `listPRStatuses` bulk fetch (`loadPRRowStatuses`, renderers in `src/pages/pr-status.ts`), so the three views agree about a PR.
- `deploy/*` holds the container entrypoint and bundled skill install script. The Kubernetes manifests live in `fleet-infra`; this repo publishes the image and runtime code.

## Jobs

Forty-three scheduled/manual jobs are registered in `src/main-controller.ts`, and WhatsApp messages are handled event-by-event through `jobs/whatsapp-handler.ts`. Use [jobs/README.md](jobs/README.md) for the shared lifecycle and per-job links; each complex job doc records its trigger, owned state, owner constraints, and failure behaviour.

Important routing:

- Issue work starts in [`jobs/issue-dispatcher.md`](jobs/issue-dispatcher.md), then flows through planner/refiner and implementer agents.
- PR work starts in [`jobs/pr-dispatcher.md`](jobs/pr-dispatcher.md), then flows through CI fixer, review addresser, and reviewer agents; the separate [`auto-merger`](jobs/auto-merger.md) job evaluates every open PR for merge every three minutes.
- Infrastructure monitors and scanners should file deduplicated/update-in-place alert issues, not comment spam.
- Smart-scheduled jobs use `smart-schedule.ts` to select stale repos under a concurrency cap, with an SLO escape valve for badly stale repos.

## Key Patterns

Open [patterns.md](patterns.md) for details and edge cases; this section is only a routing summary.

- **Content-based state machine:** issues and PRs are driven by visible comments, reactions, labels, and PR state. Use visible plain-text markers, never hidden HTML comments.
- **Worktree isolation:** write tasks use isolated worktrees under `~/.claws/worktrees/...`. Interactive sessions go through the `SessionBackend` boundary (`session-backend.ts`), implemented only by `k8s-pod`: one Kubernetes Pod per session with its own PVC checkout, so Claws rollouts never touch sessions (#3026). The host tmux backend was removed; sessions that ended on it stay in history but cannot be resumed. A large Claude session idle for `CLAWS_SESSION_AUTO_COMPACT_IDLE_MINUTES` (default 30) gets `/compact` typed into it while the 1-hour prompt cache is still warm, so it resumes cheaply (#3090); any unsent text in its input box is submitted along with it.
- **Headless shell:** Claws pins `SHELL`/`CLAUDE_CODE_SHELL` to bash for every headless CLI child, because Claude Code otherwise prefers the image's zsh. `grep`/`find` inside Claude's Bash tool are Claude Code's own ugrep/bfs shims (GNU flags work; `command grep` reaches the real binary).
- **Persistent work queue:** dispatchers enqueue serialized work in `work_queue`; workers claim rows idempotently so a long agent run cannot block the next dispatcher tick. A row is a candidate, not a decision: a free worker claims by the Priority flag (refreshed from the live label each time a dispatcher re-discovers the item), then pipeline stage rank (the item nearest to merge first — ci-fixer, then review-addresser, then pr-reviewer, then implementation, then planning), then age, and re-validates the winner against the forge (state, labels, head SHA) before an agent spawns.
- **Provider-aware model selection:** Claude, Codex, and OpenCode are selected through `model-selector.ts`, and every run asks for one of the four tiers (`fable`/`opus`/`sonnet`/`haiku`) described in [model-selection.md](model-selection.md); eligible unpinned tasks draw from enabled `aiProviders` by positive weights (default Claude:Codex:OpenCode = 4:2:1), while `Use Claude`, `Use Codex`, `Use OpenCode`, and `Plan: Deep` labels override defaults for a single item. Provider/model effectiveness is monitored through task outcomes plus exact-head review and merge signals; this observes quality but does not auto-tune weights. Background jobs pin their own provider rather than drawing from the weights — `doc-maintainer` runs on Codex (falling back to Claude) and labels any docs PR it did not write with Claude **Needs LGTM**, which withdraws the docs auto-merge exemption until a human reviews it and applies **Automerge**; see [jobs/README.md](jobs/README.md#provider-per-background-job) for the per-job audit.
- **Automated MCP parity:** headless agent runs pass the same Claws/Home Assistant MCP config through Claude, Codex, and OpenCode. Interactive Codex/OpenCode session MCP support is separate and intentionally narrower.
- **Capability gating:** sessions are default-deny for secrets (the opt-in `prod-observability` / `fleet-observability` capabilities give read-only Grafana query access to each cluster's metrics, logs and alerts via a service-account token; see [observability-access.md](observability-access.md); the opt-in, never-remembered `infra-merge` capability lets a session's `claws_merge_pr` count as the human merge of an infrastructure PR, with every other merge gate still applied and the headless auto-merger unchanged). Capabilities strip sensitive environment keys first, then re-grant selected values from a 0600 file so credentials do not appear in argv. The implicit `cross-repo` capability gives every session and shell-capable headless run guidance for reading other managed repos and filing companion issues; cross-repo reads are Forgejo-only, through the separate `forgejoReadToken`/`CLAWS_FORGEJO_READ_TOKEN` read/issue token when configured (#3152), held by every session and every non-isolated headless run including the escalation reviewer (which keeps Bash/Read/Glob/Grep but not Edit/Write). A Claude session with the `claws-state` MCP server is told, in one line, which other capabilities it may request; its `claws_request_capability` tool asks, the operator approves or denies on the session's page (OIDC session only — never the agent's bearer token), and the grant reaches the running session within seconds: Claws patches the session's Secret, then bumps a pod annotation so the kubelet remounts it at once, and polls the pod's terminal server (`GET /grants`) until the grant has landed. Every shell the agent runs sources the mounted granted-env (`BASH_ENV` plus the image's profile.d, bash.bashrc and zshenv hooks; the bash.bashrc hook precedes Debian's interactive guard because node-spawned tool shells — socket stdin, `SHLVL` < 2 — read it instead of `BASH_ENV`), so nothing is sourced by hand; `claws_request_capability` reports `landing` until the pod confirms the grant (#3072). Unless a waiting agent collects it, Claws types a one-line notice into the agent's terminal itself through the pod's `POST /notify`, after an approval or a direct Grant alike (#3106, #clw_01M4H27M8P02VT70091MBG0E4F). The create-form checkboxes and the live-grant dropdown group capabilities into labelled sections — agent logins, forge, infrastructure, SSH, tools — in a fixed order (#3138); the live-grant dropdown also shows held and fixed-at-launch capabilities, disabled with the reason, and an SSH grant reaches a running pod through Secret key slots every pod mounts from launch, which the pod polls every 2 s; a held SSH host can be revoked the same way, and only a pod launched before those slots existed waits for a resume (#3322). Auto-granted capabilities are shown on the create form rather than hidden: `cross-repo` always renders checked and disabled ("always granted"), and `forgejo` renders checked and disabled ("auto: Forgejo-hosted repo") only when the selection forces it, else as an ordinary opt-in checkbox (#3372). A session that starts another with `claws_start_session` (the `/new-session` skill), with or without an issue, gives it only the baseline grant; each extra capability it names becomes a pending request the operator decides on the new session's page (#clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE).
- **Forgejo separation:** every managed repo is read and written on Forgejo. The implicit `cross-repo` capability is read/code + issue-filing only; the implicit `forgejo` capability is push/API access for any session or headless run that has a working repo; the opt-in `forgejo-admin` capability is only for Actions secrets and variables (a session never gets a wider grant). The service also uses the same admin token in-process, read-only, to poll the Actions runner registry and waiting-jobs endpoints for `mac-runner-waker` (#3099) and for `runner-monitor`'s Forgejo runner discovery, queue-stall and long-running-job alerts (#2863). `forgejoAccessRepo` now scopes the push-capable working-repo grant, not general cross-forge reading.
- **Postgres compatibility:** new SQL must either fit the SQLite-to-Postgres translation rules in [database-schema.md](database-schema.md) or extend those rules and tests.
- **No noisy automation:** recurring alerts update one issue body, "nothing to do" findings should not create issues, and warnings that require human action should be visible on the forge or the UI, not only logs.

## Configuration

Use [configuration.md](configuration.md) for the full table. The high-risk values are:

| Area | Keys |
|---|---|
| Activation | `CLAWS_ACTIVATION_STATE=active|staging|verify-only`; verify-only starts the dashboard (with the connectivity checks in the Activation section of `/config`) but registers no side-effecting jobs; staging runs only the `Claws Staging` issue/PR pipeline. |
| Sessions | Pods only: `CLAWS_SESSION_BACKEND` is unset or `k8s-pod`, and any other value fails config load. The env-only `CLAWS_SESSION_*` variables set the pod settings. |
| Headless work | `CLAWS_WORK_BACKEND=in-process|k8s-pod` (default `in-process`, strict) plus the env-only `CLAWS_AGENT_POD_*` resources. Container deployments need `k8s-pod`, or every rollout kills running agents. |
| Database | unset `CLAWS_DATABASE_URL` means SQLite at `DB_PATH`; set `CLAWS_DATABASE_URL` plus optional `CLAWS_DATABASE_PASSWORD` for PostgreSQL. Passwords must not be printed or embedded in UI labels. |
| GitHub (public snapshots only) | `githubAppId`, `githubAppPrivateKeyPath`, `githubOwnerAppCredentials`, and installation IDs. Only the controller holds them: public snapshot sync and the upstream watcher reach GitHub through `github-external.ts`. Agent pods and sessions get no GitHub credential; their git auth is Forgejo's, from `buildEnvForForgejoGit`. |
| Forgejo | `forgejoBaseUrl`, `forgejoToken`, `forgejoReadToken`/`CLAWS_FORGEJO_READ_TOKEN` for implicit cross-repo read + issue filing, `CLAWS_FORGEJO_REPOS` emergency additive override, and optional `forgejoAdminToken`/`CLAWS_FORGEJO_ADMIN_TOKEN` for the explicit `forgejo-admin` session capability and for the service's own read-only `mac-runner-waker` and `runner-monitor` org runner-registry/waiting-job reads and the boot-time org webhook registration, and `forgejoWebhookSecret`/`CLAWS_FORGEJO_WEBHOOK_SECRET` to accept signed webhook deliveries that stream forge-originated `ci-status` and `forge-*` events to `claws_wait_for_change`. |
| Providers | `aiProviders`, provider rate-limit cooldown, Claude/Codex/OpenCode model settings, OpenRouter/OpenAI/Ollama keys, and CLI auth state. |
| Scheduling | `intervals.*`, `schedules.*`, `smartScheduling.*`, `pausedJobs`, `disabledJobsByRepo`, and per-repo `claws.json` `disabledJobs`. |
| Integrations | Slack, Gmail/DMARC, WhatsApp, Home Assistant, runner hosts, Mac runner wake targets, public snapshots, promotion, reminders, upstream watches, the env-only fleet pages host (`CLAWS_PAGES_*`: default PR-less issue-preview summaries and the opt-in `pages` session capability, whose per-session read token — derived from the signing key, not stored — is checked by the unauthenticated `/api/pages/auth` ForwardAuth route and turned into a pages-host cookie by `/__claws/login/<token>`, see `src/pages-read-token.ts`), and the env-only fleet CUPS service (`CLAWS_PRINT_SERVER`: the opt-in `print` session capability). |

Unknown `config.json` keys are discarded and surfaced in the UI/alerts so stale config can be removed deliberately. Host/operator state stays in config; durable per-repo policy belongs in `claws.json` when the setting describes the repo itself.

## Technology Stack

- TypeScript on Node.js, ESM only; relative imports include `.js`.
- Hono renders server-side dashboard pages; client TypeScript is bundled by esbuild into generated resource modules.
- Tailwind is generated through `scripts/build-tailwind.mjs`; keep UI changes aligned with [DESIGN.md](DESIGN.md).
- SQLite uses `better-sqlite3`; PostgreSQL uses `pg`, with PGlite for the `npm run test:pg` lane.
- Claude, Codex, OpenCode, tmux, git, `gh` (used only by `github-external.ts` for the public snapshot targets and upstream reads), and optional Whisper/Home Assistant integrations are runtime tools, not libraries.

## Runtime Layout

`~/.claws` is the durable work directory: `config.json`, `env`, `repos/`, `worktrees/`, prompt captures, WhatsApp auth, and SQLite on the host backend. Kubernetes uses a PVC for this state but stores the database in shared Postgres once `CLAWS_DATABASE_URL` is set. On Kubernetes, only `config.json`, `pending-ideas/` and `whatsapp-auth/` are migrated from a host, and `env` is never copied (see [k8s-cutover.md#data-migration](k8s-cutover.md#data-migration)). Session state is not in `~/.claws`: each session's HOME, checkout and uploads live on its own `claws-session-<id>` PVC in `claws-sessions`.

Agent credentials and session homes are intentionally narrow. `~/.claude` and `~/.codex` may be rebuilt from Secrets in containers; durable agent memories are backed up to the `claude-memories` branch and folded into docs by `doc-maintainer`, not restored into a pod home. An interactive session's memories live on its PVC, so when it ends a one-shot read-only capture pod copies them into the database before the PVC can be deleted, and `claude-memory-backup` pushes them to their own `memories/session-<id>-<slug>` directories without touching any other source's (see [jobs/claude-memory-backup.md](jobs/claude-memory-backup.md#session-memories)).

## Kubernetes Deployment

Read [k8s-cutover.md](k8s-cutover.md) for the operator runbook. The app-side contract is:

- This repo publishes the container image and runtime entrypoint; fleet-infra owns Kubernetes manifests, Secrets, NetworkPolicy, ingress, and traffic cutover.
- `CLAWS_ACTIVATION_STATE=verify-only` lets staging boot beside openclaw without doing work during the cutover. `CLAWS_ACTIVATION_STATE=staging` runs only `issue-dispatcher`/`pr-dispatcher`/`auto-merger` plus worker handlers, and `isDispatchSkippable` restricts execution to live issues and PRs carrying `Claws Staging`; all background jobs stay off. `CLAWS_ACTIVATION_STATE=active` is normal production mode and skips `Claws Staging` items.
- `auth-secret-sync` is the credential rotation bridge for ephemeral provider homes in the pod.
- Interactive sessions run only as pods (#3026). Claws creates one Pod, Service, Secret and PVC per session in `claws-sessions` using only its projected ServiceAccount token, and proxies the terminal to it, so a Claws rollout leaves sessions running. There is no shared session runtime. A pod's Secret holds only the credentials granted to that session. The `session-backend` connectivity check on `/config` checks the session image and RBAC, including `patch` on pods, which forces a pod to re-sync its Secret after a live grant; without it grants still land, on the kubelet's 1–2 minute schedule. Capturing an ended session's memories also needs `get` on `pods/log`; without it the capture fails, raises one alert issue, and the session still ends and is deleted normally.
- Headless agent runs survive a rollout with `CLAWS_WORK_BACKEND=k8s-pod` (#clw_01M34R5RECDPPXVXBJZS1DA6C1): each claimed work-queue row runs in a `claws-agent-<rowId>` Pod with a Secret holding the service's forge and CLI credentials (never database ones) and a per-run token for `claws-state` and the agent-pod ops API, and the next boot re-attaches to pods a restart left running. Image-pull failures raise the single `[claws-error] agent-pod:image-pull` alert (naming the image, registry and pull secrets) instead of one error issue per row; it closes itself when a pod next starts. A pod the scheduler cannot place for lack of cluster capacity waits for room instead of failing as a broken run; a wait over 30 minutes raises the single `[claws-error] agent-pod:capacity` alert, which closes when a waiting pod is scheduled, and a row is failed only after 6 hours of waiting. Start failures name the scheduler's reason rather than a bare "pending". Each pod reserves `CLAWS_AGENT_POD_EPHEMERAL_STORAGE_REQUEST` of node disk, separate from the eviction cap `CLAWS_AGENT_POD_EPHEMERAL_STORAGE_LIMIT`. The `work-backend` connectivity check FAILs `in-process` inside a container. See [k8s-cutover.md](k8s-cutover.md#pod-per-run-headless-agents-clw_01m34r5recdppxvxbjzs1da6c1). A pod that stays Pending with no stated reason, or only an ordinary startup state (`ContainerCreating`, `PodInitializing`), is named as never scheduled, or as scheduled to a given node with no container started; it is retried once by re-queueing the row, and only a second stall raises the single `[claws-error] agent-pod:never-started` issue. A start-timeout failure also names the pod's latest warning event (`last pod event: <reason>: <message>`) when one exists. A pod the kubelet rejects at admission for a resource or affinity reason (`OutOfmemory`, `OutOfcpu`, `OutOfpods`, `UnexpectedAdmissionError`, `NodeAffinity`; classified with `admissionRejected`) is re-queued once for any kind, with a warning naming the reason and no `[claws-error]` issue; only a second rejection files `agent-pod:run`. A pod deleted outside Claws or lost with its node mid-run is likewise re-queued once for every kind but the repo-scoped sweeps, and the implementer's retry resumes on the lost attempt's branch and PR instead of opening another (#clw_01M5ZCYHRJ9SPXX78HFC21J6GK), so every headless kind may run on the part-time off-node placement; only a second vanish raises the single `[claws-error] agent-pod:vanished` issue, and a disruption reason seen before the deletion (e.g. `PreemptionByScheduler`) is named in the log and failure. Agent pods should run under a priority class low-priority pods cannot preempt (`CLAWS_SESSION_PRIORITY_CLASS`). The agent image carries single-user Nix with the session-shell store registered (so `nix develop` uses each repo's flake devShell), python3/make/g++ for node-gyp, and no `NODE_ENV`; only the service's entrypoint path sets `NODE_ENV=production`.
- `.forgejo/workflows/release.yml` (Forgejo Actions) tags `main`, publishes a Forgejo release recording `Claude Code CLI: x.y.z`, pushes `registry.home.bstjohn.net/st-john-software/claws:<tag>` and `:latest` to the LAN registry, and dispatches fleet-infra's `update-claws.yml` through the Forgejo workflow-dispatch API (authorized by the Forgejo org secret `FLEET_INFRA_VERSION_BUMP`), which opens an auto-merged `automation/bump-claws` PR against `clusters/my-cluster/claws/statefulset.yaml`; Flux reconciles and `claws-0` rolls, roughly 20–25 minutes from merge to ready (it stays one pod, and the dashboard is briefly unreachable while it rolls; see [why the controller stays a single-replica StatefulSet](k8s-cutover.md#why-the-controller-stays-a-single-replica-statefulset)), and `GET /health` reports the running release tag.

## Related repositories

Claws generates this section from verified evidence only — `deploys` entries in `claws.json`, workflow dispatches, container image references in YAML manifests, and OIDC trust-policy subjects in Terraform/OpenTofu files. To change it, edit that evidence, not this section.

**Deployed, configured or provisioned by:**

- [St-John-Software/fleet-infra](https://git.home.bstjohn.net/St-John-Software/fleet-infra): [`.forgejo/workflows/update-claws.yml`](https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/.forgejo/workflows/update-claws.yml) (deploys, dispatch from [`.forgejo/workflows/release.yml`](https://git.home.bstjohn.net/St-John-Software/claws/src/branch/main/.forgejo/workflows/release.yml)); [`clusters/my-cluster/claws-prepull/deployment.yaml`](https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/clusters/my-cluster/claws-prepull/deployment.yaml) (deploys, image); [`clusters/my-cluster/claws/deployment.yaml`](https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/clusters/my-cluster/claws/deployment.yaml) (deploys, image); [`clusters/my-cluster/claws/statefulset.yaml`](https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/clusters/my-cluster/claws/statefulset.yaml) (deploys, image)
