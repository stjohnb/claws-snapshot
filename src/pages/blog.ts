import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, formatRelativeTime } from "./layout.js";
import type { BlogDraftRow } from "../db.js";
import type { RepoDirEntry } from "../github.js";

export const BLOG_REPO = process.env["CLAWS_BLOG_REPO"] ?? "St-John-Software/bstjohn-blog";
export const BLOG_CONTENT_DIR = process.env["CLAWS_BLOG_CONTENT_DIR"] ?? "src/content/blog";

export function isValidBlogPath(path: string): boolean {
  return (
    path.startsWith(BLOG_CONTENT_DIR + "/") &&
    path.endsWith(".md") &&
    !path.split("/").includes("..")
  );
}

const BLOG_CSS = `
  .blog-table { border-collapse: collapse; font-size: 0.85rem; width: 100%; margin-bottom: 1rem; }
  .blog-table th, .blog-table td { padding: 0.4rem 0.6rem; border: 1px solid var(--border); text-align: left; }
  .blog-table th { background: var(--bg); }
  .blog-badge { display: inline-block; padding: 0.1em 0.5em; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .blog-badge.draft { background: #d4a72c; color: #fff; }
  .blog-badge.pushed { background: #2da44e; color: #fff; }
  .blog-badge.none { color: var(--text-subtle); }
  .blog-flash { background: #2da44e; color: #fff; padding: 0.5em 1em; margin: 0 0 0.5em 0; font-weight: 600; border-radius: 4px; }
  .blog-flash.error { background: #d93f0b; }
  .blog-actions { margin-bottom: 1rem; }
  .blog-actions a, .blog-btn { display: inline-block; padding: 0.4em 0.9em; border-radius: 4px; background: var(--accent, #0969da); color: #fff; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 0.85rem; }
`;

function statusBadge(draft: BlogDraftRow | undefined): string {
  if (!draft) return `<span class="blog-badge none">—</span>`;
  if (draft.pr_number != null) {
    const pr = `<span class="blog-badge pushed">pushed #${draft.pr_number}</span>`;
    return draft.status === "pushed"
      ? pr
      : `${pr} <span class="blog-badge draft">unpushed edits</span>`;
  }
  return `<span class="blog-badge draft">draft</span>`;
}

export function buildBlogListPage(
  entries: RepoDirEntry[],
  drafts: BlogDraftRow[],
  theme: Theme,
  flash?: { text: string; error?: boolean },
): string {
  const draftsByPath = new Map<string, BlogDraftRow>();
  for (const d of drafts) draftsByPath.set(d.path, d);

  // Existing posts (from GitHub), newest date first.
  const posts = [...entries].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const seen = new Set(posts.map((p) => p.path));

  // Draft-only rows: new posts not yet on GitHub.
  const draftOnly = drafts.filter((d) => !seen.has(d.path));

  const postRows = posts.map((entry) => {
    const draft = draftsByPath.get(entry.path);
    const edited = draft ? formatRelativeTime(draft.updated_at) : "—";
    return `<tr>
      <td><a href="/blog/edit?path=${encodeURIComponent(entry.path)}">${escapeHtml(entry.name)}</a></td>
      <td>${statusBadge(draft)}</td>
      <td>${edited}</td>
    </tr>`;
  });

  const draftRows = draftOnly.map((draft) => {
    const name = draft.path.split("/").pop() ?? draft.path;
    return `<tr>
      <td><a href="/blog/edit?path=${encodeURIComponent(draft.path)}">${escapeHtml(name)}</a> <span class="blog-badge none">(new)</span></td>
      <td>${statusBadge(draft)}</td>
      <td>${formatRelativeTime(draft.updated_at)}</td>
    </tr>`;
  });

  const allRows = [...draftRows, ...postRows].join("\n");
  const body = allRows === ""
    ? '<p class="idle">No posts found.</p>'
    : `<table class="blog-table">
        <thead><tr><th>File</th><th>Status</th><th>Last edited</th></tr></thead>
        <tbody>${allRows}</tbody>
      </table>`;

  const flashBanner = flash
    ? `<div class="blog-flash${flash.error ? " error" : ""}">${escapeHtml(flash.text)}</div>`
    : "";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — Blog</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${BLOG_CSS}
  .idle { color: var(--text-subtle); font-style: italic; }
  </style>
</head>
<body>
  ${buildPageHeader("Blog", theme)}
  ${THEME_SCRIPT}
  ${flashBanner}
  <div class="blog-actions"><a href="/blog/edit?new=1">New post</a></div>
  ${body}
</body>
</html>`;
}

const NEW_POST_SKELETON = `---
title: ''
pubDate: ${new Date().toISOString().slice(0, 10)}
description: ''
author: 'Brendan St. John'
---

`;

export function buildBlogEditPage(
  path: string,
  content: string,
  baseSha: string,
  isNew: boolean,
  theme: Theme,
  pr?: { number: number },
  flash?: { text: string; error?: boolean },
): string {
  const pathField = isNew
    ? `<label>File path <input name="path" value="${escapeHtml(path || BLOG_CONTENT_DIR + "/")}" placeholder="${escapeHtml(BLOG_CONTENT_DIR)}/2026-07-03-my-slug.md" style="width:100%;font-family:monospace"></label><input type="hidden" name="new" value="1">`
    : `<input type="hidden" name="path" value="${escapeHtml(path)}">`;

  const textareaContent = isNew && content === "" ? NEW_POST_SKELETON : content;

  const prLink = pr
    ? ` · <a href="https://github.com/${escapeHtml(BLOG_REPO)}/pull/${pr.number}">PR #${pr.number}</a>`
    : "";

  const flashBanner = flash
    ? `<div class="blog-flash${flash.error ? " error" : ""}">${escapeHtml(flash.text)}</div>`
    : "";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — Edit blog post</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${BLOG_CSS}</style>
</head>
<body>
  ${buildPageHeader(isNew ? "New blog post" : "Edit blog post", theme)}
  ${THEME_SCRIPT}
  ${flashBanner}
  <p><a href="/blog">← Back to list</a>${prLink}</p>
  <form method="post" action="/blog/save">
    ${pathField}
    <input type="hidden" name="base_sha" value="${escapeHtml(baseSha)}">
    <p><textarea name="content" rows="30" style="width:100%;font-family:monospace">${escapeHtml(textareaContent)}</textarea></p>
    <button class="blog-btn" name="action" value="save">Save to Claws</button>
    <button class="blog-btn" name="action" value="push">Push to PR</button>
  </form>
</body>
</html>`;
}
