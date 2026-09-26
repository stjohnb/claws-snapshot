# Claws-native issue tracker

**Reference.** Read this when changing how Claws stores, routes, or renders its
own issues — the third issue backend alongside GitHub and Forgejo.

Product requirements: [product/automation-lifecycle.md](product/automation-lifecycle.md).

Claws keeps one global stream of issues in its own database, each tagged with
the managed repository (or repositories) it concerns. A native issue is planned,
refined, implemented, reviewed and merged by exactly the same jobs as a forge
issue: no dispatcher, agent or worker knows the difference.

**Source**: `src/issue-id.ts` (identity), `src/claws-issues.ts` (the store's
mapping layer), `src/db.ts` (the SQL and the tables), `src/github.ts` (the
routing façade), `src/markdown.ts` (rendering), `src/issue-board.ts` (the
board's column model), `src/pages/issue.ts`, `src/pages/board.ts` and
`src/server.ts` (the dashboard).

## Identity

An issue is `clw_` + a 26-character ULID; a comment is `clwc_` + the same.

```
clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC
clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC
```

The ULID is Crockford base32 (no I, L, O or U): a 48-bit millisecond timestamp
followed by 80 random bits. `src/issue-id.ts` mints them in process, and two
properties are load-bearing:

- **Collision-free without a round trip.** A `MAX(number) + 1` allocation is a
  read-then-write race on Postgres under READ COMMITTED, and Claws has no mutex
  to close it with. Minting the id in process removes the race entirely.
- **Sortable.** Same-millisecond calls *increment* the random component rather
  than redrawing it, so ids from one process are strictly increasing and
  `ORDER BY id` is exact creation order for comments. A clock that steps
  backwards keeps the previous timestamp rather than rewinding, so an id can
  never sort before one already issued. Claws runs a single pod; across restarts
  the ordering holds to clock accuracy.

An `issue-id: random component overflow` error means 2⁸⁰ ids were minted inside
one millisecond. It cannot happen; it throws rather than wrapping because a wrap
would hand out a duplicate.

### Case

Refs are **case-insensitive on read, canonical on write**. `isClawsIssueId`
accepts any case, and `canonicalIssueRef` returns `clw_` (lower) plus an
uppercase body. Everything Claws generates or stores is canonical; a human
typing `#clw_01jbq…` into an issue body still resolves.

Canonicalise at the entry point, never mid-pipeline: the store functions,
`/issues/:id`, `extractClosedIssueRefs`, the branch parsers,
`getLinkedIssueNumber`, `extractRelatedNumbers`, the MCP arguments and the
dashboard forms all do it before any lookup. Body and marker searches compare
lower-cased on both sides.

Two boundaries make the rule structural rather than a promise every caller has
to keep: `db.ts`'s `refParam()` canonicalises every write to the six widened
ref columns, and `github.ts`'s `queueRef()` canonicalises every queue-cache
key. Those are the places to enforce it — not the call sites, which is where it
rots.

### Presentation

Every native id minted in the same period shares the same 48-bit timestamp, so
two full ids read next to each other on the dashboard are indistinguishable at
a glance. `shortIssueRef` in `issue-id.ts` renders a short form instead —
`clw_` plus the last six characters of the body, uppercased — for **visible
text only**. A forge issue number passes through unchanged.

It is display-only: every `href`, `data-*` attribute, form value, element id
and search query keeps the full id, and hovering (or long-pressing) the short
text reveals the full id via `title`. Never use `shortIssueRef`'s output where
it is read back — search, routing or a lookup key.

### Types

`IssueRef = number | string` and `CommentRef = number | string` are declared in
`src/issue-id.ts` and re-exported from `src/config.ts` alongside the predicates.
A forge number stays a number; a native id is a string. `compareIssueRefs` sorts
forge numbers first, then native ids in creation order; `sameIssueRef` compares
canonical forms.

`ISSUE_REF_PATTERN` is the regex source for either shape and is correct with or
without the `i` flag, because callers splice it into patterns compiled both
ways. A numeric ref needs a trailing `(?!\d)` guard; a ULID ref needs the wider
`ISSUE_REF_BOUNDARY` (`(?![0-9A-Za-z])`), or `clw_<26>X` would match its first
26 characters and resolve to a different issue.

## Spelling

A native issue is written `#clw_…` in PR bodies and prose — `Closes
#clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC`. Neither forge linkifies it; that is an
accepted cost, because the same `Closes #<ref>` spelling is what
`extractClosedIssueRefs` and the whole phase-coverage machinery already read.

Branches are `claws/issue-clw_<ULID>-<suffix>`, the same shape as
`claws/issue-<N>-<suffix>`. Every parser of that prefix uses
`ISSUE_REF_PATTERN`.

## Routing

`src/github.ts` is the only façade. Every function that routes to a backend by
`(repo, issueNumber)` checks the native id **before** the `isForgejoRepo(repo)`
check:

```ts
if (isNativeIssue(issueNumber)) return clawsIssues.…;
if (isForgejoRepo(repo)) return forgejo.…;
// …the gh() path
```

`isNativeIssue` / `isNativeComment` are `github.ts`'s own one-line wrappers over
`isClawsIssueId(canonicalIssueRef(ref))`. Use them at every routing site rather
than the bare predicates: the bare form is anchored and does not trim, so a ref
carrying surrounding whitespace would resolve natively in whichever functions
canonicalised first and fall through to a 404-ing `gh` call in the rest.

The order matters. A native check placed after the Forgejo branch would send
native writes for a Forgejo-canonical repo to Forgejo. `src/github.test.ts`
exercises every routed function on both a GitHub and a Forgejo repo for that
reason.

Not every `(repo, ref)` function has a native branch. `getOpenPRForIssue` and
`listMergedPRsForIssue` are forge-first with no native route, deliberately: a
native issue's PRs still live on the forge, and the `claws/issue-<ref>-` branch
prefix identifies them there just as well. Those two canonicalise the ref
before building the prefix, because git branch names *are* case-sensitive.
`createIssue` has no ref to route on and is switched by config instead (below).

Comment-id functions (`editIssueComment`, `addReaction`, `getCommentReactions`)
route on `isNativeComment` instead, because they never see an issue id.

`listOpenIssues`, `listIssuesByLabel`, `listRecentlyClosedIssues` and
`listDuplicateIssuesOf` are the exceptions: they **union** both backends rather
than routing, because both kinds of issue coexist in one repo. The first two and
`listDuplicateIssuesOf` return the forge's own issues **followed by** the native
ones; `listRecentlyClosedIssues` instead merges the two halves by parsed
`closedAt` and then cuts to `limit`, because `doc-maintainer` stops early and
would otherwise never reach a native issue behind a full window of forge ones.
The native read sits outside the 60 s `apiCache` block — it is a local query,
and caching it would delay a label change the dashboard just made — runs
concurrently with the forge round trip, and degrades to `[]` on a database
error.

`listPRsCrossReferencingIssue` has no timeline to read for a native issue, so it
filters the repo's own open **and merged** PRs by a lower-cased body match
instead, under the same cache key and TTL as the forge branch. The merged half
is a rolling window of repo-wide merges, so treat it as best-effort enrichment
for hand-rolled branches: the durable records of what landed are the
issue-scoped branch-prefix list and the `claws-phase-done:` markers, both of
which `loadPhaseCoverage` unions in beside it.

### Imported forge refs keep resolving

An import changes an issue's ref, but plenty of durable records are keyed to
the *old* one. Rather than rewriting each kind, the `imported_issues`
table (see [database-schema.md](database-schema.md)) records
`(repo, forge_number) → native_id` and the old ref keeps resolving.

`src/imported-refs.ts` is the leaf module that owns it — it imports `db.ts` and
`issue-id.ts` only. Resolution is deliberately **not** part of
`canonicalIssueRef`: that is a sync pure function with no database, and forge
numbers collide across repositories, so every lookup here is `(repo, ref)`-scoped.
Lookups are synchronous against an in-process index loaded once by
`loadImportedRefs()`, called from `main.ts` immediately after `initDb()` (calling
it *inside* `initDb()` would make `db.ts` import `imported-refs.ts`, which imports
`db.ts`). Claws runs a single pod and the table is tiny, so one index is enough;
an index that has not been loaded resolves nothing, which is exactly the
pre-import behaviour, so a boot-order slip degrades rather than mis-resolves.

Two accessors, and the difference matters. `resolveImportedRef(repo, ref)`
answers with the single ref to *act on* — `upstream-watcher` uses it to label
and comment on the issue its manifest's `issue: <N>` became.
`issueRefAliases(repo, ref)` answers with both spellings, canonical first, for
the reads where a record could name either. Resolution is applied at named
sites, not blanket-wrapped around the façade:

| Function | What the alias buys |
|---|---|
| `isItemSkipped` / `isItemPrioritized` | An operator's `{repo, <forge number>}` entry still matches, so an import cannot silently un-skip an item. |
| `getItemTimeoutMs` (`timeout-handler.ts`) | A timeout override survives the import instead of reverting to the default. The *write* side keeps the caller's canonical ref. |
| `getOpenPRForIssue` | An in-flight PR on a `claws/issue-<forge number>-` branch stays visible, so the dispatcher does not start a second implementer. |
| `listMergedPRsForIssue` | The phases of a multi-phase issue that landed before the import are still found. |
| `listPRsCrossReferencingIssue` | A `Part of #<N>` body still cross-references the native id. The forge-number alias is matched as `#<N>` with a boundary guard on both sides, never as a bare substring, so `other/repo#7` is not read as this repo's `#7`. `loadPhaseCoverage` passes the same alias list into `computePhaseCoverage` as `issueRefs`, or its `referencesIssue` / `closesIssue` re-filter would discard under the canonical ref alone everything the fan-out just found. |
| `listDuplicateIssuesOf` | A `claws-duplicate-of:<N>` marker on an un-migrated issue still resolves. |

The fan-out costs a second call *only* for a ref with a known alias; an
un-imported ref yields a one-element alias list and exactly one call, which
`github.test.ts` asserts. The results are de-duplicated by PR or issue number,
preserving alias order.

### `createIssue` files natively

`createIssue` is the one routed write with no ref to route on — the issue does
not exist yet — but unlike every other routed write there is no forge to route
it to: it always files a native issue authored as `claws`, associated with
exactly the repo it was asked to file in, stores the labels directly (there is
no label registry to `ensureLabel` into) and returns the `clw_…` id. This is
unconditional for both GitHub and Forgejo repos, since the native store is
forge-agnostic. Its return type is `IssueRef`, and every caller that persists
the result already writes one of the six TEXT ref columns.

The dashboard does not go through the façade — it creates native issues through
`src/claws-issues.ts` directly, because it authors them as the operator rather
than as `claws`.

Carrying forge issues across is the separate
[issue-importer](jobs/issue-importer.md) job: on its own timer, walking every
repository each run, it moves
each open forge issue's title, labels, body (prefixed
`Imported from <forge url> (opened by @login)`), comments in order with their
own author logins, and Claws' own comment reactions into a native issue,
re-stamps the plan comment's markers against it, records the move in
`imported_issues`, then comments `Moved to <dashboard url>` on the forge issue
and closes it `not_planned`. A `Claws Ignore` issue is imported too, and its
native copy keeps the label. It skips anything mid-flight — an issue an open PR closes, or one with a `queued`/`running`
work-queue row — because the native issue it became would have no PR linked to
it and so would never close; a later run picks such an issue up once that work
has landed. The "native issue" is normally the forge issue's
existing **shadow**, promoted in place rather than created beside it.

#### History

The tracker was cut over under #3215/#3246 behind a host-wide `issueTracker`
config switch, so the flip — and a rollback from it — needed no restart. The
switch was removed in #3294 once every new issue was filed natively and the
importer had drained the fleet; rolling back now would split the tracker
rather than restore anything, because `imported_issues`, shadows and
native-only ids all live on `main`.

An issue a human files on a forge has a shadow underneath it until the
importer's next run moves it into the native tracker — within about half an
hour, unless it is mid-flight or its repository is switched off for
`issue-importer`, in which case it keeps being worked on that forge. Nothing
about the shadow is visible to the operator: `/issues`, `/board` and the
dispatchers all read past it.

## Shadows

Every issue Claws works has a row in `claws_issues`, whichever forge it was
filed on — so a column or a table added to the native schema applies to all of
them and not only to the natively filed ones. The row standing for an issue
that is still live on a forge is a **shadow** (#3246).

[`issue-shadow-sync`](jobs/issue-shadow-sync.md) is the job that mints shadows
and keeps them in step with the forge; it runs every five minutes, per
repository.

A shadow is a `claws_issues` row with `kind = 'shadow'`, not a table of its
own; that is the whole point, since anything added to `claws_issues` then
covers it for free. It is linked to its forge issue by the same
`imported_issues` row an import uses, so there is one linkage row per forge
issue and only `kind` says whether that issue was imported (`issue`) or is
still live on the forge (`shadow`).

A shadow is **not** a second operator-facing issue. Its title, body, labels and
open/closed state are kept in step with the forge issue; it carries no comments
and no reactions, and nothing about it is ever written back to the forge — no
label, no comment, no close. That is also why a mirror of a forge issue never
has to mark the forge original `Claws Ignore`: the shadow is hidden anyway, so
there is nothing on the forge to keep the automation away from. (The
`Claws Ignore` the [issue-importer](jobs/issue-importer.md) writes is a
different thing: it goes on the *native* issue, and only until the import has
finished assembling it — unless the forge issue carried `Claws Ignore` itself,
in which case it stays.)

Where it is hidden, exactly:

- `listOpenClawsIssues` and `listClosedClawsIssuesSince` carry a
  `kind <> 'shadow'` clause. Those two are what the façade unions, so one
  clause apiece keeps shadows out of the dispatchers, `findIssueByExactTitle`,
  alert-issue dedup, the board and the `/issues` list at once.
  `getClawsIssue(id)` still returns a shadow, so `/issues/:id` can redirect to
  the forge issue it stands for.
- `listImportedIssues` joins `claws_issues` and drops shadows, so the alias
  index in `imported-refs.ts` never aliases a live forge ref to its shadow.
  Leave them in and every forge ref on the fleet would resolve to a hidden
  native id, doubling `listMergedPRsForIssue` and `listDuplicateIssuesOf`'s API
  calls and pointing the watcher's writes at a row nothing reads.
- `auto-merger` ignores a `Closes #clw_…` that names a shadow: closing it would
  hide the row without touching the issue the PR actually closes.

Shadow writes — `createShadowIssue`, `updateShadowIssue`,
`markShadowsChecked`, `promoteShadowIssue` — go through `src/db.ts` directly
and never through `src/claws-issues.ts`, so no dashboard event is emitted for a
row no page lists. Every one of them is guarded `WHERE kind = 'shadow'`, which
is what makes them commute with the importer: whichever runs second changes no
rows rather than writing the forge's text back over an imported issue.

Two of those answers carry more than a boolean, because the linkage key
`(repo, forge_number)` is shared by imports and shadows and only `kind` tells
them apart:

- `createShadowIssue` answers `{id, created}`, or **nothing at all** when the
  linkage row already there names an *imported* issue. That is not a race — it
  is the permanent state of every issue the repo has ever imported, and a human
  reopening one puts it back in the forge's open listing. Handing that id back
  as a shadow would have the sync job write to a row every `updateShadowIssue`
  refuses, re-attempting the same pair every cycle with nothing logged.
  `issue-shadow-sync` is not its only caller: [`issue-importer`](jobs/issue-importer.md)
  calls it too, for a forge issue with no shadow yet — that call *is* the
  importer's atomic create, and it is the linkage row's primary key, not the
  order the two jobs happen to run in, that keeps them from ever producing a
  native issue nothing links to (#3262).
- `updateShadowIssue` answers `changed`, `unchanged` or `not-a-shadow`. The
  last two are separate because the caller must do the opposite thing with
  each: an unchanged shadow stays in the sync job's working set, while a
  promoted one has to leave it at once — the promotion drops it from
  `listShadowIssues` only on the *next* listing.

The converse guard is structural rather than per call site: `requireClawsIssue`
throws on a shadow, and the three by-id writes that do not go through it —
`updateClawsIssueTitle`, `updateClawsIssueBody`, `setClawsIssueState` — carry
`kind <> 'shadow'` on their own UPDATE and report the refusal as `false`. So
nothing outside the shadow helpers can write a shadow, including the
`/issues/:id/*` routes, and a new caller does not have to remember to check.

Every open forge issue gets a shadow — `Claws Ignore` issues and external
alert-bridge issues included; the shadow carries whatever labels the forge has,
split the same way as a native issue's: a forge `Ready`, `Refined`, `Blocked` or
`Backlog` is written to the shadow's `lifecycle` field rather than as a label row, and
`updateShadowIssue` compares the forge labels against the field plus the
remaining rows, so an unchanged forge issue is still `unchanged`.
Closed issues that never had one are not backfilled.

A shadow that is open here but absent from the forge's open listing has its
state confirmed with a direct `gh.getIssueState` read, at most 25 such reads
per repository per run — the rest wait for a later run. `listShadowIssues`
hands them over least-recently-*checked* first so a capped run works through
the whole set rather than re-reading the same few forever, and the marker it
orders on is `claws_issues.shadow_checked_at`, written by `markShadowsChecked`
for every shadow a run examines. `updated_at` cannot serve: a check that finds
nothing changed deliberately writes no issue column at all, so a shadow whose
check never changes anything — the forge read errors, say — would sit at the
head of the queue on every run and starve everything behind it.

**Import promotes a shadow in place** — a different sense of "promote" from
[requirements Promotion](#requirements): this one turns an *imported* shadow
into a real native issue (`kind` flips from `shadow` to `issue`), and has
nothing to do with a version being approved or the issue's lifecycle column.
`issue-importer` sets the forge title,
the imported body, the forge's labels plus `Claws Ignore` and the `kind` flip
to `issue` in a single transaction, so no reader ever sees a half-promoted row:
the issue becomes visible to the dispatchers already ignored, exactly as a
freshly created import is. It is the atomicity that guarantees that and not the
order of the statements. The `clw_` id is kept, so the linkage row, any
work-queue rows and any `Closes #clw_…` already naming it carry over instead of
being stranded on an abandoned shadow.

Promotion writes every column `createClawsIssue` would have: the title, the
author as `claws`, and an open state with `state_reason` and `closed_at`
cleared. A promoted issue has to be indistinguishable from a created one, or
the same forge issue imports differently depending on whether a shadow happened
to exist — with a plan re-stamped against a stale title, a promoted issue that
is closed and invisible because the sync closed the shadow, or the dispatchers'
allowed-actor check seeing the forge author.

## Repositories and the primary repository

Repo association is a separate table (`claws_issue_repos`), not a label, and is
shown as repo chips on the issue page. An issue may name any number of repos.

- **One or more repos** — the issue's *primary* repo is the alphabetically
  first of them (`primaryRepo` in `claws-issues.ts`; the SQL readers compare by
  code point in both dialects so they agree with it). The issue appears in
  `listOpenIssues(primary)` and in no other repo's list, so exactly one
  repo's dispatchers act on it: the primary repo owns planning, the issue's
  labels and comments, and phase sequencing. With one repo that is simply the
  issue's repo.
- **Several repos** — the issue gets one plan, and that plan can need PRs in
  any of them. The planner runs in the primary repo's worktree (reading the
  others over the API) and saves the PR list through `claws_save_plan`; every
  `prs[].repo` must be one of the issue's repos that Claws manages. The list is stored in
  `claws_issue_prs` with a repo per entry, and the implementer, still
  enqueued under the primary repo, does each entry's worktree, push and PR in
  that entry's repo — an entry in a repo Claws does not manage gets one
  Implementer comment per step, `Refined` is stripped, and the worker does
  not re-apply it to continue into that step. Each PR starts once every PR
  it depends on has merged — by default the previous one, unless the plan
  declares it `(parallel)` or `(after PR N)` — so independent PRs in
  different repos can be open at once. No companion issues are filed.
  The issue page notes the primary repo under the repo chips. Feedback on
  the issue while any of its PRs is open, in any of its repos, gets a
  follow-up that names the PR it applies to rather than a re-plan.
- **Zero repos** — the issue is *unassigned*: it can be filed, labelled and
  discussed, but it is invisible to automation and is never planned. It is
  visible only on `/issues` (its own "Unassigned" section), in the board's
  Ideas column and on the issue page, whose banner says to assign a repository to
  start automation.

Changing an issue's repos can change which repo is primary; the new primary
repo's dispatchers take it over on their next tick, because the PR list is
stored per issue rather than per repo.

The issue page's Labels and Repositories checkbox forms save as they change
(`src/client/issue-edit.ts`, debounced, one request in flight per form): they
post the same form body to `POST /issues/:id/labels` and `/repos` with
`Accept: application/json`, which those routes answer with `{"ok":true}`
instead of the 303 redirect. The header chips, the banner above — always
rendered, `hidden` once any repository is set — and the multi-repo note naming
the primary repository (likewise always rendered) are updated in place;
a failed save puts the checkboxes back and says so. The Save buttons remain for
the no-JS path. Title/body edits, comments and state changes keep their
explicit buttons. The one exception is the header title: a pencil `.icon-btn`
beside it (`#issue-title-edit`) swaps the `<h2>` text for a full-width input
in place, posting `title` alone to the same `POST /issues/:id/edit` route with
`Accept: application/json` — a request with no `body` field leaves the stored
body untouched, so the inline editor can never blank it. The collapsed Edit
section below still posts both fields for the no-JS path. A copy `.icon-btn`
next to it (`#issue-copy-url`) copies the issue's permalink URL to the
clipboard. Both report through a status span beside them
(#clw_01M3946M9S8ZT0HB2DPQD91PYC). Both repository checkbox lists, here and on `/issues/new`,
are sorted alphabetically, wrap several outlined chips per line, and drop the
`owner/` prefix from the visible text when every option shares one owner (the
full name stays in the checkbox value and a hover title). The New Issue form
also offers a second "Create issue" button right after Repositories, since
title and repo are usually all it takes.

A "transfer" of a native issue replaces the repo association. The issue keeps
its id and its URL, so `transferIssue` returns the dashboard URL.

Automation closes a native issue only after verifying it is open **and**
that the acting repo is among its repos — see [Auto-close](#auto-close).

## URLs

`issueUrl(repo, ref)` in `src/config.ts` returns `${DASHBOARD_URL}/issues/<id>`
for a native id (a site-relative `/issues/<id>` when `dashboardUrl` is unset), so
every existing page, Slack message and WhatsApp reply links to the tracker
without knowing it exists. It also resolves `ref` through the imported-refs
index first, so a forge number that has since been imported lands on the
Claws page too — once an issue is imported, every dashboard link to it under
either spelling opens the tracker, not the closed forge copy.
`forgeIssueUrl(repo, ref)` returns the forge URL unresolved, for the two
deliberate exceptions: the importer's `Imported from …` body line and the
shadow redirect, both of which must point at the forge on purpose.

## Authorship, comments and reactions

Claws' login on a native issue is the constant `claws`
(`clawsIssues.CLAWS_NATIVE_LOGIN`). Native comment and reaction writes never
call a forge, so there is no app installation to ask for a bot login — and
asking one would turn every native comment into a GitHub API call.

Comparisons therefore go through `gh.getSelfLoginForIssue(repo, ref)`, which
returns `claws` for a native issue and the repo's forge bot login otherwise.
Prefer it over `getSelfLoginForRepo` anywhere the answer is compared against a
comment author or a reaction login.

`gh.isAllowedActor(login, repo?, ref?)` trusts that constant **only when `ref`
names a native issue**. The bypass has to be scoped to the item, not to the
login: `isAllowedActor` is mostly asked about forge-sourced logins, and
`github.com/claws` is a real account this org does not control (as is any
self-registered `claws` on the Forgejo instance). Pass the ref wherever the
login came off a specific issue or PR — every call site has one in hand.

An issue created from the dashboard is authored as the first `allowedActors`
entry; one Claws files itself is authored as `claws`.

Native comments carry the same visible `*— Automated by Claws —*` marker as
forge ones, because `commentOnIssue` builds the body before handing it to the
store. That marker is load-bearing: `issue-refiner` uses it to tell its own
plans from the human feedback it must address, and marks feedback addressed with
a reaction, which is why comment reactions are stored per
`(comment_id, login, content)`.

The dashboard's comment form is the one mutation that does **not** go through
the façade. It posts as the operator with no marker — a human comment that
looked like a Claws comment would be skipped as feedback. A blank comment is
dropped without an insert or an event. If the issue is Awaiting plan review and
the comment is real feedback (not just a `claws-phase-done:` claim), the same
request also moves the lifecycle back to `planning` and enqueues a refinement run, so
the board does not keep showing the plan as awaiting review while feedback on
it is outstanding. `src/server.ts`'s `returnToPlannerOnFeedback` is that reset,
shared with the Attachments-section upload route below so an upload has the
same immediate effect.

An Attachments-section upload (`?feedback=1`) shares this path: the route
posts a synthesised "Attached …" comment the same way — as the operator, with
no marker — through `postAttachmentFeedbackComment`, so it counts as plan
feedback exactly like a typed comment. See
[Attachments](#attachments), "Uploads as feedback", for what triggers it.

## Duplicate detection

`listDuplicateIssuesOf` matches only the structured `claws-duplicate-of:<ref>`
marker, in the body or a comment, case-insensitively and with a ref boundary. A
bare `#<ref>` mention never counts: the result feeds `Closes #<ref>` lines in
the implementer's PR body, which the merger then acts on, so a `Duplicate` issue
that merely *discusses* the canonical one would otherwise be closed
automatically.

## Rendering

Issue bodies and comments are rendered server-side by `src/markdown.ts`
(`marked`, GFM). There is no DOM in this process, so DOMPurify is not an
option; the renderer is locked down at the source instead:

- raw HTML tokens, block and inline, are HTML-escaped rather than emitted;
- a link or image whose scheme is not `http:`, `https:` or `mailto:` is dropped,
  keeping only its text or alt text. A target with no scheme is relative and is
  kept.

`getIssueBodyHtml` returns the rendered body, so `src/images.ts` finds native
issues' `<img>` tags exactly as it does GitHub's `body_html`, and pasted
external image URLs still work. Files uploaded to the issue itself are linked by
site-relative URLs, which the body regexes skip; agents reach them through the
listing instead — see [Attachments](#attachments).

## Plans

A native issue is shown as three parts: the **request** (its body), the
**current plan** and the **comments**. The plan is still an ordinary Claws
comment carrying `## Implementation Plan` — `findPlanComment`, the refiner,
the auditor, the importer and phase coverage all keep reading it — but every
version of it is also kept in `claws_issue_plans`
([schema](database-schema.md#claws_issue_plans-table)):

- **When a version is recorded.** `db.ts` records one inside the same
  transaction as any comment add or edit whose body is a Claws plan comment
  (`isPlanComment`: the header *and* the Claws marker, so neither a human
  comment quoting the header nor the refiner's header-less feedback replies
  count). The planner's new comment, the refiner's in-place edit and the
  importer's comment copy all record versions with no call-site changes.
- **Normalisation and dedupe.** A version is stored without the
  `*— Automated by Claws —*` header and the trailing `CLAWS_PLAN_*` marker
  block (`normalizePlanText`). A write whose normalised text equals the latest
  version records nothing, so a marker-only re-stamp is not a new version.
- **Backfill.** `initDb` seeds history once for issues with plan comments and
  no rows; only each existing comment's current text is recoverable.
- **Sections.** `plan-parser.ts`'s `parsePlanSections` splits a version on its
  `###` headings at render time — Requirement, Decisions, Implementation, …, or
  `PR N: title` per phase — with any text before the first heading as
  "Overview", so a verdict plan with no headings is one Overview section.
  Nothing about sections is stored, so the planner's heading set can change
  without a migration.

**The issue page** renders every part as a `<details>` block. Request, Current
plan (`#plan`), Comments, Attachments and Status start open; Previous plans,
Edit, Labels, Model plan, Repositories and State start closed. Inside Current
plan each section is its own block, with Requirement and Decisions open;
Previous plans lists the older versions newest first, every section closed. The
comment the latest version came from is left out of Comments — Claws' replies
and human comments stay there.

A plan for an issue with an approved [requirements](#requirements) version has
no Requirement section — the record is the requirement — and its first
Decisions item names the version it was planned against.

**Board cards and `/issues` rows** of open native issues carry a closed
"Plan · N sections" block holding only the Requirement section (else the first,
which is Decisions for a plan written against a requirements record)
and a "Full plan" link to `/issues/<id>#plan`, from one bulk read
(`listLatestClawsIssuePlansForOpenIssues`) that is best-effort like the
model-plan summary. Forge issues get no block: their plans live in forge
comments and a shadow carries none. Once imported they gain it.

## Requirements

Before an issue is planned, the [requirements writer](jobs/issue-dispatcher.md#requirements-writer)
writes its **requirements record**: a title, a kind (`bug` or `feature`), the
context, the requirement, acceptance criteria and what is out of scope — what the
issue asks for, never how to build it ([design](refinements/issue-flow.md)).
Every version is kept in `claws_issue_requirements`
([schema](database-schema.md#claws_issue_requirements-table)):

- **Written by the writer, not by the comment.** The record is also posted as a
  `## Requirements` Claws comment, but unlike a plan the version is not a side
  effect of that comment: the writer stores it with
  `addClawsIssueRequirementsVersion` after posting (version 1) or after editing
  the comment in place on a refine run (the next version, same comment id).
- **Keyed by tracker id.** A forge issue's versions hang off its
  [shadow](#shadows) and name the forge comment, so `comment_id` is plain text
  with no foreign key.
- **Approval.** `claws_issues.approved_requirements_version`,
  `requirements_approved_by` and `requirements_approved_at` record which version
  was approved, by whom and when. Promotion sets them.

**Promotion** (not to be confused with [restoring an issue from the
backlog](#backlog) or [importing a shadow](#shadows)) moves an issue into
**Planning** and approves its latest version (`clawsIssues.promoteIssue`). It
is decided on approval state rather than on the column the issue came from:
any move into Planning of an issue with no recorded approval is a promotion,
whether that move starts in Ideas or reaches Planning by way of Blocked or
Approved — except an *entry* move (the backlog's **Promote**, or a
[dependency release](#links)), which lands where `entryLifecycle` says (a
dependency release with a real plan goes to Awaiting plan review instead)
without recording an approver, since the issue already has a plan or approved
requirements and needs no second promotion; the rest are a plain lifecycle
write. The write
itself is a compare-and-swap on the lifecycle the caller just read
(`promoteClawsIssue`'s `expectedLifecycle`), not a fixed allow-list, so it can
promote out of Blocked, Approved or Awaiting plan review, not only Ideas,
while still losing cleanly to a concurrent move to some other column. A human
promotes with the Requirements block's **Promote** button
(`POST /issues/:id/promote`), the Status section's **Promote to Planning**, or
by dropping the card into Planning on the board; each records the signed-in
operator's OIDC subject — or `dashboard` when the dashboard runs without OIDC
or the session does not verify (`sessionSubject`'s other two fallbacks). A
human may promote before any record exists: the version stays NULL and the
planner plans from the body. When the approved version's title differs from
the issue's, the issue takes it and the Request block shows "Filed as …" with
the original (`filed_title`). Moving an issue back into Ideas is the
**demotion** (`demoteIssue`): the approval is cleared, the versions stay, the
per-issue `auto_promote` override is set to "wait" so the dispatcher's
level-triggered check does not immediately re-promote it, and a planner run
still *queued* for it is skipped — one already running finishes, and a plan it
posts moves the issue on as usual.

**Auto-promotion** happens with `requirements_approved_by = 'claws'` if the
issue is still in Ideas, has no recorded approval yet, and `shouldAutoPromote`
says so. Two triggers reach the same decision: the listener fires when the
*first* version is stored (`db.addClawsIssueRequirementsVersion` calls the
listener `main.ts` registers), so an agent pod's writer triggers it through the
ops API like an in-process one; the [issue dispatcher](jobs/issue-dispatcher.md#promotion-gate)'s
level-triggered check (`clawsIssues.autoPromoteIfDue`) additionally runs on
every tick for an issue it finds in Ideas, for the versions the listener never
got to fire for — one written before the listener existed, or while
`requirements-writer` was disabled — and, with the writer disabled outright and
no version ever coming, promotes straight from the body. The decision, first
match wins:

1. the per-issue `auto_promote` (the New issue form's **Requirements** choice,
   or `claws_create_issue`'s `autoPromote`);
2. the primary repo's `claws.json` `autoPromote` — `attended` or `unattended`,
   by the issue's `source` ([repo-config.md](repo-config.md));
3. the source's default: `dashboard`, `session` and `whatsapp` issues are
   *attended* and wait for a human; `agent` (a headless `claws_create_issue`),
   `automation` (`gh.createIssue`) and `forge` (every shadow) are *unattended*
   and promote themselves.

A forge issue's stage lives on its shadow, which the forge has no label for:
the [shadow sync](#shadows) keeps a shadow that has left Ideas in Planning when
its forge labels carry no state, so a promoted forge issue is not demoted and
re-promoted every tick.

**The issue page** shows the latest version as a Requirements block between
Request and Current plan (`#requirements`) — title, kind, its four parts, and
the version and age. The block also shows where the issue came from ("Filed
from `source` · auto-promotes / waits for you"), shows "Approved vN by X" /
"Approved without a record by X" / "Not yet approved", and carries a
**Promote** button while the issue is open, assigned and in Ideas. Older
versions sit in a closed Previous requirements block. The latest version's
comment is left out of Comments, as the plan comment is. The block is omitted
until the writer has run. The planner plans only once the issue has left
Ideas (see the [promotion gate](jobs/issue-dispatcher.md#promotion-gate)), and
plans against the *approved* version, with the body as background; the plan's
hash covers that version, so re-approving an edited record re-plans. The
implementer and the PR reviewer receive its acceptance criteria. An issue with
no approved version is planned from its body as before.

The approved version can lag the latest: a refine run after promotion stores a
new version without approving it, and the planner keeps using the approved
one. To re-approve, demote the issue to Ideas and promote it again, which
approves the latest version.

## Attachments

A native issue carries its own files (#3289): images, archives, arbitrary
binaries. `src/issue-attachments.ts` is the store.

- **Storage.** Files live under `~/.claws/issue-attachments/<issueId>/` as
  `<random6>-<sanitised name>` (directory 0700, files 0600), written by the same
  `session-uploads-core.ts` helpers the session upload routes use. Each has a
  `claws_issue_attachments` row: `cla_` ULID id, owning issue, the comment that
  links it (stamped by `commentOnIssue` when a comment body contains
  `/attachments/<id>/`), sanitised filename, `stored_path` relative to
  `WORK_DIR`, content type, size and uploader.
- **URLs.** `GET /issues/<id>/attachments/<attachmentId>/<filename>`, behind the
  dashboard login. The filename is cosmetic; the route 404s unless the row
  belongs to `<id>` and the issue is not a shadow. Bodies store the
  site-relative URL, never `DASHBOARD_URL`, so they survive a host move.
- **Headers.** Content types are never sniffed. The stored type is served only
  when it is PNG, JPEG, GIF, WebP, PDF, zip, gzip, plain text, audio or video;
  anything else — SVG and HTML included — goes out as
  `application/octet-stream`. Every response carries
  `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`; images and PDF are
  `inline`, everything else `attachment`.
- **Uploads.** `POST /issues/<id>/attachments` (multipart `file`, 10 MB per
  request) and `POST /issues/<id>/attachments/stream?name=` (raw body, 1 GB).
  Over-cap uploads get a 413 with a JSON `error`. The issue page has an
  Attachments section with download and delete links; picking a file or
  dropping one anywhere on the section uploads it immediately and reloads the
  list, with the "Attach files" submit button hidden and kept only as the
  no-JS fallback. On the body and comment textareas, pasting, dropping or
  picking a file uploads it and inserts `![name](url)` (images) or
  `[name](url)` at the cursor. Delete is
  `POST /issues/<id>/attachments/<attachmentId>/delete`.
- **Uploads as feedback (#clw_01M39J5AT1SKCFV6CHMWPVHD6M).** The Attachments
  section's form (with or without JS) posts uploads with `?feedback=1`. On a
  live issue that flag makes the route synthesise a comment on the uploader's
  behalf — one `Attached [name](url)` (or `Attached ![name](url)` for an
  image) line per stored file — through `commentOnIssue`, exactly as if the
  operator had typed it: see
  [Authorship, comments and reactions](#authorship-comments-and-reactions).
  Uploads through the body/comment textarea helper carry no flag and post no
  comment of their own — the link they insert becomes feedback only when the
  comment or body edit it was inserted into is saved. A pending upload
  (`issue_id` NULL) never posts a comment, since the issue does not exist yet
  and the planner sees the files once it does. Deleting an attachment posts
  nothing.
- **Pending uploads.** On the New Issue form the issue does not exist yet, so
  `<id>` is the literal `new`: the row has a NULL `issue_id`, the file sits in
  `issue-attachments/pending/`, and the form carries an `attachment` hidden
  field per upload. `POST /issues` claims those rows, moves the files into the
  new issue's directory and rewrites `/issues/new/attachments/<attId>/` in the
  body. Pending rows older than 24 hours are swept, row and file, at the start
  of every pending upload.
- **Agents.** `gh.getIssueAttachments` returns the issue's files as
  `{ name, url }`, and `processTextForImages` reads every one of them: images
  into `.claws-images/`, everything else into `.claws-attachments/`, with size
  caps, previews and prompt guard. This is the *only* source of attachment
  context the agent pipeline has — it never downloads from GitHub, Forgejo or
  anywhere else at run time; a link to a file hosted elsewhere is named in the
  prompt as not downloaded, never fetched. `fetchWithGuard` reads such a URL
  from Claws' own store — skipping the SSRF guard — only when its issue id, and
  the row's, equal the native issue being processed, so a body linking another
  issue's file cannot read it. In an agent pod, whose HOME has no store, it
  reads the bytes through `GET /agent-pods/:rowId/attachments/:attachmentId`
  on the service with the pod's per-run token, still keyed on the issue being
  processed.
- **Sessions.** The `claws_get_issue_attachments` and
  `claws_get_issue_attachment` MCP tools list an issue's files and fetch one —
  an MCP `image` block for PNG/JPEG/GIF/WebP up to about 3.75 MB (the model API's
  5 MB limit applies to the base64 encoding), a guarded text preview, or metadata only — since a session pod reaches Claws only through the MCP server.
  The rest of an issue — title, body, state, labels, comments and current plan —
  comes from `claws_get_issue`, the same way; `claws_list_issues` lists open
  native issues (optionally for one repo) so a session can check for an
  existing issue before filing a duplicate.
- **Imports.** `issue-importer` copies the files a forge issue links into this
  store and rewrites the links, so an imported issue keeps them after the forge
  copy is closed ([issue-importer.md](jobs/issue-importer.md#what-is-carried-across)).
- **Deletion.** The rows cascade with the issue (`ON DELETE CASCADE`); the
  files do not. There is no issue-delete route yet — the one that is added must
  call `deleteIssueAttachmentFiles(issueId)` alongside the row delete.

## Links

An issue can carry typed links to any number of other tracker issues
(`src/issue-links.ts`, table `claws_issue_links`). A link is one row, read from
both ends: "A depends on B" and "B blocks A" are the same fact.

- **Kinds.** Two are stored. `depends_on` means the source cannot be
  implemented until the target closes; `blocks` is accepted as input and
  stored as `depends_on` with the ends swapped. `relates_to` is undirected and
  stored with the lexicographically smaller id as `source_id`, so the unique
  key `(source_id, target_id, kind)` dedups both spellings. Duplicate-of is not
  a link kind: the `claws-duplicate-of:` marker already drives
  [duplicate handling](#duplicate-detection).
- **Endpoints.** Both ends are native ids. A reference resolves the way an
  imported ref does: a `clw_…` id in any case (or a dashboard URL ending in
  one), `owner/repo#N` or a forge issue URL, or `#N` against the acting
  issue's primary repo, each through `imported_issues` — so an imported forge
  issue resolves to its native id and a live one to its [shadow](#shadows). A
  forge issue Claws has never seen, a PR, an unknown id and a self-link are
  refused. The issue a link is added *from* must be a native issue, not a
  shadow; the other end may be either, which is how a native issue depends on
  a forge one.
- **Parking.** Adding a `depends_on` link whose target is open parks the
  dependent — moves it to `Blocked` and comments which issue it waits on — when
  it is an open native issue in Ideas, Planning, Awaiting plan review or Approved with no open
  `claws_prs` row. A Backlog issue is already parked, and one with an open PR is
  linked but left where it is. A dependency on an issue that is already closed
  is stored released (below), since there is nothing to wait for.
- **The implementer gate.** `issue-dispatcher` never hands an issue with an
  open `depends_on` target to the implementer (Phases 1 and 3,
  [issue-dispatcher.md](jobs/issue-dispatcher.md)). The gate covers forge issues
  through their shadows, and counts a released link whose target has reopened.
  Planning is not gated.
- **Unparking.** Each dispatcher cycle opens with a sweep over the repo's
  Blocked native issues whose unreleased `depends_on` links all point at closed
  issues — closed directly, or by the [auto-close](#auto-close) of a merged
  PR. Each is moved out of Blocked with a comment listing the dependencies
  that cleared: to Awaiting plan review when it has a real plan; to Planning
  with a re-plan enqueued when its last plan is the planner's blocked verdict
  (which counts as a plan, so the dispatcher would not re-plan it by itself);
  with no plan, to Planning for the next cycle to plan when its requirements
  were approved and to Ideas otherwise (`clawsIssues.entryLifecycle`). The links are then
  stamped `released_at`, the same idea as `upstream_watch_fires`: a human who
  later re-parks the issue for another reason is not unparked every cycle.
  Only native issues are unparked; a forge issue is gated but not moved.
  Reopening a dependency does not re-park its dependents, but the gate holds
  them back again while it is open.
- **Surfaces.** The issue page's Links section groups links by relationship
  from that issue's side, each with the other issue's title, state and column,
  a Remove button and an add form (`POST /issues/:id/links`,
  `POST /issues/:id/links/:linkId/delete`). The New Issue form takes
  comma-separated `depends_on`, `blocks` and `relates_to` refs, resolved before
  the issue is written so a bad ref fails the whole create. Agents and sessions
  use the `claws_issue_links`, `claws_link_issues` and `claws_unlink_issues`
  MCP tools, over `GET`/`POST /api/issues/:id/links` and
  `DELETE /api/issues/:id/links/:linkId`; links made there are authored by
  `claws`, links made on the dashboard by the operator.
- **The planner.** The planner's prompt lists the issue's links under
  "Linked issues" with each other issue's state and column, and a native
  issue's planner is told to record a dependency it discovers with
  `claws_link_issues` before reporting `blocked`, rather than leaving it in the
  verdict's prose.
- **Imports** carry no links: "depends on #123" in an imported body is not
  parsed.

## Auto-close

GitHub closes its own issues when a PR body says `Closes #N`. A native id means
nothing to either forge, so Claws does it:

- `src/agents/auto-merger.ts` re-reads the merged PR's body with `getPRBody`
  (the sweep's copy is 60 s-cached), runs `extractClosedIssueRefs`, and closes
  each native ref as `completed` — but only when the issue is open and
  `thisRepo` is among its repos. A multi-PR plan's PR carries `Closes` only
  when every other step had already merged when it was opened, so a
  multi-repo issue closes when that PR merges, whichever of its repos it is
  in. Anything else is logged and skipped.
- Steps of a parallel plan can merge in any order, so the merge that
  completes a plan may be a `Part of` PR. `finalizeMergedClawsPR` loads the
  issue's phase state from its primary repo after every `claws/issue-<id>-`
  merge, and when every step is merged or claimed and the issue is still open
  it posts one Implementer comment and closes it as `completed`. A failed
  read only logs; the auditor below is the backstop.
- `src/jobs/issue-auditor.ts` covers PRs merged by hand: `classifyIssue` returns
  `done-native` for a native issue with no open PR whose merged
  `claws/issue-<id>-` PR satisfies `closesIssue`, and `processRepo` closes it.
  It never fires from `ready`, `needs-refinement` or `stuck-multi-phase`.
- `src/jobs/pr-dispatcher.ts`'s `refreshPrStore` gets there first: when a
  `claws_prs` row linked to an issue moves to `merged`, it runs
  `finalizeMergedClawsPR(…, "hand-merge")`, so a hand-merged PR closes its native
  issue on the next dispatcher tick rather than the next daily audit.

## Board

`/board` (`src/pages/board.ts`, `src/client/issue-board.ts`, `GET /board` and
`POST /board/move` in `src/server.ts`) is a kanban view over every managed
repository's open issues — forge and native alike — plus unassigned native ones
and native issues closed in the last 14 days (`DONE_WINDOW_DAYS`), at most
`DONE_COLUMN_LIMIT` (50) of them. That cap is applied twice: per repository in
SQL, which is how the query is shaped, and then again over the merged
newest-first list, so the column is bounded globally like the window is rather
than at 50 × the number of repositories. The `?repo=` filter is applied to the
merged list *before* that second cut, unlike every other column's, which
`buildBoardPage` filters: cutting first would leave a filtered board with
however few of that repository's cards survived a top 50 spread over every
other one — possibly none, with nothing on the page to say so. Unlike the open
read's cap, that cut adds nothing to the incomplete-source count below: the
column is "the 50 most recent issues closed in the window", which is what the
page's footnote says it is, so a 51st closed issue is outside what the column
claims rather than missing from it. The Done column is fetched per repo — a
closed multi-repo issue under its primary repo — so a *closed* native issue
with no repo is on no board at all: `columnFor` would place it in Done, but
nothing queries for it.

Every other column is bounded too, by the open read rather than by the board:
`listOpenIssues` is a single `gh issue list --limit 100` page, so a GitHub
repository with more than 100 open issues loses the rest from every column but
Done. (The Forgejo read pages to the end
and the native store has no cap, so only the GitHub half truncates —
`gh.openIssuesMayBeTruncated` is where that asymmetry is written down.)

The fetches are best-effort: a failure drops only the cards that fetch would
have produced rather than failing the page — the open and the closed fetch for
one repository catch independently, so a failed Done fetch still renders that
repository's open cards. A short board would otherwise read as an empty backlog,
so the number of distinct *sources* that came back incomplete — each repository
at most once, whether a fetch failed or its open read hit the cap, plus the
unassigned list — is rendered as "*N* of the board's sources loaded incompletely
— some cards are missing". A truncated repository counts because a missing card
is the same silence to a reader as a failed fetch. It has its own
`#board-warning` element, deliberately separate from `#board-status`: the client
blanks `#board-status` at the start of every move, so a warning rendered there
would disappear on the first drag and the incomplete board would go back to
reading as a complete one. Under `?repo=` the count is that repository's alone:
every other source contributes no card to the board in front of the operator
either way, so counting them would warn about cards that were never going to be
shown and bury the one source that matters inside a larger number.

**A native issue's lifecycle state is stored in one field; the column is
derived from it.** `claws_issues.lifecycle` holds `ideas`, `planning`,
`awaiting-plan-review`, `approved`, `blocked` — the board's own column ids — or `backlog`, which is a
destination but not a column (see [Backlog](#backlog)), and is the only storage
for a native issue's state: `Ready`, `Refined`, `Blocked` and `Backlog` are no
longer written as label rows (`src/issue-lifecycle.ts`). So that the pipeline's ~70
"is this issue `Refined`?" call sites keep working unchanged, `db.ts` presents
the field as the label it replaced on every read, turns an `addLabel` of a state
label into a field write, and turns a `removeLabel` of one into a reset —
only when the field holds that state: removing `Ready` goes to `planning`, and
any other state label to `planning` when the issue has a plan or approved
requirements and to `ideas` otherwise. The field is single-valued, so adding
`Blocked` to a `Refined` issue *replaces* `Refined`. Ideas and Planning carry no
label at all, so `lifecycle` is the one stored input `columnFor` reads beyond
labels and flight. A forge issue keeps its state in its forge labels, which is
what the pipeline reads live; importing it carries that state into the field.
No label marks an open PR: the `In Review` label was retired
(#clw_01M39G3H99HV6ED4378ZXHER6K), and a boot-time migration deletes any native
row still holding it. Implementing, PR open, Awaiting merge and Done are
never stored — they come from the issue's **flight** and `state = 'closed'`.

The flight (`src/issue-flight.ts`) is what the design calls the derived states
(`docs/refinements/issue-flow.md`, "The board"): whether an `issue-worker` task
is running for the issue (a `tasks` row, `status = 'running'`, keyed by the
issue's repo and ref) and the issue's open `claws_prs` rows (any stage but
`merged`/`closed`, keyed by tracker id — a forge issue resolves through
`resolveTrackerId`, and one with no tracker id has no rows). `GET /board` reads
it for every open card in two queries plus one tracker-id lookup per forge card
(`loadBoardFlights`); every route that moves one issue reads it for that issue
(`loadIssueFlight`). Both are best-effort: a failed read is logged and treated
as "not in flight", so a database hiccup costs the derived columns, not the
page. The rows are as fresh as the last PR dispatcher tick, so a PR merged
seconds ago still shows in Awaiting merge until the next one; the page's note
says so.

`src/issue-board.ts`'s `columnFor` reads the issue's labels (for a native issue,
the ones synthesised from the field) and its flight on every render, so a state
an agent sets moves the card with no extra bookkeeping and the board cannot
drift from the pipeline. The nine columns sit in three groups, with Blocked
alone between Building and Landing:

| Group | Column | Kind | Holds |
| --- | --- | --- | --- |
| Shaping | Ideas | gate | No lifecycle label and `lifecycle` not `planning` — a new issue, whose requirements the writer drafts and a human (or auto-promotion) promotes — and every *unassigned* native issue, whatever its labels, since automation cannot act on it yet |
| Shaping | Planning | gate | No lifecycle label and `lifecycle = 'planning'` — promoted, the planner's turn; a drop here is the [promotion](#requirements) when nothing is approved yet |
| Shaping | Awaiting plan review | gate | `Ready` |
| Building | Approved | gate | `Refined` |
| Building | Implementing | derived | A running `issue-worker` task |
| Building | PR open | derived | Open `claws_prs` rows, not all at `awaiting-merge` |
| — | Blocked | | `Blocked` |
| Landing | Awaiting merge | derived | Open `claws_prs` rows, every one at `awaiting-merge` |
| Landing | Done | gate | Closed |
| *(no column)* | | | `Backlog` — listed on [`/backlog`](#backlog) instead |

A **gate** column is where a person acts, and its header carries an accent `◆`
and a hint ending "— drop a card here" (Planning's says "drop here to promote or
re-plan"). A card in Ideas carries a "no requirements yet" or "requirements
vN" chip. A **derived** column is set by Claws and
is never a drop target; its hint ends "— set by Claws, not a drop target". A PR
open card carries a chip for each of its rows' `manual-action`, `problematic`
and `ci-failing` stages and `needs_human_review` (as the `Manual Action`,
`Claws Problematic`, "CI failing" and `Needs LGTM` chips), so the PRs that need
a person do not hide among the ones mid-review.

Within every column, cards are ordered by the issue's `updatedAt` newest first,
with Priority cards pinned above the rest and the ordering applied inside each
group separately; a card with no `updatedAt` sorts to the bottom of its group.
The Done column's 50-row cut described above is still by `closed_at`, computed
on the server before `buildBoardPage` re-orders the column like every other
one. Dropping a card is itself the card's newest update, so the client places
a moved card at the top of its group in the destination column rather than
waiting for a reload to reflect it.

The ladder, following the pipeline's own precedence:

1. closed → Done
2. unassigned → Ideas
3. `Backlog` → off the board
4. `Blocked` → Blocked
5. a running implementer → Implementing
6. `Refined` → Approved
7. open PR rows → Awaiting merge when every one is at `awaiting-merge`, else PR open
8. `Ready` → Awaiting plan review
9. otherwise Planning when `lifecycle` is `planning` (a forge card's from its
   shadow), else Ideas

`Backlog` leads the labels because a human's "not now" outranks every automated
state: a forge issue holding `Backlog` plus anything else is parked and off the
board, and imports with `lifecycle = backlog` (its `Refined` / `Ready` /
`Blocked` are dropped from the field, like any other multi-state import). Then
`Blocked`, because `gh.isParked` drops a blocked issue in
`jobs/issue-auditor.ts`'s loop *before* anything classifies it. A running
implementer outranks `Refined` because `issue-worker` keeps `Refined` until the
PR opens. `Refined` outranks an open PR because `classifyIssue` returns
`refined` before it looks for one: a multi-PR issue with one PR open and its
next phase approved is still Claws' to implement, and stays in Approved. A board
that ordered them the other way would disagree with the pipeline it draws.

An issue whose fix was pushed onto another issue's PR branch (issue-worker's
`targetPR` path) has no row of its own, so it shows in Ideas or Planning until that PR
merges; the comment issue-worker posts on it says where the work is.

**The Blocked column reads the `Blocked` label alone**, not the whole of
`gh.isParked`, which also parks an issue on `Claws Ignore` and — while the
active instance is running — on `Claws Staging`. Those two park it without
moving its card: an issue carrying `Claws Ignore` and `Refined` sits in Approved
under a hint that says Claws implements it, and every dispatcher skips it. The
card's own label chips are the only signal of that. The narrow reading is
deliberate — the board owns `LIFECYCLE_LABELS` and nothing else, so a move out
of Blocked removes exactly the `Blocked` label and cannot silently un-ignore an
issue — but read a column as "these are its lifecycle labels", never as "the
pipeline will act on it".

`transitionFor(to)` is the inverse map, applied by `POST /board/move`
(`{repo, ref, to}`, the ref canonicalised and validated like every other entry
point) through the same `github.ts` façade the `/issues` row buttons use. A move
declares the **complete** state of the labels the board *owns* —
`LIFECYCLE_LABELS` (`Backlog`, `Blocked`, `Refined`, `Ready`) minus whatever it adds is what
it removes — rather than an ad-hoc add/remove pair, which could not promise even
that much: "add `Refined`, remove `Ready`" leaves a `Blocked` card in Blocked, and
the route would answer `ok` for a column it never reached.

The page is `htmlOpenTag(theme, "full")` — the full width tier — and lays out
per form factor (see `docs/DESIGN.md#form-factors--responsive`):

- **Phone** (<768px): the three groups, and Blocked, stack. Each column is a
  full-width collapsible `<details>`; the derived columns, Planning, Blocked
  and Done start collapsed, leaving Ideas, Awaiting plan review and Approved
  open (Planning is the planner's queue and needs nothing from you), and each group's header shows
  how many cards its collapsed derived columns hold ("· *N* set by Claws"). A
  move opens its destination column. The per-card `Move to…` select is the
  touch path.
- **Tablet** (768–1023px): the groups still stack vertically, but each group's
  columns sit side by side — three at most (Shaping is Ideas, Planning and
  Awaiting plan review), so nothing side-scrolls. Every
  column is open and the derived count is hidden.
- **Desktop** (≥1024px): the groups and Blocked sit in one horizontally
  scrolling row, each column at least 13rem wide.

That leaves the move's shape short of `columnFor`, which also reads the flight,
`closed` and `unassigned` — none of which the move declares. So the route does not
trust that shape: it reads the issue's live state, its live labels *and* its
flight, computes `columnAfterMove(move, {labels, closed, unassigned, implementing, openPrs})` over
`(current − remove) ∪ add`, and answers `ok` only when that is the column asked
for, returning it in the body (`{result: "ok", column}`) so the client places the
card rather than assuming the drop landed. Anything else is a **409** with the
reason, computed *before* any label is written, so a refusal leaves the issue
untouched and the client can put the card back exactly where it was. There are
three cases:

- An **unassigned** native issue takes the labels and stays in Ideas, so
  every destination but Ideas and Done is refused with "assign this issue to a
  repository before moving it out of Ideas". Only a zero-repo issue is
  unassigned; a multi-repo one moves like any other. Its per-card select
  offers only those two columns: the select is the whole touch and keyboard
  path, so picking a guaranteed refusal and watching the card snap back would
  otherwise be the only way to learn this.
- A **closed forge** issue cannot be reopened by the façade, so it stays in Done
  whatever labels a move applies, and every destination but Done is refused with
  "the board cannot reopen a forge issue — reopen it on the forge". Only a card
  the *client* closed can be in that state on a rendered board, so it is the
  client that empties that card's select — see below.
- An issue **in flight** keeps its running implementer or open PR through the
  move, so a destination that does not outrank the flight in the ladder lands
  back in a derived column and is refused with `DERIVED_COLUMN_REJECTION` —
  "Implementing, PR open and Awaiting merge follow the issue's running
  implementer and open PR — open, merge or close the PR instead.", the same
  message a drop into a derived column gets. See the table below for which.

The state, the labels and the flight are *read* (`gh.getIssueState`, one round
trip for the first two, and `loadIssueFlight` beside it), not inferred from the
card: nothing re-renders this page, so a tab left open outlives the issue cache
by hours and can still show an issue in PR open long after its PR merged and
closed it. Without the read, dragging that stale card would relabel a closed
issue and report a column it is not in.

| Dropped into | Effect |
| --- | --- |
| Ideas | Removes `Backlog`, `Blocked`, `Refined`, `Ready`, and demotes the issue's shadow; **409** for an issue in flight |
| Planning | Removes `Backlog`, `Blocked`, `Refined`, `Ready`; promotes the issue's shadow, per [Requirements](#requirements), or a plain lifecycle write when it already has a recorded approval; **409** for an issue in flight |
| Awaiting plan review | Adds `Ready`, removes `Backlog`, `Blocked`, `Refined`; **409** for an issue in flight |
| Approved | Adds `Refined`, removes `Backlog`, `Blocked`, `Ready`; **409** while the implementer runs |
| Blocked | Adds `Blocked`, removes `Backlog`, `Refined`, `Ready` |
| Backlog | Adds `Backlog`, removes `Blocked`, `Refined`, `Ready`; **409** for an issue in flight |
| Done | Closes the issue as `completed` |
| Implementing, PR open, Awaiting merge | **Refused with 409** |

That table is the forge path. A forge issue's Ideas and Planning live on its
[shadow](#shadows); a drop into either before the shadow sync has minted one is
a 409 asking to try again. For an open **native** issue a move is a single write
of the column id to the `lifecycle` field — skipped when the field already holds
it — with the same pre-checks and 409s, the write flag raised immediately before
it: any move into Planning with no recorded approval yet is `clawsIssues.promoteIssue`,
any move into Ideas is `demoteIssue`, and the rest are `setLifecycle` — see
[Requirements](#requirements) for when a move counts as a promotion, its entry-move
exception, and what it approves. There is no add-then-remove pair, so a native move
cannot be left half applied. `setLifecycle` emits the `label-added` (new state
label) or, on a move to Ideas or Planning, `label-removed` (old state label)
event the equivalent label write would have.

The issue page (`/issues/:id`) has a **Status** section that shows the current
column as a pill and one button per state the issue can move to — **Mark
refined** (Approved), **Mark blocked**, **Move to Awaiting plan review**,
**Promote to Planning** (from Ideas; **Send back to Planning** otherwise),
**Move to Ideas** and **Send to backlog** — each posting `column=<id>` to
`POST /issues/:id/column`. That route reads the issue's flight and applies the
board's refusals: 409 with `DERIVED_COLUMN_REJECTION` for a derived column, 400
for anything else but the six stored states, 409 with
`DERIVED_COLUMN_REJECTION` for `backlog` on an issue in flight, 409 with
`UNASSIGNED_REJECTION` for an issue with no repository, 409 for a closed issue,
and 409 when `columnAfterMove` says the issue would not land there (an issue with
an open PR sent to Ideas, Planning or Awaiting plan review, or one whose implementer is running
sent to Approved). The page reads the same flight and offers only the targets
the route would accept, and none on a closed or unassigned issue.

Beside **Mark refined**, an issue that does not already hold `Automerge` also
gets a **Refine & Automerge** button: the same `column=approved` post, plus a
hidden `automerge=1` field. The route applies `Automerge` right after the
lifecycle write, so the PR that plan produces ships on green CI and a clean
review with no further click — the same approval `Automerge` always means, just
granted ahead of the plan existing. Labelling it after the write rather than
before means a labelling failure still leaves the issue refined; the operator
sees the general error page and can apply `Automerge` by hand from the Labels
form. The state labels are no
longer checkboxes on `/issues/:id` or `/issues/new`, and `POST /issues/:id/labels`
leaves them out of the labels it offers, so a "Save labels" cannot reset the
state. Nor are they chips where a column or pill already shows the state — the
issue page header, and a board card.

Those are the labels a move *declares*, not the writes it makes: a `removeLabel`
is issued only for a label the issue is really holding and an `addLabel` only for
one it is not. The common Planning → Approved drag otherwise fired a removal for each
of `Blocked` and `Ready` when the issue held neither, and on the GitHub path every
one of those is a `fetchLiveLabels` `gh api` subprocess spawn before it decides
there is nothing to do; a redundant add is an `ensureLabel` plus a `gh issue edit`
to end up where it started, and a no-op `label-added` event waking that
repository's `claws_wait_for_change` waiters. It follows that a relabelling move
can write **nothing at all**, which is why the write flag below is set per write
rather than once for the whole block.

A running implementer or an open PR puts an issue in a derived column, so no
label change an operator can make produces one — the route says so with a 409
rather than silently doing nothing, and the per-card select does not offer them
at all. Dragging *out of* a derived column keeps the flight, because no move
touches the task or the PR, so the destination is reachable only if it outranks
the flight in the ladder:

- **Blocked** reaches the column asked for from any flight: `Blocked` outranks it.
- **Approved** does for an open PR — `Refined` outranks it — but not while the
  implementer runs, which outranks `Refined`.
- **Ideas**, **Planning** and **Awaiting plan review** never do. The issue stays in its derived
  column, so `columnAfterMove` reports that and the `landing !== to` check
  answers **409** carrying `DERIVED_COLUMN_REJECTION` — the same fact in the
  same words, and the words say what to do instead: merge or close the PR.
  Nothing is written.
- **Done** closes the issue, and `closed` outranks everything.

So a card in flight carries `data-in-flight` — `task` for a running implementer,
`pr` for open PR rows — and its select offers Blocked and Done, plus Approved
for `pr`; it has no select checkbox and no Backlog option. That is derived from
the card's *flight* rather than its column, since the flight survives a move and
a column-derived rule would stop being true the moment the client moved the
card. Those options are **omitted** rather than rendered `hidden`, which is
what makes the restriction stick: `syncMoveSelect` walks the options that exist
and can un-hide one, but cannot bring back one that was never rendered.

A label removal that `github.ts` could not confirm answers **500** rather than
`ok` — a leftover label that outranks the one just added would put the card in a
column the issue is not in. The target's label is added *first* and the removals
then run together: with the add last, a failed removal would leave the issue
holding no lifecycle label at all (Ideas or Planning, which is neither end of the drag),
whereas adding first leaves the outranking old label in place and the issue in
the column the card came from. Such an answer carries **`partial: true`** in its
body, meaning a **partially applied move** whose true column the page cannot
know, so the client leaves the card where it was dropped and says to reload
rather than reverting — a revert would be as wrong as the optimistic move was.
The marker is in the body rather than on the status because `/board/move` is not
the only producer of a 500 on that URL: Hono's `app.onError` answers a bare one,
with no JSON body, for anything that throws around the handler — an expired
session's middleware first among them — and a proxy can answer one of its own.
A client reading the status alone calls those half-applied moves and strands the
card; a body the route did not write parses to `{}`, so reading the marker
reverts correctly. The status still splits the same way, for the operator and
the logs: an *unexpected* throw is a 500 only once something has been written,
and 503 while nothing has. The route tracks that in a flag, which also decides
`partial`, so the answer follows what happened rather than where the throw
happened to be. The flag means "a write has been
*issued*", not "a write returned", and it goes up immediately **before** each
write, never after — per write rather than once for the whole block, because a
relabelling move whose labels the issue already holds writes nothing at all, and
a 500 for that would send the operator off to reload a board that is right.
Issued rather than returned, because a write that throws may still have landed:
`closeIssue` commits the native state before it emits its events, a `gh` failure
can surface after the edit took server-side, and the removals all start before
any of them is awaited. Set on the write's **return**, a throw out of the first
one would report "nothing changed" for a move that had already closed or relabelled the issue —
the board lying in exactly the direction the flag exists to prevent. The other
direction costs a reload. For the same reason the removals are
gathered with `mapSettledWithConcurrency` rather than `Promise.all`: `Promise.all`
rejects at the first failure while its siblings keep running and removing
labels, so the outcome deciding the answer would be the one discarded.

Both label writes invalidate that repository's `open-issues` cache inside
`github.ts`/`forgejo.ts`; the façade-wide rule about which writes invalidate and
which deliberately do not is enumerated in
[modules.md](modules.md). Without it the 60-second entry would serve the pre-move labels back to the
next `GET /board`, and a reload within the window would put the card back in its
old column with nothing on the page to say why — indistinguishable from the move
having been silently undone.

Dragging out of Done reopens the issue — but only a native one, because the
façade has no forge reopen. The other direction is the board's one destructive
action: dropping a **forge** card into Done closes the issue and the card then
vanishes from the board with no way back from this page, so the client asks for
confirmation first, and the close is notified under `NOTIFY_DASHBOARD_ACTIONS`
exactly as the issue page's close is.

No *server render* puts a forge card in Done, but a live one can: a card the page
just closed stays in the column. Dragging it back out would relabel an issue that
is still closed, so the client refuses it before sending — every closed card
carries `data-closed="true"` (set by `pages/board.ts` and kept in step by the
client after each move) — and it empties that card's select of every other
destination and drops every column as a drop target, the same rule
`pages/board.ts` applies to an unassigned card and for the same reason: neither
a select nor a drop target is a place to offer a guaranteed refusal.
The refusal is only a pre-flight for the cards *this page* closed; the route
makes the same one from the state it read, which is what catches a card that was
already stale when the page rendered.

A native issue's card may arrive with `repo` empty on the wire, so the route
resolves the repository it writes through from the issue's own record — its
primary repo, or `""` when it has none. Resolving rather
than trusting the wire is what keeps the allowlist gate on this route: an empty
`repo` falls through `isConfiguredRepo`, so passing it on would let a hand-sent
`{repo: "", ref: <native id>}` write to an issue whose only repository Claws
does not manage. The resolved repository goes back through `isConfiguredRepo`
before any write. An unassigned issue resolves to `""`, which is what the façade
wants — `claws-issues.ts` then emits its events for every repo on the record —
and a forge ref resolves to the `repo` it must name, exactly as the queue
actions require. A named repository must also be one of the issue's own
(`record.repos`), or the move is a 403: `claws-issues.ts` tags its
`label-added`/`issue-closed` events with the acting repo, so labelling through
some other configured repository would wake that repository's
`claws_wait_for_change` waiters over an issue it has nothing to do with.

Every failure that happens *before* the first write carries a status the client
reverts on. A body that is not JSON is a **400**, not a 500 — it is read and
parsed before the handler's `try` — a native ref no issue answers to is a
**404** rather than the 503 the state read would otherwise throw into ("try
again" for a condition no retry can fix), a state read that throws (a live
API call for a forge ref) is a **503**, and so is anything else that throws
before the first write is issued. None of them carries `partial`, so the client
reverts on every one of them.

The client reads that contract as **"no `partial` in the body means nothing was
written"** (`changedNothing`, `src/client/issue-board.ts`), not as a list of
the refusals above and not off the status. An allowlist of refusals drifts: it
missed the status that reaches this fetch most often, the **401**
`authMiddleware` answers every dashboard POST once the session expires, and
rendered every move as applied with "reload the board to see where the issue
is" — `auth-watch.ts` does not rescue it either, because its `recover()` stays
put while the page is dirty and the card's `<select>` fires the `input` event
that marks it so. Testing the status inverts that drift without ending it, since
`app.onError` and any proxy in front of it also answer 500 on this URL. Only the
route writes `partial`, and a body it did not write parses to `{}`.

The page is server-rendered with one client bundle for the moves. The card is
draggable as a whole (there is no separate handle) **and** carries a "Move to…"
`<select>`, because dragging is a mouse gesture and phones are a primary client
(see [DESIGN.md](DESIGN.md#form-factors--responsive)). Every move is optimistic and reverted to the card's exact
previous position if the server answered *without having written anything*
(no `partial: true` in the body), or if the request never reached the server at all — or to
the end of its column when the neighbour it remembered has since moved — and a
card with a move in flight refuses a second one. A moved card is placed above
the column's ordinary cards when it carries `Priority`, matching how the server
orders a render. A destination the card provably cannot reach is never offered
*or* accepted: the client's `canReach` drives the select's hidden options, the
drag's drop targets (a column it refuses does not call `preventDefault`, so the
cursor shows "no drop" and the drop never fires) and the pre-flight in
`moveCard`, from one rule. Learning a refusal by picking it and watching the
card snap back is what all three exist to avoid. Nothing else re-renders the board, so the DOM is the only
copy of its state. After editing `src/client/issue-board.ts`, run
`npm run build:client` and commit the regenerated
`src/resources/issue-board.generated.ts`.

`Priority` cards sort to the top of their column; everything else keeps the order
the server assembled (the open cards repo by repo, the closed ones newest first
across all of them).

`?repo=` is the board's only filter, and it can always be widened again from the
page it produced. The Repository select sits in the one toolbar row with the
title, the card count and the Backlog link; it has no visible caption, so its
empty option reads "All repositories" and choosing it clears the filter. It
enumerates every repository Claws manages, handed to the page rather than
derived from the cards on it: `?repo=` and the Done column's row cap both cut
cards before the page sees them, so a repository whose only cards were cut
would vanish from the very filter that is hiding it. It also carries the active
value even when no card carries it — a `?repo=` naming a repository with no
open issues would otherwise render as "All repositories" over an empty board.

Each card's head shows a small **age chip** — how long the issue has been in its
current column (`2h`, `3d`). A native issue reads it from
`claws_issues.stage_changed_at`, set whenever its column could change: a
`lifecycle` change, or a close or reopen; a Done
card measures from `closed_at`. A row that predates the column falls back to
`updated_at`, so it converges on its next move. A forge issue has no stored
column timestamp, so its chip shows the age of its last activity instead,
prefixed `~` and titled to say so. The chip turns the warning colour past a
per-column threshold (`STALE_AFTER_MS` in `src/pages/board.ts`: Ideas and the
derived columns 3 days, Planning, Awaiting plan review and Approved 24 hours;
Blocked and Done never),
and the client resets it to `<1m` on a move the server accepted.

Changing the select applies the filter at once: the client re-submits the
same `GET /board` form rather than hiding cards itself, because the server owns
the `?repo=` cut, the Done cap and the incomplete-sources warning. The Filter
button is still rendered for the no-JS path, and the client hides it.

Every card with a repository, other than a Done card, carries a compact **M**
toggle (`M` for "merge" — `A` would read as the Approved column the card may
sit in) showing and setting the merge approval, via `POST /board/automerge`
(`{repo, ref, on}`); the board does not repeat `Automerge` as a chip once the
toggle carries it. It shows on when the issue holds `Automerge` or any of its
open PR rows carries `merge_approved_at`. Like a move it is optimistic and
reverts through `#board-status` on a refusal or a failed request, but unlike a
move it never touches the card's column — a merge approval is not a lifecycle
state, so flipping it moves no card; the approval is how an Awaiting merge card
lands.

Turning it on records who approved: for each of the issue's open PR rows the
route writes `merge_approved_by` — the OIDC `sub` of the request's
`claws_session`, or `"dashboard"` without one (`sessionSubject` in
`src/server.ts`) — and `merge_approved_at`, *then* applies `Automerge` to that PR,
and finally to the issue so the next PR Claws opens inherits it. The row comes
before the label because the label hook (`patchForLabelAdded` in
`src/pr-state.ts`) writes its own `Automerge` approval only when
`merge_approved_at` is empty, so the session's identity survives it. Turning it
off removes the label from each open PR and the issue, then clears both row
columns. The label writes stay while the PR-state façade is inert; they are
separate statements so that phase 5 can delete them. `POST /queue/mark-automerge`
and `POST /queue/merge` record the same two columns on a PR's row, when Claws
tracks one, before the label or the merge. With no open PR the toggle can only
decide the *next* PR Claws opens, and its title says so (`"applies to the next
PR Claws opens"`).

### Backlog

`Backlog` is the lifecycle state for "not now, but some day" (#3293). It is the
sixth `lifecycle` value (`backlog`) and a single-valued state label, synced
fleet-wide by `repo-standards` like `Blocked`, so a forge issue can carry it by
hand on GitHub or Forgejo and behave identically; removing the label returns it
to Ideas, or to Planning when it has a plan or approved requirements. The
backlog UI below reuses the word "Promote" for this — a different, unrelated
sense from [requirements Promotion](#requirements): restoring an issue from
the backlog can land it back in Ideas, which is the opposite of promoted in
that sense.

- **The pipeline leaves it alone.** `gh.isParked` treats `Backlog` like
  `Blocked`: no planning, no auditing (the issue-auditor does not re-add
  `Ready`), no error triage, no dispatch. Unlike `Blocked`, nothing automated
  ever removes it — `upstream-watcher` removes only `Blocked` and `Claws Ignore`
  — so only a human promotes it.
- **It is off the board.** `columnFor` gives it no column. `GET /board` splits
  backlog cards out of the same fetch and shows a **Backlog (N)** link in the
  header, counted under `?repo=` for that repository alone.
- **`/backlog`** (`src/pages/backlog.ts`) lists every backlog issue across the
  fleet, grouped by repository and newest first, with `?repo=` and `?label=`
  filters. Each row has a **Promote** button, and ticking rows enables
  **Promote selected**; both post to `POST /backlog/promote`, a plain form that
  needs no JavaScript and redirects back to the filtered list, or renders an
  error page listing each item it could not move.
- **Sending an issue there** works from the issue page's **Send to backlog**
  button, a board card's move select, the **Backlog** tray under the board's
  columns (a drop target, not a column: a card dropped there leaves the page and
  bumps the header count). An issue in flight — a running implementer or an
  open PR — cannot be sent: `Backlog` outranks the flight in the ladder, so
  `backlogRefusal` checks the flight explicitly and every path answers 409 with
  `DERIVED_COLUMN_REJECTION`. The select and the issue page do not offer the move
  to an issue in flight or an unassigned one.
- **Bulk moves** go through `POST /board/bulk-move`
  (`{to: "backlog" | "ideas", items: [{repo, ref}]}`, at most 200 items;
  `ideas` is the Promote, which lands where `entryLifecycle` says). Each
  item is exactly one `POST /board/move` — the same `applyBoardMove` helper, with
  every refusal above — and the answer is 200 with one `{repo, ref, status,
  error?, partial?, column?}` per item, in order. The board no longer has a
  bulk control; the route stays for API callers.
- **Promotion restores what it can.** Promoting lands a native issue in Planning
  when it has a plan or approved requirements (`clawsIssues.entryLifecycle`) and
  in Ideas otherwise — a forge issue's stage follows its shadow — with labels,
  comments, requirements and plan untouched. If it had a plan before it was backlogged, the
  dispatcher's plan-body-hash check ([stale-plan guards](jobs/issue-dispatcher.md#stale-plan-guards))
  decides on its next tick: a plan still current for the issue's title and body
  is reused (the issue-auditor re-applies `Ready`, so it returns to Awaiting
  plan review), while a stale one is **re-planned rather than re-approved**.
- **`/issues/new`** has a **File to backlog** checkbox, which files the new issue
  straight into the backlog for ideas captured for later.

A forge issue holding `Backlog` while its PR is open (labelled by hand) is parked
and off the board: `Backlog` outranks the flight.

## Tables

See [database-schema.md](database-schema.md#claws_issues-table) for the columns.
`claws_issues` holds the issue; `claws_issue_repos`, `claws_issue_labels`,
`claws_issue_comments`, `claws_issue_comment_reactions`, `claws_issue_plans`,
`claws_issue_requirements` and `claws_issue_attachments` hold the rest, as does `claws_issue_links` ([Links](#links)), whose
`source_id` and `target_id` both cascade — each with `ON DELETE CASCADE` back to
the issue (an attachment's `comment_id` is `ON DELETE SET NULL`). `claws_issues.kind` distinguishes
an operator-facing native issue (`issue`) from the hidden backing record of an
issue still live on a forge (`shadow`) — see [Shadows](#shadows).

Six existing columns hold an issue *reference* rather than a number and are
therefore `TEXT`: `tasks.item_number`, `work_queue.item_number`,
`notified_untrusted_actors.issue_number`, `reminder_notifications.issue_number`,
`upstream_watch_fires.issue_number` and `blog_draft_ports.issue_number`.
`ci_fixer_breaker.item_number` is PR-keyed and stays numeric.
