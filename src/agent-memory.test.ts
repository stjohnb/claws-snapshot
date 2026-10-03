import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./config.js", () => ({ WORK_DIR: "/home/testuser/.claws", SELF_REPO: "St-John-Software/claws" }));

const { mockGit } = vi.hoisted(() => ({
  mockGit: vi.fn().mockResolvedValue("abc\trefs/heads/claude-memories"),
}));
vi.mock("./claude.js", () => ({ git: mockGit }));

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    lstatSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));

import { collectRepoMemories, syncMemoryBranch, __resetMemoryBranchCacheForTests } from "./agent-memory.js";

const FOLD_DIR = path.join("/home/testuser/.claws", "claude-memories-fold");
const ROOT = path.join(FOLD_DIR, "memories");
const SLUG_1 = "-home-openclaw-claws-repos-St-John-Software-claws";
const SLUG_2 = "-home-brendan--claws-repos-St-John-Software-claws";
const OTHER_REPO_SLUG = "-home-openclaw-claws-repos-St-John-Software-perudo";

function dirStat() {
  return { isFile: () => false, isDirectory: () => true, size: 0 };
}
function fileStat(size = 100) {
  return { isFile: () => true, isDirectory: () => false, size };
}

describe("agent-memory", () => {
  const repo = { owner: "St-John-Software", name: "claws" };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetMemoryBranchCacheForTests();
    mockGit.mockResolvedValue("abc\trefs/heads/claude-memories");
    mockFs.existsSync.mockImplementation((p: string) => p === path.join(FOLD_DIR, ".git") || p === ROOT);
    mockFs.readdirSync.mockReturnValue([]);
    mockFs.lstatSync.mockImplementation((p: string) => (p.startsWith(ROOT) && path.dirname(p) === ROOT ? dirStat() : fileStat()));
    mockFs.readFileSync.mockReturnValue("content");
  });

  describe("syncMemoryBranch", () => {
    it("calls claude.git once across two concurrent collectRepoMemories calls", async () => {
      mockFs.readdirSync.mockImplementation((p: string) => (p === ROOT ? [] : []));

      await Promise.all([collectRepoMemories(repo), collectRepoMemories(repo)]);

      const lsRemoteCalls = mockGit.mock.calls.filter((args) => args[0][0] === "ls-remote");
      expect(lsRemoteCalls.length).toBe(1);
    });

    it("returns null when the branch does not exist", async () => {
      mockGit.mockResolvedValue("");

      const dir = await syncMemoryBranch();

      expect(dir).toBeNull();
    });

    it("returns null when claude.git rejects", async () => {
      mockGit.mockRejectedValue(new Error("network error"));

      const dir = await syncMemoryBranch();

      expect(dir).toBeNull();
    });
  });

  describe("collectRepoMemories", () => {
    it("folds files from two slugs with different host prefixes and gives them distinct scopes", async () => {
      mockFs.readdirSync.mockImplementation((p: string) => {
        if (p === ROOT) return [SLUG_1, SLUG_2];
        if (p === path.join(ROOT, SLUG_1)) return ["MEMORY.md"];
        if (p === path.join(ROOT, SLUG_2)) return ["MEMORY.md"];
        return [];
      });

      const { files, available } = await collectRepoMemories(repo);

      expect(available).toBe(true);
      expect(files.map((f) => `${f.scope}/${f.name}`)).toEqual(["claude-h1/MEMORY.md", "claude-h2/MEMORY.md"]);
    });

    it("ignores a slug belonging to a different repo", async () => {
      mockFs.readdirSync.mockImplementation((p: string) => {
        if (p === ROOT) return [OTHER_REPO_SLUG];
        if (p === path.join(ROOT, OTHER_REPO_SLUG)) return ["MEMORY.md"];
        return [];
      });

      const { files } = await collectRepoMemories(repo);

      expect(files).toEqual([]);
    });

    it("sorts MEMORY.md first within a slug", async () => {
      mockFs.readdirSync.mockImplementation((p: string) => {
        if (p === ROOT) return [SLUG_1];
        if (p === path.join(ROOT, SLUG_1)) return ["zeta.md", "MEMORY.md", "alpha.md"];
        return [];
      });

      const { files } = await collectRepoMemories(repo);

      expect(files.map((f) => f.name)).toEqual(["MEMORY.md", "alpha.md", "zeta.md"]);
    });

    it("skips a file over the per-file byte cap", async () => {
      mockFs.readdirSync.mockImplementation((p: string) => {
        if (p === ROOT) return [SLUG_1];
        if (p === path.join(ROOT, SLUG_1)) return ["huge.md", "small.md"];
        return [];
      });
      mockFs.lstatSync.mockImplementation((p: string) => {
        if (path.dirname(p) === ROOT) return dirStat();
        return p.endsWith("huge.md") ? fileStat(70 * 1024) : fileStat(100);
      });

      const { files } = await collectRepoMemories(repo);

      expect(files.map((f) => f.name)).toEqual(["small.md"]);
    });

    it("caps the total number of files", async () => {
      const names = Array.from({ length: 90 }, (_, i) => `f${String(i).padStart(3, "0")}.md`);
      mockFs.readdirSync.mockImplementation((p: string) => {
        if (p === ROOT) return [SLUG_1];
        if (p === path.join(ROOT, SLUG_1)) return names;
        return [];
      });

      const { files } = await collectRepoMemories(repo);

      expect(files.length).toBe(80);
    });

    it("digest is stable across calls and changes with content", async () => {
      mockFs.readdirSync.mockImplementation((p: string) => {
        if (p === ROOT) return [SLUG_1];
        if (p === path.join(ROOT, SLUG_1)) return ["MEMORY.md"];
        return [];
      });
      mockFs.readFileSync.mockReturnValue("v1");

      const first = await collectRepoMemories(repo);
      __resetMemoryBranchCacheForTests();
      const second = await collectRepoMemories(repo);
      expect(first.digest).toBe(second.digest);
      expect(first.digest).not.toBe("");

      __resetMemoryBranchCacheForTests();
      mockFs.readFileSync.mockReturnValue("v2");
      const third = await collectRepoMemories(repo);
      expect(third.digest).not.toBe(first.digest);
    });

    it("returns available: true with empty digest when there are no matching slugs", async () => {
      mockFs.readdirSync.mockReturnValue([]);

      const { files, digest, available } = await collectRepoMemories(repo);
      expect(files).toEqual([]);
      expect(digest).toBe("");
      expect(available).toBe(true);
    });

    it("returns available: false with empty files/digest when the branch doesn't exist", async () => {
      mockGit.mockResolvedValue("");

      expect(await collectRepoMemories(repo)).toEqual({ files: [], digest: "", available: false });
    });

    it("returns available: false with empty files/digest when claude.git rejects", async () => {
      mockGit.mockRejectedValue(new Error("network error"));

      expect(await collectRepoMemories(repo)).toEqual({ files: [], digest: "", available: false });
    });

    it("degrades to no memories when readdirSync throws listing the memories root", async () => {
      mockFs.readdirSync.mockImplementation((p: string) => {
        if (p === ROOT) throw new Error("EACCES");
        return [];
      });

      expect(await collectRepoMemories(repo)).toEqual({ files: [], digest: "", available: false });
    });

    it("degrades to no memories when lstatSync is undefined (partial fs mock)", async () => {
      mockFs.readdirSync.mockImplementation((p: string) => (p === ROOT ? [SLUG_1] : []));
      (mockFs as { lstatSync?: unknown }).lstatSync = undefined;

      const { files } = await collectRepoMemories(repo);
      expect(files).toEqual([]);
    });
  });
});
