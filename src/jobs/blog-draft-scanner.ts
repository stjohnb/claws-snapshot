import type { Repo } from "../config.js";
import { hasBlogDraftPortFiled, recordBlogDraftPortFiled } from "../db.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { mapSettledWithConcurrency } from "../util.js";
import { guardContent } from "../prompt-guard.js";
import { BLOG_REPO, BLOG_CONTENT_DIR } from "../pages/blog.js";

const NAME = "blog-draft-scanner";
const CANDIDATE_DIRS = ["docs", "ideas", "drafts", "docs/blog-drafts", "blog-drafts"] as const;
const ALWAYS_DRAFT_DIRS = ["drafts", "docs/blog-drafts", "blog-drafts"] as const;
const REPO_CONCURRENCY = 4;
const MIN_BODY_CHARS = 1500;
const MIN_PROSE_PARAGRAPHS = 5;
const PROSE_PARAGRAPH_CHARS = 200;
const EXCERPT_CHARS = 800;

export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractFrontmatterTitle(content: string): string | null {
  if (!content.startsWith("---\n")) return null;

  const lines = content.split("\n");
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) return null;

  const frontmatterBlock = lines.slice(1, closingIndex).join("\n");
  const match = frontmatterBlock.match(/^title:\s*(.+)$/m);
  if (!match) return null;

  let title = match[1]!.trim();
  if (
    (title.startsWith("'") && title.endsWith("'") && title.length >= 2) ||
    (title.startsWith('"') && title.endsWith('"') && title.length >= 2)
  ) {
    title = title.slice(1, -1);
  }
  return title;
}

export function extractDraftTitle(content: string): string | null {
  const frontmatterTitle = extractFrontmatterTitle(content);
  if (frontmatterTitle) return frontmatterTitle;

  const body = stripFrontmatter(content);
  const match = body.match(/^#\s+(.+)$/m);
  if (match) return match[1]!.trim();

  return null;
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;

  const lines = content.split("\n");
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) return content;

  return lines.slice(closingIndex + 1).join("\n");
}

export function looksLikeDraftPost(body: string): boolean {
  if (body.length < MIN_BODY_CHARS) return false;

  const blocks = body.split(/\n\s*\n/);
  let proseParagraphs = 0;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length < PROSE_PARAGRAPH_CHARS) continue;
    if (/^[-*#|>`]/.test(trimmed)) continue;
    if (/^\d+\./.test(trimmed)) continue;
    proseParagraphs++;
  }

  return proseParagraphs >= MIN_PROSE_PARAGRAPHS;
}

export function isCandidateFile(dir: string, fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(".md") && !lower.endsWith(".mdx")) return false;
  if (lower === "readme.md") return false;
  if (lower.includes("idea") || lower.includes("template")) return false;

  if ((ALWAYS_DRAFT_DIRS as readonly string[]).includes(dir)) return true;
  return lower.startsWith("blog");
}

export function buildPortIssueTitle(title: string, sourceRepo: string): string {
  return `[blog-port] ${title} (${sourceRepo})`;
}

export function buildPortIssueBody(args: {
  sourceRepo: string;
  path: string;
  title: string;
  excerpt: string;
  suggestedFile: string;
}): string {
  const { sourceRepo, path, title, excerpt, suggestedFile } = args;
  const today = new Date().toISOString().slice(0, 10);
  const excerptBlock = excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return [
    "A draft blog post lives in another repo and has not been published here yet.",
    "",
    `**Source:** \`${sourceRepo}\` → \`${path}\``,
    `**Link:** https://github.com/${sourceRepo}/blob/HEAD/${path}`,
    `**Detected title:** ${title}`,
    `**Suggested target:** \`${suggestedFile}\``,
    "",
    "## Port it",
    "",
    "1. Fetch the draft (the Claws GitHub App can read the source repo):",
    "",
    "   ```",
    `   gh api repos/${sourceRepo}/contents/${path} \\`,
    `     --jq .content | base64 -d > ${suggestedFile}`,
    "   ```",
    "",
    "2. Add or fix the frontmatter to match this repo's schema:",
    "",
    "   ```yaml",
    "   ---",
    `   title: '${title}'`,
    `   pubDate: ${today}`,
    "   description: ''",
    "   author: 'Brendan St. John'",
    "   tags: []",
    "   ---",
    "   ```",
    "",
    "   Keep `pubDate` as the intended publication date and write a one-sentence `description`.",
    "",
    "3. Fix relative links and image paths — a draft written in another repo will",
    "   reference paths that do not resolve here. Move any referenced images into this",
    "   repo's blog assets directory and update the `image`/`imageAlt` frontmatter and",
    "   inline image paths accordingly.",
    "4. Leave the source file in place; Claws will not re-file this issue for it.",
    "",
    "## Excerpt",
    "",
    excerptBlock,
  ].join("\n");
}

export interface PublishedIndex {
  titles: Set<string>;
  slugs: Set<string>;
}

export async function loadPublishedIndex(): Promise<PublishedIndex | null> {
  const entries = await gh.listRepoDirectory(BLOG_REPO, BLOG_CONTENT_DIR);
  const files = entries.filter(
    (e) => e.type === "file" && (e.name.toLowerCase().endsWith(".md") || e.name.toLowerCase().endsWith(".mdx")),
  );
  if (files.length === 0) return null;

  const titles = new Set<string>();
  const slugs = new Set<string>();

  for (const entry of files) {
    const content = await gh.fetchRepoFileContent(BLOG_REPO, entry.path);
    if (content !== null) {
      const title = extractFrontmatterTitle(content);
      if (title) titles.add(normalizeTitle(title));
    }

    const baseName = entry.name.replace(/\.mdx?$/i, "");
    const slug = baseName.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    slugs.add(slug);
  }

  return { titles, slugs };
}

export function isAlreadyPublished(title: string, fileName: string, index: PublishedIndex): boolean {
  if (index.titles.has(normalizeTitle(title))) return true;
  if (index.slugs.has(slugify(title))) return true;

  const baseName = fileName.replace(/\.mdx?$/i, "").replace(/^blog[-_]/i, "");
  const fileBaseSlug = slugify(baseName);
  if (index.slugs.has(fileBaseSlug)) return true;

  return false;
}

async function processRepo(repo: Repo, index: PublishedIndex): Promise<void> {
  for (const dir of CANDIDATE_DIRS) {
    const entries = await gh.listRepoDirectory(repo.fullName, dir);
    const files = entries.filter((e) => e.type === "file" && isCandidateFile(dir, e.name));

    for (const entry of files) {
      try {
        if (hasBlogDraftPortFiled(repo.fullName, entry.path)) continue;

        const content = await gh.fetchRepoFileContent(repo.fullName, entry.path);
        if (content === null) continue;

        const rawTitle = extractDraftTitle(content);
        if (!rawTitle) continue;
        const title = rawTitle.replace(/\s+/g, " ").trim().slice(0, 120);

        const body = stripFrontmatter(content);
        if (!looksLikeDraftPost(body)) continue;

        if (isAlreadyPublished(title, entry.name, index)) continue;

        const guardedTitle = guardContent(title, {
          repo: repo.fullName,
          source: "blog draft title",
          itemNumber: 0,
        });
        const issueTitle = buildPortIssueTitle(guardedTitle, repo.fullName);

        const existing = await gh.findIssueByExactTitle(BLOG_REPO, issueTitle);
        if (existing) {
          recordBlogDraftPortFiled(repo.fullName, entry.path, existing.number);
          continue;
        }

        const today = new Date().toISOString().slice(0, 10);
        const suggestedFile = `${BLOG_CONTENT_DIR}/${today}-${slugify(title)}.md`;
        const excerpt = guardContent(body.slice(0, EXCERPT_CHARS), {
          repo: repo.fullName,
          source: "blog draft body",
          itemNumber: 0,
        });
        const issueBody = buildPortIssueBody({
          sourceRepo: repo.fullName,
          path: entry.path,
          title: guardedTitle,
          excerpt: excerpt + (body.length > EXCERPT_CHARS ? "…" : ""),
          suggestedFile,
        });

        const issueNumber = await gh.createIssue(BLOG_REPO, issueTitle, issueBody, []);
        recordBlogDraftPortFiled(repo.fullName, entry.path, issueNumber);
        log.info(`[${NAME}] ${repo.fullName}: filed blog port issue for "${title}" as ${BLOG_REPO}#${issueNumber}`);
      } catch (err) {
        log.warn(`[${NAME}] ${repo.fullName}: failed to process "${entry.path}": ${err}`);
      }
    }
  }
}

export async function run(repos: Repo[]): Promise<void> {
  const index = await loadPublishedIndex();
  if (!index) {
    log.warn(`[${NAME}] published post index is empty — skipping run to avoid duplicate port issues`);
    return;
  }

  const targets = repos.filter((r) => r.fullName !== BLOG_REPO);
  await mapSettledWithConcurrency(targets, REPO_CONCURRENCY, async (repo) => {
    try {
      await processRepo(repo, index);
    } catch (err) {
      await reportError(`${NAME}:process-repo`, repo.fullName, err);
    }
  });
}
