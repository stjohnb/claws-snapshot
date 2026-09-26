import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  ACTIVATION_STATE: "active",
}));

import { anthropicLabel, openaiLabel, buildPageHeader, buildNav, PAGE_CSS, labelChip, refArg, htmlOpenTag, formatCompactAge } from "./layout.js";
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
  it("renders site title, nav, and subtitle when pageTitle is set", () => {
    const html = buildPageHeader("Queue", "dark");
    expect(html).toContain("<h1>claws</h1>");
    expect(html).toContain("<nav>");
    expect(html).toContain("<h2>Queue</h2>");
  });

  it("puts the wordmark inside the nav bar rather than as a standalone heading", () => {
    const html = buildPageHeader("Queue", "dark");
    expect(html.indexOf("<h1>claws</h1>")).toBeGreaterThan(html.indexOf("<nav>"));
  });

  it("omits the subtitle when pageTitle is null", () => {
    const html = buildPageHeader(null, "dark");
    expect(html).toContain("<h1>claws</h1>");
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
  it("renders a CSS-only mobile disclosure that keeps existing links intact", () => {
    const html = buildNav("system");
    expect(html).toContain('id="nav-toggle"');
    expect(html).toContain('class="nav-links"');
    expect(html).toContain('for="nav-toggle"');
    expect(html).toContain('href="/prs"');
    expect(html).toContain('id="theme-select"');
  });

  it("renders an always-visible favourites bar with exactly Board, Issues, PRs and Sessions", () => {
    const html = buildNav("dark");
    const favIdx = html.indexOf('class="nav-favourites"');
    expect(favIdx).toBeGreaterThan(-1);
    const fav = html.slice(favIdx);
    const hrefs = [...fav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/board", "/issues", "/prs", "/sessions"]);
  });

  it("keeps the favourite links in the full menu and drops the removed pages", () => {
    const html = buildNav("dark");
    const links = html.slice(html.indexOf('class="nav-links"'), html.indexOf('class="nav-favourites"'));
    for (const href of ["/board", "/prs", "/sessions", "/issues", "/jobs", "/config"]) {
      expect(links).toContain(`href="${href}"`);
    }
    for (const href of ["/queue", "/topology", "/repos", "/runners", "/logs", "/verify", "/logout"]) {
      expect(links).not.toContain(`href="${href}"`);
    }
  });

  it("puts the theme select and Logout behind the profile dropdown", () => {
    const html = buildNav("dark");
    const start = html.indexOf('<details class="nav-profile">');
    expect(start).toBeGreaterThan(-1);
    const profile = html.slice(start, html.indexOf("</details>", start));
    expect(profile).toContain("<summary>Profile ▾</summary>");
    expect(profile).toContain('id="theme-select"');
    expect(profile).toContain('href="/logout"');
    // Sits before .nav-links so it shares the hamburger row on phones.
    expect(start).toBeLessThan(html.indexOf('class="nav-links"'));
  });

  it("puts the wordmark in the bar, after the Menu toggle and before the profile dropdown", () => {
    const html = buildNav("dark");
    const toggleIdx = html.indexOf('for="nav-toggle"');
    const h1Idx = html.indexOf("<h1>claws</h1>");
    const profileIdx = html.indexOf('<details class="nav-profile">');
    const linksIdx = html.indexOf('class="nav-links"');
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(h1Idx).toBeGreaterThan(toggleIdx);
    expect(h1Idx).toBeLessThan(profileIdx);
    // The toggle checkbox must remain a preceding sibling of .nav-links for
    // the .nav-toggle:checked ~ .nav-links selector to work.
    expect(html.indexOf('id="nav-toggle"')).toBeLessThan(linksIdx);
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

  it("hides the favourites bar at desktop widths", () => {
    expect(PAGE_CSS).toContain(".nav-favourites");
    expect(PAGE_CSS).toContain("@media (min-width: 768px)");
  });

  it("sizes the wordmark to fit inside the nav bar", () => {
    expect(PAGE_CSS).toContain("nav h1");
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

  it("centres the nav at a constant --chrome-width regardless of page content width", () => {
    expect(PAGE_CSS).toContain("nav, .warning-banner { max-width: var(--chrome-width); margin-left: auto; margin-right: auto; }");
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
