---
name: title
description: Set the title/description shown for this Claws session on the dashboard's sessions list. Use when the user types /title, or asks to name, title, rename, or re-label this session.
---

Set this session's dashboard description.

The argument is the title. `/title Debugging feature X` means the title is
`Debugging feature X`. `/title` with no argument means clear the manual title
and let Claws resume automatic summaries.

Call the `claws_set_session_title` MCP tool with `title` set to the argument
verbatim (or the empty string when there is no argument). Do not rewrite,
expand, or prettify the user's wording — the whole point is that the operator
chose it. Trim surrounding whitespace and quotes only.

Constraints:

- Keep it under 120 characters; Claws truncates beyond that. If the argument is
  longer, shorten it yourself and say what you shortened it to.
- Do not name the repository or worktree — the sessions list already shows those
  in their own column.
- A title identified only by an issue or PR number ("PR #1234") is a poor title,
  but if the operator explicitly asked for it, use it as given.

Setting a title pins it: automatic summarisation of this session stops until it
is cleared. Say so in one line when you set one.

If `claws_set_session_title` is not available, this session has no Claws MCP
tools — it is a codex or opencode session, or a Claude session granted the
`browser` capability, none of which get the `claws-state` MCP server. Tell the
user to set the description from the session's page on the Claws dashboard
instead. Do not try to `curl` the Claws API as a workaround.

Report the final title in one short line. Nothing else.
