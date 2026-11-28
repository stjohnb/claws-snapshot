import { renderMarkdown } from "./markdown.js";

// Normalises raw Claude Code transcript lines (`~/.claude/projects/<cwd>/<session>.jsonl`,
// served by the session pod's `GET /transcript`) into the events the session
// page's chat view draws (#clw_01M7DYJ0WVGSM09PFTBS3HXDB3). It runs in the web
// tier, not the pod, so a change in Claude Code's transcript format is fixed
// by a web deploy rather than a new pod image. Pure: no I/O.

/** Longest chat composer text, in UTF-8 bytes: the session pod's `POST /input` cap (`INPUT_MAX_BYTES`). */
export const CHAT_INPUT_MAX_BYTES = 64 * 1024;
/** Longest tool-row summary, in characters. */
export const TOOL_SUMMARY_MAX_CHARS = 80;
/** Longest pretty-printed tool input kept, in characters. */
export const TOOL_INPUT_MAX_CHARS = 2 * 1024;
/** Longest tool output kept, in characters. */
export const TOOL_RESULT_MAX_CHARS = 8 * 1024;

interface ChatEventBase {
  /** Stable per transcript block: `<uuid>:<blockIndex>`, so a re-read never draws a block twice. */
  key: string;
  /** The transcript entry's `uuid`; empty for an oversize stub. */
  uuid: string;
  /** The entry's ISO timestamp, when it has one. */
  timestamp: string | null;
}

/** One thing the chat view draws, in transcript order. */
export type ChatEvent =
  | (ChatEventBase & { kind: "user"; text: string; html: string })
  /** A slash command the operator ran (`<command-name>` in a user entry), drawn as a chip. */
  | (ChatEventBase & { kind: "command"; name: string; args: string })
  | (ChatEventBase & { kind: "assistant"; text: string; html: string })
  | (ChatEventBase & { kind: "tool_use"; id: string; name: string; summary: string; input: string; inputTruncated: boolean })
  | (ChatEventBase & { kind: "tool_result"; toolUseId: string; isError: boolean; text: string; truncated: boolean })
  /** `/compact` (manual or automatic) ran here. */
  | (ChatEventBase & { kind: "compact" })
  /** The pod stood in for a transcript line too large to send. */
  | (ChatEventBase & { kind: "oversize"; bytes: number });

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function cut(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

function oneLine(text: string, max: number): string {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A short, one-line description of a tool call for its collapsed row. */
export function summarizeToolInput(name: string, input: unknown): string {
  const obj = isObject(input) ? input : {};
  const str = (k: string) => (typeof obj[k] === "string" ? obj[k] as string : "");
  let raw: string;
  switch (name) {
    case "Bash": raw = str("command"); break;
    case "Read": case "Edit": case "Write": case "NotebookEdit": raw = str("file_path") || str("notebook_path"); break;
    case "Grep": case "Glob": raw = str("pattern"); break;
    case "WebFetch": raw = str("url"); break;
    case "Task": case "Agent": raw = str("description"); break;
    default: raw = (Object.values(obj).find((v) => typeof v === "string") as string | undefined) ?? "";
  }
  return oneLine(raw, TOOL_SUMMARY_MAX_CHARS);
}

/**
 * A placeholder for an `image` or `document` block, such as `[image: 640 KB jpeg]`:
 * the size is the pod's `source.claws_bytes` (a slimmed line) or derived from
 * `source.data`'s base64 length, the type is `source.media_type` after the `/`.
 * Without a usable size or type it is just `[image]` or `[document]`.
 */
export function attachmentLabel(block: Record<string, unknown>): string {
  const kind = block.type === "document" ? "document" : "image";
  const source = isObject(block.source) ? block.source : {};
  let bytes: number | null = null;
  if (typeof source.claws_bytes === "number" && Number.isFinite(source.claws_bytes) && source.claws_bytes > 0) bytes = source.claws_bytes;
  else if (typeof source.data === "string" && source.data.length > 0) bytes = Math.floor(source.data.length * 3 / 4);
  const mediaType = typeof source.media_type === "string" ? source.media_type : "";
  const slash = mediaType.indexOf("/");
  const subtype = slash !== -1 ? mediaType.slice(slash + 1).trim() : "";
  if (bytes === null || subtype === "") return `[${kind}]`;
  const kb = Math.max(1, Math.round(bytes / 1024));
  const size = kb < 1024 ? `${kb} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `[${kind}: ${size} ${subtype}]`;
}

/** The text of a `tool_result` block's content: a string, or the text parts of an array (images and documents are labelled, not inlined). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!isObject(part)) return "";
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "image" || part.type === "document") return attachmentLabel(part);
    return "";
  }).filter((t) => t !== "").join("\n");
}

const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
/** Echoed output and caveats of local slash commands: noise in a chat. */
const LOCAL_COMMAND_NOISE = /^\s*<local-command-(stdout|stderr|caveat)>/;

function userText(base: ChatEventBase, text: string): ChatEvent | null {
  if (text.trim() === "" || LOCAL_COMMAND_NOISE.test(text)) return null;
  const name = COMMAND_NAME.exec(text);
  if (name) return { ...base, kind: "command", name: name[1]!.trim(), args: (COMMAND_ARGS.exec(text)?.[1] ?? "").trim() };
  return { ...base, kind: "user", text, html: renderMarkdown(text) };
}

/**
 * Turn raw transcript lines into chat events. Unparseable lines and every
 * entry the chat does not show are skipped: sidechain (subagent) and `isMeta`
 * entries, compact summaries, thinking blocks, local-command echo and any
 * entry type other than `user`, `assistant`, a `compact_boundary` `system`
 * entry and the pod's `claws-oversize` stub.
 */
export function normalizeTranscriptLines(lines: readonly string[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;
    if (entry.type === "claws-oversize") {
      const bytes = typeof entry.bytes === "number" ? entry.bytes : 0;
      const offset = typeof entry.offset === "number" ? entry.offset : 0;
      // The line's byte offset makes the key unique per line, not per size.
      events.push({ key: `oversize:${offset}:${bytes}`, uuid: "", timestamp: null, kind: "oversize", bytes });
      continue;
    }
    if (entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) continue;
    const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
    if (!uuid) continue;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
    const base = (i: number): ChatEventBase => ({ key: `${uuid}:${i}`, uuid, timestamp });

    if (entry.type === "system") {
      if (entry.subtype === "compact_boundary") events.push({ ...base(0), kind: "compact" });
      continue;
    }
    if (entry.type === "attachment") {
      // A message typed while Claude was busy is queued, then injected mid-turn as this entry.
      const att = entry.attachment;
      if (
        isObject(att) &&
        att.type === "queued_command" &&
        att.commandMode === "prompt" &&
        att.isMeta !== true &&
        (!isObject(att.origin) || att.origin.kind === "human") &&
        (!isObject(entry.origin) || entry.origin.kind === "human")
      ) {
        let text = "";
        if (typeof att.prompt === "string") text = att.prompt;
        else if (Array.isArray(att.prompt)) {
          text = att.prompt
            .filter((b): b is Record<string, unknown> => isObject(b) && b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n");
        }
        const ev = userText(base(0), text);
        if (ev) events.push(ev);
      }
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const message = isObject(entry.message) ? entry.message : null;
    if (!message) continue;
    const content = message.content;

    if (entry.type === "user") {
      if (typeof content === "string") {
        const ev = userText(base(0), content);
        if (ev) events.push(ev);
        continue;
      }
      if (!Array.isArray(content)) continue;
      content.forEach((block, i) => {
        if (!isObject(block)) return;
        if (block.type === "text" && typeof block.text === "string") {
          const ev = userText(base(i), block.text);
          if (ev) events.push(ev);
        } else if (block.type === "image" || block.type === "document") {
          const text = attachmentLabel(block);
          events.push({ ...base(i), kind: "user", text, html: renderMarkdown(text) });
        } else if (block.type === "tool_result") {
          const { text, truncated } = cut(toolResultText(block.content), TOOL_RESULT_MAX_CHARS);
          events.push({
            ...base(i),
            kind: "tool_result",
            toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
            isError: block.is_error === true,
            text,
            truncated,
          });
        }
      });
      continue;
    }

    if (!Array.isArray(content)) continue;
    content.forEach((block, i) => {
      if (!isObject(block)) return;
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.trim() === "") return;
        events.push({ ...base(i), kind: "assistant", text: block.text, html: renderMarkdown(block.text) });
      } else if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "tool";
        let pretty: string;
        try {
          pretty = JSON.stringify(block.input ?? {}, null, 2) ?? "";
        } catch {
          pretty = "";
        }
        const { text: input, truncated: inputTruncated } = cut(pretty, TOOL_INPUT_MAX_CHARS);
        events.push({
          ...base(i),
          kind: "tool_use",
          id: typeof block.id === "string" ? block.id : "",
          name,
          summary: summarizeToolInput(name, block.input),
          input,
          inputTruncated,
        });
      }
      // Thinking (and redacted thinking) blocks are left out of the chat.
    });
  }
  return events;
}
