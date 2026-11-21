// Classifies a Claude Code session's visible screen (the text of
// `GET /sessions/:id/screen`) for the session page's chat view
// (#clw_01M7DYJ0WVGSM09PFTBS3HXDB3): is Claude waiting on a terminal-only
// prompt, busy working, or idle at its input box? Pure: no DOM, no I/O.

export type ClaudeScreenState = "waiting" | "busy" | "idle";

/** How many of the screen's last non-blank lines are checked. */
export const SCREEN_TAIL_LINES = 20;

// CSI sequences (SGR colours included) and OSC sequences ending in BEL or ST.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b[@-_]/g;

/** `text` with terminal escape sequences removed. */
export function stripAnsi(text: string): string {
  return text.replace(OSC, "").replace(CSI, "").replace(OTHER_ESC, "");
}

/** The last `SCREEN_TAIL_LINES` lines of the screen, after trailing blank lines are dropped. */
export function screenTail(text: string): string[] {
  return screenLines(text).slice(-SCREEN_TAIL_LINES);
}

/**
 * The selection cursor on a numbered menu option, e.g. `❯ 1. Yes` or `│ ❯ 2. No`: the menu every
 * permission, AskUserQuestion and plan-approval prompt draws. Free text such as "Do you want to
 * …?" is deliberately not a cue, since Claude's own replies often end with a question.
 */
const MENU_CURSOR = /❯\s*\d+\./;
const BUSY = /esc to interrupt/i;

/**
 * `waiting` when the bottom of the screen shows a prompt the chat cannot
 * answer (the `❯` cursor on a numbered menu option), `busy` while Claude
 * shows "esc to interrupt", otherwise `idle`.
 */
export function classifyClaudeScreen(text: string): ClaudeScreenState {
  const tail = screenTail(text).join("\n");
  if (MENU_CURSOR.test(tail)) return "waiting";
  if (BUSY.test(tail)) return "busy";
  return "idle";
}

export interface ClaudePromptOption { n: number; label: string }
export interface ClaudePrompt {
  /**
   * Every text line of the prompt above option 1, top to bottom: the tool
   * header and the command or file being approved, ending with the question.
   */
  context: string[];
  /** The last line of `context`, or "" when there is none. */
  question: string;
  options: ClaudePromptOption[];
}

/** Box-drawing borders and padding around a line inside a prompt box. */
const BOX_EDGES = /^[\s│┃|]+|[\s│┃|]+$/g;
/** A numbered menu option, with or without the `❯` cursor: `❯ 1. Yes`, `  2. No`. */
const MENU_OPTION = /^(❯\s*)?(\d)\.\s+(.+)$/;
/** A rule or box corner line with no text, e.g. `╭────╮` or `────`. */
const RULE_LINE = /^[─━═╭╮╰╯┌┐└┘├┤\-\s]*$/;
/** A transcript line Claude Code drew above the prompt: a reply or tool call (`●`) or its output (`⎿`). */
const TRANSCRIPT_MARKER = /^[●⎿]/;

/** The screen's lines after escapes and trailing blank lines are dropped: what `screenTail` keeps the end of. */
function screenLines(text: string): string[] {
  const lines = stripAnsi(text).split(/\r?\n|\r/).map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The question and options of the numbered menu Claude Code draws for a
 * permission, AskUserQuestion or plan-approval prompt whose `❯` cursor is in
 * the bottom `SCREEN_TAIL_LINES` lines, or null when there is none. Options
 * run 1, 2, … from the last `1.` at or above the `❯` cursor; lines between
 * them (option descriptions, wrapped labels) are skipped. Only single-digit
 * options are listed, since each is answered by one key press. The context is
 * every text line above option 1, read from the whole screen rather than just
 * the tail so a long diff keeps its file header, up to the prompt's top edge:
 * the nearest rule or box corner line, or, when no rule is drawn, the nearest
 * transcript line (`●`, `⎿`) or the top of the screen. Blank lines inside the
 * prompt only separate its header, command and question. The question is the
 * last context line.
 */
export function parseClaudePrompt(text: string): ClaudePrompt | null {
  const lines = screenLines(text).map((line) => line.replace(BOX_EDGES, ""));
  const tailStart = Math.max(0, lines.length - SCREEN_TAIL_LINES);
  let cursorAt = -1;
  for (let i = tailStart; i < lines.length; i++) {
    if (MENU_CURSOR.test(lines[i]) && MENU_OPTION.test(lines[i])) { cursorAt = i; break; }
  }
  if (cursorAt === -1) return null;
  let first = -1;
  for (let i = cursorAt; i >= tailStart; i--) {
    const m = MENU_OPTION.exec(lines[i]);
    if (m && m[2] === "1") { first = i; break; }
  }
  if (first === -1) return null;
  const options: ClaudePromptOption[] = [];
  let sawCursor = false;
  for (let i = first; i < lines.length; i++) {
    const m = MENU_OPTION.exec(lines[i]);
    if (!m) continue;
    const n = Number(m[2]);
    if (n !== options.length + 1) break;
    options.push({ n, label: m[3].trim() });
    if (m[1]) sawCursor = true;
  }
  if (!sawCursor || options.length === 0) return null;
  const context: string[] = [];
  for (let i = first - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (RULE_LINE.test(line) || TRANSCRIPT_MARKER.test(line)) break;
    context.unshift(line);
  }
  return { context, question: context[context.length - 1] ?? "", options };
}

/**
 * Whether two parsed prompts are the same prompt: the same context lines
 * (tool header, command or path, question) and options. Only the `❯` cursor
 * position is ignored, so two permission prompts with the same question for
 * different commands differ.
 */
export function samePrompt(a: ClaudePrompt | null, b: ClaudePrompt | null): boolean {
  if (!a || !b) return false;
  return a.context.length === b.context.length
    && a.context.every((line, i) => line === b.context[i])
    && a.options.length === b.options.length
    && a.options.every((o, i) => o.n === b.options[i].n && o.label === b.options[i].label);
}

/** The leading `❯` or `>` of Claude Code's input box line, as plain text after box edges are trimmed. */
const INPUT_PROMPT = /^[❯>](?:\s|$)/;
/** One terminal token: an OSC or CSI sequence (the CSI's parameters and final byte captured), another escape, or one code point. */
const TOKEN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-?]*)[ -/]*([@-~])|\x1b[@-_]|[\s\S]/gu;
const EDGE_CHAR = /^[\s│┃|]$/u;

interface StyledChar { ch: string; muted: boolean; inverse: boolean }
/** SGR state carried from one screen line to the next: tmux `capture-pane -e` does not repeat it after a line break. */
interface StyleState { dim: boolean; grey: boolean; inverse: boolean }

/** A raw screen line's visible characters with whether each was drawn dim/grey or in inverse video. Reads and updates `state`, which carries across lines. */
function styledChars(raw: string, state: StyleState): StyledChar[] {
  let { dim, grey, inverse } = state;
  const out: StyledChar[] = [];
  for (const m of raw.matchAll(TOKEN)) {
    const tok = m[0];
    if (tok.charCodeAt(0) !== 0x1b) {
      out.push({ ch: tok, muted: dim || grey, inverse });
      continue;
    }
    if (m[2] !== "m") continue;
    const params = (m[1] ?? "").split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) { dim = false; grey = false; inverse = false; }
      else if (p === 2) dim = true;
      else if (p === 22) dim = false;
      else if (p === 7) inverse = true;
      else if (p === 27) inverse = false;
      else if (p === 90) grey = true;
      else if (p === 39 || (p >= 30 && p <= 37) || (p >= 91 && p <= 97)) grey = false;
      else if (p === 38) {
        if (params[i + 1] === 5) {
          const n = params[i + 2];
          grey = n >= 240 && n <= 250;
          i += 2;
        } else if (params[i + 1] === 2) {
          const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
          grey = r === g && g === b;
          i += 4;
        }
      } else if (p === 48) {
        // Background colours do not change whether text is muted; skip their arguments.
        if (params[i + 1] === 5) i += 2;
        else if (params[i + 1] === 2) i += 4;
      }
    }
  }
  state.dim = dim;
  state.grey = grey;
  state.inverse = inverse;
  return out;
}

/** `chars` without the box edges and padding at either end. */
function trimEdges(chars: StyledChar[]): StyledChar[] {
  let start = 0;
  let end = chars.length;
  while (start < end && EDGE_CHAR.test(chars[start].ch)) start++;
  while (end > start && EDGE_CHAR.test(chars[end - 1].ch)) end--;
  return chars.slice(start, end);
}

/**
 * The suggested next prompt Claude Code shows dimmed in its input box while
 * idle (#clw_01M7FCQ16J027F7RXC9YX5NYT6), or null when there is none. The
 * input line is the last tail line that starts `❯ ` or `> ` (after box
 * edges), is not a numbered menu option and sits directly under a rule line;
 * its text, and any wrapped lines below it up to the next rule, counts as a
 * suggestion only when every visible character is dim (SGR 2) or grey (90,
 * 256-colour 240–250, or an equal-channel truecolour) or is the inverse-video
 * cursor cell. Typed text, an empty box and the start-up `Try "…"` hint all
 * read as null. Style is carried across lines from the top of the screen,
 * because tmux does not repeat it on a wrapped line.
 */
export function parseClaudeSuggestion(text: string): string | null {
  if (classifyClaudeScreen(text) !== "idle") return null;
  const raw = text.split(/\r?\n|\r/);
  const plain = raw.map((line) => stripAnsi(line).replace(BOX_EDGES, ""));
  while (plain.length > 0 && plain[plain.length - 1].trim() === "") { plain.pop(); raw.pop(); }
  const tailStart = Math.max(0, plain.length - SCREEN_TAIL_LINES);
  const isRule = (i: number): boolean => i >= 0 && plain[i].trim() !== "" && RULE_LINE.test(plain[i]);
  let at = -1;
  for (let i = plain.length - 1; i >= tailStart; i--) {
    if (INPUT_PROMPT.test(plain[i]) && !MENU_OPTION.test(plain[i]) && isRule(i - 1)) { at = i; break; }
  }
  if (at === -1) return null;
  const state: StyleState = { dim: false, grey: false, inverse: false };
  const styled = raw.map((line) => styledChars(line, state));
  const parts: string[] = [];
  let sawMuted = false;
  let closed = false;
  for (let i = at; i < raw.length; i++) {
    if (isRule(i)) { closed = true; break; }
    let chars = trimEdges(styled[i]);
    // Drop the `❯`/`>` itself on the input line.
    if (i === at) chars = chars.slice(1);
    for (const c of chars) {
      if (/\s/u.test(c.ch)) continue;
      if (!c.muted && !c.inverse) return null;
      if (c.muted) sawMuted = true;
    }
    const part = chars.map((c) => c.ch).join("").trim();
    if (part) parts.push(part);
  }
  if (!closed) return null;
  const suggestion = parts.join(" ").trim();
  if (!sawMuted || suggestion.length < 2 || suggestion.startsWith('Try "')) return null;
  return suggestion;
}
