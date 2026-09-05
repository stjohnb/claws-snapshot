/** Env keys that must never leak into a child/interactive session in strict mode. */
export const SENSITIVE_ENV_KEYS = [
  "CLAWS_HOME_ASSISTANT_TOKEN", "HOME_ASSISTANT_TOKEN",
  "OPENAI_API_KEY",
  "CLAWS_OPENROUTER_API_KEY", "OPENROUTER_API_KEY",
  "CLAWS_AUTH_TOKEN",
  "CLAWS_OIDC_CLIENT_SECRET",
  "CLAWS_SLACK_BOT_TOKEN", "CLAWS_SLACK_WEBHOOK", "CLAWS_SLACK_WEBHOOK_URL",
  "BRENDAN_SERVER_GMAIL_APP_PASSWORD",
  // Injected by deploy/container-entrypoint.sh, which writes each to disk and
  // then unsets it; listed here so the strip list — not the entrypoint — is
  // the boundary, and so a systemd host that exports them is covered too.
  "CLAWS_SSH_PRIVATE_KEY", "CLAWS_KUBECONFIG",
  "CLAWS_CODEX_AUTH_JSON", "CLAWS_CLAUDE_SETTINGS_JSON",
  "CLAWS_FORGEJO_TOKEN",
  "CLAWS_SLACK_PROD_ALERTS_WEBHOOK",
] as const;
