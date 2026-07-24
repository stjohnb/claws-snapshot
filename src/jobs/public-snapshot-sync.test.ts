import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  snapshots: [] as Array<{
    source: string; target: string; mirrorReleases?: boolean; scrubPaths?: string[]; releaseAssetUrl?: string;
  }>,
}));

vi.mock("../config.js", () => ({
  get PUBLIC_SNAPSHOTS() {
    return state.snapshots;
  },
  SELF_REPO: "St-John-Software/claws",
  WORK_DIR: "/work",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockFs, mockGh, mockClaude, mockDb, mockOccurrence, mockGithubApp, mockChild } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    renameSync: vi.fn(),
  },
  mockGh: {
    listRepos: vi.fn(),
    ensureSnapshotTarget: vi.fn(),
    disableDependabot: vi.fn(),
    getLatestStableReleaseTag: vi.fn(),
    listStableReleaseTags: vi.fn(),
    getReleaseAssetNames: vi.fn(),
    downloadReleaseAssets: vi.fn(),
    createRelease: vi.fn(),
    uploadReleaseAssets: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    git: vi.fn(),
    runClaude: vi.fn(),
  },
  mockDb: {
    recordTaskStart: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    trackTaskTokens: vi.fn(),
  },
  mockOccurrence: {
    ensureAlertIssue: vi.fn(),
  },
  mockGithubApp: {
    buildEnvForGh: vi.fn(),
    getInstallationTokenForOwner: vi.fn(),
  },
  mockChild: {
    execFile: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("node:child_process", () => mockChild);
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../occurrence-tracking.js", () => mockOccurrence);
vi.mock("../github-app.js", () => mockGithubApp);

import { run } from "./public-snapshot-sync.js";

const SOURCE = "St-John-Software/claws";
const TARGET = "stjohnb/claws-snapshot";
const SRC_SHA = "srcsha123";

// Test-adjustable behaviour, reset in beforeEach.
let metaExists = false;
let metaSha = SRC_SHA;
let diffClean = false; // false → staged changes present (git diff --cached --quiet rejects)
let logOutput = "feat: shiny thing\nfix: a bug";
let fileContent = "clean file content, nothing secret here";
let fileSize = 1024;
let targetCloned = true; // false → target .git absent, triggers first-time clone
let originBranchExists = true; // false → `checkout -B origin/<branch>` fails (zero-commit target)
let tagShas: Record<string, string> = {}; // tag name → commit SHA for `git rev-list -n 1 <tag>`
let tagCommitDates: Record<string, string> = {}; // tag SHA → committer date for `git log -1 --format=%ct`
let tagUnreachable = false; // true → `merge-base --is-ancestor` rejects (tag not reachable from srcSha)
let hasPublicReadme = false; // true → source ships README.public.md, swapped over README.md

function gitCalls(): string[][] {
  return mockClaude.git.mock.calls.map((c) => c[0] as string[]);
}

describe("public-snapshot-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.snapshots = [{ source: SOURCE, target: TARGET }];
    metaExists = false;
    metaSha = SRC_SHA;
    diffClean = false;
    logOutput = "feat: shiny thing\nfix: a bug";
    fileContent = "clean file content, nothing secret here";
    fileSize = 1024;
    targetCloned = true;
    originBranchExists = true;
    tagShas = {};
    tagCommitDates = {};
    tagUnreachable = false;
    hasPublicReadme = false;

    mockGh.listRepos.mockResolvedValue([
      { owner: "St-John-Software", name: "claws", fullName: SOURCE, defaultBranch: "main" },
    ]);
    mockGh.ensureSnapshotTarget.mockResolvedValue({ exists: true, archived: false, defaultBranch: "main" });
    mockGh.disableDependabot.mockResolvedValue(undefined);
    // Release-mirror defaults: no stable release, so mirrorLatestRelease is a
    // no-op for any pair that opts in. Existing pairs have no `mirrorReleases`
    // flag, so the helper is never invoked for them at all.
    mockGh.getLatestStableReleaseTag.mockResolvedValue(null);
    mockGh.listStableReleaseTags.mockResolvedValue([]);
    mockGh.getReleaseAssetNames.mockResolvedValue([]);
    mockGh.downloadReleaseAssets.mockResolvedValue(undefined);
    mockGh.createRelease.mockResolvedValue(undefined);
    mockGh.uploadReleaseAssets.mockResolvedValue(undefined);

    mockClaude.ensureClone.mockResolvedValue("/work/repos/src");
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return Promise.resolve(`${SRC_SHA}\n`);
      // `git rev-list -n 1 <tag>` → the tag's commit SHA (per-tag overridable).
      if (args[0] === "rev-list" && args[1] === "-n") {
        return Promise.resolve(`${tagShas[args[3]!] ?? `tagsha_${args[3]}`}\n`);
      }
      // `git merge-base --is-ancestor <sha> <srcSha>` → resolve iff reachable.
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return tagUnreachable ? Promise.reject(new Error("not an ancestor")) : Promise.resolve("");
      }
      // `git log -1 --format=%ct <sha>` → committer date (drives release ordering).
      if (args[0] === "log" && args.includes("--format=%ct")) {
        return Promise.resolve(`${tagCommitDates[args[3]!] ?? 1000}\n`);
      }
      if (args[0] === "log") return Promise.resolve(logOutput);
      if (args[0] === "diff") return diffClean ? Promise.resolve("") : Promise.reject(new Error("staged"));
      // `checkout -B <branch> origin/<branch> --force` fails on a zero-commit target.
      if (args[0] === "checkout" && args[1] === "-B" && !originBranchExists) {
        return Promise.reject(new Error("no origin branch"));
      }
      return Promise.resolve("");
    });
    mockClaude.runClaude.mockResolvedValue("- feature one\n- feature two");

    mockDb.recordTaskStart.mockReturnValue(1);
    mockDb.trackTaskTokens.mockReturnValue(vi.fn());

    mockOccurrence.ensureAlertIssue.mockResolvedValue({});

    mockGithubApp.buildEnvForGh.mockReturnValue({});
    mockGithubApp.getInstallationTokenForOwner.mockResolvedValue("token");

    mockFs.existsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s.endsWith(".git")) return targetCloned; // target already cloned
      if (s.endsWith(".claws-snapshot.json")) return metaExists;
      if (s.endsWith("/ideas")) return true; // ideas folder present → scrubbed
      if (s.endsWith("README.public.md")) return hasPublicReadme;
      return false; // other scrub paths absent
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (String(p).endsWith(".claws-snapshot.json")) return JSON.stringify({ sourceSha: metaSha });
      return fileContent;
    });
    mockFs.statSync.mockImplementation(() => ({ size: fileSize }));
    mockFs.readdirSync.mockReturnValue([
      { name: "README.md", isDirectory: () => false, isFile: () => true },
    ]);

    mockChild.execFile.mockImplementation((_cmd: string, _args: string[], opts: unknown, cb: unknown) => {
      const callback = (typeof opts === "function" ? opts : cb) as (e: Error | null, o: string, s: string) => void;
      callback(null, "", "");
    });
  });

  it("no-ops when PUBLIC_SNAPSHOTS is empty", async () => {
    state.snapshots = [];
    await run();
    expect(mockGh.listRepos).not.toHaveBeenCalled();
    expect(mockDb.recordTaskStart).not.toHaveBeenCalled();
  });

  it("alerts and skips when the target does not exist (no push)", async () => {
    mockGh.ensureSnapshotTarget.mockResolvedValue({ exists: false, archived: false, defaultBranch: "main" });

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    expect(mockOccurrence.ensureAlertIssue.mock.calls[0]![0].title).toContain("does not exist");
    expect(mockDb.recordTaskStart).not.toHaveBeenCalled();
    expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
  });

  it("alerts and skips an archived target without any un-archive PATCH", async () => {
    mockGh.ensureSnapshotTarget.mockResolvedValue({ exists: true, archived: true, defaultBranch: "main" });

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    expect(mockOccurrence.ensureAlertIssue.mock.calls[0]![0].title).toContain("is archived");
    // No task, no push, no dependabot mutation — and there is no un-archive path at all.
    expect(mockDb.recordTaskStart).not.toHaveBeenCalled();
    expect(mockGh.disableDependabot).not.toHaveBeenCalled();
    expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
  });

  it("skips (no commit/push) when the source sha is unchanged", async () => {
    metaExists = true;
    metaSha = SRC_SHA; // matches rev-parse

    await run();

    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0 });
    expect(gitCalls().some((a) => a[0] === "commit")).toBe(false);
    expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("aborts on secret detection without pushing or leaking the value", async () => {
    const secret = "ghp_" + "A".repeat(38);
    fileContent = `token=${secret}\n`;

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const alert = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(alert.title).toContain("Secret detected");
    expect(alert.body).not.toContain(secret);
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "secret detected", { commits: 0 });
    expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
  });

  it("aborts on a fine-grained PAT (github_pat_...) in a file", async () => {
    const secret = "github_pat_" + "A".repeat(30);
    fileContent = `token=${secret}\n`;

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const alert = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(alert.title).toContain("Secret detected");
    expect(alert.body).not.toContain(secret);
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "secret detected", { commits: 0 });
    expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
  });

  it("scrubs the ideas folder before publishing", async () => {
    await run();

    const rmCalls = mockChild.execFile.mock.calls.filter((c) => c[0] === "rm");
    const scrubbedIdeas = rmCalls.some((c) => {
      const args = c[1] as string[];
      return args.some((a) => a.endsWith("/ideas"));
    });
    expect(scrubbedIdeas).toBe(true);
  });

  it("scrubs BLOG_IDEAS.md and HOMELAB_IDEAS.md before publishing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s.endsWith(".git")) return targetCloned;
      if (s.endsWith(".claws-snapshot.json")) return metaExists;
      if (s.endsWith("BLOG_IDEAS.md")) return true;
      if (s.endsWith("HOMELAB_IDEAS.md")) return true;
      if (s.endsWith("/ideas")) return true;
      if (s.endsWith("README.public.md")) return hasPublicReadme;
      return false;
    });

    await run();

    const rmCalls = mockChild.execFile.mock.calls.filter((c) => c[0] === "rm");
    const hasBlogIdeas = rmCalls.some((c) => {
      const args = c[1] as string[];
      return args.some((a) => a.endsWith("BLOG_IDEAS.md"));
    });
    const hasHomelabIdeas = rmCalls.some((c) => {
      const args = c[1] as string[];
      return args.some((a) => a.endsWith("HOMELAB_IDEAS.md"));
    });
    expect(hasBlogIdeas).toBe(true);
    expect(hasHomelabIdeas).toBe(true);
  });

  describe("per-pair scrubPaths (#1962)", () => {
    const SCRUB_FILE = "apps/authentik/configmap-blueprints.yaml";

    it("removes a pair-specific scrubPaths file from the rebuilt tree", async () => {
      state.snapshots = [{ source: SOURCE, target: TARGET, scrubPaths: [SCRUB_FILE] }];
      mockFs.existsSync.mockImplementation((p: string) => {
        const s = String(p);
        if (s.endsWith(".git")) return targetCloned;
        if (s.endsWith(".claws-snapshot.json")) return metaExists;
        if (s.endsWith(SCRUB_FILE)) return true;
        return false;
      });

      await run();

      const rmCalls = mockChild.execFile.mock.calls.filter((c) => c[0] === "rm");
      expect(
        rmCalls.some((c) => (c[1] as string[]).some((a) => a.endsWith(SCRUB_FILE))),
      ).toBe(true);
    });

    it("does not remove that path for a pair without scrubPaths configured", async () => {
      // Default state.snapshots pair has no scrubPaths — the file existing at the
      // same relative path should never be targeted for removal.
      mockFs.existsSync.mockImplementation((p: string) => {
        const s = String(p);
        if (s.endsWith(".git")) return targetCloned;
        if (s.endsWith(".claws-snapshot.json")) return metaExists;
        if (s.endsWith(SCRUB_FILE)) return true;
        return false;
      });

      await run();

      const rmCalls = mockChild.execFile.mock.calls.filter((c) => c[0] === "rm");
      expect(
        rmCalls.some((c) => (c[1] as string[]).some((a) => a.endsWith(SCRUB_FILE))),
      ).toBe(false);
    });

    it("skips a traversal scrubPaths entry instead of rm -rf outside the target tree", async () => {
      state.snapshots = [{ source: SOURCE, target: TARGET, scrubPaths: ["../escape"] }];

      await run();

      const rmCalls = mockChild.execFile.mock.calls.filter((c) => c[0] === "rm");
      expect(
        rmCalls.some((c) => (c[1] as string[]).some((a) => a.includes("escape"))),
      ).toBe(false);
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
    });

    it("squashes to a single force-pushed root commit for a scrubPaths pair", async () => {
      state.snapshots = [{ source: SOURCE, target: TARGET, scrubPaths: [SCRUB_FILE] }];

      await run();

      const calls = gitCalls();
      expect(calls.some((a) => a[0] === "checkout" && a[1] === "--orphan" && a[2] === "claws-snapshot-rewrite")).toBe(true);
      const push = calls.find((a) => a[0] === "push");
      expect(push).toEqual(["push", "--force", "origin", "HEAD:main"]);
    });

    it("issues neither --orphan nor --force for a plain pair", async () => {
      await run();

      const calls = gitCalls();
      expect(calls.some((a) => a[0] === "checkout" && a[1] === "--orphan")).toBe(false);
      const push = calls.find((a) => a[0] === "push");
      expect(push).toEqual(["push", "origin", "HEAD:main"]);
    });
  });

  it("commits, pushes and disables Dependabot on a clean sync", async () => {
    await run();

    const calls = gitCalls();
    expect(calls.some((a) => a[0] === "commit")).toBe(true);
    const push = calls.find((a) => a[0] === "push");
    expect(push).toEqual(["push", "origin", "HEAD:main"]);
    expect(mockGh.disableDependabot).toHaveBeenCalledWith(TARGET);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
  });

  it("skips commit/push when nothing is staged after rsync", async () => {
    diffClean = true; // git diff --cached --quiet exits 0 → nothing staged

    await run();

    const calls = gitCalls();
    expect(calls.some((a) => a[0] === "commit")).toBe(false);
    expect(calls.some((a) => a[0] === "push")).toBe(false);
    expect(mockGh.disableDependabot).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0 });
  });

  it("clones the target via gh on first run when no local .git exists", async () => {
    targetCloned = false;

    await run();

    const cloneCall = mockChild.execFile.mock.calls.find(
      (c) => c[0] === "gh" && (c[1] as string[])[0] === "repo" && (c[1] as string[])[1] === "clone",
    );
    expect(cloneCall).toBeTruthy();
    expect((cloneCall![1] as string[]).slice(0, 3)).toEqual(["repo", "clone", TARGET]);
    // Clone uses buildEnvForGh directly (installation-token auth), not claude.git.
    expect(mockGithubApp.buildEnvForGh).toHaveBeenCalled();
    expect(mockGithubApp.getInstallationTokenForOwner).toHaveBeenCalledWith("stjohnb");
    // fetch is skipped on the first-clone path.
    expect(gitCalls().some((a) => a[0] === "fetch")).toBe(false);
  });

  it("falls back to `checkout -b` when the target has zero commits", async () => {
    originBranchExists = false; // `checkout -B origin/main --force` rejects

    await run();

    const calls = gitCalls();
    expect(calls.some((a) => a[0] === "checkout" && a[1] === "-B")).toBe(true);
    expect(calls.some((a) => a[0] === "checkout" && a[1] === "-b" && a[2] === "main")).toBe(true);
    // Sync still completes and pushes the first snapshot commit.
    expect(calls.some((a) => a[0] === "push")).toBe(true);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
  });

  it("aborts on a secret in the LLM-generated commit summary", async () => {
    const secret = "ghp_" + "B".repeat(38);
    mockClaude.runClaude.mockResolvedValue(`- shipped ${secret}`);

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const alert = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(alert.title).toContain("Secret detected");
    expect(alert.body).toContain("commit-summary");
    expect(alert.body).not.toContain(secret);
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "secret detected", { commits: 0 });
    expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
  });

  it("aborts on a secret in a raw source commit subject", async () => {
    const secret = "AKIA" + "A".repeat(16);
    logOutput = `feat: leak ${secret}`;

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const alert = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(alert.title).toContain("Secret detected");
    expect(alert.body).toContain("commit-subjects");
    expect(alert.body).not.toContain(secret);
    expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
  });

  it("publishes via `git archive` at srcSha, never rsyncing the working tree", async () => {
    await run();

    const archive = gitCalls().find((a) => a[0] === "archive");
    expect(archive).toBeTruthy();
    expect(archive).toContain(SRC_SHA);
    // rsync of the source working tree must be gone (it leaked node_modules).
    expect(mockChild.execFile.mock.calls.some((c) => c[0] === "rsync")).toBe(false);
    expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
  });

  it("does not abort on the allowlisted home-assistant.md private-key placeholder", async () => {
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (String(dir).endsWith("/docs")) {
        return [{ name: "home-assistant.md", isDirectory: () => false, isFile: () => true }];
      }
      return [{ name: "docs", isDirectory: () => true, isFile: () => false }];
    });
    fileContent = "deployment_key: |\n  -----BEGIN OPENSSH PRIVATE KEY-----\n  <contents>\n  -----END OPENSSH PRIVATE KEY-----\n";

    await run();

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
  });

  it("does not abort on this module's own allowlisted private-key placeholder", async () => {
    mockFs.readdirSync.mockImplementation((dir: string) => {
      const d = String(dir);
      if (d.endsWith("/src/jobs")) {
        return [{ name: "public-snapshot-sync.ts", isDirectory: () => false, isFile: () => true }];
      }
      if (d.endsWith("/src")) {
        return [{ name: "jobs", isDirectory: () => true, isFile: () => false }];
      }
      return [{ name: "src", isDirectory: () => true, isFile: () => false }];
    });
    fileContent = "// -----BEGIN OPENSSH PRIVATE KEY-----\n";

    await run();

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
  });

  it("does not abort on the allowlisted docs/OVERVIEW.md private-key placeholder", async () => {
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (String(dir).endsWith("/docs")) {
        return [{ name: "OVERVIEW.md", isDirectory: () => false, isFile: () => true }];
      }
      return [{ name: "docs", isDirectory: () => true, isFile: () => false }];
    });
    fileContent = "// -----BEGIN OPENSSH PRIVATE KEY-----\n";

    await run();

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
  });

  it("does not abort on the allowlisted docs/jobs/public-snapshot-sync.md private-key placeholder", async () => {
    mockFs.readdirSync.mockImplementation((dir: string) => {
      const d = String(dir);
      if (d.endsWith("/docs/jobs")) {
        return [{ name: "public-snapshot-sync.md", isDirectory: () => false, isFile: () => true }];
      }
      if (d.endsWith("/docs")) {
        return [{ name: "jobs", isDirectory: () => true, isFile: () => false }];
      }
      return [{ name: "docs", isDirectory: () => true, isFile: () => false }];
    });
    fileContent = "// -----BEGIN OPENSSH PRIVATE KEY-----\n";

    await run();

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
  });

  it("still flags a private key outside docs/home-assistant.md (allowlist is path-scoped)", async () => {
    // Default readdirSync mock yields a flat README.md — a different path from
    // the allowlisted docs/home-assistant.md, so this must still trigger.
    fileContent = "deployment_key: |\n  -----BEGIN OPENSSH PRIVATE KEY-----\n  <contents>\n  -----END OPENSSH PRIVATE KEY-----\n";

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const alert = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(alert.title).toContain("Secret detected");
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "secret detected", { commits: 0 });
    expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
  });

  it("publishes workflows disabled — replaces the `on:` trigger block with workflow_dispatch", async () => {
    const workflowSource =
      "name: CI\n" +
      "on:\n" +
      "  push:\n" +
      "    branches: [main]\n" +
      "  pull_request:\n" +
      "jobs:\n" +
      "  build:\n" +
      "    runs-on: [self-hosted, linux]\n";

    mockFs.existsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s.endsWith(".git")) return targetCloned;
      if (s.endsWith(".claws-snapshot.json")) return metaExists;
      if (s.endsWith("/ideas")) return true;
      if (s.endsWith(".github/workflows")) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((dir: string) => {
      if (String(dir).endsWith(".github/workflows")) {
        return [{ name: "ci.yml", isDirectory: () => false, isFile: () => true }];
      }
      return [{ name: "README.md", isDirectory: () => false, isFile: () => true }];
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (String(p).endsWith(".claws-snapshot.json")) return JSON.stringify({ sourceSha: metaSha });
      if (String(p).endsWith("ci.yml")) return workflowSource;
      return fileContent;
    });

    await run();

    const writeCall = mockFs.writeFileSync.mock.calls.find((c) => String(c[0]).endsWith("ci.yml"));
    expect(writeCall).toBeTruthy();
    const written = writeCall![1] as string;
    expect(written).toContain("workflow_dispatch:");
    expect(written).not.toContain("pull_request");
    expect(written).not.toContain("branches: [main]");
    expect(written).toContain("jobs:");
    expect(written).toContain("runs-on: [self-hosted, linux]");
    expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
  });

  it("skips oversized files during the secret scan (no false abort)", async () => {
    fileSize = 5 * 1024 * 1024; // exceeds MAX_SCAN_BYTES
    fileContent = "ghp_" + "C".repeat(38); // would match, but the file is never read

    await run();

    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining("README.md"),
      "utf-8",
    );
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
  });

  describe("README tailoring (#1848)", () => {
    function withReadmePresent(): void {
      mockFs.existsSync.mockImplementation((p: string) => {
        const s = String(p);
        if (s.endsWith(".git")) return targetCloned;
        if (s.endsWith(".claws-snapshot.json")) return metaExists;
        if (s.endsWith("/ideas")) return true;
        if (s.endsWith("README.md")) return true;
        return false;
      });
    }

    it("rewrites the README for a public audience when present", async () => {
      withReadmePresent();
      mockClaude.runClaude.mockImplementation((prompt: string) =>
        Promise.resolve(
          prompt.includes("PUBLIC snapshot repository") ? "# claws\n\nPublic snapshot.\n" : "- feature one",
        ),
      );

      await run();

      expect(
        mockFs.writeFileSync.mock.calls.some(
          (c) => String(c[0]).endsWith("README.md") && String(c[1]).includes("Public snapshot"),
        ),
      ).toBe(true);
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
    });

    it("falls back to the verbatim source README when tailoring fails", async () => {
      withReadmePresent();
      mockClaude.runClaude.mockImplementation((prompt: string) =>
        prompt.includes("PUBLIC snapshot repository")
          ? Promise.reject(new Error("rate limited"))
          : Promise.resolve("- feature one"),
      );

      await run();

      expect(
        mockFs.writeFileSync.mock.calls.some((c) => String(c[0]).endsWith("README.md")),
      ).toBe(false);
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
    });

    it("falls back to the verbatim source README when tailoring returns empty output", async () => {
      withReadmePresent();
      mockClaude.runClaude.mockImplementation((prompt: string) =>
        Promise.resolve(prompt.includes("PUBLIC snapshot repository") ? "   \n" : "- feature one"),
      );

      await run();

      expect(
        mockFs.writeFileSync.mock.calls.some((c) => String(c[0]).endsWith("README.md")),
      ).toBe(false);
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
    });

    it("strips a whole-document code fence from the tailored README", async () => {
      withReadmePresent();
      mockClaude.runClaude.mockImplementation((prompt: string) =>
        Promise.resolve(
          prompt.includes("PUBLIC snapshot repository")
            ? "```markdown\n# claws\n\nPublic snapshot.\n```"
            : "- feature one",
        ),
      );

      await run();

      const readmeWrite = mockFs.writeFileSync.mock.calls.find((c) => String(c[0]).endsWith("README.md"));
      expect(readmeWrite).toBeDefined();
      expect(String(readmeWrite![1])).toBe("# claws\n\nPublic snapshot.\n");
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
    });

    it("swallows a write failure for the tailored README and still completes the sync", async () => {
      withReadmePresent();
      mockClaude.runClaude.mockImplementation((prompt: string) =>
        Promise.resolve(
          prompt.includes("PUBLIC snapshot repository") ? "# claws\n\nPublic snapshot.\n" : "- feature one",
        ),
      );
      mockFs.writeFileSync.mockImplementation((p: string) => {
        if (String(p).endsWith("README.md")) throw new Error("ENOSPC");
      });

      await run();

      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
    });

    it("swallows a read failure for the source README and still completes the sync", async () => {
      withReadmePresent();
      mockFs.readFileSync.mockImplementation((p: string) => {
        const s = String(p);
        if (s.endsWith(".claws-snapshot.json")) return JSON.stringify({ sourceSha: metaSha });
        if (s.endsWith("README.md")) throw new Error("EIO");
        return fileContent;
      });

      await run();

      expect(mockClaude.runClaude).not.toHaveBeenCalledWith(
        expect.stringContaining("PUBLIC snapshot repository"),
        expect.anything(),
        expect.anything(),
      );
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
    });

    it("aborts when the tailored README contains a secret", async () => {
      withReadmePresent();
      const secret = "ghp_" + "A".repeat(38);
      mockClaude.runClaude.mockImplementation((prompt: string) =>
        Promise.resolve(prompt.includes("PUBLIC snapshot repository") ? `token=${secret}` : "- feature one"),
      );
      mockFs.readFileSync.mockImplementation((p: string) => {
        const s = String(p);
        if (s.endsWith(".claws-snapshot.json")) return JSON.stringify({ sourceSha: metaSha });
        if (s.endsWith("README.md")) return `token=${secret}`;
        return fileContent;
      });

      await run();

      expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
      const alert = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
      expect(alert.title).toContain("Secret detected");
      expect(alert.body).not.toContain(secret);
      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "secret detected", { commits: 0 });
      expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
    });

    it("tracks tokens for both runClaude calls through a single shared trackTaskTokens closure", async () => {
      withReadmePresent();
      mockClaude.runClaude.mockImplementation((prompt: string) =>
        Promise.resolve(
          prompt.includes("PUBLIC snapshot repository") ? "# claws\n\nPublic snapshot.\n" : "- feature one",
        ),
      );

      await run();

      // trackTaskTokens must be invoked exactly once per task — a second call
      // would create a fresh closure whose absolute UPDATE overwrites the first
      // call's accumulated tokens/cost instead of adding to them.
      expect(mockDb.trackTaskTokens).toHaveBeenCalledTimes(1);
      expect(mockDb.trackTaskTokens).toHaveBeenCalledWith(1);
      const sharedCallback = mockDb.trackTaskTokens.mock.results[0]!.value;
      const onTokensUsedArgs = mockClaude.runClaude.mock.calls.map((c) => (c[2] as { onTokensUsed: unknown }).onTokensUsed);
      expect(onTokensUsedArgs).toEqual([sharedCallback, sharedCallback]);
    });
  });

  describe("author-controlled public README (#1948)", () => {
    it("swaps README.public.md over README.md and skips LLM tailoring", async () => {
      hasPublicReadme = true;

      await run();

      expect(
        mockFs.renameSync.mock.calls.some(
          (c) => String(c[0]).endsWith("README.public.md") && String(c[1]).endsWith("README.md"),
        ),
      ).toBe(true);
      expect(
        mockClaude.runClaude.mock.calls.some((c) =>
          String(c[0]).includes("rewriting the README of a PUBLIC snapshot"),
        ),
      ).toBe(false);
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
    });

    it("tailors the README via LLM when README.public.md is absent", async () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        const s = String(p);
        if (s.endsWith(".git")) return targetCloned;
        if (s.endsWith(".claws-snapshot.json")) return metaExists;
        if (s.endsWith("/ideas")) return true;
        if (s.endsWith("README.md")) return true;
        return false;
      });

      await run();

      expect(mockFs.renameSync).not.toHaveBeenCalled();
      expect(
        mockClaude.runClaude.mock.calls.some((c) =>
          String(c[0]).includes("rewriting the README of a PUBLIC snapshot"),
        ),
      ).toBe(true);
    });

    it("swaps README.public.md on a release-tag commit too", async () => {
      state.snapshots = [{ source: SOURCE, target: TARGET, mirrorReleases: true }];
      hasPublicReadme = true;
      mockGh.listStableReleaseTags.mockResolvedValue(["v1.3.1"]);
      tagShas = { "v1.3.1": "relsha131" };
      mockGh.getReleaseAssetNames.mockResolvedValue(null);
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (String(dir).includes("release-assets")) return ["claws-1.3.1.dmg"];
        return [{ name: "README.md", isDirectory: () => false, isFile: () => true }];
      });

      await run();

      expect(
        mockFs.renameSync.mock.calls.some(
          (c) => String(c[0]).endsWith("README.public.md") && String(c[1]).endsWith("README.md"),
        ),
      ).toBe(true);
      expect(
        mockClaude.runClaude.mock.calls.some((c) =>
          String(c[0]).includes("rewriting the README of a PUBLIC snapshot"),
        ),
      ).toBe(false);
    });
  });

  describe("release mirroring (#1851)", () => {
    const REL_SOURCE = "St-John-Software/TempoStatusBar";
    const REL_TARGET = "stjohnb/TempoStatusBar";

    /** Earliest invocation order of a `git push` call (Infinity if never pushed). */
    function pushInvocationOrder(): number {
      const orders = mockClaude.git.mock.calls
        .map((c, i) => ({ args: c[0] as string[], order: mockClaude.git.mock.invocationCallOrder[i]! }))
        .filter((c) => c.args[0] === "push")
        .map((c) => c.order);
      return orders.length ? Math.min(...orders) : Infinity;
    }

    /** Messages (`-m` arg) of every `git commit` call. */
    function commitMessages(): string[] {
      return gitCalls().filter((a) => a[0] === "commit").map((a) => a[2]!);
    }

    beforeEach(() => {
      state.snapshots = [{ source: REL_SOURCE, target: REL_TARGET, mirrorReleases: true }];
      mockGh.listRepos.mockResolvedValue([
        { owner: "St-John-Software", name: "TempoStatusBar", fullName: REL_SOURCE, defaultBranch: "main" },
      ]);
      // The download dir (…/release-assets/stjohnb) yields plain string filenames,
      // as the real fs.readdirSync(dlDir) does; every other dir keeps the object
      // form used by the withFileTypes secret-scan walk.
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (String(dir).includes("release-assets")) {
          return ["TempoStatusBarApp-1.3.1.dmg"];
        }
        return [{ name: "README.md", isDirectory: () => false, isFile: () => true }];
      });
    });

    it("skips release anchoring when there is no stable release (RC/prerelease filtering)", async () => {
      mockGh.listStableReleaseTags.mockResolvedValue([]); // no stable release tags

      await run();

      expect(mockGh.downloadReleaseAssets).not.toHaveBeenCalled();
      expect(mockGh.createRelease).not.toHaveBeenCalled();
      expect(mockGh.uploadReleaseAssets).not.toHaveBeenCalled();
      // Regular single-commit snapshot still happens.
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
    });

    it("anchors a new release tag at its own snapshot commit (not HEAD), pushing before createRelease", async () => {
      mockGh.listStableReleaseTags.mockResolvedValue(["v1.3.1"]);
      tagShas = { "v1.3.1": "relsha131" }; // distinct from srcSha → separate release + HEAD commits
      mockGh.getReleaseAssetNames.mockResolvedValue(null); // public release absent

      await run();

      // Two commits: the source-accurate release snapshot, then the HEAD snapshot.
      expect(commitMessages()).toContain(`snapshot: v1.3.1 from ${REL_SOURCE}`);
      expect(commitMessages()).toContain(`snapshot: update from ${REL_SOURCE}`);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 2 });

      expect(mockGh.downloadReleaseAssets).toHaveBeenCalledWith(
        REL_SOURCE, "v1.3.1", "*.dmg", expect.stringContaining("release-assets/stjohnb"),
      );
      expect(mockGh.createRelease).toHaveBeenCalledTimes(1);
      const [repo, tag, assets, commitish] = mockGh.createRelease.mock.calls[0]!;
      expect(repo).toBe(REL_TARGET);
      expect(tag).toBe("v1.3.1");
      expect(assets).toEqual([expect.stringContaining("TempoStatusBarApp-1.3.1.dmg")]);
      // Anchored at the recorded release-commit SHA (git rev-parse HEAD mock), NOT HEAD-at-tag-time.
      expect(commitish).toBe(SRC_SHA);
      expect(mockGh.uploadReleaseAssets).not.toHaveBeenCalled();

      // The single push MUST precede createRelease (--target needs the commit on the remote).
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
      expect(mockGh.createRelease.mock.invocationCallOrder[0]!).toBeGreaterThan(pushInvocationOrder());
    });

    it("skips a tag already recorded in publishedReleases metadata", async () => {
      metaExists = true;
      metaSha = SRC_SHA; // source unchanged
      mockGh.listStableReleaseTags.mockResolvedValue(["v1.3.1"]);
      mockFs.readFileSync.mockImplementation((p: string) => {
        if (String(p).endsWith(".claws-snapshot.json")) {
          return JSON.stringify({ sourceSha: metaSha, publishedReleases: { "v1.3.1": "oldcommitsha" } });
        }
        return fileContent;
      });

      await run();

      // Already published source-accurately + source unchanged → pure idempotent no-op.
      expect(commitMessages()).not.toContain(`snapshot: v1.3.1 from ${REL_SOURCE}`);
      expect(gitCalls().some((a) => a[0] === "commit")).toBe(false);
      expect(mockGh.createRelease).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0 });
    });

    it("leaves a pre-existing public release alone (records it as preexisting)", async () => {
      mockGh.listStableReleaseTags.mockResolvedValue(["v1.3.1"]);
      tagShas = { "v1.3.1": "relsha131" };
      mockGh.getReleaseAssetNames.mockResolvedValue(["TempoStatusBarApp-1.3.1.dmg"]); // already exists publicly

      await run();

      // Existing public release is never re-anchored: no release commit, no create/upload.
      expect(commitMessages()).not.toContain(`snapshot: v1.3.1 from ${REL_SOURCE}`);
      expect(mockGh.createRelease).not.toHaveBeenCalled();
      expect(mockGh.uploadReleaseAssets).not.toHaveBeenCalled();
      // The source still advanced → the regular HEAD snapshot commit + push happen.
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
    });

    it("skips an unreachable release tag (merge-base --is-ancestor fails)", async () => {
      mockGh.listStableReleaseTags.mockResolvedValue(["v9.9.9"]);
      tagShas = { "v9.9.9": "unreachablesha" };
      tagUnreachable = true; // tag not reachable from srcSha

      await run();

      expect(commitMessages()).not.toContain(`snapshot: v9.9.9 from ${REL_SOURCE}`);
      expect(mockGh.createRelease).not.toHaveBeenCalled();
      // Still produces the regular HEAD snapshot commit.
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1 });
    });

    it("mirrors the latest release via the fallback when the source sync is a no-op", async () => {
      metaExists = true;
      metaSha = SRC_SHA; // source unchanged, no pending tags → idempotency no-op path
      mockGh.getLatestStableReleaseTag.mockResolvedValue("v1.3.1");
      mockGh.getReleaseAssetNames.mockResolvedValue(null);

      await run();

      expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
      expect(mockGh.createRelease).toHaveBeenCalledTimes(1);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0 });
    });

    it("files a single alert when the DMG mirror fails, without failing the pushed sync", async () => {
      mockGh.listStableReleaseTags.mockResolvedValue(["v1.3.1"]);
      tagShas = { "v1.3.1": "relsha131" };
      mockGh.getReleaseAssetNames.mockResolvedValue(null);
      mockGh.downloadReleaseAssets.mockRejectedValue(new Error("network down"));
      // No dmg lands on disk when the download itself fails, and this pair has no
      // releaseAssetUrl fallback configured — downloadDmgAssets must still throw.
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (String(dir).includes("release-assets")) return [];
        return [{ name: "README.md", isDirectory: () => false, isFile: () => true }];
      });

      await run();

      expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
      expect(mockOccurrence.ensureAlertIssue.mock.calls[0]![0].title).toContain("Release mirror failed");
      // The snapshot commits were already pushed → sync is not marked failed.
      expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
      expect(gitCalls().some((a) => a[0] === "push")).toBe(true);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 2 });
    });

    it("aborts before any push when a release-commit tree contains a secret", async () => {
      mockGh.listStableReleaseTags.mockResolvedValue(["v1.3.1"]);
      tagShas = { "v1.3.1": "relsha131" };
      mockGh.getReleaseAssetNames.mockResolvedValue(null);
      const secret = "ghp_" + "D".repeat(38);
      fileContent = `token=${secret}\n`; // every scanned file (incl. the release tree) trips the scan

      await run();

      expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
      expect(mockOccurrence.ensureAlertIssue.mock.calls[0]![0].title).toContain("Secret detected");
      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "secret detected", { commits: 0 });
      expect(gitCalls().some((a) => a[0] === "push")).toBe(false);
      expect(mockGh.createRelease).not.toHaveBeenCalled();
    });
  });

  describe("S3 DMG fallback via releaseAssetUrl (#2115)", () => {
    const REL_SOURCE = "St-John-Software/TempoStatusBar";
    const REL_TARGET = "stjohnb/TempoStatusBar";
    const TEMPLATE = "https://example.invalid/releases/TempoStatusBarApp-{version}.dmg";

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    beforeEach(() => {
      mockGh.listRepos.mockResolvedValue([
        { owner: "St-John-Software", name: "TempoStatusBar", fullName: REL_SOURCE, defaultBranch: "main" },
      ]);
      mockGh.listStableReleaseTags.mockResolvedValue(["v1.3.1"]);
      tagShas = { "v1.3.1": "relsha131" };
      mockGh.getReleaseAssetNames.mockResolvedValue(null); // public release absent
      mockGh.downloadReleaseAssets.mockRejectedValue(new Error("release not found")); // no gh asset
      // No dmg on disk — the source release genuinely has no .dmg asset attached.
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (String(dir).includes("release-assets")) return [];
        return [{ name: "README.md", isDirectory: () => false, isFile: () => true }];
      });
    });

    it("falls back to the S3 URL when the source release has no .dmg asset", async () => {
      state.snapshots = [{ source: REL_SOURCE, target: REL_TARGET, mirrorReleases: true, releaseAssetUrl: TEMPLATE }];
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(1024) });
      vi.stubGlobal("fetch", fetchMock);

      await run();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.invalid/releases/TempoStatusBarApp-1.3.1.dmg",
        expect.anything(),
      );
      expect(
        mockFs.writeFileSync.mock.calls.some((c) => String(c[0]).endsWith("TempoStatusBarApp-1.3.1.dmg")),
      ).toBe(true);
      expect(mockGh.createRelease).toHaveBeenCalledTimes(1);
      const [, , assets] = mockGh.createRelease.mock.calls[0]!;
      expect(assets).toEqual([expect.stringContaining("TempoStatusBarApp-1.3.1.dmg")]);
    });

    it("alerts on HTTP 404 without retrying", async () => {
      state.snapshots = [{ source: REL_SOURCE, target: REL_TARGET, mirrorReleases: true, releaseAssetUrl: TEMPLATE }];
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      vi.stubGlobal("fetch", fetchMock);

      await run();

      expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledWith(
        expect.objectContaining({ title: `[snapshot] Release mirror failed for ${REL_TARGET}` }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("alerts with the no-asset message when no releaseAssetUrl is configured", async () => {
      state.snapshots = [{ source: REL_SOURCE, target: REL_TARGET, mirrorReleases: true }];

      await run();

      expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: `[snapshot] Release mirror failed for ${REL_TARGET}`,
          body: expect.stringContaining("no .dmg asset found"),
        }),
      );
    });
  });
});
