import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORK_DIR } from "../config.js";
import { reportError } from "../error-reporter.js";
import * as log from "../log.js";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const API_SERVER = "https://kubernetes.default.svc";
const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

interface SyncAuthSecretOpts {
  codexAuthPath?: string;
  envFilePath?: string;
  saDir?: string;
}

interface SecretEntry {
  key: string;
  value: string;
}

/**
 * kubectl wrapper local to this module — deliberately not `kubectlExec` from
 * k3s-monitor.ts (that one prepends `--kubeconfig`, the cluster-admin
 * kubeconfig the entrypoint writes from `CLAWS_KUBECONFIG`).
 *
 * `KUBECONFIG=/dev/null` is load-bearing (#2801). `--server`/`--token`/
 * `--certificate-authority` are merged *over* a loaded kubeconfig, not instead
 * of it: `~/.kube/config`'s client certificate is still presented in the TLS
 * handshake and the API server tries x509 before bearer tokens, so the
 * cluster-admin cert wins and the job runs as `system:admin`. Pointing
 * KUBECONFIG at /dev/null leaves nothing to merge, so the projected
 * ServiceAccount token is the only credential and the namespaced
 * get+patch-on-claws-auth Role is actually enforced. This is also why the
 * caller now supplies credentials as an explicit `--kubeconfig <path>` file
 * rather than `--server`/`--token`/`--certificate-authority` override flags.
 *
 * The SA token reaches kubectl via a 0600 kubeconfig written into the
 * caller's `mkdtemp` dir, never argv (#2839) — args are still never logged
 * or included in an error message.
 */
function runKubectl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "kubectl",
      args,
      { timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, KUBECONFIG: "/dev/null" } },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || `kubectl failed (${(err as NodeJS.ErrnoException).code ?? "unknown"})`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
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

  let token: string;
  try {
    token = fs.readFileSync(path.join(saDir, "token"), "utf8").trim();
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-auth-"));
  try {
    const kubeconfigPath = path.join(tmpDir, "kubeconfig");
    // kubeconfig is parsed as YAML, and JSON is valid YAML — writing JSON avoids
    // any quoting question about the token.
    fs.writeFileSync(
      kubeconfigPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          { name: "claws", cluster: { server: API_SERVER, "certificate-authority": path.join(saDir, "ca.crt") } },
        ],
        users: [{ name: "claws", user: { token } }],
        contexts: [{ name: "claws", context: { cluster: "claws", user: "claws" } }],
        "current-context": "claws",
      }),
      { mode: 0o600 },
    );
    const authArgs = ["--kubeconfig", kubeconfigPath, "-n", namespace];

    let secret: { data?: Record<string, string> };
    try {
      const stdout = await runKubectl([...authArgs, "get", "secret", secretName, "-o", "json"]);
      secret = JSON.parse(stdout);
    } catch (err) {
      await reportError("auth-secret-sync", "Failed to read the claws-auth Secret", err);
      return;
    }

    const data = secret.data ?? {};
    const changed = entries.filter((entry) => {
      const current = Buffer.from(data[entry.key] ?? "", "base64").toString("utf8").trim();
      return current !== entry.value;
    });

    if (changed.length === 0) {
      log.debug(`[auth-secret-sync] ${namespace}/${secretName} already up to date`);
      return;
    }

    const patchPath = path.join(tmpDir, "patch.json");
    const patch = {
      data: Object.fromEntries(changed.map((e) => [e.key, Buffer.from(e.value, "utf8").toString("base64")])),
    };
    fs.writeFileSync(patchPath, JSON.stringify(patch), { mode: 0o600 });

    await runKubectl([...authArgs, "patch", "secret", secretName, "--type=merge", "--patch-file", patchPath]);
    log.info(`[auth-secret-sync] persisted ${changed.map((e) => e.key).join(", ")} to Secret ${namespace}/${secretName}`);
  } catch (err) {
    await reportError("auth-secret-sync", "Failed to patch the claws-auth Secret", err);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function run(): Promise<void> {
  try {
    await syncAuthSecret();
  } catch (err) {
    log.warn(`[auth-secret-sync] Unexpected failure: ${err}`);
  }
}
