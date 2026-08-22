# shopping-comment-processor

**Source**: `src/jobs/shopping-comment-processor.ts`
**Trigger**: Interval (`intervals.shoppingCommentProcessorMs`, default 10 min)

Turns plain-English comments on a `[shopping]` tracking issue into edits to the
manifest that issue is built from. This is the primary way to update a shopping
list (#2546): comment "mark the HBA delivered, unlock phase 2, and add a 10GbE
NIC under £60", and ten minutes later the YAML on the default branch says so and
Claws has replied with what it changed. You can then delete the comment to keep
the issue readable.

See [shopping-sourcer](shopping-sourcer.md) for the manifest schema and the
sourcing side of the feature. Opening a plain issue still works, and is still
the way to start a brand-new list, or to change one whose tracking issue has
already closed — a closed issue's comments are never read.

## Flow

1. List open issues per repo and keep those titled
   `[shopping] <stem>: sourcing & tracking` (the title `shopping-sourcer` builds).
2. Select actionable comments on each — see [Comment selection](#comment-selection).
   At most **10 comments per issue per run**; `getIssueComments` is unpaginated,
   so this is what bounds the prompt. The "delete processed comments" workflow
   keeps the list short in practice.
3. Resolve `docs/shopping/<stem>.yaml` (or `.yml`) and parse it. A missing or
   malformed manifest gets a 😕 and a reply explaining why — the sourcer's own
   malformed-manifest alert covers the fix.
4. React 👀 on every selected comment. This is the durable processed-marker and
   it goes on **before** the agent call, so a crash mid-run drops that update
   rather than risking an infinite reprocess loop.
5. One text-only agent call per issue covering all selected comments returns a
   JSON list of mutations (below). It never writes YAML and never touches the
   repo.
6. `applyMutations` validates every mutation and applies the survivors to the
   file's `yaml` `Document`, so comments and formatting in the manifest survive.
7. The serialized result is re-parsed with `parseManifest`. **If it fails,
   nothing is committed** — this is the guard against ever writing a manifest
   the sourcer can't read.
8. Commit to the default branch via the contents API, passing the blob `sha`
   fetched in step 3 — a compare-and-swap, so a concurrent edit 409s instead of
   being clobbered. A failed commit is never retried; a protected branch would
   otherwise loop forever.
9. Refresh the tracking issue body immediately (via `ensureAlertIssue`) so the
   table isn't stale until the next 7 AM sourcer run, react 🚀 on each comment,
   and post one reply listing what was applied and what was not.

## Comment selection

A comment is processed only when all of these hold:

- it is not a Claws comment (`isClawsComment`),
- its author's login does not end in `[bot]`,
- its body is non-empty,
- **its author passes `gh.isAllowedActor`** — a comment rewrites a file on the
  default branch, so only the configured `allowedActors` list may drive one.
  This gate is the reason the design is safe; everything else is validation,
  this is authorization,
- it carries no self-authored 👀/🚀/😕 reaction. A failed reaction lookup is
  treated as "already processed" — skipping is cheaper than reprocessing, and
  the next run retries it.

## Reaction protocol

| Reaction | Meaning |
|----------|---------|
| 👀 `eyes` | Claimed. Claws has picked the comment up and will not pick it up again. |
| 🚀 `rocket` | Applied and committed. |
| 😕 `confused` | Nothing was committed — see the reply for why. |

## Mutation vocabulary

The agent's only output is a JSON object `{"mutations": [...]}` whose entries are:

```json
{"op":"set_field","id":"<existing item id>","field":"status|phase|max_price|notes|recheck_days|name","value":"<string or number>"}
{"op":"add_item","item":{"id":"...","name":"...","phase":1,"status":"sourcing","max_price":"£40","notes":"..."}}
{"op":"remove_item","id":"<existing item id>"}
{"op":"set_active_phases","value":[1,2]}
```

`applyMutations` rejects, with a reason echoed into the reply comment:

- an unknown `op`;
- a `set_field` naming an item id that is not in the manifest, a field outside
  the allowlist, a `status` outside `sourcing|found|ordered|delivered|skip`, or a
  `phase`/`recheck_days` that is not a safe integer ≥ 1 (`Number.isSafeInteger`,
  matching `ItemSchema`'s `z.number().int()`, which rejects e.g. `1e21`);
- an `add_item` whose id is not `/^[a-z0-9][a-z0-9-]{0,63}$/`, already exists, or
  whose item has no name, or that fails `ItemSchema`;
- a `remove_item` for an id that does not exist;
- a `set_active_phases` whose value is not a non-empty list of ≤ 20 phase numbers;
- anything past the 25th mutation in one batch.

`name`, `max_price` and `notes` are truncated to 200/60/500 characters. Only the
keys the agent actually supplied are written for a new item, so schema defaults
(`phase: 1`, `status: sourcing`, `recheck_days: 1`) stay out of the file.

## Security

- **Authorization** is `gh.isAllowedActor` on the comment author (above).
- Comment bodies are truncated to 2000 characters and passed through
  `guardContent()` before entering the prompt, and the prompt states that comment
  text is data rather than instructions.
- The agent runs text-only in a per-repo scratch directory
  (`scratch/shopping-comment-processor/<owner>-<name>`), never a worktree, with
  `claude.TEXT_ONLY_DISALLOWED_TOOLS` and the provider pinned to `claude`.
- The reply comment is assembled entirely in TypeScript — agent prose is never
  pasted. Agent-supplied item names reaching the reply pass through
  `guardContent()` first, because Claws does not re-guard its own comments when
  reading them back, so an unguarded name would become a permanently-trusted
  injection vector.
- The agent emits mutations, not YAML, and the serialized result is re-validated
  before the commit, so an agent can never write a manifest that breaks the
  sourcer.

## Known limits

- **A closed tracking issue's comments are not read.** The job only scans open
  issues. Once a list's issue auto-closes (nothing left in `sourcing` for an
  active phase), use a plain issue to reopen the work.
- **A crash after the 👀 claim drops that update.** Deliberate: an at-most-once
  claim is the price of never reprocessing a comment. Comment again.
- **10 comments per issue per run.** Extras are picked up on the next run.
