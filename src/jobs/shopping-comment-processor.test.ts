import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseDocument } from "yaml";
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

vi.mock("node:fs", () => ({
  rmSync: vi.fn(),
}));

const { mockGh, mockClaude, mockDb, mockOccurrence, mockImages } = vi.hoisted(() => ({
  mockGh: {
    listOpenIssues: vi.fn(),
    findIssueByExactTitle: vi.fn(),
    getIssueComments: vi.fn(),
    getSelfLoginForRepo: vi.fn(async () => "clawsstjohn[bot]"),
    getCommentReactions: vi.fn(async () => [] as { id: number; user: { login: string }; content: string }[]),
    addReaction: vi.fn(),
    isAllowedActor: vi.fn(async () => true),
    isClawsComment: vi.fn(() => false),
    commentOnIssue: vi.fn(),
    listRepoDirectory: vi.fn(),
    fetchRepoFileWithSha: vi.fn(),
    getDefaultBranch: vi.fn(async (_fullName: string) => "main"),
    putRepoFile: vi.fn(),
    fetchRepoFileContent: vi.fn(),
  },
  mockClaude: {
    ensureScratchDir: vi.fn((namespace: string) => `/home/testuser/.claws/scratch/${namespace}`),
    writeClawsMcpConfig: vi.fn((dir: string) => `${dir}/.mcp-claws.json`),
    runClaude: vi.fn(),
    TEXT_ONLY_DISALLOWED_TOOLS: ["Bash"],
    BROWSER_AGENT_MEMORY_MAX_BYTES: 4 * 1024 * 1024 * 1024,
  },
  mockDb: {
    getShoppingSearches: vi.fn(() => [] as { itemId: string; lastSearchedAt: string; resultJson: string }[]),
    getAllShoppingSearches: vi.fn(() => [] as { repo: string; manifest: string; resultJson: string }[]),
    recordShoppingSearch: vi.fn(),
    getShoppingSourcingError: vi.fn((_repo: string, _manifest: string): string | undefined => undefined),
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
        "updated" as const,
    ),
    closeAlertIssueIfResolved: vi.fn(async () => null as number | null),
  },
  mockImages: {
    extractImageUrls: vi.fn((_text: string, _format?: "markdown" | "html") => [] as { url: string; alt: string }[]),
    downloadImages: vi.fn(async (_refs: unknown[], _destDir: string, _repo?: unknown) => ({
      downloaded: [] as { localPath: string; alt: string }[],
      failed: [] as string[],
    })),
    buildImagePromptSection: vi.fn((imgs: { localPath: string; alt: string }[]) =>
      imgs.map((i) => `- ${i.localPath}`).join("\n"),
    ),
    IMAGE_DIR: ".claws-images",
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../occurrence-tracking.js", () => mockOccurrence);
vi.mock("../images.js", () => mockImages);

import {
  __resetFailedAttemptsForTests,
  applyMutations,
  collectCommentImageRefs,
  groupMutationsByManifest,
  run,
  serializeDoc,
} from "./shopping-comment-processor.js";
import { CONSOLIDATED_ISSUE_TITLE, parseManifest, type ShoppingManifest } from "./shopping-sourcer.js";

const MANIFEST_YAML = `project: NAS expansion
active_phases: [1]
items:
  # The HBA is the critical path.
  - id: hba-9207-8e
    name: LSI SAS 9207-8e HBA
    phase: 1
    status: sourcing
    max_price: "£40"
  - id: sas-cable
    name: SFF-8088 cable
    phase: 2
`;

function manifestOf(yaml: string): ShoppingManifest {
  const r = parseManifest("nas-expansion.yaml", yaml);
  if (!r.ok) throw new Error(r.error);
  return r.manifest;
}

const CARLINK_YAML = `project: HA CarLink
items:
  - id: esp32
    name: ESP32-S3 board
`;

const SELF = mockRepo({ owner: "St-John-Software", name: "claws", fullName: "St-John-Software/claws" });
const NAS_REPO = mockRepo({ owner: "test-org", name: "nixos-config", fullName: "test-org/nixos-config" });
const CARLINK_REPO = mockRepo({ owner: "test-org", name: "ha-carlink", fullName: "test-org/ha-carlink" });
const REPOS = [SELF, NAS_REPO, CARLINK_REPO];

const NAS_KEY = "test-org/nixos-config:docs/shopping/nas-expansion.yaml";
const CARLINK_KEY = "test-org/ha-carlink:docs/shopping/ha-carlink-hardware.yaml";

const CONSOLIDATED_ISSUE = { number: 42, title: CONSOLIDATED_ISSUE_TITLE };

function comment(overrides: Partial<{ id: number; body: string; body_html: string; login: string }> = {}) {
  return {
    id: 1001,
    body: "mark the HBA delivered",
    body_html: "",
    login: "brendanstjohn",
    ...overrides,
  };
}

function setupHappyPath(mutations: unknown[]) {
  mockGh.findIssueByExactTitle.mockResolvedValue(CONSOLIDATED_ISSUE);
  mockGh.getIssueComments.mockResolvedValue([comment()]);
  mockGh.listRepoDirectory.mockImplementation(async (fullName: string) => {
    if (fullName === NAS_REPO.fullName) {
      return [
        { name: "nas-expansion.yaml", path: "docs/shopping/nas-expansion.yaml", sha: "x", type: "file" },
      ];
    }
    if (fullName === CARLINK_REPO.fullName) {
      return [
        {
          name: "ha-carlink-hardware.yaml",
          path: "docs/shopping/ha-carlink-hardware.yaml",
          sha: "x",
          type: "file",
        },
      ];
    }
    return [];
  });
  mockGh.fetchRepoFileWithSha.mockImplementation(async (_fullName: string, path: string) => {
    if (path === "docs/shopping/nas-expansion.yaml") return { content: MANIFEST_YAML, sha: "blobsha" };
    if (path === "docs/shopping/ha-carlink-hardware.yaml") return { content: CARLINK_YAML, sha: "carsha" };
    return null;
  });
  mockClaude.runClaude.mockResolvedValue(JSON.stringify({ mutations }));
}

describe("applyMutations", () => {
  it("changes a field, preserving surrounding comments and formatting", () => {
    const doc = parseDocument(MANIFEST_YAML);
    const result = applyMutations(doc, manifestOf(MANIFEST_YAML), [
      { op: "set_field", id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.applied).toEqual(["`hba-9207-8e`: status → delivered"]);
    const out = serializeDoc(doc);
    expect(out).toContain("status: delivered");
    expect(out).toContain("# The HBA is the critical path.");
    expect(parseManifest("m.yaml", out)).toMatchObject({ ok: true });
  });

  it("appends a new item and removes an existing one", () => {
    const doc = parseDocument(MANIFEST_YAML);
    const result = applyMutations(doc, manifestOf(MANIFEST_YAML), [
      { op: "add_item", item: { id: "nic-10gbe", name: "Intel X520-DA2", max_price: "£60" } },
      { op: "remove_item", id: "sas-cable" },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.applied).toEqual(["added `nic-10gbe` — Intel X520-DA2", "removed `sas-cable`"]);
    const parsed = parseManifest("m.yaml", serializeDoc(doc));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.manifest.items.map((i) => i.id)).toEqual(["hba-9207-8e", "nic-10gbe"]);
    // Defaults the agent did not supply are not written into the file.
    expect(parsed.manifest.items[1]).toMatchObject({ status: "sourcing", phase: 1, recheck_days: 1 });
    expect(serializeDoc(doc)).toMatch(/ {2}- id: nic-10gbe\n {4}name: Intel X520-DA2\n {4}max_price: £60\n$/);
  });

  it("writes active_phases in flow style", () => {
    const doc = parseDocument(MANIFEST_YAML);
    const result = applyMutations(doc, manifestOf(MANIFEST_YAML), [
      { op: "set_active_phases", value: [1, 2] },
    ]);

    expect(result.applied).toEqual(["active phases → [1, 2]"]);
    expect(serializeDoc(doc)).toContain("active_phases: [1, 2]");
  });

  it("rejects invalid mutations without applying them", () => {
    const doc = parseDocument(MANIFEST_YAML);
    const result = applyMutations(doc, manifestOf(MANIFEST_YAML), [
      { op: "set_field", id: "nope", field: "status", value: "delivered" },
      { op: "set_field", id: "hba-9207-8e", field: "status", value: "bought" },
      { op: "set_field", id: "hba-9207-8e", field: "phase", value: 0 },
      { op: "set_field", id: "hba-9207-8e", field: "id", value: "other" },
      { op: "add_item", item: { id: "sas-cable", name: "Dupe" } },
      { op: "add_item", item: { id: "Not Kebab", name: "Bad id" } },
      { op: "remove_item", id: "ghost" },
      { op: "set_active_phases", value: [] },
      { op: "delete_everything" },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.rejected).toHaveLength(9);
    expect(serializeDoc(doc)).toBe(MANIFEST_YAML);
  });

  it("caps a runaway batch at 25 mutations", () => {
    const doc = parseDocument(MANIFEST_YAML);
    const raw = Array.from({ length: 30 }, (_, i) => ({
      op: "set_field",
      id: "hba-9207-8e",
      field: "notes",
      value: `note ${i}`,
    }));
    const result = applyMutations(doc, manifestOf(MANIFEST_YAML), raw);
    expect(result.applied).toHaveLength(25);
    expect(result.rejected).toEqual(["5 further change(s) — more than 25 in one batch"]);
  });
});

describe("groupMutationsByManifest", () => {
  const known = new Set([NAS_KEY, CARLINK_KEY]);

  it("splits mutations by their manifest key", () => {
    const { grouped, rejected } = groupMutationsByManifest(
      [
        { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
        { op: "set_field", manifest: CARLINK_KEY, id: "esp32", field: "status", value: "ordered" },
      ],
      known,
    );
    expect(rejected).toEqual([]);
    expect([...grouped.keys()].sort()).toEqual([CARLINK_KEY, NAS_KEY].sort());
    expect(grouped.get(NAS_KEY)).toHaveLength(1);
  });

  it("rejects an unknown or missing manifest key instead of guessing", () => {
    const { grouped, rejected } = groupMutationsByManifest(
      [
        { op: "set_field", manifest: "other-org/secret:docs/shopping/x.yaml", id: "a", field: "status", value: "skip" },
        { op: "set_field", id: "a", field: "status", value: "skip" },
        "not an object",
      ],
      known,
    );
    expect(grouped.size).toBe(0);
    expect(rejected).toHaveLength(3);
    expect(rejected[0]).toContain("not a manifest Claws is tracking");
    expect(rejected[1]).toContain("(no manifest named)");
  });
});

describe("run", () => {
  beforeEach(() => {
    __resetFailedAttemptsForTests();
    vi.clearAllMocks();
    mockGh.getSelfLoginForRepo.mockResolvedValue("clawsstjohn[bot]");
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockGh.isClawsComment.mockReturnValue(false);
    mockGh.getDefaultBranch.mockResolvedValue("main");
    // clearAllMocks leaves implementations in place, so restore the defaults the
    // per-test failure injections below replace.
    mockGh.putRepoFile.mockImplementation(async (_fullName: string) => {});
    mockDb.getShoppingSearches.mockReturnValue([]);
    mockDb.getShoppingSourcingError.mockReturnValue(undefined);
    mockImages.extractImageUrls.mockReturnValue([]);
    mockImages.downloadImages.mockResolvedValue({ downloaded: [], failed: [] });
    mockDb.withTaskRecording.mockImplementation(
      async (
        _jobName: string,
        _repo: string,
        _itemNumber: number,
        _triggerLabel: string | null,
        fn: (taskId: number) => Promise<unknown>,
      ) => fn(1),
    );
  });

  it("applies a comment, commits with the original blob sha and replies", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);

    await run(REPOS);

    expect(mockGh.addReaction).toHaveBeenCalledTimes(1);
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("St-John-Software/claws", 1001, "rocket");
    expect(mockGh.putRepoFile).toHaveBeenCalledTimes(1);
    const [repo, branch, path, contentB64, message, sha] = mockGh.putRepoFile.mock.calls[0]!;
    expect(repo).toBe("test-org/nixos-config");
    expect(branch).toBe("main");
    expect(path).toBe("docs/shopping/nas-expansion.yaml");
    expect(Buffer.from(contentB64 as string, "base64").toString("utf8")).toContain("status: delivered");
    // Cross-repo autolink needs the owner: the tracking issue is in another repo now.
    expect(message).toContain("St-John-Software/claws#42");
    expect(sha).toBe("blobsha");

    // The consolidated issue is refreshed in the claws repo, not the manifest's.
    expect(mockOccurrence.upsertAlertIssue).toHaveBeenCalledTimes(1);
    const refresh = mockOccurrence.upsertAlertIssue.mock.calls[0]![0] as { repo: string; title: string };
    expect(refresh.repo).toBe("St-John-Software/claws");
    expect(refresh.title).toBe(CONSOLIDATED_ISSUE_TITLE);

    const reply = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(reply).toContain(`Updated \`${NAS_KEY}\`:`);
    expect(reply).toContain("`hba-9207-8e`: status → delivered");
    expect(reply).toContain("You can delete the comment(s) above now.");
  });

  it("routes each mutation to the repo its manifest lives in", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
      { op: "set_field", manifest: CARLINK_KEY, id: "esp32", field: "status", value: "ordered" },
    ]);

    await run(REPOS);

    expect(mockGh.putRepoFile).toHaveBeenCalledTimes(2);
    const targets = mockGh.putRepoFile.mock.calls.map((c) => [c[0], c[2]]);
    expect(targets).toEqual([
      ["test-org/ha-carlink", "docs/shopping/ha-carlink-hardware.yaml"],
      ["test-org/nixos-config", "docs/shopping/nas-expansion.yaml"],
    ]);
    const reply = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(reply).toContain(`Updated \`${CARLINK_KEY}\`:`);
    expect(reply).toContain(`Updated \`${NAS_KEY}\`:`);
  });

  it("rejects a mutation naming a manifest Claws is not tracking", async () => {
    setupHappyPath([
      { op: "set_field", manifest: "evil-org/x:docs/shopping/x.yaml", id: "a", field: "status", value: "skip" },
    ]);

    await run(REPOS);

    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("St-John-Software/claws", 1001, "confused");
    expect(mockGh.commentOnIssue.mock.calls[0]![2]).toContain("not a manifest Claws is tracking");
  });

  it("keeps committing the other manifests when one repo's commit fails", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
      { op: "set_field", manifest: CARLINK_KEY, id: "esp32", field: "status", value: "ordered" },
    ]);
    mockGh.putRepoFile.mockImplementation(async (fullName: string) => {
      if (fullName === "test-org/ha-carlink") throw new Error("409 conflict");
    });

    await run(REPOS);

    expect(mockGh.putRepoFile).toHaveBeenCalledTimes(2);
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("St-John-Software/claws", 1001, "rocket");
    const reply = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(reply).toContain(`Updated \`${NAS_KEY}\`:`);
    expect(reply).toContain("commit failed");
    expect(reply).not.toContain(`Updated \`${CARLINK_KEY}\`:`);
  });

  it("does nothing when the consolidated issue does not exist", async () => {
    setupHappyPath([]);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);

    await run(REPOS);

    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
    expect(mockGh.listRepoDirectory).not.toHaveBeenCalled();
  });

  it("does nothing when the job is not enabled for the claws repo", async () => {
    setupHappyPath([]);

    await run([NAS_REPO, CARLINK_REPO]);

    expect(mockGh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
  });

  it("ignores a comment from a login that is not an allowed actor", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);
    mockGh.isAllowedActor.mockResolvedValue(false);

    await run(REPOS);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockGh.addReaction).not.toHaveBeenCalled();
  });

  it("ignores a comment carrying a legacy self-authored eyes reaction", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);
    mockGh.getCommentReactions.mockResolvedValue([
      { id: 5, user: { login: "clawsstjohn[bot]" }, content: "eyes" },
    ]);

    await run(REPOS);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
  });

  it("ignores Claws' own comments", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);
    mockGh.isClawsComment.mockReturnValue(true);

    await run(REPOS);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
  });

  it("skips a manifest that does not parse and says so when none are left", async () => {
    setupHappyPath([]);
    mockGh.fetchRepoFileWithSha.mockResolvedValue({ content: "project: []\n", sha: "blobsha" });

    await run(REPOS);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenCalledWith("St-John-Software/claws", 1001, "confused");
    expect(mockGh.commentOnIssue.mock.calls[0]![2]).toContain("couldn't read any");
  });

  it("does not commit when the agent proposes only changes that fail validation", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "bought" },
    ]);

    await run(REPOS);

    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockOccurrence.upsertAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("St-John-Software/claws", 1001, "confused");
    expect(mockGh.commentOnIssue.mock.calls[0]![2]).toContain("Not applied:");
  });

  it("still replies when one repo's default-branch lookup fails mid-batch", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
      { op: "set_field", manifest: CARLINK_KEY, id: "esp32", field: "status", value: "ordered" },
    ]);
    mockGh.getDefaultBranch.mockImplementation(async (fullName: string) => {
      if (fullName === NAS_REPO.fullName) throw new Error("rate limited");
      return "main";
    });

    await run(REPOS);

    // The carlink repo still commits, and the batch is answered rather than
    // left for a retry it would keep failing.
    expect(mockGh.putRepoFile).toHaveBeenCalledTimes(1);
    expect(mockGh.putRepoFile.mock.calls[0]![0]).toBe("test-org/ha-carlink");
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("St-John-Software/claws", 1001, "rocket");
    const reply = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(reply).toContain(`Updated \`${CARLINK_KEY}\``);
    expect(reply).toContain("rate limited");
  });

  it("leaves the consolidated issue untouched when a repo failed to load", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);
    mockGh.listRepoDirectory.mockImplementation(async (fullName: string) => {
      if (fullName === CARLINK_REPO.fullName) throw new Error("502 from GitHub");
      if (fullName === NAS_REPO.fullName) {
        return [
          { name: "nas-expansion.yaml", path: "docs/shopping/nas-expansion.yaml", sha: "x", type: "file" },
        ];
      }
      return [];
    });

    await run(REPOS);

    // The commit still lands; only the rebuild is skipped, since a body built
    // from the partial set would drop the failed repo's projects entirely.
    expect(mockGh.putRepoFile).toHaveBeenCalledTimes(1);
    expect(mockOccurrence.upsertAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("St-John-Software/claws", 1001, "rocket");
  });

  it("keeps the sourcer's stale-candidates warning when it rebuilds the body", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);
    mockDb.getShoppingSourcingError.mockImplementation((_repo: string, manifest: string) =>
      manifest === "ha-carlink-hardware.yaml" ? "browser agent was killed" : undefined,
    );

    await run(REPOS);

    const refresh = mockOccurrence.upsertAlertIssue.mock.calls[0]![0] as { body: string };
    expect(refresh.body).toContain("browser agent was killed");
  });

  it("replies without committing when the agent output cannot be parsed", async () => {
    setupHappyPath([]);
    mockClaude.runClaude.mockResolvedValue("I could not work out what you meant.");

    await run(REPOS);

    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("St-John-Software/claws", 1001, "confused");
    expect(mockGh.commentOnIssue.mock.calls[0]![2]).toContain("couldn't turn that into a manifest change");
  });

  it("gives the agent a vision run when a comment embeds an image", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);
    mockGh.getIssueComments.mockResolvedValue([
      comment({ body_html: '<img src="https://private-user-images.githubusercontent.com/1/a.png">' }),
    ]);
    mockImages.extractImageUrls.mockReturnValue([
      { url: "https://private-user-images.githubusercontent.com/1/a.png", alt: "" },
    ]);
    mockImages.downloadImages.mockResolvedValue({
      downloaded: [{ localPath: ".claws-images/img-1.png", alt: "" }],
      failed: [],
    });

    await run(REPOS);

    const options = mockClaude.runClaude.mock.calls[0]![2] as {
      noProviderFallback?: boolean;
      disallowedTools: string[];
    };
    expect(options.noProviderFallback).toBe(true);
    expect(options.disallowedTools).toContain("Bash");
    expect(options.disallowedTools).not.toContain("Read");

    const prompt = mockClaude.runClaude.mock.calls[0]![0] as string;
    expect(prompt).toContain(".claws-images/img-1.png");

    const reply = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(reply).toContain("Read 1 embedded image");
  });

  it("tells the operator when an embedded image could not be downloaded", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);
    mockGh.getIssueComments.mockResolvedValue([
      comment({ body_html: '<img src="https://private-user-images.githubusercontent.com/1/a.png">' }),
    ]);
    mockImages.extractImageUrls.mockReturnValue([
      { url: "https://private-user-images.githubusercontent.com/1/a.png", alt: "" },
    ]);
    mockImages.downloadImages.mockResolvedValue({
      downloaded: [],
      failed: ["https://private-user-images.githubusercontent.com/1/a.png"],
    });

    await run(REPOS);

    const reply = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(reply).toContain("not readable");
  });

  it("stays text-only when no comment embeds an image", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);

    await run(REPOS);

    const reply = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(reply).not.toContain("embedded image");
  });

  it("leaves the batch unreacted when the agent call fails, so the next run retries it", async () => {
    setupHappyPath([]);
    mockClaude.runClaude.mockRejectedValue(
      Object.assign(new Error("All AI providers are rate-limited or unavailable"), {
        name: "AllProvidersRateLimitedError",
      }),
    );

    await expect(run(REPOS)).rejects.toThrow("rate-limited");

    expect(mockGh.addReaction).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("answers with 😕 once the retry budget is spent", async () => {
    setupHappyPath([]);
    mockClaude.runClaude.mockRejectedValue(
      Object.assign(new Error("All AI providers are rate-limited or unavailable"), {
        name: "AllProvidersRateLimitedError",
      }),
    );

    for (let i = 0; i < 6; i++) await expect(run(REPOS)).rejects.toThrow();

    expect(mockGh.addReaction).toHaveBeenCalledTimes(1);
    expect(mockGh.addReaction).toHaveBeenCalledWith("St-John-Software/claws", 1001, "confused");
    const reply = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(reply).toContain("may already have been applied");
    expect(reply).not.toContain("nothing was changed");
  });

  it("does not re-react a comment a partial finish() already answered", async () => {
    setupHappyPath([]);
    // The batch fails every run, but by the time the budget is spent the comment
    // already carries a 🚀 from a finish() that died after reacting it.
    let failures = 0;
    mockClaude.runClaude.mockImplementation(async () => {
      failures++;
      throw Object.assign(new Error("All AI providers are rate-limited or unavailable"), {
        name: "AllProvidersRateLimitedError",
      });
    });
    mockGh.getCommentReactions.mockImplementation(async () =>
      failures >= 6 ? [{ id: 5, user: { login: "clawsstjohn[bot]" }, content: "rocket" }] : [],
    );

    for (let i = 0; i < 6; i++) await expect(run(REPOS)).rejects.toThrow();

    expect(mockGh.addReaction).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("stops retrying once the batch is answered", async () => {
    setupHappyPath([
      { op: "set_field", manifest: NAS_KEY, id: "hba-9207-8e", field: "status", value: "delivered" },
    ]);

    await run(REPOS);
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("St-John-Software/claws", 1001, "rocket");

    mockGh.getCommentReactions.mockResolvedValue([{ id: 5, user: { login: "clawsstjohn[bot]" }, content: "rocket" }]);
    mockClaude.runClaude.mockClear();
    mockClaude.runClaude.mockRejectedValue(
      Object.assign(new Error("All AI providers are rate-limited or unavailable"), {
        name: "AllProvidersRateLimitedError",
      }),
    );
    await run(REPOS);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("still marks the batch when the give-up reply cannot be posted", async () => {
    setupHappyPath([]);
    mockClaude.runClaude.mockRejectedValue(
      Object.assign(new Error("All AI providers are rate-limited or unavailable"), {
        name: "AllProvidersRateLimitedError",
      }),
    );
    mockGh.commentOnIssue.mockRejectedValue(new Error("502"));

    for (let i = 0; i < 5; i++) await expect(run(REPOS)).rejects.toThrow();
    await expect(run(REPOS)).rejects.toThrow("rate-limited");

    expect(mockGh.addReaction).toHaveBeenCalledWith("St-John-Software/claws", 1001, "confused");
  });

  it("bounds the retry when the no-manifest reply keeps failing", async () => {
    setupHappyPath([]);
    mockGh.fetchRepoFileWithSha.mockResolvedValue({ content: "project: []\n", sha: "blobsha" });
    mockGh.commentOnIssue.mockRejectedValue(new Error("502"));

    for (let i = 0; i < 6; i++) await expect(run(REPOS)).rejects.toThrow("502");

    expect(mockGh.addReaction).toHaveBeenCalledWith("St-John-Software/claws", 1001, "confused");
  });
});

describe("collectCommentImageRefs", () => {
  it("prefers body_html over body when both are present", () => {
    mockImages.extractImageUrls.mockReturnValueOnce([{ url: "https://example.com/from-html.png", alt: "" }]);

    const { refs } = collectCommentImageRefs([
      { body: "![alt](https://example.com/from-markdown.png)", body_html: "<img src=\"https://example.com/from-html.png\">" },
    ]);

    expect(mockImages.extractImageUrls).toHaveBeenCalledWith(
      "<img src=\"https://example.com/from-html.png\">",
      "html",
    );
    expect(refs).toEqual([{ url: "https://example.com/from-html.png", alt: "" }]);
  });

  it("dedupes the same URL across two comments", () => {
    mockImages.extractImageUrls
      .mockReturnValueOnce([{ url: "https://example.com/a.png", alt: "" }])
      .mockReturnValueOnce([{ url: "https://example.com/a.png", alt: "" }]);

    const { refs } = collectCommentImageRefs([
      { body: "", body_html: "<img src=\"https://example.com/a.png\">" },
      { body: "", body_html: "<img src=\"https://example.com/a.png\">" },
    ]);

    expect(refs).toHaveLength(1);
  });

  it("reports overflow when more than 6 refs are found", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ url: `https://example.com/${i}.png`, alt: "" }));
    mockImages.extractImageUrls.mockReturnValueOnce(many);

    const { refs, overflow } = collectCommentImageRefs([{ body: "", body_html: "<img>" }]);

    expect(refs).toHaveLength(6);
    expect(overflow).toBe(2);
  });
});
