/**
 * Server-side markdown rendering for Claws-native issue bodies and comments.
 *
 * The dashboard renders issue text written by humans *and* by agents, so the
 * output has to be safe without a DOM sanitiser: DOMPurify needs a browser (or
 * jsdom in the request path), which this process does not have. Instead the
 * renderer is locked down at the source — raw HTML is escaped rather than
 * passed through, and any link or image target whose scheme is not `http:`,
 * `https:` or `mailto:` is dropped. A target with no scheme at all is
 * relative and kept. A hostile issue body can then only produce text.
 */

import { Marked, type Tokens } from "marked";

/** Schemes a link or image target may carry. A relative target has none. */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** True when a link or image target survives rendering. */
function isSafeUrl(raw: string): boolean {
  // Whitespace and control characters go first: a browser reads
  // `java\tscript:alert(1)` as the javascript scheme, and a naive prefix test
  // does not.
  const href = raw.replace(/[\u0000-\u0020\u007f]/g, "");
  if (!href) return false;
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/.exec(href);
  return scheme ? ALLOWED_SCHEMES.has(scheme[0].toLowerCase()) : true;
}

export function escapeMarkdownHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Escaped attribute value; `href`/`src` are checked by {@link isSafeUrl} first. */
function attr(value: string): string {
  return escapeMarkdownHtml(value);
}

const renderer = new Marked({ gfm: true });

renderer.use({
  renderer: {
    // Raw HTML in the source — block and inline alike — is shown as text.
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeMarkdownHtml(token.raw ?? token.text ?? "");
    },
    link(token: Tokens.Link): string {
      const inner = this.parser.parseInline(token.tokens ?? []);
      if (!isSafeUrl(token.href ?? "")) return inner;
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      return `<a href="${attr(token.href)}"${title} rel="noopener noreferrer nofollow">${inner}</a>`;
    },
    image(token: Tokens.Image): string {
      const alt = escapeMarkdownHtml(token.text ?? "");
      if (!isSafeUrl(token.href ?? "")) return alt;
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      return `<img src="${attr(token.href)}" alt="${alt}"${title}>`;
    },
  },
});

/** Render GitHub-flavoured markdown to HTML that is safe to inline in a page. */
export function renderMarkdown(md: string): string {
  if (!md.trim()) return "";
  return renderer.parse(md, { async: false }) as string;
}
