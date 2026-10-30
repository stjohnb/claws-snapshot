# Claws

Claws is a self-hosted Forgejo automation service for the `St-John-Software` repos. It polls repositories, turns issue and PR state into work items, and runs Claude/Codex/OpenCode in isolated git worktrees to plan, implement, review, and maintain changes.

## Where to read first

- `docs/PRODUCT.md` — what Claws must do and why; index to the product area docs under `docs/product/`. Read this first.
- `docs/OVERVIEW.md` — the main architecture and workflow entry point.
- `docs/claws-automation.md` — how Claws manages issues, PRs, labels, and the contribution lifecycle for this repo.
- `docs/DESIGN.md` — dashboard design rules; read before touching user-facing HTML/CSS.

All changes land via pull request; never push directly to the default branch. See `docs/claws-automation.md` for the full convention.

## Where this repo lives

- This repository is hosted on Forgejo at `https://git.home.bstjohn.net/St-John-Software/claws`, which owns its issues, pull requests, releases and `main`. Every repo Claws manages is on Forgejo; GitHub is only the target of the public snapshot copies Claws pushes, and the old GitHub copies are archived.
- CI, release, the Claude Code release check and history cleanup run on Forgejo Actions from `.forgejo/workflows/`; `.github/actions/setup-nix` is the only thing left under `.github/`.
- Never use `gh` against this repo's own issues, PRs, checks, runs or releases. Use the Claws MCP tools (`claws_create_issue`, `claws_get_issue`, `claws_open_prs`, `claws_forgejo_job_logs`, …) or the Forgejo API at `$CLAWS_FORGEJO_BASE_URL/api/v1`.

## Automation host policy

Claws agents run in their own Kubernetes pod (6 GiB memory limit, no CPU limit, 24 GiB
ephemeral storage). When working on this repo as an agent:

- **Run the repo's local checks before pushing.** Install dependencies (`npm ci`), build,
  and run type-check, lint, unit tests, `task validate`, `nix develop -c …` with the repo's
  own flake devShell, and kustomize builds. CI stays the source of truth for end-to-end
  and browser tests, container image builds, and anything needing a live app or a cluster.
- **Do not start dev servers or other long-running processes** (`npm run dev`, `npm start`,
  `docker compose up`, watchers, tunnels).
- **Do not install system packages or browser binaries** at runtime: no `sudo`, no
  `apt-get install`, no `npx playwright install`, no `brew install`. A tool the checks need
  belongs in `flake.nix`; a tool the pod image lacks is an issue for St-John-Software/claws.
- **Never kill a process or free a port you do not own.** `lsof -ti:PORT | xargs kill` and
  `pkill -f node` kill the Claws helper processes that record your run.

## Observability

- Claws' observability policy — logs, metrics, traces, latency budgets, dashboards and alerts, and what each new route, DB query, background job or external call adds — is [`docs/observability.md`](docs/observability.md); read it first. Every managed repo declares one under [`docs/observability-contract.md`](docs/observability-contract.md).
- Service logging goes through `src/log.ts`, or `src/log-core.ts` for modules upstream of it (`config.ts`, `slack.ts`, `db.ts`, `db-driver-pg.ts`, `db-import.ts`). The session pod uses `src/session-pod/log.ts`.
- Off a TTY every line is one JSON object; see [`docs/observability-contract.md`](docs/observability-contract.md) for the fields.
- No direct `console.*` in `src/` outside tests, `src/tools/` and browser code.

## Key conventions

- TypeScript on Node.js, ESM only. Relative imports must use the `.js` suffix.
- Forge access for managed repos goes through the Forgejo-only façade `src/github.ts`. `src/github-external.ts` is the only GitHub client, for the public snapshot targets and upstream reads; do not call `api.github.com` directly.
- `git` subprocesses against managed repos take their auth from `buildEnvForForgejoGit` / `buildForgejoGitAuthEnv` in `src/github-app.ts`; only `github-external.ts` and public snapshot sync touch GitHub, using `buildEnvForGh` for `gh` and `buildEnvForGitHubGit` for `git`.
- Reuse shared helpers instead of re-implementing them: `retryWithBackoff`, `ensureAlertIssue`, `closeAlertIssueIfResolved`, `upsertAlertIssue`, `findIssueByExactTitle`, `trackTaskTokens`, `walkRepoTree`, `isGitHubHostedLabel`, `isCompleteJson`, `claude.repoDir`, `mapWithConcurrency`, `mapSettledWithConcurrency`, `writeAgentMcpConfig`.
- Recurring alert issues must update a single issue body rather than posting comment spam.
- New issues are filed in the Claws tracker, not on the forge: agents use the `claws_create_issue` MCP tool, humans use the dashboard's New issue page. Write a native issue's id as `#clw_…`. See `docs/issue-tracker.md`.
- Local checks are `npm ci`, `npm run build`, `npm test` and `npm run test:pg`; there is no lint script. `package.json` `allowScripts` is what lets `npm ci` build better-sqlite3 and node-pty under npm 11.20+.
- `AGENTS.md` is the only root instructions file — there is no `CLAUDE.md` — and role documents live in `.agents/<role>.md`.
- Interactive Claude Code use needs ≥ 2.1.277, the first version that auto-loads `AGENTS.md`.
- When something out of scope for this task slows you down or gets in the way — a slow or flaky command, a confusing or stale doc, a tool returning the wrong shape, a convention that fights the task — record it in one line with the `claws_note_friction` MCP tool, naming the file or command as its `reference`, and carry on. Do not file an issue for it: a note files nothing and triggers nothing, and a fortnightly fleet-wide retrospective issue rolls the notes up for the operator. Categories: `tooling`, `docs`, `tests`, `ci`, `conventions`, `prompt`, `infra`, `other`.
