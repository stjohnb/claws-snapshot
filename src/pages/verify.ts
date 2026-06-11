import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, LOCAL_TIME_SCRIPT } from "./layout.js";
import type { VerificationReport } from "../jobs/connectivity-verifier.js";
import type { ActivationState } from "../config.js";

export function buildVerifyPage(
  report: VerificationReport | null,
  activationState: ActivationState,
  theme: Theme,
): string {
  const activationBadge =
    activationState === "active"
      ? `<span style="color:#0e8a16;font-weight:600">ACTIVE</span>`
      : `<span style="color:#d93f0b;font-weight:600">VERIFY-ONLY</span>`;

  const rows = report
    ? report.checks
        .map((c) => {
          const status = c.ok
            ? `<span style="color:#0e8a16">OK</span>`
            : `<span style="color:#d73a4a">FAIL</span>`;
          return `<tr>
          <td>${escapeHtml(c.name)}</td>
          <td>${status}</td>
          <td>${c.ms}ms</td>
          <td><code>${escapeHtml(c.detail ?? "")}</code></td>
        </tr>`;
        })
        .join("\n")
    : `<tr><td colspan="4">No verification report yet. Click "Re-run verification" above to generate one.</td></tr>`;

  const generatedAt = report
    ? `<p>Report generated: <time class="local-time" datetime="${escapeHtml(report.generatedAt)}">${escapeHtml(report.generatedAt)}</time></p>`
    : "";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — verify</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  table.verify { border-collapse: collapse; width: 100%; margin-top: 1em; }
  table.verify th, table.verify td { border: 1px solid #ccc; padding: 0.4em 0.6em; text-align: left; vertical-align: top; }
  table.verify th { background: rgba(0,0,0,0.04); }
  table.verify code { font-size: 0.85em; word-break: break-word; }
  </style>
</head>
<body>
  ${buildPageHeader("Verify", theme)}
  ${THEME_SCRIPT}
  <p>Activation state: ${activationBadge}</p>
  <p>This page shows the latest connectivity verification report. In <strong>verify-only</strong> mode, no jobs run — the deployment is isolated from all external side-effects while this page is used to sanity-check credentials and connectivity. Slack and email are reachability-checked only (DNS / IMAP login), so this page does not send any messages.</p>
  <form method="POST" action="/api/verify/run" style="margin: 1em 0">
    <button type="submit">Re-run verification</button>
  </form>
  ${generatedAt}
  <table class="verify">
    <thead><tr><th>Check</th><th>Status</th><th>Duration</th><th>Detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${LOCAL_TIME_SCRIPT}
</body>
</html>`;
}
