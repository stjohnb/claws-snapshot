import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT } from "./layout.js";

export interface ErrorPageAction { href: string; label: string; method?: "post" }

export function buildErrorPage(
  theme: Theme,
  opts: { status: number; heading: string; message: string; detail?: string; actions?: ErrorPageAction[] },
): string {
  const actions = opts.actions && opts.actions.length > 0 ? opts.actions : [{ href: "/", label: "← Dashboard" }];
  const detailHtml = opts.detail ? `<p><code>${escapeHtml(opts.detail)}</code></p>` : "";
  const actionsHtml = actions
    .map((a) => a.method === "post"
      ? `<form method="post" action="${escapeHtml(a.href)}" style="display:inline" onsubmit="var b=this.querySelector('button'); if(b) b.textContent='Working…';"><button class="trigger-btn" type="submit">${escapeHtml(a.label)}</button></form>`
      : `<a class="trigger-btn" href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`)
    .join("\n    ");

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
  ${detailHtml}
  <div class="error-actions">
    ${actionsHtml}
  </div>
</body>
</html>`;
}
