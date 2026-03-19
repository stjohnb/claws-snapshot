import type { Theme } from "./layout.js";
import { PAGE_CSS, htmlOpenTag, buildNav, THEME_SCRIPT, whatsappLabel } from "./layout.js";
import { WHATSAPP_ENABLED } from "../config.js";
import { whatsappStatus } from "../whatsapp.js";

export function buildWhatsAppPage(theme: Theme): string {
  const wa = WHATSAPP_ENABLED ? whatsappStatus() : { configured: false, connected: false, pairingRequired: false };
  const wl = whatsappLabel(wa);

  let statusSection: string;
  if (!wa.configured) {
    statusSection = `<p>WhatsApp is not configured. Set <code>whatsappEnabled</code> and <code>whatsappAllowedNumbers</code> in <a href="/config">Config</a>.</p>`;
  } else if (wa.connected) {
    statusSection = `
      <p class="running">Connected</p>
      <form method="POST" action="/whatsapp/unpair" style="margin-top: 1rem;">
        <button type="submit" class="trigger-btn" onclick="return confirm('This will disconnect WhatsApp and clear auth state. You will need to re-pair.')">Unpair</button>
      </form>`;
  } else {
    statusSection = `
      <p class="${wl.cls}">${wl.text}</p>
      <div id="pair-controls" style="margin-top: 1rem;">
        <button id="pair-btn" class="trigger-btn" onclick="startPairing()">Start Pairing</button>
      </div>
      <div id="qr-area" style="margin-top: 1rem; display: none;">
        <p>Scan this QR code with WhatsApp:</p>
        <img id="qr-img" style="max-width: 300px; image-rendering: pixelated;" alt="QR Code">
        <p id="qr-status" style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-secondary);">Waiting for QR code...</p>
      </div>`;
  }

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp — Claws</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  ${buildNav(theme)}
  <h1>WhatsApp</h1>
  ${statusSection}
  ${THEME_SCRIPT}
  <script>
    function startPairing() {
      var btn = document.getElementById('pair-btn');
      btn.disabled = true;
      btn.textContent = 'Pairing...';
      var qrArea = document.getElementById('qr-area');
      qrArea.style.display = 'block';
      var qrImg = document.getElementById('qr-img');
      var qrStatus = document.getElementById('qr-status');
      var es = new EventSource('/whatsapp/pair');
      es.onmessage = function(e) {
        var event = JSON.parse(e.data);
        if (event.type === 'qr') {
          qrImg.src = event.dataUrl;
          qrStatus.textContent = 'Scan the QR code with WhatsApp > Linked Devices > Link a Device';
        } else if (event.type === 'connected') {
          qrStatus.textContent = 'Connected successfully!';
          qrStatus.style.color = 'var(--success)';
          es.close();
          setTimeout(function() { location.reload(); }, 1500);
        } else if (event.type === 'timeout') {
          qrStatus.textContent = 'Pairing timed out. Please try again.';
          qrStatus.style.color = 'var(--danger)';
          btn.disabled = false;
          btn.textContent = 'Start Pairing';
          es.close();
        } else if (event.type === 'error') {
          qrStatus.textContent = 'Error: ' + event.message;
          qrStatus.style.color = 'var(--danger)';
          btn.disabled = false;
          btn.textContent = 'Start Pairing';
          es.close();
        }
      };
      es.onerror = function() {
        if (es.readyState === EventSource.CLOSED) {
          qrStatus.textContent = 'Pairing session ended. Please try again.';
        } else {
          qrStatus.textContent = 'Connection lost. Retrying...';
        }
        qrStatus.style.color = 'var(--danger)';
        btn.disabled = false;
        btn.textContent = 'Start Pairing';
        es.close();
      };
    }
  </script>
</body>
</html>`;
}
