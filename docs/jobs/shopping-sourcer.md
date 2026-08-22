# shopping-sourcer

**Source**: `src/jobs/shopping-sourcer.ts`
**Trigger**: Daily schedule (`schedules.shoppingSourcerHour`, default 7 AM local)

Sources hardware for project shopping lists. Each managed repo can declare one
or more manifests under `docs/shopping/`; every day Claws searches marketplaces
for the items that are still wanted, and maintains a single tracking issue per
manifest listing the candidates it found. Purchases and payment are always made
manually by a human — Claws never buys anything.

Repos without a `docs/shopping/` directory are a no-op.

## Manifest schema

`docs/shopping/<kebab-slug>.yaml` (or `.yml`):

```yaml
project: NAS expansion            # display title, required
active_phases: [1]                # phases currently unlocked for sourcing; default [1]
items:
  - id: hba-9207-8e               # stable slug, required, unique within the file
    name: LSI SAS 9207-8e HBA (IT mode)   # required
    phase: 1                      # default 1; items in a phase not listed in active_phases are not searched
    status: sourcing              # sourcing|found|ordered|delivered|skip; default sourcing
    max_price: "£40"              # optional free-text budget
    notes: >-                     # optional search hints for the sourcing agent
      Must be SAS2308 / 9207-8e, not 9200-8e. UK sellers preferred.
    recheck_days: 1               # optional, integer >= 1, default 1
```

Minimal copy-paste template:

```yaml
project: My project
active_phases: [1]
items:
  - id: first-item
    name: What to buy
    max_price: "£50"
```

### Fields

| Field | Meaning |
|-------|---------|
| `project` | Display title used in the tracking issue. Required. |
| `active_phases` | Phase numbers currently unlocked. Items whose `phase` is not in this list are shown in the outstanding-items table but never searched — this is how a staged build avoids buying everything up front. |
| `items[].id` | Stable slug, unique within the file. Used as the search-throttling key, so renaming an id resets its search history. |
| `items[].name` | What to buy, in plain English. This is what the agent searches for. |
| `items[].phase` | Which phase the item belongs to. Default `1`. |
| `items[].status` | `sourcing` (searched), or `found` / `ordered` / `delivered` / `skip` (tracked but never searched). Default `sourcing`. Items marked `delivered` or `skip` are dropped from the tracking issue's table (replaced by a one-line hidden count); the manifest still records them. |
| `items[].max_price` | Free-text budget passed to the agent, e.g. `"£40"`, `"under $60 shipped"`. |
| `items[].notes` | Search hints and constraints — exact model numbers to accept or reject, preferred sellers, condition requirements. |
| `items[].recheck_days` | How often to re-search this item. Default `1`. Raise it for items unlikely to appear often. |

A malformed manifest raises one per-repo alert issue listing each bad file and
its parse error, with the schema inlined. That alert closes automatically once
every manifest parses.

## Creating and managing a list

You do not need to write YAML by hand, and there is no special issue title.

- **Starting a list**: open an ordinary issue in the project repo describing the
  hardware you need ("parts for the NAS expansion: an 8-port HBA under £40, two
  SFF-8088 cables, …"). Claws' planner knows about this feature, proposes the
  exact manifest YAML in its plan, and the implementer opens the PR through the
  normal worktree flow. You review it like any other plan and PR.
- **Managing a list**: **comment on the list's tracking issue** in plain English
  — "mark the HBA delivered", "unlock phase 2", "add a 10GbE NIC under £60".
  [shopping-comment-processor](shopping-comment-processor.md) reads new comments
  every 10 minutes, commits the manifest edit to the default branch, and replies
  saying what it changed; delete the comment once it has. This is the main update
  flow. Opening a plain issue still works and is what you need if the tracking
  issue has already closed.
- **Or edit the YAML directly** if that's quicker. All paths are equivalent.

The prompt guidance that makes the planner and implementer aware of this lives in
`SHOPPING_MANIFEST_CONTEXT` (`src/agents/agent-context.ts`), which also owns the
schema template embedded in this doc and in the malformed-manifest alert.

## Lifecycle

1. Each run lists `docs/shopping/` in every managed repo and parses each manifest.
2. **Sourceable** items are those with `status: sourcing` whose `phase` is in
   `active_phases`. If a manifest has none, its tracking issue is closed.
3. **Due** items are sourceable items never searched, or last searched at least
   `recheck_days` ago. At most 8 items are searched per manifest per run
   (oldest-searched first); the rest wait for the next run.
4. If anything is due, one browser-capable agent call covers all due items. The
   result for every due item is recorded in SQLite — **including empty results**,
   which is what stops a hard-to-find item from being re-searched every hour.
5. The tracking issue body is rebuilt from the manifest plus the latest stored
   candidates **on every run, even when this run's search fails** — the Status
   table is a pure function of the manifest and needs no search results. If
   nothing was due, the body is refreshed from storage without invoking any
   agent. If sourcing throws (e.g. the agent is killed for exceeding its memory
   cap), the body still rebuilds with a warning banner above the candidates,
   and the stored candidates from previous runs are left intact. The table
   lists only outstanding items — everything except `delivered` and `skip`,
   including gated-phase items (#2528).

The tracking issue is titled `[shopping] <file stem>: sourcing & tracking` and
carries the `Claws Ignore` label, so neither issue dispatcher picks it up. Its
body is rewritten on every run, so editing the body by hand is pointless —
change the manifest, or comment on the issue and let
[shopping-comment-processor](shopping-comment-processor.md) change the manifest
for you. Renaming a manifest file orphans its tracking issue; close it by hand.

## Security

The sourcing agent reads untrusted marketplace listings, so it is deliberately
boxed in:

- It runs in a per-repo scratch directory (`scratch/shopping-sourcer/<owner>-<name>`),
  never a git worktree, and never touches a repo clone. The per-repo scoping keeps
  two concurrently-processed repos from sharing a Claude CLI session state.
- `disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Task"]` with the
  provider pinned to `claude` **and** `noProviderFallback: true` (the flag is
  Claude-CLI-only, so a rate-limit fallback onto `codex`/`opencode` would re-run
  the same prompt with no tool restriction at all). The agent can browse and
  report; it cannot act on this host.
- Its MCP config carries **only** the Playwright server
  (`writeClawsMcpConfig(..., { includeClawsState: false })`). The `claws-state`
  server exposes queue state, cross-repo task history, open PR titles and the
  operator's config as callable tools, so an agent reading attacker-controlled
  listings must not have it — otherwise injected page text could get that state
  folded into the JSON summary and posted to the tracking issue.
- The prompt states that page content is untrusted data rather than instructions,
  and that the agent only navigates and reads: no clicking buy / checkout /
  add-to-cart / bid / reserve / login / submit controls, and no entering personal,
  payment or account details. Purchases are always made manually by a human.
- It returns strict JSON. Claws builds the issue body itself from Zod-validated
  fields — no agent-authored markdown is ever pasted through.
- Every scraped string passes `guardContent()` before it reaches the issue body,
  because Claws does not re-guard its own comments when reading them back.
- Candidate URLs are dropped unless they parse as `http:`/`https:`, and free-text
  fields are length-capped.

## Resources

The agent drives headless Chromium via `@playwright/mcp`, and Claude plus a
full Chromium process tree (browser/renderer/GPU/network) routinely lands just
over the global 2 GiB worker memory cap. This job raises its own cap per call
(`claude.BROWSER_AGENT_MEMORY_MAX_BYTES`, 4 GiB) via `runClaude`'s
`memoryMaxBytes` option, because the global cap cannot fit Claude plus a
browser.
