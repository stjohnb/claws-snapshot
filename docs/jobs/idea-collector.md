# idea-collector

**Source**: `src/jobs/idea-collector.ts`
**Trigger**: Pending ideas files in `~/.claws/pending-ideas/`
**Interval**: 30 minutes (configurable via `intervals.ideaCollectorMs`)

Scans `~/.claws/pending-ideas/` for JSON files written by [idea-suggester](idea-suggester.md).
For each pending file:

1. **Polls reactions** on each idea message via the Slack API
2. **Checks completeness** — if all ideas have a disposition reaction, or
   if 24 hours have elapsed since posting (timeout)
3. If not ready, skips to next run
4. If ready, processes the batch:

## Processing

- **Accepted ideas** (✅): Creates a GitHub issue for each, records in
  the focus-area file (e.g. `ideas/ux.md`) with the issue number
- **Potential ideas** (🤔, or unreacted after timeout): Records in
  `ideas/potential.md`
- **Rejected ideas** (❌): Records title in `ideas/rejected.md`

When multiple reaction types are present on a message, priority applies:
✅ > ❌ > 🤔

## Output

- Creates a single PR per repo titled
  `[claws-ideas] Collected idea responses for <repo>` with a disposition
  table in the body
- Posts a summary reply to the original Slack thread
- Deletes the pending ideas file after successful processing
- If the repository has no declared focus areas (neither in `ideas/overview.md`
  nor `ideas/focus-areas.md`), the PR also adds a `## Focus Areas` section
  to `ideas/overview.md` listing the areas identified during suggestion.
  This ensures future runs use those areas as a starting point — repo
  maintainers can edit the list at any time.

## Edge cases

- If `getReactions` fails (Slack API error), logs warning and retries next run
- If `createIssue` fails for one idea, logs error but continues with others
- If the pending file references a repo not in the current repos list, skips
- Unreacted ideas after 24h timeout become "potential", but only if at least one idea in the batch has a reaction. If no ideas have reactions, the collector continues waiting.
