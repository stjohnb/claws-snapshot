# shopping-comment-processor

**Source**: `src/jobs/shopping-comment-processor.ts`
**Trigger**: Interval (`intervals.shoppingCommentProcessorMs`, default 10 min)

Turns plain-English comments on the consolidated `[shopping]` tracking issue into
edits to the manifests that issue is built from. This is the primary way to
update a shopping list (#2546): comment "mark the HBA delivered, unlock phase 2
on the NAS expansion, and add a 10GbE NIC under £60", and ten minutes later the
YAML on each manifest's own default branch says so and Claws has replied with
what it changed. You can then delete the comment to keep the issue readable.

Since #2647 there is **one** tracking issue, in `SELF_REPO`, covering every
repo's manifests — so a single comment can touch several projects at once
("skip cable ties everywhere"). The manifests themselves stay distributed, and
each edit is committed to the repo that owns it.

See [shopping-sourcer](shopping-sourcer.md) for the manifest schema and the
sourcing side of the feature. Opening a plain issue still works, and is still
the way to start a brand-new list, or to change one after the tracking issue has
closed — a closed issue's comments are never read.

## Flow

1. Find the consolidated tracking issue in `SELF_REPO` by exact title
   (`findIssueByExactTitle`, the title `shopping-sourcer` builds). No issue, or
   the job not enabled for the claws repo, means the run is a no-op.
2. Select actionable comments — see [Comment selection](#comment-selection).
   At most **10 comments per run**; `getIssueComments` is unpaginated, so this is
   what bounds the prompt. The "delete processed comments" workflow keeps the
   list short in practice.
3. Load **every** `docs/shopping/*.yaml` manifest across all managed repos, with
   its blob `sha`. Unreadable or malformed files are skipped silently — the
   sourcer's own malformed-manifest alert covers the fix. Manifests are ordered
   by `(repo, path)`, so the prompt and the reply are deterministic. If nothing
   loads at all, the comments get a 😕 and a reply saying so.
4. Extract any images embedded in the selected comments (`body_html` preferred
   over `body` — a private repo's user-attachment only renders as a fetchable
   pre-signed URL there) and download up to **6** of them into a per-run
   `.claws-images` scratch directory via `src/images.ts`. When at least one
   downloads, the agent call is allowed `Read` so it can see
   them (#2674); unreadable images (download failure, oversize, or over the
   6-image cap) are named in the reply instead of silently dropped.
5. One agent call — no tools when there are no readable images, otherwise
   `Read` only — covering every manifest and every selected
   comment returns a JSON list of mutations (below). It never writes YAML and
   never touches a repo.
6. Mutations are grouped by their `manifest` key. `applyMutations` then validates
   each group and applies the survivors to that file's `yaml` `Document`, so
   comments and formatting in the manifest survive.
7. Each serialized result is re-parsed with `parseManifest`. **If it fails, that
   file is not committed** — this is the guard against ever writing a manifest
   the sourcer can't read.
8. Commit each changed manifest to its own repo's default branch via the contents
   API, passing the blob `sha` fetched in step 3 — a compare-and-swap, so a
   concurrent edit 409s instead of being clobbered. A failed commit is never
   retried (a protected branch would loop forever) and **never aborts the other
   manifests in the batch**; the failure is folded into the reply instead.
9. Refresh the consolidated issue body immediately (via `upsertAlertIssue`) so it
    isn't stale until the next 7 AM sourcer run, react 🚀 on each comment, and
    post one reply with an "Updated `<repo>:<path>`" section per manifest plus a
    combined "Not applied" list.

### Failure handling

The batch carries **no reaction until the reply is posted** (#2793): a comment
is claimed only by being answered, never in advance. So any failure after
selection — a rate-limited or unavailable provider, a timeout, a GitHub 5xx —
leaves the comments exactly as they were, and the next 10-minute run picks
them up again. This is what lets a transient provider outage self-heal without
an operator noticing. A per-comment in-memory counter bounds the retry: after
`MAX_FAILED_ATTEMPTS` (6, ~1 hour at the 10-minute interval) consecutive failed
runs, the batch gets 😕 and a reply. That reply does *not* claim nothing was
changed — a run can also fail after `applyToManifest` has committed — so it says
some updates may already have been applied and points at the manifests. For the
same reason the 😕 goes only on the comments that do not already carry a
terminal 🚀/😕 from a `finish()` that failed partway through, and if every
comment in the batch is already answered no reply is posted at all. The counter
lives only in memory, so a service restart resets it — worst case, a
persistently-failing comment gets a few more cheap retries after a deploy.

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
  the next run retries it. 👀 is only ever honoured here for a claim left by a
  pre-#2793 run; Claws itself no longer writes one (see
  [Failure handling](#failure-handling)).

## Reaction protocol

| Reaction | Meaning |
|----------|---------|
| 👀 `eyes` | Legacy claim written before #2793. Claws no longer adds it; a comment still carrying one is skipped, and only the bot can delete it (installation token). |
| 🚀 `rocket` | At least one manifest was applied and committed. |
| 😕 `confused` | Nothing was committed anywhere — see the reply for why. |

## Mutation vocabulary

The agent's only output is a JSON object `{"mutations": [...]}` whose entries are:

```json
{"op":"set_field","manifest":"<manifest key>","id":"<existing item id>","field":"status|phase|max_price|notes|recheck_days|name","value":"<string or number>"}
{"op":"add_item","manifest":"<manifest key>","item":{"id":"...","name":"...","phase":1,"status":"sourcing","max_price":"£40","notes":"..."}}
{"op":"remove_item","manifest":"<manifest key>","id":"<existing item id>"}
{"op":"set_active_phases","manifest":"<manifest key>","value":[1,2]}
```

Every op is **manifest-qualified**. The key is `<owner>/<repo>:<path>`, e.g.
`St-John-Software/nixos-config:docs/shopping/nas-expansion.yaml`, and is quoted
verbatim from a `### Manifest` heading in the prompt. `groupMutationsByManifest`
rejects any op whose key was not in the prompt rather than guessing — the key is
what lets a comment reach a file on another repo's default branch. The prompt
also tells the agent to emit nothing, rather than a guess, when a request does
not clearly identify a project.

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
- The agent runs in a per-repo scratch directory
  (`scratch/shopping-comment-processor/<owner>-<name>`), never a worktree, with
  the provider pinned to `claude` (`noProviderFallback: true` on the image path,
  since `disallowedTools` is Claude-CLI-only and a fallback provider would
  otherwise re-run the prompt unsandboxed). With no readable images it runs with
  `claude.TEXT_ONLY_DISALLOWED_TOOLS`; when at least one image
  downloaded it runs with `IMAGE_DISALLOWED_TOOLS`, allowing only `Read`, so it can view the
  downloaded files and nothing else. Either way, images only ever come from
  comments whose author already passed `isAllowedActor`, and an image's content
  is treated as data describing the request, never as instructions.
- A mutation can only reach a manifest whose key was in the prompt, so an
  injected op naming an arbitrary repo/path is discarded before any commit.
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
  issues. Once the issue auto-closes (nothing left in `sourcing` for an active
  phase anywhere), use a plain issue to reopen the work.
- **A failed run is retried, not dropped.** See
  [Failure handling](#failure-handling) — up to `MAX_FAILED_ATTEMPTS` (6)
  consecutive failures, after which the batch gets 😕 and a reply. The residual
  window is a hard process crash between a manifest commit and the reply: the
  request re-runs on the next tick. The mutations are effectively idempotent
  (`add_item` refuses an id that already exists, `set_field` re-sets the same
  value), so that costs a duplicate reply at worst.
- **10 comments per run.** Extras are picked up on the next run.
- **Every manifest in the fleet goes into the prompt.** That is what lets one
  comment span projects, but it grows with the number of manifests.
- **At most 6 embedded images per run.** An image over that cap is counted in
  the "not readable" note rather than downloaded.
- **An unreadable image is named in the reply, not silently dropped.** Download
  failure, an oversized file, or the 6-image cap all fall back to the
  no-tools path with a note asking the operator to restate what the image
  showed.
