/** Env keys that must never leak into a child/interactive session in strict mode. */
export const SENSITIVE_ENV_KEYS = [
  "CLAWS_HOME_ASSISTANT_TOKEN", "HOME_ASSISTANT_TOKEN",
  "CLAWS_PROD_GRAFANA_TOKEN", "CLAWS_FLEET_GRAFANA_TOKEN",
  "OPENAI_API_KEY",
  "CLAWS_OPENROUTER_API_KEY", "OPENROUTER_API_KEY",
  "CLAWS_AUTH_TOKEN",
  "CLAWS_OIDC_CLIENT_SECRET",
  "CLAWS_SLACK_BOT_TOKEN", "CLAWS_SLACK_WEBHOOK", "CLAWS_SLACK_WEBHOOK_URL",
  "BRENDAN_SERVER_GMAIL_APP_PASSWORD",
  // Unset by deploy/container-entrypoint.sh, which writes the SSH key, Codex
  // auth and Claude settings to disk first; listed here so the strip list — not
  // the entrypoint — is the boundary, and so a systemd host that exports them
  // is covered too.
  "CLAWS_SSH_PRIVATE_KEY", "CLAWS_CODEX_AUTH_JSON", "CLAWS_CLAUDE_SETTINGS_JSON",
  // Sessions and agents hold no Kubernetes credentials (#clw_01M3EW1TJ5FPD17N8JQSHDJXAJ).
  // Nothing writes these any more; stripped so a stale value cannot leak.
  "CLAWS_KUBECONFIG", "CLAWS_PROD_KUBECONFIG", "KUBECONFIG",
  "CLAWS_FORGEJO_TOKEN",
  "CLAWS_FORGEJO_READ_TOKEN",
  "CLAWS_FORGEJO_ADMIN_TOKEN",
  "CLAWS_SLACK_PROD_ALERTS_WEBHOOK",
  "CLAWS_DATABASE_URL", "CLAWS_DATABASE_PASSWORD",
  "CLAWS_BROWSER_CDP_ENDPOINT",
  "CLAWS_PAGES_S3_ACCESS_KEY_ID", "CLAWS_PAGES_S3_SECRET_ACCESS_KEY",
] as const;
