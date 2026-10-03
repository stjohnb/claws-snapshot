import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockRepo, mockIssue } from "../test-helpers.js";

vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../prompt-guard.js", () => ({
  guardContent: (text: string) => text,
  makeGuardCtx: () => (source: string) => ({ source }),
}));

vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  getIssueComments: vi.fn(async () => []),
  getSelfLoginForIssue: vi.fn(async () => "claws-bot"),
  getIssueTitleBody: vi.fn(async () => null),
  getIssueAttachments: vi.fn(async () => []),
  commentOnIssue: vi.fn(async () => {}),
  editIssueComment: vi.fn(async () => {}),
  addReaction: vi.fn(async () => {}),
  isAllowedActor: vi.fn(async () => true),
  getCommentReactions: vi.fn(async () => []),
}));
vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  withNewWorktree: vi.fn(),
  agentMcpDir: vi.fn(),
  writeAgentMcpConfig: vi.fn(() => "mcp.json"),
  runClaude: vi.fn(),
}));
vi.mock("../db.js", () => ({
  withTaskRecording: vi.fn(async (_job: string, _repo: string, _n: unknown, _pr: unknown, fn: (id: number) => Promise<void>) => await fn(1)),
  updateTaskWorktree: vi.fn(async () => {}),
  updateTaskProvider: vi.fn(async () => {}),
  updateTaskModel: vi.fn(async () => {}),
  trackTaskTokens: vi.fn(() => () => {}),
  recordTaskComplete: vi.fn(async () => {}),
  addClawsIssueRequirementsVersion: vi.fn(async () => 1),
}));
vi.mock("../model-plan.js", () => ({
  resolveModelPlanCell: vi.fn(async () => ({ provider: "claude", strictProvider: false, eligibleProviders: ["claude"], tier: "opus", model: "opus" })),
}));
vi.mock("../timeout-handler.js", () => ({ getItemTimeoutMs: () => 60_000 }));
vi.mock("../planned-prs.js", () => ({ resolveTrackerId: vi.fn() }));
vi.mock("../claws-issues.js", () => ({ listRequirements: vi.fn(async () => []), listCommentDetails: vi.fn(async () => []) }));

import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as db from "../db.js";
import * as clawsIssues from "../claws-issues.js";
import { resolveTrackerId } from "../planned-prs.js";
import {
  buildRequirementsPrompt, readRequirementsOutFile, recordFromVersion,
  refineRequirements, unreactedAfterRequirements, writeRequirements,
} from "./requirements-writer.js";

const RECORD = {
  title: "Add a thing",
  kind: "feature" as const,
  context: "People want it.",
  requirement: "The thing exists.",
  acceptanceCriteria: ["The thing is visible"],
  outOfScope: [],
};

describe("readRequirementsOutFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-req-writer-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the saved record", () => {
    const file = path.join(dir, "requirements.json");
    fs.writeFileSync(file, JSON.stringify(RECORD));
    expect(readRequirementsOutFile(file)).toEqual(RECORD);
  });

  it("fails clearly when the agent never called the tool", () => {
    expect(() => readRequirementsOutFile(path.join(dir, "missing.json"))).toThrow(/without calling claws_save_requirements/);
  });

  it("fails when the saved record does not validate", () => {
    const file = path.join(dir, "requirements.json");
    fs.writeFileSync(file, JSON.stringify({ ...RECORD, acceptanceCriteria: [] }));
    expect(() => readRequirementsOutFile(file)).toThrow(/acceptanceCriteria/);
  });
});

describe("buildRequirementsPrompt", () => {
  const repo = mockRepo();
  const issue = mockIssue({ number: 7, title: "Thing please", body: "I want the thing." });
  const RECORD_COMMENT = { id: 100, login: "claws-bot", body_html: "", body: "*— Automated by Claws · Requirements writer —*\n\n## Requirements" };
  const HUMAN = { id: 101, login: "stjohnb", body_html: "", body: "Also on phones" };

  it("asks a write run for the record only, through the tool, and lists attachments", () => {
    const prompt = buildRequirementsPrompt(repo, issue, [], "claws-bot", ["shot.png"], { kind: "write" });
    expect(prompt).toContain("Thing please");
    expect(prompt).toContain("I want the thing.");
    expect(prompt).toContain("- shot.png");
    expect(prompt).toContain("`claws_save_requirements` tool exactly once");
    expect(prompt).toMatch(/Do NOT make design decisions/);
    expect(prompt).not.toContain("current requirements record");
  });

  it("gives a refine run the current record and the comments to address, once each", () => {
    const latest = { ...RECORD, version: 2, commentId: "100", createdAt: "2026-09-21T09:00:00.000Z" };
    const prompt = buildRequirementsPrompt(repo, issue, [RECORD_COMMENT, HUMAN], "claws-bot", [], { kind: "refine", latest, unreacted: [HUMAN] });
    expect(prompt).toContain("current requirements record (version 2)");
    expect(prompt).toContain(JSON.stringify(recordFromVersion(latest), null, 2));
    expect(prompt.split("Also on phones")).toHaveLength(2);
    expect(prompt).not.toContain("Discussion on the issue");
  });
});

describe("buildRequirementsPrompt legacy record comments", () => {
  it("leaves a legacy requirements comment out of a write run's discussion", () => {
    const legacy = { id: "clwc_1", login: "claws-bot", body_html: "", body: "*— Automated by Claws · Requirements writer —*\n\n## Requirements\n\nOLD RECORD" };
    const prompt = buildRequirementsPrompt(mockRepo(), mockIssue({ number: 7 }), [legacy], "claws-bot", [], { kind: "write" });
    expect(prompt).not.toContain("OLD RECORD");
  });
});

describe("runWriter", () => {
  const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
  const LATEST = { ...RECORD, version: 1, commentId: null, createdAt: "2026-09-21T09:00:00.000Z" };
  const HUMAN = { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD5", login: "stjohnb", body_html: "", body: "Also on phones" };
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-req-run-"));
    vi.mocked(claude.withNewWorktree).mockImplementation((async (_r: unknown, _b: string, _j: string, fn: (wt: string) => Promise<void>) => await fn(dir)) as never);
    vi.mocked(claude.agentMcpDir).mockReturnValue(dir);
    vi.mocked(claude.runClaude).mockImplementation((async () => {
      fs.writeFileSync(path.join(dir, "requirements.json"), JSON.stringify(RECORD));
    }) as never);
    vi.mocked(resolveTrackerId).mockImplementation(async (_repo, ref) => (ref === 7 ? "clw_01JBQ7X4M2K8NV3TYRW9GZ5S07" : NATIVE));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores a native issue's record without posting a comment", async () => {
    await writeRequirements(mockRepo(), mockIssue({ number: NATIVE }));

    expect(gh.commentOnIssue).not.toHaveBeenCalled();
    expect(gh.editIssueComment).not.toHaveBeenCalled();
    expect(db.addClawsIssueRequirementsVersion).toHaveBeenCalledWith(NATIVE, RECORD, null);
  });

  it("refines a native issue's record into the next version, still without a comment, and 👍s the feedback", async () => {
    vi.mocked(clawsIssues.listRequirements).mockResolvedValue([LATEST]);

    await refineRequirements(mockRepo(), mockIssue({ number: NATIVE }), [HUMAN]);

    expect(gh.commentOnIssue).not.toHaveBeenCalled();
    expect(gh.editIssueComment).not.toHaveBeenCalled();
    expect(db.addClawsIssueRequirementsVersion).toHaveBeenCalledWith(NATIVE, RECORD, null);
    expect(gh.addReaction).toHaveBeenCalledWith("test-org/test-repo", HUMAN.id, "+1");
  });

  it("still posts a forge issue's record as a comment, and edits it on a refine", async () => {
    const posted = { id: 500, login: "claws-bot", body_html: "", body: "*— Automated by Claws · Requirements writer —*\n\n## Requirements" };
    vi.mocked(gh.getIssueComments).mockResolvedValue([posted]);

    await writeRequirements(mockRepo(), mockIssue({ number: 7 }));
    expect(gh.commentOnIssue).toHaveBeenCalledWith("test-org/test-repo", 7, expect.stringContaining("## Requirements"), expect.anything());
    expect(db.addClawsIssueRequirementsVersion).toHaveBeenCalledWith("clw_01JBQ7X4M2K8NV3TYRW9GZ5S07", RECORD, "500");

    vi.mocked(clawsIssues.listRequirements).mockResolvedValue([{ ...LATEST, commentId: "500" }]);
    await refineRequirements(mockRepo(), mockIssue({ number: 7 }), []);
    expect(gh.editIssueComment).toHaveBeenCalledWith("test-org/test-repo", 500, expect.stringContaining("## Requirements"), expect.anything());
    expect(db.addClawsIssueRequirementsVersion).toHaveBeenLastCalledWith("clw_01JBQ7X4M2K8NV3TYRW9GZ5S07", RECORD, "500");
  });
});

describe("unreactedAfterRequirements on a native issue", () => {
  const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
  const detail = (id: string, login: string, body: string, createdAt: string) => ({ id, login, body, body_html: "", createdAt });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveTrackerId).mockResolvedValue(NATIVE);
  });

  it("returns null when the issue has no record yet", async () => {
    vi.mocked(clawsIssues.listRequirements).mockResolvedValue([]);
    expect(await unreactedAfterRequirements("org/repo", NATIVE, "claws-bot")).toBeNull();
  });

  it("anchors on the latest version's creation time, with no requirements comment", async () => {
    vi.mocked(clawsIssues.listRequirements).mockResolvedValue([{ ...RECORD, version: 1, commentId: null, createdAt: "2026-09-21T09:00:00.000Z" }]);
    vi.mocked(clawsIssues.listCommentDetails).mockResolvedValue([
      detail("clwc_before", "stjohnb", "Before the record", "2026-09-21T08:59:59.000Z"),
      detail("clwc_after", "stjohnb", "After the record", "2026-09-21T09:30:00.000Z"),
      detail("clwc_liked", "stjohnb", "Already handled", "2026-09-21T09:40:00.000Z"),
      detail("clwc_self", "claws-bot", "*— Automated by Claws —*\n\nA note", "2026-09-21T09:50:00.000Z"),
    ]);
    vi.mocked(gh.getCommentReactions).mockImplementation((async (_repo: string, id: unknown) =>
      (id === "clwc_liked" ? [{ user: { login: "claws-bot" }, content: "+1" }] : [])) as never);

    const unreacted = await unreactedAfterRequirements("org/repo", NATIVE, "claws-bot");

    expect(unreacted).toEqual([{ id: "clwc_after", login: "stjohnb", body: "After the record", body_html: "" }]);
    expect(gh.getIssueComments).not.toHaveBeenCalled();
  });
});
