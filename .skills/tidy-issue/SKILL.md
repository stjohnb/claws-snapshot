---
name: tidy-issue
description: Tidy a Claws-native issue's discussion — keep what still matters, optionally fold it into a revised (unapproved) requirements version, soft-delete the stale comments the operator confirms, then keep the plan or re-plan. Use when the user types /tidy-issue, or asks to clean up, tidy or prune an issue's comments.
---

Tidy one Claws-native issue's comment thread the same way every time, so the
plan and the comments that still matter are not buried under stale
back-and-forth.

The argument is the issue id (`clw_…`, with or without a leading `#`),
optionally followed by `replan` or `keep-plan`. Only native issues work: for a
forge issue (`#123` on GitHub or Forgejo) say comments can only be tidied on a
`clw_…` issue, and stop. With no id, use the native issue this session is
about, or ask.

Deletion is a soft delete: a deleted comment disappears from the issue page
and from everything Claws agents read, but its row is kept and every deletion
is recorded in the issue's History as made by this session. It never re-plans
or queues work by itself.

1. **Read the issue.** Call `claws_get_issue` for its body, comments,
   current plan, requirements record and stage.
2. **Decide what still matters.** Classify every comment as **keep** or
   **delete**, each with a one-line reason. Keep anything that still constrains
   the work and is not already in the plan or the requirements record:
   decisions, constraints, "don't do X", open questions, feedback Claws has not
   yet answered. Delete what is superseded or noise: answered back-and-forth,
   old plan versions' discussion, stale reassessments, status chatter. The
   current plan comment and the latest requirements comment cannot be deleted —
   leave them out of the list.
3. **Fold, if needed.** If relevant substance lives only in comments you would
   delete, offer to fold it into a revised requirements record with
   `claws_save_issue_requirements` (the same fields as the current record, with
   the substance added). Say plainly that the new version is stored
   **unapproved**: approving it means moving the issue to Requirements review
   and promoting it, which re-plans an issue that has a plan. Save it only if
   the operator agrees; otherwise keep those comments.
4. **Confirm.** Show the deletion list — comment id, author, a short excerpt
   and the reason — and the keep list. Wait for the operator's explicit yes.
   Drop anything they want kept. Never delete without that yes.
5. **Delete.** Call `claws_delete_issue_comments` with the confirmed ids. The
   call is all or nothing: if it is refused (a protected, unknown or already
   deleted id), report the reason, fix the list with the operator and retry.
6. **Plan.** Do what the argument says: `keep-plan` leaves the current plan
   alone; `replan` starts a fresh re-plan against the current approved
   requirements with `claws_set_issue_column` and `planning`. If the argument
   gave neither, ask. If the move is refused (for example the issue has an open
   PR, so it would land in a derived column), report the refusal and leave the
   plan as it is. If step 3 saved a revised version, explain that approving it
   re-plans anyway.
7. **Report.** List what was deleted and what was kept, the issue's resulting
   stage, any requirements version saved (and that it awaits approval), and
   that every deletion appears in the issue's History.
