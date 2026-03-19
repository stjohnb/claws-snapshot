export type Theme = "dark" | "light" | "system";

const LIGHT_THEME_VARS = `
    --bg: #ffffff;
    --bg-secondary: #f6f8fa;
    --text: #1f2328;
    --text-secondary: #656d76;
    --text-subtle: #8b949e;
    --accent: #0969da;
    --border: #d0d7de;
    --border-hover: #afb8c1;
    --success: #1a7f37;
    --danger: #cf222e;
    --warning: #9a6700;
    --btn-bg: #f3f4f6;
    --btn-hover: #e5e7eb;
    --save-bg: #1a7f37;
    --save-hover: #2da44e;
    --save-border: #2da44e;
    --banner-bg: #dafbe1;
    --banner-border: #4ac26b;
    --warn-banner-bg: #fff8c5;
    --warn-banner-border: #d4a72c;
    --log-debug: #8b949e;`;

export const PAGE_CSS = `
    :root {
      --bg: #0d1117;
      --bg-secondary: #161b22;
      --text: #c9d1d9;
      --text-secondary: #8b949e;
      --text-subtle: #484f58;
      --accent: #58a6ff;
      --border: #21262d;
      --border-hover: #30363d;
      --success: #3fb950;
      --danger: #f85149;
      --warning: #d29922;
      --btn-bg: #21262d;
      --btn-hover: #30363d;
      --save-bg: #238636;
      --save-hover: #2ea043;
      --save-border: #2ea043;
      --banner-bg: #1f352a;
      --banner-border: #2ea043;
      --warn-banner-bg: #3b2e1a;
      --warn-banner-border: #d29922;
      --log-debug: #6e7681;
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {${LIGHT_THEME_VARS}
      }
    }
    [data-theme="light"] {${LIGHT_THEME_VARS}
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
      min-height: 100vh;
      min-height: 100dvh;
    }
    h1 { color: var(--accent); margin-bottom: 1.5rem; font-size: 1.5rem; }
    h2 { color: var(--text-secondary); margin: 1.5rem 0 0.75rem; font-size: 1.1rem; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    nav { margin-bottom: 1.5rem; font-size: 0.9rem; display: flex; align-items: center; gap: 1rem; }
    .meta {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.5rem 1rem;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
    }
    .meta dt { color: var(--text-secondary); }
    .meta dd { color: var(--text); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th {
      text-align: left;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border);
      padding: 0.5rem 0.5rem 0.5rem 0;
    }
    td {
      padding: 0.5rem 0.5rem 0.5rem 0;
      border-bottom: 1px solid var(--border);
    }
    @media (max-width: 600px) {
      body { padding: 1rem; }
    }
    .running {
      color: var(--success);
      font-weight: 600;
    }
    .running::before {
      content: "";
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      margin-right: 6px;
      animation: pulse 1.5s ease-in-out infinite;
    }
    .idle { color: var(--text-secondary); }
    .idle::before {
      content: "";
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-secondary);
      margin-right: 6px;
    }
    .paused { color: var(--warning); font-weight: 600; }
    .paused::before {
      content: "";
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--warning);
      margin-right: 6px;
    }
    .paused-btn { color: var(--warning); }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .refresh-note {
      margin-top: 1.5rem;
      font-size: 0.75rem;
      color: var(--text-subtle);
    }
    .trigger-btn {
      background: var(--btn-bg);
      color: var(--accent);
      border: 1px solid var(--border-hover);
      border-radius: 4px;
      padding: 0.25rem 0.75rem;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .trigger-btn:hover { background: var(--btn-hover); }
    .trigger-btn:disabled { opacity: 0.6; cursor: default; }
    .status-completed { color: var(--success); }
    .status-failed { color: var(--danger); }
    .status-running { color: var(--warning); }
    .filter-bar { margin-bottom: 1rem; }
    .filter-bar a {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      margin-right: 0.4rem;
      margin-bottom: 0.4rem;
      border: 1px solid var(--border-hover);
      border-radius: 4px;
      font-size: 0.8rem;
    }
    .slack-untested { color: var(--warning); }
    .slack-untested::before {
      content: "";
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--warning);
      margin-right: 6px;
    }
    .slack-error { color: var(--danger); }
    .slack-error::before {
      content: "";
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--danger);
      margin-right: 6px;
    }
    .filter-bar a.active {
      background: var(--btn-bg);
      border-color: var(--accent);
    }
    .search-bar { margin-bottom: 0.75rem; display: flex; gap: 0.5rem; }
    .search-bar input {
      padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 4px;
      background: var(--bg); color: var(--text); font-size: 0.85rem; flex: 1; max-width: 320px;
    }
    .search-bar button {
      padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 4px;
      background: var(--btn-bg); color: var(--text); cursor: pointer; font-size: 0.85rem;
    }
    .search-bar button:hover { background: var(--btn-hover); }
    .recent-items { margin-bottom: 0.5rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
    .recent-label { font-size: 0.8rem; color: var(--text-secondary); }
    .recent-item-btn {
      display: inline-block; padding: 0.2rem 0.5rem; border-radius: 12px;
      font-size: 0.75rem; text-decoration: none; color: var(--text);
      border: 1px solid var(--border); background: var(--bg-secondary);
    }
    .recent-item-btn:hover { border-color: var(--accent); background: var(--btn-hover); }
    .work-item-badge {
      display: inline-block; padding: 0.15rem 0.45rem; border-radius: 12px;
      font-size: 0.75rem; text-decoration: none; color: var(--text);
      border: 1px solid var(--border); margin: 0.1rem;
    }
    .work-item-badge:hover { border-color: var(--accent); }
    .work-item-badge.status-completed { border-color: var(--success); }
    .work-item-badge.status-failed { border-color: var(--danger); }
    .work-items { margin-bottom: 1rem; }
    .work-item-status { color: var(--text-secondary); }
    .log-output {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1rem;
      overflow-x: auto;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 0.8rem;
      line-height: 1.6;
    }
    .log-output .log-line { white-space: pre-wrap; word-break: break-all; }
    .log-output .log-warn { color: var(--warning); }
    .log-output .log-error { color: var(--danger); }
    .log-output .log-info { color: var(--text-secondary); }
    .log-output .log-debug { color: var(--log-debug); }
    .log-output .log-hidden { display: none; }
    .config-form label {
      display: block;
      color: var(--text-secondary);
      font-size: 0.85rem;
      margin-bottom: 0.25rem;
      margin-top: 0.75rem;
    }
    .config-form input[type="text"],
    .config-form input[type="number"],
    .config-form input[type="password"] {
      width: 100%;
      background: var(--bg-secondary);
      border: 1px solid var(--border-hover);
      border-radius: 4px;
      color: var(--text);
      padding: 0.4rem 0.6rem;
      font-size: 0.9rem;
    }
    .config-form input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .config-form input[type="checkbox"] {
      width: auto;
      margin-right: 0.5rem;
    }
    .config-form .field-note {
      font-size: 0.75rem;
      color: var(--text-subtle);
      margin-top: 0.15rem;
    }
    .config-form .env-note {
      font-size: 0.75rem;
      color: var(--warning);
      margin-top: 0.15rem;
    }
    .save-btn {
      margin-top: 1.5rem;
      background: var(--save-bg);
      color: #fff;
      border: 1px solid var(--save-border);
      border-radius: 6px;
      padding: 0.5rem 1.5rem;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .save-btn:hover { background: var(--save-hover); }
    .banner {
      background: var(--banner-bg);
      border: 1px solid var(--banner-border);
      border-radius: 6px;
      padding: 0.6rem 1rem;
      margin-bottom: 1rem;
      color: var(--success);
      font-size: 0.9rem;
    }
    .warning-banner {
      background: var(--warn-banner-bg);
      border: 1px solid var(--warn-banner-border);
      border-radius: 6px;
      padding: 0.6rem 1rem;
      margin-bottom: 1rem;
      color: var(--warning);
      font-size: 0.9rem;
    }
    .login-form {
      max-width: 400px;
      margin: 4rem auto;
    }
    .login-form input[type="password"] {
      width: 100%;
      background: var(--bg-secondary);
      border: 1px solid var(--border-hover);
      border-radius: 4px;
      color: var(--text);
      padding: 0.5rem 0.75rem;
      font-size: 1rem;
      margin-bottom: 1rem;
    }
    .login-error {
      color: var(--danger);
      font-size: 0.9rem;
      margin-bottom: 1rem;
    }
    .queue-section { margin-bottom: 2rem; }
    .queue-group { margin-bottom: 1rem; }
    .queue-group-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .queue-label {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .queue-count {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }
    .queue-item {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      padding: 0.3rem 0 0.3rem 1rem;
      font-size: 0.85rem;
      border-bottom: 1px solid var(--border);
    }
    .queue-item .repo { color: var(--text-secondary); min-width: 6rem; }
    .queue-item .number { min-width: 3rem; }
    .queue-item .title { flex: 1; color: var(--text); }
    .queue-item .time { color: var(--text-subtle); font-size: 0.75rem; white-space: nowrap; }
    .queue-item .check { font-size: 0.85rem; min-width: 1.2rem; text-align: center; }
    .queue-item .check-pass { color: var(--success); }
    .queue-item .check-fail { color: var(--danger); }
    .queue-item .check-pending { color: var(--text-subtle); }
    .queue-item .type-badge {
      font-size: 0.65rem;
      font-weight: 600;
      padding: 0.1rem 0.3rem;
      border-radius: 4px;
      background: var(--btn-bg);
      color: var(--text-secondary);
    }
    .merge-btn {
      font-size: 0.75rem;
      padding: 0.2rem 0.5rem;
      border: 1px solid var(--success);
      background: var(--success);
      color: #fff;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .merge-btn:hover { opacity: 0.85; }
    .merge-btn:disabled { opacity: 0.5; cursor: default; }
    .queue-empty { color: var(--text-subtle); font-style: italic; font-size: 0.85rem; padding: 0.5rem 0; }
    .queue-stale { margin-top: 1.5rem; font-size: 0.75rem; color: var(--text-subtle); }
    #theme-select {
      margin-left: auto;
      background: var(--btn-bg);
      color: var(--text);
      border: 1px solid var(--border-hover);
      border-radius: 4px;
      padding: 0.2rem 0.4rem;
      font-size: 0.8rem;
      cursor: pointer;
    }
`;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function repoShortName(fullName: string): string {
  const slash = fullName.indexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

export function itemLogsUrl(repo: string, itemNumber: number): string {
  return `/logs/issue?repo=${encodeURIComponent(repo)}&number=${itemNumber}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "—";
  const ms = new Date(completedAt + "Z").getTime() - new Date(startedAt + "Z").getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

export function formatRelativeTime(isoDate: string): string {
  if (!isoDate) return "";
  const ms = Date.now() - Date.parse(isoDate);
  if (ms < 0) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "soon";
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `in ${hours}h ${mins % 60}m`;
  if (mins > 0) return `in ${mins}m`;
  return `in ${secs}s`;
}

export function htmlOpenTag(theme: Theme): string {
  if (theme === "system") return '<html lang="en">';
  return `<html lang="en" data-theme="${theme}">`;
}

export function buildNav(theme: Theme): string {
  const options = ["system", "light", "dark"] as const;
  const labels: Record<string, string> = { system: "System", light: "Light", dark: "Dark" };
  const selectHtml = options
    .map(v => `<option value="${v}"${v === theme ? " selected" : ""}>${labels[v]}</option>`)
    .join("");
  return `<nav><a href="/">Dashboard</a><a href="/queue">Queue</a><a href="/logs">Logs</a><a href="/whatsapp">WhatsApp</a><a href="/config">Config</a><select id="theme-select" onchange="setTheme(this.value)">${selectHtml}</select></nav>`;
}

export const THEME_SCRIPT = `<script>function setTheme(v){document.cookie="claws_theme="+v+";Path=/;SameSite=Strict;Max-Age=31536000";if(v==="system"){document.documentElement.removeAttribute("data-theme")}else{document.documentElement.setAttribute("data-theme",v)}}</script>`;

export function slackLabel(slack: {
  configured: boolean;
  lastResult: "ok" | "error" | null;
}): { text: string; cls: string } {
  if (!slack.configured) return { text: "Not configured", cls: "idle" };
  if (slack.lastResult === null)
    return { text: "Configured (untested)", cls: "slack-untested" };
  if (slack.lastResult === "ok") return { text: "Connected", cls: "running" };
  return { text: "Error", cls: "slack-error" };
}

export function slackBotLabel(slackBot: {
  configured: boolean;
}): { text: string; cls: string } {
  if (!slackBot.configured) return { text: "Not configured", cls: "idle" };
  return { text: "Configured", cls: "running" };
}

export function emailLabel(email: {
  configured: boolean;
  lastCheck: string | null;
  lastError: string | null;
}): { text: string; cls: string } {
  if (!email.configured) return { text: "Not configured", cls: "idle" };
  if (email.lastError) return { text: "Error", cls: "slack-error" };
  if (email.lastCheck) return { text: "Connected", cls: "running" };
  return { text: "Configured (untested)", cls: "slack-untested" };
}

export function whatsappLabel(wa: {
  configured: boolean;
  connected: boolean;
  pairingRequired: boolean;
}): { text: string; cls: string; link: boolean } {
  if (!wa.configured) return { text: "Not configured", cls: "idle", link: false };
  if (wa.connected) return { text: "Connected", cls: "running", link: true };
  if (wa.pairingRequired) return { text: "Pairing required", cls: "slack-error", link: true };
  return { text: "Disconnected", cls: "slack-error", link: true };
}
