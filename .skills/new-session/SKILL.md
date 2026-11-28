---
name: new-session
description: Start a new, independent Claws interactive session, for a Claws-native issue or with no issue, with optional repos, agent, model, background context, a first message it starts on at once, and capability requests. Use when the user types /new-session, or asks to spin up, start, open or hand work or an issue to a new or separate session.
---

Start a new interactive session, for one issue or for work that has none.

1. **Resolve the issue, if any.** If the argument names a Claws-native issue
   (`clw_…`, with or without a leading `#`), or this session is clearly about
   one, pass it as `issue_id`. Only native issues work: for a forge issue
   (`#123` on GitHub or Forgejo) say a session can only be started for a
   `clw_…` issue, or with no issue, and stop. When the work has no issue, call
   without `issue_id` and describe the work in `instructions` and/or
   `initial_message` (step 2). Never file an issue just to have something to start a
   session for; the new session can file one itself once the operator has
   scoped the work.
2. **Collect options.** Every one is optional; pass only what the user asked
   for. Omitted options get the dashboard New session form's defaults: the
   issue's repos (none starts a home-directory session, and with no issue repos
   default to none), the form's default agent, and that agent's default model.
   - `repos`: `owner/name` list; the first is the working directory.
   - `provider`: `claude`, `codex`, `opencode` or `pi`.
   - `model`: a model the New session form offers for that provider. An
     unknown or unavailable one is rejected, not substituted: report the
     allowed list from the error and ask.
   - `instructions`: background context for the new session's system prompt
     — why the work came up, related issues, constraints — in the user's
     words (at most 4,000 characters). It never runs by itself: a request
     written here waits for the operator like everything else.
   - `initial_message`: the request the new session should act on straight
     away ("explain X", "investigate Y"), at most 4,000 characters. It becomes
     the new session's first user turn as soon as its agent is ready, marked
     as sent by this session, so the operator finds a reply or work in
     progress. It starts spending tokens at once. Omit it when the operator
     wants to drive the session themselves; the session then waits for their
     first message.
   - `title`: when there is no issue, always pass a short descriptive title
     (at most 120 characters, e.g. "Debug Loki OOM on loki-0"). Never pass it
     with `issue_id`: that session is titled from the issue.
   - `request_capabilities` (with a `reason`): capability ids beyond the
     baseline. They are not granted by this call.
3. **Call `claws_start_session`** with `issue_id` (when there is one) and those
   options. Do not retry with different options after a rejection unless the
   user chooses them.
4. **Report** the new session's id and dashboard URL in one line, and what
   it is doing from the reply's `initial_message` and `first_turn`: say it is
   working on the task now only when `initial_message` is `queued`; with
   `none`, say it waits for the operator. If `pending_capabilities` is not
   empty, add that those wait for the operator to approve them on the new
   session's page; the new session cannot use them until then.

The new session is fully independent: its own checkout, terminal, history and
usage. It starts with the instructions in its prompt, plus the issue's title,
body and latest plan when one was named. With an `initial_message` it starts
on that at once, treating it as another session's request: it may read,
investigate, edit its checkout and report, but waits for the operator before
pushing, touching a PR or issue, or passing a gate. Without one it waits for
the operator's first message. It appears in the sessions list under its title. This session cannot message it afterwards, and ending either one
leaves the other running. Do not hand it this session's uncommitted work; push
a branch and name it in `instructions` if it needs that.

If `claws_start_session` is not available, this session has no Claws session
tools (a Claude session granted the `browser` capability gets none), or it was
started before Claws offered the tool. Tell the user to create the session from
the Claws dashboard's New session page instead. Do not try to `curl` the Claws
API as a workaround.
