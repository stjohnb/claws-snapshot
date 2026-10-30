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
