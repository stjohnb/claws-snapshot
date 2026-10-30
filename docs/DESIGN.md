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
| `--backdrop` | `rgba(11, 12, 14, 0.7)` |
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
| `--backdrop` | `rgba(28, 26, 23, 0.45)` |
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

The preview modal's dialog and `::backdrop` never transition: they appear and disappear instantly.

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

- **New Session repo pickers** (`/sessions`, `"wide"` tier, no new breakpoint): the single form is a radio chip grid with a leading "Home directory" chip, the multi form a checkbox chip grid; each chip holds the repo avatar inside it beside the visible short name, listed alphabetically by short name (case-insensitive). Chips are 44px tall and two per row on a phone, 32px and auto-width wrapping from 768px (tablet and desktop). The `.check-grid` rules live in `CHECK_GRID_CSS` in `src/pages/layout.ts`, shared with the New Issue form.

- **Long previews open in an overlay modal, not inline.** A long block peeked from a list or card (a plan, a requirements record) is a `<details class="preview-peek …">` whose summary opens the page's single `PREVIEW_MODAL_HTML` dialog (`src/pages/layout.ts`, driven by `PREVIEW_MODAL_SCRIPT`) instead of growing the row. The modal holds a heading, rendered markdown and one link, nothing else. Without JS (or without `<dialog>.showModal`) the `<details>` expands inline. On a phone it is full width with 1rem gutters and a scrolling body; on tablet and desktop it is a centred box capped at 56rem. It has no open/close animation. A long Blocked reason on a Board card is such a peek, titled "Blocked reason" via `data-preview-title`.
- **The Request image gallery on `/issues/:id`.** When the request embeds more than 3 images, each is a `.md-thumb` thumbnail (max 5rem tall) linked to its full-size file, and a run of more than 3 image-only paragraphs folds into a closed `<details class="image-gallery">` whose 44px summary reads "N images"; opened, the thumbnails wrap in a flex row. The page keeps the default 64rem width tier and the layout is the same on phone, tablet and desktop. No new breakpoint.
- **The Blocked callout on `/issues/:id`.** A Blocked issue's recorded reason is a `.warning-banner` (`#issue-blocked`) directly under the issue head, full width in the single page column on every tier; long reasons clamp to 3 lines and expand in place.
- **The History block on `/issues/:id`.** The last section before the Permalink line, a collapsed `<details id="history">` with the entry count, in the single page column on every tier (the page keeps the default 64rem width tier). Each entry is a `<li>` of `ol.history-list` separated by a `--border` rule: a `comment-head` meta line (relative time, actor) above the change text, wrapping with `overflow-wrap: anywhere`. A body change nests its previous and new text in a `<details>` whose `<pre>` scrolls horizontally inside the block, so the page never side-scrolls on a phone.
- **The combined comment box on `/issues/:id`.** Comment, the one-click status buttons and the "Comment and …" buttons share the form's `.form-actions` flex row, in the default 64rem width tier. On a phone they wrap onto several 40px-tall rows; on tablet and desktop (the existing `@media (min-width: 768px)` rule) one wrapping row of 30px buttons. No new breakpoint.
- **The Blog status chips and filter bar.** `/blog` keeps the default 64rem width tier with no new breakpoint. Each post is a row followed by its draft sub-item rows (`.blog-sub`: saved drafts, open PRs, slug-colliding repo files), whose File cell is indented 1.5rem and prefixed ↳. On a phone every row is a `data-cards` card, with the sub-item cards following their post and their title indented inside the card; the status chips wrap inside the Status cell, the View diff / Edit / Discard actions (30px tall, Discard an outlined `--danger` button behind a native `confirm()`) wrap in the Actions cell, and the All / Drafts `.filter-bar` chips wrap above. On tablet and desktop it is a 4-column table (File, Status, Last edited, Actions). A stale saved draft carries an outlined `--warning` Stale chip. `/blog/diff` is a single column at the same tier: a `.warning-banner` when stale, the action row, then a monospace line diff that scrolls horizontally inside its box, `+` lines tinted `--success` and `-` lines `--danger`. The editor shows a stale draft's `.warning-banner` above a wrapping action row on every tier.
- **The Sessions Repo / Dir cell.** `/sessions` stays the `"wide"` tier with no new breakpoint. Each session's repos are one wrapping `.session-repos` row of repo avatars: 36px icons as the title of the Active card (and under the History card heading) on a phone, 30px icons as the card heading on a tablet, and a 30px row capped at about 12rem wide in the table cell on desktop. A single-repo session adds the visible short name; a directory-only session keeps its `<code>` cwd.
- **The Sessions Switch account control.** `/sessions` stays the `"wide"` tier with no new breakpoint; the session page (`/sessions/:id`) carries no account control. An Active row whose agent runs on a Claude account shows the account label (`.session-account`, `--text-secondary`, 0.8rem, "Account unknown" when unrecorded) under the agent in the Agent cell and as an **Account** line in the phone details body, and a swap-arrows `.session-switch-account-btn` icon button before End in a wrapping `.session-row-actions` row, its `aria-label`/`title` naming the current account, or disabled with the reason when no other account has a token. A failed switch fills the row's `.session-switch-error` (`role="alert"`, `--danger`, wrapping with `overflow-wrap: anywhere`, full width of the actions row, at most 16rem). On a phone (card) Switch and End sit side by side at 36px in the card's action corner with the error wrapping under them; on a tablet (card) and desktop (table, from 1024px) the same 30px pair sits in the Actions column and the account label shows under the agent.
- **The Backlog return date on `/issues/:id` and `/backlog`.** On the issue page an optional **Until (optional)** `<input type="date">` with a visible label sits beside **Send to backlog** in the comment box's `.form-actions` row, and while the issue is in the Backlog the Status section's pill reads "Backlog · returns YYYY-MM-DD" above a small form (labelled date field, **Save**, and **Clear return date** once one is set); the page keeps the default 64rem width tier. On a phone each date field takes its own full-width 40px row (`.backlog-until-field`, `flex-basis: 100%`) like the other controls; on tablet and desktop it sits in the single wrapping row at 30px. On `/backlog` (`"wide"` tier) one flat table of nine columns (Select, Issue, Repository, Title, Labels, Created, Updated, Returns, Actions) holds every row, with no per-repository headings; the **Returns** column (`data-label="Returns"`) holds a native row's date field, **Save** and **Clear** (forge rows show "—"), and Repository, Title, Created, Updated and Returns headers are sort links (▲/▼ on the active one). It takes `data-cards-wide`, so it is cards on phone and tablet and a table from 1024px; the filter form's fields (Repository, Label, Author, Title contains, Sort, Direction) stack full-width on phone and sit in one wrapping row from 768px. The board's Backlog tray summary appends "· next returns YYYY-MM-DD". No new breakpoint.
- **The per-comment Delete on `/issues/:id`.** Each comment's `comment-head` line ends with a small `--danger` outlined **Delete** button (`.comment-delete`, at least 30px tall, `aria-label="Delete comment"`) guarded by a native `confirm()`; the page keeps the default 64rem width tier. On a phone it wraps to the end of the `comment-head` line when the author and time leave no room; on tablet and desktop it is right-aligned on that line.
- **The New Session forms' Initial prompt.** On `/sessions` (still the `"wide"` tier) both New Session forms end with an optional Initial prompt `<textarea>` (`.initial-prompt-field`, 4 rows, vertical resize) as a full-width row (`flex-basis: 100%`, no 22rem cap) just above the Create button on phone, tablet and desktop alike. Like the Agent field, the single-repo form's greys out (`data-agentless`) and is disabled in "zsh in repo" mode. Under the textarea, inside the same full-width `.initial-prompt-field`, sits the attach row (`.session-attach`, revealed by the page script): an **Attach files** `trigger-btn` with a hidden multi-file input and a `role="status"` line for progress and rejections (with a Dismiss button), then a wrapping `.session-attachments` row of chips (name, size, × remove). It is full width under the textarea on phone, tablet and desktop; the button and chips are 40px tall on a phone and 30px from 768px (the × a 40px / 30px wide target). Each form is a drop target showing the terminal's dashed `--accent` drop overlay (`.attach-drop-overlay`) over the form while files are dragged onto it. In "zsh in repo" the single-repo form's attach row greys out and is disabled with the prompt. `/sessions` stays the `"wide"` tier; no new breakpoint.
- **The session page maximise toggle.** The page stays the `"full"` tier with no new breakpoint; the toggle is a sticky first `.kb-key` in `#mobile-keybar`. On a phone (keybar keys at the 768px size) and on a tablet (coarse pointer or ≤900px), maximised shows only the terminal, the keybar and the notices layer over the terminal's top edge. On a wide desktop with a fine pointer there is no keybar and no toggle.
- **The session page Files row.** Collapsed, it is a single 30px header row (`Files (N) ▸` plus the new-file hint) on every tier, so the terminal keeps the phone height. Expanded, it is 44px-tall full-width file rows on a phone and 30px chips that wrap onto as many rows as needed from 768px, inside a vertical scroll box capped at 7rem (about three rows). Chips shrink to at most `min(24rem, 100%)`; the name truncates with an ellipsis (full name in its `title`) while size, time, Latest and Download stay visible. The row never scrolls sideways.
- **The Create Session button on `/issues/:id`.** The page keeps the default 64rem tier. The button is a `.form-actions` row (`#issue-start-session`) under the title row inside `.issue-head`, on phone, tablet and desktop alike, 40px tall on phone and 30px from 768px. A failure appears in an inline `role="alert"` `.icon-status-error` beside it; while creating, the button is `disabled` with `aria-busy="true"` and reads "Creating…". No new breakpoint.
- **The board card's Start session button.** Every native card on `/board` (still the `"full"` tier) has a `.board-start-session` icon button — the `>_` glyph, no text — in the `.board-actions` row beside the Move to… select, under the card's approval track, on every tier: a 36px square on a phone and 30px from 768px (the existing `@media (min-width: 768px)` block). No new breakpoint. Its `aria-label` and `title` carry the action; while the request runs it is disabled with `aria-busy` and the title reads "Starting…"; a refusal shows in `#board-status`. A success does not navigate: the button is swapped in place for the same `.board-go-to-session` link and `#board-status.board-ok` (success colour) reads "Session started for #REF · Go to session". While the issue's board-started session is live the same slot holds a `.board-go-to-session` icon link (arrow-into-box glyph, same square sizing on every tier) to that session instead.
- **The approval strip and actions on board cards and `/issues/:id`.** `/board` stays the `"full"` tier and `/issues/:id` the default 64rem tier, with no new breakpoint. Each carries one `.approval-track` (`src/pages/approval-track.ts`), the same on phone, tablet and desktop. **The strip** is `ol.approval-steps`: three `li.approval-step` items — **Reqs**, **Plan**, **Merge**, in the display font at 0.7rem — each a 10px round `.approval-dot` followed by its label, joined by thin `li.approval-line` rules (`role="presentation"`), with no boxes, segments, click handler, button semantics or `disabled`. The dot's shape carries the state and colour only reinforces it: approved is a filled `--accent` dot; pre-approved an `--accent` ring with a faded `--accent` centre and an `--accent` label; the next stop a dashed `--success` ring with its label bold in `--text` and `aria-current="step"`; a partial merge approval a half-filled `--warning` dot; an open step a `--border-hover` ring with a `--text-subtle` label. The line after an approved step carries `data-done` and is `--accent`, otherwise `--border-hover`. Each step's `aria-label` and `title` state its state only. **The Stops at line** (`p.approval-stops`) sits under it in the body font at the card's 0.7rem chip size (0.8rem on the issue page), `--text-secondary` with the gate or stop name bold in `--text` — "Stops at **plan review**", "Stops at **operator step** on fleet-infra#409" — and the whole line in `--warning` (`.warn`) for an unplanned stop and `--success` (`.go`) for "**Runs to merge** — no further stop". **The action row** (`.approval-actions`), only where the operator can act, is one wrapping flex row. Its `.approval-group` fills the row: a filled `button.approval-primary` (`--accent` background, `--bg` text, weight 600) labelled with the next gate's verb phrase only — "Approve requirements", "Approve plan", "Approve merge" — and, attached to its right edge with shared borders, one outlined `--accent` `button.approval-further` per further approval from that gate, labelled cumulatively "& plan", "& merge", each carrying the full-effect sentence ("Approve requirements and pre-approve plan", "Approve requirements, plan and merge — no further stop", "Approve plan and merge — no further stop") as both `title` and `aria-label`. In Planning, where nothing is filled because there is no gate the issue waits on, "Pre-approve plan" leads the group outlined under its full label with "& merge" attached; filled stays reserved for the gate the issue is waiting on. Withdrawals never share the group: beside a group they live in a ⋯ icon button (`details.approval-menu` > `summary`, `aria-haspopup="menu"`, `aria-expanded`) to the right of it that opens a popover `ul[role="menu"]` of `button[role="menuitem"]` entries in `--danger`, each stating its whole effect with a `--text-subtle` `<small>` detail, bordered in `--border-hover` with no shadow. It is a `<details>` so it opens without script; `src/client/lib/approval-menu.ts` keeps one menu open at a time, focuses the first item on open, moves with ArrowDown/ArrowUp/Home/End, closes on Escape (back to the ⋯ button), Tab and an outside pointer press, and an open menu holds off the board poller. The open list is placed `position: fixed` from the ⋯ button (right edges aligned, inside the viewport, flipped above when there is no room below) so a board column's scroll box cannot clip it, and a scroll or resize outside it closes it. With nothing to approve, each withdrawal is a plain outlined `button.approval-plain` (`--border-hover`, `--text`) filling the row. Every clickable control is an `.approval-act` button with `data-gate` and `data-action`, posting `{repo, ref, gate, withdraw}` to `POST /board/approve-through`. No label is truncated with an ellipsis: on a card too narrow for group and ⋯ together the row wraps the group as a whole, and the primary's own label wraps inside it before anything overflows; where the action row is under 18rem wide (a `container-type: inline-size` query on `.approval-actions`, so a 13rem desktop column and a tablet card both qualify) the group itself breaks into two rows, the lead full width on top and the attached further approvals sharing the row under it with shared borders; nothing an operator needs is only in a `title`. Controls are 36px tall on a phone and 30px from 768px on the board (the existing `@media (min-width: 768px)` block, the ⋯ button square), and on the issue page, in the Status section under the column pill, at most 24rem wide and 40px tall on every tier to match the page's buttons. In Drafting, Blocked, Backlog and Done, and on a card awaiting import, there is no action row: the strip and the Stops at line alone show the state. On a card the track sits full card width between the chips/preview and the `.board-actions` row. While a request is in flight the track is `aria-busy` with every `.approval-act` disabled, the ⋯ button inert and the row dimmed; a refusal shows in `#board-status` on the board and as a `role="alert"` `.approval-error` line under the track on the issue page. Tokens only, so light and dark follow the theme. The strip was a row of clickable gate buttons until #clw_01M5X4HY4YC56Y6VEMK12P2QR7, whose effect lived only in a tooltip touch never shows; it became the dots-and-lines strip with a filled primary in #clw_01M61A4P3N7D76P1JR2HW5WNN5 because, on the operator's 2026-10-28 review, the boxed segments still read as a clickable segmented control, the More… select read as a form field stacked on top of the Move to… select, the next gate was stated three times (dashed segment, Stops at line, button label) across four or five rows of chrome per card, and with every control a one-pixel accent outline nothing on the card was primary.
- **The PR row's Start session control.** `/prs` stays the `"wide"` tier. Each row's `.action-secondary` group ends with a **Start session** `refined-btn pr-start-session` button (text from 768px, the `>_` icon on a phone; see the `/prs` phone card bullet), or, while that PR's PRs-page session is live, a **Go to session** `refined-btn pr-go-to-session` link styled the same; both carry `title` and `aria-label` naming the PR. On a phone the row is a compact card (`prs-compact`) and the control sits in its one wrapping action row with the other buttons, 36px tall; on tablet the row is still a card (`data-cards-wide`) and from 1024px a table row, and on both the control is the compact padded `refined-btn` stacked in the Actions column. The link is centred and never underlined so it reads as the same button. While the request runs it is disabled with `aria-busy` and its title reads "Starting…"; a refusal appears as a `.merge-error` span after it reading "Could not start session: …", as a failed merge does. A success does not navigate: the control is swapped in place for the Go to session link, followed by a `.session-started` span ("Session started", success colour). No new breakpoint.
- **The infra PR line on board cards.** `/board` stays the `"full"` tier with no new breakpoint. Under each open infrastructure PR's link — in the Awaiting merge card's `ul.board-prs`, and in a `ul.board-prs` listing only the infra PRs on In progress and Blocked cards — a `.board-infra` block takes the full card width on phone, tablet and desktop: a wrapping `.board-infra-summary` line ("Plan: 1 addition, no changes, no deletions", or "Plan summary unavailable for the current head: …") in `--text-secondary`, with deletions and replacements in `.board-infra-destroy` (`--danger`, weight 600), then either the approval state line or a `.board-infra-approve` button: an outlined `--danger` `trigger-btn`, 36px tall on a phone and 30px from 768px (the existing `@media (min-width: 768px)` block). While the request runs it is disabled with `aria-busy`; the server's re-rendered line replaces the block in place, `#board-status.board-ok` confirms with a link to the PR, and a refusal shows in `#board-status`.
- **The Queued column on `/board` and the Queued callout on `/issues/:id`.** `/board` stays the `"full"` tier and `/issues/:id` the default 64rem tier, with no new breakpoint. Queued is a derived column of the Building group, after In progress: on a phone it stacks inside that group and starts folded, counted in the group header's "set by Claws" count; on a tablet it sits side by side with Approved and In progress in the Building group; on desktop it is one more column in the horizontal group row. Its cards carry the same `.board-blocked-reason` excerpt as Blocked cards — a long one a preview peek titled "Waiting on" — and no "Needs a human" chip; the Stops at line reads "Stops at **Queued** — waits on other work" in `--warning` like every unplanned stop. On the issue page a Queued issue shows a `.banner.blocked-callout` (`id="issue-queued"`, the neutral `--banner-bg`/`--banner-border` banner, not `.warning-banner`) headed "Queued — waiting on other work" with the reason in the same clamped/peek layout as the Blocked callout.
- **The Awaiting merge card's PR list** is a stacked `ul.board-prs`, full card width on every tier, with wrapping titles and hold lines clamped to two lines and expandable when long. There is no new breakpoint and `/board` stays `"full"`.
- **The New issue modal reuses that frame.** `buildNewIssueModal` (`src/pages/issue.ts`, driven by `NEW_ISSUE_MODAL_SCRIPT`, styled by `NEW_ISSUE_MODAL_CSS` in `layout.ts`) is a second `<dialog class="preview-modal new-issue-modal">` with its own ids, opened by the **New issue** button in `/board`'s toolbar and on `/issues`. It holds the full New issue form in the scrolling body, so it has the same sizing: full width with 1rem gutters on a phone, a centred box capped at 56rem on tablet and desktop, and no animation. Opening it focuses Title; closing it (close button, Cancel, Escape, backdrop) returns focus to the button and keeps what was typed. Without JS (or `showModal`) the button is a link to `/issues/new`. Neither page's width tier changes.
- **The Capacity block on `/status`.** `/status` keeps the `"wide"` tier with no new breakpoint. The Agent Queue `.meta` grid gains a **Capacity** row (`#queue-capacity`): "7 of max 12 (min 2) · k3s lane 5 · off-node lane 2" under `k8s-pod`, "fixed: N fibers" under `in-process`, and "fallback: minimum 2 — <error>" in `--warning` when the node read failed; the 10 s refresh updates its text only. Below the grid a closed `<details id="queue-capacity-nodes">` ("Per node") holds a `.table-scroll` six-column `.data-cards` table — Node, Ready, Lane, Allocatable, Requested, Slots (GiB to one decimal) — labelled cards on a phone and a full-width table from 768px on tablet and desktop.
- **The OpenCode spend card on `/usage`.** `/usage` keeps the `"wide"` tier with no new breakpoint. A fourth `.stat-card` (`#opencode-spend`, "OpenCode API spend (all time, reported)", "$X of $T warning") joins the summary `.stat-grid`, a wrapping flex row: on a phone it wraps onto its own line under the other three, and on tablet and desktop it sits in the same row. Its number turns `--warning` once spend reaches the threshold.
- **The `/retro` page.** `/retro` takes the `"wide"` tier and adds no new breakpoint. It
  opens with one page-level `.meta` grid under the intro, holding the fleet-wide Untriaged
  `N/50`, Next retrospective (a date) and Past retrospectives (wrapping `#clw_…` links).
  Below it is one `section.retro-repo` per managed repo, separated by a `--border` rule,
  with the repos holding the most notes first. Each section has a heading (repo avatar and
  name) and the notes. The notes are a wrapping row of
  `.retro-chip` category counts (0.7rem, 12px radius, 1px outline) followed by a
  five-column `.data-cards` table: Date, Category, Note (the card title), Reference and
  Source.
  - **Phone:** each section stacks in a single column, the chips wrap, and every note is
    a labelled card.
  - **Tablet and desktop:** from 768px the notes are a full-width table, with no
    `data-cards-wide`, since five columns fit.
  - **Empty repo:** a repo with no notes shows a single "No notes" line instead of the
    chips and table.

- **The `/alerts` page.** `/alerts` takes the `"wide"` tier, is listed in the nav's More
  menu after Status, and adds no new breakpoint and no nav badge. An intro line is
  followed by one six-column `table.data-cards.data-cards-wide`: Alert (the card title,
  linking to `/issues/<id>`), Repo (repo avatar and short name), Opened, Occurrences, Last
  seen and Status. Status is a `.alert-status` chip (0.7rem, 12px radius, 1px outline):
  "Needs you · <column>" outlined in `--warning`, or "Automatic · <column>" in
  `--text-subtle`, with a Blocked alert's first reason line in `--text-secondary` under
  it. Rows needing the operator come first.
  - **Phone and tablet:** every alert is a labelled card (`data-cards-wide` keeps cards
    through 1023px), titles wrapping with `overflow-wrap: anywhere`.
  - **Desktop:** from 1024px a full table.
  - **Empty:** a single "No open alerts" line instead of the table.

768px and 1024px are the only sanctioned breakpoints; don't add a third without a
documented reason. The nav is the same single bar on every tier.

- **Width tier (required decision).** A page whose primary content is a table, list or
  grid passes `"wide"` (or `"full"`) to `htmlOpenTag(theme, width)`; the 64rem default is
  for prose, forms and detail pages. `"wide"`: `/status`, `/prs`, `/issues` (both rendered by
  `lists.ts`), the `/sessions` list, `/usage`, `/dmarc`, `/jobs`, both `/logs` detail pages
  (`/logs/:id` and `/logs/issue`), `/backlog`, `/retro`, `/alerts` and `/repos/:name`. `"full"`: `/board` and the session
  terminal. `/` is a redirect to `/board` and renders no page of its own. Default (64rem):
  `/config`, `/damp`, `/issues/:id`, `/issues/new`, `/whatsapp`,
  `/blog`, `/reauth`, the error page. `body { max-width: … }` in a page's
  own stylesheet is an anti-pattern — a page with a genuinely bespoke width sets
  `--page-width` on `html` directly instead.
- **Nav position.** `.warning-banner` fills `body`, so it shares the page's
  `--page-width`. `nav` does not: it has the constant `--chrome-width`, so it sits in the
  same place on every tier (see "The bar sits in the same place on every page" below).
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
  columns, under a `.filter-bar` chip row — All / Dependencies / Other / Blocked with counts — that wraps on phone width) and the four `src/pages/usage.ts` tables with nine or ten columns use
  `data-cards-wide`; the six-column `/usage` signals table does not, since it fits. The
  sessions tables (`src/pages/sessions.ts`, nine columns) were the original case (#3229).
  The Capabilities cell also caps at two lozenges plus a `+N` overflow pill (title lists
  the rest) to keep rows from stacking one pill per line.
  On phone only, the Active Sessions table also takes `sessions-compact`: a grid card
  (repo title link + icon End, status, one-line summary; no ID) with agent, usage, capabilities and
  created behind a `<details>`. History and tablet keep the standard `data-cards-wide` cards.
  The active session card: the title is an accent `session-title-link` and the rest of the row (outside links, buttons and the details) also opens the session; End is an icon-only 36px button (30px from 768px) with `aria-label`/`title` "End session". Phone is the grid, tablet the stacked `data-cards-wide` card with End in the actions cell, desktop the table row.
- **/prs filter form and sort.** `/prs` opens with one `.prs-toolbar` row: the icon-only Refresh button (36px square on a phone, 30px from 768px; `/issues` shares it), the Dependencies/Other/Blocked chips (the active one links back to `kind=all`) and a GET `.list-filters` form (shared with `/backlog` via `src/pages/list-filters.ts`) whose selects are compact. Filters are added on demand: an **Add filter** select (no `name`, never submitted) lists the attributes with no value; choosing one sets a local Alpine `pending` state that reveals that attribute's `.prs-filter` row (label, value select whose empty option reads "Any", and a ✕ button that clears `pending`). A row whose attribute has a value is always visible and ends with a ✕ link to the address without that key. Hidden rows still submit empty values, and a `<noscript>` style shows all six rows plus the Filter button. Value, Sort and Direction selects submit on change. The Clear-filters ✕ is an SVG cross in a square icon button (36px on a phone, 30px from 768px, same as Refresh and the row remove buttons; `a.trigger-btn.prs-clear` forces `inline-flex` so it centres) at the right end (`margin-left: auto`). On a phone each visible filter row is full width (label, growing select, 36px ✕) and Add filter, Sort and Direction are full-width 36px selects; from 768px everything is 30px high in one wrapping row with selects capped at 9rem. The toolbar wraps on every tier because the number of controls varies; no new breakpoint. The ✕ links to `/prs?kind=all` (keeping only Sort and Direction) so it clears every filter; there is no All chip. The Repo, Title, Author, Updated, Created and Checks headers are sort links (▲/▼ on the active one). A `Created` column (`hide-sm`) follows Updated; while the sort is `created` the table takes `prs-sort-created` and the phone card's age pill shows Created instead of Updated. A draft PR carries a neutral `Draft` chip. The width tier stays `"wide"`.
- **/prs phone card.** On phone only, the `/prs` table also takes `prs-compact`, and its card reads as a sibling of the `/board` card. A head line holds the repo avatar, `repo#N` in the display font, and a `.board-age`-style age pill. The title follows, then one `.pr-chips` row in board chip sizing (0.7rem, 12px radius, 1px outline): category, skip, infra, merge-blocked and awaiting-approval badges, plus phone-only checks, review, Conflicts, Escalated and Approval-exempt chips. Each chip appears only when it has a value. The attention reasons, manual warning and dispatch note fold into one "Needs you" chip (neutral "Waiting" when there is only a dispatch note), a `preview-peek` that opens the preview modal. The duplicates are hidden on phone: the `CI Failing` category badge, the Checks and Review rows, the `.needs-you`, `.manual-warning` and `.dispatch-note` lines, and the actions-area status label, escalation note and Approval-exempt span. The actions are a 3-column grid (`repeat(3, minmax(0, 1fr))`, equal-height rows, 44px minimum) of icon-over-label buttons in fixed slots, so the same action sits in the same cell on every card and empty slots stay empty. Row 1: Squash & Merge (or `⚠ Merge infra`), Automerge, Start/Go to session. Row 2: Prioritise/Deprioritise, Skip/Restore, Clear manual action. Unmark problematic takes a full-width third row only when present. Every button holds a `.pr-icon` (phone only) above an always-visible `.pr-label` (0.65rem, wraps to two lines), so nothing relies on hover or an accessible name. Icons: Start session `>_`, Go to session the board's arrow-into-box, Automerge a bolt, Squash & Merge git-merge, Prioritise/Deprioritise arrow up/down, Skip/Restore skip-forward/rotate-ccw (both icons render and the `deprio`/`unskip` class picks one), Clear manual action a check-circle, Unmark problematic a flag, Merge infra `⚠`. An outcome the operator must read (`Error`, `Retry Merge`, `Merged!`) adds `pr-label-visible` and simply replaces the label text. A set Automerge is an outlined green `Automerge ✓` (the tick follows the label), not a filled block. Under `(hover: none)` the green/red hover fill is suppressed so a tap does not leave a button filled. The CI chip uses the Checks-cell glyphs (`✔ ✘ ○ ⏸`) with the `n/n` count kept, Reviewed is an eye and Merge blocked a ban icon, each a `role="img"` chip with `aria-label` and `title`; chips that carry a count or reason (category, issues found, Conflicts, Escalated, Approval-exempt, Needs you/Waiting) keep text. Tablet keeps the `data-cards-wide` card and desktop the table, unchanged; no new breakpoint.
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
  | `/blog` | 1 | File | none (sub-item rows are indented cards) |

- **Per-page behaviour.** List/table pages (PRs, issues, sessions, usage, dmarc, jobs):
  cards on phone, a full-width table or `data-cards-wide` cards on tablet, the `"wide"` tier on desktop. Detail pages:
  `/issues/:id` renders at the default tier — it's prose (title, body, comments), not
  a grid — with a `.meta` grid for metadata and any table inside using `.data-cards`;
  `/logs/:id` and `/repos/:name` are single-item pages too but take the `"wide"` tier
  like their list-page siblings (`/repos/:name` holds several tables of its own, and
  `/logs/:id`'s pre-formatted `.log-output` reads better with the extra width), and
  both still use the `.meta` grid and cards-based tables. Forms (`/config`, `/damp`,
  `/issues/new`): single column below 768px, a two-column grid above. `/board`: groups
  stack below 1024px, and columns stack as `<details>` below 768px (see below). The session terminal: the nav shows on
  every tier, compact mode only trims vertical spacing (see below). `/jobs`: the job-status table is `data-cards-wide` cards on phone
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
- **One nav layout on every tier.** `buildNav` (`src/pages/layout.ts`) renders the same
  single bar on phone, tablet and desktop: `.nav-bar` (`display: flex; flex-wrap: nowrap`)
  holds `.nav-pinned` — the three pinned links Board, PRs and Sessions
  (`PINNED_NAV_LINKS`) — then the More menu and the avatar menu together at the right.
  No tier switches to a different arrangement, the bar never wraps, and there is no
  wordmark in it: `buildPageHeader` renders a standalone `<h1>claws</h1>` only with
  `showNav: false` (the login page).
- **Each destination appears exactly once.** `.nav-more` is a CSS-only `<details>` whose
  absolutely positioned `.nav-more-panel` (anchored `right: 0`, `z-index: 20`, like the
  profile panel) lists only the twelve other destinations (`MORE_NAV_LINKS`: Issues, Status,
  Backlog, Retro, Jobs, Usage, Damp, DMARC, Blog, WhatsApp, Reauth, Config). Pinned links are
  never repeated in it, and opening it overlays the page rather than reflowing the bar.
  Its `<summary>` (`aria-label="More"`) is a burger SVG on a phone and the SVG plus a
  visible "More" label from 768px. More and the avatar can be open at the same time; no
  JS closes either on an outside click.
- **Pinned links are ordinary nav links.** Every nav link shares one style — accent text,
  `inline-flex`, 30px tall, `white-space: nowrap`, no border, radius or background — so the
  pinned three don't read as a separate widget. Don't reintroduce bordered pills.
- **The current page is marked on the server.** Each page passes its section href as
  `buildPageHeader(title, theme, { current })` (or `buildNav(theme, current)` on the
  session terminal); that link gets `aria-current="page"`, styled `color: var(--text)` with
  a 2px `var(--accent)` bottom border. When the page is inside More, the More `<summary>`
  is marked too. Pages that aren't a nav destination (`/repos/:name`, `/logs/*`, the error
  page) pass nothing.
- **The bar sits in the same place on every page.** `nav` is capped at the constant
  `--chrome-width: 60rem` (the default tier's content width) and centred with
  `margin-inline: auto`; it never reads `--page-width`. At a given viewport width the
  pinned links, More and avatar are at the same x positions on default, wide and full
  pages. `html { scrollbar-gutter: stable; }` keeps the centre from shifting by a
  scrollbar's width between pages that scroll and pages that don't. On a large monitor
  the bar is therefore a centred 60rem strip and does not line up with wide or full
  page content.
- **On a phone, the whole bar fits one line.** Below 768px nav text is 0.8rem with
  0.02em letter-spacing, nav links have no horizontal padding (0.1rem from 768px) and
  the pinned gap is 0.45rem (1.25rem from 768px). At a 360px viewport (328px inside the
  1rem body padding) the 16 pinned characters, gaps, the 30px More icon and the 32px
  avatar come to roughly 220px; the worst realistic badges (`99+/99+` on Board and PRs and a
  one-digit Sessions count, 15 characters at about 6.2px) add roughly 94px plus three 0.2rem
  margins (about 323px in all; a `99+` Sessions badge adds about 12px and still fits). Don't
  raise the phone font, gaps or padding beyond the values in
  `src/pages/layout.ts`; the failure mode is overflow, not wrapping.
- **Board and PRs carry an attention/total count; Sessions carries its active count.** Pages pass the counts as
  `buildPageHeader(title, theme, { current, navCounts })` (or the third argument of
  `buildNav` on the session terminal); the error and login pages pass none. The Board and PRs
  badge reads `attention/total` (e.g. `3/12`): items waiting on the operator, then all open
  issues on the board or all open PRs. It renders after the label as `<span class="nav-count" aria-hidden="true">` in
  `var(--text-subtle)` (`var(--text-secondary)` on the current link), 0.65rem with a
  0.2rem left margin below 768px and 0.75rem with 0.3rem from 768px, like
  `.filter-count`. Each number is capped independently at `99+` (`3/99+`). The badge shows
  whenever the total is above zero, so `0/5` appears; it is hidden when the total is zero or the
  counts could not be read — no badge, no aria-label. The link's `aria-label` ("Board, 3 of 12
  issues need attention", "PRs, 1 of 4 needs attention"; singular "issue" when the total is 1)
  always carries the exact numbers, so the counts are never conveyed by the badge alone.
  Sessions shows only its active count, when above zero ("Sessions, 2 active"). No other nav
  destination carries a count.
- **`/prs` flags operator-waiting PRs with a "Needs you" line.** A `.needs-you` block line in the Title cell (same style as `.manual-warning`) lists the reasons from `prAttentionReasons` (`src/pr-attention.ts`), the predicate behind the nav PRs count; the Blocked chip filters the list to the same predicate. On a phone card the line is hidden and the same reasons sit behind the "Needs you" chip in the chip row, which opens the preview modal; from 768px the line sits under the title on the tablet card and in the table row; the page stays in the `wide` tier.
- **Theme and Logout live behind the avatar.** `.nav-profile` is a CSS-only `<details>`
  whose `<summary>` is a 32px circular button — a generic silhouette SVG, not the
  signed-in user's picture (the session cookie carries only an OIDC `sub`, no image URL)
  — with `aria-label="Account menu"`. Its absolutely positioned `.nav-profile-panel`
  holds the theme `<select>` and the Logout link, so opening it never reflows the nav.
  It sits immediately after More at the right end of `.nav-bar`.
- **The session terminal page shows the same nav as every other page.** `buildSessionTerminalPage`
  (`src/pages/sessions.ts`) renders `buildNav(theme, "/sessions")` on every tier as the same
  centred `--chrome-width` bar, inside `header.session-nav`, whose 1rem (2rem from 768px) inline
  padding stands in for the body padding the page removes, so the links sit at the same x
  positions as on other pages. It keeps `scrollbar-gutter: stable`, so on classic-scrollbar
  browsers the terminal column is one gutter narrower. Outside compact mode the wrapper's 2rem top
  padding and the nav's 1.5rem bottom margin match other pages; the compact media query (#2771,
  #3191) trims only the vertical spacing to one ~40px row with a full-bleed border, the one
  documented vertical difference. Opening More overlays `#terminal` rather
  than shrinking it. Its action row (`.session-bar-actions`) is `flex-wrap: nowrap` and never wraps; there is no Back
  link (the nav's Sessions tab is the route back). Below 768px it is a single non-scrolling line
  (`overflow: hidden`): 30px icon buttons for Paste, Copy and Attach (SVG plus `aria-label`/`title`),
  a compact Record, a flexible, truncating capability select, "Grant" and Revoke. From 768px it is the
  word-labelled row with `overflow-x: auto`. From 768px the bar is `.session-bar-main` (title, repo path and every control) and the Files line; below 768px both stack as before. Every notice floats in `.session-notices` under the bar, full width on phone, tablet and desktop, capped at half the viewport, with pointer-through bodies, so none resizes the terminal.
- **Touch targets.** Interactive controls need comfortable tap areas — nav links and the
  More control carry a 30px `min-height` for this reason. Don't ship
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
  mobile-first like everything else here. Its toolbar holds the heading, the repository
  filter and the **New issue** button, wrapping on a phone. Its nine columns sit in three
  `<section class="board-group">`s — Shaping (Drafting, Requirements review,
  Planning, Awaiting plan review — four wide), Building, Landing, each headed by an
  `<h2 class="board-group-head">` with a card count — with Blocked in a fourth
  single-column `board-group-solo` section between Building and Landing, whose
  heading shows from 768px so its column lines up with its neighbours and is hidden
  on a phone, where the folded column header already names it. The toolbar's
  Repository select is content-sized (10–20rem) and applies on `change`; the
  Filter button stays for the no-JS path. Human-gate columns (`.board-col-gate`) carry an
  accent `◆` before the title; derived ones and Drafting (`.board-col-derived`,
  the columns Claws moves cards into) have a subtle header, and the derived ones
  a hint saying Claws sets them. Below 768px (phone) the groups stack
  and each column is a full-width `<details class="board-col">` with the header as
  its `<summary>`, so the operator scrolls down through columns rather than
  sideways through one wide row; the group header adds the count of cards in its
  folded Claws-set columns — Drafting and the derived ones (`.board-group-derived`, phone only; Awaiting merge waits on the operator, so it is not counted). From 768px (tablet) the
  groups still stack but each group's columns (four at most) sit side by side;
  from 1024px (desktop) the whole board is one horizontally scrolling row; each group keeps `min-width: min-content` so its columns never spill under a neighbouring group, and the row scrolls rather than squeezing once the columns reach 13rem. A collapsed desktop column is a fixed 9rem and a collapsed tablet column sizes to its header, so no column takes the phone's `width: 100%`. From 768px an open column's card area (`.board-col-body`) scrolls within itself while its header stays put: on desktop that area is sized to the viewport (the client sets `--board-body-top`) so the page, the group heads and the other columns stay put, and on tablet it is capped at the viewport height; the phone layout is unchanged, and the poller restores each column's scroll. The
  client (`src/client/issue-board.ts`) folds every column without `data-waits="true"`
  (the server marks `requirements-review`, `awaiting-plan-review` and `awaiting-merge`) on load on
  a phone and reopens whichever column a card moves into; the `Move to…` `<select>`
  (Closed and Backlog only) and the card's approval buttons and ⋯ withdrawal menu, not drag-and-drop, are the touch path — `draggable` is turned off on
  coarse-pointer devices. The approval strip and its actions row are full width above `.board-actions`, which is one flex row holding the Start session (`>_`) button — 36px tall on a phone, 30px from 768px, the icon buttons square — and the Move to… select filling the rest of the row; it wraps the select onto its own full-width row only in a card narrower than about 10rem (a four-column tablet group). A lone control fills the row as before.
  While the page is open a 60 s poller replaces the whole of `#issue-board-surface` (every group,
  column, card and the Backlog tray), so the rule against animating poller-replaced subtrees applies
  to all of it; it restores the operator's folds and scroll and changes no width tier or breakpoint
  — `/board` stays `"full"` with the same phone, tablet and desktop layouts.
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
- **Repo avatars.** `repoAvatar(fullName)` (`src/pages/layout.ts`) renders a `.repo-avatar` square (1.5em of the surrounding text, 4px radius, `--bg-secondary` surface, `--text-subtle` initial) inline before a repo name wherever work is listed or grouped by repo. It always holds the repo name's initial; when the repo's `claws.json` declares an `avatar`, an `<img>` from `/repo-avatar/:owner/:name` covers it and removes itself on a load error, so the initial is the neutral fallback. Its vertical margins are negative (`-0.2em`) so the larger box leaves line height, row height and chip height unchanged. It sits inside the existing chip or cell on every tier — never add a separate avatar column. On Board cards the avatars sit grouped in `.board-repos` at the right end of the head row and the automerge `M` toggle is the head row's first item at the top-left, at the same size (36px phone / 30px from 768px). On `/sessions` multi-repo rows are avatar-only (`.session-repo` with `title` plus a visually hidden short name). On the Board it is a `<details class="board-repo">` that reveals the repo name on tap and shows the full name on hover, and the head row wraps on narrow cards.
- **Viewport plumbing.** `body` uses `min-height: 100dvh` (not just `100vh`) so mobile
  browser chrome doesn't cause overflow, and scroll containers pair `overflow-x: auto`
  with `-webkit-overflow-scrolling: touch`. Standalone pages that don't import
  `HEAD_META` must still include the
  `<meta name="viewport" content="width=device-width, initial-scale=1">` tag.
- **Page width mechanism.** `PAGE_CSS` sets `body { max-width: var(--page-width) }`,
  where `--page-width` defaults to `64rem` (1024px) on `html` and a page's width tier
  (see "Width tier" above) sets it to `90rem` (`"wide"`) or removes the cap (`"full"`).
  `.warning-banner` has no width of its own and fills `body`; `nav` is capped at the
  constant `--chrome-width` instead and never references `--page-width` (see "Nav
  position" above).

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
