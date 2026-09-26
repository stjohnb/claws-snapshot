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
| [jobs/concurrency-scanner.md](jobs/concurrency-scanner.md) | You're changing GitHub Actions concurrency checks. | **Deep dive** |
| [jobs/dependabot-alert-monitor.md](jobs/dependabot-alert-monitor.md) | You're changing Dependabot alert ingestion, dismissal, or remediation. | **Deep dive** |
| [jobs/dependabot-config-scanner.md](jobs/dependabot-config-scanner.md) | You're changing dependency-update coverage checks. | **Deep dive** |
| [jobs/dependabot-run-monitor.md](jobs/dependabot-run-monitor.md) | You're changing Dependabot updater workflow monitoring. | **Deep dive** |
| [jobs/dependabot-tofu-unblocker.md](jobs/dependabot-tofu-unblocker.md) | You're changing the bstjohn-blog Terraform/OpenTofu Dependabot unblocker. | **Deep dive** |
| [jobs/dmarc-monitor.md](jobs/dmarc-monitor.md) | You're changing DMARC aggregate-report parsing or alerting. | **Deep dive** |
| [jobs/doc-maintainer.md](jobs/doc-maintainer.md) | You're changing this documentation maintenance workflow. | **Deep dive** |
| [jobs/dynamic-workflow-runner-scanner.md](jobs/dynamic-workflow-runner-scanner.md) | You're changing checks for GitHub-generated workflows on billed runners. | **Deep dive** |
| [jobs/email-monitor.md](jobs/email-monitor.md) | You're changing unread-email polling or mailbox routing. | **Deep dive** |
| [jobs/host-disk-monitor.md](jobs/host-disk-monitor.md) | You're changing cleanup or disk alerts for the Claws host itself. | **Deep dive** |
| [jobs/host-policy-scanner.md](jobs/host-policy-scanner.md) | You're changing the scanner that enforces automation-host guidance. | **Deep dive** |
| [jobs/idea-suggester.md](jobs/idea-suggester.md) | You're changing manually-triggered idea generation. | **Deep dive** |
| [jobs/improvement-identifier.md](jobs/improvement-identifier.md) | You're changing whole-repo improvement/security scanning. | **Deep dive** |
| [jobs/issue-auditor.md](jobs/issue-auditor.md) | You're changing Ready reconciliation or native-issue close-out for issues. | **Deep dive** |
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
| [jobs/runner-metrics-sync.md](jobs/runner-metrics-sync.md) | You're changing workflow-run ingestion. | **Deep dive** |
| [jobs/runner-monitor.md](jobs/runner-monitor.md) | You're changing self-hosted runner health or disk cleanup. | **Deep dive** |
| [jobs/runner-os-scanner.md](jobs/runner-os-scanner.md) | You're changing self-hosted runner OS-label checks. | **Deep dive** |
| [jobs/shopping-comment-processor.md](jobs/shopping-comment-processor.md) | You're changing shopping-list comment-to-manifest updates. | **Deep dive** |
| [jobs/shopping-sourcer.md](jobs/shopping-sourcer.md) | You're changing marketplace sourcing for `docs/shopping/*.yaml`. | **Deep dive** |
| [jobs/stale-branch-cleaner.md](jobs/stale-branch-cleaner.md) | You're changing stale `claws/*` branch cleanup. | **Deep dive** |
| [jobs/triage-claws-errors.md](jobs/triage-claws-errors.md) | You're changing automated investigation of `[claws-error]` issues. | **Deep dive** |
| [jobs/ubuntu-latest-scanner.md](jobs/ubuntu-latest-scanner.md) | You're changing checks for billed GitHub-hosted runners. | **Deep dive** |
| [jobs/upstream-watcher.md](jobs/upstream-watcher.md) | You're changing blocked-issue watches for upstream PRs, issues, or releases. | **Deep dive** |
| [jobs/whatsapp-handler.md](jobs/whatsapp-handler.md) | You're changing WhatsApp message-to-issue handling. | **Deep dive** |
| [k8s-cutover.md](k8s-cutover.md) | You need the history of the openclaw → Kubernetes cutover and k8s operating notes. | **Deep dive** |
| [label-audit.md](label-audit.md) | You need real label usage before adding, renaming, or deleting a label. | **Deep dive** |
| [logging-conventions.md](logging-conventions.md) | You're changing the structured log-line contract services must follow. | **Reference** |
| [model-selection.md](model-selection.md) | You need to know which model tier a phase runs on, or where to change one. | **Reference** |
| [modules.md](modules.md) | You know the source file you're changing and need exports, gotchas, and rationale. | **Reference** |
| [patterns.md](patterns.md) | You need the edge cases behind a named pattern from this overview. | **Reference** |
| [postmortem-process.md](postmortem-process.md) | You're writing an incident postmortem for any managed repo. | **Deep dive** |
| [postmortems/2026-07-18-node-runtime-mismatch-failed-rollback.md](postmortems/2026-07-18-node-runtime-mismatch-failed-rollback.md) | You're investigating the Node runtime mismatch deploy incident. | **Deep dive** |
| [refinements/71.doc.md](refinements/71.doc.md) | You need the original design notes for automated documentation maintenance. | **Deep dive** |
| [refinements/issue-flow.md](refinements/issue-flow.md) | You're implementing a phase of the issue-flow redesign: the requirements stage, stored PR state, or the board's stage columns. | **Deep dive** |
| [repo-config.md](repo-config.md) | You're onboarding a repo or adding a per-repo `claws.json` setting. | **Reference** |
| [tool-evaluations.md](tool-evaluations.md) | You're about to propose a third-party tool or framework. | **Deep dive** |
| [upstream-watches/README.md](upstream-watches/README.md) | You're adding or debugging upstream watch manifests. | **Reference** |
| [upstream-watches/fleet-infra-lan-registry-only.yaml](upstream-watches/fleet-infra-lan-registry-only.yaml) | You're checking the fleet-infra LAN-registry upstream blocker. | **Deep dive** |
| [upstream-watches/seerr-oidc-stable.yaml](upstream-watches/seerr-oidc-stable.yaml) | You're checking the Seerr OIDC upstream blocker. | **Deep dive** |
| [whatsapp-setup.md](whatsapp-setup.md) | You're setting up or debugging WhatsApp pairing and voice-note transcription. | **Deep dive** |

## Purpose

Claws is a self-hosted GitHub and Forgejo automation service for the `St-John-Software` repos. It polls repositories, turns issue and PR state into work items, and runs Claude, Codex, or OpenCode in isolated git worktrees to plan, implement, review, fix CI, and maintain documentation.

This repo is both the product and one of the repos Claws manages, so documentation must preserve operational constraints that future agents need before changing automation behaviour.

## Architecture

Start with [modules.md](modules.md) once you know which source file matters; start with [ARCHITECTURE.md](ARCHITECTURE.md) when a diagram is faster. The compact flow is:

- `src/main.ts` boots the process: PID lock, config, database init, work-queue recovery, session backend start (tmux recovery or pod reconcile), job registration, scheduler, and Hono server.
- `src/config.ts`, `src/repo-config.ts`, and `claws.json` decide which repos and jobs exist. A root `claws.json` on the repo default branch is the mandatory opt-in gate on GitHub and Forgejo.
- `src/github.ts`, `src/github-app.ts`, and `src/forgejo.ts` are the only GitHub/Forgejo API and git-auth layers. Callers should not shell out to `api.github.com` directly.
- `src/db.ts` owns SQL through `src/db-driver.ts` and `src/db-driver-pg.ts`. SQLite is the default host backend; `CLAWS_DATABASE_URL` selects PostgreSQL for Kubernetes/staging.
- `src/jobs/*` are scheduled or event-driven scanners and monitors. `src/agents/*` are the task-specific planner, implementer, reviewer, CI fixer, review addresser, and merger flows they enqueue.
- `src/worker.ts` owns the persistent work queue. Dispatchers should identify work quickly and enqueue rows, not hold scheduler slots while agent processes run. With `CLAWS_WORK_BACKEND=k8s-pod`, `src/agent-pod-launcher.ts` runs each claimed row in its own pod (`src/agent-pod/*`), so a restart no longer kills it; the pod has no database access and acts through the enumerated agent-pod ops API (`src/agent-pod-ops.ts`).
- `src/claude.ts`, `src/capabilities.ts`, `src/sessions.ts`, and `src/session-env-file.ts` own agent execution, worktree/session isolation, provider selection, and capability-gated environment injection.
- `src/server.ts`, `src/pages/*`, `src/client/*`, and generated `src/resources/*` make the dashboard. Read [DESIGN.md](DESIGN.md) before changing user-facing UI.
- `deploy/*` holds the container entrypoint and bundled skill install script. The Kubernetes manifests live in `fleet-infra`; this repo publishes the image and runtime code.

## Jobs

Forty-five scheduled/manual jobs are registered in `src/main.ts`, and WhatsApp messages are handled event-by-event through `jobs/whatsapp-handler.ts`. Use [jobs/README.md](jobs/README.md) for the shared lifecycle and per-job links; each complex job doc records its trigger, owned state, owner constraints, and failure behaviour.

Important routing:

- Issue work starts in [`jobs/issue-dispatcher.md`](jobs/issue-dispatcher.md), then flows through planner/refiner and implementer agents.
- PR work starts in [`jobs/pr-dispatcher.md`](jobs/pr-dispatcher.md), then flows through CI fixer, review addresser, and reviewer agents; the separate [`auto-merger`](jobs/auto-merger.md) job evaluates every open PR for merge every three minutes.
- Infrastructure monitors and scanners should file deduplicated/update-in-place alert issues, not comment spam.
- Smart-scheduled jobs use `smart-schedule.ts` to select stale repos under a concurrency cap, with an SLO escape valve for badly stale repos.

## Key Patterns

Open [patterns.md](patterns.md) for details and edge cases; this section is only a routing summary.

- **Content-based state machine:** issues and PRs are driven by visible comments, reactions, labels, and PR state. Use visible plain-text markers, never hidden HTML comments.
- **Worktree isolation:** write tasks use isolated worktrees under `~/.claws/worktrees/...`. Interactive sessions go through the `SessionBackend` boundary (`session-backend.ts`): `local-tmux` (the default) runs tmux on the Claws host and may use worktrees; `k8s-pod` runs one Kubernetes Pod per session with its own PVC checkout, so Claws rollouts never touch sessions (#3026). On both, a large Claude session idle for `CLAWS_SESSION_AUTO_COMPACT_IDLE_MINUTES` (default 30) gets `/compact` typed into it while the 1-hour prompt cache is still warm, so it resumes cheaply (#3090); any unsent text in its input box is submitted along with it.
- **Persistent work queue:** dispatchers enqueue serialized work in `work_queue`; workers claim rows idempotently so a long agent run cannot block the next dispatcher tick. A row is a candidate, not a decision: a free worker claims by the Priority flag (refreshed from the live label each time a dispatcher re-discovers the item), then pipeline stage rank (the item nearest to merge first — ci-fixer, then review-addresser, then pr-reviewer, then implementation, then planning), then age, and re-validates the winner against the forge (state, labels, head SHA) before an agent spawns.
- **Provider-aware model selection:** Claude, Codex, and OpenCode are selected through `model-selector.ts`, and every run asks for one of the four tiers (`fable`/`opus`/`sonnet`/`haiku`) described in [model-selection.md](model-selection.md); eligible unpinned tasks draw from enabled `aiProviders` by positive weights (default Claude:Codex:OpenCode = 4:2:1), while `Use Claude`, `Use Codex`, `Use OpenCode`, and `Plan: Deep` labels override defaults for a single item. Provider/model effectiveness is monitored through task outcomes plus exact-head review and merge signals; this observes quality but does not auto-tune weights. Background jobs pin their own provider rather than drawing from the weights — `doc-maintainer` runs on Codex (falling back to Claude) and labels any docs PR it did not write with Claude **Needs LGTM**, which withdraws the docs auto-merge exemption until a human reviews it and applies **Automerge**; see [jobs/README.md](jobs/README.md#provider-per-background-job) for the per-job audit.
- **Automated MCP parity:** headless agent runs pass the same Claws/Home Assistant MCP config through Claude, Codex, and OpenCode. Interactive Codex/OpenCode session MCP support is separate and intentionally narrower.
- **Capability gating:** sessions are default-deny for secrets. Capabilities strip sensitive environment keys first, then re-grant selected values from a 0600 file so credentials do not appear in argv. The implicit `cross-repo` capability gives every session and shell-capable headless run guidance for reading other managed repos and filing companion issues; GitHub uses the authenticated `gh` CLI, while Forgejo uses only the separate `forgejoReadToken`/`CLAWS_FORGEJO_READ_TOKEN` read/issue token when configured (#3152). A Claude session with the `claws-state` MCP server is told, in one line, which other capabilities it may request; its `claws_request_capability` tool asks, the operator approves or denies on the session's page (OIDC session only — never the agent's bearer token), and the grant reaches the running session as a file to source (#3072); if the tool already stopped waiting, the approving page types a one-line notice into the agent's terminal (#3106). The create-form checkboxes and the live-grant dropdown group capabilities into labelled sections — agent logins, forge, infrastructure, SSH, tools — in a fixed order (#3138); the live-grant dropdown also shows held and fixed-at-launch capabilities, disabled with the reason, and an SSH grant to a pod launched without keys takes effect on resume (#3322). Auto-granted capabilities are shown on the create form rather than hidden: `cross-repo` always renders checked and disabled ("always granted"), and `forgejo` renders checked and disabled ("auto: Forgejo-hosted repo") only when the selection forces it, else as an ordinary opt-in checkbox (#3372).
- **Forgejo separation:** Forgejo-canonical repos are read and written on Forgejo. The implicit `cross-repo` capability is read/code + issue-filing only; the implicit `forgejo` capability is push/API access only for sessions or headless runs whose working repo is Forgejo-hosted; the opt-in `forgejo-admin` capability is only for Actions secrets and variables (a session never gets a wider grant). The service also uses the same admin token in-process, read-only, to poll the Actions runner registry and waiting-jobs endpoints for `mac-runner-waker` (#3099) and for `runner-monitor`'s Forgejo runner discovery, queue-stall and long-running-job alerts (#2863). `forgejoAccessRepo` now scopes the push-capable working-repo grant, not general cross-forge reading.
- **Postgres compatibility:** new SQL must either fit the SQLite-to-Postgres translation rules in [database-schema.md](database-schema.md) or extend those rules and tests.
- **No noisy automation:** recurring alerts update one issue body, "nothing to do" findings should not create issues, and warnings that require human action should be visible in GitHub or the UI, not only logs.

## Configuration

Use [configuration.md](configuration.md) for the full table. The high-risk values are:

| Area | Keys |
|---|---|
| Activation | `CLAWS_ACTIVATION_STATE=active|staging|verify-only`; verify-only starts the dashboard (with the connectivity checks in the Activation section of `/config`) but registers no side-effecting jobs; staging runs only the `Claws Staging` issue/PR pipeline. |
| Sessions | `CLAWS_SESSION_BACKEND=local-tmux|k8s-pod` (default `local-tmux`, strict) plus the env-only `CLAWS_SESSION_*` pod settings. Container deployments need `k8s-pod`, or every rollout kills sessions. |
| Headless work | `CLAWS_WORK_BACKEND=in-process|k8s-pod` (default `in-process`, strict) plus the env-only `CLAWS_AGENT_POD_*` resources. Container deployments need `k8s-pod`, or every rollout kills running agents. |
| Database | unset `CLAWS_DATABASE_URL` means SQLite at `DB_PATH`; set `CLAWS_DATABASE_URL` plus optional `CLAWS_DATABASE_PASSWORD` for PostgreSQL. Passwords must not be printed or embedded in UI labels. |
| GitHub | `githubOwners`, `githubAppId`, `githubAppPrivateKeyPath`, `githubOwnerAppCredentials`, and installation IDs. All `gh`/`git` subprocesses inherit auth through `github-app.ts`. |
| Forgejo | `forgejoBaseUrl`, `forgejoToken`, `forgejoReadToken`/`CLAWS_FORGEJO_READ_TOKEN` for implicit cross-repo read + issue filing, `CLAWS_FORGEJO_REPOS` emergency additive override, and optional `forgejoAdminToken`/`CLAWS_FORGEJO_ADMIN_TOKEN` for the explicit `forgejo-admin` session capability and for the service's own read-only `mac-runner-waker` and `runner-monitor` org runner-registry/waiting-job reads. |
| Providers | `aiProviders`, provider rate-limit cooldown, Claude/Codex/OpenCode model settings, OpenRouter/OpenAI/Ollama keys, and CLI auth state. |
| Scheduling | `intervals.*`, `schedules.*`, `smartScheduling.*`, `pausedJobs`, `disabledJobsByRepo`, and per-repo `claws.json` `disabledJobs`. |
| Integrations | Slack, Gmail/DMARC, WhatsApp, Home Assistant, runner hosts, Mac runner wake targets, public snapshots, shopping, promotion, reminders, and upstream watches. |

Unknown `config.json` keys are discarded and surfaced in the UI/alerts so stale config can be removed deliberately. Host/operator state stays in config; durable per-repo policy belongs in `claws.json` when the setting describes the repo itself.

## Technology Stack

- TypeScript on Node.js, ESM only; relative imports include `.js`.
- Hono renders server-side dashboard pages; client TypeScript is bundled by esbuild into generated resource modules.
- Tailwind is generated through `scripts/build-tailwind.mjs`; keep UI changes aligned with [DESIGN.md](DESIGN.md).
- SQLite uses `better-sqlite3`; PostgreSQL uses `pg`, with PGlite for the `npm run test:pg` lane.
- Claude, Codex, OpenCode, tmux, `gh`, git, kubectl, and optional Whisper/Home Assistant integrations are runtime tools, not libraries.

## Runtime Layout

`~/.claws` is the durable work directory: `config.json`, `env`, `repos/`, `worktrees/`, `local-tmux` session state and uploads, prompt captures, WhatsApp auth, and SQLite on the host backend. Kubernetes uses a PVC for this state but stores the database in shared Postgres once `CLAWS_DATABASE_URL` is set. On Kubernetes, only `config.json`, `pending-ideas/` and `whatsapp-auth/` are migrated from a host, and `env` is never copied (see [k8s-cutover.md#data-migration](k8s-cutover.md#data-migration)). On the `k8s-pod` session backend, session state is not in `~/.claws`: each session's HOME, checkout and uploads live on its own `claws-session-<id>` PVC in `claws-sessions`.

Agent credentials and session homes are intentionally narrow. `~/.claude` and `~/.codex` may be rebuilt from Secrets in containers; durable agent memories are backed up to the `claude-memories` branch and folded into docs by `doc-maintainer`, not restored into a pod home.

## Kubernetes Deployment

Read [k8s-cutover.md](k8s-cutover.md) for the operator runbook. The app-side contract is:

- This repo publishes the container image and runtime entrypoint; fleet-infra owns Kubernetes manifests, Secrets, NetworkPolicy, ingress, and traffic cutover.
- `CLAWS_ACTIVATION_STATE=verify-only` lets staging boot beside openclaw without doing work during the cutover. `CLAWS_ACTIVATION_STATE=staging` runs only `issue-dispatcher`/`pr-dispatcher`/`auto-merger` plus worker handlers, and `isDispatchSkippable` restricts execution to live issues and PRs carrying `Claws Staging`; all background jobs stay off. `CLAWS_ACTIVATION_STATE=active` is normal production mode and skips `Claws Staging` items.
- `auth-secret-sync` is the credential rotation bridge for ephemeral provider homes in the pod.
- Interactive sessions must run with `CLAWS_SESSION_BACKEND=k8s-pod` before cutover (#3026). Claws creates one Pod, Service, Secret and PVC per session in `claws-sessions` using only its projected ServiceAccount token, and proxies the terminal to it, so a Claws rollout leaves sessions running. There is no shared session runtime. A pod's Secret holds only the credentials granted to that session. The `session-backend` connectivity check on `/config` FAILs `local-tmux` inside a container.
- Headless agent runs survive a rollout with `CLAWS_WORK_BACKEND=k8s-pod` (#clw_01M34R5RECDPPXVXBJZS1DA6C1): each claimed work-queue row runs in a `claws-agent-<rowId>` Pod with a Secret holding the service's forge and CLI credentials (never database ones) and a per-run token for `claws-state` and the agent-pod ops API, and the next boot re-attaches to pods a restart left running. The `work-backend` connectivity check FAILs `in-process` inside a container. See [k8s-cutover.md](k8s-cutover.md#pod-per-run-headless-agents-clw_01m34r5recdppxvxbjzs1da6c1).
- `release.yml` builds `ghcr.io/st-john-software/claws:<tag>` and dispatches fleet-infra's `update-claws.yml`, which opens an auto-merged `automation/bump-claws` PR against `clusters/my-cluster/claws/statefulset.yaml`; Flux reconciles and `claws-0` rolls, roughly 20–25 minutes from merge to ready, and `GET /health` reports the running release tag.
