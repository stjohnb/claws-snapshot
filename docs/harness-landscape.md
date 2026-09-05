# Harness landscape (#2632)

**Deep dive.** Read this when you're about to propose adopting a
coding-harness project — it records why Claws adopts none, so it isn't
re-proposed. For third-party tool/framework decisions generally, see
tool-evaluations.md instead.

Issue #2632 asked us to research the harnesses named in David Breunig,
["Harnesses are Situated Agents"](https://www.dbreunig.com/2026/08/14/harnesses-are-situated-agents.html)
(14 Aug 2026). Everything below was verified against each project's primary
source (its own repo, docs site, or vendor blog) on 2026-08-25 and is a
snapshot — treat facts here as dated, not live.

The article's thesis: Harrison Chase's four agent elements (system prompt,
planning tool, file system, subagents) are the *core loop*. The *harness* is
the surrounding structure that makes the loop useful day to day, and it has
eight layers: the Session, the Environment, the Repo, Memory, Skills, the
Team, the Organization, and the Model. Its closing argument is that these
layers are stickier than the loop itself, so harness lock-in will end up
looking like SaaS-era network effects.

## The eight situated-agent layers, and where Claws implements each

### The Session

`src/sessions.ts` runs tmux PTY sessions with capability-gated environments.
`src/db.ts` persists task history in SQLite, including `trackTaskTokens` for
per-task token accounting across multiple `runClaude` calls. `src/mcp-server.ts`
exposes that state back to sessions over MCP.

**Gap:** there is no branchable/replayable trajectory log. A Claws session is
linear and live; you cannot fork it at turn *n* and explore an alternative
continuation the way DeepSeek Harness and Prime Agent describe for their session
layers.

### The Environment

Every agent run is isolated in a git worktree via `claude.repoDir(repo)`
(`src/claude.ts`, `WORK_DIR/repos/<owner>/<name>`), with a per-worker memory
cap (`BROWSER_AGENT_MEMORY_MAX_BYTES`, raised to 4 GiB specifically for
Chromium-backed browser sessions).

**Gap:** isolation is a worktree plus an OS process, not a container. NanoClaw's
per-agent Docker boundary — real filesystem namespaces rather than
application-level permission checks — is strictly stronger for untrusted code.

### The Repo

Git worktrees, the `AGENTS.md`/`CLAUDE.md` compatibility pair, `.agents/`,
`docs/`, and per-repo job config are Claws' Repo layer. Across managed repos,
`AGENTS.md` is the target canonical shared-instructions file with a one-line
`CLAUDE.md` include for Claude-specific auto-loading, but this repo itself has
not performed that root-file migration yet and still ships its root guidance in
`CLAUDE.md`.

### Memory

`docs/requirements.md`, `docs/tool-evaluations.md` (this file's sibling),
`docs/postmortems/`, and `src/occurrence-tracking.ts` (alert-issue state that
persists across ticks) are Claws' memory surfaces.

**Gap:** this is memory as documents that a human or an agent edits, not an
accrued per-user preference model. Hermes' learning loop (skills distilled
from experience, a model of the user built across sessions) and QM's
per-scope memory are the contrast — nothing in Claws infers or refines
preferences on its own.

### Skills

`src/resources/` prompt resources, injected via the "Prompt Resource
Injection" pattern documented in `docs/OVERVIEW.md`, are Claws' reusable
domain-knowledge layer, alongside whatever Claude Code skills an agent
invokes during a run.

### The Team

GitHub issues and PRs are Claws' real multiplayer surface — the place work is
proposed, discussed, and reviewed by both humans and agents. `src/slack.ts`,
`src/whatsapp.ts`, and `src/jobs/whatsapp-handler.ts` extend that to chat.
Buzz is the direct analogue among the twelve harnesses below, but Claws
already has a working Team layer for its actual org (GitHub), so there is
nothing Buzz would replace.

### The Organization

`src/capabilities.ts` (capability gating per session), `src/sensitive-env.ts`
(secret handling), and `src/github-app.ts` (installation-token auth) are
Claws' policy layer — the Security Model pattern referenced throughout the
codebase. Omnigent's Server layer (policies + sharing) is the analogue.

### The Model

`src/model-selector.ts` does provider-aware routing over a single
`PROVIDER_FALLBACK_ORDER`, and `TEXT_ONLY_DISALLOWED_TOOLS` in `src/claude.ts`
strips tool access for agents processing untrusted input.

## The twelve harnesses

### Omnigent (Databricks)

[databricks.com/blog](https://databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents) ·
[github.com/omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent)

Apache 2.0 "meta-harness" with three layers: Runner (wraps Claude Code,
Codex, Pi, or a custom agent in a sandboxed session behind a uniform API),
Server (policies + sharing), and Interface (terminal, web, API). Deploys
locally or to Modal, Daytona, Fly.io, or Railway; agents are swapped by
one-line config, and custom agents are specified in YAML for cross-harness
portability. Innovates on the Environment and Organization layers. Relevance
to Claws: its Runner role directly overlaps `src/model-selector.ts`, and its
Server role overlaps `src/capabilities.ts`.

### DeepSeek Harness

[deepseek.com/harness/en](https://deepseek.com/harness/en)

MIT-licensed developer preview shipped alongside DeepSeek V4-Pro. A plugin
architecture where models, tools, skills, sessions, sandboxes, storage,
loops, scheduling, and UI are all independently swappable; run via
`npx @deepseek-ai/dsh web` or by cloning the repo. Non-DeepSeek model support
is not stated on the vendor page as of 2026-08-25. Innovates on the Session
layer (its plugin-swappable session/storage split is the clearest
branchable-session story of the twelve). Relevance to Claws: the plugin
session store is the sharpest example of the trajectory-log gap noted above.

### Buzz (Block)

[block.xyz/inside](https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together) ·
[github.com/block/buzz](https://github.com/block/buzz)

Apache 2.0, self-hostable. Built on Nostr: every human and agent holds a
cryptographic keypair, so identity is portable and platform-independent.
Provides channels, threads, DMs, voice, media, code repos, and automated
workflows, and is model/harness agnostic (agents can be Claude Code, Codex,
or goose). This is a Team-layer product, not a coding harness. Relevance to
Claws: low — Claws' Team layer is already GitHub, and Buzz solves a
multi-participant identity problem Claws (single-operator) doesn't have.

### QM (Y Combinator)

[qm.ycombinator.com](https://qm.ycombinator.com) ·
[github.com/yc-software/qm](https://github.com/yc-software/qm)

Open-sourced July 2026, named for "quartermaster". Fleet management for
OpenClaw-like agents — one agent per employee, Slack room, or project, each
with its own memory, files, credentials, permissions, and schedule, running
in a sandbox. Built because YC's earlier fleet of 50+ Hermes agents became
unmanageable. Supports cron and webhook triggers. Innovates on the
Organization layer (per-scope credential/permission isolation across many
agents). Relevance to Claws: none today — Claws runs one operator's agents
against one credential set, not a fleet needing per-employee scoping.

### Flue (Cloudflare)

[blog.cloudflare.com](https://blog.cloudflare.com/agents-platform-flue-sdk)

1.0 Beta, built on the Pi harness by the Astro team. Declarative: you
describe an agent's model, skills, sandbox, and instructions, and the
framework hides the loop. Multi-cloud — on Node.js, agents are long-lived
processes on VMs, containers, or GitHub Actions; on Cloudflare, each agent
becomes a Durable Object. Licence is not stated on the vendor page as of
2026-08-25. Innovates on the Environment layer (the Durable Object placement
model). Relevance to Claws: low — the Cloudflare-specific placement path
conflicts with Claws' Linux systemd deployment, and provider-agnostic model
routing already lives in `src/model-selector.ts`.

### Muse Code (Meta)

[developer.meta.com](https://developer.meta.com/ai/products/muse-code/)

Proprietary/commercial, two paid tiers differing on data-usage permissions.
Powered by Muse Spark 1.2, co-trained with the harness for "better tool use,
fewer retries" than a generic wrapper. Supports multi-agent coordination and
full auditability; no self-hosting story is published. Innovates on the
Model layer (co-training the model to the harness). Relevance to Claws: none
— proprietary, paid, and tied to a single vendor's model, which conflicts
with provider-agnostic routing and self-hosting.

### OpenClaw

[github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)

MIT, maintained by the OpenClaw Foundation. Node.js 22.22.3+/24.15+/25.9+,
TypeScript, pnpm monorepo. A local Gateway acts as the control plane for
sessions, tools, events, and channels; channel support spans WhatsApp,
Telegram, Slack, Discord, Google Chat, Signal, and iMessage, with companion
apps/nodes for voice, canvas, camera, and screen, a plugin SDK plus ClawHub
marketplace, and sandboxing with pairing approvals. Built as a single-operator
personal assistant. Innovates on the Team and Skills layers. Relevance to
Claws: its channel span overlaps `src/whatsapp.ts`/`src/slack.ts`, but it is
a general personal assistant, not a coding-task harness.

### NanoClaw

[github.com/nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw)

MIT, TypeScript/Node + Bun. Explicitly positioned as "a lightweight
alternative to OpenClaw that runs in containers for security" — its own docs
contrast OpenClaw's roughly half a million lines of code, 53 config files,
and 70+ dependencies with application-level permission checks against
NanoClaw's per-agent Docker containers with real filesystem boundaries.
Built on Anthropic's Claude Agent SDK; messages route via SQLite between a
host process and per-agent containers. Innovates on the Environment layer.
Relevance to Claws: directly relevant as the strongest argument for
container-level (not worktree-level) isolation, see the gap noted above.

### Hermes (Nous Research)

[github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)

MIT, Python + JS. Self-improving: a built-in learning loop creates skills
from experience, refines them in use, persists knowledge, searches its own
past conversations, and builds a model of the user across sessions.
Model-agnostic (Nous Portal, OpenRouter, OpenAI, OpenAI-compatible; 300+
models). Ships messaging channels, a TUI, procedural memory, 40+ tools, MCP,
a cron scheduler, and deploys to VPS, Docker, SSH, Singularity, Modal, or
serverless. Innovates on the Memory and Skills layers. Relevance to Claws:
its learning loop is the sharpest example of the Memory-layer gap noted
above (accrued preference modelling vs. Claws' document-based memory).

**Note:** this is a different project from the "Hermes" already declined in
`docs/tool-evaluations.md` (#2579) — that one is
[blog.jakesaunders.dev](https://blog.jakesaunders.dev/building-an-almost-fully-self-hosted-sandboxed-agentic-software-factory/)'s
self-hosted personal-assistant container. `NousResearch/hermes-agent` was not
evaluated in #2579 and has not been adopted here either.

### Conductor

[conductor.build](https://conductor.build)

Commercial native macOS app. Runs parallel Claude Code, Codex, and Cursor
agents in isolated workspaces, then supports reviewing and merging their
output. The vendor site does not state that these workspaces are git
worktrees specifically — described here as "isolated workspaces" only.
Innovates on the Environment layer (parallel-agent UX). Relevance to Claws:
low — a macOS-only commercial GUI app doesn't fit a Linux systemd service,
and `src/claude.ts` already does worktree-per-run isolation.

### Prime Agent (Prime Intellect)

[github.com/PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)

MIT, TypeScript/Node + Python. Built on two abstractions: the Recursive
Language Model (context as variables, tools as function calls in a
persistent IPython REPL) and the Continual Harness (stores and refines
supplemental prompts, memories, and reusable specs). Supports subagents via
`rlm(...)`, rollback snapshots, daemon-backed session reattach,
agent-to-agent messaging, an autonomous mode with turn/token/time budgets,
persistent goals, scheduled heartbeats, and skills as importable Python
packages. Explicitly **not** a security sandbox — it runs model-generated
code with the user's own permissions. Innovates on the Session and Memory
layers (rollback snapshots and daemon reattach are the closest thing among
the twelve to a branchable trajectory log). Relevance to Claws: the
rollback/reattach design is the closest external precedent for the
Session-layer gap noted above, but the explicit no-sandbox stance is a
regression versus Claws' worktree isolation.

### Pi

Referenced only as the underlying runner beneath Omnigent and Flue; neither
vendor page describes it in enough independent detail to add anything beyond
that here.

## Verdict: adopt none, today

1. **Claws is already a harness.** `src/main.ts` (PID lock, job
   registration), `src/scheduler.ts`, `src/worker.ts` (SQLite work queue),
   `src/sessions.ts`, `src/server.ts`, and `src/mcp-server.ts` already occupy
   the orchestrator role that Omnigent, DeepSeek Harness, QM, Hermes, and
   Prime Agent each want to fill. Running any of them alongside Claws would
   mean two schedulers contending for the same `WORK_DIR` worktrees, GitHub
   App installation tokens, PID lock, and work queue — a correctness
   problem, not a feature. See `docs/tool-evaluations.md`'s Firecrawl +
   Hermes entry (#2579), which reaches the same conclusion for the other
   Hermes project.
2. **Claws is single-operator and self-hosted.** QM's per-employee fleet
   scoping and Buzz's multi-participant identity solve problems Claws does
   not have.
3. **Model or platform lock-in conflicts with Claws' design.** Muse
   Code/Muse Spark 1.2 requires a specific model; Conductor requires macOS;
   Flue's best-fit path requires Cloudflare Durable Objects. All three
   conflict with `src/model-selector.ts`'s provider-agnostic routing and the
   Linux systemd deployment.
4. **Proprietary/paid is out of scope.** Muse Code and Conductor are
   commercial products; Claws is self-hosted.

## Ideas worth stealing, without adopting anything

These are observations only — **not scheduled, no issue filed by this PR.**

- **A forkable/replayable session trajectory log over `src/db.ts`.** The
  clearest genuine gap identified above (Session layer): Claws sessions are
  linear and live, with no way to rewind or branch a run the way DeepSeek
  Harness and Prime Agent's rollback snapshots do.
- **Container-level rather than worktree-level isolation in `src/claude.ts`**
  for agents that run untrusted repo code, following NanoClaw's argument
  that application-level permission checks are weaker than real filesystem
  namespace boundaries.
- **An explicit machine-readable policy layer above `src/capabilities.ts`**,
  in the shape of Omnigent's Server layer, rather than capability checks
  scattered through call sites.

## Revisit if

1. Claws grows past single-operator use and needs per-user scoped memory,
   credentials, or permissions (QM).
2. A repo under Claws needs to run genuinely untrusted code where a worktree
   boundary is insufficient (NanoClaw).
3. Claws needs to drive non-Claude coding agents as first-class runners
   rather than via `src/model-selector.ts` fallbacks (Omnigent's Runner
   layer).
4. Session replay or fork becomes a recurring debugging need for failed
   agent runs.

None of these hold today.
