import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

// Runtime API tests never open a local pseudo-terminal.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

// The claude_accounts table behind the db mock; reset per test where it matters.
const claudeAccountsTable = vi.hoisted(() => ({
  rows: [{ id: "primary", label: "primary", token: null as string | null, position: 0 }],
}));
const workBackendState = vi.hoisted(() => ({ backend: "in-process" as "in-process" | "k8s-pod" }));
const agentPodLauncherMock = vi.hoisted(() => ({ cancelAll: vi.fn(async () => 0), cancelByRunId: vi.fn(() => false) }));
vi.mock("./agent-pod-launcher.js", () => ({ getAgentPodLauncher: () => agentPodLauncherMock }));

const forgejoWebhookState = vi.hoisted(() => ({ secret: "" }));

vi.mock("./config.js", () => ({
  get FORGEJO_WEBHOOK_SECRET() { return forgejoWebhookState.secret; },
  get WORK_BACKEND() { return workBackendState.backend; },
  SERVER_PORT: 0,
  // The repo page reads its worktrees under here; a missing directory is none.
  WORK_DIR: "/nonexistent/claws-server-test",
  BIND_HOST: "127.0.0.1",
  ACTIVATION_STATE: "active",
  isActive: () => true,
  WHATSAPP_ENABLED: false,
  INTERNAL_MCP_TOKEN: "test-internal-mcp-token",
  DASHBOARD_URL: "https://claws.example",
  LABELS: {
    priority: "Priority",
    blocked: "Blocked",
    backlog: "Backlog",
    problematic: "Claws Problematic",
    duplicate: "Duplicate",
  },
  LABEL_SPECS: {
    "Priority":             { color: "006b75", description: "High-priority — processed first in all Claws queues" },
    "Backlog":              { color: "c5def5", description: "Parked for later" },
    "Use Codex":            { color: "0969da", description: "Use Codex for this issue or pull request, overriding weighted provider selection" },
  },
  VALID_AGENT_NAMES: ["planner", "implementer", "ci-fixer", "review-addresser", "reviewer", "merger"],
  ALLOWED_ACTORS: ["stjohnb"],
  webUrlForRepo: (fullName: string) => `https://github.com/${fullName}`,
  issueUrl: (fullName: string, n: number) => `https://github.com/${fullName}/issues/${n}`,
  forgeIssueUrl: (fullName: string, n: number) => `https://github.com/${fullName}/issues/${n}`,
  prUrl: (fullName: string, n: number) => `https://github.com/${fullName}/pull/${n}`,
  isClawsIssueId: (ref: unknown) => typeof ref === "string" && /^clw_[0-9A-Za-z]{26}$/.test(ref),
  shortIssueRef: (ref: unknown) =>
    typeof ref === "string" && /^clw_[0-9A-Za-z]{26}$/.test(ref)
      ? `clw_${ref.slice(-6).toUpperCase()}`
      : String(ref ?? ""),
  DISABLED_AGENTS: [] as string[],
  CODEX_DEFAULT_MODEL: "gpt-5.5",
  CODEX_LIGHT_MODEL: "gpt-5.6-terra",
  CODEX_CHEAP_MODEL: "gpt-5.6-luna",
  OPENCODE_BEST_MODEL: "anthropic/claude-opus-5-5",
  OPENCODE_ADEQUATE_MODEL: "anthropic/claude-sonnet-5-5",
  OPENCODE_CHEAP_MODEL: "anthropic/claude-haiku-5-5",
  CLAUDE_CHEAP_MODEL: "claude-haiku-4-5-20251001",
  CLAUDE_FABLE_MODEL: "fable",
  CODEX_FABLE_MODEL: "gpt-5.5",
  OPENCODE_FABLE_MODEL: "anthropic/claude-fable-5-1",
  IMPROVEMENT_IDENTIFIER_MODEL: "anthropic/claude-sonnet-5-5",
  PI_BEST_MODEL: "anthropic/claude-opus-5-5",
  PI_ADEQUATE_MODEL: "anthropic/claude-sonnet-5-5",
  PI_CHEAP_MODEL: "anthropic/claude-haiku-4-5",
  PI_FABLE_MODEL: "anthropic/claude-opus-5-5",
  loadConfig: vi.fn().mockReturnValue({
    slackWebhook: "https://hooks.slack.com/abcdef",
    selfRepo: "owner1/repo1",
    openaiApiKey: "",
    port: 3000,
    intervals: { issueWorkerMs: 300000, issueRefinerMs: 300000, ciFixerMs: 600000, reviewAddresserMs: 300000, bugInvestigatorMs: 600000, autoMergerMs: 600000 },
    schedules: { repoStandardsHour: 2 },
    logRetentionDays: 14,
    logRetentionPerJob: 20,
    whatsappEnabled: false,
    whatsappAllowedNumbers: [],
    disabledAgents: [],
  }),
  getConfigForDisplay: vi.fn().mockReturnValue({
    slackWebhook: "****cdef",
    selfRepo: "owner1/repo1",
    openaiApiKey: "Not configured",
    port: 3000,
    intervals: { issueWorkerMs: 300000, issueRefinerMs: 300000, ciFixerMs: 600000, reviewAddresserMs: 300000, bugInvestigatorMs: 600000, autoMergerMs: 600000 },
    schedules: { repoStandardsHour: 2 },
    logRetentionDays: 14,
    logRetentionPerJob: 20,
    whatsappEnabled: false,
    whatsappAllowedNumbers: [],
    disabledAgents: [],
  }),
  writeConfig: vi.fn(),
  getUnknownConfigKeys: vi.fn().mockReturnValue([]),
  removeConfigKeys: vi.fn(),
  MAC_RUNNERS: [
    { name: "Brendans-MacBook-Pro", host: "brendans-macbook-pro.local", labels: ["macos", "tempo"] },
    { name: "Brendans-MacBook-Pro-3", host: "brendans-macbook-pro-3.local", user: "brendanstjohn", labels: ["macos", "xcode26"] },
  ],
  SKIPPED_ITEMS: [],
  PRIORITIZED_ITEMS: [],
  EMAIL_ENABLED: false,
  SENSITIVE_KEYS: new Set(["slackWebhook", "slackBotToken", "openaiApiKey", "emailAppPassword"]),
  DEEP_MERGED_KEYS: new Set(["intervals", "schedules"]),
  OPENROUTER_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  AI_PROVIDER_NAMES: ["claude", "codex", "opencode", "pi"],
  DEFAULT_AI_PROVIDERS: {
    claude: { enabled: true, weight: 4 },
    codex: { enabled: true, weight: 2 },
    opencode: { enabled: true, weight: 0 },
    pi: { enabled: true, weight: 0 },
  },
  AI_PROVIDERS: {
    claude: { enabled: true, weight: 4 },
    codex: { enabled: true, weight: 2 },
    opencode: { enabled: true, weight: 0 },
    pi: { enabled: true, weight: 0 },
  },
  CLAWS_ROLE: "all",
  CLAWS_CONTROLLER_URL: "",
  OIDC_CLIENT_ID: "",
  OIDC_CLIENT_SECRET: "",
  OIDC_BASE_URL: "",
  OIDC_APPLICATION_SLUG: "",
  OIDC_REDIRECT_URI: "",
  OIDC_HOST_MAP: {},
  DISABLED_JOBS_BY_REPO: {},
  isJobDisabledForRepo: vi.fn(() => false),
  getRepoJobExclusions: vi.fn(() => [{ repo: "org/repo", job: "doc-maintainer", hostDisabled: true, repositoryDisabled: false }]),
  getLockedJobsForRepo: vi.fn((): readonly string[] => []),
  getMacRunnerRepos: vi.fn((): readonly string[] => []),
  isRepoDeclaredMacRunner: vi.fn(() => false),
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  FLEET_INFRA_REPO: "St-John-Software/fleet-infra",
  PROD_GRAFANA_URL: "",
  FLEET_GRAFANA_URL: "",
  GRAFANA_JWT_SIGNING_KEY: "",
  FORGEJO_TOKEN: "",
  FORGEJO_ADMIN_TOKEN: "",
  FORGEJO_READ_TOKEN: "",
  FORGEJO_BASE_URL: "https://git.example.test",
  isAgentDisabled: vi.fn(() => false),
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./version.js", () => ({
  VERSION: "1.2.3-test",
}));

vi.mock("./pi-auth.js", () => ({
  piCredentialSources: vi.fn().mockReturnValue([]),
  piCredentialStatuses: vi.fn().mockResolvedValue([
    { provider: "anthropic", label: "Anthropic account", source: "Claude token (CLAUDE_CODE_OAUTH_TOKEN)", status: "ready", reason: null },
  ]),
}));

vi.mock("./claude.js", () => ({
  cancelCurrentTask: vi.fn().mockReturnValue(true),
  cancelTaskByRunId: vi.fn().mockReturnValue(false),
  isProviderRateLimited: vi.fn().mockReturnValue(false),
  getProviderRateLimitedUntil: vi.fn().mockReturnValue(null),
  clearProviderRateLimitState: vi.fn().mockReturnValue(false),
  getProviderLastUsedAt: vi.fn().mockReturnValue(null),
  getModelTierRateLimitedUntil: vi.fn().mockReturnValue(null),
  isOpenCodeBinaryAvailable: vi.fn().mockReturnValue(false),
  isPiBinaryAvailable: vi.fn().mockReturnValue(false),
}));

// The controller reads holds from provider-holds.ts; delegate to the claude.js
// mocks above so a test drives both through one set of fns.
vi.mock("./provider-holds.js", async () => {
  const claude = await import("./claude.js") as unknown as Record<string, (...args: unknown[]) => unknown>;
  // Tolerates a mockReset() fn answering undefined.
  const until = (p: string): number | null => {
    const t = claude.getProviderRateLimitedUntil!(p);
    if (typeof t === "number" && t > Date.now()) return t;
    return claude.isProviderRateLimited!(p) === true ? Date.now() + 60_000 : null;
  };
  return {
    // The real refresh also reloads the Claude accounts; so does this one.
    refreshProviderHolds: vi.fn(async () => { await (await import("./claude-accounts.js")).refreshClaudeAccounts(); }),
    providerHoldsStale: vi.fn(() => true),
    accountKey: (id: string) => `claude@${id}`,
    authExpiredKey: (id: string) => `auth-expired:claude@${id}`,
    claudeProviderHeldUntil: vi.fn(() => until("claude")),
    getProviderRateLimitedUntil: vi.fn((p: string) => until(p)),
    clearProviderRateLimitState: vi.fn((...args: unknown[]) => claude.clearProviderRateLimitState!(...args)),
    clearProviderRateLimitStateShared: vi.fn(async (...args: unknown[]) => claude.clearProviderRateLimitState!(...args)),
    getModelTierRateLimitedUntil: vi.fn((...args: unknown[]) => claude.getModelTierRateLimitedUntil!(...args) ?? null),
    getProviderLastUsedAt: vi.fn((...args: unknown[]) => claude.getProviderLastUsedAt!(...args) ?? null),
    getAccountRateLimitedUntil: vi.fn(() => null),
    getAccountLastUsedAt: vi.fn(() => null),
    // No account free: sessions fall back to the round-robin pick.
    pickClaudeAccount: vi.fn(() => null),
    isAccountAuthExpired: vi.fn(() => false),
    markAccountAuthExpired: vi.fn(),
    clearAccountAuthExpired: vi.fn(),
  };
});

vi.mock("./worker.js", async () => {
  const actual = await vi.importActual<typeof import("./worker.js")>("./worker.js");
  return {
    AGENT_KINDS: actual.AGENT_KINDS,
    workerStatus: vi.fn().mockReturnValue({ workers: 4, running: 1, queued: 2 }),
    enqueue: vi.fn(async () => ({ alreadyQueued: false })),
  };
});

vi.mock("./slack.js", () => ({
  notify: vi.fn(),
  slackStatus: vi.fn().mockReturnValue({ configured: true, lastResult: "ok" }),
  isSlackBotConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock("./whatsapp.js", () => ({
  whatsappStatus: vi.fn().mockReturnValue({ configured: false, connected: false }),
  unpair: vi.fn().mockResolvedValue(undefined),
  isPairing: vi.fn().mockReturnValue(false),
  startPairing: vi.fn().mockImplementation((listener: (event: { type: string }) => void) => {
    // Simulate immediate successful connection
    listener({ type: "connected" });
    return Promise.resolve();
  }),
  stopPairing: vi.fn(),
  cancelPairing: vi.fn(),
}));

vi.mock("./jobs/connectivity-verifier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jobs/connectivity-verifier.js")>()),
  runConnectivityVerification: vi.fn().mockResolvedValue({ generatedAt: "2026-01-01T00:00:00Z", checks: [] }),
}));

vi.mock("./jobs/email-monitor.js", () => ({
  getEmailStatus: vi.fn().mockReturnValue({ configured: false, lastCheck: null, lastError: null }),
}));

vi.mock("./forgejo-job-logs.js", () => ({
  ForgejoJobLogsError: class ForgejoJobLogsError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  },
  fetchForgejoJobLogs: vi.fn(),
}));

vi.mock("./github.js", async () => ({
  // The issue page badges Claws' own comments; use the real predicate.
  isClawsComment: (await import("./marker-text.js")).isClawsComment,
  // /prs classifies dependency PRs through dependency-prs.ts, which needs this.
  normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
  ciFixerGaveUpOnHead: vi.fn().mockReturnValue(false),
  getMergeBlockCode: vi.fn().mockReturnValue(undefined),
  getQueueSnapshot: vi.fn().mockReturnValue({ items: [], oldestFetchAt: null }),
  enrichQueueItemsWithPRStatus: vi.fn().mockResolvedValue(undefined),
  mergePR: vi.fn().mockResolvedValue(undefined),
  removeQueueItem: vi.fn(),
  listRepos: vi.fn().mockResolvedValue([
    { owner: "org", name: "repo", fullName: "org/repo" },
    { owner: "test", name: "repo", fullName: "test/repo" },
  ]),
  listOpenIssues: vi.fn().mockResolvedValue([]),
  listPRs: vi.fn().mockResolvedValue([]),
  listPRStatuses: vi.fn().mockResolvedValue(new Map()),
  getPRReviewStatus: vi.fn().mockResolvedValue({ status: "none", issueCount: 0 }),
  getMergeBlockReason: vi.fn().mockReturnValue(undefined),
  isItemPrioritized: vi.fn().mockReturnValue(false),
  isItemSkipped: vi.fn().mockReturnValue(false),
  listIssuesByLabel: vi.fn().mockResolvedValue([]),
  addLabel: vi.fn().mockResolvedValue(undefined),
  removeLabel: vi.fn().mockResolvedValue(true),
  editIssue: vi.fn().mockResolvedValue(undefined),
  editIssueTitle: vi.fn().mockResolvedValue(undefined),
  closeIssue: vi.fn().mockResolvedValue(undefined),
  getIssueState: vi.fn().mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] }),
  getIssueComments: vi.fn().mockResolvedValue([]),
  listOpenPRsForIssue: vi.fn().mockResolvedValue([]),
  getPRBody: vi.fn().mockResolvedValue(""),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  listMergedPRsForIssue: vi.fn().mockResolvedValue([]),
  ensureLabel: vi.fn().mockResolvedValue(undefined),
  ALL_QUEUE_CATEGORIES: ["ready", "needs-refinement", "refined", "needs-review-addressing", "auto-mergeable", "needs-triage", "problematic", "ci-failing", "needs-review"],
  listRepoDirectory: vi.fn().mockResolvedValue([]),
  fetchRepoFileWithSha: vi.fn().mockResolvedValue(null),
  fetchRepoFileContent: vi.fn().mockResolvedValue(null),
  fetchRepoFileBytes: vi.fn().mockResolvedValue(null),
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
  createBranchRef: vi.fn().mockResolvedValue(undefined),
  putRepoFile: vi.fn().mockResolvedValue(undefined),
  createPR: vi.fn().mockResolvedValue(1),
  getPRState: vi.fn().mockResolvedValue(null),
  getPRChangedFiles: vi.fn().mockResolvedValue([]),
  getPRHeadSHA: vi.fn().mockResolvedValue("abc1234def"),
  infraPathsIn: vi.fn((files: string[]) => files.filter((p) => /(?:^|\/)(?:tofu|terraform)\//.test(p) || /\.tf$/.test(p))),
  awaitingImportReason: vi.fn((_repo: string, _item: unknown): string | null => null),
  // Mirrors issue-id.ts's `ISSUE_ID_RE`: `clw_` + 26 Crockford base32 chars.
  isNativeIssue: vi.fn((ref: unknown) => typeof ref === "string" && /^[cC][lL][wW]_[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/.test(ref.trim())),
  isDependencyBotAuthor: (issue: { author: { login: string } }) => ["renovate", "renovate[bot]", "app/renovate", "dependabot[bot]", "app/dependabot"].includes(issue.author.login),
  hasPriorityLabel: vi.fn((labels: { name: string }[]) => labels.some((l) => l.name === "Priority")),
  getPRMergeGate: vi.fn().mockResolvedValue({ state: "OPEN", headSha: "abc1234def", labels: [], mergeable: "MERGEABLE", checkStatus: "failing", checksTotal: 1, checksHeld: 0 }),
  findLatestFailedRun: vi.fn().mockResolvedValue(42),
  isRunOnCommit: vi.fn().mockResolvedValue(true),
  rerunFailedJobsForSession: vi.fn().mockResolvedValue({ run: 42, jobs: ["build", "test"] }),
  postOperatorComment: vi.fn().mockResolvedValue("4047"),
}));

// Real implementation by default; wrapped in vi.fn so individual tests can
// override it to reject, e.g. to exercise /queue/merge's post-merge try/catch.
vi.mock("./agents/auto-merger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agents/auto-merger.js")>();
  return { ...actual, finalizeMergedClawsPR: vi.fn(actual.finalizeMergedClawsPR), attemptMerge: vi.fn(actual.attemptMerge) };
});

// The Claws-native issue store behind /issues/new, /issues/:id and its
// mutation routes (#3215).
const mockClawsIssues = vi.hoisted(() => ({
  CLAWS_NATIVE_LOGIN: "claws",
  primaryRepo: (issue: { repos: readonly string[] }) => [...issue.repos].sort()[0] ?? "",
  listUnassignedOpenIssues: vi.fn(async () => [] as any[]),
  listOpenIssuesNaming: vi.fn(async () => [] as any[]),
  listClosedIssuesSince: vi.fn(async (_repo: string, _since: Date, _limit: number) => [] as any[]),
  getIssue: vi.fn(async (_ref: string) => undefined as any),
  getIssueBodyHtml: vi.fn(async (_ref: string) => ""),
  listCommentDetails: vi.fn(async (_ref: string) => [] as any[]),
  listHistory: vi.fn(async (_ref: string) => [] as any[]),
  listPlans: vi.fn(async (_ref: string) => [] as any[]),
  getLatestPlansForOpenIssues: vi.fn(async () => new Map<string, any>()),
  duplicateOfForIssues: vi.fn(async (_ids: readonly string[]) => new Map<string, string>()),
  listRequirements: vi.fn(async (_ref: string) => [] as any[]),
  createIssue: vi.fn(async (_input: any) => "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"),
  findOpenIssueByDedupeKey: vi.fn(async (_primary: string, _key: string) => undefined as any),
  findOpenUnkeyedIssueByFiledTitle: vi.fn(async (_primary: string, _title: string) => undefined as any),
  setClawsIssueDedupeKey: vi.fn(async (_ref: string, _key: string) => true),
  closeIssue: vi.fn(async (_repo: string, _ref: string, _reason?: string) => {}),
  listOpenIssuesTouching: vi.fn(async (_repos: readonly string[]) => [] as any[]),
  commentOnIssue: vi.fn(async (_repo: string, _ref: string, _body: string, _login: string): Promise<string | null> => "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC"),
  dashboardIssueUrl: (ref: string) => `https://claws.example/issues/${ref}`,
  dashboardSessionUrl: (id: string) => `https://claws.example/sessions/${id}`,
  reopenIssue: vi.fn(async (_ref: string) => {}),
  setLifecycle: vi.fn(async (_repo: string, _ref: string, _lifecycle: string) => {}),
  blockIssue: vi.fn(async (_repo: string, _ref: string, _reason: string) => {}),
  setRepos: vi.fn(async (_ref: string, _repos: readonly string[]) => {}),
  toIso: (stored: string) => stored,
  editIssue: vi.fn(async (_ref: string, _body: string) => {}),
  getOpenShadowStages: vi.fn(async () => new Map<string, { id: string; lifecycle: string }>()),
  getLatestRequirementsForOpenIssues: vi.fn(async () => new Map<string, any>()),
  getRequirementsFeedbackPending: vi.fn(async (_latest: Map<string, any>) => new Set<string>()),
  isAwaitingRequirementsReview: vi.fn(async (_ref: unknown) => false),
  hasRequirementsFeedback: async (comments: Array<{ login: string; createdAt: string }>, latestCreatedAt: string) =>
    comments.some((c) => c.login !== "claws" && Date.parse(c.createdAt) >= Date.parse(latestCreatedAt)),
  shouldAutoPromote: vi.fn((_issue: unknown) => false),
  autoPromoteDecision: vi.fn((_issue: unknown, _kind?: unknown) => ({ promotes: false, reason: "default" as const })),
  requirementsStageApplies: vi.fn((_issue: unknown) => true),
  entryLifecycle: (issue: { requirements_approved_at: string | null }, hasPlan: boolean) =>
    hasPlan || issue.requirements_approved_at != null ? "planning" : "ideas",
  releaseLifecycle: (issue: { requirements_approved_at: string | null }, hasPlan: boolean, isBlockedVerdict: boolean) => {
    const replan = hasPlan && isBlockedVerdict;
    if (hasPlan && !replan) return { lifecycle: "awaiting-plan-review", replan: false };
    return { lifecycle: hasPlan || issue.requirements_approved_at != null ? "planning" : "ideas", replan };
  },
  promoteIssue: vi.fn(async (..._a: unknown[]) => true),
  demoteIssue: vi.fn(async (_ref: string) => {}),
  setShadowLifecycle: vi.fn(async (_ref: string, _lifecycle: string) => {}),
  IssueCommentDeleteError: class IssueCommentDeleteError extends Error {
    constructor(readonly reason: "not-found" | "refused", message: string) { super(message); }
  },
  deleteIssueComments: vi.fn(async (_ref: string, _ids: readonly string[], _by: string) => 1),
  storeSessionRequirements: vi.fn(async (_ref: string, _record: unknown) => 2),
}));
vi.mock("./claws-issues.js", () => mockClawsIssues);

// reapproval.test.ts covers the approval itself; these pin only the routing.
const mockReapproval = vi.hoisted(() => ({
  hasPendingReapproval: vi.fn(async (_id: string) => false),
  promoteReapproval: vi.fn(async (_id: string, _by: string) => true),
}));
vi.mock("./reapproval.js", () => mockReapproval);

// The approval writer (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F); issue-approval-write.test.ts
// covers the write itself, so these pin only what each route asks it for.
const mockIssueApproval = vi.hoisted(() => ({
  applyIssueApproval: vi.fn(async (_repo: string, _ref: unknown, through: string, _by: string, _opts?: any): Promise<any> =>
    ({ ok: true, trackerId: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", before: "none", after: through, changed: true, openPrs: 0 })),
  readIssueApproval: vi.fn(async (_repo: string, _ref: unknown): Promise<any> => ({ trackerId: null, approvedThrough: "none", by: null, at: null })),
}));
vi.mock("./issue-approval-write.js", async (importOriginal) => ({ ...await importOriginal<typeof import("./issue-approval-write.js")>(), ...mockIssueApproval }));

// operator-attention.test.ts covers the counting; the nav renders no counts
// here unless a test sets them, so its reads never touch the route mocks.
const mockLoadOperatorAttentionCounts = vi.hoisted(() => vi.fn(async (): Promise<{ issues?: { attention: number; total: number }; prs?: { attention: number; total: number }; sessions?: number } | undefined> => undefined));
vi.mock("./operator-attention.js", async (importOriginal) => ({ ...await importOriginal<typeof import("./operator-attention.js")>(), loadOperatorAttentionCounts: mockLoadOperatorAttentionCounts }));

// queued-issues.test.ts covers which Blocked issues are Queued; none by default.
const mockIssuesQueued = vi.hoisted(() => vi.fn(async (_ids: readonly string[]) => new Map<string, string>()));
vi.mock("./queued-issues.js", () => ({ issuesQueued: mockIssuesQueued }));

// A forge issue's Ideas/Planning stage lives on its shadow; none by default.
const mockResolveTrackerId = vi.hoisted(() => vi.fn(async (_repo: string, _ref: unknown, _create?: unknown): Promise<string | null> => null));
vi.mock("./planned-prs.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./planned-prs.js")>(),
  resolveTrackerId: mockResolveTrackerId,
}));

// Issue links (docs/issue-tracker.md#links): the writes and reads are mocked,
// the kind parsing, labels and error class are the real ones.
const mockIssueLinks = vi.hoisted(() => ({
  listLinks: vi.fn(async (_repo: string, _ref: string) => [] as any[]),
  addLink: vi.fn(async (..._args: unknown[]) => ({ link: { id: "cll_1" }, created: true, parked: false }) as any),
  removeLink: vi.fn(async (..._args: unknown[]) => {}),
  resolveLinkTarget: vi.fn(async (raw: string, _repo: string) => raw),
}));
vi.mock("./issue-links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./issue-links.js")>();
  return { ...actual, ...mockIssueLinks };
});

// An issue's flight — its running implementer and open `claws_prs` rows — which
// the board's derived columns and every move read. Not in flight by default;
// `flightKey` is the real one, so the board's lookups key the same way.
const mockIssueFlight = vi.hoisted(() => ({
  loadIssueFlight: vi.fn(async (_repo: string, _ref: unknown) => ({ implementing: false, openPrs: [] as any[] })),
  loadBoardFlights: vi.fn(async (_cards: unknown[]) => new Map<string, any>()),
}));
vi.mock("./issue-flight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./issue-flight.js")>();
  return { ...actual, ...mockIssueFlight };
});

/** An open `claws_prs` row, for an issue's flight. */
function openPrRow(overrides: Record<string, unknown> = {}) {
  return {
    repo: "org/repo", prNumber: 7, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, createdAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-24T10:00:00Z",
    ...overrides,
  };
}

/**
 * Give every forge issue one tracked shadow holding `patch` — Planning,
 * approved through Requirements by default — so the approval track the
 * `/queue/*` approval routes check offers its gates; undo with
 * {@link untrackForgeIssues}.
 */
const QUEUE_SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHF";
function trackForgeIssues(patch: Record<string, unknown> = {}, { repo = "test/repo", id = QUEUE_SHADOW } = {}): void {
  mockResolveTrackerId.mockResolvedValue(id);
  mockClawsIssues.getIssue.mockImplementation(async (ref: string) => (ref === id
    ? { id, kind: "shadow", state: "open", repos: [repo], labels: [], lifecycle: "planning", approved_through: "requirements", requirements_approved_at: "2026-09-21 09:00:00", ...patch }
    : undefined));
}
function untrackForgeIssues(): void {
  mockResolveTrackerId.mockReset().mockResolvedValue(null);
  mockClawsIssues.getIssue.mockReset().mockResolvedValue(undefined);
}

/** Put every issue out of flight again — `clearAllMocks` keeps implementations. */
function resetIssueFlight(): void {
  mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [] });
  mockIssueFlight.loadBoardFlights.mockResolvedValue(new Map());
}

// The native attachment store (#3289): the storage calls are mocked, the pure
// URL and header helpers are the real ones.
const mockIssueAttachments = vi.hoisted(() => ({
  storeIssueAttachment: vi.fn(),
  storeIssueAttachmentStream: vi.fn(),
  readIssueAttachment: vi.fn(async (_id: string) => undefined as any),
  deleteIssueAttachment: vi.fn(async (_id: string) => true),
  claimPendingAttachments: vi.fn(async (_ids: readonly string[], _issueId: string) => [] as any[]),
  sweepPendingAttachments: vi.fn(async () => 0),
}));
vi.mock("./issue-attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./issue-attachments.js")>();
  return { ...actual, ...mockIssueAttachments };
});
const mockSessionFiles = vi.hoisted(() => ({
  storeSessionFile: vi.fn(async (_sid: string, _name: string, _source: unknown): Promise<any> => ({ ok: false, reason: "write-failed" })),
  readSessionFile: vi.fn(async (_id: string) => undefined as any),
}));
vi.mock("./session-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-files.js")>();
  return { ...actual, ...mockSessionFiles };
});

const agentPodOps = vi.hoisted(() => ({
  executeAgentPodOp: vi.fn(),
  agentPodTokenLive: (row: { status: string }) => row.status === "running",
}));
vi.mock("./agent-pod-ops.js", () => agentPodOps);

/** A stand-in for `session_capability_requests`, which `capability-requests.ts` reads and writes directly. */
const mockCapabilityRequestRows = vi.hoisted(() => {
  type Row = {
    session_id: string; capability: string; status: string; reason: string;
    requested_at: number; decided_at: number | null; last_polled_at: number | null; grant_seen_at: number | null;
  };
  const rows = new Map<string, Row>();
  const key = (sessionId: string, capability: string) => `${sessionId}\0${capability}`;
  return {
    rows,
    key,
    getSessionCapabilityRequest: async (sessionId: string, capability: string) => {
      const row = rows.get(key(sessionId, capability));
      return row ? { ...row } : undefined;
    },
    listSessionCapabilityRequests: async (sessionId: string) =>
      [...rows.values()].filter((r) => r.session_id === sessionId).sort((a, b) => a.requested_at - b.requested_at).map((r) => ({ ...r })),
    insertSessionCapabilityRequestIfAbsent: async (row: Row) => {
      if (rows.has(key(row.session_id, row.capability))) return false;
      rows.set(key(row.session_id, row.capability), { ...row });
      return true;
    },
    setSessionCapabilityRequestStatus: async (sessionId: string, capability: string, status: string, decidedAt: number, opts: { onlyIfPending?: boolean } = {}) => {
      const row = rows.get(key(sessionId, capability));
      if (!row || (opts.onlyIfPending && row.status !== "pending")) return false;
      row.status = status;
      row.decided_at = decidedAt;
      return true;
    },
    markSessionCapabilityRequest: async (sessionId: string, capability: string, column: "last_polled_at" | "grant_seen_at", at: number) => {
      const row = rows.get(key(sessionId, capability));
      if (row) row[column] = at;
    },
    deleteSessionCapabilityRequest: async (sessionId: string, capability?: string) => {
      for (const [k, row] of rows) {
        if (row.session_id === sessionId && (capability === undefined || row.capability === capability)) rows.delete(k);
      }
    },
  };
});

// Staged New Session form files: `rows` stands in for the session_attachments table.
const sessionAttachmentsState = vi.hoisted(() => ({
  rows: new Map<string, { id: string; session_id: string | null; filename: string; pod_name: string | null; stored_path: string; storage: "fs"; content_type: string; size: number; created_at: string; bytes: Buffer }>(),
  next: 0,
}));
vi.mock("./session-attachments.js", () => {
  const stage = (name: string, data: Buffer) => {
    if (data.length === 0) return { ok: false as const, reason: "write-failed" as const, detail: "empty file" };
    if (data.length > 10 * 1024 * 1024) return { ok: false as const, reason: "too-large" as const };
    const id = `sat_01M617FXR2G2Q62972WCFY5${String(++sessionAttachmentsState.next).padStart(3, "0")}`;
    const row = { id, session_id: null, filename: name, pod_name: null, stored_path: `session-attachments/pending/${name}`, storage: "fs" as const, content_type: "application/octet-stream", size: data.length, created_at: "2026-10-28 12:00:00", bytes: data };
    sessionAttachmentsState.rows.set(id, row);
    return { ok: true as const, row };
  };
  return {
    isSessionAttachmentId: (id: string) => /^sat_[0-9A-Z]{26}$/.test(id),
    sweepPendingSessionAttachments: vi.fn(async () => 0),
    stageSessionAttachment: vi.fn(async (name: string, data: Buffer) => stage(name, data)),
    stageSessionAttachmentStream: vi.fn(async (name: string, source: AsyncIterable<Uint8Array>) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      return stage(name, Buffer.concat(chunks));
    }),
    findPendingSessionAttachments: vi.fn(async (ids: string[]) => {
      const rows = ids.map((id) => sessionAttachmentsState.rows.get(id));
      return rows.every((r) => r && r.session_id === null) ? rows : null;
    }),
    deleteSessionAttachment: vi.fn(async (id: string) => sessionAttachmentsState.rows.delete(id)),
    openSessionAttachment: vi.fn(async (row: { bytes: Buffer }) => ({ body: new Response(new Uint8Array(row.bytes)).body, size: row.bytes.length })),
  };
});

vi.mock("./db.js", () => ({
  getSessionAttachment: vi.fn(async (id: string) => sessionAttachmentsState.rows.get(id)),
  listClaudeAccounts: vi.fn(async () => claudeAccountsTable.rows.map((r) => ({ ...r }))),
  insertClaudeAccount: vi.fn(async (id: string, label: string) => {
    if (claudeAccountsTable.rows.some((r) => r.id === id)) throw new Error("UNIQUE constraint failed: claude_accounts.id");
    claudeAccountsTable.rows.push({ id, label, token: null, position: claudeAccountsTable.rows.length });
  }),
  updateClaudeAccountLabel: vi.fn(async (id: string, label: string) => {
    const row = claudeAccountsTable.rows.find((r) => r.id === id);
    if (row) row.label = label;
    return !!row;
  }),
  deleteClaudeAccount: vi.fn(async (id: string) => {
    const before = claudeAccountsTable.rows.length;
    claudeAccountsTable.rows = claudeAccountsTable.rows.filter((r) => r.id !== id);
    return claudeAccountsTable.rows.length < before;
  }),
  setClaudeAccountToken: vi.fn(async () => true),
  clearProviderHolds: vi.fn(async () => 0),
  // Agent pod ops API rows: 7 is running under sha256("agent-pod-token"), 8 has finished.
  getWorkRow: vi.fn().mockImplementation(async (id: number) => {
    const hash = crypto.createHash("sha256").update("agent-pod-token").digest("hex");
    if (id === 7) return { id: 7, status: "running", run_id: "run-7", agent_mcp_token_sha256: hash };
    if (id === 8) return { id: 8, status: "completed", run_id: "run-8", agent_mcp_token_sha256: hash };
    return undefined;
  }),
  // sha256("agent-pod-token")
  isRunningAgentPodMcpToken: vi.fn().mockImplementation(async (hash: string) =>
    hash === crypto.createHash("sha256").update("agent-pod-token").digest("hex")),
  getJobRun: vi.fn().mockImplementation((runId: string) => {
    if (runId === "abc-123") {
      return { run_id: "abc-123", job_name: "issue-worker", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    }
    if (runId === "running-456") {
      return { run_id: "running-456", job_name: "ci-fixer", status: "running", started_at: "2025-01-01 00:00:00", completed_at: null };
    }
    return undefined;
  }),
  getJobRunLogs: vi.fn().mockReturnValue([
    { id: 1, run_id: "abc-123", level: "info", message: "Starting", logged_at: "2025-01-01 00:00:00" },
  ]),
  getJobRunLogsSince: vi.fn().mockImplementation((_runId: string, afterId: number) => {
    if (afterId >= 1) return [];
    return [
      { id: 1, run_id: "abc-123", level: "info", message: "Starting", logged_at: "2025-01-01 00:00:00" },
    ];
  }),
  getLatestVerificationReport: vi.fn().mockResolvedValue(null),
  getLatestRunIdsByJob: vi.fn().mockReturnValue(
    new Map([
      ["issue-worker", { runId: "abc-123", status: "completed", startedAt: "2025-01-01 00:00:00", completedAt: "2025-01-01 00:01:00" }],
      ["ci-fixer", { runId: "def-456", status: "failed", startedAt: "2025-01-01 00:00:00", completedAt: "2025-01-01 00:00:30" }],
    ]),
  ),
  getRunningTasks: vi.fn().mockReturnValue([
    { id: 1, job_name: "issue-worker", repo: "org/repo", item_number: 42, trigger_label: "Refined", worktree_path: null, branch_name: null, run_id: null, status: "running", error: null, started_at: "2025-01-01 00:00:00", completed_at: null },
  ]),
  getTasksByRunId: vi.fn().mockReturnValue([]),
  getWorkItemsForRuns: vi.fn().mockReturnValue(new Map()),
  getRunsForIssue: vi.fn().mockReturnValue([]),
  getLogsForRuns: vi.fn().mockReturnValue(new Map()),
  getQueueSnapshots: vi.fn().mockReturnValue([]),
  getLastTaskTimePerRepo: vi.fn().mockReturnValue(new Map()),
  getRecentTasksForRepo: vi.fn().mockReturnValue([]),
  listPRReviews: vi.fn().mockResolvedValue([]),
  getDailyTaskStats: vi.fn().mockReturnValue([]),
  getLastUsedByProvider: vi.fn().mockReturnValue({ claude: null, codex: null, opencode: null }),
  getActiveWorkflowRuns: vi.fn().mockReturnValue([]),
  getRecentWhatsappEvents: vi.fn().mockReturnValue([]),
  getEndedSessions: vi.fn().mockReturnValue([]),
  getPersistedSession: vi.fn().mockReturnValue(undefined),
  countLiveSessionsSpawnedBy: vi.fn().mockResolvedValue(0),
  cancelJobRunIfRunning: vi.fn().mockReturnValue(false),
  listQueuedWork: vi.fn().mockReturnValue([]),
  setWorkPriority: vi.fn(),
  getRecentDampReadings: vi.fn().mockReturnValue([]),
  getDampTrendRows: vi.fn().mockReturnValue([]),
  upsertDampReading: vi.fn(),
  deleteDampReading: vi.fn(),
  getLatestDmarcReportsPerReporter: vi.fn().mockReturnValue([]),
  getDmarcVerdictCounts: vi.fn().mockReturnValue([]),
  getDmarcSourceIps: vi.fn().mockReturnValue([]),
  getRecentDmarcRows: vi.fn().mockReturnValue([]),
  upsertBlogDraft: vi.fn(),
  getBlogDraft: vi.fn().mockReturnValue(undefined),
  listBlogDrafts: vi.fn().mockReturnValue([]),
  insertFrictionNote: vi.fn().mockResolvedValue(1),
  listUntriagedFrictionNotes: vi.fn().mockResolvedValue([]),
  countUntriagedFrictionNotesByRepoAndCategory: vi.fn().mockResolvedValue(new Map()),
  lastFrictionRetrospectiveAt: vi.fn().mockResolvedValue(null),
  listFrictionRetrospectives: vi.fn().mockResolvedValue([]),
  getTasksByIds: vi.fn().mockResolvedValue([]),
  setBlogDraftPushed: vi.fn(),
  clearBlogDraftPR: vi.fn(),
  deleteBlogDraft: vi.fn(),
  resetCIFixerBreakerGrants: vi.fn(),
  recordSessionPrAction: vi.fn(async () => {}),
  getRecentSessionModels: vi.fn().mockReturnValue([]),
  rememberSessionCapabilityDefaults: vi.fn(async () => {}),
  getAllSessionCapabilityDefaults: vi.fn(async () => new Map<string, string[]>()),
  sessionCapabilityDefaultsKey: (repos: string[]) => [...new Set(repos)].sort().join("\n"),
  rememberSessionAgentDefault: vi.fn(async () => {}),
  getSessionAgentDefaults: vi.fn(async () => ({ lastProvider: null as string | null, models: {} as Record<string, string> })),
  getSessionCapabilityRequest: mockCapabilityRequestRows.getSessionCapabilityRequest,
  listSessionCapabilityRequests: mockCapabilityRequestRows.listSessionCapabilityRequests,
  insertSessionCapabilityRequestIfAbsent: mockCapabilityRequestRows.insertSessionCapabilityRequestIfAbsent,
  setSessionCapabilityRequestStatus: mockCapabilityRequestRows.setSessionCapabilityRequestStatus,
  markSessionCapabilityRequest: mockCapabilityRequestRows.markSessionCapabilityRequest,
  deleteSessionCapabilityRequest: mockCapabilityRequestRows.deleteSessionCapabilityRequest,
  pruneSessionCapabilityRequestsForEndedSessions: vi.fn(async () => 0),
  getImportedIssueByNative: vi.fn(async (_nativeId: string) => undefined as any),
  getIssueModelPlanRows: vi.fn(async () => [] as any[]),
  // model-plan.ts reads a native issue's repos to find its primary repo.
  getClawsIssue: vi.fn(async () => undefined),
  clawsIssueExists: vi.fn(async () => false),
  listExplicitIssueModelPlanRows: vi.fn(async () => [] as any[]),
  listLiveBoardStartedSessions: vi.fn(async () => new Map<string, string>()),
  listLivePrStartedSessions: vi.fn(async () => new Map<string, string>()),
  listClawsIssueAttachments: vi.fn(async (_issueId: string) => [] as any[]),
  listSessionFiles: vi.fn(async (_sessionId: string) => [] as any[]),
  upsertIssueModelPlanCell: vi.fn(async () => true),
  deleteIssueModelPlanCell: vi.fn(async () => {}),
  listOpenClawsIssues: vi.fn(async (_filter?: { repo?: string; unassigned?: boolean; label?: string }) => [] as any[]),
  listClawsIssues: vi.fn(async (_filter?: any) => [] as any[]),
  listIssueIdsWithPlans: vi.fn(async (_ids: readonly string[]) => new Set<string>()),
  getClawsPr: vi.fn(async (_repo: string, _prNumber: number) => null as any),
  getLinkedNativeId: vi.fn(async () => undefined),
  listClawsPrs: vi.fn(async (_repo: string) => [] as any[]),
  listClawsPrsForIssue: vi.fn(async (_issueId: string) => [] as any[]),
  getIssuePlannedPRs: vi.fn(async (_issueId: string) => [] as any[]),
  getIssueIdsAwaitingOperator: vi.fn(async (_issueIds: readonly string[]) => new Map<string, { position: number; title: string }>()),
  setIssueBlockedReason: vi.fn(),
  getIssueBlockedReasons: vi.fn(async (_issueIds: readonly string[]) => new Map<string, string>()),
  listOpenClawsAlerts: vi.fn(async () => []),
  setClawsIssueBacklogUntil: vi.fn(async () => true),
  getIssueBacklogUntil: vi.fn(async (_issueIds: readonly string[]) => new Map<string, string>()),
  getIssueReapproval: vi.fn(async (_issueId: string): Promise<unknown> => null),
  listPendingReapprovalIssueIds: vi.fn(async (_issueIds?: readonly string[]) => new Set<string>()),
  listRequirementsApprovedIssueIds: vi.fn(async (_issueIds: readonly string[]) => new Set<string>()),
  upsertClawsPr: vi.fn(async (_repo: string, _prNumber: number, _patch: unknown) => {}),
}));

vi.mock("./sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sessions.js")>();
  return { ...actual, getEndedSession: vi.fn(actual.getEndedSession) };
});

/**
 * The default session backend for these tests, standing in for the pod
 * backend (`getK8sSessionBackend`) so no Kubernetes client is ever built.
 * Describe blocks that need other behaviour swap in their own with
 * `setSessionBackendForTests`.
 */
const { mockSessionBackend } = vi.hoisted(() => ({
  mockSessionBackend: {
    kind: "k8s-pod" as const,
    start: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    create: vi.fn(async (_req: Record<string, unknown>) => ({ ok: false as const, reason: "shutting-down" as const })),
    createMulti: vi.fn(async (_req: Record<string, unknown>) => ({ ok: false as const, reason: "shutting-down" as const })),
    resume: vi.fn(async (id: string): Promise<{ ok: true; id: string } | { ok: false; reason: "repo-not-found" | "not-resumable"; detail?: string }> => (
      { ok: false, reason: "repo-not-found", detail: id }
    )),
    end: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
    remove: vi.fn(async () => ({ ok: true as const })),
    listLive: vi.fn(async () => []),
    getLive: vi.fn(async (_id: string): Promise<any> => ({ ok: false, reason: "not-found" })),
    getStartupStatus: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
    checkAttach: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
    attach: vi.fn(),
    saveUpload: vi.fn(async (_id: string, _name: string, _data: Buffer): Promise<any> => ({ ok: false, reason: "not-found" })),
    saveUploadStream: vi.fn(async (): Promise<any> => ({ ok: false, reason: "not-found" })),
    fetchFile: vi.fn(async (): Promise<any> => ({ ok: false, reason: "not-found" })),
    setDescription: vi.fn(async (_id: string, _description: string) => ({ ok: true, description: "my description" as string | null })),
    resummarize: vi.fn(async (_id: string) => ({ ok: true, description: "auto summary" as string | null })),
    setAgentStatus: vi.fn(async (_id: string, status: "working" | "monitoring" | "waiting" | "done") => ({ ok: true, status, updatedAt: 1234 })),
    switchClaudeAccount: vi.fn(async (): Promise<any> => ({ ok: false, reason: "not-found" })),
    grantCapability: vi.fn(async (): Promise<any> => ({ ok: false, reason: "not-found" })),
    grantDelivery: vi.fn(async (): Promise<any> => ({ ok: false, reason: "not-found" })),
    revokeCapability: vi.fn(async (): Promise<any> => ({ ok: false, reason: "not-found" })),
    notifyAgent: vi.fn(async () => "unreachable" as const),
    notifyAgentOnceReady: vi.fn(),
    verifyMcpToken: vi.fn(async () => "denied" as const),
    recordPodExit: vi.fn(async () => "denied" as const),
  },
}));
vi.mock("./session-backend-k8s.js", () => ({ getK8sSessionBackend: () => mockSessionBackend }));

// No key generation, config write or Grafana probe from createServer.
vi.mock("./grafana-jwt.js", () => ({
  GRAFANA_CLUSTERS: ["prod", "fleet"],
  isGrafanaCluster: (v: string) => v === "prod" || v === "fleet",
  ensureSigningKey: vi.fn(async () => {}),
  probeGrafanaAuth: vi.fn(async () => ({ ok: true, durationMs: 0 })),
  grafanaProbeLogContext: vi.fn(() => ({})),
  grafanaProbeFailureMessage: vi.fn(() => "probe failed"),
  jwks: () => ({ keys: [{ kty: "RSA", n: "test-n", e: "AQAB", alg: "RS256", use: "sig", kid: "test-kid" }] }),
  mintGrafanaJwt: vi.fn((cluster: string) => `eyJtest.${cluster}.sig`),
}));

// The token's MAC and session lookup are covered by pages-read-token.test.ts.
vi.mock("./pages-read-token.js", () => ({
  PAGES_READ_COOKIE: "claws_pages_token",
  PAGES_LOGIN_PATH: "/__claws/login",
  pagesHostname: () => "pages.example.test",
  verifyPagesReadToken: vi.fn(async (token: string) => (token === "s1.good" ? "ok" : "invalid")),
}));

vi.mock("./transcribe.js", () => ({
  transcribe: vi.fn(async () => "hello from the voice note"),
  isAvailable: vi.fn(() => true),
  voiceVocabularyPrompt: vi.fn(() => "Kwyjibo, Claws, GitHub"),
}));

import * as log from "./log.js";
import { formatUptime, buildLogDetailPage, buildIssueLogsPage } from "./server.js";
import type { Theme } from "./server.js";
import { createServer, signOAuthState, verifyOAuthState } from "./server.js";
import { CONTROLLER_RESTARTING_BANNER, setPageControllerHeartbeat } from "./pages/layout.js";
import { DERIVED_COLUMN_REJECTION } from "./issue-board.js";
import { currentIssueActor, type IssueActor } from "./issue-history-actor.js";
import { REPO_JOB_NAMES } from "./pages/jobs-matrix.js";
import { getEndedSession } from "./sessions.js";
import { transcribe, isAvailable } from "./transcribe.js";
import { isProviderRateLimited } from "./claude.js";
import { sessionModelsFor } from "./session-models.js";
import type { Scheduler } from "./scheduler.js";
import { liveControllerClient } from "./controller-client.js";

function mockScheduler(): Scheduler {
  const _paused = new Set<string>();
  return {
    stop: vi.fn(),
    drain: vi.fn(),
    jobStates: vi.fn().mockReturnValue(
      new Map([
        ["issue-worker", true],
        ["ci-fixer", false],
      ]),
    ),
    triggerJob: vi.fn().mockReturnValue("started"),
    updateInterval: vi.fn(),
    updateScheduledHour: vi.fn(),
    pauseJob: vi.fn().mockImplementation((name: string) => {
      if (name === "issue-worker" || name === "ci-fixer") {
        _paused.add(name);
        return true;
      }
      return false;
    }),
    resumeJob: vi.fn().mockImplementation((name: string) => {
      if (name === "issue-worker" || name === "ci-fixer") {
        _paused.delete(name);
        return true;
      }
      return false;
    }),
    pausedJobs: vi.fn().mockImplementation(() => new Set(_paused)),
    jobScheduleInfo: vi.fn().mockReturnValue(
      new Map([
        ["issue-worker", { intervalMs: 300000 }],
        ["ci-fixer", { intervalMs: 600000 }],
      ]),
    ),
    manualOnlyJobs: vi.fn().mockReturnValue(new Set<string>()),
  };
}

// Module-level session cookie injected into every request by the helper below.
// The file-level beforeEach arms it with a valid signed session so the many
// suites that predate fail-closed auth keep exercising protected routes under
// OIDC. Auth-specific suites set it to null to opt out.
let testSessionCookie: string | null = null;

// Mirrors signSession in server.ts so tests can mint valid session cookies.
function signSession(sub: string, expiresAt: number, secret: string): string {
  const payload = `${sub}|${expiresAt}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}|${hmac}`;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  options?: { headers?: Record<string, string>; body?: string | Buffer },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const reqHeaders: Record<string, string> = { ...(options?.headers ?? {}) };
    if (options?.body && !reqHeaders["content-type"]) {
      reqHeaders["content-type"] = "application/x-www-form-urlencoded";
    }
    if (testSessionCookie) {
      const existing = reqHeaders["Cookie"] ?? reqHeaders["cookie"];
      reqHeaders["Cookie"] = existing
        ? `${existing}; claws_session=${encodeURIComponent(testSessionCookie)}`
        : `claws_session=${encodeURIComponent(testSessionCookie)}`;
    }
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method, headers: reqHeaders },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}

/** A one-file `multipart/form-data` request under the `file` field, as the dashboard's attach control sends. */
function multipartFile(name: string, content: string): { headers: Record<string, string>; body: string } {
  const boundary = "BOUNDARY";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  };
}

// Fail-closed auth: with OIDC unconfigured every authenticated route is denied,
// so by default we enable OIDC and arm a valid session cookie for all tests.
// Auth-specific suites override this in their own (later-running) beforeEach.
const TEST_OIDC_SECRET = "test-oidc-client-secret";
beforeEach(async () => {
  const configMod = await import("./config.js");
  (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "test-client-id";
  (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = TEST_OIDC_SECRET;
  (configMod as Record<string, unknown>).OIDC_BASE_URL = "https://auth.example.com";
  (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "claws";
  testSessionCookie = signSession("test-user", Date.now() + 24 * 60 * 60 * 1000, TEST_OIDC_SECRET);
});
/** app.onError swallows vitest's missing-mock-export message into a bare 500; resurface it. */
function assertNoMissingMockExport(): void {
  for (const call of vi.mocked(log.error).mock.calls) {
    const msg = String(call[0]);
    if (msg.startsWith("HTTP handler error:") && msg.includes("export is defined on the")) {
      throw new Error(msg);
    }
  }
}

afterEach(async () => {
  assertNoMissingMockExport();
  const configMod = await import("./config.js");
  for (const k of ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_BASE_URL", "OIDC_APPLICATION_SLUG"]) {
    (configMod as Record<string, unknown>)[k] = "";
  }
  testSessionCookie = null;
});

describe("assertNoMissingMockExport", () => {
  it("throws naming the missing config export", () => {
    vi.mocked(log.error).mockClear();
    log.error('HTTP handler error: Error: [vitest] No "FOO" export is defined on the "./config.js" mock. Did you forget to return it from "vi.mock"?');
    expect(() => assertNoMissingMockExport()).toThrow('"FOO"');
    vi.mocked(log.error).mockClear();
  });
});

describe("formatUptime", () => {
  it("returns '0s' for 0 seconds", () => {
    expect(formatUptime(0)).toBe("0s");
  });

  it("formats seconds only", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(90)).toBe("1m 30s");
  });

  it("formats exactly 1 hour", () => {
    expect(formatUptime(3600)).toBe("1h 0s");
  });

  it("formats days, hours, minutes, seconds", () => {
    expect(formatUptime(90061)).toBe("1d 1h 1m 1s");
  });

  it("formats exactly 1 day", () => {
    expect(formatUptime(86400)).toBe("1d 0s");
  });
});

describe("HTTP server", () => {
  let server: http.Server;
  let scheduler: Scheduler;

  beforeEach(async () => {
    scheduler = mockScheduler();
    server = createServer(liveControllerClient(scheduler));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /health returns 200 with status JSON", async () => {
    const res = await request(server, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.2.3-test");
    expect(body.shuttingDown).toBe(false);
  });

  it("GET /api/status returns 200 with job states, slack status, and running tasks", async () => {
    const res = await request(server, "GET", "/api/status");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.jobs).toEqual({ "issue-worker": true, "ci-fixer": false });
    expect(body.claudeQueue).toEqual({ pending: 2, active: 1 });
    expect(typeof body.uptime).toBe("number");
    expect(body.slack).toEqual({ configured: true, lastResult: "ok" });
    expect(body.homeAssistant).toEqual({ configured: false, lastCheck: null, lastError: null });
    expect(body.runningTasks).toEqual([
      { jobName: "issue-worker", repo: "org/repo", itemNumber: 42, itemShort: "42", startedAt: "2025-01-01 00:00:00" },
    ]);
    expect(body.queueEntries).toEqual([]);
    expect(body.queueCategoryCounts).toBeUndefined();
    expect(body.latestRunStatuses).toBeUndefined();
  });

  it("GET /api/status includes a short display form of a native issue id alongside the full itemNumber", async () => {
    const { getRunningTasks } = await import("./db.js");
    vi.mocked(getRunningTasks).mockReturnValueOnce(Promise.resolve([
      { id: 1, job_name: "issue-worker", repo: "org/repo", item_number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", trigger_label: "Refined", worktree_path: null, branch_name: null, run_id: null, status: "running", error: null, started_at: "2025-01-01 00:00:00", completed_at: null } as any,
    ]));
    const res = await request(server, "GET", "/api/status");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.runningTasks).toEqual([
      {
        jobName: "issue-worker",
        repo: "org/repo",
        itemNumber: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC",
        itemShort: "clw_GZ5PDC",
        startedAt: "2025-01-01 00:00:00",
      },
    ]);
  });

  it("GET / redirects to /board", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/board");
  });

  it("GET /status returns 200 with HTML and includes Config link", async () => {
    const res = await request(server, "GET", "/status");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("claws");
    expect(res.body).toContain('href="/jobs"');
    expect(res.body).toContain('href="/config"');
    expect(res.body).not.toContain('id="job-');
    expect(res.body).toContain("Integrations");
    expect(res.body).toContain("Connected");
    expect(res.body).not.toContain('http-equiv="refresh"');
    expect(res.body).toContain("fetch('/api/status')");
  });

  it("POST /health returns 405", async () => {
    const res = await request(server, "POST", "/health");
    expect(res.status).toBe(405);
  });

  it("GET /logs/:runId returns 200 for existing run", async () => {
    const res = await request(server, "GET", "/logs/abc-123");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("issue-worker");
    expect(res.body).toContain("Starting");
  });

  it("GET /logs/:runId returns 404 for nonexistent run", async () => {
    const res = await request(server, "GET", "/logs/nonexistent");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Run not found");
  });

  it("GET /unknown returns 404", async () => {
    const res = await request(server, "GET", "/nonexistent");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Page not found");
  });

  it("GET /api/nope returns 404 with JSON content-type", async () => {
    const res = await request(server, "GET", "/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
  });

  it("POST /nope returns 405", async () => {
    const res = await request(server, "POST", "/nope");
    expect(res.status).toBe(405);
  });

  it("GET /sessions/<hex id> with no matching session returns a themed 404", async () => {
    vi.mocked(getEndedSession).mockResolvedValueOnce(undefined);
    const res = await request(server, "GET", "/sessions/abcdef1234567890abcdef1234567890abcdef12");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Session not found");
    expect(res.body).toContain('href="/sessions"');
    expect(res.body).not.toContain("Revive");
  });

  it("GET /sessions/<hex id> with an ended session in history offers a revive button", async () => {
    vi.mocked(getEndedSession).mockResolvedValueOnce({
      id: "abcdef1234567890abcdef1234567890abcdef12",
      repo: "org/app",
      extraRepos: [],
      cwd: "/w",
      provider: "claude",
      createdAt: 0,
      endedAt: 1735689600000,
      summary: "Fixed the flaky test",
      mode: "worktree-claude",
      exitCode: 2,
      lastOutput: "npm ERR! EACCES <permission denied>",
      failureReason: "pod failed: exit code 2",
      resumable: true,
    });
    const res = await request(server, "GET", "/sessions/abcdef1234567890abcdef1234567890abcdef12");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Session ended");
    expect(res.body).toContain("Revive session");
    expect(res.body).toContain("npm ERR! EACCES &lt;permission denied&gt;");
    expect(res.body).toContain("pod failed: exit code 2");
    expect(res.body).toContain('method="post"');
    expect(res.body).toContain(
      `action="/sessions/abcdef1234567890abcdef1234567890abcdef12/resume"`,
    );
    expect(res.body).toContain("Fixed the flaky test");
  });

  it("GET /sessions/<hex id> for an ended host-tmux session shows its history without Revive", async () => {
    vi.mocked(getEndedSession).mockResolvedValueOnce({
      id: "abcdef1234567890abcdef1234567890abcdef12",
      repo: "org/app",
      extraRepos: [],
      cwd: "/w",
      provider: "claude",
      createdAt: 0,
      endedAt: 1735689600000,
      summary: "Old host work",
      mode: "worktree-claude",
      exitCode: 0,
      lastOutput: "bye",
      failureReason: null,
      resumable: false,
    });
    const res = await request(server, "GET", "/sessions/abcdef1234567890abcdef1234567890abcdef12");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Session ended");
    expect(res.body).toContain("Old host work");
    expect(res.body).toContain("Host sessions can no longer be resumed");
    expect(res.body).not.toContain("Revive session");
    expect(res.body).not.toContain("/resume");
  });

  it("POST /sessions/:id/resume on a host-tmux session answers 409, never 500", async () => {
    const id = "abcdef1234567890abcdef1234567890abcdef12";
    const notResumable = { ok: false as const, reason: "not-resumable" as const, detail: "host tmux sessions can no longer be resumed" };
    mockSessionBackend.resume.mockResolvedValueOnce(notResumable).mockResolvedValueOnce(notResumable);

    const text = await request(server, "POST", `/sessions/${id}/resume`);
    expect(text.status).toBe(409);
    expect(text.headers["content-type"]).toBe("text/plain");
    expect(text.body).toBe("Cannot resume session: Session is not resumable: host tmux sessions can no longer be resumed");

    const html = await request(server, "POST", `/sessions/${id}/resume`, { headers: { Accept: "text/html" } });
    expect(html.status).toBe(409);
    expect(html.headers["content-type"]).toBe("text/html");
    expect(html.body).toContain("host tmux sessions can no longer be resumed");
    expect(html.body).toContain('href="/sessions"');
  });

  it("GET /sessions/:id with a non-hex id returns a themed 404", async () => {
    const res = await request(server, "GET", "/sessions/zzz");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Session not found");
  });

  it("POST /sessions/:id/resume on an unknown id returns text/plain by default", async () => {
    const res = await request(server, "POST", "/sessions/abcdef1234567890abcdef1234567890abcdef12/resume");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.body).toContain("Cannot resume session");
  });

  it("POST /sessions/:id/resume on an unknown id with Accept: text/html returns a themed error page", async () => {
    const res = await request(server, "POST", "/sessions/abcdef1234567890abcdef1234567890abcdef12/resume", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Cannot revive session");
  });

  it("POST /sessions/:id/description with a non-hex id returns a 404 JSON error", async () => {
    const res = await request(server, "POST", "/sessions/zzz/description", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "hello" }),
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
  });

  it("POST /sessions/:id/description returns 404 when the backend reports ok:false", async () => {
    mockSessionBackend.setDescription.mockResolvedValueOnce({ ok: false, description: null });
    const res = await request(server, "POST", "/sessions/abcdef1234567890abcdef1234567890abcdef12/description", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "hello" }),
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Session not found" });
  });

  it("POST /sessions/:id/description with a malformed JSON body returns 400", async () => {
    const res = await request(server, "POST", "/sessions/abcdef1234567890abcdef1234567890abcdef12/description", {
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "Invalid JSON body" });
  });

  it("POST /sessions/:id/description happy path passes the posted string through", async () => {
    const id = "abcdef1234567890abcdef1234567890abcdef12";
    const res = await request(server, "POST", `/sessions/${id}/description`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Fixing WebSocket reconnect loop" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ description: "my description" });
    expect(mockSessionBackend.setDescription).toHaveBeenCalledWith(id, "Fixing WebSocket reconnect loop");
  });

  it("POST /sessions/:id/resummarize with a non-hex id returns a 404 JSON error", async () => {
    const res = await request(server, "POST", "/sessions/zzz/resummarize");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
  });

  it("POST /sessions/:id/resummarize returns 404 when the backend reports ok:false", async () => {
    mockSessionBackend.resummarize.mockResolvedValueOnce({ ok: false, description: null });
    const res = await request(server, "POST", "/sessions/abcdef1234567890abcdef1234567890abcdef12/resummarize");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Session not found or not running" });
  });

  it("POST /sessions/:id/resummarize happy path returns the fresh description", async () => {
    const res = await request(server, "POST", "/sessions/abcdef1234567890abcdef1234567890abcdef12/resummarize");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ description: "auto summary" });
  });

  it("GET /config returns 200 with HTML form (no auth token set)", async () => {
    const { getUnknownConfigKeys } = await import("./config.js");
    vi.mocked(getUnknownConfigKeys).mockReturnValueOnce(["legacyKey"]);
    const res = await request(server, "GET", "/config");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Save Configuration");
    expect(res.body).toContain("selfRepo");
    expect(res.body).toContain("config-section");
    expect(res.body).toContain("<details");
    expect(res.body).toContain(">General</summary>");
    expect(res.body).toContain(">Scheduling</summary>");
    expect(res.body).not.toContain(">Server</h2>");
    expect(res.body).toContain("Unknown Config Keys");
    expect(res.body).toContain("Remove Unknown Keys");
    expect(res.body).toContain("warning-banner");
  });

  it("GET /config?saved=1 shows success banner", async () => {
    const res = await request(server, "GET", "/config?saved=1");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Configuration saved and applied");
  });

  it("GET /config shows the stored verification report in the Activation section", async () => {
    const { getLatestVerificationReport } = await import("./db.js");
    vi.mocked(getLatestVerificationReport).mockResolvedValueOnce({
      id: 1,
      ts: Date.now(),
      payload: JSON.stringify({ generatedAt: "2026-01-01T00:00:00Z", checks: [{ name: "github-api", ok: false, detail: "boom", ms: 5 }] }),
    });
    const res = await request(server, "GET", "/config");
    expect(res.status).toBe(200);
    expect(res.body).toContain("github-api");
    expect(res.body).toContain("boom");
    expect(res.body).toContain('id="activation"');
    expect(res.body).toContain('action="/api/verify/run"');
  });

  it("GET /config/api returns JSON with masked values", async () => {
    const res = await request(server, "GET", "/config/api");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body);
    expect(body.slackWebhook).toBe("****cdef");
    expect(body.selfRepo).toBe("owner1/repo1");
  });

  it("POST /api/activation accepts staging", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();

    const res = await request(server, "POST", "/api/activation", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "staging", confirm: true }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "flipped", state: "staging", restartRequired: true });
    expect(wc).toHaveBeenCalledWith({ activationState: "staging" });
  });

  it("POST /api/verify/run redirects a form post to the Activation section of /config", async () => {
    const res = await request(server, "POST", "/api/verify/run");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/config#activation");
  });

  it("POST /api/verify/run returns the report as JSON when asked for JSON", async () => {
    const res = await request(server, "POST", "/api/verify/run", { headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ generatedAt: "2026-01-01T00:00:00Z", checks: [] });
  });

  it("POST /api/activation rejects unknown states", async () => {
    const res = await request(server, "POST", "/api/activation", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "general-worker", confirm: true }),
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "state must be 'active', 'staging', or 'verify-only'" });
  });

  it("POST /config saves values and redirects", async () => {
    const { writeConfig: wc } = await import("./config.js");
    const res = await request(server, "POST", "/config", {
      body: "selfRepo=new%2Frepo&logRetentionDays=30&interval_issueWorkerMs=10&schedule_repoStandardsHour=3&slackWebhook=&authToken=",
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/config?saved=1");
    expect(wc).toHaveBeenCalled();
  });

  it("POST /config saves OIDC values and redirects", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();
    const res = await request(server, "POST", "/config", {
      body: "oidcBaseUrl=https%3A%2F%2Fauth.example.com&oidcApplicationSlug=claws&oidcClientId=test-client-id&oidcClientSecret=test-client-secret&oidcRedirectUri=https%3A%2F%2Fclaws.example.com%2Fauth%2Fcallback",
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/config?saved=1");
    expect(wc).toHaveBeenCalledWith(expect.objectContaining({
      oidcBaseUrl: "https://auth.example.com",
      oidcApplicationSlug: "claws",
      oidcClientId: "test-client-id",
      oidcClientSecret: "test-client-secret",
      oidcRedirectUri: "https://claws.example.com/auth/callback",
    }));
  });

  it("POST /config does not write the retired issueTracker key (#3294)", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();

    await request(server, "POST", "/config", { body: "selfRepo=owner1%2Frepo1" });
    expect(vi.mocked(wc).mock.calls[0][0]).not.toHaveProperty("issueTracker");
  });

  it("POST /config saves the tier table's fable keys and a valid review tier", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();

    await request(server, "POST", "/config", {
      body: "claudeFableModel=fable&codexFableModel=gpt-5.5&opencodeFableModel=openrouter%2Fanthropic%2Fclaude-opus-4&reviewModelTier=cheap",
    });
    expect(wc).toHaveBeenCalledWith(expect.objectContaining({
      claudeFableModel: "fable",
      codexFableModel: "gpt-5.5",
      opencodeFableModel: "openrouter/anthropic/claude-opus-4",
      // "cheap" is the legacy spelling; it is persisted canonically.
      reviewModelTier: "haiku",
    }));
  });

  it("POST /config saves the Anthropic API key and the OpenCode spend warning", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();

    await request(server, "POST", "/config", { body: "anthropicApiKey=sk-ant-new&opencodeSpendWarnUsd=200" });
    expect(wc).toHaveBeenCalledWith(expect.objectContaining({ anthropicApiKey: "sk-ant-new", opencodeSpendWarnUsd: 200 }));

    vi.mocked(wc).mockClear();
    await request(server, "POST", "/config", { body: "anthropicApiKey=&opencodeSpendWarnUsd=-5" });
    expect(wc).toHaveBeenCalledWith(expect.not.objectContaining({ opencodeSpendWarnUsd: expect.anything() }));
  });

  it("POST /config ignores an unrecognised review model tier", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();

    await request(server, "POST", "/config", { body: "reviewModelTier=gpt-5.5" });
    expect(wc).toHaveBeenCalledWith(expect.not.objectContaining({ reviewModelTier: expect.anything() }));
  });

  it("POST /config/remove-unknown-keys removes keys and redirects to /config?saved=1 when keys exist", async () => {
    const { getUnknownConfigKeys, removeConfigKeys } = await import("./config.js");
    vi.mocked(getUnknownConfigKeys).mockReturnValue(["oldKey", "legacyKey"]);
    vi.mocked(removeConfigKeys).mockClear();
    const res = await request(server, "POST", "/config/remove-unknown-keys");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/config?saved=1");
    expect(removeConfigKeys).toHaveBeenCalledWith(["oldKey", "legacyKey"]);
    vi.mocked(getUnknownConfigKeys).mockReturnValue([]);
  });

  it("POST /config/remove-unknown-keys redirects to /config without ?saved=1 when no unknown keys", async () => {
    const { getUnknownConfigKeys, removeConfigKeys } = await import("./config.js");
    vi.mocked(getUnknownConfigKeys).mockReturnValue([]);
    vi.mocked(removeConfigKeys).mockClear();
    const res = await request(server, "POST", "/config/remove-unknown-keys");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/config");
    expect(removeConfigKeys).not.toHaveBeenCalled();
  });

  it("POST /config assembles provider enabled and weight settings", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();
    const res = await request(server, "POST", "/config", {
      body: "providerEnabled_claude=true&providerWeight_claude=4&providerWeight_codex=2&providerEnabled_opencode=true&providerWeight_opencode=3&providerEnabled_pi=true&providerWeight_pi=0",
    });
    expect(res.status).toBe(303);
    expect(wc).toHaveBeenCalledWith(expect.objectContaining({
      aiProviders: {
        claude: { enabled: true, weight: 4 },
        codex: { enabled: false, weight: 2 },
        opencode: { enabled: true, weight: 3 },
        pi: { enabled: true, weight: 0 },
      },
    }));
  });

  it("POST /config keeps a submitted weight of 0 (pin-only) and disables non-numeric submissions", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();
    const res = await request(server, "POST", "/config", {
      body: "providerEnabled_claude=true&providerWeight_claude=4&providerEnabled_codex=true&providerWeight_codex=0&providerEnabled_opencode=true&providerWeight_opencode=banana&providerEnabled_pi=true&providerWeight_pi=0",
    });
    expect(res.status).toBe(303);
    expect(wc).toHaveBeenCalledWith(expect.objectContaining({
      aiProviders: {
        claude: { enabled: true, weight: 4 },
        codex: { enabled: true, weight: 0 },
        opencode: { enabled: false, weight: 0 },
        pi: { enabled: true, weight: 0 },
      },
    }));
  });

  it("POST /config disables an unchecked Mac runner while leaving others untouched", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();
    const res = await request(server, "POST", "/config", {
      body: "macRunnerHosts=brendans-macbook-pro.local%2Cbrendans-macbook-pro-3.local&macRunnerEnabled_brendans-macbook-pro-3.local=on",
    });
    expect(res.status).toBe(303);
    expect(wc).toHaveBeenCalledWith(expect.objectContaining({
      macRunners: [
        expect.objectContaining({ host: "brendans-macbook-pro.local", enabled: false }),
        expect.objectContaining({ host: "brendans-macbook-pro-3.local", enabled: true }),
      ],
    }));
  });

  it("POST /config leaves macRunnerRepos unchanged when no repo file covers it (#2936)", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();
    const res = await request(server, "POST", "/config", {
      body: "macRunnerRepos=org%2Frepo%2Ctest%2Frepo",
    });
    expect(res.status).toBe(303);
    const written = vi.mocked(wc).mock.calls.at(-1)![0] as { macRunnerRepos: string[] };
    expect(written.macRunnerRepos).toEqual(["org/repo", "test/repo"]);
  });

  it("POST /config drops a macRunnerRepos entry the repo's claws.json already covers (#2936)", async () => {
    const { writeConfig: wc, isRepoDeclaredMacRunner } = await import("./config.js");
    vi.mocked(wc).mockClear();
    vi.mocked(isRepoDeclaredMacRunner).mockImplementation((r: string) => r === "org/repo");
    const res = await request(server, "POST", "/config", {
      body: "macRunnerRepos=org%2Frepo%2Ctest%2Frepo",
    });
    expect(res.status).toBe(303);
    const written = vi.mocked(wc).mock.calls.at(-1)![0] as { macRunnerRepos: string[] };
    expect(written.macRunnerRepos).toEqual(["test/repo"]);
    vi.mocked(isRepoDeclaredMacRunner).mockReturnValue(false);
  });

  it("GET /sessions returns 200 with HTML", async () => {
    const res = await request(server, "GET", "/sessions");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain('method="POST" action="/sessions/create"');
  });

  it("GET /api/sessions/table returns the list's tables as JSON (#clw_01M52FEC8QSM9P57WWSEBYFB7D)", async () => {
    const res = await request(server, "GET", "/api/sessions/table");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(res.body) as { signature: unknown; active: unknown; all: unknown };
    expect(typeof body.signature).toBe("string");
    expect(typeof body.active).toBe("string");
    expect(typeof body.all).toBe("string");
  });

  it("GET /api/sessions/table returns the Sessions nav badge for the alive sessions only", async () => {
    const item = (id: string, alive: boolean) => ({ id, repo: null, extraRepos: [], cwd: "/tmp", createdAt: 1, alive, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null });
    mockSessionBackend.listLive.mockResolvedValueOnce([item("aa11", true), item("bb22", true), item("cc33", false)] as never);
    const res = await request(server, "GET", "/api/sessions/table");
    const body = JSON.parse(res.body) as { nav: Array<{ href: string; text: string; name: string }>; active: string };
    expect(body.nav).toEqual([{ href: "/sessions", text: "2", name: "Sessions, 2 active" }]);
    expect(body.active.match(/<tr[^>]*data-session-id/g)).toHaveLength(2);

    const none = JSON.parse((await request(server, "GET", "/api/sessions/table")).body) as { nav: unknown };
    expect(none.nav).toEqual([{ href: "/sessions", text: "", name: "Sessions" }]);
  });

  it("GET /sessions shows a nav count equal to the Active Sessions rows", async () => {
    const item = (id: string, alive: boolean) => ({ id, repo: null, extraRepos: [], cwd: "/tmp", createdAt: 1, alive, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null });
    mockSessionBackend.listLive.mockResolvedValue([item("aa11", true), item("bb22", true)] as never);
    try {
      const res = await request(server, "GET", "/sessions");
      expect(res.body).toMatch(/href="\/sessions"[^>]*>[^<]*(?:<[^>]+>)?[^<]*<span class="nav-count"[^>]*>2<\/span>/);
      const active = res.body.slice(res.body.indexOf('id="active-sessions-table"'));
      expect(active.slice(0, active.indexOf("</table>")).match(/data-session-id/g)).toHaveLength(2);
    } finally {
      mockSessionBackend.listLive.mockReset();
      mockSessionBackend.listLive.mockResolvedValue([]);
    }
  });

  it("GET /sessions defaults new sessions to Codex while Claude is provider-rate-limited", async () => {
    vi.mocked(isProviderRateLimited).mockImplementation((provider) => provider === "claude");
    try {
      const res = await request(server, "GET", "/sessions");
      expect(res.status).toBe(200);
      const singleForm = res.body.slice(res.body.indexOf('action="/sessions/create"'), res.body.indexOf('action="/sessions/create-multi"'));
      const multiForm = res.body.slice(res.body.indexOf('action="/sessions/create-multi"'));
      expect(singleForm).toContain('<option value="claude">Claude</option>');
      expect(singleForm).toContain('<option value="codex" selected>Codex</option>');
      expect(multiForm).toContain('<option value="claude">Claude</option>');
      expect(multiForm).toContain('<option value="codex" selected>Codex</option>');
    } finally {
      vi.mocked(isProviderRateLimited).mockReturnValue(false);
    }
  });

  it("POST /sessions/create forwards the chosen model to the backend (#2873)", async () => {
    mockSessionBackend.create.mockClear();
    const res = await request(server, "POST", "/sessions/create", {
      body: "repo=org%2Fa&mode=repo-claude&provider=claude&model=opus",
    });
    expect(res.status).toBe(503); // the mocked backend create reports shutting-down
    expect(mockSessionBackend.create).toHaveBeenCalledWith({ repo: "org/a", mode: "repo-claude", capabilities: [], provider: "claude", model: "opus", initialPrompt: null, attachments: [] });
    expect(res.body).toContain("claws-retry-form");
    expect(res.body).toContain('action="/sessions/create"');
    expect(res.body).toContain('name="mode" value="repo-claude"');
    expect(res.body).toContain('name="model" value="opus"');
  });

  it("POST /sessions/create resolves the custom-model sentinel from modelCustom (#2873)", async () => {
    mockSessionBackend.create.mockClear();
    const res = await request(server, "POST", "/sessions/create", {
      body: "repo=org%2Fa&mode=repo-claude&provider=opencode&model=__custom__&modelCustom=openrouter%2Fx%2Fy",
    });
    expect(res.status).toBe(503);
    expect(mockSessionBackend.create).toHaveBeenCalledWith({ repo: "org/a", mode: "repo-claude", capabilities: [], provider: "opencode", model: "openrouter/x/y", initialPrompt: null, attachments: [] });
  });

  it("POST /sessions/create rejects a model id with whitespace (#2873)", async () => {
    mockSessionBackend.create.mockClear();
    const res = await request(server, "POST", "/sessions/create", {
      body: "repo=org%2Fa&mode=repo-claude&provider=claude&model=a%20b",
    });
    expect(res.status).toBe(400);
    expect(mockSessionBackend.create).not.toHaveBeenCalled();
  });

  it("POST /sessions/create-multi forwards the chosen provider and model", async () => {
    mockSessionBackend.createMulti.mockClear();
    const res = await request(server, "POST", "/sessions/create-multi", {
      body: "repo=org%2Fa&repo=org%2Fb&provider=codex&model=gpt-5.6-luna",
    });
    expect(res.status).toBe(503); // the mocked backend createMulti reports shutting-down
    expect(mockSessionBackend.createMulti).toHaveBeenCalledWith({ repos: ["org/a", "org/b"], capabilities: [], provider: "codex", model: "gpt-5.6-luna", initialPrompt: null, attachments: [] });
    expect(res.body).toContain("claws-retry-form");
    expect(res.body).toContain('action="/sessions/create-multi"');
    expect(res.body).toContain('name="provider" value="codex"');
    expect(res.body).toContain('name="model" value="gpt-5.6-luna"');
  });

  it("POST /sessions/create-multi rejects an invalid provider", async () => {
    mockSessionBackend.createMulti.mockClear();
    const res = await request(server, "POST", "/sessions/create-multi", {
      body: "repo=org%2Fa&repo=org%2Fb&provider=bogus",
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("Invalid provider");
    expect(mockSessionBackend.createMulti).not.toHaveBeenCalled();
  });

  it("POST /sessions/create-multi resolves the custom-model sentinel from modelCustom", async () => {
    mockSessionBackend.createMulti.mockClear();
    const res = await request(server, "POST", "/sessions/create-multi", {
      body: "repo=org%2Fa&repo=org%2Fb&provider=codex&model=__custom__&modelCustom=gpt-5.6-luna",
    });
    expect(res.status).toBe(503);
    expect(mockSessionBackend.createMulti).toHaveBeenCalledWith({ repos: ["org/a", "org/b"], capabilities: [], provider: "codex", model: "gpt-5.6-luna", initialPrompt: null, attachments: [] });
  });

  it("POST /sessions/create passes the normalised Initial prompt and keeps it on the retry form", async () => {
    mockSessionBackend.create.mockClear();
    const res = await request(server, "POST", "/sessions/create", {
      body: `repo=org%2Fa&mode=repo-claude&provider=claude&model=opus&initialPrompt=${encodeURIComponent("  Fix the \"build\"\r\nthen test  ")}`,
    });
    expect(res.status).toBe(503);
    expect(mockSessionBackend.create).toHaveBeenCalledWith(expect.objectContaining({ mode: "repo-claude", initialPrompt: "Fix the \"build\"\nthen test" }));
    expect(res.body).toContain(`name="initialPrompt" value="Fix the &quot;build&quot;\nthen test"`);
  });

  it("POST /sessions/create passes no Initial prompt for a zsh session or a blank field", async () => {
    mockSessionBackend.create.mockClear();
    await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-zsh&provider=claude&initialPrompt=hello" });
    expect(mockSessionBackend.create).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "repo-zsh", initialPrompt: null }));
    await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-claude&provider=claude&initialPrompt=%20%0D%0A%20" });
    expect(mockSessionBackend.create).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "repo-claude", initialPrompt: null }));
  });

  it("POST /sessions/create and /sessions/create-multi reject an Initial prompt over 16,000 characters", async () => {
    mockSessionBackend.create.mockClear();
    mockSessionBackend.createMulti.mockClear();
    const single = await request(server, "POST", "/sessions/create", { body: `repo=org%2Fa&mode=repo-claude&provider=claude&initialPrompt=${"x".repeat(16_001)}` });
    expect(single.status).toBe(400);
    expect(single.body).toContain("Initial prompt is too long (max 16,000 characters)");
    const multi = await request(server, "POST", "/sessions/create-multi", { body: `repo=org%2Fa&repo=org%2Fb&provider=claude&initialPrompt=${"x".repeat(16_001)}` });
    expect(multi.status).toBe(400);
    expect(mockSessionBackend.create).not.toHaveBeenCalled();
    expect(mockSessionBackend.createMulti).not.toHaveBeenCalled();
    const atLimit = await request(server, "POST", "/sessions/create", { body: `repo=org%2Fa&mode=repo-claude&provider=claude&initialPrompt=${"x".repeat(16_000)}` });
    expect(atLimit.status).toBe(503);
  });

  it("POST /sessions/create and /sessions/create-multi pass staged attachment ids and keep them on the retry form", async () => {
    sessionAttachmentsState.rows.clear();
    mockSessionBackend.create.mockClear();
    mockSessionBackend.createMulti.mockClear();
    const staged = await request(server, "POST", "/sessions/attachments", multipartFile("a.png", "DATA"));
    const id = JSON.parse(staged.body).attachment.id as string;
    const single = await request(server, "POST", "/sessions/create", { body: `repo=org%2Fa&mode=repo-claude&provider=claude&attachment=${id}` });
    expect(single.status).toBe(503);
    expect(mockSessionBackend.create).toHaveBeenCalledWith(expect.objectContaining({ initialPrompt: null, attachments: [id] }));
    expect(single.body).toContain(`name="attachment" value="${id}"`);
    const multi = await request(server, "POST", "/sessions/create-multi", { body: `repo=org%2Fa&repo=org%2Fb&provider=claude&attachment=${id}` });
    expect(mockSessionBackend.createMulti).toHaveBeenCalledWith(expect.objectContaining({ attachments: [id] }));
    expect(multi.body).toContain(`name="attachment" value="${id}"`);
  });

  it("POST /sessions/create refuses an unknown or already-claimed attachment before creating anything", async () => {
    sessionAttachmentsState.rows.clear();
    mockSessionBackend.create.mockClear();
    mockSessionBackend.createMulti.mockClear();
    const unknown = await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-claude&provider=claude&attachment=sat_01M617FXR2G2Q62972WCFY57HA" });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toContain("Attachment no longer available");
    const staged = await request(server, "POST", "/sessions/attachments", multipartFile("a.png", "DATA"));
    const id = JSON.parse(staged.body).attachment.id as string;
    sessionAttachmentsState.rows.get(id)!.session_id = "beef01";
    const claimed = await request(server, "POST", "/sessions/create-multi", { body: `repo=org%2Fa&repo=org%2Fb&provider=claude&attachment=${id}` });
    expect(claimed.status).toBe(400);
    expect(mockSessionBackend.create).not.toHaveBeenCalled();
    expect(mockSessionBackend.createMulti).not.toHaveBeenCalled();
  });

  it("POST /sessions/create drops attachment ids for a zsh session", async () => {
    mockSessionBackend.create.mockClear();
    await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-zsh&provider=claude&attachment=sat_01M617FXR2G2Q62972WCFY57HA" });
    expect(mockSessionBackend.create).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "repo-zsh", attachments: [] }));
  });

  it("POST /sessions/attachments stages a file, refuses an empty one, and the delete route removes a pending one", async () => {
    sessionAttachmentsState.rows.clear();
    const ok = await request(server, "POST", "/sessions/attachments", multipartFile("board.png", "DATA"));
    expect(ok.status).toBe(200);
    const { attachment } = JSON.parse(ok.body) as { attachment: { id: string; name: string; size: number } };
    expect(attachment).toEqual({ id: expect.stringMatching(/^sat_/), name: "board.png", size: 4 });

    const empty = await request(server, "POST", "/sessions/attachments", multipartFile("empty.txt", ""));
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.body).error).toBe("empty.txt: empty file or folder — not uploaded");

    const streamed = await request(server, "POST", "/sessions/attachments/stream?name=big.bin", { headers: { "content-type": "application/octet-stream" }, body: "streamed" });
    expect(streamed.status).toBe(200);
    expect(JSON.parse(streamed.body).attachment).toMatchObject({ name: "big.bin", size: 8 });

    expect((await request(server, "POST", `/sessions/attachments/${attachment.id}/delete`)).status).toBe(200);
    expect(sessionAttachmentsState.rows.has(attachment.id)).toBe(false);
    expect((await request(server, "POST", `/sessions/attachments/${attachment.id}/delete`)).status).toBe(404);
  });

  it("POST /sessions/attachments answers 413 past the 10 MB per-file limit", async () => {
    const res = await request(server, "POST", "/sessions/attachments", multipartFile("big.bin", "x".repeat(10 * 1024 * 1024 + 1)));
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toBe("File too large (max 10 MB)");
  });

  it("GET /api/sessions/:sid/attachments/:aid serves a claimed file only to that session's token", async () => {
    sessionAttachmentsState.rows.clear();
    const staged = await request(server, "POST", "/sessions/attachments", multipartFile("board.png", "PIXELS"));
    const id = JSON.parse(staged.body).attachment.id as string;
    sessionAttachmentsState.rows.get(id)!.session_id = "abc123";

    const noToken = await request(server, "GET", `/api/sessions/abc123/attachments/${id}`);
    expect(noToken.status).toBe(401);

    mockSessionBackend.verifyMcpToken.mockImplementation((async () => "ok") as never);
    try {
      const auth = { headers: { authorization: "Bearer good" } };
      const ok = await request(server, "GET", `/api/sessions/abc123/attachments/${id}`, auth);
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("PIXELS");
      expect(ok.headers["content-length"]).toBe("6");
      expect((await request(server, "GET", `/api/sessions/def456/attachments/${id}`, auth)).status).toBe(404);
    } finally {
      mockSessionBackend.verifyMcpToken.mockImplementation((async () => "denied") as never);
    }
  });

  it("POST /sessions/create-multi passes the Initial prompt and keeps it on the retry form", async () => {
    mockSessionBackend.createMulti.mockClear();
    const res = await request(server, "POST", "/sessions/create-multi", {
      body: "repo=org%2Fa&repo=org%2Fb&provider=claude&initialPrompt=Look+at+both",
    });
    expect(res.status).toBe(503);
    expect(mockSessionBackend.createMulti).toHaveBeenCalledWith(expect.objectContaining({ repos: ["org/a", "org/b"], initialPrompt: "Look at both" }));
    expect(res.body).toContain('name="initialPrompt" value="Look at both"');
  });

  it("GET /jobs lists every job with Last Run and Next Run columns", async () => {
    const res = await request(server, "GET", "/jobs");
    expect(res.status).toBe(200);
    expect(res.body).toContain("issue-worker");
    expect(res.body).toContain("ci-fixer");
    expect(res.body).toContain(">Last Run</th>");
    expect(res.body).toContain(">Next Run</th>");
    expect(res.body).toContain('id="job-lastrun-issue-worker"');
    expect(res.body).toContain('id="job-nextrun-issue-worker"');
  });

  it("GET /api/status includes jobSchedules", async () => {
    const res = await request(server, "GET", "/api/status");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("jobSchedules");
    expect(body.jobSchedules).toHaveProperty("issue-worker");
    expect(body.jobSchedules["issue-worker"]).toHaveProperty("lastCompletedAt");
    expect(body.jobSchedules["issue-worker"]).toHaveProperty("nextRunIn");
  });

  it("GET /jobs shows the running task in the Current Task column", async () => {
    const res = await request(server, "GET", "/jobs");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Current Task");
    const start = res.body.indexOf('id="job-detail-issue-worker"');
    expect(start).toBeGreaterThan(-1);
    const cell = res.body.slice(start, res.body.indexOf("</td>", start));
    expect(cell).toContain('href="/logs/issue?repo=org%2Frepo&number=42"');
    expect(cell).toContain("#42");
    expect(cell).not.toContain("org/repo #42");
  });

  it("GET /status shows the running task in the Agent Queue 'Working on' panel, with a cancel button", async () => {
    const res = await request(server, "GET", "/status");
    expect(res.status).toBe(200);
    const start = res.body.indexOf('id="queue-working-on"');
    expect(start).toBeGreaterThan(-1);
    const panel = res.body.slice(start, res.body.indexOf("</dd>", start));
    expect(panel).toContain('href="/logs/issue?repo=org%2Frepo&number=42"');
    expect(panel).toContain("#42");
    // Display text should show just "repo", not "org/repo"
    expect(panel).not.toContain("org/repo #42");
    expect(res.body).toContain('id="cancel-btn"');
  });

  it("POST /trigger/:job works without auth when no token configured", async () => {
    const res = await request(server, "POST", "/trigger/issue-worker");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("started");
  });

  it("POST /trigger/:job returns 404 for unknown job", async () => {
    scheduler.triggerJob = vi.fn().mockReturnValue("unknown");
    const res = await request(server, "POST", "/trigger/nonexistent-job");
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("unknown");
  });

  it("POST /trigger/:job returns 409 when already running", async () => {
    scheduler.triggerJob = vi.fn().mockReturnValue("already-running");
    const res = await request(server, "POST", "/trigger/issue-worker");
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("already-running");
  });

  it("POST /trigger/:job returns 409 when draining", async () => {
    scheduler.triggerJob = vi.fn().mockReturnValue("draining");
    const res = await request(server, "POST", "/trigger/issue-worker");
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("draining");
  });

  it("POST /cancel returns 200 with cancelled result", async () => {
    const res = await request(server, "POST", "/cancel");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("cancelled");
    expect(agentPodLauncherMock.cancelAll).not.toHaveBeenCalled();
  });

  it("POST /cancel also cancels agent pods under the k8s-pod work backend", async () => {
    const { cancelCurrentTask } = await import("./claude.js");
    vi.mocked(cancelCurrentTask).mockReturnValueOnce(false);
    agentPodLauncherMock.cancelAll.mockResolvedValueOnce(2);
    workBackendState.backend = "k8s-pod";
    try {
      const res = await request(server, "POST", "/cancel");
      expect(JSON.parse(res.body).result).toBe("cancelled");
      expect(agentPodLauncherMock.cancelAll).toHaveBeenCalledTimes(1);
    } finally {
      workBackendState.backend = "in-process";
      agentPodLauncherMock.cancelAll.mockClear();
    }
  });

  it("POST /logs/:runId/cancel stops the run's agent pod under the k8s-pod work backend", async () => {
    const db = await import("./db.js");
    vi.mocked(db.cancelJobRunIfRunning).mockResolvedValueOnce(true);
    workBackendState.backend = "k8s-pod";
    try {
      const res = await request(server, "POST", "/logs/running-456/cancel");
      expect(JSON.parse(res.body).result).toBe("cancelled");
      expect(agentPodLauncherMock.cancelByRunId).toHaveBeenCalledWith("running-456");
    } finally {
      workBackendState.backend = "in-process";
      agentPodLauncherMock.cancelByRunId.mockClear();
    }
  });

  it("POST /pause/:job returns 200 with paused result for known unpaused job", async () => {
    const res = await request(server, "POST", "/pause/ci-fixer");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("paused");
  });

  it("POST /pause/:job returns 200 with resumed result for known paused job", async () => {
    // First pause the job
    await request(server, "POST", "/pause/ci-fixer");
    // Then toggle again to resume
    const res = await request(server, "POST", "/pause/ci-fixer");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("resumed");
  });

  it("POST /pause/:job returns 404 for unknown job", async () => {
    const res = await request(server, "POST", "/pause/nonexistent-job");
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("unknown");
  });

  it("POST /pause/:job calls writeConfig with updated paused jobs list", async () => {
    const { writeConfig: wc } = await import("./config.js");
    await request(server, "POST", "/pause/ci-fixer");
    expect(wc).toHaveBeenCalledWith({ pausedJobs: expect.arrayContaining(["ci-fixer"]) });
  });

  it("GET /api/providers returns rateLimited/rateLimitedUntil/authExpired for each provider", async () => {
    const claude = await import("./claude.js");
    const heldUntil = Date.now() + 3_600_000;
    (claude.getProviderRateLimitedUntil as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      p === "claude" ? heldUntil : null,
    );
    const res = await request(server, "GET", "/api/providers");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claude).toEqual({
      rateLimited: true,
      rateLimitedUntil: new Date(heldUntil).toISOString(),
      authExpired: false,
      accounts: {
        primary: {
          label: "primary",
          tokenPresent: expect.any(Boolean),
          authExpired: false,
          rateLimited: false,
          rateLimitedUntil: null,
          tierRateLimitedUntil: {},
          lastUsedAt: null,
        },
      },
    });
    expect(body.codex).toEqual({ rateLimited: false, rateLimitedUntil: null, authExpired: false });
    expect(body.opencode).toEqual({ rateLimited: false, rateLimitedUntil: null, authExpired: false });    // A held Claude would otherwise steer later tests' provider defaults.
    (claude.getProviderRateLimitedUntil as ReturnType<typeof vi.fn>).mockReset().mockReturnValue(null);
  });

  it("GET /api/pi-auth/providers returns pi's per-provider readiness", async () => {
    const res = await request(server, "GET", "/api/pi-auth/providers");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      { provider: "anthropic", label: "Anthropic account", source: "Claude token (CLAUDE_CODE_OAUTH_TOKEN)", status: "ready", reason: null },
    ]);
  });

  it("POST /api/providers/:provider/clear-rate-limit clears the given provider", async () => {
    const claude = await import("./claude.js");
    const slack = await import("./slack.js");
    (claude.clearProviderRateLimitState as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await request(server, "POST", "/api/providers/claude/clear-rate-limit");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, cleared: true });
    expect(claude.clearProviderRateLimitState).toHaveBeenCalledWith("claude", undefined);
    expect(slack.notify).not.toHaveBeenCalledWith(expect.stringContaining("[dashboard]"));
  });

  it("POST /api/providers/claude/accounts/:account/clear-rate-limit clears that account only", async () => {
    const claude = await import("./claude.js");
    const slack = await import("./slack.js");
    (claude.clearProviderRateLimitState as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await request(server, "POST", "/api/providers/claude/accounts/primary/clear-rate-limit");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, cleared: true });
    expect(claude.clearProviderRateLimitState).toHaveBeenCalledWith("claude", "primary");
    expect(slack.notify).not.toHaveBeenCalledWith(expect.stringContaining("[dashboard]"));
  });

  it("POST /api/providers/claude/accounts/:account/clear-rate-limit rejects an unknown account", async () => {
    const res = await request(server, "POST", "/api/providers/claude/accounts/nope/clear-rate-limit");
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "unknown account" });
  });

  it("POST /api/providers/:provider/clear-rate-limit does not notify when no cooldown was active", async () => {
    const claude = await import("./claude.js");
    const slack = await import("./slack.js");
    (claude.clearProviderRateLimitState as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await request(server, "POST", "/api/providers/claude/clear-rate-limit");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, cleared: false });
    expect(slack.notify).not.toHaveBeenCalled();
  });

  it("POST /api/providers/:provider/clear-rate-limit rejects an unknown provider", async () => {
    const res = await request(server, "POST", "/api/providers/bogus/clear-rate-limit");
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: false, error: "unknown provider" });
  });

  it("GET /api/status includes pausedJobs array", async () => {
    const res = await request(server, "GET", "/api/status");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("pausedJobs");
    expect(Array.isArray(body.pausedJobs)).toBe(true);
  });

  it("GET /jobs renders Pause buttons for each job", async () => {
    const res = await request(server, "GET", "/jobs");
    expect(res.status).toBe(200);
    expect(res.body).toContain("togglePause(");
    expect(res.body).toContain('id="pause-issue-worker"');
    expect(res.body).toContain('id="pause-ci-fixer"');
  });

  it("GET /jobs includes log links in the job status table", async () => {
    const res = await request(server, "GET", "/jobs");
    expect(res.status).toBe(200);
    expect(res.body).toContain('href="/logs/abc-123"');
    expect(res.body).toContain(">View</a>");
    expect(res.body).toContain(">Logs</th>");
  });

  it("GET /logs/:runId/tail returns JSON with logs", async () => {
    const res = await request(server, "GET", "/logs/abc-123/tail?after=0");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body);
    expect(body.status).toBe("completed");
    expect(body.logs).toBeInstanceOf(Array);
    expect(body.logs[0].message).toBe("Starting");
  });

  it("GET /logs/:runId/tail returns empty logs when after is current", async () => {
    const res = await request(server, "GET", "/logs/abc-123/tail?after=1");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.logs).toHaveLength(0);
  });

  it("GET /logs/:runId/tail returns 404 for nonexistent run", async () => {
    const res = await request(server, "GET", "/logs/nonexistent/tail?after=0");
    expect(res.status).toBe(404);
  });

  it("GET /logs/:runId shows level filter bar", async () => {
    const res = await request(server, "GET", "/logs/abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toContain('id="level-filter"');
    expect(res.body).toContain('data-level="debug"');
    expect(res.body).toContain('data-level="info"');
    expect(res.body).toContain('data-level="warn"');
    expect(res.body).toContain('data-level="error"');
  });
});

describe("Theme support", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /status defaults to system theme (no data-theme on html tag)", async () => {
    const res = await request(server, "GET", "/status");
    expect(res.status).toBe(200);
    // System mode: <html lang="en" data-width="wide"> with no data-theme attribute
    expect(res.body).toMatch(/<html lang="en" data-width="wide">\s*\n<head>/);
  });

  it("GET /status with claws_theme=dark cookie sets data-theme=dark on html tag", async () => {
    const res = await request(server, "GET", "/status", {
      headers: { Cookie: "claws_theme=dark" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<html lang="en" data-theme="dark" data-width="wide">');
  });

  it("GET /status with claws_theme=light cookie sets data-theme=light on html tag", async () => {
    const res = await request(server, "GET", "/status", {
      headers: { Cookie: "claws_theme=light" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<html lang="en" data-theme="light" data-width="wide">');
  });

  it("GET /status with claws_theme=system cookie omits data-theme on html tag", async () => {
    const res = await request(server, "GET", "/status", {
      headers: { Cookie: "claws_theme=system" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<html lang="en" data-width="wide">\s*\n<head>/);
  });

  it("GET /status with invalid claws_theme cookie defaults to system", async () => {
    const res = await request(server, "GET", "/status", {
      headers: { Cookie: "claws_theme=invalid" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<html lang="en" data-width="wide">\s*\n<head>/);
  });

  it("theme select has correct option pre-selected for dark", async () => {
    const res = await request(server, "GET", "/status", {
      headers: { Cookie: "claws_theme=dark" },
    });
    expect(res.body).toContain('<option value="dark" selected>');
    expect(res.body).not.toContain('<option value="light" selected>');
    expect(res.body).not.toContain('<option value="system" selected>');
  });

  it("theme select has system pre-selected by default", async () => {
    const res = await request(server, "GET", "/status");
    expect(res.body).toContain('<option value="system" selected>');
    expect(res.body).not.toContain('<option value="dark" selected>');
    expect(res.body).not.toContain('<option value="light" selected>');
  });

  it("all pages include theme toggle and setTheme script", async () => {
    for (const path of ["/status", "/config", "/jobs"]) {
      const res = await request(server, "GET", path);
      expect(res.status).toBe(200);
      expect(res.body).toContain("theme-select");
      expect(res.body).toContain("setTheme");
    }
  });

  it("CSS includes theme variable definitions", async () => {
    const res = await request(server, "GET", "/status");
    expect(res.body).toContain(":root {");
    expect(res.body).toContain("--bg:");
    expect(res.body).toContain("--accent:");
    expect(res.body).toContain("prefers-color-scheme: light");
    expect(res.body).toContain('[data-theme="light"]');
    expect(res.body).toContain("var(--bg)");
  });

  it("buildLogDetailPage renders theme attribute correctly", () => {
    const run = { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    const logs = [{ id: 1, run_id: "r1", level: "info", message: "test", logged_at: "2025-01-01 00:00:00" }];
    const html = buildLogDetailPage(run, logs, "dark" as Theme);
    expect(html).toContain('data-theme="dark"');
  });

  it("buildLogDetailPage renders work items section when tasks provided", () => {
    const run = { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    const logs = [{ id: 1, run_id: "r1", level: "info", message: "test", logged_at: "2025-01-01 00:00:00" }];
    const tasks = [
      { id: 1, job_name: "test-job", repo: "org/repo", item_number: 99, trigger_label: null, worktree_path: null, branch_name: null, run_id: "r1", status: "completed", error: null, started_at: "2025-01-01", completed_at: "2025-01-01" },
    ];
    const html = buildLogDetailPage(run, logs, "system" as Theme, tasks as any);
    expect(html).toContain("Work Items");
    expect(html).toContain("repo#99");
    expect(html).toContain("(completed)");
    expect(html).toContain("/logs/issue?repo=org%2Frepo&number=99");
  });

  it("buildLogDetailPage omits work items section when no tasks", () => {
    const run = { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    const logs = [{ id: 1, run_id: "r1", level: "info", message: "test", logged_at: "2025-01-01 00:00:00" }];
    const html = buildLogDetailPage(run, logs, "system" as Theme, []);
    expect(html).not.toContain("Work Items");
  });

});

describe("Claude account login routes", () => {
  it("rejects an unknown account and reports per-account token presence in the status", async () => {
    const s = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (s.listening) resolve();
      else s.on("listening", resolve);
    });
    try {
      const res = await request(s, "POST", "/api/claude-auth/not-configured/start");
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ ok: false });
      const status = await request(s, "GET", "/api/claude-auth/status");
      expect(status.status).toBe(200);
      const body = JSON.parse(status.body) as { account: string | null; tokens: Record<string, boolean> };
      expect(body.account).toBeNull();
      expect(Object.keys(body.tokens).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("Claude account management routes", () => {
  let s: http.Server;
  const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeEach(async () => {
    claudeAccountsTable.rows = [{ id: "primary", label: "primary", token: "sk-ant-oat01-ROUTE-SECRET", position: 0 }];
    await (await import("./claude-accounts.js")).refreshClaudeAccounts();
    s = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (s.listening) resolve();
      else s.on("listening", resolve);
    });
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
    claudeAccountsTable.rows = [{ id: "primary", label: "primary", token: null, position: 0 }];
    const { refreshClaudeAccounts } = await import("./claude-accounts.js");
    await refreshClaudeAccounts();
  });

  it("adds an account with the id as its default label, rejects a bad or duplicate id, and never returns a token", async () => {
    const added = await request(s, "POST", "/api/claude-accounts", json({ id: "second-max" }));
    expect(added.status).toBe(200);
    expect(JSON.parse(added.body)).toEqual({ ok: true, account: { id: "second-max", label: "second-max" } });
    expect(claudeAccountsTable.rows.map((r) => r.id)).toEqual(["primary", "second-max"]);
    // The new account's login can start at once: it is known with no restart.
    const { findClaudeAccount } = await import("./claude-accounts.js");
    expect(findClaudeAccount("second-max")).toEqual({ id: "second-max", label: "second-max" });

    expect((await request(s, "POST", "/api/claude-accounts", json({ id: "Bad_Id" }))).status).toBe(400);
    const dup = await request(s, "POST", "/api/claude-accounts", json({ id: "primary", label: "again" }));
    expect(dup.status).toBe(409);
    expect(dup.body).not.toContain("sk-ant-oat01");
  });

  it("relabels an account, 404s an unknown one, and never returns a token", async () => {
    const res = await request(s, "PATCH", "/api/claude-accounts/primary", json({ label: "Main Max" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, account: { id: "primary", label: "Main Max" } });
    expect(res.body).not.toContain("sk-ant-oat01");
    expect(claudeAccountsTable.rows[0]!.label).toBe("Main Max");
    expect((await request(s, "PATCH", "/api/claude-accounts/nope", json({ label: "x" }))).status).toBe(404);
    expect((await request(s, "PATCH", "/api/claude-accounts/primary", json({}))).status).toBe(400);
  });

  it("removes an account with its token, holds and auth-expired latch, and 404s an unknown one", async () => {
    const db = await import("./db.js");
    const res = await request(s, "DELETE", "/api/claude-accounts/primary");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(claudeAccountsTable.rows).toEqual([]);
    expect(db.clearProviderHolds).toHaveBeenCalledWith("claude@primary");
    expect(db.clearProviderHolds).toHaveBeenCalledWith("auth-expired:claude@primary");
    const { claudeAccounts } = await import("./claude-accounts.js");
    expect(claudeAccounts()).toEqual([]);
    expect((await request(s, "DELETE", "/api/claude-accounts/primary")).status).toBe(404);
    // With no account left the legacy login route has nothing to start.
    expect((await request(s, "POST", "/api/claude-auth/start")).status).toBe(404);
  });

  it("reports token presence, never the token, in the login status", async () => {
    const res = await request(s, "GET", "/api/claude-auth/status");
    expect(JSON.parse(res.body).tokens).toEqual({ primary: true });
    expect(res.body).not.toContain("sk-ant-oat01");
  });
});

describe("GET /api/auth/status", () => {
  async function withServer(fn: (s: http.Server) => Promise<void>): Promise<void> {
    const s = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (s.listening) resolve();
      else s.on("listening", resolve);
    });
    try {
      await fn(s);
    } finally {
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  it("reports an authenticated session with its expiry", async () => {
    await withServer(async (s) => {
      const res = await request(s, "GET", "/api/auth/status");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.authenticated).toBe(true);
      expect(body.oidcEnabled).toBe(true);
      expect(typeof body.expiresAt).toBe("number");
    });
  });

  it("returns 200 (not 401) with authenticated=false when no cookie is sent", async () => {
    testSessionCookie = null;
    await withServer(async (s) => {
      const res = await request(s, "GET", "/api/auth/status");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.authenticated).toBe(false);
      expect(body.oidcEnabled).toBe(true);
    });
  });

  it("reports authenticated=false for an expired cookie", async () => {
    testSessionCookie = signSession("test-user", Date.now() - 1000, TEST_OIDC_SECRET);
    await withServer(async (s) => {
      const res = await request(s, "GET", "/api/auth/status");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.authenticated).toBe(false);
      expect(body.expiresAt).toBe(null);
    });
  });

  it("reports oidcEnabled=false when OIDC is not configured", async () => {
    ((await import("./config.js")) as Record<string, unknown>).OIDC_CLIENT_ID = "";
    await withServer(async (s) => {
      const res = await request(s, "GET", "/api/auth/status");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.oidcEnabled).toBe(false);
    });
  });
});

describe("POST /queue/refresh", () => {
  it("calls triggerJob for issue-dispatcher and pr-dispatcher and returns 200 with results", async () => {
    const sched = mockScheduler();
    const triggerSpy = vi.fn().mockReturnValue("started");
    sched.triggerJob = triggerSpy;
    const s = createServer(liveControllerClient(sched));
    await new Promise<void>((resolve) => {
      if (s.listening) resolve();
      else s.on("listening", resolve);
    });
    try {
      const res = await request(s, "POST", "/queue/refresh");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toMatchObject({
        "issue-dispatcher": "started",
        "pr-dispatcher": "started",
      });
      expect(triggerSpy).toHaveBeenCalledWith("issue-dispatcher");
      expect(triggerSpy).toHaveBeenCalledWith("pr-dispatcher");
    } finally {
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("returns 200 even when triggerJob returns already-running", async () => {
    const sched = mockScheduler();
    sched.triggerJob = vi.fn().mockReturnValue("already-running");
    const s = createServer(liveControllerClient(sched));
    await new Promise<void>((resolve) => {
      if (s.listening) resolve();
      else s.on("listening", resolve);
    });
    try {
      const res = await request(s, "POST", "/queue/refresh");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results["issue-dispatcher"]).toBe("already-running");
      expect(body.results["pr-dispatcher"]).toBe("already-running");
    } finally {
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("routes through a controller that has not answered yet", () => {
  let server: http.Server;
  const controller = {
    ...liveControllerClient(mockScheduler()),
    triggerJob: vi.fn(async () => "queued" as const),
    cancelRun: vi.fn(async () => "queued" as const),
    cancelCurrentTask: vi.fn(async () => "queued" as const),
    clearRateLimit: vi.fn(async () => "queued" as const),
  };

  beforeEach(async () => {
    server = createServer(controller);
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("POST /trigger/:job answers 202 queued", async () => {
    const res = await request(server, "POST", "/trigger/issue-worker");
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ result: "queued" });
    expect(controller.triggerJob).toHaveBeenCalledWith("issue-worker");
  });

  it("POST /cancel and POST /logs/:runId/cancel answer queued", async () => {
    expect(JSON.parse((await request(server, "POST", "/cancel")).body)).toEqual({ result: "queued" });
    const db = await import("./db.js");
    vi.mocked(db.cancelJobRunIfRunning).mockResolvedValueOnce(true);
    expect(JSON.parse((await request(server, "POST", "/logs/running-456/cancel")).body)).toEqual({ result: "queued" });
    expect(controller.cancelRun).toHaveBeenCalledWith("running-456");
  });

  it("POST /api/providers/:provider/clear-rate-limit answers 202 queued", async () => {
    const res = await request(server, "POST", "/api/providers/codex/clear-rate-limit");
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, cleared: false, result: "queued" });
    expect(controller.clearRateLimit).toHaveBeenCalledWith("codex");
  });

  it("POST /queue/refresh reports each queued trigger", async () => {
    const res = await request(server, "POST", "/queue/refresh");
    expect(JSON.parse(res.body).results).toEqual({ "issue-dispatcher": "queued", "pr-dispatcher": "queued" });
  });
});

describe("web role (#clw_01M5APX7YF3AGWHV1S1WMHJDR6)", () => {
  const STALE = { alive: false, lastSeenAt: new Date(Date.now() - 60_000).toISOString(), version: "1.2.3-test", shuttingDown: true };
  let server: http.Server;
  let upstream: http.Server | null = null;
  const seen: Array<{ method: string; url: string; cookie: string | undefined; authorization: string | undefined; body: string }> = [];

  function listening(s: http.Server): Promise<void> {
    return new Promise<void>((resolve) => {
      if (s.listening) resolve();
      else s.on("listening", resolve);
    });
  }

  async function startUpstream(): Promise<string> {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, cookie: req.headers.cookie, authorization: req.headers.authorization, body });
        res.setHeader("content-type", "application/json");
        res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
        res.end(JSON.stringify({ from: "controller" }));
      });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  }

  /** A URL nothing listens on. */
  async function deadUrl(): Promise<string> {
    const s = http.createServer();
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
  }

  function staleController() {
    return { ...liveControllerClient(mockScheduler()), heartbeat: vi.fn(async () => STALE) };
  }

  beforeEach(() => {
    seen.length = 0;
  });

  afterEach(async () => {
    setPageControllerHeartbeat(null);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = null;
  });

  it("forwards proxied routes to the controller with the caller's cookies and body", async () => {
    server = createServer(staleController(), { role: "web", controllerUrl: await startUpstream() });
    await listening(server);
    const res = await request(server, "POST", "/api/claude-auth/code?x=1", {
      headers: { "content-type": "application/json", Cookie: "claws_theme=dark" },
      body: JSON.stringify({ code: "abc" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ from: "controller" });
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/claude-auth/code?x=1", body: JSON.stringify({ code: "abc" }) });
    expect(seen[0].cookie).toContain("claws_theme=dark");
    expect(seen[0].cookie).toContain("claws_session=");

    const page = await request(server, "GET", "/whatsapp");
    expect(page.status).toBe(200);
    expect(seen[1]).toMatchObject({ method: "GET", url: "/whatsapp" });
  });

  it("forwards the completion route with its Authorization header and no dashboard auth, and no other route's", async () => {
    server = createServer(staleController(), { role: "web", controllerUrl: await startUpstream() });
    await listening(server);
    testSessionCookie = null;
    const res = await request(server, "POST", "/api/completion/org/caller", {
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/completion/org/caller", authorization: "Bearer caller-token", body: JSON.stringify({ prompt: "hi" }) });
    testSessionCookie = signSession("test-user", Date.now() + 24 * 60 * 60 * 1000, TEST_OIDC_SECRET);
    await request(server, "POST", "/api/claude-auth/code", { headers: { "content-type": "application/json", authorization: "Bearer caller-token" }, body: "{}" });
    expect(seen[1]).toMatchObject({ url: "/api/claude-auth/code", authorization: undefined });
  });

  it("refuses a completion request with no bearer token or an oversized body without forwarding", async () => {
    server = createServer(staleController(), { role: "web", controllerUrl: await startUpstream() });
    await listening(server);
    const noAuth = await request(server, "POST", "/api/completion/org/caller", { headers: { "content-type": "application/json" }, body: "{}" });
    expect(noAuth.status).toBe(401);
    const big = await request(server, "POST", "/api/completion/org/caller", {
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ prompt: "x".repeat(512 * 1024 + 1) }),
    });
    expect(big.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("does not forward a request that fails dashboard auth", async () => {
    server = createServer(staleController(), { role: "web", controllerUrl: await startUpstream() });
    await listening(server);
    testSessionCookie = null;
    const res = await request(server, "GET", "/api/codex-auth/status");
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("answers 503 Background processing is restarting when the controller is unreachable", async () => {
    server = createServer(staleController(), { role: "web", controllerUrl: await deadUrl() });
    await listening(server);
    const api = await request(server, "POST", "/api/codex-auth/start");
    expect(api.status).toBe(503);
    expect(JSON.parse(api.body).error).toBe("Background processing is restarting");
    const page = await request(server, "GET", "/whatsapp/pair");
    expect(page.status).toBe(503);
    expect(page.body).toContain("Background processing is restarting");
  });

  it("waits for a slow controller answer instead of reporting it restarting", async () => {
    upstream = http.createServer((req, res) => {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ url: "https://claude.ai/oauth" }));
      }, 300);
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    server = createServer(staleController(), { role: "web", controllerUrl: url, proxyHeadersTimeoutMs: 2_000 });
    await listening(server);
    const res = await request(server, "POST", "/api/claude-auth/start");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: "https://claude.ai/oauth" });
  });

  it("answers 504, not restarting, when a reachable controller outlasts the timeout", async () => {
    upstream = http.createServer((req, res) => {
      setTimeout(() => res.end("{}"), 500);
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    server = createServer(staleController(), { role: "web", controllerUrl: url, proxyHeadersTimeoutMs: 100 });
    await listening(server);
    const res = await request(server, "POST", "/api/claude-auth/code");
    expect(res.status).toBe(504);
    expect(JSON.parse(res.body).error).not.toBe("Background processing is restarting");
  });

  it("forwards the per-account Claude login routes to the controller", async () => {
    server = createServer(staleController(), { role: "web", controllerUrl: await startUpstream() });
    await listening(server);
    const start = await request(server, "POST", "/api/claude-auth/second/start");
    expect(start.status).toBe(200);
    const code = await request(server, "POST", "/api/claude-auth/second/code", { headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "abc" }) });
    expect(code.status).toBe(200);
    expect(seen.map((r) => r.url)).toEqual(["/api/claude-auth/second/start", "/api/claude-auth/second/code"]);
  });

  it("forwards pi's credential status to the controller", async () => {
    server = createServer(staleController(), { role: "web", controllerUrl: await startUpstream() });
    await listening(server);
    const res = await request(server, "GET", "/api/pi-auth/providers");
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/pi-auth/providers" });
  });

  it("GET /health does not wait on a stalled heartbeat read", async () => {
    const stalled = { ...liveControllerClient(mockScheduler()), heartbeat: vi.fn(() => new Promise<never>(() => {})) };
    server = createServer(stalled, { role: "web", controllerUrl: await deadUrl() });
    await listening(server);
    const res = await request(server, "GET", "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok", role: "web", controller: null });
  });

  it("reports the controller's WhatsApp, email and login state rather than its own", async () => {
    const controller = {
      ...staleController(),
      integrations: vi.fn(async () => ({
        startedAt: "2026-10-19T00:00:00.000Z",
        whatsapp: { configured: true, connected: true, pairingRequired: false },
        email: { configured: true, lastCheck: "2026-10-19T12:00:00.000Z", lastError: null },
        agentAuthExpired: { claude: true, codex: false, opencode: false, pi: false },
      })),
    };
    server = createServer(controller, { role: "web", controllerUrl: await deadUrl() });
    await listening(server);
    const providers = JSON.parse((await request(server, "GET", "/api/providers")).body);
    expect(providers.claude.authExpired).toBe(true);
    expect(providers.codex.authExpired).toBe(false);
    const status = JSON.parse((await request(server, "GET", "/api/status")).body);
    expect(status).toMatchObject({
      startedAt: "2026-10-19T00:00:00.000Z",
      whatsapp: { configured: true, connected: true },
      email: { configured: true, lastCheck: "2026-10-19T12:00:00.000Z" },
    });
  });

  it("GET /health is 200 with the role and a stale heartbeat", async () => {
    server = createServer(staleController(), { role: "web", controllerUrl: await deadUrl() });
    await listening(server);
    const res = await request(server, "GET", "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok", role: "web", controller: { alive: false, shuttingDown: true } });
  });

  it("renders the restarting banner and greys the last-known job states while the heartbeat is stale", async () => {
    server = createServer(staleController(), { role: "web", controllerUrl: await deadUrl() });
    await listening(server);
    const jobs = await request(server, "GET", "/jobs");
    expect(jobs.status).toBe(200);
    expect(jobs.body).toContain(CONTROLLER_RESTARTING_BANNER);
    expect(jobs.body).toContain('class="table-scroll controller-stale"');
    expect(jobs.body).toContain("Last known state — the background controller last reported");
    const status = await request(server, "GET", "/status");
    expect(status.body).toContain(CONTROLLER_RESTARTING_BANNER);
    expect(status.body).toContain('class="meta controller-stale"');
  });

  it("renders no banner while the controller is alive", async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await listening(server);
    const jobs = await request(server, "GET", "/jobs");
    expect(jobs.body).not.toContain(CONTROLLER_RESTARTING_BANNER);
    expect(jobs.body).not.toContain(`class="table-scroll controller-stale"`);
  });

  it("serves the controller's own handlers outside the web role", async () => {
    server = createServer(liveControllerClient(mockScheduler()), { role: "controller", controllerUrl: await startUpstream() });
    await listening(server);
    await request(server, "GET", "/api/codex-auth/status");
    expect(seen).toHaveLength(0);
  });
});

describe("OIDC login state cookie (#clw_01M5APX7YF3AGWHV1S1WMHJDR6)", () => {
  const entry = { returnTo: "/board", baseUrl: "https://auth.example.com", redirectUri: "https://claws.example.com/auth/callback" };

  it("round-trips a signed state", () => {
    const value = signOAuthState("s1", entry, Date.now() + 60_000, "secret");
    expect(verifyOAuthState(value, "s1", "secret")).toEqual(entry);
  });

  it("rejects another state, a tampered or expired value and the wrong secret", () => {
    const value = signOAuthState("s1", entry, Date.now() + 60_000, "secret");
    expect(verifyOAuthState(value, "s2", "secret")).toBeNull();
    expect(verifyOAuthState(value, "s1", "other")).toBeNull();
    expect(verifyOAuthState(`x${value}`, "s1", "secret")).toBeNull();
    expect(verifyOAuthState(signOAuthState("s1", entry, Date.now() - 1, "secret"), "s1", "secret")).toBeNull();
    expect(verifyOAuthState(undefined, "s1", "secret")).toBeNull();
  });

  it("is set by /login and required by /auth/callback, on any server instance", async () => {
    testSessionCookie = null;
    const a = createServer(liveControllerClient(mockScheduler()));
    const b = createServer(liveControllerClient(mockScheduler()));
    try {
      await Promise.all([a, b].map((s) => new Promise<void>((resolve) => (s.listening ? resolve() : s.on("listening", resolve)))));
      const login = await request(a, "GET", "/login?next=%2Fjobs");
      const setCookie = String(login.headers["set-cookie"]![0]);
      const state = new URL(login.headers.location!).searchParams.get("state")!;
      expect(setCookie).toMatch(new RegExp(`^claws_oauth_state_${state}=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=/auth/callback; Max-Age=600$`));

      const missing = await request(b, "GET", `/auth/callback?state=${state}&code=test`);
      expect(missing.status).toBe(400);

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
          .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: "u1" }) }),
      );
      const cb = await request(b, "GET", `/auth/callback?state=${state}&code=test`, { headers: { Cookie: setCookie.split(";")[0] } });
      vi.unstubAllGlobals();
      expect(cb.status).toBe(303);
      expect(cb.headers.location).toBe("/jobs");
      const cookies = (cb.headers["set-cookie"] ?? []).map(String);
      expect(cookies.some((c) => c.startsWith(`claws_oauth_state_${state}=;`) && c.includes("Max-Age=0"))).toBe(true);
      expect(cookies.some((c) => c.startsWith("claws_session="))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await Promise.all([a, b].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    }
  });

  it("keeps logins started in two tabs apart", async () => {
    testSessionCookie = null;
    const server = createServer(liveControllerClient(mockScheduler()));
    try {
      await new Promise<void>((resolve) => (server.listening ? resolve() : server.on("listening", resolve)));
      const first = await request(server, "GET", "/login?next=%2Fjobs");
      const second = await request(server, "GET", "/login?next=%2Fboard");
      const jar = [first, second].map((r) => String(r.headers["set-cookie"]![0]).split(";")[0]).join("; ");
      const state = new URL(first.headers.location!).searchParams.get("state")!;
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
          .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: "u1" }) }),
      );
      const cb = await request(server, "GET", `/auth/callback?state=${state}&code=test`, { headers: { Cookie: jar } });
      expect(cb.status).toBe(303);
      expect(cb.headers.location).toBe("/jobs");
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a state /login could not have minted", async () => {
    testSessionCookie = null;
    const server = createServer(liveControllerClient(mockScheduler()));
    try {
      await new Promise<void>((resolve) => (server.listening ? resolve() : server.on("listening", resolve)));
      const cb = await request(server, "GET", "/auth/callback?state=a%3Db&code=test", { headers: { Cookie: "claws_oauth_state_a=b" } });
      expect(cb.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("POST /jobs", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    const configMod = (await import("./config.js")) as unknown as {
      DISABLED_JOBS_BY_REPO: Record<string, string[]>;
      getLockedJobsForRepo: ReturnType<typeof vi.fn>;
    };
    delete configMod.DISABLED_JOBS_BY_REPO["org/repo"];
    delete configMod.DISABLED_JOBS_BY_REPO["gone/repo"];
    configMod.getLockedJobsForRepo.mockReturnValue([]);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("carries forward a registered-but-unlisted job name instead of dropping it (#2625)", async () => {
    const configMod = (await import("./config.js")) as unknown as {
      DISABLED_JOBS_BY_REPO: Record<string, string[]>;
    };
    configMod.DISABLED_JOBS_BY_REPO["org/repo"] = ["issue-worker"];

    const res = await request(server, "POST", "/jobs", { body: "" });
    expect(res.status).toBe(303);

    const wc = (await import("./config.js")).writeConfig as ReturnType<typeof vi.fn>;
    const written = wc.mock.calls.at(-1)![0] as { disabledJobsByRepo: Record<string, string[]> };
    expect(written.disabledJobsByRepo["org/repo"]).toContain("issue-worker");
  });

  it("drops job names that are neither a matrix column nor a registered job (#2936)", async () => {
    const configMod = (await import("./config.js")) as unknown as {
      DISABLED_JOBS_BY_REPO: Record<string, string[]>;
    };
    configMod.DISABLED_JOBS_BY_REPO["org/repo"] = ["idea-collector", "idea-reconciler", "qa-phase", "issue-worker"];

    const res = await request(server, "POST", "/jobs", { body: "" });
    expect(res.status).toBe(303);

    const wc = (await import("./config.js")).writeConfig as ReturnType<typeof vi.fn>;
    const written = wc.mock.calls.at(-1)![0] as { disabledJobsByRepo: Record<string, string[]> };
    expect(written.disabledJobsByRepo["org/repo"]).toContain("issue-worker");
    expect(written.disabledJobsByRepo["org/repo"]).not.toContain("idea-collector");
    expect(written.disabledJobsByRepo["org/repo"]).not.toContain("idea-reconciler");
    expect(written.disabledJobsByRepo["org/repo"]).not.toContain("qa-phase");
  });

  it("retires a host entry that the repo's claws.json already locks (#2936)", async () => {
    const configMod = (await import("./config.js")) as unknown as {
      DISABLED_JOBS_BY_REPO: Record<string, string[]>;
      getLockedJobsForRepo: ReturnType<typeof vi.fn>;
    };
    configMod.DISABLED_JOBS_BY_REPO["org/repo"] = ["ci-fixer", "some-unlisted-job"];
    configMod.getLockedJobsForRepo.mockImplementation((r: string) =>
      r === "org/repo" ? ["ci-fixer", "some-unlisted-job"] : [],
    );

    const res = await request(server, "POST", "/jobs", { body: "" });
    expect(res.status).toBe(303);

    const wc = (await import("./config.js")).writeConfig as ReturnType<typeof vi.fn>;
    const written = wc.mock.calls.at(-1)![0] as { disabledJobsByRepo: Record<string, string[]> };
    expect(written.disabledJobsByRepo["org/repo"] ?? []).not.toContain("ci-fixer");
    expect(written.disabledJobsByRepo["org/repo"] ?? []).not.toContain("some-unlisted-job");
  });

  it("does not write a disable for a job locked only through its claws.json alias", async () => {
    const configMod = (await import("./config.js")) as unknown as {
      getLockedJobsForRepo: ReturnType<typeof vi.fn>;
    };
    configMod.getLockedJobsForRepo.mockImplementation((r: string) =>
      r === "org/repo" ? ["logging-conventions-scanner"] : [],
    );

    const res = await request(server, "POST", "/jobs", { body: "" });
    expect(res.status).toBe(303);

    const wc = (await import("./config.js")).writeConfig as ReturnType<typeof vi.fn>;
    const written = wc.mock.calls.at(-1)![0] as { disabledJobsByRepo: Record<string, string[]> };
    expect(written.disabledJobsByRepo["org/repo"] ?? []).not.toContain("observability-contract-scanner");
  });

  it("prunes entries for repos Claws no longer monitors (#2898)", async () => {
    const configMod = (await import("./config.js")) as unknown as {
      DISABLED_JOBS_BY_REPO: Record<string, string[]>;
    };
    configMod.DISABLED_JOBS_BY_REPO["gone/repo"] = ["doc-maintainer"];

    const res = await request(server, "POST", "/jobs", { body: "" });
    expect(res.status).toBe(303);

    const wc = (await import("./config.js")).writeConfig as ReturnType<typeof vi.fn>;
    const written = wc.mock.calls.at(-1)![0] as { disabledJobsByRepo: Record<string, string[]> };
    expect(written.disabledJobsByRepo).not.toHaveProperty("gone/repo");
  });

  it("round-trips a newly-listed job name through the form", async () => {
    const pairs: string[] = [];
    for (const fullName of ["org/repo", "test/repo"]) {
      for (const job of REPO_JOB_NAMES) {
        if (fullName === "org/repo" && job === "issue-comment-spam-scanner") continue;
        pairs.push(`${encodeURIComponent(`${fullName}::${job}`)}=true`);
      }
    }
    const res = await request(server, "POST", "/jobs", { body: pairs.join("&") });
    expect(res.status).toBe(303);

    const wc = (await import("./config.js")).writeConfig as ReturnType<typeof vi.fn>;
    const written = wc.mock.calls.at(-1)![0] as { disabledJobsByRepo: Record<string, string[]> };
    expect(written.disabledJobsByRepo["org/repo"]).toEqual(["issue-comment-spam-scanner"]);
    expect(written.disabledJobsByRepo["test/repo"]).toBeUndefined();
  });
});

describe("POST /queue/merge", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 with merged result", async () => {
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("merged");
  });

  it("returns 500 when mergePR fails", async () => {
    const { mergePR: mergeFn } = await import("./github.js");
    (mergeFn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("merge conflict"));
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("merge conflict");
  });

  it("returns 403 and does not merge when the repo is not configured", async () => {
    const { listRepos: listReposFn, mergePR: mergeFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "allowed", fullName: "org/allowed" },
    ]);
    (mergeFn as ReturnType<typeof vi.fn>).mockClear();
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/unauthorized", prNumber: 42 }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain("Repository not configured");
    expect(mergeFn).not.toHaveBeenCalled();
  });

  it("returns 409 and does not merge when the PR touches infra files without confirmation (#2275)", async () => {
    const { getPRChangedFiles: getFilesFn, mergePR: mergeFn } = await import("./github.js");
    (getFilesFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(["tofu/main.tf"]);
    (mergeFn as ReturnType<typeof vi.fn>).mockClear();
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain("infrastructure");
    expect(mergeFn).not.toHaveBeenCalled();
  });

  it("merges an infra PR when confirmInfra is true", async () => {
    const { getPRChangedFiles: getFilesFn, mergePR: mergeFn } = await import("./github.js");
    (getFilesFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(["tofu/main.tf"]);
    (mergeFn as ReturnType<typeof vi.fn>).mockClear();
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42, confirmInfra: true }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result).toBe("merged");
    expect(mergeFn).toHaveBeenCalledWith("org/repo", 42);
  });

  it("returns 409 and does not merge a PR with an unmet manual action without confirmManual", async () => {
    const { mergePR: mergeFn } = await import("./github.js");
    const db = await import("./db.js");
    vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ repo: "org/repo", prNumber: 42, manualActionReason: "add the deploy key" }) as any);
    (mergeFn as ReturnType<typeof vi.fn>).mockClear();
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe("Manual action before merge: add the deploy key; reload the page and confirm");
    expect(mergeFn).not.toHaveBeenCalled();
  });

  it("merges a PR with an unmet manual action once confirmManual is true", async () => {
    const { mergePR: mergeFn } = await import("./github.js");
    const db = await import("./db.js");
    vi.mocked(db.getClawsPr).mockResolvedValue(openPrRow({ repo: "org/repo", prNumber: 42, manualActionReason: "add the deploy key" }) as any);
    (mergeFn as ReturnType<typeof vi.fn>).mockClear();
    try {
      const res = await request(server, "POST", "/queue/merge", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "org/repo", prNumber: 42, confirmManual: true }),
      });
      expect(res.status).toBe(200);
      expect(mergeFn).toHaveBeenCalledWith("org/repo", 42);
    } finally {
      vi.mocked(db.getClawsPr).mockReset().mockResolvedValue(null);
    }
  });

  // #clw_01M646SBH8GCQ592CFV4SRMVK4: a fully linked stored list needs no
  // merged-PR walk of the repo's closed PRs.
  it("GET /api/issue-phases reads a fully linked stored PR list without the merged-PR walk", async () => {
    const gh = await import("./github.js");
    const db = await import("./db.js");
    vi.mocked(gh.listMergedPRsForIssue).mockClear();
    vi.mocked(gh.getPRState).mockResolvedValue("MERGED" as any);
    vi.mocked(db.getIssuePlannedPRs).mockResolvedValueOnce([
      { position: 1, repo: "org/repo", title: "First", prNumber: 41, dependsOn: null, kind: "pr", manualAction: null },
      { position: 2, repo: "test/repo", title: "Second", prNumber: 42, dependsOn: [1], kind: "pr", manualAction: null },
    ]);
    try {
      const res = await request(server, "GET", "/api/issue-phases?repo=org/repo&issue=clw_01M48WEHRHXGQGT558WG89NRY1", { headers: { authorization: "Bearer test-internal-mcp-token" } });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.source).toBe("stored");
      expect(body.phases.map((p: { status: string }) => p.status)).toEqual(["done", "done"]);
      expect(gh.listMergedPRsForIssue).not.toHaveBeenCalled();
    } finally {
      vi.mocked(gh.getPRState).mockReset().mockResolvedValue(null);
    }
  });

  it("holds a PR of an issue with an open operator step behind confirmManual", async () => {
    const { mergePR: mergeFn } = await import("./github.js");
    const db = await import("./db.js");
    vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ repo: "org/repo", prNumber: 42, issueId: "clw_01M48WEHRHXGQGT558WG89NRY1" }) as any);
    vi.mocked(db.getIssuePlannedPRs).mockResolvedValueOnce([
      { position: 1, repo: "org/repo", title: "Move", prNumber: 42, dependsOn: null, kind: "pr", manualAction: null },
      { position: 2, repo: "org/repo", title: "actions (operator)", prNumber: null, dependsOn: [1], kind: "manual", manualAction: null },
    ]);
    mockClawsIssues.getIssue.mockResolvedValueOnce({ state: "open" } as any);
    (mergeFn as ReturnType<typeof vi.fn>).mockClear();
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain("Operator step pending: actions (operator)");
    expect(mergeFn).not.toHaveBeenCalled();
  });

  // A merge from the dashboard's Merge button runs none of the auto-merger's
  // own cleanup, so `/queue/merge` must honour `Closes #clw_…` itself —
  // immediately, not on the PR dispatcher's next tick (#3338).
  it("closes the native issue a merged claws/issue-… PR names", async () => {
    const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const { listPRs: listPRsFn, getPRBody: getPRBodyFn, removeLabel: removeLabelFn, closeIssue: closeIssueFn } = await import("./github.js");
    (listPRsFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { number: 42, title: "Fix", headRefName: `claws/issue-${NATIVE}-fix`, baseRefName: "main", labels: [], author: { login: "claws" }, body: `Closes #${NATIVE}` },
    ]);
    (getPRBodyFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(`Closes #${NATIVE}`);
    const record = {
      id: NATIVE, state: "open", kind: "issue", repos: ["org/repo"], labels: [], title: "T", body: "",
      author_login: "claws", state_reason: null, created_at: "", updated_at: "", closed_at: null,
    };
    // Read twice: once to find the issue's repo for its phase state, once to close it.
    mockClawsIssues.getIssue.mockResolvedValueOnce(record).mockResolvedValueOnce(record);

    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result).toBe("merged");
    expect(removeLabelFn).not.toHaveBeenCalled();
    expect(closeIssueFn).toHaveBeenCalledWith("org/repo", NATIVE, "completed");
  });

  it("still returns 200 merged when post-merge cleanup fails", async () => {
    const { listPRs: listPRsFn } = await import("./github.js");
    const { finalizeMergedClawsPR } = await import("./agents/auto-merger.js");
    const log = await import("./log.js");
    (listPRsFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { number: 42, title: "Fix", headRefName: "claws/issue-99-fix", baseRefName: "main", labels: [], author: { login: "claws" }, body: "" },
    ]);
    (finalizeMergedClawsPR as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));

    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result).toBe("merged");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Post-merge cleanup failed for org/repo#42"));
  });

  it("still merges when the PR-list lookup for post-merge cleanup fails", async () => {
    const { listPRs: listPRsFn, mergePR: mergeFn } = await import("./github.js");
    (listPRsFn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rate limited"));
    (mergeFn as ReturnType<typeof vi.fn>).mockClear();

    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result).toBe("merged");
    expect(mergeFn).toHaveBeenCalledWith("org/repo", 42);
  });

  // An open PR the dispatcher hasn't reached yet has no claws_prs row — the
  // approval this click records must not be silently dropped (#3399).
  it("seeds a row and records the approval for an open PR with no row yet", async () => {
    const { getPRState, listPRStatuses } = await import("./github.js");
    const db = await import("./db.js");
    vi.mocked(getPRState).mockResolvedValueOnce("OPEN");
    vi.mocked(listPRStatuses).mockResolvedValueOnce(new Map());
    vi.mocked(db.upsertClawsPr).mockClear();

    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });

    expect(res.status).toBe(200);
    expect(db.upsertClawsPr).toHaveBeenCalledWith("org/repo", 42, {
      stage: "opened",
      mergeApprovedBy: "test-user",
      mergeApprovedAt: expect.stringMatching(/Z$/),
    });
  });
});

describe("POST /queue/skip", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 and calls writeConfig", async () => {
    const res = await request(server, "POST", "/queue/skip", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 42 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("ok");
  });
});

describe("POST /queue/unskip", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 and calls writeConfig", async () => {
    const res = await request(server, "POST", "/queue/unskip", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 42 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("ok");
  });
});

describe("POST /queue/prioritize", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 and calls writeConfig", async () => {
    const res = await request(server, "POST", "/queue/prioritize", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("ok");
  });
});

describe("POST /queue/deprioritize", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 and calls writeConfig", async () => {
    const res = await request(server, "POST", "/queue/deprioritize", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("ok");
  });
});

describe("POST /blog/save", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("re-renders the edit form with the submitted content instead of redirecting on an invalid path", async () => {
    const { upsertBlogDraft } = await import("./db.js");
    vi.mocked(upsertBlogDraft).mockClear();
    const res = await request(server, "POST", "/blog/save", {
      body: "action=save&path=not-the-blog-dir%2Fpost.md&content=my+precious+draft+content&new=1",
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("my precious draft content");
    expect(res.body).toContain("Invalid file path");
    expect(upsertBlogDraft).not.toHaveBeenCalled();
  });

  it("saves and redirects for a valid path", async () => {
    const { upsertBlogDraft } = await import("./db.js");
    vi.mocked(upsertBlogDraft).mockClear();
    const res = await request(server, "POST", "/blog/save", {
      body: "action=save&path=src%2Fcontent%2Fblog%2Fpost.md&content=hello&base_sha=abc123",
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/blog/edit?path=src%2Fcontent%2Fblog%2Fpost.md&saved=1");
    expect(upsertBlogDraft).toHaveBeenCalledWith("St-John-Software/bstjohn-blog", "src/content/blog/post.md", "hello", "abc123", null, expect.any(String));
  });

  describe("action=push with an existing PR", () => {
    beforeEach(async () => {
      const { getBlogDraft } = await import("./db.js");
      const { getPRState, fetchRepoFileWithSha, createBranchRef, createPR, putRepoFile } = await import("./github.js");
      vi.mocked(getBlogDraft).mockResolvedValue(null);
      vi.mocked(getPRState).mockResolvedValue(null);
      vi.mocked(fetchRepoFileWithSha).mockResolvedValue(null);
      vi.mocked(createBranchRef).mockClear();
      vi.mocked(createPR).mockClear().mockResolvedValue(1);
      vi.mocked(putRepoFile).mockClear();
    });

    it("reuses the existing open PR branch instead of opening a new one", async () => {
      const { getBlogDraft, setBlogDraftPushed } = await import("./db.js");
      const { getPRState, fetchRepoFileWithSha, createBranchRef, createPR, putRepoFile } = await import("./github.js");
      vi.mocked(getBlogDraft).mockResolvedValue({
        repo: "St-John-Software/bstjohn-blog",
        path: "src/content/blog/post.md",
        content: "old",
        base_sha: "s",
        title: null,
        status: "draft",
        pr_number: 42,
        pr_branch: "claws/blog-post-1",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      vi.mocked(getPRState).mockResolvedValue("OPEN");
      vi.mocked(fetchRepoFileWithSha).mockResolvedValue({ content: "old", sha: "blob1" });
      vi.mocked(setBlogDraftPushed).mockClear();

      const res = await request(server, "POST", "/blog/save", {
        body: "action=push&path=src%2Fcontent%2Fblog%2Fpost.md&content=new",
      });

      expect(createBranchRef).not.toHaveBeenCalled();
      expect(createPR).not.toHaveBeenCalled();
      expect(putRepoFile).toHaveBeenCalledWith(
        "St-John-Software/bstjohn-blog",
        "claws/blog-post-1",
        "src/content/blog/post.md",
        expect.any(String),
        expect.any(String),
        "blob1",
      );
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe("/blog?pushed=42");
    });

    it("opens a fresh PR when the recorded PR is merged", async () => {
      const { getBlogDraft, clearBlogDraftPR } = await import("./db.js");
      const { getPRState, fetchRepoFileWithSha, createBranchRef, createPR } = await import("./github.js");
      vi.mocked(getBlogDraft).mockResolvedValue({
        repo: "St-John-Software/bstjohn-blog",
        path: "src/content/blog/post.md",
        content: "old",
        base_sha: "s",
        title: null,
        status: "draft",
        pr_number: 42,
        pr_branch: "claws/blog-post-1",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      vi.mocked(getPRState).mockResolvedValue("MERGED");
      vi.mocked(fetchRepoFileWithSha).mockResolvedValue(null);
      vi.mocked(clearBlogDraftPR).mockClear();

      const res = await request(server, "POST", "/blog/save", {
        body: "action=push&path=src%2Fcontent%2Fblog%2Fpost.md&content=new",
      });

      expect(clearBlogDraftPR).toHaveBeenCalledWith("St-John-Software/bstjohn-blog", "src/content/blog/post.md");
      expect(createBranchRef).toHaveBeenCalled();
      expect(createPR).toHaveBeenCalled();
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe("/blog?pushed=1");
    });

    it("skips the commit when content is unchanged", async () => {
      const { getBlogDraft } = await import("./db.js");
      const { getPRState, fetchRepoFileWithSha, putRepoFile } = await import("./github.js");
      vi.mocked(getBlogDraft).mockResolvedValue({
        repo: "St-John-Software/bstjohn-blog",
        path: "src/content/blog/post.md",
        content: "old",
        base_sha: "s",
        title: null,
        status: "draft",
        pr_number: 42,
        pr_branch: "claws/blog-post-1",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      vi.mocked(getPRState).mockResolvedValue("OPEN");
      vi.mocked(fetchRepoFileWithSha).mockResolvedValue({ content: "new", sha: "blob1" });

      const res = await request(server, "POST", "/blog/save", {
        body: "action=push&path=src%2Fcontent%2Fblog%2Fpost.md&content=new",
      });

      expect(putRepoFile).not.toHaveBeenCalled();
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe("/blog?pushed=42");
    });
  });
});

describe("blog draft routes", () => {
  let server: http.Server;
  const path = "src/content/blog/2025-01-15-gitops-homelab-flux-k3s.md";
  const encPath = encodeURIComponent(path);
  const staleDraft = {
    repo: "St-John-Software/bstjohn-blog",
    path,
    content: "old saved draft text",
    base_sha: "old-sha",
    title: null,
    status: "pushed",
    pr_number: 481,
    pr_branch: "claws/blog-gitops-1",
    updated_at: "2026-07-18T00:00:00.000Z",
  };

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    const { getBlogDraft } = await import("./db.js");
    const { getPRState, fetchRepoFileWithSha, listRepoDirectory } = await import("./github.js");
    vi.mocked(getBlogDraft).mockReset().mockReturnValue(undefined as never);
    vi.mocked(getPRState).mockReset().mockResolvedValue(null);
    vi.mocked(fetchRepoFileWithSha).mockReset().mockResolvedValue(null);
    vi.mocked(listRepoDirectory).mockReset().mockResolvedValue([]);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("POST /blog/discard deletes only the stored draft and redirects", async () => {
    const { deleteBlogDraft } = await import("./db.js");
    const { putRepoFile, createPR } = await import("./github.js");
    vi.mocked(deleteBlogDraft).mockClear();
    vi.mocked(putRepoFile).mockClear();
    vi.mocked(createPR).mockClear();
    const res = await request(server, "POST", "/blog/discard", { body: `path=${encPath}` });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/blog?discarded=2025-01-15-gitops-homelab-flux-k3s.md");
    expect(deleteBlogDraft).toHaveBeenCalledTimes(1);
    expect(deleteBlogDraft).toHaveBeenCalledWith("St-John-Software/bstjohn-blog", path);
    expect(putRepoFile).not.toHaveBeenCalled();
    expect(createPR).not.toHaveBeenCalled();
  });

  it("POST /blog/discard rejects a path outside the blog content directory", async () => {
    const { deleteBlogDraft } = await import("./db.js");
    vi.mocked(deleteBlogDraft).mockClear();
    const res = await request(server, "POST", "/blog/discard", { body: "path=..%2Fetc%2Fpasswd.md" });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/blog?error=badpath");
    expect(deleteBlogDraft).not.toHaveBeenCalled();
  });

  it("GET /blog/edit loads the repo version, not a draft whose PR is not found", async () => {
    const { getBlogDraft } = await import("./db.js");
    const { getPRState, fetchRepoFileWithSha } = await import("./github.js");
    vi.mocked(getBlogDraft).mockResolvedValue(staleDraft);
    vi.mocked(getPRState).mockResolvedValue(null);
    vi.mocked(fetchRepoFileWithSha).mockResolvedValue({ content: "current repo text from PR 41", sha: "new-sha" });

    const res = await request(server, "GET", `/blog/edit?path=${encPath}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("current repo text from PR 41");
    expect(res.body).not.toContain("old saved draft text");
    expect(res.body).toContain('name="base_sha" value="new-sha"');
    expect(res.body).toContain("Load stale draft");

    const loaded = await request(server, "GET", `/blog/edit?path=${encPath}&draft=1`);
    expect(loaded.body).toContain("old saved draft text");
    expect(loaded.body).toContain('name="base_sha" value="new-sha"');
    expect(loaded.body).toContain("Push to PR will overwrite the newer repo text");
  });

  it("GET /blog/edit loads a live draft as before", async () => {
    const { getBlogDraft } = await import("./db.js");
    const { getPRState, fetchRepoFileWithSha } = await import("./github.js");
    vi.mocked(getBlogDraft).mockResolvedValue({ ...staleDraft, status: "draft" });
    vi.mocked(getPRState).mockResolvedValue("OPEN");
    vi.mocked(fetchRepoFileWithSha).mockResolvedValue({ content: "repo text", sha: "new-sha" });

    const res = await request(server, "GET", `/blog/edit?path=${encPath}`);
    expect(res.body).toContain("old saved draft text");
    expect(res.body).not.toContain('class="warning-banner"');
    expect(res.body).toContain("/blog/discard");
  });

  it("GET /blog/diff diffs a draft with no repo file at its path against the slug-matched post", async () => {
    const { getBlogDraft } = await import("./db.js");
    const { fetchRepoFileWithSha, listRepoDirectory } = await import("./github.js");
    const draftPath = "src/content/blog/2026-07-10-homelab-sso-authentik.md";
    const pubPath = "src/content/blog/2026-07-24-homelab-sso-authentik.md";
    vi.mocked(getBlogDraft).mockResolvedValue({ ...staleDraft, path: draftPath, content: "title\nnew line", pr_number: null });
    vi.mocked(listRepoDirectory).mockResolvedValue([
      { name: "2026-07-24-homelab-sso-authentik.md", path: pubPath, sha: "s1", type: "file" },
      { name: "2026-03-16-claws.md", path: "src/content/blog/2026-03-16-claws.md", sha: "s2", type: "file" },
    ]);
    vi.mocked(fetchRepoFileWithSha).mockImplementation(async (_repo: string, p: string) =>
      p === pubPath ? { content: "title\nold line", sha: "s1" } : null);

    const res = await request(server, "GET", `/blog/diff?path=${encodeURIComponent(draftPath)}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("repo file <code>2026-07-24-homelab-sso-authentik.md</code>");
    expect(res.body).toContain('class="blog-diff-line del">- old line');
    expect(res.body).toContain('class="blog-diff-line add">+ new line');
  });

  it("GET /blog/diff redirects when there is no saved draft", async () => {
    const res = await request(server, "GET", `/blog/diff?path=${encPath}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/blog");
  });

  it("POST /blog/save clears the PR pointer of a draft whose PR merged, not one whose PR is open", async () => {
    const { getBlogDraft, clearBlogDraftPR } = await import("./db.js");
    const { getPRState } = await import("./github.js");
    vi.mocked(getBlogDraft).mockResolvedValue(staleDraft);

    vi.mocked(clearBlogDraftPR).mockClear();
    vi.mocked(getPRState).mockResolvedValue("MERGED");
    await request(server, "POST", "/blog/save", { body: `action=save&path=${encPath}&content=x` });
    expect(clearBlogDraftPR).toHaveBeenCalledWith("St-John-Software/bstjohn-blog", path);

    vi.mocked(clearBlogDraftPR).mockClear();
    vi.mocked(getPRState).mockResolvedValue("OPEN");
    await request(server, "POST", "/blog/save", { body: `action=save&path=${encPath}&content=x` });
    expect(clearBlogDraftPR).not.toHaveBeenCalled();
  });

  it("GET /blog shows open PRs on the blog repo and survives a listPRs failure", async () => {
    const { listPRs, getPRChangedFiles, listRepoDirectory } = await import("./github.js");
    vi.mocked(listRepoDirectory).mockResolvedValue([{ name: "2026-03-16-claws.md", path: "src/content/blog/2026-03-16-claws.md", sha: "s2", type: "file" }]);
    vi.mocked(listPRs).mockResolvedValueOnce([
      { number: 52, title: "Fix typo", headRefName: "b", baseRefName: "main", labels: [], author: { login: "x" } },
    ]);
    vi.mocked(getPRChangedFiles).mockResolvedValueOnce(["src/content/blog/2026-03-16-claws.md"]);
    const res = await request(server, "GET", "/blog");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Awaiting merge · PR #52");

    vi.mocked(listPRs).mockRejectedValueOnce(new Error("boom"));
    const failed = await request(server, "GET", "/blog");
    expect(failed.status).toBe(200);
    expect(failed.body).toContain("2026-03-16-claws.md");
  });
});


describe("POST /damp/reading", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 400 for a non-integer index", async () => {
    const res = await request(server, "POST", "/damp/reading", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: "not-a-number", value: "1.5", reading_date: "2026-01-01" }),
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Bad index");
  });

  it("returns 400 for an out-of-range index", async () => {
    const res = await request(server, "POST", "/damp/reading", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 9999, value: "1.5", reading_date: "2026-01-01" }),
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Bad index");
  });

  it("returns 400 for a null index instead of silently targeting index 0", async () => {
    const res = await request(server, "POST", "/damp/reading", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: null, value: "1.5", reading_date: "2026-01-01" }),
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Bad index");
  });

  it("returns 400 for a blank string index instead of silently targeting index 0", async () => {
    const res = await request(server, "POST", "/damp/reading", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: "", value: "1.5", reading_date: "2026-01-01" }),
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Bad index");
  });

  it("returns 400 for a non-finite value", async () => {
    const res = await request(server, "POST", "/damp/reading", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 0, value: "not-a-number", reading_date: "2026-01-01" }),
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Bad value");
  });

  it("deletes the stored reading and returns cleared:true for a blank value", async () => {
    const { deleteDampReading, upsertDampReading } = await import("./db.js");
    vi.mocked(deleteDampReading).mockClear();
    const res = await request(server, "POST", "/damp/reading", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 0, value: "  ", reading_date: "2026-01-01" }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, cleared: true });
    expect(deleteDampReading).toHaveBeenCalledWith("Downstairs toilet", "N", "2026-01-01");
    expect(upsertDampReading).not.toHaveBeenCalled();
  });

  it("upserts the reading and returns ok:true on the success path", async () => {
    const { upsertDampReading } = await import("./db.js");
    vi.mocked(upsertDampReading).mockClear();
    const res = await request(server, "POST", "/damp/reading", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 0, value: "1.5", reading_date: "2026-01-01" }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true });
    expect(upsertDampReading).toHaveBeenCalledWith("Downstairs toilet", "N", 1.5, "2026-01-01", expect.any(String));
  });
});

describe("Issue logs page", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /logs/issue returns 400 when repo is missing", async () => {
    const res = await request(server, "GET", "/logs/issue?number=1");
    expect(res.status).toBe(400);
  });

  it("GET /logs/issue returns 400 when number is missing", async () => {
    const res = await request(server, "GET", "/logs/issue?repo=org/repo");
    expect(res.status).toBe(400);
  });

  it("GET /logs/issue returns 400 when number is invalid", async () => {
    const res = await request(server, "GET", "/logs/issue?repo=org/repo&number=abc");
    expect(res.status).toBe(400);
  });

  it("GET /logs/issue returns 200 with empty state when no runs", async () => {
    const { listRepos: listReposFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "repo", fullName: "org/repo" },
    ]);
    const res = await request(server, "GET", "/logs/issue?repo=org/repo&number=42");
    expect(res.status).toBe(200);
    expect(res.body).toContain("No logs found for this issue");
    expect(res.body).toContain("repo#42");
  });

  it("GET /logs/issue returns 404 for an unknown repo", async () => {
    const { listRepos: listReposFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "repo", fullName: "org/repo" },
    ]);
    const res = await request(server, "GET", "/logs/issue?repo=unknown/repo&number=42");
    expect(res.status).toBe(404);
  });

  it("GET /logs/issue renders runs when present", async () => {
    const { listRepos: listReposFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "repo", fullName: "org/repo" },
    ]);
    const { getRunsForIssue: fn, getLogsForRuns: logsFn, getWorkItemsForRuns: workFn } = await import("./db.js");
    (fn as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { run_id: "run-1", job_name: "issue-worker", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
      { run_id: "run-2", job_name: "ci-fixer", status: "failed", started_at: "2025-01-01 00:02:00", completed_at: "2025-01-01 00:03:00" },
    ]);
    (logsFn as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Map([
      ["run-1", [{ id: 1, run_id: "run-1", level: "info", message: "Working on issue", logged_at: "2025-01-01 00:00:01" }]],
    ]));
    (workFn as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Map());

    const res = await request(server, "GET", "/logs/issue?repo=org/repo&number=42");
    expect(res.status).toBe(200);
    expect(res.body).toContain("repo#42");
    expect(res.body).toContain("2 runs");
    expect(res.body).toContain("issue-worker");
    expect(res.body).toContain("ci-fixer");
    expect(res.body).toContain("Working on issue");
    expect(res.body).toContain("View on Forgejo");
    expect(res.body).toContain('data-level="all"');
  });

  it("buildIssueLogsPage renders correctly with multiple runs", () => {
    const runs = [
      { run_id: "r1", job_name: "issue-worker", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
      { run_id: "r2", job_name: "ci-fixer", status: "failed", started_at: "2025-01-01 00:02:00", completed_at: "2025-01-01 00:03:00" },
    ];
    const logsByRun = new Map([
      ["r1", [{ id: 1, run_id: "r1", level: "info", message: "Hello", logged_at: "2025-01-01 00:00:01" }]],
      ["r2", [{ id: 2, run_id: "r2", level: "error", message: "Failed", logged_at: "2025-01-01 00:02:01" }]],
    ]);
    const html = buildIssueLogsPage("org/repo", 42, runs, logsByRun, new Map(), "system" as Theme);
    // First run is expanded
    expect(html).toContain("<details open>");
    // Both runs present
    expect(html).toContain("issue-worker");
    expect(html).toContain("ci-fixer");
    expect(html).toContain("Hello");
    expect(html).toContain("Failed");
    expect(html).toContain("repo#42");
    expect(html).toContain("github.com/org/repo/issues/42");
  });

  it("buildIssueLogsPage renders empty state when no runs", () => {
    const html = buildIssueLogsPage("org/repo", 42, [], new Map(), new Map(), "system" as Theme);
    expect(html).toContain("No logs found for this issue");
    expect(html).toContain('href="/jobs"');
  });

  it("buildIssueLogsPage shows live indicator for running runs", () => {
    const runs = [
      { run_id: "r1", job_name: "issue-worker", status: "running", started_at: "2025-01-01 00:00:00", completed_at: null },
    ];
    const html = buildIssueLogsPage("org/repo", 10, runs, new Map(), new Map(), "system" as Theme);
    expect(html).toContain("live — click to view");
    expect(html).toContain("/logs/r1");
  });

  it("badge links in buildLogDetailPage point to /logs/issue", () => {
    const run = { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    const logs = [{ id: 1, run_id: "r1", level: "info", message: "test", logged_at: "2025-01-01 00:00:00" }];
    const tasks = [
      { id: 1, job_name: "test-job", repo: "org/repo", item_number: 99, trigger_label: null, worktree_path: null, branch_name: null, run_id: "r1", status: "completed", error: null, started_at: "2025-01-01", completed_at: "2025-01-01" },
    ];
    const html = buildLogDetailPage(run, logs, "system" as Theme, tasks as any);
    expect(html).toContain("/logs/issue?repo=org%2Frepo&number=99");
    expect(html).not.toContain("github.com/org/repo/issues/99");
  });
});

describe("Nav operator-attention counts", () => {
  let server: http.Server;

  beforeEach(async () => {
    mockLoadOperatorAttentionCounts.mockReset();
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // Every page with the nav shows the counts, not only Issues and PRs.
  it.each(["/whatsapp", "/reauth", "/config"])("renders fresh counts in the nav on %s", async (path) => {
    mockLoadOperatorAttentionCounts.mockResolvedValueOnce({ issues: { attention: 3, total: 10 }, prs: { attention: 1, total: 4 }, sessions: 2 });
    const res = await request(server, "GET", path);
    expect(res.status).toBe(200);
    expect(res.body).toContain('aria-label="Board, 3 of 10 issues need attention"');
    expect(res.body).toContain('aria-label="PRs, 1 of 4 needs attention"');
    expect(res.body).toContain('aria-label="Sessions, 2 active"');
  });

  it("renders no counts when they could not be read", async () => {
    mockLoadOperatorAttentionCounts.mockResolvedValueOnce(undefined);
    const res = await request(server, "GET", "/whatsapp");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('class="nav-count"');
  });
});

describe("Dashboard action Slack notifications", () => {
  let server: http.Server;
  let notifyFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const slackMod = await import("./slack.js");
    notifyFn = slackMod.notify as ReturnType<typeof vi.fn>;
    notifyFn.mockClear();
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // Slack is reserved for operator attention: the operator's own dashboard
  // actions are never echoed back to them.
  it("does not notify on pause or resume", async () => {
    await request(server, "POST", "/pause/ci-fixer");
    await request(server, "POST", "/pause/ci-fixer");
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("does not notify on WhatsApp pair or unpair", async () => {
    const res = await request(server, "GET", "/whatsapp/pair");
    expect(res.status).toBe(200);
    await request(server, "POST", "/whatsapp/unpair");
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("does not notify on config save", async () => {
    await request(server, "POST", "/config", {
      body: "logRetentionDays=7&logRetentionPerJob=20&selfRepo=owner1%2Frepo1&authToken=&enabledAgent_planner=true&enabledAgent_implementer=true&enabledAgent_ci-fixer=true&enabledAgent_review-addresser=true&enabledAgent_reviewer=true&enabledAgent_merger=true",
    });
    expect(notifyFn).not.toHaveBeenCalled();
  });

  // Closing an issue is a standard operation: the audit trail is the issue's
  // closed state plus the existing log lines, not a Slack post.
  it("does not notify when a card is dropped into Done", async () => {
    const { closeIssue: closeIssueFn } = await import("./github.js");

    await request(server, "POST", "/board/move", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", ref: 42, to: "done" }),
    });
    expect(closeIssueFn).toHaveBeenCalledWith("org/repo", 42, "not_planned");
    expect(notifyFn).not.toHaveBeenCalled();
  });

  // Every other column only relabels, which the queue's own actions do without
  // notifying either.
  it("does not notify for a board move that only relabels", async () => {
    await request(server, "POST", "/board/move", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", ref: 42, to: "approved" }),
    });
    expect(notifyFn).not.toHaveBeenCalled();
  });

  // Filing an issue is routine work, not a supervised mutation.
  it("does not notify when an issue is created from the dashboard", async () => {
    await request(server, "POST", "/issues", { body: "title=New+thing" });
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("does not notify on session-lifecycle / triage actions", async () => {
    await request(server, "POST", "/queue/mark-refined", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(notifyFn).not.toHaveBeenCalled();
  });

  describe("Mark Refined Endpoint", () => {
    beforeEach(() => trackForgeIssues());
    afterEach(() => untrackForgeIssues());

    it("POST /queue/mark-refined approves the issue through Plan, writing no label", async () => {
      const { addLabel, removeQueueItem } = await import("./github.js");
      mockIssueApproval.applyIssueApproval.mockClear();
      vi.mocked(addLabel).mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/mark-refined",
        { body: JSON.stringify({ repo: "test/repo", number: 123 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("test/repo", 123, "plan", "test-user", {});
      expect(addLabel).not.toHaveBeenCalled();
      expect(removeQueueItem).toHaveBeenCalledWith("test/repo", 123);
    });

    it("POST /queue/mark-refined never lowers a Merge approval", async () => {
      mockIssueApproval.applyIssueApproval.mockClear();
      trackForgeIssues({ approved_through: "merge" });
      const res = await request(server, "POST", "/queue/mark-refined",
        { body: JSON.stringify({ repo: "test/repo", number: 124 }), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(200);
      // Approved through Plan already: nothing to write.
      expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    });

    // An issue in Drafting has no requirements, so no approval past them.
    it("POST /queue/mark-refined refuses an issue the track does not offer the Plan gate on", async () => {
      const { removeQueueItem } = await import("./github.js");
      vi.mocked(removeQueueItem).mockClear();
      mockIssueApproval.applyIssueApproval.mockClear();
      trackForgeIssues({ lifecycle: "ideas", approved_through: "none", requirements_approved_at: null });
      const res = await request(server, "POST", "/queue/mark-refined",
        { body: JSON.stringify({ repo: "test/repo", number: 125 }), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).error).toContain("Plan cannot be approved here");
      expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      expect(removeQueueItem).not.toHaveBeenCalled();
    });

    it("POST /queue/mark-refined refuses a native issue posted under a repo it does not name", async () => {
      const { removeQueueItem } = await import("./github.js");
      vi.mocked(removeQueueItem).mockClear();
      mockIssueApproval.applyIssueApproval.mockClear();
      const native = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
      mockClawsIssues.getIssue.mockImplementation(async (ref: string) => (ref === native
        ? { id: native, kind: "issue", state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning", approved_through: "requirements", requirements_approved_at: "2026-09-21 09:00:00" }
        : undefined));
      const res = await request(server, "POST", "/queue/mark-refined",
        { body: JSON.stringify({ repo: "test/repo", number: native }), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(403);
      expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      expect(removeQueueItem).not.toHaveBeenCalled();
    });

    it("POST /queue/mark-refined writes nothing for a forge issue Claws does not track yet", async () => {
      const { removeQueueItem } = await import("./github.js");
      vi.mocked(removeQueueItem).mockClear();
      mockIssueApproval.applyIssueApproval.mockClear();
      untrackForgeIssues();
      const res = await request(server, "POST", "/queue/mark-refined",
        { body: JSON.stringify({ repo: "test/repo", number: 126 }), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).error).toContain("cannot be approved here");
      expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      expect(removeQueueItem).not.toHaveBeenCalled();
    });

    it("POST /queue/mark-refined validates required fields", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-refined",
        { body: JSON.stringify({ repo: "test/repo" }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("Missing repo or number");
    });

    it("POST /queue/mark-refined handles invalid JSON", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-refined",
        { body: "invalid json", headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("error");
    });

    it("returns 403 and does not label when the repo is not configured", async () => {
      const { listRepos: listReposFn, addLabel, removeQueueItem } = await import("./github.js");
      (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { owner: "org", name: "allowed", fullName: "org/allowed" },
      ]);
      (addLabel as ReturnType<typeof vi.fn>).mockClear();
      (removeQueueItem as ReturnType<typeof vi.fn>).mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/mark-refined",
        { body: JSON.stringify({ repo: "org/unauthorized", number: 123 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toContain("Repository not configured");
      expect(addLabel).not.toHaveBeenCalled();
      expect(removeQueueItem).not.toHaveBeenCalled();
    });
  });

  describe("Priority Label Endpoint", () => {
    it("POST /queue/priority-label applies the Priority label and flips matching queue rows", async () => {
      const { addLabel } = await import("./github.js");
      const db = await import("./db.js");
      (addLabel as ReturnType<typeof vi.fn>).mockClear();
      vi.mocked(db.listQueuedWork).mockResolvedValueOnce([
        { id: 5, kind: "issue-worker", repo: "test/repo", item_number: 123 } as any,
        { id: 6, kind: "review-addresser", repo: "test/repo", item_number: 999 } as any,
      ]);
      const res = await request(
        server,
        "POST",
        "/queue/priority-label",
        { body: JSON.stringify({ repo: "test/repo", number: 123, add: true }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
      expect(addLabel).toHaveBeenCalledWith("test/repo", 123, "Priority");
      expect(db.setWorkPriority).toHaveBeenCalledWith(5, true);
      expect(db.setWorkPriority).not.toHaveBeenCalledWith(6, true);
    });

    it("POST /queue/priority-label removes the Priority label when add is false", async () => {
      const { removeLabel } = await import("./github.js");
      const db = await import("./db.js");
      (removeLabel as ReturnType<typeof vi.fn>).mockClear();
      vi.mocked(db.listQueuedWork).mockResolvedValueOnce([
        { id: 5, kind: "issue-worker", repo: "test/repo", item_number: 123 } as any,
      ]);
      const res = await request(
        server,
        "POST",
        "/queue/priority-label",
        { body: JSON.stringify({ repo: "test/repo", number: 123, add: false }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(removeLabel).toHaveBeenCalledWith("test/repo", 123, "Priority");
      expect(db.setWorkPriority).toHaveBeenCalledWith(5, false);
    });

    it("POST /queue/priority-label validates required fields", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/priority-label",
        { body: JSON.stringify({ repo: "test/repo", number: 123 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("error");
    });

    it("returns 403 and does not label when the repo is not configured", async () => {
      const { listRepos: listReposFn, addLabel } = await import("./github.js");
      (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { owner: "org", name: "allowed", fullName: "org/allowed" },
      ]);
      (addLabel as ReturnType<typeof vi.fn>).mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/priority-label",
        { body: JSON.stringify({ repo: "org/unauthorized", number: 123, add: true }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toContain("Repository not configured");
      expect(addLabel).not.toHaveBeenCalled();
    });
  });

  describe("Mark Automerge Endpoint", () => {
    afterEach(() => untrackForgeIssues());
    beforeEach(async () => {
      trackForgeIssues();
      const { ensureLabel, addLabel, removeQueueItem } = await import("./github.js");
      (ensureLabel as ReturnType<typeof vi.fn>).mockClear();
      (addLabel as ReturnType<typeof vi.fn>).mockClear();
      (removeQueueItem as ReturnType<typeof vi.fn>).mockClear();
    });

    it("POST /queue/mark-automerge approves an issue through Merge, writing no label", async () => {
      const { ensureLabel, addLabel } = await import("./github.js");
      mockIssueApproval.applyIssueApproval.mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 201 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("test/repo", 201, "merge", "test-user", {});
      expect(ensureLabel).not.toHaveBeenCalled();
      expect(addLabel).not.toHaveBeenCalled();
    });

    // A PR's approval is its row alone: no Automerge label is written on it (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F).
    it("POST /queue/mark-automerge records the session's approval on a tracked PR's row with no label", async () => {
      const { addLabel, ensureLabel } = await import("./github.js");
      const db = await import("./db.js");
      // Read twice: by the manual-action gate, then by the approval write.
      const row = openPrRow({ repo: "test/repo", prNumber: 201 }) as any;
      vi.mocked(db.getClawsPr).mockResolvedValueOnce(row).mockResolvedValueOnce(row);
      vi.mocked(db.upsertClawsPr).mockClear();

      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 201 }), headers: { "content-type": "application/json" } },
      );

      expect(res.status).toBe(200);
      expect(db.upsertClawsPr).toHaveBeenCalledWith("test/repo", 201, { mergeApprovedBy: "test-user", mergeApprovedAt: expect.stringMatching(/Z$/) });
      expect(addLabel).not.toHaveBeenCalled();
      expect(ensureLabel).not.toHaveBeenCalled();
    });

    it("POST /queue/mark-automerge keeps a reviewer-escalation Manual Action after the approval", async () => {
      const { removeLabel } = await import("./github.js");
      const db = await import("./db.js");
      const row = openPrRow({ repo: "test/repo", prNumber: 202, manualActionReason: "review escalated: round cap — x" }) as any;
      // An escalation is not an operator step, so the gate lets it through.
      vi.mocked(db.getClawsPr).mockResolvedValueOnce(row).mockResolvedValueOnce(row);
      vi.mocked(removeLabel).mockClear();
      vi.mocked(db.upsertClawsPr).mockClear();

      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 202 }), headers: { "content-type": "application/json" } },
      );

      expect(res.status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalledWith("test/repo", 202, "Manual Action");
    });

    it("POST /queue/mark-automerge refuses a PR with an unmet manual action until confirmManual", async () => {
      const { addLabel } = await import("./github.js");
      const db = await import("./db.js");
      const row = openPrRow({ repo: "test/repo", prNumber: 203, manualActionReason: "import the repo" }) as any;
      vi.mocked(db.getClawsPr).mockResolvedValueOnce(row);
      vi.mocked(db.upsertClawsPr).mockClear();

      const refused = await request(server, "POST", "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 203 }), headers: { "content-type": "application/json" } });
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.body).error).toBe("Manual action before merge: import the repo; reload the page and confirm");
      expect(addLabel).not.toHaveBeenCalled();
      expect(db.upsertClawsPr).not.toHaveBeenCalled();

      vi.mocked(db.getClawsPr).mockResolvedValueOnce(row).mockResolvedValueOnce(row);
      const confirmed = await request(server, "POST", "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 203, confirmManual: true }), headers: { "content-type": "application/json" } });
      expect(confirmed.status).toBe(200);
      expect(db.upsertClawsPr).toHaveBeenCalledWith("test/repo", 203, expect.objectContaining({ mergeApprovedBy: "test-user" }));
      expect(addLabel).not.toHaveBeenCalled();
    });

    // An open PR the dispatcher hasn't reached yet (or a repo with the dispatcher
    // disabled) has no claws_prs row at all — the approval must not be dropped.
    it("POST /queue/mark-automerge seeds a row and records the approval for an open PR with no row yet", async () => {
      const { getPRState, listPRStatuses } = await import("./github.js");
      const db = await import("./db.js");
      vi.mocked(getPRState).mockResolvedValueOnce("OPEN");
      vi.mocked(listPRStatuses).mockResolvedValueOnce(new Map());
      vi.mocked(db.upsertClawsPr).mockClear();

      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 201 }), headers: { "content-type": "application/json" } },
      );

      expect(res.status).toBe(200);
      expect(db.upsertClawsPr).toHaveBeenCalledWith("test/repo", 201, {
        stage: "opened",
        mergeApprovedBy: "test-user",
        mergeApprovedAt: expect.stringMatching(/Z$/),
      });
    });

    // A numeric ref that isn't an open PR (an issue number, or a closed/merged PR)
    // must not have a row fabricated for it.
    it("POST /queue/mark-automerge does not seed a row for a number that is not an open PR", async () => {
      const { getPRState } = await import("./github.js");
      const db = await import("./db.js");
      vi.mocked(getPRState).mockResolvedValueOnce("CLOSED");
      vi.mocked(db.upsertClawsPr).mockClear();

      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 201 }), headers: { "content-type": "application/json" } },
      );

      expect(res.status).toBe(200);
      expect(db.upsertClawsPr).not.toHaveBeenCalled();
    });

    // A failed seed must surface as a failed response, not "ok" with the
    // approval silently dropped.
    it("POST /queue/mark-automerge returns 500 and skips the label when seeding the row fails", async () => {
      const { getPRState, listPRStatuses, addLabel } = await import("./github.js");
      const db = await import("./db.js");
      vi.mocked(getPRState).mockResolvedValueOnce("OPEN");
      vi.mocked(listPRStatuses).mockResolvedValueOnce(new Map());
      vi.mocked(db.upsertClawsPr).mockRejectedValueOnce(new Error("db down"));
      vi.mocked(addLabel).mockClear();

      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 201 }), headers: { "content-type": "application/json" } },
      );

      expect(res.status).toBe(500);
      expect(addLabel).not.toHaveBeenCalled();
    });

    it("POST /queue/mark-automerge with alsoRefine approves through Merge in one write and removes the queue item", async () => {
      const { addLabel, removeQueueItem } = await import("./github.js");
      mockIssueApproval.applyIssueApproval.mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 202, alsoRefine: true }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledTimes(1);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("test/repo", 202, "merge", "test-user", {});
      expect(addLabel).not.toHaveBeenCalled();
      expect(removeQueueItem).toHaveBeenCalledWith("test/repo", 202);
    });

    it("POST /queue/mark-automerge without alsoRefine approves through Merge and does not remove the queue item", async () => {
      const { removeQueueItem } = await import("./github.js");
      mockIssueApproval.applyIssueApproval.mockClear();
      await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 203 }), headers: { "content-type": "application/json" } },
      );
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledTimes(1);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("test/repo", 203, "merge", "test-user", {});
      expect(removeQueueItem).not.toHaveBeenCalled();
    });

    it("POST /queue/mark-automerge refuses an issue in Drafting, keeping its queue item", async () => {
      const { removeQueueItem } = await import("./github.js");
      mockIssueApproval.applyIssueApproval.mockClear();
      trackForgeIssues({ lifecycle: "ideas", approved_through: "none", requirements_approved_at: null });
      const res = await request(server, "POST", "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 204, alsoRefine: true }), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(409);
      expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      expect(removeQueueItem).not.toHaveBeenCalled();
    });

    it("POST /queue/mark-automerge writes nothing for a forge issue Claws does not track yet", async () => {
      const { removeQueueItem } = await import("./github.js");
      mockIssueApproval.applyIssueApproval.mockClear();
      untrackForgeIssues();
      const res = await request(server, "POST", "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 205, alsoRefine: true }), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).error).toContain("cannot be approved here");
      expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      expect(removeQueueItem).not.toHaveBeenCalled();
    });

    it("POST /queue/mark-automerge validates required fields", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo" }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("Missing repo or number");
    });

    it("returns 403 and does not label when the repo is not configured", async () => {
      const { listRepos: listReposFn, ensureLabel, addLabel } = await import("./github.js");
      (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { owner: "org", name: "allowed", fullName: "org/allowed" },
      ]);
      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "org/unauthorized", number: 201 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toContain("Repository not configured");
      expect(ensureLabel).not.toHaveBeenCalled();
      expect(addLabel).not.toHaveBeenCalled();
    });
  });

  describe("Problematic PR Endpoints", () => {
    it("POST /queue/mark-problematic marks a PR as problematic", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-problematic",
        { body: JSON.stringify({ repo: "test/repo", number: 123 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
    });

    it("POST /queue/mark-problematic validates required fields", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-problematic",
        { body: JSON.stringify({ repo: "test/repo" }), headers: { "content-type": "application/json" } }, // Missing number
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("Missing repo or number");
    });

    it("POST /queue/mark-problematic handles invalid JSON", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-problematic",
        { body: "invalid json", headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("error");
    });

    it("returns 403 and does not label when the repo is not configured", async () => {
      const { listRepos: listReposFn, addLabel } = await import("./github.js");
      (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { owner: "org", name: "allowed", fullName: "org/allowed" },
      ]);
      (addLabel as ReturnType<typeof vi.fn>).mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/mark-problematic",
        { body: JSON.stringify({ repo: "org/unauthorized", number: 123 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toContain("Repository not configured");
      expect(addLabel).not.toHaveBeenCalled();
    });

    it("POST /queue/unmark-problematic unmarks a PR", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/unmark-problematic",
        { body: JSON.stringify({ repo: "test/repo", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
    });

    it("POST /queue/unmark-problematic validates required fields", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/unmark-problematic",
        { body: JSON.stringify({ repo: "test/repo" }), headers: { "content-type": "application/json" } }, // Missing number
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("Missing repo or number");
    });

    it("POST /queue/unmark-problematic handles invalid JSON", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/unmark-problematic",
        { body: "invalid json", headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("error");
    });

    it("returns 500 and does not reset the breaker grants when the removal is unconfirmed", async () => {
      const { listRepos: listReposFn, removeLabel } = await import("./github.js");
      const { resetCIFixerBreakerGrants } = await import("./db.js");
      (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { owner: "org", name: "allowed", fullName: "org/allowed" },
      ]);
      (removeLabel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      (resetCIFixerBreakerGrants as ReturnType<typeof vi.fn>).mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/unmark-problematic",
        { body: JSON.stringify({ repo: "org/allowed", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toContain("Failed to remove");
      expect(resetCIFixerBreakerGrants).not.toHaveBeenCalled();
    });

    it("returns 403 and does not remove the label when the repo is not configured", async () => {
      const { listRepos: listReposFn, removeLabel } = await import("./github.js");
      (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { owner: "org", name: "allowed", fullName: "org/allowed" },
      ]);
      (removeLabel as ReturnType<typeof vi.fn>).mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/unmark-problematic",
        { body: JSON.stringify({ repo: "org/unauthorized", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toContain("Repository not configured");
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it("POST /queue/unmark-problematic returns 500 when the forge label clears but its row write fails", async () => {
      const { removeLabel } = await import("./github.js");
      (removeLabel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("could not mirror label Claws Problematic removed: db down"));
      const res = await request(
        server,
        "POST",
        "/queue/unmark-problematic",
        { body: JSON.stringify({ repo: "test/repo", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toContain("db down");
    });

    it("POST /queue/clear-manual-action clears the row's hold, with no forge label (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK)", async () => {
      const { removeLabel, commentOnIssue } = await import("./github.js");
      const db = await import("./db.js");
      (removeLabel as ReturnType<typeof vi.fn>).mockClear();
      vi.mocked(commentOnIssue).mockClear();
      vi.mocked(db.upsertClawsPr).mockClear();
      vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ repo: "test/repo", prNumber: 456, manualActionReason: "set secrets" }) as any).mockResolvedValueOnce(openPrRow({ repo: "test/repo", prNumber: 456, manualActionReason: "set secrets" }) as any);
      const res = await request(
        server,
        "POST",
        "/queue/clear-manual-action",
        { body: JSON.stringify({ repo: "test/repo", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ result: "ok" });
      expect(db.upsertClawsPr).toHaveBeenCalledWith("test/repo", 456, { manualActionReason: null });
      expect(removeLabel).not.toHaveBeenCalled();
      // One audit comment on the PR names the cleared reason (#clw_01M5220Y7EWQG1X0H3Y3T45J81).
      expect(commentOnIssue).toHaveBeenCalledTimes(1);
      expect(commentOnIssue).toHaveBeenCalledWith("test/repo", 456, expect.stringContaining("set secrets"));
    });

    it("POST /queue/clear-manual-action posts no audit comment when the PR has no hold", async () => {
      const { commentOnIssue } = await import("./github.js");
      const db = await import("./db.js");
      vi.mocked(commentOnIssue).mockClear();
      vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ repo: "test/repo", prNumber: 456, manualActionReason: null }) as any);
      const res = await request(
        server,
        "POST",
        "/queue/clear-manual-action",
        { body: JSON.stringify({ repo: "test/repo", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(commentOnIssue).not.toHaveBeenCalled();
    });

    it("POST /queue/clear-manual-action validates required fields", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/clear-manual-action",
        { body: JSON.stringify({ repo: "test/repo" }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("Missing repo or number");
    });

    it("POST /queue/clear-manual-action returns 403 without removing the label when the repo is not configured", async () => {
      const { listRepos: listReposFn, removeLabel } = await import("./github.js");
      (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { owner: "org", name: "allowed", fullName: "org/allowed" },
      ]);
      (removeLabel as ReturnType<typeof vi.fn>).mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/clear-manual-action",
        { body: JSON.stringify({ repo: "org/unauthorized", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(403);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it("POST /queue/clear-manual-action returns 500 when the row write fails", async () => {
      const db = await import("./db.js");
      vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ repo: "test/repo", prNumber: 456, manualActionReason: "set secrets" }) as any).mockResolvedValueOnce(openPrRow({ repo: "test/repo", prNumber: 456, manualActionReason: "set secrets" }) as any);
      vi.mocked(db.upsertClawsPr).mockRejectedValueOnce(new Error("db down"));
      const res = await request(
        server,
        "POST",
        "/queue/clear-manual-action",
        { body: JSON.stringify({ repo: "test/repo", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toContain("db down");
    });
  });
});

describe("HTTP server with OIDC auth", () => {
  let server: http.Server;
  const OIDC_SECRET = "test-oidc-client-secret";

  // Mirrors the signSession function in server.ts
  function signSession(sub: string, expiresAt: number, secret: string): string {
    const payload = `${sub}|${expiresAt}`;
    const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return `${payload}|${hmac}`;
  }

  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "test-client-id";
    (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = OIDC_SECRET;
    (configMod as Record<string, unknown>).OIDC_BASE_URL = "https://auth.example.com";
    (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "claws";
    // This suite supplies its own credentials; opt out of the global session injection.
    testSessionCookie = null;
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "";
    (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = "";
    (configMod as Record<string, unknown>).OIDC_BASE_URL = "";
    (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "";
    (configMod as Record<string, unknown>).OIDC_HOST_MAP = {};
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET / redirects to /board with a valid claws_session cookie", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour from now
    const sessionValue = signSession("user|with|pipes", expiresAt, OIDC_SECRET);
    const res = await request(server, "GET", "/", {
      headers: { Cookie: `claws_session=${encodeURIComponent(sessionValue)}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/board");
  });

  it("GET / returns 401 with a tampered claws_session cookie", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const sessionValue = signSession("user123", expiresAt, OIDC_SECRET);
    // Flip the last character of the HMAC to tamper with it
    const tampered = sessionValue.slice(0, -1) + (sessionValue.endsWith("a") ? "b" : "a");
    const res = await request(server, "GET", "/", {
      headers: { Cookie: `claws_session=${encodeURIComponent(tampered)}` },
    });
    expect(res.status).toBe(401);
  });

  it("GET / returns 401 with an expired claws_session cookie", async () => {
    const expiresAt = Date.now() - 1000; // already expired
    const sessionValue = signSession("user123", expiresAt, OIDC_SECRET);
    const res = await request(server, "GET", "/", {
      headers: { Cookie: `claws_session=${encodeURIComponent(sessionValue)}` },
    });
    expect(res.status).toBe(401);
  });

  it("GET / returns 401 with no session cookie in OIDC mode", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(401);
  });

  // Regression tests for issue #1326: backslash open-redirect via next= parameter.
  // These tests complete the full OAuth round-trip so the assertion actually verifies
  // that the sanitized returnTo value ("/" not "/\evil.example") is used on callback.
  it("backslash in next= is sanitized: final redirect goes to /", async () => {
    const loginRes = await request(server, "GET", "/login?next=%2F%5Cevil.example");
    expect(loginRes.status).toBe(302);
    const authUrl = new URL(loginRes.headers.location!);
    const state = authUrl.searchParams.get("state")!;
    const stateCookie = String(loginRes.headers["set-cookie"]![0]).split(";")[0];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: "u1", email: "u@example.com" }) }),
    );
    const cb = await request(server, "GET", `/auth/callback?state=${state}&code=test`, { headers: { Cookie: stateCookie } });
    vi.unstubAllGlobals();
    expect(cb.headers.location).toBe("/");
  });

  it("double-slash in next= is sanitized: final redirect goes to /", async () => {
    const loginRes = await request(server, "GET", "/login?next=%2F%2Fevil.example");
    expect(loginRes.status).toBe(302);
    const authUrl = new URL(loginRes.headers.location!);
    const state = authUrl.searchParams.get("state")!;
    const stateCookie = String(loginRes.headers["set-cookie"]![0]).split(";")[0];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: "u1", email: "u@example.com" }) }),
    );
    const cb = await request(server, "GET", `/auth/callback?state=${state}&code=test`, { headers: { Cookie: stateCookie } });
    vi.unstubAllGlobals();
    expect(cb.headers.location).toBe("/");
  });

  it("GET /login?next=/issues/123 redirects to OIDC (benign path accepted)", async () => {
    const res = await request(server, "GET", "/login?next=%2Fissues%2F123");
    expect(res.status).toBe(302);
    const location = res.headers.location ?? "";
    expect(location).toContain("auth.example.com");
  });

  it("GET /login authorize URL omits the application slug (Authentik slug-less)", async () => {
    const res = await request(server, "GET", "/login");
    expect(res.status).toBe(302);
    const location = res.headers.location ?? "";
    expect(location).toContain("/application/o/authorize/");
    expect(location).not.toContain("/application/o/claws/authorize/");
    expect(location).toContain("client_id=test-client-id");
  });

  // Regression tests for issue #2841: an externally-reached dashboard must not
  // bounce to an internal-only Authentik host.
  describe("OIDC_HOST_MAP (#2841)", () => {
    beforeEach(async () => {
      const configMod = await import("./config.js");
      (configMod as Record<string, unknown>).OIDC_HOST_MAP = {
        "claws.ext.example.com": "https://auth.ext.example.com",
      };
    });

    afterEach(async () => {
      const configMod = await import("./config.js");
      (configMod as Record<string, unknown>).OIDC_HOST_MAP = {};
    });

    it("uses the mapped Authentik host and derives redirect_uri when X-Forwarded-Host matches", async () => {
      const res = await request(server, "GET", "/login", {
        headers: { "X-Forwarded-Host": "claws.ext.example.com" },
      });
      expect(res.status).toBe(302);
      const location = res.headers.location ?? "";
      expect(location.startsWith("https://auth.ext.example.com/application/o/authorize/")).toBe(true);
      expect(location).toContain("redirect_uri=https%3A%2F%2Fclaws.ext.example.com%2Fauth%2Fcallback");
    });

    it("strips the port from X-Forwarded-Host before matching the map", async () => {
      const res = await request(server, "GET", "/login", {
        headers: { "X-Forwarded-Host": "claws.ext.example.com:443" },
      });
      expect(res.status).toBe(302);
      const location = res.headers.location ?? "";
      expect(location.startsWith("https://auth.ext.example.com/application/o/authorize/")).toBe(true);
      expect(location).toContain("redirect_uri=https%3A%2F%2Fclaws.ext.example.com%2Fauth%2Fcallback");
    });

    it("falls back to the default Authentik host when no forwarded header is present", async () => {
      const res = await request(server, "GET", "/login");
      expect(res.status).toBe(302);
      const location = res.headers.location ?? "";
      expect(location.startsWith("https://auth.example.com/application/o/authorize/")).toBe(true);
    });

    it("falls back to the default Authentik host for an unmapped X-Forwarded-Host (no open redirect)", async () => {
      const res = await request(server, "GET", "/login", {
        headers: { "X-Forwarded-Host": "evil.example.com" },
      });
      expect(res.status).toBe(302);
      const location = res.headers.location ?? "";
      expect(location.startsWith("https://auth.example.com/application/o/authorize/")).toBe(true);
    });

    describe("unmapped-host warning", () => {
      beforeEach(async () => {
        const configMod = await import("./config.js");
        (configMod as Record<string, unknown>).OIDC_REDIRECT_URI = "https://claws.home.example.com/auth/callback";
        const logMod = await import("./log.js");
        vi.mocked(logMod.warn).mockClear();
      });

      afterEach(async () => {
        const configMod = await import("./config.js");
        (configMod as Record<string, unknown>).OIDC_REDIRECT_URI = "";
      });

      it("warns once when a login arrives on a host that is neither mapped nor the redirect-URI host", async () => {
        const logMod = await import("./log.js");
        const host = `claws-unmapped-${crypto.randomBytes(4).toString("hex")}.example.com`;
        await request(server, "GET", "/login", { headers: { "X-Forwarded-Host": host } });
        await request(server, "GET", "/login", { headers: { "X-Forwarded-Host": host } });
        const warnings = vi.mocked(logMod.warn).mock.calls.map((call) => String(call[0])).filter((m) => m.includes(host));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("oidcHostMap");
        expect(warnings[0]).toContain(`https://${host}/auth/callback`);
      });

      it("does not warn for a mapped host or for the redirect-URI host", async () => {
        const logMod = await import("./log.js");
        await request(server, "GET", "/login", { headers: { "X-Forwarded-Host": "claws.ext.example.com" } });
        await request(server, "GET", "/login", { headers: { "X-Forwarded-Host": "claws.home.example.com:443" } });
        const warnings = vi.mocked(logMod.warn).mock.calls.map((call) => String(call[0])).filter((m) => m.includes("[oidc]"));
        expect(warnings).toHaveLength(0);
      });
    });
  });
});

describe("GET /api/grafana-auth/token/:cluster", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns a 1-hour JWT for the dashboard session", async () => {
    const { mintGrafanaJwt } = await import("./grafana-jwt.js");
    const before = Date.now();
    const result = await request(server, "GET", "/api/grafana-auth/token/prod");
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(result.body);
    expect(body.token).toBe("eyJtest.prod.sig");
    expect(vi.mocked(mintGrafanaJwt)).toHaveBeenCalledWith("prod", 60 * 60 * 1000, expect.any(Number));
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it("404s an unknown cluster", async () => {
    expect((await request(server, "GET", "/api/grafana-auth/token/staging")).status).toBe(404);
  });

  it("401s without a session", async () => {
    testSessionCookie = null;
    expect((await request(server, "GET", "/api/grafana-auth/token/fleet")).status).toBe(401);
  });
});

describe("requireApiAuth — MCP token decoupling", () => {
  let server: http.Server;

  beforeEach(async () => {
    // This suite exercises the MCP token path with no session present.
    testSessionCookie = null;
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it.each(["/api/runtime/status", "/api/runtime/jobs"])("authenticates %s and returns runtime data", async (path) => {
    for (const headers of [{}, { Authorization: "Bearer wrong-token" }] as Record<string, string>[]) {
      expect((await request(server, "GET", path, { headers })).status).toBe(401);
    }
    const result = await request(server, "GET", path, { headers: { Authorization: "Bearer test-internal-mcp-token" } });
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.activationState).toBe("active");
    if (path.endsWith("status")) {
      expect(body.workQueue).toMatchObject({ pending: 2, active: 1, workers: 4 });
    } else {
      expect(body.repositoryJobExclusions).toEqual([
        { repo: "org/repo", job: "doc-maintainer", hostDisabled: true, repositoryDisabled: false },
      ]);
      expect(body.jobs).toEqual(expect.arrayContaining([expect.objectContaining({
        name: "ci-fixer", latestRun: expect.objectContaining({ status: "failed" }),
      })]));
    }
  });

  it.each(["/api/runtime/status", "/api/runtime/jobs"])("returns the underlying JSON failure from %s", async (path) => {
    if (path.endsWith("status")) {
      const worker = await import("./worker.js");
      vi.mocked(worker.workerStatus).mockRejectedValueOnce(new Error("worker database unavailable"));
    } else {
      const db = await import("./db.js");
      vi.mocked(db.getLatestRunIdsByJob).mockRejectedValueOnce(new Error("scheduler database unavailable"));
    }
    const result = await request(server, "GET", path, { headers: { Authorization: "Bearer test-internal-mcp-token" } });
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ error: path.endsWith("status") ? "worker database unavailable" : "scheduler database unavailable" });
  });

  it("authenticates /api/runtime/latency and lists the route just requested by its pattern", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong-token" }] as Record<string, string>[]) {
      expect((await request(server, "GET", "/api/runtime/latency", { headers })).status).toBe(401);
    }
    const auth = { headers: { Authorization: "Bearer test-internal-mcp-token" } };
    expect((await request(server, "GET", "/api/runtime/status", auth)).status).toBe(200);
    const result = await request(server, "GET", "/api/runtime/latency", auth);
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.version).toBe("1.2.3-test");
    expect(body.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "/api/runtime/status", method: "GET", count: expect.any(Number), p50Ms: expect.any(Number), p95Ms: expect.any(Number) }),
    ]));
  });

  it("serves the Grafana JWKS without auth", async () => {
    const result = await request(server, "GET", "/.well-known/claws-jwks.json");
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("max-age=300");
    expect(JSON.parse(result.body).keys).toEqual([expect.objectContaining({ kty: "RSA", alg: "RS256", kid: "test-kid" })]);
  });

  it("turns a valid pages read token into a pages-host cookie, only on the pages host", async () => {
    const ok = await request(server, "GET", "/__claws/login/s1.good", { headers: { Host: "pages.example.test" } });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe("/");
    expect(ok.headers["set-cookie"]).toEqual(["claws_pages_token=s1.good; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800"]);
    expect((await request(server, "GET", "/__claws/login/s1.bad", { headers: { Host: "pages.example.test" } })).status).toBe(401);
    const wrongHost = await request(server, "GET", "/__claws/login/s1.good", { headers: { Host: "claws.example.test" } });
    expect(wrongHost.status).toBe(404);
    expect(wrongHost.headers["set-cookie"]).toBeUndefined();
  });

  it("answers Traefik's pages ForwardAuth from a bearer or cookie token, only for the pages host", async () => {
    const fwd = { "X-Forwarded-Host": "pages.example.test" };
    expect((await request(server, "GET", "/api/pages/auth", { headers: { ...fwd, Authorization: "Bearer s1.good" } })).status).toBe(204);
    expect((await request(server, "GET", "/api/pages/auth", { headers: { ...fwd, Cookie: "a=b; claws_pages_token=s1.good" } })).status).toBe(204);
    expect((await request(server, "GET", "/api/pages/auth", { headers: { ...fwd, Authorization: "Bearer s1.bad" } })).status).toBe(401);
    expect((await request(server, "GET", "/api/pages/auth", { headers: fwd })).status).toBe(401);
    for (const host of ["claws.example.test", "git.example.test"]) {
      expect((await request(server, "GET", "/api/pages/auth", { headers: { "X-Forwarded-Host": host, Authorization: "Bearer s1.good" } })).status).toBe(404);
    }
    expect((await request(server, "GET", "/api/pages/auth", { headers: { Authorization: "Bearer s1.good" } })).status).toBe(404);
  });

  it("refuses the Grafana token route to agent bearer tokens", async () => {
    for (const headers of [{}, { Authorization: "Bearer test-internal-mcp-token" }] as Record<string, string>[]) {
      expect((await request(server, "GET", "/api/grafana-auth/token/fleet", { headers })).status).toBe(401);
    }
  });

  it("does not serve /metrics on the dashboard port", async () => {
    expect((await request(server, "GET", "/metrics")).status).toBe(404);
  });

  it("accepts INTERNAL_MCP_TOKEN on /api/state when no session is present", async () => {
    const res = await request(server, "GET", "/api/state", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(200);
  });

  it("accepts a running agent pod's MCP token on /api/state", async () => {
    const res = await request(server, "GET", "/api/state", {
      headers: { Authorization: "Bearer agent-pod-token" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 on /api/state with wrong token", async () => {
    const res = await request(server, "GET", "/api/state", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns the current event cursor on /api/events with timeout=0", async () => {
    // Events live in `claws_events`; this opens an in-memory store for it.
    await (await import("./github-events.js")).resetGitHubEventsForTest();
    const res = await request(server, "GET", "/api/events?timeout=0", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.bootId).toBe("db");
    expect(typeof body.lastId).toBe("number");
    expect(body.restarted).toBe(false);
    expect(body.events).toEqual([]);
  });

  it("accepts the requirements-stored and stage-changed kinds on /api/events and filters them by item", async () => {
    const { recordGitHubEvent, resetGitHubEventsForTest } = await import("./github-events.js");
    await resetGitHubEventsForTest();
    const auth = { Authorization: "Bearer test-internal-mcp-token" };
    const cursor = JSON.parse((await request(server, "GET", "/api/events?timeout=0", { headers: auth })).body).lastId;
    recordGitHubEvent({ kind: "requirements-stored", repo: "org/repo", number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", related: [], detail: "v1" });
    recordGitHubEvent({ kind: "stage-changed", repo: "org/repo", number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD", related: [], detail: "ideas->planning" });
    recordGitHubEvent({ kind: "stage-changed", repo: "org/repo", number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", related: [], detail: "ideas->planning" });
    recordGitHubEvent({ kind: "label-added", repo: "org/repo", number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", related: [], detail: "Ready" });

    const res = await request(server, "GET", `/api/events?timeout=0&after=${cursor}&items=clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC&kinds=requirements-stored,stage-changed`, { headers: auth });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).events.map((e: any) => [e.kind, e.detail])).toEqual([["requirements-stored", "v1"], ["stage-changed", "ideas->planning"]]);
  });

  it("filters /api/events on kind:detail entries beside bare kinds (#clw_01M5Q66MKK4WHBJ8XT1EMZZGEA)", async () => {
    const { recordGitHubEvent, resetGitHubEventsForTest } = await import("./github-events.js");
    await resetGitHubEventsForTest();
    const auth = { Authorization: "Bearer test-internal-mcp-token" };
    const cursor = JSON.parse((await request(server, "GET", "/api/events?timeout=0", { headers: auth })).body).lastId;
    recordGitHubEvent({ kind: "task-completed", repo: "org/repo", number: 5, related: [], detail: "pr-merger" });
    recordGitHubEvent({ kind: "task-completed", repo: "org/repo", number: 5, related: [], detail: "pr-reviewer" });
    recordGitHubEvent({ kind: "pr-ready-to-merge", repo: "org/repo", number: 5, related: [], detail: "abc" });

    const kinds = encodeURIComponent("task-completed:pr-reviewer,pr-ready-to-merge");
    const res = await request(server, "GET", `/api/events?timeout=0&after=${cursor}&kinds=${kinds}`, { headers: auth });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).events.map((e: any) => [e.kind, e.detail])).toEqual([["task-completed", "pr-reviewer"], ["pr-ready-to-merge", "abc"]]);
  });

  it("accepts kinds=ci-status:failing on /api/events and still rejects an unknown kind", async () => {
    await (await import("./github-events.js")).resetGitHubEventsForTest();
    const auth = { Authorization: "Bearer test-internal-mcp-token" };
    expect((await request(server, "GET", `/api/events?timeout=0&kinds=${encodeURIComponent("ci-status:failing,forge-review")}`, { headers: auth })).status).toBe(200);
    expect((await request(server, "GET", "/api/events?timeout=0&kinds=ci-statuses", { headers: auth })).status).toBe(400);
  });

  describe("POST /webhooks/forgejo", () => {
    const SECRET = "test-webhook-secret";
    const comment = JSON.stringify({
      action: "created",
      issue: { number: 7, title: "t", body: "" },
      comment: { body: "Looks good, see #clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC" },
      repository: { full_name: "org/repo" },
      sender: { login: "alice" },
    });
    const sign = (body: string, secret = SECRET) => crypto.createHmac("sha256", secret).update(body).digest("hex");
    const deliver = (body: string, headers: Record<string, string>) =>
      request(server, "POST", "/webhooks/forgejo", { headers: { "content-type": "application/json", ...headers }, body });

    beforeEach(async () => {
      forgejoWebhookState.secret = SECRET;
      await (await import("./github-events.js")).resetGitHubEventsForTest();
    });

    afterEach(() => {
      forgejoWebhookState.secret = "";
    });

    it("answers 404 when no webhook secret is configured", async () => {
      forgejoWebhookState.secret = "";
      const res = await deliver(comment, { "x-forgejo-event": "issue_comment", "x-forgejo-signature": sign(comment) });
      expect(res.status).toBe(404);
    });

    it("answers 401 and records nothing for a bad or missing signature", async () => {
      const { getEventsSince } = await import("./github-events.js");
      expect((await deliver(comment, { "x-forgejo-event": "issue_comment", "x-forgejo-signature": sign(comment, "wrong") })).status).toBe(401);
      expect((await deliver(comment, { "x-forgejo-event": "issue_comment" })).status).toBe(401);
      expect(await getEventsSince(0, {})).toEqual([]);
    });

    it("records a signed human comment as a forge-comment event", async () => {
      const res = await deliver(comment, { "x-forgejo-event": "issue_comment", "x-forgejo-signature": sign(comment) });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, events: 1 });
      const { getEventsSince } = await import("./github-events.js");
      const events = await getEventsSince(0, { kinds: ["forge-comment"] });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "forge-comment", repo: "org/repo", number: 7, related: ["clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"], detail: "alice" });
    });

    it("answers 202 with no event for a repo that is not a managed Forgejo repo", async () => {
      vi.mocked((await import("./github.js")).listRepos).mockResolvedValueOnce([]);
      const res = await deliver(comment, { "x-forgejo-event": "issue_comment", "x-forgejo-signature": sign(comment) });
      expect(res.status).toBe(202);
      expect(JSON.parse(res.body)).toEqual({ ok: true, events: 0 });
    });

    it("answers 400 for malformed JSON or a missing event header", async () => {
      expect((await deliver("{", { "x-forgejo-event": "issue_comment", "x-forgejo-signature": sign("{") })).status).toBe(400);
      expect((await deliver(comment, { "x-forgejo-signature": sign(comment) })).status).toBe(400);
    });
  });

  it.each([
    ["bogus:x", 'unknown event kind "bogus"'],
    ["bogus", 'unknown event kind "bogus"'],
    ["task-failed:", 'empty detail in event kind "task-failed:"'],
  ])("rejects kinds=%s on /api/events", async (kinds, error) => {
    const res = await request(server, "GET", `/api/events?timeout=0&kinds=${encodeURIComponent(kinds)}`, {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe(error);
  });

  it("rejects a non-integer after on /api/events", async () => {
    const res = await request(server, "GET", "/api/events?timeout=0&after=nope", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 on /api/events without credentials", async () => {
    const res = await request(server, "GET", "/api/events?timeout=0");
    expect(res.status).toBe(401);
  });

  it("returns the projected PR list on /api/open-prs for a managed repo", async () => {
    const { listPRs: listPRsFn } = await import("./github.js");
    (listPRsFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      number: 7, title: "t", headRefName: "b", baseRefName: "main", labels: [{ name: "x" }],
      author: { login: "a" }, updatedAt: "2026-09-14T00:00:00Z", isDraft: false, body: "secret body",
    }]);
    const res = await request(server, "GET", "/api/open-prs?repo=org/repo", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{
      number: 7, title: "t", headRefName: "b", labels: [{ name: "x" }],
      author: { login: "a" }, updatedAt: "2026-09-14T00:00:00Z", isDraft: false,
      stage: null, merge_approved_by: null, merge_approved_at: null,
    }]);
  });

  it("adds the claws_prs stage and merge approval to /api/open-prs rows (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F)", async () => {
    const { listPRs: listPRsFn } = await import("./github.js");
    const db = await import("./db.js");
    (listPRsFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      number: 7, title: "t", headRefName: "b", baseRefName: "main", labels: [],
      author: { login: "a" }, updatedAt: "2026-09-14T00:00:00Z", isDraft: false,
    }]);
    vi.mocked(db.listClawsPrs).mockResolvedValueOnce([
      openPrRow({ repo: "org/repo", prNumber: 7, stage: "awaiting-merge", mergeApprovedBy: "issue", mergeApprovedAt: "2026-10-26T09:30:00.000Z" }),
    ] as any);
    const res = await request(server, "GET", "/api/open-prs?repo=org/repo", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)[0]).toMatchObject({
      stage: "awaiting-merge", merge_approved_by: "issue", merge_approved_at: "2026-10-26T09:30:00.000Z",
    });
  });

  it("returns 404 on /api/open-prs for an unmanaged repo without calling listPRs", async () => {
    const { listPRs: listPRsFn } = await import("./github.js");
    const res = await request(server, "GET", "/api/open-prs?repo=someone/else", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "someone/else is not a repo Claws manages" });
    expect(listPRsFn).not.toHaveBeenCalled();
  });

  it("returns 400 on /api/open-prs with no repo", async () => {
    const res = await request(server, "GET", "/api/open-prs", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "repo is required" });
  });

  it("returns 401 on /api/open-prs without credentials", async () => {
    const res = await request(server, "GET", "/api/open-prs?repo=org/repo");
    expect(res.status).toBe(401);
  });

  it("returns Forgejo job logs on /api/forgejo/job-logs, parsing run, job and all_steps", async () => {
    const { fetchForgejoJobLogs } = await import("./forgejo-job-logs.js");
    const fetchMock = fetchForgejoJobLogs as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ text: "o/r run 3 (failure)\nboom ***", truncated: false });
    const auth = { headers: { Authorization: "Bearer test-internal-mcp-token" } };

    const res = await request(server, "GET", "/api/forgejo/job-logs?repo=o%2Fr&run=3", auth);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ text: "o/r run 3 (failure)\nboom ***", truncated: false });
    expect(fetchMock).toHaveBeenLastCalledWith({ repo: "o/r", run: 3, job: undefined, allSteps: false });

    await request(server, "GET", "/api/forgejo/job-logs?repo=o%2Fr&run=3&job=1&all_steps=true", auth);
    expect(fetchMock).toHaveBeenLastCalledWith({ repo: "o/r", run: 3, job: 1, allSteps: true });
    await request(server, "GET", "/api/forgejo/job-logs?repo=o%2Fr&run=3&job=build%20linux", auth);
    expect(fetchMock).toHaveBeenLastCalledWith({ repo: "o/r", run: 3, job: "build linux", allSteps: false });
  });

  it("maps /api/forgejo/job-logs input and lookup errors to 400/404/502", async () => {
    const { fetchForgejoJobLogs, ForgejoJobLogsError } = await import("./forgejo-job-logs.js");
    const fetchMock = fetchForgejoJobLogs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    const auth = { headers: { Authorization: "Bearer test-internal-mcp-token" } };

    expect((await request(server, "GET", "/api/forgejo/job-logs?run=3", auth)).status).toBe(400);
    expect((await request(server, "GET", "/api/forgejo/job-logs?repo=o%2Fr&run=-1", auth)).status).toBe(400);
    expect((await request(server, "GET", "/api/forgejo/job-logs?repo=o%2Fr&run=3&all_steps=yes", auth)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new ForgejoJobLogsError(404, "o/r has no Actions run 3"));
    const notFound = await request(server, "GET", "/api/forgejo/job-logs?repo=o%2Fr&run=3", auth);
    expect(notFound.status).toBe(404);
    expect(JSON.parse(notFound.body)).toEqual({ error: "o/r has no Actions run 3" });

    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await request(server, "GET", "/api/forgejo/job-logs?repo=o%2Fr&run=3", auth)).status).toBe(502);

    expect((await request(server, "GET", "/api/forgejo/job-logs?repo=o%2Fr&run=3")).status).toBe(401);
  });

  it("returns 502 on /api/open-prs when listPRs rejects", async () => {
    const { listPRs: listPRsFn } = await import("./github.js");
    (listPRsFn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const res = await request(server, "GET", "/api/open-prs?repo=org/repo", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "boom" });
  });

  it("accepts INTERNAL_MCP_TOKEN on POST /api/sessions/:id/description and returns the normalised description", async () => {
    const id = "abcdef1234567890abcdef1234567890abcdef12";
    const res = await request(server, "POST", `/api/sessions/${id}/description`, {
      headers: { Authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" },
      body: JSON.stringify({ description: "Debugging feature X" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ description: "my description" });
    expect(mockSessionBackend.setDescription).toHaveBeenCalledWith(id, "Debugging feature X");
  });

  describe("POST /api/planner-runs/:id/*", () => {
    const auth = { Authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };
    const planBody = JSON.stringify({
      plan: "### What changes\nA pull request lands in org/repo.\n\n### Requirement\nx",
      prs: [{ repo: "org/repo", title: "x" }],
      implementation_model: "sonnet",
      review_model: "opus",
    });

    it("returns 404 for an unknown run id", async () => {
      const res = await request(server, "POST", "/api/planner-runs/no-such-run/plan", { headers: auth, body: planBody });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "no such planner run" });
    });

    it("returns 401 without the token", async () => {
      const plannerRuns = await import("./planner-runs.js");
      await plannerRuns.withPlannerRun({ repo: "org/repo", issueRef: 1, stage: "plan", allowedRepos: ["org/repo"] }, async (id) => {
        const res = await request(server, "POST", `/api/planner-runs/${id}/plan`, { headers: { "content-type": "application/json" }, body: planBody });
        expect(res.status).toBe(401);
        expect(plannerRuns.getSubmission(id)).toBeNull();
      });
    });

    it("records a valid plan, and returns 400 with the validation error otherwise", async () => {
      const plannerRuns = await import("./planner-runs.js");
      await plannerRuns.withPlannerRun({ repo: "org/repo", issueRef: 1, stage: "plan", allowedRepos: ["org/repo"] }, async (id) => {
        const bad = await request(server, "POST", `/api/planner-runs/${id}/plan`, {
          headers: auth,
          body: JSON.stringify({ ...JSON.parse(planBody), prs: [{ repo: "other/repo", title: "x" }] }),
        });
        expect(bad.status).toBe(400);
        expect(JSON.parse(bad.body).error).toContain("org/repo");

        const outcome = await request(server, "POST", `/api/planner-runs/${id}/outcome`, { headers: auth, body: JSON.stringify({ outcome: "blocked" }) });
        expect(outcome.status).toBe(400);
        expect(JSON.parse(outcome.body).error).toContain("explanation");

        const ok = await request(server, "POST", `/api/planner-runs/${id}/plan`, { headers: auth, body: planBody });
        expect(ok.status).toBe(200);
        expect(plannerRuns.getSubmission(id)).toMatchObject({ kind: "plan", prs: [{ repo: "org/repo", title: "x" }] });
      });
    });
  });

  it("returns 401 on POST /api/sessions/:id/description without credentials", async () => {
    const id = "abcdef1234567890abcdef1234567890abcdef12";
    const res = await request(server, "POST", `/api/sessions/${id}/description`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Debugging feature X" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 on POST /api/sessions/:id/description with a non-hex id", async () => {
    const res = await request(server, "POST", "/api/sessions/zzz/description", {
      headers: { Authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" },
      body: JSON.stringify({ description: "hello" }),
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
  });

  describe("POST /api/sessions/:id/status", () => {
    const id = "abcdef1234567890abcdef1234567890abcdef12";
    const auth = { Authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };

    it("sets the status of a live session and returns it with its timestamp", async () => {
      const res = await request(server, "POST", `/api/sessions/${id}/status`, { headers: auth, body: JSON.stringify({ status: "monitoring" }) });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: "monitoring", updatedAt: 1234 });
      expect(mockSessionBackend.setAgentStatus).toHaveBeenCalledWith(id, "monitoring");
    });

    it("returns 401 without credentials", async () => {
      const res = await request(server, "POST", `/api/sessions/${id}/status`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "working" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for a status outside the enum", async () => {
      const res = await request(server, "POST", `/api/sessions/${id}/status`, { headers: auth, body: JSON.stringify({ status: "busy" }) });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "status must be one of working, monitoring, waiting, done" });
      expect(mockSessionBackend.setAgentStatus).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await request(server, "POST", `/api/sessions/${id}/status`, { headers: auth, body: "{not json" });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "Invalid JSON body" });
    });

    it("returns 404 for a non-hex id", async () => {
      const res = await request(server, "POST", "/api/sessions/zzz/status", { headers: auth, body: JSON.stringify({ status: "done" }) });
      expect(res.status).toBe(404);
    });

    it("returns 404 for an unknown or ended session", async () => {
      mockSessionBackend.setAgentStatus.mockResolvedValueOnce({ ok: false, status: "done", updatedAt: 1 });
      const res = await request(server, "POST", `/api/sessions/${id}/status`, { headers: auth, body: JSON.stringify({ status: "done" }) });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Session not found" });
    });
  });
});

describe("requireApiAuth — OIDC-only mode", () => {
  let server: http.Server;
  const OIDC_SECRET = "test-oidc-client-secret";

  function signSession(sub: string, expiresAt: number, secret: string): string {
    const payload = `${sub}|${expiresAt}`;
    const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return `${payload}|${hmac}`;
  }

  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "test-client-id";
    (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = OIDC_SECRET;
    (configMod as Record<string, unknown>).OIDC_BASE_URL = "https://auth.example.com";
    (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "claws";
    // This suite supplies its own credentials; opt out of the global session injection.
    testSessionCookie = null;
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "";
    (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = "";
    (configMod as Record<string, unknown>).OIDC_BASE_URL = "";
    (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "";
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 401 on /api/state with no credentials when OIDC is enabled and AUTH_TOKEN is empty", async () => {
    const res = await request(server, "GET", "/api/state");
    expect(res.status).toBe(401);
  });

  it("accepts a valid claws_session cookie on /api/state", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const sessionValue = signSession("user123", expiresAt, OIDC_SECRET);
    const res = await request(server, "GET", "/api/state", {
      headers: { Cookie: `claws_session=${encodeURIComponent(sessionValue)}` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts INTERNAL_MCP_TOKEN on /api/state under OIDC", async () => {
    const res = await request(server, "GET", "/api/state", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 on /api/state with a tampered claws_session cookie", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const sessionValue = signSession("user123", expiresAt, OIDC_SECRET);
    const tampered = sessionValue.slice(0, -1) + (sessionValue.endsWith("a") ? "b" : "a");
    const res = await request(server, "GET", "/api/state", {
      headers: { Cookie: `claws_session=${encodeURIComponent(tampered)}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("default-deny — every authenticated route returns 401 without credentials", () => {
  let server: http.Server;

  // Routes that are intentionally public (no auth required).
  const PUBLIC_ROUTES: Array<[string, string]> = [
    ["GET", "/health"],
    ["GET", "/login"],
    ["GET", "/auth/callback"],
    ["GET", "/logout"],
    ["GET", "/static/alpine.js"],
    ["GET", "/static/tailwind.css"],
    ["GET", "/static/chart.js"],
  ];

  // Sample of authenticated routes spanning every group. If a new route is
  // added without mounting auth middleware, this test will fail.
  const AUTH_ROUTES: Array<[string, string]> = [
    // GET pages
    ["GET", "/"],
    ["GET", "/status"],
    ["GET", "/api/status"],
    ["GET", "/jobs"],
    ["GET", "/repos/owner/name"],
    ["GET", "/whatsapp"],
    ["GET", "/whatsapp/events"],
    ["GET", "/whatsapp/pair"],
    ["GET", "/sessions"],
    ["GET", "/sessions/abc"],
    ["GET", "/sessions/abc/ws"],
    ["GET", "/config"],
    ["GET", "/config/api"],
    ["GET", "/logs/issue?repo=org/repo&number=1"],
    ["GET", "/logs/abc-123"],
    ["GET", "/logs/abc-123/tail"],
    ["GET", "/board"],
    ["GET", "/backlog"],
    ["GET", "/retro"],
    ["GET", "/alerts"],
    ["GET", "/alerts/lookup?repo=org/repo&alertname=X"],
    ["GET", "/api/activation"],
    ["GET", "/api/state"],
    // POSTs
    ["POST", "/trigger/x"],
    ["POST", "/pause/x"],
    ["POST", "/cancel"],
    ["POST", "/api/verify/run"],
    ["POST", "/api/client-error"],
    ["POST", "/api/activation"],
    ["POST", "/queue/refresh"],
    ["POST", "/queue/merge"],
    ["POST", "/queue/skip"],
    ["POST", "/queue/unskip"],
    ["POST", "/queue/prioritize"],
    ["POST", "/queue/deprioritize"],
    ["POST", "/queue/mark-refined"],
    ["POST", "/queue/priority-label"],
    ["POST", "/queue/mark-automerge"],
    ["POST", "/queue/mark-problematic"],
    ["POST", "/queue/unmark-problematic"],
    ["POST", "/queue/clear-manual-action"],
    ["POST", "/board/move"],
    ["POST", "/board/bulk-move"],
    ["POST", "/board/automerge"],
    ["POST", "/board/approve-through"],
    ["POST", "/board/start-session"],
    ["POST", "/board/infra-approve"],
    ["POST", "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/start-session"],
    ["POST", "/prs/start-session"],
    ["POST", "/backlog/promote"],
    ["POST", "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/column"],
    ["POST", "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/links"],
    ["POST", "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/links/cll_1/delete"],
    ["GET", "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/attachments/cla_01JBQ7X4M2K8NV3TYRW9GZ5PD1/a.png"],
    ["POST", "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/attachments"],
    ["POST", "/issues/new/attachments"],
    ["POST", "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/attachments/stream?name=a.bin"],
    ["POST", "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/attachments/cla_01JBQ7X4M2K8NV3TYRW9GZ5PD1/delete"],
    ["POST", "/jobs"],
    ["POST", "/config/remove-unknown-keys"],
    ["POST", "/config"],
    ["POST", "/whatsapp/unpair"],
    ["POST", "/sessions/create"],
    ["POST", "/sessions/attachments"],
    ["POST", "/sessions/attachments/stream?name=a.bin"],
    ["POST", "/sessions/attachments/sat_01M617FXR2G2Q62972WCFY57HA/delete"],
    ["POST", "/sessions/abc/kill"],
    ["GET", "/api/sessions/table"],
    ["GET", "/api/board"],
    ["POST", "/sessions/abc/capabilities"],
    ["DELETE", "/sessions/abc/capabilities/ssh%3Anas"],
    ["POST", "/logs/abc-123/cancel"],
  ];

  beforeEach(async () => {
    // OIDC is enabled by the global beforeEach; deny everything by sending no session.
    testSessionCookie = null;
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("public routes do not require auth", async () => {
    for (const [method, path] of PUBLIC_ROUTES) {
      const res = await request(server, method, path);
      expect(res.status, `${method} ${path} should be public but got ${res.status}`).not.toBe(401);
    }
  });

  it("authenticated routes return 401 without credentials", async () => {
    for (const [method, path] of AUTH_ROUTES) {
      const res = await request(server, method, path);
      expect(res.status, `${method} ${path} should be 401 but got ${res.status}`).toBe(401);
    }
  });
});

describe("fail-closed — no auth when OIDC unconfigured", () => {
  let server: http.Server;

  beforeEach(async () => {
    // Clear the OIDC config the global beforeEach armed, and drop the session.
    const configMod = await import("./config.js");
    for (const k of ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_BASE_URL", "OIDC_APPLICATION_SLUG"]) {
      (configMod as Record<string, unknown>)[k] = "";
    }
    testSessionCookie = null;
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET / returns 503 when OIDC is not configured", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(503);
  });
});

describe("POST /sessions/:id/upload", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 404 for a non-hex session id", async () => {
    const res = await request(server, "POST", "/sessions/zzz/upload");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown session", async () => {
    const boundary = "BOUNDARY";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="a.png"\r\n` +
      `Content-Type: image/png\r\n\r\n` +
      `DATA\r\n` +
      `--${boundary}--\r\n`;
    const res = await request(server, "POST", "/sessions/abc123/upload", {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("Session not found");
  });

  // The module-level request() helper rejects on any request-stream error, which an
  // oversized upload triggers: the server answers 413 and tears the socket down while
  // the client is still writing, producing EPIPE/ECONNRESET. This helper stops writing
  // as soon as a response arrives instead.
  function oversizeUpload(
    server: http.Server,
    opts: { totalBytes: number; contentLength?: number },
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Server not listening"));
        return;
      }
      const headers: Record<string, string> = {
        "content-type": "multipart/form-data; boundary=BOUNDARY",
      };
      if (opts.contentLength !== undefined) headers["content-length"] = String(opts.contentLength);
      if (testSessionCookie) headers["Cookie"] = `claws_session=${encodeURIComponent(testSessionCookie)}`;
      let responded = false;
      const req = http.request(
        { hostname: "127.0.0.1", port: addr.port, path: "/sessions/abc123/upload", method: "POST", headers },
        (res) => {
          responded = true;
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString()));
          res.on("end", () => {
            resolve({ status: res.statusCode!, body });
            req.destroy();
          });
        },
      );
      req.on("error", (err) => {
        if (!responded) reject(err);
      });
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      let written = 0;
      const pump = () => {
        while (!responded && written < opts.totalBytes) {
          written += chunk.length;
          if (!req.write(chunk)) {
            req.once("drain", pump);
            return;
          }
        }
        if (!responded) req.end();
      };
      pump();
    });
  }

  it("returns 413 for a chunked oversized body with no content-length", async () => {
    const res = await oversizeUpload(server, { totalBytes: 12 * 1024 * 1024 });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toBe("File too large (max 10 MB)");
  });

  it("returns 413 when content-length exceeds the cap", async () => {
    const res = await oversizeUpload(server, { totalBytes: 12 * 1024 * 1024, contentLength: 12 * 1024 * 1024 });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toBe("File too large (max 10 MB)");
  });

  it("transcribes an audio upload and returns the transcript instead of the path", async () => {
    mockSessionBackend.getLive.mockResolvedValueOnce({ ok: true, session: { id: "abc123", repo: null, cwd: "/w", mode: "home-claude", provider: "claude", model: null, alive: true, summary: null, extraRepos: [], capabilities: [] } });
    mockSessionBackend.saveUpload.mockResolvedValueOnce({ ok: true, path: "/fake/session-uploads/abc123/xxx-a.m4a" });

    const boundary = "BOUNDARY";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="a.m4a"\r\n` +
      `Content-Type: audio/mp4\r\n\r\n` +
      `DATA\r\n` +
      `--${boundary}--\r\n`;
    const res = await request(server, "POST", "/sessions/abc123/upload", {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.path).toBe("/fake/session-uploads/abc123/xxx-a.m4a");
    expect(parsed.transcript).toBe("hello from the voice note");
    expect(transcribe).toHaveBeenCalled();
  });

  it("returns a transcriptError without a transcript when transcription is not configured", async () => {
    mockSessionBackend.getLive.mockResolvedValueOnce({ ok: true, session: { id: "abc123", repo: null, cwd: "/w", mode: "home-claude", provider: "claude", model: null, alive: true, summary: null, extraRepos: [], capabilities: [] } });
    mockSessionBackend.saveUpload.mockResolvedValueOnce({ ok: true, path: "/fake/session-uploads/abc123/xxx-a.m4a" });
    vi.mocked(isAvailable).mockReturnValueOnce(false);

    const boundary = "BOUNDARY";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="a.m4a"\r\n` +
      `Content-Type: audio/mp4\r\n\r\n` +
      `DATA\r\n` +
      `--${boundary}--\r\n`;
    const res = await request(server, "POST", "/sessions/abc123/upload", {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.transcript).toBeUndefined();
    expect(parsed.transcriptError).toContain("not configured");
  });

  it("returns 200 with path and a transcriptError when transcription fails", async () => {
    mockSessionBackend.getLive.mockResolvedValueOnce({ ok: true, session: { id: "abc123", repo: null, cwd: "/w", mode: "home-claude", provider: "claude", model: null, alive: true, summary: null, extraRepos: [], capabilities: [] } });
    mockSessionBackend.saveUpload.mockResolvedValueOnce({ ok: true, path: "/fake/session-uploads/abc123/xxx-a.m4a" });
    vi.mocked(transcribe).mockRejectedValueOnce(new Error("boom"));

    const boundary = "BOUNDARY";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="a.m4a"\r\n` +
      `Content-Type: audio/mp4\r\n\r\n` +
      `DATA\r\n` +
      `--${boundary}--\r\n`;
    const res = await request(server, "POST", "/sessions/abc123/upload", {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.path).toBe("/fake/session-uploads/abc123/xxx-a.m4a");
    expect(parsed.transcriptError).toContain("boom");
  });

  it("does not transcribe a non-audio upload", async () => {
    mockSessionBackend.getLive.mockResolvedValueOnce({ ok: true, session: { id: "abc123", repo: null, cwd: "/w", mode: "home-claude", provider: "claude", model: null, alive: true, summary: null, extraRepos: [], capabilities: [] } });
    mockSessionBackend.saveUpload.mockResolvedValueOnce({ ok: true, path: "/fake/session-uploads/abc123/xxx-a.png" });
    vi.mocked(transcribe).mockClear();

    const boundary = "BOUNDARY";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="a.png"\r\n` +
      `Content-Type: image/png\r\n\r\n` +
      `DATA\r\n` +
      `--${boundary}--\r\n`;
    const res = await request(server, "POST", "/sessions/abc123/upload", {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({ path: "/fake/session-uploads/abc123/xxx-a.png" });
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("POST /sessions/:id/upload-stream", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 404 for a non-hex session id", async () => {
    const res = await request(server, "POST", "/sessions/zzz/upload-stream");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await request(server, "POST", "/sessions/abc123/upload-stream?name=a.bin", {
      headers: { "content-type": "application/octet-stream" },
      body: "DATA",
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Session not found");
  });

  it("returns 413 when content-length exceeds the 1 GB cap", async () => {
    const res = await request(server, "POST", "/sessions/abc123/upload-stream?name=a.bin", {
      headers: { "content-length": String(1024 * 1024 * 1024 + 1) },
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toBe("File too large (max 1 GB)");
  });
});

describe("published session files (claws_publish_file)", () => {
  const SID = "abc123";
  const SESSION_TOKEN = "session-own-mcp-token";
  const API = { authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/json" };
  const FILE_ID = "csf_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
  let server: http.Server;
  let tmpDir: string;
  const fakeBackend = {
    kind: "k8s-pod" as const,
    shutdown: vi.fn(async () => {}),
    verifyMcpToken: vi.fn(async (id: string, token: string) => (id === SID && token === SESSION_TOKEN ? "ok" as const : "denied" as const)),
    fetchFile: vi.fn(async (_id: string, _path: string): Promise<any> => ({ ok: false, reason: "file-not-found" })),
    getLive: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
  };
  const row = (patch: Record<string, unknown> = {}) => ({
    id: FILE_ID, session_id: SID, filename: "chart.png", stored_path: "session-files/abc123/aa-chart.png",
    content_type: "image/png", size: 5, created_at: "2026-10-12 10:00:00", ...patch,
  });
  const publish = (body: unknown, headers: Record<string, string> = API) =>
    request(server, "POST", `/api/sessions/${SID}/files`, { headers, body: JSON.stringify(body) });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-session-files-"));
    fakeBackend.fetchFile.mockClear();
    mockSessionFiles.storeSessionFile.mockReset();
    mockSessionFiles.readSessionFile.mockReset();
    const { setSessionBackendForTests } = await import("./session-backend.js");
    setSessionBackendForTests(fakeBackend as any);
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    const { setSessionBackendForTests } = await import("./session-backend.js");
    setSessionBackendForTests(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pulls the file from the pod and stores exactly its bytes under the given name", async () => {
    fakeBackend.fetchFile.mockResolvedValueOnce({ ok: true, stream: Readable.from([Buffer.from("echo "), Buffer.from("hi\n")]), size: 8 });
    let stored = Buffer.alloc(0);
    mockSessionFiles.storeSessionFile.mockImplementationOnce(async (_sid: string, name: string, source: unknown) => {
      for await (const chunk of source as AsyncIterable<Buffer>) stored = Buffer.concat([stored, chunk]);
      return { ok: true, requestedName: name, row: row({ filename: name, content_type: "application/octet-stream", size: stored.length }) };
    });
    const res = await publish({ path: "out/run.sh", name: "deploy helper.sh" });
    expect(res.status).toBe(200);
    expect(fakeBackend.fetchFile).toHaveBeenCalledWith(SID, "out/run.sh");
    expect(mockSessionFiles.storeSessionFile.mock.calls[0]![0]).toBe(SID);
    expect(mockSessionFiles.storeSessionFile.mock.calls[0]![1]).toBe("deploy_helper.sh");
    expect(stored.toString()).toBe("echo hi\n");
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, id: FILE_ID, name: "deploy_helper.sh", size: 8, url: `/sessions/${SID}/files/${FILE_ID}/deploy_helper.sh` });
  });

  it("reports a renamed publish with the final name, and nothing extra for a distinct name", async () => {
    fakeBackend.fetchFile.mockResolvedValueOnce({ ok: true, stream: Readable.from([Buffer.from("x")]), size: 1 });
    mockSessionFiles.storeSessionFile.mockImplementationOnce(async () => ({
      ok: true, requestedName: "run.sh", row: row({ filename: "run-2.sh", content_type: "application/octet-stream" }),
    }));
    const res = await publish({ path: "run.sh" });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: true, name: "run-2.sh", renamed: true, requested_name: "run.sh" });
    expect(body.note).toContain("run-2.sh");

    fakeBackend.fetchFile.mockResolvedValueOnce({ ok: true, stream: Readable.from([Buffer.from("x")]), size: 1 });
    mockSessionFiles.storeSessionFile.mockImplementationOnce(async () => ({
      ok: true, requestedName: "other.sh", row: row({ filename: "other.sh", content_type: "application/octet-stream" }),
    }));
    const plain = JSON.parse((await publish({ path: "other.sh" })).body);
    expect(plain.renamed).toBeUndefined();
  });

  it("refuses a file over the per-file limit with its size, and stores nothing", async () => {
    fakeBackend.fetchFile.mockResolvedValueOnce({ ok: false, reason: "too-large", size: 12 * 1024 * 1024 });
    const res = await publish({ path: "/home/claws/big.bin" });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toBe("File is 12.0 MB — the per-file limit is 10 MB");
    expect(mockSessionFiles.storeSessionFile).not.toHaveBeenCalled();
  });

  it("maps the pod's refusals to clear messages", async () => {
    fakeBackend.fetchFile.mockResolvedValueOnce({ ok: false, reason: "outside-home" });
    expect((await publish({ path: "/etc/passwd" })).status).toBe(400);
    fakeBackend.fetchFile.mockResolvedValueOnce({ ok: false, reason: "file-not-found" });
    const missing = await publish({ path: "nope.txt" });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error).toContain("No file at nope.txt");
    fakeBackend.fetchFile.mockResolvedValueOnce({ ok: false, reason: "unsupported" });
    const old = await publish({ path: "a.txt" });
    expect(old.status).toBe(409);
    expect(JSON.parse(old.body).error).toContain("end and revive the session");
    expect((await publish({})).status).toBe(400);
  });

  it("refuses any bearer but this session's own token", async () => {
    const res = await publish({ path: "a.txt" }, { authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" });
    expect(res.status).toBe(401);
    expect(fakeBackend.fetchFile).not.toHaveBeenCalled();
  });

  it("serves a file only under its own session's URL, inline for an image and as an attachment with ?download=1", async () => {
    const file = path.join(tmpDir, "aa-chart.png");
    fs.writeFileSync(file, "PNGOK");
    mockSessionFiles.readSessionFile.mockResolvedValue({ row: row(), absolutePath: file });

    const inline = await request(server, "GET", `/sessions/${SID}/files/${FILE_ID}/chart.png`);
    expect(inline.status).toBe(200);
    expect(inline.body).toBe("PNGOK");
    expect(inline.headers["content-type"]).toBe("image/png");
    expect(inline.headers["content-disposition"]).toBe('inline; filename="chart.png"');
    expect(inline.headers["x-content-type-options"]).toBe("nosniff");

    const download = await request(server, "GET", `/sessions/${SID}/files/${FILE_ID}/chart.png?download=1`);
    expect(download.headers["content-disposition"]).toBe('attachment; filename="chart.png"');

    const other = await request(server, "GET", `/sessions/def456/files/${FILE_ID}/chart.png`);
    expect(other.status).toBe(404);
  });

  it("refuses the download without a dashboard login", async () => {
    testSessionCookie = null;
    mockSessionFiles.readSessionFile.mockResolvedValue({ row: row(), absolutePath: path.join(tmpDir, "x") });
    const res = await request(server, "GET", `/sessions/${SID}/files/${FILE_ID}/chart.png`);
    expect(res.status).not.toBe(200);
    expect(mockSessionFiles.readSessionFile).not.toHaveBeenCalled();
  });

  it("lists a session's files for the page poll", async () => {
    const db = await import("./db.js");
    vi.mocked(db.listSessionFiles).mockResolvedValueOnce([row()] as any);
    const res = await request(server, "GET", `/sessions/${SID}/files`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).files).toEqual([expect.objectContaining({
      id: FILE_ID, name: "chart.png", size: 5, isImage: true,
      url: `/sessions/${SID}/files/${FILE_ID}/chart.png`, downloadUrl: `/sessions/${SID}/files/${FILE_ID}/chart.png?download=1`,
    })]);
  });
});

describe("session routes with an unavailable backend (#3026)", () => {
  let server: http.Server;
  const unavailable = { ok: false as const, reason: "unavailable" as const, detail: "Kubernetes API unreachable" };
  const fakeBackend = {
    kind: "k8s-pod" as const,
    start: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    create: vi.fn(async () => ({ ok: false as const, reason: "backend-unavailable" as const, detail: "forbidden" })),
    createMulti: vi.fn(async () => ({ ok: false as const, reason: "backend-unavailable" as const })),
    resume: vi.fn(async () => ({ ok: false as const, reason: "backend-unavailable" as const })),
    end: vi.fn(async () => unavailable),
    remove: vi.fn(async () => unavailable),
    listLive: vi.fn(async () => []),
    getLive: vi.fn(async (id: string) => (id === "abc123" ? unavailable : { ok: false as const, reason: "not-found" as const })),
    getStartupStatus: vi.fn(async (id: string) => (id === "abc123" ? unavailable : { ok: false as const, reason: "not-found" as const })),
    checkAttach: vi.fn(async (id: string) => (id === "abc123" ? unavailable : { ok: false as const, reason: "not-found" as const })),
    attach: vi.fn(),
    saveUpload: vi.fn(async () => unavailable),
    saveUploadStream: vi.fn(async () => unavailable),
    fetchFile: vi.fn(async () => unavailable),
    setDescription: vi.fn(async () => ({ ok: false, description: null })),
    resummarize: vi.fn(async () => ({ ok: false, description: null })),
    switchClaudeAccount: vi.fn(async (id: string) => (
      id === "abc123" ? unavailable
        : id === "bbb222" ? { ok: false as const, reason: "invalid" as const, detail: "No other Claude account with a token is configured" }
          : id === "def456" ? { ok: true as const, from: "a", to: "b" }
            : { ok: false as const, reason: "not-found" as const }
    )),
    grantCapability: vi.fn(async (id: string, capId: string) => (
      id === "abc123" ? unavailable
        : capId === "browser" ? { ok: false as const, reason: "invalid" as const, detail: "browser cannot be granted to this session" }
          : id === "def456" ? { ok: true as const, live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: home-assistant", delayed: true, landed: true, restarted: false }
            : { ok: false as const, reason: "not-found" as const }
    )),
    grantDelivery: vi.fn(async () => unavailable),
    notifyAgent: vi.fn(async (): Promise<"ok" | "unreachable" | "unsupported"> => "unsupported"),
    revokeCapability: vi.fn(async (id: string, capId: string) => (
      id === "abc123" ? unavailable
        : !capId.startsWith("ssh:") ? { ok: false as const, reason: "invalid" as const, detail: `${capId} cannot be revoked from this session` }
          : id === "def456" ? { ok: true as const, live: true, keysRemoved: capId === "ssh:nas" }
            : { ok: false as const, reason: "not-found" as const }
    )),
    setAgentStatus: vi.fn(async (_id: string, status: "working" | "monitoring" | "waiting" | "done") => ({ ok: false, status, updatedAt: 0 })),
    notifyAgentOnceReady: vi.fn(),
    recordPodExit: vi.fn(async (id: string, token: string): Promise<"ok" | "denied" | "unavailable"> => (
      id === "abc123" ? "unavailable" : token === "term-tok" ? "ok" : "denied"
    )),
  };

  beforeEach(async () => {
    const { setSessionBackendForTests } = await import("./session-backend.js");
    setSessionBackendForTests(fakeBackend);
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    const { setSessionBackendForTests } = await import("./session-backend.js");
    setSessionBackendForTests(null);
  });

  it("POST /sessions/:id/switch-account maps the switch outcome to its status (#clw_01M623AMK66JB6TBB4PP55Q2V6)", async () => {
    const ok = await request(server, "POST", "/sessions/def456/switch-account");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ from: "a", to: "b" });
    const invalid = await request(server, "POST", "/sessions/bbb222/switch-account");
    expect(invalid.status).toBe(409);
    expect(JSON.parse(invalid.body)).toEqual({ error: "No other Claude account with a token is configured" });
    const down = await request(server, "POST", "/sessions/abc123/switch-account");
    expect(down.status).toBe(503);
    expect(JSON.parse(down.body).error).toContain("Kubernetes API unreachable");
    expect((await request(server, "POST", "/sessions/ccc333/switch-account")).status).toBe(404);
    expect((await request(server, "POST", "/sessions/NOPE/switch-account")).status).toBe(404);
  });

  it("maps backend-unavailable on create, create-multi and resume to 503", async () => {
    const create = await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-claude&provider=claude" });
    expect(create.status).toBe(503);
    expect(create.body).toContain("Session runtime unavailable");
    const multi = await request(server, "POST", "/sessions/create-multi", { body: "repo=org%2Fa&repo=org%2Fb&provider=claude" });
    expect(multi.status).toBe(503);
    const resume = await request(server, "POST", "/sessions/abc123/resume");
    expect(resume.status).toBe(503);
  });

  it("POST /session-pods/:id/exit passes a valid report to the backend without a dashboard session (#3311)", async () => {
    testSessionCookie = null;
    const report = JSON.stringify({ code: 2, scrollback: "Error: EACCES" });
    const post = (id: string, headers: Record<string, string>, body = report) =>
      request(server, "POST", `/session-pods/${id}/exit`, { headers: { "content-type": "application/json", ...headers }, body });

    fakeBackend.recordPodExit.mockClear();
    expect((await post("def456", { Authorization: "Bearer term-tok" })).status).toBe(204);
    expect(fakeBackend.recordPodExit).toHaveBeenCalledWith("def456", "term-tok", { code: 2, scrollback: "Error: EACCES" });
    expect((await post("def456", { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post("abc123", { Authorization: "Bearer term-tok" })).status).toBe(503);

    fakeBackend.recordPodExit.mockClear();
    expect((await post("def456", {})).status).toBe(401);
    expect((await post("zzz", { Authorization: "Bearer term-tok" })).status).toBe(404);
    expect((await post("def456", { Authorization: "Bearer term-tok" }, "not json")).status).toBe(400);
    expect((await post("def456", { Authorization: "Bearer term-tok" }, JSON.stringify({ code: "2", scrollback: "" }))).status).toBe(400);
    const huge = JSON.stringify({ code: 1, scrollback: "x".repeat(300 * 1024) });
    expect((await post("def456", { Authorization: "Bearer term-tok" }, huge)).status).toBe(413);

    // Chunked, no content-length: the cap is enforced while streaming, and the
    // server answers before the client has finished writing.
    const chunked = await new Promise<number>((resolve, reject) => {
      const addr = server.address() as { port: number };
      let responded = false;
      const req = http.request(
        { hostname: "127.0.0.1", port: addr.port, path: "/session-pods/def456/exit", method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer term-tok" } },
        (res) => { responded = true; res.resume(); resolve(res.statusCode!); req.destroy(); },
      );
      req.on("error", (err) => { if (!responded) reject(err); });
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      let written = 0;
      const pump = () => {
        while (!responded && written < 1024 * 1024) {
          written += chunk.length;
          if (!req.write(chunk)) { req.once("drain", pump); return; }
        }
        if (!responded) req.end();
      };
      pump();
    });
    expect(chunked).toBe(413);
    expect(fakeBackend.recordPodExit).not.toHaveBeenCalled();
  });

  it("POST /agent-pods/:rowId/ops/:op runs an op only for the row's own live token", async () => {
    testSessionCookie = null;
    const post = (rowId: string, op: string, headers: Record<string, string>, body = JSON.stringify({ args: [7] })) =>
      request(server, "POST", `/agent-pods/${rowId}/ops/${op}`, { headers: { "content-type": "application/json", ...headers }, body });
    const auth = { Authorization: "Bearer agent-pod-token" };

    agentPodOps.executeAgentPodOp.mockReset();
    agentPodOps.executeAgentPodOp.mockResolvedValue({ status: 200, result: { id: 7, status: "running" } });
    const ok = await post("7", "getWorkRow", auth);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ result: { id: 7, status: "running" } });
    expect(agentPodOps.executeAgentPodOp).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), "getWorkRow", [7]);

    agentPodOps.executeAgentPodOp.mockClear();
    expect((await post("7", "getWorkRow", { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post("7", "getWorkRow", {})).status).toBe(401);
    expect((await post("8", "getWorkRow", auth)).status).toBe(401);
    expect((await post("9", "getWorkRow", auth)).status).toBe(401);
    expect((await post("abc", "getWorkRow", auth)).status).toBe(404);
    expect((await post("7", "getWorkRow", auth, "not json")).status).toBe(400);
    // Over the 4 MiB cap by declared length: answered before any body is read.
    const tooLarge = await new Promise<number>((resolve, reject) => {
      const addr = server.address() as { port: number };
      const req = http.request(
        { hostname: "127.0.0.1", port: addr.port, path: "/agent-pods/7/ops/insertJobLogRows", method: "POST",
          headers: { "content-type": "application/json", "content-length": String(5 * 1024 * 1024), ...auth } },
        (res) => { res.resume(); resolve(res.statusCode!); req.destroy(); },
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(tooLarge).toBe(413);
    expect(agentPodOps.executeAgentPodOp).not.toHaveBeenCalled();

    agentPodOps.executeAgentPodOp.mockResolvedValueOnce({ status: 403, error: "markWorkFailed must name row 7" });
    const denied = await post("7", "markWorkFailed", auth, JSON.stringify({ args: [8, "x"] }));
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({ error: "markWorkFailed must name row 7" });
  });

  it("maps startup status backend-unavailable to 503", async () => {
    const res = await request(server, "GET", "/api/sessions/abc123/startup");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: "Session runtime unavailable", detail: "Kubernetes API unreachable" });
  });

  it("remembers the submitted capabilities per repo combination only on a successful create", async () => {
    const { rememberSessionCapabilityDefaults } = await import("./db.js");
    vi.mocked(rememberSessionCapabilityDefaults).mockClear();

    await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-claude&provider=claude" });
    await request(server, "POST", "/sessions/create-multi", { body: "repo=org%2Fa&repo=org%2Fb&provider=claude" });
    expect(rememberSessionCapabilityDefaults).not.toHaveBeenCalled();

    fakeBackend.create.mockResolvedValueOnce({ ok: true, id: "abc123" } as never);
    const single = await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-claude&provider=claude&capability=claude-auth" });
    expect(single.status).toBe(303);
    expect(rememberSessionCapabilityDefaults).toHaveBeenCalledWith(["org/a"], []);

    fakeBackend.createMulti.mockResolvedValueOnce({ ok: true, id: "def456" } as never);
    const multi = await request(server, "POST", "/sessions/create-multi", { body: "repo=org%2Fa&repo=org%2Fb&provider=claude" });
    expect(multi.status).toBe(303);
    expect(rememberSessionCapabilityDefaults).toHaveBeenCalledWith(["org/a", "org/b"], []);

    vi.mocked(rememberSessionCapabilityDefaults).mockClear();
    fakeBackend.create.mockResolvedValueOnce({ ok: true, id: "abc123" } as never);
    const home = await request(server, "POST", "/sessions/create", { body: "mode=home-claude&provider=claude" });
    expect(home.status).toBe(303);
    expect(rememberSessionCapabilityDefaults).not.toHaveBeenCalled();
  });

  it("remembers the agent and an offered model of a successful agent create, not a repo-zsh one (#clw_01M4TJJH1RK76ZHS0JB64KTQJ8)", async () => {
    const { rememberSessionAgentDefault } = await import("./db.js");
    vi.mocked(rememberSessionAgentDefault).mockClear();
    const codexModel = sessionModelsFor("codex")[1]!.id;

    fakeBackend.create.mockResolvedValueOnce({ ok: true, id: "abc123" } as never);
    await request(server, "POST", "/sessions/create", { body: `repo=org%2Fa&mode=repo-claude&provider=codex&model=${encodeURIComponent(codexModel)}` });
    expect(rememberSessionAgentDefault).toHaveBeenCalledWith("codex", codexModel);

    vi.mocked(rememberSessionAgentDefault).mockClear();
    fakeBackend.create.mockResolvedValueOnce({ ok: true, id: "abc123" } as never);
    await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-claude&provider=codex&model=__custom__&modelCustom=my-model" });
    expect(rememberSessionAgentDefault).toHaveBeenCalledWith("codex", null);

    vi.mocked(rememberSessionAgentDefault).mockClear();
    fakeBackend.create.mockResolvedValueOnce({ ok: true, id: "abc123" } as never);
    await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-zsh&provider=claude" });
    expect(rememberSessionAgentDefault).not.toHaveBeenCalled();
  });

  it("pre-selects the remembered agent and model on GET /sessions", async () => {
    const { getSessionAgentDefaults } = await import("./db.js");
    const codexModel = sessionModelsFor("codex")[1]!.id;
    vi.mocked(getSessionAgentDefaults).mockResolvedValueOnce({ lastProvider: "codex", models: { codex: codexModel } });
    const res = await request(server, "GET", "/sessions");
    expect(res.body).toMatch(/<option value="codex" selected>/);
    expect(res.body).toMatch(new RegExp(`<option value="${codexModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" selected>`));
  });

  it("still redirects to the new session when remembering the defaults fails", async () => {
    const { rememberSessionCapabilityDefaults } = await import("./db.js");
    vi.mocked(rememberSessionCapabilityDefaults).mockRejectedValueOnce(new Error("db down"));
    fakeBackend.create.mockResolvedValueOnce({ ok: true, id: "abc123" } as never);
    const res = await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-claude&provider=claude" });
    expect(res.status).toBe(303);
  });

  it("maps provider-unsupported on create-multi to 400", async () => {
    fakeBackend.createMulti.mockResolvedValueOnce({ ok: false, reason: "provider-unsupported", detail: "pi" } as never);
    const multi = await request(server, "POST", "/sessions/create-multi", { body: "repo=org%2Fa&repo=other%2Fb&provider=claude" });
    expect(multi.status).toBe(400);
    expect(multi.body).toContain("Provider not supported for this session type");
  });

  it("maps unavailable End and Delete to 503", async () => {
    expect((await request(server, "POST", "/sessions/abc123/kill")).status).toBe(503);
    expect((await request(server, "POST", "/sessions/abc123/delete")).status).toBe(503);
  });

  it("returns 503 before the WebSocket handshake when unavailable, 404 when not found", async () => {
    expect((await request(server, "GET", "/sessions/abc123/ws")).status).toBe(503);
    expect((await request(server, "GET", "/sessions/def456/ws")).status).toBe(404);
    expect(fakeBackend.attach).not.toHaveBeenCalled();
  });

  describe("POST /sessions/:id/capabilities (#3072)", () => {
    const grant = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      request(server, "POST", `/sessions/${id}/capabilities`, {
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    it("rejects Bearer INTERNAL_MCP_TOKEN, so an agent cannot grant itself access", async () => {
      testSessionCookie = null;
      const res = await grant("def456", { capability: "home-assistant" }, { Authorization: "Bearer test-internal-mcp-token" });
      expect(res.status).toBe(401);
      expect(fakeBackend.grantCapability).not.toHaveBeenCalled();
    });

    it("grants with an OIDC session and returns where to load the vars", async () => {
      const res = await grant("def456", { capability: "home-assistant" });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: home-assistant", delayed: true, landed: true,
        restarted: false, agentPickedUp: false, agentNotified: false, notifyFailure: "unsupported", agentNoticeQueued: false,
      });
      expect(fakeBackend.grantCapability).toHaveBeenCalledWith("def456", "home-assistant");
    });

    it("maps not-found to 404, unavailable to 503 and invalid to 400", async () => {
      expect((await grant("fff000", { capability: "home-assistant" })).status).toBe(404);
      expect((await grant("abc123", { capability: "home-assistant" })).status).toBe(503);
      const invalid = await grant("def456", { capability: "browser" });
      expect(invalid.status).toBe(400);
      expect(JSON.parse(invalid.body)).toEqual({ error: "browser cannot be granted to this session" });
    });

    it("rejects a non-hex id and a missing capability before calling the backend", async () => {
      expect((await grant("zzz", { capability: "home-assistant" })).status).toBe(404);
      expect((await grant("def456", {})).status).toBe(400);
      expect(fakeBackend.grantCapability).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /sessions/:id/capabilities/:capability", () => {
    const revoke = (id: string, capId: string, headers: Record<string, string> = {}) =>
      request(server, "DELETE", `/sessions/${id}/capabilities/${encodeURIComponent(capId)}`, { headers });

    it("rejects Bearer INTERNAL_MCP_TOKEN, so an agent cannot revoke grants", async () => {
      testSessionCookie = null;
      const res = await revoke("def456", "ssh:nas", { Authorization: "Bearer test-internal-mcp-token" });
      expect(res.status).toBe(401);
      expect(fakeBackend.revokeCapability).not.toHaveBeenCalled();
    });

    it("revokes with an OIDC session and reports whether it is live", async () => {
      const res = await revoke("def456", "ssh:nas");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ live: true, keysRemoved: true });
      expect(fakeBackend.revokeCapability).toHaveBeenCalledWith("def456", "ssh:nas");
    });

    it("reports when the revoked host keeps the shared SSH key", async () => {
      const res = await revoke("def456", "ssh:thinkcentre");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ live: true, keysRemoved: false });
    });

    it("maps not-found to 404, unavailable to 503 and invalid to 400", async () => {
      expect((await revoke("fff000", "ssh:nas")).status).toBe(404);
      expect((await revoke("abc123", "ssh:nas")).status).toBe(503);
      const invalid = await revoke("def456", "forgejo");
      expect(invalid.status).toBe(400);
      expect(JSON.parse(invalid.body)).toEqual({ error: "forgejo cannot be revoked from this session" });
    });

    it("rejects a non-hex id before calling the backend", async () => {
      expect((await revoke("zzz", "ssh:nas")).status).toBe(404);
      expect(fakeBackend.revokeCapability).not.toHaveBeenCalled();
    });
  });

  it("returns 503 for uploads and the terminal page when unavailable", async () => {
    const upload = await request(server, "POST", "/sessions/abc123/upload-stream?name=a.txt", {
      headers: { "content-type": "application/octet-stream" },
      body: "hello",
    });
    expect(upload.status).toBe(503);
    expect(fakeBackend.saveUploadStream).not.toHaveBeenCalled();
    const page = await request(server, "GET", "/sessions/abc123");
    expect(page.status).toBe(503);
    expect(page.body).toContain("Session runtime unavailable");
  });
});

describe("agent capability requests (#3072)", () => {
  let server: http.Server;
  const loadPath = "/home/claws/.claws/session-mcp/abc123/granted.env";
  // The row's capabilities, and those whose granted.env carries a marker.
  let rowCaps: string[] = [];
  let markedCaps: string[] = [];
  // Capabilities whose grant has not yet reached the pod.
  let landingCaps: string[] = [];
  // The live session's agent; browser is live-grantable only to claude.
  let liveProvider: "claude" | "codex" = "claude";
  const live = (id: string) => ({
    ok: true as const,
    session: { id, repo: "org/a", cwd: "/tmp/x", mode: "repo-claude" as const, provider: liveProvider, model: null, alive: true, summary: null, extraRepos: [], capabilities: [...rowCaps] },
  });
  const fakeBackend = {
    kind: "k8s-pod" as const,
    start: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    create: vi.fn(async () => ({ ok: false as const, reason: "backend-unavailable" as const })),
    createMulti: vi.fn(async () => ({ ok: false as const, reason: "backend-unavailable" as const })),
    resume: vi.fn(async () => ({ ok: false as const, reason: "backend-unavailable" as const })),
    end: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => ({ ok: true as const })),
    listLive: vi.fn(async () => []),
    getLive: vi.fn(async (id: string) => (id === "abc123" ? live(id) : { ok: false as const, reason: "not-found" as const })),
    getStartupStatus: vi.fn(async (id: string) => (id === "abc123"
      ? { ok: true as const, status: { state: "ready" as const, step: "Terminal ready", detail: null, startedAt: 1, elapsedMs: 2, terminalReadyAt: 2, failureReason: null } }
      : { ok: false as const, reason: "not-found" as const })),
    checkAttach: vi.fn(async () => ({ ok: true as const })),
    attach: vi.fn(),
    saveUpload: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
    saveUploadStream: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
    fetchFile: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
    setDescription: vi.fn(async () => ({ ok: false, description: null })),
    resummarize: vi.fn(async () => ({ ok: false, description: null })),
    switchClaudeAccount: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
    grantCapability: vi.fn(async (_id: string, capId: string) => {
      rowCaps.push(capId);
      if (capId === "browser") return { ok: true as const, live: true, loadPath: null, marker: null, delayed: true, landed: false, restarted: true };
      markedCaps.push(capId);
      return { ok: true as const, live: true, loadPath, marker: `# claws-granted: ${capId}`, delayed: false, landed: !landingCaps.includes(capId), restarted: false };
    }),
    grantDelivery: vi.fn(async (_id: string, capId: string) => (markedCaps.includes(capId)
      ? { ok: true as const, live: true, loadPath, marker: `# claws-granted: ${capId}`, delayed: false, landed: !landingCaps.includes(capId), restarted: false }
      : { ok: true as const, live: true, loadPath: null, marker: null, delayed: false, landed: true, restarted: false })),
    notifyAgent: vi.fn(async (_id: string, _text: string): Promise<"ok" | "unreachable" | "unsupported"> => "ok"),
    notifyAgentOnceReady: vi.fn(),
    revokeCapability: vi.fn(async (_id: string, capId: string) => {
      rowCaps = rowCaps.filter((c) => c !== capId);
      markedCaps = markedCaps.filter((c) => c !== capId);
      return { ok: true as const, live: true, keysRemoved: false };
    }),
    setAgentStatus: vi.fn(async (_id: string, status: "working" | "monitoring" | "waiting" | "done") => ({ ok: false, status, updatedAt: 0 })),
    recordPodExit: vi.fn(async () => "denied" as const),
  };
  const bearer = { Authorization: "Bearer test-internal-mcp-token" };
  const agentRequest = (body: unknown) => {
    testSessionCookie = null;
    return request(server, "POST", "/api/sessions/abc123/capability-requests", {
      headers: { "content-type": "application/json", ...bearer },
      body: JSON.stringify(body),
    });
  };

  /** Make the agent's last poll stale, so an approval does not wait for a pickup (#3106). */
  const stopPolling = async (capability: string) => {
    mockCapabilityRequestRows.rows.get(mockCapabilityRequestRows.key("abc123", capability))!.last_polled_at = 0;
  };

  beforeEach(async () => {
    mockCapabilityRequestRows.rows.clear();
    rowCaps = ["cross-repo", "ssh:thinkcentre"];
    markedCaps = [];
    landingCaps = [];
    liveProvider = "claude";
    fakeBackend.grantCapability.mockClear();
    fakeBackend.notifyAgent.mockClear();
    fakeBackend.notifyAgentOnceReady.mockClear();
    fakeBackend.grantDelivery.mockClear();
    fakeBackend.revokeCapability.mockClear();
    const { setSessionBackendForTests } = await import("./session-backend.js");
    setSessionBackendForTests(fakeBackend);
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    const { setSessionBackendForTests } = await import("./session-backend.js");
    setSessionBackendForTests(null);
  });

  it("creates a pending request with the agent's bearer token", async () => {
    const res = await agentRequest({ capability: "ssh:nas", reason: "check the ZFS pool" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "pending", capability: "ssh:nas", label: "SSH: nas (NixOS NAS)", reason: "check the ZFS pool" });

    const status = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(status.body)).toMatchObject({ status: "pending", capability: "ssh:nas" });
  });

  it("rejects a non-requestable capability with 400 listing the requestable ids", async () => {
    // browser is not requestable on a codex session (#clw_01M4RASNVDKH2YBHZMGR0SM0RA).
    liveProvider = "codex";
    const res = await agentRequest({ capability: "browser", reason: "scrape" });
    expect(res.status).toBe(400);
    const { error } = JSON.parse(res.body) as { error: string };
    expect(error).toContain("browser is not requestable");
    expect(error).toContain("ssh:nas");
    expect(error).not.toContain("ssh:thinkcentre");
    expect((await agentRequest({ capability: "ssh:nas" })).status).toBe(400);
  });

  it("reports a mid-session grant's load path from the backend even with no stored request (after a Claws restart)", async () => {
    rowCaps.push("ssh:nas");
    markedCaps.push("ssh:nas");
    const res = await agentRequest({ capability: "ssh:nas", reason: "zfs" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "granted", capability: "ssh:nas", loadPath, marker: "# claws-granted: ssh:nas", live: true });
    expect(fakeBackend.grantDelivery).toHaveBeenCalledWith("abc123", "ssh:nas");

    const status = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(status.body)).toMatchObject({ status: "granted", loadPath });
  });

  it("asks the backend again for an approved request, so a resume that cleared the marker reports nothing to load", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    expect(JSON.parse((await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve")).body)).toMatchObject({ loadPath });
    markedCaps = [];
    const status = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(status.body)).toMatchObject({ status: "granted", loadPath: null, marker: null, reason: "r" });
  });

  it("reports an already-granted capability as granted with its description and no load path", async () => {
    const res = await agentRequest({ capability: "ssh:thinkcentre", reason: "check the node" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "granted", capability: "ssh:thinkcentre", loadPath: null, live: true });
    expect(JSON.parse(res.body).description).toContain("SSH into thinkcentre");
  });

  it("returns 429 when the session already has five pending requests", async () => {
    const store = await import("./capability-requests.js");
    for (const cap of ["home-assistant", "forgejo", "ssh:ryzen", "forgejo-admin", "ssh:nas"]) {
      expect((await store.request("abc123", cap, "r")).ok).toBe(true);
    }
    expect((await agentRequest({ capability: "ssh:prod-cluster", reason: "r" })).status).toBe(429);
    // A repeat of an existing request is not a new pending entry.
    expect((await agentRequest({ capability: "ssh:nas", reason: "r" })).status).toBe(200);
  });

  it.each(["approve", "deny"])("%s rejects Bearer INTERNAL_MCP_TOKEN, so an agent cannot decide its own request", async (action) => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    const res = await request(server, "POST", `/sessions/abc123/capability-requests/ssh%3Anas/${action}`, { headers: bearer });
    expect([401, 503]).toContain(res.status);
    expect(fakeBackend.grantCapability).not.toHaveBeenCalled();
    const status = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(status.body).status).toBe("pending");
  });

  it("the pending list carries no upgrade notice", async () => {
    const db = await import("./db.js");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    vi.mocked(db.getPersistedSession).mockResolvedValueOnce({ id: "abc123", launched_version: "1.0.0-old" } as Awaited<ReturnType<typeof db.getPersistedSession>>);
    expect(JSON.parse((await request(server, "GET", "/sessions/abc123/capability-requests")).body)).not.toHaveProperty("upgradeNotice");
  });

  it("the pending list rejects bearer auth", async () => {
    testSessionCookie = null;
    expect((await request(server, "GET", "/sessions/abc123/capability-requests", { headers: bearer })).status).toBe(401);
  });

  it("approves with an OIDC session: grants, clears the pending list, and reports where to load", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "<img src=x onerror=alert(1)>" });
    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);

    const pending = await request(server, "GET", "/sessions/abc123/capability-requests");
    expect(pending.status).toBe(200);
    expect(JSON.parse(pending.body).requests).toEqual([
      expect.objectContaining({ capability: "ssh:nas", label: "SSH: nas (NixOS NAS)", reason: "<img src=x onerror=alert(1)>", status: "pending" }),
    ]);

    const approved = await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve");
    expect(approved.status).toBe(200);
    expect(JSON.parse(approved.body)).toMatchObject({ status: "granted", loadPath, live: true });
    expect(fakeBackend.grantCapability).toHaveBeenCalledWith("abc123", "ssh:nas");
    expect(JSON.parse((await request(server, "GET", "/sessions/abc123/capability-requests")).body).requests).toEqual([]);
    expect((await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve")).status).toBe(409);

    const status = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(status.body)).toMatchObject({ status: "granted", loadPath });
  });

  it("denies with an OIDC session, and a repeat request stays denied", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const denied = await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/deny");
    expect(denied.status).toBe(200);
    expect(JSON.parse(denied.body).status).toBe("denied");
    expect(fakeBackend.grantCapability).not.toHaveBeenCalled();
    expect(JSON.parse((await agentRequest({ capability: "ssh:nas", reason: "please" })).body).status).toBe("denied");
  });

  it("maps a failed grant to its status and leaves the request pending", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    fakeBackend.grantCapability.mockResolvedValueOnce({ ok: false, reason: "unavailable", detail: "busy" } as never);
    const res = await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toContain("busy");
    expect(JSON.parse((await request(server, "GET", "/sessions/abc123/capability-requests")).body).requests).toHaveLength(1);
  });

  it("tells a grant to a session that is no longer live apart from a request that is gone", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    fakeBackend.grantCapability.mockResolvedValueOnce({ ok: false, reason: "not-found" } as never);
    const failed = await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve");
    expect(failed.status).toBe(404);
    expect(JSON.parse(failed.body).code).toBe("session-not-found");
    const gone = await request(server, "POST", "/sessions/abc123/capability-requests/home-assistant/approve");
    expect(gone.status).toBe(404);
    expect(JSON.parse(gone.body).code).toBe("no-request");
  });

  it("a revoke drops the granted request, so a later request starts fresh", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    expect((await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve")).status).toBe(200);

    const revoked = await request(server, "DELETE", "/sessions/abc123/capabilities/ssh%3Anas");
    expect(revoked.status).toBe(200);
    expect(JSON.parse(revoked.body)).toEqual({ live: true, keysRemoved: false });
    expect(fakeBackend.revokeCapability).toHaveBeenCalledWith("abc123", "ssh:nas");

    expect(JSON.parse((await agentRequest({ capability: "ssh:nas", reason: "again" })).body)).toMatchObject({ status: "pending", reason: "again" });
  });

  it.each(["kill", "delete"])("%s clears the session's requests", async (action) => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    expect((await request(server, "POST", `/sessions/abc123/${action}`)).status).toBe(303);
    expect(JSON.parse((await request(server, "GET", "/sessions/abc123/capability-requests")).body).requests).toEqual([]);
  });

  it("an operator grant through the Grant control resolves a pending request", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const grant = await request(server, "POST", "/sessions/abc123/capabilities", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "ssh:nas" }),
    });
    expect(grant.status).toBe(200);
    expect(JSON.parse(grant.body)).toMatchObject({ agentPickedUp: false, agentNotified: true, notifyFailure: null });
    expect(fakeBackend.notifyAgent).toHaveBeenCalledWith("abc123", expect.stringContaining('capability "ssh:nas"'));
    expect(JSON.parse((await request(server, "GET", "/sessions/abc123/capability-requests")).body).requests).toEqual([]);
    const status = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(status.body)).toMatchObject({ status: "granted", loadPath });
  });

  it("agent polls record lastPolledAt, and a granted response records grantSeenAt (#3106)", async () => {
    const store = await import("./capability-requests.js");
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    await stopPolling("ssh:nas");
    await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect((await store.get("abc123", "ssh:nas"))!.lastPolledAt).toBeGreaterThan(0);
    await stopPolling("ssh:nas");
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    expect((await store.get("abc123", "ssh:nas"))!.lastPolledAt).toBeGreaterThan(0);
    expect((await store.get("abc123", "ssh:nas"))!.grantSeenAt).toBeNull();

    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve");
    expect((await store.get("abc123", "ssh:nas"))!.grantSeenAt).toBeNull();
    await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect((await store.get("abc123", "ssh:nas"))!.grantSeenAt).toBeGreaterThan(0);
  });

  it("approval of a request the agent stopped waiting on types the notice into its terminal server-side (#3106)", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "SECRET-REASON" });
    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const approved = JSON.parse((await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve")).body);
    expect(approved).toMatchObject({ status: "granted", agentPickedUp: false, agentNotified: true, notifyFailure: null });
    expect(approved).not.toHaveProperty("agentNotice");
    const [[, notice]] = fakeBackend.notifyAgent.mock.calls;
    expect(notice).toContain('Call claws_request_capability with capability "ssh:nas" and timeout_seconds 0');
    expect(notice).not.toContain("SECRET-REASON");
  });

  it("approval reports a notice that could not reach the agent's terminal", async () => {
    fakeBackend.notifyAgent.mockResolvedValueOnce("unreachable");
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const approved = JSON.parse((await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve")).body);
    expect(approved).toMatchObject({ status: "granted", agentPickedUp: false, agentNotified: false, notifyFailure: "unreachable" });
  });

  it("reports a live grant that has not reached the pod as landing, then granted once it lands", async () => {
    landingCaps = ["ssh:nas"];
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const approved = JSON.parse((await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve")).body);
    expect(approved).toMatchObject({ status: "landing", landed: false });
    const polled = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(polled.body)).toMatchObject({ status: "landing", landed: false });
    landingCaps = [];
    const landed = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(landed.body)).toMatchObject({ status: "granted", landed: true });
  });

  it("approval waits for a polling agent to collect the grant and sends no notice (#3106)", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const approving = request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve");
    const store = await import("./capability-requests.js");
    const deadline = Date.now() + 2000;
    while ((await store.get("abc123", "ssh:nas"))?.status !== "approved" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const polled = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(polled.body).status).toBe("granted");
    const approved = await approving;
    expect(JSON.parse(approved.body)).toMatchObject({ status: "granted", agentPickedUp: true, agentNotified: false, notifyFailure: null });
    expect(fakeBackend.notifyAgent).not.toHaveBeenCalled();
  });

  it("the Grant control tells the agent even without a pending request", async () => {
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const grant = await request(server, "POST", "/sessions/abc123/capabilities", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "ssh:nas" }),
    });
    expect(grant.status).toBe(200);
    expect(JSON.parse(grant.body)).toMatchObject({ landed: true, agentPickedUp: false, agentNotified: true, notifyFailure: null });
    expect(fakeBackend.notifyAgent).toHaveBeenCalledWith("abc123", expect.stringContaining("You now hold it"));
  });

  it("the Grant control grants browser to a claude session by restarting it, and queues the agent's notice (#clw_01M4RASNVDKH2YBHZMGR0SM0RA)", async () => {
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const grant = await request(server, "POST", "/sessions/abc123/capabilities", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "browser" }),
    });
    expect(grant.status).toBe(200);
    expect(JSON.parse(grant.body)).toMatchObject({ live: true, landed: false, restarted: true, agentNoticeQueued: true, agentNotified: false });
    expect(fakeBackend.notifyAgent).not.toHaveBeenCalled();
    expect(fakeBackend.notifyAgentOnceReady).toHaveBeenCalledWith("abc123", expect.stringContaining("restarted your agent with the conversation kept"));
  });

  it("an agent may request browser on a claude session, and approval reports the restart", async () => {
    expect((await agentRequest({ capability: "browser", reason: "check the page" })).status).toBe(200);
    await stopPolling("browser");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const approved = await request(server, "POST", "/sessions/abc123/capability-requests/browser/approve");
    expect(approved.status).toBe(200);
    expect(JSON.parse(approved.body)).toMatchObject({ restarted: true, agentNoticeQueued: true });
    expect(fakeBackend.notifyAgentOnceReady).toHaveBeenCalledTimes(1);
  });

  it("GET status is 404 when there is no request and the capability is not granted", async () => {
    testSessionCookie = null;
    const res = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(res.status).toBe(404);
  });
});


describe("Claws-native issue routes", () => {
  let server: http.Server;

  const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
  const nativeIssue = {
    id: NATIVE,
    title: "Native issue",
    body: "Body",
    author_login: "stjohnb",
    state: "open",
    state_reason: null,
    created_at: "2026-09-21 09:00:00",
    updated_at: "2026-09-21 10:00:00",
    repos: ["org/repo"],
    labels: [] as string[],
    // Awaiting plan review: a posted plan, approved through Requirements only.
    lifecycle: "awaiting-plan-review",
    approved_through: "requirements",
    requirements_approved_at: null,
  };
  // A stored plan version: Approved and Awaiting plan review need one.
  const PLAN_ROW = { version: 1, commentId: null, body: "## Implementation Plan\n\nDo it.", createdAt: "" };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetIssueFlight();
    mockClawsIssues.getIssue.mockImplementation(async (ref: string) =>
      (String(ref).toUpperCase().endsWith(NATIVE.slice(4)) ? { ...nativeIssue } : undefined));
    mockClawsIssues.listCommentDetails.mockResolvedValue([]);
    mockClawsIssues.listPlans.mockResolvedValue([]);
    mockClawsIssues.getLatestPlansForOpenIssues.mockResolvedValue(new Map());
    mockClawsIssues.listUnassignedOpenIssues.mockResolvedValue([]);
    mockClawsIssues.getIssueBodyHtml.mockResolvedValue("<p>Body</p>");
    mockClawsIssues.createIssue.mockResolvedValue(NATIVE);
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([]);
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("GET /issues/new offers a checkbox per managed repo and per declared label", async () => {
    const res = await request(server, "GET", "/issues/new");
    expect(res.status).toBe(200);
    expect(res.body).toContain('value="org/repo"');
    expect(res.body).toContain('value="Priority"');
    // Lifecycle state is set by moving the issue, not by a checkbox.
    expect(res.body).not.toContain('value="Refined"');
  });

  it("GET /issues/new?repo= pre-checks a managed repository, and nothing for an unknown one", async () => {
    const res = await request(server, "GET", "/issues/new?repo=org%2Frepo");
    expect(res.body).toContain('name="repo" value="org/repo" checked');
    const stale = await request(server, "GET", "/issues/new?repo=gone%2Frepo");
    expect(stale.body).not.toMatch(/name="repo" value="[^"]+" checked/);
  });

  it("POST /issues creates the issue as the first allowed actor and redirects to it", async () => {
    const res = await request(server, "POST", "/issues", {
      body: "title=New+thing&body=Some+context&repo=org%2Frepo&label=Priority&label=Ready&label=Bogus&repo=not%2Fmanaged",
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/issues/${NATIVE}`);
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith({
      title: "New thing",
      body: "Some context",
      authorLogin: "stjohnb",
      autoPromote: false,
      requirementsStage: true,
      repos: ["org/repo"],
      labels: ["Priority"],
      source: "dashboard",
    });
  });

  it("POST /issues takes the Requirements choice as the per-issue promotion override", async () => {
    await request(server, "POST", "/issues", { body: "title=A&repo=org%2Frepo&autoPromote=auto" });
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ source: "dashboard", autoPromote: true }));
    await request(server, "POST", "/issues", { body: "title=B&repo=org%2Frepo&autoPromote=wait" });
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ autoPromote: false }));
    await request(server, "POST", "/issues", { body: "title=C&repo=org%2Frepo" });
    // A dashboard issue always carries an explicit override, even with the field absent or empty.
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ autoPromote: false }));
    await request(server, "POST", "/issues", { body: "title=D&repo=org%2Frepo&autoPromote=" });
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ autoPromote: false, requirementsStage: true }));
    // Skip turns the requirements stage off, with no override.
    await request(server, "POST", "/issues", { body: "title=E&repo=org%2Frepo&autoPromote=skip" });
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ source: "dashboard", requirementsStage: false }));
    expect(mockClawsIssues.createIssue.mock.lastCall![0]).not.toHaveProperty("autoPromote");
  });

  describe("POST /issues/:id/comments/:commentId/delete", () => {
    const COMMENT = "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const del = () => request(server, "POST", `/issues/${NATIVE}/comments/${COMMENT}/delete`);

    it("soft-deletes as the operator and redirects to the comments, enqueuing nothing", async () => {
      const res = await del();
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe(`/issues/${NATIVE}#comments`);
      expect(mockClawsIssues.deleteIssueComments).toHaveBeenCalledWith(NATIVE, [COMMENT], expect.stringMatching(/^operator:/));
      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    });

    it("answers 409 for the plan comment and 404 for a foreign one", async () => {
      mockClawsIssues.deleteIssueComments.mockRejectedValueOnce(new mockClawsIssues.IssueCommentDeleteError("refused", "current plan"));
      expect((await del()).status).toBe(409);
      mockClawsIssues.deleteIssueComments.mockRejectedValueOnce(new mockClawsIssues.IssueCommentDeleteError("not-found", "not here"));
      expect((await del()).status).toBe(404);
    });

    it("answers 404 for an unknown issue without deleting", async () => {
      const res = await request(server, "POST", `/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDZ/comments/${COMMENT}/delete`);
      expect(res.status).toBe(404);
      expect(mockClawsIssues.deleteIssueComments).not.toHaveBeenCalled();
    });

    it("renders a confirm-guarded Delete on each comment of the issue page", async () => {
      mockClawsIssues.listCommentDetails.mockResolvedValue([{ id: COMMENT, login: "stjohnb", body: "noise", body_html: "", createdAt: "2026-09-21T09:00:00.000Z" }]);
      const res = await request(server, "GET", `/issues/${NATIVE}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain(`action="/issues/${NATIVE}/comments/${COMMENT}/delete"`);
      expect(res.body).toContain("return confirm(");
    });
  });

  describe("links", () => {
    const OTHER = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";
    const API = { authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };

    it("POST /issues resolves links before creating, and adds them after", async () => {
      const res = await request(server, "POST", "/issues", {
        body: `title=Dependent&repo=org%2Frepo&depends_on=${OTHER}%2C+org%2Fb%2312&relates_to=`,
      });
      expect(res.status).toBe(303);
      expect(mockIssueLinks.resolveLinkTarget).toHaveBeenCalledWith("org/b#12", "org/repo");
      expect(mockIssueLinks.addLink).toHaveBeenCalledWith("org/repo", NATIVE, "depends_on", OTHER, "stjohnb");
      expect(mockIssueLinks.addLink).toHaveBeenCalledWith("org/repo", NATIVE, "depends_on", "org/b#12", "stjohnb");
      expect(mockIssueLinks.addLink).toHaveBeenCalledTimes(2);
    });

    it("POST /issues with an unresolvable link fails before the issue is written", async () => {
      const { LinkError } = await import("./issue-links.js");
      mockIssueLinks.resolveLinkTarget.mockRejectedValueOnce(new LinkError("org/b#99 is not tracked by Claws, so it cannot be linked.", 400));
      const res = await request(server, "POST", "/issues", { body: "title=Dependent&repo=org%2Frepo&blocks=org%2Fb%2399" });
      expect(res.status).toBe(400);
      expect(res.body).toContain("not tracked by Claws");
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("GET /issues/:id renders the issue's links", async () => {
      mockIssueLinks.listLinks.mockResolvedValueOnce([{ id: "cll_1", kind: "depends_on", otherId: OTHER, otherTitle: "The dependency", otherState: "open", otherStateReason: null, otherStage: "planning", otherStageTitle: "Planning", releasedAt: null }]);
      const res = await request(server, "GET", `/issues/${NATIVE}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain(`<a href="/issues/${OTHER}">The dependency</a>`);
    });

    it("POST /issues/:id/links adds a link as the operator and redirects back", async () => {
      const res = await request(server, "POST", `/issues/${NATIVE}/links`, { body: `kind=blocks&issue=${OTHER}` });
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe(`/issues/${NATIVE}#links`);
      expect(mockIssueLinks.addLink).toHaveBeenCalledWith("org/repo", NATIVE, "blocks", OTHER, "stjohnb");
    });

    it("POST /issues/:id/links refuses an unknown kind and reports a rejected ref", async () => {
      const bad = await request(server, "POST", `/issues/${NATIVE}/links`, { body: `kind=duplicate_of&issue=${OTHER}` });
      expect(bad.status).toBe(400);
      expect(mockIssueLinks.addLink).not.toHaveBeenCalled();

      const { LinkError } = await import("./issue-links.js");
      mockIssueLinks.addLink.mockRejectedValueOnce(new LinkError("An issue cannot be linked to itself.", 400));
      const self = await request(server, "POST", `/issues/${NATIVE}/links`, { body: `kind=depends_on&issue=${NATIVE}` });
      expect(self.status).toBe(400);
      expect(self.body).toContain("cannot be linked to itself");
    });

    it("POST /issues/:id/links/:linkId/delete removes the link", async () => {
      const res = await request(server, "POST", `/issues/${NATIVE}/links/cll_1/delete`);
      expect(res.status).toBe(303);
      expect(mockIssueLinks.removeLink).toHaveBeenCalledWith("org/repo", NATIVE, "cll_1");
    });

    it("the links API records a bearer-token write as the agent via MCP, for the issue's History", async () => {
      let actor: IssueActor | undefined;
      mockIssueLinks.addLink.mockImplementationOnce(async () => { actor = currentIssueActor(); return { link: { id: "cll_1" }, created: true, parked: false } as any; });
      const add = await request(server, "POST", `/api/issues/${NATIVE}/links`, { headers: API, body: JSON.stringify({ kind: "depends_on", issue: OTHER }) });
      expect(add.status).toBe(201);
      expect(actor).toEqual({ kind: "automation", name: "agent via MCP" });
    });

    it("the links API lists, adds as Claws and removes, and 404s a shadow", async () => {
      mockIssueLinks.listLinks.mockResolvedValueOnce([{ id: "cll_1" }]);
      const list = await request(server, "GET", `/api/issues/${NATIVE}/links`, { headers: API });
      expect(list.status).toBe(200);
      expect(JSON.parse(list.body)).toEqual({ issue: NATIVE, links: [{ id: "cll_1" }] });

      const add = await request(server, "POST", `/api/issues/${NATIVE}/links`, { headers: API, body: JSON.stringify({ kind: "depends_on", issue: OTHER }) });
      expect(add.status).toBe(201);
      expect(mockIssueLinks.addLink).toHaveBeenCalledWith("org/repo", NATIVE, "depends_on", OTHER, "claws");

      const badKind = await request(server, "POST", `/api/issues/${NATIVE}/links`, { headers: API, body: JSON.stringify({ kind: "nope", issue: OTHER }) });
      expect(badKind.status).toBe(400);

      const del = await request(server, "DELETE", `/api/issues/${NATIVE}/links/cll_1`, { headers: API });
      expect(del.status).toBe(200);
      expect(mockIssueLinks.removeLink).toHaveBeenCalledWith("org/repo", NATIVE, "cll_1");

      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, kind: "shadow" });
      const shadow = await request(server, "GET", `/api/issues/${NATIVE}/links`, { headers: API });
      expect(shadow.status).toBe(404);
    });
  });

  describe("session gate writes (#clw_01M3BWP83BQRXE06NWW1GKYT2S)", () => {
    // The three write routes take only a bearer `verifyMcpToken` accepts for
    // the exact `:sid` in the URL — never the shared internal token, which
    // `READ_API` below still carries for the read-only model-plan route.
    const SESSION_TOKEN = "session-own-mcp-token";
    const API = { authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/json" };
    const READ_API = { authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };
    const SID = "abc123";
    const fakeBackend = {
      getLive: vi.fn(async (id: string) => (id === SID
        ? { ok: true as const, session: { id, repo: "org/repo", cwd: "/tmp/x", mode: "repo-claude" as const, provider: "claude" as const, model: null, alive: true, summary: null, extraRepos: [], capabilities: [] } }
        : { ok: false as const, reason: "not-found" as const })),
      verifyMcpToken: vi.fn(async (id: string, token: string) => (id === SID && token === SESSION_TOKEN ? "ok" as const : "denied" as const)),
      kind: "k8s-pod" as const,
      create: vi.fn(async (_req: Record<string, unknown>) => ({ ok: true as const, id: "def456" }) as { ok: true; id: string } | { ok: false; reason: string; detail?: string }),
      createMulti: vi.fn(async (_req: Record<string, unknown>) => ({ ok: true as const, id: "def789" }) as { ok: true; id: string } | { ok: false; reason: string; detail?: string }),
    };
    /** `fakeBackend`'s live session for `SID`, holding `capabilities`. */
    const liveWithCapabilities = (capabilities: string[]) =>
      ({ ok: true as const, session: { id: SID, repo: "org/repo", cwd: "/tmp/x", mode: "repo-claude" as const, provider: "claude" as const, model: null, alive: true, summary: null, extraRepos: [], capabilities: capabilities as never[] } });
    const setLabel = (label: string, present: boolean, sid = SID, reason?: string) =>
      request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/labels`, { headers: API, body: JSON.stringify({ label, present, reason }) });
    const withIssue = (patch: Record<string, unknown>) => mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, ...patch });

    beforeEach(async () => {
      const { setSessionBackendForTests } = await import("./session-backend.js");
      setSessionBackendForTests(fakeBackend as any);
    });

    afterEach(async () => {
      const { setSessionBackendForTests } = await import("./session-backend.js");
      setSessionBackendForTests(null);
    });

    // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F: the gate labels are an approval now.
    it.each(["Refined", "Automerge", "Ship", "Claws Auto-Refine", "Ready"])("refuses %s, pointing at claws_set_issue_approval", async (label) => {
      const gh = await import("./github.js");
      for (const present of [true, false]) {
        const res = await setLabel(label, present);
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toBe(`${label} is not a label any more — use claws_set_issue_approval`);
      }
      expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
      expect(gh.addLabel).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("answers changed:false and posts nothing for a state already in place", async () => {
      const gh = await import("./github.js");
      withIssue({ labels: ["Priority"] });
      for (const [label, present] of [["Blocked", false], ["Priority", true], ["Use Codex", false]] as const) {
        const res = await setLabel(label, present);
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).changed).toBe(false);
      }
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
      expect(gh.addLabel).not.toHaveBeenCalled();
      expect(gh.removeLabel).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
    });

    it.each([
      ["no reason", undefined],
      ["a blank reason", "   "],
    ])("refuses Blocked with %s, leaving the issue as it was", async (_name, reason) => {
      const gh = await import("./github.js");
      const res = await setLabel("Blocked", true, SID, reason);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toBe("A reason is required to mark an issue Blocked.");
      expect(mockClawsIssues.blockIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("refuses a reason that is not a string", async () => {
      const res = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/labels`, { headers: API, body: JSON.stringify({ label: "Blocked", present: true, reason: 5 }) });
      expect(res.status).toBe(400);
      expect(mockClawsIssues.blockIssue).not.toHaveBeenCalled();
    });

    it("sets and clears Blocked, clearing to where a dependency release sends the issue", async () => {
      expect((await setLabel("Blocked", true, SID, "Waiting on the vendor")).status).toBe(200);
      expect(mockClawsIssues.blockIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Waiting on the vendor");
      withIssue({ lifecycle: "blocked" });
      mockClawsIssues.listPlans.mockResolvedValue([]);
      expect((await setLabel("Blocked", false)).status).toBe(200);
      expect(mockClawsIssues.demoteIssue).toHaveBeenCalledWith(NATIVE);
    });

    // #clw_01M646SBH8GCQ592CFV4SRMVK4: the reply's `column` is the derived
    // board stage the tracker reads show, not only the stored lifecycle.
    it("answers a label write with the board column the issue reads show, alongside the stored lifecycle", async () => {
      withIssue({ lifecycle: "awaiting-plan-review", approved_through: "plan" });
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      mockIssueFlight.loadIssueFlight.mockResolvedValue({
        implementing: false,
        openPrs: [{ repo: "org/repo", number: 7, stage: "awaiting-review", merge_approved_at: null, needs_human_review: 0 }],
      });
      const res = await setLabel("Use Codex", true);
      expect(res.status).toBe(200);
      const reply = JSON.parse(res.body);
      const read = JSON.parse((await request(server, "GET", `/api/issues/${NATIVE}`, { headers: READ_API })).body);
      expect(reply.lifecycle).toBe("awaiting-plan-review");
      expect(reply.column).not.toBe("awaiting-plan-review");
      expect(reply.column).toBe(read.stage);
      expect(reply.approved_through).toBe(read.approved_through);
      expect(reply.stops_at).toBe(read.stops_at);
    });

    // A dependency release keeps a planned issue's plan and sends it to plan
    // review rather than throwing the plan away with a re-plan — clearing
    // Blocked from a session must land the same place (clawsIssues.releaseLifecycle).
    it("clears Blocked from a planned issue to Awaiting plan review, queuing no re-plan", async () => {
      const worker = await import("./worker.js");
      withIssue({ lifecycle: "blocked" });
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      const res = await setLabel("Blocked", false);
      expect(res.status).toBe(200);
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");
      expect(mockClawsIssues.demoteIssue).not.toHaveBeenCalled();
      expect(worker.enqueue).not.toHaveBeenCalled();
    });

    // The planner's blocked verdict is stored as a plan version too, so it
    // must not be mistaken for a real plan: it re-plans through Planning, the
    // same as a dependency release finding a blocked-verdict plan.
    it("clears Blocked from a blocked-verdict issue back to Planning, queuing a re-plan", async () => {
      const worker = await import("./worker.js");
      withIssue({ lifecycle: "blocked", requirements_approved_at: "2026-09-21 09:30:00" });
      mockClawsIssues.listPlans.mockResolvedValue([{
        ...PLAN_ROW,
        body: "The planner determined this issue is blocked on an external precondition and cannot be implemented yet.",
      }]);
      const res = await setLabel("Blocked", false);
      expect(res.status).toBe(200);
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "planning");
      expect(worker.enqueue).toHaveBeenCalledWith(worker.AGENT_KINDS.ISSUE_REFINER_REPLAN, "org/repo", NATIVE, expect.anything());
    });

    it("clears Blocked from an issue with an open PR, landing in its derived column", async () => {
      withIssue({ lifecycle: "blocked" });
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [{ repo: "org/repo", prNumber: 7, stage: "awaiting-merge", mergeApprovedAt: null }] as any[] });
      const res = await setLabel("Blocked", false);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ ok: true });
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");
    });

    it("clears Blocked from an issue with a running implementer", async () => {
      withIssue({ lifecycle: "blocked" });
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: true, openPrs: [] });
      const res = await setLabel("Blocked", false);
      expect(res.status).toBe(200);
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");
    });

    it("adds and removes Priority", async () => {
      const gh = await import("./github.js");
      expect((await setLabel("Priority", true)).status).toBe(200);
      expect(gh.addLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Priority");
      withIssue({ labels: ["Priority"] });
      expect((await setLabel("Priority", false)).status).toBe(200);
      expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Priority");
    });

    describe("the approval route (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F)", () => {
      const setApproval = (through: unknown, sid = SID, id: string = NATIVE) =>
        request(server, "POST", `/api/sessions/${sid}/issues/${id}/approval`, { headers: API, body: JSON.stringify({ through }) });
      /** Make the mocked writer store what it was asked for, so the re-read sees it. */
      const storing = () => mockIssueApproval.applyIssueApproval.mockImplementationOnce(async (_repo: string, _ref: unknown, through: string) => {
        withIssue({ ...currentPatch, approved_through: through });
        return { ok: true, trackerId: NATIVE, before: "requirements", after: through, changed: true, openPrs: 0 };
      });
      let currentPatch: Record<string, unknown> = {};
      const at = (patch: Record<string, unknown>) => { currentPatch = patch; withIssue(patch); };

      beforeEach(() => {
        currentPatch = {};
        mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      });
      // A promotion test's Requirements review must not outlive it, even when its request rejects.
      afterEach(() => {
        mockClawsIssues.isAwaitingRequirementsReview.mockReset().mockResolvedValue(false);
      });

      it("approves the plan of an issue in Awaiting plan review as session:<sid>, answering the new column and stop", async () => {
        at({});
        storing();
        const res = await setApproval("plan");
        expect(res.status).toBe(200);
        expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "session:abc123", { promote: expect.any(Function) });
        expect(JSON.parse(res.body)).toEqual({ approved_through: "plan", column: "approved", stops_at: "Stops at: merge approval" });
      });

      // #clw_01M5YJ6F1BYDXHGYMC15DZHV25: the PR columns read the stored value, so Plan is approvable there.
      it("approves through Plan on an issue with an open PR and a stored value below Plan", async () => {
        at({ approved_through: "requirements" });
        mockIssueFlight.loadIssueFlight.mockResolvedValue({
          implementing: false,
          openPrs: [{ repo: "org/repo", number: 7, stage: "awaiting-review", merge_approved_at: null, needs_human_review: 0 }],
        });
        storing();
        const res = await setApproval("plan");
        expect(res.status).toBe(200);
        expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "session:abc123", expect.anything());
      });

      it("approves through Merge in one write, pre-approving it ahead of the PR", async () => {
        at({});
        storing();
        const res = await setApproval("merge");
        expect(res.status).toBe(200);
        expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledTimes(1);
        expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "merge", "session:abc123", expect.anything());
        expect(JSON.parse(res.body)).toEqual({ approved_through: "merge", column: "approved", stops_at: "Runs to merge — no further stop" });
      });

      // Decision 8: lowering to Requirements is how a session sends a planned
      // issue back to plan review, from any column.
      it("lowers an approved issue to Requirements, sending it back to plan review", async () => {
        at({ approved_through: "plan" });
        storing();
        const res = await setApproval("requirements");
        expect(res.status).toBe(200);
        expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "requirements", "session:abc123", expect.anything());
        expect(JSON.parse(res.body)).toMatchObject({ approved_through: "requirements", column: "awaiting-plan-review", stops_at: "Stops at: plan review" });
      });

      it("lowers to Requirements even from a column whose gates are read-only", async () => {
        at({ lifecycle: "blocked", approved_through: "merge" });
        storing();
        const res = await setApproval("requirements");
        expect(res.status).toBe(200);
        expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "requirements", "session:abc123", expect.anything());
      });

      it("lowers Merge to Plan where the Merge gate offers its withdrawal, and refuses it where it does not", async () => {
        at({ approved_through: "merge" });
        storing();
        expect((await setApproval("plan")).status).toBe(200);
        expect(mockIssueApproval.applyIssueApproval).toHaveBeenLastCalledWith("org/repo", NATIVE, "plan", "session:abc123", expect.anything());

        mockIssueApproval.applyIssueApproval.mockClear();
        at({ lifecycle: "blocked", approved_through: "merge" });
        const refused = await setApproval("plan");
        expect(refused.status).toBe(409);
        expect(JSON.parse(refused.body).error).toMatch(/^Merge cannot be withdrawn here: Merge approved .* not settable in this column$/);
        expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      });

      it("refuses a raise the gate does not offer, naming the gate", async () => {
        at({ lifecycle: "blocked" });
        const res = await setApproval("plan");
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body).error).toBe("Plan cannot be approved here: Plan not yet approved — not settable in this column");
        expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      });

      it("writes nothing for the approval the issue already has", async () => {
        at({ approved_through: "plan" });
        const res = await setApproval("plan");
        expect(res.status).toBe(200);
        expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
        expect(JSON.parse(res.body)).toEqual({ approved_through: "plan", column: "approved", stops_at: "Stops at: merge approval" });
      });

      it("restating Merge writes it onto an open PR row left without its merge approval", async () => {
        at({ approved_through: "merge" });
        mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow({ issueId: NATIVE, mergeApprovedAt: null })] as any[] });
        mockIssueApproval.applyIssueApproval.mockResolvedValueOnce({ ok: true, trackerId: NATIVE, before: "merge", after: "merge", changed: false, openPrs: 1 });
        try {
          const res = await setApproval("merge");
          expect(res.status).toBe(200);
          expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "merge", "session:abc123", expect.anything());
        } finally {
          mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [] });
        }
      });

      it("restating Merge writes nothing when every open PR row already has its merge approval", async () => {
        at({ approved_through: "merge" });
        mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow({ issueId: NATIVE, mergeApprovedAt: "2026-09-26T00:00:00Z" })] as any[] });
        try {
          const res = await setApproval("merge");
          expect(res.status).toBe(200);
          expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
        } finally {
          mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [] });
        }
      });

      it("refuses none and anything that is not a gate with a 400", async () => {
        const none = await setApproval("none");
        expect(none.status).toBe(400);
        expect(JSON.parse(none.body).error).toBe("Approval cannot be withdrawn below Requirements — send the issue back to Ideas instead");
        for (const bad of ["Refined", 3, null]) expect((await setApproval(bad)).status).toBe(400);
        expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      });

      it("answers the writer's refusal as its own status", async () => {
        at({});
        mockIssueApproval.applyIssueApproval.mockResolvedValueOnce({ ok: false, status: 409, error: "The issue changed since it was read — reload and try again." });
        const res = await setApproval("plan");
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body).error).toBe("The issue changed since it was read — reload and try again.");
      });

      // AC5: approving Requirements in Requirements review promotes the issue as claws_promote_issue does.
      /** The writer, running the route's promotion for an issue still in Ideas. */
      const promoting = () => mockIssueApproval.applyIssueApproval.mockImplementationOnce(async (_repo: string, _ref: unknown, through: string, _by: string, opts?: any) => {
        const promoted = await opts.promote();
        if (!promoted.ok) return promoted;
        return { ok: true, trackerId: NATIVE, before: "none", after: through, changed: true, openPrs: 0 };
      });

      it("promotes an issue in Requirements review as session:<sid> when it approves the requirements", async () => {
        at({ lifecycle: "ideas", approved_through: "none", requirements_approved_at: null });
        mockClawsIssues.listPlans.mockResolvedValue([]);
        mockClawsIssues.isAwaitingRequirementsReview.mockResolvedValue(true);
        promoting();
        const res = await setApproval("requirements");
        expect(res.status).toBe(200);
        expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "session:abc123", "ideas");
      });

      it("answers a promotion lost to a concurrent move as its own status", async () => {
        at({ lifecycle: "ideas", approved_through: "none", requirements_approved_at: null });
        mockClawsIssues.promoteIssue.mockResolvedValueOnce(false);
        mockClawsIssues.listPlans.mockResolvedValue([]);
        mockClawsIssues.isAwaitingRequirementsReview.mockResolvedValue(true);
        promoting();
        const res = await setApproval("requirements");
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body).error).toBe("The issue changed since this page loaded — reload and try again.");
      });

      it("404s an unknown issue", async () => {
        expect((await setApproval("plan", SID, "clw_00000000000000000000000000")).status).toBe(404);
        expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      });
    });

    it("refuses a label the Labels form does not offer", async () => {
      expect((await setLabel("Ready", true)).status).toBe(400);
      expect((await setLabel("Backlog", true)).status).toBe(400);
      expect((await setLabel("Claws Staging", true)).status).toBe(400);
      expect((await setLabel("Claws Ignore", true)).status).toBe(400);
      expect((await setLabel("Not A Label", true)).status).toBe(400);
    });

    it("adds and removes the Labels form's other labels, auditing each change", async () => {
      const gh = await import("./github.js");
      expect((await setLabel("Use Codex", true)).status).toBe(200);
      expect(gh.addLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Use Codex");
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` applied **Use Codex**.");
      withIssue({ labels: ["Use Codex"] });
      const same = await setLabel("Use Codex", true);
      expect(JSON.parse(same.body).changed).toBe(false);
      expect((await setLabel("Use Codex", false)).status).toBe(200);
      expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Use Codex");
      withIssue({});
      const absent = await setLabel("Use Codex", false);
      expect(JSON.parse(absent.body).changed).toBe(false);
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(2);
    });

    const setState = (body: Record<string, unknown>, sid = SID) =>
      request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/state`, { headers: API, body: JSON.stringify(body) });

    describe("an issue whose repos are all unconfigured", () => {
      it("can be closed and have plain labels edited, but not moved through the lifecycle", async () => {
        const gh = await import("./github.js");
        withIssue({ repos: ["org/gone"], labels: ["Use Codex"] });
        const closed = await setState({ state: "closed", reason: "not_planned" });
        expect(closed.status).toBe(200);
        expect(gh.closeIssue).toHaveBeenLastCalledWith("org/gone", NATIVE, "not_planned");

        const plain = await setLabel("Use Codex", false);
        expect(plain.status).toBe(200);

        const blocked = await setLabel("Blocked", true, SID, "waiting");
        expect(blocked.status).toBe(409);
        expect(JSON.parse(blocked.body).error).toContain("org/gone");
        expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
        expect(mockClawsIssues.blockIssue).not.toHaveBeenCalled();
      });

      it("keeps the 403 when another of the issue's repos is configured", async () => {
        withIssue({ repos: ["org/gone", "org/repo"] });
        const res = await setState({ state: "closed", reason: "not_planned" });
        expect(res.status).toBe(403);
      });
    });

    it("closes an issue as completed or not planned, and reopens a closed one, auditing each", async () => {
      const gh = await import("./github.js");
      const done = await setState({ state: "closed", reason: "completed" });
      expect(done.status).toBe(200);
      expect(gh.closeIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "completed");
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` closed this issue as completed.");
      expect((await setState({ state: "closed", reason: "not_planned" })).status).toBe(200);
      expect(gh.closeIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "not_planned");
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` closed this issue as not planned.");

      withIssue({ state: "closed", state_reason: "completed" });
      const reopened = await setState({ state: "open" });
      expect(reopened.status).toBe(200);
      expect(mockClawsIssues.reopenIssue).toHaveBeenCalledWith(NATIVE);
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` reopened this issue.");
    });

    it("refuses a state already in place, a bad state, and closing without a reason", async () => {
      const gh = await import("./github.js");
      const open = await setState({ state: "open" });
      expect(open.status).toBe(409);
      expect(JSON.parse(open.body).error).toBe("The issue is already open.");
      expect((await setState({ state: "closed" })).status).toBe(400);
      expect((await setState({ state: "closed", reason: "wontfix" })).status).toBe(400);
      expect((await setState({ state: "done" })).status).toBe(400);
      withIssue({ state: "closed" });
      expect((await setState({ state: "closed", reason: "completed" })).status).toBe(409);
      expect(gh.closeIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("closes an unassigned issue, as the dashboard does", async () => {
      const gh = await import("./github.js");
      withIssue({ repos: [] });
      expect((await setState({ state: "closed", reason: "not_planned" })).status).toBe(200);
      expect(gh.closeIssue).toHaveBeenCalledWith("", NATIVE, "not_planned");
    });

    const startSession = (body: Record<string, unknown>, headers: Record<string, string> = API, issue = NATIVE) =>
      request(server, "POST", `/api/sessions/${SID}/issues/${issue}/start-session`, { headers, body: JSON.stringify(body) });

    describe("start-session (#clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE)", () => {
      beforeEach(async () => {
        const db = await import("./db.js");
        vi.mocked(db.countLiveSessionsSpawnedBy).mockResolvedValue(0);
        fakeBackend.create.mockResolvedValue({ ok: true, id: "def456" });
        fakeBackend.createMulti.mockResolvedValue({ ok: true, id: "def789" });
        const { clearCapabilityRequestsForSession } = await import("./capability-requests.js");
        await clearCapabilityRequestsForSession("def456");
      });

      it("defaults to the remembered agent and model, but explicit values win and a rate-limited agent falls back", async () => {
        const { getSessionAgentDefaults } = await import("./db.js");
        const codexModel = sessionModelsFor("codex")[1]!.id;
        const remembered = { lastProvider: "codex", models: { codex: codexModel } };
        vi.mocked(getSessionAgentDefaults).mockResolvedValue(remembered);
        try {
          await startSession({});
          expect(fakeBackend.create).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "codex", model: codexModel }));
          await startSession({ provider: "claude" });
          expect(fakeBackend.create).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "claude", model: "fable" }));
          vi.mocked(isProviderRateLimited).mockImplementation((provider) => provider === "codex");
          await startSession({});
          expect(fakeBackend.create).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "claude", model: "fable" }));
        } finally {
          vi.mocked(isProviderRateLimited).mockReset().mockReturnValue(false);
          vi.mocked(getSessionAgentDefaults).mockReset().mockResolvedValue({ lastProvider: null, models: {} });
        }
      });

      it("refuses a missing or foreign bearer, a forge issue and a closed issue, creating nothing", async () => {
        expect((await startSession({}, { "content-type": "application/json" })).status).toBe(401);
        expect((await startSession({}, READ_API)).status).toBe(401);
        expect((await startSession({}, API, "42")).status).toBe(404);
        withIssue({ state: "closed" });
        expect((await startSession({})).status).toBe(409);
        expect(fakeBackend.create).not.toHaveBeenCalled();
        expect(fakeBackend.createMulti).not.toHaveBeenCalled();
      });

      it("refuses a title for an issue session, creating nothing", async () => {
        const res = await startSession({ title: "Mine" });
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toContain("titled from the issue");
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });

      it("defaults to the issue's repo, the form's default provider and its default model, with the baseline grant only", async () => {
        const gh = await import("./github.js");
        const { withImplicitCapabilities, defaultProviderAuthCapabilities } = await import("./capabilities.js");
        mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
        const res = await startSession({ instructions: "Start with the tests" });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({
          ok: true, id: "def456", url: "https://claws.example/sessions/def456",
          provider: "claude", model: "fable", repos: ["org/repo"], pending_capabilities: [],
        });
        expect(fakeBackend.create).toHaveBeenCalledWith(expect.objectContaining({
          repo: "org/repo", mode: "worktree-claude", provider: "claude", model: "fable",
          capabilities: withImplicitCapabilities(defaultProviderAuthCapabilities("claude", "worktree-claude"), ["org/repo"]),
          spawnedBySession: SID, spawnedForIssue: NATIVE, title: "Issue: Native issue",
        }));
        expect((fakeBackend.create.mock.calls[0]![0] as { initialPrompt?: string | null }).initialPrompt ?? null).toBeNull();
        const brief = (fakeBackend.create.mock.calls[0]![0] as { brief: string }).brief;
        expect(brief).toContain(`#${NATIVE}: Native issue`);
        expect(brief).toContain("Start with the tests");
        expect(brief).toContain("Body");
        expect(brief).toContain("## Implementation Plan");
        expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, expect.stringContaining("Session `abc123` started session [`def456`](https://claws.example/sessions/def456)"));
      });

      it("starts a home session for an unassigned issue, and a multi-repo one on the multi-repo default", async () => {
        withIssue({ repos: [] });
        expect((await startSession({})).status).toBe(200);
        expect(fakeBackend.create).toHaveBeenCalledWith(expect.objectContaining({ repo: null, mode: "home-claude" }));
        withIssue({ repos: ["org/zeta", "org/repo"] });
        const res = await startSession({});
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({ id: "def789", repos: ["org/repo", "org/zeta"], provider: "claude" });
        expect(fakeBackend.createMulti).toHaveBeenCalledWith(expect.objectContaining({ repos: ["org/repo", "org/zeta"], provider: "claude" }));
      });

      it("rejects an unknown provider or a model the form does not offer, naming the allowed values", async () => {
        const bad = await startSession({ provider: "gpt" });
        expect(bad.status).toBe(400);
        expect(JSON.parse(bad.body).error).toContain("claude, codex, opencode, pi");
        const model = await startSession({ provider: "claude", model: "not-a-model" });
        expect(model.status).toBe(400);
        expect(JSON.parse(model.body).error).toContain("fable");
        expect((await startSession({ instructions: "x".repeat(4_001) })).status).toBe(400);
        expect((await startSession({ repos: ["not a repo"] })).status).toBe(400);
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });

      it("records a requested live-grantable capability as pending on the new session, granting nothing", async () => {
        const { listPending } = await import("./capability-requests.js");
        const res = await startSession({ request_capabilities: ["ssh:nas"], reason: "check the pool" });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).pending_capabilities).toEqual(["ssh:nas"]);
        expect((fakeBackend.create.mock.calls[0]![0] as { capabilities: string[] }).capabilities).not.toContain("ssh:nas");
        expect((await listPending("def456")).map((r) => [r.capability, r.reason])).toEqual([["ssh:nas", "Requested by session abc123 at start: check the pool"]]);
      });

      it("rejects an unknown or launch-only capability before creating anything", async () => {
        const { classifyLiveGrants } = await import("./capabilities.js");
        expect((await startSession({ request_capabilities: ["not-a-capability"] })).status).toBe(400);
        // browser is live-grantable to Claude, so offer pi-auth: a provider login only a launch can deliver.
        const { piCredentialSources } = await import("./pi-auth.js");
        vi.mocked(piCredentialSources).mockReturnValue(["anthropic"]);
        try {
          const fixed = classifyLiveGrants(["cross-repo"], "k8s-pod", { provider: "claude", mode: "worktree-claude" }).find((e) => e.state === "fixed");
          expect(fixed).toBeDefined();
          const res = await startSession({ request_capabilities: [fixed!.cap.id] });
          expect(res.status).toBe(400);
          expect(JSON.parse(res.body).error).toContain("only grantable at launch");
          expect(fakeBackend.create).not.toHaveBeenCalled();
        } finally {
          vi.mocked(piCredentialSources).mockReturnValue([]);
        }
      });

      it("gives the provider's reason when it cannot use a requested capability at all", async () => {
        const res = await startSession({ provider: "codex", request_capabilities: ["browser"] });
        expect(res.status).toBe(400);
        const error = JSON.parse(res.body).error as string;
        expect(error).toContain("browser cannot be requested: codex cannot use the browser capability");
        expect(error).not.toContain("only grantable at launch");
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });

      it("refuses a sixth live started session", async () => {
        const db = await import("./db.js");
        vi.mocked(db.countLiveSessionsSpawnedBy).mockResolvedValue(5);
        const res = await startSession({});
        expect(res.status).toBe(409);
        expect(db.countLiveSessionsSpawnedBy).toHaveBeenCalledWith(SID);
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });

      it("maps a backend failure to a clear JSON error", async () => {
        fakeBackend.createMulti.mockResolvedValue({ ok: false, reason: "provider-unsupported", detail: "opencode cannot attach additional repo worktrees" });
        const res = await startSession({ repos: ["org/repo", "org/lib"], provider: "opencode" });
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toContain("opencode cannot attach additional repo worktrees");
      });
    });

    describe("start-session without an issue (#clw_01M4G6RMF5EF0AF0VZPTAYNDRJ)", () => {
      const startBare = (body: Record<string, unknown>, headers: Record<string, string> = API, sid = SID) =>
        request(server, "POST", `/api/sessions/${sid}/start-session`, { headers, body: JSON.stringify(body) });

      beforeEach(async () => {
        const db = await import("./db.js");
        vi.mocked(db.countLiveSessionsSpawnedBy).mockResolvedValue(0);
        fakeBackend.create.mockResolvedValue({ ok: true, id: "def456" });
        fakeBackend.createMulti.mockResolvedValue({ ok: true, id: "def789" });
        const { clearCapabilityRequestsForSession } = await import("./capability-requests.js");
        await clearCapabilityRequestsForSession("def456");
      });

      it("pins the caller's explicit title and refuses one over 120 characters", async () => {
        expect((await startBare({ title: "Debug Loki OOM", instructions: "Wire it" })).status).toBe(200);
        expect(fakeBackend.create).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Debug Loki OOM" }));
        fakeBackend.create.mockClear();
        const res = await startBare({ title: "x".repeat(121) });
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toContain("120");
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });

      it("starts a home-directory session whose brief carries the instructions and no issue text, filing and commenting on nothing", async () => {
        const gh = await import("./github.js");
        const res = await startBare({ instructions: "Wire the transceiver" });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({
          ok: true, id: "def456", url: "https://claws.example/sessions/def456",
          provider: "claude", model: "fable", repos: [], pending_capabilities: [],
        });
        expect(fakeBackend.create).toHaveBeenCalledWith(expect.objectContaining({
          repo: null, mode: "home-claude", spawnedBySession: SID, spawnedForIssue: null, title: "Wire the transceiver",
        }));
        const brief = (fakeBackend.create.mock.calls[0]![0] as { brief: string }).brief;
        expect(brief).toContain("Wire the transceiver");
        expect(brief).toContain("untrusted data");
        expect(brief).not.toContain("### Issue body");
        expect(brief).not.toContain("### Latest plan");
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
        expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      });

      it("uses the repos given, on the multi-repo path for several", async () => {
        const res = await startBare({ repos: ["a/b", "a/c"] });
        expect(res.status).toBe(200);
        expect(fakeBackend.createMulti).toHaveBeenCalledWith(expect.objectContaining({ repos: ["a/b", "a/c"], spawnedForIssue: null }));
      });

      it("rejects an unknown provider or model with the allowed list", async () => {
        const bad = await startBare({ provider: "gpt" });
        expect(bad.status).toBe(400);
        expect(JSON.parse(bad.body).error).toContain("claude, codex, opencode, pi");
        const model = await startBare({ provider: "claude", model: "not-a-model" });
        expect(model.status).toBe(400);
        expect(JSON.parse(model.body).error).toContain("fable");
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });

      it("rejects a launch-only capability before creating anything, and records a requestable one as pending", async () => {
        const { classifyLiveGrants } = await import("./capabilities.js");
        const { piCredentialSources } = await import("./pi-auth.js");
        vi.mocked(piCredentialSources).mockReturnValue(["anthropic"]);
        try {
          const fixed = classifyLiveGrants(["cross-repo"], "k8s-pod", { provider: "claude", mode: "worktree-claude" }).find((e) => e.state === "fixed");
          expect(fixed).toBeDefined();
          expect((await startBare({ request_capabilities: [fixed!.cap.id] })).status).toBe(400);
          expect(fakeBackend.create).not.toHaveBeenCalled();
        } finally {
          vi.mocked(piCredentialSources).mockReturnValue([]);
        }
        const ok = await startBare({ request_capabilities: ["ssh:nas"] });
        expect(JSON.parse(ok.body).pending_capabilities).toEqual(["ssh:nas"]);
      });

      it("refuses a sixth live started session", async () => {
        const db = await import("./db.js");
        vi.mocked(db.countLiveSessionsSpawnedBy).mockResolvedValue(5);
        expect((await startBare({})).status).toBe(409);
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });

      it("refuses a missing or foreign bearer, and a session that is not live", async () => {
        expect((await startBare({}, { "content-type": "application/json" })).status).toBe(401);
        expect((await startBare({}, READ_API)).status).toBe(401);
        fakeBackend.verifyMcpToken.mockResolvedValueOnce("ok");
        expect((await startBare({}, API, "def000")).status).toBe(404);
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });
    });

    describe("the board's Start session button (#clw_01M52AKRRVN170EE506CRZD9VM)", () => {
      const startFromBoard = (body: Record<string, unknown>) =>
        request(server, "POST", "/board/start-session", { headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

      beforeEach(async () => {
        fakeBackend.create.mockResolvedValue({ ok: true, id: "def456" });
        fakeBackend.createMulti.mockResolvedValue({ ok: true, id: "def789" });
        const { listRepos } = await import("./github.js");
        vi.mocked(listRepos).mockResolvedValue([
          { owner: "org", name: "repo", fullName: "org/repo" },
          { owner: "org", name: "zeta", fullName: "org/zeta" },
          { owner: "test", name: "repo", fullName: "test/repo" },
        ] as never);
      });

      afterEach(async () => {
        const { listRepos } = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(listRepos).mockResolvedValue([
          { owner: "org", name: "repo", fullName: "org/repo" },
          { owner: "test", name: "repo", fullName: "test/repo" },
        ] as never);
        vi.mocked(db.getSessionAgentDefaults).mockReset().mockResolvedValue({ lastProvider: null, models: {} });
        vi.mocked(db.getAllSessionCapabilityDefaults).mockReset().mockResolvedValue(new Map());
        vi.mocked(isProviderRateLimited).mockReset().mockReturnValue(false);
      });

      it("starts a multi-repo session with the repos primary first and the form's remembered agent, model and capabilities", async () => {
        const db = await import("./db.js");
        const gh = await import("./github.js");
        const { preselectedSessionCapabilities } = await import("./session-form-defaults.js");
        const codexModel = sessionModelsFor("codex")[1]!.id;
        const remembered = new Map([["org/repo\norg/zeta", ["browser"]]]);
        vi.mocked(db.getSessionAgentDefaults).mockResolvedValue({ lastProvider: "codex", models: { codex: codexModel } });
        vi.mocked(db.getAllSessionCapabilityDefaults).mockResolvedValue(remembered);
        mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
        withIssue({ repos: ["org/zeta", "org/repo"] });

        const res = await startFromBoard({ repo: "org/repo", ref: NATIVE });

        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, id: "def789", url: "https://claws.example/sessions/def789" });
        expect(fakeBackend.createMulti).toHaveBeenCalledWith(expect.objectContaining({
          repos: ["org/repo", "org/zeta"], provider: "codex", model: codexModel,
          capabilities: preselectedSessionCapabilities(["org/repo", "org/zeta"], remembered, "codex"),
          spawnedBySession: null, spawnedForIssue: NATIVE,
        }));
        const brief = (fakeBackend.createMulti.mock.calls[0]![0] as { brief: string }).brief;
        expect(brief).toContain(`The operator started this session from the board for issue #${NATIVE}: Native issue`);
        expect(brief).toContain("## Implementation Plan");
        // Nothing is remembered and nothing is posted on the issue.
        expect(db.rememberSessionCapabilityDefaults).not.toHaveBeenCalled();
        expect(db.rememberSessionAgentDefault).not.toHaveBeenCalled();
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
      });

      it("opens the session with the issue id and a note to wait for the operator", async () => {
        withIssue({ repos: ["org/zeta", "org/repo"] });
        await startFromBoard({ repo: "org/repo", ref: NATIVE });
        const multi = (fakeBackend.createMulti.mock.calls[0]![0] as { initialPrompt: string }).initialPrompt;
        expect(multi.startsWith(`#${NATIVE}`)).toBe(true);
        expect(multi).toContain("wait for the operator's next message");
        expect(multi).toContain("claws_get_issue");
        withIssue({ repos: ["org/repo"] });
        await startFromBoard({ repo: "org/repo", ref: NATIVE });
        const single = (fakeBackend.create.mock.calls[0]![0] as { initialPrompt: string }).initialPrompt;
        expect(single.startsWith(`#${NATIVE}`)).toBe(true);
      });

      it("puts a Blocked issue's recorded reason, a stalled PR, or a read failure into the opening message", async () => {
        const db = await import("./db.js");
        const prompt = () => (fakeBackend.create.mock.calls.at(-1)![0] as { initialPrompt: string }).initialPrompt;
        withIssue({ repos: ["org/repo"], lifecycle: "blocked" });
        vi.mocked(db.getIssueBlockedReasons).mockResolvedValueOnce(new Map([[NATIVE, "waiting on the vendor"]]));
        expect((await startFromBoard({ repo: "org/repo", ref: NATIVE })).status).toBe(200);
        expect(prompt()).toContain('The issue is Blocked; recorded reason: "waiting on the vendor"');

        withIssue({ repos: ["org/repo"], lifecycle: "awaiting-plan-review", approved_through: "plan" });
        mockIssueFlight.loadIssueFlight.mockResolvedValueOnce({ implementing: false, openPrs: [openPrRow({ stage: "problematic" })] });
        await startFromBoard({ repo: "org/repo", ref: NATIVE });
        expect(prompt()).toContain("org/repo#7 is stalled");

        withIssue({ repos: ["org/repo"], lifecycle: "blocked" });
        vi.mocked(db.getIssueBlockedReasons).mockRejectedValueOnce(new Error("db down"));
        expect((await startFromBoard({ repo: "org/repo", ref: NATIVE })).status).toBe(200);
        expect(prompt()).toContain("no reason was recorded");
      });

      it("starts a single-repo issue in a worktree with the form's single-repo capabilities", async () => {
        const { preselectedSessionCapabilities } = await import("./session-form-defaults.js");
        const res = await startFromBoard({ repo: "org/repo", ref: NATIVE });
        expect(res.status).toBe(200);
        expect(fakeBackend.create).toHaveBeenCalledWith(expect.objectContaining({
          repo: "org/repo", mode: "worktree-claude", provider: "claude", model: "fable",
          capabilities: preselectedSessionCapabilities(["org/repo"], new Map(), "claude"),
          spawnedBySession: null, spawnedForIssue: NATIVE,
        }));
        expect(fakeBackend.createMulti).not.toHaveBeenCalled();
      });

      it("starts a home-directory session for an unassigned issue", async () => {
        withIssue({ repos: [] });
        expect((await startFromBoard({ repo: "", ref: NATIVE })).status).toBe(200);
        expect(fakeBackend.create).toHaveBeenCalledWith(expect.objectContaining({ repo: null, mode: "home-claude" }));
      });

      it("falls back from a rate-limited remembered agent as the form does", async () => {
        const db = await import("./db.js");
        vi.mocked(db.getSessionAgentDefaults).mockResolvedValue({ lastProvider: "codex", models: { codex: sessionModelsFor("codex")[1]!.id } });
        vi.mocked(isProviderRateLimited).mockImplementation((provider) => provider === "codex");
        expect((await startFromBoard({ repo: "org/repo", ref: NATIVE })).status).toBe(200);
        expect(fakeBackend.create).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude", model: "fable" }));
      });

      it("refuses a forge ref, an unknown id and an unconfigured repo, creating nothing", async () => {
        expect((await startFromBoard({ repo: "org/repo", ref: 42 })).status).toBe(400);
        expect((await startFromBoard({ repo: "org/repo", ref: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE" })).status).toBe(404);
        withIssue({ repos: ["org/gone"] });
        expect((await startFromBoard({ repo: "org/gone", ref: NATIVE })).status).toBe(403);
        expect(fakeBackend.create).not.toHaveBeenCalled();
        expect(fakeBackend.createMulti).not.toHaveBeenCalled();
      });

      it("answers a backend refusal with the described reason", async () => {
        fakeBackend.createMulti.mockResolvedValue({ ok: false, reason: "provider-unsupported", detail: "pi" });
        withIssue({ repos: ["org/repo", "test/repo"] });
        const res = await startFromBoard({ repo: "org/repo", ref: NATIVE });
        expect(res.status).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/^Cannot create session: /);
        expect(body.id).toBeUndefined();
      });
    });

    describe("the issue page's Create Session button (#clw_01M5MMR1XVZ4ER7FJ1826R7K99)", () => {
      const JSON_ACCEPT = { accept: "application/json" };
      const startFromIssue = (headers: Record<string, string> = JSON_ACCEPT, ref = NATIVE) =>
        request(server, "POST", `/issues/${ref}/start-session`, { headers });

      beforeEach(async () => {
        fakeBackend.create.mockResolvedValue({ ok: true, id: "iss456" });
        fakeBackend.createMulti.mockResolvedValue({ ok: true, id: "iss789" });
        const { listRepos } = await import("./github.js");
        vi.mocked(listRepos).mockResolvedValue([
          { owner: "org", name: "repo", fullName: "org/repo" },
          { owner: "org", name: "zeta", fullName: "org/zeta" },
          { owner: "test", name: "repo", fullName: "test/repo" },
        ] as never);
      });

      afterEach(async () => {
        const { listRepos } = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(listRepos).mockResolvedValue([
          { owner: "org", name: "repo", fullName: "org/repo" },
          { owner: "test", name: "repo", fullName: "test/repo" },
        ] as never);
        vi.mocked(db.getSessionAgentDefaults).mockReset().mockResolvedValue({ lastProvider: null, models: {} });
        vi.mocked(db.getAllSessionCapabilityDefaults).mockReset().mockResolvedValue(new Map());
      });

      it("starts a multi-repo session with the form's pre-ticked capabilities, the opening message and an audit comment", async () => {
        const db = await import("./db.js");
        const gh = await import("./github.js");
        const { preselectedSessionCapabilities } = await import("./session-form-defaults.js");
        const codexModel = sessionModelsFor("codex")[1]!.id;
        vi.mocked(db.getSessionAgentDefaults).mockResolvedValue({ lastProvider: "codex", models: { codex: codexModel } });
        vi.mocked(db.getAllSessionCapabilityDefaults).mockResolvedValue(new Map([["org/repo\norg/zeta", ["browser"]]]));
        mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
        withIssue({ repos: ["org/zeta", "org/repo"] });

        const res = await startFromIssue();

        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, id: "iss789", url: "https://claws.example/sessions/iss789" });
        expect(fakeBackend.createMulti).toHaveBeenCalledTimes(1);
        const req = fakeBackend.createMulti.mock.calls[0]![0] as { brief: string; capabilities: string[]; initialPrompt?: string };
        expect(fakeBackend.createMulti).toHaveBeenCalledWith(expect.objectContaining({
          repos: ["org/repo", "org/zeta"], provider: "codex", model: codexModel,
          capabilities: preselectedSessionCapabilities(["org/repo", "org/zeta"], new Map([["org/repo\norg/zeta", ["browser"]]]), "codex"),
          spawnedBySession: null, spawnedForIssue: NATIVE, spawnedFrom: "issue-page",
        }));
        expect(req.capabilities).toContain("browser");
        expect(req.initialPrompt).toMatch(new RegExp(`^#${NATIVE}`));
        expect(req.initialPrompt).toContain("stage");
        expect(req.brief).toContain(`The operator started this session from the issue page for issue #${NATIVE}: Native issue`);
        expect(req.brief).toContain("Claws' own note");
        expect(req.brief).toContain("## Implementation Plan");
        expect(db.rememberSessionAgentDefault).not.toHaveBeenCalled();
        expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
        expect(vi.mocked(gh.commentOnIssue).mock.calls[0]![2]).toContain("iss789");
      });

      it("puts a Blocked issue's recorded reason and a stalled PR into the opening message", async () => {
        const db = await import("./db.js");
        const prompt = () => (fakeBackend.create.mock.calls.at(-1)![0] as { initialPrompt: string }).initialPrompt;
        withIssue({ repos: ["org/repo"], lifecycle: "blocked" });
        vi.mocked(db.getIssueBlockedReasons).mockResolvedValueOnce(new Map([[NATIVE, "waiting on the vendor"]]));
        expect((await startFromIssue()).status).toBe(200);
        expect(prompt()).toContain('The issue is Blocked; recorded reason: "waiting on the vendor"');

        withIssue({ repos: ["org/repo"], lifecycle: "approved" });
        mockIssueFlight.loadIssueFlight.mockResolvedValueOnce({ implementing: false, openPrs: [openPrRow({ stage: "problematic" })] });
        await startFromIssue();
        expect(prompt()).toContain("org/repo#7 is stalled");
      });

      it("builds the same session request as the board start, apart from spawnedFrom and the brief's first line", async () => {
        const db = await import("./db.js");
        vi.mocked(db.getAllSessionCapabilityDefaults).mockResolvedValue(new Map([["org/repo", ["browser"]]]));
        withIssue({ repos: ["org/repo"] });
        await request(server, "POST", "/board/start-session", { headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: "org/repo", ref: NATIVE }) });
        await startFromIssue();
        const normalise = (call: unknown[]) => {
          const req = { ...(call[0] as Record<string, unknown>) };
          delete req["spawnedFrom"];
          req["brief"] = String(req["brief"]).split("\n").filter((l) => !l.startsWith("The operator started this session from")).join("\n");
          return req;
        };
        expect(fakeBackend.create).toHaveBeenCalledTimes(2);
        expect(normalise(fakeBackend.create.mock.calls[1]!)).toEqual(normalise(fakeBackend.create.mock.calls[0]!));
      });

      it("starts a single-repo issue in a worktree and redirects a plain form post to the session page", async () => {
        const res = await startFromIssue({});
        expect(res.status).toBe(303);
        expect(res.headers["location"]).toBe("https://claws.example/sessions/iss456");
        expect(fakeBackend.create).toHaveBeenCalledWith(expect.objectContaining({ repo: "org/repo", mode: "worktree-claude", spawnedFrom: "issue-page" }));
        expect(fakeBackend.createMulti).not.toHaveBeenCalled();
      });

      it("leaves no session comment behind when creation fails", async () => {
        const gh = await import("./github.js");
        fakeBackend.createMulti.mockResolvedValue({ ok: false, reason: "provider-unsupported", detail: "pi" });
        withIssue({ repos: ["org/repo", "test/repo"] });
        const res = await startFromIssue();
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toMatch(/^Cannot create session: /);
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
        const html = await startFromIssue({});
        expect(html.status).toBe(400);
        expect(html.body).toContain("Back to issue");
      });

      it("refuses a shadow record and a forge ref, creating nothing", async () => {
        withIssue({ kind: "shadow" });
        expect((await startFromIssue()).status).toBe(404);
        expect((await startFromIssue(JSON_ACCEPT, "org%2Frepo%2342")).status).toBe(404);
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });

      it("answers 409 to a second request while the first is still creating", async () => {
        let release!: (v: { ok: true; id: string }) => void;
        fakeBackend.create.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
        const first = startFromIssue();
        await vi.waitFor(() => expect(fakeBackend.create).toHaveBeenCalledTimes(1));
        const second = await startFromIssue();
        expect(second.status).toBe(409);
        release({ ok: true, id: "iss456" });
        expect((await first).status).toBe(200);
        expect(fakeBackend.create).toHaveBeenCalledTimes(1);
      });
    });

    describe("the PRs page's Start session button (#clw_01M534FQSS8T19QHHKSVHS9AGY)", () => {
      const startFromPrs = (body: Record<string, unknown>) =>
        request(server, "POST", "/prs/start-session", { headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const pr = (number: number) => ({ number, title: `PR ${number}`, headRefName: `claws/pr-${number}`, baseRefName: "main", labels: [], author: { login: "claws" }, isCrossRepository: false, headRefOid: `sha${number}` });

      beforeEach(async () => {
        fakeBackend.create.mockResolvedValue({ ok: true, id: "pr456" });
        const gh = await import("./github.js");
        vi.mocked(gh.listPRs).mockImplementation(async (repo: string) => (repo === "org/repo" ? [pr(7), pr(8)] : []) as never);
      });

      afterEach(async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(gh.listPRs).mockReset().mockResolvedValue([]);
        vi.mocked(gh.listPRStatuses).mockReset().mockResolvedValue(new Map());
        vi.mocked(gh.ciFixerGaveUpOnHead).mockReset().mockReturnValue(false);
        vi.mocked(db.getClawsPr).mockReset().mockResolvedValue(null as never);
        vi.mocked(db.getSessionAgentDefaults).mockReset().mockResolvedValue({ lastProvider: null, models: {} });
        vi.mocked(db.getAllSessionCapabilityDefaults).mockReset().mockResolvedValue(new Map());
      });

      it("starts a worktree session for the PR's repo with the form's defaults, linked to the PR and its issue, posting nothing", async () => {
        const db = await import("./db.js");
        const gh = await import("./github.js");
        const { preselectedSessionCapabilities } = await import("./session-form-defaults.js");
        const codexModel = sessionModelsFor("codex")[1]!.id;
        const remembered = new Map([["org/repo", ["browser"]]]);
        vi.mocked(db.getSessionAgentDefaults).mockResolvedValue({ lastProvider: "codex", models: { codex: codexModel } });
        vi.mocked(db.getAllSessionCapabilityDefaults).mockResolvedValue(remembered);
        vi.mocked(db.getClawsPr).mockResolvedValue(openPrRow({ prNumber: 7, issueId: NATIVE }) as never);

        const res = await startFromPrs({ repo: "org/repo", number: 7 });

        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, id: "pr456", url: "https://claws.example/sessions/pr456" });
        expect(fakeBackend.create).toHaveBeenCalledTimes(1);
        expect(fakeBackend.create).toHaveBeenCalledWith(expect.objectContaining({
          repo: "org/repo", mode: "worktree-claude", provider: "codex", model: codexModel,
          capabilities: preselectedSessionCapabilities(["org/repo"], remembered, "codex"),
          spawnedBySession: null, spawnedForIssue: NATIVE, spawnedForPr: "org/repo#7",
        }));
        const req = fakeBackend.create.mock.calls[0]![0] as { brief: string; initialPrompt: string };
        expect(req.initialPrompt.startsWith("org/repo#7\n")).toBe(true);
        expect(req.initialPrompt).toContain("wait for the operator's next message before acting");
        expect(req.initialPrompt).not.toContain("likely subject");
        expect(req.brief).toContain(`Linked Claws issue: #${NATIVE}`);
        expect(req.brief).toContain("Branch: claws/pr-7");
        expect(db.rememberSessionCapabilityDefaults).not.toHaveBeenCalled();
        expect(db.rememberSessionAgentDefault).not.toHaveBeenCalled();
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
        expect(gh.addLabel).not.toHaveBeenCalled();
        expect(db.upsertClawsPr).not.toHaveBeenCalled();
      });

      it("starts a session for a PR with no claws_prs row and no linked issue", async () => {
        expect((await startFromPrs({ repo: "org/repo", number: 8 })).status).toBe(200);
        expect(fakeBackend.create).toHaveBeenCalledWith(expect.objectContaining({ spawnedForIssue: null, spawnedForPr: "org/repo#8" }));
        expect((fakeBackend.create.mock.calls[0]![0] as { brief: string }).brief).toContain("no linked Claws issue");
      });

      it("points the first message at the PR's most pressing problem", async () => {
        const db = await import("./db.js");
        const gh = await import("./github.js");
        const prompt = () => (fakeBackend.create.mock.calls.at(-1)![0] as { initialPrompt: string }).initialPrompt;
        vi.mocked(db.getClawsPr).mockResolvedValue(openPrRow({ prNumber: 7, manualActionReason: "Set the DNS record", stage: "problematic" }) as never);
        await startFromPrs({ repo: "org/repo", number: 7 });
        expect(prompt()).toContain("manual-action hold");
        expect(prompt()).toContain("Set the DNS record");
        vi.mocked(db.getClawsPr).mockResolvedValue(openPrRow({ prNumber: 7, stage: "problematic" }) as never);
        await startFromPrs({ repo: "org/repo", number: 7 });
        expect(prompt()).toContain("problematic mark");
        vi.mocked(db.getClawsPr).mockResolvedValue(openPrRow({ prNumber: 7, ciBlockedReason: "billing" }) as never);
        await startFromPrs({ repo: "org/repo", number: 7 });
        expect(prompt()).toContain("blocked CI");
        vi.mocked(db.getClawsPr).mockResolvedValue(null as never);
        vi.mocked(gh.ciFixerGaveUpOnHead).mockReturnValue(true);
        await startFromPrs({ repo: "org/repo", number: 7 });
        expect(prompt()).toContain("CI fixer has given up");
        expect(gh.ciFixerGaveUpOnHead).toHaveBeenCalledWith("org/repo", 7, "sha7");
        vi.mocked(gh.ciFixerGaveUpOnHead).mockReturnValue(false);
        vi.mocked(gh.listPRStatuses).mockResolvedValue(new Map([[7, { checkStatus: "failing", checksPassed: 0, checksTotal: 1, mergeableState: "MERGEABLE" }]]) as never);
        await startFromPrs({ repo: "org/repo", number: 7 });
        expect(prompt()).toContain("The likely subject of this session is its failing CI");
      });

      it("refuses an unconfigured repo, an unknown PR and an unreadable forge, creating nothing", async () => {
        const gh = await import("./github.js");
        expect((await startFromPrs({ repo: "org/gone", number: 7 })).status).toBe(403);
        const missing = await startFromPrs({ repo: "org/repo", number: 99 });
        expect(missing.status).toBe(404);
        expect(JSON.parse(missing.body).error).toBe("Pull request not found or not open");
        vi.mocked(gh.listPRs).mockRejectedValueOnce(new Error("forge down"));
        const down = await startFromPrs({ repo: "org/repo", number: 7 });
        expect(down.status).toBe(502);
        expect(JSON.parse(down.body).error).toBe("Could not read the pull request");
        expect((await startFromPrs({ repo: "org/repo" })).status).toBe(400);
        expect(fakeBackend.create).not.toHaveBeenCalled();
      });

      it("answers a backend refusal with the described reason", async () => {
        fakeBackend.create.mockResolvedValue({ ok: false, reason: "provider-unsupported", detail: "pi" });
        const res = await startFromPrs({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/^Cannot create session: /);
        expect(body.id).toBeUndefined();
      });
    });

    const CANONICAL = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";
    const closeAsDuplicate = (canonical_id: unknown) =>
      request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/close-as-duplicate`, { headers: API, body: JSON.stringify({ canonical_id }) });
    /** `getIssue` answers the issue under test and, separately, the canonical one. */
    const withCanonical = (canonical: Record<string, unknown> | undefined, issue: Record<string, unknown> = {}) =>
      mockClawsIssues.getIssue.mockImplementation(async (id: string) =>
        id === NATIVE ? { ...nativeIssue, ...issue } : id === CANONICAL && canonical ? { ...nativeIssue, id: CANONICAL, ...canonical } : undefined);

    it("closes as a duplicate: Duplicate, then the marker comment, then a not-planned close", async () => {
      const gh = await import("./github.js");
      withCanonical({});
      const res = await closeAsDuplicate(CANONICAL.toLowerCase());
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ ok: true, canonical: CANONICAL });
      expect(gh.addLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Duplicate");
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE,
        `Session \`abc123\` closed this issue as a duplicate of #${CANONICAL}.\n\nclaws-duplicate-of:${CANONICAL}`);
      expect(gh.closeIssue).toHaveBeenCalledWith("org/repo", NATIVE, "not_planned");
      const order = [
        vi.mocked(gh.addLabel).mock.invocationCallOrder[0]!,
        vi.mocked(gh.commentOnIssue).mock.invocationCallOrder[0]!,
        vi.mocked(gh.closeIssue).mock.invocationCallOrder[0]!,
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("skips the label when Duplicate is already applied", async () => {
      const gh = await import("./github.js");
      withCanonical({}, { labels: ["Duplicate"] });
      expect((await closeAsDuplicate(CANONICAL)).status).toBe(200);
      expect(gh.addLabel).not.toHaveBeenCalled();
      expect(gh.closeIssue).toHaveBeenCalledWith("org/repo", NATIVE, "not_planned");
    });

    it("refuses a forge or missing canonical id, itself, an unknown or shadow canonical, and a closed one, writing nothing", async () => {
      const gh = await import("./github.js");
      withCanonical({});
      expect((await closeAsDuplicate("42")).status).toBe(400);
      expect((await closeAsDuplicate(undefined)).status).toBe(400);
      expect((await closeAsDuplicate(NATIVE)).status).toBe(409);
      withCanonical(undefined);
      expect((await closeAsDuplicate(CANONICAL)).status).toBe(404);
      withCanonical({ kind: "shadow" });
      expect((await closeAsDuplicate(CANONICAL)).status).toBe(404);
      withCanonical({ state: "closed" });
      const closed = await closeAsDuplicate(CANONICAL);
      expect(closed.status).toBe(409);
      expect(JSON.parse(closed.body).error).toContain("is closed");
      expect(gh.addLabel).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
      expect(gh.closeIssue).not.toHaveBeenCalled();
    });

    it("leaves the issue open, saying the label was applied, when the marker comment fails", async () => {
      const gh = await import("./github.js");
      withCanonical({});
      vi.mocked(gh.commentOnIssue).mockRejectedValueOnce(new Error("forge down"));
      const res = await closeAsDuplicate(CANONICAL);
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toBe("The Duplicate label was applied but the issue is still open: forge down");
      expect(gh.addLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Duplicate");
      expect(gh.closeIssue).not.toHaveBeenCalled();
    });

    it("says the marker was applied, and does not repost it on retry, when the close fails", async () => {
      const gh = await import("./github.js");
      withCanonical({});
      vi.mocked(gh.closeIssue).mockRejectedValueOnce(new Error("close failed"));
      const res = await closeAsDuplicate(CANONICAL);
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toBe("The Duplicate label and the duplicate marker were applied but closing the issue failed: close failed");
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);

      mockClawsIssues.listCommentDetails.mockResolvedValueOnce([{ body: `x\n\nclaws-duplicate-of:${CANONICAL}` }]);
      expect((await closeAsDuplicate(CANONICAL)).status).toBe(200);
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(gh.closeIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "not_planned");
    });

    it("refuses another session's token on the duplicate route", async () => {
      withCanonical({});
      const res = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/close-as-duplicate`, {
        headers: { authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" },
        body: JSON.stringify({ canonical_id: CANONICAL }),
      });
      expect(res.status).toBe(401);
    });

    const deleteComments = (body: unknown, headers: Record<string, string> = API) =>
      request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/comments/delete`, { headers, body: JSON.stringify(body) });

    it("bulk-deletes comments as the session and posts one audit comment", async () => {
      const gh = await import("./github.js");
      mockClawsIssues.deleteIssueComments.mockResolvedValueOnce(2);
      const res = await deleteComments({ comment_ids: ["clwc_A", "clwc_B"] });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, deleted: 2 });
      expect(mockClawsIssues.deleteIssueComments).toHaveBeenCalledWith(NATIVE, ["clwc_A", "clwc_B"], "session:abc123");
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Session `abc123` deleted 2 comments; see the issue's History.");
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    });

    it("refuses an empty or malformed list, a protected or foreign id, and another token", async () => {
      expect((await deleteComments({ comment_ids: [] })).status).toBe(400);
      expect((await deleteComments({ comment_ids: [3] })).status).toBe(400);
      expect((await deleteComments({})).status).toBe(400);
      mockClawsIssues.deleteIssueComments.mockRejectedValueOnce(new mockClawsIssues.IssueCommentDeleteError("refused", "plan"));
      expect((await deleteComments({ comment_ids: ["clwc_P"] })).status).toBe(409);
      mockClawsIssues.deleteIssueComments.mockRejectedValueOnce(new mockClawsIssues.IssueCommentDeleteError("not-found", "elsewhere"));
      expect((await deleteComments({ comment_ids: ["clwc_X"] })).status).toBe(404);
      const foreignToken = await deleteComments({ comment_ids: ["clwc_A"] }, { authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" });
      expect(foreignToken.status).toBe(401);
      const gh = await import("./github.js");
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
    });

    const REQUIREMENTS = { title: "T", kind: "feature", context: "C", requirement: "R", acceptanceCriteria: ["A"], outOfScope: [] };
    const saveRequirements = (body: unknown) =>
      request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/requirements`, { headers: API, body: JSON.stringify(body) });

    it("stores a requirements version unapproved and audits it", async () => {
      const gh = await import("./github.js");
      const res = await saveRequirements(REQUIREMENTS);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, version: 2, approved: false });
      expect(mockClawsIssues.storeSessionRequirements).toHaveBeenCalledWith(NATIVE, REQUIREMENTS);
      expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Session `abc123` stored requirements v2 — not approved.");
    });

    it("refuses an invalid record, and any record while a re-approval is pending", async () => {
      expect((await saveRequirements({ ...REQUIREMENTS, acceptanceCriteria: [] })).status).toBe(400);
      mockReapproval.hasPendingReapproval.mockResolvedValueOnce(true);
      expect((await saveRequirements(REQUIREMENTS)).status).toBe(409);
      expect(mockClawsIssues.storeSessionRequirements).not.toHaveBeenCalled();
    });

    const edit = (body: Record<string, unknown>) =>
      request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/edit`, { headers: API, body: JSON.stringify(body) });

    it("edits the title alone or the body alone, leaving the other field unchanged", async () => {
      const gh = await import("./github.js");
      const titled = await edit({ title: "  Renamed  " });
      expect(titled.status).toBe(200);
      expect(JSON.parse(titled.body)).toMatchObject({ changed: true, title: "Renamed" });
      expect(gh.editIssueTitle).toHaveBeenCalledWith("org/repo", NATIVE, "Renamed");
      expect(gh.editIssue).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` edited the title (was: Native issue).");

      const bodied = await edit({ body: "New body" });
      expect(bodied.status).toBe(200);
      // The same façade as the dashboard's edit, so a planned issue re-plans off the body hash.
      expect(gh.editIssue).toHaveBeenCalledWith("org/repo", NATIVE, "New body");
      expect(gh.editIssueTitle).toHaveBeenCalledTimes(1);
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` edited the body.");
    });

    it("answers changed:false for an unchanged edit, and refuses an empty or blank-title one", async () => {
      const gh = await import("./github.js");
      const same = await edit({ title: "Native issue", body: "Body" });
      expect(same.status).toBe(200);
      expect(JSON.parse(same.body).changed).toBe(false);
      expect((await edit({})).status).toBe(400);
      expect((await edit({ title: "   " })).status).toBe(400);
      expect(gh.editIssue).not.toHaveBeenCalled();
      expect(gh.editIssueTitle).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
    });

    const setRepos = (repos: unknown) =>
      request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/repos`, { headers: API, body: JSON.stringify({ repos }) });

    it("sets the repos to managed repos only, deduplicated, auditing the change", async () => {
      const gh = await import("./github.js");
      const res = await setRepos(["test/repo", "org/repo", "test/repo"]);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ changed: true, repos: ["test/repo", "org/repo"] });
      expect(mockClawsIssues.setRepos).toHaveBeenCalledWith(NATIVE, ["test/repo", "org/repo"]);
      expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Session `abc123` set the repositories to test/repo, org/repo (was: org/repo).");

      const unknown = await setRepos(["org/repo", "zz/unmanaged"]);
      expect(unknown.status).toBe(400);
      expect(JSON.parse(unknown.body).error).toBe("Not a repo Claws manages: zz/unmanaged");
      expect((await setRepos([])).status).toBe(400);
      const same = await setRepos(["org/repo"]);
      expect(JSON.parse(same.body).changed).toBe(false);
      expect(mockClawsIssues.setRepos).toHaveBeenCalledTimes(1);
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
    });

    it("assigns repos to an unassigned issue", async () => {
      withIssue({ repos: [] });
      expect((await setRepos(["org/repo"])).status).toBe(200);
      expect(mockClawsIssues.setRepos).toHaveBeenCalledWith(NATIVE, ["org/repo"]);
    });

    const setColumn = (column: string, reason?: string) =>
      request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/column`, { headers: API, body: JSON.stringify({ column, reason }) });

    it("moves the issue as the Status buttons do, as session:<sid>, and forwards their refusals", async () => {
      const gh = await import("./github.js");
      const moved = await setColumn("blocked", "Waiting on the vendor");
      expect(moved.status).toBe(200);
      expect(JSON.parse(moved.body).changed).toBe(true);
      expect(mockClawsIssues.blockIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Waiting on the vendor");
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` moved this issue to blocked.");

      expect((await setColumn("done")).status).toBe(400);
      expect((await setColumn("implementing")).status).toBe(400);
      // Approved is an approval, set through the approval route.
      expect((await setColumn("approved")).status).toBe(400);
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: true, openPrs: [] });
      const refused = await setColumn("planning");
      expect(refused.status).toBe(409);
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
    });

    it("refuses a move to blocked without a reason, writing and auditing nothing", async () => {
      const gh = await import("./github.js");
      for (const reason of [undefined, " "]) {
        const res = await setColumn("blocked", reason);
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toBe("A reason is required to mark an issue Blocked.");
      }
      expect(mockClawsIssues.blockIssue).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("makes the move as the session, for the issue's History", async () => {
      let actor: IssueActor | undefined;
      mockClawsIssues.setLifecycle.mockImplementationOnce(async () => { actor = currentIssueActor(); });
      expect((await setColumn("backlog")).status).toBe(200);
      expect(actor).toEqual({ kind: "session", name: SID });
    });

    it("parks the issue in the Backlog until a date and clears it, as the session, auditing each", async () => {
      const gh = await import("./github.js");
      const { setClawsIssueBacklogUntil } = await import("./db.js");
      let lifecycle = nativeIssue.lifecycle;
      let until: string | null = null;
      mockClawsIssues.setLifecycle.mockImplementation(async (_repo: string, _ref: string, to: string) => { lifecycle = to; });
      vi.mocked(setClawsIssueBacklogUntil).mockImplementation(async (_id: string, u: string | null) => { until = u; return true; });
      mockClawsIssues.getIssue.mockImplementation(async () => ({ ...nativeIssue, lifecycle, labels: [], backlog_until: until }));
      const park = (body: Record<string, unknown>) =>
        request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/column`, { headers: API, body: JSON.stringify(body) });
      try {
        const parked = await park({ column: "backlog", until: "2999-01-01" });
        expect(parked.status).toBe(200);
        expect(JSON.parse(parked.body)).toMatchObject({ ok: true, changed: true, lifecycle: "backlog", backlog_until: "2999-01-01" });
        expect(setClawsIssueBacklogUntil).toHaveBeenCalledWith(NATIVE, "2999-01-01");
        expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` moved this issue to backlog until 2999-01-01.");

        const cleared = await park({ column: "backlog", until: null });
        expect(JSON.parse(cleared.body)).toMatchObject({ changed: true, backlog_until: null });
        expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` cleared this issue's Backlog return date (was: 2999-01-01).");

        expect((await park({ column: "planning", until: "2999-01-01" })).status).toBe(400);
        expect((await park({ column: "backlog", until: "2000-01-01" })).status).toBe(400);
        expect((await park({ column: "backlog", until: 5 })).status).toBe(400);
        expect(gh.commentOnIssue).toHaveBeenCalledTimes(2);

        // The move lands but the date write loses a race: say so, not "nothing changed".
        lifecycle = "planning";
        vi.mocked(setClawsIssueBacklogUntil).mockResolvedValueOnce(false);
        const half = await park({ column: "backlog", until: "2999-01-01" });
        expect(half.status).toBe(409);
        expect(half.body).toContain("moved to the Backlog, but it changed before its return date was saved");
      } finally {
        mockClawsIssues.setLifecycle.mockImplementation(async () => {});
        vi.mocked(setClawsIssueBacklogUntil).mockImplementation(async () => true);
      }
    });

    it("answers changed:false for a move to the current column", async () => {
      const gh = await import("./github.js");
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      const res = await setColumn("awaiting-plan-review");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).changed).toBe(false);
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("answers changed:true, and audits it, for a move to the current column that lowers the approval", async () => {
      const gh = await import("./github.js");
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      withIssue({ lifecycle: "awaiting-plan-review", approved_through: "plan" });
      mockIssueApproval.applyIssueApproval.mockImplementationOnce(async () => {
        withIssue({ lifecycle: "awaiting-plan-review", approved_through: "requirements" });
        return { ok: true, trackerId: NATIVE, before: "plan", after: "requirements", changed: true, openPrs: 0 };
      });
      const res = await setColumn("awaiting-plan-review");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).changed).toBe(true);
      expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Session `abc123` re-sent this issue to awaiting-plan-review, lowering its approval from plan to requirements.");
    });

    it("promotes an issue in Ideas as session:<sid>, and refuses one that is not", async () => {
      const gh = await import("./github.js");
      withIssue({ lifecycle: "ideas" });
      const res = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/promote`, { headers: API, body: "{}" });
      expect(res.status).toBe(200);
      expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "session:abc123", "ideas");
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);

      withIssue({ lifecycle: "planning" });
      const refused = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/promote`, { headers: API, body: "{}" });
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.body).error).toContain("Only an issue in Drafting or Requirements review");

      withIssue({ lifecycle: "ideas" });
      mockClawsIssues.promoteIssue.mockResolvedValueOnce(false);
      const raced = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/promote`, { headers: API, body: "{}" });
      expect(raced.status).toBe(409);
    });

    it("reads the model plan and sets only the listed phases as explicit, a blank one clearing only its explicit cell", async () => {
      const gh = await import("./github.js");
      const db = await import("./db.js");
      const suggested = { repo: "org/repo", issue_ref: NATIVE, phase: "review", provider: "claude", tier: "sonnet", source: "suggested", updated_at: "2026-09-22 10:00:00" };
      const explicitPlan = { repo: "org/repo", issue_ref: NATIVE, phase: "plan", provider: "claude", tier: "opus", source: "explicit", updated_at: "2026-09-26 10:00:00" };
      vi.mocked(db.getIssueModelPlanRows).mockResolvedValueOnce([suggested] as any);
      const read = await request(server, "GET", `/api/issues/${NATIVE}/model-plan`, { headers: READ_API });
      expect(read.status).toBe(200);
      const review = JSON.parse(read.body).phases.find((p: { phase: string }) => p.phase === "review");
      expect(review).toMatchObject({ explicit: null, suggested: { provider: "claude", tier: "sonnet" } });

      vi.mocked(db.getIssueModelPlanRows).mockResolvedValueOnce([suggested] as any).mockResolvedValueOnce([suggested, explicitPlan] as any);
      const res = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/model-plan`, {
        headers: API,
        body: JSON.stringify({ cells: [{ phase: "plan", provider: "claude", tier: "Opus" }, { phase: "review", provider: "", tier: "" }] }),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).changed).toBe(true);
      expect(db.upsertIssueModelPlanCell).toHaveBeenCalledWith("org/repo", NATIVE, "plan", { provider: "claude", tier: "opus", source: "explicit" });
      expect(db.upsertIssueModelPlanCell).toHaveBeenCalledTimes(1);
      expect(db.deleteIssueModelPlanCell).toHaveBeenCalledWith("org/repo", NATIVE, "review", "explicit");
      expect(db.deleteIssueModelPlanCell).toHaveBeenCalledTimes(1);
      // "review" had no explicit cell before the request either — blanking an
      // already-blank cell must not be reported as cleared.
      expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Session `abc123` changed the model plan: set plan: claude/opus.");
    });

    it("reports a phase that actually lost its explicit cell as cleared", async () => {
      const gh = await import("./github.js");
      const db = await import("./db.js");
      const explicitPlan = { repo: "org/repo", issue_ref: NATIVE, phase: "plan", provider: "claude", tier: "opus", source: "explicit", updated_at: "2026-09-26 10:00:00" };
      vi.mocked(db.getIssueModelPlanRows).mockResolvedValueOnce([explicitPlan] as any).mockResolvedValueOnce([]);
      const res = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/model-plan`, {
        headers: API,
        body: JSON.stringify({ cells: [{ phase: "plan", provider: "", tier: "" }] }),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).changed).toBe(true);
      expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Session `abc123` changed the model plan: cleared plan.");
    });

    it("refuses an unknown phase, provider or tier rather than blanking it", async () => {
      const db = await import("./db.js");
      for (const cell of [{ phase: "deploy" }, { phase: "plan", provider: "gpt" }, { phase: "plan", tier: "huge" }]) {
        const res = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/model-plan`, { headers: API, body: JSON.stringify({ cells: [cell] }) });
        expect(res.status).toBe(400);
      }
      expect(db.upsertIssueModelPlanCell).not.toHaveBeenCalled();
      expect(db.deleteIssueModelPlanCell).not.toHaveBeenCalled();
    });

    it("applies the dashboard's ownership guard to every write", async () => {
      const writes = [
        (sid = SID) => setLabel("Priority", true, sid),
        (sid = SID) => request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/approval`, { headers: API, body: JSON.stringify({ through: "plan" }) }),
        (sid = SID) => request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/promote`, { headers: API, body: "{}" }),
        (sid = SID) => request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/model-plan`, { headers: API, body: JSON.stringify({ cells: [{ phase: "plan", tier: "opus" }] }) }),
        (sid = SID) => request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/edit`, { headers: API, body: JSON.stringify({ title: "Renamed" }) }),
        (sid = SID) => request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/column`, { headers: API, body: JSON.stringify({ column: "backlog" }) }),
      ];
      for (const write of writes) {
        // "deadbeef" is not the session the bearer names — that is an auth
        // failure now, ahead of sessionIssueGuard's own live-session check.
        expect((await write("deadbeef")).status).toBe(401);
        withIssue({ kind: "shadow" });
        expect((await write()).status).toBe(404);
        withIssue({ repos: ["aa/unmanaged", "org/repo"] });
        expect((await write()).status).toBe(403);
        withIssue({ state: "closed" });
        expect((await write()).status).toBe(409);
        withIssue({ repos: [] });
        expect((await write()).status).toBe(409);
        withIssue({});
      }
      for (const leaf of ["labels", "approval"]) {
        const forge = await request(server, "POST", `/api/sessions/${SID}/issues/42/${leaf}`, { headers: API, body: JSON.stringify({ label: "Priority", present: true, through: "plan" }) });
        expect(forge.status).toBe(404);
        expect(JSON.parse(forge.body).error).toContain("Forgejo API");
      }
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
      expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
      expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    });

    it("guards the state and repos routes, lifting only the refusals the dashboard lifts", async () => {
      const writes = [
        (sid = SID) => setState({ state: "closed", reason: "completed" }, sid),
        (sid = SID) => request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/repos`, { headers: API, body: JSON.stringify({ repos: ["org/repo", "test/repo"] }) }),
      ];
      for (const write of writes) {
        expect((await write("deadbeef")).status).toBe(401);
        withIssue({ kind: "shadow" });
        expect((await write()).status).toBe(404);
        withIssue({ repos: ["aa/unmanaged", "org/repo"] });
        expect((await write()).status).toBe(403);
        withIssue({});
      }
      // The repos route still refuses a closed issue; the state route needs one to reopen.
      withIssue({ state: "closed" });
      expect((await writes[1]!()).status).toBe(409);
      for (const leaf of ["state", "edit", "repos", "column"]) {
        const forge = await request(server, "POST", `/api/sessions/${SID}/issues/42/${leaf}`, { headers: API, body: "{}" });
        expect(forge.status).toBe(404);
      }
      const gh = await import("./github.js");
      expect(gh.closeIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.setRepos).not.toHaveBeenCalled();
    });

    it("needs the API credential, not a dashboard session", async () => {
      testSessionCookie = null;
      const res = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/labels`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Priority", present: true }) });
      expect(res.status).toBe(401);
      const approval = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/approval`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ through: "plan" }) });
      expect(approval.status).toBe(401);
    });

    it("refuses the shared internal token and an agent pod's own token — every agent holds one of those", async () => {
      // apiAuthMiddleware accepts both, but these three routes approve a native
      // issue's plan or merge, so neither may pass here — an agent must not be
      // able to grant itself that.
      const sharedToken = { authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };
      const agentPodToken = { authorization: "Bearer agent-pod-token", "content-type": "application/json" };
      for (const headers of [sharedToken, agentPodToken]) {
        expect((await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/labels`, { headers, body: JSON.stringify({ label: "Priority", present: true }) })).status).toBe(401);
        expect((await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/approval`, { headers, body: JSON.stringify({ through: "plan" }) })).status).toBe(401);
        expect((await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/promote`, { headers, body: "{}" })).status).toBe(401);
        expect((await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/model-plan`, { headers, body: JSON.stringify({ cells: [{ phase: "plan", tier: "opus" }] }) })).status).toBe(401);
        for (const [leaf, body] of [["state", { state: "closed", reason: "completed" }], ["edit", { title: "x" }], ["repos", { repos: ["org/repo"] }], ["column", { column: "backlog" }]] as const) {
          expect((await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/${leaf}`, { headers, body: JSON.stringify(body) })).status).toBe(401);
        }
      }
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
      expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
    });

    describe("clear a PR's manual action", () => {
      const clear = (body: unknown, headers: Record<string, string> = API, sid = SID) =>
        request(server, "POST", `/api/sessions/${sid}/prs/clear-manual-action`, { headers, body: JSON.stringify(body) });

      it("clears the row's hold and audits the PR as this session", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        // Read by the route, then by clearPrHold.
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ manualActionReason: "set prod secrets" }) as any);
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ manualActionReason: "set prod secrets" }) as any);
        const res = await clear({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({ ok: true, changed: true, reason: "set prod secrets" });
        expect(db.upsertClawsPr).toHaveBeenCalledWith("org/repo", 7, { manualActionReason: null });
        expect(gh.removeLabel).not.toHaveBeenCalled();
        expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
        expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", 7, expect.stringContaining("Session `abc123` cleared the recorded manual action"));
      });

      it("refuses the shared internal token", async () => {
        const gh = await import("./github.js");
        const res = await clear({ repo: "org/repo", number: 7 }, READ_API);
        expect(res.status).toBe(401);
        expect(gh.removeLabel).not.toHaveBeenCalled();
      });

      it("refuses an unknown row, a row with no manual action, bad input and an unmanaged repo", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(null);
        expect((await clear({ repo: "org/repo", number: 7 })).status).toBe(404);
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow() as any);
        expect((await clear({ repo: "org/repo", number: 7 })).status).toBe(409);
        expect((await clear({ repo: "org/repo" })).status).toBe(400);
        expect((await clear({ repo: "zz/unmanaged", number: 7 })).status).toBe(403);
        expect((await clear({ repo: "org/repo", number: 7 }, API, "deadbeef")).status).toBe(401);
        expect(gh.removeLabel).not.toHaveBeenCalled();
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
      });

      it("returns 500 without an audit comment when the row write fails", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ manualActionReason: "set prod secrets" }) as any);
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ manualActionReason: "set prod secrets" }) as any);
        vi.mocked(db.upsertClawsPr).mockRejectedValueOnce(new Error("db down"));
        const res = await clear({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(500);
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
      });
    });

    describe("PR recovery actions (#clw_01M4DQW4N7DJT8WHTCSV3NBZSD)", () => {
      const post = (leaf: string, body: unknown, headers: Record<string, string> = API, sid = SID) =>
        request(server, "POST", `/api/sessions/${sid}/prs/${leaf}`, { headers, body: JSON.stringify(body) });
      const REPORT = { id: 1, login: "claws", body: "*— Automated by Claws · Problematic PR Diagnoser —*\n\n### Report\nproblematic-pr-diagnosis-report", body_html: "" };

      it("refuses the shared internal token, an agent pod's token, a dead session and an unmanaged repo", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const agentPodToken = { authorization: "Bearer agent-pod-token", "content-type": "application/json" };
        for (const leaf of ["rerun-failed", "unmark-problematic", "rediagnose"]) {
          expect((await post(leaf, { repo: "org/repo", number: 7 }, READ_API)).status).toBe(401);
          expect((await post(leaf, { repo: "org/repo", number: 7 }, agentPodToken)).status).toBe(401);
          expect((await post(leaf, { repo: "org/repo", number: 7 }, API, "deadbeef")).status).toBe(401);
          expect((await post(leaf, { repo: "zz/unmanaged", number: 7 })).status).toBe(403);
          expect((await post(leaf, { repo: "org/repo" })).status).toBe(400);
        }
        expect(gh.rerunFailedJobsForSession).not.toHaveBeenCalled();
        expect(gh.removeLabel).not.toHaveBeenCalled();
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
      });

      it("re-runs the newest failed run on the head commit, records it and audits the PR as this session", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const res = await post("rerun-failed", { repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, run: 42, jobs: ["build", "test"] });
        expect(gh.findLatestFailedRun).toHaveBeenCalledWith("org/repo", "abc1234def");
        expect(gh.rerunFailedJobsForSession).toHaveBeenCalledWith("org/repo", 42);
        expect(db.recordSessionPrAction).toHaveBeenCalledWith(expect.objectContaining({ repo: "org/repo", prNumber: 7, sessionId: SID, action: "rerun" }));
        expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", 7, "Session `abc123` re-ran the failed jobs of run 42 (`build`, `test`).");
      });

      it("re-runs a named run only when it is on the head commit", async () => {
        const gh = await import("./github.js");
        expect((await post("rerun-failed", { repo: "org/repo", number: 7, run: 9 })).status).toBe(200);
        expect(gh.isRunOnCommit).toHaveBeenCalledWith("org/repo", 9, "abc1234def");
        expect(gh.rerunFailedJobsForSession).toHaveBeenCalledWith("org/repo", 9);
        vi.mocked(gh.rerunFailedJobsForSession).mockClear();
        vi.mocked(gh.isRunOnCommit).mockResolvedValueOnce(false);
        const stale = await post("rerun-failed", { repo: "org/repo", number: 7, run: 8 });
        expect(stale.status).toBe(409);
        expect(JSON.parse(stale.body).error).toContain("not on the PR's head commit");
        expect(gh.rerunFailedJobsForSession).not.toHaveBeenCalled();
      });

      it("refuses a closed PR and a head commit with no failed run, and passes a Forgejo 409 through", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(gh.getPRMergeGate).mockResolvedValueOnce({ state: "MERGED", headSha: "abc1234def" } as any);
        expect((await post("rerun-failed", { repo: "org/repo", number: 7 })).status).toBe(404);
        vi.mocked(gh.findLatestFailedRun).mockResolvedValueOnce(null);
        const none = await post("rerun-failed", { repo: "org/repo", number: 7 });
        expect(none.status).toBe(409);
        expect(JSON.parse(none.body).error).toBe("No failed run on the PR's head commit");
        expect(gh.rerunFailedJobsForSession).not.toHaveBeenCalled();
        vi.mocked(gh.rerunFailedJobsForSession).mockRejectedValueOnce(Object.assign(new Error("action run is not done"), { status: 409 }));
        const busy = await post("rerun-failed", { repo: "org/repo", number: 7 });
        expect(busy.status).toBe(409);
        expect(JSON.parse(busy.body).error).toBe("action run is not done");
        vi.mocked(gh.rerunFailedJobsForSession).mockRejectedValueOnce(new Error("forgejo POST /x: endpoint unavailable"));
        expect((await post("rerun-failed", { repo: "org/repo", number: 7 })).status).toBe(502);
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
      });

      it("unmarks a Problematic PR, resets its CI-fix budget, records it and audits the PR", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ stage: "problematic" }) as any);
        const res = await post("unmark-problematic", { repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 7, "Claws Problematic");
        expect(db.resetCIFixerBreakerGrants).toHaveBeenCalledWith("org/repo", 7);
        expect(db.recordSessionPrAction).toHaveBeenCalledWith(expect.objectContaining({ repo: "org/repo", prNumber: 7, sessionId: SID, action: "unmark-problematic" }));
        expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", 7, expect.stringContaining("Session `abc123` unmarked this PR"));
      });

      it("refuses to unmark an unknown or non-Problematic PR, and 500s when the removal is unconfirmed", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(null);
        expect((await post("unmark-problematic", { repo: "org/repo", number: 7 })).status).toBe(404);
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow() as any);
        expect((await post("unmark-problematic", { repo: "org/repo", number: 7 })).status).toBe(409);
        expect(gh.removeLabel).not.toHaveBeenCalled();
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ stage: "problematic" }) as any);
        vi.mocked(gh.removeLabel).mockResolvedValueOnce(false);
        expect((await post("unmark-problematic", { repo: "org/repo", number: 7 })).status).toBe(500);
        expect(db.resetCIFixerBreakerGrants).not.toHaveBeenCalled();
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
      });

      it("requests a rediagnosis with a Claws-marked marker comment and records it", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ stage: "problematic" }) as any);
        vi.mocked(gh.getIssueComments).mockResolvedValueOnce([REPORT] as any);
        const res = await post("rediagnose", { repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
        const [, , body] = vi.mocked(gh.commentOnIssue).mock.calls[0]!;
        expect(body).toContain("problematic-pr-rediagnose-requested");
        expect(body).toContain("Session `abc123`");
        expect(db.recordSessionPrAction).toHaveBeenCalledWith(expect.objectContaining({ repo: "org/repo", prNumber: 7, sessionId: SID, action: "rediagnose" }));
      });

      it("refuses a rediagnosis on a non-Problematic PR or with no report newer than the last request", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow() as any);
        expect((await post("rediagnose", { repo: "org/repo", number: 7 })).status).toBe(409);
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ stage: "problematic" }) as any);
        vi.mocked(gh.getIssueComments).mockResolvedValueOnce([
          REPORT,
          { id: 2, login: "claws", body: "*— Automated by Claws —*\n\nproblematic-pr-rediagnose-requested", body_html: "" },
        ] as any);
        const res = await post("rediagnose", { repo: "org/repo", number: 7 });
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body).error).toBe("No diagnosis report to retry");
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
      });

      it("posts operator feedback with no Claws footer and records its id as this session's feedback", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const res = await post("comment", { repo: "org/repo", number: 7, body: "Accept the escalation; keep the old API." });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, commentId: "4047" });
        expect(gh.postOperatorComment).toHaveBeenCalledWith("org/repo", 7, "**Operator feedback via Claws session `abc123`:**\n\nAccept the escalation; keep the old API.");
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
        expect(db.recordSessionPrAction).toHaveBeenCalledWith({ repo: "org/repo", prNumber: 7, sessionId: SID, action: "feedback", commentId: "4047" });
      });

      it("refuses feedback without auth, on an unmanaged repo or closed PR, or with an empty or oversized body", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const agentPodToken = { authorization: "Bearer agent-pod-token", "content-type": "application/json" };
        expect((await post("comment", { repo: "org/repo", number: 7, body: "x" }, READ_API)).status).toBe(401);
        expect((await post("comment", { repo: "org/repo", number: 7, body: "x" }, agentPodToken)).status).toBe(401);
        expect((await post("comment", { repo: "zz/unmanaged", number: 7, body: "x" })).status).toBe(403);
        expect((await post("comment", { repo: "org/repo", number: 7 })).status).toBe(400);
        expect((await post("comment", { repo: "org/repo", number: 7, body: "  " })).status).toBe(400);
        expect((await post("comment", { repo: "org/repo", number: 7, body: "x".repeat(20_001) })).status).toBe(400);
        vi.mocked(gh.getPRMergeGate).mockResolvedValueOnce({ state: "MERGED", headSha: "abc1234def" } as any);
        expect((await post("comment", { repo: "org/repo", number: 7, body: "x" })).status).toBe(404);
        expect(gh.postOperatorComment).not.toHaveBeenCalled();
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
      });

      it("surfaces a failed feedback record, since the comment would otherwise read as Claws output", async () => {
        const db = await import("./db.js");
        vi.mocked(db.recordSessionPrAction).mockRejectedValueOnce(new Error("disk full"));
        const res = await post("comment", { repo: "org/repo", number: 7, body: "x" });
        expect(res.status).toBe(500);
        expect(JSON.parse(res.body).error).toMatch(/Posted comment 4047 but failed to record it/);
      });
    });

    describe("POST /api/sessions/:sid/prs/merge (#clw_01M4XFRSGNP87QVW0N1W5KN0V4)", () => {
      const merge = (body: unknown, headers: Record<string, string> = API, sid = SID) =>
        request(server, "POST", `/api/sessions/${sid}/prs/merge`, { headers, body: JSON.stringify(body) });
      const PR = { number: 7, title: "Fix", headRefName: "claws/issue-42-abcd", baseRefName: "main", labels: [], body: "" };
      const approvedRow = () => openPrRow({ mergeApprovedBy: "operator", mergeApprovedAt: "2026-10-14T10:00:00Z" });

      it("refuses other tokens, a dead session, an unmanaged repo and bad input", async () => {
        const merger = await import("./agents/auto-merger.js");
        expect((await merge({ repo: "org/repo", number: 7 }, READ_API)).status).toBe(401);
        expect((await merge({ repo: "org/repo", number: 7 }, API, "deadbeef")).status).toBe(401);
        expect((await merge({ repo: "zz/unmanaged", number: 7 })).status).toBe(403);
        expect((await merge({ repo: "org/repo" })).status).toBe(400);
        expect(merger.attemptMerge).not.toHaveBeenCalled();
      });

      it("refuses a PR with no Claws record or no stored merge approval, without merging", async () => {
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(null);
        expect((await merge({ repo: "org/repo", number: 7 })).status).toBe(404);
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow() as any);
        const res = await merge({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body)).toMatchObject({ code: "not-approved" });
        expect(merger.attemptMerge).not.toHaveBeenCalled();
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
      });

      it("merges an approved PR through the auto-merger's gates, records it and audits the PR as this session", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(approvedRow() as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: true });
        const res = await merge({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, merged: true });
        expect(merger.attemptMerge).toHaveBeenCalledWith(expect.objectContaining({ fullName: "org/repo" }), PR, { mergedBy: "session:abc123" });
        expect(db.recordSessionPrAction).toHaveBeenCalledWith(expect.objectContaining({ repo: "org/repo", prNumber: 7, sessionId: SID, action: "merge", detail: "approved by operator" }));
        expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", 7, "Session `abc123` merged this PR directly (merge approved by operator).");
      });

      it("lets a session holding infra-merge make the human merge of an infra PR, and names the capability (#clw_01M54GYV05ZCZWKEEMAJTE9Q3X)", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        fakeBackend.getLive.mockResolvedValueOnce(liveWithCapabilities(["infra-merge"]));
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(approvedRow() as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: true, infraPaths: ["tofu/main.tf"] });
        const res = await merge({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, merged: true });
        expect(merger.attemptMerge).toHaveBeenCalledWith(expect.objectContaining({ fullName: "org/repo" }), PR, { mergedBy: "session:abc123", infraMergeBy: "abc123" });
        expect(db.recordSessionPrAction).toHaveBeenCalledWith(expect.objectContaining({
          action: "merge",
          detail: "approved by operator; human merge for infrastructure paths (tofu/main.tf) under the infra-merge capability",
        }));
        expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", 7, "Session `abc123` merged this PR directly as the human merge for its infrastructure changes (tofu/main.tf), under the operator-granted `infra-merge` capability (merge approved by operator).");
      });

      it("returns the auto-merger's infra refusal unchanged for a session without infra-merge", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(approvedRow() as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: false, code: "infra", message: "Infrastructure changes (tofu/main.tf) always need a human merge." });
        const res = await merge({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body)).toEqual({ error: "Infrastructure changes (tofu/main.tf) always need a human merge.", code: "infra" });
        expect(merger.attemptMerge).toHaveBeenCalledWith(expect.anything(), PR, { mergedBy: "session:abc123" });
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
      });

      it("returns an auto-merger refusal with its code and records nothing", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(approvedRow() as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: false, code: "checks-failed", message: "CI is failing." });
        const res = await merge({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body)).toEqual({ error: "CI is failing.", code: "checks-failed" });
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
      });

      it("answers already merged when attemptMerge throws but the PR is merged", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(approvedRow() as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockRejectedValueOnce(new Error("405 already merged"));
        vi.mocked(gh.getPRState).mockResolvedValueOnce("MERGED");
        const res = await merge({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, merged: false, note: "already merged" });
      });

      it("returns an other-work refusal with its code", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(approvedRow() as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: false, code: "other-work", message: "busy" });
        const res = await merge({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body)).toEqual({ error: "busy", code: "other-work" });
      });

      it("answers already merged when the auto-merger got there first, and refuses a PR that is not open", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(approvedRow() as any);
        vi.mocked(gh.getPRState).mockResolvedValueOnce("MERGED");
        const done = await merge({ repo: "org/repo", number: 7 });
        expect(done.status).toBe(200);
        expect(JSON.parse(done.body)).toEqual({ ok: true, merged: false, note: "already merged" });
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(approvedRow() as any);
        vi.mocked(gh.getPRState).mockResolvedValueOnce("CLOSED");
        expect((await merge({ repo: "org/repo", number: 7 })).status).toBe(409);
        expect(merger.attemptMerge).not.toHaveBeenCalled();
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
      });
    });

    describe("POST /api/sessions/:sid/prs/approve-merge (#clw_01M5022YK7Z2V63775Y92B59P3)", () => {
      const approve = (body: unknown, headers: Record<string, string> = API, sid = SID) =>
        request(server, "POST", `/api/sessions/${sid}/prs/approve-merge`, { headers, body: JSON.stringify(body) });
      const PR = { number: 7, title: "Fix", headRefName: "claws/issue-42-abcd", baseRefName: "main", labels: [], body: "" };

      it("refuses other tokens, a dead session, an unmanaged repo, bad input and a PR that is not open", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        expect((await approve({ repo: "org/repo", number: 7 }, READ_API)).status).toBe(401);
        expect((await approve({ repo: "org/repo", number: 7 }, API, "deadbeef")).status).toBe(401);
        expect((await approve({ repo: "zz/unmanaged", number: 7 })).status).toBe(403);
        expect((await approve({ repo: "org/repo", number: 7, queue: "yes" })).status).toBe(400);
        vi.mocked(gh.getPRState).mockResolvedValueOnce("MERGED");
        const closed = await approve({ repo: "org/repo", number: 7 });
        expect(closed.status).toBe(409);
        expect(JSON.parse(closed.body).error).toBe("PR is not open");
        expect(db.upsertClawsPr).not.toHaveBeenCalled();
        expect(merger.attemptMerge).not.toHaveBeenCalled();
      });

      it("approves this PR alone as the session, with no Automerge label, and merges it", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(gh.getPRState).mockResolvedValueOnce("OPEN");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ issueId: NATIVE }) as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: true });
        const res = await approve({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, merged: true });
        expect(db.upsertClawsPr).toHaveBeenCalledTimes(1);
        expect(db.upsertClawsPr).toHaveBeenCalledWith("org/repo", 7, { mergeApprovedBy: "session:abc123", mergeApprovedAt: expect.any(String) });
        expect(gh.addLabel).not.toHaveBeenCalled();
        expect(merger.attemptMerge).toHaveBeenCalledWith(expect.objectContaining({ fullName: "org/repo" }), PR, { mergedBy: "session:abc123", notify: false });
        expect(db.recordSessionPrAction).toHaveBeenCalledWith(expect.objectContaining({ repo: "org/repo", prNumber: 7, sessionId: SID, action: "approve-merge", detail: "merged" }));
        expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", 7, "Session `abc123` approved the merge of this PR only (not the issue's other PRs) and merged it directly.");
      });

      it("passes infraMergeBy for a session holding infra-merge and names the capability on the merge (#clw_01M54GYV05ZCZWKEEMAJTE9Q3X)", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        fakeBackend.getLive.mockResolvedValueOnce(liveWithCapabilities(["infra-merge"]));
        vi.mocked(gh.getPRState).mockResolvedValueOnce("OPEN");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow() as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: true, infraPaths: ["tofu/main.tf"] });
        const res = await approve({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(merger.attemptMerge).toHaveBeenCalledWith(expect.anything(), PR, { mergedBy: "session:abc123", notify: false, infraMergeBy: "abc123" });
        expect(db.recordSessionPrAction).toHaveBeenCalledWith(expect.objectContaining({
          action: "approve-merge",
          detail: "merged; human merge for infrastructure paths (tofu/main.tf) under the infra-merge capability",
        }));
        expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", 7, "Session `abc123` approved the merge of this PR only (not the issue's other PRs) and merged it directly as the human merge for its infrastructure changes (tofu/main.tf), under the operator-granted `infra-merge` capability.");
      });

      it("withdraws the approval it wrote and returns the refusal when a gate fails without queue", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        let written: { mergeApprovedBy: string; mergeApprovedAt: string } | undefined;
        vi.mocked(db.upsertClawsPr).mockImplementationOnce(async (_r, _n, patch) => { written = patch as typeof written; });
        vi.mocked(gh.getPRState).mockResolvedValueOnce("OPEN");
        vi.mocked(db.getClawsPr)
          .mockResolvedValueOnce(openPrRow() as any)
          .mockImplementationOnce(async () => openPrRow({ ...written, mergeApprovedAt: `${written!.mergeApprovedAt.slice(0, 19)}Z` }) as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: false, code: "checks-failed", message: "CI is failing." });
        const res = await approve({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body)).toEqual({ error: "CI is failing.", code: "checks-failed" });
        expect(db.upsertClawsPr).toHaveBeenLastCalledWith("org/repo", 7, { mergeApprovedBy: null, mergeApprovedAt: null });
        expect(db.recordSessionPrAction).not.toHaveBeenCalled();
        expect(gh.commentOnIssue).not.toHaveBeenCalled();
      });

      it("keeps an approval recorded by someone else in the meantime when withdrawing", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(gh.getPRState).mockResolvedValueOnce("OPEN");
        vi.mocked(db.getClawsPr)
          .mockResolvedValueOnce(openPrRow() as any)
          .mockResolvedValueOnce(openPrRow({ mergeApprovedBy: "operator", mergeApprovedAt: "2026-10-15T10:00:00Z" }) as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: false, code: "checks-failed", message: "CI is failing." });
        expect((await approve({ repo: "org/repo", number: 7 })).status).toBe(409);
        expect(db.upsertClawsPr).toHaveBeenCalledTimes(1);
      });

      it("keeps the approval and answers queued when a gate fails with queue", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(gh.getPRState).mockResolvedValueOnce("OPEN");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow() as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: false, code: "checks-pending", message: "CI is pending." });
        const res = await approve({ repo: "org/repo", number: 7, queue: true });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, merged: false, queued: true, reason: "CI is pending.", code: "checks-pending" });
        expect(merger.attemptMerge).toHaveBeenCalledWith(expect.anything(), PR, { mergedBy: "session:abc123" });
        expect(db.upsertClawsPr).toHaveBeenCalledTimes(1);
        expect(db.recordSessionPrAction).toHaveBeenCalledWith(expect.objectContaining({ action: "approve-merge", detail: "queued" }));
        expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", 7, "Session `abc123` approved the merge of this PR only (not the issue's other PRs); Claws merges it once it is ready.");
      });

      it("neither overwrites nor withdraws an approval already stored on the PR", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(gh.getPRState).mockResolvedValueOnce("OPEN");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ mergeApprovedBy: "operator", mergeApprovedAt: "2026-10-14T10:00:00Z" }) as any);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: false, code: "checks-failed", message: "CI is failing." });
        expect((await approve({ repo: "org/repo", number: 7 })).status).toBe(409);
        expect(db.upsertClawsPr).not.toHaveBeenCalled();
      });

      it("seeds and approves a row for a PR with no record and no linked issue", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        const merger = await import("./agents/auto-merger.js");
        vi.mocked(gh.getPRState).mockResolvedValueOnce("OPEN").mockResolvedValueOnce("OPEN");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(null);
        vi.mocked(gh.listPRs).mockResolvedValueOnce([PR] as any);
        vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: true });
        const res = await approve({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(db.upsertClawsPr).toHaveBeenCalledWith("org/repo", 7, { stage: "opened", mergeApprovedBy: "session:abc123", mergeApprovedAt: expect.any(String) });
      });
    });
  });

  describe("GET /api/issues/:id and GET /api/issues (#clw_01M39DBY5TECBRC8WZS8NJBRZR)", () => {
    const API = { authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };
    const PLAN_COMMENT = "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDA";

    it("returns the issue, its current plan and its non-plan comments, flagging Claws and plan comments", async () => {
      mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
        { id: PLAN_COMMENT, login: "claws", body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing", body_html: "<p>Do the thing</p>", createdAt: "2026-09-21 10:05:00" },
        { id: "clwc_2", login: "claws", body: "*— Automated by Claws —*\n\nA status note", body_html: "<p>A status note</p>", createdAt: "2026-09-21 10:06:00" },
        { id: "clwc_3", login: "stjohnb", body: "Looks good", body_html: "<p>Looks good</p>", createdAt: "2026-09-21 10:10:00" },
      ] as any);
      mockClawsIssues.listPlans.mockResolvedValueOnce([
        { version: 1, commentId: PLAN_COMMENT, body: "Do the thing", createdAt: "2026-09-21 10:05:00" },
      ] as any);

      const res = await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        id: NATIVE,
        title: nativeIssue.title,
        body: nativeIssue.body,
        state: "open",
        labels: [],
        repos: ["org/repo"],
        approved_through: "requirements",
        stops_at: "Stops at: plan review",
        plan: { version: 1, comment_id: PLAN_COMMENT, body: "Do the thing" },
        previous_plans: [],
      });
      expect(body.comments.map((c: any) => c.id)).toEqual(["clwc_2", "clwc_3"]);
      expect(body.comments).toContainEqual(expect.objectContaining({ id: "clwc_2", author_login: "claws", is_claws: true, is_plan: false }));
      expect(body.comments).toContainEqual(expect.objectContaining({ id: "clwc_3", author_login: "stjohnb", is_claws: false, is_plan: false }));
    });

    // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F: the stored approval and the track's "Stops at" line.
    it("reports approved_through and the approval track's stops_at", async () => {
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, approved_through: "plan" } as any);
      const approved = JSON.parse((await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API })).body);
      expect(approved).toMatchObject({ approved_through: "plan", stage: "approved", stops_at: "Stops at: merge approval" });

      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, lifecycle: "planning", approved_through: "merge" } as any);
      const preapproved = JSON.parse((await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API })).body);
      expect(preapproved).toMatchObject({ approved_through: "merge", stage: "planning", stops_at: "Runs to merge — no further stop" });

      const { approved_through: _drop, ...legacy } = nativeIssue;
      mockClawsIssues.getIssue.mockResolvedValue({ ...legacy, lifecycle: "ideas" } as any);
      const none = JSON.parse((await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API })).body);
      expect(none).toMatchObject({ approved_through: "none", stops_at: "Stops at: requirements review" });
    });

    it("reports the recorded blocked_reason for a Blocked issue and null otherwise", async () => {
      const db = await import("./db.js");
      mockClawsIssues.getIssue.mockResolvedValueOnce({ ...nativeIssue, lifecycle: "blocked" } as any);
      vi.mocked(db.getIssueBlockedReasons).mockResolvedValueOnce(new Map([[NATIVE, "needs a secret"]]));
      const blocked = await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API });
      expect(JSON.parse(blocked.body).blocked_reason).toBe("needs a secret");
      const healthy = await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API });
      expect(JSON.parse(healthy.body).blocked_reason).toBeNull();
    });

    it("drops a legacy requirements comment from comments even when no version links to it", async () => {
      mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
        { id: "clwc_req", login: "claws", body: "*— Automated by Claws · Requirements writer —*\n\n## Requirements\n\nOld record", body_html: "<p>Old record</p>", createdAt: "2026-09-21 10:05:00" },
        { id: "clwc_3", login: "stjohnb", body: "Looks good", body_html: "<p>Looks good</p>", createdAt: "2026-09-21 10:10:00" },
      ] as any);
      mockClawsIssues.listPlans.mockResolvedValueOnce([]);
      const res = await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).comments.map((c: any) => c.id)).toEqual(["clwc_3"]);
    });

    it("reports older plan versions in previous_plans without their body", async () => {
      mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
        { id: PLAN_COMMENT, login: "claws", body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nRevised plan", body_html: "<p>Revised plan</p>", createdAt: "2026-09-22 10:05:00" },
      ] as any);
      mockClawsIssues.listPlans.mockResolvedValueOnce([
        { version: 1, commentId: "clwc_old_plan", body: "Original plan", createdAt: "2026-09-21 10:05:00" },
        { version: 2, commentId: PLAN_COMMENT, body: "Revised plan", createdAt: "2026-09-22 10:05:00" },
      ] as any);
      const res = await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.plan).toMatchObject({ version: 2, comment_id: PLAN_COMMENT, body: "Revised plan" });
      expect(body.previous_plans).toEqual([{ version: 1, comment_id: "clwc_old_plan", created_at: "2026-09-21 10:05:00" }]);
    });

    it("keeps the plan comment in comments when the latest plan has no comment id", async () => {
      mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
        { id: PLAN_COMMENT, login: "claws", body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing", body_html: "<p>Do the thing</p>", createdAt: "2026-09-21 10:05:00" },
      ] as any);
      mockClawsIssues.listPlans.mockResolvedValueOnce([
        { version: 1, commentId: null, body: "Do the thing", createdAt: "2026-09-21 10:05:00" },
      ] as any);
      const res = await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.comments).toContainEqual(expect.objectContaining({ id: PLAN_COMMENT, is_plan: true }));
    });

    it("404s for a shadow issue and for an unknown id", async () => {
      mockClawsIssues.getIssue.mockResolvedValueOnce({ ...nativeIssue, kind: "shadow" });
      const shadow = await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API });
      expect(shadow.status).toBe(404);
      expect(JSON.parse(shadow.body)).toEqual({ error: "Issue not found" });

      const unknown = await request(server, "GET", "/api/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD", { headers: API });
      expect(unknown.status).toBe(404);
    });

    it("401s without credentials", async () => {
      testSessionCookie = null;
      const res = await request(server, "GET", `/api/issues/${NATIVE}`);
      expect(res.status).toBe(401);
    });

    it("lists open issues, filtered case-insensitively by repo, with has_plan", async () => {
      const { listClawsIssues, listIssueIdsWithPlans } = await import("./db.js");
      vi.mocked(listClawsIssues).mockResolvedValueOnce([{ ...nativeIssue }] as any);
      vi.mocked(listIssueIdsWithPlans).mockResolvedValueOnce(new Set([NATIVE]));

      const res = await request(server, "GET", "/api/issues?repo=ORG%2FREPO", { headers: API });

      expect(res.status).toBe(200);
      expect(listClawsIssues).toHaveBeenCalledWith({ state: "open", repo: "org/repo", limit: 101, offset: 0 });
      expect(JSON.parse(res.body)).toEqual({
        issues: [{ id: NATIVE, title: nativeIssue.title, state: "open", state_reason: null, closed_at: null, duplicate_of: null, labels: [], repos: ["org/repo"], primary_repo: "org/repo", updated_at: nativeIssue.updated_at, has_plan: true, dedupe_key: null, stage: "awaiting-plan-review", stage_title: "Awaiting plan review", approved_through: "requirements", stops_at: "Stops at: plan review", backlog_until: null }],
        truncated: false,
        next_offset: null,
      });
    });

    it("reports each listed issue's approval and stop, reading every row's flight in one batch", async () => {
      const { listClawsIssues, getIssueBlockedReasons, listIssueIdsWithPlans } = await import("./db.js");
      const OTHER = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE";
      const BLOCKED = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF";
      vi.mocked(listClawsIssues).mockResolvedValueOnce([
        { ...nativeIssue, approved_through: "plan" },
        { ...nativeIssue, id: OTHER, lifecycle: "planning", approved_through: "merge" },
        { ...nativeIssue, id: BLOCKED, lifecycle: "blocked", labels: ["Blocked"] },
      ] as any);
      vi.mocked(getIssueBlockedReasons).mockResolvedValueOnce(new Map([[BLOCKED, "needs a key"]]));
      vi.mocked(listIssueIdsWithPlans).mockResolvedValueOnce(new Set([NATIVE]));

      const res = await request(server, "GET", "/api/issues", { headers: API });

      const rows = JSON.parse(res.body).issues.map((r: any) => [r.id, r.approved_through, r.stops_at]);
      expect(rows).toEqual([
        [NATIVE, "plan", "Stops at: merge approval"],
        [OTHER, "merge", "Runs to merge — no further stop"],
        [BLOCKED, "requirements", "Stops at: Blocked"],
      ]);
      expect(mockIssueFlight.loadIssueFlight).not.toHaveBeenCalled();
    });

    it("lists every open issue without a repo filter", async () => {
      const { listClawsIssues, listIssueIdsWithPlans } = await import("./db.js");
      vi.mocked(listClawsIssues).mockResolvedValueOnce([]);

      const res = await request(server, "GET", "/api/issues", { headers: API });

      expect(res.status).toBe(200);
      expect(listClawsIssues).toHaveBeenCalledWith({ state: "open", limit: 101, offset: 0 });
      expect(JSON.parse(res.body)).toEqual({ issues: [], truncated: false, next_offset: null });
    });

    it("caps the list at 100 issues and reports truncated: true", async () => {
      const { listClawsIssues, listIssueIdsWithPlans } = await import("./db.js");
      const records = Array.from({ length: 101 }, (_, i) => ({ ...nativeIssue, id: `clw_${i}` }));
      vi.mocked(listClawsIssues).mockResolvedValueOnce(records as any);
      const res = await request(server, "GET", "/api/issues", { headers: API });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.issues).toHaveLength(100);
      expect(body.truncated).toBe(true);
      expect(body.next_offset).toBe(100);
    });

    it("passes state, title, time and offset filters through and pages", async () => {
      const { listClawsIssues } = await import("./db.js");
      vi.mocked(listClawsIssues).mockResolvedValueOnce([]);
      const res = await request(server, "GET", "/api/issues?state=all&title=%20Build%20&closed_since=2026-10-20&updated_since=2026-10-21T00:00:00Z&offset=100", { headers: API });
      expect(res.status).toBe(200);
      expect(listClawsIssues).toHaveBeenCalledWith({
        state: "all", titleContains: "Build", closedSince: new Date("2026-10-20"), updatedSince: new Date("2026-10-21T00:00:00Z"), limit: 101, offset: 100,
      });
    });

    it("reports a closed duplicate's reason and target, with null stage fields", async () => {
      const { listClawsIssues } = await import("./db.js");
      const TARGET = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE";
      vi.mocked(listClawsIssues).mockResolvedValueOnce([{ ...nativeIssue, state: "closed", state_reason: "not_planned", closed_at: "2026-10-26 10:00:00" }] as any);
      mockClawsIssues.duplicateOfForIssues.mockResolvedValueOnce(new Map([[NATIVE, TARGET]]));
      const res = await request(server, "GET", "/api/issues?state=closed", { headers: API });
      const [row] = JSON.parse(res.body).issues;
      expect(row).toMatchObject({ id: NATIVE, state: "closed", state_reason: "not_planned", duplicate_of: TARGET, stage: null, stage_title: null, stops_at: null });
      expect(row.closed_at).toBe("2026-10-26 10:00:00");
    });

    it.each([
      ["state=bogus", "state must be open, closed or all"],
      ["closed_since=nope", "closed_since must be an ISO 8601 date"],
      ["updated_since=nope", "updated_since must be an ISO 8601 date"],
      ["closed_since=2026-10-20", "closed_since cannot be combined with state=open"],
      ["offset=-1", "offset must be a non-negative integer"],
      [`title=${"a".repeat(201)}`, "title must be at most 200 characters"],
    ])("400s %s", async (query, error) => {
      const res = await request(server, "GET", `/api/issues?${query}`, { headers: API });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error });
    });

    it("400s a malformed repo", async () => {
      const res = await request(server, "GET", "/api/issues?repo=not-a-repo", { headers: API });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "repo must be owner/name" });
    });

    describe("requirements and stage (#clw_01M4E54RY2PFWT9SRT81V16GVG)", () => {
      const IDEAS = { ...nativeIssue, labels: [], lifecycle: "ideas", approved_requirements_version: null, requirements_approved_by: null, requirements_approved_at: null };
      const APPROVED = { ...IDEAS, lifecycle: "planning", approved_requirements_version: 1, requirements_approved_by: "session:abc", requirements_approved_at: "2026-09-21 12:00:00" };
      const version = (n: number, createdAt: string) => ({
        version: n, title: `Title v${n}`, kind: "feature", context: "Why", requirement: "What",
        acceptanceCriteria: ["It works"], outOfScope: [], commentId: null, createdAt,
      });

      it("reports an issue with no record as an empty requirements state in Drafting", async () => {
        mockClawsIssues.getIssue.mockResolvedValueOnce({ ...IDEAS });
        const res = await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toMatchObject({ stage: "drafting", stage_title: "Drafting", requirements: null, previous_requirements: [] });
      });

      it("reports a record awaiting review as not approved, in Requirements review", async () => {
        mockClawsIssues.getIssue.mockResolvedValueOnce({ ...IDEAS });
        mockClawsIssues.listRequirements.mockResolvedValueOnce([version(1, "2026-09-21 11:00:00")]);
        const res = await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API });
        const body = JSON.parse(res.body);
        expect(body.stage).toBe("requirements-review");
        expect(body.stage_title).toBe("Requirements review");
        expect(body.requirements).toMatchObject({
          version: 1, created_at: "2026-09-21 11:00:00", kind: "feature", title: "Title v1",
          context: "Why", requirement: "What", acceptance_criteria: ["It works"], out_of_scope: [],
          approved: false, approved_by: null, approved_at: null, awaiting_review: true,
        });
        expect(body.requirements.body).toContain("## Requirements");
        expect(body.requirements.body).toContain("It works");
        expect(body.previous_requirements).toEqual([]);
      });

      it("reports a record with feedback since as Drafting", async () => {
        mockClawsIssues.getIssue.mockResolvedValueOnce({ ...IDEAS });
        mockClawsIssues.listRequirements.mockResolvedValueOnce([version(1, "2026-09-21 11:00:00")]);
        mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
          { id: "clwc_fb", login: "stjohnb", body: "Missing a case", body_html: "", createdAt: "2026-09-21 11:30:00" },
        ] as any);
        const body = JSON.parse((await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API })).body);
        expect(body.stage).toBe("drafting");
        expect(body.requirements).toMatchObject({ version: 1, approved: false, awaiting_review: false });
      });

      it("reports an approved record with its approver, in Planning", async () => {
        mockClawsIssues.getIssue.mockResolvedValueOnce({ ...APPROVED });
        mockClawsIssues.listRequirements.mockResolvedValueOnce([version(1, "2026-09-21 11:00:00")]);
        const body = JSON.parse((await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API })).body);
        expect(body.stage).toBe("planning");
        expect(body.requirements).toMatchObject({
          version: 1, approved: true, approved_by: "session:abc", approved_at: "2026-09-21 12:00:00", awaiting_review: false,
        });
      });

      it("shows a v2 stored after v1's approval as not approved, with v1 approved in previous_requirements", async () => {
        mockClawsIssues.getIssue.mockResolvedValueOnce({ ...APPROVED, lifecycle: "ideas" });
        mockClawsIssues.listRequirements.mockResolvedValueOnce([version(1, "2026-09-21 11:00:00"), version(2, "2026-09-22 11:00:00")]);
        const body = JSON.parse((await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API })).body);
        expect(body.requirements).toMatchObject({ version: 2, approved: false, approved_by: null });
        expect(body.previous_requirements).toEqual([
          { version: 1, created_at: "2026-09-21 11:00:00", kind: "feature", title: "Title v1", approved: true },
        ]);
      });

      it("still drops a legacy requirements comment when a record exists", async () => {
        mockClawsIssues.getIssue.mockResolvedValueOnce({ ...IDEAS });
        mockClawsIssues.listRequirements.mockResolvedValueOnce([version(1, "2026-09-21 11:00:00")]);
        mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
          { id: "clwc_req", login: "claws", body: "*— Automated by Claws · Requirements writer —*\n\n## Requirements\n\nOld record", body_html: "", createdAt: "2026-09-21 10:05:00" },
        ] as any);
        const body = JSON.parse((await request(server, "GET", `/api/issues/${NATIVE}`, { headers: API })).body);
        expect(body.comments).toEqual([]);
        expect(body.requirements.version).toBe(1);
      });

      it("carries each list row's stage: no record, awaiting review and approved", async () => {
        const { listClawsIssues } = await import("./db.js");
        const none = { ...IDEAS, id: "clw_none" };
        const review = { ...IDEAS, id: "clw_review" };
        const approved = { ...APPROVED, id: "clw_approved" };
        vi.mocked(listClawsIssues).mockResolvedValueOnce([none, review, approved] as any);
        mockClawsIssues.getLatestRequirementsForOpenIssues.mockResolvedValueOnce(new Map([
          ["clw_review", { version: 1, created_at: "2026-09-21 11:00:00" }],
          ["clw_approved", { version: 1, created_at: "2026-09-21 11:00:00" }],
        ]) as any);
        const res = await request(server, "GET", "/api/issues", { headers: API });
        expect(res.status).toBe(200);
        const stages = Object.fromEntries(JSON.parse(res.body).issues.map((r: any) => [r.id, [r.stage, r.stage_title]]));
        expect(stages).toEqual({
          clw_none: ["drafting", "Drafting"],
          clw_review: ["requirements-review", "Requirements review"],
          clw_approved: ["planning", "Planning"],
        });
      });

      it("gives a list row stage: null when the stage read fails, rather than failing the list", async () => {
        const { listClawsIssues } = await import("./db.js");
        vi.mocked(listClawsIssues).mockResolvedValueOnce([{ ...IDEAS }] as any);
        mockIssueFlight.loadBoardFlights.mockRejectedValueOnce(new Error("db down"));
        const res = await request(server, "GET", "/api/issues", { headers: API });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).issues[0]).toMatchObject({ id: NATIVE, stage: null, stage_title: null });
      });
    });
  });

  describe("GET /api/issues/:id/attachments[/:attachmentId] (#clw_01M4GFB5Q5YQRQM2XK0RCTBSB5)", () => {
    const API = { authorization: "Bearer test-internal-mcp-token" };
    const ATT = "cla_01JBQ7X4M2K8NV3TYRW9GZ5PD1";
    const OTHER = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE";
    let storeDir: string;

    function row(overrides: Record<string, unknown> = {}) {
      return { id: ATT, issue_id: NATIVE, comment_id: "clwc_1", filename: "shot.png", stored_path: "issue-attachments/x/shot.png", content_type: "image/png", size: 4, uploader_login: "stjohnb", created_at: "2026-10-09 00:00:00", ...overrides };
    }

    async function stored(file: string, data: Buffer | string | null, overrides: Record<string, unknown> = {}) {
      const [fsMod, pathMod] = await Promise.all([import("node:fs"), import("node:path")]);
      const absolutePath = pathMod.join(storeDir, file);
      if (data !== null) fsMod.writeFileSync(absolutePath, data);
      mockIssueAttachments.readIssueAttachment.mockImplementation(async (id: string) =>
        (id === ATT ? { row: row({ filename: file, size: data === null ? 4 : Buffer.byteLength(data), ...overrides }), source: { kind: "fs", absolutePath } } : undefined));
    }

    const get = (path: string) => request(server, "GET", path, { headers: API });

    beforeEach(async () => {
      const [fsMod, osMod, pathMod] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
      storeDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "claws-api-attach-"));
    });

    afterEach(async () => {
      (await import("node:fs")).rmSync(storeDir, { recursive: true, force: true });
    });

    it("lists a visible issue's attachments without their stored path", async () => {
      const { listClawsIssueAttachments } = await import("./db.js");
      vi.mocked(listClawsIssueAttachments).mockResolvedValueOnce([row()] as any);
      const res = await get(`/api/issues/${NATIVE}/attachments`);
      expect(res.status).toBe(200);
      const { stored_path: _path, issue_id: _issue, ...summary } = row();
      expect(JSON.parse(res.body)).toEqual([summary]);
      expect(listClawsIssueAttachments).toHaveBeenCalledWith(NATIVE);
    });

    it("404s the listing for a shadow or unknown issue", async () => {
      mockClawsIssues.getIssue.mockResolvedValueOnce({ ...nativeIssue, kind: "shadow" });
      const shadow = await get(`/api/issues/${NATIVE}/attachments`);
      expect(shadow.status).toBe(404);
      expect(JSON.parse(shadow.body)).toEqual({ error: `Issue ${NATIVE} not found` });
      expect((await get(`/api/issues/${OTHER}/attachments`)).status).toBe(404);
    });

    it("returns a PNG as an image block", async () => {
      await stored("shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const res = await get(`/api/issues/${NATIVE}/attachments/${ATT}`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.content[0]).toEqual({ type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mimeType: "image/png" });
      expect(JSON.parse(body.content[1].text)).toMatchObject({ id: ATT, filename: "shot.png" });
      expect(JSON.parse(body.content[1].text)).not.toHaveProperty("stored_path");
    });

    it("returns a UTF-8 text file as a guarded preview", async () => {
      await stored("notes.txt", "Steps to reproduce", { content_type: "text/plain" });
      const res = await get(`/api/issues/${NATIVE}/attachments/${ATT}`);
      expect(res.status).toBe(200);
      expect(JSON.parse(JSON.parse(res.body).content[0].text)).toMatchObject({ id: ATT, content: "Steps to reproduce", truncated: false });
    });

    it("returns metadata and a reason for a binary file", async () => {
      await stored("blob.bin", Buffer.from([0xff, 0xfe, 0x00]), { content_type: "application/octet-stream" });
      const res = await get(`/api/issues/${NATIVE}/attachments/${ATT}`);
      expect(res.status).toBe(200);
      const meta = JSON.parse(JSON.parse(res.body).content[0].text);
      expect(meta).toMatchObject({ id: ATT, note: expect.stringContaining("Not read") });
      expect(meta).not.toHaveProperty("content");
    });

    it("404s another issue's attachment, even one linked from this issue", async () => {
      await stored("shot.png", "PNG!", { issue_id: OTHER });
      const res = await get(`/api/issues/${NATIVE}/attachments/${ATT}`);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: `No attachment ${ATT} on ${NATIVE}` });
    });

    it("404s an attachment of a shadow issue without reading it", async () => {
      await stored("shot.png", "PNG!");
      mockClawsIssues.getIssue.mockResolvedValueOnce({ ...nativeIssue, kind: "shadow" });
      expect((await get(`/api/issues/${NATIVE}/attachments/${ATT}`)).status).toBe(404);
      expect(mockIssueAttachments.readIssueAttachment).not.toHaveBeenCalled();
    });

    it("names the cause and logs it when the file is missing from the store", async () => {
      const log = await import("./log.js");
      await stored("gone.png", null);
      const res = await get(`/api/issues/${NATIVE}/attachments/${ATT}`);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: `Attachment ${ATT} file is missing from the attachment store` });
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`Attachment ${ATT} on ${NATIVE} could not be read`));
    });

    it("401s without credentials", async () => {
      testSessionCookie = null;
      expect((await request(server, "GET", `/api/issues/${NATIVE}/attachments`)).status).toBe(401);
    });
  });

  it("POST /issues never files to the backlog, even when asked", async () => {
    const res = await request(server, "POST", "/issues", { body: "title=Later&repo=org%2Frepo&label=Backlog&backlog=1" });
    expect(res.status).toBe(303);
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ labels: [] }));
  });

  it("POST /issues rejects a blank title", async () => {
    const res = await request(server, "POST", "/issues", { body: "title=+&body=x" });
    expect(res.status).toBe(400);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  describe("POST /issues from the New issue modal (Accept: application/json)", () => {
    const headers = { Accept: "application/json" };

    it("returns the new issue's id and URL instead of redirecting", async () => {
      const res = await request(server, "POST", "/issues", { headers, body: "title=From+the+board&repo=org%2Frepo" });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, id: NATIVE, url: `/issues/${NATIVE}` });
      expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ title: "From the board", repos: ["org/repo"], source: "dashboard" }));
    });

    it("returns a JSON error for a blank title", async () => {
      const res = await request(server, "POST", "/issues", { headers, body: "title=+&body=x" });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "A title is required." });
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("returns a JSON error for an unresolvable link", async () => {
      const { LinkError } = await import("./issue-links.js");
      mockIssueLinks.resolveLinkTarget.mockRejectedValueOnce(new LinkError("org/b#99 is not tracked by Claws, so it cannot be linked.", 400));
      const res = await request(server, "POST", "/issues", { headers, body: "title=Dependent&repo=org%2Frepo&blocks=org%2Fb%2399" });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("not tracked by Claws");
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("returns a JSON 409 for a model plan with no repository", async () => {
      const res = await request(server, "POST", "/issues", { headers, body: "title=Plan&provider_implement=claude" });
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).error).toContain("primary repository");
    });
  });

  it("POST /issues without Accept: application/json keeps the HTML error page", async () => {
    const res = await request(server, "POST", "/issues", { body: "title=Plan&provider_implement=claude" });
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  describe("POST /api/friction-notes", () => {
    const auth = { Authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };
    const post = (body: unknown, headers: Record<string, string> = auth) =>
      request(server, "POST", "/api/friction-notes", { headers, body: JSON.stringify(body) });

    it("is 401 without a token", async () => {
      const db = await import("./db.js");
      vi.mocked(db.insertFrictionNote).mockClear();
      testSessionCookie = null;
      const res = await post({ repo: "org/repo", category: "tests", text: "slow" }, { "content-type": "application/json" });
      expect(res.status).toBe(401);
      expect(db.insertFrictionNote).not.toHaveBeenCalled();
    });

    it("is 400 for an unknown repo, an unknown category, empty or over-long text", async () => {
      const db = await import("./db.js");
      vi.mocked(db.insertFrictionNote).mockClear();
      for (const body of [
        { repo: "org/unmanaged", category: "tests", text: "slow" },
        { repo: "org/repo", category: "bogus", text: "slow" },
        { repo: "org/repo", category: "tests", text: "   " },
        { repo: "org/repo", category: "tests", text: "x".repeat(301) },
        { repo: "org/repo", category: "tests", text: "slow", reference: "r".repeat(201) },
      ]) {
        expect((await post(body)).status).toBe(400);
      }
      expect(db.insertFrictionNote).not.toHaveBeenCalled();
    });

    it("stores a note for a managed repo, canonicalising its name, and files no issue", async () => {
      const db = await import("./db.js");
      vi.mocked(db.insertFrictionNote).mockClear().mockResolvedValueOnce(17);
      mockClawsIssues.createIssue.mockClear();
      const res = await post({ repo: "ORG/Repo", category: "tests", text: " vitest  is slow ", reference: "npm test", taskId: 42, origin: "org/repo#clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC" });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, id: 17 });
      expect(db.insertFrictionNote).toHaveBeenCalledWith({
        repo: "org/repo", category: "tests", text: "vitest is slow", reference: "npm test",
        taskId: 42, sessionId: null, origin: "org/repo#clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC",
      });
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });
  });

  it("GET /retro lists every managed repo with its untriaged notes and past retrospectives", async () => {
    const db = await import("./db.js");
    vi.mocked(db.listUntriagedFrictionNotes).mockResolvedValueOnce([{
      id: 1, repo: "org/repo", category: "tests", text: "vitest is slow", reference: "npm test", task_id: 7,
      session_id: null, origin: null, created_at: "2026-10-20 10:00:00", triaged_at: null, retrospective_issue_id: null,
    }]);
    vi.mocked(db.countUntriagedFrictionNotesByRepoAndCategory).mockResolvedValueOnce(new Map([["org/repo", new Map([["tests", 1]])]]));
    vi.mocked(db.getTasksByIds).mockResolvedValueOnce([{ id: 7, job_name: "issue-worker" } as never]);
    vi.mocked(db.listFrictionRetrospectives).mockResolvedValue(
      [{ issueId: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", triagedAt: "2026-10-09 12:00:00", noteCount: 3 }]);
    const res = await request(server, "GET", "/retro");
    expect(res.status).toBe(200);
    expect(res.body).toContain("vitest is slow");
    expect(res.body).toContain("task 7 (issue-worker)");
    expect(res.body).toContain(">org/repo</a>");
    expect(res.body).toContain(">test/repo</a>");
    expect(res.body).toContain("No notes");
    expect(res.body).toContain('href="/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"');
    vi.mocked(db.listFrictionRetrospectives).mockReset().mockResolvedValue([]);
  });

  it("GET /alerts lists open alerts with their board column, the Blocked one as needing the operator", async () => {
    const db = await import("./db.js");
    const base = {
      body: "x\n\n---\n**First seen:** a\n**Last seen:** b\n**Occurrences:** 4", author_login: "claws", state: "open", state_reason: null,
      created_at: "2026-10-27 10:00:00", updated_at: "2026-10-27 11:00:00", closed_at: null, kind: "issue", repos: ["org/repo"],
      approved_through: "plan", alert_kind: "error-reporter", importPending: false,
    };
    vi.mocked(db.listOpenClawsAlerts).mockResolvedValueOnce([
      { ...base, id: "clw_01M5YPSK289NXAK8E6K6RNTFS1", title: "[claws-error] auto", lifecycle: "planning", labels: [] },
      { ...base, id: "clw_01M5YPSK289NXAK8E6K6RNTFS2", title: "[claws-error] stuck", lifecycle: "blocked", labels: ["Blocked"] },
    ] as never);
    vi.mocked(db.getIssueBlockedReasons).mockReset().mockResolvedValue(new Map([["clw_01M5YPSK289NXAK8E6K6RNTFS2", "The fix failed CI."]]));
    const res = await request(server, "GET", "/alerts");
    vi.mocked(db.getIssueBlockedReasons).mockReset().mockResolvedValue(new Map());
    expect(res.status).toBe(200);
    expect(res.body).toContain("[claws-error] auto");
    expect(res.body).toContain("Needs you · Blocked");
    expect(res.body).toContain("The fix failed CI.");
    expect(res.body).toContain(">4</td>");
    expect(res.body.indexOf("[claws-error] stuck")).toBeLessThan(res.body.indexOf("[claws-error] auto"));
  });

  describe("POST /api/issues (#3286)", () => {
    const auth = { Authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };

    it("creates the issue as claws when no sessionId is given, and drops state/unknown labels into ignoredLabels", async () => {
      const res = await request(server, "POST", "/api/issues", {
        headers: auth,
        body: JSON.stringify({ title: "Companion change", body: "Needed", repos: ["org/repo"], labels: ["Priority", "Ready", "Bogus", "Backlog"] }),
      });
      expect(res.status).toBe(200);
      expect(mockClawsIssues.createIssue).toHaveBeenCalledWith({
        title: "Companion change",
        body: "Needed",
        authorLogin: "claws",
        repos: ["org/repo"],
        labels: ["Priority"],
        source: "agent",
      });
      expect(JSON.parse(res.body)).toEqual({
        id: NATIVE,
        ref: `#${NATIVE}`,
        url: `https://claws.example/issues/${NATIVE}`,
        repos: ["org/repo"],
        labels: ["Priority"],
        ignoredLabels: ["Ready", "Bogus", "Backlog"],
        primaryRepo: "org/repo",
      });
    });

    it("creates the issue as the first allowed actor when sessionId is given", async () => {
      const res = await request(server, "POST", "/api/issues", {
        headers: auth,
        body: JSON.stringify({ title: "T", repos: ["org/repo"], sessionId: "abc123" }),
      });
      expect(res.status).toBe(200);
      expect(mockClawsIssues.createIssue).toHaveBeenCalledWith({
        title: "T",
        body: "",
        authorLogin: "stjohnb",
        repos: ["org/repo"],
        labels: [],
        source: "session",
      });
    });

    // An up-front approval or requirements record rides only on the session's
    // own token (#clw_01M3BWP83BQRXE06NWW1GKYT2S), never the shared one.
    const SESSION_TOKEN = "session-own-mcp-token";
    const sessionAuth = { Authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/json" };
    const sessionBackend = {
      kind: "k8s-pod" as const,
      getLive: vi.fn(async (id: string) => (id === "abc123"
        ? { ok: true as const, session: { id, repo: "org/repo", cwd: "/tmp/x", mode: "repo-claude" as const, provider: "claude" as const, model: null, alive: true, summary: null, extraRepos: [], capabilities: [] } }
        : { ok: false as const, reason: "not-found" as const })),
      verifyMcpToken: vi.fn(async (id: string, token: string) => (id === "abc123" && token === SESSION_TOKEN ? "ok" as const : "denied" as const)),
    };
    const createAsSession = (body: Record<string, unknown>, headers: Record<string, string> = sessionAuth) =>
      request(server, "POST", "/api/sessions/abc123/issues", { headers, body: JSON.stringify(body) });

    beforeEach(async () => {
      const { setSessionBackendForTests } = await import("./session-backend.js");
      setSessionBackendForTests(sessionBackend as any);
    });

    afterEach(async () => {
      const { setSessionBackendForTests } = await import("./session-backend.js");
      setSessionBackendForTests(null);
    });

    // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F
    it("files the issue approved through approveThrough as the session, dropping the retired gate labels", async () => {
      const res = await createAsSession({ title: "T", repos: ["org/repo"], approveThrough: "plan", labels: ["Priority", "Refined", "Automerge", "Ship", "Claws Auto-Refine", "Ready"] });
      expect(res.status).toBe(200);
      expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ labels: ["Priority"], approvedThrough: "plan", approvedBy: "session:abc123" }));
      expect(JSON.parse(res.body)).toMatchObject({
        labels: ["Priority"],
        ignoredLabels: ["Refined", "Automerge", "Ship", "Claws Auto-Refine", "Ready"],
        approvedThrough: "plan",
      });
    });

    it("refuses an up-front approval from a caller with no session", async () => {
      mockClawsIssues.createIssue.mockClear();
      const res = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ title: "T", repos: ["org/repo"], approveThrough: "merge" }) });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/interactive session/);
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("refuses an up-front approval on the shared token whatever sessionId the body claims", async () => {
      mockClawsIssues.createIssue.mockClear();
      const res = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ title: "T", repos: ["org/repo"], sessionId: "made-up", approveThrough: "merge" }) });
      expect(res.status).toBe(400);
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("refuses the session route without that session's own token, or for a session that is not live", async () => {
      mockClawsIssues.createIssue.mockClear();
      expect((await createAsSession({ title: "T", repos: ["org/repo"], approveThrough: "merge" }, auth)).status).toBe(401);
      sessionBackend.verifyMcpToken.mockResolvedValueOnce("ok");
      const gone = await request(server, "POST", "/api/sessions/def000/issues", { headers: sessionAuth, body: JSON.stringify({ title: "T", repos: ["org/repo"], approveThrough: "merge" }) });
      expect(gone.status).toBe(404);
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("files no approval for approveThrough none, and 400s a value that is not a gate", async () => {
      mockClawsIssues.createIssue.mockClear();
      const none = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ title: "T", repos: ["org/repo"], approveThrough: "none" }) });
      expect(none.status).toBe(200);
      expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.not.objectContaining({ approvedThrough: expect.anything() }));
      mockClawsIssues.createIssue.mockClear();
      const bad = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ title: "T", repos: ["org/repo"], approveThrough: "Refined" }) });
      expect(bad.status).toBe(400);
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    describe("requirements", () => {
      const requirements = { title: "Agreed", kind: "feature", context: "Why.", requirement: "What.", acceptanceCriteria: ["Works"], outOfScope: [] };

      // Agent and session issues skip the requirements stage, so an older
      // session pod's record is dropped rather than refusing the filing.
      it("ignores a supplied record and files the issue with no requirements stage", async () => {
        mockClawsIssues.createIssue.mockClear();
        const session = await createAsSession({ title: "T", repos: ["org/repo"], requirements, approveThrough: "requirements" });
        expect(session.status).toBe(200);
        expect(JSON.parse(session.body)).not.toHaveProperty("requirementsStored");
        expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ source: "session", approvedThrough: "requirements" }));
        const headless = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ title: "T", repos: ["org/repo"], requirements }) });
        expect(headless.status).toBe(200);
        expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ source: "agent" }));
      });
    });

    it("passes autoPromote through, and 400s one that is not a boolean", async () => {
      const held = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ title: "T", repos: ["org/repo"], autoPromote: false }) });
      expect(held.status).toBe(200);
      expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ source: "agent", autoPromote: false }));
      const bad = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ title: "T", repos: ["org/repo"], autoPromote: "yes" }) });
      expect(bad.status).toBe(400);
    });

    it("resolves a repo case-insensitively and 400s an unknown one", async () => {
      const ok = await request(server, "POST", "/api/issues", {
        headers: auth,
        body: JSON.stringify({ title: "T", repos: ["ORG/REPO"] }),
      });
      expect(ok.status).toBe(200);
      expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ repos: ["org/repo"] }));

      const bad = await request(server, "POST", "/api/issues", {
        headers: auth,
        body: JSON.stringify({ title: "T", repos: ["someone/else"] }),
      });
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body)).toEqual({ error: "someone/else is not a repo Claws manages" });
    });

    it("400s a missing title or empty repos list", async () => {
      const noTitle = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ repos: ["org/repo"] }) });
      expect(noTitle.status).toBe(400);

      const noRepos = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ title: "T", repos: [] }) });
      expect(noRepos.status).toBe(400);
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("carries a note naming the primary repo when more than one repo is given, and none otherwise", async () => {
      const multi = await request(server, "POST", "/api/issues", {
        headers: auth,
        body: JSON.stringify({ title: "T", repos: ["org/repo", "test/repo"] }),
      });
      const multiBody = JSON.parse(multi.body);
      expect(multiBody.note).toContain("org/repo");
      expect(multiBody.note).toContain("companion");
      expect(multiBody.primaryRepo).toBe("org/repo");

      const single = await request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify({ title: "T", repos: ["org/repo"] }) });
      const singleBody = JSON.parse(single.body);
      expect(singleBody.note).toBeUndefined();
      expect(singleBody.primaryRepo).toBe("org/repo");
    });

    describe("dedupe on create", () => {
      const KEPT = "clw_01M45S1G6S9YPREVAAN809HE3C";
      const kept = {
        ...nativeIssue,
        id: KEPT,
        title: "Create renovate-github-com secret so Renovate can update npm lockfiles",
        body: "Create the `renovate-github-com` Secret.",
        repos: ["org/repo"],
        filed_title: null,
        dedupe_key: null,
      };
      const proposal = { title: "Renovate: create the renovate-github-com Secret so GITHUB_COM_TOKEN is set", repos: ["org/repo"] };
      const post = (body: Record<string, unknown>) => request(server, "POST", "/api/issues", { headers: auth, body: JSON.stringify(body) });

      it("returns the open issue with the same dedupeKey and comments on it once", async () => {
        const { commentOnIssue: ghCommentOnIssue } = await import("./github.js");
        mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ ...kept, dedupe_key: "renovate-github-com-secret" });
        const res = await post({ ...proposal, dedupeKey: " Renovate-GitHub-com-Secret ", origin: "org/perudo#clw_X", sessionId: "abc123", force: true });
        expect(res.status).toBe(200);
        expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith("org/repo", "renovate-github-com-secret");
        expect(JSON.parse(res.body)).toMatchObject({ deduplicated: true, matchedBy: "dedupeKey", id: KEPT, ref: `#${KEPT}`, primaryRepo: "org/repo" });
        expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
        expect(ghCommentOnIssue).toHaveBeenCalledTimes(1);
        expect(ghCommentOnIssue).toHaveBeenCalledWith("org/repo", KEPT,
          `Also needed by org/perudo#clw_X for org/repo: a claws_create_issue call proposed "${proposal.title}", dedupe key \`renovate-github-com-secret\` and was deduplicated onto this issue.`);
      });

      it("does not repeat the audit comment when the same call is deduplicated again", async () => {
        const { commentOnIssue: ghCommentOnIssue } = await import("./github.js");
        mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(kept);
        const body = `Also needed by a headless agent for org/repo: a claws_create_issue call proposed "${proposal.title}", dedupe key \`renovate-github-com-secret\` and was deduplicated onto this issue.`;
        mockClawsIssues.listCommentDetails.mockResolvedValue([{ id: "clwc_1", body: `${body}\n\n<sub>Automated by Claws</sub>`, body_html: "", login: "claws", createdAt: "" }]);
        const res = await post({ ...proposal, dedupeKey: "renovate-github-com-secret" });
        expect(JSON.parse(res.body).deduplicated).toBe(true);
        expect(ghCommentOnIssue).not.toHaveBeenCalled();
      });

      it("returns a strong similarity match to a headless caller, with the candidates and an audit comment", async () => {
        const { commentOnIssue: ghCommentOnIssue } = await import("./github.js");
        mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([kept]);
        const res = await post({ ...proposal, body: "Set `GITHUB_COM_TOKEN` from the `renovate-github-com` Secret.", origin: "org/perudo#clw_X" });
        const parsed = JSON.parse(res.body);
        expect(mockClawsIssues.listOpenIssuesTouching).toHaveBeenCalledWith(["org/repo"]);
        expect(parsed).toMatchObject({ deduplicated: true, matchedBy: "similarity", id: KEPT });
        expect(parsed.candidates[0]).toMatchObject({ id: KEPT, ref: `#${KEPT}`, sharedKeyTerms: ["renovate-github-com"] });
        expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
        expect(ghCommentOnIssue).toHaveBeenCalledWith("org/repo", KEPT, expect.stringContaining("Also needed by org/perudo#clw_X for org/repo"));
      });

      describe("a keyed call against an alert inbox", () => {
        const inbox = {
          ...kept,
          id: "clw_01M57YH7V136WTDBE5RRMVMFAE",
          title: "Renovate: create the renovate-github-com Secret so GITHUB_COM_TOKEN is set for npm",
          filed_title: "Grafana alerts",
          labels: ["grafana-alert"],
          body: "Create the `renovate-github-com` Secret.",
        };

        it("files a new issue for a headless caller rather than deduplicating onto the inbox", async () => {
          mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([inbox]);
          const res = await post({ ...proposal, dedupeKey: "alert-pvc-usage-warning-80" });
          const parsed = JSON.parse(res.body);
          expect(parsed.deduplicated).toBeUndefined();
          expect(parsed).toMatchObject({ id: NATIVE });
          expect(mockClawsIssues.createIssue).toHaveBeenCalled();
        });

        it("files a new issue for a session caller without asking for force", async () => {
          mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([inbox]);
          const res = await post({ ...proposal, dedupeKey: "alert-pvc-usage-warning-80", sessionId: "abc123" });
          const parsed = JSON.parse(res.body);
          expect(parsed.needsForce).toBeUndefined();
          expect(parsed.deduplicated).toBeUndefined();
          expect(mockClawsIssues.createIssue).toHaveBeenCalled();
        });

        it("ignores an inbox the key lookup returns", async () => {
          mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ ...inbox, dedupe_key: "alert-pvc-usage-warning-80" });
          const res = await post({ ...proposal, dedupeKey: "alert-pvc-usage-warning-80" });
          expect(JSON.parse(res.body).deduplicated).toBeUndefined();
          expect(mockClawsIssues.createIssue).toHaveBeenCalled();
        });
      });

      describe("a keyed call against an issue holding a different dedupeKey", () => {
        const similarBody = "Set `GITHUB_COM_TOKEN` from the `renovate-github-com` Secret.";
        const otherKeyed = { ...kept, dedupe_key: "alert-kubepodnotready" };

        it("files a new issue for a headless caller rather than deduplicating onto it", async () => {
          mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([otherKeyed]);
          const res = await post({ ...proposal, body: similarBody, dedupeKey: "alert-kubedeploymentreplicasmismatch" });
          const parsed = JSON.parse(res.body);
          expect(parsed.deduplicated).toBeUndefined();
          expect(parsed).toMatchObject({ id: NATIVE, dedupeKey: "alert-kubedeploymentreplicasmismatch" });
          expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "alert-kubedeploymentreplicasmismatch" }));
        });

        it("still deduplicates a headless keyed call onto a similar issue with no key", async () => {
          mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([kept]);
          const res = await post({ ...proposal, body: similarBody, dedupeKey: "alert-kubedeploymentreplicasmismatch" });
          expect(JSON.parse(res.body)).toMatchObject({ deduplicated: true, matchedBy: "similarity", id: KEPT });
          expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
        });

        it("filters before the top-N cut so keyed look-alikes cannot crowd out an unkeyed match", async () => {
          const crowd = Array.from({ length: 6 }, (_, i) => ({
            ...otherKeyed,
            id: `clw_01M45S1G6S9YPREVAAN809HF${i}0`,
            title: proposal.title,
            body: similarBody,
            dedupe_key: `alert-other${i}`,
          }));
          mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([...crowd, kept]);
          const res = await post({ ...proposal, body: similarBody, dedupeKey: "alert-kubedeploymentreplicasmismatch" });
          expect(JSON.parse(res.body)).toMatchObject({ deduplicated: true, matchedBy: "similarity", id: KEPT });
        });

        it("lists only compatible candidates to a keyed session caller", async () => {
          const OTHER = "clw_01M45S1G6S9YPREVAAN809HE3D";
          mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([{ ...otherKeyed, id: OTHER }, kept]);
          const res = await post({ ...proposal, body: similarBody, dedupeKey: "alert-kubedeploymentreplicasmismatch", sessionId: "abc123" });
          const parsed = JSON.parse(res.body);
          expect(parsed).toMatchObject({ created: false, needsForce: true });
          expect(parsed.candidates.map((c: { id: string }) => c.id)).toEqual([KEPT]);
          expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
        });
      });

      it("files nothing for a session caller on a similarity match until it passes force", async () => {
        const { commentOnIssue: ghCommentOnIssue } = await import("./github.js");
        mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([kept]);
        const held = await post({ ...proposal, sessionId: "abc123" });
        expect(held.status).toBe(200);
        const parsed = JSON.parse(held.body);
        expect(parsed).toMatchObject({ created: false, needsForce: true });
        expect(parsed.candidates.map((c: { id: string }) => c.id)).toEqual([KEPT]);
        expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
        expect(ghCommentOnIssue).not.toHaveBeenCalled();

        const forced = await post({ ...proposal, sessionId: "abc123", force: true });
        expect(JSON.parse(forced.body).id).toBe(NATIVE);
        expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
      });

      it("files a dissimilar issue and stores its dedupeKey", async () => {
        mockClawsIssues.listOpenIssuesTouching.mockResolvedValue([kept]);
        const res = await post({ title: "Renovate: pin the node image tag in fleet-infra", repos: ["org/repo"], dedupeKey: "pin-node-image" });
        expect(JSON.parse(res.body)).toMatchObject({ id: NATIVE, dedupeKey: "pin-node-image" });
        expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "pin-node-image" }));
      });

      it("400s a malformed dedupeKey or a non-boolean force", async () => {
        for (const dedupeKey of ["x", "-leading", "has space", 42, "a".repeat(101)]) {
          const res = await post({ ...proposal, dedupeKey });
          expect(res.status, String(dedupeKey)).toBe(400);
        }
        expect((await post({ ...proposal, force: "yes" })).status).toBe(400);
        expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      });

      it("serialises concurrent creates for one primary repo, so the second sees the first", async () => {
        const filed: any[] = [];
        mockClawsIssues.listOpenIssuesTouching.mockImplementation(async () => [...filed]);
        mockClawsIssues.createIssue.mockImplementation(async (input: any) => {
          await new Promise((r) => setTimeout(r, 20));
          filed.push({ ...kept, title: input.title });
          return KEPT;
        });
        const [a, b] = await Promise.all([post({ ...proposal, title: kept.title }), post(proposal)]);
        expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
        expect([JSON.parse(a.body).deduplicated, JSON.parse(b.body).deduplicated].filter(Boolean)).toHaveLength(1);
      });
    });

    it("returns 401 without credentials", async () => {
      testSessionCookie = null;
      const res = await request(server, "POST", "/api/issues", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T", repos: ["org/repo"] }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/issues/:id/comments (#3286)", () => {
    const auth = { Authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };

    it("posts as the operator with no marker when sessionId is given", async () => {
      const res = await request(server, "POST", `/api/issues/${NATIVE}/comments`, {
        headers: auth,
        body: JSON.stringify({ body: "Looks good", sessionId: "abc123" }),
      });
      expect(res.status).toBe(200);
      expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Looks good", "stjohnb");
      expect(JSON.parse(res.body)).toEqual({ ok: true, id: NATIVE, url: `https://claws.example/issues/${NATIVE}` });
    });

    it("posts through the github.ts façade, which stamps the automation marker, when no sessionId is given", async () => {
      const { commentOnIssue: ghCommentOnIssue } = await import("./github.js");
      const res = await request(server, "POST", `/api/issues/${NATIVE}/comments`, {
        headers: auth,
        body: JSON.stringify({ body: "Filed the companion issue" }),
      });
      expect(res.status).toBe(200);
      expect(ghCommentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Filed the companion issue");
      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
    });

    it("404s as JSON for a shadow or unknown issue", async () => {
      const res = await request(server, "POST", "/api/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PD1/comments", {
        headers: auth,
        body: JSON.stringify({ body: "x" }),
      });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Issue not found" });
    });

    it("400s a blank body", async () => {
      const res = await request(server, "POST", `/api/issues/${NATIVE}/comments`, { headers: auth, body: JSON.stringify({ body: "  " }) });
      expect(res.status).toBe(400);
      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
    });

    it("returns 401 without credentials", async () => {
      testSessionCookie = null;
      const res = await request(server, "POST", `/api/issues/${NATIVE}/comments`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "x" }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("GET /issues/:id renders a native issue", async () => {
    const res = await request(server, "GET", `/issues/${NATIVE}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("Native issue");
    expect(res.body).toContain("org/repo");
  });

  it("GET /issues/:id lists the issue's pull requests, linked to the forge", async () => {
    const db = await import("./db.js");
    vi.mocked(db.listClawsPrsForIssue).mockResolvedValueOnce([
      { repo: "org/repo", prNumber: 7, title: "Add <thing>", stage: "merged", needsHumanReview: false },
    ] as any);
    const res = await request(server, "GET", `/issues/${NATIVE}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(`<a href="https://github.com/org/repo/pull/7">#7</a>`);
    expect(res.body).toContain("Add &lt;thing&gt;");
    expect(res.body).toContain("Merged");
  });

  it("GET /issues/:id falls back to the planned title when the row has none", async () => {
    const db = await import("./db.js");
    vi.mocked(db.listClawsPrsForIssue).mockResolvedValueOnce([
      { repo: "org/repo", prNumber: 8, title: null, stage: "opened", needsHumanReview: false },
    ] as any);
    vi.mocked(db.getIssuePlannedPRs).mockResolvedValueOnce([
      { position: 1, repo: "org/repo", title: "Planned title", prNumber: 8, dependsOn: null },
    ] as any);
    const res = await request(server, "GET", `/issues/${NATIVE}`);
    expect(res.body).toContain("Planned title");
  });

  it("GET /issues/:id still renders when the pull request query fails", async () => {
    const db = await import("./db.js");
    vi.mocked(db.listClawsPrsForIssue).mockRejectedValueOnce(new Error("db down"));
    const res = await request(server, "GET", `/issues/${NATIVE}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("No pull requests yet");
  });

  it("GET /issues/:id shows the latest plan under Current plan, not in Comments", async () => {
    const PLAN_COMMENT = "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD2";
    mockClawsIssues.listCommentDetails.mockResolvedValue([
      { id: PLAN_COMMENT, body: "PLAN COMMENT HTML", body_html: "<p>PLAN COMMENT HTML</p>", login: "claws", createdAt: "2026-09-21T09:00:00.000Z" },
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD3", body: "HUMAN REPLY", body_html: "<p>HUMAN REPLY</p>", login: "stjohnb", createdAt: "2026-09-21T09:10:00.000Z" },
    ]);
    mockClawsIssues.listPlans.mockResolvedValue([
      { version: 1, commentId: PLAN_COMMENT, body: "## Implementation Plan\n\n### Requirement\n\nOLD REQUIREMENT", createdAt: "2026-09-21T08:00:00.000Z" },
      { version: 2, commentId: PLAN_COMMENT, body: "## Implementation Plan\n\n### Requirement\n\nNEW REQUIREMENT\n\n### Decisions\n\nD", createdAt: "2026-09-21T09:00:00.000Z" },
    ]);

    const res = await request(server, "GET", `/issues/${NATIVE}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toContain("PLAN COMMENT HTML");
    expect(res.body).toContain("HUMAN REPLY");
    expect(res.body).toContain("<p>NEW REQUIREMENT</p>");
    expect(res.body).toContain("Previous plans <span>1</span>");
    expect(res.body).toContain("<p>OLD REQUIREMENT</p>");
  });

  it("GET /issues/:id shows the latest requirements under Requirements, not in Comments", async () => {
    const REQ_COMMENT = "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD4";
    const version = (n: number, requirement: string) => ({
      version: n, title: `Title v${n}`, kind: "feature", context: "Why", requirement,
      acceptanceCriteria: ["It works"], outOfScope: [], commentId: REQ_COMMENT, createdAt: "2026-09-21T08:00:00.000Z",
    });
    mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
      { id: REQ_COMMENT, body: "REQ COMMENT HTML", body_html: "<p>REQ COMMENT HTML</p>", login: "claws", createdAt: "2026-09-21T08:00:00.000Z" },
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD5", body: "HUMAN REPLY", body_html: "<p>HUMAN REPLY</p>", login: "stjohnb", createdAt: "2026-09-21T09:10:00.000Z" },
    ]);
    mockClawsIssues.listRequirements.mockResolvedValueOnce([version(1, "OLD REQ"), version(2, "NEW REQ")]);

    const res = await request(server, "GET", `/issues/${NATIVE}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toContain("REQ COMMENT HTML");
    expect(res.body).toContain("HUMAN REPLY");
    expect(res.body).toMatch(/id="requirements" open>\s*<summary><h2>Requirements<\/h2>/);
    expect(res.body).toContain("<p>NEW REQ</p>");
    expect(res.body).toContain("<li>It works</li>");
    expect(res.body).toContain("Not yet approved");
    expect(res.body).toContain("Previous requirements <span>1</span>");
    expect(res.body).toContain("<p>OLD REQ</p>");
  });

  it("GET /issues/:id shows Requirements review until a human comments on the latest version, then Drafting", async () => {
    const version = {
      version: 1, title: "T", kind: "feature", context: "Why", requirement: "REQ PART",
      acceptanceCriteria: ["It works"], outOfScope: [], commentId: null, createdAt: "2026-09-21T08:00:00.000Z",
    };
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "ideas" });
    mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD5", body: "early", body_html: "<p>early</p>", login: "stjohnb", createdAt: "2026-09-21T07:00:00.000Z" },
    ]);
    mockClawsIssues.listRequirements.mockResolvedValueOnce([version]);
    const review = await request(server, "GET", `/issues/${NATIVE}`);
    expect(review.body).toMatch(/state-pill state-column">Requirements review</);

    mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD5", body: "tighten it", body_html: "<p>tighten it</p>", login: "stjohnb", createdAt: "2026-09-21T09:00:00.000Z" },
    ]);
    mockClawsIssues.listRequirements.mockResolvedValueOnce([version]);
    const drafting = await request(server, "GET", `/issues/${NATIVE}`);
    expect(drafting.body).toMatch(/state-pill state-column">Drafting</);
    expect(drafting.body).toContain("Comment and promote to Planning");
  });

  it("GET /issues/:id hides a legacy requirements comment no version links to", async () => {
    mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD6", body: "*— Automated by Claws · Requirements writer —*\n\n## Requirements\n\nLEGACY REQ COMMENT", body_html: "<p>LEGACY REQ COMMENT</p>", login: "claws", createdAt: "2026-09-21T08:00:00.000Z" },
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD7", body: "*— Automated by Claws —*\n\nSTATUS NOTE", body_html: "<p>STATUS NOTE</p>", login: "claws", createdAt: "2026-09-21T08:05:00.000Z" },
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD5", body: "HUMAN REPLY", body_html: "<p>HUMAN REPLY</p>", login: "stjohnb", createdAt: "2026-09-21T09:10:00.000Z" },
    ]);
    mockClawsIssues.listRequirements.mockResolvedValueOnce([{
      version: 1, title: "T", kind: "feature", context: "Why", requirement: "REQ PART",
      acceptanceCriteria: ["It works"], outOfScope: [], commentId: null, createdAt: "2026-09-21T08:00:00.000Z",
    }]);

    const res = await request(server, "GET", `/issues/${NATIVE}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toContain("LEGACY REQ COMMENT");
    expect(res.body).toContain("STATUS NOTE");
    expect(res.body).toContain("HUMAN REPLY");
    expect(res.body).toContain("<p>REQ PART</p>");
  });

  it("GET /issues/:id links a known issue ref in a comment and leaves an unknown one plain", async () => {
    const OTHER_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF";
    const UNKNOWN_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDG";
    const db = await import("./db.js");
    vi.mocked(db.clawsIssueExists).mockImplementation(async (id: string) => id === OTHER_ID);
    mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD5", body: `see #${OTHER_ID}, #${UNKNOWN_ID} and #4040`, body_html: "<p>stale</p>", login: "stjohnb", createdAt: "2026-09-21T09:10:00.000Z" },
    ]);
    try {
      const res = await request(server, "GET", `/issues/${NATIVE}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain(`<a href="/issues/${OTHER_ID}" class="issue-ref">#${OTHER_ID}</a>`);
      expect(res.body).not.toContain(`href="/issues/${UNKNOWN_ID}"`);
      expect(res.body).not.toContain("issue-ref\">#4040");
    } finally {
      vi.mocked(db.clawsIssueExists).mockImplementation(async () => false);
    }
  });

  describe("attachments", () => {
    const ATT = "cla_01JBQ7X4M2K8NV3TYRW9GZ5PD1";
    const OTHER = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE";
    let storeDir: string;

    function attachmentRow(overrides: Record<string, unknown> = {}) {
      return { id: ATT, issue_id: NATIVE, comment_id: null, filename: "shot.png", stored_path: "x", content_type: "image/png", size: 4, uploader_login: "stjohnb", created_at: "", ...overrides };
    }

    beforeEach(async () => {
      const [fsMod, osMod, pathMod] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
      storeDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "claws-server-attach-"));
      fsMod.writeFileSync(pathMod.join(storeDir, "shot.png"), "PNG!");
      mockIssueAttachments.readIssueAttachment.mockImplementation(async (id: string) =>
        (id === ATT ? { row: attachmentRow(), source: { kind: "fs", absolutePath: pathMod.join(storeDir, "shot.png") } } : undefined));
    });

    afterEach(async () => {
      (await import("node:fs")).rmSync(storeDir, { recursive: true, force: true });
    });

    function multipart(name: string, type: string, data: string) {
      const boundary = "BOUNDARY";
      return {
        headers: { "content-type": `multipart/form-data; boundary=${boundary}`, accept: "application/json" },
        body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${data}\r\n--${boundary}--\r\n`,
      };
    }

    /** Declares an over-cap body and waits for the early 413 without sending it. */
    function declareOversize(path: string, contentLength: number, contentType: string): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const addr = server.address();
        if (!addr || typeof addr === "string") return reject(new Error("Server not listening"));
        const headers: Record<string, string> = { "content-type": contentType, "content-length": String(contentLength), accept: "application/json" };
        if (testSessionCookie) headers["Cookie"] = `claws_session=${encodeURIComponent(testSessionCookie)}`;
        let responded = false;
        const req = http.request({ hostname: "127.0.0.1", port: addr.port, path, method: "POST", headers }, (res) => {
          responded = true;
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString()));
          res.on("end", () => {
            resolve({ status: res.statusCode!, body });
            req.destroy();
          });
        });
        req.on("error", (err) => { if (!responded) reject(err); });
        req.write(Buffer.alloc(1024, 0x41));
      });
    }

    it("GET serves the file with the safety headers", async () => {
      const res = await request(server, "GET", `/issues/${NATIVE}/attachments/${ATT}/shot.png`);
      expect(res.status).toBe(200);
      expect(res.body).toBe("PNG!");
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["content-disposition"]).toBe(`inline; filename="shot.png"`);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    });

    it("GET serves an SVG as a download, never as markup", async () => {
      mockIssueAttachments.readIssueAttachment.mockImplementation(async () => ({
        row: attachmentRow({ filename: "x.svg", content_type: "image/svg+xml" }),
        source: { kind: "fs", absolutePath: (await import("node:path")).join(storeDir, "shot.png") },
      }));
      const res = await request(server, "GET", `/issues/${NATIVE}/attachments/${ATT}/x.svg`);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["content-disposition"]).toBe(`attachment; filename="x.svg"`);
    });

    it("GET 404s for an attachment requested under the wrong issue", async () => {
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, id: OTHER });
      const res = await request(server, "GET", `/issues/${OTHER}/attachments/${ATT}/shot.png`);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain("PNG!");
    });

    it("GET 404s for an issue's file requested as pending, and for a shadow", async () => {
      expect((await request(server, "GET", `/issues/new/attachments/${ATT}/shot.png`)).status).toBe(404);
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, kind: "shadow" });
      expect((await request(server, "GET", `/issues/${NATIVE}/attachments/${ATT}/shot.png`)).status).toBe(404);
    });

    it("GET /agent-pods/:rowId/attachments/:attachmentId streams the file only for the row's own live token", async () => {
      testSessionCookie = null;
      const get = (rowId: string, id: string, headers: Record<string, string>) =>
        request(server, "GET", `/agent-pods/${rowId}/attachments/${id}`, { headers });
      const auth = { Authorization: "Bearer agent-pod-token" };

      const ok = await get("7", ATT, auth);
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("PNG!");
      expect(ok.headers["content-type"]).toBe("image/png");
      expect(ok.headers["content-length"]).toBe("4");
      expect(ok.headers["x-content-type-options"]).toBe("nosniff");
      expect(ok.headers["cache-control"]).toBe("no-store");

      expect((await get("7", ATT, { Authorization: "Bearer wrong" })).status).toBe(401);
      expect((await get("7", ATT, {})).status).toBe(401);
      expect((await get("8", ATT, auth)).status).toBe(401);
      expect((await get("abc", ATT, auth)).status).toBe(404);
      expect((await get("7", "cla_01JBQ7X4M2K8NV3TYRW9GZ5PDZ", auth)).body).toBe("attachment not found");
      expect((await get("7", "not-an-id", auth)).status).toBe(404);

      (await import("node:fs")).rmSync((await import("node:path")).join(storeDir, "shot.png"));
      const missing = await get("7", ATT, auth);
      expect(missing.status).toBe(404);
      expect(missing.body).toBe("attachment file missing");
    });

    it("POST stores each file and answers with its URL", async () => {
      mockIssueAttachments.storeIssueAttachment.mockResolvedValue({ ok: true, row: attachmentRow() });
      const res = await request(server, "POST", `/issues/${NATIVE}/attachments`, multipart("shot.png", "image/png", "PNG!"));
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        attachments: [{ id: ATT, name: "shot.png", url: `/issues/${NATIVE}/attachments/${ATT}/shot.png`, size: 4, contentType: "image/png" }],
      });
      expect(mockIssueAttachments.storeIssueAttachment).toHaveBeenCalledWith(NATIVE, "shot.png", Buffer.from("PNG!"), "image/png", "stjohnb");
      expect(mockIssueAttachments.sweepPendingAttachments).not.toHaveBeenCalled();
    });

    it("POST to /issues/new stores a pending file after sweeping stale ones", async () => {
      mockIssueAttachments.storeIssueAttachment.mockResolvedValue({ ok: true, row: attachmentRow({ issue_id: null }) });
      const res = await request(server, "POST", "/issues/new/attachments", multipart("shot.png", "image/png", "PNG!"));
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).attachments[0].url).toBe(`/issues/new/attachments/${ATT}/shot.png`);
      expect(mockIssueAttachments.storeIssueAttachment).toHaveBeenCalledWith(null, "shot.png", expect.any(Buffer), "image/png", "stjohnb");
      expect(mockIssueAttachments.sweepPendingAttachments).toHaveBeenCalled();
    });

    // Attaching a file from the Attachments section counts as plan feedback
    // (#clw_01M39J5AT1SKCFV6CHMWPVHD6M): the client marks that form's uploads
    // with `?feedback=1`, and only those synthesise a comment.
    it("POST with ?feedback=1 posts an unmarked comment linking the file and returns an Awaiting plan review issue to the planner", async () => {
      const worker = await import("./worker.js");
      mockIssueAttachments.storeIssueAttachment.mockResolvedValue({ ok: true, row: attachmentRow() });

      const res = await request(server, "POST", `/issues/${NATIVE}/attachments?feedback=1`, multipart("shot.png", "image/png", "PNG!"));

      expect(res.status).toBe(200);
      expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith(
        "org/repo",
        NATIVE,
        `Attached ![shot.png](/issues/${NATIVE}/attachments/${ATT}/shot.png)`,
        "stjohnb",
      );
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "planning");
      expect(worker.enqueue).toHaveBeenCalledWith("issue-refiner:refine", "org/repo", NATIVE, { priority: false });
    });

    it("POST without ?feedback=1 stores the file but posts no comment", async () => {
      mockIssueAttachments.storeIssueAttachment.mockResolvedValue({ ok: true, row: attachmentRow() });

      await request(server, "POST", `/issues/${NATIVE}/attachments`, multipart("shot.png", "image/png", "PNG!"));

      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    });

    it("POST /issues/new/attachments?feedback=1 posts no comment — the issue does not exist yet", async () => {
      mockIssueAttachments.storeIssueAttachment.mockResolvedValue({ ok: true, row: attachmentRow({ issue_id: null }) });

      await request(server, "POST", "/issues/new/attachments?feedback=1", multipart("shot.png", "image/png", "PNG!"));

      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
    });

    it("POST /stream with ?feedback=1 posts an unmarked comment linking the file", async () => {
      mockIssueAttachments.storeIssueAttachmentStream.mockResolvedValue({ ok: true, row: attachmentRow() });

      await request(server, "POST", `/issues/${NATIVE}/attachments/stream?name=shot.png&feedback=1`, {
        headers: { "content-type": "image/png", accept: "application/json" },
        body: "PNG!",
      });

      expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith(
        "org/repo",
        NATIVE,
        `Attached ![shot.png](/issues/${NATIVE}/attachments/${ATT}/shot.png)`,
        "stjohnb",
      );
    });

    it("POST answers an over-cap upload with a 413 JSON body, not a 500", async () => {
      const res = await declareOversize(`/issues/${NATIVE}/attachments`, 12 * 1024 * 1024, "multipart/form-data; boundary=BOUNDARY");
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body).error).toBe("File too large (max 10 MB)");
      expect(mockIssueAttachments.storeIssueAttachment).not.toHaveBeenCalled();
    });

    it("POST /stream answers an over-cap declared size with a 413 JSON body", async () => {
      const res = await declareOversize(`/issues/${NATIVE}/attachments/stream?name=big.bin`, 1024 * 1024 * 1024 + 1, "application/octet-stream");
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body).error).toBe("File too large (max 1 GB)");
    });

    it("POST /stream reports a store-side too-large as 413", async () => {
      mockIssueAttachments.storeIssueAttachmentStream.mockResolvedValue({ ok: false, reason: "too-large" });
      const res = await request(server, "POST", `/issues/${NATIVE}/attachments/stream?name=big.bin`, {
        headers: { "content-type": "application/octet-stream", accept: "application/json" },
        body: "data",
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body).error).toBe("File too large (max 1 GB)");
    });

    it("POST .../delete removes the issue's own attachment only", async () => {
      const ok = await request(server, "POST", `/issues/${NATIVE}/attachments/${ATT}/delete`, { headers: { accept: "application/json" } });
      expect(ok.status).toBe(200);
      expect(mockIssueAttachments.deleteIssueAttachment).toHaveBeenCalledWith(ATT);

      mockIssueAttachments.deleteIssueAttachment.mockClear();
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, id: OTHER });
      const wrong = await request(server, "POST", `/issues/${OTHER}/attachments/${ATT}/delete`, { headers: { accept: "application/json" } });
      expect(wrong.status).toBe(404);
      expect(mockIssueAttachments.deleteIssueAttachment).not.toHaveBeenCalled();
    });

    it("POST /issues claims pending attachments and rewrites their links to the new id", async () => {
      mockIssueAttachments.claimPendingAttachments.mockResolvedValue([attachmentRow()]);
      const body = `see ![shot](/issues/new/attachments/${ATT}/shot.png) and [x](/issues/new/attachments/cla_01JBQ7X4M2K8NV3TYRW9GZ5PD9/x.zip)`;
      const res = await request(server, "POST", "/issues", {
        body: `title=T&body=${encodeURIComponent(body)}&attachment=${ATT}`,
      });
      expect(res.status).toBe(303);
      expect(mockIssueAttachments.claimPendingAttachments).toHaveBeenCalledWith([ATT], NATIVE);
      expect(mockClawsIssues.editIssue).toHaveBeenCalledWith(
        NATIVE,
        `see ![shot](/issues/${NATIVE}/attachments/${ATT}/shot.png) and [x](/issues/new/attachments/cla_01JBQ7X4M2K8NV3TYRW9GZ5PD9/x.zip)`,
      );
    });

    it("GET /issues/:id lists the attachments", async () => {
      const { listClawsIssueAttachments } = await import("./db.js");
      vi.mocked(listClawsIssueAttachments).mockResolvedValue([attachmentRow()] as any);
      const res = await request(server, "GET", `/issues/${NATIVE}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain(`href="/issues/${NATIVE}/attachments/${ATT}/shot.png"`);
      expect(res.body).toContain(`action="/issues/${NATIVE}/attachments/${ATT}/delete"`);
      expect(res.body).toContain(`data-attach-target="${NATIVE}"`);
    });
  });

  it("GET /issues/:id canonicalises a lower-cased id", async () => {
    const res = await request(server, "GET", `/issues/${NATIVE.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(mockClawsIssues.getIssue).toHaveBeenCalledWith(NATIVE);
  });

  it("GET /issues/:id 404s for a forge number, pointing at the forge", async () => {
    const res = await request(server, "GET", "/issues/42");
    expect(res.status).toBe(404);
    expect(res.body).toContain("own forge");
    expect(mockClawsIssues.getIssue).not.toHaveBeenCalled();
  });

  it("GET /issues/:id 404s for an unknown native id", async () => {
    const res = await request(server, "GET", "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD");
    expect(res.status).toBe(404);
  });

  it("GET /issues/:id redirects a shadow to the forge issue it stands for", async () => {
    const { getImportedIssueByNative } = await import("./db.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, kind: "shadow" });
    vi.mocked(getImportedIssueByNative).mockResolvedValue({ repo: "org/repo", forgeNumber: 42 });

    const res = await request(server, "GET", `/issues/${NATIVE}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://github.com/org/repo/issues/42");
    expect(getImportedIssueByNative).toHaveBeenCalledWith(NATIVE);
    expect(mockClawsIssues.listCommentDetails).not.toHaveBeenCalled();
  });

  it("GET /issues/:id 404s for a shadow with no linkage row", async () => {
    const { getImportedIssueByNative } = await import("./db.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, kind: "shadow" });
    vi.mocked(getImportedIssueByNative).mockResolvedValue(undefined);

    const res = await request(server, "GET", `/issues/${NATIVE}`);

    expect(res.status).toBe(404);
  });

  it("POST /issues/:id/* treats a shadow as not found", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, kind: "shadow" });

    const edit = await request(server, "POST", `/issues/${NATIVE}/edit`, { body: "title=Hijacked" });
    const comment = await request(server, "POST", `/issues/${NATIVE}/comments`, { body: "body=hello" });
    const state = await request(server, "POST", `/issues/${NATIVE}/state`, { body: "state=closed" });

    expect([edit.status, comment.status, state.status]).toEqual([404, 404, 404]);
    expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/labels applies the difference through the façade", async () => {
    const { addLabel: addLabelFn, removeLabel: removeLabelFn } = await import("./github.js");

    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: ["Priority"] });

    const res = await request(server, "POST", `/issues/${NATIVE}/labels`, { body: "label=Use+Codex" });

    expect(res.status).toBe(303);
    expect(addLabelFn).toHaveBeenCalledWith("org/repo", NATIVE, "Use Codex");
    expect(removeLabelFn).toHaveBeenCalledWith("org/repo", NATIVE, "Priority");
  });

  // The lifecycle is read off its field and the approval off its own, and the
  // form offers neither — so an unticked box must not reset the issue to
  // Ideas, and a hand-sent state or retired gate label must not set anything.
  it("POST /issues/:id/labels leaves the lifecycle state and the approval alone", async () => {
    const { addLabel: addLabelFn, removeLabel: removeLabelFn } = await import("./github.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: ["Blocked"], lifecycle: "blocked" });

    await request(server, "POST", `/issues/${NATIVE}/labels`, { body: "label=Refined&label=Automerge" });

    expect(addLabelFn).not.toHaveBeenCalled();
    expect(removeLabelFn).not.toHaveBeenCalled();
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/column sets the lifecycle state and redirects back", async () => {
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=backlog" });

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/issues/${NATIVE}`);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "backlog");
  });

  // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F: Approved is the plan-review lifecycle approved through Plan.
  it("POST /issues/:id/column approved approves an issue in plan review through Plan, writing no lifecycle", async () => {
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved" });
    expect(res.status).toBe(303);
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user");
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/column approved from Planning approves through Plan, then sets the plan-review lifecycle", async () => {
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, lifecycle: "planning" });
    expect((await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved" })).status).toBe(303);
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user");
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");
    expect(mockIssueApproval.applyIssueApproval.mock.invocationCallOrder[0]).toBeLessThan(mockClawsIssues.setLifecycle.mock.invocationCallOrder[0]);
  });

  it("POST /issues/:id/column never lowers a Merge approval on Approved, and Awaiting plan review lowers it to Requirements", async () => {
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, lifecycle: "planning", approved_through: "merge" });
    expect((await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved" })).status).toBe(303);
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");

    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, approved_through: "plan" });
    expect((await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=awaiting-plan-review" })).status).toBe(303);
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "requirements", "test-user");
  });

  it("POST /issues/:id/column makes its write as the signed-in operator, for the issue's History", async () => {
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    let actor: IssueActor | undefined;
    mockClawsIssues.setLifecycle.mockImplementationOnce(async () => { actor = currentIssueActor(); });
    await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=backlog" });
    expect(actor).toEqual({ kind: "operator", name: "test-user" });
  });

  it("POST /issues/:id/column sends an issue to the backlog, but not while its PR is open", async () => {
    const ok = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=backlog" });
    expect(ok.status).toBe(303);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "backlog");

    mockClawsIssues.setLifecycle.mockClear();
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow()] });
    const withPr = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=backlog" });
    expect(withPr.status).toBe(409);
    expect(withPr.body).toContain("open PR");
    expect(mockIssueFlight.loadIssueFlight).toHaveBeenCalledWith("org/repo", NATIVE);
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/column approves through Merge in one write when column=approved&automerge=1", async () => {
    const { addLabel: addLabelFn } = await import("./github.js");
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);

    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved&automerge=1" });

    expect(res.status).toBe(303);
    expect(mockIssueApproval.applyIssueApproval.mock.calls.map((call) => call[2])).toEqual(["merge"]);
    expect(addLabelFn).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/column reports a partly applied move, not a refusal, when the lifecycle write fails after the approval landed", async () => {
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    mockClawsIssues.getIssue.mockImplementation(async () => ({ ...nativeIssue, lifecycle: "planning", requirements_approved_at: "2026-09-21 09:30:00" }));
    mockClawsIssues.setLifecycle.mockRejectedValueOnce(new Error("changed"));

    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved" });

    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user");
    expect(res.status).toBe(500);
    expect(res.body).toContain("The approval was saved");
  });

  // The plan rule (board-plan-rule.ts): Approved and Awaiting plan review need
  // a plan, refused before anything writes — Refine & Automerge included.
  it.each([
    ["approved&automerge=1", "Approved needs a plan"],
    ["awaiting-plan-review", "Awaiting plan review needs a plan"],
  ])("POST /issues/:id/column refuses column=%s for an issue with no plan", async (form, reason) => {
    const { addLabel: addLabelFn } = await import("./github.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "planning" });

    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: `column=${form}` });

    expect(res.status).toBe(409);
    expect(res.body).toContain(reason);
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
    expect(addLabelFn).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/column=planning on an issue with a plan re-plans it", async () => {
    const worker = await import("./worker.js");
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, requirements_approved_at: "2026-09-21 09:30:00" });

    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=planning" });

    expect(res.status).toBe(303);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "planning");
    expect(worker.enqueue).toHaveBeenCalledWith(worker.AGENT_KINDS.ISSUE_REFINER_REPLAN, "org/repo", NATIVE, expect.anything());
  });

  it("POST /issues/:id/column=planning on an issue with no plan queues no re-plan", async () => {
    const worker = await import("./worker.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: ["Blocked"], lifecycle: "blocked", requirements_approved_at: "2026-09-21 09:30:00" });

    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=planning" });

    expect(res.status).toBe(303);
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/column refuses blocked without a reason and writes nothing", async () => {
    for (const body of ["column=blocked", "column=blocked&reason=+++"]) {
      const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body });
      expect(res.status).toBe(400);
      expect(res.body).toContain("A reason is required to mark an issue Blocked.");
    }
    expect(mockClawsIssues.blockIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/column adds no label when automerge=1 but the column is not approved", async () => {
    const { addLabel: addLabelFn } = await import("./github.js");

    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=blocked&automerge=1&reason=waiting" });

    expect(res.status).toBe(303);
    expect(mockClawsIssues.blockIssue).toHaveBeenCalledWith("org/repo", NATIVE, "waiting");
    expect(addLabelFn).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/column adds no label for a refused move even with automerge=1", async () => {
    const { addLabel: addLabelFn } = await import("./github.js");
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: true, openPrs: [] });

    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved&automerge=1" });

    expect(res.status).toBe(409);
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(addLabelFn).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/unblock moves an in-flight Blocked issue out of Blocked, while /column still refuses the derived landing", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: ["Blocked"], lifecycle: "blocked" });
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow()] });

    const refused = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=awaiting-plan-review" });
    expect(refused.status).toBe(409);
    expect(refused.body).toContain(DERIVED_COLUMN_REJECTION.slice(0, 20));
    const derived = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=awaiting-merge" });
    expect(derived.status).toBe(409);
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();

    const res = await request(server, "POST", `/issues/${NATIVE}/unblock`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/issues/${NATIVE}`);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");
  });

  it("POST /issues/:id/unblock writes nothing for an issue that is not Blocked", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "planning" });
    const res = await request(server, "POST", `/issues/${NATIVE}/unblock`);
    expect(res.status).toBe(303);
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  describe("POST /issues/:id/backlog-until", () => {
    const post = (body: string) => request(server, "POST", `/issues/${NATIVE}/backlog-until`, { body });
    const inBacklog = () => mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "backlog" });

    it("sets, changes and clears the date of an issue in the Backlog", async () => {
      const { setClawsIssueBacklogUntil } = await import("./db.js");
      inBacklog();
      const set = await post("until=2999-01-01");
      expect(set.status).toBe(303);
      expect(set.headers.location).toBe(`/issues/${NATIVE}`);
      expect(setClawsIssueBacklogUntil).toHaveBeenCalledWith(NATIVE, "2999-01-01");
      expect((await post("until=")).status).toBe(303);
      expect(setClawsIssueBacklogUntil).toHaveBeenLastCalledWith(NATIVE, null);
    });

    it("returns to the filtered backlog page, and only there", async () => {
      inBacklog();
      expect((await post("until=2999-01-01&return_to=%2Fbacklog%3Frepo%3Dorg%252Frepo")).headers.location).toBe("/backlog?repo=org%2Frepo");
      expect((await post("until=2999-01-01&return_to=https%3A%2F%2Fevil.example")).headers.location).toBe(`/issues/${NATIVE}`);
    });

    it("refuses an issue that is not in the Backlog, and a past date", async () => {
      const { setClawsIssueBacklogUntil } = await import("./db.js");
      expect((await post("until=2999-01-01")).status).toBe(409);
      inBacklog();
      expect((await post("until=2000-01-01")).status).toBe(400);
      expect((await post("until=tomorrow")).status).toBe(400);
      expect(setClawsIssueBacklogUntil).not.toHaveBeenCalled();
    });

    it("refuses a closed or unassigned issue, which the sweep would never bring back", async () => {
      const { setClawsIssueBacklogUntil } = await import("./db.js");
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "backlog", state: "closed" });
      expect((await post("until=2999-01-01")).status).toBe(409);
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "backlog", repos: [] });
      expect((await post("until=2999-01-01")).status).toBe(409);
      expect(setClawsIssueBacklogUntil).not.toHaveBeenCalled();
    });
  });

  describe("POST /issues/:id/comments with a status", () => {
    const post = (body: string) => request(server, "POST", `/issues/${NATIVE}/comments`, { body });

    it("comments, then sets Blocked with the comment as the reason in the same write", async () => {
      const { setIssueBlockedReason } = await import("./db.js");
      const res = await post("body=waiting+on+vendor&status=blocked");
      expect(res.status).toBe(303);
      expect(mockClawsIssues.commentOnIssue).toHaveBeenCalled();
      expect(mockClawsIssues.blockIssue).toHaveBeenCalledWith("org/repo", NATIVE, "waiting on vendor");
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
      expect(setIssueBlockedReason).not.toHaveBeenCalled();
      expect(mockClawsIssues.commentOnIssue.mock.invocationCallOrder[0]).toBeLessThan(mockClawsIssues.blockIssue.mock.invocationCallOrder[0]);
    });

    it("refuses a comment-requiring status with an empty comment and writes nothing", async () => {
      const res = await post("body=+&status=blocked");
      expect(res.status).toBe(400);
      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    });

    it("applies Approve plan with an empty comment", async () => {
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      const res = await post("body=&status=approved");
      expect(res.status).toBe(303);
      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user");
    });

    it("approves through Merge for approved-automerge", async () => {
      const { addLabel: addLabelFn } = await import("./github.js");
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      const res = await post("body=&status=approved-automerge");
      expect(res.status).toBe(303);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenLastCalledWith("org/repo", NATIVE, "merge", "test-user");
      expect(addLabelFn).not.toHaveBeenCalled();
    });

    it("parks the issue until the date beside Send to backlog, and ignores the date for any other status", async () => {
      const { setClawsIssueBacklogUntil } = await import("./db.js");
      expect((await post("body=&status=backlog&backlog_until=2999-01-01")).status).toBe(303);
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "backlog");
      expect(setClawsIssueBacklogUntil).toHaveBeenCalledWith(NATIVE, "2999-01-01");
      vi.mocked(setClawsIssueBacklogUntil).mockClear();
      expect((await post("body=&status=backlog&backlog_until=")).status).toBe(303);
      expect(setClawsIssueBacklogUntil).not.toHaveBeenCalled();
      expect((await post("body=&status=backlog&backlog_until=2000-01-01")).status).toBe(400);
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      expect((await post("body=&status=approved&backlog_until=2999-01-01")).status).toBe(303);
      expect(setClawsIssueBacklogUntil).not.toHaveBeenCalled();
    });

    it("posts both for Send to backlog with a comment", async () => {
      const res = await post("body=later&status=backlog");
      expect(res.status).toBe(303);
      expect(mockClawsIssues.commentOnIssue).toHaveBeenCalled();
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "backlog");
    });

    it("moves to Planning once, without the implicit feedback return", async () => {
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, requirements_approved_at: "2026-09-21 09:30:00" });
      const res = await post("body=redo+the+plan&status=planning");
      expect(res.status).toBe(303);
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledTimes(1);
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "planning");
    });

    it("unblocks an in-flight Blocked issue", async () => {
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: ["Blocked"], lifecycle: "blocked" });
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow()] });
      const res = await post("body=fixed&status=unblock");
      expect(res.status).toBe(303);
      expect(mockClawsIssues.commentOnIssue).toHaveBeenCalled();
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");
    });

    it("answers 409 for a refused status after the comment posted", async () => {
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "planning" });
      const res = await post("body=hi&status=awaiting-plan-review");
      expect(res.status).toBe(409);
      expect(mockClawsIssues.commentOnIssue).toHaveBeenCalled();
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    });
  });

  it("POST /issues/:id/promote approves the requirements and moves an Ideas issue to Planning", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "ideas" });
    const res = await request(server, "POST", `/issues/${NATIVE}/promote`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/issues/${NATIVE}`);
    expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "test-user", "ideas");
    expect((await import("./worker.js")).enqueue).not.toHaveBeenCalled();
  });

  // A demoted issue that kept its plan: the promotion re-plans it, or it would
  // sit in Planning with nothing running.
  it("POST /issues/:id/promote re-plans an issue that already has a plan", async () => {
    const worker = await import("./worker.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "ideas" });
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    const res = await request(server, "POST", `/issues/${NATIVE}/promote`);
    expect(res.status).toBe(303);
    expect(worker.enqueue).toHaveBeenCalledWith(worker.AGENT_KINDS.ISSUE_REFINER_REPLAN, "org/repo", NATIVE, expect.anything());
  });

  // reapproval.ts: promoting a pending design change approves it, from any column.
  it("POST /issues/:id/promote approves a pending design change from any column, without a re-plan", async () => {
    mockReapproval.hasPendingReapproval.mockResolvedValue(true);
    try {
      mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "awaiting-plan-review" });
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      const res = await request(server, "POST", `/issues/${NATIVE}/promote`);
      expect(res.status).toBe(303);
      expect(mockReapproval.promoteReapproval).toHaveBeenCalledWith(NATIVE, "test-user");
      expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
      expect((await import("./worker.js")).enqueue).not.toHaveBeenCalled();
    } finally {
      mockReapproval.hasPendingReapproval.mockResolvedValue(false);
    }
  });

  it("POST /issues/:id/promote refuses an issue out of the requirements columns, unassigned or closed", async () => {
    for (const record of [
      { ...nativeIssue, labels: [], lifecycle: "planning" },
      { ...nativeIssue, labels: [], lifecycle: "ideas", repos: [] },
      { ...nativeIssue, labels: [], lifecycle: "ideas", state: "closed" },
    ]) {
      mockClawsIssues.getIssue.mockResolvedValue(record);
      expect((await request(server, "POST", `/issues/${NATIVE}/promote`)).status).toBe(409);
    }
    expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/promote 404s a shadow record — a forge issue promotes through /board/move, not its shadow's id", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, kind: "shadow", labels: [], lifecycle: "ideas" });
    expect((await request(server, "POST", `/issues/${NATIVE}/promote`)).status).toBe(404);
    expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/promote 409s when the issue changed lifecycle since the page loaded", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "ideas" });
    mockClawsIssues.promoteIssue.mockResolvedValueOnce(false);
    const res = await request(server, "POST", `/issues/${NATIVE}/promote`);
    expect(res.status).toBe(409);
  });

  it("POST /issues/:id/column promotes out of the requirements columns and demotes into them", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "ideas" });
    expect((await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=planning" })).status).toBe(303);
    expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "test-user", "ideas");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue });
    expect((await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=ideas" })).status).toBe(303);
    expect(mockClawsIssues.demoteIssue).toHaveBeenCalledWith(NATIVE);
  });

  it("POST /issues/:id/column 409s when the issue changed lifecycle since the page loaded, like /promote does", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: [], lifecycle: "ideas" });
    mockClawsIssues.promoteIssue.mockResolvedValueOnce(false);
    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=planning" });
    expect(res.status).toBe(409);
  });

  it("POST /issues/:id/column refuses a move the board would refuse, writing nothing", async () => {
    const derived = await Promise.all(["in-progress", "awaiting-merge"].map((column) =>
      request(server, "POST", `/issues/${NATIVE}/column`, { body: `column=${column}` })));
    const inProgress = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=implementing" });
    const unknown = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=done" });
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, repos: [] });
    const unassigned = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved" });
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, lifecycle: "planning" });
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow()] });
    const withPr = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=ideas" });
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [] });
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, state: "closed" });
    const closed = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved" });

    for (const res of derived) {
      expect(res.status).toBe(409);
      expect(res.body).toContain("open PR");
    }
    // `in-progress` is no longer a column at all.
    expect([inProgress.status, unknown.status, unassigned.status, withPr.status, closed.status]).toEqual([400, 400, 409, 409, 409]);
    expect(withPr.body).toContain("open PR");
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  // The form only offers LABEL_SPECS labels, so a label an agent applied but
  // the form never showed must survive a "Save labels".
  it("POST /issues/:id/labels leaves labels the form did not offer alone", async () => {
    const { removeLabel: removeLabelFn } = await import("./github.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: ["Priority", "Plan: Deep"] });

    await request(server, "POST", `/issues/${NATIVE}/labels`, { body: "label=Automerge" });

    expect(removeLabelFn).toHaveBeenCalledWith("org/repo", NATIVE, "Priority");
    expect(removeLabelFn).not.toHaveBeenCalledWith("org/repo", NATIVE, "Plan: Deep");
  });

  // Claws Staging is opt-in only via the forge, so the Labels form never
  // renders a checkbox for it — the write path's "offered" set must match,
  // or toggling any other label strips Claws Staging from a live issue.
  it("POST /issues/:id/labels leaves Claws Staging alone", async () => {
    const { removeLabel: removeLabelFn } = await import("./github.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: ["Claws Staging", "Priority"] });

    await request(server, "POST", `/issues/${NATIVE}/labels`, { body: "label=Automerge" });

    expect(removeLabelFn).toHaveBeenCalledWith("org/repo", NATIVE, "Priority");
    expect(removeLabelFn).not.toHaveBeenCalledWith("org/repo", NATIVE, "Claws Staging");
  });

  it("POST /issues/:id/edit only writes what changed", async () => {
    const { editIssue: editIssueFn, editIssueTitle: editIssueTitleFn } = await import("./github.js");

    await request(server, "POST", `/issues/${NATIVE}/edit`, { body: "title=Native+issue&body=Changed" });

    expect(editIssueTitleFn).not.toHaveBeenCalled();
    expect(editIssueFn).toHaveBeenCalledWith("org/repo", NATIVE, "Changed");
  });

  // The header's inline title editor posts only `title` — a missing `body`
  // field must leave the stored body alone rather than clearing it.
  it("POST /issues/:id/edit with title alone renames without touching the body", async () => {
    const { editIssue: editIssueFn, editIssueTitle: editIssueTitleFn } = await import("./github.js");

    await request(server, "POST", `/issues/${NATIVE}/edit`, { body: "title=Renamed" });

    expect(editIssueTitleFn).toHaveBeenCalledWith("org/repo", NATIVE, "Renamed");
    expect(editIssueFn).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/edit with Accept: application/json returns the saved title", async () => {
    const res = await request(server, "POST", `/issues/${NATIVE}/edit`, {
      body: "title=Renamed",
      headers: { accept: "application/json" },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, title: "Renamed" });
  });

  it("POST /issues/:id/edit silently ignores an empty title", async () => {
    const { editIssue: editIssueFn, editIssueTitle: editIssueTitleFn } = await import("./github.js");

    const res = await request(server, "POST", `/issues/${NATIVE}/edit`, {
      body: "title=",
      headers: { accept: "application/json" },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, title: "Native issue" });
    expect(editIssueTitleFn).not.toHaveBeenCalled();
    expect(editIssueFn).not.toHaveBeenCalled();
  });

  // An empty/whitespace title must not discard an already-valid body edit posted
  // in the same request, as the collapsed Edit section's no-JS form always does.
  it("POST /issues/:id/edit still saves the body when the title is empty", async () => {
    const { editIssue: editIssueFn, editIssueTitle: editIssueTitleFn } = await import("./github.js");

    await request(server, "POST", `/issues/${NATIVE}/edit`, { body: "title=&body=Changed" });

    expect(editIssueTitleFn).not.toHaveBeenCalled();
    expect(editIssueFn).toHaveBeenCalledWith("org/repo", NATIVE, "Changed");
  });

  it("POST /issues/:id/state closes as not planned by default and reopens through the store", async () => {
    const { closeIssue: closeIssueFn } = await import("./github.js");
    const { notify: notifyFn } = await import("./slack.js");

    await request(server, "POST", `/issues/${NATIVE}/state`, { body: "state=closed" });
    expect(closeIssueFn).toHaveBeenCalledWith("org/repo", NATIVE, "not_planned");
    expect(notifyFn).not.toHaveBeenCalled();

    await request(server, "POST", `/issues/${NATIVE}/state`, { body: "state=open" });
    expect(mockClawsIssues.reopenIssue).toHaveBeenCalledWith(NATIVE);
  });

  it("POST /issues/:id/state closes an issue whose repos are no longer configured", async () => {
    const { closeIssue: closeIssueFn } = await import("./github.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, repos: ["org/gone"] });
    const res = await request(server, "POST", `/issues/${NATIVE}/state`, { body: "state=closed" });
    expect(res.status).toBe(303);
    expect(closeIssueFn).toHaveBeenCalledWith("org/gone", NATIVE, "not_planned");
  });

  // The issue page's second close button opts into completed, for work
  // finished outside Claws.
  it("POST /issues/:id/state closes as completed when reason=completed", async () => {
    const { closeIssue: closeIssueFn } = await import("./github.js");

    await request(server, "POST", `/issues/${NATIVE}/state`, { body: "state=closed&reason=completed" });
    expect(closeIssueFn).toHaveBeenCalledWith("org/repo", NATIVE, "completed");
  });

  // A dashboard comment is the operator's feedback, not Claws'. Routing it
  // through the façade would stamp the "Automated by Claws" marker on it and
  // the refiner would skip it as its own output.
  it("POST /issues/:id/comments posts as the operator, unmarked", async () => {
    await request(server, "POST", `/issues/${NATIVE}/comments`, { body: "body=please+tweak+the+plan" });

    expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "please tweak the plan", "stjohnb");
  });

  it("POST /issues/:id/comments on an Awaiting plan review issue returns it to the planner", async () => {
    const worker = await import("./worker.js");

    await request(server, "POST", `/issues/${NATIVE}/comments`, { body: "body=please+tweak+the+plan" });

    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "planning");
    expect(worker.enqueue).toHaveBeenCalledWith("issue-refiner:refine", "org/repo", NATIVE, { priority: false });
  });

  it.each(["ideas", "planning", "approved"] as const)("POST /issues/:id/comments on a %s issue leaves the lifecycle alone", async (lifecycle) => {
    const worker = await import("./worker.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, lifecycle });

    await request(server, "POST", `/issues/${NATIVE}/comments`, { body: "body=please+tweak+the+plan" });

    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/comments does nothing when the comment is blank", async () => {
    const worker = await import("./worker.js");
    mockClawsIssues.commentOnIssue.mockResolvedValueOnce(null);

    await request(server, "POST", `/issues/${NATIVE}/comments`, { body: "body=" });

    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/comments does nothing when the comment is only a phase-done claim", async () => {
    const worker = await import("./worker.js");

    await request(server, "POST", `/issues/${NATIVE}/comments`, { body: `body=${encodeURIComponent("claws-phase-done: 2")}` });

    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/comments resets the lifecycle but skips the enqueue when the planner is disabled", async () => {
    const worker = await import("./worker.js");
    const cfg = await import("./config.js");
    vi.mocked(cfg.isAgentDisabled).mockImplementation((name: string) => name === "planner");

    await request(server, "POST", `/issues/${NATIVE}/comments`, { body: "body=please+tweak+the+plan" });

    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "planning");
    expect(worker.enqueue).not.toHaveBeenCalled();

    vi.mocked(cfg.isAgentDisabled).mockImplementation(() => false);
  });

  it("POST /issues/:id/comments resets the lifecycle but skips the enqueue for an unassigned issue", async () => {
    const worker = await import("./worker.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, repos: [] });

    await request(server, "POST", `/issues/${NATIVE}/comments`, { body: "body=please+tweak+the+plan" });

    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("", NATIVE, "planning");
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/model-plan writes the grid as explicit cells and clears blank phases", async () => {
    const db = await import("./db.js");
    const res = await request(server, "POST", `/issues/${NATIVE}/model-plan`, {
      body: "provider_implement=codex&tier_implement=haiku&provider_review=&tier_review=opus&provider_plan=bogus&tier_plan=",
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/issues/${NATIVE}`);
    expect(db.upsertIssueModelPlanCell).toHaveBeenCalledWith("org/repo", NATIVE, "implement", { provider: "codex", tier: "haiku", source: "explicit" });
    expect(db.upsertIssueModelPlanCell).toHaveBeenCalledWith("org/repo", NATIVE, "review", { provider: null, tier: "opus", source: "explicit" });
    // An unknown provider reads as blank, and a blank phase is cleared.
    expect(db.deleteIssueModelPlanCell).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "explicit");
    expect(db.upsertIssueModelPlanCell).toHaveBeenCalledTimes(2);
  });

  it("POST /issues/:id/model-plan of the rendered form, unchanged, leaves a suggested cell suggested", async () => {
    const db = await import("./db.js");
    vi.mocked(db.getIssueModelPlanRows).mockResolvedValueOnce([
      { repo: "org/repo", issue_ref: NATIVE, phase: "implement", provider: "claude", tier: "fable", source: "suggested", updated_at: "2026-09-22 10:00:00" },
    ]);
    const page = await request(server, "GET", `/issues/${NATIVE}`);
    expect(page.body).toContain("default (suggested: opus)");
    // Submit exactly what the browser would: each select's selected value.
    const fields = [...page.body.matchAll(/<select name="((?:provider|tier)_[a-z-]+)"[^>]*>(.*?)<\/select>/gs)]
      .map(([, name, options]) => `${name}=${encodeURIComponent(options.match(/<option value="([^"]*)" selected>/)?.[1] ?? "")}`);
    expect(fields).toHaveLength(14);

    await request(server, "POST", `/issues/${NATIVE}/model-plan`, { body: fields.join("&") });

    expect(db.upsertIssueModelPlanCell).not.toHaveBeenCalled();
    for (const call of vi.mocked(db.deleteIssueModelPlanCell).mock.calls) expect(call[3]).toBe("explicit");
  });

  it("POST /issues/:id/model-plan refuses an issue with no repo", async () => {
    const db = await import("./db.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, repos: [] });
    const res = await request(server, "POST", `/issues/${NATIVE}/model-plan`, { body: "tier_implement=opus" });
    expect(res.status).toBe(409);
    expect(db.upsertIssueModelPlanCell).not.toHaveBeenCalled();
    expect(db.deleteIssueModelPlanCell).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/model-plan stores a multi-repo issue's plan under its primary repo", async () => {
    const db = await import("./db.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, repos: ["org/repo", "org/other"] });
    const res = await request(server, "POST", `/issues/${NATIVE}/model-plan`, { body: "tier_implement=opus" });
    expect(res.status).toBe(303);
    expect(db.upsertIssueModelPlanCell).toHaveBeenCalledWith("org/other", NATIVE, "implement", expect.objectContaining({ tier: "opus", source: "explicit" }));
  });

  it("POST /issues/:id/model-plan treats a shadow as not found", async () => {
    const db = await import("./db.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, kind: "shadow" });
    const res = await request(server, "POST", `/issues/${NATIVE}/model-plan`, { body: "tier_implement=opus" });
    expect(res.status).toBe(404);
    expect(db.upsertIssueModelPlanCell).not.toHaveBeenCalled();
  });

  it("GET /issues/:id renders the model plan grid", async () => {
    const db = await import("./db.js");
    vi.mocked(db.getIssueModelPlanRows).mockResolvedValueOnce([
      { repo: "org/repo", issue_ref: NATIVE, phase: "implement", provider: "codex", tier: "haiku", source: "explicit", updated_at: "2026-09-22 10:00:00" },
    ]);
    const res = await request(server, "GET", `/issues/${NATIVE}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(`action="/issues/${NATIVE}/model-plan"`);
    expect(res.body).toContain("gpt-5.6-luna");
    expect(db.getIssueModelPlanRows).toHaveBeenCalledWith("org/repo", NATIVE);
  });

  it("POST /issues applies a submitted model plan to each selected repo", async () => {
    const db = await import("./db.js");
    await request(server, "POST", "/issues", { body: "title=New+thing&repo=org%2Frepo&provider_plan=claude&tier_plan=opus" });
    expect(db.upsertIssueModelPlanCell).toHaveBeenCalledWith("org/repo", NATIVE, "plan", { provider: "claude", tier: "opus", source: "explicit" });
  });

  it("POST /issues writes no model plan when the grid was left blank", async () => {
    const db = await import("./db.js");
    await request(server, "POST", "/issues", { body: "title=New+thing&repo=org%2Frepo&provider_plan=&tier_plan=" });
    expect(db.upsertIssueModelPlanCell).not.toHaveBeenCalled();
    expect(db.deleteIssueModelPlanCell).not.toHaveBeenCalled();
  });

  it("POST /issues refuses a submitted model plan when no repo is selected", async () => {
    const db = await import("./db.js");
    const res = await request(server, "POST", "/issues", { body: "title=New+thing&provider_plan=claude&tier_plan=opus" });
    expect(res.status).toBe(409);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    expect(db.upsertIssueModelPlanCell).not.toHaveBeenCalled();
  });

  it("POST /issues stores a multi-repo issue's model plan under its primary repo", async () => {
    const db = await import("./db.js");
    await request(server, "POST", "/issues", { body: "title=New+thing&repo=test%2Frepo&repo=org%2Frepo&provider_plan=claude&tier_plan=opus" });
    expect(db.upsertIssueModelPlanCell).toHaveBeenCalledWith("org/repo", NATIVE, "plan", { provider: "claude", tier: "opus", source: "explicit" });
  });

  it("POST /issues/:id/repos keeps only managed repos", async () => {
    await request(server, "POST", `/issues/${NATIVE}/repos`, { body: "repo=org%2Frepo&repo=not%2Fmanaged" });

    expect(mockClawsIssues.setRepos).toHaveBeenCalledWith(NATIVE, ["org/repo"]);
  });

  // The issue page's auto-saving forms post with `Accept: application/json`
  // and read the answer; a plain form post keeps the redirect.
  it("POST /issues/:id/labels and /repos answer JSON when asked, and redirect otherwise", async () => {
    const json = { headers: { accept: "application/json" } };
    for (const [path, body] of [["labels", "label=Refined"], ["repos", "repo=org%2Frepo"]] as const) {
      const asked = await request(server, "POST", `/issues/${NATIVE}/${path}`, { ...json, body });
      expect(asked.status).toBe(200);
      expect(JSON.parse(asked.body)).toEqual({ ok: true });

      const plain = await request(server, "POST", `/issues/${NATIVE}/${path}`, { body });
      expect(plain.status).toBe(303);
    }
  });

  it("POST /issues/:id/labels answers a JSON 404 for a missing issue when asked", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, kind: "shadow" });

    const res = await request(server, "POST", `/issues/${NATIVE}/labels`, { headers: { accept: "application/json" }, body: "label=Refined" });

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Issue not found" });
  });

  // Unassigned native issues never come through listOpenIssues, so the list
  // page fetches them separately or they are invisible.
  it("GET /issues lists unassigned native issues", async () => {
    mockClawsIssues.listUnassignedOpenIssues.mockResolvedValue([
      { id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD", title: "No repo yet", author_login: "stjohnb", updated_at: "2026-09-21 10:00:00", repos: [] },
    ]);

    const res = await request(server, "GET", "/issues");

    expect(res.status).toBe(200);
    expect(res.body).toContain("Unassigned");
    expect(res.body).toContain("No repo yet");
  });

  // A mutation route with no session cookie must not reach the store.
  it("rejects an unauthenticated mutation", async () => {
    testSessionCookie = null;
    const res = await request(server, "POST", "/issues", { body: "title=Sneaky" });
    expect(res.status).toBe(401);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });
});

describe("Issue board routes", () => {
  let server: http.Server;

  const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

  async function githubMock() {
    return await import("./github.js");
  }

  /**
   * Give the issue under test a plan, both ways the route reads one: a stored
   * plan version for a native ref, a Claws plan comment for a forge one.
   * Approved and Awaiting plan review are refused without it.
   */
  async function withPlan(): Promise<void> {
    const gh = await githubMock();
    mockClawsIssues.listPlans.mockResolvedValue([{ version: 1, commentId: null, body: "## Implementation Plan\n\nDo it.", createdAt: "" }]);
    vi.mocked(gh.getIssueComments).mockResolvedValue([
      { id: 1, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo it.", login: "claws", created_at: "2026-09-21T09:00:00Z" } as never,
    ]);
  }

  /**
   * Give forge issue `org/repo#42` a shadow holding `patch`: its lifecycle
   * and approval live there (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F), and a move into
   * a plan-review column is refused without one.
   */
  const FORGE_SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHE";
  function withShadow(patch: Record<string, unknown> = {}): void {
    trackForgeIssues(patch, { repo: "org/repo", id: FORGE_SHADOW });
  }

  async function move(body: unknown) {
    return await request(server, "POST", "/board/move", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    resetIssueFlight();
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockResolvedValue([]);
    vi.mocked(gh.removeLabel).mockResolvedValue(true);
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    // `clearAllMocks` clears calls, not implementations: a test that sets `mockResolvedValue` (not `…Once`) on this —
    // a forge ref's shadow — would otherwise leak it into every later test.
    mockResolveTrackerId.mockReset().mockResolvedValue(null);
    // Planless unless a test says otherwise (`withPlan`); reset rather than
    // cleared, so one test's plan does not leak into the next.
    mockClawsIssues.listPlans.mockReset().mockResolvedValue([]);
    vi.mocked(gh.getIssueComments).mockReset().mockResolvedValue([]);
    mockClawsIssues.listClosedIssuesSince.mockResolvedValue([]);
    mockClawsIssues.listUnassignedOpenIssues.mockResolvedValue([]);
    mockClawsIssues.getIssue.mockResolvedValue(undefined);
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  describe("POST /board/infra-approve (#clw_01M5WBG6JZ8P3PCYVCQ3PS9BBS)", () => {
    const PR = { number: 7, title: "Infra", headRefName: "claws/issue-1", baseRefName: "main", labels: [], author: { login: "claws" } };

    async function approveInfra(body: unknown = { repo: "org/repo", ref: 42, prRepo: "org/repo", prNumber: 7, headSha: "abc1234def" }) {
      return await request(server, "POST", "/board/infra-approve", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    async function infraPr() {
      const gh = await githubMock();
      const db = await import("./db.js");
      vi.mocked(db.getClawsPr).mockResolvedValue(openPrRow({ headSha: "abc1234def" }) as any);
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow({ headSha: "abc1234def" })] });
      vi.mocked(gh.getPRState).mockResolvedValue("OPEN");
      vi.mocked(gh.getPRChangedFiles).mockResolvedValue(["tofu/main.tf"]);
      vi.mocked(gh.listPRs).mockResolvedValue([PR] as any);
      vi.mocked(gh.listPRStatuses).mockResolvedValue(new Map([[7, {
        checkStatus: "passing", checksPassed: 1, checksTotal: 1, checksHeld: 0, mergeableState: "MERGEABLE",
        infraPaths: ["tofu/main.tf"], tofuPlan: { add: 1, change: 0, replace: 0, destroy: 0 }, tofuPlanState: "changes", tofuPlanDetail: "plan",
        tofuPlanHeadSha: "abc1234def",
      }]]) as any);
      return { gh, db };
    }

    afterEach(async () => {
      const gh = await githubMock();
      const db = await import("./db.js");
      vi.mocked(db.getClawsPr).mockReset().mockResolvedValue(null);
      vi.mocked(gh.getPRState).mockReset().mockResolvedValue(null);
      vi.mocked(gh.getPRChangedFiles).mockReset().mockResolvedValue([]);
      vi.mocked(gh.listPRs).mockReset().mockResolvedValue([]);
      vi.mocked(gh.listPRStatuses).mockReset().mockResolvedValue(new Map());
      vi.mocked(gh.getPRHeadSHA).mockReset().mockResolvedValue("abc1234def");
      resetIssueFlight();
    });

    it("records the merge approval and the infra approval for the live head, then tries the merge", async () => {
      const { db } = await infraPr();
      const merger = await import("./agents/auto-merger.js");
      vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: true });
      const res = await approveInfra();
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ ok: true, merged: true });
      expect(db.upsertClawsPr).toHaveBeenCalledWith("org/repo", 7, expect.objectContaining({ mergeApprovedBy: "test-user" }));
      expect(db.upsertClawsPr).toHaveBeenCalledWith("org/repo", 7, expect.objectContaining({ infraMergeApprovedBy: "test-user", infraMergeApprovedSha: "abc1234def" }));
      expect(merger.attemptMerge).toHaveBeenCalledWith(expect.objectContaining({ fullName: "org/repo" }), expect.objectContaining({ number: 7 }), { mergedBy: "dashboard", notify: false });
    });

    it("keeps the approval and answers the refusal and the re-rendered line when a gate holds the merge", async () => {
      const { db } = await infraPr();
      const merger = await import("./agents/auto-merger.js");
      vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: false, code: "checks-failed", message: "CI is failing." });
      vi.mocked(db.getClawsPr).mockResolvedValue(openPrRow({
        headSha: "abc1234def", infraMergeApprovedBy: "dashboard", infraMergeApprovedAt: "2026-10-26T10:00:00Z", infraMergeApprovedSha: "abc1234def",
      }) as any);
      const res = await approveInfra();
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toMatchObject({ ok: true, merged: false, reason: "CI is failing.", code: "checks-failed" });
      expect(data.line).toContain("board-infra");
      expect(data.line).toContain("1 addition");
      expect(data.line).toContain("Infra merge approved by dashboard for abc1234");
      const clearing = vi.mocked(db.upsertClawsPr).mock.calls.filter(([, , patch]) => (patch as Record<string, unknown>)["infraMergeApprovedBy"] === null);
      expect(clearing).toEqual([]);
    });

    it("refuses a head the operator did not see, records nothing and answers the new head's line without stale counts", async () => {
      const { gh, db } = await infraPr();
      vi.mocked(gh.getPRHeadSHA).mockResolvedValue("fedcba98765");
      const merger = await import("./agents/auto-merger.js");
      const res = await approveInfra();
      expect(res.status).toBe(409);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("moved to fedcba9; review the new plan and approve again");
      expect(data.line).toContain('data-head-sha="fedcba98765"');
      expect(data.line).toContain("Plan summary unavailable for the current head");
      expect(data.line).not.toContain("1 addition");
      expect(db.upsertClawsPr).not.toHaveBeenCalled();
      expect(merger.attemptMerge).not.toHaveBeenCalled();
    });

    it("shows no counts for a head the cached plan evidence was not read for, even once the row is at that head", async () => {
      const { gh, db } = await infraPr();
      vi.mocked(db.getClawsPr).mockResolvedValue(openPrRow({ headSha: "fedcba98765" }) as any);
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow({ headSha: "fedcba98765" })] });
      vi.mocked(gh.getPRHeadSHA).mockResolvedValue("fedcba98765");
      const merger = await import("./agents/auto-merger.js");
      vi.mocked(merger.attemptMerge).mockResolvedValueOnce({ merged: false, code: "checks-failed", message: "CI is failing." });
      const res = await approveInfra({ repo: "org/repo", ref: 42, prRepo: "org/repo", prNumber: 7, headSha: "fedcba98765" });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.line).toContain('data-head-sha="fedcba98765"');
      expect(data.line).toContain("Plan summary unavailable for the current head: the plan for this head has not been read yet");
      expect(data.line).not.toContain("1 addition");
    });

    it("refuses a PR that is not one of the card's issue's open PRs", async () => {
      const { db } = await infraPr();
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow({ prNumber: 8 })] });
      const res = await approveInfra();
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).error).toContain("org/repo#7 is not an open PR of org/repo#42");
      expect(db.upsertClawsPr).not.toHaveBeenCalled();
    });

    it("refuses a PR that touches no infrastructure paths", async () => {
      const { gh, db } = await infraPr();
      vi.mocked(gh.getPRChangedFiles).mockResolvedValue(["src/app.ts"]);
      const res = await approveInfra();
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).error).toContain("not an infrastructure PR");
      expect(db.upsertClawsPr).not.toHaveBeenCalled();
    });

    it("answers 404 without a claws_prs row and 409 for a PR that is not open", async () => {
      const { gh, db } = await infraPr();
      vi.mocked(db.getClawsPr).mockResolvedValueOnce(null);
      expect((await approveInfra()).status).toBe(404);
      vi.mocked(gh.getPRState).mockResolvedValueOnce("MERGED");
      expect((await approveInfra()).status).toBe(409);
      expect(db.upsertClawsPr).not.toHaveBeenCalled();
    });

    it("refuses an unconfigured repository and a malformed body", async () => {
      expect((await approveInfra({ repo: "org/repo", ref: 42, prRepo: "evil/repo", prNumber: 7, headSha: "abc1234def" })).status).toBe(403);
      expect((await approveInfra({ repo: "org/repo", ref: 42 })).status).toBe(400);
      expect((await approveInfra({ repo: "org/repo", ref: 42, prRepo: "org/repo", prNumber: 7 })).status).toBe(400);
    });
  });

  it("POST /board/move refuses a return date off a native move to the backlog", async () => {
    const res = await move({ repo: "org/repo", ref: 42, to: "backlog", until: "2999-01-01" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain("only accepted when moving a native issue to the backlog");
    expect((await move({ repo: "org/repo", ref: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", to: "planning", until: "2999-01-01" })).status).toBe(400);
    expect((await move({ repo: "org/repo", ref: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", to: "backlog", until: "2000-01-01" })).status).toBe(400);
  });

  it("GET /board summarises an issue's explicit model-plan cells on its card", async () => {
    const gh = await githubMock();
    const db = await import("./db.js");
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 42, title: "Planned", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 43, title: "Default", body: "", labels: [], author: { login: "stjohnb" } }]
        : []));
    vi.mocked(db.listExplicitIssueModelPlanRows).mockResolvedValueOnce([
      { repo: "org/repo", issue_ref: "42", phase: "implement", provider: "codex", tier: "sonnet", source: "explicit", updated_at: "2026-09-22 10:00:00" },
      { repo: "org/repo", issue_ref: "42", phase: "plan", provider: "claude", tier: "fable", source: "explicit", updated_at: "2026-09-22 10:00:00" },
    ]);

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(res.body).toContain("plan: claude/fable · impl: codex/sonnet");
    expect(res.body.match(/class="board-model-plan"/g)).toHaveLength(1);
  });

  it("GET /board shows Go to session on a card with a live board-started session, and survives a failed lookup", async () => {
    const OTHER = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE";
    const gh = await githubMock();
    const db = await import("./db.js");
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: NATIVE, title: "Has session", body: "", labels: [], author: { login: "stjohnb" } },
           { number: OTHER, title: "No session", body: "", labels: [], author: { login: "stjohnb" } }]
        : []));
    vi.mocked(db.listLiveBoardStartedSessions).mockResolvedValueOnce(new Map([[NATIVE, "sess123"]]));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(res.body.match(/class="trigger-btn board-icon-btn board-go-to-session"/g)).toHaveLength(1);
    expect(res.body).toContain(`href="/sessions/sess123"`);
    expect(res.body.match(/board-icon-btn board-start-session/g)).toHaveLength(1);

    vi.mocked(db.listLiveBoardStartedSessions).mockRejectedValueOnce(new Error("db down"));
    const failed = await request(server, "GET", "/board");
    expect(failed.status).toBe(200);
    expect(failed.body).not.toContain(`<a class="trigger-btn board-icon-btn board-go-to-session"`);
    expect(failed.body.match(/<button type="button" class="trigger-btn board-icon-btn board-start-session"/g)).toHaveLength(2);
  });

  it("GET /api/board returns the board's surface, count, warning and nav counts as JSON (#clw_01M59YYPDF6SQS5RR4JSFDZGJQ)", async () => {
    const gh = await githubMock();
    const db = await import("./db.js");
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: NATIVE, title: "Has session", body: "", labels: [], author: { login: "stjohnb" } }]
        : []));
    vi.mocked(db.listLiveBoardStartedSessions).mockResolvedValueOnce(new Map([[NATIVE, "sess123"]]));

    const res = await request(server, "GET", "/api/board?repo=org%2Frepo");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(res.body) as { surface: string; total: number; warning: string; nav: Array<{ href: string; text: string; name: string }> };
    expect(body.surface).toContain(`id="issue-board"`);
    expect(body.surface).toContain("Has session");
    expect(body.surface).toContain(`href="/sessions/sess123"`);
    expect(body.total).toBe(1);
    expect(typeof body.warning).toBe("string");
    expect(body.nav.map((n) => n.href)).toEqual(["/board", "/prs", "/sessions"]);
  });

  // #clw_01M59ZXZ26S1WBJQRSBGJXZVPZ: a reload renders from stale-ok forge
  // reads; a strict read (what a job makes) would hang here.
  it("GET /board, /backlog and /prs render from stale-ok forge reads without awaiting a strict one", async () => {
    const gh = await githubMock();
    const strictHang = new Promise<never>(() => {});
    const issues = [{ number: 42, title: "Cached card", body: "", labels: [], author: { login: "stjohnb" } }];
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string, opts?: { staleOk?: boolean }) =>
      (opts?.staleOk ? (repo === "org/repo" ? issues : []) : strictHang));
    vi.mocked(gh.listPRs).mockImplementation(async (_repo: string, opts?: { staleOk?: boolean }) =>
      (opts?.staleOk ? [] : strictHang));
    vi.mocked(gh.listPRStatuses).mockImplementation(async (_repo: string, opts?: { staleOk?: boolean }) =>
      (opts?.staleOk ? new Map() : strictHang));
    mockLoadOperatorAttentionCounts.mockResolvedValue({ issues: { attention: 1, total: 1 } });

    const board = await request(server, "GET", "/board");
    expect(board.status).toBe(200);
    expect(board.body).toContain("Cached card");
    expect(board.body).toContain('aria-label="Board, 1 of 1 issue needs attention"');
    expect((await request(server, "GET", "/backlog")).status).toBe(200);
    expect((await request(server, "GET", "/prs?kind=other")).status).toBe(200);
    expect(gh.listOpenIssues).toHaveBeenCalledWith("org/repo", { staleOk: true });
    expect(gh.listPRs).toHaveBeenCalledWith("org/repo", { staleOk: true });
    mockLoadOperatorAttentionCounts.mockReset();
    vi.mocked(gh.listPRs).mockReset().mockResolvedValue([]);
    vi.mocked(gh.listPRStatuses).mockReset().mockResolvedValue(new Map());
  });

  it("GET /api/board stays a strict forge read", async () => {
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockResolvedValue([]);

    expect((await request(server, "GET", "/api/board?repo=org%2Frepo")).status).toBe(200);
    expect(gh.listOpenIssues).toHaveBeenCalledWith("org/repo", undefined);
  });

  it("GET /board leaves a dependency bot's forge tracking issue off the board", async () => {
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 12, title: "Dependency Dashboard", body: "", labels: [], author: { login: "renovate[bot]" } },
           { number: 42, title: "Real work", body: "", labels: [], author: { login: "stjohnb" } }]
        : []));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(res.body).toContain(`data-ref="42"`);
    expect(res.body).not.toContain(`data-ref="12"`);
    expect(res.body).not.toContain("Dependency Dashboard");
  });

  // #clw_01M64CH10AK2PKH1JDGTB3FBMJ: a Blocked issue only waiting on other
  // work in flight is in Queued with what it waits on; the rest stay Blocked.
  it("GET /board puts a queued Blocked issue in Queued with its reason", async () => {
    const OTHER = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF";
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: NATIVE, title: "Waits", body: "", labels: [{ name: "Blocked" }], author: { login: "stjohnb" }, lifecycle: "blocked" },
           { number: OTHER, title: "Needs a person", body: "", labels: [{ name: "Blocked" }], author: { login: "stjohnb" }, lifecycle: "blocked" }]
        : []));
    mockIssuesQueued.mockResolvedValueOnce(new Map([[NATIVE, "Waiting on `org/repo#4` to merge"]]));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(mockIssuesQueued).toHaveBeenCalledWith(expect.arrayContaining([NATIVE, OTHER]));
    expect(res.body).toContain(`data-ref="${NATIVE}" data-column="queued"`);
    expect(res.body).toContain(`data-ref="${OTHER}" data-column="blocked"`);
    expect(res.body).toContain("Waiting on org/repo#4 to merge");
  });

  it("GET /board reads a forge card's stage off its shadow and splits `ideas` cards by their requirements", async () => {
    const FEEDBACK = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF";
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 42, title: "Promoted", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 43, title: "Written", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 44, title: "Fresh", body: "Make the **thing**   happen\n\nplease", labels: [], author: { login: "stjohnb" } },
           { number: NATIVE, title: "Native in Planning", body: "", labels: [], author: { login: "stjohnb" }, lifecycle: "planning" },
           { number: FEEDBACK, title: "Native with feedback", body: "", labels: [], author: { login: "stjohnb" }, lifecycle: "ideas" }]
        : []));
    mockClawsIssues.getOpenShadowStages.mockResolvedValueOnce(new Map([
      ["org/repo\u000042", { id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5S42", lifecycle: "planning" }],
      ["org/repo\u000043", { id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5S43", lifecycle: "ideas" }],
    ]));
    const latest = new Map([
      ["clw_01JBQ7X4M2K8NV3TYRW9GZ5S43", { version: 2, kind: "feature", title: "Written up", requirement: "The *thing* exists." }],
      [FEEDBACK, { version: 1, kind: "feature", title: "Asked again", requirement: "Again." }],
    ]);
    mockClawsIssues.getLatestRequirementsForOpenIssues.mockResolvedValueOnce(latest);
    // A human comment after FEEDBACK's v1: the writer owes v2.
    mockClawsIssues.getRequirementsFeedbackPending.mockResolvedValueOnce(new Set([FEEDBACK]));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(mockClawsIssues.getRequirementsFeedbackPending).toHaveBeenCalledWith(latest);
    expect(res.body).toContain(`data-ref="42" data-column="planning"`);
    expect(res.body).toContain(`data-ref="43" data-column="requirements-review"`);
    expect(res.body).toContain(`data-ref="44" data-column="drafting"`);
    expect(res.body).toContain(`data-ref="${FEEDBACK}" data-column="drafting"`);
    expect(res.body).toContain(`data-ref="${NATIVE}" data-column="planning"`);
    // Scoped to each card's own markup: a page-wide `toContain` can't tell a
    // chip on the right card from one that leaked onto its neighbour, or from
    // one that should have been hidden outside Ideas altogether.
    const cardFor = (ref: string) => res.body.match(new RegExp(`<article[^>]*data-ref="${ref}"[^>]*>([\\s\\S]*?)</article>`))?.[1] ?? "";
    expect(cardFor("43")).toContain("requirements v2");
    expect(cardFor("44")).not.toContain("board-chip-req");
    expect(cardFor(FEEDBACK)).not.toContain("board-chip-req");
    expect(cardFor("42")).not.toContain("board-chip-req");
    expect(cardFor(NATIVE)).not.toContain("board-chip-req");
    // Requirements-column cards preview the idea: the record's Requirement part, else the body.
    expect(cardFor("43")).toContain(`<details class="preview-peek board-plan board-idea"><summary>Requirements v2 · feature — Written up</summary>`);
    expect(cardFor("43")).toContain("<em>thing</em> exists.");
    expect(cardFor("44")).toContain(`<summary>Idea</summary><div class="markdown"><p>Make the **thing** happen please</p></div>`);
    expect(cardFor("42")).not.toContain("board-idea");
    expect(cardFor(NATIVE)).not.toContain("board-idea");
  });

  it("GET /board still renders when the shadow-stage and requirements reads fail", async () => {
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 42, title: "Forge issue", body: "", labels: [], author: { login: "stjohnb" } }]
        : []));
    mockClawsIssues.getOpenShadowStages.mockRejectedValueOnce(new Error("db down"));
    mockClawsIssues.getLatestRequirementsForOpenIssues.mockRejectedValueOnce(new Error("db down"));

    const res = await request(server, "GET", "/board");

    // A failed shadow-stage read falls back to an empty map, so a forge card
    // with no lifecycle of its own lands in Drafting rather than 500ing the
    // whole board; a failed requirements read falls back to `null`, which
    // `requirementsVersion` reads as "don't render a chip" rather than
    // "no requirements yet".
    expect(res.status).toBe(200);
    expect(res.body).toContain(`data-ref="42" data-column="drafting"`);
    expect(res.body).not.toContain("requirements v");
    // No requirements map, so no feedback read either.
    expect(mockClawsIssues.getRequirementsFeedbackPending).not.toHaveBeenCalled();
  });

  it("GET /board places each repo's open issues in the column their stored state implies", async () => {
    const gh = await githubMock();
    const NATIVE_APPROVED = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE";
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 42, title: "Needs a plan", body: "", labels: [], author: { login: "stjohnb" } },
           // A retired label approves nothing; the shadow's approval does (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F).
           { number: 43, title: "Approved thing", body: "", labels: [{ name: "Refined" }], author: { login: "stjohnb" } },
           { number: 44, title: "Plan to review", body: "", labels: [{ name: "Refined" }], author: { login: "stjohnb" } },
           { number: NATIVE_APPROVED, title: "Native approved", body: "", labels: [], author: { login: "stjohnb" }, lifecycle: "awaiting-plan-review", approvedThrough: "merge" }]
        : []));
    mockClawsIssues.getOpenShadowStages.mockResolvedValueOnce(new Map([
      ["org/repo\u000043", { id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDA", lifecycle: "awaiting-plan-review", approvedThrough: "plan", hasPlannedPrs: false }],
      ["org/repo\u000044", { id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDB", lifecycle: "awaiting-plan-review", approvedThrough: "requirements", hasPlannedPrs: false }],
    ]) as any);

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    // The column, not just the card: `data-ref` alone passes with `columnFor`
    // returning `drafting` for everything.
    expect(res.body).toContain(`data-ref="42" data-column="drafting"`);
    expect(res.body).toContain(`data-ref="43" data-column="approved"`);
    expect(res.body).toContain(`data-ref="44" data-column="awaiting-plan-review"`);
    expect(res.body).toContain(`data-ref="${NATIVE_APPROVED}" data-column="approved"`);
    expect(res.body).toContain("Approved thing");
    // The shadow's plan-review lifecycle is the forge card's has-a-plan hint.
    expect(res.body).toMatch(/data-ref="44"[^>]*data-has-plan="true"/);
    // The card's track reads the stored approval.
    const card = res.body.match(new RegExp(`<article class="board-card"[^>]*data-ref="${NATIVE_APPROVED}"[\\s\\S]*?</article>`))![0];
    expect(card).toContain(`data-gate="merge" data-state="preapproved"`);
    // Both halves of the Done bound are the caller's, not the query's: the
    // 8-hour window and the per-repo row cap are arguments, so nothing else
    // here would notice them widening.
    expect(mockClawsIssues.listClosedIssuesSince).toHaveBeenCalledWith("org/repo", expect.any(Date), 50);
    const since = mockClawsIssues.listClosedIssuesSince.mock.calls[0][1] as Date;
    expect(Math.abs(since.getTime() - (Date.now() - 8 * 60 * 60 * 1000))).toBeLessThan(5000);
  });

  // #clw_01M52GPG0E9DP8RQKW6ABH0X7R: nixos-config#33 sat in Awaiting plan review
  // with an Approve button and no plan while it waited for the importer.
  it("GET /board shows a forge issue awaiting import as waiting, with no plan gate", async () => {
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 33, title: "Deploy failure", body: "", labels: [{ name: "Ready" }], author: { login: "stjohnb" } }]
        : []));
    vi.mocked(gh.awaitingImportReason).mockImplementation((_repo, item) =>
      (typeof (item as { number: unknown }).number === "number" ? "awaiting import into the native tracker" : null));

    try {
      const res = await request(server, "GET", "/board");

      expect(res.status).toBe(200);
      expect(res.body).toContain(`data-ref="33" data-column="drafting"`);
      const card = res.body.match(/<article class="board-card"[^>]*data-ref="33"[\s\S]*?<\/article>/)![0];
      expect(card).toContain(`data-awaiting-import="true"`);
      expect(card).toContain(">Waiting for import</span>");
      expect(card).not.toContain("data-has-plan");
      expect(card).not.toContain("board-approve");
    } finally {
      vi.mocked(gh.awaitingImportReason).mockImplementation(() => null);
    }
  });

  // Native issues closed in the last 8 hours fill the Done column; the forge's
  // own closed issues deliberately do not.
  it("GET /board shows recently closed native issues and unassigned ones", async () => {
    mockClawsIssues.listClosedIssuesSince.mockImplementation(async (repo: string) =>
      (repo === "org/repo" ? [{ id: NATIVE, title: "Shipped", labels: [], repos: [repo], state: "closed" }] : []));
    mockClawsIssues.listUnassignedOpenIssues.mockResolvedValue([
      { id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD", title: "No repo yet", body: "", labels: [], repos: [] },
    ]);

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    // Columns again, not just the titles: a closed card belongs in Done and an
    // unassigned one in Drafting whatever its labels say. `unassigned` on its
    // own would match BOARD_CSS's `.board-repo-unassigned` rule on every render.
    expect(res.body).toContain(`data-ref="${NATIVE}" data-column="done"`);
    expect(res.body).toContain(`data-ref="clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD" data-column="drafting"`);
    expect(res.body).toContain("Shipped");
    expect(res.body).toContain("No repo yet");
  });

  // A dropped issue is told apart from a shipped one at a glance.
  it("GET /board carries a closed native card's recorded reason as a chip", async () => {
    mockClawsIssues.listClosedIssuesSince.mockImplementation(async (repo: string) =>
      (repo === "org/repo" ? [{ id: NATIVE, title: "Shipped", labels: [], repos: [repo], state: "closed", state_reason: "not_planned" }] : []));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(res.body).toContain(`<span class="board-chip-reason">Not planned</span>`);
  });

  it("GET /board puts the latest plan's Requirement on a native card", async () => {
    // In Planning: a card in Drafting or Requirements review previews the idea in the plan's place.
    const PLANNED = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo" ? [{ number: PLANNED, title: "Planned", body: "", labels: [], author: { login: "stjohnb" }, lifecycle: "planning" }] : []));
    mockClawsIssues.getLatestPlansForOpenIssues.mockResolvedValue(new Map([[PLANNED, {
      issue_id: PLANNED, version: 1, comment_id: null, created_at: "",
      body: "## Implementation Plan\n\n### Requirement\n\nCARD REQUIREMENT\n\n### Decisions\n\nD",
    }]]));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(res.body).toContain("Plan · 2 sections");
    expect(res.body).toContain("<p>CARD REQUIREMENT</p>");
    expect(res.body).toContain(`href="/issues/${PLANNED}#plan"`);
    expect(res.body).not.toContain("board-idea\"");
  });

  it("GET /board prefers the plan's What changes section over Requirement", async () => {
    const PLANNED = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo" ? [{ number: PLANNED, title: "Planned", body: "", labels: [], author: { login: "stjohnb" }, lifecycle: "planning" }] : []));
    mockClawsIssues.getLatestPlansForOpenIssues.mockResolvedValue(new Map([[PLANNED, {
      issue_id: PLANNED, version: 1, comment_id: null, created_at: "",
      body: "## Implementation Plan\n\n### What changes\n\nCARD ACTION\n\n### Requirement\n\nCARD REQUIREMENT",
    }]]));

    const res = await request(server, "GET", "/board");

    expect(res.body).toContain("<p>CARD ACTION</p>");
    expect(res.body).not.toContain("<p>CARD REQUIREMENT</p>");
  });

  it("GET /board still renders when the plan read fails", async () => {
    mockClawsIssues.getLatestPlansForOpenIssues.mockRejectedValue(new Error("db down"));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(res.body).not.toContain(`<details class="preview-peek board-plan">`);
  });

  // The query's limit is per repository, so without a second cut the column's
  // real ceiling would be 50 × however many repositories Claws manages, while
  // the 8-hour window it is paired with is global.
  it("GET /board bounds the Done column across every repository, newest first", async () => {
    const closedId = (n: number) => `clw_01JBQ7X4M2K8NV3TYRW9GZ5P${String(n).padStart(2, "0")}`;
    mockClawsIssues.listClosedIssuesSince.mockImplementation(async (repo: string) => {
      const offset = repo === "org/repo" ? 0 : 30;
      // Newest first, as the SQL hands them over.
      return Array.from({ length: 30 }, (_, i) => offset + (29 - i)).map((n) => ({
        id: closedId(n),
        title: `Closed ${n}`,
        labels: [],
        repos: [repo],
        state: "closed",
        closed_at: `2026-09-20 10:${String(n).padStart(2, "0")}:00`,
      }));
    });

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(res.body).toContain(`data-count="done">50<`);
    expect(res.body).toContain(closedId(59));
    expect(res.body).toContain(closedId(10));
    // The ten oldest fall off, whichever repository they came from.
    expect(res.body).not.toContain(closedId(9));
  });

  // The global cut runs before buildBoardPage filters, so applying `?repo=`
  // only there would show a filtered board whatever few of that repository's
  // cards survived a top 50 spread over every other one — here, none at all.
  it("GET /board applies ?repo= to the Done column before the global cut", async () => {
    const closedId = (n: number) => `clw_01JBQ7X4M2K8NV3TYRW9GZ5P${String(n).padStart(2, "0")}`;
    mockClawsIssues.listClosedIssuesSince.mockImplementation(async (repo: string) => {
      // test/repo's are all newer, so an unfiltered top 50 holds none of
      // org/repo's.
      const offset = repo === "org/repo" ? 0 : 50;
      return Array.from({ length: 50 }, (_, i) => offset + (49 - i)).map((n) => ({
        id: closedId(n),
        title: `Closed ${n}`,
        labels: [],
        repos: [repo],
        state: "closed",
        closed_at: `2026-09-20 10:${String(n).padStart(2, "0")}:00`,
      }));
    });

    const res = await request(server, "GET", "/board?repo=org%2Frepo");

    expect(res.status).toBe(200);
    expect(res.body).toContain(`data-count="done">50<`);
    expect(res.body).toContain(closedId(49));
    expect(res.body).toContain(closedId(0));
    expect(res.body).not.toContain(closedId(50));
  });

  // A repo whose issues cannot be fetched renders no cards, which is a short
  // board rather than an error — say so rather than letting it read as an empty
  // backlog.
  it("GET /board reports a repository whose issues could not be fetched", async () => {
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) => {
      if (repo === "org/repo") throw new Error("rate limited");
      return [];
    });

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(res.body).toContain("some cards are missing");
  });

  // A repo past the open-issue page limit drops cards from every column but
  // Done, which is the same silence as a failed fetch — the warning counts it
  // rather than letting a truncated backlog read as a complete one.
  // The unassigned list is the one source whose key is not a repository name,
  // so it cannot be deduped against the two per-repo reads. It must still leave
  // a 200 board rather than throwing out of the route.
  it("GET /board reports the unassigned list when it could not be read", async () => {
    mockClawsIssues.listUnassignedOpenIssues.mockRejectedValue(new Error("database is locked"));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(res.body).toContain("1 of the board's sources loaded incompletely");
  });

  // The warning is about the board being rendered. Counting repositories the
  // `?repo=` filter drops would bury the one source that matters in a larger
  // number and warn about missing cards on a board that was never going to
  // show them.
  it("GET /board counts only the filtered repository's sources as incomplete", async () => {
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) => {
      if (repo === "test/repo") throw new Error("rate limited");
      return [];
    });

    const filtered = await request(server, "GET", "/board?repo=org%2Frepo");
    expect(filtered.status).toBe(200);
    expect(filtered.body).not.toContain("sources loaded incompletely");

    const unfiltered = await request(server, "GET", "/board");
    expect(unfiltered.body).toContain("1 of the board's sources loaded incompletely");
  });

  // ── Backlog (#3293) ──

  it("GET /board leaves backlog issues off the board", async () => {
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 42, title: "In play", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 43, title: "Some day", body: "", labels: [{ name: "Backlog" }], author: { login: "stjohnb" } }]
        : [{ number: 7, title: "Elsewhere later", body: "", labels: [{ name: "Backlog" }], author: { login: "stjohnb" } }]));

    const res = await request(server, "GET", "/board");
    expect(res.status).toBe(200);
    expect(res.body).toContain(`data-ref="42" data-column="drafting"`);
    expect(res.body).not.toContain("Some day");
    expect(res.body).not.toContain("board-backlog-link");
    // The collapsed tray counts them, under the `?repo=` filter.
    expect(res.body).toContain(`data-count="backlog">2</span>`);
    const filtered = await request(server, "GET", "/board?repo=org/repo");
    expect(filtered.body).toContain(`data-count="backlog">1</span>`);
  });

  it("GET /backlog lists backlog forge and native issues, honouring ?repo=", async () => {
    const gh = await githubMock();
    const clwBacklog = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE";
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 42, title: "In play", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 43, title: "Forge some day", body: "", labels: [{ name: "Backlog" }], author: { login: "stjohnb" }, updatedAt: "2026-09-20T10:00:00Z", createdAt: "2026-09-01T10:00:00Z" },
           // A native issue reads its lifecycle as the Backlog label.
           { number: clwBacklog, title: "Native some day", body: "", labels: [{ name: "Backlog" }], author: { login: "stjohnb" }, updatedAt: "2026-09-21T10:00:00Z", createdAt: "2026-08-01T10:00:00Z" }]
        : [{ number: 7, title: "Elsewhere later", body: "", labels: [{ name: "Backlog" }], author: { login: "stjohnb" }, updatedAt: "2026-09-20T20:00:00Z" }]));

    const res = await request(server, "GET", "/backlog");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Forge some day");
    expect(res.body).toContain("Native some day");
    expect(res.body).toContain("Elsewhere later");
    expect(res.body).not.toContain("In play");
    // Newest updated first, repositories interleaved.
    const at = (t: string) => res.body.indexOf(`>${t}</a>`);
    expect(at("Native some day")).toBeLessThan(at("Elsewhere later"));
    expect(at("Elsewhere later")).toBeLessThan(at("Forge some day"));
    expect(res.body).toContain('data-label="Created" title="2026-09-01T10:00:00Z"');

    const byCreated = await request(server, "GET", "/backlog?sort=created&dir=asc");
    const cat = (t: string) => byCreated.body.indexOf(`>${t}</a>`);
    expect(cat("Native some day")).toBeLessThan(cat("Forge some day"));
    expect(cat("Forge some day")).toBeLessThan(cat("Elsewhere later"));
    expect(res.body).toContain(`name="only" value="org/repo#43"`);

    const filtered = await request(server, "GET", "/backlog?repo=org%2Frepo");
    expect(filtered.body).toContain("Forge some day");
    expect(filtered.body).not.toContain("Elsewhere later");
  });

  it("POST /backlog/promote takes one issue out of the backlog and returns to the view it was promoted from", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Backlog"] });

    const res = await request(server, "POST", "/backlog/promote", {
      body: "return_to=%2Fbacklog%3Fsort%3Dcreated%26dir%3Dasc&item=org%2Frepo%2342&item=org%2Frepo%2343&only=org%2Frepo%2342",
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/backlog?sort=created&dir=asc");
    // `only` wins over the ticked items: the row's own button was pressed.
    expect(gh.removeLabel).toHaveBeenCalledTimes(1);
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Backlog");
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("POST /backlog/promote ignores a return_to outside the backlog", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Backlog"] });
    const res = await request(server, "POST", "/backlog/promote", { body: "return_to=%2F%2Fevil.example&only=org%2Frepo%2342" });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/backlog");
  });

  it("POST /backlog/promote sends a native issue to Ideas, and lists failures", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: ["Backlog"], lifecycle: "backlog" });
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Backlog"] });

    const res = await request(server, "POST", "/backlog/promote", {
      body: `item=${encodeURIComponent(`org/repo#${NATIVE}`)}&item=${encodeURIComponent("not/managed#5")}`,
    });

    // No plan and no approved requirements: Ideas, but an entry move — a
    // plain lifecycle write, not the demotion, so auto-promote survives it.
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "ideas");
    expect(mockClawsIssues.demoteIssue).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(res.body).toContain("1 of 2 promoted");
    expect(res.body).toContain("not/managed#5: Repository not configured");
  });

  it("POST /backlog/promote sends a native issue with a plan straight to Planning", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: ["Backlog"], lifecycle: "backlog", requirements_approved_at: null });
    mockClawsIssues.listPlans.mockResolvedValueOnce([{ version: 1, commentId: null, body: "plan", createdAt: "" }]);
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Backlog"] });

    const res = await request(server, "POST", "/backlog/promote", { body: `only=${encodeURIComponent(`org/repo#${NATIVE}`)}` });

    expect(res.status).toBe(303);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "planning");
    expect(mockClawsIssues.demoteIssue).not.toHaveBeenCalled();
  });

  it("POST /backlog/promote with nothing ticked is a 400", async () => {
    const res = await request(server, "POST", "/backlog/promote", { body: "return_to=%2Fbacklog" });
    expect(res.status).toBe(400);
  });

  it("POST /board/move to backlog relabels a forge issue, removing the state labels it holds", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked", "bug"] });

    const res = await move({ repo: "org/repo", ref: 42, to: "backlog" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "ok", column: "backlog" });
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Backlog");
    expect(gh.removeLabel).toHaveBeenCalledTimes(1);
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Blocked");
  });

  it("POST /board/move closes a native issue whose repos are no longer configured, and refuses any other move", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/gone"], labels: [], lifecycle: "planning" });
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });

    const closed = await move({ repo: "org/gone", ref: NATIVE, to: "done" });
    expect(closed.status).toBe(200);
    expect(gh.closeIssue).toHaveBeenCalledWith("org/gone", NATIVE, "not_planned");

    const approved = await move({ repo: "org/gone", ref: NATIVE, to: "approved" });
    expect(approved.status).toBe(403);

    // A forge ref in an unconfigured repo is never relaxed.
    const forge = await move({ repo: "org/gone", ref: 42, to: "done" });
    expect(forge.status).toBe(403);
  });

  it("POST /board/move to backlog sets a native issue's lifecycle", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "awaiting-plan-review", approved_through: "plan" });
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "backlog" });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "backlog");
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move answers 500 partial when the return date write fails after the move", async () => {
    const gh = await githubMock();
    const { setClawsIssueBacklogUntil } = await import("./db.js");
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "awaiting-plan-review", approved_through: "plan" });
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    vi.mocked(setClawsIssueBacklogUntil).mockResolvedValueOnce(false);

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "backlog", until: "2999-01-01" });

    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "backlog");
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).partial).toBe(true);
  });

  // A drop into Planning is the promotion that approves a pending design
  // change; it lands where the approval leaves it, not with the landsIn 409.
  it("POST /board/move to planning approves a pending design change and reports where it landed", async () => {
    const gh = await githubMock();
    mockReapproval.hasPendingReapproval.mockResolvedValue(true);
    try {
      // The approval re-approves the plan, which the re-read sees.
      mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "awaiting-plan-review", approved_through: "plan" });
      vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });

      const res = await move({ repo: "org/repo", ref: NATIVE, to: "planning" });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ result: "ok", column: "approved", track: expect.stringContaining(`class="approval-track"`) });
      expect(mockReapproval.promoteReapproval).toHaveBeenCalledWith(NATIVE, "test-user");
      expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
    } finally {
      mockReapproval.hasPendingReapproval.mockResolvedValue(false);
    }
  });

  // Backlog outranks the flight in `columnFor`, so without the explicit refusal
  // the landing check would let work in flight off the board.
  it("POST /board/move to backlog is a 409 for an issue whose PR is open", async () => {
    const gh = await githubMock();
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow()] });

    const res = await move({ repo: "org/repo", ref: 42, to: "backlog" });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe(DERIVED_COLUMN_REJECTION);
    expect(mockIssueFlight.loadIssueFlight).toHaveBeenCalledWith("org/repo", 42);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  it("POST /board/bulk-move answers each item's own outcome, in order", async () => {
    const gh = await githubMock();
    mockIssueFlight.loadIssueFlight.mockImplementation(async (_repo: string, ref: unknown) =>
      ({ implementing: ref === 43, openPrs: [] }));

    const res = await request(server, "POST", "/board/bulk-move", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "backlog", items: [
        { repo: "org/repo", ref: 42 },
        { repo: "org/repo", ref: 43 },
        { repo: "not/managed", ref: 44 },
      ] }),
    });

    expect(res.status).toBe(200);
    const { results } = JSON.parse(res.body);
    expect(results.map((r: { ref: number; status: number }) => [r.ref, r.status])).toEqual([[42, 200], [43, 409], [44, 403]]);
    expect(results[0].column).toBe("backlog");
    expect(gh.addLabel).toHaveBeenCalledTimes(1);
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Backlog");
  });

  it("POST /board/bulk-move rejects a destination other than backlog or ideas", async () => {
    const res = await request(server, "POST", "/board/bulk-move", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "done", items: [{ repo: "org/repo", ref: 42 }] }),
    });
    expect(res.status).toBe(400);
  });

  // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F: Approved is the plan-review lifecycle with
  // the issue approved through Plan; a forge issue holds both on its shadow.
  it("POST /board/move to approved writes the Plan approval, then the plan-review lifecycle, with no label", async () => {
    await withPlan();
    withShadow();
    const gh = await githubMock();

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(200);
    // The column the issue is in now, computed rather than assumed.
    expect(JSON.parse(res.body)).toEqual({ result: "ok", column: "approved", track: expect.stringContaining(`class="approval-track"`) });
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", 42, "plan", "test-user");
    expect(mockClawsIssues.setShadowLifecycle).toHaveBeenCalledWith(FORGE_SHADOW, "awaiting-plan-review");
    expect(mockIssueApproval.applyIssueApproval.mock.invocationCallOrder[0]).toBeLessThan(mockClawsIssues.setShadowLifecycle.mock.invocationCallOrder[0]);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move to approved never lowers a Merge approval, and to awaiting-plan-review lowers it to Requirements", async () => {
    await withPlan();
    withShadow({ approved_through: "merge" });
    expect((await move({ repo: "org/repo", ref: 42, to: "approved" })).status).toBe(200);
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    expect(mockClawsIssues.setShadowLifecycle).toHaveBeenCalledWith(FORGE_SHADOW, "awaiting-plan-review");

    withShadow({ lifecycle: "awaiting-plan-review", approved_through: "plan" });
    const back = await move({ repo: "org/repo", ref: 42, to: "awaiting-plan-review" });
    expect(back.status).toBe(200);
    expect(JSON.parse(back.body).column).toBe("awaiting-plan-review");
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", 42, "requirements", "test-user");
  });

  it("POST /board/move to approved writes nothing for an issue already there", async () => {
    await withPlan();
    withShadow({ lifecycle: "awaiting-plan-review", approved_through: "plan" });
    const gh = await githubMock();

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(200);
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    expect(mockClawsIssues.setShadowLifecycle).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
    // Nothing was written, so this is not a half-applied move to reload over.
    expect(JSON.parse(res.body).partial).toBeUndefined();
  });

  it("POST /board/move answers 500 partial when the approval write fails", async () => {
    await withPlan();
    withShadow();
    mockIssueApproval.applyIssueApproval.mockResolvedValueOnce({ ok: false, status: 500, error: "database is locked" });

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ partial: true, error: expect.stringContaining("database is locked") });
    expect(mockClawsIssues.setShadowLifecycle).not.toHaveBeenCalled();
  });

  // No move touches the PR, and an open PR outranks the stored approval in
  // `columnFor`, so the card would stay in In progress.
  it("POST /board/move out of In progress to approved is a 409 that writes nothing", async () => {
    await withPlan();
    withShadow();
    const gh = await githubMock();
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow()] });

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe(DERIVED_COLUMN_REJECTION);
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  // A running implementer outranks the approval too.
  it("POST /board/move to approved is a 409 while the implementer runs", async () => {
    await withPlan();
    withShadow();
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: true, openPrs: [] });

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe(DERIVED_COLUMN_REJECTION);
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
  });

  // The other side of the same rule: the plan-review lifecycle does not
  // outrank an open PR, so the issue would stay in Awaiting merge — a 409
  // rather than a column the card never reached. The reason is
  // DERIVED_COLUMN_REJECTION, which says what to do about it: merge or close the PR.
  it("POST /board/move out of Awaiting merge to awaiting-plan-review is a 409 that writes nothing", async () => {
    await withPlan();
    withShadow({ approved_through: "plan" });
    const gh = await githubMock();
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow({ stage: "awaiting-merge" })] });

    const res = await move({ repo: "org/repo", ref: 42, to: "awaiting-plan-review" });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe(DERIVED_COLUMN_REJECTION);
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    expect(mockClawsIssues.setShadowLifecycle).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  // removeLabel returns false when the label is not confirmed absent — still
  // there, or unverifiable after a failed removal — so the issue may have kept
  // a label that outranks the one just added. Either way the move is half
  // applied and only a reload can say which column the issue is in.
  it("POST /board/move answers 500 when a label removal fails", async () => {
    await withPlan();
    const gh = await githubMock();
    // A label the issue really holds: the route only removes those, so a starting
    // set without one would remove nothing and pass this trivially.
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    vi.mocked(gh.removeLabel).mockResolvedValue(false);

    const res = await move({ repo: "org/repo", ref: 42, to: "backlog" });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toContain("Failed to remove");
    // The marker the client reverts on the absence of: only this route writes
    // it, so a framework or proxy 500 on the same URL cannot be mistaken for a
    // half-applied move.
    expect(JSON.parse(res.body).partial).toBe(true);
    expect(JSON.parse(res.body).error).toContain("stale");
    // The target's label goes on first, so a failed removal leaves the
    // outranking old label in place rather than no lifecycle label at all.
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Backlog");
  });

  // The flag the catch reads means a write was *issued*, not that one returned:
  // a `gh` failure can surface after the edit took server-side, so a throw out
  // of the first write is still a move that may be half applied. 503 would tell
  // the client "nothing changed" and revert a card whose label is really on.
  it("POST /board/move answers 500 when the first write throws", async () => {
    await withPlan();
    const gh = await githubMock();
    vi.mocked(gh.addLabel).mockRejectedValueOnce(new Error("gh: HTTP 502"));

    const res = await move({ repo: "org/repo", ref: 42, to: "backlog" });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toContain("502");
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  // The other half of the same rule: a throw from *before* the write block —
  // here the record read that decides whether the issue is assigned — wrote
  // nothing, so the card snaps back rather than being stranded.
  it("POST /board/move answers 503 when a read before the first write throws", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockRejectedValue(new Error("database is locked"));

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "approved" });

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toContain("database is locked");
    // Nothing was written, so the card goes back where it came from.
    expect(JSON.parse(res.body).partial).toBe(false);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  // The one live half-applied move: the reopen landed, so a later throw leaves
  // the issue reopened and out of Done, holding none of the destination's
  // labels — only a reload can say which column that is, which is what
  // `partial: true` tells the client.
  it("POST /board/move answers 500 when a label write throws after a reopen landed", async () => {
    await withPlan();
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "CLOSED", stateReason: "completed", labels: [] });
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "closed", repos: ["org/repo"], labels: [], lifecycle: "ideas" });
    mockClawsIssues.setLifecycle.mockRejectedValueOnce(new Error("database is locked"));

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "approved" });

    expect(mockClawsIssues.reopenIssue).toHaveBeenCalledWith(NATIVE);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).partial).toBe(true);
  });

  // `removeLabel` throwing never reaches the catch — the removals are settled
  // rather than awaited as a `Promise.all`, so a rejection is an outcome the
  // route reports itself. Under `Promise.all` the first rejection short-
  // circuited the await while its siblings kept running and removing labels, so
  // the outcome that decided the answer was the one thrown away.
  it("POST /board/move answers 500 when one of several removals throws and another lands", async () => {
    const gh = await githubMock();
    // Every label the board owns, so both removals are really issued — the
    // route removes only what the issue holds, and a starting set without them
    // would remove nothing and never reach the failure this is about.
    vi.mocked(gh.getIssueState).mockResolvedValue({
      state: "OPEN",
      stateReason: null,
      labels: ["Blocked", "Backlog"],
    });
    const seen: string[] = [];
    vi.mocked(gh.removeLabel).mockImplementation(async (_repo, _ref, label) => {
      if (label === "Blocked") throw new Error("gh: HTTP 502");
      seen.push(label);
      return true;
    });
    mockResolveTrackerId.mockResolvedValueOnce("clw_01JBQ7X4M2K8NV3TYRW9GZ5SHD");

    const res = await move({ repo: "org/repo", ref: 42, to: "drafting" });

    expect(res.status).toBe(500);
    // Named from what was actually handed to the removals, not from `move.remove`
    // — indexing that superset would name a label the route never tried.
    expect(JSON.parse(res.body).error).toContain("Failed to remove the Blocked label");
    // The siblings were never cancelled: their removals landed, which is why
    // this cannot be reported as "nothing changed".
    expect(seen).toEqual(["Backlog"]);
  });

  // The derived columns follow the issue's running implementer and open PR, so
  // none is a destination.
  it.each(["in-progress", "awaiting-merge"])("POST /board/move into %s is refused with 409 and changes nothing", async (to) => {
    const gh = await githubMock();

    const res = await move({ repo: "org/repo", ref: 42, to });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe(DERIVED_COLUMN_REJECTION);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
    expect(gh.closeIssue).not.toHaveBeenCalled();
  });

  // The columns it replaced no longer exist.
  it("POST /board/move into a removed column is an unknown column", async () => {
    const res = await move({ repo: "org/repo", ref: 42, to: "pr-progressing" });

    expect(res.status).toBe(400);
  });

  it("POST /board/move to done closes the issue as not planned and reports the reason", async () => {
    const gh = await githubMock();

    const res = await move({ repo: "org/repo", ref: 42, to: "done" });

    expect(res.status).toBe(200);
    expect(gh.closeIssue).toHaveBeenCalledWith("org/repo", 42, "not_planned");
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).stateReason).toBe("not_planned");
  });

  it("POST /board/move out of done reopens a closed native issue", async () => {
    await withPlan();
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "CLOSED", stateReason: "completed", labels: [] });
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "closed", repos: ["org/repo"], labels: [], lifecycle: "ideas" });

    const res = await move({ repo: "org/repo", ref: NATIVE.toLowerCase(), to: "awaiting-plan-review" });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.reopenIssue).toHaveBeenCalledWith(NATIVE);
  });

  it("POST /board/move leaves an open issue alone rather than reopening it", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });

    // The status matters: without it a 403, 404 or 409 from any guard above the
    // reopen would satisfy the assertion below while the move stopped working.
    expect((await move({ repo: "org/repo", ref: NATIVE, to: "blocked", reason: "Waiting on the vendor" })).status).toBe(200);

    expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
  });

  // An unassigned native issue has no repository to check; a forge issue always does.
  it("POST /board/move accepts an empty repo only for a native ref", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: [], labels: ["Blocked"], lifecycle: "blocked" });
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });

    expect((await move({ repo: "", ref: NATIVE, to: "drafting" })).status).toBe(200);
    expect(mockClawsIssues.demoteIssue).toHaveBeenCalledWith(NATIVE);

    expect((await move({ repo: "", ref: 42, to: "drafting" })).status).toBe(403);
    expect((await move({ repo: "", ref: NATIVE, to: "ideas" })).status).toBe(400);
  });

  // An *assigned* native ref sent with no repo would skip both wire-side gates:
  // `isConfiguredRepo` and the record's own ownership check each fall through on
  // `""`. The route resolves the repository from the record instead, so the
  // write names it and the allowlist gate below still applies to it.
  it("POST /board/move takes an assigned native ref's repository from its record", async () => {
    await withPlan();
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });

    expect((await move({ repo: "", ref: NATIVE, to: "approved" })).status).toBe(200);
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user");
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");
  });

  // A native issue's lifecycle is one field, so the move is one write — no
  // add-then-remove label pair to leave half applied.
  it("POST /board/move sets a native issue's lifecycle in one write", async () => {
    await withPlan();
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning", approved_through: "requirements" });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "approved" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).column).toBe("approved");
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledTimes(1);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  // The plan rule (board-plan-rule.ts): Approved and Awaiting plan review need a
  // plan, whichever column the move starts from, and are refused before any write.
  it.each([
    ["approved", "ideas", "Approved needs a plan — move the issue to Planning first so Claws writes one."],
    ["approved", "planning", "Approved needs a plan — move the issue to Planning first so Claws writes one."],
    ["awaiting-plan-review", "ideas", "Awaiting plan review needs a plan — move the issue to Planning first so Claws writes one."],
    ["awaiting-plan-review", "planning", "Awaiting plan review needs a plan — move the issue to Planning first so Claws writes one."],
  ])("POST /board/move to %s refuses a planless native issue in %s with 409, writing nothing", async (to, lifecycle, reason) => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle, requirements_approved_at: null });

    const res = await move({ repo: "org/repo", ref: NATIVE, to });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: reason });
    expect(mockClawsIssues.listPlans).toHaveBeenCalledWith(NATIVE);
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  it.each(["approved", "awaiting-plan-review"])("POST /board/move to %s refuses a forge issue with no plan comment", async (to) => {
    const gh = await githubMock();
    withShadow();
    vi.mocked(gh.getIssueComments).mockResolvedValue([
      { id: 1, body: "Just a human comment.", login: "someone", created_at: "2026-09-21T09:00:00Z" } as never,
    ]);

    const res = await move({ repo: "org/repo", ref: 42, to });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/needs a plan/);
    expect(gh.getIssueComments).toHaveBeenCalledWith("org/repo", 42);
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move answers 503 when a forge issue's comments cannot be read", async () => {
    const gh = await githubMock();
    withShadow();
    vi.mocked(gh.getIssueComments).mockRejectedValue(new Error("gh: HTTP 502"));

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toContain("try again");
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move lets a forge issue with a plan comment reach Awaiting plan review, through its shadow", async () => {
    const gh = await githubMock();
    await withPlan();
    withShadow();

    const res = await move({ repo: "org/repo", ref: 42, to: "awaiting-plan-review" });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.setShadowLifecycle).toHaveBeenCalledWith(FORGE_SHADOW, "awaiting-plan-review");
    // Already approved through Requirements: nothing to lower.
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move refuses a forge issue with no shadow a plan-review column", async () => {
    await withPlan();
    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain("has not synced this issue yet");
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
  });

  // "Send back to Planning" on an issue with a plan is a re-plan: without one
  // queued, the dispatcher sees an unchanged plan and the card sits in Planning.
  it("POST /board/move into Planning re-plans a native issue that has a plan, through its primary repo", async () => {
    const gh = await githubMock();
    const worker = await import("./worker.js");
    await withPlan();
    mockClawsIssues.getIssue.mockResolvedValue({
      id: NATIVE, state: "open", repos: ["org/zz-other", "org/repo"], labels: [], lifecycle: "awaiting-plan-review", requirements_approved_at: "2026-09-21 09:00:00",
    });

    const res = await move({ repo: "", ref: NATIVE, to: "planning" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).column).toBe("planning");
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "planning");
    expect(worker.enqueue).toHaveBeenCalledTimes(1);
    expect(worker.enqueue).toHaveBeenCalledWith(worker.AGENT_KINDS.ISSUE_REFINER_REPLAN, "org/repo", NATIVE, { priority: false });
  });

  // Unsticks a card already stranded in Planning with a plan and nothing running.
  it("POST /board/move into Planning re-plans a native issue already sitting there", async () => {
    const worker = await import("./worker.js");
    await withPlan();
    mockClawsIssues.getIssue.mockResolvedValue({
      id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning", requirements_approved_at: "2026-09-21 09:00:00",
    });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "planning" });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(worker.enqueue).toHaveBeenCalledWith(worker.AGENT_KINDS.ISSUE_REFINER_REPLAN, "org/repo", NATIVE, expect.anything());
  });

  it("POST /board/move into Planning re-plans a forge issue whose plan comment exists", async () => {
    const gh = await githubMock();
    const worker = await import("./worker.js");
    const SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHD";
    await withPlan();
    mockResolveTrackerId.mockResolvedValueOnce(SHADOW);
    mockClawsIssues.getIssue.mockResolvedValue({
      id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: [], lifecycle: "awaiting-plan-review", requirements_approved_at: "2026-09-21 09:00:00",
    });

    const res = await move({ repo: "org/repo", ref: 42, to: "planning" });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.setShadowLifecycle).toHaveBeenCalledWith(SHADOW, "planning");
    expect(gh.removeLabel).not.toHaveBeenCalled();
    expect(worker.enqueue).toHaveBeenCalledWith(worker.AGENT_KINDS.ISSUE_REFINER_REPLAN, "org/repo", 42, expect.anything());
  });

  it("POST /board/move into Planning queues no re-plan for a planless issue, and still promotes it", async () => {
    const worker = await import("./worker.js");
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "planning" });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "test-user", "ideas");
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F: Ship is gone — a Plan approval from the
  // track is the pre-approval now — so a stale client's flag changes nothing.
  it("POST /board/move ignores the retired ship flag, writing no label and no approval", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas", requirements_approved_at: null });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "planning", ship: true });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "test-user", "ideas");
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
    expect(gh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("POST /board/move into Planning queues no re-plan while the planner is disabled", async () => {
    const worker = await import("./worker.js");
    const cfg = await import("./config.js");
    await withPlan();
    vi.mocked(cfg.isAgentDisabled).mockImplementation((name: string) => name === "planner");
    mockClawsIssues.getIssue.mockResolvedValue({
      id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "awaiting-plan-review", requirements_approved_at: "2026-09-21 09:00:00",
    });

    try {
      const res = await move({ repo: "org/repo", ref: NATIVE, to: "planning" });
      expect(res.status).toBe(200);
      expect(worker.enqueue).not.toHaveBeenCalled();
    } finally {
      vi.mocked(cfg.isAgentDisabled).mockImplementation(() => false);
    }
  });

  // Promote out of the backlog is an entry move: `entryLifecycle` lands it,
  // and it is never a re-plan even when the issue has a plan.
  it("POST /board/bulk-move to ideas lands a planned issue in Planning without a re-plan", async () => {
    const worker = await import("./worker.js");
    await withPlan();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: ["Backlog"], lifecycle: "backlog", requirements_approved_at: "2026-09-21 09:00:00" });

    const res = await request(server, "POST", "/board/bulk-move", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "ideas", items: [{ repo: "org/repo", ref: NATIVE }] }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).results[0]).toMatchObject({ status: 200, column: "planning" });
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  // Moves the plan rule does not touch: planless issues still reach them.
  it.each(["drafting", "requirements-review", "blocked", "backlog", "done"])("POST /board/move to %s needs no plan, and the move reads none", async (to) => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning" });

    const res = await move({ repo: "org/repo", ref: NATIVE, to, ...(to === "blocked" ? { reason: "Waiting on the vendor" } : {}) });

    expect(res.status).toBe(200);
    // The move itself reads no plan; a landed move re-reads one for the
    // track it answers with, which Backlog and Done cards do not show.
    const tracked = to !== "backlog" && to !== "done";
    expect(mockClawsIssues.listPlans).toHaveBeenCalledTimes(tracked ? 1 : 0);
    expect(gh.getIssueComments).not.toHaveBeenCalled();
    expect("track" in JSON.parse(res.body)).toBe(tracked);
  });

  // Every issue entering Blocked carries a reason.
  it.each([
    ["no reason", {}],
    ["a blank reason", { reason: "  \n " }],
  ])("POST /board/move to blocked with %s is refused before anything reads or writes", async (_name, extra) => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning" });

    for (const ref of [NATIVE, 42]) {
      const res = await move({ repo: "org/repo", ref, to: "blocked", ...extra });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "A reason is required to mark an issue Blocked." });
    }
    expect(mockClawsIssues.getIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.blockIssue).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move to blocked records the trimmed reason with a native move", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning" });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "blocked", reason: "  Waiting on the vendor " });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.blockIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Waiting on the vendor");
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  it("POST /board/move to blocked labels a forge issue and records the reason on its shadow", async () => {
    const gh = await githubMock();
    const { setIssueBlockedReason } = await import("./db.js");
    const SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHD";
    mockResolveTrackerId.mockResolvedValue(SHADOW);
    mockClawsIssues.getIssue.mockResolvedValue({ id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning" });

    const res = await move({ repo: "org/repo", ref: 42, to: "blocked", reason: "Waiting on the vendor" });

    expect(res.status).toBe(200);
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Blocked");
    expect(mockClawsIssues.setShadowLifecycle).toHaveBeenCalledWith(SHADOW, "blocked");
    expect(setIssueBlockedReason).toHaveBeenCalledWith(SHADOW, "Waiting on the vendor");
  });

  it("POST /board/move to blocked refuses a forge issue with no shadow to hold the reason, writing nothing", async () => {
    const gh = await githubMock();
    const { setIssueBlockedReason } = await import("./db.js");

    const res = await move({ repo: "org/repo", ref: 42, to: "blocked", reason: "Waiting on the vendor" });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain("has not synced this issue yet");
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(setIssueBlockedReason).not.toHaveBeenCalled();
  });

  // Ideas and Planning share their (empty) labels: the drop between them is the
  // promotion (docs/refinements/issue-flow.md "Promotion"), and the drop back
  // is the demotion.
  it("POST /board/move from a requirements column into Planning promotes as the signed-in operator, and back demotes", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });

    const promoted = await move({ repo: "org/repo", ref: NATIVE, to: "planning" });
    expect(promoted.status).toBe(200);
    expect(JSON.parse(promoted.body).column).toBe("planning");
    // The approver is the session's OIDC subject; the expected lifecycle is
    // the one the route just read.
    expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "test-user", "ideas");
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();

    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning" });
    // A drop on either requirements column is the demotion; the requirements
    // state picks the column it lands in, and either one counts as landed.
    const demoted = await move({ repo: "org/repo", ref: NATIVE, to: "requirements-review" });
    expect(demoted.status).toBe(200);
    expect(JSON.parse(demoted.body).column).toBe("drafting");
    expect(mockClawsIssues.demoteIssue).toHaveBeenCalledWith(NATIVE);
    expect(mockClawsIssues.isAwaitingRequirementsReview).toHaveBeenCalledWith(NATIVE);

    mockClawsIssues.isAwaitingRequirementsReview.mockResolvedValueOnce(true);
    const reviewed = await move({ repo: "org/repo", ref: NATIVE, to: "drafting" });
    expect(reviewed.status).toBe(200);
    expect(JSON.parse(reviewed.body).column).toBe("requirements-review");
  });

  it("POST /board/move promotes a forge issue through its shadow, and 409s one with no shadow yet", async () => {
    const gh = await githubMock();
    const SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHD";
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    mockResolveTrackerId.mockResolvedValueOnce(SHADOW);
    mockClawsIssues.getIssue.mockResolvedValue({ id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });

    const res = await move({ repo: "org/repo", ref: 42, to: "planning" });
    expect(res.status).toBe(200);
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Blocked");
    expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(SHADOW, "test-user", "ideas");

    const unsynced = await move({ repo: "org/repo", ref: 43, to: "planning" });
    expect(unsynced.status).toBe(409);
    // The refusal must run before any write: nothing about issue 43 changed.
    expect(gh.removeLabel).not.toHaveBeenCalledWith("org/repo", 43, expect.anything());
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  // Blocked (or Approved, Awaiting plan review) is not Ideas, but an unapproved
  // issue dragged from there into Planning is still the promotion — decided on
  // approval state, not on the column the issue came from (83531a51).
  it("POST /board/move promotes into Planning from Blocked, not only from Ideas, expecting the lifecycle it read", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    mockClawsIssues.getIssue.mockResolvedValue({
      id: NATIVE, state: "open", repos: ["org/repo"], labels: ["Blocked"], lifecycle: "blocked", requirements_approved_at: null,
    });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "planning" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).column).toBe("planning");
    expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "test-user", "blocked");
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  it("POST /board/move promotes a shadow into Planning from Blocked, expecting the lifecycle it read", async () => {
    const gh = await githubMock();
    const SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHD";
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    mockResolveTrackerId.mockResolvedValueOnce(SHADOW);
    mockClawsIssues.getIssue.mockResolvedValue({
      id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: ["Blocked"], lifecycle: "blocked", requirements_approved_at: null,
    });

    const res = await move({ repo: "org/repo", ref: 42, to: "planning" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).column).toBe("planning");
    expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(SHADOW, "test-user", "blocked");
  });

  // A promotion is a compare-and-swap on the lifecycle the route read: a
  // `false` means the issue changed underneath it, so the move must not be
  // reported as having landed.
  it("POST /board/move answers 500 with partial:true when the promotion loses its race", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });
    mockClawsIssues.promoteIssue.mockResolvedValueOnce(false);

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "planning" });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).partial).toBe(true);
    expect(JSON.parse(res.body).column).toBeUndefined();
  });

  // The shadow branch's compare-and-swap (src/server.ts:3504-3505) runs after
  // the label write, so a lost race there must still report partial:true —
  // the label already landed even though the lifecycle write did not.
  it("POST /board/move answers 500 with partial:true when a shadow promotion loses its race", async () => {
    const gh = await githubMock();
    const SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHD";
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    mockResolveTrackerId.mockResolvedValueOnce(SHADOW);
    mockClawsIssues.getIssue.mockResolvedValue({ id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });
    mockClawsIssues.promoteIssue.mockResolvedValueOnce(false);

    const res = await move({ repo: "org/repo", ref: 42, to: "planning" });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).partial).toBe(true);
    expect(JSON.parse(res.body).column).toBeUndefined();
    // The label write had already landed by the time the lifecycle CAS lost.
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Blocked");
  });

  // The guard that stops a second promotion from overwriting the first
  // approver: dropping a forge card into the stage its shadow is already in
  // must not re-run `promoteIssue`/`demoteIssue` at all.
  it("POST /board/move is a no-op promotion when a forge card is dropped into its shadow's own stage", async () => {
    const gh = await githubMock();
    const SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHD";
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    mockResolveTrackerId.mockResolvedValue(SHADOW);

    mockClawsIssues.getIssue.mockResolvedValue({ id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning" });
    const already = await move({ repo: "org/repo", ref: 42, to: "planning" });
    expect(already.status).toBe(200);
    expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();

    mockClawsIssues.getIssue.mockResolvedValue({ id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });
    const still = await move({ repo: "org/repo", ref: 42, to: "drafting" });
    expect(still.status).toBe(200);
    expect(mockClawsIssues.demoteIssue).not.toHaveBeenCalled();
  });

  // A re-plan dropped into Planning from a later column (an existing
  // approval already on record) must not re-approve the latest version.
  it("POST /board/move plain-writes into Planning when the shadow already has a recorded approval", async () => {
    const gh = await githubMock();
    const SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHD";
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    mockResolveTrackerId.mockResolvedValue(SHADOW);
    mockClawsIssues.getIssue.mockResolvedValue({
      id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: ["Blocked"], lifecycle: "blocked",
      requirements_approved_at: "2026-09-01T00:00:00Z",
    });

    const res = await move({ repo: "org/repo", ref: 42, to: "planning" });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.setShadowLifecycle).toHaveBeenCalledWith(SHADOW, "planning");
    expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
  });

  // The native counterpart: a re-plan dropped into Planning from a later
  // column (an existing approval already on record) must not re-approve the
  // latest version either.
  it("POST /board/move plain-writes a native issue into Planning when it already has a recorded approval", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    mockClawsIssues.getIssue.mockResolvedValue({
      id: NATIVE, state: "open", repos: ["org/repo"], labels: ["Blocked"], lifecycle: "blocked",
      requirements_approved_at: "2026-09-01T00:00:00Z",
    });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "planning" });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "planning");
    expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
  });

  // The hole that resolution closes: `repo: ""` on an assigned native ref is the
  // one way past `isConfiguredRepo`, and every other dashboard mutation route
  // gates on it. The record's repository goes back through the allowlist.
  it("POST /board/move refuses a native ref whose repository is not configured", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["other/unmanaged"], labels: [] });

    const res = await move({ repo: "", ref: NATIVE, to: "approved" });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain("is configured in Claws any more");
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  // A multi-repo issue is an ordinary card: its primary repo — the
  // alphabetically first — owns its lifecycle writes.
  it("POST /board/move moves a two-repo native issue through its primary repo", async () => {
    await withPlan();
    await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/zz-other", "org/repo"], labels: [], lifecycle: "ideas" });

    const res = await move({ repo: "", ref: NATIVE, to: "approved" });

    expect(res.status).toBe(200);
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user");
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "awaiting-plan-review");
  });

  // columnFor parks an unassigned native issue in Ideas whatever its labels
  // say, so a move that only relabels it would answer `ok` for a column the
  // card can never be in.
  it("POST /board/move refuses to move an unassigned native issue out of Drafting", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: [], labels: [] });

    const res = await move({ repo: "", ref: NATIVE, to: "blocked", reason: "Waiting on the vendor" });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe("Assign this issue to a repository before moving it out of Drafting.");
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  // Closing one is fine: Done is where an unassigned issue does belong.
  it("POST /board/move still closes an unassigned native issue", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: [], labels: [] });

    const res = await move({ repo: "", ref: NATIVE, to: "done" });

    expect(res.status).toBe(200);
    expect(gh.closeIssue).toHaveBeenCalledWith("", NATIVE, "not_planned");
  });

  // The board is the only copy of its own state, so a tab left open can show an
  // issue the forge has since closed. The route reads the real state rather than
  // trusting the card: a closed forge issue cannot be reopened, so relabelling
  // it would report a column it is not in.
  it("POST /board/move refuses to move a closed forge issue out of done", async () => {
    const gh = await githubMock();
    withShadow();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "CLOSED", stateReason: "completed", labels: [] });

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain("reopen it on the forge");
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  // Closing one is still fine — Done is the column it is already in.
  it("POST /board/move still accepts a closed forge issue dropped into done", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "CLOSED", stateReason: "completed", labels: [] });

    const res = await move({ repo: "org/repo", ref: 42, to: "done" });

    expect(res.status).toBe(200);
    expect(gh.closeIssue).toHaveBeenCalledWith("org/repo", 42, "not_planned");
  });

  // The state read happens before any write, so a failure there must not
  // borrow the 500 that means a half-applied move — the client would strand the
  // card in the column it was dropped into.
  it("POST /board/move answers 503, not 500, when the issue's state cannot be read", async () => {
    const gh = await githubMock();
    withShadow();
    vi.mocked(gh.getIssueState).mockRejectedValue(new Error("rate limited"));

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(503);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move rejects a repository Claws does not manage", async () => {
    const gh = await githubMock();

    const res = await move({ repo: "someone/else", ref: 42, to: "approved" });

    expect(res.status).toBe(403);
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  // A configured repo is not necessarily the issue's own: labelling through
  // another one would tag this repo's events at an issue it has nothing to do
  // with.
  it("POST /board/move rejects a native ref moved through another repository", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["test/repo"], labels: [] });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "approved" });

    expect(res.status).toBe(403);
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  // A well-formed native id no issue answers to: the state read would throw and
  // borrow the 503's "try again", which no retry can fix.
  it("POST /board/move answers 404 for a native ref the store does not know", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue(undefined);

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "approved" });

    expect(res.status).toBe(404);
    expect(gh.getIssueState).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move rejects an unknown column and a malformed ref", async () => {
    expect((await move({ repo: "org/repo", ref: 42, to: "nowhere" })).status).toBe(400);
    expect((await move({ repo: "org/repo", ref: "not-a-ref", to: "approved" })).status).toBe(400);
  });

  // A 500 from this route means a half-applied move, so the client leaves the
  // card where it was dropped and says to reload. A body that never parsed
  // wrote nothing and must not claim that.
  it("POST /board/move answers 400 rather than 500 for a body that is not JSON", async () => {
    const gh = await githubMock();

    const res = await request(server, "POST", "/board/move", {
      headers: { "content-type": "application/json" },
      body: "{\"repo\": \"org/repo\",",
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Malformed");
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  async function automerge(body: unknown) {
    return await request(server, "POST", "/board/automerge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F: on approves the issue through Merge, off
  // lowers a Merge approval to Plan — the writer handles the PR rows.
  it("POST /board/automerge on:true approves the issue through Merge, writing no label", async () => {
    const gh = await githubMock();
    withShadow();

    const res = await automerge({ repo: "org/repo", ref: 42, on: true });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "ok", on: true });
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", 42, "merge", "test-user", {});
    expect(gh.ensureLabel).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("POST /board/automerge on:false lowers a Merge approval to Plan, and never raises a lower one", async () => {
    const gh = await githubMock();
    mockIssueApproval.readIssueApproval.mockResolvedValueOnce({ trackerId: "clw_x", approvedThrough: "merge", by: "op", at: null });

    const res = await automerge({ repo: "org/repo", ref: 42, on: false });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "ok", on: false });
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenLastCalledWith("org/repo", 42, "plan", "test-user", { clearMergeRows: true });
    expect(gh.removeLabel).not.toHaveBeenCalled();

    // Short of Merge it restates the approval, only to clear a row approval.
    mockIssueApproval.readIssueApproval.mockResolvedValueOnce({ trackerId: "clw_x", approvedThrough: "requirements", by: "op", at: null });
    mockIssueFlight.loadIssueFlight.mockResolvedValueOnce({ implementing: false, openPrs: [openPrRow({ mergeApprovedBy: "op", mergeApprovedAt: "2026-09-24T10:00:00Z" })] as any[] });
    expect((await automerge({ repo: "org/repo", ref: 42, on: false })).status).toBe(200);
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenLastCalledWith("org/repo", 42, "requirements", "test-user", { clearMergeRows: true });

    // With no row approval to clear it writes nothing: restating Requirements
    // would promote an issue still in Ideas. Nor with no approval at all.
    mockIssueApproval.applyIssueApproval.mockClear();
    mockIssueApproval.readIssueApproval.mockResolvedValueOnce({ trackerId: "clw_x", approvedThrough: "requirements", by: "op", at: null });
    expect((await automerge({ repo: "org/repo", ref: 42, on: false })).status).toBe(200);
    expect((await automerge({ repo: "org/repo", ref: 42, on: false })).status).toBe(200);
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
  });

  // A partial Merge: one PR approved alone (claws_approve_pr_merge), one not.
  // Off must clear the approved row, not only when every row is approved.
  it("POST /board/automerge on:false withdraws a partial Merge, clearing every approved row", async () => {
    mockIssueApproval.readIssueApproval.mockResolvedValueOnce({ trackerId: "clw_x", approvedThrough: "plan", by: "op", at: null });
    mockIssueFlight.loadIssueFlight.mockResolvedValueOnce({
      implementing: false,
      openPrs: [openPrRow({ mergeApprovedBy: "op", mergeApprovedAt: "2026-09-24T10:00:00Z" }), openPrRow({ prNumber: 101 })] as any[],
    });

    const res = await automerge({ repo: "org/repo", ref: 42, on: false });

    expect(res.status).toBe(200);
    expect(mockIssueApproval.applyIssueApproval).toHaveBeenLastCalledWith("org/repo", 42, "plan", "test-user", { clearMergeRows: true });
  });

  it("POST /board/automerge on:false answers a failed read as a 503", async () => {
    mockIssueApproval.readIssueApproval.mockRejectedValueOnce(new Error("db down"));

    const res = await automerge({ repo: "org/repo", ref: 42, on: false });

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toContain("try again");
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
  });

  // The track's own check: an issue in Drafting has no requirements to merge against.
  it("POST /board/automerge on:true refuses an issue the track does not offer Merge on", async () => {
    withShadow({ lifecycle: "ideas", approved_through: "none", requirements_approved_at: null });

    const res = await automerge({ repo: "org/repo", ref: 42, on: true });

    expect(res.status).toBe(409);
    expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
  });

  it("POST /board/automerge answers the writer's failure as its own status", async () => {
    withShadow();
    mockIssueApproval.applyIssueApproval.mockResolvedValueOnce({ ok: false, status: 500, error: "database is locked" });

    const res = await automerge({ repo: "org/repo", ref: 42, on: true });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toBe("database is locked");
  });

  it("POST /board/automerge writes no row for an issue with no open PR", async () => {
    const db = await import("./db.js");

    await automerge({ repo: "org/repo", ref: 42, on: true });

    expect(db.upsertClawsPr).not.toHaveBeenCalled();
  });

  it("GET /board puts cards in the derived columns their flight implies", async () => {
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 42, title: "Running", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 43, title: "Reviewing", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 44, title: "Ready to land", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 45, title: "Quiet", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 46, title: "Stuck", body: "", labels: [{ name: "Blocked" }], author: { login: "stjohnb" } }]
        : []));
    mockIssueFlight.loadBoardFlights.mockResolvedValue(new Map([
      ["org/repo\u000046", { implementing: false, openPrs: [openPrRow({ prNumber: 8, stage: "problematic" })] }],
      ["org/repo\u000042", { implementing: true, openPrs: [] }],
      ["org/repo\u000043", { implementing: false, openPrs: [openPrRow({ stage: "ci-failing" })] }],
      ["org/repo\u000044", { implementing: false, openPrs: [openPrRow({ stage: "awaiting-merge", mergeApprovedAt: "2026-09-24T10:00:00Z" })] }],
    ]));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    const cardsIn = (column: string) => {
      const body = res.body.match(new RegExp(`<div class="board-col-body" data-column="${column}">([\\s\\S]*?)</div>\\s*</details>`))![1];
      return [...body.matchAll(/data-ref="([^"]+)"/g)].map((m) => m[1]);
    };
    expect(cardsIn("in-progress")).toEqual(["42", "43"]);
    // A problematic PR has no column of its own: its parked issue is in Blocked.
    expect(cardsIn("blocked")).toEqual(["46"]);
    expect(cardsIn("awaiting-merge")).toEqual(["44"]);
    expect(cardsIn("drafting")).toEqual(["45"]);
    expect(res.body).toContain(`<span class="board-chip-ci">CI failing</span>`);
    expect(res.body).not.toContain("PR columns are as fresh as the last PR dispatcher tick.");
    expect(res.body).not.toContain("Cards are ordered most recently updated first");
    const cards = vi.mocked(mockIssueFlight.loadBoardFlights).mock.calls[0][0] as { ref: unknown }[];
    expect(cards.map((c) => c.ref)).toEqual([42, 43, 44, 45, 46]);
  });

  it("GET /board puts an issue awaiting its operator step in Awaiting merge with the chip", async () => {
    const gh = await githubMock();
    const db = await import("./db.js");
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo" ? [{ number: 46, title: "Cut over", body: "", labels: [], author: { login: "stjohnb" } }] : []));
    mockClawsIssues.getOpenShadowStages.mockResolvedValueOnce(new Map([["org/repo\u000046", { id: "clw_SHADOW46", lifecycle: "planning", hasPlannedPrs: true }]]) as any);
    vi.mocked(db.getIssueIdsAwaitingOperator).mockResolvedValueOnce(new Map([["clw_SHADOW46", { position: 3, title: "Run the cutover" }]]));
    vi.mocked(db.getIssuePlannedPRs).mockResolvedValueOnce([
      { position: 3, repo: "org/repo", title: "Run the cutover", prNumber: null, dependsOn: null, kind: "manual", manualAction: null },
    ] as any);

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(vi.mocked(db.getIssueIdsAwaitingOperator).mock.calls.at(-1)![0]).toEqual(["clw_SHADOW46"]);
    const body = res.body.match(/<div class="board-col-body" data-column="awaiting-merge">([\s\S]*?)<\/div>\s*<\/details>/)![1];
    expect(body).toContain(`data-ref="46"`);
    expect(body).toContain(">Awaiting operator</span>");
  });

  it("GET /prs links a PR's live PRs-page session instead of Start session, and survives a failed lookup", async () => {
    const gh = await githubMock();
    const db = await import("./db.js");
    const pr = (number: number) => ({ number, title: `PR ${number}`, headRefName: `b${number}`, baseRefName: "main", labels: [], author: { login: "claws" }, isCrossRepository: false });
    vi.mocked(gh.listPRs).mockImplementation(async (repo: string) => (repo === "org/repo" ? [pr(7), pr(8)] : []) as never);
    vi.mocked(db.listLivePrStartedSessions).mockResolvedValueOnce(new Map([["org/repo#7", "sess777"]]));
    try {
      const res = await request(server, "GET", "/prs");
      expect(res.status).toBe(200);
      expect(res.body).toContain(`href="/sessions/sess777"`);
      expect(res.body.match(/class="refined-btn pr-go-to-session"/g)).toHaveLength(1);
      expect(res.body).toContain("startPrSession('org/repo',8, $event)");
      expect(res.body).not.toContain("startPrSession('org/repo',7, $event)");
      vi.mocked(db.listLivePrStartedSessions).mockRejectedValueOnce(new Error("db down"));
      const failed = await request(server, "GET", "/prs");
      expect(failed.status).toBe(200);
      expect(failed.body).not.toContain(`class="refined-btn pr-go-to-session"`);
      expect(failed.body.match(/class="refined-btn pr-start-session"/g)).toHaveLength(2);
    } finally {
      vi.mocked(gh.listPRs).mockReset().mockResolvedValue([]);
    }
  });

  it("GET /prs names a PR's unmet manual action and its issue's open operator step", async () => {
    const gh = await githubMock();
    const db = await import("./db.js");
    const pr = (number: number, title: string) => ({ number, title, headRefName: `claws/issue-9-${number}`, baseRefName: "main", labels: [], author: { login: "claws" }, isCrossRepository: false });
    vi.mocked(gh.listPRs).mockImplementation(async (repo: string) => (repo === "org/repo" ? [pr(7, "Move"), pr(8, "Other")] : []) as never);
    vi.mocked(db.listClawsPrs).mockImplementation(async (repo: string) => (repo === "org/repo"
      ? [openPrRow({ prNumber: 7, issueId: "clw_01M48WEHRHXGQGT558WG89NRY1", manualActionReason: "set secrets" }), openPrRow({ prNumber: 8 })]
      : []) as never);
    vi.mocked(db.getIssuePlannedPRs).mockResolvedValueOnce([
      { position: 1, repo: "org/repo", title: "Move", prNumber: 7, dependsOn: null, kind: "pr", manualAction: "set secrets" },
      { position: 2, repo: "org/repo", title: "actions (operator)", prNumber: null, dependsOn: [1], kind: "manual", manualAction: null },
    ]);
    mockClawsIssues.getIssue.mockResolvedValueOnce({ state: "open" } as any);
    try {
      const res = await request(server, "GET", "/prs");
      expect(res.status).toBe(200);
      const warning = "Manual action before merge: set secrets; Operator step pending: actions (operator)";
      expect(res.body).toContain(`<span class="manual-warning">&#x26A0; ${warning}</span>`);
      expect(res.body).toContain(`markAutomerge('org/repo',7, $event, false, &quot;${warning}&quot;)`);
      expect(res.body).toContain(`markAutomerge('org/repo',8, $event, false)`);
    } finally {
      vi.mocked(gh.listPRs).mockReset().mockResolvedValue([]);
      vi.mocked(db.listClawsPrs).mockReset().mockResolvedValue([]);
    }
  });

  // #clw_01M3ENMX6HWNW9DZWP6ZX2Z9BD: one PR, one cached bulk status, the same
  // counts and conflict state on every view that shows it.
  it("renders the same live PR status on /prs, the repo page and /board", async () => {
    const gh = await githubMock();
    const pr = { number: 7, title: "Pin driver", headRefName: "claws/issue-43-abc1", baseRefName: "main", labels: [], author: { login: "claws" }, isCrossRepository: false };
    vi.mocked(gh.listPRs).mockImplementation(async (repo: string) => (repo === "org/repo" ? [pr] : []) as never);
    vi.mocked(gh.listPRStatuses).mockImplementation(async (repo: string) =>
      new Map(repo === "org/repo" ? [[7, { checkStatus: "pending", checksPassed: 18, checksTotal: 22, mergeableState: "CONFLICTING" }]] : []) as never);
    vi.mocked(gh.getMergeBlockReason).mockImplementation((repo: string, n: number) => (repo === "org/repo" && n === 7 ? "conflicts with main" : undefined));
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo" ? [{ number: 43, title: "Reviewing", body: "", labels: [], author: { login: "stjohnb" } }] : []));
    // A stale stage the live status contradicts: the checks are pending, not failing.
    mockIssueFlight.loadBoardFlights.mockResolvedValue(new Map([
      ["org/repo\u000043", { implementing: false, openPrs: [openPrRow({ stage: "ci-failing" })] }],
    ]));

    try {
      for (const url of ["/prs", "/repos/org/repo"]) {
        const res = await request(server, "GET", url);
        expect(res.status, url).toBe(200);
        const row = res.body.slice(res.body.indexOf("Pin driver"));
        expect(row, url).toContain("&#x25CB; 18/22");
        expect(row, url).toContain("Merge blocked");
      }
      const repoPage = await request(server, "GET", "/repos/org/repo");
      expect(repoPage.body).toContain("&#x26A0; Conflicts");

      const board = await request(server, "GET", "/board");
      expect(board.status).toBe(200);
      expect(board.body).toContain(`<span class="board-chip-ci">Conflicts</span>`);
      expect(board.body).toContain(`<span class="board-chip-ci">Merge blocked</span>`);
      expect(board.body).not.toContain(`<span class="board-chip-ci">CI failing</span>`);
    } finally {
      vi.mocked(gh.listPRs).mockReset().mockResolvedValue([]);
      vi.mocked(gh.listPRStatuses).mockReset().mockResolvedValue(new Map());
      vi.mocked(gh.getMergeBlockReason).mockReset().mockReturnValue(undefined);
    }
  });

  it("GET /prs filters by kind and shows every PR on a bare /prs, ignoring any old kind cookie", async () => {
    const gh = await githubMock();
    const mk = (number: number, title: string, headRefName: string, login: string) =>
      ({ number, title, headRefName, baseRefName: "main", labels: [], author: { login }, isCrossRepository: false });
    const prs = [mk(1, "Bump renovate dep", "renovate/dep", "renovate[bot]"), mk(2, "Claws feature", "claws/issue-9-abc1", "claws")];
    vi.mocked(gh.listPRs).mockImplementation(async (repo: string) => (repo === "org/repo" ? prs : []) as never);
    try {
      const deps = await request(server, "GET", "/prs?kind=deps");
      expect(deps.status).toBe(200);
      expect(deps.body).toContain("Bump renovate dep");
      expect(deps.body).not.toContain("Claws feature");
      expect(deps.body).toContain("Open PRs <span>1</span>");
      expect(String(deps.headers["set-cookie"] ?? "")).not.toContain("claws_prs_kind");

      const other = await request(server, "GET", "/prs?kind=other");
      expect(other.body).toContain("Claws feature");
      expect(other.body).not.toContain("Bump renovate dep");

      const bare = await request(server, "GET", "/prs");
      expect(bare.status).toBe(200);
      expect(bare.body).toContain("Bump renovate dep");
      expect(bare.body).toContain("Claws feature");
      expect(String(bare.headers["set-cookie"] ?? "")).not.toContain("claws_prs_kind");

      const remembered = await request(server, "GET", "/prs", { headers: { Cookie: "claws_prs_kind=deps" } });
      expect(remembered.status).toBe(200);
      expect(remembered.headers.location).toBeUndefined();
      expect(remembered.body).toContain("Bump renovate dep");
      expect(remembered.body).toContain("Claws feature");
      expect(String(remembered.headers["set-cookie"] ?? "")).not.toContain("claws_prs_kind");

      const bogus = await request(server, "GET", "/prs?kind=bogus", { headers: { Cookie: "claws_prs_kind=deps" } });
      expect(bogus.status).toBe(200);
      expect(bogus.body).toContain("Claws feature");

      const filtered = await request(server, "GET", "/prs?repo=org/repo", { headers: { Cookie: "claws_prs_kind=deps" } });
      expect(filtered.status).toBe(200);
      expect(filtered.body).toContain("Claws feature");
      expect(filtered.body).toContain("Bump renovate dep");

      const created = await request(server, "GET", "/prs?sort=created&dir=asc");
      expect(created.status).toBe(200);
      expect(created.body).toContain("Created ▲");
    } finally {
      vi.mocked(gh.listPRs).mockReset().mockResolvedValue([]);
    }
  });

  it("POST /board/automerge answers 400 for a malformed body", async () => {
    const res = await request(server, "POST", "/board/automerge", {
      headers: { "content-type": "application/json" },
      body: "{\"repo\": \"org/repo\",",
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Malformed");
  });

  it("POST /board/automerge answers 400 when a field is missing", async () => {
    const res = await automerge({ repo: "org/repo", ref: 42 });
    expect(res.status).toBe(400);
  });

  it("POST /board/automerge rejects a repository Claws does not manage", async () => {
    const gh = await githubMock();

    const res = await automerge({ repo: "someone/else", ref: 42, on: true });

    expect(res.status).toBe(403);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  describe("POST /board/approve-through (#clw_01M5VRB6Q607S256SQ8NDC5AHT)", () => {
    async function approve(body: unknown) {
      return await request(server, "POST", "/board/approve-through", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    const defaultApply = mockIssueApproval.applyIssueApproval.getMockImplementation()!;
    /**
     * A native issue whose lifecycle and stored approval the writes advance, as
     * the store would: the approval writer promotes an issue in Ideas through
     * the route's promotion before it stores the value (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F).
     */
    function nativeIn(lifecycle: string, approvedThrough: string = lifecycle === "ideas" ? "none" : "requirements", extra: Record<string, unknown> = {}): void {
      let current = lifecycle;
      let approved = approvedThrough;
      mockClawsIssues.getIssue.mockImplementation(async () => ({
        id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: current, approved_through: approved,
        requirements_approved_at: current === "ideas" ? null : "2026-10-26 09:00:00", ...extra,
      }));
      mockClawsIssues.promoteIssue.mockImplementation(async () => { current = "planning"; return true; });
      mockClawsIssues.setLifecycle.mockImplementation(async (_o: string, _id: string, to: string) => { current = to; });
      mockClawsIssues.isAwaitingRequirementsReview.mockResolvedValue(lifecycle === "ideas");
      mockIssueApproval.applyIssueApproval.mockImplementation(async (_repo: string, _ref: unknown, through: string, _by: string, opts?: any) => {
        const before = approved;
        if (current === "ideas" && opts?.promote) {
          const promoted = await opts.promote();
          if (!promoted.ok) return promoted;
        }
        approved = through;
        return { ok: true, trackerId: NATIVE, before, after: through, changed: before !== through, openPrs: 0 };
      });
    }
    afterEach(() => {
      mockClawsIssues.isAwaitingRequirementsReview.mockReset().mockResolvedValue(false);
      mockClawsIssues.promoteIssue.mockReset().mockResolvedValue(true);
      mockClawsIssues.setLifecycle.mockReset();
      mockIssueApproval.applyIssueApproval.mockReset().mockImplementation(defaultApply);
    });

    it("Reqs in Requirements review approves only the requirements, and the issue then stops at plan review (AC6)", async () => {
      const gh = await githubMock();
      nativeIn("ideas");

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "requirements" });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ result: "ok", column: "planning" });
      expect(body.track).toContain("Stops at <b>plan review</b>");
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledTimes(1);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "requirements", "test-user", { promote: expect.any(Function) });
      // The dashboard's own promotion, approving the latest requirements version.
      expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "test-user", "ideas");
      expect(gh.addLabel).not.toHaveBeenCalled();
    });

    it("Reqs keeps a standing plan pre-approval rather than lowering it", async () => {
      nativeIn("ideas", "plan");

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "requirements" });

      expect(res.status).toBe(200);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user", expect.anything());
      expect(mockClawsIssues.promoteIssue).toHaveBeenCalled();
      expect(JSON.parse(res.body).track).toContain("Stops at <b>merge approval</b>");
    });

    it("Plan in Requirements review approves the requirements and pre-approves the plan in one write (AC4)", async () => {
      const gh = await githubMock();
      nativeIn("ideas");

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "plan" });

      expect(res.status).toBe(200);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledTimes(1);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user", expect.anything());
      expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith(NATIVE, "test-user", "ideas");
      const body = JSON.parse(res.body);
      expect(body.column).toBe("planning");
      expect(body.track).toMatch(/data-gate="plan" data-state="preapproved"/);
      expect(gh.addLabel).not.toHaveBeenCalled();
    });

    it("Merge in Requirements review approves the requirements, the plan and the merge in one write (AC5)", async () => {
      const gh = await githubMock();
      nativeIn("ideas");

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "merge" });

      expect(res.status).toBe(200);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledTimes(1);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "merge", "test-user", expect.anything());
      expect(mockClawsIssues.promoteIssue).toHaveBeenCalled();
      expect(JSON.parse(res.body).track).toContain("<b>Runs to merge</b> — no further stop");
      expect(gh.ensureLabel).not.toHaveBeenCalled();
      expect(gh.addLabel).not.toHaveBeenCalled();
    });

    it("Plan in Planning pre-approves the plan without a promotion", async () => {
      nativeIn("planning");

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "plan" });

      expect(res.status).toBe(200);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user", expect.anything());
      expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
      expect(JSON.parse(res.body).column).toBe("planning");
    });

    it("Plan in Awaiting plan review approves the plan, moving the card to Approved with no lifecycle write (AC7)", async () => {
      await withPlan();
      nativeIn("awaiting-plan-review");

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "plan" });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).column).toBe("approved");
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user", expect.anything());
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    });

    it("answers 500 with partial when the write fails part-way, and a refusal as itself", async () => {
      nativeIn("planning");
      mockIssueApproval.applyIssueApproval.mockResolvedValueOnce({ ok: false, status: 500, error: "database is locked" });

      const failed = await approve({ repo: "org/repo", ref: NATIVE, gate: "plan" });

      expect(failed.status).toBe(500);
      expect(JSON.parse(failed.body)).toMatchObject({ error: "database is locked", partial: true });

      mockIssueApproval.applyIssueApproval.mockResolvedValueOnce({ ok: false, status: 409, error: "The issue changed since it was read — reload and try again." });
      const refused = await approve({ repo: "org/repo", ref: NATIVE, gate: "plan" });
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.body).partial).toBeUndefined();
    });

    it("a landed /board/move carries the track re-rendered for its new column", async () => {
      nativeIn("ideas");

      const res = await request(server, "POST", "/board/move", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "org/repo", ref: NATIVE, to: "planning" }),
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ result: "ok", column: "planning" });
      expect(body.track).toContain("Stops at <b>plan review</b>");
    });

    it("withdrawing a pre-approved Plan lowers the approval to Requirements, Merge with it (AC8)", async () => {
      const gh = await githubMock();
      nativeIn("planning", "merge");

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "plan", withdraw: true });

      expect(res.status).toBe(200);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "requirements", "test-user", expect.anything());
      expect(JSON.parse(res.body).track).toContain("Stops at <b>plan review</b>");
      expect(gh.removeLabel).not.toHaveBeenCalled();
    });

    it("withdrawing Merge lowers the approval to Plan", async () => {
      await withPlan();
      nativeIn("awaiting-plan-review", "merge");
      mockIssueFlight.loadIssueFlight.mockResolvedValue({
        implementing: false,
        openPrs: [openPrRow({ prNumber: 7, stage: "awaiting-merge", mergeApprovedBy: "op", mergeApprovedAt: "2026-10-26T10:00:00Z" })],
      });

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "merge", withdraw: true });

      expect(res.status).toBe(200);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user", expect.anything());
    });

    it("withdrawing a partial Merge restates Requirements rather than raising the issue to Plan", async () => {
      await withPlan();
      nativeIn("awaiting-plan-review", "requirements");
      mockIssueFlight.loadIssueFlight.mockResolvedValue({
        implementing: false,
        openPrs: [openPrRow({ prNumber: 7, stage: "awaiting-merge", mergeApprovedBy: "session:abc", mergeApprovedAt: "2026-10-26T10:00:00Z" })],
      });

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "merge", withdraw: true });

      expect(res.status).toBe(200);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledTimes(1);
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "requirements", "test-user", expect.anything());
    });

    it("refuses a click the issue's live track does not offer, writing nothing", async () => {
      const gh = await githubMock();
      nativeIn("planning");

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "requirements" });

      expect(res.status).toBe(409);
      // The live track goes with the refusal, so the card stops offering the click.
      expect(JSON.parse(res.body).track).toContain(`class="approval-track"`);
      expect(mockIssueApproval.applyIssueApproval).not.toHaveBeenCalled();
      expect(gh.addLabel).not.toHaveBeenCalled();
      expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
    });

    it("answers ok without a track, not partial, when only the re-read after the writes fails", async () => {
      const gh = await githubMock();
      nativeIn("planning");
      vi.mocked(gh.getIssueState)
        .mockResolvedValueOnce({ state: "OPEN", stateReason: null, labels: [] })
        .mockRejectedValueOnce(new Error("forge down"));

      const res = await approve({ repo: "org/repo", ref: NATIVE, gate: "plan" });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ result: "ok" });
      expect(mockIssueApproval.applyIssueApproval).toHaveBeenCalledWith("org/repo", NATIVE, "plan", "test-user", expect.anything());
    });

    it("is a 400 for withdrawing requirements and for a malformed body", async () => {
      expect((await approve({ repo: "org/repo", ref: NATIVE, gate: "requirements", withdraw: true })).status).toBe(400);
      expect((await approve({ repo: "org/repo", ref: NATIVE, gate: "deploy" })).status).toBe(400);
      const res = await request(server, "POST", "/board/approve-through", { headers: { "content-type": "application/json" }, body: "{" });
      expect(res.status).toBe(400);
    });

    it("rejects a repository Claws does not manage", async () => {
      const gh = await githubMock();
      const res = await approve({ repo: "someone/else", ref: 42, gate: "merge" });
      expect(res.status).toBe(403);
      expect(gh.addLabel).not.toHaveBeenCalled();
    });

    it("is a 404 for a native id the store does not know", async () => {
      expect((await approve({ repo: "org/repo", ref: NATIVE, gate: "plan" })).status).toBe(404);
    });
  });
});

describe("GET /repo-avatar/:owner/:name", () => {
  let server: http.Server;

  beforeEach(async () => {
    const repoConfig = await import("./repo-config.js");
    repoConfig.clearRepoConfigCache();
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    (await import("./repo-config.js")).clearRepoConfigCache();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 404 when the repo declares no avatar", async () => {
    const gh = await import("./github.js");
    vi.mocked(gh.fetchRepoFileBytes).mockClear();
    const res = await request(server, "GET", "/repo-avatar/org/no-avatar");
    expect(res.status).toBe(404);
    expect(gh.fetchRepoFileBytes).not.toHaveBeenCalled();
  });

  it("serves the declared image with its content type and a sandboxing CSP", async () => {
    const { refreshRepoConfigs } = await import("./repo-config.js");
    await refreshRepoConfigs([{ fullName: "org/with-avatar" }], async () => JSON.stringify({ avatar: "docs/avatar.png" }));
    const gh = await import("./github.js");
    vi.mocked(gh.fetchRepoFileBytes).mockResolvedValueOnce(Buffer.from("PNGDATA"));

    const res = await request(server, "GET", "/repo-avatar/org/with-avatar");

    expect(res.status).toBe(200);
    expect(res.body).toBe("PNGDATA");
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(gh.fetchRepoFileBytes).toHaveBeenCalledWith("org/with-avatar", "docs/avatar.png");
  });

  it("returns 404 when the declared image is missing, and caches the miss", async () => {
    const { refreshRepoConfigs } = await import("./repo-config.js");
    await refreshRepoConfigs([{ fullName: "org/missing-avatar" }], async () => JSON.stringify({ avatar: "logo.svg" }));
    const gh = await import("./github.js");
    vi.mocked(gh.fetchRepoFileBytes).mockClear();
    vi.mocked(gh.fetchRepoFileBytes).mockResolvedValueOnce(null);

    expect((await request(server, "GET", "/repo-avatar/org/missing-avatar")).status).toBe(404);
    expect((await request(server, "GET", "/repo-avatar/org/missing-avatar")).status).toBe(404);
    expect(gh.fetchRepoFileBytes).toHaveBeenCalledTimes(1);
  });
});

describe("alert-bridge routes", () => {
  const BRIDGE_TOKEN = "bridge-token-for-org-bridged";
  let server: http.Server;

  beforeEach(async () => {
    const { refreshRepoConfigs } = await import("./repo-config.js");
    const alertBridge = { label: "alert", title: "[Alert] bridged alerts firing", tokenSha256: crypto.createHash("sha256").update(BRIDGE_TOKEN).digest("hex") };
    await refreshRepoConfigs([{ fullName: "org/bridged" }], async () => JSON.stringify({ alertBridge }));
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    (await import("./repo-config.js")).clearRepoConfigCache();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("refuses an operator session and the agents' shared internal token", async () => {
    expect((await request(server, "GET", "/api/alert-bridge/org/bridged/issues?state=closed")).status).toBe(401);
    testSessionCookie = null;
    const headers = { authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };
    expect((await request(server, "GET", "/api/alert-bridge/org/bridged/issues?state=closed", { headers })).status).toBe(401);
    expect((await request(server, "POST", "/api/alert-bridge/org/bridged/issues", { headers, body: JSON.stringify({ body: "x" }) })).status).toBe(401);
    expect((await request(server, "PATCH", "/api/alert-bridge/org/bridged/issues/clw_x", { headers, body: JSON.stringify({ body: "x" }) })).status).toBe(401);
    expect((await request(server, "POST", "/api/alert-bridge/org/bridged/alerts/events", { headers, body: JSON.stringify({ reopenWindowHours: 24, alerts: [] }) })).status).toBe(401);
  });

  it("admits the bridge token on its own repo's routes and nowhere else", async () => {
    testSessionCookie = null;
    const headers = { authorization: `Bearer ${BRIDGE_TOKEN}` };
    expect((await request(server, "GET", "/api/alert-bridge/org/bridged/issues?state=nonsense", { headers })).status).toBe(400);
    expect((await request(server, "GET", "/api/alert-bridge/org/other/issues?state=nonsense", { headers })).status).toBe(401);
    const events = { headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ reopenWindowHours: 24, alerts: [] }) };
    expect((await request(server, "POST", "/api/alert-bridge/org/bridged/alerts/events", events)).status).toBe(200);
    expect((await request(server, "POST", "/api/alert-bridge/org/other/alerts/events", events)).status).toBe(401);
    expect((await request(server, "GET", "/api/issues", { headers })).status).toBe(401);
  });

  it("GET /alerts/lookup redirects a tracked alertname to its dedicated issue", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValueOnce({
      id: "clw_01M61M73EW1AMEZPD9V06YW18X", kind: "issue", title: "KubeJobFailed", body: "The Job failed.", labels: [], repos: ["org/bridged"],
      dedupe_key: "alert-kubejobfailed", filed_title: null,
    });
    const res = await request(server, "GET", "/alerts/lookup?repo=org/bridged&alertname=KubeJobFailed");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/issues/clw_01M61M73EW1AMEZPD9V06YW18X");
    expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith("org/bridged", "alert-kubejobfailed");
  });

  it("GET /alerts/lookup redirects to /alerts for a repo without an alert bridge", async () => {
    const res = await request(server, "GET", "/alerts/lookup?repo=org/unknown&alertname=KubeJobFailed");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/alerts");
  });
});

describe("issue-filer routes", () => {
  const FILER_TOKEN = "filer-token-for-org-filed";
  const OTHER_FILER_TOKEN = "filer-token-for-org-other-filed";
  const BRIDGE_TOKEN = "bridge-token-for-org-bridged";
  const ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
  const OTHER_ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";
  const ATT = "cla_01JBQ7X4M2K8NV3TYRW9GZ5PDE";
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-of-png")]);
  const sha = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
  /** What each repo's claws.json currently says, as `fetchRepoFileContent` serves it. */
  let files: Record<string, string>;
  /** The native issues `getIssue`/`findOpenIssueByDedupeKey` see. */
  let records: Array<Record<string, any>>;
  let server: http.Server;

  const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const file = (title: string, dedupeKey: unknown, token = FILER_TOKEN, repo = "org/filed") =>
    request(server, "POST", `/api/issue-filer/${repo}/issues`, { headers: auth(token), body: JSON.stringify({ title, body: "Seen on the home page.", dedupeKey }) });
  const upload = (id: string, body: Buffer | string, contentType = "image/png", name = "home.png") =>
    request(server, "POST", `/api/issue-filer/org/filed/issues/${id}/attachments?name=${encodeURIComponent(name)}`, {
      headers: { authorization: `Bearer ${FILER_TOKEN}`, "content-type": contentType },
      body,
    });
  const record = (overrides: Record<string, unknown>) => ({
    id: ISSUE, kind: "issue", title: "Site review: missing title on /", body: "", state: "open", repos: ["org/filed"],
    labels: [], dedupe_key: "site-review-missing-title-home", filed_title: null, ...overrides,
  });

  beforeEach(async () => {
    testSessionCookie = null;
    files = {
      "org/filed": JSON.stringify({ issueFiler: { tokenSha256: sha(FILER_TOKEN), dedupeKeyPrefix: "site-review-" } }),
      "org/other-filed": JSON.stringify({ issueFiler: { tokenSha256: sha(OTHER_FILER_TOKEN), dedupeKeyPrefix: "site-review-" } }),
      "org/bridged": JSON.stringify({ alertBridge: { label: "alert", title: "[Alert] bridged", tokenSha256: sha(BRIDGE_TOKEN) } }),
      "org/plain": JSON.stringify({}),
    };
    records = [];
    const { refreshRepoConfigs } = await import("./repo-config.js");
    const fetchFile = async (fullName: string) => files[fullName] ?? null;
    await refreshRepoConfigs(Object.keys(files).map((fullName) => ({ fullName })), fetchFile);
    const gh = await import("./github.js");
    vi.mocked(gh.fetchRepoFileContent).mockImplementation(fetchFile);
    mockClawsIssues.findOpenIssueByDedupeKey.mockImplementation(async (primary: string, key: string) =>
      records.find((r) => r.state === "open" && r.dedupe_key === key && mockClawsIssues.primaryRepo(r as { repos: string[] }) === primary));
    mockClawsIssues.getIssue.mockImplementation(async (id: string) => records.find((r) => r.id === id));
    mockClawsIssues.createIssue.mockClear();
    mockClawsIssues.commentOnIssue.mockClear();
    mockClawsIssues.listOpenIssuesTouching.mockClear();
    mockIssueAttachments.storeIssueAttachment.mockReset();
    mockIssueAttachments.storeIssueAttachment.mockResolvedValue({
      ok: true,
      row: { id: ATT, issue_id: ISSUE, comment_id: null, filename: "home.png", stored_path: "x", content_type: "image/png", size: PNG.length, uploader_login: "claws", created_at: "" },
    });
    vi.mocked((await import("./worker.js")).enqueue).mockClear();
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    (await import("./repo-config.js")).clearRepoConfigCache();
    vi.mocked((await import("./github.js")).fetchRepoFileContent).mockReset().mockResolvedValue(null);
    mockClawsIssues.findOpenIssueByDedupeKey.mockImplementation(async () => undefined);
    mockClawsIssues.getIssue.mockImplementation(async () => undefined);
    mockClawsIssues.listOpenIssuesTouching.mockImplementation(async () => []);
    mockIssueAttachments.storeIssueAttachment.mockReset();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("files an automation-sourced, unpromoted issue in the path repo only (AC 1)", async () => {
    let actor: IssueActor | undefined;
    mockClawsIssues.createIssue.mockImplementationOnce(async () => { actor = currentIssueActor(); return ISSUE; });
    const res = await file("Site review: missing title on /", " Site-Review-Missing-Title-Home ");
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ id: ISSUE, ref: `#${ISSUE}`, url: `https://claws.example/issues/${ISSUE}`, deduplicated: false });
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith({
      title: "Site review: missing title on /",
      body: "Seen on the home page.",
      authorLogin: "claws",
      repos: ["org/filed"],
      source: "automation",
      autoPromote: false,
      dedupeKey: "site-review-missing-title-home",
    });
    expect(actor).toEqual({ kind: "automation", name: "issue filer" });
  });

  it("returns the open issue already holding the key, creating nothing (AC 2)", async () => {
    records.push(record({}));
    const res = await file("Site review: missing title on / again", "site-review-missing-title-home");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: ISSUE, ref: `#${ISSUE}`, url: `https://claws.example/issues/${ISSUE}`, deduplicated: true });
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
  });

  it("never dedupes on title similarity (AC 3)", async () => {
    const lookalike = record({ id: OTHER_ISSUE, dedupe_key: null });
    records.push(lookalike);
    mockClawsIssues.listOpenIssuesTouching.mockImplementation(async () => [lookalike]);
    const res = await file("Site review: missing title on /", "site-review-missing-title-about");
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body).deduplicated).toBe(false);
    expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.listOpenIssuesTouching).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["malformed", "site-review-has spaces"],
    ["without the prefix", "missing-title-home"],
    ["not a string", 42],
  ])("rejects a %s dedupe key and creates nothing (AC 4)", async (_name, key) => {
    expect((await file("Site review: x", key)).status).toBe(400);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("rejects a missing or over-long title", async () => {
    expect((await file("  ", "site-review-x1")).status).toBe(400);
    expect((await file("t".repeat(257), "site-review-x1")).status).toBe(400);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("looks up the open issue holding a key in the path repo, else 404 (AC 5)", async () => {
    const lookup = (key: string) => request(server, "GET", `/api/issue-filer/org/filed/issues?dedupeKey=${key}`, { headers: auth(FILER_TOKEN) });
    records.push(
      record({}),
      record({ id: OTHER_ISSUE, dedupe_key: "site-review-closed", state: "closed" }),
      record({ id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF", dedupe_key: "site-review-elsewhere", repos: ["org/other-filed"] }),
    );
    const found = await lookup("site-review-missing-title-home");
    expect(found.status).toBe(200);
    expect(JSON.parse(found.body)).toEqual({ id: ISSUE, ref: `#${ISSUE}`, url: `https://claws.example/issues/${ISSUE}` });
    expect((await lookup("site-review-closed")).status).toBe(404);
    expect((await lookup("site-review-elsewhere")).status).toBe(404);
    expect((await lookup("site-review-nothing")).status).toBe(404);
    // A key outside the prefix is refused rather than looked up.
    expect((await lookup("alert-foo")).status).toBe(400);
  });

  describe("adoption by filed title", () => {
    const REPORT = "[security] Pinned images carry High/Critical CVEs with fixes available";
    const lookup = (key: string, filedTitle?: string) =>
      request(server, "GET", `/api/issue-filer/org/filed/issues?dedupeKey=${key}${filedTitle === undefined ? "" : `&filedTitle=${encodeURIComponent(filedTitle)}`}`, { headers: auth(FILER_TOKEN) });

    beforeEach(() => {
      // The real lookup's filter, over `records`: open, unkeyed, primary repo, COALESCE(filed_title, title).
      mockClawsIssues.findOpenUnkeyedIssueByFiledTitle.mockReset().mockImplementation(async (primary: string, title: string) =>
        [...records].reverse().find((r) => r.state === "open" && r.kind === "issue" && r.dedupe_key == null
          && mockClawsIssues.primaryRepo(r as { repos: string[] }) === primary && (r.filed_title ?? r.title) === title));
      mockClawsIssues.setClawsIssueDedupeKey.mockReset().mockImplementation(async (id: string, key: string) => {
        const r = records.find((x) => x.id === id);
        if (!r) return false;
        r.dedupe_key = key;
        return true;
      });
    });

    it("adopts an unkeyed issue renamed after filing, and a second lookup finds it by key", async () => {
      records.push(record({ title: "Clear blocking High/Critical image CVEs", filed_title: REPORT, dedupe_key: null }));
      const res = await lookup("site-review-image-cve-scan", REPORT);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: ISSUE, ref: `#${ISSUE}`, url: `https://claws.example/issues/${ISSUE}` });
      expect(mockClawsIssues.setClawsIssueDedupeKey).toHaveBeenCalledWith(ISSUE, "site-review-image-cve-scan");
      mockClawsIssues.findOpenUnkeyedIssueByFiledTitle.mockClear();
      expect((await lookup("site-review-image-cve-scan", REPORT)).status).toBe(200);
      expect(mockClawsIssues.findOpenUnkeyedIssueByFiledTitle).not.toHaveBeenCalled();
    });

    it("never adopts a keyed or closed issue, or one filed under a different title (AC6)", async () => {
      records.push(
        record({ title: REPORT, dedupe_key: "site-review-other" }),
        record({ id: OTHER_ISSUE, title: REPORT, dedupe_key: null, state: "closed" }),
        record({ id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF", title: "[security] Something else", dedupe_key: null }),
      );
      expect((await lookup("site-review-image-cve-scan", REPORT)).status).toBe(404);
      expect((await lookup("site-review-image-cve-scan", "[security] Something")).status).toBe(404);
      expect(mockClawsIssues.setClawsIssueDedupeKey).not.toHaveBeenCalled();
    });

    it("answers 404 without a filedTitle or when the key claim fails, and 400 on an over-long one", async () => {
      records.push(record({ title: REPORT, dedupe_key: null }));
      expect((await lookup("site-review-image-cve-scan")).status).toBe(404);
      expect((await lookup("site-review-image-cve-scan", "")).status).toBe(404);
      expect(mockClawsIssues.findOpenUnkeyedIssueByFiledTitle).not.toHaveBeenCalled();
      mockClawsIssues.setClawsIssueDedupeKey.mockImplementationOnce(async () => false);
      expect((await lookup("site-review-image-cve-scan", REPORT)).status).toBe(404);
      expect((await lookup("site-review-image-cve-scan", "t".repeat(257))).status).toBe(400);
    });
  });

  describe("PATCH an issue", () => {
    const patch = (id: string, body: unknown, repo = "org/filed", token = FILER_TOKEN) =>
      request(server, "PATCH", `/api/issue-filer/${repo}/issues/${id}`, { headers: auth(token), body: JSON.stringify(body) });

    beforeEach(() => {
      mockClawsIssues.editIssue.mockClear();
      mockClawsIssues.closeIssue.mockClear();
    });

    it("rewrites the body when it differs, posting no comment", async () => {
      records.push(record({ body: "19 blocking rows" }));
      const res = await patch(ISSUE, { body: "18 blocking rows" });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: ISSUE, ref: `#${ISSUE}`, url: `https://claws.example/issues/${ISSUE}`, state: "open" });
      expect(mockClawsIssues.editIssue).toHaveBeenCalledWith(ISSUE, "18 blocking rows");
      expect((await patch(ISSUE, { body: "19 blocking rows" })).status).toBe(200);
      expect(mockClawsIssues.editIssue).toHaveBeenCalledTimes(1);
      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.closeIssue).not.toHaveBeenCalled();
    });

    it("closes as completed, and closing a closed issue is a no-op", async () => {
      records.push(record({}), record({ id: OTHER_ISSUE, state: "closed" }));
      const res = await patch(ISSUE, { state: "closed" });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).state).toBe("closed");
      expect(mockClawsIssues.closeIssue).toHaveBeenCalledWith("org/filed", ISSUE, "completed");
      const again = await patch(OTHER_ISSUE, { state: "closed" });
      expect(again.status).toBe(200);
      expect(JSON.parse(again.body).state).toBe("closed");
      expect(mockClawsIssues.closeIssue).toHaveBeenCalledTimes(1);
      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
    });

    it("answers 404 for another repo's or an unprefixed issue", async () => {
      records.push(
        record({ id: OTHER_ISSUE, repos: ["org/other-filed"] }),
        record({ id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF", dedupe_key: null }),
        record({ id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDG", dedupe_key: "other-key" }),
      );
      for (const id of [OTHER_ISSUE, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDG"]) {
        expect((await patch(id, { state: "closed" })).status).toBe(404);
      }
      expect((await patch(OTHER_ISSUE, { state: "closed" }, "org/other-filed")).status).toBe(401);
      expect(mockClawsIssues.closeIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    });

    it("rejects a bad state or body", async () => {
      records.push(record({}));
      expect((await patch(ISSUE, { state: "open" })).status).toBe(400);
      expect((await patch(ISSUE, { body: 42 })).status).toBe(400);
      expect((await patch(ISSUE, { body: "x".repeat(65_537) })).status).toBe(400);
      expect(mockClawsIssues.closeIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    });
  });

  it("stores a PNG and answers its dashboard URL, with no comment or re-plan (AC 6)", async () => {
    records.push(record({}));
    const res = await upload(ISSUE, PNG);
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ id: ATT, url: `https://claws.example/issues/${ISSUE}/attachments/${ATT}/home.png` });
    expect(mockIssueAttachments.storeIssueAttachment).toHaveBeenCalledWith(ISSUE, "home.png", PNG, "image/png", "claws");
    expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
    expect((await import("./worker.js")).enqueue).not.toHaveBeenCalled();
  });

  it("refuses an upload to another repo's issue, an unprefixed issue, a non-PNG or an over-cap body (AC 7)", async () => {
    records.push(
      record({ id: OTHER_ISSUE, repos: ["org/other-filed"] }),
      record({ id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF", dedupe_key: null }),
      record({ id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDG", dedupe_key: "other-key" }),
      record({}),
    );
    expect((await upload(OTHER_ISSUE, PNG)).status).toBe(404);
    expect((await upload("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF", PNG)).status).toBe(404);
    expect((await upload("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDG", PNG)).status).toBe(404);
    expect((await upload(ISSUE, "GIF89a-not-a-png", "image/png")).status).toBe(415);
    expect((await upload(ISSUE, PNG, "image/jpeg")).status).toBe(415);
    expect((await upload(ISSUE, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))).status).toBe(413);
    expect((await upload(ISSUE, PNG, "image/png", "")).status).toBe(400);
    expect(mockIssueAttachments.storeIssueAttachment).not.toHaveBeenCalled();
  });

  it("admits the filer token on its own repo's routes and nowhere else (AC 8)", async () => {
    expect((await file("Site review: x", "site-review-x1", FILER_TOKEN, "org/other-filed")).status).toBe(401);
    expect((await request(server, "GET", "/api/issue-filer/org/other-filed/issues?dedupeKey=site-review-x1", { headers: auth(FILER_TOKEN) })).status).toBe(401);
    expect((await request(server, "GET", "/api/alert-bridge/org/bridged/issues?state=closed", { headers: auth(FILER_TOKEN) })).status).toBe(401);
    expect((await request(server, "GET", "/api/alert-bridge/org/filed/issues?state=closed", { headers: auth(FILER_TOKEN) })).status).toBe(401);
    expect((await request(server, "GET", "/api/issues", { headers: auth(FILER_TOKEN) })).status).toBe(401);
    expect((await request(server, "POST", "/api/issues", { headers: auth(FILER_TOKEN), body: JSON.stringify({ title: "x", repos: ["org/filed"] }) })).status).toBe(401);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("refuses the internal token, an agent-pod bearer and the operator's session (AC 9)", async () => {
    for (const token of ["test-internal-mcp-token", "agent-pod-token"]) {
      expect((await file("Site review: x", "site-review-x1", token)).status).toBe(401);
      expect((await request(server, "GET", "/api/issue-filer/org/filed/issues?dedupeKey=site-review-x1", { headers: auth(token) })).status).toBe(401);
    }
    testSessionCookie = signSession("test-user", Date.now() + 24 * 60 * 60 * 1000, TEST_OIDC_SECRET);
    expect((await request(server, "POST", "/api/issue-filer/org/filed/issues", { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x", dedupeKey: "site-review-x1" }) })).status).toBe(401);
    expect((await request(server, "GET", "/api/issue-filer/org/filed/issues?dedupeKey=site-review-x1")).status).toBe(401);
    testSessionCookie = null;
    records.push(record({}));
    const res = await request(server, "POST", `/api/issue-filer/org/filed/issues/${ISSUE}/attachments?name=a.png`, {
      headers: { authorization: "Bearer test-internal-mcp-token", "content-type": "image/png" },
      body: PNG,
    });
    expect(res.status).toBe(401);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    expect(mockIssueAttachments.storeIssueAttachment).not.toHaveBeenCalled();
  });

  it("rejects every request on a repo with no issueFiler (AC 10)", async () => {
    for (const token of [FILER_TOKEN, BRIDGE_TOKEN]) {
      expect((await file("Site review: x", "site-review-x1", token, "org/plain")).status).toBe(401);
      expect((await file("Site review: x", "site-review-x1", token, "org/bridged")).status).toBe(401);
      expect((await request(server, "GET", "/api/issue-filer/org/plain/issues?dedupeKey=site-review-x1", { headers: auth(token) })).status).toBe(401);
    }
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("accepts a rotated token after one forced re-read of claws.json (AC 11)", async () => {
    const ROTATED = "rotated-filer-token";
    files["org/filed"] = JSON.stringify({ issueFiler: { tokenSha256: sha(ROTATED), dedupeKeyPrefix: "site-review-" } });
    const gh = await import("./github.js");
    vi.mocked(gh.fetchRepoFileContent).mockClear();
    const res = await file("Site review: x", "site-review-x1", ROTATED);
    expect(res.status).toBe(201);
    expect(gh.fetchRepoFileContent).toHaveBeenCalledTimes(1);
    expect(gh.fetchRepoFileContent).toHaveBeenCalledWith("org/filed", "claws.json");
    // The old token now fails, and the re-read is rate-limited, so no second fetch.
    expect((await file("Site review: x", "site-review-x2", FILER_TOKEN)).status).toBe(401);
    expect(gh.fetchRepoFileContent).toHaveBeenCalledTimes(1);
  });
});

describe("completion route", () => {
  const CALLER_TOKEN = "completion-token-for-org-caller";
  const OTHER_CALLER_TOKEN = "completion-token-for-org-other-caller";
  const FILER_TOKEN = "filer-token-for-org-caller";
  const BRIDGE_TOKEN = "bridge-token-for-org-caller";
  const sha = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
  let server: http.Server;
  const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  // An empty object fails validation (400) without running anything, so a 400 proves auth passed.
  const complete = (token: string | null, repo = "org/caller", body = "{}") =>
    request(server, "POST", `/api/completion/${repo}`, { headers: token ? auth(token) : { "content-type": "application/json" }, body });

  beforeEach(async () => {
    testSessionCookie = null;
    const files: Record<string, string> = {
      "org/caller": JSON.stringify({
        completion: { tokenSha256: sha(CALLER_TOKEN) },
        issueFiler: { tokenSha256: sha(FILER_TOKEN), dedupeKeyPrefix: "site-review-" },
        alertBridge: { label: "alert", title: "[Alert] caller", tokenSha256: sha(BRIDGE_TOKEN) },
      }),
      "org/other-caller": JSON.stringify({ completion: { tokenSha256: sha(OTHER_CALLER_TOKEN) } }),
      "org/plain": JSON.stringify({}),
    };
    const { refreshRepoConfigs } = await import("./repo-config.js");
    const fetchFile = async (fullName: string) => files[fullName] ?? null;
    await refreshRepoConfigs(Object.keys(files).map((fullName) => ({ fullName })), fetchFile);
    vi.mocked((await import("./github.js")).fetchRepoFileContent).mockImplementation(fetchFile);
    server = createServer(liveControllerClient(mockScheduler()));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    (await import("./repo-config.js")).clearRepoConfigCache();
    vi.mocked((await import("./github.js")).fetchRepoFileContent).mockReset().mockResolvedValue(null);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("admits the caller's own token on its own path", async () => {
    expect((await complete(CALLER_TOKEN)).status).toBe(400);
  });

  it("answers 401 to a missing, wrong or other repo's token, and on a repo with no completion entry", async () => {
    expect((await complete(null)).status).toBe(401);
    expect((await complete("not-the-token")).status).toBe(401);
    expect((await complete(OTHER_CALLER_TOKEN)).status).toBe(401);
    expect((await complete(CALLER_TOKEN, "org/other-caller")).status).toBe(401);
    expect((await complete(CALLER_TOKEN, "org/plain")).status).toBe(401);
    expect((await complete(FILER_TOKEN)).status).toBe(401);
    expect((await complete(BRIDGE_TOKEN)).status).toBe(401);
    expect((await complete("test-internal-mcp-token")).status).toBe(401);
  });

  it("refuses an operator session", async () => {
    testSessionCookie = signSession("test-user", Date.now() + 24 * 60 * 60 * 1000, TEST_OIDC_SECRET);
    expect((await complete(null)).status).toBe(401);
  });

  it("refuses the completion token on every other route family", async () => {
    const headers = auth(CALLER_TOKEN);
    expect((await request(server, "GET", "/api/issue-filer/org/caller/issues?dedupeKey=site-review-x1", { headers })).status).toBe(401);
    expect((await request(server, "POST", "/api/issue-filer/org/caller/issues", { headers, body: JSON.stringify({ title: "x", dedupeKey: "site-review-x1" }) })).status).toBe(401);
    expect((await request(server, "GET", "/api/alert-bridge/org/caller/issues?state=closed", { headers })).status).toBe(401);
    expect((await request(server, "GET", "/api/issues", { headers })).status).toBe(401);
    expect((await request(server, "POST", "/api/issues", { headers, body: JSON.stringify({ title: "x", repos: ["org/caller"] }) })).status).toBe(401);
  });

  it("answers 413 JSON to a body over 512 KiB", async () => {
    const res = await complete(CALLER_TOKEN, "org/caller", JSON.stringify({ prompt: "x".repeat(600 * 1024) }));
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toMatch(/too large/);
  });
});
