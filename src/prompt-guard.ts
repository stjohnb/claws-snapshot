import * as slack from "./slack.js";
import * as log from "./log.js";

const POSTED_COMMENTS = new Set<string>();

/** Test-only: reset the dedup set between test cases. */
export function __resetPostedCommentsForTests(): void {
  POSTED_COMMENTS.clear();
}

export interface ScanMatch {
  pattern: string;
  matched: string;
  index: number;
  length: number;
}

export interface ScanResult {
  score: number;
  matches: ScanMatch[];
}

interface PatternDef {
  name: string;
  regex: RegExp;
}

const INSTRUCTION_OVERRIDE_PATTERNS: PatternDef[] = [
  {
    name: "instruction-override:ignore-previous",
    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/gi,
  },
  {
    name: "instruction-override:disregard-previous",
    regex: /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|guidelines|context|prompts)/gi,
  },
  {
    name: "instruction-override:you-are-now",
    // Require the article to be followed (within a few words) by a role/persona noun
    // typical of jailbreaks. This avoids false positives on legitimate phrases like
    // "you are now a contributor" or "you are now the owner of this module".
    regex: /you\s+are\s+now\s+(?:a|an|my|the)\s+(?:\w+\s+){0,3}(?:assistant|agent|AI|bot|model|persona|character|system|chatbot|DAN)\b/gi,
  },
  {
    name: "instruction-override:from-now-on",
    regex: /from\s+now\s+on\s+you\s+(are|will|must|should)/gi,
  },
  {
    name: "instruction-override:system-prompt",
    // Negative lookbehind rejects mid-sentence uses like "Add system prompt: retry on timeout"
    // while still catching standalone injection attempts at start of line/sentence.
    // Uses [ \t] instead of \s so that a newline after a word doesn't bypass the check.
    regex: /(?<!\w[ \t])(?:system\s+prompt|system\s+message|new\s+instructions)\s*:/gi,
  },
  {
    name: "instruction-override:forget-everything",
    regex: /forget\s+(everything|all\s+your\s+instructions|your\s+(?:instructions|rules|guidelines|programming|training))/gi,
  },
  {
    name: "instruction-override:pretend",
    regex: /(?:pretend\s+(?:you\s+are|to\s+be)|act\s+as\s+if)/gi,
  },
  {
    name: "instruction-override:override-instructions",
    regex: /override\s+(?:your\s+|the\s+)?(?:instructions|rules|guidelines)/gi,
  },
];

const ZERO_WIDTH_PATTERN: PatternDef = {
  name: "encoded-payload:zero-width-chars",
  regex: /[\u200B\u200C\u200D\uFEFF]{5,}/g,
};

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

// Derive keyword regex from the main pattern set so they never diverge.
// We strip negative lookaheads and lookbehinds (which only make sense in full-text
// scanning) to produce a lightweight "contains any instruction-like phrase" check.
// NOTE: The strip-lookarounds regex assumes no `)` inside lookaround groups.
// If a future pattern uses `)` within a lookaround (e.g. `(?<!foo\)bar)`), the
// stripping will break. Keep lookaround bodies simple or update the strip regex.
const INSTRUCTION_KEYWORDS_REGEX = new RegExp(
  INSTRUCTION_OVERRIDE_PATTERNS.map((p) =>
    p.regex.source.replace(/\(\?<?![^)]*\)/g, ""),
  ).join("|"),
  "i",
);

// Sanity check: verify no leftover lookaround syntax after stripping
if (/\(\?<?[!=]/.test(INSTRUCTION_KEYWORDS_REGEX.source)) {
  throw new Error(
    "INSTRUCTION_KEYWORDS_REGEX contains leftover lookaround syntax after stripping — " +
      "a pattern likely has `)` inside a lookaround group. Fix the strip regex or simplify the pattern.",
  );
}

const BASE64_BLOCK_REGEX = /[A-Za-z0-9+/]{40,}={0,2}/g;

export function scanContent(text: string): ScanResult {
  const matches: ScanMatch[] = [];

  // 1. Instruction override patterns
  for (const pat of INSTRUCTION_OVERRIDE_PATTERNS) {
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.regex.exec(text)) !== null) {
      matches.push({
        pattern: pat.name,
        matched: m[0],
        index: m.index,
        length: m[0].length,
      });
    }
  }

  // 2. Zero-width character sequences
  ZERO_WIDTH_PATTERN.regex.lastIndex = 0;
  let zwm: RegExpExecArray | null;
  while ((zwm = ZERO_WIDTH_PATTERN.regex.exec(text)) !== null) {
    matches.push({
      pattern: ZERO_WIDTH_PATTERN.name,
      matched: zwm[0],
      index: zwm.index,
      length: zwm[0].length,
    });
  }

  // 3. HTML comments with instruction-like content
  HTML_COMMENT_REGEX.lastIndex = 0;
  let hm: RegExpExecArray | null;
  while ((hm = HTML_COMMENT_REGEX.exec(text)) !== null) {
    const commentContent = hm[0].slice(4, -3); // strip <!-- and -->
    if (INSTRUCTION_KEYWORDS_REGEX.test(commentContent)) {
      matches.push({
        pattern: "suspicious-markdown:html-comment-injection",
        matched: hm[0],
        index: hm.index,
        length: hm[0].length,
      });
    }
  }

  // 4. Base64-encoded instruction payloads
  BASE64_BLOCK_REGEX.lastIndex = 0;
  let bm: RegExpExecArray | null;
  while ((bm = BASE64_BLOCK_REGEX.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(bm[0], "base64").toString("utf-8");
      // Only flag if decoded text is mostly printable ASCII and contains instruction keywords
      if (/^[\x20-\x7E\n\r\t]+$/.test(decoded) && INSTRUCTION_KEYWORDS_REGEX.test(decoded)) {
        matches.push({
          pattern: "encoded-payload:base64-instructions",
          matched: bm[0],
          index: bm.index,
          length: bm[0].length,
        });
      }
    } catch {
      // Not valid base64, skip
    }
  }

  const score = matches.length * 10;
  return { score, matches };
}

/**
 * Defang a matched injection span before quoting it in the Claws-authored alert
 * comment. That comment carries the Claws marker, so on later planning/implementing
 * passes it is read back through formatIssueCommentsForPrompt() WITHOUT re-guarding
 * (self-authored comments are trusted). Quoting the raw span verbatim re-introduces the
 * attacker's bytes into a tool-enabled agent — most acutely for the
 * suspicious-markdown:html-comment-injection pattern, whose span is a full <!-- ... -->
 * block that can carry a real directive. Zero-width breaks keep the phrase human-readable
 * in the alert while making it non-parseable as an HTML comment and non-matchable as an
 * instruction if it is ever read back.
 */
function defangPhrase(phrase: string): string {
  const ZWSP = "\u200B";
  // 1. Break HTML-comment structure so it can't re-parse as <!-- ... -->.
  let out = phrase.replace(/<!--/g, `<${ZWSP}!--`).replace(/-->/g, `--${ZWSP}>`);
  // 2. Break instruction trigger words: insert a zero-width space after the first
  //    character. Reads normally to a human; no longer a clean instruction token to a
  //    scanner or an LLM.
  out = out.replace(
    /\b(ignore|disregard|forget|override|pretend|system|instruction|instructions|prompt|assistant|now)/gi,
    (w) => w[0] + ZWSP + w.slice(1),
  );
  return out;
}

function formatInjectionComment(
  source: string,
  score: number,
  patternNames: string[],
  matches: ScanMatch[],
): string {
  const MAX_MATCHES_SHOWN = 5;
  const MAX_PHRASE_LEN = 200;
  const shown = matches.slice(0, MAX_MATCHES_SHOWN);
  const remaining = matches.length - shown.length;

  const phraseSections = shown.map((m, i) => {
    let phrase = m.matched;
    if (phrase.length > MAX_PHRASE_LEN) phrase = phrase.slice(0, MAX_PHRASE_LEN) + "…";
    phrase = defangPhrase(phrase);
    const fence = "`".repeat(Math.max(3, (phrase.match(/`+/g) ?? []).reduce((mx, s) => Math.max(mx, s.length), 0) + 1));
    return [
      `**${i + 1}.** Pattern \`${m.pattern}\` at offset ${m.index} (${m.length} chars):`,
      ``,
      `${fence}`,
      phrase,
      `${fence}`,
    ].join("\n");
  });

  const trailer = remaining > 0 ? `\n_(+${remaining} additional match${remaining === 1 ? "" : "es"} not shown)_` : "";

  return [
    `## ⚠️ Potential prompt injection detected`,
    ``,
    `Claws scanned content from this item before sending it to the AI model and found text matching prompt-injection patterns. The matched spans were **redacted** before reaching the model, so no instruction smuggling actually occurred.`,
    ``,
    `- **Source field:** \`${source}\``,
    `- **Patterns matched:** ${patternNames.map((p) => `\`${p}\``).join(", ")}`,
    `- **Score:** ${score}`,
    ``,
    `### Matched phrase${shown.length === 1 ? "" : "s"}`,
    ``,
    phraseSections.join("\n\n"),
    trailer,
    ``,
    `If this content is legitimate (e.g. quoting an injection example in documentation), no action is needed. If it was unintended, please edit the source so future runs aren't redacted.`,
  ].join("\n");
}

async function postInjectionComment(
  repo: string,
  itemNumber: number,
  body: string,
): Promise<void> {
  try {
    const gh = await import("./github.js");
    await gh.commentOnIssue(repo, itemNumber, body, { agentName: "prompt-guard" });
  } catch (err) {
    log.warn(`[prompt-guard] failed to post injection comment on ${repo}#${itemNumber}: ${err}`);
  }
}

export function makeGuardCtx(repo: string, itemNumber: number): (source: string) => { repo: string; source: string; itemNumber: number } {
  return (source: string) => ({ repo, source, itemNumber });
}

export function formatGuardedTitleList(
  titles: string[],
  guardCtx: ReturnType<typeof makeGuardCtx>,
  source: string,
): string {
  if (titles.length === 0) return "  (none)";
  return titles.map((t) => `  - ${guardContent(t, guardCtx(source))}`).join("\n");
}

export function guardContent(text: string, context: { repo: string; source: string; itemNumber: number }): string;
export function guardContent(text: string | null | undefined, context: { repo: string; source: string; itemNumber: number }): string | null | undefined;
export function guardContent(
  text: string | null | undefined,
  context: { repo: string; source: string; itemNumber: number },
): string | null | undefined {
  if (!text) return text;

  const result = scanContent(text);
  if (result.score < 10) return text;

  // Merge overlapping/contained spans before redacting
  const sorted = [...result.matches].sort((a, b) => a.index - b.index || b.length - a.length);
  const merged: Array<{ index: number; length: number }> = [];
  for (const m of sorted) {
    const last = merged[merged.length - 1];
    if (last && m.index < last.index + last.length) {
      // Overlapping or contained — extend the existing span if needed
      const end = Math.max(last.index + last.length, m.index + m.length);
      last.length = end - last.index;
    } else {
      merged.push({ index: m.index, length: m.length });
    }
  }

  // Replace merged spans from end to start to preserve indices.
  // Note: each redaction marker is 48 chars, so many small matches could inflate
  // text size. Callers that truncate after guarding should be aware of this.
  let sanitized = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const span = merged[i];
    sanitized =
      sanitized.slice(0, span.index) +
      "[content redacted — potential prompt injection]" +
      sanitized.slice(span.index + span.length);
  }

  const patternNames = [...new Set(result.matches.map((m) => m.pattern))];
  const itemUrl =
    context.repo.includes("/") && context.itemNumber > 0
      ? ` https://github.com/${context.repo}/issues/${context.itemNumber}`
      : "";
  const alertMsg =
    `Prompt injection detected in ${context.repo} ${context.source} #${context.itemNumber}: ` +
    `score=${result.score}, patterns=[${patternNames.join(", ")}]${itemUrl}`;

  log.warn(`[prompt-guard] ${alertMsg}`);
  slack.notify(alertMsg);

  if (context.repo.includes("/") && context.itemNumber > 0) {
    const key = `${context.repo}#${context.itemNumber}`;
    if (!POSTED_COMMENTS.has(key)) {
      POSTED_COMMENTS.add(key);
      const commentBody = formatInjectionComment(
        context.source,
        result.score,
        patternNames,
        result.matches,
      );
      void postInjectionComment(context.repo, context.itemNumber, commentBody);
    }
  }

  return sanitized;
}
