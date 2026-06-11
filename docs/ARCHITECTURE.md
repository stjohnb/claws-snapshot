# Architecture Diagrams

A visual companion to [OVERVIEW.md](OVERVIEW.md). For prose descriptions of
each module, refer to OVERVIEW.md. This document focuses on **how the pieces
connect**.

All diagrams use [Mermaid](https://mermaid.js.org/), which GitHub renders
natively in markdown.

## Contents

- [System Overview](#system-overview)
- [Module Layering](#module-layering)
- [Dispatcher Fan-Out](#dispatcher-fan-out)
- [Issue Lifecycle](#issue-lifecycle)
- [PR Lifecycle](#pr-lifecycle)
- [Claude Invocation Path](#claude-invocation-path)
- [Worktree Lifecycle](#worktree-lifecycle)
- [HTTP / Dashboard Request Flow](#http--dashboard-request-flow)

---

## System Overview

The top-level shape: a single Node.js process registers ~21 scheduled jobs,
serves a dashboard, runs a bounded queue of `claude` CLI subprocesses in
isolated git worktrees, and persists everything to a local SQLite database.
External effects flow out via the `gh` CLI (GitHub) and Slack/WhatsApp/Email
gateways.

```mermaid
flowchart LR
  subgraph host["Linux host (systemd)"]
    main["main.ts<br/>entry point"]
    sched["scheduler.ts<br/>skip-if-busy timers"]
    queue["claude.ts<br/>bounded Claude queue"]
    server["server.ts<br/>HTTP dashboard"]
    db[("db.ts<br/>SQLite (~/.claws/claws.db)")]
    wt["worktrees<br/>~/.claws/worktrees/..."]
  end

  subgraph external["External services"]
    gh["GitHub<br/>(gh CLI + App tokens)"]
    cli["claude / codex / opencode CLIs"]
    slack["Slack"]
    wa["WhatsApp (Baileys)"]
    mail["Gmail (IMAP)"]
    k3s["k3s cluster (kubectl)"]
    namey["namey PostgreSQL"]
  end

  user(["Operator"]) -->|browser| server
  main --> sched
  main --> server
  sched -->|run| jobs["src/jobs/*"]
  jobs -->|delegate| agents["src/agents/*"]
  agents --> queue
  jobs --> queue
  queue -->|spawn| cli
  queue --> wt
  jobs --> gh
  agents --> gh
  jobs --> db
  server --> db
  jobs --> slack
  jobs --> wa
  jobs --> mail
  jobs --> k3s
  cli -.->|MCP stdio| mcp["mcp-server.ts"]
  mcp --> db
  mcp --> namey
```

---

## Module Layering

Modules in `src/` form an informal layering. Lower layers know nothing about
higher ones; higher layers compose lower ones. This is a logical grouping, not
a directory structure.

```mermaid
flowchart TB
  subgraph L1["Foundation (no internal deps)"]
    config["config.ts"]
    log["log.ts"]
    format["format.ts"]
    shutdown["shutdown.ts"]
    version["version.ts"]
  end

  subgraph L2["Persistence & validation"]
    db["db.ts"]
    sqlv["sql-validation.ts"]
    pp["plan-parser.ts"]
    outcome["outcome.ts"]
    pg["prompt-guard.ts"]
  end

  subgraph L3["I/O & integrations"]
    github["github.ts"]
    ghapp["github-app.ts"]
    claude["claude.ts"]
    slack["slack.ts"]
    sessions["sessions.ts"]
    whatsapp["whatsapp.ts"]
    transcribe["transcribe.ts"]
    images["images.ts"]
    namey["namey-query.ts"]
    ollama["ollama-rate-limit-classifier.ts"]
  end

  subgraph L4["Orchestration & policy"]
    sched["scheduler.ts"]
    msel["model-selector.ts"]
    cclass["classify-complexity.ts"]
    timeout["timeout-handler.ts"]
    err["error-reporter.ts"]
  end

  subgraph L5["Workflow modules"]
    agents["agents/*<br/>issue-refiner, issue-worker,<br/>ci-fixer, review-addresser,<br/>pr-reviewer, auto-merger"]
    jobs["jobs/*<br/>issue-dispatcher, pr-dispatcher,<br/>doc-maintainer, scanners,<br/>idea-*, k3s-monitor, ..."]
  end

  subgraph L6["Presentation & APIs"]
    server["server.ts"]
    pages["pages/*<br/>dashboard, queue, logs,<br/>config, topology, repo, ..."]
    mcp["mcp-server.ts"]
  end

  L7["main.ts (composition root)"]

  L2 --> L1
  L3 --> L1
  L3 --> L2
  L4 --> L1
  L4 --> L2
  L4 --> L3
  L5 --> L1
  L5 --> L2
  L5 --> L3
  L5 --> L4
  L6 --> L1
  L6 --> L2
  L6 --> L3
  L6 --> L4
  L6 --> L5
  L7 --> L6
  L7 --> L5
  L7 --> L4
```

> **Reading note:** `github-app.ts` produces installation tokens that
> `github.ts` and `claude.ts` consume via env-var injection — not via a direct
> function call. `agents/agent-context.ts` exports prompt-context strings
> shared across all agents.

---

## Dispatcher Fan-Out

Two dispatcher jobs (`issue-dispatcher`, `pr-dispatcher`) classify items once
per repo and fan out to per-concern agents. Agents are individually disablable
via `disabledAgents` in config.

```mermaid
flowchart LR
  subgraph issueFlow["issue-dispatcher.ts"]
    iclassify["classify(issue)"]
    iclassify -->|new / no plan| planner["agents/issue-refiner.ts<br/>(planner)"]
    iclassify -->|unreacted feedback| planner
    iclassify -->|Refined label| impl["agents/issue-worker.ts<br/>(implementer)"]
  end

  subgraph prFlow["pr-dispatcher.ts"]
    pclassify["classify(pr)"]
    pclassify -->|failing CI or conflicts| cif["agents/ci-fixer.ts"]
    pclassify -->|reviewer feedback from human or Claws| ra["agents/review-addresser.ts"]
    pclassify -->|always| rev["agents/pr-reviewer.ts<br/>(reviewer)"]
    pclassify -->|LGTM + green CI or doc/idea-only PR| merge["agents/auto-merger.ts<br/>(merger)"]
  end

  planner -.->|plan comment + Ready| GH[(GitHub)]
  impl -.->|PR| GH
  cif -.->|commits / rerun| GH
  ra -.->|commits / reply| GH
  rev -.->|review comment| GH
  merge -.->|squash-merge| GH
```

> **Concurrency guard:** the pr-dispatcher skips review-addresser for PRs
> that already have ci-fixer work in the same cycle (and skips conflicting
> PRs entirely in the review-addresser phase) so that ci-fixer and
> review-addresser never push to the same branch concurrently.

---

## Issue Lifecycle

State transitions a typical issue moves through. Labels are shown in
**bold**. Most transitions are content-driven (comments, reactions, PR state)
rather than label-driven — `Refined` is the only label that itself triggers
work.

```mermaid
stateDiagram-v2
  [*] --> Created
  Created --> Planning: planner picks up (no plan comment yet)
  Planning --> Ready: plan posted, Ready added
  Ready --> Refining: human leaves feedback (unreacted comment)
  Refining --> Ready: planner refines plan, Ready re-added
  Ready --> Refined: human adds Refined label
  Refined --> Implementing: implementer picks up
  Implementing --> InReview: PR opened, Refined and Ready removed
  InReview --> Closed: PR merged
  Closed --> [*]

  Ready --> Skipped: human adds Claws Ignore or auto-skip after 3 timeouts
  Implementing --> NoChanges: zero commits produced, Refined removed
  NoChanges --> Refined: human re-adds Refined
```

---

## PR Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Open

  Open --> Reviewed: pr-reviewer posts review (every cycle if new commits)
  Reviewed --> AddressingReview: review-addresser picks up (human or Claws review)
  AddressingReview --> Reviewed: commits pushed, reviewer re-runs same cycle

  Open --> CIFixing: failing checks
  CIFixing --> Open: fix commits pushed or workflow rerun
  CIFixing --> Problematic: circuit breaker tripped, Claws Problematic added

  Open --> QA: human comments QA this
  QA --> Reviewed: Playwright report posted

  Reviewed --> ReadyToMerge: LGTM + passing CI, Ready added
  ReadyToMerge --> Merged: auto-merger squash-merges
  Merged --> [*]

  Open --> AutoMerge: dependabot OR doc-only OR idea-collection PR with green CI
  AutoMerge --> Merged
```

---

## Claude Invocation Path

Every agent and most jobs call `runClaude()` in `claude.ts`. This module owns
the bounded concurrent queue, multi-provider fallback, timeout handling, and
worktree integration.

```mermaid
flowchart TB
  caller["Job or agent<br/>calls runClaude(opts)"]

  caller --> ovr["timeout-handler.getItemTimeoutMs(item)<br/>(per-item override or default)"]
  ovr --> enq["claude.enqueue<br/>(bounded queue, max=2 by default)"]

  enq --> retry["runClaude → runClaudeOnce<br/>(retries on 0-byte timeout,<br/>numTurns=0, or transient API 5xx)"]

  retry --> fb{Provider<br/>fallback loop}
  fb -->|capability='tool-use'| tuOrder["TOOL_USE_PROVIDER_FALLBACK_ORDER<br/>(default: claude → ...)"]
  fb -->|capability='text-only'| toOrder["TEXT_ONLY_PROVIDER_FALLBACK_ORDER<br/>(default: opencode → ...)"]

  tuOrder --> dispatch
  toOrder --> dispatch

  dispatch{{"runClaudeOnce<br/>dispatches to one of:"}}
  dispatch --> claudecli["runClaudeCliOnce<br/>(spawn 'claude')"]
  dispatch --> codex["runCodexOnce<br/>(spawn 'codex')"]
  dispatch --> opencode["runOpenCodeOnce<br/>(spawn 'opencode')"]

  claudecli --> mcp["MCP config:<br/>claws state + optional Playwright"]
  mcp -.-> mcps["mcp-server.ts<br/>(stdio child of claude CLI)"]

  claudecli --> result{Result?}
  codex --> result
  opencode --> result

  result -->|success| done["return text<br/>+ onProviderUsed callback"]
  result -->|AgentCliError rate-limit classified by ollama| trip["Mark provider<br/>rate-limited<br/>(circuit breaker)"]
  trip --> fb
  result -->|AgentTimeoutError| esc["timeout-handler.<br/>handleTimeoutIfApplicable<br/>(escalate × 1.5 or auto-skip)"]
  result -->|other error| rep["error-reporter<br/>(Slack + [claws-error] issue)"]

  done --> dbrec["db.ts records<br/>model_used, provider_used"]
```

---

## Worktree Lifecycle

Tasks operate in throwaway git worktrees so concurrent work on the same repo
cannot interfere. Always created and destroyed in pairs via the
`withNewWorktree` / `withExistingWorktree` helpers.

```mermaid
sequenceDiagram
  participant J as Job/Agent
  participant C as claude.ts
  participant G as git CLI
  participant FS as ~/.claws/worktrees/...

  J->>C: withNewWorktree(repo, branch, jobNamespace, fn)
  C->>C: ensureClone(repo) — fetch + reset main clone
  C->>G: git worktree add (--detach OR --no-track)
  G->>FS: create worktree dir
  C->>J: invoke fn(wtPath)

  Note over J: agent runs Claude,<br/>generates commits,<br/>pushes branch

  J-->>C: fn resolves (or throws)
  C->>G: git worktree remove --force
  C->>G: git branch -D claws-wt/... (if scoped)
  G->>FS: delete worktree dir
  C->>J: return / re-throw
```

> **Crash recovery:** on startup, `main.ts` calls `db.findRunningTasks()`,
> reaps the dangling worktrees, and marks the tasks `failed`.

---

## HTTP / Dashboard Request Flow

The dashboard is built on the **Hono** framework (via `@hono/node-server`). All mutating
endpoints emit Slack notifications (gated by `notifyDashboardActions`).

```mermaid
flowchart LR
  client["Browser / API client"] -->|HTTP| server["server.ts"]

  server --> auth{Auth mode}
  auth -->|OIDC configured| oidc["redirect → authentik<br/>/auth/callback exchanges code<br/>signed claws_session cookie"]
  auth -->|OIDC not configured| denied["503 — OIDC required"]

  oidc --> route

  route{{Route dispatch}}
  route -->|GET /| pages_dash["pages/dashboard.ts"]
  route -->|GET /queue| pages_q["pages/queue.ts"]
  route -->|GET /logs| pages_l["pages/logs.ts"]
  route -->|GET /config| pages_c["pages/config.ts"]
  route -->|GET /topology| pages_t["pages/topology.ts"]
  route -->|GET /sessions/:id/ws| ws["sessions.ts<br/>(WebSocket → tmux/node-pty)"]
  route -->|POST /trigger/:job| sched["scheduler.triggerJob"]
  route -->|POST /pause/:job| sched
  route -->|POST /cancel| q["claude.cancelCurrentTask"]
  route -->|POST /queue/refresh| sched
  route -->|POST /queue/merge,skip,prioritize,...| ghOps["github.ts ops<br/>(skip / prioritize / merge)"]

  pages_dash --> db[("db.ts")]
  pages_q --> ghCache["github queue cache"]
  pages_l --> db
  pages_c --> conf["config.ts"]
```

---

## Where to go next

- For the prose description of each module's responsibilities, read
  [OVERVIEW.md](OVERVIEW.md).
- For database table definitions and indexes, read
  [database-schema.md](database-schema.md).
- For per-job behavior and failure modes, read [jobs/](jobs/README.md).
