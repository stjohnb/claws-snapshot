# shopping-sourcer

**Source**: `src/jobs/shopping-sourcer.ts`
**Trigger**: Daily schedule (`schedules.shoppingSourcerHour`, default 7 AM local)

Sources hardware for project shopping lists. Each managed repo can declare one
or more manifests under `docs/shopping/`; every day Claws searches marketplaces
for the items that are still wanted, and maintains **one consolidated tracking
issue in the claws repo** covering every repo's manifests (#2647). Purchases and
payment are always made manually by a human — Claws never buys anything.

Manifests stay distributed in the project repos; only the issue is centralised.
Shopping for different projects overlaps heavily on suppliers, so the issue
groups candidates into **baskets by store** rather than by project — one order
at a store can move several projects on at once.

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
| `project` | Display title used in the tracking issue, where it links back to this file. Required. |
| `active_phases` | Phase numbers currently unlocked. Items whose `phase` is not in this list count towards the project's outstanding total but are never searched — this is how a staged build avoids buying everything up front (#2528). |
| `items[].id` | Stable slug, unique within the file. Used as the search-throttling key, so renaming an id resets its search history. |
| `items[].name` | What to buy, in plain English. This is what the agent searches for. |
| `items[].phase` | Which phase the item belongs to. Default `1`. |
| `items[].status` | `sourcing` (searched), or `found` / `ordered` / `delivered` / `skip` (tracked but never searched). Default `sourcing`. A manifest whose items are all `delivered` or `skip` drops off the tracking issue entirely; the manifest still records them. |
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
- **Managing a list**: **comment on the consolidated tracking issue** in plain
  English, naming the project or the item — "mark the ha-carlink ESP32
  delivered", "unlock phase 2 on the NAS expansion", "skip cable ties
  everywhere". [shopping-comment-processor](shopping-comment-processor.md) reads
  new comments every 10 minutes, commits each manifest edit to its own repo's
  default branch, and replies saying what it changed; delete the comment once it
  has. This is the main update flow. Opening a plain issue still works and is
  what you need if the tracking issue has already closed.
- **Or edit the YAML directly** if that's quicker. All paths are equivalent.

### Issue updates

The consolidated issue's body is rewritten only when a manifest or the candidate
set actually changes. A re-search that finds the same listings at the same
prices leaves the issue untouched — even though the agent's summary wording is
re-generated every run — so `updated_at` stays meaningful instead of bumping
daily and cluttering the "recently updated" issues view (#2611, #2634).

Three rules keep a re-search of an unchanged market from looking like a
change: the sourcing prompt carries the candidates already on the issue and
instructs the agent to return the still-live ones verbatim, so re-searching
the same market produces an identical result; prices are compared on their
first currency amount, so a re-worded price string (`£5.29` vs `£5.29 + £1.79
postage`) is not a change; and a run that returns no candidates for an item
that previously had some leaves the stored list intact, because a blocked
site is more likely than the whole market vanishing overnight — clear a
genuinely dead list by setting the item's `status` to `skip` or `found` in
the manifest.

Because one body is now built from every repo, **every list in it is explicitly
sorted** — projects by `(repo, path)`, store groups by cross-project coverage,
candidates in manifest/stored order. `upsertAlertIssue` byte-compares the body,
so any nondeterministic ordering would edit the issue every single day.

For the same reason, **a run in which any repo failed to process leaves the
issue untouched**: a body built from partial data would silently drop whole
projects, which reads as "nothing outstanding there".

The prompt guidance that makes the planner and implementer aware of this lives in
`SHOPPING_MANIFEST_CONTEXT` (`src/agents/agent-context.ts`), which also owns the
schema template embedded in this doc and in the malformed-manifest alert.

## Lifecycle

1. Each run lists `docs/shopping/` in every managed repo and parses each manifest.
   Any pre-#2647 per-manifest tracking issue (`[shopping] <stem>: sourcing &
   tracking`) it finds is closed — the migration needs no manual step.
2. **Sourceable** items are those with `status: sourcing` whose `phase` is in
   `active_phases`. A manifest with none is still reported, just not searched.
3. **Due** items are sourceable items never searched, or last searched at least
   `recheck_days` ago. At most 8 items are searched per manifest per run
   (oldest-searched first); the rest wait for the next run.
4. If anything is due, one browser-capable agent call per manifest covers all its
   due items. The result for every due item is recorded in SQLite — **including
   empty results**, which is what stops a hard-to-find item from being
   re-searched every hour. The prompt also names any store already supplying
   candidates to two or more manifests, so equivalent listings converge on stores
   an order is already going to.
5. Once every repo has been processed, one issue body is rebuilt from all the
   manifests plus the latest stored candidates — **even when a run's search
   failed**, since the project list is a pure function of the manifests. If
   nothing was due anywhere, the body is refreshed from storage without invoking
   any agent. If sourcing throws for a project (e.g. the agent is killed for
   exceeding its memory cap), the body still rebuilds with a per-project warning
   banner, and that project's stored candidates are left intact.

The tracking issue is titled `[shopping] Sourcing & tracking — all projects`,
lives in `SELF_REPO` (`St-John-Software/claws`) and carries the `Claws Ignore`
label, so neither issue dispatcher picks it up. It closes automatically once no
item is in `sourcing` state for an active phase in *any* repo.

Its body has four sections:

- **Projects** — one bullet per manifest, linking to
  `https://github.com/<repo>/blob/HEAD/<path>` with its sourcing/outstanding
  counts. Deliberately no per-item detail: the manifest is the record, and
  the issue links back to it.
- **Baskets by store** — every candidate for every currently-sourceable item,
  grouped by the candidate URL's hostname (`www.` stripped). Groups are ordered
  by how many distinct projects the store covers, then candidate count, then
  hostname — most effective basket first. Each bullet says which item and which
  project it is for.
- **Still searching** — sourceable items with no candidates yet.
- **How to update** — the comment flow.

The body is rebuilt on every run and re-posted only when it actually differs, so
editing it by hand is pointless — change a manifest, or comment on the issue and
let [shopping-comment-processor](shopping-comment-processor.md) change the
manifest for you. It is deliberately rendered as bullet lists rather than
Markdown tables (#2584). A five-column candidates table overflowed the viewport
on mobile and forced horizontal scrolling; lists reflow to any width. Do not
reintroduce a table here.

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
