# WhatsApp Gateway Setup

The WhatsApp gateway lets authorised phone numbers create GitHub issues by
sending text messages or voice notes to a linked WhatsApp account. Messages are
interpreted by Claude, which picks the target repository and drafts the issue.

## Prerequisites

Before starting, confirm you have the following ready:

- A working Claws installation (systemd service running, `gh` and `claude`
  authenticated)
- A phone with an active WhatsApp account to use as the bot's identity (see
  [Choosing a phone number](#choosing-a-phone-number) below)
- Terminal access (SSH or local) to the Claws host for the initial QR-code
  pairing step
- *(Optional)* An OpenAI API key if you want voice-note transcription

## Choosing a phone number

The bot runs as a **WhatsApp Web linked device** on an existing WhatsApp
account. Any phone number with an active WhatsApp account will work — it does
not need to be the same phone you use day-to-day.

### Using a second SIM with WhatsApp Business

If you want to keep the bot completely separate from your personal WhatsApp, a
dedicated SIM with the **WhatsApp Business** app is the recommended approach.
This works with the current implementation without any changes.

**Important distinction — WhatsApp Business *app* vs WhatsApp Business *API*:**

| | WhatsApp Business app | WhatsApp Business API (Cloud API) |
|---|---|---|
| **What it is** | Free app for Android/iOS, alternative to the standard WhatsApp app | Meta's commercial API platform for large-scale messaging |
| **Account type** | Regular WhatsApp account registered to a phone number | Requires a Meta Business Suite account, approval process, and a Business Solution Provider |
| **Linked devices** | Supported — works identically to the standard app | Not applicable — the API *is* the integration point |
| **Claws compatibility** | Fully compatible, no changes needed | Not used by Claws |
| **Cost** | Free | Pay-per-conversation pricing from Meta |

**Claws uses the Baileys library, which connects via the WhatsApp Web linked
device protocol.** This works with both the standard WhatsApp app and the
WhatsApp Business app. You do **not** need the WhatsApp Business API (Cloud
API), a Meta Business Suite account, or any third-party gateway service.

### Recommended setup with a second SIM

1. Insert a second SIM into a spare phone (or a dual-SIM phone)
2. Install the **WhatsApp Business** app from the App Store / Play Store
3. Register the app with the new phone number
4. Complete the WhatsApp Business profile (business name, description — this is
   what users see when they message the bot)
5. Use this number for the Claws QR-code pairing step below

The phone must stay powered on and connected to the internet. If the primary
phone goes offline for an extended period (roughly 14 days), WhatsApp will
disconnect linked devices and you will need to re-pair.

---

## Step-by-step operational setup

### Step 1 — Configure allowed numbers

Decide which phone numbers are permitted to create issues. Numbers use the
international format without the leading `+` (e.g. `447700900000` for a UK
mobile).

Add the numbers to `~/.claws/config.json`:

```json
{
  "whatsappEnabled": true,
  "whatsappAllowedNumbers": ["447700900000", "447700900001"]
}
```

Or set environment variables in `~/.claws/env`:

```bash
WHATSAPP_ENABLED=true
WHATSAPP_ALLOWED_NUMBERS=447700900000,447700900001
```

Environment variables take priority over the config file.

### Step 2 — (Optional) Enable voice-note transcription

Voice notes are transcribed using the OpenAI Whisper API. If you skip this
step, the bot will reply asking users to send text instead.

Add the key to `~/.claws/config.json`:

```json
{
  "openaiApiKey": "sk-..."
}
```

Or to `~/.claws/env`:

```bash
OPENAI_API_KEY=sk-...
```

### Step 3 — Restart Claws

```bash
sudo systemctl restart claws
```

### Step 4 — Pair WhatsApp via QR code

On first startup with WhatsApp enabled, the service prints a QR code to its
journal output. You need to scan it with the WhatsApp app on the bot's phone.

1. Open the service logs so you can see the QR code:

   ```bash
   sudo journalctl -u claws -f
   ```

2. On the phone whose number will act as the bot:
   - **Standard WhatsApp**: Settings → **Linked Devices** → **Link a Device**
   - **WhatsApp Business**: Settings → **Linked Devices** → **Link a Device**
   - Point the camera at the QR code in the terminal

3. The logs should show `[whatsapp] Connected` once pairing completes.
   Credentials are saved to `~/.claws/whatsapp-auth/` — subsequent restarts
   reconnect automatically without a QR code.

> **Note:** The QR code expires after about 60 seconds. If it times out, a new
> one will be generated automatically. Keep the journal output visible and be
> ready to scan promptly.

### Step 5 — Verify the connection

Check the Claws status endpoint:

```bash
curl -s http://localhost:3000/status | jq .whatsapp
```

Expected output:

```json
{
  "configured": true,
  "connected": true
}
```

The web dashboard at `http://localhost:3000/` also shows WhatsApp connection
status in the Integrations section.

### Step 6 — Send a test message

From one of the allowed numbers, send a WhatsApp message to the bot's phone
number, e.g.:

> Add a dark-mode toggle to the settings page in my-org/my-app

The bot should reply with a link to the newly created GitHub issue.

### Step 7 — Verify issue creation

Check the target repository on GitHub to confirm the issue was created with:
- A descriptive title (drafted by Claude from your message)
- A body explaining the request
- The `Needs Refinement` label applied

---

## Operational checklist

Use this checklist to confirm everything is working after setup:

- [ ] `~/.claws/config.json` has `whatsappEnabled: true` and at least one
      number in `whatsappAllowedNumbers`
- [ ] Claws service is running: `sudo systemctl status claws`
- [ ] QR code has been scanned and `[whatsapp] Connected` appears in logs
- [ ] `/status` endpoint shows `whatsapp.configured: true` and
      `whatsapp.connected: true`
- [ ] Test message from an allowed number creates a GitHub issue
- [ ] Bot replies with the issue link
- [ ] *(If voice notes enabled)* `OPENAI_API_KEY` is configured and a test
      voice note creates an issue with the transcription in the body

---

## Adding or removing allowed numbers

To update the allowlist after initial setup:

1. Edit `~/.claws/config.json` and modify the `whatsappAllowedNumbers` array
   (or update `WHATSAPP_ALLOWED_NUMBERS` in `~/.claws/env`)
2. Restart the service: `sudo systemctl restart claws`

No re-pairing is needed — the existing WhatsApp session persists.

---

## Troubleshooting

### QR code not appearing

- Confirm `WHATSAPP_ENABLED` is `true` and at least one number is in
  `WHATSAPP_ALLOWED_NUMBERS`
- Check the journal for errors: `sudo journalctl -u claws -e`

### "Logged out — delete auth state and re-scan QR code"

WhatsApp sessions can expire if the primary phone is offline for an extended
period, or if the linked device is removed manually. To re-pair:

```bash
rm -rf ~/.claws/whatsapp-auth
sudo systemctl restart claws
```

Then repeat the QR-code pairing step.

### Messages are ignored

- The sender's number must be in `WHATSAPP_ALLOWED_NUMBERS` (international
  format, no `+` prefix)
- Group messages are ignored by design — only direct messages are processed
- Images, videos, and documents are not supported; only text and voice notes

### Voice notes fail

- Ensure `OPENAI_API_KEY` is set and valid
- Voice notes longer than ~10 minutes (25 MB) are rejected — the bot will ask
  the user to send a shorter note

### Bot stops responding after a period

- Check that the phone running WhatsApp is still powered on and connected to
  the internet
- Check `sudo journalctl -u claws -e` for disconnect/reconnect messages
- If the session was revoked, clear the auth state and re-pair (see above)

---

## Security notes

- Only numbers in the allowlist can trigger issue creation. Messages from all
  other numbers are silently dropped.
- The bot runs as a WhatsApp Web linked device. It does not require a WhatsApp
  Business API account or any third-party gateway service.
- Auth credentials are stored locally in `~/.claws/whatsapp-auth/`. Protect
  this directory — anyone with access to these files can impersonate the linked
  device.
- Messages are not stored in the Claws database. They are processed in memory
  and discarded after issue creation.
