# Claws Overview

## Doc Map

| Doc | Read this when | Depth |
|---|---|---|
| [OVERVIEW.md](OVERVIEW.md) | You're starting work on this repo and need to route to the right context. | **Entry point** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | You want the system map as Mermaid diagrams instead of prose. | **Entry point** |
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
| [jobs/README.md](jobs/README.md) | You're changing a job and need the shared lifecycle plus the per-job doc index. | **Reference** |
| [jobs/auth-secret-sync.md](jobs/auth-secret-sync.md) | You're changing provider credential sync into the `claws-auth` Secret. | **Deep dive** |
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
| [jobs/issue-auditor.md](jobs/issue-auditor.md) | You're changing Ready/In Review reconciliation for issues. | **Deep dive** |
| [jobs/issue-dispatcher.md](jobs/issue-dispatcher.md) | You're changing issue planning, refinement, duplicate handling, or implementation dispatch. | **Deep dive** |
| [jobs/k3s-monitor.md](jobs/k3s-monitor.md) | You're changing Kubernetes pod/node/Flux monitoring. | **Deep dive** |
| [jobs/main-build-monitor.md](jobs/main-build-monitor.md) | You're changing default-branch build monitoring and build-failure issues. | **Deep dive** |
| [jobs/migration-scanner.md](jobs/migration-scanner.md) | You're changing migration filename convention checks. | **Deep dive** |
| [jobs/pr-dispatcher.md](jobs/pr-dispatcher.md) | You're changing PR review, CI fixing, conflict handling, or automerge dispatch. | **Deep dive** |
| [jobs/public-snapshot-sync.md](jobs/public-snapshot-sync.md) | You're changing private-to-public mirror publishing or scrubbing. | **Deep dive** |
| [jobs/reminder-monitor.md](jobs/reminder-monitor.md) | You're changing scheduled reminder issue creation. | **Deep dive** |
| [jobs/repo-standards.md](jobs/repo-standards.md) | You're changing label sync, legacy label cleanup, or repo standards. | **Deep dive** |
| [jobs/runner-metrics-sync.md](jobs/runner-metrics-sync.md) | You're changing runner metrics ingestion for dashboards. | **Deep dive** |
| [jobs/runner-monitor.md](jobs/runner-monitor.md) | You're changing self-hosted runner health or disk cleanup. | **Deep dive** |
| [jobs/runner-os-scanner.md](jobs/runner-os-scanner.md) | You're changing self-hosted runner OS-label checks. | **Deep dive** |
| [jobs/shopping-comment-processor.md](jobs/shopping-comment-processor.md) | You're changing shopping-list comment-to-manifest updates. | **Deep dive** |
| [jobs/shopping-sourcer.md](jobs/shopping-sourcer.md) | You're changing marketplace sourcing for `docs/shopping/*.yaml`. | **Deep dive** |
| [jobs/site-promoter.md](jobs/site-promoter.md) | You're changing promotional-channel execution for `docs/promotion/*.yaml`. | **Deep dive** |
| [jobs/staging-db-sync.md](jobs/staging-db-sync.md) | You're changing the openclaw SQLite to staging Postgres sync. | **Deep dive** |
| [jobs/stale-branch-cleaner.md](jobs/stale-branch-cleaner.md) | You're changing stale `claws/*` branch cleanup. | **Deep dive** |
| [jobs/triage-claws-errors.md](jobs/triage-claws-errors.md) | You're changing automated investigation of `[claws-error]` issues. | **Deep dive** |
| [jobs/ubuntu-latest-scanner.md](jobs/ubuntu-latest-scanner.md) | You're changing checks for billed GitHub-hosted runners. | **Deep dive** |
| [jobs/upstream-watcher.md](jobs/upstream-watcher.md) | You're changing blocked-issue watches for upstream PRs, issues, or releases. | **Deep dive** |
| [jobs/whatsapp-handler.md](jobs/whatsapp-handler.md) | You're changing WhatsApp message-to-issue handling. | **Deep dive** |
| [k8s-cutover.md](k8s-cutover.md) | You're cutting over from openclaw/systemd to the Kubernetes deployment. | **Deep dive** |
| [label-audit.md](label-audit.md) | You need real label usage before adding, renaming, or deleting a label. | **Deep dive** |
| [modules.md](modules.md) | You know the source file you're changing and need exports, gotchas, and rationale. | **Reference** |
| [patterns.md](patterns.md) | You need the edge cases behind a named pattern from this overview. | **Reference** |
| [postmortem-process.md](postmortem-process.md) | You're writing an incident postmortem for any managed repo. | **Deep dive** |
| [postmortems/2026-07-18-node-runtime-mismatch-failed-rollback.md](postmortems/2026-07-18-node-runtime-mismatch-failed-rollback.md) | You're investigating the Node runtime mismatch deploy incident. | **Deep dive** |
| [refinements/71.doc.md](refinements/71.doc.md) | You need the original design notes for automated documentation maintenance. | **Deep dive** |
| [repo-config.md](repo-config.md) | You're onboarding a repo or adding a per-repo `claws.json` setting. | **Reference** |
| [requirements.md](requirements.md) | You need cross-cutting owner constraints that no single subsystem owns. | **Reference** |
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

- `src/main.ts` boots the process: PID lock, config, database init, work-queue recovery, tmux session recovery, job registration, scheduler, and Hono server.
- `src/config.ts`, `src/repo-config.ts`, and `claws.json` decide which repos and jobs exist. A root `claws.json` on the repo default branch is the mandatory opt-in gate on GitHub and Forgejo.
- `src/github.ts`, `src/github-app.ts`, and `src/forgejo.ts` are the only GitHub/Forgejo API and git-auth layers. Callers should not shell out to `api.github.com` directly.
- `src/db.ts` owns SQL through `src/db-driver.ts` and `src/db-driver-pg.ts`. SQLite is the default host backend; `CLAWS_DATABASE_URL` selects PostgreSQL for Kubernetes/staging.
- `src/jobs/*` are scheduled or event-driven scanners and monitors. `src/agents/*` are the task-specific planner, implementer, reviewer, CI fixer, review addresser, and merger flows they enqueue.
- `src/worker.ts` owns the persistent work queue. Dispatchers should identify work quickly and enqueue rows, not hold scheduler slots while agent processes run.
- `src/claude.ts`, `src/capabilities.ts`, `src/sessions.ts`, and `src/session-env-file.ts` own agent execution, worktree/session isolation, provider selection, and capability-gated environment injection.
- `src/server.ts`, `src/pages/*`, `src/client/*`, and generated `src/resources/*` make the dashboard. Read [DESIGN.md](DESIGN.md) before changing user-facing UI.
- `deploy/*` holds the systemd, updater, container entrypoint, image/runtime, and bundled skill install paths. The Kubernetes manifests live in `fleet-infra`; this repo publishes the image and runtime code.

## Jobs

Forty-three scheduled/manual jobs are registered in `src/main.ts`, and WhatsApp messages are handled event-by-event through `jobs/whatsapp-handler.ts`. Use [jobs/README.md](jobs/README.md) for the shared lifecycle and per-job links; each complex job doc records its trigger, owned state, owner constraints, and failure behaviour.

Important routing:

- Issue work starts in [`jobs/issue-dispatcher.md`](jobs/issue-dispatcher.md), then flows through planner/refiner and implementer agents.
- PR work starts in [`jobs/pr-dispatcher.md`](jobs/pr-dispatcher.md), then flows through CI fixer, review addresser, reviewer, and auto-merger agents.
- Infrastructure monitors and scanners should file deduplicated/update-in-place alert issues, not comment spam.
- Smart-scheduled jobs use `smart-schedule.ts` to select stale repos under a concurrency cap, with an SLO escape valve for badly stale repos.

## Key Patterns

Open [patterns.md](patterns.md) for details and edge cases; this section is only a routing summary.

- **Content-based state machine:** issues and PRs are driven by visible comments, reactions, labels, and PR state. Use visible plain-text markers, never hidden HTML comments.
- **Worktree isolation:** write tasks use isolated worktrees under `~/.claws/worktrees/...`; interactive sessions use tmux and may also use worktrees.
- **Persistent work queue:** dispatchers enqueue serialized work in `work_queue`; workers claim rows idempotently so a long agent run cannot block the next dispatcher tick.
- **Provider-aware model selection:** Claude, Codex, and OpenCode are selected through `model-selector.ts`; eligible unpinned tasks draw from enabled `aiProviders` by positive weights (default Claude:Codex:OpenCode = 4:2:1), while `Use Claude`, `Use Codex`, `Use OpenCode`, and `Plan: Deep` labels override defaults for a single item. Provider/model effectiveness is monitored through task outcomes plus exact-head review and merge signals; this observes quality but does not auto-tune weights.
- **Capability gating:** sessions are default-deny for secrets. Capabilities strip sensitive environment keys first, then re-grant selected values from a 0600 file so credentials do not appear in argv.
- **Forgejo separation:** Forgejo-canonical repos are read and written on Forgejo. The implicit `forgejo` capability is push/API access only; the opt-in `forgejo-admin` capability is only for Actions secrets and variables.
- **Postgres compatibility:** new SQL must either fit the SQLite-to-Postgres translation rules in [database-schema.md](database-schema.md) or extend those rules and tests.
- **No noisy automation:** recurring alerts update one issue body, "nothing to do" findings should not create issues, and warnings that require human action should be visible in GitHub or the UI, not only logs.

## Configuration

Use [configuration.md](configuration.md) for the full table. The high-risk values are:

| Area | Keys |
|---|---|
| Activation | `CLAWS_ACTIVATION_STATE=active|verify-only`; verify-only starts the dashboard and `/verify` but registers no side-effecting jobs. |
| Database | unset `CLAWS_DATABASE_URL` means SQLite at `DB_PATH`; set `CLAWS_DATABASE_URL` plus optional `CLAWS_DATABASE_PASSWORD` for PostgreSQL. Passwords must not be printed or embedded in UI labels. |
| GitHub | `githubOwners`, `githubAppId`, `githubAppPrivateKeyPath`, `githubOwnerAppCredentials`, and installation IDs. All `gh`/`git` subprocesses inherit auth through `github-app.ts`. |
| Forgejo | `forgejoBaseUrl`, `forgejoToken`, `CLAWS_FORGEJO_REPOS` emergency additive override, and optional `forgejoAdminToken`/`CLAWS_FORGEJO_ADMIN_TOKEN` for the explicit `forgejo-admin` session capability. |
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

`~/.claws` is the durable work directory: `config.json`, `env`, `repos/`, `worktrees/`, tmux/session state, uploads, prompt captures, WhatsApp auth, and SQLite on the host backend. Kubernetes uses a PVC for this state but stores the database in shared Postgres once `CLAWS_DATABASE_URL` is set.

Agent credentials and session homes are intentionally narrow. `~/.claude` and `~/.codex` may be rebuilt from Secrets in containers; durable agent memories are backed up to the `claude-memories` branch and folded into docs by `doc-maintainer`, not restored into a pod home.

## Kubernetes Deployment

Read [k8s-cutover.md](k8s-cutover.md) for the operator runbook. The app-side contract is:

- This repo publishes the container image and runtime entrypoint; fleet-infra owns Kubernetes manifests, Secrets, NetworkPolicy, ingress, and traffic cutover.
- `CLAWS_ACTIVATION_STATE=verify-only` lets staging boot beside openclaw without doing work. Operators activate it only after `/verify` is green and the final data sync is complete.
- The final SQLite-to-Postgres sync must happen after openclaw is stopped; doing it before stop loses writes made between snapshot and shutdown.
- `auth-secret-sync` is the credential rotation bridge for ephemeral provider homes in the pod.
