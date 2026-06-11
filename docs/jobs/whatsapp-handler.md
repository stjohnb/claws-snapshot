# whatsapp-handler

**Source**: `src/jobs/whatsapp-handler.ts`
**Trigger**: Incoming WhatsApp message (event-driven, not scheduled)
**Requires**: `whatsappEnabled: true` in config

Not a scheduled job — registered as a callback on the WhatsApp client via
`createHandler()`. Processes each incoming message:

- If the message contains a voice note and `OPENAI_API_KEY` is configured,
  transcribes it via the Whisper API. If no API key, replies asking for text.
- Truncates message text to 10,000 characters
- Asks Claude to interpret the message and produce a JSON response with
  `repo`, `title`, and `body` fields, choosing the most likely target
  repository from the available list
- Creates a GitHub issue (no labels) in the chosen repository
- Replies to the WhatsApp sender with the issue link
- Does not create worktrees or record tasks in the database

See [WhatsApp Setup](../whatsapp-setup.md) for configuration and pairing.
