import { hasItemRef, type IssueRef } from "./issue-id.js";
import { issueUrl, webUrlForRepo, isManagedRepo, SELF_REPO, LABELS } from "./config.js";
import * as slack from "./slack.js";
import * as log from "./log.js";
import type { JudgeResult } from "./prompt-guard-judge.js";

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
    // "override" + instructions/guidelines is never ordinary technical prose.
    name: "instruction-override:override-instructions",
    regex: /override\s+(?:(?:all|your|the|these|previous|prior|above)\s+)*(?:instructions|guidelines)/gi,
  },
  {
    // #2526: "rules" is an overloaded technical noun (udev rules, eslint rules,
    // firewall rules, sops creation rules), so require the same explicit
    // possessive/prior anchor the ignore-/disregard-previous siblings use.
    // Bare "override rules" false-positived on nixos-config#236
    // ("Ship a small override rules file ordered after 99-asi.rules").
    name: "instruction-override:override-rules",
    regex: /override\s+(?:all\s+)?(?:your|these|my|the\s+(?:previous|prior|above|system)|previous|prior|above)\s+rules/gi,
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
 * issue. That issue carries the Claws marker, so on later planning/implementing
 * passes it is read back through formatIssueCommentsForPrompt() WITHOUT re-guarding
 * (self-authored comments are trusted). Quoting the raw span verbatim re-introduces the
 * attacker's bytes into a tool-enabled agent — most acutely for the
 * suspicious-markdown:html-comment-injection pattern, whose span is a full <!-- ... -->
 * block that can carry a real directive. Zero-width breaks keep the phrase human-readable
 * in the alert while making it non-parseable as an HTML comment and non-matchable as an
 * instruction if it is ever read back.
 *
 * Exported for any other builder of a Claws-authored body that has to embed an
 * untrusted string verbatim (e.g. third-party names or identifiers), where redaction would destroy the value the reader needs.
 */
export function defangPhrase(phrase: string): string {
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

interface DetectionContext {
  repo: string;
  source: string;
  itemNumber: IssueRef;
}

const MAX_MATCHES_SHOWN = 5;
const MAX_PHRASE_LEN = 200;
const MAX_ALERT_BODY_LEN = 20_000;
const BODY_CAP_TRAILER = "_Further detections are counted in Occurrences but not listed._";

const ALERT_INTRO = [
  "Claws scanned content before sending it to the AI model and found text matching prompt-injection patterns. The matched spans were **redacted** before reaching the model, so no instruction smuggling actually occurred.",
  "",
  "If a flagged item is legitimate (e.g. quoting an injection example in documentation or test output), close this issue once reviewed. If it was unintended, edit the source so future runs aren't redacted. Repeat detections of an already-listed item only raise Occurrences.",
].join("\n");

function formatDetectionItem(ctx: DetectionContext): string {
  if (ctx.repo.includes("/")) {
    if (hasItemRef(ctx.itemNumber)) return `[${ctx.repo} #${ctx.itemNumber}](${issueUrl(ctx.repo, ctx.itemNumber)})`;
    return `[${ctx.repo} repo-level content](${webUrlForRepo(ctx.repo)})`;
  }
  return `${ctx.repo} #${ctx.itemNumber}`;
}

/**
 * One alert-issue entry for a detection. Carries no timestamp, so identical
 * detections compare equal and {@link appendDetectionEntry} can skip repeats.
 * Every quoted phrase goes through {@link defangPhrase}.
 */
export function formatDetectionEntry(
  ctx: DetectionContext,
  score: number,
  patternNames: string[],
  matches: ScanMatch[],
): string {
  const shown = matches.slice(0, MAX_MATCHES_SHOWN);
  const remaining = matches.length - shown.length;

  const phraseSections = shown.map((m) => {
    let phrase = m.matched;
    if (phrase.length > MAX_PHRASE_LEN) phrase = phrase.slice(0, MAX_PHRASE_LEN) + "…";
    phrase = defangPhrase(phrase);
    const fence = "`".repeat(Math.max(3, (phrase.match(/`+/g) ?? []).reduce((mx, s) => Math.max(mx, s.length), 0) + 1));
    return [
      `Pattern \`${m.pattern}\` at offset ${m.index} (${m.length} chars):`,
      ``,
      fence,
      phrase,
      fence,
    ].join("\n");
  });

  const trailer = remaining > 0 ? `\n_(+${remaining} additional match${remaining === 1 ? "" : "es"} not shown)_` : "";

  return [
    `#### Detection: ${formatDetectionItem(ctx)}`,
    ``,
    `- **Source field:** \`${ctx.source}\``,
    `- **Patterns:** ${patternNames.map((p) => `\`${p}\``).join(", ")}`,
    `- **Score:** ${score}`,
    ``,
    phraseSections.join("\n\n"),
    trailer,
  ].join("\n").trimEnd();
}

/** The body a first detection files the alert issue with. */
export function freshDetectionBody(entry: string): string {
  return [ALERT_INTRO, "", "### Detections", "", entry].join("\n");
}

/**
 * Add `entry` to an alert body unless it is already listed. Past
 * {@link MAX_ALERT_BODY_LEN} characters no entry is added; a one-off trailer
 * says further detections are only counted.
 */
export function appendDetectionEntry(currentBody: string, entry: string): string {
  if (currentBody.includes(entry)) return currentBody;
  if (currentBody.length > MAX_ALERT_BODY_LEN) {
    return currentBody.includes(BODY_CAP_TRAILER) ? currentBody : `${currentBody}\n\n${BODY_CAP_TRAILER}`;
  }
  return `${currentBody}\n\n${entry}`;
}

async function fileDetectionAlert(
  context: DetectionContext,
  score: number,
  patternNames: string[],
  matches: ScanMatch[],
  alertMsg: string,
): Promise<void> {
  try {
    // Dynamic: forgejo.ts imports this module, so a static import of
    // occurrence-tracking → github → forgejo would cycle.
    const { ensureAlertIssue } = await import("./occurrence-tracking.js");
    const repo = context.repo.includes("/") && isManagedRepo(context.repo) ? context.repo : SELF_REPO;
    const entry = formatDetectionEntry(context, score, patternNames, matches);
    const { outcome, issueNumber } = await ensureAlertIssue({
      repo,
      title: `[prompt-injection] Potential prompt injection detected in ${context.repo}`,
      body: freshDetectionBody(entry),
      updateBody: (cur) => appendDetectionEntry(cur, entry),
      labels: [LABELS.blocked],
      blockedReason:
        "Prompt-guard detections need a human to review the flagged items; there is nothing for Claws to implement.",
      logPrefix: "prompt-guard",
    });
    if (outcome === "created") {
      void slack.notify(
        `:rotating_light: ${alertMsg} — review the item before trusting its author; tracked in ${issueUrl(repo, issueNumber)}`,
      );
    }
  } catch (err) {
    log.warn(`[prompt-guard] failed to file injection alert for ${context.repo}: ${err}`);
  }
}

export function makeGuardCtx(repo: string, itemNumber: IssueRef): (source: string) => { repo: string; source: string; itemNumber: IssueRef } {
  return (source: string) => ({ repo, source, itemNumber });
}

export async function formatGuardedTitleList(
  titles: string[],
  guardCtx: ReturnType<typeof makeGuardCtx>,
  source: string,
): Promise<string> {
  if (titles.length === 0) return "  (none)";
  const guarded = await Promise.all(titles.map((t) => guardContent(t, guardCtx(source))));
  return guarded.map((t) => `  - ${t}`).join("\n");
}

export async function guardContent(text: string, context: { repo: string; source: string; itemNumber: IssueRef }): Promise<string>;
export async function guardContent(text: string | null | undefined, context: { repo: string; source: string; itemNumber: IssueRef }): Promise<string | null | undefined>;
export async function guardContent(
  text: string | null | undefined,
  context: { repo: string; source: string; itemNumber: IssueRef },
): Promise<string | null | undefined> {
  if (!text) return text;

  const result = scanContent(text);
  if (result.score < 10) return text;

  // Second stage: a Haiku judge decides which hits are directives aimed at the
  // agent. Dynamic: prompt-guard-judge imports claude.ts, which imports this module.
  let matches = result.matches;
  let verdict: JudgeResult;
  try {
    const { judgeMatches } = await import("./prompt-guard-judge.js");
    verdict = await judgeMatches({ text, matches, source: context.source });
  } catch (err) {
    verdict = { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (verdict.kind === "judged") {
    matches = matches.filter((_, i) => verdict.directive[i] !== false);
    if (matches.length === 0) {
      const cleared = [...new Set(result.matches.map((m) => m.pattern))];
      log.info(
        `[prompt-guard] judge cleared ${result.matches.length} regex hit(s) in ${context.repo} ${context.source} #${context.itemNumber}: patterns=[${cleared.join(", ")}]`,
      );
      return text;
    }
  } else {
    log.warn(
      `[prompt-guard] judge unavailable (${verdict.reason}) for ${context.repo} ${context.source} #${context.itemNumber} — redacting and filing`,
    );
  }
  const score = matches.length * 10;

  // Merge overlapping/contained spans before redacting
  const sorted = [...matches].sort((a, b) => a.index - b.index || b.length - a.length);
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

  const patternNames = [...new Set(matches.map((m) => m.pattern))];
  const itemUrl =
    context.repo.includes("/") && hasItemRef(context.itemNumber)
      // `issueUrl`, not a hard-coded github.com path: a native issue lives on
      // the dashboard and a Forgejo issue on the Forgejo host, so the literal
      // form put a 404 in the Slack alert for both.
      ? ` ${issueUrl(context.repo, context.itemNumber)}`
      : "";
  const alertMsg =
    `Prompt injection detected in ${context.repo} ${context.source} #${context.itemNumber}: ` +
    `score=${score}, patterns=[${patternNames.join(", ")}]${itemUrl}`;

  log.warn(`[prompt-guard] ${alertMsg}`);

  void fileDetectionAlert(context, score, patternNames, matches, alertMsg);

  return sanitized;
}
