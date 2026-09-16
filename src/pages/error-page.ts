import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT } from "./layout.js";

export interface ErrorPageAction { href: string; label: string; method?: "post" }

export interface ErrorPageRetry {
  action: string;
  fields: Array<{ name: string; value: string }>;
  elapsedMs: number;
}

export function buildErrorPage(
  theme: Theme,
  opts: { status: number; heading: string; message: string; detail?: string; actions?: ErrorPageAction[]; retry?: ErrorPageRetry },
): string {
  const actions = opts.actions && opts.actions.length > 0 ? opts.actions : [{ href: "/", label: "← Dashboard" }];
  const detailHtml = opts.detail ? `<p><code>${escapeHtml(opts.detail)}</code></p>` : "";
  const actionsHtml = actions
    .map((a) => a.method === "post"
      ? `<form method="post" action="${escapeHtml(a.href)}" style="display:inline" onsubmit="var b=this.querySelector('button'); if(b) b.textContent='Working…';"><button class="trigger-btn" type="submit">${escapeHtml(a.label)}</button></form>`
      : `<a class="trigger-btn" href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`)
    .join("\n    ");

  const retryLine = opts.retry ? `\n  ${buildRetryHtml(opts.retry)}` : "";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>${opts.status} — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .error-heading { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 1.4rem; font-weight: 200; letter-spacing: 0.04em; color: var(--text); margin: 1.5rem 0 0.5rem; }
  .error-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1.25rem; }
  </style>
</head>
<body>
  ${buildPageHeader(String(opts.status), theme)}
  ${THEME_SCRIPT}
  <p class="error-heading">${escapeHtml(opts.heading)}</p>
  <p>${escapeHtml(opts.message)}</p>
  ${detailHtml}${retryLine}
  <div class="error-actions">
    ${actionsHtml}
  </div>
</body>
</html>`;
}

function buildRetryHtml(retry: ErrorPageRetry): string {
  const elapsedSeconds = Math.round(retry.elapsedMs / 1000);
  const fieldsHtml = retry.fields
    .map((f) => `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value)}">`)
    .join("\n    ");

  const script = [
    "<script>",
    "(function() {",
    "  var t0 = Date.now();",
    "  var base = " + elapsedSeconds + ";",
    "  var done = false;",
    "  var statusEl = document.getElementById('claws-retry-status');",
    "  var elapsedEl = document.getElementById('claws-retry-elapsed');",
    "  var form = document.getElementById('claws-retry-form');",
    "  var btn = document.getElementById('claws-retry-now');",
    "  if (btn) btn.onclick = function() { done = true; };",
    "  var tickTimer = setInterval(function() {",
    "    if (done) return;",
    "    var secs = Math.round(base + (Date.now() - t0) / 1000);",
    "    if (elapsedEl) elapsedEl.textContent = secs + 's';",
    "  }, 1000);",
    "  var pollTimer = setInterval(function() {",
    "    if (done) return;",
    "    fetch('/health', { cache: 'no-store' }).then(function(res) {",
    "      if (!res.ok) return null;",
    "      return res.json();",
    "    }).then(function(j) {",
    "      if (done || !j) return;",
    "      if (j.shuttingDown === false) {",
    "        done = true;",
    "        if (statusEl) statusEl.textContent = 'Server is back — retrying…';",
    "        if (form) form.submit();",
    "      }",
    "    }).catch(function() {});",
    "  }, 2000);",
    "  setTimeout(function() {",
    "    if (done) return;",
    "    clearInterval(tickTimer);",
    "    clearInterval(pollTimer);",
    "    if (statusEl) statusEl.textContent = 'Still restarting after 10 minutes — use Retry now.';",
    "  }, 600000);",
    "})();",
    "</script>",
  ].join("\n  ");

  return `<p id="claws-retry-status">Shutdown requested <span id="claws-retry-elapsed">${elapsedSeconds}s</span> ago — retrying automatically when the server is back…</p>
  <form method="post" action="${escapeHtml(retry.action)}" id="claws-retry-form">
    ${fieldsHtml}
    <button class="trigger-btn" type="submit" id="claws-retry-now">Retry now</button>
  </form>
  ${script}`;
}
