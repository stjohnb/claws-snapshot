# site-promoter

**Source**: `src/jobs/site-promoter.ts`
**Trigger**: Daily schedule (`schedules.sitePromoterHour`, default 11 AM local)

Promotes the websites the org runs. Each project repo can declare one or more
manifests under `docs/promotion/`; every day Claws picks the sites whose
channels are due, runs a growth-marketing agent **inside a worktree of that
site's own repo** so it reads the real product, and files at most two concrete
issues per site.

Two kinds of issue come out of it:

- **Code channels** (SEO pages, AEO, free tools, share cards, blog posts) file
  an **unlabelled** issue. The normal Claws pipeline plans and implements it like
  any other issue.
- **Manual channels** (Reddit, X, Bluesky, Instagram, TikTok, …) file an issue
  labelled **`Claws Ignore`** whose body is the final copy, ready to paste. Claws
  never posts to a platform itself — a human does, so nothing here depends on a
  platform's automation policy.

Manifests are repo-owned: nothing in the claws repo knows which sites exist. A
repo with no `docs/promotion/` directory is a silent no-op.

Strategy reference given to the agent:
<https://github.com/EdoStra/Marketing-for-Founders>.

## Manifest schema

`docs/promotion/<kebab-slug>.yaml` (or `.yml`):

```yaml
project: Namey                    # display title, required
sites:
  - id: namey-baby                # stable slug, required, unique within the file
    name: Namey (baby names)      # required
    url: https://namey.baby/      # required, must be a full URL
    status: active                # active|paused; default active
    audience: >-                  # optional — who you are trying to reach
      Expectant parents shortlisting baby names.
    pitch: >-                     # optional — what the site is, in one or two sentences
      Baby-name discovery and shortlisting app.
    channels:                     # channels this site is marketed on
      - seo-content               # a bare id uses the built-in cadence
      - bluesky
      - id: reddit                # or an object to override
        cadence_days: 30          # optional, integer >= 1
        notes: >-                 # optional — the owner's rules for this channel
          Only r/namenerds; no link in the post body.
      - id: guest-blog
        target_repo: St-John-Software/bstjohn-blog   # optional; default is this repo
```

### Fields

| Field | Meaning |
|-------|---------|
| `project` | Display title for the manifest. Required. |
| `sites[].id` | Stable slug, unique within the file. It is the cadence key, so renaming one resets its promotion history. |
| `sites[].name` | The site's name, as the agent should refer to it. |
| `sites[].url` | The site's public URL. Must be a full URL. |
| `sites[].status` | `active` (promoted) or `paused` (kept in the file, never promoted). Default `active`. |
| `sites[].audience` | Who you are trying to reach. Passed to the agent verbatim. |
| `sites[].pitch` | What the site is, in a sentence or two. The agent still reads the repo — this only orients it. |
| `sites[].channels` | The channels this site is marketed on. A bare id uses the built-in cadence; an object may set `cadence_days`, `notes` and `target_repo`. |
| `channels[].cadence_days` | Overrides the channel's default cadence. Integer ≥ 1. |
| `channels[].notes` | The owner's rules for that channel ("only r/namenerds", "post from @namey.baby"). Given to the agent verbatim and overriding the built-in brief. |
| `channels[].target_repo` | `owner/name` of the repo this channel's issues are filed into. Default is the manifest's own repo. Must be a Claws-managed repo — a channel pointing anywhere else is skipped with a warning, so one repo's manifest cannot dispatch auto-implemented work into an unmanaged repo. |

A malformed manifest raises one per-repo alert issue listing each bad file and
its parse error, with the schema inlined. That alert closes automatically once
every manifest parses.

## Channels

| id | Channel | Mode | Default cadence (days) |
|----|---------|------|------------------------|
| `seo-content` | SEO landing/content page | code | 14 |
| `aeo` | AI answer-engine optimisation | code | 30 |
| `free-tool` | Free standalone mini-tool | code | 45 |
| `share-cards` | Open Graph / share-card polish | code | 90 |
| `guest-blog` | Blog post about the site | code | 30 |
| `reddit` | Reddit post | manual | 21 |
| `x` | X post | manual | 14 |
| `bluesky` | Bluesky post | manual | 14 |
| `instagram` | Instagram post | manual | 21 |
| `tiktok` | TikTok short video | manual | 21 |
| `youtube-shorts` | YouTube Short | manual | 30 |
| `pinterest` | Pinterest pin | manual | 21 |
| `hacker-news` | Hacker News / Indie Hackers post | manual | 90 |
| `product-hunt` | Product Hunt launch | manual | 180 |
| `directories` | Directory / aggregator listing | manual | 60 |
| `newsletter` | Email / newsletter send | manual | 30 |

`PROMOTION_CHANNELS` in `src/jobs/site-promoter.ts` is the single source of
truth — it also carries each channel's brief, which is what tells the agent what
a good action for that channel looks like. Adding a channel is one entry there.

Each channel's `mode` decides what happens to its issues:

- `code` — filed with **no labels**, so `issue-dispatcher` picks it up and the
  usual planner/implementer flow builds it. The brief requires the agent to name
  real files and routes in the checked-out repo, which is why the agent works in
  a worktree rather than from the manifest alone.
- `manual` — filed with **`Claws Ignore`**, which is what stops an implementer
  agent being dispatched to "post to TikTok". The brief requires the final copy
  verbatim, within the platform's constraints (300 characters for Bluesky, a hook
  and shot list for TikTok/Shorts, an image concept for Instagram/Pinterest),
  plus exactly where to post it and that platform's self-promotion rules.

## Caps

Code-mode issues are auto-implemented with no human triage, so the caps are the
safety valve:

| Cap | Value |
|-----|-------|
| Actions filed per site per run | 2 |
| Channels considered per site per run | 3 |
| Sites promoted per run | 4 |
| Minimum score to file | 7/10 |
| Channel cadences | 14–180 days |

Sites run **sequentially**, one agent at a time — this is a shared,
resource-constrained host.

## Dedup

Two independent gates:

- **Cadence** — every filed action is recorded in the `promotion_actions` table,
  and a channel is not due again until its `cadence_days` have elapsed. This is
  what stops a closed or rejected action being re-filed, since title search only
  sees open issues.
- **Title** — `findIssueByExactTitle` on the target repo, checked immediately
  before filing. Filing is sequential so the check sees an issue filed moments
  earlier in the same run.

## Provider

The agent runs on **OpenCode via OpenRouter** (`provider: "opencode"`,
`strictProvider: true`) with the read-only `plan` agent. The pin is deliberate:
without `strictProvider` a failure would silently fall back to the Claude CLI.
An OpenCode outage therefore fails that site's run — nothing is filed, its
cadence is unchanged, and the next day retries. If neither an OpenRouter key nor
the `opencode` binary is configured, the whole job logs and returns.

## Lifecycle

1. Each run lists `docs/promotion/` in every managed repo and parses each
   manifest. Malformed files raise (or clear) the per-repo alert.
2. Every site with `status: active` becomes a candidate. Its channels are
   resolved against `PROMOTION_CHANNELS` with the manifest's overrides applied.
3. **Due** channels are those never filed, or last filed at least
   `cadence_days` ago — never-filed first, at most 3 per site. Sites with no due
   channel are dropped; the rest are ordered by their oldest filing and capped at
   4 sites.
4. For each selected site, in turn: fetch the open issue titles of every target
   repo its due channels file into (guarded, since issue titles are
   attacker-influenceable), then run one agent in a fresh
   `claws/promote-<suffix>` worktree of the site's repo. The worktree is for
   reading only — the job commits and pushes nothing, and `withNewWorktree`
   tears it down.
5. The agent's JSON is filtered to due channels, one action per channel,
   score ≥ 7, top 2. Each surviving action is filed into
   `channels[].target_repo` (default: the manifest's own repo) and recorded in
   SQLite. A failure filing one action does not stop the others; a failure
   anywhere in a site is reported and the next site still runs.

## Creating and managing a manifest

You do not need to write YAML by hand. Open an ordinary issue in the project
repo — "promote namey on Bluesky and Reddit", "stop promoting perudo",
"only post to r/namenerds" — and the planner proposes the exact manifest YAML,
which the implementer opens as a PR through the normal flow. The prompt guidance
that makes the planner and implementer aware of this lives in
`PROMOTION_MANIFEST_CONTEXT` (`src/agents/agent-context.ts`), which also owns
the schema template embedded in this doc and in the malformed-manifest alert.

Editing the YAML directly works just as well. Both paths are equivalent.

The job can also be disabled per repo from the `/jobs` matrix on the dashboard,
which is independent of whether that repo has a manifest.
