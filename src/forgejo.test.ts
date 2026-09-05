import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cfg = vi.hoisted(() => ({
  token: "test-token" as string | undefined,
  baseUrl: "https://forge.example.com",
}));

vi.mock("./config.js", () => ({
  get FORGEJO_TOKEN() {
    return cfg.token;
  },
  get FORGEJO_BASE_URL() {
    return cfg.baseUrl;
  },
  ALLOWED_ACTORS: ["stjohnb"],
  LABELS: { duplicate: "Duplicate" },
  LABEL_SPECS: {
    Ready: { color: "0e8a16", description: "Ready to work" },
  } as Record<string, { color: string; description: string }>,
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./slack.js", () => ({ notify: vi.fn() }));

// retryWithBackoff and getPRMergeableState both sleep between attempts; the
// real delays (1s/2s/4s) would make the retry tests unusably slow.
vi.mock("./util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./util.js")>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

import * as forgejo from "./forgejo.js";
import * as log from "./log.js";

const API = "https://forge.example.com/api/v1";

interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = { status: number; body: string } | ((call: RecordedCall) => { status: number; body: string });

let routes: Record<string, Handler>;
let calls: RecordedCall[];

function json(body: unknown, status = 200): { status: number; body: string } {
  return { status, body: JSON.stringify(body) };
}

/** Register `METHOD /path` (query string optional — an exact match wins). */
function route(key: string, handler: Handler | unknown): void {
  routes[key] =
    typeof handler === "function" || (handler as { status?: unknown })?.status !== undefined
      ? (handler as Handler)
      : json(handler);
}

function installFetch(): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const path = String(url).slice(API.length);
    const method = init.method ?? "GET";
    const call: RecordedCall = {
      method,
      path,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const pathOnly = path.split("?")[0]!;
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${pathOnly}`];
    if (!handler) return new Response("no route", { status: 404 });
    const { status, body } = typeof handler === "function" ? handler(call) : handler;
    return new Response(body, { status });
  });
}

beforeEach(() => {
  cfg.token = "test-token";
  cfg.baseUrl = "https://forge.example.com";
  routes = {};
  calls = [];
  forgejo.clearForgejoCache();
  installFetch();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.info).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── HTTP plumbing ──

describe("request plumbing", () => {
  it("sends the token as an Authorization: token header against /api/v1", async () => {
    route("GET /repos/o/r", { full_name: "o/r", default_branch: "main", private: true });
    await forgejo.getRepo("o/r");
    expect(calls[0]!.path).toBe("/repos/o/r");
    expect(calls[0]!.headers["Authorization"]).toBe("token test-token");
  });

  it("throws without retrying when no token is configured", async () => {
    cfg.token = undefined;
    await expect(forgejo.getRepo("o/r")).rejects.toThrow(/no access token configured/);
    expect(calls).toHaveLength(0);
  });

  it("formats a non-OK response as `forgejo <method> <path> failed: HTTP <status>`", async () => {
    route("GET /repos/o/r", { status: 404, body: "nope" });
    await expect(forgejo.getRepo("o/r")).rejects.toThrow(
      "forgejo GET /repos/o/r failed: HTTP 404: nope",
    );
  });

  it("retries a 5xx and succeeds on a later attempt", async () => {
    let n = 0;
    route("GET /repos/o/r", () => {
      n++;
      return n < 3 ? { status: 503, body: "busy" } : json({ full_name: "o/r", default_branch: "main" });
    });
    await expect(forgejo.getDefaultBranch("o/r")).resolves.toBe("main");
    expect(n).toBe(3);
  });

  it("does not retry a 4xx", async () => {
    let n = 0;
    route("GET /repos/o/r", () => {
      n++;
      return { status: 422, body: "bad" };
    });
    await expect(forgejo.getRepo("o/r")).rejects.toThrow(/HTTP 422/);
    expect(n).toBe(1);
  });

  it("retries a network-level failure (no HTTP status)", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n < 2) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ full_name: "o/r", default_branch: "trunk" }), { status: 200 });
    });
    await expect(forgejo.getDefaultBranch("o/r")).resolves.toBe("trunk");
    expect(n).toBe(2);
  });

  it("never consults or trips the global GitHub rate-limit breaker", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/forgejo.ts", "utf8"));
    expect(src).not.toMatch(/isRateLimited\(|setRateLimited\(|from "\.\/rate-limit\.js"/);
  });
});

describe("isConfigured", () => {
  it("is true with a token and false when absent or blank (#2670)", () => {
    try {
      cfg.token = "test-token";
      expect(forgejo.isConfigured()).toBe(true);

      cfg.token = undefined;
      expect(forgejo.isConfigured()).toBe(false);

      cfg.token = "";
      expect(forgejo.isConfigured()).toBe(false);

      cfg.token = "   ";
      expect(forgejo.isConfigured()).toBe(false);
    } finally {
      cfg.token = "test-token";
    }
  });
});

describe("pagination", () => {
  it("keeps paging until a short page arrives", async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ number: n * 100 + i, title: `t${i}`, body: "" }));
    route("GET /repos/o/r/issues?state=open&type=issues&limit=50&page=1", json(page(1, 50)));
    route("GET /repos/o/r/issues?state=open&type=issues&limit=50&page=2", json(page(2, 50)));
    route("GET /repos/o/r/issues?state=open&type=issues&limit=50&page=3", json(page(3, 7)));
    const issues = await forgejo.listOpenIssues("o/r");
    expect(issues).toHaveLength(107);
    expect(calls).toHaveLength(3);
  });
});

// ── Issues ──

describe("issues", () => {
  const rawIssue = {
    number: 12,
    title: "Fix the thing",
    body: "details",
    labels: [{ id: 3, name: "Ready" }],
    user: { login: "stjohnb" },
    state: "open",
    updated_at: "2026-08-01T00:00:00Z",
  };

  it("lists open issues with type=issues so PRs are excluded, mapped to the gh shape", async () => {
    route("GET /repos/o/r/issues?state=open&type=issues&limit=50&page=1", json([rawIssue]));
    const issues = await forgejo.listOpenIssues("o/r");
    expect(calls[0]!.path).toContain("type=issues");
    expect(issues).toEqual([
      {
        number: 12,
        title: "Fix the thing",
        body: "details",
        labels: [{ name: "Ready" }],
        author: { login: "stjohnb" },
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ]);
  });

  it("caches the open-issue list for 60s", async () => {
    route("GET /repos/o/r/issues?state=open&type=issues&limit=50&page=1", json([rawIssue]));
    await forgejo.listOpenIssues("o/r");
    await forgejo.listOpenIssues("o/r");
    expect(calls).toHaveLength(1);
  });

  it("creates an issue with resolved label IDs and invalidates the list cache", async () => {
    route("GET /repos/o/r/labels?limit=50&page=1", json([{ id: 7, name: "Ready" }]));
    route("POST /repos/o/r/issues", json({ number: 99 }));
    route("GET /repos/o/r/issues?state=open&type=issues&limit=50&page=1", json([]));

    await forgejo.listOpenIssues("o/r");
    const num = await forgejo.createIssue("o/r", "T", "B", ["Ready"]);
    expect(num).toBe(99);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ title: "T", body: "B", labels: [7] });

    await forgejo.listOpenIssues("o/r");
    expect(calls.filter((c) => c.path.startsWith("/repos/o/r/issues?state=open"))).toHaveLength(2);
  });

  it("reads title/body uncached and maps a null body to an empty string", async () => {
    route("GET /repos/o/r/issues/5", json({ number: 5, title: "T", body: null }));
    expect(await forgejo.getIssueTitleBody("o/r", 5)).toEqual({ title: "T", body: "" });
    expect(await forgejo.getIssueBody("o/r", 5)).toBe("");
    expect(calls).toHaveLength(2);
  });

  it("uppercases issue state and reports stateReason as null", async () => {
    route("GET /repos/o/r/issues/5", json({ number: 5, title: "T", state: "closed" }));
    expect(await forgejo.getIssueState("o/r", 5)).toEqual({ state: "CLOSED", stateReason: null });
  });

  it("closes an issue with a PATCH and ignores the GitHub-only stateReason", async () => {
    route("PATCH /repos/o/r/issues/5", json({}));
    await forgejo.closeIssue("o/r", 5, "not_planned");
    expect(calls[0]!.body).toEqual({ state: "closed" });
  });

  it("edits title and body through the issue index", async () => {
    route("PATCH /repos/o/r/issues/5", json({}));
    await forgejo.editIssue("o/r", 5, "new body");
    await forgejo.editIssueTitle("o/r", 5, "new title");
    expect(calls[0]!.body).toEqual({ body: "new body" });
    expect(calls[1]!.body).toEqual({ title: "new title" });
  });

  it("filters recently-closed issues by closedAt and honours the limit", async () => {
    route(
      "GET /repos/o/r/issues?state=closed&type=issues&since=2026-08-01T00%3A00%3A00.000Z&limit=50&page=1",
      json([
        { number: 1, title: "old", body: "", closed_at: "2026-07-01T00:00:00Z", user: { login: "a" } },
        { number: 2, title: "new", body: "", closed_at: "2026-08-05T00:00:00Z", user: { login: "b" } },
        { number: 3, title: "open-still", body: "", closed_at: null, user: { login: "c" } },
      ]),
    );
    const out = await forgejo.listRecentlyClosedIssues("o/r", new Date("2026-08-01T00:00:00Z"));
    expect(out.map((i) => i.number)).toEqual([2]);
    expect(out[0]).toMatchObject({ closedAt: "2026-08-05T00:00:00Z", author: "b" });
  });

  it("refuses to transfer an issue", async () => {
    await expect(forgejo.transferIssue("o/r", 1, "o/other")).rejects.toThrow(/no issue-transfer API/);
  });

  it("returns an empty body_html — Gitea renders none", async () => {
    expect(await forgejo.getIssueBodyHtml("o/r", 1)).toBe("");
    expect(calls).toHaveLength(0);
  });
});

// ── Comments ──

describe("issue comments", () => {
  it("lists comments, dropping empty ones and mapping user.login to login", async () => {
    route(
      "GET /repos/o/r/issues/4/comments?limit=50&page=1",
      json([
        { id: 1, body: "hello", user: { login: "stjohnb" } },
        { id: 2, body: "   ", user: { login: "stjohnb" } },
      ]),
    );
    expect(await forgejo.getIssueComments("o/r", 4)).toEqual([
      { id: 1, body: "hello", body_html: "", login: "stjohnb" },
    ]);
  });

  it("posts through the issue index and edits through the comment id", async () => {
    route("POST /repos/o/r/issues/4/comments", json({ id: 1 }));
    route("PATCH /repos/o/r/issues/comments/77", json({}));
    await forgejo.commentOnIssue("o/r", 4, "body text", { agentName: "tester" });
    await forgejo.editIssueComment("o/r", 77, "edited");
    expect(calls[0]!.body).toEqual({ body: "*— Automated by Claws · tester —*\n\nbody text" });
    expect(calls[1]!.body).toEqual({ body: "*— Automated by Claws —*\n\nedited" });
  });
});

// ── Reactions ──

describe("reactions", () => {
  it("uses the shared issues/comments namespace for both comment kinds", async () => {
    route("POST /repos/o/r/issues/comments/11/reactions", json({}));
    await forgejo.addReaction("o/r", 11, "rocket");
    await forgejo.addReviewCommentReaction("o/r", 11, "rocket");
    expect(calls.map((c) => c.path)).toEqual([
      "/repos/o/r/issues/comments/11/reactions",
      "/repos/o/r/issues/comments/11/reactions",
    ]);
    expect(calls[0]!.body).toEqual({ content: "rocket" });
  });

  it("maps reactions into the gh shape", async () => {
    route(
      "GET /repos/o/r/issues/comments/11/reactions",
      json([{ content: "rocket", user: { login: "claws" } }]),
    );
    expect(await forgejo.getCommentReactions("o/r", 11)).toEqual([
      { id: 0, user: { login: "claws" }, content: "rocket" },
    ]);
  });

  it("fails soft on a 404 rather than throwing", async () => {
    route("GET /repos/o/r/issues/comments/11/reactions", { status: 404, body: "gone" });
    route("POST /repos/o/r/issues/comments/11/reactions", { status: 404, body: "gone" });
    await expect(forgejo.getReviewCommentReactions("o/r", 11)).resolves.toEqual([]);
    await expect(forgejo.addReaction("o/r", 11, "rocket")).resolves.toBeUndefined();
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });
});

// ── Labels ──

describe("labels", () => {
  beforeEach(() => {
    route("GET /repos/o/r/labels?limit=50&page=1", json([{ id: 7, name: "Ready" }, { id: 8, name: "Legacy" }]));
  });

  it("lists label names", async () => {
    expect(await forgejo.listLabels("o/r")).toEqual(["Ready", "Legacy"]);
  });

  it("does not recreate a label that already exists", async () => {
    await forgejo.ensureLabel("o/r", "Ready");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("creates a missing label with the #rrggbb colour Gitea requires", async () => {
    routes["GET /repos/o/r/labels?limit=50&page=1"] = json([]);
    route("POST /repos/o/r/labels", json({ id: 21, name: "Ready" }));
    await forgejo.ensureLabel("o/r", "Ready");
    expect(calls[1]!.body).toEqual({ name: "Ready", color: "#0e8a16", description: "Ready to work" });
  });

  it("warns when creating a label that is not in LABEL_SPECS", async () => {
    routes["GET /repos/o/r/labels?limit=50&page=1"] = json([]);
    route("POST /repos/o/r/labels", json({ id: 22, name: "Undeclared" }));
    await forgejo.ensureLabel("o/r", "Undeclared");
    expect(vi.mocked(log.warn).mock.calls.join(" ")).toMatch(/undeclared label "Undeclared"/);
  });

  it("adds and removes labels by ID, not by name", async () => {
    route("POST /repos/o/r/issues/3/labels", json([]));
    route("DELETE /repos/o/r/issues/3/labels/7", json({}));
    await forgejo.addLabel("o/r", 3, "Ready");
    expect(calls.at(-1)!.body).toEqual({ labels: [7] });
    await expect(forgejo.removeLabel("o/r", 3, "Ready")).resolves.toBe(true);
    expect(calls.at(-1)!.path).toBe("/repos/o/r/issues/3/labels/7");
  });

  it("re-reads live labels when a removal fails, so callers can trust the result", async () => {
    route("DELETE /repos/o/r/issues/3/labels/7", { status: 422, body: "nope" });
    route("GET /repos/o/r/issues/3/labels", json([{ id: 8, name: "Legacy" }]));
    await expect(forgejo.removeLabel("o/r", 3, "Ready")).resolves.toBe(true);
  });

  it("deletes a label by ID and forgets it", async () => {
    route("DELETE /repos/o/r/labels/8", json({}));
    await forgejo.deleteLabel("o/r", "Legacy");
    expect(calls.at(-1)!.path).toBe("/repos/o/r/labels/8");
    await forgejo.deleteLabel("o/r", "Legacy");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("renames a label by ID and skips a rename whose target already exists", async () => {
    route("PATCH /repos/o/r/labels/8", json({}));
    await forgejo.applyLabelRenames("o/r", { Legacy: "Modern", Ready: "Legacy", Missing: "Nope" });
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.path).toBe("/repos/o/r/labels/8");
    expect(patches[0]!.body).toEqual({ name: "Modern" });
  });
});

// ── Pull requests ──

const rawPull = {
  number: 42,
  title: "Do the thing",
  body: "Closes #12",
  labels: [{ id: 1, name: "Ready" }],
  user: { login: "claws" },
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
  additions: 10,
  deletions: 2,
  changed_files: 3,
  head: { ref: "claws/issue-12-abcd", sha: "deadbeef", repo: { full_name: "o/r" } },
  base: { ref: "main", sha: "cafe", repo: { full_name: "o/r" } },
};

describe("pull requests", () => {
  it("maps Gitea PR fields into the gh camelCase shape", async () => {
    route("GET /repos/o/r/pulls?state=open&limit=50&page=1", json([rawPull]));
    const [pr] = await forgejo.listPRs("o/r");
    expect(pr).toEqual({
      number: 42,
      title: "Do the thing",
      headRefName: "claws/issue-12-abcd",
      baseRefName: "main",
      labels: [{ name: "Ready" }],
      author: { login: "claws" },
      updatedAt: "2026-08-02T00:00:00Z",
      body: "Closes #12",
      isCrossRepository: false,
      createdAt: "2026-08-01T00:00:00Z",
      isDraft: false,
      changedFiles: 3,
      additions: 10,
      deletions: 2,
    });
  });

  it("flags a fork PR via differing head/base repo full names", async () => {
    route(
      "GET /repos/o/r/pulls?state=open&limit=50&page=1",
      json([{ ...rawPull, head: { ...rawPull.head, repo: { full_name: "fork/r" } } }]),
    );
    const [pr] = await forgejo.listPRs("o/r");
    expect(pr!.isCrossRepository).toBe(true);
  });

  it("creates a PR against the repo default branch and returns its number", async () => {
    route("GET /repos/o/r", json({ full_name: "o/r", default_branch: "main" }));
    route("POST /repos/o/r/pulls", json({ number: 77 }));
    expect(await forgejo.createPR("o/r", "claws/issue-1-x", "T", "B")).toBe(77);
    expect(calls.at(-1)!.body).toEqual({ head: "claws/issue-1-x", base: "main", title: "T", body: "B" });
  });

  it("squash-merges with capital-D Do and pins the head commit", async () => {
    route("POST /repos/o/r/pulls/42/merge", json({}));
    await forgejo.mergePR("o/r", 42, "deadbeef");
    expect(calls[0]!.body).toEqual({
      Do: "squash",
      head_commit_id: "deadbeef",
      delete_branch_after_merge: true,
    });
  });

  it("omits head_commit_id when no expected SHA is supplied", async () => {
    route("POST /repos/o/r/pulls/42/merge", json({}));
    await forgejo.mergePR("o/r", 42);
    expect(calls[0]!.body).toEqual({ Do: "squash", delete_branch_after_merge: true });
  });

  it("closes a PR with a state PATCH and invalidates the list cache", async () => {
    route("GET /repos/o/r/pulls?state=open&limit=50&page=1", json([rawPull]));
    route("PATCH /repos/o/r/pulls/42", json({}));
    await forgejo.listPRs("o/r");
    await forgejo.closePR("o/r", 42);
    expect(calls.at(-1)!.body).toEqual({ state: "closed" });
    await forgejo.listPRs("o/r");
    expect(calls.filter((c) => c.path.startsWith("/repos/o/r/pulls?state=open"))).toHaveLength(2);
  });

  it("reports a merged PR as MERGED and a missing PR as null", async () => {
    route("GET /repos/o/r/pulls/42", json({ ...rawPull, state: "closed", merged: true }));
    route("GET /repos/o/r/pulls/43", { status: 404, body: "missing" });
    expect(await forgejo.getPRState("o/r", 42)).toBe("MERGED");
    expect(await forgejo.getPRState("o/r", 43)).toBeNull();
  });

  it("returns head SHA, body and diff stats", async () => {
    route("GET /repos/o/r/pulls/42", json(rawPull));
    expect(await forgejo.getPRHeadSHA("o/r", 42)).toBe("deadbeef");
    expect(await forgejo.getPRBody("o/r", 42)).toBe("Closes #12");
    expect(await forgejo.getPRDiffStats("o/r", 42)).toEqual({
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      state: "OPEN",
    });
  });

  it("maps mergeable true/false to MERGEABLE/CONFLICTING and a missing value to UNKNOWN", async () => {
    route("GET /repos/o/r/pulls/42", json(rawPull));
    expect(await forgejo.getPRMergeableState("o/r", 42)).toBe("MERGEABLE");
    routes["GET /repos/o/r/pulls/42"] = json({ ...rawPull, mergeable: false });
    expect(await forgejo.getPRMergeableState("o/r", 42)).toBe("CONFLICTING");
    routes["GET /repos/o/r/pulls/42"] = json({ ...rawPull, mergeable: null });
    expect(await forgejo.getPRMergeableState("o/r", 42, 2, 0)).toBe("UNKNOWN");
  });

  it("builds the merge gate from live PR + commit-status reads", async () => {
    route("GET /repos/o/r/pulls/42", json(rawPull));
    route(
      "GET /repos/o/r/commits/deadbeef/status",
      json({ state: "success", statuses: [{ context: "ci", status: "success", target_url: "u" }] }),
    );
    expect(await forgejo.getPRMergeGate("o/r", 42)).toEqual({
      state: "OPEN",
      headSha: "deadbeef",
      labels: ["Ready"],
      mergeable: "MERGEABLE",
      checkStatus: "passing",
      checksTotal: 1,
    });
  });

  it("fetches the raw diff from the .diff suffix", async () => {
    route("GET /repos/o/r/pulls/42.diff", { status: 200, body: "diff --git a b" });
    expect(await forgejo.getPRDiff("o/r", 42)).toBe("diff --git a b");
  });

  it("lists changed file paths", async () => {
    route("GET /repos/o/r/pulls/42/files?limit=50&page=1", json([{ filename: "src/a.ts" }, { filename: "b.md" }]));
    expect(await forgejo.getPRChangedFiles("o/r", 42)).toEqual(["src/a.ts", "b.md"]);
  });

  it("finds the open PR for an issue via the linked-issue convention", async () => {
    route("GET /repos/o/r/pulls?state=open&limit=50&page=1", json([rawPull]));
    expect((await forgejo.getOpenPRForIssue("o/r", 12))!.number).toBe(42);
    expect(await forgejo.getOpenPRForIssue("o/r", 13)).toBeNull();
  });

  it("lists merged PRs for an issue, skipping closed-unmerged ones", async () => {
    route(
      "GET /repos/o/r/pulls?state=closed&limit=50&page=1",
      json([
        { ...rawPull, number: 40, merged: true },
        { ...rawPull, number: 41, merged: false },
        { ...rawPull, number: 44, merged: true, head: { ...rawPull.head, ref: "claws/issue-99-z" }, body: "" },
      ]),
    );
    expect((await forgejo.listMergedPRsForIssue("o/r", 12)).map((p) => p.number)).toEqual([40]);
  });

  it("buckets all PRs by head branch and returns [] for a branch with none", async () => {
    route(
      "GET /repos/o/r/pulls?state=all&limit=50&page=1",
      json([
        { ...rawPull, number: 40, state: "closed", merged: true, merged_at: "2026-08-03T00:00:00Z" },
        { ...rawPull, number: 41, head: { ...rawPull.head, ref: "other" } },
      ]),
    );
    const map = await forgejo.listPRsForBranches("o/r", ["claws/issue-12-abcd", "unused", "bad branch"]);
    expect(map.get("claws/issue-12-abcd")).toEqual([
      { number: 40, state: "MERGED", mergedAt: "2026-08-03T00:00:00Z" },
    ]);
    expect(map.get("unused")).toEqual([]);
    expect(map.has("bad branch")).toBe(false);
  });

  it("deletes a remote branch", async () => {
    route("DELETE /repos/o/r/branches/claws/issue-12-abcd", json({}));
    await forgejo.deleteRemoteBranch("o/r", "claws/issue-12-abcd");
    // Slashes stay raw: Gitea binds /branches/* as a wildcard route.
    expect(calls[0]!.path).toBe("/repos/o/r/branches/claws/issue-12-abcd");
  });

  it("lists compare commits with first-line subjects", async () => {
    route(
      "GET /repos/o/r/compare/main...feature",
      json({ commits: [{ sha: "aaa", commit: { message: "subject\n\nbody" } }] }),
    );
    expect(await forgejo.listCompareCommits("o/r", "main", "feature")).toEqual([
      { sha: "aaa", subject: "subject" },
    ]);
  });
});

// ── Checks ──

describe("checks", () => {
  const withStatuses = (statuses: unknown[]) => {
    route("GET /repos/o/r/pulls/42", json(rawPull));
    route("GET /repos/o/r/commits/deadbeef/status", json({ statuses }));
  };

  it("reports passing when every commit status succeeded", async () => {
    withStatuses([{ context: "build", status: "success" }, { context: "test", status: "success" }]);
    expect(await forgejo.getPRCheckStatus("o/r", 42)).toBe("passing");
    forgejo.clearForgejoCache();
    expect(await forgejo.getPRChecksSummary("o/r", 42)).toEqual({ status: "passing", passed: 2, total: 2 });
  });

  it("reports failing on error or failure and surfaces the failing check's link", async () => {
    withStatuses([
      { context: "build", status: "success" },
      { context: "test", status: "failure", target_url: "https://forge/run/1" },
    ]);
    expect(await forgejo.getPRCheckStatus("o/r", 42)).toBe("failing");
    forgejo.clearForgejoCache();
    expect(await forgejo.getFailingCheck("o/r", 42)).toEqual({
      name: "test",
      state: "FAILURE",
      link: "https://forge/run/1",
    });
  });

  it("reports pending while a status is still running, and none with no statuses", async () => {
    withStatuses([{ context: "build", status: "pending" }, { context: "test", status: "success" }]);
    expect(await forgejo.getPRCheckStatus("o/r", 42)).toBe("pending");
    forgejo.clearForgejoCache();
    withStatuses([]);
    expect(await forgejo.getPRCheckStatus("o/r", 42)).toBe("none");
  });

  it("reads the commit date from the git-commit endpoint", async () => {
    route("GET /repos/o/r/git/commits/deadbeef", json({ commit: { committer: { date: "2026-08-01T00:00:00Z" } } }));
    expect(await forgejo.getCommitCommittedAt("o/r", "deadbeef")).toBe("2026-08-01T00:00:00Z");
  });

  it("treats a settled non-pending status as conclusive immediately", async () => {
    route("GET /repos/o/r/git/commits/deadbeef", json({ commit: { committer: { date: new Date().toISOString() } } }));
    route("GET /repos/o/r/commits/deadbeef/status", json({ statuses: [{ context: "ci", status: "success" }] }));
    expect((await forgejo.haveChecksSettled("o/r", "deadbeef")).settled).toBe(true);
  });

  it("falls back to the age window when no status has registered yet", async () => {
    route("GET /repos/o/r/commits/deadbeef/status", json({ statuses: [] }));
    route("GET /repos/o/r/git/commits/deadbeef", json({ commit: { committer: { date: new Date().toISOString() } } }));
    expect((await forgejo.haveChecksSettled("o/r", "deadbeef")).settled).toBe(false);

    forgejo.clearForgejoCache();
    routes["GET /repos/o/r/git/commits/deadbeef"] = json({
      commit: { committer: { date: new Date(Date.now() - 10 * 60_000).toISOString() } },
    });
    expect((await forgejo.haveChecksSettled("o/r", "deadbeef")).settled).toBe(true);
  });

  it("fails closed when the commit date cannot be read", async () => {
    route("GET /repos/o/r/commits/deadbeef/status", json({ statuses: [] }));
    route("GET /repos/o/r/git/commits/deadbeef", { status: 500, body: "boom" });
    expect(await forgejo.haveChecksSettled("o/r", "deadbeef")).toEqual({ settled: false, age: "unknown" });
  });
});

// ── Reviews ──

describe("reviews", () => {
  const reviewsPath = "GET /repos/o/r/pulls/42/reviews?limit=50&page=1";

  it("collects review bodies and per-review inline comments as notes", async () => {
    route(reviewsPath, json([{ id: 5, user: { login: "stjohnb" }, body: "looks good overall", state: "COMMENT" }]));
    route(
      "GET /repos/o/r/pulls/42/reviews/5/comments",
      json([{ id: 9, user: { login: "stjohnb" }, path: "src/a.ts", position: 3, body: "rename this" }]),
    );
    expect(await forgejo.getPRReviewNotes("o/r", 42)).toEqual([
      { login: "stjohnb", body: "looks good overall" },
      { login: "stjohnb", body: "rename this", path: "src/a.ts", line: 3 },
    ]);
  });

  it("derives review status from the latest Claws review comment", async () => {
    route(
      "GET /repos/o/r/issues/42/comments?limit=50&page=1",
      json([
        {
          id: 1,
          user: { login: "claws" },
          body: "*— Automated by Claws —*\n\n## PR Review\nReviewed commit: `abc123`\n\nreview-result: clean",
        },
      ]),
    );
    expect(await forgejo.getPRReviewStatus("o/r", 42)).toEqual({
      status: "clean",
      issueCount: 0,
      reviewedCommit: "abc123",
    });
  });

  it("surfaces human comments and unresolved inline comments as outstanding work", async () => {
    route("GET /user", json({ login: "claws" }));
    route(reviewsPath, json([{ id: 5, user: { login: "stjohnb" }, body: "", state: "COMMENT" }]));
    route(
      "GET /repos/o/r/pulls/42/reviews/5/comments",
      json([
        { id: 9, user: { login: "stjohnb" }, path: "src/a.ts", position: 3, body: "rename this", diff_hunk: "@@" },
        { id: 10, user: { login: "stjohnb" }, path: "src/b.ts", position: 1, body: "done", resolver: { login: "stjohnb" } },
      ]),
    );
    route(
      "GET /repos/o/r/issues/42/comments?limit=50&page=1",
      json([{ id: 20, user: { login: "stjohnb" }, body: "please also update the docs" }]),
    );
    route("GET /repos/o/r/issues/comments/9/reactions", json([]));
    route("GET /repos/o/r/issues/comments/20/reactions", json([]));

    const data = await forgejo.getPRReviewComments("o/r", 42);
    expect(data.reviewCommentIds).toEqual([9]);
    expect(data.commentIds).toEqual([20]);
    expect(data.htmlBodies).toEqual([]);
    expect(data.formatted).toContain("HUMAN REVIEWER COMMENTS");
    expect(data.formatted).toContain("rename this");
    expect(data.formatted).toContain("please also update the docs");
    expect(data.formatted).not.toContain("done");
  });

  it("skips comments already carrying Claws' rocket reaction", async () => {
    route("GET /user", json({ login: "claws" }));
    route(reviewsPath, json([]));
    route(
      "GET /repos/o/r/issues/42/comments?limit=50&page=1",
      json([{ id: 20, user: { login: "stjohnb" }, body: "please also update the docs" }]),
    );
    route("GET /repos/o/r/issues/comments/20/reactions", json([{ content: "rocket", user: { login: "claws" } }]));
    const data = await forgejo.getPRReviewComments("o/r", 42);
    expect(data.formatted).toBe("");
    expect(data.commentIds).toEqual([]);
  });

  it("holds an advisory-only Claws review back unless the caller opts in", async () => {
    route("GET /user", json({ login: "claws" }));
    route(reviewsPath, json([]));
    route("GET /repos/o/r/pulls/42", json(rawPull));
    route(
      "GET /repos/o/r/issues/42/comments?limit=50&page=1",
      json([
        {
          id: 30,
          user: { login: "claws" },
          body: "*— Automated by Claws —*\n\n## PR Review\nReviewed commit: `deadbeef`\n\nreview-result: advisory\n\n1. tiny nit",
        },
      ]),
    );
    expect((await forgejo.getPRReviewComments("o/r", 42)).formatted).toBe("");
    forgejo.clearForgejoCache();
    const opted = await forgejo.getPRReviewComments("o/r", 42, { includeAdvisory: true });
    expect(opted.advisoryOnly).toBe(true);
    expect(opted.prReviewComment).toMatchObject({ id: 30, reviewedCommit: "deadbeef" });
  });

  it("returns the empty result rather than throwing when the forge errors", async () => {
    route("GET /user", { status: 500, body: "down" });
    const data = await forgejo.getPRReviewComments("o/r", 42);
    expect(data).toEqual({
      formatted: "",
      commentIds: [],
      reviewCommentIds: [],
      htmlBodies: [],
      prReviewComment: undefined,
      advisoryOnly: false,
    });
  });
});

describe("hasValidLGTM", () => {
  beforeEach(() => {
    route("GET /user", json({ login: "claws" }));
    route("GET /repos/o/r/pulls/42", json(rawPull));
    route("GET /repos/o/r/git/commits/deadbeef", json({ commit: { committer: { date: "2026-08-01T00:00:00Z" } } }));
  });

  it("accepts an APPROVED review from an allowed actor at the current head", async () => {
    route(
      "GET /repos/o/r/pulls/42/reviews?limit=50&page=1",
      json([{ id: 1, user: { login: "stjohnb" }, state: "APPROVED", commit_id: "deadbeef" }]),
    );
    expect(await forgejo.hasValidLGTM("o/r", 42, "main")).toBe(true);
  });

  it("rejects an APPROVED review pinned to a stale commit", async () => {
    route(
      "GET /repos/o/r/pulls/42/reviews?limit=50&page=1",
      json([{ id: 1, user: { login: "stjohnb" }, state: "APPROVED", commit_id: "oldsha" }]),
    );
    route("GET /repos/o/r/issues/42/comments?limit=50&page=1", json([]));
    expect(await forgejo.hasValidLGTM("o/r", 42, "main")).toBe(false);
  });

  it("accepts a bare LGTM posted after the head commit", async () => {
    route("GET /repos/o/r/pulls/42/reviews?limit=50&page=1", json([]));
    route(
      "GET /repos/o/r/issues/42/comments?limit=50&page=1",
      json([{ id: 1, user: { login: "stjohnb" }, body: "LGTM", created_at: "2026-08-02T00:00:00Z" }]),
    );
    expect(await forgejo.hasValidLGTM("o/r", 42, "main")).toBe(true);
  });

  it("rejects an LGTM predating the head commit, from a bot, or from a non-allowed actor", async () => {
    route("GET /repos/o/r/pulls/42/reviews?limit=50&page=1", json([]));
    route(
      "GET /repos/o/r/issues/42/comments?limit=50&page=1",
      json([
        { id: 1, user: { login: "stjohnb" }, body: "LGTM", created_at: "2026-07-01T00:00:00Z" },
        { id: 2, user: { login: "some-bot[bot]" }, body: "LGTM", created_at: "2026-08-02T00:00:00Z" },
        { id: 3, user: { login: "randomer" }, body: "LGTM", created_at: "2026-08-02T00:00:00Z" },
        { id: 4, user: { login: "claws" }, body: "*— Automated by Claws —*\n\nLGTM", created_at: "2026-08-02T00:00:00Z" },
      ]),
    );
    expect(await forgejo.hasValidLGTM("o/r", 42, "main")).toBe(false);
  });
});

// ── Contents ──

describe("repository contents", () => {
  it("decodes base64 file content and returns null on 404", async () => {
    route(
      "GET /repos/o/r/contents/README.md",
      json({ name: "README.md", path: "README.md", sha: "s1", type: "file", content: Buffer.from("hi").toString("base64") }),
    );
    route("GET /repos/o/r/contents/missing.md", { status: 404, body: "gone" });
    expect(await forgejo.fetchRepoFileContent("o/r", "README.md")).toBe("hi");
    expect(await forgejo.fetchRepoFileContent("o/r", "missing.md")).toBeNull();
  });

  it("returns content plus sha, honouring a ref", async () => {
    route(
      "GET /repos/o/r/contents/a.txt?ref=main",
      json({ sha: "s2", content: Buffer.from("body").toString("base64") }),
    );
    expect(await forgejo.fetchRepoFileWithSha("o/r", "a.txt", "main")).toEqual({ content: "body", sha: "s2" });
  });

  it("lists a directory and yields [] for a missing one", async () => {
    route("GET /repos/o/r/contents/docs", json([{ name: "a.md", path: "docs/a.md", sha: "s3", type: "file" }]));
    route("GET /repos/o/r/contents/nope", { status: 404, body: "gone" });
    expect(await forgejo.listRepoDirectory("o/r", "docs")).toEqual([
      { name: "a.md", path: "docs/a.md", sha: "s3", type: "file" },
    ]);
    expect(await forgejo.listRepoDirectory("o/r", "nope")).toEqual([]);
  });

  it("PUTs a file with sha only when updating", async () => {
    route("PUT /repos/o/r/contents/a.txt", json({}));
    await forgejo.putRepoFile("o/r", "main", "a.txt", "Ym9keQ==", "msg");
    expect(calls[0]!.body).toEqual({ message: "msg", content: "Ym9keQ==", branch: "main" });
    await forgejo.putRepoFile("o/r", "main", "a.txt", "Ym9keQ==", "msg", "s2");
    expect(calls[1]!.body).toMatchObject({ sha: "s2" });
  });

  it("reads default branch and privacy from the repo endpoint", async () => {
    route("GET /repos/o/r", json({ full_name: "o/r", default_branch: "trunk", private: true }));
    expect(await forgejo.getRepo("o/r")).toEqual({
      fullName: "o/r",
      owner: "o",
      name: "r",
      defaultBranch: "trunk",
      isPrivate: true,
    });
    expect(await forgejo.getDefaultBranch("o/r")).toBe("trunk");
    expect(await forgejo.isRepoPrivate("o/r")).toBe(true);
  });

  it("defaults isRepoPrivate to false when the lookup fails", async () => {
    route("GET /repos/o/r", { status: 404, body: "gone" });
    expect(await forgejo.isRepoPrivate("o/r")).toBe(false);
  });
});

// ── Identity ──

describe("forgejoSelfLogin", () => {
  it("caches the login for the process lifetime", async () => {
    route("GET /user", json({ login: "claws" }));
    expect(await forgejo.forgejoSelfLogin()).toBe("claws");
    expect(await forgejo.forgejoSelfLogin()).toBe("claws");
    expect(calls).toHaveLength(1);
  });
});

// ── Unsupported surfaces ──

describe("recently closed pull requests", () => {
  const closedPull = (over: Record<string, unknown>) => ({ ...rawPull, state: "closed", ...over });

  const routeClosed = (pulls: unknown[]) =>
    route(`GET /repos/o/r/pulls?state=closed&limit=50&page=1`, json(pulls));

  it("returns merged PRs newest-first with the gh camelCase shape", async () => {
    routeClosed([
      closedPull({ number: 1, merged: true, merged_at: "2026-08-01T00:00:00Z", closed_at: "2026-08-01T00:00:00Z" }),
      closedPull({ number: 2, merged: true, merged_at: "2026-08-05T00:00:00Z", closed_at: "2026-08-05T00:00:00Z" }),
    ]);

    const merged = await forgejo.listRecentlyMergedPRs("o/r", null);
    expect(merged.map((p) => p.number)).toEqual([2, 1]);
    expect(merged[0]).toEqual({
      number: 2,
      title: "Do the thing",
      body: "Closes #12",
      mergedAt: "2026-08-05T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
      author: "claws",
      headRefName: "claws/issue-12-abcd",
    });
  });

  // Gitea's `state=closed` includes merged PRs, so the two lists must not overlap.
  it("splits merged from closed-unmerged and honours since/limit", async () => {
    const pulls = [
      closedPull({ number: 1, merged: true, merged_at: "2026-08-01T00:00:00Z", closed_at: "2026-08-01T00:00:00Z" }),
      closedPull({ number: 2, merged: false, merged_at: null, closed_at: "2026-08-03T00:00:00Z" }),
      closedPull({ number: 3, merged: false, merged_at: null, closed_at: "2026-08-07T00:00:00Z" }),
    ];
    routeClosed(pulls);
    expect((await forgejo.listRecentlyMergedPRs("o/r", null)).map((p) => p.number)).toEqual([1]);

    forgejo.clearForgejoCache();
    routeClosed(pulls);
    const rejected = await forgejo.listRecentlyClosedUnmergedPRs("o/r", new Date("2026-08-05T00:00:00Z"));
    expect(rejected.map((p) => p.number)).toEqual([3]);

    forgejo.clearForgejoCache();
    routeClosed(pulls);
    expect((await forgejo.listRecentlyClosedUnmergedPRs("o/r", null, 1)).map((p) => p.number)).toEqual([3]);
  });
});

describe("getUpstreamPRStatus", () => {
  it("normalises a merged Gitea pull into the UpstreamPRStatus shape", async () => {
    route("GET /repos/o/r/pulls/42", json({
      state: "closed",
      merged: true,
      merged_at: "2026-08-05T00:00:00Z",
      title: "Upstream fix",
      html_url: "https://forge.example.com/o/r/pulls/42",
      updated_at: "2026-08-06T00:00:00Z",
    }));

    expect(await forgejo.getUpstreamPRStatus("o/r", 42)).toEqual({
      state: "closed",
      merged: true,
      mergedAt: "2026-08-05T00:00:00Z",
      title: "Upstream fix",
      url: "https://forge.example.com/o/r/pulls/42",
      updatedAt: "2026-08-06T00:00:00Z",
    });
  });

  it("returns null when the PR is gone", async () => {
    route("GET /repos/o/r/pulls/99", { status: 404, body: "not found" });
    expect(await forgejo.getUpstreamPRStatus("o/r", 99)).toBeNull();
  });
});

describe("listReleases", () => {
  it("maps Gitea releases into the ReleaseInfo shape", async () => {
    route("GET /repos/o/r/releases?limit=50&page=1", json([
      { tag_name: "v2.0.0", name: "Two", published_at: "2026-08-01T00:00:00Z", prerelease: false, draft: false, html_url: "https://forge.example.com/o/r/releases/tag/v2.0.0" },
      { tag_name: "v2.1.0-rc1", name: null, published_at: null, prerelease: true, draft: false, html_url: null },
    ]));

    const releases = await forgejo.listReleases("o/r");
    expect(releases[0]).toEqual({
      tag: "v2.0.0", name: "Two", publishedAt: "2026-08-01T00:00:00Z",
      prerelease: false, draft: false, url: "https://forge.example.com/o/r/releases/tag/v2.0.0",
    });
    expect(releases[1]).toMatchObject({ tag: "v2.1.0-rc1", name: "", publishedAt: null, prerelease: true });
  });

  it("returns [] rather than throwing when the endpoint is unavailable", async () => {
    expect(await forgejo.listReleases("o/r")).toEqual([]);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });
});

describe("createBranchRef", () => {
  it("posts the two branch names to Gitea's branch endpoint", async () => {
    route("POST /repos/o/r/branches", json({}));
    await forgejo.createBranchRef("o/r", "claws/new", "main");
    expect(calls[0]!.body).toEqual({ new_branch_name: "claws/new", old_branch_name: "main" });
  });

  it("swallows a 409 so a retry stays idempotent", async () => {
    route("POST /repos/o/r/branches", { status: 409, body: "branch already exists" });
    await expect(forgejo.createBranchRef("o/r", "claws/new", "main")).resolves.toBeUndefined();
  });
});

describe("listDefaultBranchActionRuns", () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    id: 9,
    workflow_id: "deploy.yml",
    status: "failure",
    event: "push",
    created: "2026-09-01T21:48:50+01:00",
    commit_sha: "abc",
    html_url: "https://git.example.com/o/r/actions/runs/9",
    prettyref: "main",
    ...overrides,
  });

  it("drops a run that has not finished yet", async () => {
    route("GET /repos/o/r/actions/runs?limit=30&event=push", json({ workflow_runs: [run({ status: "running" })] }));
    route("GET /repos/o/r/actions/runs?limit=30&event=schedule", json({ workflow_runs: [] }));

    expect(await forgejo.listDefaultBranchActionRuns("o/r", "main")).toEqual([]);
  });

  it("drops a run whose prettyref is a PR, not the default branch, even under a push event", async () => {
    route("GET /repos/o/r/actions/runs?limit=30&event=push", json({ workflow_runs: [run({ prettyref: "#287" })] }));
    route("GET /repos/o/r/actions/runs?limit=30&event=schedule", json({ workflow_runs: [] }));

    expect(await forgejo.listDefaultBranchActionRuns("o/r", "main")).toEqual([]);
  });

  it("maps a completed default-branch failure into a row keyed by the workflow file name", async () => {
    route("GET /repos/o/r/actions/runs?limit=30&event=push", json({ workflow_runs: [run()] }));
    route("GET /repos/o/r/actions/runs?limit=30&event=schedule", json({ workflow_runs: [] }));

    const rows = await forgejo.listDefaultBranchActionRuns("o/r", "main");
    expect(rows).toEqual([
      {
        run_id: 9,
        workflow_name: "deploy.yml",
        conclusion: "failure",
        event: "push",
        created_at: "2026-09-01T21:48:50+01:00",
        head_sha: "abc",
        html_url: "https://git.example.com/o/r/actions/runs/9",
        run_attempt: null,
      },
    ]);
    expect(calls.map((c) => c.path)).toEqual([
      "/repos/o/r/actions/runs?limit=30&event=push",
      "/repos/o/r/actions/runs?limit=30&event=schedule",
    ]);
  });

  it("returns [] rather than throwing when workflow_runs is absent", async () => {
    route("GET /repos/o/r/actions/runs?limit=30&event=push", json({ total_count: 0 }));
    route("GET /repos/o/r/actions/runs?limit=30&event=schedule", json({ total_count: 0 }));

    expect(await forgejo.listDefaultBranchActionRuns("o/r", "main")).toEqual([]);
  });
});

describe("unsupported surfaces degrade instead of throwing", () => {
  it("returns empty job summaries, annotations and logs", async () => {
    expect(await forgejo.getRunJobSummaries("o/r", "1")).toEqual([]);
    expect(await forgejo.getRunAnnotations("o/r", "1")).toEqual([]);
    expect(await forgejo.getFailedRunLog("o/r", 42)).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("makes rerun requests no-ops", async () => {
    await expect(forgejo.rerunWorkflow("o/r", "1")).resolves.toBeUndefined();
    await expect(forgejo.rerunFailedJobs("o/r", "1")).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(2);
  });

  // Unlike rerun, a silent no-op here would report success to the dashboard's
  // Cancel button while the run kept going.
  it("throws on cancelWorkflow rather than silently succeeding", async () => {
    await expect(forgejo.cancelWorkflow("o/r", "1")).rejects.toThrow(/no run-cancel API/);
    expect(calls).toHaveLength(0);
  });

  // Returning the GitHub mirror's timeline would mark a phase covered that no
  // Forgejo PR implements; `[]` degrades to branch-prefix accounting instead.
  it("reports no cross-referencing PRs without calling the API", async () => {
    expect(await forgejo.listPRsCrossReferencingIssue("o/r", 12)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ── Duplicate issues ──

describe("listDuplicateIssuesOf", () => {
  const dupe = (number: number) => ({
    number,
    title: `dupe ${number}`,
    body: "",
    labels: [{ id: 9, name: "Duplicate" }],
    user: { login: "stjohnb" },
    state: "open",
  });

  it("keeps only label-matched issues whose comments carry the canonical marker", async () => {
    route("GET /repos/o/r/issues?state=open&type=issues&labels=Duplicate&limit=50&page=1", json([dupe(5), dupe(6)]));
    route("GET /repos/o/r/issues/5/comments?limit=50&page=1", json([{ id: 1, body: "claws-duplicate-of:2", user: { login: "claws" } }]));
    route("GET /repos/o/r/issues/6/comments?limit=50&page=1", json([{ id: 2, body: "claws-duplicate-of:99", user: { login: "claws" } }]));

    expect((await forgejo.listDuplicateIssuesOf("o/r", 2)).map((i) => i.number)).toEqual([5]);
  });

  it("skips an issue whose comments cannot be read rather than failing the whole lookup", async () => {
    route("GET /repos/o/r/issues?state=open&type=issues&labels=Duplicate&limit=50&page=1", json([dupe(5), dupe(6)]));
    route("GET /repos/o/r/issues/5/comments?limit=50&page=1", { status: 500, body: "boom" });
    route("GET /repos/o/r/issues/6/comments?limit=50&page=1", json([{ id: 2, body: "claws-duplicate-of:2", user: { login: "claws" } }]));

    expect((await forgejo.listDuplicateIssuesOf("o/r", 2)).map((i) => i.number)).toEqual([6]);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("listDuplicateIssuesOf o/r#5"));
  });
});
