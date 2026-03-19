import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const WORK_DIR = path.join(os.homedir(), ".claws");

export const DB_PATH = path.join(WORK_DIR, "claws.db");

export const CONFIG_PATH = path.join(WORK_DIR, "config.json");

export const LABELS = {
  refined: "Refined",
  ready: "Ready",
  priority: "Priority",
  inReview: "In Review",
} as const;

export const LABEL_SPECS: Record<string, { color: string; description: string }> = {
  "Refined":              { color: "0075ca", description: "Issue is ready for claws to implement" },
  "Ready":                { color: "0e8a16", description: "Claws has finished — needs human attention" },
  "Priority":             { color: "d93f0b", description: "High-priority — processed first in all Claws queues" },
  "In Review":            { color: "fbca04", description: "Issue has an open PR being reviewed" },
};

/** Labels that were previously managed by Claws and can be cleaned up as stale. */
export const LEGACY_LABELS = new Set([
  "Needs Refinement",
  "Plan Produced",
  "Reviewed",
  "prod-report",
  "investigated",
  "claws-mergeable",
  "claws-error",
]);

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface RunnerHost {
  name?: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  actionsDir: string;
}

export interface ConfigFile {
  slackWebhook?: string;
  slackBotToken?: string;
  slackIdeasChannel?: string;
  githubOwners?: string[];
  selfRepo?: string;
  port?: number;
  kwyjiboBaseUrl?: string;
  kwyjiboApiKey?: string;
  whatsappEnabled?: boolean;
  whatsappAllowedNumbers?: string[];
  openaiApiKey?: string;
  authToken?: string;
  maxClaudeWorkers?: number;
  claudeTimeoutMs?: number;
  runners?: RunnerHost[];
  emailEnabled?: boolean;
  emailUser?: string;
  emailAppPassword?: string;
  emailRecipient?: string;
  emailVegBoxSender?: string;
  intervals?: {
    issueWorkerMs?: number;
    issueRefinerMs?: number;
    ciFixerMs?: number;
    reviewAddresserMs?: number;
    triageKwyjiboErrorsMs?: number;
    autoMergerMs?: number;
    triageClawsErrorsMs?: number;
    ideaCollectorMs?: number;
    runnerMonitorMs?: number;
    emailMonitorMs?: number;
  };
  schedules?: {
    docMaintainerHour?: number;
    repoStandardsHour?: number;
    improvementIdentifierHour?: number;
    ideaSuggesterHour?: number;
    issueAuditorHour?: number;
    ubuntuLatestScannerHour?: number;
  };
  logRetentionDays?: number;
  logRetentionPerJob?: number;
  pausedJobs?: string[];
  skippedItems?: Array<{ repo: string; number: number }>;
  prioritizedItems?: Array<{ repo: string; number: number }>;
}

const DEFAULT_RUNNERS: RunnerHost[] = [
  {
    name: "runner-1",
    host: "0.0.0.0",
    user: "runner",
    port: 22,
    identityFile: "~/.ssh/id_ed25519",
    actionsDir: "/home/runner/actions-runner",
  },
];

function loadConfig() {
  let file: ConfigFile = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    file = JSON.parse(raw) as ConfigFile;
  } catch {
    // No config file or invalid JSON — use defaults + env vars
  }

  const slackWebhook =
    process.env["CLAWS_SLACK_WEBHOOK"] ?? file.slackWebhook ?? "";

  const slackBotToken =
    process.env["CLAWS_SLACK_BOT_TOKEN"] ?? file.slackBotToken ?? "";

  const slackIdeasChannel =
    process.env["CLAWS_SLACK_IDEAS_CHANNEL"] ?? file.slackIdeasChannel ?? "";

  const githubOwners = process.env["CLAWS_GITHUB_OWNERS"]
    ? process.env["CLAWS_GITHUB_OWNERS"].split(",").map((s) => s.trim())
    : file.githubOwners ?? ["stjohnb", "St-John-Software"];

  const selfRepo =
    process.env["CLAWS_SELF_REPO"] ?? file.selfRepo ?? "St-John-Software/claws";

  const port = parseInt(
    process.env["PORT"] ?? String(file.port ?? 3000),
    10,
  );

  const kwyjiboBaseUrl =
    process.env["KWYJIBO_BASE_URL"] ?? file.kwyjiboBaseUrl ?? "https://kwyjibo.vercel.app";

  const kwyjiboApiKey =
    process.env["KWYJIBO_AUTOMATION_API_KEY"] ?? file.kwyjiboApiKey ?? "";

  const runners = file.runners ?? DEFAULT_RUNNERS;

  const emailEnabled =
    process.env["CLAWS_EMAIL_ENABLED"] === "true" || file.emailEnabled === true;

  const emailUser =
    process.env["CLAWS_EMAIL_USER"] ?? file.emailUser ?? "";

  const emailAppPassword =
    process.env["CLAWS_EMAIL_APP_PASSWORD"] ?? file.emailAppPassword ?? "";

  const emailRecipient =
    process.env["CLAWS_EMAIL_RECIPIENT"] ?? file.emailRecipient ?? "";

  const emailVegBoxSender =
    file.emailVegBoxSender ?? "";

  const intervals = {
    issueWorkerMs: file.intervals?.issueWorkerMs ?? 5 * 60 * 1000,
    issueRefinerMs: file.intervals?.issueRefinerMs ?? 5 * 60 * 1000,
    ciFixerMs: file.intervals?.ciFixerMs ?? 10 * 60 * 1000,
    reviewAddresserMs: file.intervals?.reviewAddresserMs ?? 5 * 60 * 1000,
    triageKwyjiboErrorsMs: file.intervals?.triageKwyjiboErrorsMs ?? 10 * 60 * 1000,
    autoMergerMs: file.intervals?.autoMergerMs ?? 10 * 60 * 1000,
    triageClawsErrorsMs: file.intervals?.triageClawsErrorsMs ?? 10 * 60 * 1000,
    ideaCollectorMs: file.intervals?.ideaCollectorMs ?? 30 * 60 * 1000,
    runnerMonitorMs: file.intervals?.runnerMonitorMs ?? 10 * 60 * 1000,
    emailMonitorMs: file.intervals?.emailMonitorMs ?? 5 * 60 * 1000,
  };

  const schedules = {
    docMaintainerHour: file.schedules?.docMaintainerHour ?? 1, // 1 AM local time
    repoStandardsHour: file.schedules?.repoStandardsHour ?? 2, // 2 AM local time
    improvementIdentifierHour: file.schedules?.improvementIdentifierHour ?? 3, // 3 AM local time
    ideaSuggesterHour: file.schedules?.ideaSuggesterHour ?? 4, // 4 AM local time
    issueAuditorHour: file.schedules?.issueAuditorHour ?? 5, // 5 AM local time
    ubuntuLatestScannerHour: file.schedules?.ubuntuLatestScannerHour ?? 6, // 6 AM local time
  };

  const whatsappEnabled =
    process.env["WHATSAPP_ENABLED"] === "true" || file.whatsappEnabled === true;

  const whatsappAllowedNumbers = process.env["WHATSAPP_ALLOWED_NUMBERS"]
    ? process.env["WHATSAPP_ALLOWED_NUMBERS"].split(",").map((s) => s.trim()).filter(Boolean)
    : file.whatsappAllowedNumbers ?? [];

  const whatsappAuthDir = path.join(WORK_DIR, "whatsapp-auth");

  const openaiApiKey =
    process.env["OPENAI_API_KEY"] ?? file.openaiApiKey ?? "";

  const authToken =
    process.env["CLAWS_AUTH_TOKEN"] ?? file.authToken ?? "";

  const maxClaudeWorkers = parseInt(
    process.env["CLAWS_MAX_CLAUDE_WORKERS"] ?? String(file.maxClaudeWorkers ?? 2),
    10,
  );

  const claudeTimeoutMs = Math.max(
    60_000,
    parseInt(
      process.env["CLAWS_CLAUDE_TIMEOUT_MS"] ?? String(file.claudeTimeoutMs ?? 20 * 60 * 1000),
      10,
    ),
  );

  const logRetentionDays = file.logRetentionDays ?? 14;
  const logRetentionPerJob = file.logRetentionPerJob ?? 20;
  const pausedJobs = file.pausedJobs ?? [];
  const skippedItems = file.skippedItems ?? [];
  const prioritizedItems = file.prioritizedItems ?? [];

  if (!slackWebhook) {
    console.warn(
      "Warning: No Slack webhook configured. Set CLAWS_SLACK_WEBHOOK or slackWebhook in ~/.claws/config.json",
    );
  }

  return { slackWebhook, slackBotToken, slackIdeasChannel, githubOwners, selfRepo, port, kwyjiboBaseUrl, kwyjiboApiKey, runners, intervals, schedules, logRetentionDays, logRetentionPerJob, whatsappEnabled, whatsappAllowedNumbers, whatsappAuthDir, openaiApiKey, authToken, maxClaudeWorkers, claudeTimeoutMs, pausedJobs, skippedItems, prioritizedItems, emailEnabled, emailUser, emailAppPassword, emailRecipient, emailVegBoxSender };
}

const config = loadConfig();

export let SLACK_WEBHOOK = config.slackWebhook;
export let SLACK_BOT_TOKEN = config.slackBotToken;
export let SLACK_IDEAS_CHANNEL = config.slackIdeasChannel;
export let GITHUB_OWNERS: readonly string[] = config.githubOwners;
export let SELF_REPO = config.selfRepo;
export const SERVER_PORT = config.port; // immutable — requires restart
export let KWYJIBO_BASE_URL = config.kwyjiboBaseUrl;
export let KWYJIBO_API_KEY = config.kwyjiboApiKey;
export let RUNNER_HOSTS: readonly RunnerHost[] = config.runners;
export let INTERVALS = config.intervals;
export let SCHEDULES = config.schedules;
export let LOG_RETENTION_DAYS = config.logRetentionDays;
export let LOG_RETENTION_PER_JOB = config.logRetentionPerJob;
export const WHATSAPP_ENABLED = config.whatsappEnabled; // immutable — requires restart (QR pairing)
export let WHATSAPP_ALLOWED_NUMBERS: readonly string[] = config.whatsappAllowedNumbers;
export const WHATSAPP_AUTH_DIR = config.whatsappAuthDir;
export let OPENAI_API_KEY = config.openaiApiKey;
export let AUTH_TOKEN = config.authToken;
export let MAX_CLAUDE_WORKERS = config.maxClaudeWorkers;
export let CLAUDE_TIMEOUT_MS = config.claudeTimeoutMs;
export let PAUSED_JOBS: readonly string[] = config.pausedJobs;
export let SKIPPED_ITEMS: ReadonlyArray<{ repo: string; number: number }> = config.skippedItems;
export let PRIORITIZED_ITEMS: ReadonlyArray<{ repo: string; number: number }> = config.prioritizedItems;
export const EMAIL_ENABLED = config.emailEnabled; // immutable — requires restart
export let EMAIL_USER = config.emailUser;
export let EMAIL_APP_PASSWORD = config.emailAppPassword;
export let EMAIL_RECIPIENT = config.emailRecipient;
export let EMAIL_VEG_BOX_SENDER = config.emailVegBoxSender;

// ── Change notification system ──

type ConfigChangeListener = () => void;
const listeners: Set<ConfigChangeListener> = new Set();

export function onConfigChange(listener: ConfigChangeListener): void {
  listeners.add(listener);
}

export function offConfigChange(listener: ConfigChangeListener): void {
  listeners.delete(listener);
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Don't let a failing listener break config reload
    }
  }
}

// ── Reload & write ──

export function reloadConfig(): void {
  const fresh = loadConfig();
  SLACK_WEBHOOK = fresh.slackWebhook;
  SLACK_BOT_TOKEN = fresh.slackBotToken;
  SLACK_IDEAS_CHANNEL = fresh.slackIdeasChannel;
  GITHUB_OWNERS = fresh.githubOwners;
  SELF_REPO = fresh.selfRepo;
  KWYJIBO_BASE_URL = fresh.kwyjiboBaseUrl;
  KWYJIBO_API_KEY = fresh.kwyjiboApiKey;
  RUNNER_HOSTS = fresh.runners;
  INTERVALS = fresh.intervals;
  SCHEDULES = fresh.schedules;
  LOG_RETENTION_DAYS = fresh.logRetentionDays;
  LOG_RETENTION_PER_JOB = fresh.logRetentionPerJob;
  WHATSAPP_ALLOWED_NUMBERS = fresh.whatsappAllowedNumbers;
  OPENAI_API_KEY = fresh.openaiApiKey;
  AUTH_TOKEN = fresh.authToken;
  MAX_CLAUDE_WORKERS = fresh.maxClaudeWorkers;
  CLAUDE_TIMEOUT_MS = fresh.claudeTimeoutMs;
  PAUSED_JOBS = fresh.pausedJobs;
  SKIPPED_ITEMS = fresh.skippedItems;
  PRIORITIZED_ITEMS = fresh.prioritizedItems;
  EMAIL_USER = fresh.emailUser;
  EMAIL_APP_PASSWORD = fresh.emailAppPassword;
  EMAIL_RECIPIENT = fresh.emailRecipient;
  EMAIL_VEG_BOX_SENDER = fresh.emailVegBoxSender;
  notifyListeners();
}

const SENSITIVE_KEYS = new Set(["slackWebhook", "slackBotToken", "kwyjiboApiKey", "openaiApiKey", "authToken", "emailAppPassword"]);

function maskValue(value: string): string {
  if (!value) return "Not configured";
  if (value.length <= 4) return "****";
  return "****" + value.slice(-4);
}

export function getConfigForDisplay(): Record<string, unknown> {
  const raw = loadConfig();
  const display: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (SENSITIVE_KEYS.has(key)) {
      display[key] = maskValue(value as string);
    } else {
      display[key] = value;
    }
  }

  return display;
}

export function writeConfig(updates: Partial<ConfigFile>): void {
  let existing: ConfigFile = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    existing = JSON.parse(raw) as ConfigFile;
  } catch {
    // Start from empty if missing or invalid
  }

  // Deep-merge, skipping empty secret fields to avoid clearing masked values
  for (const [key, value] of Object.entries(updates)) {
    if (SENSITIVE_KEYS.has(key) && value === "") continue;

    if (key === "intervals" && typeof value === "object" && value !== null) {
      existing.intervals = { ...existing.intervals, ...(value as ConfigFile["intervals"]) };
    } else if (key === "schedules" && typeof value === "object" && value !== null) {
      existing.schedules = { ...existing.schedules, ...(value as ConfigFile["schedules"]) };
    } else {
      (existing as Record<string, unknown>)[key] = value;
    }
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
  reloadConfig();
}
