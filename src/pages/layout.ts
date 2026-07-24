import type { QueueCategory } from "../github.js";
import * as config from "../config.js";
import { ERROR_HANDLER_SCRIPT } from "../resources/error-handler.generated.js";

export type Theme = "dark" | "light" | "system";

export const CATEGORY_DISPLAY: Record<QueueCategory, { label: string; color: string }> = {
  "ready": { label: "Ready", color: "0e8a16" },
  "needs-refinement": { label: "Needs Refinement", color: "d876e3" },
  "refined": { label: "Refined", color: "0075ca" },
  "needs-review-addressing": { label: "Needs Review Addressing", color: "e4e669" },
  "auto-mergeable": { label: "Auto-Mergeable", color: "0e8a16" },
  "needs-triage": { label: "Needs Triage", color: "d73a49" },
  "needs-qa": { label: "Needs QA", color: "1d76db" },
  "problematic": { label: "Problematic", color: "d73a4a" },
};

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
    html { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 1rem;
      max-width: 1024px;
      margin: 0 auto;
      min-height: 100vh;
      min-height: 100dvh;
    }
    @media (min-width: 768px) {
      body { padding: 2rem; }
    }
    h1 { color: var(--accent); margin-bottom: 1rem; font-size: 1.35rem; font-weight: 700; }
    h2 { color: var(--text-secondary); margin: 1.25rem 0 0.6rem; font-size: 1rem; font-weight: 600; }
    @media (min-width: 768px) {
      h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
      h2 { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; }
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    nav {
      margin-bottom: 1.25rem;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.25rem 0.75rem;
    }
    nav a { padding: 0.3rem 0.1rem; }
    @media (min-width: 768px) {
      nav { font-size: 0.9rem; gap: 0.5rem 1rem; margin-bottom: 1.5rem; }
    }
    .meta {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.5rem 1rem;
      margin-bottom: 1.25rem;
      font-size: 0.875rem;
    }
    .meta dt { color: var(--text-secondary); }
    .meta dd { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th {
      text-align: left;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border);
      padding: 0.5rem 0.5rem 0.5rem 0;
      white-space: nowrap;
    }
    td {
      padding: 0.5rem 0.5rem 0.5rem 0;
      border-bottom: 1px solid var(--border);
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
      padding: 0.35rem 0.75rem;
      cursor: pointer;
      font-size: 0.8rem;
      min-height: 30px;
    }
    .trigger-btn:hover { background: var(--btn-hover); }
    .trigger-btn:disabled { opacity: 0.6; cursor: default; }
    .btn-danger { background: var(--danger); color: #fff; border: none; padding: 0.4rem 1rem; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
    .btn-danger:hover { opacity: 0.85; }
    .btn-danger:disabled { opacity: 0.5; cursor: default; }
    .status-completed { color: var(--success); }
    .status-failed { color: var(--danger); }
    .status-running { color: var(--warning); }
    .status-cancelled { color: var(--text-secondary); }
    .filter-bar { margin-bottom: 1rem; display: flex; flex-wrap: wrap; gap: 0.3rem; }
    .filter-bar a {
      display: inline-block;
      padding: 0.3rem 0.6rem;
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
    .search-bar { margin-bottom: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .search-bar input {
      padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 4px;
      background: var(--bg); color: var(--text); font-size: 0.875rem; flex: 1; min-width: 0; max-width: 320px;
    }
    .search-bar button {
      padding: 0.4rem 0.75rem; border: 1px solid var(--border); border-radius: 4px;
      background: var(--btn-bg); color: var(--text); cursor: pointer; font-size: 0.875rem; min-height: 32px;
    }
    .search-bar button:hover { background: var(--btn-hover); }
    .recent-items { margin-bottom: 0.5rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
    .recent-label { font-size: 0.8rem; color: var(--text-secondary); }
    .recent-item-btn {
      display: inline-block; padding: 0.25rem 0.55rem; border-radius: 12px;
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
    .config-form input[type="password"],
    .config-form textarea {
      width: 100%;
      background: var(--bg-secondary);
      border: 1px solid var(--border-hover);
      border-radius: 4px;
      color: var(--text);
      padding: 0.5rem 0.7rem;
      font-size: 0.9rem;
      font-family: inherit;
    }
    .config-form textarea { font-family: "SFMono-Regular", Consolas, Menlo, monospace; font-size: 0.8rem; }
    .config-form input:disabled, .config-form textarea:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .config-form input[type="checkbox"], .config-form input[type="radio"] {
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
    .config-form fieldset {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      margin: 0.5rem 0;
    }
    .config-form fieldset legend { color: var(--text); font-weight: 600; padding: 0 0.4rem; }
    .save-btn {
      margin-top: 1.5rem;
      background: var(--save-bg);
      color: #fff;
      border: 1px solid var(--save-border);
      border-radius: 6px;
      padding: 0.6rem 1.5rem;
      cursor: pointer;
      font-size: 0.9rem;
      min-height: 38px;
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
      margin: 3rem auto;
    }
    .login-form input[type="password"] {
      width: 100%;
      background: var(--bg-secondary);
      border: 1px solid var(--border-hover);
      border-radius: 4px;
      color: var(--text);
      padding: 0.6rem 0.8rem;
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
      flex-wrap: wrap;
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
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.5rem;
      padding: 0.4rem 0 0.4rem 0.5rem;
      font-size: 0.875rem;
      border-bottom: 1px solid var(--border);
    }
    .queue-item .repo { color: var(--text-secondary); }
    .queue-item .number { color: var(--accent); }
    .queue-item .title { flex: 1 1 100%; color: var(--text); word-break: break-word; }
    @media (min-width: 768px) {
      .queue-item { flex-wrap: nowrap; padding-left: 1rem; }
      .queue-item .repo { min-width: 6rem; }
      .queue-item .number { min-width: 3rem; }
      .queue-item .title { flex: 1 1 auto; }
    }
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
    .pr-label {
      font-size: 0.65rem;
      font-weight: 600;
      padding: 0.1rem 0.4rem;
      border-radius: 10px;
      background: var(--btn-bg);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      white-space: nowrap;
    }
    .merge-conflict {
      font-size: 0.75rem;
      color: var(--danger);
      white-space: nowrap;
    }
    .merge-btn {
      font-size: 0.75rem;
      padding: 0.3rem 0.6rem;
      border: 1px solid var(--success);
      background: var(--success);
      color: #fff;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
      min-height: 30px;
    }
    .merge-btn:hover { opacity: 0.85; }
    .merge-btn:disabled { opacity: 0.5; cursor: default; }
    .queue-empty { color: var(--text-subtle); font-style: italic; font-size: 0.875rem; padding: 0.5rem 0; }
    .queue-stale { margin-top: 1.5rem; font-size: 0.75rem; color: var(--text-subtle); }
    #theme-select {
      margin-left: auto;
      background: var(--btn-bg);
      color: var(--text);
      border: 1px solid var(--border-hover);
      border-radius: 4px;
      padding: 0.3rem 0.4rem;
      font-size: 0.8rem;
      cursor: pointer;
      min-height: 30px;
    }
    .outcome-card {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      padding: 0.6rem 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 1rem;
      font-size: 0.85rem;
      align-items: center;
    }
    .outcome-card.outcome-failed {
      border-color: var(--danger);
    }
    .outcome-stat {
      display: inline-block;
      padding: 0.2rem 0.55rem;
      background: var(--btn-bg);
      border-radius: 4px;
      font-size: 0.8rem;
      white-space: nowrap;
    }
    .outcome-stat.outcome-danger { color: var(--danger); }
    .outcome-stat.outcome-pr { color: var(--accent); }
    .cancel-btn {
      padding: 0.35rem 0.8rem;
      font-size: 0.85rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
      color: var(--text);
      min-height: 32px;
    }
    .cancel-btn:hover:not(:disabled) {
      background: var(--danger);
      color: white;
      border-color: var(--danger);
    }
    .cancel-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .stat-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.75rem 1.25rem;
      min-width: 120px;
      flex: 1 1 120px;
    }
    .stat-card .stat-number { font-size: 1.5rem; font-weight: 700; }
    .stat-card .stat-label { font-size: 0.8rem; color: var(--text-secondary); }
    .stat-grid { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.5rem; }

    /* Mobile card layout: any <table class="data-cards"> inside .table-scroll
       becomes a stack of cards below 768px. Cell labels come from data-label. */
    @media (max-width: 767px) {
      .data-cards thead { display: none; }
      .data-cards, .data-cards tbody { display: block; width: 100%; }
      .data-cards tr {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        padding: 0.6rem 0.75rem;
        margin-bottom: 0.75rem;
      }
      .data-cards td {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        border-bottom: none;
        padding: 0.15rem 0;
        font-size: 0.8125rem;
        min-width: 0;
      }
      .data-cards td::before {
        content: attr(data-label);
        color: var(--text-secondary);
        font-size: 0.75rem;
        flex: 0 0 4.5rem;
      }
      .data-cards td:empty { display: none; }
      .data-cards td.hide-sm { display: none; }
      .data-cards td.cell-title {
        order: -1;
        display: block;
        font-size: 0.95rem;
        font-weight: 600;
        line-height: 1.35;
        margin-bottom: 0.35rem;
        overflow-wrap: anywhere;
      }
      .data-cards td.cell-title::before { content: none; }
      .data-cards td.cell-actions { margin-top: 0.4rem; }
      .data-cards td.cell-actions::before { content: none; }
    }
    @media (min-width: 768px) {
      .table-scroll .data-cards { min-width: 820px; }
    }
    .nav-toggle { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .nav-toggle-label {
      display: inline-block;
      padding: 0.3rem 0.7rem;
      border: 1px solid var(--border-hover);
      border-radius: 4px;
      background: var(--btn-bg);
      color: var(--accent);
      font-size: 0.85rem;
      cursor: pointer;
      user-select: none;
    }
    .nav-toggle:focus-visible + .nav-toggle-label { outline: 2px solid var(--accent); }
    .nav-links { display: none; flex-basis: 100%; flex-wrap: wrap; gap: 0.25rem 0.75rem; }
    .nav-toggle:checked ~ .nav-links { display: flex; }
    @media (min-width: 768px) {
      .nav-toggle-label { display: none; }
      .nav-links { display: flex; flex-basis: auto; gap: 0.5rem 1rem; }
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
  return `<nav><input type="checkbox" id="nav-toggle" class="nav-toggle"><label class="nav-toggle-label" for="nav-toggle">Menu</label><div class="nav-links"><a href="/">Dashboard</a><a href="/queue">Queue</a><a href="/prs">PRs</a><a href="/issues">Issues</a><a href="/topology">Topology</a><a href="/repos">Repos</a><a href="/jobs">Jobs</a><a href="/ha-upgrader">HA</a><a href="/damp">Damp</a><a href="/blog">Blog</a><a href="/k8s">K8s</a><a href="/runners">Runners</a><a href="/usage">Usage</a><a href="/logs">Logs</a><a href="/whatsapp">WhatsApp</a><a href="/sessions">Sessions</a><a href="/claude-auth">Reauth</a><a href="/config">Config</a><a href="/verify">Verify</a><a href="/logout">Logout</a></div><select id="theme-select" onchange="setTheme(this.value)">${selectHtml}</select></nav>`;
}

export function buildPageHeader(
  pageTitle: string | null,
  theme: Theme,
  opts: { showNav?: boolean } = { showNav: true },
): string {
  const nav = opts.showNav === false ? "" : buildNav(theme);
  const subtitle = pageTitle ? `<h2>${escapeHtml(pageTitle)}</h2>` : "";
  const verifyBanner = config.ACTIVATION_STATE === "verify-only"
    ? `<div style="background:#d93f0b;color:#fff;padding:0.5em 1em;margin:0 0 0.5em 0;font-weight:600;border-radius:4px">VERIFY-ONLY MODE — no jobs are running. <a href="/verify" style="color:#fff;text-decoration:underline">Review connectivity checks</a> before toggling to active.</div>`
    : "";
  return `${ERROR_HANDLER_SCRIPT}
<h1>claws</h1>
  ${nav}
  ${verifyBanner}
  ${subtitle}`;
}

// Both stylesheets must coexist: PAGE_CSS owns the component class names
// (.running, .idle, .queue-item, etc.) that live-polling JS references by
// string; Tailwind utilities are additive on top.
export const TAILWIND_STYLESHEET = `<link rel="stylesheet" href="/static/tailwind.css">`;

export const HEAD_META = `<link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#0d1117">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Claws">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="icon" type="image/png" href="/static/icon-192.png">`;

export const THEME_SCRIPT = `<script>function setTheme(v){document.cookie="claws_theme="+v+";Path=/;SameSite=Strict;Max-Age=31536000";if(v==="system"){document.documentElement.removeAttribute("data-theme")}else{document.documentElement.setAttribute("data-theme",v)}}</script>`;

// Pages using this script require `unsafe-eval` in their Content-Security-Policy script-src directive.
export const ALPINE_SCRIPT = `<script src="/static/alpine.js" defer></script>`;

export const LOCAL_TIME_SCRIPT = `<script>
(function() {
  function localizeTimestamps() {
    var els = document.querySelectorAll('time.local-time');
    for (var i = 0; i < els.length; i++) {
      var iso = els[i].getAttribute('datetime');
      if (!iso) continue;
      if (!iso.endsWith('Z') && !/[+\-]\d{2}:\d{2}$/.test(iso)) iso += 'Z';
      try { els[i].textContent = new Date(iso).toLocaleString(); } catch(e) {}
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', localizeTimestamps);
  } else {
    localizeTimestamps();
  }
})();
</script>`;

export function timestampHtml(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}" class="local-time">${escapeHtml(iso)}</time>`;
}

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

export interface AiProviderStatus {
  configured: boolean;
  rateLimited: boolean;
  rateLimitedUntil?: number; // timestamp when cooldown expires (if rateLimited)
  lastUsedAt: string | null; // ISO string or null
  isPrimary?: boolean;
  /**
   * OpenRouter only. Two independent sources of "configured":
   *   - clawsKeyConfigured: claws has CLAWS_OPENROUTER_API_KEY set and injects
   *     it into opencode spawns.
   *   - opencodeCliAvailable: the `opencode` CLI binary is installed and can
   *     use its own `opencode auth login` credentials.
   * Either one is sufficient to run workflows; the dashboard shows both so
   * operators can tell which path is active.
   */
  clawsKeyConfigured?: boolean;
  opencodeCliAvailable?: boolean;
}

function formatRateLimitCooldown(until: number): string {
  const remainingMs = Math.max(0, until - Date.now());
  const totalSecs = Math.ceil(remainingMs / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function providerLabel(s: AiProviderStatus, sourceSuffix = ""): { text: string; cls: string } {
  const primary = s.isPrimary ? " (primary)" : "";
  if (!s.configured) return { text: `Not configured${primary}`, cls: "idle" };
  if (s.rateLimited && s.rateLimitedUntil) {
    return { text: `Rate limited (${formatRateLimitCooldown(s.rateLimitedUntil)})${primary}${sourceSuffix}`, cls: "slack-error" };
  }
  if (s.rateLimited) return { text: `Rate limited${primary}${sourceSuffix}`, cls: "slack-error" };
  if (s.lastUsedAt) return { text: `Active${primary}${sourceSuffix}`, cls: "running" };
  return { text: `Idle${primary}${sourceSuffix}`, cls: "idle" };
}

export function anthropicLabel(s: AiProviderStatus): { text: string; cls: string } {
  return providerLabel(s);
}

export function openaiLabel(s: AiProviderStatus): { text: string; cls: string } {
  return providerLabel(s);
}

/**
 * Label for the opencode provider (which routes through OpenRouter via the
 * opencode CLI). The "configured" status has two independent sources —
 * claws-supplied CLAWS_OPENROUTER_API_KEY and the opencode CLI's own
 * `opencode auth login` credentials — and we surface both.
 */
export function opencodeLabel(s: AiProviderStatus): { text: string; cls: string } {
  const sources: string[] = [];
  if (s.clawsKeyConfigured) sources.push("claws key");
  if (s.opencodeCliAvailable) sources.push("opencode CLI");
  const sourceSuffix = sources.length > 0 ? ` · via ${sources.join(" + ")}` : "";
  return providerLabel(s, sourceSuffix);
}

/**
 * Label for the direct-OpenRouter HTTP provider. Configured iff claws has
 * CLAWS_OPENROUTER_API_KEY — the opencode CLI's own auth does not help here
 * since the direct path calls OpenRouter's API straight from claws.
 */
export function openrouterLabel(s: AiProviderStatus): { text: string; cls: string } {
  return providerLabel(s);
}

export function homeAssistantLabel(ha: {
  configured: boolean;
  lastCheck: string | null;
  lastError: string | null;
}): { text: string; cls: string } {
  if (!ha.configured) return { text: "Not configured", cls: "idle" };
  if (ha.lastError) return { text: "Error", cls: "slack-error" };
  if (ha.lastCheck) return { text: "Connected", cls: "running" };
  return { text: "Configured (untested)", cls: "slack-untested" };
}

export function k8sIntegrationLabel(s: {
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  nodesNotReady: number;
  podAlertCount: number;
  nodeAlertCount: number;
  fluxAlertCount: number;
} | null): { text: string; cls: string } {
  if (!s || !s.enabled) return { text: "Disabled", cls: "idle" };
  if (s.lastError) return { text: "Error", cls: "slack-error" };
  if (!s.lastRunAt) return { text: "Configured (untested)", cls: "slack-untested" };
  if (s.nodesNotReady > 0 || s.podAlertCount > 0 || s.nodeAlertCount > 0 || s.fluxAlertCount > 0)
    return { text: "Degraded", cls: "slack-error" };
  return { text: "Healthy", cls: "running" };
}
