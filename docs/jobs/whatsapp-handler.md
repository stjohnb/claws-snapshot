# whatsapp-handler

**Source**: `src/jobs/whatsapp-handler.ts`
**Trigger**: Incoming WhatsApp message (event-driven, not scheduled)
**Requires**: `whatsappEnabled: true` in config

Not a scheduled job — registered as a callback on the WhatsApp client via
`createHandler()`. Processes each incoming message:

- If the message contains a voice note, transcribes it via Whisper (local-first
  at `http://127.0.0.1:9000`, then fallback to configured `WHISPER_BASE_URL`,
  finally OpenAI if `OPENAI_API_KEY` is set). If no Whisper service is available,
  replies asking for text.
- Truncates message text to 10,000 characters
- Messages queued by WhatsApp while Claws was offline are delivered on reconnect
  (as Baileys `append` upserts) and processed identically to live messages — read
  receipt, transcription, issue creation (#2424)
- Asks Claude to interpret the message and produce a JSON response with only
  `repo` and `title` fields, choosing the most likely target repository from
  the available list. This call is pinned to `provider: "claude"` to avoid
  OpenRouter 402 credit exhaustion (#2151)
- The issue body is the raw message text itself (prefixed with `*Transcribed
  from a voice note.*` for voice notes), never a Claude-authored summary —
  the owner asked for unmodified raw content since the issue gets fleshed out
  by the standard refinement pipeline anyway (#283)
- Creates a GitHub issue (no labels) in the chosen repository
- Replies to the WhatsApp sender with the issue link
- Does not create worktrees or record tasks in the database

See [WhatsApp Setup](../whatsapp-setup.md) for configuration and pairing.
