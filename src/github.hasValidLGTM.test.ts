import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({ GITHUB_OWNERS: [], LABEL_SPECS: {} }));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./slack.js", () => ({ notify: vi.fn() }));
vi.mock("./error-reporter.js", () => ({ reportError: vi.fn() }));

// Mock child_process.execFile to control gh CLI responses
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

// Import after mocks are set up
import * as github from "./github.js";

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;

function mockGhCalls(handlers: Array<{ match: (args: string[]) => boolean; response: string }>) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecFileCb) => {
    for (const h of handlers) {
      if (h.match(args)) {
        cb(null, h.response, "");
        return;
      }
    }
    cb(new Error(`Unexpected gh call: ${args.join(" ")}`), "", "unexpected call");
  });
}

describe("getPRLatestCommitDate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    github.clearRateLimitState();
    github.clearApiCache();
  });

  it("returns the latest commit date", async () => {
    mockGhCalls([
      { match: (args) => args.some((a) => a.includes("/commits")), response: "2025-01-15T10:00:00Z\n" },
    ]);

    const date = await github.getPRLatestCommitDate("owner/repo", 42);
    expect(date).toBe("2025-01-15T10:00:00Z");
  });
});

describe("hasValidLGTM", () => {
  const selfLogin = "claws-bot";
  const commitDate = "2025-01-15T10:00:00Z";

  beforeEach(() => {
    vi.clearAllMocks();
    github.clearRateLimitState();
    github.clearApiCache();
  });

  type CommitDef = {
    message: string;
    date: string;
    parentCount?: number;
  };

  function setupMocks(
    comments: Array<{ body: string; login: string; created_at: string }>,
    commits?: CommitDef[],
  ) {
    const commitsArray = commits ?? [
      { message: "feat: some change", date: commitDate, parentCount: 1 },
    ];
    const commitsJson = JSON.stringify(commitsArray.map((c) => ({
      commit: { message: c.message, committer: { date: c.date } },
      parents: Array.from({ length: c.parentCount ?? 1 }, (_, i) => ({ sha: `abc${i}` })),
    })));
    const commentsJson = JSON.stringify(comments.map((c) => ({
      body: c.body,
      user: { login: c.login },
      created_at: c.created_at,
    })));

    mockGhCalls([
      { match: (args) => args.some((a) => a.includes("/commits")), response: commitsJson },
      { match: (args) => args.some((a) => a.includes("/comments")), response: commentsJson },
    ]);
  }

  it("returns false when there are no comments", async () => {
    setupMocks([]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(false);
  });

  it("returns true when LGTM comment is after latest commit by non-self user", async () => {
    setupMocks([
      { body: "LGTM", login: "reviewer", created_at: "2025-01-15T12:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(true);
  });

  it("returns false when LGTM comment is before latest commit (invalidated by push)", async () => {
    setupMocks([
      { body: "LGTM", login: "reviewer", created_at: "2025-01-15T08:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(false);
  });

  it("returns true when LGTM comment is by shared account (user and CLAWS share login)", async () => {
    setupMocks([
      { body: "LGTM", login: selfLogin, created_at: "2025-01-15T12:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(true);
  });

  it("returns true when multiple LGTM comments exist and the latest is valid", async () => {
    setupMocks([
      { body: "LGTM", login: "reviewer1", created_at: "2025-01-15T08:00:00Z" },
      { body: "LGTM", login: "reviewer2", created_at: "2025-01-15T12:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(true);
  });

  it("returns false when multiple LGTM comments exist but the latest is before a commit", async () => {
    setupMocks([
      { body: "LGTM", login: "reviewer1", created_at: "2025-01-15T06:00:00Z" },
      { body: "LGTM", login: "reviewer2", created_at: "2025-01-15T08:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(false);
  });

  it("handles case-insensitive LGTM — 'lgtm'", async () => {
    setupMocks([
      { body: "lgtm", login: "reviewer", created_at: "2025-01-15T12:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(true);
  });

  it("handles case-insensitive LGTM — 'Lgtm'", async () => {
    setupMocks([
      { body: "Lgtm", login: "reviewer", created_at: "2025-01-15T12:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(true);
  });

  it("handles LGTM with surrounding whitespace", async () => {
    setupMocks([
      { body: "  LGTM  \n", login: "reviewer", created_at: "2025-01-15T12:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(true);
  });

  it("rejects comments that contain LGTM but are not exact matches", async () => {
    setupMocks([
      { body: "not LGTM", login: "reviewer", created_at: "2025-01-15T12:00:00Z" },
      { body: "LGTM but fix X first", login: "reviewer", created_at: "2025-01-15T12:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(false);
  });

  it("ignores non-LGTM comments", async () => {
    setupMocks([
      { body: "Looks good, ship it!", login: "reviewer", created_at: "2025-01-15T12:00:00Z" },
      { body: "Nice work", login: "reviewer", created_at: "2025-01-15T12:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(false);
  });

  // ── Merge-from-base exemption tests ──

  it("merge-from-main after LGTM does not invalidate", async () => {
    setupMocks(
      [{ body: "LGTM", login: "reviewer", created_at: "2025-01-15T11:00:00Z" }],
      [
        { message: "feat: some change", date: "2025-01-15T10:00:00Z", parentCount: 1 },
        { message: "Merge branch 'main' into claws/issue-42", date: "2025-01-15T12:00:00Z", parentCount: 2 },
      ],
    );
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(true);
  });

  it("non-main merge after LGTM still invalidates", async () => {
    setupMocks(
      [{ body: "LGTM", login: "reviewer", created_at: "2025-01-15T11:00:00Z" }],
      [
        { message: "feat: some change", date: "2025-01-15T10:00:00Z", parentCount: 1 },
        { message: "Merge branch 'feature-x' into claws/issue-42", date: "2025-01-15T12:00:00Z", parentCount: 2 },
      ],
    );
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(false);
  });

  it("regular commit after merge-from-main invalidates", async () => {
    setupMocks(
      [{ body: "LGTM", login: "reviewer", created_at: "2025-01-15T11:00:00Z" }],
      [
        { message: "feat: some change", date: "2025-01-15T10:00:00Z", parentCount: 1 },
        { message: "Merge branch 'main' into claws/issue-42", date: "2025-01-15T12:00:00Z", parentCount: 2 },
        { message: "fix: another change", date: "2025-01-15T13:00:00Z", parentCount: 1 },
      ],
    );
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(false);
  });

  it("all commits are merge-from-main — LGTM remains valid", async () => {
    setupMocks(
      [{ body: "LGTM", login: "reviewer", created_at: "2025-01-15T09:00:00Z" }],
      [
        { message: "Merge branch 'main' into claws/issue-42", date: "2025-01-15T10:00:00Z", parentCount: 2 },
        { message: "Merge branch 'main' into claws/issue-42", date: "2025-01-15T12:00:00Z", parentCount: 2 },
      ],
    );
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(true);
  });

  it("remote-tracking branch pattern is treated as merge-from-main", async () => {
    setupMocks(
      [{ body: "LGTM", login: "reviewer", created_at: "2025-01-15T11:00:00Z" }],
      [
        { message: "feat: some change", date: "2025-01-15T10:00:00Z", parentCount: 1 },
        { message: "Merge remote-tracking branch 'origin/main' into claws/issue-42", date: "2025-01-15T12:00:00Z", parentCount: 2 },
      ],
    );
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(true);
  });

  it("baseBranch parameter is respected — master base only exempts master merges", async () => {
    setupMocks(
      [{ body: "LGTM", login: "reviewer", created_at: "2025-01-15T11:00:00Z" }],
      [
        { message: "feat: some change", date: "2025-01-15T10:00:00Z", parentCount: 1 },
        { message: "Merge branch 'main' into claws/issue-42", date: "2025-01-15T12:00:00Z", parentCount: 2 },
      ],
    );
    // baseBranch is "master", so merging "main" is NOT exempt
    expect(await github.hasValidLGTM("owner/repo", 42, "master")).toBe(false);
  });

  it("returns false when LGTM comment is a Claws-automated comment", async () => {
    setupMocks([
      { body: `LGTM\n<!-- claws-automated -->`, login: "claws-bot", created_at: "2025-01-15T12:00:00Z" },
    ]);
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(false);
  });

  it("single-parent commit with merge-like message is not exempt", async () => {
    setupMocks(
      [{ body: "LGTM", login: "reviewer", created_at: "2025-01-15T11:00:00Z" }],
      [
        { message: "feat: some change", date: "2025-01-15T10:00:00Z", parentCount: 1 },
        { message: "Merge branch 'main' into claws/issue-42", date: "2025-01-15T12:00:00Z", parentCount: 1 },
      ],
    );
    expect(await github.hasValidLGTM("owner/repo", 42, "main")).toBe(false);
  });
});
