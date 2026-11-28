import { describe, expect, it } from "vitest";
import { INPUT_MAX_BYTES } from "./session-pod/terminal-server.js";
import {
  CHAT_INPUT_MAX_BYTES,
  normalizeTranscriptLines,
  summarizeToolInput,
  TOOL_INPUT_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
  TOOL_SUMMARY_MAX_CHARS,
} from "./session-chat.js";

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", uuid, timestamp: "2026-11-14T10:00:00.000Z", message: { role: "user", content }, ...extra });
const assistant = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", uuid, timestamp: "2026-11-14T10:00:01.000Z", message: { role: "assistant", content }, ...extra });

const queued = (uuid: string, att: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  line({ type: "attachment", uuid, timestamp: "2026-11-17T07:46:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", ...att }, ...extra });

describe("normalizeTranscriptLines queued messages", () => {
  it("shows a queued prompt in place", () => {
    const events = normalizeTranscriptLines([
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      queued("q1", { prompt: "Can we kill docker too?" }),
      assistant("a2", [{ type: "text", text: "Sure" }]),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["tool_use", "user", "assistant"]);
    expect(events[1]).toMatchObject({ key: "q1:0", text: "Can we kill docker too?" });
    expect(events[1]!.kind === "user" && events[1].html).toContain("kill docker");
  });

  it("joins text blocks of an array prompt and ignores images", () => {
    const events = normalizeTranscriptLines([
      queued("q1", { prompt: [{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }] }),
    ]);
    expect(events).toEqual([expect.objectContaining({ kind: "user", text: "a\nb" })]);
  });

  it("accepts a human origin and hides everything else", () => {
    expect(normalizeTranscriptLines([queued("q1", { prompt: "hi", origin: { kind: "human" } })])).toHaveLength(1);
    expect(normalizeTranscriptLines([
      queued("q2", { prompt: "x", commandMode: "task-notification" }),
      queued("q3", { prompt: "x", isMeta: true }),
      queued("q4", { prompt: "x", origin: { kind: "peer" } }),
      queued("q5", { prompt: "x" }, { isSidechain: true }),
      line({ type: "attachment", uuid: "q6", attachment: { type: "other", prompt: "x" } }),
      line({ type: "queue-operation", uuid: "q7", operation: "enqueue", content: "x" }),
    ])).toEqual([]);
  });
});

describe("normalizeTranscriptLines", () => {
  it("turns a user prompt into a user event with rendered Markdown", () => {
    const [ev] = normalizeTranscriptLines([user("u1", "Fix **this** <script>alert(1)</script>")]);
    expect(ev).toMatchObject({ kind: "user", key: "u1:0", uuid: "u1", timestamp: "2026-11-14T10:00:00.000Z", text: "Fix **this** <script>alert(1)</script>" });
    expect(ev!.kind === "user" && ev.html).toContain("<strong>this</strong>");
    expect(ev!.kind === "user" && ev.html).not.toContain("<script>");
  });

  it("turns the text blocks of an array user message into user events keyed by block", () => {
    const events = normalizeTranscriptLines([user("u1", [{ type: "image", source: {} }, { type: "text", text: "look" }])]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "user", key: "u1:0", text: "[image]" }),
      expect.objectContaining({ kind: "user", key: "u1:1", text: "look" }),
    ]);
  });

  it("labels a slimmed image with its size and type and keeps the text sent with it", () => {
    const events = normalizeTranscriptLines([user("u1", [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "", claws_bytes: 655360 } },
      { type: "text", text: "what is this chip?" },
    ])]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "user", key: "u1:0", text: "[image: 640 KB jpeg]" }),
      expect.objectContaining({ kind: "user", key: "u1:1", text: "what is this chip?" }),
    ]);
    expect(events[0]!.kind === "user" && events[0].html).toContain("[image: 640 KB jpeg]");
  });

  it("labels an unslimmed small image from its base64 length", () => {
    const [ev] = normalizeTranscriptLines([user("u1", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4096) } }])]);
    expect(ev).toMatchObject({ kind: "user", key: "u1:0", text: "[image: 3 KB png]" });
  });

  it("labels a size that rounds up to 1024 KB in MB", () => {
    const [ev] = normalizeTranscriptLines([user("u1", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "", claws_bytes: 1024 * 1024 - 100 } }])]);
    expect(ev).toMatchObject({ kind: "user", key: "u1:0", text: "[image: 1.0 MB png]" });
  });

  it("labels a document block, in MB once it is over 1 MB", () => {
    const [ev] = normalizeTranscriptLines([user("u1", [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "", claws_bytes: 2.5 * 1024 * 1024 } }])]);
    expect(ev).toMatchObject({ kind: "user", key: "u1:0", text: "[document: 2.5 MB pdf]" });
  });

  it("turns a slash command into a command chip and drops its local output", () => {
    const events = normalizeTranscriptLines([
      user("c1", "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep tests</command-args>"),
      user("c2", "<local-command-stdout>Compacted</local-command-stdout>"),
    ]);
    expect(events).toEqual([{ kind: "command", key: "c1:0", uuid: "c1", timestamp: "2026-11-14T10:00:00.000Z", name: "/compact", args: "keep tests" }]);
  });

  it("emits one assistant event per text block and drops thinking", () => {
    const events = normalizeTranscriptLines([assistant("a1", [
      { type: "thinking", thinking: "secret plan" },
      { type: "text", text: "First" },
      { type: "redacted_thinking", data: "x" },
      { type: "text", text: "Second `code`" },
    ])]);
    expect(events.map((e) => [e.kind, e.key])).toEqual([["assistant", "a1:1"], ["assistant", "a1:3"]]);
    expect(events[1]!.kind === "assistant" && events[1].html).toContain("<code>code</code>");
    expect(JSON.stringify(events)).not.toContain("secret plan");
  });

  it("turns tool calls and results into tool_use and tool_result events", () => {
    const events = normalizeTranscriptLines([
      assistant("a1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test\nnpm run build", description: "run" } }]),
      user("u2", [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }]),
      user("u3", [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "boom" }, { type: "image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "", claws_bytes: 2048 } }], is_error: true }]),
    ]);
    expect(events[0]).toMatchObject({ kind: "tool_use", key: "a1:0", id: "toolu_1", name: "Bash", summary: "npm test", inputTruncated: false });
    expect(JSON.parse((events[0] as { input: string }).input)).toEqual({ command: "npm test\nnpm run build", description: "run" });
    expect(events[1]).toMatchObject({ kind: "tool_result", key: "u2:0", toolUseId: "toolu_1", isError: false, text: "ok", truncated: false });
    expect(events[2]).toMatchObject({ kind: "tool_result", toolUseId: "toolu_2", isError: true, text: "boom\n[image]\n[image: 2 KB png]" });
  });

  it("truncates large tool input and output", () => {
    const events = normalizeTranscriptLines([
      assistant("a1", [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "/a", content: "x".repeat(10_000) } }]),
      user("u1", [{ type: "tool_result", tool_use_id: "t", content: "y".repeat(TOOL_RESULT_MAX_CHARS + 5) }]),
    ]);
    expect(events[0]).toMatchObject({ kind: "tool_use", summary: "/a", inputTruncated: true });
    expect((events[0] as { input: string }).input).toHaveLength(TOOL_INPUT_MAX_CHARS);
    expect(events[1]).toMatchObject({ kind: "tool_result", truncated: true });
    expect((events[1] as { text: string }).text).toHaveLength(TOOL_RESULT_MAX_CHARS);
  });

  it("marks a compact boundary and passes the pod's oversize stub through", () => {
    const events = normalizeTranscriptLines([
      line({ type: "system", subtype: "compact_boundary", uuid: "s1", timestamp: "t" }),
      line({ type: "system", subtype: "informational", uuid: "s2" }),
      line({ type: "claws-oversize", bytes: 900_000, offset: 4096 }),
    ]);
    expect(events).toEqual([
      { kind: "compact", key: "s1:0", uuid: "s1", timestamp: "t" },
      { kind: "oversize", key: "oversize:4096:900000", uuid: "", timestamp: null, bytes: 900_000 },
    ]);
  });

  it("skips sidechain, meta, compact-summary, unknown and unparseable entries", () => {
    expect(normalizeTranscriptLines([
      user("m1", "Caveat: generated by local commands", { isMeta: true }),
      assistant("s1", [{ type: "text", text: "subagent" }], { isSidechain: true }),
      user("cs", "This session is being continued…", { isCompactSummary: true }),
      line({ type: "summary", summary: "x", leafUuid: "u" }),
      line({ type: "file-history-snapshot", messageId: "m" }),
      "{not json",
      "[1,2]",
      line({ type: "user", message: { content: "no uuid" } }),
    ])).toEqual([]);
  });
});

describe("summarizeToolInput", () => {
  it.each([
    ["Read", { file_path: "/src/a.ts" }, "/src/a.ts"],
    ["Edit", { file_path: "/src/b.ts", old_string: "a" }, "/src/b.ts"],
    ["Write", { file_path: "/c" }, "/c"],
    ["NotebookEdit", { notebook_path: "/n.ipynb" }, "/n.ipynb"],
    ["Grep", { pattern: "foo.*bar", path: "src" }, "foo.*bar"],
    ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["WebFetch", { url: "https://example.com", prompt: "read" }, "https://example.com"],
    ["Task", { description: "Explore code", prompt: "long" }, "Explore code"],
    ["Agent", { description: "Review", prompt: "long" }, "Review"],
    ["mcp__x__y", { count: 3, query: "hello" }, "hello"],
    ["Other", { n: 1 }, ""],
  ])("summarises %s", (name, input, expected) => {
    expect(summarizeToolInput(name, input)).toBe(expected);
  });

  it("caps the summary length", () => {
    const summary = summarizeToolInput("Bash", { command: "echo " + "z".repeat(200) });
    expect(summary).toHaveLength(TOOL_SUMMARY_MAX_CHARS);
    expect(summary.endsWith("…")).toBe(true);
  });
});

it("caps chat input at the session pod's POST /input limit", () => {
  expect(CHAT_INPUT_MAX_BYTES).toBe(INPUT_MAX_BYTES);
});
