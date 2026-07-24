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
- Terminal access (SSH or local) to the Claws host, or a browser, for the
  initial QR-code pairing step
- Voice-note transcription works out of the box against a self-hosted Whisper
  instance (default `whisperBaseUrl`); an OpenAI API key is only needed as a
  fallback backend or if the self-hosted instance is disabled

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

### Step 2 — Voice-note transcription (on by default)

Voice notes are transcribed by a Whisper server running on the same VM as
Claws — no configuration or manual setup is needed. `whisperLocalUrl`
defaults to `http://127.0.0.1:9000`, and the auto-updater
(`deploy/deploy.sh`, run every minute by `claws-updater.timer`) installs
everything the local server needs:

- [`uv`](https://docs.astral.sh/uv/) — installed to `/usr/local/bin` if
  `uv` is not already on the PATH.
- The bundled `deploy/whisper.service` unit — which runs
  `deploy/whisper-server.py` (a self-contained PEP-723 script: faster-whisper
  behind a small OpenAI-compatible FastAPI app, launched with
  `uv run --script`) on `127.0.0.1:9000` — installed, enabled, and kept in
  sync with the bundled copy from then on, restarting the service whenever
  the unit content changes. A manually installed
  `/etc/systemd/system/whisper.service` is kept in sync the same way.

The first start is slow: `uv` resolves the script's dependencies and
faster-whisper downloads the model (~142 MB for the default) into
`~/.cache/huggingface`. Allow a couple of minutes before the server answers.

Set `whisperLocalUrl` to an empty string (in `~/.claws/config.json`, or
`CLAWS_WHISPER_LOCAL_URL=` in `~/.claws/env`) to disable the local server —
the unit is then neither installed nor tried. Point it at a non-localhost
URL to use a local-network server you manage yourself.

`transcribe.ts` tries each configured Whisper server in order (each with its
own circuit breaker: 5 min disabled after 3 consecutive failures): local
server (`whisperLocalUrl`) → remote server (`whisperBaseUrl`, default
`https://whisper.home.bstjohn.net`; empty string disables it) → OpenAI
Whisper API. `OPENAI_API_KEY` is optional and is only used if every Whisper
server is unreachable. The 25 MB audio cap (`src/whatsapp.ts:126`) is
unchanged.

The `model` sent to self-hosted Whisper servers is controlled by
`CLAWS_WHISPER_MODEL` / `whisperModel` (default `Systran/faster-whisper-base`).
The model the bundled server actually loads is set by `WHISPER_MODEL` in
`deploy/whisper.service`. `whisper-server.py` accepts and ignores the `model`
form field, so a mismatch no longer rejects the request — but the two should
still be kept in agreement so the configured model is the one transcribing.
Raising `WHISPER_MODEL` to `small` or `medium` also needs `MemoryMax` in the
unit raised above the `2G` that suits the default `base` model.

To configure the OpenAI fallback, add the key to `~/.claws/config.json`:

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

On first startup with WhatsApp enabled and no existing auth state, Claws does
**not** connect automatically or print a QR code — it sets a `pairingRequired`
flag and waits. Pairing is started explicitly from the web dashboard:

1. Open `http://localhost:3000/whatsapp` in a browser (the dashboard's
   Integrations section links here, or navigate directly).
2. Click **Start Pairing** — this hits `GET /whatsapp/pair`, an SSE endpoint
   that calls `startPairing()` and streams the QR code to the page as it's
   generated.
3. On the phone whose number will act as the bot:
   - **Standard WhatsApp**: Settings → **Linked Devices** → **Link a Device**
   - **WhatsApp Business**: Settings → **Linked Devices** → **Link a Device**
   - Point the camera at the QR code shown on the `/whatsapp` page

4. The page updates to a connected state once pairing completes (also visible
   as `[whatsapp] Connected` in `sudo journalctl -u claws -f`). Credentials are
   saved to `~/.claws/whatsapp-auth/` — subsequent restarts reconnect
   automatically without repeating this step.

> **Note:** The QR code expires after about 60 seconds. If it times out, a new
> one is generated automatically while the pairing page stays open.

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
- No labels applied — the issue enters the normal unlabelled state-machine flow
  like any manually-created issue (`Needs Refinement` is a legacy label no
  longer used by any current job)

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
- [ ] A test voice note creates an issue with the transcription in the body
      (works by default via self-hosted Whisper; no config needed unless
      you've disabled it)

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

- Check the local server first: `systemctl status whisper` and
  `curl http://127.0.0.1:9000/health` (returns `{"status":"ok",...}` once the
  model has loaded). `sudo journalctl -u whisper -e` shows dependency
  resolution and model-download progress on a first start.
- Check whether the configured Whisper servers (`whisperLocalUrl`,
  `whisperBaseUrl`) are reachable; after 3 consecutive failures a server is
  circuit-broken for 5 minutes and the next server (or the OpenAI API) is
  tried instead — if no `OPENAI_API_KEY` is configured and every server is
  circuit-broken, transcription fails
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
