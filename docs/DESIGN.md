# Design Guidelines

**Reference.** Read this when you're touching dashboard HTML/CSS and need the
styling rules — tokens, layout, mobile conventions. For architecture or
backend patterns, see OVERVIEW.md/patterns.md instead.

Product requirements: [product/dashboard-and-integrations.md](product/dashboard-and-integrations.md)

Claws' own dashboard styling. This is the authoritative source `FRONTEND_AESTHETICS_CONTEXT`
(`src/agents/agent-context.ts`) tells agents to look for before touching any page in this repo.
New pages and components must consume the CSS custom properties below via `var(--…)` — never
hard-code a hex value that duplicates one of these tokens.

This doc exists because of an explicit owner requirement (#2142): style choices should be
delegated to each repo, with "a monitor that creates an issue in any repo that has a UI but no
guidelines" — landed as `design-guidelines-scanner` alongside this file and the
`FRONTEND_AESTHETICS_CONTEXT` agent context. It was later extended to cover mobile (PR #2161),
since the dashboard is heavily used as a home-screen PWA and saying nothing about narrow
viewports left agents treating them as an afterthought.

## Typeface

- Display: `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace` — headings, nav, table
  headers, `.meta dt` labels. Technical and deliberate; not on the AI-slop-default list
  (Inter/Roboto/Arial/system-font stacks), and not the equally-overused Space Grotesk.
- Body: `"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif` — everything else.
- Both loaded via Google Fonts `preconnect` + stylesheet link in `HEAD_META` (`src/pages/layout.ts`)
  and duplicated in the standalone `<head>` blocks of `src/pages/blog.ts` and `src/pages/damp.ts`
  (neither imports `HEAD_META`).
- Weight contrast is deliberately extreme: `h1` is 200-weight uppercase with wide letter-spacing;
  `h2` is 600-weight uppercase, much smaller. Don't converge the two toward a similar weight/size.

## Colour tokens

All tokens are CSS custom properties: `LIGHT_THEME_VARS` (light) and the dark `:root` block inside
`PAGE_CSS`, both in `src/pages/layout.ts`. Add new tokens if a page needs one; do not rename or
remove existing tokens — pages and client-side JS reference `--accent`, `--success`, `.running`,
`.queue-item`, etc. by string.

Dark:

| Token | Value |
| --- | --- |
| `--bg` | `#0b0c0e` |
| `--bg-secondary` | `#15171b` |
| `--text` | `#e8e3da` |
| `--text-secondary` | `#9b958a` |
| `--text-subtle` | `#5d574e` |
| `--accent` | `#ff8a3d` |
| `--border` | `#232629` |
| `--border-hover` | `#343840` |
| `--success` | `#5fd38d` |
| `--danger` | `#ff5f56` |
| `--warning` | `#e0a44a` |
| `--btn-bg` | `#1b1e23` |
| `--btn-hover` | `#262a30` |
| `--save-bg` | `#2f7d54` |
| `--save-hover` | `#379464` |
| `--save-border` | `#379464` |
| `--banner-bg` | `#16281f` |
| `--banner-border` | `#379464` |
| `--warn-banner-bg` | `#2b2114` |
| `--warn-banner-border` | `#e0a44a` |
| `--log-debug` | `#6a655c` |

Light (`LIGHT_THEME_VARS`):

| Token | Value |
| --- | --- |
| `--bg` | `#faf7f2` |
| `--bg-secondary` | `#f0ebe2` |
| `--text` | `#1c1a17` |
| `--text-secondary` | `#6b655c` |
| `--text-subtle` | `#948d82` |
| `--accent` | `#c1521a` |
| `--border` | `#ddd6ca` |
| `--border-hover` | `#c4bcae` |
| `--success` | `#1f7a4d` |
| `--danger` | `#b3352c` |
| `--warning` | `#96631a` |
| `--btn-bg` | `#efe9df` |
| `--btn-hover` | `#e3dbcd` |
| `--save-bg` | `#1f7a4d` |
| `--save-hover` | `#26925c` |
| `--save-border` | `#26925c` |
| `--banner-bg` | `#dff2e6` |
| `--banner-border` | `#26925c` |
| `--warn-banner-bg` | `#fbf0d5` |
| `--warn-banner-border` | `#c99b32` |
| `--log-debug` | `#948d82` |

`--accent` (ember orange) and `--warning` (amber) are adjacent hues on purpose — warning states
always carry a distinguishing border/banner background, so don't "fix" the closeness by shifting
warning green-ward.

`--text-subtle` is intentionally low-contrast (~4.3:1 against `--bg`) — fine for de-emphasised
metadata, not for primary text. Don't darken it further.

`CATEGORY_DISPLAY` (top of `layout.ts`) is GitHub label colours, not part of this palette — leave
it alone. The hard-coded `#d93f0b` verify-only banner in `buildPageHeader` is also out of scope.

## Backgrounds

Layered radial-gradient depth behind the flat `--bg` fill, via a `--bg-layers` token applied as
`background: var(--bg-layers), var(--bg); background-attachment: fixed;` on `body`. Not a flat fill,
not a full-page pattern.

## Motion

No page-load or entrance animation. The dashboard renders in its final position on
first paint — headings, nav, and content do not fade, slide, or stagger in. This is a
deliberate product decision (issue #2145 — the owner's words on the entrance animation
that shipped with the first version of this doc were "I don't like the new menu
animations"), not an oversight, and it overrides the generic "one orchestrated
page-load reveal" default in `FRONTEND_AESTHETICS_CONTEXT`.

Motion is reserved for a single narrow case:

- **Live execution flow** — an element that represents a job genuinely in motion may
  animate; no current page has one. Status dots (`.running::before`, `.idle::before`,
  `.paused::before`) in `PAGE_CSS` are static and must not animate — the shared
  `.running` class labels steady states such as "Connected"/"Healthy"/"Active" in the
  dashboard Integrations list, so a pulse there reads as noise (issue #2453).
- **Hover/focus feedback on interactive controls** — e.g. `transition: all 0.2s` on
  `.cancel-btn`. Keep these under 0.2s and limited to colour/border properties.

Never animate anything a live poller replaces (`.queue-item`, table rows,
`.data-cards`, or any subtree `src/client/queue.ts` and the dashboard and `/jobs` pollers re-render
on every refresh) — it would re-fire and flicker on every poll.

## Form factors & responsive

Claws' dashboard has three form factors, and every user-facing page must work on all
three — none is a degraded fallback for another:

- **Phone** — narrower than 768px. Often installed as a home-screen PWA (`HEAD_META` in
  `src/pages/layout.ts` ships the manifest and `apple-mobile-web-app-*` meta tags).
- **Tablet** — 768–1023px, portrait or landscape, touch input.
- **Desktop with a large monitor** — 1280px and up, often much wider than that.

768px and 1024px are the only sanctioned breakpoints; don't add a third without a
documented reason.

- **Width tier (required decision).** A page whose primary content is a table, list or
  grid passes `"wide"` (or `"full"`) to `htmlOpenTag(theme, width)`; the 64rem default is
  for prose, forms and detail pages. `"wide"`: `/status`, `/prs`, `/issues` (both rendered by
  `lists.ts`), the `/sessions` list, `/usage`, `/dmarc`, `/jobs`, both `/logs` detail pages
  (`/logs/:id` and `/logs/issue`) and `/repos/:name`. `"full"`: `/board` and the session
  terminal. `/` is a redirect to `/board` and renders no page of its own. Default (64rem):
  `/config`, `/damp`, `/issues/:id`, `/issues/new`, `/whatsapp`,
  `/ha-upgrader`, `/blog`, `/reauth`, the error page. `body { max-width: … }` in a page's
  own stylesheet is an anti-pattern — a page with a genuinely bespoke width sets
  `--page-width` on `html` directly instead.
- **Nav alignment.** `nav` and `.warning-banner` are centred (`margin-left/right: auto`)
  at the constant `--chrome-width` (`64rem`) on every tier, so the menu sits in the same
  place on `/board`, the session terminal and every default-tier page. On `"wide"`/`"full"`
  pages this means the nav sits centred above left-aligned page content — that's by
  design, not a bug to "fix" by widening `--chrome-width`. The nav wrapping to two lines
  at very wide viewports (roughly ≥1440px, where the centred 64rem nav no longer spans
  the full window) is accepted; it can't happen on a default-tier page since the nav
  never exceeds the 64rem body there.
- **Mobile-first at 768px.** Base styles in `PAGE_CSS` are the phone layout; desktop
  refinements live in `@media (min-width: 768px)` blocks (larger `h1`, wider padding,
  single-row `.queue-item`). New components follow the same shape: write the narrow
  layout first, enhance upward.
- **Tables collapse to cards.** Any `<table class="data-cards">` inside `.table-scroll`
  becomes a stack of labelled cards below 768px: cell labels come from `data-label`
  attributes, `.cell-title` promotes a cell to the card heading, `.hide-sm` drops
  low-value columns on phones. New tables must use this pattern — a raw `<table>` that
  only side-scrolls on mobile is not acceptable for primary content.
- **Three width bands.** Below 768px every `.data-cards` table is cards (above). From
  768–1023px (tablet, either orientation) it renders as a full-width table with no
  `min-width` floor — a portrait tablet has only ~704px of content, so the desktop
  `min-width: 820px` floor must not apply there — unless it has **more than six columns**,
  in which case it takes the `data-cards-wide` modifier class to stay cards through
  1023px instead of switching to a table it can't fit. From 1024px up, every
  `.data-cards` table gets the 820px floor. `src/pages/lists.ts`'s `/prs` table (nine
  columns) and the four `src/pages/usage.ts` tables with nine or ten columns use
  `data-cards-wide`; the six-column `/usage` signals table does not, since it fits. The
  sessions tables (`src/pages/sessions.ts`, nine columns) were the original case (#3229).
  The Capabilities cell also caps at two lozenges plus a `+N` overflow pill (title lists
  the rest) to keep rows from stacking one pill per line.
- **Existing tables.** All primary-content tables use `.data-cards`. One is exempt and
  stays raw: the `/jobs` per-repo toggle matrix (a checkbox grid with rotated column
  headers — its phone/tablet layout is the existing `.matrix-wrap` side-scroll with a sticky
  header row and sticky Repo column on every tier). The `/jobs` job-status table above it
  (seven columns) uses `data-cards-wide`: Job is the card title, Next Run and Logs are
  `.hide-sm`, it stays cards through the tablet band and becomes a table from 1024px.
  Everything else still on a raw `<table>` is migration backlog:

  | Page | Tables migrated | Card title | `.hide-sm` columns |
  | --- | --- | --- | --- |
  | `/dmarc` | 4 (reports, verdict counts, sources, raw rows) | Domain / Source IP | reports: Published policy, Rows · sources: Last seen · raw rows (wide-cards): Window start, Header from, Reporter, Disposition · verdict counts: none |
  | `/repos/:name` | 4 (PRs, 2 issue tables, jobs) | Title / Item | PRs: Author, Branch · issue tables: Author · jobs: Started, Duration |
  | `/whatsapp` | 1 (events, Alpine `x-for`) | Event | none |
  | `/ha-upgrader` | 1 | Entity | First Seen, Failures |
  | `/blog` | 1 | File | none |

- **Per-page behaviour.** List/table pages (PRs, issues, sessions, usage, dmarc, jobs):
  cards on phone, a full-width table or `data-cards-wide` cards on tablet, the `"wide"` tier on desktop. Detail pages:
  `/issues/:id` renders at the default tier — it's prose (title, body, comments), not
  a grid — with a `.meta` grid for metadata and any table inside using `.data-cards`;
  `/logs/:id` and `/repos/:name` are single-item pages too but take the `"wide"` tier
  like their list-page siblings (`/repos/:name` holds several tables of its own, and
  `/logs/:id`'s pre-formatted `.log-output` reads better with the extra width), and
  both still use the `.meta` grid and cards-based tables. Forms (`/config`, `/damp`,
  `/issues/new`): single column below 768px, a two-column grid above. `/board`: groups
  stack below 1024px, and columns stack as `<details>` below 768px (see below). The session terminal: compact mode hides
  the nav (see below). `/jobs`: the job-status table is `data-cards-wide` cards on phone
  and tablet and a table from 1024px; the toggle matrix below it is exempt, sticky header
  row and Repo column instead of cards. `/status`: single-column `.meta` grids for the
  version/uptime and integrations sections, plus a six-column `.data-cards` Agent Queue
  table (Position, Job, Repo, Issue, Title, Action) — cards on phone, a full-width table
  on tablet and desktop (no `data-cards-wide`, since six columns fits). `/logs/:id`: the
  level filter bar wraps on narrow widths, and log lines
  wrap long unbroken tokens via `word-break: break-all` instead of forcing a side-scroll.
- **A fixed-`ch` truncation cap must not carry into the card layout.** `.cell-summary`
  (used by `pages/sessions.ts`'s Summary column) ellipsis-truncates at `42ch` on desktop,
  but the mobile card override drops the cap entirely (`max-width: none; white-space:
  normal; overflow-wrap: anywhere`) instead of reusing the desktop value. In the card
  layout each `<td>` becomes a flex item with a fixed-width `::before` label, so a
  `max-width` meant for the full table cell leaves far less room than intended, and
  `overflow: hidden` on a flex item clips text mid-glyph with **no** ellipsis (`text-
  overflow: ellipsis` is a no-op there) — #2252. `overflow-wrap: anywhere` (not `break-
  word`) is required so a long unbroken token (a path, URL, branch name) still wraps
  inside the card; this mirrors `.cell-title`'s existing mobile treatment.
- **The wordmark, Menu and Profile share a single header bar.** `buildNav` (`src/pages/
  layout.ts`) renders the "CLAWS" `<h1>` inside `<nav>` itself, between the Menu toggle
  label and the profile dropdown, so `buildPageHeader` no longer emits a standalone `<h1>`
  above the nav on any page that shows one — one compact bar at the top of the page instead
  of the wordmark and nav stacking as two rows (#clw_01M37VVXE4HTTRQ1YSKKD8HJ30).
  `buildPageHeader` still renders the standalone `<h1>claws</h1>` on its own when called
  with `showNav: false`. Below 768px the bar is one row reading Menu · CLAWS · Profile,
  with the wordmark centred between the two controls; the collapsed `.nav-links` and the
  `.nav-favourites` pills still follow as further rows underneath. From 768px the Menu
  label hides as before, so row one is CLAWS on the left and Profile on the right, and
  `.nav-links` (`flex-basis: 100%`) wraps to a full-width second row under the wordmark —
  15 links plus a wordmark cannot share row one without wrapping raggedly. `nav h1` scopes
  the wordmark's smaller size (1.25rem on phones, 1.5rem from 768px) so the global `h1`
  rule used by the standalone login wordmark is untouched.
- **Nav is a hamburger on phones.** `.nav-toggle` (CSS-only checkbox) collapses the nav
  links below 768px, and `.nav-favourites` shows mobile-only quick-link pills. Don't add
  nav items that assume the full horizontal bar is visible. The favourites bar is an
  owner requirement (#2131): the owner's most-used views must stay reachable on mobile
  without opening the hamburger — "leave them in the full menu too, just add them to a
  favourites bar that always shows", so the pills are an addition to the nav list, never
  a replacement for it. The pills are `/board`, `/issues`, `/prs` and `/sessions`
  (#clw_01M37CNYHH5KHTVX7SV9FNBZD7 superseded #2131's Queue/PRs/Issues/Sessions list;
  `/issues` was re-added by #clw_01M3946M9S8ZT0HB2DPQD91PYC).
- **Theme and Logout live in the profile dropdown.** `.nav-profile` is a CSS-only
  `<details>` whose `<summary>` reads "Profile ▾"; its absolutely positioned
  `.nav-profile-panel` holds the theme `<select>` and the Logout link, so opening it never
  reflows the nav. It is visible on every tier: on phones it sits on the hamburger row
  (it precedes `.nav-links` in the DOM); `margin-left: auto` (not `order`) keeps it pinned
  to the right end of the bar on every tier, including now that the wordmark shares row
  one with it from 768px. No JS closes it on an outside click; a second tap on the summary
  does.
- **The session terminal page hides the nav in compact terminal mode.** `buildSessionTerminalPage`
  (`src/pages/sessions.ts`) still renders `buildNav()` for larger desktop viewports — the
  wordmark now shows there too, as part of the shared bar — but its
  page-scoped compact media query removes the whole nav, wordmark included,
  on phones, tablets/touch devices, and constrained terminal windows (#2771, #3191): it is a
  full-bleed xterm.js view where that row costs terminal height, and its `← Back` link reaches
  `/sessions`, which has all of them. Its action row (`.session-bar-actions`) is
  `flex-wrap: nowrap` with `overflow-x: auto` so its controls (including the optional
  "Grant capability" select, #3072) stay on one line, shrinking font/padding in compact mode
  rather than wrapping; the grant result goes in its own status row beneath. This is the single exception
  to the mobile-favourites rule — not a licence to hide the nav on any other page.
- **Touch targets.** Interactive controls need comfortable tap areas — nav links carry
  extra padding and favourite pills a `min-height` for this reason. Don't ship
  tap-only controls smaller than roughly 30px in either dimension, and don't rely on
  hover as the only way to reach an action (see the coarse-pointer
  `@media (hover: none) and (pointer: coarse)` key bar in `src/pages/sessions.ts`).
  Bind a scrollable tap control's action to `click`, not `pointerdown` — a finger
  placed on the bar to scroll it will otherwise fire whatever it landed on before the
  scroll starts, since `click` never dispatches when the gesture becomes a scroll.
  Give `pointerdown` a listener that only calls `preventDefault()` (suppresses
  compatibility mouse events and, on the session terminal's key bar, keeps the iOS
  on-screen keyboard from dismissing) without suppressing `click` or the scroll —
  the pattern behind the Paste, Attach, Record and key-bar buttons in
  `src/client/session-terminal.ts` (#2870).
- **The board's columns stack, not side-scroll.** `/board` (`src/pages/board.ts`) is
  mobile-first like everything else here. Its nine columns sit in three
  `<section class="board-group">`s — Shaping (Ideas, Planning, Awaiting plan
  review — three wide), Building, Landing, each headed by an
  `<h2 class="board-group-head">` with a card count — with Blocked standing alone
  between Building and Landing. Human-gate columns (`.board-col-gate`) carry an
  accent `◆` before the title; derived ones (`.board-col-derived`) have a subtle
  header and a hint saying Claws sets them. Below 768px (phone) the groups stack
  and each column is a full-width `<details class="board-col">` with the header as
  its `<summary>`, so the operator scrolls down through columns rather than
  sideways through one wide row; the group header adds the count of cards in its
  derived columns (`.board-group-derived`, phone only). From 768px (tablet) the
  groups still stack but each group's columns (three at most) sit side by side;
  from 1024px (desktop) the whole board is one horizontally scrolling row. The
  client (`src/client/issue-board.ts`) collapses the derived columns
  (`implementing`, `pr-open`, `awaiting-merge`), `planning`, `blocked` and `done` on load on
  a phone and reopens whichever column a card moves into; the `Move to…` `<select>`
  on each card, not drag-and-drop, is the touch path — `draggable` is turned off on
  coarse-pointer devices.
- **The issue page collapses by section.** `/issues/:id` (`src/pages/issue.ts`) renders
  every part — Request, Current plan, Comments, and each form — as a native
  `<details class="issue-section">` whose `<summary>` is the section's `h2`, with the
  board's `▾`/`▴` indicator; plan sections nest as `<details class="plan-section">`. Only
  the parts an operator reads first start open, so a phone lands on the request and plan
  rather than scrolling past every form. The one exception is State (the close/reopen
  form at the bottom of the page): it renders as a plain `<h2>`, not a `<details>`, since
  it is a single always-visible action rather than a section worth hiding. The header title
  is also editable inline — a pencil `.icon-btn` beside it swaps the `<h2>` for a full-width
  text input without leaving the page — and a copy `.icon-btn` next to it copies the issue's
  permalink; both are 32px tap targets with status text (`.icon-status`) beside them, and the
  collapsed Edit section stays as the no-JS path for editing title and body together
  (#clw_01M3946M9S8ZT0HB2DPQD91PYC).
- **Viewport plumbing.** `body` uses `min-height: 100dvh` (not just `100vh`) so mobile
  browser chrome doesn't cause overflow, and scroll containers pair `overflow-x: auto`
  with `-webkit-overflow-scrolling: touch`. Standalone pages that don't import
  `HEAD_META` must still include the
  `<meta name="viewport" content="width=device-width, initial-scale=1">` tag.
- **Page width mechanism.** `PAGE_CSS` sets `body { max-width: var(--page-width) }`,
  where `--page-width` defaults to `64rem` (1024px) on `html` and a page's width tier
  (see "Width tier" above) sets it to `90rem` (`"wide"`) or removes the cap (`"full"`).
  `--chrome-width` is a separate, constant `64rem` that only `nav` and `.warning-banner`
  use (see "Nav alignment" above) — it never changes with a page's content tier.

## Anti-patterns to avoid

- Inter/Roboto/Open Sans/Lato/Arial/bare system-font stacks.
- Purple gradients on white.
- A second competing typeface/colour system introduced alongside these tokens.
- Animating anything a live poller replaces.
- Page-load reveal / entrance animations (fade-in, slide-up, staggered `animation-delay`) on `h1`, `nav`, `h2`, or any page chrome.
- Hard-coding a hex value in a new page instead of referencing an existing `var(--…)` token.
- Desktop-only layouts: raw side-scrolling tables for primary content, hover-only actions, or tap targets below ~30px. Phones and tablets are primary clients, not degraded fallbacks (see "Form factors & responsive"). A nav that doesn't sit in the same place as every other page's nav is also an anti-pattern.
- Swapping a button's `textContent` for a transient in-flight label ("Marking...", "Refined ✓") without first locking its box — on an auto-layout table this changes the button's intrinsic width mid-request and squeezes/re-wraps the whole Actions column, growing every row for a few seconds (#2301). Add `white-space: nowrap` to the column and freeze the button's `minWidth` to its current `getBoundingClientRect().width` before swapping the label in (see `lockWidth`/`unlockWidth` in `src/client/queue.ts`).
- Putting a class that defines its own `::before` (the `.running`/`.idle`/`.paused` status dots) directly on a `<td>` inside a `.data-cards`/`.data-cards-wide` table — the card label is also a `::before`, and the two rules merge into a stretched, colour-filled blob on phone/tablet. Wrap such content in a `<span>` instead.

## Regeneration

Some assets are compiled bundles — never hand-edit the `.generated.ts` output:

- `src/client/session-terminal.ts` → `npm run build:client` → commit
  `src/resources/session-terminal.generated.ts`.
- `src/tailwind.css` → `npm run build:css` → commit `src/resources/tailwind-css.generated.ts`.
