import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  LABELS: { priority: "Priority", clawsIgnore: "Claws Ignore" },
  SELF_REPO: "St-John-Software/claws",
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
}));

vi.mock("../model-selector.js", () => ({
  getModel: vi.fn(() => "claude-sonnet-test"),
}));

const { mockGh, mockClaude, mockDb, mockOccurrence } = vi.hoisted(() => ({
  mockGh: {
    listRepoDirectory: vi.fn(),
    fetchRepoFileContent: vi.fn(),
  },
  mockClaude: {
    ensureScratchDir: vi.fn((namespace: string) => `/home/testuser/.claws/scratch/${namespace}`),
    writeClawsMcpConfig: vi.fn((dir: string, _options?: Record<string, unknown>) => `${dir}/.mcp-claws.json`),
    runClaude: vi.fn(),
    BROWSER_AGENT_MEMORY_MAX_BYTES: 4 * 1024 * 1024 * 1024,
  },
  mockDb: {
    getShoppingSearches: vi.fn(() => [] as { itemId: string; lastSearchedAt: string; resultJson: string }[]),
    getAllShoppingSearches: vi.fn(() => [] as { repo: string; manifest: string; resultJson: string }[]),
    recordShoppingSearch: vi.fn(),
    recordShoppingSourcingError: vi.fn(),
    updateTaskModel: vi.fn(),
    recordTaskComplete: vi.fn(),
    trackTaskTokens: vi.fn(() => vi.fn()),
    withTaskRecording: vi.fn(
      async (
        _jobName: string,
        _repo: string,
        _itemNumber: number,
        _triggerLabel: string | null,
        fn: (taskId: number) => Promise<unknown>,
      ) => fn(1),
    ),
  },
  mockOccurrence: {
    upsertAlertIssue: vi.fn(
      async (_opts: { repo: string; title: string; body: string; labels: string[]; logPrefix: string }) =>
        "created" as "created" | "updated" | "unchanged",
    ),
    closeAlertIssueIfResolved: vi.fn(
      async (_opts: { repo: string; title: string; logPrefix: string; reason?: string }) =>
        null as number | null,
    ),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../occurrence-tracking.js", () => mockOccurrence);

import {
  parseManifest,
  sourceableItems,
  outstandingItems,
  dueItems,
  sanitizeAgentResult,
  candidatesUnchanged,
  normalizePriceForCompare,
  stableResult,
  buildPrompt,
  buildConsolidatedIssueBody,
  collectPreferredStores,
  storeKey,
  CONSOLIDATED_ISSUE_TITLE,
  AgentResultSchema,
  run,
  type ManifestState,
  type ShoppingItem,
  type ShoppingManifest,
  type StoredCandidate,
  type StoredResult,
} from "./shopping-sourcer.js";

const VALID_MANIFEST = `project: NAS expansion
active_phases: [1]
items:
  - id: hba-9207-8e
    name: LSI SAS 9207-8e HBA (IT mode)
    max_price: "£40"
    notes: Must be SAS2308, not 9200-8e
  - id: sas-cable
    name: SFF-8088 to SFF-8088 cable
    phase: 2
`;

function dirEntry(name: string) {
  return { name, path: `docs/shopping/${name}`, sha: "abc", type: "file" };
}

describe("parseManifest", () => {
  it("parses a valid manifest and applies defaults", () => {
    const result = parseManifest("nas-expansion.yaml", VALID_MANIFEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.project).toBe("NAS expansion");
    expect(result.manifest.active_phases).toEqual([1]);
    const first = result.manifest.items[0]!;
    expect(first.phase).toBe(1);
    expect(first.status).toBe("sourcing");
    expect(first.recheck_days).toBe(1);
  });

  it("rejects invalid YAML", () => {
    const result = parseManifest("bad.yaml", "project: [unclosed\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invalid YAML/);
  });

  it("rejects a manifest missing project", () => {
    const result = parseManifest("bad.yaml", "items: []\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/project/);
  });

  it("rejects an unknown status value", () => {
    const result = parseManifest(
      "bad.yaml",
      `project: X\nitems:\n  - id: a\n    name: A\n    status: pending\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/status/);
  });

  it("rejects duplicate item ids", () => {
    const result = parseManifest(
      "bad.yaml",
      `project: X\nitems:\n  - id: a\n    name: A\n  - id: a\n    name: B\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('duplicate item id "a"');
  });
});

describe("selection", () => {
  function parsed(yaml: string) {
    const r = parseManifest("m.yaml", yaml);
    if (!r.ok) throw new Error(r.error);
    return r.manifest;
  }

  it("excludes items in a gated phase", () => {
    const ids = sourceableItems(parsed(VALID_MANIFEST)).map((i) => i.id);
    expect(ids).toEqual(["hba-9207-8e"]);
  });

  it("excludes non-sourcing statuses", () => {
    const manifest = parsed(
      `project: X\nactive_phases: [1]\nitems:\n` +
        `  - id: a\n    name: A\n    status: delivered\n` +
        `  - id: b\n    name: B\n    status: ordered\n` +
        `  - id: c\n    name: C\n    status: skip\n` +
        `  - id: d\n    name: D\n`,
    );
    expect(sourceableItems(manifest).map((i) => i.id)).toEqual(["d"]);
  });

  it("outstandingItems keeps everything but delivered/skip", () => {
    const manifest = parsed(
      `project: X\nactive_phases: [1]\nitems:\n` +
        `  - id: a\n    name: A\n    status: sourcing\n` +
        `  - id: b\n    name: B\n    status: found\n` +
        `  - id: c\n    name: C\n    status: ordered\n` +
        `  - id: d\n    name: D\n    status: delivered\n` +
        `  - id: e\n    name: E\n    status: skip\n`,
    );
    expect(outstandingItems(manifest).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("throttles items searched within their recheck window", () => {
    const now = new Date("2026-08-15T12:00:00Z");
    const items = sourceableItems(
      parsed(`project: X\nitems:\n  - id: a\n    name: A\n    recheck_days: 1\n`),
    );

    // 2 hours ago — not due.
    const recent = new Map([["a", "2026-08-15 10:00:00"]]);
    expect(dueItems(items, recent, now)).toEqual([]);

    // 25 hours ago — due.
    const stale = new Map([["a", "2026-08-14 11:00:00"]]);
    expect(dueItems(items, stale, now).map((i) => i.id)).toEqual(["a"]);
  });

  it("caps at 8 items per run, oldest-searched first", () => {
    const now = new Date("2026-08-15T12:00:00Z");
    const items: ShoppingItem[] = Array.from({ length: 10 }, (_, n) => ({
      id: `i${n}`,
      name: `Item ${n}`,
      phase: 1,
      status: "sourcing" as const,
      recheck_days: 1,
    }));
    // i9 oldest, i0 newest — all outside the recheck window.
    const last = new Map(items.map((i, n) => [i.id, `2026-08-${String(10 - n).padStart(2, "0")} 00:00:00`]));

    const due = dueItems(items, last, now);
    expect(due).toHaveLength(8);
    expect(due[0]!.id).toBe("i9");
    expect(due.map((i) => i.id)).not.toContain("i0");
  });
});

describe("sanitizeAgentResult", () => {
  const dueIds = new Set(["a"]);

  it("drops candidates with non-http(s) URLs", () => {
    const raw = AgentResultSchema.parse({
      items: [
        {
          id: "a",
          candidates: [
            { title: "Evil", url: "javascript:alert(1)" },
            { title: "Not a URL", url: "not a url" },
            { title: "Fine", url: "https://example.com/x" },
          ],
        },
      ],
    });
    const out = sanitizeAgentResult(raw, dueIds);
    expect(out.get("a")!.candidates.map((c) => c.title)).toEqual(["Fine"]);
  });

  it("slices to 5 candidates per item", () => {
    const raw = AgentResultSchema.parse({
      items: [
        {
          id: "a",
          candidates: Array.from({ length: 9 }, (_, n) => ({
            title: `C${n}`,
            url: `https://example.com/${n}`,
          })),
        },
      ],
    });
    expect(sanitizeAgentResult(raw, dueIds).get("a")!.candidates).toHaveLength(5);
  });

  it("drops items the agent invented", () => {
    const raw = AgentResultSchema.parse({ items: [{ id: "not-due", candidates: [] }] });
    expect(sanitizeAgentResult(raw, dueIds).size).toBe(0);
  });

  it("normalizes the URL, percent-encoding whitespace and angle brackets", () => {
    const raw = AgentResultSchema.parse({
      items: [
        {
          id: "a",
          candidates: [{ title: "Spoofed", url: "https://example.com/x) [pwned](<https://evil.example>" }],
        },
      ],
    });
    const url = sanitizeAgentResult(raw, dueIds).get("a")!.candidates[0].url;
    expect(url).not.toContain("<");
    expect(url).not.toContain(">");
    expect(url).not.toMatch(/\s/);
  });
});

describe("candidatesUnchanged", () => {
  it("treats a reordered identical set as unchanged", () => {
    const a: StoredCandidate[] = [
      { title: "A", url: "https://example.com/a", price: "£10" },
      { title: "B", url: "https://example.com/b", price: "£20" },
    ];
    const b: StoredCandidate[] = [
      { title: "B (different wording)", url: "https://example.com/b", price: "£20" },
      { title: "A", url: "https://example.com/a", price: "£10" },
    ];
    expect(candidatesUnchanged(a, b)).toBe(true);
  });

  it("treats a changed price on the same URL as changed", () => {
    const a: StoredCandidate[] = [{ title: "A", url: "https://example.com/a", price: "£10" }];
    const b: StoredCandidate[] = [{ title: "A", url: "https://example.com/a", price: "£12" }];
    expect(candidatesUnchanged(a, b)).toBe(false);
  });

  it("treats a different note on the same URL/price as unchanged", () => {
    const a: StoredCandidate[] = [{ title: "A", url: "https://example.com/a", price: "£10", note: "old note" }];
    const b: StoredCandidate[] = [{ title: "A", url: "https://example.com/a", price: "£10", note: "new note" }];
    expect(candidatesUnchanged(a, b)).toBe(true);
  });

  it("treats differing lengths as changed", () => {
    const a: StoredCandidate[] = [{ title: "A", url: "https://example.com/a", price: "£10" }];
    const b: StoredCandidate[] = [
      { title: "A", url: "https://example.com/a", price: "£10" },
      { title: "C", url: "https://example.com/c", price: "£5" },
    ];
    expect(candidatesUnchanged(a, b)).toBe(false);
  });

  it("treats a re-worded price with the same amount as unchanged", () => {
    const a: StoredCandidate[] = [{ title: "A", url: "https://example.com/a", price: "£5.29" }];
    const b: StoredCandidate[] = [
      { title: "A", url: "https://example.com/a", price: "£5.29 + £1.79 postage (£7.08 total)" },
    ];
    expect(candidatesUnchanged(a, b)).toBe(true);
  });

  it("treats a different amount in the re-worded price as changed", () => {
    const a: StoredCandidate[] = [{ title: "A", url: "https://example.com/a", price: "£5.29" }];
    const b: StoredCandidate[] = [{ title: "A", url: "https://example.com/a", price: "£6.50" }];
    expect(candidatesUnchanged(a, b)).toBe(false);
  });

  it("treats a missing price on both sides as unchanged, and undefined vs a price as changed", () => {
    const a: StoredCandidate[] = [{ title: "A", url: "https://example.com/a" }];
    const b: StoredCandidate[] = [{ title: "A", url: "https://example.com/a" }];
    expect(candidatesUnchanged(a, b)).toBe(true);

    const c: StoredCandidate[] = [{ title: "A", url: "https://example.com/a", price: "£10" }];
    expect(candidatesUnchanged(a, c)).toBe(false);
  });
});

describe("normalizePriceForCompare", () => {
  it("ignores postage prose appended after the base price", () => {
    expect(normalizePriceForCompare("£5.29 + £1.79 postage (£7.08 total)")).toBe(
      normalizePriceForCompare("£5.29"),
    );
  });

  it("returns an empty string for undefined", () => {
    expect(normalizePriceForCompare(undefined)).toBe("");
  });
});

describe("stableResult", () => {
  it("keeps the previous result when the fresh search found nothing", () => {
    const previous: StoredResult = {
      candidates: [{ title: "A", url: "https://example.com/a", price: "£10" }],
    };
    const fresh: StoredResult = { candidates: [] };
    expect(stableResult(previous, fresh)).toBe(previous);
  });

  it("uses the fresh result when there is no previous result", () => {
    const fresh: StoredResult = { candidates: [] };
    expect(stableResult(undefined, fresh)).toBe(fresh);
  });

  it("uses the fresh result when the previous result had no candidates", () => {
    const previous: StoredResult = { candidates: [] };
    const fresh: StoredResult = {
      candidates: [{ title: "A", url: "https://example.com/a", price: "£10" }],
    };
    expect(stableResult(previous, fresh)).toBe(fresh);
  });

  it("keeps the previous wording when the candidate sets match", () => {
    const previous: StoredResult = {
      summary: "Old summary.",
      candidates: [{ title: "A", url: "https://example.com/a", price: "£10" }],
    };
    const fresh: StoredResult = {
      summary: "New summary.",
      candidates: [{ title: "A", url: "https://example.com/a", price: "£10" }],
    };
    expect(stableResult(previous, fresh)).toBe(previous);
  });
});

describe("buildPrompt", () => {
  function parsed(yaml: string): ShoppingManifest {
    const r = parseManifest("m.yaml", yaml);
    if (!r.ok) throw new Error(r.error);
    return r.manifest;
  }

  const manifest = parsed(VALID_MANIFEST);
  const items = sourceableItems(manifest);

  it("omits the already-listed block when there is no previous result", () => {
    const prompt = buildPrompt(manifest, items, new Map());
    expect(prompt).not.toContain("re-check these first");
  });

  it("includes the previous candidate's URL and price and the exact-copy instruction", () => {
    const previous = new Map<string, StoredResult>([
      [
        "hba-9207-8e",
        { candidates: [{ title: "LSI 9207-8e", url: "https://example.com/x", price: "£38.00" }] },
      ],
    ]);
    const prompt = buildPrompt(manifest, items, previous);
    expect(prompt).toContain("re-check these first");
    expect(prompt).toContain("https://example.com/x");
    expect(prompt).toContain("£38.00");
    expect(prompt).toContain("copied **exactly**");
  });

  it("compiles and returns a string when called with two arguments", () => {
    const prompt = buildPrompt(manifest, items);
    expect(typeof prompt).toBe("string");
  });
});

describe("storeKey", () => {
  it("normalizes the hostname and strips www.", () => {
    expect(storeKey("https://www.eBay.co.uk/itm/1")).toBe("ebay.co.uk");
    expect(storeKey("https://ebay.co.uk/itm/2")).toBe("ebay.co.uk");
  });

  it("falls back to `other` for an unparseable URL", () => {
    expect(storeKey("not a url")).toBe("other");
  });
});

describe("buildConsolidatedIssueBody", () => {
  function state(
    repoFullName: string,
    path: string,
    yaml: string,
    results: Record<string, StoredResult> = {},
  ): ManifestState {
    const r = parseManifest("m.yaml", yaml);
    if (!r.ok) throw new Error(r.error);
    return { repoFullName, path, manifest: r.manifest, results: new Map(Object.entries(results)) };
  }

  const NAS = state("test-org/nixos-config", "docs/shopping/nas-expansion.yaml", VALID_MANIFEST, {
    "hba-9207-8e": {
      summary: "Checked eBay UK.",
      candidates: [
        { title: "LSI 9207-8e | IT mode", url: "https://www.ebay.co.uk/itm/1", price: "£38.00" },
      ],
    },
  });
  const CARLINK = state(
    "test-org/ha-carlink",
    "docs/shopping/ha-carlink-hardware.yaml",
    `project: HA CarLink\nitems:\n  - id: esp32\n    name: ESP32-S3 board\n`,
    {
      esp32: {
        candidates: [{ title: "ESP32-S3 DevKit", url: "https://ebay.co.uk/itm/2", price: "£9" }],
      },
    },
  );

  it("links each project at its manifest and counts sourcing/outstanding items", () => {
    const body = buildConsolidatedIssueBody([NAS]);
    expect(body).toContain(
      "- [NAS expansion](https://github.com/test-org/nixos-config/blob/HEAD/docs/shopping/nas-expansion.yaml) — 1 sourcing, 2 outstanding",
    );
    // Per-project item detail lives in the manifest, not here (#2647).
    expect(body).not.toContain("SFF-8088 to SFF-8088 cable —");
    expect(body).toContain("docs/jobs/shopping-sourcer.md");
  });

  it("groups candidates from two projects on the same host into one basket", () => {
    const body = buildConsolidatedIssueBody([NAS, CARLINK]);
    const headings = body.split("\n").filter((l) => l.startsWith("### "));
    expect(headings).toEqual(["### ebay.co.uk — 2 candidate(s) across 2 project(s)"]);
    expect(body).toContain("- [LSI 9207-8e | IT mode](<https://www.ebay.co.uk/itm/1>) — £38.00 — for LSI SAS 9207-8e HBA (IT mode) (NAS expansion)");
    expect(body).toContain("- [ESP32-S3 DevKit](<https://ebay.co.uk/itm/2>) — £9 — for ESP32-S3 board (HA CarLink)");
  });

  it("orders a two-project store above a single-project store with more candidates", () => {
    const wide = state("test-org/a", "docs/shopping/a.yaml", `project: A\nitems:\n  - id: x\n    name: X\n`, {
      x: { candidates: [{ title: "X", url: "https://shared.example/1" }] },
    });
    const deep = state("test-org/b", "docs/shopping/b.yaml", `project: B\nitems:\n  - id: y\n    name: Y\n`, {
      y: {
        candidates: [
          { title: "Y1", url: "https://shared.example/2" },
          { title: "Y2", url: "https://deep.example/1" },
          { title: "Y3", url: "https://deep.example/2" },
          { title: "Y4", url: "https://deep.example/3" },
        ],
      },
    });

    const headings = buildConsolidatedIssueBody([wide, deep])
      .split("\n")
      .filter((l) => l.startsWith("### "));
    expect(headings).toEqual([
      "### shared.example — 2 candidate(s) across 2 project(s)",
      "### deep.example — 3 candidate(s) across 1 project(s)",
    ]);
  });

  it("is byte-identical whatever order the states arrive in", () => {
    expect(buildConsolidatedIssueBody([NAS, CARLINK])).toBe(buildConsolidatedIssueBody([CARLINK, NAS]));
  });

  it("omits a manifest with nothing outstanding", () => {
    const done = state(
      "test-org/done",
      "docs/shopping/done.yaml",
      `project: All done\nitems:\n  - id: a\n    name: A\n    status: delivered\n`,
    );
    const body = buildConsolidatedIssueBody([NAS, done]);
    expect(body).not.toContain("All done");
    expect(body).toContain("NAS expansion");
  });

  it("renders the closed state when nothing anywhere is sourceable", () => {
    const gated = state(
      "test-org/gated",
      "docs/shopping/gated.yaml",
      `project: Gated\nactive_phases: [1]\nitems:\n  - id: a\n    name: A\n    phase: 2\n`,
    );
    const body = buildConsolidatedIssueBody([gated]);
    expect(body).toContain("_Nothing is currently being sourced._");
    expect(body).not.toContain("## Baskets by store");
  });

  it("lists sourceable items with no candidates under Still searching", () => {
    const body = buildConsolidatedIssueBody([
      state("test-org/x", "docs/shopping/x.yaml", `project: X\nitems:\n  - id: a\n    name: Widget\n`),
    ]);
    expect(body).toContain("## Still searching");
    expect(body).toContain("- Widget (X)");
  });

  it("collapses a newline in agent text so the candidate stays one line", () => {
    const body = buildConsolidatedIssueBody([
      state("test-org/x", "docs/shopping/x.yaml", `project: X\nitems:\n  - id: a\n    name: A\n`, {
        a: {
          candidates: [
            { title: "Card", url: "https://example.com/x", condition: "Used", source: "eBay UK", note: "line one\nline two" },
          ],
        },
      }),
    ]);
    const candidateLine = body.split("\n").find((l) => l.startsWith("- [Card]"));
    expect(candidateLine).toContain("Used · eBay UK");
    expect(candidateLine).toContain("line one line two");
  });

  it("omits absent metadata with no dangling separator", () => {
    const body = buildConsolidatedIssueBody([
      state("test-org/x", "docs/shopping/x.yaml", `project: X\nitems:\n  - id: a\n    name: A\n`, {
        a: { candidates: [{ title: "Bare", url: "https://example.com/y" }] },
      }),
    ]);
    expect(body).toContain("- [Bare](<https://example.com/y>) — for A (X)");
  });

  it("escapes a `]` in a project name so the manifest link can't close early", () => {
    const body = buildConsolidatedIssueBody([
      state(
        "test-org/x",
        "docs/shopping/x.yaml",
        `project: Heating Controller [Zone 2]\nitems:\n  - id: a\n    name: A\n`,
      ),
    ]);
    expect(body).toContain(
      "- [Heating Controller [Zone 2\\]](https://github.com/test-org/x/blob/HEAD/docs/shopping/x.yaml)",
    );
  });

  it("escapes a `]` in the candidate title so it can't close the markdown link early", () => {
    const body = buildConsolidatedIssueBody([
      state("test-org/x", "docs/shopping/x.yaml", `project: X\nitems:\n  - id: a\n    name: A\n`, {
        a: {
          candidates: [
            { title: "LSI SAS 9207-8e HBA [IT Mode] - Tested Working", url: "https://example.com/x" },
          ],
        },
      }),
    ]);
    expect(body).toContain("[LSI SAS 9207-8e HBA [IT Mode\\] - Tested Working](<https://example.com/x>)");
  });

  it("wraps the URL in angle brackets so a stray `)` in it can't inject a second link", () => {
    const body = buildConsolidatedIssueBody([
      state("test-org/x", "docs/shopping/x.yaml", `project: X\nitems:\n  - id: a\n    name: A\n`, {
        a: {
          candidates: [
            { title: "Fine", url: "https://example.com/x)%20[Buy%20now](https://evil.example" },
          ],
        },
      }),
    ]);
    expect(body).toContain("[Fine](<https://example.com/x)%20[Buy%20now](https://evil.example>)");
  });

  it("warns per project when its sourcing run failed", () => {
    const body = buildConsolidatedIssueBody([{ ...NAS, sourcingError: "exceeded memory limit (2312MiB)" }]);
    expect(body).toContain("⚠️ The most recent sourcing run failed");
    expect(body).toContain("> - NAS expansion — exceeded memory limit (2312MiB)");
  });

  it("emits no markdown table anywhere", () => {
    expect(buildConsolidatedIssueBody([NAS, CARLINK])).not.toContain("| --- |");
  });
});

describe("collectPreferredStores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only hosts seen in two or more distinct manifests, sorted", () => {
    mockDb.getAllShoppingSearches.mockReturnValue([
      {
        repo: "o/a",
        manifest: "a.yaml",
        resultJson: JSON.stringify({
          candidates: [{ url: "https://www.ebay.co.uk/itm/1" }, { url: "https://only-here.example/1" }],
        }),
      },
      {
        repo: "o/b",
        manifest: "b.yaml",
        resultJson: JSON.stringify({ candidates: [{ url: "https://ebay.co.uk/itm/2" }] }),
      },
      { repo: "o/c", manifest: "c.yaml", resultJson: "not json" },
    ]);

    expect(collectPreferredStores()).toEqual(["ebay.co.uk"]);
  });
});

describe("run", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks leaves implementations in place, so restore the defaults the
    // per-test failure injections below replace.
    mockOccurrence.closeAlertIssueIfResolved.mockImplementation(async (_opts: { title: string }) => null);
    mockDb.getShoppingSearches.mockReturnValue([]);
    mockDb.getAllShoppingSearches.mockReturnValue([]);
    mockDb.withTaskRecording.mockImplementation(
      async (
        _jobName: string,
        _repo: string,
        _itemNumber: number,
        _triggerLabel: string | null,
        fn: (taskId: number) => Promise<unknown>,
      ) => fn(1),
    );
    mockDb.trackTaskTokens.mockReturnValue(vi.fn());
    mockOccurrence.upsertAlertIssue.mockResolvedValue("created");
    mockOccurrence.closeAlertIssueIfResolved.mockResolvedValue(null);
    mockGh.listRepoDirectory.mockResolvedValue([dirEntry("nas-expansion.yaml")]);
    mockGh.fetchRepoFileContent.mockResolvedValue(VALID_MANIFEST);
    mockClaude.runClaude.mockResolvedValue(
      JSON.stringify({
        items: [
          {
            id: "hba-9207-8e",
            summary: "Found two.",
            candidates: [{ title: "LSI 9207-8e", url: "https://ebay.co.uk/itm/1", price: "£35" }],
          },
        ],
      }),
    );
  });

  it("sources due items and files the tracking issue with Claws Ignore", async () => {
    await run([repo], new Date("2026-08-15T12:00:00Z"));

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    const opts = mockClaude.runClaude.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts["provider"]).toBe("claude");
    expect(opts["disallowedTools"]).toContain("Bash");
    // disallowedTools is Claude-CLI-only, so falling back to another provider
    // would unsandbox the agent.
    expect(opts["noProviderFallback"]).toBe(true);
    // The agent reads attacker-influenceable listings — no claws-state MCP tools.
    const mcpOpts = mockClaude.writeClawsMcpConfig.mock.calls[0]![1] as Record<string, unknown>;
    expect(mcpOpts["includeClawsState"]).toBe(false);
    expect(Object.keys(mcpOpts["additionalServers"] as object)).toEqual(["playwright"]);

    const trackingCall = mockOccurrence.upsertAlertIssue.mock.calls.find((c) =>
      (c[0] as { title: string }).title.startsWith("[shopping]"),
    );
    expect(trackingCall).toBeDefined();
    const args = trackingCall![0] as { repo: string; title: string; labels: string[]; body: string };
    expect(args.repo).toBe("St-John-Software/claws");
    expect(args.title).toBe(CONSOLIDATED_ISSUE_TITLE);
    expect(args.labels).toEqual(["Claws Ignore"]);
    expect(args.body).toContain("https://ebay.co.uk/itm/1");
    expect(args.body).toContain("### ebay.co.uk");

    // The pre-#2647 per-manifest issue is closed on migration.
    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "test-org/test-repo",
        title: "[shopping] nas-expansion: sourcing & tracking",
      }),
    );

    // Every due item is recorded, including ones with no candidates.
    expect(mockDb.recordShoppingSearch).toHaveBeenCalledTimes(1);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("gives concurrently-processed repos distinct scratch directories", async () => {
    const other = mockRepo({ owner: "other-org", name: "other-repo", fullName: "other-org/other-repo" });

    await run([repo, other], new Date("2026-08-15T12:00:00Z"));

    const namespaces = mockClaude.ensureScratchDir.mock.calls.map((c) => c[0]);
    expect(namespaces).toEqual([
      "shopping-sourcer/test-org-test-repo",
      "shopping-sourcer/other-org-other-repo",
    ]);
    expect(new Set(namespaces).size).toBe(2);
  });

  it("closes the tracking issue and never runs the agent when nothing is sourcing", async () => {
    mockGh.fetchRepoFileContent.mockResolvedValue(
      `project: X\nitems:\n  - id: a\n    name: A\n    status: delivered\n`,
    );

    await run([repo], new Date("2026-08-15T12:00:00Z"));

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "St-John-Software/claws", title: CONSOLIDATED_ISSUE_TITLE }),
    );
    expect(mockOccurrence.upsertAlertIssue).not.toHaveBeenCalled();
  });

  it("leaves the consolidated issue untouched when a repo fails to process", async () => {
    const other = mockRepo({ owner: "other-org", name: "other-repo", fullName: "other-org/other-repo" });
    mockGh.listRepoDirectory.mockImplementation(async (fullName: string) => {
      if (fullName === "other-org/other-repo") throw new Error("gh api 502");
      return [dirEntry("nas-expansion.yaml")];
    });

    await run([repo, other], new Date("2026-08-15T12:00:00Z"));

    expect(mockOccurrence.upsertAlertIssue).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: CONSOLIDATED_ISSUE_TITLE }),
    );
    expect(mockOccurrence.closeAlertIssueIfResolved).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: CONSOLIDATED_ISSUE_TITLE }),
    );
  });

  it("hints stores already shared by two manifests to the sourcing agent", async () => {
    mockDb.getAllShoppingSearches.mockReturnValue([
      { repo: "o/a", manifest: "a.yaml", resultJson: JSON.stringify({ candidates: [{ url: "https://www.ebay.co.uk/itm/1" }] }) },
      { repo: "o/b", manifest: "b.yaml", resultJson: JSON.stringify({ candidates: [{ url: "https://ebay.co.uk/itm/2" }] }) },
    ]);

    await run([repo], new Date("2026-08-15T12:00:00Z"));

    const prompt = mockClaude.runClaude.mock.calls[0]![0] as string;
    expect(prompt).toContain("Other projects are already buying from these stores: ebay.co.uk");
  });

  it("refreshes the body without running the agent when nothing is due", async () => {
    mockDb.getShoppingSearches.mockReturnValue([
      {
        itemId: "hba-9207-8e",
        lastSearchedAt: "2026-08-15 10:00:00",
        resultJson: JSON.stringify({
          summary: "cached",
          candidates: [{ title: "Cached listing", url: "https://example.com/c" }],
        }),
      },
    ]);

    await run([repo], new Date("2026-08-15T12:00:00Z"));

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    const args = mockOccurrence.upsertAlertIssue.mock.calls[0]![0] as { body: string };
    expect(args.body).toContain("Cached listing");
  });

  it("files a malformed-manifest alert and skips the bad file", async () => {
    mockGh.fetchRepoFileContent.mockResolvedValue("project: [unclosed\n");

    await run([repo], new Date("2026-08-15T12:00:00Z"));

    const alert = mockOccurrence.upsertAlertIssue.mock.calls.find((c) =>
      (c[0] as { title: string }).title.startsWith("[shopping-sourcer]"),
    );
    expect(alert).toBeDefined();
    expect((alert![0] as { body: string }).body).toContain("nas-expansion.yaml");
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("still rebuilds the tracking issue when the malformed-manifest alert fails", async () => {
    mockOccurrence.closeAlertIssueIfResolved.mockImplementation(async (opts: { title: string }) => {
      if (opts.title.startsWith("[shopping-sourcer]")) throw new Error("502 from GitHub");
      return null;
    });

    await run([repo], new Date("2026-08-15T12:00:00Z"));

    // The alert is a side channel; failing it must not drop the whole fleet's
    // consolidated body through run()'s anyRepoFailed gate.
    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ title: "[shopping-sourcer] Malformed manifests in docs/shopping/" }),
    );
    const trackingCall = mockOccurrence.upsertAlertIssue.mock.calls.find((c) =>
      (c[0] as { title: string }).title.startsWith("[shopping]"),
    );
    expect(trackingCall).toBeDefined();
  });

  it("closes the malformed alert when every manifest parses", async () => {
    await run([repo], new Date("2026-08-15T12:00:00Z"));

    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "[shopping-sourcer] Malformed manifests in docs/shopping/",
      }),
    );
  });

  it("passes a raised memory cap and headless Chromium to the browser agent", async () => {
    await run([repo], new Date("2026-08-15T12:00:00Z"));

    const mcpOpts = mockClaude.writeClawsMcpConfig.mock.calls[0]![1] as {
      additionalServers: { playwright: { args: string[] } };
    };
    expect(mcpOpts.additionalServers.playwright.args).toContain("--headless");

    const opts = mockClaude.runClaude.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts["memoryMaxBytes"]).toBe(4 * 1024 * 1024 * 1024);
  });

  it("still files the tracking issue when the sourcing agent is killed", async () => {
    mockClaude.runClaude.mockRejectedValue(
      new Error("Agent process tree exceeded memory limit (2312MiB > 2048MiB)"),
    );

    await expect(run([repo], new Date("2026-08-15T12:00:00Z"))).resolves.toBeUndefined();

    expect(mockOccurrence.upsertAlertIssue).toHaveBeenCalledTimes(1);
    const args = mockOccurrence.upsertAlertIssue.mock.calls[0]![0] as { body: string };
    expect(args.body).toContain("## Projects");
    expect(args.body).toContain("— 1 sourcing, 2 outstanding");
    expect(args.body).toContain("2312MiB");
    expect(args.body).toContain("⚠️ The most recent sourcing run failed");
  });

  it("no-ops for repos without a docs/shopping directory", async () => {
    mockGh.listRepoDirectory.mockResolvedValue([]);

    await run([repo], new Date("2026-08-15T12:00:00Z"));

    expect(mockGh.fetchRepoFileContent).not.toHaveBeenCalled();
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockOccurrence.upsertAlertIssue).not.toHaveBeenCalled();
  });

  it("keeps the previous stored wording when a re-search finds the same listing at the same price", async () => {
    mockDb.getShoppingSearches.mockReturnValue([
      {
        itemId: "hba-9207-8e",
        lastSearchedAt: "2026-08-13 10:00:00",
        resultJson: JSON.stringify({
          summary: "Old wording",
          candidates: [{ title: "Old wording", url: "https://ebay.co.uk/itm/1", price: "£35" }],
        }),
      },
    ]);
    mockClaude.runClaude.mockResolvedValue(
      JSON.stringify({
        items: [
          {
            id: "hba-9207-8e",
            summary: "Freshly re-worded summary.",
            candidates: [{ title: "Freshly re-worded title", url: "https://ebay.co.uk/itm/1", price: "£35" }],
          },
        ],
      }),
    );

    await run([repo], new Date("2026-08-15T12:00:00Z"));

    // The prior stored candidate must reach the agent's prompt so it re-checks
    // rather than re-searching blind — the anchoring fix for #2634.
    const prompt = mockClaude.runClaude.mock.calls[0]![0] as string;
    expect(prompt).toContain("re-check these first");
    expect(prompt).toContain("https://ebay.co.uk/itm/1");

    const trackingCall = mockOccurrence.upsertAlertIssue.mock.calls.find((c) =>
      (c[0] as { title: string }).title.startsWith("[shopping]"),
    );
    expect(trackingCall).toBeDefined();
    const args = trackingCall![0] as { body: string };
    expect(args.body).toContain("Old wording");
    expect(args.body).not.toContain("Freshly re-worded");

    expect(mockDb.recordShoppingSearch).toHaveBeenCalledWith(
      repo.fullName,
      "nas-expansion.yaml",
      "hba-9207-8e",
      expect.stringContaining("Old wording"),
    );
  });
});
