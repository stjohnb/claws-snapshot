# Claws

Claws is a self-hosted GitHub automation service that polls repositories, identifies work items, and delegates tasks to the Claude CLI in isolated git worktrees. It runs as a Linux systemd service.

## Where to read first

- `docs/OVERVIEW.md` — architecture, module responsibilities, and wiring. Read this before making non-trivial changes; it is the source of truth.
- `docs/ARCHITECTURE.md` — Mermaid diagrams of the same architecture.

## Stack & build

TypeScript on Node.js, ESM modules. Relative imports must use the `.js` suffix (e.g. `import { foo } from "./bar.js"`). Dependencies via `npm`. Tests via `vitest` co-located as `*.test.ts`. Type-check via `npx tsc --noEmit`. Client bundles in `src/resources/*.generated.ts` built with esbuild.

## Conventions

- Prefer editing existing modules over creating new ones.
- Reuse shared helpers:
  - `retryWithBackoff` — `src/retry.ts`
  - `sleep` — `src/util.ts`
  - `ensureAlertIssue` — `src/occurrence-tracking.ts`
  - `findIssueByExactTitle` — `src/github.ts` (exact-title issue lookup; use instead of `searchIssues().find(r => r.title === title)` — GitHub search is substring-based and this helper narrows to an exact match)
  - `trackTaskTokens` — `src/db.ts` (canonical `onTokensUsed` callback factory for all agent call sites; accumulates across multiple `runClaude` calls)
  - `renderViolationTable` — `src/jobs/scanner-runner.ts` (shared Markdown table builder for scanner violation reports)
  - `formatGuardedTitleList` — `src/prompt-guard.ts` (build a guarded bullet list of GitHub-supplied issue/PR titles; used by prompt builders that embed open issue/PR titles)
- All GitHub API access goes through `src/github.ts`. Never use raw `fetch` to `api.github.com`.
- All `gh`/`git` subprocesses must inherit the env from `buildEnvForGh`/`buildEnvForGhGit` in `src/github-app.ts` for installation-token auth.
- When adding a new job, register it in `main.ts` and consider adding it to `triggers` chains.

## GitHub Actions runners (CRITICAL)

Never add `ubuntu-latest`, `ubuntu-22.04`, `windows-latest`, or `windows-2022`. Linux/Windows jobs MUST be `runs-on: [self-hosted, linux]` (matching existing labels). A bare `runs-on: self-hosted` is not acceptable — always include the OS label. macOS jobs may use GitHub-hosted `macos-latest`/`macos-14`.

## Alert issues

Recurring alerts must use `ensureAlertIssue()` from `src/occurrence-tracking.ts` so they update an existing issue's body instead of posting new comments. The `issue-comment-spam-scanner` flags repos that don't do this.

## Testing

`npm test` runs vitest. New modules should ship with co-located tests. Mock external dependencies (`node:fs`, `gh`, `claude` CLI) via `vi.mock` with `vi.hoisted` mock objects — see `src/jobs/claude-config-scanner.test.ts` for the canonical pattern.

## Common gotchas

- Provider-aware model selection uses `runClaudeOptions.capability` (`"tool-use"` vs `"text-only"`). Every `runClaude` call must declare it.
- MCP `INTERNAL_MCP_TOKEN` is per-process random and never persisted. Do not try to surface it in config UI.
- When adding a new job, register it in `main.ts` and consider adding it to `triggers` chains.
