/** Env keys that must never leak into a child/interactive session in strict mode. */
export const SENSITIVE_ENV_KEYS = [
  "CLAWS_HOME_ASSISTANT_TOKEN", "HOME_ASSISTANT_TOKEN",
  // CLAWS_PROD_GRAFANA_TOKEN and CLAWS_FLEET_GRAFANA_TOKEN are retired (a claws-config
  // key and the Claws-signed Grafana JWT, #clw_01M7QFE3ZDE06M6JW202445NPX), stripped
  // so a stale value cannot leak.
  "CLAWS_PROD_GRAFANA_TOKEN", "CLAWS_FLEET_GRAFANA_TOKEN", "CLAWS_FLEET_GRAFANA_AUTH",
  "OPENAI_API_KEY",
  "CLAWS_OPENROUTER_API_KEY", "OPENROUTER_API_KEY",
  "CLAWS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN", "CLAWS_ANTHROPIC_ACCESS_TOKEN", "CLAWS_ANTHROPIC_ACCESS_TOKEN_EXPIRES_AT",
  "CLAWS_AUTH_TOKEN",
  // CLAWS_NODE_EVACUATION_TOKEN is retired (the shared node-evacuation bearer, replaced by
  // Authentik machine tokens, #clw_01M7RC7NY8JM8T76FKNBVK53ND), stripped so a stale value
  // cannot leak.
  "CLAWS_NODE_EVACUATION_TOKEN",
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
  "CLAWS_FORGEJO_WEBHOOK_SECRET",
  "CLAWS_SLACK_PROD_ALERTS_WEBHOOK",
  "CLAWS_DATABASE_URL", "CLAWS_DATABASE_PASSWORD",
  // The prod mailbox reader password stays in the web tier (#clw_01M8BM2RWC1T085EEEVZ6X21EH).
  "CLAWS_MAIL_READ_PASSWORD",
  "CLAWS_BROWSER_CDP_ENDPOINT",
  "CLAWS_PAGES_S3_ACCESS_KEY_ID", "CLAWS_PAGES_S3_SECRET_ACCESS_KEY",
  "CLAWS_ATTACHMENTS_S3_ACCESS_KEY_ID", "CLAWS_ATTACHMENTS_S3_SECRET_ACCESS_KEY",
] as const;
