import type { Theme } from "./layout.js";
import {
  PAGE_CSS,
  TAILWIND_STYLESHEET,
  HEAD_META,
  escapeHtml,
  htmlOpenTag,
  buildPageHeader,
  THEME_SCRIPT,
  ALPINE_SCRIPT,
} from "./layout.js";
import { getConfigForDisplay, VALID_AGENT_NAMES, getUnknownConfigKeys } from "../config.js";
import * as config from "../config.js";
import type { MacRunner } from "../config.js";
import { isOpenCodeBinaryAvailable } from "../claude.js";

function isEnvOverridden(envVar: string): boolean {
  return process.env[envVar] !== undefined && process.env[envVar] !== "";
}

export function buildConfigPage(saved: boolean, theme: Theme): string {
  const cfg = getConfigForDisplay();

  const envMap: Record<string, string> = {
    slackWebhook: "CLAWS_SLACK_WEBHOOK",
    slackBotToken: "CLAWS_SLACK_BOT_TOKEN",
    slackIdeasChannel: "CLAWS_SLACK_IDEAS_CHANNEL",
    githubOwners: "CLAWS_GITHUB_OWNERS",
    selfRepo: "CLAWS_SELF_REPO",
    port: "PORT",
    whatsappEnabled: "WHATSAPP_ENABLED",
    whatsappAllowedNumbers: "WHATSAPP_ALLOWED_NUMBERS",
    openaiApiKey: "OPENAI_API_KEY",
    emailUser: "CLAWS_EMAIL_USER",
    emailAppPassword: "BRENDAN_SERVER_GMAIL_APP_PASSWORD",
    emailRecipient: "CLAWS_EMAIL_RECIPIENT",
    emailEnabled: "CLAWS_EMAIL_ENABLED",
    oidcClientId: "CLAWS_OIDC_CLIENT_ID",
    oidcClientSecret: "CLAWS_OIDC_CLIENT_SECRET",
    oidcBaseUrl: "CLAWS_OIDC_BASE_URL",
    oidcApplicationSlug: "CLAWS_OIDC_APPLICATION_SLUG",
    oidcRedirectUri: "CLAWS_OIDC_REDIRECT_URI",
    dashboardUrl: "CLAWS_DASHBOARD_URL",
    k3sMonitorEnabled: "CLAWS_K3S_MONITOR_ENABLED",
    openrouterApiKey: "CLAWS_OPENROUTER_API_KEY",
  };

  function envNote(key: string): string {
    const envVar = envMap[key];
    if (envVar && isEnvOverridden(envVar)) {
      return `<div class="env-note">Set via environment variable ${escapeHtml(envVar)}</div>`;
    }
    return "";
  }

  function isDisabled(key: string): boolean {
    const envVar = envMap[key];
    return !!(envVar && isEnvOverridden(envVar));
  }

  function renderField(opts: {
    name: string;
    label: string;
    value: string;
    note?: string;
    type?: "text" | "number";
    min?: number;
    max?: number;
    disabled?: boolean;
  }): string {
    const { name, label, value, note, type = "text", min, max, disabled = false } = opts;
    return `<div class="config-field">
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <input type="${type}" name="${escapeHtml(name)}" id="${escapeHtml(name)}" value="${escapeHtml(value)}"${min !== undefined ? ` min="${min}"` : ""}${max !== undefined ? ` max="${max}"` : ""}${disabled ? " disabled" : ""}>
      ${note ?? ""}
    </div>`;
  }

  function renderSecretField(opts: {
    name: string;
    label: string;
    placeholder: string;
    note?: string;
    disabled?: boolean;
  }): string {
    const { name, label, placeholder, note, disabled = false } = opts;
    return `<div class="config-field">
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <input type="password" name="${escapeHtml(name)}" id="${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}"${disabled ? " disabled" : ""}>
      ${note ?? ""}
    </div>`;
  }

  function renderTextareaField(opts: {
    name: string;
    label: string;
    value: string;
    note?: string;
    rows?: number;
    disabled?: boolean;
  }): string {
    const { name, label, value, note, rows = 8, disabled = false } = opts;
    return `<div class="config-field config-field-full">
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <textarea name="${escapeHtml(name)}" id="${escapeHtml(name)}" rows="${rows}"${disabled ? " disabled" : ""}>${escapeHtml(value)}</textarea>
      ${note ?? ""}
    </div>`;
  }

  function renderCheckboxField(opts: {
    name: string;
    label: string;
    checked: boolean;
    note?: string;
    value?: string;
    disabled?: boolean;
  }): string {
    const { name, label, checked, note, value = "true", disabled = false } = opts;
    return `<div class="config-field config-field-full">
      <label class="config-check" for="${escapeHtml(name)}">
        <input type="checkbox" name="${escapeHtml(name)}" id="${escapeHtml(name)}" value="${escapeHtml(value)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}>
        <span>${escapeHtml(label)}</span>
      </label>
      ${note ?? ""}
    </div>`;
  }

  function renderStatusRow(label: string, value: string, note?: string): string {
    return `<div class="config-status-row">
      <div class="config-status-label">${escapeHtml(label)}</div>
      <div class="config-status-value">${escapeHtml(value)}</div>
      ${note ? `<div class="field-note">${note}</div>` : ""}
    </div>`;
  }

  function renderSection(title: string, body: string, open = false): string {
    return `<details class="config-section"${open ? " open" : ""}>
      <summary>${escapeHtml(title)}</summary>
      <div class="config-section-body">${body}</div>
    </details>`;
  }

  function joinNotes(...notes: Array<string | undefined>): string {
    return notes.filter(Boolean).join("");
  }

  const intervals = cfg.intervals as Record<string, number>;
  const schedules = cfg.schedules as Record<string, number>;
  const providerLabels: Record<string, string> = {
    claude: "Anthropic (Claude)",
    codex: "OpenAI (Codex)",
    opencode: "OpenCode (via OpenRouter)",
  };
  const unknownKeys = Array.from(getUnknownConfigKeys());
  const macRunners = Array.isArray(cfg.macRunners) ? cfg.macRunners as MacRunner[] : [];

  const generalSection = renderSection("General", [
    renderField({
      name: "githubOwners",
      label: "GitHub Owners (comma-separated)",
      value: Array.isArray(cfg.githubOwners) ? (cfg.githubOwners as string[]).join(", ") : "",
      note: envNote("githubOwners"),
      disabled: isDisabled("githubOwners"),
    }),
    renderField({
      name: "selfRepo",
      label: "Self Repo",
      value: String(cfg.selfRepo ?? ""),
      note: envNote("selfRepo"),
      disabled: isDisabled("selfRepo"),
    }),
    renderField({
      name: "logRetentionDays",
      label: "Log Retention (days)",
      value: String(Number(cfg.logRetentionDays)),
      type: "number",
      min: 1,
    }),
    renderField({
      name: "logRetentionPerJob",
      label: "Min Logs Kept Per Job",
      value: String(Number(cfg.logRetentionPerJob)),
      type: "number",
      min: 0,
    }),
    renderCheckboxField({
      name: "notifyDashboardActions",
      label: "Notify Dashboard Actions via Slack",
      checked: cfg.notifyDashboardActions !== false,
      note: '<div class="field-note">Send Slack notifications for configuration and activation changes (pause/resume, config edits, activation flip, WhatsApp pairing). Routine actions (queue triage, session lifecycle, merges, cancellations) never notify.</div>',
    }),
    renderCheckboxField({
      name: "k3sMonitorEnabled",
      label: "K3s Monitor Enabled",
      checked: cfg.k3sMonitorEnabled !== false,
      note: joinNotes(
        '<div class="field-note">Monitor k3s cluster pod health and report alerts to GitHub issues</div>',
        envNote("k3sMonitorEnabled"),
      ),
      disabled: isDisabled("k3sMonitorEnabled"),
    }),
  ].join(""), true);

  const integrationsSection = renderSection("Integrations", [
    renderSecretField({
      name: "slackWebhook",
      label: "Slack Webhook",
      placeholder: String(cfg.slackWebhook ?? ""),
      note: joinNotes(
        envNote("slackWebhook"),
        '<div class="field-note">Leave empty to keep current value</div>',
      ),
      disabled: isDisabled("slackWebhook"),
    }),
    renderSecretField({
      name: "slackBotToken",
      label: "Slack Bot Token (Ideas)",
      placeholder: String(cfg.slackBotToken ?? ""),
      note: joinNotes(
        envNote("slackBotToken"),
        '<div class="field-note">Leave empty to keep current value</div>',
      ),
      disabled: isDisabled("slackBotToken"),
    }),
    renderField({
      name: "slackIdeasChannel",
      label: "Slack Ideas Channel ID",
      value: String(cfg.slackIdeasChannel ?? ""),
      note: envNote("slackIdeasChannel"),
      disabled: isDisabled("slackIdeasChannel"),
    }),
    renderStatusRow(
      "WhatsApp Enabled",
      cfg.whatsappEnabled ? "Enabled" : "Disabled",
      'Read-only status. Requires restart to change. Pair via <a href="/whatsapp">/whatsapp</a>.',
    ),
    renderField({
      name: "whatsappAllowedNumbers",
      label: "WhatsApp Allowed Numbers (comma-separated)",
      value: Array.isArray(cfg.whatsappAllowedNumbers) ? (cfg.whatsappAllowedNumbers as string[]).join(", ") : "",
      note: envNote("whatsappAllowedNumbers"),
      disabled: isDisabled("whatsappAllowedNumbers"),
    }),
    renderSecretField({
      name: "openaiApiKey",
      label: "OpenAI API Key",
      placeholder: String(cfg.openaiApiKey ?? ""),
      note: joinNotes(
        envNote("openaiApiKey"),
        '<div class="field-note">Leave empty to keep current value</div>',
      ),
      disabled: isDisabled("openaiApiKey"),
    }),
  ].join(""));

  const emailSection = renderSection("Email", [
    renderStatusRow(
      "Email Enabled",
      cfg.emailEnabled ? "Enabled" : "Disabled",
      "Read-only status. Requires restart to change.",
    ),
    renderField({
      name: "emailUser",
      label: "Email User",
      value: String(cfg.emailUser ?? ""),
      note: envNote("emailUser"),
      disabled: isDisabled("emailUser"),
    }),
    renderSecretField({
      name: "emailAppPassword",
      label: "Email App Password",
      placeholder: String(cfg.emailAppPassword ?? ""),
      note: joinNotes(
        envNote("emailAppPassword"),
        '<div class="field-note">Leave empty to keep current value</div>',
      ),
      disabled: isDisabled("emailAppPassword"),
    }),
    renderField({
      name: "emailRecipient",
      label: "Email Recipient",
      value: String(cfg.emailRecipient ?? ""),
      note: envNote("emailRecipient"),
      disabled: isDisabled("emailRecipient"),
    }),
  ].join(""));

  const runnerEnrollment = macRunners.map((runner) => {
    const enabled = runner.enabled !== false;
    const id = `macRunnerEnabled_${runner.host}`;
    return `<label class="config-check" for="${escapeHtml(id)}">
      <input type="checkbox" name="${escapeHtml(id)}" id="${escapeHtml(id)}"${enabled ? " checked" : ""}>
      <span>${escapeHtml(runner.name ?? runner.host)} <span class="field-note">(${escapeHtml(runner.host)})</span></span>
    </label>`;
  }).join("");

  const runnersSection = renderSection("Runners", [
    renderTextareaField({
      name: "runners",
      label: "Runner Hosts (JSON)",
      value: JSON.stringify(cfg.runners ?? [], null, 2),
      note: '<div class="field-note">Format: [{"name","host","user","identityFile", "actionsDir": "/path/to/actions-runner"}] — for a NixOS systemd runner use {"serviceUnit": "github-runner-&lt;name&gt;", "workDir": "/var/lib/...-work", "toolDir": "/var/lib/...-tool"} instead of actionsDir</div>',
    }),
    `<div class="config-field config-field-full">
      <label>Mac Runner Enrolment (mac-runner-waker)</label>
      <div class="field-note">Untick a Mac to stop waking it — no SSH attempt and no alerts while it is off the LAN.</div>
      <div class="config-check-group">${runnerEnrollment}</div>
      <input type="hidden" name="macRunnerHosts" value="${escapeHtml(macRunners.map((runner) => runner.host).join(","))}">
    </div>`,
    renderTextareaField({
      name: "macRunners",
      label: "Mac Runners (JSON)",
      value: JSON.stringify(cfg.macRunners ?? [], null, 2),
      note: '<div class="field-note">Format: [{"name": "...", "host": "...", "labels": ["macos","xcode26"]}]</div>',
    }),
    renderField({
      name: "macRunnerRepos",
      label: "Mac Runner Repos (comma-separated)",
      value: Array.isArray(cfg.macRunnerRepos) ? (cfg.macRunnerRepos as string[]).join(", ") : "",
      note: '<div class="field-note">Repos to poll for queued Mac jobs, e.g. "owner/repo"</div>',
    }),
  ].join(""));

  const schedulingSection = renderSection("Scheduling", [
    `<div class="config-subsection">
      <h3>Intervals (minutes)</h3>
      <div class="config-grid">
        ${Object.entries(intervals).map(([key, value]) => renderField({
          name: `interval_${key}`,
          label: key.replace(/Ms$/, ""),
          value: String(Math.round(value / 60000)),
          type: "number",
          min: 1,
        })).join("")}
      </div>
    </div>`,
    `<div class="config-subsection">
      <h3>Schedules (hour, 0-23)</h3>
      <div class="config-grid">
        ${Object.entries(schedules).map(([key, value]) => renderField({
          name: `schedule_${key}`,
          label: key.replace(/Hour$/, ""),
          value: String(value),
          type: "number",
          min: 0,
          max: 23,
        })).join("")}
      </div>
    </div>`,
  ].join(""));

  const authenticationSection = renderSection("Authentication", [
    `<div class="config-subsection">
      <h3>SSO (authentik / OIDC)</h3>
      <div class="config-grid">
        ${renderField({
          name: "oidcBaseUrl",
          label: "Authentik Base URL",
          value: String(cfg.oidcBaseUrl ?? ""),
          note: joinNotes(
            envNote("oidcBaseUrl"),
            '<div class="field-note">e.g. https://auth.home.bstjohn.net — all four OIDC fields are required to enable login; without them the dashboard is inaccessible</div>',
          ),
          disabled: isDisabled("oidcBaseUrl"),
        })}
        ${renderField({
          name: "oidcApplicationSlug",
          label: "Application Slug",
          value: String(cfg.oidcApplicationSlug ?? ""),
          note: joinNotes(
            envNote("oidcApplicationSlug"),
            '<div class="field-note">The application slug in authentik (e.g. claws)</div>',
          ),
          disabled: isDisabled("oidcApplicationSlug"),
        })}
        ${renderField({
          name: "oidcClientId",
          label: "Client ID",
          value: String(cfg.oidcClientId ?? ""),
          note: envNote("oidcClientId"),
          disabled: isDisabled("oidcClientId"),
        })}
        ${renderSecretField({
          name: "oidcClientSecret",
          label: "Client Secret",
          placeholder: String(cfg.oidcClientSecret ?? ""),
          note: joinNotes(
            envNote("oidcClientSecret"),
            '<div class="field-note">Leave empty to keep current value</div>',
          ),
          disabled: isDisabled("oidcClientSecret"),
        })}
        ${renderField({
          name: "oidcRedirectUri",
          label: "Redirect URI",
          value: String(cfg.oidcRedirectUri ?? ""),
          note: joinNotes(
            envNote("oidcRedirectUri"),
            '<div class="field-note">e.g. https://claws.home.bstjohn.net/auth/callback</div>',
          ),
          disabled: isDisabled("oidcRedirectUri"),
        })}
        ${renderField({
          name: "dashboardUrl",
          label: "Dashboard URL",
          value: String(cfg.dashboardUrl ?? ""),
          note: joinNotes(
            envNote("dashboardUrl"),
            '<div class="field-note">e.g. https://claws.home.bstjohn.net — used for links in Slack alerts; defaults to the OIDC redirect URI\'s origin</div>',
          ),
          disabled: isDisabled("dashboardUrl"),
        })}
      </div>
    </div>`,
  ].join(""));

  const disabledAgentsSection = renderSection("Disabled Agents", [
    '<div class="field-note">Uncheck agents to disable them within the issue-dispatcher/pr-dispatcher jobs.</div>',
    `<div class="config-check-group">
      ${VALID_AGENT_NAMES.map((name) => {
        const checked = !(Array.isArray(cfg.disabledAgents) && (cfg.disabledAgents as string[]).includes(name));
        return `<label class="config-check" for="agent_${escapeHtml(name)}">
          <input type="checkbox" name="enabledAgent_${escapeHtml(name)}" id="agent_${escapeHtml(name)}" value="true"${checked ? " checked" : ""}>
          <span>${escapeHtml(name)}</span>
        </label>`;
      }).join("")}
    </div>`,
  ].join(""));

  const providerOrder = Array.isArray(cfg.providerFallbackOrder) && cfg.providerFallbackOrder.length > 0
    ? cfg.providerFallbackOrder as string[]
    : ["claude"];

  const renderFallbackFieldset = (legend: string, helpText: string, current: ReadonlyArray<string>) => {
    const primary = current[0] ?? "claude";
    const primaryHtml = (["claude", "codex", "opencode"] as const).map((provider) => {
      const checked = primary === provider ? " checked" : "";
      const opencodeAvailable = !!cfg.openrouterApiKey || isOpenCodeBinaryAvailable();
      const noKey = provider === "opencode" && !opencodeAvailable
        ? ' <span class="config-inline-note">(no API key set)</span>'
        : "";
      return `<label class="config-check" for="provider_${provider}">
        <input type="radio" name="primaryProvider" value="${provider}" id="provider_${provider}"${checked}>
        <span>${providerLabels[provider]}${noKey}</span>
      </label>`;
    }).join("");
    const fallbackHtml = (["claude", "codex", "opencode"] as const).map((provider) => {
      const checked = current.slice(1).includes(provider) ? " checked" : "";
      const disabled = primary === provider ? " disabled" : "";
      return `<label class="config-check" for="fallback_${provider}">
        <input type="checkbox" name="fallback_${provider}" value="true" id="fallback_${provider}"${checked}${disabled}>
        <span>${providerLabels[provider]}</span>
      </label>`;
    }).join("");
    return `<fieldset class="provider-fieldset">
      <legend>${escapeHtml(legend)}</legend>
      <div class="field-note">${helpText}</div>
      <div class="provider-fieldset-group">
        <strong>Primary</strong>
        <div class="config-check-group">${primaryHtml}</div>
      </div>
      <div class="provider-fieldset-group">
        <strong>Fallbacks</strong>
        <div class="config-check-group">${fallbackHtml}</div>
      </div>
    </fieldset>`;
  };

  const aiProvidersSection = renderSection("AI Providers", [
    '<div class="field-note">Pick the global default provider for all agent runs below. The <strong>Use Codex</strong> / <strong>Use Claude</strong> labels override it for a single issue or PR.</div>',
    renderSecretField({
      name: "openrouterApiKey",
      label: "OpenRouter API Key",
      placeholder: String(cfg.openrouterApiKey ?? ""),
      note: joinNotes(
        envNote("openrouterApiKey"),
        '<div class="field-note">Leave empty to keep current value. Required for the OpenCode provider.</div>',
      ),
      disabled: isDisabled("openrouterApiKey"),
    }),
    renderField({
      name: "ollamaBaseUrl",
      label: "Ollama Base URL",
      value: String(cfg.ollamaBaseUrl ?? "https://ollama.home.bstjohn.net"),
      note: '<div class="field-note">Base URL for local Ollama instance used for rate-limit classification</div>',
    }),
    renderField({
      name: "ollamaTimeoutMs",
      label: "Ollama Classification Timeout (seconds)",
      value: String(Math.round(Number(cfg.ollamaTimeoutMs ?? 60000) / 1000)),
      type: "number",
      min: 5,
      note: '<div class="field-note">Timeout for Ollama queries. Use 60+ seconds to allow cold GPU model loading.</div>',
    }),
    renderField({
      name: "ollamaConsecutiveFailuresBeforeDisable",
      label: "Consecutive Failures Before Skipping Ollama",
      value: String(Number(cfg.ollamaConsecutiveFailuresBeforeDisable ?? 3)),
      type: "number",
      min: 1,
      note: '<div class="field-note">After this many consecutive Ollama failures, skip for 5 minutes and use regex fallback</div>',
    }),
    `<div class="config-field config-field-full">
      ${renderFallbackFieldset("AI Providers", "Primary provider for all agent runs, and the order to fall back through when it is rate-limited or fails.", providerOrder)}
    </div>`,
    renderField({
      name: "providerRateLimitCooldownMs",
      label: "Provider Rate Limit Cooldown (minutes)",
      value: String(Math.round(Number(cfg.providerRateLimitCooldownMs ?? 300000) / 60000)),
      type: "number",
      min: 1,
      note: '<div class="field-note">How long to skip a rate-limited provider before retrying</div>',
    }),
    renderField({
      name: "opencodeBestModel",
      label: "OpenCode Best Model",
      value: String(cfg.opencodeBestModel ?? "openrouter/anthropic/claude-opus-4"),
      note: '<div class="field-note">OpenRouter model ID for opus-tier tasks via OpenCode</div>',
    }),
    renderField({
      name: "opencodeAdequateModel",
      label: "OpenCode Adequate Model",
      value: String(cfg.opencodeAdequateModel ?? "openrouter/anthropic/claude-sonnet-4.5"),
      note: '<div class="field-note">OpenRouter model ID for sonnet-tier tasks via OpenCode</div>',
    }),
    renderField({
      name: "opencodeCheapModel",
      label: "OpenCode Cheap Model",
      value: String(cfg.opencodeCheapModel ?? "openrouter/google/gemini-2.5-flash"),
      note: '<div class="field-note">OpenRouter model ID for cheap-tier tasks via OpenCode</div>',
    }),
    renderField({
      name: "improvementIdentifierModel",
      label: "Improvement Identifier Model",
      value: String(cfg.improvementIdentifierModel ?? "openrouter/z-ai/glm-5.3"),
      note: '<div class="field-note">OpenRouter model ID used for improvement-identifier\'s repo analysis via OpenCode</div>',
    }),
    renderField({
      name: "claudeCheapModel",
      label: "Claude Cheap Model",
      value: String(cfg.claudeCheapModel ?? "claude-haiku-4-5-20251001"),
      note: '<div class="field-note">Anthropic model ID for cheap-tier tasks via Claude CLI</div>',
    }),
    renderField({
      name: "codexDefaultModel",
      label: "Codex Default Model",
      value: String(cfg.codexDefaultModel ?? "gpt-5.4"),
      note: '<div class="field-note">OpenAI model ID for opus-tier and deep-planning tasks via Codex CLI</div>',
    }),
    renderField({
      name: "codexLightModel",
      label: "Codex Light Model",
      value: String(cfg.codexLightModel ?? "gpt-5.4"),
      note: '<div class="field-note">OpenAI model ID for sonnet-tier tasks via Codex CLI</div>',
    }),
    renderField({
      name: "codexCheapModel",
      label: "Codex Cheap Model",
      value: String(cfg.codexCheapModel ?? "gpt-5.4-mini"),
      note: '<div class="field-note">OpenAI model ID for cheap-tier tasks via Codex CLI</div>',
    }),
  ].join(""));

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>claws — config</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="configPage()">
  ${buildPageHeader("Config", theme)}
  ${THEME_SCRIPT}
  ${saved ? '<div class="banner">Configuration saved and applied.</div>' : ""}

  <section class="config-static-block">
    <h2>Activation</h2>
    <p class="config-activation-status">Current state:
      ${config.ACTIVATION_STATE === "active"
        ? '<strong class="status-active">active</strong> - scheduler runs jobs, WhatsApp pairs, external side-effects are live.'
        : '<strong class="status-verify-only">verify-only</strong> - no jobs run. Deployment is isolated while you validate connectivity via <a href="/verify">/verify</a>.'}
    </p>
    <div class="field-note">Toggling activation requires a process restart so jobs and WhatsApp can be re-initialised cleanly. After clicking, restart this process (e.g. <code>kubectl rollout restart statefulset/claws</code> or <code>systemctl restart claws</code>).</div>
    ${config.ACTIVATION_STATE === "active"
      ? '<button type="button" onclick="claws_setActivation(\'verify-only\')" class="btn-danger activation-btn">Switch to verify-only</button>'
      : '<button type="button" onclick="claws_setActivation(\'active\')" class="btn-success activation-btn">Activate (run jobs)</button>'}
  </section>
  <script>
    function claws_setActivation(state) {
      if (!confirm("Flip activation to '" + state + "'? You will need to restart the process afterwards.")) return;
      fetch("/api/activation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: state, confirm: true }),
      }).then(function(r) { return r.json(); }).then(function(j) {
        if (j.error) { alert("Error: " + j.error); return; }
        alert("Activation state set to '" + j.state + "'. " + (j.restartRequired ? "Restart required." : ""));
        window.location.reload();
      }).catch(function(err) { alert("Request failed: " + err); });
    }
  </script>

  ${unknownKeys.length === 0 ? "" : `<section class="warning-banner config-static-block config-warning-block">
    <h2>Unknown Config Keys</h2>
    <p>The following keys in your config.json are not recognized and will be ignored. You can remove them to clean up your configuration:</p>
    <ul>
      ${unknownKeys.map((key) => `<li><code>${escapeHtml(key)}</code></li>`).join("")}
    </ul>
    <form method="POST" action="/config/remove-unknown-keys">
      <button type="submit" class="btn-danger">Remove Unknown Keys</button>
    </form>
  </section>`}

  <form method="POST" action="/config" class="config-form">
    ${generalSection}
    ${integrationsSection}
    ${emailSection}
    ${runnersSection}
    ${schedulingSection}
    ${authenticationSection}
    ${disabledAgentsSection}
    ${aiProvidersSection}

    <button type="submit" class="save-btn">Save Configuration</button>
  </form>

  <script>
    function configPage() {
      return {
        init() {
          this.bindGroup();
        },
        bindGroup() {
          const radios = document.querySelectorAll('input[name="primaryProvider"]');
          const savedStates = {};
          const update = () => {
            const selected = document.querySelector('input[name="primaryProvider"]:checked');
            if (!selected) return;
            const primary = selected.value;
            ["claude","codex","opencode"].forEach((p) => {
              const cb = document.getElementById("fallback_" + p);
              if (!cb) return;
              if (p === primary) {
                savedStates[p] = cb.checked;
                cb.disabled = true;
                cb.checked = false;
              } else {
                cb.disabled = false;
                if (Object.prototype.hasOwnProperty.call(savedStates, p)) {
                  cb.checked = savedStates[p];
                  delete savedStates[p];
                }
              }
            });
          };
          radios.forEach((r) => r.addEventListener("change", update));
          update();
        },
      };
    }
  </script>
</body>
</html>`;
}
