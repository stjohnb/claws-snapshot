import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const mockDeployWatcherEnabled = vi.hoisted(() => ({ value: true }));
const mockGitPullAddonSlug = vi.hoisted(() => ({ value: "core_git_pull" as string | undefined }));
const mockHaConfigRepo = vi.hoisted(() => ({ value: "St-John-Software/home-assistant-config" as string | undefined }));
vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED() { return mockDeployWatcherEnabled.value; },
  get HOME_ASSISTANT_GIT_PULL_ADDON_SLUG() { return mockGitPullAddonSlug.value; },
  get HOME_ASSISTANT_CONFIG_REPO() { return mockHaConfigRepo.value; },
  LABELS: { priority: "Priority" },
}));

const mockIsConfigured = vi.hoisted(() => vi.fn(() => true));
const mockGetAddonLogs = vi.hoisted(() => vi.fn());
vi.mock("../home-assistant.js", () => ({
  isConfigured: mockIsConfigured,
  getAddonLogs: mockGetAddonLogs,
}));

const mockListCompareCommits = vi.hoisted(() => vi.fn());
vi.mock("../github.js", () => ({
  listCompareCommits: mockListCompareCommits,
}));

const mockEnsureAlertIssue = vi.hoisted(() => vi.fn(async (_opts: Record<string, unknown>) => ({ outcome: "created", issueNumber: 42 })));
const mockCloseAlertIssue = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../occurrence-tracking.js", () => ({
  ensureAlertIssue: mockEnsureAlertIssue,
  closeAlertIssueIfResolved: mockCloseAlertIssue,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({
  notify: mockNotify,
}));

// ── DB mock ──

const deployWatcherStateStore = vi.hoisted(() => new Map<string, { addonSlug: string; lastNotifiedSha: string; lastSeenAt: number }>());
vi.mock("../db.js", () => ({
  getHaDeployWatcherState: vi.fn((slug: string) => deployWatcherStateStore.get(slug) ?? null),
  upsertHaDeployWatcherState: vi.fn((slug: string, sha: string, now: number) => {
    deployWatcherStateStore.set(slug, { addonSlug: slug, lastNotifiedSha: sha, lastSeenAt: now });
  }),
  clearHaDeployWatcherStateForTests: vi.fn(() => deployWatcherStateStore.clear()),
}));

import { run, parseDeployEvents, deploySeverity, buildDeployFailureBody } from "./ha-deploy-watcher.js";
import { clearHaDeployWatcherStateForTests } from "../db.js";

// Realistic log fixture from issue #1313
const REALISTIC_LOG = `From github.com:St-John-Software/home-assistant-config
 * branch            main       -> FETCH_HEAD
[12:34:02] INFO: [Info] Staying on currently checked out branch: main...
[12:34:02] INFO: [Info] Start git pull...
Already up to date.
[12:34:03] INFO: [Info] Checking if something has changed...
[12:34:03] INFO: [Info] Nothing has changed.
[12:39:03] INFO: Check SSH connection
[12:39:04] INFO: [Info] Valid SSH connection for git@github.com
[12:39:04] INFO: [Info] Local git repository exists
[12:39:04] INFO: [Info] Git origin is correctly set to git@github.com:St-John-Software/home-assistant-config
[12:39:04] INFO: [Info] Start git fetch...
From github.com:St-John-Software/home-assistant-config
 * branch            main       -> FETCH_HEAD
[12:39:05] INFO: [Info] Staying on currently checked out branch: main...
[12:39:05] INFO: [Info] Start git pull...
Already up to date.
[12:39:07] INFO: [Info] Checking if something has changed...
[12:39:07] INFO: [Info] Nothing has changed.
[13:09:25] INFO: Check SSH connection
[13:09:26] INFO: [Info] Valid SSH connection for git@github.com
[13:09:26] INFO: [Info] Local git repository exists
[13:09:26] INFO: [Info] Git origin is correctly set to git@github.com:St-John-Software/home-assistant-config
[13:09:26] INFO: [Info] Start git fetch...
From github.com:St-John-Software/home-assistant-config
 * branch            main       -> FETCH_HEAD
   fa09a4b..eea9f86  main       -> origin/main
[13:09:27] INFO: [Info] Staying on currently checked out branch: main...
[13:09:27] INFO: [Info] Start git pull...
Updating fa09a4b..eea9f86
Fast-forward
 automations.yaml    |  7 +++----
 docs/automations.md | 14 ++++++++++----
 2 files changed, 13 insertions(+), 8 deletions(-)
[13:09:28] INFO: [Info] Checking if something has changed...
[13:09:28] INFO: [Info] Something has changed, checking Home-Assistant config...
[13:09:39] INFO: [Info] Local configuration has changed. Restart required.`;

// Same deploy, but the config check after the pull fails — used by the tests that assert
// Slack message content, since clean deploys are no longer notified (#2544).
const FAILING_LOG = REALISTIC_LOG.replace(
  "[13:09:39] INFO: [Info] Local configuration has changed. Restart required.",
  "[13:09:39] ERROR: [Error] Configuration invalid, not reloading!",
);

beforeEach(() => {
  clearHaDeployWatcherStateForTests();
  vi.clearAllMocks();
  mockDeployWatcherEnabled.value = true;
  mockGitPullAddonSlug.value = "core_git_pull";
  mockHaConfigRepo.value = "St-John-Software/home-assistant-config";
  mockIsConfigured.mockReturnValue(true);
  mockListCompareCommits.mockResolvedValue([
    { sha: "eea9f86abcdef00", subject: "Tweak automations" },
  ]);
  mockEnsureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 42 });
  mockCloseAlertIssue.mockResolvedValue(null);
});

// ── parseDeployEvents unit tests ──

describe("parseDeployEvents", () => {
  it("parses the realistic fixture from issue #1313 as exactly one event", () => {
    const events = parseDeployEvents(REALISTIC_LOG);
    expect(events).toHaveLength(1);
    expect(events[0]!.oldSha).toBe("fa09a4b");
    expect(events[0]!.newSha).toBe("eea9f86");
    expect(events[0]!.diffstat).toMatch(/^Fast-forward/);
    expect(events[0]!.diffstat).toContain("2 files changed, 13 insertions(+), 8 deletions(-)");
  });

  it("does NOT match the fetch-summary line with leading whitespace", () => {
    // The line "   fa09a4b..eea9f86  main       -> origin/main" must not be matched
    const logWithFetchLine = `   fa09a4b..eea9f86  main       -> origin/main
[13:09:27] INFO: [Info] Start git pull...
Already up to date.`;
    const events = parseDeployEvents(logWithFetchLine);
    expect(events).toHaveLength(0);
  });

  it("returns empty array when no Updating lines present", () => {
    const events = parseDeployEvents("Already up to date.\n[12:34:02] INFO: Nothing has changed.");
    expect(events).toHaveLength(0);
  });

  it("handles two consecutive deploy events", () => {
    const log = `Updating aaa1111..bbb2222
Fast-forward
 file.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
[10:00:01] INFO: Something changed.
Updating bbb2222..ccc3333
Fast-forward
 other.yaml | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)
[10:05:01] INFO: Something changed.`;
    const events = parseDeployEvents(log);
    expect(events).toHaveLength(2);
    expect(events[0]!.oldSha).toBe("aaa1111");
    expect(events[0]!.newSha).toBe("bbb2222");
    expect(events[1]!.oldSha).toBe("bbb2222");
    expect(events[1]!.newSha).toBe("ccc3333");
  });

  it("handles a truncated log without N files changed trailer", () => {
    const log = `Updating aaa1111..bbb2222
Fast-forward
 file.yaml | 2 +-`;
    const events = parseDeployEvents(log);
    expect(events).toHaveLength(1);
    expect(events[0]!.newSha).toBe("bbb2222");
    expect(events[0]!.diffstat).toContain("Fast-forward");
  });

  it("deduplicates by newSha keeping last occurrence", () => {
    const log = `Updating aaa1111..bbb2222
Fast-forward
 old.yaml | 1 +
[10:00:00] INFO: changed
Updating aaa1111..bbb2222
Fast-forward
 new.yaml | 2 ++
[10:05:00] INFO: changed`;
    const events = parseDeployEvents(log);
    expect(events).toHaveLength(1);
    expect(events[0]!.diffstat).toContain("new.yaml");
  });

  it("accepts 40-char SHAs", () => {
    const log = `Updating a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2..b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3
Fast-forward
 file.yaml | 1 +
[10:00:00] INFO: changed`;
    const events = parseDeployEvents(log);
    expect(events).toHaveLength(1);
    expect(events[0]!.oldSha).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
    expect(events[0]!.newSha).toBe("b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3");
  });

  it("captures configError when HA config check fails after deploy", () => {
    const log = `Updating fa09a4b..eea9f86
Fast-forward
 automations.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
[13:09:28] INFO: [Info] Checking if something has changed...
[13:09:28] INFO: [Info] Something has changed, checking Home-Assistant config...
[13:09:39] ERROR: [Error] Configuration invalid, not reloading!`;
    const events = parseDeployEvents(log);
    expect(events).toHaveLength(1);
    expect(events[0]!.configError).toMatch(/Configuration invalid/);
  });

  it("strips ANSI color codes from configError", () => {
    const log = `Updating fa09a4b..eea9f86
Fast-forward
 automations.yaml | 2 +-
[13:09:28] INFO: \x1b[32m[Info] Checking config...\x1b[0m
[13:09:39] ERROR: \x1b[31m[Error] Configuration invalid!\x1b[0m`;
    const events = parseDeployEvents(log);
    expect(events[0]!.configError).not.toMatch(/\x1b/);
    expect(events[0]!.configError).toMatch(/Configuration invalid/);
  });

  it("sets configError to undefined when no error follows the deploy", () => {
    const events = parseDeployEvents(REALISTIC_LOG);
    expect(events[0]!.configError).toBeUndefined();
  });

  it("does not assign configError from a later deploy cycle to an earlier deploy", () => {
    const log = `Updating aaa1111..bbb2222
Fast-forward
 file.yaml | 1 +
[10:00:01] INFO: Something changed.
Updating bbb2222..ccc3333
Fast-forward
 other.yaml | 2 +-
[10:05:01] INFO: Something changed.
[10:05:02] ERROR: [Error] Configuration invalid!`;
    const events = parseDeployEvents(log);
    expect(events).toHaveLength(2);
    expect(events[0]!.configError).toBeUndefined();
    expect(events[1]!.configError).toMatch(/Configuration invalid/);
  });
});

// ── run() integration tests ──

describe("run()", () => {
  it("returns early when disabled", async () => {
    mockDeployWatcherEnabled.value = false;
    await run();
    expect(mockGetAddonLogs).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("returns early when HA not configured", async () => {
    mockIsConfigured.mockReturnValue(false);
    await run();
    expect(mockGetAddonLogs).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("logs warning and skips when getAddonLogs throws", async () => {
    mockGetAddonLogs.mockRejectedValueOnce(new Error("HA API 404"));
    await run();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("first run: baselines state at latest SHA without notifying", async () => {
    mockGetAddonLogs.mockResolvedValueOnce(REALISTIC_LOG);
    await run();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(deployWatcherStateStore.get("core_git_pull")?.lastNotifiedSha).toBe("eea9f86");
  });

  it("notifies when a new deploy fails its config check", async () => {
    // Pre-seed state at old SHA
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    mockGetAddonLogs.mockResolvedValueOnce(FAILING_LOG);
    await run();
    expect(mockNotify).toHaveBeenCalledOnce();
    const msg = mockNotify.mock.calls[0]![0] as string;
    expect(msg).toContain("compare/fa09a4b...eea9f86");
    expect(msg).toContain("Tweak automations");
    expect(msg).toContain("*Commits:*");
    expect(msg).not.toMatch(/^\*Repo:\*/m);
    expect(msg).not.toMatch(/^\*Range:\*/m);
    expect(deployWatcherStateStore.get("core_git_pull")?.lastNotifiedSha).toBe("eea9f86");
  });

  it("does not notify when no deploy events found in logs", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "abc1234",
      lastSeenAt: Date.now(),
    });
    mockGetAddonLogs.mockResolvedValueOnce("Already up to date.\n[12:34:02] INFO: Nothing has changed.");
    await run();
    expect(mockNotify).not.toHaveBeenCalled();
    // State unchanged
    expect(deployWatcherStateStore.get("core_git_pull")?.lastNotifiedSha).toBe("abc1234");
  });

  it("does not notify when state SHA already matches latest event", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "eea9f86",
      lastSeenAt: Date.now(),
    });
    mockGetAddonLogs.mockResolvedValueOnce(REALISTIC_LOG);
    await run();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("sends error notification when config check fails after a new deploy", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    const errorLog = `Updating fa09a4b..eea9f86
Fast-forward
 automations.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
[13:09:28] INFO: [Info] Checking if something has changed...
[13:09:28] INFO: [Info] Something has changed, checking Home-Assistant config...
[13:09:39] ERROR: [Error] Configuration invalid, not reloading!`;
    mockGetAddonLogs.mockResolvedValueOnce(errorLog);
    await run();
    expect(mockNotify).toHaveBeenCalledOnce();
    const msg = mockNotify.mock.calls[0]![0] as string;
    expect(msg).toContain(":x:");
    expect(msg).not.toContain(":warning:"); // detail section icon must match header
    expect(msg).toContain("Config check error");
    expect(msg).toContain("Configuration invalid");
    expect(msg).not.toContain(":rocket:");
  });

  it("sends warning notification when config check produces a WARNING line", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    const warningLog = `Updating fa09a4b..eea9f86
Fast-forward
 automations.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
[13:09:28] INFO: [Info] Checking if something has changed...
[13:09:28] INFO: [Info] Something has changed, checking Home-Assistant config...
[13:09:39] WARNING: [Warning] Non-critical advisory`;
    mockGetAddonLogs.mockResolvedValueOnce(warningLog);
    await run();
    expect(mockNotify).toHaveBeenCalledOnce();
    const msg = mockNotify.mock.calls[0]![0] as string;
    expect(msg).toContain(":warning:");
    expect(msg).not.toContain(":x:");
    expect(msg).not.toContain(":rocket:");
    expect(msg).toContain("Config check warning");
    expect(msg).toContain("Non-critical advisory");
  });

  it("skips Slack for a clean deploy that follows a failed one in the same batch", async () => {
    deployWatcherStateStore.set("core_git_pull", { addonSlug: "core_git_pull", lastNotifiedSha: "old0000", lastSeenAt: Date.now() });
    const log = `Updating aaa1111..bbb2222
Fast-forward
 file.yaml | 1 +
[10:00:01] INFO: [Info] Something has changed, checking Home-Assistant config...
[10:00:02] ERROR: [Error] Configuration invalid!
Updating bbb2222..ccc3333
Fast-forward
 other.yaml | 2 +-
[10:05:01] INFO: Something changed.`;
    mockGetAddonLogs.mockResolvedValueOnce(log);
    await run();
    expect(mockNotify).toHaveBeenCalledOnce();
    expect(mockNotify.mock.calls[0]![0] as string).toContain(":x:");
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockCloseAlertIssue).toHaveBeenCalledOnce();
  });

  it("does not notify Slack on a clean deploy, but still advances state", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    mockGetAddonLogs.mockResolvedValueOnce(REALISTIC_LOG);
    await run();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockListCompareCommits).not.toHaveBeenCalled();
    expect(deployWatcherStateStore.get("core_git_pull")?.lastNotifiedSha).toBe("eea9f86");
  });

  it("notifies for both events when state SHA is not in the log", async () => {
    const log = `Updating aaa1111..bbb2222
Fast-forward
 file.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
[10:00:01] INFO: Something changed.
[10:00:02] ERROR: [Error] Configuration invalid!
Updating bbb2222..ccc3333
Fast-forward
 other.yaml | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)
[10:05:01] INFO: Something changed.
[10:05:02] ERROR: [Error] Configuration invalid!`;

    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "old0000",
      lastSeenAt: Date.now(),
    });
    mockGetAddonLogs.mockResolvedValueOnce(log);
    await run();
    expect(mockNotify).toHaveBeenCalledTimes(2);
    const firstMsg = mockNotify.mock.calls[0]![0] as string;
    const secondMsg = mockNotify.mock.calls[1]![0] as string;
    expect(firstMsg).toContain("compare/aaa1111...bbb2222");
    expect(secondMsg).toContain("compare/bbb2222...ccc3333");
    expect(mockListCompareCommits).toHaveBeenCalledTimes(2);
    expect(deployWatcherStateStore.get("core_git_pull")?.lastNotifiedSha).toBe("ccc3333");
  });

  it("falls back to placeholder when listCompareCommits throws", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    mockGetAddonLogs.mockResolvedValueOnce(FAILING_LOG);
    mockListCompareCommits.mockRejectedValueOnce(new Error("boom"));
    await run();
    expect(mockNotify).toHaveBeenCalledOnce();
    const msg = mockNotify.mock.calls[0]![0] as string;
    expect(msg).toContain("commit list unavailable");
    expect(msg).toContain("compare/fa09a4b...eea9f86");
  });

  it("renders empty-commit placeholder when compare returns zero commits", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    mockGetAddonLogs.mockResolvedValueOnce(FAILING_LOG);
    mockListCompareCommits.mockResolvedValueOnce([]);
    await run();
    expect(mockNotify).toHaveBeenCalledOnce();
    const msg = mockNotify.mock.calls[0]![0] as string;
    expect(msg).toContain("no commits between");
  });

  it("files an alert issue when a new deploy has an ERROR: config check", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    const errorLog = `Updating fa09a4b..eea9f86
Fast-forward
 automations.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
[13:09:28] INFO: [Info] Checking if something has changed...
[13:09:28] INFO: [Info] Something has changed, checking Home-Assistant config...
[13:09:39] ERROR: [Error] Configuration invalid, not reloading!`;
    mockGetAddonLogs.mockResolvedValueOnce(errorLog);
    await run();
    expect(mockEnsureAlertIssue).toHaveBeenCalledOnce();
    const opts = mockEnsureAlertIssue.mock.calls[0]![0];
    expect(opts.title).toBe(
      "[ha-deploy-watcher] home-assistant-config deploy failed on the Home Assistant host",
    );
    expect(opts.labels).toEqual(["Priority"]);
    expect(opts.refreshBody).toBe(true);
    expect(opts.body).toContain("Configuration invalid");
    expect(opts.body).toContain("fa09a4b");
    expect(opts.body).toContain("eea9f86");
    expect(opts.body).toContain("https://github.com/St-John-Software/home-assistant-config/compare/fa09a4b...eea9f86");
    expect(mockCloseAlertIssue).not.toHaveBeenCalled();
  });

  it("does not file an alert issue for a WARNING: config check, and closes any existing alert", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    const warningLog = `Updating fa09a4b..eea9f86
Fast-forward
 automations.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
[13:09:28] INFO: [Info] Checking if something has changed...
[13:09:28] INFO: [Info] Something has changed, checking Home-Assistant config...
[13:09:39] WARNING: [Warning] Non-critical advisory`;
    mockGetAddonLogs.mockResolvedValueOnce(warningLog);
    await run();
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockCloseAlertIssue).toHaveBeenCalledOnce();
  });

  it("closes the alert issue on a clean deploy, and does not file", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    mockGetAddonLogs.mockResolvedValueOnce(REALISTIC_LOG);
    await run();
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockCloseAlertIssue).toHaveBeenCalledOnce();
  });

  it("closes rather than files when an older ERROR event is superseded by a newer clean event", async () => {
    const log = `Updating aaa1111..bbb2222
Fast-forward
 file.yaml | 1 +
[10:00:01] INFO: [Info] Something has changed, checking Home-Assistant config...
[10:00:02] ERROR: [Error] Configuration invalid!
Updating bbb2222..ccc3333
Fast-forward
 other.yaml | 2 +-
[10:05:01] INFO: Something changed.`;

    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "old0000",
      lastSeenAt: Date.now(),
    });
    mockGetAddonLogs.mockResolvedValueOnce(log);
    await run();
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockCloseAlertIssue).toHaveBeenCalledOnce();
  });

  it("first run files no alert issue and notifies nothing", async () => {
    const errorLog = `Updating fa09a4b..eea9f86
Fast-forward
 automations.yaml | 2 +-
[13:09:28] INFO: [Info] Something has changed, checking Home-Assistant config...
[13:09:39] ERROR: [Error] Configuration invalid, not reloading!`;
    mockGetAddonLogs.mockResolvedValueOnce(errorLog);
    await run();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockCloseAlertIssue).not.toHaveBeenCalled();
  });

  it("does not throw when ensureAlertIssue rejects, and still advances state", async () => {
    deployWatcherStateStore.set("core_git_pull", {
      addonSlug: "core_git_pull",
      lastNotifiedSha: "fa09a4b",
      lastSeenAt: Date.now(),
    });
    const errorLog = `Updating fa09a4b..eea9f86
Fast-forward
 automations.yaml | 2 +-
[13:09:28] INFO: [Info] Something has changed, checking Home-Assistant config...
[13:09:39] ERROR: [Error] Configuration invalid, not reloading!`;
    mockEnsureAlertIssue.mockRejectedValueOnce(new Error("GitHub API down"));
    mockGetAddonLogs.mockResolvedValueOnce(errorLog);
    await expect(run()).resolves.not.toThrow();
    expect(deployWatcherStateStore.get("core_git_pull")?.lastNotifiedSha).toBe("eea9f86");

    // Second run with the same log should not re-notify, since state already advanced.
    mockGetAddonLogs.mockResolvedValueOnce(errorLog);
    await run();
    expect(mockNotify).toHaveBeenCalledOnce();
  });
});

describe("deploySeverity", () => {
  it("returns 'error' for an ERROR: config check line", () => {
    const evt = { oldSha: "a", newSha: "b", diffstat: "", configError: "[13:09:39] ERROR: Configuration invalid!" };
    expect(deploySeverity(evt)).toBe("error");
  });

  it("returns 'warning' for a WARNING: config check line", () => {
    const evt = { oldSha: "a", newSha: "b", diffstat: "", configError: "[13:09:39] WARNING: Non-critical advisory" };
    expect(deploySeverity(evt)).toBe("warning");
  });

  it("returns null when configError is undefined", () => {
    const evt = { oldSha: "a", newSha: "b", diffstat: "" };
    expect(deploySeverity(evt)).toBeNull();
  });
});

describe("buildDeployFailureBody", () => {
  const evt = {
    oldSha: "fa09a4b",
    newSha: "eea9f86",
    diffstat: "1 file changed",
    configError: "[13:09:39] ERROR: Configuration invalid!",
  };

  it("renders the commit-list-unavailable placeholder when commits is null", () => {
    const body = buildDeployFailureBody(evt, "St-John-Software/home-assistant-config", null, "2026-08-11T00:00:00.000Z");
    expect(body).toContain("_(commit list unavailable — see compare link)_");
  });

  it("renders the no-commits placeholder when commits is an empty array", () => {
    const body = buildDeployFailureBody(evt, "St-John-Software/home-assistant-config", [], "2026-08-11T00:00:00.000Z");
    expect(body).toContain("_(no commits between fa09a4b and eea9f86)_");
  });
});
