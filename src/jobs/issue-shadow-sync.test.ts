import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockGh, mockDb, mockClawsIssues, mockWorker, mockResolveImportedRef, mockIsAgentDisabled } = vi.hoisted(() => ({
  mockGh: {
    isRepoRateLimited: vi.fn(() => false),
    isNativeIssue: vi.fn((ref: unknown) => typeof ref === "string" && ref.toLowerCase().startsWith("clw_")),
    listOpenIssues: vi.fn(),
    getIssueState: vi.fn(),
    hasPriorityLabel: vi.fn((labels: { name: string }[]) => labels.some((l) => l.name === "Priority")),
    // Every forge write the job must never make. Declared so a call would be
    // recorded rather than throwing "not a function" from somewhere else.
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    commentOnIssue: vi.fn(),
    closeIssue: vi.fn(),
    editIssue: vi.fn(),
    editIssueTitle: vi.fn(),
  },
  mockDb: {
    listShadowIssues: vi.fn(),
    createShadowIssue: vi.fn(),
    updateShadowIssue: vi.fn(),
    markShadowsChecked: vi.fn(),
    getImportedForgeSyncedAt: vi.fn(),
    setImportedForgeSyncedAt: vi.fn(),
  },
  mockClawsIssues: {
    getIssue: vi.fn(),
    editIssue: vi.fn(),
    editIssueTitle: vi.fn(),
    reopenIssue: vi.fn(),
    setLifecycle: vi.fn(),
    primaryRepo: vi.fn((repos: readonly string[]) => [...repos].sort()[0] ?? ""),
  },
  mockWorker: {
    enqueue: vi.fn(),
    AGENT_KINDS: { ISSUE_REFINER_REPLAN: "work:issue-refiner:replan" },
  },
  mockResolveImportedRef: vi.fn(),
  mockIsAgentDisabled: vi.fn(() => false),
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../db.js", () => mockDb);
vi.mock("../claws-issues.js", () => mockClawsIssues);
vi.mock("../worker.js", () => mockWorker);
vi.mock("../imported-refs.js", () => ({ resolveImportedRef: mockResolveImportedRef }));
vi.mock("./issue-importer.js", () => ({
  importedBody: (url: string, author: string, body: string) => `Imported from ${url} (opened by @${author})\n\n${body}`,
}));
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  isAgentDisabled: mockIsAgentDisabled,
}));

import { run, CLOSE_CHECK_CAP } from "./issue-shadow-sync.js";
import { reportError } from "../error-reporter.js";

const REPO = "test-org/claws";
const REPOS = [{ fullName: REPO } as never];

interface ForgeIssueInput {
  number: number;
  title?: string;
  body?: string;
  labels?: string[];
  author?: string;
  updatedAt?: string;
}

function forgeIssue(input: ForgeIssueInput) {
  return {
    number: input.number,
    title: input.title ?? `Issue ${input.number}`,
    body: input.body ?? "body",
    labels: (input.labels ?? []).map((name) => ({ name })),
    author: { login: input.author ?? "bstjohn" },
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

interface ShadowInput {
  id: string;
  forgeNumber: number;
  title?: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
}

function shadow(input: ShadowInput) {
  return {
    id: input.id,
    forgeNumber: input.forgeNumber,
    title: input.title ?? `Issue ${input.forgeNumber}`,
    body: input.body ?? "body",
    labels: input.labels ?? [],
    repos: [REPO],
    state: input.state ?? "open",
    state_reason: null,
    author_login: "bstjohn",
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    closed_at: null,
    kind: "shadow",
    shadow_checked_at: null,
  };
}

/** Every forge write function the job is forbidden from ever calling. */
function expectNoForgeWrites(): void {
  expect(mockGh.addLabel).not.toHaveBeenCalled();
  expect(mockGh.removeLabel).not.toHaveBeenCalled();
  expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  expect(mockGh.closeIssue).not.toHaveBeenCalled();
  expect(mockGh.editIssue).not.toHaveBeenCalled();
  expect(mockGh.editIssueTitle).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGh.isRepoRateLimited.mockReturnValue(false);
  mockGh.isNativeIssue.mockImplementation((ref: unknown) => typeof ref === "string" && ref.toLowerCase().startsWith("clw_"));
  mockGh.listOpenIssues.mockResolvedValue([]);
  mockDb.listShadowIssues.mockResolvedValue([]);
  mockDb.createShadowIssue.mockResolvedValue({ id: "clw_new", created: true });
  mockDb.updateShadowIssue.mockResolvedValue("changed");
  // Re-stated per test: `clearAllMocks` clears calls but keeps the previous
  // test's implementation, so an un-stubbed read would silently answer with
  // whatever the test above it wanted.
  mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
  mockResolveImportedRef.mockImplementation((_repo: string, ref: unknown) => ref);
  mockIsAgentDisabled.mockReturnValue(false);
  mockDb.getImportedForgeSyncedAt.mockResolvedValue(null);
  mockClawsIssues.getIssue.mockResolvedValue(undefined);
});

describe("issue-shadow-sync", () => {
  it("creates a shadow for a forge issue that has none", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      forgeIssue({ number: 7, title: "Broken pump", body: "it leaks", labels: ["Priority"], author: "bstjohn" }),
    ]);

    await run(REPOS);

    expect(mockDb.createShadowIssue).toHaveBeenCalledWith(REPO, 7, {
      title: "Broken pump",
      body: "it leaks",
      authorLogin: "bstjohn",
      labels: ["Priority"],
    });
    expect(mockDb.updateShadowIssue).not.toHaveBeenCalled();
    expectNoForgeWrites();
  });

  it("does not write an unchanged issue but still marks it checked", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      forgeIssue({ number: 7, title: "Same", body: "same body", labels: ["Ready"] }),
    ]);
    mockDb.listShadowIssues.mockResolvedValue([
      shadow({ id: "clw_a", forgeNumber: 7, title: "Same", body: "same body", labels: ["Ready"] }),
    ]);

    await run(REPOS);

    expect(mockDb.createShadowIssue).not.toHaveBeenCalled();
    expect(mockDb.updateShadowIssue).not.toHaveBeenCalled();
    expect(mockDb.markShadowsChecked).toHaveBeenCalledWith(["clw_a"]);
  });

  it("updates a shadow whose label set changed", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      forgeIssue({ number: 7, title: "Same", body: "same body", labels: ["Ready", "Priority"] }),
    ]);
    mockDb.listShadowIssues.mockResolvedValue([
      shadow({ id: "clw_a", forgeNumber: 7, title: "Same", body: "same body", labels: ["Ready"] }),
    ]);

    await run(REPOS);

    expect(mockDb.updateShadowIssue).toHaveBeenCalledWith("clw_a", {
      title: "Same",
      body: "same body",
      labels: ["Ready", "Priority"],
      state: "open",
      stateReason: null,
    });
    expect(mockDb.markShadowsChecked).toHaveBeenCalledWith(["clw_a"]);
    expectNoForgeWrites();
  });

  it("closes a shadow missing from the listing only once getIssueState says CLOSED", async () => {
    mockDb.listShadowIssues.mockResolvedValue([shadow({ id: "clw_a", forgeNumber: 7, title: "Gone", body: "b" })]);
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "NOT_PLANNED", labels: ["Ready"] });

    await run(REPOS);

    expect(mockGh.getIssueState).toHaveBeenCalledWith(REPO, 7);
    expect(mockDb.updateShadowIssue).toHaveBeenCalledWith("clw_a", {
      title: "Gone",
      body: "b",
      labels: ["Ready"],
      state: "closed",
      stateReason: "not_planned",
    });
    expect(mockDb.markShadowsChecked).toHaveBeenCalledWith(["clw_a"]);
    expectNoForgeWrites();
  });

  it("leaves a shadow open when getIssueState still says OPEN", async () => {
    mockDb.listShadowIssues.mockResolvedValue([shadow({ id: "clw_a", forgeNumber: 7 })]);
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });

    await run(REPOS);

    expect(mockDb.updateShadowIssue).not.toHaveBeenCalled();
    expect(mockDb.markShadowsChecked).toHaveBeenCalledWith(["clw_a"]);
  });

  it("never re-checks a shadow that is already closed", async () => {
    mockDb.listShadowIssues.mockResolvedValue([shadow({ id: "clw_a", forgeNumber: 7, state: "closed" })]);

    await run(REPOS);

    expect(mockGh.getIssueState).not.toHaveBeenCalled();
    expect(mockDb.markShadowsChecked).toHaveBeenCalledWith([]);
  });

  it("caps state reads per run and takes them in shadow_checked_at order", async () => {
    // listShadowIssues already orders oldest-checked-first, so the job must
    // take the head of the list it was handed and nothing else.
    const shadows = Array.from({ length: CLOSE_CHECK_CAP + 5 }, (_, i) => shadow({ id: `clw_${i}`, forgeNumber: i + 1 }));
    mockDb.listShadowIssues.mockResolvedValue(shadows);
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });

    await run(REPOS);

    expect(mockGh.getIssueState).toHaveBeenCalledTimes(CLOSE_CHECK_CAP);
    const read = mockGh.getIssueState.mock.calls.map((call) => call[1]);
    expect(read).toEqual(shadows.slice(0, CLOSE_CHECK_CAP).map((s) => s.forgeNumber));
    expect(mockDb.markShadowsChecked).toHaveBeenCalledWith(shadows.slice(0, CLOSE_CHECK_CAP).map((s) => s.id));
  });

  it("still marks a shadow checked when its state read fails", async () => {
    // Otherwise a shadow whose read keeps failing holds the head of the
    // `shadow_checked_at` queue and starves every shadow behind it.
    mockDb.listShadowIssues.mockResolvedValue([
      shadow({ id: "clw_a", forgeNumber: 7 }),
      shadow({ id: "clw_b", forgeNumber: 8 }),
    ]);
    mockGh.getIssueState.mockImplementation(async (_repo: string, n: number) => {
      if (n === 7) throw new Error("gone");
      return { state: "OPEN", stateReason: null, labels: [] };
    });

    await run(REPOS);

    expect(mockGh.getIssueState).toHaveBeenCalledTimes(2);
    expect(mockDb.markShadowsChecked).toHaveBeenCalledWith(["clw_a", "clw_b"]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("skips a forge issue whose linkage row already names an imported issue", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 })]);
    mockDb.createShadowIssue.mockResolvedValue(undefined);

    await run(REPOS);

    expect(mockDb.updateShadowIssue).not.toHaveBeenCalled();
    expect(mockDb.markShadowsChecked).toHaveBeenCalledWith([]);
  });

  it("drops a shadow the importer promoted mid-run from the working set", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, title: "Edited" })]);
    mockDb.listShadowIssues.mockResolvedValue([shadow({ id: "clw_a", forgeNumber: 7, title: "Old" })]);
    mockDb.updateShadowIssue.mockResolvedValue("not-a-shadow");

    await run(REPOS);

    expect(mockDb.updateShadowIssue).toHaveBeenCalledTimes(1);
    // Not close-checked either: the listing accounted for it, so it is not a
    // shadow missing from the forge.
    expect(mockGh.getIssueState).not.toHaveBeenCalled();
    expect(mockDb.markShadowsChecked).toHaveBeenCalledWith([]);
  });

  it("ignores a native issue in the listing", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      { ...forgeIssue({ number: 7 }), number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC" },
    ]);

    await run(REPOS);

    expect(mockDb.createShadowIssue).not.toHaveBeenCalled();
    expect(mockDb.updateShadowIssue).not.toHaveBeenCalled();
  });

  it("skips a rate-limited repo entirely", async () => {
    mockGh.isRepoRateLimited.mockReturnValue(true);

    await run(REPOS);

    expect(mockGh.listOpenIssues).not.toHaveBeenCalled();
    expect(mockDb.listShadowIssues).not.toHaveBeenCalled();
  });

  it("reports a failing repo without taking the run down", async () => {
    mockGh.listOpenIssues.mockImplementation(async (repo: string) => {
      if (repo === "test-org/other") throw new Error("boom");
      return [];
    });

    await run([{ fullName: REPO } as never, { fullName: "test-org/other" } as never]);

    expect(reportError).toHaveBeenCalledWith(
      "issue-shadow-sync:repo",
      "test-org/other",
      expect.any(Error),
      { repo: "test-org/other" },
    );
  });
});

describe("issue-shadow-sync forwarding an imported forge issue", () => {
  const NATIVE = "clw_01M39NZ3H9F5GHVM4PJHT85V96";

  function nativeIssue(overrides: Record<string, unknown> = {}) {
    return {
      id: NATIVE,
      title: "Issue 7",
      body: "old body",
      state: "open",
      labels: [] as string[],
      repos: [REPO],
      lifecycle: "awaiting-plan-review",
      ...overrides,
    };
  }

  beforeEach(() => {
    mockDb.createShadowIssue.mockResolvedValue(undefined);
    mockResolveImportedRef.mockImplementation((_repo: string, ref: unknown) => (String(ref) === "7" ? NATIVE : ref));
  });

  function expectNoNativeWrites(): void {
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.editIssueTitle).not.toHaveBeenCalled();
    expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  }

  it("records only the baseline on a null marker when the native issue is open", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, body: "new", updatedAt: "2026-09-25T08:45:00Z" })]);
    mockClawsIssues.getIssue.mockResolvedValue(nativeIssue());

    await run(REPOS);

    expectNoNativeWrites();
    expect(mockDb.setImportedForgeSyncedAt).toHaveBeenCalledWith(REPO, 7, "2026-09-25T08:45:00Z");
    expectNoForgeWrites();
  });

  it("reopens a closed native issue on a null marker and queues a re-plan", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, body: "new alert", updatedAt: "2026-09-25T12:52:00Z" })]);
    mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ state: "closed", lifecycle: "approved", labels: ["Priority"] }));

    await run(REPOS);

    expect(mockClawsIssues.reopenIssue).toHaveBeenCalledWith(NATIVE);
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith(NATIVE, expect.stringMatching(/^Imported from .*\(opened by @bstjohn\)\n\nnew alert$/));
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, NATIVE, "planning");
    expect(mockWorker.enqueue).toHaveBeenCalledWith("work:issue-refiner:replan", REPO, NATIVE, { priority: true });
    expect(mockDb.setImportedForgeSyncedAt).toHaveBeenCalledWith(REPO, 7, "2026-09-25T12:52:00Z");
    expectNoForgeWrites();
  });

  it("forwards a newer body rewrite to an open native issue", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, title: "[Alert] firing", body: "five alerts", updatedAt: "2026-09-25T13:09:00Z" })]);
    mockDb.getImportedForgeSyncedAt.mockResolvedValue("2026-09-25T12:55:00Z");
    mockClawsIssues.getIssue.mockResolvedValue(nativeIssue());

    await run(REPOS);

    expect(mockClawsIssues.editIssueTitle).toHaveBeenCalledWith(NATIVE, "[Alert] firing");
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith(NATIVE, expect.stringMatching(/^Imported from .*\n\nfive alerts$/));
    expect(mockClawsIssues.reopenIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, NATIVE, "planning");
    expect(mockWorker.enqueue).toHaveBeenCalledWith("work:issue-refiner:replan", REPO, NATIVE, { priority: false });
  });

  it("queues the re-plan against the native issue's primary repo, not the forge repo the copy lives in", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, body: "new", updatedAt: "2026-09-25T12:52:00Z" })]);
    mockDb.getImportedForgeSyncedAt.mockResolvedValue("2026-09-25T10:00:00Z");
    mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ repos: [REPO, "aaa-org/alpha"] }));

    await run(REPOS);

    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith("aaa-org/alpha", NATIVE, "planning");
    expect(mockWorker.enqueue).toHaveBeenCalledWith("work:issue-refiner:replan", "aaa-org/alpha", NATIVE, { priority: false });
  });

  it("does nothing when the forge has not moved past the marker, even with the native issue closed", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, body: "new", updatedAt: "2026-09-25T12:52:00Z" })]);
    mockDb.getImportedForgeSyncedAt.mockResolvedValue("2026-09-25T12:52:00Z");
    mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ state: "closed" }));

    await run(REPOS);

    expectNoNativeWrites();
  });

  it("leaves a half-finished import alone", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, body: "new", updatedAt: "2026-09-25T12:52:00Z" })]);
    mockDb.getImportedForgeSyncedAt.mockResolvedValue("2026-09-25T10:00:00Z");
    mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ labels: ["Claws Ignore"] }));

    await run(REPOS);

    expectNoNativeWrites();
    expect(mockDb.setImportedForgeSyncedAt).not.toHaveBeenCalled();
  });

  it("edits and reopens a blocked native issue without moving it to planning", async () => {
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, body: "new", updatedAt: "2026-09-25T12:52:00Z" })]);
    mockDb.getImportedForgeSyncedAt.mockResolvedValue("2026-09-25T10:00:00Z");
    mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ state: "closed", lifecycle: "blocked" }));

    await run(REPOS);

    expect(mockClawsIssues.editIssue).toHaveBeenCalled();
    expect(mockClawsIssues.reopenIssue).toHaveBeenCalledWith(NATIVE);
    expect(mockClawsIssues.setLifecycle).not.toHaveBeenCalled();
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  it("moves to planning but queues nothing when the planner is disabled", async () => {
    mockIsAgentDisabled.mockReturnValue(true);
    mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, body: "new", updatedAt: "2026-09-25T12:52:00Z" })]);
    mockDb.getImportedForgeSyncedAt.mockResolvedValue("2026-09-25T10:00:00Z");
    mockClawsIssues.getIssue.mockResolvedValue(nativeIssue());

    await run(REPOS);

    expect(mockClawsIssues.setLifecycle).toHaveBeenCalledWith(REPO, NATIVE, "planning");
    expect(mockWorker.enqueue).not.toHaveBeenCalled();
  });

  it("carries on to the next issue when one forward throws", async () => {
    const OTHER = "clw_01M3BEW8WQVZ2Q915WRXJZGJJG";
    mockResolveImportedRef.mockImplementation((_repo: string, ref: unknown) => (String(ref) === "7" ? NATIVE : String(ref) === "8" ? OTHER : ref));
    mockGh.listOpenIssues.mockResolvedValue([
      forgeIssue({ number: 7, body: "new", updatedAt: "2026-09-25T12:52:00Z" }),
      forgeIssue({ number: 8, body: "new", updatedAt: "2026-09-25T12:52:00Z" }),
    ]);
    mockDb.getImportedForgeSyncedAt.mockResolvedValue("2026-09-25T10:00:00Z");
    mockClawsIssues.getIssue.mockImplementation(async (id: string) => {
      if (id === NATIVE) throw new Error("boom");
      return nativeIssue({ id: OTHER });
    });

    await run(REPOS);

    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith(OTHER, expect.any(String));
    expect(mockDb.setImportedForgeSyncedAt).toHaveBeenCalledTimes(1);
    expect(mockDb.setImportedForgeSyncedAt).toHaveBeenCalledWith(REPO, 8, "2026-09-25T12:52:00Z");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("lists with includeImported so it still sees the imported copies", async () => {
    await run(REPOS);

    expect(mockGh.listOpenIssues).toHaveBeenCalledWith(REPO, { includeImported: true });
  });
});
