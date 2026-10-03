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
(The remaining six — Buzz, Conductor, Muse Code, Flue, OpenClaw, and
NanoClaw — are declined for other reasons; see `harness-landscape.md`'s
per-harness notes and Verdict. Pi was later re-evaluated on its own and given a
trial verdict; see [pi coding agent and Pi Durable](#pi-coding-agent-and-pi-durable-clw_01m3xk86g53004fyjddzr1yw25) below.) Note that `NousResearch/hermes-agent` is a **different project** from
the Hermes declined in #2579 above (`blog.jakesaunders.dev`'s self-hosted
personal-assistant container) — neither has been adopted, but they are not
the same evaluation. Full layer-by-layer analysis, per-harness notes, and
revisit triggers live in [harness-landscape.md](harness-landscape.md).

## pi coding agent and Pi Durable (#clw_01M3XK86G53004FYJDDZR1YW25)

Issue #clw_01M3XK86G53004FYJDDZR1YW25 asked whether pi, Earendil's terminal
coding agent, and Pi Durable, the framework announced with Pi 1.0, are worth
adopting. Verdicts: **pi coding agent: trial**, as a fourth headless agent
provider that runs only when an operator pins it. **Pi Durable: decline.**
Sources: the [Pi Durable post](https://earendil.com/posts/pi-durable/), the
[Pi 1.0 post](https://earendil.com/posts/pi-1-0/), and pi's own
[coding-agent docs](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)
(`cli.md`, `json.md`, `mcp.md`, `rpc.md`, `sdk.md`, `security.md`,
`containerization.md`, `settings.md`), plus the `packages/coding-agent` and
`packages/durable` READMEs and `package.json` files in the same repo.

**What pi is.** An MIT-licensed terminal coding agent, installed with
`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`. It needs
Node 22.19+ (`engines.node` is `>=22.19.0`); Claws' `flake.nix` pins
`nodejs_24`, so that is met. Besides the interactive TUI it has `--print`,
`--mode json` and `--mode rpc` modes and an embeddable SDK. The repo was
renamed from `badlogic/pi-mono` to `earendil-works/pi` and the npm scope from
`@mariozechner` to `@earendil-works`, so older links and package names are
stale.

**What Pi Durable is.** The package `@earendil-works/pi-durable`, a library
for agent applications that survive crashes: it checkpoints every task,
stores state in Memory, SQLite or JSONL storage, and lets several clients
attach to one conversation and fork it. Its README opens with
"**Experimental.** The API changes without notice between releases." and its
storage section says "One process owns a storage at a time; there is no
cross-process locking."

**Comparison with the agents Claws already runs:**

| Capability | Claude CLI | Codex | OpenCode | pi |
| --- | --- | --- | --- | --- |
| Worktree runs | Spawned with `cwd` set to the worktree | Same | Same | Same: pi works in its `cwd` |
| Headless output | `-p --output-format json` | `exec --json` event stream | `run --format json` | `--mode json` writes a JSONL stream of `session`, `message_update`, `message_end`, `turn_end`, `agent_end` and `agent_settled` events |
| Permissions | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `permission: "allow"` in `OPENCODE_CONFIG_CONTENT` | No approval prompts at all; the docs recommend running it in a container. The same posture as `--dangerously-skip-permissions` |
| Tokens and cost | Tokens and cost | Tokens only, no cost | Tokens and cost | `message_update.usage` carries `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` and `cost.total` |
| MCP | `--mcp-config` | Per-run `CODEX_HOME` | `OPENCODE_CONFIG_CONTENT` | Reads `mcpServers` from `$PI_CODING_AGENT_DIR/mcp.json`; reads a project's `.pi/mcp.json` only for trusted projects. MCP is built in since 1.0, so older docs saying pi "will not support MCP" are stale |
| Crash and resume | Claws' pod re-attach and retry | Same | Same | `--continue`, `--session-id` and `--fork`, but Claws' own pod re-attach still owns crash survival |
| Context files | Claws inlines `AGENTS.md` into the prompt | Auto-loads `AGENTS.md`; Claws also inlines it | Claws inlines `AGENTS.md` | Loads `AGENTS.md`, as Codex does |

**What pi adds over the existing three:**

- cost figures for runs on non-Claude models, which Codex does not report
- per-run tool allow-listing with `--tools`
- `--append-system-prompt`, which OpenCode lacks
- an RPC/SDK mode, a candidate for the open "agent SDK" question in
  `docs/product/automation-lifecycle.md`

**Costs and risks against [PRODUCT.md](PRODUCT.md)'s goals** (operator in
control, observable and supervised work, least privilege, resource limits on
the shared host):

- A fourth provider to maintain: its runner, output parser, auth checks,
  config keys and label.
- A managed repo can ship `.pi/` config (extensions, settings, MCP servers)
  that would run with the agent's credentials. Runs use
  `--no-approve --no-extensions` and a throwaway `PI_CODING_AGENT_DIR` so
  repo-local config cannot widen the agent's access.
- pi reads the project `sessionDir` setting before its trust check, so a repo
  could point session files outside the worktree; runs use `--no-session`.
- pi downloads `rg` and `fd` into `~/.pi/agent/bin/` unverified when they are
  missing from `PATH`, so the image preinstalls them.
- One more Node process under the host's 5 GB memory cap while a pi run is
  active.

**Trial shape.** pi is enabled with weight 0. It is never drawn at random; it
runs only on issues an operator pins with the `Use Pi` label or a `pi/…`
model-plan cell, which keeps every pi run deliberate and supervised. It
reaches models through OpenRouter with the existing `OPENROUTER_API_KEY`, so
the trial adds no new credential. Integration: shipped enabled at weight 0:
runs only when pinned with `Use Pi` or a `pi/…` model-plan cell.

**Pi Durable declined**, because:

- Claws' agent pods and work rows already survive service restarts.
- tmux already gives interactive sessions multi-client attach.
- Rebuilding Claws' job or session execution on it is out of scope for this
  issue.
- Its API is experimental, and its storage is single-process, which does not
  fit Claws' split between the service and agent pods.

**Revisit if:**

1. Pinned pi runs over 30 days do worse than OpenCode on the same kinds of
   issues: drop pi. If they do as well or better: give it a positive weight.
2. The agent-SDK open question in `docs/product/automation-lifecycle.md` is
   taken up: trial pi's RPC/SDK mode first.
3. Pi Durable ships a stable API with multi-process or server-backed storage.
4. Claws decides to build the forkable trajectory log from
   [harness-landscape.md](harness-landscape.md) "Ideas worth stealing".
