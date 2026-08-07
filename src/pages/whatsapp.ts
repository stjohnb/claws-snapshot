import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, htmlOpenTag, buildPageHeader, THEME_SCRIPT, ALPINE_SCRIPT, whatsappLabel } from "./layout.js";
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
        <button id="pair-btn" class="trigger-btn" @click="startPairing()">Start Pairing</button>
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
  ${HEAD_META}
  <title>WhatsApp — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="whatsappPage()">
  ${buildPageHeader("WhatsApp", theme)}
  ${THEME_SCRIPT}
  ${statusSection}
  <div style="margin-top: 2rem;">
    <h2 style="font-size: 1.1rem; font-weight: 600; margin-bottom: 0.75rem;">Recent Events</h2>
    <div x-data="waEvents()" x-init="load(); setInterval(() => load(), 30000)">
      <template x-if="events.length === 0">
        <p style="color: var(--text-secondary); font-size: 0.875rem;">No events recorded yet.</p>
      </template>
      <template x-if="events.length > 0">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.875rem;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border);">
              <th style="text-align: left; padding: 0.4rem 0.75rem; color: var(--text-secondary); font-weight: 500;">Time</th>
              <th style="text-align: left; padding: 0.4rem 0.75rem; color: var(--text-secondary); font-weight: 500;">Event</th>
              <th style="text-align: left; padding: 0.4rem 0.75rem; color: var(--text-secondary); font-weight: 500;">Detail</th>
            </tr>
          </thead>
          <tbody>
            <template x-for="ev in events" :key="ev.id">
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 0.4rem 0.75rem; white-space: nowrap; color: var(--text-secondary);" x-text="fmtTime(ev.occurred_at)"></td>
                <td style="padding: 0.4rem 0.75rem; white-space: nowrap;">
                  <span :class="badgeClass(ev.event_type)" style="display: inline-block; padding: 0.1rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500;" x-text="ev.event_type"></span>
                </td>
                <td style="padding: 0.4rem 0.75rem; color: var(--text-secondary);" x-text="ev.detail || ''"></td>
              </tr>
            </template>
          </tbody>
        </table>
      </template>
    </div>
  </div>
  <script>
    function whatsappPage() {
      return {
        es: null,
        startPairing() {
          const btn = document.getElementById('pair-btn');
          btn.disabled = true;
          btn.textContent = 'Pairing...';
          const qrArea = document.getElementById('qr-area');
          qrArea.style.display = 'block';
          const qrImg = document.getElementById('qr-img');
          const qrStatus = document.getElementById('qr-status');
          this.es = new EventSource('/whatsapp/pair');
          this.es.onmessage = (e) => {
            const event = JSON.parse(e.data);
            if (event.type === 'qr') {
              qrImg.src = event.dataUrl;
              qrStatus.textContent = 'Scan the QR code with WhatsApp > Linked Devices > Link a Device';
            } else if (event.type === 'connected') {
              qrStatus.textContent = 'Connected successfully!';
              qrStatus.style.color = 'var(--success)';
              this.es.close();
              setTimeout(() => location.reload(), 1500);
            } else if (event.type === 'timeout') {
              qrStatus.textContent = 'Pairing timed out. Please try again.';
              qrStatus.style.color = 'var(--danger)';
              btn.disabled = false;
              btn.textContent = 'Start Pairing';
              this.es.close();
            } else if (event.type === 'error') {
              qrStatus.textContent = 'Error: ' + event.message;
              qrStatus.style.color = 'var(--danger)';
              btn.disabled = false;
              btn.textContent = 'Start Pairing';
              this.es.close();
            }
          };
          this.es.onerror = () => {
            if (this.es.readyState === EventSource.CLOSED) {
              qrStatus.textContent = 'Pairing session ended. Please try again.';
            } else {
              qrStatus.textContent = 'Connection lost. Retrying...';
            }
            qrStatus.style.color = 'var(--danger)';
            btn.disabled = false;
            btn.textContent = 'Start Pairing';
            this.es.close();
          };
        },
      };
    }
    function waEvents() {
      return {
        events: [],
        load() {
          fetch('/whatsapp/events').then(r => r.json()).then(d => { this.events = d; }).catch(() => {});
        },
        fmtTime(ts) {
          if (!ts) return '';
          const d = new Date(ts + (ts.endsWith('Z') ? '' : 'Z'));
          const diff = Math.floor((Date.now() - d.getTime()) / 1000);
          if (diff < 60) return diff + 's ago';
          if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
          if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
          return Math.floor(diff / 86400) + 'd ago';
        },
        badgeClass(type) {
          const map = {
            connected: 'badge-green',
            disconnected: 'badge-red',
            'auth-cleared': 'badge-red',
            'logged-out': 'badge-red',
            'restart-required': 'badge-yellow',
            'message-received': 'badge-blue',
            'pairing-required': 'badge-orange',
            'connection-replaced': 'badge-red',
          };
          return map[type] || 'badge-gray';
        },
      };
    }
  </script>
  <style>
    .badge-green { background: #d1fae5; color: #065f46; }
    .badge-red { background: #fee2e2; color: #991b1b; }
    .badge-yellow { background: #fef9c3; color: #854d0e; }
    .badge-blue { background: #dbeafe; color: #1e40af; }
    .badge-orange { background: #ffedd5; color: #9a3412; }
    .badge-gray { background: #f3f4f6; color: #374151; }
    @media (prefers-color-scheme: dark) {
      .badge-green { background: #064e3b; color: #6ee7b7; }
      .badge-red { background: #7f1d1d; color: #fca5a5; }
      .badge-yellow { background: #713f12; color: #fde047; }
      .badge-blue { background: #1e3a5f; color: #93c5fd; }
      .badge-orange { background: #7c2d12; color: #fdba74; }
      .badge-gray { background: #374151; color: #d1d5db; }
    }
  </style>
</body>
</html>`;
}
