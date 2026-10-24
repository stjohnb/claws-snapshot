import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORK_DIR } from "../config.js";
import { reportError } from "../error-reporter.js";
import { createK8sClient, type K8sClient } from "../k8s/api.js";
import * as log from "../log.js";

// Talks to the API server through the in-process `k8s/api.ts` client, which
// authenticates only with the projected ServiceAccount token and never loads a
// kubeconfig, so a stale cluster-admin `~/.kube/config` left on the PVC
// (#2801) cannot override it and the namespaced get+patch-on-claws-auth Role
// is what the API server enforces. The token travels only as an Authorization
// header — never argv or a temp file (#2839) — and the client's error messages
// name the method, path and status only, never Secret data.

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

interface SyncAuthSecretOpts {
  codexAuthPath?: string;
  envFilePath?: string;
  saDir?: string;
  /** Defaults to `createK8sClient({ saDir })`. */
  client?: K8sClient;
}

interface SecretEntry {
  key: string;
  value: string;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readCodexEntry(codexAuthPath: string): SecretEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(codexAuthPath, "utf8").trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    JSON.parse(raw);
  } catch {
    log.warn(`[auth-secret-sync] ~/.codex/auth.json is not valid JSON; not syncing`);
    return null;
  }
  return { key: "CLAWS_CODEX_AUTH_JSON", value: raw };
}

function readClaudeEntry(envFilePath: string): SecretEntry | null {
  let content: string;
  try {
    content = fs.readFileSync(envFilePath, "utf8");
  } catch {
    return null;
  }
  let value: string | undefined;
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^CLAUDE_CODE_OAUTH_TOKEN=(.*)$/);
    if (match) value = unquote(match[1]);
  }
  if (!value) return null;
  return { key: "CLAUDE_CODE_OAUTH_TOKEN", value };
}

export async function syncAuthSecret(opts: SyncAuthSecretOpts = {}): Promise<void> {
  const secretName = (process.env["CLAWS_AUTH_SECRET_NAME"] ?? "").trim();
  if (!secretName) return;
  const namespace = (process.env["CLAWS_AUTH_SECRET_NAMESPACE"] ?? "default").trim();

  if (!NAME_RE.test(secretName)) {
    log.warn(`[auth-secret-sync] Invalid CLAWS_AUTH_SECRET_NAME; skipping`);
    return;
  }
  if (!NAME_RE.test(namespace)) {
    log.warn(`[auth-secret-sync] Invalid CLAWS_AUTH_SECRET_NAMESPACE; skipping`);
    return;
  }

  const saDir = opts.saDir ?? SA_DIR;
  const codexAuthPath = opts.codexAuthPath ?? path.join(os.homedir(), ".codex", "auth.json");
  const envFilePath = opts.envFilePath ?? path.join(WORK_DIR, "env");

  // Presence check only: the client re-reads the token on every request.
  try {
    const token = fs.readFileSync(path.join(saDir, "token"), "utf8").trim();
    if (!token) throw new Error("empty token");
  } catch {
    log.warn("[auth-secret-sync] no ServiceAccount token; skipping");
    return;
  }

  const entries: SecretEntry[] = [];
  const codexEntry = readCodexEntry(codexAuthPath);
  if (codexEntry) entries.push(codexEntry);
  const claudeEntry = readClaudeEntry(envFilePath);
  if (claudeEntry) entries.push(claudeEntry);

  if (entries.length === 0) return;

  const client = opts.client ?? createK8sClient({ saDir });

  const secret = await client.get<{ data?: Record<string, string> }>("secrets", namespace, secretName);
  if (!secret.ok) {
    await reportError("auth-secret-sync", "Failed to read the claws-auth Secret", new Error(secret.message));
    return;
  }

  const data = secret.value.data ?? {};
  const changed = entries.filter((entry) => {
    const current = Buffer.from(data[entry.key] ?? "", "base64").toString("utf8").trim();
    return current !== entry.value;
  });

  if (changed.length === 0) {
    log.debug(`[auth-secret-sync] ${namespace}/${secretName} already up to date`);
    return;
  }

  const patch = {
    data: Object.fromEntries(changed.map((e) => [e.key, Buffer.from(e.value, "utf8").toString("base64")])),
  };
  const patched = await client.patch("secrets", namespace, secretName, patch);
  if (!patched.ok) {
    await reportError("auth-secret-sync", "Failed to patch the claws-auth Secret", new Error(patched.message));
    return;
  }
  log.info(`[auth-secret-sync] persisted ${changed.map((e) => e.key).join(", ")} to Secret ${namespace}/${secretName}`);
}

export async function run(): Promise<void> {
  try {
    await syncAuthSecret();
  } catch (err) {
    log.warn(`[auth-secret-sync] Unexpected failure: ${err}`);
  }
}
