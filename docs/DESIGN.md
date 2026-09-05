# Design Guidelines

**Reference.** Read this when you're touching dashboard HTML/CSS and need the
styling rules — tokens, layout, mobile conventions. For architecture or
backend patterns, see OVERVIEW.md/patterns.md instead.

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

- **Live execution flow** — the `topo-pulse` keyframe on the running-node stroke in
  the topology graph (`src/pages/topology.ts`). This animates because the node
  represents a job genuinely in motion. Status dots (`.running::before`, `.idle::before`,
  `.paused::before`) in `PAGE_CSS` are static and must not animate — the shared
  `.running` class labels steady states such as "Connected"/"Healthy"/"Active" in the
  dashboard Integrations list, so a pulse there reads as noise (issue #2453).
- **Hover/focus feedback on interactive controls** — e.g. `transition: all 0.2s` on
  `.cancel-btn`. Keep these under 0.2s and limited to colour/border properties.

Never animate anything a live poller replaces (`.queue-item`, table rows,
`.data-cards`, or any subtree `src/client/queue.ts` and the dashboard poller re-render
on every refresh) — it would re-fire and flicker on every poll.

## Mobile & responsive

The dashboard is heavily used from phones — often installed as a home-screen PWA
(`HEAD_META` in `src/pages/layout.ts` ships the manifest and `apple-mobile-web-app-*`
meta tags). Treat narrow viewports as a primary target, not a degraded fallback.

- **Mobile-first at 768px.** Base styles in `PAGE_CSS` are the phone layout; desktop
  refinements live in `@media (min-width: 768px)` blocks (larger `h1`, wider padding,
  single-row `.queue-item`). New components follow the same shape: write the narrow
  layout first, enhance upward. Don't introduce additional ad-hoc breakpoints without
  reason — 768px is the shared line.
- **Tables collapse to cards.** Any `<table class="data-cards">` inside `.table-scroll`
  becomes a stack of labelled cards below 768px: cell labels come from `data-label`
  attributes, `.cell-title` promotes a cell to the card heading, `.hide-sm` drops
  low-value columns on phones. New tables must use this pattern — a raw `<table>` that
  only side-scrolls on mobile is not acceptable for primary content.
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
- **Nav is a hamburger on phones.** `.nav-toggle` (CSS-only checkbox) collapses the nav
  links below 768px, and `.nav-favourites` shows mobile-only quick-link pills. Don't add
  nav items that assume the full horizontal bar is visible. The favourites bar is an
  owner requirement (#2131): `/queue`, `/prs`, `/issues` and `/sessions` must stay
  reachable on mobile without opening the hamburger — "leave them in the full menu too,
  just add them to a favourites bar that always shows", so the pills are an addition to
  the nav list, never a replacement for it.
- **The session terminal page hides the nav below 768px.** `buildSessionTerminalPage`
  (`src/pages/sessions.ts`) still renders `buildNav()` and shows it at ≥768px, but a
  page-scoped `@media (max-width: 768px) { nav { display: none; } }` removes the
  hamburger, theme `<select>` and favourites pills on phones (#2771): it is a full-bleed
  xterm.js view where that row costs ~55px of terminal height, and its `← Back` link
  reaches `/sessions`, which has all of them. Its action row (`.session-bar-actions`) is
  `flex-wrap: nowrap` with `overflow-x: auto` so the six controls stay on one line,
  shrinking font/padding below 768px rather than wrapping. This is the single exception
  to the mobile-favourites rule — not a licence to hide the nav on any other page.
- **Touch targets.** Interactive controls need comfortable tap areas — nav links carry
  extra padding and favourite pills a `min-height` for this reason. Don't ship
  tap-only controls smaller than roughly 30px in either dimension, and don't rely on
  hover as the only way to reach an action (see the coarse-pointer
  `@media (hover: none) and (pointer: coarse)` key bar in `src/pages/sessions.ts`).
- **Viewport plumbing.** `body` uses `min-height: 100dvh` (not just `100vh`) so mobile
  browser chrome doesn't cause overflow, and scroll containers pair `overflow-x: auto`
  with `-webkit-overflow-scrolling: touch`. Standalone pages that don't import
  `HEAD_META` must still include the
  `<meta name="viewport" content="width=device-width, initial-scale=1">` tag.

## Anti-patterns to avoid

- Inter/Roboto/Open Sans/Lato/Arial/bare system-font stacks.
- Purple gradients on white.
- A second competing typeface/colour system introduced alongside these tokens.
- Animating anything a live poller replaces.
- Page-load reveal / entrance animations (fade-in, slide-up, staggered `animation-delay`) on `h1`, `nav`, `h2`, or any page chrome.
- Hard-coding a hex value in a new page instead of referencing an existing `var(--…)` token.
- Desktop-only layouts: raw side-scrolling tables for primary content, hover-only actions, or tap targets below ~30px. Phones are a primary client (see "Mobile & responsive").
- Swapping a button's `textContent` for a transient in-flight label ("Marking...", "Refined ✓") without first locking its box — on an auto-layout table this changes the button's intrinsic width mid-request and squeezes/re-wraps the whole Actions column, growing every row for a few seconds (#2301). Add `white-space: nowrap` to the column and freeze the button's `minWidth` to its current `getBoundingClientRect().width` before swapping the label in (see `lockWidth`/`unlockWidth` in `src/client/queue.ts`).

## Regeneration

Some assets are compiled bundles — never hand-edit the `.generated.ts` output:

- `src/client/session-terminal.ts` → `npm run build:client` → commit
  `src/resources/session-terminal.generated.ts`.
- `src/tailwind.css` → `npm run build:css` → commit `src/resources/tailwind-css.generated.ts`.
