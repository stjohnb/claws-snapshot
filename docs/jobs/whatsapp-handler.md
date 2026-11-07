# whatsapp-handler

**Deep dive.** Read this when you're changing WhatsApp message-to-issue
handling. For pairing and transcription setup, read ../whatsapp-setup.md
instead.

**Source**: `src/jobs/whatsapp-handler.ts`
**Trigger**: Incoming WhatsApp message (event-driven, not scheduled)
**Requires**: `whatsappEnabled: true` in config

Not a scheduled job — registered as a callback on the WhatsApp client via
`createHandler()`. Processes each incoming message:

- Looks up the managed repo list first (before transcribing), so a voice note
  with no repos configured fails fast without spending a transcription call.
- If the message contains a voice note, transcribes it via Whisper (local-first
  at `http://127.0.0.1:9000`, then fallback to configured `WHISPER_BASE_URL`,
  finally OpenAI if `OPENAI_API_KEY` is set). If no Whisper service is available,
  replies asking for text. Transcription is given the managed repos' short
  names as Whisper prompt vocabulary (`voiceVocabularyPrompt()` in
  `src/transcribe.ts`), so an invented or unusual repo name is more likely to
  come out spelled correctly instead of as a phonetic neighbour.
- Truncates message text to 10,000 characters
- Messages queued by WhatsApp while Claws was offline are delivered on reconnect
  (as Baileys `append` upserts) and processed identically to live messages — read
  receipt, transcription, issue creation (#2424)
- Asks Claude to interpret the message and produce a JSON response with only
  `repo` and `title` fields, choosing the most likely target repository from
  the available list, shown one per line with its `claws.json` `description`
  when the repo has one. This call is pinned to `provider: "claude"` to avoid
  OpenRouter 402 credit exhaustion (#2151)
- For a voice note, the prompt also tells Claude the text is an automatic
  speech transcript, that repository names may be misspelled phonetically, and
  to prefer a name match over a topical guess — the routing bug that
  misdirected two `whyrr` voice notes to `vr-rooms`
  (#clw_01M35CMQEZ82JRF6TF93DE3V3P)
- The issue body is the raw message text itself (prefixed with `*Transcribed
  from a voice note.*` for voice notes), never a Claude-authored summary —
  the owner asked for unmodified raw content since the issue gets fleshed out
  by the standard refinement pipeline anyway (#283)
- Creates a GitHub issue (no labels) in the chosen repository
- Replies to the WhatsApp sender with the issue link
- Does not create worktrees or record tasks in the database

See [WhatsApp Setup](../whatsapp-setup.md) for configuration and pairing.
