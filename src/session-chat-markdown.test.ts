import { describe, expect, it } from "vitest";
import { normalizeTranscriptLines } from "./session-chat.js";

const assistant = (uuid: string, text: string) =>
  JSON.stringify({ type: "assistant", uuid, timestamp: "2026-11-25T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("chat path Markdown lists", () => {
  it("keeps a nested ordered list inside its parent bullet", () => {
    const events = normalizeTranscriptLines([
      assistant("a1", "Current state:\n\n- **Contents:** items:\n  1. first\n  2. second\n- **Other:** x"),
    ]);
    const ev = events.find((e) => e.kind === "assistant");
    const html = ev && ev.kind === "assistant" ? ev.html : "";
    expect(html).toContain("<ul>");
    const firstLi = html.indexOf("<li>");
    const firstLiEnd = html.indexOf("</li>", firstLi);
    const ol = html.indexOf("<ol>");
    expect(firstLi).toBeGreaterThanOrEqual(0);
    expect(ol).toBeGreaterThan(firstLi);
    expect(ol).toBeLessThan(firstLiEnd);
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
  });
});
