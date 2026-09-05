import { describe, it, expect } from "vitest";
import { buildIssueLogsPage } from "./logs.js";

describe("buildIssueLogsPage repo escaping", () => {
  it("escapes & in the repo param so HTML attribute parsing is safe", () => {
    const withAmpersand = `org/repo&injected=x`;
    const html = buildIssueLogsPage(withAmpersand, 1, [], new Map(), new Map(), "light");
    // encodeURI does NOT encode &, but escapeHtml must convert it to &amp;
    expect(html).toContain("&amp;injected");
    expect(html).not.toContain("&injected=");
  });
});
