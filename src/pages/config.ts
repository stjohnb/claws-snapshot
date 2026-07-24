import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, ALPINE_SCRIPT } from "./layout.js";
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

  const intervals = cfg.intervals as Record<string, number>;
  const schedules = cfg.schedules as Record<string, number>;
  const providerLabels: Record<string, string> = { claude: "Anthropic (Claude)", codex: "OpenAI (Codex)", opencode: "OpenCode (via OpenRouter)", openrouter: "OpenRouter (direct)" };

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

  <h2>Activation</h2>
  <p style="margin-bottom:0.5em">Current state:
    ${config.ACTIVATION_STATE === "active"
      ? `<strong style="color:#0e8a16">active</strong> — scheduler runs jobs, WhatsApp pairs, external side-effects are live.`
      : `<strong style="color:#d93f0b">verify-only</strong> — no jobs run. Deployment is isolated while you validate connectivity via <a href="/verify">/verify</a>.`}
  </p>
  <div class="field-note" style="margin-bottom:0.5em">Toggling activation requires a process restart so jobs and WhatsApp can be re-initialised cleanly. After clicking, restart this process (e.g. <code>kubectl rollout restart statefulset/claws</code> or <code>systemctl restart claws</code>).</div>
  ${config.ACTIVATION_STATE === "active"
    ? `<button type="button" onclick="claws_setActivation('verify-only')" style="background:#d93f0b;color:#fff;padding:0.4em 0.8em;border:none;border-radius:3px;cursor:pointer">Switch to verify-only</button>`
    : `<button type="button" onclick="claws_setActivation('active')" style="background:#0e8a16;color:#fff;padding:0.4em 0.8em;border:none;border-radius:3px;cursor:pointer">Activate (run jobs)</button>`}
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

  ${(() => {
    const unknownKeys = Array.from(getUnknownConfigKeys());
    if (unknownKeys.length === 0) return "";
    return `<div style="background-color:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:1em;margin-bottom:1.5em">
      <h2 style="margin-top:0;color:#856404">Unknown Config Keys</h2>
      <p style="color:#856404">The following keys in your config.json are not recognized and will be ignored. You can remove them to clean up your configuration:</p>
      <ul style="color:#856404">
        ${unknownKeys.map(k => `<li><code>${escapeHtml(k)}</code></li>`).join("")}
      </ul>
      <form method="POST" action="/config/remove-unknown-keys" style="display:inline">
        <button type="submit" style="background-color:#dc3545;color:white;border:none;padding:0.5em 1em;border-radius:4px;cursor:pointer">Remove Unknown Keys</button>
      </form>
    </div>`;
  })()}
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

    <label for="notifyDashboardActions">Notify Dashboard Actions via Slack</label>
    <div><input type="checkbox" name="notifyDashboardActions" id="notifyDashboardActions" value="true"${cfg.notifyDashboardActions !== false ? " checked" : ""}>
    <span class="field-note">Send Slack notifications for configuration and activation changes (pause/resume, config edits, activation flip, WhatsApp pairing). Routine actions (queue triage, session lifecycle, merges, cancellations) never notify.</span></div>

    <label for="k3sMonitorEnabled">K3s Monitor Enabled</label>
    <div><input type="checkbox" name="k3sMonitorEnabled" id="k3sMonitorEnabled" value="true"${cfg.k3sMonitorEnabled !== false ? " checked" : ""}${isDisabled("k3sMonitorEnabled") ? " disabled" : ""}>
    <span class="field-note">Monitor k3s cluster pod health and report alerts to GitHub issues</span></div>
    ${envNote("k3sMonitorEnabled")}

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

    <h2>Runners</h2>
    <label for="runners">Runner Hosts (JSON)</label>
    <textarea name="runners" id="runners" rows="8">${escapeHtml(JSON.stringify(cfg.runners ?? [], null, 2))}</textarea>
    <div class="field-note">Format: [{"name": "...", "host": "...", "user": "...", "identityFile": "~/.ssh/...", "actionsDir": "/path/to/actions-runner"}]</div>

    <label>Mac Runner Enrolment (mac-runner-waker)</label>
    <div class="field-note">Untick a Mac to stop waking it — no SSH attempt and no alerts while it is off the LAN.</div>
    ${(Array.isArray(cfg.macRunners) ? cfg.macRunners as MacRunner[] : []).map((r) => {
      const enabled = r.enabled !== false;
      return `<label style="display:block"><input type="checkbox" name="macRunnerEnabled_${escapeHtml(r.host)}"${enabled ? " checked" : ""}> ${escapeHtml(r.name ?? r.host)} <span class="field-note">(${escapeHtml(r.host)})</span></label>`;
    }).join("\n    ")}
    <input type="hidden" name="macRunnerHosts" value="${escapeHtml((Array.isArray(cfg.macRunners) ? (cfg.macRunners as MacRunner[]) : []).map(r => r.host).join(","))}">

    <label for="macRunners">Mac Runners (JSON)</label>
    <textarea name="macRunners" id="macRunners" rows="8">${escapeHtml(JSON.stringify(cfg.macRunners ?? [], null, 2))}</textarea>
    <div class="field-note">Format: [{"name": "...", "host": "...", "labels": ["macos","xcode26"]}]</div>

    <label for="macRunnerRepos">Mac Runner Repos (comma-separated)</label>
    <input type="text" name="macRunnerRepos" id="macRunnerRepos" value="${escapeHtml(Array.isArray(cfg.macRunnerRepos) ? (cfg.macRunnerRepos as string[]).join(", ") : "")}">
    <div class="field-note">Repos to poll for queued Mac jobs, e.g. "owner/repo"</div>

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

    <h3>SSO (authentik / OIDC)</h3>
    <label for="oidcBaseUrl">Authentik Base URL</label>
    <input type="text" name="oidcBaseUrl" id="oidcBaseUrl" value="${escapeHtml(String(cfg.oidcBaseUrl ?? ""))}"${isDisabled("oidcBaseUrl") ? " disabled" : ""}>
    ${envNote("oidcBaseUrl")}
    <div class="field-note">e.g. https://auth.home.bstjohn.net — all four OIDC fields are required to enable login; without them the dashboard is inaccessible</div>

    <label for="oidcApplicationSlug">Application Slug</label>
    <input type="text" name="oidcApplicationSlug" id="oidcApplicationSlug" value="${escapeHtml(String(cfg.oidcApplicationSlug ?? ""))}"${isDisabled("oidcApplicationSlug") ? " disabled" : ""}>
    ${envNote("oidcApplicationSlug")}
    <div class="field-note">The application slug in authentik (e.g. claws)</div>

    <label for="oidcClientId">Client ID</label>
    <input type="text" name="oidcClientId" id="oidcClientId" value="${escapeHtml(String(cfg.oidcClientId ?? ""))}"${isDisabled("oidcClientId") ? " disabled" : ""}>
    ${envNote("oidcClientId")}

    <label for="oidcClientSecret">Client Secret</label>
    <input type="password" name="oidcClientSecret" id="oidcClientSecret" placeholder="${escapeHtml(String(cfg.oidcClientSecret ?? ""))}"${isDisabled("oidcClientSecret") ? " disabled" : ""}>
    ${envNote("oidcClientSecret")}
    <div class="field-note">Leave empty to keep current value</div>

    <label for="oidcRedirectUri">Redirect URI</label>
    <input type="text" name="oidcRedirectUri" id="oidcRedirectUri" value="${escapeHtml(String(cfg.oidcRedirectUri ?? ""))}"${isDisabled("oidcRedirectUri") ? " disabled" : ""}>
    ${envNote("oidcRedirectUri")}
    <div class="field-note">e.g. https://claws.home.bstjohn.net/auth/callback</div>

    <h2>Disabled Agents</h2>
    <div class="field-note">Uncheck agents to disable them within the issue-dispatcher/pr-dispatcher jobs.</div>
    ${VALID_AGENT_NAMES.map((name) => {
      const checked = !(Array.isArray(cfg.disabledAgents) && (cfg.disabledAgents as string[]).includes(name));
      return `<div><input type="checkbox" name="enabledAgent_${escapeHtml(name)}" id="agent_${escapeHtml(name)}" value="true"${checked ? " checked" : ""}>
      <label for="agent_${escapeHtml(name)}" style="display:inline">${escapeHtml(name)}</label></div>`;
    }).join("\n    ")}

    <h2>AI Providers</h2>
    <label for="openrouterApiKey">OpenRouter API Key</label>
    <input type="password" name="openrouterApiKey" id="openrouterApiKey" placeholder="${escapeHtml(String(cfg.openrouterApiKey ?? ""))}"${isDisabled("openrouterApiKey") ? " disabled" : ""}>
    ${envNote("openrouterApiKey")}
    <div class="field-note">Leave empty to keep current value. Required for OpenCode/OpenRouter provider.</div>

    <label for="ollamaBaseUrl">Ollama Base URL</label>
    <input type="text" name="ollamaBaseUrl" id="ollamaBaseUrl" value="${escapeHtml(String(cfg.ollamaBaseUrl ?? "https://ollama.home.bstjohn.net"))}">
    <div class="field-note">Base URL for local Ollama instance used for rate-limit classification</div>

    <label for="ollamaTimeoutMs">Ollama Classification Timeout (seconds)</label>
    <input type="number" name="ollamaTimeoutMs" id="ollamaTimeoutMs" value="${Math.round(Number(cfg.ollamaTimeoutMs ?? 60000) / 1000)}" min="5">
    <div class="field-note">Timeout for Ollama queries. Use 60+ seconds to allow cold GPU model loading.</div>

    <label for="ollamaConsecutiveFailuresBeforeDisable">Consecutive Failures Before Skipping Ollama</label>
    <input type="number" name="ollamaConsecutiveFailuresBeforeDisable" id="ollamaConsecutiveFailuresBeforeDisable" value="${Number(cfg.ollamaConsecutiveFailuresBeforeDisable ?? 3)}" min="1">
    <div class="field-note">After this many consecutive Ollama failures, skip for 5 minutes and use regex fallback</div>

    ${(() => {
      const renderFallbackFieldset = (group: "toolUse" | "textOnly", legend: string, helpText: string, current: ReadonlyArray<string>) => {
        const primary = current[0] ?? "claude";
        const primaryHtml = (["claude", "codex", "opencode", "openrouter"] as const).map(p => {
          const checked = primary === p ? " checked" : "";
          // OpenCode is "configured" if claws has the OpenRouter key OR if
          // the opencode CLI is installed (it may be authenticated via its own
          // `opencode auth login` config, which claws has no direct visibility
          // into). Only show the "no API key" hint if neither is available.
          const opencodeAvailable = !!cfg.openrouterApiKey || isOpenCodeBinaryAvailable();
          const noKey = p === "opencode" && !opencodeAvailable ? ' <span style="color:#888;font-size:0.85em">(no API key set)</span>' : "";
          return `<div><input type="radio" name="${group}_primaryProvider" value="${p}" id="${group}_provider_${p}"${checked}> <label for="${group}_provider_${p}" style="display:inline">${providerLabels[p]}${noKey}</label></div>`;
        }).join("\n        ");
        const fallbackHtml = (["claude", "codex", "opencode", "openrouter"] as const).map(p => {
          const checked = current.slice(1).includes(p) ? " checked" : "";
          const disabled = primary === p ? " disabled" : "";
          return `<div><input type="checkbox" name="${group}_fallback_${p}" value="true" id="${group}_fallback_${p}"${checked}${disabled}> <label for="${group}_fallback_${p}" style="display:inline">${providerLabels[p]}</label></div>`;
        }).join("\n        ");
        return `<fieldset style="border:1px solid #ccc;padding:0.75em 1em;margin-bottom:0.5em">
      <legend>${legend}</legend>
      <div class="field-note" style="margin-bottom:0.5em">${helpText}</div>
      <strong>Primary</strong>
        ${primaryHtml}
      <strong style="display:block;margin-top:0.5em">Fallbacks</strong>
        ${fallbackHtml}
    </fieldset>`;
      };
      const toolUseOrder = Array.isArray(cfg.toolUseProviderFallbackOrder) && cfg.toolUseProviderFallbackOrder.length > 0
        ? cfg.toolUseProviderFallbackOrder as string[] : ["claude"];
      const textOnlyOrder = Array.isArray(cfg.textOnlyProviderFallbackOrder) && cfg.textOnlyProviderFallbackOrder.length > 0
        ? cfg.textOnlyProviderFallbackOrder as string[] : ["opencode"];
      return [
        renderFallbackFieldset("toolUse", "Tool-use Providers", "Workflows that need to edit files, run git, or call gh (issue-worker, ci-fixer, review-addresser, doc-maintainer).", toolUseOrder),
        renderFallbackFieldset("textOnly", "Text-only Providers", "Workflows that only produce text (pr-reviewer, planner, triage, idea-suggester, qa-phase). Route these to cheaper models to preserve Claude quota.", textOnlyOrder),
      ].join("\n    ");
    })()}
    <script>
      function configPage() {
        return {
          init() {
            ["toolUse", "textOnly"].forEach((group) => this.bindGroup(group));
          },
          bindGroup(group) {
            const radios = document.querySelectorAll('input[name="' + group + '_primaryProvider"]');
            const savedStates = {};
            const update = () => {
              const selected = document.querySelector('input[name="' + group + '_primaryProvider"]:checked');
              if (!selected) return;
              const primary = selected.value;
              ["claude","codex","opencode","openrouter"].forEach((p) => {
                const cb = document.getElementById(group + "_fallback_" + p);
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

    <label for="providerRateLimitCooldownMs">Provider Rate Limit Cooldown (minutes)</label>
    <input type="number" name="providerRateLimitCooldownMs" id="providerRateLimitCooldownMs" value="${Math.round(Number(cfg.providerRateLimitCooldownMs ?? 300000) / 60000)}" min="1">
    <div class="field-note">How long to skip a rate-limited provider before retrying</div>

    <label for="opencodeBestModel">OpenCode Best Model</label>
    <input type="text" name="opencodeBestModel" id="opencodeBestModel" value="${escapeHtml(String(cfg.opencodeBestModel ?? "openrouter/anthropic/claude-opus-4"))}">
    <div class="field-note">OpenRouter model ID for opus-tier tasks via OpenCode</div>

    <label for="opencodeAdequateModel">OpenCode Adequate Model</label>
    <input type="text" name="opencodeAdequateModel" id="opencodeAdequateModel" value="${escapeHtml(String(cfg.opencodeAdequateModel ?? "openrouter/anthropic/claude-sonnet-4.5"))}">
    <div class="field-note">OpenRouter model ID for sonnet-tier tasks via OpenCode</div>

    <label for="opencodeCheapModel">OpenCode Cheap Model</label>
    <input type="text" name="opencodeCheapModel" id="opencodeCheapModel" value="${escapeHtml(String(cfg.opencodeCheapModel ?? "openrouter/google/gemini-2.5-flash"))}">
    <div class="field-note">OpenRouter model ID for cheap-tier tool-use tasks via OpenCode</div>

    <label for="opencodeTextBestModel">OpenCode Text-only Best Model</label>
    <input type="text" name="opencodeTextBestModel" id="opencodeTextBestModel" value="${escapeHtml(String(cfg.opencodeTextBestModel ?? "openrouter/google/gemini-2.5-flash"))}">
    <div class="field-note">OpenRouter model ID for opus-tier text-only tasks (PR review, plans, triage). Must support tool calling — opencode always sends tool schemas in requests.</div>

    <label for="opencodeTextAdequateModel">OpenCode Text-only Adequate Model</label>
    <input type="text" name="opencodeTextAdequateModel" id="opencodeTextAdequateModel" value="${escapeHtml(String(cfg.opencodeTextAdequateModel ?? "openrouter/google/gemini-2.5-flash"))}">
    <div class="field-note">OpenRouter model ID for sonnet-tier text-only tasks. Must support tool calling.</div>

    <label for="opencodeTextCheapModel">OpenCode Text-only Cheap Model</label>
    <input type="text" name="opencodeTextCheapModel" id="opencodeTextCheapModel" value="${escapeHtml(String(cfg.opencodeTextCheapModel ?? "openrouter/google/gemini-2.5-flash-lite"))}">
    <div class="field-note">OpenRouter model ID for cheap-tier text-only tasks via OpenCode. Must support tool calling.</div>

    <h3>OpenRouter (direct HTTP)</h3>
    <div class="field-note" style="margin-bottom:0.5em">Direct OpenRouter API backend — no tool schemas attached, so these models do NOT need to support function calling. Ideal for pure text generation (PR review, triage).</div>

    <label for="openrouterBestModel">OpenRouter Best Model</label>
    <input type="text" name="openrouterBestModel" id="openrouterBestModel" value="${escapeHtml(String(cfg.openrouterBestModel ?? "qwen/qwen-2.5-coder-32b-instruct"))}">
    <div class="field-note">OpenRouter model ID for opus-tier direct-HTTP text generation (e.g. PR review)</div>

    <label for="openrouterAdequateModel">OpenRouter Adequate Model</label>
    <input type="text" name="openrouterAdequateModel" id="openrouterAdequateModel" value="${escapeHtml(String(cfg.openrouterAdequateModel ?? "qwen/qwen-2.5-coder-32b-instruct"))}">
    <div class="field-note">OpenRouter model ID for sonnet-tier direct-HTTP text generation</div>

    <label for="openrouterCheapModel">OpenRouter Cheap Model</label>
    <input type="text" name="openrouterCheapModel" id="openrouterCheapModel" value="${escapeHtml(String(cfg.openrouterCheapModel ?? "google/gemini-2.5-flash-lite"))}">
    <div class="field-note">OpenRouter model ID for cheap-tier direct-HTTP text generation</div>

    <label for="claudeCheapModel">Claude Cheap Model</label>
    <input type="text" name="claudeCheapModel" id="claudeCheapModel" value="${escapeHtml(String(cfg.claudeCheapModel ?? "claude-haiku-4-5-20251001"))}">
    <div class="field-note">Anthropic model ID for cheap-tier tasks via Claude CLI</div>

    <label for="codexCheapModel">Codex Cheap Model</label>
    <input type="text" name="codexCheapModel" id="codexCheapModel" value="${escapeHtml(String(cfg.codexCheapModel ?? "o4-mini"))}">
    <div class="field-note">OpenAI model ID for cheap-tier tasks via Codex CLI</div>

    <button type="submit" class="save-btn">Save Configuration</button>
  </form>
</body>
</html>`;
}
