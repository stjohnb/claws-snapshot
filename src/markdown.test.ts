import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders ordinary markdown", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders GFM tables and fenced code", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```");
    expect(html).toContain("<table>");
    expect(html).toContain("<code");
  });

  it("escapes raw block HTML instead of passing it through", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes raw inline HTML", () => {
    const html = renderMarkdown("text with <img src=x onerror=alert(1)> inline");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("drops a javascript: link, keeping its text", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
    expect(html).toContain("click me");
  });

  it("drops a data: image, keeping its alt text", () => {
    const html = renderMarkdown("![alt text](data:text/html;base64,PHNjcmlwdD4=)");
    expect(html).not.toContain("<img");
    expect(html).toContain("alt text");
  });

  it("keeps http, https, root-relative and fragment links", () => {
    const html = renderMarkdown("[a](https://example.com) [b](http://example.com) [c](/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC) [d](#section)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="http://example.com"');
    expect(html).toContain('href="/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"');
    expect(html).toContain('href="#section"');
  });

  it("keeps mailto and path-relative links", () => {
    const html = renderMarkdown("[a](mailto:ops@example.com) [b](./docs/OVERVIEW.md)");
    expect(html).toContain('href="mailto:ops@example.com"');
    expect(html).toContain('href="./docs/OVERVIEW.md"');
  });

  it("drops schemes outside the allowlist, whatever their case", () => {
    expect(renderMarkdown("[x](JAVASCRIPT:alert(1))")).not.toContain("<a ");
    expect(renderMarkdown("[x](vbscript:alert(1))")).not.toContain("<a ");
  });

  it("drops a scheme smuggled past a prefix test with control characters", () => {
    // Angle-bracket destinations are the only markdown form that can carry a
    // tab; a browser reads `java<TAB>script:` as the javascript scheme.
    expect(renderMarkdown("[x](<java\tscript:alert(1)>)")).not.toContain("<a ");
  });

  it("keeps http(s) images, which is how the images pipeline finds them", () => {
    const html = renderMarkdown("![shot](https://example.com/a.png)");
    expect(html).toContain('<img src="https://example.com/a.png" alt="shot">');
  });

  it("escapes quotes inside a link title so the attribute cannot be broken out of", () => {
    const html = renderMarkdown('[x](https://example.com "a \\" b")');
    expect(html).not.toMatch(/title="a " b"/);
    expect(html).toContain("&quot;");
  });

  it("returns an empty string for blank input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   \n  ")).toBe("");
  });
});
