import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import pg from "pg";
import * as config from "../config.js";
import * as log from "../log.js";
import { healthCheck, insertVerificationReport, getLatestVerificationReport } from "../db.js";
import { ensureGitHubAppConfigured, getAnyInstallationToken, isGitHubAppEnabled } from "../github-app.js";

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
  healthCheck();
  return { ok: true, detail: `SELECT 1 via ${config.DB_PATH}` };
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

async function checkBinary(binary: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 15_000 });
    return { ok: true, detail: stdout.trim().split("\n")[0] ?? "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
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
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
  ];
  if (identityFile) {
    const expanded = identityFile.startsWith("~")
      ? path.join(process.env.HOME ?? "", identityFile.slice(1))
      : identityFile;
    args.push("-i", expanded);
  }
  if (port) args.push("-p", String(port));
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

async function checkNameyDb(): Promise<{ ok: boolean; detail?: string }> {
  if (!config.NAMEY_DB_URL) return { ok: true, detail: "NAMEY_DB_URL not set (optional)" };
  const client = new pg.Client({ connectionString: config.NAMEY_DB_URL, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return { ok: true, detail: "SELECT 1 OK" };
  } catch (err) {
    try { await client.end(); } catch { /* best effort */ }
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkKwyjibo(): Promise<{ ok: boolean; detail?: string }> {
  if (!config.KWYJIBO_BASE_URL) return { ok: false, detail: "KWYJIBO_BASE_URL not set" };
  const res = await fetch(config.KWYJIBO_BASE_URL.replace(/\/$/, ""), {
    method: "HEAD",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 405) return { ok: false, detail: `HTTP ${res.status}` };
  return { ok: true, detail: `HTTP ${res.status}` };
}

async function checkWhatsAppAuth(): Promise<{ ok: boolean; detail?: string }> {
  if (!config.WHATSAPP_ENABLED) return { ok: true, detail: "WhatsApp disabled" };
  const credsPath = path.join(config.WHATSAPP_AUTH_DIR, "creds.json");
  if (fs.existsSync(credsPath)) {
    return { ok: true, detail: `paired (${credsPath} exists)` };
  }
  return { ok: false, detail: "pairing required on first active start (no creds.json)" };
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

/**
 * Run every connectivity check once. Designed to be called on startup in
 * verify-only mode and on-demand from the /verify page. Never throws — each
 * check is wrapped in try/catch/timeout and recorded individually.
 */
export async function runConnectivityVerification(): Promise<VerificationReport> {
  const checks: CheckResult[] = [];

  const sshChecks = config.RUNNER_HOSTS.map((runner) => {
    const label = `ssh:${runner.name ?? runner.host}`;
    return timed(label, () => checkSshHost(label, runner.user, runner.host, runner.port, runner.identityFile));
  });
  const ds = config.DATASETTE_EXPORT;
  if (ds) {
    sshChecks.push(timed("ssh:datasette", () => checkSshHost("datasette", ds.user, ds.host, ds.port, ds.identityFile)));
  }

  const results = await Promise.all([
    timed("database", checkDb),
    timed("github-app", checkGitHubApp),
    timed("gh-cli", checkGhCli),
    timed("claude-cli", () => checkBinary("claude")),
    timed("codex-cli", () => checkBinary("codex")),
    timed("opencode-cli", () => checkBinary("opencode")),
    timed("openrouter", checkOpenRouter),
    timed("slack-webhook", checkSlackWebhook),
    timed("email-imap", checkEmail),
    ...sshChecks,
    timed("ollama", checkOllama),
    timed("namey-db", checkNameyDb),
    timed("kwyjibo", checkKwyjibo),
    timed("whatsapp-auth", checkWhatsAppAuth),
    timed("home-assistant", checkHomeAssistant),
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
    insertVerificationReport(JSON.stringify(report));
  } catch (err) {
    log.warn(`[verify] Failed to persist verification report: ${err}`);
  }

  return report;
}

export function loadLatestReport(): VerificationReport | null {
  const row = getLatestVerificationReport();
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as VerificationReport;
  } catch {
    return null;
  }
}
