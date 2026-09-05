import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  LABELS: { priority: "Priority", clawsIgnore: "Claws Ignore" },
  OPENROUTER_API_KEY: "test-key",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("../prompt-guard.js", () => ({
  guardContent: (text: string) => text,
  makeGuardCtx: (repo: string, itemNumber: number) => (source: string) => ({ repo, source, itemNumber }),
  formatGuardedTitleList: (titles: string[]) =>
    titles.length === 0 ? "  (none)" : titles.map((t) => `  - ${t}`).join("\n"),
}));

vi.mock("../model-selector.js", () => ({
  getModel: vi.fn(() => "opencode-sonnet-test"),
}));

vi.mock("../github.js", () => ({
  listRepoDirectory: vi.fn(),
  fetchRepoFileContent: vi.fn(),
  listOpenIssues: vi.fn(),
  findIssueByExactTitle: vi.fn(),
  createIssue: vi.fn(),
}));

vi.mock("../claude.js", () => ({
  randomSuffix: vi.fn(() => "abcd"),
  withNewWorktree: vi.fn(),
  runClaude: vi.fn(),
  isOpenCodeBinaryAvailable: vi.fn(() => true),
}));

vi.mock("../db.js", () => ({
  withTaskRecording: vi.fn(),
  updateTaskWorktree: vi.fn(),
  updateTaskModel: vi.fn(),
  recordTaskComplete: vi.fn(),
  trackTaskTokens: vi.fn(() => vi.fn()),
  getPromotionActionTimestamps: vi.fn(() => new Map<string, string>()),
  recordPromotionActionFiled: vi.fn(),
}));

vi.mock("../occurrence-tracking.js", () => ({
  upsertAlertIssue: vi.fn(),
  closeAlertIssueIfResolved: vi.fn(),
}));

import { PROMOTION_MANIFEST_TEMPLATE } from "../agents/agent-context.js";
import {
  parseManifest,
  resolveChannels,
  dueChannels,
  sanitizeActions,
  buildPrompt,
  filterChannelsToManagedRepos,
  PROMOTION_CHANNELS,
  type ResolvedChannel,
  type Site,
} from "./site-promoter.js";

function siteFrom(yaml: string): Site {
  const result = parseManifest("promotion.yaml", yaml);
  if (!result.ok) throw new Error(`expected a valid manifest, got: ${result.error}`);
  return result.manifest.sites[0]!;
}

const VALID_MANIFEST = `project: Namey
sites:
  - id: namey-baby
    name: Namey (baby names)
    url: https://namey.baby/
    audience: Expectant parents
    pitch: Baby-name discovery and shortlisting app.
    channels:
      - seo-content
      - id: reddit
        cadence_days: 30
        notes: Only r/namenerds; no link in the post body.
      - id: guest-blog
        target_repo: St-John-Software/bstjohn-blog
`;

/** A SQLite-style UTC timestamp `daysAgo` days before `now`. */
function ago(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
}

function channel(id: string, overrides: Partial<ResolvedChannel> = {}): ResolvedChannel {
  const base = PROMOTION_CHANNELS.find((c) => c.id === id)!;
  return { ...base, ...overrides };
}

describe("parseManifest", () => {
  it("parses the documented template", () => {
    const result = parseManifest("namey.yaml", PROMOTION_MANIFEST_TEMPLATE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.project).toBe("Namey");
    expect(result.manifest.sites).toHaveLength(1);
    expect(result.manifest.sites[0]!.status).toBe("active");
    expect(result.manifest.sites[0]!.channels).toHaveLength(4);
  });

  it("parses a valid manifest and applies defaults", () => {
    const result = parseManifest("namey.yaml", VALID_MANIFEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.sites[0]!.status).toBe("active");
  });

  it("rejects invalid YAML", () => {
    const result = parseManifest("bad.yaml", "project: [unclosed\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^invalid YAML: /);
  });

  it("rejects a site missing name", () => {
    const result = parseManifest("bad.yaml", "project: X\nsites:\n  - id: a\n    url: https://a.test/\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^sites\.0\.name: /);
  });

  it("rejects a non-URL url", () => {
    const result = parseManifest("bad.yaml", "project: X\nsites:\n  - id: a\n    name: A\n    url: not-a-url\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^sites\.0\.url: /);
  });

  it("rejects a duplicate site id", () => {
    const yaml = `project: X
sites:
  - id: a
    name: A
    url: https://a.test/
  - id: a
    name: A again
    url: https://a2.test/
`;
    const result = parseManifest("bad.yaml", yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('duplicate site id "a"');
  });

  it("rejects an unknown channel id", () => {
    const yaml = `project: X
sites:
  - id: a
    name: A
    url: https://a.test/
    channels: [carrier-pigeon]
`;
    const result = parseManifest("bad.yaml", yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('site "a": unknown channel "carrier-pigeon"');
  });

  it("rejects a duplicate channel within a site", () => {
    const yaml = `project: X
sites:
  - id: a
    name: A
    url: https://a.test/
    channels:
      - reddit
      - id: reddit
        cadence_days: 7
`;
    const result = parseManifest("bad.yaml", yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('site "a": duplicate channel "reddit"');
  });
});

describe("resolveChannels", () => {
  it("applies cadence, notes and target_repo overrides and leaves defaults otherwise", () => {
    const resolved = resolveChannels(siteFrom(VALID_MANIFEST));
    expect(resolved.map((c) => c.id)).toEqual(["seo-content", "reddit", "guest-blog"]);

    const seo = resolved[0]!;
    expect(seo.cadenceDays).toBe(PROMOTION_CHANNELS.find((c) => c.id === "seo-content")!.cadenceDays);
    expect(seo.notes).toBeUndefined();
    expect(seo.targetRepo).toBeUndefined();

    const reddit = resolved[1]!;
    expect(reddit.cadenceDays).toBe(30);
    expect(reddit.notes).toBe("Only r/namenerds; no link in the post body.");
    expect(reddit.mode).toBe("manual");

    const blog = resolved[2]!;
    expect(blog.targetRepo).toBe("St-John-Software/bstjohn-blog");
    expect(blog.cadenceDays).toBe(PROMOTION_CHANNELS.find((c) => c.id === "guest-blog")!.cadenceDays);
  });
});

describe("filterChannelsToManagedRepos", () => {
  it("keeps channels with no target_repo and those targeting a managed repo", () => {
    const channels = resolveChannels(siteFrom(VALID_MANIFEST));
    const kept = filterChannelsToManagedRepos(
      "St-John-Software/namey",
      "namey-baby",
      channels,
      new Set(["St-John-Software/namey", "St-John-Software/bstjohn-blog"]),
    );
    expect(kept.map((c) => c.id)).toEqual(["seo-content", "reddit", "guest-blog"]);
  });

  it("drops a channel whose target_repo is not Claws-managed", () => {
    const channels = resolveChannels(siteFrom(VALID_MANIFEST));
    const kept = filterChannelsToManagedRepos(
      "St-John-Software/namey",
      "namey-baby",
      channels,
      new Set(["St-John-Software/namey"]),
    );
    expect(kept.map((c) => c.id)).toEqual(["seo-content", "reddit"]);
  });
});

describe("dueChannels", () => {
  const now = new Date("2026-09-04T12:00:00Z");

  it("puts never-filed channels first", () => {
    const channels = [channel("x"), channel("seo-content")];
    const last = new Map([["x", ago(now, 100)]]);
    expect(dueChannels(channels, last, now).map((c) => c.id)).toEqual(["seo-content", "x"]);
  });

  it("excludes a channel filed inside its cadence and includes one filed outside it", () => {
    // x: 14 days, seo-content: 14 days.
    const channels = [channel("x"), channel("seo-content")];
    const last = new Map([
      ["x", ago(now, 3)],
      ["seo-content", ago(now, 20)],
    ]);
    expect(dueChannels(channels, last, now).map((c) => c.id)).toEqual(["seo-content"]);
  });

  it("honours a manifest cadence override", () => {
    const channels = [channel("reddit", { cadenceDays: 90 })];
    const last = new Map([["reddit", ago(now, 30)]]);
    expect(dueChannels(channels, last, now)).toEqual([]);
    expect(dueChannels(channels, new Map([["reddit", ago(now, 120)]]), now).map((c) => c.id)).toEqual(["reddit"]);
  });

  it("treats an unparseable timestamp as never filed", () => {
    const channels = [channel("product-hunt")];
    expect(dueChannels(channels, new Map([["product-hunt", "not a date"]]), now).map((c) => c.id)).toEqual([
      "product-hunt",
    ]);
  });

  it("caps at MAX_CHANNELS_PER_SITE", () => {
    const channels = [channel("x"), channel("bluesky"), channel("reddit"), channel("tiktok"), channel("aeo")];
    expect(dueChannels(channels, new Map(), now)).toHaveLength(3);
  });
});

describe("sanitizeActions", () => {
  const due = new Set(["seo-content", "reddit", "bluesky"]);

  it("drops actions for channels that are not due", () => {
    const parsed = { actions: [{ channel: "tiktok", title: "T", body: "B", score: 9 }] };
    expect(sanitizeActions(parsed, due)).toEqual([]);
  });

  it("drops sub-threshold scores", () => {
    const parsed = { actions: [{ channel: "reddit", title: "R", body: "B", score: 6 }] };
    expect(sanitizeActions(parsed, due)).toEqual([]);
  });

  it("keeps only the first action per channel", () => {
    const parsed = {
      actions: [
        { channel: "reddit", title: "First", body: "B", score: 8 },
        { channel: "reddit", title: "Second", body: "B", score: 10 },
      ],
    };
    expect(sanitizeActions(parsed, due).map((a) => a.title)).toEqual(["First"]);
  });

  it("caps at MAX_ACTIONS_PER_SITE, highest score first", () => {
    const parsed = {
      actions: [
        { channel: "seo-content", title: "S", body: "B", score: 8 },
        { channel: "reddit", title: "R", body: "B", score: 10 },
        { channel: "bluesky", title: "Bs", body: "B", score: 9 },
      ],
    };
    expect(sanitizeActions(parsed, due).map((a) => a.title)).toEqual(["R", "Bs"]);
  });
});

describe("buildPrompt", () => {
  it("includes the site URL, every due channel, the owner's notes, the read-first instruction and the JSON contract", () => {
    const site = siteFrom(VALID_MANIFEST);
    const due = resolveChannels(site);
    const titles = new Map([
      ["St-John-Software/namey", ["Existing open issue"]],
      ["St-John-Software/bstjohn-blog", []],
    ]);
    const prompt = buildPrompt("St-John-Software/namey", site, due, titles);

    expect(prompt).toContain("https://namey.baby/");
    expect(prompt).toContain("Expectant parents");
    for (const c of due) expect(prompt).toContain(`\`${c.id}\``);
    expect(prompt).toContain("Only r/namenerds; no link in the post body.");
    expect(prompt).toMatch(/Before proposing anything, read the code/);
    expect(prompt).toContain('{"actions":[{"channel":');
    expect(prompt).toContain("Existing open issue");
    expect(prompt).toContain("St-John-Software/bstjohn-blog");
  });
});
