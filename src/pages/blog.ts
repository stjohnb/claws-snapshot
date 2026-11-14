import { createHash } from "node:crypto";
import type { NavCounts, Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, formatRelativeTime } from "./layout.js";
import type { BlogDraftRow } from "../db.js";
import type { RepoDirEntry } from "../github.js";
import { prUrl } from "../config.js";
import { mapWithConcurrency } from "../util.js";
import type { LineDiff } from "../blog-diff.js";

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
  .blog-table th { background: var(--bg); }
  .blog-badge { display: inline-block; padding: 0.1em 0.5em; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .blog-badge.published { background: var(--success); color: #fff; }
  .blog-badge.draft { background: var(--warning); color: #fff; }
  .blog-badge.review { background: var(--accent); color: #fff; text-decoration: none; }
  .blog-badge.none { color: var(--text-subtle); }
  .blog-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
  .blog-flash { background: #2da44e; color: #fff; padding: 0.5em 1em; margin: 0 0 0.5em 0; font-weight: 600; border-radius: 4px; }
  .blog-flash.error { background: #d93f0b; }
  .blog-actions { margin-bottom: 1rem; }
  .blog-actions a, .blog-btn { display: inline-block; padding: 0.4em 0.9em; border-radius: 4px; background: var(--accent, #0969da); color: #fff; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 0.85rem; }
  .blog-badge.stale { color: var(--warning); border: 1px solid var(--warning); }
  .blog-sub .cell-title { padding-left: 1.5rem; font-weight: 400; }
  .blog-sub-kind { color: var(--text-subtle); font-size: 0.75rem; }
  .blog-row-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
  .blog-toolbar { margin-bottom: 1rem; }
  .blog-action { display: inline-flex; align-items: center; min-height: 30px; padding: 0 0.6rem; border: 1px solid var(--border); border-radius: 4px; font-size: 0.75rem; text-decoration: none; white-space: nowrap; }
  .blog-action.disabled { color: var(--text-subtle); cursor: not-allowed; opacity: 0.6; }
  .blog-inline-form { display: inline; margin: 0; }
  .blog-discard { min-height: 30px; padding: 0 0.6rem; background: none; color: var(--danger); border: 1px solid var(--danger); border-radius: 4px; font-family: inherit; font-size: 0.75rem; cursor: pointer; }
  .blog-diff { font-family: 'IBM Plex Mono', monospace; font-size: 0.8rem; border: 1px solid var(--border); border-radius: 4px; overflow-x: auto; }
  .blog-diff-line { white-space: pre; padding: 0 0.5rem; min-height: 1.2em; }
  .blog-diff-line.add { color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }
  .blog-diff-line.del { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
`;

/** True when the leading `---` front-matter block has a `draft: true` line. */
export function isFrontmatterDraft(content: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return false;
  return /^draft:\s*true\s*$/m.test(m[1]!);
}

// Repo draft flag per blob sha: post files are re-fetched only when they change.
const repoDraftCache = new Map<string, boolean>();

/** Resolve the front-matter draft flag for each entry; null when the fetch failed. */
export async function loadRepoDraftFlags(
  entries: RepoDirEntry[],
  fetchFile: (path: string) => Promise<{ content: string; sha: string } | null>,
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  await mapWithConcurrency(entries, 4, async (e) => {
    const cached = repoDraftCache.get(e.sha);
    if (cached !== undefined) {
      out.set(e.path, cached);
      return;
    }
    try {
      const file = await fetchFile(e.path);
      if (!file) {
        out.set(e.path, null);
        return;
      }
      const flag = isFrontmatterDraft(file.content);
      repoDraftCache.set(e.sha, flag);
      out.set(e.path, flag);
    } catch {
      out.set(e.path, null);
    }
  });
  return out;
}

/** A post's grouping key: its file name without `.md` and without a leading `YYYY-MM-DD-`. */
export function blogSlug(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export type StaleReason = "pr-merged" | "pr-closed" | "pr-notfound" | "base-changed";
export type DraftLiveness = { live: true } | { live: false; reason: StaleReason };

/**
 * Whether a saved draft is still live work. With a recorded PR it is live while
 * the PR is OPEN or the lookup failed ("UNKNOWN"); merged, closed or missing
 * (null) PRs make it stale. Without a PR it is live while its base sha matches
 * the repo file at the same path, or no repo file exists there.
 */
export function draftLiveness(
  draft: BlogDraftRow,
  repoShaAtPath: string | undefined,
  prState: string | null,
): DraftLiveness {
  if (draft.pr_number != null) {
    if (prState === "OPEN" || prState === "UNKNOWN") return { live: true };
    if (prState === "MERGED") return { live: false, reason: "pr-merged" };
    if (prState === "CLOSED") return { live: false, reason: "pr-closed" };
    return { live: false, reason: "pr-notfound" };
  }
  if (repoShaAtPath === undefined || draft.base_sha === repoShaAtPath) return { live: true };
  return { live: false, reason: "base-changed" };
}

function gitBlobSha(content: string): string {
  return createHash("sha1").update(`blob ${Buffer.byteLength(content, "utf8")}\0`).update(content, "utf8").digest("hex");
}

/** True when `content` is byte-identical to the repo blob `sha` (allowing for the browser's CRLF line endings). */
function sameAsBlob(content: string, sha: string): boolean {
  return gitBlobSha(content) === sha || gitBlobSha(content.replace(/\r\n/g, "\n")) === sha;
}

export interface BlogRowStatus {
  base: "published" | "draft" | "unknown";
  pr: { kind: "review" | "merged" | "closed" | "notfound" | "unknown"; number: number } | null;
  unpushed: boolean;
}

/** PR state: "OPEN" | "MERGED" | "CLOSED", null when missing, "UNKNOWN" when the lookup failed. */
export function blogRowStatus(
  inRepo: boolean,
  repoDraft: boolean | null,
  draft: BlogDraftRow | undefined,
  prState: string | null,
): BlogRowStatus {
  const base: BlogRowStatus["base"] = !inRepo
    ? "draft"
    : repoDraft === null
      ? "unknown"
      : repoDraft
        ? "draft"
        : "published";
  let pr: BlogRowStatus["pr"] = null;
  if (draft?.pr_number != null) {
    const kind = prState === "OPEN"
      ? "review"
      : prState === "MERGED"
        ? "merged"
        : prState === "CLOSED"
          ? "closed"
          : prState === "UNKNOWN"
            ? "unknown"
            : "notfound";
    pr = { kind, number: draft.pr_number };
  }
  const unpushed = !!draft && (draft.pr_number != null ? draft.status === "draft" : inRepo);
  return { base, pr, unpushed };
}

export type BlogBase = "published" | "draft" | "unknown" | "new";

/** A Claws-saved draft under a post. `diffable` is false only when its content equals the file it would be diffed against. */
export interface BlogSavedItem { kind: "saved"; draft: BlogDraftRow; prState: string | null; liveness: DraftLiveness; diffable: boolean }
/** An open PR on the blog repo that changes a file of this post. */
export interface BlogPrItem { kind: "pr"; number: number; title: string; path: string; updatedAt?: string; /** The editor can open this path (in the repo or saved as a draft). */ editable: boolean }
/** Another repo file sharing the post's slug (slug collision). */
export interface BlogFileItem { kind: "file"; entry: RepoDirEntry; base: BlogBase }
export type BlogSubItem = BlogSavedItem | BlogPrItem | BlogFileItem;

export interface BlogPostGroup {
  slug: string;
  /** The file heading the entry: the newest repo file with this slug, else the newest draft or PR file. */
  path: string;
  inRepo: boolean;
  base: BlogBase;
  items: BlogSubItem[];
  /** Counts under the Drafts filter: repo `draft: true`, or any live saved draft or open PR. */
  isDraft: boolean;
  latestEdit: string | null;
}

export interface OpenPrFiles { title: string; files: string[]; updatedAt?: string }

const byNameDesc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

/** Group repo files, saved drafts and open-PR files into one entry per post, keyed by `blogSlug`. */
export function groupBlogPosts(
  entries: RepoDirEntry[],
  drafts: BlogDraftRow[],
  openPrFiles: Map<number, OpenPrFiles>,
  repoDraft: Map<string, boolean | null>,
  prStates: Map<number, string | null>,
): BlogPostGroup[] {
  const repoShas = new Map(entries.map((e) => [e.path, e.sha]));
  const bySlug = new Map<string, BlogPostGroup>();
  const repoGroups: BlogPostGroup[] = [];
  const newGroups: BlogPostGroup[] = [];
  const baseOf = (path: string): BlogBase => {
    const flag = repoDraft.get(path) ?? null;
    return flag === null ? "unknown" : flag ? "draft" : "published";
  };
  const newGroup = (slug: string, path: string): BlogPostGroup => {
    const g: BlogPostGroup = { slug, path, inRepo: false, base: "new", items: [], isDraft: false, latestEdit: null };
    bySlug.set(slug, g);
    newGroups.push(g);
    return g;
  };

  for (const entry of [...entries].sort((a, b) => byNameDesc(a.name, b.name))) {
    const slug = blogSlug(entry.path);
    const existing = bySlug.get(slug);
    if (existing) {
      existing.items.push({ kind: "file", entry, base: baseOf(entry.path) });
      continue;
    }
    const g: BlogPostGroup = { slug, path: entry.path, inRepo: true, base: baseOf(entry.path), items: [], isDraft: false, latestEdit: null };
    bySlug.set(slug, g);
    repoGroups.push(g);
  }

  for (const draft of [...drafts].sort((a, b) => byNameDesc(a.updated_at, b.updated_at))) {
    const slug = blogSlug(draft.path);
    const g = bySlug.get(slug) ?? newGroup(slug, draft.path);
    const prState = draft.pr_number != null ? (prStates.get(draft.pr_number) ?? null) : null;
    const against = repoShas.get(draft.path) ?? (g.inRepo ? repoShas.get(g.path) : undefined);
    g.items.push({
      kind: "saved",
      draft,
      prState,
      liveness: draftLiveness(draft, repoShas.get(draft.path), prState),
      diffable: against === undefined || !sameAsBlob(draft.content, against),
    });
  }

  // An open PR already tracked by a saved draft shows on that draft's sub-item, not twice.
  const tracked = new Set(
    drafts.map((d) => d.pr_number).filter((n): n is number => n != null && prStates.get(n) === "OPEN"),
  );
  const draftPaths = new Set(drafts.map((d) => d.path));
  for (const [number, pr] of [...openPrFiles].sort((a, b) => b[0] - a[0])) {
    if (tracked.has(number)) continue;
    for (const path of pr.files) {
      if (!isValidBlogPath(path)) continue;
      const slug = blogSlug(path);
      const g = bySlug.get(slug) ?? newGroup(slug, path);
      if (g.items.some((i) => i.kind === "pr" && i.number === number)) continue;
      g.items.push({ kind: "pr", number, title: pr.title, path, updatedAt: pr.updatedAt, editable: repoShas.has(path) || draftPaths.has(path) });
    }
  }

  const groups = [...newGroups, ...repoGroups];
  for (const g of groups) {
    g.isDraft = g.base === "draft" || g.items.some((i) => (i.kind === "saved" && i.liveness.live) || i.kind === "pr");
    const times = g.items.map((i) => (i.kind === "saved" ? i.draft.updated_at : i.kind === "pr" ? i.updatedAt : undefined))
      .filter((t): t is string => !!t);
    g.latestEdit = times.length ? times.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null;
  }
  return groups;
}

function baseChip(base: BlogBase): string {
  const label = { published: "Published", draft: "Draft", unknown: "Status unknown", new: "New post" }[base];
  const cls = { published: "published", draft: "draft", unknown: "none", new: "draft" }[base];
  return `<span class="blog-badge ${cls}">${label}</span>`;
}

function prChip(pr: NonNullable<BlogRowStatus["pr"]>): string {
  const n = pr.number;
  switch (pr.kind) {
    case "review":
      return `<a class="blog-badge review" href="${escapeHtml(prUrl(BLOG_REPO, n))}">Awaiting merge · PR #${n}</a>`;
    case "merged":
      return `<span class="blog-badge none">PR #${n} merged</span>`;
    case "closed":
      return `<span class="blog-badge none">PR #${n} closed</span>`;
    case "notfound":
      return `<span class="blog-badge none">PR #${n} not found</span>`;
    case "unknown":
      return `<span class="blog-badge none">PR #${n} status unknown</span>`;
  }
}

function staleChipText(reason: StaleReason, prNumber: number | null): string {
  switch (reason) {
    case "pr-merged":
      return `Stale · PR #${prNumber} merged`;
    case "pr-closed":
      return `Stale · PR #${prNumber} closed`;
    case "pr-notfound":
      return `Stale · PR #${prNumber} not found`;
    case "base-changed":
      return "Stale · repo file changed";
  }
}

function staleReasonText(reason: StaleReason, prNumber: number | null): string {
  switch (reason) {
    case "pr-merged":
      return `its PR #${prNumber} has merged`;
    case "pr-closed":
      return `its PR #${prNumber} was closed`;
    case "pr-notfound":
      return `its PR #${prNumber} cannot be found on the forge`;
    case "base-changed":
      return "the file in the blog repo has changed since it was saved";
  }
}

function savedChips(item: BlogSavedItem): string {
  const { draft, liveness } = item;
  const st = blogRowStatus(true, null, draft, item.prState);
  const chips: string[] = [];
  if (st.pr) chips.push(prChip(st.pr));
  if (draft.pr_number == null || draft.status === "draft") chips.push(`<span class="blog-badge draft">Unpushed edits</span>`);
  if (!liveness.live) chips.push(`<span class="blog-badge stale">${staleChipText(liveness.reason, draft.pr_number)}</span>`);
  return `<div class="blog-chips">${chips.join("")}</div>`;
}

function editHref(path: string, stale = false): string {
  return `/blog/edit?path=${encodeURIComponent(path)}${stale ? "&amp;draft=1" : ""}`;
}

function diffHref(path: string): string {
  return `/blog/diff?path=${encodeURIComponent(path)}`;
}

/** POST form that discards a saved draft after a native confirm(). */
function discardForm(path: string): string {
  const msg = `Discard the saved draft ${fileName(path)}? The file in the blog repo is not changed.`;
  return `<form class="blog-inline-form" method="post" action="/blog/discard" onsubmit="return confirm(${escapeHtml(JSON.stringify(msg))})"><input type="hidden" name="path" value="${escapeHtml(path)}"><button class="blog-discard" type="submit">Discard</button></form>`;
}

function subItemRow(item: BlogSubItem): string {
  let name: string;
  let chips: string;
  let edited = "—";
  const actions: string[] = [];
  if (item.kind === "file") {
    name = `<a href="${editHref(item.entry.path)}">${escapeHtml(item.entry.name)}</a> <span class="blog-sub-kind">repo file</span>`;
    chips = `<div class="blog-chips">${baseChip(item.base)}</div>`;
    actions.push(`<a class="blog-action" href="${editHref(item.entry.path)}">Edit</a>`);
  } else if (item.kind === "pr") {
    name = `${escapeHtml(fileName(item.path))} <span class="blog-sub-kind">open PR · ${escapeHtml(item.title)}</span>`;
    chips = `<div class="blog-chips">${prChip({ kind: "review", number: item.number })}</div>`;
    if (item.updatedAt) edited = formatRelativeTime(item.updatedAt);
    actions.push(
      `<a class="blog-action" href="${escapeHtml(prUrl(BLOG_REPO, item.number))}">View diff</a>`,
      item.editable
        ? `<a class="blog-action" href="${editHref(item.path)}">Edit</a>`
        : `<span class="blog-action disabled" aria-disabled="true" title="Only exists in PR #${item.number}">Edit</span>`,
    );
  } else {
    const { draft, liveness } = item;
    name = `${escapeHtml(fileName(draft.path))} <span class="blog-sub-kind">saved in Claws</span>`;
    chips = savedChips(item);
    edited = formatRelativeTime(draft.updated_at);
    actions.push(
      item.diffable
        ? `<a class="blog-action" href="${diffHref(draft.path)}">View diff</a>`
        : `<span class="blog-action disabled" aria-disabled="true" title="No differences from the repo file">View diff</span>`,
      `<a class="blog-action" href="${editHref(draft.path, !liveness.live)}">Edit</a>`,
    );
    if (draft.pr_number != null && item.prState === "OPEN") {
      actions.push(`<a class="blog-action" href="${escapeHtml(prUrl(BLOG_REPO, draft.pr_number))}">Open PR</a>`);
    }
    actions.push(discardForm(draft.path));
  }
  return `<tr class="blog-sub">
      <td class="cell-title" data-label="File">↳ ${name}</td>
      <td data-label="Status">${chips}</td>
      <td data-label="Last edited">${edited}</td>
      <td class="cell-actions" data-label="Actions"><div class="blog-row-actions">${actions.join("")}</div></td>
    </tr>`;
}

function postRows(g: BlogPostGroup): string {
  const headPr = g.inRepo || g.items.some((i) => i.kind === "saved" && i.draft.path === g.path)
    ? undefined
    : g.items.find((i): i is BlogPrItem => i.kind === "pr" && i.path === g.path);
  const nameCell = headPr
    ? `<a href="${escapeHtml(prUrl(BLOG_REPO, headPr.number))}">${escapeHtml(fileName(g.path))}</a>`
    : `<a href="${editHref(g.path)}">${escapeHtml(fileName(g.path))}</a>`;
  const editAction = headPr
    ? `<span class="blog-action disabled" aria-disabled="true" title="Only exists in PR #${headPr.number}">Edit</span>`
    : `<a class="blog-action" href="${editHref(g.path)}">Edit</a>`;
  const chip = g.base === "new" && !g.isDraft ? `<span class="blog-badge none">New post · stale</span>` : baseChip(g.base);
  const head = `<tr class="blog-post">
      <td class="cell-title" data-label="File">${nameCell}</td>
      <td data-label="Status"><div class="blog-chips">${chip}</div></td>
      <td data-label="Last edited">${g.latestEdit ? formatRelativeTime(g.latestEdit) : "—"}</td>
      <td class="cell-actions" data-label="Actions"><div class="blog-row-actions">${editAction}</div></td>
    </tr>`;
  return [head, ...g.items.map(subItemRow)].join("\n");
}

export interface BlogListOptions {
  repoDraft?: Map<string, boolean | null>;
  prStates?: Map<number, string | null>;
  /** Open PRs on the blog repo with the files each one changes. */
  openPrFiles?: Map<number, OpenPrFiles>;
  filter?: "all" | "drafts";
}

export function buildBlogListPage(
  entries: RepoDirEntry[],
  drafts: BlogDraftRow[],
  theme: Theme,
  flash?: { text: string; error?: boolean },
  navCounts?: NavCounts,
  opts: BlogListOptions = {},
): string {
  const filter = opts.filter ?? "all";
  const groups = groupBlogPosts(entries, drafts, opts.openPrFiles ?? new Map(), opts.repoDraft ?? new Map(), opts.prStates ?? new Map());
  const total = groups.length;
  const draftCount = groups.filter((g) => g.isDraft).length;
  const allRows = groups.filter((g) => filter === "all" || g.isDraft).map(postRows).join("\n");

  const filterBar = `<div class="filter-bar">
    <a href="/blog"${filter === "all" ? ' class="active"' : ""}>All (${total})</a>
    <a href="/blog?filter=drafts"${filter === "drafts" ? ' class="active"' : ""}>Drafts (${draftCount})</a>
  </div>`;
  const body = allRows === ""
    ? filter === "drafts"
      ? '<p class="idle">No drafts — every post is published. <a href="/blog">All posts</a></p>'
      : '<p class="idle">No posts found.</p>'
    : `<div class="table-scroll"><table class="blog-table data-cards">
        <thead><tr><th>File</th><th>Status</th><th>Last edited</th><th>Actions</th></tr></thead>
        <tbody>${allRows}</tbody>
      </table></div>`;

  const flashBanner = flash
    ? `<div class="blog-flash${flash.error ? " error" : ""}">${escapeHtml(flash.text)}</div>`
    : "";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@200;400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap">
  <title>claws — Blog</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${BLOG_CSS}
  .idle { color: var(--text-subtle); font-style: italic; }
  </style>
</head>
<body>
  ${buildPageHeader("Blog", theme, { current: "/blog", navCounts })}
  ${THEME_SCRIPT}
  ${flashBanner}
  <div class="blog-actions"><a href="/blog/edit?new=1">New post</a></div>
  ${filterBar}
  ${body}
</body>
</html>`;
}

/**
 * Line diff of a saved draft against the repo file it would
 * replace (`against`), or against an empty file when `against` is null.
 */
export function buildBlogDiffPage(
  draft: BlogDraftRow,
  against: { path: string } | null,
  diff: LineDiff,
  theme: Theme,
  stale?: StaleReason,
  navCounts?: NavCounts,
): string {
  const draftName = fileName(draft.path);
  const baseText = against
    ? `repo file <code>${escapeHtml(fileName(against.path))}</code>`
    : "an empty file (new post)";
  const prLink = draft.pr_number != null
    ? ` · <a href="${escapeHtml(prUrl(BLOG_REPO, draft.pr_number))}">PR #${draft.pr_number}</a>`
    : "";
  const staleBanner = stale
    ? `<div class="warning-banner" role="status">This saved draft is stale: ${escapeHtml(staleReasonText(stale, draft.pr_number))}.</div>`
    : "";
  let diffHtml: string;
  if ("tooLarge" in diff) {
    diffHtml = '<p class="idle">Too large to diff.</p>';
  } else if (diff.ops.every((o) => o.op === "same")) {
    diffHtml = '<p class="idle">No differences.</p>';
  } else {
    const sign = { same: " ", add: "+", del: "-" } as const;
    diffHtml = `<div class="blog-diff">${diff.ops
      .map((o) => `<div class="blog-diff-line ${o.op}">${sign[o.op]} ${escapeHtml(o.text)}</div>`)
      .join("")}</div>`;
  }

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@200;400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap">
  <title>claws — Blog draft diff</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${BLOG_CSS}
  .idle { color: var(--text-subtle); font-style: italic; }
  </style>
</head>
<body>
  ${buildPageHeader("Blog draft diff", theme, { current: "/blog", navCounts })}
  ${THEME_SCRIPT}
  ${staleBanner}
  <p>Saved draft <code>${escapeHtml(draftName)}</code> (edited ${formatRelativeTime(draft.updated_at)}) against ${baseText}${prLink}</p>
  <div class="blog-row-actions blog-toolbar"><a class="blog-action" href="/blog">← Back to list</a><a class="blog-action" href="${editHref(draft.path, !!stale)}">Edit</a>${discardForm(draft.path)}</div>
  ${diffHtml}
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

/** A saved draft behind the editor: `stale` is set when it is not live; `loaded` when its content is the one shown. */
export interface BlogEditDraftInfo {
  exists: boolean;
  stale?: { reason: StaleReason; loaded: boolean; prNumber?: number | null; noRepoFile?: boolean };
}

export function buildBlogEditPage(
  path: string,
  content: string,
  baseSha: string,
  isNew: boolean,
  theme: Theme,
  pr?: { number: number },
  flash?: { text: string; error?: boolean },
  navCounts?: NavCounts,
  draftInfo?: BlogEditDraftInfo,
): string {
  const pathField = isNew
    ? `<label>File path <input name="path" value="${escapeHtml(path || BLOG_CONTENT_DIR + "/")}" placeholder="${escapeHtml(BLOG_CONTENT_DIR)}/2026-07-03-my-slug.md" style="width:100%;font-family:monospace"></label><input type="hidden" name="new" value="1">`
    : `<input type="hidden" name="path" value="${escapeHtml(path)}">`;

  const textareaContent = isNew && content === "" ? NEW_POST_SKELETON : content;

  const prLink = pr
    ? ` · <a href="${escapeHtml(prUrl(BLOG_REPO, pr.number))}">PR #${pr.number}</a>`
    : "";

  const flashBanner = flash
    ? `<div class="blog-flash${flash.error ? " error" : ""}">${escapeHtml(flash.text)}</div>`
    : "";

  const draftActions = draftInfo?.exists && !isNew
    ? `<a class="blog-action" href="${diffHref(path)}">View diff</a>${discardForm(path)}`
    : "";

  let staleBanner = "";
  const stale = draftInfo?.stale;
  if (stale && !isNew) {
    const why = escapeHtml(staleReasonText(stale.reason, stale.prNumber ?? null));
    staleBanner = stale.loaded
      ? `<div class="warning-banner" role="status">Showing the stale saved draft (${why}). ${stale.noRepoFile
        ? "There is no file at this path in the blog repo."
        : `Push to PR will overwrite the newer repo text. <a href="${editHref(path)}">Show the repo version</a>`}</div>`
      : `<div class="warning-banner" role="status">A saved draft of this post is stale (${why}), so the editor shows the current repo version. <a href="${editHref(path, true)}">Load stale draft</a> · <a href="${diffHref(path)}">View diff</a></div>`;
  }

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@200;400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap">
  <title>claws — Edit blog post</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${BLOG_CSS}</style>
</head>
<body>
  ${buildPageHeader(isNew ? "New blog post" : "Edit blog post", theme, { current: "/blog", navCounts })}
  ${THEME_SCRIPT}
  ${flashBanner}
  ${staleBanner}
  <div class="blog-row-actions blog-toolbar"><span><a href="/blog">← Back to list</a>${prLink}</span>${draftActions}</div>
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
