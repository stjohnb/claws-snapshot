import fs from "node:fs";

/**
 * Load `<WORK_DIR>/env` into process.env, replicating systemd's
 * `EnvironmentFile=` for non-systemd hosts. File values WIN over
 * pre-existing env: this file is only written by claude-auth.ts's
 * persistToken(), so it always holds a credential fresher than the Secret
 * that seeded the pod. Never throws, never logs values.
 */
export function loadEnvFile(envPath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;

    let value = trimmed.slice(eq + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
