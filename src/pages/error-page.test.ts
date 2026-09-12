import { describe, it, expect, vi } from "vitest";

vi.mock("./layout.js", () => ({
  PAGE_CSS: "",
  TAILWIND_STYLESHEET: "",
  HEAD_META: "",
  escapeHtml: (s: string) => "ESC(" + s + ")",
  htmlOpenTag: () => "<html>",
  buildPageHeader: () => "",
  THEME_SCRIPT: "",
}));

import { buildErrorPage } from "./error-page.js";

describe("buildErrorPage", () => {
  it("includes status in the title", () => {
    const html = buildErrorPage("dark", { status: 404, heading: "Not found", message: "Nope." });
    expect(html).toContain("<title>404 — Claws</title>");
  });

  it("includes the heading and message", () => {
    const html = buildErrorPage("dark", { status: 404, heading: "Session not found", message: "This session has ended." });
    expect(html).toContain("Session not found");
    expect(html).toContain("This session has ended.");
  });

  it("escapes the detail value", () => {
    const html = buildErrorPage("dark", { status: 404, heading: "Not found", message: "Nope.", detail: "<script>" });
    expect(html).toContain("ESC(<script>)");
  });

  it("renders each action's href and label", () => {
    const html = buildErrorPage("dark", {
      status: 404,
      heading: "Not found",
      message: "Nope.",
      actions: [{ href: "/sessions", label: "← All sessions" }, { href: "/", label: "Dashboard" }],
    });
    expect(html).toContain('href="ESC(/sessions)"');
    expect(html).toContain("ESC(← All sessions)");
    expect(html).toContain('href="ESC(/)"');
    expect(html).toContain("ESC(Dashboard)");
  });

  it("defaults to a single Dashboard action when actions is omitted", () => {
    const html = buildErrorPage("dark", { status: 404, heading: "Not found", message: "Nope." });
    expect(html).toContain('href="ESC(/)"');
    expect(html).toContain("ESC(← Dashboard)");
  });

  it("defaults to a single Dashboard action when actions is empty", () => {
    const html = buildErrorPage("dark", { status: 404, heading: "Not found", message: "Nope.", actions: [] });
    expect(html).toContain('href="ESC(/)"');
    expect(html).toContain("ESC(← Dashboard)");
  });

  it("renders a post action as a form with a submit button", () => {
    const html = buildErrorPage("dark", {
      status: 404,
      heading: "Session ended",
      message: "Ended.",
      actions: [{ href: "/sessions/abc/resume", label: "Revive session", method: "post" }],
    });
    expect(html).toContain('method="post"');
    expect(html).toContain('action="ESC(/sessions/abc/resume)"');
    expect(html).toContain("<button");
    expect(html).toContain("ESC(Revive session)");
  });

  it("still renders a link action as an anchor", () => {
    const html = buildErrorPage("dark", {
      status: 404,
      heading: "Not found",
      message: "Nope.",
      actions: [{ href: "/sessions", label: "← All sessions" }],
    });
    expect(html).toContain('<a class="trigger-btn" href=');
  });

  it("renders no retry form when retry is omitted", () => {
    const html = buildErrorPage("dark", { status: 503, heading: "Cannot create session", message: "Restarting." });
    expect(html).not.toContain("claws-retry-form");
  });

  it("renders a retry form and poller when retry is present", () => {
    const html = buildErrorPage("dark", {
      status: 503,
      heading: "Cannot create session",
      message: "Restarting.",
      retry: {
        action: "/sessions/create",
        fields: [
          { name: "mode", value: "repo-claude" },
          { name: "capability", value: "web" },
          { name: "capability", value: "docs" },
        ],
        elapsedMs: 12345,
      },
    });
    expect(html).toContain('id="claws-retry-form"');
    expect(html).toContain('action="ESC(/sessions/create)"');
    expect(html).toContain('<input type="hidden" name="ESC(mode)" value="ESC(repo-claude)">');
    const capabilityInputs = html.match(/name="ESC\(capability\)"/g) ?? [];
    expect(capabilityInputs).toHaveLength(2);
    expect(html).toContain('<input type="hidden" name="ESC(capability)" value="ESC(web)">');
    expect(html).toContain('<input type="hidden" name="ESC(capability)" value="ESC(docs)">');
    expect(html).toContain("12s");
  });
});
