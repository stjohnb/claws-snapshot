import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";

// Runtime API tests never open a local pseudo-terminal.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

const workBackendState = vi.hoisted(() => ({ backend: "in-process" as "in-process" | "k8s-pod" }));
const agentPodLauncherMock = vi.hoisted(() => ({ cancelAll: vi.fn(async () => 0), cancelByRunId: vi.fn(() => false) }));
vi.mock("./agent-pod-launcher.js", () => ({ getAgentPodLauncher: () => agentPodLauncherMock }));

vi.mock("./config.js", () => ({
  get WORK_BACKEND() { return workBackendState.backend; },
  SERVER_PORT: 0,
  // The repo page reads its worktrees under here; a missing directory is none.
  WORK_DIR: "/nonexistent/claws-server-test",
  BIND_HOST: "127.0.0.1",
  ACTIVATION_STATE: "active",
  isActive: () => true,
  WHATSAPP_ENABLED: false,
  INTERNAL_MCP_TOKEN: "test-internal-mcp-token",
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    blocked: "Blocked",
    backlog: "Backlog",
    problematic: "Claws Problematic",
    automerge: "Automerge",
    manualAction: "Manual Action",
    duplicate: "Duplicate",
  },
  LABEL_SPECS: {
    "Refined":              { color: "0075ca", description: "Issue is ready for claws to implement" },
    "Ready":                { color: "0e8a16", description: "Claws has finished — needs human attention" },
    "Automerge":            { color: "c2e0c6", description: "Mirror of a dashboard merge approval; applying it on a forge PR has no effect" },
    "Priority":             { color: "006b75", description: "High-priority — processed first in all Claws queues" },
    "Backlog":              { color: "c5def5", description: "Parked for later" },
    "Claws Ignore":         { color: "cfd3d7", description: "Claws will completely ignore this issue or PR" },
  },
  VALID_AGENT_NAMES: ["planner", "implementer", "ci-fixer", "review-addresser", "reviewer", "merger"],
  ALLOWED_ACTORS: ["stjohnb"],
  isForgejoRepo: () => false,
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
  OPENCODE_BEST_MODEL: "openrouter/anthropic/claude-opus-4",
  OPENCODE_ADEQUATE_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
  OPENCODE_CHEAP_MODEL: "openrouter/google/gemini-2.5-flash",
  CLAUDE_CHEAP_MODEL: "claude-haiku-4-5-20251001",
  CLAUDE_FABLE_MODEL: "fable",
  CODEX_FABLE_MODEL: "gpt-5.5",
  OPENCODE_FABLE_MODEL: "openrouter/anthropic/claude-opus-4",
  IMPROVEMENT_IDENTIFIER_MODEL: "openrouter/z-ai/glm-5.3",
  PI_BEST_MODEL: "anthropic/claude-opus-5-5",
  PI_ADEQUATE_MODEL: "anthropic/claude-sonnet-5-5",
  PI_CHEAP_MODEL: "anthropic/claude-haiku-4-5",
  PI_FABLE_MODEL: "anthropic/claude-opus-5-5",
  loadConfig: vi.fn().mockReturnValue({
    slackWebhook: "https://hooks.slack.com/abcdef",
    githubOwners: ["owner1"],
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
    notifyDashboardActions: true,
  }),
  getConfigForDisplay: vi.fn().mockReturnValue({
    slackWebhook: "****cdef",
    githubOwners: ["owner1"],
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
    notifyDashboardActions: true,
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
  NOTIFY_DASHBOARD_ACTIONS: true,
  SENSITIVE_KEYS: new Set(["slackWebhook", "slackBotToken", "openaiApiKey", "emailAppPassword"]),
  DEEP_MERGED_KEYS: new Set(["intervals", "schedules"]),
  OPENROUTER_API_KEY: "",
  AI_PROVIDER_NAMES: ["claude", "codex", "opencode", "pi"],
  DEFAULT_AI_PROVIDERS: {
    claude: { enabled: true, weight: 4 },
    codex: { enabled: true, weight: 2 },
    opencode: { enabled: true, weight: 1 },
    pi: { enabled: true, weight: 0 },
  },
  AI_PROVIDERS: {
    claude: { enabled: true, weight: 4 },
    codex: { enabled: true, weight: 2 },
    opencode: { enabled: true, weight: 1 },
    pi: { enabled: true, weight: 0 },
  },
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
  PROD_GRAFANA_TOKEN: "",
  FLEET_GRAFANA_URL: "",
  FLEET_GRAFANA_TOKEN: "",
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
  isOpenCodeBinaryAvailable: vi.fn().mockReturnValue(false),
  isPiBinaryAvailable: vi.fn().mockReturnValue(false),
}));

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
  // /prs classifies dependency PRs through dependency-prs.ts, which needs these.
  isDependabotPR: (pr: { author: { login: string } }) => pr.author.login === "dependabot[bot]" || pr.author.login === "app/dependabot",
  normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
  getQueueSnapshot: vi.fn().mockReturnValue({ items: [], oldestFetchAt: null }),
  enrichQueueItemsWithPRStatus: vi.fn().mockResolvedValue(undefined),
  mergePR: vi.fn().mockResolvedValue(undefined),
  removeQueueItem: vi.fn(),
  listRepos: vi.fn().mockResolvedValue([
    { owner: "org", name: "repo", fullName: "org/repo" },
    { owner: "test", name: "repo", fullName: "test/repo" },
  ]),
  listOpenIssues: vi.fn().mockResolvedValue([]),
  // Stubbed to "complete", never re-implemented: a copy of the real predicate
  // here would hardcode `OPEN_ISSUE_LIMIT` and drop its `isForgejoRepo` half,
  // so raising the page limit would leave the board's truncation test passing
  // against a threshold production no longer uses. The predicate itself is
  // pinned in github.test.ts; what the board owes is to report whatever it says.
  openIssuesMayBeTruncated: vi.fn().mockReturnValue(false),
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
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
  createBranchRef: vi.fn().mockResolvedValue(undefined),
  putRepoFile: vi.fn().mockResolvedValue(undefined),
  createPR: vi.fn().mockResolvedValue(1),
  getPRState: vi.fn().mockResolvedValue(null),
  getPRChangedFiles: vi.fn().mockResolvedValue([]),
  infraPathsIn: vi.fn((files: string[]) => files.filter((p) => /(?:^|\/)(?:tofu|terraform)\//.test(p) || /\.tf$/.test(p))),
  // Mirrors issue-id.ts's `ISSUE_ID_RE`: `clw_` + 26 Crockford base32 chars.
  isNativeIssue: vi.fn((ref: unknown) => typeof ref === "string" && /^[cC][lL][wW]_[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/.test(ref.trim())),
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
  return { ...actual, finalizeMergedClawsPR: vi.fn(actual.finalizeMergedClawsPR) };
});

// The Claws-native issue store behind /issues/new, /issues/:id and its
// mutation routes (#3215).
const mockClawsIssues = vi.hoisted(() => ({
  CLAWS_NATIVE_LOGIN: "claws",
  primaryRepo: (repos: readonly string[]) => [...repos].sort()[0] ?? "",
  listUnassignedOpenIssues: vi.fn(async () => [] as any[]),
  listOpenIssuesNaming: vi.fn(async () => [] as any[]),
  listClosedIssuesSince: vi.fn(async (_repo: string, _since: Date, _limit: number) => [] as any[]),
  getIssue: vi.fn(async (_ref: string) => undefined as any),
  getIssueBodyHtml: vi.fn(async (_ref: string) => ""),
  listCommentDetails: vi.fn(async (_ref: string) => [] as any[]),
  listPlans: vi.fn(async (_ref: string) => [] as any[]),
  getLatestPlansForOpenIssues: vi.fn(async () => new Map<string, any>()),
  listRequirements: vi.fn(async (_ref: string) => [] as any[]),
  createIssue: vi.fn(async (_input: any) => "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"),
  findOpenIssueByDedupeKey: vi.fn(async (_primary: string, _key: string) => undefined as any),
  listOpenIssuesTouching: vi.fn(async (_repos: readonly string[]) => [] as any[]),
  commentOnIssue: vi.fn(async (_repo: string, _ref: string, _body: string, _login: string): Promise<string | null> => "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC"),
  dashboardIssueUrl: (ref: string) => `https://claws.example/issues/${ref}`,
  dashboardSessionUrl: (id: string) => `https://claws.example/sessions/${id}`,
  reopenIssue: vi.fn(async (_ref: string) => {}),
  setLifecycle: vi.fn(async (_repo: string, _ref: string, _lifecycle: string) => {}),
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
}));
vi.mock("./claws-issues.js", () => mockClawsIssues);

// reapproval.test.ts covers the approval itself; these pin only the routing.
const mockReapproval = vi.hoisted(() => ({
  hasPendingReapproval: vi.fn(async (_id: string) => false),
  promoteReapproval: vi.fn(async (_id: string, _by: string) => true),
}));
vi.mock("./reapproval.js", () => mockReapproval);

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

const agentPodOps = vi.hoisted(() => ({
  executeAgentPodOp: vi.fn(),
  agentPodTokenLive: (row: { status: string }) => row.status === "running",
}));
vi.mock("./agent-pod-ops.js", () => agentPodOps);

vi.mock("./db.js", () => ({
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
  setBlogDraftPushed: vi.fn(),
  clearBlogDraftPR: vi.fn(),
  resetCIFixerBreakerGrants: vi.fn(),
  recordSessionPrAction: vi.fn(async () => {}),
  getRecentSessionModels: vi.fn().mockReturnValue([]),
  rememberSessionCapabilityDefaults: vi.fn(async () => {}),
  getAllSessionCapabilityDefaults: vi.fn(async () => new Map<string, string[]>()),
  getImportedIssueByNative: vi.fn(async (_nativeId: string) => undefined as any),
  getIssueModelPlanRows: vi.fn(async () => [] as any[]),
  // model-plan.ts reads a native issue's repos to find its primary repo.
  getClawsIssue: vi.fn(async () => undefined),
  listExplicitIssueModelPlanRows: vi.fn(async () => [] as any[]),
  listClawsIssueAttachments: vi.fn(async (_issueId: string) => [] as any[]),
  upsertIssueModelPlanCell: vi.fn(async () => true),
  deleteIssueModelPlanCell: vi.fn(async () => {}),
  listOpenClawsIssues: vi.fn(async (_filter?: { repo?: string; unassigned?: boolean; label?: string }) => [] as any[]),
  getClawsPr: vi.fn(async (_repo: string, _prNumber: number) => null as any),
  listClawsPrs: vi.fn(async (_repo: string) => [] as any[]),
  listClawsPrsForIssue: vi.fn(async (_issueId: string) => [] as any[]),
  getIssuePlannedPRs: vi.fn(async (_issueId: string) => [] as any[]),
  getIssueIdsAwaitingOperator: vi.fn(async (_issueIds: readonly string[]) => new Map<string, { position: number; title: string }>()),
  getIssueBlockedReasons: vi.fn(async (_issueIds: readonly string[]) => new Map<string, string>()),
  getIssueReapproval: vi.fn(async (_issueId: string): Promise<unknown> => null),
  listPendingReapprovalIssueIds: vi.fn(async (_issueIds?: readonly string[]) => new Set<string>()),
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
    setDescription: vi.fn(async (_id: string, _description: string) => ({ ok: true, description: "my description" as string | null })),
    resummarize: vi.fn(async (_id: string) => ({ ok: true, description: "auto summary" as string | null })),
    setAgentStatus: vi.fn(async (_id: string, status: "working" | "monitoring" | "waiting" | "done") => ({ ok: true, status, updatedAt: 1234 })),
    grantCapability: vi.fn(async (): Promise<any> => ({ ok: false, reason: "not-found" })),
    grantDelivery: vi.fn(async (): Promise<any> => ({ ok: false, reason: "not-found" })),
    revokeCapability: vi.fn(async (): Promise<any> => ({ ok: false, reason: "not-found" })),
    verifyMcpToken: vi.fn(async () => "denied" as const),
    recordPodExit: vi.fn(async () => "denied" as const),
  },
}));
vi.mock("./session-backend-k8s.js", () => ({ getK8sSessionBackend: () => mockSessionBackend }));

vi.mock("./transcribe.js", () => ({
  transcribe: vi.fn(async () => "hello from the voice note"),
  isAvailable: vi.fn(() => true),
  voiceVocabularyPrompt: vi.fn(() => "Kwyjibo, Claws, GitHub"),
}));

import { formatUptime, buildLogDetailPage, buildIssueLogsPage } from "./server.js";
import type { Theme } from "./server.js";
import { createServer } from "./server.js";
import { DERIVED_COLUMN_REJECTION } from "./issue-board.js";
import { REPO_JOB_NAMES } from "./pages/jobs-matrix.js";
import { getEndedSession } from "./sessions.js";
import { transcribe, isAvailable } from "./transcribe.js";
import { isProviderRateLimited } from "./claude.js";
import type { Scheduler } from "./scheduler.js";

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
  options?: { headers?: Record<string, string>; body?: string },
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
afterEach(async () => {
  const configMod = await import("./config.js");
  for (const k of ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_BASE_URL", "OIDC_APPLICATION_SLUG"]) {
    (configMod as Record<string, unknown>)[k] = "";
  }
  testSessionCookie = null;
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
    server = createServer(scheduler);
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
    expect(res.body).toContain("githubOwners");
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
    expect(body.githubOwners).toEqual(["owner1"]);
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
        opencode: { enabled: false, weight: 1 },
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
    expect(mockSessionBackend.create).toHaveBeenCalledWith({ repo: "org/a", mode: "repo-claude", capabilities: [], provider: "claude", model: "opus" });
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
    expect(mockSessionBackend.create).toHaveBeenCalledWith({ repo: "org/a", mode: "repo-claude", capabilities: [], provider: "opencode", model: "openrouter/x/y" });
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
    expect(mockSessionBackend.createMulti).toHaveBeenCalledWith({ repos: ["org/a", "org/b"], capabilities: [], provider: "codex", model: "gpt-5.6-luna" });
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
    expect(mockSessionBackend.createMulti).toHaveBeenCalledWith({ repos: ["org/a", "org/b"], capabilities: [], provider: "codex", model: "gpt-5.6-luna" });
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
    (claude.getProviderRateLimitedUntil as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      p === "claude" ? 1234567890000 : null,
    );
    const res = await request(server, "GET", "/api/providers");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claude).toEqual({
      rateLimited: true,
      rateLimitedUntil: new Date(1234567890000).toISOString(),
      authExpired: false,
    });
    expect(body.codex).toEqual({ rateLimited: false, rateLimitedUntil: null, authExpired: false });
    expect(body.opencode).toEqual({ rateLimited: false, rateLimitedUntil: null, authExpired: false });
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
    expect(claude.clearProviderRateLimitState).toHaveBeenCalledWith("claude");
    expect(slack.notify).toHaveBeenCalledWith('[dashboard] Cleared rate-limit cooldown for provider "claude"');
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
    server = createServer(mockScheduler());
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

describe("GET /api/auth/status", () => {
  async function withServer(fn: (s: http.Server) => Promise<void>): Promise<void> {
    const s = createServer(mockScheduler());
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
    const s = createServer(sched);
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
    const s = createServer(sched);
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

describe("POST /jobs", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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

describe("POST /damp/reading", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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
    expect(res.body).toContain("View on GitHub");
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

describe("Dashboard action Slack notifications", () => {
  let server: http.Server;
  let notifyFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).NOTIFY_DASHBOARD_ACTIONS = true;
    const slackMod = await import("./slack.js");
    notifyFn = slackMod.notify as ReturnType<typeof vi.fn>;
    notifyFn.mockClear();
    server = createServer(mockScheduler());
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

  it("sends notification on pause", async () => {
    await request(server, "POST", "/pause/ci-fixer");
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining('[dashboard] Job "ci-fixer" paused'));
  });

  it("sends notification on resume", async () => {
    await request(server, "POST", "/pause/ci-fixer");
    notifyFn.mockClear();
    await request(server, "POST", "/pause/ci-fixer");
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining('[dashboard] Job "ci-fixer" resumed'));
  });

  it("does not send notification for unknown job (404)", async () => {
    await request(server, "POST", "/pause/nonexistent-job");
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("sends notification on WhatsApp pair success", async () => {
    const res = await request(server, "GET", "/whatsapp/pair");
    expect(res.status).toBe(200);
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] WhatsApp paired"));
  });

  it("sends notification on WhatsApp unpair", async () => {
    await request(server, "POST", "/whatsapp/unpair");
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] WhatsApp unpaired"));
  });

  it("sends notification on config save with changed fields", async () => {
    await request(server, "POST", "/config", {
      body: "logRetentionDays=7&logRetentionPerJob=20&githubOwners=owner1&selfRepo=owner1%2Frepo1&authToken=&notifyDashboardActions=true&enabledAgent_planner=true&enabledAgent_implementer=true&enabledAgent_ci-fixer=true&enabledAgent_review-addresser=true&enabledAgent_reviewer=true&enabledAgent_merger=true",
    });
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] Config updated:"));
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("logRetentionDays"));
    // Unchanged fields should not appear in the notification
    expect(notifyFn).not.toHaveBeenCalledWith(expect.stringContaining("selfRepo"));
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

  it("does not send notification when NOTIFY_DASHBOARD_ACTIONS is false", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).NOTIFY_DASHBOARD_ACTIONS = false;
    await request(server, "POST", "/pause/ci-fixer");
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("does not notify on session-lifecycle / triage actions", async () => {
    await request(server, "POST", "/queue/mark-refined", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("does not leak client-supplied X-Forwarded-For into notifications", async () => {
    await request(server, "POST", "/pause/ci-fixer", {
      headers: { "x-forwarded-for": "192.168.1.100" },
    });
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] Job"));
    expect(notifyFn).not.toHaveBeenCalledWith(expect.stringContaining("192.168.1.100"));
    expect(notifyFn).not.toHaveBeenCalledWith(expect.stringContaining("from "));
  });

  describe("Mark Refined Endpoint", () => {
    it("POST /queue/mark-refined marks an issue as refined", async () => {
      const { addLabel, removeQueueItem } = await import("./github.js");
      const res = await request(
        server,
        "POST",
        "/queue/mark-refined",
        { body: JSON.stringify({ repo: "test/repo", number: 123 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
      expect(addLabel).toHaveBeenCalledWith("test/repo", 123, "Refined");
      expect(removeQueueItem).toHaveBeenCalledWith("test/repo", 123);
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
    beforeEach(async () => {
      const { ensureLabel, addLabel, removeQueueItem } = await import("./github.js");
      (ensureLabel as ReturnType<typeof vi.fn>).mockClear();
      (addLabel as ReturnType<typeof vi.fn>).mockClear();
      (removeQueueItem as ReturnType<typeof vi.fn>).mockClear();
    });

    it("POST /queue/mark-automerge ensures and applies the Automerge label", async () => {
      const { ensureLabel, addLabel } = await import("./github.js");
      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 201 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
      expect(ensureLabel).toHaveBeenCalledWith("test/repo", "Automerge");
      expect(addLabel).toHaveBeenCalledWith("test/repo", 201, "Automerge");
    });

    // A PR Claws tracks records who approved it, before the label goes on.
    it("POST /queue/mark-automerge records the session's approval on a tracked PR's row first", async () => {
      const { addLabel } = await import("./github.js");
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
      expect(vi.mocked(db.upsertClawsPr).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(addLabel).mock.invocationCallOrder[0]);
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
      expect(addLabel).toHaveBeenCalledWith("test/repo", 203, "Automerge");
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

    it("POST /queue/mark-automerge with alsoRefine also adds Refined and removes the queue item", async () => {
      const { addLabel, removeQueueItem } = await import("./github.js");
      const res = await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 202, alsoRefine: true }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(addLabel).toHaveBeenCalledWith("test/repo", 202, "Automerge");
      expect(addLabel).toHaveBeenCalledWith("test/repo", 202, "Refined");
      expect(removeQueueItem).toHaveBeenCalledWith("test/repo", 202);
    });

    it("POST /queue/mark-automerge without alsoRefine does not add Refined or remove the queue item", async () => {
      const { addLabel, removeQueueItem } = await import("./github.js");
      await request(
        server,
        "POST",
        "/queue/mark-automerge",
        { body: JSON.stringify({ repo: "test/repo", number: 203 }), headers: { "content-type": "application/json" } },
      );
      expect(addLabel).not.toHaveBeenCalledWith("test/repo", 203, "Refined");
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

    it("POST /queue/clear-manual-action removes Manual Action, which the label hook mirrors into the row", async () => {
      const { removeLabel } = await import("./github.js");
      (removeLabel as ReturnType<typeof vi.fn>).mockClear();
      const res = await request(
        server,
        "POST",
        "/queue/clear-manual-action",
        { body: JSON.stringify({ repo: "test/repo", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ result: "ok" });
      expect(removeLabel).toHaveBeenCalledWith("test/repo", 456, "Manual Action");
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

    it("POST /queue/clear-manual-action returns 500 when the removal is unconfirmed", async () => {
      const { removeLabel } = await import("./github.js");
      (removeLabel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      const res = await request(
        server,
        "POST",
        "/queue/clear-manual-action",
        { body: JSON.stringify({ repo: "test/repo", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toContain("Failed to remove the Manual Action label");
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

    it("POST /queue/clear-manual-action returns 500 when the forge label clears but its row write fails", async () => {
      const { removeLabel } = await import("./github.js");
      (removeLabel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("could not mirror label Manual Action removed: db down"));
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
    server = createServer(mockScheduler());
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
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: "u1", email: "u@example.com" }) }),
    );
    const cb = await request(server, "GET", `/auth/callback?state=${state}&code=test`);
    vi.unstubAllGlobals();
    expect(cb.headers.location).toBe("/");
  });

  it("double-slash in next= is sanitized: final redirect goes to /", async () => {
    const loginRes = await request(server, "GET", "/login?next=%2F%2Fevil.example");
    expect(loginRes.status).toBe(302);
    const authUrl = new URL(loginRes.headers.location!);
    const state = authUrl.searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: "u1", email: "u@example.com" }) }),
    );
    const cb = await request(server, "GET", `/auth/callback?state=${state}&code=test`);
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

describe("requireApiAuth — MCP token decoupling", () => {
  let server: http.Server;

  beforeEach(async () => {
    // This suite exercises the MCP token path with no session present.
    testSessionCookie = null;
    server = createServer(mockScheduler());
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
    const res = await request(server, "GET", "/api/events?timeout=0", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.bootId).toBe("string");
    expect(typeof body.lastId).toBe("number");
    expect(body.restarted).toBe(false);
    expect(body.events).toEqual([]);
  });

  it("accepts the requirements-stored and stage-changed kinds on /api/events and filters them by item", async () => {
    const { recordGitHubEvent } = await import("./github-events.js");
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
    }]);
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
      plan: "### Requirement\nx",
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
    server = createServer(mockScheduler());
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
    ["GET", "/ha-upgrader"],
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
    ["POST", "/sessions/abc/kill"],
    ["POST", "/sessions/abc/capabilities"],
    ["DELETE", "/sessions/abc/capabilities/ssh%3Anas"],
    ["POST", "/logs/abc-123/cancel"],
  ];

  beforeEach(async () => {
    // OIDC is enabled by the global beforeEach; deny everything by sending no session.
    testSessionCookie = null;
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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
    server = createServer(mockScheduler());
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
    setDescription: vi.fn(async () => ({ ok: false, description: null })),
    resummarize: vi.fn(async () => ({ ok: false, description: null })),
    grantCapability: vi.fn(async (id: string, capId: string) => (
      id === "abc123" ? unavailable
        : capId === "browser" ? { ok: false as const, reason: "invalid" as const, detail: "browser cannot be granted to this session" }
          : id === "def456" ? { ok: true as const, live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: home-assistant", delayed: true }
            : { ok: false as const, reason: "not-found" as const }
    )),
    grantDelivery: vi.fn(async () => unavailable),
    revokeCapability: vi.fn(async (id: string, capId: string) => (
      id === "abc123" ? unavailable
        : !capId.startsWith("ssh:") ? { ok: false as const, reason: "invalid" as const, detail: `${capId} cannot be revoked from this session` }
          : id === "def456" ? { ok: true as const, live: true, keysRemoved: capId === "ssh:nas" }
            : { ok: false as const, reason: "not-found" as const }
    )),
    setAgentStatus: vi.fn(async (_id: string, status: "working" | "monitoring" | "waiting" | "done") => ({ ok: false, status, updatedAt: 0 })),
    recordPodExit: vi.fn(async (id: string, token: string): Promise<"ok" | "denied" | "unavailable"> => (
      id === "abc123" ? "unavailable" : token === "term-tok" ? "ok" : "denied"
    )),
  };

  beforeEach(async () => {
    const { setSessionBackendForTests } = await import("./session-backend.js");
    setSessionBackendForTests(fakeBackend);
    server = createServer(mockScheduler());
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

  it("still redirects to the new session when remembering the defaults fails", async () => {
    const { rememberSessionCapabilityDefaults } = await import("./db.js");
    vi.mocked(rememberSessionCapabilityDefaults).mockRejectedValueOnce(new Error("db down"));
    fakeBackend.create.mockResolvedValueOnce({ ok: true, id: "abc123" } as never);
    const res = await request(server, "POST", "/sessions/create", { body: "repo=org%2Fa&mode=repo-claude&provider=claude" });
    expect(res.status).toBe(303);
  });

  it("maps repos-span-owners on create-multi to 400", async () => {
    fakeBackend.createMulti.mockResolvedValueOnce({ ok: false, reason: "repos-span-owners", detail: "org, other" } as never);
    const multi = await request(server, "POST", "/sessions/create-multi", { body: "repo=org%2Fa&repo=other%2Fb&provider=claude" });
    expect(multi.status).toBe(400);
    expect(multi.body).toContain("cannot be combined in one session");
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
      expect(JSON.parse(res.body)).toEqual({ live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: home-assistant", delayed: true });
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
      const res = await revoke("def456", "ssh:k3s");
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
  const live = (id: string) => ({
    ok: true as const,
    session: { id, repo: "org/a", cwd: "/tmp/x", mode: "repo-claude" as const, provider: "claude" as const, model: null, alive: true, summary: null, extraRepos: [], capabilities: [...rowCaps] },
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
    setDescription: vi.fn(async () => ({ ok: false, description: null })),
    resummarize: vi.fn(async () => ({ ok: false, description: null })),
    grantCapability: vi.fn(async (_id: string, capId: string) => {
      rowCaps.push(capId);
      markedCaps.push(capId);
      return { ok: true as const, live: true, loadPath, marker: `# claws-granted: ${capId}`, delayed: false };
    }),
    grantDelivery: vi.fn(async (_id: string, capId: string) => (markedCaps.includes(capId)
      ? { ok: true as const, live: true, loadPath, marker: `# claws-granted: ${capId}`, delayed: false }
      : { ok: true as const, live: true, loadPath: null, marker: null, delayed: false })),
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
    const store = await import("./capability-requests.js");
    store.get("abc123", capability)!.lastPolledAt = 0;
  };

  beforeEach(async () => {
    const { clearCapabilityRequestsForTests } = await import("./capability-requests.js");
    clearCapabilityRequestsForTests();
    rowCaps = ["cross-repo", "ssh:k3s"];
    markedCaps = [];
    fakeBackend.grantCapability.mockClear();
    fakeBackend.grantDelivery.mockClear();
    fakeBackend.revokeCapability.mockClear();
    const { setSessionBackendForTests } = await import("./session-backend.js");
    setSessionBackendForTests(fakeBackend);
    server = createServer(mockScheduler());
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
    expect(JSON.parse(res.body)).toMatchObject({ status: "pending", capability: "ssh:nas", label: "SSH: nas", reason: "check the ZFS pool" });

    const status = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(status.body)).toMatchObject({ status: "pending", capability: "ssh:nas" });
  });

  it("rejects a non-requestable capability with 400 listing the requestable ids", async () => {
    const res = await agentRequest({ capability: "browser", reason: "scrape" });
    expect(res.status).toBe(400);
    const { error } = JSON.parse(res.body) as { error: string };
    expect(error).toContain("ssh:nas");
    expect(error).not.toContain("ssh:k3s");
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
    const res = await agentRequest({ capability: "ssh:k3s", reason: "check the node" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "granted", capability: "ssh:k3s", loadPath: null, live: true });
    expect(JSON.parse(res.body).description).toContain("SSH into k3s");
  });

  it("returns 429 when the session already has five pending requests", async () => {
    const store = await import("./capability-requests.js");
    for (const cap of ["home-assistant", "forgejo", "ssh:ryzen", "forgejo-admin", "ssh:proxmox"]) {
      expect(store.request("abc123", cap, "r").ok).toBe(true);
    }
    expect((await agentRequest({ capability: "ssh:nas", reason: "r" })).status).toBe(429);
    // A repeat of an existing request is not a new pending entry.
    expect((await agentRequest({ capability: "ssh:proxmox", reason: "r" })).status).toBe(200);
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
      expect.objectContaining({ capability: "ssh:nas", label: "SSH: nas", reason: "<img src=x onerror=alert(1)>", status: "pending" }),
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
    expect(JSON.parse(grant.body)).toMatchObject({ agentPickedUp: false, agentNotice: expect.stringContaining('capability "ssh:nas"') });
    const status = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(status.body)).toMatchObject({ status: "granted", loadPath });
  });

  it("agent polls record lastPolledAt, and a granted response records grantSeenAt (#3106)", async () => {
    const store = await import("./capability-requests.js");
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    await stopPolling("ssh:nas");
    await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(store.get("abc123", "ssh:nas")!.lastPolledAt).toBeGreaterThan(0);
    await stopPolling("ssh:nas");
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    expect(store.get("abc123", "ssh:nas")!.lastPolledAt).toBeGreaterThan(0);
    expect(store.get("abc123", "ssh:nas")!.grantSeenAt).toBeNull();

    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve");
    expect(store.get("abc123", "ssh:nas")!.grantSeenAt).toBeNull();
    await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(store.get("abc123", "ssh:nas")!.grantSeenAt).toBeGreaterThan(0);
  });

  it("approval of a request the agent stopped waiting on returns the notice to type (#3106)", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "SECRET-REASON" });
    await stopPolling("ssh:nas");
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const approved = JSON.parse((await request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve")).body);
    expect(approved).toMatchObject({ status: "granted", agentPickedUp: false });
    expect(approved.agentNotice).toContain('Call claws_request_capability with capability "ssh:nas" and timeout_seconds 0');
    expect(approved.agentNotice).not.toContain("SECRET-REASON");
  });

  it("approval waits for a polling agent to collect the grant and sends no notice (#3106)", async () => {
    await agentRequest({ capability: "ssh:nas", reason: "r" });
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const approving = request(server, "POST", "/sessions/abc123/capability-requests/ssh%3Anas/approve");
    const store = await import("./capability-requests.js");
    const deadline = Date.now() + 2000;
    while (store.get("abc123", "ssh:nas")?.status !== "approved" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const polled = await request(server, "GET", "/api/sessions/abc123/capability-requests/ssh%3Anas", { headers: bearer });
    expect(JSON.parse(polled.body).status).toBe("granted");
    const approved = await approving;
    expect(JSON.parse(approved.body)).toMatchObject({ status: "granted", agentPickedUp: true, agentNotice: null });
  });

  it("the Grant control reports no agent fields without a pending request (#3106)", async () => {
    testSessionCookie = signSession("test-user", Date.now() + 60_000, TEST_OIDC_SECRET);
    const grant = await request(server, "POST", "/sessions/abc123/capabilities", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "ssh:nas" }),
    });
    expect(grant.status).toBe(200);
    const body = JSON.parse(grant.body);
    expect(body).not.toHaveProperty("agentPickedUp");
    expect(body).not.toHaveProperty("agentNotice");
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
    labels: ["Ready"],
    lifecycle: "awaiting-plan-review",
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
    server = createServer(mockScheduler());
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
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ autoPromote: false }));
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
      mockIssueLinks.listLinks.mockResolvedValueOnce([{ id: "cll_1", kind: "depends_on", otherId: OTHER, otherTitle: "The dependency", otherState: "open", otherStateReason: null, otherLifecycle: "ideas", releasedAt: null }]);
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
    const setLabel = (label: string, present: boolean, sid = SID) =>
      request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/labels`, { headers: API, body: JSON.stringify({ label, present }) });
    const withIssue = (patch: Record<string, unknown>) => mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, ...patch });

    beforeEach(async () => {
      const { setSessionBackendForTests } = await import("./session-backend.js");
      setSessionBackendForTests(fakeBackend as any);
    });

    afterEach(async () => {
      const { setSessionBackendForTests } = await import("./session-backend.js");
      setSessionBackendForTests(null);
    });

    it("applies Refined as the column route would, then removes it back to plan review, auditing each", async () => {
      const gh = await import("./github.js");
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      const on = await setLabel("Refined", true);
      expect(on.status).toBe(200);
      expect(JSON.parse(on.body)).toMatchObject({ ok: true, changed: true });
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "approved");
      expect(gh.commentOnIssue).toHaveBeenCalledWith("org/repo", NATIVE, "Session `abc123` applied **Refined**.");

      withIssue({ lifecycle: "approved" });
      mockClawsIssues.listPlans.mockResolvedValue([{ version: 1 }]);
      const off = await setLabel("Refined", false);
      expect(off.status).toBe(200);
      expect(mockClawsIssues.setLifecycle).toHaveBeenLastCalledWith("org/repo", NATIVE, "awaiting-plan-review");
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` removed **Refined**.");
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(2);
    });

    it("answers changed:false and posts nothing for a state already in place", async () => {
      const gh = await import("./github.js");
      withIssue({ lifecycle: "approved", labels: ["Refined", "Priority"] });
      for (const [label, present] of [["Refined", true], ["Blocked", false], ["Priority", true], ["Automerge", false]] as const) {
        const res = await setLabel(label, present);
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).changed).toBe(false);
      }
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
      expect(gh.addLabel).not.toHaveBeenCalled();
      expect(gh.removeLabel).not.toHaveBeenCalled();
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("refuses a Refined apply the column route would refuse", async () => {
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: true, openPrs: [] });
      const res = await setLabel("Refined", true);
      expect(res.status).toBe(409);
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    });

    it("refuses to remove Refined from an issue a running implementer has already picked up", async () => {
      // A running implementer outranks the Refined removal's target column, the
      // same landing check `POST /issues/:id/column` applies to a forward move —
      // dragging this card back to plan review must not undo a task in flight.
      withIssue({ lifecycle: "approved" });
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: true, openPrs: [] });
      const res = await setLabel("Refined", false);
      expect(res.status).toBe(409);
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    });

    it("sets and clears Blocked, clearing to where a dependency release sends the issue", async () => {
      expect((await setLabel("Blocked", true)).status).toBe(200);
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "blocked");
      withIssue({ lifecycle: "blocked" });
      mockClawsIssues.listPlans.mockResolvedValue([]);
      expect((await setLabel("Blocked", false)).status).toBe(200);
      expect(mockClawsIssues.demoteIssue).toHaveBeenCalledWith(NATIVE);
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

    it("adds and removes Priority", async () => {
      const gh = await import("./github.js");
      expect((await setLabel("Priority", true)).status).toBe(200);
      expect(gh.addLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Priority");
      withIssue({ labels: ["Priority"] });
      expect((await setLabel("Priority", false)).status).toBe(200);
      expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Priority");
    });

    it("approves the merge of every open PR as session:<sid>, and withdraws it", async () => {
      const gh = await import("./github.js");
      const db = await import("./db.js");
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [{ repo: "org/repo", prNumber: 7, mergeApprovedAt: null }] as any[] });
      const on = await setLabel("Automerge", true);
      expect(on.status).toBe(200);
      expect(JSON.parse(on.body)).toMatchObject({ changed: true, open_prs: 1 });
      expect(db.upsertClawsPr).toHaveBeenCalledWith("org/repo", 7, { mergeApprovedBy: "session:abc123", mergeApprovedAt: expect.any(String) });
      expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 7, "Automerge");
      expect(gh.addLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Automerge");

      withIssue({ labels: ["Automerge"] });
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [{ repo: "org/repo", prNumber: 7, mergeApprovedAt: "2026-09-26T00:00:00Z" }] as any[] });
      const off = await setLabel("Automerge", false);
      expect(off.status).toBe(200);
      expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 7, "Automerge");
      expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Automerge");
      expect(db.upsertClawsPr).toHaveBeenLastCalledWith("org/repo", 7, { mergeApprovedBy: null, mergeApprovedAt: null });
    });

    it("notes that the next PR inherits Automerge when none is open", async () => {
      const res = await setLabel("Automerge", true);
      expect(JSON.parse(res.body)).toMatchObject({ open_prs: 0, note: expect.stringContaining("next PR") });
    });

    it("refuses a label the Labels form does not offer", async () => {
      expect((await setLabel("Ready", true)).status).toBe(400);
      expect((await setLabel("Backlog", true)).status).toBe(400);
      expect((await setLabel("Claws Staging", true)).status).toBe(400);
      expect((await setLabel("Not A Label", true)).status).toBe(400);
    });

    it("adds and removes the Labels form's other labels, auditing each change", async () => {
      const gh = await import("./github.js");
      expect((await setLabel("Claws Ignore", true)).status).toBe(200);
      expect(gh.addLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Claws Ignore");
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` applied **Claws Ignore**.");
      withIssue({ labels: ["Claws Ignore"] });
      const same = await setLabel("Claws Ignore", true);
      expect(JSON.parse(same.body).changed).toBe(false);
      expect((await setLabel("Claws Ignore", false)).status).toBe(200);
      expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", NATIVE, "Claws Ignore");
      withIssue({});
      const absent = await setLabel("Claws Ignore", false);
      expect(JSON.parse(absent.body).changed).toBe(false);
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(2);
    });

    const setState = (body: Record<string, unknown>, sid = SID) =>
      request(server, "POST", `/api/sessions/${sid}/issues/${NATIVE}/state`, { headers: API, body: JSON.stringify(body) });

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
        clearCapabilityRequestsForSession("def456");
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
          spawnedBySession: SID, spawnedForIssue: NATIVE,
        }));
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
        expect(listPending("def456").map((r) => [r.capability, r.reason])).toEqual([["ssh:nas", "Requested by session abc123 at start: check the pool"]]);
      });

      it("rejects an unknown or launch-only capability before creating anything", async () => {
        const { classifyLiveGrants } = await import("./capabilities.js");
        expect((await startSession({ request_capabilities: ["not-a-capability"] })).status).toBe(400);
        const fixed = classifyLiveGrants(["cross-repo"], "k8s-pod").find((e) => e.state === "fixed");
        expect(fixed).toBeDefined();
        const res = await startSession({ request_capabilities: [fixed!.cap.id] });
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toContain("only grantable at launch");
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
        clearCapabilityRequestsForSession("def456");
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
          repo: null, mode: "home-claude", spawnedBySession: SID, spawnedForIssue: null,
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
        const fixed = classifyLiveGrants(["cross-repo"], "k8s-pod").find((e) => e.state === "fixed");
        expect(fixed).toBeDefined();
        expect((await startBare({ request_capabilities: [fixed!.cap.id] })).status).toBe(400);
        expect(fakeBackend.create).not.toHaveBeenCalled();
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

    const setColumn = (column: string) =>
      request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/column`, { headers: API, body: JSON.stringify({ column }) });

    it("moves the issue as the Status buttons do, as session:<sid>, and forwards their refusals", async () => {
      const gh = await import("./github.js");
      const moved = await setColumn("blocked");
      expect(moved.status).toBe(200);
      expect(JSON.parse(moved.body).changed).toBe(true);
      expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "blocked");
      expect(gh.commentOnIssue).toHaveBeenLastCalledWith("org/repo", NATIVE, "Session `abc123` moved this issue to blocked.");

      expect((await setColumn("done")).status).toBe(400);
      expect((await setColumn("implementing")).status).toBe(400);
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: true, openPrs: [] });
      const refused = await setColumn("approved");
      expect(refused.status).toBe(409);
      expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
    });

    it("answers changed:false for a move to the current column", async () => {
      const gh = await import("./github.js");
      mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
      const res = await setColumn("awaiting-plan-review");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).changed).toBe(false);
      expect(gh.commentOnIssue).not.toHaveBeenCalled();
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
        (sid = SID) => setLabel("Refined", true, sid),
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
        withIssue({ repos: ["zz/unmanaged"] });
        expect((await write()).status).toBe(403);
        withIssue({ state: "closed" });
        expect((await write()).status).toBe(409);
        withIssue({ repos: [] });
        expect((await write()).status).toBe(409);
        withIssue({});
      }
      const forge = await request(server, "POST", `/api/sessions/${SID}/issues/42/labels`, { headers: API, body: JSON.stringify({ label: "Refined", present: true }) });
      expect(forge.status).toBe(404);
      expect(JSON.parse(forge.body).error).toContain("gh issue edit");
      expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
      expect(mockClawsIssues.promoteIssue).not.toHaveBeenCalled();
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
        withIssue({ repos: ["zz/unmanaged"] });
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
      const res = await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/labels`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Refined", present: true }) });
      expect(res.status).toBe(401);
    });

    it("refuses the shared internal token and an agent pod's own token — every agent holds one of those", async () => {
      // apiAuthMiddleware accepts both, but these three routes approve a native
      // issue's plan or merge, so neither may pass here — an agent must not be
      // able to grant itself that.
      const sharedToken = { authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };
      const agentPodToken = { authorization: "Bearer agent-pod-token", "content-type": "application/json" };
      for (const headers of [sharedToken, agentPodToken]) {
        expect((await request(server, "POST", `/api/sessions/${SID}/issues/${NATIVE}/labels`, { headers, body: JSON.stringify({ label: "Refined", present: true }) })).status).toBe(401);
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

      it("removes Manual Action through the label hook and audits the PR as this session", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ manualActionReason: "set prod secrets" }) as any);
        const res = await clear({ repo: "org/repo", number: 7 });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({ ok: true, changed: true, reason: "set prod secrets" });
        expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 7, "Manual Action");
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

      it("returns 500 without an audit comment when the removal is unconfirmed", async () => {
        const gh = await import("./github.js");
        const db = await import("./db.js");
        vi.mocked(db.getClawsPr).mockResolvedValueOnce(openPrRow({ manualActionReason: "set prod secrets" }) as any);
        vi.mocked(gh.removeLabel).mockResolvedValueOnce(false);
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
        labels: ["Ready"],
        repos: ["org/repo"],
        plan: { version: 1, comment_id: PLAN_COMMENT, body: "Do the thing" },
        previous_plans: [],
      });
      expect(body.comments.map((c: any) => c.id)).toEqual(["clwc_2", "clwc_3"]);
      expect(body.comments).toContainEqual(expect.objectContaining({ id: "clwc_2", author_login: "claws", is_claws: true, is_plan: false }));
      expect(body.comments).toContainEqual(expect.objectContaining({ id: "clwc_3", author_login: "stjohnb", is_claws: false, is_plan: false }));
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
      const { listOpenClawsIssues } = await import("./db.js");
      vi.mocked(listOpenClawsIssues).mockResolvedValueOnce([{ ...nativeIssue }] as any);
      mockClawsIssues.getLatestPlansForOpenIssues.mockResolvedValueOnce(new Map([[NATIVE, { version: 1 }]]) as any);

      const res = await request(server, "GET", "/api/issues?repo=ORG%2FREPO", { headers: API });

      expect(res.status).toBe(200);
      expect(listOpenClawsIssues).toHaveBeenCalledWith({ repo: "org/repo", repoMatch: "any" });
      expect(JSON.parse(res.body)).toEqual({
        issues: [{ id: NATIVE, title: nativeIssue.title, state: "open", labels: ["Ready"], repos: ["org/repo"], primary_repo: "org/repo", updated_at: nativeIssue.updated_at, has_plan: true, dedupe_key: null, stage: "awaiting-plan-review", stage_title: "Awaiting plan review" }],
        truncated: false,
      });
    });

    it("lists every open issue without a repo filter", async () => {
      const { listOpenClawsIssues } = await import("./db.js");
      vi.mocked(listOpenClawsIssues).mockResolvedValueOnce([]);

      const res = await request(server, "GET", "/api/issues", { headers: API });

      expect(res.status).toBe(200);
      expect(listOpenClawsIssues).toHaveBeenCalledWith({});
      expect(JSON.parse(res.body)).toEqual({ issues: [], truncated: false });
    });

    it("caps the list at 100 issues and reports truncated: true", async () => {
      const { listOpenClawsIssues } = await import("./db.js");
      const records = Array.from({ length: 101 }, (_, i) => ({ ...nativeIssue, id: `clw_${i}` }));
      vi.mocked(listOpenClawsIssues).mockResolvedValueOnce(records as any);
      mockClawsIssues.getLatestPlansForOpenIssues.mockResolvedValueOnce(new Map() as any);
      const res = await request(server, "GET", "/api/issues", { headers: API });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.issues).toHaveLength(100);
      expect(body.truncated).toBe(true);
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
        const { listOpenClawsIssues } = await import("./db.js");
        const none = { ...IDEAS, id: "clw_none" };
        const review = { ...IDEAS, id: "clw_review" };
        const approved = { ...APPROVED, id: "clw_approved" };
        vi.mocked(listOpenClawsIssues).mockResolvedValueOnce([none, review, approved] as any);
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
        const { listOpenClawsIssues } = await import("./db.js");
        vi.mocked(listOpenClawsIssues).mockResolvedValueOnce([{ ...IDEAS }] as any);
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
        (id === ATT ? { row: row({ filename: file, size: data === null ? 4 : Buffer.byteLength(data), ...overrides }), absolutePath } : undefined));
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

  it("POST /issues files to the backlog when the form asks, and only then", async () => {
    await request(server, "POST", "/issues", { body: "title=Later&repo=org%2Frepo&label=Backlog" });
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ labels: [] }));

    await request(server, "POST", "/issues", { body: "title=Later&repo=org%2Frepo&label=Priority&backlog=1" });
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({ labels: ["Priority", "Backlog"] }));
  });

  it("POST /issues files a multi-repo issue to the backlog", async () => {
    const res = await request(server, "POST", "/issues", {
      body: "title=Later&repo=org%2Frepo&repo=test%2Frepo&backlog=1",
    });

    expect(res.status).toBe(303);
    expect(mockClawsIssues.createIssue).toHaveBeenLastCalledWith(expect.objectContaining({
      repos: ["org/repo", "test/repo"],
      labels: ["Backlog"],
    }));
  });

  it("POST /issues refuses to file an unassigned issue to the backlog", async () => {
    const res = await request(server, "POST", "/issues", { body: "title=Later&backlog=1" });

    expect(res.status).toBe(409);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("POST /issues rejects a blank title", async () => {
    const res = await request(server, "POST", "/issues", { body: "title=+&body=x" });
    expect(res.status).toBe(400);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  describe("POST /api/issues (#3286)", () => {
    const auth = { Authorization: "Bearer test-internal-mcp-token", "content-type": "application/json" };

    it("creates the issue as claws when no sessionId is given, and drops state/unknown labels into ignoredLabels", async () => {
      const res = await request(server, "POST", "/api/issues", {
        headers: auth,
        body: JSON.stringify({ title: "Companion change", body: "Needed", repos: ["org/repo"], labels: ["Priority", "Ready", "Bogus"] }),
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
        ignoredLabels: ["Ready", "Bogus"],
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
      { id: PLAN_COMMENT, body: "plan comment body", body_html: "<p>PLAN COMMENT HTML</p>", login: "claws", createdAt: "2026-09-21T09:00:00.000Z" },
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD3", body: "reply", body_html: "<p>HUMAN REPLY</p>", login: "stjohnb", createdAt: "2026-09-21T09:10:00.000Z" },
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
      { id: REQ_COMMENT, body: "requirements comment", body_html: "<p>REQ COMMENT HTML</p>", login: "claws", createdAt: "2026-09-21T08:00:00.000Z" },
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD5", body: "reply", body_html: "<p>HUMAN REPLY</p>", login: "stjohnb", createdAt: "2026-09-21T09:10:00.000Z" },
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
    expect(drafting.body).toContain("Promote to Planning");
  });

  it("GET /issues/:id hides a legacy requirements comment no version links to", async () => {
    mockClawsIssues.listCommentDetails.mockResolvedValueOnce([
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD6", body: "*— Automated by Claws · Requirements writer —*\n\n## Requirements\n\nOld", body_html: "<p>LEGACY REQ COMMENT</p>", login: "claws", createdAt: "2026-09-21T08:00:00.000Z" },
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD7", body: "*— Automated by Claws —*\n\nA status note", body_html: "<p>STATUS NOTE</p>", login: "claws", createdAt: "2026-09-21T08:05:00.000Z" },
      { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD5", body: "reply", body_html: "<p>HUMAN REPLY</p>", login: "stjohnb", createdAt: "2026-09-21T09:10:00.000Z" },
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
        (id === ATT ? { row: attachmentRow(), absolutePath: pathMod.join(storeDir, "shot.png") } : undefined));
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
        absolutePath: (await import("node:path")).join(storeDir, "shot.png"),
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

    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: ["Ready", "Priority"] });

    const res = await request(server, "POST", `/issues/${NATIVE}/labels`, { body: "label=Automerge" });

    expect(res.status).toBe(303);
    expect(addLabelFn).toHaveBeenCalledWith("org/repo", NATIVE, "Automerge");
    expect(removeLabelFn).toHaveBeenCalledWith("org/repo", NATIVE, "Priority");
  });

  // `Refined` on an approved issue is read off its lifecycle field, and the
  // form no longer offers it — so an unticked box must not reset the issue to
  // Ideas, and a hand-sent one must not set it.
  it("POST /issues/:id/labels leaves the lifecycle state alone", async () => {
    const { addLabel: addLabelFn, removeLabel: removeLabelFn } = await import("./github.js");
    mockClawsIssues.getIssue.mockResolvedValue({ ...nativeIssue, labels: ["Refined"], lifecycle: "approved" });

    await request(server, "POST", `/issues/${NATIVE}/labels`, { body: "label=Blocked" });

    expect(addLabelFn).not.toHaveBeenCalled();
    expect(removeLabelFn).not.toHaveBeenCalled();
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
  });

  it("POST /issues/:id/column sets the lifecycle state and redirects back", async () => {
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);
    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved" });

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/issues/${NATIVE}`);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "approved");
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

  it("POST /issues/:id/column applies Automerge after the lifecycle write when column=approved&automerge=1", async () => {
    const { addLabel: addLabelFn } = await import("./github.js");
    mockClawsIssues.listPlans.mockResolvedValue([PLAN_ROW]);

    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=approved&automerge=1" });

    expect(res.status).toBe(303);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "approved");
    expect(addLabelFn).toHaveBeenCalledWith("org/repo", NATIVE, "Automerge");
    const setLifecycleOrder = mockClawsIssues.setLifecycle.mock.invocationCallOrder[0];
    const addLabelOrder = vi.mocked(addLabelFn).mock.invocationCallOrder[0];
    expect(setLifecycleOrder).toBeLessThan(addLabelOrder);
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

  it("POST /issues/:id/column adds no label when automerge=1 but the column is not approved", async () => {
    const { addLabel: addLabelFn } = await import("./github.js");

    const res = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=blocked&automerge=1" });

    expect(res.status).toBe(303);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "blocked");
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
    const derived = await Promise.all(["implementing", "pr-progressing", "pr-stalled", "awaiting-merge"].map((column) =>
      request(server, "POST", `/issues/${NATIVE}/column`, { body: `column=${column}` })));
    const inProgress = await request(server, "POST", `/issues/${NATIVE}/column`, { body: "column=in-progress" });
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
    // `clearAllMocks` clears calls, not implementations, so the truncation test
    // below would otherwise report its repository short for every test after it.
    vi.mocked(gh.openIssuesMayBeTruncated).mockReturnValue(false);
    // Same reason: a test that sets `mockResolvedValue` (not `…Once`) on this —
    // a forge ref's shadow — would otherwise leak it into every later test.
    mockResolveTrackerId.mockReset().mockResolvedValue(null);
    // Planless unless a test says otherwise (`withPlan`); reset rather than
    // cleared, so one test's plan does not leak into the next.
    mockClawsIssues.listPlans.mockReset().mockResolvedValue([]);
    vi.mocked(gh.getIssueComments).mockReset().mockResolvedValue([]);
    mockClawsIssues.listClosedIssuesSince.mockResolvedValue([]);
    mockClawsIssues.listUnassignedOpenIssues.mockResolvedValue([]);
    mockClawsIssues.getIssue.mockResolvedValue(undefined);
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
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

  it("GET /board places each repo's open issues in the column its labels imply", async () => {
    const gh = await githubMock();
    vi.mocked(gh.listOpenIssues).mockImplementation(async (repo: string) =>
      (repo === "org/repo"
        ? [{ number: 42, title: "Needs a plan", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 43, title: "Approved thing", body: "", labels: [{ name: "Refined" }], author: { login: "stjohnb" } }]
        : []));

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    // The column, not just the card: `data-ref` alone passes with `columnFor`
    // returning `drafting` for everything.
    expect(res.body).toContain(`data-ref="42" data-column="drafting"`);
    expect(res.body).toContain(`data-ref="43" data-column="approved"`);
    expect(res.body).toContain("Approved thing");
    // Both halves of the Done bound are the caller's, not the query's: the
    // 8-hour window and the per-repo row cap are arguments, so nothing else
    // here would notice them widening.
    expect(mockClawsIssues.listClosedIssuesSince).toHaveBeenCalledWith("org/repo", expect.any(Date), 50);
    const since = mockClawsIssues.listClosedIssuesSince.mock.calls[0][1] as Date;
    expect(Math.abs(since.getTime() - (Date.now() - 8 * 60 * 60 * 1000))).toBeLessThan(5000);
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
  it("GET /board reports a repository whose open issues were truncated", async () => {
    const gh = await githubMock();
    vi.mocked(gh.openIssuesMayBeTruncated).mockImplementation((repo: string) => repo === "org/repo");

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    // `escapeHtml` leaves an apostrophe alone, so the sentence reaches the page
    // verbatim — matching it with a wildcard would cover for a corrupted render.
    expect(res.body).toContain("1 of the board's sources loaded incompletely");
  });

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
           { number: 43, title: "Forge some day", body: "", labels: [{ name: "Backlog" }], author: { login: "stjohnb" }, updatedAt: "2026-09-20T10:00:00Z" },
           // A native issue reads its lifecycle as the Backlog label.
           { number: clwBacklog, title: "Native some day", body: "", labels: [{ name: "Backlog" }], author: { login: "stjohnb" }, updatedAt: "2026-09-21T10:00:00Z" }]
        : [{ number: 7, title: "Elsewhere later", body: "", labels: [{ name: "Backlog" }], author: { login: "stjohnb" } }]));

    const res = await request(server, "GET", "/backlog");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Forge some day");
    expect(res.body).toContain("Native some day");
    expect(res.body).toContain("Elsewhere later");
    expect(res.body).not.toContain("In play");
    // Newest first within the repository.
    expect(res.body.indexOf("Native some day")).toBeLessThan(res.body.indexOf("Forge some day"));
    expect(res.body).toContain(`name="only" value="org/repo#43"`);

    const filtered = await request(server, "GET", "/backlog?repo=org%2Frepo");
    expect(filtered.body).toContain("Forge some day");
    expect(filtered.body).not.toContain("Elsewhere later");
  });

  it("POST /backlog/promote takes one issue out of the backlog and returns to the filtered list", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Backlog"] });

    const res = await request(server, "POST", "/backlog/promote", {
      body: "repo=org%2Frepo&label=&item=org%2Frepo%2342&item=org%2Frepo%2343&only=org%2Frepo%2342",
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/backlog?repo=org%2Frepo");
    // `only` wins over the ticked items: the row's own button was pressed.
    expect(gh.removeLabel).toHaveBeenCalledTimes(1);
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Backlog");
    expect(gh.addLabel).not.toHaveBeenCalled();
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
    const res = await request(server, "POST", "/backlog/promote", { body: "repo=" });
    expect(res.status).toBe(400);
  });

  it("POST /board/move to backlog relabels a forge issue, removing the state labels it holds", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready", "bug"] });

    const res = await move({ repo: "org/repo", ref: 42, to: "backlog" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "ok", column: "backlog" });
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Backlog");
    expect(gh.removeLabel).toHaveBeenCalledTimes(1);
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Ready");
  });

  it("POST /board/move to backlog sets a native issue's lifecycle", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: ["Refined"], lifecycle: "approved" });
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "backlog" });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "backlog");
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  // A drop into Planning is the promotion that approves a pending design
  // change; it lands where the approval leaves it, not with the landsIn 409.
  it("POST /board/move to planning approves a pending design change and reports where it landed", async () => {
    const gh = await githubMock();
    mockReapproval.hasPendingReapproval.mockResolvedValue(true);
    try {
      mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "awaiting-plan-review" });
      mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow()] });
      vi.mocked(gh.getIssueState)
        .mockResolvedValueOnce({ state: "OPEN", stateReason: null, labels: [] })
        .mockResolvedValueOnce({ state: "OPEN", stateReason: null, labels: ["Refined"] });

      const res = await move({ repo: "org/repo", ref: NATIVE, to: "planning" });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ result: "ok", column: "approved" });
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

  it("POST /board/move applies the target column's labels through the façade", async () => {
    await withPlan();
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready"] });

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(200);
    // The column the issue is in now, computed rather than assumed.
    expect(JSON.parse(res.body)).toEqual({ result: "ok", column: "approved" });
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Refined");
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Ready");
  });

  // Only the labels the issue is actually holding: the Planning → Approved drag is
  // the common one, and it used to fire a removal for each of `Blocked` and
  // `Ready` when it held neither. On the GitHub path each is a `fetchLiveLabels`
  // `gh api` subprocess spawn before it decides there is nothing to do.
  it("POST /board/move removes nothing when the issue holds no lifecycle label", async () => {
    await withPlan();
    const gh = await githubMock();

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "ok", column: "approved" });
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Refined");
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  // And nor does it re-add one the issue already has: `ensureLabel` plus a
  // `gh issue edit` to end up where it started, and a no-op `label-added` event.
  it("POST /board/move adds nothing when the issue already holds the target label", async () => {
    await withPlan();
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(200);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
    // Nothing was written, so this is not a half-applied move to reload over.
    expect(JSON.parse(res.body).partial).toBeUndefined();
  });

  // No move touches the PR, and `Refined` outranks an open PR in `columnFor`,
  // so the card lands in Approved.
  it("POST /board/move out of PR progressing to approved lands", async () => {
    await withPlan();
    const gh = await githubMock();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow()] });

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "ok", column: "approved" });
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Refined");
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  // A running implementer outranks `Refined`, so the same drop does not land.
  it("POST /board/move to approved is a 409 while the implementer runs", async () => {
    await withPlan();
    const gh = await githubMock();
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: true, openPrs: [] });

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe(DERIVED_COLUMN_REJECTION);
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  // The other side of the same rule: `Ready` does not outrank an open PR, so
  // the issue would stay in Awaiting merge — a 409 rather than a column the
  // card never reached. The reason is DERIVED_COLUMN_REJECTION, which says
  // what to do about it: merge or close the PR.
  it("POST /board/move out of Awaiting merge to awaiting-plan-review is a 409 that writes nothing", async () => {
    await withPlan();
    const gh = await githubMock();
    mockIssueFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [openPrRow({ stage: "awaiting-merge" })] });

    const res = await move({ repo: "org/repo", ref: 42, to: "awaiting-plan-review" });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe(DERIVED_COLUMN_REJECTION);
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
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready"] });
    vi.mocked(gh.removeLabel).mockResolvedValue(false);

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toContain("Failed to remove");
    // The marker the client reverts on the absence of: only this route writes
    // it, so a framework or proxy 500 on the same URL cannot be mistaken for a
    // half-applied move.
    expect(JSON.parse(res.body).partial).toBe(true);
    expect(JSON.parse(res.body).error).toContain("stale");
    // The target's label goes on first, so a failed removal leaves the
    // outranking old label in place rather than no lifecycle label at all.
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Refined");
  });

  // The flag the catch reads means a write was *issued*, not that one returned:
  // a `gh` failure can surface after the edit took server-side, so a throw out
  // of the first write is still a move that may be half applied. 503 would tell
  // the client "nothing changed" and revert a card whose label is really on.
  it("POST /board/move answers 500 when the first write throws", async () => {
    await withPlan();
    const gh = await githubMock();
    vi.mocked(gh.addLabel).mockRejectedValueOnce(new Error("gh: HTTP 502"));

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

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
    // Every label the board owns, so all three removals are really issued — the
    // route removes only what the issue holds, and a starting set without them
    // would remove nothing and never reach the failure this is about.
    vi.mocked(gh.getIssueState).mockResolvedValue({
      state: "OPEN",
      stateReason: null,
      labels: ["Blocked", "Refined", "Ready"],
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
    expect(seen).toEqual(expect.arrayContaining(["Refined", "Ready"]));
  });

  // The derived columns follow the issue's running implementer and open PR, so
  // none is a destination.
  it.each(["implementing", "pr-progressing", "pr-stalled", "awaiting-merge"])("POST /board/move into %s is refused with 409 and changes nothing", async (to) => {
    const gh = await githubMock();

    const res = await move({ repo: "org/repo", ref: 42, to });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe(DERIVED_COLUMN_REJECTION);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
    expect(gh.closeIssue).not.toHaveBeenCalled();
  });

  // The column it replaced no longer exists.
  it("POST /board/move into in-progress is an unknown column", async () => {
    const res = await move({ repo: "org/repo", ref: 42, to: "in-progress" });

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
    expect((await move({ repo: "org/repo", ref: NATIVE, to: "blocked" })).status).toBe(200);

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
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "approved");
  });

  // A native issue's lifecycle is one field, so the move is one write — no
  // add-then-remove label pair to leave half applied.
  it("POST /board/move sets a native issue's lifecycle in one write", async () => {
    await withPlan();
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: ["Ready"], lifecycle: "awaiting-plan-review" });
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready"] });

    const res = await move({ repo: "org/repo", ref: NATIVE, to: "approved" });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).column).toBe("approved");
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "approved");
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
    vi.mocked(gh.getIssueComments).mockResolvedValue([
      { id: 1, body: "Just a human comment.", login: "someone", created_at: "2026-09-21T09:00:00Z" } as never,
    ]);

    const res = await move({ repo: "org/repo", ref: 42, to });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/needs a plan/);
    expect(gh.getIssueComments).toHaveBeenCalledWith("org/repo", 42);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move answers 503 when a forge issue's comments cannot be read", async () => {
    const gh = await githubMock();
    vi.mocked(gh.getIssueComments).mockRejectedValue(new Error("gh: HTTP 502"));

    const res = await move({ repo: "org/repo", ref: 42, to: "approved" });

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toContain("try again");
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("POST /board/move lets a forge issue with a plan comment reach Awaiting plan review", async () => {
    const gh = await githubMock();
    await withPlan();

    const res = await move({ repo: "org/repo", ref: 42, to: "awaiting-plan-review" });

    expect(res.status).toBe(200);
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Ready");
  });

  // "Send back to Planning" on an issue with a plan is a re-plan: without one
  // queued, the dispatcher sees an unchanged plan and the card sits in Planning.
  it("POST /board/move into Planning re-plans a native issue that has a plan, through its primary repo", async () => {
    const gh = await githubMock();
    const worker = await import("./worker.js");
    await withPlan();
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready"] });
    mockClawsIssues.getIssue.mockResolvedValue({
      id: NATIVE, state: "open", repos: ["org/zz-other", "org/repo"], labels: ["Ready"], lifecycle: "awaiting-plan-review", requirements_approved_at: "2026-09-21 09:00:00",
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
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready"] });
    mockResolveTrackerId.mockResolvedValueOnce(SHADOW);
    mockClawsIssues.getIssue.mockResolvedValue({
      id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning", requirements_approved_at: "2026-09-21 09:00:00",
    });

    const res = await move({ repo: "org/repo", ref: 42, to: "planning" });

    expect(res.status).toBe(200);
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Ready");
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

  it("POST /board/move into Planning queues no re-plan while the planner is disabled", async () => {
    const worker = await import("./worker.js");
    const cfg = await import("./config.js");
    await withPlan();
    vi.mocked(cfg.isAgentDisabled).mockImplementation((name: string) => name === "planner");
    mockClawsIssues.getIssue.mockResolvedValue({
      id: NATIVE, state: "open", repos: ["org/repo"], labels: ["Ready"], lifecycle: "awaiting-plan-review", requirements_approved_at: "2026-09-21 09:00:00",
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
  it.each(["drafting", "requirements-review", "blocked", "backlog", "done"])("POST /board/move to %s needs no plan and reads none", async (to) => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: ["org/repo"], labels: [], lifecycle: "planning" });

    const res = await move({ repo: "org/repo", ref: NATIVE, to });

    expect(res.status).toBe(200);
    expect(mockClawsIssues.listPlans).not.toHaveBeenCalled();
    expect(gh.getIssueComments).not.toHaveBeenCalled();
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
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready"] });
    mockResolveTrackerId.mockResolvedValueOnce(SHADOW);
    mockClawsIssues.getIssue.mockResolvedValue({ id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });

    const res = await move({ repo: "org/repo", ref: 42, to: "planning" });
    expect(res.status).toBe(200);
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Ready");
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
    vi.mocked(gh.getIssueState).mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready"] });
    mockResolveTrackerId.mockResolvedValueOnce(SHADOW);
    mockClawsIssues.getIssue.mockResolvedValue({ id: SHADOW, kind: "shadow", state: "open", repos: ["org/repo"], labels: [], lifecycle: "ideas" });
    mockClawsIssues.promoteIssue.mockResolvedValueOnce(false);

    const res = await move({ repo: "org/repo", ref: 42, to: "planning" });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).partial).toBe(true);
    expect(JSON.parse(res.body).column).toBeUndefined();
    // The label write had already landed by the time the lifecycle CAS lost.
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Ready");
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
    expect(JSON.parse(res.body).error).toContain("not configured");
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
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("org/repo", NATIVE, "approved");
  });

  // columnFor parks an unassigned native issue in Ideas whatever its labels
  // say, so a move that only relabels it would answer `ok` for a column the
  // card can never be in.
  it("POST /board/move refuses to move an unassigned native issue out of Drafting", async () => {
    const gh = await githubMock();
    mockClawsIssues.getIssue.mockResolvedValue({ id: NATIVE, state: "open", repos: [], labels: [] });

    const res = await move({ repo: "", ref: NATIVE, to: "blocked" });

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

  it("POST /board/automerge on:true ensures the label then applies it", async () => {
    const gh = await githubMock();

    const res = await automerge({ repo: "org/repo", ref: 42, on: true });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "ok", on: true });
    expect(gh.ensureLabel).toHaveBeenCalledWith("org/repo", "Automerge");
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Automerge");
  });

  it("POST /board/automerge on:false removes the label", async () => {
    const gh = await githubMock();

    const res = await automerge({ repo: "org/repo", ref: 42, on: false });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "ok", on: false });
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Automerge");
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  // The merge approval is recorded on each open row from the session's
  // identity, before the label — so the label hook, a no-op once
  // `merge_approved_at` is set, keeps the identity rather than overwriting it.
  it("POST /board/automerge on:true records the session's approval on each open PR row before labelling it", async () => {
    const gh = await githubMock();
    const db = await import("./db.js");
    mockIssueFlight.loadIssueFlight.mockResolvedValue({
      implementing: false,
      openPrs: [openPrRow({ prNumber: 7 }), openPrRow({ repo: "org/other", prNumber: 8, stage: "awaiting-merge" })],
    });

    const res = await automerge({ repo: "org/repo", ref: 42, on: true });

    expect(res.status).toBe(200);
    expect(mockIssueFlight.loadIssueFlight).toHaveBeenCalledWith("org/repo", 42);
    for (const [repo, number] of [["org/repo", 7], ["org/other", 8]] as const) {
      expect(db.upsertClawsPr).toHaveBeenCalledWith(repo, number, { mergeApprovedBy: "test-user", mergeApprovedAt: expect.stringMatching(/Z$/) });
      expect(gh.addLabel).toHaveBeenCalledWith(repo, number, "Automerge");
      const rowAt = vi.mocked(db.upsertClawsPr).mock.invocationCallOrder[vi.mocked(db.upsertClawsPr).mock.calls.findIndex((c) => c[1] === number)];
      const labelAt = vi.mocked(gh.addLabel).mock.invocationCallOrder[vi.mocked(gh.addLabel).mock.calls.findIndex((c) => c[1] === number)];
      expect(rowAt).toBeLessThan(labelAt);
    }
    expect(gh.ensureLabel).toHaveBeenCalledWith("org/other", "Automerge");
    // The issue still takes the label, for the next PR Claws opens.
    expect(gh.addLabel).toHaveBeenCalledWith("org/repo", 42, "Automerge");
  });

  it("POST /board/automerge on:false removes the label from each open PR and clears the approval", async () => {
    const gh = await githubMock();
    const db = await import("./db.js");
    mockIssueFlight.loadIssueFlight.mockResolvedValue({
      implementing: false,
      openPrs: [openPrRow({ prNumber: 7, mergeApprovedBy: "test-user", mergeApprovedAt: "2026-09-24T10:00:00Z" })],
    });

    const res = await automerge({ repo: "org/repo", ref: 42, on: false });

    expect(res.status).toBe(200);
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 7, "Automerge");
    expect(gh.removeLabel).toHaveBeenCalledWith("org/repo", 42, "Automerge");
    expect(db.upsertClawsPr).toHaveBeenCalledWith("org/repo", 7, { mergeApprovedBy: null, mergeApprovedAt: null });
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
        ? [{ number: 42, title: "Running", body: "", labels: [{ name: "Refined" }], author: { login: "stjohnb" } },
           { number: 43, title: "Reviewing", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 44, title: "Ready to land", body: "", labels: [{ name: "Ready" }], author: { login: "stjohnb" } },
           { number: 45, title: "Quiet", body: "", labels: [], author: { login: "stjohnb" } },
           { number: 46, title: "Stuck", body: "", labels: [], author: { login: "stjohnb" } }]
        : []));
    mockIssueFlight.loadBoardFlights.mockResolvedValue(new Map([
      ["org/repo\u000046", { implementing: false, openPrs: [openPrRow({ prNumber: 8, manualActionReason: "needs a secret" })] }],
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
    expect(cardsIn("implementing")).toEqual(["42"]);
    expect(cardsIn("pr-progressing")).toEqual(["43"]);
    expect(cardsIn("pr-stalled")).toEqual(["46"]);
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

    const res = await request(server, "GET", "/board");

    expect(res.status).toBe(200);
    expect(vi.mocked(db.getIssueIdsAwaitingOperator).mock.calls.at(-1)![0]).toEqual(["clw_SHADOW46"]);
    const body = res.body.match(/<div class="board-col-body" data-column="awaiting-merge">([\s\S]*?)<\/div>\s*<\/details>/)![1];
    expect(body).toContain(`data-ref="46"`);
    expect(body).toContain(">Awaiting operator</span>");
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

  it("GET /prs filters by kind, remembers it in a cookie and redirects a bare /prs", async () => {
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
      expect(String(deps.headers["set-cookie"])).toContain("claws_prs_kind=deps");

      const other = await request(server, "GET", "/prs?kind=other");
      expect(other.body).toContain("Claws feature");
      expect(other.body).not.toContain("Bump renovate dep");

      const bare = await request(server, "GET", "/prs");
      expect(bare.status).toBe(200);
      expect(bare.body).toContain("Bump renovate dep");
      expect(bare.body).toContain("Claws feature");
      expect(String(bare.headers["set-cookie"] ?? "")).not.toContain("claws_prs_kind");

      const redirect = await request(server, "GET", "/prs", { headers: { Cookie: "claws_prs_kind=deps" } });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.location).toBe("/prs?kind=deps");

      for (const value of ["all", "junk"]) {
        const res = await request(server, "GET", "/prs", { headers: { Cookie: `claws_prs_kind=${value}` } });
        expect(res.status, value).toBe(200);
        expect(res.body).toContain("Claws feature");
      }

      const all = await request(server, "GET", "/prs?kind=all", { headers: { Cookie: "claws_prs_kind=deps" } });
      expect(all.status).toBe(200);
      expect(String(all.headers["set-cookie"])).toContain("claws_prs_kind=all");

      const bogus = await request(server, "GET", "/prs?kind=bogus", { headers: { Cookie: "claws_prs_kind=deps" } });
      expect(bogus.status).toBe(200);
      expect(bogus.body).toContain("Claws feature");
      expect(String(bogus.headers["set-cookie"] ?? "")).not.toContain("claws_prs_kind");
    } finally {
      vi.mocked(gh.listPRs).mockReset().mockResolvedValue([]);
    }
  });

  it("POST /board/automerge answers 500 when removeLabel fails", async () => {
    const gh = await githubMock();
    vi.mocked(gh.removeLabel).mockResolvedValueOnce(false);

    const res = await automerge({ repo: "org/repo", ref: 42, on: false });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toContain("Automerge");
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
});
