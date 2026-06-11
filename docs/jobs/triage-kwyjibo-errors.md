# triage-kwyjibo-errors

**Source**: `src/jobs/triage-kwyjibo-errors.ts`
**Trigger**: Open issues with a game UUID in the body (content-based discovery)
**Interval**: 10 minutes

Specialized for the Kwyjibo game application. Discovers issues by scanning
open issues for game UUIDs — no trigger label required. Skips issues that
already have a `## Bug Investigation Report` comment.

- Extracts a game UUID from the issue body (tries URL pattern, labelled
  pattern, then bare UUID)
- Fetches debug data from the Kwyjibo API:
  - `GET /api/games/<id>/debug-logs` — public endpoint
  - `GET /api/games/<id>/turns` — public endpoint
  - `GET /api/games/<id>/pg-net-errors` — requires `KWYJIBO_AUTOMATION_API_KEY`
- Debug logs are truncated if they exceed 50KB (keeps first and last 25KB)
- Reads `docs/debugging-games.md` from the repo if it exists
- Creates a worktree on branch `claws/investigate-<N>-<hex4>`
- Passes all data to Claude for analysis (no code changes, report only)
- Posts the report as a comment prefixed with `## Bug Investigation Report`
- Populates queue cache: `needs-triage` for uninvestigated issues,
  `needs-refinement` for already-investigated issues
