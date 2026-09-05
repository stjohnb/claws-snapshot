# blog-draft-scanner

**Source**: `src/jobs/blog-draft-scanner.ts`
**Trigger**: Daily at 9 AM local time (`blogDraftScannerHour`, #2560)
**Targets**: All repos except `St-John-Software/bstjohn-blog` (opt-out per repo via the `/jobs` matrix)

Some repos have draft blog posts because it makes more sense to draft them in the repo
where the work happened, but they're intended for eventual publication on
`St-John-Software/bstjohn-blog`. This job scans for those drafts and files a port issue
in `bstjohn-blog` when one hasn't been published there yet.

## Scanned directories

Only these directories are scanned, in each repo's default branch:

- `docs`
- `ideas`
- `drafts`
- `docs/blog-drafts`
- `blog-drafts`

Within `drafts`, `docs/blog-drafts`, and `blog-drafts`, every `.md`/`.mdx` file (other
than `README.md`, or a name containing `idea` or `template`) is a candidate. Within
`docs` and `ideas`, only files whose basename starts with `blog` are candidates (e.g.
`docs/blog-post.md`, `ideas/blog-truenas-to-nixos.md`) — this is what keeps a plain
`docs/blog-post.md` in scope while leaving the rest of `docs/` and `ideas/` alone.

Repo-owned site blogs — `bonkus/content/blog`, `namey/src/app/blog` — are out of scope
by design: neither `content` nor `src/app/blog` is one of the five scanned directories,
so those trees are never listed at all. The scanner deliberately walks a fixed,
shallow directory list via the contents API rather than a recursive `git/trees` walk,
specifically to avoid pulling those repos' own blog content into scope.

## Detecting a draft

A candidate file's title comes from its YAML frontmatter `title` field if present,
otherwise the first `# Heading` line in the body. A file with neither is skipped.

The body (with any frontmatter stripped) must then look like actual prose, not a list
of ideas: at least 1500 characters, and at least 5 paragraphs of at least 200
characters that don't start with a list/heading/table/quote/code marker (`-`, `*`,
`#`, `|`, `>`, `` ` ``, or `1.`). This is what accepts a genuine draft post while
rejecting `BLOG_IDEAS.md`-style files, which are also excluded up front by name (any
candidate with `idea` in its filename is never considered).

## Suppressing already-published drafts

Before filing anything, the job lists `src/content/blog` in `bstjohn-blog` and builds
an index of every published post's frontmatter title (normalized: lowercased, stripped
to `[a-z0-9]`) and filename slug (date prefix and extension removed). A draft is
considered already published if:

- its title normalizes to a published title, or
- its title slugifies to a published slug, or
- its own filename (minus a leading `blog-`/`blog_` prefix) slugifies to a published slug.

If that published-post listing comes back empty, the entire run is skipped rather than
treating "no posts found" as "nothing is published yet" — an API hiccup returning `[]`
would otherwise file a port issue for every already-published draft across every repo.

## Filing and dedup

The filed issue's title is `[blog-port] <title> (<source repo>)` — the repo suffix
keeps two repos with a same-titled draft from colliding. The body links to the source
file, suggests a target path under `src/content/blog`, gives the exact `gh api ... | base64
-d` command to fetch it, a frontmatter skeleton to fill in, a reminder to fix relative
links/image paths, and a guarded excerpt (first 800 characters of the body) so a
planner agent in `bstjohn-blog` has context without the full draft (which can be tens
of KB) inlined. The excerpt and detected title are passed through `guardContent()`
before being embedded, since the source file is untrusted content from another repo.

Firing is deduplicated in SQLite by `(repo, path)` — not the blob sha or the title — so
editing a draft, or renaming it before it's ported, does not cause a second issue to be
filed once the original has been recorded. Publication status is re-checked on every
run instead of being cached in that dedup table, since a draft can be published at any
time independent of when it was first seen.

The dedup key is backed by the [`blog_draft_ports`](../database-schema.md#blog_draft_ports-table) SQLite table.

## Config

- `schedules.blogDraftScannerHour` — local hour to run (default 9 AM).
- Per-repo opt-out via the `blog-draft-scanner` toggle in the `/jobs` matrix (on by default).
