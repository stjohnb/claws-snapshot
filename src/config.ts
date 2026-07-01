import { z } from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { resetGitHubAppState } from "./github-app.js";

export const WORK_DIR = path.join(os.homedir(), ".claws");

export const DB_PATH = path.join(WORK_DIR, "claws.db");

export const CONFIG_PATH = path.join(WORK_DIR, "config.json");

// Per-process random token shared with spawned MCP server children only. Regenerated each restart. Never read from env or config.
export const INTERNAL_MCP_TOKEN = crypto.randomBytes(32).toString("hex");

export const LABELS = {
  refined: "Refined",
  ready: "Ready",
  priority: "Priority",
  inReview: "In Review",
  clawsIgnore: "Claws Ignore",
  problematic: "Claws Problematic",
  duplicate: "Duplicate",
  billing: "Billing",
  planFable: "Plan: Fable",
} as const;

export const LABEL_SPECS: Record<string, { color: string; description: string }> = {
  "Refined":              { color: "0075ca", description: "Issue is ready for claws to implement" },
  "Ready":                { color: "0e8a16", description: "Claws has finished — needs human attention" },
  "Priority":             { color: "006b75", description: "High-priority — processed first in all Claws queues" },
  "In Review":            { color: "fbca04", description: "Issue has an open PR being reviewed" },
  "Claws Ignore":         { color: "cfd3d7", description: "Claws will completely ignore this issue or PR" },
  "Claws Problematic":    { color: "d73a4a", description: "PR has exceeded CI fix attempts and requires manual intervention" },
  "Duplicate":            { color: "cfd3d7", description: "Issue is a duplicate — the canonical issue will be implemented instead" },
  "Billing":              { color: "e4e669", description: "PR encountered a GitHub Actions billing/spending-limit block" },
  "Plan: Fable":          { color: "5319e7", description: "Plan this issue with Claude Fable 5 instead of the default model" },
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

export interface DatasetteExport {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  remotePath: string;
}

export interface KubeconfigRefresh {
  tailscaleHostname?: string;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  remotePath: string;
  serverPort?: number;
  serverOverride?: string;
}

export interface OwnerAppCredential {
  appId: number;
  privateKeyPath: string;
  installationId?: number;
}

export interface ConfigFile {
  slackWebhook?: string;
  slackBotToken?: string;
  slackIdeasChannel?: string;
  githubOwners?: string[];
  selfRepo?: string;
  port?: number;
  whatsappEnabled?: boolean;
  whatsappAllowedNumbers?: string[];
  openaiApiKey?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcBaseUrl?: string;
  oidcApplicationSlug?: string;
  oidcRedirectUri?: string;
  maxClaudeWorkers?: number; // deprecated
  maxWorkWorkers?: number;
  claudeTimeoutMs?: number;
  worktreeStaleMs?: number;
  claudeLivenessTimeoutMs?: number;
  claudeWorkerMemoryMaxBytes?: number;
  runners?: RunnerHost[];
  datasetteExport?: DatasetteExport;
  emailEnabled?: boolean;
  emailUser?: string;
  emailAppPassword?: string;
  nameyDbUrl?: string;
  githubAppId?: number;
  githubAppPrivateKeyPath?: string;
  githubAppInstallationIds?: Record<string, number>;
  githubOwnerAppCredentials?: Record<string, OwnerAppCredential>;
  emailRecipient?: string;
  codexDefaultModel?: string;
  codexLightModel?: string;
  openrouterApiKey?: string;
  opencodeBestModel?: string;
  opencodeAdequateModel?: string;
  opencodeCheapModel?: string;
  opencodeTextBestModel?: string;
  opencodeTextAdequateModel?: string;
  opencodeTextCheapModel?: string;
  openrouterBestModel?: string;
  openrouterAdequateModel?: string;
  openrouterCheapModel?: string;
  claudeCheapModel?: string;
  codexCheapModel?: string;
  toolUseProviderFallbackOrder?: Array<"claude" | "codex" | "opencode" | "openrouter">;
  textOnlyProviderFallbackOrder?: Array<"claude" | "codex" | "opencode" | "openrouter">;
  providerRateLimitCooldownMs?: number;
  ollamaBaseUrl?: string;
  whisperBaseUrl?: string;
  ollamaTimeoutMs?: number;
  ollamaConsecutiveFailuresBeforeDisable?: number;
  intervals?: {
    issueWorkerMs?: number;
    issueRefinerMs?: number;
    ciFixerMs?: number;
    reviewAddresserMs?: number;
    autoMergerMs?: number;
    triageClawsErrorsMs?: number;
    ideaCollectorMs?: number;
    runnerMonitorMs?: number;
    emailMonitorMs?: number;
    qaPhaseMs?: number;
    prReviewerMs?: number;
    issueDispatcherMs?: number;
    prDispatcherMs?: number;
    datasetteExportMs?: number;
    k3sMonitorMs?: number;
    prodK8sMonitorMs?: number;
    runnerMetricsSyncMs?: number;
    haUpgraderMs?: number;
    haDeployWatcherMs?: number;
    worktreeCleanerMs?: number;
    binDayMonitorMs?: number;
    batteryMonitorMs?: number;
  };
  schedules?: {
    repoStandardsHour?: number;
    publicRepoScannerHour?: number;
    actionsStorageMonitorHour?: number;
  };
  smartScheduling?: {
    enabled?: boolean;
    quietHourStart?: number;
    quietHourEnd?: number;
    tickIntervalMs?: number;
    jobs?: Record<string, Record<string, never>>;
    targetStalenessMs?: number;
    sloStalenessMs?: number;
    maxConcurrentJobTasks?: number;
    ignoreBusyKinds?: string[];
  };
  dependabotAutoDismissStale?: boolean;
  k3sMonitorEnabled?: boolean;
  k3sIgnoredNodes?: string[];
  fleetInfraRepo?: string;
  prodK8sMonitorEnabled?: boolean;
  prodK8sKubeconfigPath?: string;
  fleetKubeconfigPath?: string;
  prodK8sKubeconfigRefresh?: KubeconfigRefresh;
  prodK8sIgnoredNodes?: string[];
  prodK8sRepo?: string;
  logRetentionDays?: number;
  logRetentionPerJob?: number;
  disabledAgents?: string[];
  pausedJobs?: string[];
  skippedItems?: Array<{ repo: string; number: number }>;
  prioritizedItems?: Array<{ repo: string; number: number }>;
  itemTimeoutOverrides?: Array<{ repo: string; number: number; timeoutMs: number }>;
  allowedActors?: string[];
  notifyDashboardActions?: boolean;
  reviewModelTier?: "sonnet" | "opus";
  ciFixerCircuitBreaker?: {
    maxAttempts?: number;
    windowMs?: number;
    maxConsecutiveFailures?: number;
  };
  disabledJobsByRepo?: Record<string, string[]>;
  dependabotIgnoredAdvisories?: Record<string, string[]>;
  enabledJobsByRepo?: Record<string, string[]>;
  activationState?: "verify-only" | "active";
  homeAssistantBaseUrl?: string;
  homeAssistantToken?: string;
  homeAssistantConfigRepo?: string;
  homeAssistantUpgraderEnabled?: boolean;
  homeAssistantUpgraderExcludePatterns?: string[];
  homeAssistantDeployWatcherEnabled?: boolean;
  homeAssistantGitPullAddonSlug?: string;
  homeAssistantBinDayMonitorEnabled?: boolean;
  homeAssistantBinDaySensorPrefix?: string;
  homeAssistantBatteryMonitorEnabled?: boolean;
  homeAssistantBatteryThresholdPercent?: number;
}

export type ActivationState = "verify-only" | "active";

export const RunnerHostSchema = z.object({
  name: z.string().optional(),
  host: z.string(),
  user: z.string().optional(),
  port: z.number().optional(),
  identityFile: z.string().optional(),
  actionsDir: z.string().regex(/^\/[a-zA-Z0-9._/-]+$/, "actionsDir must be an absolute path with no shell metacharacters"),
});

const DatasetteExportSchema = z.object({
  host: z.string(),
  user: z.string().optional(),
  port: z.number().optional(),
  identityFile: z.string().optional(),
  remotePath: z.string(),
});

const KubeconfigRefreshSchema = z.object({
  tailscaleHostname: z.string().optional(),
  host: z.string().optional(),
  user: z.string().optional(),
  port: z.number().optional(),
  identityFile: z.string().optional(),
  remotePath: z.string(),
  serverPort: z.number().optional(),
  serverOverride: z.string().optional(),
});

const OwnerAppCredentialSchema = z.object({
  appId: z.number(),
  privateKeyPath: z.string(),
  installationId: z.number().optional(),
});

const providerEnum = z.enum(["claude", "codex", "opencode", "openrouter"]);

const ConfigFileSchema = z.object({
  slackWebhook: z.string().optional(),
  slackBotToken: z.string().optional(),
  slackIdeasChannel: z.string().optional(),
  githubOwners: z.array(z.string()).optional(),
  selfRepo: z.string().optional(),
  port: z.number().optional(),
  whatsappEnabled: z.boolean().optional(),
  whatsappAllowedNumbers: z.array(z.string()).optional(),
  openaiApiKey: z.string().optional(),
  oidcClientId: z.string().optional(),
  oidcClientSecret: z.string().optional(),
  oidcBaseUrl: z.string().optional(),
  oidcApplicationSlug: z.string().optional(),
  oidcRedirectUri: z.string().optional(),
  maxClaudeWorkers: z.number().optional(),
  maxWorkWorkers: z.number().optional(),
  claudeTimeoutMs: z.number().optional(),
  worktreeStaleMs: z.number().optional(),
  claudeLivenessTimeoutMs: z.number().optional(),
  claudeWorkerMemoryMaxBytes: z.number().optional(),
  runners: z.array(RunnerHostSchema).optional(),
  datasetteExport: DatasetteExportSchema.optional(),
  emailEnabled: z.boolean().optional(),
  emailUser: z.string().optional(),
  emailAppPassword: z.string().optional(),
  nameyDbUrl: z.string().optional(),
  githubAppId: z.number().optional(),
  githubAppPrivateKeyPath: z.string().optional(),
  githubAppInstallationIds: z.record(z.string(), z.number()).optional(),
  githubOwnerAppCredentials: z.record(z.string(), OwnerAppCredentialSchema).optional(),
  emailRecipient: z.string().optional(),
  codexDefaultModel: z.string().optional(),
  codexLightModel: z.string().optional(),
  openrouterApiKey: z.string().optional(),
  opencodeBestModel: z.string().optional(),
  opencodeAdequateModel: z.string().optional(),
  opencodeCheapModel: z.string().optional(),
  opencodeTextBestModel: z.string().optional(),
  opencodeTextAdequateModel: z.string().optional(),
  opencodeTextCheapModel: z.string().optional(),
  openrouterBestModel: z.string().optional(),
  openrouterAdequateModel: z.string().optional(),
  openrouterCheapModel: z.string().optional(),
  claudeCheapModel: z.string().optional(),
  codexCheapModel: z.string().optional(),
  toolUseProviderFallbackOrder: z.array(providerEnum).optional(),
  textOnlyProviderFallbackOrder: z.array(providerEnum).optional(),
  providerRateLimitCooldownMs: z.number().optional(),
  ollamaBaseUrl: z.string().optional(),
  whisperBaseUrl: z.string().optional(),
  ollamaTimeoutMs: z.number().optional(),
  ollamaConsecutiveFailuresBeforeDisable: z.number().optional(),
  intervals: z.object({
    issueWorkerMs: z.number().optional(),
    issueRefinerMs: z.number().optional(),
    ciFixerMs: z.number().optional(),
    reviewAddresserMs: z.number().optional(),
    autoMergerMs: z.number().optional(),
    triageClawsErrorsMs: z.number().optional(),
    ideaCollectorMs: z.number().optional(),
    runnerMonitorMs: z.number().optional(),
    emailMonitorMs: z.number().optional(),
    qaPhaseMs: z.number().optional(),
    prReviewerMs: z.number().optional(),
    issueDispatcherMs: z.number().optional(),
    prDispatcherMs: z.number().optional(),
    datasetteExportMs: z.number().optional(),
    k3sMonitorMs: z.number().optional(),
    prodK8sMonitorMs: z.number().optional(),
    runnerMetricsSyncMs: z.number().optional(),
    haUpgraderMs: z.number().optional(),
    haDeployWatcherMs: z.number().optional(),
    worktreeCleanerMs: z.number().optional(),
    binDayMonitorMs: z.number().optional(),
    batteryMonitorMs: z.number().optional(),
  }).optional(),
  schedules: z.object({
    repoStandardsHour: z.number().optional(),
    publicRepoScannerHour: z.number().optional(),
    actionsStorageMonitorHour: z.number().optional(),
  }).optional(),
  smartScheduling: z.object({
    enabled: z.boolean().optional(),
    quietHourStart: z.number().optional(),
    quietHourEnd: z.number().optional(),
    tickIntervalMs: z.number().optional(),
    jobs: z.record(z.string(), z.object({})).optional(),
    targetStalenessMs: z.number().optional(),
    sloStalenessMs: z.number().optional(),
    maxConcurrentJobTasks: z.number().optional(),
    ignoreBusyKinds: z.array(z.string()).optional(),
  }).optional(),
  dependabotAutoDismissStale: z.boolean().optional(),
  k3sMonitorEnabled: z.boolean().optional(),
  k3sIgnoredNodes: z.array(z.string()).optional(),
  fleetInfraRepo: z.string().optional(),
  prodK8sMonitorEnabled: z.boolean().optional(),
  prodK8sKubeconfigPath: z.string().optional(),
  fleetKubeconfigPath: z.string().optional(),
  prodK8sKubeconfigRefresh: KubeconfigRefreshSchema.optional(),
  prodK8sIgnoredNodes: z.array(z.string()).optional(),
  prodK8sRepo: z.string().optional(),
  logRetentionDays: z.number().optional(),
  logRetentionPerJob: z.number().optional(),
  disabledAgents: z.array(z.string()).optional(),
  pausedJobs: z.array(z.string()).optional(),
  skippedItems: z.array(z.object({ repo: z.string(), number: z.number() })).optional(),
  prioritizedItems: z.array(z.object({ repo: z.string(), number: z.number() })).optional(),
  itemTimeoutOverrides: z.array(z.object({ repo: z.string(), number: z.number(), timeoutMs: z.number() })).optional(),
  allowedActors: z.array(z.string()).optional(),
  notifyDashboardActions: z.boolean().optional(),
  reviewModelTier: z.enum(["sonnet", "opus"]).optional(),
  ciFixerCircuitBreaker: z.object({
    maxAttempts: z.number().optional(),
    windowMs: z.number().optional(),
    maxConsecutiveFailures: z.number().optional(),
  }).optional(),
  disabledJobsByRepo: z.record(z.string(), z.array(z.string())).optional(),
  dependabotIgnoredAdvisories: z.record(z.string(), z.array(z.string())).optional(),
  enabledJobsByRepo: z.record(z.string(), z.array(z.string())).optional(),
  homeAssistantBaseUrl: z.string().optional(),
  homeAssistantToken: z.string().optional(),
  homeAssistantConfigRepo: z.string().optional(),
  homeAssistantUpgraderEnabled: z.boolean().optional(),
  homeAssistantUpgraderExcludePatterns: z.array(z.string()).optional(),
  homeAssistantDeployWatcherEnabled: z.boolean().optional(),
  homeAssistantGitPullAddonSlug: z.string().optional(),
  homeAssistantBinDayMonitorEnabled: z.boolean().optional(),
  homeAssistantBinDaySensorPrefix: z.string().optional(),
  homeAssistantBatteryMonitorEnabled: z.boolean().optional(),
  homeAssistantBatteryThresholdPercent: z.number().optional(),
  activationState: z.enum(["verify-only", "active"]).optional(),
});

const DEFAULT_RUNNERS: RunnerHost[] = [
  {
    name: "hetzner-actions-runner",
    host: "203.0.113.10",
    user: "actions",
    port: 22,
    identityFile: "~/.ssh/id_ed25519",
    actionsDir: "/home/actions/actions-runner",
  },
  {
    name: "hetzner-beefy-actions",
    host: "203.0.113.11",
    user: "user",
    port: 22,
    identityFile: "~/.ssh/id_ed25519",
    actionsDir: "/home/user/actions-runner",
  },
];

let _unknownConfigKeys: string[] = [];

export function getUnknownConfigKeys(): readonly string[] {
  return _unknownConfigKeys;
}

export function loadConfig() {
  let file: ConfigFile = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const rawParsed = JSON.parse(raw);
    const knownKeys = new Set(Object.keys(ConfigFileSchema.shape));
    _unknownConfigKeys = Object.keys(rawParsed).filter(k => !knownKeys.has(k));
    if (_unknownConfigKeys.length > 0) {
      console.warn(`[config] Unknown config keys (will be discarded): ${_unknownConfigKeys.join(", ")}`);
    }
    const parsed = ConfigFileSchema.safeParse(rawParsed);
    if (!parsed.success) {
      console.warn("[config] Config file failed schema validation:", parsed.error.message);
      file = rawParsed as ConfigFile;
    } else {
      file = parsed.data as ConfigFile;
    }
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

  const runners = file.runners ?? DEFAULT_RUNNERS;
  const datasetteExport = file.datasetteExport ?? null;

  const emailEnabled =
    process.env["CLAWS_EMAIL_ENABLED"] !== undefined
      ? process.env["CLAWS_EMAIL_ENABLED"] === "true"
      : file.emailEnabled ?? true;

  const emailUser =
    process.env["CLAWS_EMAIL_USER"] ?? file.emailUser ?? "";

  const emailAppPassword =
    process.env["BRENDAN_SERVER_GMAIL_APP_PASSWORD"] ?? file.emailAppPassword ?? "";

  const nameyDbUrl =
    process.env["NAMEY_DB_URL"] ?? file.nameyDbUrl ?? "";

  const githubAppIdRaw =
    process.env["CLAWS_GITHUB_APP_ID"] ??
    (file.githubAppId !== undefined ? String(file.githubAppId) : "");
  const githubAppId = githubAppIdRaw ? parseInt(githubAppIdRaw, 10) : 0;
  const githubAppPrivateKeyPath =
    process.env["CLAWS_GITHUB_APP_PRIVATE_KEY_PATH"] ??
    file.githubAppPrivateKeyPath ?? "";
  const githubAppInstallationIds: Record<string, number> =
    file.githubAppInstallationIds ?? {};
  const githubOwnerAppCredentials: Record<string, OwnerAppCredential> =
    file.githubOwnerAppCredentials ?? {};

  const emailRecipient =
    process.env["CLAWS_EMAIL_RECIPIENT"] ?? file.emailRecipient ?? "";

  const codexDefaultModel =
    process.env["CLAWS_CODEX_DEFAULT_MODEL"] ?? file.codexDefaultModel ?? "o3";

  const codexLightModel =
    process.env["CLAWS_CODEX_LIGHT_MODEL"] ?? file.codexLightModel ?? "o4-mini";

  const openrouterApiKey =
    process.env["CLAWS_OPENROUTER_API_KEY"] ?? file.openrouterApiKey ?? "";

  const opencodeBestModel =
    process.env["CLAWS_OPENCODE_BEST_MODEL"] ?? file.opencodeBestModel ?? "openrouter/anthropic/claude-opus-4";

  const opencodeAdequateModel =
    process.env["CLAWS_OPENCODE_ADEQUATE_MODEL"] ?? file.opencodeAdequateModel ?? "openrouter/anthropic/claude-sonnet-4.5";

  const opencodeCheapModel =
    process.env["CLAWS_OPENCODE_CHEAP_MODEL"] ?? file.opencodeCheapModel ?? "openrouter/google/gemini-2.5-flash";

  // NOTE on model selection for text-only workflows: opencode's `run` command
  // always sends tool schemas in the request (the primary "plan" agent still
  // has read/grep/glob/webfetch tools), which means the underlying model must
  // support function calling — not every OpenRouter endpoint does. Qwen 2.5
  // Coder 32B, for example, is served by providers that don't expose a
  // tool-capable endpoint and the request fails with "No endpoints found that
  // support tool use". Defaults below are picked from tool-capable, low-cost
  // OpenRouter models. Operators can override via config to experiment with
  // Qwen 3 Coder, DeepSeek, etc. once they verify tool-use support.
  const opencodeTextBestModel =
    process.env["CLAWS_OPENCODE_TEXT_BEST_MODEL"] ?? file.opencodeTextBestModel ?? "openrouter/google/gemini-2.5-flash";

  const opencodeTextAdequateModel =
    process.env["CLAWS_OPENCODE_TEXT_ADEQUATE_MODEL"] ?? file.opencodeTextAdequateModel ?? "openrouter/google/gemini-2.5-flash";

  const opencodeTextCheapModel =
    process.env["CLAWS_OPENCODE_TEXT_CHEAP_MODEL"] ?? file.opencodeTextCheapModel ?? "openrouter/google/gemini-2.5-flash-lite";

  // Direct OpenRouter HTTP backend. Unlike the opencode-wrapped path, this
  // calls OpenRouter's chat completions API directly via fetch() with no
  // tool schemas attached, which unlocks models whose OpenRouter endpoints
  // don't support function calling (notably Qwen 2.5 Coder 32B). Used for
  // pure text-generation workflows like PR review.
  const openrouterBestModel =
    process.env["CLAWS_OPENROUTER_BEST_MODEL"] ?? file.openrouterBestModel ?? "qwen/qwen-2.5-coder-32b-instruct";

  const openrouterAdequateModel =
    process.env["CLAWS_OPENROUTER_ADEQUATE_MODEL"] ?? file.openrouterAdequateModel ?? "qwen/qwen-2.5-coder-32b-instruct";

  const openrouterCheapModel =
    process.env["CLAWS_OPENROUTER_CHEAP_MODEL"] ?? file.openrouterCheapModel ?? "google/gemini-2.5-flash-lite";

  const claudeCheapModel =
    process.env["CLAWS_CLAUDE_CHEAP_MODEL"] ?? file.claudeCheapModel ?? "claude-haiku-4-5-20251001";

  const codexCheapModel =
    process.env["CLAWS_CODEX_CHEAP_MODEL"] ?? file.codexCheapModel ?? "o4-mini";

  type ProviderName = "claude" | "codex" | "opencode" | "openrouter";
  function parseProviderOrder(raw: string | undefined, fileValue: Array<ProviderName> | undefined, fallback: Array<ProviderName>): Array<ProviderName> {
    const parsed = raw
      ? raw.split(",").map((s) => s.trim()).filter(
          (s): s is ProviderName => s === "claude" || s === "codex" || s === "opencode" || s === "openrouter",
        )
      : fileValue ?? fallback;
    return parsed.length > 0 ? parsed : fallback;
  }

  const toolUseProviderFallbackOrder = parseProviderOrder(
    process.env["CLAWS_TOOL_USE_PROVIDER_FALLBACK_ORDER"],
    file.toolUseProviderFallbackOrder,
    ["claude"],
  );

  const textOnlyProviderFallbackOrder = parseProviderOrder(
    process.env["CLAWS_TEXT_ONLY_PROVIDER_FALLBACK_ORDER"],
    file.textOnlyProviderFallbackOrder,
    ["openrouter"],
  );

  const providerRateLimitCooldownMs = parseInt(
    process.env["CLAWS_PROVIDER_RATE_LIMIT_COOLDOWN_MS"] ?? String(file.providerRateLimitCooldownMs ?? 5 * 60 * 1000),
    10,
  );

  const ollamaBaseUrl =
    process.env["CLAWS_OLLAMA_BASE_URL"] ?? file.ollamaBaseUrl ?? "https://ollama.home.example.invalid";

  const whisperBaseUrl =
    process.env["CLAWS_WHISPER_BASE_URL"] ?? file.whisperBaseUrl ?? "https://whisper.home.example.invalid";

  const ollamaTimeoutMs = parseInt(
    process.env["CLAWS_OLLAMA_TIMEOUT_MS"] ?? String(file.ollamaTimeoutMs ?? 60_000),
    10,
  );

  const ollamaConsecutiveFailuresBeforeDisable = parseInt(
    process.env["CLAWS_OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE"] ?? String(file.ollamaConsecutiveFailuresBeforeDisable ?? 3),
    10,
  );

  const intervals = {
    issueWorkerMs: file.intervals?.issueWorkerMs ?? 5 * 60 * 1000,
    issueRefinerMs: file.intervals?.issueRefinerMs ?? 5 * 60 * 1000,
    ciFixerMs: file.intervals?.ciFixerMs ?? 10 * 60 * 1000,
    reviewAddresserMs: file.intervals?.reviewAddresserMs ?? 5 * 60 * 1000,
    autoMergerMs: file.intervals?.autoMergerMs ?? 10 * 60 * 1000,
    triageClawsErrorsMs: file.intervals?.triageClawsErrorsMs ?? 10 * 60 * 1000,
    ideaCollectorMs: file.intervals?.ideaCollectorMs ?? 30 * 60 * 1000,
    runnerMonitorMs: file.intervals?.runnerMonitorMs ?? 10 * 60 * 1000,
    emailMonitorMs: file.intervals?.emailMonitorMs ?? 5 * 60 * 1000,
    qaPhaseMs: file.intervals?.qaPhaseMs ?? 10 * 60 * 1000,
    prReviewerMs: file.intervals?.prReviewerMs ?? 10 * 60 * 1000,
    issueDispatcherMs: file.intervals?.issueDispatcherMs ?? 5 * 60 * 1000,
    prDispatcherMs: file.intervals?.prDispatcherMs ?? 5 * 60 * 1000,
    datasetteExportMs: file.intervals?.datasetteExportMs ?? 6 * 60 * 60 * 1000,
    k3sMonitorMs: file.intervals?.k3sMonitorMs ?? 15 * 60 * 1000,
    prodK8sMonitorMs: file.intervals?.prodK8sMonitorMs ?? 15 * 60 * 1000,
    runnerMetricsSyncMs: file.intervals?.runnerMetricsSyncMs ?? 2 * 60 * 1000,
    haUpgraderMs: file.intervals?.haUpgraderMs ?? 24 * 60 * 60 * 1000,
    haDeployWatcherMs: file.intervals?.haDeployWatcherMs ?? 5 * 60 * 1000,
    worktreeCleanerMs: file.intervals?.worktreeCleanerMs ?? 24 * 60 * 60 * 1000,
    binDayMonitorMs: file.intervals?.binDayMonitorMs ?? 15 * 60 * 1000,
    batteryMonitorMs: file.intervals?.batteryMonitorMs ?? 60 * 60 * 1000,
  };

  const schedules = {
    repoStandardsHour: file.schedules?.repoStandardsHour ?? 2, // 2 AM local time
    publicRepoScannerHour: file.schedules?.publicRepoScannerHour ?? 4, // 4 AM local time
    actionsStorageMonitorHour: file.schedules?.actionsStorageMonitorHour ?? 5, // 5 AM local time
  };

  const smartScheduling = {
    enabled: file.smartScheduling?.enabled ?? true,
    quietHourStart: file.smartScheduling?.quietHourStart ?? 19,
    quietHourEnd: file.smartScheduling?.quietHourEnd ?? 7,
    tickIntervalMs: file.smartScheduling?.tickIntervalMs ?? 60 * 60 * 1000,
    jobs: file.smartScheduling?.jobs ?? {
      "idea-suggester": {},
      "improvement-identifier": {},
      "doc-maintainer": {},
      "issue-auditor": {},
      "scanner-dispatcher": {},
      "stale-branch-cleaner": {},
      "idea-reconciler": {},
    },
    targetStalenessMs: file.smartScheduling?.targetStalenessMs ?? 24 * 60 * 60 * 1000,
    sloStalenessMs: file.smartScheduling?.sloStalenessMs ?? 48 * 60 * 60 * 1000,
    maxConcurrentJobTasks: file.smartScheduling?.maxConcurrentJobTasks ?? 4,
    ignoreBusyKinds: file.smartScheduling?.ignoreBusyKinds ?? [
      "ci-fixer",
      "ci-fixer:conflict",
      "ci-fixer:rerun",
      "ci-fixer:problematic",
      "review-addresser",
      "pr-reviewer",
      "auto-merger:sweep",
      // smart-schedule jobs — concurrency is managed by withSmartJobSlot, not isClawsBusy
      "doc-maintainer",
      "improvement-identifier",
      "idea-suggester",
      "issue-auditor",
    ],
  };

  const whatsappEnabled =
    process.env["WHATSAPP_ENABLED"] === "true" || file.whatsappEnabled === true;

  const whatsappAllowedNumbers = process.env["WHATSAPP_ALLOWED_NUMBERS"]
    ? process.env["WHATSAPP_ALLOWED_NUMBERS"].split(",").map((s) => s.trim()).filter(Boolean)
    : file.whatsappAllowedNumbers ?? [];

  const whatsappAuthDir = path.join(WORK_DIR, "whatsapp-auth");

  const openaiApiKey =
    process.env["OPENAI_API_KEY"] ?? file.openaiApiKey ?? "";

  const oidcClientId =
    process.env["CLAWS_OIDC_CLIENT_ID"] ?? file.oidcClientId ?? "";
  const oidcClientSecret =
    process.env["CLAWS_OIDC_CLIENT_SECRET"] ?? file.oidcClientSecret ?? "";
  const oidcBaseUrl =
    process.env["CLAWS_OIDC_BASE_URL"] ?? file.oidcBaseUrl ?? "";
  const oidcApplicationSlug =
    process.env["CLAWS_OIDC_APPLICATION_SLUG"] ?? file.oidcApplicationSlug ?? "";
  const oidcRedirectUri =
    process.env["CLAWS_OIDC_REDIRECT_URI"] ?? file.oidcRedirectUri ?? "";

  if (process.env["CLAWS_MAX_CLAUDE_WORKERS"] && !process.env["CLAWS_MAX_WORK_WORKERS"]) {
    console.warn(
      `CLAWS_MAX_CLAUDE_WORKERS is deprecated; ` +
        `set CLAWS_MAX_WORK_WORKERS instead (currently using ${process.env["CLAWS_MAX_CLAUDE_WORKERS"]} as fallback)`,
    );
  }
  if (file.maxClaudeWorkers !== undefined && file.maxWorkWorkers === undefined &&
      !process.env["CLAWS_MAX_WORK_WORKERS"]) {
    console.warn(
      `Config key 'maxClaudeWorkers' (value: ${file.maxClaudeWorkers}) is deprecated; ` +
        `rename to 'maxWorkWorkers' in ~/.claws/config.json`,
    );
  }
  const maxWorkWorkers = parseInt(
    process.env["CLAWS_MAX_WORK_WORKERS"] ??
      process.env["CLAWS_MAX_CLAUDE_WORKERS"] ??
      String(file.maxWorkWorkers ?? file.maxClaudeWorkers ?? 2),
    10,
  );

  const claudeTimeoutMs = Math.max(
    60_000,
    parseInt(
      process.env["CLAWS_CLAUDE_TIMEOUT_MS"] ?? String(file.claudeTimeoutMs ?? 6 * 60 * 60 * 1000),
      10,
    ),
  );

  const worktreeStaleMs = file.worktreeStaleMs ?? 7 * 24 * 60 * 60 * 1000;

  const claudeLivenessTimeoutMs = Math.max(
    60_000,
    parseInt(
      process.env["CLAWS_CLAUDE_LIVENESS_TIMEOUT_MS"] ?? String(file.claudeLivenessTimeoutMs ?? 6 * 60 * 60 * 1000),
      10,
    ),
  );

  const _parsedWorkerMemory = parseInt(
    process.env["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES"] ??
      String(file.claudeWorkerMemoryMaxBytes ?? 2_147_483_648),
    10,
  );
  const claudeWorkerMemoryMaxBytes = Math.max(
    0,
    Number.isNaN(_parsedWorkerMemory) ? 2_147_483_648 : _parsedWorkerMemory,
  );

  const logRetentionDays = file.logRetentionDays ?? 14;
  const logRetentionPerJob = file.logRetentionPerJob ?? 20;
  const pausedJobs = file.pausedJobs ?? [];
  const disabledAgents = file.disabledAgents ?? [];
  const skippedItems = file.skippedItems ?? [];
  const prioritizedItems = file.prioritizedItems ?? [];
  const itemTimeoutOverrides = file.itemTimeoutOverrides ?? [];
  const allowedActors = file.allowedActors ?? ["stjohnb"];
  const notifyDashboardActions = file.notifyDashboardActions ?? true;

  const rawReviewModelTier = process.env["CLAWS_REVIEW_MODEL_TIER"] ?? file.reviewModelTier ?? "sonnet";
  const reviewModelTier: "sonnet" | "opus" = rawReviewModelTier === "opus" ? "opus" : "sonnet";

  const dependabotAutoDismissStale =
    process.env["CLAWS_DEPENDABOT_AUTO_DISMISS_STALE"] !== undefined
      ? process.env["CLAWS_DEPENDABOT_AUTO_DISMISS_STALE"] === "true"
      : file.dependabotAutoDismissStale ?? true;

  const k3sMonitorEnabled =
    process.env["CLAWS_K3S_MONITOR_ENABLED"] !== undefined
      ? process.env["CLAWS_K3S_MONITOR_ENABLED"] === "true"
      : file.k3sMonitorEnabled ?? true;

  const k3sIgnoredNodes = file.k3sIgnoredNodes ?? ["k3s-nas", "ryzen"];

  const fleetInfraRepo =
    process.env["CLAWS_FLEET_INFRA_REPO"] ?? file.fleetInfraRepo ?? "St-John-Software/fleet-infra";

  const prodK8sMonitorEnabled =
    process.env["CLAWS_PROD_K8S_MONITOR_ENABLED"] !== undefined
      ? process.env["CLAWS_PROD_K8S_MONITOR_ENABLED"] === "true"
      : file.prodK8sMonitorEnabled ?? false;

  const prodK8sKubeconfigPath =
    process.env["CLAWS_PROD_K8S_KUBECONFIG_PATH"] ?? file.prodK8sKubeconfigPath ?? "";

  const fleetKubeconfigPath =
    process.env["CLAWS_FLEET_KUBECONFIG_PATH"] ?? file.fleetKubeconfigPath ?? "~/.kube/config";

  const prodK8sKubeconfigRefresh = file.prodK8sKubeconfigRefresh ?? null;

  const prodK8sIgnoredNodes = file.prodK8sIgnoredNodes ?? [];

  const prodK8sRepo =
    process.env["CLAWS_PROD_K8S_REPO"] ?? file.prodK8sRepo ?? "St-John-Software/production-infra";

  const homeAssistantBaseUrl =
    process.env["CLAWS_HOME_ASSISTANT_BASE_URL"] ?? file.homeAssistantBaseUrl ?? "";

  const homeAssistantToken =
    process.env["CLAWS_HOME_ASSISTANT_TOKEN"] ?? file.homeAssistantToken ?? "";

  const homeAssistantConfigRepo =
    process.env["CLAWS_HOME_ASSISTANT_CONFIG_REPO"] ?? file.homeAssistantConfigRepo;

  const homeAssistantUpgraderEnabled =
    process.env["CLAWS_HOME_ASSISTANT_UPGRADER_ENABLED"] !== undefined
      ? process.env["CLAWS_HOME_ASSISTANT_UPGRADER_ENABLED"] === "true"
      : file.homeAssistantUpgraderEnabled ?? !!(homeAssistantBaseUrl && homeAssistantToken);

  const homeAssistantUpgraderExcludePatterns: string[] = process.env["CLAWS_HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS"]
    ? process.env["CLAWS_HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS"].split(",").map((s) => s.trim()).filter(Boolean)
    : file.homeAssistantUpgraderExcludePatterns ?? [];

  const homeAssistantDeployWatcherEnabled =
    process.env["CLAWS_HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED"] !== undefined
      ? process.env["CLAWS_HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED"] === "true"
      : file.homeAssistantDeployWatcherEnabled !== undefined
        ? file.homeAssistantDeployWatcherEnabled
        : !!(homeAssistantBaseUrl && homeAssistantToken);

  const homeAssistantGitPullAddonSlug =
    process.env["CLAWS_HOME_ASSISTANT_GIT_PULL_ADDON_SLUG"] ??
    file.homeAssistantGitPullAddonSlug ?? "core_git_pull";

  const homeAssistantBinDayMonitorEnabled =
    process.env["CLAWS_HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED"] !== undefined
      ? process.env["CLAWS_HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED"] === "true"
      : file.homeAssistantBinDayMonitorEnabled ?? false;

  const homeAssistantBinDaySensorPrefix =
    process.env["CLAWS_HOME_ASSISTANT_BIN_DAY_SENSOR_PREFIX"] ??
    file.homeAssistantBinDaySensorPrefix ?? "sensor.bin_scraper_";

  const homeAssistantBatteryMonitorEnabled =
    process.env["CLAWS_HOME_ASSISTANT_BATTERY_MONITOR_ENABLED"] !== undefined
      ? process.env["CLAWS_HOME_ASSISTANT_BATTERY_MONITOR_ENABLED"] === "true"
      : file.homeAssistantBatteryMonitorEnabled ?? false;
  const homeAssistantBatteryThresholdPercent =
    process.env["CLAWS_HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT"] !== undefined
      ? Number(process.env["CLAWS_HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT"])
      : file.homeAssistantBatteryThresholdPercent ?? 10;

  const ciFixerCircuitBreaker = {
    maxAttempts: file.ciFixerCircuitBreaker?.maxAttempts ?? 5,
    windowMs: file.ciFixerCircuitBreaker?.windowMs ?? 24 * 60 * 60 * 1000,
    maxConsecutiveFailures: file.ciFixerCircuitBreaker?.maxConsecutiveFailures ?? 3,
  };

  const disabledJobsByRepo: Record<string, string[]> = file.disabledJobsByRepo ?? {};
  const dependabotIgnoredAdvisories: Record<string, string[]> = file.dependabotIgnoredAdvisories ?? {};
  const enabledJobsByRepo: Record<string, string[]> = file.enabledJobsByRepo ?? {};

  // Activation state: env wins > config file > default-based-on-existing-db.
  // A pre-existing DB means this host was already running as `active`, so we
  // auto-preserve that. Fresh installs (no DB) default to `verify-only` so a
  // new deployment (e.g. k8s pod) can be brought up alongside the existing
  // host without racing on shared state.
  const rawActivationState =
    process.env["CLAWS_ACTIVATION_STATE"] ?? file.activationState;
  // Track whether the value came from an explicit source (env var or config
  // file). reloadConfig() uses this to avoid re-running the dbExists check on
  // every reload, which would silently flip verify-only → active after initDb()
  // creates the DB.
  const activationStateIsExplicit =
    rawActivationState === "active" || rawActivationState === "verify-only";
  const dbExists = fs.existsSync(path.join(WORK_DIR, "claws.db"));
  const activationState: ActivationState = activationStateIsExplicit
    ? rawActivationState
    : dbExists
    ? "active"
    : "verify-only";

  const bindHost = process.env["CLAWS_BIND_HOST"] ?? "0.0.0.0";

  if (!slackWebhook) {
    console.warn(
      "Warning: No Slack webhook configured. Set CLAWS_SLACK_WEBHOOK or slackWebhook in ~/.claws/config.json",
    );
  }

  return { slackWebhook, slackBotToken, slackIdeasChannel, githubOwners, selfRepo, port, runners, datasetteExport, intervals, schedules, smartScheduling, logRetentionDays, logRetentionPerJob, whatsappEnabled, whatsappAllowedNumbers, whatsappAuthDir, openaiApiKey, oidcClientId, oidcClientSecret, oidcBaseUrl, oidcApplicationSlug, oidcRedirectUri, maxWorkWorkers, claudeTimeoutMs, worktreeStaleMs, claudeLivenessTimeoutMs, claudeWorkerMemoryMaxBytes, pausedJobs, disabledAgents, skippedItems, prioritizedItems, itemTimeoutOverrides, allowedActors, emailEnabled, emailUser, emailAppPassword, emailRecipient, nameyDbUrl, githubAppId, githubAppPrivateKeyPath, githubAppInstallationIds, githubOwnerAppCredentials, codexDefaultModel, codexLightModel, openrouterApiKey, opencodeBestModel, opencodeAdequateModel, opencodeCheapModel, opencodeTextBestModel, opencodeTextAdequateModel, opencodeTextCheapModel, openrouterBestModel, openrouterAdequateModel, openrouterCheapModel, claudeCheapModel, codexCheapModel, toolUseProviderFallbackOrder, textOnlyProviderFallbackOrder, providerRateLimitCooldownMs, ollamaBaseUrl, whisperBaseUrl, ollamaTimeoutMs, ollamaConsecutiveFailuresBeforeDisable, notifyDashboardActions, reviewModelTier, dependabotAutoDismissStale, k3sMonitorEnabled, k3sIgnoredNodes, fleetInfraRepo, prodK8sMonitorEnabled, prodK8sKubeconfigPath, fleetKubeconfigPath, prodK8sKubeconfigRefresh, prodK8sIgnoredNodes, prodK8sRepo, ciFixerCircuitBreaker, disabledJobsByRepo, dependabotIgnoredAdvisories, enabledJobsByRepo, activationState, activationStateIsExplicit, bindHost, homeAssistantBaseUrl, homeAssistantToken, homeAssistantConfigRepo, homeAssistantUpgraderEnabled, homeAssistantUpgraderExcludePatterns, homeAssistantDeployWatcherEnabled, homeAssistantGitPullAddonSlug, homeAssistantBinDayMonitorEnabled, homeAssistantBinDaySensorPrefix, homeAssistantBatteryMonitorEnabled, homeAssistantBatteryThresholdPercent };
}

const config = loadConfig();

export let SLACK_WEBHOOK = config.slackWebhook;
export let SLACK_BOT_TOKEN = config.slackBotToken;
export let SLACK_IDEAS_CHANNEL = config.slackIdeasChannel;
export let GITHUB_OWNERS: readonly string[] = config.githubOwners;
export let SELF_REPO = config.selfRepo;
export const SERVER_PORT = config.port; // immutable — requires restart
export let RUNNER_HOSTS: readonly RunnerHost[] = config.runners;
export let DATASETTE_EXPORT: DatasetteExport | null = config.datasetteExport;
export let INTERVALS = config.intervals;
export let WORKTREE_STALE_MS = config.worktreeStaleMs;
export let SCHEDULES = config.schedules;
export let SMART_SCHEDULING = config.smartScheduling;
export let LOG_RETENTION_DAYS = config.logRetentionDays;
export let LOG_RETENTION_PER_JOB = config.logRetentionPerJob;
export const WHATSAPP_ENABLED = config.whatsappEnabled; // immutable — requires restart (QR pairing)
export let WHATSAPP_ALLOWED_NUMBERS: readonly string[] = config.whatsappAllowedNumbers;
export const WHATSAPP_AUTH_DIR = config.whatsappAuthDir;
export let OPENAI_API_KEY = config.openaiApiKey;
export let OIDC_CLIENT_ID = config.oidcClientId;
export let OIDC_CLIENT_SECRET = config.oidcClientSecret;
export let OIDC_BASE_URL = config.oidcBaseUrl;
export let OIDC_APPLICATION_SLUG = config.oidcApplicationSlug;
export let OIDC_REDIRECT_URI = config.oidcRedirectUri;
export let MAX_WORK_WORKERS = config.maxWorkWorkers;
export let CLAUDE_TIMEOUT_MS = config.claudeTimeoutMs;
export let CLAUDE_LIVENESS_TIMEOUT_MS = config.claudeLivenessTimeoutMs;
export let CLAUDE_WORKER_MEMORY_MAX_BYTES = config.claudeWorkerMemoryMaxBytes;
export let DISABLED_AGENTS: readonly string[] = config.disabledAgents;
export let PAUSED_JOBS: readonly string[] = config.pausedJobs;
export let SKIPPED_ITEMS: ReadonlyArray<{ repo: string; number: number }> = config.skippedItems;
export let PRIORITIZED_ITEMS: ReadonlyArray<{ repo: string; number: number }> = config.prioritizedItems;
export let ITEM_TIMEOUT_OVERRIDES: ReadonlyArray<{ repo: string; number: number; timeoutMs: number }> = config.itemTimeoutOverrides;
export let ALLOWED_ACTORS: readonly string[] = config.allowedActors;
export const EMAIL_ENABLED = config.emailEnabled; // immutable — requires restart
export let EMAIL_USER = config.emailUser;
export let EMAIL_APP_PASSWORD = config.emailAppPassword;
export let EMAIL_RECIPIENT = config.emailRecipient;
export let NAMEY_DB_URL = config.nameyDbUrl;
export let GITHUB_APP_ID = config.githubAppId;
export let GITHUB_APP_PRIVATE_KEY_PATH = config.githubAppPrivateKeyPath;
export let GITHUB_APP_INSTALLATION_IDS: Readonly<Record<string, number>> = config.githubAppInstallationIds;
export let GITHUB_OWNER_APP_CREDENTIALS: Readonly<Record<string, OwnerAppCredential>> = config.githubOwnerAppCredentials;
export let CODEX_DEFAULT_MODEL = config.codexDefaultModel;
export let CODEX_LIGHT_MODEL = config.codexLightModel;
export let OPENROUTER_API_KEY = config.openrouterApiKey;
export let OPENCODE_BEST_MODEL = config.opencodeBestModel;
export let OPENCODE_ADEQUATE_MODEL = config.opencodeAdequateModel;
export let OPENCODE_CHEAP_MODEL = config.opencodeCheapModel;
export let OPENCODE_TEXT_BEST_MODEL = config.opencodeTextBestModel;
export let OPENCODE_TEXT_ADEQUATE_MODEL = config.opencodeTextAdequateModel;
export let OPENCODE_TEXT_CHEAP_MODEL = config.opencodeTextCheapModel;
export let OPENROUTER_BEST_MODEL = config.openrouterBestModel;
export let OPENROUTER_ADEQUATE_MODEL = config.openrouterAdequateModel;
export let OPENROUTER_CHEAP_MODEL = config.openrouterCheapModel;
export let CLAUDE_CHEAP_MODEL = config.claudeCheapModel;
export let CODEX_CHEAP_MODEL = config.codexCheapModel;
export let TOOL_USE_PROVIDER_FALLBACK_ORDER: ReadonlyArray<"claude" | "codex" | "opencode" | "openrouter"> = config.toolUseProviderFallbackOrder;
export let TEXT_ONLY_PROVIDER_FALLBACK_ORDER: ReadonlyArray<"claude" | "codex" | "opencode" | "openrouter"> = config.textOnlyProviderFallbackOrder;
export let PROVIDER_RATE_LIMIT_COOLDOWN_MS = config.providerRateLimitCooldownMs;
export let OLLAMA_BASE_URL = config.ollamaBaseUrl;
export let WHISPER_BASE_URL = config.whisperBaseUrl;
export let OLLAMA_TIMEOUT_MS = config.ollamaTimeoutMs;
export let OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE = config.ollamaConsecutiveFailuresBeforeDisable;
export let NOTIFY_DASHBOARD_ACTIONS = config.notifyDashboardActions;
export let REVIEW_MODEL_TIER: "sonnet" | "opus" = config.reviewModelTier;
export let DEPENDABOT_AUTO_DISMISS_STALE = config.dependabotAutoDismissStale;
export let K3S_MONITOR_ENABLED = config.k3sMonitorEnabled;
export let K3S_IGNORED_NODES: readonly string[] = config.k3sIgnoredNodes;
export let FLEET_INFRA_REPO = config.fleetInfraRepo;
export let PROD_K8S_MONITOR_ENABLED = config.prodK8sMonitorEnabled;
export let PROD_K8S_KUBECONFIG_PATH = config.prodK8sKubeconfigPath;
export let FLEET_KUBECONFIG_PATH = config.fleetKubeconfigPath;
export let PROD_K8S_KUBECONFIG_REFRESH: KubeconfigRefresh | null = config.prodK8sKubeconfigRefresh;
export let PROD_K8S_IGNORED_NODES: readonly string[] = config.prodK8sIgnoredNodes;
export let PROD_K8S_REPO = config.prodK8sRepo;
export let CI_FIXER_CIRCUIT_BREAKER = config.ciFixerCircuitBreaker;
export let DISABLED_JOBS_BY_REPO: Readonly<Record<string, readonly string[]>> = config.disabledJobsByRepo;
export let DEPENDABOT_IGNORED_ADVISORIES: Readonly<Record<string, readonly string[]>> = config.dependabotIgnoredAdvisories;
export let ENABLED_JOBS_BY_REPO: Readonly<Record<string, readonly string[]>> = config.enabledJobsByRepo;
export let ACTIVATION_STATE: ActivationState = config.activationState;
export let HOME_ASSISTANT_BASE_URL = config.homeAssistantBaseUrl;
export let HOME_ASSISTANT_TOKEN = config.homeAssistantToken;
export let HOME_ASSISTANT_CONFIG_REPO = config.homeAssistantConfigRepo;
export let HOME_ASSISTANT_UPGRADER_ENABLED = config.homeAssistantUpgraderEnabled;
export let HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS: ReadonlyArray<string> = config.homeAssistantUpgraderExcludePatterns;
export let HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED = config.homeAssistantDeployWatcherEnabled;
export let HOME_ASSISTANT_GIT_PULL_ADDON_SLUG = config.homeAssistantGitPullAddonSlug;
export let HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED = config.homeAssistantBinDayMonitorEnabled;
export let HOME_ASSISTANT_BIN_DAY_SENSOR_PREFIX = config.homeAssistantBinDaySensorPrefix;
export let HOME_ASSISTANT_BATTERY_MONITOR_ENABLED = config.homeAssistantBatteryMonitorEnabled;
export let HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT = config.homeAssistantBatteryThresholdPercent;

/** Jobs disabled by default for all repos; must be explicitly opted in via enabledJobsByRepo. */
export const OPT_IN_JOB_NAMES: ReadonlySet<string> = new Set(["main-build-monitor-scanner"]);
export const BIND_HOST = config.bindHost; // immutable — requires restart

export function isActive(): boolean {
  return ACTIVATION_STATE === "active";
}

// Circuit breaker configuration accessors
export const CI_FIXER_MAX_ATTEMPTS = () => CI_FIXER_CIRCUIT_BREAKER.maxAttempts;
export const CI_FIXER_WINDOW_MS = () => CI_FIXER_CIRCUIT_BREAKER.windowMs;
export const CI_FIXER_MAX_CONSECUTIVE_FAILURES = () => CI_FIXER_CIRCUIT_BREAKER.maxConsecutiveFailures;

/** Valid agent names for disabledAgents config. */
export const VALID_AGENT_NAMES = ["planner", "implementer", "ci-fixer", "review-addresser", "reviewer", "merger"] as const;
/** Check whether a specific agent is disabled. */
export function isAgentDisabled(name: string): boolean {
  return DISABLED_AGENTS.includes(name);
}

/** GHSA advisory IDs to suppress for a repo (merges the "*" global list). Lowercased. */
export function getIgnoredAdvisoriesForRepo(repoFullName: string): Set<string> {
  const out = new Set<string>();
  for (const key of ["*", repoFullName]) {
    const list = DEPENDABOT_IGNORED_ADVISORIES[key];
    if (list) for (const id of list) out.add(id.toLowerCase());
  }
  return out;
}

/** Check whether a specific job is disabled for a given repo. */
export function isJobDisabledForRepo(jobName: string, repoFullName: string): boolean {
  const disabled = DISABLED_JOBS_BY_REPO[repoFullName];
  if (disabled !== undefined && disabled.includes(jobName)) return true;
  // Opt-in jobs are disabled by default; require explicit enablement via enabledJobsByRepo.
  if (OPT_IN_JOB_NAMES.has(jobName)) {
    const enabled = ENABLED_JOBS_BY_REPO[repoFullName];
    return enabled === undefined || !enabled.includes(jobName);
  }
  return false;
}

// ── Change notification system ──

type ConfigChangeListener = () => void;
const listeners: Set<ConfigChangeListener> = new Set();

export function onConfigChange(listener: ConfigChangeListener): void {
  listeners.add(listener);
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
  RUNNER_HOSTS = fresh.runners;
  DATASETTE_EXPORT = fresh.datasetteExport;
  INTERVALS = fresh.intervals;
  WORKTREE_STALE_MS = fresh.worktreeStaleMs;
  SCHEDULES = fresh.schedules;
  SMART_SCHEDULING = fresh.smartScheduling;
  LOG_RETENTION_DAYS = fresh.logRetentionDays;
  LOG_RETENTION_PER_JOB = fresh.logRetentionPerJob;
  WHATSAPP_ALLOWED_NUMBERS = fresh.whatsappAllowedNumbers;
  OPENAI_API_KEY = fresh.openaiApiKey;
  OIDC_CLIENT_ID = fresh.oidcClientId;
  OIDC_CLIENT_SECRET = fresh.oidcClientSecret;
  OIDC_BASE_URL = fresh.oidcBaseUrl;
  OIDC_APPLICATION_SLUG = fresh.oidcApplicationSlug;
  OIDC_REDIRECT_URI = fresh.oidcRedirectUri;
  MAX_WORK_WORKERS = fresh.maxWorkWorkers;
  CLAUDE_TIMEOUT_MS = fresh.claudeTimeoutMs;
  CLAUDE_LIVENESS_TIMEOUT_MS = fresh.claudeLivenessTimeoutMs;
  CLAUDE_WORKER_MEMORY_MAX_BYTES = fresh.claudeWorkerMemoryMaxBytes;
  DISABLED_AGENTS = fresh.disabledAgents;
  PAUSED_JOBS = fresh.pausedJobs;
  SKIPPED_ITEMS = fresh.skippedItems;
  PRIORITIZED_ITEMS = fresh.prioritizedItems;
  ITEM_TIMEOUT_OVERRIDES = fresh.itemTimeoutOverrides;
  ALLOWED_ACTORS = fresh.allowedActors;
  EMAIL_USER = fresh.emailUser;
  EMAIL_APP_PASSWORD = fresh.emailAppPassword;
  EMAIL_RECIPIENT = fresh.emailRecipient;
  NAMEY_DB_URL = fresh.nameyDbUrl;
  GITHUB_APP_ID = fresh.githubAppId;
  GITHUB_APP_PRIVATE_KEY_PATH = fresh.githubAppPrivateKeyPath;
  GITHUB_APP_INSTALLATION_IDS = fresh.githubAppInstallationIds;
  GITHUB_OWNER_APP_CREDENTIALS = fresh.githubOwnerAppCredentials;
  resetGitHubAppState();
  CODEX_DEFAULT_MODEL = fresh.codexDefaultModel;
  CODEX_LIGHT_MODEL = fresh.codexLightModel;
  OPENROUTER_API_KEY = fresh.openrouterApiKey;
  OPENCODE_BEST_MODEL = fresh.opencodeBestModel;
  OPENCODE_ADEQUATE_MODEL = fresh.opencodeAdequateModel;
  OPENCODE_CHEAP_MODEL = fresh.opencodeCheapModel;
  OPENCODE_TEXT_BEST_MODEL = fresh.opencodeTextBestModel;
  OPENCODE_TEXT_ADEQUATE_MODEL = fresh.opencodeTextAdequateModel;
  OPENCODE_TEXT_CHEAP_MODEL = fresh.opencodeTextCheapModel;
  OPENROUTER_BEST_MODEL = fresh.openrouterBestModel;
  OPENROUTER_ADEQUATE_MODEL = fresh.openrouterAdequateModel;
  OPENROUTER_CHEAP_MODEL = fresh.openrouterCheapModel;
  CLAUDE_CHEAP_MODEL = fresh.claudeCheapModel;
  CODEX_CHEAP_MODEL = fresh.codexCheapModel;
  TOOL_USE_PROVIDER_FALLBACK_ORDER = fresh.toolUseProviderFallbackOrder;
  TEXT_ONLY_PROVIDER_FALLBACK_ORDER = fresh.textOnlyProviderFallbackOrder;
  PROVIDER_RATE_LIMIT_COOLDOWN_MS = fresh.providerRateLimitCooldownMs;
  OLLAMA_BASE_URL = fresh.ollamaBaseUrl;
  WHISPER_BASE_URL = fresh.whisperBaseUrl;
  OLLAMA_TIMEOUT_MS = fresh.ollamaTimeoutMs;
  OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE = fresh.ollamaConsecutiveFailuresBeforeDisable;
  NOTIFY_DASHBOARD_ACTIONS = fresh.notifyDashboardActions;
  REVIEW_MODEL_TIER = fresh.reviewModelTier;
  DEPENDABOT_AUTO_DISMISS_STALE = fresh.dependabotAutoDismissStale;
  K3S_MONITOR_ENABLED = fresh.k3sMonitorEnabled;
  K3S_IGNORED_NODES = fresh.k3sIgnoredNodes;
  FLEET_INFRA_REPO = fresh.fleetInfraRepo;
  PROD_K8S_MONITOR_ENABLED = fresh.prodK8sMonitorEnabled;
  PROD_K8S_KUBECONFIG_PATH = fresh.prodK8sKubeconfigPath;
  FLEET_KUBECONFIG_PATH = fresh.fleetKubeconfigPath;
  PROD_K8S_KUBECONFIG_REFRESH = fresh.prodK8sKubeconfigRefresh;
  PROD_K8S_IGNORED_NODES = fresh.prodK8sIgnoredNodes;
  PROD_K8S_REPO = fresh.prodK8sRepo;
  CI_FIXER_CIRCUIT_BREAKER = fresh.ciFixerCircuitBreaker;
  DISABLED_JOBS_BY_REPO = fresh.disabledJobsByRepo;
  DEPENDABOT_IGNORED_ADVISORIES = fresh.dependabotIgnoredAdvisories;
  ENABLED_JOBS_BY_REPO = fresh.enabledJobsByRepo;
  HOME_ASSISTANT_BASE_URL = fresh.homeAssistantBaseUrl;
  HOME_ASSISTANT_TOKEN = fresh.homeAssistantToken;
  HOME_ASSISTANT_CONFIG_REPO = fresh.homeAssistantConfigRepo;
  HOME_ASSISTANT_UPGRADER_ENABLED = fresh.homeAssistantUpgraderEnabled;
  HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS = fresh.homeAssistantUpgraderExcludePatterns;
  HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED = fresh.homeAssistantDeployWatcherEnabled;
  HOME_ASSISTANT_GIT_PULL_ADDON_SLUG = fresh.homeAssistantGitPullAddonSlug;
  HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED = fresh.homeAssistantBinDayMonitorEnabled;
  HOME_ASSISTANT_BIN_DAY_SENSOR_PREFIX = fresh.homeAssistantBinDaySensorPrefix;
  HOME_ASSISTANT_BATTERY_MONITOR_ENABLED = fresh.homeAssistantBatteryMonitorEnabled;
  HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT = fresh.homeAssistantBatteryThresholdPercent;
  // Only overwrite ACTIVATION_STATE when the value is explicit (env var or
  // config file). Without this guard, re-deriving from dbExists after initDb()
  // creates the DB would silently flip verify-only → active on any reload.
  if (fresh.activationStateIsExplicit) {
    // verify-only → active requires restart to register jobs; don't flip in-process
    if (fresh.activationState === "verify-only" || ACTIVATION_STATE === "active") {
      ACTIVATION_STATE = fresh.activationState;
    }
  }
  notifyListeners();
}

// ReadonlySet provides compile-time immutability; Object.freeze on a Set does not
// prevent .add()/.delete() at runtime (they operate on internal slots, not own properties).
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set(["slackWebhook", "slackBotToken", "openaiApiKey", "emailAppPassword", "nameyDbUrl", "openrouterApiKey", "oidcClientSecret", "githubAppPrivateKeyPath", "githubOwnerAppCredentials", "homeAssistantToken"]);

function maskValue(value: unknown): string {
  if (!value) return "Not configured";
  if (typeof value === "object") {
    return Object.keys(value as object).length === 0 ? "Not configured" : "****";
  }
  const s = value as string;
  if (s.length <= 4) return "****";
  return "****" + s.slice(-4);
}

export function getConfigForDisplay(): Record<string, unknown> {
  const raw = loadConfig();
  const display: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (SENSITIVE_KEYS.has(key)) {
      display[key] = maskValue(value);
    } else {
      display[key] = value;
    }
  }

  return display;
}

/** Keys whose values are deep-merged (spread into existing) rather than replaced wholesale by writeConfig. */
export const DEEP_MERGED_KEYS: ReadonlySet<string> = new Set(["intervals", "schedules"]);

export function writeConfig(updates: Partial<ConfigFile>): void {
  let existing: ConfigFile = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const p = ConfigFileSchema.safeParse(parsed);
    if (p.success) {
      const merged: Record<string, unknown> = { ...parsed };
      for (const [k, v] of Object.entries(p.data as Record<string, unknown>)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof merged[k] === "object") {
          merged[k] = { ...(merged[k] as object), ...(v as object) };
        } else {
          merged[k] = v;
        }
      }
      existing = merged as ConfigFile;
    } else {
      existing = parsed as ConfigFile;
    }
  } catch {
    // Start from empty if missing or invalid
  }

  // Deep-merge, skipping empty secret fields to avoid clearing masked values
  for (const [key, value] of Object.entries(updates)) {
    if (SENSITIVE_KEYS.has(key) && value === "") continue;

    if (DEEP_MERGED_KEYS.has(key) && typeof value === "object" && value !== null) {
      (existing as Record<string, unknown>)[key] = { ...(existing as Record<string, Record<string, unknown>>)[key], ...(value as Record<string, unknown>) };
    } else {
      (existing as Record<string, unknown>)[key] = value;
    }
  }

  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to write config to ${CONFIG_PATH}: ${message}`);
  }
  reloadConfig();
}

export function removeConfigKeys(keysToRemove: string[]): void {
  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const keysToRemoveSet = new Set(keysToRemove);
  const cleaned = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !keysToRemoveSet.has(key))
  );

  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cleaned, null, 2) + "\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to write config to ${CONFIG_PATH}: ${message}`);
  }
  reloadConfig();
}
