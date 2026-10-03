# Claws

Claws is a self-hosted GitHub automation service for the `St-John-Software` repos. It polls repositories, turns issue and PR state into work items, and runs Claude/Codex/OpenCode in isolated git worktrees to plan, implement, review, and maintain changes.

## Where to read first

- `docs/PRODUCT.md` — what Claws must do and why; index to the product area docs under `docs/product/`. Read this first.
- `docs/OVERVIEW.md` — the main architecture and workflow entry point.
- `docs/claws-automation.md` — how Claws manages issues, PRs, labels, and the contribution lifecycle for this repo.
- `docs/DESIGN.md` — dashboard design rules; read before touching user-facing HTML/CSS.

All changes land via pull request; never push directly to the default branch. See `docs/claws-automation.md` for the full convention.

## Automation host policy

Claws agents work on a shared, resource-constrained automation host that also runs the
Claws service itself. When working on this repo as an agent:

- **Do not start dev servers or other long-running processes** (`npm run dev`, `npm start`,
  `docker compose up`, watchers, tunnels). Verify with fast one-shot checks — type-check,
  lint, unit tests — and let CI run anything that needs a live app or an end-to-end browser.
- **Do not install system packages or browser binaries** on the host: no `sudo`, no
  `apt-get install`, no `npx playwright install`, no `brew install`. If CI needs a tool,
  add it to `flake.nix` in the same PR.
- **Never kill a process or free a port you do not own.** `lsof -ti:PORT | xargs kill` and
  `pkill -f node` will take down the Claws service, whose dashboard listens on port 3000.

## Logging

- Service logging goes through `src/log.ts`, or `src/log-core.ts` for modules upstream of it (`config.ts`, `slack.ts`, `db.ts`, `db-driver-pg.ts`, `db-import.ts`). The session pod uses `src/session-pod/log.ts`.
- Off a TTY every line is one JSON object; see [`docs/logging-conventions.md`](docs/logging-conventions.md) for the fields.
- No direct `console.*` in `src/` outside tests, `src/tools/` and browser code.

## Key conventions

- TypeScript on Node.js, ESM only. Relative imports must use the `.js` suffix.
- All GitHub API access goes through `src/github.ts`; do not call `api.github.com` directly.
- All `gh` and `git` subprocesses must inherit auth from `buildEnvForGh` / `buildEnvForGhGit` in `src/github-app.ts`.
- Reuse shared helpers instead of re-implementing them: `retryWithBackoff`, `ensureAlertIssue`, `closeAlertIssueIfResolved`, `upsertAlertIssue`, `findIssueByExactTitle`, `trackTaskTokens`, `walkRepoTree`, `isGitHubHostedLabel`, `isCompleteJson`, `claude.repoDir`, `mapWithConcurrency`, `mapSettledWithConcurrency`, `writeAgentMcpConfig`.
- Recurring alert issues must update a single issue body rather than posting comment spam.
- New issues are filed in the Claws tracker, not on the forge: agents use the `claws_create_issue` MCP tool, humans use the dashboard's New issue page. Write a native issue's id as `#clw_…`. See `docs/issue-tracker.md`.
- `AGENTS.md` is the only root instructions file — there is no `CLAUDE.md` — and role documents live in `.agents/<role>.md`.
- Interactive Claude Code use needs ≥ 2.1.277, the first version that auto-loads `AGENTS.md`.
