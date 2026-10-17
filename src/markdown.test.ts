import { describe, it, expect } from "vitest";
import { renderMarkdown, collectIssueRefs, type IssueRefLinks } from "./markdown.js";

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

describe("renderMarkdown issue refs", () => {
  const ID = "clw_01JBQ0000000000000000000AA";
  const refs: IssueRefLinks = {
    hrefFor: (ref) => ({
      [ID]: `/issues/${ID}`,
      "#123": "https://git.example/o/r/pulls/123",
      "o/r#7": "/issues/clw_01JBQ0000000000000000000BB",
    } as Record<string, string>)[ref],
  };

  it("links a known native id written with and without #", () => {
    const html = renderMarkdown(`see #${ID} and ${ID.toLowerCase()}.`, { refs });
    expect(html).toContain(`<a href="/issues/${ID}" class="issue-ref">#${ID}</a>`);
    expect(html).toContain(`<a href="/issues/${ID}" class="issue-ref">${ID.toLowerCase()}</a>`);
  });

  it("links a known #N and owner/repo#N", () => {
    const html = renderMarkdown("fixed by #123, see o/r#7", { refs });
    expect(html).toContain(`<a href="https://git.example/o/r/pulls/123" class="issue-ref">#123</a>`);
    expect(html).toContain(`<a href="/issues/clw_01JBQ0000000000000000000BB" class="issue-ref">o/r#7</a>`);
  });

  it("does not double-wrap a ref inside link text", () => {
    const html = renderMarkdown(`[text #${ID} **#123**](https://x.example/)`, { refs });
    expect(html).not.toContain("issue-ref");
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("leaves refs in inline code and fenced code alone", () => {
    const html = renderMarkdown("`#123` and\n\n```\n#123 " + ID + "\n```", { refs });
    expect(html).not.toContain("issue-ref");
  });

  it("leaves an unknown id plain", () => {
    const html = renderMarkdown("see #999 and clw_01JBQ0000000000000000000ZZ", { refs });
    expect(html).not.toContain("<a ");
  });

  it("leaves entities, URL fragments and glued refs plain", () => {
    const html = renderMarkdown("&#123; https://x.example/y#123 host/path#123 foo#123 ##123 #1234", { refs });
    expect(html).not.toContain("issue-ref");
  });

  it("mixes known refs, unknown ids, code and links", () => {
    const html = renderMarkdown(`${ID} then #123, #999, \`#123\` and [#123](https://x.example/)`, { refs });
    expect(html.match(/class="issue-ref"/g)).toHaveLength(2);
  });

  it("renders identically without a resolver", () => {
    const md = `see #${ID}, #123 and o/r#7 with **bold** and [a](https://x.example/)`;
    const html = renderMarkdown(md);
    expect(html).not.toContain("<a href=\"/issues");
    expect(html).toBe(renderMarkdown(md, {}));
    expect(html).toBe("<p>see #" + ID + ", #123 and o/r#7 with <strong>bold</strong> and <a href=\"https://x.example/\" rel=\"noopener noreferrer nofollow\">a</a></p>\n");
  });
});

describe("collectIssueRefs", () => {
  it("returns distinct candidates", () => {
    expect(collectIssueRefs("#1 #1 o/r#2 #clw_01jbq0000000000000000000aa")).toEqual([
      { kind: "forge", repo: null, number: 1 },
      { kind: "forge", repo: "o/r", number: 2 },
      { kind: "native", id: "clw_01JBQ0000000000000000000AA" },
    ]);
  });

  it("scans a long slash-free word in linear time", () => {
    const word = "a".repeat(50_000);
    const t = Date.now();
    renderMarkdown(word, { refs: { hrefFor: () => undefined } });
    collectIssueRefs(word);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
