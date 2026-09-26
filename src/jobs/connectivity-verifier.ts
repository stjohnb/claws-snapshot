import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import * as config from "../config.js";
import * as log from "../log.js";
import { healthCheck, insertVerificationReport, getLatestVerificationReport, describeDatabaseTarget } from "../db.js";
import { ensureGitHubAppConfigured, getAnyInstallationToken, isGitHubAppEnabled } from "../github-app.js";
import { buildSshArgs } from "../ssh.js";
import { isContainer } from "../runtime-env.js";
import { createK8sClient } from "../k8s/api.js";
import { fetchBrowserPressure, redactedBrowserEndpoint, usesRemoteBrowser } from "../browser-endpoint.js";

const execFileAsync = promisify(execFile);

const PER_CHECK_TIMEOUT_MS = 30_000;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

export interface VerificationReport {
  generatedAt: string;
  checks: CheckResult[];
}

async function timed(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>): Promise<CheckResult> {
  const start = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout>;
  try {
    const timeoutPromise = new Promise<{ ok: boolean; detail?: string }>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`timed out after ${PER_CHECK_TIMEOUT_MS}ms`)), PER_CHECK_TIMEOUT_MS);
    });
    const fnPromise = fn();
    fnPromise.catch(() => {}); // prevent unhandled rejection if outer timeout wins the race
    const { ok, detail } = await Promise.race([fnPromise, timeoutPromise]);
    clearTimeout(timeoutHandle!);
    return { name, ok, detail, ms: Date.now() - start };
  } catch (err) {
    clearTimeout(timeoutHandle!);
    const msg = err instanceof Error ? err.message : String(err);
    return { name, ok: false, detail: msg, ms: Date.now() - start };
  }
}

async function checkDb(): Promise<{ ok: boolean; detail?: string }> {
  await healthCheck();
  return { ok: true, detail: `SELECT 1 via ${describeDatabaseTarget()}` };
}

async function checkGitHubApp(): Promise<{ ok: boolean; detail?: string }> {
  if (!isGitHubAppEnabled()) {
    return { ok: false, detail: "GitHub App not configured (missing appId or private key path)" };
  }
  ensureGitHubAppConfigured();
  const token = await getAnyInstallationToken();
  return { ok: true, detail: `minted token ${token.slice(0, 4)}… (${token.length} chars)` };
}

async function checkGhCli(): Promise<{ ok: boolean; detail?: string }> {
  let token: string;
  try {
    token = await getAnyInstallationToken();
  } catch (err) {
    return { ok: false, detail: `could not mint token: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const { stdout, stderr } = await execFileAsync("gh", ["auth", "status"], {
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      timeout: 15_000,
    });
    const combined = (stdout + stderr).trim();
    return { ok: true, detail: combined.split("\n")[0] ?? "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
}

async function checkBinary(binary: string, versionArgs: string[] = ["--version"]): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { stdout } = await execFileAsync(binary, versionArgs, { timeout: 15_000 });
    return { ok: true, detail: stdout.trim().split("\n")[0] ?? "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
}

async function checkKubectl(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { stdout } = await execFileAsync("kubectl", ["version", "--client", "-o", "json"], { timeout: 15_000 });
    const parsed = JSON.parse(stdout) as { clientVersion?: { gitVersion?: string } };
    return { ok: true, detail: parsed.clientVersion?.gitVersion ?? "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
}

/** RBAC the `k8s-pod` session backend needs in `CLAWS_SESSION_NAMESPACE` (#3026). */
export const SESSION_BACKEND_RBAC: ReadonlyArray<{ resource: string; verbs: string[] }> = [
  { resource: "pods", verbs: ["get", "list", "create", "delete"] },
  { resource: "services", verbs: ["get", "create", "delete"] },
  { resource: "secrets", verbs: ["get", "create", "delete", "patch"] },
  { resource: "persistentvolumeclaims", verbs: ["get", "list", "create", "delete"] },
];

/**
 * Whether interactive sessions survive a Claws rollout (#3026). `local-tmux`
 * inside a container always FAILs: the tmux server lives in the service pod
 * and dies with it. `k8s-pod` needs a published image and the namespaced RBAC.
 */
async function checkSessionBackend(): Promise<{ ok: boolean; detail?: string }> {
  if (config.SESSION_BACKEND !== "k8s-pod") {
    const tmux = await checkBinary("tmux", ["-V"]);
    if (isContainer()) {
      return { ok: false, detail: `local-tmux (${tmux.detail ?? "tmux"}): local tmux inside the service container is killed by every rollout — cutover blocker (#3026)` };
    }
    return { ok: tmux.ok, detail: `local-tmux: ${tmux.detail ?? ""}`.trim() };
  }

  const { namespace, image } = config.SESSION_POD_SETTINGS;
  if (!image) return { ok: false, detail: "k8s-pod: CLAWS_SESSION_IMAGE is empty (dev build) — sessions cannot start" };
  const client = createK8sClient();
  const reviews = SESSION_BACKEND_RBAC.flatMap(({ resource, verbs }) => verbs.map((verb) => ({ resource, verb })));
  const results = await Promise.all(reviews.map((r) => client.selfSubjectAccessReview({ namespace, ...r })));
  const denied: string[] = [];
  for (const [i, res] of results.entries()) {
    if (!res.ok) return { ok: false, detail: `k8s-pod: access review failed: ${res.message}` };
    if (!res.value.allowed) denied.push(`${reviews[i].verb} ${reviews[i].resource}`);
  }
  if (denied.length > 0) {
    return { ok: false, detail: `k8s-pod: missing RBAC in namespace ${namespace}: ${denied.join(", ")}` };
  }
  return { ok: true, detail: `k8s-pod: namespace ${namespace}, image ${image}, RBAC ok` };
}

/** The `SESSION_BACKEND_RBAC` entries a `k8s-pod` agent pod's launcher uses: its Pod and Secret. */
export const WORK_BACKEND_RBAC = SESSION_BACKEND_RBAC.filter(({ resource }) => resource === "pods" || resource === "secrets");

/**
 * Whether headless agent runs survive a Claws rollout (#clw_01M34R5RECDPPXVXBJZS1DA6C1).
 * `in-process` inside a container always FAILs: the agent is a child of the
 * service and dies with it. `k8s-pod` needs a published image, the session
 * MCP URL the pods call back on, and the Pod/Secret RBAC in the session namespace.
 */
async function checkWorkBackend(): Promise<{ ok: boolean; detail?: string }> {
  if (config.WORK_BACKEND !== "k8s-pod") {
    if (isContainer()) {
      return { ok: false, detail: "in-process: headless agents inside the service container are killed by every rollout — set CLAWS_WORK_BACKEND=k8s-pod" };
    }
    return { ok: true, detail: "in-process" };
  }

  const { namespace, image, mcpUrl } = config.SESSION_POD_SETTINGS;
  if (!image) return { ok: false, detail: "k8s-pod: CLAWS_SESSION_IMAGE is empty (dev build) — agent pods cannot start" };
  if (!mcpUrl) return { ok: false, detail: "k8s-pod: CLAWS_SESSION_MCP_URL is empty — agent pods cannot reach Claws" };
  const client = createK8sClient();
  const reviews = WORK_BACKEND_RBAC.flatMap(({ resource, verbs }) => verbs.map((verb) => ({ resource, verb })));
  const results = await Promise.all(reviews.map((r) => client.selfSubjectAccessReview({ namespace, ...r })));
  const denied: string[] = [];
  for (const [i, res] of results.entries()) {
    if (!res.ok) return { ok: false, detail: `k8s-pod: access review failed: ${res.message}` };
    if (!res.value.allowed) denied.push(`${reviews[i].verb} ${reviews[i].resource}`);
  }
  if (denied.length > 0) {
    return { ok: false, detail: `k8s-pod: missing RBAC in namespace ${namespace}: ${denied.join(", ")}` };
  }
  return { ok: true, detail: `k8s-pod: namespace ${namespace}, image ${image}, RBAC ok` };
}

async function checkOpenRouter(): Promise<{ ok: boolean; detail?: string }> {
  if (!config.OPENROUTER_API_KEY) {
    return { ok: false, detail: "OPENROUTER_API_KEY not set" };
  }
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
  return { ok: true, detail: `HTTP ${res.status}` };
}

async function checkSlackWebhook(): Promise<{ ok: boolean; detail?: string }> {
  if (!config.SLACK_WEBHOOK) return { ok: false, detail: "SLACK_WEBHOOK not set" };
  let url: URL;
  try {
    url = new URL(config.SLACK_WEBHOOK);
  } catch {
    return { ok: false, detail: "SLACK_WEBHOOK is not a valid URL" };
  }
  if (url.hostname !== "hooks.slack.com") {
    return { ok: false, detail: `unexpected host ${url.hostname}` };
  }
  try {
    await dns.lookup("hooks.slack.com");
  } catch (err) {
    return { ok: false, detail: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  // DNS-only check: we deliberately do NOT POST in verify-only mode to avoid
  // spamming the channel while the systemd instance is still active. A revoked
  // webhook will not be detected until the first real send after activation.
  return { ok: true, detail: "DNS resolved; POST not attempted in verify-only" };
}

async function checkEmail(): Promise<{ ok: boolean; detail?: string }> {
  if (!config.EMAIL_ENABLED) return { ok: true, detail: "email disabled" };
  if (!config.EMAIL_USER || !config.EMAIL_APP_PASSWORD) {
    return { ok: false, detail: "EMAIL_USER or app password not set" };
  }
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: config.EMAIL_USER, pass: config.EMAIL_APP_PASSWORD },
    logger: false,
    connectionTimeout: 20_000,
  });
  try {
    await client.connect();
    await client.logout();
    return { ok: true, detail: `IMAP login OK for ${config.EMAIL_USER}` };
  } catch (err) {
    try { await client.logout(); } catch { /* best effort */ }
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkSshHost(label: string, user: string | undefined, host: string, port: number | undefined, identityFile: string | undefined): Promise<{ ok: boolean; detail?: string }> {
  const args = buildSshArgs(
    { host, user, port, identityFile },
    { strictHostKeyChecking: "yes" },
  );
  args.push(`${user ?? "root"}@${host}`, "true");
  try {
    await execFileAsync("ssh", args, { timeout: 15_000 });
    return { ok: true, detail: `${label} reachable` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
}

async function checkOllama(): Promise<{ ok: boolean; detail?: string }> {
  const base = config.OLLAMA_BASE_URL;
  if (!base) return { ok: false, detail: "OLLAMA_BASE_URL not set" };
  const res = await fetch(`${base.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
  return { ok: true, detail: `HTTP ${res.status}` };
}

async function checkWhatsAppAuth(): Promise<{ ok: boolean; detail?: string }> {
  if (!config.WHATSAPP_ENABLED) return { ok: true, detail: "WhatsApp disabled" };
  const credsPath = path.join(config.WHATSAPP_AUTH_DIR, "creds.json");
  const deferredPairingDetail = "pairing deferred until first active start; verify-only instances do not claim the WhatsApp device slot";
  if (!fs.existsSync(credsPath)) {
    if (config.ACTIVATION_STATE === "verify-only") {
      return { ok: true, detail: deferredPairingDetail };
    }
    return { ok: false, detail: "pairing required on first active start (no creds.json)" };
  }
  // A creds.json without `me` is a freshly-initialised, unregistered session —
  // Baileys would run the QR pairing flow, not log in. Mirrors hasAuthState()
  // in whatsapp.ts; inlined so the verify path doesn't pull in Baileys.
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf8")) as { me?: { id?: string } };
    if (typeof creds?.me?.id === "string" && creds.me.id.length > 0) {
      return { ok: true, detail: `paired (${credsPath} exists)` };
    }
  } catch {
    // fall through — unreadable/unparseable creds are not a paired session
  }
  if (config.ACTIVATION_STATE === "verify-only") {
    return { ok: true, detail: deferredPairingDetail };
  }
  return { ok: false, detail: "creds.json present but not registered — pairing required" };
}

async function checkHomeAssistant(): Promise<{ ok: boolean; detail?: string }> {
  if (!config.HOME_ASSISTANT_BASE_URL || !config.HOME_ASSISTANT_TOKEN) {
    return { ok: true, detail: "HA not configured (optional)" };
  }
  const base = config.HOME_ASSISTANT_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/api/`, {
    headers: { Authorization: `Bearer ${config.HOME_ASSISTANT_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
  return { ok: true, detail: `HTTP ${res.status}` };
}

// Details carry only the redacted endpoint: the configured URL holds the browserless token.
async function checkBrowserService(): Promise<{ ok: boolean; detail?: string }> {
  if (!usesRemoteBrowser()) return { ok: true, detail: "not configured (optional) — local Chromium" };
  const endpoint = redactedBrowserEndpoint();
  const p = await fetchBrowserPressure(10_000);
  if (!p.reachable) {
    return { ok: false, detail: `${endpoint}: ${p.status !== undefined ? `HTTP ${p.status}` : `unreachable (${p.error})`}` };
  }
  const count = (a?: number, b?: number) => `${a ?? "?"}/${b ?? "?"}`;
  return { ok: true, detail: `${endpoint}: running ${count(p.running, p.maxConcurrent)}, queued ${count(p.queued, p.maxQueued)}` };
}

/**
 * Run every connectivity check once. Designed to be called on startup in
 * verify-only mode and on-demand from the Activation section of /config. Never throws — each
 * check is wrapped in try/catch/timeout and recorded individually.
 */
export async function runConnectivityVerification(): Promise<VerificationReport> {
  const checks: CheckResult[] = [];

  const sshChecks = config.RUNNER_HOSTS.map((runner) => {
    const label = `ssh:${runner.name ?? runner.host}`;
    return timed(label, () => checkSshHost(label, runner.user, runner.host, runner.port, runner.identityFile));
  });
  const results = await Promise.all([
    timed("database", checkDb),
    timed("github-app", checkGitHubApp),
    timed("gh-cli", checkGhCli),
    timed("claude-cli", () => checkBinary("claude")),
    timed("codex-cli", () => checkBinary("codex")),
    timed("opencode-cli", () => checkBinary("opencode")),
    timed("tmux", () => checkBinary("tmux", ["-V"])),
    timed("session-backend", checkSessionBackend),
    timed("work-backend", checkWorkBackend),
    timed("kubectl", checkKubectl),
    timed("openrouter", checkOpenRouter),
    timed("slack-webhook", checkSlackWebhook),
    timed("email-imap", checkEmail),
    ...sshChecks,
    timed("ollama", checkOllama),
    timed("whatsapp-auth", checkWhatsAppAuth),
    timed("home-assistant", checkHomeAssistant),
    timed("browser-service", checkBrowserService),
  ]);
  checks.push(...results);

  const report: VerificationReport = {
    generatedAt: new Date().toISOString(),
    checks,
  };

  for (const c of checks) {
    const logFn = c.ok ? log.info : log.warn;
    logFn(`[verify] ${c.name}: ${c.ok ? "OK" : "FAIL"} (${c.ms}ms)${c.detail ? ` — ${c.detail}` : ""}`);
  }

  try {
    await insertVerificationReport(JSON.stringify(report));
  } catch (err) {
    log.warn(`[verify] Failed to persist verification report: ${err}`);
  }

  return report;
}

export async function loadLatestReport(): Promise<VerificationReport | null> {
  const row = await getLatestVerificationReport();
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as VerificationReport;
  } catch {
    return null;
  }
}
