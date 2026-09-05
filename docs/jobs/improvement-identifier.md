# improvement-identifier

**Source**: `src/jobs/improvement-identifier.ts`
**Trigger**: Smart-scheduled
**Schedule**: Evaluated hourly via the shared staleness-based smart-scheduling loop. A repo is due once it has not been processed within the target staleness window (24h by default); the busy gate defers routine runs while Claws is occupied, but the SLO escape valve still forces badly stale repos through. `weekendPause` still suppresses unattended ticks from Fri 18:00 to Sun 18:00 local time (manual trigger bypasses). The legacy `smartScheduling.quietHourStart` / `quietHourEnd` settings remain accepted in config for compatibility but are no longer used.

Only processes repos that Claws has previously cloned. Repos are processed concurrently.
Single-prompt analysis phase produces both security findings and improvement suggestions,
cutting analysis-phase Claude usage roughly in half compared to two separate jobs.

## Phase 1: Analysis

- Fetches all open issue and PR titles for deduplication context
- Skips analysis entirely if **both** an open `security: ...` issue **and** 3 or more open improvement issues filed by this job exist (both downstream phases would skip — analysis is wasted)
- Creates a transient worktree on branch `claws/improve-<hex4>`
- Instructs Claude to read `docs/OVERVIEW.md` (if it exists) and analyze the codebase for **both** security vulnerabilities and actionable improvements
- Claude responds with structured JSON containing `securityFindings` and `improvements` arrays
- Analysis worktree is cleaned up before implementation begins

The analysis call runs on OpenCode via OpenRouter, using the model configured by
`improvementIdentifierModel` / `CLAWS_IMPROVEMENT_IDENTIFIER_MODEL` (default
`openrouter/z-ai/glm-5.3`). This whole-repo pass is the job's dominant cost, and
GLM-5.3's 1.3M-token context and 131k-token output ceiling keep the structured
JSON from truncating (#1737, #1810). No `strictProvider`/`noProviderFallback` is
set, so an OpenRouter outage, a missing `opencode` binary, or a rate limit falls
back automatically through `PROVIDER_FALLBACK_ORDER` to Claude. The Home
Assistant config repo is the one exception: it stays pinned to Claude, because
OpenCode silently drops `mcpConfig` and would lose HA MCP tool access.

**JSON parsing robustness**: `parseReviewOutput()` tries three strategies in order to
extract the JSON object from Claude's output: (1) greedy fence match anchored to the
last closing `` ``` `` (handles bodies containing inline code blocks), (2) non-greedy
fence match (fallback when trailing prose follows the fence), (3) brace-balanced
extraction starting at the last `{` before the final `}` (handles unfenced JSON).
Parse failures are reported via `reportError("improvement-identifier:parse-findings", ...)`.

## Phase 2A: File security findings

Security findings are filed first (before improvement implementation). For each finding (up to 5 per run):

- Skipped entirely if any open issue with a title starting with `security: ` already exists for this repo
- Searches existing issues **and PRs** by finding title (skips if a match is found)
- Calls `gh.createIssue` with title `security: <finding title>` (no labels applied)
- Errors in one finding do not block processing of others

Issues include a footer: *"Automated security review by claws improvement-identifier"*

## Phase 2B: File improvement issues

Suggested improvements (up to 2 per run) are filed as GitHub issues via `fileIssueIfAbsent`
(no PRs are created — improvement-identifier no longer opens PRs).
This phase is **skipped** if:
- 3 or more issues carrying the improvement footer are still open on the repo (`MAX_OPEN_IMPROVEMENT_ISSUES`) — backpressure, since exact-title dedup does not catch a reworded restatement of the same finding, OR
- At least one security finding was actually filed this tick (security priority lever)

When security findings are filed, improvement filing is deferred to the next tick.
This ensures operator attention goes toward security fixes first.

Each improvement:

- Searches existing issues **and PRs** for duplicates (skips if found)
- Calls `gh.createIssue` with the improvement title and body (no labels applied)
- Errors in one improvement do not block processing of others

Conservative by design: only tangible improvements, no stylistic or
documentation suggestions. "No improvements found" is acceptable.

Issues include a footer: *"Automated improvement by claws improvement-identifier"*

## What it looks for

**Security**: injection vectors, auth/authorization gaps, hardcoded secrets, path-traversal,
SSRF, unsafe deserialization, crypto misuse, secrets in logs, known CVEs, missing input
validation at trust boundaries. Only concrete findings with an exploit path; no
defense-in-depth speculation. On private repos (checked via `gh.isRepoPrivate()`), the
prompt explicitly tells Claude not to report fork-PR hardening findings (gating self-hosted
runners against fork PRs, restricting `pull_request` triggers, etc.) or attacker-controlled-
issue-text findings — a private repo can't receive PRs from non-collaborator forks and only
invited collaborators can open issues/comments, so both threat models don't apply and were a
confirmed false-positive source before this guard was added (#1481, #1874).

**Improvements**: the bar is "important only" (#2631) — correctness bugs, reliability
failures at system boundaries (unhandled errors that drop/duplicate/swallow work, crash
paths, resource leaks), measured performance or cost problems with a concrete cause, and
recurring operational burden. Explicitly **not** reportable: refactoring, consolidation,
simplification of working code, dead code/unused exports, stale TODO/FIXME cleanup,
renames/type annotations/comments/documentation, test coverage gaps, or theoretical/
unmeasured performance concerns — these are deferrable and no longer filed. The prompt
requires every improvement to be tagged `"severity": "high"`, `"medium"`, or `"low"`, and
`filterImportantImprovements()` fail-closed filters to `"high"` only — a missing or
unrecognised severity drops the item rather than being filed, since the prompt states the
tagging rule explicitly and an untagged item means the model ignored the bar.

**Web / SEO** (conditional): For repos that appear to serve user-facing web pages
(detected by `*.html` files, static-site generator configs such as Hugo/Jekyll/Astro/Next.js,
or output directories like `public/`, `static/`, `_site/`, `dist/`), the prompt also checks for:
- Missing or incomplete JSON-LD structured data (`<script type="application/ld+json">`) using
  schema.org types: `WebSite`, `Person`, `ProfilePage`, `BreadcrumbList`, `BlogPosting`, `Blog`,
  `SoftwareApplication`, `CollectionPage`
- Standard SEO basics: unique `<title>`, `<meta name="description">`, canonical link tags,
  Open Graph (`og:*`) and Twitter Card meta tags, `sitemap.xml`, `robots.txt`, descriptive
  `alt` text, semantic heading structure

Findings are emitted as `improvements` entries (same JSON shape). Backend, library, CLI,
and infra repos with no user-facing HTML are excluded from this check.
