# Claws

Claws is a self-hosted GitHub automation service that polls repositories, identifies work items, and delegates tasks to the Claude CLI in isolated git worktrees. It runs as a Linux systemd service.

## Where to read first

- `docs/OVERVIEW.md` — architecture, module responsibilities, and wiring. Read this before making non-trivial changes; it is the source of truth.
- `docs/ARCHITECTURE.md` — Mermaid diagrams of the same architecture.
- `docs/postmortem-process.md` — how to run a blameless postmortem after an incident. Run the `/postmortem` skill rather than writing one freehand.

## Stack & build

TypeScript on Node.js, ESM modules. Relative imports must use the `.js` suffix (e.g. `import { foo } from "./bar.js"`). Dependencies via `npm`. Type-check via `npx tsc --noEmit`. Client bundles in `src/resources/*.generated.ts` built with esbuild.

## Conventions

- Prefer editing existing modules over creating new ones.
- Reuse shared helpers:
  - `retryWithBackoff` — `src/retry.ts`
  - `sleep` — `src/util.ts`
  - `ensureAlertIssue` — `src/occurrence-tracking.ts`
  - `closeAlertIssueIfResolved` — `src/occurrence-tracking.ts` (close-when-resolved counterpart to `ensureAlertIssue`; use instead of hand-rolling `findIssueByExactTitle` → `closeIssue`)
  - `findIssueByExactTitle` — `src/github.ts` (exact-title lookup over the cached open-issue list)
  - `trackTaskTokens` — `src/db.ts` (canonical `onTokensUsed` callback factory for all agent call sites; accumulates across multiple `runClaude` calls)
  - `renderViolationTable` — `src/jobs/scanner-runner.ts` (shared Markdown table builder for scanner violation reports)
  - `formatGuardedTitleList` — `src/prompt-guard.ts` (build a guarded bullet list of GitHub-supplied issue/PR titles; used by prompt builders that embed open issue/PR titles)
  - `isCompleteJson` — `src/json-extract.ts` (structural, brace-balanced completeness check for LLM JSON output; use instead of a trailing-code-fence heuristic to tell a genuine parse failure from a max-tokens truncation — see `improvement-identifier.ts`, `public-repo-scanner.ts`)
  - `claude.repoDir(repo)` — `src/claude.ts` (canonical `path.join(WORK_DIR, "repos", repo.owner, repo.name)`; don't re-inline this path computation in a job file)
  - `mapWithConcurrency` / `mapSettledWithConcurrency` — `src/util.ts` (bounded-concurrency batch loops; use the plain variant for fail-fast `Promise.all` semantics, the `Settled` variant when per-item error isolation is needed instead of hand-rolling a `for` loop of `Promise.allSettled` batches)
- All GitHub API access goes through `src/github.ts`. Never use raw `fetch` to `api.github.com`.
- All `gh`/`git` subprocesses must inherit the env from `buildEnvForGh`/`buildEnvForGhGit` in `src/github-app.ts` for installation-token auth.
- When adding a new job, register it in `main.ts` and consider adding it to `triggers` chains.

## Frontend design

`docs/DESIGN.md` records Claws' own typeface, colour tokens, background, and motion choices for the dashboard. Read it before touching any user-facing HTML/CSS.

## GitHub Actions runners (CRITICAL)

Never add `ubuntu-latest`, `ubuntu-22.04`, `windows-latest`, `windows-2022`, `macos-latest`, or `macos-14`. Linux/Windows jobs MUST be `runs-on: [self-hosted, linux]` (matching existing labels). A bare `runs-on: self-hosted` is not acceptable — always include the OS label. macOS jobs MUST be `runs-on: [self-hosted, macos]`.

CI dependencies are repo-owned. The self-hosted runners are NixOS machines that provide only a baseline (nix, git, docker); every tool a workflow needs comes from this repo's `flake.nix` devShells, entered via `nix develop` (see `.github/workflows/ci.yml` and the `Set up Nix` action at `.github/actions/setup-nix`). This is what lets repos with conflicting toolchains share the same runners — each repo's dependencies live isolated in the nix store. Never add `actions/setup-node`, `sudo`/`apt-get`, or a request for a package on the runner itself: add the tool to the right devShell instead (`default` for the node/native-build toolchain, `scripts` for gh/maintenance tooling).

## Alert issues

Recurring alerts must use `ensureAlertIssue()` from `src/occurrence-tracking.ts` so they update an existing issue's body instead of posting new comments. The `issue-comment-spam-scanner` flags repos that don't do this.

## Testing

`npm test` runs vitest. New modules should ship with co-located tests. Mock external dependencies (`node:fs`, `gh`, `claude` CLI) via `vi.mock` with `vi.hoisted` mock objects — see `src/jobs/claude-config-scanner.test.ts` for the canonical pattern.

## Common gotchas

- Provider-aware model selection uses `runClaudeOptions.capability` (`"tool-use"` vs `"text-only"`). Every `runClaude` call must declare it.
- MCP `INTERNAL_MCP_TOKEN` is per-process random and never persisted. Do not try to surface it in config UI.
- Self-authored Claws comments (marked via `CLAWS_COMMENT_MARKER`) are never re-guarded when read back by `formatIssueCommentsForPrompt()` — so any GitHub-supplied string (PR title, branch name, etc.) embedded into a comment Claws posts itself must be passed through `guardContent()` *before* posting, or it becomes a permanently-trusted prompt-injection vector once read back into a planning/implementing agent.
- Use `log.error` (`src/log.ts`), never bare `console.error`, for failure paths — `log.error` writes a timestamped `[ERROR]` line, escalates to Slack via `notify()`, and records the message via `captureLog`; a stray `console.error` silently drops all three.
- Review-comment reactions live at `pulls/comments/{id}/reactions` and issue-comment reactions at `issues/comments/{id}/reactions`; the IDs are different namespaces, so use `getReviewCommentReactions` for inline review comments and `getCommentReactions` for issue comments — mixing them 404s silently under a `catch` and makes addressed comments look unaddressed forever.
- Never reach for `gh search issues` / `gh search prs` to find an issue or PR by title — GitHub parses the positional query as *advanced search syntax*, so a title containing a bare `key:value` token (inline-code identifiers, `16:9`, timestamps) is rejected as invalid, and the search index lags creation by minutes. Use `findIssueByExactTitle` / `findOpenPRsByTitle` in `src/github.ts`, which read the cached, strongly-consistent `listOpenIssues` / `listPRs` results.
