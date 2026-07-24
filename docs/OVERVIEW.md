# Claws — Overview

Claws is a self-hosted
GitHub automation service. It polls GitHub repositories on configurable timers,
identifies work items via comment analysis, reactions, and PR state, and
delegates tasks to the Claude CLI in isolated git worktrees. It runs as a
Linux systemd service.

## Architecture

> **See also:** [ARCHITECTURE.md](ARCHITECTURE.md) for visual Mermaid diagrams of the same architecture (system overview, module layering, dispatcher fan-out, issue/PR lifecycles, Claude invocation path). [claws-automation.md](claws-automation.md) describes how Claws automates this repository's issue/PR lifecycle (maintained automatically — do not edit). [postmortem-process.md](postmortem-process.md) describes how to run a blameless postmortem after an incident in any managed repo. [intent-log.md](intent-log.md) is a chronological record of the repo owner's stated requirements and rationale, extracted from human-authored issue/PR content (#2090).

```
src/
├── main.ts              Entry point — DB init, crash recovery, job registration, shutdown
├── config.ts            Configuration loading (env > config file > defaults)
├── scheduler.ts         Interval/schedule-based job runner with skip-if-busy
├── smart-schedule.ts    Smart-scheduling gate + staleness-based per-repo selection (isClawsBusy check with SLO escape valve, selects repos with age ≥ targetStalenessMs, forces SLO-breached repos through even when busy); also exports `runDailyRepoLoop(jobName, repos, processRepo)`, a shared daily-repo-processing loop (rate-limit check that breaks the loop, per-repo error reporting fingerprinted `${jobName}:process-repo`, then `db.markRepoProcessedDaily` unconditionally) extracted from `idea-reconciler` and `stale-branch-cleaner` (#1978) — both jobs' `run()` now just delegate to it. Also exports `withDailyRepoMarking(jobName, repoFullName, fn, onError?)` (#1992), a concurrent-variant wrapper for smart-scheduled jobs that fan out a single repo's processing with `Promise.all`/`allSettled` rather than looping sequentially — runs `fn`, and on throw either returns `onError(err)` (if supplied) or rethrows, always calling `db.markRepoProcessedDaily` in a `finally` so staleness selection can never miss a repo whose handler forgot to mark it; used by `doc-maintainer`, `idea-suggester`, `improvement-identifier`, `public-repo-scanner`, `dependabot-alert-monitor`, and `issue-auditor`'s `processRepo` functions
├── github.ts            gh CLI wrapper with transient-error retry; exports `TransientGitHubError` (#2036/#2039) — thrown by `gh()` when a call exhausts its retries and the final failure matches `GH_SERVER_ERROR_RE` (a literal `HTTP 500/502/503/504` in the `gh` error text, distinct from the broader `TRANSIENT_RE` used to decide whether to retry at all) — signals a GitHub-side 5xx that outlived the retry window rather than a genuine Claws-side defect; `error-reporter.ts` downgrades it to a warning instead of filing a `[claws-error]` issue
├── github-app.ts        GitHub App authentication — JWT signing, installation token minting, env injection for gh/git subprocesses
├── claude.ts            CLI runner (Claude/Codex/OpenCode backends), provider circuit breaker + fallback, bounded concurrent queue, git worktree helpers. Exports `repoDir(repo: Repo)` (#2020) — the single canonical `path.join(WORK_DIR, "repos", repo.owner, repo.name)` computation, called as `claude.repoDir(repo)` by 9 job files that previously each inlined the same `path.join`. `generatePRDescription()` prompts the model to emit a leading `TITLE: <subject>` marker line (#2028) derived from the diff rather than the issue title — see `issue-worker.ts`'s `extractTitleMarker`. Exports `ensureScratchDir(namespace)` (#2068) — an isolated `~/.claws/scratch/<namespace>` cwd (created on demand, never cleaned up separately since the path is fixed/reused) for text-only agents that aren't tied to a repo worktree; **must** be used instead of `process.cwd()` for such calls, since under systemd `process.cwd()` is the service's `WorkingDirectory` (`/opt/claws`) — the live install holding `.env`, the GitHub App private key, plaintext `config.json`, and `claws.db` — and `runClaudeCliOnce` always passes `--dangerously-skip-permissions` with no tool restriction by default. Exports `TEXT_ONLY_DISALLOWED_TOOLS` (#2068) — `["Bash","Edit","Write","NotebookEdit","Read","Glob","Grep","WebFetch","WebSearch","Task"]`, the deny-list passed via the `disallowedTools` `RunClaudeOptions` field (Claude-CLI-only, forwarded as `--disallowedTools`; ignored by the Codex/OpenCode backends) to strip filesystem/shell/network access from pure text-extraction calls over untrusted content — used by `email-monitor.ts` and `whatsapp-handler.ts`
├── db.ts                SQLite task tracking (better-sqlite3)
├── server.ts            HTTP server — dashboard, health, status, manual triggers
├── capabilities.ts      Session capability registry — defines three gated capability bundles (home-assistant, prod-infra, fleet-infra) plus eight hardcoded `ssh:<alias>` capabilities (#1985; e.g. `ssh:truenas`, `ssh:homeassistant`, `ssh:k3s`, `ssh:hetzner-actions-runner`, `ssh:hetzner-beefy-actions`, `ssh:ryzen`, `ssh:k3s-nas`, `ssh:proxmox`) — the SSH capabilities inject no env vars (auth is via on-disk keys already present on the Claws host) so `envKeys: []` and `resolve()` always returns `{}` (always-available, never null), and exist purely to drive the session-create checkbox UI and tell the model via `buildCapabilityPrompt` which hosts it may SSH to; exports `buildCapabilityEnvArgs` (strips ungranted env keys via `env -u`, injects granted ones as argv elements — since #1944/#1947 this also always strips the full `SENSITIVE_ENV_KEYS` set, imported from the zero-dependency `sensitive-env.ts` leaf module to avoid pulling `claude.ts`'s heavy import tree into `capabilities.test.ts`, so a zero-capability interactive session no longer inherits Slack/OIDC/OpenRouter/OpenAI/Gmail secrets from `process.env`) and `buildCapabilityPrompt` (generates `--append-system-prompt` text listing only granted capabilities — returns "" when nothing granted so callers omit the flag entirely); `CAPABILITIES` registry reads live config bindings at call time to reflect reloads
├── sessions.ts          Interactive PTY session manager — node-pty processes, scrollback buffer, WebSocket bridge; multi-repo sessions via `createMultiWorktreeSession`; session resume via `resumeSession`
├── log.ts               Timestamped logging + Slack error escalation
├── slack.ts             Slack incoming-webhook + Bot API (ideas, notifications)
├── model-selector.ts    Provider-aware model selection (Claude/Codex/OpenCode, cheap/sonnet/opus tiers, config override)
├── classify-complexity.ts  Lightweight Claude call to classify whether a task warrants opus-level reasoning. Accepts `defaultOnFailure` option (defaults to `"sonnet"`; ci-fixer, triage jobs, and improvement-identifier are the current callers — the issue-refiner planner does NOT use this and is hardcoded to opus. Pinned to provider="claude" because the OpenRouter direct backend has a 32 K context limit that overflows on large prompts.)
├── ollama-rate-limit-classifier.ts  Ollama-based rate-limit error classification with regex fallback and circuit breaker
├── error-reporter.ts    Deduplicating GitHub issue-based error reporter (filters ShutdownError, RateLimitError, transient API 5xx, and `TransientGitHubError` (#2036/#2039) — a persistent `gh` 5xx that survived `gh()`'s own retries is self-healing via the next dispatcher cycle, so it is logged as a warning instead of opening a `[claws-error]` issue)
├── images.ts            Image/attachment extraction + download for issue/PR context
├── whatsapp.ts          WhatsApp Web client (Baileys) — QR pairing, message routing, Slack pairing alerts; `downloadAudio` enforces the 25 MB cap while streaming (not after buffering) so oversized/malformed media cannot drive memory up before the check
├── transcribe.ts        Voice-note transcription — tries same-VM Whisper (`whisperLocalUrl`) first, then remote Whisper (`whisperBaseUrl`), each with a per-URL circuit-breaker (disabled for 5 min after 3 consecutive failures), falls back to OpenAI Whisper API; `isAvailable()` returns true if any backend is configured; self-hosted requests send `WHISPER_MODEL` (default `Systran/faster-whisper-base`) as the model field, never the OpenAI-only `"whisper-1"` alias (#1931)
├── format.ts            Duration formatting (formatMs: milliseconds → human-readable)
├── version.ts           Build-time injected version string
├── plan-parser.ts       Parses multi-PR implementation plans into phases
├── timeout-handler.ts   Per-item Claude timeout escalation and auto-skip
├── outcome.ts           Task outcome builders (success/failure metadata, failure categorization)
├── occurrence-tracking.ts  Shared occurrence-tracking helpers for recurring alert issues — `appendOccurrenceTracking`, `updateOccurrenceTracking`, `applyOccurrenceTracking`, plus the higher-level `ensureAlertIssue({ repo, title, body, labels?, timestamp?, logPrefix })` that does the search → update-or-create + warn-on-regex-miss flow; used by error-reporter, main.ts (unknown-config-key reporting), k3s-monitor, and runner-monitor to edit issue bodies on recurrence instead of posting new comments
├── prompt-guard.ts      Prompt injection detection and content redaction
├── mcp-server.ts        MCP server — exposes Claws state to Claude sessions
├── namey-query.ts       Handler logic for namey_query MCP tool (read-only SQL against namey PostgreSQL)
├── ha-mcp.ts            Standalone HA MCP handler — `ha_list_entities` (projects /api/states to entity_id/state/friendly_name, filterable by domain/search, capped at 500) and `ha_api_request` (generic passthrough to any `/api/…` endpoint, GET/POST); imported by mcp-server.ts; path validation resolves `opts.path` via `new URL(opts.path, baseUrl)` first, then checks the resolved URL's `origin` (must match HA host — rejects absolute URLs, protocol-relative paths, and `@`/backslash host-swap variants) and `pathname` (must start with `/api/` — prevents percent-encoded traversal like `/api/%2e%2e/config` since the pathname is post-normalization); `fetch` is called with the resolved `URL` object, never via string concatenation; never includes token in error messages; no config.ts imports
├── sql-validation.ts    SQL validation helpers — multi-statement rejection, LIMIT enforcement
├── worker.ts            SQLite-backed work queue — `N` worker fibers (default 2, `MAX_WORK_WORKERS`) claim rows from `work_queue`, execute registered handlers, handle `ShutdownError`/`RateLimitError`/timeout escalation, and recover stuck `running` rows on startup via `recoverWorkOnStartup()`; exports `AGENT_KINDS` constants, `enqueue()`, `registerHandler()`, `workerStatus()`, and `start()`
├── work-handlers.ts     Registers all per-kind work handlers with `worker.ts` via `registerAll()` — one handler per `AGENT_KINDS` constant; each handler re-fetches the live issue/PR state before invoking the agent, ensuring stale queue entries are handled gracefully; also wires the auto-merger sweep chain (every agent handler that mutates a PR enqueues an `AUTO_MERGER_SWEEP` in its `finally` block)
├── retry.ts             `retryWithBackoff(fn, maxRetries, isTransient, label)` — generic exponential-backoff retry helper (1s/2s/4s delays) extracted from `gh()` and `git()`; callers supply their own `isTransient` predicate
├── rate-limit.ts        GitHub API rate-limit circuit breaker (#2108) — extracted from `github.ts` into a leaf module (no imports from `github.ts`/`github-app.ts`) so both can depend on it without a circular import. Exports the `RateLimitError` class, `isRateLimited()`/`setRateLimited(cooldownMs?)`/`clearRateLimitState()`, and `checkAndResumeAfterCooldown()` (called by `gh()` before each attempt to notify once when a cooldown expires). `github.ts` re-exports `RateLimitError`/`isRateLimited`/`clearRateLimitState` for backward compatibility with existing importers (`error-reporter.ts`, tests); `setRateLimited` is also called directly by `github-app.ts` when `listInstallationRepositories()` hits a 403 rate-limit response, so that path trips the same shared breaker instead of escalating straight to a `[claws-error]` issue
├── claude-auth.ts       Server-side orchestration of the `claude setup-token` OAuth flow (#2082) via a `node-pty` child — lets the subscription credential be refreshed from the web UI instead of a cramped browser terminal. Spawns the PTY with a wide `cols` so the OAuth URL is emitted unwrapped (easy to copy); `startClaudeLogin()` begins the flow and captures the URL via `URL_REGEX`, `submitClaudeLoginCode(code)` writes the pasted code to the PTY, `getClaudeLoginStatus()` reports `awaiting-url`/`awaiting-code`/`completed`/`failed` with any token redacted (`redactToken`, matches `sk-ant-oat01-…`) before it reaches the browser. On success the `sk-ant-oat01-…` token is persisted as `CLAUDE_CODE_OAUTH_TOKEN`, which outranks the expired `/login` subscription credential in the CLI's precedence, so subsequent `runClaude`/session spawns pick it up immediately without a restart
├── json-extract.ts      `extractJsonCandidates(output)` — multi-strategy JSON extraction for LLM outputs; tries greedy fence match, non-greedy fence match, and brace-balanced extraction. `parseFirstValidJson(output, schema, logPrefix, onFailure?)` — generic helper that iterates candidates from `extractJsonCandidates`, validates each against a Zod schema via `safeParse`, and returns the first valid result or `null`; logs on failure; used by `improvement-identifier` (`parseReviewOutput`), `public-repo-scanner` (`parseFindings`), `idea-suggester`, `whatsapp-handler`, `ci-fixer` (`classifyCIFailure`), and other jobs that parse structured JSON from Claude. `repairJsonEscapes(input)` — exported helper that repairs invalid JSON string escapes (e.g. `\(`, `\.`, `\s` from Markdown-escaped chars or regex snippets embedded in LLM string values) by dropping the backslash from any `\X` where `X` is not a legal JSON escape char; used internally by `parseFirstValidJson` as a single-retry fallback when a candidate fails `JSON.parse` — the repaired form is tried once before discarding the candidate. `isCompleteJson(output)` — string-escape-aware brace-balance walk (mirrors the `extractJsonCandidates` strategy 3 logic) that returns `true` only when `output` contains a top-level JSON object whose outer braces close cleanly; used by `improvement-identifier` and `public-repo-scanner` to distinguish a genuinely-malformed Claude response (file a `[claws-error]` issue) from a transient max-tokens truncation (warn and retry next tick) — replaces a prior "ends with a closing \`\`\` fence" heuristic that produced false negatives when truncation happened to land right after an *inner* fence embedded in the LLM's own output (#1810)
├── util.ts              `sleep(ms)` — shared async sleep helper; `resolveIdentityFile(path)` — expands a leading `~/` in a path to the user's home directory (via `os.homedir()`; bare `~` without a slash is passed through unmodified for `ssh` to interpret). Imported by `worker.ts`, `github.ts`, `agents/problematic-pr-diagnoser.ts`, `jobs/datasette-export.ts`, `jobs/runner-monitor.ts`, and `jobs/connectivity-verifier.ts`. `mapWithConcurrency(items, concurrency, fn)` (#2022) — bounded-concurrency batch mapper, `Promise.all` semantics (rejects on first failure, preserves input order); moved here verbatim from a local copy in `triage-claws-errors.ts`, which now imports it. `mapSettledWithConcurrency(items, concurrency, fn)` — a thin wrapper returning `PromiseSettledResult<R>[]` (per-item error isolation, never rejects) for callers that previously hand-rolled a `for` loop of `Promise.allSettled` batches; used by `public-repo-scanner.ts`, `runner-metrics-sync.ts`, `actions-storage-monitor.ts`, and `github.ts`'s `fetchWorkflowRunsBatched` (#2044) — replaced a batch-synchronous loop (wait for all `concurrency` repos to settle before starting the next batch) with a sliding window (starts the next repo as soon as any one finishes), which is strictly faster and never exceeds the concurrency cap
├── sensitive-env.ts     Exports `SENSITIVE_ENV_KEYS` — a zero-dependency leaf module (#1944) so `capabilities.ts` can import the constant without pulling in `claude.ts`'s heavy dependency tree (which would break `capabilities.test.ts`, which mocks only `./config.js`); `claude.ts` re-exports the same constant for backward compatibility
├── ssh.ts               Shared SSH/scp helpers (#1909), extracted from duplicated argument-assembly and `execFile`→Promise code across remote-ops jobs. `buildSshArgs(cfg: SshConnection, opts?)` assembles the common connection flags in a fixed order — `-o StrictHostKeyChecking=<accept-new|yes> -o ConnectTimeout=10 -o BatchMode=yes`, plus `-p`/`-P <port>` (scp uses `-P`) when `port !== 22` and `-i <identityFile>` (resolved via `resolveIdentityFile`) when set — and does NOT append the target or command; callers append `user@host` + command (ssh) or `localPath` + `target:remotePath` (scp) themselves. `execCapture(cmd, args, opts)` wraps `execFile` in a Promise (default `maxBuffer` 4 MiB), resolving stdout as a string and rejecting with trimmed stderr (falling back to the error message). `isSafeAbsolutePath(path)` (#1993) validates a config-supplied absolute path against `/^\/[a-zA-Z0-9._/-]+$/` (leading `/`, conservative charset excluding shell metacharacters) before it is interpolated into an SSH command string — the single shared implementation of a regex previously duplicated byte-for-byte in `kubeconfig-refresh.ts` (`SAFE_REMOTE_PATH`) and `runner-monitor.ts` (`SAFE_ACTIONS_DIR`, inside `assertSafeActionsDir`), both of which now import it instead. Used by `jobs/runner-monitor.ts` (`sshExec`, `assertSafeActionsDir`), `jobs/kubeconfig-refresh.ts` (`sshCapture`, remote-path validation), `jobs/datasette-export.ts`, `jobs/connectivity-verifier.ts`, and `jobs/mac-runner-waker.ts`
├── home-assistant.ts    Home Assistant REST API client — `listStates()`, `callService()`, `listUpdateEntities()`, `installUpdate()`, addon log fetching; `isConfigured()` checks `HOME_ASSISTANT_BASE_URL`/`HOME_ASSISTANT_TOKEN`; `isHaTransient()` matches HA 429/5xx for `retryWithBackoff`; used by `ha-upgrader`, `ha-deploy-watcher`, and `bin-day-monitor`
├── mcp-result.ts        Shared MCP tool-result helpers (`ToolResult` interface, `textResult`, `errorResult`) — pure, no config/runtime dependencies; imported by `namey-query.ts`, `ha-mcp.ts`, and `mcp-server.ts` (extracted from those modules to avoid duplication; `ha-mcp.ts` requires the wider `obj: unknown` signature rather than `Record<string, unknown>`)
├── shutdown.ts          Graceful shutdown flag + ShutdownError class (shared across modules)
├── test-helpers.ts      Test factories (mockRepo, mockIssue, mockPR)
├── pwa.ts               PWA support (#1818) — `APP_ICON_SVG` (inline SVG icon), `WEB_MANIFEST` (JSON web app manifest served at `/manifest.webmanifest`; `display: "standalone"`, `/` scope/start_url, 192/512 PNG icon refs), and `getAppIconPng(size)` (rasterizes the SVG to PNG via `sharp` — already a dependency, used elsewhere in `images.ts` — memoized per size in an in-process `Map` since the icon is static); deliberately ships with no service worker (iOS Add-to-Home-Screen standalone mode doesn't require one, and a cache-first worker would risk serving stale auth-gated dashboard content)
├── resources/
│   ├── claws-info.ts                 Exports `CLAWS_AUTOMATION_DOC` (the canonical `docs/claws-automation.md` markdown) and `CLAWS_AUTOMATION_DOC_PATH` (`"docs/claws-automation.md"`); `doc-maintainer` compares the committed file against this constant and rewrites it when stale — the content is owned here, not by Claude
│   ├── marketing.ts                  Marketing knowledge resource for idea-suggester prompts
│   ├── alpinejs.ts                   Exports `ALPINE_JS_SOURCE` — Alpine.js bundle served at `/static/alpine.js`
│   ├── tailwind-css.generated.ts     Exports `TAILWIND_STYLESHEET` — generated Tailwind CSS link tag
│   ├── error-handler.generated.ts    esbuild bundle of `src/client/error-handler.ts`; exports `ERROR_HANDLER_SCRIPT` (window.onerror + unhandledrejection → `/api/client-error`)
│   ├── queue.generated.ts            esbuild bundle of `src/client/queue.ts`; exports `QUEUE_SCRIPT`
│   ├── sessions-list.generated.ts    esbuild bundle of `src/client/sessions-list.ts`; exports `SESSIONS_LIST_SCRIPT`
│   └── session-terminal.generated.ts esbuild bundle of `src/client/session-terminal.ts`; exports `SESSION_TERMINAL_SCRIPT`
├── client/
│   ├── error-handler.ts    Client-side window.onerror + unhandledrejection handler; POSTs deduplicated fingerprints to `/api/client-error`
│   ├── queue.ts            Client-side queue page interactions — skip/prioritize/unmark-problematic buttons and "Refresh from GitHub" button (POSTs to `/queue/refresh`, reloads page after 4 s on success; `already-running` treated as success); `markRefined` keeps the row in place on success (sets button text to "Refined ✓", disables it, adds `refined-done` class for stable green styling) — the row self-reconciles on the 60 s page auto-refresh once the server stops rendering the Refined button for that item
│   ├── sessions-list.ts    Client-side sessions list page interactions
│   └── session-terminal.ts xterm.js terminal — WebSocket PTY bridge, ResizeObserver-based fit (replaces RAF), Paste button, Copy button (snapshot overlay), Enter key (`"\r"` in `KEY_MAP`) and other mobile keys; Cmd+C (mac) / Ctrl+Shift+C (linux/windows) and right-click both copy xterm's **own** selection (`term.getSelection()`) rather than relying on the browser's native DOM copy (#1822) — xterm.js renders selection on its own canvas layer, which is nearly invisible to native Cmd+C (previously copied ~one word) and is dropped by the browser before a right-click context-menu "Copy" can fire; `term.attachCustomKeyEventHandler()` intercepts the keystroke (returning `false` only when it actually consumes it, so all other keys reach the shell unmodified) and a `contextmenu` listener on the terminal element calls `event.preventDefault()` + copies when a selection exists; **never intercepts plain Ctrl+C**, which must keep sending SIGINT to the shell; copy result flows through `navigator.clipboard.writeText()` with an `execCommand("copy")` textarea fallback, flashing "Copied ✓"/"Copy failed" on the same Copy button used by the whole-buffer overlay
├── pages/
│   ├── dashboard.ts     Main status page HTML builder
│   ├── queue.ts         Work queue page HTML builder
│   ├── logs.ts          Log list, detail, and issue logs page HTML builders
│   ├── config.ts        Config editor page HTML builder
│   ├── topology.ts      Pipeline topology visualization page (SVG diagram, live status)
│   ├── whatsapp.ts      WhatsApp status/pairing page HTML builder
│   ├── sessions.ts      Session list + terminal page HTML builders; session list form uses `display:flex; flex-wrap:wrap` so label+select pairs stack on mobile; terminal page injects `ERROR_HANDLER_SCRIPT` (from `error-handler.generated.ts`), adds `ws.onerror` handler that writes a red reconnect message to xterm.js, and uses `SESSION_TERMINAL_SCRIPT` (from `session-terminal.generated.ts`) for the xterm.js terminal — ResizeObserver-based fit (replaces RAF; fixes 1-row canvas on mobile), Paste button (`navigator.clipboard.readText()` → WebSocket `{type:'input',data}`), Copy button (dumps terminal buffer via `term.buffer.active` into a read-only `<textarea>` overlay — supports native long-press selection and OS copy on mobile where shift-click is unavailable; includes a "Copy all" convenience button with clipboard API + `execCommand` fallback; closes on backdrop click), and mobile keybar with Esc, Tab, Enter, font-size controls (A−/A+), ^D, ^D×2 (sends Ctrl+D twice ~50ms apart for Claude Code exit), arrow keys, Ctrl, Home/End/PgUp/PgDn, ^C/^Z/^L
│   ├── jobs-matrix.ts   Per-repo job enable/disable matrix page HTML builder
│   ├── ha-upgrader.ts   Home Assistant update state page HTML builder — shows pending/applied/failing/blocked HA updates from the DB
│   ├── damp.ts          Damp meter reading page HTML builder (`/damp`, #1819/#1824/#1900/#1904) — exports `DAMP_POINTS` (the single source of truth for the 15 fixed `{ location, point, wall: "masonry"|"stud", exposure: "interior"|"exterior" }` measurement points: 4 in the downstairs toilet, 3 on the sitting-room wall, 3 on the sitting-room bay window, 2 in the Hall Closet — `Manifold` and `utility`, and 3 on the utility wall; readings are keyed by `(location, point)` strings, not array index, so inserting a new point anywhere in the array cannot corrupt existing rows — `src/server.ts`'s `POST /damp/log` handler iterates by index for form field names but only reads back `.location`/`.point`, so reordering or resizing the array would silently misalign submitted readings even though adding fields is safe) and `buildDampPage()`. `wallLabel(p)` renders `"<wall> · <exposure>"` (middle dot, HTML-safe) and is surfaced as a "Wall" column in both the log-entry form and the trends table; `renderHistory()` looks up the same label via a `WALL_BY_KEY` map keyed by `pointKey(location, point)`. `renderContext()` includes qualitative expected-reading guidance per wall type (interior stud reads low/stable, interior masonry moderately higher, exterior masonry highest and rain-reactive) so readings are judged against their own construction type, not each other. `renderCharts()` plots all 15 points as a single multi-series SVG (one shared date/value axis, a 15-colour `CHART_PALETTE`, location+point legend labels since point names repeat across locations) rather than one chart per location. `buildDampPage()` renders the log-entry form (one numeric input per point, POSTs to `/damp/log`), the consolidated chart, a trends table (latest value, reading date, previous value, and a Δ arrow computed from the two most-recent rows per point), and a recent-history table
│   ├── k8s.ts           Kubernetes integrations page HTML builder — shows monitor status, recent monitor runs, and a link to open alert issues for k3s and prod-k8s clusters
│   ├── repo.ts          Per-repo detail page HTML builder (`/repos/:owner/:repo`) — recent tasks with outcome summaries and open queue items for that repo
│   ├── lists.ts         Cross-repo aggregate list pages (#2096) — `buildAllPRsPage()` (`/prs`) and `buildAllIssuesPage()` (`/issues`) flatten every managed repo's open PRs/issues into one sorted (by `updatedAt` desc) table with a Repo column, reusing the pipeline-stage badge logic from `repo.ts`. Both pages are Alpine components (`pageShell` loads `ALPINE_SCRIPT` + `QUEUE_SCRIPT` and sets `x-data="queuePage()"`) so each row's **Actions** column reuses the existing `mergePR`/`markRefined` client handlers verbatim — no new server routes or client script needed (#2099). The PR row's Squash & Merge button is gated (#2110) on `resolveStatus()`: hidden unless `mergeableState === "MERGEABLE"`, `checkStatus === "passing"` (or `"none"` with no CI configured), and `reviewStatus` is not `"issues"`/`"escalated"`; status comes from a per-repo bulk `listPRStatuses()` fetch (falls back to the queue-cache item if that fetch failed, so nothing regresses to a permanently-hidden button). Every GitHub-supplied string (title, author, branch, repo) is passed through `escapeHtml` — these tables render attacker-influenceable text. Both tables opt into `PAGE_CSS`'s shared `.data-cards` mobile layout (#2124) via `class="data-cards"` plus a `data-label` attribute on every `<td>`; other table pages can adopt the same pattern by adding the same class and attributes
│   ├── claude-auth.ts   Reauth page HTML builder (`/claude-auth`, #2082) — "Start login"/paste-code UI driving `startClaudeLogin`/`submitClaudeLoginCode`/`getClaudeLoginStatus` in `../claude-auth.ts`; the OAuth URL is rendered in a `readonly` selectable input (`onclick="this.select()"`) so it's easy to copy in full, unlike a wrapped terminal line
│   ├── runners.ts       Self-hosted runner utilization page HTML builder (`/runners`) — active workflow runs and `WorkflowRunStats` synced by `runner-metrics-sync`
│   ├── usage.ts         Token/cost usage dashboard HTML builder (`/usage`) — `getUsageStats`/`getTotalUsage` breakdowns by repo, job, and provider+model over a selectable 1/7/30-day window
│   ├── verify.ts        Connectivity verification report page HTML builder (`/verify`) — shows the latest `VerificationReport` and current `ActivationState` (active vs. verify-only)
│   ├── blog.ts          Blog post editor page HTML builder (`/blog`, #1849) for `BLOG_REPO` (`St-John-Software/bstjohn-blog` default, env `CLAWS_BLOG_REPO`) — no Claude/agent invocation, plain CRUD over GitHub content plus a `blog_drafts` SQLite table (survives across browsers/sessions). Read directly from `process.env` rather than routed through `config.ts` (unlike most other configurable values in this codebase). `buildBlogListPage()` lists posts fetched live from `BLOG_CONTENT_DIR` (`src/content/blog` default, env `CLAWS_BLOG_CONTENT_DIR`) via `listRepoDirectory()`, merged with any in-progress drafts (draft-only rows for posts not yet pushed to GitHub) and a status badge (`draft` / `pushed #N`). `buildBlogEditPage()` edits the **raw file text** (frontmatter + body) in a single textarea — deliberately does not parse/rebuild YAML frontmatter, since the sole editor is the trusted repo owner. `isValidBlogPath()` is the only guard on the write path: the path must be under `BLOG_CONTENT_DIR`, end in `.md`, and contain no `..` segment
│   └── layout.ts        Shared layout (header, theme support, formatters, `timestampHtml()` / `LOCAL_TIME_SCRIPT` for client-side timestamp localisation, `ALPINE_SCRIPT` for defer-loading Alpine.js on all pages, `TAILWIND_STYLESHEET` link tag for pages using the generated Tailwind CSS alongside `PAGE_CSS`, `buildPageHeader()` for consistent `<h1>claws</h1>` + nav + optional `<h2>` across all pages; `ERROR_HANDLER_SCRIPT` from `error-handler.generated.ts` is prepended so the error handler runs before any other script on every page that calls `buildPageHeader()`; `HEAD_META` (#1818/PWA) — manifest link, `theme-color`/`apple-mobile-web-app-*` meta tags, and apple-touch-icon link, sourced from `pwa.ts` — is included in most page builders' `<head>` (notably absent from `damp.ts`, which was added after PWA support landed); `buildNav()` includes `/prs`, `/issues`, `/damp`, `/k8s`, and `/claude-auth` ("Reauth") links. Mobile layout (#2124): `PAGE_CSS` ships a shared `.data-cards` responsive block — tables opted in via `class="data-cards"` collapse to stacked cards below 768px, keyed off `data-label` on each `<td>` (`content: attr(data-label)`), with `hide-sm` dropping low-value columns and `cell-title` hoisted to the top of the card via `order: -1`. `buildNav()` is a CSS-only checkbox disclosure (`#nav-toggle` + `.nav-toggle-label`/`.nav-links`, no JS) — collapsed behind a "Menu" toggle below 768px, always expanded at ≥768px; `sessions.ts`'s terminal page dropped its own redundant hamburger-button nav toggle in favor of this shared mechanism
├── agents/
│   ├── issue-refiner.ts        Per-item planning functions (fresh plan, refinement, follow-up); planners run in fresh git worktrees (created via `createWorktree()` in `src/claude.ts`) containing only tracked files — dependencies are NOT installed (`node_modules` is `.gitignore`d and omitted); agents that need them must run `npm install`/`npm ci` themselves, but planners typically read lockfiles directly for dependency/version analysis rather than incurring the cost of a full install. Planner runs with the full main-agent toolset — per-repo behaviour is shaped by the repo's `.claude/agents/issue-refiner.md` document, which is read via `readRepoAgentDoc()` and injected into every `runClaude` call via `--append-system-prompt`; and the prompt builders. All three prompt builders inject `LINKED_REFERENCES_INSTRUCTION` (planner **must** fetch linked GitHub issues/PRs via `gh` before writing the plan and is explicitly **forbidden** from deferring the lookup to the implementer — the implementer runs on a smaller model and will produce wrong code without the facts embedded in the plan; applies to cross-repo links, with a fallback to proceed-with-what's-in-the-issue when both `gh issue view` and `gh pr view` return 404), `EXTERNAL_REFERENCES_INSTRUCTION` (use WebFetch for external URLs, WebSearch for library/concept research), `DIAGNOSTIC_REFERENCES_INSTRUCTION` (fetch and inspect GitHub Actions logs/artifacts before writing the plan — uses `gh run view --log-failed` / `gh run view --log` and `gh run download`; requires commitment to ONE diagnosed root cause, not speculative branches), and `homeAssistantContext()` when `HOME_ASSISTANT_BASE_URL`/`HOME_ASSISTANT_TOKEN` are configured **and** `isHomeAssistantConfigRepo(fullName)` is true (default-deny elsewhere, #2064) — giving the planner access to `ha_list_entities` and `ha_api_request` MCP tools only for issues on the HA config repo. `homeAssistantContext()` (`agent-context.ts`) directs the model to use **only** those two MCP tools and explicitly tells it not to expect an HA token in its shell environment or to `curl` the HA API directly (#1814): every `tool-use` agent that calls this shared context string (planner, issue-worker, ci-fixer, review-addresser) runs with strict env sanitization by default (`sanitiseEnvForChild` in `claude.ts` strips `SENSITIVE_ENV_KEYS`, including the HA token, from the child process env — see #1840), so a shell-token/curl approach reliably fails for all of them — the MCP server holds the credential out-of-band regardless. MCP config is written with `{ includeNameyDb: false, includeHomeAssistant: isHomeAssistantConfigRepo(fullName) }` (Namey is out of scope for the planner; HA tools are scoped to the HA repo). Plan generation and refinement run on the opus-tier Claude model by default; an issue labelled `Plan: Fable` is planned with `claude-fable-5` instead. Follow-up Q&A does not honour the label. When Fable routing applies, `FABLE_PLANNING_CONTEXT` is injected into the prompt instructing the model to invest the extra capability in deeper investigation — reading more of the codebase, tracing actual code paths, verifying assumptions against real files — rather than writing a longer plan, and emphasising that the implementer is unchanged so the planner–implementer capability gap is wider than usual. After generating any plan output, `stripLeadingPlanHeader()` strips a leading `## Implementation Plan` header from the model output before posting — instruction-faithful models like Fable reliably produce this since `CONCISENESS_INSTRUCTIONS` tells the planner to start with that header and the posting code also prepends it, resulting in duplication. After a fresh plan is generated and before it is posted, a second text-only pass (`runStepBack`, gated on `CLAWS_PLANNER_STEP_BACK !== "false"` and plans at least `STEP_BACK_MIN_PLAN_CHARS` long) asks whether the plan is a well-executed version of a suboptimal approach; it defaults to "sound" and stays silent, and on a `reconsider` verdict its complete replacement plan is posted as the plan while the critique goes out as a separate `## Step Back` comment (deliberately not containing `## Implementation Plan`, since plan lookup elsewhere finds the last comment containing that header). It runs on `processIssue` only — not `processRefinement`/`processFollowUp`, which already have a human in the loop — and any failure or unparseable output falls back to posting the original plan.
Every plan comment (fresh plan, refinement, and in-place replan edits) appends a plain-text
`CLAWS_PLAN_OCCURRENCES: N` marker recording the occurrence count of the issue body at planning
time. `parsePlannedOccurrences(planBody)` extracts this integer from a plan comment; `findUnreactedFeedbackAfterPlan`
returns it as `plannedOccurrences` alongside the existing `hasPlan`/`unreacted` fields. The
`issue-dispatcher` uses this to trigger `ISSUE_REFINER_REPLAN` when the current issue occurrence
count is ≥ `plannedOccurrences * 2` (and > `plannedOccurrences`) — handled by calling
`processRefinement` with no unreacted feedback, which edits the plan in place with updated context.
Legacy plans without the marker default to `plannedOccurrences = 1`, ensuring existing alert issues
receive one backfill re-plan.
│   ├── issue-worker.ts         Per-item implementation functions (create PR, continue phases). Injects repo agent doc (`issue-implementer`) via `appendSystemPrompt`. `buildPRTitle()` uses the diff-derived subject from `claude.generatePRDescription()`'s `TITLE:` marker (extracted by `extractTitleMarker`, #2028) for single-phase PRs instead of the original issue title, since refinement can diverge the implementation from what the issue asked for; the multi-phase path still uses plan phase titles, unchanged.
│   ├── ci-fixer.ts             Per-item CI fix functions (identify, fix, conflicts, unrelated). Injects repo agent doc (`issue-implementer`) via `appendSystemPrompt`. `pushAndUpdatePR()` regenerates the PR body via `claude.regeneratePRDescription()` but, mirroring `review-addresser.ts`, re-extracts and reattaches the phase header (`## PR N of M: ...`) and `Closes #N`/`Part of #N` line from the pre-regeneration body before overwriting it (#2018) — otherwise a CI-fix or conflict-resolution pass would silently drop the issue auto-close link and the multi-phase identifier. Exports `parseMajorBumps(text)` (#2065) — scans a PR title/body for Dependabot "bump X from A to B" phrasing and returns only the pairs whose leading integer increases (so `5.4.5→7.0.0` flags but `4.1.8→4.1.10` doesn't; also flags non-semver majors like a Docker base-image tag bump), deduped by package name. `fileMajorBumpIssue(fullName, pr)` runs `parseMajorBumps` against the title, falling back to the PR body for grouped bumps, and — when `triggerCircuitBreaker` fires (the PR is stuck, not on first CI failure) — files a tracking issue via `ensureAlertIssue()` describing the broken major-version bump, per the policy that a failing major bump must be fixed properly rather than blocklisted in `dependabot.yml`. Filing at the circuit-breaker point (rather than on first failure) preserves auto-fixing of majors that *are* fixable via codemods/API renames and only escalates genuinely-stuck ones.
│   ├── review-addresser.ts     Per-item review addressing functions. Injects repo agent doc (`issue-implementer`) via `appendSystemPrompt`. Posts its summary of actions taken as a single comment edited in place each round (`postOrEditAddresserComment`, marked with `review-addresser-summary`) rather than a fresh comment per round, avoiding per-round comment spam on long review loops (#1927).
│   ├── pr-reviewer.ts          Per-item PR review functions. Injects repo agent doc (`pr-reviewer`) via `appendSystemPrompt`. Reviews are posted as a **single comment that is edited in place** each round (`postOrEditReview`) rather than a fresh comment per round; prior rounds are preserved in a collapsed `<details>` audit log (`ARCHIVE_SUMMARY`, capped at `ARCHIVE_MAX_ENTRIES` entries / `ARCHIVE_MAX_ENTRY_CHARS` chars each) so `getReviewHistory()` can recover full multi-round context for the reassessment prompt instead of only the latest round. A review is classified `review-result: clean`, `review-result: advisory` (findings exist but are all non-blocking — recorded without triggering another addresser round, and still Ready-eligible), or left blocking (default — withholds Ready and triggers review-addresser). After `MAX_REVIEW_ITERATIONS` (8) rounds without converging, the loop escalates: posts a `review-result: escalated` marker and the `Manual Action` label instead of grinding on (escalated reviews are never Ready-eligible, unlike advisory) (#1927).
│   ├── auto-merger.ts          Per-item merge function (tryMerge); LGTM-exempt categories: dependabot, claws docs, idea-collection, and prod-infra auto-bump PRs (branch automation/bump-*, label auto-bump) — bump PRs still require passing CI and may only touch the image-pin manifests the bump-app-version workflow rewrites: `deployment.yaml`, `migrate-job.yaml`, and `cleanup-test-data-cronjob.yaml` under `apps/<app>/` or its `base/`/`prod/` overlay.
│   ├── problematic-pr-diagnoser.ts  One-shot deep-diagnosis pass (`ci-fixer:problematic` kind) for PRs flagged `Claws Problematic` by the ci-fixer circuit breaker; short-circuits to `success` (clears the label) if CI already recovered before the pass runs; otherwise runs up to `MAX_ROUNDS` (3) rounds watching CI (`ciWatchBudgetMs`/`ciPollIntervalMs`) and posts a final report comment marked with `DIAGNOSIS_COMMENT_MARKER`
│   └── agent-context.ts        Shared tool-context strings (kubectl, namey_query, home-assistant including ha_list_entities/ha_api_request tool hints, fast-checks guidance, runner policy) injected into agent prompts; also exports `formatIssueCommentsForPrompt(comments, selfLogin, guardCtx)` — shared helper that formats `IssueComment[]` into flat prompt lines (`---` / label / body / `""` per comment); strips the Claws marker from self-authored comments without guarding them (no injection risk), and runs `guardContent()` on all human-authored comments; used by issue-refiner (three prompt builders) and issue-worker
└── jobs/
    ├── issue-dispatcher.ts     Unified issue dispatcher — orchestrates planner + implementer agents; gates dispatch on issue author via `isAllowedActor()` in both Phase 1 (refined → implementer) and Phase 2 (fresh plan/refine → planner)
    ├── sequential-issue-processor.ts  Opt-in (per repo, via the `/jobs` matrix — `OPT_IN_JOB_NAMES`) "process all issues" mode for incident-heavy repos (#2103). Each tick, per opted-in repo: gathers open, non-skipped, non-duplicate issues; if any candidate already carries `Refined` it's in flight, so the job returns (serialized — one issue at a time); if any carries `Manual Action` it holds the repo until a human clears the label (no skip-ahead); otherwise calls `prioritiseIssues()` (a single opus call in `issue-refiner.ts` that ranks **all** open candidates together and classifies each `auto`/`needs_human`/`out_of_scope` — issue number is filing order, not priority) and applies the `Refined` label to the top `auto`-classified issue, which launches the existing plan → implement → PR → review → merge pipeline unchanged. Cross-repo grouping (e.g. app + its deployment repo processed as one unit) is a known limitation, not yet implemented — each opted-in repo advances independently
    ├── pr-dispatcher.ts        Unified PR dispatcher — orchestrates CI fixer + review addresser + reviewer + merger agents
    ├── scanner-runner.ts       Shared sequential scanner runner utility used by scanner-dispatcher; exports `RECURRENCE_TRACKING_SNIPPET_LINES` (a `readonly string[]` canonical bash occurrence-tracking snippet for CI failure notification workflows — single source of truth shared by `main-build-monitor-scanner` and `issue-comment-spam-scanner` so both scanners recommend the identical pattern); also exports `renderViolationTable<T>(opts: ViolationTableOptions<T>)` and the `ViolationTableOptions<T>` interface — used by concurrency-scanner, runner-os-scanner, cache-on-self-hosted-scanner, migration-scanner, and ubuntu-latest-scanner to generate GitHub Markdown violation tables consistently (header row, separator, data rows, footer prose) without duplicating table-formatting logic. `processRepo()`'s dedup check uses `findIssueByExactTitle(repo.fullName, spec.issueTitle)` (#2019), not `gh.searchIssues()` — GitHub's search is substring/fuzzy, so an unrelated open issue sharing words with the scanner's title used to suppress real violation reports
    ├── workflow-parser.ts      YAML workflow parser utility — `parseWorkflow()` returns a typed `ParsedWorkflow` with `getTriggers()`, `getJobs()` (typed `JobInfo` with `runsOn`, `concurrency`, `steps`), `getPushConfig()`, and `getWorkflowRunTargets()`; `listParsedWorkflows(repoDir)` iterates a repo's `.github/workflows/` directory and returns `ParsedWorkflowFile[]` (each entry: `{ file, filePath, content, workflow }`) or `null` when the directory is absent — used by concurrency-scanner, cache-on-self-hosted-scanner, runner-os-scanner, and main-build-monitor-scanner to eliminate repeated boilerplate; `listWorkflowFiles(repoDir)` is the lower-level file enumeration used by ubuntu-latest-scanner; tolerates malformed YAML (returns an empty-job object rather than throwing)
    ├── connectivity-verifier.ts  On-demand connectivity checker used by `verify-only` mode — `runConnectivityVerification()` runs every configured integration (DB, GitHub App, CLIs, Slack, IMAP, SSH, Ollama, WhatsApp) with a 30 s per-check timeout and writes results to `verification_reports`; `getLatestVerificationReport()` is read by `GET /verify` and `GET /api/activation`
    ├── triage-claws-errors.ts       Investigates internal Claws errors ([claws-error] issues)
    ├── doc-maintainer.ts       Nightly documentation generation/update; also deterministically syncs `docs/claws-automation.md` (from `src/resources/claws-info.ts`) into every repo after each Claude pass — the skip gate requires both an unchanged HEAD and a current `claws-automation.md` to skip processing, so the first rollout touches every repo even without code changes; links it from OVERVIEW.md. Also gathers human-authored intent (#2090) — issue/PR bodies and comments filtered to exclude bot/Claws-authored content (`isHumanLogin()`) — into a temporary `.intent/` directory (never committed) and has Claude fold it into an append-only `docs/intent-log.md`; the first run per repo (detected by the absence of `docs/intent-log.md`, since `lastDocSha` is non-null on every previously-processed repo) does an unbounded historical scan instead of the usual since-last-commit window. See [doc-maintainer.md](jobs/doc-maintainer.md)
    ├── repo-standards.ts       Syncs labels and cleans legacy labels for each managed repo; removes stale local clones
    ├── improvement-identifier.ts  Reviews codebases for security issues and improvements via Claude; files issues for both (no longer opens PRs); conditionally emits Web/SEO and JSON-LD structured-data suggestions for repos that serve user-facing HTML (detected by presence of `*.html` files, static-site generator configs, or `public/`/`static/`/`dist/` output dirs — skipped for backend, library, CLI, and infra repos); truncated Claude output in the analysis phase is detected structurally — via `isCompleteJson()` in `json-extract.ts`, not by checking whether the output ends with a closing code fence (a prior heuristic that false-negatived whenever truncation happened to land right after an inner fence inside the improvement `body` text, issue #1810) — in the `parseReviewOutput` `onFailure` callback, and downgraded to a warning rather than an error issue; the job retries on the next tick
    ├── public-repo-scanner.ts  Daily scan of all public repos (including archived) for accidentally-committed sensitive data (secrets, private keys, credentials, PII); manages its own 7-day per-repo throttle via `processed_repos_daily`; does NOT call `writeClawsMcpConfig()` (capability: text-only, no MCP needed); files alert issues via `ensureAlertIssue()`; `parseFindings`'s `onFailure` callback also gates on `isCompleteJson()` (#1810) before calling `reportError`, so a truncated scan output is silently skipped and retried next tick instead of always filing a `[claws-error]` issue; `findSnapshotSource(fullName)` checks whether the scanned repo is a `PUBLIC_SNAPSHOTS` target and, if so, `fileFindings` routes the alert to `SELF_REPO` instead (never the private source — the body explains the finding is fixed by adding the path to that pair's `scrubPaths`, not by editing the source, which is allowed to hold the data) — see `public-snapshot-sync.ts` (#1875, #1962)
    ├── idea-suggester.ts       Suggests new ideas per repo, posts to Slack for reaction-based review
    ├── idea-collector.ts       Collects Slack reactions on ideas, creates GH issues and collection PRs; `appendEntries(file, header, ideas, formatFn)` (#2012) is the shared write helper for the accepted/potential/rejected branches — it writes each target file exactly once, so callers with multiple ideas destined for the same file must group by file path first (see the accepted branch's `acceptedByFile` map) rather than calling `appendEntries` once per idea, or concurrent same-file writes would clobber each other
    ├── issue-auditor.ts        Daily audit ensuring no issues fall between the cracks
    ├── whatsapp-handler.ts     Interprets WhatsApp messages via Claude, creates GitHub issues; runs the Claude call in `claude.ensureScratchDir("whatsapp-handler")` rather than `process.cwd()`, with `disallowedTools: claude.TEXT_ONLY_DISALLOWED_TOOLS` (#2068) — isolates untrusted inbound message text from the production working directory and strips filesystem/shell/network tool access
    ├── runner-monitor.ts       Monitors self-hosted GH Actions runners via SSH
    ├── mac-runner-waker.ts     Wakes sleeping self-hosted Macs over SSH — polls `MAC_RUNNER_REPOS` for queued workflow runs older than `QUEUED_GRACE_MS` (60s), fetches each run's queued jobs, matches macOS jobs (`isMacJob()`, any `macos` label) to a configured `MacRunner` by label subset match (`matchingRunners()`), then SSHes a bounded `nohup caffeinate -dimsu -t <WAKE_HOLD_SECONDS> & disown; echo awake` per matched host (`wakeRunner()`, 3 retries via `retryWithBackoff`) subject to a 5-minute per-host `WAKE_COOLDOWN_MS`. A bare network wake is a "dark wake" — the Mac answers SSH long enough to be picked up by the runner, then re-sleeps within seconds unless something holds a power assertion, causing the job to go silent mid-checkout ("lost communication with the server"); `caffeinate` holds the assertion for `WAKE_HOLD_SECONDS` (600s, covering pickup through the job's own keep-awake step) and the `-t` bound ensures a wake with no job behind it cannot pin the Mac awake indefinitely. SSH failures report a per-host `[claws-error]` fingerprint (`mac-runner-waker-ssh:<host>`) via `reportError()`; GitHub API errors use the bare `"mac-runner-waker"` fingerprint. Deliberately excluded from `runners`/`RUNNER_HOSTS` — `runner-monitor`'s `df`/`sudo ./svc.sh status`/`journalctl` checks assume Linux and would fail non-interactively on macOS. Each `MacRunner` has an optional `enabled` flag (togglable per-Mac in the config UI); a Mac with `enabled: false` is skipped entirely — no SSH attempt and no `[claws-error]` alert — which is how an operator silences a Mac taken off the LAN (issue #1980)
    ├── scanner-dispatcher.ts   Runs scanners sequentially: ubuntu-latest, concurrency, migration, main-build-monitor, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, gitignore
    ├── ubuntu-latest-scanner.ts  Scans workflows for non-self-hosted runners, creates alert issues
    ├── concurrency-scanner.ts  Scans workflows for missing/misconfigured concurrency groups
    ├── migration-scanner.ts    Scans repos for incrementally-numbered migrations, recommends date stamps
    ├── main-build-monitor-scanner.ts  Scans workflows for main-branch builds and scheduled jobs, files alert if failures aren't monitored
    ├── cache-on-self-hosted-scanner.ts  Scans workflows for unnecessary caching steps (actions/cache, setup-* cache options) in self-hosted runner jobs where workspace is persisted
    ├── issue-comment-spam-scanner.ts  Scans workflows for the `gh issue create` + `gh issue comment` pattern (posting new comments on recurrence instead of editing the issue body)
    ├── runner-os-scanner.ts  Flags self-hosted runner jobs missing a linux/macos OS label
    ├── claude-config-scanner.ts  Scans repos for missing CLAUDE.md and named subagents in .claude/agents/, files alert issue with recommended layout
    ├── gitignore-scanner.ts  Scans repos for a missing `.mcp-claws.json` entry in `.gitignore`, files an unlabeled chore issue
    ├── dependabot-config-scanner.ts  Detects dependency manifests per repo and flags (ecosystem, directory) pairs no dependabot.yml/Renovate config covers, files alert issue with the exact YAML to add
    ├── stale-branch-cleaner.ts Deletes stale claws/* remote branches after PR merge/close
    ├── idea-reconciler.ts      Reconciles closed-without-implementation ideas back to potential.md
    ├── qa-phase.ts             Exploratory QA on deployed PRs via Playwright browser automation
    ├── email-monitor.ts        Polls Gmail for veg box emails, generates recipes via Claude; IMAP connect goes through `retryWithBackoff` (#2037, 1 retry — 2 total attempts, matching the prior hand-rolled loop it replaced) rather than a bespoke retry loop; each attempt constructs a fresh `ImapFlow` instance since one whose `connect()` rejected is not reusable. Both Claude calls (extraction + recipe generation) run in `claude.ensureScratchDir("email-monitor")` rather than `process.cwd()`, with `disallowedTools: claude.TEXT_ONLY_DISALLOWED_TOOLS` (#2068) — email content is reachable by any external sender, so the agent runs isolated from the production working directory with filesystem/shell/network tools stripped. Before extraction, `processVegBoxEmail` checks the sender's address against `config.EMAIL_ALLOWED_SENDERS` (case-insensitive; enforced only when non-empty) and skips (marking the message seen) if it doesn't match
    ├── k3s-monitor.ts          Monitors k3s cluster pod/node health and Flux Kustomization/HelmRelease reconciliation failures; raises alerts with occurrence tracking (updates issue body instead of posting comments)
    ├── kubeconfig-refresh.ts   Kubeconfig auto-refresh via SSH — `refreshKubeconfig()` SSHes to a remote host (supports Tailscale hostname resolution via `resolveTailscaleHost()`), fetches the remote kubeconfig, rewrites its `server:` URL if needed, and atomically writes it locally; `isStaleKubeconfigError()` classifies kubectl errors that indicate a stale/rebuilt cluster vs. Claws-side defects a refresh cannot fix; used by k3s-monitor and prod-k8s-monitor as a best-effort recovery step before failing
    ├── prod-k8s-monitor.ts     Same detection logic as k3s-monitor but targets the prod cluster via configurable kubeconfig and files alerts to `PROD_K8S_REPO` (default: `St-John-Software/production-infra`); enabled via `prodK8sMonitorEnabled`; supports `prodK8sKubeconfigRefresh` for automatic kubeconfig rotation when the cluster endpoint changes
    ├── runner-metrics-sync.ts  Adaptive sync of GitHub Actions workflow runs to SQLite for runner utilization analytics
    ├── ha-upgrader.ts          Home Assistant update manager — polls HA entities, installs updates within dwell windows, raises GitHub issues on failures
    ├── ha-deploy-watcher.ts    Home Assistant deploy notifications — polls git-pull addon logs for Updating events, posts Slack notification with commit list (via `listCompareCommits`), compare link, and diffstat when `Updating <old>..<new>` is detected; commit-list fetch failures fall back to compare link only; first run baselines silently
    ├── datasette-export.ts     Exports the SQLite database to a remote host via scp (for Datasette exploration)
    ├── worktree-cleaner.ts     Daily prune of stale ~/.claws/worktrees/ directories
    ├── ha-monitor-common.ts    Shared entry guard for Home Assistant monitors — `resolveHaMonitorContext(enabled, logPrefix)` checks the enabled flag, `ha.isConfigured()`, and repo resolution (`HOME_ASSISTANT_CONFIG_REPO || FLEET_INFRA_REPO`), then fetches `ha.listStates()`; returns `{ repo, states } | null` (`null` on any guard failure, after logging the reason at `debug` or `warn` level as appropriate). Extracted from `bin-day-monitor.ts` and `ha-battery-monitor.ts`, which previously duplicated this sequence byte-for-byte; both now call it as the first line of `run()`
    ├── bin-day-monitor.ts      Polls Home Assistant every 15 minutes for `sensor.bin_scraper_*` entities (configurable prefix); maintains a single long-lived GitHub issue as a running availability log — issue is created on first MISSING event and never closed; body is rebuilt on every run to keep "Last checked" fresh; status transitions (HEALTHY ↔ MISSING) are appended as rows to an embedded history table; does NOT use `ensureAlertIssue` (that helper cannot record recoveries); entry guard via `resolveHaMonitorContext()`; enabled via `homeAssistantBinDayMonitorEnabled`; disabled by default
    ├── ha-battery-monitor.ts   Polls Home Assistant for battery sensors (`device_class=battery`, `unit_of_measurement=%`) below `homeAssistantBatteryThresholdPercent` (default 10%); creates a Priority issue in `homeAssistantConfigRepo` (falls back to `FLEET_INFRA_REPO`) listing all low devices; auto-closes the issue when all devices recover; body rebuilt in-place on each tick (never posts comments — compliant with issue-comment-spam rule); entry guard via `resolveHaMonitorContext()`; disabled by default (`homeAssistantBatteryMonitorEnabled`)
    ├── damp-reminder.ts    Weekly reminder (#1824) to log damp meter readings — runs on `intervals.dampReminderMs` (default 15 min, #1880); each tick checks `hasDampReadingLoggedSince(weekStart)` and auto-closes the open reminder (once per week, via the `closedForWeek` module-level guard) once readings are logged; on Monday local time ≥ 9 AM (`isReminderDay()`) with no readings yet, files a single deduplicated `Priority` issue in `SELF_REPO` via `findIssueByExactTitle` + `createIssue` (guarded by the `ensuredForWeek` module-level flag) pointing at the dashboard's `/damp` page — deliberately does NOT use `ensureAlertIssue()` (#1999): that helper is for recurring alerts where re-detection should bump an occurrence counter, and using it here rewrote the issue body (bumping "Occurrences") on every 15-minute tick all day instead of leaving a filed reminder untouched until closed
    ├── dependabot-alert-monitor.ts  Polls the GitHub Dependabot Alerts API per repo; auto-dismisses stale alerts (SBOM-based, then manifest-pin-based for pip `==` pins) and suppresses alerts via central config or a repo-local `.claws/dependabot-deferrals.json` manifest; files a Priority alert issue for the remainder. See [jobs/dependabot-alert-monitor.md](jobs/dependabot-alert-monitor.md).
    ├── actions-storage-monitor.ts  Daily scan of GitHub Actions cache + artifact storage usage across all repos. Fetches per-repo stats via `fetchRepoCacheUsage` and `fetchRepoArtifactUsage` in `github.ts` (fault-tolerant: 404 returns zero). Files a per-repo `ensureAlertIssue` when a repo uses ≥ 50 MB of Actions **cache** or has artifacts older than 7 days (high retention); files an org-level roll-up alert in `SELF_REPO` when total usage nears 80% of the 2 GB account quota. Runs at 5 AM (`actionsStorageMonitorHour`)
    └── public-snapshot-sync.ts  Daily (3 AM, #2106) private→public snapshot sync (#1826) of the `PUBLIC_SNAPSHOTS` pairs (`claws`, `3d-models`, `TempoStatusBar`, `fleet-infra` → `stjohnb/*`): rebuilds each target from its source's tracked files via `git archive`, scrubs development-process artefacts, disables workflow triggers, runs a fail-closed secret scan, and pushes one summarising commit. See [jobs/public-snapshot-sync.md](jobs/public-snapshot-sync.md).

deploy/
├── claws.service           systemd service unit (KillMode=process preserves tmux sessions across restarts; cgroup limits: MemoryHigh=2.5G, MemoryMax=3G, TasksMax=800, CPUWeight=80, OOMScoreAdjust=200)
├── claws-updater.service   systemd updater service
├── claws-updater.timer     systemd timer (every 60s)
├── install.sh              One-shot bootstrap installer
├── deploy.sh               Auto-update with Node ABI gate, health check, and rollback (see [Auto-Update & Rollback](#auto-update--rollback))
├── install-skills.sh       Installs bundled `.claude/skills/*` (e.g. `/postmortem`) into `$CLAWS_HOME/.claude/skills/`; run by both install.sh and deploy.sh on every deploy
└── uninstall.sh            Service removal
```

### Module Responsibilities

**`main.ts`** — Wires everything together. Acquires a **PID file lock** at
`~/.claws/claws.pid` on startup (liveness check via `process.kill(pid, 0)`);
exits immediately if a live sibling holds it — prevents double-scheduling in
k8s rolling updates. Initializes the SQLite database,
recovers orphaned tasks from a previous crash (cleans up dangling worktrees,
marks tasks failed), calls `recoverWorkOnStartup()` to reset any `work_queue`
rows stuck in `running` state from a previous crash back to `queued` (so they
are retried after restart), prunes old logs. When `ACTIVATION_STATE === "verify-only"`,
no jobs are registered, WhatsApp is not started, and `runConnectivityVerification()`
runs once at startup to populate `verification_reports`. When `"active"`,
registers all 30 jobs with the scheduler
(interval jobs staggered by 2 seconds to prevent thundering herd), calls
`registerWorkHandlers()` (from `work-handlers.ts`) to register agent callbacks
with the work queue, starts `worker.ts` fibers, starts the HTTP server, sets up
live config reloading (interval and schedule changes propagated to the scheduler
without restart), initializes the WhatsApp gateway if enabled, and installs
SIGINT/SIGTERM handlers that cancel queued tasks, drain running jobs (5 min
timeout), terminate active Claude processes, and close the database.

**`config.ts`** — Loads configuration in priority order: environment variables >
`~/.claws/config.json` > hardcoded defaults. Also exports `INTERNAL_MCP_TOKEN`, a per-process
random 64-hex-char token generated at startup via `crypto.randomBytes(32)`. It is never read from
env or config, never shown in the config UI, and never persisted — its sole purpose is to
authenticate MCP child processes (spawned by `claude.ts`) to the local HTTP server's `/api/state`
endpoint. It is the only programmatic credential the API accepts.
`requireApiAuth` in `server.ts` checks `INTERNAL_MCP_TOKEN` first, then accepts a valid
`claws_session` cookie when OIDC is enabled.
Exports `LABELS` (`refined`,
`ready`, `priority`, `inReview`, `clawsIgnore`, `problematic`, `duplicate`, `billing`, `planFable`, `manualAction`, `automerge`), `LABEL_SPECS`
(synced to all repos by repo-standards — includes colors and descriptions for
all eleven labels; `Plan: Fable` triggers Fable 5 planning in issue-refiner; `Manual Action` blocks
auto-merge (see `auto-merger.ts`) and is applied by `issue-worker` when the PR-description generator
emits a `MANUAL-ACTION:` marker; `Automerge` replaces the human-LGTM gate in auto-merger with an automated one (#2120)), `LEGACY_LABELS` (set of old labels cleaned up as stale, including
`claws-mergeable` and `claws-error`), `INTERVALS`, `SCHEDULES`, and
connection strings. `WORK_DIR` is always `~/.claws`. Also exports `PROMPT_CAPTURE_DIR`
(`~/.claws/prompt-captures/`), where `claude.ts` writes a JSONL record of every
`runClaude()` prompt/output pair when capture is enabled (see
`docs/dspy-prompt-analysis.md`); capture is opt-in/off by default, enable with
`CLAWS_PROMPT_CAPTURE=1` (or `true`), override the directory with
`CLAWS_PROMPT_CAPTURE_DIR`. AI provider model
mapping includes Codex (`codexDefaultModel`/`codexLightModel`/`codexCheapModel`),
OpenCode/OpenRouter tool-use tier (`opencodeBestModel`, `opencodeAdequateModel`, `opencodeCheapModel`),
OpenCode text-only tier (`opencodeTextBestModel`, `opencodeTextAdequateModel`, `opencodeTextCheapModel`)
defaulting to Qwen 2.5 Coder on OpenRouter, and Claude cheap tier (`claudeCheapModel`).
Provider fallback is controlled per-capability via `toolUseProviderFallbackOrder` (default
`["claude"]`) and `textOnlyProviderFallbackOrder` (default `["opencode"]`), plus
`providerRateLimitCooldownMs` for rate-limit circuit breaker timing.
Ollama integration is configured via `ollamaBaseUrl`, `ollamaTimeoutMs`, and
`ollamaConsecutiveFailuresBeforeDisable`. Whisper transcription is configured via
`whisperLocalUrl` (env: `CLAWS_WHISPER_LOCAL_URL`; default `http://127.0.0.1:9000` — a same-VM Whisper server, auto-installed by the updater along with `uv`/`uvx` and tried first; empty string disables it)
and `whisperBaseUrl` (env: `CLAWS_WHISPER_BASE_URL`; default `https://whisper.home.bstjohn.net` — a remote Whisper server, tried second; empty string disables it, leaving OpenAI as the only backend). `whisperModel` (env:
`CLAWS_WHISPER_MODEL`; default `Systran/faster-whisper-base`, matching `WHISPER__MODEL` in
`deploy/whisper.service`) is the model ID sent to self-hosted (local/remote) Whisper servers only —
the OpenAI fallback always sends OpenAI's own `whisper-1` alias regardless of this setting; the two
must not be conflated since a self-hosted faster-whisper server rejects `whisper-1` outright (#1931).
GitHub App authentication is
configured via `githubAppId`, `githubAppPrivateKeyPath`, and
`githubAppInstallationIds`. OIDC/SSO is configured via `oidcClientId`,
`oidcClientSecret`, `oidcBaseUrl`, `oidcApplicationSlug`, and
`oidcRedirectUri`. Per-repo job disabling is configured via
`disabledJobsByRepo` (a `Record<string, string[]>` mapping repo full names to
arrays of job names) and exposed via `isJobDisabledForRepo()` helper and
`DISABLED_JOBS_BY_REPO` export. `oidcClientSecret` and
`githubAppPrivateKeyPath` are in `SENSITIVE_KEYS` (masked in config UI).
`getUnknownConfigKeys()` returns a readonly list of keys present in `config.json`
that are not recognised by the schema (e.g. stale keys from old versions);
`removeConfigKeys(keys)` rewrites `config.json` without those keys and calls
`reloadConfig()`. Both are used by the config page to surface and clean up
unknown keys. Both `writeConfig()` and `removeConfigKeys()` write `config.json` with mode `0o600`
plus an explicit `fs.chmodSync(CONFIG_PATH, 0o600)` (the `mode` option is ignored when overwriting
an existing file, so the chmod is what actually tightens permissions on a pre-existing config.json) —
`config.json` holds plaintext secrets (Slack tokens, OIDC client secret, GitHub App private key path,
etc.), so it must not be left world-readable under the default umask (#1937). `activationState?: "verify-only" | "active"` controls whether the
instance runs jobs (`"active"`) or only performs connectivity checks
(`"verify-only"`). The exported `ACTIVATION_STATE` mutable variable and
`isActive()` helper are the runtime source of truth; `activationState` is
persisted to `config.json` via the **Activate** button or the
`CLAWS_ACTIVATION_STATE` env var. On first boot (no `claws.db`), the default is
`"verify-only"`; if `claws.db` already exists the loader auto-selects
`"active"` (so copying a populated data volume from systemd does not require a
manual flip). `BIND_HOST` (`CLAWS_BIND_HOST` env or `"0.0.0.0"`) controls the
interface the HTTP server listens on; required when Claws runs in a container.

**`scheduler.ts`** — Manages job lifecycle. Each job runs immediately on
startup, then repeats on its interval. If a prior run is still active, the
incoming tick is silently skipped (no queuing). Supports `scheduledHour` mode
(fires once daily at a specific hour) with optional `runOnStart` for jobs
that should also fire immediately at startup (e.g. repo-standards) and
optional `skipWeekends` to suppress Saturday/Sunday runs (manual triggers
bypass this). Exposes
`drain()` for graceful shutdown, `triggerJob(name)` for manual HTTP-triggered
runs, `updateInterval()` / `updateScheduledHour()` for live config
changes without restart, `pauseJob(name)` / `resumeJob(name)` for toggling
job execution via the dashboard, `jobScheduleInfo()` for exposing per-job
schedule metadata (interval or scheduled hour) to the dashboard, and exports
`msUntilHour()` for computing next-run countdowns. Paused jobs are
initialized from the `pausedJobs` config array on startup. Jobs can declare
a `triggers` array of downstream job names — when a run completes
successfully and produced tasks (checked via `getTasksByRunId()`), each
downstream job is triggered after a 10-second delay to allow GitHub
webhooks and CI status to propagate. Cascades terminate naturally when a
triggered run produces no tasks. Existing polling is preserved as fallback.

**`github.ts`** — All GitHub interaction via the `gh` CLI (never the HTTP API
directly). Wraps `execFile("gh", ...)` with exponential-backoff retry on
transient errors (400, 401, 500, 502, 503, 504, ETIMEDOUT, ECONNRESET, ECONNREFUSED, EAGAIN,
connection reset, "Could not resolve to a", "TLS handshake timeout",
"Something went wrong", "i/o timeout", "failed to create new OS thread", "resource temporarily unavailable", "unexpected EOF" — up to 3 attempts with 1s/2s/4s delays). The EAGAIN variants handle OS-thread exhaustion from Go-binary (`gh`, `git`) spawn failures under `TasksMax` cgroup pressure. The 401
retry handles transient GitHub OAuth token rotation — if the token is truly
revoked, all 3 retries fail and the error surfaces normally. Rate limit
errors are not retried — they trip a **circuit breaker** that blocks all API
calls for 60 seconds (throws `RateLimitError`). If a 5xx (`GH_SERVER_ERROR_RE`:
a literal `HTTP 500/502/503/504`) is still the failure after all retries are
exhausted, `gh()` rejects with `TransientGitHubError` instead of a plain
`Error` (#2036/#2039) — `error-reporter.ts` recognizes the type and logs a
warning rather than opening a `[claws-error]` issue, since the condition is
self-healing (the dispatcher retries the item on its next cycle). Includes GraphQL pagination for
resolved review thread filtering. Uses a generic `TTLCache` for API response
caching and in-flight request deduplication (PR lists, check status, issue
comments). Jobs populate a category-based queue cache via
`populateQueueCache()`, and the dashboard reads it via `getQueueSnapshot()`.
Categories: `ready`, `needs-refinement`, `refined`, `needs-review-addressing`,
`auto-mergeable`, `needs-triage`, `needs-qa`. `populateQueueCache()` accepts an
optional `labels?: string[]` field — issue-dispatcher, pr-dispatcher, and all other
callers pass `issue.labels.map((l) => l.name)` so labels are stored in the cache
entry and rendered on the queue page. `enrichQueueItemsWithPRStatus()` only
overwrites `item.labels` for `type === "pr"` — issue labels are preserved from
the cache. The queue cache has four correctness
invariants: (1) `populateQueueCache()` evicts any existing entry for the same
`(repo, number)` under a different category before writing the new one — preventing
stale categories from lingering after a state transition (e.g. `needs-refinement` →
`refined`); (2) `getQueueSnapshot()` performs TTL eviction on read, removing entries
older than `QUEUE_ENTRY_TTL_MS` (20 minutes — longer than the slowest dispatcher
interval so a single transient scan failure does not wipe the cache); (3) when the
same `(repo, number)` appears under multiple categories, deduplication keeps the
freshest entry (by `fetchedAt`), not the oldest; (4) after each dispatcher completes
a full repo scan, `reconcileQueueCache(repo, categories, populated, type)` evicts
entries in the categories that dispatcher owns whose item number was not populated
this cycle — removing items that closed, merged, or changed state on GitHub without
a tracked Claws transition (the `type` parameter keeps `issue-dispatcher` and
`pr-dispatcher` from clobbering each other's entries in the shared `"ready"` category;
reconciliation is skipped if the rate-limit circuit breaker fired mid-scan, since
`populated` would be incomplete). `oldestFetchAt` (the "last scanned"
banner on the queue page) is computed only over returned entries, not evicted ones.
The `listRepos()` function falls back to a
stale cache when the fresh fetch returns empty (transient failure protection).
Its underlying `fetchRepos()` filters to **private repos only** (`isPrivate` from the
installation-repositories API) in addition to skipping archived repos, so the whole
polling/dispatch pipeline ignores public repos (#1826). `listPublicReposIncludingArchived()`
is unaffected and still enumerates public repos for `public-repo-scanner`.
Provides `isItemSkipped()` and `isItemPrioritized()` helpers that check
items against the `skippedItems` and `prioritizedItems` config lists,
used by jobs to exclude or fast-track specific issues/PRs.
`findIssueByExactTitle(repo, title)` — exported helper that wraps `searchIssues` with an exact-title narrowing step (GitHub's search is substring-based; the helper returns `{ number, title } | null`). Replaces the duplicated `searchIssues(...).find(r => r.title === title)` pattern at four call sites (`ensureAlertIssue`, `ha-upgrader`, `bin-day-monitor`, `idea-collector`). Returns the narrowed result type `{ number: number; title: string } | null` — callers that previously used the raw search type are unchanged since `existing.number` and `existing.title` still type-check.
`isCiAlertBotAuthor(issue)` returns `true` for any issue authored by the GitHub
Actions runner bot (`github-actions[bot]` or `app/github-actions`, via
`CI_FAILURE_ALERT_BOT_LOGINS`). The issue-dispatcher uses this as its single bot gate:
any runner-authored issue is dispatched into the refine-and-fix pipeline regardless of
title — no title allowlist is needed. Other bots (dependabot, etc.) are not in
`CI_FAILURE_ALERT_BOT_LOGINS` and remain subject to the untrusted-actor notify/skip
path.
`isRepoPrivate(repo)` fetches repo visibility via `gh api repos/{repo} --jq .private`;
on non-rate-limit errors it defaults to `false` (safer for public-repo findings) — used
by `improvement-identifier` to suppress two classes of findings on private repos: (1)
fork-PR hardening recommendations (a private repo can't receive fork PRs from users
without write access, so untrusted fork code never runs on its runners), and (2)
findings whose only threat model is that GitHub-supplied issue/comment/PR text is
attacker-controlled or a prompt-injection vector — on a private repo only invited
collaborators can post that content, so it's trusted-party input, not anonymous
attacker input. This second carve-out does **not** extend to injection arriving via
other channels (webhooks, external HTTP, file contents, command output), which are
still reported normally regardless of repo visibility (#1874).
`listPublicReposIncludingArchived()` iterates `GITHUB_OWNERS`, calls `listInstallationRepositories(owner)` from
`github-app.ts`, filters to non-private entries, and returns `PublicRepoEntry[]` (includes `isArchived: boolean`);
archived repos are intentionally kept — this is the only enumeration path that covers them since `fetchRepos()`
skips archived repos; used exclusively by `public-repo-scanner`. Provides
`hasIgnoreLabel()` for the `Claws Ignore` label check, `skipItem()` for
programmatic auto-skipping, and `getDeploymentUrl()` for discovering preview
deployment URLs for QA — the Deployments-API path is only trusted when
`isSafeDeploymentUrl()` confirms the returned `environment_url` parses as an
`http:`/`https:` URL (rejecting `javascript:`/`data:`/malformed values before
the URL reaches the Playwright-equipped `qa-phase` agent prompt, #1945); the
Vercel-comment fallback is already regex-anchored to `https://…vercel.app` and
needed no change. `listCompareCommits(repo, base, head)` calls the GitHub
Compare API (`/repos/{repo}/compare/{base}...{head}`) and returns
`{ sha, subject }[]` (chronological, capped at 250 commits — pagination not
needed for typical deploy ranges); used by `ha-deploy-watcher` to format
per-commit Slack notifications. `listDuplicateIssuesOf(repo, canonicalNumber)` returns
all open issues labeled `Duplicate` whose comments contain the plain-text
`CLAWS_DUPLICATE_OF: #N` marker — used by issue-worker to add `Closes #N`
closing keywords for every duplicate when the canonical issue's last-phase PR
is created. (GitHub's search is substring-based, so legacy issues with the old
`<!-- claws-duplicate-of:N -->` HTML comment format are still matched.)
`getIssueBodyHtml(repo, issueNumber)` fetches the rendered `body_html` field
via `gh api repos/{repo}/issues/{number}` with `Accept: application/vnd.github.full+json` — this HTML contains pre-signed
`private-user-images.githubusercontent.com` URLs that are directly
downloadable, used by `processTextForImages()` to access private-repo images.
(Prior implementation used `gh issue view --json bodyHTML` which is not a valid
JSON field for that command and silently returned empty strings.)
`getIssueComments()` requests `Accept: application/vnd.github.full+json`
so each comment includes a `body_html` field alongside `body`. Provides
reaction helpers (`addReaction`, `addReviewCommentReaction`,
`getCommentReactions`).
All comments posted by Claws include a hidden `CLAWS_COMMENT_MARKER` and a
visible header. When an `agentName` is provided, the header shows
`*— Automated by Claws · <agentName> —*` (e.g., `· Planner ·`, `· CI Fixer ·`);
otherwise the default `CLAWS_VISIBLE_HEADER` is used. Helper functions
`isClawsComment()` / `stripClawsMarker()` handle attribution when processing
feedback. Comment
filtering uses `isClawsComment()` (marker-based) rather than self-login
comparison, ensuring correct behavior when the `gh` auth identity is the
same GitHub account as the human user. `hasValidLGTM()` accepts a
`baseBranch` parameter and filters out merge-from-base commits (e.g. from
ci-fixer resolving conflicts) so they don't invalidate an existing LGTM.
`getPRReviewComments()` skips bare "LGTM" issue-tab comments (approval
signals for auto-merger, not review feedback) and returns `PRReviewData`: an authority-structured
`formatted` string plus a `htmlBodies: string[]` array populated from `body_html` fields. All three
`gh api` calls (reviews, inline review comments, and issue-tab comments) use
`Accept: application/vnd.github.full+json` to receive `body_html`; the PR description's own HTML
is fetched once at the top of the function and prepended to `htmlBodies`. `htmlBodies` is accumulated
in parallel with the text `formatted` string — every body that contributes a line to `formatted` also
contributes its `body_html` to `htmlBodies`. The review-addresser passes `reviewData.htmlBodies` as
the fifth argument to `processTextForImages()` so the image pipeline prefers pre-signed
`private-user-images.githubusercontent.com` URLs (mirroring the fix applied to the issue path in
#1135). Human review comments (top-level reviews, inline review comments, and human issue-tab
comments) appear under `=== HUMAN REVIEWER COMMENTS (AUTHORITATIVE — must be followed) ===`; the
single Claws `## PR Review` comment (when present and non-clean) appears under
`=== AUTOMATED CLAWS REVIEW (advisory — defer to human directives above when they conflict) ===`;
other Claws comments with human 👍 approval appear under a third section. Empty sections are omitted
entirely. This structure lets the review-addresser reliably distinguish owner directives from
automated suggestions — human instructions win any conflict. `getPRCheckStatus()` returns
four states: `"passing"`, `"failing"`, `"pending"`, or `"none"` (no checks
exist at all — used by auto-merger to distinguish doc-only PRs that skip CI
from PRs with in-progress checks). Check status strings returned by different GitHub APIs use different casing (GitHub Actions returns uppercase `"FAILURE"`, `"SUCCESS"`, etc.; Statuses API uses lowercase). `normalizeCheckState(s)` (`s.toUpperCase()`) normalises all values before membership tests against `FAILED_STATES` and `PASSING_STATES` sets — applied at four call sites: `getPRCheckStatus`, `getPRChecksSummary`, `getFailingCheck`, and `getFailedRunLog`. The original cased values are preserved in returned objects; only comparisons are normalised.
`getRunAnnotations(repo, runId)` fetches job annotations for a completed workflow run (paginates job IDs, then fetches per-check-run annotations). `isBillingBlocked(annotations)` checks the annotation messages against `BILLING_ANNOTATION_PATTERN` to detect GitHub Actions spending-limit blocks. The ci-fixer calls both before deciding to rerun a failed workflow — billing-blocked runs are skipped (with a `Billing` label applied) rather than rerun.
`getPRMergeableState()` polls up to 5
times (3-second intervals) when GitHub returns `"UNKNOWN"` — a transient state
GitHub sets while computing the merge commit; the auto-merger skips the PR if
`"UNKNOWN"` persists after all retries, and re-processes it on the next cycle. `getIssueState()` returns
`state` and `stateReason` for an issue, used by idea-reconciler to detect
issues closed without implementation. `editIssue()` edits an issue's body
in place (used by k3s-monitor to update occurrence tracking without posting
new comments).
`fetchRepoCacheUsage(repo)` fetches cache usage via `GET /repos/{repo}/actions/cache/usage`
(returns `{ bytes, count }`; tolerates 404 as zero). `fetchRepoArtifactUsage(repo)` paginates
`GET /repos/{repo}/actions/artifacts` using `--paginate --jq` (one JSON object per line) and
sums non-expired artifact sizes. `fetchRepoStorageUsage(repo)` combines both into a
`RepoStorageUsage` object (`{ repo, cacheBytes, cacheCount, artifactBytes, artifactCount,
oldestArtifactAt }`). Used exclusively by `actions-storage-monitor`.
`fetchRepoFileContent(repo, path)` fetches a file's contents via `GET /repos/{repo}/contents/{path}` and base64-decodes the response; returns `null` on 404/403/missing file. Used by `dependabot-alert-monitor`'s manifest-pin staleness pass.
`DependabotAlertsPermissionError` — named error class thrown by `listOpenDependabotAlerts` when the GitHub App lacks the `dependabot_alerts: read` permission (HTTP 403 "Resource not accessible by integration"); distinct from the 404 / "disabled" case (which returns `[]` silently, per-maintainer guidance to leave repos with scanning disabled as-is). The permission-check must come before the 404 swallow in the catch block to avoid misclassifying permission failures as "no alerts". `listOpenDependabotAlerts(repo)` returns up to 100 open alerts (no pagination; caller warns on exact-100 result) as typed `DependabotAlert[]`. `dismissDependabotAlert(repo, number, reason, comment)` sends `PATCH /repos/{repo}/dependabot/alerts/{number}` with `state=dismissed` and the provided `dismissed_reason` (required by GitHub — defaults to `"inaccurate"` for stale-version dismissals). `fetchRepoSbomPackages(repo)` fetches the SPDX 2.3 dependency graph via `GET /repos/{repo}/dependency-graph/sbom`, strips the `<manager>:` prefix from each package name, and lowercases the remainder; tolerates 403/404/disabled by returning `[]`. Used by `dependabot-alert-monitor` to compare patched versions against the SBOM and dismiss alerts whose fixed version is already present in the graph.

**`github-app.ts`** — GitHub App authentication (required). Supports two
credential modes: **global** (`githubAppId` + `githubAppPrivateKeyPath`) and
**per-owner** (`githubOwnerAppCredentials`, a `Record<string, OwnerAppCredential>`
mapping owner names to `{appId, privateKeyPath, installationId?}`). Per-owner
credentials take priority over global credentials (useful when different GitHub
organisations use different Apps). `ensureGitHubAppConfigured()` is the startup
validator — called early in `main.ts`, it checks per-owner credentials first,
then global credentials, and throws with a clear message if neither resolves.
`isGitHubAppEnabled()` is retained as a vestigial always-true accessor for
callers that haven't been simplified yet. When configured, the module signs RS256
JWTs (cached, 9-minute expiry), resolves installation IDs per-owner (via org or
user installation endpoint, configurable override via `githubAppInstallationIds`),
and mints short-lived installation tokens (cached with 10-minute expiry
buffer, concurrent refresh deduplication). `getInstallationTokenForOwner(owner)`
returns a valid token or throws; `getAnyInstallationToken()` walks `GITHUB_OWNERS`
and returns the first success or throws. `buildEnvForGh(token)` produces an env
with `GH_TOKEN` and `GITHUB_TOKEN` set; `buildEnvForGhGit(token)` additionally
injects a one-shot inline credential helper via `GIT_CONFIG_COUNT/KEY/VALUE`
env vars so authenticated git pushes/fetches use the installation token
without mutating git global config. `listInstallationRepositories(owner)`
paginates the installation repositories endpoint with up to 3 retry attempts on
transient network failures (DNS, ECONNRESET, ETIMEDOUT) via the module-level
`isRetryableFetchError()` helper — which inspects `err.message` and `err.cause`
since raw `fetch()` wraps the underlying cause. The token is re-fetched inside
each retry body (safe because `getInstallationTokenForOwner` caches tokens).
`InstallationRepoEntry` includes an `isPrivate: boolean` field (from `r.private` in
the raw GitHub API response) — used by `listPublicReposIncludingArchived()` to filter
to public repos only; `fetchRepos()` ignores this field and existing behavior is unchanged.
PRs and comments posted by
Claws appear under the App bot identity. `extractOwnerFromGhArgs()`
parses a `gh` argv array to determine which owner's token should be injected,
enabling per-call token scoping. `resetGitHubAppState()` clears all caches
(called on config reload).

**`sessions.ts`** — Interactive PTY session manager. Each session is wrapped in
a detached `tmux` session (`claws-<id>`); the `node-pty` process that the
WebSocket bridges to is a `tmux attach-session` client. This lets sessions
survive Claws service restarts: the tmux server lives outside Claws's cgroup
(enabled by `KillMode=process` in the systemd unit). All tmux invocations use
`-L claws` (the `TMUX_SOCKET = "claws"` constant) to isolate Claws sessions to
a named socket, keeping them separate from any user tmux server and allowing the
socket to survive cgroup OOM kills that target claude child processes first. On startup,
`recoverSessions()` reconciles the `sessions` SQLite table with live tmux
sessions and re-attaches a fresh bridge for each survivor (with scrollback
seeded from `tmux capture-pane`). After reconciling, it also sweeps for stray
`claws-*` tmux sessions: any on the `claws` socket with no DB row is killed
(crash between tmux-create and DB-insert leaves such leaks), and any on the
default tmux socket is killed (claws never creates on the default socket, so
any match is a leak from an older build or manual session). **Capability-based env gating** (via `capabilities.ts`): sessions are default-deny for gated secrets. `createSession` and `createMultiWorktreeSession` accept a `capabilities: string[]` parameter (selected IDs from the `CAPABILITIES` registry). Granted capabilities inject their resolved env vars; all other gated keys (`HOME_ASSISTANT_BASE_URL/TOKEN`, `NAMEY_DB_URL`, `KUBECONFIG`) are stripped with `env -u` before the claude process is spawned (`NAMEY_DB_URL` is stripped only as a baseline sensitive key now — no capability grants it since `namey-db` was removed; the `namey_query` MCP tool self-disables when it's unset). When at least one capability is granted, `--append-system-prompt` is appended with a brief description of each granted capability (via `buildCapabilityPrompt`); when nothing is granted, the flag is omitted. The `capabilities` column in the `sessions` DB table (JSON array of selected IDs) persists the selection so `resumeSession` can re-apply the same env grant and system-prompt injection. The session-create UI exposes checkboxes for all currently-available capabilities (those whose backing config is non-empty). `prod-infra` and `fleet-infra` grant `KUBECONFIG` — when both are selected, the two kubeconfig paths are colon-joined so kubectl can address both clusters. The eight `ssh:<alias>` capabilities (#1985) are always available (they resolve to `{}` regardless of config) and always appear in the checkbox list; granting one injects no env var, it only adds the host to `buildCapabilityPrompt`'s description of what the session may do.
`createSession(repo, mode)` supports five modes (exported as `SESSION_MODES`):
`repo-zsh` (zsh in the repo's main clone), `repo-claude` (claude in the repo's
main clone), `worktree-claude` (claude in a fresh worktree), `home-claude`
(claude in `$HOME`, no repo required), and `multi-worktree-claude` (multi-repo —
must be created via `createMultiWorktreeSession`, not `createSession`).
`createMultiWorktreeSession(repos: string[])` (requires ≥ 2 repos) creates a
fresh worktree for each repo, runs Claude in the first repo's worktree, and
passes additional worktree paths via `--add-dir <path>` so Claude can
read/write across all of them in one session. The primary worktree/repo is
stored in the existing `repo`/`worktreePath`/`cwd` DB columns; additional ones
are stored as JSON in a new `extra_worktrees` column and surfaced via
`session.extraWorktrees: Array<{ repo: string; worktreePath: string }>`.
Initiated via `POST /sessions/create-multi`.
**Session resume**: When a tmux session exits normally (process finishes), the
session row and in-memory entry are kept rather than deleted, and `session.resumable`
is set to `true`. `resumeSession(id)` recreates worktrees at the same deterministic
path (`claws-wt/<id>`) so `claude --continue` finds the path-keyed conversation
history preserved in `~/.claude/projects/`. For `repo-claude`/`home-claude`/`repo-zsh`
modes the cwd is a stable main clone / `$HOME` and is never deleted, so resume just
relaunches tmux there. `session.resumeRepos: string[]` stores the repo list needed to
reconstruct worktrees (set before cleanup in the bridge-exit handler). Sessions that fail
their bridge (respawn) or are killed manually are not marked resumable and are reaped by
the 60-second reaper normally. Accessible via `POST /sessions/:id/resume`.
Before opening any repo-backed session
(`repo-zsh`, `repo-claude`, `worktree-claude`), `ensureClone()` is called to
fetch the latest remote state; failures surface as `"fetch-failed"` (a
`CreateSessionError` variant). Path traversal is guarded by verifying the
resolved `cwd` starts with `~/.claws/repos/` when a repo is specified. No hard
cap on concurrent sessions; `createSession` returns a `{ ok, reason }` result
and failures (shutdown, bad mode/repo, fetch failure, tmux/worktree errors)
surface a specific reason to the caller. No idle timeout — sessions
persist until explicitly killed. `session.scrollback` retains up to 50,000
bytes of recent output for reconnect. Immediately after a tmux session is created
(and again during `recoverSessions()` for pre-existing sessions), mouse mode is
enabled via `tmux set-option -t =<name> mouse on` — this forwards xterm.js wheel
events to tmux's copy-mode for scroll, fixing desktop terminal scrolling. Failures
to set mouse mode are logged at warn level and do not abort session creation.
`listSessions()`, `killSession(id)`, and `disconnectAllSessions()` manage
lifecycle; `disconnectAllSessions()` is called from `server.ts` on server close
and only tears down PTY bridges (tmux sessions keep running). Sessions are
accessible via WebSocket at `/sessions/:id/ws`. Each session is summarized shortly after it accumulates ≥80 chars of scrollback, via `summarizeSession()` (a 30-second poll retries un-summarized sessions until they have enough output). A non-idle summary is then frozen for the session's lifetime, but an idle placeholder (`isIdlePlaceholder()` matches `"Idle at shell prompt"` / `"Idle at Claude prompt"`) is re-summarized once `session.lastActivity` advances past the summary's timestamp, and any idle-sounding model output is deterministically collapsed to one of those two canonical repo-free strings rather than left as free text (#1884). The call pins `provider: "claude"` (text-only, `sonnet` tier) for reliability, mirroring `classify-complexity.ts`.

**Session history**: when a session's tmux process exits, `recordSessionEnded()` persists it as a terminated-but-browsable row (`sessions.ended_at` set, `resume_repos` JSON storing the repo list needed to reconstruct worktrees) instead of deleting it outright. `listEndedSessions()` returns up to `MAX_ENDED_SESSIONS` (50) most-recent ended sessions, pruned oldest-first via `pruneEndedSessions()`; `getEndedSessions`/`markSessionEnded`/`clearSessionEnded` (`db.ts`) back this. The sessions page merges ended sessions (filtered against still-live IDs) alongside live ones (#1883). `reconstructEndedSession()` rebuilds a `Session` object from the DB row on demand — its `pty` field is left as an unused placeholder until `resumeSession` attaches a live bridge, so code reading `session.pty` must not assume it is set for a reconstructed-but-not-yet-resumed session. `deleteSession` (`POST /sessions/:id/delete`) permanently removes an ended session's row.

**`claude.ts`** — Git worktree helpers and Claude/Codex/OpenCode CLI runner. Key exports: `ensureClone`, `createWorktree`,
`createWorktreeFromBranch`, `createWorktreeFromBranchIfExists`, `removeWorktree`,
`withNewWorktree` (create + try/finally cleanup in one call), `withExistingWorktree`
(same but returns `null` if branch is gone), `attemptMerge`, `pushBranch`,
`generatePRDescription`, `generateDocsPRDescription`, `regeneratePRDescription`,
`readRepoAgentDoc(wtPath, role)` — reads a repo's `.claude/agents/<role>.md` from a worktree, strips YAML frontmatter, and returns the body for injection via `RunClaudeOptions.appendSystemPrompt`; agents use this to load their corresponding per-repo doc (role mapping: `issue-refiner` → issue-refiner.md, `issue-implementer` → issue-implementer.md, `pr-reviewer` → pr-reviewer.md). Missing files return `undefined` (graceful no-op). `ensureClone` (exported) clones a repo on first use and on subsequent calls
runs `git fetch --all --prune` followed by `git checkout origin/<defaultBranch>
--force` to refresh the main clone's working directory — this ensures any code
reading directly from the main clone (e.g. ubuntu-latest-scanner) sees the
latest remote state. The `git()` helper wraps `execFile("git", ...)` with
exponential-backoff retry (up to 3 attempts, 1s/2s/4s) on transient network
errors (HTTP 5xx, ETIMEDOUT, ECONNRESET, ECONNREFUSED, TLS handshake timeout,
DNS failures). The separate `gitRaw()` helper returns `{ code, stdout, stderr }`
without throwing or retrying — callers like `pushBranch` and `attemptMerge`
manage their own error handling. The queue rejects new tasks when the system is
shutting down (via `shutdown.ts`, throwing `ShutdownError`). Active child
processes are tracked for signal-based cancellation: `cancelCurrentTask()` kills
the most-recently-spawned process (used by shutdown and the `/cancel` endpoint),
while `cancelTaskByRunId(runId)` kills all child processes for a specific job run
(used by the `/logs/:runId/cancel` dashboard endpoint). The `activeRunChildren`
map (`Map<string, Set<ChildProcess>>`) tracks which children belong to each run ID
by reading `runContext.getStore()` (AsyncLocalStorage from `log.ts`) at spawn time
— entries are cleaned up in the `"close"` and `"error"` handlers.
Concurrent clones to the same repo are deduplicated.

**Multi-provider backend:** `RunClaudeOptions` requires a `capability` field
(`"tool-use"` or `"text-only"`) — every call site must declare whether the
workflow needs tool calling (file edits, git, gh) or only text generation. The
options also accept an optional `provider` field (`"claude"`, `"codex"`, or
`"opencode"`) and an optional `agent` field (`"plan"` or `"build"`, passed to
OpenCode via `--agent`). The `runClaude()` function implements a **capability-aware
provider fallback loop**: it walks the capability-specific fallback order
(`TOOL_USE_PROVIDER_FALLBACK_ORDER` or `TEXT_ONLY_PROVIDER_FALLBACK_ORDER`) —
explicit provider first if pinned, then remaining entries — skipping any that are
currently rate-limited (circuit breaker). On failure,
`ollama-rate-limit-classifier.ts` determines whether the error is a rate limit;
confirmed rate limits mark the provider as unavailable for `providerRateLimitCooldownMs`.
The `onProviderUsed` callback lets callers track which provider was actually used
(for DB persistence and attribution). The `onTokensUsed` callback reports token count and cost when the provider exposes usage data: Claude CLI extracts `total_cost_usd` and sums the four `usage.*` fields from its JSON output; OpenCode and OpenRouter direct extract token/cost from their NDJSON event streams; Codex CLI does not expose usage data and never fires `onTokensUsed`. All agent call sites (issue-worker, issue-refiner, ci-fixer, review-addresser, pr-reviewer, and problematic-pr-diagnoser) capture the callback result and write it to the DB via `db.updateTaskTokenUsage()`. `runClaudeOnce()` dispatches to
`runClaudeCliOnce()` (Claude CLI), `runCodexOnce()` (OpenAI Codex CLI), or
`runOpenCodeOnce()` (OpenCode CLI with `OPENROUTER_API_KEY` env). Claude is invoked via
`spawn("claude", ["-p", "--dangerously-skip-permissions", "--output-format", "json"])`
while Codex uses `spawn("codex", ["exec", "--dangerously-bypass-approvals-and-sandbox"])`
and OpenCode uses `spawn("opencode", ["--no-tui", "--format", "json"])`.
All three receive the prompt on stdin. OpenCode `--format json` produces an NDJSON
event stream (events: `text`, `error`, `step_finish`) parsed to extract output,
detect errors, and capture token usage. Claude uses `--output-format json` for
structured output parsing. Codex output is plain text.
MCP config is not passed to Codex/OpenCode sessions.
The `agent` field maps to OpenCode's agent types: analysis/review tasks use
`agent: "plan"` (issue-refiner, pr-reviewer), code generation tasks use
`agent: "build"` (issue-worker, ci-fixer, review-addresser).

**Env sanitization:** `RunClaudeOptions.envSanitization` (`"strict" | "passthrough"`) controls whether `sanitiseEnvForChild()` strips `SENSITIVE_ENV_KEYS` (HA token, `NAMEY_DB_URL`, `CLAWS_AUTH_TOKEN`, `CLAWS_OIDC_CLIENT_SECRET`, Slack tokens/webhook, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, Gmail app password, etc.) from the spawned child's environment before it inherits `process.env`. It defaults to `"strict"`. `SENSITIVE_ENV_KEYS` must be kept in sync with whatever env var name `config.ts`'s `loadConfig()` actually reads for each secret — the list previously carried `CLAWS_SLACK_WEBHOOK_URL` while the loader read `CLAWS_SLACK_WEBHOOK`, and omitted `CLAWS_OIDC_CLIENT_SECRET` (the dashboard session-cookie HMAC key) entirely, so both leaked into every strict-mode child until fixed (#1859); a name in the list that no loader reads is silently a no-op, not a caught error. Every `capability: "tool-use"` call site (planner, issue-worker, ci-fixer, review-addresser) runs strict — a `"passthrough"` override on these was removed (#1840) because it handed a Bash/git-capable agent every production secret while processing untrusted GitHub issue/PR/comment content, and the one legitimate need (Home Assistant access) is already served out-of-band by the `ha_list_entities`/`ha_api_request` MCP tools (`writeClawsMcpConfig()` writes the HA token into the MCP server's own env regardless of the child's sanitization mode). LLM provider credentials survive strict mode too: `runCliProcess` layers the backend's own `env` back on top of the sanitised env, so `OPENROUTER_API_KEY` reaches OpenCode/OpenRouter even after stripping. `qa-phase.ts` remains `"passthrough"` because it needs ambient auth to reach a live preview deployment via Playwright. `pr-reviewer.ts`'s three `runClaude` calls were flipped from `capability: "text-only"` to `"tool-use"` (#1879, so the reviewer can verify git facts — diff, blame, file contents — before asserting them, rather than trusting the PR description) **but their `envSanitization` was left at `"passthrough"`**, making pr-reviewer the exception to the "every tool-use site runs strict" rule above. Since `capability` never actually gated tool availability on the Claude CLI (see Gotcha below), this was not a new hole opened by #1879 — the reviewer always had real Bash/git/file access in the PR's worktree while processing untrusted, guarded-but-still-model-visible PR/issue/comment content — but it does mean pr-reviewer is now the only *labelled* `tool-use` site that still runs with ambient production secrets (Slack tokens/webhook, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `NAMEY_DB_URL`, `CLAWS_AUTH_TOKEN`, `CLAWS_OIDC_CLIENT_SECRET`, Gmail app password) in its child env. Anyone hardening the strict/passthrough split further should treat this as the next site to reconcile.
This automated-`runClaude` sanitization is separate from interactive-session env stripping: `sessions.ts`
never calls `sanitiseEnvForChild()` directly, but `capabilities.ts`'s `buildCapabilityEnvArgs()` (called
by `createSession`, `createMultiWorktreeSession`, and `resumeSession`) always strips the same
`SENSITIVE_ENV_KEYS` set in addition to any ungranted capability keys, so a zero-capability interactive
session gets the same baseline protection as a strict-mode automated child (#1944/#1947 — previously
interactive sessions inherited these secrets unconditionally, since `buildCapabilityEnvArgs()` only
stripped the four capability bundles' own env keys).

**Gotcha:** `capability` (`"tool-use" | "text-only"`) is a **routing** hint, not a tool-access gate, when `provider: "claude"` is in play — the Claude CLI is always invoked with the same tool schemas (Bash, Read, Edit, …) regardless of the declared capability; `capability` only selects the model tier (`model-selector.ts`) and which provider fallback order applies. A prompt that needs an actual no-tools guarantee cannot rely on `capability: "text-only"` alone if the resolved provider is `"claude"` — it must either pin a provider that genuinely lacks tool schemas or avoid tool-shaped instructions in the prompt itself (#1876).

An optional model flag is appended when the caller passes a `model`
option (`--model` for Claude CLI, `-m` for Codex CLI). For Claude, the `--output-format json` flag enables structured
output parsing: on completion, `runClaudeCliOnce()` parses the JSON response and
checks the `is_error` boolean. If `is_error` is `true`, or if the CLI outputs
non-JSON (e.g. a usage-limit message), the process rejects with `AgentCliError`
— this prevents error text from being treated as real work output and posted as
PR comments or triggering false reactions. `AgentCliError` carries the
`exitCode`, a truncated (500 char) message, and an optional `numTurns`
property (extracted from parsed JSON output). Three PR description functions exist:
`generatePRDescription()` (issue + diff → PR body for issue-worker),
`generateDocsPRDescription()` (diff-only → PR body for doc-maintainer), and
`regeneratePRDescription()` (full diff → updated body after ci-fixer or
review-addresser pushes; preserves any `Closes #N` / `Part of #N` closing
keywords from the original body so issue auto-close links are not lost).
All use three-dot diff (`origin/base...HEAD`) to
isolate branch changes from concurrent main-branch movement. `pushBranch()`
uses a **fetch-rebase-push retry loop** (up to 3 attempts) to handle
concurrent pushes to the same branch — when a non-fast-forward rejection
occurs, it fetches the latest remote state, rebases local commits on top,
and retries. If the branch doesn't exist on the remote yet (new branches),
the fetch is skipped and push proceeds directly. Rebase conflicts (and their
fallback merge conflicts) abort with `PushConflictError` — a named class
suppressed by the error reporter (logged at warn, no `[claws-error]` issue) since
this is a transient race resolved on the next dispatcher cycle. Each Claude process has a configurable **timeout**
(`CLAUDE_TIMEOUT_MS`, default 6 hours) — on expiry, SIGTERM is sent with a
10-second SIGKILL escalation. Per-item timeout overrides can escalate this
for items that have timed out before (see `timeout-handler.ts`). A **spawn
log line** records PID, working directory, and effective timeouts at process
start for post-mortem analysis. A 5-minute **heartbeat** logs PID, elapsed
time, and stdout byte count for observability.
A configurable **liveness abort** (`claudeLivenessTimeoutMs`, default 6
hours) kills processes that produce zero stdout bytes early, and `runClaude`
automatically retries once on 0-byte timeouts (transient hang recovery).
Timed-out processes throw `AgentTimeoutError` (carries diagnostic fields:
`lastOutput`, `lastStderr`, `outputBytes`, `cwd`) which the error reporter
includes in GitHub issue reports. `writeClawsMcpConfig()` generates MCP
configuration files that give Claude sessions access to the Claws MCP server
(operational state) and optionally additional MCP servers (e.g. Playwright
for QA); the generated `.mcp-claws.json` is written with mode `0o600` (plus an
explicit `chmodSync` to tighten a pre-existing file, since `mode` is ignored on
overwrite) since it can carry secrets such as the Home Assistant token (#1937).

**`db.ts`** — SQLite database at `~/.claws/claws.db`. Fifteen tables: `tasks`
(tracks every job invocation, linked to `job_runs` via `run_id`), `job_runs`
(tracks scheduled job executions), `job_logs` (captures log output per run
via `AsyncLocalStorage` context), `queue_snapshots` (hourly queue depth
snapshots for trend visualization), `workflow_runs` (GitHub Actions
workflow run data synced by `runner-metrics-sync` for runner utilization
analytics — indexed by repo, status, and created_at), `whatsapp_events`
(append-only log of WhatsApp connection state transitions, keyed by
`event_type` values: `connected`, `disconnected`, `restart-required`,
`connection-replaced`, `logged-out`, `auth-cleared`, `message-received`,
`pairing-required`; readable via `GET /whatsapp/events`), `sessions`
(persisted PTY session records — `id`, `tmux_name`, `mode`, `repo`, `cwd`,
`worktree_path`, `extra_worktrees` (JSON array of additional worktrees for
`multi-worktree-claude` sessions), `capabilities` (JSON array of selected capability IDs — persisted so `resumeSession` re-applies env gating and system-prompt injection), `created_at`,
`ended_at` (set when a session's tmux process exits — retains the row as browsable
history instead of deleting it), `resume_repos` (JSON array of repos needed to
reconstruct worktrees for an ended session, see "Session history" above); reconciled with live tmux sessions on startup),
`verification_reports` (connectivity check results written by
`runConnectivityVerification()` — stores a JSON `payload` with per-check
pass/fail results indexed by `ts`; latest row retrieved by `GET /api/activation`
and rendered on the `/verify` page), `work_queue` (SQLite-backed agent dispatch
queue — one row per pending/running/completed agent task; `kind` maps to
`AGENT_KINDS` constants in `worker.ts`; a UNIQUE partial index on
`(kind, repo, item_number) WHERE status IN ('queued', 'running')` is the
idempotency guard preventing double-dispatch; `enqueueWork()` returns `alreadyQueued: true`
on a silent no-op; `claimNextWork()` atomically claims the highest-priority oldest
`queued` row; `recoverWorkOnStartup()` resets stuck `running` rows to `queued`
on restart; `pruneWorkQueue()` deletes completed/failed rows older than 7 days),
and `processed_repos_daily` (smart-scheduling daily per-repo ledger —
primary key `(job_name, repo, local_date)`; `markRepoProcessedDaily()` inserts via
`INSERT OR IGNORE`; `getReposProcessedOn()` returns the processed set for a given
job/date; `getLastProcessedTimestampsForJob()` returns a `Map<repo, epoch-ms>` of most-recent
processing timestamps for fairness-based sorting; rows older than 7 days are
pruned by `pruneProcessedReposDailyOlderThan()`), and `ha_upgrader_state` (one row per
observed HA update entity — tracks `first_seen_at`, `attempted_at`, `failure_count`;
`getAllHaUpgraderStates()` returns all rows for the `/ha-upgrader` dashboard page),
and `ha_deploy_watcher_state` (one row per addon slug — tracks `last_notified_sha`
and `last_seen_at`; used by `ha-deploy-watcher` to deduplicate Slack notifications
across restarts), `notified_untrusted_actors` (durable dedup table for
untrusted-actor Slack notifications — primary key `(repo, issue_number)`;
`markUntrustedActorNotified(repo, issueNumber)` uses `INSERT OR IGNORE` and returns
`true` on the first notification for a given issue, `false` on subsequent calls;
survives process restarts, preventing re-notification on the same blocked item after
a Claws restart), and `damp_readings` (#1819 — one row per logged damp-meter
reading: `location`, `point`, `value` (REAL), `reading_date` (`YYYY-MM-DD`), and
`recorded_at` (full ISO timestamp); indexed on `(location, point)` and on
`reading_date DESC`; `upsertDampReading()` writes a row, `getRecentDampReadings(limit=200)`
returns the most recent rows across all points for the `/damp` history table, and
`getDampTrendRows()` returns every row ordered by `(location, point, reading_date DESC,
recorded_at DESC)` so `pages/damp.ts` can pick the two most-recent rows per point to
compute a trend delta; `initDb()` seeds one idempotent backfill row — `("Hall Closet",
"utility", 0.5, "2026-07-02", ...)` — guarded by a `COUNT(*) = 0` check, since that
point (#1824) was added to `DAMP_POINTS` after the other points' first readings had
already been logged through the UI), and `blog_drafts` (#1849 — one row per
in-progress blog post edit, primary key `(repo, path)`; `content`, `base_sha`
(the GitHub content SHA the draft was based on, used as the base for `putRepoFile()`'s
optimistic-concurrency check), `title` (parsed from the frontmatter `title:` field),
`status` (`'draft' | 'pushed'`), `pr_number`/`pr_branch` (set once pushed);
`upsertBlogDraft()` resets `status` back to `'draft'` on every re-save while leaving
`pr_number`/`pr_branch` untouched, so a subsequent push (#1953) commits onto the
existing PR's branch rather than opening a duplicate PR; `clearBlogDraftPR(repo, path)`
nulls the PR pointer and resets `status` to `'draft'` when the recorded PR turns out
to be closed/merged/deleted, so the next push falls back to opening a fresh PR;
`listBlogDrafts(repo)` orders by `updated_at DESC` for the `/blog` list page).
`updateTaskTokenUsage(taskId, tokensUsed, costUsd)` writes token and cost data into `tasks.tokens_used` / `tasks.cost_usd`. `trackTaskTokens(taskId)` returns an accumulating `onTokensUsed` callback bound to `taskId` — reusable across multiple `runClaude` calls for one task (e.g. triage-claws-errors and pr-reviewer each call `runClaude` 2–3 times per item); accumulates totals and writes the running sum on every invocation via `updateTaskTokenUsage`, so partial accounting is preserved if a later call throws. Used by all agent call sites: review-addresser, issue-worker, ci-fixer, issue-refiner, problematic-pr-diagnoser, idea-suggester, improvement-identifier, doc-maintainer, qa-phase, and public-repo-scanner. `getUsageStats(days)` and `getTotalUsage(days)` aggregate token/cost data over a configurable time window, returning `UsageStats` (breakdowns by repo, job, and provider+model, all sorted by cost descending) and `UsageTotals` (overall counts). Job names are normalised with the same colon-prefix-stripping pattern as `getAllAverageTaskDurations` so `ci-fixer:revert` rolls up with `ci-fixer`. See [Database Schema](database-schema.md).
`completeJobRun(runId, status)` accepts `"completed" | "failed" | "cancelled"`
and includes `AND status != 'cancelled'` in its SQL — this prevents the
scheduler's error handler from overwriting a `"cancelled"` status with `"failed"`
after SIGTERM. `cancelJobRunIfRunning(runId)` atomically sets status to
`"cancelled"` only when the current status is `"running"` (returns `true` if the
row was updated); used by the `/logs/:runId/cancel` endpoint to record
cancellation before sending SIGTERM, so the SQL guard in `completeJobRun` takes
effect.

**`server.ts`** — HTTP server built on the **Hono** framework (via `@hono/node-server` adapter). The public interface is unchanged — `createServer(scheduler)` still returns a native `http.Server`. WebSocket support uses `@hono/node-ws`. Auth middleware (`requireAuth`, `requireApiAuth`) is implemented as Hono `MiddlewareHandler` and applied per route group (not globally). `apiAuthMiddleware` (applied to `/api/state`) accepts: (1) `INTERNAL_MCP_TOKEN` Bearer unconditionally (loopback/MCP), or (2) a valid `claws_session` cookie when OIDC is enabled. There is no operator-token fallback — every other request returns 401. Routes:

- `GET /` — Dashboard: job status with Last Run/Next Run columns, "Run" buttons, queue overview, integrations status (Slack, Slack Bot, WhatsApp, Email)
- `GET /health` — JSON health check
- `GET /status` — JSON with jobs (including `jobSchedules` with per-job `nextRunIn` countdowns), uptime, queue, integrations (slack, slackBot, whatsapp, email)
- `GET /api/state` — JSON queue state for MCP server consumption (requires API auth)
- `GET /login` — Redirects to authentik's authorization endpoint when OIDC is configured; returns 503 otherwise
- `GET /auth/callback` — OAuth2 OIDC callback — exchanges code, fetches userinfo, issues signed session cookie
- `POST /trigger/:job` — Manual job trigger (returns 200/409/404)
- `POST /pause/:job` — Toggle pause/resume for a job
- `POST /cancel` — Cancel current Claude task
- `GET /queue` — Work queue page; within each section items are sorted flat: all open PRs first (by `updatedAt` desc), then all open issues (by `updatedAt` desc); each item shows an inline per-item category badge (reusing `CATEGORY_DISPLAY` colors) in place of the old category-group headers; also shows CI status, squash & merge, queue position + ETA estimates; includes a "Refresh from GitHub" button
- `POST /queue/refresh` — Triggers `issue-dispatcher` and `pr-dispatcher` to rescan GitHub immediately; returns `{ results: Record<string, string> }` (values: `"started"`, `"already-running"`, `"draining"`, `"unknown"`); always 200 — `"already-running"` is benign (scan already in flight)
- `POST /queue/merge` — Squash-merge a PR from the queue page
- `POST /queue/skip` — Skip an issue/PR (excluded from all job processing)
- `POST /queue/unskip` — Remove skip for an issue/PR
- `POST /queue/prioritize` — Prioritize an issue/PR (processed first)
- `POST /queue/deprioritize` — Remove priority for an issue/PR
- `POST /queue/mark-refined` — Apply `Refined` label to an issue in the `ready` or `needs-refinement` queue category; removes it from the queue cache. The "Refined" button is suppressed in the rendered HTML when the issue already carries the `Refined` label (checked via `item.labels?.includes(LABELS.refined)`) to prevent duplicate label application.
- `GET /logs` — Log viewer with per-job filtering and item search
- `GET /logs/:runId` — Individual run detail page with task list
- `POST /logs/:runId/cancel` — Cancel a running job: atomically marks the run `"cancelled"` via `cancelJobRunIfRunning()`, sends SIGTERM to its child processes via `cancelTaskByRunId()`, and returns `{ result: "cancelled" | "not-running" }`
- `GET /logs/:runId/tail` — Live log tail (JSON, polls for new entries)
- `GET /logs/issue` — Issue-specific logs page (`?repo=...&number=...`)
- `GET /config` / `POST /config` — Config viewer/editor (HTML form); displays an "Unknown Config Keys" warning banner when `getUnknownConfigKeys()` returns any entries
- `POST /config/remove-unknown-keys` — Removes all unknown keys from `config.json` via `removeConfigKeys()` and reloads config
- `GET /config/api` — JSON config (sensitive fields masked)
- `GET /api/activation` — Returns `{ state, lastVerification }` (activation state + latest connectivity check)
- `POST /api/activation` — Sets activation state (`{ state: "active"|"verify-only", confirm: true }`); requires restart to register jobs when flipping to `"active"`
- `POST /api/client-error` — Receives client-side JS error reports (fingerprint, message, stack, context) from `ERROR_HANDLER_SCRIPT`; deduplicates via `reportError()` and creates `[claws-error]` issues for novel errors; responds 204, ignores malformed payloads
- `GET /verify` — Connectivity verification page; shows latest `verification_reports` result (database, GitHub App, CLIs, Slack, IMAP, SSH, Ollama, WhatsApp)
- `POST /api/verify/run` — Triggers an on-demand connectivity verification and redirects to `/verify`
- `GET /topology` — Pipeline topology visualization (SVG diagram with live job status)
- `GET /repos` — Repo list page sorted by most-recent Claws activity (`getLastTaskTimePerRepo()`)
- `GET /repos/:owner/:name` — Per-repo page: open PRs (with CI status), open issues, recent Claws run logs, 30-day task stats, active worktrees
- `GET /prs` — All open PRs across every managed repo (#2096), sorted by `updatedAt` desc; enriched with a per-repo bulk `listPRStatuses()` fetch (CI status shown for every PR, not just ones in the in-memory queue cache) and, for merge candidates only, `getPRReviewStatus()`; Squash & Merge button gated on mergeable + CI passing/none + clean review (#2110)
- `GET /issues` — All open issues across every managed repo (#2096), sorted by `updatedAt` desc; each row has a Refined button (hidden if already `Refined`) reusing the queue page's `markRefined` client handler (#2099)
- `GET /claude-auth` — Reauth page (#2082) for refreshing the `claude` CLI's subscription OAuth credential from the browser
- `POST /api/claude-auth/start` — Begins the `claude setup-token` PTY flow, returns the OAuth URL once available
- `POST /api/claude-auth/code` — Submits the pasted authorization code to complete the flow
- `GET /api/claude-auth/status` — Polls login status (`awaiting-url`/`awaiting-code`/`completed`/`failed`)
- `GET /whatsapp` — WhatsApp status/pairing page
- `GET /whatsapp/pair` — SSE endpoint streaming QR codes for pairing
- `GET /whatsapp/events` — Recent WhatsApp connection events (JSON, `?limit=N`, max 200; requires auth)
- `POST /whatsapp/unpair` — Clear WhatsApp auth state
- `GET /runners` — Runner utilization page (active workflow runs, per-repo stats, per-`(repo, workflow_name)` stats with a Repository column so identically-named workflows in different repos are not merged, cancel buttons for queued runs). Both tables include a `Total Duration` column (`totalDurationS` — sum of completed run durations); the "By Workflow" table is sorted by total duration descending.
- `POST /runners/cancel` — Cancel a queued GitHub Actions workflow run (only `queued` status, not `in_progress`)
- `GET /usage` — Token/cost usage dashboard; `?days=1|7|30` (defaults to 7, invalid values fall back to 7) selects the `getUsageStats`/`getTotalUsage` aggregation window; breaks down by repo, job, and provider+model sorted by cost descending
- `GET /sessions` — Interactive session list page
- `POST /sessions/create` — Create a new PTY session; redirects to `/sessions/:id`
- `POST /sessions/create-multi` — Create a multi-repo session (≥2 repos required); calls `createMultiWorktreeSession`; redirects to `/sessions/:id`
- `GET /sessions/:id` — Terminal page (xterm.js over WebSocket)
- `POST /sessions/:id/kill` — Kill a session
- `POST /sessions/:id/resume` — Resume an exited session: recreates worktrees at the original path and relaunches `claude --continue`; calls `resumeSession(id)`
- `POST /sessions/:id/delete` — Permanently delete an ended session's history row
- `GET /sessions/:id/ws` — WebSocket endpoint for PTY I/O
- `GET /jobs` — Per-repo job enable/disable matrix page
- `POST /jobs` — Save `disabledJobsByRepo` config changes from matrix UI
- `GET /ha-upgrader` — Home Assistant update state page; categorizes DB rows from `getAllHaUpgraderStates()` into pending/applied/failing/blocked sections with dwell-window countdown ETAs
- `GET /damp` — Damp meter reading page (#1819); renders the log form, trends table, and recent history from `getDampTrendRows()` / `getRecentDampReadings(200)`; `?saved=1` shows a "Saved ✓" banner
- `POST /damp/log` — Logs one row per non-empty numeric field (`p0`, `p1`, … indexed into `DAMP_POINTS`) for the submitted `reading_date` (defaults to today if malformed); redirects to `/damp?saved=1`
- `GET /k8s` — Kubernetes integrations page; shows k3s and prod-k8s monitor status, recent monitor runs, and a link to open `Priority`-labelled alert issues for each cluster
- `GET /blog` — Blog post list page (#1849); merges posts fetched live from `BLOG_REPO`/`BLOG_CONTENT_DIR` with in-progress `blog_drafts` rows; `?pushed=<PR#>` / `?error=badpath|push` show a flash banner
- `GET /blog/edit` — Blog post editor; `?new=1` opens a blank post from `NEW_POST_SKELETON`, `?path=...` opens an existing post — prefers the stored draft (if any) over the live GitHub content so cross-browser edits aren't lost, else fetches via `fetchRepoFileWithSha()`; the PR link is shown whenever the draft has a recorded `pr_number`, regardless of `status`, so it stays visible after a further edit resets `status` back to `'draft'`
- `POST /blog/save` — Validates the path via `isValidBlogPath()` (re-renders the form with the submitted content on failure, never discarding what was typed), upserts a `blog_drafts` row, and — only when `action=push` (#1953) — reuses the draft's recorded `pr_branch` when `getPRState()` reports the PR is `OPEN` (committing via `putRepoFile()` against the branch's blob sha, skipping the commit when content is unchanged), and only creates a new branch + PR via `createPR()` when there is no recorded PR or the recorded one is closed/merged/missing (in which case `clearBlogDraftPR()` drops the stale pointer first); either path ends by marking the draft `pushed` via `setBlogDraftPushed()`
- `GET /manifest.webmanifest` — PWA web app manifest (#1818, from `pwa.ts`)
- `GET /static/icon-{180,192,512}.png`, `GET /apple-touch-icon.png`, `GET /apple-touch-icon-precomposed.png` — PNG app icons rasterized on demand from `APP_ICON_SVG` via `getAppIconPng(size)` (memoized per size, `sharp`-backed)

Supports dark/light/system themes. **Authentication is fail-closed — nothing
runs open:**

- **OIDC configured** (when `oidcClientId`, `oidcClientSecret`, `oidcBaseUrl`,
  and `oidcApplicationSlug` are all set): `GET /login` redirects immediately to
  authentik's authorization endpoint. After authentication, `/auth/callback`
  exchanges the code for a token, fetches userinfo, and issues a signed session
  cookie (`claws_session`), which is the only browser credential accepted.
  Programmatic access (the MCP server) uses the loopback-scoped
  `INTERNAL_MCP_TOKEN` Bearer on `/api/state`. The `next=` query parameter on
  `GET /login` is validated: it must start with `/`, must not start with `//`,
  and must not contain a backslash — any path that fails these checks falls
  back to `"/"` to prevent open-redirect attacks (e.g. `/\evil.example` being
  interpreted as a host by some browsers). There is deliberately **no in-app
  identity allowlist** in `/auth/callback` — any `sub`/`email` that reaches the
  callback is treated as authorized. This is not an oversight: dashboard
  authorization is enforced upstream by version-controlled Authentik group
  policy bindings (`fleet-infra` repo, `apps/authentik/configmap-blueprints.yaml`)
  restricting completion of OIDC authorization for the claws-app application to
  members of specific groups (`policy_engine_mode: any`). A user who can
  authenticate to the IdP but isn't in an allowed group is rejected at the
  application-authorization step and never reaches the callback with a valid
  code. Adding a second allowlist here would duplicate that authorization
  across two systems (drift hazard) for what is a single-tenant deployment. See
  the comment at the top of the session-minting code in `/auth/callback` in
  `server.ts`.
- **OIDC not configured**: every authenticated route returns **503**
  ("configure OIDC"). The dashboard and API never serve content without a
  session, so the `OIDC_*` variables must be set in `~/.claws/env` before first
  boot — there is no web-UI bootstrap path and no static token. The only thing
  that still works is the loopback `INTERNAL_MCP_TOKEN` on `/api/state`.

All dashboard mutation endpoints
send Slack notifications (gated by `notifyDashboardActions` config, default
`true`) with only an action description — no client IP is attached, since
there is no trusted reverse proxy in front of Claws and the
`x-forwarded-for` header is fully client-suppliable, making it unsafe for
audit attribution.

**`format.ts`** — Duration formatting utility. Exports `formatMs(ms)` which
converts milliseconds to human-readable strings: `0ms`, `5s`, `1m 5s`, `2m`,
`1h 30m`, `6h`. Used across `claude.ts`, `github.ts`, `scheduler.ts`,
`main.ts`, and `whatsapp.ts` for log messages and error reports. Replaces
ad-hoc `/ 1000` and `/ 60_000` conversions with a single consistent formatter.

**`plan-parser.ts`** — Parses structured implementation plan comments into
discrete phases for multi-PR workflows. Looks for `### PR N:` or `### Phase N:`
headers to split a plan into phases. Also provides `findPlanComment()` to locate the
most recent plan comment in an issue's comment history, `getPlanUpdatePhase()`
to read the `plan-updated-after-phase:N` marker from plan text,
`makePlanUpdateFooter()` to generate the plain-text footer
appended after plan updates, `getRecommendedModel()` to extract the
recommended model tier (`cheap`/`sonnet`/`opus`), and
`extractModelsAttribution()` to extract any existing `*Models used:...*` attribution
line for reuse in refinements. The `Provider` type is exported for use by
`model-selector.ts`. Plans embed only a model tier recommendation — provider
selection is handled entirely by the capability-specific fallback order config
(`TOOL_USE_PROVIDER_FALLBACK_ORDER` / `TEXT_ONLY_PROVIDER_FALLBACK_ORDER`), not by
plan annotations. Used by issue-worker to implement multi-phase plans
sequentially and update the plan between phases.

**`log.ts`** — Timestamped console logging with four levels: `debug`, `info`,
`warn`, `error`. Errors also trigger Slack notifications. All log calls capture
output into the `job_logs` table via `AsyncLocalStorage`-based run context, so
logs are associated with the job run that produced them.

**`ollama-rate-limit-classifier.ts`** — Classifies whether a CLI error string
represents a usage/rate-limit error. Primary strategy: sends the error text to a
local Ollama instance (`llama3`) via POST `/api/generate` with a long timeout
(`OLLAMA_TIMEOUT_MS`, default 60 seconds, to accommodate cold GPU starts) and
parses a YES/NO response. Falls back to `RATE_LIMIT_RE` regex on any failure.
A **circuit breaker** disables Ollama for 5 minutes after
`OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE` consecutive failures (default 3).
`clearOllamaAvailabilityCache()` resets state for test isolation. Used by
`claude.ts` provider fallback logic to decide whether to mark a provider as
rate-limited.

**`error-reporter.ts`** — On error: logs to console + Slack, then (with a
30-minute per-fingerprint cooldown) calls `ensureAlertIssue()` from `occurrence-tracking.ts`
to either edit the body of an existing `[claws-error]` issue in `SELF_REPO` (bumping the
occurrence count) or create a new one with an initial occurrence-tracking block appended.
Recurrences no longer post new comments — only the issue body is updated, eliminating
comment spam for repeated errors. These issues are then picked up by the
triage-claws-errors job for automated investigation. Several error
conditions are filtered before any reporting: `ShutdownError` (logged at info level —
shutdown cancellations are expected), `RateLimitError` (logged at warn
level — handled by the circuit breaker, not actionable bugs),
`TransientGitHubError` (#2036/#2039; logged at warn level — a `gh` call whose
final failure, after `gh()`'s own retries, was a GitHub-side `HTTP 500/502/503/504`;
self-healing since the dispatcher retries the item next cycle, so it must not open
a `[claws-error]` issue the way an unclassified `Error` carrying the same "HTTP 503"
text would),
`PushConflictError` (logged at warn level — transient race where another actor
pushed to the same branch concurrently; the dispatcher retries on the next cycle),
`AgentCliError` matching usage-limit messages (`USAGE_LIMIT_RE`:
`/you're out of .* usage|hit your limit/i` — transient credit exhaustion,
downgraded to warn), and `AgentCliError` matching transient Anthropic API errors
(`API_TRANSIENT_RE` — Anthropic API 5xx errors and unexpected socket closures, downgraded
to warn). Other `AgentCliError` instances (auth failures, unknown CLI errors)
flow through to the normal reporting path. When the error
is a `AgentTimeoutError`, the report includes a diagnostics section with
working directory, stdout byte count, whether Claude was producing output,
and collapsible last stdout/stderr snippets. Also exports
`reportTimeoutOnItem()`, which posts a comment on the source issue/PR when
a CLI timeout occurs, informing the user of the timeout count, any
escalation, and whether the item was auto-skipped. Also exports
`reportFailedAttachments()`, which creates or comments on a deduplicated
`[claws-error] Attachment download failures` issue in `SELF_REPO` when
`processTextForImages()` cannot download one or more referenced files — the
fingerprint is scoped per source issue (`attachment-download-failures:<repo>:<number>`)
with the same 30-minute cooldown. Failed URLs are listed in backticks (not
markdown image/link syntax) to prevent re-triggering the image extractor on
the generated issue body.

**`timeout-handler.ts`** — Central per-item timeout escalation logic. When a
`AgentTimeoutError` occurs, `handleTimeoutIfApplicable()` counts recent
timeouts for that item (via `db.countRecentTimeouts()`, 2-hour window) and
either escalates the timeout by 1.5x (capped at 6 hours) or auto-skips the
item after 3 timeouts. Escalated timeouts are persisted via
`itemTimeoutOverrides` in `config.json`. Jobs call `getItemTimeoutMs()` to
retrieve any per-item override before invoking Claude. For repo-level jobs
that have no issue number (e.g. `improvement-identifier`, `doc-maintainer`),
`itemNumber` is `0` — auto-skip and comment-posting are suppressed (no issue
to skip or comment on), but timeout escalation still applies so subsequent
runs use a larger budget. Returns `Promise<boolean>` (true = item was skipped).
`handleMemoryLimitIfApplicable()` counts recent memory-limit kills for that
item (via `db.countRecentMemoryLimits()`, 2-hour window) and either posts a
feedback comment (below threshold) or auto-skips the item via `gh.skipItem()`
after 3 kills (no timeout escalation — memory kills have a fixed cap).
Bounded by a 30-minute cooldown in `reportMemoryLimitOnItem`. Repo-level jobs
(item number 0) only log at warn — no comment or skip. `reportError()` suppresses
the `[claws-error]` alert for memory kills so they don't create noise in the
Claws repo.

**`outcome.ts`** — Task outcome builders used by agents to record structured
metadata on completed/failed tasks. Exports `buildSuccessOutcome()` (extracts
commit count and diff stats from the worktree), `buildFailureOutcome()`, and
`categorizeFailure()` (maps error types to failure categories: `timeout`,
`shutdown`, `rate-limit`, `push-rejection`, `git-conflict`, `ref-not-found`,
`transient-api`, `payload-too-large`, `unknown`). `BranchDeletedError` maps to
`ref-not-found` by error name; `PushConflictError` maps to `git-conflict` via the
`"Rebase onto origin/"` substring in its message; transient Anthropic 5xx errors match via
`"API Error: 5"` substring; `OpenRouterClientError` (HTTP 4xx non-429, e.g.
context-too-long, payload-too-large) maps to `payload-too-large` and is
never classified as a rate-limit — it fails fast without tripping the circuit
breaker.

**`occurrence-tracking.ts`** — Shared helpers for recurring alert issues. Body-level exports:
`appendOccurrenceTracking(body, timestamp, initialCount?)` appends a `---`-separated block with
`**First seen:**`, `**Last seen:**`, and `**Occurrences:**` lines to an issue body.
`updateOccurrenceTracking(body, timestamp)` increments the count and updates `**Last seen:**` in
an existing block (matched by the block's regex). `applyOccurrenceTracking(currentBody, timestamp)`
combines both — if the body already has tracking it calls `updateOccurrenceTracking`; otherwise it
retroactively appends with count=2 (the caller just observed a recurrence). The higher-level
`ensureAlertIssue({ repo, title, body, labels?, timestamp?, logPrefix })` does the full
search → update-or-create flow: searches for an open issue with the given exact title, calls
`applyOccurrenceTracking` + `editIssue` on a hit (warning on regex-miss), or `createIssue` with
`appendOccurrenceTracking(body, timestamp)` on a miss. Returns `{ outcome: "created" | "updated"
| "tracking-not-updated", issueNumber }`. Used by `error-reporter.ts` (both `reportError` and
`reportFailedAttachments`), `main.ts` (unknown-config-key reporting), and `k3s-monitor.ts` / `runner-monitor.ts`.
`parseOccurrenceCount(body)` — pure parser that extracts the `**Occurrences:** N` integer from
an issue body; returns `null` when absent. Used by `issue-dispatcher` to detect when an alert
issue has recurred enough since its plan was written to warrant a re-plan.

**`prompt-guard.ts`** — Prompt injection detection for user-submitted content.
`scanContent()` checks text against four pattern categories: instruction
overrides, zero-width characters, HTML comment injections, and base64-encoded
payloads. `guardContent()` wraps scanning with automatic redaction of
suspicious sections and Slack audit notifications. Claws-authored content
(identified via `isClawsComment()`) is never passed through `guardContent()`
— only human-authored comments, issue bodies, PR review text, and WhatsApp
inbound messages are guarded, preventing false positives from Claws' own
structured output. The `whatsapp-handler` guards the message text inline in
the prompt (via `makeGuardCtx("whatsapp", 0)` / `guardContent(text, guardCtx("whatsapp-message"))`)
while leaving the issue body raw — the body is plain data posted to GitHub,
not an instruction context, so redaction markers there would degrade the issue.
`formatGuardedTitleList(titles, guardCtx, source)` — shared helper used by
`improvement-identifier` and `idea-suggester` to build an indented Markdown
bullet list of GitHub-supplied issue/PR titles, passing each through
`guardContent()`. Returns `"  (none)"` for empty lists.
Every GitHub-supplied string interpolated into a prompt or a comment `ci-fixer.ts` posts must be
guarded — including `occ.pr.title` in `fileUnrelatedIssue()`'s `[ci-unrelated]` tracking comment
(#1812) and `pr.title` in issue-worker's `postPhaseProgressComment()` (#1860). Both comments are
posted via `gh.commentOnIssue()`, which stamps them with the Claws marker, so
`formatIssueCommentsForPrompt()` later treats them as self-authored and skips `guardContent()`
when reading them back — an unguarded, attacker-influenceable PR title would otherwise become a
permanently-trusted prompt-injection vector reachable by the opus-tier issue-refiner planner. See
also `CLAUDE.md`'s "Common gotchas" entry for this invariant.

**Guard once, reuse the guarded value**: guarding a piece of GitHub-supplied text at one embedding
site does not cover every other place the same underlying value is re-embedded — each additional
appearance (a second interpolation into the same prompt, or into a different comment/file) needs
either the already-guarded variable reused or an independent `guardContent()` call. Three fixes
converged on this pattern from separate angles: `triage-claws-errors.ts` guards `errorDetails.fingerprint`
once (`guardedFingerprint`) and reuses that single value at both of its embedding sites rather than
re-embedding the raw fingerprint a second time, and also guards it before writing it into the
self-authored "Known Fingerprints" comment (#1868/#1869); `doc-maintainer.ts` guards `issue.title`
before writing it into a `.plans/*.md` file, since that file is later read back by planning/implementing
agents just like a self-authored GitHub comment would be (#1870).

`formatInjectionComment()` quotes the actual matched span (`m.matched`) inside a code fence in its
own Claws-authored alert comment when `scanContent()` flags something — but that comment is
subject to the exact same unguarded-read-back risk, and `guardContent()` can't be applied to the
quoted span itself (it would redact the whole phrase and defeat the point of the report). Instead
`defangPhrase()` (`prompt-guard.ts`) inserts zero-width spaces (`\u200B`) into the quoted text
before it's fenced: breaking `<!--`/`-->` sequences so an HTML-comment-injection match can't
re-parse as a real comment, and splitting common instruction-trigger words (`ignore`, `disregard`,
`override`, `system`, `prompt`, etc.) so they read normally to a human but no longer match as clean
tokens to a scanner or LLM on read-back (#1862).

**`mcp-server.ts`** — Standalone stdio-based MCP (Model Context Protocol)
server that exposes Claws operational state to Claude sessions. Spawned by
Claude CLI via `--mcp-config`. Intentionally self-contained — imports only
`namey-query.js` and `ha-mcp.js` from the Claws source tree and avoids importing `config.ts`
or other main-process modules (e.g. `home-assistant.ts`), so it can run as a
stdio child of the Claude CLI without dragging in the full config loader or
its transitive dependencies. Provides four core tools: `claws_status` (running
tasks, queue items, Claude queue counts), `claws_task_history` (recent task
history filtered by repo/issue), `claws_open_prs` (open PRs via `gh` CLI),
`claws_config` (skip and priority lists); plus `namey_query` (read-only SQL
queries against the namey production PostgreSQL database) registered only when
`NAMEY_DB_URL` is configured; plus `ha_list_entities` (projects `/api/states` to
`{ entity_id, state, friendly_name }`, filterable by domain or search substring,
capped at 500) and `ha_api_request` (generic passthrough to any `/api/…` endpoint,
GET/POST, non-JSON bodies handled as raw text) registered only when both
`HOME_ASSISTANT_BASE_URL` and `HOME_ASSISTANT_TOKEN` env vars are present.
Reads from the SQLite database (read-only), the
Claws HTTP API (`/api/state`), and optionally the namey PostgreSQL database or
Home Assistant REST API.

**`namey-query.ts`** — Handler logic for the `namey_query` MCP tool, extracted
for testability. `handleNameyQuery()` validates SQL via `sql-validation.ts`
(rejects multi-statement queries, enforces a 500-row LIMIT cap), acquires a
pooled PostgreSQL connection, wraps the query in `BEGIN TRANSACTION READ ONLY`,
and races it against a 30-second client-side abort timer. On timeout, the
connection is destroyed (not returned to pool) to avoid blocking on the
in-flight query. On success or error, `statement_timeout` is restored before
releasing the connection to prevent `set_config()` bypass attacks.

**`sql-validation.ts`** — SQL validation helpers for `namey-query.ts`. Exports
`isMultiStatement(sql)` (detects semicolons outside string literals and
comments via a single-pass tokenizer) and `ensureLimit(sql)` (appends
`LIMIT 500` if missing, caps existing LIMIT/FETCH FIRST clauses to 500).
The tokenizer strips single-quoted string literals, block comments, and line
comments to prevent bypass via `'LIMIT 10'` or `-- LIMIT 1`. Parenthesized
subqueries are stripped before checking so inner LIMITs don't satisfy the
outer-level check. Does not handle PostgreSQL dollar-quoting — false positives
only, not false negatives. The extended query protocol (`values: []`) is the
real single-statement guard.

**`images.ts`** — Extracts image references (markdown `![](url)` and HTML
`<img>` tags) from issue/PR text, downloads them (up to 10 images, 10 MB
each, 30s timeout), and writes them into the worktree under `.claws-images/`.
Also extracts GitHub file attachments (`[filename](github-attachment-url)`),
downloads them (up to 5 attachments, 1 MB each), validates UTF-8 encoding,
and truncates large text content (100K char limit, keeps first/last halves).
Auto-detects the GitHub token for private image access. Skips badges, data
URLs, and binary attachment types. `extractImageUrls()` calls `stripCodeRegions(text, "markdown"|"html")` before running
URL-extraction regexes to remove inline code spans, fenced code blocks, and
`<code>`/`<pre>` HTML regions — preventing false positives from code examples
that contain image-like syntax in backticks. URL candidates are then
validated with `isUsableImageUrl()` (must be `http:`/`https:` or `data:`) to
reject fragments, relative paths, or other regex surprises. Same code-region
stripping is applied to `extractAttachmentUrls()`. **SSRF protection**: `assertPublicHost(rawUrl)` (exported) guards every fetch — it parses the URL, rejects non-http(s) protocols and localhost, and DNS-resolves hostnames via `dns.lookup({all:true})` requiring every returned address to pass `isPrivateIp()` (private IPv4 ranges: loopback 127/8, link-local 169.254/16, RFC-1918 10/8, 172.16/12, 192.168/16, "this network" 0/8, CGN 100.64/10, multicast 224/4, reserved 240/4; private IPv6: loopback `::1`, unspecified `::`, link-local `fe80::/10`, unique-local `fc00::/7`, multicast `ff00::/8`, plus IPv4-mapped `::ffff:*/96` via embedded v4 re-check). `fetchWithGuard(url, token, controller)` is an internal helper that calls `assertPublicHost` then fetches with `redirect:"manual"`, following up to `MAX_REDIRECT_HOPS` (3) redirects with a fresh `assertPublicHost` and GitHub token re-evaluation per hop (never carries auth to a non-github host). Both `downloadImages` and `downloadAttachments` use `fetchWithGuard` in their per-URL loops. **Auth header strategy**: `private-user-images.githubusercontent.com` pre-signed URLs are
fetched without auth (sending a token would invalidate the JWT signature);
all other `github.com` and `githubusercontent.com` URLs — including
`github.com/user-attachments/` — are fetched with the installation token.
The main entry point `processTextForImages(texts, wtPath, owner?, posting?,
htmlBodies?)` runs both pipelines and returns a combined prompt section. When
`htmlBodies` is provided (rendered `body_html` from GitHub's REST API), image
URLs are extracted from the HTML rather than the raw markdown — `body_html`
contains pre-signed `private-user-images.githubusercontent.com` URLs that are
directly downloadable, making private-repo images accessible. Both
`downloadImages` and `downloadAttachments` return a two-part result:
`downloaded` and `failed`. Non-OK HTTP responses from any URL are classified
as `failed` and trigger `reportFailedAttachments()` to create a `[claws-error]`
issue; failed URLs are surfaced in the user-facing warning comment so Claude
knows the files were absent. Since that comment is self-authored by Claws (never
re-guarded on read-back), each failed URL is passed through `guardContent()`
before interpolation, both in the comment built here and again independently in
`reportFailedAttachments()` — an unreachable URL is still attacker-controlled
text and would otherwise become a permanent prompt-injection channel (#1842).
Used by issue-refiner, issue-worker, and review-addresser to give Claude visual
and file context.

## Jobs

Thirty registered jobs run on timers or schedules, plus one event-driven handler.
See [Jobs](jobs/README.md) for detailed behavior of each.

| Job | Trigger | Interval | Summary |
|-----|---------|----------|---------|
| `issue-dispatcher` | All open issues per repo | 5 min | Unified dispatcher — classifies issues and delegates to planner (issue-refiner) and implementer (issue-worker) agents |
| `sequential-issue-processor` | Opt-in per repo (`/jobs` matrix) | 10 min (`sequentialIssueProcessorMs`) | "Process all issues" mode (#2103) for incident-heavy repos — serializes work to one issue at a time in an LLM-assessed priority order, auto-refining the top non-controversial issue and waiting for its PR to merge before advancing; defers to a human (`Manual Action`) for controversial/out-of-scope issues |
| `pr-dispatcher` | All open PRs per repo | 5 min | Unified dispatcher — classifies PRs and delegates to CI fixer, review addresser, reviewer (pr-reviewer), and merger (auto-merger) agents; closes empty PRs (0 changed files) before dispatching |
| `triage-claws-errors` | `[claws-error]` issues in `SELF_REPO` | 10 min | Investigates internal Claws errors, deduplicates by fingerprint, posts report |
| [`doc-maintainer`](jobs/doc-maintainer.md) | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Updates `docs/` to reflect current codebase; also captures human-authored issue/PR intent into `docs/intent-log.md` (#2090); posts a Slack summary after all repos are processed (PRs opened with plan titles, skipped repos, errors); silent on fully-quiet runs |
| `repo-standards` | Daily at 2 AM (+ on startup) | Scheduled | Syncs labels and cleans legacy labels for each managed repo; removes stale local clones |
| `improvement-identifier` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Reviews codebase via Claude for security issues and improvements; files improvement issues when no security work is queued; no longer opens PRs; skips fork-PR hardening findings on private repos (uses `isRepoPrivate()`); conditionally adds Web/SEO and JSON-LD guidance for repos that serve user-facing HTML |
| `public-repo-scanner` | Daily at 4 AM (`publicRepoScannerHour`); 7-day per-repo throttle | Scheduled | Enumerates all public repos for all owners (including archived, via `listPublicReposIncludingArchived()`); asks Claude to scan each for live secrets, private keys, and credentials; files alert issues via `ensureAlertIssue()`; does NOT write MCP config (text-only, no tool use needed); findings on a `PUBLIC_SNAPSHOTS` target repo are filed to `SELF_REPO`, never the private source (#1875, #1962) |
| `idea-suggester` | Hourly (weekdays only); selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Suggests new ideas per repo, posts to Slack thread for reaction-based review |
| `idea-collector` | Pending ideas with reactions | 30 min | Polls Slack reactions, creates GH issues for accepted ideas, batches results into collection PR |
| `issue-auditor` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Reconciles issue states, manages Ready and In Review labels |
| `whatsapp-handler` | WhatsApp message | Event-driven | Interprets messages via Claude, creates GitHub issues |
| `runner-monitor` | Self-hosted GH Actions runners | 10 min | SSHes to runners, checks service health, restarts dead services, tiered disk cleanup (>85% tier 1, >90% tier 2), files issue when disk stays critical post-cleanup |
| `mac-runner-waker` | Queued jobs in `bonkus`, `namey`, `TempoStatusBar` | 1 min | Wakes sleeping self-hosted Macs over SSH when a macOS CI job has been queued for >60 s, selecting the Mac by `runs-on` label match; SSH wake failures raise a per-host `[claws-error]` alert issue |
| `scanner-dispatcher` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Runs nine scanners sequentially (one failure doesn't block others): ubuntu-latest, concurrency, migration, main-build-monitor, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, gitignore |
| `stale-branch-cleaner` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Deletes stale `claws/*` remote branches whose PRs have been merged or closed for 7+ days |
| `idea-reconciler` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Moves accepted ideas back to potential.md when their GitHub issues are closed without implementation |
| `qa-phase` | PRs with "QA this" comment | 10 min | Performs exploratory QA on deployed PRs via Playwright browser automation |
| `email-monitor` | Unread emails in configured Gmail inbox | 5 min | Polls Gmail via IMAP, extracts veg box contents via Claude, generates recipes, emails results |
| [`k3s-monitor`](jobs/k3s-monitor.md) | k3s cluster pods/nodes | 15 min | Monitors cluster health via `kubectl`, detects failing pods, unhealthy nodes, and Flux Kustomization/HelmRelease failures; raises alert issues to `FLEET_INFRA_REPO` with the `Priority` label and occurrence tracking |
| `prod-k8s-monitor` | Prod k8s cluster pods/nodes | 15 min (configurable) | Same detection as `k3s-monitor` but for the prod cluster via `prodK8sKubeconfigPath`; files alerts to `prodK8sRepo` (default `St-John-Software/production-infra`); disabled by default — enable via `prodK8sMonitorEnabled: true` |
| `runner-metrics-sync` | GitHub Actions workflow runs | 2 min (adaptive) | Syncs recent workflow runs to the `workflow_runs` SQLite table; skips API calls when Claws is idle and last sync was <15 min ago; reconciles stale `queued`/`in_progress` rows via `fetchWorkflowRunById()` (deletes runs that GitHub no longer knows about); backs off to zero cost at rest |
| `datasette-export` | Local SQLite DB | Configurable interval | Exports a copy of `claws.db` to a remote host via scp for Datasette-based data exploration |
| `ha-upgrader` | Home Assistant `update.*` entities | 24 h | Polls Home Assistant for pending updates, applies device and HA core/supervisor/OS updates within configurable dwell windows (24 h device, 48 h high-risk), raises alert issues for failures; Slack notified only on actual installs, user-excluded alerts, or install failures (not on routine dwell-deferred waits) |
| `ha-deploy-watcher` | git-pull addon logs | 5 min | Polls git-pull addon logs via HA Supervisor API; posts Slack notification with commit list (`listCompareCommits`), compare link, and diffstat when `Updating <old>..<new>` is detected; commit-list fetch failures fall back to compare link only; first run baselines silently |
| `worktree-cleaner` | All `~/.claws/worktrees/` directories | 24 h | Removes worktrees >7 days old that aren't in any running task or persisted session; uses `git worktree remove --force` with `rm -rf` + `git worktree prune` fallback; logs removed count and freed bytes |
| `bin-day-monitor` | Home Assistant bin-day sensors | 15 min | Polls `sensor.bin_scraper_*` entities; maintains a single persistent GitHub issue as a running availability log; records status transitions (HEALTHY ↔ MISSING) in an embedded history table; never closes the issue on recovery; disabled by default (`homeAssistantBinDayMonitorEnabled`) |
| `ha-battery-monitor` | Home Assistant battery sensors | 1 h | Polls HA entities with `device_class=battery` and `unit_of_measurement=%`; creates a `Priority` issue listing all devices at or below `homeAssistantBatteryThresholdPercent` (default 10%); auto-closes the issue when all devices recover; body is rebuilt in-place each tick without posting comments; disabled by default (`homeAssistantBatteryMonitorEnabled`) |
| `actions-storage-monitor` | All repos | Daily at 5 AM (`actionsStorageMonitorHour`) | Scans GitHub Actions cache + artifact storage per repo; files per-repo alert when a repo uses ≥ 50 MB of Actions **cache** or has artifacts older than 7 days (high retention); org-level roll-up alert when total usage ≥ 80% of 2 GB account quota |
| `dependabot-alert-monitor` | All repos | Smart-scheduled | Polls `GET /repos/{owner}/{repo}/dependabot/alerts?state=open` per repo; auto-dismisses stale alerts in two passes — SBOM-based (gated by `dependabotAutoDismissStale`, default on) then manifest-pin-based for pip packages with `==` pins (handles SBOM lag); files a Priority `ensureAlertIssue` listing the remaining open alerts sorted by severity, with an embedded `REMEDIATION_GUIDANCE` block ordering remediation steps (remove unneeded deps, classify dev vs runtime, bump direct deps, use `>=` ranges in overrides); auto-closes the issue once alerts clear; leaves repos with scanning disabled as-is; if the App lacks `dependabot_alerts: read`, files a remediation issue on `SELF_REPO` (throttled hourly) |
| `damp-reminder` | N/A | 15 min (`dampReminderMs`) | Checks `hasDampReadingLoggedSince(weekStart)` and auto-closes the open reminder once readings are logged this week (once per week via an in-memory guard); on Monday local time ≥ 9 AM with no readings yet, files a single deduplicated `Priority` issue in `SELF_REPO` (via `findIssueByExactTitle`/`createIssue`, not `ensureAlertIssue` — a one-shot-per-period reminder must not have its body rewritten on every tick) reminding readings be logged on the `/damp` dashboard page |
| `public-snapshot-sync` | `PUBLIC_SNAPSHOTS` source→target pairs | Daily at 3 AM (`publicSnapshotSyncHour`, #2106 — was weekly via `publicSnapshotSyncMs`; chosen to slot between `repo-standards` (2 AM) and `public-repo-scanner` (4 AM), outside UK office hours) | Rebuilds each public `stjohnb/*` target from its private source via `git archive` (tracked files only, #1833), scrubbing `.claude`, `.plans`, `ideas/`, MCP config, dependabot files, `BLOG_IDEAS.md`, `HOMELAB_IDEAS.md`, and any pair-specific `scrubPaths` (#1962); publishes `.github/workflows` but disabled — `disableWorkflowTriggers()` rewrites each workflow's `on:` block to `workflow_dispatch:` only (#1835); runs a fail-closed secret scan against a path+pattern `SCAN_ALLOWLIST` for known-safe placeholders (#1833/#1836); disables Dependabot; pushes exactly one commit summarising features since the last sync (tracked via `.claws-snapshot.json`), or — for a `scrubPaths` pair — force-pushes a single squashed root commit every sync so a scrubbed path can't survive in ancestor history (#1962, mutually exclusive with `mirrorReleases`); for pairs with `mirrorReleases: true` (TempoStatusBar), also mirrors the latest stable GitHub release's assets to the target (#1851); the DMG is fetched from the pair's `releaseAssetUrl` (public S3) when the source release has no `.dmg` asset, because TempoStatusBar's release workflow moved DMG storage off GitHub Releases to S3 (#2115); idempotent via the stored source SHA, so a daily no-op run (no new source commits) is fast; never un-archives a target — a missing/archived target alerts on `SELF_REPO` and is skipped |

### Naming Convention

- **Jobs** (`src/jobs/`): Top-level units registered with the scheduler. Each job runs on a timer or schedule and is referenced by name in the DB, config (`pausedJobs`), and dashboard.
- **Agents** (`src/agents/`): Task-specific modules called by dispatcher jobs. Each handles a specific concern (planning, implementing, CI fixing, etc.) and typically invokes Claude in an isolated worktree.
- Agent display names (`Planner`, `Implementer`, `CI Fixer`, etc.) are short labels for GitHub comment headers and `disabledAgents` config. Filenames are more descriptive (e.g., `issue-refiner.ts`, `ci-fixer.ts`).

## Key Patterns

### Content-Based State Machine

Issues and PRs are discovered by analysing comments, reactions, and PR state —
not labels. Eleven labels are used:

- `Refined` — trigger for issue-worker (only label that drives a state transition)
- `Ready` — informational, signals "Claws is done, your turn"
- `In Review` — informational, signals an issue has an open PR under review
- `Priority` — high-priority items processed first in all Claws queues
- `Duplicate` — issue has been identified as a duplicate; issue-dispatcher skips it in both the planner and implementer phases; canonical issue's last-phase PR auto-closes duplicates via `Closes #N`
- `Claws Ignore` — causes all Claws jobs to skip the item entirely (label-based complement to `skippedItems` config)
- `Claws Problematic` — PR has exceeded CI fixer circuit breaker thresholds and requires manual intervention
- `Billing` — applied by ci-fixer when a workflow run's annotations indicate a GitHub Actions billing/spending-limit block; rerun is skipped for these PRs
- `Plan: Fable` — causes issue-refiner to plan with `claude-fable-5` instead of the default opus tier; per-issue opt-in for Fable 5 planning
- `Manual Action` — applied by issue-worker when the PR-description generator emits a `MANUAL-ACTION:` marker; blocks auto-merger from merging the PR until a human removes it (#1887)
- `Automerge` — opt-in per issue (one-click from the Claws `/queue` and `/issues` pages); propagated by issue-worker onto the PR it opens. On a PR it replaces the human-LGTM gate in auto-merger with an automated one: the latest Claws `## PR Review` must be `clean` **and** must have reviewed the current HEAD SHA, and CI must be `passing` (a `none` check status is not enough). `Manual Action` still blocks the merge (#2120)

```
Issues (issue-dispatcher):
  No plan comment        →  (planner posts plan)         →  Ready label added
  Unreacted feedback     →  (planner refines plan)       →  Ready label re-added, response comment posted
  Open PR + follow-up Q  →  (planner posts response)     →  👍 reactions added (no label changes)
  Refined label          →  (implementer creates PR)     →  Refined removed, Ready removed, In Review added
  [claws-error] title    →  (triage-claws-errors)        →  investigation report posted
  Plan occurrences stale →  (planner re-plans in-place)  →  CLAWS_PLAN_OCCURRENCES marker updated (fires when currentOcc ≥ plannedOcc×2)
  No code change needed  →  (planner posts explanation + CLAWS_NO_CODE_CHANGES)  →  Claws Ignore label applied; pipeline short-circuits, issue stays open

PRs (pr-dispatcher):
  Empty PR (0 files changed, >10 min old)  →  (empty-pr-closer)  →  comment posted, PR closed; linked issue closed only if a PR for it already merged
  All open PRs               →  (reviewer)           →  review comment posted, Ready added if clean
  "/claude-review" comment   →  (reviewer)           →  re-review forced via Claude (bypasses OpenRouter for one cycle)
  Failing CI checks          →  (ci-fixer)           →  fix commits pushed or workflow rerun
  Merge conflicts            →  (ci-fixer)           →  conflicts resolved
  "QA this" comment          →  (qa-phase)           →  Playwright QA report posted, Ready added
  Reviewer feedback (auto)   →  (review-addresser)   →  🚀 reactions added, commits pushed → reviewer re-reviews
  Human review comments       →  (review-addresser)   →  🚀 reactions added, reply posted + Ready added if no commits pushed
  Dependabot (`dependabot[bot]` or `app/dependabot`) or LGTM'd Claws PR + passing CI  →  (merger)  →  merged, In Review removed
  Doc PR (claws/docs-*) + doc-only files + CI passing/skipped  →  (merger)  →  merged (no LGTM required)
  Idea-collection PR (claws/ideas-collect-*) + ideas-only files + CI passing/skipped  →  (merger)  →  merged (no LGTM required)
  Auto-bump PR (automation/bump-*, label auto-bump, no major-update) + image-pin manifests only (deployment.yaml, migrate-job.yaml, cleanup-test-data-cronjob.yaml under apps/<app>/ or base/|prod/ overlay) + CI passing  →  (merger)  →  merged (no LGTM required)
```

**Plan length warning**: After posting any plan comment (fresh plan,
refinement, or follow-up), the issue-refiner checks the output length against
`PLAN_LENGTH_WARN_CHARS` (15,000 chars). If exceeded, it posts an additional
GitHub `> [!WARNING]` callout comment — a yellow alert box in the GitHub UI —
advising that the implementer may run low on context and offering to re-plan
more concisely. This is distinct from `CONCISENESS_INSTRUCTIONS` (which guides
the planner to stay under 3,000 words) — the warning fires after the fact as a
visible signal to operators.

**Duplicate issue detection**: During fresh planning (`processIssue`), the
issue-refiner injects up to `MAX_DUPLICATE_CANDIDATES` (20) lower-numbered open
issues as "possible duplicate candidates" into the planner prompt. Claude appends a
`DUPLICATE_OF: #N` or `DUPLICATE_OF: none` line to its output. If a duplicate is
declared, the new issue receives a short "See #N" plan instead of a full
implementation plan, and a back-reference comment is posted on the canonical issue.
The duplicate issue also receives the `Duplicate` label, and the plan comment embeds
a plain-text `CLAWS_DUPLICATE_OF: #N` marker (never an HTML comment — consistent
with `NO_HTML_COMMENTS_INSTRUCTION` injected into all planner prompts). The issue-dispatcher then skips
`Duplicate`-labeled issues in both the planner and implementer phases. When the
canonical issue is implemented, the issue-worker calls `listDuplicateIssuesOf()` on
the last phase and appends `Closes #N` entries to the PR body for each open duplicate,
so all related issues are closed when the PR merges. Tiebreaking is deterministic:
lowest issue number wins (important when a cluster of alert issues is created in
parallel for the same root cause). The `parseDuplicateOf()` helper validates the
declared number against `allowedNumbers` to prevent hallucination. Candidate titles
and bodies are run through `guardContent()` before being injected. This scope is
restricted to fresh plans only — refinement and follow-up paths are not affected.

Jobs track processed items via reactions on comments: the issue-refiner uses
👍 to mark seen comments, while the review-addresser uses 🚀 to mark
addressed review feedback. Human review comments are processed automatically;
Claws-authored suggestions require a human 👍 before implementation.

**Automated review-implement cycle**: Claws PR reviewer comments with
actionable feedback (`## PR Review` containing issues) are automatically
picked up by the review-addresser without requiring a human 👍 — this
creates a fully automated review → fix → re-review loop. Clean reviews
("no issues found" / "no net changes") are excluded from auto-addressing.
Non-review Claws comments still require human 👍. Text output rules for the
review-addresser: (1) if a review comment asks a **question** (e.g. "why did
you…", "what about…", "can you explain…"), the agent MUST post a written
answer — even when a code commit also addresses it; answering only with a
commit is not acceptable; (2) if a suggestion couldn't be implemented or an
error occurred, the agent explains in text; (3) if every comment was a pure
change request fully addressed by commits (no questions, no problems), the
agent posts no comment. The `Ready` label is added when a text reply is
posted without any commits. When only commits are pushed (no questions
asked), no comment is posted and `Ready` is not added — the reviewer
re-reviews in the same dispatcher cycle. This prevents `Ready` from
flickering on/off between cycles.

**Benign no-change output** (`isBenignNoChangeOutput`, exported from `review-addresser.ts`): when the addresser made no commits but produced text output, the guard distinguishes benign "already addressed / not applicable" confirmations from real blockers. A positive "no change needed" phrase is required AND no blocker/error/uncertainty signal may be present. When the guard returns `true`, `Ready` is applied (with a CI/merge-state re-check mirroring the pr-reviewer path) rather than withheld — fixing the case where a false-positive reviewer nit produces confirmation text that previously caused PRs to stall permanently (the `review-addressed: <SHA>` marker prevents the addresser from re-firing, and without a push there are no new commits for the reviewer to detect).

**Human-over-automated authority**: When human and Claws reviewer comments conflict
(e.g. a human directs "use self-hosted runner" but the automated review says "use
ubuntu-latest"), the review-addresser's prompt explicitly instructs it to follow the
human and ignore the conflicting automated comment. The authority hierarchy — established
by the `getPRReviewComments()` section headers — means human directives cannot be
silently overridden by the next automated review cycle.

**Refined plan is authoritative over the original issue**: `buildIssueContext()`
in `src/agents/pr-reviewer.ts` fetches both the originating issue body and the
Claws refined-plan comment (if one exists, via `planParser.findPlanComment()`).
When a plan comment exists, the reviewer is told the **refined plan**, not the
original issue text, is the authoritative spec — the planner may have
deliberately narrowed, expanded, or changed the original request after
investigation, and the reviewer must not flag that intentional divergence as a
"missing requirement" or "scope drift". The original issue body is still
included, but only as background on the user's initial intent. When no plan
comment exists, the issue body remains the sole source of truth (unchanged
behavior). This prevents the reviewer from forcing a PR back toward a
requirement the plan explicitly rejected (e.g. issue #1792 asked for an in-app
OIDC allowlist; the refined plan concluded it was unnecessary because
authorization is already enforced upstream in Authentik — see the auth
discussion above — and the reviewer must accept that narrower scope).

**`review-result: clean` marker**: When the pr-reviewer posts a "no issues found"
review, the review body includes a plain-text `review-result: clean` marker (in addition
to the human-readable text). `maybeAddReadyLabel()` uses this marker as its primary
detection signal (with a regex fallback for older reviews that predate it), eliminating
fragile text-matching on body content that may have accumulated formatting drift.
`extractCurrentReviewContent()` strips the marker before content comparisons, and also
strips the `review-addressed: <SHA>` marker written by the review-addresser (preventing
it from leaking into content comparisons).

`isNoActionableReview(output)` catches a related edge case: re-reviews whose verdict is
"no actionable changes" phrased conversationally (e.g. "no changes needed", "the review I
already posted is accurate") without the exact `review-result: clean` marker. These are also
classified as clean so the `Ready` label is applied. The helper returns `false` if the review
carries any actionable signal (file/line references, backticked paths, `Suggested Approach
Change`, `recommended-model:` annotation) to prevent false positives.

The pr-reviewer also includes a **reassessment mechanism**: after
`REASSESSMENT_THRESHOLD` (3) previous reviews with substantive issues,
the reviewer prompt includes the last 5 rounds of feedback and asks Claude
to reassess whether the current approach is fundamentally sound, or whether
a different approach would avoid recurring issues entirely. If so, the
review leads with a "Suggested Approach Change" section.

Triage jobs check for existing report comments.
The issue-auditor reconciles label state daily, adding missing `In Review`
labels to issues with open PRs and removing stale ones.

### SQLite-Backed Work Queue

Dispatcher jobs (`issue-dispatcher`, `pr-dispatcher`) classify items and
`enqueue()` work into the `work_queue` SQLite table via `worker.ts`. Up to
`MAX_WORK_WORKERS` (default 2) worker fibers run concurrently; each claims the
highest-priority oldest `queued` row via `claimNextWork()`, invokes the
registered handler, and marks the row `completed` or `failed`. The concurrency
limit is configurable via `maxWorkWorkers` in `config.json` or the
`CLAWS_MAX_WORK_WORKERS` env var (`maxClaudeWorkers` / `CLAWS_MAX_CLAUDE_WORKERS`
are deprecated aliases). Idempotency is enforced by a UNIQUE partial index on
`(kind, repo, item_number) WHERE status IN ('queued', 'running')` — a second
`enqueue()` for the same item no-ops silently.

Each Claude process spawned by a handler has a configurable timeout
(`claudeTimeoutMs`, default 6 hours) with SIGTERM/SIGKILL escalation. Per-item
overrides can extend this for items that have timed out before (see Per-Item
Timeout Escalation below). A 5-minute heartbeat logs PID, elapsed time, and
stdout byte count. A configurable **liveness abort** (`claudeLivenessTimeoutMs`,
default 6 hours) kills processes that produce zero stdout bytes early. A per-worker **memory watchdog** additionally samples each Claude/Codex process tree's RSS every 15s and SIGKILLs the whole tree (children included — e.g. a runaway `openscad` render) when it exceeds `claudeWorkerMemoryMaxBytes` (default 2 GiB; `0` disables), throwing `AgentMemoryLimitError`. The Claude CLI is spawned with `NODE_OPTIONS=--max-old-space-size=1024` to keep its V8 heap footprint deterministic under the cap. After 3 consecutive memory-limit kills in a 2-hour window, the item is auto-skipped (via `gh.skipItem`) and a comment is posted explaining the skip; below that threshold a comment is posted and the item re-queues normally. All liveness, timeout, and memory kills reap the entire process tree, not just the CLI process. `runClaude`
wraps `runClaudeOnce` with a retry layer (gated on `!isShuttingDown()`) that
retries once on: (1) 0-byte timeouts (transient hang recovery), (2) `AgentCliError`
with `numTurns === 0` (transient CLI initialization failure), or (3) `AgentCliError`
matching `API_TRANSIENT_RE` (Anthropic API 5xx errors). Non-0-byte timeouts and CLI
errors with turns > 0 that don't match the transient API pattern are not retried.
The stdin pipe has an error handler to prevent unhandled stream errors. Timed-out
processes throw `AgentTimeoutError` with diagnostic fields, surfaced in error
reports for debugging. CLI-level failures (usage limits, auth errors, malformed
output) throw `AgentCliError` — usage-limit errors are suppressed by the error
reporter; other CLI errors create `[claws-error]` issues normally.

### Model Selection

`model-selector.ts` provides `getModel(defaultTier, provider)`. Three tiers
exist: `"cheap"` (trivial tasks), `"sonnet"` (standard), and `"opus"` (complex).
Most call sites pass the tier explicitly; `"sonnet"` is the default. The PR
reviewer embeds a `recommended-model: sonnet` or `recommended-model: opus` marker
(plain text) in its review output, and the review-addresser extracts it to choose
the appropriate tier.
Per-provider model mapping: Claude uses `CLAUDE_CHEAP_MODEL` / `"sonnet"` /
`"opus"`; Codex uses `CODEX_CHEAP_MODEL` / `CODEX_LIGHT_MODEL` /
`CODEX_DEFAULT_MODEL`; OpenCode uses `OPENCODE_CHEAP_MODEL` /
`OPENCODE_ADEQUATE_MODEL` / `OPENCODE_BEST_MODEL`.
Empty-string overrides are handled: if `CLAUDE_CHEAP_MODEL` is `""`, the cheap
tier falls back to `"haiku"` (a valid Claude CLI alias, cheaper than sonnet).
The model used for each task is recorded in the `model_used` column, and the
provider used is recorded in the `provider_used` column, both via `db.ts`.

The issue-refiner (planner) recommends a model tier per issue via embedded
annotations in the plan comment. Provider selection is not part of the plan —
every call site declares its `capability` (`"tool-use"` or `"text-only"`) and
`runClaude()` walks the corresponding fallback order. Tool-use workflows
(issue-worker, ci-fixer, review-addresser, doc-maintainer, improvement-identifier,
triage-claws-errors, pr-reviewer) use Claude — pr-reviewer was flipped from
text-only to tool-use (#1879) so it can verify git facts (diff, blame, file
contents) with real tool calls before asserting them in a review, rather than
trusting the PR description alone. Text-only workflows split
into two groups:

- **Pinned to Claude** (explicit `provider: "claude"` on the `runClaude` call):
  issue-refiner plan generation/refinement/follow-up,
  improvement-identifier analysis phase, email-monitor (both veg-list extraction
  and recipe generation, pinned to avoid OpenRouter 402 credit errors), and the
  PR description/diagnosis utilities in `claude.ts` (`generatePRDescription`,
  `generateDocsPRDescription`, `regeneratePRDescription`, `diagnoseNoCommits`).
  These are pinned for output quality, structured-JSON correctness, or reliable
  auth — Qwen via OpenCode/OpenRouter consistently produces malformed JSON for
  analysis tasks, blocking all downstream work.
- **Default to OpenCode+Qwen on OpenRouter** (no explicit provider pin, walks
  `TEXT_ONLY_PROVIDER_FALLBACK_ORDER`): idea-suggester,
  qa-phase — preserving Claude quota for workflows that actually need tool
  calling or where output quality is critical.

Pinning with `provider: "claude"` bypasses the fallback chain entirely and fails
visibly on a Claude outage rather than silently routing to a provider that may
produce unusable output.
The planner itself defaults to the `opus` tier (no classification step) because issue descriptions are frequently too sparse to classify reliably, and a wrong downgrade — especially to `haiku` via the `cheap` tier — produces low-quality plans that propagate through every downstream implementation. When an issue carries the `Plan: Fable` label, `planModelForIssue()` in `issue-refiner.ts` overrides the model to `claude-fable-5` (`FABLE_MODEL`) instead, and `FABLE_PLANNING_CONTEXT` is injected into the prompt to direct extra capability toward deeper investigation rather than longer plans (the implementer model is unchanged, so the planner–implementer capability gap is wider than usual). Follow-up Q&A (`processFollowUp`) always uses the `sonnet` tier regardless of the label.
The planner prompt emphasizes that implementation will run on a smaller model and
instructs the planner to produce a detailed, specification-grade plan (exact file
paths, concrete edits, named invariants and gotchas) to keep the implementer on
track. Attribution footers (`*Models used: <model> (provider: <provider>)*`) are
appended to plan comments and PR descriptions to record which model/provider was
actually used.

### Skip-If-Busy Scheduling

Jobs that fire while a prior instance is still running are silently dropped —
no queue pile-up. This is distinct from the Claude task queue; a job can be
"running" while waiting in the Claude queue.

### Smart Scheduling

Low-priority background jobs (doc-maintainer, improvement-identifier,
idea-suggester, issue-auditor, dependabot-alert-monitor, scanner-dispatcher,
stale-branch-cleaner, idea-reconciler) use smart scheduling via
`smart-schedule.ts` rather than fixed intervals — all eight are wired through the
`smartScheduledJob()`/`smartScheduledBatchJob()` factories in `main.ts`. Each smart-scheduled job fires
hourly (configurable via `smartScheduling.tickIntervalMs`) and uses
staleness-based per-repo selection via `selectReposForTick()`:

1. **Due repos** (`targetStalenessMs`, default 24h): only repos not processed
   within the target staleness window are candidates for this tick.
2. **Busy gate** (`isClawsBusy`): skips the tick if `work_queue` has active or
   pending agent tasks (excluding `ignoreBusyKinds` — PR agents and smart-schedule
   jobs themselves are excluded so they don't block each other).
3. **SLO escape valve** (`sloStalenessMs`, default 48h): if Claws is busy but one
   or more repos have exceeded the SLO threshold, only those SLO-breached repos are
   processed regardless of busy state. A throttled Slack warning fires when the
   escape valve engages.
4. **Concurrency cap**: `withSmartJobSlot()` limits concurrent repo processing to
   `smartScheduling.maxConcurrentJobTasks` (default 4).

Jobs call `db.markRepoProcessedDaily()` after each successful repo run.
Skip statuses (disabled repo, no work needed, etc.) do not consume a daily
slot — only actual processing does.

**Manual trigger bypass**: `shouldRunSmartJob(name, now, manual)` gates the tick. All
eight smart-scheduled jobs are present as keys of `smartScheduling.jobs` by default;
if a job name is not a key (e.g. a user-edited `config.json` removed one), the gate
always passes regardless of `manual` or the `smartScheduling.enabled` flag. For jobs
that *are* keys, a `manual` trigger (`POST /trigger/:job` or the dashboard button)
also always passes — the global kill-switch (`smartScheduling.enabled = false`) only
blocks their unattended, non-manual ticks. In every case, staleness-based repo
selection in `selectReposForTick()` still applies (repos already processed within
`targetStalenessMs` are not reprocessed by a manual trigger).

The `main.ts` `smartScheduledJob()` factory wires the gate check into the scheduler's
tick and registers the job with `tickIntervalMs` as the interval.

**Staleness-first ordering**: `selectReposForTick()` in `smart-schedule.ts` sorts due
repos by age descending — the most stale repo is processed first. A stable tiebreak by
`fullName` ensures deterministic ordering when ages are equal. Repos never processed for
a given job have age = `Infinity` and always sort first, preventing starvation.
`db.getLastProcessedTimestampsForJob(jobName)` provides the `Map<repo, epoch-ms>` used
for age computation.

### Worktree Isolation

Each task gets its own git worktree at
`~/.claws/worktrees/<owner>/<repo>/<job>/<branch>`. Both `createWorktree` and
`createWorktreeFromBranch` use `--no-track` to avoid `.git/config` lock
contention when concurrent worktree operations target the same repo. The job
namespace prevents path collisions. Read-only jobs (`pr-reviewer`, `qa-phase`) use
`--detach` mode to avoid git's one-branch-per-worktree restriction, allowing
multiple jobs to read the same branch simultaneously. Write jobs (`ci-fixer`,
`review-addresser`) check out the branch on a namespace-scoped local branch
(`claws-wt/<job>/<remoteBranch>`), with a defensive fallback to detached mode
if the branch is already locked by another worktree. `removeWorktree`
auto-detects and deletes `claws-wt/` scoped branches after worktree removal.
The main clone lives at `~/.claws/repos/<owner>/<repo>`. Worktrees are always
cleaned up in a `finally` block after each task. The higher-level
`withNewWorktree<T>(repo, branchName, namespace, fn)` and
`withExistingWorktree<T>(repo, branchName, namespace, fn)` helpers in
`claude.ts` own the full create + try/finally cleanup lifecycle, eliminating
the footgun of forgetting cleanup. `withExistingWorktree` returns `null` if
the branch doesn't exist (absorbed `BranchDeletedError`). Most agents have
been refactored to use these helpers instead of manual `createWorktree` +
`finally removeWorktree` patterns.

`createWorktreeFromBranch` validates that the remote ref exists (via
`git rev-parse --verify`) before creating the worktree. If the branch has
been deleted (e.g. after a PR merge), it throws `BranchDeletedError`. The
convenience wrapper `createWorktreeFromBranchIfExists` catches this error
and returns `undefined`, allowing callers to skip work items with deleted
branches without noisy error reports. All PR-processing agents (pr-reviewer,
ci-fixer, review-addresser, qa-phase) use `createWorktreeFromBranchIfExists`.

Every interactive session is spawned via tmux with `env: { ...process.env }`,
so `claude` always runs as the service user with the service's `HOME`,
whatever repo's worktree is the current directory. Claude Code resolves
Claude Code skills from both the project's `.claude/skills/` **and**
`~/.claude/skills/`, so a skill installed once at the user level (via
`deploy/install-skills.sh`, e.g. `/postmortem`) is available in every Claws
session in every managed repo, not just the `claws` repo. A skill meant to
run this way must not reference a claws-repo-relative path — it executes
inside a worktree of whichever repo the session is working on.

### Graceful Shutdown

On SIGINT/SIGTERM, `main.ts` cancels all queued (not yet started) Claude tasks,
drains running jobs (5-minute timeout), terminates any in-flight Claude
processes (5-second grace period), closes the database, and exits. The
`shutdown.ts` module provides a shared `isShuttingDown()` flag that prevents
the Claude queue from accepting new tasks during shutdown. Cancelled tasks
throw `ShutdownError` (a distinct error class), which the error reporter
suppresses — no Slack notifications or GitHub issues are created for shutdown
cancellations.

### Crash Recovery

At startup, any tasks still marked `running` in the database (from a previous
crash) have their worktrees cleaned up and are marked `failed`.

### Auto-Update & Rollback

`deploy/deploy.sh` runs every 60s via `claws-updater.timer` (systemd, outside
the Node process — this is what allows it to keep functioning and alerting
even while the `claws` service itself is crash-looping). Each tick: fetch the
latest GitHub release tag, skip if already current or previously
skip-listed (`$INSTALL_DIR/.skipped-versions`), download and extract the
release tarball to a staging dir, then:

1. **Node ABI gate (before touching the running service).** `release.yml`
   stamps the build's Node major into a `.node-version` file at the tarball
   root (via `process.versions.node`, not the hardcoded `setup-node` version,
   so it stays correct if that's bumped). `deploy.sh` compares it against the
   host's `node --version` *before* backing up or stopping anything. A
   mismatch (release tarballs bundle a prebuilt `node_modules/` with native
   modules like `better-sqlite3` compiled against the build's Node major, so a
   different host major fails `dlopen` at startup) aborts immediately, Slacks
   the operator with the fix (upgrade host Node, then remove the tag from the
   skip file), adds the tag to the skip list, and leaves the running version
   untouched — no downtime. A tarball with no `.node-version` (pre-feature
   release) skips the check with a warning rather than blocking. Added after a
   2026-07-18 incident where a Node-major bump reached the build before the
   host, causing `ERR_DLOPEN_FAILED` after the service had already been
   stopped and swapped.
2. **Backup, stop, swap.** `dist` → `dist.prev` (copy), then `node_modules` is
   backed up to `node_modules.prev` via rename (not copy — same filesystem,
   avoids doubling disk usage for a large tree) *during* the swap step, after
   the service is stopped. Both `.prev` trees are cleaned up on a successful
   deploy and restored together on rollback — a bug where rollback restored
   only `dist.prev` (leaving the old `dist` paired with a still-broken new
   `node_modules`) caused a rollback to fail to actually recover during the
   same incident.
3. **Health check + rollback.** Polls `GET /health` for up to 45s after
   restart; on failure, restores `dist.prev`/`node_modules.prev`, restarts,
   and polls again for up to 30s. A tag that reaches this rollback path (or
   the ABI gate above) is always added to the skip list, and a Slack message
   is sent once — the timer would otherwise re-alert every tick until a human
   intervenes.
4. **Persistent unhealthy reminder.** If the timer skips a skip-listed tag on
   a later tick, `remind_if_unhealthy()` checks `/health` again: if still
   failing, it Slacks a reminder at most once per hour (tracked via a
   `.unhealthy-alert-ts` timestamp file) rather than staying silent between
   the initial failure alert and manual intervention. The stamp is cleared as
   soon as the service reports healthy again (including on the next
   successful deploy), so a fresh outage alerts immediately rather than
   waiting out the old cooldown. This exists because during the 2026-07-18
   incident the only one-time "manual intervention required" Slack message
   was easy to miss, and claws itself couldn't escalate further since it was
   the thing that was down — the updater timer, running independently of the
   Node process, is the only component that reliably keeps checking.

See `deploy/deploy.sh` for the full script; `~/.claws/` (config, env, DB) is
never touched by any of the above.

### Transient Retry & Rate Limit Circuit Breaker

Both the `gh` CLI wrapper (in `github.ts`) and the `git()` helper (in
`claude.ts`) retry up to 3 times with exponential backoff (1s, 2s, 4s) on
transient network errors. The `gh` wrapper matches HTTP status codes (400, 401,
500, 502, 503, 504), timeouts, connection resets, "Could not resolve to a",
"TLS handshake timeout", "Something went wrong", Go TCP dial "i/o timeout",
`"invalid character"` (Go `encoding/json` errors from `gh` when GitHub's Checks
API returns a transitional response during an in-progress check), EAGAIN /
"failed to create new OS thread" / "resource temporarily unavailable" (OS-thread
exhaustion when `TasksMax` cgroup pressure prevents Go binaries from spawning
threads), `"unexpected EOF"` (TCP connection dropped before HTTP response arrived). `getPRCheckStatus` and `getPRChecksSummary` additionally catch
`"invalid character"` in their own `catch` blocks and degrade gracefully to
`"none"` rather than crashing the `processPR` task — the pr-dispatcher re-runs
every 5 minutes, so missing one cycle is invisible to the operator.
The `git()` helper matches HTTP 5xx, ETIMEDOUT, ECONNRESET, ECONNREFUSED,
EAGAIN, TLS handshake timeout, DNS failures, "i/o timeout", "failed to create
new OS thread", and "resource temporarily unavailable". The `gitRaw()` helper does not retry — callers
manage their own error handling.
Rate limit errors are handled separately: they trip a circuit breaker that
blocks all GitHub API calls for 60 seconds, throwing `RateLimitError`
immediately without retry. A single Slack notification is sent when the
circuit breaker trips, and another when the first API call succeeds after
cooldown expires. Jobs that iterate over repos short-circuit their loops via
`isRateLimited()` to avoid cascading failures during a rate-limit window.

### WhatsApp Pairing Notifications

The WhatsApp module sends Slack notifications on pairing state transitions,
following the same "notify once per state change" pattern as the rate limit
circuit breaker. A `lastNotifiedState` variable deduplicates notifications:
a "pairing required" alert is sent once when the session is lost (logout,
stale session, repeated connection failures), and a "connected" notification
is sent only if a prior pairing-required alert was active. User-initiated
actions (unpair, stop pairing) do not trigger notifications.

Two Baileys disconnect status codes are handled specially: **status 515**
(`restartRequired`) fires after post-pairing key exchange and is transient —
the handler reconnects after 1 second without incrementing `consecutiveFailures`
or triggering a re-pair cycle. **Status 440** (`connectionReplaced`) means
another WhatsApp session took over; the handler clears auth state and raises a
pairing-required alert. Without these guards, 5 consecutive 515 events after
re-pairing would trigger `clearAuthState()` and force another pair cycle.

`startPairing()` explicitly resets `lastNotifiedState = "pairing-required"`
after `stop()` (which resets it to `null`) so the `"connected"` Slack
notification fires correctly after the new session establishes.

WhatsApp connection events are persisted to the `whatsapp_events` SQLite table
and accessible at `GET /whatsapp/events` (JSON) and displayed on the WhatsApp
dashboard page as a "Recent Events" log.

### Error Reporting & Investigation Pipeline

Errors flow through two stages:

1. **Error reporter** (`error-reporter.ts`) — Uses a 30-minute cooldown per
   fingerprint. Recurrences edit the body of the existing `[claws-error]` issue
   (via `ensureAlertIssue()`) rather than opening new ones or adding comments.
   `ShutdownError`, `RateLimitError`, `TransientGitHubError`, `PushConflictError`,
   and select `AgentCliError` patterns (usage-limit, transient API 5xx) are
   filtered before any reporting. Source-level filtering also applies: the
   WhatsApp module's Baileys logger suppresses transient errors (keep-alive
   timeouts, stream errors, bad-request) at warn level before they reach the
   reporter. When Baileys uses structured logging (object + message string),
   `baileysLogger.error` also checks `obj.err` against `TRANSIENT_MESSAGES` —
   this catches cases where the human-readable `msg` differs from the underlying
   error value (e.g. `"unexpected error in 'init queries'"` with `err: "bad-request"`).
2. **Triage** (`triage-claws-errors.ts`) — Discovers `[claws-error]` issues
   by title pattern (no label required), runs two-phase deduplication (by
   fingerprint before investigation, then by root cause after), and posts an
   investigation report. Reads `docs/OVERVIEW.md` for context and identifies
   related issues that share the same root cause. Every investigation prompt
   requires Claude to end its output with a `RELATED_ISSUES: <numbers|none>`
   sentinel. `isReportTruncated(output)` checks for this sentinel; if absent,
   the investigation is retried once with a fresh `runClaude` call. If the
   retry output is also truncated, the task is recorded as complete with zero
   commits (no comment is posted) so that no `REPORT_HEADER` is written and the
   next scheduled triage run picks the issue up again — avoiding a permanently
   truncated report being posted.

### CI-Fixer Circuit Breaker

The ci-fixer includes a circuit breaker to prevent infinite automated fix
attempts on PRs where CI continues to fail despite multiple attempts.
Configuration via `ciFixerCircuitBreaker` in `config.json`:

| Config key | Default | Description |
|---|---|---|
| `maxAttempts` | `5` | Maximum CI fix attempts per PR within the window |
| `windowMs` | `86400000` (24h) | Time window for counting attempts |
| `maxConsecutiveFailures` | `3` | Maximum consecutive failures before tripping |

When thresholds are exceeded, the PR is marked as problematic:
- Further automatic CI fix attempts are skipped
- A comment is posted on the PR explaining the situation
- The PR appears in a "Problematic PRs" section on the `/queue` dashboard page
- Manual unmarking is available via `POST /queue/unmark-problematic`

Attempt counting is database-backed via `countCIFixerAttempts()` in `db.ts`,
which queries the `tasks` table for CI fixer attempts per PR within the
configurable window and returns `{ total, failed, successful, transientApiFailed }`
— transient API failures (4xx/5xx infrastructure errors) are counted separately
so they don't unfairly trip the circuit breaker. The `Claws Problematic` label
is applied to flagged PRs.

After the label is applied, `pr-dispatcher` enqueues a one-shot
**problematic-PR diagnosis pass** (`ci-fixer:problematic` kind →
`src/agents/problematic-pr-diagnoser.ts`). The diagnoser first checks whether
CI has already recovered before running any rounds: if `getFailedRunLog()`
returns empty, it calls `getFailingCheck()` and — if no check is failing —
calls `getPRCheckStatus()`; when the status is `"passing"` or `"none"`, it
immediately resolves as `success` and removes the label (CI recovered between
the label being applied and the diagnosis pass running — e.g. a flaky check
passed on retry, a transient infra failure cleared, or a manual fix landed).
The dedup guard that prevents re-running the diagnoser once a final report comment
exists (`DIAGNOSIS_COMMENT_MARKER`) now also clears the `Claws Problematic` label
before short-circuiting, via `clearStaleProblematicLabelIfGreen()` — this handles
the case where CI recovered on its own (flaky check passed on retry, transient infra
cleared, manual fix landed) after the diagnosis report was posted. Without this,
a PR that goes green post-diagnosis keeps the stale label forever because the marker
blocks every future diagnosis pass.

Only when CI is genuinely still failing does the diagnoser run up to
`MAX_ROUNDS` (3) deeper-diagnosis rounds: each round invokes Claude with the
full failure-log + recent-error history and an explicit instruction to take a
more thorough approach (consider reverting earlier ci-fixer commits, merging
the base branch, etc.). When Claude produces commits the diagnoser pushes the
branch and polls CI for up to 30 min per round (`getPRHeadSHA` +
`getFailingCheck` + `getPRCheckStatus`). On success it removes the
`Claws Problematic` label so the PR re-enters the normal flow; on failure or
exhaustion it posts a single final report comment (marker:
`problematic-pr-diagnosis-report`) that the dedup guard uses to prevent
re-entry. Each round records its own task with `job_name = 'ci-fixer:problematic'`
so the round-by-round logs are visible at `/logs/issue?repo=...&number=...`.
Fork PRs and `[ci-unrelated]` fix PRs are skipped — the diagnoser can't push to
forks, and `[ci-unrelated]` PRs are already a downstream remediation path.

### CI-Fixer Two-Phase Design

The ci-fixer uses a two-phase identify/process pattern (matching the pattern
used by improvement-identifier and issue-refiner):

1. **Identify**: Scans all PRs, checks merge state, CI status, and classifies
   failures — collects typed `WorkItem` entries (a discriminated union with
   variants: `conflict`, `rerun`, `unrelated`, `fix`)
2. **Process**: Groups unrelated failures by repo (structural dedup — one
   consolidated issue per repo), then processes remaining items concurrently

This eliminates race conditions when multiple PRs in the same repo have
unrelated CI failures — without the grouping, concurrent `searchIssues` +
`createIssue` calls would produce duplicate issues.

Reruns are emitted both for cancelled/startup-failure workflows and when
failure log fetching returns empty (the `getFailedRunLog` two-tier fallback —
CLI then REST API — both returned no output). Each no-log cycle is handled by
`handleMissingFailLog()`, which records a `ci-fixer` task failure with
`failureCategory: "logs-unavailable"`. This counts toward the circuit
breaker's `nonTransientFailed` counter (only `transient-api` rows are
excluded), so a PR whose logs are permanently unfetchable trips the breaker
after `maxConsecutiveFailures` cycles rather than looping indefinitely.
Benign "already running" errors (a harmless race condition where the workflow
restarted between detection and rerun) are caught and logged at info level
rather than reported as errors. Non-rerunnable workflows (`"cannot be rerun"`
/ `"Resource not accessible"` from GitHub — e.g. runs older than 30 days, or
runs the App lacks rerun permissions for) are logged at warn level and also
not reported as errors; these are expected terminal conditions, not Claws bugs.

**`[ci-unrelated]` fix PRs**: When ci-fixer processes a PR whose title
contains `[ci-unrelated]` (i.e., a PR created by issue-worker to fix a
`[ci-unrelated]` issue), it skips the classification step entirely and treats
all CI failures as related. Without this guard, the classifier would see the
pre-existing failures, classify them as "unrelated to the PR's changes", and
the PR would stall indefinitely in a loop of filing redundant issues and
reverting fix attempts. Errors on these PRs are posted as comments directly
on the PR rather than creating `[claws-error]` issues.

### No-Commit Feedback

When the implementer (issue-worker) runs but produces zero commits, it first
calls `diagnoseNoCommits(wtPath, baseBranch)` in `claude.ts` — a cheap Claude
invocation that inspects `git status`, `git log`, and `git diff --stat` to
produce a 1–3 sentence diagnosis (e.g. "implementation already appears complete",
"files were edited but not committed"). The diagnosis is injected as a
`**Diagnosis:**` block into the `## No changes produced` comment. If the
diagnostic call fails, the comment is posted without it (`.catch(() => null)`
guard). The comment is deduplicated per phase via a `no-commit:${currentPhase}`
plain-text marker — if a prior comment for the same phase already exists, no
new comment is posted. The `Refined` label is removed before the comment is
posted, preventing re-entry until the user explicitly retries.

### Multi-Phase Plan Validation

After a multi-phase plan's PR is merged, the issue-worker runs
`validateAndUpdatePlan()` which compares the completed phase's plan text
against the actual PR diff using Claude. If significant deviations are
found, the plan comment is updated in-place so subsequent phases have an
accurate picture of reality. The update is tracked via a
`plan-updated-after-phase:N` plain-text marker (deduplication —
each phase only triggers one update). Validation failures are caught and
logged but never block phase advancement.

**Phase overflow protection**: `currentPhase` is derived from the count of
merged PRs for the issue (`mergedPRs.length + 1`). If this exceeds
`totalPhases` (can occur after plan edits reduce phase count, or out-of-order
merges), `processIssue()` returns early and removes the `Refined` label —
allowing the planner to re-refine with an updated phase count. All three
build helpers (`buildPrompt()`, `buildPRTitle()`, `buildPRBody()`) include
defensive bounds checks on `plan.phases[currentPhase - 1]` as a second guard.

### CI & Codebase Infrastructure Monitoring

The `runner-monitor` job runs independently. The remaining nine scanners
(ubuntu-latest, concurrency, migration, main-build-monitor, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, gitignore) run sequentially via `scanner-dispatcher`:

- **runner-monitor**: SSHes to configured self-hosted GitHub Actions runner
  hosts on a 10-minute interval. Checks service health (restarts dead `svc.sh`
  services), detects zombie/stale Runner.Worker processes (kills orphaned
  processes older than 6 hours only if the runner service is down), and
  monitors disk usage with tiered cleanup: Tier 1 (>85%) runs basic cleanup
  (temp files, `docker system prune -f`, `docker image prune -af --filter 'until=24h'`
  to remove tagged CI images older than 24 hours, journal vacuum); Tier 2 (>90%) adds
  aggressive cleanup (all unused Docker images + volumes, tool cache). The
  `until=24h` filter keeps in-use images (active CI runs) safe while reclaiming
  tagged-but-old build cache images that `docker system prune` misses. After
  cleanup, if disk is still >90%, `getDiskBreakdown()` fetches a disk usage
  breakdown and either comments on an existing open `[runner-monitor] Persistent
  high disk` issue or creates a new one (label: `runner-maintenance`).
  `getDiskBreakdown()` uses sequential per-probe SSH calls (60s timeout each
  via the optional `timeoutMs` parameter of `sshExec`) instead of a single
  bundled command — probes include `df -h /`, `du -sh` per directory, top
  docker images by size, and `docker system df`; each probe is wrapped in its
  own `try/catch` so a slow probe does not abort the rest. Actions taken are
  reported via Slack. Runner hosts are configured with baked-in defaults
  (two Hetzner servers, overridable via `runners` in `config.json`).
  **Security**: `actionsDir` is validated against a safe-path regex
  (`/^\/[a-zA-Z0-9._/-]+$/`) both in the Zod config schema and at runtime
  via `assertSafeActionsDir()` before any SSH command that interpolates it.
  This is defense-in-depth against the Zod schema being bypassed by the
  `safeParse` fallback path in config loading.
- **ubuntu-latest-scanner**: Daily scan of `.github/workflows/*.yml` files in
  all cloned repos. Detects `runs-on:` values matching known GitHub-hosted runner
  patterns (`ubuntu-*`, `windows-*`, `macos-*`) and creates a deduped alert issue in the
  offending repo with the `Priority` label. Skips commented-out lines and handles both direct string and
  array forms of `runs-on`. Custom self-hosted runner labels (e.g. `ryzen`,
  `arm64`) are not flagged — detection is positive-match only, not a
  `self-hosted`-string check. Expression syntax (`${{ matrix.os }}`) is **not**
  flagged — runtime expressions are indeterminate at static analysis time and
  flagging them unconditionally produces false positives. False positives are
  treated as worse than false negatives for this scanner.
- **concurrency-scanner**: Daily scan of `.github/workflows/*.yml` files in
  all cloned repos. Detects three classes of concurrency misconfiguration:
  (1) missing top-level `concurrency:` groups — only flagged when
  `workflowBenefitsFromConcurrency()` returns `true` (PR-relevant triggers:
  `pull_request`, `pull_request_target`, `merge_group`; or `push` to non-default
  branches — bare `push` or `push` with non-`{main,master}` branch filters;
  `schedule`, `workflow_run`, `release`, and other event-only workflows are
  not flagged because per-branch cancellation provides no value there); also
  suppressed if any job uses dynamic concurrency (e.g., Vercel preview
  deployments with per-deployment groups, indicated by `${{ }}` in a job-level
  concurrency key), (2) job-level concurrency groups using static names (no
  `${{ github.ref }}` interpolation) **only** when `cancel-in-progress: true`
  (intentional serialization with `cancel-in-progress: false` is not flagged),
  and (3) `deployment_status`-triggered workflows using `${{ github.ref }}` in
  concurrency groups — `github.ref` always resolves to the default branch for
  deployment events, creating a global mutex across all PRs. Creates a deduped
  alert issue per repo with recommended fixes and the `Priority` label.
- **migration-scanner**: Daily scan of all cloned repos for directories
  containing incrementally-numbered migration files (e.g. `001_create_users.sql`).
  Detects migration directories via common paths (`migrations/`,
  `db/migrations/`, etc.) plus a shallow recursive scan (up to 4 levels deep)
  for any directory named `migrations`. Files with numeric prefixes of 6 or
  fewer digits are classified as incremental; 8+ digit prefixes that
  resemble dates or 10+ digit prefixes that resemble Unix timestamps are
  classified as date-based. If any date-based file exists in a directory
  (even alongside incremental files), the directory is considered
  mid-transition and is not flagged. Creates a deduped alert issue per repo
  with the `Priority` label, a table of violations, and recommended convention: `YYYYMMDDHHMMSS_description.ext`
  filenames, directory scanning (no barrel file), `schema_migrations` table
  for tracking, and out-of-order application support.
- **main-build-monitor-scanner**: Daily scan of `.github/workflows/*.yml` files
  in all cloned repos. Identifies workflows that run automatically against the
  `main` branch: push-triggered builds (handling inline `on: push`, array, and
  block forms, including `branches:` and `branches-ignore:` filters) **and**
  `schedule`-triggered workflows (which always execute against the default
  branch). `workflow_dispatch`-only workflows are excluded — those are
  human-initiated and observed by the operator. Checks whether a dedicated
  `notify-failures.yml`-style workflow exists with a `workflow_run:` trigger
  whose `workflows:` list covers every monitored workflow AND which creates a
  GitHub issue on failure (detected by the presence of `gh issue create` and
  `failure` in the file body). If any monitored workflow is unmonitored, files
  a deduped alert issue with the `Priority` label. When no monitor workflow
  exists at all, the issue body includes a recommended `notify-failures.yml`
  template (patterned after the production-infra example) listing all
  monitored workflows in the `on.workflow_run.workflows` list. When a partial
  monitor exists, prompts the implementer to extend its `workflows:` list.
  Skips repos with no push-to-main or scheduled workflows entirely to avoid noise.
- **cache-on-self-hosted-scanner**: Daily scan of `.github/workflows/*.yml` files
  in all cloned repos. Identifies jobs whose `runs-on` is a self-hosted runner
  and flags any cache-related step uses inside those jobs (`actions/cache`,
  `setup-*` actions with cache options). Self-hosted runners persist their
  workspace and caches between runs, making these steps redundant. Creates a
  deduped alert issue per repo with the `Priority` label. Uses `workflow-parser.ts`
  `JobInfo.steps` to inspect step `uses` fields and `StepInfo.with` for cache
  configuration keys.
- **issue-comment-spam-scanner**: Daily scan of `.github/workflows/*.yml` files
  in all cloned repos. Detects workflows that create new issues for failures
  (`gh issue create`) and then post new comments on recurrence (`gh issue comment`)
  — this produces comment spam in alert issues. The scan uses raw text matching:
  flags files that contain both `gh issue create` and `gh issue comment` but do NOT
  already contain `gh issue edit`, `**Occurrences:**`, or `**First seen:**` (already
  migrated). Files where the only `gh issue comment` usage is within a `close --comment`
  invocation are not flagged. Creates a deduped alert issue per repo with a
  recommended fix (`gh issue view` + `awk` body-edit + `gh issue edit` pattern).
- **runner-os-scanner**: Daily scan of `.github/workflows/*.yml` files in all
  cloned repos. Flags jobs whose `runs-on` contains `self-hosted` but no OS label
  (`linux` or `macos`, case-insensitive). Jobs using dynamic expressions (`${{ … }}`)
  or custom non-`self-hosted` labels are not flagged. Creates a deduped alert issue
  per repo with the `Priority` label. Issue title: `Alert: self-hosted runner jobs
  missing OS label`. Uses `workflow-parser.ts` `JobInfo.runsOn` to inspect runner labels.
- **claude-config-scanner**: Daily scan of all cloned repos. Checks each repo for four
  required files: `CLAUDE.md` at the repo root, `.claude/agents/issue-refiner.md`,
  `.claude/agents/issue-implementer.md`, and `.claude/agents/pr-reviewer.md`. These are
  the minimum Claude agent configuration Claws needs to delegate issue refinement,
  implementation, and pull request review to repo-tailored subagents. If any are missing,
  files a combined alert issue per repo listing only the absent files as an actionable
  checklist. Uses `fs.existsSync` for each check (symlinks are acceptable). Alert title:
  `Alert: missing Claude agent configuration`.
- **gitignore-scanner**: Daily scan of all cloned repos. Checks whether `.mcp-claws.json`
  appears as its own line in `.gitignore` (treating a missing `.gitignore` as equivalent to
  an empty one). Files an **unlabeled** chore issue per repo with issue title
  `chore: add .mcp-claws.json to .gitignore` when the entry is absent. Uses
  `ScannerSpec` without a `label` field (the only scanner that does so — all others use the
  `Priority` label). Extracted from `repo-standards.ts` (#1453) to follow the standard
  `ScannerSpec`/`runRepoScanner` pattern.
- **dependabot-config-scanner**: Daily scan of all cloned repos. Walks each repo (max depth 3)
  for dependency manifests, mapping them to Dependabot `package-ecosystem` values, and compares
  them against `.github/dependabot.yml` as **(ecosystem, directory) pairs** — not by ecosystem
  alone, so a separate project like `bonkus`'s `apps/mobile` is not masked by a root-only entry.
  npm directories are anchored on lockfile presence, which drops workspace members covered by a
  root lockfile (emitting entries for those yields a config Dependabot errors on). Repos with no
  manifests, a Renovate config, or a committed `.claws/dependency-updates-optout` are left alone;
  an unparseable `dependabot.yml` logs a warning rather than filing an alert. Files a `Priority`
  issue containing the exact YAML to add, which the normal issue pipeline turns into the PR.
  Alert title: `Alert: missing dependency-update configuration`. Note Dependabot *alerts* are an
  org default needing no config — *version updates* are what this file enables. See
  [docs/jobs/dependabot-config-scanner.md](jobs/dependabot-config-scanner.md).
- **k3s-monitor**: Runs every 15 minutes. Uses `kubectl get pods/nodes` to detect
  failing pods and unhealthy nodes in the k3s cluster, and additionally fetches
  Flux `Kustomization` and `HelmRelease` resources (best-effort — Flux may not
  be installed) to detect reconciliation failures. When a `kubectl` call fails
  with a stale-kubeconfig error (unreachable endpoint, expired cert, etc.) and
  `kubeconfigRefresh` is configured, the monitor calls `refreshKubeconfig()` from
  `kubeconfig-refresh.ts` to fetch a fresh kubeconfig from the remote host via
  SSH before retrying — this handles cluster rebuilds that change the endpoint or CA. Both Flux resource kinds share
  the same detection logic: `DependencyNotReady` resources are suppressed
  entirely (checked first) — these are always cascade noise: the named
  dependency raises its own alert if genuinely stuck, and the dependent
  self-heals within one Flux `retryInterval` if merely mid-reconcile. This
  suppression applies to both Kustomizations and HelmReleases on both clusters
  (prod-k8s-monitor reuses the same `detectFluxAlerts` function). A
  `Ready=False`/`Unknown` condition then triggers an alert after a 2-minute
  grace period (to ride out transient reconciliation hiccups), **except**
  reasons in `TERMINAL_FLUX_FAILURE_REASONS` (currently just
  `HealthCheckFailed`), which bypass the grace period since they represent a
  *concluded* failure — a Kustomization with `wait: true` health-checking a
  Failed Job fails fast every `retryInterval`, flapping `Ready`
  `False→Unknown→False` and refreshing `lastTransitionTime` on each flip,
  which previously kept the condition permanently inside the grace window and
  suppressed a 6-hour prod chain wedge with zero alerts (#1989, #1990).
  All new alert issues are created with the `Priority` label so they are fast-tracked
  through the Claws issue pipeline (issue-worker propagates the label to its fix PRs).
  All alerts are raised as issues in `FLEET_INFRA_REPO`. On recurrence, updates
  the existing issue body with occurrence tracking (`**First seen:**` /
  `**Last seen:**` / `**Occurrences:**` appended as a `---`-separated block at
  the end of the body) rather than posting repeated comments. Retroactively adds
  tracking to pre-existing issues that lack it. Can be disabled via
  `k3sMonitorEnabled: false` in config. **`kubectlExec` timeout errors** include
  the server URL extracted lazily from the kubeconfig file (via `extractKubeconfigServer()`,
  regex-based, no YAML parser) so timeout messages name the unreachable cluster endpoint
  rather than giving a generic error — the path itself is never logged. **Ignored-node
  suppression** is nuanced: node health alerts for ignored nodes are unconditionally suppressed
  (even when `NotReady`); pod alerts for pods on ignored nodes are suppressed
  only while that node is actually `NotReady` — when the node is `Ready`, pod
  failures on it are reported normally. If the node-status fetch fails, the
  monitor conservatively treats all ignored nodes as down (fallback to full
  suppression). **Pod alert dedup keys** are derived by `workloadNameForPod()`
  using `metadata.ownerReferences` when present: Job pods use the Job name,
  ReplicaSet pods strip the trailing pod-template-hash to recover the
  Deployment name, StatefulSet/DaemonSet pods use the owner name directly.
  This is robust to all-alpha (digit-free) pod-template hashes that the
  legacy `podWorkloadName()` regex-strip missed, which previously caused
  duplicate `[k3s] Pod Failed` issues for the same workload.
  `podWorkloadName()` remains as the fallback for bare pods with no controller
  owner.
  **Same-run dedup**: after all alert arrays are assembled, `dedupeAlertsByTitle(alerts)` collapses entries sharing the same title to a single alert (keeping the first, which for pod alerts is the log-enriched one). Without this, workloads with multiple failing pod replicas (e.g. a Kubernetes Job) would produce N identical-titled alerts in one monitor run — each calling `ensureAlertIssue`, which uses GitHub's search index and cannot see an issue created milliseconds earlier in the same run, causing N duplicate issues. The status counters (`podAlertCount`, `nodeAlertCount`, `fluxAlertCount`) are computed from pre-dedup arrays and report what was detected; only the raise loop operates on the deduped list.
  See [k3s-monitor](jobs/k3s-monitor.md) for details.

### GitHub Actions Concurrency & Runner Priorities

GitHub Actions has no native job priority system. The "higher priority waiting
request" cancellation message comes from GitHub's concurrency model, not from
any configurable priority setting. When multiple jobs share the same
concurrency group (e.g. `group: self-hosted-runner` without per-branch
scoping), only one runs at a time across all branches. With multiple open PRs,
jobs queue up and get cancelled by newer pushes — producing systemic CI
failures.

Claws mitigates this in several ways:

- **Concurrency groups in own workflows**: `ci.yml` uses
  `group: ci-${{ github.ref }}` (per-branch, cancel-in-progress) and
  `release.yml` uses `group: release` (never cancel — only triggers on main).
- **Throttled reruns in ci-fixer**: When 3+ PRs in the same repo have
  cancelled checks, ci-fixer throttles to 1 rerun per repo per cycle
  (prevents cascade while still making progress). Priority-labeled PRs
  are rerun first.
- **Priority-aware rerun ordering**: Reruns that pass bottleneck filtering are
  processed sequentially with a 2-second stagger. PRs with the `Priority`
  label are re-run first.
- **Concurrency scanner**: Daily scan detects misconfigured concurrency groups
  across all managed repos and files advisory issues with recommended fixes.

The `Priority` label affects Claws' internal Claude task queue and ci-fixer
rerun ordering, but cannot control GitHub's runner allocation.

### Image & Attachment Context

When processing issues or PR reviews, `images.ts` extracts embedded image
references and GitHub file attachments from the text, downloads them, and
appends prompt sections so Claude can view images and read attached files.
Images are saved into the worktree; text attachments are inlined in the
prompt. This is used by issue-refiner, issue-worker, and review-addresser.

### Parallel Repo Processing

Both `issue-dispatcher` and `pr-dispatcher` process repos concurrently using
`Promise.allSettled(repos.map(...))`. One failure in a repo does not block
others. The rate-limit circuit breaker check at the start of each repo callback
short-circuits only that repo — other repos proceed normally.

### Fast-Checks Guidance

`agent-context.ts` exports `FAST_CHECKS_GUIDANCE` (injected into issue-worker
and review-addresser prompts) and `CI_FIXER_FAST_CHECKS_GUIDANCE` (injected into
ci-fixer prompts). Both instruct Claude to prefer fast local checks (type-check,
lint, unit tests) and skip slow ones (integration tests, Docker, external
services) — CI is the source of truth for slow checks. The ci-fixer variant
notes that CI reruns automatically on push rather than "after the PR is opened".

`RUNNER_POLICY_CONTEXT` (also in `agent-context.ts`) is injected into all three
issue-refiner prompt builders (fresh plan, refinement, follow-up), both
issue-worker prompt builders, and both pr-reviewer prompt builders
(`buildStandardReviewPrompt` and the per-file `filePrompt` for large PRs).
It instructs Claude not to suggest or add GitHub-hosted runners
(`ubuntu-latest`, `windows-latest`, `macos-latest`, etc.) — this organisation
uses only self-hosted runners due to cost, with no macOS exception. The
constant also instructs agents to always include an OS label when using
`self-hosted` runners (`[self-hosted, linux]` or `[self-hosted, macos]`),
mirroring the enforcement done by the `runner-os-scanner` detector. Together,
these constants apply the runner policy proactively at plan/implementation/review
time rather than reactively after a violation is committed.

### Documentation as Context

Issue-refiner, issue-worker, improvement-identifier,
idea-suggester, and triage-claws-errors prompts instruct Claude to read
`docs/OVERVIEW.md`
(and linked docs) before starting work. This gives Claude accumulated
architectural context about each repository.

### Client TypeScript Pipeline

Client-side JavaScript is authored as TypeScript in `src/client/*.ts` and
compiled/bundled by `scripts/build-client.mjs` (esbuild) into
`src/resources/*.generated.ts` constants. The pattern mirrors
`tailwind-css.generated.ts`: each generated file exports a string constant
containing an inline `<script>…</script>` block, which page builders
interpolate directly into HTML. `tsconfig.client.json` type-checks client
sources with DOM libs; the generated `.ts` files are excluded from the main
server `tsconfig.json`. The `npm run build:client` script type-checks then
bundles; `npm run build` runs `build:client` first. Generated files are
checked into the repo so CI and production require no extra build step beyond
`npm run build`.

### Prompt Resource Injection

The idea-suggester's `buildPrompt()` accepts a `resources` parameter for
injecting reference material into prompts. Currently used to provide
marketing strategy knowledge (from `src/resources/marketing.ts`, sourced
from the Marketing-for-Founders repository) so Claude considers marketing
tactics when suggesting ideas. The resource is inlined as a TypeScript string
constant to avoid runtime file I/O and build-path issues.

### Branch Naming

| Agent / Job | Pattern |
|-----------------|---------|
| planner (issue-refiner) | `claws/plan-<N>-<hex4>` |
| implementer (issue-worker) | `claws/issue-<N>-<hex4>` |
| ci-fixer / review-addresser | Uses existing PR branch |
| triage-claws-errors | `claws/investigate-error-<N>-<hex4>` |
| doc-maintainer | `claws/docs-<YYYYMMDD>-<hex4>` |
| improvement-identifier | `claws/improve-<hex4>` (analysis worktree only; no PR is opened) |
| idea-suggester | `claws/ideas-<hex4>` |
| idea-collector | `claws/ideas-collect-<hex4>` |
| idea-reconciler | `claws/ideas-reconcile-<hex4>` |

### PR Title Conventions

- `fix: resolve #N — <title>` — single-PR issue implementations
- `fix(#N): <phase title> (X/Y)` — multi-PR issue phases
- `docs: update documentation for <repo>` — doc maintenance
- `[claws-ideas] Collected idea responses for <repo>` — idea collection
- `[claws-ideas] Reconcile closed ideas for <repo>` — idea reconciliation

### Issue Title Conventions (Claws-created)

- `security: <title>` — security finding raised by improvement-identifier (one issue per finding; deduped by title prefix)
- `<title>` (raw) — improvement finding filed by improvement-identifier (one issue per finding; no prefix added)
- `Alert: self-hosted runner jobs missing OS label` — runner-os-scanner alert
- `[runner-monitor] Persistent high disk` — runner-monitor disk alert
- `[claws-error] <fingerprint>` — internal Claws error reports
- `[disallowed-actor] @<login> is blocked from Claws automation` — filed in `SELF_REPO` when the issue-dispatcher skips an issue whose author is not in `ALLOWED_ACTORS` (and is not a CI failure alert); one issue per actor, occurrence-tracked so the body is updated rather than new comments posted

### Duplicate PR Guards

PR-creating jobs check for existing open PRs before creating new ones to
prevent pile-up when previous PRs haven't been merged:

- **doc-maintainer**: Skips if an open `claws/docs-*` PR exists
- **improvement-identifier**: Skips analysis entirely if both an open `security: ` issue and an open `claws/improve-*` PR exist (legacy guard; no longer triggered since improvement PRs are no longer opened). Skips security filing if any `security: ` issue is open. Skips improvement issue filing if security findings were filed this tick
- **idea-suggester**: Skips if a pending ideas file exists (previous batch
  still awaiting collection)
- **idea-reconciler**: Skips if an open `[claws-ideas]` reconciliation PR
  already exists for the repo
- **ci-fixer**: Uses consolidated per-repo `[ci-unrelated]` issues rather
  than per-fingerprint issues, so all unrelated CI failures for a repo
  are tracked in a single issue

### Item Skip & Prioritize

Individual issues/PRs can be skipped or prioritized via `skippedItems` and
`prioritizedItems` in `config.json` (arrays of `{repo, number}`), or via
the dashboard queue page buttons (`POST /queue/skip`, `/queue/prioritize`).
Skipped items are excluded from all job processing via `isItemSkipped()`.
Prioritized items are processed before others in job queues via
`isItemPrioritized()`. Both lists are hot-reloadable.

### Per-Repo Job Disabling

Individual jobs can be disabled for specific repos via `disabledJobsByRepo` in
`config.json` (a `Record<string, string[]>` mapping repo full names to arrays
of job names) or via the `/jobs` matrix page in the dashboard. The matrix UI
shows repos on one axis and jobs on the other with checkboxes. Changes are
written to `config.json` and hot-reloaded. `isJobDisabledForRepo(jobName,
repoFullName)` is called in each job's `run()` function to filter out disabled
repos before processing. For example, `ci-fixer` can be disabled per-repo this
way to suppress automated CI fix attempts on repos where manual intervention is
preferred.

**Opt-in jobs** (`OPT_IN_JOB_NAMES`): some jobs are disabled by default for all
repos and require explicit opt-in via `enabledJobsByRepo` in `config.json`. Currently
`main-build-monitor-scanner` is the only opt-in job — it is suppressed unless a repo
explicitly lists it in `enabledJobsByRepo[repoFullName]`. `isJobDisabledForRepo()`
handles both lists: a job is disabled if it appears in `disabledJobsByRepo` for the
repo, or if it is in `OPT_IN_JOB_NAMES` and the repo is not in `enabledJobsByRepo`.

### Job Pause/Resume

Individual jobs can be paused and resumed via the dashboard (`POST /pause/:job`)
or pre-configured via `pausedJobs` in `config.json`. Paused jobs skip their
scheduled ticks but can still be triggered manually.

### Disabled Agents

Agents within `issue-dispatcher` and `pr-dispatcher` can be individually disabled
via `disabledAgents` in `config.json` (array of agent names) or via the config
page checkboxes. Valid agent names: `planner`, `implementer`, `ci-fixer`,
`review-addresser`, `reviewer`, `merger`. A disabled agent's phase is silently
skipped — the parent agent job still runs and processes other phases. Legacy
`pausedJobs` entries for the old job names are automatically migrated to
`disabledAgents` on config load.

### Push Branch Concurrency

`pushBranch()` in `claude.ts` uses a fetch-rebase-push retry loop (up to 3
attempts) to handle concurrent pushes to the same PR branch. The initial
`git fetch` uses an explicit refspec (`refs/heads/${branchName}:refs/remotes/origin/${branchName}`)
rather than passing `branchName` bare — `branchName` is `pr.headRefName`, an
attacker-controlled GitHub value (a PR author can name their branch e.g.
`--upload-pack=...`), and `execFile` runs `git` without a shell so this isn't
shell injection but is git **option injection**: a bare argument starting
with `-` is parsed by git as a flag rather than a ref name. Prefixing with
the literal `refs/heads/` makes the token unparseable as an option (#1861).
When multiple jobs operate on the same branch (e.g. review-addresser and ci-fixer),
non-fast-forward rejections are resolved by fetching the latest remote state,
rebasing local commits on top (using `--rebase-merges` to preserve merge
commit topology), and retrying. The `--rebase-merges` flag is critical when
ci-fixer's `resolveConflicts()` creates merge commits — without it, plain
rebase would decompose merge commits into individual constituent commits,
causing conflicts. For new branches (where fetch fails because the branch
doesn't exist on the remote yet), rebase is skipped and push proceeds
directly. When a rebase conflict occurs, `pushBranch` falls back to merging
the remote branch — this handles the common case where both sides
incorporated the same upstream changes via different merge paths. If the
merge also conflicts, the operation aborts with a `PushConflictError` — a named error class that the error reporter suppresses (logs at warn, does not create a `[claws-error]` issue) since this is a transient race resolved by the next dispatcher cycle.

As a defense-in-depth measure, the pr-dispatcher skips review-addresser
for PRs with active ci-fixer work in the same cycle. During Phase 1
(identification), the dispatcher collects PR numbers that have `fix` or
`conflict` ci-fixer tasks. Phase 3 (review-addresser) skips those PRs
with a `continue` guard — they are picked up on the next cycle (~60s
later). This prevents concurrent pushes to the same branch. The
dispatcher also skips CONFLICTING PRs in the review-addresser phase,
since ci-fixer handles conflict resolution.

### Commit Tag

Doc-maintainer commits include `[doc-maintainer]` in the message. This is used
by `getLastDocMaintainerSha()` to detect whether docs are already up-to-date.

### Per-Item Timeout Escalation

When a Claude process times out on a specific issue/PR, the
`timeout-handler.ts` module:

1. Counts recent timeouts for that item (2-hour sliding window via
   `db.countRecentTimeouts()`)
2. If fewer than 3 timeouts: escalates the per-item timeout by 1.5x (capped
   at 6 hours), persisted in `itemTimeoutOverrides` config
3. If 3+ timeouts: auto-skips the item via `gh.skipItem()` (adds to
   `skippedItems` config and removes from queue cache)
4. Posts a comment on the source issue/PR via `reportTimeoutOnItem()` with
   timeout count, escalation details, and skip status

Jobs call `getItemTimeoutMs()` before invoking Claude to retrieve any
per-item override. `getItemTimeoutMs()` applies a floor at the global
`CLAUDE_TIMEOUT_MS` default — legacy overrides from previous lower-default
eras are silently ignored so items aren't cut short. All jobs that invoke
Claude must use both `getItemTimeoutMs()` (before invocation) and
`handleTimeoutIfApplicable()` (in error handlers) for consistent timeout
tracking and escalation.

### Plain-Text Markers (No HTML Comments)

Claws does not use HTML comments (`<!-- ... -->`) as machine-readable markers.
All structured markers in GitHub comments and PR bodies are plain text:

- `review-addressed: <SHA>` — review-addresser marks addressed feedback (backward-compatible regex handles legacy HTML-comment form in old comments)
- `Reviewed commit: \`<SHA>\`` — pr-reviewer records the last-reviewed commit
- `recommended-model: sonnet` / `recommended-model: opus` — pr-reviewer's model hint
- `review-provider: openrouter` / `review-provider: claude` — legacy marker from a previous OpenRouter routing experiment; no longer written but still parsed for backward compatibility (strips the marker from displayed comment text)
- `plan-updated-after-phase:N` — plan-parser deduplication marker
- `no-commit:<phase>` — dedup marker in issue-worker no-commit feedback (one per phase; `no-commits-warning` global marker removed in #851)
- `CLAWS_PLAN_OCCURRENCES: N` — appended to every plan comment by issue-refiner, recording the `**Occurrences:**` count from the issue body at planning time; parsed by `parsePlannedOccurrences()` and used by issue-dispatcher to trigger re-planning when recurrence count doubles
- `CLAWS_NO_CODE_CHANGES` — planner verdict emitted when the issue requires no file changes (purely operational task, fix already shipped, not actionable as code). `issue-refiner` posts the planner's explanation paragraph, then applies the `Claws Ignore` label to stop all further planner + implementer dispatch. The issue stays open so `ensureAlertIssue` can still find it by title on recurrence. Must appear on its own line; rejected if combined with a plan body or a `DUPLICATE_OF` verdict.

Agent prompts include explicit instructions not to use HTML comments in output.

### Zod Runtime Validation

All external data entering the system is validated with Zod schemas rather than
cast with `as T`. The key surfaces:

- **`github.ts`** — `safeJsonParse<T>(schema, raw, context)` requires a Zod schema
  at every call site. It handles `gh` returning an empty string `""` for empty list
  results (e.g. `gh pr list` when no PRs exist) by falling back to `[]` before
  parsing. `ghJson<T>` forwards the schema. All `gh` output parsed this way: PR
  lists, issue lists, check status, reactions, labels, etc.
- **`server.ts`** — POST request bodies (`/queue/merge`, `/queue/skip`,
  `/queue/prioritize`, etc.) are parsed with Zod schemas. WebSocket messages
  (`input`/`resize`) use a `discriminatedUnion` schema.
- **`slack.ts`** — Slack API response shapes (`postMessage`, `getReactions`) are
  validated on receipt.
- **`mcp-server.ts`**, **`agents/ci-fixer.ts`**, **`github-app.ts`** — AI-extracted
  JSON and GitHub App API responses are validated.
- **`transcribe.ts`**, **`ollama-rate-limit-classifier.ts`** — External API responses
  validated before field access.
- **`jobs/whatsapp-handler.ts`**, **`jobs/improvement-identifier.ts`**,
  **`jobs/idea-suggester.ts`**,
  **`jobs/idea-collector.ts`** — AI-extracted JSON outputs validated before use.
- **`config.ts`** — Config file parsing validated with a full schema (no
  `passthrough()` — schema surfaces unknown/cruft fields).

The rule: no `JSON.parse(...) as T` casts. Every parse site uses a Zod schema so
shape mismatches throw a `ZodError` with a readable message rather than producing
silent type-unsafe values.

### GitHub App Authentication

Claws requires GitHub App authentication for its own GitHub and git operations.
On startup, `ensureGitHubAppConfigured()` validates that either global
`githubAppId` + `githubAppPrivateKeyPath` are set with an existing key file, or
that `githubOwnerAppCredentials` includes at least one fully-resolvable per-owner
entry; otherwise startup fails. Per-owner credentials take priority and allow
different GitHub Apps for different organisations. All `gh` and `git` subprocess
invocations are passed short-lived installation tokens via env var injection
(`GH_TOKEN`, `GITHUB_TOKEN`). Tokens are minted per-owner via RS256 JWT →
GitHub API → installation access token, with a 10-minute expiry buffer.
Concurrent token refreshes for the same owner are deduplicated via a promise
cache. PRs and comments appear under the App bot identity.

### Security Model

Because Claude runs with `--dangerously-skip-permissions`, all user-supplied
input paths must be guarded upstream. Three primary defenses:

- **Query param escaping**: The `/logs/issue` page escapes the `repo` query param through both `encodeURI()` and `escapeHtml()` (in that order) before interpolating it into an `href` attribute — preventing reflected XSS via a crafted `repo` value containing a double-quote. A repo-membership check (`listRepos()`) also gates the handler: unknown repos return 404 rather than rendering an empty page with the attacker-controlled value.
- **Fork PR filtering**: All PR-processing jobs (pr-reviewer, ci-fixer,
  qa-phase, auto-merger, review-addresser) skip fork PRs via `isForkPR()`
  (checks the `isCrossRepository` field). This prevents untrusted external
  contributors from injecting content that Claude would execute with full
  host access.
- **Allowed actor gating**: `isAllowedActor()` in `github.ts` checks whether
  a user is in the `ALLOWED_ACTORS` list or is the authenticated `gh` user.
  Applied at multiple layers:
  - **issue-dispatcher** gates on issue *author* in both Phase 1 (refined → implementer) and Phase 2 (fresh plan/refine → planner) — issues from non-allowed actors are logged and skipped; the dispatcher also Slack-notifies and files a tracked `[disallowed-actor] @<login> is blocked from Claws automation` issue in `SELF_REPO` (via `ensureAlertIssue`, one issue per actor with occurrence tracking; individual item dedup via `markUntrustedActorNotified` in `notified_untrusted_actors` DB table) so the operator can grant an `allowedActors` exception. One CI bot exception exists: `isCiAlertBotAuthor()` grants a full pass-through for any issue authored by the GitHub Actions runner bot (`github-actions[bot]` / `app/github-actions`) — any such issue is dispatched into the refine-and-fix pipeline regardless of title. Other bots (dependabot, etc.) are not covered and remain subject to the untrusted-actor path.
  - **issue-refiner** gates the auto-`Refined` label application for `[ci-unrelated]` issues on the issue author (defense-in-depth against escalation from untrusted actors).
  - **issue-refiner** also filters comments by actor — only comments from allowed actors trigger plan refinement or follow-up.
  - **triage jobs** check issue authors.
  For the self-repo (`SELF_REPO`), issue
  processing includes a collaborator check via the GitHub API. A
  `normalizeBotLogin()` helper normalizes both the incoming login and self-login
  before comparing: `gh` CLI returns GitHub App authors as `app/<slug>` in
  `--json author` output, while the REST `/app` endpoint returns `<slug>[bot]`.
  `normalizeBotLogin` converts `app/<slug>` → `<slug>[bot]` so comparisons
  work regardless of which API surface produced the login. `isAllowedActor`
  passes `SELF_REPO.split("/")[0]` to `getSelfLogin()` to ensure the correct
  App credentials are used (critical in multi-owner setups where different owners
  have different App slugs).

### PR Review Comment Protocol

Every terminal code path in the pr-reviewer must leave a comment with the
standard `REVIEW_HEADER` (`## PR Review`) and a `Reviewed commit: \`SHA\``
marker (plain text). This invariant prevents infinite re-review loops — without
a commit marker, `hasNewCommitsSinceLastReview()` cannot determine whether
re-review is needed, causing the PR to be re-processed every cycle. Three terminal states:

1. **Empty diff** — posts "no net changes" comment with marker
2. **No issues found** — posts "Reviewed — no issues found" comment with marker, adds `Ready` label
3. **Issues found** — posts review feedback with marker (review-addresser auto-picks up)

On re-review (new commits since last review), the reviewer always posts a
new comment rather than editing the previous one. This preserves discussion
threads and approval signals on previous reviews. The dispatcher calls
`hasNewCommitsSinceLastReview(repo, prNumber)`, which internally finds the
latest review comment and compares its commit marker against the current
HEAD. If no new commits are found, the PR is skipped. If new commits exist
(or no prior review exists), `processPR(repo, pr)` is called to generate
and post a fresh review.

**Large PR diff handling**: The reviewer uses a two-phase diff strategy. Phase 1
attempts to fetch the full diff with a 200 MB buffer. If the buffer is exceeded
(or the diff exceeds 50,000 chars), Phase 2 switches to per-file mode: each
changed file is diffed individually; files larger than 20,000 chars receive a
dedicated Claude call with a structure-focused prompt (schema validity, format
consistency, field naming); smaller files are reviewed together in a single call
with the standard review prompt. Results from all segments are merged into one
`## PR Review` comment. The `generatePRDescription*` functions also use the
larger 200 MB buffer, truncating to 30,000 chars after fetch.

**Provider for PR reviews**: The pr-reviewer always uses Claude CLI with
`capability: "tool-use"` and `provider: "claude"` (#1879 — flipped from
`"text-only"` so the reviewer can verify git facts with real tool calls before
asserting them; see `REVIEW_VERIFICATION_CONTEXT` in `agent-context.ts`). A previous routing
mechanism (`resolveReviewDispatch()`) that dispatched to OpenRouter/Qwen for
smaller PRs was removed after review quality degraded. The `REVIEW_PROVIDER_PATTERN`
regex (`review-provider: (openrouter|claude)`) is retained in the code for
backward compatibility — existing comments with that marker are parsed to strip
the marker from displayed text. `isVagueReview()` validates reviewer output
before posting — comments with empty `Lines:` fields or missing required details
are suppressed entirely rather than posted as low-quality feedback.

**Dynamic context budgeting**: `buildReviewContext()` accepts an optional byte
budget (`contextBudgetBytes(diffBytes, reassessmentBytes)`) and passes it to
`loadRepoDocs()` to cap how much of `docs/OVERVIEW.md` is included. The budget
is derived from `REVIEW_MODEL_MAX_INPUT_TOKENS` (30,000) × `BYTES_PER_TOKEN`
(3.5) minus the diff and reassessment sizes — preventing over-large context
even with Claude's 200K window, keeping reviews focused.

### MCP Server Context

Claude sessions spawned by Claws can access operational state via the
built-in MCP server (`mcp-server.ts`). `writeClawsMcpConfig()` in `claude.ts`
generates an MCP config file that includes the Claws state server and
optionally additional MCP servers (e.g. Playwright for QA). The Claws MCP
server provides four core tools (`claws_status`, `claws_task_history`, `claws_open_prs`,
`claws_config`) plus `namey_query` when `NAMEY_DB_URL` is configured, and
`ha_list_entities` / `ha_api_request` when `HOME_ASSISTANT_BASE_URL` and
`HOME_ASSISTANT_TOKEN` are configured, giving Claude visibility into what Claws
is currently doing, recent task history, operator configuration, namey production
data (user counts, name popularity stats, etc.), and live Home Assistant entity
state and services.

`includeHomeAssistant` defaults to `false` and every call site must opt in
explicitly (#2064 — `ha_api_request` can invoke arbitrary HA services, e.g.
unlocking doors, so handing it to fleet agents working on unrelated repos was
a standing risk). Call sites pass
`{ includeHomeAssistant: isHomeAssistantConfigRepo(fullName) }`
(`isHomeAssistantConfigRepo()` in `home-assistant.ts`, a case-insensitive
match against `HOME_ASSISTANT_CONFIG_REPO`, default
`"St-John-Software/home-assistant-config"`) — issue-refiner (planner),
issue-worker (implementer), ci-fixer, review-addresser, pr-reviewer,
problematic-pr-diagnoser, improvement-identifier, and qa-phase all gate this
way, so HA tools are wired in only when the agent is actually working on the
HA config repo. `triage-claws-errors.ts` always operates on `selfRepo` and
passes no HA option at all, relying on the `false` default. The
`homeAssistantContext()` prompt text (which tells the model the HA MCP tools
exist) is gated by the same `isHomeAssistantConfigRepo(fullName)` check at
each call site, so agents on other repos are no longer told about tools they
don't have. The namey DB tool is only enabled for the implementer and
ci-fixer, not the planner.

## Configuration

Configuration is resolved per-field: env vars > `~/.claws/config.json` >
defaults.

| Config key | Env variable | Default |
|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | *(empty — must be set)* |
| `slackBotToken` | `CLAWS_SLACK_BOT_TOKEN` | *(empty — needed for idea threads)* |
| `slackIdeasChannel` | `CLAWS_SLACK_IDEAS_CHANNEL` | *(empty — needed for idea threads)* |
| `githubOwners` | `CLAWS_GITHUB_OWNERS` | `["stjohnb","St-John-Software"]` |
| `selfRepo` | `CLAWS_SELF_REPO` | `St-John-Software/claws` |
| `port` | `PORT` | `3000` |
| `intervals.issueDispatcherMs` | — | `300000` (5 min) |
| `intervals.prDispatcherMs` | — | `300000` (5 min) |
| `intervals.triageClawsErrorsMs` | — | `600000` (10 min) |
| `intervals.ideaCollectorMs` | — | `1800000` (30 min) |
| `intervals.runnerMonitorMs` | — | `600000` (10 min) |
| `intervals.qaPhaseMs` | — | `600000` (10 min) |
| `intervals.emailMonitorMs` | — | `300000` (5 min) |
| `intervals.k3sMonitorMs` | — | `900000` (15 min) |
| `intervals.runnerMetricsSyncMs` | — | `120000` (2 min) |
| `intervals.publicSnapshotSyncMs` | — | `604800000` (7 days) |
| `schedules.repoStandardsHour` | — | `2` (2 AM local time) |
| `schedules.publicRepoScannerHour` | — | `4` (4 AM local time) |
| `schedules.actionsStorageMonitorHour` | — | `5` (5 AM local time) |
| `intervals.dampReminderMs` | — | `900000` (15 min; `damp-reminder` still only creates the issue on Mondays ≥ 9 AM local) |
| `smartScheduling.enabled` | — | `true` |
| `smartScheduling.quietHourStart` | — | `19` (accepted but unused — off-hours gating was removed) |
| `smartScheduling.quietHourEnd` | — | `7` (accepted but unused — off-hours gating was removed) |
| `smartScheduling.tickIntervalMs` | — | `3600000` (1 hour) |
| `smartScheduling.jobs` | — | `{ "idea-suggester": {}, "improvement-identifier": {}, "doc-maintainer": {}, "issue-auditor": {}, "scanner-dispatcher": {}, "stale-branch-cleaner": {}, "idea-reconciler": {}, "dependabot-alert-monitor": {} }` — set of jobs that use smart scheduling |
| `smartScheduling.targetStalenessMs` | — | `86400000` (24h — repos not processed within this window are "due") |
| `smartScheduling.sloStalenessMs` | — | `172800000` (48h — repos past this threshold force processing even when Claws is busy) |
| `smartScheduling.maxConcurrentJobTasks` | — | `4` (max concurrent repo processing slots via `withSmartJobSlot`) |
| `smartScheduling.ignoreBusyKinds` | — | `["ci-fixer", "ci-fixer:conflict", "ci-fixer:rerun", "ci-fixer:problematic", "review-addresser", "pr-reviewer", "auto-merger:sweep", "doc-maintainer", "improvement-identifier", "idea-suggester", "issue-auditor"]` — agent kinds excluded from the busy check |
| `runners` | — | Two default self-hosted runner hosts (see config) |
| `macRunners` | — | Two default `MacRunner` entries (`{name, host, user?, port?, identityFile?, labels, enabled?}`): `Brendans-MacBook-Pro` (`brendans-macbook-pro.local`, labels `macos`+`tempo`) and `Brendans-MacBook-Pro-3` (`brendans-macbook-pro-3.local`, `user: "brendanstjohn"`, labels `macos`+`xcode26`) — woken by `mac-runner-waker`; kept separate from `runners`/`RUNNER_HOSTS` since `runner-monitor` cannot manage macOS hosts. `enabled` (optional, default `true`) is togglable per-Mac from the config UI (#1984) — set `false` to stop `mac-runner-waker` from SSHing to or alerting on a Mac that's been taken off the LAN |
| `macRunnerRepos` | — | `["St-John-Software/bonkus", "St-John-Software/namey", "St-John-Software/TempoStatusBar"]` (repos `mac-runner-waker` polls for queued macOS jobs) |
| `intervals.macRunnerWakerMs` | — | `60000` (1 min) |
| `publicSnapshots` | — | Four `{ source, target, mirrorReleases?, scrubPaths?, releaseAssetUrl? }` pairs (#1826): `St-John-Software/claws` → `stjohnb/claws-snapshot` (`scrubPaths: [".github/workflows/history-cleanup.yml"]`, #2009 — added after that workflow leaked a personal email into the public mirror), `St-John-Software/3d-models` → `stjohnb/3d-models`, `St-John-Software/TempoStatusBar` → `stjohnb/TempoStatusBar` (`mirrorReleases: true` — the only pair with release mirroring enabled, #1851 — and `releaseAssetUrl: "https://tempo-statusbar-releases.s3.us-east-1.amazonaws.com/releases/TempoStatusBarApp-{version}.dmg"`, an HTTPS fallback the DMG mirror fetches when the source release has no `.dmg` asset; `{version}` is the tag with a leading `v` stripped, #2115), `St-John-Software/fleet-infra` → `stjohnb/homelab` (`scrubPaths: ["apps/authentik/configmap-blueprints.yaml"]`, #1962). Any pair with a non-empty `scrubPaths` republishes as a squashed, force-pushed single-commit history every sync (there is no way to remove a path from ancestor commits without discarding history) and is mutually exclusive with `mirrorReleases` (enforced by a zod refinement in `config.ts`) |
| `logRetentionDays` | — | `14` |
| `logRetentionPerJob` | — | `20` |
| `emailEnabled` | `CLAWS_EMAIL_ENABLED` | `true` |
| `emailUser` | `CLAWS_EMAIL_USER` | `""` (empty — must be set in env or config) |
| `emailAppPassword` | `BRENDAN_SERVER_GMAIL_APP_PASSWORD` | *(empty)* |
| `emailRecipient` | `CLAWS_EMAIL_RECIPIENT` | `""` (empty — must be set in env or config) |
| `emailAllowedSenders` | `CLAWS_EMAIL_ALLOWED_SENDERS` | `[]` (comma-separated in env, lower-cased; empty = allow all senders. When non-empty, `email-monitor` skips messages whose `From` address isn't in the list — #2068) |
| `whatsappEnabled` | `WHATSAPP_ENABLED` | `false` |
| `whatsappAllowedNumbers` | `WHATSAPP_ALLOWED_NUMBERS` | `[]` |
| `openaiApiKey` | `OPENAI_API_KEY` | *(empty)* |
| `maxWorkWorkers` | `CLAWS_MAX_WORK_WORKERS` | `2` (`maxClaudeWorkers` / `CLAWS_MAX_CLAUDE_WORKERS` are deprecated aliases) |
| `claudeTimeoutMs` | `CLAWS_CLAUDE_TIMEOUT_MS` | `21600000` (6 hours, minimum 60s) |
| `claudeLivenessTimeoutMs` | `CLAWS_CLAUDE_LIVENESS_TIMEOUT_MS` | `21600000` (6 hours, minimum 60s) |
| `claudeWorkerMemoryMaxBytes` | `CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES` | `2147483648` (2 GiB; 0 disables) |
| `worktreeStaleMs` | — | `604800000` (7 days — worktrees older than this are pruned by worktree-cleaner) |
| `reviewModelTier` | `CLAWS_REVIEW_MODEL_TIER` | `"sonnet"` (global default model tier for PR reviews; `"opus"` raises all reviews to the opus tier) |
| `openrouterApiKey` | `CLAWS_OPENROUTER_API_KEY` | *(empty — required for OpenCode/OpenRouter text-only backend)* |
| `openrouterBestModel` | `CLAWS_OPENROUTER_BEST_MODEL` | `"qwen/qwen-2.5-coder-32b-instruct"` (best-tier model for OpenRouter text-only workflows) |
| `openrouterAdequateModel` | `CLAWS_OPENROUTER_ADEQUATE_MODEL` | `"qwen/qwen-2.5-coder-32b-instruct"` (adequate/sonnet-tier model for the direct OpenRouter text-only backend) |
| `openrouterCheapModel` | `CLAWS_OPENROUTER_CHEAP_MODEL` | `"google/gemini-2.5-flash-lite"` (cheap-tier model for the direct OpenRouter text-only backend) |
| `datasetteExport` | — | *(empty — disables the job)* `{ host, user?, port?, identityFile?, remotePath }` — remote SSH target `datasette-export` scp's a copy of `claws.db` to for Datasette-based data exploration |
| `intervals.datasetteExportMs` | — | `21600000` (6 hours) |
| `oidcClientId` | `CLAWS_OIDC_CLIENT_ID` | *(empty)* |
| `oidcClientSecret` | `CLAWS_OIDC_CLIENT_SECRET` | *(empty)* |
| `oidcBaseUrl` | `CLAWS_OIDC_BASE_URL` | *(empty — e.g. `https://auth.example.com`)* |
| `oidcApplicationSlug` | `CLAWS_OIDC_APPLICATION_SLUG` | *(empty — authentik application slug)* |
| `oidcRedirectUri` | `CLAWS_OIDC_REDIRECT_URI` | *(empty — defaults to `http://localhost:<port>/auth/callback`)* |
| `githubAppId` | `CLAWS_GITHUB_APP_ID` | `0` (disabled) |
| `githubAppPrivateKeyPath` | `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH` | *(empty)* |
| `githubAppInstallationIds` | — | `{}` (owner → installation ID overrides) |
| `githubOwnerAppCredentials` | — | `{}` (per-owner App credentials — `Record<string, {appId, privateKeyPath, installationId?}>` — overrides global credentials per owner; also listed in `SENSITIVE_KEYS`) |
| `nameyDbUrl` | `NAMEY_DB_URL` | *(empty — namey DB access disabled)* |
| `pausedJobs` | — | `[]` (job names to pause on startup) |
| `disabledJobsByRepo` | — | `{}` (map of repo full name → array of job names to disable for that repo) |
| `enabledJobsByRepo` | — | `{}` (map of repo full name → array of opt-in job names to enable for that repo; currently `main-build-monitor-scanner` is the only opt-in job, disabled by default for all repos) |
| `disabledAgents` | — | `[]` (agent names to disable: `planner`, `implementer`, `ci-fixer`, `review-addresser`, `reviewer`, `merger`, `empty-pr-closer`) |
| `skippedItems` | — | `[]` (array of `{repo, number}` excluded from processing) |
| `prioritizedItems` | — | `[]` (array of `{repo, number}` processed first) |
| `itemTimeoutOverrides` | — | `[]` (array of `{repo, number, timeoutMs}` — auto-managed by timeout escalation) |
| `homeAssistantBaseUrl` | `CLAWS_HOME_ASSISTANT_BASE_URL` | *(empty — HA REST API integration disabled)* |
| `homeAssistantToken` | `CLAWS_HOME_ASSISTANT_TOKEN` | *(empty — required when homeAssistantBaseUrl is set)* |
| `homeAssistantConfigRepo` | — | *(empty — e.g. `St-John-Software/home-assistant-config`)* |
| `homeAssistantUpgraderEnabled` | `CLAWS_HOME_ASSISTANT_UPGRADER_ENABLED` | Defaults to whether HA is configured (`homeAssistantBaseUrl` + `homeAssistantToken` both set); set `false` to disable the `ha-upgrader` job without unconfiguring HA |
| `homeAssistantUpgraderExcludePatterns` | `CLAWS_HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS` | `[]` (comma-separated in env; entity IDs/patterns `ha-upgrader` should never install updates for) |
| `homeAssistantDeployWatcherEnabled` | `CLAWS_HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED` | Defaults to whether HA is configured; set `false` to disable the `ha-deploy-watcher` job |
| `homeAssistantGitPullAddonSlug` | `CLAWS_HOME_ASSISTANT_GIT_PULL_ADDON_SLUG` | `"core_git_pull"` (HA Supervisor addon slug `ha-deploy-watcher` polls for `Updating <old>..<new>` log lines) |
| `allowedActors` | — | `["stjohnb"]` (issue authors whose issues are dispatched into the refine/implement pipeline; see [Content-Based State Machine](#content-based-state-machine)) |
| `dependabotIgnoredAdvisories` | — | `{}` (map of repo full name, or `"*"` for all repos, → array of `GHSA-...` IDs to suppress before filing the `dependabot-alert-monitor` alert issue) |
| `notifyDashboardActions` | — | `true` (send Slack notifications for all dashboard mutations) |
| `dependabotAutoDismissStale` | — | `true` (auto-dismiss Dependabot alerts whose patched version is already present in the dependency-graph SBOM; set to `false` to disable) |
| `k3sMonitorEnabled` | — | `true` (set to `false` to disable the k3s-monitor job) |
| `k3sIgnoredNodes` | — | `["k3s-nas", "ryzen"]` (nodes to suppress alerts for — applies to both node and pod alerts) |
| `fleetInfraRepo` | `CLAWS_FLEET_INFRA_REPO` | `St-John-Software/fleet-infra` (repo where k3s-monitor files alert issues) |
| `prodK8sMonitorEnabled` | `CLAWS_PROD_K8S_MONITOR_ENABLED` | `false` (enable prod cluster monitoring) |
| `prodK8sKubeconfigPath` | `CLAWS_PROD_K8S_KUBECONFIG_PATH` | *(empty — uses default kubeconfig when empty)* |
| `fleetKubeconfigPath` | `CLAWS_FLEET_KUBECONFIG_PATH` | `"~/.kube/config"` (kubeconfig path for fleet/k3s cluster; `~` is expanded to an absolute path via `resolveIdentityFile` at session-create time; granted to sessions with the `fleet-infra` capability; set to `""` to hide the capability from the sessions UI) |
| `prodK8sKubeconfigRefresh` | — | *(empty — when set, enables automatic kubeconfig refresh for the prod cluster; object with fields: `tailscaleHostname`, `host`, `user`, `port`, `identityFile`, `remotePath`, `serverPort`, `serverOverride`)* |
| `prodK8sIgnoredNodes` | — | `[]` (nodes to suppress alerts for in the prod cluster) |
| `prodK8sRepo` | `CLAWS_PROD_K8S_REPO` | `St-John-Software/production-infra` (repo where prod-k8s-monitor files alert issues) |
| `intervals.prodK8sMonitorMs` | — | `900000` (15 min) |
| `ciFixerCircuitBreaker.maxAttempts` | — | `5` (max CI fix attempts per PR within window) |
| `ciFixerCircuitBreaker.windowMs` | — | `86400000` (24h window for attempt counting) |
| `ciFixerCircuitBreaker.maxConsecutiveFailures` | — | `3` (consecutive failures before tripping) |
| `homeAssistantBinDayMonitorEnabled` | `CLAWS_HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED` | `false` (enable bin-day sensor monitoring) |
| `homeAssistantBinDaySensorPrefix` | `CLAWS_HOME_ASSISTANT_BIN_DAY_SENSOR_PREFIX` | `"sensor.bin_scraper_"` (HA entity ID prefix to monitor) |
| `intervals.binDayMonitorMs` | — | `900000` (15 min) |
| `homeAssistantBatteryMonitorEnabled` | `CLAWS_HOME_ASSISTANT_BATTERY_MONITOR_ENABLED` | `false` (enable battery-level sensor monitoring) |
| `homeAssistantBatteryThresholdPercent` | `CLAWS_HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT` | `10` (alert threshold — devices at or below this percent are reported; `<=` comparison so exactly-10% devices are included) |
| `intervals.batteryMonitorMs` | — | `3600000` (1 hour) |

Config changes made via the web UI (`POST /config`) take effect immediately
at runtime — no restart required. The config module uses ESM live bindings
(`export let`) so all consumers see updated values on their next access.
Interval and schedule changes are propagated to the scheduler via
`onConfigChange()` listeners that call `updateInterval()` /
`updateScheduledHour()`. The only exceptions are `port` (requires socket
re-bind), `whatsappEnabled` (requires QR pairing), and `emailEnabled`
(requires restart), which are shown as read-only in the UI.

Env vars always take priority over `config.json`. Fields set via env var
are shown as disabled in the config UI with a note indicating the override.

External tools `gh` and `claude` must be authenticated separately — Claws does
not manage their credentials.

`kubectl` is also available on the production host, configured with read-only
access to the k3s cluster. This provides Claws with the ability to inspect
cluster state (pods, logs, events, resources) when working on issues in the
`fleet-services` and `fleet-infrastructure` repositories. Access is read-only —
Claws cannot apply, delete, or modify cluster resources.

When `nameyDbUrl` is configured, the MCP server exposes a `namey_query` tool
that runs read-only SQL queries against the namey production PostgreSQL
database. This lets Claude sessions query user stats, name popularity trends,
and other production data during planning and implementation. Queries are
enforced read-only via `BEGIN TRANSACTION READ ONLY`, capped at
500 rows, and subject to a 30-second timeout.

When `homeAssistantBaseUrl` and `homeAssistantToken` are configured, and the
call site opts in via `includeHomeAssistant: true`, the MCP server exposes two
HA tools: `ha_list_entities` (discovers entity IDs, current state, and
friendly names, filterable by domain or search substring) and
`ha_api_request` (generic GET/POST passthrough to any `/api/…` endpoint, able
to invoke any HA service). Every fleet call site gates that opt-in on
`isHomeAssistantConfigRepo(fullName)` (default-deny since #2064), so these
tools are only wired in when the agent is working on the
`home-assistant-config` repo — see [MCP Server Context](#mcp-server-context)
above. See [Home Assistant Integration](home-assistant.md) for the manual
HA-side setup runbook (what can/can't be GitOps'd, initial repo and token
setup) that is a prerequisite for this integration.

The WhatsApp gateway requires a one-time QR-code pairing step. See
[WhatsApp Setup](whatsapp-setup.md) for the full walkthrough.

## Technology Stack

- **Runtime**: Node.js 22
- **Language**: TypeScript (strict mode, ES2022 target, Node16 modules, ESM)
- **Database**: SQLite via better-sqlite3 (WAL mode)
- **Testing**: Vitest — co-located test files, heavy mocking of external boundaries
- **CI**: GitHub Actions on self-hosted runner — build + test on every push
- **History cleanup**: Workflow-dispatch action for branch cleanup and `git-filter-repo` to audit/scrub git secrets
- **Releases**: Date-based version tags (`v<YYYY-MM-DD>.<N>`), tarball attached to GitHub Release
- **Auto-updates**: systemd timer checks for new releases every 60s, downloads + swaps + health checks with automatic rollback

## Filesystem Layout (Runtime)

```
~/.claws/
├── config.json          Configuration file
├── env                  Environment overrides (loaded by systemd)
├── claws.db             SQLite database
├── whatsapp-auth/       Baileys auth state (created on first QR pairing)
├── pending-ideas/       Transient state for ideas awaiting Slack reaction collection
│   └── <owner>-<repo>.json
├── repos/
│   └── <owner>/<repo>/  Main clone per repository
└── worktrees/
    └── <owner>/<repo>/
        └── <job>/
            └── <branch>/   Isolated worktree per task
```

## Kubernetes Deployment

Claws ships a container image for running on a Kubernetes cluster alongside
or in place of the systemd deployment. Plain-YAML manifests live in the
fleet-infra repo. The app remains a hard single-instance service — the
manifests encode that invariant rather than relaxing it.

**Shape.** A `StatefulSet` with `replicas: 1` and `podManagementPolicy:
OrderedReady`, a 50 Gi `ReadWriteOnce` PVC at `/home/claws/.claws` (SQLite
WAL needs real local storage), `terminationGracePeriodSeconds: 360` to cover
the 300 s scheduler drain in `src/main.ts`, and liveness/readiness probes on
`GET /health`. The container runs as the non-root `claws` user (uid 1000);
`fsGroup: 1000` fixes PVC ownership on first mount.

**Verify-only rollout.** A fresh pod boots with `activationState:
"verify-only"`. In this mode:

- The job scheduler is started with an empty job set.
- The WhatsApp gateway does not pair (so it doesn't claim the single device
  slot belonging to the systemd instance).
- GitHub App config is not required at startup.
- `runConnectivityVerification()` fires once and records a report into
  `verification_reports`.

A `/verify` page renders the latest report — database, GitHub App, every
CLI (`gh`, `claude`, `codex`, `opencode`), OpenRouter, Slack webhook (DNS
only — no POST), IMAP login/logout, per-runner SSH, datasette SSH, Ollama,
WhatsApp auth. Each check is wrapped in a 30 s timeout.
A red verify-only banner appears on every page of the dashboard.

Flipping to `active` is explicit: either click **Activate** on the Config
page (writes `activationState: "active"` and prompts for a pod restart) or
set `CLAWS_ACTIVATION_STATE=active` in the secret and restart. The loader
also auto-selects `active` if `claws.db` already exists on the data volume
at startup — so copying a populated PV from the systemd host does not
accidentally re-enter verify-only.

**Image.** `ghcr.io/st-john-software/claws:<tag>` plus `:latest`, built and
pushed by the `docker` job in `.github/workflows/release.yml` on every
release tag.

**Concurrency guard.** `src/main.ts` writes `claws.pid` into the data dir at
startup and refuses to start if a live sibling holds the lock (checked via
`process.kill(pid, 0)`). This is belt-and-braces on top of the StatefulSet's
single-replica guarantee: if a rolling update ever double-schedules the
pod, the newcomer crash-loops instead of corrupting the WAL.

See the fleet-infra repo for the operator playbook (secrets, cutover from
systemd, troubleshooting).
