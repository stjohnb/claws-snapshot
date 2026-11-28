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

import { Marked, type Token, type Tokens } from "marked";
import { ULID_BODY_PATTERN, canonicalIssueRef } from "./issue-id.js";

/**
 * Resolves an issue or PR reference in rendered text to the page it links to.
 * Keys are a canonical native id (`clw_…`), `owner/repo#N` or `#N`; an
 * unknown key returns undefined and the reference stays plain text.
 */
export interface IssueRefLinks {
  hrefFor(ref: string): string | undefined;
}

/** A reference found in raw markdown, before it is resolved. */
export type IssueRefCandidate =
  | { kind: "native"; id: string }
  | { kind: "forge"; repo: string | null; number: number };

/** `owner/repo#N`, `#clw_…`/`clw_…`, or `#N`, ending at a non-alphanumeric. */
const ISSUE_REF_SOURCE = `(?:((?<![\\w./-])[\\w.-]+\\/[\\w.-]+)#(\\d+)|#?([cC][lL][wW]_${ULID_BODY_PATTERN})|#(\\d+))(?![0-9A-Za-z])`;
const ISSUE_REF_AT_START = new RegExp(`^${ISSUE_REF_SOURCE}`);
/** Where a reference could begin — cuts the text run so the tokenizer gets a look. */
const ISSUE_REF_START = /(?<![\w./-])[\w.-]+\/[\w.-]+#\d|#?[cC][lL][wW]_|#\d/;
/** A character that, written just before a reference, makes it part of something else. */
const ISSUE_REF_BLOCKED_BEFORE = /[0-9A-Za-z_\/&#]$/;

function candidateFromMatch(m: RegExpExecArray): IssueRefCandidate {
  if (m[1]) return { kind: "forge", repo: m[1], number: Number(m[2]) };
  if (m[3]) return { kind: "native", id: canonicalIssueRef(m[3]) as string };
  return { kind: "forge", repo: null, number: Number(m[4]) };
}

/** The key {@link IssueRefLinks.hrefFor} is asked for. */
export function issueRefKey(ref: IssueRefCandidate): string {
  if (ref.kind === "native") return ref.id;
  return ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`;
}

/**
 * The distinct references in `md`, read from the raw text. It over-collects —
 * a ref inside code is included — since resolving only decides what may link.
 */
export function collectIssueRefs(md: string): IssueRefCandidate[] {
  const seen = new Map<string, IssueRefCandidate>();
  for (const m of md.matchAll(new RegExp(ISSUE_REF_SOURCE, "g"))) {
    const ref = candidateFromMatch(m as RegExpExecArray);
    seen.set(issueRefKey(ref), ref);
  }
  return [...seen.values()];
}

/**
 * The resolver for the `parse` call in progress. Extensions are fixed when the
 * renderer is built, so the per-request resolver is handed over here for the
 * duration of one synchronous parse; with none, the tokenizer always declines.
 */
let activeRefs: IssueRefLinks | undefined;

/** True while rendering a body with enough images that each becomes a linked thumbnail. */
let thumbImages = false;
/** True while rendering inside a link, so an image there is not wrapped in a second anchor. */
let insideLink = false;

/** More images than this in one body collapse into a gallery. */
const COLLAPSE_IMAGES_OVER = 3;

interface IssueRefToken extends Tokens.Generic {
  type: "issueRef";
  raw: string;
  href: string;
}

/** Turn issue refs back into text, so a ref in link text is not a nested anchor. */
function unlinkIssueRefs(tokens: Token[]): Token[] {
  return tokens.map((t): Token => {
    if (t.type === "issueRef") return { type: "text", raw: t.raw, text: t.raw, escaped: false };
    if ("tokens" in t && Array.isArray(t.tokens)) return { ...t, tokens: unlinkIssueRefs(t.tokens) } as Token;
    return t;
  });
}

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
      const wasInside = insideLink;
      insideLink = true;
      let inner: string;
      try {
        inner = this.parser.parseInline(unlinkIssueRefs(token.tokens ?? []));
      } finally {
        insideLink = wasInside;
      }
      if (!isSafeUrl(token.href ?? "")) return inner;
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      return `<a href="${attr(token.href)}"${title} rel="noopener noreferrer nofollow">${inner}</a>`;
    },
    image(token: Tokens.Image): string {
      const alt = escapeMarkdownHtml(token.text ?? "");
      if (!isSafeUrl(token.href ?? "")) return alt;
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      if (!thumbImages) return `<img src="${attr(token.href)}" alt="${alt}"${title}>`;
      const img = `<img class="md-thumb" src="${attr(token.href)}" alt="${alt}"${title} loading="lazy">`;
      if (insideLink) return img;
      return `<a href="${attr(token.href)}" rel="noopener noreferrer nofollow">${img}</a>`;
    },
  },
});

interface ImageGalleryToken extends Tokens.Generic {
  type: "imageGallery";
  raw: string;
  count: number;
  tokens: Token[];
}

renderer.use({
  extensions: [{
    name: "imageGallery",
    renderer(token: Tokens.Generic): string {
      const count = (token as ImageGalleryToken).count;
      const label = count === 1 ? "1 image" : `${count} images`;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this as unknown as { parser: { parseInline(t: Token[]): string } };
      return `<details class="image-gallery"><summary>${label}</summary><p class="image-gallery-grid">${self.parser.parseInline(token.tokens ?? [])}</p></details>\n`;
    },
  }],
});

renderer.use({
  extensions: [{
    name: "issueRef",
    level: "inline",
    start(src: string): number | undefined {
      if (!activeRefs) return undefined;
      const m = ISSUE_REF_START.exec(src);
      return m ? m.index : undefined;
    },
    tokenizer(src: string, tokens: Token[]): IssueRefToken | undefined {
      if (!activeRefs) return undefined;
      const m = ISSUE_REF_AT_START.exec(src);
      if (!m) return undefined;
      // `start` only cuts the text run; this is what keeps `foo#123`,
      // `&#123;` and `host/path#123` plain.
      const before = tokens.at(-1)?.raw ?? "";
      if (ISSUE_REF_BLOCKED_BEFORE.test(before)) return undefined;
      const href = activeRefs.hrefFor(issueRefKey(candidateFromMatch(m)));
      if (!href) return undefined;
      return { type: "issueRef", raw: m[0], href };
    },
    renderer(token: Tokens.Generic): string {
      return `<a href="${attr(token.href)}" class="issue-ref">${escapeMarkdownHtml(token.raw)}</a>`;
    },
  }],
});

/** Number of image tokens in `tokens`, nested ones included. */
function countImages(tokens: Token[]): number {
  let n = 0;
  renderer.walkTokens(tokens, (t) => {
    if (t.type === "image") n++;
  });
  return n;
}

/** Images in an image-only paragraph, or undefined when the paragraph holds anything else. */
function imageOnlyCount(token: Token): number | undefined {
  if (token.type !== "paragraph") return undefined;
  let n = 0;
  for (const t of (token as Tokens.Paragraph).tokens ?? []) {
    if (t.type === "image") n++;
    else if (t.type === "link") {
      const inner = (t as Tokens.Link).tokens ?? [];
      if (inner.length !== 1 || inner[0].type !== "image") return undefined;
      n++;
    } else if ((t.type === "text" || t.type === "br") && !t.raw.trim()) continue;
    else return undefined;
  }
  return n > 0 ? n : undefined;
}

/** Merge each run of image-only paragraphs holding more than the threshold into one gallery token. */
function groupImageRuns(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (imageOnlyCount(tokens[i]) === undefined) {
      out.push(tokens[i++]);
      continue;
    }
    const run: Token[] = [];
    let count = 0;
    let end = i;
    let j = i;
    while (j < tokens.length) {
      const n = imageOnlyCount(tokens[j]);
      if (n !== undefined) {
        run.push(tokens[j]);
        count += n;
        end = ++j;
      } else if (tokens[j].type === "space") j++;
      else break;
    }
    if (count > COLLAPSE_IMAGES_OVER) {
      const inline: Token[] = [];
      run.forEach((p, k) => {
        if (k > 0) inline.push({ type: "text", raw: " ", text: " ", escaped: false } as Token);
        inline.push(...((p as Tokens.Paragraph).tokens ?? []));
      });
      const raw = tokens.slice(i, end).map((t) => t.raw).join("");
      out.push({ type: "imageGallery", raw, count, tokens: inline } as ImageGalleryToken);
    } else {
      out.push(...tokens.slice(i, end));
    }
    i = end;
  }
  return out;
}

/**
 * Render GitHub-flavoured markdown to HTML that is safe to inline in a page.
 * With `opts.refs`, bare issue and PR references the resolver knows become
 * links; references in code or in link text are left alone. With
 * `opts.collapseImages`, a body holding more than three images shows each as a
 * linked thumbnail and folds runs of image-only paragraphs into a closed
 * "N images" disclosure.
 */
export function renderMarkdown(md: string, opts?: { refs?: IssueRefLinks; collapseImages?: boolean }): string {
  if (!md.trim()) return "";
  activeRefs = opts?.refs;
  try {
    if (!opts?.collapseImages) return renderer.parse(md, { async: false }) as string;
    const tokens = renderer.lexer(md);
    if (countImages(tokens) <= COLLAPSE_IMAGES_OVER) return renderer.parser(tokens);
    thumbImages = true;
    return renderer.parser(groupImageRuns(tokens));
  } finally {
    activeRefs = undefined;
    thumbImages = false;
    insideLink = false;
  }
}

/** Markdown punctuation that {@link plainExcerpt} escapes so its text renders literally. */
const MARKDOWN_PUNCTUATION = /[\\*_[\]<>#~|`]/g;

/** `s` with whitespace collapsed, cut at the last space within `max`, as escaped literal markdown. */
function plainExcerpt(s: string, max: number): string {
  const text = s.replace(/\s+/g, " ").trim();
  let kept = text;
  if (text.length > max) {
    const slice = text.slice(0, max);
    const space = slice.lastIndexOf(" ");
    kept = (space > 0 ? slice.slice(0, space) : slice).trimEnd();
  }
  return kept.replace(MARKDOWN_PUNCTUATION, (c) => `\\${c}`);
}

/** The smallest remaining budget, in characters, worth shortening a later block into. */
const MIN_SHORTENED_BLOCK = 40;

/** Inline token types {@link shortenInline} descends into, rewrapping the kept children in the token's own delimiters. */
const WRAPPER_INLINE = new Set(["strong", "em", "del", "link"]);

/** The plain text of `tokens` with all formatting stripped: leaf tokens' `text` concatenated. */
function flatText(tokens: readonly Token[]): string {
  let out = "";
  for (const t of tokens) {
    const g = t as Tokens.Generic;
    if (Array.isArray(g.tokens) && g.tokens.length > 0) out += flatText(g.tokens);
    else if (g.type === "br") out += " ";
    else out += typeof g.text === "string" ? g.text : g.raw;
  }
  return out;
}

/**
 * The leading inline `tokens` within `max` characters, as markdown that keeps
 * its formatting: whole tokens while they fit, then a plain-text run cut at a
 * space, or a bold, italic, strikethrough or link token shortened inside its
 * own delimiters. Stops at the first token that is cut or dropped.
 */
function shortenInline(tokens: readonly Token[], max: number): string {
  let out = "";
  for (const t of tokens) {
    if (out.length + t.raw.length <= max) {
      out += t.raw;
      continue;
    }
    const room = max - out.length;
    const g = t as Tokens.Generic;
    if (t.type === "text") {
      const slice = t.raw.slice(0, Math.max(0, room));
      const space = slice.lastIndexOf(" ");
      if (space > 0) out += slice.slice(0, space);
    } else if (WRAPPER_INLINE.has(t.type) && Array.isArray(g.tokens) && typeof g.text === "string" && g.text) {
      const at = t.raw.indexOf(g.text);
      if (at >= 0) {
        const prefix = t.raw.slice(0, at);
        const suffix = t.raw.slice(at + g.text.length);
        const inner = shortenInline(g.tokens, room - prefix.length - suffix.length).trim();
        if (inner) out += prefix + inner + suffix;
      }
    }
    break;
  }
  return out;
}

/**
 * A block that does not fit, shortened into `max` characters without cutting
 * through any markdown construct: a list keeps its leading whole items, a
 * paragraph its leading inline tokens with formatting kept (see
 * {@link shortenInline}) or else its plain text, a table becomes plain text
 * (cells joined with ` · `, rows with `; `), and anything else becomes escaped
 * plain text. With `later` (an earlier block was kept) a list whose first item
 * does not fit gives an empty string instead.
 */
function shortenBlock(token: Token, max: number, later = false): string {
  if (token.type === "list") {
    let out = "";
    for (const item of (token as Tokens.List).items) {
      if (out.length + item.raw.length > max) break;
      out += item.raw;
    }
    if (out.trim() || later) return out.trim() ? out.trimEnd() : "";
  } else if (token.type === "paragraph") {
    const inline = (token as Tokens.Paragraph).tokens ?? [];
    const out = shortenInline(inline, max);
    if (out.trim()) return out.trimEnd();
    return plainExcerpt(flatText(inline), max);
  } else if (token.type === "table") {
    const table = token as Tokens.Table;
    const row = (cells: Tokens.TableCell[]) => cells.map((c) => flatText(c.tokens).trim()).join(" · ");
    return plainExcerpt([table.header, ...table.rows].map(row).join("; "), max);
  }
  const t = token as Tokens.Generic;
  return plainExcerpt(typeof t.text === "string" ? t.text : t.raw, max);
}

/**
 * The start of `md`, at most about `max` characters of markdown, cut between
 * whole top-level blocks so no bold run, link or code fence is left half
 * open. The first block that does not fit is shortened into the budget left
 * (see {@link shortenBlock}) when it is the first block, or when it is a
 * paragraph or list with at least {@link MIN_SHORTENED_BLOCK} characters left;
 * otherwise it is dropped. Link definitions from the dropped part are appended
 * so reference-style links in the kept blocks resolve; they render nothing and
 * do not count against `max`. `cut` says whether any content was dropped; the
 * caller adds its own marker.
 */
export function markdownExcerpt(md: string, max: number): { markdown: string; cut: boolean } {
  const src = md.trim();
  if (src.length <= max) return { markdown: src, cut: false };
  const tokens = renderer.lexer(src);
  let out = "";
  let i = 0;
  for (; i < tokens.length; i++) {
    if (out.length + tokens[i].raw.length > max) break;
    out += tokens[i].raw;
  }
  const dropped = tokens.slice(i);
  const rest = dropped.filter((t) => t.type !== "space" && t.type !== "def");
  let markdown = out.trim();
  if (rest.length > 0) {
    if (!markdown) {
      markdown = shortenBlock(rest[0], max);
    } else {
      const remaining = max - markdown.length - 2;
      if (remaining >= MIN_SHORTENED_BLOCK && (rest[0].type === "paragraph" || rest[0].type === "list")) {
        const shortened = shortenBlock(rest[0], remaining, true);
        if (shortened) markdown += `\n\n${shortened}`;
      }
    }
  }
  const defs = dropped.filter((t) => t.type === "def").map((t) => t.raw.trim());
  if (defs.length > 0) markdown += `${markdown ? "\n\n" : ""}${defs.join("\n")}`;
  return { markdown, cut: rest.length > 0 };
}
