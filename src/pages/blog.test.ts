import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildBlogListPage, buildBlogEditPage, buildBlogDiffPage, isFrontmatterDraft, blogSlug, draftLiveness, groupBlogPosts, BLOG_CONTENT_DIR, BLOG_REPO } from "./blog.js";
import { prUrl } from "../config.js";
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
    // status badges: a PR with no recorded state is not found, never closed
    expect(html).toContain("PR #42 not found");
    expect(html).not.toContain("PR #42 closed");
    expect(html).toContain('"blog-badge draft">New post<');
    // new post link
    expect(html).toContain('href="/blog/edit?new=1"');
    // edit links
    expect(html).toContain("/blog/edit?path=");
  });

  it("renders a flash banner when provided", () => {
    const html = buildBlogListPage([], [], "light", { text: "Pushed PR #7" });
    expect(html).toContain("Pushed PR #7");
  });

  it("renders the posts table as data-cards with a data-label on the first cell", () => {
    const html = buildBlogListPage([entry], [draftForEntry], "light");
    expect(html).toContain('class="blog-table data-cards"');
    expect(html).toContain('data-label="File"');
  });

  const pub = { repoDraft: new Map([[entry.path, false]]) };

  it("shows a post with no Claws edits and no front-matter draft as Published", () => {
    const html = buildBlogListPage([entry], [], "light", undefined, undefined, pub);
    expect(html).toContain(">Published<");
    expect(html).not.toContain("—</span>");
  });

  it("shows repo files with draft: true as Draft", () => {
    const html = buildBlogListPage([entry], [], "light", undefined, undefined, { repoDraft: new Map([[entry.path, true]]) });
    expect(html).toContain(">Draft<");
    expect(html).not.toContain(">Published<");
  });

  it("shows a Claws-only post as a New post entry counted under Drafts", () => {
    const html = buildBlogListPage([], [draftOnly], "light");
    expect(html).toContain('"blog-badge draft">New post<');
    expect(html).toContain("Drafts (1)");
  });

  it("links an open PR as awaiting merge", () => {
    const html = buildBlogListPage([entry], [draftForEntry], "light", undefined, undefined, {
      ...pub,
      prStates: new Map([[42, "OPEN"]]),
    });
    expect(html).toContain("Awaiting merge · PR #42");
    expect(html).toContain("/pull");
    expect(html).not.toContain("Unpushed edits");
  });

  it("shows Published plus Unpushed edits for a published post with unpushed edits", () => {
    const edited: BlogDraftRow = { ...draftForEntry, status: "draft", pr_number: null, pr_branch: null };
    const html = buildBlogListPage([entry], [edited], "light", undefined, undefined, pub);
    expect(html).toContain(">Published<");
    expect(html).toContain("Unpushed edits");
  });

  it("reflects merged and closed PRs without a stale pushed state", () => {
    const merged = buildBlogListPage([entry], [draftForEntry], "light", undefined, undefined, { ...pub, prStates: new Map([[42, "MERGED"]]) });
    expect(merged).toContain("PR #42 merged");
    const closed = buildBlogListPage([entry], [draftForEntry], "light", undefined, undefined, { ...pub, prStates: new Map([[42, "CLOSED"]]) });
    expect(closed).toContain("PR #42 closed");
    expect(merged + closed).not.toContain("pushed #");
  });

  it("filters to drafts, hiding published rows but keeping Claws-only drafts", () => {
    const html = buildBlogListPage([entry], [draftOnly], "light", undefined, undefined, { ...pub, filter: "drafts" });
    expect(html).toContain("2026-07-03-brand-new.md");
    expect(html).not.toContain("2026-03-16-claws.md");
    expect(html).toContain('href="/blog"');
  });

  it("says there are no drafts when the filter matches nothing", () => {
    const html = buildBlogListPage([entry], [], "light", undefined, undefined, { ...pub, filter: "drafts" });
    expect(html).toContain("No drafts");
    expect(html).not.toContain("No posts found");
  });
});

describe("isFrontmatterDraft", () => {
  it("detects draft: true only in the leading front matter", () => {
    expect(isFrontmatterDraft("no front matter\ndraft: true")).toBe(false);
    expect(isFrontmatterDraft("---\ntitle: x\ndraft: false\n---\nbody")).toBe(false);
    expect(isFrontmatterDraft("---\ntitle: x\ndraft: true\n---\nbody")).toBe(true);
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

const blob = (content: string): string =>
  createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");

function repoEntry(name: string, sha = `sha-${name}`): RepoDirEntry {
  return { name, path: `${BLOG_CONTENT_DIR}/${name}`, sha, type: "file" };
}

function savedDraft(name: string, over: Partial<BlogDraftRow> = {}): BlogDraftRow {
  return {
    repo: BLOG_REPO,
    path: `${BLOG_CONTENT_DIR}/${name}`,
    content: `content of ${name}`,
    base_sha: `sha-${name}`,
    title: null,
    status: "pushed",
    pr_number: null,
    pr_branch: null,
    updated_at: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("blogSlug", () => {
  it("strips the directory, .md and a leading date", () => {
    expect(blogSlug(`${BLOG_CONTENT_DIR}/2026-07-10-homelab-sso-authentik.md`)).toBe("homelab-sso-authentik");
    expect(blogSlug("2026-07-24-homelab-sso-authentik.md")).toBe("homelab-sso-authentik");
    expect(blogSlug(`${BLOG_CONTENT_DIR}/about.md`)).toBe("about");
  });
});

describe("draftLiveness", () => {
  it("keeps a draft with an open or unknown PR live", () => {
    const d = savedDraft("a.md", { pr_number: 5 });
    expect(draftLiveness(d, "other", "OPEN")).toEqual({ live: true });
    expect(draftLiveness(d, "other", "UNKNOWN")).toEqual({ live: true });
  });

  it("marks a merged, closed or missing PR stale", () => {
    const d = savedDraft("a.md", { pr_number: 5 });
    expect(draftLiveness(d, undefined, "MERGED")).toEqual({ live: false, reason: "pr-merged" });
    expect(draftLiveness(d, undefined, "CLOSED")).toEqual({ live: false, reason: "pr-closed" });
    expect(draftLiveness(d, undefined, null)).toEqual({ live: false, reason: "pr-notfound" });
  });

  it("marks a PR-less draft stale only when the repo file moved past its base", () => {
    const d = savedDraft("a.md");
    expect(draftLiveness(d, "sha-a.md", null)).toEqual({ live: true });
    expect(draftLiveness(d, undefined, null)).toEqual({ live: true });
    expect(draftLiveness(d, "newer", null)).toEqual({ live: false, reason: "base-changed" });
  });
});

describe("blog list grouping by post", () => {
  // Today's state (2026-10-25): nine repo posts, three of them draft: true,
  // plus four leftover saved drafts whose GitHub-era PRs do not exist on Forgejo.
  const published = [
    "2025-01-15-wildcard-https-letsencrypt-nat.md",
    "2025-01-15-gitops-homelab-flux-k3s.md",
    "2026-03-16-claws.md",
    "2026-07-09-3d-modelling-with-openscad.md",
    "2026-07-24-homelab-sso-authentik.md",
    "2026-08-01-something-else.md",
  ];
  const repoDrafts = [
    "2026-08-24-replacing-truenas-with-nixos.md",
    "2026-08-27-letsencrypt-route53-oidc.md",
    "2026-09-25-ha-carlink-bench-build.md",
  ];
  const entries = [...published, ...repoDrafts].map((n) => repoEntry(n));
  const repoDraft = new Map<string, boolean | null>([
    ...published.map((n) => [`${BLOG_CONTENT_DIR}/${n}`, false] as [string, boolean]),
    ...repoDrafts.map((n) => [`${BLOG_CONTENT_DIR}/${n}`, true] as [string, boolean]),
  ]);
  const leftovers = [
    savedDraft("2026-07-10-homelab-sso-authentik.md", { pr_number: 484, base_sha: null }),
    savedDraft("2026-06-11-3d-modelling-with-openscad.md", { pr_number: 438, base_sha: null }),
    savedDraft("2025-01-15-wildcard-https-letsencrypt-nat.md", { pr_number: 482 }),
    savedDraft("2025-01-15-gitops-homelab-flux-k3s.md", { pr_number: 481 }),
  ];
  const prStates = new Map<number, string | null>([[484, null], [438, null], [482, null], [481, null]]);

  it("counts posts, excludes stale drafts from Drafts, and nests date-changed drafts under the published post", () => {
    const html = buildBlogListPage(entries, leftovers, "light", undefined, undefined, { repoDraft, prStates });
    expect(html).toContain("All (9)");
    expect(html).toContain("Drafts (3)");
    expect(html).not.toContain('"blog-badge draft">New post<');
    expect(html.match(/Stale · PR #\d+ not found/g)).toHaveLength(4);
    expect(html).not.toContain(" closed<");

    const groups = groupBlogPosts(entries, leftovers, new Map(), repoDraft, prStates);
    expect(groups).toHaveLength(9);
    const sso = groups.find((g) => g.slug === "homelab-sso-authentik")!;
    expect(sso.path).toBe(`${BLOG_CONTENT_DIR}/2026-07-24-homelab-sso-authentik.md`);
    expect(sso.items).toHaveLength(1);
    expect(sso.items[0]!.kind).toBe("saved");
    expect(groups.find((g) => g.slug === "3d-modelling-with-openscad")!.items).toHaveLength(1);
  });

  it("filters Drafts to the three repo drafts", () => {
    const html = buildBlogListPage(entries, leftovers, "light", undefined, undefined, { repoDraft, prStates, filter: "drafts" });
    for (const n of repoDrafts) expect(html).toContain(n);
    expect(html).not.toContain("2026-07-24-homelab-sso-authentik.md");
  });

  it("offers View diff, Edit and a confirmed Discard on each saved draft", () => {
    const html = buildBlogListPage(entries, leftovers, "light", undefined, undefined, { repoDraft, prStates });
    expect(html).toContain(`/blog/diff?path=${encodeURIComponent(`${BLOG_CONTENT_DIR}/2025-01-15-gitops-homelab-flux-k3s.md`)}`);
    expect(html).toContain(`/blog/edit?path=${encodeURIComponent(`${BLOG_CONTENT_DIR}/2025-01-15-gitops-homelab-flux-k3s.md`)}&amp;draft=1`);
    expect(html).toContain('action="/blog/discard"');
    expect(html).toContain("Discard the saved draft 2025-01-15-gitops-homelab-flux-k3s.md? The file in the blog repo is not changed.");
    expect(html).toContain("<th>Actions</th>");
  });

  it("disables View diff for a live draft identical to the repo file", () => {
    const content = "---\ntitle: x\n---\nbody\n";
    const e = repoEntry("2026-03-16-claws.md", blob(content));
    const d = savedDraft("2026-03-16-claws.md", { base_sha: e.sha, content: content.replace(/\n/g, "\r\n"), status: "draft" });
    const html = buildBlogListPage([e], [d], "light", undefined, undefined, { repoDraft: new Map([[e.path, false]]) });
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("/blog/diff?path=");
  });

  it("lists an open PR as a draft of the post it changes and counts the post under Drafts", () => {
    const e = repoEntry("2026-03-16-claws.md");
    const html = buildBlogListPage([e], [], "light", undefined, undefined, {
      repoDraft: new Map([[e.path, false]]),
      openPrFiles: new Map([[52, { title: "Fix typo", files: [e.path, "README.md"], updatedAt: "2026-10-24T00:00:00.000Z" }]]),
    });
    expect(html).toContain("Drafts (1)");
    expect(html).toContain("Awaiting merge · PR #52");
    expect(html).toContain("open PR · Fix typo");
    expect(html).toContain(`href="${prUrl(BLOG_REPO, 52)}">View diff`);
  });

  it("does not list an open PR twice when a saved draft already records it", () => {
    const e = repoEntry("2026-03-16-claws.md");
    const d = savedDraft("2026-03-16-claws.md", { pr_number: 52 });
    const groups = groupBlogPosts([e], [d], new Map([[52, { title: "t", files: [e.path] }]]), new Map([[e.path, false]]), new Map([[52, "OPEN"]]));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.kind)).toEqual(["saved"]);
    expect(groups[0]!.isDraft).toBe(true);
  });

  it("makes the newest repo file the entry when two share a slug", () => {
    const groups = groupBlogPosts([repoEntry("2026-01-01-x.md"), repoEntry("2026-02-01-x.md")], [], new Map(), new Map(), new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.path).toBe(`${BLOG_CONTENT_DIR}/2026-02-01-x.md`);
    expect(groups[0]!.items.map((i) => i.kind)).toEqual(["file"]);
  });
});

describe("blog edit page draft actions", () => {
  const path = `${BLOG_CONTENT_DIR}/2025-01-15-gitops-homelab-flux-k3s.md`;

  it("links the PR with prUrl, not a hard-coded github.com", () => {
    const html = buildBlogEditPage(path, "body", "sha1", false, "light", { number: 41 });
    expect(html).toContain(`href="${prUrl(BLOG_REPO, 41)}"`);
  });

  it("offers View diff and a confirmed Discard when a saved draft exists", () => {
    const html = buildBlogEditPage(path, "body", "sha1", false, "light", undefined, undefined, undefined, { exists: true });
    expect(html).toContain(`/blog/diff?path=${encodeURIComponent(path)}`);
    expect(html).toContain("return confirm(");
    expect(html).not.toContain('class="warning-banner"');
  });

  it("flags a stale draft and offers to load it", () => {
    const html = buildBlogEditPage(path, "repo body", "sha1", false, "light", undefined, undefined, undefined, {
      exists: true,
      stale: { reason: "pr-notfound", loaded: false, prNumber: 481 },
    });
    expect(html).toContain('class="warning-banner"');
    expect(html).toContain("PR #481 cannot be found");
    expect(html).toContain("Load stale draft");
    expect(html).toContain(`/blog/edit?path=${encodeURIComponent(path)}&amp;draft=1`);
  });

  it("warns that pushing a loaded stale draft overwrites newer repo text", () => {
    const html = buildBlogEditPage(path, "old body", "sha1", false, "light", undefined, undefined, undefined, {
      exists: true,
      stale: { reason: "base-changed", loaded: true },
    });
    expect(html).toContain("Push to PR will overwrite the newer repo text");
    expect(html).toContain("Show the repo version");
  });
});

describe("blog diff page", () => {
  const d = savedDraft("2025-01-15-gitops-homelab-flux-k3s.md", { pr_number: 481 });

  it("renders added and removed lines", () => {
    const html = buildBlogDiffPage(d, { path: d.path }, { ops: [{ op: "same", text: "a" }, { op: "del", text: "old <b>" }, { op: "add", text: "new" }] }, "light", "pr-notfound");
    expect(html).toContain('class="blog-diff-line del">- old &lt;b&gt;');
    expect(html).toContain('class="blog-diff-line add">+ new');
    expect(html).toContain("repo file <code>2025-01-15-gitops-homelab-flux-k3s.md</code>");
    expect(html).toContain("This saved draft is stale");
    expect(html).toContain('action="/blog/discard"');
  });

  it("says No differences for an identical draft and Too large when capped", () => {
    expect(buildBlogDiffPage(d, null, { ops: [{ op: "same", text: "a" }] }, "light")).toContain("No differences.");
    const big = buildBlogDiffPage(d, null, { tooLarge: true }, "light");
    expect(big).toContain("Too large to diff.");
    expect(big).toContain("an empty file (new post)");
  });
});
