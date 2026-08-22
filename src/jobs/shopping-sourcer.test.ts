import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  LABELS: { priority: "Priority", clawsIgnore: "Claws Ignore" },
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
    recordShoppingSearch: vi.fn(),
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
    ensureAlertIssue: vi.fn(
      async (_opts: {
        repo: string;
        title: string;
        body: string;
        labels: string[];
        logPrefix: string;
        refreshBody?: boolean;
      }) => ({ outcome: "created", issueNumber: 1 }),
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
  buildIssueBody,
  AgentResultSchema,
  run,
  type ShoppingItem,
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

describe("buildIssueBody", () => {
  function parsed(yaml: string) {
    const r = parseManifest("m.yaml", yaml);
    if (!r.ok) throw new Error(r.error);
    return r.manifest;
  }

  it("marks gated phases and escapes pipes in candidate cells", () => {
    const manifest = parsed(VALID_MANIFEST);
    const stored = new Map([
      [
        "hba-9207-8e",
        {
          summary: "Checked eBay UK.",
          candidates: [
            { title: "LSI 9207-8e | IT mode", url: "https://example.com/x", price: "£38.00" },
          ],
        },
      ],
    ]);

    const body = buildIssueBody(
      "test-org/test-repo",
      manifest,
      "docs/shopping/nas-expansion.yaml",
      stored,
    );

    expect(body).toContain("| 2 | sourcing (gated) |");
    expect(body).toContain("[LSI 9207-8e \\| IT mode](<https://example.com/x>)");
    // The gated phase-2 item gets no candidates section.
    expect(body).not.toContain("### SFF-8088 to SFF-8088 cable");
    expect(body).toContain("docs/jobs/shopping-sourcer.md");
  });

  it("escapes a `]` in the candidate title so it can't close the markdown link early", () => {
    const manifest = parsed(VALID_MANIFEST);
    const stored = new Map([
      [
        "hba-9207-8e",
        {
          candidates: [
            {
              title: "LSI SAS 9207-8e HBA [IT Mode] - Tested Working",
              url: "https://example.com/x",
            },
          ],
        },
      ],
    ]);

    const body = buildIssueBody("test-org/test-repo", manifest, "docs/shopping/nas-expansion.yaml", stored);

    expect(body).toContain("[LSI SAS 9207-8e HBA [IT Mode\\] - Tested Working](<https://example.com/x>)");
  });

  it("wraps the URL in angle brackets so a stray `)` in it can't inject a second link", () => {
    const manifest = parsed(VALID_MANIFEST);
    const stored = new Map([
      [
        "hba-9207-8e",
        {
          candidates: [
            {
              title: "Fine",
              url: "https://example.com/x)%20[Buy%20now](https://evil.example",
            },
          ],
        },
      ],
    ]);

    const body = buildIssueBody("test-org/test-repo", manifest, "docs/shopping/nas-expansion.yaml", stored);

    expect(body).toContain(
      "[Fine](<https://example.com/x)%20[Buy%20now](https://evil.example>)",
    );
  });

  it("says searching continues when an item has no candidates", () => {
    const body = buildIssueBody(
      "test-org/test-repo",
      parsed(`project: X\nitems:\n  - id: a\n    name: A\n    recheck_days: 3\n`),
      "docs/shopping/x.yaml",
      new Map(),
    );
    expect(body).toContain("keeps searching every 3 day(s)");
  });

  it("hides finished items from the outstanding-items table", () => {
    const manifest = parsed(
      `project: X\nactive_phases: [1, 2]\nitems:\n` +
        `  - id: a\n    name: Item A\n` +
        `  - id: b\n    name: Item B\n    status: delivered\n` +
        `  - id: c\n    name: Item C\n    status: skip\n` +
        `  - id: d\n    name: Item D\n    status: ordered\n`,
    );
    const body = buildIssueBody("test-org/test-repo", manifest, "docs/shopping/x.yaml", new Map());
    expect(body).toContain("| Item A |");
    expect(body).toContain("| Item D |");
    expect(body).not.toContain("| Item B |");
    expect(body).not.toContain("| Item C |");
    expect(body).toContain("_Hidden: 1 delivered, 1 skipped.");
  });

  it("keeps gated outstanding items visible", () => {
    const manifest = parsed(VALID_MANIFEST);
    const body = buildIssueBody(
      "test-org/test-repo",
      manifest,
      "docs/shopping/nas-expansion.yaml",
      new Map(),
    );
    expect(body).toContain("## Outstanding items");
    expect(body).toContain("| 2 | sourcing (gated) |");
    expect(body).not.toContain("_Hidden:");
  });

  it("shows the empty state when every item is delivered or skipped", () => {
    const manifest = parsed(
      `project: X\nitems:\n` +
        `  - id: a\n    name: A\n    status: delivered\n` +
        `  - id: b\n    name: B\n    status: skip\n`,
    );
    const body = buildIssueBody("test-org/test-repo", manifest, "docs/shopping/x.yaml", new Map());
    expect(body).toContain("_Nothing outstanding");
    expect(body).not.toContain("| Item | Phase | Status | Budget |");
  });
});

describe("run", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getShoppingSearches.mockReturnValue([]);
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
    mockOccurrence.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
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
    expect(opts["capability"]).toBe("tool-use");
    expect(opts["provider"]).toBe("claude");
    expect(opts["disallowedTools"]).toContain("Bash");
    // disallowedTools is Claude-CLI-only, so falling back to another provider
    // would unsandbox the agent.
    expect(opts["noProviderFallback"]).toBe(true);
    // The agent reads attacker-influenceable listings — no claws-state MCP tools.
    const mcpOpts = mockClaude.writeClawsMcpConfig.mock.calls[0]![1] as Record<string, unknown>;
    expect(mcpOpts["includeClawsState"]).toBe(false);
    expect(Object.keys(mcpOpts["additionalServers"] as object)).toEqual(["playwright"]);

    const trackingCall = mockOccurrence.ensureAlertIssue.mock.calls.find((c) =>
      (c[0] as { title: string }).title.startsWith("[shopping]"),
    );
    expect(trackingCall).toBeDefined();
    const args = trackingCall![0] as { title: string; labels: string[]; refreshBody: boolean; body: string };
    expect(args.title).toBe("[shopping] nas-expansion: sourcing & tracking");
    expect(args.labels).toEqual(["Claws Ignore"]);
    expect(args.refreshBody).toBe(true);
    expect(args.body).toContain("https://ebay.co.uk/itm/1");

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
      expect.objectContaining({ title: "[shopping] nas-expansion: sourcing & tracking" }),
    );
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
    const args = mockOccurrence.ensureAlertIssue.mock.calls[0]![0] as { body: string };
    expect(args.body).toContain("Cached listing");
  });

  it("files a malformed-manifest alert and skips the bad file", async () => {
    mockGh.fetchRepoFileContent.mockResolvedValue("project: [unclosed\n");

    await run([repo], new Date("2026-08-15T12:00:00Z"));

    const alert = mockOccurrence.ensureAlertIssue.mock.calls.find((c) =>
      (c[0] as { title: string }).title.startsWith("[shopping-sourcer]"),
    );
    expect(alert).toBeDefined();
    expect((alert![0] as { body: string }).body).toContain("nas-expansion.yaml");
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
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

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const args = mockOccurrence.ensureAlertIssue.mock.calls[0]![0] as { body: string };
    expect(args.body).toContain("## Outstanding items");
    expect(args.body).toContain("| 1 | sourcing |");
    expect(args.body).toContain("2312MiB");
    expect(args.body).toContain("⚠️ The most recent sourcing run failed");
  });

  it("no-ops for repos without a docs/shopping directory", async () => {
    mockGh.listRepoDirectory.mockResolvedValue([]);

    await run([repo], new Date("2026-08-15T12:00:00Z"));

    expect(mockGh.fetchRepoFileContent).not.toHaveBeenCalled();
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
  });
});
