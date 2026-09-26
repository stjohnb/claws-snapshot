import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockReportError } = vi.hoisted(() => ({
  mockReportError: vi.fn(),
}));
vi.mock("../error-reporter.js", () => ({
  reportError: mockReportError,
}));

vi.mock("../prompt-guard.js", () => ({
  guardContent: (t: string) => t,
}));

vi.mock("../pages/blog.js", () => ({
  BLOG_REPO: "St-John-Software/bstjohn-blog",
  BLOG_CONTENT_DIR: "src/content/blog",
}));

const { mockDb, mockGh } = vi.hoisted(() => ({
  mockDb: {
    hasBlogDraftPortFiled: vi.fn(),
    recordBlogDraftPortFiled: vi.fn(),
  },
  mockGh: {
    listRepoDirectory: vi.fn(),
    fetchRepoFileContent: vi.fn(),
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
  },
}));

vi.mock("../db.js", () => mockDb);
vi.mock("../github.js", () => mockGh);

import {
  run,
  extractDraftTitle,
  looksLikeDraftPost,
  isCandidateFile,
  isAlreadyPublished,
  normalizeTitle,
  loadPublishedIndex,
  type PublishedIndex,
} from "./blog-draft-scanner.js";

const LONG_PARAGRAPH =
  "This is a long prose paragraph about something interesting that happened recently and is worth writing about at length. ".repeat(3);

function buildLongDraftBody(paragraphs = 5): string {
  return Array.from({ length: paragraphs }, () => LONG_PARAGRAPH).join("\n\n");
}

const BULLET_IDEAS_BODY = Array.from({ length: 10 }, (_, i) => `- Idea number ${i}: write about something`).join("\n");

describe("blog-draft-scanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listRepoDirectory.mockResolvedValue([]);
    mockGh.fetchRepoFileContent.mockResolvedValue(null);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(42);
    mockDb.hasBlogDraftPortFiled.mockReturnValue(false);
  });

  describe("extractDraftTitle", () => {
    it("reads a quoted frontmatter title", () => {
      const content = `---\ntitle: 'My Own Personal Claws'\npubDate: 2026-03-16\n---\n\nBody text.\n`;
      expect(extractDraftTitle(content)).toBe("My Own Personal Claws");
    });

    it("falls back to the first # heading when there is no frontmatter title", () => {
      const content = `# 3D modelling with OpenSCAD\n\nSome body text about modelling.\n`;
      expect(extractDraftTitle(content)).toBe("3D modelling with OpenSCAD");
    });
  });

  describe("looksLikeDraftPost", () => {
    it("is false for a bullet-only BLOG_IDEAS.md-shaped body", () => {
      expect(looksLikeDraftPost(BULLET_IDEAS_BODY)).toBe(false);
    });

    it("is true for a long-paragraph draft", () => {
      expect(looksLikeDraftPost(buildLongDraftBody())).toBe(true);
    });
  });

  describe("isCandidateFile", () => {
    it("accepts docs/blog-post.md", () => {
      expect(isCandidateFile("docs", "blog-post.md")).toBe(true);
    });

    it("rejects ideas/BLOG_IDEAS.md", () => {
      expect(isCandidateFile("ideas", "BLOG_IDEAS.md")).toBe(false);
    });

    it("accepts ideas/blog-truenas-to-nixos.md", () => {
      expect(isCandidateFile("ideas", "blog-truenas-to-nixos.md")).toBe(true);
    });

    it("rejects docs/OVERVIEW.md", () => {
      expect(isCandidateFile("docs", "OVERVIEW.md")).toBe(false);
    });

    it("accepts anything under docs/blog-drafts", () => {
      expect(isCandidateFile("docs/blog-drafts", "anything.md")).toBe(true);
    });
  });

  describe("isAlreadyPublished", () => {
    it("matches on a case-differing title", () => {
      const index: PublishedIndex = {
        titles: new Set([normalizeTitle("3D Modelling with OpenSCAD")]),
        slugs: new Set(),
      };
      expect(isAlreadyPublished("3D modelling with OpenSCAD", "blog-post.md", index)).toBe(true);
    });

    it("matches a draft file basename against a published slug", () => {
      const index: PublishedIndex = {
        titles: new Set(),
        slugs: new Set(["truenas-to-nixos"]),
      };
      expect(isAlreadyPublished("Some other title", "blog-truenas-to-nixos.md", index)).toBe(true);
    });

    it("does not match an unrelated title/file", () => {
      const index: PublishedIndex = {
        titles: new Set([normalizeTitle("Something else")]),
        slugs: new Set(["something-else"]),
      };
      expect(isAlreadyPublished("Replacing TrueNAS with NixOS for Plex", "blog-truenas-to-nixos.md", index)).toBe(false);
    });
  });

  describe("loadPublishedIndex", () => {
    it("returns null when the content listing is empty", async () => {
      mockGh.listRepoDirectory.mockResolvedValue([]);
      expect(await loadPublishedIndex()).toBeNull();
    });
  });

  describe("run", () => {
    const publishedListing = [
      { name: "2026-03-16-claws.md", path: "src/content/blog/2026-03-16-claws.md", sha: "a", type: "file" },
    ];

    it("files exactly one issue for an unpublished draft and records it", async () => {
      const repo = mockRepo({ fullName: "St-John-Software/fleet-infra" });
      mockGh.listRepoDirectory.mockImplementation(async (fullName: string, dir: string) => {
        if (fullName === "St-John-Software/bstjohn-blog") return publishedListing;
        if (fullName === repo.fullName && dir === "ideas") {
          return [{ name: "blog-truenas-to-nixos.md", path: "ideas/blog-truenas-to-nixos.md", sha: "x", type: "file" }];
        }
        return [];
      });
      mockGh.fetchRepoFileContent.mockImplementation(async (fullName: string, path: string) => {
        if (fullName === "St-John-Software/bstjohn-blog") return `---\ntitle: 'My Own Personal Claws'\n---\n\nbody\n`;
        if (path === "ideas/blog-truenas-to-nixos.md") {
          return `# Replacing TrueNAS with NixOS for Plex\n\n${buildLongDraftBody()}\n`;
        }
        return null;
      });

      await run([repo]);

      expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.createIssue.mock.calls[0]![0]).toBe("St-John-Software/bstjohn-blog");
      expect(mockDb.recordBlogDraftPortFiled).toHaveBeenCalledWith(
        repo.fullName,
        "ideas/blog-truenas-to-nixos.md",
        42,
      );
    });

    it("files nothing when the title matches a published post", async () => {
      const repo = mockRepo({ fullName: "St-John-Software/claws" });
      mockGh.listRepoDirectory.mockImplementation(async (fullName: string, dir: string) => {
        if (fullName === "St-John-Software/bstjohn-blog") return publishedListing;
        if (fullName === repo.fullName && dir === "docs") {
          return [{ name: "blog-post.md", path: "docs/blog-post.md", sha: "x", type: "file" }];
        }
        return [];
      });
      mockGh.fetchRepoFileContent.mockImplementation(async (fullName: string, path: string) => {
        if (fullName === "St-John-Software/bstjohn-blog") return `---\ntitle: 'My Own Personal Claws'\n---\n\nbody\n`;
        if (path === "docs/blog-post.md") {
          return `---\ntitle: 'My Own Personal Claws'\n---\n\n${buildLongDraftBody()}\n`;
        }
        return null;
      });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("files nothing when hasBlogDraftPortFiled returns true", async () => {
      const repo = mockRepo({ fullName: "St-John-Software/fleet-infra" });
      mockDb.hasBlogDraftPortFiled.mockReturnValue(true);
      mockGh.listRepoDirectory.mockImplementation(async (fullName: string, dir: string) => {
        if (fullName === "St-John-Software/bstjohn-blog") return publishedListing;
        if (fullName === repo.fullName && dir === "ideas") {
          return [{ name: "blog-truenas-to-nixos.md", path: "ideas/blog-truenas-to-nixos.md", sha: "x", type: "file" }];
        }
        return [];
      });

      await run([repo]);

      expect(mockGh.fetchRepoFileContent).not.toHaveBeenCalledWith(repo.fullName, "ideas/blog-truenas-to-nixos.md");
      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("records but does not create when an issue with the exact title already exists", async () => {
      const repo = mockRepo({ fullName: "St-John-Software/fleet-infra" });
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 99, title: "existing" });
      mockGh.listRepoDirectory.mockImplementation(async (fullName: string, dir: string) => {
        if (fullName === "St-John-Software/bstjohn-blog") return publishedListing;
        if (fullName === repo.fullName && dir === "ideas") {
          return [{ name: "blog-truenas-to-nixos.md", path: "ideas/blog-truenas-to-nixos.md", sha: "x", type: "file" }];
        }
        return [];
      });
      mockGh.fetchRepoFileContent.mockImplementation(async (fullName: string, path: string) => {
        if (fullName === "St-John-Software/bstjohn-blog") return `---\ntitle: 'My Own Personal Claws'\n---\n\nbody\n`;
        if (path === "ideas/blog-truenas-to-nixos.md") {
          return `# Replacing TrueNAS with NixOS for Plex\n\n${buildLongDraftBody()}\n`;
        }
        return null;
      });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
      expect(mockDb.recordBlogDraftPortFiled).toHaveBeenCalledWith(
        repo.fullName,
        "ideas/blog-truenas-to-nixos.md",
        99,
      );
    });

    it("returns early and creates nothing when the blog content listing is empty", async () => {
      const repo = mockRepo({ fullName: "St-John-Software/fleet-infra" });
      mockGh.listRepoDirectory.mockResolvedValue([]);

      await run([repo]);

      expect(mockGh.fetchRepoFileContent).not.toHaveBeenCalled();
      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("never scans BLOG_REPO itself", async () => {
      const blogRepo = mockRepo({ fullName: "St-John-Software/bstjohn-blog" });
      mockGh.listRepoDirectory.mockImplementation(async (fullName: string) => {
        if (fullName === "St-John-Software/bstjohn-blog") return publishedListing;
        return [];
      });
      mockGh.fetchRepoFileContent.mockResolvedValue(`---\ntitle: 'My Own Personal Claws'\n---\n\nbody\n`);

      await run([blogRepo]);

      // Only the published-index listing call should have happened, never a
      // per-candidate-dir scan of bstjohn-blog itself.
      const calledDirs = mockGh.listRepoDirectory.mock.calls.map((c: unknown[]) => c[1]);
      expect(calledDirs).toEqual(["src/content/blog"]);
      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });
  });
});
