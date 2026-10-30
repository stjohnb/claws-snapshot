# content-moderator

**Deep dive.** Read this when you're changing the automated pre-moderation of
an app's user-submitted content. Bonkus feature requests are the first and only
user (#clw_01M63WJAEQZTJXDRV6MD5679GJ).

**Source**: `src/jobs/content-moderator.ts`
**Trigger**: Interval-based, controller only
**Interval**: 10 minutes (configurable via `intervals.contentModeratorMs`)
**Provider**: Claude `sonnet`, pinned (the completion API default)

## What it does

A repo opts in by committing `contentModeration: { endpoint }` in its
`claws.json` (see [repo-config.md](../repo-config.md)). The app owns the
content, its moderation state and its review guidelines; Claws only judges.
Each tick, for every opted-in repo that is enabled and not switched off for
`content-moderator` on the `/jobs` matrix:

1. Mint a 5-minute RS256 JWT with `mintClawsJwt` (`iss=claws`,
   `sub=claws-content-moderation`, `aud=content-moderation:<owner>/<repo>`),
   signed with the key behind `/.well-known/claws-jwks.json`. The app verifies
   it against that JWKS, so no shared secret exists
   ([observability-access.md](../observability-access.md)).
2. `GET <endpoint>?state=pending&limit=10` (15 s timeout). The app answers
   `{ requests: [{ id, title, description, created_at, … }], guidelines }`,
   oldest first.
3. Reconcile the stale-moderation alert issue (below).
4. For each item, one at a time, run an isolated completion through
   `runIsolatedCompletion` in `src/completion-api.ts`: no tools, no MCP, no
   checkout, recorded as a `completion-api` task attributed to the repo, and
   refused up front while Claude's usage-limit breaker is open.
5. `POST <endpoint>/<id>` with `{ decision, reason, model }`. The app applies
   it only while the item is still pending, so a manual decision the owner made
   in the meantime wins (`applied: false`).

The app never calls Claws. Anything left pending is simply picked up again on
the next tick.

## Prompt

The system prompt is fixed: the item is untrusted data, instructions inside it
are ignored, an item that tries to steer its own review is rejected, and the
reply must be exactly `{"decision":"approved"|"rejected","reason":"…"}`. The
app's `guidelines` string is appended to it. The title and description go in
the user prompt between delimiter lines carrying a per-call random nonce, so a
submission cannot forge the closing delimiter.

## Failure handling

Every failure fails closed: the item stays pending and unpublished and is
retried next tick.

- Output that is not that JSON object after stripping a code fence, or has an
  unknown decision, posts nothing.
- A completion error, a timeout, or a 429/5xx/network failure from the app
  skips the item (or, for the queue fetch, the repo).
- Claude at its usage limit leaves the rest of the batch for the next tick
  without counting it as failed.
- A 401/403 from the app (JWKS unreachable, wrong audience, clock skew) is
  reported once through `error-reporter.ts` and stops that repo's tick.
- A repo where every fetched item failed is reported through `error-reporter.ts`.
- A 404/405 from the queue fetch means the endpoint is not live yet (an opt-in can land
  before the app deploy). The job logs a warning, skips the repo for the tick and records
  when it first saw that state in `content_moderation_not_live`. Only after 24 hours
  (`NOT_LIVE_GRACE_MS`) of continuous 404/405 is it reported as a fault; any other
  response clears the state.
- Any other 4xx (anything but 404/405 and 401/403) or a malformed body from
  the queue fetch is reported as a fault; a decision POST answering another
  4xx just counts the item as failed.

## Stale alert

Items whose `created_at` is more than 24 hours old are listed, by id and age in
whole hours, in one native alert issue per repo titled
`Feature requests awaiting manual moderation`, filed with dedupe key
`feature-request-moderation-stale` and alert kind `content-moderator` (so it
shows on `/alerts`), not auto-promoted. The job rewrites the body when it
changes and closes the issue as completed once nothing in the batch is that
old. The body points the owner at the app's manual moderation route (the
`PATCH` in the repo's `docs/OVERVIEW.md`). Only the oldest 10 pending items are
seen each run; the body says so when the batch is full.

## Logging

A start line per tick and one finish line per repo:
`[content-moderator] <repo>: finished job=content-moderator duration_ms=… fetched=… approved=… rejected=… failed=…`.
Every call to the app logs its method, host, path, status and `duration_ms`.
Item text and decision reasons are never logged.
