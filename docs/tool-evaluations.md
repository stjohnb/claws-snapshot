# Third-party tool evaluations

**Deep dive.** Read this when you're about to propose adopting a third-party
tool or framework — it records prior decisions so they aren't re-proposed.
For coding-harness proposals specifically, see harness-landscape.md instead.

Decisions on whether to adopt an external tool or framework into Claws,
recorded so `idea-suggester` and future planners don't re-propose something
already considered and declined. Each entry states the trigger conditions
that would flip the decision, not just the current answer.

## Firecrawl + Hermes (#2579)

Issue #2579 asked whether [Firecrawl](https://firecrawl.dev) and
[Hermes](https://blog.jakesaunders.dev/building-an-almost-fully-self-hosted-sandboxed-agentic-software-factory/)
(a self-hosted personal-assistant container with a web UI, Telegram access,
and self-building skills) could be useful to Claws. **No, for both, for now.**

Firecrawl is an open-source scrape/crawl/map/search API; self-hosting is a
docker-compose stack (API, Postgres, Redis, RabbitMQ, a Playwright service)
that explicitly **lacks** Fire-engine (the anti-bot/IP-block layer), the
`/agent` and `/browser` endpoints, LLM extraction, and screenshots — those are
cloud-only. In the source post its role is "nicer access to SERP data and web
scraping at scale" for an agent with no built-in web tooling of its own.

Claws' agents already have that tooling:

- `WebFetch`/`WebSearch` are available to tool-use agents and explicitly
  prompted for in `src/agents/issue-refiner.ts` ("If it references external
  URLs, use the WebFetch tool to retrieve their content...").
- A real headless Chromium via the Playwright MCP `browser` capability
  (`BROWSER_CAPABILITY_ID` in `src/capabilities.ts`, granted per-session in
  `src/sessions.ts`), used unconditionally by `src/jobs/shopping-sourcer.ts`
  for marketplaces that block plain HTTP fetches (eBay, Facebook Marketplace,
  Gumtree), with a raised `BROWSER_AGENT_MEMORY_MAX_BYTES` (4 GiB,
  `src/claude.ts`, #2509) because Chromium doesn't fit the 2 GiB global
  per-worker memory cap.

For the one job that genuinely fights anti-bot pages (`shopping-sourcer`),
self-hosted Firecrawl would be strictly worse than what's already there —
Fire-engine is cloud-only, so a self-hosted instance falls back to the same
plain Playwright fetch Claws already drives directly, minus per-session tab
control. Elsewhere there is no gap to close. On the cost side: five more
containers with their own Postgres/Redis/RabbitMQ on the Claws host (already
watched by `src/jobs/host-disk-monitor.ts`), a new capability, a
`sensitive-env` key, MCP wiring, a `connectivity-verifier` probe, and a second
scraping path to keep working — for no job that currently crawls at scale.

`TEXT_ONLY_DISALLOWED_TOOLS` in `src/claude.ts` deliberately strips
`WebFetch`/`WebSearch` (plus Bash/Read/Write/…) from agents that process
untrusted email/WhatsApp text. A Firecrawl MCP tool handed to those agents
would silently reopen exactly that network hole, since MCP tool names aren't
covered by that deny list — a reason to be extra cautious about adding one.

Hermes' orchestrator role is already occupied by Claws itself: `src/main.ts`
(PID lock, job registration), `src/scheduler.ts`, `src/worker.ts` (SQLite work
queue), `src/sessions.ts` (tmux PTY sessions with capability-gated env),
`src/server.ts` (dashboard/web UI), `src/whatsapp.ts` +
`src/jobs/whatsapp-handler.ts` (the Telegram analogue), `src/slack.ts`, and
`src/mcp-server.ts` (state exposed to sessions over MCP). Running Hermes
alongside would mean two schedulers contending for the same `WORK_DIR`
worktrees, GitHub App installation tokens, PID lock, and work queue — a
correctness problem, not a feature.

**Revisit if:**

1. A job needs to crawl tens-to-hundreds of pages per run (a site-wide SEO
   audit, docs ingestion) where per-page `WebFetch` round-trips would
   dominate the run.
2. Anthropic-hosted `WebSearch`/`WebFetch` become unavailable or unusable for
   a provider Claws routes to (the Codex/OpenCode fallbacks in
   `src/model-selector.ts`), leaving text-capable agents with no search at
   all.
3. `shopping-sourcer` (or a similar job) sees recurring, evidenced `WebFetch`
   failures on sites that a real headless browser also can't get past.

None of these hold today.

## Coding-harness landscape (#2632)

Issue #2632 asked us to research the twelve harnesses named in David
Breunig's ["Harnesses are Situated Agents"](https://www.dbreunig.com/2026/08/14/harnesses-are-situated-agents.html):
Omnigent, DeepSeek Harness, Buzz, QM, Flue, Muse Code, OpenClaw, NanoClaw,
Hermes (`NousResearch/hermes-agent`), Conductor, Prime Agent, and Pi.
**No adoption, for any of them, today.** For the five that are themselves
orchestrators — Omnigent, DeepSeek Harness, QM, Hermes, and Prime Agent —
Claws already occupies the orchestrator role each one wants to fill
(`src/main.ts`, `src/scheduler.ts`, `src/worker.ts`, `src/sessions.ts`,
`src/mcp-server.ts`), so running one alongside Claws would mean two
schedulers contending for the same `WORK_DIR` worktrees, GitHub App
installation tokens, PID lock, and work queue — the same conclusion reached
above for the other Hermes project in #2579.
(The remaining seven — Buzz, Pi, Conductor, Muse Code, Flue, OpenClaw, and
NanoClaw — are declined for other reasons; see `harness-landscape.md`'s
per-harness notes and Verdict.) Note that `NousResearch/hermes-agent` is a **different project** from
the Hermes declined in #2579 above (`blog.jakesaunders.dev`'s self-hosted
personal-assistant container) — neither has been adopted, but they are not
the same evaluation. Full layer-by-layer analysis, per-harness notes, and
revisit triggers live in [harness-landscape.md](harness-landscape.md).
