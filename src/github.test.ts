import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("./config.js", () => ({
  GITHUB_OWNERS: ["test-owner"],
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
  },
  LABEL_SPECS: {
    "Refined": { color: "0075ca", description: "Issue is ready for claws to implement" },
    "Ready": { color: "0e8a16", description: "Claws has finished — needs human attention" },
    "Priority": { color: "d93f0b", description: "High-priority — processed first in all Claws queues" },
  },
  SELF_REPO: "test-org/test-repo",
  SKIPPED_ITEMS: [],
  PRIORITIZED_ITEMS: [],
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("./slack.js", () => ({
  notify: vi.fn(),
}));

import { notify } from "./slack.js";

import {
  listRepos,
  clearRepoCache,
  searchIssues,
  createIssue,
  createPR,
  listIssuesByLabel,
  prChecksFailing,
  prChecksPassing,
  getPRCheckStatus,
  getFailingCheck,
  getFailedRunLog,
  getPRReviewComments,
  ensureLabel,
  ensureAllLabels,
  listLabels,
  deleteLabel,
  deleteStaleLabels,
  getIssueComments,
  editIssueComment,
  CLAWS_COMMENT_MARKER,
  CLAWS_VISIBLE_HEADER,
  isClawsComment,
  stripClawsMarker,
  isRateLimited,
  clearRateLimitState,
  RateLimitError,
  clearApiCache,
  listPRs,
  getOpenPRForIssue,
  updatePRBody,
  populateQueueCache,
  getQueueSnapshot,
  clearQueueCache,
  isItemSkipped,
  isItemPrioritized,
  hasPriorityLabel,
  removeQueueItem,
  addReaction,
  addReviewCommentReaction,
  getCommentReactions,
  getPRReviewDecision,
} from "./github.js";

describe("gh retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExecFile.mockReset();
    clearRepoCache();
    clearRateLimitState();
    clearApiCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on transient errors (502)", async () => {
    let attempt = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      attempt++;
      if (attempt < 3) {
        const err = new Error("502 Bad Gateway");
        cb(err, "", "502 Bad Gateway");
      } else {
        cb(null, "success", "");
      }
    });

    const promise = listRepos();

    // Advance past retry delays (1s, 2s)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const repos = await promise;
    // It succeeded — should parse the empty/success response
    expect(attempt).toBe(3);
  });

  it("retries on transient errors (500)", async () => {
    let attempt = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      attempt++;
      if (attempt < 3) {
        const err = new Error("HTTP 500 (https://api.github.com/graphql)");
        cb(err, "", "HTTP 500 (https://api.github.com/graphql)");
      } else {
        cb(null, "[]", "");
      }
    });

    const promise = listRepos();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const repos = await promise;
    expect(attempt).toBe(3);
  });

  it("retries on transient errors (400)", async () => {
    let attempt = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      attempt++;
      if (attempt < 3) {
        const err = new Error("HTTP 400: 400 Bad Request (https://api.github.com/graphql)");
        cb(err, "", "HTTP 400: 400 Bad Request (https://api.github.com/graphql)");
      } else {
        cb(null, "[]", "");
      }
    });

    const promise = listRepos();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await promise;
    expect(attempt).toBe(3);
  });

  it("retries on transient errors (GraphQL 'Something went wrong')", async () => {
    let attempt = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      attempt++;
      if (attempt < 3) {
        const msg = "Something went wrong while executing your query";
        cb(new Error(msg), "", msg);
      } else {
        cb(null, "[]", "");
      }
    });

    const promise = listRepos();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await promise;
    expect(attempt).toBe(3);
  });

  it("retries on Go-style 'connection reset by peer' errors", async () => {
    let attempt = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      attempt++;
      if (attempt < 3) {
        const msg = 'Post "https://api.github.com/graphql": read tcp 192.168.0.73:37684->20.26.156.210:443: read: connection reset by peer';
        cb(new Error(msg), "", msg);
      } else {
        cb(null, "[]", "");
      }
    });

    const promise = listRepos();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await promise;
    expect(attempt).toBe(3);
  });

  it("retries on GraphQL 'Could not resolve to a Repository' errors", async () => {
    let attempt = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      attempt++;
      if (attempt < 3) {
        const msg = "GraphQL: Could not resolve to a Repository with the name 'owner/repo'. (repository)";
        cb(new Error(msg), "", msg);
      } else {
        cb(null, "[]", "");
      }
    });

    const promise = listRepos();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await promise;
    expect(attempt).toBe(3);
  });

  it("retries on TLS handshake timeout errors", async () => {
    let attempt = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      attempt++;
      if (attempt < 3) {
        const msg = 'Post "https://api.github.com/graphql": net/http: TLS handshake timeout';
        cb(new Error(msg), "", msg);
      } else {
        cb(null, "[]", "");
      }
    });

    const promise = listRepos();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await promise;
    expect(attempt).toBe(3);
  });

  it("rejects immediately on non-transient errors", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("permission denied"), "", "permission denied");
    });

    // listRepos catches the error per-owner, so it won't throw
    // but let's test through createPR which propagates errors
    const promise = createPR("org/repo", "feature", "title", "body");
    await expect(promise).rejects.toThrow("permission denied");
  });

  it("retries when stderr is empty (transient failure)", async () => {
    let attempt = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      attempt++;
      if (attempt < 2) {
        // Empty stderr — Node's generic "Command failed" message
        const err = new Error("Command failed: gh pr list");
        cb(err, "", "");
      } else {
        cb(null, "https://github.com/org/repo/pull/42\n", "");
      }
    });

    const promise = createPR("org/repo", "feature", "title", "body");

    await vi.advanceTimersByTimeAsync(1000);

    const prNumber = await promise;
    expect(prNumber).toBe(42);
    expect(attempt).toBe(2);
  });

  it("rejects after max retries exhausted", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("ETIMEDOUT"), "", "ETIMEDOUT");
    });

    const promise = createPR("org/repo", "feature", "title", "body");

    // Attach rejection handler before advancing timers to avoid unhandled rejection
    const result = expect(promise).rejects.toThrow("ETIMEDOUT");

    // Advance past all retries: 1s, 2s, 4s
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    await result;
  });

  it("rejects immediately on rate limit errors without retrying", async () => {
    let attempts = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      attempts++;
      cb(new Error("API rate limit exceeded"), "", "API rate limit exceeded");
    });

    await expect(createPR("org/repo", "feature", "title", "body")).rejects.toThrow(RateLimitError);
    expect(attempts).toBe(1);
  });

  it("trips circuit breaker on rate limit, blocking subsequent calls", async () => {
    // First call triggers rate limit
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("API rate limit exceeded"), "", "API rate limit exceeded");
    });

    await expect(createPR("org/repo", "feature", "title", "body")).rejects.toThrow(RateLimitError);
    expect(isRateLimited()).toBe(true);

    // Second call should be blocked without spawning a process
    mockExecFile.mockReset();
    await expect(createPR("org/repo", "feature2", "title2", "body2")).rejects.toThrow(RateLimitError);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("circuit breaker clears after cooldown period", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("API rate limit exceeded"), "", "API rate limit exceeded");
    });

    await expect(createPR("org/repo", "feature", "title", "body")).rejects.toThrow(RateLimitError);
    expect(isRateLimited()).toBe(true);

    // Advance past the 60s cooldown
    vi.advanceTimersByTime(60_001);
    expect(isRateLimited()).toBe(false);

    // Next call should proceed normally
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "https://github.com/org/repo/pull/1\n", "");
    });
    const prNumber = await createPR("org/repo", "feature", "title", "body");
    expect(prNumber).toBe(1);
  });

  it("sends Slack notification when rate limit cooldown expires and API calls resume", async () => {
    const mockNotify = vi.mocked(notify);

    // Trip the circuit breaker
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("API rate limit exceeded"), "", "API rate limit exceeded");
    });

    await expect(searchIssues("org/repo", "test")).rejects.toThrow(RateLimitError);
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("rate limit hit"));

    // Reset call count so we can assert cleanly on the resume notification
    mockNotify.mockClear();

    // Advance past the 60s cooldown
    vi.advanceTimersByTime(60_001);
    expect(isRateLimited()).toBe(false);

    // Next call should succeed and fire the resume notification
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "[]", "");
    });

    await searchIssues("org/repo", "test");
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("resuming operations"));

    // A subsequent call should NOT fire the notification again
    mockNotify.mockClear();
    await searchIssues("org/repo", "another");
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe("listRepos", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRepoCache();
    clearRateLimitState();
  });

  it("parses repo list JSON into Repo objects", async () => {
    const repoData = [
      {
        nameWithOwner: "test-owner/repo1",
        name: "repo1",
        owner: { login: "test-owner" },
        defaultBranchRef: { name: "main" },
        isArchived: false,
      },
      {
        nameWithOwner: "test-owner/repo2",
        name: "repo2",
        owner: { login: "test-owner" },
        defaultBranchRef: null,
        isArchived: false,
      },
    ];

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify(repoData), "");
    });

    const repos = await listRepos();
    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({
      owner: "test-owner",
      name: "repo1",
      fullName: "test-owner/repo1",
      defaultBranch: "main",
    });
    expect(repos[1].defaultBranch).toBe("main"); // fallback when null
  });

  it("handles API error for one owner gracefully", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("not found"), "", "not found");
    });

    const repos = await listRepos();
    expect(repos).toEqual([]); // error caught, returns empty
  });
});

describe("createPR", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("parses PR number from URL output", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "https://github.com/org/repo/pull/123\n", "");
    });

    const prNumber = await createPR("org/repo", "feature", "title", "body");
    expect(prNumber).toBe(123);
  });

  it("throws on unparseable URL", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "something unexpected", "");
    });

    await expect(createPR("org/repo", "feature", "title", "body")).rejects.toThrow(
      "Could not parse PR number",
    );
  });

  it("recovers when PR already exists from a retried request", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      const msg = "a pull request for branch \"feature\" into branch \"main\" already exists:\nhttps://github.com/org/repo/pull/445";
      cb(new Error(msg), "", msg);
    });

    const prNumber = await createPR("org/repo", "feature", "title", "body");
    expect(prNumber).toBe(445);
  });

  it("still throws non-duplicate errors", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("permission denied"), "", "permission denied");
    });

    await expect(createPR("org/repo", "feature", "title", "body")).rejects.toThrow(
      "permission denied",
    );
  });
});

describe("createIssue", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("parses issue number from URL output", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === "label") {
        cb(null, "", "");
      } else {
        cb(null, "https://github.com/org/repo/issues/99\n", "");
      }
    });

    const issueNumber = await createIssue("org/repo", "title", "body", ["bug"]);
    expect(issueNumber).toBe(99);
  });

  it("recovers when issue already exists from a retried request", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === "label") {
        cb(null, "", "");
      } else {
        const msg = "already exists: https://github.com/org/repo/issues/42";
        cb(new Error(msg), "", msg);
      }
    });

    const issueNumber = await createIssue("org/repo", "title", "body", ["bug"]);
    expect(issueNumber).toBe(42);
  });
});

describe("prChecksFailing", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearApiCache();
    clearRateLimitState();
  });

  it("returns true when any check has a failed state", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "FAILURE" },
      ]), "");
    });

    expect(await prChecksFailing("org/repo", 1)).toBe(true);
  });

  it("returns false when all checks pass", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "SUCCESS" },
      ]), "");
    });

    expect(await prChecksFailing("org/repo", 1)).toBe(false);
  });

  it("returns false on error", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("fail"), "", "fail");
    });

    expect(await prChecksFailing("org/repo", 1)).toBe(false);
  });
});

describe("prChecksPassing", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearApiCache();
    clearRateLimitState();
  });

  it("returns true when all checks are SUCCESS and there is at least one", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "SUCCESS" },
      ]), "");
    });

    expect(await prChecksPassing("org/repo", 1)).toBe(true);
  });

  it("returns false when a check is not SUCCESS", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "PENDING" },
      ]), "");
    });

    expect(await prChecksPassing("org/repo", 1)).toBe(false);
  });

  it("returns false when no checks exist", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "[]", "");
    });

    expect(await prChecksPassing("org/repo", 1)).toBe(false);
  });

  it("returns true when checks are SUCCESS or SKIPPED", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "detect-changes", state: "SUCCESS" },
        { name: "build", state: "SKIPPED" },
        { name: "test", state: "SKIPPED" },
      ]), "");
    });

    expect(await prChecksPassing("org/repo", 1)).toBe(true);
  });

  it("returns true when all checks are SKIPPED", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SKIPPED" },
      ]), "");
    });

    expect(await prChecksPassing("org/repo", 1)).toBe(true);
  });
});

describe("getPRCheckStatus", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearApiCache();
    clearRateLimitState();
  });

  it("returns 'passing' when all checks pass", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "SKIPPED" },
      ]), "");
    });

    expect(await getPRCheckStatus("org/repo", 1)).toBe("passing");
  });

  it("returns 'failing' when any check has a failed state", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "FAILURE" },
      ]), "");
    });

    expect(await getPRCheckStatus("org/repo", 1)).toBe("failing");
  });

  it("returns 'pending' when checks are in progress", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "PENDING" },
      ]), "");
    });

    expect(await getPRCheckStatus("org/repo", 1)).toBe("pending");
  });

  it("returns 'none' when no checks exist", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "[]", "");
    });

    expect(await getPRCheckStatus("org/repo", 1)).toBe("none");
  });

  it("returns 'none' when gh CLI reports no checks", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      const err = Object.assign(new Error("exit code 1"), { code: 1 });
      cb(err, "", "no checks reported on the 'some-branch' branch");
    });

    expect(await getPRCheckStatus("org/repo", 1)).toBe("none");
  });

  it("rethrows other gh errors from check status", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      const err = Object.assign(new Error("exit code 1"), { code: 1 });
      cb(err, "", "some other error");
    });

    await expect(getPRCheckStatus("org/repo", 1)).rejects.toThrow("some other error");
  });

  it("caches results and deduplicates concurrent calls", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([{ name: "build", state: "SUCCESS" }]), "");
    });

    const [r1, r2] = await Promise.all([
      getPRCheckStatus("org/repo", 1),
      getPRCheckStatus("org/repo", 1),
    ]);

    expect(r1).toBe("passing");
    expect(r2).toBe("passing");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

describe("getOpenPRForIssue (uses cached listPRs)", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearApiCache();
    clearRateLimitState();
  });

  it("finds PR matching the issue branch prefix", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { number: 5, title: "fix: something", headRefName: "claws/issue-42-abc1", baseRefName: "main", labels: [], author: { login: "bot" } },
        { number: 6, title: "fix: other", headRefName: "claws/issue-99-def2", baseRefName: "main", labels: [], author: { login: "bot" } },
      ]), "");
    });

    const pr = await getOpenPRForIssue("org/repo", 42);
    expect(pr).not.toBeNull();
    expect(pr!.number).toBe(5);
  });

  it("returns null when no PR matches", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "[]", "");
    });

    const pr = await getOpenPRForIssue("org/repo", 42);
    expect(pr).toBeNull();
  });

  it("reuses cached listPRs result", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { number: 5, title: "fix: something", headRefName: "claws/issue-42-abc1", baseRefName: "main", labels: [], author: { login: "bot" } },
      ]), "");
    });

    await listPRs("org/repo");
    const pr = await getOpenPRForIssue("org/repo", 42);

    expect(pr!.number).toBe(5);
    // Only 1 gh call despite two function calls — cache shared
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

describe("getFailingCheck", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("returns the first failed check", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SUCCESS", link: "" },
        { name: "test", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/123" },
      ]), "");
    });

    const check = await getFailingCheck("org/repo", 1);
    expect(check).toEqual({
      name: "test",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
  });

  it("returns undefined when all checks pass", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "build", state: "SUCCESS", link: "" },
      ]), "");
    });

    expect(await getFailingCheck("org/repo", 1)).toBeUndefined();
  });

  it("returns undefined on error", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("fail"), "", "fail");
    });

    expect(await getFailingCheck("org/repo", 1)).toBeUndefined();
  });
});

describe("getFailedRunLog", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("extracts run ID and fetches log, truncated to 20K", async () => {
    let callIndex = 0;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      callIndex++;
      if (args.includes("checks")) {
        cb(null, JSON.stringify([
          {
            name: "CI",
            state: "FAILURE",
            link: "https://github.com/org/repo/actions/runs/99999/jobs/1",
          },
        ]), "");
      } else if (args.includes("view")) {
        cb(null, "x".repeat(25000), "");
      }
    });

    const log = await getFailedRunLog("org/repo", 5);
    expect(log).toHaveLength(20000);
  });

  it("returns empty string when no failed check has a link", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "CI", state: "SUCCESS", link: "" },
      ]), "");
    });

    const log = await getFailedRunLog("org/repo", 5);
    expect(log).toBe("");
  });

  it("falls back to API when --log-failed fails (in progress)", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("checks")) {
        cb(null, JSON.stringify([
          { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/12345/jobs/1" },
        ]), "");
      } else if (argsStr.includes("view") && argsStr.includes("--log-failed")) {
        cb(new Error("run 12345 is still in progress"), "", "run 12345 is still in progress");
      } else if (argsStr.includes("actions/runs/12345/jobs")) {
        cb(null, JSON.stringify({
          jobs: [{ id: 777, conclusion: "failure", name: "build" }],
        }), "");
      } else if (argsStr.includes("actions/jobs/777/logs")) {
        cb(null, "Error: test failed on line 42", "");
      }
    });

    const log = await getFailedRunLog("org/repo", 5);
    expect(log).toBe("Error: test failed on line 42");
  });

  it("falls back to API when --log-failed fails (log not found)", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("checks")) {
        cb(null, JSON.stringify([
          { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/12345/jobs/1" },
        ]), "");
      } else if (argsStr.includes("view") && argsStr.includes("--log-failed")) {
        cb(new Error("log not found: 66858365573"), "", "log not found: 66858365573");
      } else if (argsStr.includes("actions/runs/12345/jobs")) {
        cb(null, JSON.stringify({
          jobs: [{ id: 888, conclusion: "failure", name: "test" }],
        }), "");
      } else if (argsStr.includes("actions/jobs/888/logs")) {
        cb(null, "FAIL src/app.test.ts", "");
      }
    });

    const log = await getFailedRunLog("org/repo", 5);
    expect(log).toBe("FAIL src/app.test.ts");
  });

  it("returns empty string when fallback finds no failed jobs", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("checks")) {
        cb(null, JSON.stringify([
          { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/12345/jobs/1" },
        ]), "");
      } else if (argsStr.includes("view") && argsStr.includes("--log-failed")) {
        cb(new Error("run 12345 is still in progress"), "", "run 12345 is still in progress");
      } else if (argsStr.includes("actions/runs/12345/jobs")) {
        cb(null, JSON.stringify({
          jobs: [{ id: 999, conclusion: null, name: "build" }],
        }), "");
      }
    });

    const log = await getFailedRunLog("org/repo", 5);
    expect(log).toBe("");
  });

  it("falls back to API when --log-failed returns empty output", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("checks")) {
        cb(null, JSON.stringify([
          { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/12345/jobs/1" },
        ]), "");
      } else if (argsStr.includes("view") && argsStr.includes("--log-failed")) {
        cb(null, "", "");
      } else if (argsStr.includes("actions/runs/12345/jobs")) {
        cb(null, JSON.stringify({
          jobs: [{ id: 666, conclusion: "failure", name: "cypress" }],
        }), "");
      } else if (argsStr.includes("actions/jobs/666/logs")) {
        cb(null, "##[error]The runner has received a shutdown signal.", "");
      }
    });

    const log = await getFailedRunLog("org/repo", 5);
    expect(log).toBe("##[error]The runner has received a shutdown signal.");
  });

  it("returns empty string when both primary and fallback fail", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("checks")) {
        cb(null, JSON.stringify([
          { name: "CI", state: "FAILURE", link: "https://github.com/org/repo/actions/runs/12345/jobs/1" },
        ]), "");
      } else if (argsStr.includes("view") && argsStr.includes("--log-failed")) {
        cb(new Error("run 12345 is still in progress"), "", "run 12345 is still in progress");
      } else {
        cb(new Error("API error"), "", "API error");
      }
    });

    const log = await getFailedRunLog("org/repo", 5);
    expect(log).toBe("");
  });
});

describe("getPRReviewComments", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
    clearApiCache();
  });

  it("assembles reviews, inline comments, and issue comments", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("api user")) {
        cb(null, "test-bot\n", "");
      } else if (argsStr.includes("/reviews")) {
        cb(null, JSON.stringify([
          { user: { login: "alice" }, state: "CHANGES_REQUESTED", body: "Fix this" },
        ]), "");
      } else if (argsStr.includes("/pulls/") && argsStr.includes("/reactions")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/pulls/") && argsStr.includes("/comments")) {
        cb(null, JSON.stringify([
          { id: 100, user: { login: "bob" }, path: "src/main.ts", line: 42, body: "Typo here", diff_hunk: "@@ -1,3 +1,3 @@" },
        ]), "");
      } else if (argsStr.includes("/issues/") && argsStr.includes("/reactions")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/issues/")) {
        cb(null, JSON.stringify([
          { id: 500, user: { login: "charlie" }, body: "LGTM with comments" },
        ]), "");
      } else if (argsStr.includes("graphql")) {
        cb(null, JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          } } } },
        }), "");
      }
    });

    const result = await getPRReviewComments("org/repo", 1);
    expect(result.formatted).toContain("alice");
    expect(result.formatted).toContain("CHANGES_REQUESTED");
    expect(result.formatted).toContain("Fix this");
    expect(result.formatted).toContain("bob");
    expect(result.formatted).toContain("src/main.ts:42");
    expect(result.formatted).toContain("Typo here");
    expect(result.formatted).toContain("charlie");
    expect(result.formatted).toContain("LGTM with comments");
    expect(result.reviewCommentIds).toContain(100);
    expect(result.commentIds).toContain(500);
  });

  it("filters out comments from resolved review threads", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("api user")) {
        cb(null, "test-bot\n", "");
      } else if (argsStr.includes("/reviews")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/pulls/") && argsStr.includes("/reactions")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/pulls/") && argsStr.includes("/comments")) {
        cb(null, JSON.stringify([
          { id: 100, user: { login: "bob" }, path: "src/main.ts", line: 42, body: "Resolved comment", diff_hunk: "@@ -1,3 +1,3 @@" },
          { id: 200, user: { login: "carol" }, path: "src/app.ts", line: 10, body: "Unresolved comment", diff_hunk: "@@ -5,3 +5,3 @@" },
        ]), "");
      } else if (argsStr.includes("/issues/")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("graphql")) {
        cb(null, JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { isResolved: true, comments: { nodes: [{ databaseId: 100 }] } },
              { isResolved: false, comments: { nodes: [{ databaseId: 200 }] } },
            ],
          } } } },
        }), "");
      }
    });

    const result = await getPRReviewComments("org/repo", 1);
    expect(result.formatted).not.toContain("Resolved comment");
    expect(result.formatted).toContain("Unresolved comment");
    expect(result.formatted).toContain("carol");
  });

  it("returns empty PRReviewData on error", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("API error"), "", "API error");
    });

    const result = await getPRReviewComments("org/repo", 1);
    expect(result.formatted).toBe("");
    expect(result.commentIds).toEqual([]);
    expect(result.reviewCommentIds).toEqual([]);
  });

  it("includes Claws-automated issue comments with attribution label", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("api user")) {
        cb(null, "test-bot\n", "");
      } else if (argsStr.includes("/reviews")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/pulls/") && argsStr.includes("/comments")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/issues/") && argsStr.includes("/reactions")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/issues/")) {
        cb(null, JSON.stringify([
          { id: 501, user: { login: "claws-bot" }, body: `Some automated response\n${CLAWS_COMMENT_MARKER}` },
          { id: 502, user: { login: "alice" }, body: "Please fix the tests" },
        ]), "");
      } else if (argsStr.includes("graphql")) {
        cb(null, JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          } } } },
        }), "");
      }
    });

    const result = await getPRReviewComments("org/repo", 1);
    expect(result.formatted).toContain("Some automated response");
    expect(result.formatted).toContain("(automated by Claws)");
    expect(result.formatted).toContain("claws-bot");
    expect(result.formatted).not.toContain(CLAWS_COMMENT_MARKER);
    expect(result.formatted).toContain("alice");
    expect(result.formatted).toContain("Please fix the tests");
  });

  it("does not filter reviews or inline comments by login", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("api user")) {
        cb(null, "test-bot\n", "");
      } else if (argsStr.includes("/reviews")) {
        cb(null, JSON.stringify([
          { user: { login: "stjohnb" }, state: "COMMENTED", body: "Looks good overall" },
        ]), "");
      } else if (argsStr.includes("/pulls/") && argsStr.includes("/reactions")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/pulls/") && argsStr.includes("/comments")) {
        cb(null, JSON.stringify([
          { id: 300, user: { login: "stjohnb" }, path: "src/app.ts", line: 5, body: "Consider renaming", diff_hunk: "@@ -1,3 +1,3 @@" },
          { id: 301, user: { login: "test-bot" }, path: "src/utils.ts", line: 10, body: "Needs a type annotation", diff_hunk: "@@ -8,3 +8,3 @@" },
        ]), "");
      } else if (argsStr.includes("/issues/")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("graphql")) {
        cb(null, JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          } } } },
        }), "");
      }
    });

    const result = await getPRReviewComments("org/repo", 1);
    expect(result.formatted).toContain("stjohnb");
    expect(result.formatted).toContain("Looks good overall");
    expect(result.formatted).toContain("Consider renaming");
    expect(result.formatted).toContain("test-bot");
    expect(result.formatted).toContain("Needs a type annotation");
    expect(result.reviewCommentIds).toContain(300);
    expect(result.reviewCommentIds).toContain(301);
  });

  it("excludes bare LGTM issue-tab comments from review data", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("api user")) {
        cb(null, "test-bot\n", "");
      } else if (argsStr.includes("/reviews")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/pulls/") && argsStr.includes("/comments")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/issues/") && argsStr.includes("/reactions")) {
        cb(null, "[]", "");
      } else if (argsStr.includes("/issues/")) {
        cb(null, JSON.stringify([
          { id: 600, user: { login: "reviewer" }, body: "LGTM" },
          { id: 601, user: { login: "alice" }, body: "Please fix the tests" },
        ]), "");
      } else if (argsStr.includes("graphql")) {
        cb(null, JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          } } } },
        }), "");
      }
    });

    const result = await getPRReviewComments("org/repo", 1);
    expect(result.formatted).not.toContain("Comment by @reviewer");
    expect(result.commentIds).not.toContain(600);
    expect(result.formatted).toContain("alice");
    expect(result.formatted).toContain("Please fix the tests");
    expect(result.commentIds).toContain(601);
  });

  it("handles empty reviews gracefully", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const argsStr = args.join(" ");
      if (argsStr.includes("api user")) {
        cb(null, "test-bot\n", "");
      } else if (argsStr.includes("graphql")) {
        cb(null, JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          } } } },
        }), "");
      } else {
        cb(null, "[]", "");
      }
    });

    const result = await getPRReviewComments("org/repo", 1);
    expect(result.formatted).toBe("");
    expect(result.commentIds).toEqual([]);
    expect(result.reviewCommentIds).toEqual([]);
  });
});

describe("getIssueComments", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
    clearApiCache();
  });

  it("returns comments with id, body, and login, filtering empty bodies", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { id: 1, body: "First comment", user: { login: "alice" } },
        { id: 2, body: "  ", user: { login: "bob" } },
        { id: 3, body: "Third comment", user: { login: "charlie" } },
      ]), "");
    });

    const comments = await getIssueComments("org/repo", 1);
    expect(comments).toEqual([
      { id: 1, body: "First comment", login: "alice" },
      { id: 3, body: "Third comment", login: "charlie" },
    ]);
  });
});

describe("editIssueComment", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("calls gh api PATCH with visible header and marker", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "", "");
    });

    await editIssueComment("org/repo", 123, "Updated body");

    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["api", "--method", "PATCH", "repos/org/repo/issues/comments/123", "-f", `body=${CLAWS_VISIBLE_HEADER}\n\nUpdated body\n${CLAWS_COMMENT_MARKER}`],
      expect.any(Object),
      expect.any(Function),
    );
  });
});

describe("ensureLabel", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("passes color and description for known labels", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "", "");
    });

    await ensureLabel("org/repo", "Refined");

    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["label", "create", "Refined", "--repo", "org/repo", "--force", "--color", "0075ca", "--description", "Issue is ready for claws to implement"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("omits color and description for unknown labels", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "", "");
    });

    await ensureLabel("org/repo", "unknown-label");

    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["label", "create", "unknown-label", "--repo", "org/repo", "--force"],
      expect.any(Object),
      expect.any(Function),
    );
  });
});

describe("ensureAllLabels", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("calls ensureLabel for every entry in LABEL_SPECS", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "", "");
    });

    await ensureAllLabels("org/repo");

    // LABEL_SPECS in mock has 3 entries: "Refined", "Ready", and "Priority"
    const calls = mockExecFile.mock.calls.filter(
      (call: any[]) => call[1][0] === "label",
    );
    expect(calls).toHaveLength(3);

    const labelNames = calls.map((call: any[]) => call[1][2]);
    expect(labelNames).toContain("Refined");
    expect(labelNames).toContain("Ready");
    expect(labelNames).toContain("Priority");
  });
});

describe("listLabels", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("returns parsed label names from gh output", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { name: "bug" },
        { name: "Refined" },
        { name: "enhancement" },
      ]), "");
    });

    const labels = await listLabels("org/repo");
    expect(labels).toEqual(["bug", "Refined", "enhancement"]);
  });
});

describe("deleteLabel", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("calls gh label delete with --yes flag", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "", "");
    });

    await deleteLabel("org/repo", "bug");

    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["label", "delete", "bug", "--repo", "org/repo", "--yes"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("warns but does not throw on failure", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("not found"), "", "not found");
    });

    await expect(deleteLabel("org/repo", "missing")).resolves.toBeUndefined();
  });
});

describe("deleteStaleLabels", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("deletes labels present in legacyLabels set", async () => {
    const deletedLabels: string[] = [];
    const legacyLabels = new Set(["Needs Refinement", "Plan Produced", "Reviewed"]);

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === "label" && args[1] === "list") {
        cb(null, JSON.stringify([
          { name: "Refined" },
          { name: "Needs Refinement" },
          { name: "Reviewed" },
          { name: "bug" },
        ]), "");
      } else if (args[0] === "label" && args[1] === "delete") {
        deletedLabels.push(args[2]);
        cb(null, "", "");
      }
    });

    await deleteStaleLabels("org/repo", legacyLabels);

    expect(deletedLabels).toContain("Needs Refinement");
    expect(deletedLabels).toContain("Reviewed");
    expect(deletedLabels).not.toContain("Refined");
    expect(deletedLabels).not.toContain("bug");
  });

  it("does nothing when no legacy labels are present", async () => {
    const legacyLabels = new Set(["Needs Refinement", "Plan Produced"]);

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === "label" && args[1] === "list") {
        cb(null, JSON.stringify([
          { name: "Refined" },
          { name: "Ready" },
        ]), "");
      } else {
        cb(null, "", "");
      }
    });

    await deleteStaleLabels("org/repo", legacyLabels);

    const deleteCalls = mockExecFile.mock.calls.filter(
      (call: any[]) => call[1][0] === "label" && call[1][1] === "delete",
    );
    expect(deleteCalls).toHaveLength(0);
  });
});

describe("searchIssues", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearRateLimitState();
  });

  it("returns parsed issues and passes --json before -- separator", async () => {
    const issues = [
      { number: 1, title: "[claws-error] Something broke" },
      { number: 2, title: "[claws-error] Another error" },
    ];

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      // Verify --json appears before -- in the args
      const jsonIndex = args.indexOf("--json");
      const dashDashIndex = args.indexOf("--");
      expect(jsonIndex).toBeGreaterThan(-1);
      expect(dashDashIndex).toBeGreaterThan(-1);
      expect(jsonIndex).toBeLessThan(dashDashIndex);
      cb(null, JSON.stringify(issues), "");
    });

    const result = await searchIssues("org/repo", "[claws-error] Something broke");
    expect(result).toEqual(issues);
  });

  it("handles titles with special characters via -- separator", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      // The title query should come after --
      const dashDashIndex = args.indexOf("--");
      expect(args[dashDashIndex + 1]).toBe("--problematic-title");
      cb(null, "[]", "");
    });

    const result = await searchIssues("org/repo", "--problematic-title");
    expect(result).toEqual([]);
  });

  it("throws descriptive error on non-JSON output", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "Showing 0 results\n", "");
    });

    await expect(searchIssues("org/repo", "query")).rejects.toThrow(
      "Failed to parse JSON from gh search issues",
    );
  });
});

describe("repo cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExecFile.mockReset();
    clearRepoCache();
    clearRateLimitState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns cached repos within TTL without a second gh call", async () => {
    const repoData = [
      { nameWithOwner: "test-owner/repo1", name: "repo1", owner: { login: "test-owner" }, defaultBranchRef: { name: "main" }, isArchived: false },
    ];
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify(repoData), "");
    });

    const first = await listRepos();
    expect(first).toHaveLength(1);
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    const second = await listRepos();
    expect(second).toHaveLength(1);
    // Still only 1 call — served from cache
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const repoData = [
      { nameWithOwner: "test-owner/repo1", name: "repo1", owner: { login: "test-owner" }, defaultBranchRef: { name: "main" }, isArchived: false },
    ];
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify(repoData), "");
    });

    await listRepos();
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await listRepos();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent listRepos calls", async () => {
    const repoData = [
      { nameWithOwner: "test-owner/repo1", name: "repo1", owner: { login: "test-owner" }, defaultBranchRef: { name: "main" }, isArchived: false },
    ];
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      // Simulate async delay
      setTimeout(() => cb(null, JSON.stringify(repoData), ""), 100);
    });

    // Fire two concurrent calls
    const p1 = listRepos();
    const p2 = listRepos();

    await vi.advanceTimersByTimeAsync(100);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    // Only one gh execution despite two concurrent calls
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("returns stale cache when fetch returns empty (e.g. rate limit)", async () => {
    const repoData = [
      { nameWithOwner: "test-owner/repo1", name: "repo1", owner: { login: "test-owner" }, defaultBranchRef: { name: "main" }, isArchived: false },
    ];

    // First call succeeds
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify(repoData), "");
    });
    const first = await listRepos();
    expect(first).toHaveLength(1);

    // Expire the cache
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // Second call fails (non-transient error so gh() rejects without retrying)
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("authentication required"), "", "authentication required");
    });

    const second = await listRepos();
    // Returns stale cache instead of empty
    expect(second).toHaveLength(1);
    expect(second[0].fullName).toBe("test-owner/repo1");
  });

  it("clearRepoCache forces a fresh fetch", async () => {
    const repoData = [
      { nameWithOwner: "test-owner/repo1", name: "repo1", owner: { login: "test-owner" }, defaultBranchRef: { name: "main" }, isArchived: false },
    ];
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify(repoData), "");
    });

    await listRepos();
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    clearRepoCache();

    await listRepos();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

describe("apiCache TTL for listIssuesByLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExecFile.mockReset();
    clearApiCache();
    clearRateLimitState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("listIssuesByLabel returns cached results within TTL", async () => {
    const issues = [
      { number: 1, title: "Issue 1", body: "body", labels: [{ name: "Refined" }], updatedAt: "2024-01-01T00:00:00Z" },
    ];
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify(issues), "");
    });

    const first = await listIssuesByLabel("org/repo", "Refined");
    expect(first).toHaveLength(1);
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    const second = await listIssuesByLabel("org/repo", "Refined");
    expect(second).toHaveLength(1);
    expect(second[0].body).toBe("body");
    // Still only 1 call — served from cache
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("listIssuesByLabel re-fetches after TTL expires", async () => {
    const issues = [
      { number: 1, title: "Issue 1", body: "body", labels: [{ name: "Refined" }], updatedAt: "2024-01-01T00:00:00Z" },
    ];
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify(issues), "");
    });

    await listIssuesByLabel("org/repo", "Refined");
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Advance past the 60-second TTL
    vi.advanceTimersByTime(60 * 1000 + 1);

    await listIssuesByLabel("org/repo", "Refined");
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

describe("isClawsComment", () => {
  it("returns true when body contains the Claws marker", () => {
    expect(isClawsComment(`Some response\n${CLAWS_COMMENT_MARKER}`)).toBe(true);
  });

  it("returns false when body does not contain the marker", () => {
    expect(isClawsComment("A normal comment")).toBe(false);
  });
});

describe("stripClawsMarker", () => {
  it("strips both hidden marker and visible header", () => {
    const body = `${CLAWS_VISIBLE_HEADER}\n\nPlan content\n${CLAWS_COMMENT_MARKER}`;
    expect(stripClawsMarker(body)).toBe("Plan content");
  });

  it("strips hidden marker only when visible header is absent", () => {
    const body = `Plan content\n${CLAWS_COMMENT_MARKER}`;
    expect(stripClawsMarker(body)).toBe("Plan content");
  });

  it("returns body unchanged when no markers present", () => {
    expect(stripClawsMarker("Just text")).toBe("Just text");
  });
});

describe("updatePRBody", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("calls gh pr edit with correct arguments", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await updatePRBody("org/repo", 42, "new body text");

    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["pr", "edit", "--repo", "org/repo", "42", "--body", "new body text"],
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe("isItemSkipped / isItemPrioritized", () => {
  it("isItemSkipped returns false when SKIPPED_ITEMS is empty", () => {
    expect(isItemSkipped("org/repo", 1)).toBe(false);
  });

  it("isItemSkipped returns true when item is in SKIPPED_ITEMS", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).SKIPPED_ITEMS = [{ repo: "org/repo", number: 42 }];
    try {
      expect(isItemSkipped("org/repo", 42)).toBe(true);
      expect(isItemSkipped("org/repo", 43)).toBe(false);
      expect(isItemSkipped("org/other", 42)).toBe(false);
    } finally {
      (configMod as Record<string, unknown>).SKIPPED_ITEMS = [];
    }
  });

  it("isItemPrioritized returns false when PRIORITIZED_ITEMS is empty", () => {
    expect(isItemPrioritized("org/repo", 1)).toBe(false);
  });

  it("isItemPrioritized returns true when item is in PRIORITIZED_ITEMS", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [{ repo: "org/repo", number: 7 }];
    try {
      expect(isItemPrioritized("org/repo", 7)).toBe(true);
      expect(isItemPrioritized("org/repo", 8)).toBe(false);
    } finally {
      (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [];
    }
  });
});

describe("populateQueueCache skip/priority integration", () => {
  beforeEach(() => {
    clearQueueCache();
  });

  it("skips items in the skip list", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).SKIPPED_ITEMS = [{ repo: "org/repo", number: 5 }];
    try {
      populateQueueCache("refined", "org/repo", { number: 5, title: "Skipped", type: "issue" });
      const snap = getQueueSnapshot(["refined"]);
      expect(snap.items).toHaveLength(0);
    } finally {
      (configMod as Record<string, unknown>).SKIPPED_ITEMS = [];
    }
  });

  it("marks prioritized items", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [{ repo: "org/repo", number: 3 }];
    try {
      populateQueueCache("refined", "org/repo", { number: 3, title: "Prioritized", type: "issue" });
      populateQueueCache("refined", "org/repo", { number: 4, title: "Normal", type: "issue" });
      const snap = getQueueSnapshot(["refined"]);
      expect(snap.items).toHaveLength(2);
      expect(snap.items[0].number).toBe(3);
      expect(snap.items[0].prioritized).toBe(true);
      expect(snap.items[1].prioritized).toBeFalsy();
    } finally {
      (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [];
    }
  });
});

describe("removeQueueItem", () => {
  beforeEach(() => {
    clearQueueCache();
  });

  it("removes all cache entries for a given repo:number", () => {
    populateQueueCache("refined", "org/repo", { number: 10, title: "A", type: "issue" });
    populateQueueCache("needs-refinement", "org/repo", { number: 10, title: "A", type: "issue" });
    populateQueueCache("refined", "org/repo", { number: 11, title: "B", type: "issue" });

    removeQueueItem("org/repo", 10);

    const snap = getQueueSnapshot(["refined", "needs-refinement"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].number).toBe(11);
  });
});

describe("getQueueSnapshot prioritized sorting", () => {
  beforeEach(async () => {
    clearQueueCache();
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [{ repo: "org/repo", number: 2 }];
  });

  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [];
  });

  it("sorts prioritized items before non-prioritized", () => {
    populateQueueCache("refined", "org/repo", { number: 1, title: "Normal", type: "issue", updatedAt: "2025-01-02T00:00:00Z" });
    populateQueueCache("refined", "org/repo", { number: 2, title: "Priority", type: "issue", updatedAt: "2025-01-01T00:00:00Z" });

    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items[0].number).toBe(2);
    expect(snap.items[0].prioritized).toBe(true);
    expect(snap.items[1].number).toBe(1);
  });
});

describe("hasPriorityLabel", () => {
  it("returns true when Priority label is present", () => {
    expect(hasPriorityLabel([{ name: "Priority" }, { name: "bug" }])).toBe(true);
  });

  it("returns false when Priority label is absent", () => {
    expect(hasPriorityLabel([{ name: "bug" }, { name: "enhancement" }])).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(hasPriorityLabel([])).toBe(false);
  });
});

describe("populateQueueCache label-based priority", () => {
  beforeEach(() => {
    clearQueueCache();
  });

  it("marks items as prioritized when priority flag is true", () => {
    populateQueueCache("refined", "org/repo", { number: 7, title: "Priority Issue", type: "issue", priority: true });
    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].prioritized).toBe(true);
  });

  it("does not mark items as prioritized when priority flag is false", () => {
    populateQueueCache("refined", "org/repo", { number: 8, title: "Normal Issue", type: "issue", priority: false });
    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].prioritized).toBeFalsy();
  });

  it("sorts label-priority items before non-priority items", () => {
    populateQueueCache("refined", "org/repo", { number: 1, title: "Normal", type: "issue", updatedAt: "2025-01-02T00:00:00Z" });
    populateQueueCache("refined", "org/repo", { number: 2, title: "Priority", type: "issue", updatedAt: "2025-01-01T00:00:00Z", priority: true });

    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items[0].number).toBe(2);
    expect(snap.items[0].prioritized).toBe(true);
    expect(snap.items[1].number).toBe(1);
  });
});
