import type { Theme } from "./layout.js";
import { PAGE_CSS, escapeHtml, htmlOpenTag, buildNav, THEME_SCRIPT } from "./layout.js";
import { getConfigForDisplay } from "../config.js";
import * as config from "../config.js";

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
    kwyjiboBaseUrl: "KWYJIBO_BASE_URL",
    kwyjiboApiKey: "KWYJIBO_AUTOMATION_API_KEY",
    whatsappEnabled: "WHATSAPP_ENABLED",
    whatsappAllowedNumbers: "WHATSAPP_ALLOWED_NUMBERS",
    openaiApiKey: "OPENAI_API_KEY",
    emailUser: "CLAWS_EMAIL_USER",
    emailAppPassword: "BRENDAN_SERVER_GMAIL_APP_PASSWORD",
    emailRecipient: "CLAWS_EMAIL_RECIPIENT",
    emailEnabled: "CLAWS_EMAIL_ENABLED",
    authToken: "CLAWS_AUTH_TOKEN",
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

  const intervals = cfg.intervals as Record<string, number>;
  const schedules = cfg.schedules as Record<string, number>;
  const authDisabled = !config.AUTH_TOKEN;

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — config</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <h1>claws</h1>
  ${buildNav(theme)}
  ${THEME_SCRIPT}
  ${saved ? '<div class="banner">Configuration saved and applied.</div>' : ""}
  ${authDisabled ? '<div class="warning-banner">Authentication is disabled. Set an auth token to protect this interface.</div>' : ""}
  <form method="POST" action="/config" class="config-form">
    <h2>General</h2>
    <label for="githubOwners">GitHub Owners (comma-separated)</label>
    <input type="text" name="githubOwners" id="githubOwners" value="${escapeHtml(Array.isArray(cfg.githubOwners) ? (cfg.githubOwners as string[]).join(", ") : "")}"${isDisabled("githubOwners") ? " disabled" : ""}>
    ${envNote("githubOwners")}

    <label for="selfRepo">Self Repo</label>
    <input type="text" name="selfRepo" id="selfRepo" value="${escapeHtml(String(cfg.selfRepo ?? ""))}"${isDisabled("selfRepo") ? " disabled" : ""}>
    ${envNote("selfRepo")}

    <label for="logRetentionDays">Log Retention (days)</label>
    <input type="number" name="logRetentionDays" id="logRetentionDays" value="${Number(cfg.logRetentionDays)}" min="1">

    <label for="logRetentionPerJob">Min Logs Kept Per Job</label>
    <input type="number" name="logRetentionPerJob" id="logRetentionPerJob" value="${Number(cfg.logRetentionPerJob)}" min="0">

    <h2>Server</h2>
    <label for="port">Port</label>
    <input type="number" name="port" id="port" value="${Number(cfg.port)}" disabled>
    <div class="field-note">Read-only — requires restart to change</div>

    <h2>Integrations</h2>
    <label for="slackWebhook">Slack Webhook</label>
    <input type="password" name="slackWebhook" id="slackWebhook" placeholder="${escapeHtml(String(cfg.slackWebhook ?? ""))}"${isDisabled("slackWebhook") ? " disabled" : ""}>
    ${envNote("slackWebhook")}
    <div class="field-note">Leave empty to keep current value</div>

    <label for="slackBotToken">Slack Bot Token (Ideas)</label>
    <input type="password" name="slackBotToken" id="slackBotToken" placeholder="${escapeHtml(String(cfg.slackBotToken ?? ""))}"${isDisabled("slackBotToken") ? " disabled" : ""}>
    ${envNote("slackBotToken")}
    <div class="field-note">Leave empty to keep current value</div>

    <label for="slackIdeasChannel">Slack Ideas Channel ID</label>
    <input type="text" name="slackIdeasChannel" id="slackIdeasChannel" value="${escapeHtml(String(cfg.slackIdeasChannel ?? ""))}"${isDisabled("slackIdeasChannel") ? " disabled" : ""}>
    ${envNote("slackIdeasChannel")}

    <label for="kwyjiboBaseUrl">Kwyjibo Base URL</label>
    <input type="text" name="kwyjiboBaseUrl" id="kwyjiboBaseUrl" value="${escapeHtml(String(cfg.kwyjiboBaseUrl ?? ""))}"${isDisabled("kwyjiboBaseUrl") ? " disabled" : ""}>
    ${envNote("kwyjiboBaseUrl")}

    <label for="kwyjiboApiKey">Kwyjibo API Key</label>
    <input type="password" name="kwyjiboApiKey" id="kwyjiboApiKey" placeholder="${escapeHtml(String(cfg.kwyjiboApiKey ?? ""))}"${isDisabled("kwyjiboApiKey") ? " disabled" : ""}>
    ${envNote("kwyjiboApiKey")}
    <div class="field-note">Leave empty to keep current value</div>

    <label for="whatsappEnabled">WhatsApp Enabled</label>
    <div><input type="checkbox" name="whatsappEnabled" id="whatsappEnabled" value="true"${cfg.whatsappEnabled ? " checked" : ""} disabled>
    <span class="field-note">Read-only — requires restart. Pair via <a href="/whatsapp">/whatsapp</a></span></div>

    <label for="whatsappAllowedNumbers">WhatsApp Allowed Numbers (comma-separated)</label>
    <input type="text" name="whatsappAllowedNumbers" id="whatsappAllowedNumbers" value="${escapeHtml(Array.isArray(cfg.whatsappAllowedNumbers) ? (cfg.whatsappAllowedNumbers as string[]).join(", ") : "")}"${isDisabled("whatsappAllowedNumbers") ? " disabled" : ""}>
    ${envNote("whatsappAllowedNumbers")}

    <label for="openaiApiKey">OpenAI API Key</label>
    <input type="password" name="openaiApiKey" id="openaiApiKey" placeholder="${escapeHtml(String(cfg.openaiApiKey ?? ""))}"${isDisabled("openaiApiKey") ? " disabled" : ""}>
    ${envNote("openaiApiKey")}
    <div class="field-note">Leave empty to keep current value</div>

    <h2>Email</h2>
    <label for="emailEnabled">Email Enabled</label>
    <div><input type="checkbox" name="emailEnabled" id="emailEnabled" value="true"${cfg.emailEnabled ? " checked" : ""} disabled>
    <span class="field-note">Read-only — requires restart</span></div>

    <label for="emailUser">Email User</label>
    <input type="text" name="emailUser" id="emailUser" value="${escapeHtml(String(cfg.emailUser ?? ""))}"${isDisabled("emailUser") ? " disabled" : ""}>
    ${envNote("emailUser")}

    <label for="emailAppPassword">Email App Password</label>
    <input type="password" name="emailAppPassword" id="emailAppPassword" placeholder="${escapeHtml(String(cfg.emailAppPassword ?? ""))}"${isDisabled("emailAppPassword") ? " disabled" : ""}>
    ${envNote("emailAppPassword")}
    <div class="field-note">Leave empty to keep current value</div>

    <label for="emailRecipient">Email Recipient</label>
    <input type="text" name="emailRecipient" id="emailRecipient" value="${escapeHtml(String(cfg.emailRecipient ?? ""))}">

    <label for="emailVegBoxSender">Veg Box Sender Filter</label>
    <input type="text" name="emailVegBoxSender" id="emailVegBoxSender" value="${escapeHtml(String(cfg.emailVegBoxSender ?? ""))}">
    <div class="field-note">IMAP FROM filter — matches against the forwarding sender's address</div>

    <h2>Runners</h2>
    <label for="runners">Runner Hosts (JSON)</label>
    <textarea name="runners" id="runners" rows="8">${escapeHtml(JSON.stringify(cfg.runners ?? [], null, 2))}</textarea>
    <div class="field-note">Format: [{"name": "...", "host": "...", "user": "...", "identityFile": "~/.ssh/...", "actionsDir": "/path/to/actions-runner"}]</div>

    <h2>Intervals (minutes)</h2>
    ${Object.entries(intervals).map(([key, value]) =>
      `<label for="${escapeHtml(key)}">${escapeHtml(key.replace(/Ms$/, ""))}</label>
      <input type="number" name="interval_${escapeHtml(key)}" id="${escapeHtml(key)}" value="${Math.round(value / 60000)}" min="1">`
    ).join("\n    ")}

    <h2>Schedules (hour, 0-23)</h2>
    ${Object.entries(schedules).map(([key, value]) =>
      `<label for="${escapeHtml(key)}">${escapeHtml(key.replace(/Hour$/, ""))}</label>
      <input type="number" name="schedule_${escapeHtml(key)}" id="${escapeHtml(key)}" value="${value}" min="0" max="23">`
    ).join("\n    ")}

    <h2>Authentication</h2>
    <label for="authToken">Auth Token</label>
    <input type="password" name="authToken" id="authToken" placeholder="${escapeHtml(String(cfg.authToken ?? ""))}"${isDisabled("authToken") ? " disabled" : ""}>
    ${envNote("authToken")}
    <div class="field-note">Leave empty to keep current value</div>

    <button type="submit" class="save-btn">Save Configuration</button>
  </form>
</body>
</html>`;
}
