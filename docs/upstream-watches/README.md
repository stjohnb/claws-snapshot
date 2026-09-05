# Upstream watches

Each `*.yaml` file in this directory parks a GitHub issue on some piece of work
that has to happen in a repository we don't control — an upstream PR landing, an
upstream issue being closed, or a new release being cut. The issue carries the
`Blocked` label so nothing plans it in the meantime. The daily
`upstream-watcher` job polls the declared conditions, and when they are all
satisfied it removes `Blocked` (and any legacy `Claws Ignore`), adds `Ready`,
and comments on the issue explaining which conditions fired. See
[docs/jobs/upstream-watcher.md](../jobs/upstream-watcher.md) for the full
behaviour, including the dedup rules and the alerts raised for a malformed or
un-satisfiable watch.

Delete a watch file once its issue has been done — a fired watch is recorded in
the database and never re-fires, so a stale file is just noise.

`README.md` is ignored by the scanner, which only reads `.yaml`/`.yml` files.

## Schema

```yaml
id: optional-slug             # optional; defaults to the filename stem
target:
  repo: owner/repo            # the parked issue's repo
  issue: 123                  # the parked issue number
require: all                  # optional; all (default) or any
conditions:                   # at least one
  - kind: pr_merged           # met once the PR is merged (not merely closed)
    repo: upstream-org/upstream-repo
    number: 2715
  - kind: issue_closed        # met once the issue is closed, however it closed
    repo: upstream-org/upstream-repo
    number: 42
  - kind: release             # met once a matching release exists
    repo: upstream-org/upstream-repo
    published_after: "2026-08-25"   # optional YYYY-MM-DD; strictly after
    tag_matches: "^v\\d+"           # optional regular expression over the tag
    include_prereleases: false      # optional; default false. Drafts never match.
note: >-                      # optional; reproduced in the unblock comment
  Anything the planner should read before starting.
```
