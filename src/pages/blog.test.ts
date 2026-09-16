import { describe, it, expect } from "vitest";
import { buildBlogListPage, buildBlogEditPage, BLOG_CONTENT_DIR } from "./blog.js";
import type { BlogDraftRow } from "../db.js";
import type { RepoDirEntry } from "../github.js";

const entry: RepoDirEntry = {
  name: "2026-03-16-claws.md",
  path: `${BLOG_CONTENT_DIR}/2026-03-16-claws.md`,
  sha: "abc123",
  type: "file",
};

const draftForEntry: BlogDraftRow = {
  repo: "St-John-Software/bstjohn-blog",
  path: `${BLOG_CONTENT_DIR}/2026-03-16-claws.md`,
  content: "edited",
  base_sha: "abc123",
  title: "Claws",
  status: "pushed",
  pr_number: 42,
  pr_branch: "claws/blog-x",
  updated_at: new Date().toISOString(),
};

const draftOnly: BlogDraftRow = {
  repo: "St-John-Software/bstjohn-blog",
  path: `${BLOG_CONTENT_DIR}/2026-07-03-brand-new.md`,
  content: "new post body",
  base_sha: null,
  title: "Brand New",
  status: "draft",
  pr_number: null,
  pr_branch: null,
  updated_at: new Date().toISOString(),
};

describe("blog list page", () => {
  it("renders existing posts, draft-only rows, and the New post link", () => {
    const html = buildBlogListPage([entry], [draftForEntry, draftOnly], "light");
    expect(html).toContain("2026-03-16-claws.md");
    expect(html).toContain("2026-07-03-brand-new.md");
    // status badges
    expect(html).toContain("pushed #42");
    expect(html).toContain(">draft<");
    // new post link
    expect(html).toContain('href="/blog/edit?new=1"');
    // edit links
    expect(html).toContain("/blog/edit?path=");
  });

  it("renders a flash banner when provided", () => {
    const html = buildBlogListPage([], [], "light", { text: "Pushed PR #7" });
    expect(html).toContain("Pushed PR #7");
  });

  it("shows both the PR badge and an unpushed-edits badge for a draft with a recorded PR", () => {
    const draftWithUnpushedEdits: BlogDraftRow = { ...draftForEntry, status: "draft" };
    const html = buildBlogListPage([entry], [draftWithUnpushedEdits], "light");
    expect(html).toContain("pushed #42");
    expect(html).toContain("unpushed edits");
  });
});

describe("blog edit page", () => {
  it("escapes file content in the textarea", () => {
    const raw = "---\ntitle: 'x & <y>'\n---\n\n<script>alert(1)</script> & more";
    const html = buildBlogEditPage("src/content/blog/a.md", raw, "sha1", false, "light");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; more");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("renders both submit buttons and hidden fields for an existing post", () => {
    const html = buildBlogEditPage("src/content/blog/a.md", "body", "sha1", false, "light");
    expect(html).toContain('name="action" value="save"');
    expect(html).toContain('name="action" value="push"');
    expect(html).toContain('name="path" value="src/content/blog/a.md"');
    expect(html).toContain('name="base_sha" value="sha1"');
    expect(html).toContain('action="/blog/save"');
  });

  it("prefills the path input for a new post", () => {
    const html = buildBlogEditPage("", "", "", true, "light");
    expect(html).toContain('name="path"');
    expect(html).toContain(`value="${BLOG_CONTENT_DIR}/"`);
  });

  it("links to an existing PR when provided", () => {
    const html = buildBlogEditPage("src/content/blog/a.md", "body", "sha1", false, "light", { number: 99 });
    expect(html).toContain("PR #99");
  });
});
