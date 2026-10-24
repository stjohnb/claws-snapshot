import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  ACTIVATION_STATE: "active",
}));

import { anthropicLabel, openaiLabel, buildPageHeader, buildNav, navLinkCount, PINNED_NAV_LINKS, MORE_NAV_LINKS, PAGE_CSS, labelChip, refArg, htmlOpenTag, formatCompactAge, PREVIEW_MODAL_HTML } from "./layout.js";
import { repoAvatar } from "./layout.js";
import { clearRepoConfigCache, refreshRepoConfigs } from "../repo-config.js";
import type { AiProviderStatus } from "./layout.js";

const base: AiProviderStatus = {
  configured: true,
  rateLimited: false,
  lastUsedAt: null,
};

describe("anthropicLabel isPrimary", () => {
  it("appends (primary) to idle label when isPrimary is true", () => {
    const result = anthropicLabel({ ...base, lastUsedAt: null, isPrimary: true });
    expect(result.text).toBe("Idle (primary)");
    expect(result.cls).toBe("idle");
  });

  it("appends (primary) to active label when isPrimary is true", () => {
    const result = anthropicLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: true });
    expect(result.text).toBe("Active (primary)");
    expect(result.cls).toBe("running");
  });

  it("does not append (primary) when isPrimary is false", () => {
    const result = anthropicLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: false });
    expect(result.text).toBe("Active");
  });

  it("appends (primary) to not-configured label when isPrimary is true", () => {
    const result = anthropicLabel({ ...base, configured: false, isPrimary: true });
    expect(result.text).toBe("Not configured (primary)");
  });

  it("returns an auth-expired label with a link when authExpired is true", () => {
    const result = anthropicLabel({ ...base, authExpired: true });
    expect(result.text).toBe("Auth expired — visit Reauth");
    expect(result.cls).toBe("slack-error");
    expect(result.link).toBe(true);
  });

  it("does not set link when authExpired is false", () => {
    const result = anthropicLabel({ ...base, authExpired: false });
    expect(result.link).toBe(false);
  });

  it("sets link when rateLimited is true", () => {
    const result = anthropicLabel({ ...base, rateLimited: true });
    expect(result.text).toBe("Rate limited");
    expect(result.link).toBe(true);
  });
});

describe("openaiLabel isPrimary", () => {
  it("appends (primary) to idle label when isPrimary is true", () => {
    const result = openaiLabel({ ...base, lastUsedAt: null, isPrimary: true });
    expect(result.text).toBe("Idle (primary)");
    expect(result.cls).toBe("idle");
  });

  it("appends (primary) to active label when isPrimary is true", () => {
    const result = openaiLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: true });
    expect(result.text).toBe("Active (primary)");
    expect(result.cls).toBe("running");
  });

  it("does not append (primary) when isPrimary is false", () => {
    const result = openaiLabel({ ...base, lastUsedAt: "2024-01-01T00:00:00Z", isPrimary: false });
    expect(result.text).toBe("Active");
  });

  it("appends (primary) to not-configured label when isPrimary is true", () => {
    const result = openaiLabel({ ...base, configured: false, isPrimary: true });
    expect(result.text).toBe("Not configured (primary)");
  });

  it("links to Reauth when the codex credential is expired", () => {
    const result = openaiLabel({ ...base, authExpired: true });
    expect(result).toEqual({ text: "Auth expired — visit Reauth", cls: "slack-error", link: true });
  });

  it("does not set link when authExpired is false", () => {
    expect(openaiLabel({ ...base, authExpired: false }).link).toBe(false);
  });

  it("sets link when rateLimited is true", () => {
    const result = openaiLabel({ ...base, rateLimited: true });
    expect(result.text).toBe("Rate limited");
    expect(result.link).toBe(true);
  });
});

describe("buildPageHeader", () => {
  it("renders nav and subtitle when pageTitle is set, without the wordmark", () => {
    const html = buildPageHeader("Queue", "dark");
    expect(html).not.toContain("<h1>claws</h1>");
    expect(html).toContain("<nav>");
    expect(html).toContain("<h2>Queue</h2>");
  });

  it("omits the subtitle when pageTitle is null", () => {
    const html = buildPageHeader(null, "dark");
    expect(html).not.toContain("<h1>claws</h1>");
    expect(html).toContain("<nav>");
    expect(html).not.toContain("<h2>");
  });

  it("escapes HTML in the page title", () => {
    const html = buildPageHeader("<script>alert(1)</script>", "dark");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("injects the stale-session watcher on every page", () => {
    const html = buildPageHeader(null, "dark");
    expect(html).toContain("/api/auth/status");
    expect(html).toContain("clawsAuthCheck");
  });

  it("omits the nav when showNav is false, but keeps a standalone wordmark", () => {
    const html = buildPageHeader("Login", "dark", { showNav: false });
    expect(html).toContain("<h1>claws</h1>");
    expect(html).not.toContain("<nav>");
    expect(html).toContain("<h2>Login</h2>");
  });
});

describe("buildNav", () => {
  const ALL_HREFS = [...PINNED_NAV_LINKS, ...MORE_NAV_LINKS].map(([href]) => href);
  const morePanel = (html: string) => {
    const start = html.indexOf('class="nav-more-panel"');
    return html.slice(start, html.indexOf("</div>", start));
  };

  it("renders every destination exactly once", () => {
    const html = buildNav("dark");
    expect(ALL_HREFS).toHaveLength(14);
    for (const href of ALL_HREFS) {
      expect(html.split(`href="${href}"`)).toHaveLength(2);
    }
    for (const href of ["/queue", "/topology", "/repos", "/runners", "/logs", "/verify"]) {
      expect(html).not.toContain(`href="${href}"`);
    }
  });

  it("pins exactly Board, PRs and Sessions in .nav-pinned, as plain links", () => {
    const html = buildNav("dark");
    const start = html.indexOf('class="nav-pinned"');
    expect(start).toBeGreaterThan(-1);
    const pinned = html.slice(html.indexOf(">", start) + 1, html.indexOf("</div>", start));
    const hrefs = [...pinned.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/board", "/prs", "/sessions"]);
    for (const tag of pinned.match(/<a [^>]*>/g) ?? []) expect(tag).not.toContain("class=");
    expect(pinned).not.toContain("role=");
  });

  it("lists exactly the 11 non-pinned destinations, in order, in the More panel", () => {
    const panel = morePanel(buildNav("dark"));
    const labels = [...panel.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Issues", "Status", "Backlog", "Jobs", "Usage", "Damp", "DMARC", "Blog", "WhatsApp", "Reauth", "Config"]);
    for (const [href] of PINNED_NAV_LINKS) {
      expect(panel).not.toContain(`href="${href}"`);
    }
  });

  it("orders pinned links, More, then the avatar menu inside one .nav-bar, with no wordmark or checkbox", () => {
    const html = buildNav("dark");
    const barIdx = html.indexOf('class="nav-bar"');
    const pinnedIdx = html.indexOf('class="nav-pinned"');
    const moreIdx = html.indexOf('<details class="nav-more">');
    const profileIdx = html.indexOf('<details class="nav-profile">');
    expect(barIdx).toBeGreaterThan(-1);
    expect(pinnedIdx).toBeGreaterThan(barIdx);
    expect(moreIdx).toBeGreaterThan(pinnedIdx);
    expect(profileIdx).toBeGreaterThan(moreIdx);
    expect(html).not.toContain("<h1>claws</h1>");
    expect(html).not.toContain('type="checkbox"');
  });

  it("uses a burger icon with a More label for the More control", () => {
    const html = buildNav("dark");
    const start = html.indexOf('<details class="nav-more">');
    const summary = html.slice(start, html.indexOf("</summary>", start));
    expect(summary).toContain('aria-label="More"');
    expect(summary).toContain("<svg");
    expect(summary).toContain('<span class="nav-more-label">More</span>');
  });

  it("puts the theme select and Logout behind the avatar menu", () => {
    const html = buildNav("dark");
    const start = html.indexOf('<details class="nav-profile">');
    expect(start).toBeGreaterThan(-1);
    const profile = html.slice(start, html.indexOf("</details>", start));
    expect(profile).toContain('aria-label="Account menu"');
    expect(profile).toContain('id="theme-select"');
    expect(profile).toContain('href="/logout"');
  });

  it("marks only the current pinned link with aria-current", () => {
    const html = buildNav("dark", "/prs");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('<a href="/prs" aria-current="page">PRs</a>');
  });

  it("marks both the More summary and the link when the current page is inside More", () => {
    const html = buildNav("dark", "/config");
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
    expect(html).toContain('<summary aria-label="More" aria-current="page">');
    expect(morePanel(html)).toContain('<a href="/config" aria-current="page">Config</a>');
  });

  it("marks the More summary when the current page is Issues", () => {
    const html = buildNav("dark", "/issues");
    expect(html).toContain('<summary aria-label="More" aria-current="page">');
    expect(morePanel(html)).toContain('<a href="/issues" aria-current="page">Issues</a>');
  });

  it("marks nothing when no current page is given", () => {
    expect(buildNav("dark")).not.toContain("aria-current");
  });

  it("is threaded through buildPageHeader's current option", () => {
    expect(buildPageHeader(null, "dark", { current: "/issues" })).toContain('<a href="/issues" aria-current="page">');
  });

  describe("operator-attention counts", () => {
    const pinnedOf = (html: string) => {
      const start = html.indexOf('class="nav-pinned"');
      return html.slice(html.indexOf(">", start) + 1, html.indexOf("</div>", start));
    };

    it("renders no count and no aria-label for a zero total or missing counts", () => {
      const zero = { attention: 0, total: 0 };
      for (const html of [buildNav("dark"), buildNav("dark", undefined, { issues: zero, prs: zero }), buildNav("dark", undefined, { sessions: 2 })]) {
        expect(html).not.toContain('class="nav-count" aria-hidden="true">0');
        expect(html).toContain('<a href="/board">Board</a>');
        expect(html).toContain('<a href="/prs">PRs</a>');
      }
      expect(pinnedOf(buildNav("dark", undefined, { issues: zero, prs: zero }))).not.toContain("aria-label");
    });

    it("shows attention/total on each link with the exact numbers in the accessible name", () => {
      const html = buildNav("dark", undefined, { issues: { attention: 12, total: 40 }, prs: { attention: 1, total: 9 } });
      expect(html).toContain('<a href="/board" aria-label="Board, 12 of 40 issues need attention">Board<span class="nav-count" aria-hidden="true">12/40</span></a>');
      expect(html).toContain('<a href="/prs" aria-label="PRs, 1 of 9 need attention">PRs<span class="nav-count" aria-hidden="true">1/9</span></a>'.replace("1 of 9 need", "1 of 9 needs"));
    });

    it("keeps the badge when attention is zero but the total is not", () => {
      const html = buildNav("dark", undefined, { issues: { attention: 0, total: 5 }, prs: { attention: 0, total: 0 } });
      expect(html).toContain('<a href="/board" aria-label="Board, 0 of 5 issues need attention">Board<span class="nav-count" aria-hidden="true">0/5</span></a>');
      expect(html).toContain('<a href="/prs">PRs</a>');
      expect(html.match(/nav-count/g)).toHaveLength(1);
    });

    it("caps each visible number at 99+ independently but keeps the exact numbers in the aria-label", () => {
      const html = buildNav("dark", "/board", { issues: { attention: 123, total: 150 }, prs: { attention: 3, total: 120 } });
      expect(html).toContain('aria-label="Board, 123 of 150 issues need attention"');
      expect(html).toContain('aria-label="PRs, 3 of 120 need attention"');
      expect(html).toContain('aria-hidden="true">99+/99+</span>');
      expect(html).toContain('aria-hidden="true">3/99+</span>');
      const all = buildNav("dark", undefined, { sessions: 101 });
      expect(all).toContain('aria-label="Sessions, 101 active"');
      expect(all).toContain('aria-hidden="true">99+</span>');
      expect(html).not.toContain(">123");
    });

    it("shows the active session count on Sessions, never on a More link", () => {
      const html = buildNav("dark", undefined, { issues: { attention: 5, total: 6 }, prs: { attention: 5, total: 6 }, sessions: 2 });
      expect(html).toContain('<a href="/sessions" aria-label="Sessions, 2 active">Sessions<span class="nav-count" aria-hidden="true">2</span></a>');
      expect(morePanel(html)).not.toContain("nav-count");
      expect(html.match(/nav-count/g)).toHaveLength(3);
    });

    it("shows nothing on Sessions for zero or unreadable sessions, while Board and PRs still render", () => {
      for (const sessions of [0, undefined]) {
        const html = buildNav("dark", undefined, { issues: { attention: 5, total: 6 }, prs: { attention: 5, total: 6 }, sessions });
        expect(html).toContain('<a href="/sessions">Sessions</a>');
        expect(html.match(/nav-count/g)).toHaveLength(2);
      }
    });

    it("uses the singular forms when the numbers are one", () => {
      const html = buildNav("dark", "/board", { issues: { attention: 1, total: 1 }, prs: { attention: 1, total: 4 } });
      expect(html).toContain('<a href="/board" aria-label="Board, 1 of 1 issue needs attention" aria-current="page">Board<span class="nav-count" aria-hidden="true">1/1</span></a>');
      expect(html).toContain('aria-label="PRs, 1 of 4 needs attention"');
    });

    it("is threaded through buildPageHeader's navCounts option", () => {
      expect(buildPageHeader(null, "dark", { current: "/prs", navCounts: { issues: { attention: 4, total: 7 } } })).toContain('aria-label="Board, 4 of 7 issues need attention"');
      expect(buildPageHeader("Login", "dark", { showNav: false, navCounts: { issues: { attention: 4, total: 7 } } })).not.toContain("nav-count");
    });

    it("sizes the count per tier", () => {
      expect(PAGE_CSS).toContain(".nav-count { color: var(--text-subtle); font-size: 0.65rem; margin-left: 0.2rem; letter-spacing: 0; }");
      expect(PAGE_CSS).toContain(".nav-count { font-size: 0.75rem; margin-left: 0.3rem; }");
    });
  });
});

describe("PREVIEW_MODAL_HTML", () => {
  it("is a labelled dialog with a close button and a markdown body", () => {
    expect(PREVIEW_MODAL_HTML).toContain('<dialog class="preview-modal" id="preview-modal" aria-labelledby="preview-modal-title">');
    expect(PREVIEW_MODAL_HTML).toContain('aria-label="Close"');
    expect(PREVIEW_MODAL_HTML).toContain('class="preview-modal-body markdown"');
  });

  it("styles the backdrop from a theme token in both themes with no animation", () => {
    expect(PAGE_CSS.match(/--backdrop:/g)).toHaveLength(3);
    const start = PAGE_CSS.indexOf(".preview-modal {");
    const block = PAGE_CSS.slice(start);
    expect(block).not.toMatch(/transition|animation/);
    expect(block).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});

describe("PAGE_CSS", () => {
  it("ships the shared responsive data-cards block", () => {
    expect(PAGE_CSS).toContain(".data-cards");
    expect(PAGE_CSS).toContain("attr(data-label)");
  });

  it("ships the data-cards-wide breakpoint for the sessions tables (#3229)", () => {
    expect(PAGE_CSS).toContain(".data-cards-wide");
    expect(PAGE_CSS).toContain("@media (max-width: 1023px)");
    const min820Index = PAGE_CSS.indexOf(".table-scroll .data-cards { min-width: 820px; }");
    const min0Index = PAGE_CSS.indexOf(".table-scroll .data-cards-wide { min-width: 0; }");
    expect(min820Index).toBeGreaterThan(-1);
    expect(min0Index).toBeGreaterThan(min820Index);
  });

  it("puts the 820px floor inside a min-width: 1024px query, not a 768px one (tablet band)", () => {
    const floorRule = ".table-scroll .data-cards { min-width: 820px; }";
    const floorIndex = PAGE_CSS.indexOf(floorRule);
    expect(floorIndex).toBeGreaterThan(-1);
    const before = PAGE_CSS.slice(0, floorIndex);
    const lastMediaQuery = before.match(/@media[^{]*\{[^{}]*$/);
    expect(lastMediaQuery?.[0]).toContain("min-width: 1024px");
    expect(PAGE_CSS).toContain("@media (min-width: 768px) and (max-width: 1023px) {\n      .table-scroll .data-cards { min-width: 0; width: 100%; }");
  });

  it("keeps the nav bar on a single nowrap row at every width, with no wrapping nav rule", () => {
    const barIdx = PAGE_CSS.indexOf(".nav-bar {");
    expect(barIdx).toBeGreaterThan(-1);
    const barBlock = PAGE_CSS.slice(barIdx, PAGE_CSS.indexOf("}", barIdx));
    expect(barBlock).toContain("flex-wrap: nowrap");
    const navRules = PAGE_CSS.match(/(^|\n)\s*(nav[ {.[]|\.nav-)[^{]*\{[^}]*\}/g) ?? [];
    expect(navRules.length).toBeGreaterThan(0);
    for (const rule of navRules) expect(rule).not.toContain("flex-wrap: wrap");
  });

  it("drops the checkbox toggle, full link list and pinned pills", () => {
    for (const cls of ["nav-favourites", "nav-toggle", "nav-links"]) {
      expect(PAGE_CSS).not.toContain(cls);
    }
  });

  it("styles pinned links as plain nav links, not pills", () => {
    const start = PAGE_CSS.indexOf(".nav-pinned {");
    expect(start).toBeGreaterThan(-1);
    const block = PAGE_CSS.slice(start, PAGE_CSS.indexOf("}", start));
    expect(block).not.toContain("border");
    const linkIdx = PAGE_CSS.indexOf("nav a {");
    const linkBlock = PAGE_CSS.slice(linkIdx, PAGE_CSS.indexOf("}", linkIdx));
    expect(linkBlock).toContain("white-space: nowrap");
    expect(linkBlock).not.toContain("border");
  });

  it("highlights the current page with an accent bottom border", () => {
    expect(PAGE_CSS).toContain('nav [aria-current="page"] { color: var(--text); border-bottom: 2px solid var(--accent); }');
  });

  it("anchors the More panel absolutely so opening it never reflows the bar", () => {
    const start = PAGE_CSS.indexOf(".nav-more-panel {");
    const block = PAGE_CSS.slice(start, PAGE_CSS.indexOf("}", start));
    expect(block).toContain("position: absolute");
    expect(block).toContain("right: 0");
    expect(PAGE_CSS).toContain(".nav-more { position: relative; margin-left: auto;");
    expect(PAGE_CSS).toContain(".nav-profile { position: relative; flex: 0 0 auto; }");
  });

  it("drops the nav wordmark styling entirely", () => {
    expect(PAGE_CSS).not.toContain("nav h1");
  });

  it("declares the display/body font tokens", () => {
    expect(PAGE_CSS).toContain("--font-display");
    expect(PAGE_CSS).toContain("IBM Plex Mono");
  });

  it("ships no page-load entrance animation (see docs/DESIGN.md — deliberate)", () => {
    expect(PAGE_CSS).not.toContain("claws-rise");
    expect(PAGE_CSS).not.toContain("prefers-reduced-motion");
  });

  it("styles form selects so Tailwind preflight does not leave them borderless", () => {
    expect(PAGE_CSS).toContain(".form-select");
    expect(PAGE_CSS).toContain(".form-field");
    expect(PAGE_CSS).not.toContain("appearance: none");
  });

  it("centres the preview modal despite Tailwind preflight zeroing margins", () => {
    const m = PAGE_CSS.match(/\.preview-modal \{[^}]*\}/);
    expect(m?.[0]).toContain("margin: auto");
  });

  it("ships no pulsing status dot (see docs/DESIGN.md — deliberate, issue #2453)", () => {
    expect(PAGE_CSS).not.toContain("@keyframes pulse");
    expect(PAGE_CSS).not.toContain("animation: pulse");
  });

  it("ships .cell-summary for responsive summary truncation", () => {
    expect(PAGE_CSS).toContain(".cell-summary");
  });
});

describe("labelChip", () => {
  it("picks a dark foreground on a pale background and a light one on a dark background", () => {
    expect(labelChip("Ready", "e0e0e0")).toContain("color:#000");
    expect(labelChip("Ready", "0e8a16")).toContain("color:#fff");
  });

  it("escapes the text and uses the given class", () => {
    const html = labelChip("<script>", "0075ca", "pipeline-badge");
    expect(html).toContain(`class="pipeline-badge"`);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("refArg", () => {
  it("renders a forge number bare and a native id quoted", () => {
    expect(refArg(42)).toBe("42");
    expect(refArg("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).toBe("'clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC'");
  });

  it("escapes a reference so it cannot break out of the attribute", () => {
    expect(refArg(`a"b`)).toBe(`'a&quot;b'`);
  });
});

describe("htmlOpenTag width tier", () => {
  it("emits no data-width for the default tier", () => {
    expect(htmlOpenTag("dark")).toBe('<html lang="en" data-theme="dark">');
  });

  it("emits data-width for a named tier alongside a theme", () => {
    expect(htmlOpenTag("dark", "wide")).toBe('<html lang="en" data-theme="dark" data-width="wide">');
  });

  it("emits data-width for the system theme, which otherwise renders a bare tag", () => {
    expect(htmlOpenTag("system", "full")).toBe('<html lang="en" data-width="full">');
  });
});

describe("PAGE_CSS page width tokens", () => {
  it("defines --page-width and applies it to body's max-width", () => {
    expect(PAGE_CSS).toContain("--page-width: 64rem");
    expect(PAGE_CSS).toContain("max-width: var(--page-width)");
  });

  it("caps nav at the constant --chrome-width, never the page width", () => {
    expect(PAGE_CSS).toContain("--chrome-width: 60rem");
    const start = PAGE_CSS.indexOf("\n    nav {");
    expect(start).toBeGreaterThan(-1);
    const navRule = PAGE_CSS.slice(start, PAGE_CSS.indexOf("}", start));
    expect(navRule).toContain("max-width: var(--chrome-width)");
    expect(navRule).toContain("margin-inline: auto");
    expect(navRule).not.toContain("--page-width");
  });

  it("reserves the scrollbar gutter so the nav centre does not shift between pages", () => {
    expect(PAGE_CSS).toContain("scrollbar-gutter: stable");
  });
});

describe("formatCompactAge", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("rounds down to the largest whole unit", () => {
    expect(formatCompactAge(ago(59_000), now)).toBe("<1m");
    expect(formatCompactAge(ago(60_000), now)).toBe("1m");
    expect(formatCompactAge(ago(59 * 60_000), now)).toBe("59m");
    expect(formatCompactAge(ago(60 * 60_000), now)).toBe("1h");
    expect(formatCompactAge(ago(24 * 3_600_000 - 1), now)).toBe("23h");
    expect(formatCompactAge(ago(24 * 3_600_000), now)).toBe("1d");
    expect(formatCompactAge(ago(40 * 86_400_000), now)).toBe("40d");
  });
  it("reads a future time as just now", () => {
    expect(formatCompactAge(ago(-5 * 60_000), now)).toBe("<1m");
  });
  it("returns empty for an empty or unparseable input", () => {
    expect(formatCompactAge("", now)).toBe("");
    expect(formatCompactAge("not a date", now)).toBe("");
  });
});

describe("repoAvatar", () => {
  it("renders only the neutral initial when the repo declares no avatar", () => {
    clearRepoConfigCache();
    const html = repoAvatar("org/widget");
    expect(html).toBe('<span class="repo-avatar" aria-hidden="true">w</span>');
    expect(html).not.toContain("<img");
  });

  it("layers the declared avatar over the initial, falling back to it on a load error", async () => {
    clearRepoConfigCache();
    await refreshRepoConfigs([{ fullName: "org/widget" }], async () => JSON.stringify({ avatar: "docs/avatar.png" }));
    const html = repoAvatar("org/widget");
    expect(html).toContain(">w<img");
    expect(html).toContain('src="/repo-avatar/org/widget?v=docs%2Favatar.png"');
    expect(html).toContain('onerror="this.remove()"');
    clearRepoConfigCache();
  });

  it("emits no image for an invalid avatar path", async () => {
    clearRepoConfigCache();
    await refreshRepoConfigs([{ fullName: "org/widget" }], async () => JSON.stringify({ avatar: "https://x/y.png" }));
    expect(repoAvatar("org/widget")).not.toContain("<img");
    clearRepoConfigCache();
  });

  it("styles the avatar in PAGE_CSS", () => {
    expect(PAGE_CSS).toContain(".repo-avatar {");
    expect(PAGE_CSS).toContain(".repo-avatar img {");
  });

  it("sizes the avatar at 1.5x the surrounding text with negative vertical margins", () => {
    const start = PAGE_CSS.indexOf(".repo-avatar {");
    const block = PAGE_CSS.slice(start, PAGE_CSS.indexOf("}", start));
    expect(block).toContain("width: 1.667em");
    expect(block).toContain("font-size: 0.9em");
    expect(block).toContain("margin: -0.2em 0.4em -0.2em 0");
  });
});

describe("navLinkCount", () => {
  it("names each pinned link's badge as buildNav does", () => {
    const counts = { issues: { attention: 3, total: 7 }, prs: { attention: 1, total: 120 }, sessions: 2 };
    expect(navLinkCount("/board", counts)).toEqual({ text: "3/7", name: "Board, 3 of 7 issues need attention" });
    expect(navLinkCount("/prs", counts)).toEqual({ text: "1/99+", name: "PRs, 1 of 120 needs attention" });
    expect(navLinkCount("/sessions", counts)).toEqual({ text: "2", name: "Sessions, 2 active" });
    expect(navLinkCount("/board", { issues: { attention: 1, total: 1 } })?.name).toBe("Board, 1 of 1 issue needs attention");
  });

  it("is null for a zero total or missing count, and for a link that carries none", () => {
    expect(navLinkCount("/board", { issues: { attention: 0, total: 0 }, prs: { attention: 4, total: 4 } })).toBeNull();
    expect(navLinkCount("/sessions", { issues: { attention: 2, total: 2 } })).toBeNull();
    expect(navLinkCount("/prs")).toBeNull();
    expect(navLinkCount("/issues", { issues: { attention: 5, total: 5 } })).toBeNull();
  });
});
