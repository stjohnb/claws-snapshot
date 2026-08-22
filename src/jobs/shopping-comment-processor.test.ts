import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseDocument } from "yaml";
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
    listOpenIssues: vi.fn(),
    getIssueComments: vi.fn(),
    getSelfLogin: vi.fn(async () => "clawsstjohn[bot]"),
    getCommentReactions: vi.fn(async () => [] as { id: number; user: { login: string }; content: string }[]),
    addReaction: vi.fn(),
    isAllowedActor: vi.fn(async () => true),
    isClawsComment: vi.fn(() => false),
    commentOnIssue: vi.fn(),
    listRepoDirectory: vi.fn(),
    fetchRepoFileWithSha: vi.fn(),
    getDefaultBranch: vi.fn(async () => "main"),
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
    ensureAlertIssue: vi.fn(async () => ({ outcome: "updated", issueNumber: 7 })),
    closeAlertIssueIfResolved: vi.fn(async () => null as number | null),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../occurrence-tracking.js", () => mockOccurrence);

import { applyMutations, run, serializeDoc } from "./shopping-comment-processor.js";
import { parseManifest, type ShoppingManifest } from "./shopping-sourcer.js";

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

const TRACKING_ISSUE = {
  number: 42,
  title: "[shopping] nas-expansion: sourcing & tracking",
  body: "",
  labels: [{ name: "Claws Ignore" }],
  author: { login: "clawsstjohn[bot]" },
};

const DIR_ENTRIES = [
  { name: "nas-expansion.yaml", path: "docs/shopping/nas-expansion.yaml", sha: "blobsha", type: "file" },
];

function comment(overrides: Partial<{ id: number; body: string; login: string }> = {}) {
  return {
    id: 1001,
    body: "mark the HBA delivered",
    body_html: "",
    login: "brendanstjohn",
    ...overrides,
  };
}

function setupHappyPath(mutations: unknown[]) {
  mockGh.listOpenIssues.mockResolvedValue([TRACKING_ISSUE]);
  mockGh.getIssueComments.mockResolvedValue([comment()]);
  mockGh.listRepoDirectory.mockResolvedValue(DIR_ENTRIES);
  mockGh.fetchRepoFileWithSha.mockResolvedValue({ content: MANIFEST_YAML, sha: "blobsha" });
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

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.getSelfLogin.mockResolvedValue("clawsstjohn[bot]");
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockGh.isClawsComment.mockReturnValue(false);
    mockGh.getDefaultBranch.mockResolvedValue("main");
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
  });

  it("applies a comment, commits with the original blob sha and replies", async () => {
    setupHappyPath([{ op: "set_field", id: "hba-9207-8e", field: "status", value: "delivered" }]);

    await run([mockRepo()]);

    expect(mockGh.addReaction).toHaveBeenNthCalledWith(1, "test-org/test-repo", 1001, "eyes");
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("test-org/test-repo", 1001, "rocket");
    expect(mockGh.putRepoFile).toHaveBeenCalledTimes(1);
    const [repo, branch, path, contentB64, message, sha] = mockGh.putRepoFile.mock.calls[0]!;
    expect(repo).toBe("test-org/test-repo");
    expect(branch).toBe("main");
    expect(path).toBe("docs/shopping/nas-expansion.yaml");
    expect(Buffer.from(contentB64 as string, "base64").toString("utf8")).toContain("status: delivered");
    expect(message).toContain("#42");
    expect(sha).toBe("blobsha");
    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const reply = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(reply).toContain("`hba-9207-8e`: status → delivered");
    expect(reply).toContain("You can delete the comment(s) above now.");
  });

  it("ignores a comment from a login that is not an allowed actor", async () => {
    setupHappyPath([{ op: "set_field", id: "hba-9207-8e", field: "status", value: "delivered" }]);
    mockGh.isAllowedActor.mockResolvedValue(false);

    await run([mockRepo()]);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockGh.addReaction).not.toHaveBeenCalled();
  });

  it("ignores a comment already carrying a self-authored eyes reaction", async () => {
    setupHappyPath([{ op: "set_field", id: "hba-9207-8e", field: "status", value: "delivered" }]);
    mockGh.getCommentReactions.mockResolvedValue([
      { id: 5, user: { login: "clawsstjohn[bot]" }, content: "eyes" },
    ]);

    await run([mockRepo()]);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
  });

  it("ignores Claws' own comments", async () => {
    setupHappyPath([{ op: "set_field", id: "hba-9207-8e", field: "status", value: "delivered" }]);
    mockGh.isClawsComment.mockReturnValue(true);

    await run([mockRepo()]);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
  });

  it("does not commit, or call the agent, when the manifest does not parse", async () => {
    setupHappyPath([{ op: "set_field", id: "hba-9207-8e", field: "status", value: "delivered" }]);
    mockGh.fetchRepoFileWithSha.mockResolvedValue({ content: "project: []\n", sha: "blobsha" });

    await run([mockRepo()]);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenCalledWith("test-org/test-repo", 1001, "confused");
  });

  it("does not commit when the agent proposes only changes that fail validation", async () => {
    setupHappyPath([{ op: "set_field", id: "hba-9207-8e", field: "status", value: "bought" }]);

    await run([mockRepo()]);

    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("test-org/test-repo", 1001, "confused");
    expect(mockGh.commentOnIssue.mock.calls[0]![2]).toContain("Not applied:");
  });

  it("replies without committing when the manifest file no longer exists", async () => {
    setupHappyPath([{ op: "set_field", id: "hba-9207-8e", field: "status", value: "delivered" }]);
    mockGh.listRepoDirectory.mockResolvedValue([]);

    await run([mockRepo()]);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue.mock.calls[0]![2]).toContain("No manifest for this list exists");
  });

  it("skips issues whose title is not a shopping tracking issue", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      { ...TRACKING_ISSUE, number: 9, title: "Some other issue" },
    ]);

    await run([mockRepo()]);

    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
    expect(mockGh.listRepoDirectory).not.toHaveBeenCalled();
  });

  it("replies without committing when the agent output cannot be parsed", async () => {
    setupHappyPath([]);
    mockClaude.runClaude.mockResolvedValue("I could not work out what you meant.");

    await run([mockRepo()]);

    expect(mockGh.putRepoFile).not.toHaveBeenCalled();
    expect(mockGh.addReaction).toHaveBeenLastCalledWith("test-org/test-repo", 1001, "confused");
    expect(mockGh.commentOnIssue.mock.calls[0]![2]).toContain("couldn't turn that into a manifest change");
  });
});
